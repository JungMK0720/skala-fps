/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: HUD 화면. 체력·탄약·슬롯·크로스헤어·히트마커·피격 방향·타이머·스코어·킬피드·중앙 메시지·속도계·콜아웃·상단 배너와
 *          개인전 표시(순위, 부활 패널, 보호)를 그린다. hud.set()은 매 프레임 불러도 되고 값이 바뀐 곳만 DOM에 쓴다.
 */
import { h, setText, clamp, fmtTime, num, TEAMS, TEAM_KEYS, teamKey, FFA_TARGET } from './dom.js';
import { makeScreen } from './parts.js';
import { headshotIcon, weaponInfo } from './icons.js';
import { PLAYER, MOVE } from '../core/consts.js';

const KILLFEED_MAX = 5;
const KILLFEED_MS = 5000;
const DMG_MAX = 6;

// 속도계: 막대는 걷기 속도 ~ 이동 상한. 이 값을 넘어야 보인다
const SPEED_SHOW_ABOVE = 5.5;
const SPEED_TINT_LOW = [0x35, 0xe0, 0xff];
const SPEED_TINT_HIGH = [0xff, 0x4d, 0x8d];

// 콜아웃: 줄 DOM과 Animation을 둘씩만 만들어 돌려 쓴다
const CALLOUT_TONES = Object.freeze(['head', 'half', 'kill', 'info']);
const CALLOUT_ROWS = 2;
const CALLOUT_KEYFRAMES = [
  { opacity: 0, transform: 'translateY(0) scale(1.22)', easing: 'ease-out' },
  { opacity: 1, transform: 'translateY(0) scale(1)', offset: 0.1 },
  { opacity: 1, transform: 'translateY(0) scale(1)', offset: 0.72 },
  { opacity: 0, transform: 'translateY(-5px) scale(1)' },
];
const CALLOUT_TIMING = { duration: 1150 };

// 상단 배너: 한 번에 하나씩 보여 주고 나머지는 줄을 세운다
const BANNER_MS = 3200;
const BANNER_OUT_MS = 320; // css .sk-hud-banner의 전환 시간과 맞춘다
const BANNER_QUEUE_MAX = 6;

function autoTone(text) {
  if (/매치 ?포인트|무승부|재경기|연장/.test(text)) return 'warn';
  if (/블루/.test(text) && !/오렌지/.test(text)) return 'owner';
  if (/오렌지/.test(text) && !/블루/.test(text)) return 'charterer';
  return '';
}

/** 수평 속력(m/s) → 속도계 표시 { on, text, ratio, color }. ratio = 걷기 0 ~ 상한 1, 상한에 가까울수록 시안에서 핑크로 */
export function speedGauge(speed) {
  const v = Math.max(0, num(speed, 0));
  const ratio = clamp((v - PLAYER.WALK) / (MOVE.MAX_SPEED - PLAYER.WALK), 0, 1);
  const t = ratio * ratio;
  const [r, g, b] = SPEED_TINT_LOW.map((c, i) => Math.round(c + (SPEED_TINT_HIGH[i] - c) * t));
  return { on: v > SPEED_SHOW_ABOVE, text: v.toFixed(1), ratio, color: `rgb(${r}, ${g}, ${b})` };
}

/** 모르는 tone은 'info' */
export function calloutTone(tone) {
  return CALLOUT_TONES.includes(tone) ? tone : 'info';
}

/** hud.banner 입력 → { icon, title, sub, ms }. 보여 줄 글자가 없으면 null */
export function bannerSpec(o) {
  if (!o || typeof o !== 'object') return null;
  const text = (v) => (v == null ? '' : String(v));
  const title = text(o.title);
  const sub = text(o.sub);
  if (!title && !sub) return null;
  const ms = num(o.ms, BANNER_MS);
  return { icon: text(o.icon), title, sub, ms: ms > 0 ? ms : BANNER_MS };
}

function normSlot(registry, s) {
  if (s == null || s === false || s === '') return null;
  if (typeof s === 'object' && s.id == null && !s.name) return null;
  const info = weaponInfo(registry, s);
  return { id: info.id, icon: info.icon, name: info.short || info.name, full: info.name };
}

/** slots(길이 4 배열 또는 { 1:…, 4:… }) → 네 칸. 칸마다 { id, icon, name, full } 또는 null */
export function normSlots(registry, list) {
  const arr = Array.isArray(list) ? list : list && typeof list === 'object' ? [1, 2, 3, 4].map((n) => list[n]) : [];
  return [0, 1, 2, 3].map((i) => normSlot(registry, arr[i]));
}

export function createHud(ctx) {
  const st = {
    hp: null, maxHp: 100, ammo: undefined, reserve: undefined, mag: undefined, magSeen: 0, hasAmmo: false,
    reload: null, reloading: false, slot: null, slotList: null, slotSig: '', slotSeen: [false, false, false, false],
    weaponName: null, weaponLabel: '',
    spread: 0, spreadPx: null, fov: null, gap: -1, time: undefined, scoreSig: '', aliveSig: '',
    alive: null, size: null, team: null, centerTimer: null, hitAnim: null,
    ffa: false, respSig: '', protect: false,
    speedOn: false, speedTenths: -1, calloutSeq: 0, bannerQueue: [], bannerTimer: null,
  };
  let viewH = 0;

  // ---------- 요소 ----------
  const vignette = h('div', { class: 'sk-vignette', 'aria-hidden': 'true' });
  const flash = h('div', { class: 'sk-flash', 'aria-hidden': 'true' });
  const dmgs = h('div', { class: 'sk-dmgs', 'aria-hidden': 'true' });
  const xhair = h('div', { class: 'sk-xhair', 'aria-hidden': 'true' }, ['t', 'b', 'l', 'r', 'dot'].map((k) => h('i', { class: `sk-xh-${k}` })));
  const hit = h('div', { class: 'sk-hit', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'), h('i'));

  // 크로스헤어 아래 콜아웃
  const calloutRows = Array.from({ length: CALLOUT_ROWS }, () => ({
    el: h('div', { class: 'sk-callout', dataset: { tone: 'info' } }), anim: null, text: '', tone: 'info', seq: 0, rank: 0,
  }));
  const calloutBox = h('div', { class: 'sk-callouts', 'aria-hidden': 'true' }, calloutRows.map((c) => c.el));

  function side(team) {
    const score = h('b', { class: 'sk-ts-score', text: '0' });
    const pips = h('span', { class: 'sk-pips' });
    const aliveN = h('span', { class: 'sk-ts-alive-n' });
    const mp = h('span', { class: 'sk-ts-mp', text: '매치 포인트', hidden: true });
    const el = h('div', { class: `sk-ts sk-ts--${team}` },
      h('div', { class: 'sk-ts-row' }, h('span', { class: 'sk-ts-name', text: TEAMS[team].name }), score),
      h('div', { class: 'sk-ts-alive' }, pips, aliveN),
      mp);
    return { el, score, pips, aliveN, mp };
  }
  const sides = { owner: side('owner'), charterer: side('charterer') };
  const timer = h('div', { class: 'sk-timer', text: '-:--' });
  const tcSub = h('div', { class: 'sk-tc-sub', text: '5판 3선승' });

  // 개인전 스코어: "🎯 7킬 · 2위/5 · 1위 하늘 12 / 20"
  const ffaKills = h('b', { class: 'sk-ts-score', text: '0' });
  const ffaGoal = h('span', { class: 'sk-ts-alive-n sk-ffa-goal' });
  const ffaRank = h('b', { class: 'sk-ts-score', text: '-' });
  const ffaTotal = h('small', { class: 'sk-ffa-total' });
  const ffaLeader = h('span', { class: 'sk-ts-alive-n sk-ffa-leader' });
  const ffaMe = h('div', { class: 'sk-ts sk-ts--ffa sk-ffa-me' },
    h('div', { class: 'sk-ts-row' }, h('span', { class: 'sk-ts-name', text: '🎯 내 킬' }), h('span', { class: 'sk-ffa-kv' }, ffaKills, h('small', { text: '킬' }))),
    h('div', { class: 'sk-ts-alive' }, ffaGoal));
  const ffaStand = h('div', { class: 'sk-ts sk-ts--ffa sk-ffa-stand' },
    h('div', { class: 'sk-ts-row' }, h('span', { class: 'sk-ffa-kv' }, ffaRank, h('small', { text: '위' }), ffaTotal), h('span', { class: 'sk-ts-name', text: '순위' })),
    h('div', { class: 'sk-ts-alive' }, ffaLeader));

  const top = h('div', { class: 'sk-top', role: 'group', 'aria-label': '라운드 스코어' },
    sides.owner.el, ffaMe, h('div', { class: 'sk-tc' }, timer, tcSub), ffaStand, sides.charterer.el);

  // 상단 배너(비밀 스팟 발견 등)
  const bannerIco = h('span', { class: 'sk-hud-banner-ico', hidden: true, 'aria-hidden': 'true' });
  const bannerTitle = h('b', { class: 'sk-hud-banner-title', hidden: true });
  const bannerSub = h('span', { class: 'sk-hud-banner-sub', hidden: true });
  const bannerEl = h('div', { class: 'sk-hud-banner', role: 'status' },
    bannerIco, h('div', { class: 'sk-hud-banner-text' }, bannerTitle, bannerSub));

  const hpNum = h('b', { class: 'sk-hp-num', text: '100' });
  const hpFill = h('i');
  const hpEl = h('div', { class: 'sk-hp' },
    h('span', { class: 'sk-hp-ico', text: '✚', 'aria-hidden': 'true' }),
    h('div', { class: 'sk-hp-main' },
      h('div', { class: 'sk-hp-top' }, hpNum, h('span', { class: 'sk-hp-label', text: '체력' })),
      h('div', { class: 'sk-hp-bar' }, hpFill)));

  // 속도계(아래 가운데)
  const speedNum = h('b', { class: 'sk-speed-num' });
  const speedFill = h('i');
  const speedEl = h('div', { class: 'sk-speed', 'aria-hidden': 'true' },
    h('div', { class: 'sk-speed-read' }, speedNum, h('small', { class: 'sk-speed-unit', text: 'm/s' })),
    h('div', { class: 'sk-speed-bar' }, speedFill));

  const wpnName = h('span', { class: 'sk-ammo-wpn' });
  const magEl = h('b', { class: 'sk-ammo-mag' });
  const resEl = h('span', { class: 'sk-ammo-res' });
  const ammoRow = h('div', { class: 'sk-ammo-row', hidden: true }, magEl, resEl);
  const ammoHint = h('span', { class: 'sk-ammo-hint' });
  const reloadFill = h('i');
  const reloadBar = h('div', { class: 'sk-reload', hidden: true }, reloadFill);
  const ammoEl = h('div', { class: 'sk-ammo', hidden: true }, wpnName, ammoRow, reloadBar, ammoHint);

  const slotsEl = h('div', { class: 'sk-slots' });
  const slotEls = [1, 2, 3, 4].map((n) => {
    const ico = h('span', { class: 'sk-slot-ico' });
    const nm = h('span', { class: 'sk-slot-nm', text: '비어 있음' });
    const el = h('div', { class: 'sk-slot is-empty', hidden: true }, h('kbd', { class: 'sk-slot-key', text: String(n) }), ico, nm);
    slotsEl.append(el);
    return { el, ico, nm };
  });

  const feed = h('div', { class: 'sk-killfeed', 'aria-label': '킬피드' });
  const centerMain = h('div', { class: 'sk-center-main' });
  const centerSub = h('div', { class: 'sk-center-sub', hidden: true });
  const centerEl = h('div', { class: 'sk-center', 'aria-live': 'polite' }, centerMain, centerSub);
  const specEl = h('div', { class: 'sk-spec', hidden: true });
  const hintEl = h('div', { class: 'sk-hint', hidden: true });

  // 개인전 부활 패널 "💀 하늘에게 당했어요 · 3초 뒤 부활" / 부활 직후 보호 "🛡 보호 중"
  const rspMain = h('div', { class: 'sk-rsp-main' });
  const rspWpn = h('span', { class: 'sk-rsp-wpn', hidden: true });
  const rspNum = h('b', { class: 'sk-rsp-num' });
  const rspTxt = h('span', { class: 'sk-rsp-txt' });
  const respawnEl = h('div', { class: 'sk-rsp', hidden: true, role: 'status' },
    h('div', { class: 'sk-rsp-top' }, rspMain, rspWpn),
    h('div', { class: 'sk-rsp-line' }, rspNum, rspTxt));
  const protectEl = h('div', { class: 'sk-protect', hidden: true, role: 'status', text: '🛡 보호 중' });
  // 이모트 중 하단 안내 "🕺 탱고 · 움직이면 취소"(MODES.md 4.3)
  const emoteEl = h('div', { class: 'sk-emote-banner', hidden: true, role: 'status' });

  const el = h('section', { class: 'sk-screen sk-hud', hidden: true, 'aria-label': 'HUD' },
    vignette, flash, dmgs, xhair, hit, calloutBox, protectEl, top, bannerEl, feed, centerEl, respawnEl, specEl, emoteEl, hintEl, speedEl, hpEl,
    h('div', { class: 'sk-br' }, slotsEl, ammoEl));

  ctx.listen(window, 'resize', () => { viewH = 0; if (st.gap >= 0) applySpread(); });

  // ---------- 적용 ----------
  function applyHp(v) {
    const hp = Math.max(0, Math.round(num(v, 0)));
    if (hp === st.hp && st.maxSeen === st.maxHp) return;
    st.hp = hp;
    st.maxSeen = st.maxHp;
    const r = clamp(hp / st.maxHp, 0, 1);
    setText(hpNum, hp);
    hpFill.style.transform = `scaleX(${r.toFixed(3)})`;
    hpEl.classList.toggle('is-low', r <= 0.3);
    hpEl.classList.toggle('is-crit', r <= 0.15);
    hpEl.classList.toggle('is-dead', hp <= 0);
    vignette.style.opacity = hp <= 0 ? '0' : clamp((0.4 - r) / 0.4, 0, 1).toFixed(3);
    vignette.classList.toggle('is-pulse', hp > 0 && r <= 0.2);
  }

  // 0.1 m/s가 바뀔 때만 쓴다. 막대는 transform, 색은 변수라서 레이아웃을 건드리지 않는다
  function applySpeed(v) {
    const sp = num(v, 0);
    const on = sp > SPEED_SHOW_ABOVE;
    if (on !== st.speedOn) {
      st.speedOn = on;
      speedEl.classList.toggle('is-on', on);
    }
    if (!on) return; // 사라지는 동안에는 마지막 값을 그대로 둔다
    const tenths = Math.round(sp * 10);
    if (tenths === st.speedTenths) return;
    st.speedTenths = tenths;
    const g = speedGauge(tenths / 10);
    setText(speedNum, g.text);
    speedFill.style.transform = `scaleX(${g.ratio.toFixed(3)})`;
    speedEl.style.setProperty('--sk-speed-c', g.color);
  }

  function applyReload(v) {
    const r = v == null || v === false ? null : clamp(num(v, 0), 0, 1);
    st.reload = r;
    const show = r != null && r < 1;
    reloadBar.hidden = !show;
    if (show) reloadFill.style.transform = `scaleX(${r.toFixed(3)})`;
  }

  // 탄약도 무기 이름도 없으면 칸 자체를 숨긴다
  function syncAmmoPanel() {
    const hide = !st.hasAmmo && !st.weaponLabel;
    if (ammoEl.hidden !== hide) ammoEl.hidden = hide;
  }

  function applyAmmo() {
    const a = st.ammo;
    const has = a != null && a !== '' && Number.isFinite(Number(a));
    st.hasAmmo = has;
    if (ammoRow.hidden === has) ammoRow.hidden = !has;
    ammoEl.classList.toggle('is-melee', !has);
    syncAmmoPanel();
    if (!has) {
      setText(magEl, '');
      setText(resEl, '');
      setText(ammoHint, '');
      ammoEl.classList.remove('is-low', 'is-empty');
      return;
    }
    const ammo = Math.max(0, Math.floor(Number(a)));
    st.magSeen = Math.max(st.magSeen, ammo);
    const mag = num(st.mag, 0) || st.magSeen;
    const res = st.reserve == null || st.reserve === '' ? null : Math.max(0, Math.floor(num(st.reserve, 0)));
    setText(magEl, ammo);
    setText(resEl, res == null ? '' : `/ ${res}`);
    const empty = ammo === 0;
    const low = !empty && mag > 1 && ammo <= Math.max(1, Math.ceil(mag * 0.25));
    ammoEl.classList.toggle('is-empty', empty);
    ammoEl.classList.toggle('is-low', low);
    let hint = '';
    if (st.reloading || (st.reload != null && st.reload < 1)) hint = '재장전 중…';
    else if (empty) hint = res > 0 ? 'R 재장전' : '탄약 없음';
    else if (low && res > 0) hint = 'R 재장전';
    setText(ammoHint, hint);
  }

  // 무기를 든 적 없는 칸(규칙이 막은 칸)은 그리지 않고, 있다가 비면(수류탄을 던짐) 흐리게 남긴다
  function applySlots(list) {
    const norm = normSlots(ctx.weapons, list);
    const sig = JSON.stringify(norm);
    if (sig === st.slotSig) return;
    st.slotSig = sig;
    st.slotList = norm;
    norm.forEach((s, i) => {
      const se = slotEls[i];
      if (s) st.slotSeen[i] = true;
      se.el.hidden = !st.slotSeen[i];
      se.el.classList.toggle('is-empty', !s);
      setText(se.ico, s ? s.icon : '');
      setText(se.nm, s ? s.name : '비어 있음');
      se.el.title = s ? s.full : '';
    });
    applyWeaponName();
  }
  function applySlot(n) {
    const v = Math.round(num(n, 0));
    if (v === st.slot) return;
    if (st.slot != null) st.magSeen = 0;
    st.slot = v;
    slotEls.forEach((se, i) => se.el.classList.toggle('is-active', i + 1 === v));
    applyWeaponName();
  }
  function applyWeaponName() {
    const s = st.slotList && st.slot ? st.slotList[st.slot - 1] : null;
    st.weaponLabel = st.weaponName != null ? st.weaponName : s ? `${s.icon} ${s.full}` : '';
    setText(wpnName, st.weaponLabel);
    syncAmmoPanel();
  }

  function applySpread() {
    let gap;
    if (st.spreadPx != null) gap = num(st.spreadPx, 0);
    else {
      if (!viewH) viewH = ctx.root.clientHeight || window.innerHeight || 800;
      const fovDeg = num(st.fov, 0) || ctx.setting('fov') || 75;
      const half = (clamp(fovDeg, 10, 150) * Math.PI) / 360;
      gap = (Math.tan(clamp(num(st.spread, 0), 0, 1.2)) / Math.tan(half)) * (viewH / 2);
    }
    const g = Math.round(clamp(4 + gap, 4, 200) * 2) / 2;
    if (g === st.gap) return;
    st.gap = g;
    xhair.style.setProperty('--gap', `${g}px`);
  }

  function applyTime(t) {
    const v = t == null || t === '' || !Number.isFinite(Number(t)) ? null : Math.max(0, Math.ceil(Number(t)));
    if (v === st.time) return;
    st.time = v;
    setText(timer, v == null ? '-:--' : fmtTime(v));
    timer.classList.toggle('is-urgent', v != null && v <= 10);
  }

  function applyScore(s) {
    const sc = s || {};
    const ffa = sc.mode === 'ffa';
    if (ffa !== st.ffa) {
      st.ffa = ffa;
      st.scoreSig = '';
      top.classList.toggle('is-ffa', ffa);
    }
    if (ffa) { applyFfaScore(sc); return; }
    const o = Math.max(0, Math.floor(num(sc.owner, 0)));
    const c = Math.max(0, Math.floor(num(sc.charterer, 0)));
    const target = Math.max(1, Math.floor(num(sc.target, 3)));
    const bestOf = Math.max(1, Math.floor(num(sc.bestOf, target * 2 - 1)));
    const round = sc.round != null ? Math.floor(num(sc.round, 0)) : 0;
    const sig = [o, c, target, bestOf, round].join('|');
    if (sig === st.scoreSig) return;
    st.scoreSig = sig;
    setText(sides.owner.score, o);
    setText(sides.charterer.score, c);
    setText(tcSub, `${bestOf}판 ${target}선승${round ? ` · 라운드 ${round}` : ''}`);
    const done = o >= target || c >= target;
    sides.owner.mp.hidden = done || o !== target - 1;
    sides.charterer.mp.hidden = done || c !== target - 1;
    top.setAttribute('aria-label', `블루 ${o} : ${c} 오렌지 · ${bestOf}판 ${target}선승`);
  }

  // score: { mode:'ffa', kills, rank, total, leaderName, leaderKills, target }
  function applyFfaScore(sc) {
    const kills = Math.max(0, Math.floor(num(sc.kills, 0)));
    const rank = sc.rank != null && sc.rank !== '' ? Math.max(1, Math.floor(num(sc.rank, 1))) : null;
    const total = sc.total != null && sc.total !== '' ? Math.max(1, Math.floor(num(sc.total, 1))) : null;
    const target = Math.max(1, Math.floor(num(sc.target, FFA_TARGET)));
    const leaderName = sc.leaderName ? String(sc.leaderName) : '';
    const leaderKills = Math.max(0, Math.floor(num(sc.leaderKills, 0)));
    const sig = ['ffa', kills, rank, total, target, leaderName, leaderKills].join('|');
    if (sig === st.scoreSig) return;
    st.scoreSig = sig;
    const rankText = rank == null ? '-' : String(rank);
    const totalText = total == null ? '' : `/${total}`;
    setText(ffaKills, kills);
    setText(ffaGoal, kills >= target ? '목표 달성!' : `목표까지 ${target - kills}킬`);
    setText(ffaRank, rankText);
    setText(ffaTotal, totalText);
    setText(ffaLeader, leaderName ? `1위 ${leaderName} ${leaderKills} / ${target}` : `목표 ${target}킬`);
    ffaStand.classList.toggle('is-leader', rank === 1);
    setText(tcSub, `개인전 · ${target}킬`);
    top.setAttribute('aria-label', `🎯 ${kills}킬 · ${rankText}위${totalText} · ${leaderName ? `1위 ${leaderName} ${leaderKills} / ${target}` : `목표 ${target}킬`}`);
  }

  function weaponByName(name) {
    for (const d of ctx.weapons.values()) if (d.name === name || d.short === name) return d;
    return null;
  }
  // respawn: { seconds, killer?, weaponName?, weaponId? } | null
  function applyRespawn(r) {
    const on = !!r && typeof r === 'object';
    const sec = on ? Math.max(0, Math.ceil(num(r.seconds, 0))) : 0;
    const self = ctx.playerName;
    const killer = on && r.killer && String(r.killer) !== self ? String(r.killer) : '';
    let w = null;
    if (on && r.weaponId != null) w = weaponInfo(ctx.weapons, r.weaponId, r.weaponName ? { weaponName: r.weaponName } : {});
    else if (on && r.weaponName) {
      const d = weaponByName(String(r.weaponName));
      w = d ? weaponInfo(ctx.weapons, d.id, { weaponName: String(r.weaponName) }) : { icon: '', name: String(r.weaponName) };
    }
    const sig = on ? JSON.stringify([sec, killer, w && w.name, w && w.icon]) : '';
    if (sig === st.respSig) return;
    const wasOn = st.respSig !== '';
    st.respSig = sig;
    respawnEl.hidden = !on;
    if (!on) {
      if (wasOn && ctx.hooks && ctx.hooks.respawnEnd) ctx.hooks.respawnEnd(); // 부활 → compact 로드아웃도 닫기
      return;
    }
    setText(rspMain, killer ? `💀 ${killer}에게 당했어요` : '💀 전사했어요');
    rspWpn.hidden = !w;
    if (w) setText(rspWpn, w.icon ? `${w.icon} ${w.name}` : w.name);
    setText(rspNum, sec > 0 ? String(sec) : '');
    setText(rspTxt, sec > 0 ? '초 뒤 부활' : '곧 부활해요…');
    respawnEl.setAttribute('aria-label', `${rspMain.textContent} · ${sec > 0 ? `${sec}초 뒤 부활` : '곧 부활'}`);
  }

  function applyProtect(v) {
    const on = !!v;
    if (on === st.protect) return;
    st.protect = on;
    protectEl.hidden = !on;
    hpEl.classList.toggle('is-protect', on);
  }

  function applyAlive() {
    const a = st.alive || {};
    const z = st.size || {};
    const sig = JSON.stringify([a.owner, a.charterer, z.owner, z.charterer]);
    if (sig === st.aliveSig) return;
    st.aliveSig = sig;
    for (const t of TEAM_KEYS) {
      const n = Math.max(0, Math.floor(num(a[t], 0)));
      const total = Math.min(8, Math.max(n, Math.floor(num(z[t], 0))));
      setText(sides[t].aliveN, a[t] == null ? '' : `생존 ${n}`);
      sides[t].pips.replaceChildren(...Array.from({ length: total }, (_, i) => h('i', { class: i < n ? 'is-alive' : '' })));
    }
  }

  function setLine(node, text) {
    setText(node, text || '');
    node.hidden = !text;
  }

  // ---------- 공개 ----------
  function set(p) {
    if (!p || typeof p !== 'object') return;
    if ('maxHp' in p) st.maxHp = Math.max(1, num(p.maxHp, 100));
    if ('hp' in p || 'maxHp' in p) applyHp('hp' in p ? p.hp : st.hp);
    if ('speed' in p) applySpeed(p.speed);
    let ammoDirty = false;
    for (const k of ['ammo', 'reserve', 'mag']) if (k in p) { st[k] = p[k]; ammoDirty = true; }
    if ('reloading' in p) { st.reloading = !!p.reloading; ammoDirty = true; }
    if ('reload' in p) { applyReload(p.reload); ammoDirty = true; }
    if ('slots' in p) applySlots(p.slots);
    if ('slot' in p) { applySlot(p.slot); ammoDirty = true; }
    if ('weaponName' in p) { st.weaponName = p.weaponName == null ? null : String(p.weaponName); applyWeaponName(); }
    if (ammoDirty) applyAmmo();
    if ('spread' in p) st.spread = p.spread;
    if ('spreadPx' in p) st.spreadPx = p.spreadPx;
    if ('fov' in p) st.fov = p.fov;
    if ('spread' in p || 'spreadPx' in p || 'fov' in p || st.gap < 0) applySpread();
    if ('roundTime' in p) applyTime(p.roundTime);
    if ('score' in p) applyScore(p.score);
    if ('alive' in p) st.alive = p.alive;
    if ('teamSize' in p) st.size = p.teamSize;
    if ('alive' in p || 'teamSize' in p) applyAlive();
    if ('team' in p && teamKey(p.team) !== st.team) {
      st.team = teamKey(p.team);
      for (const t of TEAM_KEYS) sides[t].el.classList.toggle('is-mine', t === st.team);
    }
    if ('hint' in p) setLine(hintEl, p.hint);
    if ('spectate' in p) setLine(specEl, p.spectate ? `👁️ 관전 중 · ${p.spectate}` : '');
    if ('crosshair' in p) xhair.hidden = p.crosshair === false;
    if ('respawn' in p) applyRespawn(p.respawn);
    if ('protect' in p) applyProtect(p.protect);
    if ('emote' in p) {
      // emote: { name, icon } | null — 아이콘이 없으면 🕺
      const e = p.emote && typeof p.emote === 'object' ? p.emote : null;
      const name = e ? String(e.name || e.id || '') : '';
      setLine(emoteEl, name ? `${e.icon || '🕺'} ${name} · 움직이면 취소` : '');
      el.classList.toggle('is-emote', !!name); // 이모트 중(3인칭)에는 크로스헤어·히트마커를 숨긴다
    }
  }

  /** hitmarker(head, kill, { half }) — half: 저격 반샷(손·발) 전용 분홍 표시 */
  function hitmarker(head = false, kill = false, opts) {
    const half = !!(opts && opts.half);
    hit.classList.toggle('is-head', !!head);
    hit.classList.toggle('is-kill', !!kill);
    hit.classList.toggle('is-half', half);
    if (!hit.animate) return;
    if (st.hitAnim) st.hitAnim.cancel();
    st.hitAnim = hit.animate([
      { opacity: 1, transform: 'scale(1.4)' },
      { opacity: 1, transform: 'scale(1)', offset: 0.35 },
      { opacity: 0, transform: 'scale(1)' },
    ], { duration: head || kill || half ? 440 : 260, easing: 'ease-out' });
  }

  /**
   * callout(text, tone) — 크로스헤어 아래 짧은 글자. tone: 'head'|'half'|'kill'|'info'. ''이면 지운다.
   * 최대 2줄이고 최근 것이 위에 온다. 같은 글자를 다시 부르면 그 줄의 애니메이션을 처음부터 돌린다.
   */
  function callout(text, tone) {
    const msg = text == null ? '' : String(text);
    if (!msg) { clearCallouts(); return; }
    const t = calloutTone(tone);
    let row = null;
    for (const c of calloutRows) {
      const running = !!c.anim && c.anim.playState === 'running';
      if (running && c.text === msg && c.tone === t) { row = c; break; }
      c.rank = running ? c.seq : 0; // 빈 줄 먼저, 없으면 가장 오래된 줄
      if (!row || c.rank < row.rank) row = c;
    }
    row.seq = ++st.calloutSeq;
    row.text = msg;
    setText(row.el, msg);
    if (row.tone !== t) { row.tone = t; row.el.dataset.tone = t; }
    if (calloutBox.firstElementChild !== row.el) calloutBox.prepend(row.el);
    if (row.anim) { row.anim.cancel(); row.anim.play(); } else row.anim = row.el.animate(CALLOUT_KEYFRAMES, CALLOUT_TIMING);
  }
  function clearCallouts() {
    for (const c of calloutRows) if (c.anim) c.anim.cancel();
  }

  function nextBanner() {
    st.bannerTimer = null;
    const b = st.bannerQueue.shift();
    if (!b) return;
    setText(bannerIco, b.icon);
    bannerIco.hidden = !b.icon;
    setText(bannerTitle, b.title);
    bannerTitle.hidden = !b.title;
    setText(bannerSub, b.sub);
    bannerSub.hidden = !b.sub;
    bannerEl.classList.add('is-show');
    st.bannerTimer = ctx.later(() => {
      bannerEl.classList.remove('is-show');
      st.bannerTimer = ctx.later(nextBanner, BANNER_OUT_MS);
    }, b.ms);
  }
  /** banner({ icon, title, sub, ms }) — 상단 배너. 앞 배너가 다 사라진 뒤 차례로 나온다 */
  function banner(o) {
    const b = bannerSpec(o);
    if (!b) return;
    if (st.bannerQueue.length >= BANNER_QUEUE_MAX) st.bannerQueue.shift();
    st.bannerQueue.push(b);
    if (st.bannerTimer == null) nextBanner();
  }
  function clearBanners() {
    st.bannerQueue.length = 0;
    if (st.bannerTimer != null) ctx.cancel(st.bannerTimer);
    st.bannerTimer = null;
    bannerEl.classList.remove('is-show');
  }

  function damageFrom(angle) {
    const d = h('div', { class: 'sk-dmg', style: { transform: `rotate(${num(angle, 0)}rad)` } }, h('i'));
    dmgs.append(d);
    while (dmgs.children.length > DMG_MAX) dmgs.firstElementChild.remove();
    if (d.animate) {
      d.animate([{ opacity: 1 }, { opacity: 1, offset: 0.3 }, { opacity: 0 }], { duration: 1300, easing: 'ease-in' })
        .onfinish = () => d.remove();
    } else ctx.later(() => d.remove(), 1300);
    if (flash.animate) flash.animate([{ opacity: 0.65 }, { opacity: 0 }], { duration: 380, easing: 'ease-out' });
  }

  function center(text, ms, opts) {
    if (ms && typeof ms === 'object') { opts = ms; ms = opts.ms; }
    const o = opts || {};
    if (st.centerTimer != null) { ctx.cancel(st.centerTimer); st.centerTimer = null; }
    if (!text) { centerEl.classList.remove('is-show'); return; }
    setText(centerMain, text);
    setText(centerSub, o.sub || '');
    centerSub.hidden = !o.sub;
    centerEl.dataset.tone = o.tone || autoTone(String(text));
    centerEl.classList.remove('is-show');
    void centerEl.offsetWidth; // 애니메이션 재시작
    centerEl.classList.add('is-show');
    const dur = ms == null ? 2000 : Number(ms);
    if (Number.isFinite(dur) && dur > 0) {
      st.centerTimer = ctx.later(() => { st.centerTimer = null; centerEl.classList.remove('is-show'); }, dur);
    }
  }

  function pushKill(k) {
    if (!k) return;
    // 개인전이면(k.mode === 'ffa', 생략 시 HUD score.mode를 따름) 팀 색 없이 중립
    const ffa = k.mode === 'ffa' || (k.mode == null && st.ffa);
    const kt = ffa ? 'ffa' : teamKey(k.killerTeam) || 'none';
    const vt = ffa ? 'ffa' : teamKey(k.victimTeam) || 'none';
    const self = ctx.playerName;
    const mine = k.mine != null ? !!k.mine : !!self && (k.killer === self || k.victim === self);
    const w = weaponInfo(ctx.weapons, k.weaponId, k);
    const suicide = !k.killer || k.killer === k.victim;
    const half = !!(k.half || k.halfShot);
    const row = h('div', { class: 'sk-kf' + (mine ? ' is-mine' : '') + (k.head ? ' is-head' : '') + (half ? ' is-half' : '') + (ffa ? ' is-ffa' : '') },
      suicide ? null : h('span', { class: `sk-kf-name t-${kt}`, text: k.killer }),
      h('span', { class: 'sk-kf-wpn', title: w.name },
        h('span', { class: 'sk-kf-ico', text: w.icon, 'aria-hidden': 'true' }),
        w.short ? h('span', { class: 'sk-kf-wn', text: w.short }) : null),
      k.head ? headshotIcon() : null,
      half ? h('span', { class: 'sk-kf-half', text: '반샷' }) : null,
      h('span', { class: `sk-kf-name t-${vt}`, text: k.victim == null ? '' : k.victim }));
    feed.append(row);
    while (feed.children.length > KILLFEED_MAX) feed.firstElementChild.remove();
    ctx.later(() => {
      row.classList.add('is-out');
      ctx.later(() => row.remove(), 400);
    }, KILLFEED_MS);
  }

  function reset() {
    feed.replaceChildren();
    dmgs.replaceChildren();
    center('');
    setLine(hintEl, '');
    setLine(specEl, '');
    applyRespawn(null);
    applyProtect(false);
    setLine(emoteEl, '');
    el.classList.remove('is-emote');
    clearCallouts();
    clearBanners();
    applySpeed(0);
    // 다음 판은 규칙이 다를 수 있다. 슬롯과 탄약을 비우고 다음 hud.set을 기다린다
    st.slotSeen.fill(false);
    st.slotSig = '';
    st.weaponName = null;
    applySlots(null);
    st.ammo = st.reserve = st.mag = undefined;
    st.magSeen = 0;
    st.reloading = false;
    applyReload(null);
    applyAmmo();
  }

  const screen = makeScreen(el, { render: (_props, { patch }) => set(patch) });
  return Object.assign(screen, {
    set, hitmarker, damageFrom, center, callout, banner, reset,
    killfeed: { push: pushKill, clear: () => feed.replaceChildren() },
  });
}
