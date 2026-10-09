'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

test('offline guard rejects HTTP, TLS, socket, DNS and fetch requests before connecting', async () => {
    const blocked = /Network access is disabled in offline tests/;
    assert.throws(() => require('node:http').get('http://example.invalid'), blocked);
    assert.throws(() => require('node:https').request('https://example.invalid'), blocked);
    assert.throws(() => require('node:http2').connect('https://example.invalid'), blocked);
    assert.throws(() => require('node:net').connect(443, 'example.invalid'), blocked);
    assert.throws(() => new (require('node:net').Socket)().connect(443, 'example.invalid'), blocked);
    assert.throws(() => require('node:tls').connect(443, 'example.invalid'), blocked);
    assert.throws(() => require('node:dgram').createSocket('udp4'), blocked);
    assert.throws(() => require('node:dns').lookup('example.invalid', () => {}), blocked);
    assert.throws(() => new (require('node:dns').Resolver)().resolve('example.invalid', () => {}), blocked);
    await assert.rejects(require('node:dns').promises.resolve('example.invalid'), blocked);
    await assert.rejects(new (require('node:dns').promises.Resolver)().resolve('example.invalid'), blocked);
    await assert.rejects(fetch('https://example.invalid'), blocked);
});

test('offline guard is inherited by Node integration subprocesses', () => {
    const result = spawnSync(process.execPath, ['-e', "require('node:https').get('https://example.invalid')"], {
        encoding: 'utf8'
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Network access is disabled in offline tests/);
});
