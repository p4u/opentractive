// Router tables, no DOM (app.js, ui.js and the tests import them). Hash path to view module.
export const ROUTES = {
  '': 'live', history: 'history', escapes: 'escapes', fences: 'fences', alerts: 'alerts',
  tracker: 'tracker', pet: 'pet', telegram: 'telegram', lab: 'lab',
};
export const PATHS = Object.fromEntries(Object.entries(ROUTES).map(([path, name]) => [name, path]));
export const CARRIED = ['r', 'from', 'to']; // the time range follows the user across these views
export const RANGED = new Set(['history', 'escapes']);
export const IN_SHEET = new Set(['fences', 'tracker', 'pet', 'telegram', 'lab']);
export const PARENT = {};
