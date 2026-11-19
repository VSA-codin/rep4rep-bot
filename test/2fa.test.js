// SPDX-License-Identifier: MIT
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// The store reads R4R_2FA_DIR when it is first loaded, so set it before requiring.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r4r-2fa-test-'));
process.env.R4R_2FA_DIR = dir;

const store = require('../steam-2fa/src/store');
const totp = require('../steam-2fa/src/totp');

const CODE_RE = /^[23456789BCDFGHJKMNPQRTVWXY]{5}$/;
const SECRET = Buffer.from('0123456789abcdef0123').toString('base64');
const CLI = path.join(__dirname, '..', 'steam-2fa', 'scripts', 'code.js');

function runCli(args) {
    return spawnSync(process.execPath, [CLI, ...args], {
        env: { ...process.env, R4R_2FA_DIR: dir },
        encoding: 'utf8'
    });
}

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('store: saves, lists and reads accounts without exposing secrets in the list', () => {
    store.saveAccountSecrets('alice', { shared_secret: SECRET, identity_secret: 'id', revocation_code: 'R12345' });
    assert.deepStrictEqual(store.listAccounts(), ['alice']);
    assert.strictEqual(store.hasAccountSecrets('alice'), true);
    assert.strictEqual(store.hasAccountSecrets('bob'), false);
});

test('store: secrets file and directory are private on POSIX', { skip: process.platform === 'win32' }, () => {
    const file = store.getConfigPath();
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
    assert.strictEqual(fs.statSync(dir).mode & 0o777, 0o700);
});

test('store: prototype keys and control characters are not treated as accounts', () => {
    assert.strictEqual(store.getAccountSecrets('constructor'), null);
    assert.strictEqual(store.getAccountSecrets('toString'), null);
    assert.throws(() => store.getAccountSecrets('__proto__'), /Invalid Steam account name/);
    assert.throws(() => store.getAccountSecrets('a\nb'), /Invalid Steam account name/);
});

test('totp: generates a 5 character Steam Guard code and a sane countdown', () => {
    assert.match(totp.generateCodeForAccount('alice'), CODE_RE);
    assert.strictEqual(totp.secondsRemaining(0), 30);
    assert.strictEqual(totp.secondsRemaining(29000), 1);
    assert.strictEqual(totp.secondsRemaining(30000), 30);
    assert.strictEqual(totp.secondsRemaining(0, 5), 25);
    assert.throws(() => totp.generateCodeForAccount('nobody'), /No authenticator stored/);
});

test('cli: --plain prints only the code and never the secret', () => {
    const res = runCli(['alice', '--plain']);
    assert.strictEqual(res.status, 0);
    assert.match(res.stdout.trim(), CODE_RE);
    assert.ok(!res.stdout.includes(SECRET) && !res.stderr.includes(SECRET));
});

test('cli: account can be omitted when exactly one is stored; --list shows names only', () => {
    const res = runCli(['--plain']);
    assert.strictEqual(res.status, 0);
    assert.match(res.stdout.trim(), CODE_RE);
    const list = runCli(['--list']);
    assert.strictEqual(list.stdout.trim(), 'alice');
    assert.ok(!list.stdout.includes('R12345') && !list.stdout.includes(SECRET));
});

test('cli: readable output, unknown account and bad options fail cleanly', () => {
    const ok = runCli(['alice']);
    assert.match(ok.stdout, /^alice: [23456789BCDFGHJKMNPQRTVWXY]{5} {2}\(valid for \d+ s\)/);
    assert.strictEqual(runCli(['nobody']).status, 1);
    assert.strictEqual(runCli(['--bogus']).status, 2);
    assert.strictEqual(runCli(['alice', '--watch', '--plain']).status, 2);
});

test('cli: with several accounts, the account must be named', () => {
    store.saveAccountSecrets('bob', { shared_secret: SECRET });
    const res = runCli(['--plain']);
    assert.strictEqual(res.status, 1);
    assert.match(res.stderr, /Several accounts are stored/);
});

// ---- 2fa:check (read-only health check) ----
const CHECK = path.join(__dirname, '..', 'steam-2fa', 'scripts', 'check.js');

function runCheck(dirPath, args = []) {
    return spawnSync(process.execPath, [CHECK, ...args], {
        env: { ...process.env, R4R_2FA_DIR: dirPath },
        encoding: 'utf8'
    });
}

test('check: reports a healthy setup without printing any secret or code', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'r4r-2fa-check-'));
    fs.chmodSync(d, 0o700);
    fs.writeFileSync(path.join(d, 'steam-2fa.json'), JSON.stringify({
        alice: { shared_secret: SECRET, identity_secret: 'IDSECRET-VALUE', revocation_code: 'R12345' }
    }), { mode: 0o600 });
    fs.writeFileSync(path.join(d, 'steam-passwords.json'), JSON.stringify({ alice: 'PW-VALUE' }), { mode: 0o600 });

    const res = runCheck(d);
    assert.strictEqual(res.status, 0, res.stdout);
    assert.match(res.stdout, /al\*\*\*e: shared_secret OK, code generation OK, identity_secret yes, revocation_code yes/);
    assert.match(res.stdout, /Result: OK/);
    for (const secret of [SECRET, 'IDSECRET-VALUE', 'R12345', 'PW-VALUE', 'alice']) {
        assert.ok(!res.stdout.includes(secret), 'output leaked ' + secret);
    }
    assert.match(runCheck(d, ['--show-names']).stdout, /alice: shared_secret OK/);
    fs.rmSync(d, { recursive: true, force: true });
});

test('check: flags damaged secrets and mismatched password/authenticator pairs', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'r4r-2fa-check-'));
    fs.chmodSync(d, 0o700);
    fs.writeFileSync(path.join(d, 'steam-2fa.json'), JSON.stringify({
        broken: { shared_secret: 'not-a-real-secret' },
        empty: {}
    }), { mode: 0o600 });
    fs.writeFileSync(path.join(d, 'steam-passwords.json'), JSON.stringify({ orphan: 'x' }), { mode: 0o600 });

    const res = runCheck(d);
    assert.strictEqual(res.status, 1);
    assert.match(res.stdout, /PROBLEM/);
    assert.match(res.stdout, /has a password but no authenticator/);
    fs.rmSync(d, { recursive: true, force: true });
});

test('check: warns about permissive files on POSIX', { skip: process.platform === 'win32' }, () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'r4r-2fa-check-'));
    fs.chmodSync(d, 0o755);
    fs.writeFileSync(path.join(d, 'steam-2fa.json'), JSON.stringify({ a: { shared_secret: SECRET, revocation_code: 'R1' } }), { mode: 0o644 });
    const res = runCheck(d);
    assert.match(res.stdout, /accessible by other users/);
    // the check itself must not change anything
    assert.strictEqual(fs.statSync(path.join(d, 'steam-2fa.json')).mode & 0o777, 0o644);
    fs.rmSync(d, { recursive: true, force: true });
});

test('migration: a file written by the previous 2FA module format is read unchanged', () => {
    // Same on-disk layout the old tool produced: account -> { shared_secret, identity_secret, revocation_code }
    const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r4r-2fa-legacy-'));
    fs.chmodSync(legacyDir, 0o700);
    fs.writeFileSync(path.join(legacyDir, 'steam-2fa.json'), JSON.stringify({
        legacyacct: { shared_secret: SECRET, identity_secret: 'id==', revocation_code: 'R54321' }
    }, null, 2), { mode: 0o600 });
    const res = spawnSync(process.execPath, [CLI, 'legacyacct', '--plain'], {
        env: { ...process.env, R4R_2FA_DIR: legacyDir }, encoding: 'utf8'
    });
    assert.strictEqual(res.status, 0, res.stderr);
    assert.match(res.stdout.trim(), CODE_RE);
    fs.rmSync(legacyDir, { recursive: true, force: true });
});
