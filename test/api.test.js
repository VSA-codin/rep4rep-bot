'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApi } = require('../lib/api');

const profile = { id: 11, steamId: '76561198000000001' };
const task = {
    taskId: 21,
    requiredCommentId: 31,
    targetSteamProfileId: '76561198000000002',
    targetSteamProfileName: 'Offline target',
    requiredCommentText: '+rep offline test'
};

function response(data, { status = 200, raw } = {}) {
    const body = raw === undefined ? JSON.stringify(data) : raw;
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText: status === 200 ? 'OK' : 'Failure',
        json: async () => JSON.parse(body),
        text: async () => body
    };
}

test('API profile, registration, task and completion calls use the expected endpoints and fields', async () => {
    const requests = [];
    const results = [[profile], { success: true }, [task], { success: true }];
    const api = createApi({
        apiToken: 'offline-api-token',
        fetch: async (url, options = {}) => {
            requests.push({ url: new URL(url), options });
            return response(results.shift());
        }
    });
    assert.deepEqual(await api.profiles(), [profile]);
    await api.addProfile(profile.steamId);
    assert.deepEqual(await api.tasks(profile.id), [task]);
    await api.complete(task, profile.id);
    assert.equal(requests[0].url.pathname, '/pub-api/user/steamprofiles');
    assert.equal(requests[1].url.pathname, '/pub-api/user/steamprofiles/add');
    assert.equal(requests[2].url.pathname, '/pub-api/tasks');
    assert.equal(requests[3].url.pathname, '/pub-api/tasks/complete');
    assert.equal(requests[0].url.searchParams.get('apiToken'), 'offline-api-token');
    assert.equal(requests[2].url.searchParams.get('steamProfile'), String(profile.id));
    assert.equal(requests[1].options.method.toUpperCase(), 'POST');
    assert.equal(requests[3].options.method.toUpperCase(), 'POST');
    const addition = requests[1].options.body.getBuffer().toString();
    const completion = requests[3].options.body.getBuffer().toString();
    assert.match(addition, /76561198000000001/);
    for (const value of ['taskId', 'commentId', 'authorSteamProfileId']) assert.match(completion, new RegExp(value));
});

test('API rejects unsuccessful HTTP responses without exposing response secrets', async () => {
    const api = createApi({
        apiToken: 'offline-api-token',
        fetch: async () => response({ error: 'sensitive-server-body offline-api-token' }, { status: 403 })
    });
    await assert.rejects(api.profiles(), error => {
        assert.equal(error.name, 'ApiError');
        assert.doesNotMatch(error.message, /offline-api-token|sensitive-server-body/);
        return true;
    });
});

test('API rejects invalid JSON and provider errors', async () => {
    for (const invalid of [response(null, { raw: '{ broken' }), response({ error: 'provider failure' })]) {
        const api = createApi({ apiToken: 'offline-api-token', fetch: async () => invalid });
        await assert.rejects(api.profiles());
    }
});

test('API requires a positive provider acknowledgement for registration and completion', async () => {
    for (const data of [null, [], {}, { success: false }, { success: '' }, { success: 0 }, { info: '' }]) {
        const api = createApi({ apiToken: 'offline-api-token', fetch: async () => response(data) });
        await assert.rejects(api.complete(task, profile.id));
        await assert.rejects(api.addProfile(profile.steamId));
    }
    for (const data of [{ success: true }, { success: 'Task completed' }, { info: 'Profile added' }]) {
        const api = createApi({ apiToken: 'offline-api-token', fetch: async () => response(data) });
        await api.complete(task, profile.id);
        await api.addProfile(profile.steamId);
    }
});

test('API validates response schemas before any comment can be scheduled', async () => {
    const invalidProfiles = [null, {}, [{ id: 0, steamId: profile.steamId }], [{ id: '0', steamId: profile.steamId }], [{ id: 1, steamId: 'not-a-steamid' }], [{ ...profile, steamId: Number(profile.steamId) }], [profile, profile], [profile, { id: profile.id, steamId: '76561198000000002' }]];
    for (const data of invalidProfiles) {
        const api = createApi({ apiToken: 'offline-api-token', fetch: async () => response(data) });
        await assert.rejects(api.profiles());
    }
    const invalidTasks = [null, {}, [{ ...task, taskId: null }], [{ ...task, targetSteamProfileId: 'not-a-steamid' }], [{ ...task, targetSteamProfileId: Number(task.targetSteamProfileId) }], [{ ...task, requiredCommentText: '' }], [{ ...task, requiredCommentText: 'x'.repeat(1001) }], [task, task]];
    for (const data of invalidTasks) {
        const api = createApi({ apiToken: 'offline-api-token', fetch: async () => response(data) });
        await assert.rejects(api.tasks(profile.id));
    }
});

test('API times out a stalled request and aborts its network signal', async () => {
    let signal;
    const api = createApi({
        apiToken: 'offline-api-token',
        timeoutMs: 20,
        fetch: (_url, options) => {
            signal = options.signal;
            return new Promise(() => {});
        }
    });
    await assert.rejects(api.profiles(), /failed or timed out/);
    assert.equal(signal.aborted, true);
});

test('API timeout includes a stalled response body', async () => {
    const api = createApi({
        apiToken: 'offline-api-token',
        timeoutMs: 20,
        fetch: async () => ({ ok: true, status: 200, json: () => new Promise(() => {}), text: () => new Promise(() => {}) })
    });
    await assert.rejects(api.profiles(), /failed or timed out/);
});

test('API stops a pending request when its caller cancels', async () => {
    const controller = new AbortController();
    let networkSignal;
    const api = createApi({
        apiToken: 'offline-api-token',
        signal: controller.signal,
        timeoutMs: 1000,
        fetch: (_url, options) => {
            networkSignal = options.signal;
            return new Promise(() => {});
        }
    });
    const pending = api.profiles();
    controller.abort();
    await assert.rejects(pending, error => error.code === 'ABORT_ERR');
    assert.equal(networkSignal.aborted, true);
});
