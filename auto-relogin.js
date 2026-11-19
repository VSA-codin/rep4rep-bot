// SPDX-License-Identifier: MIT
const fs = require('fs');
const os = require('os');
const path = require('path');
const SteamCommunity = require('steamcommunity');
const SteamTotp = require('steam-totp');
const { maskLogin } = require('./lib/privacy');

const configDir = path.join(os.homedir(), '.config', 'r4r');

function readPrivateJson(name) {
    const file = path.join(configDir, name);

    // Check and read through one open descriptor: a separate statSync() would
    // allow the file to be swapped between the permission check and the read.
    const fd = fs.openSync(file, 'r');

    try {
        const stat = fs.fstatSync(fd);

        // POSIX permission bits are not meaningful on Windows, skip the check there.
        if (!stat.isFile() || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) {
            throw new Error('Unsafe file permissions: ' + name);
        }

        return JSON.parse(fs.readFileSync(fd, 'utf8'));
    } finally {
        fs.closeSync(fd);
    }
}

function login(client, accountName, password, code) {
    return new Promise((resolve, reject) => {
        client.login({
            accountName,
            password,
            ...(code ? { twoFactorCode: code } : {})
        }, (err, sessionID, cookies) => {
            if (err) return reject(err);
            resolve(cookies);
        });
    });
}

function saveSession(db, accountName, cookies) {
    return new Promise((resolve, reject) => {
        db.run(
            `UPDATE steamprofiles
             SET cookies = ?, token = NULL
             WHERE username = ?`,
            [JSON.stringify(cookies), accountName],
            function(err) {
                if (err) return reject(err);

                if (this.changes !== 1) {
                    return reject(
                        new Error('Account missing or duplicated')
                    );
                }

                resolve();
            }
        );
    });
}

const retryFile = path.join(configDir, 'relogin-attempts.json');
const RETRY_MS = 6 * 60 * 60 * 1000;

async function autoRelogin(accountName, db) {
    const label = maskLogin(accountName);
    let passwords;
    let secrets;

    // 1. Is unattended re-login set up on this machine? If not, say so and stop
    //    without starting a cooldown (no login was attempted).
    try {
        passwords = readPrivateJson('steam-passwords.json');
        secrets = readPrivateJson('steam-2fa.json');
    } catch (err) {
        if (err.code === 'ENOENT') {
            console.log(
                '[RELOGIN] ' + label + ': unattended re-login is not set up on this machine ' +
                '(stored password or authenticator not found). ' +
                'Sign in again from the menu: Steam accounts -> Refresh the login of a saved account.'
            );
        } else {
            console.log('[RELOGIN] Config error: ' + String(err.message).split(configDir).join('<config dir>'));
        }
        return null;
    }

    const password = passwords[accountName];
    const sharedSecret = secrets[accountName]?.shared_secret;

    if (!password || !sharedSecret) {
        console.log(
            '[RELOGIN] Missing credentials: ' + label +
            ' (needs both a stored password and an authenticator). ' +
            'Sign in again from the menu: Steam accounts -> Refresh the login of a saved account.'
        );
        return null;
    }

    // 2. Cooldown: at most one real login attempt per account every 6 hours.
    let attempts = {};

    try {
        attempts = readPrivateJson('relogin-attempts.json');
    } catch (err) {
        if (err.code !== 'ENOENT') {
            console.log('[RELOGIN] Retry state unavailable: ' + String(err.message).split(configDir).join('<config dir>'));
            return null;
        }
    }

    if (Date.now() - (attempts[accountName] || 0) < RETRY_MS) {
        console.log('[RELOGIN] Cooldown active: ' + label);
        return null;
    }

    attempts[accountName] = Date.now();
    try {
        fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
        fs.writeFileSync(
            retryFile,
            JSON.stringify(attempts),
            { mode: 0o600 }
        );
    } catch (err) {
        // Fail closed: without a saved cooldown a broken login could be retried every run.
        console.log('[RELOGIN] Could not save retry state: ' + String(err.message).split(configDir).join('<config dir>'));
        return null;
    }

    const client = new SteamCommunity();

    try {
        let cookies;

        try {
            cookies = await login(client, accountName, password);
        } catch (err) {
            if (err.message !== 'SteamGuardMobile') {
                throw err;
            }

            const code = SteamTotp.generateAuthCode(sharedSecret);
            cookies = await login(client, accountName, password, code);
        }

        if (!Array.isArray(cookies) || cookies.length === 0) {
            throw new Error('No cookies returned');
        }

        const loggedIn = await new Promise((resolve, reject) => {
            client.loggedIn((err, status) => {
                if (err) return reject(err);
                resolve(status);
            });
        });

        if (!loggedIn) {
            throw new Error('Session verification failed');
        }

        await saveSession(db, accountName, cookies);

        console.log('[RELOGIN] Success: ' + maskLogin(accountName));

        return client;
    } catch (err) {
        console.log(
            '[RELOGIN] Failed for ' +
            maskLogin(accountName) +
            ': ' +
            String(err.message).split(accountName).join(maskLogin(accountName))
        );

        return null;
    }
}

module.exports = { autoRelogin };
