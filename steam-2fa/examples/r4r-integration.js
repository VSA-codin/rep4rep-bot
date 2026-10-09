'use strict';

/*
 * Example integration for an existing R4R-bot login flow.
 *
 * Folder layout:
 *   ~/apps/R4R-bot
 *   ~/apps/steam-2fa-r4r-tool
 */

const {
    generateCodeForAccount
} = require('../');

function handleSteamGuardMobile(
    err,
    accountName,
    password,
    doLogin,
    rl
) {
    if (
        !err ||
        err.message !== 'SteamGuardMobile'
    ) {
        return false;
    }

    try {
        const code =
            generateCodeForAccount(accountName);

        console.log(
            '[2FA] Generated Steam Guard code automatically.'
        );

        doLogin(
            accountName,
            password,
            null,
            code
        );
    } catch (secretErr) {
        console.log(
            '[2FA] ' + secretErr.message
        );

        rl.question(
            'Steam Authenticator Code: ',
            function(code) {
                doLogin(
                    accountName,
                    password,
                    null,
                    code.trim()
                );
            }
        );
    }

    return true;
}

module.exports = {
    handleSteamGuardMobile
};
