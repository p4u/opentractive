// Shared markup builders (they return HTML strings; every value is escaped) and small DOM helpers.
import { t } from './i18n.js';

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Line icon from the sprite. Decorative unless a label is given.
export function icon(name, { size = 20, label } = {}) {
  const use = `<use href="/icons.svg#${esc(name)}"/>`;
  return label
    ? `<svg class="icon icon-${size}" role="img"><title>${esc(label)}</title>${use}</svg>`
    : `<svg class="icon icon-${size}" aria-hidden="true">${use}</svg>`;
}

// Placeholder with the final height, so nothing jumps when the data arrives.
export const skeleton = (height) =>
  `<div class="skeleton" style="height:${Number(height) || 0}px"><span class="sr-only">${esc(t('core.loading'))}</span></div>`;

// action: { label, href } (a link) or { label, id } (a button the caller wires up).
export function emptyState({ title, body, action } = {}) {
  const act = !action ? '' : action.href
    ? `<a class="pill pill-outline" href="${esc(action.href)}">${esc(action.label)}</a>`
    : `<button type="button" class="pill pill-outline" id="${esc(action.id ?? '')}">${esc(action.label)}</button>`;
  return `<div class="empty"><span class="orb orb-lavender" aria-hidden="true"></span>
    <p class="empty-title">${esc(title ?? t('core.empty.title'))}</p>
    ${body ? `<p class="empty-body">${esc(body)}</p>` : ''}${act}</div>`;
}

// The retry button carries data-retry; loadBlock wires it, other callers do it themselves.
export const errorState = (message = t('core.error.load')) => `<div class="error" role="alert">
    ${icon('circle-alert', { size: 24 })}
    <div class="error-text"><p class="error-title">${esc(message)}</p><p>${esc(t('core.error.nothingLost'))}</p></div>
    <button type="button" class="pill pill-outline" data-retry>${icon('refresh-cw', { size: 16 })}${esc(t('core.retry'))}</button>
  </div>`;

// kind: provisional | ongoing | ok | warn | alarm (status kinds add a coloured dot)
export const badge = (text, kind = '') => `<span class="badge${kind ? ` badge-${esc(kind)}` : ''}">${esc(text)}</span>`;

// Tiles in one card divided by hairlines. delta: a string or format.delta() output; status: ok | warn | alarm.
export function ledger(tiles) {
  const tile = ({ icon: name, label, value, hint, delta, status, title }) => `<div class="tile"${title ? ` title="${esc(title)}"` : ''}>
      <dt class="tile-label">${name ? icon(name, { size: 16 }) : ''}<span>${esc(label)}</span></dt>
      <dd class="tile-value">${status ? `<span class="status-dot status-${esc(status)}" aria-hidden="true"></span>` : ''}${esc(value ?? t('core.unknown'))}</dd>
      ${delta != null ? `<dd class="tile-delta">${esc(typeof delta === 'string' ? delta : delta.text)}</dd>` : ''}
      ${hint ? `<dd class="tile-hint">${esc(hint)}</dd>` : ''}
    </div>`;
  return `<dl class="ledger" style="--cols:${ledgerColumns(tiles.length, 5)};--cols-md:${ledgerColumns(tiles.length, 4)}">${tiles.map(tile).join('')}</dl>`;
}

// Columns that fill every row of the card when they can (9 tiles: 3 by 3, not 5 and 4 with a hole), at most `max`.
export function ledgerColumns(n, max) {
  if (n <= max) return Math.max(n, 1);
  const options = Array.from({ length: max - 2 }, (_, i) => max - i); // max down to 3
  return options.find((c) => n % c === 0) ?? options.reduce((a, c) => (n % c > n % a ? c : a));
}

const STATES = {
  ok: ['circle-check', 'mint'],
  info: ['info', 'sky'],
  warn: ['triangle-alert', 'peach'],
  alarm: ['circle-alert', 'rose'],
  waiting: ['clock', 'lavender'],
};

// The headline that answers "do I need to act?": icon plus words; the orb hue is decoration only.
// link: { href, label } shown after the details.
export function statusLine({ state = 'ok', title, details = [], link = null }) {
  const [name, hue] = STATES[state] ?? STATES.info;
  return `<div class="status-line status-${esc(state)}" role="status">
    <span class="orb orb-${hue}" aria-hidden="true"></span>
    ${icon(name, { size: 24 })}
    <div class="status-text"><p class="headline">${esc(title)}</p>
    ${[].concat(details).filter(Boolean).map((d) => `<p class="status-detail">${esc(d)}</p>`).join('')}
    ${link ? `<p class="status-detail"><a class="link" href="${esc(link.href)}">${esc(link.label)}</a></p>` : ''}</div>
  </div>`;
}

// A compact warning card in the flow (body type, icon plus words): advice that is not the page's headline.
export const notice = (text, { state = 'warn', testid } = {}) => `<div class="notice notice-${esc(state)}" role="note"${testid ? ` data-testid="${esc(testid)}"` : ''}>
    ${icon((STATES[state] ?? STATES.info)[0], { size: 20 })}<p>${esc(text)}</p></div>`;

// Overlays and the back button. Every modal dialog and the menu popover go through overlay(el): opening
// pushes a history entry on the same URL (no hashchange), so the back button closes the top overlay before it leaves
// the view; an overlay closed any other way pops its own entry again.
const stack = []; // open overlays, the top last
let seq = 0;
let settled = Promise.resolve(); // resolves when no back() of an overlay is pending
let release = null;

function popOwnEntry() {
  let timer;
  settled = new Promise((resolve) => {
    release = () => { clearTimeout(timer); release = null; resolve(); };
    timer = setTimeout(release, 500); // guard: a popstate that never comes
  });
  history.back();
}

// dialog.close() fires its close event a task later: settle overlays already shut before another one opens or the
// back button acts, so their entries are popped in order
const sweep = () => { for (const e of [...stack]) if (!e.isOpen()) e.closed(); };

globalThis.addEventListener?.('popstate', () => {
  if (release) return release(); // the pop of our own back()
  sweep();
  if (stack.length) stack.at(-1).hide();
  else if (history.state?.overlay) popOwnEntry(); // forward onto an overlay entry: nothing to show there
});
if (globalThis.history?.state?.overlay) popOwnEntry(); // reloaded while an overlay was open

const wired = new WeakMap();

// Wired once per element. open(): showModal (dialogs) or showPopover; a popover pushes on its toggle event, so the
// native popovertarget button works too. closed(): resolves once the element has closed and its entry is popped;
// callers that navigate or write history after closing an overlay wait for it.
export function overlay(el) {
  if (wired.has(el)) return wired.get(el);
  const isDialog = typeof el.showModal === 'function';
  let finish = () => {};
  const entry = {
    n: 0,
    done: Promise.resolve(),
    isOpen: () => (isDialog ? el.open : el.matches(':popover-open')),
    hide: () => (isDialog ? el.close() : el.hidePopover()),
    closed() {
      const i = stack.indexOf(entry);
      if (i < 0) return;
      stack.splice(i, 1);
      if (history.state?.overlay === entry.n) popOwnEntry();
      settled.then(finish);
    },
  };
  const opened = () => {
    entry.n = ++seq;
    entry.done = new Promise((resolve) => { finish = resolve; });
    stack.push(entry);
    history.pushState({ ...history.state, overlay: entry.n }, '');
  };
  if (isDialog) el.addEventListener('close', () => entry.closed());
  else el.addEventListener('toggle', (e) => (e.newState === 'open' ? opened() : entry.closed()));
  // a route link inside: close, wait for the pop, then navigate, so no overlay entry is left under the next view
  el.addEventListener('click', (e) => {
    const a = e.target.closest?.('a[href^="#/"]');
    if (!a || !stack.includes(entry) || e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    const { done } = entry;
    entry.hide();
    done.then(() => { location.hash = a.getAttribute('href'); });
  });
  const api = {
    async open() {
      sweep();
      let s;
      do await (s = settled); while (s !== settled); // a back() started meanwhile is waited for too
      if (!isDialog) return el.showPopover();
      if (el.open || !el.isConnected) return;
      el.showModal();
      opened();
    },
    closed: () => entry.done,
  };
  wired.set(el, api);
  return api;
}

// Modal question with two buttons; resolves true on `yes`, false on `no`, Escape, close or back, once its history
// entry is gone (the caller may navigate next). Labels are plain text.
export function confirmDialog({ title, body, yes, no }) {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'sheet';
    dialog.setAttribute('aria-labelledby', 'confirm-title');
    dialog.innerHTML = `<h2 id="confirm-title" class="view-title">${esc(title)}</h2>${body ? `<p>${esc(body)}</p>` : ''}
      <div class="actions"><button type="button" class="pill pill-primary" data-yes>${esc(yes)}</button>
      <button type="button" class="pill pill-outline" data-no>${esc(no)}</button></div>`;
    const o = overlay(dialog);
    let answer = false;
    dialog.addEventListener('click', (e) => {
      if (e.target.closest('[data-yes]')) answer = true;
      if (e.target.closest('[data-yes], [data-no]')) dialog.close();
    });
    dialog.addEventListener('close', () => { dialog.remove(); o.closed().then(() => resolve(answer)); });
    document.body.append(dialog);
    o.open();
  });
}

// Skeleton while fn runs; on failure an error with a retry that runs fn again. fn fills el itself.
export async function loadBlock(el, height, fn) {
  el.innerHTML = skeleton(height);
  el.setAttribute('aria-busy', 'true');
  try {
    await fn(el);
  } catch (err) {
    if (err?.name === 'AbortError') return;
    console.error(err);
    el.innerHTML = errorState();
    el.querySelector('[data-retry]').addEventListener('click', () => loadBlock(el, height, fn), { once: true });
  } finally {
    el.removeAttribute('aria-busy');
  }
}

// setInterval that stops when the signal aborts (the view was left).
export function every(ms, fn, signal) {
  const id = setInterval(fn, ms);
  signal?.addEventListener('abort', () => clearInterval(id), { once: true });
  return id;
}

// Theme: 'light' | 'dark' saved in localStorage; absent means follow the device ('system').
export function getTheme() {
  try {
    const v = localStorage.getItem('theme');
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function setTheme(mode) {
  const root = document.documentElement;
  try {
    if (mode === 'light' || mode === 'dark') localStorage.setItem('theme', mode);
    else localStorage.removeItem('theme');
  } catch { /* still applied to this page */ }
  const fixed = mode === 'light' || mode === 'dark';
  if (fixed) root.dataset.theme = mode;
  else delete root.dataset.theme;
  document.dispatchEvent(new CustomEvent('themechange', { detail: { mode: fixed ? mode : 'system' } }));
}

// One short message (role=status) above the tab bar; hides after 6 s. action: { label, onClick }.
export function toast(text, { action } = {}) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.innerHTML = `<span>${esc(text)}</span>${action ? `<button type="button" class="pill pill-primary">${esc(action.label)}</button>` : ''}`;
  const hide = () => el.remove();
  el.querySelector('button')?.addEventListener('click', () => { action.onClick?.(); hide(); }, { once: true });
  document.body.append(el);
  setTimeout(hide, 6000);
  return el;
}

// Plain sentence for a failed API call, shown next to the control that failed.
export function apiErrorText(err) {
  const b = err?.body ?? {};
  if (err?.status === 503 && b.retryAfter != null) return t('core.error.rateLimited', { n: Math.ceil(b.retryAfter) });
  if (err?.status === 503 && b.login) return t('core.error.login', { message: b.error ?? String(b.login) });
  if (err?.status === 502) return t('core.error.tractive', { message: b.error ?? err.message });
  return t('core.error.generic', { message: err?.message ?? '' });
}

export const fieldError = (text) => `<p class="field-error" role="alert">${icon('circle-alert', { size: 16 })}<span>${esc(text)}</span></p>`;
