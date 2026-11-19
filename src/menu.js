// SPDX-License-Identifier: MIT
'use strict';

const ansi = require('../lib/ansi');
const { maskLogin } = require('../lib/privacy');
const accounts = require('./accounts');

function clear() {
    if (process.stdout.isTTY) process.stdout.write('\u001b[2J\u001b[H');
}

function banner(title) {
    clear();
    console.log(ansi.bold('R4R Bot') + ' - ' + title);
    console.log();
}

// Interactive menu. `runNow` starts one Auto Run pass; it may throw an Error whose
// message is shown to the user.
async function menu({ db, prompt, runNow }) {
    let note = '';

    for (;;) {
        banner('main menu');
        console.log('  1  Run now');
        console.log('  2  Steam accounts');
        console.log('  0  Exit');
        console.log(ansi.gray('Ctrl+C leaves at any time.'));
        if (note) console.log('\n' + note);
        note = '';

        const choice = await prompt.ask('\n> ');
        if (choice === null) return;

        switch (choice.trim()) {
            case '1':
                try {
                    await runNow();
                    note = ansi.green('Run finished.');
                } catch (err) {
                    note = ansi.red('[AUTO ERROR] ' + err.message);
                }
                break;
            case '2':
                await accountsMenu({ db, prompt });
                break;
            case '0':
                return;
            default:
                note = ansi.red('Please choose 1, 2 or 0.');
        }
    }
}

async function accountsMenu({ db, prompt }) {
    let note = '';

    for (;;) {
        banner('Steam accounts');

        let rows = [];
        try {
            rows = await accounts.listAccounts(db);
        } catch (err) {
            console.log(ansi.red('Could not read the local database: ' + err.message));
        }

        if (rows.length > 0) {
            // Terminal output often ends up in pasted bug reports, so logins are masked.
            console.table(rows.map((row) => ({
                id: row.id,
                login: maskLogin(row.username),
                steamId: row.steamId,
                lastComment: row.last_comment
            })));
        } else {
            console.log('No accounts saved yet.\n');
        }

        console.log('  1  Add an account');
        console.log('  2  Refresh the login of a saved account');
        console.log('  3  Remove an account');
        console.log('  0  Back');
        if (note) console.log('\n' + note);
        note = '';

        const choice = await prompt.ask('\n> ');
        if (choice === null) return;

        try {
            switch (choice.trim()) {
                case '1': note = await addAccount({ db, prompt }); break;
                case '2': note = await refreshAccount({ db, prompt }); break;
                case '3': note = await deleteAccount({ db, prompt }); break;
                case '0': return;
                default: note = ansi.red('Please choose 1, 2, 3 or 0.');
            }
        } catch (err) {
            note = ansi.red(err.message);
        }
    }
}

async function signInAndSave({ db, prompt, login }) {
    const password = await prompt.askHidden('Password (not shown, not stored): ');
    if (password === null || password === '') return ansi.red('A password is required.');

    const result = await accounts.signIn({ login, password, prompt });
    await accounts.saveSession(db, login, result.steamId, result.cookies, result.oauthToken);

    return ansi.green('Signed in. The session for ' + maskLogin(login) + ' was saved.');
}

async function addAccount({ db, prompt }) {
    const login = ((await prompt.ask('Steam login name: ')) || '').trim();
    if (!login) return ansi.red('A login name is required.');

    return signInAndSave({ db, prompt, login });
}

async function refreshAccount({ db, prompt }) {
    const login = ((await prompt.ask('Steam login name: ')) || '').trim();
    if (!login) return ansi.red('A login name is required.');

    if (!(await accounts.hasAccount(db, login))) {
        return ansi.red('No saved account has that login. Use "Add an account" instead.');
    }

    return signInAndSave({ db, prompt, login });
}

async function deleteAccount({ db, prompt }) {
    const value = ((await prompt.ask('Login name (or record id) to remove: ')) || '').trim();
    if (!value) return 'Nothing was removed.';

    const removed = await accounts.removeAccount(db, value);
    return removed === 0 ? ansi.red('No saved account matched.') : ansi.green('Account removed.');
}

module.exports = { menu };
