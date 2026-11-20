// Read-only discovery of the Tractive API with the account in .env.
// Raw responses go to data/probe/<name>.json (gitignored: they hold locations); the console shows only shapes.
// usage: node scripts/probe.mjs [--channel SECONDS]
import fs from 'node:fs';

process.loadEnvFile('.env');
const { TRACTIVE_EMAIL: email, TRACTIVE_PASSWORD: password } = process.env;
const CLIENT = '625e533dc3c3b41c28a669f0';
const GRAPH = 'https://graph.tractive.com/4';
const APS = 'https://aps-api.tractive.com/api/1';
const TIMELINE = 'https://prod.eu-central-1.event-timeline-api.tractive.com/api/1';
const OUT = 'data/probe';
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Shape of a JSON value: keys and types, arrays summarised by their first element. Coordinates are hidden.
function shape(v, depth = 0) {
  if (Array.isArray(v)) return v.length ? [shape(v[0], depth + 1), `…${v.length}`] : [];
  if (v && typeof v === 'object') {
    if (depth > 4) return '{…}';
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, /latlong|coords|home_location|token/.test(k) ? '<hidden>' : shape(x, depth + 1)]));
  }
  if (typeof v === 'string') return /^[A-Z_]+$/.test(v) ? v : 'str';
  return v === null ? null : typeof v;
}

let headers = { 'x-tractive-client': CLIENT, 'content-type': 'application/json;charset=UTF-8', accept: 'application/json' };

const DELAY = Number(process.env.PROBE_DELAY_MS || 8000);
// Re-runs skip responses already saved with 200, so a run cut short by 429s can be resumed.
async function call(name, url, { method = 'GET', body, quiet = false } = {}) {
  const saved = `${OUT}/${name}.json`;
  if (name !== 'auth' && fs.existsSync(saved)) {
    const prev = JSON.parse(fs.readFileSync(saved, 'utf8'));
    if (prev.status === 200) return { status: 200, data: prev.data };
  }
  await sleep(DELAY);
  const res = await fetch(url, { method, headers, body: body && JSON.stringify(body) });
  const text = await res.text();
  let data = text;
  try { data = JSON.parse(text); } catch {}
  fs.writeFileSync(`${OUT}/${name}.json`, JSON.stringify({ url, status: res.status, data }, null, 2));
  if (!quiet) console.log(`\n## ${name}  ${method} ${url.replace(GRAPH, '').replace(/[A-Z0-9]{8}/g, '{tracker}')}  -> ${res.status}\n${JSON.stringify(shape(data))}`);
  return { status: res.status, data };
}

const auth = await call('auth', `${GRAPH}/auth/token`, { method: 'POST', body: { platform_email: email, platform_token: password, grant_type: 'tractive' }, quiet: true });
if (auth.status !== 200) throw new Error(`auth failed: ${auth.status}`);
const uid = auth.data.user_id;
headers = { ...headers, 'x-tractive-user': uid, authorization: `Bearer ${auth.data.access_token}` };
console.log(`auth ok, expires in ${Math.round((auth.data.expires_at - Date.now() / 1000) / 3600)} h`);

await call('user', `${GRAPH}/user/${uid}`);
await call('user-me', `${GRAPH}/user/me`);
const trackers = (await call('user-trackers', `${GRAPH}/user/${uid}/trackers`)).data;
const pets = (await call('user-trackable-objects', `${GRAPH}/user/${uid}/trackable_objects`)).data;
const subs = (await call('user-subscriptions', `${GRAPH}/user/${uid}/subscriptions`)).data;
await call('user-shares', `${GRAPH}/user/${uid}/shares`);
await call('push-notification-settings', `${GRAPH}/user/push_notification_settings?language=en`);
await call('pull-notifications', `${GRAPH}/pull-notifications?language=en`);
await call('config-all', `${GRAPH}/config/all`);

for (const s of Array.isArray(subs) ? subs : []) await call(`subscription-${s._id}`, `${GRAPH}/subscription/${s._id}`);

for (const t of Array.isArray(trackers) ? trackers : []) {
  const id = t._id;
  const tracker = (await call(`tracker-${id}`, `${GRAPH}/tracker/${id}`)).data;
  await call(`hw-report-${id}`, `${GRAPH}/device_hw_report/${id}/`);
  await call(`pos-report-${id}`, `${GRAPH}/device_pos_report/${id}`);
  const fences = (await call(`geofences-${id}`, `${GRAPH}/tracker/${id}/geofences`)).data;
  if (Array.isArray(fences) && fences.length) await call(`geofences-bulk-${id}`, `${GRAPH}/bulk?partial=1`, { method: 'POST', body: fences.map((f) => ({ _type: 'geofence', _id: f._id })) });
  const psz = await call(`power-saving-zones-${id}`, `${GRAPH}/tracker/${id}/power_saving_zones`);
  const pszIds = new Set([tracker?.power_saving_zone_id, ...(Array.isArray(psz.data) ? psz.data.map((z) => z._id) : [])].filter(Boolean));
  for (const z of pszIds) await call(`power-saving-zone-${z}`, `${GRAPH}/power_saving_zone/${z}`);
  await call(`command-states-${id}`, `${GRAPH}/bulk?partial=1`, { method: 'POST', body: ['live_tracking', 'led_control', 'buzzer_control', 'pos_request'].map((c) => ({ _type: 'tracker_command_state', _id: `${id.toLowerCase()}_${c}` })) });
  const range = (await call(`positions-range-${id}`, `${GRAPH}/tracker/${id}/positions/range`)).data;
  const to = Math.floor(Date.now() / 1000);
  await call(`positions-6h-${id}`, `${GRAPH}/tracker/${id}/positions?time_from=${to - 6 * 3600}&time_to=${to}&format=json_segments`);
  await call(`public-shares-${id}`, `${GRAPH}/tracker/${id}/public_shares`);
  await call(`event-notification-reachable-${id}`, `${GRAPH}/tracker/${id}/event_notification/tracker_reachable_again`);
  if (range?.first) console.log(`history range: ${new Date(range.first * 1000).toISOString()} .. ${new Date(range.last * 1000).toISOString()}`);
}

for (const p of Array.isArray(pets) ? pets : []) {
  const id = p._id;
  await call('pet', `${GRAPH}/trackable_object/${id}`);
  await call('weight-activity-history', `${GRAPH}/weight_activity_history/${id}`);
  await call('health-overview', `${APS}/pet/${id}/health/overview`);
  const types = ['walk', 'dailyActivityGoalReached', 'safezoneEnter', 'safezoneExit', 'dangerzoneEnter', 'dangerzoneExit', 'insidePowerSavingZone', 'territory', 'birthday'];
  await call('timeline', `${TIMELINE}/events?petId=${id}&timezone=${process.env.TZ || 'UTC'}&${types.map((x) => `types=${x}`).join('&')}`);
}

const secs = Number(process.argv[process.argv.indexOf('--channel') + 1]) || 0;
if (process.argv.includes('--channel') && secs > 0) {
  console.log(`\n## channel: listening ${secs}s`);
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), secs * 1000);
  const lines = [];
  try {
    const res = await fetch('https://channel.tractive.com/3/channel', { method: 'POST', headers, signal: ctrl.signal });
    console.log(`channel status ${res.status}`);
    const dec = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        lines.push({ at: new Date().toISOString(), msg });
        console.log(`${new Date().toISOString()} ${msg.message} ${JSON.stringify(shape(msg))}`);
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') throw e;
  }
  fs.writeFileSync(`${OUT}/channel.json`, JSON.stringify(lines, null, 2));
}
