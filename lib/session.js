// SPDX-License-Identifier: MIT
'use strict';

// Steam's web session cookies (steamLoginSecure) are JWTs that last about 24 hours.
// This reads only their timestamps so the bot can say WHY a saved session is
// rejected. It never returns or logs the cookie values.
function decodePayload(raw) {
    try {
        const jwt = decodeURIComponent(raw).split('||')[1];
        return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
    } catch (err) {
        return null;
    }
}

// cookiesJson: the JSON text stored in steamprofiles.db.
// Returns null when there is nothing usable, otherwise
// { issuedHoursAgo, expiresInHours, expired }.
function describeSession(cookiesJson, nowSec = Math.floor(Date.now() / 1000)) {
    let cookies;

    try {
        cookies = JSON.parse(cookiesJson);
    } catch (err) {
        return null;
    }

    if (!Array.isArray(cookies)) return null;

    let best = null;

    for (const cookie of cookies) {
        const first = String(cookie).split(';')[0].trim();
        if (!first.startsWith('steamLoginSecure=')) continue;

        const payload = decodePayload(first.slice('steamLoginSecure='.length));
        if (!payload || typeof payload.iat !== 'number' || typeof payload.exp !== 'number') continue;

        const forCommunity = Array.isArray(payload.aud) && payload.aud.includes('web:community');
        if (forCommunity || best === null) best = payload;
        if (forCommunity) break;
    }

    if (!best) return null;

    return {
        issuedHoursAgo: Math.round((nowSec - best.iat) / 3600),
        expiresInHours: Math.round((best.exp - nowSec) / 3600),
        expired: best.exp <= nowSec
    };
}

module.exports = { describeSession };
