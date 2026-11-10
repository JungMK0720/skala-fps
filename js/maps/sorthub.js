/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 택배 분류 센터(Parcel Hub). 야간 택배 분류장의 좁은 2층 맵으로, 양쪽 하역 도크 사이 랙 통로 셋과 2층 통로를 화물 승강기·셔터·무인 대차가 쉬지 않고 가로지른다.
 */
import { TEAMS } from '../core/consts.js';
import { box, stairs, doorwayWall, rotate180 } from './kit.js';

// 방위: 북 = -z, 남 = +z. 블루 = -x(서쪽 도크), 레드 = +x(동쪽 도크). 아래는 서쪽 절반이고 동쪽은 원점 기준 180° 돌린 복사본이다.
//
//          x -21      -16      -13  -11      -9   -6.5     -4    -1  0
//  z -15    ┌ 도크 ────┬ 통로 밑 ─────┬ 보관실(2층 북쪽 통로 밑) ──────┬ 통로 밑 ┐
//  z -12    │ 팰릿     │ 북문 로비 │틈│ 계단 → → → → → 계단참        │         │
//  z -10    │          │          │  └ 안전벽 ─┘   북쪽 통로         팰릿      │
//  z -6.6   │ 스폰     ├ 높은 랙 ─┴ 랙 A ──┬ 틈 ┬ 랙 B ──┬─ 틈 ─┬ 랙 ─────────┤
//  z -5     │          │ 셔터 칸  ╎        대차 길 → →  상자 더미          ┌───┤
//  z  0     │ 가림 랙  ═ 셔터     ╎ 유리   가운데 통로                     │분 │
//  z  3.2   │          │ 충전소 ──┘        투입대 ─ 컨베이어 ─┐ 상자 더미  │류 │
//  z  5     │ 스폰     ├ 높은 랙 ─┬ 랙(다리 밑까지 틈 없음) ───────────────┴기 ┤
//  z  6.6   │          │ 남문 로비 │틈│안전벽│ 승강기   상자 더미 · 발판  팰릿  │
//  z  12    │ 팰릿     │          └──┴ 반품 보관실(2층 남쪽 통로 밑) ─┬ 통로 밑 ┤
//  z  15    └──────────┴ 통로 밑 ─────┴────────────────────────────────┴─────────┘
//
//  2층(y 3): 북쪽 통로(z -15 ~ -12)와 남쪽 통로(z 12 ~ 15)를 가운데 다리(x ±1.2)가 잇는다. 서쪽 절반에서는 계단이 북쪽 통로로,
//  승강기와 발판이 남쪽 통로로 올라간다(동쪽 절반은 반대다).
//  도크 문 셋: 북문·남문은 늘 열려 있고 가림벽을 돌아 2층 통로 밑으로 나온다. 가운데 셔터는 14초에 4초만 다 열리는 지름길이다.
//  도크 안은 반대쪽 절반 어디에서도 쏠 수 없다. 북문·남문은 높은 랙과 가림벽이 ㄱ자로 감싸고, 셔터 앞은 유리 가림막(보이지만 총알은 막는다)이 가리고,
//  양쪽 셔터 사이는 분류기가 막는다. 랙·상자 더미·가림벽 위는 clip으로 덮어 2층이나 승강기에서 뛰어도 올라서지 못한다.
//  움직이는 지형(movers)은 승강기 둘, 셔터 둘, 대차 둘이다. 봇 길 찾기는 이들을 보지 않으므로 어느 것도 유일한 길이 아니다(2층은 계단으로도 오른다).

/* ---------------- 치수 ---------------- */

const WALL_H = 7;        // 바깥 벽과 도크 벽 높이
const PLINTH = 1;        // 바깥 벽 밑단 콘크리트 띠
const DOOR_TOP = 3.2;    // 늘 열린 도크 문 윗변. 뛰어도 머리가 닿지 않는다
const SHUT_TOP = 2.6;    // 셔터 문 윗변
const MEZ = 3;           // 2층 바닥 윗면
const UNDER = 2.7;       // 2층 바닥 밑면. 그 아래는 걸어서 지나간다
const RAIL = 1;          // 2층 난간 높이
const RACK = 2.6;        // 랙 높이
const TALL = 5;          // 도크 문 가림벽 높이. 2층 난간 위에서 뛰어도 넘겨다보지 못한다
const GLASS = 3.6;       // 셔터 앞 유리 가림막 높이
const BELT = 0.9;        // 컨베이어 윗면. 뛰어서 넘는다
const LID_TOP = 9;       // 막이 윗면
const EDGE = 0.03;       // 막이를 도형보다 이만큼 넓게 덮는다. 모서리 끝에 걸쳐 서는 것까지 막는다

const FACE = { '+x': Math.PI / 2, '-x': -Math.PI / 2, '+z': 0, '-z': Math.PI };
const out = (dir) => (dir[0] === '+' ? 1 : -1);

/* ---------------- 도형 도우미 ---------------- */

const rect = (x0, z0, x1, z1, y0, y1, mat) => box((x0 + x1) / 2, y0, (z0 + z1) / 2, x1 - x0, y1 - y0, z1 - z0, mat);
const lid = (x0, z0, x1, z1, y0) => rect(x0, z0, x1, z1, y0, LID_TOP, 'clip');
/** 도형 하나를 모서리까지 덮는 막이 */
const cap = (x0, z0, x1, z1, y0) => lid(x0 - EDGE, z0 - EDGE, x1 + EDGE, z1 + EDGE, y0);
/** 바닥에 칠한 노란 선. 얇아서 걸리지 않고 움직이는 지형 밑에 깔려도 된다 */
const mark = (x0, z0, x1, z1) => rect(x0, z0, x1, z1, 0, 0.02, 'yellow');

/**
 * 동서로 긴 택배 랙 한 줄. 칸마다 아래·위 상자 더미를 채우고 가운데 선반, 윗판, 칸 사이 기둥을 세운다.
 * 속이 차 있어 총알과 시야를 막는다. lidX1은 막이의 동쪽 끝이다(다리 밑 구간은 다리가 덮으므로 그 앞에서 끊는다).
 */
function rack(x0, z0, x1, z1, bays, flip = false, lidX1 = x1 + EDGE) {
  const list = [];
  const step = (x1 - x0) / bays;
  for (let i = 0; i < bays; i++) {
    const a = x0 + step * i + 0.08, b = x0 + step * (i + 1) - 0.08;
    const odd = (i % 2 === 1) !== flip;
    list.push(rect(a, z0 + 0.1, b, z1 - 0.1, 0, 1.25, odd ? 'sand' : 'wood'));
    list.push(rect(a, z0 + (odd ? 0.1 : 0.28), b, z1 - (odd ? 0.28 : 0.1), 1.35, RACK - 0.1, odd ? 'wood' : 'sand'));
  }
  list.push(rect(x0, z0, x1, z1, 1.25, 1.35, 'metal_dark'), rect(x0, z0, x1, z1, RACK - 0.1, RACK, 'metal_dark'));
  for (let i = 0; i <= bays; i++) {
    const x = x0 + step * i;
    list.push(rect(Math.max(x0, x - 0.08), z0, Math.min(x1, x + 0.08), z1, 0, RACK, 'metal_dark'));
  }
  list.push(lid(x0 - EDGE, z0 - EDGE, lidX1, z1 + EDGE, RACK));
  return list;
}

/** 두 단으로 쌓은 상자 더미. 높이는 랙과 같고 위에는 막이를 올린다 */
const stack = (x0, z0, x1, z1) => [
  rect(x0, z0, x1, z1, 0, 1.4, 'wood'),
  rect(x0 + 0.15, z0 + 0.15, x1 - 0.15, z1 - 0.15, 1.4, RACK, 'sand'),
  cap(x0, z0, x1, z1, RACK)
];

/** 컨베이어 한 토막: 강철 몸통 위에 녹슨 롤러 띠. alongX = 동서로 흐르는 토막 */
const belt = (x0, z0, x1, z1, alongX = true) => [
  rect(x0, z0, x1, z1, 0, BELT - 0.06, 'steel'),
  alongX ? rect(x0, z0 + 0.12, x1, z1 - 0.12, BELT - 0.06, BELT, 'rust') : rect(x0 + 0.12, z0, x1 - 0.12, z1, BELT - 0.06, BELT, 'rust')
];

/** 팰릿 위에 쌓은 상자. 뛰어서 올라설 수 있는 낮은 엄폐물이다. 팰릿과 상자의 옆면을 맞춰 발이 걸리는 턱을 두지 않는다 */
const pallet = (x0, z0, x1, z1, top = 1.15, y0 = 0) => [
  rect(x0, z0, x1, z1, y0, y0 + 0.14, 'wood_dark'),
  rect(x0, z0, x1, z1, y0 + 0.14, y0 + top, 'wood')
];

/* ---------------- 서쪽 절반: 바깥 벽과 도크 벽 ---------------- */

const shell = [
  // 서쪽 벽과 북쪽 벽(돌리면 동쪽 벽과 남쪽 벽). 콘크리트 밑단, 밝은 패널, 강판 윗단
  rect(-22, -15, -21, 15, 0, PLINTH, 'concrete'),
  rect(-22, -15, -21, 15, PLINTH, 4.4, 'plaster'),
  rect(-22, -15, -21, 15, 4.4, WALL_H, 'steel'),
  rect(-22, -16, 22, -15, 0, PLINTH, 'concrete'),
  rect(-22, -16, 22, -15, PLINTH, 4.4, 'plaster'),
  rect(-22, -16, 22, -15, 4.4, WALL_H, 'steel'),
  lid(-22, -15, -21, 15, WALL_H),
  lid(-22, -16, 22, -15, WALL_H)
];

const dockWall = [
  // 북문, 가운데 셔터 문, 남문. 셔터(두께 0.2)는 문 위 벽(두께 0.4, 높이 4.4) 속으로 올라간다
  doorwayWall(-16.2, -15, -16.2, -4, WALL_H, 0.4, 'tank', { at: -8.3, w: 2.6, top: DOOR_TOP }),
  doorwayWall(-16.2, -4, -16.2, 4, WALL_H, 0.4, 'tank', { at: 0, w: 2.4, top: SHUT_TOP }),
  doorwayWall(-16.2, 4, -16.2, 15, WALL_H, 0.4, 'tank', { at: 8.3, w: 2.6, top: DOOR_TOP }),
  // 셔터 문틀의 노란 띠(분류장 쪽)와 문 앞 바닥의 주의 띠
  rect(-16, -1.38, -15.95, -1.2, 0, SHUT_TOP, 'yellow'),
  rect(-16, 1.2, -15.95, 1.38, 0, SHUT_TOP, 'yellow'),
  rect(-16, -1.38, -15.95, 1.38, SHUT_TOP, SHUT_TOP + 0.18, 'yellow'),
  mark(-15.9, -1.05, -15.2, -0.75),
  mark(-15.9, -0.15, -15.2, 0.15),
  mark(-15.9, 0.75, -15.2, 1.05)
].flat();

/* ---------------- 서쪽 절반: 도크 문 가림벽과 셔터 앞 유리 ---------------- */

const screens = [
  // 북문 로비: 높은 랙과 가림벽이 ㄱ자로 막아 2층 통로 밑(북쪽)으로만 나간다
  rect(-16, -6.6, -13, -5, 0, TALL, 'tile'),
  rect(-13.4, -12, -13, -6.6, 0, TALL, 'tile'),
  cap(-16, -6.6, -13, -5, TALL),
  cap(-13.4, -12, -13, -6.6, TALL),
  // 남문 로비: 2층 통로 밑(남쪽)으로만 나간다
  rect(-16, 5, -13, 6.6, 0, TALL, 'tile'),
  rect(-13.4, 6.6, -13, 12, 0, TALL, 'tile'),
  cap(-16, 5, -13, 6.6, TALL),
  cap(-13.4, 6.6, -13, 12, TALL)
];

const bay = [
  // 셔터 앞 유리 가림막: 셔터는 보이지만 총알은 막는다. 북쪽 틈(z -5 ~ -3.2)으로 돌아 나간다
  rect(-14, -3.2, -13.8, 3.2, 0.2, GLASS - 0.15, 'glass'),
  rect(-14, -3.2, -13.8, 3.2, 0, 0.2, 'metal_dark'),
  rect(-14, -3.2, -13.8, 3.2, GLASS - 0.15, GLASS, 'metal_dark'),
  rect(-14.03, -3.2, -13.77, -3.05, 0.2, GLASS - 0.15, 'metal_dark'),
  rect(-14.03, -0.08, -13.77, 0.08, 0.2, GLASS - 0.15, 'metal_dark'),
  lid(-14 - EDGE, -3.2 - EDGE, -13.8 + EDGE, 3.2, GLASS),
  // 대차 충전소: 유리 가림막 남쪽 끝을 막는다
  rect(-16, 3.2, -13.8, 5, 0, GLASS, 'metal_dark'),
  lid(-16, 3.2, -13.8 + EDGE, 5, GLASS)
];

/* ---------------- 서쪽 절반: 랙 두 줄 ---------------- */

const racks = [
  // 북쪽 줄: 높은 랙 뒤로 A, 건너가는 틈(x -9 ~ -6.5), B, 다리 서쪽 틈(x -4 ~ -1). 그 동쪽은 남쪽 줄을 돌린 복사본이다
  rack(-13, -6.6, -9, -5, 2),
  rack(-6.5, -6.6, -4, -5, 2, true),
  // 남쪽 줄: 다리 밑을 지나 x 1까지 틈 없이 이어진다. 다리 밑 구간은 다리가 덮으니 막이를 다리 앞에서 끊는다
  rack(-13, 5, 1, 6.6, 5, false, -1.2),
  // 가운데 통로를 좁히는 상자 더미. 분류기와 엇갈려서 통로 끝에서 끝까지 뚫린 시야를 끊는다
  stack(-6.5, -5, -4, -3),
  stack(-6.5, 3, -4, 5)
].flat();

/* ---------------- 서쪽 절반: 북쪽 통로(계단) ---------------- */

const north = [
  // 2층 통로 밑 보관실. 통로 밑으로 길게 뚫린 시야를 막는다
  rect(-11, -15, -4, -12, 0, UNDER, 'plaster'),
  // 2층으로 오르는 계단(폭 2 m, 10단)과 계단참
  stairs(-8.5, 0, -11, 5, MEZ, 2, '+x', 'steel'),
  rect(-6, -12, -4, -10, 0, UNDER, 'plaster'),
  rect(-6, -12, -4, -10, UNDER, MEZ, 'deck'),
  rect(-4.2, -12, -4, -10, MEZ, MEZ + RAIL, 'steel'),
  rect(-6, -10.2, -4.2, -10, MEZ, MEZ + RAIL, 'steel'),
  // 계단 옆 안전벽: 낮은 단 너머로 로비 입구가 멀리서 보이지 않게 한다
  rect(-11, -10, -8, -9.7, 0, 2.2, 'steel'),
  // 다리 서쪽 틈 앞 팰릿
  pallet(-3.2, -9.6, -2, -8.4)
].flat();

/* ---------------- 서쪽 절반: 남쪽 통로(승강기와 발판) ---------------- */

const south = [
  // 2층 통로 밑 반품 보관실. 승강기 남쪽을 막는다
  rect(-11, 12, -4, 15, 0, UNDER, 'plaster'),
  // 승강기 서쪽 안전벽: 남문에서 나오는 길과 승강기를 가르고, 통로에서 로비 입구가 들여다보이지 않게 한다
  rect(-11, 9.4, -10.6, 12, 0, MEZ + RAIL, 'steel'),
  // 승강기 동쪽 노란 난간: 북쪽에서만 타게 해서, 승강기를 못 보는 봇의 길이 승강기 자리를 가로지르지 않는다
  rect(-8, 9.4, -7.88, 12, 0, 1.25, 'yellow'),
  // 승강기 자리 노란 테두리(서쪽은 안전벽, 남쪽은 보관실, 동쪽은 난간)와 타는 쪽 바닥의 주의 띠
  mark(-10.6, 9.28, -7.88, 9.4),
  mark(-10.3, 8.7, -9.9, 9.1),
  mark(-9.5, 8.7, -9.1, 9.1),
  mark(-8.7, 8.7, -8.3, 9.1),
  // 발판을 가리는 상자 더미와 발판 남쪽 팰릿
  stack(-6, 6.6, -4.6, 9.4),
  pallet(-3, 10.2, -1.8, 11.4, 1.1)
].flat();

/* ---------------- 서쪽 절반: 가운데 통로(컨베이어와 대차 길) ---------------- */

const aisle = [
  // 지그재그 컨베이어: 분류기에서 서쪽으로 가다 북쪽으로 한 번 꺾여 투입대에 닿는다
  belt(-7, 1.8, -0.8, 3),
  belt(-8.2, 0.7, -7, 3, false),
  belt(-10.6, 0.7, -8.2, 1.9),
  rect(-11.9, 0.7, -10.6, 1.9, 0, 2.6, 'metal_dark'),
  cap(-11.9, 0.7, -10.6, 1.9, 2.6),
  // 무인 대차 유도선과 양 끝 정지선. 대차 길(z -2.7 ~ -1.3)에는 다른 것을 두지 않는다
  mark(-11.9, -2.05, -2.1, -1.95),
  mark(-12, -2.7, -11.9, -1.3),
  mark(-2.1, -2.7, -2, -1.3)
].flat();

/* ---------------- 서쪽 절반: 도크 안 ---------------- */

const dock = [
  // 셔터 앞 가림 랙: 셔터가 열려도 유리 너머로 보이는 곳은 랙 앞 2 m뿐이고 도크 안쪽은 보이지 않는다
  rect(-19, -3.5, -18.4, 3.5, 0, 1.4, 'wood'),
  rect(-18.95, -3.4, -18.45, 3.4, 1.4, 2.7, 'sand'),
  rect(-19, -3.5, -18.4, 3.5, 2.7, 2.8, 'metal_dark'),
  cap(-19, -3.5, -18.4, 3.5, 2.8),
  // 팰릿 더미
  pallet(-17.8, -6.2, -16.6, -5),
  pallet(-20.8, -12.4, -19.6, -11.2),
  pallet(-17.8, -14.8, -16.6, -13.6, 1.1),
  pallet(-17.8, 5, -16.6, 6.2),
  pallet(-20.8, 11.2, -19.6, 12.4, 1.1),
  pallet(-18.2, 13.6, -17, 14.8),
  // 벽에 세워 둔 손수레
  rect(-20.95, 8.2, -20.87, 8.75, 0.1, 1.3, 'yellow'),
  rect(-20.95, 8.2, -20.55, 8.75, 0, 0.05, 'yellow'),
  // 걷는 길 표시선
  mark(-17.05, -14.6, -16.95, -10.2),
  mark(-17.05, 10.2, -16.95, 14.6)
].flat();

/* ---------------- 서쪽 절반: 통로 바닥 선 ---------------- */

const lines = [
  mark(-12.8, -7.05, -9.1, -6.95),
  mark(-6.4, -7.05, -4.1, -6.95),
  mark(-0.9, -7.05, 0, -6.95),
  mark(-12.8, 6.95, -6.1, 7.05),
  mark(-2.2, 6.95, 0, 7.05)
];

/* ---------------- 서쪽 절반: 2층 난간과 엄폐물 ---------------- */

const rails = [
  // 북쪽 통로: 계단참 앞과 다리 앞을 비운다
  rect(-16, -12.2, -6.6, -12, MEZ, MEZ + RAIL, 'steel'),
  rect(-4, -12.2, -1.2, -12, MEZ, MEZ + RAIL, 'steel'),
  // 남쪽 통로: 승강기 앞과 다리 앞을 비운다
  rect(-16, 12, -10.6, 12.2, MEZ, MEZ + RAIL, 'steel'),
  rect(-8, 12, -1.2, 12.2, MEZ, MEZ + RAIL, 'steel'),
  // 다리 서쪽 난간
  rect(-1.2, -12.2, -1, 12.2, MEZ, MEZ + RAIL, 'steel'),
  // 2층 통로 위 상자와 분전함
  pallet(-10.6, -13.1, -9.2, -12.2, 1.1, MEZ),
  rect(-3.2, -15, -2, -14.45, MEZ, MEZ + 1.4, 'metal_dark'),
  pallet(-6.4, 12.2, -5, 13.1, 1.1, MEZ),
  rect(-14.2, 14.45, -13, 15, MEZ, MEZ + 1.4, 'metal_dark')
].flat();

/* ---------------- 가운데(돌리지 않고 한 번만) ---------------- */

const center = [
  // 2층 통로 둘과 가운데 다리
  rect(-16, -15, 16, -12, UNDER, MEZ, 'deck'),
  rect(-16, 12, 16, 15, UNDER, MEZ, 'deck'),
  rect(-1.2, -12, 1.2, 12, UNDER, MEZ, 'deck'),
  // 자동 분류기: 다리를 받치고 양쪽 셔터 사이 시야를 끊는다. 컨베이어가 이 안에서 엇갈린다
  rect(-0.8, -3.2, 0.8, 3.2, 0, UNDER, 'metal_dark'),
  // 천창. 지붕은 덮지 않는다(트러스는 장식이다)
  rect(-15, -3.9, 15, -2.9, 7.4, 7.46, 'glass'),
  rect(-15, 2.9, 15, 3.9, 7.4, 7.46, 'glass')
];

const half = [...shell, ...dockWall, ...screens, ...bay, ...racks, ...north, ...south, ...aisle, ...dock, ...lines, ...rails];

/* ---------------- 움직이는 지형 ---------------- */

const moversWest = [
  // 화물 승강기: 바닥에 묻힌 기둥(높이 3.2)이 2.8 m 올라와 윗면이 2층 바닥과 나란해진다. 쉴 때 윗면은 0.2라 그냥 올라선다.
  // phase 0.9: 맵 시계 0초에 내려오는 중이고 1초에 바닥에 닿아 3초에 다시 올라간다
  { id: 'lift_w', x: -9.3, y: -3, z: 10.7, w: 2.6, h: 3.2, d: 2.6, mat: 'steel', axis: 'y', dist: 2.8, period: 10, hold: 2, phase: 0.9 },
  // 도크 셔터: 14초 가운데 4초 동안 다 열린다. phase 0.5: 맵 시계 0초에 다 열려 있다가 4초부터 닫힌다
  { id: 'shutter_w', x: -16.2, y: 0, z: 0, w: 0.2, h: SHUT_TOP, d: 2.4, mat: 'metal_dark', axis: 'y', dist: SHUT_TOP, period: 14, hold: 4, phase: 0.5 },
  // 무인 대차: 가운데 통로 북쪽 길을 7 m 오간다. 유리 가림막에서 2.2 m, 분류기에서 1.6 m 앞에 멈춘다
  { id: 'cart_w', x: -10.5, y: 0, z: -2, w: 2.2, h: 1.5, d: 1.4, mat: 'yellow', axis: 'x', dist: 7, period: 12, hold: 1 }
];

/* ---------------- 장식 도우미 ---------------- */

/** 벽면(dir 쪽을 보는 면, 좌표 fixed) 앞 off만큼 떨어진 자리와 그 벽이 보는 방향. c = 벽 방향 좌표 */
const on = (dir, fixed, c, y, off = 0.05) => (dir[1] === 'x'
  ? { x: fixed + out(dir) * off, y, z: c, rotY: FACE[dir] }
  : { x: c, y, z: fixed + out(dir) * off, rotY: FACE[dir] });

const plate = (dir, fixed, c, y, w, h, text) => ({ type: 'sign', ...on(dir, fixed, c, y), w, h, text, bg: '#15324f', fg: '#eef6ff' });
/** 어두운 가림벽에 붙이는 밝은 구역 표지 */
const zone = (dir, fixed, c, y, w, h, text) => ({ type: 'sign', ...on(dir, fixed, c, y), w, h, text, bg: '#f2f5f9', fg: '#12263d' });
const monitor = (dir, fixed, c, y, w, h, text) => ({ type: 'sign', ...on(dir, fixed, c, y), w, h, text, bg: '#07131c', fg: '#58f0c2' });
const caution = (dir, fixed, c, y, w, h, text) => ({ type: 'sign', ...on(dir, fixed, c, y), w, h, text, bg: '#e8b61c', fg: '#1a1a1a' });
/** 네온 띠. 서쪽은 시안, 돌린 동쪽은 핑크로 바꿔 칠한다 */
const neon = (from, to, r = 0.035) => ({ type: 'pipe', from, to, r, mat: 'neon_cyan' });
const beam = (from, to, r = 0.07) => ({ type: 'pipe', from, to, r, mat: 'steel' });
/** 불 켜진 전구(실제 조명 아님) */
const bulb = (x, y, z) => ({ type: 'light', x, y, z, color: '#fff0cf', intensity: 0.8, dist: 8 });
/** 바깥 벽의 닫힌 하역 문 */
const dockDoor = (z) => ({ type: 'vent', ...on('+x', -21, z, 1.75, 0.005), w: 3, h: 3.5, d: 0.12, mat: 'steel' });
const parcels = (x, y, z, rotY = 0.2, size = 0.7, levels = 2) => ({ type: 'crateStack', x, y, z, rotY, size, levels });

/** 남북으로 걸친 지붕 트러스: 위·아래 현재와 지그재그 사재 */
function truss(x) {
  const list = [beam([x, 7.25, -15], [x, 7.25, 15], 0.08), beam([x, 6.6, -15], [x, 6.6, 15], 0.07)];
  for (let i = 0; i < 6; i++) {
    const z = -15 + i * 5, up = i % 2 === 0;
    list.push(beam([x, up ? 6.6 : 7.25, z], [x, up ? 7.25 : 6.6, z + 5], 0.045));
  }
  return list;
}

/* ---------------- 장식 ---------------- */

const decorCenter = [
  // 실제 조명 넷(배열 앞쪽부터 실제 조명이 된다): 분류기 양쪽 마당과 북쪽·남쪽 통로 한가운데
  { type: 'light', x: -7.5, y: 6.1, z: 0, color: '#e8efff', intensity: 1.25, dist: 18 },
  { type: 'light', x: 7.5, y: 6.1, z: 0, color: '#e8efff', intensity: 1.25, dist: 18 },
  { type: 'light', x: 0, y: 6.1, z: -9, color: '#fff1d6', intensity: 1, dist: 15 },
  { type: 'light', x: 0, y: 6.1, z: 9, color: '#fff1d6', intensity: 1, dist: 15 },
  beam([-7.5, 6.32, 0], [-7.5, 7.3, 0], 0.03),
  beam([7.5, 6.32, 0], [7.5, 7.3, 0], 0.03),
  beam([0, 6.32, -9], [0, 6.6, -9], 0.03),
  beam([0, 6.32, 9], [0, 6.6, 9], 0.03),
  // 가운데 트러스와 동서로 긴 도리
  ...truss(0),
  beam([-21, 7.3, -10], [21, 7.3, -10], 0.06),
  beam([-21, 7.3, 0], [21, 7.3, 0], 0.06),
  beam([-21, 7.3, 10], [21, 7.3, 10], 0.06),
  // 분류기 화면과 모서리 네온(서쪽 시안, 동쪽 핑크)
  monitor('-x', -0.8, 0, 1.85, 2.6, 0.95, '분류 처리량\n시간당 12,480건'),
  monitor('+x', 0.8, 0, 1.85, 2.6, 0.95, '오분류율 0.3 %\n야간조 가동 중'),
  neon([-0.84, 0.05, -3.24], [-0.84, UNDER, -3.24]),
  neon([-0.84, 0.05, 3.24], [-0.84, UNDER, 3.24]),
  { ...neon([0.84, 0.05, -3.24], [0.84, UNDER, -3.24]), mat: 'neon_pink' },
  { ...neon([0.84, 0.05, 3.24], [0.84, UNDER, 3.24]), mat: 'neon_pink' }
];

const decorHalf = [
  // 지붕 트러스
  ...truss(-18), ...truss(-12), ...truss(-6),
  // 바깥 벽: 닫힌 하역 문과 환기구
  dockDoor(-11.5), dockDoor(-6), dockDoor(6), dockDoor(11.5),
  { type: 'vent', ...on('+z', -15, -8, 5.6, 0.005), w: 1.6, h: 0.8, d: 0.16 },
  { type: 'vent', ...on('+z', -15, -18.6, 5.6, 0.005), w: 1.6, h: 0.8, d: 0.16 },
  // 전구: 2층 통로 밑과 도크
  bulb(-14.5, 2.55, -13.5), bulb(-2, 2.55, -13.5), bulb(-14.5, 2.55, 13.5), bulb(-2, 2.55, 13.5),
  bulb(-18, 5.6, -9), bulb(-18, 5.6, 9),
  beam([-18, 5.82, -9], [-18, 6.6, -9], 0.03), beam([-18, 5.82, 9], [-18, 6.6, 9], 0.03),
  // 네온: 랙 윗변
  neon([-13, RACK + 0.04, -6.66], [-9, RACK + 0.04, -6.66]),
  neon([-13, RACK + 0.04, -4.94], [-9, RACK + 0.04, -4.94]),
  neon([-6.5, RACK + 0.04, -6.66], [-4, RACK + 0.04, -6.66]),
  neon([-6.5, RACK + 0.04, -2.94], [-4, RACK + 0.04, -2.94]),
  neon([-13, RACK + 0.04, 6.66], [-1.2, RACK + 0.04, 6.66]),
  neon([-13, RACK + 0.04, 4.94], [-6.5, RACK + 0.04, 4.94]),
  neon([-6.5, RACK + 0.04, 2.94], [-4, RACK + 0.04, 2.94]),
  neon([-6, RACK + 0.04, 9.46], [-4.6, RACK + 0.04, 9.46]),
  // 네온: 가림벽 윗변과 유리 가림막, 충전소
  neon([-12.94, TALL, -12], [-12.94, TALL, -6.6], 0.045),
  neon([-12.94, TALL, 6.6], [-12.94, TALL, 12], 0.045),
  neon([-16, TALL, -4.94], [-13, TALL, -4.94], 0.045),
  neon([-13.9, GLASS + 0.04, -3.2], [-13.9, GLASS + 0.04, 3.2], 0.03),
  neon([-13.74, 0.4, 3.3], [-13.74, GLASS - 0.3, 3.3], 0.03),
  neon([-13.74, 0.4, 4.9], [-13.74, GLASS - 0.3, 4.9], 0.03),
  // 네온: 2층 난간 윗변과 다리
  neon([-16, MEZ + RAIL + 0.03, -12.1], [-6.6, MEZ + RAIL + 0.03, -12.1], 0.03),
  neon([-4, MEZ + RAIL + 0.03, -12.1], [-1.2, MEZ + RAIL + 0.03, -12.1], 0.03),
  neon([-16, MEZ + RAIL + 0.03, 12.1], [-10.6, MEZ + RAIL + 0.03, 12.1], 0.03),
  neon([-8, MEZ + RAIL + 0.03, 12.1], [-1.2, MEZ + RAIL + 0.03, 12.1], 0.03),
  neon([-1.1, MEZ + RAIL + 0.03, -12.2], [-1.1, MEZ + RAIL + 0.03, 12.2], 0.03),
  neon([-1.24, UNDER + 0.15, -12], [-1.24, UNDER + 0.15, 12], 0.03),
  // 네온: 승강기 양옆 길잡이(승강기가 지나가는 자리 밖에 붙인다)
  neon([-10.8, 0.1, 9.36], [-10.8, MEZ + RAIL, 9.36], 0.03),
  neon([-7.8, 0.1, 11.96], [-7.8, UNDER, 11.96], 0.03),
  // 랙과 높은 랙 위에 올려 둔 상자(막이 안쪽이라 닿지 않는다)
  parcels(-11.6, RACK, -5.8, 0.15),
  parcels(-5.1, RACK, -5.8, -0.3, 0.6),
  parcels(-10.8, RACK, 5.8, 0.4),
  parcels(-3.4, RACK, 5.8, -0.1, 0.6),
  parcels(-5, RACK, -4, 0.5, 0.7, 1),
  parcels(-14.6, TALL, -5.8, 0.2, 0.8, 1),
  parcels(-14.4, TALL, 5.8, -0.4, 0.8, 1),
  parcels(-18.7, 2.8, 1.2, 0.1, 0.6, 1)
];

/** 절반마다 글자가 다른 표지. 동쪽은 돌려서 쓴다 */
const labelled = (t) => [
  // 구역 이름: 가림벽의 분류장 쪽
  zone('+x', -13, -8.3, 3.7, 3, 0.9, t.zoneNorth),
  zone('+x', -13, 8.3, 3.7, 3, 0.9, t.zoneSouth),
  // 로비 안 길 안내: 도크 문에서 나오면 정면에 보인다
  zone('-x', -13.4, -8.3, 2.5, 2.6, 0.6, t.wayNorth),
  zone('-x', -13.4, 8.3, 2.5, 2.6, 0.6, t.waySouth),
  // 도크 번호
  plate('+x', -21, -8.75, 4, 1.8, 0.6, t.dockA),
  plate('+x', -21, 8.75, 4, 1.8, 0.6, t.dockB),
  // 투입대와 충전소 화면, 보관실 문패
  monitor('-z', 0.7, -11.25, 1.75, 1.1, 0.6, t.feed),
  monitor('+x', -13.8, 4.1, 2.3, 1.4, 0.6, t.charge),
  plate('+x', -4, -13.5, 1.9, 1.8, 0.5, t.storeNorth),
  plate('-z', 12, -6, 1.9, 2, 0.5, t.storeSouth),
  // 승강기와 셔터 주의
  caution('-x', -11, 10.7, 2, 1.9, 0.5, '화물 승강기 · 탑승 주의'),
  caution('+x', -16, 0, 3.25, 2.6, 0.55, '셔터 작동 중 · 끼임 주의')
];

/** 도크 벽 안쪽의 팀 색 깃발. 스폰에서 바로 보인다 */
const teamDecor = (team) => [
  { type: 'banner', ...on('-x', -16.4, -4.1, 4.9, 0.12), w: 1.5, h: 3.2, text: team.name, emblem: 'ring', bg: team.color, fg: '#f4f1e8' },
  { type: 'banner', ...on('-x', -16.4, 4.1, 4.9, 0.12), w: 1.5, h: 3.2, text: team.name, emblem: 'ring', bg: team.color, fg: '#f4f1e8' }
];

const pink = (d) => (d.mat === 'neon_cyan' ? { ...d, mat: 'neon_pink' } : d);

/* ---------------- 스폰 ---------------- */

/** 카메라가 (x,z)에서 (tx,tz)를 보는 rotY */
const look = (x, z, tx, tz) => Math.atan2(-(tx - x), -(tz - z));
const spot = (x, z, tx, tz, y) => (y === undefined ? { x, z, rotY: look(x, z, tx, tz) } : { x, y, z, rotY: look(x, z, tx, tz) });

const blue = [
  spot(-19.6, -6.6, -16.2, -8.3),
  spot(-18.4, -4.4, -16.2, -8.3),
  spot(-18.4, 4.4, -16.2, 8.3),
  spot(-19.6, 6.6, -16.2, 8.3),
  spot(-20, 0, -19.6, -8)
];

const ffaHalf = [
  spot(-8, -8.2, 0, -8.2),
  spot(-12.6, 4, -6, 0),
  spot(-1.5, 13.5, 3, 9),
  spot(-8.2, -13.6, 0, -13.6, MEZ)
];

/* ---------------- 발판과 소품 ---------------- */

const padsHalf = [
  // 남쪽 랙 뒤(상자 더미 옆) → 다리 남쪽 끝의 2층 남쪽 통로
  { x: -3.4, y: 0, z: 7.8, w: 2, d: 2, target: [-0.3, MEZ, 13.5], apex: 2.5 }
];

const propsHalf = [
  { type: 'crate', x: -19.8, y: 0, z: -13.6 },
  { type: 'barrel', x: -17.2, y: 0, z: -11.4 },
  { type: 'crate', x: -19.6, y: 0, z: 13.4, size: 0.8 },
  { type: 'crate', x: -11.8, y: 0, z: -7.5 },
  { type: 'barrel', x: -9.4, y: 0, z: 3.9 },
  { type: 'crate', x: -3.4, y: 0, z: 13.8 },
  { type: 'barrel', x: -2.6, y: 0, z: -14.2 },
  { type: 'crate', x: -14.6, y: MEZ, z: -14.4, size: 0.8 }
];

export default {
  id: 'sorthub',
  name: '택배 분류 센터',
  nameEn: 'Parcel Hub',
  desc: '랙 통로 셋과 2층 통로 사이로 화물 승강기·셔터·무인 대차가 쉬지 않고 움직이는 야간 택배 분류장.',
  tag: '좁은 맵',
  size: { x: 44, z: 32 },
  rulesets: ['classic', 'knife'],
  theme: {
    sky: '#151c2e', skyTop: '#05070f', fog: [40, 150], sunDir: [0.18, 0.95, 0.24],
    sunColor: '#dfe6ff', sunIntensity: 0.9, ambient: 0.95, ground: 'concrete'
  },
  spawns: {
    owner: blue,
    charterer: rotate180(blue),
    ffa: [...ffaHalf, ...rotate180(ffaHalf)]
  },
  solids: [...center, ...half, ...rotate180(half)],
  decor: [
    ...decorCenter,
    ...decorHalf,
    ...rotate180(decorHalf).map(pink),
    ...labelled({
      zoneNorth: 'A-1 수도권', zoneSouth: 'A-2 강원·충청', wayNorth: '← 계단 · 북쪽 통로', waySouth: '남쪽 통로 · 승강기 →',
      dockA: '도크 1 · 2', dockB: '도크 3 · 4', feed: '투입 대기 37건', charge: '대차 충전 87 %', storeNorth: '분실물 보관실', storeSouth: '반품 구역'
    }),
    ...rotate180(labelled({
      zoneNorth: 'B-1 영남', zoneSouth: 'B-2 호남·제주', wayNorth: '← 계단 · 남쪽 통로', waySouth: '북쪽 통로 · 승강기 →',
      dockA: '도크 5 · 6', dockB: '도크 7 · 8', feed: '투입 대기 52건', charge: '대차 충전 64 %', storeNorth: '미배송 보관실', storeSouth: '파손 화물 구역'
    })),
    ...teamDecor(TEAMS.owner),
    ...rotate180(teamDecor(TEAMS.charterer))
  ],
  movers: [...moversWest, ...rotate180(moversWest).map((m) => ({ ...m, id: m.id.replace('_w_r', '_e') }))],
  pads: [...padsHalf, ...rotate180(padsHalf)],
  portals: [],
  secrets: [],
  props: [...propsHalf, ...rotate180(propsHalf)]
};
