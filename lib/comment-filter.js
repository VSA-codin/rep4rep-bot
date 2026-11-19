// SPDX-License-Identifier: MIT
'use strict';

// Default filter for comment texts received from Rep4Rep tasks.
// The texts are written by other users and are posted from YOUR Steam accounts,
// so by default the bot skips links, file/download/delete instructions and
// cheating accusations. Override in config.json -> "commentFilter".

const DEFAULT_BLOCKED_WORDS = [
    'http://', 'https://', 'www.', 'discord.gg', 't.me/',
    '.exe', '.rar', '.zip', '.bat', '.dll',
    'download', 'delete', 'uninstall',
    'cheat', 'hack', 'scam',
    '-rep'
];

const DEFAULT_MAX_LENGTH = 300;

function createCommentFilter(config) {
    const cfg = (config && config.commentFilter) || {};
    const enabled = cfg.enabled !== false;
    const maxLength = Number.isInteger(cfg.maxLength) && cfg.maxLength > 0
        ? cfg.maxLength
        : DEFAULT_MAX_LENGTH;
    const words = (Array.isArray(cfg.blockedWords) ? cfg.blockedWords : DEFAULT_BLOCKED_WORDS)
        .map((w) => String(w).toLowerCase())
        .filter(Boolean);

    // Returns null if the comment may be posted, otherwise a short reason.
    return function rejectionReason(text) {
        if (!enabled) return null;
        if (typeof text !== 'string' || text.trim() === '') return 'empty text';
        if (text.length > maxLength) return 'longer than ' + maxLength + ' characters';
        const lower = text.toLowerCase();
        for (const word of words) {
            if (lower.includes(word)) return 'contains "' + word + '"';
        }
        return null;
    };
}

module.exports = { createCommentFilter, DEFAULT_BLOCKED_WORDS, DEFAULT_MAX_LENGTH };
