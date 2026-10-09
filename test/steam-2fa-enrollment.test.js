'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {PassThrough} = require('node:stream');
const {spawnSync} = require('node:child_process');
const {createStore} = require('../steam-2fa/src/store');
const {enroll, finalize, errorMessage} = require('../steam-2fa/src/enrollment');
const {run} = require('../steam-2fa/src/cli');
const {withTimeout} = require('../lib/async');

const secrets = {shared_secret: Buffer.alloc(20, 7).toString('base64'),
    identity_secret: Buffer.alloc(20, 8).toString('base64'), revocation_code: 'R00000'};

function fixture(t, overrides = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r4r-2fa-flow-'));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    const calls = [];
    const logs = [];
    const community = {
        mobileAccessToken: 'offline-access-token',
        steamID: {getSteamID64: () => '76561198000000000'},
        login(details, callback) { calls.push({method: 'login', details}); callback(null); },
        enableTwoFactor(callback) { calls.push({method: 'enable'}); callback(null, secrets); },
        httpRequestPost(options, callback) {
            calls.push({method: 'request', options});
            callback(null, {statusCode: 200}, {response: options.uri.includes('QueryTime')
                ? {server_time: 1700000000} : {success: true}});
        },
        ...overrides
    };
    const store = createStore({env: {R4R_2FA_DIR: dir}});
    return {dir, calls, logs, community, store,
        options: {accountName: 'offline_account', password: 'offline-password', community, store,
            timeoutMs: 50, promptTimeoutMs: 50, ask: async () => '000000', log: message => logs.push(message),
            authenticate: (client, details, limits) => withTimeout(done => client.login(details, done),
                limits.timeoutMs, 'Steam login', limits),
            sendRequest: (client, details, callback) => client.httpRequestPost(details, callback),
            enableAuthenticator: options => withTimeout(done => options.community.enableTwoFactor(done),
                options.timeoutMs, 'Steam enrollment', options)}};
}

test('enrollment stores the reservation before Steam and durable secrets before deleting pending', async t => {
    const fixtureData = fixture(t);
    const {options, store, calls, community} = fixtureData;
    community.enableTwoFactor = callback => {
        assert.equal(store.readPending('offline_account').state, 'requesting');
        calls.push({method: 'enable'});
        callback(null, secrets);
    };
    await enroll(options);
    assert.deepEqual(calls.map(call => call.method), ['login', 'enable', 'request', 'request']);
    assert.deepEqual(store.getAccountSecrets('offline_account'), secrets);
    assert.equal(store.readPending('offline_account'), null);
    assert.equal(calls[0].details.disableMobile, false);
    assert.equal(calls[3].options.form.access_token, 'offline-access-token');
    assert.equal(calls[3].options.uri.includes('offline-access-token'), false);
    assert.equal(calls[3].options.form.activation_code, '000000');
    assert.equal(fixtureData.logs.join('\n').includes(secrets.shared_secret), false);
});

test('production enrollment uses bounded mobile API requests with tokens kept out of URLs', async t => {
    const {options, store, calls} = fixture(t);
    delete options.enableAuthenticator;
    delete options.sendRequest;
    options.community.request = (details, callback) => {
        calls.push({method: 'api', details});
        const response = details.uri.includes('AddAuthenticator/v1/')
            && !details.uri.includes('Finalize') ? {...secrets, status: 1}
            : details.uri.includes('QueryTime') ? {server_time: 1700000000} : {success: true};
        callback(null, {statusCode: 200}, {response});
        return {abort() {assert.fail('Successful request was aborted');}};
    };
    await enroll(options);
    const requests = calls.filter(call => call.method === 'api');
    assert.equal(requests.length, 3);
    assert.match(requests[0].details.uri, /\/AddAuthenticator\/v1\/$/);
    assert.equal(requests[0].details.method, 'POST');
    assert.equal(requests[0].details.timeout, options.timeoutMs);
    assert.equal(requests[0].details.form.access_token, 'offline-access-token');
    assert.match(requests[0].details.form.device_identifier, /^android:[a-f0-9-]{36}$/);
    assert.equal(requests.every(call => !call.details.uri.includes('offline-access-token')), true);
    assert.deepEqual(store.getAccountSecrets('offline_account'), secrets);
});

test('production request deadlines abort outstanding handles and preserve uncertain enrollment', async t => {
    for (const mode of ['enroll', 'finalize']) {
        const {options, store} = fixture(t);
        delete options.enableAuthenticator;
        delete options.sendRequest;
        let aborted = 0;
        let lateCallback;
        options.community.request = (details, callback) => {
            lateCallback = callback;
            return {abort() {aborted++;}};
        };
        if (mode === 'finalize') store.writePending('offline_account', secrets);
        await assert.rejects((mode === 'enroll' ? enroll : finalize)({...options, timeoutMs: 5}), {code: 'ETIMEDOUT'});
        assert.equal(aborted, 1);
        lateCallback(null, {statusCode: 200}, {response: {...secrets, status: 1, success: true}});
        assert.equal(store.hasAccountSecrets('offline_account'), false);
        assert.equal(store.readPending('offline_account').state, mode === 'enroll' ? 'requesting' : undefined);
    }
});

test('existing authenticators and pending enrollments block all Steam calls', async t => {
    const {options, store, calls} = fixture(t);
    store.saveAccountSecrets('offline_account', secrets);
    await assert.rejects(enroll(options), {code: 'EEXISTING'});
    assert.equal(calls.length, 0);
    const other = fixture(t);
    other.store.writePending('offline_account', secrets);
    await assert.rejects(enroll(other.options), {code: 'EPENDING'});
    assert.equal(other.calls.length, 0);
});

test('an uncertain enrollment timeout retains a reservation and cannot be retried or finalized automatically', async t => {
    let lateCallback;
    const {options, store, calls} = fixture(t, {enableTwoFactor(callback) {lateCallback = callback;}});
    await assert.rejects(enroll({...options, timeoutMs: 5}), {code: 'ETIMEDOUT'});
    assert.equal(store.readPending('offline_account').state, 'requesting');
    lateCallback(null, secrets);
    assert.equal(store.readPending('offline_account').state, 'requesting');
    await assert.rejects(enroll(options), {code: 'EPENDING'});
    await assert.rejects(finalize(options), {code: 'EUNCERTAIN'});
    assert.equal(calls.length, 1);
});

test('rate limits and malformed enrollment responses preserve the reservation without retries', async t => {
    for (const response of [new Error('429 secret=offline-password'), {}, {shared_secret: 'broken'}]) {
        let requests = 0;
        const {options, store} = fixture(t, {enableTwoFactor(callback) {
            requests++;
            callback(response instanceof Error ? response : null, response);
        }});
        await assert.rejects(enroll(options), error => !error.message.includes('offline-password'));
        assert.equal(requests, 1);
        assert.equal(store.readPending('offline_account').state, 'requesting');
    }
});

test('empty input and EOF preserve valid pending secrets for later finalization', async t => {
    for (const ask of [async () => '', async () => {throw Object.assign(new Error('EOF'), {code: 'ABORT_ERR'});}]) {
        const {options, store, calls} = fixture(t);
        await assert.rejects(enroll({...options, ask}));
        assert.equal(store.readPending('offline_account').shared_secret, secrets.shared_secret);
        assert.equal(store.hasAccountSecrets('offline_account'), false);
        assert.equal(calls.filter(call => call.method === 'request').length, 0);
    }
});

test('finalization resumes pending enrollment and automatically answers Mobile Guard', async t => {
    let attempts = 0;
    const {options, store, calls} = fixture(t);
    store.writePending('offline_account', secrets);
    options.community.login = (details, callback) => {
        attempts++;
        calls.push({method: 'login', details});
        callback(attempts === 1 ? new Error('SteamGuardMobile') : null);
    };
    await finalize(options);
    assert.equal(attempts, 2);
    assert.match(calls[1].details.twoFactorCode, /^[23456789BCDFGHJKMNPQRTVWXY]{5}$/);
    assert.deepEqual(store.getAccountSecrets('offline_account'), secrets);
    assert.equal(store.readPending('offline_account'), null);
});

test('email Guard and repeated Mobile Guard are bounded by the login attempt limit', async t => {
    for (const guard of ['SteamGuard', 'SteamGuardMobile']) {
        let attempts = 0;
        let prompts = 0;
        const {options, store} = fixture(t, {login(details, callback) {
            attempts++;
            callback(new Error(guard));
        }});
        store.writePending('offline_account', secrets);
        await assert.rejects(finalize({...options, ask: async () => {prompts++; return '000000';}}), {code: 'ELOGINLIMIT'});
        assert.equal(attempts, 3);
        assert.equal(prompts, guard === 'SteamGuard' ? 2 : 0);
        assert.equal(store.readPending('offline_account').shared_secret, secrets.shared_secret);
    }
});

test('unbounded upstream want_more responses stop after the configured confirmation budget', async t => {
    let finalizations = 0;
    const {options, store} = fixture(t, {httpRequestPost(request, callback) {
        if (request.uri.includes('QueryTime')) {
            callback(null, {statusCode: 200}, {response: {server_time: 1700000000}});
        } else {
            finalizations++;
            callback(null, {statusCode: 200}, {response: {want_more: true, server_time: 1700000000}});
        }
    }});
    store.writePending('offline_account', secrets);
    await assert.rejects(finalize(options), {code: 'EFINALIZELIMIT'});
    assert.equal(finalizations, 5);
    assert.equal(store.hasAccountSecrets('offline_account'), false);
    assert.equal(store.readPending('offline_account').shared_secret, secrets.shared_secret);
});

test('Steam request timeout does not finalize or delete pending data after a late callback', async t => {
    let lateCallback;
    const {options, store} = fixture(t, {httpRequestPost(request, callback) {lateCallback = callback;}});
    store.writePending('offline_account', secrets);
    await assert.rejects(finalize({...options, timeoutMs: 5}), {code: 'ETIMEDOUT'});
    lateCallback(null, {statusCode: 200}, {response: {success: true}});
    assert.equal(store.hasAccountSecrets('offline_account'), false);
    assert.equal(store.readPending('offline_account').shared_secret, secrets.shared_secret);
});

test('bad activation codes and unexpected Steam payloads preserve pending data', async t => {
    for (const body of [{response: {status: 89}}, {response: {success: false}},
        {response: []}, {response: null}, null]) {
        const {options, store} = fixture(t, {httpRequestPost(request, callback) {
            callback(null, {statusCode: 200}, request.uri.includes('QueryTime')
                ? {response: {server_time: 1700000000}} : body);
        }});
        store.writePending('offline_account', secrets);
        await assert.rejects(finalize(options));
        assert.equal(store.hasAccountSecrets('offline_account'), false);
        assert.equal(store.readPending('offline_account').shared_secret, secrets.shared_secret);
    }
});

test('SIGINT-style cancellation during enrollment keeps the reservation and avoids subsequent requests', async t => {
    const controller = new AbortController();
    const {options, store} = fixture(t, {enableTwoFactor() {controller.abort();}});
    await assert.rejects(enroll({...options, signal: controller.signal}), {code: 'ABORT_ERR'});
    assert.equal(store.readPending('offline_account').state, 'requesting');
    assert.equal(store.hasAccountSecrets('offline_account'), false);
});

test('failed local secret persistence never deletes recovery data', async t => {
    const {options, store, calls} = fixture(t);
    store.writePending('offline_account', secrets);
    const failing = {...store, saveAccountSecrets() {throw new Error('disk full');}};
    await assert.rejects(finalize({...options, store: failing}), {code: 'ESTORAGE'});
    assert.equal(store.readPending('offline_account').shared_secret, secrets.shared_secret);
    assert.equal(store.readPending('offline_account').state, 'finalized');
    calls.length = 0;
    await finalize(options);
    assert.equal(calls.length, 0);
    assert.deepEqual(store.getAccountSecrets('offline_account'), secrets);
    assert.equal(store.readPending('offline_account'), null);
});

test('failed finalization marker persistence retains pending data for manual Steam verification', async t => {
    const {options, store} = fixture(t);
    store.writePending('offline_account', secrets);
    const failing = {...store, markPendingFinalized() {throw new Error('disk full');}};
    await assert.rejects(finalize({...options, store: failing}), {code: 'ESTORAGE'});
    assert.equal(store.readPending('offline_account').state, undefined);
    assert.equal(store.hasAccountSecrets('offline_account'), false);
});

test('concurrent finalization attempts issue only one login and hold an exclusive operation lock', async t => {
    const {options, store, calls} = fixture(t);
    store.writePending('offline_account', secrets);
    let finishPrompt;
    const pending = finalize({...options, ask: () => new Promise(resolve => {finishPrompt = resolve;})});
    while (!finishPrompt) await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(finalize(options), {code: 'ESTORAGE'});
    assert.equal(calls.filter(call => call.method === 'login').length, 1);
    finishPrompt('000000');
    await pending;
    assert.equal(store.readPending('offline_account'), null);
});

test('enrollment holds the same account lock while waiting for activation', async t => {
    const {options, store, calls} = fixture(t);
    let finishPrompt;
    const pending = enroll({...options, ask: () => new Promise(resolve => {finishPrompt = resolve;})});
    while (!finishPrompt) await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(finalize(options), {code: 'ESTORAGE'});
    await assert.rejects(enroll(options), {code: 'ESTORAGE'});
    assert.equal(calls.filter(call => call.method === 'login').length, 1);
    finishPrompt('000000');
    await pending;
    assert.equal(store.readPending('offline_account'), null);
});

test('a saved authenticator with matching pending data completes cleanup without accessing Steam', async t => {
    const {options, store, calls} = fixture(t);
    store.saveAccountSecrets('offline_account', secrets);
    store.writePending('offline_account', secrets);
    await finalize(options);
    assert.equal(calls.length, 0);
    assert.equal(store.readPending('offline_account'), null);
    const conflicting = fixture(t);
    conflicting.store.saveAccountSecrets('offline_account', {...secrets, shared_secret: Buffer.alloc(20, 9).toString('base64')});
    conflicting.store.writePending('offline_account', secrets);
    await assert.rejects(finalize(conflicting.options), {code: 'EEXISTING'});
    assert.equal(conflicting.calls.length, 0);
    assert.notEqual(conflicting.store.readPending('offline_account'), null);
});

test('input deadlines are bounded and pre-aborted operations issue no Steam login', async t => {
    const {options, store} = fixture(t);
    await assert.rejects(enroll({...options, ask: () => new Promise(() => {}), promptTimeoutMs: 5}), {code: 'ETIMEDOUT'});
    assert.equal(store.readPending('offline_account').state, 'pending');
    const untouched = fixture(t);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(enroll({...untouched.options, signal: controller.signal}), {code: 'ABORT_ERR'});
    assert.equal(untouched.calls.length, 0);
});

test('error output never repeats arbitrary Steam messages or secrets', async t => {
    const {store} = fixture(t);
    const messages = [];
    const code = await run('enroll', {env: {STEAM_USER: 'offline_account', STEAM_PASS: 'offline-password'},
        store,
        authenticate: (client, details) => new Promise((resolve, reject) => client.login(details,
            error => error ? reject(error) : resolve())),
        community: {login(details, callback) {callback(new Error('offline-password; token=offline-access-token; code=000000'));}},
        logger: {log: message => messages.push(message), error: message => messages.push(message)}});
    assert.equal(code, 1);
    assert.equal(messages.join('\n').includes('offline-password'), false);
    assert.equal(messages.join('\n').includes('offline-access-token'), false);
    assert.equal(errorMessage(new Error(secrets.shared_secret)).includes(secrets.shared_secret), false);
    assert.equal(errorMessage(Object.assign(new Error('Steam error'), {userMessage: 'offline-password'}))
        .includes('offline-password'), false);
});

test('CLI imports are inert and missing credentials fail safely', async () => {
    assert.equal(typeof require('../steam-2fa/scripts/enroll').enroll, 'function');
    assert.equal(typeof require('../steam-2fa/scripts/finalize').finalize, 'function');
    const errors = [];
    const code = await run('enroll', {env: {STEAM_USER: '', STEAM_PASS: ''}, community: {},
        logger: {log() {assert.fail('Unexpected success output');}, error: message => errors.push(message)}});
    assert.equal(code, 1);
    assert.match(errors.join('\n'), /valid Steam account name/);
    const env = {...process.env, STEAM_USER: '', STEAM_PASS: ''};
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [path.resolve(__dirname, '../steam-2fa/scripts/enroll.js')],
        {env, encoding: 'utf8', timeout: 5000});
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /valid Steam account name/);
    assert.equal(result.stdout, '');
});

test('CLI EOF during email Guard returns failure and removes its signal listeners', async t => {
    const {store} = fixture(t);
    const input = new PassThrough();
    const output = new PassThrough();
    const beforeInt = process.listenerCount('SIGINT');
    const beforeTerm = process.listenerCount('SIGTERM');
    output.once('data', () => input.end());
    const result = await run('enroll', {env: {STEAM_USER: 'offline_account', STEAM_PASS: 'offline-password'},
        community: {}, store, input, output, authenticate: async () => {throw new Error('SteamGuard');},
        logger: {log() {}, error() {}}});
    assert.equal(result, 1);
    assert.equal(process.listenerCount('SIGINT'), beforeInt);
    assert.equal(process.listenerCount('SIGTERM'), beforeTerm);
    assert.equal(store.readPending('offline_account'), null);
});
