'use strict';

const crypto = require('node:crypto');
const SteamCommunity = require('steamcommunity');
const { createCommunity } = require('./lib/community');
const SteamTotp = require('steam-totp');
const { withTimeout } = require('./lib/async');
const { loginSteam } = require('./lib/steam-login');
const { validateSecret } = require('./steam-2fa/src/store');
const {
    getPrivatePaths,
    readPrivateJson,
    atomicWritePrivateJson,
    removePrivateFile,
    validateAccountName
} = require('./lib/private-files');

const RETRY_MS = 6 * 60 * 60 * 1000;
const TIMEOUT_MS = 30000;

function requireObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Private store must be a JSON object.');
    }
    return value;
}

function accountValue(store, accountName) {
    const keys = Object.keys(store).filter(key => key.toLowerCase() === accountName.toLowerCase());
    if (keys.length > 1) throw new Error('Account configuration is ambiguous.');
    return keys.length === 1 ? store[keys[0]] : undefined;
}

function reserveAttempt(paths, accountName, now) {
    const lockPath = paths.retry + '.lock';
    const owner = { pid: process.pid, id: crypto.randomUUID() };
    let locked = false;
    try {
        try {
            atomicWritePrivateJson(lockPath, owner, { overwrite: false });
            locked = true;
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;
            // A crashed writer's lock needs operator review. Deleting it automatically
            // can remove another process's new lock and permit duplicate authentication.
            return false;
        }

        const stored = requireObject(readPrivateJson(paths.retry, { fallback: {} }));
        const attempts = Object.create(null);
        for (const [name, timestamp] of Object.entries(stored)) {
            const normalized = validateAccountName(name).toLowerCase();
            if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
                throw new Error('Retry state is invalid.');
            }
            attempts[normalized] = Math.max(attempts[normalized] || 0, timestamp);
        }
        const key = accountName.toLowerCase();
        if (Object.hasOwn(attempts, key) && now - attempts[key] < RETRY_MS) return false;
        attempts[key] = now;
        atomicWritePrivateJson(paths.retry, attempts);
        return true;
    } finally {
        if (locked) {
            const current = readPrivateJson(lockPath);
            if (current.id === owner.id) removePrivateFile(lockPath, { missingOk: false });
        }
    }
}

function createAutoRelogin(dependencies = {}) {
    const Community = dependencies.SteamCommunity || SteamCommunity;
    const makeClient = dependencies.createCommunity || (dependencies.SteamCommunity
        ? options => new Community(options)
        : options => createCommunity(options));
    const totp = dependencies.SteamTotp || SteamTotp;
    const now = dependencies.now || Date.now;
    const logger = dependencies.logger || console;
    const getPaths = dependencies.getPaths || getPrivatePaths;
    const authenticate = dependencies.login || loginSteam;
    const active = new Set();

    return async function autoRelogin(accountName, db, options = {}) {
        let account;
        let activeKey;
        let ownsActiveKey = false;
        let client;
        let returnedClient = false;
        const report = message => logger.log('[RELOGIN] ' + message);
        try {
            account = validateAccountName(accountName);
            const paths = getPaths();
            activeKey = paths.retry + '\0' + account.toLowerCase();
            if (active.has(activeKey)) {
                report('An authentication attempt is already running for ' + account + '.');
                return null;
            }
            active.add(activeKey);
            ownsActiveKey = true;
            const { signal, accountId, steamId, timeoutMs = TIMEOUT_MS } = options;
            if (signal?.aborted) {
                report('Authentication cancelled for ' + account + '.');
                return null;
            }
            if (accountId !== undefined && (!Number.isSafeInteger(accountId) || accountId < 1)) {
                throw new Error('Invalid account identity.');
            }
            const call = (operation, label) => withTimeout(operation, timeoutMs, label, { signal });
            const rows = await call(done => db.all(
                'SELECT id, username, steamId FROM steamprofiles WHERE lower(username) = lower(?)',
                [account], done
            ), 'Account lookup');
            const matches = accountId === undefined ? rows : rows.filter(row => row.id === accountId);
            if (matches.length !== 1) {
                report('Saved account is missing or ambiguous for ' + account + '.');
                return null;
            }
            const row = matches[0];
            if (typeof row.steamId !== 'string' || !/^\d{17}$/.test(row.steamId) ||
                (steamId !== undefined && steamId !== row.steamId)) {
                report('Saved account identity is invalid for ' + account + '.');
                return null;
            }

            const passwords = requireObject(readPrivateJson(paths.passwords));
            const secrets = requireObject(readPrivateJson(paths.secrets, { fallback: {} }));
            const password = accountValue(passwords, account);
            const sharedSecret = accountValue(secrets, account)?.shared_secret;
            if (typeof password !== 'string' || password.length === 0 || password.length > 4096) {
                report('No valid password is configured for ' + account + '.');
                return null;
            }
            if (signal?.aborted) {
                report('Authentication cancelled for ' + account + '.');
                return null;
            }
            if (!reserveAttempt(paths, account, now())) {
                report('Cooldown or another authentication attempt is active for ' + account + '.');
                return null;
            }

            client = makeClient({ timeoutMs, timeout: timeoutMs, signal });
            const login = async code => (await authenticate(client, {
                accountName: account,
                password,
                ...(code ? { twoFactorCode: code } : {})
            }, { timeoutMs, signal })).cookies;
            let cookies;
            try {
                cookies = await login();
            } catch (error) {
                if (error.message !== 'SteamGuardMobile') throw error;
                try {
                    validateSecret(sharedSecret);
                } catch {
                    report('A valid Steam Guard secret is required for ' + account + '.');
                    return null;
                }
                // Only one challenge response is sent; further failures consume the cooldown.
                cookies = await login(totp.generateAuthCode(sharedSecret));
            }
            if (!Array.isArray(cookies) || cookies.length === 0 ||
                cookies.some(cookie => typeof cookie !== 'string' || cookie.length === 0)) {
                throw new Error('No usable session cookies were returned.');
            }
            const verification = await call(done => client.loggedIn(
                (error, loggedIn, familyView) => done(error, { loggedIn, familyView })
            ), 'Session verification');
            if (!verification.loggedIn || verification.familyView) {
                throw new Error('The session cannot perform account actions.');
            }
            if (!client.steamID || client.steamID.getSteamID64() !== row.steamId) {
                throw new Error('The authenticated account identity does not match.');
            }
            await call(done => db.run(
                'UPDATE steamprofiles SET cookies = ?, token = NULL WHERE id = ? AND username = ? AND steamId = ?',
                [JSON.stringify(cookies), row.id, row.username, row.steamId],
                function (error) {
                    if (error) return done(error);
                    if (this.changes !== 1) return done(new Error('Saved account changed during authentication.'));
                    done(null);
                }
            ), 'Session persistence');
            report('Authenticated ' + account + '.');
            returnedClient = true;
            return client;
        } catch (error) {
            // Steam errors can contain credentials, cookies, or URLs. Keep diagnostics categorical.
            const category = error.code === 'ETIMEDOUT' ? 'timed out' :
                error.code === 'ABORT_ERR' ? 'was cancelled' : 'failed';
            report('Authentication ' + category + (account ? ' for ' + account : '') + '. Check private configuration and account state.');
            return null;
        } finally {
            if (!returnedClient) client?.dispose?.();
            if (ownsActiveKey) active.delete(activeKey);
        }
    };
}

const autoRelogin = createAutoRelogin();

module.exports = { autoRelogin, createAutoRelogin, RETRY_MS };
