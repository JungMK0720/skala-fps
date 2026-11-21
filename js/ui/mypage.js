/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 마이페이지 = 요원 기록부(OPERATOR FILE). 닉네임 변경, 포인트, 전적, 장비 3칸, 캐릭터(초상·가진 캐릭터 고르기), 찾은 비밀 스팟, 이 기기의 데이터 초기화(두 번 확인)를 보여 준다.
 *          계정 연결 칸(account.online): 구글·카카오 계정 잇기, 다른 닉네임에 연결된 계정으로 이 기기를 바꿀지 묻기, 이 기기에서 로그아웃(두 번 확인).
 *          이벤트: mypage:back, mypage:shop { tab? }. 계정이 바뀌면 index.js가 다시 그린다.
 */
import { h, btn, setText, fmtPlayTime } from './dom.js';
import { avatarArtEl, createChoiceRow, makeScreen, pointsBadge } from './parts.js';
import { uiIcon, weaponGlyph } from './icons.js';
import { createNicknameField } from './nickname.js';
import { createProviderRow, onlineState, paintNote, providerLabel } from './online.js';
import { TEAM_IDS } from '../core/consts.js';
import { AVATARS, DEFAULT_AVATAR, avatarById } from '../core/avatar-defs.js';
import { t, loc, fmtNum } from '../core/i18n.js';
import { platform } from '../platform/index.js';

const STAT_CELLS = [
  ['kills', t('account.statKills')], ['deaths', t('account.statDeaths')], ['kd', 'K/D'],
  ['headshots', t('account.statHeadshots')], ['halfShots', t('account.statHalfShots')], ['knifeKills', t('account.statKnifeKills')],
  ['matches', t('account.statMatches')], ['wins', t('account.statWins')], ['time', t('account.statTime')],
];
const EQUIP_SLOTS = [['primary', 1, t('account.slotPrimary')], ['secondary', 2, t('account.slotSecondary')], ['melee', 3, t('account.slotMelee')]];

const count = (n) => fmtNum(Number(n || 0));

export function createMyPage(ctx) {
  const account = () => ctx.account;
  const back = () => ctx.emit('mypage:back', {});

  // ---------- 닉네임 ----------
  const nameNow = h('strong', { class: 'sk-my-name' });
  const saveBtn = h('button', { type: 'submit', class: 'sk-btn sk-btn--primary sk-my-save', disabled: true, text: t('account.save') });
  const nameNote = h('p', { class: 'sk-note' });
  const field = createNicknameField(ctx, {
    id: 'sk-my-nick',
    label: t('account.newNickname'),
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
    setText(nameNow, a.profile.nickname || t('account.noNickname'));
    let note = '';
    if (!a.remoteEnabled) note = t('account.offlineMode');
    else if (a.nicknamePending) note = t('account.namePending');
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
    const row = createChoiceRow({ label: t('account.pickSlot', { label }), onPick: (id) => { account().equip(key, id); renderEquip(); } });
    const el = h('div', { class: 'sk-my-equiprow' },
      h('div', { class: 'sk-my-equiphead' }, h('span', { class: 'sk-field-label', text: label }), current),
      row.el);
    return { key, slot, current, row, el };
  });

  function ownedInSlot(slot) {
    const a = account();
    const list = [];
    for (const w of ctx.weapons.values()) if (w.slot === slot && (!w.zombieOnly || w.shop) && a.isOwned(w.id)) list.push(w);
    return list;
  }

  function renderEquip() {
    const loadout = account().loadout;
    for (const r of equipRows) {
      const items = ownedInSlot(r.slot).map((w) => ({ id: w.id, label: loc(w, 'short') || loc(w, 'name'), glyph: weaponGlyph(w.id, w.slot), title: loc(w, 'name') }));
      r.row.set(items, loadout[r.key]);
      const def = ctx.weapons.get(loadout[r.key]);
      setText(r.current, def ? loc(def, 'name') : loadout[r.key]);
    }
  }

  // ---------- 캐릭터 ----------
  const avArt = avatarArtEl(AVATARS[0], 'sk-av-art--my');
  const avName = h('b', { class: 'sk-my-avname' });
  const avDesc = h('p', { class: 'sk-my-avdesc' });
  const avRow = createChoiceRow({
    label: t('account.pickAvatar'), cls: 'sk-my-avchoices',
    onPick: (id) => { const a = account(); if (typeof a.equipAvatar === 'function') a.equipAvatar(id); renderAvatar(); }
  });
  const avShopBtn = btn(t('account.avatarShop'), () => ctx.emit('mypage:shop', { tab: 'avatar' }), 'sk-btn--sm');

  function renderAvatar() {
    const a = account();
    const now = avatarById(a.loadout && a.loadout.avatar) || avatarById(DEFAULT_AVATAR);
    setText(avName, loc(now, 'name'));
    setText(avDesc, loc(now, 'desc'));
    avArt.paint(ctx.avatarArt, TEAM_IDS[0], now);
    avRow.set(AVATARS.filter((x) => a.isOwned(x.id)).map((x) => ({ id: x.id, label: loc(x, 'name'), title: loc(x, 'name') })), now.id);
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
        h('b', { text: map ? loc(map, 'name') : mapId }),
        h('span', { class: 'sk-my-secretcount', text: total != null ? `${n} / ${total}` : t('account.secretCount', { n }) })),
      names.length ? h('p', { class: 'sk-my-secretnames', text: names.join(' · ') }) : null);
  }

  function renderSecrets(secrets) {
    const known = [...ctx.maps.keys()].filter((id) => !ctx.maps.get(id).test && (secrets[id] || secretTotal(id)));
    const lost = Object.keys(secrets).filter((id) => !ctx.maps.has(id));
    const ids = [...known, ...lost];
    const found = ids.reduce((sum, id) => sum + Object.keys(secrets[id] || {}).length, 0);
    setText(secretsTitle, t('account.secretsFound', { n: found }));
    secretsBox.replaceChildren(...ids.map((id) => secretRow(id, secrets[id] || {})));
    if (!found) {
      secretsBox.prepend(h('p', { class: 'sk-set-hint', text: t('account.secretsHint') }));
    }
  }

  // ---------- 초기화 ----------
  const resetText = h('p', { class: 'sk-confirm-text' });
  const resetCancel = btn(t('account.cancel'), () => closeReset(true), 'sk-btn--ghost');
  const resetYes = btn(t('account.resetYes'), () => {
    closeReset(false);
    account().resetLocal();
    back();
  }, 'sk-btn--danger');
  const resetBox = h('div', { class: 'sk-confirm sk-my-resetbox', hidden: true, role: 'alertdialog', 'aria-label': t('account.resetConfirm') },
    resetText, h('div', { class: 'sk-row' }, resetYes, resetCancel));
  const resetBtn = btn(t('account.resetBtn'), openReset, 'sk-btn--danger sk-my-resetbtn');

  function openReset() {
    setText(resetText, account().remoteEnabled
      ? t('account.resetTextRemote')
      : t('account.resetTextLocal'));
    resetBox.hidden = false;
    resetBtn.hidden = true;
    resetCancel.focus({ preventScroll: true });
  }

  function closeReset(refocus) {
    resetBox.hidden = true;
    resetBtn.hidden = false;
    if (refocus) resetBtn.focus({ preventScroll: true });
  }

  // ---------- 계정 연결 (account.online) ----------
  const online = () => account().online;
  const linkState = h('p', { class: 'sk-my-linkstate' });
  // 포털(CrazyGames) 안에서는 바깥 로그인(구글·카카오)을 쓰지 않는다: 연결 줄을 만들지 않고 칸을 숨긴다. 기기 토큰 계정은 그대로 쓴다
  const linkRow = platform.isPortal ? null : createProviderRow('sk-row sk-my-linkrow', (id) => online().startLogin(id));
  const linkNote = h('p', { class: 'sk-nick-status sk-my-linknote', role: 'status', hidden: true });
  const switchText = h('p', { class: 'sk-confirm-text' });
  const switchYes = btn(t('account.switch'), () => online().confirmSwitch(), 'sk-btn--primary');
  const switchNo = btn(t('account.keep'), () => online().cancelSwitch(), 'sk-btn--ghost');
  const switchBox = h('div', { class: 'sk-confirm sk-my-switch', hidden: true, role: 'alertdialog', 'aria-label': t('account.switchLabel') },
    switchText, h('div', { class: 'sk-row' }, switchYes, switchNo));
  const logoutText = h('p', { class: 'sk-confirm-text', text: t('account.logoutText') });
  const logoutNo = btn(t('account.cancel'), () => closeLogout(true), 'sk-btn--ghost');
  const logoutYes = btn(t('account.logoutYes'), () => { closeLogout(false); online().logout(); }, 'sk-btn--danger');
  const logoutBox = h('div', { class: 'sk-confirm', hidden: true, role: 'alertdialog', 'aria-label': t('account.logoutConfirm') },
    logoutText, h('div', { class: 'sk-row' }, logoutYes, logoutNo));
  const logoutBtn = btn(t('account.logoutBtn'), openLogout, 'sk-btn--danger sk-btn--sm sk-my-logout');
  const linkPanel = h('section', { class: 'sk-panel sk-steel sk-my-link', hidden: true },
    h('h2', { class: 'sk-panel-title' }, uiIcon('lock'), t('account.linkTitle')), linkState, linkRow && linkRow.el, switchBox, logoutBtn, logoutBox, linkNote);

  function openLogout() {
    logoutBox.hidden = false;
    logoutBtn.hidden = true;
    logoutNo.focus({ preventScroll: true });
  }

  function closeLogout(refocus) {
    logoutBox.hidden = true;
    renderLink();
    if (refocus && !logoutBtn.hidden) logoutBtn.focus({ preventScroll: true });
  }

  function renderLink() {
    const a = account();
    const s = onlineState(ctx);
    if (!s || s.status === 'off' || !linkRow) { linkPanel.hidden = true; return; }
    linkPanel.hidden = false;
    const registered = a.hasNickname() && !a.nicknamePending && a.remoteEnabled;
    const names = s.linked.map((id) => providerLabel(s, id)).join(', ');
    let text;
    if (s.status === 'checking') text = t('account.linkChecking');
    else if (s.status === 'error') text = t('account.linkError');
    else if (!registered) text = t('account.linkNeedName');
    else if (s.linked.length) text = t('account.linkedWith', { names });
    else text = t('account.linkNone');
    setText(linkState, text);
    const ready = s.status === 'ready' && registered;
    linkRow.paint(ready ? s.providers.filter((p) => !s.linked.includes(p.id)).map((p) => ({ id: p.id, label: t('account.linkProvider', { name: p.name }) })) : [], { disabled: !!s.busy });
    // 다른 닉네임에 연결된 계정으로 로그인했다: 이 기기를 바꿀지 묻는다
    const sw = s.pending && s.pending.kind === 'switch' ? s.pending : null;
    switchBox.hidden = !sw;
    if (sw) {
      const keep = s.linked.length ? t('account.switchKeepLinked') : t('account.switchKeepLost');
      setText(switchText, t('account.switchText', { provider: sw.providerName, name: sw.name, current: a.profile.nickname, keep }));
      setText(switchYes, t('account.switchTo', { name: sw.name }));
      switchYes.disabled = switchNo.disabled = !!s.busy;
    }
    logoutBtn.hidden = !ready || !s.linked.length || !logoutBox.hidden;
    logoutBtn.disabled = !!s.busy;
    if (!ready || !s.linked.length) logoutBox.hidden = true;
    paintNote(linkNote, s, { kinds: ['login', 'logout'] });
  }

  // ---------- 화면 ----------
  const backBtn = btn([uiIcon('back'), h('span', { text: t('account.menu') })], back, 'sk-btn--ghost', { 'aria-label': t('account.toMenu') });
  const shopBtn = btn(t('account.toShop'), () => ctx.emit('mypage:shop', {}), 'sk-btn--sm');

  const el = h('section', { class: 'sk-screen sk-page sk-mypage', hidden: true, tabindex: '-1', 'aria-label': t('account.title') },
    h('div', { class: 'sk-page-inner' },
      h('header', { class: 'sk-bar' },
        backBtn,
        h('div', { class: 'sk-bar-title' },
          h('p', { class: 'sk-kicker', text: 'OPERATOR FILE', 'aria-hidden': 'true' }),
          h('h1', { class: 'sk-h1 sk-stencil', text: t('account.title') }),
          h('p', { class: 'sk-bar-sub' }, h('span', { text: t('account.currentName') }), nameNow)),
        points.el),
      h('div', { class: 'sk-my-grid' },
        h('div', { class: 'sk-my-col' },
          h('section', { class: 'sk-panel sk-steel' },
            h('h2', { class: 'sk-panel-title' }, uiIcon('user'), t('account.panelName')), nameForm, nameNote),
          h('section', { class: 'sk-panel sk-steel' },
            h('div', { class: 'sk-my-panelhead' },
              h('h2', { class: 'sk-panel-title' }, uiIcon('armory'), t('account.panelGear')), shopBtn),
            equipRows.map((r) => r.el)),
          h('section', { class: 'sk-panel sk-steel sk-my-avatar' },
            h('div', { class: 'sk-my-panelhead' },
              h('h2', { class: 'sk-panel-title' }, uiIcon('helmet'), t('account.panelAvatar')), avShopBtn),
            h('div', { class: 'sk-my-avnow' }, avArt.el, h('div', { class: 'sk-my-avtext' }, avName, avDesc)),
            avRow.el)),
        h('div', { class: 'sk-my-col' },
          linkPanel,
          h('section', { class: 'sk-panel sk-steel' },
            h('h2', { class: 'sk-panel-title' }, uiIcon('target'), t('account.panelStats')), statGrid),
          h('section', { class: 'sk-panel sk-steel' }, secretsTitle, secretsBox),
          h('section', { class: 'sk-panel sk-steel' },
            h('h2', { class: 'sk-panel-title' }, uiIcon('alert'), t('account.panelData')), resetBtn, resetBox)))));

  // 입력칸에서 친 키는 index.js가 전파를 막으므로 캡처 단계에서 듣는다. 게이트가 위에 떠 있으면(inert) 무시한다.
  ctx.listen(window, 'keydown', (e) => {
    if (e.key !== 'Escape' || !screen.visible || el.inert) return;
    e.preventDefault();
    if (!logoutBox.hidden) closeLogout(true);
    else if (resetBox.hidden) back();
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
    renderLink();
    // 저장이 끝난 뒤나 입력 중에는 건드리지 않는다. 다른 탭이나 서버가 닉네임을 바꿨을 때만 따라간다.
    if (first || (field.state === 'same' && field.value() !== profile.nickname)) field.reset(profile.nickname);
  }

  const screen = makeScreen(el, {
    render,
    onShow: () => backBtn.focus({ preventScroll: true }),
    onHide: () => { field.stop(); closeReset(false); logoutBox.hidden = true; },
    onDispose: () => field.dispose(),
  });
  return screen;
}
