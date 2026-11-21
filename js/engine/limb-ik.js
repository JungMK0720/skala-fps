/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 팔·다리 두 마디 IK(순수 수학). 어깨(엉덩이)에서 손목(발)까지 목표에 닿게 팔꿈치(무릎) 위치를 구한다. three.js 없이 node에서 시험한다.
 */
/*
 *   solveTwoBone(root, target, a, b, pole) → { mid, end, reach }
 *     root·target·pole = [x, y, z]. a = 위 마디 길이, b = 아래 마디 길이.
 *     pole은 팔꿈치(무릎)가 향할 쪽(방향 벡터). 목표가 너무 멀면 팔을 곧게 펴서 그쪽으로 뻗고 reach = false.
 *     mid = 팔꿈치(무릎) 위치, end = 손목(발) 위치(닿으면 target과 같다).
 */

const sub = (p, q) => [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
const dot = (p, q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
const len = (p) => Math.hypot(p[0], p[1], p[2]);

/** 길이 1로(0 벡터면 fallback) */
export function unit(p, fallback = [0, -1, 0]) {
  const l = len(p);
  return l > 1e-9 ? [p[0] / l, p[1] / l, p[2] / l] : [fallback[0], fallback[1], fallback[2]];
}

/** p에서 n 방향 성분을 뺀 단위 벡터. 거의 나란하면 n에 수직인 아무 방향 */
function perpendicular(p, n) {
  const d = dot(p, n);
  const q = [p[0] - n[0] * d, p[1] - n[1] * d, p[2] - n[2] * d];
  if (len(q) > 1e-6) return unit(q);
  const alt = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 0, 1];
  const e = dot(alt, n);
  return unit([alt[0] - n[0] * e, alt[1] - n[1] * e, alt[2] - n[2] * e]);
}

export function solveTwoBone(root, target, a, b, pole) {
  const toT = sub(target, root);
  const dist = len(toT);
  const n = unit(toT, [0, -1, 0]);
  const lo = Math.abs(a - b) + 1e-4, hi = a + b - 1e-4;
  const d = Math.min(hi, Math.max(lo, dist));
  // 코사인 법칙: 위 마디가 목표 방향과 이루는 각
  const cosA = Math.min(1, Math.max(-1, (a * a + d * d - b * b) / (2 * a * d)));
  const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
  const m = perpendicular(pole, n);
  const mid = [
    root[0] + n[0] * a * cosA + m[0] * a * sinA,
    root[1] + n[1] * a * cosA + m[1] * a * sinA,
    root[2] + n[2] * a * cosA + m[2] * a * sinA
  ];
  const end = [root[0] + n[0] * d, root[1] + n[1] * d, root[2] + n[2] * d];
  return { mid, end, reach: dist <= a + b && dist >= Math.abs(a - b) };
}
