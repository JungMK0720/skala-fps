/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: UI 루트. 캔버스 위 순수 DOM 오버레이(메뉴·닉네임 게이트·마이페이지·상점·로비·방·로드아웃·HUD·스코프·이모트 휠·점수판·결과·일시정지)를 만들고
 *          화면 배타 규칙, 이벤트, 커서 상태, 설정 어댑터, 계정·무기·맵 연결을 맡는다. 사용법과 이벤트 목록은 ./README.md.
 */
import { h, ensureStyles, isTextField, relativeAngle } from './dom.js';
import { createLocalSettings, isSettingsStore, clampSetting, DEFAULT_SETTINGS, UI_KEYS } from './settings.js';
import { normMap } from './icons.js';
import { createMenu } from './menu.js';
import { createNicknameGate } from './nickname.js';
import { createMyPage } from './mypage.js';
import { createShop } from './shop.js';
import { createLobby } from './lobby.js';
import { createRoom } from './room.js';
import { createLoadout } from './loadout.js';
import { createHud } from './hud.js';
import { createScope } from './scope.js';
import { createScoreboard } from './scoreboard.js';
import { createResults } from './results.js';
import { createPause } from './pause.js';
import { createEmotes, emoteIndexAt, EMOTE_WHEEL } from './emotes.js';
import { NICKNAME_MAX, cleanNickname } from '../account/nickname.js';

export { relativeAngle, DEFAULT_SETTINGS, emoteIndexAt, EMOTE_WHEEL };

export const SCREENS = Object.freeze(['menu', 'nickname', 'mypage', 'shop', 'lobby', 'room', 'loadout', 'hud', 'emotes', 'scoreboard', 'results', 'pause']);
const PAGES = ['menu', 'mypage', 'shop', 'lobby', 'room', 'results']; // 서로 배타적인 전체 화면
const GAME_LAYERS = ['hud', 'emotes', 'loadout', 'pause', 'scoreboard']; // 게임 중 레이어
const CURSOR_SCREENS = ['menu', 'nickname', 'mypage', 'shop', 'lobby', 'room', 'loadout', 'results', 'pause']; // 커서가 필요한 화면(emotes는 아님)
const Z_ORDER = ['hud', 'emotes', 'scoreboard', 'loadout', 'pause', 'results', 'room', 'lobby', 'shop', 'mypage', 'menu', 'nickname']; // 아래 → 위
const ACCOUNT_SCREENS = ['menu', 'nickname', 'mypage', 'shop', 'loadout']; // 계정이 바뀌면 다시 그리는 화면

const cleanName = (n) => cleanNickname(n).slice(0, NICKNAME_MAX);

/**
 * @param {HTMLElement} rootEl  게임 컨테이너(캔버스와 같은 부모, position 지정 권장) 또는 document.body
 * @param {{ settings?: { get(k), set(k, v), all?() }, account?: object, maps?: Array|object, injectCss?: boolean }} [options]
 *   settings: core의 createSettings(bus) 저장소. 넘기면 설정을 그 저장소 하나로만 읽고 쓴다.
 *   account : js/account의 createAccount 결과. 없으면 마이페이지·상점·닉네임 게이트를 쓰지 않는다.
 *   maps    : js/maps/index.js 모듈(MAP_LIST·MAPS) 또는 맵 목록 배열.
 */
export function createUI(rootEl, options = {}) {
  if (!rootEl || typeof rootEl.append !== 'function') throw new Error('createUI(rootEl): DOM 요소가 필요합니다');
  const styleLink = options.injectCss === false ? null : ensureStyles();
  const root = h('div', { class: 'sk-ui' });
  rootEl.append(root);

  const handlers = new Map();
  const timers = new Map(); // id → 'timeout' | 'interval'
  const cleanups = [];
  const store = isSettingsStore(options.settings) ? options.settings : createLocalSettings();
  let playerName = '';
  let cursorNeeded = false;
  let disposed = false;

  function emit(action, payload) {
    for (const key of [action, '*']) {
      const set = handlers.get(key);
      if (!set) continue;
      for (const fn of [...set]) {
        try { fn(payload, action); } catch (err) { console.error(`[ui] '${action}' 핸들러 오류`, err); }
      }
    }
  }

  // ---------- 설정(저장소 어댑터) ----------
  const readSetting = (k) => {
    const v = store.get(k);
    return v === undefined ? DEFAULT_SETTINGS[k] : v;
  };
  /** 저장소 전체 + UI 항목(보정값). core 저장소면 quality·invertY 같은 다른 키도 함께 들어 있다. */
  function snapshot() {
    const out = typeof store.all === 'function' ? { ...store.all() } : {};
    for (const k of UI_KEYS) out[k] = clampSetting(k, readSetting(k));
    return out;
  }
  function applySettings(patch) {
    const changed = [];
    for (const k of Object.keys(patch || {})) {
      const before = store.get(k);
      store.set(k, k in DEFAULT_SETTINGS ? clampSetting(k, patch[k]) : patch[k]);
      if (store.get(k) !== before) changed.push(k);
    }
    if (!changed.length) return;
    emit('settings:change', { settings: snapshot(), key: changed[0], value: store.get(changed[0]), changed });
  }

  const ctx = {
    root,
    emit,
    account: options.account || null,
    getSettings: snapshot,
    setting: readSetting,
    setSetting: (key, value) => applySettings({ [key]: value }),
    resetSettings: () => applySettings({ ...DEFAULT_SETTINGS }),
    get playerName() { return playerName; },
    setPlayerName: (n) => { playerName = cleanName(n); },
    weapons: new Map(),
    maps: new Map(),
    mapData: null, // 맵 id → 원본 맵 데이터(비밀 스팟 수를 셀 때 쓴다)
    later(fn, ms) {
      const id = setTimeout(() => { timers.delete(id); fn(); }, ms);
      timers.set(id, 'timeout');
      return id;
    },
    every(fn, ms) {
      const id = setInterval(fn, ms);
      timers.set(id, 'interval');
      return id;
    },
    cancel(id) {
      const kind = timers.get(id);
      if (!kind) return;
      if (kind === 'interval') clearInterval(id); else clearTimeout(id);
      timers.delete(id);
    },
    listen(target, type, fn, opts) {
      target.addEventListener(type, fn, opts);
      cleanups.push(() => target.removeEventListener(type, fn, opts));
    },
    hideSelf: (name) => hide(name),
    hooks: {}, // 화면 사이 내부 신호(respawnEnd 등)
  };

  const scope = createScope(ctx);
  const screens = {
    menu: createMenu(ctx),
    nickname: createNicknameGate(ctx),
    mypage: createMyPage(ctx),
    shop: createShop(ctx),
    lobby: createLobby(ctx),
    room: createRoom(ctx),
    loadout: createLoadout(ctx),
    hud: createHud(ctx),
    emotes: createEmotes(ctx),
    scoreboard: createScoreboard(ctx),
    results: createResults(ctx),
    pause: createPause(ctx),
  };
  root.append(scope.el, ...Z_ORDER.map((n) => screens[n].el));

  // 개인전: hud.respawn이 null로 돌아오면(부활) 하단 compact 로드아웃도 닫는다.
  ctx.hooks.respawnEnd = () => {
    const lo = screens.loadout;
    if (lo.visible && lo.isCompact && lo.isCompact()) hide('loadout');
  };

  // UI 입력칸에서 친 키가 엔진(window/document 버블 리스너)으로 새지 않게 막는다.
  for (const type of ['keydown', 'keyup', 'keypress']) {
    ctx.listen(root, type, (e) => { if (isTextField(e.target)) e.stopPropagation(); });
  }
  // 엔진은 점수판 때문에 Tab의 기본 동작을 항상 막는다. 커서가 필요한 화면에서 Tab은 키보드 탐색이어야 하므로 엔진까지 보내지 않는다.
  ctx.listen(window, 'keydown', (e) => { if (e.code === 'Tab' && cursorNeeded) e.stopPropagation(); }, true);
  // 버튼을 누를 때마다 효과음을 요청한다. 게임 쪽이 'ui:sound'를 듣지 않으면 아무 일도 없다.
  ctx.listen(root, 'click', (e) => {
    if (e.target && e.target.closest && e.target.closest('button')) emit('ui:sound', { name: 'ui_click' });
  });

  function get(name) {
    const s = screens[name];
    if (!s) console.warn(`[ui] 알 수 없는 화면: '${name}' (가능: ${SCREENS.join(', ')})`);
    return s;
  }

  function refreshCursor() {
    // 화면이 wantsCursor()를 주면 그 값을 따른다(예: compact 로드아웃은 커서 불필요)
    const need = CURSOR_SCREENS.some((n) => screens[n].visible && (typeof screens[n].wantsCursor !== 'function' || screens[n].wantsCursor()));
    root.classList.toggle('sk-cursor', need);
    if (need !== cursorNeeded) {
      cursorNeeded = need;
      emit('needCursor', need);
    }
  }

  /** 닉네임 게이트가 떠 있는 동안 뒤 화면을 Tab·클릭에서 뺀다. 게이트는 닫을 수 없으니 뒤로 빠져나가지 못하게 한다. */
  function setGateBlocking(on) {
    for (const child of root.children) {
      if (child !== screens.nickname.el) child.inert = on;
    }
  }

  function show(name, props) {
    if (disposed) return api;
    const s = get(name);
    if (!s) return api;
    if (PAGES.includes(name)) {
      for (const other of PAGES) if (other !== name) screens[other].hide();
      for (const g of GAME_LAYERS) screens[g].hide();
      scope.set(0);
    } else if (name === 'hud') {
      for (const pg of PAGES) screens[pg].hide();
    } else if (name === 'pause') {
      screens.scoreboard.hide();
      screens.emotes.hide();
    }
    s.show(props);
    if (name === 'nickname') setGateBlocking(s.visible);
    refreshCursor();
    return api;
  }

  function hide(name) {
    if (disposed) return api;
    const s = get(name);
    if (!s) return api;
    s.hide();
    if (name === 'hud') { scope.set(0); screens.emotes.hide(); }
    if (name === 'nickname') setGateBlocking(false);
    refreshCursor();
    return api;
  }

  function update(name, props) {
    if (disposed) return api;
    const s = get(name);
    if (s) s.update(props);
    if (s && s.visible) refreshCursor(); // 예: loadout compact ↔ 전체 전환
    return api;
  }

  /** 계정이 바뀌었을 때 불러 준다(bus 'account:change'). 떠 있는 화면만 다시 그린다. */
  function refreshAccount() {
    if (disposed || !ctx.account) return api;
    const { nickname } = ctx.account.profile;
    if (nickname) ctx.setPlayerName(nickname);
    for (const name of ACCOUNT_SCREENS) {
      const s = screens[name];
      if (!s.visible) continue;
      if (s.onAccount) s.onAccount(); else s.update();
    }
    refreshCursor();
    return api;
  }

  /** 맵 등록. js/maps/index.js 모듈이나 [{ id, name, nameEn, desc, tag?, rulesets? }] 배열을 받는다. */
  function setMaps(source) {
    const list = Array.isArray(source) ? source : source && Array.isArray(source.MAP_LIST) ? source.MAP_LIST : [];
    ctx.maps.clear();
    for (const m of list) if (m && m.id != null) ctx.maps.set(String(m.id), normMap(m));
    if (source && source.MAPS) ctx.mapData = source.MAPS;
    return api;
  }

  const hud = screens.hud;
  const api = {
    el: root,
    show,
    hide,
    update,
    isVisible: (name) => !!(screens[name] && screens[name].visible),
    needsCursor: () => cursorNeeded,
    /** 포커스가 UI 텍스트 입력칸에 있는가(엔진 키 처리 무시용) */
    isTyping: () => root.contains(document.activeElement) && isTextField(document.activeElement),

    get account() { return ctx.account; },
    refreshAccount,
    /** 닉네임 게이트가 필요한 상태인가: 닉네임이 없거나 서버가 닉네임을 거절했다 */
    nicknameNeeded: () => screens.nickname.needed(),

    hud: {
      set: (p) => hud.set(p),
      hitmarker: (head, kill, opts) => hud.hitmarker(head, kill, opts),
      damageFrom: (angle) => hud.damageFrom(angle),
      center: (text, ms, opts) => hud.center(text, ms, opts),
      callout: (text, tone) => hud.callout(text, tone),
      banner: (opts) => hud.banner(opts),
      reset: () => hud.reset(),
    },
    killfeed: {
      push: (k) => hud.killfeed.push(k),
      clear: () => hud.killfeed.clear(),
    },
    scope: {
      set: (amount, opts) => scope.set(amount, opts),
      get: () => scope.amount,
    },

    on(action, fn) {
      if (typeof fn !== 'function') return () => {};
      if (!handlers.has(action)) handlers.set(action, new Set());
      handlers.get(action).add(fn);
      return () => { const set = handlers.get(action); if (set) set.delete(fn); };
    },
    off(action, fn) {
      const set = handlers.get(action);
      if (set) set.delete(fn);
    },

    getSettings: snapshot,
    setSettings: (patch) => applySettings(patch),
    getPlayerName: () => playerName,
    setPlayerName: (name) => { playerName = cleanName(name); },

    /** 무기 정의 등록(킬피드·슬롯·로드아웃·상점에서 id로 이름·아이콘·해설을 찾는다). 배열 또는 { id: def } */
    setWeapons(defs) {
      ctx.weapons.clear();
      const list = Array.isArray(defs) ? defs : defs && typeof defs === 'object' ? Object.keys(defs).map((k) => ({ id: k, ...defs[k] })) : [];
      for (const d of list) if (d && d.id != null) ctx.weapons.set(String(d.id), { ...d, id: String(d.id) });
      return api;
    },
    setMaps,

    dispose() {
      if (disposed) return;
      disposed = true;
      for (const [id, kind] of timers) { if (kind === 'interval') clearInterval(id); else clearTimeout(id); }
      timers.clear();
      for (const off of cleanups.splice(0)) off();
      for (const s of Object.values(screens)) s.dispose();
      scope.dispose();
      handlers.clear();
      root.remove();
      if (styleLink) styleLink.remove();
    },
  };
  if (options.maps) setMaps(options.maps);
  return api;
}

export default createUI;
