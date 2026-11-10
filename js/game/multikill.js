/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 연속 킬 규칙(순수 모듈). 내가 적을 처치한 뒤 5초 안에 또 처치하면 이어서 세고, 2킬부터 헥사 킬(6)까지 단계 이름을 붙인다.
 *          7킬부터는 모두 '당신은 전설입니다'다. 표시(hud.multiKill)와 소리(audio.voice)는 game/world.js가 맡는다.
 */

/** 앞 킬에서 이 시간(ms) 안에 다음 킬을 내면 이어진다. 딱 5초도 이어진다 */
export const MULTI_KILL_WINDOW_MS = 5000;

/**
 * 단계표. count = 이어진 킬 수(legend는 그 이상 모두), id = 안내 음성 파일 이름(audio/voice/<id>.mp3)이자 그림 이름.
 * 음성 문장은 tools/make-voice.mjs의 VOICE_LINES에 있다(같은 id).
 */
export const MULTI_KILL_TIERS = Object.freeze([
  Object.freeze({ count: 2, id: 'double', title: '더블 킬!' }),
  Object.freeze({ count: 3, id: 'triple', title: '트리플 킬!' }),
  Object.freeze({ count: 4, id: 'quadra', title: '쿼드라 킬!' }),
  Object.freeze({ count: 5, id: 'penta', title: '펜타 킬!' }),
  Object.freeze({ count: 6, id: 'hexa', title: '헥사 킬!' }),
  Object.freeze({ count: 7, id: 'legend', title: '당신은 전설입니다' })
]);
const TOP = MULTI_KILL_TIERS[MULTI_KILL_TIERS.length - 1];

/** 이어진 킬 수 → 단계(2 미만이면 null, 7 이상은 legend) */
export function multiKillTier(count) {
  const n = Math.floor(Number(count));
  if (!(n >= 2)) return null;
  return n >= TOP.count ? TOP : MULTI_KILL_TIERS[n - 2];
}

/**
 * 연속 킬 세기. 시각은 같은 시계로만 넘긴다(World 시뮬레이션 시각: 연습장 일시정지 중에는 멈춘다).
 * kill(t) → 이번 킬까지 이어진 수(첫 킬 1). reset() → 처음부터(내가 죽거나 판·맵이 바뀔 때).
 */
export function createMultiKill({ windowMs = MULTI_KILL_WINDOW_MS } = {}) {
  let count = 0, last = -Infinity;
  return {
    kill(t) {
      const now = Number(t);
      if (!Number.isFinite(now)) return count;
      // 시계가 거꾸로 가면(맵을 다시 불러 시계가 처음부터 등) 이어지지 않은 것으로 본다
      count = now >= last && now - last <= windowMs ? count + 1 : 1;
      last = now;
      return count;
    },
    reset() { count = 0; last = -Infinity; },
    get count() { return count; }
  };
}
