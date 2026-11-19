// SPDX-License-Identifier: MIT
'use strict';

const {
    getAccountSecrets,
    hasAccountSecrets,
    listAccounts,
    getConfigPath,
    getPendingPath
} = require('./src/store');

const {
    generateCodeForAccount,
    generateCodeFromSecret,
    secondsRemaining,
    getSteamTimeOffset
} = require('./src/totp');

module.exports = {
    getAccountSecrets,
    hasAccountSecrets,
    listAccounts,
    getConfigPath,
    getPendingPath,
    generateCodeForAccount,
    generateCodeFromSecret,
    secondsRemaining,
    getSteamTimeOffset
};
