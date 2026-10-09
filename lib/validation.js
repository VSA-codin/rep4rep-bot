'use strict';

function isSteamId(value) {
    if (typeof value !== 'string' || !/^\d{17}$/.test(value)) return false;
    const id = BigInt(value);
    // Public individual accounts, desktop instance, nonzero 32-bit account ID.
    return id >= 76561197960265729n && id <= 76561202255233023n;
}

module.exports = { isSteamId };
