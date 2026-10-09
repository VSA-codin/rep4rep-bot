'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

function privateError(message, code = 'EPRIVATEFILE') {
    const error = new Error(message);
    error.code = code;
    return error;
}

function absolutePath(file) {
    if (typeof file !== 'string' || !file || file.includes('\0')) {
        throw privateError('A valid private file path is required.');
    }
    return path.resolve(file);
}

function checkOwner(stat) {
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
        throw privateError('Private data must belong to the current user.');
    }
}

function checkAncestors(directory) {
    const resolved = absolutePath(directory);
    const root = path.parse(resolved).root;
    let current = root;
    for (const component of resolved.slice(root.length).split(path.sep).filter(Boolean)) {
        current = path.join(current, component);
        const stat = fs.lstatSync(current);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
            throw privateError('Private data paths cannot contain symbolic links.');
        }
    }
    return resolved;
}

function checkDirectory(directory, requirePrivate = true) {
    const resolved = checkAncestors(directory);
    if (requirePrivate) {
        const stat = fs.lstatSync(resolved);
        checkOwner(stat);
        if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
            throw privateError('Private data directory must have mode 0700.');
        }
    }
    return resolved;
}

function ensurePrivateDirectory(directory) {
    const resolved = absolutePath(directory);
    const parent = path.dirname(resolved);
    try {
        const stat = fs.lstatSync(resolved);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
            throw privateError('Private data directory must be a real directory.');
        }
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        if (parent !== resolved) {
            try {
                checkAncestors(parent);
            } catch (parentError) {
                if (parentError.code !== 'ENOENT') throw parentError;
                ensurePrivateDirectory(parent);
            }
        }
        try {
            fs.mkdirSync(resolved, { mode: 0o700 });
        } catch (mkdirError) {
            if (mkdirError.code !== 'EEXIST') throw mkdirError;
        }
    }
    return checkDirectory(resolved);
}

function checkFile(stat) {
    if (!stat.isFile() || stat.nlink !== 1) {
        throw privateError('Private data must be a regular file with one link.');
    }
    checkOwner(stat);
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
        throw privateError('Private data file must have mode 0600.');
    }
}

function inspectFile(file) {
    const stat = fs.lstatSync(file);
    checkFile(stat);
    return stat;
}

function readPrivateJson(file, options = {}) {
    const resolved = absolutePath(file);
    const { privateDirectory = true, maxBytes = 1024 * 1024 } = options;
    let fd;
    try {
        checkDirectory(path.dirname(resolved), privateDirectory);
        const before = inspectFile(resolved);
        fd = fs.openSync(resolved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        const opened = fs.fstatSync(fd);
        checkFile(opened);
        if (before.dev !== opened.dev || before.ino !== opened.ino) {
            throw privateError('Private data changed while opening the file.');
        }
        if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || opened.size > maxBytes) {
            throw privateError('Private data file is too large.');
        }
        const raw = fs.readFileSync(fd, 'utf8');
        if (Buffer.byteLength(raw) > maxBytes) {
            throw privateError('Private data file is too large.');
        }
        try {
            return JSON.parse(raw);
        } catch {
            throw privateError('Private data contains invalid JSON.', 'EPRIVATEJSON');
        }
    } catch (error) {
        if (error.code === 'ENOENT' && Object.hasOwn(options, 'fallback')) return options.fallback;
        throw error;
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
    }
}

function syncDirectory(directory) {
    if (process.platform === 'win32') return;
    const fd = fs.openSync(directory, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0));
    try {
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
}

function atomicWritePrivateJson(file, data, { overwrite = true, privateDirectory = true } = {}) {
    const resolved = absolutePath(file);
    const directory = path.dirname(resolved);
    if (privateDirectory) ensurePrivateDirectory(directory);
    else checkDirectory(directory, false);

    try {
        inspectFile(resolved);
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }

    const temporary = path.join(directory, '.' + path.basename(resolved) + '.' + crypto.randomUUID() + '.tmp');
    let fd;
    let published = false;
    try {
        fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
        const serialized = JSON.stringify(data, null, 2);
        if (serialized === undefined) throw privateError('Private data must be JSON serializable.');
        fs.writeFileSync(fd, serialized + '\n', 'utf8');
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = undefined;
        if (overwrite) {
            fs.renameSync(temporary, resolved);
        } else {
            // Linking publishes a complete file and refuses an existing target atomically.
            fs.linkSync(temporary, resolved);
            fs.unlinkSync(temporary);
        }
        published = true;
        syncDirectory(directory);
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
        if (!published) {
            try { fs.unlinkSync(temporary); } catch (error) {
                if (error.code !== 'ENOENT') throw error;
            }
        }
    }
}

function removePrivateFile(file, { privateDirectory = true, missingOk = true } = {}) {
    const resolved = absolutePath(file);
    try {
        const directory = checkDirectory(path.dirname(resolved), privateDirectory);
        inspectFile(resolved);
        fs.unlinkSync(resolved);
        syncDirectory(directory);
        return true;
    } catch (error) {
        if (error.code === 'ENOENT' && missingOk) return false;
        throw error;
    }
}

function validateAccountName(accountName) {
    if (typeof accountName !== 'string' || !/^[A-Za-z0-9_]{1,64}$/.test(accountName.trim()) ||
        ['__proto__', 'constructor', 'prototype'].includes(accountName.trim().toLowerCase())) {
        throw privateError('A valid Steam account name is required.', 'EACCOUNT');
    }
    return accountName.trim();
}

function getPrivatePaths(env = process.env) {
    const dir = env.R4R_2FA_DIR ? path.resolve(env.R4R_2FA_DIR) : path.join(os.homedir(), '.config', 'r4r');
    return {
        dir,
        secrets: env.R4R_2FA_FILE ? path.resolve(env.R4R_2FA_FILE) : path.join(dir, 'steam-2fa.json'),
        passwords: env.R4R_PASSWORDS_FILE ? path.resolve(env.R4R_PASSWORDS_FILE) : path.join(dir, 'steam-passwords.json'),
        retry: env.R4R_RELOGIN_FILE ? path.resolve(env.R4R_RELOGIN_FILE) : path.join(dir, 'relogin-attempts.json')
    };
}

module.exports = {
    ensurePrivateDirectory,
    readPrivateJson,
    atomicWritePrivateJson,
    removePrivateFile,
    validateAccountName,
    getPrivatePaths
};
