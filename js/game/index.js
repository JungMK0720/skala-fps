/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: game 플러그인. UI, World(무기·FX·오디오), 연습장 봇전, 멀티 세션, 계정(닉네임 게이트·마이페이지·상점)을 한곳에서 엮는다.
 */
/**
 * main.js가 부팅 때 install(ctx)를 부른다(CORE_API 3절). provides로 core 임시 총·기본 메뉴·기본 HUD를 끈다.
 *   - UI: createUI(ctx.ui.root, { settings, account, maps }). 앱에 하나. 메뉴는 core 'menu' 화면에 맞춰 띄운다.
 *   - 마이페이지·상점은 core 화면이 아니라 메뉴 안의 UI 페이지다. core 화면은 'menu' 그대로다.
 *   - 닉네임 게이트: 메뉴 위에 뜨는 UI 오버레이. ?autoplay=1은 게이트를 건너뛰고, ?sandbox=는 메뉴로 돌아올 때까지 미룬다.
 *   - World: createWorld({ ctx, ui }). 연습장과 멀티가 같은 것을 쓴다(./WORLD_API.md).
 *   - 연습장: core 'sandbox' 화면을 practice.js로 바꿔 등록한다(?sandbox=<mapId>도 그대로 동작).
 *   - 멀티: 멀티플레이를 처음 누를 때 ./session.js를 불러 createSession({ ctx, ui, world, settings, bus })를 만든다.
 */
import { createUI } from '../ui/index.js';
import { WEAPONS } from '../weapons/defs.js';
import { createAvatarPortraits } from '../engine/avatars.js';
import { createWorld, setWorldContext } from './world.js';
import { createPractice, createPracticeSetup } from './practice.js';

const SCREEN_LABEL = { lobby: '로비', room: '대기실', match: '멀티 경기', results: '결과' };

/** 오류·안내 알림 */
function createToast(ui) {
  const el = document.createElement('div');
  el.className = 'sk-game-toast';
  el.setAttribute('role', 'alert');
  el.hidden = true;
  ui.el.append(el);
  let timer = 0;
  el.addEventListener('click', () => { el.hidden = true; });
  return {
    notify(text, ms = 5000) {
      el.textContent = String(text || '');
      el.hidden = !text;
      clearTimeout(timer);
      if (text) timer = setTimeout(() => { el.hidden = true; }, ms);
    },
    dispose() { clearTimeout(timer); },
  };
}

/**
 * core 화면 상태가 세션을 따라가게(lobby/room/match/results) 얇은 화면을 등록한다.
 * 'match'에서만 캔버스 클릭 → 포인터 잠금 → 조작(main.js GAME_SCREENS)이 켜진다. 맵·액터는 세션이 world로 다룬다.
 */
function registerSessionScreens(ctx) {
  return ['lobby', 'room', 'match', 'results'].map((name) => ctx.registerScreen(name, {
    enter() {
      if (name === 'match') { ctx.input.setEnabled(ctx.input.locked || !!(ctx.flags && ctx.flags.autoplay)); return; }
      ctx.input.exitLock();
      ctx.input.setEnabled(false);
    },
  }));
}

/** 멀티 세션. 멀티플레이를 누를 때 만들고, 로비에서 메뉴로 나오면 정리한다(연습장과 UI 이벤트가 섞이지 않게). */
function createMultiFlow({ ctx, ui, world, bus }) {
  let sessionP = null;

  function close() {
    const p = sessionP;
    sessionP = null;
    if (p) p.then((s) => { try { if (s && s.dispose) s.dispose(); } catch (err) { /* ignore */ } }, () => {});
  }

  function load() {
    if (!sessionP) {
      sessionP = import('./session.js').then(async (mod) => {
        const make = mod.createSession || mod.default;
        if (typeof make !== 'function') throw new Error('session.js에 createSession이 없어요');
        const s = await make({ ctx, ui, world, settings: ctx.settings, bus, playerName: ctx.session.name, setScreens: true });
        if (s && typeof s.on === 'function') {
          s.on('exit', () => { close(); ctx.setScreen('menu'); });
          s.on('error', (e) => console.warn('[game] session', e && e.where, e && e.error));
        }
        return s;
      });
      sessionP.catch(() => { sessionP = null; });
    }
    return sessionP;
  }

  async function open() {
    // 오프라인 때 정한 닉네임을 서버에 다시 등록한다. 거절되면 게이트가 다시 열리므로 입장을 멈춘다.
    const claim = await ctx.account.retryNickname();
    if (!claim.ok) return;
    try {
      const s = await load();
      if (s && typeof s.open === 'function') await s.open({ name: ctx.session.name });
      else await ctx.setScreen('lobby');
    } catch (err) {
      console.warn('[game] 멀티플레이를 열 수 없어요', err);
      close();
      ui.update('menu', { multiDisabled: '멀티플레이를 열 수 없어요. 잠시 뒤 다시 시도해 주세요.' });
    }
  }

  return { open, close };
}

/** 닉네임 게이트를 언제 열지 정한다. 닫는 일은 게이트가 계정 변경을 보고 스스로 한다. */
function createGateControl({ ctx, ui }) {
  let conflict = null;
  let bootSandbox = !!ctx.flags.sandbox;   // ?sandbox=로 바로 들어간 경우 메뉴로 돌아올 때까지 미룬다

  function allowed() {
    return !ctx.flags.autoplay && !bootSandbox && ctx.screen === 'menu';
  }

  function sync() {
    if (ui.isVisible('nickname')) {
      ui.update('nickname', { conflict });
    } else if (ui.nicknameNeeded() && allowed()) {
      ui.show('nickname', { conflict });
    }
  }

  return {
    sync,
    leftSandbox() { bootSandbox = false; },
    onConflict(e) {
      conflict = e || null;
      sync();
    },
  };
}

export async function install(ctx) {
  const { bus, account } = ctx;
  setWorldContext(ctx);
  const ui = createUI(ctx.ui.root, { settings: ctx.settings, account, maps: ctx.maps });
  ui.setWeapons(WEAPONS);
  // 상점·마이페이지 캐릭터 초상: 게임 렌더러로 캐릭터 × 팀마다 한 번 그려 둔다(처음 보여 줄 때)
  const portraits = ctx.renderer && ctx.renderer.three ? createAvatarPortraits(ctx.renderer.three) : null;
  if (portraits) ui.setAvatarArt((id, team) => portraits.get(id, team));
  const world = await createWorld({ ctx, ui });
  const practice = createPractice({ ctx, world, ui });
  const toast = createToast(ui);
  const gate = createGateControl({ ctx, ui });
  const multi = createMultiFlow({ ctx, ui, world, bus });
  const offs = [...registerSessionScreens(ctx)];

  /* ---------- 연습장 ---------- */
  offs.push(ctx.registerScreen('sandbox', {
    enter: (params) => practice.enter(params || {}),
    exit: () => practice.exit(),
  }));
  const setup = createPracticeSetup({
    ui, maps: ctx.maps,
    onStart: (o) => { ctx.setScreen('sandbox', o); },
  });

  /* ---------- 메뉴 ---------- */
  function showMenu() {
    ui.show('menu', { name: ctx.session.name });
    gate.sync();
  }
  function onScreenChange(e) {
    if (!e || e.to !== 'menu') return;
    if (e.from === 'sandbox') gate.leftSandbox();
    showMenu();
  }
  function openPracticeSetup() {
    multi.close();
    setup.open();
  }

  /* ---------- 마이페이지 · 상점 (메뉴 안의 UI 페이지) ---------- */
  let shopReturn = 'menu';
  function openShop(from, tab) {
    shopReturn = from;
    ui.show('shop', { tab: tab || null });
  }
  function leaveShop() {
    if (typeof world.stopEmotePreview === 'function') world.stopEmotePreview();
    if (shopReturn === 'mypage') ui.show('mypage');
    else showMenu();
  }

  /* ---------- 계정 ---------- */
  function onAccountChange() {
    ui.refreshAccount();
    gate.sync();
  }
  /** 로드아웃 화면의 보조·근접 빠른 교체. 이미 스폰한 뒤에도 바로 적용한다. */
  function equipFromLoadout(e) {
    if (e && account.equip(e.slot, e.id).ok) world.setLocalLoadout(e.id);
  }

  offs.push(
    bus.on('screen:change', onScreenChange),
    bus.on('account:change', onAccountChange),
    bus.on('account:nickname-conflict', (e) => gate.onConflict(e)),
    bus.on('app:error', (e) => toast.notify((e && e.message) || '오류가 났어요')),
    bus.on('map:error', (e) => toast.notify(`맵을 불러오지 못했어요: ${(e && (e.message || e.id)) || ''}`)),
    bus.on('screen:unavailable', (e) => toast.notify(`${SCREEN_LABEL[e && e.name] || (e && e.name) || ''} 화면은 아직 준비 중이에요.`)),
    ui.on('menu:sandbox', openPracticeSetup),
    ui.on('menu:multi', () => multi.open()),
    ui.on('menu:mypage', () => ui.show('mypage')),
    ui.on('menu:shop', () => openShop('menu')),
    ui.on('mypage:back', showMenu),
    ui.on('mypage:shop', (e) => openShop('mypage', e && e.tab)),
    ui.on('shop:back', leaveShop),
    ui.on('shop:preview', (e) => { if (e && e.id && typeof world.previewEmote === 'function') world.previewEmote(e.id); }),
    ui.on('loadout:equip', equipFromLoadout),
    ui.on('ui:sound', (e) => { if (e && e.name && world.sound) world.sound(e.name); }),
  );
  if (ctx.screen === 'menu') showMenu();

  return {
    provides: ['weapons', 'menu', 'hud'],
    ui, world, practice,
    dispose() {
      offs.forEach((o) => { try { o(); } catch (err) { /* ignore */ } });
      offs.length = 0;
      toast.dispose();
      setup.dispose();
      if (portraits) portraits.dispose();
      if (practice.active) { try { practice.exit(); } catch (err) { /* ignore */ } }
      multi.close();
      world.dispose();
      ui.dispose();
    },
  };
}

export default install;
