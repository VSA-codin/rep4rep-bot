'use strict';

const { withTimeout, sleep: defaultSleep } = require('./async');

const DAY_MS = 24 * 60 * 60 * 1000;

function lastCommentTime(value) {
    if (!value) return null;
    // Existing SQLite timestamps used localtime; retain their original interpretation.
    const time = Date.parse(value.includes('T') ? value : value.replace(' ', 'T'));
    return Number.isFinite(time) ? time : NaN;
}

async function runTasks({ db, api, createCommunity, autoRelogin, now = Date.now,
    sleep = defaultSleep, timeoutMs = 30000, signal, logger = console } = {}) {
    const result = { posted: 0, completed: 0, skipped: 0, failed: 0 };
    const abortCheck = () => { if (signal?.aborted) { const err = new Error('Operation cancelled.'); err.code = 'ABORT_ERR'; throw err; } };
    abortCheck();
    const accounts = await db.all('SELECT id,username,steamId,cookies,token,last_comment FROM steamprofiles ORDER BY id');
    if (!accounts.length) throw new Error('No local Steam accounts; add one from the menu.');
    abortCheck();
    const profiles = await api.profiles();
    const repProfiles = new Map(profiles.map(profile => [String(profile.steamId), String(profile.id)]));
    let previousPost = null;

    for (const account of accounts) {
        abortCheck();
        let client;
        try {
            const pending = await db.all('SELECT * FROM comment_operations WHERE account_id=? AND state != ? ORDER BY created_at', [account.id, 'completed']);
            if (pending.some(operation => operation.state === 'posting')) {
                logger.error('[AUTO] Account ' + account.id + ': comment outcome needs manual review.');
                result.failed++;
                continue;
            }
            for (const operation of pending) {
                abortCheck();
                await api.complete({ taskId: operation.task_id, requiredCommentId: operation.comment_id }, operation.rep_id);
                await db.run('UPDATE comment_operations SET state=? WHERE account_id=? AND task_id=? AND comment_id=?', ['completed', account.id, operation.task_id, operation.comment_id]);
                result.completed++;
            }

            const repId = repProfiles.get(String(account.steamId));
            if (!repId) {
                await api.addProfile(account.steamId);
                logger.log('[AUTO] Account ' + account.id + ': added to rep4rep; tasks will start on the next pass.');
                result.skipped++;
                continue;
            }
            const last = lastCommentTime(account.last_comment);
            if (last !== null && (!Number.isFinite(last) || now() - last < DAY_MS)) {
                logger.log('[AUTO] Account ' + account.id + ': daily cooldown or invalid timestamp.');
                result.skipped++;
                continue;
            }

            client = createCommunity();
            let loggedIn = false;
            try {
                const cookies = JSON.parse(account.cookies || 'null');
                if (Array.isArray(cookies) && cookies.length && cookies.every(cookie => typeof cookie === 'string')) {
                    client.setCookies(cookies);
                    client.oAuthToken = account.token || null;
                    const verification = await withTimeout(done => client.loggedIn((err, status, familyView) =>
                        done(err, { status, familyView })), timeoutMs, 'Session check', { signal });
                    loggedIn = verification.status && !verification.familyView &&
                        client.steamID?.getSteamID64() === account.steamId;
                }
            } catch (err) {
                if (err.code === 'ABORT_ERR') throw err;
            }
            if (!loggedIn) {
                client.dispose?.();
                client = await autoRelogin(account.username, db.raw, {
                    accountId: account.id, steamId: account.steamId, timeoutMs, signal
                });
                if (!client) {
                    logger.error('[AUTO] Account ' + account.id + ': session unavailable.');
                    result.failed++;
                    continue;
                }
            }

            const tasks = await api.tasks(repId);
            for (const task of tasks) {
                abortCheck();
                const recorded = await db.get('SELECT state FROM comment_operations WHERE account_id=? AND task_id=? AND comment_id=?',
                    [account.id, String(task.taskId), String(task.requiredCommentId)]);
                if (recorded) continue;
                if (previousPost !== null) await sleep(Math.max(0, 15000 - (now() - previousPost)), { signal });
                const created = new Date(now()).toISOString();
                // Persist intent before Steam: a timeout or crash may leave a real comment behind.
                await db.run('INSERT INTO comment_operations(account_id,task_id,comment_id,rep_id,state,created_at) VALUES(?,?,?,?,?,?)',
                    [account.id, String(task.taskId), String(task.requiredCommentId), repId, 'posting', created]);
                abortCheck();
                previousPost = now();
                await withTimeout(done => client.postUserComment(task.targetSteamProfileId, task.requiredCommentText, done),
                    timeoutMs, 'Steam comment', { signal });
                previousPost = now();
                result.posted++;
                // One atomic update preserves both the cooldown and the completion retry state.
                await db.run('BEGIN IMMEDIATE');
                try {
                    await db.run('UPDATE comment_operations SET state=? WHERE account_id=? AND task_id=? AND comment_id=?',
                        ['posted', account.id, String(task.taskId), String(task.requiredCommentId)]);
                    await db.run('UPDATE steamprofiles SET last_comment=? WHERE id=?', [new Date(now()).toISOString(), account.id]);
                    await db.run('COMMIT');
                } catch (err) { await db.run('ROLLBACK'); throw err; }
                await api.complete(task, repId);
                await db.run('UPDATE comment_operations SET state=? WHERE account_id=? AND task_id=? AND comment_id=?',
                    ['completed', account.id, String(task.taskId), String(task.requiredCommentId)]);
                result.completed++;
                logger.log('[AUTO] Account ' + account.id + ': task completed.');
            }
        } catch (err) {
            if (err.code === 'ABORT_ERR') throw err;
            // Do not expose remote responses, comment text, cookies, or request URLs.
            logger.error('[AUTO] Account ' + account.id + ': task pass failed; saved state retained.');
            result.failed++;
        } finally {
            client?.dispose?.();
        }
    }
    return result;
}

module.exports = { runTasks, lastCommentTime, DAY_MS };
