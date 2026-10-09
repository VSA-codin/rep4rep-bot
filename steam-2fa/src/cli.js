'use strict';

const readline = require('node:readline');
const SteamCommunity = require('steamcommunity');
const {enroll, finalize, errorMessage} = require('./enrollment');

async function run(mode, {env = process.env, argv = process.argv, input = process.stdin,
    output = process.stdout, logger = console, community, signal, store, authenticate} = {}) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) abort();
    signal?.addEventListener('abort', abort, {once: true});
    process.once('SIGINT', abort);
    process.once('SIGTERM', abort);
    let rl;
    let closed = false;
    const ask = question => {
        if (closed) return Promise.reject(Object.assign(new Error('Input closed.'), {code: 'ABORT_ERR'}));
        rl ||= readline.createInterface({input, output});
        return new Promise((resolve, reject) => {
            const onClose = () => {
                closed = true;
                reject(Object.assign(new Error('Input closed.'), {code: 'ABORT_ERR'}));
            };
            rl.once('close', onClose);
            rl.question(question, value => {
                rl.removeListener('close', onClose);
                resolve(value);
            });
        });
    };
    try {
        const action = mode === 'finalize' ? finalize : enroll;
        await action({
            accountName: mode === 'finalize' ? (argv[2] || env.STEAM_USER || '') : (env.STEAM_USER || ''),
            password: env.STEAM_PASS || '',
            community: community || new SteamCommunity({timeout: 30000}),
            ...(store ? {store} : {}),
            ...(authenticate ? {authenticate} : {}),
            ask,
            signal: controller.signal,
            log: message => logger.log(message)
        });
        return 0;
    } catch (error) {
        // Steam errors can include passwords, token-bearing URLs or response bodies.
        logger.error('[ERROR] ' + errorMessage(error));
        return controller.signal.aborted ? 130 : 1;
    } finally {
        closed = true;
        rl?.close();
        process.removeListener('SIGINT', abort);
        process.removeListener('SIGTERM', abort);
        signal?.removeEventListener('abort', abort);
    }
}

function main(mode) {
    run(mode).then(code => {
        process.exitCode = code;
    }, () => {
        console.error('[ERROR] Enrollment tool failed. Pending data was preserved.');
        process.exitCode = 1;
    });
}

module.exports = {run, main};
