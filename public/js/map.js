// Leaflet + Geoman helpers. The pure helpers run under Node; Leaflet is reached only inside functions through
// globalThis.L. Coordinates here are Tractive [lat, lng]; GeoJSON is [lng, lat].

export function geojsonToTractive(ring) {
  const pts = ring.map(([lng, lat]) => [lat, lng]);
  const [a, b] = [pts[0], pts.at(-1)];
  return pts.length > 1 && a[0] === b[0] && a[1] === b[1] ? pts.slice(0, -1) : pts;
}

export function tractiveToGeojson(coords) {
  const ring = coords.map(([lat, lng]) => [lng, lat]);
  return ring.length ? [...ring, ring[0]] : ring;
}

export function mixHex(a, b, t) {
  const ch = (h, i) => parseInt(h.slice(1 + 2 * i, 3 + 2 * i), 16);
  return `#${[0, 1, 2].map((i) => Math.round(ch(a, i) + (ch(b, i) - ch(a, i)) * t).toString(16).padStart(2, '0')).join('')}`;
}

export const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const SATELLITE = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const STREETS = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

export function createMap(el, { center, zoom = 19 } = {}) {
  const L = globalThis.L;
  const map = L.map(el, { zoomControl: true, maxZoom: 21 });
  const satellite = L.tileLayer(SATELLITE, { attribution: 'Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics', maxNativeZoom: 19, maxZoom: 21 });
  const streets = L.tileLayer(STREETS, { attribution: '© OpenStreetMap contributors', maxNativeZoom: 19, maxZoom: 21 });
  satellite.addTo(map);
  L.control.layers({ Satellite: satellite, Map: streets }).addTo(map);
  if (center) map.setView(center, zoom);
  return { map, destroy: () => map.remove() };
}

// Layers read their colours once; views re-create them on `themechange`.
export function yardLayer(polygon) {
  return globalThis.L.polygon(polygon, { color: cssVar('--map-yard'), weight: 3, fillColor: cssVar('--map-yard'), fillOpacity: 0.08 });
}

export function geofenceLayer(g) {
  const L = globalThis.L;
  const color = cssVar(g.fence_type === 'DANGER' ? '--map-danger' : '--map-yard');
  const style = { color, weight: 3, fillColor: color, fillOpacity: 0.08, dashArray: g.active === false ? '6 6' : null };
  if (g.shape === 'CIRCLE') return L.circle(g.coords[0], { ...style, radius: g.radius });
  if (g.shape === 'RECTANGLE') return L.rectangle(g.coords, style);
  return L.polygon(g.coords, style);
}

export function pszLayer(zones) {
  const L = globalThis.L;
  const color = cssVar('--map-psz');
  const group = L.layerGroup();
  for (const z of zones) {
    const pin = z.lat != null ? z : (z.pin ?? z.coords?.[0]);
    if (!pin) continue;
    const m = L.circleMarker(Array.isArray(pin) ? pin : [pin.lat, pin.lng], { radius: 8, color, fillColor: color, fillOpacity: 0.5, weight: 2 });
    // Leaflet renders string tooltips as HTML; a text node keeps a Tractive zone name inert.
    m.bindTooltip(document.createTextNode(z.name ?? ''), { permanent: true, direction: 'top', className: 'psz-label' });
    group.addLayer(m);
  }
  return group;
}

export function dogMarker(pos) {
  const L = globalThis.L;
  const make = (p) => L.divIcon({
    className: '',
    iconSize: [16, 16],
    html: `<div class="dog-marker${p.course != null ? ' has-heading' : ''}" style="--heading:${Number(p.course) || 0}deg"></div>`,
  });
  const at = (p) => [p.lat, p.lng];
  const color = cssVar('--map-dog');
  const marker = L.marker(at(pos), { icon: make(pos), keyboard: false });
  const circle = L.circle(at(pos), { radius: pos.acc ?? 0, color, weight: 1, fillColor: color, fillOpacity: 0.15 });
  const group = L.layerGroup([circle, marker]);
  group.update = (p) => {
    marker.setLatLng(at(p)).setIcon(make(p));
    circle.setLatLng(at(p)).setRadius(p.acc ?? 0);
  };
  return group;
}

export function trailLayer(points) {
  const L = globalThis.L;
  const group = L.layerGroup();
  const style = (wifi) => (wifi
    ? { color: cssVar('--map-trail-wifi'), weight: 2, dashArray: '4 6' }
    : { color: cssVar('--map-trail-gps'), weight: 3 });
  let run = [];
  let wifi = null;
  const flush = () => { if (run.length > 1) L.polyline(run, style(wifi)).addTo(group); };
  for (const p of points) {
    const w = /wifi/i.test(p.sensor ?? '');
    if (w !== wifi) {
      const last = run.at(-1);
      flush();
      run = last ? [last] : []; // segments share their joint so the line has no gap
      wifi = w;
    }
    run.push([p.lat, p.lng]);
  }
  flush();
  return group;
}

export function layerToGeofence(layer, shape) {
  if (shape === 'Circle') {
    const c = layer.getLatLng();
    return { shape: 'CIRCLE', coords: [[c.lat, c.lng]], radius: Math.round(layer.getRadius()) };
  }
  if (shape === 'Rectangle') {
    const b = layer.getBounds();
    return { shape: 'RECTANGLE', coords: [[b.getSouthWest().lat, b.getSouthWest().lng], [b.getNorthEast().lat, b.getNorthEast().lng]] };
  }
  const ring = layer.getLatLngs();
  return { shape: 'POLYGON', coords: (Array.isArray(ring[0]) ? ring[0] : ring).map((p) => [p.lat, p.lng]) };
}

export const enableDraw = (map, shape) => map.pm.enableDraw(shape, { snappable: false });
export const onCreate = (map, fn) => map.on('pm:create', (e) => fn(e.layer, e.shape));
