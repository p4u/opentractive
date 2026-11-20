// Static files: safe path resolution under public/, plus whitelisted fonts and the icon sprite.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULES = fileURLToPath(new URL('../node_modules/', import.meta.url));

export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
};
const SERVED = new Set(['.html', '.js', '.css', '.svg', '.png']);

export function resolveStatic(root, urlPath) {
  let p;
  try {
    p = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  // a segment starting with '.' covers '..', dotfiles and dot directories
  if (p.includes('\0') || p.split(/[/\\]/).some((s) => s.startsWith('.'))) return null;
  const base = path.resolve(root);
  const abs = path.join(base, p);
  if (!abs.startsWith(base + path.sep) || !SERVED.has(path.extname(abs))) return null;
  try {
    return fs.statSync(abs).isFile() ? abs : null;
  } catch {
    return null;
  }
}

const font = (pkg, file) => path.join(MODULES, '@fontsource-variable', pkg, 'files', file);
export const FONTS = Object.freeze({
  '/fonts/inter-latin-wght-normal.woff2': font('inter', 'inter-latin-wght-normal.woff2'),
  '/fonts/inter-latin-ext-wght-normal.woff2': font('inter', 'inter-latin-ext-wght-normal.woff2'),
  '/fonts/eb-garamond-latin-wght-normal.woff2': font('eb-garamond', 'eb-garamond-latin-wght-normal.woff2'),
  '/fonts/eb-garamond-latin-ext-wght-normal.woff2': font('eb-garamond', 'eb-garamond-latin-ext-wght-normal.woff2'),
});

const LUCIDE_DIR = path.join(MODULES, 'lucide-static', 'icons');

export const ICONS = Object.freeze([
  'map-pin', 'map', 'locate', 'locate-fixed', 'radar', 'dog', 'paw-print', 'house', 'shield', 'shield-alert',
  'shield-check', 'fence', 'battery', 'battery-low', 'battery-medium', 'battery-full', 'battery-charging',
  'battery-warning', 'wifi', 'wifi-off', 'satellite', 'lightbulb', 'lightbulb-off', 'bell', 'bell-ring', 'bell-off',
  'volume-2', 'volume-x', 'radio', 'route', 'history', 'play', 'pause', 'crosshair', 'footprints', 'flask-conical',
  'terminal', 'send', 'bot', 'link', 'link-2-off', 'copy', 'trash-2', 'pencil', 'plus', 'square', 'circle',
  'hexagon', 'list-checks', 'download', 'cloud-download', 'rotate-ccw', 'refresh-cw', 'gauge', 'zap', 'timer',
  'navigation', 'navigation-2', 'target', 'siren', 'eye', 'eye-off', 'log-out', 'moon', 'sun-medium', 'ellipsis',
  'x', 'check', 'circle-check', 'circle-alert', 'triangle-alert', 'info', 'clock', 'calendar', 'chevron-down',
  'chevron-left', 'chevron-right', 'settings', 'sliders-horizontal', 'activity', 'heart', 'scale', 'cake', 'user',
  'share-2', 'smartphone', 'cpu', 'message-circle', 'power', 'signal', 'mouse-pointer-click', 'search-check',
  'compass',
]);

const mod = (...p) => path.join(MODULES, ...p);
const LEAFLET_IMAGES = ['layers.png', 'layers-2x.png', 'marker-icon.png', 'marker-icon-2x.png', 'marker-shadow.png'];
export const VENDOR = Object.freeze({
  '/vendor/leaflet/leaflet.js': mod('leaflet', 'dist', 'leaflet.js'),
  '/vendor/leaflet/leaflet.css': mod('leaflet', 'dist', 'leaflet.css'),
  ...Object.fromEntries(LEAFLET_IMAGES.map((f) => [`/vendor/leaflet/images/${f}`, mod('leaflet', 'dist', 'images', f)])),
  '/vendor/geoman/leaflet-geoman.js': mod('@geoman-io', 'leaflet-geoman-free', 'dist', 'leaflet-geoman.js'),
  '/vendor/geoman/leaflet-geoman.css': mod('@geoman-io', 'leaflet-geoman-free', 'dist', 'leaflet-geoman.css'),
  '/vendor/apexcharts.js': mod('apexcharts', 'dist', 'apexcharts.min.js'),
});

// Stroke attributes live on the outer <svg> and are dropped: CSS `.icon` sets them.
export function buildSprite(dir = LUCIDE_DIR) {
  const symbols = ICONS.map((name) => {
    const src = fs.readFileSync(path.join(dir, `${name}.svg`), 'utf8');
    const inner = /<svg\b[^>]*>([\s\S]*?)<\/svg>/.exec(src)?.[1];
    if (inner == null) throw new Error(`icon ${name}: no <svg> element`);
    return `<symbol id="${name}" viewBox="0 0 24 24">${inner.trim().replace(/\s*\n\s*/g, '')}</symbol>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg">${symbols.join('')}</svg>`;
}
