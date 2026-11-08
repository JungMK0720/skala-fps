/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 봇 내비게이션 그리드(2.5D 걷기 칸, A*, 시야선 평탄화). 충돌체는 maps/collision.js에서 읽어 물리와 같은 기준으로 걷기 칸을 만든다.
 *          three.js·DOM에 의존하지 않는 순수 모듈이다.
 */
/**
 * SKALA 작전 — 봇 내비게이션 그리드 (2.5D 걷기 셀 + A* + 시야선 평탄화)
 *
 * 순수 ES 모듈: three.js·DOM 의존 없음 → node에서 그대로 테스트할 수 있다.
 * 입력은 ARCHITECTURE.md 4절 맵 데이터(solids: box / cyl / ramp, 바닥 y=0). 해석은 maps/collision.js의 buildCollision을 따른다.
 * 발판(pads)은 충돌체가 없으므로 그 아래 바닥이 그대로 걷기 칸이다. 발판을 타는 경로는 계획하지 않는다(봇이 밟으면 날아갈 뿐).
 *
 * 걷기 판정은 engine/physics.js와 같은 해석을 따른다.
 *   - 캐릭터 = 세로 원기둥(반지름 r, 키 H, 평평한 발).
 *   - 발밑 = 원(r-0.01) 아래에서 '발+STEP' 이하인 가장 높은 윗면 (턱은 자동으로 올라탐).
 *   - 벽   = 원(r)과 겹치고, 머리 아래에서 시작하며, (사각형 안으로 클램프한 지점의) 윗면이 발+STEP보다 높은 충돌체.
 *   - ramp = dir 방향으로 y → y+h 올라가는 쐐기. 높이는 점을 사각형 안으로 클램프한 지점에서 계산.
 *
 * 그리드: 맵을 cell 크기 칸(열)으로 나누고, 열마다 '서 있을 수 있는 바닥 높이'를 여러 층으로 저장한다
 * (지면, 컨테이너 위, 데크 위 …). 이웃 칸으로의 이동은 짧은 이동 시뮬레이션(위 규칙)으로 검사해
 * 걷기(WALK) / 뛰어내리기(DROP, 한 방향) / 점프로 오르기(JUMP, 한 방향) 간선을 만든다.
 * 그래서 경사로·계단으로 층이 이어지고, 난간·얇은 벽은 막힌다.
 */

import * as CONSTS from '../core/consts.js';
import { buildCollision } from '../maps/collision.js';

const SQRT2 = Math.SQRT2;
/** 이웃 방향 8개: 0 +x, 1 -x, 2 +z, 3 -z, 4 +x+z, 5 +x-z, 6 -x+z, 7 -x-z */
const DX8 = [1, -1, 0, 0, 1, 1, -1, -1];
const DZ8 = [0, 0, 1, -1, 1, -1, 1, -1];

export const NAV_EDGE = Object.freeze({ NONE: 0, WALK: 1, DROP: 2, JUMP: 3 });
const WALK = 1, DROP = 2, JUMP = 3;

const P0 = (CONSTS && CONSTS.PLAYER) || {};
const pnum = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
/**
 * 점프로 올라탈 수 있는 턱 높이 기본값: 물리 한계(최고 높이 v²/2g + 공중 턱 STEP/2)에서 0.25 m 여유, 최대 1.2 m.
 * consts PLAYER.JUMP_V 6.3 → 1.2 m (한계 1.46), 5.2 → 0.82 m (한계 1.07).
 */
export function jumpHeightFor(jumpV = pnum(P0.JUMP_V, 6.3), gravity = pnum(P0.GRAVITY, -16), step = pnum(P0.STEP, 0.45)) {
  const g = Math.abs(gravity) || 16;
  const limit = (jumpV * jumpV) / (2 * g) + step * 0.5;
  return Math.max(0, Math.min(1.2, Math.round((limit - 0.25) * 100) / 100));
}

export const NAV_DEFAULTS = Object.freeze({
  cell: 1.0,            // 칸 크기 (m)
  agentRadius: pnum(P0.RADIUS, 0.35),  // 캐릭터 반지름 (consts PLAYER.RADIUS)
  stepHeight: pnum(P0.STEP, 0.45),     // 자동으로 올라서는 턱 높이 (PLAYER.STEP)
  agentHeight: pnum(P0.HEIGHT, 1.8),   // 키 (머리 위 여유 공간)
  maxDrop: 3.2,         // 뛰어내리기 허용 높이 (0 = 뛰어내리기 간선 없음)
  jumpHeight: jumpHeightFor(),         // 점프로 오르는 턱 높이 (0 = 끔). JUMP_V 6.3이면 1.2 (물리 한계 ≈ 1.46)
  groundY: 0,           // 지면 높이 (null = 지면 없음, solids만). 빌더처럼 '구멍' 박스(y<0, 윗면≤0.05)는 지면을 뚫는다
  wallPenalty: 0.12,    // 벽·낭떠러지에 붙은 칸 비용 가산 (끊긴 이웃 1개당) → 경로가 모서리를 덜 긁는다
  strategicSpacing: 6,  // 요충지 후보 간격 (m)
  sightMax: 90,         // 요충지 시야 거리 측정 상한 (m)
  sightRays: 12,        // 요충지마다 수평 시야 레이 개수
  bucket: 4,            // 충돌체 공간 해시 칸 (m)
  allowBrinks: false,   // true면 '원 끝만 걸친' 가장자리 노드도 쓴다(물리상 설 수는 있지만 조금만 어긋나도 떨어짐)
  ignoreMats: null      // 무시할 mat 목록(충돌 없음으로 취급) — 보통 null
});

const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
function num(v, d) {
  if (isNum(v)) return v;
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return d;
  const n = +v;
  return Number.isFinite(n) ? n : d;
}
/** 위치 읽기: {x,y,z} 또는 [x,y,z] 모두 허용. y가 없으면 NaN(높이 모름) */
const PX = (p) => (p == null ? NaN : p.x !== undefined ? +p.x : +p[0]);
const PY = (p) => (p == null ? NaN : p.y !== undefined ? +p.y : +p[1]);
const PZ = (p) => (p == null ? NaN : p.z !== undefined ? +p.z : +p[2]);

const RAMP_DIR = { '+x': 0, '-x': 1, '+z': 2, '-z': 3 };

/**
 * 맵 데이터로 내비게이션 그리드를 만든다.
 * @param {object} mapData ARCHITECTURE 4절 형식 { size:{x,z}, spawns, solids:[...] }
 * @param {object} [options] NAV_DEFAULTS 참고 ({ cell, agentRadius, stepHeight, ... })
 */
export function buildNavGrid(mapData, options) {
  const t0 = now();
  const map = mapData && typeof mapData === 'object' ? mapData : {};
  const o = Object.assign({}, NAV_DEFAULTS, options || {});
  const CELL = num(o.cell, 1) >= 0.2 ? num(o.cell, 1) : 1;
  const R = Math.max(0.05, num(o.agentRadius, 0.35));
  const RS = Math.max(0.01, R - 0.01);           // 발밑 판정 반지름 (physics와 같음)
  const STEP = Math.max(0, num(o.stepHeight, 0.45));
  const HGT = Math.max(0.5, num(o.agentHeight, 1.8));
  const MAXDROP = Math.max(0, num(o.maxDrop, 3.2));
  const JUMPH = Math.max(0, num(o.jumpHeight, NAV_DEFAULTS.jumpHeight));
  const GROUND = o.groundY === null ? null : num(o.groundY, 0);
  const WALLPEN = Math.max(0, num(o.wallPenalty, 0.12));
  const ALLOW_BRINK = !!o.allowBrinks;
  const BRINK_PAD = 0.08;                          // 중심이 발판 가장자리에서 이만큼 밖이어도 '위'로 친다
  const SAMPLE = Math.min(0.3, CELL / 3);         // 간선 이동 시뮬레이션 간격 (< 캐릭터 지름이라 얇은 벽도 걸린다)
  const ignoreMats = Array.isArray(o.ignoreMats) ? new Set(o.ignoreMats) : null;

  /* ---------------- 충돌체 파싱 (buildCollision과 같은 해석) ---------------- */
  const col = buildCollision(map);
  const raw = Array.isArray(map.solids) ? map.solids : [];
  const parsed = [];
  for (const c of col.solidColliders) {
    // buildCollision은 모르는 mat을 concrete로, clip을 invisible로 바꾼다. ignoreMats는 맵에 적힌 이름으로 비교한다
    const rawMat = raw[c.index] && raw[c.index].mat;
    if (ignoreMats && ignoreMats.has(typeof rawMat === 'string' ? rawMat : 'concrete')) continue;
    const shape = c.kind === 'cyl' ? { k: 1, cx: c.x, cz: c.z, r: c.r, dir: 0 }
      : { k: c.kind === 'box' ? 0 : 2, cx: 0, cz: 0, r: 0, dir: c.kind === 'ramp' ? (RAMP_DIR[c.dir] ?? 0) : 0 };
    parsed.push(Object.assign(shape, { minX: c.minX, maxX: c.maxX, minY: c.minY, maxY: c.maxY, minZ: c.minZ, maxZ: c.maxZ,
      water: c.mat === 'water', clip: c.tag === 'clip' }));
  }
  const NS = parsed.length;
  const K = new Uint8Array(NS), DIR = new Uint8Array(NS), WAT = new Uint8Array(NS);
  const CLIP = new Uint8Array(NS); // mat 'clip' = 보이지 않는 막이: 걷기엔 벽, 시야·총알은 통과(builder.js와 같음)
  const MINX = new Float64Array(NS), MAXX = new Float64Array(NS), MINY = new Float64Array(NS), MAXY = new Float64Array(NS);
  const MINZ = new Float64Array(NS), MAXZ = new Float64Array(NS), CX = new Float64Array(NS), CZ = new Float64Array(NS), CR = new Float64Array(NS);
  const PLANES = new Float64Array(NS * 24); // ramp: 6 평면 × [nx,ny,nz,d] (내부: n·p ≤ d)
  for (let i = 0; i < NS; i++) {
    const p = parsed[i];
    K[i] = p.k; DIR[i] = p.dir; WAT[i] = p.water ? 1 : 0; CLIP[i] = p.clip ? 1 : 0;
    MINX[i] = p.minX; MAXX[i] = p.maxX; MINY[i] = p.minY; MAXY[i] = p.maxY;
    MINZ[i] = p.minZ; MAXZ[i] = p.maxZ; CX[i] = p.cx; CZ[i] = p.cz; CR[i] = p.r;
    if (p.k === 2) {
      const b = i * 24, h = p.maxY - p.minY;
      const pl = [[1, 0, 0, p.maxX], [-1, 0, 0, -p.minX], [0, 0, 1, p.maxZ], [0, 0, -1, -p.minZ], [0, -1, 0, -p.minY]];
      let n, d;
      if (p.dir <= 1) {
        const k = h / (p.maxX - p.minX);
        if (p.dir === 0) { n = [-k, 1, 0]; d = p.minY - k * p.minX; } else { n = [k, 1, 0]; d = p.minY + k * p.maxX; }
      } else {
        const k = h / (p.maxZ - p.minZ);
        if (p.dir === 2) { n = [0, 1, -k]; d = p.minY - k * p.minZ; } else { n = [0, 1, k]; d = p.minY + k * p.maxZ; }
      }
      const len = Math.hypot(n[0], n[1], n[2]);
      pl.push([n[0] / len, n[1] / len, n[2] / len, d / len]);
      for (let q = 0; q < 6; q++) for (let c = 0; c < 4; c++) PLANES[b + q * 4 + c] = pl[q][c];
    }
  }

  /* ---------------- 지면 (maps/builder.js와 같은 규칙) ----------------
   * 기본: 플레이 영역 − 구멍(박스 중 minY < 0 이고 윗면 ≤ 0.05인 것, 보통 물)에 윗면 y=0 슬래브.
   * theme.ground === 'none': 구멍 없는 y=0 무한 평면(physics floorY). */
  const theme = col.theme;
  const planeGround = theme.ground === 'none';
  const holes = [];
  if (GROUND !== null && !planeGround) {
    for (let i = 0; i < NS; i++) if (K[i] === 0 && !CLIP[i] && MAXY[i] <= 0.05 && MINY[i] < -0.001) holes.push([MINX[i], MAXX[i], MINZ[i], MAXZ[i]]);
  }
  const NH = holes.length;
  /** 원(x,z,rad)이 지면 슬래브와 겹치는가 (= 어떤 구멍 안에도 통째로 들어가 있지 않음) */
  function groundOverlap(x, z, rad) {
    for (let h = 0; h < NH; h++) {
      const q = holes[h];
      if (x > q[0] + rad && x < q[1] - rad && z > q[2] + rad && z < q[3] - rad) return false;
    }
    return true;
  }

  /* ---------------- 플레이 영역 ---------------- */
  const sizeX = col.size.x, sizeZ = col.size.z;
  const BMINX = -sizeX / 2, BMAXX = sizeX / 2, BMINZ = -sizeZ / 2, BMAXZ = sizeZ / 2;
  const NXC = Math.max(1, Math.ceil(sizeX / CELL - 1e-9)), NZC = Math.max(1, Math.ceil(sizeZ / CELL - 1e-9));
  const NCOL = NXC * NZC;
  const OX = BMINX, OZ = BMINZ;
  const colX = (i) => OX + (i + 0.5) * CELL;
  const colZ = (k) => OZ + (k + 0.5) * CELL;

  /* ---------------- 공간 해시 (버킷마다 반지름만큼 넓혀서 등록) ---------------- */
  const BK = Math.max(1, num(o.bucket, 4));
  const HX0 = BMINX - BK, HZ0 = BMINZ - BK;
  const NBX = Math.ceil((sizeX + 2 * BK) / BK), NBZ = Math.ceil((sizeZ + 2 * BK) / BK);
  const PAD = R + 0.05;
  const bCount = new Int32Array(NBX * NBZ + 1);
  const bRange = new Int32Array(NS * 4);
  for (let i = 0; i < NS; i++) {
    const x0 = Math.max(0, Math.floor((MINX[i] - PAD - HX0) / BK)), x1 = Math.min(NBX - 1, Math.floor((MAXX[i] + PAD - HX0) / BK));
    const z0 = Math.max(0, Math.floor((MINZ[i] - PAD - HZ0) / BK)), z1 = Math.min(NBZ - 1, Math.floor((MAXZ[i] + PAD - HZ0) / BK));
    bRange[i * 4] = x0; bRange[i * 4 + 1] = x1; bRange[i * 4 + 2] = z0; bRange[i * 4 + 3] = z1;
    for (let gz = z0; gz <= z1; gz++) for (let gx = x0; gx <= x1; gx++) bCount[gx + gz * NBX + 1]++;
  }
  for (let b = 0; b < NBX * NBZ; b++) bCount[b + 1] += bCount[b];
  const BS = bCount; // 시작 인덱스 (prefix)
  const BI = new Int32Array(BS[NBX * NBZ]);
  {
    const fill = BS.slice(0, NBX * NBZ);
    for (let i = 0; i < NS; i++) {
      const x0 = bRange[i * 4], x1 = bRange[i * 4 + 1], z0 = bRange[i * 4 + 2], z1 = bRange[i * 4 + 3];
      for (let gz = z0; gz <= z1; gz++) for (let gx = x0; gx <= x1; gx++) BI[fill[gx + gz * NBX]++] = i;
    }
  }
  function bucketOf(x, z) {
    let gx = Math.floor((x - HX0) / BK), gz = Math.floor((z - HZ0) / BK);
    if (gx < 0) gx = 0; else if (gx >= NBX) gx = NBX - 1;
    if (gz < 0) gz = 0; else if (gz >= NBZ) gz = NBZ - 1;
    return gx + gz * NBX;
  }

  /* ---------------- 기하 판정 (physics.js와 같은 규칙) ---------------- */
  function overlap(i, x, z, rad) {
    if (K[i] === 1) {
      const dx = x - CX[i], dz = z - CZ[i], RR = CR[i] + rad;
      return dx * dx + dz * dz < RR * RR;
    }
    const qx = x < MINX[i] ? MINX[i] : x > MAXX[i] ? MAXX[i] : x;
    const qz = z < MINZ[i] ? MINZ[i] : z > MAXZ[i] ? MAXZ[i] : z;
    const dx = x - qx, dz = z - qz;
    return (dx === 0 && dz === 0) || dx * dx + dz * dz < rad * rad;
  }
  function topAt(i, x, z) {
    if (K[i] !== 2) return MAXY[i];
    let t;
    switch (DIR[i]) {
      case 1: t = (MAXX[i] - x) / (MAXX[i] - MINX[i]); break;
      case 2: t = (z - MINZ[i]) / (MAXZ[i] - MINZ[i]); break;
      case 3: t = (MAXZ[i] - z) / (MAXZ[i] - MINZ[i]); break;
      default: t = (x - MINX[i]) / (MAXX[i] - MINX[i]); break;
    }
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return MINY[i] + t * (MAXY[i] - MINY[i]);
  }
  const inBounds = (x, z) => x >= BMINX + R && x <= BMAXX - R && z >= BMINZ + R && z <= BMAXZ - R;

  /** (x,z)에서 발 높이 f로 안정적으로 서 있을 수 있는가 (벽 없음 + 더 높은 턱에 들려 올라가지 않음 + 물 아님) */
  function standable(x, z, f) {
    if (!inBounds(x, z)) return false;
    const b = bucketOf(x, z);
    let supportWater = false, support = false;
    if (GROUND !== null) {
      if (GROUND > f + STEP && groundOverlap(x, z, R)) return false;                // 구멍 안에서 본 지면 가장자리 = 벽
      if (GROUND > f + 0.005 && GROUND <= f + STEP + 1e-4 && groundOverlap(x, z, RS)) return false;
      support = Math.abs(GROUND - f) < 0.005 && groundOverlap(x, z, RS);
    }
    // 중심 바로 아래 바닥(가장자리 판정용): 원 끝만 걸쳐 서 있고 중심 아래가 STEP보다 깊으면 '가장자리' → 제외
    let under = GROUND !== null && GROUND <= f + 0.005 && groundOverlap(x, z, 0.05) ? GROUND : -Infinity;
    for (let j = BS[b], e = BS[b + 1]; j < e; j++) {
      const i = BI[j];
      if (!overlap(i, x, z, R)) continue;
      const top = topAt(i, x, z);
      if (MINY[i] < f + HGT - 0.01 && top > f + STEP) return false;            // 벽/천장
      if (top > f + 0.005 && top <= f + STEP + 1e-4 && overlap(i, x, z, RS)) return false; // 더 높은 턱으로 들림
      if (Math.abs(top - f) < 0.005 && overlap(i, x, z, RS)) { support = true; if (WAT[i]) supportWater = true; }
      if (top <= f + 0.005 && top > under && overlap(i, x, z, BRINK_PAD)) under = top;
    }
    if (!ALLOW_BRINK && f - under > STEP + 1e-4) return false;
    return support && !supportWater;
  }

  // traverse 결과 슬롯
  let trDrop = 0, trJump = false, trJX = 0, trJZ = 0, trJY = 0;
  /**
   * (ax,ay,az)에서 (bx,bz)까지 직선으로 걸어갈 때의 발 높이를 흉내 낸다.
   * @returns 도착 발 높이 (막히면 NaN). trDrop = 떨어진 높이 합, trJump = 점프로 턱을 오름
   */
  /** (x,z) 원(RS) 위에 바닥면이 [y0, y1) 사이인 충돌체(천장)가 있나 — 점프 머리 공간 확인 */
  function headBlocked(x, z, y0, y1) {
    if (!(y1 > y0)) return false;
    const b = bucketOf(x, z);
    for (let j = BS[b], e = BS[b + 1]; j < e; j++) {
      const i = BI[j];
      if (MINY[i] >= y0 && MINY[i] < y1 && overlap(i, x, z, RS)) return true;
    }
    return false;
  }
  function traverse(ax, ay, az, bx, bz, allowJump) {
    const dx = bx - ax, dz = bz - az;
    const len = Math.sqrt(dx * dx + dz * dz);
    const n = Math.max(2, Math.ceil(len / SAMPLE));
    let feet = ay, px = ax, pz = az;
    trDrop = 0; trJump = false;
    for (let s = 1; s <= n; s++) {
      const t = s / n, x = ax + dx * t, z = az + dz * t;
      if (!inBounds(x, z)) return NaN;
      const b = bucketOf(x, z), j0 = BS[b], j1 = BS[b + 1];
      for (let pass = 0; pass < 2; pass++) {
        let ground = -Infinity, jumpTop = -Infinity;
        if (GROUND !== null) {
          if (GROUND > feet + STEP) {
            if (groundOverlap(x, z, R)) {
              if (allowJump && !trJump && GROUND <= feet + JUMPH) jumpTop = GROUND; else return NaN;
            }
          } else if (groundOverlap(x, z, RS)) ground = GROUND;
        }
        for (let j = j0; j < j1; j++) {
          const i = BI[j];
          if (!overlap(i, x, z, R)) continue;
          const top = topAt(i, x, z);
          if (MINY[i] < feet + HGT - 0.01 && top > feet + STEP) {
            if (allowJump && !trJump && top <= feet + JUMPH) { if (top > jumpTop) jumpTop = top; continue; }
            return NaN;
          }
          if (top <= feet + STEP + 1e-4 && top > ground && overlap(i, x, z, RS)) ground = top;
        }
        if (jumpTop > -Infinity) {
          // 점프 중 머리 공간: 발이 (턱 − 공중 턱 STEP/2)까지 올라갈 동안 천장에 막히면 못 오른다 (physics ceilingAt)
          const need = jumpTop - STEP * 0.5 + HGT + 0.05;
          if (headBlocked(x, z, feet + HGT - 0.02, need) || headBlocked(px, pz, feet + HGT - 0.02, need)) return NaN;
          feet = jumpTop; trJump = true; trJX = px; trJZ = pz; trJY = jumpTop; continue; // 오른 높이에서 다시 검사 (도약 = 직전 표본 위치)
        }
        if (ground === -Infinity) return NaN;
        if (ground < feet - STEP - 1e-4) trDrop += feet - ground;
        feet = ground;
        break;
      }
      px = x; pz = z;
    }
    return feet;
  }

  /** (ax,ay,az)에서 (bx,bz)까지 떨어지지 않고 걸어가 by 높이(tol 안)에 닿는가 (by가 NaN이면 높이 무시) */
  function straightOK(ax, ay, az, bx, by, bz, tol) {
    const fy = traverse(ax, ay, az, bx, bz, false);
    if (fy !== fy || trDrop > 0) return false;
    return !Number.isFinite(by) || Math.abs(fy - by) < tol;
  }

  const tPhase = { parse: now() - t0 };
  let tMark = now();
  /* ---------------- 1) 열마다 바닥 층 만들기 ---------------- */
  let cap = Math.max(1024, NCOL * 2);
  let NX = new Float32Array(cap), NY = new Float32Array(cap), NZ = new Float32Array(cap), NC = new Int32Array(cap);
  const colStart = new Int32Array(NCOL + 1);
  let N = 0;
  const cand = [];
  for (let k = 0; k < NZC; k++) {
    const z = colZ(k);
    for (let i = 0; i < NXC; i++) {
      const c = i + k * NXC;
      colStart[c] = N;
      const x = colX(i);
      if (!inBounds(x, z)) continue;
      cand.length = 0;
      if (GROUND !== null && groundOverlap(x, z, RS)) cand.push(GROUND);
      const b = bucketOf(x, z);
      for (let j = BS[b], e = BS[b + 1]; j < e; j++) {
        const s = BI[j];
        if (overlap(s, x, z, RS)) cand.push(topAt(s, x, z));
      }
      cand.sort((a, b2) => a - b2);
      let last = -Infinity;
      for (let q = 0; q < cand.length; q++) {
        const f = cand[q];
        if (f - last < 0.005) continue;
        last = f;
        if (!standable(x, z, f)) continue;
        if (N >= cap) {
          cap *= 2;
          const gx = new Float32Array(cap), gy = new Float32Array(cap), gz = new Float32Array(cap), gc = new Int32Array(cap);
          gx.set(NX); gy.set(NY); gz.set(NZ); gc.set(NC); NX = gx; NY = gy; NZ = gz; NC = gc;
        }
        NX[N] = x; NY[N] = f; NZ[N] = z; NC[N] = c; N++;
      }
    }
  }
  colStart[NCOL] = N;
  NX = NX.slice(0, N); NY = NY.slice(0, N); NZ = NZ.slice(0, N); NC = NC.slice(0, N);
  const colOfNode = (n) => NC[n];

  tPhase.columns = now() - tMark; tMark = now();
  /* ---------------- 2) 간선 (이웃 8방향) ---------------- */
  // 빠른 경로: 반경 R + 0.75칸 안에 충돌체가 하나도 없는 열(NEAR=0)끼리는 시뮬레이션 없이 평지 걷기 간선
  const NEAR = new Uint8Array(NCOL);
  {
    const pad = R + 0.75 * CELL + 0.02;
    for (let i = 0; i < NS; i++) {
      const i0 = Math.max(0, Math.floor((MINX[i] - pad - OX) / CELL - 0.5)), i1 = Math.min(NXC - 1, Math.ceil((MAXX[i] + pad - OX) / CELL - 0.5));
      const k0 = Math.max(0, Math.floor((MINZ[i] - pad - OZ) / CELL - 0.5)), k1 = Math.min(NZC - 1, Math.ceil((MAXZ[i] + pad - OZ) / CELL - 0.5));
      for (let k = k0; k <= k1; k++) for (let ii = i0; ii <= i1; ii++) NEAR[ii + k * NXC] = 1;
    }
  }
  const NB = new Int32Array(N * 8).fill(-1);
  const ET = new Uint8Array(N * 8);
  let edgeCount = 0, fastEdges = 0;
  const tallDrops = [];                 // MAXDROP보다 높은 뛰어내리기 후보 [간선 번호, 도착 노드, ...] (4단계 뒤에 쓴다)
  for (let a = 0; a < N; a++) {
    const c = NC[a], ci = c % NXC, ck = (c - ci) / NXC;
    const ax = NX[a], ay = NY[a], az = NZ[a];
    const clearA = NEAR[c] === 0;
    for (let d = 0; d < 8; d++) {
      const ni = ci + DX8[d], nk = ck + DZ8[d];
      if (ni < 0 || nk < 0 || ni >= NXC || nk >= NZC) continue;
      const nc = ni + nk * NXC, s0 = colStart[nc], s1 = colStart[nc + 1];
      if (s0 === s1) continue;
      if (clearA && NEAR[nc] === 0 && s1 - s0 === 1 && Math.abs(NY[s0] - ay) < 1e-4) {
        NB[a * 8 + d] = s0; ET[a * 8 + d] = WALK; edgeCount++; fastEdges++;
        continue;
      }
      const fy = traverse(ax, ay, az, colX(ni), colZ(nk), d < 4 && JUMPH > STEP);
      if (fy !== fy) continue;
      let b = -1;
      for (let m = s0; m < s1; m++) if (Math.abs(NY[m] - fy) < 0.06) { b = m; break; }
      if (b < 0) continue;
      let type = WALK;
      if (trJump) type = JUMP;
      else if (trDrop > 0) {
        if (trDrop > MAXDROP + 1e-6) { if (d < 4) tallDrops.push(a * 8 + d, b); continue; }
        type = DROP;
      }
      if (d >= 4 && type !== WALK) continue; // 대각선은 걷기만
      NB[a * 8 + d] = b; ET[a * 8 + d] = type; edgeCount++;
    }
  }

  // 2b) 넘어가기 점프 간선: 바로 옆 칸이 벽(얇은 벽·난간·파이프)이라 노드가 없으면 2~3칸 앞 착지 칸까지 한 번에
  //     (점프로 벽 위에 올라 건너 반대편으로 내려가는 동작을 같은 이동 시뮬레이션으로 확인). 저장: 노드별 CSR
  const XS = new Int32Array(N + 1);
  const xT = [], xC = [];
  for (let a = 0; a < N; a++) {
    XS[a] = xT.length;
    if (!(JUMPH > STEP)) continue;
    const c = NC[a], ci = c % NXC, ck = (c - ci) / NXC;
    for (let d = 0; d < 4; d++) {
      if (NB[a * 8 + d] >= 0) continue;
      for (let st = 2; st <= 3; st++) {
        const ni = ci + DX8[d] * st, nk = ck + DZ8[d] * st;
        if (ni < 0 || nk < 0 || ni >= NXC || nk >= NZC) break;
        const nc = ni + nk * NXC, s0 = colStart[nc], s1 = colStart[nc + 1];
        if (s0 === s1) continue;                           // 착지할 칸이 아님 → 한 칸 더
        const fy = traverse(NX[a], NY[a], NZ[a], colX(ni), colZ(nk), true);
        if (fy !== fy || !trJump || trDrop > MAXDROP + 1e-6) break;
        let b = -1;
        for (let m = s0; m < s1; m++) if (Math.abs(NY[m] - fy) < 0.06) { b = m; break; }
        if (b >= 0) { xT.push(b); xC.push(st * CELL + 1.8 + 0.35 * Math.abs(NY[b] - NY[a]) + 0.25 * trDrop); edgeCount++; }
        break;
      }
    }
  }
  XS[N] = xT.length;
  const XT = Int32Array.from(xT), XC = Float32Array.from(xC);
  const vaultEdges = XT.length;

  // 벽·낭떠러지에 붙은 정도 (끊긴 걷기 이웃 수)
  const WALLN = new Uint8Array(N);
  for (let a = 0; a < N; a++) {
    let miss = 0;
    for (let d = 0; d < 8; d++) if (ET[a * 8 + d] !== WALK) miss++;
    WALLN[a] = miss;
  }
  const COST = new Float32Array(N * 8);
  for (let a = 0; a < N; a++) {
    for (let d = 0; d < 8; d++) {
      const e = a * 8 + d, b = NB[e];
      if (b < 0) continue;
      const dy = Math.abs(NY[b] - NY[a]);
      let c = (d < 4 ? CELL : CELL * SQRT2) + 0.35 * dy + WALLPEN * WALLN[b];
      if (ET[e] === DROP) c += 1.0 + 0.25 * dy;
      else if (ET[e] === JUMP) c += 1.6;
      COST[e] = c;
    }
  }

  tPhase.edges = now() - tMark; tMark = now();
  /* ---------------- 3) 위치 → 노드 ---------------- */
  // GOOD 계산 전에도 쓰므로 goodOnly일 때만 GOOD를 본다
  let GOOD = new Uint8Array(N);
  function locate(x, y, z, rings, goodOnly) {
    if (!(N > 0) || !Number.isFinite(x) || !Number.isFinite(z)) return -1;
    let ci = Math.floor((x - OX) / CELL), ck = Math.floor((z - OZ) / CELL);
    if (ci < 0) ci = 0; else if (ci >= NXC) ci = NXC - 1;
    if (ck < 0) ck = 0; else if (ck >= NZC) ck = NZC - 1;
    const hasY = Number.isFinite(y);
    let best = -1, bestS = Infinity;
    for (let r = 0; r <= rings; r++) {
      for (let dk = -r; dk <= r; dk++) {
        const kk = ck + dk;
        if (kk < 0 || kk >= NZC) continue;
        const edge = dk === -r || dk === r;
        for (let di = -r; di <= r; di += edge ? 1 : 2 * r) {
          const ii = ci + di;
          if (ii >= 0 && ii < NXC) {
            const c = ii + kk * NXC;
            for (let m = colStart[c], e = colStart[c + 1]; m < e; m++) {
              if (goodOnly && !GOOD[m]) continue;
              const dx = NX[m] - x, dz = NZ[m] - z;
              let s = dx * dx + dz * dz;
              if (hasY) {
                const dy = NY[m] - y;               // 노드가 위에 있으면(오를 수 없을 수 있음) 더 크게 친다
                const w = dy > STEP ? (dy - STEP) * 3 + STEP : dy > 0 ? dy : -dy * 1.5;
                s += w * w;
              } else s += NY[m] * 0.01;              // 높이를 모르면 낮은 층 우선
              if (s < bestS) { bestS = s; best = m; }
            }
          }
          if (r === 0) break;
        }
      }
      if (best >= 0 && (r + 0.5) * CELL >= Math.sqrt(bestS)) break;
    }
    return best;
  }

  /* ---------------- 4) 쓸 수 있는 영역(GOOD): 스폰에서 갔다가 돌아올 수 있는 노드 ---------------- */
  const spawnsOut = { owner: [], charterer: [] };
  const seeds = [];
  const spawnSrc = col.spawns;
  for (const team of Object.keys(spawnSrc)) {
    const arr = Array.isArray(spawnSrc[team]) ? spawnSrc[team] : [];
    const out = [];
    for (const sp of arr) {
      const sx = num(sp && sp.x, NaN), sz = num(sp && sp.z, NaN);
      if (!Number.isFinite(sx) || !Number.isFinite(sz)) continue;
      const n = locate(sx, num(sp.y, NaN), sz, 6, false);
      if (n < 0) continue;
      seeds.push(n);
      out.push({ x: sx, y: NY[n], z: sz, rotY: num(sp.rotY, 0), node: n });
    }
    spawnsOut[team] = out;
  }
  // 역방향 인접 (CSR)
  const RS0 = new Int32Array(N + 1);
  for (let e = 0; e < N * 8; e++) if (NB[e] >= 0) RS0[NB[e] + 1]++;
  for (let e = 0; e < XT.length; e++) RS0[XT[e] + 1]++;
  for (let n = 0; n < N; n++) RS0[n + 1] += RS0[n];
  const RI = new Int32Array(RS0[N]);
  {
    const fill = RS0.slice(0, N);
    for (let e = 0; e < N * 8; e++) if (NB[e] >= 0) RI[fill[NB[e]]++] = (e / 8) | 0;
    for (let a = 0; a < N; a++) for (let e = XS[a]; e < XS[a + 1]; e++) RI[fill[XT[e]]++] = a;
  }
  const queue = new Int32Array(Math.max(1, N));
  function bfs(starts, forward, mark) {
    let qh = 0, qt = 0;
    for (const s of starts) if (!mark[s]) { mark[s] = 1; queue[qt++] = s; }
    while (qh < qt) {
      const n = queue[qh++];
      if (forward) {
        for (let d = 0; d < 8; d++) { const m = NB[n * 8 + d]; if (m >= 0 && !mark[m]) { mark[m] = 1; queue[qt++] = m; } }
        for (let e = XS[n]; e < XS[n + 1]; e++) { const m = XT[e]; if (!mark[m]) { mark[m] = 1; queue[qt++] = m; } }
      } else {
        for (let j = RS0[n]; j < RS0[n + 1]; j++) { const m = RI[j]; if (!mark[m]) { mark[m] = 1; queue[qt++] = m; } }
      }
    }
    return qt;
  }
  if (!seeds.length && N > 0) {
    // 스폰이 없으면 가장 큰 걷기 연결 요소의 노드 하나를 씨앗으로
    const comp = new Uint8Array(N);
    let bestSeed = 0, bestSize = 0;
    for (let n = 0; n < N; n++) {
      if (comp[n]) continue;
      const size = bfs([n], true, comp);
      if (size > bestSize) { bestSize = size; bestSeed = n; }
    }
    seeds.push(bestSeed);
  }
  if (N > 0) {
    const fw = new Uint8Array(N), bw = new Uint8Array(N);
    bfs(seeds, true, fw);
    bfs(seeds, false, bw);
    for (let n = 0; n < N; n++) GOOD[n] = fw[n] & bw[n];
  }
  let goodCount = 0;
  for (let n = 0; n < N; n++) goodCount += GOOD[n];
  const goodList = new Int32Array(goodCount);
  for (let n = 0, j = 0; n < N; n++) if (GOOD[n]) goodList[j++] = n;

  // 발판으로만 올라가는 지붕처럼 GOOD 밖에 있는 층: 낙하 피해가 없으니 높이 제한 없이 뛰어내려 돌아오게 한다.
  // GOOD 노드에서 시작한 경로는 GOOD 밖으로 나가지 않으므로 결과가 달라지지 않는다.
  let escapeEdges = 0;
  for (let i = 0; i < tallDrops.length; i += 2) {
    const e = tallDrops[i], b = tallDrops[i + 1], a = (e / 8) | 0;
    if (GOOD[a] || NB[e] >= 0) continue;
    const dy = Math.abs(NY[b] - NY[a]);
    NB[e] = b; ET[e] = DROP;
    COST[e] = CELL + 0.35 * dy + WALLPEN * WALLN[b] + 1.0 + 0.25 * dy;
    edgeCount++; escapeEdges++;
  }
  // 낮은 난간 때문에 바로 옆 칸에서는 아직 난간 위인 경우: 2~3칸 앞까지 걸어 넘어가 뛰어내린다. 노드 → [도착, 비용, ...]
  const ESC = new Map();
  for (let a = 0; a < N; a++) {
    if (GOOD[a]) continue;
    const c = NC[a], ci = c % NXC, ck = (c - ci) / NXC;
    for (let d = 0; d < 4; d++) {
      if (NB[a * 8 + d] >= 0) continue;
      for (let st = 2; st <= 3; st++) {
        const ni = ci + DX8[d] * st, nk = ck + DZ8[d] * st;
        if (ni < 0 || nk < 0 || ni >= NXC || nk >= NZC) break;
        const nc = ni + nk * NXC, s0 = colStart[nc], s1 = colStart[nc + 1];
        if (s0 === s1) continue;
        const fy = traverse(NX[a], NY[a], NZ[a], colX(ni), colZ(nk), false);
        if (fy !== fy) break;
        if (!(trDrop > 0)) continue;                       // 아직 난간 위다 → 한 칸 더
        let b = -1;
        for (let m = s0; m < s1; m++) if (Math.abs(NY[m] - fy) < 0.06) { b = m; break; }
        if (b >= 0) {
          const dy = Math.abs(NY[b] - NY[a]);
          if (!ESC.has(a)) ESC.set(a, []);
          ESC.get(a).push(b, st * CELL + 0.6 * dy + 1.0);
          edgeCount++; escapeEdges++;
        }
        break;
      }
    }
  }

  tPhase.good = now() - tMark; tMark = now();
  /* ---------------- 5) 레이캐스트 (정적 지형, 요충지 분석·테스트용) ---------------- */
  const stamp = new Uint32Array(Math.max(1, NS));
  let stampId = 0;
  function raySolid(i, ox, oy, oz, dx, dy, dz, maxT) {
    // AABB slab
    let tmin = -Infinity, tmax = maxT;
    if (Math.abs(dx) < 1e-12) { if (ox < MINX[i] || ox > MAXX[i]) return -1; }
    else { let t1 = (MINX[i] - ox) / dx, t2 = (MAXX[i] - ox) / dx; if (t1 > t2) { const q = t1; t1 = t2; t2 = q; } if (t1 > tmin) tmin = t1; if (t2 < tmax) tmax = t2; if (tmin > tmax) return -1; }
    if (Math.abs(dy) < 1e-12) { if (oy < MINY[i] || oy > MAXY[i]) return -1; }
    else { let t1 = (MINY[i] - oy) / dy, t2 = (MAXY[i] - oy) / dy; if (t1 > t2) { const q = t1; t1 = t2; t2 = q; } if (t1 > tmin) tmin = t1; if (t2 < tmax) tmax = t2; if (tmin > tmax) return -1; }
    if (Math.abs(dz) < 1e-12) { if (oz < MINZ[i] || oz > MAXZ[i]) return -1; }
    else { let t1 = (MINZ[i] - oz) / dz, t2 = (MAXZ[i] - oz) / dz; if (t1 > t2) { const q = t1; t1 = t2; t2 = q; } if (t1 > tmin) tmin = t1; if (t2 < tmax) tmax = t2; if (tmin > tmax) return -1; }
    if (tmax < 0) return -1;
    if (K[i] === 0) return tmin < 0 ? 0 : tmin;
    if (K[i] === 1) {
      const rx = ox - CX[i], rz = oz - CZ[i], RR = CR[i];
      const inside = rx * rx + rz * rz <= RR * RR;
      if (inside && oy >= MINY[i] && oy <= MAXY[i]) return 0;
      let best = Infinity;
      const a = dx * dx + dz * dz;
      if (a > 1e-12 && !inside) {
        const bq = 2 * (rx * dx + rz * dz), cq = rx * rx + rz * rz - RR * RR, disc = bq * bq - 4 * a * cq;
        if (disc >= 0) {
          const t = (-bq - Math.sqrt(disc)) / (2 * a);
          if (t >= 0 && t <= maxT) { const y = oy + dy * t; if (y >= MINY[i] && y <= MAXY[i]) best = t; }
        }
      }
      if (Math.abs(dy) > 1e-12) {
        const capY = oy > MAXY[i] ? MAXY[i] : oy < MINY[i] ? MINY[i] : NaN;
        if (capY === capY) {
          const t = (capY - oy) / dy;
          if (t >= 0 && t <= maxT && t < best) { const qx = rx + dx * t, qz = rz + dz * t; if (qx * qx + qz * qz <= RR * RR) best = t; }
        }
      }
      return best === Infinity ? -1 : best;
    }
    // ramp: Cyrus-Beck
    let tE = -Infinity, tX = maxT;
    const b = i * 24;
    for (let q = 0; q < 6; q++) {
      const nx = PLANES[b + q * 4], ny = PLANES[b + q * 4 + 1], nz = PLANES[b + q * 4 + 2], pd = PLANES[b + q * 4 + 3];
      const den = nx * dx + ny * dy + nz * dz, dist = pd - (nx * ox + ny * oy + nz * oz);
      if (Math.abs(den) < 1e-12) { if (dist < 0) return -1; continue; }
      const t = dist / den;
      if (den < 0) { if (t > tE) tE = t; } else if (t < tX) tX = t;
      if (tE > tX) return -1;
    }
    if (tX < 0) return -1;
    return tE < 0 ? 0 : tE;
  }
  /** 정규화된 방향 (dx,dy,dz)로 첫 충돌까지 거리 (없으면 maxT) */
  function rayCast(ox, oy, oz, dx, dy, dz, maxT) {
    let best = maxT;
    if (GROUND !== null && dy < -1e-9 && oy > GROUND) { const t = (GROUND - oy) / dy; if (t < best) best = t; }
    stampId = (stampId + 1) >>> 0;
    if (stampId === 0) { stamp.fill(0); stampId = 1; }
    let gx = Math.floor((ox - HX0) / BK), gz = Math.floor((oz - HZ0) / BK);
    const sx = dx > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1;
    let tMX = Math.abs(dx) > 1e-12 ? ((sx > 0 ? gx + 1 : gx) * BK + HX0 - ox) / dx : Infinity;
    let tMZ = Math.abs(dz) > 1e-12 ? ((sz > 0 ? gz + 1 : gz) * BK + HZ0 - oz) / dz : Infinity;
    const tDX = Math.abs(dx) > 1e-12 ? BK / Math.abs(dx) : Infinity, tDZ = Math.abs(dz) > 1e-12 ? BK / Math.abs(dz) : Infinity;
    for (let guard = 0; guard < 4096; guard++) {
      if (gx >= 0 && gx < NBX && gz >= 0 && gz < NBZ) {
        const b = gx + gz * NBX;
        for (let j = BS[b], e = BS[b + 1]; j < e; j++) {
          const i = BI[j];
          if (stamp[i] === stampId) continue;
          stamp[i] = stampId;
          if (CLIP[i]) continue; // 시야·총알은 clip 막이를 통과
          const t = raySolid(i, ox, oy, oz, dx, dy, dz, best);
          if (t >= 0 && t < best) best = t;
        }
      } else if ((gx < 0 && sx < 0) || (gx >= NBX && sx > 0) || (gz < 0 && sz < 0) || (gz >= NBZ && sz > 0)) break;
      const tn = tMX < tMZ ? tMX : tMZ;
      if (tn >= best) break;
      if (tMX < tMZ) { gx += sx; tMX += tDX; } else { gz += sz; tMZ += tDZ; }
    }
    return best;
  }
  /** a→b 사이를 정적 지형이 막지 않으면 true */
  function raycast(a, b) {
    const ax = PX(a), ay = PY(a), az = PZ(a), bx = PX(b), by = PY(b), bz = PZ(b);
    const dx = bx - ax, dy = by - ay, dz = bz - az, len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!(len > 1e-6)) return true;
    return rayCast(ax, ay, az, dx / len, dy / len, dz / len, len) >= len - 1e-3;
  }
  function boundsDist(x, z, dx, dz) {
    let t = Infinity;
    if (dx > 1e-9) t = Math.min(t, (BMAXX - x) / dx); else if (dx < -1e-9) t = Math.min(t, (BMINX - x) / dx);
    if (dz > 1e-9) t = Math.min(t, (BMAXZ - z) / dz); else if (dz < -1e-9) t = Math.min(t, (BMINZ - z) / dz);
    return Math.max(0, t);
  }

  /* ---------------- 6) 요충지 (긴 시야선·엄폐 분석) ---------------- */
  const points = [];
  const SR = Math.max(4, Math.min(32, num(o.sightRays, 12) | 0));
  const SMAX = Math.max(10, num(o.sightMax, 90));
  if (goodCount > 0 && num(o.strategicSpacing, 6) > 0) {
    const SP = Math.max(2, num(o.strategicSpacing, 6));
    const nbi = Math.ceil(sizeX / SP), nbk = Math.ceil(sizeZ / SP);
    const bestLow = new Int32Array(nbi * nbk).fill(-1), bestHigh = new Int32Array(nbi * nbk).fill(-1);
    const scLow = new Float64Array(nbi * nbk).fill(Infinity), scHigh = new Float64Array(nbi * nbk).fill(Infinity);
    for (let j = 0; j < goodCount; j++) {
      const n = goodList[j];
      const bi = Math.min(nbi - 1, Math.floor((NX[n] - BMINX) / SP)), bk = Math.min(nbk - 1, Math.floor((NZ[n] - BMINZ) / SP));
      const blk = bi + bk * nbi;
      const cxb = BMINX + (bi + 0.5) * SP, czb = BMINZ + (bk + 0.5) * SP;
      const s = Math.hypot(NX[n] - cxb, NZ[n] - czb) + WALLN[n] * 0.4;
      if (NY[n] >= 1.5) { if (s < scHigh[blk]) { scHigh[blk] = s; bestHigh[blk] = n; } }
      else if (s < scLow[blk]) { scLow[blk] = s; bestLow[blk] = n; }
    }
    const dirs = [];
    for (let q = 0; q < SR; q++) { const a = (q / SR) * Math.PI * 2; dirs.push([Math.cos(a), Math.sin(a)]); }
    const pick = [];
    for (let blk = 0; blk < nbi * nbk; blk++) { if (bestLow[blk] >= 0) pick.push(bestLow[blk]); if (bestHigh[blk] >= 0) pick.push(bestHigh[blk]); }
    for (const n of pick) {
      const x = NX[n], y = NY[n] + 1.6, z = NZ[n];
      const dist = new Float32Array(SR);
      let sum = 0, far = 0, near = 0;
      for (let q = 0; q < SR; q++) {
        const dx = dirs[q][0], dz = dirs[q][1];
        const lim = Math.min(SMAX, boundsDist(x, z, dx, dz));
        const d = rayCast(x, y, z, dx, 0, dz, lim);
        dist[q] = d; sum += d; if (d > far) far = d; if (d < 3) near++;
      }
      points.push({ x, y: NY[n], z, node: n, open: sum / SR, far, cover: near / SR, elev: NY[n] >= 1.5, dist });
    }
  }
  tPhase.points = now() - tMark;
  /** 요충지 p에서 수평 방향 (dx,dz)로의 시야 거리 (레이 사이 보간) */
  function sightToward(p, dx, dz) {
    if (!p || !p.dist) return 0;
    let a = Math.atan2(dz, dx); if (a < 0) a += Math.PI * 2;
    const f = (a / (Math.PI * 2)) * SR, i0 = Math.floor(f) % SR, i1 = (i0 + 1) % SR, w = f - Math.floor(f);
    return p.dist[i0] * (1 - w) + p.dist[i1] * w;
  }

  /* ---------------- 7) A* ---------------- */
  const gScore = new Float64Array(N), parent = new Int32Array(N);
  const seen = new Uint32Array(N), closed = new Uint32Array(N);
  let searchId = 0;
  let heapN = new Int32Array(Math.max(64, N)), heapF = new Float64Array(Math.max(64, N)), heapSize = 0;
  function heapPush(n, f) {
    if (heapSize >= heapN.length) {
      const a = new Int32Array(heapN.length * 2), b = new Float64Array(heapN.length * 2);
      a.set(heapN); b.set(heapF); heapN = a; heapF = b;
    }
    let i = heapSize++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heapF[p] <= f) break;
      heapN[i] = heapN[p]; heapF[i] = heapF[p]; i = p;
    }
    heapN[i] = n; heapF[i] = f;
  }
  function heapPop() {
    const top = heapN[0];
    const n = heapN[--heapSize], f = heapF[heapSize];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= heapSize) break;
      if (c + 1 < heapSize && heapF[c + 1] < heapF[c]) c++;
      if (heapF[c] >= f) break;
      heapN[i] = heapN[c]; heapF[i] = heapF[c]; i = c;
    }
    heapN[i] = n; heapF[i] = f;
    return top;
  }
  function nextSearch() {
    searchId = (searchId + 1) >>> 0;
    if (searchId === 0) { seen.fill(0); closed.fill(0); searchId = 1; }
    heapSize = 0;
  }
  let lastExpanded = 0;
  function astar(s, g, avoid, maxExpand) {
    nextSearch();
    const gx = NX[g], gz = NZ[g];
    const allowBad = !GOOD[s];
    const hasAvoid = Array.isArray(avoid) && avoid.length > 0;
    gScore[s] = 0; parent[s] = -1; seen[s] = searchId;
    const h0 = Math.abs(NX[s] - gx), h1 = Math.abs(NZ[s] - gz);
    heapPush(s, (h0 + h1 - (2 - SQRT2) * Math.min(h0, h1)) * 1.0001);
    let expanded = 0;
    while (heapSize > 0) {
      const n = heapPop();
      if (closed[n] === searchId) continue;
      closed[n] = searchId;
      if (n === g) { lastExpanded = expanded; return reconstruct(g); }
      if (++expanded > maxExpand) break;
      const gn = gScore[n];
      for (let d = 0; d < 8; d++) {
        const e = n * 8 + d, m = NB[e];
        if (m < 0 || closed[m] === searchId) continue;
        if (!GOOD[m] && !allowBad && m !== g) continue;
        let c = gn + COST[e];
        if (hasAvoid) c += avoidCost(avoid, NX[m], NZ[m]);
        if (seen[m] !== searchId || c < gScore[m]) {
          seen[m] = searchId; gScore[m] = c; parent[m] = n;
          const hx = Math.abs(NX[m] - gx), hz = Math.abs(NZ[m] - gz);
          heapPush(m, c + (hx + hz - (2 - SQRT2) * Math.min(hx, hz)) * 1.0001);
        }
      }
      // GOOD 밖에서 돌아오는 뛰어내리기 간선(GOOD 칸에는 없다)
      const esc = ESC.size ? ESC.get(n) : null;
      if (esc) {
        for (let i = 0; i < esc.length; i += 2) {
          const m = esc[i];
          if (closed[m] === searchId) continue;
          let c = gn + esc[i + 1];
          if (hasAvoid) c += avoidCost(avoid, NX[m], NZ[m]);
          if (seen[m] !== searchId || c < gScore[m]) {
            seen[m] = searchId; gScore[m] = c; parent[m] = n;
            const hx = Math.abs(NX[m] - gx), hz = Math.abs(NZ[m] - gz);
            heapPush(m, c + (hx + hz - (2 - SQRT2) * Math.min(hx, hz)) * 1.0001);
          }
        }
      }
      // 넘어가기 점프 간선
      for (let e = XS[n], e1 = XS[n + 1]; e < e1; e++) {
        const m = XT[e];
        if (closed[m] === searchId) continue;
        if (!GOOD[m] && !allowBad && m !== g) continue;
        let c = gn + XC[e];
        if (hasAvoid) c += avoidCost(avoid, NX[m], NZ[m]);
        if (seen[m] !== searchId || c < gScore[m]) {
          seen[m] = searchId; gScore[m] = c; parent[m] = n;
          const hx = Math.abs(NX[m] - gx), hz = Math.abs(NZ[m] - gz);
          heapPush(m, c + (hx + hz - (2 - SQRT2) * Math.min(hx, hz)) * 1.0001);
        }
      }
    }
    lastExpanded = expanded;
    return null;
  }
  function avoidCost(avoid, x, z) {
    let c = 0;
    for (let i = 0; i < avoid.length; i++) {
      const a = avoid[i];
      const dx = x - a.x, dz = z - a.z, r = a.r || 5;
      const d2 = dx * dx + dz * dz;
      if (d2 < r * r) c += (a.cost || 4) * (1 - Math.sqrt(d2) / r);
    }
    return c;
  }
  function reconstruct(g) {
    const out = [];
    for (let n = g; n >= 0; n = parent[n]) out.push(n);
    out.reverse();
    return out;
  }
  function edgeType(a, b) {
    for (let d = 0; d < 8; d++) if (NB[a * 8 + d] === b) return ET[a * 8 + d];
    for (let e = XS[a]; e < XS[a + 1]; e++) if (XT[e] === b) return JUMP;
    const esc = ESC.size ? ESC.get(a) : null;
    if (esc) for (let i = 0; i < esc.length; i += 2) if (esc[i] === b) return DROP;
    return 0;
  }

  /* ---------------- 8) 평탄화 ---------------- */
  /** 노드 a → b 직선이 걷기 간선만으로 이어지는가 (칸 단위 DDA, 모서리 통과는 양쪽 모두 확인) */
  function walkLine(a, b) {
    if (a === b) return true;
    const ca = NC[a], cb = NC[b];
    let ci = ca % NXC, ck = (ca - ci) / NXC;
    const ti = cb % NXC, tk = (cb - ti) / NXC;
    const dx = NX[b] - NX[a], dz = NZ[b] - NZ[a];
    const sx = dx > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1;
    const dX = sx > 0 ? 0 : 1, dZ = sz > 0 ? 2 : 3;
    const adx = Math.abs(dx), adz = Math.abs(dz);
    let tMX = adx > 1e-9 ? (0.5 * CELL) / adx : Infinity, tMZ = adz > 1e-9 ? (0.5 * CELL) / adz : Infinity;
    const tDX = adx > 1e-9 ? CELL / adx : Infinity, tDZ = adz > 1e-9 ? CELL / adz : Infinity;
    let cur = a;
    for (let guard = 0; (ci !== ti || ck !== tk) && guard < 100000; guard++) {
      const diff = tMX - tMZ;
      if (Math.abs(diff) < 1e-9) {
        const ex = cur * 8 + dX, ez = cur * 8 + dZ;
        const p = NB[ex], q = NB[ez];
        if (p < 0 || q < 0 || ET[ex] !== WALK || ET[ez] !== WALK) return false;
        const pz = p * 8 + dZ, qx = q * 8 + dX;
        if (NB[pz] < 0 || NB[pz] !== NB[qx] || ET[pz] !== WALK || ET[qx] !== WALK) return false;
        cur = NB[pz]; ci += sx; ck += sz; tMX += tDX; tMZ += tDZ;
      } else if (diff < 0) {
        const e = cur * 8 + dX;
        if (NB[e] < 0 || ET[e] !== WALK) return false;
        cur = NB[e]; ci += sx; tMX += tDX;
      } else {
        const e = cur * 8 + dZ;
        if (NB[e] < 0 || ET[e] !== WALK) return false;
        cur = NB[e]; ck += sz; tMZ += tDZ;
      }
    }
    return cur === b;
  }
  /** 실제 기하로 a → b 직선 걷기 확인 (평탄화 결과 검증용) */
  function exactWalk(a, b) {
    const fy = traverse(NX[a], NY[a], NZ[a], NX[b], NZ[b], false);
    return fy === fy && trDrop === 0 && Math.abs(fy - NY[b]) < 0.06;
  }
  /** path[i0..i1] (걷기 간선만) 구간을 줄당기기 → 남길 인덱스(i0 제외, i1 포함) */
  let curAvoid = null; // findPath 동안의 회피 구역 (평탄화가 구역을 가로지르지 않게)
  /** 선분이 (시작점이 이미 안에 있지 않은) 회피 구역을 지나가면 false */
  function avoidOK(a, b) {
    if (!curAvoid) return true;
    const ax = NX[a], az = NZ[a], dx = NX[b] - ax, dz = NZ[b] - az, L2 = dx * dx + dz * dz;
    for (let i = 0; i < curAvoid.length; i++) {
      const z0 = curAvoid[i], r = z0.r || 5;
      let t = L2 > 1e-9 ? ((z0.x - ax) * dx + (z0.z - az) * dz) / L2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      if (t <= 1e-6) continue; // 시작점이 가장 가까움 = 구역에서 멀어지는 중
      const qx = ax + dx * t - z0.x, qz = az + dz * t - z0.z;
      if (qx * qx + qz * qz < r * r) return false;
    }
    return true;
  }
  const lineOK = (a, b) => walkLine(a, b) && avoidOK(a, b);
  function pull(path, i0, i1, out) {
    let anchor = i0;
    while (anchor < i1) {
      let best = anchor + 1, step = 2;
      while (anchor + step <= i1 && lineOK(path[anchor], path[anchor + step])) { best = anchor + step; step *= 2; }
      let lo = best, hi = Math.min(anchor + step, i1 + 1);
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (lineOK(path[anchor], path[mid])) lo = mid; else hi = mid;
      }
      // 실제 기하 검증: 실패하면 절반씩 줄인다
      let pick = lo;
      while (pick > anchor + 1 && !exactWalk(path[anchor], path[pick])) pick = anchor + ((pick - anchor) >> 1);
      out.push(pick);
      anchor = pick;
    }
  }
  function toWaypoints(path, from, to, smooth) {
    const L = path.length;
    const keep = [];
    if (smooth) {
      let segStart = 0;
      for (let j = 1; j < L; j++) {
        const t = edgeType(path[j - 1], path[j]);
        if (t !== WALK) { if (j - 1 > segStart) pull(path, segStart, j - 1, keep); keep.push(j); segStart = j; }
      }
      if (L - 1 > segStart) pull(path, segStart, L - 1, keep);
    } else for (let j = 1; j < L; j++) keep.push(j);
    const pts = [];
    for (const j of keep) {
      const n = path[j], t = edgeType(path[j - 1] ?? path[0], n);
      const wp = { x: NX[n], y: NY[n], z: NZ[n], node: n };
      if (t === JUMP) {
        wp.jump = true;
        // 도약 지점(벽에 닿기 직전): 봇은 여기 가까워지면 뛴다
        const a = path[j - 1];
        const fy = traverse(NX[a], NY[a], NZ[a], NX[n], NZ[n], true);
        if (fy === fy && trJump) { wp.jumpAt = { x: trJX, z: trJZ }; wp.jumpTop = trJY; } // jumpTop = 넘어야 할 턱 윗면 높이
      } else if (t === DROP) wp.drop = true;
      pts.push(wp);
    }
    // 시작: 현재 위치에서 첫 경유점으로 바로 못 가면 시작 노드를 먼저 들른다
    const fx = PX(from), fz = PZ(from), s = path[0];
    if (pts.length && Number.isFinite(fx) && Number.isFinite(fz)) {
      const first = pts[0];
      const fy = Number.isFinite(PY(from)) ? Math.min(Math.max(PY(from), NY[s]), NY[s] + STEP) : NY[s];
      const ok = Math.hypot(fx - NX[s], fz - NZ[s]) < 0.2 ||
        (!first.jump && !first.drop && straightOK(fx, fy, fz, first.x, first.y, first.z, 0.06));
      if (!ok) pts.unshift({ x: NX[s], y: NY[s], z: NZ[s], node: s });
    }
    // 끝: 목표 지점이 마지막 노드 칸 안이면 정확한 목표 좌표로
    const tx = PX(to), tz = PZ(to);
    if (Number.isFinite(tx) && Number.isFinite(tz)) {
      const g = path[L - 1];
      if (Math.abs(tx - NX[g]) <= CELL * 0.5 && Math.abs(tz - NZ[g]) <= CELL * 0.5 && standable(tx, tz, NY[g])) {
        if (pts.length) { const last = pts[pts.length - 1]; if (last.node === g) { last.x = tx; last.z = tz; } }
        else pts.push({ x: tx, y: NY[g], z: tz, node: g });
      }
    }
    if (!pts.length) pts.push({ x: NX[path[L - 1]], y: NY[path[L - 1]], z: NZ[path[L - 1]], node: path[L - 1] });
    return pts;
  }

  /* ---------------- 공개 API ---------------- */
  /**
   * 경로 탐색.
   * @param from {x,y,z}|[x,y,z] (y = 발 높이, 모르면 생략)
   * @param to   {x,y,z}|[x,y,z]
   * @param [opts] { smooth=true, avoid:[{x,z,r,cost}], maxExpand }
   * @returns 경유점 배열 [{x,y,z,node, jump?, drop?}] (시작점 제외, 마지막 = 목표) 또는 null
   */
  function findPath(from, to, opts) {
    const op = opts || {};
    const s = locate(PX(from), PY(from), PZ(from), 6, false);
    if (s < 0) return null;
    let g = locate(PX(to), PY(to), PZ(to), Math.ceil(12 / CELL), true);
    if (g < 0) g = locate(PX(to), PY(to), PZ(to), Math.ceil(12 / CELL), false);
    if (g < 0) return null;
    if (s === g) return toWaypoints([s], from, to, false);
    const avoid = Array.isArray(op.avoid) && op.avoid.length ? op.avoid : null;
    const path = astar(s, g, avoid, op.maxExpand > 0 ? op.maxExpand : N + 1);
    if (!path) return null;
    curAvoid = avoid;
    try { return toWaypoints(path, from, to, op.smooth !== false); } finally { curAvoid = null; }
  }

  function randomGood(rng) {
    if (!goodCount) return -1;
    return goodList[Math.min(goodCount - 1, Math.floor(rng() * goodCount))];
  }
  const nodePoint = (n) => (n < 0 ? null : { x: NX[n], y: NY[n], z: NZ[n] });
  /**
   * 걸을 수 있는 무작위 지점.
   * @param [region] 없음(맵 전체) | {x,z,r, minR?} 원 | {minX,maxX,minZ,maxZ} 사각형 | (+ minY / maxY 높이 필터)
   * @param [rng] () => [0,1) (기본 Math.random)
   */
  function randomPoint(region, rng) {
    const rnd = typeof rng === 'function' ? rng : Math.random;
    if (!goodCount) return null;
    const minY = region && isNum(region.minY) ? region.minY : -Infinity;
    const maxY = region && isNum(region.maxY) ? region.maxY : Infinity;
    const okY = (n) => NY[n] >= minY - 1e-3 && NY[n] <= maxY + 1e-3;
    if (!region || (region.r == null && region.minX == null)) {
      for (let t = 0; t < 64; t++) { const n = randomGood(rnd); if (okY(n)) return nodePoint(n); }
      for (let j = 0; j < goodCount; j++) if (okY(goodList[j])) return nodePoint(goodList[j]);
      return null;
    }
    if (region.r != null) {
      const cx = num(region.x, 0), cz = num(region.z, 0), r = Math.max(0, num(region.r, 5)), r0 = Math.max(0, Math.min(r, num(region.minR, 0)));
      for (let t = 0; t < 48; t++) {
        const a = rnd() * Math.PI * 2, d = Math.sqrt(r0 * r0 + rnd() * (r * r - r0 * r0));
        const n = locate(cx + Math.cos(a) * d, NaN, cz + Math.sin(a) * d, 0, true);
        if (n >= 0 && okY(n)) {
          const dd = Math.hypot(NX[n] - cx, NZ[n] - cz);
          if (dd <= r + CELL && dd >= r0 - CELL) return nodePoint(n);
        }
      }
      const n = locate(cx, NaN, cz, Math.ceil((r + 6) / CELL), true);
      return n >= 0 && okY(n) ? nodePoint(n) : null;
    }
    const x0 = num(region.minX, BMINX), x1 = num(region.maxX, BMAXX), z0 = num(region.minZ, BMINZ), z1 = num(region.maxZ, BMAXZ);
    for (let t = 0; t < 48; t++) {
      const n = locate(x0 + rnd() * (x1 - x0), NaN, z0 + rnd() * (z1 - z0), 0, true);
      if (n >= 0 && okY(n)) return nodePoint(n);
    }
    const n = locate((x0 + x1) / 2, NaN, (z0 + z1) / 2, Math.ceil(Math.max(x1 - x0, z1 - z0) / CELL), true);
    return n >= 0 && okY(n) ? nodePoint(n) : null;
  }

  /** 가장 가까운 걸을 수 있는 지점 {x,y,z,node,dist} (maxDist 안에 없으면 null) */
  function nearestWalkable(p, maxDist) {
    const md = num(maxDist, 8);
    const n = locate(PX(p), PY(p), PZ(p), Math.max(1, Math.ceil(md / CELL)), true);
    if (n < 0) return null;
    const dist = Math.hypot(NX[n] - PX(p), NZ[n] - PZ(p));
    if (dist > md + CELL) return null;
    return { x: NX[n], y: NY[n], z: NZ[n], node: n, dist };
  }

  /** 두 위치 사이를 똑바로 걸어갈 수 있는가 (칸 단위, 빠름) */
  function losWalk(a, b) {
    const na = locate(PX(a), PY(a), PZ(a), 2, false), nb = locate(PX(b), PY(b), PZ(b), 2, false);
    if (na < 0 || nb < 0) return false;
    return walkLine(na, nb);
  }

  /**
   * 실제 기하로 a(발 위치) → b 직선 걷기 확인: 벽·낭떠러지 없이 b 높이에 닿으면 true.
   * 칸 단위 losWalk보다 정확하다(봇이 경유점 모서리를 자를 때 확인용, 10m에 수십 µs).
   */
  function walkStraight(a, b) {
    const ax = PX(a), az = PZ(a), bx = PX(b), bz = PZ(b);
    if (!Number.isFinite(ax) || !Number.isFinite(bx)) return false;
    let ay = PY(a);
    if (!Number.isFinite(ay)) { const n = locate(ax, NaN, az, 1, false); if (n < 0) return false; ay = NY[n]; }
    return straightOK(ax, ay, az, bx, PY(b), bz, 0.3);
  }

  /** p에서 걸어서 maxDist 안에 닿는 노드들 (가까운 순, 벽에 붙은 칸 우선 표시) — 엄폐 후보용 */
  function reachable(p, maxDist, maxCount, opts) {
    const s = locate(PX(p), PY(p), PZ(p), 4, false);
    if (s < 0) return [];
    const md = Math.max(CELL, num(maxDist, 12)), cnt = Math.max(1, num(maxCount, 24) | 0);
    const minSep = num(opts && opts.minSep, CELL * 1.5);
    const wallOnly = !(opts && opts.wallOnly === false);
    nextSearch();
    gScore[s] = 0; seen[s] = searchId;
    heapPush(s, 0);
    const found = [];
    while (heapSize > 0) {
      const n = heapPop();
      if (closed[n] === searchId) continue;
      closed[n] = searchId;
      found.push(n);
      const gn = gScore[n];
      for (let d = 0; d < 8; d++) {
        const e = n * 8 + d, m = NB[e];
        if (m < 0 || ET[e] !== WALK || closed[m] === searchId || !GOOD[m]) continue;
        const c = gn + COST[e];
        if (c > md) continue;
        if (seen[m] !== searchId || c < gScore[m]) { seen[m] = searchId; gScore[m] = c; heapPush(m, c); }
      }
    }
    const out = [];
    for (const n of found) {
      if (n === s) continue;
      if (wallOnly && WALLN[n] < 2) continue;
      let close = false;
      for (const q of out) if (Math.abs(q.x - NX[n]) < minSep && Math.abs(q.z - NZ[n]) < minSep && Math.abs(q.y - NY[n]) < 1) { close = true; break; }
      if (close) continue;
      out.push({ x: NX[n], y: NY[n], z: NZ[n], node: n, dist: gScore[n], wall: WALLN[n] });
      if (out.length >= cnt) break;
    }
    return out;
  }

  /**
   * 좌·중·우 진격로 경유점. from(우리 스폰) → to(적 스폰) 축 기준, 바라보는 사람의 왼쪽/오른쪽.
   * @returns {{left:[p,p], center:[p,p], right:[p,p]}}
   */
  function lanes(from, to, opts) {
    const fx = PX(from), fz = PZ(from), tx = PX(to), tz = PZ(to);
    const ax = tx - fx, az = tz - fz, L = Math.hypot(ax, az) || 1;
    const ux = ax / L, uz = az / L;
    const rx = -uz, rz = ux; // 오른쪽 (yaw 규약: right = (-fz, fx))
    const fracs = (opts && opts.fracs) || [0.35, 0.65];
    const width = num(opts && opts.width, 0.6);
    const res = { left: [], center: [], right: [] };
    for (const [name, side] of [['left', -1], ['center', 0], ['right', 1]]) {
      for (const f of fracs) {
        const bx = fx + ax * f, bz = fz + az * f;
        let px = bx, pz = bz;
        if (side !== 0) {
          const w = boundsDist(bx, bz, rx * side, rz * side) * width;
          px = bx + rx * side * w; pz = bz + rz * side * w;
        }
        const n = locate(px, NaN, pz, Math.ceil(16 / CELL), true);
        if (n >= 0) res[name].push({ x: NX[n], y: NY[n], z: NZ[n], node: n });
      }
    }
    return res;
  }

  /** (x,z)에서 nearY에 가장 가까운 바닥 높이 (없으면 null) */
  function floorAt(x, z, nearY) {
    const n = locate(x, nearY, z, 0, false);
    return n >= 0 ? NY[n] : null;
  }
  function isWalkable(p) {
    const n = locate(PX(p), PY(p), PZ(p), 0, true);
    if (n < 0) return false;
    const y = PY(p);
    return !Number.isFinite(y) || Math.abs(NY[n] - y) <= STEP + 0.1;
  }

  const buildMs = now() - t0;
  const nav = {
    findPath, randomPoint, nearestWalkable, losWalk, walkStraight, raycast, isWalkable, floorAt, lanes,
    coverCandidates: (p, maxDist, maxCount, opts) => reachable(p, maxDist, maxCount, opts),
    rayDistance(origin, dir, maxDist) {
      const dx = PX(dir), dy = PY(dir) || 0, dz = PZ(dir), l = Math.hypot(dx, dy, dz) || 1;
      return rayCast(PX(origin), PY(origin), PZ(origin), dx / l, dy / l, dz / l, num(maxDist, 200));
    },
    sightToward,
    /** 노드 인덱스 (내부용·디버그) */
    nodeAt: (p, goodOnly) => locate(PX(p), PY(p), PZ(p), 3, !!goodOnly),
    node: (n) => (n >= 0 && n < N ? { x: NX[n], y: NY[n], z: NZ[n], good: !!GOOD[n], wall: WALLN[n] } : null),
    edgeType,
    points,
    spawns: spawnsOut,
    /** theme.fog [near, far] (봇 시야 거리 상한에 쓰임) */
    fog: [theme.fog[0], theme.fog[1]],
    bounds: { minX: BMINX, maxX: BMAXX, minZ: BMINZ, maxZ: BMAXZ },
    options: { cell: CELL, agentRadius: R, stepHeight: STEP, agentHeight: HGT, maxDrop: MAXDROP, jumpHeight: JUMPH },
    info: { mapId: map.id || null, holes: NH, fastEdges, vaultEdges, escapeEdges, cols: NCOL, nx: NXC, nz: NZC, cell: CELL, nodes: N, good: goodCount, edges: edgeCount, solids: NS, points: points.length, buildMs, phases: tPhase },
    get lastExpanded() { return lastExpanded; },
    /** 디버그 오버레이용 원시 배열 (읽기 전용으로 쓸 것) */
    debug: () => ({ nx: NXC, nz: NZC, cell: CELL, ox: OX, oz: OZ, colStart, x: NX, y: NY, z: NZ, good: GOOD, nb: NB, et: ET, wall: WALLN }),
    dispose() {}
  };
  return nav;
}

export default buildNavGrid;
