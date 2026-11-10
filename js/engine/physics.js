/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 충돌·캐릭터 이동·레이캐스트·수류탄 스윕을 맡는 순수 물리 함수. 사격 판정은 머리·몸·다리·손·발 다섯 부위 중 가장 먼저 닿은 곳을 돌려준다.
 *          three.js에 의존하지 않아 node에서 그대로 테스트한다.
 */
/**
 * SKALA 작전 — 물리 (순수 함수, three.js 의존 없음 → node에서 테스트 가능)
 *
 * 좌표: 1 = 1 m, y 위. 벡터는 [x, y, z] 배열.
 *
 * 충돌체(collider) — 모두 축 정렬, bbox 필드(minX..maxZ)를 공통으로 가진다.
 *   box : { kind:'box',  minX,minY,minZ, maxX,maxY,maxZ, mat }
 *   cyl : { kind:'cyl',  x, z, r, minY, maxY, (bbox), mat }           세로 원통
 *   ramp: { kind:'ramp', (bbox), dir:'+x'|'-x'|'+z'|'-z', planes, mat }  dir 방향으로 minY→maxY 상승하는 쐐기
 *   공통 옵션: noRay(레이캐스트 무시 — 보이지 않는 외곽 벽), tag('bounds' 외곽 벽 · 'clip' 점프 방지 막이 → sphereSweep도 무시 · 'ground')
 *
 * 캐릭터는 세로 원기둥(반지름 r, 키 h, 평평한 발)으로 근사한다. XZ 원 대 AABB/원/경사로로 벽을 밀어내고,
 * 발밑은 '반지름 안에서 가장 높은 윗면'으로 판정한다(계단 STEP 이하는 올라탐).
 */
import { PLAYER, HITBOX, HITBOX_CROUCH } from '../core/consts.js';

const SKIN = 0.001;            // 밀어낸 뒤 남기는 틈
const AIR_STEP_FACTOR = 0.5;   // 공중에서의 턱 오르기 = STEP × 0.5
const MAX_SUB_MOVE = 0.15;     // 서브스텝당 최대 이동 (m) — 반지름(0.35)보다 충분히 작게: 터널링 방지
const MAX_QUERY_COORD = 1e9;   // 브로드페이즈가 받는 좌표 상한 (m)

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/* ============================================================
 * 충돌체 생성
 * ============================================================ */

/** 경사로 높이 (점 x,z를 사각형 안으로 클램프한 뒤 계산) */
export function rampHeight(c, x, z) {
  let t;
  switch (c.dir) {
    case '-x': t = (c.maxX - x) / (c.maxX - c.minX); break;
    case '+z': t = (z - c.minZ) / (c.maxZ - c.minZ); break;
    case '-z': t = (c.maxZ - z) / (c.maxZ - c.minZ); break;
    default:   t = (x - c.minX) / (c.maxX - c.minX); break; // '+x'
  }
  t = clamp(t, 0, 1);
  return c.minY + t * (c.maxY - c.minY);
}

/** 쐐기의 볼록 평면들 [nx,ny,nz,d] (내부: n·p ≤ d) */
function rampPlanes(c) {
  const h = c.maxY - c.minY;
  const planes = [
    [1, 0, 0, c.maxX], [-1, 0, 0, -c.minX],
    [0, 0, 1, c.maxZ], [0, 0, -1, -c.minZ],
    [0, -1, 0, -c.minY]
  ];
  let n, d;
  if (c.dir === '+x' || c.dir === '-x') {
    const k = h / (c.maxX - c.minX);
    if (c.dir === '+x') { n = [-k, 1, 0]; d = c.minY - k * c.minX; } else { n = [k, 1, 0]; d = c.minY + k * c.maxX; }
  } else {
    const k = h / (c.maxZ - c.minZ);
    if (c.dir === '+z') { n = [0, 1, -k]; d = c.minY - k * c.minZ; } else { n = [0, 1, k]; d = c.minY + k * c.maxZ; }
  }
  const len = Math.hypot(n[0], n[1], n[2]);
  planes.push([n[0] / len, n[1] / len, n[2] / len, d / len]);
  return planes;
}

const RAMP_DIRS = ['+x', '-x', '+z', '-z'];
const num = (v, d = 0) => (Number.isFinite(+v) && v !== null && v !== '' ? +v : d);

/** AABB 충돌체 직접 생성 */
export function makeBox(minX, minY, minZ, maxX, maxY, maxZ, mat = 'concrete', extra) {
  return Object.assign({ kind: 'box', minX, minY, minZ, maxX, maxY, maxZ, mat }, extra || null);
}

/** 맵 solids 항목 1개 → collider (잘못된 항목이면 null) */
export function solidToCollider(s, index = -1) {
  if (!s || typeof s !== 'object') return null;
  const mat = typeof s.mat === 'string' ? s.mat : 'concrete';
  const x = num(s.x), y = num(s.y), z = num(s.z);
  if (s.type === 'box' || s.type === 'ramp') {
    const w = num(s.w), h = num(s.h), d = num(s.d);
    if (!(w > 0 && h > 0 && d > 0)) return null;
    const c = { kind: s.type, minX: x - w / 2, minY: y, minZ: z - d / 2, maxX: x + w / 2, maxY: y + h, maxZ: z + d / 2, mat, index };
    if (s.type === 'ramp') {
      c.dir = RAMP_DIRS.includes(s.dir) ? s.dir : '+x';
      c.planes = rampPlanes(c);
    }
    return c;
  }
  if (s.type === 'cyl') {
    const r = num(s.r), h = num(s.h);
    if (!(r > 0 && h > 0)) return null;
    return { kind: 'cyl', x, z, r, minX: x - r, minY: y, minZ: z - r, maxX: x + r, maxY: y + h, maxZ: z + r, mat, index };
  }
  return null;
}

/** 직사각형 a − b (XZ) → 남는 직사각형 목록. rect = {minX,minZ,maxX,maxZ} */
export function rectSubtract(a, b) {
  if (b.maxX <= a.minX || b.minX >= a.maxX || b.maxZ <= a.minZ || b.minZ >= a.maxZ) return [a];
  const out = [];
  const ix0 = Math.max(a.minX, b.minX), ix1 = Math.min(a.maxX, b.maxX);
  if (b.minZ > a.minZ) out.push({ minX: a.minX, minZ: a.minZ, maxX: a.maxX, maxZ: b.minZ });
  if (b.maxZ < a.maxZ) out.push({ minX: a.minX, minZ: b.maxZ, maxX: a.maxX, maxZ: a.maxZ });
  const z0 = Math.max(a.minZ, b.minZ), z1 = Math.min(a.maxZ, b.maxZ);
  if (ix0 > a.minX) out.push({ minX: a.minX, minZ: z0, maxX: ix0, maxZ: z1 });
  if (ix1 < a.maxX) out.push({ minX: ix1, minZ: z0, maxX: a.maxX, maxZ: z1 });
  return out.filter((r) => r.maxX - r.minX > 1e-4 && r.maxZ - r.minZ > 1e-4);
}

/* ============================================================
 * 월드 (브로드페이즈 격자)
 * ============================================================ */

/**
 * @param {object[]} colliders
 * @param {{bounds?:{minX,maxX,minZ,maxZ}, floorY?:number|null, groundMat?:string, cell?:number}} [opts]
 *   floorY: 숫자면 그 높이에 무한 바닥 평면(테스트·간단한 맵용). 빌더는 바닥을 box 충돌체로 만들고 null로 둔다.
 */
export function createWorld(colliders = [], opts = {}) {
  const cell = opts.cell || 4;
  const grid = new Map();
  const big = [];
  const list = colliders.filter(Boolean);
  list.forEach((c, i) => {
    c.id = i;
    const x0 = Math.floor(c.minX / cell), x1 = Math.floor(c.maxX / cell);
    const z0 = Math.floor(c.minZ / cell), z1 = Math.floor(c.maxZ / cell);
    // dynamic = 움직이는 지형(engine/movers.js). 상자가 틱마다 옮겨지므로 격자에 넣지 않고 늘 검사한다
    if (c.dynamic || (x1 - x0 + 1) * (z1 - z0 + 1) > 96) { big.push(c); return; }
    for (let gx = x0; gx <= x1; gx++) for (let gz = z0; gz <= z1; gz++) {
      const key = (gx + 32768) * 65536 + (gz + 32768);
      let arr = grid.get(key);
      if (!arr) { arr = []; grid.set(key, arr); }
      arr.push(c);
    }
  });
  const stamp = new Uint32Array(list.length + 1);
  let stampId = 0;

  // bounds: 명시적으로 준 플레이 영역만(이동 클램프에 사용). extents: 충돌체 전체 범위(참고용).
  const bounds = opts.bounds || null;
  const extents = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (const c of list) {
    extents.minX = Math.min(extents.minX, c.minX); extents.maxX = Math.max(extents.maxX, c.maxX);
    extents.minY = Math.min(extents.minY, c.minY); extents.maxY = Math.max(extents.maxY, c.maxY);
    extents.minZ = Math.min(extents.minZ, c.minZ); extents.maxZ = Math.max(extents.maxZ, c.maxZ);
  }

  /** XZ 사각형과 bbox가 겹치는 충돌체 목록 (out 재사용) */
  function query(minX, minZ, maxX, maxZ, out = []) {
    out.length = 0;
    // 터무니없는 좌표에서는 gx++가 값을 바꾸지 못해 아래 격자 반복이 끝나지 않는다. 네트워크로 온 값이 여기까지 올 수 있다
    if (!(Math.abs(minX) < MAX_QUERY_COORD && Math.abs(maxX) < MAX_QUERY_COORD && Math.abs(minZ) < MAX_QUERY_COORD && Math.abs(maxZ) < MAX_QUERY_COORD)) return out;
    stampId = (stampId + 1) >>> 0;
    if (stampId === 0) { stamp.fill(0); stampId = 1; }
    for (const c of big) {
      if (c.maxX >= minX && c.minX <= maxX && c.maxZ >= minZ && c.minZ <= maxZ) out.push(c);
    }
    const x0 = Math.floor(minX / cell), x1 = Math.floor(maxX / cell);
    const z0 = Math.floor(minZ / cell), z1 = Math.floor(maxZ / cell);
    for (let gx = x0; gx <= x1; gx++) for (let gz = z0; gz <= z1; gz++) {
      const arr = grid.get((gx + 32768) * 65536 + (gz + 32768));
      if (!arr) continue;
      for (const c of arr) {
        if (stamp[c.id] === stampId) continue;
        stamp[c.id] = stampId;
        if (c.maxX >= minX && c.minX <= maxX && c.maxZ >= minZ && c.minZ <= maxZ) out.push(c);
      }
    }
    return out;
  }

  const world = {
    colliders: list,
    bounds,
    extents,
    floorY: opts.floorY == null ? null : +opts.floorY,
    groundMat: opts.groundMat || 'asphalt',
    query
  };
  // 바인딩된 편의 메서드
  world.raycastWorld = (o, d, m, op) => raycastWorld(world, o, d, m, op);
  world.raycast = world.raycastWorld;
  world.traceShot = (o, d, m, t, op) => traceShot(world, o, d, m, t, op);
  world.moveCharacter = (b, w, dt, op) => moveCharacter(world, b, w, dt, op);
  world.sphereSweep = (b, dt, op) => sphereSweep(world, b, dt, op);
  world.getGroundY = (x, z, fromY) => getGroundY(world, x, z, fromY);
  world.findFloor = (x, z, op) => findFloor(world, x, z, op);
  world.lineOfSight = (a, b) => lineOfSight(world, a, b);
  world.overlapsCapsule = (x, y, z, r, h) => overlapsCapsule(world, x, y, z, r, h);
  world.canStand = (x, y, z, op) => canStand(world, x, y, z, op);
  return world;
}

/* ============================================================
 * 캐릭터 이동
 * ============================================================ */

const _qa = [], _qb = [], _qc = [], _qd = [], _qe = [];

/** 충돌체의 (x,z)에서의 윗면 높이 (원 반지름 r과 겹치지 않으면 null) */
function topUnderCircle(c, x, z, r) {
  if (c.kind === 'cyl') {
    const dx = x - c.x, dz = z - c.z, R = c.r + r;
    return dx * dx + dz * dz < R * R ? c.maxY : null;
  }
  const qx = clamp(x, c.minX, c.maxX), qz = clamp(z, c.minZ, c.maxZ);
  const dx = x - qx, dz = z - qz;
  if ((dx !== 0 || dz !== 0) && dx * dx + dz * dz >= r * r) return null;
  return c.kind === 'ramp' ? rampHeight(c, qx, qz) : c.maxY;
}

/** 원(x,z,r) 아래에서 limitY 이하인 가장 높은 윗면. 없으면 -Infinity */
function groundAt(world, x, z, r, limitY) {
  let best = -Infinity;
  if (world.floorY != null && world.floorY <= limitY) best = world.floorY;
  const list = world.query(x - r, z - r, x + r, z + r, _qb);
  for (let i = 0; i < list.length; i++) {
    const top = topUnderCircle(list[i], x, z, r);
    if (top !== null && top <= limitY && top > best) best = top;
  }
  return best;
}

/** 원(x,z,r) 위에서 fromY 이상에 바닥면이 있는 가장 낮은 천장. 없으면 Infinity */
function ceilingAt(world, x, z, r, fromY) {
  let best = Infinity;
  const list = world.query(x - r, z - r, x + r, z + r, _qc);
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (c.minY < fromY || c.minY >= best) continue;
    if (topUnderCircle(c, x, z, r) !== null) best = c.minY;
  }
  return best;
}

/** XZ 원 대 벽 밀어내기 (벽: 머리 아래에서 시작하고 윗면이 feet+stepAllow보다 높은 것) */
function resolveWalls(world, pos, vel, r, height, stepAllow, ev) {
  const reach = r + 0.6;
  const list = world.query(pos[0] - reach, pos[2] - reach, pos[0] + reach, pos[2] + reach, _qa);
  const feet = pos[1], head = feet + height - 0.01;
  for (let iter = 0; iter < 4; iter++) {
    let moved = false;
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (c.minY >= head) continue; // 머리 위
      let nx, nz, depth;
      if (c.kind === 'cyl') {
        if (c.maxY <= feet + stepAllow) continue;
        const dx = pos[0] - c.x, dz = pos[2] - c.z, R = c.r + r;
        const d2 = dx * dx + dz * dz;
        if (d2 >= R * R) continue;
        const d = Math.sqrt(d2);
        if (d > 1e-9) { nx = dx / d; nz = dz / d; }
        else {
          const vl = Math.hypot(vel[0], vel[2]);
          if (vl > 1e-9) { nx = -vel[0] / vl; nz = -vel[2] / vl; } else { nx = 1; nz = 0; }
        }
        depth = R - d;
      } else {
        const qx = clamp(pos[0], c.minX, c.maxX), qz = clamp(pos[2], c.minZ, c.maxZ);
        const cTop = c.kind === 'ramp' ? rampHeight(c, qx, qz) : c.maxY;
        if (cTop <= feet + stepAllow) continue; // 올라설 수 있는 높이
        const dx = pos[0] - qx, dz = pos[2] - qz;
        const d2 = dx * dx + dz * dz;
        if (d2 > 1e-14) {
          if (d2 >= r * r) continue;
          const d = Math.sqrt(d2);
          nx = dx / d; nz = dz / d; depth = r - d;
        } else {
          // 중심이 사각형 안: 가장 가까운 변으로
          const l = pos[0] - c.minX, rr = c.maxX - pos[0], b = pos[2] - c.minZ, f = c.maxZ - pos[2];
          let m = l; nx = -1; nz = 0;
          if (rr < m) { m = rr; nx = 1; nz = 0; }
          if (b < m) { m = b; nx = 0; nz = -1; }
          if (f < m) { m = f; nx = 0; nz = 1; }
          depth = m + r;
        }
      }
      pos[0] += nx * (depth + SKIN);
      pos[2] += nz * (depth + SKIN);
      const vn = vel[0] * nx + vel[2] * nz;
      if (vn < 0) { vel[0] -= vn * nx; vel[2] -= vn * nz; }
      moved = true;
      ev.walls++;
    }
    if (!moved) break;
  }
}

// 이번 틱의 수직 이동 속도(틱 시작·끝 속도의 평균 → 포물선을 정확히 따라감, 틱 빈도와 무관한 점프 높이)
const _mv = { vy: 0 };

function subStep(world, body, dt, r, height, step, ev) {
  const pos = body.pos, vel = body.vel;
  const wasGround = !!body.onGround;
  const stepAllow = wasGround ? step : step * AIR_STEP_FACTOR;

  // 1) 수평 이동 + 벽 미끄러짐
  pos[0] += vel[0] * dt;
  pos[2] += vel[2] * dt;
  resolveWalls(world, pos, vel, r, height, stepAllow, ev);

  // 2) 수직 이동 + 천장/바닥
  const feet = pos[1];
  const rr = r - 0.01;
  const ground = groundAt(world, pos[0], pos[2], rr, feet + stepAllow + 1e-4);
  let newY = feet + _mv.vy * dt;
  if (_mv.vy > 0) {
    const ceil = ceilingAt(world, pos[0], pos[2], rr, feet + height - 0.02);
    if (newY + height > ceil) {
      newY = Math.max(feet, ceil - height);
      vel[1] = 0; _mv.vy = 0;
      ev.ceiling = true;
    }
  }
  if (ground > -Infinity && newY <= ground) {
    if (!wasGround && (vel[1] < 0 || _mv.vy < 0)) { ev.landed = true; ev.impact = Math.max(ev.impact, -Math.min(vel[1], _mv.vy)); }
    if (wasGround && ground > feet + 0.01) ev.stepUp = Math.max(ev.stepUp, ground - feet);
    newY = ground;
    vel[1] = 0; _mv.vy = 0;
    body.onGround = true;
  } else if (wasGround && vel[1] <= 0 && ground > -Infinity && feet - ground <= step + 1e-4) {
    newY = ground; // 계단·경사로 내려가기: 바닥에 붙이기
    vel[1] = 0; _mv.vy = 0;
    body.onGround = true;
  } else {
    body.onGround = false;
  }
  pos[1] = newY;
}

/**
 * 캐릭터 1틱 이동 (body를 직접 수정).
 * @param world createWorld 결과
 * @param body { pos:[x,y,z] 발바닥, vel:[x,y,z], onGround:boolean }
 * @param wish { x, z: 원하는 수평 속도(m/s, 월드 좌표), jump?: boolean }
 * @param dt 초
 * @param [opt] { radius, height, step, gravity, jumpV, accel, friction, airAccel, maxFall, rawVelocity, nearFloor }
 *   rawVelocity: true면 수평 가속을 건너뛰고 body.vel을 그대로 쓴다(플레이어 이동 movement.js 전용, wish.x·z는 무시)
 *   nearFloor: true면 이번 틱은 공중이어도 턱을 지면 한도(step)까지 넘는다(플레이어 이동 movement.js 전용)
 * @returns {{jumped:boolean, landed:boolean, impact:number, ceiling:boolean, stepUp:number, walls:number}}
 */
export function moveCharacter(world, body, wish, dt, opt = {}) {
  const r = opt.radius ?? PLAYER.RADIUS;
  const height = opt.height ?? PLAYER.HEIGHT;
  const step = opt.step ?? PLAYER.STEP;
  const g = opt.gravity ?? PLAYER.GRAVITY;
  const maxFall = opt.maxFall ?? PLAYER.MAX_FALL;
  const ev = { jumped: false, landed: false, impact: 0, ceiling: false, stepUp: 0, walls: 0 };
  if (!(dt > 0)) return ev;
  const vel = body.vel, pos = body.pos;

  const grounded = !!body.onGround;
  // 수평 가속(지면: 빠르게 붙음 / 공중: 약한 조작). rawVelocity면 호출자(movement.js)가 수평 속도를 이미 정했다
  if (!opt.rawVelocity) {
    const wx = (wish && wish.x) || 0, wz = (wish && wish.z) || 0;
    const wishLen = Math.hypot(wx, wz);
    const accel = grounded
      ? (wishLen > 0.01 ? (opt.accel ?? 60) : (opt.friction ?? 45))
      : (wishLen > 0.01 ? (opt.airAccel ?? 10) : 0);
    if (accel > 0) {
      const dx = wx - vel[0], dz = wz - vel[2];
      const dl = Math.hypot(dx, dz), maxD = accel * dt;
      if (dl <= maxD) { vel[0] = wx; vel[2] = wz; } else { vel[0] += (dx / dl) * maxD; vel[2] += (dz / dl) * maxD; }
    }
  }

  if (wish && wish.jump && grounded) {
    vel[1] = opt.jumpV ?? PLAYER.JUMP_V;
    body.onGround = false;
    ev.jumped = true;
  }
  const vy0 = vel[1];
  if (!body.onGround) {
    vel[1] += g * dt;
    if (vel[1] < -maxFall) vel[1] = -maxFall;
    _mv.vy = (vy0 + vel[1]) / 2;
  } else {
    vel[1] = 0;
    _mv.vy = 0;
  }

  const maxComp = Math.max(Math.abs(vel[0]), Math.abs(vel[1]), Math.abs(_mv.vy), Math.abs(vel[2])) * dt;
  const n = clamp(Math.ceil(maxComp / MAX_SUB_MOVE), 1, 24);
  const sdt = dt / n;
  // subStep은 공중이면 step에 AIR_STEP_FACTOR를 곱한다. nearFloor면 그 곱을 상쇄해 공중에서도 지면과 같은 턱 한도를 쓴다
  const airStep = opt.nearFloor ? step / AIR_STEP_FACTOR : step;
  for (let i = 0; i < n; i++) subStep(world, body, sdt, r, height, body.onGround ? step : airStep, ev);

  // 안전장치: 플레이 영역 밖으로 못 나가게
  const b = world.bounds;
  if (b && Number.isFinite(b.minX)) {
    if (pos[0] < b.minX + r) { pos[0] = b.minX + r; if (vel[0] < 0) vel[0] = 0; }
    if (pos[0] > b.maxX - r) { pos[0] = b.maxX - r; if (vel[0] > 0) vel[0] = 0; }
    if (pos[2] < b.minZ + r) { pos[2] = b.minZ + r; if (vel[2] < 0) vel[2] = 0; }
    if (pos[2] > b.maxZ - r) { pos[2] = b.maxZ - r; if (vel[2] > 0) vel[2] = 0; }
  }
  return ev;
}

/** (x,z) 지점의 바닥 높이: fromY 이하의 가장 높은 윗면 (없으면 floorY 또는 0) */
export function getGroundY(world, x, z, fromY = Infinity, radius = 0) {
  const g = groundAt(world, x, z, radius, fromY);
  return g > -Infinity ? g : (world.floorY ?? 0);
}

/** 스폰용: 아래(지면)에서부터 키 height만큼 빈 공간이 있는 첫 바닥 높이 */
export function findFloor(world, x, z, opt = {}) {
  const r = opt.radius ?? 0.3;
  const h = opt.height ?? PLAYER.HEIGHT;
  let y = opt.fromY;
  if (y == null) {
    const g = groundAt(world, x, z, r, 0.05);
    y = g > -Infinity ? g : 0;
  }
  const list = world.query(x - r, z - r, x + r, z + r, _qd);
  for (let iter = 0; iter < 24; iter++) {
    let block = -Infinity;
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (c.minY >= y + h) continue;
      const top = topUnderCircle(c, x, z, r);
      if (top !== null && top > y + 0.01 && top > block) block = top;
    }
    if (block === -Infinity) return y;
    y = block;
  }
  return y;
}

/** 캡슐(원기둥)이 어떤 충돌체와 겹치는지 (바닥 윗면에 딱 닿는 것은 제외) */
/**
 * 앉은 자리에서 일어설 수 있는지(머리 위로 키 height까지 막는 것이 없는지).
 * opt: { radius = PLAYER.RADIUS, height = PLAYER.HEIGHT }. 벽에 붙어 있는 정도(반지름 − 2 cm)는 막힘으로 치지 않는다.
 */
export function canStand(world, x, y, z, opt = {}) {
  const r = (opt.radius ?? PLAYER.RADIUS) - 0.02;
  const h = opt.height ?? PLAYER.HEIGHT;
  return !overlapsCapsule(world, x, y, z, r, h);
}

export function overlapsCapsule(world, x, y, z, r = PLAYER.RADIUS, h = PLAYER.HEIGHT) {
  const list = world.query(x - r, z - r, x + r, z + r, _qd);
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (c.minY >= y + h) continue;
    const top = topUnderCircle(c, x, z, r);
    if (top !== null && top > y + 0.02) return true;
  }
  return false;
}

/* ============================================================
 * 레이캐스트
 * ============================================================ */

function normDir(d) {
  const l = Math.hypot(d[0], d[1], d[2]) || 1;
  return [d[0] / l, d[1] / l, d[2] / l];
}

// 결과 버퍼(할당 줄이기)
const _hit = { t: 0, nx: 0, ny: 0, nz: 0 };

/** 레이 vs AABB(slab). 맞으면 _hit 채우고 true */
function rayAabb(ox, oy, oz, dx, dy, dz, minX, minY, minZ, maxX, maxY, maxZ, maxT) {
  let tmin = -Infinity, tmax = maxT, nx = 0, ny = 0, nz = 0;
  if (Math.abs(dx) < 1e-12) { if (ox < minX || ox > maxX) return false; }
  else {
    const inv = 1 / dx;
    let t1 = (minX - ox) * inv, t2 = (maxX - ox) * inv, s = -1;
    if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; s = 1; }
    if (t1 > tmin) { tmin = t1; nx = s; ny = 0; nz = 0; }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return false;
  }
  if (Math.abs(dy) < 1e-12) { if (oy < minY || oy > maxY) return false; }
  else {
    const inv = 1 / dy;
    let t1 = (minY - oy) * inv, t2 = (maxY - oy) * inv, s = -1;
    if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; s = 1; }
    if (t1 > tmin) { tmin = t1; nx = 0; ny = s; nz = 0; }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return false;
  }
  if (Math.abs(dz) < 1e-12) { if (oz < minZ || oz > maxZ) return false; }
  else {
    const inv = 1 / dz;
    let t1 = (minZ - oz) * inv, t2 = (maxZ - oz) * inv, s = -1;
    if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; s = 1; }
    if (t1 > tmin) { tmin = t1; nx = 0; ny = 0; nz = s; }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return false;
  }
  if (tmax < 0) return false;
  if (tmin < 0) { _hit.t = 0; _hit.nx = -dx; _hit.ny = -dy; _hit.nz = -dz; return true; } // 시작점이 안
  _hit.t = tmin; _hit.nx = nx; _hit.ny = ny; _hit.nz = nz;
  return true;
}

/** 레이 vs 세로 원통 */
function rayCyl(ox, oy, oz, dx, dy, dz, c, maxT) {
  const rx = ox - c.x, rz = oz - c.z, R = c.r;
  let best = Infinity, nx = 0, ny = 0, nz = 0;
  const inside2D = rx * rx + rz * rz <= R * R;
  if (inside2D && oy >= c.minY && oy <= c.maxY) {
    _hit.t = 0; _hit.nx = -dx; _hit.ny = -dy; _hit.nz = -dz; return true;
  }
  const a = dx * dx + dz * dz;
  if (a > 1e-12 && !inside2D) {
    const b = 2 * (rx * dx + rz * dz), cc = rx * rx + rz * rz - R * R;
    const disc = b * b - 4 * a * cc;
    if (disc >= 0) {
      const t = (-b - Math.sqrt(disc)) / (2 * a);
      if (t >= 0 && t <= maxT) {
        const y = oy + dy * t;
        if (y >= c.minY && y <= c.maxY) { best = t; nx = (rx + dx * t) / R; ny = 0; nz = (rz + dz * t) / R; }
      }
    }
  }
  if (Math.abs(dy) > 1e-12) {
    // 윗면/아랫면
    const capY = oy > c.maxY ? c.maxY : oy < c.minY ? c.minY : null;
    if (capY !== null && ((capY === c.maxY && dy < 0) || (capY === c.minY && dy > 0))) {
      const t = (capY - oy) / dy;
      if (t >= 0 && t <= maxT && t < best) {
        const px = rx + dx * t, pz = rz + dz * t;
        if (px * px + pz * pz <= R * R) { best = t; nx = 0; ny = capY === c.maxY ? 1 : -1; nz = 0; }
      }
    }
  }
  if (best === Infinity) return false;
  _hit.t = best; _hit.nx = nx; _hit.ny = ny; _hit.nz = nz;
  return true;
}

/** 레이 vs 볼록 다면체(평면 목록) — Cyrus-Beck */
function rayPlanes(ox, oy, oz, dx, dy, dz, planes, maxT) {
  let tEnter = -Infinity, tExit = maxT, nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < planes.length; i++) {
    const p = planes[i];
    const denom = p[0] * dx + p[1] * dy + p[2] * dz;
    const dist = p[3] - (p[0] * ox + p[1] * oy + p[2] * oz);
    if (Math.abs(denom) < 1e-12) { if (dist < 0) return false; continue; }
    const t = dist / denom;
    if (denom < 0) { if (t > tEnter) { tEnter = t; nx = p[0]; ny = p[1]; nz = p[2]; } }
    else if (t < tExit) tExit = t;
    if (tEnter > tExit) return false;
  }
  if (tExit < 0) return false;
  if (tEnter < 0) { _hit.t = 0; _hit.nx = -dx; _hit.ny = -dy; _hit.nz = -dz; return true; }
  _hit.t = tEnter; _hit.nx = nx; _hit.ny = ny; _hit.nz = nz;
  return true;
}

/**
 * 월드 레이캐스트.
 * @returns {{dist:number, point:number[], normal:number[], mat:string, collider:object|null}|null}
 * opts: { includeHidden?: boolean (noRay 충돌체도 검사), filter?: (collider)=>boolean (false면 무시) }
 */
export function raycastWorld(world, origin, dir, maxDist = 1000, opts = null) {
  if (!world) return null;
  const d = normDir(dir);
  const ox = origin[0], oy = origin[1], oz = origin[2], dx = d[0], dy = d[1], dz = d[2];
  let best = maxDist, found = false, bnx = 0, bny = 0, bnz = 0, bmat = null, bc = null;
  if (world.floorY != null && dy < -1e-9 && oy >= world.floorY) {
    const t = (world.floorY - oy) / dy;
    if (t <= best) { best = t; found = true; bnx = 0; bny = 1; bnz = 0; bmat = world.groundMat; }
  }
  const cols = world.colliders;
  const includeHidden = !!(opts && opts.includeHidden);
  const filter = opts && opts.filter;
  for (let i = 0; i < cols.length; i++) {
    const c = cols[i];
    if (c.noRay && !includeHidden) continue;
    if (filter && filter(c) === false) continue;
    // bbox 빠른 거르기 (박스는 이것이 곧 결과)
    if (!rayAabb(ox, oy, oz, dx, dy, dz, c.minX, c.minY, c.minZ, c.maxX, c.maxY, c.maxZ, best)) continue;
    if (c.kind === 'cyl') { if (!rayCyl(ox, oy, oz, dx, dy, dz, c, best)) continue; }
    else if (c.kind === 'ramp') { if (!rayPlanes(ox, oy, oz, dx, dy, dz, c.planes, best)) continue; }
    if (_hit.t <= best) {
      best = _hit.t; found = true; bnx = _hit.nx; bny = _hit.ny; bnz = _hit.nz; bmat = c.mat; bc = c;
    }
  }
  if (!found) return null;
  const nl = Math.hypot(bnx, bny, bnz) || 1;
  return {
    dist: best,
    point: [ox + dx * best, oy + dy * best, oz + dz * best],
    normal: [bnx / nl, bny / nl, bnz / nl],
    mat: bmat,
    collider: bc
  };
}

/** 레이 vs 구 (rx..: 레이 시작점 − 구 중심) → t 또는 -1 */
function raySphere(rx, ry, rz, dx, dy, dz, r) {
  const b = rx * dx + ry * dy + rz * dz;
  const c = rx * rx + ry * ry + rz * rz - r * r;
  if (c <= 0) return 0; // 안에서 시작
  if (b > 0) return -1;
  const disc = b * b - c;
  if (disc < 0) return -1;
  return -b - Math.sqrt(disc);
}

/** 대상의 crouch 값 → 0..1 (true = 1, 숫자는 자세 전환 중 비율) */
function crouchK(v) {
  if (v === true) return 1;
  const n = +v;
  return n > 0 ? (n >= 1 ? 1 : n) : 0;
}

/** 세로축에서 가장 먼 판정까지의 수평 거리(m). 손은 몸 앞으로 나와 있어 몸통 크기만 보면 넓은 거르기에서 빠진다 */
function hitboxReach(S) {
  const boxReach = (b) => Math.hypot(b.hw, b.hd + Math.abs(b.cz || 0));
  let reach = Math.max(S.HEAD.r, boxReach(S.BODY), boxReach(S.LEGS), boxReach(S.FOOT));
  for (const h of S.HANDS) reach = Math.max(reach, Math.hypot(h.x, h.z) + h.r);
  return reach;
}
// 상수에서 계산하므로 히트박스 수치를 고쳐도 넓은 거르기가 판정을 잘라 먹지 않는다. 자세 전환은 두 표 사이를 섞으므로 큰 쪽이면 충분하다
const BROAD_REACH = Math.max(hitboxReach(HITBOX), hitboxReach(HITBOX_CROUCH)) + 0.01;
const BROAD_REACH2 = BROAD_REACH * BROAD_REACH;

/**
 * 플레이어 히트박스 레이캐스트 (월드 차단은 고려하지 않음 — traceShot 사용 권장).
 * 머리·몸·다리·발 중 레이가 가장 먼저 닿은 곳이 결과다. 머리와 손은 구, 몸·다리·발은 상자다.
 * 손은 탄이 손만 스칠 때만 결과가 된다. 같은 사람의 다른 부위가 그 뒤에 있으면 그 부위로 친다.
 * 총을 쥔 손은 가슴 앞에 있어서, 이렇게 하지 않으면 정면에서 가슴 한가운데를 쏴도 저격 반샷이 나온다.
 * 벽이 몸을 가리고 손만 나와 있으면 maxDist가 벽에서 끊겨 손으로 판정된다.
 * 몸·다리·발 상자와 손 구는 대상의 yaw로 함께 돌고, 머리는 세로축 위에 있어 돌지 않는다.
 * @param targets [{ id, pos:[x,y,z](발바닥), yaw?:number, alive?:boolean, crouch?:boolean|number }]
 *   crouch: true(또는 1)면 HITBOX_CROUCH, 0..1 사이면 서 있는/앉은 히트박스를 그 비율로 섞는다(자세 전환 중)
 * @param opts { ignoreId? }
 * @returns {{id, part:'head'|'body'|'legs'|'hand'|'foot', dist:number, point:number[], target:object}|null}
 */
export function raycastPlayers(origin, dir, maxDist = 1000, targets = [], opts = null) {
  if (!targets || !targets.length) return null;
  const d = normDir(dir);
  const ox = origin[0], oy = origin[1], oz = origin[2], dx = d[0], dy = d[1], dz = d[2];
  const ignoreId = opts && opts.ignoreId != null ? opts.ignoreId : undefined;
  const H = HITBOX.HEAD, B = HITBOX.BODY, L = HITBOX.LEGS, F = HITBOX.FOOT, HS = HITBOX.HANDS;
  const HC = HITBOX_CROUCH.HEAD, BC = HITBOX_CROUCH.BODY, LC = HITBOX_CROUCH.LEGS, FC = HITBOX_CROUCH.FOOT, HSC = HITBOX_CROUCH.HANDS;
  let best = maxDist, hitT = null, hitPart = null;
  for (let i = 0; i < targets.length; i++) {
    const tg = targets[i];
    if (!tg || tg.alive === false || (ignoreId !== undefined && tg.id === ignoreId)) continue;
    const p = tg.pos;
    const px = p[0] ?? p.x, py = p[1] ?? p.y, pz = p[2] ?? p.z;
    const rx = ox - px, ry = oy - py, rz = oz - pz;
    // 넓은 거르기: 세로축까지의 2D 거리가 BROAD_REACH보다 멀면 패스
    const a2 = dx * dx + dz * dz;
    if (a2 > 1e-9) {
      const tc = -(rx * dx + rz * dz) / a2;
      const cx = rx + dx * Math.max(0, tc), cz = rz + dz * Math.max(0, tc);
      if (cx * cx + cz * cz > BROAD_REACH2) continue;
    } else if (rx * rx + rz * rz > BROAD_REACH2) continue;

    // 앉음 비율 k로 서 있는/앉은 히트박스 섞기 (hw·hd는 같음)
    const k = crouchK(tg.crouch);
    const headY = H.y + (HC.y - H.y) * k, headR = H.r + (HC.r - H.r) * k;
    const by0 = B.y0 + (BC.y0 - B.y0) * k, by1 = B.y1 + (BC.y1 - B.y1) * k;
    const ly0 = L.y0 + (LC.y0 - L.y0) * k, ly1 = L.y1 + (LC.y1 - L.y1) * k;
    const fy0 = F.y0 + (FC.y0 - F.y0) * k, fy1 = F.y1 + (FC.y1 - F.y1) * k;
    const fz = (F.cz || 0) + ((FC.cz || 0) - (F.cz || 0)) * k;

    let coreT = best, corePart = null;
    const th = raySphere(rx, ry - headY, rz, dx, dy, dz, headR);
    if (th >= 0 && th < coreT) { coreT = th; corePart = 'head'; }

    const yaw = tg.yaw || 0, cs = Math.cos(yaw), sn = Math.sin(yaw);
    // 월드 → 로컬 (rotation.y = yaw 의 역회전). 아래 부위는 모두 이 로컬 좌표에서 잰다
    const lox = rx * cs - rz * sn, loz = rx * sn + rz * cs;
    const ldx = dx * cs - dz * sn, ldz = dx * sn + dz * cs;
    if (rayAabb(lox, ry, loz, ldx, dy, ldz, -B.hw, by0, -B.hd, B.hw, by1, B.hd, coreT) && _hit.t < coreT) {
      coreT = _hit.t; corePart = 'body';
    }
    if (rayAabb(lox, ry, loz, ldx, dy, ldz, -L.hw, ly0, -L.hd, L.hw, ly1, L.hd, coreT) && _hit.t < coreT) {
      coreT = _hit.t; corePart = 'legs';
    }
    if (rayAabb(lox, ry, loz, ldx, dy, ldz, -F.hw, fy0, fz - F.hd, F.hw, fy1, fz + F.hd, coreT) && _hit.t < coreT) {
      coreT = _hit.t; corePart = 'foot';
    }
    if (corePart) { best = coreT; hitT = tg; hitPart = corePart; continue; }
    for (let h = 0; h < HS.length; h++) {
      const a = HS[h], c = HSC[h];
      const hx = a.x + (c.x - a.x) * k, hy = a.y + (c.y - a.y) * k, hz = a.z + (c.z - a.z) * k, hr = a.r + (c.r - a.r) * k;
      const t = raySphere(lox - hx, ry - hy, loz - hz, ldx, dy, ldz, hr);
      if (t >= 0 && t < best) { best = t; hitT = tg; hitPart = 'hand'; }
    }
  }
  if (!hitT) return null;
  return { id: hitT.id, part: hitPart, dist: best, point: [ox + dx * best, oy + dy * best, oz + dz * best], target: hitT };
}

/**
 * 사격 판정: 월드가 먼저 막으면 플레이어를 맞히지 않는다.
 * @returns { kind:'player', id, part:'head'|'body'|'legs'|'hand'|'foot', dist, point, target } | { kind:'world', dist, point, normal, mat, collider } | { kind:'none', dist, point }
 */
export function traceShot(world, origin, dir, maxDist = 1000, targets = [], opts = null) {
  const w = world ? raycastWorld(world, origin, dir, maxDist, opts) : null;
  const p = raycastPlayers(origin, dir, w ? w.dist : maxDist, targets, opts);
  if (p) return Object.assign({ kind: 'player' }, p);
  if (w) return Object.assign({ kind: 'world' }, w);
  const d = normDir(dir);
  return { kind: 'none', dist: maxDist, point: [origin[0] + d[0] * maxDist, origin[1] + d[1] * maxDist, origin[2] + d[2] * maxDist] };
}

/** a→b 사이에 막는 월드가 없으면 true (수류탄 엄폐 체크 등). opts는 raycastWorld와 같다(예: { filter } 로 일부 충돌체를 뺀다) */
export function lineOfSight(world, a, b, opts = null) {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-6) return true;
  const hit = raycastWorld(world, a, [dx, dy, dz], len, opts);
  return !hit || hit.dist >= len - 1e-3;
}

/* ============================================================
 * 구 스윕 (수류탄 바운스)
 * ============================================================ */

const _ct = { nx: 0, ny: 0, nz: 0, depth: 0, mat: null };

/** 구(p, r)의 가장 깊은 접촉 → _ct 채우고 true */
function sphereContact(world, px, py, pz, r) {
  let bestDepth = 0, found = false;
  if (world.floorY != null && py - r < world.floorY) {
    bestDepth = world.floorY - (py - r); found = true;
    _ct.nx = 0; _ct.ny = 1; _ct.nz = 0; _ct.mat = world.groundMat;
  }
  const list = world.query(px - r, pz - r, px + r, pz + r, _qe);
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    // clip 막이(점프 방지용 보이지 않는 벽)는 수류탄이 통과한다. 외곽 벽(tag 'bounds')은 그대로 튕긴다
    if (c.tag === 'clip') continue;
    if (py + r < c.minY || py - r > c.maxY) continue;
    let nx = 0, ny = 0, nz = 0, depth = -1;
    if (c.kind === 'box') {
      const qx = clamp(px, c.minX, c.maxX), qy = clamp(py, c.minY, c.maxY), qz = clamp(pz, c.minZ, c.maxZ);
      const dx = px - qx, dy = py - qy, dz = pz - qz, d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > 1e-14) {
        if (d2 >= r * r) continue;
        const d = Math.sqrt(d2); nx = dx / d; ny = dy / d; nz = dz / d; depth = r - d;
      } else {
        const faces = [px - c.minX, c.maxX - px, py - c.minY, c.maxY - py, pz - c.minZ, c.maxZ - pz];
        let m = 0;
        for (let k = 1; k < 6; k++) if (faces[k] < faces[m]) m = k;
        nx = m === 0 ? -1 : m === 1 ? 1 : 0; ny = m === 2 ? -1 : m === 3 ? 1 : 0; nz = m === 4 ? -1 : m === 5 ? 1 : 0;
        depth = faces[m] + r;
      }
    } else if (c.kind === 'cyl') {
      const hx = px - c.x, hz = pz - c.z, h = Math.hypot(hx, hz);
      const qy = clamp(py, c.minY, c.maxY);
      if (h <= c.r && py >= c.minY && py <= c.maxY) {
        const side = c.r - h, top = c.maxY - py, bot = py - c.minY;
        if (side <= top && side <= bot) { nx = h > 1e-9 ? hx / h : 1; nz = h > 1e-9 ? hz / h : 0; depth = side + r; }
        else if (top <= bot) { ny = 1; depth = top + r; } else { ny = -1; depth = bot + r; }
      } else {
        const qx = h > c.r ? c.x + (hx / h) * c.r : px, qz = h > c.r ? c.z + (hz / h) * c.r : pz;
        const dx = px - qx, dy = py - qy, dz = pz - qz, d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= r * r || d2 < 1e-14) continue;
        const d = Math.sqrt(d2); nx = dx / d; ny = dy / d; nz = dz / d; depth = r - d;
      }
    } else {
      // ramp: 평면 부호거리 최댓값(근사)
      let smax = -Infinity, pi = -1;
      const planes = c.planes;
      for (let k = 0; k < planes.length; k++) {
        const pl = planes[k], s = pl[0] * px + pl[1] * py + pl[2] * pz - pl[3];
        if (s > smax) { smax = s; pi = k; }
      }
      if (smax >= r) continue;
      nx = planes[pi][0]; ny = planes[pi][1]; nz = planes[pi][2]; depth = r - smax;
    }
    if (depth > bestDepth) {
      bestDepth = depth; found = true;
      _ct.nx = nx; _ct.ny = ny; _ct.nz = nz; _ct.mat = c.mat;
    }
  }
  _ct.depth = bestDepth;
  return found;
}

/**
 * 구 스윕 + 바운스 (수류탄). body를 직접 수정.
 * @param body { pos:[x,y,z], vel:[x,y,z] }
 * @param opt { radius=0.07, gravity=PLAYER.GRAVITY, restitution=0.38, friction=0.7(충돌 시 접선 속도 유지율) }
 * @returns {{ hits: {point:number[], normal:number[], speed:number, mat:string}[], resting:boolean }}
 */
export function sphereSweep(world, body, dt, opt = {}) {
  const r = opt.radius ?? 0.07;
  const g = opt.gravity ?? PLAYER.GRAVITY;
  const e = opt.restitution ?? 0.38;
  const fr = opt.friction ?? 0.7;
  const pos = body.pos, vel = body.vel;
  const res = { hits: [], resting: false };
  if (!(dt > 0)) return res;
  vel[1] += g * dt;
  const speed = Math.hypot(vel[0], vel[1], vel[2]);
  const n = clamp(Math.ceil((speed * dt) / (r * 0.9)), 1, 64);
  const sdt = dt / n;
  let floorContact = false;
  for (let i = 0; i < n; i++) {
    pos[0] += vel[0] * sdt; pos[1] += vel[1] * sdt; pos[2] += vel[2] * sdt;
    for (let iter = 0; iter < 4; iter++) {
      if (!sphereContact(world, pos[0], pos[1], pos[2], r)) break;
      const nx = _ct.nx, ny = _ct.ny, nz = _ct.nz;
      pos[0] += nx * (_ct.depth + 1e-4); pos[1] += ny * (_ct.depth + 1e-4); pos[2] += nz * (_ct.depth + 1e-4);
      const vn = vel[0] * nx + vel[1] * ny + vel[2] * nz;
      if (ny > 0.6) floorContact = true;
      if (vn < 0) {
        const impact = -vn;
        // 접선 성분
        let tx = vel[0] - vn * nx, ty = vel[1] - vn * ny, tz = vel[2] - vn * nz;
        if (impact < 1.2 && ny > 0.6) {
          // 굴러가다 멈춤: 튀지 않고 마찰
          const k = Math.max(0, 1 - 6 * sdt);
          vel[0] = tx * k; vel[1] = ty * k; vel[2] = tz * k;
        } else {
          tx *= fr; ty *= fr; tz *= fr;
          vel[0] = tx - vn * e * nx; vel[1] = ty - vn * e * ny; vel[2] = tz - vn * e * nz;
          if (impact > 1.0) {
            res.hits.push({ point: [pos[0] - nx * r, pos[1] - ny * r, pos[2] - nz * r], normal: [nx, ny, nz], speed: impact, mat: _ct.mat });
          }
        }
      }
    }
  }
  res.resting = floorContact && Math.hypot(vel[0], vel[1], vel[2]) < 0.2;
  if (res.resting) { vel[0] = 0; vel[1] = 0; vel[2] = 0; }
  return res;
}
