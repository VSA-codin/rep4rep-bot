'use strict';

const FormData = require('form-data');
const defaultFetch = require('node-fetch');
const { withTimeout } = require('./async');
const { isSteamId } = require('./validation');

class ApiError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ApiError';
    }
}

function validId(value) {
    return (typeof value === 'string' && /^[1-9]\d*$/.test(value) && value.length <= 20) ||
        (Number.isSafeInteger(value) && value > 0);
}

function acknowledgement(data) {
    if (Array.isArray(data) || data.success === false ||
        !(data.success === true || typeof data.success === 'string' && data.success.trim() ||
            typeof data.info === 'string' && data.info.trim())) {
        throw new ApiError('rep4rep returned an invalid acknowledgement.');
    }
}

function createApi({ apiToken, fetch = defaultFetch, timeoutMs = 30000, signal } = {}) {
    if (typeof apiToken !== 'string' || !apiToken.trim()) {
        throw new ApiError('Configure a nonempty rep4rep API token.');
    }

    async function request(endpoint, fields = {}, post = false) {
        const controller = new AbortController();
        const abort = () => controller.abort();
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) controller.abort();
        const url = new URL(endpoint, 'https://rep4rep.com/pub-api/');
        const options = { signal: controller.signal, redirect: 'error', size: 1024 * 1024 };
        if (post) {
            const form = new FormData();
            for (const [key, value] of Object.entries({ apiToken, ...fields })) {
                form.append(key, String(value));
            }
            options.method = 'POST';
            options.body = form;
        } else {
            for (const [key, value] of Object.entries({ apiToken, ...fields })) {
                url.searchParams.set(key, String(value));
            }
        }
        try {
            return await withTimeout(async () => {
                const response = await fetch(url.toString(), options);
                if (!response.ok) throw new ApiError('rep4rep returned HTTP ' + Number(response.status) + '.');
                const data = await response.json();
                if (!data || typeof data !== 'object' || Object.hasOwn(data, 'error') && data.error) {
                    throw new ApiError('rep4rep rejected the request.');
                }
                return data;
            }, timeoutMs, 'rep4rep request', { signal });
        } catch (err) {
            if (err.code === 'ABORT_ERR' || err instanceof ApiError) throw err;
            // Fetch errors can include the request URL and its API token.
            const error = new ApiError('rep4rep request failed or timed out.');
            if (err.code === 'ETIMEDOUT') error.code = err.code;
            throw error;
        } finally {
            controller.abort();
            signal?.removeEventListener('abort', abort);
        }
    }

    function array(data, validator) {
        if (!Array.isArray(data) || !data.every(validator)) {
            throw new ApiError('rep4rep returned an invalid response.');
        }
        return data;
    }

    return {
        async profiles() {
            const profiles = array(await request('user/steamprofiles'), profile =>
                profile && isSteamId(profile.steamId) && validId(profile.id));
            if (new Set(profiles.map(profile => String(profile.steamId))).size !== profiles.length ||
                new Set(profiles.map(profile => String(profile.id))).size !== profiles.length) {
                throw new ApiError('rep4rep returned duplicate profile identities.');
            }
            return profiles;
        },
        async addProfile(steamId) {
            if (!isSteamId(steamId)) throw new ApiError('Invalid Steam profile ID.');
            const response = await request('user/steamprofiles/add', { steamProfile: steamId }, true);
            acknowledgement(response);
        },
        async tasks(repId) {
            if (!validId(repId)) throw new ApiError('Invalid rep4rep profile ID.');
            const tasks = array(await request('tasks', { steamProfile: repId }), task => task &&
                validId(task.taskId) && validId(task.requiredCommentId) &&
                isSteamId(task.targetSteamProfileId) &&
                typeof task.requiredCommentText === 'string' && task.requiredCommentText.trim().length > 0 &&
                task.requiredCommentText.length <= 1000);
            const ids = tasks.map(task => String(task.taskId) + ':' + String(task.requiredCommentId));
            if (new Set(ids).size !== ids.length) throw new ApiError('rep4rep returned duplicate tasks.');
            return tasks;
        },
        async complete(task, repId) {
            if (!validId(task.taskId) || !validId(task.requiredCommentId) || !validId(repId)) {
                throw new ApiError('Invalid task completion identity.');
            }
            const response = await request('tasks/complete', {
                taskId: task.taskId,
                commentId: task.requiredCommentId,
                authorSteamProfileId: repId
            }, true);
            acknowledgement(response);
        }
    };
}

module.exports = { createApi, ApiError };
