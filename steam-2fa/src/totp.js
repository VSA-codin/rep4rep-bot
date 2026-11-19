// SPDX-License-Identifier: MIT
'use strict';

const SteamTotp = require('steam-totp');
const {
    getAccountSecrets
} = require('./store');

// Steam Guard codes change every 30 seconds.
const PERIOD_SECONDS = 30;

// timeOffset: seconds between this machine's clock and Steam's (see getSteamTimeOffset).
function generateCodeFromSecret(sharedSecret, timeOffset = 0) {
    if (
        typeof sharedSecret !== 'string' ||
        !sharedSecret
    ) {
        throw new Error('shared_secret is missing.');
    }

    return SteamTotp.generateAuthCode(sharedSecret, timeOffset);
}

function generateCodeForAccount(accountName, timeOffset = 0) {
    const secrets = getAccountSecrets(accountName);

    if (!secrets || !secrets.shared_secret) {
        throw new Error(
            'No authenticator stored for Steam account: ' +
            accountName
        );
    }

    return generateCodeFromSecret(
        secrets.shared_secret,
        timeOffset
    );
}

// How many seconds the current code stays valid.
function secondsRemaining(nowMs = Date.now(), timeOffset = 0) {
    const seconds = Math.floor(nowMs / 1000) + timeOffset;

    return PERIOD_SECONDS - (seconds % PERIOD_SECONDS);
}

// Asks Steam for its time (one request to api.steampowered.com) so codes stay
// valid even when the local clock is off.
function getSteamTimeOffset() {
    return new Promise((resolve, reject) => {
        SteamTotp.getTimeOffset((err, offset) => {
            if (err) reject(err);
            else resolve(offset);
        });
    });
}

module.exports = {
    PERIOD_SECONDS,
    generateCodeForAccount,
    generateCodeFromSecret,
    secondsRemaining,
    getSteamTimeOffset
};
