// SPDX-License-Identifier: MIT
'use strict';

// Read-only health check of the local 2FA files. Use it after moving the bot to
// a new machine or upgrading, to confirm the saved authenticators are usable.
// It never prints secrets or codes, and never changes any file.
//
//   npm run 2fa:check                 account names are masked
//   npm run 2fa:check -- --show-names show full login names

const fs = require('fs');
const path = require('path');
const SteamTotp = require('steam-totp');
const { getConfigPath } = require('../src/store');

const CODE_RE = /^[23456789BCDFGHJKMNPQRTVWXY]{5}$/;
const showNames = process.argv.includes('--show-names');
const isWindows = process.platform === 'win32';

const secretsFile = getConfigPath();
const dir = path.dirname(secretsFile);
const passwordsFile = path.join(dir, 'steam-passwords.json');

let problems = 0;
let warnings = 0;

function mask(name) {
    if (showNames) return name;
    return name.length <= 3 ? '***' : name.slice(0, 2) + '***' + name.slice(-1);
}

function problem(message) { problems++; console.log('  [PROBLEM] ' + message); }
function warn(message) { warnings++; console.log('  [WARN] ' + message); }

function checkMode(target, label, maxMode) {
    if (isWindows) return;
    const mode = fs.statSync(target).mode & 0o777;
    if ((mode & ~maxMode) !== 0) {
        warn(label + ' is accessible by other users (mode ' + mode.toString(8) + '). Run: chmod ' + maxMode.toString(8) + ' "' + target + '"');
    }
}

function readObject(file) {
    try {
        const value = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
            problem(path.basename(file) + ' does not contain a JSON object.');
            return null;
        }
        return value;
    } catch (err) {
        if (err.code === 'ENOENT') return undefined;
        problem(path.basename(file) + ' cannot be read: ' + err.message);
        return null;
    }
}

console.log('Directory: ' + (showNames ? dir : '(hidden, use --show-names)'));

if (!fs.existsSync(dir)) {
    console.log('  The directory does not exist. Nothing is enrolled on this machine yet.');
    process.exit(1);
}
checkMode(dir, 'Directory', 0o700);

const secrets = readObject(secretsFile);
const passwords = readObject(passwordsFile);

if (secrets === undefined) {
    console.log('steam-2fa.json: not found');
} else if (secrets) {
    checkMode(secretsFile, 'steam-2fa.json', 0o600);
    const names = Object.keys(secrets);
    console.log('steam-2fa.json: ' + names.length + ' account(s)');

    for (const name of names) {
        const entry = secrets[name];
        const label = '  ' + mask(name) + ': ';

        if (!entry || typeof entry !== 'object' || typeof entry.shared_secret !== 'string' || !entry.shared_secret) {
            console.log(label);
            problem('no shared_secret, codes cannot be generated.');
            continue;
        }

        const decoded = Buffer.from(entry.shared_secret, 'base64');
        let codeOk = false;
        try { codeOk = CODE_RE.test(SteamTotp.generateAuthCode(entry.shared_secret)); } catch (err) { codeOk = false; }

        console.log(
            label + 'shared_secret ' + (decoded.length === 20 ? 'OK' : 'UNEXPECTED LENGTH') +
            ', code generation ' + (codeOk ? 'OK' : 'FAILED') +
            ', identity_secret ' + (entry.identity_secret ? 'yes' : 'no') +
            ', revocation_code ' + (entry.revocation_code ? 'yes' : 'NO')
        );

        if (decoded.length !== 20 || !codeOk) problem('shared_secret looks damaged for this account.');
        if (!entry.revocation_code) warn('no revocation code saved for this account; keep one elsewhere.');
    }
}

if (passwords === undefined) {
    console.log('steam-passwords.json: not found (unattended re-login is disabled)');
} else if (passwords) {
    checkMode(passwordsFile, 'steam-passwords.json', 0o600);
    const names = Object.keys(passwords);
    console.log('steam-passwords.json: ' + names.length + ' account(s)');

    const have2fa = new Set(secrets ? Object.keys(secrets) : []);
    for (const name of names) {
        if (!have2fa.has(name)) {
            warn(mask(name) + ' has a password but no authenticator: automatic re-login will fail if Steam Guard is on for it.');
        }
    }
    for (const name of have2fa) {
        if (!Object.prototype.hasOwnProperty.call(passwords, name)) {
            warn(mask(name) + ' has an authenticator but no password: automatic re-login cannot run for it.');
        }
    }
}

console.log('Result: ' + (problems === 0 ? 'OK' : problems + ' problem(s)') + (warnings ? ', ' + warnings + ' warning(s)' : ''));
process.exit(problems === 0 ? 0 : 1);
