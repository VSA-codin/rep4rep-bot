#!/usr/bin/env node
'use strict';

const readline = require('readline');
const SteamCommunity = require('steamcommunity');

const {
    readPending,
    saveAccountSecrets,
    deletePending,
    getPendingPath
} = require('../src/store');

const {
    generateCodeFromSecret
} = require('../src/totp');

const accountName = (
    process.argv[2] ||
    process.env.STEAM_USER ||
    ''
).trim();

const password = process.env.STEAM_PASS || '';

if (!accountName || !password) {
    console.error(
        '[ERROR] Usage: STEAM_PASS=... node scripts/finalize.js ACCOUNT'
    );
    process.exit(1);
}

let pending;

try {
    pending = readPending(accountName);
} catch (err) {
    console.error(
        '[ERROR] Could not read pending enrollment: ' +
        err.message
    );
    process.exit(1);
}

if (!pending) {
    console.error(
        '[ERROR] No pending enrollment found:'
    );
    console.error(
        getPendingPath(accountName)
    );
    process.exit(1);
}

if (!pending.shared_secret) {
    console.error(
        '[ERROR] Pending enrollment has no shared_secret.'
    );
    process.exit(1);
}

const community = new SteamCommunity();

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function close(code = 0) {
    rl.close();
    process.exitCode = code;
}

function errorMessage(err) {
    return err && err.message
        ? err.message
        : String(err);
}

function finalize() {
    rl.question(
        'Steam activation code: ',
        function(activationCode) {
            activationCode = activationCode.trim();

            if (!activationCode) {
                console.error(
                    '[ERROR] Activation code is required.'
                );
                close(1);
                return;
            }

            console.log(
                '[2FA] Finalizing existing enrollment...'
            );

            community.finalizeTwoFactor(
                pending.shared_secret,
                activationCode,
                function(err) {
                    if (err) {
                        console.error(
                            '[ERROR] ' + errorMessage(err)
                        );
                        console.log(
                            '[INFO] Pending enrollment was NOT deleted.'
                        );
                        close(1);
                        return;
                    }

                    saveAccountSecrets(
                        accountName,
                        pending
                    );

                    deletePending(accountName);

                    console.log(
                        '[SUCCESS] 2FA enrollment finalized.'
                    );
                    console.log(
                        '[SUCCESS] Secrets saved locally.'
                    );
                    console.log(
                        '[SUCCESS] Pending file removed.'
                    );

                    close(0);
                }
            );
        }
    );
}

function login(authCode, twoFactorCode) {
    community.login(
        {
            accountName,
            password,
            authCode: authCode || undefined,
            twoFactorCode:
                twoFactorCode || undefined,
            disableMobile: false
        },
        function(err) {
            if (err) {
                if (err.message === 'SteamGuard') {
                    rl.question(
                        'Steam Guard email code: ',
                        function(code) {
                            login(
                                code.trim(),
                                null
                            );
                        }
                    );
                    return;
                }

                if (
                    err.message ===
                    'SteamGuardMobile'
                ) {
                    try {
                        const code =
                            generateCodeFromSecret(
                                pending.shared_secret
                            );

                        console.log(
                            '[2FA] Generated Steam Guard code automatically.'
                        );

                        login(null, code);
                    } catch (codeErr) {
                        console.error(
                            '[ERROR] ' +
                            errorMessage(codeErr)
                        );
                        close(1);
                    }

                    return;
                }

                console.error(
                    '[ERROR] ' + errorMessage(err)
                );
                close(1);
                return;
            }

            console.log('[OK] Logged in.');
            finalize();
        }
    );
}

console.log('[LOGIN] ' + accountName);
login(null, null);
