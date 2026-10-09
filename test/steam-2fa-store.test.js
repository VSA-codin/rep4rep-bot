'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {createStore, validateSecret} = require('../steam-2fa/src/store');
const {generateCodeFromSecret} = require('../steam-2fa');

// Synthetic 20-byte fixtures; no Steam account or live authenticator is used.
const secrets = {shared_secret: Buffer.alloc(20, 7).toString('base64'),
    identity_secret: Buffer.alloc(20, 8).toString('base64'), revocation_code: 'R00000'};

function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r4r-2fa-store-'));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    return {dir, store: createStore({env: {R4R_2FA_DIR: dir}})};
}

function write(file, value) {
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), {mode: 0o600});
}

test('multiple accounts retain their own secrets and existing authenticators cannot be overwritten', t => {
    const {store} = fixture(t);
    const second = {...secrets, shared_secret: Buffer.alloc(20, 9).toString('base64')};
    store.saveAccountSecrets('First', secrets);
    store.saveAccountSecrets('Second', second);
    assert.deepEqual(store.getAccountSecrets('FIRST'), secrets);
    assert.deepEqual(store.getAccountSecrets('second'), second);
    assert.equal(store.getAccountSecrets('missing'), null);
    assert.throws(() => store.saveAccountSecrets('first', second), /overwrite/);
    assert.deepEqual(store.getAccountSecrets('First'), secrets);
    assert.equal(fs.statSync(store.getConfigPath()).mode & 0o777, 0o600);
});

test('secrets reject malformed encoding, incorrect lengths and unsupported types', t => {
    const {store} = fixture(t);
    for (const value of [null, {}, '', 'not-base64', Buffer.alloc(19).toString('base64'),
        Buffer.alloc(21).toString('base64'), secrets.shared_secret + '\n']) {
        assert.throws(() => store.saveAccountSecrets('account', {shared_secret: value}));
        assert.throws(() => generateCodeFromSecret(value));
    }
    assert.equal(validateSecret('07'.repeat(20)), '07'.repeat(20));
    assert.throws(() => store.saveAccountSecrets('account', {...secrets, identity_secret: 12}));
    assert.throws(() => store.saveAccountSecrets('account', {...secrets, revocation_code: 'bad\ncode'}));
});

test('all store records are validated before use; invalid JSON is not treated as an empty store', t => {
    const {store} = fixture(t);
    for (const value of ['{secret broken', null, [], {account: null}, {account: {shared_secret: 'bad'}},
        {Account: secrets, account: secrets}, JSON.parse('{"__proto__":{}}')]) {
        write(store.getConfigPath(), value);
        assert.throws(() => store.getAccountSecrets('account'));
        assert.throws(() => store.saveAccountSecrets('other', secrets));
    }
});

test('reserved names, traversal, path separators and whitespace cannot become account paths', t => {
    const {store} = fixture(t);
    for (const name of ['__proto__', 'CONSTRUCTOR', 'prototype', '../other', 'a/b', 'a\\b', '',
        'two accounts', 'name\0', 'a'.repeat(65)]) {
        assert.throws(() => store.getPendingPath(name));
        assert.throws(() => store.saveAccountSecrets(name, secrets));
    }
});

test('pending writes are exclusive and replacement must match the enrollment reservation', t => {
    const {store} = fixture(t);
    const reservation = {state: 'requesting', account_name: 'Account',
        reservation_id: randomUUID(), created_at: new Date().toISOString()};
    store.writePending('Account', reservation);
    assert.throws(() => store.writePending('ACCOUNT', secrets));
    assert.throws(() => store.writePending('account', secrets, {replace: true, expectedReservationId: randomUUID()}));
    assert.deepEqual(store.readPending('account'), reservation);
    store.writePending('account', {...secrets, state: 'pending'},
        {replace: true, expectedReservationId: reservation.reservation_id});
    assert.equal(store.readPending('Account').shared_secret, secrets.shared_secret);
    assert.throws(() => store.writePending('account', secrets,
        {replace: true, expectedReservationId: reservation.reservation_id}));
    assert.equal(store.deletePending('account'), true);
    assert.equal(store.deletePending('account'), false);
});

test('legacy case-sensitive pending paths remain recoverable and duplicates fail closed', t => {
    const {store, dir} = fixture(t);
    const legacy = path.join(dir, 'AccOuNt.2fa-pending.json');
    write(legacy, secrets);
    assert.equal(store.getPendingPath('account'), legacy);
    assert.deepEqual(store.readPending('ACCOUNT'), secrets);
    write(path.join(dir, 'account.2fa-pending.json'), secrets);
    assert.throws(() => store.readPending('Account'), /Multiple/);
});

test('pending content and account binding are validated without replacing files', t => {
    const {store} = fixture(t);
    for (const value of [[], null, {shared_secret: 'invalid'}, {...secrets, account_name: 'other'},
        {state: 'requesting', created_at: 'invalid', reservation_id: randomUUID()},
        {...secrets, state: 'unknown'}]) {
        write(store.getPendingPath('account'), value);
        assert.throws(() => store.readPending('account'));
    }
});

test('secret and pending files reject symlinks, hardlinks and public permissions', t => {
    const {store, dir} = fixture(t);
    const target = path.join(dir, 'target.json');
    write(target, {account: secrets});
    fs.symlinkSync(target, store.getConfigPath());
    assert.throws(() => store.getAccountSecrets('account'));
    assert.throws(() => store.saveAccountSecrets('other', secrets));
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), {account: secrets});
    fs.unlinkSync(store.getConfigPath());
    fs.linkSync(target, store.getConfigPath());
    assert.throws(() => store.getAccountSecrets('account'));
    fs.unlinkSync(store.getConfigPath());
    fs.chmodSync(target, 0o644);
    fs.renameSync(target, store.getConfigPath());
    assert.throws(() => store.getAccountSecrets('account'));
    fs.symlinkSync(store.getConfigPath(), store.getPendingPath('account'));
    assert.throws(() => store.readPending('account'));
    assert.throws(() => store.deletePending('account'));
});

test('a live or stale store lock prevents another writer from losing data', t => {
    const {store} = fixture(t);
    write(store.getConfigPath() + '.lock', {pid: 1});
    assert.throws(() => store.saveAccountSecrets('account', secrets));
    assert.deepEqual(JSON.parse(fs.readFileSync(store.getConfigPath() + '.lock', 'utf8')), {pid: 1});
});

test('TOTP generation is deterministic for a known synthetic secret and clock', () => {
    const original = Date.now;
    Date.now = () => 1700000000000;
    try {
        assert.equal(generateCodeFromSecret(Buffer.alloc(20, 7).toString('base64')), '2XF5Q');
    } finally {
        Date.now = original;
    }
});
