'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase, loadConfig } = require('../lib/database');

async function database(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'r4r-database-test-'));
    const file = path.join(directory, 'profiles.db');
    const db = await openDatabase(file);
    t.after(async () => {
        await db.close();
        fs.rmSync(directory, { recursive: true, force: true });
    });
    await db.initialize();
    return { db, file };
}

function account(overrides = {}) {
    return {
        accountName: 'offline_account',
        steamId: '76561198000000001',
        cookies: ['sessionid=offline; Path=/'],
        token: 'offline-token',
        ...overrides
    };
}

test('SQLite initializes before first read and persists account data with private permissions', async t => {
    const { db, file } = await database(t);
    assert.deepEqual(await db.all('SELECT * FROM steamprofiles'), []);
    await db.saveAccount(account());
    const saved = await db.get('SELECT * FROM steamprofiles WHERE username=?', ['offline_account']);
    assert.equal(saved.steamId, account().steamId);
    assert.deepEqual(JSON.parse(saved.cookies), account().cookies);
    assert.equal(saved.token, 'offline-token');
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('relogin updates an account without deleting its id or cooldown', async t => {
    const { db } = await database(t);
    await db.saveAccount(account());
    const original = await db.get('SELECT * FROM steamprofiles');
    await db.run('UPDATE steamprofiles SET last_comment=? WHERE id=?', ['2026-10-08T15:00:00.000Z', original.id]);
    await db.saveAccount(account({ cookies: ['sessionid=renewed'], token: 'renewed-token' }));
    const rows = await db.all('SELECT * FROM steamprofiles');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, original.id);
    assert.equal(rows[0].last_comment, '2026-10-08T15:00:00.000Z');
    assert.deepEqual(JSON.parse(rows[0].cookies), ['sessionid=renewed']);
});

test('account removal treats input as data and supports username and numeric id', async t => {
    const { db } = await database(t);
    await db.saveAccount(account());
    await db.saveAccount(account({ accountName: 'second_account', steamId: '76561198000000002' }));
    await db.removeAccount("' OR 1=1 --");
    assert.equal((await db.all('SELECT * FROM steamprofiles')).length, 2);
    await db.removeAccount('offline_account');
    const remaining = await db.get('SELECT * FROM steamprofiles');
    assert.equal(remaining.username, 'second_account');
    await db.removeAccount(String(remaining.id));
    assert.deepEqual(await db.all('SELECT * FROM steamprofiles'), []);
});

test('database errors reject promises rather than hanging or reporting success', async t => {
    const { db } = await database(t);
    await assert.rejects(db.all('SELECT * FROM missing_table'), /SQLITE_ERROR/);
    await assert.rejects(db.get('SELECT * FROM missing_table'), /SQLITE_ERROR/);
    await assert.rejects(db.run('INSERT INTO missing_table VALUES (?)', ['offline']), /SQLITE_ERROR/);
});

test('pending operations prevent account removal until recovery is complete', async t => {
    const { db } = await database(t);
    await db.saveAccount(account());
    const saved = await db.get('SELECT id FROM steamprofiles');
    await db.run('INSERT INTO comment_operations(account_id,task_id,comment_id,rep_id,state,created_at) VALUES(?,?,?,?,?,?)',
        [saved.id, '21', '31', '11', 'posting', '2026-10-09T15:00:00.000Z']);
    for (const state of ['posting', 'posted']) {
        await db.run('UPDATE comment_operations SET state=?', [state]);
        await assert.rejects(db.removeAccount(String(saved.id)), /pending/i);
        assert.equal((await db.all('SELECT id FROM steamprofiles')).length, 1);
        assert.equal((await db.all('SELECT state FROM comment_operations')).length, 1);
    }
    await db.run('UPDATE comment_operations SET state=?', ['completed']);
    assert.equal(await db.removeAccount(String(saved.id)), true);
    assert.deepEqual(await db.all('SELECT state FROM comment_operations'), []);
});

test('account identity changes are refused without overwriting the saved session', async t => {
    const { db } = await database(t);
    await db.saveAccount(account());
    await assert.rejects(db.saveAccount(account({ steamId: '76561198000000002', token: 'replacement-token' })), /identity/i);
    const saved = await db.get('SELECT * FROM steamprofiles');
    assert.equal(saved.steamId, account().steamId);
    assert.equal(saved.token, 'offline-token');
    await db.saveAccount(account({ accountName: 'OFFLINE_ACCOUNT', token: 'renewed-token' }));
    assert.equal((await db.all('SELECT * FROM steamprofiles')).length, 1);
});

test('two database clients cannot both acquire the active process lock', async t => {
    const { db, file } = await database(t);
    const other = await openDatabase(file);
    t.after(() => other.close());
    await db.acquireRunLock();
    await assert.rejects(other.acquireRunLock(), /lock/i);
    await db.releaseRunLock();
    await other.acquireRunLock();
    await other.releaseRunLock();
});

test('a lock left by a dead process can be recovered after a crash', async t => {
    const { db } = await database(t);
    // This PID is outside Linux's practical pid_max and cannot name a test or production process.
    await db.run('INSERT INTO run_lock(id,pid) VALUES(1,?)', [2147483647]);
    await db.acquireRunLock();
    assert.equal((await db.get('SELECT pid FROM run_lock')).pid, process.pid);
    await db.releaseRunLock();
    assert.equal(await db.get('SELECT pid FROM run_lock'), undefined);
});

test('SQLite refuses public database files and symlink paths', async t => {
    if (process.platform === 'win32') return t.skip('Unix permissions and symlink fixtures');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'r4r-database-security-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const file = path.join(directory, 'public.db');
    fs.writeFileSync(file, '', { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    await assert.rejects(openDatabase(file), /0600/);
    fs.chmodSync(file, 0o600);
    const link = path.join(directory, 'linked.db');
    fs.symlinkSync(file, link);
    await assert.rejects(openDatabase(link));
    const hardlink = path.join(directory, 'hardlinked.db');
    fs.linkSync(file, hardlink);
    await assert.rejects(openDatabase(file));
    fs.unlinkSync(hardlink);
    const linkedDirectory = path.join(directory, 'linked-dir');
    const realDirectory = path.join(directory, 'real-dir');
    fs.mkdirSync(realDirectory, { mode: 0o700 });
    fs.symlinkSync(realDirectory, linkedDirectory);
    await assert.rejects(openDatabase(path.join(linkedDirectory, 'profiles.db')), /symlink/);
});

test('SQLite refuses unsafe existing sidecar files', async t => {
    if (process.platform === 'win32') return t.skip('Unix permission fixture');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'r4r-database-sidecar-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const file = path.join(directory, 'profiles.db');
    const sidecar = file + '-wal';
    fs.writeFileSync(sidecar, 'offline fixture');
    fs.chmodSync(sidecar, 0o644);
    await assert.rejects(openDatabase(file), /0600/);
    assert.equal(fs.statSync(sidecar).mode & 0o777, 0o644);
});

test('SQLite refuses a database directory writable by another user', async t => {
    if (process.platform === 'win32') return t.skip('Unix permission fixture');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'r4r-database-directory-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    fs.chmodSync(directory, 0o770);
    await assert.rejects(openDatabase(path.join(directory, 'profiles.db')), /writable by other users/);
    assert.equal(fs.existsSync(path.join(directory, 'profiles.db')), false);
});

test('config loader accepts a private token and rejects malformed, missing or public data', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'r4r-config-test-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const file = path.join(directory, 'config.json');
    fs.writeFileSync(file, JSON.stringify({ apiToken: 'offline-api-token' }), { mode: 0o600 });
    assert.equal(loadConfig(file).apiToken, 'offline-api-token');
    for (const data of [null, [], {}, { apiToken: '' }, { apiToken: 12 }]) {
        fs.writeFileSync(file, JSON.stringify(data));
        assert.throws(() => loadConfig(file));
    }
    fs.writeFileSync(file, '{ invalid');
    assert.throws(() => loadConfig(file));
    if (process.platform !== 'win32') {
        fs.chmodSync(file, 0o644);
        assert.throws(() => loadConfig(file));
    }
});
