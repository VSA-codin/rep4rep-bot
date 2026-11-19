// SPDX-License-Identifier: MIT
'use strict';

// Tiny terminal styling helper (no dependency). Colors are switched off when
// output is not a terminal or NO_COLOR is set, so logs and pipes stay clean.
const enabled = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

function style(open, close) {
    return (text) => (enabled ? '\u001b[' + open + 'm' + text + '\u001b[' + close + 'm' : String(text));
}

module.exports = {
    bold: style(1, 22),
    red: style(31, 39),
    green: style(32, 39),
    yellow: style(33, 39),
    cyan: style(36, 39),
    gray: style(90, 39)
};
