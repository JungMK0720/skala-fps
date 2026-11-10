/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 움직이는 지형(맵 movers) 판정(순수 모듈, three.js 없음). 맵 데이터를 왕복 운동 표로 바꾸고,
 *          틱마다 충돌체를 그 시각의 자리로 옮기며, 위에 선 몸을 함께 실어 나른다.
 */
/**
 * SKALA 작전 — 움직이는 지형 (docs/MAP_GUIDE.md 11절)
 *
 *   맵 데이터: movers: [{ id, x, y, z, w, h, d, mat, axis: 'x'|'y'|'z', dist, period, hold, phase }]
 *     x·y·z·w·h·d = 쉬는 자리의 상자(solids의 box와 같은 규약). axis 방향으로 dist만큼 갔다가 돌아온다.
 *     한 주기(period 초) = 쉬는 자리에서 hold초 → 이동 → 끝에서 hold초 → 돌아옴. 편도 이동 시간 = period/2 − hold.
 *     phase(0~1)는 주기를 그만큼 앞당긴다. 출발과 도착은 부드럽게(smoothstep) 한다.
 *
 *   const state = createMovers(data.movers);          // { list: [{ spec, collider, off, prevOff }], time, empty }
 *   world.movers = state;                              // buildCollision이 넣는다. 충돌체는 world.colliders에도 들어 있다(dynamic: true)
 *   stepMovers(world, t);                              // 틱마다 한 번, 몸을 움직이기 전에. t = 초(모든 화면이 같은 시계를 쓴다)
 *   carryBody(world, body);                            // 몸을 움직이기 직전에. 움직이는 상자 위에 서 있으면 같이 옮긴다
 *
 * 위치는 시각의 함수라서 따로 동기화하지 않는다. 멀티에서는 방장 시계, 연습장에서는 맵을 불러온 뒤 흐른 시간을 쓴다.
 * 옆에서 미는 것은 physics의 벽 밀어내기가 한다. 그래서 수평으로 움직이는 상자는 벽에서 1.5 m 이상 떨어져서 멈춰야 한다(검사기가 본다).
 */
import { LIMITS, MATS } from '../core/consts.js';
import { makeBox } from './physics.js';

export const MOVER_AXES = Object.freeze(['x', 'y', 'z']);
/** 가장 빠른 순간의 속력 상한(m/s). 걷는 속도(5.2)보다 느려서 피할 수 있다 */
export const MOVER_MAX_SPEED = 3;
/** 편도 이동 시간 하한(초) */
export const MOVER_MIN_TRAVEL = 1.5;
/** hold를 안 적었을 때 양 끝에서 쉬는 시간(초) */
export const MOVER_DEFAULT_HOLD = 1;
/** mat을 안 적었거나 모르는 이름일 때 */
export const MOVER_DEFAULT_MAT = 'steel';

const CARRY_TOL = 0.08;   // 발과 윗면의 높이 차가 이 안이면 위에 선 것으로 본다(m)
const CARRY_MAX = 0.5;    // 한 틱에 이보다 많이 움직였으면 시계가 튄 것이라 실어 나르지 않는다(m)

const isNum = (v) => v !== null && v !== '' && v !== undefined && typeof v !== 'boolean' && Number.isFinite(+v);
const isPos = (v) => isNum(v) && +v > 0;
const frac = (v) => ((v % 1) + 1) % 1;

/**
 * 맵 movers 항목 하나 → 운동 표. 쓸 수 없는 항목이면 null(이유는 validateMap이 알려 준다).
 * @returns {{id, x, y, z, w, h, d, mat, axis, dist, period, hold, travel, phase, src}|null}
 */
export function normalizeMover(m, i = 0) {
  if (!m || typeof m !== 'object') return null;
  if (!isNum(m.x) || !isNum(m.z) || !isPos(m.w) || !isPos(m.h) || !isPos(m.d)) return null;
  if (!MOVER_AXES.includes(m.axis) || !isNum(m.dist) || +m.dist === 0 || !isPos(m.period)) return null;
  const period = +m.period;
  const hold = isNum(m.hold) && +m.hold >= 0 ? +m.hold : MOVER_DEFAULT_HOLD;
  const travel = period / 2 - hold;
  if (!(travel > 0)) return null;
  return {
    id: m.id === undefined || m.id === null || m.id === '' ? `mover${i}` : String(m.id),
    x: +m.x, y: isNum(m.y) ? +m.y : 0, z: +m.z, w: +m.w, h: +m.h, d: +m.d,
    mat: typeof m.mat === 'string' && MATS.includes(m.mat) ? m.mat : MOVER_DEFAULT_MAT,
    axis: m.axis, dist: +m.dist, period, hold, travel,
    phase: isNum(m.phase) ? frac(+m.phase) : 0,
    src: i
  };
}

/** 맵 movers → 운동 표 목록. 잘못된 항목은 빼고 한도(LIMITS.MOVERS)에서 자른다 */
export function normalizeMovers(list) {
  const out = [];
  if (!Array.isArray(list)) return out;
  for (let i = 0; i < list.length && out.length < LIMITS.MOVERS; i++) {
    const spec = normalizeMover(list[i], i);
    if (spec) out.push(spec);
  }
  return out;
}

/** t초일 때 쉬는 자리에서 끝까지 간 비율(0~1). 양 끝에서 쉬고, 가고 오는 동안은 부드럽게 빨라졌다 느려진다 */
export function moverProgress(spec, t) {
  const c = frac((Number.isFinite(t) ? t : 0) / spec.period + spec.phase) * spec.period;
  const { hold, travel } = spec;
  let s;
  if (c < hold) s = 0;
  else if (c < hold + travel) s = (c - hold) / travel;
  else if (c < 2 * hold + travel) s = 1;
  else s = 1 - (c - 2 * hold - travel) / travel;
  if (s <= 0) return 0;
  if (s >= 1) return 1;
  return s * s * (3 - 2 * s);
}

/** t초일 때 쉬는 자리에서 axis 방향으로 벗어난 거리(m) */
export function moverOffset(spec, t) {
  return spec.dist * moverProgress(spec, t);
}

/** 가장 빠른 순간의 속력(m/s). smoothstep의 가운데 기울기가 1.5다 */
export function moverPeakSpeed(spec) {
  return (1.5 * Math.abs(spec.dist)) / spec.travel;
}

/** 쉬는 자리에서 off만큼 옮긴 상자 { minX, minY, minZ, maxX, maxY, maxZ } */
export function moverBox(spec, off = 0, out = {}) {
  const ox = spec.axis === 'x' ? off : 0, oy = spec.axis === 'y' ? off : 0, oz = spec.axis === 'z' ? off : 0;
  out.minX = spec.x - spec.w / 2 + ox; out.maxX = spec.x + spec.w / 2 + ox;
  out.minY = spec.y + oy; out.maxY = spec.y + spec.h + oy;
  out.minZ = spec.z - spec.d / 2 + oz; out.maxZ = spec.z + spec.d / 2 + oz;
  return out;
}

/** 쉬는 자리부터 끝까지 지나가는 부피 전체를 덮는 상자 */
export function moverSweep(spec) {
  const a = moverBox(spec, 0), b = moverBox(spec, spec.dist);
  return {
    minX: Math.min(a.minX, b.minX), maxX: Math.max(a.maxX, b.maxX),
    minY: Math.min(a.minY, b.minY), maxY: Math.max(a.maxY, b.maxY),
    minZ: Math.min(a.minZ, b.minZ), maxZ: Math.max(a.maxZ, b.maxZ)
  };
}

/**
 * 맵 movers → 움직이는 지형 상태. 충돌체는 쉬는 자리의 상자이고 dynamic 표시가 붙는다
 * (physics.createWorld가 격자에 넣지 않고 늘 검사한다. 그래서 상자를 옮겨도 판정이 맞는다).
 * @returns {{ list: {spec, collider, off:number, prevOff:number}[], time:number, started:boolean, empty:boolean }}
 */
export function createMovers(list) {
  const specs = normalizeMovers(list);
  const items = specs.map((spec, index) => {
    const b = moverBox(spec, 0);
    const collider = makeBox(b.minX, b.minY, b.minZ, b.maxX, b.maxY, b.maxZ, spec.mat, { dynamic: true, tag: 'mover', mover: index });
    return { spec, collider, off: 0, prevOff: 0 };
  });
  return { list: items, time: 0, started: false, empty: items.length === 0 };
}

/**
 * 틱마다 한 번 부른다. 충돌체를 t초의 자리로 옮기고, 직전 자리(prevOff)를 남겨 carryBody와 그리기 보간이 쓰게 한다.
 * 처음 부를 때는 직전 자리도 지금 자리로 맞춘다(맵을 불러오자마자 실려 가지 않게).
 */
export function stepMovers(world, t) {
  const st = world && world.movers;
  if (!st || st.empty) return;
  const time = Number.isFinite(t) ? t : st.time;
  for (const m of st.list) {
    const off = moverOffset(m.spec, time);
    m.prevOff = st.started ? m.off : off;
    m.off = off;
    moverBox(m.spec, off, m.collider);
  }
  st.time = time;
  st.started = true;
}

/**
 * 몸을 움직이기 직전에 부른다. 발이 움직이는 상자의 윗면(직전 틱의 자리)에 닿아 있고 몸 중심이 그 위에 있으면
 * 상자가 이번 틱에 움직인 만큼 몸을 같이 옮긴다. 속도는 건드리지 않는다.
 * @param {{pos:number[], onGround:boolean}} body
 * @returns {object|null} 몸을 실은 mover(목록 항목). 없으면 null
 */
export function carryBody(world, body) {
  const st = world && world.movers;
  if (!st || st.empty || !body || !body.onGround || !body.pos) return null;
  const x = body.pos[0], y = body.pos[1], z = body.pos[2];
  for (const m of st.list) {
    const d = m.off - m.prevOff;
    const c = m.collider, axis = m.spec.axis;
    const ox = axis === 'x' ? d : 0, oy = axis === 'y' ? d : 0, oz = axis === 'z' ? d : 0;
    if (Math.abs(y - (c.maxY - oy)) > CARRY_TOL) continue;
    if (x < c.minX - ox || x > c.maxX - ox || z < c.minZ - oz || z > c.maxZ - oz) continue;
    if (d === 0 || Math.abs(d) > CARRY_MAX) return m;
    body.pos[0] += ox; body.pos[1] += oy; body.pos[2] += oz;
    return m;
  }
  return null;
}
