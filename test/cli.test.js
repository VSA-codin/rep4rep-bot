'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { PassThrough, Writable } = require('node:stream');
const { LoginSession } = require('steam-session');
const { createPrompt, menu } = require('../index');
const { openDatabase } = require('../lib/database');

const ROOT = path.resolve(__dirname, '..');

async function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'r4r-cli-test-'));
    const config = path.join(directory, 'config.json');
    const dbFile = path.join(directory, 'profiles.db');
    fs.writeFileSync(config, JSON.stringify({ apiToken: 'synthetic-cli-api-token' }), { mode: 0o600 });
    const db = await openDatabase(dbFile);
    t.after(async () => {
        await db.close();
        fs.rmSync(directory, { recursive: true, force: true });
    });
    return { db, config, dbFile, env: { ...process.env, R4R_CONFIG_FILE: config, R4R_DB_PATH: dbFile } };
}

function captureLogger() {
    const messages = [];
    return { messages, ...Object.fromEntries(['log', 'error', 'table'].map(name => [name,
        value => messages.push(typeof value === 'string' ? value : JSON.stringify(value))])) };
}

function queuedPrompt(answers) {
    const asked = [];
    return { asked, async question(label, secret) {
        asked.push({ label, secret });
        assert.ok(answers.length, 'Unexpected menu prompt');
        return answers.shift();
    } };
}

async function runCli(t, env, args, interact) {
    const childEnv = { ...env };
    delete childEnv.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, ['index.js', ...args], { cwd: ROOT, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    let output = '';
    let errors = '';
    let acted = false;
    child.stdout.on('data', chunk => {
        output += chunk;
        if (!acted && output.includes('>> ') && interact) {
            acted = true;
            interact(child);
        }
    });
    child.stderr.on('data', chunk => { errors += chunk; });
    if (!interact) child.stdin.end();
    const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Offline CLI did not terminate.')); }, 5000);
        child.on('error', error => { clearTimeout(timer); reject(error); });
        child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, output, errors }); });
    });
    assert.doesNotMatch(result.output + result.errors, /synthetic-cli-api-token/);
    return result;
}

test('requiring the entry module performs no startup or network work', () => {
    const env = { ...process.env, R4R_CONFIG_FILE: '/nonexistent/offline-config.json' };
    delete env.NODE_TEST_CONTEXT;
    const imported = spawnSync(process.execPath, ['-e', "require('./index.js'); console.log('imported');"],
        { cwd: ROOT, env, encoding: 'utf8', timeout: 5000 });
    assert.equal(imported.error, undefined);
    assert.equal(imported.status, 0);
    assert.equal(imported.stdout, 'imported\n');
    assert.equal(imported.stderr, '');
});

test('interactive account menus retain navigation and remove exactly the selected account', async t => {
    const { db } = await fixture(t);
    for (const [accountName, steamId] of [['first_offline', '76561198000000001'], ['second_offline', '76561198000000002']]) {
        await db.saveAccount({ accountName, steamId, cookies: ['sessionid=synthetic'] });
    }
    const controller = new AbortController();
    const prompt = queuedPrompt(['invalid', '2', 'invalid', '3', 'first_offline', '4', '3']);
    const logger = captureLogger();
    const code = await menu({ db, api: {}, signal: controller.signal, logger, prompt,
        createCommunity() { assert.fail('Account removal must not authenticate'); } });
    assert.equal(code, 0);
    assert.deepEqual((await db.all('SELECT username FROM steamprofiles')).map(row => row.username), ['second_offline']);
    assert.ok(logger.messages.includes('Steam account removed.'));
    assert.equal(logger.messages.filter(message => message === 'Invalid option.').length, 2);
});

test('interactive re-login refuses a missing saved account before requesting its password', async t => {
    const { db } = await fixture(t);
    const prompt = queuedPrompt(['2', '2', 'missing_offline', '4', '3']);
    const logger = captureLogger();
    assert.equal(await menu({ db, api: {}, signal: new AbortController().signal, logger, prompt,
        createCommunity() { assert.fail('Missing account must not authenticate'); } }), 0);
    assert.ok(logger.messages.some(message => message.includes('No unique saved account')));
    assert.ok(prompt.asked.every(item => item.label !== 'Password: '));
});

test('account management adds and re-logs the selected account without resetting its saved cooldown', async t => {
    const { db } = await fixture(t);
    const attempts = [];
    let sessionNumber = 0;
    t.mock.method(LoginSession.prototype, 'startWithCredentials', async function(details) {
        attempts.push({ ...details });
        setImmediate(() => this.emit('authenticated'));
        return { actionRequired: false };
    });
    t.mock.method(LoginSession.prototype, 'getWebCookies', async () => [`sessionid=synthetic-menu-${++sessionNumber}`]);
    const createCommunity = () => ({
        steamID: { getSteamID64: () => '76561198000000001' },
        setCookies() {},
        loggedIn(callback) { callback(null, true, false); }
    });
    const firstPrompt = queuedPrompt(['2', '1', 'offline_menu', 'synthetic-first-password', '4', '3']);
    const logger = captureLogger();
    assert.equal(await menu({ db, api: {}, signal: new AbortController().signal, logger,
        prompt: firstPrompt, createCommunity }), 0);
    const original = await db.get('SELECT * FROM steamprofiles');
    assert.equal(original.username, 'offline_menu');
    assert.deepEqual(JSON.parse(original.cookies), ['sessionid=synthetic-menu-1']);
    const cooldown = '2026-10-09T10:00:00.000Z';
    await db.run('UPDATE steamprofiles SET last_comment=? WHERE id=?', [cooldown, original.id]);
    const secondPrompt = queuedPrompt(['2', '2', 'OFFLINE_MENU', 'synthetic-second-password', '4', '3']);
    assert.equal(await menu({ db, api: {}, signal: new AbortController().signal, logger,
        prompt: secondPrompt, createCommunity }), 0);
    const accounts = await db.all('SELECT * FROM steamprofiles');
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0].id, original.id);
    assert.equal(accounts[0].last_comment, cooldown);
    assert.deepEqual(JSON.parse(accounts[0].cookies), ['sessionid=synthetic-menu-2']);
    assert.deepEqual(attempts.map(item => item.accountName), ['offline_menu', 'OFFLINE_MENU']);
    assert.ok([...firstPrompt.asked, ...secondPrompt.asked].filter(item => item.label === 'Password: ').every(item => item.secret));
    assert.ok(logger.messages.every(message => !message.includes('synthetic-first-password') && !message.includes('synthetic-second-password')));
});

test('terminal password prompts display the prompt while suppressing typed credentials', async () => {
    const input = new PassThrough();
    input.isTTY = true;
    let displayed = '';
    const output = new Writable({ write(chunk, _encoding, done) { displayed += chunk; done(); } });
    const prompt = createPrompt({ input, output });
    try {
        const pending = prompt.question('Password: ', true);
        input.write('synthetic masked password\r');
        assert.equal(await pending, 'synthetic masked password');
        assert.match(displayed, /Password: /);
        assert.doesNotMatch(displayed, /synthetic masked password/);
        const ordinary = prompt.question('Username: ');
        input.write('offline_account\r');
        assert.equal(await ordinary, 'offline_account');
        assert.match(displayed, /offline_account/);
    } finally { prompt.close(); input.destroy(); output.destroy(); }
});

test('EOF aborts an unanswered prompt without retaining a live readline interface', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const controller = new AbortController();
    const prompt = createPrompt({ input, output, signal: controller.signal });
    prompt.onClose(() => controller.abort());
    const pending = prompt.question('>> ');
    input.end();
    await assert.rejects(pending, error => error.code === 'ABORT_ERR');
    prompt.close();
    output.destroy();
});

test('CLI rejects unsupported arguments and --auto reports an empty account database', async t => {
    const { env, db } = await fixture(t);
    const invalid = await runCli(t, env, ['--unknown']);
    assert.equal(invalid.code, 1);
    assert.match(invalid.errors, /Usage:/);
    const auto = await runCli(t, env, ['--auto']);
    assert.equal(auto.code, 1);
    assert.equal(auto.signal, null);
    assert.match(auto.errors, /failed/);
    assert.equal(await db.get('SELECT * FROM run_lock'), undefined);
});

test('CLI exits after menu selection and releases its database lock', async t => {
    const { env, db } = await fixture(t);
    const result = await runCli(t, env, [], child => child.stdin.end('3\n'));
    assert.equal(result.code, 0);
    assert.equal(result.signal, null);
    assert.equal(await db.get('SELECT * FROM run_lock'), undefined);
});

test('CLI terminates on stdin EOF and releases its database lock', async t => {
    const { env, db } = await fixture(t);
    const result = await runCli(t, env, [], child => child.stdin.end());
    assert.equal(result.signal, null);
    assert.ok([0, 130].includes(result.code));
    assert.equal(await db.get('SELECT * FROM run_lock'), undefined);
});

test('SIGINT and SIGTERM interrupt an unanswered CLI prompt and release its database lock', async t => {
    if (process.platform === 'win32') return t.skip('Unix signal delivery');
    const { env, db } = await fixture(t);
    for (const [signal, expectedCode] of [['SIGINT', 130], ['SIGTERM', 143]]) {
        const result = await runCli(t, env, [], child => child.kill(signal));
        assert.equal(result.code, expectedCode);
        assert.equal(result.signal, null);
        assert.match(result.output, /interrupted/);
        assert.equal(await db.get('SELECT * FROM run_lock'), undefined);
    }
});
