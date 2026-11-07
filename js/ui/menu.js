/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 메인 메뉴. 플레이어 카드(닉네임·포인트·마이페이지)와 빠른 시작, 연습장, 멀티플레이, 상점, 설정, 조작법 버튼을 보여 준다.
 *          닉네임 입력은 없다. 처음 정하는 곳은 닉네임 게이트, 바꾸는 곳은 마이페이지다.
 */
import { h, btn, setText } from './dom.js';
import { makeScreen, createModal, pointsBadge } from './parts.js';
import { menuBackdrop, uiIcon } from './icons.js';
import { createSettingsPanel } from './settings.js';
import { createControlsPanel } from './controls.js';

const QUICK_SUB = '지난 설정으로 바로 출격';
const MULTI_SUB = '방을 만들거나 참가해요';
const NO_SERVER_NOTE = '온라인 서버가 설정되지 않아 멀티플레이를 쓸 수 없어요. 연습장과 상점은 그대로 쓸 수 있어요.';

function menuBtn(icon, label, sub, onClick, cls = '') {
  const subEl = h('span', { class: 'sk-menu-sub', text: sub });
  const iconBox = h('span', { class: 'sk-menu-ico' }, uiIcon(icon));
  const el = h('button', { type: 'button', class: 'sk-menu-btn' + (cls ? ' ' + cls : ''), onclick: onClick },
    iconBox,
    h('span', { class: 'sk-menu-txt' },
      h('span', { class: 'sk-menu-label', text: label }),
      subEl));
  return { el, subEl, iconBox };
}

export function createMenu(ctx) {
  const modal = createModal();
  const settingsPanel = createSettingsPanel(ctx, { onClose: () => modal.close() });
  const controlsPanel = createControlsPanel({ onClose: () => modal.close() });

  const start = (action) => ctx.emit(action, { name: ctx.playerName, account: !!ctx.account });

  // ---------- 플레이어 카드 ----------
  const nameText = h('strong', { class: 'sk-name-text' });
  const points = pointsBadge('sk-points--big');
  const myPageBtn = btn('마이페이지', () => start('menu:mypage'), 'sk-player-mypage');

  // ---------- 버튼 ----------
  const quickBtn = menuBtn('bolt', '빠른 시작', QUICK_SUB, () => start('menu:quick'), 'sk-menu-btn--main');
  const sandboxBtn = menuBtn('target', '연습장', '맵과 모드, 봇을 골라 연습해요', () => start('menu:sandbox'), 'sk-menu-btn--wide');
  const multiBtn = menuBtn('globe', '멀티플레이', MULTI_SUB, () => start('menu:multi'), 'sk-menu-btn--wide');
  const shopBtn = menuBtn('bag', '상점', '포인트로 무기 잠금 해제', () => start('menu:shop'), 'sk-menu-btn--sub');
  const settingsBtn = menuBtn('gear', '설정', '감도 · 줌 · 시야각 · 볼륨', () => {
    settingsPanel.refresh();
    modal.open(settingsPanel.el);
  }, 'sk-menu-btn--sub');
  const controlsBtn = menuBtn('keys', '조작법', '키 배치와 이동 기술', () => modal.open(controlsPanel.el), 'sk-menu-btn--sub');
  const multiNote = h('p', { class: 'sk-menu-note', role: 'status' });

  const el = h('section', { class: 'sk-screen sk-page sk-menu', hidden: true, 'aria-label': '메인 메뉴' },
    menuBackdrop(),
    h('div', { class: 'sk-menu-wrap' },
      h('header', { class: 'sk-brand' },
        h('h1', { class: 'sk-brand-title', text: 'SKALA FPS' }),
        h('p', { class: 'sk-brand-tag', text: '빠르게 달리고, 정확하게 쏘는 브라우저 FPS' })),
      h('section', { class: 'sk-player sk-steel', 'aria-label': '플레이어' },
        h('div', { class: 'sk-name-view' },
          h('span', { class: 'sk-name-ico' }, uiIcon('user')),
          nameText),
        points.el,
        myPageBtn),
      h('nav', { class: 'sk-menu-nav', 'aria-label': '메뉴' },
        quickBtn.el, sandboxBtn.el, multiBtn.el, shopBtn.el, settingsBtn.el, controlsBtn.el),
      multiNote),
    modal.el);

  /** 왜 멀티플레이를 못 쓰는지. 빈 문자열이면 쓸 수 있다. 문자열이 아닌 참이면 사유 없이 끈다. */
  function multiBlock(p) {
    if (ctx.account && !ctx.account.remoteEnabled) return NO_SERVER_NOTE;
    return p.multiDisabled || '';
  }

  function render(p) {
    const profile = ctx.account ? ctx.account.profile : null;
    const name = (profile && profile.nickname) || p.name || ctx.playerName || '플레이어';
    ctx.setPlayerName(name);
    setText(nameText, ctx.playerName);
    points.el.hidden = !profile;
    if (profile) points.set(profile.points);
    myPageBtn.hidden = !ctx.account;
    shopBtn.el.hidden = !ctx.account;
    setText(quickBtn.subEl, p.quickLabel || QUICK_SUB);

    const block = multiBlock(p);
    multiBtn.el.disabled = !!block;
    multiBtn.el.classList.toggle('is-locked', !!block);
    multiBtn.iconBox.replaceChildren(uiIcon(block ? 'lock' : 'globe'));
    setText(multiBtn.subEl, block ? '지금은 쓸 수 없어요' : MULTI_SUB);
    setText(multiNote, typeof block === 'string' ? block : '');
    multiNote.hidden = !multiNote.textContent;
  }

  return makeScreen(el, { render, onHide: () => modal.close() });
}
