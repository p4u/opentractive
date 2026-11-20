// Login page. No inline script (CSP). The DOM wiring is guarded so tests can import safeNext under Node.
import { register, t, translate } from './i18n.js';
import core from './i18n/core.js';

// Where to go after login: only a path on this origin, anything else goes home (no open redirect).
export function safeNext(next, origin) {
  try {
    const u = new URL(next || '/', origin);
    return u.origin === origin ? u.pathname + u.search + u.hash : '/';
  } catch {
    return '/';
  }
}

if (typeof document !== 'undefined') {
  register(core);
  const $ = (id) => document.getElementById(id);
  const form = $('login');
  const input = $('password');
  const submit = $('submit');
  const errorText = $('login-error-text');
  const reveal = $('reveal');
  let errorKey = null;
  let errorVars = {};

  const showError = (key, vars = {}) => {
    [errorKey, errorVars] = [key, vars];
    errorText.textContent = key ? t(key, vars) : '';
    if (key) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  };

  const paint = () => {
    translate();
    const shown = input.type === 'text';
    reveal.setAttribute('aria-label', t(shown ? 'core.login.hide' : 'core.login.show'));
    reveal.title = reveal.getAttribute('aria-label');
    if (errorKey) showError(errorKey, errorVars);
  };

  reveal.addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    reveal.querySelector('use').setAttribute('href', `/icons.svg#${show ? 'eye-off' : 'eye'}`);
    paint();
    input.focus();
  });

  input.addEventListener('input', () => {
    if (errorKey) showError(null);
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!input.value) {
      input.focus();
      return;
    }
    showError(null);
    submit.disabled = true;
    submit.textContent = t('core.login.submitting');
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: input.value }),
      });
      if (res.status === 204) {
        location.assign(safeNext(new URLSearchParams(location.search).get('next'), location.origin));
        return;
      }
      if (res.status === 429) showError('core.login.tooMany', { min: Math.max(1, Math.ceil(Number(res.headers.get('retry-after')) / 60) || 1) });
      else showError(res.status === 401 ? 'core.login.wrong' : 'core.login.failed');
    } catch {
      showError('core.login.offline');
    }
    submit.disabled = false;
    submit.textContent = t('core.login.submit');
    input.select();
  });

  paint();
}
