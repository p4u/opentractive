// Pure geometry. Points are {lat, lng}; polygons are arrays of points, closed implicitly.
export const R = 6371008.8;
export const M_PER_DEG = (R * Math.PI) / 180;
const RAD = Math.PI / 180;

export const project = (o, p) => ({ x: (p.lng - o.lng) * Math.cos(o.lat * RAD) * M_PER_DEG, y: (p.lat - o.lat) * M_PER_DEG });
export const unproject = (o, { x, y }) => ({ lat: o.lat + y / M_PER_DEG, lng: o.lng + x / (Math.cos(o.lat * RAD) * M_PER_DEG) });

export function centroid(poly) {
  const n = poly.length;
  return { lat: poly.reduce((s, p) => s + p.lat, 0) / n, lng: poly.reduce((s, p) => s + p.lng, 0) / n };
}

export const distanceM = (a, b) => { const q = project(a, b); return Math.hypot(q.x, q.y); };

export function polylineLength(points) {
  let s = 0;
  for (let i = 1; i < points.length; i++) s += distanceM(points[i - 1], points[i]);
  return s;
}

const flat = (poly) => { const o = centroid(poly); return { o, pts: poly.map((p) => project(o, p)) }; };

function inside(pt, pts) {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}

function segDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export function pointInPolygon(p, poly) {
  const { o, pts } = flat(poly);
  return inside(project(o, p), pts);
}

export function distanceToBoundary(p, poly) {
  const { o, pts } = flat(poly);
  const q = project(o, p);
  let d = Infinity;
  for (let i = 0; i < pts.length; i++) d = Math.min(d, segDist(q, pts[i], pts[(i + 1) % pts.length]));
  return inside(q, pts) ? -d : d;
}

function edgeLengths(pts) {
  return pts.map((a, i) => { const b = pts[(i + 1) % pts.length]; return Math.hypot(b.x - a.x, b.y - a.y); });
}

export const perimeterLength = (poly) => edgeLengths(flat(poly).pts).reduce((s, l) => s + l, 0);

export function pointAtPerimeter(poly, s) {
  const { o, pts } = flat(poly);
  const lens = edgeLengths(pts);
  const total = lens.reduce((a, l) => a + l, 0);
  let rest = ((s % total) + total) % total;
  for (let i = 0; i < pts.length; i++) {
    if (rest <= lens[i] || i === pts.length - 1) {
      const a = pts[i], b = pts[(i + 1) % pts.length], u = lens[i] === 0 ? 0 : rest / lens[i];
      return unproject(o, { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u });
    }
    rest -= lens[i];
  }
}

export function segmentBoundaryCrossings(a, b, poly) {
  const { o, pts } = flat(poly);
  const p = project(o, a), r = { x: project(o, b).x - p.x, y: project(o, b).y - p.y };
  const lens = edgeLengths(pts);
  const out = [];
  let before = 0;
  for (let i = 0; i < pts.length; i++) {
    const q = pts[i], e = pts[(i + 1) % pts.length];
    const s = { x: e.x - q.x, y: e.y - q.y };
    const den = r.x * s.y - r.y * s.x;
    if (Math.abs(den) > 1e-12) { // parallel and collinear edges are ignored
      const t = ((q.x - p.x) * s.y - (q.y - p.y) * s.x) / den;
      const u = ((q.x - p.x) * r.y - (q.y - p.y) * r.x) / den;
      if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
        out.push({ point: unproject(o, { x: p.x + t * r.x, y: p.y + t * r.y }), perimeter_m: before + u * lens[i], t });
      }
    }
    before += lens[i];
  }
  return out.sort((x, y) => x.t - y.t);
}

export function circleToPolygon(center, r, n = 32) {
  return Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n;
    return unproject(center, { x: r * Math.cos(a), y: r * Math.sin(a) });
  });
}

export function rectangleToPolygon(c1, c2) {
  const [s, n] = [Math.min(c1.lat, c2.lat), Math.max(c1.lat, c2.lat)];
  const [w, e] = [Math.min(c1.lng, c2.lng), Math.max(c1.lng, c2.lng)];
  return [{ lat: s, lng: w }, { lat: s, lng: e }, { lat: n, lng: e }, { lat: n, lng: w }];
}

const validPair = (c) => Array.isArray(c) && c.length >= 2 && Number.isFinite(c[0]) && Number.isFinite(c[1]) && Math.abs(c[0]) <= 90 && Math.abs(c[1]) <= 180;

export function geofenceToPolygon(g) {
  if (!g || !Array.isArray(g.coords) || !g.coords.every(validPair)) return null;
  const pts = g.coords.map(([lat, lng]) => ({ lat, lng }));
  switch (g.shape) {
    case 'POLYGON': return pts.length >= 3 ? pts : null;
    case 'RECTANGLE': return pts.length >= 2 ? rectangleToPolygon(pts[0], pts[1]) : null;
    case 'CIRCLE': return pts.length >= 1 && Number.isFinite(g.radius) && g.radius > 0 ? circleToPolygon(pts[0], g.radius) : null;
    default: return null;
  }
}
