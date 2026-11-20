/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 대기실 화면. 팀 또는 개인전 명단, 준비와 시작, 모드·규칙·개인전 목표 킬·맵 변경, 채팅, 내 장비 칸(주무기·보조무기·근접·수류탄)을 다룬다.
 *          폭파 미션은 팀 칼럼에 전반 진영(먼저 공격/수비)을 붙이고, 규칙은 클래식, 맵은 미션 맵만 고른다.
 *          자리 비움으로 방이 곧 닫히면(idleLeft) 위에 남은 초와 [계속 기다리기] 띠를 띄운다. 화면을 누르거나 키를 치면 'room:active'(1초에 한 번까지).
 *          장비 칸을 누르면 그 칸의 무기 창이 뜨고, 가진 무기는 바로 장착, 안 가진 무기는 포인트로 사서 바로 장착한다(account.buy·equip).
 */
// SKALA 작전 UI — 방(대기실): 팀 칼럼(팀전·폭파 미션) / 한 줄 명단(개인전), 준비/시작, 모드·규칙·목표 킬·맵 변경, 채팅
import { h, btn, setText, num, fmtPoints, TEAMS, TEAM_KEYS, teamKey, pingText, pingClass, modeKey, modeLabel, MODE_ICON, MODE_NAME, SIDE_NAME, bombSide } from './dom.js';
import { makeScreen, mapCard, createChoiceRow, createStepper, createModal, sheet, normWeapon, summaryChips, pointsBadge } from './parts.js';
import { mapList, mapInfo } from './icons.js';
import { RULE_CHOICES, MODE_IDS, ZOMBIE_MAX, mapsForMode, missionMaps, ruleForMode } from './lobby.js';
import { RULESETS, normalizeRuleset, FFA_KILLS, FFA_KILL_PRESETS, normalizeKillTarget } from '../game/modes.js';

const CHAT_MAX = 30;
const CHAT_LEN = 120;
/** 대기실 장비 칸. 수류탄은 팔지 않고 계정 장비에도 없다(언제나 기본 지급) */
const GEAR_SLOTS = [
  { key: 'primary', slot: 1, label: '주무기' },
  { key: 'secondary', slot: 2, label: '보조무기' },
  { key: 'melee', slot: 3, label: '근접' },
  { key: 'grenade', slot: 4, label: '수류탄' },
];

function normPlayers(p) {
  return (Array.isArray(p.players) ? p.players : []).map((x, i) => ({
    id: x.id != null ? x.id : `p${i}`,
    name: x.name || '플레이어',
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
  const modeChip = h('span', { class: 'sk-chip sk-chip--mode' });
  const ruleChip = h('span', { class: 'sk-chip sk-chip--mode' });
  const mapChip = h('span', { class: 'sk-chip' });
  const countChip = h('span', { class: 'sk-chip' });
  const idChip = h('span', { class: 'sk-chip sk-chip--dim' });

  // ---------- 팀 칼럼(폭파 미션은 머리에 전반 진영 '먼저 공격'/'먼저 수비') ----------
  function teamCol(team) {
    const T = TEAMS[team];
    const count = h('span', { class: 'sk-team-count' });
    const move = btn('이 팀으로 이동', () => ctx.emit('room:team', { team }), 'sk-btn--sm');
    const list = h('ul', { class: 'sk-team-list', 'aria-label': `${T.name} 팀 명단` });
    const side = h('span', { class: 'sk-team-side', hidden: true });
    const el = h('section', { class: `sk-team sk-team--${team} sk-steel` },
      h('header', { class: 'sk-team-head' },
        h('h2', { class: 'sk-team-name' },
          h('span', { class: 'sk-team-emoji', text: T.emoji, 'aria-hidden': 'true' }),
          h('span', { text: T.name }), h('small', { text: T.en }), side),
        count, move),
      list);
    return { el, count, move, list, side };
  }
  const cols = { owner: teamCol('owner'), charterer: teamCol('charterer') };
  const waiting = h('p', { class: 'sk-unassigned' });
  const bombNote = h('p', { class: 'sk-room-note', hidden: true, text: '💣 2라운드 뒤 공수 교대' });
  const teamsWrap = h('div', { class: 'sk-room-teams' }, waiting, cols.owner.el, h('div', { class: 'sk-vs', text: 'VS', 'aria-hidden': 'true' }), cols.charterer.el, bombNote);

  // ---------- 개인전 명단(팀 버튼 없음) ----------
  const ffaCount = h('span', { class: 'sk-team-count' });
  const ffaList = h('ul', { class: 'sk-team-list', 'aria-label': '개인전 명단' });
  const ffaEmoji = h('span', { class: 'sk-team-emoji', text: MODE_ICON.ffa, 'aria-hidden': 'true' });
  const ffaName = h('span', { text: '개인전' });
  const ffaSub = h('small', { text: '· 모두가 적' });
  const ffaCol = h('section', { class: 'sk-team sk-team--ffa sk-steel', hidden: true },
    h('header', { class: 'sk-team-head' },
      h('h2', { class: 'sk-team-name' }, ffaEmoji, ffaName, ffaSub),
      ffaCount),
    ffaList);

  // ---------- 모드(방장만 바꿀 수 있음 → 머리글 오른쪽 전환 버튼, 다른 사람은 모드 칩만) ----------
  const modeBtns = MODE_IDS.map((m) => btn([
    h('span', { class: 'sk-mode-ico', text: MODE_ICON[m], 'aria-hidden': 'true' }),
    h('span', { class: 'sk-mode-txt' }, h('b', { text: MODE_NAME[m] })),
  ], () => pickMode(m), 'sk-mode-btn', { role: 'radio', 'data-mode': m }));
  const modePick = h('div', { class: 'sk-modepick sk-modepick--bar', role: 'radiogroup', 'aria-label': '모드 변경(방장)', title: '방장만 모드를 바꿀 수 있어요' }, modeBtns);
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
      h('span', { class: 'sk-pl-crown', text: x.host ? '👑' : '', title: x.host ? '방장' : null }),
      h('span', { class: 'sk-pl-name', text: (x.bot ? '🤖 ' : '') + x.name }),
      x.me ? h('span', { class: 'sk-tag', text: '나' }) : null,
      h('span', { class: 'sk-ping ' + pingClass(x.ping), text: pingText(x.ping), title: '핑' }),
      h('span', { class: 'sk-pl-ready', text: x.host ? '방장' : x.ready ? '✔ 준비' : '대기 중' }));
  }
  const emptyRow = (n) => h('li', { class: 'sk-pl sk-pl--empty' }, h('span', { class: 'sk-pl-crown' }), h('span', { class: 'sk-pl-name', text: n > 1 ? `빈 자리 ×${n}` : '빈 자리' }));

  // ---------- 규칙(방장만 바꿀 수 있음. 바꾸면 세션이 이 규칙으로 고를 수 있는 맵으로 맞춘다. 폭파 미션은 클래식 고정) ----------
  const rulePick = createChoiceRow({ label: '규칙 변경(방장)', onPick: pickRule });
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
    label: '목표 킬', min: FFA_KILLS.min, max: FFA_KILLS.max, presets: FFA_KILL_PRESETS, fmt: (n) => `${n}킬`, onPick: pickKills, cls: 'sk-kill-pick',
  });
  const killDesc = h('p', { class: 'sk-set-hint' });
  const killBox = h('div', { class: 'sk-room-kills', hidden: true },
    h('h3', { class: 'sk-room-kills-title', text: '🎯 목표 킬' }), killPick.el, killDesc);
  function pickKills(n) {
    const me = normPlayers(p).find((x) => x.me);
    const next = normalizeKillTarget(n);
    if (!me || !me.host || p.starting || modeKey(p.mode) !== 'ffa' || next === normalizeKillTarget(p.killTarget)) return;
    screen.update({ killTarget: next }); // 즉시 반영, 다음 update가 오면 그 값이 우선
    ctx.emit('room:killTarget', { killTarget: next });
  }

  // ---------- 맵 ----------
  const mapCur = h('div', { class: 'sk-room-mapcur' });
  const mapPick = h('div', { class: 'sk-mapcards sk-mapcards--sm', role: 'radiogroup', 'aria-label': '맵 변경' });
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
  const chatLog = h('ol', { class: 'sk-chat-log', 'aria-live': 'polite', 'aria-label': '채팅' });
  const chatIn = h('input', {
    class: 'sk-input', type: 'text', maxlength: CHAT_LEN, placeholder: '메시지 입력 후 Enter',
    autocomplete: 'off', spellcheck: 'false', 'aria-label': '채팅 입력',
  });
  const chatForm = h('form', { class: 'sk-chat-form', onsubmit: (e) => { e.preventDefault(); sendChat(); } },
    chatIn, h('button', { type: 'submit', class: 'sk-btn' }, '전송'));
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
        h('span', { class: 'sk-chat-text', text: m.scope === 'team' ? `[팀] ${m.text}` : m.text })))) : [h('li', { class: 'sk-chat-sys', text: '대기실 채팅 — 작전 계획을 나눠 보세요.' })]));
    if (stick) chatLog.scrollTop = chatLog.scrollHeight;
  }

  // ---------- 하단 ----------
  const status = h('p', { class: 'sk-room-status', role: 'status' });
  const readyBtn = btn('준비하기', toggleReady, 'sk-btn--big sk-ready-btn');
  const startBtn = btn('▶ 게임 시작', () => {
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
  const gearBox = h('section', { class: 'sk-panel sk-steel sk-rgear', 'aria-label': '내 장비' },
    h('header', { class: 'sk-rgear-head' }, h('h2', { class: 'sk-panel-title', text: '🎒 내 장비' }), gearPoints.el),
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
      h('span', { class: 'sk-lo-ico', text: w.icon, 'aria-hidden': 'true' }),
      h('div', { class: 'sk-rgear-itext' },
        h('b', { class: 'sk-rgear-iname', text: w.name }, w.premium ? h('span', { class: 'sk-premium', text: '프리미엄' }) : null),
        w.tagline ? h('span', { class: 'sk-lo-tagline', text: w.tagline }) : null,
        w.summary.length ? summaryChips(w.summary) : null),
      h('div', { class: 'sk-rgear-iside' }, state, action));
    return { id: w.id, w, el, state, action };
  }

  function openGear(g) {
    if (!ctx.account || p.starting) return;
    gearOpen = g;
    setText(gearSheetNote, g.key === 'grenade' ? '수류탄은 모두에게 기본으로 지급돼요.' : '가진 무기는 바로 장착하고, 없는 무기는 포인트로 사서 바로 장착해요.');
    gearRows = slotWeapons(g.slot).map((d) => gearRow(g, d));
    modal.open(sheet({
      title: `${g.label} 고르기`, onClose: () => modal.close(), cls: 'sk-rgear-sheet',
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
      const short = owned ? 0 : Math.max(0, r.w.price - a.profile.points);
      r.el.classList.toggle('is-on', on);
      r.el.classList.toggle('is-owned', owned);
      setText(r.state, on ? '장착 중' : owned ? '보유' : fmtPoints(r.w.price));
      setText(r.action, on ? '장착 중' : owned ? '장착' : short ? `${fmtPoints(short)} 부족` : '구매 후 장착');
      r.action.disabled = on || fixed || short > 0 || !!p.starting;
      r.action.classList.toggle('sk-btn--primary', !owned && !short);
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
        setText(gearSheetNote, r.reason === 'points' ? `포인트가 모자라요. ${fmtPoints(w.price - r.points)} 더 필요해요.` : '이 무기는 살 수 없어요.');
        paintGearRows();
        return;
      }
      ctx.emit('ui:sound', { name: 'purchase' });
      bought = r;
    }
    if (!a.equip(g.key, w.id).ok) {
      setText(gearSheetNote, '이 무기는 장착할 수 없어요.');
      paintGear();
      return;
    }
    setText(gearNote, bought
      ? `${w.name}을(를) 사서 장착했어요. 남은 포인트 ${fmtPoints(bought.points)}.`
      : `${g.label} 칸에 ${w.name}을(를) 장착했어요.`);
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
      setText(s.ico, w ? w.icon : '—');
      setText(s.name, w ? w.name : '없음');
      s.el.title = `${s.label} 바꾸기`;
      s.el.disabled = !!p.starting;
    }
    paintGearRows();
  }

  // ---------- 자리 비움 안내: 방장이 곧 방을 닫는다 ----------
  const idleText = h('span', { class: 'sk-room-idle-text' });
  const idleBar = h('div', { class: 'sk-room-idle', role: 'alert', hidden: true },
    idleText,
    btn('계속 기다리기', () => ctx.emit('room:stay', {}), 'sk-btn--sm sk-btn--primary sk-room-idle-stay'));

  const el = h('section', { class: 'sk-screen sk-page sk-room', hidden: true, 'aria-label': '대기실' },
    h('div', { class: 'sk-page-inner' },
      h('header', { class: 'sk-bar' },
        btn('← 나가기', () => ctx.emit('room:leave', { roomId: p.roomId }), 'sk-btn--ghost'),
        h('div', { class: 'sk-bar-title' }, title, h('p', { class: 'sk-bar-sub sk-chips' }, ruleChip, modeChip, mapChip, countChip, idChip)),
        modePick),
      h('div', { class: 'sk-hazard sk-hazard--thin', 'aria-hidden': 'true' }),
      idleBar,
      h('div', { class: 'sk-room-grid' },
        h('div', { class: 'sk-room-left' },
          teamsWrap,
          ffaCol,
          h('section', { class: 'sk-panel sk-steel sk-chat' }, h('h2', { class: 'sk-panel-title', text: '💬 채팅' }), chatLog, chatForm)),
        h('aside', { class: 'sk-room-side' },
          gearBox,
          h('section', { class: 'sk-panel sk-steel' }, h('h2', { class: 'sk-panel-title', text: '🎮 규칙' }), rulePick.el, ruleDesc, killBox),
          h('section', { class: 'sk-panel sk-steel' }, h('h2', { class: 'sk-panel-title', text: '🗺️ 맵' }), mapCur, mapPick, mapNote))),
      h('footer', { class: 'sk-room-foot sk-steel' }, status, h('div', { class: 'sk-room-foot-actions' }, readyBtn, startBtn))),
    modal.el);

  // 대기실을 누르거나 키를 치면 자리 비움을 처음부터 센다(방장 것만 쓰인다). 1초에 한 번까지만 알린다
  let activeAt = -Infinity;
  const onActive = () => {
    const t = Date.now();
    if (t - activeAt < 1000) return;
    activeAt = t;
    ctx.emit('room:active', {});
  };
  el.addEventListener('pointerdown', onActive, true);
  el.addEventListener('keydown', onActive, true);

  function render(props) {
    p = props;
    const idleLeft = Math.max(0, Math.ceil(num(p.idleLeft, 0)));
    idleBar.hidden = !(idleLeft > 0);
    if (idleLeft > 0) setText(idleText, `⏳ ${p.idleSpan || '1분'} 동안 아무 활동이 없어 ${idleLeft}초 뒤 방이 닫혀요`);
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

    setText(title, p.name || '대기실');
    setText(ruleChip, `${RULESETS[rs].icon} ${RULESETS[rs].name}`);
    setText(modeChip, `${MODE_ICON[mode]} ${modeLabel(mode, { killTarget: kills })}`);
    modeChip.classList.toggle('is-ffa', mode === 'ffa');
    modeChip.classList.toggle('is-zombie', zombie);
    setText(ffaEmoji, zombie ? MODE_ICON.zombie : MODE_ICON.ffa);
    setText(ffaName, zombie ? '함께 막는 사람' : '개인전');
    setText(ffaSub, zombie ? '· 모두 같은 편' : '· 모두가 적');
    modeChip.classList.toggle('is-bomb', bomb);
    const m = mapInfo(ctx.maps, p.maps, p.mapId);
    setText(mapChip, `🗺️ ${m ? m.name : '맵 미정'}`);
    setText(countChip, `👥 ${players.length}/${max}`);
    setText(idChip, p.roomId ? `#${p.roomId}` : '');
    idChip.hidden = !p.roomId;

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
      for (const t of TEAM_KEYS) {
        const c = cols[t];
        setText(c.count, `${byTeam[t].length}/${cap}`);
        c.move.hidden = !me || me.team === t;
        c.move.disabled = byTeam[t].length >= cap;
        const empties = Array.from({ length: Math.max(0, cap - byTeam[t].length) }, emptyRow);
        c.list.replaceChildren(...byTeam[t].map(playerRow), ...empties);
      }
      setText(waiting, unassigned.length ? `⏳ 팀 배정 대기: ${unassigned.map((x) => x.name).join(', ')}` : '');
      waiting.hidden = !unassigned.length;
    }
    // 폭파 미션: 전반 진영(firstAttack, 기본은 블루가 먼저 공격)과 공수 교대 안내
    const first = teamKey(p.firstAttack) || 'owner';
    for (const t of TEAM_KEYS) {
      const role = bomb ? bombSide(t, first) : '';
      const tag = cols[t].side;
      tag.hidden = !role;
      tag.dataset.side = role;
      setText(tag, role ? `먼저 ${SIDE_NAME[role]}` : '');
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
      if (id === 'bomb') b.title = missionReady ? '' : '폭파 미션을 할 수 있는 맵이 아직 없어요';
      if (id === 'zombie') b.title = players.length > ZOMBIE_MAX ? `좀비 물량 막기는 ${ZOMBIE_MAX}명까지예요` : '';
    }
    modePick.hidden = !isHost;
    modeChip.title = isHost ? '' : '모드는 방장만 바꿀 수 있어요';

    // 규칙: 방장만 바꾼다. 다른 사람은 설명과 칩으로 확인. 폭파 미션은 클래식뿐이라 고르는 버튼이 없다
    rulePick.el.hidden = !isHost || fixedRule;
    if (isHost && !fixedRule) rulePick.set(RULE_CHOICES, rs);
    if (fixedRule) setText(ruleDesc, `${MODE_NAME[mode]}은 클래식 규칙만 써요${zombie ? ' · 탄은 스테이지 사이에 채워지지 않고 예비 탄이 3배예요' : ''}`);
    else setText(ruleDesc, isHost ? RULESETS[rs].desc : `${RULESETS[rs].desc} · 규칙은 방장만 바꿀 수 있어요.`);

    // 목표 킬: 개인전에서만 보인다. 고르는 칸은 방장에게만
    killBox.hidden = mode !== 'ffa';
    killPick.el.hidden = !isHost;
    killPick.set(kills, { disabled: !isHost || !!p.starting });
    setText(killDesc, isHost
      ? `먼저 ${kills}킬을 채우면 우승해요. ${FFA_KILLS.min}~${FFA_KILLS.max}킬 중에서 고를 수 있어요.`
      : `먼저 ${kills}킬을 채우면 우승해요 · 목표 킬은 방장만 바꿀 수 있어요.`);

    // 맵: 이 규칙(폭파 미션은 미션 맵)으로 고를 수 있는 맵만 (바뀐 경우에만 다시 그린다)
    const maps = mapsForMode(mapList(ctx.maps, p.maps), mode, rs);
    const sig = JSON.stringify([isHost, p.mapId, maps]);
    if (sig !== mapSig) {
      mapSig = sig;
      mapCur.replaceChildren(m ? mapCard(m) : h('p', { class: 'sk-set-hint', text: '맵이 아직 정해지지 않았어요.' }));
      mapPick.hidden = !isHost;
      mapPick.replaceChildren(...(isHost ? maps.map(pickerCard) : []));
      setText(mapNote, !isHost ? '맵은 방장만 바꿀 수 있어요.' : maps.length ? '방장: 카드를 눌러 맵을 바꿀 수 있어요.' : '폭파 미션을 할 수 있는 맵이 없어요.');
    }

    renderChat(p.chat);
    paintGear();

    // 시작 조건(방장은 자동 준비)
    //   팀전·폭파 미션: 양 팀 1명 이상 + 팀 미배정 없음 + 방장 외 전원 준비
    //   개인전: 2명 이상 + 방장 외 전원 준비
    const notReady = players.filter((x) => !x.host && !x.ready);
    let reason = '';
    if (zombie) {
      if (players.length > ZOMBIE_MAX) reason = `좀비 물량 막기는 ${ZOMBIE_MAX}명까지예요.`;
    } else if (ffa) {
      if (players.length < 2) reason = '2명 이상 있어야 시작할 수 있어요.';
    } else if (byTeam.owner.length < 1 || byTeam.charterer.length < 1) reason = '양 팀에 1명 이상 있어야 시작할 수 있어요.';
    else if (unassigned.length) reason = `팀 배정을 기다리는 플레이어가 ${unassigned.length}명 있어요.`;
    if (!reason && notReady.length) reason = `준비 안 된 플레이어 ${notReady.length}명: ${notReady.map((x) => x.name).join(', ')}`;

    startBtn.hidden = !isHost;
    readyBtn.hidden = isHost || !me;
    startBtn.disabled = !isHost || !!reason || !!p.starting;
    setText(startBtn, p.starting ? '시작하는 중…' : '▶ 게임 시작');
    if (me && !isHost) {
      setText(readyBtn, me.ready ? '✔ 준비 완료 (취소)' : '준비하기');
      readyBtn.classList.toggle('is-on', me.ready);
      readyBtn.setAttribute('aria-pressed', me.ready ? 'true' : 'false');
    }
    let msg;
    if (isHost) msg = reason || '모두 준비됐어요. 게임을 시작하세요!';
    else if (!me) msg = '방 정보를 기다리는 중…';
    else if (!me.ready) msg = '준비를 누르면 방장이 게임을 시작할 수 있어요.';
    else msg = reason ? `방장 대기 중 · ${reason}` : '방장이 게임을 시작하기를 기다리는 중…';
    setText(status, msg);
    status.classList.toggle('is-ok', isHost && !reason);
  }

  screen = makeScreen(el, { render, onHide: () => modal.close() });
  screen.onAccount = () => paintGear();
  return screen;
}
