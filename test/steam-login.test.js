'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { loginSteam, LoginAgent } = require('../lib/steam-login');

function fixture(settings = {}) {
    const sessions = [];
    const updates = [];
    const agents = [];
    class Session extends EventEmitter {
        constructor(platform, options) {
            super();
            this.platform = platform;
            this.options = options;
            this.accessToken = 'offline-mobile-access';
            this.cancelled = 0;
            sessions.push(this);
        }
        async startWithCredentials(details) {
            this.credentials = details;
            if (settings.start) return settings.start.call(this, details);
            setImmediate(() => this.emit('authenticated'));
            return { actionRequired: false };
        }
        async getWebCookies() {
            if (settings.cookies) return settings.cookies.call(this);
            return ['sessionid=offline-cookie'];
        }
        cancelLoginAttempt() { this.cancelled++; }
    }
    const client = {
        setCookies(cookies) { updates.push({ cookies }); },
        setMobileAppAccessToken(token) { updates.push({ token }); }
    };
    const options = {
        LoginSession: Session,
        EAuthTokenPlatformType: { WebBrowser: 2, MobileApp: 3 },
        EAuthSessionGuardType: { EmailCode: 2, DeviceCode: 3 },
        createAgent(timeoutMs) {
            const agent = { timeoutMs, destroyed: 0, destroy() { this.destroyed++; } };
            agents.push(agent);
            return agent;
        },
        timeoutMs: 100
    };
    return { sessions, updates, agents, client, options };
}

const details = { accountName: 'offline_account', password: 'offline fixture password' };

test('web login transfers usable cookies and releases its transport', async () => {
    const f = fixture();
    const result = await loginSteam(f.client, details, f.options);
    assert.deepEqual(result, { cookies: ['sessionid=offline-cookie'], token: null });
    assert.equal(f.sessions[0].platform, 2);
    assert.equal(f.sessions[0].loginTimeout, 100);
    assert.equal(f.sessions[0].credentials.password, details.password);
    assert.equal(f.sessions[0].cancelled, 1);
    assert.equal(f.agents[0].destroyed, 1);
    assert.deepEqual(f.updates, [{ cookies: ['sessionid=offline-cookie'] }]);
});

test('mobile enrollment retains the access token through the current SteamCommunity API', async () => {
    const f = fixture();
    const result = await loginSteam(f.client, { ...details, disableMobile: false, twoFactorCode: 'TEST2' }, f.options);
    assert.equal(f.sessions[0].platform, 3);
    assert.equal(f.sessions[0].credentials.steamGuardCode, 'TEST2');
    assert.equal(result.token, 'offline-mobile-access');
    assert.deepEqual(f.updates[1], { token: 'offline-mobile-access' });
});

test('email and mobile challenges preserve their categorical errors and close the attempt', async () => {
    for (const validActions of [[{ type: 2, detail: 'example.invalid' }], [{ type: 3 }]]) {
        const f = fixture({ start() { return { actionRequired: true, validActions }; } });
        await assert.rejects(loginSteam(f.client, details, f.options), error => {
            assert.equal(error.message, validActions[0].type === 2 ? 'SteamGuard' : 'SteamGuardMobile');
            if (validActions[0].type === 2) assert.equal(error.emaildomain, 'example.invalid');
            return true;
        });
        assert.equal(f.updates.length, 0);
        assert.equal(f.sessions[0].cancelled, 1);
        assert.equal(f.agents[0].destroyed, 1);
    }
});

test('timeouts cancel pending credential requests before any client state is changed', async () => {
    let release;
    const f = fixture({ start() { return new Promise(resolve => { release = resolve; }); } });
    await assert.rejects(loginSteam(f.client, details, { ...f.options, timeoutMs: 5 }), { code: 'ETIMEDOUT' });
    assert.equal(f.sessions[0].cancelled, 1);
    assert.equal(f.agents[0].destroyed, 1);
    release({ actionRequired: false });
    f.sessions[0].emit('authenticated');
    f.sessions[0].emit('error', new Error('offline late response'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.updates.length, 0);
});

test('abort during cookie retrieval ignores late cookies and prevents client mutation', async () => {
    let release;
    const f = fixture({ cookies() { return new Promise(resolve => { release = resolve; }); } });
    const controller = new AbortController();
    const pending = loginSteam(f.client, details, { ...f.options, signal: controller.signal });
    while (!release) await new Promise(resolve => setImmediate(resolve));
    controller.abort();
    await assert.rejects(pending, { code: 'ABORT_ERR' });
    release(['sessionid=late-offline-cookie']);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.updates.length, 0);
    assert.equal(f.sessions[0].cancelled, 1);
    assert.equal(f.agents[0].destroyed, 1);
});

test('already cancelled operations cannot create a transport or session', async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(loginSteam(f.client, details, { ...f.options, signal: controller.signal }), { code: 'ABORT_ERR' });
    assert.equal(f.sessions.length, 0);
    assert.equal(f.agents.length, 0);
});

test('invalid responses and authentication errors release transport without accepting cookies', async () => {
    for (const settings of [
        { start() { throw new Error('offline credential rejection'); } },
        { start() { return null; } },
        { cookies() { return []; } },
        { cookies() { throw new Error('offline malformed transfer'); } }
    ]) {
        const f = fixture(settings);
        await assert.rejects(loginSteam(f.client, details, f.options));
        assert.equal(f.updates.length, 0);
        assert.equal(f.sessions[0].cancelled, 1);
        assert.equal(f.agents[0].destroyed, 1);
    }
});

test('a destroyed authentication agent rejects subsequent requests without opening a socket', () => {
    const agent = new LoginAgent(100);
    agent.destroy();
    let error;
    agent.addRequest({ destroy(reason) { error = reason; } }, { hostname: 'example.invalid' });
    assert.equal(error.code, 'ABORT_ERR');
    assert.equal(Object.keys(agent.sockets).length, 0);
});
