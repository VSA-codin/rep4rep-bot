'use strict';

const SteamTotp = require('steam-totp');
const {
    getAccountSecrets
} = require('./store');

function generateCodeFromSecret(sharedSecret) {
    if (
        typeof sharedSecret !== 'string' ||
        !sharedSecret
    ) {
        throw new Error('shared_secret is missing.');
    }

    return SteamTotp.generateAuthCode(sharedSecret);
}

function generateCodeForAccount(accountName) {
    const secrets = getAccountSecrets(accountName);

    if (!secrets || !secrets.shared_secret) {
        throw new Error(
            'No shared_secret stored for Steam account: ' +
            accountName
        );
    }

    return generateCodeFromSecret(
        secrets.shared_secret
    );
}

module.exports = {
    generateCodeForAccount,
    generateCodeFromSecret
};
