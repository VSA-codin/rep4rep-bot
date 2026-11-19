// SPDX-License-Identifier: MIT
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { signIn, saveSession, listAccounts, hasAccount, removeAccount } = require('../src/accounts');
const { openDatabase } = require('../src/db');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r4r-accounts-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

// A scripted Steam client: each call to login() consumes the next scripted outcome.
function scripted(outcomes) {
    const seen = [];
    const factory = () => ({
        steamID: { getSteamID64: () => '76561190000000001' },
        login(credentials, done) {
            seen.push(credentials);
            const next = outcomes.shift();
            if (next.error) done(next.error);
            else done(null, 'sid', ['steamLoginSecure=x'], null, next.oauth || null);
        }
    });
    return { factory, seen };
}

function fakePrompt(answers) {
    const asked = [];
    return {
        asked,
        ask: async (q) => { asked.push(q); return answers.length ? answers.shift() : null; },
        askHidden: async (q) => { asked.push(q); return answers.length ? answers.shift() : null; }
    };
}

const guard = (message, extra = {}) => ({ error: Object.assign(new Error(message), extra) });
const quiet = () => {};

test('signIn: plain success returns the SteamID and the session cookies', async () => {
    const s = scripted([{ oauth: 'tok' }]);
    const r = await signIn({ login: 'alice', password: 'pw', prompt: fakePrompt([]), createCommunity: s.factory, say: quiet });
    assert.deepStrictEqual(r, { steamId: '76561190000000001', cookies: ['steamLoginSecure=x'], oauthToken: 'tok' });
    assert.strictEqual(s.seen[0].accountName, 'alice');
});

test('signIn: authenticator step uses the stored authenticator and never asks', async () => {
    const s = scripted([guard('SteamGuardMobile'), {}]);
    const p = fakePrompt([]);
    await signIn({ login: 'alice', password: 'pw', prompt: p, createCommunity: s.factory, say: quiet, authenticatorCode: () => 'ABCDE' });
    assert.strictEqual(s.seen[1].twoFactorCode, 'ABCDE');
    assert.deepStrictEqual(p.asked, []);
});

test('signIn: a rejected stored code falls back to asking the user (no endless loop)', async () => {
    const s = scripted([guard('SteamGuardMobile'), guard('SteamGuardMobile'), {}]);
    const p = fakePrompt(['  12345  ']);
    await signIn({ login: 'alice', password: 'pw', prompt: p, createCommunity: s.factory, say: quiet, authenticatorCode: () => 'ABCDE' });
    assert.strictEqual(s.seen[1].twoFactorCode, 'ABCDE');
    assert.strictEqual(s.seen[2].twoFactorCode, '12345');
    assert.strictEqual(p.asked.length, 1);
});

test('signIn: without a stored authenticator the code is typed in', async () => {
    const s = scripted([guard('SteamGuardMobile'), {}]);
    await signIn({ login: 'alice', password: 'pw', prompt: fakePrompt(['99999']), createCommunity: s.factory, say: quiet, authenticatorCode: () => null });
    assert.strictEqual(s.seen[1].twoFactorCode, '99999');
});

test('signIn: e-mail code and CAPTCHA steps', async () => {
    const s = scripted([guard('SteamGuard', { emaildomain: 'example.com' }), guard('CAPTCHA', { captchaurl: 'https://captcha.example' }), {}]);
    const said = [];
    await signIn({ login: 'alice', password: 'pw', prompt: fakePrompt(['MAIL1', 'xyz']), createCommunity: s.factory, say: (m) => said.push(m) });
    assert.strictEqual(s.seen[1].authCode, 'MAIL1');
    assert.strictEqual(s.seen[2].captcha, 'xyz');
    assert.strictEqual(s.seen[2].authCode, 'MAIL1');
    assert.ok(said.some((m) => m.includes('example.com')));
});

test('signIn: failure messages show the login masked', async () => {
    const s = scripted([guard('Invalid password for vacsecuredapproved')]);
    await assert.rejects(
        signIn({ login: 'vacsecuredapproved', password: 'pw', prompt: fakePrompt([]), createCommunity: s.factory, say: quiet }),
        (err) => err.message === 'Invalid password for va***d'
    );
});

test('signIn: ended input, missing SteamID and too many rounds are reported', async () => {
    await assert.rejects(
        signIn({ login: 'a', password: 'p', prompt: fakePrompt([]), createCommunity: scripted([guard('SteamGuardMobile')]).factory, say: quiet, authenticatorCode: () => null }),
        /Input ended/
    );
    const noId = () => ({ steamID: null, login: (c, done) => done(null, 's', [], null, null) });
    await assert.rejects(
        signIn({ login: 'a', password: 'p', prompt: fakePrompt([]), createCommunity: noId, say: quiet }),
        /did not report a SteamID/
    );
    const endless = Array.from({ length: 10 }, () => guard('SteamGuardMobile'));
    await assert.rejects(
        signIn({ login: 'a', password: 'p', prompt: fakePrompt(Array(10).fill('1')), createCommunity: scripted(endless).factory, say: quiet, authenticatorCode: () => null }),
        /Too many Steam Guard attempts/
    );
});

test('database: saveSession inserts, updates, lists, finds and removes accounts', async () => {
    const db = await openDatabase(path.join(tmp, 'a.db'));
    await saveSession(db, 'alice', '111', ['c=1'], 'tok');
    await saveSession(db, 'alice', '111', ['c=2'], null); // same account: update, not a second row
    await saveSession(db, '777', '222', ['c=3'], null);   // a numeric login name
    assert.strictEqual((await listAccounts(db)).length, 2);
    assert.deepStrictEqual(JSON.parse((await db.get('SELECT cookies FROM steamprofiles WHERE username = ?', ['alice'])).cookies), ['c=2']);
    assert.strictEqual(await hasAccount(db, 'alice'), true);
    assert.strictEqual(await hasAccount(db, 'nobody'), false);

    // "777" is a login name AND could be read as a record id: the login wins.
    await saveSession(db, 'carol', '333', [], null);
    const carol = await db.get('SELECT id FROM steamprofiles WHERE username = ?', ['carol']);
    assert.strictEqual(await removeAccount(db, '777'), 1);
    assert.strictEqual(await hasAccount(db, '777'), false);
    assert.strictEqual(await hasAccount(db, 'carol'), true);
    assert.strictEqual(await removeAccount(db, String(carol.id)), 1); // no login matches: id fallback
    assert.strictEqual(await removeAccount(db, 'nobody'), 0);
    await db.close();
});

test('database: file is private on POSIX', { skip: process.platform === 'win32' }, async () => {
    const file = path.join(tmp, 'private.db');
    const db = await openDatabase(file);
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
    await db.close();
});
