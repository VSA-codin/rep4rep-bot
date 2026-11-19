// SPDX-License-Identifier: MIT
'use strict';

// R4R Bot - entry point.
//   node index.js            interactive menu (also: npm start)
//   node index.js --auto     one unattended pass, then exit (systemd / cron)
//
// Environment: R4R_DRY_RUN=1 (plan only), R4R_ONLY=<login> (one account),
// R4R_DATA_DIR (where config.json and steamprofiles.db live, default: current directory).
//
// Privacy: the bot contacts Rep4Rep and Steam only. Nothing is collected or reported.
// Files it creates are private to the current user (umask 077, mode 600).

const path = require('path');
const ansi = require('./lib/ansi');
const { loadConfig } = require('./src/config');
const { openDatabase, restrict } = require('./src/db');
const { createPrompt } = require('./src/prompt');
const { menu } = require('./src/menu');
const { runAuto } = require('./src/run');

if (process.platform !== 'win32') process.umask(0o077);

const dataDir = process.env.R4R_DATA_DIR || process.cwd();
const configFile = path.join(dataDir, 'config.json');
const databaseFile = path.join(dataDir, 'steamprofiles.db');

async function main() {
    const { config, notice } = loadConfig(configFile);
    if (notice) console.log(ansi.yellow('[CONFIG] ' + notice));

    const db = await openDatabase(databaseFile);
    restrict(configFile);

    const run = () => runAuto({ config, db });

    if (process.argv.includes('--auto')) {
        console.log('[AUTO] Auto Run started.');

        try {
            await run();
            process.exit(0);
        } catch (err) {
            console.error('[AUTO ERROR]', err.message || String(err));
            process.exit(1);
        }
    }

    const prompt = createPrompt();
    await menu({ db, prompt, runNow: run });
    prompt.close();
    await db.close();
    process.exit(0);
}

main().catch((err) => {
    console.error('Could not start: ' + (err && err.message ? err.message : String(err)));
    process.exit(1);
});
