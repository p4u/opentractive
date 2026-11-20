// SQLite store (schema v1): positions, hardware samples, alerts, escapes, command log, raw objects, channel log,
// known fields, Telegram chats/messages and a kv table. Every time is integer unix seconds.
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS positions(tracker_id TEXT NOT NULL, t INTEGER NOT NULL, lat REAL, lng REAL, acc REAL, sensor TEXT,
  alt REAL, speed REAL, course REAL, psz_id TEXT, source TEXT, PRIMARY KEY(tracker_id, t));
CREATE TABLE IF NOT EXISTS hw(tracker_id TEXT NOT NULL, t INTEGER NOT NULL, battery INTEGER, charging TEXT, psz_id TEXT, PRIMARY KEY(tracker_id, t));
CREATE TABLE IF NOT EXISTS alerts(id INTEGER PRIMARY KEY, t INTEGER NOT NULL, tracker_id TEXT, kind TEXT NOT NULL,
  severity TEXT NOT NULL CHECK(severity IN ('info','warn','critical')), title TEXT NOT NULL, body TEXT, data TEXT,
  acked_at INTEGER, acked_by TEXT, incident INTEGER NOT NULL DEFAULT 0, sent_count INTEGER NOT NULL DEFAULT 0,
  last_sent_at INTEGER, closed_at INTEGER, closed_by TEXT);
CREATE INDEX IF NOT EXISTS alerts_kind ON alerts(tracker_id, kind, t);
CREATE TABLE IF NOT EXISTS escapes(id INTEGER PRIMARY KEY, tracker_id TEXT NOT NULL, t_inside INTEGER, t_outside INTEGER NOT NULL,
  note TEXT, dismissed INTEGER NOT NULL DEFAULT 0, UNIQUE(tracker_id, t_outside));
CREATE TABLE IF NOT EXISTS commands(id INTEGER PRIMARY KEY, t INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL,
  params TEXT, ok INTEGER, result TEXT);
CREATE TABLE IF NOT EXISTS raw(kind TEXT PRIMARY KEY, t INTEGER NOT NULL, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS channel_log(id INTEGER PRIMARY KEY, t INTEGER NOT NULL, message TEXT, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS known_fields(kind TEXT NOT NULL, path TEXT NOT NULL, first_seen INTEGER NOT NULL, PRIMARY KEY(kind, path));
CREATE TABLE IF NOT EXISTS telegram_chats(chat_id TEXT PRIMARY KEY, name TEXT, approved_at INTEGER, muted_until INTEGER,
  mute_all INTEGER NOT NULL DEFAULT 0, min_severity TEXT NOT NULL DEFAULT 'info');
CREATE TABLE IF NOT EXISTS telegram_messages(alert_id INTEGER NOT NULL, chat_id TEXT NOT NULL, message_id INTEGER NOT NULL,
  PRIMARY KEY(alert_id, chat_id));
CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, json TEXT NOT NULL);
`;

const POS_COLS = ['tracker_id', 't', 'lat', 'lng', 'acc', 'sensor', 'alt', 'speed', 'course', 'psz_id', 'source'];
const ALERT_COLS = new Set(['kind', 'severity', 'title', 'body', 'data', 'acked_at', 'acked_by', 'sent_count', 'last_sent_at', 'closed_at', 'closed_by']);
const CHAT_COLS = new Set(['min_severity', 'muted_until', 'mute_all']);
const ESCAPE_COLS = new Set(['note', 'dismissed']);
const JSON_COLS = ['data', 'params', 'json'];

const plain = (row) => {
  if (!row) return null;
  const o = { ...row };
  for (const c of JSON_COLS) if (typeof o[c] === 'string') o[c] = JSON.parse(o[c]);
  return o;
};
const nz = (v) => v ?? null;

export class Store {
  constructor(file = ':memory:', { now = Date.now } = {}) {
    this.now = now;
    const isFile = file !== ':memory:';
    if (isFile) {
      fs.writeFileSync(file, '', { flag: 'a', mode: 0o600 });
      fs.chmodSync(file, 0o600);
    }
    this.db = new DatabaseSync(file);
    this.db.exec(`${isFile ? 'PRAGMA journal_mode = WAL; ' : ''}PRAGMA busy_timeout = 5000;`);
    this.db.exec(SCHEMA);
    const v = this.getKv('schema');
    if (v == null) this.setKv('schema', 1);
    else if (v !== 1) {
      this.db.close();
      throw new Error(`unsupported schema version ${v}`);
    }
  }

  q(sql) { return this.db.prepare(sql); }
  all(sql, ...a) { return this.q(sql).all(...a).map(plain); }
  get(sql, ...a) { return plain(this.q(sql).get(...a)); }
  run(sql, ...a) { return this.q(sql).run(...a); }
  tx(fn) {
    this.db.exec('BEGIN');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // kv
  getKv(key) {
    const r = this.q('SELECT json FROM kv WHERE key=?').get(key);
    return r ? JSON.parse(r.json) : null;
  }
  setKv(key, value) { this.run('INSERT INTO kv(key,json) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET json=excluded.json', key, JSON.stringify(value)); }
  delKv(key) { this.run('DELETE FROM kv WHERE key=?', key); }

  // positions
  // A synthetic 'zone' row never changes a stored fix, and a real fix at the same second replaces it.
  insertPosition(row) {
    if (row.source === 'zone') {
      return Number(this.run(`INSERT INTO positions(${POS_COLS.join(',')}) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`, ...POS_COLS.map((c) => nz(row[c]))).changes);
    }
    this.run("DELETE FROM positions WHERE tracker_id=? AND t=? AND source='zone'", row.tracker_id, row.t);
    return Number(this.run(
      `INSERT INTO positions(${POS_COLS.join(',')}) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(tracker_id,t) DO UPDATE SET
       lat=COALESCE(positions.lat,excluded.lat), lng=COALESCE(positions.lng,excluded.lng), acc=COALESCE(positions.acc,excluded.acc),
       sensor=COALESCE(positions.sensor,excluded.sensor), alt=COALESCE(positions.alt,excluded.alt), speed=COALESCE(positions.speed,excluded.speed),
       course=COALESCE(positions.course,excluded.course), psz_id=COALESCE(positions.psz_id,excluded.psz_id), source=COALESCE(positions.source,excluded.source)`,
      ...POS_COLS.map((c) => nz(row[c])),
    ).changes);
  }
  insertPositions(rows) {
    return this.tx(() => { for (const r of rows) this.insertPosition(r); return rows.length; });
  }
  positions(trackerId, from, to, { step, limit = 50000 } = {}) {
    const rows = step
      ? this.all(`SELECT tracker_id, MIN(positions.t) AS t, lat, lng, acc, sensor, alt, speed, course, psz_id, source FROM positions
          WHERE tracker_id=? AND positions.t BETWEEN ? AND ? GROUP BY positions.t / CAST(? AS INTEGER) ORDER BY t DESC LIMIT ?`,
      trackerId, from, to, step, limit + 1)
      : this.all('SELECT * FROM positions WHERE tracker_id=? AND t BETWEEN ? AND ? ORDER BY t DESC LIMIT ?', trackerId, from, to, limit + 1);
    const truncated = rows.length > limit;
    if (truncated) rows.pop();
    return { rows, truncated };
  }
  positionsAsc(trackerId, from, to, limit = 200000) {
    return this.all('SELECT * FROM positions WHERE tracker_id=? AND t BETWEEN ? AND ? ORDER BY t LIMIT ?', trackerId, from, to, limit);
  }
  lastPosition(trackerId) { return this.get('SELECT * FROM positions WHERE tracker_id=? ORDER BY t DESC LIMIT 1', trackerId); }
  thinPositions(trackerId, beforeT, thinnable) {
    const rows = this.all('SELECT * FROM positions WHERE tracker_id=? AND t < ? ORDER BY t', trackerId, beforeT);
    const seen = new Set();
    const del = [];
    for (const r of rows) {
      if (!thinnable(r)) continue;
      const m = Math.floor(r.t / 60);
      if (seen.has(m)) del.push(r.t);
      else seen.add(m);
    }
    this.tx(() => { for (const t of del) this.run('DELETE FROM positions WHERE tracker_id=? AND t=?', trackerId, t); });
    return del.length;
  }

  insertHw(r) {
    this.run('INSERT INTO hw(tracker_id,t,battery,charging,psz_id) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING',
      r.tracker_id, r.t, nz(r.battery), nz(r.charging), nz(r.psz_id));
  }

  // alerts
  insertAlert({ t, tracker_id, kind, severity, title, body = null, data = null, incident = 0 }) {
    return Number(this.run('INSERT INTO alerts(t,tracker_id,kind,severity,title,body,data,incident) VALUES(?,?,?,?,?,?,?,?)',
      t, nz(tracker_id), kind, severity, title, body, data == null ? null : JSON.stringify(data), incident).lastInsertRowid);
  }
  updateAlert(id, patch) {
    const keys = Object.keys(patch);
    for (const k of keys) if (!ALERT_COLS.has(k)) throw new Error(`unknown alert column ${k}`);
    if (!keys.length) return;
    this.run(`UPDATE alerts SET ${keys.map((k) => `${k}=?`).join(',')} WHERE id=?`, ...keys.map((k) => (k === 'data' && patch[k] != null ? JSON.stringify(patch[k]) : nz(patch[k]))), id);
  }
  alert(id) { return this.get('SELECT * FROM alerts WHERE id=?', id); }
  alerts({ before, limit = 50 } = {}) {
    return this.all('SELECT * FROM alerts WHERE (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?', nz(before), nz(before), limit);
  }
  openIncident(trackerId) {
    return this.get('SELECT * FROM alerts WHERE tracker_id=? AND incident=1 AND closed_at IS NULL ORDER BY id DESC LIMIT 1', trackerId);
  }
  pendingRepeats() { return this.all("SELECT * FROM alerts WHERE severity='critical' AND acked_at IS NULL AND closed_at IS NULL ORDER BY id"); }
  unackedCritical() { return this.pendingRepeats(); }
  lastAlertOfKind(trackerId, kind) { return this.get('SELECT * FROM alerts WHERE tracker_id=? AND kind=? ORDER BY id DESC LIMIT 1', trackerId, kind); }
  countAlertsSince(kind, t) { return Number(this.q('SELECT COUNT(*) AS n FROM alerts WHERE kind=? AND t >= ?').get(kind, t).n); }

  // escapes
  insertEscape({ tracker_id, t_inside, t_outside, note = null, dismissed = 0 }) {
    this.run('INSERT INTO escapes(tracker_id,t_inside,t_outside,note,dismissed) VALUES(?,?,?,?,?) ON CONFLICT(tracker_id,t_outside) DO NOTHING',
      tracker_id, nz(t_inside), t_outside, note, dismissed);
    return this.q('SELECT id FROM escapes WHERE tracker_id=? AND t_outside=?').get(tracker_id, t_outside).id;
  }
  escape(id) { return this.get('SELECT * FROM escapes WHERE id=?', id); }
  escapes(trackerId, from, to) {
    return this.all('SELECT * FROM escapes WHERE tracker_id=? AND t_outside BETWEEN ? AND ? ORDER BY t_outside', trackerId, from, to);
  }
  updateEscape(id, patch) {
    const keys = Object.keys(patch);
    for (const k of keys) if (!ESCAPE_COLS.has(k)) throw new Error(`unknown escape column ${k}`);
    if (!keys.length) return;
    this.run(`UPDATE escapes SET ${keys.map((k) => `${k}=?`).join(',')} WHERE id=?`, ...keys.map((k) => nz(patch[k])), id);
  }
  deleteEscapes(ids) {
    return this.tx(() => ids.reduce((n, id) => n + Number(this.run("DELETE FROM escapes WHERE id=? AND (note IS NULL OR note='') AND dismissed=0", id).changes), 0));
  }

  // command log
  logCommand({ t, actor, action, params = null, ok, result = null }) {
    const res = result == null ? null : (typeof result === 'string' ? result : JSON.stringify(result)).slice(0, 2000);
    return Number(this.run('INSERT INTO commands(t,actor,action,params,ok,result) VALUES(?,?,?,?,?,?)',
      t, actor, action, params == null ? null : JSON.stringify(params), ok ? 1 : 0, res).lastInsertRowid);
  }
  commands(limit = 100) { return this.all('SELECT * FROM commands ORDER BY id DESC LIMIT ?', limit); }

  // raw objects and channel log
  setRaw(kind, obj) {
    this.run('INSERT INTO raw(kind,t,json) VALUES(?,?,?) ON CONFLICT(kind) DO UPDATE SET t=excluded.t, json=excluded.json',
      kind, Math.floor(this.now() / 1000), JSON.stringify(obj));
  }
  getRaw(kind) { return this.get('SELECT json FROM raw WHERE kind=?', kind)?.json ?? null; }
  rawAll() { return this.all('SELECT kind, t, json FROM raw ORDER BY kind'); }
  logChannel(t, message, obj) {
    this.run('INSERT INTO channel_log(t,message,json) VALUES(?,?,?)', t, nz(message), JSON.stringify(obj));
    this.run('DELETE FROM channel_log WHERE id <= (SELECT id FROM channel_log ORDER BY id DESC LIMIT 1 OFFSET 2000)');
  }
  channelLog(limit = 200, message) {
    return message == null
      ? this.all('SELECT id,t,message,json FROM channel_log ORDER BY id DESC LIMIT ?', limit)
      : this.all('SELECT id,t,message,json FROM channel_log WHERE message=? ORDER BY id DESC LIMIT ?', message, limit);
  }

  // known fields
  knownFieldCount(kind) { return Number(this.q('SELECT COUNT(*) AS n FROM known_fields WHERE kind=?').get(kind).n); }
  addField(kind, path, t) { return this.run('INSERT OR IGNORE INTO known_fields(kind,path,first_seen) VALUES(?,?,?)', kind, path, t).changes === 1; }
  fields() { return this.all('SELECT kind,path,first_seen FROM known_fields ORDER BY first_seen DESC, kind, path'); }

  // telegram
  chats() { return this.all('SELECT * FROM telegram_chats ORDER BY chat_id'); }
  chat(id) { return this.get('SELECT * FROM telegram_chats WHERE chat_id=?', id); }
  upsertChat({ chat_id, name, approved_at }) {
    this.run(`INSERT INTO telegram_chats(chat_id,name,approved_at) VALUES(?,?,?) ON CONFLICT(chat_id) DO UPDATE SET
      name=excluded.name, approved_at=COALESCE(telegram_chats.approved_at, excluded.approved_at)`, chat_id, nz(name), nz(approved_at));
  }
  updateChat(id, patch) {
    const keys = Object.keys(patch);
    for (const k of keys) if (!CHAT_COLS.has(k)) throw new Error(`unknown chat column ${k}`);
    if (!keys.length) return;
    this.run(`UPDATE telegram_chats SET ${keys.map((k) => `${k}=?`).join(',')} WHERE chat_id=?`, ...keys.map((k) => nz(patch[k])), id);
  }
  deleteChat(id) {
    this.tx(() => {
      this.run('DELETE FROM telegram_messages WHERE chat_id=?', id);
      this.run('DELETE FROM telegram_chats WHERE chat_id=?', id);
    });
  }
  setAlertMessage(alertId, chatId, messageId) { this.run('INSERT OR IGNORE INTO telegram_messages(alert_id,chat_id,message_id) VALUES(?,?,?)', alertId, chatId, messageId); }
  alertMessages(alertId) { return this.all('SELECT chat_id, message_id FROM telegram_messages WHERE alert_id=? ORDER BY chat_id', alertId); }

  healthCheck() { this.q('SELECT 1').get(); return true; }
  close() { this.db.close(); }
}
