import { register, t } from '../i18n.js';
import dict from '../i18n/history.js';
import { getPositions, getTracker, gpxUrl, backfill } from '../api.js';
import { fmtDate, fmtDateTime, metres, duration } from '../format.js';
import {
  esc, icon, ledger, emptyState, errorState, skeleton, confirmDialog, toast, apiErrorText, fieldError,
} from '../ui.js';
import { createMap, yardLayer, pszLayer, trailLayer, cssVar } from '../map.js';

register(dict);

const PRESETS = { '1h': 3600, '6h': 6 * 3600, '24h': 86400, '7d': 7 * 86400 };
const DAY = 86400;
const sensorWords = (s) => (/wifi/i.test(s ?? '') ? t('history.sensor.wifi') : s === 'GPS' ? t('history.sensor.gps') : (s ?? t('core.unknown')));
const localInput = (s) => new Date(s * 1000 - new Date(s * 1000).getTimezoneOffset() * 60000).toISOString().slice(0, 16);

function parseRange(params) {
  const r = params.get('r') ?? '24h';
  const to = Math.floor(Date.now() / 1000);
  if (PRESETS[r]) return { r, from: to - PRESETS[r], to };
  const from = Number(params.get('from')); const end = Number(params.get('to'));
  if (r === 'custom' && Number.isInteger(from) && Number.isInteger(end) && from > 0 && end > from) return { r, from, to: end };
  return { r: '24h', from: to - DAY, to };
}

export async function render(root, { state, params, setParams, signal }) {
  const range = parseRange(params);
  const tracker = state.trackers?.find((x) => x.followed) ?? state.trackers?.[0];
  const tid = tracker?.trackerId ?? tracker?.id;
  const days = Math.ceil((range.to - range.from) / DAY);
  const presets = Object.keys(PRESETS).map((k) => `<button type="button" data-r="${k}" aria-pressed="${range.r === k}">${esc(t(`history.range.${k}`))}</button>`).join('')
    + `<button type="button" data-r="custom" aria-pressed="${range.r === 'custom'}">${esc(t('history.range.custom'))}</button>`;
  root.innerHTML = `<header class="view-head"><h1 class="view-title">${esc(t('history.title'))}</h1></header>
    <div class="range-bar"><div class="segmented" role="group" aria-label="${esc(t('history.range.label'))}">${presets}</div>
      <form class="range-custom" data-custom${range.r === 'custom' ? '' : ' hidden'}>
        <div class="field"><label for="h-from">${esc(t('history.range.from'))}</label><input id="h-from" type="datetime-local" value="${localInput(range.from)}"></div>
        <div class="field"><label for="h-to">${esc(t('history.range.to'))}</label><input id="h-to" type="datetime-local" value="${localInput(range.to)}"></div>
        <button type="submit" class="pill pill-outline">${esc(t('history.range.show'))}</button></form></div>
    <div data-range-error></div><p class="hint" data-keeps></p>
    <div class="stack" data-body>${skeleton(320)}</div>`;
  const $ = (s) => root.querySelector(s);
  for (const b of root.querySelectorAll('[data-r]')) {
    b.addEventListener('click', () => (b.dataset.r === 'custom'
      ? setParams({ r: 'custom', from: range.from, to: range.to })
      : setParams({ r: b.dataset.r, from: null, to: null })));
  }
  $('[data-custom]').addEventListener('submit', (e) => {
    e.preventDefault();
    const from = Math.floor(new Date($('#h-from').value).getTime() / 1000); const to = Math.floor(new Date($('#h-to').value).getTime() / 1000);
    const err = !(from > 0 && to > from) ? t('history.range.bad') : to - from > 31 * DAY ? t('history.range.max') : '';
    $('[data-range-error]').innerHTML = err ? fieldError(err) : '';
    if (!err) setParams({ r: 'custom', from, to });
  });
  getTracker(tid).then((tr) => {
    if (!signal.aborted && tr?.range?.first != null) $('[data-keeps]').textContent = t('history.keeps', { date: fmtDate(tr.range.first * 1000) });
  }).catch(() => {});

  let map = null; let playTimer = null;
  const stop = () => { clearInterval(playTimer); playTimer = null; };

  async function load() {
    const body = $('[data-body]');
    body.innerHTML = skeleton(320);
    let r;
    try {
      const step = Math.max(0, Math.ceil((range.to - range.from) / 5000)) || undefined;
      r = await getPositions({ tracker: tid, from: range.from, to: range.to, step });
      r.step = step;
    } catch (err) {
      if (signal.aborted) return;
      body.innerHTML = `${errorState(t('core.error.load'))}<p class="hint">${esc(apiErrorText(err))}</p>`;
      body.querySelector('[data-retry]').addEventListener('click', load, { once: true });
      return;
    }
    if (signal.aborted) return;
    const pts = [...r.rows].reverse().filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
    const actions = `<div class="actions-row"><button type="button" class="pill pill-outline" data-testid="history-backfill">${icon('cloud-download', { size: 16 })}${esc(t('history.backfill'))}</button>
      <a class="pill pill-outline" data-testid="history-gpx" href="${esc(gpxUrl({ tracker: tid, from: range.from, to: range.to }))}" download>${icon('download', { size: 16 })}${esc(t('history.gpx'))}</a></div>`;
    if (!pts.length) {
      body.innerHTML = `${emptyState({ title: t('history.empty.title'), body: t('history.empty.body') })}${actions}`;
    } else if (!globalThis.L) {
      body.innerHTML = `${errorState(t('history.map.error'))}${actions}`;
      body.querySelector('[data-retry]').addEventListener('click', () => location.reload(), { once: true });
    } else {
      const s = r.stats ?? {};
      body.innerHTML = `<div class="map" data-testid="history-map"></div><p class="hint">${esc(t('history.legend'))}</p>
        <div data-testid="history-stats">${ledger([
          { icon: 'route', label: t('history.stats.distance'), value: metres(s.distanceM) },
          { icon: 'shield', label: t('history.stats.outside'), value: s.outsideS == null ? t('history.stats.noYard') : duration(s.outsideS * 1000) },
          { icon: 'map-pin', label: t('history.stats.fixes'), value: String(s.fixes ?? pts.length), hint: r.truncated ? t('history.stats.thinned', { step: r.step ?? '' }) : null },
        ])}</div>
        <div class="card playback"><button type="button" class="pill pill-primary" data-testid="history-play" aria-label="${esc(t('history.play'))}"></button>
          <input type="range" min="0" max="${pts.length - 1}" value="0" data-testid="history-slider" aria-label="${esc(t('history.slider'))}">
          <span class="play-label" data-label></span>
          <div class="segmented" role="group" aria-label="${esc(t('history.speed.label'))}">${[1, 5, 20].map((n) => `<button type="button" data-speed="${n}" aria-pressed="${n === 1}">${esc(t(`history.speed.${n}`))}</button>`).join('')}</div></div>
        ${actions}`;
      drawMap(body, pts);
    }
    $('[data-testid="history-backfill"]').addEventListener('click', async () => {
      if (days > 31) return void toast(t('history.range.max'));
      if (!(await confirmDialog({ title: t('history.backfill.title'), body: t('history.backfill.body', { n: days }), yes: t('history.backfill.yes'), no: t('history.backfill.no') }))) return;
      try {
        await backfill({ tracker: tid, from: range.from, to: range.to });
        toast(t('history.backfill.done', { n: days }));
      } catch (err) { toast(apiErrorText(err)); }
    });
  }

  function popup(p) {
    const el = document.createElement('div');
    const line = (text) => { const d = document.createElement('div'); d.textContent = text; el.append(d); };
    line(fmtDateTime(p.t * 1000));
    line(`${t('history.popup.acc', { n: Math.round(p.acc ?? 0) })} · ${sensorWords(p.sensor)}`);
    if (p.speed != null) line(t('history.popup.speed', { x: (p.speed * 3.6).toFixed(1) }));
    return el;
  }

  function drawMap(body, pts) {
    const L = globalThis.L;
    map?.remove();
    map = createMap($('[data-testid="history-map"]'), { center: [pts[0].lat, pts[0].lng] }).map;
    if (state.yard?.polygon) yardLayer(state.yard.polygon).addTo(map);
    pszLayer(state.psz ?? []).addTo(map);
    trailLayer(pts).addTo(map);
    const color = cssVar('--map-trail-gps');
    for (const p of pts) L.circleMarker([p.lat, p.lng], { radius: 3, color, fillColor: color, fillOpacity: 1, weight: 1 }).bindPopup(popup(p)).addTo(map);
    map.fitBounds(L.latLngBounds(pts.map((p) => [p.lat, p.lng])).pad(0.1));
    const dogColor = cssVar('--map-dog');
    const cursor = L.circleMarker([pts[0].lat, pts[0].lng], { radius: 7, color: cssVar('--map-halo'), fillColor: dogColor, fillOpacity: 1, weight: 2 }).addTo(map);
    const slider = $('[data-testid="history-slider"]'); const play = $('[data-testid="history-play"]'); const label = $('[data-label]');
    let speed = 1;
    const show = () => {
      const p = pts[Number(slider.value)];
      cursor.setLatLng([p.lat, p.lng]);
      label.textContent = fmtDateTime(p.t * 1000);
    };
    const paint = () => {
      const on = playTimer != null;
      play.innerHTML = `${icon(on ? 'pause' : 'play', { size: 16 })}${esc(t(on ? 'history.pause' : 'history.play'))}`;
      play.setAttribute('aria-label', t(on ? 'history.pause' : 'history.play'));
    };
    const tick = () => {
      if (Number(slider.value) >= pts.length - 1) { stop(); paint(); return; }
      slider.value = Number(slider.value) + 1;
      show();
    };
    const restart = () => { stop(); playTimer = setInterval(tick, 1000 / speed); };
    play.addEventListener('click', () => {
      if (playTimer) stop();
      else { if (Number(slider.value) >= pts.length - 1) slider.value = 0; restart(); }
      paint();
    });
    slider.addEventListener('input', show);
    for (const b of body.querySelectorAll('[data-speed]')) {
      b.addEventListener('click', () => {
        speed = Number(b.dataset.speed);
        for (const o of body.querySelectorAll('[data-speed]')) o.setAttribute('aria-pressed', String(o === b));
        if (playTimer) restart();
      });
    }
    paint(); show();
  }

  await load();
  return () => { stop(); map?.remove(); };
}
