/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 플랫폼 신호를 게임에 잇는다. 실제로 조작 중인지(맵이 떠 있고 결과·일시정지·불러오기 화면이 아님)를 보고 gameplayStart/Stop을 보내고,
 *          광고가 재생되는 동안 소리와 입력을 멈추며, SDK의 음소거 설정을 게임 볼륨보다 앞세운다. game/index.js가 install 때 부른다.
 */
import { platform } from './index.js';

const GAME_SCREENS = new Set(['sandbox', 'match']);
const POLL_MS = 250;

/**
 * @param {{ ctx:object, ui:object, world:object }} deps
 * @returns {() => void} 정리 함수
 */
export function wirePlatform({ ctx, ui, world }) {
  const { bus, settings, input } = ctx;
  const audio = () => (world && world.internals ? world.internals.audio : null);
  let adPlaying = false;

  /** 볼륨: 광고 중이거나 SDK가 음소거를 원하면 0, 아니면 설정 값 */
  function applyVolume() {
    const a = audio();
    if (!a || typeof a.setVolume !== 'function') return;
    const v = Number(settings.get('volume'));
    a.setVolume(adPlaying || platform.muted ? 0 : (Number.isFinite(v) ? v : 0.8));
  }

  /** 지금 플레이어가 게임을 조작하는 중인가 */
  function playingNow() {
    if (adPlaying || !GAME_SCREENS.has(ctx.screen) || ctx.loading) return false;
    if (!world || !world.active || world.paused) return false;
    return !(ui.isVisible('results') || ui.isVisible('pause'));
  }
  function syncGameplay() {
    if (playingNow()) platform.gameplayStart(); else platform.gameplayStop();
  }

  platform.setAdHooks({
    pause() {
      adPlaying = true;
      input.exitLock();
      input.setEnabled(false);
      applyVolume();
      syncGameplay();
    },
    resume() {
      // 입력은 다시 포인터를 잠글 때 main.js(input:lock)가 켠다. 광고는 판 사이(결과 화면)에서만 나온다
      adPlaying = false;
      applyVolume();
      syncGameplay();
    }
  });

  const timer = setInterval(syncGameplay, POLL_MS);
  const offs = [
    // world가 먼저 볼륨을 설정에 맞춘 뒤 여기서 음소거를 다시 앞세운다(구독 순서)
    bus.on('settings:change', (e) => { if (!e || e.key === 'volume' || e.key === '*') applyVolume(); }),
    bus.on('screen:change', syncGameplay),
    platform.onChange(applyVolume)
  ];
  applyVolume();

  return () => {
    clearInterval(timer);
    offs.forEach((off) => { try { off(); } catch (e) { /* 무시 */ } });
    platform.setAdHooks(null);
    platform.gameplayStop();
  };
}
