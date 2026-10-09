'use strict';

const path = require('node:path');
const fs = require('node:fs');
const {randomUUID} = require('node:crypto');
const {
    getPrivatePaths,
    ensurePrivateDirectory,
    readPrivateJson,
    atomicWritePrivateJson,
    removePrivateFile,
    validateAccountName
} = require('../../lib/private-files');

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function validateSecret(secret, field = 'shared_secret') {
    if (typeof secret !== 'string' || !secret || secret.length > 128) {
        throw new Error(`Invalid ${field}.`);
    }

    // steam-totp accepts either a 20-byte hexadecimal secret or canonical base64.
    const validHex = /^[a-f0-9]{40}$/i.test(secret);
    const validBase64 = /^[A-Za-z0-9+/]+={0,2}$/.test(secret)
        && Buffer.from(secret, 'base64').length === 20
        && Buffer.from(secret, 'base64').toString('base64') === secret;
    if (!validHex && !validBase64) {
        throw new Error(`Invalid ${field}.`);
    }

    return secret;
}

function validateSecrets(secrets) {
    if (!isRecord(secrets)) {
        throw new Error('Authenticator secrets must be a JSON object.');
    }

    const shared_secret = validateSecret(secrets.shared_secret);
    const identity_secret = secrets.identity_secret == null
        ? null : validateSecret(secrets.identity_secret, 'identity_secret');
    const revocation_code = secrets.revocation_code == null ? null : secrets.revocation_code;
    if (revocation_code !== null && (typeof revocation_code !== 'string'
        || !/^[\x21-\x7e]{1,128}$/.test(revocation_code))) {
        throw new Error('Invalid revocation_code.');
    }

    return {shared_secret, identity_secret, revocation_code};
}

function validateStore(store) {
    if (!isRecord(store)) {
        throw new Error('2FA store must be a JSON object.');
    }
    const names = new Set();
    for (const [name, secrets] of Object.entries(store)) {
        const account = validateAccountName(name).toLowerCase();
        if (names.has(account)) {
            throw new Error('2FA store contains duplicate account names.');
        }
        names.add(account);
        validateSecrets(secrets);
    }
    return store;
}

function validatePending(data, account) {
    if (!isRecord(data)) {
        throw new Error('Pending enrollment must be a JSON object.');
    }
    if (data.account_name !== undefined
        && validateAccountName(data.account_name).toLowerCase() !== account.toLowerCase()) {
        throw new Error('Pending enrollment belongs to another account.');
    }
    if (data.state === 'requesting') {
        if (typeof data.reservation_id !== 'string' || !/^[a-f0-9-]{36}$/i.test(data.reservation_id)
            || typeof data.created_at !== 'string' || !Number.isFinite(Date.parse(data.created_at))
            || data.shared_secret !== undefined) {
            throw new Error('Enrollment reservation is invalid.');
        }
    } else {
        if (data.state !== undefined && data.state !== 'pending' && data.state !== 'finalized') {
            throw new Error('Pending enrollment state is invalid.');
        }
        validateSecrets(data);
    }
    return data;
}

function createStore({env = process.env} = {}) {
    const {dir, secrets: configFile} = getPrivatePaths(env);

    function readStore() {
        return validateStore(readPrivateJson(configFile, {fallback: {}}));
    }

    function withLock(callback) {
        const lock = configFile + '.lock';
        // Exclusive publication serializes cooperating writers without following links.
        atomicWritePrivateJson(lock, {pid: process.pid}, {overwrite: false});
        try {
            return callback();
        } finally {
            removePrivateFile(lock);
        }
    }

    function findAccount(store, account) {
        return Object.keys(store).find(name => name.toLowerCase() === account.toLowerCase());
    }

    function getAccountSecrets(accountName) {
        const account = validateAccountName(accountName);
        const store = readStore();
        const key = findAccount(store, account);
        return key === undefined ? null : validateSecrets(store[key]);
    }

    function hasAccountSecrets(accountName) {
        return getAccountSecrets(accountName) !== null;
    }

    function saveAccountSecrets(accountName, secrets) {
        const account = validateAccountName(accountName);
        const validated = validateSecrets(secrets);
        return withLock(() => {
            const store = readStore();
            if (findAccount(store, account) !== undefined) {
                throw new Error('Refusing to overwrite an existing authenticator.');
            }
            Object.defineProperty(store, account, {value: validated, enumerable: true, writable: true, configurable: true});
            atomicWritePrivateJson(configFile, store);
            return validated;
        });
    }

    function getPendingPath(accountName) {
        // Steam login names are case-insensitive; use one reservation per account.
        const name = validateAccountName(accountName).toLowerCase() + '.2fa-pending.json';
        ensurePrivateDirectory(dir);
        const existing = fs.readdirSync(dir).filter(entry => entry.toLowerCase() === name);
        if (existing.length > 1) {
            throw new Error('Multiple pending enrollments exist for this account.');
        }
        // Preserve the location of pending files created by earlier versions.
        return path.join(dir, existing[0] || name);
    }

    function readPending(accountName) {
        const account = validateAccountName(accountName);
        const data = readPrivateJson(getPendingPath(account), {fallback: undefined});
        return data === undefined ? null : validatePending(data, account);
    }

    function writePending(accountName, data, {replace = false, expectedReservationId} = {}) {
        const account = validateAccountName(accountName);
        validatePending(data, account);
        const file = getPendingPath(account);
        return withLock(() => {
            if (replace) {
                const existing = readPending(account);
                if (!existing || !expectedReservationId || existing.reservation_id !== expectedReservationId
                    || existing.state !== 'requesting') {
                    throw new Error('Pending enrollment changed; refusing to overwrite it.');
                }
            }
            atomicWritePrivateJson(file, data, {overwrite: replace});
            return file;
        });
    }

    function deletePending(accountName) {
        return removePrivateFile(getPendingPath(accountName));
    }

    function markPendingFinalized(accountName, expectedSecrets) {
        const validated = validateSecrets(expectedSecrets);
        return withLock(() => {
            const existing = readPending(accountName);
            if (!existing || existing.state === 'requesting'
                || JSON.stringify(validateSecrets(existing)) !== JSON.stringify(validated)) {
                throw new Error('Pending enrollment changed before finalization could be recorded.');
            }
            const finalized = {...existing, state: 'finalized'};
            atomicWritePrivateJson(getPendingPath(accountName), finalized);
            return finalized;
        });
    }

    function acquireEnrollmentLock(accountName) {
        const file = getPendingPath(accountName) + '.operation-lock';
        const id = randomUUID();
        atomicWritePrivateJson(file, {pid: process.pid, id}, {overwrite: false});
        return () => {
            const existing = readPrivateJson(file);
            if (existing?.id !== id) {
                throw new Error('Enrollment operation lock changed.');
            }
            removePrivateFile(file);
        };
    }

    function getConfigPath() {
        return configFile;
    }

    return {getAccountSecrets, hasAccountSecrets, saveAccountSecrets, getPendingPath,
        readPending, writePending, deletePending, markPendingFinalized, acquireEnrollmentLock, getConfigPath};
}

module.exports = {...createStore(), createStore, validateSecret, validateSecrets};
