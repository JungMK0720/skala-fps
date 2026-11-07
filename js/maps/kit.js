/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 맵 제작 도우미(순수 함수). 맵 파일을 짧고 대칭으로 쓰게 도형 생성과 좌우·앞뒤·180° 뒤집기를 제공한다.
 */
/**
 * SKALA FPS — 맵 제작 도우미. 사용법은 docs/MAP_GUIDE.md.
 *
 * 하나를 돌려주는 함수: box, ramp, cyl, wall, pillar
 * 배열을 돌려주는 함수: stairs, platform, doorwayWall, clipAbove, mirrorX, mirrorZ, rotate180
 * solids에는 평평한 배열을 넣어야 한다: solids: [box(...), stairs(...), ...].flat()
 * 잘못된 도형(대각선 벽, 문이 벽 밖으로 나감 등)은 바로 오류를 던져 맵을 쓰는 중에 알아차리게 한다.
 */
import { PLAYER, toRad } from '../core/consts.js';

/** 자동 계단의 단 높이(m). 걸어서 오르는 한계 PLAYER.STEP보다 낮다 */
const AUTO_STEP = 0.3;
/** 사람이 지나가는 문의 최소 크기(m) */
const MIN_DOOR_W = 0.8;
const MIN_DOOR_TOP = PLAYER.HEIGHT + 0.05;

/* ---------------- 도형 ---------------- */

/** 상자. x,z = 바닥 중심, y = 바닥 높이 */
export function box(x, y, z, w, h, d, mat = 'concrete') {
  return { type: 'box', x, y, z, w, h, d, mat };
}

/** 경사로. 위치·크기는 box와 같고 dir('+x'|'-x'|'+z'|'-z') 쪽으로 올라간다 */
export function ramp(x, y, z, w, h, d, dir = '+x', mat = 'concrete') {
  return { type: 'ramp', x, y, z, w, h, d, dir, mat };
}

/** 세로 원통 */
export function cyl(x, y, z, r, h, mat = 'concrete') {
  return { type: 'cyl', x, y, z, r, h, mat };
}

function wallAxis(x0, z0, x1, z1, fn) {
  const alongX = z0 === z1, alongZ = x0 === x1;
  if (alongX === alongZ) throw new Error(`${fn}: (${x0},${z0})→(${x1},${z1}) must be axis-aligned and have length`);
  return alongX;
}

/** 축에 나란한 벽 한 칸. (x0,z0)→(x1,z1)이 벽 중심선이고 t가 두께다 */
export function wall(x0, z0, x1, z1, h, t = 0.4, mat = 'concrete', y = 0) {
  return wallAxis(x0, z0, x1, z1, 'wall')
    ? box((x0 + x1) / 2, y, z0, Math.abs(x1 - x0), h, t, mat)
    : box(x0, y, (z0 + z1) / 2, t, h, Math.abs(z1 - z0), mat);
}

/** 네모 기둥 */
export function pillar(x, z, h, s = 0.6, mat = 'concrete', y = 0) {
  return box(x, y, z, s, h, s, mat);
}

/**
 * 속이 찬 계단. 위치·크기는 ramp와 같아서 서로 바꿔 쓸 수 있다.
 * @param {number} [steps] 단 수. 생략하면 단 높이가 0.3 m 이하가 되게 정한다
 */
export function stairs(x, y, z, w, h, d, dir = '+x', mat = 'concrete', steps = 0) {
  const n = steps > 0 ? Math.round(steps) : Math.ceil(h / AUTO_STEP - 1e-9);
  const rise = h / n;
  if (rise > PLAYER.STEP) throw new Error(`stairs: step ${rise.toFixed(2)} m is higher than PLAYER.STEP ${PLAYER.STEP}; use more steps`);
  const alongX = dir === '+x' || dir === '-x';
  const sign = dir === '+x' || dir === '+z' ? 1 : -1;
  const run = (alongX ? w : d) / n;
  const out = [];
  for (let i = 0; i < n; i++) {
    const off = sign * (run * (i + 0.5) - (alongX ? w : d) / 2);
    const top = rise * (i + 1);
    out.push(alongX ? box(x + off, y, z, run, top, d, mat) : box(x, y, z + off, w, top, run, mat));
  }
  return out;
}

/**
 * 판 + 네 귀 다리. 윗면 높이를 top으로 정한다.
 * @param {{t?:number, legs?:boolean, legMat?:string, leg?:number, base?:number}} [opt]
 *   t 판 두께(0.3) · legs 다리 여부(true) · legMat 다리 재질(판과 같음) · leg 다리 굵기(0.3) · base 다리 밑 높이(0)
 */
export function platform(x, top, z, w, d, mat = 'concrete', opt = {}) {
  const t = opt.t ?? 0.3, base = opt.base ?? 0, leg = opt.leg ?? 0.3, legMat = opt.legMat ?? mat;
  const out = [box(x, top - t, z, w, t, d, mat)];
  const legH = top - t - base;
  if (opt.legs !== false && legH > 0.05) {
    const lx = w / 2 - leg / 2, lz = d / 2 - leg / 2;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) out.push(box(x + sx * lx, base, z + sz * lz, leg, legH, leg, legMat));
  }
  return out;
}

/**
 * 문이나 창이 뚫린 벽. 벽 중심선과 h·t는 wall과 같다.
 * @param {{at?:number|number[], w?:number, top?:number, sill?:number, y?:number}} [door]
 *   at 구멍 중심(벽 방향의 월드 좌표, 여러 개면 배열, 생략하면 벽 가운데)
 *   w 구멍 폭(1.8, 봇 내비 칸이 1 m라서 이보다 좁으면 봇이 못 지나갈 수 있다)
 *   top 구멍 윗변 높이(벽 밑 기준, 2.4) · sill 구멍 아랫변 높이(0이면 문, 0보다 크면 창) · y 벽 밑 높이(0)
 */
export function doorwayWall(x0, z0, x1, z1, h, t = 0.4, mat = 'concrete', door = {}) {
  const alongX = wallAxis(x0, z0, x1, z1, 'doorwayWall');
  const a = alongX ? Math.min(x0, x1) : Math.min(z0, z1), b = alongX ? Math.max(x0, x1) : Math.max(z0, z1);
  const fixed = alongX ? z0 : x0;
  const w = door.w ?? 1.8, top = door.top ?? 2.4, sill = door.sill ?? 0, y = door.y ?? 0;
  const centers = (Array.isArray(door.at) ? door.at : [door.at ?? (a + b) / 2]).slice().sort((p, q) => p - q);
  if (sill === 0 && (w < MIN_DOOR_W || top < MIN_DOOR_TOP)) throw new Error(`doorwayWall: a door needs w >= ${MIN_DOOR_W} and top >= ${MIN_DOOR_TOP}; got w=${w}, top=${top}`);
  if (top > h || sill >= top) throw new Error(`doorwayWall: opening ${sill}..${top} does not fit a wall of height ${h}`);
  const seg = (p, q, y0, hh) => (alongX
    ? box((p + q) / 2, y0, fixed, q - p, hh, t, mat)
    : box(fixed, y0, (p + q) / 2, t, hh, q - p, mat));
  const out = [];
  let cur = a;
  for (const c of centers) {
    const p = c - w / 2, q = c + w / 2;
    if (p < cur - 1e-9 || q > b + 1e-9) throw new Error(`doorwayWall: opening at ${c} (width ${w}) overlaps another opening or leaves the wall ${a}..${b}`);
    if (p - cur > 1e-6) out.push(seg(cur, p, y, h));
    if (top < h) out.push(seg(p, q, y + top, h - top));
    if (sill > 0) out.push(seg(p, q, y, sill));
    cur = q;
  }
  if (b - cur > 1e-6) out.push(seg(cur, b, y, h));
  return out;
}

const flatten = (list) => (Array.isArray(list) ? list.flat(Infinity) : [list]);

/**
 * 도형 바로 위에 보이지 않는 막이를 올린다. 사람은 막고 총알·시야는 통과한다(mat 'clip').
 * 낮은 벽을 넘어 물이나 맵 밖으로 나가지 못하게 할 때 쓴다. 경사로는 높은 끝을 기준으로 막는다.
 * @param {object|object[]} solids 도형 하나 또는 배열
 * @param {number} [h] 막이 높이(m)
 */
export function clipAbove(solids, h = 8) {
  return flatten(solids).map((s) => (s.type === 'cyl'
    ? cyl(s.x, s.y + s.h, s.z, s.r, h, 'clip')
    : box(s.x, s.y + s.h, s.z, s.w, h, s.d, 'clip')));
}

/* ---------------- 대칭 ---------------- */

const FLIP_DIR = { '+x': '-x', '-x': '+x', '+z': '-z', '-z': '+z' };
/** rotY가 없어도 방향이 있는 장식(0으로 친다) */
const FACING_TYPES = new Set(['sign', 'banner', 'vent', 'loadingArm', 'crateStack']);
const noNegZero = (v) => (v === 0 ? 0 : v);

/** 스폰처럼 {x,z[,y,rotY]}만 있는 점 */
const isBarePoint = (o) => o.type === undefined && o.w === undefined && o.target === undefined && o.vel === undefined && o.to === undefined && o.id === undefined;

function flipYaw(rotY, sx, sz) {
  const a = toRad(rotY || 0);
  const out = Math.atan2(sx * Math.sin(a), sz * Math.cos(a));
  return out <= -Math.PI + 1e-9 ? Math.PI : noNegZero(out);
}

function flipVec(v, sx, sz) {
  return Array.isArray(v) ? [noNegZero(v[0] * sx), v[1], noNegZero(v[2] * sz)] : v;
}

function flipOne(o, sx, sz, suffix) {
  if (!o || typeof o !== 'object') return o;
  const c = { ...o };
  if (typeof c.x === 'number') c.x = noNegZero(c.x * sx);
  if (typeof c.z === 'number') c.z = noNegZero(c.z * sz);
  if (typeof c.dir === 'string' && FLIP_DIR[c.dir]) {
    const onX = c.dir.endsWith('x');
    if ((onX && sx < 0) || (!onX && sz < 0)) c.dir = FLIP_DIR[c.dir];
  }
  for (const key of ['from', 'target', 'vel']) if (c[key]) c[key] = flipVec(c[key], sx, sz);
  if (Array.isArray(c.to)) c.to = flipVec(c.to, sx, sz);
  else if (c.to && typeof c.to === 'object') {
    c.to = { ...c.to, x: noNegZero(c.to.x * sx), z: noNegZero(c.to.z * sz) };
    if (c.to.rotY !== undefined) c.to.rotY = flipYaw(c.to.rotY, sx, sz);
  }
  if (c.rotY !== undefined || FACING_TYPES.has(c.type) || isBarePoint(c)) c.rotY = flipYaw(c.rotY, sx, sz);
  if (c.id !== undefined && c.id !== null) c.id = `${c.id}${suffix}`;
  return c;
}

const flipList = (list, sx, sz, suffix) => flatten(list).map((o) => flipOne(o, sx, sz, suffix));

/** x → -x로 뒤집은 복사본 (원본은 포함하지 않는다) */
export function mirrorX(list) { return flipList(list, -1, 1, '_mx'); }

/** z → -z로 뒤집은 복사본 (원본은 포함하지 않는다) */
export function mirrorZ(list) { return flipList(list, 1, -1, '_mz'); }

/**
 * 원점을 중심으로 180° 돌린 복사본 (원본은 포함하지 않는다). 양 팀이 공정한 맵의 기본 대칭이다.
 * solids·decor·pads·portals·secrets·props·spawns를 모두 받는다. 경사로 방향·rotY·target·vel·to를 함께 뒤집고,
 * 비밀 스팟 id에는 꼬리표(_mx·_mz·_r)를 붙여 겹치지 않게 한다.
 */
export function rotate180(list) { return flipList(list, -1, -1, '_r'); }
