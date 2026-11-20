import { register, t } from '../i18n.js';
import dict from '../i18n/alerts.js';
import { getAlerts, ackAlert, falseAlarm, getSettings, putSettings } from '../api.js';
import { esc, icon, badge, emptyState, fieldError, loadBlock, toast, apiErrorText } from '../ui.js';
import { fmtDateTime, relTime } from '../format.js';

register(dict);

const PAGE = 50;
const SEV = { critical: 'siren', warn: 'triangle-alert', info: 'info' };
const get = (o, path) => path.split('.').reduce((a, k) => a?.[k], o);
const set = (o, path, v) => { const ks = path.split('.'); const last = ks.pop(); ks.reduce((a, k) => a[k], o)[last] = v; };

function alertRow(a) {
  const closed = { home: 'home', walk: 'walk' }[a.closed_by] ?? 'other';
  return `<li class="alert-row alert-sev-${esc(a.severity)}" data-testid="alert-row" data-id="${a.id}">
    <div class="alert-row-head">${icon(SEV[a.severity] ?? 'info', { size: 20 })}<strong>${esc(t(`alerts.sev.${a.severity}`))}</strong>
      <span class="hint" title="${esc(fmtDateTime(a.t * 1000))}">${esc(relTime(a.t * 1000))}</span></div>
    <p class="subtitle">${esc(a.title)}</p>${a.body ? `<p>${esc(a.body)}</p>` : ''}
    <div class="alert-badges">${a.incident ? badge(t('alerts.badge.incident'), 'alarm') : ''}
      ${a.acked_at ? badge(t('alerts.badge.acked', { who: a.acked_by ?? '' }), 'ok') : ''}
      ${a.closed_at ? badge(t('alerts.badge.closed', { how: t(`alerts.closed.${closed}`) }), 'ok') : ''}</div>
    <div class="alert-actions">${a.acked_at || a.severity === 'info' ? '' : `<button type="button" class="pill pill-primary" data-testid="alert-ack" data-ack>${esc(t('alerts.ack'))}</button>`}
      ${a.incident && !a.closed_at ? `<button type="button" class="pill pill-outline" data-false>${esc(t('alerts.false'))}</button>` : ''}</div>
    <div data-err></div></li>`;
}

function logBlock(el, ctx, kinds) {
  let items = [];
  let more = false;
  let sev = '';
  let kind = '';
  return async () => {
    const first = await getAlerts({ limit: PAGE });
    items = first;
    more = first.length === PAGE;
    el.innerHTML = `<div class="card-head"><h2 class="card-title">${esc(t('alerts.log.title'))}</h2></div>
      <div class="alert-filters"><div class="segmented" role="group" aria-label="${esc(t('alerts.filter.severity'))}">${['', 'critical', 'warn', 'info'].map((s) =>
    `<button type="button" data-sev="${s}" aria-pressed="${s === ''}">${esc(s ? t(`alerts.sev.${s}`) : t('alerts.filter.all'))}</button>`).join('')}</div>
        <div class="field"><label for="alert-kind">${esc(t('alerts.filter.kind'))}</label><select id="alert-kind"><option value="">${esc(t('alerts.filter.all'))}</option>${kinds.map((k) =>
    `<option value="${esc(k)}">${esc(t(`alerts.rule.${k}`))}</option>`).join('')}</select></div></div>
      <div data-list data-testid="alerts-list"></div><div data-more></div>`;
    const list = el.querySelector('[data-list]');
    const moreEl = el.querySelector('[data-more]');
    const draw = () => {
      const shown = items.filter((a) => (!sev || a.severity === sev) && (!kind || a.kind === kind));
      list.innerHTML = shown.length ? `<ul class="alert-list">${shown.map(alertRow).join('')}</ul>`
        : emptyState(items.length ? { title: t('alerts.emptyFiltered.title') } : { title: t('alerts.empty.title'), body: t('alerts.empty.body') });
      moreEl.innerHTML = more ? `<button type="button" class="pill pill-outline" data-more-btn>${esc(t('alerts.more'))}</button>` : '';
    };
    const upsert = (a) => {
      const i = items.findIndex((x) => x.id === a.id);
      if (i >= 0) items[i] = a;
      else items = [a, ...items].sort((x, y) => y.id - x.id);
      draw();
    };
    draw();
    el.querySelector('.segmented').addEventListener('click', (e) => {
      const b = e.target.closest('[data-sev]');
      if (!b) return;
      sev = b.dataset.sev;
      el.querySelectorAll('[data-sev]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      draw();
    });
    el.querySelector('#alert-kind').addEventListener('change', (e) => { kind = e.target.value; draw(); });
    el.addEventListener('click', async (e) => {
      const btn = e.target.closest('button');
      if (btn?.matches('[data-more-btn]')) {
        btn.disabled = true;
        try {
          const page = await getAlerts({ limit: PAGE, before: items.at(-1)?.id });
          items = items.concat(page);
          more = page.length === PAGE;
          draw();
        } catch (err) {
          btn.disabled = false;
          toast(apiErrorText(err));
        }
        return;
      }
      const row = e.target.closest('[data-testid="alert-row"]');
      if (!row || !btn?.matches('[data-ack], [data-false]')) return;
      btn.disabled = true;
      try {
        upsert(await (btn.matches('[data-ack]') ? ackAlert : falseAlarm)(Number(row.dataset.id)));
      } catch (err) {
        btn.disabled = false;
        row.querySelector('[data-err]').innerHTML = fieldError(apiErrorText(err));
      }
    }, { signal: ctx.signal });
    ctx.bus.addEventListener('alert', (e) => upsert(e.detail), { signal: ctx.signal });
  };
}

const num = (path, draft, { step = 'any' } = {}) => `<input id="f-${esc(path)}" type="number" step="${step}" data-path="${esc(path)}" value="${esc(get(draft, path) ?? '')}">`;
const field = (path, draft, label, hint) => `<div class="field"><label for="f-${esc(path)}">${esc(t(label))}</label>${num(path, draft)}
  <p class="field-hint">${esc(t(hint))}</p><div data-err="${esc(path)}"></div></div>`;
const toggle = (path, draft, label, hint, testid) => `<div class="field"><label class="switch-row"><input type="checkbox" class="switch" data-path="${esc(path)}"${testid ? ` data-testid="${esc(testid)}"` : ''}${get(draft, path) ? ' checked' : ''}>${esc(t(label))}</label>
  <p class="field-hint">${esc(t(hint))}</p><div data-err="${esc(path)}"></div></div>`;

function windowsHtml(draft) {
  return draft.yardWatch.windows.map((w, i) => `<div class="yw-window" data-win="${i}">
    <fieldset class="yw-days"><legend class="field-label">${esc(t('alerts.yw.days'))}</legend>${[1, 2, 3, 4, 5, 6, 7].map((d) =>
    `<label><input type="checkbox" data-day="${d}"${w.days.includes(d) ? ' checked' : ''}>${esc(t(`alerts.day.${d}`))}</label>`).join('')}</fieldset>
    <div class="field"><label for="yw-from-${i}">${esc(t('alerts.yw.from'))}</label><input id="yw-from-${i}" type="time" data-time="from" value="${esc(w.from)}"></div>
    <div class="field"><label for="yw-to-${i}">${esc(t('alerts.yw.to'))}</label><input id="yw-to-${i}" type="time" data-time="to" value="${esc(w.to)}"></div>
    <button type="button" class="pill pill-outline" data-remove>${icon('trash-2', { size: 16 })}${esc(t('alerts.yw.remove'))}</button>
    <div data-err="yardWatch.windows.${i}.days"></div><div data-err="yardWatch.windows.${i}.from"></div><div data-err="yardWatch.windows.${i}.to"></div></div>`).join('');
}

// the words the form shows for a settings key path (rules.offline.severity: the rule's name), the path if none
function fieldLabel(form, path) {
  const w = /^yardWatch\.windows\.(\d+)(?:\.(days|from|to))?$/.exec(path);
  if (w) return [t('alerts.yw.windows'), Number(w[1]) + 1, w[2] ? `(${t(`alerts.yw.${w[2]}`)})` : ''].join(' ').trim();
  const slot = [...form.querySelectorAll('[data-err]')].find((s) => s.dataset.err === path);
  const box = slot?.closest('.field, .rule-row');
  return box?.querySelector('label, .field-label, .subtitle')?.textContent.trim() || path;
}

function settingsBlock(el) {
  return async () => {
    const { settings, ruleKinds, pszFlags } = await getSettings();
    const draft = structuredClone(settings);
    const kinds = ruleKinds ?? Object.keys(draft.rules);
    const th = ['offlineMin', 'channelDownMin', 'batteryLow', 'batteryCritical', 'repeatMin', 'repeatMax', 'dedupeMin'];
    el.innerHTML = `<form class="settings-form" novalidate>
      <div data-summary role="alert"></div>
      <section class="card"><div class="card-head"><h2 class="card-title">${esc(t('alerts.rules.title'))}</h2></div><p class="hint">${esc(t('alerts.rules.hint'))}</p>
        ${kinds.map((k) => `<div class="rule-row"><div><p class="subtitle">${esc(t(`alerts.rule.${k}`))}</p><p class="hint">${esc(t(`alerts.rule.${k}.hint`))}</p></div>
          <div class="rule-controls"><label class="switch-row"><input type="checkbox" class="switch" data-path="rules.${k}.enabled" data-testid="rule-${k}-enabled"${draft.rules[k].enabled ? ' checked' : ''}>${esc(t('alerts.rule.enabled'))}</label>
            <select class="input" aria-label="${esc(t('alerts.rule.severity'))}: ${esc(t(`alerts.rule.${k}`))}" data-path="rules.${k}.severity" data-testid="rule-${k}-severity">${['info', 'warn', 'critical'].map((s) =>
    `<option value="${s}"${draft.rules[k].severity === s ? ' selected' : ''}>${esc(t(`alerts.sev.${s}`))}</option>`).join('')}</select></div>
          <div data-err="rules.${k}.enabled"></div><div data-err="rules.${k}.severity"></div></div>`).join('')}</section>
      <section class="card"><div class="card-head"><h2 class="card-title">${esc(t('alerts.thresholds.title'))}</h2></div>
        <div class="settings-grid">${th.map((k) => field(`thresholds.${k}`, draft, `alerts.th.${k}`, `alerts.th.${k}.hint`)).join('')}</div></section>
      <section class="card"><div class="card-head"><h2 class="card-title">${esc(t('alerts.chase.title'))}</h2></div>
        <div class="settings-grid">${toggle('chase.auto', draft, 'alerts.chase.auto', 'alerts.chase.auto.hint')}
          ${field('chase.maxHours', draft, 'alerts.chase.maxHours', 'alerts.chase.maxHours.hint')}${field('chase.minBattery', draft, 'alerts.chase.minBattery', 'alerts.chase.minBattery.hint')}</div></section>
      <section class="card"><div class="card-head"><h2 class="card-title">${esc(t('alerts.yw.title'))}</h2></div>
        <div class="settings-grid">${toggle('yardWatch.enabled', draft, 'alerts.yw.enabled', 'alerts.yw.enabled.hint')}</div>
        <p class="subtitle">${esc(t('alerts.yw.windows'))}</p><p class="hint">${esc(t('alerts.yw.windows.hint'))}</p>
        <div data-windows></div><div data-err="yardWatch.windows"></div>
        <button type="button" class="pill pill-outline" data-add-window>${icon('plus', { size: 16 })}${esc(t('alerts.yw.add'))}</button>
        <div class="settings-grid">${field('yardWatch.minBattery', draft, 'alerts.yw.minBattery', 'alerts.yw.minBattery.hint')}${field('yardWatch.resumeBattery', draft, 'alerts.yw.resumeBattery', 'alerts.yw.resumeBattery.hint')}
          <div class="field"><span class="field-label">${esc(t('alerts.yw.mode'))}</span><div class="segmented" role="group" aria-label="${esc(t('alerts.yw.mode'))}">${['live', 'near-fence'].map((m) =>
    `<button type="button" data-mode="${m}" aria-pressed="${draft.yardWatch.mode === m}">${esc(t(`alerts.yw.mode.${m}`))}</button>`).join('')}</div>
            <p class="field-hint">${esc(t('alerts.yw.mode.hint'))}</p><div data-err="yardWatch.mode"></div></div>
          ${field('yardWatch.nearFenceM', draft, 'alerts.yw.nearFenceM', 'alerts.yw.nearFenceM.hint')}${field('yardWatch.nearFenceHoldMin', draft, 'alerts.yw.nearFenceHoldMin', 'alerts.yw.nearFenceHoldMin.hint')}</div>
        <p class="hint">${icon('battery-warning', { size: 16 })} ${esc(t('alerts.yw.battery'))}</p></section>
      <section class="card"><div class="card-head"><h2 class="card-title">${esc(t('alerts.an.title'))}</h2></div>
        <div class="settings-grid">${['marginM', 'maxGapS', 'homePszM'].map((k) => field(`analysis.${k}`, draft, `alerts.an.${k}`, `alerts.an.${k}.hint`)).join('')}</div></section>
      <section class="card"><div class="card-head"><h2 class="card-title">${esc(t('alerts.psz.title'))}</h2></div><p class="hint">${esc(t('alerts.psz.hint'))}</p>
        ${pszFlags.length ? pszFlags.map((z) => `<div class="rule-row"><div><p class="subtitle">${esc(z.name)}</p>
          <p class="hint">${esc(t(z.geometric ? 'alerts.psz.default.yes' : 'alerts.psz.default.no', { m: draft.analysis.homePszM }))}</p></div>
          <label class="switch-row"><input type="checkbox" class="switch" data-psz="${esc(z.id)}"${z.coversYard ? ' checked' : ''}>${esc(t('alerts.psz.covers'))}</label></div>`).join('')
    : emptyState({ title: t('alerts.psz.empty.title'), body: t('alerts.psz.empty.body') })}</section>
      <div class="settings-bar"><button type="submit" class="pill pill-primary" data-testid="settings-save">${esc(t('alerts.save'))}</button><span data-status class="hint" role="status"></span></div></form>`;

    const form = el.querySelector('form');
    const wins = form.querySelector('[data-windows]');
    const drawWindows = () => { wins.innerHTML = windowsHtml(draft); };
    drawWindows();
    form.addEventListener('input', (e) => {
      const p = e.target.dataset.path;
      if (p) set(draft, p, e.target.type === 'checkbox' ? e.target.checked : e.target.type === 'number' ? (e.target.value === '' ? null : Number(e.target.value)) : e.target.value);
      else if (e.target.dataset.psz) draft.pszCoversYard[e.target.dataset.psz] = e.target.checked;
      else if (e.target.closest('[data-win]')) {
        const w = draft.yardWatch.windows[e.target.closest('[data-win]').dataset.win];
        if (e.target.dataset.time) w[e.target.dataset.time] = e.target.value;
        else w.days = [1, 2, 3, 4, 5, 6, 7].filter((d) => form.querySelector(`[data-win="${draft.yardWatch.windows.indexOf(w)}"] [data-day="${d}"]`).checked);
      }
    });
    form.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (b?.matches('[data-mode]')) {
        draft.yardWatch.mode = b.dataset.mode;
        form.querySelectorAll('[data-mode]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      } else if (b?.matches('[data-add-window]')) {
        draft.yardWatch.windows.push({ days: [1, 2, 3, 4, 5, 6, 7], from: '08:00', to: '22:00' });
        drawWindows();
      } else if (b?.matches('[data-remove]')) {
        draft.yardWatch.windows.splice(Number(b.closest('[data-win]').dataset.win), 1);
        drawWindows();
      }
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const summary = form.querySelector('[data-summary]');
      const btn = form.querySelector('[data-testid="settings-save"]');
      form.querySelectorAll('[data-err]').forEach((s) => { s.innerHTML = ''; });
      summary.innerHTML = '';
      btn.disabled = true;
      try {
        await putSettings(draft);
        toast(t('alerts.saved'));
      } catch (err) {
        const f = err.status === 400 ? err.body?.fields : null;
        if (!f) { summary.innerHTML = fieldError(apiErrorText(err)); return; }
        for (const [k, msg] of Object.entries(f)) {
          const slot = [...form.querySelectorAll('[data-err]')].find((s) => s.dataset.err === k);
          if (slot) slot.innerHTML = fieldError(msg);
        }
        summary.innerHTML = `<p class="settings-summary">${icon('circle-alert', { size: 16 })} ${esc(t('alerts.errors'))}</p><ul>${Object.entries(f).map(([k, msg]) => `<li>${esc(fieldLabel(form, k))}: ${esc(msg)}</li>`).join('')}</ul>`;
        summary.scrollIntoView({ block: 'nearest' });
      } finally {
        btn.disabled = false;
      }
    });
  };
}

export async function render(root, ctx) {
  root.innerHTML = `<header class="view-head"><h1 class="view-title">${esc(t('alerts.title'))}</h1></header>
    <section class="card" data-log></section><div data-settings></div>`;
  const kinds = ['out_possible', 'out_confirmed', 'left_psz', 'fence_exit', 'danger_enter', 'offline', 'live_failed', 'chase_low_battery', 'channel_down',
    'battery_low', 'battery_critical', 'charging', 'back_home', 'new_field'];
  const log = root.querySelector('[data-log]');
  const settings = root.querySelector('[data-settings]');
  await Promise.all([loadBlock(log, 320, logBlock(log, ctx, kinds)), loadBlock(settings, 900, settingsBlock(settings))]);
}
