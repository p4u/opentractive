// compares the mock fixtures with the shapes of the real probe (data/probe, written by scripts/probe.mjs).
// Prints key paths only, never values.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

export function flatten(value) {
  const out = new Map();
  const walk = (v, p) => {
    const t = typeOf(v);
    if (p !== '') (out.get(p) ?? out.set(p, new Set()).get(p)).add(t);
    if (t === 'array') v.forEach((x) => walk(x, `${p}[]`));
    else if (t === 'object') for (const [k, x] of Object.entries(v)) walk(x, p ? `${p}.${k}` : k);
  };
  walk(value, '');
  return out;
}

export function compare(probe, fixture) {
  const fx = flatten(fixture);
  const problems = [];
  for (const [p, types] of flatten(probe)) {
    const have = fx.get(p);
    if (!have) { problems.push({ kind: 'MISSING', path: p }); continue; }
    const missing = [...types].find((t) => t !== 'null' && !have.has(t));
    if (missing) problems.push({ kind: 'TYPE', path: p, probe: missing, fixture: [...have].join('|') });
  }
  return problems.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

const RULES = [
  [/^auth$/, 'auth'], [/^(user|user-me)$/, 'user'],
  [/^user-trackers$/, 'user-trackers'], [/^user-trackable-objects$/, 'user-trackable-objects'], [/^user-subscriptions$/, 'user-subscriptions'],
  [/^tracker-/, 'tracker'], [/^hw-report-/, 'hw-report'], [/^pos-report-/, 'pos-report'],
  [/^geofences-bulk-/, 'geofences-bulk'], [/^geofences-/, 'geofences'],
  [/^power-saving-zones-/, 'power-saving-zones'], [/^power-saving-zone-/, 'power-saving-zone', true],
  [/^command-states-/, 'command-states'], [/^positions-range-/, 'positions-range'], [/^positions-6h-/, 'positions'],
  [/^public-shares-/, 'public-shares'], [/^event-notification-reachable-/, 'event-notification-reachable'],
  [/^pet$/, 'pet'], [/^weight-activity-history$/, 'weight-activity-history'], [/^health-overview$/, 'health-overview'],
  [/^timeline$/, 'timeline'], [/^config-all$/, 'config-all'], [/^subscription-/, 'subscription'], [/^channel$/, 'channel'],
];
const SKIP = new Set(['pull-notifications', 'push-notification-settings', 'user-shares']);

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const probeDir = path.join(root, 'data', 'probe');
  if (!fs.existsSync(probeDir)) {
    console.error('data/probe not found: run this on the host that ran scripts/probe.mjs');
    process.exit(2);
  }
  const load = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
  const fixture = (n) => load(path.join(root, 'test', 'mock', 'fixtures', `${n}.json`));
  const files = fs.readdirSync(probeDir).filter((f) => f.endsWith('.json')).sort();
  const lines = [];
  const report = (file, target, ps) => ps.forEach((p) => lines.push(
    `${file} -> ${target}: ${p.kind === 'TYPE' ? `TYPE ${p.path} probe=${p.probe} fixture=${p.fixture}` : `${p.kind} ${p.path}`}`,
  ));
  for (const file of files) {
    const name = file.slice(0, -5);
    let probe;
    try { probe = load(path.join(probeDir, file)); } catch { lines.push(`${file} -> ?: UNPARSEABLE`); continue; }
    if (probe.status !== 200 || probe.data == null) continue;
    if (SKIP.has(name)) { console.log(`SKIP ${name}`); continue; }
    const rule = RULES.find(([re]) => re.test(name));
    if (!rule) { lines.push(`${file} -> ?: UNMAPPED ${name}`); continue; }
    const [, target, wrap] = rule;
    if (target === 'channel') {
      const fx = fixture('channel');
      const seen = new Set();
      for (const { msg } of probe.data) {
        if (seen.has(msg?.message)) continue;
        seen.add(msg?.message);
        const f = fx.find((x) => x.message === msg?.message);
        if (f) report(file, `channel[${msg.message}]`, compare(msg, f));
        else lines.push(`${file} -> channel: UNMAPPED message ${msg?.message}`);
      }
    } else report(file, target, compare(wrap ? [probe.data] : probe.data, fixture(target)));
  }
  lines.forEach((l) => console.log(l));
  console.log(`check-fixtures: ${files.length} probe files, ${lines.length} problems`);
  process.exit(lines.length ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
