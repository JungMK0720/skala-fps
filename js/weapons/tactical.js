/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 연막탄·섬광탄의 판정(순수 모듈). 연기 구름의 크기·시선 차단과 섬광의 세기(시선 각도·거리·가림)를 계산한다.
 *          three.js·엔진·DOM에 의존하지 않아 node 테스트, World(내 화면), 연습장 봇 시야가 같은 함수를 쓴다.
 */
/*
 *   const smoke = createSmokeField();
 *   smoke.add({ id, pos: [x, y, z], t })      // 신관이 다 된 자리(바닥)와 그때의 시계(초). 같은 id는 한 번만
 *   smoke.blocks(a, b, t)                     // a→b 시선이 지금 연기에 막히는가(봇 시야·내 화면이 같이 쓴다)
 *   smoke.density(p, t)                       // 점 p가 연기 속에 얼마나 깊이 있나(0..1, 화면 안개)
 *   smoke.list(t)                             // [{ id, center:[x,y,z], radius, age, life }] 그리기용
 *   flashIntensity({ eye, forward, pos, clear })   // 0..1. clear=false(벽에 가림)면 0
 *   flashBlindSec(intensity)                  // 눈이 멀어 있는 시간(초)
 *
 * 단위: 거리 m, 시간 s. 벡터는 [x,y,z] 배열과 {x,y,z} 객체를 모두 받는다.
 */
import { WEAPONS } from './defs.js';

/** 연기 구름 수치. radius = 다 퍼졌을 때 반경, grow = 퍼지는 데 걸리는 시간, life = 터진 뒤 전체 수명, fade = 끝에서 걷히는 시간 */
export const SMOKE = Object.freeze({
  radius: 6, grow: 2.2, life: 14, fade: 2.5,
  lift: 1.0,       // 구름 가운데는 떨어진 자리보다 이만큼 위(바닥에 깔린 반구처럼 보이게)
  blockLen: 1.2,   // 시선이 구름 안을 이만큼 이상 지나가면 막힌다(가장자리를 스치는 시선은 통과)
  minRadius: 0.8   // 이보다 작은(막 터졌거나 다 걷힌) 구름은 막지 않는다
});

/** 섬광 수치. full 안쪽은 거리 감쇠 없음, range 밖은 0. back = 완전히 등을 돌렸을 때 남는 비율 */
export const FLASH = Object.freeze({
  maxBlind: 3, full: 6, range: 28, back: 0.12, coneCos: Math.cos(Math.PI / 6),
  close: 2.5,      // 이 안이면 등을 돌려도 세게 맞는다(반사광)
  min: 0.08,       // 이보다 약하면 아무 일도 없다
  smokeMul: 0.5    // 연기 너머 섬광은 절반
});

/** 투척 무기 정의 → 효과 종류('smoke'|'flash'|null). 모르는 id는 null */
export function throwableOf(id) {
  const d = typeof id === 'string' && Object.prototype.hasOwnProperty.call(WEAPONS, id) ? WEAPONS[id] : null;
  return d && (d.throwable === 'smoke' || d.throwable === 'flash') ? d.throwable : null;
}

const num = (v, d = 0) => (Number.isFinite(v) ? v : d);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const rd = (v) => (Array.isArray(v) ? [num(+v[0]), num(+v[1]), num(+v[2])] : v ? [num(+v.x), num(+v.y), num(+v.z)] : [0, 0, 0]);
const smooth = (x) => x * x * (3 - 2 * x);

/** 터진 뒤 age초의 구름 반경(m). 처음 grow초 동안 빠르게 퍼지고, 끝 fade초 동안 걷힌다 */
export function smokeRadius(age, S = SMOKE) {
  const a = num(age, -1);
  if (a < 0 || a >= S.life) return 0;
  const up = 1 - Math.pow(1 - clamp(a / S.grow, 0, 1), 3);
  const down = clamp((S.life - a) / S.fade, 0, 1);
  return S.radius * up * Math.sqrt(down);
}

/**
 * 선분 a→b가 구(c, r) 안을 지나는 길이(m).
 * @returns {number} 0이면 닿지 않는다
 */
export function chordLength(a, b, c, r) {
  const A = rd(a), B = rd(b), C = rd(c);
  const dx = B[0] - A[0], dy = B[1] - A[1], dz = B[2] - A[2];
  const L2 = dx * dx + dy * dy + dz * dz;
  if (!(r > 0)) return 0;
  const fx = A[0] - C[0], fy = A[1] - C[1], fz = A[2] - C[2];
  if (L2 < 1e-12) return 0;
  const bq = 2 * (fx * dx + fy * dy + fz * dz);
  const cq = fx * fx + fy * fy + fz * fz - r * r;
  const disc = bq * bq - 4 * L2 * cq;
  if (disc <= 0) return 0;
  const s = Math.sqrt(disc);
  const t0 = clamp((-bq - s) / (2 * L2), 0, 1), t1 = clamp((-bq + s) / (2 * L2), 0, 1);
  return t1 > t0 ? (t1 - t0) * Math.sqrt(L2) : 0;
}

/**
 * 연기 구름 모음. 시계(t, 초)는 부르는 쪽이 넘긴다(World는 시뮬레이션 시계 — 일시정지하면 연기도 멈춘다).
 * @param {object} [cfg] SMOKE 덮어쓰기(시험용)
 */
export function createSmokeField(cfg = {}) {
  const S = { ...SMOKE, ...cfg };
  let clouds = [];   // { id, center:[x,y,z], t0 }

  function live(t) {
    const now = num(t, 0);
    if (clouds.some((c) => now - c.t0 >= S.life)) clouds = clouds.filter((c) => now - c.t0 < S.life);
    return clouds;
  }

  return {
    /** 구름 하나를 더한다. 같은 id가 이미 있으면 false */
    add({ id, pos, t } = {}) {
      const key = id == null ? `s${clouds.length}:${num(t)}` : String(id);
      if (clouds.some((c) => c.id === key)) return false;
      const p = rd(pos);
      clouds.push({ id: key, center: [p[0], p[1] + S.lift, p[2]], t0: num(t, 0) });
      return true;
    },
    /** a→b 시선이 시각 t에 연기에 막히는가 */
    blocks(a, b, t) {
      const now = num(t, 0);
      for (const c of live(now)) {
        const r = smokeRadius(now - c.t0, S);
        if (r < S.minRadius) continue;
        if (chordLength(a, b, c.center, r) >= S.blockLen) return true;
      }
      return false;
    },
    /** 점 p가 연기 속에 얼마나 깊이 있나(0 = 밖, 1 = 가운데 가까이). 여러 구름이면 가장 진한 것 */
    density(p, t) {
      const now = num(t, 0), q = rd(p);
      let best = 0;
      for (const c of live(now)) {
        const r = smokeRadius(now - c.t0, S);
        if (r < S.minRadius) continue;
        const d = Math.hypot(q[0] - c.center[0], q[1] - c.center[1], q[2] - c.center[2]);
        if (d >= r) continue;
        best = Math.max(best, clamp((r - d) / (r * 0.45), 0, 1));
      }
      return best;
    },
    /** 그리기용 목록 */
    list(t) {
      const now = num(t, 0);
      return live(now).map((c) => ({ id: c.id, center: c.center.slice(), radius: smokeRadius(now - c.t0, S), age: now - c.t0, life: S.life }));
    },
    get count() { return clouds.length; },
    clear() { clouds = []; }
  };
}

/**
 * 섬광의 세기(0..1).
 * @param {{ eye, forward, pos, clear?:boolean, smoke?:boolean }} o
 *   eye = 보는 사람 눈, forward = 시선(단위 벡터가 아니어도 된다), pos = 터진 자리,
 *   clear = 눈과 섬광 사이에 벽이 없나(false면 0), smoke = 사이에 연기가 있나(세기 절반)
 */
export function flashIntensity(o = {}) {
  if (o.clear === false) return 0;
  const e = rd(o.eye), p = rd(o.pos), f = rd(o.forward);
  const dx = p[0] - e[0], dy = p[1] - e[1], dz = p[2] - e[2];
  const d = Math.hypot(dx, dy, dz);
  if (d >= FLASH.range) return 0;
  const fd = d <= FLASH.full ? 1 : 1 - (d - FLASH.full) / (FLASH.range - FLASH.full);
  const fl = Math.hypot(f[0], f[1], f[2]);
  const cos = d < 1e-6 || fl < 1e-6 ? 1 : (dx * f[0] + dy * f[1] + dz * f[2]) / (d * fl);
  // 시선 원뿔(30°) 안이면 그대로, 등 뒤로 갈수록 back까지 부드럽게 줄어든다
  let fa = FLASH.back + (1 - FLASH.back) * smooth(clamp((cos + 1) / (1 + FLASH.coneCos), 0, 1));
  fa = Math.max(fa, clamp(1 - d / FLASH.close, 0, 1));
  let k = clamp(fd * fa, 0, 1);
  if (o.smoke) k *= FLASH.smokeMul;
  return k < FLASH.min ? 0 : k;
}

/** 세기 → 눈이 멀어 있는 시간(초) */
export function flashBlindSec(intensity) {
  return clamp(num(intensity), 0, 1) * FLASH.maxBlind;
}

/**
 * 섬광 뒤 경과 시간(초)의 하얀 화면 불투명도(0..1). 처음 45%는 하얗게 버티고 남은 시간 동안 걷힌다
 * @param {number} intensity 0..1
 * @param {number} elapsed 섬광 뒤 경과(초)
 */
export function flashWhiteout(intensity, elapsed) {
  const k = clamp(num(intensity), 0, 1), dur = flashBlindSec(k), t = num(elapsed, Infinity);
  if (!(dur > 0) || t < 0 || t >= dur) return 0;
  const hold = dur * 0.45;
  const peak = Math.min(1, 0.35 + k);
  return t <= hold ? peak : peak * (1 - smooth((t - hold) / (dur - hold)));
}
