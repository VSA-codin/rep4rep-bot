const fs = require('fs');
const os = require('os');
const path = require('path');
const SteamCommunity = require('steamcommunity');
const SteamTotp = require('steam-totp');

const configDir = path.join(os.homedir(), '.config', 'r4r');

function readPrivateJson(name) {
    const file = path.join(configDir, name);
    const stat = fs.statSync(file);

    if (!stat.isFile() || (stat.mode & 0o077) !== 0) {
        throw new Error('Unsafe file permissions: ' + name);
    }

    return JSON.parse(fs.readFileSync(file, 'utf8'));
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
    let attempts = {};

    try {
        attempts = readPrivateJson('relogin-attempts.json');
    } catch (err) {
        if (err.code !== 'ENOENT') {
            console.log('[RELOGIN] Retry state unavailable: ' + err.message);
            return null;
        }
    }

    if (Date.now() - (attempts[accountName] || 0) < RETRY_MS) {
        console.log('[RELOGIN] Cooldown active: ' + accountName);
        return null;
    }

    attempts[accountName] = Date.now();
    fs.writeFileSync(
        retryFile,
        JSON.stringify(attempts),
        { mode: 0o600 }
    );

    let passwords;
    let secrets;

    try {
        passwords = readPrivateJson('steam-passwords.json');
        secrets = readPrivateJson('steam-2fa.json');
    } catch (err) {
        console.log('[RELOGIN] Config error: ' + err.message);
        return null;
    }

    const password = passwords[accountName];
    const sharedSecret = secrets[accountName]?.shared_secret;

    if (!password || !sharedSecret) {
        console.log('[RELOGIN] Missing credentials: ' + accountName);
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

        console.log('[RELOGIN] Success: ' + accountName);

        return client;
    } catch (err) {
        console.log(
            '[RELOGIN] Failed for ' +
            accountName +
            ': ' +
            err.message
        );

        return null;
    }
}

module.exports = { autoRelogin };
