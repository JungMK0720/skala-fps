/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 낙하 피해 곡선과 낙하 높이 추적기. 점프·낙하의 가장 높은 지점에서 착지 지점까지의 높이로 피해를 정한다(배틀로얄, MODES.md 15절).
 *          three.js·DOM 의존 없음. 로컬 플레이어(engine/player.js)와 연습장 봇(game/practice.js)이 같이 쓴다.
 */
/**
 * 곡선: 4 m 이하 0 → 4~12 m 직선으로 0~100 → 12 m 이상 100(즉사).
 *   한 층 ≈ 3 m라 2층 바닥(3 m)에서 뛰어내리면 0, 3층 바닥(6 m) 25, 4층 바닥(9 m) 62.5, 4층 건물 옥상(12 m 이상) 즉사.
 *
 *   const fall = createFallTracker(body.pos[1]);
 *   매 틱 이동 뒤: const r = fall.step(body.pos[1], body.onGround, wasGround);  // 착지 틱에만 { height, damage, exempt }, 아니면 null
 *   fall.exempt('pad' | 'portal')  // 지금 공중 구간(아직 땅이면 곧 시작될 공중 구간)의 착지를 면제한다
 *   fall.reset(y, floor?)          // 스폰·순간이동·턱 오르기 끝: 높이를 y에서 다시 잰다. floor를 주면 그 높이에서 잰다(넘기: 넘은 난간 높이는 세지 않는다)
 *
 * 면제: 발판으로 날아간 착지와 포털로 나온 뒤의 착지는 피해가 없다. 턱 오르기는 몸을 들어 올린 높이를 낙하로 세지 않도록
 *   끝난 자리에서 높이를 다시 잰다. 넘기로 난간 너머에 떨어지면 난간을 넘기 전 발 높이(층 바닥)부터의 높이만 센다
 *   (2층 발코니 난간을 넘어 뛰어내려도 바닥 3.3 m 기준이라 피해 없음).
 */

export const FALL = Object.freeze({
  SAFE: 4,      // 이 높이(m)까지는 피해 없음
  LETHAL: 12,   // 이 높이(m)부터 즉사
  MAX: 100      // 즉사 피해
});

/** 낙하 높이(m) → 피해(소수 그대로, 반올림은 받는 쪽이 한다) */
export function fallDamage(height) {
  const h = Number(height);
  if (!(h > FALL.SAFE)) return 0;
  if (h >= FALL.LETHAL) return FALL.MAX;
  return ((h - FALL.SAFE) / (FALL.LETHAL - FALL.SAFE)) * FALL.MAX;
}

// 면제 표시는 땅에 이만큼(틱) 붙어 있으면 잊는다. 발판이 이번 틱에 속도를 넣고 다음 틱에 땅을 떠나는 순서를 견딘다
const EXEMPT_GROUND_TICKS = 3;

export function createFallTracker(y0 = 0) {
  let apex = Number.isFinite(y0) ? y0 : 0;
  let credit = 0;            // 넘기 뒤 첫 착지에서 빼 주는 높이(난간 윗면 − 넘기 전 바닥)
  let exempt = null;
  let exemptGround = 0;
  return {
    step(y, onGround, wasGround) {
      if (!Number.isFinite(y)) return null;
      if (!onGround) {
        apex = Math.max(apex, y);
        return null;
      }
      if (wasGround) {
        apex = y;
        credit = 0;
        if (exempt && ++exemptGround > EXEMPT_GROUND_TICKS) exempt = null;
        return null;
      }
      // 착지
      const height = Math.max(0, apex - y - credit);
      const why = exempt;
      apex = y;
      credit = 0;
      exempt = null;
      return { height, damage: why ? 0 : fallDamage(height), exempt: why };
    },
    exempt(reason = 'pad') { exempt = String(reason || 'pad'); exemptGround = 0; },
    reset(y, floor) {
      if (!Number.isFinite(y)) return;
      apex = y;
      credit = Number.isFinite(floor) && floor < y ? y - floor : 0;
      exempt = null;
    },
    get apex() { return apex; },
    get exempted() { return exempt; }
  };
}
