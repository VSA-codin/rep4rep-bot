'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const targets = process.argv.slice(2);
const ignored = new Set(['node_modules', '.git']);

function javascriptFiles(target) {
    const absolute = path.resolve(root, target);
    if (!fs.existsSync(absolute)) return [];
    if (fs.statSync(absolute).isFile()) return absolute.endsWith('.js') ? [absolute] : [];
    return fs.readdirSync(absolute, { withFileTypes: true })
        .filter((entry) => !ignored.has(entry.name) && !entry.isSymbolicLink())
        .sort((left, right) => left.name.localeCompare(right.name))
        .flatMap((entry) => javascriptFiles(path.join(target, entry.name)));
}

const files = (targets.length ? targets : ['index.js', 'auto-relogin.js', 'lib', 'scripts', 'steam-2fa', 'test'])
    .flatMap(javascriptFiles);

for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
    if (result.error) {
        console.error(`Cannot check ${path.relative(root, file)}: ${result.error.message}`);
        process.exitCode = 1;
    } else if (result.status !== 0) {
        process.exitCode = 1;
    }
}

if (!process.exitCode) console.log(`Syntax checked ${files.length} JavaScript files.`);
