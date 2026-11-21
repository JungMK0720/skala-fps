/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 메인 메뉴 = 작전 지휘소(COMMAND). 맨 위 상태 줄(● 운영 중 // 서울 // 시각 Z, 대원 이름, 포인트), 왼쪽 작전 레일(연습장·좀비 물량 막기·무기고·설정·조작법·건의하기),
 *          가운데 3D 대원 무대(.sk-operator-stage, 지금은 빈 격자 무대이고 나중에 캔버스를 붙인다), 오른쪽 요원 기록(전적), 아래 출격 버튼(멀티플레이)을 둔다.
 *          닉네임 입력은 없다. 처음 정하는 곳은 닉네임 게이트, 바꾸는 곳은 요원 기록부(마이페이지)다.
 *          좀비 물량 막기는 작은 시트에서 '같이 하기'(공개 좀비 방을 바로 만든다)와 '혼자 하기'(좀비 모드를 고른 연습장 시트) 중 하나를 고르고 [확인]을 누른다.
 *          건의하기: 이 기기에서 보낸 적이 있으면 5분에 한 번까지 내 건의를 읽어, 운영자의 새 답이 있으면 버튼에 표시를 켠다(ui/feedback.js).
 */
import { h, svg, btn, setText, fmtPlayTime } from './dom.js';
import { makeScreen, createModal, pointsBadge, sheet } from './parts.js';
import { uiIcon } from './icons.js';
import { createSettingsPanel } from './settings.js';
import { createControlsPanel } from './controls.js';
import { createFeedbackPanel, readFeedbackLocal } from './feedback.js';
import { latestReplyAt } from '../account/feedback.js';
import { BRAND } from '../core/brand.js';
import { AVATARS, DEFAULT_AVATAR, avatarById } from '../core/avatar-defs.js';
import { t, loc, fmtNum } from '../core/i18n.js';

const MULTI_SUB = t('menu.multiSub');
// 레일 버튼의 설명은 한 줄 안에 들어가게 짧게 쓴다
const FEEDBACK_SUB = t('menu.feedbackSub');
const FEEDBACK_NEW = t('menu.feedbackNew');
const REPLY_CHECK_MS = 5 * 60 * 1000;
const CLOCK_MS = 10 * 1000;
const NO_SERVER_NOTE = t('menu.noServerNote');
const ZOMBIE_ROOM_SUB = t('menu.zombieRoomSub');
const ZOMBIE_SOLO_SUB = t('menu.zombieSoloSub');
const UNAVAILABLE = t('menu.unavailable');
/** 상태 줄의 지역 이름(중계 서버가 있는 곳) */
const REGION = t('menu.region');

/** 레일 버튼: 아이콘 + 이름 + 짧은 설명. en은 오른쪽 끝의 작은 영문 라벨, lead는 아이콘 앞에 붙는 요소(출격 버튼의 DEPLOY 표시) */
function menuBtn(icon, label, sub, onClick, cls = '', en = '', lead = null) {
  const subEl = h('span', { class: 'sk-menu-sub', text: sub });
  const iconBox = h('span', { class: 'sk-menu-ico' }, uiIcon(icon));
  const el = h('button', { type: 'button', class: 'sk-menu-btn' + (cls ? ' ' + cls : ''), onclick: onClick },
    lead,
    iconBox,
    h('span', { class: 'sk-menu-txt' },
      h('span', { class: 'sk-menu-label', text: label }),
      subEl),
    en ? h('span', { class: 'sk-menu-en', text: en, 'aria-hidden': 'true' }) : null);
  return { el, subEl, iconBox };
}

/** 빈 무대의 원근 격자 바닥(소실점으로 모이는 선 + 멀수록 촘촘한 가로선). 캔버스를 붙이면 CSS가 숨긴다 */
function stageFloor() {
  const W = 1200;
  const H = 360;
  const vx = W / 2;
  const vy = -260;
  const d = [];
  for (let x = -W; x <= W * 2; x += 80) d.push(`M${vx} ${vy} L${x} ${H}`);
  for (let i = 1; i <= 12; i++) { const y = Math.round(H * (i / 12) ** 2); d.push(`M0 ${y} H${W}`); }
  return svg('svg', { class: 'sk-cmd-floor', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'xMidYMax slice', 'aria-hidden': 'true', focusable: 'false' },
    svg('path', { d: d.join(' ') }));
}

/** 지금 시각(UTC)을 "HH:MMZ"로. 작전 시각은 세계 표준시로 적는다 */
export function zuluTime(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}Z`;
}

/** 전적 → 요원 기록 칸 [이름, 값]. 경기가 없으면 승률은 '—' */
export function dossierRows(stats) {
  const s = stats || {};
  const n = (k) => Math.max(0, Number(s[k]) || 0);
  const matches = n('matches');
  return [
    [t('menu.statMatches'), fmtNum(n('matches'))],
    [t('menu.statWinRate'), matches ? `${Math.round((n('wins') / matches) * 100)}%` : '—'],
    ['K/D', (n('kills') / Math.max(1, n('deaths'))).toFixed(2)],
    [t('menu.statKills'), fmtNum(n('kills'))],
    [t('menu.statHeadshots'), fmtNum(n('headshots'))],
    [t('menu.statPlayTime'), fmtPlayTime(n('secondsPlayed'))],
  ];
}

export function createMenu(ctx) {
  const modal = createModal();
  const settingsPanel = createSettingsPanel(ctx, { onClose: () => modal.close() });
  const controlsPanel = createControlsPanel({ onClose: () => modal.close() });
  const feedbackPanel = createFeedbackPanel(ctx, { onClose: () => modal.close(), where: 'menu', onSeen: () => setReplyDot(false) });

  const start = (action) => ctx.emit(action, { name: ctx.playerName, account: !!ctx.account });

  // ---------- 좀비 물량 막기 고르기: 같이 하기(공개 방) · 혼자 하기 중 하나를 고르고 [확인] ----------
  let zombieBlock = '';
  let zombiePick = 'menu:zombieRoom';
  function zombieOpt(icon, label, sub, action, cls = '') {
    const subEl = h('span', { class: 'sk-zpick-sub', text: sub });
    const el = h('button', { type: 'button', class: 'sk-zpick-opt' + (cls ? ' ' + cls : ''), role: 'radio', 'aria-checked': 'false',
      onclick: () => { zombiePick = action; paintZombiePick(); } },
      h('span', { class: 'sk-zpick-ico', 'aria-hidden': 'true' }, uiIcon(icon)),
      h('span', { class: 'sk-zpick-txt' },
        h('span', { class: 'sk-zpick-label', text: label }),
        subEl));
    return { el, subEl, action };
  }
  const zombieRoom = zombieOpt('squad', t('menu.zombieRoom'), ZOMBIE_ROOM_SUB, 'menu:zombieRoom', 'sk-zpick-opt--room');
  const zombieSolo = zombieOpt('solo', t('menu.zombieSolo'), ZOMBIE_SOLO_SUB, 'menu:zombie');
  /** 시트를 먼저 닫고(포커스가 메뉴로 돌아온 뒤) 고른 쪽을 알린다 */
  const zombieOk = btn(t('menu.ok'), () => { modal.close(); start(zombiePick); }, 'sk-btn--primary sk-zpick-ok');
  const zombieNote = h('p', { class: 'sk-zpick-note', role: 'status', hidden: true });
  const zombieSheet = sheet({
    title: t('menu.zombieTitle'),
    kicker: 'HORDE DEFENSE',
    onClose: () => modal.close(),
    cls: 'sk-zpick',
    body: [h('div', { class: 'sk-zpick-opts', role: 'radiogroup', 'aria-label': t('menu.zombieModeAria') }, zombieRoom.el, zombieSolo.el), zombieNote, zombieOk],
  });
  function paintZombiePick() {
    for (const o of [zombieRoom, zombieSolo]) {
      const on = o.action === zombiePick;
      o.el.classList.toggle('is-on', on);
      o.el.setAttribute('aria-checked', on ? 'true' : 'false');
      o.el.toggleAttribute('data-autofocus', on);   // 시트를 열면 고른 칸에 포커스
    }
  }
  /** 시트를 열 때마다 같이 하기를 고른 채로 연다(멀티플레이를 못 쓰면 혼자 하기) */
  function openZombieSheet() {
    zombiePick = zombieBlock ? 'menu:zombie' : 'menu:zombieRoom';
    paintZombiePick();
    modal.open(zombieSheet);
  }
  /** 멀티플레이를 못 쓰면 '같이 하기'를 끄고 사유를 보여 준다(혼자 하기는 언제나 된다) */
  function syncZombieSheet(block) {
    zombieBlock = block;
    zombieRoom.el.disabled = !!block;
    setText(zombieRoom.subEl, block ? UNAVAILABLE : ZOMBIE_ROOM_SUB);
    setText(zombieNote, typeof block === 'string' ? block : '');
    zombieNote.hidden = !zombieNote.textContent;
    if (block && zombiePick === 'menu:zombieRoom') zombiePick = 'menu:zombie';
    paintZombiePick();
  }

  // ---------- 상태 줄: ● 운영 중 // 서울 // 시각 Z · 대원 이름 · 포인트 ----------
  const liveText = h('span', { class: 'sk-cmd-live-text', text: t('menu.live') });
  const live = h('span', { class: 'sk-cmd-live' }, h('i', { class: 'sk-cmd-dot', 'aria-hidden': 'true' }), liveText);
  const clock = h('time', { class: 'sk-cmd-clock' });
  const nameText = h('strong', { class: 'sk-name-text' });
  const points = pointsBadge('sk-points--strip');

  // ---------- 출격(멀티플레이)과 레일 버튼 ----------
  const multiBtn = menuBtn('globe', t('menu.multi'), MULTI_SUB, () => start('menu:multi'), 'sk-menu-btn--main sk-deploy', '',
    h('span', { class: 'sk-deploy-kicker', 'aria-hidden': 'true' }, h('span', { text: 'DEPLOY' }), h('span', { class: 'sk-deploy-arrow' }, uiIcon('deploy'))));
  const sandboxBtn = menuBtn('target', t('menu.sandbox'), t('menu.sandboxSub'), () => start('menu:sandbox'), 'sk-menu-btn--wide', 'RANGE');
  // 같이 하기(공개 좀비 방) · 혼자 하기(좀비 모드를 고른 연습장 시트)를 고르는 시트를 연다. 글에 '연습장'을 넣지 않는다(QA가 글로 버튼을 찾는다)
  const zombieBtn = menuBtn('skull', t('menu.zombieTitle'), t('menu.zombieSub'), openZombieSheet, 'sk-menu-btn--wide sk-menu-btn--zombie', 'HORDE');
  const shopBtn = menuBtn('armory', t('menu.shop'), t('menu.shopSub'), () => start('menu:shop'), 'sk-menu-btn--sub', 'ARMORY');
  const settingsBtn = menuBtn('gear', t('menu.settings'), t('menu.settingsSub'), () => {
    settingsPanel.refresh();
    modal.open(settingsPanel.el);
  }, 'sk-menu-btn--sub', 'SETUP');
  const controlsBtn = menuBtn('keys', t('menu.controls'), document.documentElement.classList.contains('pc-touch') ? t('menu.controlsSubTouch') : t('menu.controlsSub'), () => modal.open(controlsPanel.el), 'sk-menu-btn--sub', 'KEYS');
  const feedbackBtn = menuBtn('mail', t('menu.feedback'), FEEDBACK_SUB, () => {
    feedbackPanel.refresh();
    modal.open(feedbackPanel.el);
  }, 'sk-menu-btn--sub', 'COMMS');
  const multiNote = h('p', { class: 'sk-menu-note', role: 'status' });

  // ---------- 가운데 무대: 3D 대원을 올릴 자리(나중에 캔버스를 operatorStage에 붙인다) ----------
  const stageName = h('b', { class: 'sk-cmd-stage-name' });
  const stageUnit = h('span', { class: 'sk-cmd-stage-unit sk-mono' });
  const operatorStage = h('div', { class: 'sk-operator-stage', 'data-operator-stage': '', 'aria-hidden': 'true' },
    stageFloor(), h('i', { class: 'sk-cmd-plinth' }), h('i', { class: 'sk-cmd-scan' }));
  const stage = h('div', { class: 'sk-cmd-stage sk-frame' },
    operatorStage,
    h('p', { class: 'sk-kicker sk-cmd-stage-tag', text: 'OPERATOR PREVIEW' }),
    h('div', { class: 'sk-cmd-stage-label' }, stageUnit, stageName));

  // ---------- 오른쪽 요원 기록: 전적(계정이 있을 때) ----------
  const dossierList = h('dl', { class: 'sk-cmd-stats' });
  const dossierEmpty = h('p', { class: 'sk-note', text: t('menu.dossierEmpty') });
  const myPageBtn = btn([uiIcon('file'), h('span', { text: t('menu.myPage') })], () => start('menu:mypage'), 'sk-player-mypage');
  const dossier = h('aside', { class: 'sk-cmd-dossier sk-steel', 'aria-label': t('menu.dossier') },
    h('p', { class: 'sk-kicker', text: 'DOSSIER' }),
    h('h2', { class: 'sk-cmd-h2', text: t('menu.dossier') }),
    dossierList, dossierEmpty, myPageBtn);

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

  const el = h('section', { class: 'sk-screen sk-page sk-menu', hidden: true, 'aria-label': t('menu.commandAria') },
    h('div', { class: 'sk-cmd' },
      h('header', { class: 'sk-cmd-strip' },
        h('div', { class: 'sk-cmd-sys' }, live, h('span', { class: 'sk-cmd-sep', text: '//', 'aria-hidden': 'true' }),
          h('span', { text: REGION }), h('span', { class: 'sk-cmd-sep', text: '//', 'aria-hidden': 'true' }), clock),
        h('div', { class: 'sk-brand' },
          h('h1', { class: 'sk-brand-title', text: loc(BRAND, 'name') }),
          h('span', { class: 'sk-brand-en sk-mono', text: `${BRAND.nameEn} // COMMAND`, 'aria-hidden': 'true' })),
        h('section', { class: 'sk-player', 'aria-label': t('menu.operatorAria') },
          h('span', { class: 'sk-name-ico' }, uiIcon('user')),
          nameText,
          points.el)),
      h('nav', { class: 'sk-menu-nav', 'aria-label': t('menu.navAria') },
        multiBtn.el,
        h('div', { class: 'sk-cmd-rail' },
          h('p', { class: 'sk-kicker sk-kicker-dim', text: 'OPERATIONS' }),
          sandboxBtn.el, zombieBtn.el,
          h('p', { class: 'sk-kicker sk-kicker-dim', text: 'SUPPORT' }),
          shopBtn.el, settingsBtn.el, controlsBtn.el, feedbackBtn.el)),
      stage,
      dossier,
      multiNote),
    modal.el);

  let clockTimer = null;
  const tick = () => { const now = new Date(); setText(clock, zuluTime(now)); clock.setAttribute('datetime', now.toISOString()); };

  function renderDossier(profile) {
    dossierEmpty.hidden = !!profile;
    dossierList.hidden = !profile;
    if (profile) {
      dossierList.replaceChildren(...dossierRows(profile.stats).map(([k, v]) => h('div', { class: 'sk-cmd-stat' }, h('dt', { text: k }), h('dd', { class: 'sk-mono', text: v }))));
    }
    const a = ctx.account;
    const av = avatarById(a && a.loadout && a.loadout.avatar) || avatarById(DEFAULT_AVATAR);
    const idx = Math.max(0, AVATARS.findIndex((x) => x.id === av.id));
    setText(stageName, loc(av, 'name'));
    setText(stageUnit, `UNIT ${String(idx + 1).padStart(2, '0')}`);
    operatorStage.dataset.avatar = av.id;
  }

  /** 왜 멀티플레이를 못 쓰는지. 빈 문자열이면 쓸 수 있다. 문자열이 아닌 참이면 사유 없이 끈다. */
  function multiBlock(p) {
    if (ctx.account && !ctx.account.remoteEnabled) return NO_SERVER_NOTE;
    return p.multiDisabled || '';
  }

  function render(p) {
    const profile = ctx.account ? ctx.account.profile : null;
    const name = (profile && profile.nickname) || p.name || ctx.playerName || t('menu.player');
    ctx.setPlayerName(name);
    setText(nameText, ctx.playerName);
    points.el.hidden = !profile;
    if (profile) points.set(profile.points);
    renderDossier(profile);
    myPageBtn.hidden = !ctx.account;
    shopBtn.el.hidden = !ctx.account;
    // 건의는 온라인 서버로만 간다
    feedbackBtn.el.hidden = !ctx.account || !ctx.account.remoteEnabled;
    if (!feedbackBtn.el.hidden) checkReplies();

    const block = multiBlock(p);
    multiBtn.el.disabled = !!block;
    multiBtn.el.classList.toggle('is-locked', !!block);
    multiBtn.iconBox.replaceChildren(uiIcon(block ? 'lock' : 'globe'));
    setText(multiBtn.subEl, block ? UNAVAILABLE : MULTI_SUB);
    setText(liveText, block ? t('menu.offline') : t('menu.live'));
    el.classList.toggle('is-offline', !!block);
    setText(multiNote, typeof block === 'string' ? block : '');
    multiNote.hidden = !multiNote.textContent;
    syncZombieSheet(block);
  }

  const screen = makeScreen(el, {
    render,
    onShow: () => { tick(); if (clockTimer == null) clockTimer = ctx.every(tick, CLOCK_MS); },
    onHide: () => { modal.close(); if (clockTimer != null) { ctx.cancel(clockTimer); clockTimer = null; } },
  });
  /** 가운데 3D 대원 무대. 3D 미리 보기를 붙이는 쪽이 이 요소 안에 캔버스를 넣는다(크기는 CSS가 정한다) */
  screen.operatorStage = operatorStage;
  return screen;
}
