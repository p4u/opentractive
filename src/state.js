// Merged live state per tracker from channel tracker_status messages, REST tracker objects and command results.
import { EventEmitter } from 'node:events';

const LABELS = { OPERATIONAL: 'Reporting', NOT_REPORTING: 'Not reporting', OUT_OF_BATTERY: 'Out of battery', NO_SUBSCRIPTION: 'No subscription' };
const BLOCKS = { live_tracking: 'live', led_control: 'led', buzzer_control: 'buzzer', pos_request: 'posRequest' };
const CMD_SUFFIX = /_(live_tracking|led_control|buzzer_control|pos_request)$/;

export function stateLabel(state, reason) {
  if (state === 'NOT_REPORTING' && reason === 'SHUTDOWN_BY_USER') return 'Switched off by user';
  if (state === 'NOT_REPORTING') return 'Not reporting';
  if (reason === 'POWER_SAVING') return 'In Wi-Fi zone';
  if (state == null) return 'Unknown';
  if (LABELS[state]) return LABELS[state];
  const s = String(state).toLowerCase().replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function normalizePosition(p, { pszPins = [], nowS } = {}) {
  if (!p || typeof p !== 'object') return null;
  const t = p.time, ll = p.latlong;
  if (!Number.isFinite(t) || t > nowS + 300) return null;
  if (!Array.isArray(ll) || ll.length !== 2 || !Number.isFinite(ll[0]) || !Number.isFinite(ll[1])) return null;
  const [lat, lng] = ll;
  return {
    t, lat, lng,
    acc: p.accuracy ?? p.pos_uncertainty ?? null,
    sensor: p.sensor_used ?? null,
    alt: p.altitude ?? p.alt ?? null,
    speed: p.speed ?? null,
    course: p.course ?? null,
    pszId: p.power_saving_zone_id ?? pszPins.find((z) => z.lat === lat && z.lng === lng)?.id ?? null,
  };
}

export function positionRow(trackerId, pos, source) {
  return {
    tracker_id: trackerId, t: pos.t, lat: pos.lat, lng: pos.lng, acc: pos.acc, sensor: pos.sensor, alt: pos.alt,
    speed: pos.speed, course: pos.course, psz_id: pos.pszId, source,
  };
}

const control = () => ({ active: false, pending: false, remaining: 0, timeout: null, at: null });

function mergeControl(prev, block, atS, onOff) {
  const pending = !!block.pending;
  const remaining = block.remaining ?? 0;
  let active = pending ? prev.active : !!block.active;
  if (onOff && remaining === 0) active = false; // LED and buzzer report remaining 0 when off
  return { active, pending, remaining, timeout: block.timeout ?? prev.timeout, at: atS };
}

export class LiveState extends EventEmitter {
  constructor({ now = Date.now, pszPins = () => [], pszName = () => null } = {}) {
    super();
    this.now = now;
    this.pszPins = pszPins;
    this.pszName = pszName;
    this.trackers = new Map();
    this.channel = { connected: null, since: null, lastMessageAt: null };
  }

  nowS() { return Math.floor(this.now() / 1000); }

  ensure(id) {
    let st = this.trackers.get(id);
    if (!st) {
      st = {
        trackerId: id, state: null, stateReason: null, stateLabel: 'Unknown', battery: null, batteryState: null, charging: null,
        pszId: null, pszName: null, prioritizedZone: null, position: null,
        controls: { live: control(), led: control(), buzzer: control(), posRequest: control() },
        powerMode: null, liveTimeout: null, model: null, lastStatusAt: null, channel: { ...this.channel },
      };
      this.trackers.set(id, st);
    }
    return st;
  }

  // Runs fn on the state, recomputes derived fields, emits 'change' with the changed keys, then any position.
  update(id, fn) {
    const st = this.ensure(id);
    const prev = structuredClone(st);
    const pos = fn(st);
    st.stateLabel = stateLabel(st.state, st.stateReason);
    st.pszName = st.pszId ? this.pszName(st.pszId) ?? null : null;
    const keys = Object.keys(st).filter((k) => JSON.stringify(st[k]) !== JSON.stringify(prev[k]));
    if (keys.length) this.emit('change', id, st, keys, prev);
    if (pos) this.emit('position', id, pos);
  }

  applyStatus(msg) {
    const id = msg?.tracker_id;
    if (!id) return;
    const has = (k) => Object.hasOwn(msg, k);
    const nowS = this.nowS();
    this.update(id, (st) => {
      if (has('tracker_state')) st.state = msg.tracker_state;
      if (has('tracker_state_reason')) st.stateReason = msg.tracker_state_reason;
      if (has('charging_state')) st.charging = msg.charging_state;
      if (has('battery_state')) st.batteryState = msg.battery_state;
      if (has('prioritized_zone')) st.prioritizedZone = msg.prioritized_zone;
      const hw = msg.hardware;
      if (hw && Object.hasOwn(hw, 'battery_level')) st.battery = hw.battery_level;
      if (has('power_saving_zone_id')) st.pszId = msg.power_saving_zone_id;
      else if (hw && Object.hasOwn(hw, 'power_saving_zone_id')) st.pszId = hw.power_saving_zone_id;
      for (const [k, name] of Object.entries(BLOCKS)) {
        if (msg[k] && typeof msg[k] === 'object') st.controls[name] = mergeControl(st.controls[name], msg[k], nowS, name === 'led' || name === 'buzzer');
      }
      st.lastStatusAt = nowS;
      if (!has('position')) return null;
      const pos = normalizePosition(msg.position, { pszPins: this.pszPins(), nowS });
      if (!pos) { this.emit('drop', id, 'invalid position'); return null; }
      if (st.position && pos.t <= st.position.t) { this.emit('drop', id, 'not newer'); return null; }
      st.position = pos;
      return pos;
    });
  }

  applyTracker(obj) {
    const id = obj?._id;
    if (!id) return;
    this.update(id, (st) => {
      if (Object.hasOwn(obj, 'power_mode')) st.powerMode = obj.power_mode;
      if (Object.hasOwn(obj, 'custom_lt_timeout')) st.liveTimeout = obj.custom_lt_timeout;
      if (Object.hasOwn(obj, 'model_number')) st.model = obj.model_number;
      if (st.lastStatusAt !== null) return null; // the channel is authoritative once it has spoken
      const map = { state: 'state', state_reason: 'stateReason', charging_state: 'charging', battery_state: 'batteryState', power_saving_zone_id: 'pszId' };
      for (const [k, f] of Object.entries(map)) if (Object.hasOwn(obj, k)) st[f] = obj[k];
      return null;
    });
  }

  applyCommandStates(trackerId, list) {
    const nowS = this.nowS();
    this.update(trackerId, (st) => {
      for (const c of list ?? []) {
        const m = CMD_SUFFIX.exec(c?._id ?? '');
        if (!m) continue;
        const name = BLOCKS[m[1]];
        st.controls[name] = mergeControl(st.controls[name], c, nowS, name === 'led' || name === 'buzzer');
      }
      return null;
    });
  }

  applyCommandResult(trackerId, name, result) {
    const key = BLOCKS[name];
    if (!key || !result || typeof result !== 'object') return;
    const nowS = this.nowS();
    this.update(trackerId, (st) => {
      st.controls[key] = mergeControl(st.controls[key], result, nowS, key === 'led' || key === 'buzzer');
      return null;
    });
  }

  setChannel({ connected, since, lastMessageAt }) {
    this.channel = { connected, since, lastMessageAt };
    for (const id of this.trackers.keys()) this.update(id, (st) => { st.channel = { ...this.channel }; return null; });
  }

  get(id) { return this.trackers.get(id); }
  all() { return [...this.trackers.values()]; }
}
