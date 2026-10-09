'use strict';

const https = require('node:https');
const RealSteamCommunity = require('steamcommunity');
const { isSteamId } = require('./validation');

function requestError(message, code) {
    const error = new Error(message);
    if (code) error.code = code;
    return error;
}

function createCommunity({ timeoutMs = 30000, signal, SteamCommunity = RealSteamCommunity, sendRequest } = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) {
        throw new RangeError('A positive Steam request timeout is required.');
    }
    const client = new SteamCommunity({ timeout: timeoutMs });
    const transport = sendRequest || client.request.bind(client);
    const agent = new https.Agent({ keepAlive: true, timeout: timeoutMs });
    const active = new Set();
    let disposed = false;

    client.request = function trackedRequest(options, callback) {
        const completed = typeof callback === 'function' ? callback : () => {};
        if (disposed || signal?.aborted) {
            completed(requestError('Steam request was cancelled.', 'ABORT_ERR'));
            return null;
        }
        const operation = { handle: null, finished: false, cancelled: false, timer: null };
        const finish = (error, response, body) => {
            if (operation.finished) return;
            operation.finished = true;
            clearTimeout(operation.timer);
            active.delete(operation);
            completed(error, response, body);
        };
        operation.cancel = code => {
            operation.cancelled = true;
            finish(requestError(code === 'ETIMEDOUT' ? 'Steam request timed out.' : 'Steam request was cancelled.', code));
            try { operation.handle?.abort(); } catch { /* The owning agent is closed on disposal. */ }
        };
        active.add(operation);
        operation.timer = setTimeout(() => operation.cancel('ETIMEDOUT'), timeoutMs);
        try {
            operation.handle = transport({ ...options, timeout: timeoutMs, agent }, (error, response, body) => {
                if (error) return finish(requestError('Steam request failed.', error.code === 'ETIMEDOUT' ? error.code : undefined));
                finish(null, response, body);
            }, client);
            if (operation.cancelled) operation.handle?.abort();
        } catch {
            finish(requestError('Steam request failed.'));
        }
        return operation.handle;
    };

    client.dispose = () => {
        if (disposed) return;
        disposed = true;
        signal?.removeEventListener('abort', client.dispose);
        for (const operation of [...active]) operation.cancel('ABORT_ERR');
        agent.destroy();
    };
    signal?.addEventListener('abort', client.dispose, { once: true });
    if (signal?.aborted) client.dispose();

    client.loggedIn = callback => {
        client.request({ method: 'GET', uri: 'https://steamcommunity.com/my', followRedirect: false }, (error, response) => {
            if (error) return callback(error);
            if (response?.statusCode === 403) return callback(null, true, true);
            if (response?.statusCode !== 302 || typeof response.headers?.location !== 'string') {
                return callback(requestError('Steam returned an invalid session response.'));
            }
            let location;
            try { location = new URL(response.headers.location, 'https://steamcommunity.com/my'); }
            catch { return callback(requestError('Steam returned an invalid session response.')); }
            const match = /^\/(id|profiles)\/([^/]+)\/?$/.exec(location.pathname);
            const loggedIn = location.protocol === 'https:' && location.hostname === 'steamcommunity.com' &&
                !location.port && !location.username && !location.password && Boolean(match) &&
                (match[1] === 'id' || isSteamId(match[2]));
            callback(null, loggedIn, false);
        });
    };

    client.postUserComment = (target, text, callback = () => {}) => {
        let steamId;
        try { steamId = typeof target === 'string' ? target : target?.getSteamID64(); }
        catch { return callback(requestError('Invalid Steam comment target.')); }
        if (!isSteamId(steamId) || typeof text !== 'string' || !text.trim() || text.length > 1000) {
            return callback(requestError('Invalid Steam comment request.'));
        }
        client.request({
            method: 'POST',
            uri: 'https://steamcommunity.com/comment/Profile/post/' + steamId + '/-1',
            followRedirect: false,
            headers: { origin: 'https://steamcommunity.com' },
            form: { comment: text, count: 1, sessionid: client.getSessionID() },
            json: true
        }, (error, response, body) => {
            if (error) return callback(error);
            if (!Number.isInteger(response?.statusCode) || response.statusCode < 200 || response.statusCode >= 300 ||
                !body || typeof body !== 'object' || Array.isArray(body) || body.error ||
                !(body.success === true || body.success === 1)) {
                return callback(requestError('Steam did not confirm the comment.'));
            }
            // The bot records rep4rep's requiredCommentId; it does not need Steam's HTML comment ID.
            callback(null);
        });
    };

    return client;
}

module.exports = { createCommunity };
