'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const sqlite3 = require('sqlite3');
const { createAutoRelogin, RETRY_MS } = require('../auto-relogin');
const { getPrivatePaths, atomicWritePrivateJson, readPrivateJson } = require('../lib/private-files');
const { withTimeout } = require('../lib/async');

const ACCOUNT = 'offline_account';
const STEAM_ID = '76561198000000001';
const OTHER_ID = '76561198000000002';
const SECRET = Buffer.alloc(20, 7).toString('base64');

async function fixture(t, options = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'r4r-relogin-'));
    fs.chmodSync(directory, 0o700);
    const paths = getPrivatePaths({ R4R_2FA_DIR: directory });
    atomicWritePrivateJson(paths.passwords, options.passwords || { [ACCOUNT]: 'offline fixture password' });
    if (!options.omitSecrets) {
        atomicWritePrivateJson(paths.secrets, options.secrets || { [ACCOUNT]: { shared_secret: SECRET } });
    }
    const db = new sqlite3.Database(':memory:');
    const run = (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, function (error) {
        if (error) reject(error); else resolve(this);
    }));
    const all = (sql, params = []) => new Promise((resolve, reject) => db.all(sql, params, (error, rows) => {
        if (error) reject(error); else resolve(rows);
    }));
    await run('CREATE TABLE steamprofiles (id INTEGER PRIMARY KEY, username TEXT, steamId TEXT, cookies TEXT, token TEXT)');
    await run('INSERT INTO steamprofiles VALUES (?, ?, ?, ?, ?)', [1, ACCOUNT, STEAM_ID, 'old cookies', 'old token']);
    t.after(async () => {
        await new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve()));
        fs.rmSync(directory, { recursive: true, force: true });
    });
    const calls = [];
    const clients = [];
    const logs = [];
    let clock = 1000000;
    class Community {
        constructor(settings) {
            this.settings = settings;
            this.steamID = { getSteamID64: () => options.clientSteamId || STEAM_ID };
            clients.push(this);
        }
        login(details, callback) {
            calls.push(details);
            if (options.login) return options.login.call(this, details, callback, calls.length);
            callback(null, 'offline-session', ['sessionid=offline-cookie']);
        }
        loggedIn(callback) {
            if (options.verify) return options.verify(callback);
            callback(null, true, false);
        }
    }
    const relogin = createAutoRelogin({
        SteamCommunity: Community,
        SteamTotp: { generateAuthCode(secret) { assert.equal(secret, SECRET); return 'TEST2'; } },
        login(client, details, options) {
            return withTimeout(done => client.login(details,
                (error, sessionID, cookies) => done(error, { cookies, token: null })),
            options.timeoutMs, 'Steam login', options);
        },
        getPaths: () => paths,
        now: () => clock,
        logger: { log(message) { logs.push(message); } }
    });
    return { paths, db, run, all, calls, clients, logs, relogin, setClock(value) { clock = value; } };
}

test('password login verifies the Steam identity and persists cookies only to the selected account', async t => {
    const f = await fixture(t);
    await f.run('INSERT INTO steamprofiles VALUES (?, ?, ?, ?, ?)', [2, 'another_account', OTHER_ID, 'other cookies', 'other token']);
    const client = await f.relogin(ACCOUNT, f.db, { accountId: 1, steamId: STEAM_ID });
    assert.equal(client, f.clients[0]);
    assert.equal(f.calls.length, 1);
    assert.equal(f.clients[0].settings.timeout, 30000);
    const rows = await f.all('SELECT * FROM steamprofiles ORDER BY id');
    assert.deepEqual(JSON.parse(rows[0].cookies), ['sessionid=offline-cookie']);
    assert.equal(rows[0].token, null);
    assert.equal(rows[1].cookies, 'other cookies');
    assert.equal(rows[1].token, 'other token');
    assert.deepEqual(readPrivateJson(f.paths.retry), { [ACCOUNT]: 1000000 });
    assert.equal(fs.existsSync(f.paths.retry + '.lock'), false);
});

test('Steam Guard Mobile sends one generated challenge response and retains a verified client', async t => {
    const f = await fixture(t, {
        login(details, callback) {
            if (!details.twoFactorCode) return callback(new Error('SteamGuardMobile'));
            callback(null, 'session', ['sessionid=offline-2fa-cookie']);
        }
    });
    assert.ok(await f.relogin(ACCOUNT, f.db));
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[1].twoFactorCode, 'TEST2');
    assert.ok(f.logs.every(message => !message.includes('TEST2') && !message.includes(SECRET)));
});

test('repeated Steam Guard failures cannot cause unbounded authentication retries', async t => {
    const f = await fixture(t, { login(details, callback) { callback(new Error('SteamGuardMobile')); } });
    assert.equal(await f.relogin(ACCOUNT, f.db), null);
    assert.equal(f.calls.length, 2);
    assert.equal(await f.relogin(ACCOUNT, f.db), null);
    assert.equal(f.calls.length, 2);
});

test('cooldown survives failure, handles account case, and allows a new attempt after six hours', async t => {
    const f = await fixture(t, { login(details, callback) { callback(new Error('offline fixture rejected')); } });
    assert.equal(await f.relogin(ACCOUNT.toUpperCase(), f.db), null);
    assert.equal(await f.relogin(ACCOUNT, f.db), null);
    assert.equal(f.calls.length, 1);
    f.setClock(1000000 + RETRY_MS);
    assert.equal(await f.relogin(ACCOUNT, f.db), null);
    assert.equal(f.calls.length, 2);
});

test('the cooldown of one account does not block another saved account', async t => {
    const otherAccount = 'other_offline_account';
    const f = await fixture(t, {
        passwords: { [ACCOUNT]: 'offline first password', [otherAccount]: 'offline second password' },
        login(details, callback) {
            this.steamID = { getSteamID64: () => details.accountName === ACCOUNT ? STEAM_ID : OTHER_ID };
            callback(null, 'session', ['sessionid=offline-cookie']);
        }
    });
    await f.run('INSERT INTO steamprofiles VALUES (?, ?, ?, ?, ?)', [2, otherAccount, OTHER_ID, 'old other cookies', null]);
    assert.ok(await f.relogin(ACCOUNT, f.db));
    assert.ok(await f.relogin(otherAccount, f.db));
    assert.equal(f.calls.length, 2);
    assert.deepEqual(readPrivateJson(f.paths.retry), { [ACCOUNT]: 1000000, [otherAccount]: 1000000 });
});

test('missing credentials do not consume cooldown and password-only accounts still work', async t => {
    const f = await fixture(t, { passwords: {}, omitSecrets: true });
    assert.equal(await f.relogin(ACCOUNT, f.db), null);
    assert.equal(f.calls.length, 0);
    assert.equal(fs.existsSync(f.paths.retry), false);
    atomicWritePrivateJson(f.paths.passwords, { [ACCOUNT]: 'offline fixture password' });
    assert.ok(await f.relogin(ACCOUNT, f.db));
});

test('ambiguous usernames require an explicit profile id, which updates one row', async t => {
    const f = await fixture(t);
    await f.run('INSERT INTO steamprofiles VALUES (?, ?, ?, ?, ?)', [2, ACCOUNT.toUpperCase(), OTHER_ID, 'other cookies', 'other token']);
    assert.equal(await f.relogin(ACCOUNT, f.db), null);
    assert.equal(f.calls.length, 0);
    assert.ok(await f.relogin(ACCOUNT, f.db, { accountId: 1, steamId: STEAM_ID }));
    const rows = await f.all('SELECT cookies, token FROM steamprofiles ORDER BY id');
    assert.equal(rows[1].cookies, 'other cookies');
    assert.equal(rows[1].token, 'other token');
});

test('a SteamID mismatch or locked Family View never replaces stored cookies', async t => {
    for (const settings of [
        { clientSteamId: OTHER_ID },
        { verify(callback) { callback(null, true, true); } },
        { verify(callback) { callback(null, false, false); } },
        { login(details, callback) { callback(null, 'session', []); } }
    ]) {
        const f = await fixture(t, settings);
        assert.equal(await f.relogin(ACCOUNT, f.db), null);
        const [row] = await f.all('SELECT cookies, token FROM steamprofiles');
        assert.equal(row.cookies, 'old cookies');
        assert.equal(row.token, 'old token');
    }
});

test('changed database identity during authentication prevents persistence', async t => {
    let release;
    const f = await fixture(t, { login(details, callback) { release = callback; } });
    const pending = f.relogin(ACCOUNT, f.db, { accountId: 1 });
    while (!release) await new Promise(resolve => setImmediate(resolve));
    await f.run('UPDATE steamprofiles SET username = ? WHERE id = 1', ['renamed_account']);
    release(null, 'session', ['sessionid=offline-cookie']);
    assert.equal(await pending, null);
    const [row] = await f.all('SELECT cookies FROM steamprofiles');
    assert.equal(row.cookies, 'old cookies');
});

test('timeouts and aborts retain cooldown and late login callbacks cannot persist a session', async t => {
    let release;
    const f = await fixture(t, { login(details, callback) { release = callback; } });
    assert.equal(await f.relogin(ACCOUNT, f.db, { timeoutMs: 20 }), null);
    release(null, 'late-session', ['sessionid=late-offline-cookie']);
    await new Promise(resolve => setImmediate(resolve));
    const [row] = await f.all('SELECT cookies FROM steamprofiles');
    assert.equal(row.cookies, 'old cookies');
    assert.ok(f.logs.some(message => message.includes('timed out')));
    assert.equal(await f.relogin(ACCOUNT, f.db), null);
    assert.equal(f.calls.length, 1);

    const abortFixture = await fixture(t, { login(details, callback) { release = callback; } });
    const controller = new AbortController();
    const pending = abortFixture.relogin(ACCOUNT, abortFixture.db, { signal: controller.signal });
    while (abortFixture.calls.length === 0) await new Promise(resolve => setImmediate(resolve));
    controller.abort();
    assert.equal(await pending, null);
    assert.equal(abortFixture.calls.length, 1);
    assert.equal(await abortFixture.relogin(ACCOUNT, abortFixture.db), null);
});

test('concurrent relogin calls make one network attempt until the original settles', async t => {
    let release;
    const f = await fixture(t, { login(details, callback) { release = callback; } });
    const pending = f.relogin(ACCOUNT, f.db);
    while (!release) await new Promise(resolve => setImmediate(resolve));
    assert.equal(await f.relogin(ACCOUNT.toUpperCase(), f.db), null);
    assert.equal(await f.relogin(ACCOUNT, f.db), null);
    assert.equal(f.calls.length, 1);
    release(null, 'session', ['sessionid=offline-cookie']);
    assert.ok(await pending);
});

test('separate processes share an atomic cooldown reservation', async t => {
    const f = await fixture(t);
    const source = `
        const fs = require('node:fs');
        const path = require('node:path');
        const {createAutoRelogin} = require(process.argv[1]);
        const paths = JSON.parse(process.argv[2]);
        const row = {id: 1, username: 'offline_account', steamId: '76561198000000001'};
        const db = {
            all(sql, values, callback) { setTimeout(() => callback(null, [row]), 10); },
            run(sql, values, callback) { callback.call({changes: 1}, null); }
        };
        class Community {
            constructor() { this.steamID = {getSteamID64: () => row.steamId}; }
            loggedIn(callback) { callback(null, true, false); }
        }
        const relogin = createAutoRelogin({
            SteamCommunity: Community, getPaths: () => paths, now: () => 1000000,
            logger: {log() {}},
            async login() {
                fs.appendFileSync(path.join(paths.dir, 'attempt-count'), 'attempt\\n', {mode: 0o600});
                await new Promise(resolve => setTimeout(resolve, 20));
                return {cookies: ['sessionid=offline-cookie'], token: null};
            }
        });
        relogin(row.username, db).then(result => process.exitCode = result ? 0 : 2);
    `;
    const child = () => new Promise((resolve, reject) => {
        const process = spawn(globalThis.process.execPath, ['-e', source,
            path.resolve(__dirname, '../auto-relogin.js'), JSON.stringify(f.paths)],
        { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        process.stderr.on('data', chunk => { stderr += chunk; });
        process.on('error', reject);
        process.on('exit', (code, signal) => {
            if (signal || ![0, 2].includes(code)) reject(new Error('Offline child failed: ' + stderr));
            else resolve(code);
        });
    });
    const results = await Promise.all([child(), child()]);
    assert.deepEqual(results.sort(), [0, 2]);
    assert.equal(fs.readFileSync(path.join(f.paths.dir, 'attempt-count'), 'utf8'), 'attempt\n');
    assert.equal(fs.existsSync(f.paths.retry + '.lock'), false);
});

test('existing writer locks fail closed and malformed retry state never triggers authentication', async t => {
    const locked = await fixture(t);
    atomicWritePrivateJson(locked.paths.retry + '.lock', { pid: 2147483647, id: 'interrupted-offline-writer' });
    assert.equal(await locked.relogin(ACCOUNT, locked.db), null);
    assert.equal(locked.calls.length, 0);
    assert.equal(fs.existsSync(locked.paths.retry + '.lock'), true);

    const malformed = await fixture(t);
    atomicWritePrivateJson(malformed.paths.retry, { [ACCOUNT]: 'invalid timestamp' });
    assert.equal(await malformed.relogin(ACCOUNT, malformed.db), null);
    assert.equal(malformed.calls.length, 0);
    assert.equal(fs.existsSync(malformed.paths.retry + '.lock'), false);
});

test('unsafe credential files and arbitrary Steam errors never leak secrets in logs', async t => {
    const unsafe = await fixture(t);
    fs.chmodSync(unsafe.paths.passwords, 0o644);
    assert.equal(await unsafe.relogin(ACCOUNT, unsafe.db), null);
    assert.equal(unsafe.calls.length, 0);
    const sensitive = 'offline fixture password https://example.invalid/?token=offline-cookie';
    const f = await fixture(t, { login(details, callback) { callback(new Error(sensitive)); } });
    assert.equal(await f.relogin(ACCOUNT, f.db), null);
    assert.ok(f.logs.every(message => !message.includes('offline fixture password') && !message.includes('token=')));
});
