import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../src/store.js';
import { tmpDir, TID } from './helpers.js';

const pos = (t, extra = {}) => ({ tracker_id: TID, t, lat: 41, lng: 2, acc: 5, sensor: 'GPS', alt: null, speed: null, course: null, psz_id: null, source: 'channel', ...extra });

test('creates schema v1 in a file with mode 600 and refuses another version', () => {
  const dir = tmpDir('store');
  try {
    const file = path.join(dir, 'opentractive.db');
    const s = new Store(file);
    assert.equal(s.getKv('schema'), 1);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    s.close();
    const again = new Store(file);
    assert.equal(again.getKv('schema'), 1);
    again.setKv('schema', 2);
    again.close();
    assert.throws(() => new Store(file), /unsupported schema version 2/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('kv round-trips JSON and deletes', () => {
  const s = new Store(':memory:');
  assert.equal(s.getKv('x'), null);
  s.setKv('x', { a: [1, 2] });
  assert.deepEqual(s.getKv('x'), { a: [1, 2] });
  s.delKv('x');
  assert.equal(s.getKv('x'), null);
});

test('insertPosition fills only NULL columns on conflict', () => {
  const s = new Store(':memory:');
  s.insertPosition(pos(100, { acc: null, alt: 120 }));
  s.insertPosition(pos(100, { lat: 50, acc: 7, alt: 999, speed: 3 }));
  const [row] = s.positions(TID, 0, 200).rows;
  assert.equal(row.lat, 41);
  assert.equal(row.acc, 7);
  assert.equal(row.alt, 120);
  assert.equal(row.speed, 3);
});

test('S2: a synthetic zone row never changes a real fix, and a real fix at the same second replaces it', () => {
  const s = new Store(':memory:');
  const zone = (t) => pos(t, { lat: 42, lng: 3, acc: 30, sensor: 'KNOWN_WIFI', psz_id: 'z1', source: 'zone' });
  s.insertPosition(pos(100));
  s.insertPosition(zone(100));
  assert.deepEqual(s.positionsAsc(TID, 0, 300).map((r) => [r.t, r.lat, r.sensor, r.psz_id, r.source]), [[100, 41, 'GPS', null, 'channel']]);
  s.insertPosition(zone(200));
  s.insertPosition(pos(200, { alt: 5 }));
  assert.deepEqual(s.positionsAsc(TID, 0, 300).map((r) => [r.t, r.lat, r.sensor, r.psz_id, r.source]),
    [[100, 41, 'GPS', null, 'channel'], [200, 41, 'GPS', null, 'channel']]);
});

test('positions: newest first, step decimation, limit with truncated, ascending helper, last position', () => {
  const s = new Store(':memory:');
  assert.equal(s.insertPositions(Array.from({ length: 100 }, (_, i) => pos(1000 + i * 10))), 100); // t = 1000..1990
  const all = s.positions(TID, 1000, 1990);
  assert.equal(all.rows.length, 100);
  assert.equal(all.truncated, false);
  assert.equal(all.rows[0].t, 1990);
  const stepped = s.positions(TID, 1000, 1990, { step: 60 }); // buckets floor(t/60) = 16..33
  assert.equal(stepped.rows.length, 18);
  assert.equal(stepped.rows[0].t, 1980);
  assert.equal(stepped.rows.at(-1).t, 1000);
  const cut = s.positions(TID, 1000, 1990, { limit: 30 });
  assert.equal(cut.rows.length, 30);
  assert.equal(cut.truncated, true);
  assert.equal(cut.rows[0].t, 1990);
  assert.deepEqual(s.positionsAsc(TID, 1000, 1100).map((r) => r.t), Array.from({ length: 11 }, (_, i) => 1000 + i * 10));
  assert.equal(s.lastPosition(TID).t, 1990);
  assert.equal(s.lastPosition('ZZZ00000'), null);
  assert.equal(s.positions('ZZZ00000', 0, 5000).rows.length, 0);
});

test('alerts: insert, update, parsed data, open incident, pending repeats, lookups, paging', () => {
  const s = new Store(':memory:');
  const id = s.insertAlert({ t: 100, tracker_id: TID, kind: 'out_possible', severity: 'warn', title: 'A', body: 'b', data: { d: 15 }, incident: 1 });
  assert.equal(typeof id, 'number');
  assert.deepEqual(s.alert(id).data, { d: 15 });
  assert.equal(s.openIncident(TID).id, id);
  s.updateAlert(id, { severity: 'critical', kind: 'out_confirmed', data: { d: 40 }, last_sent_at: 110 });
  assert.equal(s.alert(id).severity, 'critical');
  assert.deepEqual(s.alert(id).data, { d: 40 });
  assert.deepEqual(s.pendingRepeats().map((a) => a.id), [id]);
  s.updateAlert(id, { acked_at: 120, acked_by: 'web' });
  assert.deepEqual(s.pendingRepeats(), []);
  s.updateAlert(id, { closed_at: 130, closed_by: 'home' });
  assert.equal(s.openIncident(TID), null);
  const b = s.insertAlert({ t: 200, tracker_id: TID, kind: 'battery_low', severity: 'warn', title: 'B' });
  assert.equal(s.lastAlertOfKind(TID, 'battery_low').id, b);
  assert.equal(s.lastAlertOfKind(TID, 'nothing'), null);
  assert.equal(s.countAlertsSince('battery_low', 150), 1);
  assert.deepEqual(s.alerts({ limit: 1 }).map((a) => a.id), [b]);
  assert.deepEqual(s.alerts({ before: b, limit: 10 }).map((a) => a.id), [id]);
  assert.equal(s.alert(9999), null);
  assert.throws(() => s.updateAlert(id, { bogus: 1 }), /unknown alert column/);
});

test('escapes: unique by t_outside, update, delete only rows without note or dismissal', () => {
  const s = new Store(':memory:');
  const a = s.insertEscape({ tracker_id: TID, t_inside: 90, t_outside: 100 });
  assert.equal(s.insertEscape({ tracker_id: TID, t_inside: 95, t_outside: 100 }), a);
  const b = s.insertEscape({ tracker_id: TID, t_inside: 190, t_outside: 200, note: 'walk', dismissed: 1 });
  const c = s.insertEscape({ tracker_id: TID, t_inside: 290, t_outside: 300 });
  s.updateEscape(c, { note: 'by the gate' });
  const d = s.insertEscape({ tracker_id: TID, t_inside: 390, t_outside: 400 });
  assert.deepEqual(s.escapes(TID, 0, 1000).map((e) => e.id), [a, b, c, d]);
  assert.deepEqual(s.escapes(TID, 150, 350).map((e) => e.id), [b, c]);
  assert.equal(s.deleteEscapes([a, b, c, d]), 2);
  assert.deepEqual(s.escapes(TID, 0, 1000).map((e) => e.id), [b, c]);
  assert.equal(s.escape(c).note, 'by the gate');
  assert.equal(s.escape(a), null);
  assert.throws(() => s.updateEscape(c, { t_outside: 5 }), /unknown escape column/);
});

test('commands log keeps JSON params and truncates results to 2000 chars', () => {
  const s = new Store(':memory:');
  s.logCommand({ t: 1, actor: 'web', action: 'command:led_control', params: { on: true }, ok: true, result: 'x'.repeat(5000) });
  s.logCommand({ t: 2, actor: 'auto:live', action: 'command:live_tracking', params: { on: false }, ok: false, result: { status: 500 } });
  const [last, first] = s.commands(10);
  assert.deepEqual(first.params, { on: true });
  assert.equal(first.ok, 1);
  assert.equal(first.result.length, 2000);
  assert.equal(last.result, '{"status":500}');
  assert.equal(last.ok, 0);
});

test('raw objects keep the latest per kind', () => {
  const s = new Store(':memory:', { now: () => 5_000 });
  s.setRaw('tracker:TRK00001', { a: 1 });
  s.setRaw('tracker:TRK00001', { a: 2 });
  assert.deepEqual(s.getRaw('tracker:TRK00001'), { a: 2 });
  assert.equal(s.getRaw('nope'), null);
  assert.deepEqual(s.rawAll(), [{ kind: 'tracker:TRK00001', t: 5, json: { a: 2 } }]);
});

test('channel_log is capped at 2000 rows, newest first, filterable by message', () => {
  const s = new Store(':memory:');
  for (let i = 0; i < 2010; i++) s.logChannel(i, i % 2 ? 'tracker_status' : 'graph_sync', { i });
  const rows = s.channelLog(5000);
  assert.equal(rows.length, 2000);
  assert.equal(rows[0].json.i, 2009);
  const sync = s.channelLog(10, 'graph_sync');
  assert.equal(sync.length, 10);
  assert.ok(sync.every((r) => r.message === 'graph_sync'));
});

test('known_fields: addField reports the first sighting only', () => {
  const s = new Store(':memory:');
  assert.equal(s.knownFieldCount('tracker'), 0);
  assert.equal(s.addField('tracker', 'a.b', 10), true);
  assert.equal(s.addField('tracker', 'a.b', 11), false);
  assert.equal(s.knownFieldCount('tracker'), 1);
  assert.deepEqual(s.fields(), [{ kind: 'tracker', path: 'a.b', first_seen: 10 }]);
});

test('telegram chats and first alert message per chat', () => {
  const s = new Store(':memory:');
  s.upsertChat({ chat_id: '1001', name: 'Ann', approved_at: 50 });
  s.upsertChat({ chat_id: '1001', name: 'Ann B', approved_at: 60 });
  assert.deepEqual(s.chat('1001'), { chat_id: '1001', name: 'Ann B', approved_at: 50, muted_until: null, mute_all: 0, min_severity: 'info' });
  s.updateChat('1001', { min_severity: 'critical', muted_until: 99, mute_all: 1 });
  assert.equal(s.chat('1001').min_severity, 'critical');
  assert.equal(s.chats().length, 1);
  s.setAlertMessage(7, '1001', 555);
  s.setAlertMessage(7, '1001', 556);
  assert.deepEqual(s.alertMessages(7), [{ chat_id: '1001', message_id: 555 }]);
  s.deleteChat('1001');
  assert.equal(s.chat('1001'), null);
  assert.throws(() => s.updateChat('1001', { name: 'x' }), /unknown chat column/);
});

test('thinPositions keeps the first thinnable row per minute before the cutoff', () => {
  const s = new Store(':memory:');
  s.insertPositions(Array.from({ length: 12 }, (_, i) => pos(6000 + i * 10))); // minutes 100 (6000-6050) and 101 (6060-6110)
  s.insertPositions([pos(9000)]);
  const deleted = s.thinPositions(TID, 8000, (row) => row.t !== 6050);
  assert.equal(deleted, 9);
  assert.deepEqual(s.positionsAsc(TID, 0, 10000).map((r) => r.t), [6000, 6050, 6060, 9000]);
});

test('healthCheck throws once the database is closed', () => {
  const s = new Store(':memory:');
  assert.equal(s.healthCheck(), true);
  s.close();
  assert.throws(() => s.healthCheck());
});
