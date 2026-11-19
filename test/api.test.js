// SPDX-License-Identifier: MIT
'use strict';

const test = require('node:test');
const assert = require('node:assert');

// lib/api.js captures node-fetch when it is loaded, so every test loads a fresh
// copy of the module with a stub in the require cache. No request leaves the machine.
function loadApi(handler) {
    const calls = [];
    const stub = async (url, options) => {
        calls.push({ url, options });
        return handler(url, options, calls.length);
    };
    const fetchPath = require.resolve('node-fetch');
    const apiPath = require.resolve('../lib/api');

    const hadFetch = Object.prototype.hasOwnProperty.call(require.cache, fetchPath);
    const previousFetch = require.cache[fetchPath];
    delete require.cache[apiPath];
    require.cache[fetchPath] = { id: fetchPath, filename: fetchPath, loaded: true, exports: stub };

    let api;
    try {
        api = require('../lib/api');
    } finally {
        if (hadFetch) require.cache[fetchPath] = previousFetch;
        else delete require.cache[fetchPath];
        delete require.cache[apiPath];
    }

    return { api, calls };
}

function reply(status, payload) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => payload
    };
}

function recorder() {
    const waits = [];
    return { waits, sleep: async (ms) => { waits.push(ms); } };
}

test('api: GET sends the key only in the Authorization header', async () => {
    const { api, calls } = loadApi(() => reply(200, { data: [] }));
    const res = await api.createApiClient('KEY123', async () => {}).request('GET', '/steam-profiles');

    assert.deepStrictEqual(res, { ok: true, status: 200, body: { data: [] } });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, 'https://api.rep4rep.com/v1/steam-profiles');
    assert.ok(!calls[0].url.includes('KEY123'), 'the key must never be in the URL');
    assert.strictEqual(calls[0].options.headers.Authorization, 'Bearer KEY123');
    assert.strictEqual(calls[0].options.redirect, 'error');
    assert.strictEqual(calls[0].options.timeout, 30000);
    assert.strictEqual(calls[0].options.body, undefined);
});

test('api: POST sends a JSON body', async () => {
    const { api, calls } = loadApi(() => reply(200, { data: { id: 1 } }));
    await api.createApiClient('k', async () => {}).request('POST', '/tasks', { requestId: 'r1' });

    assert.strictEqual(calls[0].options.method, 'POST');
    assert.strictEqual(calls[0].options.headers['Content-Type'], 'application/json');
    assert.strictEqual(calls[0].options.body, '{"requestId":"r1"}');
});

test('api: 401 and 500 are returned once, without retrying', async () => {
    for (const status of [401, 500]) {
        const { api, calls } = loadApi(() => reply(status, { message: 'nope' }));
        const { waits, sleep } = recorder();
        const res = await api.createApiClient('k', sleep).request('GET', '/steam-profiles');

        assert.deepStrictEqual(res, { ok: false, status, body: { message: 'nope' } });
        assert.strictEqual(calls.length, 1);
        assert.deepStrictEqual(waits, []);
    }
});

test('api: 429 is retried with growing backoff and can succeed', async () => {
    const { api, calls } = loadApi((url, options, attempt) =>
        attempt < 3 ? reply(429, { message: 'slow down' }) : reply(200, { data: [] }));
    const { waits, sleep } = recorder();
    const res = await api.createApiClient('k', sleep).request('GET', '/steam-profiles');

    assert.strictEqual(res.ok, true);
    assert.strictEqual(calls.length, 3);
    assert.deepStrictEqual(waits, [5000, 10000]);
});

test('api: persistent 429 gives up after four attempts', async () => {
    const { api, calls } = loadApi(() => reply(429, { message: 'slow down' }));
    const { waits, sleep } = recorder();
    const res = await api.createApiClient('k', sleep).request('GET', '/steam-profiles');

    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.status, 429);
    assert.strictEqual(calls.length, 4);
    assert.deepStrictEqual(waits, [5000, 10000, 15000]);
});

test('api: network errors become a result instead of an exception', async () => {
    const refused = loadApi(() => { throw Object.assign(new Error('boom'), { code: 'ECONNREFUSED' }); });
    const a = await refused.api.createApiClient('k', async () => {}).request('GET', '/steam-profiles');
    assert.deepStrictEqual(a, { ok: false, status: 0, body: { message: 'network error: ECONNREFUSED' } });

    const unknown = loadApi(() => { throw new Error('boom'); });
    const b = await unknown.api.createApiClient('k', async () => {}).request('GET', '/steam-profiles');
    assert.deepStrictEqual(b, { ok: false, status: 0, body: { message: 'network error: unknown' } });
});

test('api: a non-JSON body does not break the call, 204 has no body', async () => {
    const html = loadApi(() => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } }));
    const res = await html.api.createApiClient('k', async () => {}).request('GET', '/steam-profiles');
    assert.deepStrictEqual(res, { ok: true, status: 200, body: null });

    let parsed = false;
    const nocontent = loadApi(() => ({ ok: true, status: 204, json: async () => { parsed = true; return {}; } }));
    const empty = await nocontent.api.createApiClient('k', async () => {}).request('DELETE', '/steam-profiles/1');
    assert.deepStrictEqual(empty, { ok: true, status: 204, body: null });
    assert.strictEqual(parsed, false);
});

test('apiMessage: uses the server message, adds validation errors, falls back to the status', () => {
    const { api } = loadApi(() => reply(200, {}));

    assert.strictEqual(api.apiMessage({ status: 400, body: { message: 'Invalid ticket', errors: ['ticket'] } }),
        'Invalid ticket ["ticket"]');
    assert.strictEqual(api.apiMessage({ status: 400, body: { message: 'Invalid ticket' } }), 'Invalid ticket');
    assert.strictEqual(api.apiMessage({ status: 500, body: null }), 'HTTP 500');
    assert.strictEqual(api.API_BASE, 'https://api.rep4rep.com/v1');
});
