/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 턱 오르기·넘기(맨틀·볼트). 점프를 누른 채 0.5~2.0 m 턱(벽·난간·창턱·컨테이너 끝)을 마주하면 앞을 살펴 올라설 자리나
 *          넘어갈 자리를 찾고, 짧은 동작(몸 들어 올리기 → 앞으로 넘기) 동안의 위치를 계산한다. three.js·DOM 의존 없음.
 */
/**
 *   const plan = findMantle(world, pos, dirX, dirZ, { radius, floor });   // null | plan
 *   plan = { kind: 'climb'|'vault', height, top, floor, from:[x,y,z], to:[x,y,z], lift:[x,y,z], crouch, dur, dirX, dirZ }
 *     floor  높이를 잰 바닥(땅이면 발 높이, 공중이면 발밑 바닥). 넘기 뒤 낙하 높이는 여기서 잰다(engine/falldamage.js)
 *     climb  턱 위에 올라선다(to.y = 턱 윗면, 끝나면 땅 위)
 *     vault  얇은 턱(난간·창턱·낮은 담)을 넘어 반대편 공중에 놓는다(그다음은 보통 낙하)
 *     crouch 끝 자리에 선 키(1.8 m)가 들어가지 않아 앉은 채로 끝난다
 *   mantlePose(plan, t, out) → t초 뒤의 발 위치(out), 끝났으면 true
 *
 * 높이 창: 발 기준 턱 윗면 MANTLE.MIN ~ MANTLE.MAX. 공중이면 opt.floor(발밑 바닥 높이) 기준으로 같은 창을 쓴다
 *   (뛰어서 더 높은 턱을 잡지 못하게: 바닥에서 2 m를 넘는 턱은 공중에서도 오르지 못한다).
 * 길 검사: 지금 자리에서 턱 높이로 몸을 들어 올릴 틈, 턱 위 CLEAR_H(창문을 지나는 높이)의 틈, 그 높이로 끝 자리까지 가는 길.
 * 이동 속도 검사(game/anticheat.js): 들어 올리는 속도가 점프 초속보다 느리도록 dur을 잡는다(2 m → 0.36초 상승 ≈ 5.6 m/s).
 */
import { PLAYER } from '../core/consts.js';
import { getGroundY, overlapsCapsule, canStand } from './physics.js';

export const MANTLE = Object.freeze({
  MIN: 0.5,          // 이보다 낮은 턱은 걷거나 점프로 넘는다(m)
  MAX: 2.0,          // 이보다 높은 턱은 오르지 못한다(m)
  REACH: 0.55,       // 몸 가장자리에서 앞으로 턱을 찾는 거리(m)
  CLEAR_H: 1.0,      // 넘어가는 동안 필요한 틈 높이(m). 창문(1 m 창턱 위 1.2~1.4 m 구멍)도 지난다
  THIN: 0.8,         // 턱 앞면에서 이 거리 안에 다시 낮아지면 얇은 턱(넘기)
  BASE_TIME: 0.3,    // 동작 시간 = BASE_TIME + PER_M × 높이
  PER_M: 0.15,
  LIFT_FRAC: 0.6,    // 동작 앞 60%는 들어 올리기, 나머지는 앞으로 넘기
  VAULT_ARC: 0.12    // 넘기는 동안 난간 위로 더 뜨는 높이(m)
});

const STEP_D = 0.05;          // 앞 살피기 간격(m)
const PROBE_R = 0.04;         // 바닥·틈을 재는 가는 기둥 반지름(m)
const DROP_EDGE = 0.25;       // 턱 윗면에서 이만큼 낮아지면 턱이 끝났다고 본다(m)

/** 가는 기둥(반지름 PROBE_R) 자리의 가장 높은 윗면(limit 이하) */
const topAt = (world, x, z, limit) => getGroundY(world, x, z, limit, PROBE_R);

/**
 * 앞(dirX, dirZ 단위 벡터)으로 오를 턱을 찾는다.
 * @param world createWorld 결과
 * @param pos 발 위치 [x,y,z]
 * @param [opt] { radius = PLAYER.RADIUS, floor = pos[1](공중이면 발밑 바닥), min, max, reach = MANTLE.REACH(달리면 더 멀리 본다) }
 * @returns plan | null
 */
export function findMantle(world, pos, dirX, dirZ, opt = {}) {
  if (!world || !pos) return null;
  const len = Math.hypot(dirX, dirZ);
  if (!(len > 1e-6)) return null;
  const dx = dirX / len, dz = dirZ / len;
  const r = opt.radius ?? PLAYER.RADIUS;
  const minH = opt.min ?? MANTLE.MIN, maxH = opt.max ?? MANTLE.MAX;
  const x = pos[0], feet = pos[1], z = pos[2];
  const base = Number.isFinite(opt.floor) ? Math.min(opt.floor, feet) : feet;
  const limit = base + maxH + 0.02;
  // 1) 턱 앞면: 발 기준 MIN 근처부터 MAX까지의 높이를 막는 것이 처음 나오는 거리
  const lowY = Math.max(feet, base + minH) - 0.06;
  const band = limit - lowY;
  if (!(band > 0.05)) return null;
  let front = -1;
  const reach = Math.max(0.1, opt.reach ?? MANTLE.REACH);
  for (let d = r + 0.02; d <= r + reach + 1e-9; d += STEP_D) {
    if (overlapsCapsule(world, x + dx * d, lowY, z + dz * d, PROBE_R, band)) { front = d; break; }
  }
  if (front < 0) return null;
  const fx = x + dx * (front + 0.06), fz = z + dz * (front + 0.06);
  const top = topAt(world, fx, fz, limit);
  const height = top - base;
  if (!(height >= minH - 0.02 && height <= maxH + 0.02) || top < feet - 0.05) return null;
  // 2) 턱 위 틈(창문 구멍 포함)과 지금 자리에서 들어 올릴 틈(천장)
  if (overlapsCapsule(world, fx, top, fz, PROBE_R, MANTLE.CLEAR_H)) return null;
  const bodyR = r - 0.06;
  if (overlapsCapsule(world, x, top, z, bodyR, MANTLE.CLEAR_H)) return null;
  // 3) 턱 두께: 앞면 뒤로 THIN 안에서 다시 낮아지는 자리
  let back = -1;
  for (let d = front + 0.1; d <= front + MANTLE.THIN + 1e-9; d += STEP_D) {
    if (topAt(world, x + dx * d, z + dz * d, top + 0.05) < top - DROP_EDGE) { back = d; break; }
  }
  const pathFree = (dist, y) => {
    for (let s = 0.2; s < dist; s += 0.2) {
      if (overlapsCapsule(world, x + dx * s, y, z + dz * s, bodyR, MANTLE.CLEAR_H)) return false;
    }
    return !overlapsCapsule(world, x + dx * dist, y, z + dz * dist, bodyR, MANTLE.CLEAR_H);
  };
  const plan = (kind, dist, y, crouch) => {
    const lift = Math.max(0, front - r - 0.02);
    return {
      kind, height, top, floor: base, crouch,
      from: [x, feet, z],
      lift: [x + dx * lift, top + (kind === 'vault' ? 0.02 : 0), z + dz * lift],
      to: [x + dx * dist, y, z + dz * dist],
      dur: MANTLE.BASE_TIME + MANTLE.PER_M * Math.max(0, top - feet),
      dirX: dx, dirZ: dz
    };
  };
  const standKind = (tx, ty, tz) => {
    if (canStand(world, tx, ty, tz)) return 'stand';
    if (canStand(world, tx, ty, tz, { height: PLAYER.CROUCH_HEIGHT })) return 'crouch';
    return null;
  };
  // 4) 넘기: 얇은 턱 너머 공중(턱 윗면 높이)에 몸이 들어갈 자리
  if (back >= 0) {
    const dist = back + r + 0.08;
    const y = top + 0.02;
    if (pathFree(dist, y) && !overlapsCapsule(world, x + dx * dist, y, z + dz * dist, r - 0.03, PLAYER.CROUCH_HEIGHT)) {
      return plan('vault', dist, y, !canStand(world, x + dx * dist, y, z + dz * dist));
    }
  }
  // 5) 오르기: 몸 전체가 턱 위에 올라선 자리. 얇은 턱이면 그 가운데에 선다
  const dist = back >= 0 ? Math.max(front + 0.06, (front + back) / 2) : front + r + 0.1;
  const tx = x + dx * dist, tz = z + dz * dist;
  const floorThere = getGroundY(world, tx, tz, top + 0.05, r - 0.01);
  if (Math.abs(floorThere - top) > 0.06) return null;
  const st = standKind(tx, top, tz);
  if (!st || !pathFree(dist, top)) return null;
  return plan('climb', dist, top, st === 'crouch');
}

const smooth = (k) => k * k * (3 - 2 * k);

/** t초 뒤의 발 위치를 out에 쓴다. 끝났으면 true */
export function mantlePose(plan, t, out) {
  const k = Math.max(0, Math.min(1, t / plan.dur));
  const a = MANTLE.LIFT_FRAC;
  const f = plan.from, l = plan.lift, e = plan.to;
  if (k < a) {
    // 들어 올리기: 높이는 일정한 속도로(속도 검사), 앞으로는 턱에 붙을 만큼만
    const u = k / a;
    out[0] = f[0] + (l[0] - f[0]) * smooth(u);
    out[1] = f[1] + (l[1] - f[1]) * u;
    out[2] = f[2] + (l[2] - f[2]) * smooth(u);
  } else {
    const u = (k - a) / (1 - a);
    const s = smooth(u);
    out[0] = l[0] + (e[0] - l[0]) * s;
    out[2] = l[2] + (e[2] - l[2]) * s;
    out[1] = l[1] + (e[1] - l[1]) * s + (plan.kind === 'vault' ? MANTLE.VAULT_ARC * Math.sin(Math.PI * u) : 0);
  }
  return k >= 1;
}
