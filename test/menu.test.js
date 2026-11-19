// SPDX-License-Identifier: MIT
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const INDEX = path.join(__dirname, '..', 'index.js');

function runMenu(input) {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'r4r-menu-'));
    try {
        const res = spawnSync(process.execPath, [INDEX], { cwd, input, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
        return { ...res, cwd };
    } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
    }
}

test('menu: opens the accounts screen on a fresh install and exits cleanly', () => {
    const r = runMenu('2\n0\n0\n');
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /main menu/);
    assert.match(r.stdout, /No accounts saved yet\./);
    assert.ok(!r.stdout.includes('no such table'));
});

test('menu: invalid choices and removing an unknown account are handled', () => {
    const r = runMenu('x\n2\n3\nnobody\n0\n0\n');
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Please choose 1, 2 or 0\./);
    assert.match(r.stdout, /No saved account matched\./);
});

test('menu: end of input leaves without an error', () => {
    const r = runMenu('');
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
});

test('menu: Run now without an API key reports the problem and returns to the menu', () => {
    const r = runMenu('1\n0\n');
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Missing apiToken in config\.json/);
});
