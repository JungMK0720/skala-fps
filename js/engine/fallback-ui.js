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

import { EMOTES, EMOTE_WHEEL } from '../core/consts.js';

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
  const title = el('h1', 'core-title', 'SKALA 작전');
  card.append(title, el('p', 'core-sub', '빠르게 달리고, 정확하게 쏘는 브라우저 FPS — 블루 팀 vs 오렌지 팀'));

  const nameRow = el('label', 'core-row');
  nameRow.append(el('span', 'core-label', '닉네임'));
  const nameInput = el('input', 'core-input');
  nameInput.maxLength = 12;
  nameInput.value = ctx.session.name;
  nameInput.addEventListener('change', () => {
    const v = nameInput.value.trim().slice(0, 12);
    if (v) ctx.setPlayerName(v); else nameInput.value = ctx.session.name;
  });
  nameRow.append(nameInput);
  card.append(nameRow);

  card.append(el('h2', 'core-h2', '맵 선택'));
  const mapsBox = el('div', 'core-maps');
  let selected = lsGet(LAST_MAP_KEY);
  const list = ctx.maps.MAP_LIST;
  if (!list.some((m) => m.id === selected)) selected = (list.find((m) => m.ok && !m.test) || list[list.length - 1]).id;
  const cards = [];
  for (const m of list) {
    const b = el('button', 'core-map');
    b.type = 'button';
    b.append(el('b', null, m.name), el('span', 'core-map-en', m.nameEn || m.id), el('span', 'core-map-desc', m.desc || ''));
    if (m.fallback) b.append(el('em', 'core-badge', '준비 중 · 연습 맵으로 대체'));
    if (m.test) b.append(el('em', 'core-badge test', '코어 테스트 맵'));
    b.addEventListener('click', () => { selected = m.id; lsSet(LAST_MAP_KEY, m.id); sync(); });
    b.addEventListener('dblclick', () => start());
    cards.push([m.id, b]);
    mapsBox.append(b);
  }
  const sync = () => cards.forEach(([id, b]) => b.classList.toggle('on', id === selected));
  sync();
  card.append(mapsBox);

  const actions = el('div', 'core-actions');
  const startBtn = el('button', 'core-btn primary', '🎯 연습장 시작');
  startBtn.type = 'button';
  const multiBtn = el('button', 'core-btn', '👥 멀티플레이');
  multiBtn.type = 'button';
  multiBtn.addEventListener('click', () => ctx.setScreen('lobby'));
  actions.append(startBtn, multiBtn);
  card.append(actions);
  const note = el('p', 'core-note', '');
  card.append(note);

  // 설정
  const set = el('details', 'core-settings');
  set.append(el('summary', null, '⚙️ 설정'));
  const grid = el('div', 'core-set-grid');
  const sensVal = el('output', 'core-out', settings.get('sensitivity').toFixed(2));
  const sens = el('input');
  Object.assign(sens, { type: 'range', min: '0.2', max: '3', step: '0.05', value: String(settings.get('sensitivity')) });
  sens.addEventListener('input', () => { settings.set('sensitivity', +sens.value); sensVal.textContent = (+sens.value).toFixed(2); });
  const zoom = el('select');
  [['hold', '누르고 있는 동안'], ['toggle', '클릭으로 켜고 끄기']].forEach(([v, t]) => { const o = el('option', null, t); o.value = v; zoom.append(o); });
  zoom.value = settings.get('zoomMode');
  zoom.addEventListener('change', () => settings.set('zoomMode', zoom.value));
  const qual = el('select');
  [['auto', '자동'], ['high', '높음'], ['low', '낮음 (그림자 끔)']].forEach(([v, t]) => { const o = el('option', null, t); o.value = v; qual.append(o); });
  qual.value = settings.get('quality');
  qual.addEventListener('change', () => settings.set('quality', qual.value));
  const fps = el('input'); fps.type = 'checkbox'; fps.checked = !!settings.get('showFps');
  fps.addEventListener('change', () => settings.set('showFps', fps.checked));
  const inv = el('input'); inv.type = 'checkbox'; inv.checked = !!settings.get('invertY');
  inv.addEventListener('change', () => settings.set('invertY', inv.checked));
  const row = (label, ...kids) => { const r = el('label', 'core-set'); r.append(el('span', null, label), ...kids); grid.append(r); };
  row('마우스 감도', sens, sensVal);
  row('줌(우클릭)', zoom);
  row('그래픽', qual);
  row('FPS 표시', fps);
  row('마우스 상하 반전', inv);
  set.append(grid);
  card.append(set);

  const help = el('p', 'core-help');
  help.textContent = 'WASD 이동 · 마우스 시점 · 좌클릭 사격 · 우클릭 줌 · Space 점프 · Shift 천천히 걷기 · Ctrl 또는 C 앉기(누르고 있는 동안) · B 누르고 있기 이모트 휠(마우스로 고르고 떼기, 움직이면 취소) · R 재장전 · 1~4 무기 · Tab 점수판 · Esc 일시정지 — 앉은 채 앞으로 갈 때는 C 추천(Ctrl+W는 브라우저 탭 닫기)';
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
  const loadingText = el('p', null, '맵 불러오는 중…');
  loading.append(el('div', 'core-spinner'), loadingText);
  root.append(loading);

  // ---- 클릭해서 시작 / 일시정지
  const overlay = el('div', 'core-overlay');
  overlay.hidden = true;
  const ovCard = el('div', 'core-card small');
  const ovTitle = el('h2', null, '클릭해서 시작');
  const ovText = el('p', 'core-sub', '마우스로 시점을 돌리려면 화면을 클릭하세요. Esc를 누르면 다시 여기로 와요.');
  const resume = el('button', 'core-btn primary', '▶ 계속하기');
  resume.type = 'button';
  const toMenu = el('button', 'core-btn', '메뉴로 나가기');
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
      ovTitle.textContent = first ? '클릭해서 시작' : '일시정지';
      resume.textContent = first ? '▶ 시작하기' : '▶ 계속하기';
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
    loadingText.textContent = `${m ? m.name : e.id} 불러오는 중…`;
    loading.hidden = false;
    overlay.hidden = true;
  }));
  offs.push(bus.on('map:loaded', () => { loading.hidden = true; refreshOverlay(!started); }));
  offs.push(bus.on('map:error', (e) => { loading.hidden = true; showError('맵을 불러오지 못했어요: ' + (e.message || e.id)); }));
  offs.push(bus.on('input:lock', (e) => { if (e.locked) started = true; refreshOverlay(!started); }));
  offs.push(bus.on('input:lock-error', () => { if (inGame()) ovText.textContent = '포인터 잠금을 쓸 수 없는 환경이에요(브라우저 설정·iframe 확인). 다시 클릭해 보세요.'; }));
  offs.push(bus.on('screen:unavailable', (e) => {
    note.textContent = e.name === 'lobby' ? '멀티플레이는 준비 중이에요. 지금은 연습장만 열려 있어요.' : `'${e.name}' 화면은 아직 준비 중이에요.`;
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

const PART_KO = { head: '머리', body: '몸통', legs: '다리', hand: '손', foot: '발' };
const EMOTE_DENY = { moving: '멈춘 상태에서만 할 수 있어요', air: '땅 위에서만 할 수 있어요', crouch: '일어선 상태에서만 할 수 있어요', dead: '살아 있을 때만 할 수 있어요', unknown: '없는 이모트예요' };

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
  const statsTitle = el('b', null, '🎯 연습장');
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
  const wName = el('span', 'core-wname', '임시 히트스캔');
  ammo.append(wName, ammoNum, ammoRes);
  bottom.append(hp, ammo);
  // 이모트 휠(최소 버전: 8칸 원형 + 가상 커서). UI 플러그인이 있으면 그쪽 휠을 쓴다
  const wheel = el('div', 'core-emote-wheel');
  wheel.hidden = true;
  const wheelDot = el('i', 'core-emote-dot');
  const wheelHub = el('b', 'core-emote-hub', 'B');
  const slots = EMOTES.slice(0, EMOTE_WHEEL.SLOTS).map((e, i) => {
    const a = (i / EMOTE_WHEEL.SLOTS) * Math.PI * 2;
    const it = el('div', 'core-emote-slot');
    it.style.left = `calc(50% + ${Math.sin(a) * 118}px)`;
    it.style.top = `calc(50% - ${Math.cos(a) * 118}px)`;
    it.append(el('span', 'core-emote-ico', e.icon), el('small', null, e.name));
    return it;
  });
  wheel.append(...slots, wheelHub, wheelDot);
  const emoteTag = el('div', 'core-emote-tag');
  emoteTag.hidden = true;
  hud.append(cross, hit, toast, feed, statsBox, mapName, perf, bottom, wheel, emoteTag);
  root.append(hud);

  // 점수판(Tab)
  const board = el('div', 'core-board');
  board.hidden = true;
  const boardTitle = el('h3', null, 'Tab · 연습장 과녁');
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
  offs.push(bus.on('map:loaded', (e) => { mapName.textContent = `${e.data.name || e.id}${e.data.fallback ? ' (연습 맵 대체)' : ''}`; }));
  offs.push(bus.on('hit:player', (e) => {
    if (!e || e.shooterId !== ctx.player.state.id) return;
    flashHit(e.part === 'head' ? 'head' : 'body');
  }));
  offs.push(bus.on('sandbox:target-hit', (e) => {
    if (e.killed) flashHit('kill');
    showToast(`${PART_KO[e.part] || e.part} −${e.damage}${e.killed ? ' · 쓰러뜨림!' : ''} (${Math.round(e.dist)} m)`, e.part === 'head' ? 'head' : '');
  }));
  offs.push(bus.on('sandbox:target-down', (e) => addFeed(`🎯 ${e.name} — ${e.part === 'head' ? '헤드샷' : PART_KO[e.part] || e.part} (${Math.round(e.dist)} m)`)));
  offs.push(bus.on('sandbox:stats', (s) => {
    statsText.textContent = `사격 ${s.shots} · 명중 ${s.hits} (${s.accuracy}%) · 머리 ${s.head} · 쓰러뜨림 ${s.kills}${s.longest ? ` · 최장 ${s.longest} m` : ''}`;
  }));
  offs.push(bus.on('sandbox:targets', (e) => {
    boardBody.textContent = '';
    for (const t of e.list) {
      const r = el('div', 'core-board-row' + (t.alive ? '' : ' down'));
      r.append(el('span', null, t.name), el('span', null, t.mode === 'strafe' ? '좌우 이동' : t.mode === 'bob' ? '앉았다 일어섬' : '서 있음'), el('b', null, t.alive ? `HP ${t.hp}` : '쓰러짐'));
      boardBody.append(r);
    }
  }));
  offs.push(bus.on('input:scoreboard', (e) => { if (!hud.hidden) board.hidden = !e.open; }));
  offs.push(bus.on('weapon:ammo', (e) => {
    ammoNum.textContent = e.reloading ? '…' : String(e.ammo);
    ammoRes.textContent = '/ ' + (Number.isFinite(e.reserve) ? e.reserve : '∞');
    ammo.classList.toggle('low', !e.reloading && e.ammo <= Math.ceil((e.mag || 30) * 0.2));
  }));
  offs.push(bus.on('weapon:reload', () => showToast('재장전…')));
  offs.push(bus.on('weapon:zoom', (e) => cross.classList.toggle('aim', !!e.active)));
  // 이모트: 휠 · 진행 표시 · 3인칭이면 조준선 숨김 · 거절 사유
  offs.push(bus.on('input:emoteWheel', (e) => {
    wheel.hidden = !e.open || hud.hidden;
    slots.forEach((it, i) => it.classList.toggle('on', e.selected === i));
    wheelDot.style.transform = `translate(${e.cursor ? e.cursor.x : 0}px, ${e.cursor ? e.cursor.y : 0}px)`;
    cross.style.visibility = e.open || ctx.player.thirdPerson > 0 ? 'hidden' : '';
  }));
  offs.push(bus.on('player:emote', (e) => {
    const def = EMOTES.find((x) => x.code === e.code);
    emoteTag.hidden = !e.active;
    if (e.active && def) emoteTag.textContent = `${def.icon} ${def.name} — 움직이면 취소`;
  }));
  offs.push(bus.on('player:view', (e) => { cross.style.visibility = e.mode === 'third' ? 'hidden' : ''; }));
  offs.push(bus.on('player:emote-denied', (e) => showToast(EMOTE_DENY[e.reason] || '지금은 할 수 없어요')));
  offs.push(bus.on('input:slot', (e) => { if (ctx.flags.devgun) showToast(`${e.slot}번 무기는 무기 모듈이 붙으면 쓸 수 있어요`); }));
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
