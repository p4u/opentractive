// Shell: hash router, navigation, theme, critical-alert banner and the live stream. Each view is a module with
// `export async function render(root, ctx)` that may return a cleanup function, loaded on demand.
import { register, t, translate } from './i18n.js';
import core from './i18n/core.js';
import { getState, logout, openStream, bus, ackAlert, falseAlarm } from './api.js';
import { fmtTime } from './format.js';
import { errorState, getTheme, setTheme, skeleton, overlay, toast, apiErrorText } from './ui.js';
import { ROUTES, PATHS, CARRIED, RANGED, IN_SHEET, PARENT } from './routes.js';

register(core);

const STATE_MS = 60e3;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const main = $('#main');
const sheet = $('#more-sheet');
const menu = $('#more-menu');
const banner = $('#alert-banner');
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

let state = null; // one object for the whole session: views keep their reference while it is updated in place
let current = null; // { name, controller, cleanup }
let streamLostShown = false;

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const i = raw.indexOf('?');
  return { path: i < 0 ? raw : raw.slice(0, i), params: new URLSearchParams(i < 0 ? '' : raw.slice(i + 1)) };
}

const hashFor = (path, params) => {
  const query = params.toString();
  return `#/${path}${query ? `?${query}` : ''}`;
};

// Merge a patch into the hash query (null deletes a key); the hashchange re-renders the view.
function setParams(patch, { replace = false } = {}) {
  const { path, params } = parseHash();
  for (const [k, v] of Object.entries(patch)) {
    if (v == null) params.delete(k);
    else params.set(k, String(v));
  }
  const hash = hashFor(path, params);
  if (hash === location.hash) return;
  if (replace) location.replace(hash);
  else location.hash = hash;
}

function updateNav(name, params) {
  const carried = new URLSearchParams(CARRIED.filter((k) => params.has(k)).map((k) => [k, params.get(k)]));
  for (const a of $$('a[data-route]')) {
    const route = a.dataset.route;
    a.href = hashFor(PATHS[route], RANGED.has(route) ? carried : new URLSearchParams());
    if (route === name || route === PARENT[name]) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  $('.tab[data-action="sheet"]').classList.toggle('is-current', IN_SHEET.has(name));
}

const isDark = () => (document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : darkQuery.matches);

// The theme buttons show what they will switch to.
function updateActions() {
  const dark = isDark();
  const label = t(dark ? 'core.theme.toLight' : 'core.theme.toDark');
  for (const b of $$('[data-action="theme"]')) {
    b.querySelector('use').setAttribute('href', `/icons.svg#${dark ? 'sun-medium' : 'moon'}`);
    const span = b.querySelector('.action-label');
    if (span) span.textContent = label;
    else {
      b.setAttribute('aria-label', label);
      b.title = label;
    }
  }
}

async function refreshState() {
  const fresh = await getState();
  for (const k of Object.keys(state ?? {})) if (!(k in fresh)) delete state[k];
  state = Object.assign(state ?? {}, fresh);
  updateBanner();
  return state;
}

// The newest unacknowledged, unclosed critical alert is shown in every view.
function updateBanner() {
  const list = state?.alerts?.unacked ?? [];
  const a = list.reduce((best, x) => (!best || x.id > best.id ? x : best), null);
  banner.hidden = !a;
  if (!a) return;
  banner.dataset.alertId = a.id;
  banner.querySelector('.alert-banner-title').textContent = a.title ?? '';
  banner.querySelector('.alert-banner-body').textContent = [a.body, t('core.banner.since', { time: fmtTime(a.t * 1000) })].filter(Boolean).join(' · ');
  banner.querySelector('[data-action="banner-false"]').hidden = a.incident !== 1;
}

function applyAlert(a) {
  if (!state) return;
  state.alerts ??= { unacked: [] };
  const rest = state.alerts.unacked.filter((x) => x.id !== a.id);
  if (a.severity === 'critical' && !a.acked_at && !a.closed_at) rest.push(a);
  state.alerts.unacked = rest;
  updateBanner();
}

function wireStream() {
  bus.addEventListener('state', (e) => {
    const d = e.detail;
    if (d.trackers) { // the full state sent on (re)connect
      Object.assign(state, d);
      updateBanner();
      return;
    }
    if (d.trackerId && d.tracker) {
      const i = state.trackers.findIndex((x) => x.id === d.trackerId || x.trackerId === d.trackerId);
      if (i >= 0) state.trackers[i] = { ...state.trackers[i], ...d.tracker };
    }
    if (d.monitor) state.monitor = d.monitor;
  });
  bus.addEventListener('alert', (e) => applyAlert(e.detail));
  bus.addEventListener('stream-open', () => { streamLostShown = false; });
  bus.addEventListener('stream-error', () => {
    if (streamLostShown) return;
    streamLostShown = true;
    toast(t('core.sse.lost'));
  });
  openStream();
}

async function bannerAction(button, fn) {
  const id = Number(banner.dataset.alertId);
  button.disabled = true;
  try {
    applyAlert(await fn(id));
  } catch (err) {
    toast(apiErrorText(err));
  } finally {
    button.disabled = false;
  }
}

async function render({ focus = false } = {}) {
  const { path, params } = parseHash();
  const name = ROUTES[path];
  if (name === undefined) {
    location.replace('#/');
    return;
  }
  if (current) {
    current.controller.abort();
    try {
      current.cleanup?.();
    } catch (err) {
      console.error(err);
    }
  }
  const changed = current != null && current.name !== name;
  const me = { name, controller: new AbortController(), cleanup: null };
  current = me;
  const { signal } = me.controller;
  updateNav(name, params);
  // set at once from the route, so the tab title never names the previous view while this one loads
  document.title = `${t(`core.nav.${name}`)} – ${t('core.appName')}`;
  // a fresh root per render: a slow, superseded render writes into a detached node
  const root = document.createElement('div');
  root.className = `view view-${name}`;
  const swap = () => main.replaceChildren(root);
  // a cross-fade between views only; the root is in the page before the view draws into it (maps measure it)
  if (changed && document.startViewTransition && !reducedMotion.matches) {
    await document.startViewTransition(swap).updateCallbackDone.catch(() => {});
    if (signal.aborted) return;
  } else swap();
  if (focus) scrollTo(0, 0);
  try {
    const view = await import(`./views/${name}.js`);
    if (signal.aborted) return;
    const ctx = { state, params, setParams, signal, bus, refreshState };
    const cleanup = await view.render(root, ctx);
    if (signal.aborted) {
      if (typeof cleanup === 'function') cleanup();
      return;
    }
    me.cleanup = typeof cleanup === 'function' ? cleanup : null;
    const h1 = root.querySelector('h1');
    if (focus && h1) {
      h1.tabIndex = -1;
      h1.focus({ preventScroll: true });
    }
  } catch (err) {
    if (signal.aborted || err?.name === 'AbortError') return;
    console.error(err);
    root.innerHTML = errorState(t('core.error.view'));
    root.querySelector('[data-retry]').addEventListener('click', () => render(), { once: true });
  }
}

function closeOverlays() {
  if (sheet.open) sheet.close();
  try {
    if (menu.matches(':popover-open')) menu.hidePopover();
  } catch { /* no popover support: the menu is never open */ }
}

function wireShell() {
  overlay(sheet);
  overlay(menu); // pushes its history entry on the popover's toggle event
  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const action = el.dataset.action;
    if (action === 'theme') setTheme(isDark() ? 'light' : 'dark');
    else if (action === 'sheet') overlay(sheet).open();
    else if (action === 'close-sheet') sheet.close();
    else if (action === 'banner-ack') bannerAction(el, ackAlert);
    else if (action === 'banner-false') bannerAction(el, falseAlarm);
    else if (action === 'logout') {
      el.disabled = true;
      try {
        await logout();
      } finally {
        location.assign('/login');
      }
    }
  });
  // a click on the backdrop (the dialog box itself, outside its content) closes the sheet
  sheet.addEventListener('click', (e) => {
    if (e.target === sheet) sheet.close();
  });
  // the skip link must not change the hash (that is the router's)
  $('.skip-link').addEventListener('click', (e) => {
    e.preventDefault();
    main.focus();
  });
  window.addEventListener('hashchange', () => {
    closeOverlays();
    if (!state) return; // boot renders once the state is in
    const before = current?.name;
    render({ focus: ROUTES[parseHash().path] !== before });
  });
  document.addEventListener('themechange', updateActions);
  darkQuery.addEventListener('change', () => {
    if (getTheme() === 'system') document.dispatchEvent(new CustomEvent('themechange', { detail: { mode: 'system' } }));
  });
}

async function boot() {
  main.innerHTML = skeleton(320);
  try {
    await refreshState();
  } catch (err) {
    console.error(err);
    main.innerHTML = errorState(t('core.error.server'));
    main.querySelector('[data-retry]').addEventListener('click', boot, { once: true });
    return;
  }
  render();
  wireStream();
  setInterval(() => refreshState().catch((err) => console.error(err)), STATE_MS);
}

translate();
updateActions();
wireShell();
boot();
