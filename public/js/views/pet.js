import { register, t } from '../i18n.js';
import dict from '../i18n/pet.js';
import { getPet, putPet, petPhotoUrl } from '../api.js';
import { esc, icon, badge, emptyState, loadBlock, toast, apiErrorText, fieldError } from '../ui.js';
import { fmtDate, fmtDateTime, nf } from '../format.js';
import { cssVar } from '../map.js';

register(dict);

const card = (id, title, body, head = '') => `<section class="card" data-testid="${id}"><div class="card-head"><h2 class="card-title">${esc(title)}</h2>${head}</div>${body}</section>`;
const known = (key) => t(key) !== key;

// Timeline event line; unknown types show the raw type.
export function eventLabel(ev) {
  return known(`pet.event.${ev.type}`) ? t(`pet.event.${ev.type}`, { zone: ev.zoneName ?? '' }) : String(ev.type ?? '');
}
const evTime = (ev) => {
  const ms = (v) => (v ? Date.parse(v) : NaN);
  const a = ms(ev.occurredAt ?? ev.startedAt), b = ms(ev.endedAt);
  return Number.isNaN(a) ? t('core.unknown') : `${fmtDateTime(a)}${Number.isNaN(b) ? '' : ` – ${fmtDateTime(b)}`}`;
};
const status = (s) => (s == null ? t('core.unknown') : known(`pet.status.${s.status}`) ? t(`pet.status.${s.status}`) : String(s.status));

export async function render(root, ctx) {
  const { state, signal } = ctx;
  const me = state.trackers.find((x) => x.followed);
  const pid = me?.petId;
  root.innerHTML = `<header class="view-head"><h1 class="view-title">${esc(t('pet.title'))}</h1></header><div data-main></div>`;
  const main = root.querySelector('[data-main]');
  if (!pid) {
    main.innerHTML = emptyState({ title: t('pet.none'), body: t('pet.noneBody') });
    return;
  }
  const charts = [];
  const chart = (el, opts) => {
    if (!globalThis.ApexCharts) return;
    const c = new globalThis.ApexCharts(el, { chart: { toolbar: { show: false }, fontFamily: 'inherit', background: 'transparent' }, ...opts });
    charts.push(c);
    c.render();
  };
  const dropCharts = () => { for (const c of charts.splice(0)) try { c.destroy(); } catch { /* already gone */ } };

  let data = null;
  let events = [];
  let next = null;

  const paintTimeline = (el) => {
    el.innerHTML = card('timeline-card', t('pet.timeline'), `${events.length ? `<ul class="plain timeline">${events.map((ev) => `<li class="timeline-row"><span class="timeline-what">${esc(eventLabel(ev))}</span><span class="hint num">${esc(evTime(ev))}</span></li>`).join('')}</ul>` : emptyState({ title: t('pet.timeline.empty') })}
      ${next ? `<button type="button" class="pill pill-outline" data-testid="timeline-more">${icon('chevron-down', { size: 16 })}${esc(t('pet.timeline.more'))}</button><div data-more-error></div>` : ''}`);
    el.querySelector('[data-testid="timeline-more"]')?.addEventListener('click', async (e) => {
      const b = e.currentTarget; // null after the first await
      b.disabled = true;
      try {
        const r = (await getPet(pid, { resumeFrom: next })).timeline;
        events = events.concat(r.events);
        next = r.nextResumeFrom;
        paintTimeline(el);
      } catch (err) {
        b.disabled = false;
        el.querySelector('[data-more-error]').innerHTML = fieldError(apiErrorText(err));
      }
    });
  };

  function profile(el) {
    const d = data.pet.details ?? {};
    const as = d.activity_settings ?? {};
    const photo = data.photo ? `<img class="pet-photo" data-testid="pet-photo" src="${esc(petPhotoUrl(pid))}" alt="${esc(t('pet.photoAlt', { name: d.name ?? '' }))}">` : icon('paw-print', { size: 24 });
    const kv = (k, v) => `<div class="kv-row"><dt>${esc(k)}</dt><dd>${esc(v ?? t('core.unknown'))}</dd></div>`;
    el.innerHTML = card('profile-card', t('pet.profile'), `<div class="profile"><div class="photo-box">${photo}</div><dl class="kv">
      ${kv(t('pet.name'), d.name)}${kv(t('pet.birthday'), d.birthday == null ? null : fmtDate(d.birthday * 1000, { day: 'numeric', month: 'short', year: 'numeric' }))}
      ${kv(t('pet.weight'), d.weight == null ? null : `${nf(1).format(d.weight / 1000)} kg`)}${kv(t('pet.gender'), known(`pet.gender.${d.gender}`) ? t(`pet.gender.${d.gender}`) : d.gender)}
      ${kv(t('pet.goalMinutes'), as.daily_active_minutes_goal == null ? null : `${as.daily_active_minutes_goal} min`)}${kv(t('pet.goalDistance'), as.daily_distance_goal == null ? null : `${as.daily_distance_goal} m`)}
      </dl></div><div data-form></div>`,
    `<button type="button" class="pill pill-outline" data-testid="pet-edit">${icon('pencil', { size: 16 })}${esc(t('pet.edit'))}</button>`);
    const img = el.querySelector('img');
    img?.addEventListener('error', () => { img.replaceWith(Object.assign(document.createElement('span'), { innerHTML: icon('paw-print', { size: 24 }) })); }, { once: true });
    el.querySelector('[data-testid="pet-edit"]').addEventListener('click', () => form(el, d, as));
  }

  function form(el, d, as) {
    const box = el.querySelector('[data-form]');
    const day = d.birthday == null ? '' : new Date(d.birthday * 1000).toISOString().slice(0, 10);
    const f = (id, label, attrs) => `<div class="field"><label for="pet-${id}">${esc(label)}</label><input id="pet-${id}" name="${id}" ${attrs}></div>`;
    box.innerHTML = `<form class="pet-form" novalidate>
      ${f('name', t('pet.name'), `required minlength="1" maxlength="40" value="${esc(d.name ?? '')}"`)}
      ${f('birthday', t('pet.birthday'), `type="date" value="${esc(day)}"`)}
      ${f('weight', t('pet.weightKg'), `type="number" min="0.5" max="150" step="0.1" value="${d.weight == null ? '' : d.weight / 1000}"`)}
      <div class="field"><label for="pet-gender">${esc(t('pet.gender'))}</label><select id="pet-gender" name="gender"><option value="F"${d.gender === 'F' ? ' selected' : ''}>${esc(t('pet.gender.F'))}</option><option value="M"${d.gender === 'M' ? ' selected' : ''}>${esc(t('pet.gender.M'))}</option></select></div>
      ${f('minutes', t('pet.goalMinutes'), `type="number" min="10" max="600" step="1" value="${esc(as.daily_active_minutes_goal ?? '')}"`)}
      ${f('distance', t('pet.goalDistanceM'), `type="number" min="100" max="50000" step="1" value="${esc(as.daily_distance_goal ?? '')}"`)}
      <div class="actions-inline"><button type="submit" class="pill pill-primary" data-testid="pet-save">${esc(t('pet.save'))}</button><button type="button" class="pill pill-outline" data-cancel>${esc(t('pet.cancel'))}</button></div>
      <div data-error></div></form>`;
    const fm = box.querySelector('form');
    fm.name.focus();
    fm.querySelector('[data-cancel]').addEventListener('click', () => { box.innerHTML = ''; });
    fm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = fm.querySelector('[data-error]');
      const details = {};
      const name = fm.name.value.trim();
      if (name !== (d.name ?? '')) details.name = name;
      if (fm.birthday.value && fm.birthday.value !== day) details.birthday = Math.floor(Date.parse(`${fm.birthday.value}T00:00:00Z`) / 1000);
      if (fm.weight.value !== '' && Math.round(fm.weight.valueAsNumber * 1000) !== d.weight) details.weight = Math.round(fm.weight.valueAsNumber * 1000);
      if (fm.gender.value !== d.gender) details.gender = fm.gender.value;
      const goals = {};
      if (fm.minutes.value !== '' && fm.minutes.valueAsNumber !== as.daily_active_minutes_goal) goals.daily_active_minutes_goal = fm.minutes.valueAsNumber;
      if (fm.distance.value !== '' && fm.distance.valueAsNumber !== as.daily_distance_goal) goals.daily_distance_goal = fm.distance.valueAsNumber;
      if (Object.keys(goals).length) details.activity_settings = goals;
      if (!fm.checkValidity() || name.length < 1) return void (err.innerHTML = fieldError(t('pet.invalid', { message: '' })));
      if (!Object.keys(details).length) { box.innerHTML = ''; return; }
      const btn = fm.querySelector('[data-testid="pet-save"]');
      btn.disabled = true;
      try {
        data.pet = await putPet(pid, details);
        toast(t('pet.saved'));
        me.petName = data.pet.details?.name ?? me.petName;
        profile(el);
      } catch (ex) {
        btn.disabled = false;
        err.innerHTML = fieldError(ex.status === 409 ? t('pet.conflict') : apiErrorText(ex));
      }
    });
  }

  function health(el) {
    const h = data.health;
    if (!h) { el.innerHTML = card('health-card', t('pet.health'), emptyState({ title: t('pet.health.empty') })); return; }
    const a = h.activity ?? {};
    const mins = a.minutesGoal ? Math.min(a.minutesActive ?? 0, a.minutesGoal) : 0;
    const segs = h.stateTimeline?.segments ?? [];
    const total = segs.reduce((s, x) => s + (x.durationSeconds ?? 0), 0) || 1;
    const cls = (s) => (s === 'REST' || s === 'OFF_PET' ? s : 'other');
    const stLabel = (s) => (known(`pet.health.state.${s}`) ? t(`pet.health.state.${s}`) : String(s));
    const num = (v) => (v == null ? t('core.unknown') : `${v} min`);
    const st = (k, s) => `<div class="kv-row"><dt>${esc(k)}</dt><dd>${esc(status(s))}</dd></div>`;
    el.innerHTML = card('health-card', t('pet.health'), `
      <h3 class="subtitle">${esc(t('pet.health.activity'))}</h3>
      <p class="num">${esc(t('pet.health.minutes', { a: a.minutesActive ?? t('core.unknown'), b: a.minutesGoal ?? t('core.unknown') }))}</p>
      <progress class="bar" max="${esc(a.minutesGoal || 1)}" value="${esc(mins)}"></progress>
      <h3 class="subtitle">${esc(t('pet.health.hours'))}</h3><div class="chart" data-hours></div>
      <h3 class="subtitle">${esc(t('pet.health.sleep'))}</h3>
      <dl class="kv">${[[t('pet.health.sleepDay'), h.sleep?.minutesDaySleep], [t('pet.health.sleepNight'), h.sleep?.minutesNightSleep], [t('pet.health.calm'), h.sleep?.minutesCalm]]
        .map(([k, v]) => `<div class="kv-row"><dt>${esc(k)}</dt><dd>${esc(num(v))}</dd></div>`).join('')}
        <div class="kv-row"><dt>${esc(t('pet.health.rest'))}</dt><dd>${esc(h.rest == null ? t('core.unknown') : typeof h.rest === 'object' ? JSON.stringify(h.rest) : String(h.rest))}</dd></div></dl>
      <h3 class="subtitle">${esc(t('pet.health.timeline'))}</h3>
      ${segs.length ? `<div class="stack" role="img" aria-label="${esc(t('pet.health.timeline'))}">${segs.map((s) => `<span class="seg seg-${cls(s.state)}" style="flex-grow:${Number(s.durationSeconds) || 0}" title="${esc(stLabel(s.state))}"></span>`).join('')}</div>
        <ul class="legend">${[...new Set(segs.map((s) => s.state))].map((s) => `<li><span class="swatch seg-${cls(s)}"></span>${esc(stLabel(s))}</li>`).join('')}</ul>` : `<p class="hint">${esc(t('core.unknown'))}</p>`}
      <dl class="kv">${st(t('pet.health.bark'), h.bark)}${st(t('pet.health.heart'), h.restingHeartRate)}${st(t('pet.health.breath'), h.restingRespiratoryRate)}${st(t('pet.health.scratch'), h.scratch)}</dl>`);
    chart(el.querySelector('[data-hours]'), {
      chart: { type: 'bar', height: 180, toolbar: { show: false }, background: 'transparent' },
      series: [{ name: t('pet.health.hours'), data: (a.hourlyDistribution ?? []).slice(0, 24) }],
      xaxis: { categories: Array.from({ length: 24 }, (_, i) => i) },
      colors: [cssVar('--chart-activity')], dataLabels: { enabled: false }, legend: { show: false },
    });
  }

  function weight(el) {
    const rows = (data.weight?.data ?? []).filter((p) => Array.isArray(p) && p[1] != null);
    el.innerHTML = card('weight-card', t('pet.weightCard'), rows.length ? '<div class="chart" data-w></div>' : emptyState({ title: t('pet.weight.empty') }));
    if (!rows.length) return;
    chart(el.querySelector('[data-w]'), {
      chart: { type: 'line', height: 220, toolbar: { show: false }, background: 'transparent' },
      series: [{ name: t('pet.weight.series'), data: rows.map(([x, g]) => [(x > 1e9 ? x * 1000 : x), g / 1000]) }],
      xaxis: { type: 'datetime' }, stroke: { width: 3, curve: 'straight' }, colors: [cssVar('--chart-activity')], markers: { size: 4 },
      yaxis: { labels: { formatter: (v) => nf(1).format(v) } },
    });
  }

  await loadBlock(main, 480, async (el) => {
    data = await getPet(pid);
    if (signal.aborted) return;
    events = data.timeline?.events ?? [];
    next = data.timeline?.nextResumeFrom ?? null;
    el.innerHTML = '<div class="grid"><div class="span-12" data-p></div><div class="span-12" data-h></div><div class="span-12" data-w></div><div class="span-12" data-t></div></div>';
    profile(el.querySelector('[data-p]'));
    health(el.querySelector('[data-h]'));
    weight(el.querySelector('[data-w]'));
    paintTimeline(el.querySelector('[data-t]'));
  });
  return dropCharts;
}
