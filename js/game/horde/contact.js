/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 좀비 몸에 닿는 계산(순수 함수). 날아가는 검기가 닿는 좀비와 그 거리, 벽에 막히기 전까지 날 수 있는 거리, C4가 좀비 몸에 붙을 자리를 구한다.
 *          three.js·DOM에 의존하지 않아 화면(horde/view.js·World)과 node 시험이 같이 쓴다.
 */
/**
 * 좀비 z = { x, y, z, yaw, s, low } — 화면에 그린 자리(발 = y). yaw는 모형 회전(정면 = 로컬 -z를 Y축으로 yaw만큼 돌린 쪽),
 * s는 크기 배율, low는 기어 다니는 좀비. 몸은 세로 원기둥으로 본다(view.js touching과 같은 크기):
 *   서 있는 좀비 반지름 0.32·s · 높이 1.85·s, 기어 다니는 좀비 반지름 0.5·s · 높이 0.8·s
 */

const BODY_R = 0.32, BODY_R_LOW = 0.5;
const BODY_H = 1.85, BODY_H_LOW = 0.8;
/** C4가 붙는 높이(발에서, ·s): 서 있으면 가슴, 기어 다니면 등 */
export const C4_STICK_H = 1.1;
export const C4_STICK_H_LOW = 0.45;
/** 몸 중심에서 C4가 붙는 겉면까지(·s). 좀비 충돌 반지름보다 크지 않아 벽에 붙어 걷는 좀비의 C4도 벽 속으로 들어가지 않는다 */
const C4_SURF = 0.24, C4_SURF_LOW = 0.3;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const scaleOf = (z) => (z && z.s > 0 ? z.s : 1);

/**
 * 검기(반지름 r인 구)가 o에서 단위 방향 d로 거리 t0 → t1 구간을 지날 때 좀비 몸에 처음 닿는 거리.
 * 원기둥을 r만큼 부풀린 모양(위아래도 r)과 선분의 교차라 빠르게 지나가도 건너뛰지 않는다. 구간 시작에서 이미 닿아 있으면 t0.
 * @returns {number} t0 ≤ t ≤ t1, 닿지 않으면 -1
 */
export function waveHitT(ox, oy, oz, dx, dy, dz, t0, t1, z, r) {
  if (!z || !(t1 >= t0)) return -1;
  const s = scaleOf(z);
  const R = (z.low ? BODY_R_LOW : BODY_R) * s + r;
  const yLo = z.y - r, yHi = z.y + (z.low ? BODY_H_LOW : BODY_H) * s + r;
  let lo = t0, hi = t1;
  // 수평: |(o + d·t) - 좀비 축|² ≤ R²
  const px = ox - z.x, pz = oz - z.z;
  const A = dx * dx + dz * dz;
  const B = px * dx + pz * dz;
  const C = px * px + pz * pz - R * R;
  if (A < 1e-12) {
    if (C > 0) return -1;
  } else {
    const disc = B * B - A * C;
    if (disc < 0) return -1;
    const sq = Math.sqrt(disc);
    const e0 = (-B - sq) / A, e1 = (-B + sq) / A;
    if (e0 > lo) lo = e0;
    if (e1 < hi) hi = e1;
    if (lo > hi) return -1;
  }
  // 세로: yLo ≤ oy + dy·t ≤ yHi
  if (Math.abs(dy) < 1e-12) {
    if (oy < yLo || oy > yHi) return -1;
  } else {
    let u0 = (yLo - oy) / dy, u1 = (yHi - oy) / dy;
    if (u0 > u1) { const q = u0; u0 = u1; u1 = q; }
    if (u0 > lo) lo = u0;
    if (u1 < hi) hi = u1;
    if (lo > hi) return -1;
  }
  return lo;
}

/**
 * 검기가 거리 t에서 좀비에 닿았을 때 불꽃·피해 숫자를 띄울 자리: 검기 중심에서 좀비 쪽으로 r만큼(몸 겉면 가까이), 높이는 몸 안으로 자른다
 * @returns {number[]} [x, y, z] (out을 주면 거기에 쓴다)
 */
export function waveHitPoint(ox, oy, oz, dx, dy, dz, t, z, r, out = [0, 0, 0]) {
  const s = scaleOf(z);
  const cx = ox + dx * t, cy = oy + dy * t, cz = oz + dz * t;
  const hx = z.x - cx, hz = z.z - cz;
  const hd = Math.hypot(hx, hz);
  const k = hd > 1e-6 ? Math.min(r, hd) / hd : 0;
  out[0] = cx + hx * k;
  out[1] = clamp(cy, z.y + (z.low ? 0.15 : 0.5) * s, z.y + (z.low ? 0.7 : 1.7) * s);
  out[2] = cz + hz * k;
  return out;
}

/**
 * o에서 단위 방향 d로 range까지 가는 동안 벽에 막히지 않는 거리(시선 los(a, b) → true = 가리는 것 없음).
 * 끝까지 보이면 range, 아니면 반으로 나눠 찾는다(steps번, range/2^steps 정밀도). los가 없으면 range
 */
export function losReach(los, o, d, range, steps = 7) {
  const max = Number.isFinite(range) && range > 0 ? range : 0;
  if (typeof los !== 'function' || !max) return max;
  const at = (t) => [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t];
  const clear = (t) => { try { return !!los(o, at(t)); } catch (e) { return false; } };
  if (clear(max)) return max;
  let lo = 0, hi = max;
  for (let i = 0; i < steps; i++) {
    const mid = (lo + hi) / 2;
    if (clear(mid)) lo = mid; else hi = mid;
  }
  return lo;
}

/**
 * C4가 좀비 z에 닿은 순간, 붙을 자리를 좀비 발 기준 로컬 오프셋으로 정한다(좀비가 돌면 함께 돈다).
 * 수류탄이 온 쪽(좀비 → 수류탄 수평 방향. 머리 위처럼 겹치면 날아온 반대 방향 -v, 그것도 없으면 좀비 정면)의 몸 겉면,
 * 높이는 C4_STICK_H·s(기어 다니는 좀비는 C4_STICK_H_LOW·s)
 * @param {number} gx, gy, gz  닿은 순간 수류탄 위치
 * @param {number} [vx], [vz]  그때 수류탄 수평 속도
 * @returns {{ x, y, z }} 로컬 오프셋(yaw를 되돌린 값)
 */
export function c4Offset(z, gx, gy, gz, vx = 0, vz = 0) {
  const s = scaleOf(z);
  const y = (z.low ? C4_STICK_H_LOW : C4_STICK_H) * s;
  const surf = (z.low ? C4_SURF_LOW : C4_SURF) * s;
  let hx = gx - z.x, hz = gz - z.z;
  let l = Math.hypot(hx, hz);
  if (!(l > 0.04)) { hx = -(+vx || 0); hz = -(+vz || 0); l = Math.hypot(hx, hz); }
  if (!(l > 1e-6)) return { x: 0, y, z: -surf };
  const wx = (hx / l) * surf, wz = (hz / l) * surf;
  const yaw = Number.isFinite(z.yaw) ? z.yaw : 0;
  const c = Math.cos(yaw), sn = Math.sin(yaw);
  // 월드 → 로컬: Y축 yaw 회전의 역
  return { x: wx * c - wz * sn, y, z: wx * sn + wz * c };
}

/**
 * 붙은 C4의 지금 월드 위치: 좀비 발 + yaw만큼 돌린 오프셋
 * @returns {number[]} [x, y, z] (out을 주면 거기에 쓴다)
 */
export function c4WorldPos(z, off, out = [0, 0, 0]) {
  const yaw = Number.isFinite(z.yaw) ? z.yaw : 0;
  const c = Math.cos(yaw), sn = Math.sin(yaw);
  out[0] = z.x + off.x * c + off.z * sn;
  out[1] = z.y + off.y;
  out[2] = z.z - off.x * sn + off.z * c;
  return out;
}
