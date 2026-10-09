'use strict';

const {randomUUID} = require('node:crypto');
const SteamTotp = require('steam-totp');
const {withTimeout} = require('../../lib/async');
const {loginSteam} = require('../../lib/steam-login');
const {validateAccountName} = require('../../lib/private-files');
const defaultStore = require('./store');
const {generateCodeFromSecret} = require('./totp');

class EnrollmentError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

function failure(code, message) {
    return new EnrollmentError(code, message);
}

function errorMessage(error) {
    if (error instanceof EnrollmentError) return error.message;
    if (error?.code === 'ETIMEDOUT') return 'Operation timed out. Pending enrollment was preserved.';
    if (error?.code === 'ABORT_ERR') return 'Operation cancelled. Pending enrollment was preserved.';
    return 'Operation failed. Check private file permissions and the Steam account state before retrying.';
}

function storage(operation) {
    try {
        return operation();
    } catch {
        throw failure('ESTORAGE', 'Could not safely access authenticator storage. Check its contents, ownership and permissions.');
    }
}

function settings(options) {
    let accountName;
    try {
        accountName = validateAccountName(options.accountName);
    } catch {
        throw failure('EACCOUNT', 'A valid Steam account name is required.');
    }
    if (typeof options.password !== 'string' || !options.password) {
        throw failure('ECREDENTIALS', 'Set STEAM_USER and STEAM_PASS before running the enrollment tools.');
    }
    if (!options.community || typeof options.ask !== 'function') {
        throw failure('EOPTIONS', 'A Steam client and input prompt are required.');
    }
    const result = {
        timeoutMs: 30000,
        promptTimeoutMs: 120000,
        maxLoginAttempts: 3,
        maxFinalizeAttempts: 5,
        store: defaultStore,
        log: () => {},
        generateCode: generateCodeFromSecret,
        authenticate: loginSteam,
        sendRequest: (community, details, callback) => community.request(details, callback),
        enableAuthenticator: addAuthenticator,
        now: Date.now,
        ...options,
        accountName
    };
    for (const key of ['timeoutMs', 'promptTimeoutMs', 'maxLoginAttempts', 'maxFinalizeAttempts']) {
        if (!Number.isSafeInteger(result[key]) || result[key] < 1
            || result[key] > (key.endsWith('Attempts') ? 10 : 2147483647)) {
            throw failure('EOPTIONS', 'Invalid enrollment operation limits.');
        }
    }
    return result;
}

async function prompt(options, message) {
    const value = await withTimeout(() => options.ask(message), options.promptTimeoutMs, 'Input', options);
    if (typeof value !== 'string' || !value.trim()) {
        throw failure('EINPUT', 'A Steam code is required. Pending enrollment was preserved.');
    }
    return value.trim();
}

async function login(options, sharedSecret) {
    let authCode;
    let twoFactorCode;
    for (let attempt = 0; attempt < options.maxLoginAttempts; attempt++) {
        try {
            await options.authenticate(options.community, {
                accountName: options.accountName,
                password: options.password,
                authCode,
                twoFactorCode,
                disableMobile: false
            }, {timeoutMs: options.timeoutMs, signal: options.signal});
            options.log('[OK] Logged in.');
            return;
        } catch (error) {
            if (error?.code === 'ETIMEDOUT' || error?.code === 'ABORT_ERR') throw error;
            if (attempt + 1 === options.maxLoginAttempts) {
                throw failure('ELOGINLIMIT', 'Steam login attempt limit reached. Stop retrying and verify Steam Guard manually.');
            }
            if (error?.message === 'SteamGuard') {
                authCode = await prompt(options, 'Steam Guard email code: ');
                twoFactorCode = undefined;
            } else if (error?.message === 'SteamGuardMobile') {
                if (!sharedSecret) {
                    throw failure('EEXISTINGMOBILE', 'Steam already requires Mobile Authenticator. Verify the existing authenticator before enrolling another one.');
                }
                authCode = undefined;
                twoFactorCode = options.generateCode(sharedSecret);
                options.log('[2FA] Generated Steam Guard code automatically.');
            } else {
                throw failure('ELOGIN', 'Steam login failed. Verify credentials and account status manually.');
            }
        }
    }
}

async function request(options, uri, form) {
    let pendingRequest;
    try {
        return await withTimeout(done => {
            pendingRequest = options.sendRequest(options.community, {
                uri,
                method: 'POST',
                form,
                json: true,
                timeout: options.timeoutMs
            }, (error, response, body) => {
                if (error) return done(error);
                if (!response || response.statusCode !== 200 || !body?.response
                    || typeof body.response !== 'object' || Array.isArray(body.response)) {
                    return done(failure('ERESPONSE', 'Steam returned an invalid authenticator response. Pending enrollment was preserved.'));
                }
                done(null, body.response);
            });
        }, options.timeoutMs, 'Steam authenticator request', options);
    } catch (error) {
        if (error?.code === 'ETIMEDOUT' || error?.code === 'ABORT_ERR') {
            pendingRequest?.abort?.();
        }
        if (error?.code === 'ETIMEDOUT' || error?.code === 'ABORT_ERR' || error instanceof EnrollmentError) throw error;
        throw failure('ESTEAMREQUEST', 'Steam authenticator request failed. Pending enrollment was preserved.');
    }
}

function mobileSession(options) {
    const {community} = options;
    if (typeof community.mobileAccessToken !== 'string' || !community.mobileAccessToken
        || !community.steamID || typeof community.steamID.getSteamID64 !== 'function') {
        throw failure('EMOBILESESSION', 'Steam did not provide a mobile session. Pending enrollment was preserved.');
    }
    return community;
}

async function addAuthenticator(options) {
    const community = mobileSession(options);
    const response = await request(options, 'https://api.steampowered.com/ITwoFactorService/AddAuthenticator/v1/', {
        access_token: community.mobileAccessToken,
        steamid: community.steamID.getSteamID64(),
        authenticator_type: 1,
        device_identifier: SteamTotp.getDeviceID(community.steamID.getSteamID64()),
        sms_phone_id: '1',
        version: 2
    });
    if (response.status !== 1) {
        throw failure('EENROLL', 'Steam did not confirm enrollment creation. Its reservation was preserved; verify Steam before starting another enrollment.');
    }
    return response;
}

async function finalizeTwoFactor(options, sharedSecret, activationCode) {
    const community = mobileSession(options);
    const time = await request(options, 'https://api.steampowered.com/ITwoFactorService/QueryTime/v1/', {});
    if (!Number.isSafeInteger(Number(time.server_time)) || Number(time.server_time) <= 0) {
        throw failure('ERESPONSE', 'Steam returned an invalid server time. Pending enrollment was preserved.');
    }
    let offset = Number(time.server_time) - Math.floor(options.now() / 1000);
    for (let attempt = 0; attempt < options.maxFinalizeAttempts; attempt++) {
        const response = await request(options, 'https://api.steampowered.com/ITwoFactorService/FinalizeAddAuthenticator/v1/', {
            access_token: community.mobileAccessToken,
            steamid: community.steamID.getSteamID64(),
            authenticator_code: SteamTotp.generateAuthCode(sharedSecret, offset),
            authenticator_time: Math.floor(options.now() / 1000) + offset,
            activation_code: activationCode
        });
        if (response.status === 89) {
            throw failure('EACTIVATION', 'Steam rejected the activation code. Pending enrollment was preserved.');
        }
        if (response.want_more) {
            if (response.server_time !== undefined) {
                const serverTime = Number(response.server_time);
                if (!Number.isSafeInteger(serverTime) || serverTime <= 0) {
                    throw failure('ERESPONSE', 'Steam returned an invalid server time. Pending enrollment was preserved.');
                }
                offset = serverTime - Math.floor(options.now() / 1000);
            }
            offset += 30;
            continue;
        }
        if (response.success === true || response.success === 1) return;
        throw failure('EFINALIZE', 'Steam did not confirm enrollment. Pending enrollment was preserved.');
    }
    throw failure('EFINALIZELIMIT', 'Steam requested too many authenticator confirmations. Pending enrollment was preserved.');
}

async function complete(options, pending) {
    const activationCode = await prompt(options, 'Steam activation code: ');
    options.log('[2FA] Finalizing Steam Guard Mobile...');
    await finalizeTwoFactor(options, pending.shared_secret, activationCode);
    // Keep a durable record of Steam's confirmation before saving the main store.
    storage(() => options.store.markPendingFinalized(options.accountName, pending));
    storage(() => options.store.saveAccountSecrets(options.accountName, pending));
    storage(() => options.store.deletePending(options.accountName));
    options.log('[SUCCESS] Steam Guard Mobile enabled. Secrets saved locally.');
    options.log('[IMPORTANT] Keep the revocation code safe.');
}

async function enroll(options) {
    options = settings(options);
    const release = storage(() => options.store.acquireEnrollmentLock(options.accountName));
    try {
        await enrollPending(options);
    } finally {
        storage(release);
    }
}

async function enrollPending(options) {
    if (storage(() => options.store.hasAccountSecrets(options.accountName))) {
        throw failure('EEXISTING', 'Refusing to overwrite an existing authenticator.');
    }
    if (storage(() => options.store.readPending(options.accountName))) {
        throw failure('EPENDING', 'Pending enrollment already exists. Finalize it or verify the Steam account state manually.');
    }
    await login(options);
    const reservation = {
        state: 'requesting',
        account_name: options.accountName,
        created_at: new Date(options.now()).toISOString(),
        reservation_id: randomUUID()
    };
    // Record the potentially state-changing request before contacting Steam.
    storage(() => options.store.writePending(options.accountName, reservation));
    options.log('[2FA] Starting Steam Guard Mobile enrollment...');
    let response;
    try {
        response = await options.enableAuthenticator(options);
    } catch (error) {
        if (error?.code === 'ETIMEDOUT' || error?.code === 'ABORT_ERR') throw error;
        throw failure('EENROLL', 'Steam enrollment failed. Its reservation was preserved; verify Steam before starting another enrollment.');
    }
    try {
        response = defaultStore.validateSecrets(response);
    } catch {
        throw failure('ERESPONSE', 'Steam returned invalid authenticator secrets. The enrollment reservation was preserved.');
    }
    const pending = {...response, ...reservation, state: 'pending'};
    storage(() => options.store.writePending(options.accountName, pending,
        {replace: true, expectedReservationId: reservation.reservation_id}));
    options.log('[OK] Pending enrollment saved securely.');
    await complete(options, pending);
}

async function finalize(options) {
    options = settings(options);
    const release = storage(() => options.store.acquireEnrollmentLock(options.accountName));
    try {
        await finalizePending(options);
    } finally {
        storage(release);
    }
}

async function finalizePending(options) {
    const pending = storage(() => options.store.readPending(options.accountName));
    if (!pending) throw failure('ENOPENDING', 'No pending enrollment exists for this account.');
    if (pending.state === 'requesting') {
        throw failure('EUNCERTAIN', 'Enrollment was interrupted before secrets were saved. Verify the authenticator state in Steam manually before removing its reservation.');
    }
    const existing = storage(() => options.store.getAccountSecrets(options.accountName));
    if (existing) {
        const saved = defaultStore.validateSecrets(pending);
        if (JSON.stringify(saved) !== JSON.stringify(existing)) {
            throw failure('EEXISTING', 'Refusing to overwrite an existing authenticator.');
        }
        // A crash after durable storage but before cleanup does not require another Steam request.
        storage(() => options.store.deletePending(options.accountName));
        options.log('[SUCCESS] Authenticator is already stored. Pending file removed.');
        return;
    }
    if (pending.state === 'finalized') {
        storage(() => options.store.saveAccountSecrets(options.accountName, pending));
        storage(() => options.store.deletePending(options.accountName));
        options.log('[SUCCESS] Steam already confirmed enrollment. Secrets saved locally.');
        return;
    }
    await login(options, pending.shared_secret);
    await complete(options, pending);
}

module.exports = {enroll, finalize, errorMessage};
