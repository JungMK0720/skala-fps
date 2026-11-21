/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 우리 도메인에서 쓰는 기본 플랫폼. 포털 SDK가 없으니 모든 호출이 아무것도 하지 않고, 광고는 보여 주지 않는다.
 *          CrazyGames 구현(crazygames.js)과 같은 모양이라 게임 코드는 어느 쪽인지 몰라도 된다(platform/index.js).
 */

/** @returns {import('./index.js').PlatformImpl} */
export function createWebPlatform() {
  return {
    id: 'web',
    isPortal: false,
    async init() { return false; },
    get ready() { return false; },
    get chatAllowed() { return true; },
    get muted() { return false; },
    get adsEnabled() { return false; },
    get adblock() { return false; },
    loadingStart() {},
    loadingStop() {},
    gameplayStart() {},
    gameplayStop() {},
    /** 광고가 없으니 바로 끝난다 */
    async requestAd() { return { ok: false, code: 'unavailable' }; },
    inviteLink() { return null; },
    inviteParam() { return null; },
    updateRoom() {},
    leftRoom() {},
    happytime() {},
    onSettings() { return () => {}; },
    onJoinRoom() { return () => {}; }
  };
}
