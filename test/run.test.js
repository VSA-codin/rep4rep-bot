// SPDX-License-Identifier: MIT
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runAuto, RunError, hoursSince } = require('../src/run');
const { openDatabase } = require('../src/db');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r4r-run-'));
const opened = [];

// Windows refuses to delete a database file that is still open, so close them first.
test.after(async () => {
    await Promise.all(opened.map((handle) => handle.close()));
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const LOGIN = 'vacsecuredapproved';
const KEY = 'SECRET-API-KEY-123';
let counter = 0;

async function freshDb(rows) {
    const db = await openDatabase(path.join(tmp, 'run' + (counter++) + '.db'));
    opened.push(db);
    for (const r of rows) {
        await db.run('INSERT INTO steamprofiles (username, steamId, cookies, token, last_comment) VALUES (?, ?, ?, ?, ?)',
            [r.username || LOGIN, r.steamId || '7656119900000001', r.cookies === undefined ? '["a=b"]' : r.cookies, null, r.last || null]);
    }
    return db;
}

const task = (id, text) => ({ requestId: id, target: { steamId: '765' + id, name: 'T' + id }, comment: { id: 'c' + id, text }, ticket: 'tk' + id });

// Scripted Rep4Rep: routes by method + path.
function fakeApi(overrides = {}) {
    const calls = [];
    const api = {
        calls,
        async request(method, endpoint, body) {
            calls.push({ method, endpoint, body });
            const key = method + ' ' + endpoint.split('?')[0].replace(/\d{10,}/, ':id');
            if (overrides[key]) return typeof overrides[key] === 'function' ? overrides[key](body, calls) : overrides[key];
            const defaults = {
                'GET /steam-profiles': { ok: true, status: 200, body: { data: [{ steamId: '7656119900000001', dailyCommentLimit: 10, commentsToday: 0 }] } },
                'GET /steam-profiles/:id/tasks': { ok: true, status: 200, body: { data: [task('1', '+rep nice'), task('2', 'visit https://evil.example'), task('3', 'good game')] } },
                'POST /tasks': { ok: true, status: 201, body: {} },
                'POST /steam-profiles': { ok: true, status: 201, body: { data: { steamId: '7656119900000002', dailyCommentLimit: 10, commentsToday: 0 } } }
            };
            return defaults[key] || { ok: false, status: 404, body: { message: 'not found' } };
        }
    };
    return api;
}

function fakeSteam({ loggedIn = true, failPost = false } = {}) {
    const posted = [];
    const factory = () => ({
        posted,
        setCookies() {},
        loggedIn(cb) { cb(null, loggedIn); },
        postUserComment(id, text, cb) { if (failPost) cb(new Error('Steam says no')); else { posted.push(text); cb(null); } }
    });
    factory.posted = posted;
    return factory;
}

async function run(db, extra = {}) {
    const lines = [];
    const api = extra.api || fakeApi();
    const steam = extra.steam || fakeSteam();
    const pauses = [];
    await runAuto({
        config: extra.config || { apiToken: KEY },
        db,
        env: extra.env || {},
        say: (m) => lines.push(String(m)),
        deps: { api, createCommunity: steam, restoreSession: extra.restoreSession || (async () => null), pause: async (ms) => { pauses.push(ms); }, now: () => Date.parse('2026-11-08T12:00:00') }
    });
    return { lines, api, steam, pauses, text: lines.join('\n') };
}

test('hoursSince understands SQLite local timestamps and missing values', () => {
    const now = Date.parse('2026-11-08T12:00:00');
    assert.strictEqual(hoursSince('2026-11-07 10:00:00', now), 26);
    assert.strictEqual(hoursSince(null, now), Infinity);
    assert.strictEqual(hoursSince('garbage', now), Infinity);
});

test('a missing or placeholder API key stops the run', async () => {
    const db = await freshDb([{}]);
    await assert.rejects(runAuto({ config: {}, db, say() {} }), RunError);
    await assert.rejects(runAuto({ config: { apiToken: 'YOUR_KEY' }, db, say() {} }), /Missing apiToken/);
});

test('a rejected API key (401) stops the run with a clear message', async () => {
    const db = await freshDb([{}]);
    await assert.rejects(
        run(db, { api: fakeApi({ 'GET /steam-profiles': { ok: false, status: 401, body: {} } }) }),
        /rejected the API key/
    );
});

test('normal run: posts allowed comments, skips filtered ones, submits with the ticket, updates the cooldown', async () => {
    const db = await freshDb([{}]);
    const r = await run(db);
    assert.deepStrictEqual(r.steam.posted, ['+rep nice', 'good game']); // the filtered task was never posted
    const submits = r.api.calls.filter((c) => c.method === 'POST' && c.endpoint === '/tasks');
    assert.deepStrictEqual(submits.map((c) => c.body), [
        { steamId: '7656119900000001', requestId: '1', commentId: 'c1', ticket: 'tk1' },
        { steamId: '7656119900000001', requestId: '3', commentId: 'c3', ticket: 'tk3' }
    ]);
    assert.match(r.text, /\[FILTER\] Task 2 skipped: contains "http/);
    assert.deepStrictEqual(r.pauses, [15000, 15000]);
    const row = await db.get('SELECT last_comment FROM steamprofiles');
    assert.ok(row.last_comment, 'last_comment must be stored');
});

test('dry run never touches Steam or submits anything', async () => {
    const db = await freshDb([{}]);
    let created = 0;
    const steam = () => { created++; return fakeSteam()(); };
    const r = await run(db, { env: { R4R_DRY_RUN: '1' }, steam });
    assert.strictEqual(created, 0);
    assert.strictEqual(r.api.calls.filter((c) => c.method === 'POST').length, 0);
    assert.match(r.text, /\[DRY RUN\] would comment on and submit task 1/);
});

test('rejected session: explains why, tries to restore, skips the account when that fails', async () => {
    const db = await freshDb([{}]);
    let restoreCalls = 0;
    const r = await run(db, { steam: fakeSteam({ loggedIn: false }), restoreSession: async () => { restoreCalls++; return null; } });
    assert.strictEqual(restoreCalls, 1);
    assert.match(r.text, /\[SESSION\] va\*\*\*d: there is no usable saved web session|the saved web session/);
    assert.match(r.text, /\[RELOGIN\] va\*\*\*d: skipped/);
    assert.strictEqual(r.api.calls.filter((c) => c.endpoint.includes('/tasks')).length, 0);
});

test('rejected session that can be restored continues with the restored client', async () => {
    const db = await freshDb([{}]);
    const restored = { posted: [], postUserComment(id, text, cb) { this.posted.push(text); cb(null); } };
    const r = await run(db, { steam: fakeSteam({ loggedIn: false }), restoreSession: async () => restored });
    assert.deepStrictEqual(restored.posted, ['+rep nice', 'good game']);
    assert.match(r.text, /Submitted/);
});

test('accounts that are not ready or are out of daily comments are left alone', async () => {
    const recent = '2026-11-08 06:00:00';
    const db = await freshDb([{ last: recent }]);
    const r1 = await run(db);
    assert.match(r1.text, /not ready, next run possible in 18 h/);
    assert.strictEqual(r1.api.calls.filter((c) => c.endpoint.includes('/tasks')).length, 0);

    const db2 = await freshDb([{}]);
    const r2 = await run(db2, { api: fakeApi({ 'GET /steam-profiles': { ok: true, status: 200, body: { data: [{ steamId: '7656119900000001', dailyCommentLimit: 10, commentsToday: 10 }] } } }) });
    assert.match(r2.text, /daily comment limit/);
});

test('an account missing on Rep4Rep is registered first', async () => {
    const db = await freshDb([{ username: 'newone', steamId: '7656119900000002' }]);
    const r = await run(db, { api: fakeApi({ 'GET /steam-profiles': { ok: true, status: 200, body: { data: [] } } }) });
    const added = r.api.calls.find((c) => c.method === 'POST' && c.endpoint === '/steam-profiles');
    assert.deepStrictEqual(added.body, { profile: '7656119900000002' });
    assert.match(r.text, /registered on Rep4Rep/);
});

test('repeated tasks are not processed twice and the loop ends', async () => {
    const db = await freshDb([{}]);
    const r = await run(db);
    assert.strictEqual(r.api.calls.filter((c) => c.endpoint.includes('/tasks') && c.method === 'GET').length, 2);
    assert.match(r.text, /no new tasks right now/);
});

test('two failed submissions stop the account', async () => {
    const db = await freshDb([{}]);
    const api = fakeApi({
        'GET /steam-profiles/:id/tasks': { ok: true, status: 200, body: { data: [task('1', 'a'), task('2', 'b'), task('3', 'c')] } },
        'POST /tasks': { ok: false, status: 409, body: { message: 'taken' } }
    });
    const r = await run(db, { api });
    assert.strictEqual(r.api.calls.filter((c) => c.method === 'POST' && c.endpoint === '/tasks').length, 2);
    assert.match(r.text, /two failures in a row/);
});

test('R4R_ONLY with an unknown login ends the run with a clear message', async () => {
    const db = await freshDb([{}]);
    await assert.rejects(run(db, { env: { R4R_ONLY: 'nobody' } }), /no saved account has that login name/);
});

test('output never contains the API key or the full login name', async () => {
    const db = await freshDb([{}]);
    const r = await run(db, { steam: fakeSteam({ loggedIn: false }) });
    assert.ok(!r.text.includes(KEY));
    assert.ok(!r.text.includes(LOGIN));
    assert.ok(r.text.includes('va***d'));
});
