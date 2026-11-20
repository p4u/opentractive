// UI strings. Each namespace file under ./i18n/ registers { en: {...}, ca: {...} }; t() looks a key up in the
// current language, then English, then returns the key. Runs under plain Node too (view-model tests), so every
// browser global is guarded and nothing touches the DOM at import time.

export const LANGS = { en: { name: 'English', locale: 'en-GB' } };

const MESSAGES = Object.fromEntries(Object.keys(LANGS).map((l) => [l, {}]));
let current = null;

function detect() {
  return 'en';
}

export function register(dict) {
  for (const [lang, entries] of Object.entries(dict)) if (MESSAGES[lang]) Object.assign(MESSAGES[lang], entries);
}

export function getLang() {
  current ??= detect();
  return current;
}

export function locale() {
  return LANGS[getLang()].locale;
}

export function setLang(lang) {
  if (!LANGS[lang]) return;
  current = lang;
  try {
    globalThis.localStorage?.setItem('lang', lang);
  } catch { /* the choice still holds for this page */ }
  if (typeof document !== 'undefined') {
    document.documentElement.lang = lang;
    document.dispatchEvent(new CustomEvent('langchange', { detail: { lang } }));
  }
}

export function t(key, vars = {}) {
  const s = MESSAGES[getLang()][key] ?? MESSAGES.en[key] ?? key;
  return typeof s === 'string' ? s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '') : s;
}

// Static markup: data-i18n sets the text, data-i18n-aria the aria-label, data-i18n-title the title.
export function translate(root = document) {
  if (root === document) document.documentElement.lang = getLang();
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
  for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
}
