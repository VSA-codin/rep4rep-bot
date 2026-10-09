'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { interactiveLogin } = require('../lib/login');
const { withTimeout } = require('../lib/async');

const ACCOUNT = 'offline_interactive';
const PASSWORD = 'synthetic interactive password';
const STEAM_ID = '76561198000000001';

function fixture({ authenticate, verification = { loggedIn: true, familyView: false }, steamId = STEAM_ID,
    answers = [], generatedCode = 'TEST2' } = {}) {
    const attempts = [];
    const prompts = [];
    const logs = [];
    const generatedAccounts = [];
    const client = {
        steamID: { getSteamID64: () => steamId },
        login(details, callback) {
            const saved = { ...details };
            attempts.push(saved);
            if (authenticate) return authenticate(saved, callback, attempts.length);
            callback(null, 'offline-session', ['sessionid=synthetic-cookie'], null, 'synthetic-token');
        },
        loggedIn(callback) { callback(null, verification.loggedIn, verification.familyView); }
    };
    const options = {
        client,
        accountName: ACCOUNT,
        password: PASSWORD,
        timeoutMs: 30,
        login: (community, details, { timeoutMs, signal }) => withTimeout(done => community.login(details,
            (error, _sessionId, cookies, _guard, token) => done(error, { cookies, token: token || null })),
        timeoutMs, 'Synthetic login', { signal }),
        question: async (label, secret) => {
            prompts.push({ label, secret });
            assert.ok(answers.length, 'Unexpected interactive challenge');
            return answers.shift();
        },
        generateCode: name => { generatedAccounts.push(name); return generatedCode; },
        logger: { log: message => logs.push(message) }
    };
    return { options, client, attempts, prompts, logs, generatedAccounts };
}

test('interactive password login verifies the account session before returning persistence data', async () => {
    const f = fixture();
    const profile = await interactiveLogin(f.options);
    assert.equal(profile.accountName, ACCOUNT);
    assert.equal(profile.steamId, STEAM_ID);
    assert.deepEqual(profile.cookies, ['sessionid=synthetic-cookie']);
    assert.equal(profile.token, 'synthetic-token');
    assert.deepEqual(f.attempts, [{ accountName: ACCOUNT, password: PASSWORD }]);
    assert.deepEqual(f.prompts, []);
});

test('interactive Steam Guard uses a stored code once, then a masked manual challenge', async () => {
    const f = fixture({
        answers: ['MAN2'],
        authenticate(details, callback) {
            if (details.twoFactorCode !== 'MAN2') return callback(new Error('SteamGuardMobile'));
            callback(null, 'session', ['sessionid=synthetic-cookie']);
        }
    });
    await interactiveLogin(f.options);
    assert.deepEqual(f.attempts.map(item => item.twoFactorCode), [undefined, 'TEST2', 'MAN2']);
    assert.deepEqual(f.generatedAccounts, [ACCOUNT]);
    assert.equal(f.prompts.length, 1);
    assert.equal(f.prompts[0].secret, true);
    assert.ok(f.logs.every(message => !message.includes('TEST2') && !message.includes('MAN2') && !message.includes(PASSWORD)));
});

test('interactive Steam Guard accepts a manual code when the private secret is unavailable', async () => {
    const f = fixture({
        answers: [' MAN2 '],
        authenticate(details, callback) {
            if (!details.twoFactorCode) return callback(new Error('SteamGuardMobile'));
            callback(null, 'session', ['sessionid=synthetic-cookie']);
        }
    });
    f.options.generateCode = () => { throw new Error('Synthetic inaccessible secret'); };
    await interactiveLogin(f.options);
    assert.equal(f.attempts[1].twoFactorCode, 'MAN2');
    assert.equal(f.prompts[0].secret, true);
});

test('interactive email Guard remains available and does not request a mobile secret', async () => {
    const f = fixture({
        answers: [' MAIL2 '],
        authenticate(details, callback) {
            if (!details.authCode) return callback(new Error('SteamGuard'));
            callback(null, 'session', ['sessionid=synthetic-cookie']);
        }
    });
    await interactiveLogin(f.options);
    assert.equal(f.attempts[1].authCode, 'MAIL2');
    assert.equal(f.prompts[0].secret, true);
    assert.deepEqual(f.generatedAccounts, []);
});

test('interactive CAPTCHA restricts the destination to an HTTPS Steam origin', async () => {
    for (const captchaurl of ['http://steamcommunity.com/captcha', 'https://example.invalid/captcha',
        'https://steamcommunity.com.example.invalid/captcha', 'https://user:password@steamcommunity.com/captcha', 'malformed']) {
        const f = fixture({ authenticate(_details, callback) {
            callback(Object.assign(new Error('CAPTCHA'), { captchaurl }));
        } });
        await assert.rejects(interactiveLogin(f.options), /login failed/i);
        assert.deepEqual(f.prompts, []);
        assert.deepEqual(f.logs, []);
    }
    const f = fixture({
        answers: [' synthetic-answer '],
        authenticate(details, callback) {
            if (!details.captcha) return callback(Object.assign(new Error('CAPTCHA'), {
                captchaurl: 'https://steamcommunity.com/public/captcha.php?gid=synthetic'
            }));
            callback(null, 'session', ['sessionid=synthetic-cookie']);
        }
    });
    await interactiveLogin(f.options);
    assert.equal(f.attempts[1].captcha, 'synthetic-answer');
    assert.equal(f.prompts[0].secret, true);
});

test('interactive login rejects invalid Steam identities and unusable Family View sessions', async () => {
    for (const settings of [
        { steamId: 'invalid' },
        { steamId: '76561197960265728' },
        { verification: { loggedIn: false } },
        { verification: { loggedIn: true, familyView: true } }
    ]) {
        const f = fixture(settings);
        await assert.rejects(interactiveLogin(f.options), /login failed/i);
        assert.equal(f.attempts.length, 1);
    }
});

test('interactive challenge attempts are bounded and errors omit credentials', async () => {
    const f = fixture({ answers: ['MAN2', 'MAN3'], authenticate(_details, callback) {
        callback(new Error('SteamGuardMobile'));
    } });
    await assert.rejects(interactiveLogin(f.options), /login failed/i);
    assert.equal(f.attempts.length, 4);
    assert.equal(f.generatedAccounts.length, 1);
    const rejected = fixture({ authenticate(_details, callback) {
        callback(new Error(PASSWORD + ' https://steamcommunity.com/?token=synthetic-cookie'));
    } });
    await assert.rejects(interactiveLogin(rejected.options), error => !error.message.includes(PASSWORD) && !error.message.includes('token='));
});

test('an already cancelled interactive login never starts authentication', async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    f.options.signal = controller.signal;
    await assert.rejects(interactiveLogin(f.options), error => error.code === 'ABORT_ERR');
    assert.equal(f.attempts.length, 0);
});
