/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 항구 골목(Harbor Alley). 해 질 녘 항구 뒷골목의 좁은 근접전 맵으로, 양쪽 야적장에서 나온 골목 3개가 가운데 우물 광장에서 만난다.
 *          서쪽 절반만 적고 rotate180으로 동쪽을 만들어 양 팀이 공정하다.
 */
import { TEAMS } from '../core/consts.js';
import { box, ramp, cyl, doorwayWall, clipAbove, rotate180 } from './kit.js';

// 방위: 북 = -z, 남 = +z. 블루 = -x, 오렌지 = +x. 아래는 서쪽 절반이고 동쪽은 원점 기준 180° 돌린 복사본이다.
//
//         x -28      -20        -14 -12      -9   -6     -2  0
//  z -18  담 ┌ 발판 ──┬ 지붕길(y 5, 발판 → 물탱크) ──────┬ 중앙채 ┐
//  z -14     │ 야적장 ├ 북 골목 ─────────────── 나무 문 ─┐│        │
//  z -10     │ (스폰) ├ 벽돌 창고 ┬연결 통로┬ 벽돌 창고  ├┤ 북쪽   │
//  z -5      │        ├ 가운데 골목 ────┐   ┌ 별채 ──────┤ 입구 ──┘
//  z -1      │ 막이벽 ├ 민가 ───────────┤꺾임│           └ 우물 광장(x ±6, z ±5)
//  z 2       │        │                 └─── 가운데 입구 ┘ 원점에 물탱크
//  z 5       │        ├ 남 골목 ┬ 민가 ──┬ 뒷마당 ────── 광장 남쪽 입구
//  z 9       │        ├ 큰 창고 │세로    │     │
//  z 13      └ 큰 창고 ─────────┤골목    ├ 살림채 문 ┐
//  z 18                         └ 부둣가 ─ 낮은 안벽 ┘ 너머는 바다
//
//  연결 통로는 절반에 하나씩 모두 2개다. 지붕길은 블루 쪽 북 골목 위, 돌려서 오렌지 쪽 남 골목 위에 있다.
//  물탱크는 원점에 하나뿐이라 양 팀 발판이 같은 곳으로 간다. 비밀 스팟도 돌리지 않아 보상이 한 번이다.
//  걸어 다니는 지붕 말고는 처마까지 clip으로 덮어 물탱크에서 뛰어도 다른 지붕에 올라서지 못한다.

/* ---------------- 치수 ---------------- */

const PLINTH = 0.8;      // 건물 밑단 돌 띠 높이. 벽과 같은 평면이라 턱이 생기지 않는다
const DOOR_TOP = 3.2;    // 문 윗변. 뛰어도 머리가 닿지 않아 버니합이 끊기지 않는다
const LID_TOP = 11.6;    // 지붕 막이 윗면. 물탱크 위에서 뛰어도 닿지 않는 높이
const RUN_Y = 5;         // 지붕길 높이
const TANK_TOP = 9.9;    // 물탱크 윗면

const FACE = { '+x': Math.PI / 2, '-x': -Math.PI / 2, '+z': 0, '-z': Math.PI };
const out = (dir) => (dir[0] === '+' ? 1 : -1);

/* ---------------- 도형 도우미 ---------------- */

const rect = (x0, z0, x1, z1, y0, y1, mat) => box((x0 + x1) / 2, y0, (z0 + z1) / 2, x1 - x0, y1 - y0, z1 - z0, mat);
const mass = (x0, z0, x1, z1, top, mat, base = 'stone') => [rect(x0, z0, x1, z1, 0, PLINTH, base), rect(x0, z0, x1, z1, PLINTH, top, mat)];
const lid = (x0, z0, x1, z1, y0) => rect(x0, z0, x1, z1, y0, LID_TOP, 'clip');
const crate = (x0, z0, x1, z1, top = 1.15, y0 = 0) => rect(x0, z0, x1, z1, y0, top, 'wood');

/** x 방향 용마루 박공지붕 + 처마까지 덮는 막이 */
function gableX(x0, z0, x1, z1, y, rise, over = 0.3) {
  const zm = (z0 + z1) / 2, x = (x0 + x1) / 2, w = x1 - x0 + over * 2;
  return [
    ramp(x, y, (z0 - over + zm) / 2, w, rise, zm - z0 + over, '+z', 'tile'),
    ramp(x, y, (zm + z1 + over) / 2, w, rise, z1 + over - zm, '-z', 'tile'),
    lid(x0 - over, z0 - over, x1 + over, z1 + over, y)
  ];
}

/** z 방향 용마루 박공지붕 + 처마까지 덮는 막이 */
function gableZ(x0, z0, x1, z1, y, rise, over = 0.3) {
  const xm = (x0 + x1) / 2, z = (z0 + z1) / 2, d = z1 - z0 + over * 2;
  return [
    ramp((x0 - over + xm) / 2, y, z, xm - x0 + over, rise, d, '+x', 'tile'),
    ramp((xm + x1 + over) / 2, y, z, x1 + over - xm, rise, d, '-x', 'tile'),
    lid(x0 - over, z0 - over, x1 + over, z1 + over, y)
  ];
}

/** 벽면(dir 쪽을 보는 면, 좌표 fixed)에 붙은 얇은 판. c = 벽 방향 중심, hw = 반폭, d = 돌출 */
function onWall(dir, fixed, c, hw, d, y0, y1, mat) {
  const a = Math.min(fixed, fixed + out(dir) * d), b = Math.max(fixed, fixed + out(dir) * d);
  return dir[1] === 'x' ? rect(a, c - hw, b, c + hw, y0, y1, mat) : rect(c - hw, a, c + hw, b, y0, y1, mat);
}

/** 불 켜진 창(틀 + 창호). 아랫변이 3.1 m 위라 벽에 붙어 뛰어도 머리가 걸리지 않는다 */
const lit = (dir, fixed, c, y = 3.3, w = 1.1, h = 1.4) => [
  onWall(dir, fixed, c, w / 2 + 0.1, 0.05, y - 0.1, y + h + 0.1, 'wood_dark'),
  onWall(dir, fixed, c, w / 2, 0.08, y, y + h, 'paper')
];

/** 닫힌 문. 상자 위에서 뛰어도 윗변에 올라서지 못하는 높이다 */
const door = (dir, fixed, c, w = 1.2, h = 2.7) => onWall(dir, fixed, c, w / 2, 0.05, 0, h, 'wood_dark');

/** 문 위 차양. 뛰어도 머리가 닿지 않는 높이다 */
function awning(dir, fixed, c, w = 1.8, deep = 1.1) {
  const y = 3.35, rise = 0.32, mid = fixed + (out(dir) * deep) / 2, opposite = (dir[0] === '+' ? '-' : '+') + dir[1];
  return dir[1] === 'x'
    ? ramp(mid, y, c, deep, rise, w, opposite, 'rust')
    : ramp(c, y, mid, w, rise, deep, opposite, 'rust');
}

/* ---------------- 장식 도우미 ---------------- */

/** 벽면 앞 off만큼 떨어진 자리와 그 벽이 보는 방향 */
const on = (dir, fixed, c, y, off = 0.03) => (dir[1] === 'x'
  ? { x: fixed + out(dir) * off, y, z: c, rotY: FACE[dir] }
  : { x: c, y, z: fixed + out(dir) * off, rotY: FACE[dir] });

const sign = (dir, fixed, c, y, w, h, text) => ({ type: 'sign', ...on(dir, fixed, c, y, 0.05), w, h, text, bg: '#2b1f16', fg: '#f3dcae' });
const shutter = (dir, fixed, c, w = 2.6, h = 2.7) => ({ type: 'vent', ...on(dir, fixed, c, h / 2, 0.005), w, h, d: 0.12, mat: 'metal_dark' });
const wallVent = (dir, fixed, c, y, w = 1, h = 0.6) => ({ type: 'vent', ...on(dir, fixed, c, y, 0.005), w, h, d: 0.14 });
const cloth = (dir, fixed, c, y, text, bg = '#31475f', fg = '#f2e6cf', w = 1.5, h = 0.8) => ({ type: 'banner', ...on(dir, fixed, c, y, 0.14), w, h, text, bg, fg });

/** 빗물 홈통 */
function drain(dir, fixed, c, top) {
  const a = on(dir, fixed, c, top, 0.08), b = on(dir, fixed, c, 0.1, 0.08);
  return { type: 'pipe', from: [a.x, a.y, a.z], to: [b.x, b.y, b.z], r: 0.055, mat: 'metal_dark' };
}

/** 젖은 빗물 도랑. 바닥을 도려내면 슬래브가 띠로 갈라져 이음매가 보이므로 납작한 장식으로 깐다 */
const gutter = (x0, z0, x1, z1) => ({ type: 'pipe', from: [x0, -0.23, z0], to: [x1, -0.23, z1], r: 0.25, mat: 'metal_dark' });

/** 벽에 내민 팔걸이 등 */
function wallLantern(dir, fixed, c, y) {
  const a = on(dir, fixed, c, y + 0.55, 0), b = on(dir, fixed, c, y + 0.55, 0.5), l = on(dir, fixed, c, y, 0.5);
  return [
    { type: 'pipe', from: [a.x, a.y, a.z], to: [b.x, b.y, b.z], r: 0.02, mat: 'metal_dark' },
    { type: 'lantern', x: l.x, y, z: l.z, r: 0.2, cord: 0.31 }
  ];
}

/** 줄에 매단 등. 줄 하나 + 등 n개 */
function lanternLine(from, to, sag, n, opt = {}) {
  const r = opt.r ?? 0.24, cord = opt.cord ?? 0.25, color = opt.color ?? '#ffb35c';
  const at = (f) => from[1] + (to[1] - from[1]) * f - 4 * sag * f * (1 - f);
  const list = [{ type: 'rope', from, to, sag }];
  for (let i = 0; i < n; i++) {
    const f = (i + 0.5) / n;
    list.push({ type: 'lantern', x: from[0] + (to[0] - from[0]) * f, y: at(f) - cord - r * 1.18, z: from[2] + (to[2] - from[2]) * f, r, cord, color });
  }
  return list;
}

/** 양쪽 벽 사이 빨랫줄. 천은 머리 위에 걸린다 */
function laundry([x0, z0], [x1, z1], y, tones) {
  const list = [{ type: 'rope', from: [x0, y, z0], to: [x1, y, z1], sag: 0.08 }];
  tones.forEach((bg, i) => {
    const f = (i + 0.5) / tones.length;
    list.push({ type: 'banner', x: x0 + (x1 - x0) * f, y: y - 0.58, z: z0 + (z1 - z0) * f, rotY: x0 === x1 ? FACE['+x'] : FACE['+z'], w: 0.8, h: 1.05, text: ' ', bg, fg: bg });
  });
  return list;
}

/* ---------------- 서쪽 절반: 건물 ---------------- */

const buildings = [
  // 지붕길이 올라앉은 북쪽 창고. 윗면 슬래브가 걷는 바닥이다
  mass(-20, -18, -2, -14, RUN_Y - 0.12, 'brick'),
  rect(-20, -18, -2, -13.82, RUN_Y - 0.12, RUN_Y, 'concrete'),
  // 중앙채: 북쪽 입구와 동쪽 골목 사이의 좁고 높은 집
  mass(-2, -18, 2, -5, 8, 'plaster'),
  gableZ(-2, -18, 2, -5, 8, 1.4),
  // 북 골목과 가운데 골목 사이 벽돌 창고. 가운데로 연결 통로가 뚫려 있다
  mass(-20, -10, -14.2, -5, 7, 'brick'),
  mass(-11.8, -10, -6, -5, 7, 'brick'),
  rect(-14.2, -10, -11.8, -5, DOOR_TOP, 7, 'brick'),
  gableX(-20, -10, -6, -5, 7, 1.5),
  // 광장 서쪽 별채
  mass(-9, -5, -6, -2, 5.6, 'plaster'),
  ramp(-7.5, 5.6, -3.4, 3.5, 1.3, 3.2, '-z', 'tile'),
  lid(-9.25, -5, -5.75, -1.8, 5.6),
  // 가운데 골목과 남 골목 사이 민가
  mass(-20, -1, -12, 5, 6.2, 'plaster'),
  gableX(-20, -1, -12, 5, 6.2, 1.6),
  mass(-12, 2, -6, 5, 6.2, 'plaster'),
  gableX(-12, 2, -6, 5, 6.2, 0.9),
  // 세로 골목과 뒷마당 사이 담, 살림채(문이 뚫린 부분은 윗부분만)
  mass(-11, 5, -9.5, 10, 6, 'brick'),
  rect(-11.2, 5, -9.3, 10, 6, 6.15, 'concrete'),
  mass(-11, 10, -8.6, 13, 6, 'plaster'),
  rect(-8.6, 10, -6.4, 13, DOOR_TOP, 6, 'plaster'),
  rect(-8.6, 10, -6.4, 13, DOOR_TOP - 0.06, DOOR_TOP, 'wood_dark'),
  mass(-6.4, 10, -2, 18, 6, 'plaster'),
  gableX(-11, 10, -6.4, 13, 6, 1),
  gableX(-6.4, 10, -2, 18, 6, 1.2),
  lid(-11.2, 5, -9.3, 10, 6),
  // 남서쪽 큰 벽돌 창고
  mass(-20, 9, -15, 18, 9, 'brick'),
  mass(-28, 10, -20, 18, 9, 'brick'),
  rect(-28.2, 9.8, -14.8, 18.2, 9, 9.2, 'concrete')
].flat();

/* ---------------- 서쪽 절반: 야적장 ---------------- */

const yard = [
  // 바깥 담
  rect(-28, -18, -27.6, 10, 0, 7, 'brick'),
  rect(-27.6, -18, -20, -17.6, 0, 7, 'brick'),
  rect(-28, -18, -27.45, 10, 7, 7.15, 'concrete'),
  rect(-27.45, -18, -20, -17.45, 7, 7.15, 'concrete'),
  lit('+x', -27.6, -5.5, 3.6), lit('+x', -27.6, 1, 3.6),
  // 골목으로 나가는 문 3개. 지붕길에서 북문 위로 내려서지 못하게 막이를 올린다
  doorwayWall(-20, -14, -20, -10, 4.4, 0.5, 'brick', { at: -12, w: 2.6, top: DOOR_TOP }),
  doorwayWall(-20, -5, -20, -1, 4.4, 0.5, 'brick', { at: -3, w: 2.6, top: DOOR_TOP }),
  doorwayWall(-20, 5, -20, 9, 4.4, 0.5, 'brick', { at: 7, w: 2.6, top: DOOR_TOP }),
  rect(-20.25, -14, -19.75, -10, 4.4, 8, 'clip'),
  // 가운데 문 앞 막이벽: 스폰이 골목에서 곧장 보이지 않게 한다
  rect(-23.2, -5.6, -22.6, -0.4, 0, 2.6, 'brick'),
  rect(-23.3, -5.7, -22.5, -0.3, 2.6, 2.75, 'concrete'),
  // 상자 더미: 북문·남문 안쪽 시선도 끊는다
  crate(-22, -10.6, -20.25, -8.2),
  crate(-21.7, -10.4, -20.45, -9.2, 2.1, 1.15),
  crate(-22, 4.7, -20.6, 6.2),
  crate(-21.9, 4.9, -20.75, 6, 2.1, 1.15),
  crate(-27.6, -13.2, -26.5, -12.1),
  // 남서쪽 하역 차양과 그 밑 상자
  rect(-24.75, 6.3, -24.5, 6.55, 0, 3.1, 'wood_dark'),
  rect(-24.75, 9.45, -24.5, 9.7, 0, 3.1, 'wood_dark'),
  ramp(-26, 3.05, 8.1, 3.6, 0.7, 3.9, '-x', 'rust'),
  crate(-27.6, 8.4, -25.8, 10, 1.2),
  rect(-27.6, 7, -26.4, 8.2, 0, 1.2, 'wood_dark'),
  crate(-25.7, 8.3, -24.85, 9.15, 0.85)
].flat();

/* ---------------- 서쪽 절반: 골목 엄폐물과 문 ---------------- */

const SEA_WALL = rect(-15, 17.4, -6.4, 18, 0, 1, 'stone');

const lanes = [
  // 북 골목 (z -14~-10): 긴 직선, 동쪽 끝에 나무 문
  crate(-18.2, -14, -17, -12.9),
  rect(-13.6, -14, -12.2, -13.1, 0, 1, 'stone'),
  doorwayWall(-8, -14, -8, -10, 3.9, 0.4, 'wood_dark', { at: -12, w: 2.6, top: DOOR_TOP }),
  cyl(-9.6, 0, -13.4, 0.42, 1.05, 'rust'),
  cyl(-10.4, 0, -13.5, 0.42, 1.05, 'rust'),
  // 북쪽 입구 (x -6~-2)
  crate(-3.1, -8, -2, -6.9, 1.1),
  crate(-6, -13.9, -4.9, -12.8),
  // 가운데 골목 (z -5~-1)
  rect(-17, -1.9, -15.6, -1, 0, 1.05, 'stone'),
  crate(-12.9, -5, -11.8, -4),
  // 꺾임 (x -12~-9)
  crate(-10.1, -5, -9, -3.9, 1.2),
  crate(-12, 0.9, -10.9, 2, 1.2),
  // 광장 쪽 문틀 (폭 3 m)
  rect(-6.4, -2, -6, -1.5, 0, 3.7, 'stone'),
  rect(-6.4, 1.5, -6, 2, 0, 3.7, 'stone'),
  rect(-6.4, -1.5, -6, 1.5, DOOR_TOP, 3.7, 'wood_dark'),
  // 남 골목 (z 5~9), 세로 골목 (x -15~-11)
  crate(-17.6, 5, -16.4, 6, 1.1),
  rect(-12, 7, -11, 8.4, 0, 1.05, 'stone'),
  crate(-15, 11, -14, 12.2),
  // 부둣가 (z 13~17.4): 낮은 안벽 너머로 바다가 보인다
  SEA_WALL,
  clipAbove(SEA_WALL, 8),
  crate(-13.4, 16.3, -12.2, 17.4),
  cyl(-7.3, 0, 16.7, 0.42, 1.05, 'rust'),
  cyl(-9.6, 1, 17.7, 0.12, 0.3, 'steel'),
  cyl(-12.8, 1, 17.7, 0.12, 0.3, 'steel'),
  // 뒷마당 (x -9.5~-2, z 5~10)
  crate(-9.5, 7.6, -8.4, 8.8, 1.1),
  rect(-3.2, 8.9, -2, 10, 0, 1.1, 'stone'),
  // 광장 안
  crate(-5.1, 2.3, -3.9, 3.5),
  crate(-1.9, -5, -0.7, -3.9, 1.1)
].flat();

/* ---------------- 서쪽 절반: 지붕길 ---------------- */

const ROOF_PARAPET = rect(-20, -18, -2, -17.6, RUN_Y, RUN_Y + 0.9, 'brick');

const roof = [
  // 바다 쪽 난간 + 막이, 골목 쪽 낮은 턱(비운 곳으로 뛰어내릴 수 있다)
  ROOF_PARAPET,
  clipAbove(ROOF_PARAPET, 6),
  rect(-16, -14.2, -7.5, -13.85, RUN_Y, RUN_Y + 0.6, 'brick'),
  rect(-5, -14.2, -2, -13.85, RUN_Y, RUN_Y + 0.6, 'brick'),
  // 굴뚝, 환기함, 상자: 지붕 위 엄폐물
  rect(-12.6, -17.6, -11.7, -16.7, RUN_Y, RUN_Y + 2.2, 'brick'),
  rect(-12.75, -17.6, -11.55, -16.55, RUN_Y + 2.2, RUN_Y + 2.35, 'concrete'),
  rect(-18.2, -17.6, -17.4, -16.85, RUN_Y, RUN_Y + 1.7, 'brick'),
  rect(-18.32, -17.6, -17.28, -16.75, RUN_Y + 1.7, RUN_Y + 1.82, 'concrete'),
  rect(-10.6, -15.1, -9.5, -14.2, RUN_Y, RUN_Y + 1, 'steel'),
  crate(-5.4, -17.6, -4.2, -16.5, RUN_Y + 1.15, RUN_Y),
  crate(-3.5, -17.6, -2.6, -16.7, RUN_Y + 0.9, RUN_Y)
].flat();

/* ---------------- 서쪽 절반: 물탱크 다리 ---------------- */

const towerHalf = [
  rect(-3.28, -2.88, -2.92, -2.52, 0, 7.2, 'wood_dark'),
  rect(-3.28, 2.52, -2.92, 2.88, 0, 7.2, 'wood_dark'),
  rect(-3.4, -3, 3.4, -2.4, 7.2, 7.5, 'wood_dark'),
  rect(-3.4, -2.4, -2.8, 2.4, 7.2, 7.5, 'wood_dark')
];

/* ---------------- 서쪽 절반: 창과 문 ---------------- */

const facades = [
  // 북 골목
  lit('+z', -14, -11, 3.2),
  lit('-z', -10, -17, 3.6), lit('-z', -10, -8.9, 3.6),
  // 가운데 골목과 꺾임
  lit('+z', -5, -17, 3.6), lit('-z', -1, -14.5),
  door('-z', -1, -13.2), awning('-z', -1, -13.2),
  lit('-x', -9, -3.5), lit('-z', 2, -8), lit('+z', -2, -7.5),
  // 광장 벽과 북쪽 입구
  lit('+x', -6, -3.5, 3.75), door('+x', -6, -3.5, 1.3), awning('+x', -6, -3.5, 2.2),
  lit('+x', -6, 3.5),
  lit('+z', -5, 0, 3.75), lit('+z', -5, 0, 5.8), door('+z', -5, 0.8), awning('+z', -5, 0.8, 2),
  lit('+x', -6, -7.5, 3.6), lit('+x', 2, -7.5, 3.6),
  // 남 골목, 세로 골목, 부둣가
  lit('-z', 9, -17.5, 4),
  lit('+z', 5, -13), lit('-x', -11, 7.6), door('-x', -11, 11.5),
  lit('+x', -15, 13, 4),
  lit('+z', 13, -9.8), lit('-x', -6.4, 15.4),
  // 뒷마당
  lit('+z', 5, -8), lit('-z', 10, -4.2, 3.75), door('-z', 10, -4.2), awning('-z', 10, -4.2)
].flat();

/* ---------------- 물탱크 (원점에 하나, 돌리지 않는다) ---------------- */

const tower = [
  cyl(0, 0, 0, 1.35, 0.9, 'stone'),
  cyl(0, 0.9, 0, 1.05, 0.02, 'water'),
  cyl(0, 0.92, 0, 0.36, 6.6, 'rust'),
  cyl(0, 2.6, 0, 0.41, 0.14, 'metal_dark'),
  cyl(0, 5, 0, 0.41, 0.14, 'metal_dark'),
  cyl(0, 7.5, 0, 3, 2.25, 'wood'),
  cyl(0, 8, 0, 3.04, 0.12, 'metal_dark'),
  cyl(0, 8.9, 0, 3.04, 0.12, 'metal_dark'),
  cyl(0, 9.7, 0, 3.12, 0.12, 'metal_dark'),
  cyl(0, 9.82, 0, 3.02, 0.08, 'wood')
];

/* ---------------- 맵 밖 경치: 부둣가 앞 고깃배와 먼 방파제 ---------------- */

const scenery = [
  rect(-15, 19.4, -8, 22.6, -0.8, 1.1, 'wood_dark'),
  ramp(-6.8, -0.8, 21, 2.4, 1.9, 3.2, '-x', 'wood_dark'),
  rect(-13.6, 20, -11, 22, 1.1, 2.7, 'plaster'),
  rect(-13.8, 19.8, -10.8, 22.2, 2.7, 2.85, 'wood_dark'),
  rect(-13.1, 19.94, -11.5, 20, 1.6, 2.3, 'paper'),
  rect(-42, 44, -6, 47, -0.8, 0.8, 'stone'),
  cyl(-7.5, 0.8, 45.5, 1.1, 7, 'white'),
  cyl(-7.5, 5.4, 45.5, 1.12, 1, 'container_red'),
  cyl(-7.5, 7.8, 45.5, 1.25, 0.2, 'metal_dark')
];

const half = [...buildings, ...yard, ...lanes, ...roof, ...towerHalf, ...facades, ...scenery];

/* ---------------- 장식 ---------------- */

const LINEN = ['#d8c8aa', '#a8755c', '#8aa2b6'];

const decorHalf = [
  gutter(-19.7, -12, -8.2, -12), gutter(-19.7, -3, -12.6, -3), gutter(-19.7, 7, -15, 7), gutter(-15, 13.5, -8.6, 13.5),
  // 북 골목
  lanternLine([-17, 4.4, -14], [-17, 4.4, -10], 0.25, 1),
  laundry([-14.6, -14], [-14.6, -10], 4.3, LINEN),
  lanternLine([-11, 4.4, -14], [-11, 4.4, -10], 0.25, 1),
  lanternLine([-4, 4.4, -14], [-2, 4.4, -11], 0.2, 1),
  lanternLine([-6, 4.5, -8], [-2, 4.5, -8], 0.25, 1),
  shutter('+z', -14, -15.6), shutter('-z', -10, -16.8),
  wallVent('-z', -10, -13, 4.6), wallVent('+z', -14, -7.4, 3.7, 0.8, 0.5),
  drain('+z', -14, -9, 4.85), drain('-z', -10, -14.6, 6.9),
  // 연결 통로
  { type: 'light', x: -13, y: 2.72, z: -7.5, color: '#ffc27a', intensity: 0.8, dist: 9 },
  { type: 'lantern', x: -13, y: 2.72, z: -7.5, r: 0.24, cord: 0.2 },
  // 가운데 골목과 꺾임
  lanternLine([-15.5, 4.4, -5], [-15.5, 4.4, -1], 0.25, 1),
  lanternLine([-10.5, 4.6, -5], [-10.5, 4.6, 2], 0.4, 2),
  lanternLine([-7.5, 4.5, -2], [-7.5, 4.5, 2], 0.25, 1),
  laundry([-18.2, -5], [-18.2, -1], 4.2, ['#a8755c', '#d8c8aa']),
  wallVent('+z', -5, -13.8, 4.4), drain('-z', -1, -19, 6.1),
  cloth('-z', -1, -13.2, 2.9, '뱃사람 국밥'),
  wallLantern('-z', -1, -12.3, 2.5),
  // 광장
  lanternLine([-3.1, 6.6, -2.7], [-6, 5.3, -5], 0.3, 2),
  lanternLine([-3.1, 6.6, 2.7], [-6, 5.3, 5], 0.3, 2),
  { type: 'lantern', x: -1.7, y: 6.55, z: -2.7, r: 0.22, cord: 0.35 },
  { type: 'lantern', x: 1.7, y: 6.55, z: -2.7, r: 0.22, cord: 0.35 },
  { type: 'lantern', x: -3.1, y: 6.55, z: 0, r: 0.22, cord: 0.35 },
  { type: 'pipe', from: [-3.1, 4.4, -2.7], to: [3.1, 4.4, -2.7], r: 0.05, mat: 'wood_dark' },
  { type: 'pipe', from: [-3.1, 4.4, -2.7], to: [-3.1, 4.4, 2.7], r: 0.05, mat: 'wood_dark' },
  { type: 'pipe', from: [-3.1, 4.4, -2.7], to: [-0.4, 7.2, -2.7], r: 0.04, mat: 'wood_dark' },
  { type: 'pipe', from: [-3.1, 4.4, -2.7], to: [-3.1, 7.2, -0.4], r: 0.04, mat: 'wood_dark' },
  shutter('+x', -6, 3.5, 2.2, 2.4),
  drain('+x', -6, -5.4, 6.8),
  wallLantern('+z', -5, -1.3, 2.6),
  // 남 골목과 세로 골목
  lanternLine([-17.5, 4.2, 5], [-17.5, 4.2, 9], 0.25, 1),
  lanternLine([-15, 4.6, 10], [-11, 4.6, 10], 0.25, 1),
  laundry([-15, 12], [-11, 12], 4.4, LINEN),
  shutter('-z', 9, -17.6), drain('+x', -15, 9.6, 8.9),
  wallVent('+x', -15, 11.3, 5.6), wallVent('-x', -11, 12.2, 4.4, 0.8, 0.5),
  // 부둣가와 뒷마당
  lanternLine([-15, 4.6, 15], [-6.4, 4.2, 15], 0.5, 3),
  lanternLine([-9.5, 4.4, 7.5], [-2, 4.4, 7.5], 0.4, 2),
  drain('+z', 13, -8.9, 5.9),
  { type: 'rope', from: [-9.6, 1.25, 17.7], to: [-9.4, 1.0, 19.5], sag: 0.25, r: 0.03 },
  { type: 'rope', from: [-12.8, 1.25, 17.7], to: [-14, 1.0, 19.5], sag: 0.25, r: 0.03 },
  // 야적장
  lanternLine([-27.6, 5, -8.4], [-20, 5, -8.4], 0.35, 2),
  lanternLine([-27.6, 5, 3], [-20, 5, 3], 0.35, 2),
  wallVent('+x', -27.6, -9, 5.4, 1.2, 0.7), drain('+x', -27.6, -14.6, 6.9), drain('+x', -27.6, 4.4, 6.9),
  // 고깃배
  { type: 'pipe', from: [-9.6, 1.1, 21], to: [-9.6, 7, 21], r: 0.07, mat: 'wood_dark' },
  { type: 'rope', from: [-9.6, 6.8, 21], to: [-6, 1.1, 21], sag: 0.05, r: 0.018 },
  { type: 'rope', from: [-9.6, 6.8, 21], to: [-14.6, 1.1, 21], sag: 0.05, r: 0.018 },
  { type: 'lantern', x: -9.6, y: 6.1, z: 20.8, r: 0.18, cord: 0.2 },
  { type: 'crateStack', x: -8.9, y: 1.1, z: 21, size: 0.7, levels: 1, rotY: 0.2 },
  { type: 'buoy', x: -19, z: 25, r: 0.5 }, { type: 'buoy', x: -3, z: 27, r: 0.5 }, { type: 'buoy', x: -26, z: 33, r: 0.6 },
  { type: 'lantern', x: -7.5, y: 8.6, z: 45.5, r: 0.5, cord: 0, color: '#fff0c0' },
  // 지붕길
  { type: 'vent', x: -10.05, y: 5.5, z: -15.12, rotY: FACE['-z'], w: 0.9, h: 0.7, d: 0.1 },
  { type: 'rope', from: [-12.15, 7, -16.7], to: [-5, 5.9, -17.6], sag: 0.35 }
].flat();

/** 절반마다 글자가 다른 표지. 동쪽은 돌려서 쓴다 */
const labelled = ({ warehouse, big, shop, office, fish }) => [
  sign('+z', -14, -15.6, 3.2, 2.2, 0.55, warehouse),
  sign('-z', 9, -17.6, 3.2, 2.2, 0.55, big),
  sign('+x', -6, -3.5, 3.05, 1.9, 0.5, shop),
  sign('+z', -5, 0.8, 3.05, 2.2, 0.5, office),
  sign('-x', -6.4, 15.4, 2.7, 2.2, 0.5, fish)
];

/** 팀 색 깃발과 문 위 골목 이름. 스폰에서 바로 보이는 벽에 건다 */
const teamDecor = (team, gates) => [
  { type: 'banner', x: -20.12, y: 4.4, z: -7.2, rotY: FACE['-x'], w: 1.5, h: 3.2, text: team.name, emblem: 'ring', bg: team.color, fg: '#f4f1e8' },
  { type: 'banner', x: -20.12, y: 4.4, z: 2.6, rotY: FACE['-x'], w: 1.5, h: 3.2, text: team.name, emblem: 'ring', bg: team.color, fg: '#f4f1e8' },
  { type: 'banner', x: -20.4, y: 3.72, z: -12, rotY: FACE['-x'], w: 2, h: 0.62, text: gates[0], bg: team.color, fg: '#f4f1e8' },
  { type: 'banner', x: -20.4, y: 3.72, z: -3, rotY: FACE['-x'], w: 2, h: 0.62, text: gates[1], bg: team.color, fg: '#f4f1e8' },
  { type: 'banner', x: -20.4, y: 3.72, z: 7, rotY: FACE['-x'], w: 2, h: 0.62, text: gates[2], bg: team.color, fg: '#f4f1e8' }
];

const decorCenter = [
  { type: 'light', x: 0, y: 6.4, z: 0, color: '#ffc27a', intensity: 1.4, dist: 15 },
  { type: 'pipe', from: [0, TANK_TOP, 0], to: [0, TANK_TOP + 3.2, 0], r: 0.05, mat: 'wood_dark' },
  { type: 'banner', x: 0.75, y: TANK_TOP + 2.7, z: 0, rotY: 0, w: 1.4, h: 0.9, text: ' ', emblem: 'ring', bg: '#7a2f28', fg: '#f4e3c0' },
  // 물탱크 위 밧줄 울타리와 등 (장식)
  ...[[-1, -1], [1, -1], [1, 1], [-1, 1]].flatMap(([sx, sz], i, all) => {
    const x = sx * 1.95, z = sz * 1.95, top = TANK_TOP + 1, next = all[(i + 1) % 4];
    return [
      { type: 'pipe', from: [x, TANK_TOP, z], to: [x, top, z], r: 0.04, mat: 'wood_dark' },
      { type: 'rope', from: [x, top - 0.1, z], to: [next[0] * 1.95, top - 0.1, next[1] * 1.95], sag: 0.12 },
      { type: 'lantern', x, y: top + 0.28, z, r: 0.16, cord: 0.08 }
    ];
  })
];

/* ---------------- 스폰 ---------------- */

/** 카메라가 (x,z)에서 (tx,tz)를 보는 rotY */
const look = (x, z, tx, tz) => Math.atan2(-(tx - x), -(tz - z));
const spot = (x, z, tx, tz) => ({ x, z, rotY: look(x, z, tx, tz) });

const blue = [
  spot(-26, -8.2, -20, -12),
  spot(-25.2, 1.2, -20, 7),
  spot(-24.8, -6.2, -20, -12),
  spot(-26.2, 4.4, -20, 7),
  spot(-26.4, -3, -21.5, -7)
];
const ffaHalf = [
  spot(-17.5, -11.2, -8, -12),
  spot(-16.2, -4.2, -9, -3),
  spot(-13, 10.5, -13, 16),
  spot(-8, 15.6, -13, 15)
];

/* ---------------- 발판과 소품 ---------------- */

const padsHalf = [
  // 야적장 북쪽 끝 → 지붕길 서쪽
  { x: -24, y: 0, z: -15.6, w: 2.4, d: 2.4, target: [-15.5, RUN_Y, -15.9], apex: 2.6 },
  // 지붕길 → 물탱크 위 (비밀 스팟)
  { x: -8.6, y: RUN_Y, z: -16.6, w: 1.8, d: 1.8, target: [0, TANK_TOP, 0], apex: 3.8, color: '#ff4d8d' }
];

const propsHalf = [
  { type: 'crate', x: -3.6, y: 0, z: -3.9 },
  { type: 'barrel', x: -5.2, y: 0, z: 4.2 },
  { type: 'crate', x: -24.4, y: 0, z: 5.2, size: 1 },
  { type: 'barrel', x: -21.2, y: 0, z: -6.2 }
];

export default {
  id: 'alley',
  name: '항구 골목',
  nameEn: 'Harbor Alley',
  desc: '해 질 녘 항구 뒷골목. 좁은 골목 셋이 우물 광장으로 모이는 근접전 맵. 지붕길로 오르면 물탱크가 보인다.',
  tag: '근접전',
  size: { x: 56, z: 36 },
  rulesets: ['classic', 'knife'],
  theme: {
    sky: '#f2a872', skyTop: '#3c4a80', fog: [22, 95], sunDir: [0.25, 0.42, -0.87],
    sunColor: '#ffc296', ambient: 0.58, water: '#26333f', waterLevel: -0.8, ground: 'stone'
  },
  spawns: {
    owner: blue,
    charterer: rotate180(blue),
    ffa: [...ffaHalf, ...rotate180(ffaHalf)]
  },
  solids: [...half, ...rotate180(half), ...tower],
  decor: [
    ...decorCenter,
    ...decorHalf,
    ...rotate180(decorHalf),
    ...labelled({ warehouse: '3번 창고', big: '1번 창고', shop: '선구점', office: '항구 사무소', fish: '수산물 창고' }),
    ...rotate180(labelled({ warehouse: '4번 창고', big: '2번 창고', shop: '어망 수선', office: '물탱크 관리소', fish: '건어물 창고' })),
    ...teamDecor(TEAMS.owner, ['북 골목', '가운데 골목', '남 골목']),
    ...rotate180(teamDecor(TEAMS.charterer, ['남 골목', '가운데 골목', '북 골목']))
  ],
  pads: [...padsHalf, ...rotate180(padsHalf)],
  portals: [],
  secrets: [{ id: 'alley_watertower', name: '물탱크 옥상', x: 0, y: TANK_TOP, z: 0, w: 5.4, h: 2.5, d: 5.4, points: 100 }],
  props: [...propsHalf, ...rotate180(propsHalf)]
};
