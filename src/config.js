// SPDX-License-Identifier: MIT
'use strict';

const fs = require('fs');

// Reads config.json. A missing or broken file never throws: the bot still starts
// (the account menus work without an API key) and the problem is reported as a
// notice. The JSON parser's own message is deliberately dropped, because current
// Node versions quote part of the input and this file contains the API key.
function loadConfig(file) {
    let text;

    try {
        text = fs.readFileSync(file, 'utf8');
    } catch (err) {
        return {
            config: {},
            notice: err.code === 'ENOENT'
                ? 'config.json not found (copy config.example.json to config.json).'
                : 'config.json could not be read (' + (err.code || 'unknown error') + ').'
        };
    }

    try {
        const parsed = JSON.parse(text);

        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return { config: parsed, notice: null };
        }
    } catch (err) {
        // fall through to the notice below
    }

    return {
        config: {},
        notice: 'config.json is not valid JSON. It must be a JSON object with "apiToken".'
    };
}

module.exports = { loadConfig };
