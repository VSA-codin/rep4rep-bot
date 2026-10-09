'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCommunity } = require('../lib/community');

const STEAM_ID = '76561198000000001';
const TARGET = '76561198000000002';

function fixture(t, { respond, timeoutMs = 100, signal } = {}) {
    const requests = [];
    const client = createCommunity({ timeoutMs, signal, sendRequest(options, callback) {
        const request = { options, callback, aborted: 0, abort() { this.aborted++; } };
        requests.push(request);
        if (respond) setImmediate(() => respond(request));
        return request;
    } });
    client.setCookies(['sessionid=synthetic-session', `steamLoginSecure=${STEAM_ID}%7C%7Csynthetic-token`]);
    t.after(() => client.dispose());
    return { client, requests };
}

function loggedIn(client) {
    return new Promise((resolve, reject) => client.loggedIn((error, status, familyView) =>
        error ? reject(error) : resolve({ status, familyView })));
}

function post(client, target = TARGET, text = '+rep synthetic offline test') {
    return new Promise((resolve, reject) => client.postUserComment(target, text, error => error ? reject(error) : resolve()));
}

test('community session checks retain real cookie isolation and validate a Steam profile redirect', async t => {
    const f = fixture(t, { respond(request) {
        request.callback(null, { statusCode: 302, headers: { location: `https://steamcommunity.com/profiles/${STEAM_ID}/` } });
    } });
    assert.deepEqual(await loggedIn(f.client), { status: true, familyView: false });
    assert.equal(f.client.getSessionID(), 'synthetic-session');
    assert.equal(f.client.steamID.getSteamID64(), STEAM_ID);
    assert.match(f.client._jar.getCookieString('https://steamcommunity.com/'), /sessionid=synthetic-session/);
    assert.equal(f.requests[0].options.followRedirect, false);
    assert.equal(f.requests[0].options.timeout, 100);
});

test('community session checks reject login redirects, non-Steam destinations, credentials and invalid identities', async t => {
    for (const location of ['https://steamcommunity.com/login/', 'https://example.invalid/id/synthetic',
        'https://steamcommunity.com.example.invalid/id/synthetic', 'http://steamcommunity.com/id/synthetic',
        'https://user:synthetic-password@steamcommunity.com/id/synthetic', 'https://steamcommunity.com:444/id/synthetic',
        'https://steamcommunity.com/profiles/invalid']) {
        const f = fixture(t, { respond(request) { request.callback(null, { statusCode: 302, headers: { location } }); } });
        assert.deepEqual(await loggedIn(f.client), { status: false, familyView: false });
    }
    const vanity = fixture(t, { respond(request) { request.callback(null, { statusCode: 302, headers: { location: '/id/offline_account/' } }); } });
    assert.deepEqual(await loggedIn(vanity.client), { status: true, familyView: false });
});

test('community session checks preserve locked Family View and handle malformed headers without throwing', async t => {
    const locked = fixture(t, { respond(request) { request.callback(null, { statusCode: 403 }); } });
    assert.deepEqual(await loggedIn(locked.client), { status: true, familyView: true });
    for (const response of [undefined, { statusCode: 200 }, { statusCode: 302 }, { statusCode: 302, headers: { location: null } }]) {
        const f = fixture(t, { respond(request) { request.callback(null, response); } });
        await assert.rejects(loggedIn(f.client), /invalid session response/);
    }
});

test('community comments accept Steam success without parsing fragile response HTML', async t => {
    for (const success of [true, 1]) {
        const f = fixture(t, { respond(request) { request.callback(null, { statusCode: 200 }, { success, comments_html: '<malformed>' }); } });
        await post(f.client);
        const options = f.requests[0].options;
        assert.equal(options.uri, `https://steamcommunity.com/comment/Profile/post/${TARGET}/-1`);
        assert.equal(options.method, 'POST');
        assert.deepEqual(options.form, { comment: '+rep synthetic offline test', count: 1, sessionid: 'synthetic-session' });
        assert.equal(options.json, true);
        assert.equal(options.followRedirect, false);
    }
});

test('community comments reject malformed bodies and HTTP failures with categorical errors', async t => {
    for (const [statusCode, body] of [[200, null], [200, []], [200, 'not JSON'], [200, {}],
        [200, { success: false }], [200, { success: 'true' }], [200, { error: 'synthetic-private-response' }],
        [200, { success: true, error: 'synthetic-private-response' }], [403, { success: true }], [302, { success: true }]]) {
        const f = fixture(t, { respond(request) { request.callback(null, { statusCode }, body); } });
        await assert.rejects(post(f.client), error => /did not confirm/.test(error.message) && !error.message.includes('synthetic-private-response'));
    }
    const f = fixture(t);
    await assert.rejects(post(f.client, 'invalid'), /Invalid/);
    await assert.rejects(post(f.client, TARGET, ''), /Invalid/);
    assert.equal(f.requests.length, 0);
});

test('community requests time out, abort their handles and ignore late responses', async t => {
    const f = fixture(t, { timeoutMs: 10 });
    let callbacks = 0;
    const pending = new Promise(resolve => f.client.postUserComment(TARGET, '+rep synthetic', error => { callbacks++; resolve(error); }));
    const error = await pending;
    assert.equal(error.code, 'ETIMEDOUT');
    assert.equal(f.requests[0].aborted, 1);
    f.requests[0].callback(null, { statusCode: 200 }, { success: true });
    assert.equal(callbacks, 1);
});

test('abort and disposal stop pending requests and prevent future requests', async t => {
    const controller = new AbortController();
    const f = fixture(t, { signal: controller.signal });
    const pending = post(f.client);
    controller.abort();
    await assert.rejects(pending, { code: 'ABORT_ERR' });
    assert.equal(f.requests[0].aborted, 1);
    await assert.rejects(loggedIn(f.client), { code: 'ABORT_ERR' });
    await assert.rejects(post(f.client), { code: 'ABORT_ERR' });
    assert.equal(f.requests.length, 1);
    f.client.dispose();
    assert.equal(f.requests[0].aborted, 1);
});

test('network errors never reveal request URLs or cookie values', async t => {
    const f = fixture(t, { respond(request) {
        request.callback(new Error('https://steamcommunity.com/?token=synthetic-token sessionid=synthetic-session'));
    } });
    await assert.rejects(post(f.client), error => error.message === 'Steam request failed.');
});

test('already aborted clients and cancellation while creating a request do not leave an active handle', async t => {
    const cancelled = new AbortController();
    cancelled.abort();
    const f = fixture(t, { signal: cancelled.signal });
    await assert.rejects(post(f.client), { code: 'ABORT_ERR' });
    assert.equal(f.requests.length, 0);
    const controller = new AbortController();
    const handle = { aborted: 0, abort() { this.aborted++; } };
    const client = createCommunity({ signal: controller.signal, sendRequest() { controller.abort(); return handle; } });
    t.after(() => client.dispose());
    client.setCookies(['sessionid=synthetic-session']);
    await assert.rejects(post(client), { code: 'ABORT_ERR' });
    assert.equal(handle.aborted, 1);
});
