// SPDX-License-Identifier: MIT
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createCommentFilter } = require('../lib/comment-filter');

test('filter allows ordinary +rep comments', () => {
    const f = createCommentFilter({});
    assert.strictEqual(f('+rep good player'), null);
    assert.strictEqual(f('Have a nice day'), null);
});

test('filter blocks links, instructions and accusations by default', () => {
    const f = createCommentFilter({});
    assert.ok(f('visit https://example.com'));
    assert.ok(f('Downloads -> Cheats -> Delete Folder'));
    assert.ok(f('hacker'));
    assert.ok(f('-rep'));
    assert.ok(f(''));
    assert.ok(f('x'.repeat(301)));
});

test('filter can be disabled or customised', () => {
    assert.strictEqual(createCommentFilter({ commentFilter: { enabled: false } })('https://x.y'), null);
    const f = createCommentFilter({ commentFilter: { blockedWords: ['banana'], maxLength: 10 } });
    assert.ok(f('banana'));
    assert.ok(f('this is too long'));
    assert.strictEqual(f('+rep'), null);
});
