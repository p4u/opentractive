// Pure escape analysis over store fix rows {t, lat, lng, acc, sensor, psz_id}, ascending by t.
import { distanceToBoundary, distanceM, perimeterLength, pointAtPerimeter, segmentBoundaryCrossings } from './geo.js';

export const DEFAULTS = Object.freeze({ marginM: 10, maxGapS: 600, homePszM: 50 });
export const WEIGHT = Object.freeze({ good: 1, fair: 0.5, poor: 0.2, none: 0 });
export const HOME = new Set(['inside', 'psz']);

const accOf = (f) => (f.acc > 0 ? f.acc : 50);

export function classify(fix, poly, settings) {
  const d = distanceToBoundary(fix, poly);
  if (fix.psz_id || fix.sensor === 'KNOWN_WIFI') return { cls: d < 0 || d <= settings.homePszM ? 'psz' : 'away', d };
  if (d < 0) return { cls: 'inside', d };
  return { cls: d > Math.max(accOf(fix), settings.marginM) ? 'outside' : 'uncertain', d };
}

export function detectEpisodes(fixes, poly, { settings, now }) {
  const cl = fixes.map((f) => classify(f, poly, settings));
  const out = [];
  let home = false, lastHome = null;
  for (let i = 0; i < fixes.length; i++) {
    const f = fixes[i], { cls, d } = cl[i];
    if (HOME.has(cls)) { home = true; lastHome = f; continue; }
    if (cls === 'away') { home = false; continue; }
    if (cls !== 'outside' || !home) continue;
    let confirmed = d > Math.max(3 * accOf(f), 30), outlier = false;
    if (!confirmed) {
      for (let j = i + 1; j < fixes.length && fixes[j].t <= f.t + 45; j++) {
        if (cl[j].cls === 'outside') { confirmed = true; break; }
        if (HOME.has(cl[j].cls)) { outlier = true; break; }
      }
      if (!confirmed && !outlier) confirmed = fixes.some((x) => x.t > f.t + 45) || now > f.t + 45;
    }
    if (outlier) continue;
    out.push({ t_inside: lastHome.t, t_outside: f.t, confirmed, pending: !confirmed, lastHome, firstOutside: f });
    home = false;
  }
  return out;
}

export function analyzeEpisode(fixes, ep, poly, settings, pszNames) {
  const { lastHome, firstOutside } = ep;
  const distance_m = classify(firstOutside, poly, settings).d;
  if (classify(lastHome, poly, settings).cls === 'psz') {
    return {
      quality: 'none', weight: 0, crossing: null, gap_s: firstOutside.t - lastHome.t, segment_m: null, acc: null,
      a: lastHome, b: null, firstOutside, distance_m,
      note: `dog left Wi-Fi zone ${pszNames?.[lastHome.psz_id] ?? 'unknown'}: no GPS before the exit`,
    };
  }
  let ai = -1;
  fixes.forEach((f, i) => { if (f.t <= ep.t_inside && classify(f, poly, settings).cls === 'inside') ai = i; });
  const a = ai >= 0 ? fixes[ai] : lastHome;
  const b = fixes.slice(ai + 1).find((f) => {
    const { cls, d } = classify(f, poly, settings);
    return cls !== 'psz' && cls !== 'away' && d >= 0;
  }) ?? null;
  const base = { quality: 'none', weight: 0, crossing: null, gap_s: null, segment_m: null, acc: null, a, b, firstOutside, distance_m, note: null };
  if (!b) return base;
  const gap = b.t - a.t, seg = distanceM(a, b), acc = Math.max(accOf(a), accOf(b));
  let quality = 'none';
  if (gap <= 30 && acc <= 15 && seg <= 25) quality = 'good';
  else if (gap <= 180 && acc <= 30 && seg <= 80) quality = 'fair';
  else if (gap <= settings.maxGapS) quality = 'poor';
  const x = quality === 'none' ? null : segmentBoundaryCrossings(a, b, poly)[0];
  if (!x) return { ...base, gap_s: gap, segment_m: seg, acc };
  return {
    ...base, quality, weight: WEIGHT[quality], gap_s: gap, segment_m: seg, acc,
    crossing: { lat: x.point.lat, lng: x.point.lng, perimeter_m: x.perimeter_m },
  };
}

export function heatStrip(crossings, poly, { stepM = 2 } = {}) {
  const P = perimeterLength(poly), n = Math.max(1, Math.round(P / stepM)), step = P / n;
  const dc = (x, y) => { const d = Math.abs(x - y); return Math.min(d, P - d); };
  const raw = Array.from({ length: n }, (_, i) => {
    const s = i * step;
    return crossings.reduce((v, c) => {
      const h = Math.max(5, c.acc ?? 0, (c.segment_m ?? 0) / 4);
      return v + c.weight * Math.exp(-0.5 * (dc(s, c.perimeter_m) / h) ** 2);
    }, 0);
  });
  const max = Math.max(...raw);
  const v = raw.map((x) => (max > 0 ? x / max : 0));
  const strip = v.map((value, i) => ({ perimeter_m: i * step, ...pointAtPerimeter(poly, i * step), value }));

  const cands = [];
  for (let i = 0; i < n; i++) {
    if (v[i] > v[(i - 1 + n) % n] && v[i] >= v[(i + 1) % n] && v[i] >= 0.1) cands.push(i);
  }
  cands.sort((x, y) => v[y] - v[x]);
  const reach = (i, dir) => { let k = 0; while (k < n && v[(i + dir * (k + 1) + n * (k + 2)) % n] >= v[i] / 2) k++; return k * step; };
  const peaks = [];
  for (const i of cands) {
    const s = i * step, widthM = Math.round((reach(i, -1) + reach(i, 1)) / 2);
    if (peaks.some((k) => dc(s, k.perimeter_m) < Math.max(10, k.widthM))) continue;
    const count = crossings.filter((c) => c.weight > 0 && dc(s, c.perimeter_m) <= Math.max(widthM, 5)).length;
    peaks.push({ perimeter_m: s, ...pointAtPerimeter(poly, s), value: v[i], widthM, count });
    if (peaks.length === 3) break;
  }
  return { strip, peaks };
}

export function analyze({ fixes, poly, settings, now, stored, pszNames }) {
  const detected = detectEpisodes(fixes, poly, { settings, now });
  const episodes = stored.map((row) => {
    const ep = detected.find((e) => e.t_outside === row.t_outside);
    const r = ep
      ? analyzeEpisode(fixes, ep, poly, settings, pszNames)
      : { quality: 'none', weight: 0, crossing: null, gap_s: null, segment_m: null, acc: null, a: null, b: null, firstOutside: null, distance_m: null, note: null };
    return {
      id: row.id, t_inside: row.t_inside, t_outside: row.t_outside, note: row.note ?? r.note, dismissed: row.dismissed,
      quality: r.quality, weight: r.weight, crossing: r.crossing, gap_s: r.gap_s, segment_m: r.segment_m, acc: r.acc,
      a: r.a, b: r.b, firstOutside: r.firstOutside, distance_m: r.distance_m, missing: !ep,
    };
  }).sort((x, y) => x.t_outside - y.t_outside);
  const crossings = episodes.filter((e) => !e.dismissed && e.crossing && e.weight > 0)
    .map((e) => ({ perimeter_m: e.crossing.perimeter_m, weight: e.weight, acc: e.acc, segment_m: e.segment_m }));
  return { episodes, ...heatStrip(crossings, poly) };
}

export function reconcileStored(detected, stored, from, to) {
  const confirmed = detected.filter((e) => e.confirmed);
  const have = new Set(stored.map((s) => s.t_outside)), want = new Set(confirmed.map((e) => e.t_outside));
  return {
    insert: confirmed.filter((e) => !have.has(e.t_outside)).map((e) => ({ t_inside: e.t_inside, t_outside: e.t_outside })),
    remove: stored.filter((s) => s.t_outside >= from && s.t_outside <= to && !want.has(s.t_outside) && !s.note && !s.dismissed).map((s) => s.id),
  };
}
