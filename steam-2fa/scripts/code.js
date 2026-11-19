// SPDX-License-Identifier: MIT
'use strict';

// Prints the current Steam Guard code for an account whose authenticator was
// enrolled with this tool. Use it to sign in to Steam on another device or
// browser without resetting two-factor authentication.
//
//   npm run 2fa:code -- ACCOUNT          show the code once
//   npm run 2fa:code -- ACCOUNT --watch  keep it updated (Ctrl+C to stop)
//   npm run 2fa:code -- --list           list accounts that have an authenticator
//
// The shared secret is never printed or logged; only the 5-character code is.

const {
    listAccounts
} = require('../src/store');

const {
    generateCodeForAccount,
    secondsRemaining,
    getSteamTimeOffset
} = require('../src/totp');

const USAGE = [
    'Usage: npm run 2fa:code -- [ACCOUNT] [options]',
    '',
    'Options:',
    '  --watch   keep showing the current code (Ctrl+C to stop)',
    '  --plain   print only the code (for scripts or clipboard tools)',
    '  --sync    use Steam\'s server time (one request to api.steampowered.com)',
    '            if the code is rejected because this machine\'s clock is off',
    '  --list    list accounts that have an authenticator stored',
    '  --help    show this help',
    '',
    'ACCOUNT can be omitted when exactly one account is stored.'
].join('\n');

function fail(message, exitCode = 1) {
    console.error('[ERROR] ' + message);
    process.exit(exitCode);
}

function parseArgs(argv) {
    const options = {
        watch: false,
        plain: false,
        sync: false,
        list: false,
        help: false,
        account: null
    };

    for (const arg of argv) {
        switch (arg) {
            case '--watch': options.watch = true; break;
            case '--plain': options.plain = true; break;
            case '--sync': options.sync = true; break;
            case '--list': options.list = true; break;
            case '--help':
            case '-h': options.help = true; break;
            default:
                if (arg.startsWith('-')) {
                    fail('Unknown option: ' + arg + '\n\n' + USAGE, 2);
                }
                if (options.account !== null) {
                    fail('Only one account can be given.\n\n' + USAGE, 2);
                }
                options.account = arg;
        }
    }

    return options;
}

function resolveAccount(requested) {
    if (requested) return requested;

    const accounts = listAccounts();

    if (accounts.length === 1) return accounts[0];

    if (accounts.length === 0) {
        fail('No authenticator is stored yet. Run: npm run 2fa:enroll');
    }

    fail(
        'Several accounts are stored, choose one:\n  ' +
        accounts.join('\n  ')
    );
}

async function main() {
    const options = parseArgs(process.argv.slice(2));

    if (options.help) {
        console.log(USAGE);
        return;
    }

    if (options.watch && options.plain) {
        fail('--watch and --plain cannot be combined.', 2);
    }

    if (options.list) {
        const accounts = listAccounts();

        if (accounts.length === 0) {
            console.log('No authenticator is stored yet.');
        } else {
            accounts.forEach((name) => console.log(name));
        }
        return;
    }

    const account = resolveAccount(options.account);

    let offset = 0;

    if (options.sync) {
        try {
            offset = await getSteamTimeOffset();
        } catch (err) {
            console.error(
                '[WARN] Could not get Steam time, using the local clock: ' +
                err.message
            );
        }
    }

    const render = () => {
        const code = generateCodeForAccount(account, offset);
        const left = secondsRemaining(Date.now(), offset);

        return { code, left };
    };

    if (options.plain) {
        console.log(render().code);
        return;
    }

    if (!options.watch) {
        const { code, left } = render();
        console.log(account + ': ' + code + '  (valid for ' + left + ' s)');
        return;
    }

    const clearLine = () => process.stdout.write('\r' + ' '.repeat(60) + '\r');

    const tick = () => {
        const { code, left } = render();
        process.stdout.write(
            '\r' + account + ': ' + code + '  (valid for ' +
            String(left).padStart(2, ' ') + ' s)   '
        );
    };

    process.on('SIGINT', () => {
        clearLine();
        process.exit(0);
    });

    tick();
    setInterval(tick, 1000);
}

main().catch((err) => fail(err.message));
