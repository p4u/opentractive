import { register, t } from '../i18n.js';
import dict from '../i18n/telegram.js';
import { getTelegram, createPairing, deleteChat, updateChat, telegramTest } from '../api.js';
import { esc, icon, badge, statusLine, emptyState, loadBlock, toast, apiErrorText, confirmDialog, every } from '../ui.js';
import { fmtDateTime, countdown } from '../format.js';

register(dict);

const SEV = ['info', 'warn', 'critical'];
const MUTES = [0, 30, 120, 480];
const card = (id, title, body) => `<section class="card" data-testid="${id}"><div class="card-head"><h2 class="card-title">${esc(title)}</h2></div>${body}</section>`;

export async function render(root, ctx) {
  const { signal } = ctx;
  root.innerHTML = `<header class="view-head"><h1 class="view-title">${esc(t('telegram.title'))}</h1></header><div data-main></div>`;
  const main = root.querySelector('[data-main]');
  let data = null;
  let pollId = null;
  let tickId = null;
  const stop = () => { clearInterval(pollId); clearInterval(tickId); pollId = tickId = null; };
  const nowS = () => Math.floor(Date.now() / 1000);

  const statusCard = () => {
    const d = data;
    const s = !d.enabled ? statusLine({ state: 'warn', title: t('telegram.off') })
      : d.lastError ? statusLine({ state: 'alarm', title: t('telegram.error', { error: d.lastError }) })
        : statusLine({ state: 'ok', title: t('telegram.running', { name: d.botName ?? '' }) });
    return `<div data-testid="tg-status">${s}</div>`;
  };

  const pairingCard = () => {
    const p = data.pairing && data.pairing.expiresAt > nowS() ? data.pairing : null;
    const body = `<button type="button" class="pill pill-primary" data-testid="tg-pair"${data.enabled ? '' : ' disabled'}>${icon('link', { size: 16 })}${esc(t('telegram.pair'))}</button>
      ${p ? `<p class="code num" data-testid="tg-code">${esc(p.code)}</p><p class="hint" data-count>${esc(t('telegram.expires', { time: countdown(p.expiresAt - nowS()) }))}</p>
        <ol class="steps"><li>${esc(t('telegram.step1', { name: data.botName ?? '' }).slice(3))}</li><li>${esc(t('telegram.step2', { code: p.code }).slice(3))}</li><li>${esc(t('telegram.step3').slice(3))}</li></ol>` : ''}`;
    return card('tg-pairing', t('telegram.pairing'), body);
  };

  const chatRow = (c) => {
    const muted = c.muted_until && c.muted_until > nowS();
    return `<li class="chat" data-testid="tg-chat-row" data-id="${esc(c.chat_id)}">
      <div class="chat-info"><p class="chat-name">${esc(c.name ?? c.chat_id)}</p><p class="hint num">${esc(c.chat_id)} · ${esc(t('telegram.approved', { time: fmtDateTime(c.approved_at == null ? null : c.approved_at * 1000) }))}</p>
        <p>${c.mute_all ? badge(t('telegram.muteAll'), 'warn') : ''} ${muted ? badge(t('telegram.mutedUntil', { time: fmtDateTime(c.muted_until * 1000) }), 'warn') : ''}</p></div>
      <div class="field"><label for="sev-${esc(c.chat_id)}">${esc(t('telegram.alerts'))}</label><select id="sev-${esc(c.chat_id)}" data-sev>${SEV.map((s) => `<option value="${s}"${c.min_severity === s ? ' selected' : ''}>${esc(t(`telegram.sev.${s}`))}</option>`).join('')}</select></div>
      <div class="field"><label for="mute-${esc(c.chat_id)}">${esc(t('telegram.mute'))}</label><select id="mute-${esc(c.chat_id)}" data-mute>${muted ? `<option value="keep" selected>${esc(t('telegram.mute.keep'))}</option>` : ''}${MUTES.map((m) => `<option value="${m}"${!muted && m === 0 ? ' selected' : ''}>${esc(t(`telegram.mute.${m}`))}</option>`).join('')}</select></div>
      <button type="button" class="pill pill-outline" data-remove>${icon('trash-2', { size: 16 })}${esc(t('telegram.remove'))}</button></li>`;
  };

  const chatsCard = () => card('tg-chats', t('telegram.chats'), data.chats.length
    ? `<ul class="plain">${data.chats.map(chatRow).join('')}</ul>`
    : emptyState({ title: t('telegram.chats.empty'), body: t('telegram.chats.emptyBody') }));

  const cmdCard = () => card('tg-commands', t('telegram.commands'), `<dl class="cmds">${t('telegram.cmd').map(([c, d]) => `<div><dt><code>${esc(c)}</code></dt><dd>${esc(d)}</dd></div>`).join('')}</dl>`);

  function paint() {
    stop();
    main.innerHTML = `<div class="grid"><div class="span-12">${statusCard()}</div><div class="span-6">${pairingCard()}</div>
      <div class="span-6">${card('tg-test-card', t('telegram.test'), `<button type="button" class="pill pill-outline" data-testid="tg-test"${data.enabled ? '' : ' disabled'}>${icon('send', { size: 16 })}${esc(t('telegram.test'))}</button>`)}</div>
      <div class="span-12">${chatsCard()}</div><div class="span-12">${cmdCard()}</div></div>`;
    const p = data.pairing;
    if (p && p.expiresAt > nowS()) {
      // poll while a code is active; stops when it is gone or expired
      pollId = every(3000, async () => {
        try {
          data = await getTelegram();
        } catch { return; }
        if (signal.aborted) return;
        if (!data.pairing || data.pairing.expiresAt <= nowS()) paint();
        else refreshChats();
      }, signal);
      tickId = every(1000, () => {
        const left = p.expiresAt - nowS();
        if (left <= 0) { data.pairing = null; paint(); toast(t('telegram.expired')); return; }
        const el = main.querySelector('[data-count]');
        if (el) el.textContent = t('telegram.expires', { time: countdown(left) });
      }, signal);
    }
  }

  // the code stays on screen while chats update
  function refreshChats() {
    const box = main.querySelector('[data-testid="tg-chats"]')?.parentElement;
    if (box) box.innerHTML = chatsCard();
  }

  main.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.testid === 'tg-pair') {
      b.disabled = true;
      try {
        data.pairing = await createPairing();
        paint();
      } catch (err) { b.disabled = false; toast(apiErrorText(err)); }
    } else if (b.dataset.testid === 'tg-test') {
      b.disabled = true;
      try {
        toast(t('telegram.tested', { n: (await telegramTest()).sent }));
      } catch (err) { toast(apiErrorText(err)); }
      b.disabled = false;
    } else if ('remove' in b.dataset) {
      const id = b.closest('.chat').dataset.id;
      if (!(await confirmDialog({ title: t('telegram.removeConfirm'), body: t('telegram.removeBody'), yes: t('telegram.remove'), no: t('core.cancel') }))) return;
      try {
        await deleteChat(id);
        data.chats = data.chats.filter((c) => c.chat_id !== id);
        toast(t('telegram.removed'));
        refreshChats();
      } catch (err) { toast(apiErrorText(err)); }
    }
  });
  main.addEventListener('change', async (e) => {
    const sel = e.target.closest('select');
    const row = sel?.closest('.chat');
    if (!row) return;
    const patch = sel.dataset.sev !== undefined ? { min_severity: sel.value }
      : sel.value === 'keep' ? null : { muted_until: Number(sel.value) ? nowS() + Number(sel.value) * 60 : null };
    if (!patch) return;
    try {
      const c = await updateChat(row.dataset.id, patch);
      data.chats = data.chats.map((x) => (x.chat_id === c.chat_id ? c : x));
      toast(t('telegram.updated'));
    } catch (err) { toast(apiErrorText(err)); }
    refreshChats();
  });

  await loadBlock(main, 360, async () => {
    data = await getTelegram();
    if (!signal.aborted) paint();
  });
  return stop;
}
