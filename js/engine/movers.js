/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 움직이는 지형(맵 movers) 판정(순수 모듈, three.js 없음). 맵 데이터를 왕복 운동 표로 바꾸고,
 *          틱마다 충돌체를 그 시각의 자리로 옮기며, 위에 선 몸을 함께 실어 나른다. 가까이 오면 열리는 문도 여기서 다룬다.
 */
/**
 * SKALA 작전 — 움직이는 지형 (docs/MAP_GUIDE.md 11절)
 *
 *   맵 데이터: movers: [{ id, x, y, z, w, h, d, mat, axis: 'x'|'y'|'z', dist, period, hold, phase }]
 *     x·y·z·w·h·d = 쉬는 자리의 상자(solids의 box와 같은 규약). axis 방향으로 dist만큼 갔다가 돌아온다.
 *     한 주기(period 초) = 쉬는 자리에서 hold초 → 이동 → 끝에서 hold초 → 돌아옴. 편도 이동 시간 = period/2 − hold.
 *     phase(0~1)는 주기를 그만큼 앞당긴다. 출발과 도착은 부드럽게(smoothstep) 한다.
 *
 *   const state = createMovers(data.movers);          // { list: [{ spec, collider, off, prevOff }], time, empty, doors }
 *   world.movers = state;                              // buildCollision이 넣는다. 충돌체는 world.colliders에도 들어 있다(dynamic: true)
 *   stepMovers(world, t, bodies);                      // 틱마다 한 번, 몸을 움직이기 전에. t = 초(모든 화면이 같은 시계를 쓴다)
 *   carryBody(world, body);                            // 몸을 움직이기 직전에. 움직이는 상자 위에 서 있으면 같이 옮긴다
 *
 * 위치는 시각의 함수라서 따로 동기화하지 않는다. 멀티에서는 방장 시계, 연습장에서는 맵을 불러온 뒤 흐른 시간을 쓴다.
 * 옆에서 미는 것은 physics의 벽 밀어내기가 한다. 그래서 수평으로 움직이는 상자는 벽에서 1.5 m 이상 떨어져서 멈춰야 한다(검사기가 본다).
 *
 * 문(door): 주기 대신 사람을 보고 움직인다. { id, x, y, z, w, h, d, mat, axis, dist, door: true | { range, open, close, linger } }
 *     x·y·z·w·h·d = 닫힌 자리의 문짝. 살아 있는 사람(bodies = 발 위치 목록)이 그 문짝에서 range m 안에 있으면 open초에 걸쳐
 *     axis 방향으로 dist만큼 가서 열리고, 아무도 없이 linger초가 지나면 close초에 걸쳐 닫힌다.
 *     옆으로 여는 문(axis 'x'·'z')은 문 옆 벽 속으로 들어가고, 위아래로 여는 문(axis 'y')은 문 위 벽이나 바닥 속으로 들어간다.
 *     사람이 가까이 있는 동안에는 닫히지 않으므로 문에 끼이지 않는다. 그래서 속도 한도(MOVER_MAX_SPEED)를 두지 않는다.
 *     문의 자리는 화면마다 자기가 보는 사람 위치로 정한다. 그래서 보낼 메시지가 없고, 늦게 들어온 사람도 금방 같은 상태가 된다.
 *     원격 위치는 보간 지연(약 0.1초)만큼 늦으므로 남이 연 문은 그만큼 늦게 열려 보인다.
 */
import { LIMITS, MATS } from '../core/consts.js';
import { makeBox } from './physics.js';

export const MOVER_AXES = Object.freeze(['x', 'y', 'z']);
/** 가장 빠른 순간의 속력 상한(m/s). 걷는 속도(5.2)보다 느려서 피할 수 있다. 문에는 적용하지 않는다(사람이 있으면 닫히지 않는다) */
export const MOVER_MAX_SPEED = 3;
/** 편도 이동 시간 하한(초) */
export const MOVER_MIN_TRAVEL = 1.5;
/** hold를 안 적었을 때 양 끝에서 쉬는 시간(초) */
export const MOVER_DEFAULT_HOLD = 1;
/** mat을 안 적었거나 모르는 이름일 때 */
export const MOVER_DEFAULT_MAT = 'steel';

/** 문을 안 적은 값: 사람을 알아보는 거리(m, 닫힌 문의 바닥 사각형에서 잰다), 여닫는 시간(초), 아무도 없을 때 닫히기까지 기다리는 시간(초) */
export const DOOR_DEFAULTS = Object.freeze({ range: 1.8, open: 0.25, close: 0.5, linger: 0.6 });
/** 문이 사람을 알아보는 거리와 여닫는 시간의 범위 */
export const DOOR_LIMITS = Object.freeze({ minRange: 0.8, maxRange: 6, minTime: 0.1, maxTime: 5, maxLinger: 10 });
/** 올라가는 문이 다 열렸을 때 그 밑에 비어야 하는 높이(m). 선 사람(1.8)이 지나간다 */
export const DOOR_CLEARANCE = 1.95;
/** 내려가는 문이 다 열렸을 때 바닥 위로 남아도 되는 높이(m). 걸어서 넘는 턱(0.45)보다 훨씬 낮다 */
export const DOOR_SILL = 0.1;
/** 옆으로 여는 문이 다 열렸을 때 문간에 남아도 되는 폭(m) */
export const DOOR_STUB = 0.05;

const DOOR_BELOW = 1.5;       // 문 바닥보다 이만큼 아래(계단 중간)에 선 사람까지 알아본다(m)
const DOOR_ABOVE = 0.5;       // 문 윗변보다 이만큼 위(뛰어오른 사람)까지 알아본다(m)
const DOOR_MAX_STEP = 0.25;   // 시계가 튀어도 한 번에 이만큼만 진행한다(초)

const CARRY_TOL = 0.08;   // 발과 윗면의 높이 차가 이 안이면 위에 선 것으로 본다(m)
const CARRY_MAX = 0.5;    // 한 틱에 이보다 많이 움직였으면 시계가 튄 것이라 실어 나르지 않는다(m)

const isNum = (v) => v !== null && v !== '' && v !== undefined && typeof v !== 'boolean' && Number.isFinite(+v);
const isPos = (v) => isNum(v) && +v > 0;
const frac = (v) => ((v % 1) + 1) % 1;
const clampNum = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * 맵 항목의 door 칸 → { range, open, close, linger }. 문이 아니면 null.
 * true면 기본값이고, 객체면 적힌 값만 바꾼다. 범위를 벗어난 값은 가까운 끝으로 자른다(validateMap이 알려 준다)
 */
export function normalizeDoor(v) {
  if (v !== true && !(v && typeof v === 'object')) return null;
  const o = v === true ? {} : v;
  const pick = (key, lo, hi) => (isNum(o[key]) ? clampNum(+o[key], lo, hi) : DOOR_DEFAULTS[key]);
  return {
    range: pick('range', DOOR_LIMITS.minRange, DOOR_LIMITS.maxRange),
    open: pick('open', DOOR_LIMITS.minTime, DOOR_LIMITS.maxTime),
    close: pick('close', DOOR_LIMITS.minTime, DOOR_LIMITS.maxTime),
    linger: pick('linger', 0, DOOR_LIMITS.maxLinger)
  };
}

/**
 * 맵 movers 항목 하나 → 운동 표. 쓸 수 없는 항목이면 null(이유는 validateMap이 알려 준다).
 * 문(door)은 주기가 없다: period·hold·phase는 0이고 travel은 열리는 시간이다.
 * @returns {{id, x, y, z, w, h, d, mat, axis, dist, period, hold, travel, phase, door, src}|null}
 */
export function normalizeMover(m, i = 0) {
  if (!m || typeof m !== 'object') return null;
  if (!isNum(m.x) || !isNum(m.z) || !isPos(m.w) || !isPos(m.h) || !isPos(m.d)) return null;
  if (!MOVER_AXES.includes(m.axis) || !isNum(m.dist) || +m.dist === 0) return null;
  const door = normalizeDoor(m.door);
  if (!door && !isPos(m.period)) return null;
  const period = door ? 0 : +m.period;
  const hold = door ? 0 : (isNum(m.hold) && +m.hold >= 0 ? +m.hold : MOVER_DEFAULT_HOLD);
  const travel = door ? door.open : period / 2 - hold;
  if (!(travel > 0)) return null;
  return {
    id: m.id === undefined || m.id === null || m.id === '' ? `mover${i}` : String(m.id),
    x: +m.x, y: isNum(m.y) ? +m.y : 0, z: +m.z, w: +m.w, h: +m.h, d: +m.d,
    mat: typeof m.mat === 'string' && MATS.includes(m.mat) ? m.mat : MOVER_DEFAULT_MAT,
    axis: m.axis, dist: +m.dist, period, hold, travel,
    phase: !door && isNum(m.phase) ? frac(+m.phase) : 0,
    door,
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

/**
 * t초일 때 쉬는 자리에서 끝까지 간 비율(0~1). 양 끝에서 쉬고, 가고 오는 동안은 부드럽게 빨라졌다 느려진다.
 * 문은 시각으로 정해지지 않으므로 늘 0(닫힌 자리)이다
 */
export function moverProgress(spec, t) {
  if (spec.door) return 0;
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

/** 가장 빠른 순간의 속력(m/s). smoothstep의 가운데 기울기가 1.5다. 문은 열리기 시작할 때가 가장 빠르고 그 기울기가 2다 */
export function moverPeakSpeed(spec) {
  return ((spec.door ? 2 : 1.5) * Math.abs(spec.dist)) / spec.travel;
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

/* ---------------- 문 ---------------- */

/** 열린 비율(0~1) → 간 거리의 비율. 빨리 열리기 시작해 부드럽게 멈춘다(닫힐 때는 거꾸로) */
export function doorEase(p) {
  if (!(p > 0)) return 0;
  if (p >= 1) return 1;
  return p * (2 - p);
}

/**
 * 문이 다 열렸을 때 사람이 지나갈 수 있는가. 옆으로 여는 문은 문짝 길이만큼(DOOR_STUB 빼고) 비켜야 하고,
 * 올라가는 문은 밑이 DOOR_CLEARANCE 넘게 뜨고, 내려가는 문은 윗변이 DOOR_SILL 아래로 내려가야 한다
 */
export function doorPassable(spec) {
  if (spec.axis === 'x') return Math.abs(spec.dist) >= spec.w - DOOR_STUB;
  if (spec.axis === 'z') return Math.abs(spec.dist) >= spec.d - DOOR_STUB;
  return spec.dist > 0 ? spec.dist >= DOOR_CLEARANCE : spec.h + spec.dist <= DOOR_SILL;
}

/**
 * 문 가까이에 사람이 있는가. bodies = 살아 있는 사람의 발 위치 목록([x, y, z] 또는 { x, y, z }).
 * 거리는 닫힌 자리의 바닥 사각형에서 재고, 다른 층에 선 사람은 세지 않는다.
 */
export function doorNear(spec, bodies) {
  if (!spec.door || !bodies) return false;
  const hx = spec.w / 2, hz = spec.d / 2, r = spec.door.range;
  for (const b of bodies) {
    if (!b) continue;
    const arr = Array.isArray(b) || ArrayBuffer.isView(b);
    const x = arr ? b[0] : b.x, y = arr ? b[1] : b.y, z = arr ? b[2] : b.z;
    if (!(y > spec.y - DOOR_BELOW && y < spec.y + spec.h + DOOR_ABOVE)) continue;
    const dx = Math.max(Math.abs(x - spec.x) - hx, 0), dz = Math.max(Math.abs(z - spec.z) - hz, 0);
    if (dx * dx + dz * dz <= r * r) return true;
  }
  return false;
}

/**
 * 문 하나를 dt초 진행한다. near면 열리고, 아무도 없이 linger초가 지나면 닫힌다.
 * @param {{spec:object, open:number, quiet:number}} m 목록 항목(open = 열린 비율 0~1, quiet = 아무도 없던 시간)
 * @returns {number} 열린 비율(0~1)
 */
export function stepDoor(m, dt, near) {
  const d = m.spec.door;
  if (!(dt > 0)) return m.open;
  if (near) {
    m.quiet = 0;
    m.open = Math.min(1, m.open + dt / d.open);
  } else {
    m.quiet += dt;
    if (m.quiet >= d.linger) m.open = Math.max(0, m.open - dt / d.close);
  }
  return m.open;
}

/* ---------------- 상태 ---------------- */

/**
 * 맵 movers → 움직이는 지형 상태. 충돌체는 쉬는 자리의 상자이고 dynamic 표시가 붙는다
 * (physics.createWorld가 격자에 넣지 않고 늘 검사한다. 그래서 상자를 옮겨도 판정이 맞는다).
 * @returns {{ list: {spec, collider, off:number, prevOff:number, open:number, quiet:number}[], time:number, started:boolean, empty:boolean, doors:number }}
 *   open·quiet은 문만 쓴다(열린 비율, 아무도 없던 시간). doors = 문의 수
 */
export function createMovers(list) {
  const specs = normalizeMovers(list);
  const items = specs.map((spec, index) => {
    const b = moverBox(spec, 0);
    const collider = makeBox(b.minX, b.minY, b.minZ, b.maxX, b.maxY, b.maxZ, spec.mat, { dynamic: true, tag: 'mover', mover: index });
    return { spec, collider, off: 0, prevOff: 0, open: 0, quiet: Infinity };
  });
  return { list: items, time: 0, started: false, empty: items.length === 0, doors: items.filter((m) => m.spec.door).length };
}

/**
 * 틱마다 한 번 부른다. 충돌체를 t초의 자리로 옮기고, 직전 자리(prevOff)를 남겨 carryBody와 그리기 보간이 쓰게 한다.
 * 처음 부를 때는 직전 자리도 지금 자리로 맞춘다(맵을 불러오자마자 실려 가지 않게).
 * 문은 지난번 부른 뒤 흐른 시간만큼 진행한다(시계가 멈추면 문도 멈춘다).
 * @param {number} t 초
 * @param {Array|null} [bodies] 살아 있는 사람의 발 위치 목록(doorNear). 없으면 아무도 없는 것으로 본다
 */
export function stepMovers(world, t, bodies = null) {
  const st = world && world.movers;
  if (!st || st.empty) return;
  const time = Number.isFinite(t) ? t : st.time;
  const dt = st.started ? Math.min(DOOR_MAX_STEP, Math.max(0, time - st.time)) : 0;
  for (const m of st.list) {
    const off = m.spec.door
      ? m.spec.dist * doorEase(stepDoor(m, dt, dt > 0 && doorNear(m.spec, bodies)))
      : moverOffset(m.spec, time);
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
