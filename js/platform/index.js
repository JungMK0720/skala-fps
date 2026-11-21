/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 게임이 쓰는 플랫폼 창구 하나. 우리 도메인이면 아무것도 하지 않는 기본 구현(web.js), CrazyGames 안이면 SDK 구현(crazygames.js)을 고른다.
 *          로딩·게임플레이 신호의 중복을 거르고, 광고를 판 사이에만 보여 주며(3분 간격), 광고 중에는 화면을 막고 소리·입력을 멈춘다.
 */
/**
 * 사용법(docs/PORTAL.md)
 *   import { platform } from '../platform/index.js';
 *   platform.isPortal            CrazyGames 안인가(페이지를 열 때 정해진다)
 *   platform.chatAllowed         채팅을 보여 줘도 되는가(SDK 설정 disableChat)
 *   platform.muted               SDK가 소리를 끄라고 했는가(muteAudio). 게임 볼륨 설정보다 앞선다
 *   await platform.init()        SDK를 불러와 초기화한다. 실패해도 false로 끝난다(예외 없음)
 *   platform.loadingStart/Stop() · platform.gameplayStart/Stop()   같은 상태를 두 번 보내지 않는다
 *   await platform.midgameAd()   판과 판 사이에서만. 게임 중이면 부르지 않고 false. 마지막 광고 뒤 3분 안이면 false
 *   await platform.rewardedAd()  보상 광고를 끝까지 봤으면 true(adFinished). 오류·없음·차단이면 false
 *   platform.rewardedAvailable   보상 광고 단추를 보여 줘도 되는가 · platform.rewardedBlocked 광고 차단기 때문에 못 쓰는가
 *   platform.inviteLink(roomId)  CrazyGames 초대 링크 | null
 *   platform.setAdHooks({ pause, resume })   광고가 실제로 시작·끝날 때 부를 함수(소리·입력)
 *   platform.onChange(fn)        채팅·음소거 설정이나 초기화 결과가 바뀌면
 *
 * 포털 판별(detectPortal): ?portal=crazygames(우리 도메인을 iframe으로 제출할 때 주소에 붙인다) ·
 *   SKALA_CONFIG.portal.id = 'crazygames'(tools/build-site.mjs --portal crazygames가 넣는다) · 주소가 crazygames.com 또는 그 하위 도메인.
 * 광고 사용: SKALA_CONFIG.portal.ads = 'on' 또는 ?ads=1(정식 출시 제출본). 기본 출시(Basic Launch)는 광고가 꺼져 있어 단추를 숨긴다.
 */
import { createWebPlatform } from './web.js';
import { createCrazyGamesPlatform } from './crazygames.js';
import { t } from '../core/i18n.js';

/** 중간 광고 최소 간격(ms). SDK도 3분 간격을 지키지만 화면을 막는 깜빡임을 줄이려고 여기서도 거른다 */
export const MIDGAME_GAP_MS = 180000;

/**
 * @param {{hostname?:string, search?:string, config?:object}} where
 * @returns {''|'crazygames'}
 */
export function detectPortal({ hostname = '', search = '', config = null } = {}) {
  const q = new URLSearchParams(search || '');
  if (q.get('portal') === 'crazygames') return 'crazygames';
  if (config && config.portal && config.portal.id === 'crazygames') return 'crazygames';
  const host = String(hostname || '').toLowerCase();
  if (host === 'crazygames.com' || host.endsWith('.crazygames.com')) return 'crazygames';
  return '';
}

/** 이 제출본에서 광고를 쓰는가 */
export function adsWanted({ search = '', config = null } = {}) {
  const q = new URLSearchParams(search || '');
  return q.get('ads') === '1' || !!(config && config.portal && config.portal.ads === 'on');
}

/** 광고를 요청하는 동안 화면을 막는 판(요청에는 몇 초가 걸린다. 문서: adFinished/adError까지 UI를 막을 것) */
function createAdBlocker() {
  let el = null;
  return {
    show() {
      if (typeof document === 'undefined' || el) return;
      el = document.createElement('div');
      el.className = 'pf-ad-block';
      el.setAttribute('role', 'status');
      el.textContent = t('portal.adOverlay');
      Object.assign(el.style, {
        position: 'fixed', inset: '0', zIndex: '2147483000', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(5,8,12,0.72)', color: '#D8E1EA', font: '600 14px/1.4 system-ui, sans-serif', letterSpacing: '0.08em',
        textTransform: 'uppercase', pointerEvents: 'auto'
      });
      document.body.append(el);
    },
    /** 광고가 실제로 시작되면 SDK가 자기 화면을 띄우므로 우리 글자는 지운다(판은 남겨 입력을 막는다) */
    quiet() { if (el) el.textContent = ''; },
    hide() { if (el) { el.remove(); el = null; } }
  };
}

/**
 * 구현 위에 공통 규칙을 얹는다(시험에서 가짜 구현을 넣을 수 있게 따로 둔다).
 * @param {PlatformImpl} impl
 * @param {{ now?:()=>number, blocker?:{show():void, hide():void} }} [opt]
 */
export function createPlatform(impl, opt = {}) {
  const now = opt.now || (() => Date.now());
  const blocker = opt.blocker || createAdBlocker();
  let playing = false, loading = false, adBusy = false;
  let lastAdAt = -Infinity;
  let lastAdError = null;
  let hooks = { pause() {}, resume() {} };
  const changeFns = new Set();
  const notify = () => { for (const fn of [...changeFns]) { try { fn(api); } catch (e) { console.error(e); } } };
  impl.onSettings(notify);

  async function runAd(type) {
    adBusy = true;
    blocker.show();
    let result;
    try {
      console.info(`[platform] ${type} ad requested`);
      result = await impl.requestAd(type, {
        start: () => { if (blocker.quiet) blocker.quiet(); try { hooks.pause(type); } catch (e) { console.error(e); } },
        end: () => { try { hooks.resume(type); } catch (e) { console.error(e); } }
      });
    } catch (err) {
      result = { ok: false, code: 'other' };
    } finally {
      blocker.hide();
      adBusy = false;
    }
    lastAdError = result.ok ? null : result.code || 'other';
    console.info(`[platform] ${type} ad ${result.ok ? 'finished' : 'not shown: ' + lastAdError}`);
    return result;
  }

  const api = {
    get id() { return impl.id; },
    get isPortal() { return impl.isPortal; },
    get ready() { return impl.ready; },
    get chatAllowed() { return impl.chatAllowed; },
    get muted() { return impl.muted; },
    get playing() { return playing; },
    get adActive() { return adBusy; },
    get lastAdError() { return lastAdError; },
    /** 보상 광고 단추를 보여 줘도 되는가: 광고를 쓰는 제출본이고 차단기가 없다 */
    get rewardedAvailable() { return impl.adsEnabled && !impl.adblock; },
    /** 광고 차단기 때문에 보상 광고를 못 쓴다(단추 대신 안내를 보여 준다) */
    get rewardedBlocked() { return impl.adsEnabled && impl.adblock; },
    async init() {
      const ok = await impl.init().catch(() => false);
      notify();
      return ok;
    },
    loadingStart() { if (!loading) { loading = true; impl.loadingStart(); } },
    loadingStop() { if (loading) { loading = false; impl.loadingStop(); } },
    gameplayStart() { if (!playing) { playing = true; impl.gameplayStart(); } },
    gameplayStop() { if (playing) { playing = false; impl.gameplayStop(); } },
    /** 판 사이 중간 광고. 보여 줬으면 true */
    async midgameAd() {
      if (!impl.adsEnabled || adBusy || playing) return false;
      if (now() - lastAdAt < MIDGAME_GAP_MS) return false;
      lastAdAt = now();
      return (await runAd('midgame')).ok;
    },
    /** 보상 광고. 끝까지 봤으면 true. 직후에는 중간 광고를 잇지 않는다(광고 연달아 보여 주기 금지) */
    async rewardedAd() {
      if (!api.rewardedAvailable || adBusy || playing) return false;
      const r = await runAd('rewarded');
      lastAdAt = now();
      return r.ok;
    },
    happytime() { impl.happytime(); },
    inviteLink(roomId) { return roomId ? impl.inviteLink({ roomId: String(roomId) }) : null; },
    /** 초대 링크로 들어왔으면 그 방 id */
    inviteRoomId() { return impl.inviteParam('roomId'); },
    updateRoom(room) { impl.updateRoom(room); },
    leftRoom() { impl.leftRoom(); },
    onJoinRoom(fn) { return impl.onJoinRoom(fn); },
    setAdHooks(next) { hooks = { pause: (next && next.pause) || (() => {}), resume: (next && next.resume) || (() => {}) }; },
    onChange(fn) { changeFns.add(fn); return () => changeFns.delete(fn); }
  };
  return api;
}

function pickImpl() {
  if (typeof window === 'undefined' || typeof location === 'undefined') return createWebPlatform();
  const where = { hostname: location.hostname, search: location.search, config: window.SKALA_CONFIG || null };
  return detectPortal(where) === 'crazygames' ? createCrazyGamesPlatform({ adsEnabled: adsWanted(where) }) : createWebPlatform();
}

/** 게임 전체가 쓰는 하나뿐인 플랫폼 */
export const platform = createPlatform(pickImpl());

/**
 * @typedef {object} PlatformImpl
 * @property {string} id
 * @property {boolean} isPortal
 * @property {() => Promise<boolean>} init
 * @property {boolean} ready
 * @property {boolean} chatAllowed
 * @property {boolean} muted
 * @property {boolean} adsEnabled
 * @property {boolean} adblock
 * @property {(type:'midgame'|'rewarded', hooks:{start?:Function, end?:Function}) => Promise<{ok:boolean, code?:string}>} requestAd
 */
