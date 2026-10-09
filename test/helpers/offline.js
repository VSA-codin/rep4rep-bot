'use strict';

const http = require('node:http');
const https = require('node:https');
const http2 = require('node:http2');
const net = require('node:net');
const tls = require('node:tls');
const dns = require('node:dns');
const dgram = require('node:dgram');
const { syncBuiltinESMExports } = require('node:module');

function blocked() {
    throw new Error('Network access is disabled in offline tests. Inject a mock client.');
}

for (const module of [http, https]) {
    module.request = blocked;
    module.get = blocked;
}
net.connect = blocked;
net.createConnection = blocked;
net.Socket.prototype.connect = blocked;
tls.connect = blocked;
http2.connect = blocked;
dgram.createSocket = blocked;
for (const name of Object.keys(dns)) {
    if (name === 'lookup' || name === 'lookupService' || name.startsWith('resolve') || name === 'reverse') {
        dns[name] = blocked;
    }
}
for (const name of Object.keys(dns.promises)) {
    if (name === 'lookup' || name === 'lookupService' || name.startsWith('resolve') || name === 'reverse') {
        dns.promises[name] = async () => blocked();
    }
}
for (const [Resolver, asynchronous] of [[dns.Resolver, false], [dns.promises.Resolver, true]]) {
    for (const name of Object.getOwnPropertyNames(Resolver.prototype)) {
        if (name.startsWith('resolve') || name === 'reverse') {
            Resolver.prototype[name] = asynchronous ? async () => blocked() : blocked;
        }
    }
}
globalThis.fetch = async () => blocked();
syncBuiltinESMExports();

// Keep the same guard when integration tests start another Node process.
const preload = `--require ${JSON.stringify(__filename)}`;
if (!(process.env.NODE_OPTIONS || '').includes(preload)) {
    process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, preload].filter(Boolean).join(' ');
}
