import { register, t } from '../i18n.js';
import dict from '../i18n/escapes.js';
import { getEscapes, recomputeEscapes, patchEscape } from '../api.js';
import { esc, icon, emptyState, notice, loadBlock, toast, apiErrorText } from '../ui.js';
import { fmtDateTime, relTime, metres } from '../format.js';
import { createMap, mixHex, cssVar } from '../map.js';

register(dict);

const RANGES = [7, 30, 90];
const QUALITY = { good: 'circle-check', fair: 'info', poor: 'triangle-alert', none: 'circle-alert' };
const times = (n) => t(n === 1 ? 'escapes.time.one' : 'escapes.time.other');
// a truncated recompute changed nothing: say so instead of "0 added, 0 removed"
export const recomputeText = (res) => (res?.truncated ? t('escapes.truncated')
  : t('escapes.recomputed', { inserted: res?.inserted ?? 0, deleted: res?.deleted ?? 0 }));

// Leaflet renders string content as HTML: popups and tooltips get a DOM node of text lines instead.
const lines = (list) => {
  const div = document.createElement('div');
  list.forEach((l, i) => { if (i) div.append(document.createElement('br')); div.append(document.createTextNode(l)); });
  return div;
};

export async function render(root, ctx) {
  const { state, params, signal } = ctx;
  const tracker = state.followed;
  const r = RANGES.includes(Number(params.get('r'))) ? Number(params.get('r')) : 30;
  root.innerHTML = `<header class="view-head"><h1 class="view-title">${esc(t('escapes.title'))}</h1></header>
    <div class="escapes-bar"><div class="segmented" role="group" aria-label="${esc(t('escapes.range'))}">${RANGES.map((d) =>
    `<button type="button" data-range="${d}" aria-pressed="${d === r}">${esc(t(`escapes.range.${d}`))}</button>`).join('')}</div>
      <button type="button" class="pill pill-outline" data-testid="escapes-recompute">${icon('refresh-cw', { size: 16 })}${esc(t('escapes.recompute'))}</button>
      <p class="hint">${esc(t('escapes.recompute.hint'))}</p></div>
    <div class="band" data-body></div>`;
  const body = root.querySelector('[data-body]');
  let map = null;
  const range = () => { const to = Math.floor(Date.now() / 1000) + 60; return { tracker, from: to - r * 86400, to }; };
  const destroy = () => { map?.remove(); map = null; };

  root.querySelector('.segmented').addEventListener('click', (e) => {
    const b = e.target.closest('[data-range]');
    if (b) ctx.setParams({ r: b.dataset.range });
  });
  root.querySelector('[data-testid="escapes-recompute"]').addEventListener('click', async (e) => {
    const b = e.currentTarget; // null after the first await
    b.disabled = true;
    try {
      const res = await recomputeEscapes(range());
      toast(recomputeText(res));
      await load();
    } catch (err) {
      toast(apiErrorText(err));
    } finally {
      b.disabled = false;
    }
  });

  const load = () => loadBlock(body, 560, async (el) => {
    destroy();
    const data = await getEscapes(range());
    if (signal.aborted) return;
    if (!data.yard) {
      el.innerHTML = emptyState({ title: t('escapes.noYard.title'), body: t('escapes.noYard.body'), action: { label: t('escapes.noYard.action'), href: '#/fences' } });
      root.querySelector('.escapes-bar').hidden = true;
      return;
    }
    root.querySelector('.escapes-bar').hidden = false;
    const eps = [...data.episodes].reverse();
    el.innerHTML = `${data.blind.length ? `<div data-testid="blind-notice">${notice(
      t(data.blind.length === 1 ? 'escapes.blind.one' : 'escapes.blind', { n: data.blind.length, names: data.blind.map((z) => z.name).join(', ') }),
    )}</div>` : ''}
      <section class="card"><div class="map" data-testid="escapes-map"></div><p class="hint">${esc(t('escapes.map'))}</p></section>
      <section class="card" data-testid="escapes-peaks"><div class="card-head"><h2 class="card-title">${esc(t('escapes.peaks.title'))}</h2></div>
        ${data.peaks.length ? `<ul class="peak-list">${data.peaks.map((p, i) => `<li><span>${esc(t('escapes.peak', { n: i + 1, count: p.count, times: times(p.count), width: p.widthM }))}</span>
          <button type="button" class="pill pill-outline" data-peak="${i}">${icon('target', { size: 16 })}${esc(t('escapes.peak.show'))}</button></li>`).join('')}</ul>`
    : `<p class="hint">${esc(t('escapes.peaks.none'))}</p>`}</section>
      <section class="card"><div class="card-head"><h2 class="card-title">${esc(t('escapes.table.title'))}</h2></div>
        ${eps.length ? `<div class="table-scroll"><table class="table" data-testid="escapes-table"><thead><tr>${['time', 'gap', 'quality', 'distance', 'note', 'dismiss']
          .map((c) => `<th scope="col">${esc(t(`escapes.col.${c}`))}</th>`).join('')}</tr></thead><tbody>${eps.map((e) => {
          const when = fmtDateTime(e.t_outside * 1000);
          const col = (c) => `data-label="${esc(t(`escapes.col.${c}`))}"`; // the label each cell shows when rows stack as cards
          return `<tr class="escape-row${e.dismissed ? ' muted' : ''}" data-testid="escape-row" data-id="${esc(e.id)}">
            <td class="escape-time" ${col('time')} title="${esc(relTime(e.t_outside * 1000))}">${esc(when)}</td>
            <td ${col('gap')}>${e.gap_s == null ? '' : esc(t('escapes.gap', { n: e.gap_s }))}</td>
            <td ${col('quality')}><span class="badge escape-q">${icon(QUALITY[e.quality], { size: 16 })}${esc(t(`escapes.q.${e.quality}`))}</span></td>
            <td ${col('distance')}>${e.distance_m == null ? '' : esc(t('escapes.outside', { distance: metres(e.distance_m) }))}</td>
            <td class="escape-note" ${col('note')}><input type="text" class="input" maxlength="200" data-note value="${esc(e.note ?? '')}" aria-label="${esc(t('escapes.note', { time: when }))}"></td>
            <td ${col('dismiss')}><input type="checkbox" class="switch" data-dismiss${e.dismissed ? ' checked' : ''} aria-label="${esc(t('escapes.dismiss', { time: when }))}"></td></tr>`;
        }).join('')}</tbody></table></div>` : emptyState({ title: t('escapes.empty.title'), body: t('escapes.empty.body') })}</section>
      <section class="card"><div class="card-head"><h2 class="card-title">${esc(t('escapes.how.title'))}</h2></div>
        <p class="hint">${esc(t('escapes.how.quality'))}</p><p class="hint">${esc(t('escapes.how.wifi'))}</p></section>`;

    const L = globalThis.L;
    ({ map } = createMap(el.querySelector('[data-testid="escapes-map"]')));
    const yard = L.polygon(data.yard.polygon, { color: cssVar('--map-yard'), weight: 1, fill: false });
    yard.addTo(map);
    map.fitBounds(yard.getBounds(), { maxZoom: 20, padding: [24, 24] });
    const s = data.strip;
    s.forEach((p, i) => {
      const q = s[(i + 1) % s.length];
      const v = (p.value + q.value) / 2;
      L.polyline([[p.lat, p.lng], [q.lat, q.lng]], { weight: 6, color: mixHex(cssVar('--heat-low'), cssVar('--heat-high'), v), opacity: 0.25 + 0.75 * v }).addTo(map);
    });
    const at = (p) => [p.lat, p.lng];
    for (const e of data.episodes) {
      const when = fmtDateTime(e.t_outside * 1000);
      if (e.crossing) {
        const m = L.circleMarker(at(e.crossing), { radius: 4 + 8 * e.weight, color: cssVar('--map-crossing') }).addTo(map);
        m.bindPopup(lines([t('escapes.pop.time', { time: when }), t('escapes.pop.quality', { quality: t(`escapes.q.${e.quality}`) }),
          t('escapes.pop.gap', { n: e.gap_s }), t('escapes.pop.acc', { n: e.acc })]));
        if (e.a && e.b) L.polyline([at(e.a), at(e.b)], { color: cssVar('--map-crossing'), weight: 2, dashArray: '4 6' }).addTo(map);
      } else if (e.firstOutside) {
        L.circleMarker(at(e.firstOutside), { radius: 6, color: cssVar('--map-crossing'), fill: false }).addTo(map).bindTooltip(lines([t('escapes.firstOutside')]));
      }
    }
    data.peaks.forEach((p, i) => L.marker(at(p), { icon: L.divIcon({ className: '', html: `<div class="peak-marker">${i + 1}</div>`, iconSize: [24, 24] }) })
      .addTo(map).bindTooltip(lines([t('escapes.peak.tip', { n: i + 1, width: p.widthM, count: p.count, times: times(p.count) })])));

    el.querySelectorAll('[data-peak]').forEach((b) => b.addEventListener('click', () => map.setView(at(data.peaks[b.dataset.peak]), 21)));
    const byId = new Map(data.episodes.map((e) => [String(e.id), e]));
    el.querySelector('tbody')?.addEventListener('click', (e) => {
      if (e.target.closest('input')) return;
      const ep = byId.get(e.target.closest('tr')?.dataset.id);
      const p = ep?.crossing ?? ep?.firstOutside;
      if (p) map.setView(at(p), 20);
    });
    el.querySelector('tbody')?.addEventListener('change', async (e) => {
      const tr = e.target.closest('tr');
      const dismiss = e.target.matches('[data-dismiss]');
      try {
        await patchEscape(tr.dataset.id, dismiss ? { dismissed: e.target.checked } : { note: e.target.value.trim() || null });
        if (dismiss) tr.classList.toggle('muted', e.target.checked);
      } catch (err) {
        toast(apiErrorText(err));
      }
    });
  });

  await load();
  const reload = (e) => { if (['out_confirmed', 'back_home'].includes(e.detail?.kind)) load(); };
  ctx.bus.addEventListener('alert', reload, { signal });
  document.addEventListener('themechange', load, { signal });
  return destroy;
}
