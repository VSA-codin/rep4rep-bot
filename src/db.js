// SPDX-License-Identifier: MIT
'use strict';

const fs = require('fs');
const sqlite3 = require('sqlite3');

const SCHEMA = `CREATE TABLE IF NOT EXISTS steamprofiles (
    id integer PRIMARY KEY AUTOINCREMENT,
    username varchar,
    steamId varchar UNIQUE,
    cookies text,
    token varchar,
    last_comment datetime
)`;

// The database holds Steam sessions, so it is created private (mode 600).
function restrict(file) {
    if (process.platform === 'win32') return;

    try {
        fs.chmodSync(file, 0o600);
    } catch (err) {
        // best effort
    }
}

// Opens (and if needed creates) the local SQLite database.
// `raw` is the underlying sqlite3 object for code that needs the callback API.
function openDatabase(file) {
    return new Promise((resolve, reject) => {
        const raw = new sqlite3.Database(file, (openErr) => {
            if (openErr) {
                reject(openErr);
                return;
            }

            const run = (sql, params = []) => new Promise((ok, fail) => {
                raw.run(sql, params, function onDone(err) {
                    if (err) fail(err);
                    else ok({ changes: this.changes, lastID: this.lastID });
                });
            });

            const all = (sql, params = []) => new Promise((ok, fail) => {
                raw.all(sql, params, (err, rows) => (err ? fail(err) : ok(rows)));
            });

            const get = (sql, params = []) => new Promise((ok, fail) => {
                raw.get(sql, params, (err, row) => (err ? fail(err) : ok(row)));
            });

            const close = () => new Promise((ok) => raw.close(() => ok()));

            run(SCHEMA).then(() => {
                restrict(file);
                resolve({ raw, run, all, get, close });
            }, reject);
        });
    });
}

module.exports = { openDatabase, restrict };
