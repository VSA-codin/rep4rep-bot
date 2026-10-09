'use strict';

const {
    getAccountSecrets,
    hasAccountSecrets,
    getConfigPath,
    getPendingPath
} = require('./src/store');

const {
    generateCodeForAccount,
    generateCodeFromSecret
} = require('./src/totp');

module.exports = {
    getAccountSecrets,
    hasAccountSecrets,
    getConfigPath,
    getPendingPath,
    generateCodeForAccount,
    generateCodeFromSecret
};
