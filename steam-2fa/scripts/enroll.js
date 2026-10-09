#!/usr/bin/env node
'use strict';

const readline = require('readline');
const SteamCommunity = require('steamcommunity');

const {
    saveAccountSecrets,
    writePending,
    deletePending,
    getPendingPath,
    hasAccountSecrets
} = require('../src/store');

const {
    generateCodeForAccount
} = require('../src/totp');

const accountName = (
    process.env.STEAM_USER || ''
).trim();

const password = process.env.STEAM_PASS || '';

if (!accountName || !password) {
    console.error(
        '[ERROR] Set STEAM_USER and STEAM_PASS first.'
    );
    process.exit(1);
}

if (hasAccountSecrets(accountName)) {
    console.error(
        '[ERROR] This account already has a stored shared_secret.'
    );
    console.error(
        '[INFO] Refusing to overwrite an existing 2FA setup.'
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

function finalizeEnrollment(response) {
    rl.question(
        'Steam activation code: ',
        function(activationCode) {
            activationCode = activationCode.trim();

            if (!activationCode) {
                console.error(
                    '[ERROR] Activation code is required.'
                );
                console.log(
                    '[INFO] Pending enrollment preserved at:'
                );
                console.log(
                    getPendingPath(accountName)
                );
                close(1);
                return;
            }

            console.log(
                '[2FA] Finalizing Steam Guard Mobile...'
            );

            community.finalizeTwoFactor(
                response.shared_secret,
                activationCode,
                function(err) {
                    if (err) {
                        console.error(
                            '[ERROR] ' + errorMessage(err)
                        );
                        console.log(
                            '[INFO] Pending enrollment preserved.'
                        );
                        close(1);
                        return;
                    }

                    saveAccountSecrets(
                        accountName,
                        response
                    );

                    deletePending(accountName);

                    console.log(
                        '[SUCCESS] Steam Guard Mobile enabled.'
                    );
                    console.log(
                        '[SUCCESS] Secrets saved locally.'
                    );
                    console.log(
                        '[IMPORTANT] Keep the revocation code safe.'
                    );

                    close(0);
                }
            );
        }
    );
}

function beginEnrollment() {
    console.log(
        '[2FA] Starting Steam Guard Mobile enrollment...'
    );

    community.enableTwoFactor(
        function(err, response) {
            if (err) {
                console.error(
                    '[ERROR] ' + errorMessage(err)
                );

                if (
                    errorMessage(err).includes('429')
                ) {
                    console.error(
                        '[INFO] Steam rate-limited enrollment.'
                    );
                    console.error(
                        '[INFO] Stop repeated retries and check for an existing pending enrollment.'
                    );
                }

                close(1);
                return;
            }

            if (
                !response ||
                !response.shared_secret
            ) {
                console.error(
                    '[ERROR] Steam did not return a shared_secret.'
                );
                close(1);
                return;
            }

            const pendingFile = writePending(
                accountName,
                response
            );

            console.log(
                '[OK] Enrollment started.'
            );
            console.log(
                '[OK] Pending data saved securely:'
            );
            console.log(pendingFile);

            finalizeEnrollment(response);
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
                            generateCodeForAccount(
                                accountName
                            );

                        console.log(
                            '[2FA] Generated Steam Guard code automatically.'
                        );

                        login(null, code);
                    } catch {
                        console.error(
                            '[ERROR] Steam requires Mobile Authenticator, but this tool has no stored shared_secret for this account.'
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
            beginEnrollment();
        }
    );
}

console.log('[LOGIN] ' + accountName);
login(null, null);
