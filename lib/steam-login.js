'use strict';

const https = require('node:https');
const { LoginSession, EAuthTokenPlatformType, EAuthSessionGuardType } = require('steam-session');

function stoppedError(code = 'ABORT_ERR') {
    const error = new Error(code === 'ETIMEDOUT' ? 'Steam login timed out.' : 'Steam login was cancelled.');
    error.code = code;
    return error;
}

class LoginAgent extends https.Agent {
    constructor(timeoutMs) {
        super({ keepAlive: true, timeout: timeoutMs });
        this.stopped = false;
    }

    addRequest(request, options) {
        if (this.stopped) {
            request.destroy(stoppedError());
            return;
        }
        super.addRequest(request, options);
    }

    destroy() {
        this.stopped = true;
        super.destroy();
    }
}

function loginSteam(client, details, options = {}) {
    const { timeoutMs = 30000, signal } = options;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) {
        return Promise.reject(new RangeError('A positive login timeout is required.'));
    }
    if (signal?.aborted) return Promise.reject(stoppedError());
    const Session = options.LoginSession || LoginSession;
    const platforms = options.EAuthTokenPlatformType || EAuthTokenPlatformType;
    const guards = options.EAuthSessionGuardType || EAuthSessionGuardType;
    const mobile = details.disableMobile === false;

    return new Promise((resolve, reject) => {
        let completed = false;
        let session;
        let agent;
        let timer;

        const finish = (error, result) => {
            if (completed) return;
            completed = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            if (session) {
                session.removeListener('authenticated', authenticated);
                session.removeListener('timeout', timeout);
                session.removeListener('error', failed);
                // Upstream may finish a pending request after cancellation.
                session.on('error', () => {});
                try { session.cancelLoginAttempt(); } catch { /* The transport is also closed below. */ }
            }
            agent?.destroy();
            if (error) reject(error);
            else resolve(result);
        };
        const failed = error => finish(error);
        const timeout = () => finish(stoppedError('ETIMEDOUT'));
        const abort = () => finish(stoppedError());
        const authenticated = async () => {
            try {
                const cookies = await session.getWebCookies();
                if (completed) return;
                if (!Array.isArray(cookies) || cookies.length === 0 ||
                    cookies.some(cookie => typeof cookie !== 'string' || !cookie)) {
                    throw new Error('Steam did not provide usable web cookies.');
                }
                const token = mobile ? session.accessToken : null;
                if (mobile && (typeof token !== 'string' || !token)) {
                    throw new Error('Steam did not provide a mobile access token.');
                }
                client.setCookies(cookies);
                if (mobile) client.setMobileAppAccessToken(token);
                finish(null, { cookies, token });
            } catch (error) {
                finish(error);
            }
        };

        try {
            agent = options.createAgent ? options.createAgent(timeoutMs) : new LoginAgent(timeoutMs);
            session = new Session(mobile ? platforms.MobileApp : platforms.WebBrowser, { agent });
            session.loginTimeout = timeoutMs;
            session.on('authenticated', authenticated);
            session.on('error', failed);
            session.on('timeout', timeout);
            signal?.addEventListener('abort', abort, { once: true });
            timer = setTimeout(timeout, timeoutMs);
            if (signal?.aborted) return abort();
            Promise.resolve(session.startWithCredentials({
                accountName: details.accountName,
                password: details.password,
                steamGuardMachineToken: details.steamguard,
                steamGuardCode: details.authCode || details.twoFactorCode
            })).then(result => {
                if (completed) return;
                if (!result || typeof result.actionRequired !== 'boolean') {
                    throw new Error('Steam returned an invalid authentication response.');
                }
                if (!result.actionRequired) return;
                const email = result.validActions?.find(action => action.type === guards.EmailCode);
                const error = new Error(email ? 'SteamGuard' : 'SteamGuardMobile');
                if (email) error.emaildomain = email.detail;
                finish(error);
            }).catch(failed);
        } catch (error) {
            finish(error);
        }
    });
}

module.exports = { loginSteam, LoginAgent };
