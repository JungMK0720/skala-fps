/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: CrazyGames HTML5 SDK v3 구현. SDK 스크립트를 불러와 초기화하고 로딩·게임플레이 신호, 광고, 채팅·음소거 설정, 초대 링크를 잇는다.
 *          SDK가 막히거나 실패해도 예외를 밖으로 내지 않고 우리 도메인과 똑같이 돈다(모든 호출이 조용히 무시된다).
 */
/**
 * 공식 문서(docs.crazygames.com/sdk): 스크립트 https://sdk.crazygames.com/crazygames-sdk-v3.js → await SDK.init().
 *   environment: 'local'(localhost·?useLocalSdk=true, 광고 대신 안내 글자) | 'crazygames' | 'disabled'(다른 도메인, 모든 호출이 오류).
 *   game.loadingStart/Stop, game.gameplayStart/Stop, game.settings { disableChat, muteAudio } + addSettingsChangeListener,
 *   ad.requestAd('midgame'|'rewarded', { adStarted, adFinished, adError }), ad.hasAdblock(),
 *   game.inviteLink(params), game.getInviteParam(name), game.updateRoom(...), game.leftRoom(), game.addJoinRoomListener(fn).
 */

export const SDK_URL = 'https://sdk.crazygames.com/crazygames-sdk-v3.js';
const LOAD_TIMEOUT_MS = 8000;   // 스크립트·초기화 각각. 넘으면 SDK 없이 간다
const AD_TIMEOUT_MS = 120000;   // 광고 콜백이 끝내 오지 않을 때 게임을 풀어 주는 안전장치

const sdk = () => (typeof window !== 'undefined' && window.CrazyGames && window.CrazyGames.SDK) || null;

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    Promise.resolve(promise).then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

/** SDK 스크립트를 붙인다. 정적 태그(포털 빌드)로 이미 있으면 그대로 쓴다 */
function loadScript() {
  if (sdk()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = SDK_URL;
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error('sdk script blocked'));
    document.head.append(el);
  });
}

/**
 * @param {{ adsEnabled?: boolean }} [opt] adsEnabled = 이 제출본에서 광고를 쓰는가(기본 출시는 끔, 정식 출시 빌드에서 켬)
 * @returns {import('./index.js').PlatformImpl}
 */
export function createCrazyGamesPlatform(opt = {}) {
  let ready = false;
  let environment = 'disabled';
  let settings = { disableChat: false, muteAudio: false };
  let adblock = false;
  let initPromise = null;
  const settingsFns = new Set();
  const joinFns = new Set();

  /** SDK 호출. 준비 전이거나 오류면 조용히 넘어간다 */
  const call = (fn, fallback = undefined) => {
    if (!ready) return fallback;
    try { return fn(sdk()); } catch (err) { console.warn('[platform] SDK 호출 실패', err); return fallback; }
  };

  async function init() {
    if (initPromise) return initPromise;
    initPromise = (async () => {
      try {
        await withTimeout(loadScript(), LOAD_TIMEOUT_MS);
        const S = sdk();
        if (!S) return false;
        await withTimeout(S.init(), LOAD_TIMEOUT_MS);
        environment = S.environment || 'disabled';
        if (environment === 'disabled') return false;   // 다른 도메인: 모든 호출이 오류를 내므로 쓰지 않는다
        ready = true;
        settings = Object.assign({}, settings, S.game.settings || {});
        S.game.addSettingsChangeListener((next) => {
          settings = Object.assign({}, settings, next || {});
          for (const fn of [...settingsFns]) { try { fn(settings); } catch (e) { console.error(e); } }
        });
        S.game.addJoinRoomListener((params) => {
          for (const fn of [...joinFns]) { try { fn(params || {}); } catch (e) { console.error(e); } }
        });
        try { adblock = !!(await withTimeout(S.ad.hasAdblock(), LOAD_TIMEOUT_MS)); } catch (e) { adblock = false; }
        console.info('[platform] CrazyGames SDK ready', environment);
        return true;
      } catch (err) {
        console.warn('[platform] CrazyGames SDK를 쓸 수 없어 SDK 없이 진행합니다', err && err.message ? err.message : err);
        ready = false;
        return false;
      }
    })();
    return initPromise;
  }

  /**
   * 광고 하나를 요청한다. hooks.start는 광고가 실제로 시작될 때(음소거·입력 정지), hooks.end는 시작했던 광고가 끝났을 때 부른다.
   * @returns {Promise<{ok:boolean, code?:string}>} ok = adFinished
   */
  function requestAd(type, hooks = {}) {
    if (!ready) return Promise.resolve({ ok: false, code: 'unavailable' });
    return new Promise((resolve) => {
      let started = false, settled = false;
      const finish = (ok, code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (started && hooks.end) hooks.end();
        resolve(ok ? { ok: true } : { ok: false, code: code || 'other' });
      };
      const timer = setTimeout(() => finish(false, 'timeout'), AD_TIMEOUT_MS);
      try {
        sdk().ad.requestAd(type, {
          adStarted: () => { if (!settled && !started) { started = true; if (hooks.start) hooks.start(); } },
          adFinished: () => finish(true),
          adError: (error) => finish(false, error && error.code)
        });
      } catch (err) {
        finish(false, 'other');
      }
    });
  }

  return {
    id: 'crazygames',
    isPortal: true,
    init,
    get ready() { return ready; },
    get environment() { return environment; },
    get chatAllowed() { return !settings.disableChat; },
    get muted() { return !!settings.muteAudio; },
    /** local 환경은 광고 대신 SDK가 안내 글자를 띄우므로 연습용으로 켠다 */
    get adsEnabled() { return ready && (environment === 'local' || !!opt.adsEnabled); },
    get adblock() { return adblock; },
    loadingStart: () => call((S) => S.game.loadingStart()),
    loadingStop: () => call((S) => S.game.loadingStop()),
    gameplayStart: () => call((S) => S.game.gameplayStart()),
    gameplayStop: () => call((S) => S.game.gameplayStop()),
    happytime: () => call((S) => S.game.happytime()),
    requestAd,
    inviteLink: (params) => call((S) => S.game.inviteLink(params), null),
    inviteParam: (name) => call((S) => S.game.getInviteParam(name), null),
    updateRoom: (room) => call((S) => S.game.updateRoom(room)),
    leftRoom: () => call((S) => S.game.leftRoom()),
    onSettings(fn) { settingsFns.add(fn); return () => settingsFns.delete(fn); },
    onJoinRoom(fn) { joinFns.add(fn); return () => joinFns.delete(fn); }
  };
}
