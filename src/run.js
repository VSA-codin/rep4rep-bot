// SPDX-License-Identifier: MIT
'use strict';

// One Auto Run pass: for every saved Steam account that is ready, fetch tasks from
// Rep4Rep, post the comments and submit them.
//
// Privacy rules: the API key travels only in an HTTP header and is never logged;
// login names are masked in every line; passwords and codes are never printed.

const SteamCommunity = require('steamcommunity');
const ansi = require('../lib/ansi');
const { createApiClient, apiMessage } = require('../lib/api');
const { createCommentFilter } = require('../lib/comment-filter');
const { maskLogin } = require('../lib/privacy');
const { describeSession } = require('../lib/session');
const { autoRelogin } = require('../auto-relogin');

const COMMENT_PAUSE_MS = 15000;
const MAX_ROUNDS = 4;
const MAX_FAILURES = 2;
const TASKS_PER_ROUND = 10;
const COOLDOWN_HOURS = 24;

// A failure that ends the whole run (bad key, missing config, ...).
class RunError extends Error {}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// SQLite stores last_comment as local time "YYYY-MM-DD HH:MM:SS".
function hoursSince(stamp, now) {
    if (!stamp) return Infinity;
    const then = new Date(String(stamp).replace(' ', 'T'));
    if (Number.isNaN(then.getTime())) return Infinity;
    return Math.floor((now - then.getTime()) / 3600000);
}

function promisify(method, target, ...args) {
    return new Promise((resolve, reject) => {
        target[method](...args, (err, value) => (err ? reject(err) : resolve(value)));
    });
}

function explainRejectedSession(label, cookieJson, say) {
    const info = describeSession(cookieJson);

    if (!info) {
        say('[SESSION] ' + label + ': there is no usable saved web session.');
    } else if (info.expired) {
        say('[SESSION] ' + label + ': the saved web session was issued ' + info.issuedHoursAgo +
            ' h ago and has expired (web sessions last about 24 h).');
    } else {
        say('[SESSION] ' + label + ': the saved web session should still be valid for ' +
            info.expiresInHours + ' h, but Steam rejected it.');
    }
}

// Returns a Steam client with a working web session, or null when none can be had.
async function obtainSession(profile, label, ctx) {
    const { say, deps, db } = ctx;
    const community = deps.createCommunity();

    community.oAuthToken = profile.token || null;

    let valid = false;
    if (profile.cookies) {
        try {
            community.setCookies(JSON.parse(profile.cookies));
            valid = await promisify('loggedIn', community);
        } catch (err) {
            say('[SESSION] ' + label + ': the saved session is unusable (' + err.message + ').');
        }
    }

    if (valid) return community;

    explainRejectedSession(label, profile.cookies, say);
    say('[RELOGIN] ' + label + ': trying to restore the session.');

    const restored = await deps.restoreSession(profile.username, db.raw);
    if (!restored) {
        say('[RELOGIN] ' + label + ': skipped.');
        return null;
    }

    return restored;
}

async function processProfile(profile, rep, ctx) {
    const { say, api, accepts, dryRun, now, deps } = ctx;
    const label = maskLogin(profile.username);

    const quiet = hoursSince(profile.last_comment, now());
    if (quiet < COOLDOWN_HOURS) {
        say(label + ': not ready, next run possible in ' + (COOLDOWN_HOURS - quiet) + ' h.');
        return;
    }

    let remaining = (rep.dailyCommentLimit ?? 10) - (rep.commentsToday ?? 0);
    if (remaining <= 0) {
        say(label + ': daily comment limit on Rep4Rep reached.');
        return;
    }

    say('[AUTO] ' + label + ': starting, up to ' + remaining + ' comment(s), ' +
        COMMENT_PAUSE_MS / 1000 + ' s pause between them.');

    let steam = null;
    if (!dryRun) {
        try {
            steam = await obtainSession(profile, label, ctx);
        } catch (err) {
            say('[AUTO] ' + label + ': session check failed (' + err.message + ').');
            return;
        }
        if (!steam) return;
    }

    let failures = 0;
    const seen = new Set();

    for (let round = 0; round < MAX_ROUNDS && remaining > 0 && failures < MAX_FAILURES; round++) {
        const batch = Math.min(remaining, TASKS_PER_ROUND);
        const reply = await api.request('GET', '/steam-profiles/' + profile.steamId + '/tasks?limit=' + batch);

        if (reply.status === 401) throw new RunError('Rep4Rep rejected the API key (401).');
        if (!reply.ok) {
            say('[AUTO] ' + label + ': could not fetch tasks (' + apiMessage(reply) + ').');
            break;
        }

        const fresh = ((reply.body && reply.body.data) || []).filter((task) => !seen.has(task.requestId));
        if (fresh.length === 0) {
            say('[AUTO] ' + label + ': no new tasks right now.');
            break;
        }
        fresh.forEach((task) => seen.add(task.requestId));

        for (const task of fresh) {
            if (failures >= MAX_FAILURES) {
                say(ansi.yellow('[AUTO] ' + label + ': two failures in a row, skipping this account.'));
                break;
            }
            if (remaining <= 0) break;

            const refusal = accepts(task.comment && task.comment.text);
            if (refusal) {
                say('[FILTER] Task ' + task.requestId + ' skipped: ' + refusal);
                continue;
            }

            say(label + ' -> ' + task.target.name + ' | ' + task.comment.text);

            if (dryRun) {
                say('[DRY RUN] would comment on and submit task ' + task.requestId + '.');
                continue;
            }

            try {
                await promisify('postUserComment', steam, task.target.steamId, task.comment.text);
                say(ansi.green('[AUTO] Comment posted.'));
                remaining--;

                await ctx.db.run(
                    "UPDATE steamprofiles SET last_comment = DATETIME('now', 'localtime') WHERE id = ?",
                    [profile.id]
                );

                const sent = await api.request('POST', '/tasks', {
                    steamId: profile.steamId,
                    requestId: task.requestId,
                    commentId: task.comment.id,
                    ticket: task.ticket
                });

                if (sent.ok) {
                    say('[AUTO] Submitted. Rep4Rep verifies it within a few minutes.');
                } else {
                    say('[AUTO] Submission refused (' + sent.status + '): ' + apiMessage(sent));
                    failures++;
                }
            } catch (err) {
                say('[AUTO] The comment or its submission failed: ' + err.message);
                failures++;
            }

            await deps.pause(COMMENT_PAUSE_MS);
        }

        if (dryRun) break;
    }
}

// Runs one pass over all saved accounts. Throws RunError for problems that end the run.
async function runAuto({ config, db, env = process.env, say = console.log, deps = {} }) {
    const dryRun = env.R4R_DRY_RUN === '1';
    const onlyLogin = env.R4R_ONLY || null;

    const apiKey = String(config.apiToken || '').trim();
    if (!apiKey || /^YOUR_/i.test(apiKey)) {
        throw new RunError('Missing apiToken in config.json (Rep4Rep: Settings -> API key).');
    }

    const wired = {
        createCommunity: () => new SteamCommunity(),
        restoreSession: autoRelogin,
        pause,
        now: Date.now,
        ...deps
    };
    const api = wired.api || createApiClient(apiKey, wired.pause);
    const accepts = createCommentFilter(config);

    const listing = await api.request('GET', '/steam-profiles');
    if (listing.status === 401) {
        throw new RunError('Rep4Rep rejected the API key (401). Create a new key in Settings -> API key.');
    }
    if (!listing.ok) throw new RunError('Rep4Rep /steam-profiles: ' + apiMessage(listing));

    const known = {};
    ((listing.body && listing.body.data) || []).forEach((entry) => { known[entry.steamId] = entry; });

    let profiles = await db.all('SELECT id, username, steamId, last_comment, cookies, token FROM steamprofiles');
    if (profiles.length === 0) throw new RunError('No local steam accounts added to comment from.');

    if (onlyLogin) {
        profiles = profiles.filter((profile) => profile.username === onlyLogin);
        if (profiles.length === 0) throw new RunError('R4R_ONLY is set but no saved account has that login name.');
    }

    if (dryRun) say(ansi.yellow('[DRY RUN] No Steam login, no comments, no submissions.'));

    const ctx = { say, api, accepts, dryRun, db, deps: wired, now: wired.now };

    for (const profile of profiles) {
        const label = maskLogin(profile.username);

        if (!known[profile.steamId]) {
            say(label + ': not yet registered on Rep4Rep.');
            if (dryRun) continue;

            const added = await api.request('POST', '/steam-profiles', { profile: profile.steamId });
            if (!added.ok) {
                say('[AUTO] ' + label + ': could not register it on Rep4Rep (' + apiMessage(added) + ').');
                continue;
            }
            known[profile.steamId] = (added.body && added.body.data) || {};
            say(label + ': registered on Rep4Rep.');
        }

        await processProfile(profile, known[profile.steamId], ctx);
    }

    say(ansi.green('Auto Run finished.'));
}

module.exports = { runAuto, RunError, hoursSince };
