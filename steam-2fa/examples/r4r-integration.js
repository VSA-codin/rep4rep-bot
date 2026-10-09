'use strict';

/*
 * Example integration for an existing R4R-bot login flow.
 *
 * The caller owns its login timeout and attempt budget. This handler answers
 * one Mobile Guard challenge; it should run inside a bounded login flow.
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
    } catch {
        console.log(
            '[2FA] Stored authenticator is unavailable. Enter a code manually.'
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
