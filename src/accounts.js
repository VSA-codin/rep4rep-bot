// SPDX-License-Identifier: MIT
'use strict';

const SteamCommunity = require('steamcommunity');
const SteamTotp = require('steam-totp');
const { getAccountSecrets } = require('../steam-2fa/src/store');
const { maskLogin } = require('../lib/privacy');

const MAX_GUARD_ROUNDS = 6;

// Steam error text can contain the login name; show it masked.
function maskInText(text, login) {
    const message = String(text || 'Steam sign-in failed.');
    return login ? message.split(login).join(maskLogin(login)) : message;
}

// Current Steam Guard code from the authenticator stored by the 2FA tools, or null.
function storedAuthenticatorCode(login) {
    try {
        const secrets = getAccountSecrets(login);

        if (secrets && secrets.shared_secret) {
            return SteamTotp.generateAuthCode(secrets.shared_secret);
        }
    } catch (err) {
        // unreadable store: fall back to asking the user
    }

    return null;
}

// One sign-in attempt on a fresh Steam client.
function tryOnce(createCommunity, credentials) {
    return new Promise((resolve) => {
        const community = createCommunity();

        community.login(credentials, (error, sessionID, cookies, steamguard, oauthToken) => {
            if (error) resolve({ ok: false, error });
            else resolve({ ok: true, community, cookies, oauthToken });
        });
    });
}

// Signs in with login + password and walks through whatever Steam Guard step
// Steam asks for (authenticator, e-mail code, CAPTCHA).
// Resolves with { steamId, cookies, oauthToken }.
async function signIn(options) {
    const {
        login,
        password,
        prompt,
        say = console.log,
        createCommunity = () => new SteamCommunity(),
        authenticatorCode = storedAuthenticatorCode
    } = options;

    const extra = {};
    let storedCodeUsed = false;

    for (let round = 0; round < MAX_GUARD_ROUNDS; round++) {
        const outcome = await tryOnce(createCommunity, { accountName: login, password, ...extra });

        if (outcome.ok) {
            const id = outcome.community.steamID;
            const steamId = id && id.getSteamID64();

            if (!steamId) {
                throw new Error('Steam accepted the login but did not report a SteamID. Try again.');
            }

            return { steamId, cookies: outcome.cookies, oauthToken: outcome.oauthToken || null };
        }

        const reason = outcome.error && outcome.error.message;

        if (reason === 'SteamGuardMobile') {
            const stored = storedCodeUsed ? null : authenticatorCode(login);

            if (stored) {
                storedCodeUsed = true;
                say('[2FA] Using the stored authenticator for this account.');
                extra.twoFactorCode = stored;
            } else {
                const typed = await prompt.ask('Steam Guard code (authenticator app): ');
                if (typed === null) throw new Error('Input ended before the Steam Guard code was entered.');
                extra.twoFactorCode = typed.trim();
            }
            continue;
        }

        if (reason === 'SteamGuard') {
            say('Steam sent a code to your e-mail (' + (outcome.error.emaildomain || 'unknown domain') + ').');
            const typed = await prompt.ask('Steam Guard code from e-mail: ');
            if (typed === null) throw new Error('Input ended before the Steam Guard code was entered.');
            extra.authCode = typed.trim();
            continue;
        }

        if (reason === 'CAPTCHA') {
            say('Open this address, solve the CAPTCHA and type its text: ' + outcome.error.captchaurl);
            const typed = await prompt.ask('CAPTCHA text: ');
            if (typed === null) throw new Error('Input ended before the CAPTCHA was answered.');
            extra.captcha = typed.trim();
            continue;
        }

        throw new Error(maskInText(reason, login));
    }

    throw new Error('Too many Steam Guard attempts. Try again later.');
}

// Stores (or refreshes) the saved session of an account.
async function saveSession(db, login, steamId, cookies, oauthToken) {
    const existing = await db.get(
        'SELECT id FROM steamprofiles WHERE username = ? OR steamId = ?',
        [login, steamId]
    );
    const cookieJson = JSON.stringify(cookies);

    if (existing) {
        await db.run(
            'UPDATE steamprofiles SET username = ?, steamId = ?, cookies = ?, token = ? WHERE id = ?',
            [login, steamId, cookieJson, oauthToken, existing.id]
        );
    } else {
        await db.run(
            'INSERT INTO steamprofiles (username, steamId, cookies, token) VALUES (?, ?, ?, ?)',
            [login, steamId, cookieJson, oauthToken]
        );
    }
}

async function listAccounts(db) {
    return db.all('SELECT id, username, steamId, last_comment FROM steamprofiles ORDER BY id');
}

async function hasAccount(db, login) {
    return Boolean(await db.get('SELECT id FROM steamprofiles WHERE username = ?', [login]));
}

// Removes an account by login name. Only when no login matches is a purely
// numeric value treated as a record id, so a numeric login can never delete
// another account's row. Returns how many rows were removed.
async function removeAccount(db, value) {
    const byLogin = await db.run('DELETE FROM steamprofiles WHERE username = ?', [value]);
    if (byLogin.changes > 0) return byLogin.changes;

    if (/^[0-9]+$/.test(value)) {
        const byId = await db.run('DELETE FROM steamprofiles WHERE id = ?', [Number(value)]);
        return byId.changes;
    }

    return 0;
}

module.exports = {
    signIn,
    saveSession,
    listAccounts,
    hasAccount,
    removeAccount,
    maskInText,
    storedAuthenticatorCode
};
