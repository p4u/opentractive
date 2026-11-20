// Numbers, dates and durations in the current language and the browser's time zone. Unknown (null) values read
// as t('core.unknown'), never as zero. Instants are ms here (API seconds x 1000 in the views). Formatters are
// built on first use and cached (none at import time).
import { locale, t } from './i18n.js';

const NB = ' '; // keeps a number and its unit on one line
const HOUR = 3600e3;
const DAY = 24 * HOUR;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

let zone; // undefined: the browser's zone
const cache = new Map();

export function setTimeZone(tz) {
  try {
    zone = tz ? new Intl.DateTimeFormat('en', { timeZone: tz }).resolvedOptions().timeZone : undefined;
  } catch {
    zone = undefined;
  }
}

function intl(Kind, opts) {
  const key = `${Kind.name}|${locale()}|${JSON.stringify(opts)}`;
  if (!cache.has(key)) cache.set(key, new Kind(locale(), opts));
  return cache.get(key);
}
const dateFmt = (opts, timeZone = zone) => intl(Intl.DateTimeFormat, { ...opts, timeZone });
const unknown = (v) => v == null || Number.isNaN(v);

export const nf = (digits) => intl(Intl.NumberFormat, { minimumFractionDigits: digits, maximumFractionDigits: digits });
// axis ticks: up to `digits` decimals, no trailing zeros ("2", "2,5", never "2,00")
export const nfAxis = (digits) => intl(Intl.NumberFormat, { maximumFractionDigits: digits });
export const pct = (v) => (unknown(v) ? t('core.unknown') : `${Math.round(v)}${NB}%`);
export const pctText = (v) => (unknown(v) ? t('core.unknown') : `${Math.round(v)} %`);

export const fmtTime = (ts) => (unknown(ts) ? t('core.unknown') : dateFmt({ hour: '2-digit', minute: '2-digit' }).format(ts));
export const fmtDateTime = (ts) =>
  (unknown(ts) ? t('core.unknown') : dateFmt({ day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(ts));

// 'YYYY-MM-DD' is a calendar day (formatted as is); a number is an instant shown in the local zone.
export function fmtDate(dayOrTs, opts = { day: 'numeric', month: 'short' }) {
  if (unknown(dayOrTs)) return t('core.unknown');
  if (typeof dayOrTs === 'string' && DAY_RE.test(dayOrTs)) {
    const [y, m, d] = dayOrTs.split('-').map(Number);
    return dateFmt(opts, 'UTC').format(Date.UTC(y, m - 1, d, 12));
  }
  return dateFmt(opts).format(dayOrTs);
}

export function duration(ms) {
  if (unknown(ms)) return t('core.unknown');
  const n = (v) => intl(Intl.NumberFormat, { maximumFractionDigits: 1 }).format(v);
  if (ms >= 2 * DAY) return t('core.duration.days', { n: n(ms / DAY) });
  if (ms >= HOUR) return t('core.duration.hours', { n: n(ms / HOUR) });
  return t('core.duration.minutes', { n: Math.max(1, Math.round(ms / 60e3)) });
}

// The calendar day of an instant, and the instant a day starts (DST-safe).
export function dayOf(ts) {
  const p = Object.fromEntries(dateFmt({ year: 'numeric', month: '2-digit', day: '2-digit' }, zone).formatToParts(ts).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

export function dayStart(day) {
  const [y, m, d] = day.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  const start = guess - offset(guess);
  return guess - offset(start);
}

// zone offset in ms at an instant (local wall time minus UTC)
function offset(ts) {
  const p = Object.fromEntries(dateFmt({ hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
    .formatToParts(ts).map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ts / 1000) * 1000;
}

export function relTime(ms, now = Date.now()) {
  if (unknown(ms)) return t('core.unknown');
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 60) return t('core.time.justNow');
  if (s < 3600) return t('core.time.minAgo', { n: Math.floor(s / 60) });
  if (s < 48 * 3600) return t('core.time.hAgo', { n: Math.floor(s / 3600) });
  return t('core.time.dAgo', { n: Math.floor(s / 86400) });
}

export function countdown(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function metres(m) {
  if (unknown(m)) return t('core.unknown');
  return m < 1000 ? `${Math.round(m)} m` : `${nf(1).format(m / 1000)} km`;
}
