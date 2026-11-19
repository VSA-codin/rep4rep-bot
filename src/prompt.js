// SPDX-License-Identifier: MIT
'use strict';

const readline = require('readline');

// Interactive input. On a real terminal each answer is read key by key, which
// lets passwords be typed without any echo. When input is piped (scripts, tests)
// answers are read line by line instead; end of input yields null.

function createTerminalPrompt(stdin, stdout) {
    function ask(question, options = {}) {
        const hidden = Boolean(options.hidden);

        return new Promise((resolve) => {
            stdout.write(question);
            stdin.setRawMode(true);
            stdin.resume();
            stdin.setEncoding('utf8');

            let value = '';
            let skip = 0;

            const finish = (result) => {
                stdin.removeListener('data', onData);
                stdin.setRawMode(false);
                stdin.pause();
                stdout.write('\n');
                resolve(result);
            };

            const onData = (chunk) => {
                for (const ch of chunk) {
                    if (skip > 0) { skip--; continue; }
                    if (ch === '\u0003') { // Ctrl+C
                        stdin.setRawMode(false);
                        stdout.write('\n');
                        process.exit(130);
                    }
                    if (ch === '\u0004') { finish(null); return; } // Ctrl+D
                    if (ch === '\r' || ch === '\n') { finish(value); return; }
                    if (ch === '\u007f' || ch === '\b') {
                        if (value.length > 0) {
                            value = value.slice(0, -1);
                            if (!hidden) stdout.write('\b \b');
                        }
                        continue;
                    }
                    if (ch === '\u001b') { skip = 2; continue; } // arrow keys and similar
                    if (ch >= ' ') {
                        value += ch;
                        if (!hidden) stdout.write(ch);
                    }
                }
            };

            stdin.on('data', onData);
        });
    }

    return {
        ask: (question) => ask(question),
        askHidden: (question) => ask(question, { hidden: true }),
        close() { stdin.pause(); }
    };
}

function createLinePrompt(stdin, stdout) {
    const reader = readline.createInterface({ input: stdin, terminal: false });
    const queued = [];
    const waiting = [];
    let ended = false;

    reader.on('line', (line) => {
        if (waiting.length > 0) waiting.shift()(line);
        else queued.push(line);
    });
    reader.on('close', () => {
        ended = true;
        waiting.splice(0).forEach((resolve) => resolve(null));
    });

    function ask(question) {
        stdout.write(question);

        return new Promise((resolve) => {
            if (queued.length > 0) resolve(queued.shift());
            else if (ended) resolve(null);
            else waiting.push(resolve);
        });
    }

    return { ask, askHidden: ask, close() { reader.close(); } };
}

function createPrompt(stdin = process.stdin, stdout = process.stdout) {
    return stdin.isTTY ? createTerminalPrompt(stdin, stdout) : createLinePrompt(stdin, stdout);
}

module.exports = { createPrompt };
