'use strict';

const SteamTotp = require('steam-totp');
const {
    getAccountSecrets,
    validateSecret
} = require('./store');

function generateCodeFromSecret(sharedSecret) {
    return SteamTotp.generateAuthCode(validateSecret(sharedSecret));
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
