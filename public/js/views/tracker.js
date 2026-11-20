import { register, t } from '../i18n.js';
import dict from '../i18n/tracker.js';
import { getTracker, setPowerMode, setLiveTimeout, deletePsz, createShare, deleteShare, notifyReachable, getNotifications, putNotifications } from '../api.js';
import { esc, icon, badge, ledger, emptyState, loadBlock, toast, apiErrorText, confirmDialog, overlay, fieldError } from '../ui.js';
import { fmtDate } from '../format.js';
import { createMap, yardLayer, pszLayer } from '../map.js';

register(dict);

const POWER = ['LOW', 'BALANCED', 'PRECISION'];
const TIMEOUTS = [300, 900, 1800, 3600];
const NOTES = ['geofence_in', 'geofence_out', 'battery_full', 'battery_low', 'battery_critical', 'battery_empty', 'charging_reminder',
  'proactive_charge_reminder', 'tracker_startup_shutdown', 'sharing', 'support', 'wellness_and_activity', 'point_of_interest_warnings', 'automatic_walk_detection'];
const GROUPS = ['push', 'mail', 'webPush'];

const card = (id, title, body, hint) => `<section class="card" data-testid="${id}"><div class="card-head"><h2 class="card-title">${esc(title)}</h2></div>${body}${hint ? `<p class="hint">${esc(hint)}</p>` : ''}</section>`;
const known = (key) => t(key) !== key;
// a Tractive enum in sentence case (BLACK-LINES: Black-lines, HW_REPORTS: Hw reports), or its known wording
export const words = (v) => (v == null ? null : String(v).replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase()));
const enumText = (kind, v) => (v != null && known(`tracker.${kind}.${v}`) ? t(`tracker.${kind}.${v}`) : words(v));

// A capability id: a known name, "<base>_BLE" over Bluetooth, or the raw id marked as undocumented.
export function capability(id) {
  if (known(`tracker.cap.${id}`)) return { name: t(`tracker.cap.${id}`), note: null };
  const base = /^(.+)_BLE$/.exec(id)?.[1];
  if (base) return { name: t('tracker.caps.ble', { base: known(`tracker.cap.${base}`) ? t(`tracker.cap.${base}`) : words(base) }), note: null };
  return { name: words(id), note: t('tracker.caps.unknown') };
}

function typedDialog(zone) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.className = 'sheet';
    d.setAttribute('aria-labelledby', 'psz-del-title');
    d.innerHTML = `<h2 id="psz-del-title" class="view-title">${esc(t('tracker.psz.deleteTitle'))}</h2>
      <div class="field"><label for="psz-del-input">${esc(t('tracker.psz.type', { name: zone.name }))}</label><input id="psz-del-input" data-testid="psz-confirm" autocomplete="off"></div>
      <div class="actions"><button type="button" class="pill pill-primary" data-yes>${esc(t('tracker.delete'))}</button>
      <button type="button" class="pill pill-outline" data-no>${esc(t('tracker.cancel'))}</button></div>`;
    const o = overlay(d);
    let typed = null;
    d.addEventListener('click', (e) => {
      if (e.target.closest('[data-yes]')) typed = d.querySelector('input').value;
      if (e.target.closest('[data-yes], [data-no]')) d.close();
    });
    d.addEventListener('close', () => { d.remove(); o.closed().then(() => resolve(typed)); });
    document.body.append(d);
    o.open();
  });
}

export async function render(root, ctx) {
  const { state, signal } = ctx;
  const tid = state.followed;
  root.innerHTML = `<header class="view-head"><h1 class="view-title">${esc(t('tracker.title'))}</h1>
    <button type="button" class="pill pill-outline" data-testid="tracker-refresh">${icon('refresh-cw', { size: 16 })}${esc(t('tracker.refresh'))}</button></header>
    <p class="hint">${esc(t('tracker.refreshHint'))}</p><div data-main></div>`;
  const main = root.querySelector('[data-main]');
  if (!tid) {
    main.innerHTML = emptyState({ title: t('tracker.none'), body: t('tracker.noneBody') });
    root.querySelector('[data-testid="tracker-refresh"]').disabled = true;
    return;
  }
  let maps = [];
  const dropMaps = () => { for (const m of maps) m.destroy(); maps = []; };
  let data = null;

  const load = (refresh) => loadBlock(main, 480, async (el) => {
    data = await getTracker(tid, { refresh });
    if (!signal.aborted) paint(el);
  });

  function paint(el) {
    dropMaps();
    const { tracker: tr, subscription: sub, psz, shares, reachable } = data;
    const ro = data.readOnly || tr.read_only;
    const w = !ro;
    const others = state.trackers.filter((x) => !x.followed);
    const tiles = ledger([
      { label: t('tracker.model'), value: tr.model_number === 'TG6A' ? 'DOG 6' : tr.model_number },
      { label: t('tracker.edition'), value: words(tr.hw_edition), hint: t('tracker.edition.hint') },
      { label: t('tracker.firmware'), value: tr.fw_version },
      { label: t('tracker.battery'), value: enumText('battery', tr.battery_state), hint: t('tracker.battery.hint') },
      { label: t('tracker.sensitivity'), value: words(tr.geofence_sensitivity), hint: t('tracker.sensitivity.hint') },
      { label: t('tracker.id'), value: tr.hw_id ?? tr._id },
    ]);
    const caps = (tr.capabilities ?? []).map((c) => { const x = capability(c); return `<li>${esc(x.name)}${x.note ? ` <span class="hint">${esc(x.note)}</span>` : ''}</li>`; }).join('');
    const subWord = sub && (known(`tracker.sub.${sub.status}`) ? t(`tracker.sub.${sub.status}`) : sub.status);
    const subBody = sub
      ? `<p>${badge(subWord, sub.status === 'ACTIVE' ? 'ok' : 'warn')}</p>
         <p>${esc(t('tracker.sub.plan'))}: ${esc(words(sub.plan_type_used) ?? t('core.unknown'))}</p>
         <p>${esc(t('tracker.sub.interval'))}: ${esc(words(sub.billing_interval) ?? t('core.unknown'))}</p>
         <p>${esc(t('tracker.sub.until', { date: fmtDate(sub.valid_to == null ? null : sub.valid_to * 1000, { day: 'numeric', month: 'short', year: 'numeric' }) }))}</p>`
      : emptyState({ title: t('tracker.sub.empty') });
    const seg = (testid, items) => `<div class="segmented" role="group" data-testid="${testid}">${items}</div>`;
    const controls = `<div class="row"><div><p class="row-label">${esc(t('tracker.power'))}</p><p class="hint">${esc(t('tracker.power.hint'))}</p></div>
        ${seg('tracker-power-mode', POWER.map((m) => `<button type="button" data-mode="${m}" aria-pressed="${tr.power_mode === m}">${esc(t(`tracker.power.${m}`))}</button>`).join(''))}</div>
      <div class="row"><div><p class="row-label">${esc(t('tracker.timeout'))}</p><p class="hint">${esc(t('tracker.timeout.hint'))}</p></div>
        ${seg('tracker-live-timeout', TIMEOUTS.map((s) => `<button type="button" data-s="${s}" aria-pressed="${tr.custom_lt_timeout === s}">${esc(t('tracker.timeout.value', { n: s / 60 }))}</button>`).join(''))}</div>
      <div data-controls-error></div>`;
    const pszRows = psz.map((z) => `<li class="psz" data-testid="psz-row" data-id="${esc(z._id)}">
        <div class="psz-info"><p class="row-label">${esc(z.name)}</p><p class="hint">${esc(t('tracker.psz.wifi'))}: <span class="num">${esc(z.zone_id)}</span></p>
        <p>${z.current ? badge(t('tracker.psz.current'), 'ongoing') : ''} ${z.coversYard ? badge(t('tracker.psz.yard'), 'warn') : ''}</p>
        ${w ? `<button type="button" class="pill pill-outline" data-testid="psz-delete">${icon('trash-2', { size: 16 })}${esc(t('tracker.psz.delete'))}</button>` : ''}</div>
        <div class="map-sm" data-map></div></li>`).join('');
    const shareRows = shares.map((s) => `<li class="share" data-id="${esc(s._id)}"><div class="share-info"><p class="row-label">${esc(s.message)}</p>
        <p class="hint"><a class="link" href="${esc(/^https?:\/\//.test(s.share_link) ? s.share_link : '#')}" target="_blank" rel="noopener noreferrer">${esc(s.share_link)}</a></p>
        <p>${badge(t(s.active ? 'tracker.share.active' : 'tracker.share.inactive'), s.active ? 'ok' : '')}</p></div>
        <div class="actions-inline"><button type="button" class="pill pill-outline" data-copy="${esc(s.share_link)}">${icon('copy', { size: 16 })}${esc(t('tracker.share.copy'))}</button>
        ${w && s.active ? `<button type="button" class="pill pill-outline" data-deactivate>${esc(t('tracker.share.deactivate'))}</button>` : ''}</div></li>`).join('');
    const shareForm = w ? `<form class="share-form" data-share-form><div class="field"><label for="share-msg">${esc(t('tracker.share.message'))}</label>
        <input id="share-msg" name="message" maxlength="200" required></div>
        <button type="submit" class="pill pill-primary" data-testid="share-create">${icon('share-2', { size: 16 })}${esc(t('tracker.share.create'))}</button><div data-share-error></div></form>` : '';
    const notified = reachable?.user_gets_notified;
    const reach = `<p>${badge(t(notified ? 'tracker.reach.on' : 'tracker.reach.off'), notified ? 'ok' : '')}</p>
      ${w ? `<button type="button" class="pill pill-outline" data-reach>${icon('bell', { size: 16 })}${esc(t('tracker.reach.button'))}</button>` : ''}`;
    const list = (items) => `<ul class="plain">${items}</ul>`;
    el.innerHTML = `<div class="grid">
      <div class="span-12">${card('device-card', t('tracker.device'), `${ro ? `<p>${badge(t('tracker.readOnly'), 'warn')}</p>` : ''}${tiles}`)}</div>
      <div class="span-6">${card('caps-card', t('tracker.caps'), caps ? `<ul class="plain caps">${caps}</ul>` : emptyState({ title: t('tracker.caps.empty') }))}</div>
      <div class="span-6">${card('sub-card', t('tracker.sub'), subBody)}</div>
      ${w ? `<div class="span-12">${card('controls-card', t('tracker.controls'), controls)}</div>` : ''}
      <div class="span-12">${card('psz-card', t('tracker.psz'), psz.length ? list(pszRows) : emptyState({ title: t('tracker.psz.empty'), body: t('tracker.psz.emptyBody') }), w ? t('tracker.psz.deleteHint') : null)}</div>
      <div class="span-6">${card('share-card', t('tracker.share'), `${shares.length ? list(shareRows) : emptyState({ title: t('tracker.share.empty'), body: t('tracker.share.emptyBody') })}${shareForm}`, t('tracker.share.hint'))}</div>
      <div class="span-6">${card('reach-card', t('tracker.reach'), reach)}</div>
      <div class="span-12" data-notif></div>
      <div class="span-12">${card('others-card', t('tracker.others'), others.length ? list(others.map((o) => `<li><span class="num">${esc(o.trackerId)}</span> ${esc(o.model ?? '')} ${badge(o.stateLabel ?? t('core.unknown'))}</li>`).join('')) : `<p class="hint">${esc(t('tracker.others.empty'))}</p>`)}</div>
    </div>`;
    el.querySelectorAll('.psz').forEach((li, i) => {
      const z = psz[i];
      if (!globalThis.L || !Array.isArray(z.latlong)) return;
      const m = createMap(li.querySelector('[data-map]'), { center: z.latlong, zoom: 18 });
      pszLayer([{ name: z.name, lat: z.latlong[0], lng: z.latlong[1] }]).addTo(m.map);
      if (state.yard?.polygon?.length) yardLayer(state.yard.polygon).addTo(m.map);
      maps.push(m);
    });
    loadBlock(el.querySelector('[data-notif]'), 200, (box) => paintNotif(box, w));
  }

  async function paintNotif(el, w) {
    const n = await getNotifications();
    if (signal.aborted) return;
    const has = (g, k) => k in (n[g] ?? {});
    const keys = NOTES.filter((k) => GROUPS.some((g) => has(g, k)));
    if (!keys.length) {
      el.innerHTML = card('notif-card', t('tracker.notif'), emptyState({ title: t('tracker.notif.empty') }), t('tracker.notif.hint'));
      return;
    }
    const cell = (g, k) => (has(g, k) ? `<input type="checkbox" class="switch" data-g="${g}" data-k="${k}" aria-label="${esc(`${t(`tracker.note.${k}`)}, ${t(`tracker.notif.${g}`)}`)}"${n[g][k] ? ' checked' : ''}${w ? '' : ' disabled'}>` : '');
    el.innerHTML = card('notif-card', t('tracker.notif'), `<div class="table-scroll"><table class="table"><thead><tr><th></th>${GROUPS.map((g) => `<th>${esc(t(`tracker.notif.${g}`))}</th>`).join('')}</tr></thead><tbody>
      ${keys.map((k) => `<tr><th scope="row">${esc(t(`tracker.note.${k}`))}</th>${GROUPS.map((g) => `<td>${cell(g, k)}</td>`).join('')}</tr>`).join('')}
      </tbody></table></div>${w ? `<button type="button" class="pill pill-primary" data-testid="notif-save">${esc(t('core.save'))}</button><div data-notif-error></div>` : ''}`, t('tracker.notif.hint'));
    el.querySelector('[data-testid="notif-save"]')?.addEventListener('click', async (e) => {
      const patch = {};
      for (const box of el.querySelectorAll('input[data-g]')) if (box.checked !== !!n[box.dataset.g][box.dataset.k]) (patch[box.dataset.g] ??= {})[box.dataset.k] = box.checked;
      if (!Object.keys(patch).length) return toast(t('tracker.notif.saved'));
      e.target.disabled = true;
      try {
        await putNotifications(patch);
        toast(t('tracker.notif.saved'));
        await loadBlock(el, 200, (box) => paintNotif(box, w));
      } catch (err) {
        e.target.disabled = false;
        el.querySelector('[data-notif-error]').innerHTML = fieldError(apiErrorText(err));
      }
    });
  }

  const setControl = async (btn, fn) => {
    btn.disabled = true;
    try {
      data.tracker = (await fn()) ?? data.tracker;
      toast(t('tracker.saved'));
      paint(main);
    } catch (err) {
      btn.disabled = false;
      main.querySelector('[data-controls-error]').innerHTML = fieldError(apiErrorText(err));
    }
  };

  // one delegated handler for the whole view (the cards are re-painted)
  main.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.mode) setControl(b, () => setPowerMode(tid, b.dataset.mode));
    else if (b.dataset.s) setControl(b, () => setLiveTimeout(tid, Number(b.dataset.s)));
    else if (b.dataset.copy != null) {
      try {
        await navigator.clipboard.writeText(b.dataset.copy);
        toast(t('tracker.share.copied'));
      } catch (err) { toast(apiErrorText(err)); }
    } else if ('deactivate' in b.dataset) {
      const id = b.closest('.share').dataset.id;
      if (!(await confirmDialog({ title: t('tracker.share.confirm'), body: t('tracker.share.confirmBody'), yes: t('tracker.share.deactivate'), no: t('tracker.cancel') }))) return;
      try {
        await deleteShare(id);
        toast(t('tracker.share.done'));
        load(true);
      } catch (err) { toast(apiErrorText(err)); }
    } else if ('reach' in b.dataset) {
      b.disabled = true;
      try {
        data.reachable = await notifyReachable(tid);
        toast(t('tracker.reach.done'));
        paint(main);
      } catch (err) { b.disabled = false; toast(apiErrorText(err)); }
    } else if (b.dataset.testid === 'psz-delete') {
      const z = data.psz.find((x) => x._id === b.closest('.psz').dataset.id);
      const typed = await typedDialog(z);
      if (typed == null) return;
      try {
        await deletePsz(z._id, typed);
        toast(t('tracker.psz.deleted'));
        load(true);
      } catch (err) { toast(apiErrorText(err)); }
    }
  });
  main.addEventListener('submit', async (e) => {
    if (!e.target.matches('[data-share-form]')) return;
    e.preventDefault();
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    try {
      await createShare(tid, e.target.message.value.trim());
      toast(t('tracker.share.created'));
      load(true);
    } catch (err) {
      btn.disabled = false;
      e.target.querySelector('[data-share-error]').innerHTML = fieldError(apiErrorText(err));
    }
  });
  root.querySelector('[data-testid="tracker-refresh"]').addEventListener('click', () => load(true));
  await load(false);
  return dropMaps;
}
