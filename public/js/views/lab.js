import { register, t } from '../i18n.js';
import dict from '../i18n/lab.js';
import { labRaw, labChannel, labFields, labRequest, getCommands } from '../api.js';
import { esc, icon, badge, emptyState, loadBlock, toast, apiErrorText, fieldError, every } from '../ui.js';
import { fmtDateTime, relTime } from '../format.js';

register(dict);

const TABS = ['raw', 'channel', 'fields', 'console', 'audit', 'queue'];
const HOSTS = ['graph', 'aps', 'timeline'];
const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];
const HISTORY = []; // console requests of this session, newest first (not persisted)
const pretty = (v) => JSON.stringify(v, null, 2);
const known = (key) => t(key) !== key;
const copyBtn = (text) => `<button type="button" class="pill pill-outline" data-copy="${esc(text)}">${icon('copy', { size: 16 })}${esc(t('lab.copy'))}</button>`;

// The console needs the confirm box for writes and for command paths.
export const needsConfirm = (method, path) => method !== 'GET' || /\/command\//.test(path);

const table = (testid, head, rows) => `<div class="table-scroll"><table class="table"${testid ? ` data-testid="${testid}"` : ''}><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`;

export async function render(root, ctx) {
  const { state, signal, bus } = ctx;
  const tab = TABS.includes(ctx.params.get('tab')) ? ctx.params.get('tab') : 'raw';
  const cleanups = [];
  root.innerHTML = `<header class="view-head"><h1 class="view-title">${esc(t('lab.title'))}</h1></header><p class="hint">${esc(t('lab.hint'))}</p>
    <div class="segmented" role="group" aria-label="${esc(t('lab.tabs'))}">${TABS.map((k) => `<button type="button" data-testid="lab-tab-${k}" data-tab="${k}" aria-pressed="${k === tab}">${esc(t(`lab.tab.${k}`))}</button>`).join('')}</div>
    <div class="lab-body" data-body></div>`;
  root.querySelector('.segmented').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (b && b.dataset.tab !== tab) ctx.setParams({ tab: b.dataset.tab });
  });
  root.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-copy]');
    if (!b) return;
    try {
      await navigator.clipboard.writeText(b.dataset.copy);
      toast(t('lab.copied'));
    } catch (err) { toast(apiErrorText(err)); }
  });
  const body = root.querySelector('[data-body]');
  const panels = { raw, channel, fields, console: consoleTab, audit, queue };

  async function raw(el) {
    const rows = await labRaw();
    el.innerHTML = rows.length
      ? `<div class="stack" data-testid="lab-raw-list">${rows.map((r) => `<details class="raw"><summary>${esc(r.kind)} · ${esc(relTime(r.t * 1000))}</summary>
          <pre class="json">${esc(pretty(r.json))}</pre>${copyBtn(pretty(r.json))}</details>`).join('')}</div>`
      : emptyState({ title: t('lab.raw.empty'), body: t('lab.raw.emptyBody') });
  }

  async function channel(el) {
    let rows = (await labChannel({ limit: 200 })).map((r) => ({ t: r.t, message: r.message, json: r.json }));
    let filter = '';
    let paused = false;
    const row = (r) => `<details class="raw"><summary><span class="num">${esc(fmtDateTime(r.t * 1000))}</span> · ${esc(r.message ?? '')}</summary><pre class="json">${esc(pretty(r.json))}</pre></details>`;
    el.innerHTML = `<div class="lab-tools"><div class="field"><label for="lab-filter">${esc(t('lab.channel.filter'))}</label><select id="lab-filter" data-filter></select></div>
      <button type="button" class="pill pill-outline" data-pause aria-pressed="false">${icon('pause', { size: 16 })}<span>${esc(t('lab.channel.pause'))}</span></button></div>
      <p class="hint" data-paused hidden>${esc(t('lab.channel.paused'))}</p><div class="stack" data-testid="lab-channel-list"></div>`;
    const list = el.querySelector('[data-testid="lab-channel-list"]');
    const sel = el.querySelector('[data-filter]');
    const draw = () => {
      const types = [...new Set(rows.map((r) => r.message).filter(Boolean))].sort();
      sel.innerHTML = `<option value="">${esc(t('lab.channel.all'))}</option>${types.map((m) => `<option value="${esc(m)}"${m === filter ? ' selected' : ''}>${esc(m)}</option>`).join('')}`;
      const shown = filter ? rows.filter((r) => r.message === filter) : rows;
      list.innerHTML = shown.length ? shown.map(row).join('') : emptyState({ title: t('lab.channel.empty'), body: t('lab.channel.emptyBody') });
    };
    draw();
    sel.addEventListener('change', () => { filter = sel.value; draw(); });
    const pause = el.querySelector('[data-pause]');
    pause.addEventListener('click', () => {
      paused = !paused;
      pause.setAttribute('aria-pressed', String(paused));
      pause.querySelector('use').setAttribute('href', `/icons.svg#${paused ? 'play' : 'pause'}`);
      pause.querySelector('span').textContent = t(paused ? 'lab.channel.resume' : 'lab.channel.pause');
      el.querySelector('[data-paused]').hidden = !paused;
      if (!paused) draw();
    });
    const onMsg = (e) => {
      if (e.detail?.kind !== 'message') return;
      rows = [{ t: e.detail.t, message: e.detail.message, json: e.detail.json }, ...rows].slice(0, 500);
      if (!paused) draw();
    };
    bus.addEventListener('channel', onMsg);
    cleanups.push(() => bus.removeEventListener('channel', onMsg));
  }

  async function fields(el) {
    const rows = await labFields();
    el.innerHTML = rows.length
      ? table('lab-fields-table', [t('lab.fields.kind'), t('lab.fields.path'), t('lab.fields.first')],
        rows.map((r) => `<tr><td>${esc(r.kind)}</td><td><code>${esc(r.path)}</code></td><td class="num">${esc(fmtDateTime(r.first_seen * 1000))} ${r.isNew ? badge(t('lab.fields.new'), 'ongoing') : ''}</td></tr>`).join(''))
      : emptyState({ title: t('lab.fields.empty'), body: t('lab.fields.emptyBody') });
  }

  async function audit(el) {
    const rows = await getCommands({ limit: 100 });
    el.innerHTML = rows.length
      ? table('lab-audit-table', ['time', 'actor', 'action', 'params', 'ok', 'result'].map((k) => t(`lab.audit.${k}`)),
        rows.map((r) => `<tr><td class="num">${esc(fmtDateTime(r.t * 1000))}</td><td>${esc(r.actor)}</td><td>${esc(r.action)}</td><td><code>${esc(r.params == null ? '' : JSON.stringify(r.params))}</code></td>
          <td>${badge(t(r.ok ? 'lab.audit.okYes' : 'lab.audit.okNo'), r.ok ? 'ok' : 'alarm')}</td><td><code>${esc(r.result == null ? '' : JSON.stringify(r.result))}</code></td></tr>`).join(''))
      : emptyState({ title: t('lab.audit.empty'), body: t('lab.audit.emptyBody') });
  }

  function queue(el) {
    const draw = () => {
      const tr = state.tractive ?? {}, ch = state.channel ?? {};
      const nowS = Math.floor(Date.now() / 1000);
      const left = tr.queue?.penaltyUntil ? tr.queue.penaltyUntil - nowS : 0;
      const kv = (k, v) => `<div class="kv-row"><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`;
      const login = tr.login == null ? t('core.unknown') : known(`lab.queue.login.${tr.login}`) ? t(`lab.queue.login.${tr.login}`) : tr.login;
      el.innerHTML = `<section class="card" data-testid="lab-queue"><dl class="kv">
        ${kv(t('lab.queue.login'), login)}${kv(t('lab.queue.pending'), tr.queue?.pending ?? t('core.unknown'))}
        ${kv(t('lab.queue.gap'), tr.queue?.gapMs == null ? t('core.unknown') : t('lab.queue.gapValue', { n: Math.round(tr.queue.gapMs / 100) / 10 }))}
        ${kv(t('lab.queue.penalty'), left > 0 ? t('lab.queue.penaltyOn', { n: left }) : t('lab.queue.penaltyOff'))}
        ${kv(t('lab.queue.backfill'), tr.backfillPendingDays ?? t('core.unknown'))}
        ${kv(t('lab.queue.channel'), ch.connected ? t('lab.queue.connected') : t('lab.queue.disconnected'))}
        ${kv(t('lab.queue.reconnects'), ch.reconnects ?? t('core.unknown'))}
        ${kv(t('lab.queue.lastMessage'), ch.lastMessageAt == null ? t('core.unknown') : relTime(ch.lastMessageAt * 1000))}</dl></section>`;
    };
    draw();
    every(5000, draw, signal);
  }

  function consoleTab(el) {
    const opt = (list, cur) => list.map((x) => `<option${x === cur ? ' selected' : ''}>${esc(x)}</option>`).join('');
    el.innerHTML = `<form class="card console" novalidate>
      <div class="console-row"><div class="field"><label for="lab-host">${esc(t('lab.console.host'))}</label><select id="lab-host" name="host">${opt(HOSTS, 'graph')}</select></div>
        <div class="field"><label for="lab-method">${esc(t('lab.console.method'))}</label><select id="lab-method" name="method">${opt(METHODS, 'GET')}</select></div>
        <div class="field console-path"><label for="lab-path">${esc(t('lab.console.path'))}</label><input id="lab-path" name="path" data-testid="lab-console-path" placeholder="/tracker/&lt;id&gt;" autocomplete="off" spellcheck="false"></div></div>
      <div class="field" data-body-field hidden><label for="lab-json">${esc(t('lab.console.body'))}</label><textarea id="lab-json" name="body" spellcheck="false" rows="6"></textarea></div>
      <label class="check" data-confirm-field hidden><input type="checkbox" name="confirm"><span>${esc(t('lab.console.confirm'))}</span></label>
      <div data-error></div>
      <button type="submit" class="pill pill-primary" data-testid="lab-console-send">${icon('terminal', { size: 16 })}${esc(t('lab.console.send'))}</button></form>
      <div data-testid="lab-console-response" class="console-response" aria-live="polite"></div>
      <h2 class="card-title">${esc(t('lab.console.history'))}</h2><div data-history></div>`;
    const f = el.querySelector('form');
    const out = el.querySelector('[data-testid="lab-console-response"]');
    const err = el.querySelector('[data-error]');
    const sync = () => {
      const m = f.method.value;
      el.querySelector('[data-body-field]').hidden = m === 'GET';
      el.querySelector('[data-confirm-field]').hidden = !needsConfirm(m, f.path.value);
    };
    const history = () => {
      el.querySelector('[data-history]').innerHTML = HISTORY.length
        ? `<ul class="plain">${HISTORY.map((h, i) => `<li><button type="button" class="link" data-h="${i}"><code>${esc(h.method)} ${esc(h.host)} ${esc(h.path)}</code></button> <span class="hint">${esc(h.status ?? '')}</span></li>`).join('')}</ul>`
        : `<p class="hint">${esc(t('lab.console.historyEmpty'))}</p>`;
    };
    history();
    f.method.addEventListener('change', sync);
    f.path.addEventListener('input', sync);
    el.querySelector('[data-history]').addEventListener('click', (e) => {
      const h = HISTORY[e.target.closest('[data-h]')?.dataset.h];
      if (!h) return;
      f.host.value = h.host; f.method.value = h.method; f.path.value = h.path; f.body.value = h.body ?? '';
      sync();
    });
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.innerHTML = '';
      const host = f.host.value, method = f.method.value, path = f.path.value.trim();
      if (!path.startsWith('/')) return void (err.innerHTML = fieldError(t('lab.console.noPath')));
      let payload;
      if (method !== 'GET' && f.body.value.trim()) {
        try { payload = JSON.parse(f.body.value); } catch { return void (err.innerHTML = fieldError(t('lab.console.badJson'))); }
      }
      const confirm = needsConfirm(method, path);
      if (confirm && !f.confirm.checked) return void (err.innerHTML = fieldError(t('lab.console.needConfirm')));
      const btn = f.querySelector('[data-testid="lab-console-send"]');
      btn.disabled = true;
      out.textContent = t('lab.console.sending');
      const entry = { host, method, path, body: f.body.value };
      try {
        const r = await labRequest({ host, method, path, ...(payload !== undefined && { body: payload }), ...(confirm && { confirm: true }) });
        entry.status = r.status;
        out.innerHTML = `<p class="num"><strong>${esc(t('lab.console.status', { status: r.status, ms: r.ms }))}</strong></p><pre class="json">${esc(pretty(r.body))}</pre>${copyBtn(pretty(r.body))}`;
      } catch (ex) {
        entry.status = ex.status;
        out.innerHTML = '';
        err.innerHTML = fieldError(ex.status === 403 ? t('lab.console.blocked') : apiErrorText(ex));
      }
      HISTORY.unshift(entry);
      HISTORY.length = Math.min(HISTORY.length, 20);
      history();
      btn.disabled = false;
    });
  }

  await loadBlock(body, 320, (el) => panels[tab](el));
  return () => { for (const c of cleanups) c(); };
}
