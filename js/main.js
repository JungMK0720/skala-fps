/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 부트스트랩. 코어 모듈과 계정을 만들고 화면 상태 머신, 게임 루프, 플러그인을 띄운다.
 */
/**
 * 화면: menu | sandbox | lobby | room | match | results
 *   - core가 구현: menu(기본 메뉴), sandbox(연습장)
 *   - 나머지는 플러그인이 ctx.registerScreen(name, { enter(params, from), exit(to) })로 등록한다.
 *     등록되지 않은 화면으로 가려 하면 'screen:unavailable' {name}을 발행하고 그대로 머문다.
 *
 * 플러그인: js/{ui,net,game}/index.js 가 `export function install(ctx)`를 내보내면 부팅 때 순서대로 호출.
 *   (무기·FX·UI·연습장·멀티 연결은 game/index.js 한곳에서 한다 — game/WORLD_API.md)
 *   install(ctx) → { provides?: string[], dispose?() } (Promise 가능)
 *   provides: 'weapons'(임시 총 끔) · 'menu'(기본 메뉴·오버레이 끔) · 'hud'(기본 HUD 끔)
 *   다른 이름으로 된 진입점(createUI, connect …)은 자동으로 부르지 않는다 — 접착 코드는 install 안에서.
 *
 * 계정: ctx.account는 플러그인보다 먼저 만들어진다. account.ready를 기다리지 않는다(네트워크가 게임을 막지 않게).
 *   플레이어 이름은 계정 닉네임이다. 닉네임 게이트를 지나기 전에만(예: ?sandbox=) 임시 이름을 쓴다.
 *
 * URL: ?sandbox=<mapId>  메뉴 없이 연습장 · &debug=1  window.__skalafps = ctx, 디버그 패널
 *      &plugins=0  플러그인 끄기 · &autoplay=1  (자동 테스트용) 포인터 잠금 없이도 입력·화면 진행, 닉네임 게이트 건너뜀
 */
import * as THREE from 'three';
import * as consts from './core/consts.js';
import { bus } from './core/bus.js';
import { createSettings } from './core/settings.js';
import { createAccount } from './account/index.js';
import * as physics from './engine/physics.js';
import * as materials from './engine/materials.js';
import { createRenderer } from './engine/renderer.js';
import { createInput } from './engine/input.js';
import { createTouchControls } from './engine/touch.js';
import { detectTouch } from './engine/touch-logic.js';
import { createLoop } from './engine/loop.js';
import { createLocalPlayer } from './engine/player.js';
import { createAvatars } from './engine/avatars.js';
import { createSandbox } from './engine/sandbox.js';
import { createDevGun } from './engine/devgun.js';
import { createFallbackMenu, createFallbackHud } from './engine/fallback-ui.js';
import { buildMap } from './maps/builder.js';

const params = new URLSearchParams(location.search);
const FLAGS = {
  debug: params.has('debug') && params.get('debug') !== '0',
  autoplay: params.has('autoplay') && params.get('autoplay') !== '0',
  plugins: params.get('plugins') !== '0',
  sandbox: params.get('sandbox') || null,
  devgun: false,
  touch: detectTouch({ flag: params.get('touch'), coarse: !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches), maxTouchPoints: navigator.maxTouchPoints || 0 })
};
// weapons·fx는 index.js 없이 game/index.js(World)가 직접 엮는다 → 여기서 불러 보면 404만 남고, 나중에 install이 생기면 두 번 엮인다
const PLUGIN_NAMES = ['ui', 'net', 'game'];
const GAME_SCREENS = new Set(['sandbox', 'match']);

function sessionId() {
  const make = () => 'p' + Math.random().toString(36).slice(2, 10);
  try {
    let id = sessionStorage.getItem('skalafps.pid');
    if (!id || !/^[A-Za-z0-9_-]{1,40}$/.test(id)) { id = make(); sessionStorage.setItem('skalafps.pid', id); }
    return id;
  } catch (e) { return make(); }
}

/** 닉네임 게이트를 지나기 전에 쓰는 임시 이름 */
const temporaryName = () => '플레이어' + Math.floor(100 + Math.random() * 900);

const nextFrame = () => new Promise((res) => {
  let done = false;
  const fin = () => { if (!done) { done = true; res(); } };
  requestAnimationFrame(fin);
  setTimeout(fin, 60);
});

function fatal(msg, err) {
  console.error('[skalafps]', msg, err || '');
  const ui = document.getElementById('pc-ui') || document.body;
  const box = document.createElement('div');
  box.className = 'core-fatal';
  const h = document.createElement('h2');
  h.textContent = '게임을 시작할 수 없어요';
  const p = document.createElement('p');
  p.textContent = msg;
  box.append(h, p);
  if (err) { const pre = document.createElement('pre'); pre.textContent = String((err && err.stack) || err); box.append(pre); }
  ui.append(box);
}

/** 맵 만들기·치우기. 셰이더를 미리 준비해 첫 프레임에 끊기지 않게 한다. */
function createMapHost({ maps, renderer, avatars }) {
  let map = null;
  let loading = false;
  let queue = Promise.resolve();

  function unload() {
    if (!map) return;
    const id = map.id;
    map.dispose();
    map = null;
    bus.emit('map:unload', { id });
  }

  /** 맵과 함께 아바타 몸·이모트 리그(두 팀)도 넣어 GPU 버퍼·셰이더·그리기 상태를 지금 준비한다 */
  async function prewarm() {
    await avatars.prewarm(async () => {
      try { if (renderer.three.compileAsync) await renderer.three.compileAsync(renderer.scene, renderer.camera); } catch (e) { /* 미지원 브라우저 */ }
      // 화면 밖 메시도 빠짐없이 그리도록 프러스텀 컬링을 잠깐 끈다(그림자 패스 포함) → 스폰 뒤 처음 보는 쪽에서도 안 끊김
      // 1픽셀 가위(scissor)로 그려 래스터 비용은 거의 없고, 그리기 상태·버퍼·셰이더 준비만 일어난다(화면에도 안 보임)
      const culled = [];
      renderer.scene.traverse((o) => { if (o.frustumCulled) { o.frustumCulled = false; culled.push(o); } });
      const gl3 = renderer.three;
      try { gl3.setScissorTest(true); gl3.setScissor(0, 0, 1, 1); renderer.update(0); renderer.render(); } catch (e) { /* ignore */ }
      finally { gl3.setScissorTest(false); for (const o of culled) o.frustumCulled = true; }
    });
  }

  /** 한 번에 하나만 만든다. 겹치면 먼저 만든 맵이 치워지지 않은 채 장면에 남는다 */
  function load(id) {
    const run = queue.then(() => loadNow(id));
    queue = run.catch(() => {});
    return run;
  }

  async function loadNow(id) {
    const data = maps.getMap(id) || maps.TEST_MAP;
    loading = true;
    bus.emit('map:loading', { id });
    unload();
    await nextFrame();
    await nextFrame();
    try {
      const t0 = performance.now();
      const built = buildMap(data, renderer.scene, { onWarn: (m) => console.warn(`[map:${id}]`, m) });
      renderer.setTheme(built.theme);
      map = built;
      await prewarm();
      loading = false;
      console.info(`[map:${id}] built in ${Math.round(performance.now() - t0)} ms`, built.stats, built.warnings.length ? built.warnings : '');
      bus.emit('map:loaded', { id, data, map: built });
      return built;
    } catch (err) {
      loading = false;
      bus.emit('map:error', { id, message: (err && err.message) || String(err), error: err });
      throw err;
    }
  }

  return { load, unload, get map() { return map; }, get loading() { return loading; } };
}

/** 화면 상태 머신. 전환은 직렬화한다(연타해도 순서대로 하나씩). */
function createScreenMachine() {
  const screens = new Map();
  let current = null;
  let queue = Promise.resolve();

  function register(name, handler) {
    if (!consts.SCREENS.includes(name)) throw new Error('unknown screen: ' + name);
    screens.set(name, handler || {});
    return () => { if (screens.get(name) === handler) screens.delete(name); };
  }

  async function go(name, enterParams = {}) {
    if (!consts.SCREENS.includes(name)) throw new Error('unknown screen: ' + name);
    const handler = screens.get(name);
    if (!handler) { bus.emit('screen:unavailable', { name, params: enterParams }); return false; }
    const from = current;
    const prev = from ? screens.get(from) : null;
    if (prev && prev.exit) {
      try { await prev.exit(name); } catch (err) { console.error(`[screen] ${from}.exit`, err); }
    }
    current = name;
    bus.emit('screen:change', { from, to: name, params: enterParams });
    if (handler.enter) {
      try { await handler.enter(enterParams, from); }
      catch (err) {
        console.error(`[screen] ${name}.enter 실패`, err);
        bus.emit('app:error', { message: `${name} 화면을 열지 못했어요: ${(err && err.message) || err}` });
        if (name !== 'menu') await go('menu');
        return false;
      }
    }
    return true;
  }

  function set(name, enterParams) {
    const p = queue.then(() => go(name, enterParams));
    queue = p.catch(() => {});
    return p;
  }

  /** 페이지를 닫을 때: 지금 화면의 exit를 바로 부른다 */
  function exitCurrent() {
    const handler = current && screens.get(current);
    if (handler && handler.exit) handler.exit(null);
  }

  return { register, set, exitCurrent, get current() { return current; } };
}

/** 전체 화면(Fullscreen API). 들어가면 input이 Keyboard Lock을 걸어 Ctrl+W·Tab·Esc 같은 키도 게임이 받는다(크로뮴). 클릭·키 핸들러 안에서 부를 것 */
function fullscreenControls(app) {
  const api = {
    isFullscreen: () => !!document.fullscreenElement,
    enterFullscreen() {
      const el = app || document.documentElement;
      if (document.fullscreenElement) return Promise.resolve(true);
      if (!el.requestFullscreen) return Promise.resolve(false);
      try { return el.requestFullscreen({ navigationUI: 'hide' }).then(() => true, () => false); }
      catch (err) { return Promise.resolve(false); }
    },
    exitFullscreen() {
      if (!document.fullscreenElement || !document.exitFullscreen) return Promise.resolve();
      return document.exitFullscreen().catch(() => {});
    },
    toggleFullscreen() { return document.fullscreenElement ? api.exitFullscreen() : api.enterFullscreen(); }
  };
  return api;
}

/**
 * 전체 화면과 설정('fullscreen': 'on' | 'off')을 맞춘다.
 *  - F11(input:fullscreenToggle)과 설정·일시정지 메뉴의 버튼(settings:change)이 전체 화면을 켜고 끈다. 둘 다 사용자 입력 안에서 온다.
 *  - 실제 전체 화면 상태가 바뀌면 설정을 따라 바꾼다(Esc를 길게 눌러 나갔으면 '끔'으로).
 *  - 설정이 '켬'인 채 다시 방문했으면 처음 포인터를 잠그는 클릭(input:lockRequest)에서 전체 화면도 같이 켠다.
 *  - 브라우저가 전체 화면을 거절하면(끼워 넣은 화면, 권한 없음) 설정을 '끔'으로 되돌리고 fullscreen:denied를 낸다.
 */
function wireFullscreen(ctx) {
  const { settings } = ctx;
  if (FLAGS.touch) return;   // 휴대폰은 engine/touch.js가 가로 고정과 함께 다룬다
  /** 전체 화면을 켠다. 거절되면 설정을 되돌려 화면의 표시와 실제 상태가 어긋나지 않게 한다 */
  const enter = (notify) => ctx.enterFullscreen().then((ok) => {
    if (ok || ctx.isFullscreen()) return;
    settings.set('fullscreen', 'off');
    bus.emit('fullscreen:denied', { notify: !!notify });
  });
  bus.on('input:fullscreenToggle', () => { if (ctx.isFullscreen()) ctx.exitFullscreen(); else enter(true); });
  bus.on('settings:change', (e) => {
    if (!e || (e.key !== 'fullscreen' && e.key !== '*')) return;
    const want = settings.get('fullscreen') === 'on';
    if (want && !ctx.isFullscreen()) enter(true);
    else if (!want && ctx.isFullscreen()) ctx.exitFullscreen();
  });
  bus.on('input:lockRequest', () => {
    if (settings.get('fullscreen') === 'on' && !ctx.isFullscreen() && !FLAGS.autoplay) enter(false);
  });
  document.addEventListener('fullscreenchange', () => {
    settings.set('fullscreen', ctx.isFullscreen() ? 'on' : 'off');
    bus.emit('fullscreen:change', { active: ctx.isFullscreen() });
  });
}

/** core 기본 화면: 메뉴와 연습장(플러그인이 바꿔 등록할 수 있다) */
function registerCoreScreens(ctx, machine, hooks) {
  const { input, renderer, player, avatars, provided } = ctx;
  let sandbox = null, devgun = null;

  machine.register('menu', {
    enter() {
      input.exitLock();
      input.setEnabled(false);
      hooks.setRendering(false);
    }
  });

  machine.register('sandbox', {
    async enter(enterParams = {}) {
      const mapId = enterParams.mapId || 'testyard';
      await ctx.loadMap(mapId);
      player.state.team = 'owner';
      player.state.kills = player.state.deaths = 0;
      avatars.setLocalTeam('owner');
      const spawns = ctx.map.spawns.owner;
      player.spawn(spawns[enterParams.spawn | 0] || spawns[0]);
      renderer.setFov(renderer.baseFov);
      input.setLookScale(1);
      sandbox = createSandbox(ctx);
      if (!provided.has('weapons')) { devgun = createDevGun(ctx); FLAGS.devgun = true; }
      input.setEnabled(input.locked || FLAGS.autoplay); // 잠금 전(클릭 전)·일시정지 중에는 조작 안 받음
      hooks.setRendering(true);
      bus.emit('sandbox:start', { mapId, map: ctx.map });
    },
    exit() {
      bus.emit('sandbox:end', {});
      if (devgun) { devgun.dispose(); devgun = null; FLAGS.devgun = false; }
      if (sandbox) { sandbox.dispose(); sandbox = null; }
      avatars.clear();
      avatars.setLocalBody(null);
      input.exitLock();
      input.setEnabled(false);
      input.setLookScale(1);
      renderer.setFov(renderer.baseFov);
      hooks.setRendering(false);
      ctx.unloadMap();
    }
  });

  return { get sandbox() { return sandbox; }, get devgun() { return devgun; } };
}

/** 틱·프레임 순서: 움직이는 지형 → 플레이어 → 아바타·맵 → (플러그인) → 렌더 */
function wireLoop(ctx) {
  const { loop, player, avatars, renderer } = ctx;
  loop.onTick((dt) => { if (ctx.map) ctx.map.tickMovers(dt); }, -150);   // 지형을 먼저 옮기고 몸을 움직인다(위에 선 몸이 같이 간다)
  loop.onTick((dt) => { if (ctx.map) player.tick(dt); }, -100);
  loop.onFrame((dt, alpha) => { if (ctx.rendering && ctx.map) player.frame(dt, alpha); }, -100);
  loop.onFrame((dt, alpha, now) => {
    if (!ctx.rendering || !ctx.map) return;
    avatars.setLocalBody(player.getBodyState()); // 이모트 3인칭 때만 내 몸을 그린다(평소엔 숨김)
    avatars.update(now, dt);
    ctx.map.update(dt, now / 1000, alpha);
  }, -50);
  loop.onFrame((dt) => {
    if (!ctx.rendering || !ctx.map) return;
    const p = player.state.pos;
    renderer.setShadowFocus(p[0], p[1], p[2]);
    renderer.update(dt);
    renderer.render();
  }, 1000);
}

/** 포인터 잠금·품질 변경·탭 닫기 확인 */
function wireWindow(ctx) {
  const { renderer, input, avatars } = ctx;
  const inGame = () => GAME_SCREENS.has(ctx.screen);
  // 캔버스 클릭 → 포인터 잠금 (게임 화면에서)
  renderer.domElement.addEventListener('click', () => {
    if (inGame() && !input.locked) input.requestLock();
  });
  // 품질(그림자 켬·끔)이 바뀌면 셰이더가 다시 만들어지므로, 그 자리(안전한 때)에서 아바타·리그 셰이더도 함께 준비한다
  bus.on('renderer:quality', () => { if (ctx.map) avatars.compileWarm(renderer.three, renderer.camera); });
  // 게임 화면에서는 포인터 잠금 = 조작 가능 (autoplay 테스트 모드는 잠금 없이도 허용)
  bus.on('input:lock', (e) => { if (inGame()) input.setEnabled(e.locked || FLAGS.autoplay); });
  // Ctrl+W(탭 닫기)는 페이지가 막을 수 없다(앉기 = Ctrl) → 연습장·경기 화면에 있는 동안은 닫기 전에 확인을 받는다
  window.addEventListener('beforeunload', (e) => {
    if (!inGame() || FLAGS.autoplay) return undefined;
    e.preventDefault();
    e.returnValue = '';
    return '';
  });
}

/** 계정 닉네임이 바뀌면 플레이어 이름을 따라 바꾼다. 닉네임이 지워지면(초기화) 게이트를 지날 때까지 지금 이름을 둔다. */
function wireAccountName(ctx) {
  bus.on('account:change', (e) => {
    const nickname = e && e.profile ? e.profile.nickname : '';
    if (nickname && nickname !== ctx.session.name) ctx.setPlayerName(nickname);
  });
}

async function installPlugins(ctx) {
  const results = await Promise.allSettled(PLUGIN_NAMES.map((n) => import(`./${n}/index.js`)));
  for (let i = 0; i < PLUGIN_NAMES.length; i++) {
    const name = PLUGIN_NAMES[i], r = results[i];
    if (r.status !== 'fulfilled') { console.info(`[plugin] ${name}/index.js 없음 → core 기본 동작`); continue; }
    const mod = r.value;
    if (typeof mod.install !== 'function') { console.info(`[plugin] ${name}/index.js에 install(ctx)가 없어 건너뜀`); continue; }
    try {
      const res = (await mod.install(ctx)) || {};
      const provides = Array.isArray(res.provides) ? res.provides.map(String) : [];
      provides.forEach((p) => ctx.provided.add(p));
      ctx.plugins.push({ name, api: res, provides });
      bus.emit('plugin:loaded', { name, provides });
    } catch (err) {
      console.error(`[plugin] ${name} install 실패 → 건너뜀`, err);
      bus.emit('plugin:failed', { name, message: String((err && err.message) || err) });
    }
  }
}

function wireTeardown(ctx, machine, fallback) {
  window.addEventListener('pagehide', (e) => {
    if (e.persisted) return;
    try { machine.exitCurrent(); } catch (err) { /* ignore */ }
    for (const p of ctx.plugins) { try { p.api && p.api.dispose && p.api.dispose(); } catch (err) { /* ignore */ } }
    fallback.forEach((f) => f.dispose());
    ctx.account.dispose();
    ctx.loop.dispose();
    ctx.input.dispose();
    ctx.player.dispose();
    ctx.avatars.dispose();
    ctx.renderer.dispose();
  });
}

async function boot() {
  const app = document.getElementById('pc-app');
  const view = document.getElementById('pc-view');
  const uiRoot = document.getElementById('pc-ui');
  const settings = createSettings(bus);
  const account = createAccount({ bus });

  let renderer;
  try { renderer = createRenderer({ container: view, settings, bus, preferLow: FLAGS.touch }); }
  catch (err) { fatal('3D(WebGL)를 쓸 수 없어요. 브라우저의 하드웨어 가속을 켜거나 다른 브라우저로 열어 주세요.', err); return; }

  const input = createInput({ element: renderer.domElement, bus, settings, touch: FLAGS.touch });
  input.setEnabled(false);
  if (FLAGS.touch) createTouchControls({ input, bus, canvas: renderer.domElement, root: app, gameScreens: GAME_SCREENS });
  const loop = createLoop({ tickRate: consts.TICK_RATE, bus });
  const avatars = createAvatars({ scene: renderer.scene, camera: renderer.camera });
  let mapHost = null;
  const player = createLocalPlayer({ bus, input, camera: renderer.camera, getWorld: () => (mapHost && mapHost.map ? mapHost.map.world : null) });
  const session = { id: sessionId(), name: account.profile.nickname || temporaryName() };
  player.state.id = session.id;
  player.state.name = session.name;

  const maps = await import('./maps/index.js');
  mapHost = createMapHost({ maps, renderer, avatars });
  const machine = createScreenMachine();
  const targetProviders = new Set();
  const plugins = [];
  let rendering = false;

  /* ---------------- 사격 판정 도우미 ---------------- */
  function getTargets() {
    const out = avatars.getTargets();
    for (const fn of targetProviders) {
      try { const extra = fn(); if (extra && extra.length) out.push(...extra); } catch (e) { console.error('[targets]', e); }
    }
    return out;
  }
  function addTargets(fn) { targetProviders.add(fn); return () => targetProviders.delete(fn); }
  function traceShot(origin, dir, maxDist = 1000, opts = null) {
    return physics.traceShot(mapHost.map ? mapHost.map.world : null, origin, dir, maxDist, getTargets(), opts);
  }
  function raycastWorld(origin, dir, maxDist = 1000, opts = null) {
    return mapHost.map ? physics.raycastWorld(mapHost.map.world, origin, dir, maxDist, opts) : null;
  }

  function setPlayerName(name) {
    const n = String(name || '').trim().slice(0, 12);
    if (!n) return session.name;
    session.name = n;
    player.state.name = n;
    settings.set('name', n);
    bus.emit('player:name', { id: session.id, name: n });
    return n;
  }

  /* ---------------- ctx ---------------- */
  const coreScreens = {};
  const ctx = {
    version: consts.VERSION,
    THREE, bus, consts, settings, account, physics, materials,
    renderer, input, loop, player, avatars, maps,
    flags: FLAGS,
    session,
    ui: { root: uiRoot, app },
    plugins, provided: new Set(),
    get map() { return mapHost.map; },
    get world() { return mapHost.map ? mapHost.map.world : null; },
    get screen() { return machine.current; },
    get loading() { return mapHost.loading; },
    get sandbox() { return coreScreens.state.sandbox; },
    get devgun() { return coreScreens.state.devgun; },
    get rendering() { return rendering; },
    setRendering(v) { rendering = !!v; },
    setScreen: machine.set,
    registerScreen: machine.register,
    loadMap: mapHost.load,
    unloadMap: mapHost.unload,
    buildMap,
    getTargets, addTargets, traceShot, raycastWorld,
    setPlayerName,
    ...fullscreenControls(app),
    onTick: (fn, order) => loop.onTick(fn, order),
    onFrame: (fn, order) => loop.onFrame(fn, order)
  };
  coreScreens.state = registerCoreScreens(ctx, machine, { setRendering: ctx.setRendering });

  wireLoop(ctx);
  wireWindow(ctx);
  wireFullscreen(ctx);
  wireAccountName(ctx);

  /* ---------------- 플러그인 ---------------- */
  if (FLAGS.plugins) await installPlugins(ctx);
  const fallback = [];
  if (!ctx.provided.has('menu')) fallback.push(createFallbackMenu(ctx));
  if (!ctx.provided.has('hud')) fallback.push(createFallbackHud(ctx));

  if (FLAGS.debug) window.__skalafps = ctx;
  if (FLAGS.debug) import('./engine/debug.js').then((m) => plugins.push({ name: 'debug', api: m.createDebug(ctx), provides: [] })).catch((err) => console.warn('[debug] 디버그 도구를 불러오지 못했어요', err));
  wireTeardown(ctx, machine, fallback);

  loop.start();
  bus.emit('app:ready', { ctx });
  await machine.set('menu');
  if (FLAGS.sandbox) await machine.set('sandbox', { mapId: FLAGS.sandbox });
  return ctx;
}

boot().catch((err) => fatal('초기화 중 오류가 났어요.', err));
