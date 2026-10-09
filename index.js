'use strict';

const path = require('path');
const readline = require('readline/promises');
const { Writable } = require('stream');
const { createCommunity: createSteamCommunity } = require('./lib/community');
const fetch = require('node-fetch');
const { autoRelogin } = require('./auto-relogin');
const { generateCodeForAccount } = require('./steam-2fa');
const { validateAccountName } = require('./lib/private-files');
const { withTimeout } = require('./lib/async');
const { openDatabase, loadConfig } = require('./lib/database');
const { createApi } = require('./lib/api');
const { runTasks } = require('./lib/bot');
const { interactiveLogin } = require('./lib/login');
const { version } = require('./package.json');

function createPrompt({ input = process.stdin, output = process.stdout, signal } = {}) {
    let muted = false;
    const sink = new Writable({
        write(chunk, encoding, callback) {
            if (!muted) output.write(chunk, encoding);
            callback();
        }
    });
    const rl = readline.createInterface({ input, output: sink, terminal: Boolean(input.isTTY) });
    return {
        async question(text, secret = false) {
            // Prompt first, then suppress terminal echo until the answer is submitted.
            const pending = rl.question(text, { signal });
            muted = secret;
            try { return await pending; }
            finally { muted = false; if (secret) output.write('\n'); }
        },
        close() { rl.close(); },
        onClose(handler) { rl.on('close', handler); }
    };
}

async function updateChecker({ logger = console, signal } = {}) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    try {
        const data = await withTimeout(async () => {
            const response = await fetch('https://raw.githubusercontent.com/VSA-codin/rep4rep-bot/main/package.json',
                { signal: controller.signal, redirect: 'error', size: 65536 });
            if (!response.ok) throw new Error('HTTP failure');
            return response.json();
        }, 3000, 'Update check', { signal });
        const latest = /^\d+\.\d+\.\d+$/.test(data.version) ? data.version.split('.').map(Number) : null;
        const current = version.split('.').map(Number);
        if (latest) {
            const differing = latest.findIndex((part, index) => part !== current[index]);
            if (differing >= 0 && latest[differing] > current[differing]) {
                logger.log('[UPDATE] New version available at https://github.com/VSA-codin/rep4rep-bot');
            }
        }
    } catch (err) {
        if (signal?.aborted) throw err;
        logger.log('[UPDATE] Version check unavailable.');
    }
    finally { controller.abort(); signal?.removeEventListener('abort', abort); }
}

async function menu({ db, api, signal, logger = console, prompt,
    createCommunity = () => createSteamCommunity({ signal }) }) {
    async function authenticate(relogin) {
        const accountName = validateAccountName(await prompt.question('Steam Login Username: '));
        if (relogin) {
            const matches = await db.all('SELECT id FROM steamprofiles WHERE username=? COLLATE NOCASE', [accountName]);
            if (matches.length !== 1) {
                logger.error('No unique saved account with that name. Review account IDs in the menu.');
                return;
            }
        }
        const password = await prompt.question('Password: ', true);
        if (!password) throw new Error('Password is required.');
        const client = createCommunity();
        try {
            const profile = await interactiveLogin({ client, accountName, password,
                question: prompt.question.bind(prompt), generateCode: generateCodeForAccount, signal, logger });
            await db.saveAccount(profile);
        } finally { client.dispose?.(); }
        logger.log('Steam account saved.');
    }
    async function run() {
        const summary = await runTasks({ db, api, signal, logger, createCommunity, autoRelogin });
        logger.log(`[AUTO] Posted ${summary.posted}, completed ${summary.completed}, skipped ${summary.skipped}, failed ${summary.failed}.`);
        return summary.failed ? 1 : 0;
    }

    while (!signal.aborted) {
        logger.log('\nRep4Rep Bot\n1) Auto Run\n2) Manage Steam Accounts\n3) Exit');
        const choice = (await prompt.question('>> ')).trim();
        if (choice === '3') return 0;
        if (choice === '1') return run();
        if (choice !== '2') { logger.error('Invalid option.'); continue; }
        let managing = true;
        while (managing && !signal.aborted) {
            const accounts = await db.all('SELECT id,username,steamId,last_comment FROM steamprofiles ORDER BY id');
            logger.table(accounts);
            logger.log('1) Add a Steam Account\n2) Re-Login to a Steam Account\n3) Remove a Steam Account\n4) Back');
            const action = (await prompt.question('>> ')).trim();
            try {
                if (action === '1' || action === '2') await authenticate(action === '2');
                else if (action === '3') {
                    const input = (await prompt.question('Username or numeric ID to remove: ')).trim();
                    logger.log(await db.removeAccount(input) ? 'Steam account removed.' : 'No account found.');
                } else if (action === '4') managing = false;
                else logger.error('Invalid option.');
            } catch (err) {
                if (signal.aborted || err.code === 'ABORT_ERR') throw err;
                logger.error('Account operation failed. Check private file permissions, credentials, and account identity.');
            }
        }
    }
    return 0;
}

async function main({ argv = process.argv.slice(2), env = process.env, logger = console } = {}) {
    if (argv.some(arg => arg !== '--auto')) {
        logger.error('Usage: node index.js [--auto]');
        return 1;
    }
    process.umask(0o077);
    const controller = new AbortController();
    const interrupt = () => controller.abort('SIGINT');
    const terminate = () => controller.abort('SIGTERM');
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', terminate);
    let db;
    let prompt;
    let locked = false;
    let code = 0;
    try {
        const config = loadConfig(env.R4R_CONFIG_FILE || path.join(__dirname, 'config.json'));
        db = await openDatabase(env.R4R_DB_PATH || path.join(__dirname, 'steamprofiles.db'));
        await db.acquireRunLock();
        locked = true;
        const api = createApi({ apiToken: config.apiToken, signal: controller.signal });
        if (argv.includes('--auto')) {
            const summary = await runTasks({ db, api, createCommunity: () => createSteamCommunity({ signal: controller.signal }),
                autoRelogin, signal: controller.signal, logger });
            logger.log(`[AUTO] Posted ${summary.posted}, completed ${summary.completed}, skipped ${summary.skipped}, failed ${summary.failed}.`);
            code = summary.failed ? 1 : 0;
        } else {
            prompt = createPrompt({ signal: controller.signal });
            prompt.onClose(() => controller.abort('EOF'));
            await updateChecker({ logger, signal: controller.signal });
            code = await menu({ db, api, signal: controller.signal, logger, prompt });
        }
        if (controller.signal.aborted) code = controller.signal.reason === 'SIGTERM' ? 143 :
            controller.signal.reason === 'EOF' ? 0 : 130;
    } catch (err) {
        if (controller.signal.aborted || err.code === 'ABORT_ERR') {
            logger.log('Run interrupted; saved task state retained.');
            code = controller.signal.reason === 'SIGTERM' ? 143 :
                controller.signal.reason === 'EOF' ? 0 : 130;
        } else {
            logger.error('R4R startup or task pass failed. Check configuration, private file permissions, database lock, and API availability.');
            code = 1;
        }
    } finally {
        prompt?.close();
        try { if (locked) await db.releaseRunLock(); }
        catch { logger.error('Database lock cleanup failed.'); code = 1; }
        try { if (db) await db.close(); }
        catch { logger.error('Database cleanup failed.'); code = 1; }
        process.removeListener('SIGINT', interrupt);
        process.removeListener('SIGTERM', terminate);
    }
    return code;
}

if (require.main === module) {
    main().then(code => { process.exitCode = code; }, () => {
        console.error('R4R failed unexpectedly.');
        process.exitCode = 1;
    });
}

module.exports = { main, menu, createPrompt, updateChecker };
