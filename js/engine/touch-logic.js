/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 터치 조작의 계산(순수 함수). 터치 기기 판별, 조이스틱 입력을 8방향 이동으로 바꾸기, 화면의 어느 쪽을 눌렀는지 판단한다.
 *          DOM에 의존하지 않아 node 테스트에서 그대로 쓴다. 화면과 이벤트는 engine/touch.js가 맡는다.
 */
export const TOUCH = Object.freeze({
  STICK_RADIUS: 56,   // 조이스틱 반지름(px). 이만큼 밀면 최대다
  DEADZONE: 0.2,      // 이 비율 안쪽은 멈춤
  WALK_BELOW: 0.55,   // 이 비율보다 덜 밀면 천천히 걷는다(Shift 걷기와 같다)
  DIAGONAL: 0.38,     // sin(22.5°). 축에서 이만큼 벗어나면 그 방향도 함께 누른 것으로 친다
  STICK_SIDE: 0.42,   // 화면 왼쪽 이 비율 안에서 누르면 조이스틱, 나머지는 시점
  LOOK_SCALE: 1.7,    // 손가락 1 px을 마우스 몇 px로 볼지. 화면이 좁아 마우스보다 크게 돈다
});

const STILL = Object.freeze({ x: 0, y: 0, mag: 0, forward: false, back: false, left: false, right: false, walk: false });

/**
 * 터치 조작을 켤지 정한다. ?touch=1은 켜고 ?touch=0은 끈다.
 * 값이 없으면 주 입력이 손가락이고 터치 지점이 있을 때만 켠다. 터치스크린 노트북은 주 입력이 마우스라 켜지 않는다.
 * @param {{ flag?: string|null, coarse?: boolean, maxTouchPoints?: number }} o
 */
export function detectTouch({ flag = null, coarse = false, maxTouchPoints = 0 } = {}) {
  if (flag === '1') return true;
  if (flag === '0') return false;
  return !!coarse && maxTouchPoints > 0;
}

/**
 * 조이스틱을 민 거리(px, 화면 좌표: 오른쪽 +, 아래 +) → 움직임.
 * @returns {{ x:number, y:number, mag:number, forward:boolean, back:boolean, left:boolean, right:boolean, walk:boolean }}
 *   x·y는 -1..1, mag는 0..1이다. 데드존 안쪽이면 모두 0과 false다.
 */
export function stickState(dx, dy, o = TOUCH) {
  const d = Math.hypot(dx, dy);
  if (!Number.isFinite(d) || d <= 0) return STILL;
  const mag = Math.min(1, d / o.STICK_RADIUS);
  if (mag <= o.DEADZONE) return STILL;
  const nx = dx / d, ny = dy / d;
  return {
    x: nx * mag, y: ny * mag, mag,
    forward: ny < -o.DIAGONAL, back: ny > o.DIAGONAL, left: nx < -o.DIAGONAL, right: nx > o.DIAGONAL,
    walk: mag < o.WALK_BELOW,
  };
}

/** 조이스틱 손잡이를 그릴 위치. 반지름 밖으로 나가지 않는다 */
export function knobOffset(dx, dy, o = TOUCH) {
  const d = Math.hypot(dx, dy);
  if (!Number.isFinite(d) || d <= o.STICK_RADIUS) return { x: Number.isFinite(dx) ? dx : 0, y: Number.isFinite(dy) ? dy : 0 };
  return { x: (dx / d) * o.STICK_RADIUS, y: (dy / d) * o.STICK_RADIUS };
}

/** 이 자리를 누르면 조이스틱인가(아니면 시점) */
export function isStickSide(x, width, o = TOUCH) {
  return x < width * o.STICK_SIDE;
}
