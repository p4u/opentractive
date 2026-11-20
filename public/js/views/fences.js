import { register, t } from '../i18n.js';
import dict from '../i18n/fences.js';
import { getGeofences, getSettings, putSettings, createGeofence, updateGeofence, deleteGeofence } from '../api.js';
import { esc, icon, emptyState, fieldError, loadBlock, confirmDialog, apiErrorText } from '../ui.js';
import { createMap, geofenceLayer, layerToGeofence, enableDraw, onCreate } from '../map.js';

register(dict);

const PM_SHAPE = { POLYGON: 'Polygon', RECTANGLE: 'Rectangle', CIRCLE: 'Circle' };
const typeOptions = (cur) => ['SAFE', 'DANGER'].map((v) => `<option value="${v}"${v === cur ? ' selected' : ''}>${esc(t(`fences.type.${v}`))}</option>`).join('');
const ICONS = ['TRACTIVE', 'HOME', 'BONE', 'POISON']; // the icons seen on the account; any other current icon is kept as an option
const iconOptions = (cur = 'TRACTIVE') => [...new Set([cur, ...ICONS])].map((v) =>
  `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(ICONS.includes(v) ? t(`fences.icon.${v}`) : v)}</option>`).join('');

// The body Tractive needs for an update: the stored fence with some fields replaced (the server keeps the icon unless one is sent).
const putBody = (g, over = {}) => {
  const f = { ...g, ...over };
  return { name: f.name, shape: f.shape, coords: f.coords, fence_type: f.fence_type, active: f.active !== false, ...(f.radius != null && { radius: f.radius }), ...(over.icon && { icon: over.icon }), _version: f._version };
};

export async function render(root, ctx) {
  const { state, signal } = ctx;
  const tid = state.followed;
  root.innerHTML = `<header class="view-head"><h1 class="view-title">${esc(t('fences.title'))}</h1></header>
    <p class="hint">${esc(t('fences.explain'))}</p><div class="band" data-body></div>`;
  const body = root.querySelector('[data-body]');
  let map = null;
  let own = null; // listeners on the reloaded container are dropped with each load
  const destroy = () => { map?.remove(); map = null; own?.abort(); };

  const load = () => loadBlock(body, 560, async (el) => {
    destroy();
    own = new AbortController();
    const [list, { settings }] = await Promise.all([getGeofences(tid), getSettings()]);
    if (signal.aborted) return;
    const fences = list.filter((g) => !g.deleted_at);
    const auto = fences.find((g) => g.active !== false && g.fence_type === 'SAFE' && (String(g.name ?? '').toLowerCase() === 'yard' || g.home_flag));
    const yardId = settings.yardGeofenceId ?? auto?._id ?? null;
    el.innerHTML = `<section class="card">
        <div class="fence-draw">${['polygon', 'rectangle', 'circle'].map((s) =>
    `<button type="button" class="pill pill-outline" data-testid="draw-${s}" data-draw="${s}">${icon(s === 'polygon' ? 'hexagon' : s === 'circle' ? 'circle' : 'square', { size: 16 })}${esc(t(`fences.draw.${s}`))}</button>`).join('')}
        <p class="hint">${esc(t('fences.draw.hint'))}</p></div><div class="map" data-testid="fences-map"></div></section>
      <section class="card" data-form hidden></section>
      <section class="card"><div class="card-head"><h2 class="card-title">${esc(t('fences.list.title'))}</h2></div>
        ${fences.length ? `<ul class="fence-list">${fences.map((g) => `<li class="fence-row" data-testid="fence-row" data-id="${esc(g._id)}">
          <p class="subtitle fence-name">${esc(g.name)}</p>
          <div class="field"><label>${esc(t('fences.rename'))}<input type="text" data-testid="fence-rename" maxlength="40" value="${esc(g.name)}"></label></div>
          <div class="fence-fields"><span class="hint">${esc(t(`fences.shape.${g.shape}`))}</span>
            <div class="field"><label>${esc(t('fences.type'))}<select data-type>${typeOptions(g.fence_type)}</select></label></div>
            <div class="field"><label>${esc(t('fences.icon'))}<select data-testid="fence-icon" data-icon>${iconOptions(g.icon)}</select></label></div>
            <label class="inline"><input type="checkbox" class="switch" data-active${g.active !== false ? ' checked' : ''}>${esc(t('fences.active'))}</label>
            <label class="inline"><input type="radio" name="yard" data-testid="fence-yard" value="${esc(g._id)}"${g._id === yardId ? ' checked' : ''}>${esc(t('fences.yard'))}</label></div>
          <div class="fence-actions"><button type="button" class="pill pill-outline" data-testid="fence-edit">${icon('pencil', { size: 16 })}${esc(t('fences.edit'))}</button>
            <button type="button" class="pill pill-primary" data-testid="fence-edit-save" hidden>${esc(t('fences.edit.save'))}</button>
            <button type="button" class="pill pill-outline" data-edit-cancel hidden>${esc(t('fences.cancel'))}</button>
            <button type="button" class="pill pill-outline" data-testid="fence-delete">${icon('trash-2', { size: 16 })}${esc(t('fences.delete'))}</button></div>
          <div data-err></div></li>`).join('')}</ul>
          <div class="fence-auto"><label class="inline"><input type="radio" name="yard" data-yard-auto value=""${yardId ? '' : ' checked'}>${esc(t('fences.yard.auto'))}</label>
          <p class="hint">${esc(t('fences.yard.autoHint'))}</p></div>`
    : emptyState({ title: t('fences.empty.title'), body: t('fences.empty.body') })}</section>`;

    const L = globalThis.L;
    ({ map } = createMap(el.querySelector('[data-testid="fences-map"]')));
    const layers = new Map();
    for (const g of fences) {
      const layer = geofenceLayer(g).addTo(map);
      layer.bindTooltip(document.createTextNode(g.name)); // a text node keeps a Tractive name inert
      layers.set(g._id, layer);
    }
    const mine = L.featureGroup([...layers.values()]);
    if (layers.size) map.fitBounds(mine.getBounds(), { maxZoom: 19, padding: [24, 24] });
    else {
      const p = state.trackers?.find((x) => x.followed)?.position;
      map.setView(p ? [p.lat, p.lng] : [20, 0], p ? 18 : 2);
    }

    // ---- drawing ----
    const form = el.querySelector('[data-form]');
    let pending = null;
    const closeForm = () => { if (pending) map.removeLayer(pending.layer); pending = null; form.hidden = true; form.innerHTML = ''; };
    el.querySelectorAll('[data-draw]').forEach((b) => b.addEventListener('click', () => { closeForm(); enableDraw(map, PM_SHAPE[b.dataset.draw.toUpperCase()]); }));
    onCreate(map, (layer, shape) => {
      pending = { layer, shape };
      form.hidden = false;
      form.innerHTML = `<form class="fence-form" data-testid="fence-form" novalidate><h2 class="card-title">${esc(t('fences.form.title'))}</h2>
        <div class="field"><label for="fence-name">${esc(t('fences.name'))}</label>
          <input id="fence-name" data-testid="fence-name" type="text" required maxlength="40" autocomplete="off"><p class="hint">${esc(t('fences.name.hint'))}</p><div data-name-err></div></div>
        <div class="field"><label for="fence-type">${esc(t('fences.type'))}</label><select id="fence-type" data-fence-type>${typeOptions('SAFE')}</select></div>
        <label class="inline"><input type="checkbox" class="switch" data-fence-active checked>${esc(t('fences.active'))}</label>
        <div data-form-err></div>
        <div class="actions"><button type="submit" class="pill pill-primary" data-testid="fence-save">${esc(t('fences.save'))}</button>
          <button type="button" class="pill pill-outline" data-cancel>${esc(t('fences.cancel'))}</button></div></form>`;
      form.querySelector('[data-cancel]').addEventListener('click', closeForm);
      form.querySelector('form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const nameErr = form.querySelector('[data-name-err]'), formErr = form.querySelector('[data-form-err]');
        const name = form.querySelector('[data-testid="fence-name"]').value.trim();
        nameErr.innerHTML = formErr.innerHTML = '';
        if (name.length < 1 || name.length > 40) { nameErr.innerHTML = fieldError(t('fences.name.hint')); return; }
        try {
          await createGeofence(tid, { name, fence_type: form.querySelector('[data-fence-type]').value, active: form.querySelector('[data-fence-active]').checked, ...layerToGeofence(layer, shape) });
          pending = null; // the reload draws the saved fence
          await load();
        } catch (err) {
          const f = err.body?.fields ?? {};
          if (f.name) nameErr.innerHTML = fieldError(f.name);
          const rest = Object.entries(f).filter(([k]) => k !== 'name').map(([k, v]) => `${k}: ${v}`).join('; ');
          if (rest || !f.name) formErr.innerHTML = fieldError(rest || apiErrorText(err));
        }
      });
      form.querySelector('[data-testid="fence-name"]').focus();
    });

    // ---- list ----
    const byId = new Map(fences.map((g) => [g._id, g]));
    const rowOf = (n) => n.closest('[data-testid="fence-row"]');
    const fail = (row, err) => {
      const slot = row.querySelector('[data-err]');
      slot.innerHTML = fieldError(err.status === 409 ? t('fences.conflict') : apiErrorText(err))
        + (err.status === 409 ? `<button type="button" class="pill pill-outline" data-reload>${esc(t('fences.reload'))}</button>` : '');
      slot.querySelector('[data-reload]')?.addEventListener('click', load);
    };
    const save = async (row, over, extra) => {
      try {
        await updateGeofence(row.dataset.id, putBody(byId.get(row.dataset.id), { ...over, ...extra }));
        await load();
      } catch (err) { fail(row, err); }
    };
    el.addEventListener('change', async (e) => {
      const row = rowOf(e.target);
      if (e.target.matches('[data-testid="fence-rename"]')) {
        const name = e.target.value.trim();
        if (name && name !== byId.get(row.dataset.id).name) await save(row, { name });
      } else if (e.target.matches('[data-type]')) await save(row, { fence_type: e.target.value });
      else if (e.target.matches('[data-icon]')) await save(row, { icon: e.target.value });
      else if (e.target.matches('[data-active]')) await save(row, { active: e.target.checked });
      else if (e.target.matches('[name="yard"]')) {
        try {
          await putSettings({ ...settings, yardGeofenceId: e.target.value || null });
          settings.yardGeofenceId = e.target.value || null;
        } catch (err) { if (row) fail(row, err); else el.querySelector('[data-yard-auto]').closest('label').after(Object.assign(document.createElement('div'), { innerHTML: fieldError(apiErrorText(err)) })); }
      }
    }, { signal: own.signal });
    el.addEventListener('click', async (e) => {
      const row = rowOf(e.target);
      const btn = e.target.closest('button');
      if (!row || !btn) return;
      const g = byId.get(row.dataset.id), layer = layers.get(row.dataset.id);
      const edit = (on) => {
        row.querySelector('[data-testid="fence-edit"]').hidden = on;
        row.querySelector('[data-testid="fence-edit-save"]').hidden = !on;
        row.querySelector('[data-edit-cancel]').hidden = !on;
      };
      if (btn.matches('[data-testid="fence-edit"]')) { layer.pm.enable(); edit(true); } else if (btn.matches('[data-edit-cancel]')) load();
      else if (btn.matches('[data-testid="fence-edit-save"]')) await save(row, {}, layerToGeofence(layer, PM_SHAPE[g.shape]));
      else if (btn.matches('[data-testid="fence-delete"]')) {
        if (!await confirmDialog({ title: t('fences.delete.title', { name: g.name }), body: t('fences.delete.body'), yes: t('fences.delete'), no: t('fences.cancel') })) return;
        try {
          await deleteGeofence(g._id);
          await load();
        } catch (err) { fail(row, err); }
      }
    }, { signal: own.signal });
  });

  await load();
  document.addEventListener('themechange', load, { signal });
  return destroy;
}
