'use strict';

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');
const { readPrivateJson, validateAccountName } = require('./private-files');
const { isSteamId } = require('./validation');

function checkDatabaseFile(file, { create = false } = {}) {
    const dir = path.dirname(file);
    if (fs.realpathSync(dir) !== dir) throw new Error('Database directory must not contain symlinks.');
    if (process.platform !== 'win32' && (fs.statSync(dir).mode & 0o022) !== 0) {
        throw new Error('Database directory must not be writable by other users.');
    }
    let stat;
    try {
        stat = fs.lstatSync(file);
    } catch (err) {
        if (err.code !== 'ENOENT') throw err;
        if (create) {
            const fd = fs.openSync(file, 'wx', 0o600);
            fs.closeSync(fd);
        }
        return;
    }
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 ||
        process.getuid && stat.uid !== process.getuid()) {
        throw new Error('Database and sidecars require owned regular files with mode 0600.');
    }
}

function loadConfig(file) {
    const config = readPrivateJson(path.resolve(file), { privateDirectory: false });
    if (!config || Array.isArray(config) || typeof config !== 'object' ||
        typeof config.apiToken !== 'string' || !config.apiToken.trim()) {
        throw new Error('Set apiToken in the private config.json file.');
    }
    return config;
}

async function openDatabase(file, { sqlite = sqlite3 } = {}) {
    file = path.resolve(file);
    checkDatabaseFile(file, { create: true });
    for (const suffix of ['-wal', '-shm', '-journal']) checkDatabaseFile(file + suffix);
    let raw;
    await new Promise((resolve, reject) => {
        raw = new sqlite.Database(file, err => err ? reject(err) : resolve());
    });
    raw.configure('busyTimeout', 5000);
    const db = {
        raw,
        all(sql, params = []) {
            return new Promise((resolve, reject) => raw.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows)));
        },
        get(sql, params = []) {
            return new Promise((resolve, reject) => raw.get(sql, params, (err, row) => err ? reject(err) : resolve(row)));
        },
        run(sql, params = []) {
            return new Promise((resolve, reject) => raw.run(sql, params, function(err) {
                if (err) reject(err);
                else resolve({ changes: this.changes, lastID: this.lastID });
            }));
        },
        close() {
            return new Promise((resolve, reject) => raw.close(err => err ? reject(err) : resolve()));
        },
        async initialize() {
            await db.run('PRAGMA foreign_keys = ON');
            await db.run(`CREATE TABLE IF NOT EXISTS steamprofiles (
                id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT, steamId TEXT UNIQUE,
                cookies TEXT, token TEXT, last_comment TEXT
            )`);
            await db.run(`CREATE TABLE IF NOT EXISTS comment_operations (
                account_id INTEGER NOT NULL REFERENCES steamprofiles(id) ON DELETE CASCADE,
                task_id TEXT NOT NULL, comment_id TEXT NOT NULL, rep_id TEXT NOT NULL,
                state TEXT NOT NULL CHECK(state IN ('posting', 'posted', 'completed')), created_at TEXT NOT NULL,
                PRIMARY KEY(account_id, task_id, comment_id)
            )`);
            await db.run('CREATE TABLE IF NOT EXISTS run_lock (id INTEGER PRIMARY KEY CHECK(id = 1), pid INTEGER NOT NULL)');
        },
        async acquireRunLock() {
            await db.run('BEGIN IMMEDIATE');
            try {
                const lock = await db.get('SELECT pid FROM run_lock WHERE id=1');
                if (lock) {
                    let live = true;
                    try { process.kill(lock.pid, 0); } catch (err) { live = err.code !== 'ESRCH'; }
                    if (live) throw new Error('Another R4R process holds the database lock.');
                }
                await db.run('INSERT OR REPLACE INTO run_lock(id,pid) VALUES(1,?)', [process.pid]);
                await db.run('COMMIT');
            } catch (err) {
                await db.run('ROLLBACK');
                throw err;
            }
        },
        async releaseRunLock() {
            await db.run('DELETE FROM run_lock WHERE id=1 AND pid=?', [process.pid]);
        },
        async saveAccount({ accountName, steamId, cookies, token = null }) {
            accountName = validateAccountName(accountName);
            if (!isSteamId(steamId) || !Array.isArray(cookies) ||
                !cookies.length || !cookies.every(cookie => typeof cookie === 'string')) {
                throw new Error('Steam returned an invalid account session.');
            }
            await db.run('BEGIN IMMEDIATE');
            try {
                const matches = await db.all('SELECT id, username, steamId FROM steamprofiles WHERE username=? COLLATE NOCASE OR steamId=?', [accountName, steamId]);
                if (matches.length > 1 || matches.length === 1 && matches[0].steamId !== String(steamId)) {
                    throw new Error('Saved account identity is ambiguous; review local accounts.');
                }
                if (matches.length) {
                    await db.run('UPDATE steamprofiles SET username=?,cookies=?,token=? WHERE id=?', [accountName, JSON.stringify(cookies), token, matches[0].id]);
                } else {
                    await db.run('INSERT INTO steamprofiles(username,steamId,cookies,token) VALUES(?,?,?,?)', [accountName, String(steamId), JSON.stringify(cookies), token]);
                }
                await db.run('COMMIT');
            } catch (err) {
                await db.run('ROLLBACK');
                throw err;
            }
        },
        async removeAccount(input) {
            const byId = /^\d+$/.test(input);
            const matches = await db.all(byId ? 'SELECT id FROM steamprofiles WHERE id=?' : 'SELECT id FROM steamprofiles WHERE username=? COLLATE NOCASE', [input]);
            if (matches.length > 1) throw new Error('Account name is ambiguous; remove by numeric ID.');
            if (!matches.length) return false;
            const pending = await db.get('SELECT task_id FROM comment_operations WHERE account_id=? AND state != ? LIMIT 1',
                [matches[0].id, 'completed']);
            if (pending) throw new Error('Resolve pending task operations before removing this account.');
            await db.run('DELETE FROM steamprofiles WHERE id=?', [matches[0].id]);
            return true;
        }
    };
    try { await db.initialize(); } catch (err) { await db.close(); throw err; }
    return db;
}

module.exports = { openDatabase, loadConfig };
