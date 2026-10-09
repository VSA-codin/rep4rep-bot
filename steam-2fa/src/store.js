'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_DIR = process.env.R4R_2FA_DIR
    ? path.resolve(process.env.R4R_2FA_DIR)
    : path.join(os.homedir(), '.config', 'r4r');

const CONFIG_FILE = process.env.R4R_2FA_FILE
    ? path.resolve(process.env.R4R_2FA_FILE)
    : path.join(CONFIG_DIR, 'steam-2fa.json');

function ensureConfigDir() {
    fs.mkdirSync(CONFIG_DIR, {
        recursive: true,
        mode: 0o700
    });

    try {
        fs.chmodSync(CONFIG_DIR, 0o700);
    } catch {
        // Best effort. A permission error will surface on file access.
    }
}

function safeReadJson(file, fallback = {}) {
    try {
        const raw = fs.readFileSync(file, 'utf8');
        return JSON.parse(raw || '{}');
    } catch (err) {
        if (err.code === 'ENOENT') {
            return fallback;
        }

        throw err;
    }
}

function atomicWriteJson(file, data) {
    ensureConfigDir();

    const tmp = file + '.tmp-' + process.pid;

    fs.writeFileSync(
        tmp,
        JSON.stringify(data, null, 2) + '\n',
        {
            encoding: 'utf8',
            mode: 0o600
        }
    );

    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
    fs.chmodSync(file, 0o600);
}

function readStore() {
    ensureConfigDir();

    const store = safeReadJson(CONFIG_FILE, {});

    if (
        store === null ||
        Array.isArray(store) ||
        typeof store !== 'object'
    ) {
        throw new Error('2FA store is not a JSON object.');
    }

    if (fs.existsSync(CONFIG_FILE)) {
        fs.chmodSync(CONFIG_FILE, 0o600);
    }

    return store;
}

function writeStore(store) {
    atomicWriteJson(CONFIG_FILE, store);
}

function validateAccountName(accountName) {
    if (
        typeof accountName !== 'string' ||
        !accountName.trim()
    ) {
        throw new Error('Steam account name is required.');
    }

    return accountName.trim();
}

function getAccountSecrets(accountName) {
    const account = validateAccountName(accountName);
    const store = readStore();

    return store[account] || null;
}

function hasAccountSecrets(accountName) {
    const data = getAccountSecrets(accountName);

    return Boolean(
        data &&
        typeof data.shared_secret === 'string' &&
        data.shared_secret.length > 0
    );
}

function saveAccountSecrets(accountName, secrets) {
    const account = validateAccountName(accountName);

    if (
        !secrets ||
        typeof secrets.shared_secret !== 'string' ||
        !secrets.shared_secret
    ) {
        throw new Error('shared_secret is required.');
    }

    const store = readStore();

    store[account] = {
        shared_secret: secrets.shared_secret,
        identity_secret: secrets.identity_secret || null,
        revocation_code: secrets.revocation_code || null
    };

    writeStore(store);

    return store[account];
}

function getPendingPath(accountName) {
    const account = validateAccountName(accountName);

    if (
        account.includes('/') ||
        account.includes('\\') ||
        account.includes('..')
    ) {
        throw new Error('Invalid Steam account name.');
    }

    ensureConfigDir();

    return path.join(
        CONFIG_DIR,
        account + '.2fa-pending.json'
    );
}

function readPending(accountName) {
    const file = getPendingPath(accountName);
    const data = safeReadJson(file, null);

    if (!data) {
        return null;
    }

    if (
        typeof data !== 'object' ||
        Array.isArray(data)
    ) {
        throw new Error('Pending enrollment is invalid.');
    }

    fs.chmodSync(file, 0o600);

    return data;
}

function writePending(accountName, data) {
    const file = getPendingPath(accountName);
    atomicWriteJson(file, data);
    return file;
}

function deletePending(accountName) {
    const file = getPendingPath(accountName);

    if (fs.existsSync(file)) {
        fs.unlinkSync(file);
        return true;
    }

    return false;
}

function getConfigPath() {
    ensureConfigDir();
    return CONFIG_FILE;
}

module.exports = {
    getAccountSecrets,
    hasAccountSecrets,
    saveAccountSecrets,
    getPendingPath,
    readPending,
    writePending,
    deletePending,
    getConfigPath
};
