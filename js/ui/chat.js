/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 경기 중 채팅 화면. 새 메시지를 HUD 구석에 잠깐 띄우고, Enter(휴대폰은 채팅 버튼)로 입력칸을 연다.
 *          팀 경기에서는 입력칸 위의 전체·팀 탭이나 Tab 키로 보낼 범위를 바꾼다. 휴대폰에는 누르면 바로 보내는 빠른 문장이 있다.
 *          보내기와 받기는 game/session.js가 맡는다.
 */
// SKALA 작전 UI — 경기 채팅('chat'). 멀티플레이 경기에서만 session이 띄운다(연습장에는 없다).
//   ui.show('chat', { teamChat })                       teamChat = 팀 채팅을 고를 수 있는 경기인가(팀전·폭파 미션). ui.update로 바꿀 수 있다
//   ui.chat.push({ name, text, team?, system?, me?, scope? })  새 줄. scope 'team'이면 [팀] 표시. 닫혀 있으면 CHAT_UI.fadeMs 동안 보였다가 사라진다
//   ui.chat.open() · close() · isOpen() · clear() · scope() · setScope('all' | 'team')
//   이벤트(ui.on): 'chat:send' { text, scope } · 'chat:open' · 'chat:close' · 'chat:scope' { scope }
//   PC는 포인터 잠금을 유지한 채 입력칸에 포커스만 준다(마우스 시점·사격은 그대로). Enter = 보내기(빈 칸이면 닫기), Esc = 닫기,
//   Tab = 전체 ↔ 팀(팀 채팅을 고를 수 있을 때). 고른 범위는 그 경기 동안 남는다.
//   휴대폰은 열 때 키보드를 띄우지 않는다. 빠른 문장을 누르거나, 입력칸을 눌러 직접 친다. 범위는 탭을 눌러 바꾼다.
import { h, teamKey } from './dom.js';

export const CHAT_UI = Object.freeze({
  keep: 40,          // 들고 있는 줄
  fadeMs: 9000,      // 닫혀 있을 때 새 줄이 보이는 시간
  len: 120,          // 한 줄 최대 글자(session·protocol과 같다)
  touchIdleMs: 12000 // 휴대폰에서 연 채로 아무것도 안 하면 닫는다(입력칸에 포커스가 있으면 기다린다)
});

/** 보낼 범위. 'team'은 같은 팀에게만 간다(session이 팀원에게만 보낸다) */
export const CHAT_SCOPES = Object.freeze(['all', 'team']);
export const CHAT_SCOPE_LABEL = Object.freeze({ all: '전체', team: '팀' });

/** 휴대폰 빠른 문장: 누르면 바로 보낸다 */
export const QUICK_CHAT = Object.freeze(['좋아요 👍', '고마워요 🙏', '도와줘요!', '조심해요!', '따라와요', 'GG']);

const isTouch = () => document.documentElement.classList.contains('pc-touch');
const tidy = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);

/** 입력칸 안내 글자 */
export function chatPlaceholder(scope, teamChat, touch) {
  if (!teamChat) return touch ? '메시지 입력' : 'Enter 보내기 · Esc 닫기';
  const label = CHAT_SCOPE_LABEL[scope] || CHAT_SCOPE_LABEL.all;
  return touch ? `${label} 채팅 메시지` : `${label} 채팅 · Enter 보내기 · Tab 전체/팀 · Esc 닫기`;
}

export function createChat(ctx) {
  let opened = false;
  let idleTimer = null;
  let scope = 'all';
  let teamChat = false;

  const log = h('ol', { class: 'sk-cb-log', 'aria-live': 'polite', 'aria-label': '경기 채팅' });
  const field = h('input', {
    class: 'sk-input sk-cb-input', type: 'text', maxlength: CHAT_UI.len, autocomplete: 'off', spellcheck: 'false',
    enterkeyhint: 'send', 'aria-label': '채팅 입력',
  });
  const tabs = CHAT_SCOPES.map((id) => h('button', {
    type: 'button', class: 'sk-cb-tab', role: 'tab', 'data-scope': id, 'aria-selected': 'false',
    onclick: () => { setScope(id); focusField(); },
  }, CHAT_SCOPE_LABEL[id]));
  const tabBar = h('div', { class: 'sk-cb-tabs', role: 'tablist', 'aria-label': '채팅 범위', hidden: true },
    tabs, h('span', { class: 'sk-cb-tabhint', text: 'Tab 전환' }));
  const quick = h('div', { class: 'sk-cb-quick', role: 'group', 'aria-label': '빠른 문장' },
    QUICK_CHAT.map((text) => h('button', { type: 'button', class: 'sk-cb-q', onclick: () => submit(text) }, text)));
  const form = h('form', { class: 'sk-cb-form', hidden: true, onsubmit: (e) => { e.preventDefault(); submit(field.value); } },
    tabBar,
    h('div', { class: 'sk-cb-row' },
      field,
      h('button', { type: 'submit', class: 'sk-btn sk-btn--primary sk-cb-send' }, '보내기'),
      h('button', { type: 'button', class: 'sk-btn sk-cb-x', 'aria-label': '채팅 닫기', onclick: () => close() }, '✕')),
    quick);
  const box = h('div', { class: 'sk-cb' }, log, form);
  const el = h('section', { class: 'sk-screen sk-chatbox', hidden: true, 'aria-label': '경기 채팅' }, box);

  // Esc는 입력칸에서 닫기. Tab은 전체·팀을 바꾼다(포커스가 버튼으로 빠지면 이동 키가 게임으로 새므로 기본 동작은 늘 막는다).
  // 칸 안의 키는 ui/index.js가 엔진으로 보내지 않는다
  field.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'Tab') {
      e.preventDefault();
      if (teamChat && !e.repeat) setScope(scope === 'team' ? 'all' : 'team');
    }
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

  /** PC는 탭을 눌러도 입력칸에 포커스를 돌려준다. 휴대폰은 키보드가 뜨므로 그대로 둔다 */
  function focusField() {
    if (!opened) return;
    if (isTouch()) { startIdle(); return; }
    try { field.focus({ preventScroll: true }); } catch (err) { field.focus(); }
  }

  function paintScope() {
    for (const tab of tabs) {
      const on = tab.getAttribute('data-scope') === scope;
      tab.classList.toggle('is-on', on);
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    el.classList.toggle('is-team', scope === 'team');
    field.placeholder = chatPlaceholder(scope, teamChat, isTouch());
    field.setAttribute('aria-label', teamChat ? `${CHAT_SCOPE_LABEL[scope]} 채팅 입력` : '채팅 입력');
  }

  /** 보낼 범위를 바꾼다. 팀 채팅을 고를 수 없는 경기면 늘 전체다 */
  function setScope(next) {
    const want = teamChat && next === 'team' ? 'team' : 'all';
    const changed = want !== scope;
    scope = want;
    paintScope();
    if (changed) ctx.emit('chat:scope', { scope });
  }

  function setTeamChat(on) {
    teamChat = !!on;
    tabBar.hidden = !teamChat;
    setScope(scope);
  }

  function submit(raw) {
    const text = tidy(raw, CHAT_UI.len);
    field.value = '';
    if (text) ctx.emit('chat:send', { text, scope });
    close();
  }

  function push(line) {
    if (!line || typeof line !== 'object') return;
    const text = tidy(line.text, line.system ? 200 : CHAT_UI.len);
    if (!text) return;
    const team = line.scope === 'team';
    const li = line.system
      ? h('li', { class: 'sk-cb-line sk-cb-sys', text })
      : h('li', { class: 'sk-cb-line' + (line.me ? ' is-me' : '') + (team ? ' is-team' : '') },
        team ? h('span', { class: 'sk-cb-tag', text: CHAT_SCOPE_LABEL.team }) : null,
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
    paintScope();
    log.scrollTop = log.scrollHeight;
    if (isTouch()) startIdle();                      // 휴대폰은 키보드가 화면을 덮으니 바로 띄우지 않는다
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
    const active = document.activeElement;
    if (active && (active === field || tabs.includes(active))) active.blur();
    ctx.emit('chat:close', {});
  }

  function apply(p) {
    if (p && typeof p === 'object' && 'teamChat' in p) setTeamChat(p.teamChat);
  }

  const api = {
    el,
    visible: false,
    show(p) {
      // 새 경기: 범위는 전체부터. 같은 경기에서 다시 보일 때(일시정지 뒤 등)는 고른 범위를 둔다
      if (!api.visible) { api.visible = true; el.hidden = false; scope = 'all'; }
      apply(p);
      paintScope();
    },
    update(p) { apply(p); },
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
    scope: () => scope,
    setScope,
    clear() { log.replaceChildren(); },
    dispose() { close(); el.remove(); },
  };
  return api;
}
