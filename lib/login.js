'use strict';

const { withTimeout } = require('./async');
const { isSteamId } = require('./validation');
const { loginSteam } = require('./steam-login');

async function interactiveLogin({ client, accountName, password, question, generateCode,
    timeoutMs = 30000, signal, logger = console, login = loginSteam }) {
    const options = { accountName, password };
    let generated = false;
    for (let attempt = 0; attempt < 4; attempt++) {
        try {
            const session = await withTimeout(() => login(client, options, { timeoutMs, signal }),
                timeoutMs, 'Steam login', { signal });
            const verification = await withTimeout(done => client.loggedIn((err, loggedIn, familyView) =>
                done(err, { loggedIn, familyView })), timeoutMs, 'Session verification', { signal });
            const steamId = client.steamID?.getSteamID64();
            if (!verification.loggedIn || verification.familyView || !isSteamId(String(steamId))) throw new Error('Session verification failed.');
            return { accountName, steamId, ...session };
        } catch (err) {
            if (signal?.aborted || err.code === 'ABORT_ERR') throw err;
            if (attempt === 3) break;
            if (err.message === 'SteamGuardMobile') {
                let code = null;
                if (!generated) {
                    generated = true;
                    try { code = generateCode(accountName); } catch { /* A manual code can still be supplied. */ }
                }
                options.twoFactorCode = code || (await question('Steam Authenticator Code: ', true)).trim();
                if (!options.twoFactorCode) break;
                logger.log('[2FA] Steam Guard code supplied.');
            } else if (err.message === 'SteamGuard') {
                options.authCode = (await question('Steam Guard email code: ', true)).trim();
                if (!options.authCode) break;
            } else if (err.message === 'CAPTCHA') {
                try {
                    const url = new URL(err.captchaurl);
                    if (url.protocol !== 'https:' || url.username || url.password ||
                        !['steamcommunity.com', 'store.steampowered.com', 'login.steampowered.com'].includes(url.hostname)) break;
                    logger.log('Open the Steam CAPTCHA: ' + url.toString());
                } catch { break; }
                options.captcha = (await question('CAPTCHA answer: ', true)).trim();
                if (!options.captcha) break;
            } else {
                break;
            }
        }
    }
    throw new Error('Steam login failed. Check credentials, Steam Guard, and the account status.');
}

module.exports = { interactiveLogin };
