import { register, t } from '../i18n.js';
import dict from '../i18n/live.js';
import {
  getPositions, getSettings, putSettings, sendCommand, setChase, setWalk, setPowerMode, setLiveTimeout, retryLogin,
} from '../api.js';
import { relTime, fmtTime, metres, countdown } from '../format.js';
import {
  esc, icon, ledger, statusLine, notice, emptyState, errorState, confirmDialog, every, toast, apiErrorText,
} from '../ui.js';
import { createMap, yardLayer, pszLayer, dogMarker, cssVar } from '../map.js';

register(dict);

const OFFLINE = new Set(['NOT_REPORTING', 'OUT_OF_BATTERY', 'SHUTDOWN_BY_USER']);
const TRAIL_S = 1800;
const SENT_MAX_MS = 15_000;
const sensorWords = (s) => (/wifi/i.test(s ?? '') ? t('live.sensor.wifi') : s === 'GPS' ? t('live.sensor.gps') : (s ?? t('core.unknown')));
const nowS = () => Math.floor(Date.now() / 1000);

export async function render(root, { state, signal, bus }) {
  const tracker = () => state.trackers?.find((x) => x.followed) ?? state.trackers?.[0] ?? null;
  root.innerHTML = `<header class="view-head"><h1 class="view-title">${esc(t('live.title'))}</h1><p class="hint" data-sub></p></header>
    <div data-login></div><div data-empty></div>
    <div class="split" data-main hidden>
      <div class="stack">
        <div data-status></div>
        <div class="map-wrap"><div class="map" data-testid="live-map"></div>
          <button type="button" class="pill pill-outline map-centre" data-centre>${icon('crosshair', { size: 16 })}${esc(t('live.map.centre'))}</button></div>
        <div data-psz></div>
        <div data-ledger></div>
      </div>
      <div class="card" data-controls-card><h2 class="card-title">${esc(t('live.controls'))}</h2><div data-controls></div></div>
    </div>`;
  const $ = (s) => root.querySelector(s);
  const settings = (await getSettings().catch(() => null))?.settings;
  let map = null; let dog = null; let layers = []; let trail = []; let trailLine = null; let mapDone = false;
  const busy = {}; // control name -> { phase: 'sending' | 'sent', want, at, error }
  let ctlText = {}; // per-control error text

  // ---- status ----
  function statusBlock() {
    const tr = tracker(); const m = state.monitor ?? {}; const fix = m.lastFix;
    const pszName = tr?.pszName ?? state.psz?.find((z) => z.id === tr?.pszId)?.name ?? '';
    const pos = tr?.position;
    const details = tr?.lastStatusAt == null && !pos ? [] : [[
      t('live.detail.lastFix', { when: relTime((pos?.t ?? tr.lastStatusAt) * 1000) }),
      pos?.acc != null ? t('live.detail.acc', { n: Math.round(pos.acc) }) : null,
      sensorWords(pos?.sensor),
    ].filter(Boolean).join(' · ')];
    let s;
    if (m.incident) {
      // a Wi-Fi zone pin (left_psz) has a meaningless signed distance: only a GPS fix outside or near the fence gives one
      s = { state: 'alarm', title: (fix?.cls === 'outside' || fix?.cls === 'uncertain') && fix.d != null ? t('live.status.outD', { d: metres(Math.abs(fix.d)) }) : t('live.status.outUnknown'), details };
    } else if (OFFLINE.has(tr?.state)) {
      s = { state: 'alarm', title: t('live.status.offline', { when: relTime(tr.lastStatusAt * 1000) }), details: [tr.stateLabel] };
    } else if (!state.yard) {
      s = { state: 'info', title: t('live.status.noYard'), details, link: { href: '#/fences', label: t('live.status.chooseYard') } };
    } else if (tr?.pszId && fix?.cls === 'psz') {
      s = { state: 'info', title: t('live.status.inPsz', { name: pszName }), details };
    } else if (fix?.cls === 'away') {
      s = { state: 'info', title: t('live.status.atPsz', { name: pszName }), details };
    } else if (fix?.cls === 'inside') {
      s = { state: 'ok', title: t('live.status.inside'), details };
    } else if (fix?.cls === 'uncertain') {
      s = { state: 'warn', title: t('live.status.uncertain', { d: metres(Math.abs(fix.d)) }), details };
    } else if (fix?.cls === 'outside') {
      s = { state: 'warn', title: t('live.status.walk', { d: metres(fix.d) }), details: [t('live.status.walkOn'), ...details] };
    } else s = { state: 'waiting', title: t('live.status.waiting'), details };
    return statusLine({ ...s, state: s.state });
  }
  function renderStatus() {
    const el = $('[data-status]');
    el.innerHTML = statusBlock();
    el.firstElementChild.dataset.testid = 'status-line';
  }

  function renderLedger() {
    const tr = tracker(); const pos = tr?.position;
    const bs = tr?.batteryState;
    const words = bs == null ? null : bs === 'REGULAR' ? t('live.battery.regular') : bs === 'LOW' ? t('live.battery.low') : String(bs).toLowerCase();
    const el = $('[data-ledger]');
    el.innerHTML = ledger([
      { icon: 'battery', label: t('live.ledger.battery'), value: tr?.battery != null ? `${Math.round(tr.battery)} %` : null, hint: words },
      { icon: 'zap', label: t('live.ledger.charging'), value: tr?.charging == null ? null : tr.charging === 'CHARGING' || tr.charging === true ? t('live.charging.yes') : t('live.charging.no') },
      { icon: 'clock', label: t('live.ledger.lastFix'), value: pos ? relTime(pos.t * 1000) : null, title: pos ? new Date(pos.t * 1000).toLocaleString() : undefined },
      { icon: 'target', label: t('live.ledger.accuracy'), value: pos?.acc != null ? `±${Math.round(pos.acc)} m` : null },
      { icon: 'satellite', label: t('live.ledger.sensor'), value: pos ? sensorWords(pos.sensor) : null },
      { icon: state.channel?.connected ? 'circle-check' : 'wifi-off', label: t('live.ledger.connection'), value: state.channel?.connected ? t('live.conn.ok') : t('live.conn.down') },
    ]);
    el.firstElementChild.dataset.testid = 'live-ledger';
  }

  function renderPsz() {
    const names = (state.psz ?? []).filter((z) => z.coversYard).map((z) => z.name);
    $('[data-psz]').innerHTML = names.length
      ? notice(t('live.psz.advice', { names: names.join(', ') }), { testid: 'psz-advice' })
      : '';
  }

  // ---- controls ----
  const ctl = () => tracker()?.controls ?? {};
  const wantOf = (name, actual) => (busy[name]?.want ?? actual);
  function stateText(name, actual, pending) {
    const b = busy[name];
    if (ctlText[name]) return ctlText[name];
    if (b?.phase === 'sending') return t('live.sending');
    if (b?.phase === 'sent' || pending) return t('live.sent');
    return actual ? t('live.on') : t('live.off');
  }
  const row = ({ name, label, hint, control, status, statusId, stack, sub }) => `<div class="control-row${stack ? ' control-stack' : ''}${sub ? ' control-sub' : ''}" data-row="${esc(name)}">
      <div><p class="control-label">${esc(label)}</p><p class="hint">${esc(hint)}</p></div>${control}
      ${status != null ? `<p class="control-status"${statusId ? ` data-testid="${statusId}"` : ''}>${esc(status)}</p>` : ''}</div>`;
  const sw = (name, id, label, checked, disabled) => `<input type="checkbox" role="switch" class="switch" data-sw="${name}" data-testid="${id}" aria-label="${esc(label)}"${checked ? ' checked' : ''}${disabled ? ' disabled' : ''}>`;

  function liveStatusText() {
    const tr = tracker(); const c = ctl().live ?? {};
    if (tr?.pszId) return t('live.live.psz');
    if (ctlText.live) return ctlText.live;
    if (busy.live?.phase === 'sending') return t('live.sending');
    if (busy.live?.phase === 'sent' || c.pending) return t('live.sent');
    if (c.active && c.remaining > 0) return t('live.live.on', { left: countdown(c.remaining - (nowS() - (c.at ?? nowS()))) });
    return state.monitor?.live?.manual || c.active ? t('live.on') : t('live.live.off');
  }

  // a pending position request gives up client-side at + timeout + 15 s; a fix newer than the request ends it
  function locateText() {
    const p = ctl().posRequest ?? {}; const pos = tracker()?.position;
    if (ctlText.locate) return ctlText.locate;
    if (busy.locate?.phase === 'sending') return t('live.sending');
    if (!p.pending || (p.at != null && pos?.t >= p.at)) return t('live.locate.idle');
    return p.at != null && nowS() > p.at + (p.timeout ?? 30) + 15 ? t('live.locate.gaveUp') : t('live.locate.pending');
  }

  function renderControls() {
    const tr = tracker(); if (!tr) return;
    const c = ctl(); const m = state.monitor ?? {}; const st = state.settings ?? {};
    const keep = document.activeElement?.dataset?.testid && root.contains(document.activeElement) ? document.activeElement.dataset.testid : null;
    const sending = (n) => busy[n]?.phase === 'sending';
    const coverNames = (state.psz ?? []).filter((z) => z.coversYard);
    const ywStatus = m.yardWatch?.status ?? 'off';
    const ywOn = !!st.yardWatchEnabled;
    const ywText = ctlText.yw ?? (sending('yw') ? t('live.sending') : t(`live.yw.${ywStatus}`, { n: settings?.yardWatch?.minBattery ?? 35 }));
    const walk = m.walk;
    const power = tr.powerMode;
    const rows = [
      row({ name: 'live', label: t('live.live.label'), hint: t('live.live.hint'), control: sw('live', 'live-toggle', t('live.live.label'), wantOf('live', !!(m.live?.manual || c.live?.active)), sending('live') || !!tr.pszId), status: liveStatusText(), statusId: 'live-status' }),
      row({ name: 'locate', label: t('live.locate.label'), hint: t('live.locate.hint'), control: `<button type="button" class="pill pill-outline" data-locate data-testid="locate-btn"${sending('locate') ? ' disabled' : ''}>${icon('locate-fixed', { size: 16 })}${esc(t('live.locate.btn'))}</button>`, status: locateText(), statusId: 'locate-status' }),
      row({ name: 'led', label: t('live.led.label'), hint: t('live.led.hint'), control: sw('led', 'led-toggle', t('live.led.label'), wantOf('led', !!c.led?.active), sending('led')), status: stateText('led', c.led?.active, c.led?.pending) }),
      row({ name: 'buzzer', label: t('live.buzzer.label'), hint: t('live.buzzer.hint'), control: sw('buzzer', 'buzzer-toggle', t('live.buzzer.label'), wantOf('buzzer', !!c.buzzer?.active), sending('buzzer')), status: stateText('buzzer', c.buzzer?.active, c.buzzer?.pending) }),
      row({ name: 'chase', label: t('live.chase.label'), hint: t('live.chase.hint'), control: sw('chase', 'chase-toggle', t('live.chase.label'), wantOf('chase', !!m.chase), sending('chase')), status: ctlText.chase ?? (sending('chase') ? t('live.sending') : m.chase ? t('live.chase.since', { time: fmtTime(m.chase.since * 1000) }) : t('live.off')) }),
      row({
        name: 'yw', label: t('live.yw.label'), hint: t('live.yw.hint'),
        control: sw('yw', 'yardwatch-toggle', t('live.yw.label'), wantOf('yw', ywOn), sending('yw') || coverNames.length > 0),
        status: coverNames.length ? t('live.yw.blind', { n: coverNames.length, names: coverNames.map((z) => z.name).join(', ') }) : ywText,
      }),
      tr.liveTimeout != null && tr.liveTimeout < 3600
        ? row({ name: 'yw-dur', label: t('live.yw.durLabel'), hint: t('live.yw.durHint'), stack: true, sub: true, control: `<button type="button" class="pill pill-outline" data-yw-dur>${esc(t('live.yw.duration'))}</button>` }) : '',
      row({ name: 'power', label: t('live.power.label'), hint: t('live.power.hint'), stack: true, control: `<div class="segmented" role="group" aria-label="${esc(t('live.power.label'))}" data-testid="power-mode">${['LOW', 'BALANCED', 'PRECISION'].map((p) => `<button type="button" data-power="${p}" aria-pressed="${power === p}"${sending('power') ? ' disabled' : ''}>${esc(t(`live.power.${p}`))}</button>`).join('')}</div>`, status: ctlText.power ?? (sending('power') ? t('live.sending') : null) }),
      row({ name: 'timeout', label: t('live.timeout.label'), hint: t('live.timeout.hint'), control: `<select class="input" data-timeout data-testid="live-timeout" aria-label="${esc(t('live.timeout.label'))}"${sending('timeout') ? ' disabled' : ''}>${[300, 900, 1800, 3600].map((s) => `<option value="${s}"${tr.liveTimeout === s ? ' selected' : ''}>${esc(t(`live.timeout.${s}`))}</option>`).join('')}</select>`, status: ctlText.timeout ?? (sending('timeout') ? t('live.sending') : null) }),
      row({
        name: 'walk', label: t('live.walk.label'), hint: t('live.walk.hint'), stack: true,
        control: `<div class="actions-row">${[['60', 'walk-60'], ['120', 'walk-120'], ['until', 'walk-until']].map(([k, id]) => `<button type="button" class="pill pill-outline" data-walk="${k}" data-testid="${id}">${esc(t(`live.walk.${k}`))}</button>`).join('')}</div>`,
        status: ctlText.walk ?? null,
      }),
      walk ? `<div class="control-row walk-on"><p class="control-status" data-testid="walk-status">${icon('footprints', { size: 16 })} ${esc(t('live.walk.on', { time: fmtTime(walk.until * 1000) }))}</p><button type="button" class="pill pill-primary" data-walk-end data-testid="walk-end">${esc(t('live.walk.end'))}</button></div>` : '',
    ];
    $('[data-controls]').innerHTML = rows.join('');
    if (keep) $(`[data-testid="${keep}"]`)?.focus();
  }

  // run an action for control `name`: disabled and "Sending…" until the HTTP reply, then "Sent…" until the tracker confirms
  async function act(name, want, fn, { confirmed = false } = {}) {
    busy[name] = { phase: 'sending', want, at: Date.now() };
    delete ctlText[name];
    renderControls();
    try {
      await fn();
      if (confirmed) delete busy[name];
      else busy[name] = { phase: 'sent', want, at: Date.now() };
    } catch (err) {
      delete busy[name];
      ctlText[name] = apiErrorText(err);
    }
    renderControls();
  }
  // a control is confirmed once the tracker reports no pending command, or after SENT_MAX_MS
  function settle() {
    const c = ctl();
    for (const [name, b] of Object.entries(busy)) {
      if (b?.phase !== 'sent') continue;
      const blk = c[name === 'live' ? 'live' : name];
      const actual = name === 'live' ? !!(state.monitor?.live?.manual || blk?.active) : blk?.active;
      if (Date.now() - b.at > SENT_MAX_MS || (blk && !blk.pending && actual === b.want)) delete busy[name];
    }
  }

  const tid = () => tracker()?.trackerId ?? tracker()?.id;
  const ctlEl = $('[data-controls]');
  ctlEl.addEventListener('change', async (e) => {
    const el = e.target; const name = el.dataset.sw; const on = el.checked;
    if (name === 'live') return act('live', on, () => sendCommand(tid(), 'live', on));
    if (name === 'led') return act('led', on, () => sendCommand(tid(), 'led', on));
    if (name === 'buzzer') {
      if (on && !(await confirmDialog({ title: t('live.buzzer.title'), body: t('live.buzzer.body'), yes: t('live.buzzer.yes'), no: t('live.cancel') }))) { el.checked = false; return; }
      return act('buzzer', on, () => sendCommand(tid(), 'buzzer', on));
    }
    if (name === 'chase') {
      if (on && !(await confirmDialog({ title: t('live.chase.title'), body: t('live.chase.body', { h: settings?.chase?.maxHours ?? 6 }), yes: t('live.chase.yes'), no: t('live.cancel') }))) { el.checked = false; return; }
      return act('chase', on, async () => { state.monitor = await setChase(on); }, { confirmed: true });
    }
    if (name === 'yw') {
      if (on && !(await confirmDialog({ title: t('live.yw.title'), body: t('live.yw.body'), yes: t('live.yw.yes'), no: t('live.cancel') }))) { el.checked = false; return; }
      return act('yw', on, async () => {
        const cur = (await getSettings()).settings;
        cur.yardWatch.enabled = on;
        const saved = (await putSettings(cur)).settings;
        state.settings = { ...state.settings, yardWatchEnabled: !!saved.yardWatch.enabled };
      }, { confirmed: true });
    }
    if (el.matches('[data-timeout]')) return act('timeout', null, () => setLiveTimeout(tid(), Number(el.value)), { confirmed: true });
  });
  ctlEl.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.matches('[data-locate]')) act('locate', true, () => sendCommand(tid(), 'pos_request', true), { confirmed: true });
    else if (b.dataset.power) act('power', null, () => setPowerMode(tid(), b.dataset.power), { confirmed: true });
    else if (b.matches('[data-yw-dur]')) act('timeout', null, () => setLiveTimeout(tid(), 3600), { confirmed: true });
    else if (b.dataset.walk) act('walk', null, async () => { state.monitor = await setWalk(b.dataset.walk === 'until' ? 720 : Number(b.dataset.walk)); }, { confirmed: true });
    else if (b.matches('[data-walk-end]')) act('walk', null, async () => { state.monitor = await setWalk(null); }, { confirmed: true });
  });

  // ---- map ----
  function drawLayers() {
    for (const l of layers) l.remove();
    layers = [];
    if (state.yard?.polygon) layers.push(yardLayer(state.yard.polygon).addTo(map));
    layers.push(pszLayer(state.psz ?? []).addTo(map));
    trailLine?.remove();
    trailLine = globalThis.L.polyline(trail.map((p) => [p.lat, p.lng]), { color: cssVar('--map-trail-gps'), weight: 3 }).addTo(map);
  }
  function updateDog() {
    const pos = tracker()?.position;
    if (!map || !pos) return;
    if (!dog) { dog = dogMarker(pos).addTo(map); if (!mapDone) { map.setView([pos.lat, pos.lng], 19); mapDone = true; } } else dog.update(pos);
  }
  function addTrail(p) {
    if (trail.some((x) => x.t === p.t)) return;
    trail.push(p);
    trail = trail.filter((x) => x.t >= nowS() - TRAIL_S).sort((a, b) => a.t - b.t);
    trailLine?.setLatLngs(trail.map((x) => [x.lat, x.lng]));
  }
  async function setupMap() {
    const el = $('[data-testid="live-map"]');
    if (!globalThis.L) { el.outerHTML = errorState(t('live.map.error')); $('.map-centre').hidden = true; $('[data-main] [data-retry]')?.addEventListener('click', () => location.reload()); return; }
    const pos = tracker()?.position;
    const poly = state.yard?.polygon;
    const centre = pos ? [pos.lat, pos.lng] : poly?.length ? [poly.reduce((a, p) => a + p[0], 0) / poly.length, poly.reduce((a, p) => a + p[1], 0) / poly.length] : [41, 2];
    map = createMap(el, { center: centre, zoom: pos || poly ? 19 : 3 }).map;
    mapDone = !!(pos || poly);
    try {
      const r = await getPositions({ tracker: tid(), from: nowS() - TRAIL_S, to: nowS() });
      if (signal.aborted) return;
      trail = [...r.rows].reverse();
    } catch { trail = []; }
    drawLayers();
    updateDog();
    $('[data-centre]').addEventListener('click', () => { const p = tracker()?.position; if (p) map.setView([p.lat, p.lng], Math.max(map.getZoom(), 18)); });
  }

  // ---- header, login, empty state ----
  function renderHead() {
    const tr = tracker();
    $('[data-sub]').textContent = tr ? t('live.subtitle', { pet: tr.petName ?? '', model: tr.model ?? '' }).replace(/^ · | · $/g, '') : '';
    const login = state.tractive?.login;
    $('[data-login]').innerHTML = login === 'bad-credentials'
      ? `${statusLine({ state: 'alarm', title: t('live.login.bad') })}<p><button type="button" class="pill pill-outline" data-retry-login>${esc(t('live.login.retry'))}</button></p>`
      : login === 'login-retrying' ? statusLine({ state: 'warn', title: t('live.login.retrying') }) : '';
  }
  $('[data-login]').addEventListener('click', async (e) => {
    if (!e.target.closest('[data-retry-login]')) return;
    try { await retryLogin(); } catch (err) { toast(apiErrorText(err)); }
  });

  let ready = false;
  async function refresh() {
    renderHead();
    if (!tracker()) {
      $('[data-empty]').innerHTML = emptyState({ title: t('live.noTracker.title'), body: t('live.noTracker.body') });
      return;
    }
    $('[data-empty]').innerHTML = '';
    $('[data-main]').hidden = false;
    if (!ready) { ready = true; await setupMap(); }
    settle();
    renderStatus(); renderLedger(); renderPsz(); renderControls();
  }

  const onState = () => { if (!ready) return refresh(); renderHead(); settle(); renderStatus(); renderLedger(); renderPsz(); renderControls(); updateDog(); };
  const onPos = (e) => {
    const p = e.detail?.pos;
    if (p && ready && (e.detail.trackerId == null || e.detail.trackerId === tid())) addTrail(p);
    queueMicrotask(() => { if (ready) { renderStatus(); renderLedger(); updateDog(); } });
  };
  const onAlert = () => { if (ready) renderStatus(); };
  const onTheme = () => { if (map) drawLayers(); };
  bus.addEventListener('state', onState);
  bus.addEventListener('position', onPos);
  bus.addEventListener('alert', onAlert);
  document.addEventListener('themechange', onTheme);
  every(1000, () => {
    if (!ready) return;
    renderStatus();
    const el = $('[data-testid="live-status"]'); if (el) el.textContent = liveStatusText();
    const loc = $('[data-testid="locate-status"]'); if (loc) loc.textContent = locateText();
    settle();
  }, signal);
  await refresh();
  return () => {
    bus.removeEventListener('state', onState);
    bus.removeEventListener('position', onPos);
    bus.removeEventListener('alert', onAlert);
    document.removeEventListener('themechange', onTheme);
    map?.remove();
  };
}
