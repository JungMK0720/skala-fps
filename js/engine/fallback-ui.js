/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: UI 플러그인이 없을 때만 쓰는 core 기본 화면. 메뉴·로딩·일시정지 오버레이와 조준선·체력·킬피드 HUD를 그린다.
 */
/**
 * SKALA 작전 — core 기본 UI (UI 플러그인이 없을 때만 쓰는 최소 화면)
 *   createFallbackMenu(ctx)  : 메인 메뉴(닉네임·맵 선택·설정) + 로딩 + 일시정지/클릭해서 시작 오버레이
 *   createFallbackHud(ctx)   : 조준선 · 히트마커 · 체력 · 탄약 · 연습장 기록 · 킬피드 · 점수판(Tab) · FPS
 * 모든 사용자 문자열은 textContent로만 넣는다. 클래스는 'core-' 접두사(index.html <style>).
 */

import { DEFAULT_EMOTE_WHEEL, EMOTES, EMOTE_WHEEL } from '../core/consts.js';
import { BRAND } from '../core/brand.js';
import { t as tr, loc } from '../core/i18n.js';

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

const LAST_MAP_KEY = 'skalafps.lastMap';
const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } };

/* ============================================================ 메뉴 + 오버레이 */

export function createFallbackMenu(ctx) {
  const { bus, settings } = ctx;
  const root = ctx.ui.root;
  const offs = [];

  // ---- 메인 메뉴
  const menu = el('section', 'core-menu');
  menu.hidden = true;
  const card = el('div', 'core-card');
  const title = el('h1', 'core-title', BRAND.name);
  card.append(title, el('p', 'core-sub', tr('engine.fb.tagline')));

  const nameRow = el('label', 'core-row');
  nameRow.append(el('span', 'core-label', tr('engine.fb.nickname')));
  const nameInput = el('input', 'core-input');
  nameInput.maxLength = 12;
  nameInput.value = ctx.session.name;
  nameInput.addEventListener('change', () => {
    const v = nameInput.value.trim().slice(0, 12);
    if (v) ctx.setPlayerName(v); else nameInput.value = ctx.session.name;
  });
  nameRow.append(nameInput);
  card.append(nameRow);

  card.append(el('h2', 'core-h2', tr('engine.fb.mapSelect')));
  const mapsBox = el('div', 'core-maps');
  let selected = lsGet(LAST_MAP_KEY);
  const list = ctx.maps.MAP_LIST;
  if (!list.some((m) => m.id === selected)) selected = (list.find((m) => m.ok && !m.test) || list[list.length - 1]).id;
  const cards = [];
  for (const m of list) {
    const b = el('button', 'core-map');
    b.type = 'button';
    b.append(el('b', null, loc(m, 'name')), el('span', 'core-map-en', m.nameEn || m.id), el('span', 'core-map-desc', loc(m, 'desc') || ''));
    if (m.fallback) b.append(el('em', 'core-badge', tr('engine.fb.badgeFallback')));
    if (m.test) b.append(el('em', 'core-badge test', tr('engine.fb.badgeTest')));
    b.addEventListener('click', () => { selected = m.id; lsSet(LAST_MAP_KEY, m.id); sync(); });
    b.addEventListener('dblclick', () => start());
    cards.push([m.id, b]);
    mapsBox.append(b);
  }
  const sync = () => cards.forEach(([id, b]) => b.classList.toggle('on', id === selected));
  sync();
  card.append(mapsBox);

  const actions = el('div', 'core-actions');
  const startBtn = el('button', 'core-btn primary', tr('engine.fb.startPractice'));
  startBtn.type = 'button';
  const multiBtn = el('button', 'core-btn', tr('engine.fb.multiplayer'));
  multiBtn.type = 'button';
  multiBtn.addEventListener('click', () => ctx.setScreen('lobby'));
  actions.append(startBtn, multiBtn);
  card.append(actions);
  const note = el('p', 'core-note', '');
  card.append(note);

  // 설정
  const set = el('details', 'core-settings');
  set.append(el('summary', null, tr('engine.fb.settings')));
  const grid = el('div', 'core-set-grid');
  const sensVal = el('output', 'core-out', settings.get('sensitivity').toFixed(2));
  const sens = el('input');
  Object.assign(sens, { type: 'range', min: '0.2', max: '3', step: '0.05', value: String(settings.get('sensitivity')) });
  sens.addEventListener('input', () => { settings.set('sensitivity', +sens.value); sensVal.textContent = (+sens.value).toFixed(2); });
  const zoom = el('select');
  [['hold', tr('engine.fb.zoomHold')], ['toggle', tr('engine.fb.zoomToggle')]].forEach(([v, t]) => { const o = el('option', null, t); o.value = v; zoom.append(o); });
  zoom.value = settings.get('zoomMode');
  zoom.addEventListener('change', () => settings.set('zoomMode', zoom.value));
  const qual = el('select');
  [['auto', tr('engine.fb.qAuto')], ['high', tr('engine.fb.qHigh')], ['low', tr('engine.fb.qLow')]].forEach(([v, t]) => { const o = el('option', null, t); o.value = v; qual.append(o); });
  qual.value = settings.get('quality');
  qual.addEventListener('change', () => settings.set('quality', qual.value));
  const fps = el('input'); fps.type = 'checkbox'; fps.checked = !!settings.get('showFps');
  fps.addEventListener('change', () => settings.set('showFps', fps.checked));
  const inv = el('input'); inv.type = 'checkbox'; inv.checked = !!settings.get('invertY');
  inv.addEventListener('change', () => settings.set('invertY', inv.checked));
  const row = (label, ...kids) => { const r = el('label', 'core-set'); r.append(el('span', null, label), ...kids); grid.append(r); };
  row(tr('engine.fb.sens'), sens, sensVal);
  row(tr('engine.fb.zoom'), zoom);
  row(tr('engine.fb.graphics'), qual);
  row(tr('engine.fb.showFps'), fps);
  row(tr('engine.fb.invertY'), inv);
  set.append(grid);
  card.append(set);

  const help = el('p', 'core-help');
  help.textContent = tr('engine.fb.help');
  card.append(help);
  menu.append(card);
  root.append(menu);

  function start() {
    if (startBtn.disabled) return;
    startBtn.disabled = true;
    lsSet(LAST_MAP_KEY, selected);
    ctx.input.requestLock(); // 클릭 제스처 안에서 미리 잠금 요청
    ctx.setScreen('sandbox', { mapId: selected }).finally(() => { startBtn.disabled = false; });
  }
  startBtn.addEventListener('click', start);

  // ---- 로딩
  const loading = el('div', 'core-loading');
  loading.hidden = true;
  const loadingText = el('p', null, tr('engine.fb.loading'));
  loading.append(el('div', 'core-spinner'), loadingText);
  root.append(loading);

  // ---- 클릭해서 시작 / 일시정지
  const overlay = el('div', 'core-overlay');
  overlay.hidden = true;
  const ovCard = el('div', 'core-card small');
  const ovTitle = el('h2', null, tr('engine.fb.clickToStart'));
  const ovText = el('p', 'core-sub', tr('engine.fb.clickHint'));
  const resume = el('button', 'core-btn primary', tr('engine.fb.resume'));
  resume.type = 'button';
  const toMenu = el('button', 'core-btn', tr('engine.fb.toMenu'));
  toMenu.type = 'button';
  const ovActions = el('div', 'core-actions');
  ovActions.append(resume, toMenu);
  ovCard.append(ovTitle, ovText, ovActions, el('p', 'core-help', help.textContent));
  overlay.append(ovCard);
  root.append(overlay);
  const lockNow = (e) => { if (e) e.stopPropagation(); ctx.input.requestLock(); };
  overlay.addEventListener('click', (e) => { if (e.target === overlay) lockNow(e); });
  resume.addEventListener('click', lockNow);
  toMenu.addEventListener('click', (e) => { e.stopPropagation(); ctx.setScreen('menu'); });

  let toast = null;
  function showError(msg) {
    if (!toast) { toast = el('div', 'core-error'); root.append(toast); }
    toast.textContent = msg;
    toast.hidden = false;
    clearTimeout(showError.t);
    showError.t = setTimeout(() => { toast.hidden = true; }, 6000);
  }

  const inGame = () => ctx.screen === 'sandbox' || ctx.screen === 'match';
  function refreshOverlay(first) {
    const show = inGame() && !ctx.input.locked && !ctx.loading && !ctx.flags.autoplay;
    overlay.hidden = !show;
    if (show) {
      ovTitle.textContent = first ? tr('engine.fb.clickToStart') : tr('engine.fb.paused');
      resume.textContent = first ? tr('engine.fb.start') : tr('engine.fb.resume');
    }
  }
  let started = false;
  offs.push(bus.on('screen:change', (e) => {
    menu.hidden = e.to !== 'menu';
    if (e.to === 'menu') { nameInput.value = ctx.session.name; started = false; }
    refreshOverlay(true);
  }));
  offs.push(bus.on('map:loading', (e) => {
    const m = list.find((x) => x.id === e.id);
    loadingText.textContent = tr('engine.fb.loadingMap', { name: m ? loc(m, 'name') : e.id });
    loading.hidden = false;
    overlay.hidden = true;
  }));
  offs.push(bus.on('map:loaded', () => { loading.hidden = true; refreshOverlay(!started); }));
  offs.push(bus.on('map:error', (e) => { loading.hidden = true; showError(tr('engine.fb.mapError', { msg: e.message || e.id })); }));
  offs.push(bus.on('input:lock', (e) => { if (e.locked) started = true; refreshOverlay(!started); }));
  offs.push(bus.on('input:lock-error', () => { if (inGame()) ovText.textContent = tr('engine.fb.lockError'); }));
  offs.push(bus.on('screen:unavailable', (e) => {
    note.textContent = e.name === 'lobby' ? tr('engine.fb.lobbySoon') : tr('engine.fb.screenSoon', { name: e.name });
  }));
  offs.push(bus.on('app:error', (e) => showError(e.message || String(e))));

  return {
    root: menu,
    dispose() {
      offs.forEach((o) => o()); offs.length = 0;
      [menu, loading, overlay, toast].forEach((n) => n && n.remove());
    }
  };
}

/* ============================================================ HUD */

const PART_KO = { head: tr('engine.fb.part.head'), body: tr('engine.fb.part.body'), legs: tr('engine.fb.part.legs'), hand: tr('engine.fb.part.hand'), foot: tr('engine.fb.part.foot') };
const EMOTE_DENY = { moving: tr('engine.fb.deny.moving'), air: tr('engine.fb.deny.air'), crouch: tr('engine.fb.deny.crouch'), dead: tr('engine.fb.deny.dead'), unknown: tr('engine.fb.deny.unknown') };

export function createFallbackHud(ctx) {
  const { bus, settings } = ctx;
  const root = ctx.ui.root;
  const offs = [];
  const hud = el('div', 'core-hud');
  hud.hidden = true;

  const cross = el('div', 'core-crosshair');
  for (let i = 0; i < 4; i++) cross.append(el('i'));
  cross.append(el('b'));
  const hit = el('div', 'core-hitmarker');
  for (let i = 0; i < 4; i++) hit.append(el('i'));
  const toast = el('div', 'core-toast');
  const feed = el('div', 'core-feed');
  const statsBox = el('div', 'core-stats');
  const statsTitle = el('b', null, tr('engine.fb.practice'));
  const statsText = el('span', null, '');
  statsBox.append(statsTitle, statsText);
  const mapName = el('div', 'core-mapname', '');
  const perf = el('div', 'core-perf', '');
  const bottom = el('div', 'core-bottom');
  const hp = el('div', 'core-hp');
  const hpNum = el('b', null, '100');
  const hpBar = el('span', 'core-bar');
  const hpFill = el('i');
  hpBar.append(hpFill);
  hp.append(el('small', null, 'HP'), hpNum, hpBar);
  const ammo = el('div', 'core-ammo');
  const ammoNum = el('b', null, '30');
  const ammoRes = el('small', null, '/ ∞');
  const wName = el('span', 'core-wname', tr('engine.fb.tempGun'));
  ammo.append(wName, ammoNum, ammoRes);
  bottom.append(hp, ammo);
  // 이모트 휠(최소 버전: 8칸 원형 + 가상 커서). UI 플러그인이 있으면 그쪽 휠을 쓴다
  const wheel = el('div', 'core-emote-wheel');
  wheel.hidden = true;
  const wheelDot = el('i', 'core-emote-dot');
  const wheelHub = el('b', 'core-emote-hub', 'B');
  const slots = Array.from({ length: EMOTE_WHEEL.SLOTS }, (_, i) => {
    const a = (i / EMOTE_WHEEL.SLOTS) * Math.PI * 2;
    const it = el('div', 'core-emote-slot');
    it.style.left = `calc(50% + ${Math.sin(a) * 118}px)`;
    it.style.top = `calc(50% - ${Math.cos(a) * 118}px)`;
    it.append(el('span', 'core-emote-ico', ''), el('small', null, ''));
    return it;
  });
  /** 휠을 열 때 칸 이름을 지금 장착한 이모트(input.emoteWheelIds)로 맞춘다 */
  function fillSlots() {
    const ids = (ctx.input && ctx.input.emoteWheelIds) || DEFAULT_EMOTE_WHEEL;
    slots.forEach((it, i) => {
      const e = EMOTES.find((x) => x.id === ids[i]);
      it.hidden = !e;
      it.firstChild.textContent = e ? e.icon : '';
      it.lastChild.textContent = e ? loc(e, 'name') : '';
    });
  }
  fillSlots();
  wheel.append(...slots, wheelHub, wheelDot);
  const emoteTag = el('div', 'core-emote-tag');
  emoteTag.hidden = true;
  hud.append(cross, hit, toast, feed, statsBox, mapName, perf, bottom, wheel, emoteTag);
  root.append(hud);

  // 점수판(Tab)
  const board = el('div', 'core-board');
  board.hidden = true;
  const boardTitle = el('h3', null, tr('engine.fb.boardTitle'));
  const boardBody = el('div', 'core-board-body');
  board.append(boardTitle, boardBody);
  root.append(board);

  let toastT = 0, hitT = 0;
  function flashHit(kind) {
    hit.className = 'core-hitmarker show ' + kind;
    clearTimeout(hitT);
    hitT = setTimeout(() => { hit.className = 'core-hitmarker'; }, kind === 'kill' ? 260 : 140);
  }
  function showToast(text, cls = '') {
    toast.textContent = text;
    toast.className = 'core-toast show ' + cls;
    clearTimeout(toastT);
    toastT = setTimeout(() => { toast.className = 'core-toast'; }, 900);
  }
  function addFeed(text) {
    const row = el('div', 'core-feed-row', text);
    feed.prepend(row);
    while (feed.children.length > 5) feed.lastChild.remove();
    setTimeout(() => row.classList.add('fade'), 4000);
    setTimeout(() => row.remove(), 5000);
  }
  function setHp(v) {
    hpNum.textContent = String(Math.max(0, Math.round(v)));
    hpFill.style.width = Math.max(0, Math.min(100, v)) + '%';
    hp.classList.toggle('low', v <= 30);
  }

  offs.push(bus.on('screen:change', (e) => {
    const show = e.to === 'sandbox' || e.to === 'match';
    hud.hidden = !show;
    statsBox.hidden = e.to !== 'sandbox';
    if (!show) board.hidden = true;
  }));
  offs.push(bus.on('map:loaded', (e) => { mapName.textContent = (e.data.fallback ? tr('engine.fb.mapFallback', { name: loc(e.data, 'name') || e.id }) : (loc(e.data, 'name') || e.id)); }));
  offs.push(bus.on('hit:player', (e) => {
    if (!e || e.shooterId !== ctx.player.state.id) return;
    flashHit(e.part === 'head' ? 'head' : 'body');
  }));
  offs.push(bus.on('sandbox:target-hit', (e) => {
    if (e.killed) flashHit('kill');
    showToast(tr(e.killed ? 'engine.fb.hitToastKill' : 'engine.fb.hitToast', { part: PART_KO[e.part] || e.part, dmg: e.damage, dist: Math.round(e.dist) }), e.part === 'head' ? 'head' : '');
  }));
  offs.push(bus.on('sandbox:target-down', (e) => addFeed(`🎯 ${e.name} — ${e.part === 'head' ? tr('engine.fb.headshot') : PART_KO[e.part] || e.part} (${Math.round(e.dist)} m)`)));
  offs.push(bus.on('sandbox:stats', (s) => {
    statsText.textContent = tr(s.longest ? 'engine.fb.statsLongest' : 'engine.fb.stats', { shots: s.shots, hits: s.hits, acc: s.accuracy, head: s.head, kills: s.kills, longest: s.longest });
  }));
  offs.push(bus.on('sandbox:targets', (e) => {
    boardBody.textContent = '';
    for (const t of e.list) {
      const r = el('div', 'core-board-row' + (t.alive ? '' : ' down'));
      r.append(el('span', null, t.name), el('span', null, t.mode === 'strafe' ? tr('engine.fb.modeStrafe') : t.mode === 'bob' ? tr('engine.fb.modeBob') : tr('engine.fb.modeStand')), el('b', null, t.alive ? `HP ${t.hp}` : tr('engine.fb.down')));
      boardBody.append(r);
    }
  }));
  offs.push(bus.on('input:scoreboard', (e) => { if (!hud.hidden) board.hidden = !e.open; }));
  offs.push(bus.on('weapon:ammo', (e) => {
    ammoNum.textContent = e.reloading ? '…' : String(e.ammo);
    ammoRes.textContent = '/ ' + (Number.isFinite(e.reserve) ? e.reserve : '∞');
    ammo.classList.toggle('low', !e.reloading && e.ammo <= Math.ceil((e.mag || 30) * 0.2));
  }));
  offs.push(bus.on('weapon:reload', () => showToast(tr('engine.fb.reloading'))));
  offs.push(bus.on('weapon:zoom', (e) => cross.classList.toggle('aim', !!e.active)));
  // 이모트: 휠 · 진행 표시 · 3인칭이면 조준선 숨김 · 거절 사유
  offs.push(bus.on('input:emoteWheel', (e) => {
    if (e.open && wheel.hidden) fillSlots();
    wheel.hidden = !e.open || hud.hidden;
    slots.forEach((it, i) => it.classList.toggle('on', e.selected === i));
    wheelDot.style.transform = `translate(${e.cursor ? e.cursor.x : 0}px, ${e.cursor ? e.cursor.y : 0}px)`;
    cross.style.visibility = e.open || ctx.player.thirdPerson > 0 ? 'hidden' : '';
  }));
  offs.push(bus.on('player:emote', (e) => {
    const def = EMOTES.find((x) => x.code === e.code);
    emoteTag.hidden = !e.active;
    if (e.active && def) emoteTag.textContent = tr('engine.fb.emoteTag', { icon: def.icon, name: loc(def, 'name') });
  }));
  offs.push(bus.on('player:view', (e) => { cross.style.visibility = e.mode === 'third' ? 'hidden' : ''; }));
  offs.push(bus.on('player:emote-denied', (e) => showToast(EMOTE_DENY[e.reason] || tr('engine.fb.cantNow'))));
  offs.push(bus.on('input:slot', (e) => { if (ctx.flags.devgun) showToast(tr('engine.fb.slotLater', { slot: e.slot })); }));
  offs.push(bus.on('player:spawn', (e) => setHp(e.state.hp)));
  offs.push(bus.on('player:damage', (e) => setHp(e.hp)));

  const perfTimer = setInterval(() => {
    const show = !!settings.get('showFps') || ctx.flags.debug;
    perf.hidden = !show || hud.hidden;
    if (perf.hidden) return;
    const info = ctx.renderer.info();
    const p = ctx.player.state.pos;
    perf.textContent = `${Math.round(ctx.loop.fps)} fps · draw ${info.render.calls} · tri ${(info.render.triangles / 1000).toFixed(1)}k · ${ctx.renderer.quality}` +
      (ctx.flags.debug ? ` · (${p[0].toFixed(1)}, ${p[1].toFixed(2)}, ${p[2].toFixed(1)})` : '');
  }, 500);

  return {
    root: hud,
    dispose() {
      clearInterval(perfTimer);
      offs.forEach((o) => o()); offs.length = 0;
      hud.remove(); board.remove();
    }
  };
}
