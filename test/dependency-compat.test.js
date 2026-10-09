'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('request');
const SteamCommunity = require('steamcommunity');

test('patched cookie jar preserves request synchronous cookie operations', () => {
    const jar = request.jar();
    const url = 'https://steamcommunity.com/profiles/76561198000000001';
    jar.setCookie(request.cookie('sessionid=offline-session; Path=/; Secure; HttpOnly'), url);
    assert.equal(jar.getCookieString(url), 'sessionid=offline-session');
    assert.equal(jar.getCookieString('http://steamcommunity.com/'), '');
    assert.equal(jar.getCookieString('https://example.invalid/'), '');
    const cookie = jar.getCookies(url)[0];
    assert.equal(cookie.key, 'sessionid');
    assert.equal(cookie.httpOnly, true);
    assert.equal(cookie.clone().value, 'offline-session');
});

test('a prototype-shaped cookie domain cannot pollute unrelated objects', () => {
    const jar = request.jar();
    assert.equal(Object.hasOwn(Object.prototype, '/'), false);
    jar.setCookie('r4rOfflinePollution=synthetic; Domain=__proto__; Path=/', 'https://__proto__/');
    assert.equal(Object.hasOwn(Object.prototype, '/'), false);
    assert.equal(jar.getCookieString('https://example.invalid/'), '');
    assert.equal(jar.getCookieString('https://__proto__/'), 'r4rOfflinePollution=synthetic');
});

test('SteamCommunity restores synthetic cookies independently for each account', () => {
    const first = new SteamCommunity();
    const second = new SteamCommunity();
    first.setCookies(['sessionid=offline-first', 'steamLoginSecure=76561198000000001%7C%7Coffline-token']);
    second.setCookies(['sessionid=offline-second', 'steamLoginSecure=76561198000000002%7C%7Coffline-token']);

    assert.equal(first.getSessionID(), 'offline-first');
    assert.equal(second.getSessionID(), 'offline-second');
    assert.equal(first.steamID.getSteamID64(), '76561198000000001');
    assert.equal(second.steamID.getSteamID64(), '76561198000000002');
    for (const host of ['steamcommunity.com', 'store.steampowered.com', 'help.steampowered.com']) {
        assert.match(first._jar.getCookieString(`https://${host}/`), /sessionid=offline-first/);
        assert.doesNotMatch(first._jar.getCookieString(`https://${host}/`), /offline-second/);
        assert.doesNotMatch(first._jar.getCookieString(`http://${host}/`), /steamLoginSecure/);
    }
});
