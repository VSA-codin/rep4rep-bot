// SPDX-License-Identifier: MIT
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { describeSession } = require('../lib/session');

function token(aud, iat, exp) {
    const payload = Buffer.from(JSON.stringify({ aud, iat, exp })).toString('base64url');
    return encodeURIComponent('76561190000000000||h.' + payload + '.s');
}

test('describeSession reads the community token and reports expiry', () => {
    const now = 1_000_000;
    const cookies = JSON.stringify([
        'sessionid=abc',
        'steamLoginSecure=' + token(['web:help'], now - 3600, now + 3600),
        'steamLoginSecure=' + token(['web:community'], now - 67 * 3600, now - 43 * 3600) + '; Domain=steamcommunity.com'
    ]);
    assert.deepStrictEqual(describeSession(cookies, now), { issuedHoursAgo: 67, expiresInHours: -43, expired: true });
});

test('describeSession: fresh session, missing and broken input', () => {
    const now = 1_000_000;
    const fresh = JSON.stringify(['steamLoginSecure=' + token(['web:community'], now - 60, now + 86340)]);
    const r = describeSession(fresh, now);
    assert.strictEqual(r.expired, false);
    assert.strictEqual(r.expiresInHours, 24);
    assert.strictEqual(describeSession(null, now), null);
    assert.strictEqual(describeSession('not json', now), null);
    assert.strictEqual(describeSession(JSON.stringify(['sessionid=x']), now), null);
});

test('describeSession never exposes cookie values', () => {
    const now = 1_000_000;
    const out = JSON.stringify(describeSession(JSON.stringify(['steamLoginSecure=' + token(['web:community'], now - 1, now + 1)]), now));
    assert.ok(!out.includes('76561190000000000'));
});

test('auto-relogin without stored credentials explains itself and starts no cooldown', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'r4r-home-'));
    const script = "require('./auto-relogin').autoRelogin('someaccount', { run() {} }).then((r) => console.log('RESULT:' + r))";
    const res = spawnSync(process.execPath, ['-e', script], {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, HOME: home, USERPROFILE: home },
        encoding: 'utf8'
    });
    assert.strictEqual(res.status, 0, res.stderr);
    assert.match(res.stdout, /not set up on this machine/);
    assert.match(res.stdout, /RESULT:null/);
    assert.ok(!res.stdout.includes(home), 'output must not contain the home directory path');
    assert.strictEqual(fs.existsSync(path.join(home, '.config', 'r4r', 'relogin-attempts.json')), false);
    fs.rmSync(home, { recursive: true, force: true });
});
