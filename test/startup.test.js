// SPDX-License-Identifier: MIT
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const INDEX = path.join(__dirname, '..', 'index.js');

// A fresh install has no config.json (git-ignored). Auto Run must explain that,
// not crash with a raw MODULE_NOT_FOUND stack trace.
test('auto run without config.json fails with a clear message', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'r4r-start-'));

    try {
        const res = spawnSync(process.execPath, [INDEX, '--auto'], { cwd, encoding: 'utf8' });

        const where = 'status=' + res.status + '\nstdout: ' + res.stdout + '\nstderr: ' + res.stderr;

        assert.strictEqual(res.status, 1, where);
        assert.match(res.stdout, /config\.json not found/, where);
        assert.match(res.stderr, /Missing apiToken in config\.json/, where);
        assert.ok(!res.stderr.includes('MODULE_NOT_FOUND'), where);
        assert.ok(!res.stderr.includes('Cannot find module'), where);

        // The database is prepared before Auto Run queries it.
        assert.ok(fs.existsSync(path.join(cwd, 'steamprofiles.db')));

        if (process.platform !== 'win32') {
            const mode = fs.statSync(path.join(cwd, 'steamprofiles.db')).mode & 0o777;
            assert.strictEqual(mode, 0o600, 'the database must be readable only by its owner');
        }
    } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
    }
});
