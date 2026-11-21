/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 대기실 = 출격 대기(DEPLOYMENT). 팀 또는 개인전 명단, 준비와 시작, 모드·규칙·개인전 목표 킬·맵 변경, 채팅, 내 장비 칸(주무기·보조무기·근접·수류탄)을 다룬다.
 *          폭파 미션은 팀 칼럼에 전반 진영(먼저 공격/수비)을 붙이고, 규칙은 클래식, 맵은 미션 맵만 고른다.
 *          자리 비움으로 방이 곧 닫히면(idleLeft) 위에 남은 초와 [계속 기다리기] 띠를 띄운다. 화면을 누르거나 키를 치면 'room:active'(1초에 한 번까지).
 *          장비 칸을 누르면 그 칸의 무기 창이 뜨고, 가진 무기는 바로 장착, 안 가진 무기는 포인트로 사서 바로 장착한다(account.buy·equip).
 */
// 대기실: 팀 칼럼(팀전·폭파 미션) / 한 줄 명단(개인전), 준비/출격, 모드·규칙·목표 킬·맵 변경, 채팅
import { h, btn, setText, num, fmtPoints, TEAMS, TEAM_KEYS, teamKey, pingText, pingClass, modeKey, modeLabel, MODE_NAME, SIDE_NAME, bombSide } from './dom.js';
import { makeScreen, mapCard, createChoiceRow, createStepper, createModal, sheet, normWeapon, summaryChips, pointsBadge } from './parts.js';
import { mapList, mapInfo, uiIcon, weaponGlyph, MODE_GLYPH, RULE_GLYPH } from './icons.js';
import { RULE_CHOICES, MODE_IDS, ZOMBIE_MAX, mapsForMode, missionMaps, ruleForMode } from './lobby.js';
import { RULESETS, normalizeRuleset, FFA_KILLS, FFA_KILL_PRESETS, normalizeKillTarget } from '../game/modes.js';
import { t, loc } from '../core/i18n.js';
import { platform } from '../platform/index.js';

const CHAT_MAX = 30;
const CHAT_LEN = 120;
/** 대기실 장비 칸. 수류탄은 팔지 않고 계정 장비에도 없다(언제나 기본 지급) */
const GEAR_SLOTS = [
  { key: 'primary', slot: 1, label: t('room.gearPrimary') },
  { key: 'secondary', slot: 2, label: t('room.gearSecondary') },
  { key: 'melee', slot: 3, label: t('room.gearMelee') },
  { key: 'grenade', slot: 4, label: t('room.gearGrenade') },
];

function normPlayers(p) {
  return (Array.isArray(p.players) ? p.players : []).map((x, i) => ({
    id: x.id != null ? x.id : `p${i}`,
    name: x.name || t('room.playerFallback'),
    team: teamKey(x.team),
    ready: !!x.ready,
    ping: x.ping,
    bot: !!x.bot,
    host: !!x.host || (p.hostId != null && x.id === p.hostId),
    me: !!x.me || (p.meId != null && x.id === p.meId),
  }));
}

export function createRoom(ctx) {
  let p = {};
  let screen = null;
  let chatSig = '';
  let mapSig = '';

  // ---------- 헤더 ----------
  const title = h('h1', { class: 'sk-h1 sk-stencil sk-room-title' });
  /** 아이콘 + 글자 칩. 글자는 text에, 아이콘은 ico에 바꿔 넣는다 */
  const iconChip = (cls, glyph) => {
    const ico = h('span', { class: 'sk-chip-ico', 'aria-hidden': 'true' }, uiIcon(glyph));
    const text = h('span');
    return { el: h('span', { class: cls }, ico, text), ico, text, glyph };
  };
  const modeChip = iconChip('sk-chip sk-chip--mode', 'team');
  const ruleChip = iconChip('sk-chip sk-chip--mode', 'rifle');
  const mapChip = iconChip('sk-chip', 'map');
  const countChip = iconChip('sk-chip', 'squad');
  const setChip = (c, glyph, text) => {
    if (c.glyph !== glyph) { c.glyph = glyph; c.ico.replaceChildren(uiIcon(glyph)); }
    setText(c.text, text);
  };
  const idChip = h('span', { class: 'sk-chip sk-chip--dim' });
  // 포털에서 초대 링크를 줄 수 있으면 방 번호 옆에 [초대 링크 복사]. 누르면 잠깐 '복사했어요'로 바뀐다
  const inviteLabel = t('room.copyInvite');
  let inviteTimer = 0;
  const inviteBtn = h('button', {
    type: 'button', class: 'sk-chip sk-chip--dim sk-room-invite', hidden: true, text: inviteLabel,
    onclick: () => {
      const link = platform.isPortal ? platform.inviteLink(p.roomId) : null;
      if (typeof link !== 'string' || !link || !navigator.clipboard) return;
      navigator.clipboard.writeText(link).then(() => {
        setText(inviteBtn, t('portal.inviteCopied'));
        clearTimeout(inviteTimer);
        inviteTimer = setTimeout(() => setText(inviteBtn, inviteLabel), 2000);
      }, () => {});
    },
  });

  // ---------- 팀 칼럼(폭파 미션은 머리에 전반 진영 '먼저 공격'/'먼저 수비') ----------
  function teamCol(team) {
    const T = TEAMS[team];
    const count = h('span', { class: 'sk-team-count' });
    const move = btn(t('room.moveTeam'), () => ctx.emit('room:team', { team }), 'sk-btn--sm');
    const list = h('ul', { class: 'sk-team-list', 'aria-label': t('room.teamRoster', { team: T.name }) });
    const side = h('span', { class: 'sk-team-side', hidden: true });
    const el = h('section', { class: `sk-team sk-team--${team} sk-steel` },
      h('header', { class: 'sk-team-head' },
        h('h2', { class: 'sk-team-name' },
          h('span', { class: 'sk-team-emoji', 'aria-hidden': 'true' }),
          h('span', { text: T.name }), h('small', { text: T.en }), side),
        count, move),
      list);
    return { el, count, move, list, side };
  }
  const cols = { owner: teamCol('owner'), charterer: teamCol('charterer') };
  const waiting = h('p', { class: 'sk-unassigned' });
  const bombNote = h('p', { class: 'sk-room-note', hidden: true }, uiIcon('bomb', 'sk-uico--inline'), t('room.bombSwapNote'));
  const teamsWrap = h('div', { class: 'sk-room-teams' }, waiting, cols.owner.el, h('div', { class: 'sk-vs', text: 'VS', 'aria-hidden': 'true' }), cols.charterer.el, bombNote);

  // ---------- 개인전 명단(팀 버튼 없음) ----------
  const ffaCount = h('span', { class: 'sk-team-count' });
  const ffaList = h('ul', { class: 'sk-team-list', 'aria-label': t('room.ffaRoster') });
  const ffaEmoji = h('span', { class: 'sk-team-emoji sk-team-emoji--ico', 'aria-hidden': 'true' }, uiIcon(MODE_GLYPH.ffa));
  let ffaGlyph = MODE_GLYPH.ffa;
  const ffaName = h('span', { text: t('room.ffaTitle') });
  const ffaSub = h('small', { text: t('room.ffaSub') });
  const ffaCol = h('section', { class: 'sk-team sk-team--ffa sk-steel', hidden: true },
    h('header', { class: 'sk-team-head' },
      h('h2', { class: 'sk-team-name' }, ffaEmoji, ffaName, ffaSub),
      ffaCount),
    ffaList);

  // ---------- 모드(방장만 바꿀 수 있음 → 머리글 오른쪽 전환 버튼, 다른 사람은 모드 칩만) ----------
  const modeBtns = MODE_IDS.map((m) => btn([
    h('span', { class: 'sk-mode-ico', 'aria-hidden': 'true' }, uiIcon(MODE_GLYPH[m])),
    h('span', { class: 'sk-mode-txt' }, h('b', { text: MODE_NAME[m] })),
  ], () => pickMode(m), 'sk-mode-btn', { role: 'radio', 'data-mode': m }));
  const modePick = h('div', { class: 'sk-modepick sk-modepick--bar', role: 'radiogroup', 'aria-label': t('room.modePickLabel'), title: t('room.modeHostOnly') }, modeBtns);
  const hasMissionMap = () => missionMaps(mapList(ctx.maps, p.maps)).length > 0;
  function pickMode(m) {
    const players = normPlayers(p);
    const me = players.find((x) => x.me);
    if (!me || !me.host || p.starting || modeKey(m) === modeKey(p.mode)) return;
    if (modeKey(m) === 'bomb' && !hasMissionMap()) return; // 미션 맵이 없으면 폭파 미션을 고를 수 없다
    if (modeKey(m) === 'zombie' && players.length > ZOMBIE_MAX) return; // 좀비 방은 4명까지
    screen.update({ mode: modeKey(m) }); // 즉시 반영, 다음 update가 오면 그 값이 우선
    ctx.emit('room:mode', { mode: modeKey(m) });
  }

  function playerRow(x) {
    return h('li', { class: 'sk-pl' + (x.me ? ' is-me' : '') + (x.ready || x.host ? ' is-ready' : '') },
      h('span', { class: 'sk-pl-crown', title: x.host ? t('room.host') : null }, x.host ? uiIcon('crown') : null),
      h('span', { class: 'sk-pl-name' }, x.bot ? uiIcon('bot', 'sk-uico--inline sk-pl-bot') : null, x.bot ? h('span', { class: 'sk-vh', text: t('room.bot') }) : null, x.name),
      x.me ? h('span', { class: 'sk-tag', text: t('room.me') }) : null,
      h('span', { class: 'sk-ping ' + pingClass(x.ping), text: pingText(x.ping), title: t('room.ping') }),
      h('span', { class: 'sk-pl-ready' }, x.ready && !x.host ? uiIcon('check', 'sk-uico--inline') : null, x.host ? t('room.host') : x.ready ? t('room.ready') : t('room.waiting')));
  }
  const emptyRow = (n) => h('li', { class: 'sk-pl sk-pl--empty' }, h('span', { class: 'sk-pl-crown' }), h('span', { class: 'sk-pl-name', text: n > 1 ? t('room.emptySlots', { n }) : t('room.emptySlot') }));

  // ---------- 규칙(방장만 바꿀 수 있음. 바꾸면 세션이 이 규칙으로 고를 수 있는 맵으로 맞춘다. 폭파 미션은 클래식 고정) ----------
  const rulePick = createChoiceRow({ label: t('room.rulePickLabel'), onPick: pickRule });
  const ruleDesc = h('p', { class: 'sk-set-hint' });
  function pickRule(id) {
    const me = normPlayers(p).find((x) => x.me);
    const next = normalizeRuleset(id);
    if (!me || !me.host || p.starting || modeKey(p.mode) === 'bomb' || modeKey(p.mode) === 'zombie' || next === normalizeRuleset(p.ruleset)) return;
    screen.update({ ruleset: next }); // 즉시 반영, 다음 update가 오면 그 값이 우선
    ctx.emit('room:ruleset', { ruleset: next });
  }

  // ---------- 목표 킬(개인전만. 방장만 5~20 안에서 바꾼다. 다른 사람은 글과 모드 칩으로 확인) ----------
  const killPick = createStepper({
    label: t('room.killTarget'), min: FFA_KILLS.min, max: FFA_KILLS.max, presets: FFA_KILL_PRESETS, fmt: (n) => t('room.killsN', { n }), onPick: pickKills, cls: 'sk-kill-pick',
  });
  const killDesc = h('p', { class: 'sk-set-hint' });
  const killBox = h('div', { class: 'sk-room-kills', hidden: true },
    h('h3', { class: 'sk-room-kills-title' }, uiIcon('target', 'sk-uico--inline'), t('room.killTargetTitle')), killPick.el, killDesc);
  function pickKills(n) {
    const me = normPlayers(p).find((x) => x.me);
    const next = normalizeKillTarget(n);
    if (!me || !me.host || p.starting || modeKey(p.mode) !== 'ffa' || next === normalizeKillTarget(p.killTarget)) return;
    screen.update({ killTarget: next }); // 즉시 반영, 다음 update가 오면 그 값이 우선
    ctx.emit('room:killTarget', { killTarget: next });
  }

  // ---------- 맵 ----------
  const mapCur = h('div', { class: 'sk-room-mapcur' });
  const mapPick = h('div', { class: 'sk-mapcards sk-mapcards--sm', role: 'radiogroup', 'aria-label': t('room.mapPickLabel') });
  const mapNote = h('p', { class: 'sk-set-hint' });
  /** 작은 카드는 mapCard가 tag를 빼므로 여기서 붙인다('칼전 전용' 같은 표시가 고를 때 보이게) */
  function pickerCard(m) {
    const card = mapCard(m, {
      small: true, selected: m.id === p.mapId,
      onPick: (id) => { if (id !== p.mapId) ctx.emit('room:map', { mapId: id }); },
    });
    if (m.tag) card.querySelector('.sk-mapcard-text').append(h('span', { class: 'sk-mapcard-tag', text: m.tag }));
    return card;
  }

  // ---------- 채팅 ----------
  const chatLog = h('ol', { class: 'sk-chat-log', 'aria-live': 'polite', 'aria-label': t('room.chat') });
  const chatIn = h('input', {
    class: 'sk-input', type: 'text', maxlength: CHAT_LEN, placeholder: t('room.chatPlaceholder'),
    autocomplete: 'off', spellcheck: 'false', 'aria-label': t('room.chatInput'),
  });
  const chatForm = h('form', { class: 'sk-chat-form', onsubmit: (e) => { e.preventDefault(); sendChat(); } },
    chatIn, h('button', { type: 'submit', class: 'sk-btn' }, t('room.send')));
  // 포털이 채팅을 끄면 기록·입력칸 대신 한 줄 안내만 보인다(render마다 platform.chatAllowed를 다시 본다)
  const chatOff = h('p', { class: 'sk-set-hint sk-chat-off', hidden: true, text: t('portal.chatOff') });
  function sendChat() {
    const text = chatIn.value.replace(/\s+/g, ' ').trim().slice(0, CHAT_LEN);
    if (!text) return;
    chatIn.value = '';
    ctx.emit('room:chat', { text });
  }
  function renderChat(items) {
    const list = (Array.isArray(items) ? items : []).slice(-CHAT_MAX);
    const sig = JSON.stringify(list);
    if (sig === chatSig) return;
    chatSig = sig;
    const stick = chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight < 48;
    chatLog.replaceChildren(...(list.length ? list.map((m) => (m.system
      ? h('li', { class: 'sk-chat-sys', text: m.text })
      : h('li', { class: 'sk-chat-line' },
        h('b', { class: 'sk-chat-name t-' + (teamKey(m.team) || 'none'), text: m.name || '?' }),
        h('span', { class: 'sk-chat-text', text: m.scope === 'team' ? t('room.teamTag', { text: m.text }) : m.text })))) : [h('li', { class: 'sk-chat-sys', text: t('room.chatEmpty') })]));
    if (stick) chatLog.scrollTop = chatLog.scrollHeight;
  }

  // ---------- 하단 ----------
  const status = h('p', { class: 'sk-room-status', role: 'status' });
  const readyBtn = btn(t('room.readyUp'), toggleReady, 'sk-btn--big sk-ready-btn');
  const startBtn = btn(t('room.deployStart'), () => {
    if (!startBtn.disabled) ctx.emit('room:start', { roomId: p.roomId, mapId: p.mapId, mode: modeKey(p.mode) });
  }, 'sk-btn--primary sk-btn--big');

  // 내 준비 상태는 즉시 반영(낙관적 갱신)하고, 다음 update가 오면 그 값이 우선한다.
  const isMeRaw = (x) => !!x.me || (p.meId != null && x.id === p.meId);
  function toggleReady() {
    const me = normPlayers(p).find((x) => x.me);
    if (!me || me.host) return;
    const ready = !me.ready;
    screen.update({ players: (p.players || []).map((x) => (isMeRaw(x) ? { ...x, ready } : x)) });
    ctx.emit('room:ready', { ready });
  }

  // ---------- 내 장비: 칸을 누르면 그 칸의 무기 창(장착 · 바로 구매) ----------
  const modal = createModal();
  const gearPoints = pointsBadge();
  const gearNote = h('p', { class: 'sk-set-hint sk-rgear-note', role: 'status' });
  const gearSlots = GEAR_SLOTS.map((g) => {
    const ico = h('span', { class: 'sk-lo-ico', 'aria-hidden': 'true' });
    const name = h('b', { class: 'sk-rgear-name' });
    const el = h('button', { type: 'button', class: 'sk-rgear-slot', onclick: () => openGear(g) },
      ico, h('span', { class: 'sk-rgear-txt' }, h('small', { class: 'sk-rgear-label', text: g.label }), name));
    return { ...g, el, ico, name };
  });
  const gearBox = h('section', { class: 'sk-panel sk-steel sk-rgear', 'aria-label': t('room.myGear') },
    h('header', { class: 'sk-rgear-head' }, h('h2', { class: 'sk-panel-title' }, uiIcon('armory'), t('room.myGear')), gearPoints.el),
    h('div', { class: 'sk-rgear-slots' }, gearSlots.map((s) => s.el)),
    gearNote);
  const gearSheetNote = h('p', { class: 'sk-set-hint sk-rgear-sheetnote', role: 'status' });
  let gearOpen = null;   // 창이 열린 칸(GEAR_SLOTS 항목)
  let gearRows = [];

  /** 상점에서 파는 그 칸의 무기(좀비 전용·카드 전용은 빠지고, 상점에서 파는 좀비 전용 무기 shop은 남는다). 무기 정의 순서 그대로 */
  const slotWeapons = (slot) => [...ctx.weapons.values()].filter((w) => w.slot === slot && (!w.zombieOnly || w.shop) && !w.cardOnly);
  function equippedId(g) {
    if (g.key !== 'grenade') return ctx.account.loadout[g.key];
    const first = slotWeapons(g.slot)[0];
    return first ? first.id : null;
  }

  function gearRow(g, d) {
    const w = normWeapon(ctx.weapons, d);
    const state = h('span', { class: 'sk-shop-state' });
    const action = h('button', { type: 'button', class: 'sk-btn sk-btn--sm sk-rgear-act', onclick: () => pickGear(g, w) });
    const el = h('article', { class: 'sk-rgear-item', 'aria-label': w.name },
      h('span', { class: 'sk-lo-ico', 'aria-hidden': 'true' }, uiIcon(weaponGlyph(w.id, w.slot))),
      h('div', { class: 'sk-rgear-itext' },
        h('b', { class: 'sk-rgear-iname', text: w.name }, w.premium ? h('span', { class: 'sk-premium', text: t('room.premium') }) : null),
        w.tagline ? h('span', { class: 'sk-lo-tagline', text: w.tagline }) : null,
        w.summary.length ? summaryChips(w.summary) : null),
      h('div', { class: 'sk-rgear-iside' }, state, action));
    return { id: w.id, w, el, state, action };
  }

  function openGear(g) {
    if (!ctx.account || p.starting) return;
    gearOpen = g;
    setText(gearSheetNote, g.key === 'grenade' ? t('room.grenadeNote') : t('room.gearSheetNote'));
    gearRows = slotWeapons(g.slot).map((d) => gearRow(g, d));
    modal.open(sheet({
      title: t('room.pickSlot', { slot: g.label }), kicker: 'LOADOUT', onClose: () => modal.close(), cls: 'sk-rgear-sheet',
      body: [gearSheetNote, h('div', { class: 'sk-rgear-list' }, gearRows.map((r) => r.el))],
    }), () => { gearOpen = null; gearRows = []; });
    paintGearRows();
    const on = gearRows.find((r) => r.el.classList.contains('is-on'));
    if (on && typeof on.el.scrollIntoView === 'function') on.el.scrollIntoView({ block: 'nearest' });
  }

  function paintGearRows() {
    const g = gearOpen;
    const a = ctx.account;
    if (!g || !a) return;
    const now = equippedId(g);
    const fixed = g.key === 'grenade';
    for (const r of gearRows) {
      const owned = fixed || a.isOwned(r.id);
      const on = r.id === now;
      const closed = !owned && typeof a.canSell === 'function' && !a.canSell(r.id);   // 서버 가격표에 아직 없다
      const short = owned || closed ? 0 : Math.max(0, r.w.price - a.profile.points);
      r.el.classList.toggle('is-on', on);
      r.el.classList.toggle('is-owned', owned);
      setText(r.state, on ? t('room.equipped') : owned ? t('room.owned') : fmtPoints(r.w.price));
      setText(r.action, on ? t('room.equipped') : owned ? t('room.equip') : closed ? t('room.buyPending') : short ? t('room.short', { points: fmtPoints(short) }) : t('room.buyEquip'));
      r.action.disabled = on || fixed || closed || short > 0 || !!p.starting;
      r.action.classList.toggle('sk-btn--primary', !owned && !closed && !short);
      r.action.classList.toggle('sk-btn--ghost', on);
    }
  }

  function pickGear(g, w) {
    const a = ctx.account;
    if (!a || p.starting || g.key === 'grenade') return;
    let bought = null;
    if (!a.isOwned(w.id)) {
      const r = a.buy(w.id);
      if (!r.ok) {
        setText(gearSheetNote, r.reason === 'points' ? t('room.notEnoughPoints', { points: fmtPoints(w.price - r.points) })
          : r.reason === 'closed' ? t('room.buyClosed') : t('room.cantBuy'));
        paintGearRows();
        return;
      }
      ctx.emit('ui:sound', { name: 'purchase' });
      bought = r;
    }
    if (!a.equip(g.key, w.id).ok) {
      setText(gearSheetNote, t('room.cantEquip'));
      paintGear();
      return;
    }
    setText(gearNote, bought
      ? t('room.boughtEquipped', { weapon: w.name, points: fmtPoints(bought.points) })
      : t('room.slotEquipped', { slot: g.label, weapon: w.name }));
    modal.close();
    paintGear();
  }

  /** 장비 칸과(열려 있으면) 무기 창. 계정이 바뀔 때(index.js refreshAccount)도 부른다 */
  function paintGear() {
    const a = ctx.account;
    gearBox.hidden = !a;
    if (!a) return;
    gearPoints.set(a.profile.points);
    for (const s of gearSlots) {
      const id = equippedId(s);
      const w = id ? normWeapon(ctx.weapons, id) : null;
      const glyph = w ? weaponGlyph(w.id, w.slot) : '';
      if (s.ico.dataset.glyph !== glyph) { s.ico.dataset.glyph = glyph; s.ico.replaceChildren(glyph ? uiIcon(glyph) : '—'); }
      setText(s.name, w ? w.name : t('room.none'));
      s.el.title = t('room.changeSlot', { slot: s.label });
      s.el.disabled = !!p.starting;
    }
    paintGearRows();
  }

  // ---------- 자리 비움 안내: 방장이 곧 방을 닫는다 ----------
  const idleText = h('span', { class: 'sk-room-idle-text' });
  const idleBar = h('div', { class: 'sk-room-idle', role: 'alert', hidden: true },
    idleText,
    btn(t('room.keepWaiting'), () => ctx.emit('room:stay', {}), 'sk-btn--sm sk-btn--primary sk-room-idle-stay'));

  const el = h('section', { class: 'sk-screen sk-page sk-room', hidden: true, 'aria-label': t('room.screenLabel') },
    h('div', { class: 'sk-page-inner' },
      h('header', { class: 'sk-bar' },
        btn([uiIcon('back'), h('span', { text: t('room.leave') })], () => ctx.emit('room:leave', { roomId: p.roomId }), 'sk-btn--ghost'),
        h('div', { class: 'sk-bar-title' },
          h('p', { class: 'sk-kicker', text: 'DEPLOYMENT // STANDBY', 'aria-hidden': 'true' }),
          title, h('p', { class: 'sk-bar-sub sk-chips' }, ruleChip.el, modeChip.el, mapChip.el, countChip.el, idChip, inviteBtn)),
        modePick),
      idleBar,
      h('div', { class: 'sk-room-grid' },
        h('div', { class: 'sk-room-left' },
          teamsWrap,
          ffaCol,
          h('section', { class: 'sk-panel sk-steel sk-chat' }, h('h2', { class: 'sk-panel-title' }, uiIcon('chat'), t('room.chat')), chatLog, chatForm, chatOff)),
        h('aside', { class: 'sk-room-side' },
          gearBox,
          h('section', { class: 'sk-panel sk-steel' }, h('h2', { class: 'sk-panel-title' }, uiIcon('rules'), t('room.rules')), rulePick.el, ruleDesc, killBox),
          h('section', { class: 'sk-panel sk-steel' }, h('h2', { class: 'sk-panel-title' }, uiIcon('map'), t('room.map')), mapCur, mapPick, mapNote))),
      h('footer', { class: 'sk-room-foot sk-steel' }, status, h('div', { class: 'sk-room-foot-actions' }, readyBtn, startBtn))),
    modal.el);

  // 대기실을 누르거나 키를 치면 자리 비움을 처음부터 센다(방장 것만 쓰인다). 1초에 한 번까지만 알린다
  let activeAt = -Infinity;
  const onActive = () => {
    const nowMs = Date.now();
    if (nowMs - activeAt < 1000) return;
    activeAt = nowMs;
    ctx.emit('room:active', {});
  };
  el.addEventListener('pointerdown', onActive, true);
  el.addEventListener('keydown', onActive, true);

  function render(props) {
    p = props;
    const idleLeft = Math.max(0, Math.ceil(num(p.idleLeft, 0)));
    idleBar.hidden = !(idleLeft > 0);
    if (idleLeft > 0) setText(idleText, t('room.idleBar', { span: p.idleSpan || t('room.spanMin', { m: 1 }), left: idleLeft }));
    const players = normPlayers(p);
    const me = players.find((x) => x.me);
    const isHost = !!(me && me.host);
    const max = Math.max(2, num(p.max, 8));
    const cap = Math.max(1, num(p.teamMax, Math.ceil(max / 2)));
    const mode = modeKey(p.mode);
    const zombie = mode === 'zombie';
    const ffa = mode === 'ffa' || zombie;   // 좀비 방도 팀 칼럼 없이 한 줄 명단이다(모두 같은 편)
    const bomb = mode === 'bomb';
    const fixedRule = bomb || zombie;
    const rs = ruleForMode(mode, p.ruleset);
    const kills = normalizeKillTarget(p.killTarget);

    setText(title, p.name || t('room.roomTitle'));
    setChip(ruleChip, RULE_GLYPH[rs] || 'rifle', loc(RULESETS[rs], 'name'));
    setChip(modeChip, MODE_GLYPH[mode], modeLabel(mode, { killTarget: kills }));
    modeChip.el.classList.toggle('is-ffa', mode === 'ffa');
    modeChip.el.classList.toggle('is-zombie', zombie);
    const fg = zombie ? MODE_GLYPH.zombie : MODE_GLYPH.ffa;
    if (fg !== ffaGlyph) { ffaGlyph = fg; ffaEmoji.replaceChildren(uiIcon(fg)); }
    setText(ffaName, zombie ? t('room.zombieTeam') : t('room.ffaTitle'));
    setText(ffaSub, zombie ? t('room.zombieSub') : t('room.ffaSub'));
    modeChip.el.classList.toggle('is-bomb', bomb);
    const m = mapInfo(ctx.maps, p.maps, p.mapId);
    setChip(mapChip, 'map', m ? m.name : t('room.mapTbd'));
    setChip(countChip, 'squad', `${players.length}/${max}`);
    setText(idChip, p.roomId ? `#${p.roomId}` : '');
    idChip.hidden = !p.roomId;
    const invite = p.roomId && platform.isPortal ? platform.inviteLink(p.roomId) : null;
    inviteBtn.hidden = !(typeof invite === 'string' && invite && navigator.clipboard);

    // 명단: 팀전·폭파 미션 = 팀 칼럼 두 개, 개인전 = 한 줄 명단
    teamsWrap.hidden = ffa;
    ffaCol.hidden = !ffa;
    const byTeam = { owner: [], charterer: [] };
    for (const x of players) if (x.team) byTeam[x.team].push(x);
    const unassigned = ffa ? [] : players.filter((x) => !x.team);
    if (ffa) {
      setText(ffaCount, `${players.length}/${max}`);
      const free = Math.max(0, max - players.length); // 빈 자리는 한 줄로 묶는다(명단이 길어지지 않게)
      ffaList.replaceChildren(...players.map(playerRow), ...(free ? [emptyRow(free)] : []));
    } else {
      for (const tk of TEAM_KEYS) {
        const c = cols[tk];
        setText(c.count, `${byTeam[tk].length}/${cap}`);
        c.move.hidden = !me || me.team === tk;
        c.move.disabled = byTeam[tk].length >= cap;
        const empties = Array.from({ length: Math.max(0, cap - byTeam[tk].length) }, emptyRow);
        c.list.replaceChildren(...byTeam[tk].map(playerRow), ...empties);
      }
      setText(waiting, unassigned.length ? t('room.unassignedList', { names: unassigned.map((x) => x.name).join(', ') }) : '');
      waiting.hidden = !unassigned.length;
    }
    // 폭파 미션: 전반 진영(firstAttack, 기본은 블루가 먼저 공격)과 공수 교대 안내
    const first = teamKey(p.firstAttack) || 'owner';
    for (const tk of TEAM_KEYS) {
      const role = bomb ? bombSide(tk, first) : '';
      const tag = cols[tk].side;
      tag.hidden = !role;
      tag.dataset.side = role;
      setText(tag, role ? t('room.sideFirst', { side: SIDE_NAME[role] }) : '');
    }
    bombNote.hidden = !bomb;

    // 모드 전환: 방장만(머리글 오른쪽). 다른 사람은 모드 칩으로 확인
    const missionReady = hasMissionMap();
    for (const b of modeBtns) {
      const id = b.getAttribute('data-mode');
      const on = id === mode;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.disabled = !!p.starting || (id === 'bomb' && !missionReady && !on) || (id === 'zombie' && !on && players.length > ZOMBIE_MAX);
      if (id === 'bomb') b.title = missionReady ? '' : t('room.noBombMapYet');
      if (id === 'zombie') b.title = players.length > ZOMBIE_MAX ? t('room.zombieMaxShort', { max: ZOMBIE_MAX }) : '';
    }
    modePick.hidden = !isHost;
    modeChip.el.title = isHost ? '' : t('room.modeHostOnlyChip');

    // 규칙: 방장만 바꾼다. 다른 사람은 설명과 칩으로 확인. 폭파 미션은 클래식뿐이라 고르는 버튼이 없다
    rulePick.el.hidden = !isHost || fixedRule;
    if (isHost && !fixedRule) rulePick.set(RULE_CHOICES, rs);
    if (fixedRule) setText(ruleDesc, `${t('room.fixedRule', { mode: MODE_NAME[mode] })}${zombie ? t('room.zombieAmmoNote') : ''}`);
    else setText(ruleDesc, isHost ? loc(RULESETS[rs], 'desc') : t('room.ruleHostOnly', { desc: loc(RULESETS[rs], 'desc') }));

    // 목표 킬: 개인전에서만 보인다. 고르는 칸은 방장에게만
    killBox.hidden = mode !== 'ffa';
    killPick.el.hidden = !isHost;
    killPick.set(kills, { disabled: !isHost || !!p.starting });
    setText(killDesc, isHost
      ? t('room.killDescHost', { k: kills, min: FFA_KILLS.min, max: FFA_KILLS.max })
      : t('room.killDesc', { k: kills }));

    // 맵: 이 규칙(폭파 미션은 미션 맵)으로 고를 수 있는 맵만 (바뀐 경우에만 다시 그린다)
    const maps = mapsForMode(mapList(ctx.maps, p.maps), mode, rs);
    const sig = JSON.stringify([isHost, p.mapId, maps]);
    if (sig !== mapSig) {
      mapSig = sig;
      mapCur.replaceChildren(m ? mapCard(m) : h('p', { class: 'sk-set-hint', text: t('room.mapUnset') }));
      mapPick.hidden = !isHost;
      mapPick.replaceChildren(...(isHost ? maps.map(pickerCard) : []));
      setText(mapNote, !isHost ? t('room.mapHostOnly') : maps.length ? t('room.mapHostHint') : t('room.noBombMap'));
    }

    const chatOn = platform.chatAllowed;
    chatLog.hidden = !chatOn;
    chatForm.hidden = !chatOn;
    chatOff.hidden = chatOn;
    if (chatOn) renderChat(p.chat);
    paintGear();

    // 시작 조건(방장은 자동 준비)
    //   팀전·폭파 미션: 양 팀 1명 이상 + 팀 미배정 없음 + 방장 외 전원 준비
    //   개인전: 2명 이상 + 방장 외 전원 준비
    const notReady = players.filter((x) => !x.host && !x.ready);
    let reason = '';
    if (zombie) {
      if (players.length > ZOMBIE_MAX) reason = t('room.zombieMax', { max: ZOMBIE_MAX });
    } else if (ffa) {
      if (players.length < 2) reason = t('room.needTwo');
    } else if (byTeam.owner.length < 1 || byTeam.charterer.length < 1) reason = t('room.needBothTeams');
    else if (unassigned.length) reason = t('room.unassignedCount', { n: unassigned.length });
    if (!reason && notReady.length) reason = t('room.notReadyList', { n: notReady.length, names: notReady.map((x) => x.name).join(', ') });

    startBtn.hidden = !isHost;
    readyBtn.hidden = isHost || !me;
    startBtn.disabled = !isHost || !!reason || !!p.starting;
    setText(startBtn, p.starting ? t('room.deploying') : t('room.deployStart'));
    if (me && !isHost) {
      setText(readyBtn, me.ready ? t('room.readyCancel') : t('room.readyUp'));
      readyBtn.classList.toggle('is-on', me.ready);
      readyBtn.setAttribute('aria-pressed', me.ready ? 'true' : 'false');
    }
    let msg;
    if (isHost) msg = reason || t('room.allReady');
    else if (!me) msg = t('room.waitingInfo');
    else if (!me.ready) msg = t('room.readyHint');
    else msg = reason ? t('room.waitHostReason', { reason }) : t('room.waitHost');
    setText(status, msg);
    status.classList.toggle('is-ok', isHost && !reason);
  }

  screen = makeScreen(el, { render, onHide: () => modal.close() });
  screen.onAccount = () => paintGear();
  return screen;
}
