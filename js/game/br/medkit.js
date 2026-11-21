/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 배틀로얄 구급상자 사용(채널링). 4초 동안 진행 막대를 채우고, 다 차면 체력을 한 번 회복한다. 도중에 사격·무기 교체·점프·E를 다시 누르면
 *          취소되고 구급상자는 쓰지 않은 것으로 남는다. 사용 중에는 사격·조준·재장전을 막고 걷기만 40% 속도로 된다.
 *          사람(br/kit.js)과 봇(br/solo.js)이 같은 규칙을 쓴다. three.js·DOM 없이 node 테스트에서 그대로 쓴다
 */

/** 사용 시간(ms) · 회복량 · 사용 중 이동 속도 배율 */
export const MEDKIT = Object.freeze({ ms: 4000, heal: 40, walkMul: 0.4 });

/**
 * 채널링 하나. start → step(dtMs)을 반복하다 다 차면 step이 true를 한 번 돌려준다(그때 구급상자를 쓰고 회복한다).
 * cancel은 아무것도 쓰지 않는다
 * @param {number} [ms]
 */
export function createChannel(ms = MEDKIT.ms) {
  let t = -1;
  return {
    get active() { return t >= 0; },
    /** 0~1 진행. 쓰고 있지 않으면 null */
    get progress() { return t < 0 ? null : Math.min(1, t / ms); },
    /** 시작 → 새로 시작했으면 true(이미 쓰는 중이면 false) */
    start() {
      if (t >= 0) return false;
      t = 0;
      return true;
    },
    /** 취소 → 쓰던 중이었으면 true */
    cancel() {
      if (t < 0) return false;
      t = -1;
      return true;
    },
    /** dtMs만큼 진행. 이번에 다 찼으면 true(채널은 끝난다) */
    step(dtMs) {
      if (t < 0) return false;
      t += Number.isFinite(dtMs) && dtMs > 0 ? dtMs : 0;
      if (t + 1e-6 < ms) return false;
      t = -1;
      return true;
    }
  };
}

/**
 * 사용 중 무기 입력 거르기(사람). 사격을 새로 누르거나(firePressed) 무기를 바꾸면(slot·wheel) 취소 신호를 내고 그 입력은 그대로 지나간다.
 * 누르고 있는 사격·조준·재장전은 막는다. wi를 고쳐서 돌려준다 → { wi, cancel }
 */
export function channelInput(wi) {
  const cancel = !!(wi.firePressed || wi.slot || wi.wheel);
  if (!cancel) {
    wi.fireDown = false;
    wi.firePressed = false;
  }
  wi.zoomDown = false;
  wi.zoomToggle = false;
  wi.reloadPressed = false;
  return { wi, cancel };
}

/**
 * 봇이 구급상자를 쓰기 시작해도 되는가: 살아 있고, 구급상자가 있고, 체력이 기준 이하이며, 보이는 적(두뇌의 표적)이 없고 최근에 맞지 않았을 때.
 * @param {{ alive?:boolean, hp:number, medkits:number, healHp:number, targetId?:any, hurt?:boolean, channelling?:boolean }} s
 */
export function botMayStartHeal(s) {
  return s.alive !== false && !s.channelling && s.medkits > 0 && s.hp <= s.healHp && s.hp < 100 && s.targetId == null && !s.hurt;
}

/** 봇이 쓰던 구급상자를 멈춰야 하는가: 적이 보이거나(표적이 생겼다) 맞았을 때 */
export function botMustCancelHeal(s) {
  return s.targetId != null || !!s.hurt;
}

/** 봇 무기 입력 거르기: 구급상자를 쓰는 동안 쏘지도, 조준·재장전·교체도 하지 않는다 → wi */
export function botChannelInput(wi) {
  wi.fireDown = false;
  wi.firePressed = false;
  wi.zoomDown = false;
  wi.reloadPressed = false;
  wi.slot = null;
  wi.wheel = 0;
  return wi;
}
