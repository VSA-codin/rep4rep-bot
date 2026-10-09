'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
    readPrivateJson,
    atomicWritePrivateJson,
    removePrivateFile,
    ensurePrivateDirectory,
    getPrivatePaths,
    validateAccountName
} = require('../lib/private-files');
const { withTimeout, sleep } = require('../lib/async');

function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r4r-private-'));
    fs.chmodSync(dir, 0o700);
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return { dir, file: path.join(dir, 'secrets.json') };
}

test('atomic writes preserve private modes and support safe replacement and removal', t => {
    const { dir, file } = fixture(t);
    atomicWritePrivateJson(file, { account: 'offline fixture' });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    atomicWritePrivateJson(file, { account: 'updated fixture' });
    assert.deepEqual(readPrivateJson(file), { account: 'updated fixture' });
    assert.equal(removePrivateFile(file), true);
    assert.equal(removePrivateFile(file), false);
});

test('exclusive publication and failed serialization preserve the previous store', t => {
    const { dir, file } = fixture(t);
    atomicWritePrivateJson(file, { version: 1 }, { overwrite: false });
    assert.throws(() => atomicWritePrivateJson(file, { version: 2 }, { overwrite: false }), { code: 'EEXIST' });
    const circular = {}; circular.self = circular;
    assert.throws(() => atomicWritePrivateJson(file, circular), TypeError);
    assert.deepEqual(readPrivateJson(file), { version: 1 });
    assert.deepEqual(fs.readdirSync(dir), ['secrets.json']);
});

test('unsafe modes are rejected without silently changing existing files or directories', t => {
    const { dir, file } = fixture(t);
    fs.writeFileSync(file, '{}', { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    assert.throws(() => readPrivateJson(file), { code: 'EPRIVATEFILE' });
    assert.throws(() => atomicWritePrivateJson(file, {}), { code: 'EPRIVATEFILE' });
    assert.equal(fs.statSync(file).mode & 0o777, 0o644);
    fs.chmodSync(file, 0o600);
    fs.chmodSync(dir, 0o755);
    assert.throws(() => readPrivateJson(file), { code: 'EPRIVATEFILE' });
    assert.throws(() => ensurePrivateDirectory(dir), { code: 'EPRIVATEFILE' });
    assert.deepEqual(readPrivateJson(file, { privateDirectory: false }), {});
    atomicWritePrivateJson(file, { safe: true }, { privateDirectory: false });
    assert.equal(fs.statSync(dir).mode & 0o777, 0o755);
});

test('symlinks, hardlinks, and symlink parent directories cannot expose private data', t => {
    const { dir, file } = fixture(t);
    const target = path.join(dir, 'target.json');
    atomicWritePrivateJson(target, { private: true });
    fs.symlinkSync(target, file);
    assert.throws(() => readPrivateJson(file), { code: 'EPRIVATEFILE' });
    assert.throws(() => atomicWritePrivateJson(file, {}), { code: 'EPRIVATEFILE' });
    assert.throws(() => removePrivateFile(file), { code: 'EPRIVATEFILE' });
    fs.unlinkSync(file);
    fs.linkSync(target, file);
    assert.throws(() => readPrivateJson(file), { code: 'EPRIVATEFILE' });
    assert.throws(() => readPrivateJson(target), { code: 'EPRIVATEFILE' });
    fs.unlinkSync(file);
    const alias = path.join(dir, 'alias');
    fs.symlinkSync(dir, alias);
    assert.throws(() => readPrivateJson(path.join(alias, 'target.json')), { code: 'EPRIVATEFILE' });
    assert.throws(() => ensurePrivateDirectory(path.join(alias, 'child')), { code: 'EPRIVATEFILE' });
    assert.deepEqual(readPrivateJson(target), { private: true });
});

test('fallback applies only to absent files and JSON parser errors conceal file contents', t => {
    const { file } = fixture(t);
    assert.deepEqual(readPrivateJson(file, { fallback: { absent: true } }), { absent: true });
    assert.throws(() => readPrivateJson(file), { code: 'ENOENT' });
    fs.writeFileSync(file, '{"password":"offline-sensitive-value"', { mode: 0o600 });
    assert.throws(() => readPrivateJson(file, { fallback: {} }), error => {
        assert.equal(error.code, 'EPRIVATEJSON');
        assert.ok(!error.message.includes('offline-sensitive-value'));
        return true;
    });
    assert.throws(() => readPrivateJson(file, { maxBytes: 5 }), { code: 'EPRIVATEFILE' });
});

test('path settings consistently honor the 2FA directory and explicit file overrides', t => {
    const { dir } = fixture(t);
    const paths = getPrivatePaths({ R4R_2FA_DIR: dir });
    assert.equal(paths.secrets, path.join(dir, 'steam-2fa.json'));
    assert.equal(paths.passwords, path.join(dir, 'steam-passwords.json'));
    assert.equal(paths.retry, path.join(dir, 'relogin-attempts.json'));
    const overrides = getPrivatePaths({
        R4R_2FA_DIR: dir,
        R4R_2FA_FILE: path.join(dir, 'custom.json'),
        R4R_PASSWORDS_FILE: path.join(dir, 'passwords.json'),
        R4R_RELOGIN_FILE: path.join(dir, 'retry.json')
    });
    assert.equal(overrides.secrets, path.join(dir, 'custom.json'));
    assert.equal(overrides.passwords, path.join(dir, 'passwords.json'));
    assert.equal(overrides.retry, path.join(dir, 'retry.json'));
});

test('account names reject path traversal, control characters, and prototype keys', () => {
    assert.equal(validateAccountName(' Steam_User42 '), 'Steam_User42');
    for (const name of ['', '../user', 'a/b', 'a\\b', 'user\nother', '__proto__', 'Constructor', 'prototype', 'x'.repeat(65)]) {
        assert.throws(() => validateAccountName(name), { code: 'EACCOUNT' });
    }
});

test('timeouts and cancellation settle once and do not accept late callbacks', async () => {
    let late;
    await assert.rejects(withTimeout(done => { late = done; }, 5), { code: 'ETIMEDOUT' });
    late(null, 'late result');
    const controller = new AbortController();
    const pending = withTimeout(() => {}, 1000, 'Fixture', { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, { code: 'ABORT_ERR' });
    await assert.rejects(sleep(100, { signal: controller.signal }), { code: 'ABORT_ERR' });
    assert.equal(await withTimeout(done => done(null, 'result'), 100), 'result');
    assert.equal(await withTimeout(() => Promise.resolve('promise result'), 100), 'promise result');
    await assert.rejects(withTimeout(() => { throw new Error('fixture'); }, 100), /fixture/);
});
