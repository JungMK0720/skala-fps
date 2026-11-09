/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 경기 중 채팅 화면. 새 메시지를 HUD 구석에 잠깐 띄우고, Enter(휴대폰은 채팅 버튼)로 입력칸을 연다.
 *          휴대폰에는 누르면 바로 보내는 빠른 문장이 있다. 보내기와 받기는 game/session.js가 맡는다.
 */
// SKALA 작전 UI — 경기 채팅('chat'). 멀티플레이 경기에서만 session이 띄운다(연습장에는 없다).
//   ui.chat.push({ name, text, team?, system?, me? })  새 줄. 닫혀 있으면 CHAT_UI.fadeMs 동안 보였다가 사라진다
//   ui.chat.open() · close() · isOpen() · clear()
//   이벤트(ui.on): 'chat:send' { text } · 'chat:open' · 'chat:close'
//   PC는 포인터 잠금을 유지한 채 입력칸에 포커스만 준다(마우스 시점·사격은 그대로). Enter = 보내기(빈 칸이면 닫기), Esc = 닫기.
//   휴대폰은 열 때 키보드를 띄우지 않는다. 빠른 문장을 누르거나, 입력칸을 눌러 직접 친다.
import { h, teamKey } from './dom.js';

export const CHAT_UI = Object.freeze({
  keep: 40,          // 들고 있는 줄
  fadeMs: 9000,      // 닫혀 있을 때 새 줄이 보이는 시간
  len: 120,          // 한 줄 최대 글자(session·protocol과 같다)
  touchIdleMs: 12000 // 휴대폰에서 연 채로 아무것도 안 하면 닫는다(입력칸에 포커스가 있으면 기다린다)
});

/** 휴대폰 빠른 문장: 누르면 바로 보낸다 */
export const QUICK_CHAT = Object.freeze(['좋아요 👍', '고마워요 🙏', '도와줘요!', '조심해요!', '따라와요', 'GG']);

const isTouch = () => document.documentElement.classList.contains('pc-touch');
const tidy = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);

export function createChat(ctx) {
  let opened = false;
  let idleTimer = null;

  const log = h('ol', { class: 'sk-cb-log', 'aria-live': 'polite', 'aria-label': '경기 채팅' });
  const field = h('input', {
    class: 'sk-input sk-cb-input', type: 'text', maxlength: CHAT_UI.len, autocomplete: 'off', spellcheck: 'false',
    enterkeyhint: 'send', 'aria-label': '채팅 입력',
  });
  const quick = h('div', { class: 'sk-cb-quick', role: 'group', 'aria-label': '빠른 문장' },
    QUICK_CHAT.map((text) => h('button', { type: 'button', class: 'sk-cb-q', onclick: () => submit(text) }, text)));
  const form = h('form', { class: 'sk-cb-form', hidden: true, onsubmit: (e) => { e.preventDefault(); submit(field.value); } },
    h('div', { class: 'sk-cb-row' },
      field,
      h('button', { type: 'submit', class: 'sk-btn sk-btn--primary sk-cb-send' }, '보내기'),
      h('button', { type: 'button', class: 'sk-btn sk-cb-x', 'aria-label': '채팅 닫기', onclick: () => close() }, '✕')),
    quick);
  const box = h('div', { class: 'sk-cb' }, log, form);
  const el = h('section', { class: 'sk-screen sk-chatbox', hidden: true, 'aria-label': '경기 채팅' }, box);

  // Esc는 입력칸에서 닫기. Tab으로 포커스가 버튼으로 빠지면 이동 키가 게임으로 새므로 막는다. 칸 안의 키는 ui/index.js가 엔진으로 보내지 않는다
  field.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'Tab') e.preventDefault();
  });
  field.addEventListener('focus', () => stopIdle());
  field.addEventListener('blur', () => { if (opened && isTouch()) startIdle(); });

  function stopIdle() {
    if (idleTimer != null) { ctx.cancel(idleTimer); idleTimer = null; }
  }
  function startIdle() {
    stopIdle();
    idleTimer = ctx.later(() => {
      idleTimer = null;
      if (opened && document.activeElement !== field) close();
    }, CHAT_UI.touchIdleMs);
  }

  function submit(raw) {
    const text = tidy(raw, CHAT_UI.len);
    field.value = '';
    if (text) ctx.emit('chat:send', { text });
    close();
  }

  function push(line) {
    if (!line || typeof line !== 'object') return;
    const text = tidy(line.text, line.system ? 200 : CHAT_UI.len);
    if (!text) return;
    const li = line.system
      ? h('li', { class: 'sk-cb-line sk-cb-sys', text })
      : h('li', { class: 'sk-cb-line' + (line.me ? ' is-me' : '') },
        h('b', { class: 'sk-cb-name t-' + (teamKey(line.team) || 'none'), text: tidy(line.name, 24) || '?' }),
        h('span', { class: 'sk-cb-text', text }));
    log.append(li);
    while (log.children.length > CHAT_UI.keep) log.firstElementChild.remove();
    ctx.later(() => li.classList.add('is-old'), CHAT_UI.fadeMs);
    if (opened) log.scrollTop = log.scrollHeight;
  }

  function open() {
    if (!api.visible || opened) return;
    opened = true;
    el.classList.add('is-open');
    form.hidden = false;
    const touch = isTouch();
    field.placeholder = touch ? '메시지 입력' : 'Enter 보내기 · Esc 닫기';
    log.scrollTop = log.scrollHeight;
    if (touch) startIdle();                          // 휴대폰은 키보드가 화면을 덮으니 바로 띄우지 않는다
    else { try { field.focus({ preventScroll: true }); } catch (err) { field.focus(); } }
    ctx.emit('chat:open', {});
  }

  function close() {
    stopIdle();
    if (!opened) return;
    opened = false;
    el.classList.remove('is-open');
    form.hidden = true;
    field.value = '';
    if (document.activeElement === field) field.blur();
    ctx.emit('chat:close', {});
  }

  const api = {
    el,
    visible: false,
    show() {
      if (!api.visible) { api.visible = true; el.hidden = false; }
    },
    update() {},
    hide() {
      close();
      if (!api.visible) return;
      api.visible = false;
      el.hidden = true;
    },
    push,
    open,
    close,
    isOpen: () => opened,
    clear() { log.replaceChildren(); },
    dispose() { close(); el.remove(); },
  };
  return api;
}
