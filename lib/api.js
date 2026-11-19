// SPDX-License-Identifier: MIT
'use strict';

const fetch = require('node-fetch');

// Rep4Rep public API v1 - https://rep4rep.com/api
const API_BASE = 'https://api.rep4rep.com/v1';

function createApiClient(apiKey, sleep) {
    // The key is sent only in the Authorization header (never in the URL, so it
    // cannot end up in error messages or logs). Redirects are refused so the
    // header can never be forwarded to another host.
    async function request(method, endpoint, params, attempt = 0) {
        const options = {
            method,
            redirect: 'error',
            timeout: 30000,
            headers: {
                'Authorization': 'Bearer ' + apiKey,
                'Accept': 'application/json'
            }
        };
        if (params) {
            options.headers['Content-Type'] = 'application/json';
            options.body = JSON.stringify(params);
        }

        let res;
        try {
            res = await fetch(API_BASE + endpoint, options);
        } catch (err) {
            return { ok: false, status: 0, body: { message: 'network error: ' + (err.code || err.type || 'unknown') } };
        }

        if (res.status === 429 && attempt < 3) {
            await sleep(5000 * (attempt + 1));
            return request(method, endpoint, params, attempt + 1);
        }

        let body = null;
        if (res.status !== 204) {
            try { body = await res.json(); } catch (e) { body = null; }
        }
        return { ok: res.ok, status: res.status, body };
    }

    return { request };
}

function apiMessage(res) {
    if (res.body && res.body.message) {
        let msg = res.body.message;
        if (res.body.errors) msg += ' ' + JSON.stringify(res.body.errors);
        return msg;
    }
    return 'HTTP ' + res.status;
}

module.exports = { createApiClient, apiMessage, API_BASE };
