/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 마이페이지. 닉네임 변경, 포인트, 전적, 장비 3칸, 캐릭터(초상·가진 캐릭터 고르기), 찾은 비밀 스팟, 이 기기의 데이터 초기화(두 번 확인)를 보여 준다.
 *          이벤트: mypage:back, mypage:shop { tab? }. 계정이 바뀌면 index.js가 다시 그린다.
 */
import { h, btn, setText, fmtPlayTime } from './dom.js';
import { avatarArtEl, createChoiceRow, makeScreen, pointsBadge } from './parts.js';
import { createNicknameField } from './nickname.js';
import { TEAM_IDS } from '../core/consts.js';
import { AVATARS, DEFAULT_AVATAR, avatarById } from '../core/avatar-defs.js';

const STAT_CELLS = [
  ['kills', '킬'], ['deaths', '데스'], ['kd', 'K/D'],
  ['headshots', '헤드샷'], ['halfShots', '반샷'], ['knifeKills', '칼 킬'],
  ['matches', '경기'], ['wins', '승'], ['time', '플레이 시간'],
];
const EQUIP_SLOTS = [['primary', 1, '주무기'], ['secondary', 2, '보조'], ['melee', 3, '근접']];

const count = (n) => Number(n || 0).toLocaleString('ko-KR');

export function createMyPage(ctx) {
  const account = () => ctx.account;
  const back = () => ctx.emit('mypage:back', {});

  // ---------- 닉네임 ----------
  const nameNow = h('strong', { class: 'sk-my-name' });
  const saveBtn = h('button', { type: 'submit', class: 'sk-btn sk-btn--primary sk-my-save', disabled: true, text: '저장' });
  const nameNote = h('p', { class: 'sk-note' });
  const field = createNicknameField(ctx, {
    id: 'sk-my-nick',
    label: '새 닉네임',
    current: () => account().profile.nickname,
    onState: () => { saveBtn.disabled = !field.canSubmit; },
    onSaved: () => {
      renderName();
      field.input.focus({ preventScroll: true }); // 저장 버튼이 꺼지므로 포커스를 입력칸으로 돌린다
    },
  });
  const nameForm = h('form', { class: 'sk-my-nickform', novalidate: true, onsubmit: (e) => { e.preventDefault(); field.submit(); } },
    field.el, saveBtn);

  function renderName() {
    const a = account();
    setText(nameNow, a.profile.nickname || '아직 없어요');
    let note = '';
    if (!a.remoteEnabled) note = '오프라인 모드예요. 닉네임은 이 기기에만 저장돼요.';
    else if (a.nicknamePending) note = '이 닉네임은 아직 서버에 등록되지 않았어요. 멀티 입장 때 다시 등록해요.';
    setText(nameNote, note);
    nameNote.hidden = !note;
  }

  // ---------- 전적 ----------
  const statValues = new Map(STAT_CELLS.map(([key]) => [key, h('dd', { text: '0' })]));
  const statGrid = h('dl', { class: 'sk-my-stats' },
    STAT_CELLS.map(([key, label]) => h('div', { class: 'sk-my-stat' }, h('dt', { text: label }), statValues.get(key))));

  function renderStats(stats) {
    const ratio = stats.kills / Math.max(1, stats.deaths);
    const cell = { ...stats, kd: ratio.toFixed(2), time: fmtPlayTime(stats.secondsPlayed) };
    for (const [key] of STAT_CELLS) {
      const v = cell[key];
      setText(statValues.get(key), typeof v === 'number' ? count(v) : v);
    }
  }

  // ---------- 포인트 ----------
  const points = pointsBadge('sk-points--big');

  // ---------- 장비 ----------
  const equipRows = EQUIP_SLOTS.map(([key, slot, label]) => {
    const current = h('span', { class: 'sk-my-equipnow' });
    const row = createChoiceRow({ label: `${label} 고르기`, onPick: (id) => { account().equip(key, id); renderEquip(); } });
    const el = h('div', { class: 'sk-my-equiprow' },
      h('div', { class: 'sk-my-equiphead' }, h('span', { class: 'sk-field-label', text: label }), current),
      row.el);
    return { key, slot, current, row, el };
  });

  function ownedInSlot(slot) {
    const a = account();
    const list = [];
    for (const w of ctx.weapons.values()) if (w.slot === slot && a.isOwned(w.id)) list.push(w);
    return list;
  }

  function renderEquip() {
    const loadout = account().loadout;
    for (const r of equipRows) {
      const items = ownedInSlot(r.slot).map((w) => ({ id: w.id, label: w.short || w.name, icon: w.icon, title: w.name }));
      r.row.set(items, loadout[r.key]);
      const def = ctx.weapons.get(loadout[r.key]);
      setText(r.current, def ? def.name : loadout[r.key]);
    }
  }

  // ---------- 캐릭터 ----------
  const avArt = avatarArtEl(AVATARS[0], 'sk-av-art--my');
  const avName = h('b', { class: 'sk-my-avname' });
  const avDesc = h('p', { class: 'sk-my-avdesc' });
  const avRow = createChoiceRow({
    label: '캐릭터 고르기', cls: 'sk-my-avchoices',
    onPick: (id) => { const a = account(); if (typeof a.equipAvatar === 'function') a.equipAvatar(id); renderAvatar(); }
  });
  const avShopBtn = btn('캐릭터 상점', () => ctx.emit('mypage:shop', { tab: 'avatar' }), 'sk-btn--sm');

  function renderAvatar() {
    const a = account();
    const now = avatarById(a.loadout && a.loadout.avatar) || avatarById(DEFAULT_AVATAR);
    setText(avName, now.name);
    setText(avDesc, now.desc);
    avArt.paint(ctx.avatarArt, TEAM_IDS[0], now);
    avRow.set(AVATARS.filter((x) => a.isOwned(x.id)).map((x) => ({ id: x.id, label: x.name, icon: x.icon, title: x.name })), now.id);
  }

  // ---------- 비밀 스팟 ----------
  const secretsTitle = h('h2', { class: 'sk-panel-title' });
  const secretsBox = h('div', { class: 'sk-my-secrets' });

  /** 맵 데이터에 적힌 비밀 스팟 수. 모르면 null */
  function secretTotal(mapId) {
    const data = ctx.mapData && ctx.mapData[mapId];
    return data && Array.isArray(data.secrets) ? data.secrets.length : null;
  }

  function secretRow(mapId, found) {
    const map = ctx.maps.get(mapId);
    const names = Object.values(found).map((s) => s.name).filter(Boolean);
    const total = secretTotal(mapId);
    const n = Object.keys(found).length;
    return h('div', { class: 'sk-my-secret' + (n ? ' is-found' : '') },
      h('div', { class: 'sk-my-secrethead' },
        h('b', { text: map ? map.name : mapId }),
        h('span', { class: 'sk-my-secretcount', text: total != null ? `${n} / ${total}` : `${n}곳` })),
      names.length ? h('p', { class: 'sk-my-secretnames', text: names.join(' · ') }) : null);
  }

  function renderSecrets(secrets) {
    const known = [...ctx.maps.keys()].filter((id) => !ctx.maps.get(id).test && (secrets[id] || secretTotal(id)));
    const lost = Object.keys(secrets).filter((id) => !ctx.maps.has(id));
    const ids = [...known, ...lost];
    const found = ids.reduce((sum, id) => sum + Object.keys(secrets[id] || {}).length, 0);
    setText(secretsTitle, `찾은 비밀 스팟 ${found}곳`);
    secretsBox.replaceChildren(...ids.map((id) => secretRow(id, secrets[id] || {})));
    if (!found) {
      secretsBox.prepend(h('p', { class: 'sk-set-hint', text: '맵 곳곳의 높은 곳과 숨은 곳을 찾아보세요. 처음 들어가면 포인트를 받아요.' }));
    }
  }

  // ---------- 초기화 ----------
  const resetText = h('p', { class: 'sk-confirm-text' });
  const resetCancel = btn('취소', () => closeReset(true), 'sk-btn--ghost');
  const resetYes = btn('네, 지워요', () => {
    closeReset(false);
    account().resetLocal();
    back();
  }, 'sk-btn--danger');
  const resetBox = h('div', { class: 'sk-confirm', hidden: true, role: 'alertdialog', 'aria-label': '데이터 초기화 확인' },
    resetText, h('div', { class: 'sk-row' }, resetYes, resetCancel));
  const resetBtn = btn('이 기기의 데이터 초기화', openReset, 'sk-btn--danger sk-my-resetbtn');

  function openReset() {
    setText(resetText, account().remoteEnabled
      ? '이 기기의 닉네임, 포인트, 무기, 전적을 지워요. 서버에 저장된 프로필은 다음 접속 때 돌아올 수 있어요.'
      : '이 기기의 닉네임, 포인트, 무기, 전적을 지워요. 되돌릴 수 없어요.');
    resetBox.hidden = false;
    resetBtn.hidden = true;
    resetCancel.focus({ preventScroll: true });
  }

  function closeReset(refocus) {
    resetBox.hidden = true;
    resetBtn.hidden = false;
    if (refocus) resetBtn.focus({ preventScroll: true });
  }

  // ---------- 화면 ----------
  const backBtn = btn('← 메뉴', back, 'sk-btn--ghost');
  const shopBtn = btn('상점으로', () => ctx.emit('mypage:shop', {}), 'sk-btn--sm');

  const el = h('section', { class: 'sk-screen sk-page sk-mypage', hidden: true, tabindex: '-1', 'aria-label': '마이페이지' },
    h('div', { class: 'sk-page-inner' },
      h('header', { class: 'sk-bar' },
        backBtn,
        h('div', { class: 'sk-bar-title' },
          h('h1', { class: 'sk-h1 sk-stencil', text: '마이페이지' }),
          h('p', { class: 'sk-bar-sub' }, h('span', { text: '지금 닉네임 · ' }), nameNow)),
        points.el),
      h('div', { class: 'sk-hazard sk-hazard--thin', 'aria-hidden': 'true' }),
      h('div', { class: 'sk-my-grid' },
        h('div', { class: 'sk-my-col' },
          h('section', { class: 'sk-panel sk-steel' },
            h('h2', { class: 'sk-panel-title', text: '닉네임 변경' }), nameForm, nameNote),
          h('section', { class: 'sk-panel sk-steel' },
            h('div', { class: 'sk-my-panelhead' },
              h('h2', { class: 'sk-panel-title', text: '장비' }), shopBtn),
            equipRows.map((r) => r.el)),
          h('section', { class: 'sk-panel sk-steel sk-my-avatar' },
            h('div', { class: 'sk-my-panelhead' },
              h('h2', { class: 'sk-panel-title', text: '캐릭터' }), avShopBtn),
            h('div', { class: 'sk-my-avnow' }, avArt.el, h('div', { class: 'sk-my-avtext' }, avName, avDesc)),
            avRow.el)),
        h('div', { class: 'sk-my-col' },
          h('section', { class: 'sk-panel sk-steel' },
            h('h2', { class: 'sk-panel-title', text: '전적' }), statGrid),
          h('section', { class: 'sk-panel sk-steel' }, secretsTitle, secretsBox),
          h('section', { class: 'sk-panel sk-steel' },
            h('h2', { class: 'sk-panel-title', text: '데이터' }), resetBtn, resetBox)))));

  // 입력칸에서 친 키는 index.js가 전파를 막으므로 캡처 단계에서 듣는다. 게이트가 위에 떠 있으면(inert) 무시한다.
  ctx.listen(window, 'keydown', (e) => {
    if (e.key !== 'Escape' || !screen.visible || el.inert) return;
    e.preventDefault();
    if (resetBox.hidden) back();
    else closeReset(true);
  }, true);

  function render(p, { first }) {
    const a = account();
    if (!a) return;
    const { profile } = a;
    renderName();
    points.set(profile.points);
    renderStats(profile.stats);
    renderEquip();
    renderAvatar();
    renderSecrets(profile.secrets);
    // 저장이 끝난 뒤나 입력 중에는 건드리지 않는다. 다른 탭이나 서버가 닉네임을 바꿨을 때만 따라간다.
    if (first || (field.state === 'same' && field.value() !== profile.nickname)) field.reset(profile.nickname);
  }

  const screen = makeScreen(el, {
    render,
    onShow: () => backBtn.focus({ preventScroll: true }),
    onHide: () => { field.stop(); closeReset(false); },
    onDispose: () => field.dispose(),
  });
  return screen;
}
