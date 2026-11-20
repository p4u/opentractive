import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ROUTES, PATHS, IN_SHEET } from '../public/js/routes.js';
import { geojsonToTractive, tractiveToGeojson, mixHex } from '../public/js/map.js';
import { relTime, countdown, metres } from '../public/js/format.js';
import { esc } from '../public/js/ui.js';
import { register } from '../public/js/i18n.js';
import core from '../public/js/i18n/core.js';

register(core); // app.js does this in the browser
const read = (p) => fs.readFileSync(new URL(`../public/${p}`, import.meta.url), 'utf8');
const VIEWS = ['live', 'history', 'escapes', 'fences', 'alerts', 'tracker', 'pet', 'telegram', 'lab'];

test('routes cover every view; the phone tabbar is Live, History, Escapes, Alerts, More', () => {
  assert.deepEqual(Object.values(ROUTES).sort(), [...VIEWS].sort());
  assert.equal(PATHS.live, '');
  const html = read('index.html');
  const tabbar = html.slice(html.indexOf('class="tabbar"'), html.indexOf('</nav>', html.indexOf('class="tabbar"')));
  const tabs = [...tabbar.matchAll(/data-route="(\w+)"|data-action="sheet"/g)].map((m) => m[1] ?? 'more');
  assert.deepEqual(tabs, ['live', 'history', 'escapes', 'alerts', 'more']);
  for (const v of ['fences', 'tracker', 'pet', 'telegram', 'lab']) assert.ok(IN_SHEET.has(v), v);
});

test('index.html links every view stylesheet, the vendor files and the banner', () => {
  const html = read('index.html');
  for (const v of VIEWS) assert.match(html, new RegExp(`href="/css/views/${v}\\.css"`), v);
  for (const s of ['/vendor/leaflet/leaflet.css', '/vendor/geoman/leaflet-geoman.css', '/vendor/leaflet/leaflet.js', '/vendor/geoman/leaflet-geoman.js', '/vendor/apexcharts.js', '/js/app.js', '/css/app.css']) assert.ok(html.includes(s), s);
  assert.match(html, /id="alert-banner"[^>]*data-testid="alert-banner"/);
});

test('every view module exports render and every t() key it uses exists', async () => {
  const core = (await import('../public/js/i18n/core.js')).default.en;
  for (const v of VIEWS) {
    const mod = await import(`../public/js/views/${v}.js`);
    assert.equal(typeof mod.render, 'function', v);
    const dict = (await import(`../public/js/i18n/${v}.js`)).default.en;
    assert.equal(typeof dict[`${v}.title`], 'string', `${v}.title`);
    for (const [, key] of read(`js/views/${v}.js`).matchAll(/\bt\('([A-Za-z0-9_.-]+)'/g)) assert.ok(key in dict || key in core, `${v}: missing ${key}`);
  }
  for (const [, key] of read('js/app.js').matchAll(/\bt\('([A-Za-z0-9_.-]+)'/g)) assert.ok(key in core, `app.js: missing ${key}`);
});

test('no hex colours in views or view css; no emoji in UI strings', () => {
  for (const v of VIEWS) {
    assert.doesNotMatch(read(`js/views/${v}.js`), /['"`]#[0-9a-fA-F]{3,8}['"`]/, `${v}.js`);
    assert.doesNotMatch(read(`css/views/${v}.css`), /:[^;{}]*#[0-9a-fA-F]{3,8}\b/, `${v}.css`);
  }
  const emoji = /\p{Extended_Pictographic}/u;
  for (const f of fs.readdirSync(new URL('../public/js/i18n/', import.meta.url))) assert.doesNotMatch(read(`js/i18n/${f}`), emoji, f);
  assert.doesNotMatch(read('index.html'), emoji);
});

test('map helpers swap GeoJSON [lng, lat] and Tractive [lat, lng]; colour mixing', () => {
  const ring = [[2.1, 41.1], [2.2, 41.1], [2.2, 41.2], [2.1, 41.1]];
  assert.deepEqual(geojsonToTractive(ring), [[41.1, 2.1], [41.1, 2.2], [41.2, 2.2]]);
  assert.deepEqual(tractiveToGeojson([[41.1, 2.1], [41.1, 2.2], [41.2, 2.2]]), ring);
  assert.equal(mixHex('#000000', '#ffffff', 0.5), '#808080');
  assert.equal(mixHex('#000000', '#ffffff', 0), '#000000');
});

test('format: relative times, countdowns, metres, escaping', () => {
  const now = Date.UTC(2026, 10, 20, 10);
  assert.equal(relTime(now - 30_000, now), 'just now');
  assert.equal(relTime(now - 120_000, now), '2 min ago');
  assert.equal(relTime(now - 3 * 3600_000, now), '3 h ago');
  assert.equal(relTime(now - 3 * 86400_000, now), '3 d ago');
  assert.equal(countdown(125), '2:05');
  assert.equal(countdown(-5), '0:00');
  assert.equal(metres(12.4), '12 m');
  assert.equal(metres(1520), '1.5 km');
  assert.equal(metres(null), 'unknown');
  assert.equal(esc('<a href="x">'), '&lt;a href=&quot;x&quot;&gt;');
});
