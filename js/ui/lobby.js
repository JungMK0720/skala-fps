/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 로비 화면. 방 목록과 방 만들기 시트를 그린다.
 */
// SKALA FPS UI — 로비(방 목록 + 방 만들기)
import { h, btn, setText, clamp, num, modeKey, modeLabel, MODE_ICON } from './dom.js';
import { makeScreen, createModal, sheet, mapCard } from './parts.js';
import { mapIcon, mapList, mapInfo } from './icons.js';

const ROOM_NAME_MAX = 24;
// 무료 Realtime 한도(초당 메시지) 때문에 방은 최대 6명(3:3). props.maxPlayers로 더 낮출 수 있다.
const ROOM_MAX = 6;
const cleanRoomName = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, ROOM_NAME_MAX);
const countOf = (v) => (Array.isArray(v) ? v.length : num(v, 0));

export function createLobby(ctx) {
  let p = {};
  let formMap = null;
  let formMax = ROOM_MAX;
  let formMode = 'team';
  const modal = createModal();

  // ---------- 헤더 ----------
  const meChip = h('span', { class: 'sk-chip sk-chip--me' });
  const countText = h('span', { class: 'sk-lobby-count' });
  const refreshBtn = btn('⟳ 새로고침', () => ctx.emit('lobby:refresh', {}), '', { 'aria-label': '방 목록 새로고침' });

  // ---------- 방 만들기 폼 ----------
  const nameIn = h('input', {
    class: 'sk-input', type: 'text', maxlength: ROOM_NAME_MAX, placeholder: '예: 오늘 밤 3:3',
    autocomplete: 'off', spellcheck: 'false', 'aria-label': '방 이름', 'data-autofocus': '',
  });
  const mapBox = h('div', { class: 'sk-mapcards', role: 'radiogroup', 'aria-label': '맵 선택' });
  const modeBtns = ['team', 'ffa'].map((m) => btn([
    h('span', { class: 'sk-mode-ico', text: MODE_ICON[m], 'aria-hidden': 'true' }),
    h('span', { class: 'sk-mode-txt' },
      h('b', { text: m === 'ffa' ? '개인전' : '팀전' }),
      h('small', { text: m === 'ffa' ? '모두가 적 · 20킬' : '블루 vs 오렌지 · 5판 3선승' })),
  ], () => setMode(m), 'sk-mode-btn', { role: 'radio', 'data-mode': m }));
  const modeHint = h('p', { class: 'sk-set-hint' });
  const maxOut = h('output', { class: 'sk-stepper-val', 'aria-live': 'polite' });
  const maxNote = h('span', { class: 'sk-set-hint' });
  const minus = btn('−', () => setMax(formMax - 1), 'sk-btn--icon', { 'aria-label': '최대 인원 줄이기' });
  const plus = btn('＋', () => setMax(formMax + 1), 'sk-btn--icon', { 'aria-label': '최대 인원 늘리기' });
  const formErr = h('p', { class: 'sk-field-err', role: 'alert' });
  const form = h('form', { class: 'sk-create', novalidate: true, onsubmit: (e) => { e.preventDefault(); doCreate(); } },
    h('label', { class: 'sk-field' }, h('span', { class: 'sk-field-label', text: '방 이름' }), nameIn),
    h('div', { class: 'sk-field' },
      h('span', { class: 'sk-field-label', text: '모드' }),
      h('div', { class: 'sk-modepick', role: 'radiogroup', 'aria-label': '모드 선택' }, modeBtns),
      modeHint),
    h('div', { class: 'sk-field' }, h('span', { class: 'sk-field-label', text: '맵 선택' }), mapBox),
    h('div', { class: 'sk-field' },
      h('span', { class: 'sk-field-label', text: '최대 인원' }),
      h('div', { class: 'sk-stepper' }, minus, maxOut, plus, maxNote)),
    formErr,
    h('div', { class: 'sk-form-actions' },
      btn('취소', () => modal.close(), 'sk-btn--ghost'),
      h('button', { type: 'submit', class: 'sk-btn sk-btn--primary' }, '＋ 방 만들기')));
  const createSheet = sheet({ title: '＋ 방 만들기', onClose: () => modal.close(), body: form, cls: 'sk-create-sheet' });

  const roomMax = () => clamp(Math.round(num(p.maxPlayers, ROOM_MAX)), 2, ROOM_MAX);
  function setMax(n) {
    formMax = clamp(Math.round(n), 2, roomMax());
    setText(maxOut, `${formMax}명`);
    setText(maxNote, formMode === 'ffa' ? `최대 ${formMax}명 · 모두가 적` : `팀당 최대 ${Math.ceil(formMax / 2)}명`);
    minus.disabled = formMax <= 2;
    plus.disabled = formMax >= roomMax();
  }
  function setMode(m) {
    formMode = modeKey(m);
    for (const b of modeBtns) {
      const on = b.getAttribute('data-mode') === formMode;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    }
    setText(modeHint, formMode === 'ffa'
      ? '모두가 적이에요. 먼저 20킬을 채우면 우승하고, 죽으면 3초 뒤 부활해요.'
      : '블루 vs 오렌지 섬멸전이에요. 라운드 중 부활 없이 5판 3선승으로 겨뤄요.');
    setMax(formMax);
  }
  function renderMapCards() {
    const maps = mapList(ctx.maps, p.maps);
    if (!maps.some((m) => m.id === formMap)) formMap = maps[0] ? maps[0].id : null;
    mapBox.replaceChildren(...maps.map((m) => mapCard(m, {
      selected: m.id === formMap,
      onPick: (id) => { formMap = id; setText(formErr, ''); renderMapCards(); },
    })));
  }
  function openCreate() {
    setText(formErr, '');
    if (!nameIn.value) nameIn.value = cleanRoomName(`${ctx.playerName || '플레이어'}의 방`);
    renderMapCards();
    setMode(formMode);
    modal.open(createSheet);
    nameIn.select();
  }
  function doCreate() {
    const name = cleanRoomName(nameIn.value) || cleanRoomName(`${ctx.playerName || '플레이어'}의 방`);
    if (!formMap) { setText(formErr, '맵을 골라 주세요.'); return; }
    modal.close();
    ctx.emit('lobby:create', { name, mapId: formMap, max: formMax, mode: formMode });
  }

  // ---------- 방 목록 ----------
  const list = h('div', { class: 'sk-rooms', role: 'list', 'aria-label': '방 목록' });
  const statusEl = h('div', { class: 'sk-lobby-status', role: 'status' });

  function roomRow(r) {
    const n = countOf(r.players);
    const max = Math.max(1, num(r.max, ROOM_MAX));
    const playing = r.status === 'playing';
    const full = n >= max;
    const joining = p.joining != null && p.joining === r.roomId;
    const m = mapInfo(ctx.maps, p.maps, r.mapId);
    const label = playing ? '진행 중' : full ? '만원' : joining ? '참가 중…' : '참가';
    return h('div', { class: 'sk-room-row sk-steel' + (playing || full ? ' is-locked' : ''), role: 'listitem' },
      h('div', { class: 'sk-room-ico' }, mapIcon(r.mapId)),
      h('div', { class: 'sk-room-main' },
        h('div', { class: 'sk-room-name', text: r.name || '이름 없는 방' }),
        h('div', { class: 'sk-room-meta' },
          h('span', { class: `sk-mode-badge sk-mode-badge--${modeKey(r.mode)}`, text: modeLabel(r.mode, { killTarget: r.killTarget }) }),
          h('span', { class: 'sk-room-map', text: m ? m.name : '맵 미정' }),
          h('span', { class: 'sk-room-host' }, h('span', { text: '👑', 'aria-label': '방장' }), h('span', { text: r.hostName || '?' })))),
      h('div', { class: 'sk-room-count', title: `${n}/${max}명` },
        h('b', { text: `${n}/${max}` }),
        h('span', { class: 'sk-meter' }, h('i', { style: { transform: `scaleX(${clamp(n / max, 0, 1)})` } }))),
      h('span', { class: 'sk-badge ' + (playing ? 'sk-badge--live' : 'sk-badge--wait'), text: playing ? '게임 중' : '대기' }),
      btn(label, () => ctx.emit('lobby:join', { roomId: r.roomId }), 'sk-btn--primary sk-room-join', {
        disabled: playing || full || joining,
        'aria-label': `${r.name || '방'} ${label}`,
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
    const sig = JSON.stringify([rooms, p.loading, p.error, p.joining, p.maps, ctx.maps.size]);
    if (sig === listSig) return;
    listSig = sig;
    statusEl.replaceChildren();
    if (p.error) {
      statusEl.append(h('div', { class: 'sk-alert sk-alert--bad' },
        h('span', { text: `⚠️ ${p.error}` }),
        btn('다시 시도', () => ctx.emit('lobby:refresh', {}), 'sk-btn--sm')));
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
