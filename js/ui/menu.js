/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 메인 메뉴. 플레이어 카드(닉네임·포인트·마이페이지)와 멀티플레이(가장 큰 버튼), 연습장, 좀비 물량 막기, 상점, 설정, 조작법, 건의하기 버튼을 보여 준다.
 *          닉네임 입력은 없다. 처음 정하는 곳은 닉네임 게이트, 바꾸는 곳은 마이페이지다.
 *          건의하기: 이 기기에서 보낸 적이 있으면 5분에 한 번까지 내 건의를 읽어, 운영자의 새 답이 있으면 버튼에 표시를 켠다(ui/feedback.js).
 */
import { h, btn, setText } from './dom.js';
import { makeScreen, createModal, pointsBadge } from './parts.js';
import { menuBackdrop, uiIcon } from './icons.js';
import { createSettingsPanel } from './settings.js';
import { createControlsPanel } from './controls.js';
import { createFeedbackPanel, readFeedbackLocal } from './feedback.js';
import { latestReplyAt } from '../account/feedback.js';

const MULTI_SUB = '방을 만들거나 참가해요';
// 작은 버튼은 넷이 한 줄이라 설명을 짧게 쓴다(두 줄 안)
const FEEDBACK_SUB = '운영자에게 바로';
const FEEDBACK_NEW = '새 답이 왔어요';
const REPLY_CHECK_MS = 5 * 60 * 1000;
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
  const feedbackPanel = createFeedbackPanel(ctx, { onClose: () => modal.close(), where: 'menu', onSeen: () => setReplyDot(false) });

  const start = (action) => ctx.emit(action, { name: ctx.playerName, account: !!ctx.account });

  // ---------- 플레이어 카드 ----------
  const nameText = h('strong', { class: 'sk-name-text' });
  const points = pointsBadge('sk-points--big');
  const myPageBtn = btn('마이페이지', () => start('menu:mypage'), 'sk-player-mypage');

  // ---------- 버튼 ----------
  const multiBtn = menuBtn('globe', '멀티플레이', MULTI_SUB, () => start('menu:multi'), 'sk-menu-btn--main');
  const sandboxBtn = menuBtn('target', '연습장', '맵과 모드, 봇을 골라 연습해요', () => start('menu:sandbox'), 'sk-menu-btn--wide');
  // 연습장 설정 시트를 좀비 모드로 연다(친구와 하려면 멀티플레이의 좀비 방). 글에 '연습장'을 넣지 않는다(QA가 글로 버튼을 찾는다)
  const zombieBtn = menuBtn('skull', '좀비 물량 막기', '스테이지마다 몰려오는 좀비를 버텨요', () => start('menu:zombie'), 'sk-menu-btn--wide sk-menu-btn--zombie');
  const shopBtn = menuBtn('bag', '상점', '포인트로 장비 사기', () => start('menu:shop'), 'sk-menu-btn--sub');
  const settingsBtn = menuBtn('gear', '설정', '감도·줌·볼륨', () => {
    settingsPanel.refresh();
    modal.open(settingsPanel.el);
  }, 'sk-menu-btn--sub');
  const controlsBtn = menuBtn('keys', '조작법', document.documentElement.classList.contains('pc-touch') ? '터치 조작·이동' : '키 배치·이동 기술', () => modal.open(controlsPanel.el), 'sk-menu-btn--sub');
  const feedbackBtn = menuBtn('mail', '건의하기', FEEDBACK_SUB, () => {
    feedbackPanel.refresh();
    modal.open(feedbackPanel.el);
  }, 'sk-menu-btn--sub');
  const multiNote = h('p', { class: 'sk-menu-note', role: 'status' });

  // 운영자의 새 답 표시
  let replyCheckAt = 0;
  function setReplyDot(on) {
    feedbackBtn.el.classList.toggle('has-new', !!on);
    setText(feedbackBtn.subEl, on ? FEEDBACK_NEW : FEEDBACK_SUB);
  }
  function checkReplies() {
    const a = ctx.account;
    if (!a || a.feedbackBox !== 'open' || typeof a.myFeedback !== 'function') return;
    if (!readFeedbackLocal().sent || Date.now() - replyCheckAt < REPLY_CHECK_MS) return;
    replyCheckAt = Date.now();
    a.myFeedback()
      .then((r) => { if (r && r.ok && latestReplyAt(r.items) > readFeedbackLocal().seen) setReplyDot(true); })
      .catch(() => { /* 다음 확인 때 다시 */ });
  }

  const el = h('section', { class: 'sk-screen sk-page sk-menu', hidden: true, 'aria-label': '메인 메뉴' },
    menuBackdrop(),
    h('div', { class: 'sk-menu-wrap' },
      h('header', { class: 'sk-brand' },
        h('h1', { class: 'sk-brand-title', text: 'SKALA 작전' }),
        h('p', { class: 'sk-brand-tag', text: '빠르게 달리고, 정확하게 쏘는 브라우저 FPS' })),
      h('section', { class: 'sk-player sk-steel', 'aria-label': '플레이어' },
        h('div', { class: 'sk-name-view' },
          h('span', { class: 'sk-name-ico' }, uiIcon('user')),
          nameText),
        points.el,
        myPageBtn),
      h('nav', { class: 'sk-menu-nav', 'aria-label': '메뉴' },
        multiBtn.el, sandboxBtn.el, zombieBtn.el, shopBtn.el, settingsBtn.el, controlsBtn.el, feedbackBtn.el),
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
    // 건의는 온라인 서버로만 간다
    feedbackBtn.el.hidden = !ctx.account || !ctx.account.remoteEnabled;
    if (!feedbackBtn.el.hidden) checkReplies();

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
