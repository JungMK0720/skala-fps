/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 로비 화면. 방 목록(규칙·모드·목표 킬 배지)과 방 만들기 시트(규칙·모드·개인전 목표 킬·맵·인원)를 그린다.
 *          폭파 미션은 클래식 규칙과 미션 맵만 고른다.
 */
// SKALA 작전 UI — 로비(방 목록 + 방 만들기)
import { h, btn, setText, clamp, num, modeKey, modeLabel, MODE_ICON, MODE_NAME } from './dom.js';
import { PASSWORD_MAX } from '../net/secret.js';
import { makeScreen, createModal, sheet, mapCard, createChoiceRow, createStepper } from './parts.js';
import { mapIcon, mapList, mapInfo } from './icons.js';
import {
  RULESETS, RULESET_IDS, DEFAULT_RULESET, normalizeRuleset, FFA_KILLS, FFA_KILL_PRESETS, normalizeKillTarget
} from '../game/modes.js';

const ROOM_NAME_MAX = 24;
// 방 인원 상한은 세션이 props.maxPlayers로 정한다: Cloudflare 중계는 16명(8:8), Supabase Realtime은 무료 한도 때문에 6명(3:3).
// 값을 안 주면 예전처럼 6명. 이 화면이 받는 가장 큰 값은 ROOM_CAP(net·중계 서버의 방 인원 상한과 같다)
const ROOM_MAX = 6;
const ROOM_CAP = 16;
/** 방 만들기 시트가 처음 고르는 인원(상한이 더 작으면 상한) */
const ROOM_DEFAULT = 8;
/** 최대 인원 빠른 선택(상한보다 큰 값은 빼고, 상한은 늘 넣는다) */
const ROOM_PRESETS = Object.freeze([4, 8, 12, 16]);
const cleanRoomName = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, ROOM_NAME_MAX);
const countOf = (v) => (Array.isArray(v) ? v.length : num(v, 0));
/** rulesets를 적지 않은 맵이 고를 수 있는 규칙(DESIGN 5절) */
const DEFAULT_MAP_RULESETS = Object.freeze(['classic', 'sniper']);

/** 규칙 고르는 버튼 묶음의 항목(방 만들기 시트와 대기실이 같이 쓴다) */
export const RULE_CHOICES = Object.freeze(RULESET_IDS.map((id) => Object.freeze({
  id, label: RULESETS[id].name, icon: RULESETS[id].icon, title: RULESETS[id].desc,
})));

/** 고를 수 있는 모드(방 만들기 시트와 대기실이 같이 쓴다) */
export const MODE_IDS = Object.freeze(['team', 'ffa', 'bomb', 'zombie']);
/** 좀비 물량 막기 방의 최대 인원(함께 막는 사람 수) */
export const ZOMBIE_MAX = 4;
/** 폭파 미션은 클래식 규칙만 쓴다 */
export const BOMB_RULESET = 'classic';
/** 모드 칸의 작은 글자. 개인전 칸은 고른 목표 킬을 넣어 ffaSubText로 쓴다 */
const MODE_SUB = Object.freeze({ team: '블루 vs 레드 · 5판 3선승', bomb: '공격·수비 · A/B 구역에 폭탄', zombie: '함께 버티기 · 최대 4명' });
const ffaSubText = (kills) => `모두가 적 · ${kills}킬`;
const MODE_HINT = Object.freeze({
  team: '블루 vs 레드 섬멸전이에요. 라운드 중 부활 없이 5판 3선승으로 겨뤄요.',
  bomb: '공격 팀은 A나 B 구역에 폭탄을 설치하고, 수비 팀은 막거나 해체해요. 5판 3선승이고 2라운드 뒤 공수를 바꿔요.',
  zombie: '최대 4명이 함께 스테이지마다 몰려오는 좀비를 막아요. 탄은 스테이지 사이에 채워지지 않고(예비 탄 3배), 깰 때마다 강화 카드를 1장씩 골라요. 5스테이지마다 보스가 나와요.',
});
/** 모드 안내 글. 개인전은 고른 목표 킬을 넣는다 */
const modeHintText = (mode, kills) => (mode === 'ffa'
  ? `모두가 적이에요. 먼저 ${kills}킬을 채우면 우승하고, 죽으면 3초 뒤 부활해요.` : MODE_HINT[mode]);

/** 이 모드에서 쓰는 규칙. 폭파 미션과 좀비 물량 막기는 언제나 클래식 */
export function ruleForMode(mode, ruleset) {
  const m = modeKey(mode);
  return m === 'bomb' || m === 'zombie' ? BOMB_RULESET : normalizeRuleset(ruleset);
}

/**
 * 방 목록 배지 글자. 예: '칼전 · 개인전', '클래식 · 폭파 미션'. 규칙이 없는 옛 방은 클래식이다.
 * killTarget을 넘기면 개인전 배지에 목표 킬을 붙인다('칼전 · 개인전 · 10킬'). 팀전·폭파 미션에는 붙이지 않는다
 */
export function ruleBadge(ruleset, mode, killTarget) {
  if (modeKey(mode) === 'zombie') return `🧟 ${MODE_NAME.zombie}`;
  const base = `${RULESETS[ruleForMode(mode, ruleset)].name} · ${MODE_NAME[modeKey(mode)]}`;
  return modeKey(mode) === 'ffa' && killTarget !== undefined ? `${base} · ${normalizeKillTarget(killTarget)}킬` : base;
}

/** 맵 목록에서 이 규칙으로 고를 수 있는 맵만 남긴다. 하나도 없으면 그대로 둔다(고를 맵이 없어 막히지 않게) */
export function mapsForRule(maps, ruleset) {
  const id = normalizeRuleset(ruleset);
  const valid = maps.filter((m) => (Array.isArray(m.rulesets) ? m.rulesets : DEFAULT_MAP_RULESETS).includes(id));
  return valid.length ? valid : maps;
}

/** 폭파 미션을 할 수 있는 맵(MAP_LIST 항목의 mission이 true이고 클래식을 고를 수 있음). 없으면 빈 목록이고, 그때는 폭파 미션을 고를 수 없다 */
export function missionMaps(maps) {
  return maps.filter((m) => !!m && m.mission === true && (Array.isArray(m.rulesets) ? m.rulesets : DEFAULT_MAP_RULESETS).includes(BOMB_RULESET));
}

/** 모드·규칙으로 고를 수 있는 맵. 폭파 미션은 미션 맵만, 좀비 물량 막기는 클래식 맵, 나머지는 mapsForRule */
export function mapsForMode(maps, mode, ruleset) {
  const m = modeKey(mode);
  return m === 'bomb' ? missionMaps(maps) : mapsForRule(maps, m === 'zombie' ? BOMB_RULESET : ruleset);
}

export function createLobby(ctx) {
  let p = {};
  let formMap = null;
  let formMax = ROOM_DEFAULT;
  let formMode = 'team';
  let formRule = DEFAULT_RULESET;
  let formKills = FFA_KILLS.def;
  const modal = createModal();
  const myName = () => p.name || ctx.playerName || '플레이어';

  // ---------- 헤더 ----------
  const meChip = h('span', { class: 'sk-chip sk-chip--me' });
  const countText = h('span', { class: 'sk-lobby-count' });
  const refreshBtn = btn('⟳ 새로고침', () => ctx.emit('lobby:refresh', {}), '', { 'aria-label': '방 목록 새로고침' });

  // ---------- 방 만들기 폼 ----------
  const nameIn = h('input', {
    class: 'sk-input', type: 'text', maxlength: ROOM_NAME_MAX, placeholder: '예: 오늘 밤 3:3',
    autocomplete: 'off', spellcheck: 'false', 'aria-label': '방 이름', 'data-autofocus': '',
  });
  // 비밀번호는 친구에게 알려 주는 값이라 가리지 않는다(type=text). 브라우저 비밀번호 저장도 뜨지 않는다
  const pwIn = h('input', {
    class: 'sk-input', type: 'text', maxlength: PASSWORD_MAX, placeholder: '비워 두면 누구나 들어와요',
    autocomplete: 'off', spellcheck: 'false', 'aria-label': '비밀번호(선택)',
  });
  const mapBox = h('div', { class: 'sk-mapcards', role: 'radiogroup', 'aria-label': '맵 선택' });
  const ffaSub = h('small');
  const modeBtns = MODE_IDS.map((m) => btn([
    h('span', { class: 'sk-mode-ico', text: MODE_ICON[m], 'aria-hidden': 'true' }),
    h('span', { class: 'sk-mode-txt' },
      h('b', { text: MODE_NAME[m] }),
      m === 'ffa' ? ffaSub : h('small', { text: MODE_SUB[m] })),
  ], () => setMode(m), 'sk-mode-btn', { role: 'radio', 'data-mode': m }));
  const modeHint = h('p', { class: 'sk-set-hint' });
  // 개인전 목표 킬: 개인전을 고를 때만 보인다(대기실에서도 방장이 다시 바꿀 수 있다)
  const killPick = createStepper({
    label: '목표 킬', min: FFA_KILLS.min, max: FFA_KILLS.max, presets: FFA_KILL_PRESETS, fmt: (n) => `${n}킬`, onPick: (n) => setKills(n), cls: 'sk-kill-pick',
  });
  const killField = h('div', { class: 'sk-field', hidden: true }, h('span', { class: 'sk-field-label', text: '목표 킬' }), killPick.el);
  // 폭파 미션이면 클래식으로 고정하고 버튼을 끈다(고른 규칙은 다른 모드로 돌아가면 다시 쓴다)
  const ruleRow = createChoiceRow({ label: '규칙 선택', onPick: (id) => { if (formMode !== 'bomb' && formMode !== 'zombie') setRule(id); } });
  const ruleHint = h('p', { class: 'sk-set-hint' });
  const maxOut = h('output', { class: 'sk-stepper-val', 'aria-live': 'polite' });
  const maxNote = h('span', { class: 'sk-set-hint' });
  const minus = btn('−', () => setMax(formMax - 1), 'sk-btn--icon', { 'aria-label': '최대 인원 줄이기' });
  const plus = btn('＋', () => setMax(formMax + 1), 'sk-btn--icon', { 'aria-label': '최대 인원 늘리기' });
  const maxQuick = createChoiceRow({ label: '최대 인원 빠른 선택', onPick: (id) => setMax(Number(id)), cls: 'sk-stepper-quick' });
  const formErr = h('p', { class: 'sk-field-err', role: 'alert' });
  const form = h('form', { class: 'sk-create', novalidate: true, onsubmit: (e) => { e.preventDefault(); doCreate(); } },
    h('label', { class: 'sk-field' }, h('span', { class: 'sk-field-label', text: '방 이름' }), nameIn),
    h('label', { class: 'sk-field' }, h('span', { class: 'sk-field-label', text: '비밀번호 (선택)' }), pwIn),
    h('div', { class: 'sk-field' },
      h('span', { class: 'sk-field-label', text: '규칙' }),
      ruleRow.el,
      ruleHint),
    h('div', { class: 'sk-field' },
      h('span', { class: 'sk-field-label', text: '모드' }),
      h('div', { class: 'sk-modepick', role: 'radiogroup', 'aria-label': '모드 선택' }, modeBtns),
      modeHint),
    killField,
    h('div', { class: 'sk-field' }, h('span', { class: 'sk-field-label', text: '맵 선택' }), mapBox),
    h('div', { class: 'sk-field' },
      h('span', { class: 'sk-field-label', text: '최대 인원' }),
      h('div', { class: 'sk-stepper', role: 'group', 'aria-label': '최대 인원' }, minus, maxOut, plus, maxQuick.el),
      maxNote),
    formErr,
    h('div', { class: 'sk-form-actions' },
      btn('취소', () => modal.close(), 'sk-btn--ghost'),
      h('button', { type: 'submit', class: 'sk-btn sk-btn--primary' }, '＋ 방 만들기')));
  const createSheet = sheet({ title: '＋ 방 만들기', onClose: () => modal.close(), body: form, cls: 'sk-create-sheet' });

  const roomMax = () => (formMode === 'zombie' ? Math.min(ZOMBIE_MAX, clamp(Math.round(num(p.maxPlayers, ROOM_MAX)), 2, ROOM_CAP)) : clamp(Math.round(num(p.maxPlayers, ROOM_MAX)), 2, ROOM_CAP));
  function setMax(n) {
    const top = roomMax();
    formMax = clamp(Math.round(num(n, ROOM_DEFAULT)), 2, top);
    setText(maxOut, `${formMax}명`);
    setText(maxNote, formMode === 'ffa' ? `최대 ${formMax}명 · 모두가 적` : formMode === 'zombie' ? `최대 ${formMax}명이 함께 막아요` : `팀당 최대 ${Math.ceil(formMax / 2)}명`);
    minus.disabled = formMax <= 2;
    plus.disabled = formMax >= top;
    const quick = formMode === 'zombie' ? [2, 3, 4].filter((v) => v <= top) : [...new Set([...ROOM_PRESETS.filter((v) => v < top), top])];
    maxQuick.set(quick.map((v) => ({ id: String(v), label: `${v}명` })), String(formMax));
  }
  const allMaps = () => mapList(ctx.maps, p.maps);
  /** 모드를 바꾼다. 미션 맵이 하나도 없으면 폭파 미션 대신 팀전 */
  function setMode(m) {
    const ready = missionMaps(allMaps()).length > 0;
    formMode = modeKey(m) === 'bomb' && !ready ? 'team' : modeKey(m);
    for (const b of modeBtns) {
      const id = b.getAttribute('data-mode');
      const on = id === formMode;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      if (id === 'bomb') {
        b.disabled = !ready;
        b.title = ready ? '' : '폭파 미션을 할 수 있는 맵이 아직 없어요';
      }
    }
    killField.hidden = formMode !== 'ffa';
    setKills(formKills);   // 개인전 칸 글자와 모드 안내도 여기서 쓴다
    renderRule();
    renderMapCards();
    setMax(formMax);
  }
  function setKills(n) {
    formKills = normalizeKillTarget(n);
    killPick.set(formKills);
    setText(ffaSub, ffaSubText(formKills));
    setText(modeHint, modeHintText(formMode, formKills));
  }
  function setRule(id) {
    const next = normalizeRuleset(id);
    // 규칙을 바꾸면 그 규칙의 첫 맵(기본 맵, 칼전은 좁은 칼전 맵)으로 옮긴다. 같은 규칙이면 고른 맵을 둔다
    if (next !== formRule) formMap = null;
    formRule = next;
    renderRule();
    renderMapCards();
  }
  function renderRule() {
    const fixed = formMode === 'bomb' || formMode === 'zombie';
    const rs = ruleForMode(formMode, formRule);
    ruleRow.set(RULE_CHOICES, rs);
    for (const b of ruleRow.el.children) b.disabled = fixed;
    setText(ruleHint, fixed ? `${MODE_NAME[formMode]}은 클래식 규칙만 써요` : RULESETS[rs].desc);
  }
  function renderMapCards() {
    const maps = mapsForMode(allMaps(), formMode, formRule);
    if (!maps.some((m) => m.id === formMap)) formMap = maps[0] ? maps[0].id : null;
    mapBox.replaceChildren(...maps.map((m) => mapCard(m, {
      selected: m.id === formMap,
      onPick: (id) => { formMap = id; setText(formErr, ''); renderMapCards(); },
    })));
  }
  function openCreate() {
    setText(formErr, '');
    if (!nameIn.value) nameIn.value = cleanRoomName(`${myName()}의 방`);
    setMode(formMode); // 규칙 · 맵 카드 · 인원도 다시 그린다
    // 터치 기기에서 입력칸에 바로 포커스를 주면 가상 키보드가 시트를 덮는다. 이름은 이미 채워 두었으니 손으로 누를 때만 연다
    const touch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    if (touch) nameIn.removeAttribute('data-autofocus');
    modal.open(createSheet);
    if (!touch) nameIn.select();
  }
  function doCreate() {
    const name = cleanRoomName(nameIn.value) || cleanRoomName(`${myName()}의 방`);
    if (!formMap) { setText(formErr, '맵을 골라 주세요.'); return; }
    const password = pwIn.value.trim().slice(0, PASSWORD_MAX);
    modal.close();
    ctx.emit('lobby:create', {
      name, mapId: formMap, max: formMax, mode: formMode, ruleset: ruleForMode(formMode, formRule),
      ...(formMode === 'ffa' ? { killTarget: formKills } : {}), ...(password ? { password } : {})
    });
  }

  // ---------- 비밀번호 입력 ----------
  function askPassword(r) {
    const input = h('input', {
      class: 'sk-input', type: 'text', maxlength: PASSWORD_MAX, placeholder: '방장에게 받은 비밀번호',
      autocomplete: 'off', spellcheck: 'false', 'aria-label': '비밀번호', 'data-autofocus': '',
    });
    const err = h('p', { class: 'sk-field-err', role: 'alert' });
    const form = h('form', {
      class: 'sk-create sk-pw-form', novalidate: true,
      onsubmit: (e) => {
        e.preventDefault();
        const password = input.value.trim().slice(0, PASSWORD_MAX);
        if (!password) { setText(err, '비밀번호를 입력해 주세요.'); return; }
        modal.close();
        ctx.emit('lobby:join', { roomId: r.roomId, password });
      },
    },
    h('label', { class: 'sk-field' }, h('span', { class: 'sk-field-label', text: r.name || '이름 없는 방' }), input),
    err,
    h('div', { class: 'sk-form-actions' },
      btn('취소', () => modal.close(), 'sk-btn--ghost'),
      h('button', { type: 'submit', class: 'sk-btn sk-btn--primary' }, '들어가기')));
    modal.open(sheet({ title: '🔒 비밀번호 방', onClose: () => modal.close(), body: form, cls: 'sk-pw-sheet' }));
  }

  // ---------- 방 목록 ----------
  const list = h('div', { class: 'sk-rooms', role: 'list', 'aria-label': '방 목록' });
  const statusEl = h('div', { class: 'sk-lobby-status', role: 'status' });

  function roomRow(r) {
    const n = countOf(r.players);
    const max = Math.max(1, num(r.max, ROOM_MAX));
    const playing = r.status === 'playing';
    // 경기 중인 방은 팀전·폭파 미션만 잠근다. 개인전은 언제 들어가도 곧 출격하고(match.js joinFfa: 부활 시간 뒤), 좀비 방은 다음 스테이지부터 함께한다
    const locked = playing && r.mode !== 'ffa' && r.mode !== 'zombie';
    const full = n >= max;
    const joining = p.joining != null && p.joining === r.roomId;
    const m = mapInfo(ctx.maps, p.maps, r.mapId);
    const label = locked ? '진행 중' : full ? '만원' : joining ? '참가 중…' : playing ? '중간 참가' : '참가';
    return h('div', { class: 'sk-room-row sk-steel' + (locked || full ? ' is-locked' : ''), role: 'listitem' },
      h('div', { class: 'sk-room-ico' }, mapIcon(r.mapId)),
      h('div', { class: 'sk-room-main' },
        h('div', { class: 'sk-room-name', text: (r.locked ? '🔒 ' : '') + (r.name || '이름 없는 방'), title: r.locked ? '비밀번호가 있는 방' : null }),
        h('div', { class: 'sk-room-meta' },
          h('span', {
            class: `sk-mode-badge sk-mode-badge--${modeKey(r.mode)}`,
            text: ruleBadge(r.ruleset, r.mode, r.killTarget ?? FFA_KILLS.def), title: modeLabel(r.mode, { killTarget: normalizeKillTarget(r.killTarget) }),
          }),
          h('span', { class: 'sk-room-map', text: m ? [m.name, m.tag].filter(Boolean).join(' · ') : '맵 미정' }),
          h('span', { class: 'sk-room-host' }, h('span', { text: '👑', 'aria-label': '방장' }), h('span', { text: r.hostName || '?' })))),
      h('div', { class: 'sk-room-count', title: `${n}/${max}명` },
        h('b', { text: `${n}/${max}` }),
        h('span', { class: 'sk-meter' }, h('i', { style: { transform: `scaleX(${clamp(n / max, 0, 1)})` } }))),
      h('span', { class: 'sk-badge ' + (playing ? 'sk-badge--live' : 'sk-badge--wait'), text: playing ? '게임 중' : '대기' }),
      btn(label, () => (r.locked ? askPassword(r) : ctx.emit('lobby:join', { roomId: r.roomId })), 'sk-btn--primary sk-room-join', {
        disabled: locked || full || joining,
        'aria-label': `${r.name || '방'} ${label}`,
        title: locked ? `${MODE_NAME[modeKey(r.mode)]}은 경기가 끝나면 들어갈 수 있어요` : playing && !full ? (r.mode === 'zombie' ? '진행 중인 좀비 방에 들어가 다음 스테이지부터 함께해요' : '진행 중인 개인전에 들어가 곧 출격해요') : null,
      }));
  }

  function emptyState() {
    return h('div', { class: 'sk-empty' },
      h('div', { class: 'sk-empty-art', 'aria-hidden': 'true' }, mapIcon('_')),
      h('p', { class: 'sk-empty-title', text: '열려 있는 방이 없어요' }),
      h('p', { class: 'sk-empty-sub', text: '첫 방을 열고 동료를 기다려 보세요.' }),
      btn('＋ 방 만들기', openCreate, 'sk-btn--primary'));
  }

  const el = h('section', { class: 'sk-screen sk-page sk-lobby', hidden: true, 'aria-label': '로비' },
    h('div', { class: 'sk-page-inner' },
      h('header', { class: 'sk-bar' },
        btn('← 메뉴', () => ctx.emit('lobby:back', {}), 'sk-btn--ghost'),
        h('div', { class: 'sk-bar-title' },
          h('h1', { class: 'sk-h1 sk-stencil', text: '🌐 로비' }),
          h('p', { class: 'sk-bar-sub' }, h('span', { text: '방 목록 · ' }), countText)),
        h('div', { class: 'sk-bar-actions' }, meChip, refreshBtn, btn('＋ 방 만들기', openCreate, 'sk-btn--primary'))),
      h('div', { class: 'sk-hazard sk-hazard--thin', 'aria-hidden': 'true' }),
      statusEl,
      list),
    modal.el);

  let listSig = '';
  function render(props) {
    p = props;
    const rooms = (Array.isArray(p.rooms) ? p.rooms : []).slice()
      .sort((a, b) => (a.status === 'playing') - (b.status === 'playing'));
    setText(meChip, `👤 ${p.name || ctx.playerName || '플레이어'}`);
    setText(countText, p.loading && !rooms.length ? '불러오는 중' : `방 ${rooms.length}개`);
    refreshBtn.disabled = !!p.loading;

    // 같은 데이터면 다시 그리지 않는다(누르는 중인 참가 버튼이 바뀌지 않게)
    const sig = JSON.stringify([rooms, p.loading, p.error, p.notice, p.joining, p.maps, ctx.maps.size]);
    if (sig === listSig) return;
    listSig = sig;
    statusEl.replaceChildren();
    if (p.error) {
      statusEl.append(h('div', { class: 'sk-alert sk-alert--bad' },
        h('span', { text: `⚠️ ${p.error}` }),
        btn('다시 시도', () => ctx.emit('lobby:refresh', {}), 'sk-btn--sm')));
    } else if (p.notice) {
      // 알림(자리 비움으로 방이 닫힘 등): 실패가 아니라서 다시 시도 버튼이 없다
      statusEl.append(h('div', { class: 'sk-alert sk-alert--info', role: 'status' }, h('span', { text: `ℹ️ ${p.notice}` })));
    }
    if (p.loading && !rooms.length) {
      list.replaceChildren(h('div', { class: 'sk-loading' }, h('span', { class: 'sk-spinner', 'aria-hidden': 'true' }), h('span', { text: '방 목록을 불러오는 중…' })));
    } else if (!rooms.length) {
      list.replaceChildren(p.error ? h('div') : emptyState());
    } else {
      list.replaceChildren(...rooms.map(roomRow));
    }
  }

  return makeScreen(el, { render, onHide: () => modal.close() });
}
