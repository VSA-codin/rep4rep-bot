'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase } = require('../lib/database');
const { runTasks } = require('../lib/bot');

const NOW = Date.parse('2026-10-09T15:00:00.000Z');
const first = { accountName: 'first_offline', steamId: '76561198000000001', cookies: ['sessionid=first'], token: 'first-token' };
const second = { accountName: 'second_offline', steamId: '76561198000000002', cookies: ['sessionid=second'], token: 'second-token' };
const task = {
    taskId: 21,
    requiredCommentId: 31,
    targetSteamProfileId: '76561198000000003',
    targetSteamProfileName: 'Offline target',
    requiredCommentText: '+rep offline test'
};
const logger = Object.fromEntries(['log', 'info', 'warn', 'error'].map(key => [key, () => {}]));

async function setup(t, accounts = [first]) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'r4r-runner-test-'));
    const file = path.join(directory, 'profiles.db');
    let db = await openDatabase(file);
    await db.initialize();
    for (const account of accounts) await db.saveAccount(account);
    t.after(async () => {
        await db.close();
        fs.rmSync(directory, { recursive: true, force: true });
    });
    const posts = [];
    const clients = [];
    const completions = [];
    const delays = [];
    const api = {
        profiles: async () => accounts.map((account, index) => ({ id: index + 1, steamId: account.steamId })),
        addProfile: async () => ({ success: true }),
        tasks: async id => [{ ...task, taskId: task.taskId + Number(id) }],
        complete: async (item, id) => { completions.push({ item, id }); return { success: true }; }
    };
    const createCommunity = () => {
        const client = {
            cookies: [],
            setCookies(cookies) {
                this.cookies = cookies;
                const account = accounts.find(item => JSON.stringify(item.cookies) === JSON.stringify(cookies));
                this.steamID = { getSteamID64: () => account?.steamId };
            },
            loggedIn(callback) { callback(null, true, false); },
            postUserComment(target, text, callback) {
                posts.push({ client: this, target, text });
                callback(null);
            }
        };
        clients.push(client);
        return client;
    };
    const options = {
        db,
        api,
        createCommunity,
        autoRelogin: async () => { throw new Error('Unexpected offline relogin'); },
        now: () => NOW,
        sleep: async ms => { delays.push(ms); },
        timeoutMs: 20,
        logger
    };
    return {
        db, file, api, options, posts, clients, completions, delays,
        async reopen() {
            await db.close();
            db = await openDatabase(file);
            await db.initialize();
            options.db = db;
            return db;
        }
    };
}

test('runner rejects an empty local account set without performing Steam or API requests', async t => {
    const context = await setup(t, []);
    context.api.profiles = async () => { throw new Error('API must not be called for an empty database'); };
    await assert.rejects(runTasks(context.options), /account/i);
    assert.equal(context.clients.length, 0);
    assert.equal(context.posts.length, 0);
});

test('runner isolates cookies, tokens and completion identities for multiple accounts', async t => {
    const context = await setup(t, [first, second]);
    await runTasks(context.options);
    assert.equal(context.posts.length, 2);
    assert.equal(context.clients.length, 2);
    assert.notEqual(context.clients[0], context.clients[1]);
    assert.deepEqual(context.clients[0].cookies, first.cookies);
    assert.deepEqual(context.clients[1].cookies, second.cookies);
    assert.equal(context.clients[0].oAuthToken, first.token);
    assert.equal(context.clients[1].oAuthToken, second.token);
    assert.deepEqual(context.completions.map(item => item.id), ['1', '2']);
    assert.equal(context.delays.length, 1);
    assert.ok(context.delays.every(ms => ms >= 15000));
    const saved = await context.db.all('SELECT last_comment FROM steamprofiles ORDER BY id');
    assert.deepEqual(saved.map(row => row.last_comment), [new Date(NOW).toISOString(), new Date(NOW).toISOString()]);
});

test('runner waits for the full 24-hour cooldown and accepts its exact UTC boundary', async t => {
    const context = await setup(t, [first, second]);
    await context.db.run('UPDATE steamprofiles SET last_comment=? WHERE username=?', [new Date(NOW - 24 * 60 * 60 * 1000 + 1).toISOString(), first.accountName]);
    await context.db.run('UPDATE steamprofiles SET last_comment=? WHERE username=?', [new Date(NOW - 24 * 60 * 60 * 1000).toISOString(), second.accountName]);
    await runTasks(context.options);
    assert.equal(context.posts.length, 1);
    assert.deepEqual(context.posts[0].client.cookies, second.cookies);
});

test('UTC cooldown timestamps retain the same meaning across host timezones', async t => {
    const context = await setup(t);
    await context.db.run('UPDATE steamprofiles SET last_comment=?', ['2026-10-08T15:00:01.000Z']);
    const previousTimezone = process.env.TZ;
    process.env.TZ = 'Pacific/Honolulu';
    try {
        await runTasks(context.options);
        assert.equal(context.posts.length, 0);
    } finally {
        if (previousTimezone === undefined) delete process.env.TZ;
        else process.env.TZ = previousTimezone;
    }
});

test('expired sessions use the freshly authenticated account client', async t => {
    const context = await setup(t);
    context.options.createCommunity = () => ({
        setCookies() {},
        loggedIn(callback) { callback(null, false); },
        postUserComment() { assert.fail('Expired session must not post'); }
    });
    const renewedClient = {
        steamID: { getSteamID64: () => first.steamId },
        loggedIn(callback) { callback(null, true, false); },
        postUserComment(target, text, callback) { context.posts.push({ target, text, client: this }); callback(null); }
    };
    const relogins = [];
    context.options.autoRelogin = async (username, db) => {
        relogins.push({ username, db });
        return renewedClient;
    };
    await runTasks(context.options);
    assert.equal(relogins.length, 1);
    assert.equal(relogins[0].username, first.accountName);
    assert.equal(context.posts.length, 1);
    assert.equal(context.posts[0].client, renewedClient);
});

test('one account session error does not prevent later accounts from running', async t => {
    const context = await setup(t, [first, second]);
    const originalCreate = context.options.createCommunity;
    let number = 0;
    context.options.createCommunity = () => {
        const client = originalCreate();
        if (number++ === 0) client.loggedIn = callback => callback(new Error('Offline session failure'));
        return client;
    };
    await runTasks(context.options);
    assert.equal(context.posts.length, 1);
    assert.deepEqual(context.posts[0].client.cookies, second.cookies);
});

test('an API acknowledgement failure is persisted and retried after restart without reposting', async t => {
    const context = await setup(t);
    let attempts = 0;
    context.api.complete = async () => {
        attempts++;
        if (attempts === 1) throw new Error('Offline acknowledgement timeout');
        return { success: true };
    };
    await runTasks(context.options);
    assert.equal(context.posts.length, 1);
    await context.reopen();
    // The provider may stop returning a task after receiving its first acknowledgement.
    context.api.tasks = async () => [];
    await runTasks(context.options);
    assert.equal(attempts, 2);
    assert.equal(context.posts.length, 1);
});

test('a timed-out comment stays uncertain across restart and is never posted automatically twice', async t => {
    const context = await setup(t);
    let attempts = 0;
    context.options.createCommunity = () => ({
        steamID: { getSteamID64: () => first.steamId },
        setCookies() {},
        loggedIn(callback) { callback(null, true); },
        postUserComment() { attempts++; }
    });
    await runTasks(context.options);
    assert.equal(attempts, 1);
    assert.equal(context.completions.length, 0);
    await context.reopen();
    await runTasks(context.options);
    assert.equal(attempts, 1);
    assert.equal(context.completions.length, 0);
});

test('runner cancels before posting when its caller has already aborted', async t => {
    const context = await setup(t);
    const controller = new AbortController();
    controller.abort();
    context.options.signal = controller.signal;
    context.api.profiles = async () => { assert.fail('Cancelled runs must not contact the API'); };
    await assert.rejects(runTasks(context.options), error => error.code === 'ABORT_ERR');
    assert.equal(context.posts.length, 0);
});

test('completed task identities survive restart and a later cooldown period', async t => {
    const context = await setup(t);
    await runTasks(context.options);
    assert.equal(context.posts.length, 1);
    await context.reopen();
    context.options.now = () => NOW + 24 * 60 * 60 * 1000;
    await runTasks(context.options);
    assert.equal(context.posts.length, 1);
    assert.equal(context.completions.length, 1);
});

test('duplicate tasks in a provider response cannot cause duplicate comments', async t => {
    const context = await setup(t);
    context.api.tasks = async () => [task, task];
    await runTasks(context.options);
    assert.equal(context.posts.length, 1);
    assert.equal(context.completions.length, 1);
});

test('the runner delays consecutive comments within an account', async t => {
    const context = await setup(t);
    context.api.tasks = async () => [task, { ...task, taskId: task.taskId + 1 }];
    await runTasks(context.options);
    assert.equal(context.posts.length, 2);
    assert.deepEqual(context.delays, [15000]);
});

test('an unsuccessful comment attempt still delays the next account', async t => {
    const context = await setup(t, [first, second]);
    const originalCreate = context.options.createCommunity;
    let number = 0;
    context.options.createCommunity = () => {
        const client = originalCreate();
        if (number++ === 0) client.postUserComment = (_target, _text, callback) => callback(new Error('Offline comment outcome unknown'));
        return client;
    };
    await runTasks(context.options);
    assert.equal(context.posts.length, 1);
    assert.deepEqual(context.delays, [15000]);
});

test('a Steam session belonging to another account never posts a comment', async t => {
    const context = await setup(t);
    const originalCreate = context.options.createCommunity;
    context.options.createCommunity = () => {
        const client = originalCreate();
        client.setCookies = function(cookies) {
            this.cookies = cookies;
            this.steamID = { getSteamID64: () => second.steamId };
        };
        return client;
    };
    await runTasks(context.options);
    assert.equal(context.posts.length, 0);
});

test('a session locked by Family View never posts a comment', async t => {
    const context = await setup(t);
    const originalCreate = context.options.createCommunity;
    context.options.createCommunity = () => {
        const client = originalCreate();
        client.loggedIn = callback => callback(null, true, true);
        return client;
    };
    await runTasks(context.options);
    assert.equal(context.posts.length, 0);
});

test('a persistence failure after Steam success retains an uncertain operation for manual review', async t => {
    const context = await setup(t);
    const originalRun = context.db.run;
    let failOnce = true;
    context.db.run = async (sql, params) => {
        if (failOnce && sql.startsWith('UPDATE steamprofiles SET last_comment')) {
            failOnce = false;
            throw new Error('Offline SQLite write failure');
        }
        return originalRun(sql, params);
    };
    await runTasks(context.options);
    assert.equal(context.posts.length, 1);
    assert.equal(context.completions.length, 0);
    await context.reopen();
    await runTasks(context.options);
    assert.equal(context.posts.length, 1);
    assert.equal(context.completions.length, 0);
});

test('cancelling during a Steam comment retains its intent and prevents automatic reposting', async t => {
    const context = await setup(t);
    const controller = new AbortController();
    context.options.signal = controller.signal;
    const originalCreate = context.options.createCommunity;
    context.options.createCommunity = () => {
        const client = originalCreate();
        client.postUserComment = () => { context.posts.push({ client }); controller.abort(); };
        return client;
    };
    await assert.rejects(runTasks(context.options), error => error.code === 'ABORT_ERR');
    assert.equal(context.posts.length, 1);
    context.options.signal = undefined;
    await context.reopen();
    await runTasks(context.options);
    assert.equal(context.posts.length, 1);
    assert.equal(context.completions.length, 0);
});

test('an unregistered account is added without posting or loading tasks until the next pass', async t => {
    const context = await setup(t);
    const registrations = [];
    context.api.profiles = async () => [];
    context.api.addProfile = async steamId => { registrations.push(steamId); };
    context.api.tasks = async () => { assert.fail('A new registration has no provider ID yet'); };
    await runTasks(context.options);
    assert.deepEqual(registrations, [first.steamId]);
    assert.equal(context.clients.length, 0);
    assert.equal(context.posts.length, 0);
});
