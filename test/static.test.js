import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { resolveStatic, buildSprite, ICONS, FONTS, VENDOR } from '../src/static.js';
import { tmpDir } from './helpers.js';

test('every icon, font and vendor file exists', () => {
  const sprite = buildSprite();
  for (const name of ICONS) assert.match(sprite, new RegExp(`<symbol id="${name}"`), name);
  for (const f of Object.values(FONTS)) assert.ok(fs.statSync(f).isFile(), f);
  for (const [url, f] of Object.entries(VENDOR)) assert.ok(fs.statSync(f).isFile(), `${url} -> ${f}`);
  for (const k of ['/vendor/leaflet/leaflet.js', '/vendor/leaflet/leaflet.css', '/vendor/leaflet/images/layers.png',
    '/vendor/geoman/leaflet-geoman.js', '/vendor/geoman/leaflet-geoman.css', '/vendor/apexcharts.js']) assert.ok(VENDOR[k], k);
});

test('resolveStatic refuses dot segments, encoded traversal, NUL and unknown types', () => {
  const root = tmpDir('static');
  try {
    fs.writeFileSync(path.join(root, 'a.js'), '');
    fs.mkdirSync(path.join(root, 'css'));
    fs.writeFileSync(path.join(root, 'css', 'b.css'), '');
    fs.writeFileSync(path.join(root, 'c.txt'), '');
    assert.equal(resolveStatic(root, '/a.js'), path.join(root, 'a.js'));
    assert.equal(resolveStatic(root, '/css/b.css'), path.join(root, 'css', 'b.css'));
    for (const bad of ['/../x.js', '/%2e%2e/x.js', '/.env', '/css/../a.js', '/c.txt', '/a.js%00', '/%E0%A4%A', '/missing.js']) {
      assert.equal(resolveStatic(root, bad), null, bad);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
