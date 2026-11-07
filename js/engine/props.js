/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 맵 props(상자·드럼통)를 cannon-es 강체로 움직이는 표시 전용 소품. 판정·이동·네트워크에 영향이 없고,
 *          cannon-es를 불러오지 못하면 고정 소품으로 대체한다. 앞부분의 순수 도우미는 node에서 바로 테스트한다.
 */
import { LIMITS, PLAYER } from '../core/consts.js';
import { createLogger } from '../core/log.js';

const log = createLogger('props');

/*
 * 사용법 (docs/DESIGN.md 10절)
 *   const props = createProps({ THREE, scene, getMapData, getColliders, getPlayerPos, quality });
 *   props.load(mapData, colliders);         // 맵 로드 직후(Promise, 거부되지 않음). 인자를 생략하면 getMapData()·getColliders()
 *   props.update(dt);                       // 매 프레임
 *   props.explode(center, radius, power);   // 폭발. power = 중심 충격량(N·s), 생략 가능
 *   props.bulletHit(origin, dir, maxDist);  // 사격. 맞힌 소품이 있으면 true. maxDist에 실제 명중 거리를 넘기면 벽 뒤 소품은 안 맞는다
 *   props.setQuality(level);                // 'low' | 그 외
 *   props.clear();  props.dispose();  props.stats();
 *
 * 맵 데이터: { type: 'crate'|'barrel', x, y, z, size?, mass? }
 *   y = 밑면 높이, size = 상자 모서리·드럼통 높이(m), mass = kg. 벡터 인자는 [x,y,z]와 {x,y,z} 모두 받는다.
 *
 * 소품은 총알을 막지 않고 플레이어도 밀어내지 않는다. 플레이어는 소품을 살살 미는 키네마틱 구 두 개다.
 */

/* ---------------- 조정값 ---------------- */

const STEP = 1 / 60;              // 고정 스텝(초)

const PROP_TYPES = Object.freeze({
  crate: Object.freeze({ kind: 'box', size: 0.9, density: 25 }),    // size = 모서리. 속이 빈 나무 상자
  barrel: Object.freeze({ kind: 'cyl', size: 1.0, density: 90 })    // size = 높이. 반쯤 찬 드럼통
});
const BARREL_RADIUS = 0.31;       // 드럼통 반지름 = 높이 × 이 값
const SIZE_MIN = 0.25, SIZE_MAX = 3;
const MASS_MIN = 2, MASS_MAX = 200;
const PROP_TINTS = Object.freeze({
  box: Object.freeze([0xffffff, 0xeadfca, 0xd3c6ae, 0xf3e7d3]),
  cyl: Object.freeze([0xc8453a, 0x3f71b5, 0x63804a, 0xd9aa3c])
});

// 정적 세계: 소품에서 이만큼(m) 안쪽의 충돌체만 강체로 만든다. 폭발로 날아가는 거리를 덮는 값
const NEAR_MARGIN = 12;
const OPEN_MARGIN = 30;           // 외곽 벽이 없는 맵: 소품·충돌체 범위를 이만큼 벗어나면 세계 밖
const FALL_MARGIN = 8;            // 가장 낮은 충돌체보다 이만큼 아래면 세계 밖
const RESPAWN_GUARD_STEPS = 240;  // 복귀한 지 이 스텝(4초) 안에 또 떨어지면 시작 자리가 구멍 위다 → 끝없이 떨어지지 않게 재운다
const MAX_AWAKE_STEPS = 600;      // 외부 충격 없이 이 스텝(10초) 넘게 깨어 있으면 벽 틈에 끼어 떨리는 것으로 보고 재운다
const BARREL_SEGMENTS = 10, CYL_SEGMENTS = 12;

// cannon-es 마찰 상한은 접촉점마다 스텝당 충격량(μ·g·m)이다. 실제 마찰계수를 넣으면 상자가 바닥에 붙어 버리므로
// '실제 계수 × 스텝 길이 ÷ 접촉점 수(상자 4)'로 맞춘다. enableFrictionReduction은 팔 길이를 뒤바꿔 원점에서 멀수록
// 마찰이 사라지므로(0.20.0) 쓰지 않는다.
const PROP_FRICTION = (0.5 * STEP) / 4;
const PROP_RESTITUTION = 0.12;
const LINEAR_DAMPING = 0.05, ANGULAR_DAMPING = 0.35;
// 잠들기 기준 속력은 한 스텝의 중력 속도(16/60 ≈ 0.27 m/s)보다 커야 한다. 솔버 반복이 적으면 접촉이 잠깐 떨어지는데,
// 그때마다 다시 깨어 끝내 잠들지 못한다
const SLEEP_SPEED = 0.35, SLEEP_TIME = 0.4;
const SOLVER_TOLERANCE = 1e-3;
const MAX_SPEED = 14;             // m/s. 스텝당 23 cm → 벽을 뚫지 않는다
const MAX_SPIN = 18;              // rad/s

// 플레이어(키네마틱): 부드러운 접촉 + 속도 제한으로 살살 민다
const PLAYER_SPHERES = Object.freeze([0.45, 1.25]);   // 발바닥 위 높이
const PUSH_STIFFNESS = 3000, PUSH_RELAXATION = 5;
const PUSH_MAX_SPEED = 2.2;       // 접촉 계산에 쓰는 플레이어 속도 상한(m/s). 실제 위치는 그대로 따라간다
const PUSH_PROP_SPEED = 3;        // 플레이어가 밀어서 낼 수 있는 소품 수평 속력(m/s). 가벼운 상자도 차 날리지 않는다
const TELEPORT_DIST = 3;          // 한 스텝에 이보다 멀면 부활·포털로 보고 속도 없이 옮긴다
const PARK_Y = -1000;             // 플레이어가 없을 때 치워 두는 높이
const NEAR_PAD = 0.6;             // 잠든 소품을 깨울 수 있는 플레이어 거리 여유

const BLAST_RADIUS = 6, BLAST_POWER = 240;            // 기본 폭발 반경(m)·중심 충격량(N·s)
const BLAST_LIFT = 0.45;          // 폭발 방향에 더하는 위쪽 성분
const BLAST_MAX_SPEED = 10;       // 폭발이 주는 속력 상한(m/s). 가벼운 소품도 맵 끝까지 날아가지 않는다
const BULLET_IMPULSE = 18;        // 총알 충격량(N·s). 18 kg 상자가 약 1 m/s
const BULLET_RANGE = 300;
const LOW_SETTLE_STEPS = 180;     // 저사양 활성 제한을 시작하기 전 맵 시작 안정화(스텝)
const SLOW_SPEED2 = 1.44;         // 저사양 활성 제한으로 재울 수 있는 속력²

const G_PROP = 1, G_STATIC = 2, G_PLAYER = 4;

/* ---------------- 순수 도우미 (three.js·cannon-es 없음) ---------------- */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const vecX = (v) => (v ? (v[0] ?? v.x) : NaN);
const vecY = (v) => (v ? (v[1] ?? v.y) : NaN);
const vecZ = (v) => (v ? (v[2] ?? v.z) : NaN);

/** 소품 종류·크기 → 형태. kind 'box'는 반폭 hx·hy·hz, 'cyl'은 반지름 hx(=hz)와 반높이 hy. 모르는 종류면 null */
export function propShape(type, size) {
  if (type !== 'crate' && type !== 'barrel') return null;
  const t = PROP_TYPES[type];
  const s = clamp(finite(size) && size > 0 ? size : t.size, SIZE_MIN, SIZE_MAX);
  if (t.kind === 'cyl') return { kind: 'cyl', hx: s * BARREL_RADIUS, hy: s / 2, hz: s * BARREL_RADIUS };
  return { kind: 'box', hx: s / 2, hy: s / 2, hz: s / 2 };
}

/** 질량(kg): 지정값 또는 부피 × 밀도, 범위 안으로 */
export function propMass(type, shape, mass) {
  if (finite(mass) && mass > 0) return clamp(mass, MASS_MIN, MASS_MAX);
  const volume = shape.kind === 'cyl'
    ? Math.PI * shape.hx * shape.hx * shape.hy * 2
    : shape.hx * shape.hy * shape.hz * 8;
  return clamp(volume * PROP_TYPES[type].density, MASS_MIN, MASS_MAX);
}

/** 맵 props → 검증된 명세 목록. 잘못된 항목은 건너뛰고 limit개에서 자른다 */
export function normalizeProps(list, limit = LIMITS.PROPS) {
  const out = [];
  if (!Array.isArray(list)) return out;
  const cap = Math.min(limit, LIMITS.PROPS);
  for (let i = 0; i < list.length && out.length < cap; i++) {
    const p = list[i];
    if (!p || typeof p !== 'object' || !finite(p.x) || !finite(p.z)) continue;
    const shape = propShape(p.type, p.size);
    if (!shape) continue;
    out.push({ type: p.type, x: p.x, y: finite(p.y) ? p.y : 0, z: p.z, ...shape, mass: propMass(p.type, shape, p.mass) });
  }
  return out;
}

/** 품질 → 시뮬레이션 예산. maxActive = 동시에 깨어 있을 소품 수 */
export function qualityProfile(level) {
  return level === 'low'
    ? { maxActive: 12, iterations: 5, maxSubSteps: 2, maxStatic: 60 }
    : { maxActive: LIMITS.PROPS, iterations: 10, maxSubSteps: 3, maxStatic: 160 };
}

/**
 * 바닥 평면 높이. 평면이 상자 충돌체보다 싸고 안정적이므로 구멍이 없을 때는 평면을 쓴다.
 * 바닥 슬래브가 없으면 y=0(physics의 floorY와 같음), 슬래브 1장이면 그 윗면, 구멍(builder.js 기준)이 있으면 null → 슬래브를 상자로 쓴다.
 */
export function groundPlaneY(colliders) {
  if (!Array.isArray(colliders)) return 0;
  let slabs = 0, top = 0, holes = 0;
  for (const c of colliders) {
    if (!c) continue;
    if (c.tag === 'ground') { slabs++; top = c.maxY; } else if (c.kind === 'box' && c.maxY <= 0.05 && c.minY < -0.001) holes++;
  }
  if (!slabs) return 0;
  return slabs === 1 && !holes ? top : null;
}

function distToBox(c, x, y, z) {
  const dx = x < c.minX ? c.minX - x : x > c.maxX ? x - c.maxX : 0;
  const dy = y < c.minY ? c.minY - y : y > c.maxY ? y - c.maxY : 0;
  const dz = z < c.minZ ? c.minZ - z : z > c.maxZ ? z - c.maxZ : 0;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * 소품과 부딪히는 충돌체인가. clip 막이와 물은 빼고(수류탄처럼 clip을 통과하고, 물에 빠지면 가라앉아 제자리로 돌아온다),
 * planeY가 null이 아니면 바닥 슬래브도 평면이 대신하므로 뺀다.
 */
function isPropSolid(c, planeY) {
  if (!c || (c.kind !== 'box' && c.kind !== 'cyl' && c.kind !== 'ramp')) return false;
  if (c.tag === 'clip' || c.mat === 'water') return false;
  return !(c.tag === 'ground' && planeY !== null);
}

/**
 * 강체로 만들 충돌체 고르기. 외곽 벽(tag 'bounds')은 항상, 나머지는 소품 근처에서 가까운 순으로 max개까지.
 * opt: { margin, max, planeY }
 */
export function selectStaticColliders(colliders, specs, opt = {}) {
  const margin = opt.margin ?? NEAR_MARGIN;
  const max = opt.max ?? Infinity;
  const planeY = opt.planeY ?? null;
  const always = [], near = [];
  if (!Array.isArray(colliders)) return always;
  for (const c of colliders) {
    if (!isPropSolid(c, planeY)) continue;
    if (c.tag === 'bounds') { always.push(c); continue; }
    let dist = Infinity;
    for (const s of specs) dist = Math.min(dist, distToBox(c, s.x, s.y + s.hy, s.z));
    if (dist <= margin) near.push({ c, dist });
  }
  near.sort((a, b) => a.dist - b.dist);
  for (let i = 0; i < near.length && i < max; i++) always.push(near[i].c);
  return always;
}

/**
 * 경사로 collider → 볼록 쐐기. vertices는 center 기준 좌표, faces는 바깥에서 볼 때 반시계(cannon-es 규칙).
 * 경사면은 physics.rampHeight와 같은 평면이다.
 */
export function rampWedge(c) {
  const alongX = c.dir === '+x' || c.dir === '-x';
  const rising = c.dir === '+x' || c.dir === '+z';
  const a0 = alongX ? c.minX : c.minZ, a1 = alongX ? c.maxX : c.maxZ;
  const b0 = alongX ? c.minZ : c.minX, b1 = alongX ? c.maxZ : c.maxX;
  const lo = rising ? a0 : a1, hi = rising ? a1 : a0;
  const at = (a, y, b) => (alongX ? [a, y, b] : [b, y, a]);
  const world = [at(lo, c.minY, b0), at(lo, c.minY, b1), at(hi, c.minY, b0), at(hi, c.minY, b1), at(hi, c.maxY, b0), at(hi, c.maxY, b1)];
  const center = [0, 1, 2].map((k) => world.reduce((sum, v) => sum + v[k], 0) / world.length);
  const vertices = world.map((v) => [v[0] - center[0], v[1] - center[1], v[2] - center[2]]);
  const faces = [[0, 1, 3, 2], [2, 3, 5, 4], [0, 4, 5, 1], [0, 2, 4], [1, 5, 3]].map((f) => outwardFace(f, vertices));
  return { center, vertices, faces };
}

function outwardFace(face, vertices) {
  const [a, b, c] = [vertices[face[0]], vertices[face[1]], vertices[face[2]]];
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], bc = [c[0] - b[0], c[1] - b[1], c[2] - b[2]];
  const n = [ab[1] * bc[2] - ab[2] * bc[1], ab[2] * bc[0] - ab[0] * bc[2], ab[0] * bc[1] - ab[1] * bc[0]];
  return n[0] * a[0] + n[1] * a[1] + n[2] * a[2] < 0 ? face.slice().reverse() : face;
}

/** 프레임 시간을 누적하되 maxSub 스텝을 넘지 않게 자른다(긴 프레임이 시뮬레이션을 밀리게 하지 않는다) */
export function clampAccumulator(acc, dt, step, maxSub) {
  const next = acc + (finite(dt) && dt > 0 ? dt : 0);
  const cap = step * maxSub;
  return next > cap ? cap : next;
}

/** 폭발 충격량: 중심에서 power, 반경에서 0으로 선형 감소 */
export function blastImpulse(dist, radius, power) {
  if (!(radius > 0) || !(power > 0) || !(dist < radius)) return 0;
  return power * (1 - (dist > 0 ? dist : 0) / radius);
}

/**
 * 소품이 제자리로 돌아오는 세계 범위. 외곽 벽이 있으면 벽 바깥이 곧 세계 밖이고(벽을 뚫은 경우),
 * 없으면 평면 바닥 위를 어디까지나 미끄러질 수 있으므로 넉넉히 둔다.
 */
export function worldLimits(colliders, specs) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, minY = 0;
  let walled = false;
  const grow = (x0, x1, z0, z1) => {
    if (x0 < minX) minX = x0;
    if (x1 > maxX) maxX = x1;
    if (z0 < minZ) minZ = z0;
    if (z1 > maxZ) maxZ = z1;
  };
  if (Array.isArray(colliders)) {
    for (const c of colliders) {
      if (!c || !finite(c.minX) || !finite(c.maxX) || !finite(c.minZ) || !finite(c.maxZ)) continue;
      grow(c.minX, c.maxX, c.minZ, c.maxZ);
      if (c.tag === 'bounds') walled = true;
      else if (finite(c.minY) && c.minY < minY) minY = c.minY;
    }
  }
  for (const s of specs) {
    grow(s.x, s.x, s.z, s.z);
    if (s.y < minY) minY = s.y;
  }
  const m = walled ? 0 : OPEN_MARGIN;
  return { minX: minX - m, maxX: maxX + m, minZ: minZ - m, maxZ: maxZ + m, minY: minY - FALL_MARGIN };
}

/** 세계 밖인가 (NaN도 밖으로 친다) */
export function isOutOfWorld(x, y, z, lim) {
  return !(y >= lim.minY && x >= lim.minX && x <= lim.maxX && z >= lim.minZ && z <= lim.maxZ);
}

/* ---------------- 절차적 텍스처 ---------------- */

function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function paintCrate(ctx, S) {
  const rand = seededRandom(41);
  const planks = 5, pw = S / planks;
  for (let i = 0; i < planks; i++) {
    const t = 0.88 + rand() * 0.22;
    ctx.fillStyle = `rgb(${Math.round(176 * t)}, ${Math.round(134 * t)}, ${Math.round(86 * t)})`;
    ctx.fillRect(i * pw, 0, pw, S);
    for (let k = 0; k < 16; k++) {
      ctx.fillStyle = `rgba(66, 40, 18, ${0.05 + rand() * 0.12})`;
      ctx.fillRect(i * pw + rand() * pw, 0, 1 + rand() * 2, S);
    }
    ctx.fillStyle = 'rgba(28, 16, 6, 0.75)';
    ctx.fillRect(i * pw - 1, 0, 2, S);
  }
  // 대각 보강재와 테두리
  const bw = S * 0.14;
  const board = (fn) => {
    ctx.fillStyle = '#8f6a3e';
    fn(0);
    ctx.fillStyle = 'rgba(255, 226, 170, 0.18)';
    fn(-2);
    ctx.fillStyle = 'rgba(24, 14, 6, 0.5)';
    fn(2);
    ctx.fillStyle = '#8f6a3e';
    fn(0, 3);
  };
  ctx.save();
  ctx.translate(S / 2, S / 2);
  ctx.rotate(Math.PI / 4);
  board((off, inset = 0) => ctx.fillRect(-S * 0.72, -bw / 2 + off + inset, S * 1.44, bw - inset * 2));
  ctx.restore();
  board((off, inset = 0) => ctx.fillRect(0, off + inset, S, bw - inset * 2));
  board((off, inset = 0) => ctx.fillRect(0, S - bw + off + inset, S, bw - inset * 2));
  board((off, inset = 0) => ctx.fillRect(off + inset, 0, bw - inset * 2, S));
  board((off, inset = 0) => ctx.fillRect(S - bw + off + inset, 0, bw - inset * 2, S));
  // 테두리 나뭇결과 못
  for (let k = 0; k < 90; k++) {
    ctx.fillStyle = `rgba(56, 32, 12, ${0.05 + rand() * 0.1})`;
    const at = rand() < 0.5 ? rand() * bw : S - rand() * bw;
    if (k % 2) ctx.fillRect(0, at, S, 1);
    else ctx.fillRect(at, 0, 1, S);
  }
  ctx.fillStyle = '#2d2a26';
  const nail = bw * 0.5;
  for (const [x, y] of [[nail, nail], [S - nail, nail], [nail, S - nail], [S - nail, S - nail], [S / 2, nail], [S / 2, S - nail], [nail, S / 2], [S - nail, S / 2]]) {
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();
  }
}

// 드럼통 아틀라스: 아래 3/4 = 옆면(둘레 한 바퀴), 왼쪽 위 1/4 칸 = 뚜껑. 인스턴스 색이 곱해지므로 밝게 그린다
const BARREL_SIDE_V = 0.75, BARREL_CAP_UV = 0.25;

function paintBarrel(ctx, S) {
  const rand = seededRandom(97);
  const top = S * (1 - BARREL_SIDE_V), h = S - top;
  ctx.fillStyle = '#e4e6e7';
  ctx.fillRect(0, top, S, h);
  for (let k = 0; k < 150; k++) {
    ctx.fillStyle = rand() < 0.5 ? `rgba(40, 42, 46, ${0.03 + rand() * 0.07})` : `rgba(255, 255, 255, ${0.03 + rand() * 0.08})`;
    ctx.fillRect(rand() * S, top, 1 + rand() * 3, h);
  }
  // 옆면 높이 → 캔버스 y (드럼통 아래 = 캔버스 아래)
  const yAt = (u) => S - (u + 0.5) * BARREL_SIDE_V * S;
  for (const [a, b] of [[-0.5, -0.42], [-0.2, -0.14], [0.14, 0.2], [0.42, 0.5]]) {
    ctx.fillStyle = 'rgba(30, 30, 34, 0.32)';
    ctx.fillRect(0, yAt(b), S, yAt(a) - yAt(b));
    ctx.fillStyle = 'rgba(20, 20, 24, 0.55)';
    ctx.fillRect(0, yAt(a) - 1, S, 2);
    ctx.fillRect(0, yAt(b) - 1, S, 2);
  }
  // 앞뒤 표식: 빗금 띠
  for (const cu of [0.25, 0.75]) {
    const w = S * 0.18, x = cu * S - w / 2, y0 = yAt(0.09), y1 = yAt(-0.09);
    ctx.fillStyle = '#f5f4ee';
    ctx.fillRect(x, y0, w, y1 - y0);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y0, w, y1 - y0);
    ctx.clip();
    ctx.fillStyle = '#26272b';
    for (let s = -40; s < w + 40; s += 16) {
      ctx.beginPath();
      ctx.moveTo(x + s, y1);
      ctx.lineTo(x + s + 8, y1);
      ctx.lineTo(x + s + 8 + (y1 - y0), y0);
      ctx.lineTo(x + s + (y1 - y0), y0);
      ctx.fill();
    }
    ctx.restore();
  }
  // 긁힘과 녹
  for (let k = 0; k < 70; k++) {
    const x = rand() * S, y = top + rand() * h, r = 1 + rand() * rand() * 7;
    ctx.fillStyle = `rgba(112, 66, 30, ${0.08 + rand() * 0.22})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  // 뚜껑
  const c = S * BARREL_CAP_UV, m = c / 2;
  ctx.fillStyle = '#c7cacc';
  ctx.fillRect(0, 0, c, c);
  ctx.strokeStyle = 'rgba(30, 30, 34, 0.6)';
  ctx.lineWidth = 2;
  for (const r of [m * 0.92, m * 0.74]) {
    ctx.beginPath();
    ctx.arc(m, m, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.fillStyle = '#34363a';
  for (const [dx, dy, r] of [[0.42, -0.2, 0.13], [-0.46, 0.24, 0.08]]) {
    ctx.beginPath();
    ctx.arc(m + dx * m, m + dy * m, r * m, 0, Math.PI * 2);
    ctx.fill();
  }
}

function canvasTexture(THREE, paint) {
  if (typeof document === 'undefined') return null;
  const S = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  paint(ctx, S);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/* ---------------- 드럼통 형상 ---------------- */

// (반지름, 높이) 단위 드럼통: 지름·높이 1. 첫 2점과 끝 4점이 뚜껑이고 나머지가 옆면이다
const BARREL_PROFILE = Object.freeze([
  [0, -0.5], [0.44, -0.5],
  [0.5, -0.47], [0.5, -0.44], [0.47, -0.42],
  [0.47, -0.2], [0.5, -0.185], [0.5, -0.155], [0.47, -0.14],
  [0.47, 0.14], [0.5, 0.155], [0.5, 0.185], [0.47, 0.2],
  [0.47, 0.42], [0.5, 0.44], [0.5, 0.47],
  [0.44, 0.5], [0.4, 0.5], [0.4, 0.46], [0, 0.46]
]);
const BARREL_CAP_HEAD = 2, BARREL_CAP_TAIL = 4;

function barrelGeometry(THREE) {
  const n = BARREL_PROFILE.length;
  const geo = new THREE.LatheGeometry(BARREL_PROFILE.map(([r, y]) => new THREE.Vector2(r, y)), 14);
  const uv = geo.attributes.uv, pos = geo.attributes.position;
  for (let i = 0; i < uv.count; i++) {
    const j = i % n;
    if (j < BARREL_CAP_HEAD || j >= n - BARREL_CAP_TAIL) {
      uv.setXY(i, (pos.getX(i) + 0.5) * BARREL_CAP_UV, 1 - BARREL_CAP_UV + (pos.getZ(i) + 0.5) * BARREL_CAP_UV);
    } else {
      uv.setY(i, (pos.getY(i) + 0.5) * BARREL_SIDE_V);
    }
  }
  uv.needsUpdate = true;
  return geo;
}

/* ---------------- 시뮬레이션 구성 ---------------- */

function addStaticBody(C, world, c) {
  const body = new C.Body({ mass: 0, collisionFilterGroup: G_STATIC, collisionFilterMask: G_PROP });
  if (c.kind === 'cyl') {
    body.addShape(new C.Cylinder(c.r, c.r, c.maxY - c.minY, CYL_SEGMENTS));
    body.position.set(c.x, (c.minY + c.maxY) / 2, c.z);
  } else if (c.kind === 'ramp') {
    const wedge = rampWedge(c);
    body.addShape(new C.ConvexPolyhedron({ vertices: wedge.vertices.map(([x, y, z]) => new C.Vec3(x, y, z)), faces: wedge.faces }));
    body.position.set(wedge.center[0], wedge.center[1], wedge.center[2]);
  } else {
    body.addShape(new C.Box(new C.Vec3((c.maxX - c.minX) / 2, (c.maxY - c.minY) / 2, (c.maxZ - c.minZ) / 2)));
    body.position.set((c.minX + c.maxX) / 2, (c.minY + c.maxY) / 2, (c.minZ + c.maxZ) / 2);
  }
  body.aabbNeedsUpdate = true;
  world.addBody(body);
}

function addPropBody(C, world, s, material) {
  const shape = s.kind === 'cyl'
    ? new C.Cylinder(s.hx, s.hx, s.hy * 2, BARREL_SEGMENTS)
    : new C.Box(new C.Vec3(s.hx, s.hy, s.hz));
  const body = new C.Body({
    mass: s.mass,
    shape,
    material,
    position: new C.Vec3(s.x, s.y + s.hy, s.z),
    linearDamping: LINEAR_DAMPING,
    angularDamping: ANGULAR_DAMPING,
    allowSleep: true,
    sleepSpeedLimit: SLEEP_SPEED,
    sleepTimeLimit: SLEEP_TIME,
    collisionFilterGroup: G_PROP,
    collisionFilterMask: G_PROP | G_STATIC | G_PLAYER
  });
  world.addBody(body);
  return body;
}

function buildSim(C, items, specs, colliders, prof) {
  const world = new C.World({ gravity: new C.Vec3(0, PLAYER.GRAVITY, 0), allowSleep: true });
  world.broadphase.useBoundingBoxes = true;   // 긴 벽의 경계 구는 너무 커서 상자로 거른다
  world.solver.iterations = prof.iterations;
  world.solver.tolerance = SOLVER_TOLERANCE;
  const base = world.defaultContactMaterial;
  base.friction = PROP_FRICTION;
  base.restitution = PROP_RESTITUTION;

  const planeY = groundPlaneY(colliders);
  if (planeY !== null) {
    const floor = new C.Body({ mass: 0, shape: new C.Plane(), collisionFilterGroup: G_STATIC, collisionFilterMask: G_PROP });
    floor.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    floor.position.set(0, planeY, 0);
    floor.aabbNeedsUpdate = true;
    world.addBody(floor);
  }
  const statics = selectStaticColliders(colliders, specs, { planeY, max: prof.maxStatic });
  for (const c of statics) addStaticBody(C, world, c);
  const placed = new Set(statics);

  const propMaterial = new C.Material('prop'), playerMaterial = new C.Material('player');
  world.addContactMaterial(new C.ContactMaterial(propMaterial, playerMaterial, {
    friction: 0,
    restitution: 0,
    contactEquationStiffness: PUSH_STIFFNESS,
    contactEquationRelaxation: PUSH_RELAXATION
  }));
  for (const it of items) {
    it.body = addPropBody(C, world, it.spec, propMaterial);
    it.body.item = it;
  }

  const player = new C.Body({
    mass: 0,
    type: C.Body.KINEMATIC,
    material: playerMaterial,
    allowSleep: false,
    sleepSpeedLimit: 0.05,       // 이 속도의 √2배부터 잠든 소품을 깨운다
    collisionFilterGroup: G_PLAYER,
    collisionFilterMask: G_PROP
  });
  for (const y of PLAYER_SPHERES) player.addShape(new C.Sphere(PLAYER.RADIUS), new C.Vec3(0, y, 0));
  player.position.set(0, PARK_Y, 0);
  world.addBody(player);

  return {
    world,
    player,
    C,
    statics: statics.length + (planeY !== null ? 1 : 0),
    staticLimit: Math.round(prof.maxStatic * 1.5),
    pending: colliders.filter((c) => isPropSolid(c, planeY) && !placed.has(c)),   // 아직 강체로 만들지 않은 충돌체
    limits: worldLimits(colliders, specs),
    settle: LOW_SETTLE_STEPS,
    steps: 0,
    // 재사용 객체(explode·bulletHit가 매번 만들지 않게)
    from: new C.Vec3(),
    to: new C.Vec3(),
    impulse: new C.Vec3(),
    rel: new C.Vec3(),
    rayResult: new C.RaycastResult(),
    rayOptions: { collisionFilterMask: G_PROP, skipBackfaces: true },
    losResult: new C.RaycastResult(),
    losOptions: { collisionFilterMask: G_STATIC, skipBackfaces: true },
    SLEEPING: C.Body.SLEEPING
  };
}

function limitSpeed(b) {
  const v = b.velocity, w = b.angularVelocity;
  const v2 = v.x * v.x + v.y * v.y + v.z * v.z;
  if (v2 > MAX_SPEED * MAX_SPEED) {
    const k = MAX_SPEED / Math.sqrt(v2);
    v.x *= k; v.y *= k; v.z *= k;
  }
  const w2 = w.x * w.x + w.y * w.y + w.z * w.z;
  if (w2 > MAX_SPIN * MAX_SPIN) {
    const k = MAX_SPIN / Math.sqrt(w2);
    w.x *= k; w.y *= k; w.z *= k;
  }
}

/** 플레이어와 맞닿은 스텝에 수평 속력이 PUSH_PROP_SPEED를 넘어 늘지 않게 한다(폭발로 이미 빠른 소품은 그대로) */
function limitPush(b, speedBefore2) {
  const v = b.velocity;
  const speed2 = v.x * v.x + v.z * v.z;
  const cap2 = Math.max(PUSH_PROP_SPEED * PUSH_PROP_SPEED, speedBefore2);
  if (speed2 > cap2) {
    const k = Math.sqrt(cap2 / speed2);
    v.x *= k;
    v.z *= k;
  }
}

/* ---------------- 공개 API ---------------- */

/**
 * @param {object} opts
 * @param {object} opts.THREE three.js 모듈
 * @param {object} opts.scene 소품을 넣을 장면
 * @param {function} [opts.getMapData] load() 인자를 생략했을 때 쓸 맵 데이터
 * @param {function} [opts.getColliders] load() 인자를 생략했을 때 쓸 충돌체
 * @param {function} [opts.getPlayerPos] 내 발바닥 위치([x,y,z] 또는 {x,y,z}). 없으면 null
 * @param {string} [opts.quality] 'low'면 활성 수·솔버 반복을 줄인다
 * @param {function} [opts.loadCannon] cannon-es 불러오기(시험용으로 바꿔 끼운다)
 */
export function createProps(opts = {}) {
  const { THREE, scene, getMapData, getColliders, getPlayerPos, quality, loadCannon = () => import('cannon-es') } = opts;
  let prof = qualityProfile(quality);
  let gfx = null, sim = null, cannon = null;
  let mode = 'idle', generation = 0, disposed = false, warned = false;
  let acc = 0, respawns = 0;
  let hasPlayer = false, plX = 0, plY = 0, plZ = 0;
  const items = [];
  const blastList = [];
  const byBlastDist = (a, b) => a.blastDist - b.blastDist;

  function warnOnce(message, err) {
    if (warned) return;
    warned = true;
    log.warn(message, err);
  }

  /** 시뮬레이션 오류는 게임으로 던지지 않고, 소품을 지금 자리에 세운 채 멈춘다 */
  function fail(err) {
    warnOnce('시뮬레이션을 멈추고 고정 소품으로 표시합니다', err);
    sim = null;
    if (mode !== 'idle') mode = 'static';
  }

  function getCannon() {
    if (!cannon) {
      cannon = Promise.resolve().then(loadCannon).then((C) => {
        if (!C || !C.World) throw new Error('cannon-es 모듈이 비어 있어요');
        return C;
      }).catch((err) => {
        warnOnce('cannon-es를 불러오지 못해 고정 소품으로 표시합니다', err);
        return null;
      });
    }
    return cannon;
  }

  /* ---------- 그리기 ---------- */

  function ensureGfx() {
    if (gfx) return gfx;
    const group = new THREE.Group();
    group.name = 'props';
    const makeMesh = (name, geometry, texture, color) => {
      const material = new THREE.MeshLambertMaterial(texture ? { map: texture } : { color });
      const mesh = new THREE.InstancedMesh(geometry, material, LIMITS.PROPS);
      mesh.name = name;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;   // 인스턴스가 움직이므로 경계 구를 다시 재지 않는다
      mesh.count = 0;
      group.add(mesh);
      return { mesh, geometry, material, texture };
    };
    gfx = {
      group,
      box: makeMesh('props:crate', new THREE.BoxGeometry(1, 1, 1), canvasTexture(THREE, paintCrate), 0xb08656),
      cyl: makeMesh('props:barrel', barrelGeometry(THREE), canvasTexture(THREE, paintBarrel), 0x8a9299),
      pos: new THREE.Vector3(),
      quat: new THREE.Quaternion(),
      matrix: new THREE.Matrix4(),
      color: new THREE.Color()
    };
    return gfx;
  }

  function writeMatrix(it, x, y, z, qx, qy, qz, qw) {
    const g = gfx;
    g.pos.set(x, y, z);
    g.quat.set(qx, qy, qz, qw);
    g.matrix.compose(g.pos, g.quat, it.scale);
    it.mesh.setMatrixAt(it.index, g.matrix);
    it.mesh.instanceMatrix.needsUpdate = true;
  }

  function placeProps(specs) {
    const g = ensureGfx();
    let boxes = 0, barrels = 0;
    for (const s of specs) {
      const isBox = s.kind === 'box';
      const part = isBox ? g.box : g.cyl;
      const index = isBox ? boxes++ : barrels++;
      const it = {
        spec: s,
        mesh: part.mesh,
        index,
        body: null,
        reach: Math.hypot(s.hx, s.hy, s.hz),
        scale: new THREE.Vector3(s.hx * 2, s.hy * 2, s.hz * 2),
        px: s.x, py: s.y + s.hy, pz: s.z,
        qx: 0, qy: 0, qz: 0, qw: 1,
        anchorX: s.x, anchorZ: s.z,
        respawnStep: -Infinity,
        awakeSteps: 0,
        moving: false,
        dirty: false,
        pushed: false,
        speedBefore: 0,
        blastDist: 0
      };
      items.push(it);
      writeMatrix(it, it.px, it.py, it.pz, 0, 0, 0, 1);
      const tints = PROP_TINTS[s.kind];
      g.color.set(tints[index % tints.length]);
      part.mesh.setColorAt(index, g.color);
    }
    for (const part of [g.box, g.cyl]) {
      part.mesh.count = part === g.box ? boxes : barrels;
      part.mesh.visible = part.mesh.count > 0;
      if (part.mesh.instanceColor) part.mesh.instanceColor.needsUpdate = true;
    }
    if (scene) scene.add(g.group);
  }

  /** 이전 스텝과 현재 스텝을 보간해 그린다(화면 주사율이 달라도 끊겨 보이지 않게) */
  function renderProps(alpha) {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!it.moving && !it.dirty) continue;
      const b = it.body, p = b.position, q = b.quaternion;
      const a = it.moving ? alpha : 1;
      let qx = q.x, qy = q.y, qz = q.z, qw = q.w;
      const sign = it.qx * qx + it.qy * qy + it.qz * qz + it.qw * qw < 0 ? -1 : 1;
      qx = it.qx + (sign * qx - it.qx) * a;
      qy = it.qy + (sign * qy - it.qy) * a;
      qz = it.qz + (sign * qz - it.qz) * a;
      qw = it.qw + (sign * qw - it.qw) * a;
      const len = Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw) || 1;
      writeMatrix(it, it.px + (p.x - it.px) * a, it.py + (p.y - it.py) * a, it.pz + (p.z - it.pz) * a, qx / len, qy / len, qz / len, qw / len);
      it.dirty = false;
    }
  }

  /* ---------- 시뮬레이션 ---------- */

  function readPlayer() {
    const p = getPlayerPos ? getPlayerPos() : null;
    const x = vecX(p), y = vecY(p), z = vecZ(p);
    hasPlayer = finite(x) && finite(y) && finite(z);
    if (hasPlayer) { plX = x; plY = y; plZ = z; }
  }

  function countAwake() {
    let n = 0;
    for (let i = 0; i < items.length; i++) if (items[i].body.sleepState !== sim.SLEEPING) n++;
    return n;
  }

  function nearPlayer(it, pad) {
    const p = it.body.position;
    const reach = PLAYER.RADIUS + it.reach + pad;
    const dx = p.x - plX, dz = p.z - plZ;
    return dx * dx + dz * dz < reach * reach && Math.abs(p.y - plY - PLAYER.HEIGHT / 2) < PLAYER.HEIGHT / 2 + reach;
  }

  /** 모두 잠들었으면 세계를 돌리지 않는다. 다시 깨울 수 있는 것은 소품 가까이에서 움직이는 플레이어뿐이다 */
  function needsStep() {
    if (countAwake() > 0) return true;
    if (!hasPlayer) return false;
    const p = sim.player.position, dx = plX - p.x, dy = plY - p.y, dz = plZ - p.z;
    if (dx * dx + dy * dy + dz * dz < 1e-6) return false;
    for (let i = 0; i < items.length; i++) if (nearPlayer(items[i], NEAR_PAD)) return true;
    return false;
  }

  /** 접촉에 쓰는 속도만 제한하고 위치는 플레이어를 정확히 따라간다. 플레이어는 소품의 영향을 받지 않는다 */
  function movePlayerBody(stepsLeft) {
    const b = sim.player, pos = b.position, vel = b.velocity;
    if (!hasPlayer) {
      if (pos.y !== PARK_Y) { pos.set(0, PARK_Y, 0); b.aabbNeedsUpdate = true; }
      vel.set(0, 0, 0);
      return;
    }
    const dx = plX - pos.x, dy = plY - pos.y, dz = plZ - pos.z;
    const dist2 = dx * dx + dy * dy + dz * dz;
    if (dist2 > TELEPORT_DIST * TELEPORT_DIST) {
      pos.set(plX, plY, plZ);
      vel.set(0, 0, 0);
      b.aabbNeedsUpdate = true;
      return;
    }
    const h = STEP * stepsLeft;
    let vx = dx / h, vy = dy / h, vz = dz / h;
    const speed2 = vx * vx + vy * vy + vz * vz;
    if (speed2 > PUSH_MAX_SPEED * PUSH_MAX_SPEED) {
      const k = PUSH_MAX_SPEED / Math.sqrt(speed2);
      vx *= k; vy *= k; vz *= k;
      // 제한으로 못 가는 만큼은 먼저 옮겨 둔다 → 이번 스텝이 끝나면 정확히 목표 위치
      pos.set(pos.x + dx * (STEP / h) - vx * STEP, pos.y + dy * (STEP / h) - vy * STEP, pos.z + dz * (STEP / h) - vz * STEP);
      b.aabbNeedsUpdate = true;
    }
    vel.set(vx, vy, vz);
  }

  function putToSleep(it) {
    it.body.sleep();
    it.moving = false;
    it.dirty = true;
    it.awakeSteps = 0;
  }

  function respawn(it) {
    const b = it.body, s = it.spec;
    b.position.set(s.x, s.y + s.hy, s.z);
    b.quaternion.set(0, 0, 0, 1);
    b.velocity.set(0, 0, 0);
    b.angularVelocity.set(0, 0, 0);
    b.force.set(0, 0, 0);
    b.torque.set(0, 0, 0);
    b.aabbNeedsUpdate = true;
    it.px = b.position.x; it.py = b.position.y; it.pz = b.position.z;
    it.qx = 0; it.qy = 0; it.qz = 0; it.qw = 1;
    it.awakeSteps = 0;
    if (sim.steps - it.respawnStep < RESPAWN_GUARD_STEPS) putToSleep(it);
    else b.wakeUp();
    it.respawnStep = sim.steps;
    respawns++;
  }

  /** 소품이 맵 시작 때 고른 범위를 벗어나면 새 자리 근처의 충돌체를 마저 강체로 만든다 → 멀리 밀어도 벽을 통과하지 않는다 */
  function addStaticsNear(x, y, z) {
    const list = sim.pending;
    for (let i = list.length - 1; i >= 0 && sim.statics < sim.staticLimit; i--) {
      if (distToBox(list[i], x, y, z) > NEAR_MARGIN) continue;
      addStaticBody(sim.C, sim.world, list[i]);
      sim.statics++;
      list[i] = list[list.length - 1];
      list.pop();
    }
  }

  function trackProp(it) {
    const p = it.body.position;
    if (isOutOfWorld(p.x, p.y, p.z, sim.limits)) { respawn(it); return; }
    const dx = p.x - it.anchorX, dz = p.z - it.anchorZ;
    if (dx * dx + dz * dz > (NEAR_MARGIN * NEAR_MARGIN) / 4) {
      it.anchorX = p.x;
      it.anchorZ = p.z;
      addStaticsNear(p.x, p.y, p.z);
    }
  }

  /** 저사양: 활성 수가 넘치면 플레이어에서 가장 먼, 거의 멈춘 소품부터 스텝마다 하나씩 재운다 */
  function sleepFarthest() {
    let best = null, bestDist = -1;
    for (let i = 0; i < items.length; i++) {
      const it = items[i], b = it.body;
      if (b.sleepState === sim.SLEEPING || b.velocity.lengthSquared() > SLOW_SPEED2) continue;
      const dx = b.position.x - plX, dz = b.position.z - plZ;
      const dist = dx * dx + dz * dz;
      if (dist > bestDist) { bestDist = dist; best = it; }
    }
    if (best) putToSleep(best);
  }

  /** 풀이 뒤, 위치를 옮기기 직전(world 'preStep')에 속력을 제한한다 → 빠른 소품이 벽을 뚫지 않는다 */
  function limitSpeeds() {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      limitSpeed(it.body);
      if (it.pushed) limitPush(it.body, it.speedBefore);
    }
  }

  function stepOnce(stepsLeft) {
    for (let i = 0; i < items.length; i++) {
      const it = items[i], p = it.body.position, q = it.body.quaternion;
      it.px = p.x; it.py = p.y; it.pz = p.z;
      it.qx = q.x; it.qy = q.y; it.qz = q.z; it.qw = q.w;
      it.pushed = hasPlayer && nearPlayer(it, 0);
      if (it.pushed) it.speedBefore = it.body.velocity.x * it.body.velocity.x + it.body.velocity.z * it.body.velocity.z;
    }
    movePlayerBody(stepsLeft);
    sim.world.step(STEP);
    sim.steps++;
    let awake = 0;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.body.sleepState === sim.SLEEPING) {
        if (it.moving) { it.moving = false; it.dirty = true; }
        it.awakeSteps = 0;
      } else if (it.moving) {
        if (!it.pushed && ++it.awakeSteps > MAX_AWAKE_STEPS) {
          putToSleep(it);
        } else {
          awake++;
          trackProp(it);
        }
      }
    }
    // 이번 스텝에 접촉으로 막 깨어난 소품은 활성 예산 안에서만 움직인다
    const limited = sim.settle === 0;
    for (let i = 0; i < items.length; i++) {
      const it = items[i], b = it.body;
      if (it.moving || b.sleepState === sim.SLEEPING) continue;
      if (limited && awake >= prof.maxActive) {
        putToSleep(it);
      } else {
        awake++;
        it.moving = true;
        trackProp(it);
      }
    }
    if (limited && awake > prof.maxActive) sleepFarthest();
  }

  /** 매 프레임. 고정 스텝으로 돌리고, 움직일 것이 없으면 세계를 돌리지 않는다 */
  function update(dt) {
    if (!sim) return;
    try {
      acc = clampAccumulator(acc, dt, STEP, prof.maxSubSteps);
      const steps = Math.floor(acc / STEP);
      if (steps > 0) {
        readPlayer();
        const run = needsStep();
        for (let left = steps; left > 0; left--) {
          acc -= STEP;
          if (sim.settle > 0) sim.settle--;
          if (run) stepOnce(left);
        }
      }
      renderProps(clamp(acc / STEP, 0, 1));
    } catch (err) {
      fail(err);
    }
  }

  /**
   * 폭발: 반경 안의 소품에 방사형 충격량. 벽 뒤 소품은 맞지 않고, 저사양에서는 가까운 소품만 깨운다.
   * @param center [x,y,z] 또는 {x,y,z}
   * @param {number} [radius] m
   * @param {number} [power] 중심 충격량(N·s)
   */
  function explode(center, radius = BLAST_RADIUS, power = BLAST_POWER) {
    if (!sim) return;
    try {
      const cx = vecX(center), cy = vecY(center), cz = vecZ(center);
      if (!finite(cx) || !finite(cy) || !finite(cz) || !(radius > 0) || !(power > 0)) return;
      blastList.length = 0;
      for (let i = 0; i < items.length; i++) {
        const it = items[i], p = it.body.position;
        it.blastDist = Math.hypot(p.x - cx, p.y - cy, p.z - cz);
        if (it.blastDist - it.reach < radius) blastList.push(it);
      }
      if (blastList.length > prof.maxActive) {
        blastList.sort(byBlastDist);
        blastList.length = prof.maxActive;
      }
      sim.from.set(cx, cy, cz);
      for (let i = 0; i < blastList.length; i++) applyBlast(blastList[i], i, cx, cy, cz, radius, power);
    } catch (err) {
      fail(err);
    }
  }

  function applyBlast(it, order, cx, cy, cz, radius, power) {
    const b = it.body, s = it.spec, p = b.position;
    if (sim.world.raycastAny(sim.from, p, sim.losOptions, sim.losResult)) return;
    const impulse = Math.min(blastImpulse(it.blastDist - it.reach, radius, power), s.mass * BLAST_MAX_SPEED);
    if (impulse <= 0) return;
    const d = it.blastDist > 1e-3 ? it.blastDist : 1;
    let dx = (p.x - cx) / d, dy = (p.y - cy) / d + BLAST_LIFT, dz = (p.z - cz) / d;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    dx /= len; dy /= len; dz /= len;
    sim.impulse.set(dx * impulse, dy * impulse, dz * impulse);
    // 중심에서 어긋난 점을 밀어 굴러가게 한다(같은 폭발이면 같은 결과)
    sim.rel.set(s.hx * (((order * 37) % 10) / 10 - 0.5), s.hy * 0.7, s.hz * (((order * 53) % 10) / 10 - 0.5));
    b.wakeUp();
    b.applyImpulse(sim.impulse, sim.rel);
    limitSpeed(b);
    it.moving = true;
    it.awakeSteps = 0;
  }

  /**
   * 사격: 가장 가까운 소품에 작은 충격량을 준다. 소품은 총알을 막지 않는다.
   * @returns {boolean} 소품을 맞혔는가 (시뮬레이션이 없으면 false)
   */
  function bulletHit(origin, dir, maxDist = BULLET_RANGE) {
    if (!sim) return false;
    try {
      const ox = vecX(origin), oy = vecY(origin), oz = vecZ(origin);
      const dx = vecX(dir), dy = vecY(dir), dz = vecZ(dir);
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (!finite(ox) || !finite(oy) || !finite(oz) || !(len > 0) || !finite(len) || !(maxDist > 0)) return false;
      const ux = dx / len, uy = dy / len, uz = dz / len;
      const range = finite(maxDist) ? maxDist : BULLET_RANGE;
      sim.from.set(ox, oy, oz);
      sim.to.set(ox + ux * range, oy + uy * range, oz + uz * range);
      const hit = sim.rayResult;
      if (!sim.world.raycastClosest(sim.from, sim.to, sim.rayOptions, hit) || !hit.body) return false;
      const b = hit.body;
      sim.impulse.set(ux * BULLET_IMPULSE, uy * BULLET_IMPULSE, uz * BULLET_IMPULSE);
      hit.hitPointWorld.vsub(b.position, sim.rel);
      b.wakeUp();
      b.applyImpulse(sim.impulse, sim.rel);
      limitSpeed(b);
      b.item.moving = true;
      b.item.awakeSteps = 0;
      return true;
    } catch (err) {
      fail(err);
      return false;
    }
  }

  /* ---------- 수명 ---------- */

  /**
   * 맵의 소품을 올린다. 먼저 고정 자세로 그리고, cannon-es가 도착하면 그때부터 움직인다.
   * cannon-es는 소품이 있는 맵을 처음 만날 때만 불러온다.
   * @returns {Promise<void>} 준비가 끝나면(실패해도) 풀린다
   */
  function load(mapData, colliders) {
    if (disposed) return Promise.resolve();
    try {
      clear();
      const data = mapData !== undefined ? mapData : (getMapData ? getMapData() : null);
      const specs = normalizeProps(data && data.props);
      if (!specs.length) return Promise.resolve();
      const cols = colliders !== undefined ? colliders : (getColliders ? getColliders() : null);
      placeProps(specs);
      mode = 'loading';
      const gen = generation;
      return getCannon().then((C) => {
        if (gen !== generation) return;
        mode = 'static';
        if (!C) return;
        try {
          sim = buildSim(C, items, specs, Array.isArray(cols) ? cols : [], prof);
          sim.world.addEventListener('preStep', limitSpeeds);
          mode = 'physics';
        } catch (err) {
          fail(err);
        }
      });
    } catch (err) {
      warnOnce('소품을 올리지 못했습니다', err);
      return Promise.resolve();
    }
  }

  /** 지금 맵의 소품을 치운다. 텍스처·형상은 다음 맵에서 다시 쓴다 */
  function clear() {
    generation++;
    sim = null;
    items.length = 0;
    blastList.length = 0;
    acc = 0;
    respawns = 0;
    hasPlayer = false;
    mode = 'idle';
    if (gfx) {
      gfx.box.mesh.count = 0;
      gfx.cyl.mesh.count = 0;
      if (scene) scene.remove(gfx.group);
    }
  }

  function dispose() {
    if (disposed) return;
    clear();
    disposed = true;
    if (!gfx) return;
    for (const part of [gfx.box, gfx.cyl]) {
      part.mesh.dispose();
      part.geometry.dispose();
      part.material.dispose();
      if (part.texture) part.texture.dispose();
    }
    gfx = null;
  }

  /** 품질 변경(renderer:quality). 활성 수·솔버 반복·서브스텝이 바로 바뀐다 */
  function setQuality(level) {
    prof = qualityProfile(level);
    if (sim) sim.world.solver.iterations = prof.iterations;
  }

  /** 디버그 패널·시험용 현황 */
  function stats() {
    const active = sim ? countAwake() : 0;
    return {
      mode,
      total: items.length,
      active,
      sleeping: sim ? items.length - active : 0,
      statics: sim ? sim.statics : 0,
      drawCalls: gfx ? (gfx.box.mesh.count > 0 ? 1 : 0) + (gfx.cyl.mesh.count > 0 ? 1 : 0) : 0,
      maxActive: prof.maxActive,
      iterations: prof.iterations,
      steps: sim ? sim.steps : 0,
      respawns
    };
  }

  return { load, update, explode, bulletHit, clear, dispose, stats, setQuality };
}

export default createProps;
