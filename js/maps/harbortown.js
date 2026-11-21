/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 배틀로얄 전용 맵 '서해 항만 신도시'(West Sea Harbor Town). 서해 매립지 위 250 m 신도시로, 동쪽 컨테이너 부두, 북서 아파트 단지,
 *          가운데 전통시장과 홍보관, 남서 신축 공사현장, 남쪽 초등학교·행정복지센터·방조제가 있다. 8×8 격자(칸 31 m) 구역 봉쇄용 br 칸을 가진다.
 */
import { box, cyl, ramp, doorwayWall, mirrorZ } from './kit.js';

// 방위: 북 = -z, 동 = +x(바다). 1 = 1 m, 바닥 y = 0, 바다 윗면 y = -2.6(안벽 높이 2.6 m).
// 격자 칸은 31 m이고 열 A~H는 x -124 → 124, 행 1~8은 z -124 → 124 다.
//
//            A         B         C         D    │    E         F         G         H
//  z -124 ┌ 101동 ─── 102동 ──────────── 차고지 ─┼─ ── 위판장 ─────── 컨테이너 ─────┐ 바
//         │  놀이터 · 주차                       │                  야적장   안벽  │ 다
//  z  -80 │ 103동(옥상 계단) 104동  상가 주유소 │  냉동창고        (단 1~3)  크레인│
//  z  -40 ├────────────── 북쪽 큰길 ─────────────┼──────── 주차장 ──┤ 부두길          │
//         │ 언덕공원 │ 주차 │ ═ 전통시장(아케이드) ═ │ 홍보관 · 중앙광장 │          크레인│ 화물선
//  z   36 ├────────────── 남쪽 큰길 ─────────────┼──────────────────┤                 │
//         │ 공사현장(골조·터파기·타워크레인) │ 초등학교 │ 행정복지센터 · 빌라 │ 운영동 · 보세창고│
//  z  124 └─────────────────── 방조제 산책로(높이 3) ──────────────────┴──────────────┘
//
// 큰 건물은 1층(일부는 2층·옥상)까지 들어가고, 차·트럭·컨테이너가 길 위 엄폐물이다. 높은 곳은 103동 옥상, 공사 골조 3층, 언덕 정자, 방조제다.
// 여러 층 건물(103동 바깥 복도, 시장 2층 회랑·옥상, 학교 옥상 계단, 공사 골조, 운영동 계단식 테라스)은 바깥 경사로·턱 오르기로 오르고,
// 낮은 난간(1 m)을 넘어 뛰어내릴 수 있다. 배틀로얄 낙하 피해는 4 m부터라 2층(3~4 m)에서는 피해가 없다(engine/falldamage.js).

/* ---------------- 치수 ---------------- */

const HALF = 125;
const GRID = { origin: [-124, -124], cell: 31, cols: 8, rows: 8 };
const PILOTI = 3.6;          // 아파트·빌라 필로티(1층 빈 층) 높이
const SEA_TOP = -2.6;        // 바다 윗면
const QUAY_X = 113;          // 안벽 끝(여기부터 바다)

const R = Math.PI;
const R90 = Math.PI / 2;
/** (x0,z0)~(x1,z1) 바닥, y0~y1 높이의 상자 */
const rect = (x0, z0, x1, z1, y0, y1, mat) => box((x0 + x1) / 2, y0, (z0 + z1) / 2, x1 - x0, y1 - y0, z1 - z0, mat);
/** 카메라가 (x,z)에서 (tx,tz)를 보는 rotY */
const look = (x, z, tx, tz) => Math.atan2(-(tx - x), -(tz - z));
/** 전리품 자리 */
const loot = (x, y, z, tier = 'common') => ({ pos: [x, y, z], tier });

/* ---------------- 탈것과 소품 ---------------- */

/** 승용차 한 대(1.9×1.5×4.4). along = 'x'면 x로 길다 */
const car = (x, z, along = 'z', mat = 'white') => (along === 'x' ? rect(x - 2.2, z - 0.95, x + 2.2, z + 0.95, 0, 1.5, mat) : rect(x - 0.95, z - 2.2, x + 0.95, z + 2.2, 0, 1.5, mat));
/** 시내버스(2.6×3.2×11) */
const bus = (x, z, along = 'z', mat = 'yellow') => (along === 'x' ? rect(x - 5.5, z - 1.3, x + 5.5, z + 1.3, 0, 3.2, mat) : rect(x - 1.3, z - 5.5, x + 1.3, z + 5.5, 0, 3.2, mat));
/** 화물 트럭: 운전석(앞, -쪽) + 짐칸. 운전석 2.7, 짐칸 3.4 높이 */
function truck(x, z, along = 'z', mat = 'container_red') {
  return along === 'x'
    ? [rect(x - 5, z - 1.25, x - 2.6, z + 1.25, 0, 2.7, 'white'), rect(x - 2.4, z - 1.25, x + 4.6, z + 1.25, 0, 3.4, mat)]
    : [rect(x - 1.25, z - 5, x + 1.25, z - 2.6, 0, 2.7, 'white'), rect(x - 1.25, z - 2.4, x + 1.25, z + 4.6, 0, 3.4, mat)];
}
/** 콘크리트 방호벽(높이 0.9, 길이 4) */
const barrier = (x, z, along = 'x') => (along === 'x' ? rect(x - 2, z - 0.3, x + 2, z + 0.3, 0, 0.9, 'white') : rect(x - 0.3, z - 2, x + 0.3, z + 2, 0, 0.9, 'white'));

/**
 * 1층이 빈 필로티 동. 양 끝 벽, 가운데 승강기 홀, 위 몸통, 앞뒤 유리면.
 * 1층(높이 PILOTI)은 끝 벽과 승강기 홀 사이로 앞뒤가 트여 지나다닐 수 있다
 */
function piloti(x0, z0, x1, z1, top, mat = 'white', glass = true) {
  const xm = (x0 + x1) / 2;
  const out = [
    rect(x0, z0, x0 + 0.8, z1, 0, PILOTI, 'concrete'),
    rect(x1 - 0.8, z0, x1, z1, 0, PILOTI, 'concrete'),
    rect(xm - 2.2, z0 + 2.5, xm + 2.2, z1 - 2.5, 0, PILOTI, 'metal_dark'),
    rect(x0, z0, x1, z1, PILOTI, top, mat)
  ];
  if (glass) out.push(rect(x0 + 1.5, z0 - 0.15, x1 - 1.5, z0, PILOTI + 1, top - 1, 'glass'), rect(x0 + 1.5, z1, x1 - 1.5, z1 + 0.15, PILOTI + 1, top - 1, 'glass'));
  return out;
}

/**
 * 네모 단층 건물: 벽 높이 h, 지붕 판 0.4. doors = { n, s, w, e } 면마다 문 중심 좌표(벽 방향의 월드 좌표) 하나나 배열.
 * 문 윗변이 벽 높이와 같아 문틀 위 토막이 없다(도형 수를 아낀다)
 */
function hut(x0, z0, x1, z1, h, mat, doors = {}, roofMat = 'concrete', dw = 2.2) {
  const t = 0.4, out = [];
  const side = (ax0, az0, ax1, az1, at) => (at === undefined
    ? rect(Math.min(ax0, ax1) - (az0 === az1 ? 0 : t / 2), Math.min(az0, az1) - (az0 === az1 ? t / 2 : 0), Math.max(ax0, ax1) + (az0 === az1 ? 0 : t / 2), Math.max(az0, az1) + (az0 === az1 ? t / 2 : 0), 0, h, mat)
    : doorwayWall(ax0, az0, ax1, az1, h, t, mat, { at, w: dw, top: h }));
  out.push(side(x0, z0 + t / 2, x1, z0 + t / 2, doors.n));
  out.push(side(x0, z1 - t / 2, x1, z1 - t / 2, doors.s));
  out.push(side(x0 + t / 2, z0 + t, x0 + t / 2, z1 - t, doors.w));
  out.push(side(x1 - t / 2, z0 + t, x1 - t / 2, z1 - t, doors.e));
  out.push(rect(x0, z0, x1, z1, h, h + 0.4, roofMat));
  return out.flat();
}

/* ---------------- 바다·안벽·바닥 ---------------- */

const ground = [
  // 동쪽 바다(바닥을 도려내는 가라앉은 물)와 안벽 턱. 턱 위는 보이지 않는 막이라 바다로 떨어지지 않는다
  rect(QUAY_X, -HALF, HALF, HALF, SEA_TOP - 0.6, SEA_TOP, 'water'),
  rect(111.6, -HALF, QUAY_X, HALF, 0, 1, 'concrete'),
  rect(111.6, -HALF, QUAY_X, HALF, 1, 7, 'clip'),
  // 바닥 구역: 부두 콘크리트, 광장 타일, 시장 돌길, 단지 잔디, 공사장 모래, 운동장 흙
  rect(62, -HALF, 111.6, HALF, 0, 0.03, 'concrete'),
  rect(10, -28, 50, 28, 0, 0.03, 'tile'),
  rect(-74, -7.2, -12, 7.2, 0, 0.03, 'stone'),
  rect(-118, -101, -46, -86, 0, 0.03, 'grass'),
  rect(-122, 48, -62, 90, 0, 0.03, 'sand'),
  rect(-54, 52, -16, 88, 0, 0.03, 'sand'),
  // 차선(노란 중앙선): 남북 대로, 북쪽·남쪽 큰길, 부두길
  rect(-1.15, -HALF, -0.85, 106, 0, 0.02, 'yellow'),
  rect(-84, -40.15, 52, -39.85, 0, 0.02, 'yellow'),
  rect(-84, 35.85, 52, 36.15, 0, 0.02, 'yellow'),
  rect(56.85, -HALF, 57.15, 114, 0, 0.02, 'yellow')
];

/* ---------------- 아파트 단지 (A~C 1~3) ---------------- */

// 103동 동쪽 바깥 계단(두 줄 경사로가 지그재그로 옥상 13.2 m까지). 왼줄 x -88~-85.6, 오른줄 -85.6~-83.2
const T103 = { x0: -116, z0: -84, x1: -88, z1: -73, top: 13.2 };
const LANE_L = -86.8, LANE_R = -84.4, FLIGHT_Z = -78.5;
const stair103 = [
  ramp(LANE_L, 0, FLIGHT_Z, 2.4, 3.3, 7, '+z', 'steel'),
  rect(-88, -75, -83.2, -72.6, 3.0, 3.3, 'steel'),
  ramp(LANE_R, 3.3, FLIGHT_Z, 2.4, 3.3, 7, '-z', 'steel'),
  rect(-88, -84.4, -83.2, -82, 6.3, 6.6, 'steel'),
  ramp(LANE_L, 6.6, FLIGHT_Z, 2.4, 3.3, 7, '+z', 'steel'),
  rect(-88, -75, -83.2, -72.6, 9.6, 9.9, 'steel'),
  ramp(LANE_R, 9.9, FLIGHT_Z, 2.4, 3.3, 7, '-z', 'steel'),
  rect(-88, -84.4, -83.2, -82, 12.9, T103.top, 'steel')
];
const roof103 = [
  // 옥상 난간(높이 1). 동쪽 난간은 계단이 닿는 자리(z -84 ~ -82)에서 끊긴다
  rect(T103.x0, T103.z0, T103.x1, T103.z0 + 0.25, T103.top, T103.top + 1, 'concrete'),
  rect(T103.x0, T103.z1 - 0.25, T103.x1, T103.z1, T103.top, T103.top + 1, 'concrete'),
  rect(T103.x0, T103.z0 + 0.25, T103.x0 + 0.25, T103.z1 - 0.25, T103.top, T103.top + 1, 'concrete'),
  rect(T103.x1 - 0.25, -82, T103.x1, T103.z1 - 0.25, T103.top, T103.top + 1, 'concrete'),
  // 옥상 물탱크(앉으면 가려진다)
  rect(-104, -82, -100, -79, T103.top, T103.top + 2, 'white')
];
// 103동 바깥 복도(계단참과 이어진 2층 3.3 · 3층 6.6 · 4층 9.9). 바깥 난간(1 m)을 넘어 뛰어내린다: 2층은 피해 없음, 위층은 낙하 피해
const LEDGE = 2.6, RAIL = 0.2;
const corridor = (y, south) => {
  const z0 = south ? T103.z1 + 0.15 : T103.z0 - 0.15 - LEDGE, z1 = z0 + LEDGE;
  return [
    rect(T103.x0, z0, -83.2, z1, y - 0.3, y, 'concrete'),
    south ? rect(T103.x0, z1 - RAIL, -83.2, z1, y, y + 1, 'steel') : rect(T103.x0, z0, -83.2, z0 + RAIL, y, y + 1, 'steel')
  ];
};
const corridors103 = [...corridor(3.3, true), ...corridor(6.6, false), ...corridor(9.9, true)];
const apartments = [
  ...piloti(-116, -114, -88, -103, 27),
  ...piloti(-78, -114, -50, -103, 27),
  ...piloti(T103.x0, T103.z0, T103.x1, T103.z1, T103.top),
  ...piloti(-76, -84, -48, -73, 16.4),
  ...stair103, ...roof103, ...corridors103,
  // 상가동 '해솔프라자'(1층, 두 칸): 앞문 둘(남), 뒷문 하나, 가운데 칸막이
  ...hut(-64, -64, -46, -52, 3.6, 'brick', { s: [-59, -51], n: -60 }),
  rect(-55.15, -63.6, -54.85, -60.2, 0, 3.6, 'brick'),
  rect(-55.15, -56.6, -54.85, -52.4, 0, 3.6, 'brick'),
  rect(-53, -63.5, -48, -62.6, 0, 1.1, 'wood'),
  // 놀이터 미끄럼틀 받침
  rect(-104, -93, -102, -91, 0, 1.4, 'yellow')
];

/* ---------------- 차고지·위판장·냉동창고·주유소 (D~F 1~3) ---------------- */

const depot = [
  // 버스 넷(사이 2 m)과 캐노피
  bus(-27, -110.5, 'z', 'yellow'), bus(-22.4, -110.5, 'z', 'white'), bus(-17.8, -110.5, 'z', 'yellow'), bus(-13.2, -110.5, 'z', 'white'),
  ...[[-29.5, -117], [-11, -117], [-29.5, -104], [-11, -104]].map(([x, z]) => rect(x - 0.3, z - 0.3, x + 0.3, z + 0.3, 0, 4.2, 'steel')),
  rect(-30, -117.5, -10.5, -103.5, 4.2, 4.5, 'metal_dark'),
  // 차고지 사무실(남쪽 문)
  ...hut(-28, -96, -18, -88, 3.4, 'plaster', { s: -23 }),
  rect(-27.4, -95.4, -24, -94.6, 0, 0.9, 'wood')
];

const fishMarket = [
  // 지붕만 있는 위판장(높이 6.5)과 기둥 여덟
  rect(18, -118, 56, -88, 6.5, 6.9, 'steel'),
  ...[18.6, 31, 43.5, 55.4].flatMap((x) => [-117.4, -88.6].map((z) => rect(x - 0.3, z - 0.3, x + 0.3, z + 0.3, 0, 6.5, 'steel'))),
  // 활어 수조 줄과 얼음 상자
  rect(22, -112, 34, -110.6, 0, 1.1, 'steel'), rect(40, -112, 52, -110.6, 0, 1.1, 'steel'),
  rect(22, -100, 34, -98.6, 0, 1.1, 'steel'), rect(40, -100, 52, -98.6, 0, 1.1, 'steel'),
  rect(36, -106, 38, -103, 0, 1.6, 'wood'), rect(24, -94, 27, -92, 0, 1.6, 'wood')
];

const coldStore = [
  // 냉동창고(높이 6): 북쪽 하역문, 남쪽 출입문, 안에 선반 두 줄
  doorwayWall(20, -79.8, 44, -79.8, 6, 0.4, 'white', { at: 32, w: 3.2, top: 4 }),
  doorwayWall(20, -66.2, 44, -66.2, 6, 0.4, 'white', { at: 26, w: 3.2, top: 4 }),
  rect(20, -79.6, 20.4, -66.4, 0, 6, 'white'),
  rect(43.6, -79.6, 44, -66.4, 0, 6, 'white'),
  rect(20, -80, 44, -66, 6, 6.4, 'metal_dark'),
  rect(24, -76, 40, -75, 0, 3.2, 'steel'),
  rect(24, -71, 40, -70, 0, 3.2, 'steel')
].flat();

const gasStation = [
  rect(-32, -74, -14, -60, 5, 5.5, 'white'),
  ...[[-29, -71], [-17, -71], [-29, -63], [-17, -63]].map(([x, z]) => rect(x - 0.25, z - 0.25, x + 0.25, z + 0.25, 0, 5, 'steel')),
  rect(-24, -68.8, -22, -67.8, 0, 1.6, 'metal_dark'),
  rect(-24, -64.2, -22, -63.2, 0, 1.6, 'metal_dark'),
  // 계산 부스(동쪽 문)
  ...hut(-38, -74, -32, -66, 3.2, 'plaster', { e: -70 })
];

/* ---------------- 전통시장 (C~D 4~5) ---------------- */

// 북쪽 상가 줄(z -16 ~ -7.2). 앞(거리 쪽)은 셔터를 올린 가게라 트여 있다. 남쪽 줄은 z로 뒤집은 복사본이다.
// 2층은 앞이 하늘로 트인 회랑(바닥 3.9, 난간 1 m — 넘어 아케이드로 뛰어내린다)이고 뒤 6.6 m에만 지붕(7)이 있다.
// 회랑 끝의 실외기(1.5 m)를 밟고 지붕(+1.6 m)으로 턱 오르기를 해서 옥상에 오른다
const MARKET_2F = 3.9, MARKET_ROOF = 7;
function shopBlock(x0, x1) {
  const xm = (x0 + x1) / 2;
  return [
    doorwayWall(x0, -15.8, x1, -15.8, 3.6, 0.4, 'brick', { at: x0 + 4, w: 2.2, top: 3.6 }),
    rect(x0, -15.6, x0 + 0.4, -7.2, 0, 3.6, 'brick'),
    rect(x1 - 0.4, -15.6, x1, -7.2, 0, 3.6, 'brick'),
    rect(xm - 0.15, -15.6, xm + 0.15, -9.4, 0, 3.6, 'brick'),
    rect(x0, -16, x1, -7.2, 3.6, MARKET_2F, 'plaster'),
    rect(x0, -16, x1, -15.6, MARKET_2F, MARKET_ROOF, 'plaster'),
    rect(x0, -16, x1, -9.4, MARKET_ROOF - 0.3, MARKET_ROOF, 'plaster'),
    rect(x0, -7.6, x1, -7.2, MARKET_2F, MARKET_2F + 1, 'steel'),
    rect(x1 - 3, -9.4, x1 - 1.6, -8.4, MARKET_2F, MARKET_2F + 1.5, 'metal_dark')
  ].flat();
}
const MARKET_X0 = -74, MARKET_X1 = -12;
const marketRow = [
  ...shopBlock(-74, -55),
  rect(-51, -16, -37, -7.2, 0, 7, 'plaster'),
  ...shopBlock(-33, -12),
  // 양 끝 바깥 경사로(땅 → 2층 회랑): 서쪽은 서쪽 가게, 동쪽은 동쪽 가게 2층으로
  ramp(MARKET_X0 - 1.2, 0, -11.8, 2.4, MARKET_2F, 8.4, '+z', 'steel'),
  ramp(MARKET_X1 + 1.2, 0, -11.8, 2.4, MARKET_2F, 8.4, '+z', 'steel'),
  // 좌판(높이 1)과 차양
  ...[-70, -60, -44, -29, -22, -16].map((x) => rect(x - 1.6, -6.4, x + 1.6, -5, 0, 1, 'wood')),
  rect(-74, -7.2, -55, -4.6, 2.8, 2.95, 'container_red'),
  rect(-51, -7.2, -37, -4.6, 2.8, 2.95, 'yellow'),
  rect(-33, -7.2, -12, -4.6, 2.8, 2.95, 'container_red')
];
const market = [
  ...marketRow, ...mirrorZ(marketRow),
  // 아케이드 유리 지붕(높이 7)과 양 끝 문 들보
  rect(MARKET_X0, -7.2, MARKET_X1, 7.2, 7, 7.2, 'glass'),
  rect(MARKET_X0 - 0.6, -7.2, MARKET_X0 + 0.6, 7.2, 5.8, 7, 'wood_dark'),
  rect(MARKET_X1 - 0.6, -7.2, MARKET_X1 + 0.6, 7.2, 5.8, 7, 'wood_dark')
];

/* ---------------- 홍보관·중앙광장 (E~F 4~5) ---------------- */

const HALL = { x0: 16, z0: -12, x1: 44, z1: 12, h: 8 };
const hall = [
  rect(HALL.x0, HALL.z0, HALL.x1, HALL.z0 + 0.4, 0, HALL.h, 'white'),
  doorwayWall(HALL.x0, HALL.z1 - 0.2, HALL.x1, HALL.z1 - 0.2, HALL.h, 0.4, 'glass', { at: [24, 36], w: 2.6, top: 3.2 }),
  doorwayWall(HALL.x0 + 0.2, HALL.z0 + 0.4, HALL.x0 + 0.2, HALL.z1 - 0.4, HALL.h, 0.4, 'white', { at: 6, w: 2.4, top: 3.2 }),
  doorwayWall(HALL.x1 - 0.2, HALL.z0 + 0.4, HALL.x1 - 0.2, HALL.z1 - 0.4, HALL.h, 0.4, 'glass', { at: 0, w: 2.6, top: 3.2 }),
  rect(HALL.x0, HALL.z0, HALL.x1, HALL.z1, HALL.h, HALL.h + 0.4, 'white'),
  // 2층 전시 회랑(높이 4)과 서쪽 벽을 따라 오르는 경사로, 유리 난간
  rect(HALL.x0 + 0.4, HALL.z0 + 0.4, HALL.x1 - 0.4, -4.5, 3.7, 4, 'concrete'),
  ramp(17.9, 0, 0, 3, 4, 9, '-z', 'concrete'),
  rect(19.4, -4.7, HALL.x1 - 0.4, -4.5, 4, 5, 'glass'),
  // 신도시 모형(탁자 위 아파트 둘)과 전시 칸막이, 2층 안내 데스크
  rect(26, -2, 34, 4, 0, 1, 'wood'),
  rect(27, -1, 28.5, 0.5, 1, 3, 'white'),
  rect(31, 1, 32.5, 2.5, 1, 2.4, 'white'),
  rect(36, -3, 36.3, 2, 0, 2.4, 'white'),
  rect(22, 6, 26, 6.3, 0, 2.4, 'white'),
  rect(30, -10, 34, -9, 4, 5.1, 'wood')
].flat();
const plaza = [
  cyl(30, 0, 20, 3.2, 0.6, 'stone'),
  cyl(30, 0.6, 20, 2.8, 0.03, 'water'),
  ...[[12, -24], [45, -24], [12, 21], [45, 21]].map(([x, z]) => rect(x, z, x + 3, z + 3, 0, 0.9, 'stone'))
];

/* ---------------- 언덕공원 (A 4~5) ---------------- */

const hill = [
  rect(-122, -30, -92, 30, 0, 2.4, 'stone'),
  rect(-122, -30, -92, 30, 2.4, 2.45, 'grass'),
  rect(-118, -18, -100, 16, 2.45, 4.8, 'stone'),
  rect(-118, -18, -100, 16, 4.8, 4.85, 'grass'),
  // 아래 단 경사로(동 둘, 북, 남)
  ramp(-88.5, 0, -6, 7, 2.45, 6, '-x', 'stone'),
  ramp(-88.5, 0, 20, 7, 2.45, 6, '-x', 'stone'),
  ramp(-106, 0, -33.5, 6, 2.45, 7, '+z', 'stone'),
  ramp(-106, 0, 33.5, 6, 2.45, 7, '-z', 'stone'),
  // 위 단 경사로(동, 남)
  ramp(-96.5, 2.45, 0, 7, 2.4, 5, '-x', 'stone'),
  ramp(-110, 2.45, 19.5, 5, 2.4, 7, '-z', 'stone'),
  // 정자: 마루, 기둥 넷, 지붕
  rect(-113, -5, -105, 3, 4.85, 5.1, 'wood_dark'),
  ...[[-112.6, -4.6], [-105.4, -4.6], [-112.6, 2.6], [-105.4, 2.6]].map(([x, z]) => rect(x - 0.15, z - 0.15, x + 0.15, z + 0.15, 5.1, 7.9, 'wood_dark')),
  rect(-113.6, -5.6, -104.4, 3.6, 7.9, 8.3, 'wood_dark')
];

/* ---------------- 공사현장 (A~B 6~8) ---------------- */

// 철근콘크리트 골조(x -116 ~ -90, z 56 ~ 76): 슬래브 4·8 m, 3층(12 m)은 북쪽 절반만. 동쪽 비계 경사로로 오른다
const frame = [
  rect(-116, 56, -90, 76, 3.7, 4, 'concrete'),
  rect(-116, 56, -90, 76, 7.7, 8, 'concrete'),
  rect(-116, 56, -90, 66, 11.7, 12, 'concrete'),
  ...[[-115.7, 56.3, 12], [-115.7, 75.7, 8], [-103, 56.3, 12], [-103, 75.7, 8], [-90.3, 56.3, 12], [-90.3, 75.7, 8], [-103, 66, 12]]
    .map(([x, z, h]) => rect(x - 0.3, z - 0.3, x + 0.3, z + 0.3, 0, h, 'concrete')),
  // 비계 경사로: 왼줄(x -90 ~ -87.6) 0→4, 오른줄(-87.6 ~ -85.2) 4→8, 남쪽 발판 8, 왼줄 위 8→12
  ramp(-88.8, 0, 63.5, 2.4, 4, 9, '-z', 'steel'),
  ramp(-86.4, 4, 63.5, 2.4, 4, 9, '+z', 'steel'),
  rect(-90, 68, -85.2, 70.4, 7.7, 8, 'steel'),
  ramp(-88.8, 8, 63.5, 2.4, 4, 9, '-z', 'steel'),
  // 쌓다 만 블록 벽과 자재
  rect(-110, 60, -104, 60.3, 4, 5.2, 'brick'),
  rect(-100, 70, -95, 70.3, 8, 9.2, 'brick'),
  rect(-112, 66, -106, 66.3, 0, 1.4, 'brick'),
  rect(-112, 70, -109, 72, 4, 4.9, 'rust'),
  rect(-110, 60.8, -108, 63.3, 12, 12.8, 'wood'),
  // 비계 난간(1 m, 넘어 뛰어내린다): 2층 슬래브(4) 남쪽 동편, 3층 슬래브(8) 남쪽 서편
  rect(-103, 75.8, -91, 76, 4, 5, 'steel'),
  rect(-116, 75.8, -103.3, 76, 8, 9, 'steel'),
  // 서쪽 팔레트 더미 두 단(1.5 · 3.0): 턱 오르기를 이어 2층 슬래브(4)로 오른다
  rect(-118, 58, -116.2, 60, 0, 1.5, 'wood'),
  rect(-118, 60, -116.2, 62, 0, 3, 'wood')
];
const site = [
  // 가설 울타리(북쪽 문 둘, 동쪽 문 하나)
  rect(-122, 45.9, -104, 46.1, 0, 2.6, 'steel'),
  rect(-98, 45.9, -80, 46.1, 0, 2.6, 'steel'),
  rect(-74, 45.9, -62, 46.1, 0, 2.6, 'steel'),
  rect(-62.1, 46, -61.9, 80, 0, 2.6, 'steel'),
  rect(-62.1, 86, -61.9, 112, 0, 2.6, 'steel'),
  // 타워크레인 둘(올라갈 수 없다)
  rect(-77, 65, -75, 67, 0, 36, 'yellow'),
  rect(-112, 65.4, -70, 66.6, 36, 37.4, 'yellow'),
  rect(-77.6, 64.4, -74.4, 67.6, 33, 36, 'white'),
  rect(-72, 65.2, -70, 66.8, 34, 36, 'concrete'),
  rect(-101, 101, -99, 103, SEA_TOP + 0.2, 32, 'yellow'),
  rect(-100.6, 80, -99.4, 120, 32, 33.2, 'yellow'),
  rect(-100.8, 114, -99.2, 118, 30, 32, 'concrete'),
  // 현장 사무실(컨테이너 두 층, 아래층에 남쪽 문)
  ...hut(-80, 50, -70, 56, 2.8, 'white', { s: -75 }, 'container_red'),
  rect(-80, 50, -70, 56, 3.2, 5.6, 'white'),
  rect(-74, 50.4, -71, 51.2, 0, 0.9, 'wood'),
  // 자재 마당: 모래 더미, 철근 묶음, 관 더미, 거푸집, 레미콘 차
  ramp(-78, 0, 96, 6, 2.2, 4, '+z', 'sand'),
  ramp(-78, 0, 100, 6, 2.2, 4, '-z', 'sand'),
  rect(-72, 92, -66, 93.4, 0, 0.8, 'rust'),
  rect(-72, 95, -66, 96.4, 0, 0.8, 'rust'),
  rect(-84, 106, -78, 108.5, 0, 1.3, 'pipe'),
  rect(-74, 104, -71, 107, 0, 1.6, 'wood'),
  rect(-69.3, 108, -66.7, 110.4, 0, 2.8, 'white'),
  rect(-69.3, 110.4, -66.7, 117, 0, 3.4, 'steel'),
  // 터파기(깊이 2.4): 바닥, 남북 경사로, 굴착기
  rect(-114, 92, -86, 112, SEA_TOP, SEA_TOP + 0.2, 'sand'),
  ramp(-91, SEA_TOP + 0.2, 96, 4, 2.4, 8, '-z', 'sand'),
  ramp(-110, SEA_TOP + 0.2, 108, 4, 2.4, 8, '+z', 'sand'),
  rect(-106, 98, -102, 101, SEA_TOP + 0.2, 0.4, 'yellow')
].flat();

/* ---------------- 초등학교 (C~D 6~8) ---------------- */

const SCHOOL = { x0: -52, z0: 94, x1: -16, z1: 108 };
const school = [
  // 담장(북 정문, 서·동 쪽문)
  rect(-58, 45.85, -40, 46.15, 0, 1.6, 'brick'),
  rect(-32, 45.85, -12, 46.15, 0, 1.6, 'brick'),
  rect(-58.15, 46, -57.85, 74, 0, 1.6, 'brick'),
  rect(-58.15, 80, -57.85, 112, 0, 1.6, 'brick'),
  rect(-12.15, 46, -11.85, 64, 0, 1.6, 'brick'),
  rect(-12.15, 70, -11.85, 112, 0, 1.6, 'brick'),
  // 본관 1층 앞면: 허리 벽(1 m, 넘어갈 수 있는 창)과 문 셋, 위 띠
  rect(-52, 93.8, -47.2, 94.2, 0, 1, 'plaster'),
  rect(-44.8, 93.8, -35.2, 94.2, 0, 1, 'plaster'),
  rect(-32.8, 93.8, -23.2, 94.2, 0, 1, 'plaster'),
  rect(-20.8, 93.8, -16, 94.2, 0, 1, 'plaster'),
  rect(-52, 93.8, -16, 94.2, 2.6, 3.6, 'plaster'),
  // 뒷벽·양 끝 벽(2층까지)
  rect(-52, 107.6, -16, 108, 0, 7.2, 'plaster'),
  rect(-52, 94.2, -51.6, 107.6, 0, 7.2, 'plaster'),
  rect(-16.4, 94.2, -16, 107.6, 0, 7.2, 'plaster'),
  // 복도 벽(교실 문 셋)과 교실 칸막이
  doorwayWall(-51.6, 98.5, -16.4, 98.5, 3.6, 0.3, 'plaster', { at: [-44, -32, -24], w: 2, top: 2.6 }),
  rect(-40.15, 98.65, -39.85, 107.6, 0, 3.6, 'plaster'),
  rect(-28.15, 98.65, -27.85, 107.6, 0, 3.6, 'plaster'),
  // 2층 바닥(동쪽 교실에 계단 구멍)과 경사로, 구멍 난간
  rect(-51.6, 94.2, -20, 107.6, 3.6, 3.9, 'concrete'),
  rect(-20, 94.2, -16.4, 98.5, 3.6, 3.9, 'concrete'),
  ramp(-18.2, 0, 103.05, 3.6, 3.9, 9.1, '-z', 'concrete'),
  rect(-20.2, 98.5, -20, 107.6, 3.9, 4.9, 'steel'),
  // 2층 앞면(허리 벽 + 위 띠), 칸막이, 지붕
  rect(-52, 93.8, -16, 94.2, 3.9, 4.9, 'plaster'),
  rect(-52, 93.8, -16, 94.2, 6.3, 7.2, 'plaster'),
  rect(-34.15, 98, -33.85, 107.6, 3.9, 7.2, 'plaster'),
  rect(SCHOOL.x0, SCHOOL.z0, SCHOOL.x1, SCHOOL.z1, 7.2, 7.5, 'concrete'),
  // 서쪽 바깥 계단(땅 → 3.75 계단참 → 옥상 7.5): 왼줄은 남쪽에서 북쪽으로, 오른줄은 다시 남쪽으로 오른다
  ramp(-55.6, 0, 102.5, 2.4, 3.75, 9, '-z', 'steel'),
  rect(-56.8, 95.6, -52, 98, 3.45, 3.75, 'steel'),
  ramp(-53.2, 3.75, 102.5, 2.4, 3.75, 9, '+z', 'steel'),
  rect(-56.8, 107, -52, 109.4, 7.2, 7.5, 'steel'),
  // 구령대
  rect(-38, 88.5, -30, 92, 0, 1.2, 'concrete')
].flat();

/* ---------------- 행정복지센터·빌라·마트 (E~F 6~8) ---------------- */

const center = [
  // 행정복지센터 1층 앞면(허리 벽, 문 둘, 위 띠), 뒷문, 양 끝 벽
  rect(10, 51.8, 14.8, 52.2, 0, 1, 'plaster'),
  rect(17.2, 51.8, 24.8, 52.2, 0, 1, 'plaster'),
  rect(27.2, 51.8, 32, 52.2, 0, 1, 'plaster'),
  rect(10, 51.8, 32, 52.2, 2.6, 3.6, 'plaster'),
  doorwayWall(10, 65.8, 32, 65.8, 7.2, 0.4, 'plaster', { at: 21, w: 2.2, top: 2.6 }),
  rect(10, 52.2, 10.4, 65.6, 0, 7.2, 'plaster'),
  rect(31.6, 52.2, 32, 65.6, 0, 7.2, 'plaster'),
  rect(14, 58, 22, 59, 0, 1.1, 'wood'),
  // 2층 바닥(동쪽에 계단 구멍), 경사로, 난간, 2층 앞면, 칸막이, 지붕
  rect(10.4, 52.2, 28, 65.6, 3.6, 3.9, 'concrete'),
  rect(28, 52.2, 31.6, 57, 3.6, 3.9, 'concrete'),
  ramp(29.8, 0, 61.3, 3.6, 3.9, 8.6, '-z', 'concrete'),
  rect(27.8, 57, 28, 65.6, 3.9, 4.9, 'steel'),
  rect(10, 51.8, 32, 52.2, 3.9, 4.9, 'plaster'),
  rect(10, 51.8, 32, 52.2, 6.3, 7.2, 'plaster'),
  rect(19.85, 57, 20.15, 65.6, 3.9, 7.2, 'plaster'),
  rect(10, 52, 32, 66, 7.2, 7.5, 'concrete'),
  // 편의점 '해솔마트 24'(북쪽 문)와 진열대
  ...hut(38, 52, 50, 62, 3.4, 'white', { n: 44 }, 'metal_dark', 2.4),
  rect(40, 55, 48, 55.6, 0, 1.6, 'wood'),
  rect(40, 58.5, 48, 59.1, 0, 1.6, 'wood'),
  // 빌라 둘(필로티), 경로당
  ...piloti(10, 76, 24, 88, 13.2, 'brick', false),
  ...piloti(32, 76, 46, 88, 13.2, 'brick', false),
  ...hut(10, 96, 24, 106, 3.2, 'brick', { n: 17 }, 'wood_dark')
].flat();

/* ---------------- 부두 (G~H 전체) ---------------- */

/** 안벽 크레인: 다리 넷(바다 쪽·육지 쪽), 문형 보 둘, 붐, 기계실. 아래에 내려놓은 컨테이너 하나 */
function gantry(zc) {
  const leg = (x, z) => rect(x - 0.6, z - 0.6, x + 0.6, z + 0.6, 0, 30, 'container_red');
  return [
    leg(99, zc - 8), leg(99, zc + 8), leg(110.5, zc - 8), leg(110.5, zc + 8),
    rect(98.4, zc - 8.6, 111.1, zc - 7.4, 24, 26, 'container_red'),
    rect(98.4, zc + 7.4, 111.1, zc + 8.6, 24, 26, 'container_red'),
    rect(84, zc - 2, 124, zc + 2, 30, 32.5, 'white'),
    rect(96, zc - 4, 104, zc + 4, 32.5, 36, 'white'),
    rect(101, zc - 6.1, 103.44, zc + 6.1, 0, 2.6, 'container_red')
  ];
}
const CRANES = [-50, 20];

// 야적장: 두 열(x 64.5 ~ 76.7, 81 ~ 93.2)에 컨테이너 더미. [더미 수(z로 2.44 m씩), 1열 단수, 2열 단수]. 단 0이면 빈 자리
const YARD_ROWS = [
  [3, 2, 1], [2, 3, 2], [3, 1, 0], [2, 2, 3], [1, 0, 2], [3, 3, 1], [2, 1, 2],
  [3, 2, 3], [2, 0, 1], [3, 3, 2], [2, 1, 3], [3, 2, 0], [2, 3, 1], [2, 1, 2]
];
const YARD_MATS = ['container_red', 'steel', 'rust', 'yellow', 'white'];
const YARD_COLS = [[64.5, 76.7], [81, 93.2]];
const CONTAINER_H = 2.6, CONTAINER_D = 2.44, YARD_AISLE = 4.2;
const yardStacks = [];
const yardTops = [];   // 1단 더미 윗면(전리품·경사로 자리)
{
  let z = -117;
  YARD_ROWS.forEach(([k, a, b], r) => {
    const d = k * CONTAINER_D;
    [a, b].forEach((levels, c) => {
      if (!levels) return;
      const [x0, x1] = YARD_COLS[c];
      yardStacks.push(rect(x0, z, x1, z + d, 0, levels * CONTAINER_H, YARD_MATS[(r * 2 + c) % YARD_MATS.length]));
      if (levels === 1) yardTops.push({ x0, x1, z0: z, z1: z + d, col: c });
    });
    z += d + YARD_AISLE;
  });
}
// 1단 더미 둘에 오르는 철판 경사로(서쪽 끝에서 +x로 오른다)
const climbable = [yardTops.find((t) => t.col === 0 && t.z0 > -100), yardTops.find((t) => t.col === 0 && t.z0 > 0)];
const yardRamps = climbable.map((t) => ramp(t.x0 - 3, 0, (t.z0 + t.z1) / 2, 6, CONTAINER_H, 2.2, '+x', 'steel'));

const port = [
  ...CRANES.flatMap(gantry),
  // 안벽 크레인 레일
  rect(98.8, -HALF, 99.2, HALF, 0, 0.05, 'steel'),
  rect(110.3, -HALF, 110.7, HALF, 0, 0.05, 'steel'),
  ...yardStacks, ...yardRamps,
  // 화물선 '해솔호'(바다에 떠 있고 갑판 위 컨테이너). 안벽 막이 때문에 건너갈 수 없다
  rect(114, -40, 124, 40, SEA_TOP, 6, 'rust'),
  rect(115, -30, 123, -8, 6, 11.2, 'steel'),
  rect(115, 4, 123, 30, 6, 8.6, 'container_red'),
  // 항만 운영동(계단식): 1층(북·남 문, 지붕 4 = 2층 테라스), 2층 사무동(북쪽 8 m, 윗면 7.6 = 3층 테라스), 3층 관제실(북쪽 4 m 유리, 옥상 10.6).
  // 서쪽 바깥 경사로로 2층 테라스(남쪽 난간 1 m — 넘어 뛰어내린다), 테라스 위 경사로로 3층 테라스, 배전함(1.5 m)을 밟고 턱 오르기로 옥상
  ...hut(66, 64, 80, 76, 3.6, 'white', { n: 73, s: 70 }, 'white', 2.4),
  rect(66, 64, 80, 72, 4, 7.6, 'white'),
  rect(66, 64, 80, 68, 7.6, 10.2, 'glass'),
  rect(65.8, 63.8, 80.2, 68.2, 10.2, 10.6, 'white'),
  rect(63.6, 76, 80, 77.6, 3.7, 4, 'white'),
  rect(63.6, 77.4, 80, 77.6, 4, 5, 'steel'),
  ramp(64.8, 0, 69.5, 2.4, 4, 9, '+z', 'steel'),
  rect(63.6, 74, 66, 76, 3.7, 4, 'steel'),
  ramp(73, 4, 73.2, 8, 3.6, 2.4, '-x', 'steel'),
  rect(76, 68, 78, 69.2, 7.6, 9.1, 'metal_dark'),
  rect(68, 66, 72, 67, 0, 1.1, 'wood'),
  // 보세창고 3동(높이 9): 북쪽 큰 셔터 둘, 서·동 쪽문, 안에 선반·팔레트·지게차
  doorwayWall(70, 86.2, 106, 86.2, 9, 0.4, 'steel', { at: [80, 96], w: 6, top: 5 }),
  rect(70, 117.6, 106, 118, 0, 9, 'steel'),
  doorwayWall(70.2, 86.4, 70.2, 117.6, 9, 0.4, 'steel', { at: 102, w: 3, top: 4 }),
  doorwayWall(105.8, 86.4, 105.8, 117.6, 9, 0.4, 'steel', { at: 100, w: 3, top: 4 }),
  rect(70, 86, 106, 118, 9, 9.4, 'metal_dark'),
  ...[95, 103, 111].flatMap((z) => [rect(74, z - 0.6, 86, z + 0.6, 0, 4.5, 'steel'), rect(90, z - 0.6, 102, z + 0.6, 0, 4.5, 'steel')]),
  rect(76, 89, 78, 91, 0, 1.4, 'wood'), rect(98, 89, 100, 91, 0, 1.4, 'wood'), rect(88, 114.5, 90.5, 116.5, 0, 1.4, 'wood'),
  rect(84, 97.5, 86.4, 100.5, 0, 2.2, 'yellow')
].flat();

/* ---------------- 길·탈것 ---------------- */

const roads = [
  // 대로 화단(낮은 엄폐물)
  ...[-95, -65, 85].map((z) => rect(-1.8, z - 5, -0.2, z + 5, 0, 0.7, 'stone')),
  // 트럭
  ...truck(3, -16, 'z', 'container_red'),
  ...truck(-4.5, 50, 'z', 'steel'),
  ...truck(-60, -37, 'x', 'yellow'),
  ...truck(30, 38.5, 'x', 'rust'),
  ...truck(57, -20, 'z', 'container_red'),
  ...truck(57, 50, 'z', 'steel'),
  ...truck(40, -43, 'x', 'white'),
  // 시내버스
  bus(-30, 33.5, 'x', 'yellow'), bus(2.5, 78, 'z', 'white'), bus(-50, -42.5, 'x', 'white'),
  // 승용차: 단지 마당, 언덕 주차장, 냉동창고 앞, 빌라 앞
  car(-100, -90, 'x'), car(-92, -90, 'x', 'steel'), car(-74, -90, 'x', 'container_red'), car(-66, -90, 'x'),
  car(-80, -24, 'z', 'steel'), car(-80, -12, 'z'), car(-80, 10, 'z', 'container_red'), car(-80, 22, 'z', 'metal_dark'),
  car(16, -58, 'z', 'white'), car(24, -58, 'z', 'steel'), car(36, -58, 'z', 'metal_dark'),
  car(30, 70, 'x', 'white'), car(38, 70, 'x', 'container_red'), car(46, 70, 'x', 'steel'),
  // 방호벽
  barrier(-10, -30, 'z'), barrier(8.5, -30, 'z'), barrier(-10, 26, 'z'), barrier(8.5, 26, 'z'), barrier(48, 44), barrier(48, -48),
  // 버스 정류장(유리 뒤판 + 지붕)
  rect(8.6, -33, 8.8, -27, 0, 2.6, 'glass'), rect(6.6, -33, 9, -27, 2.6, 2.8, 'metal_dark'),
  rect(-10.8, 23, -10.6, 29, 0, 2.6, 'glass'), rect(-11, 23, -8.6, 29, 2.6, 2.8, 'metal_dark')
];

/* ---------------- 빈 터 엄폐물 ---------------- */

/** 분리수거함(높이 1.4, 앉으면 가려진다) */
const bin = (x, z) => rect(x - 1.6, z - 0.9, x + 1.6, z + 0.9, 0, 1.4, 'metal_dark');
// 넓게 트인 마당·길가에 둔 경비실, 수거함, 트럭, 자재와 컨테이너
const cover = [
  ...hut(-112, -56, -106, -50, 2.8, 'plaster', { e: -53 }),
  bin(-100, -52), bin(-96, -52), bin(-70, -58), bin(-70, -54),
  car(-90, -50, 'z', 'steel'), car(-120, -48, 'z', 'white'),
  ...truck(12, -88, 'z', 'yellow'), ...truck(13, -72, 'z', 'steel'),
  rect(8, -118, 10.5, -115.5, 0, 1.4, 'wood'),
  barrier(-20, -48), barrier(14, -48),
  rect(48, -32, 50.5, -29.5, 0, 1.6, 'wood'), rect(51, -33, 53.4, -30.6, 0, 1.2, 'wood'),
  rect(45.5, -6, 47.94, 0.1, 0, CONTAINER_H, 'container_red'), rect(45.5, 8, 47.94, 14.1, 0, CONTAINER_H, 'steel'),
  rect(83, 64, 95.2, 66.44, 0, CONTAINER_H, 'yellow'), rect(84, 76, 86.44, 82.1, 0, CONTAINER_H * 2, 'rust'),
  rect(-120, 115, -114, 117, 0, 1.3, 'pipe')
];

/* ---------------- 방조제 (남쪽 끝) ---------------- */

const dike = [
  rect(-60, 114, 66, HALF, 0, 3, 'stone'),
  rect(-60, 124.6, 66, HALF, 3, 4, 'stone'),
  ramp(-64, 0, 119.5, 8, 3, 11, '+x', 'stone'),
  ramp(-7, 0, 110, 6, 3, 8, '+z', 'stone'),
  ramp(50, 0, 110, 6, 3, 8, '+z', 'stone')
];

/* ---------------- 장식 ---------------- */

const sign = (x, y, z, rotY, w, h, text, textEn, bg = '#1d3b6b', fg = '#ffffff') => ({ type: 'sign', x, y, z, rotY, w, h, text, textEn, bg, fg });
const tree = (x, z, h = 6, y = 0) => ({ type: 'tree', x, y, z, h, petals: false });

const decor = [
  // 아파트 동 번호(동쪽 벽 꼭대기)와 단지 이름
  sign(-87.94, 23, -108.5, R90, 5, 2.6, '101동', 'Bldg 101', '#f4f1e8', '#2b4c7e'),
  sign(-49.94, 23, -108.5, R90, 5, 2.6, '102동', 'Bldg 102', '#f4f1e8', '#2b4c7e'),
  sign(-88.2, 15.6, -78.5, R90, 4, 2, '103동', 'Bldg 103', '#f4f1e8', '#2b4c7e'),
  sign(-47.94, 13, -78.5, R90, 5, 2.6, '104동', 'Bldg 104', '#f4f1e8', '#2b4c7e'),
  sign(-102, 24, -114.21, R, 12, 2.2, '해솔마을 1단지', 'Haesol Village Complex 1', '#f4f1e8', '#1e6a3a'),
  sign(-55, 4.6, -51.74, 0, 10, 1, '해솔프라자 · 편의점 · 약국', 'Haesol Plaza · Mart · Pharmacy', '#c8352c'),
  // 차고지·위판장·냉동창고·주유소
  sign(-20.25, 4.9, -103.44, 0, 9, 0.9, '해솔 공영차고지', 'Haesol Bus Depot', '#1e6a3a'),
  sign(37, 6, -87.94, 0, 12, 1, '해솔 수산물 위판장', 'Haesol Fish Auction House', '#0b2545'),
  sign(32, 5, -80.06, R, 7, 0.9, '해솔 냉동창고', 'Haesol Cold Storage', '#0b2545'),
  sign(-13.94, 5.25, -67, R90, 9, 0.5, '해솔 셀프주유소', 'Haesol Self-Serve Gas', '#c8352c'),
  // 전통시장: 문 간판, 가게 간판
  sign(MARKET_X0 - 0.66, 6.4, 0, -R90, 9, 1, '해솔 전통시장', 'Haesol Market', '#a3201b', '#fff3e6'),
  sign(MARKET_X1 + 0.66, 6.4, 0, R90, 9, 1, '해솔 전통시장', 'Haesol Market', '#a3201b', '#fff3e6'),
  sign(-64.5, 4.6, -7.14, 0, 8, 1, '바다 건어물 · 갯벌 젓갈', 'Dried Seafood · Salted Fish', '#f2c14e', '#111111'),
  sign(-22.5, 4.6, -7.14, 0, 8, 1, '할매 국밥 · 손칼국수', 'Granny\'s Soup · Noodles', '#2b2d31'),
  sign(-64.5, 4.6, 7.14, R, 8, 1, '청과 상회 · 제철 과일', 'Greengrocer · Fresh Fruit', '#1e6a3a'),
  sign(-22.5, 4.6, 7.14, R, 8, 1, '서해 횟집 · 활어 직판', 'West Sea Sashimi · Live Fish', '#0b2545'),
  // 홍보관·학교·행정복지센터·마트
  sign(30, 6.4, 12.06, 0, 12, 1.2, '해솔 신도시 홍보관', 'Haesol New Town Showroom', '#f4f1e8', '#1d3b6b'),
  sign(-34, 6.75, 93.74, R, 10, 0.8, '해솔초등학교', 'Haesol Elementary School', '#f4f1e8', '#1e6a3a'),
  sign(21, 6.75, 51.74, R, 11, 0.8, '해솔동 행정복지센터', 'Haesol Community Center', '#f4f1e8', '#1d3b6b'),
  sign(44, 3.1, 51.74, R, 6, 0.6, '해솔마트 24', 'Haesol Mart 24', '#1e6a3a'),
  // 부두
  sign(73, 6, 63.74, R, 8, 1, '해솔항 운영동', 'Haesol Port Office', '#0b2545'),
  sign(88, 7, 85.94, R, 10, 1.2, '보세창고 3동', 'Bonded Warehouse 3', '#2b2d31', '#f2c14e'),
  sign(113.94, 3, 0, -R90, 14, 2, '해솔호', 'HAESOL', '#2b2d31'),
  // 공사현장·방조제·언덕
  sign(-110, 1.6, 45.84, R, 12, 1.4, '해솔 3블록 신축 공사 · 안전제일', 'Haesol Block 3 Construction · Safety First', '#e2b21a', '#1d1d1b'),
  sign(0, 4, 113.94, R, 10, 1, '해솔 방조제 산책로', 'Haesol Seawall Promenade', '#1e6a3a'),
  sign(-91.94, 1.6, 6, R90, 6, 0.8, '솔바람 언덕공원', 'Solbaram Hill Park', '#1e6a3a'),

  // 시장 골목 현수막과 좌판 위 상자
  { type: 'banner', x: -53, y: 5.2, z: 0, rotY: R90, w: 1.2, h: 2.6, text: '오늘 특가', textEn: 'Today\'s Deal', bg: '#a3201b', fg: '#fff3e6' },
  { type: 'banner', x: -35, y: 5.2, z: 0, rotY: -R90, w: 1.2, h: 2.6, text: '신선 수산', textEn: 'Fresh Fish', bg: '#1d3b6b', fg: '#ffffff' },
  { type: 'banner', x: -44, y: 6.2, z: -4.6, rotY: 0, w: 4, h: 0.9, text: '제철 과일 · 건어물', textEn: 'Seasonal Fruit · Dried Fish', bg: '#f2c14e', fg: '#111111' },
  { type: 'banner', x: -110, y: 2.2, z: 46.3, rotY: 0, w: 4, h: 0.9, text: '안전제일', textEn: 'Safety First', bg: '#e2b21a', fg: '#1d1d1b' },
  ...[[-70, -5.7], [-44, -5.7], [-22, -5.7], [-60, 5.7], [-29, 5.7], [-16, 5.7]].map(([x, z], i) => ({ type: 'crateStack', x, y: 1, z, rotY: i * 0.3, size: 0.6, levels: 1 })),
  { type: 'crateStack', x: -96, y: 4, z: 64, rotY: 0.2, size: 0.9, levels: 2 },
  { type: 'crateStack', x: 108, y: 0, z: -90, rotY: 0, size: 1.1, levels: 2 },

  // 조명(실제 조명 넷): 시장 아케이드, 홍보관, 보세창고, 학교 복도
  { type: 'light', x: -43, y: 6.4, z: 0, color: '#ffe2b0', intensity: 1.4, dist: 30 },
  { type: 'light', x: 30, y: 7.4, z: 0, color: '#f2f6ff', intensity: 1.3, dist: 26 },
  { type: 'light', x: 88, y: 8.6, z: 102, color: '#ffd59a', intensity: 1.5, dist: 30 },
  { type: 'light', x: -34, y: 3.2, z: 96, color: '#f2f6ff', intensity: 1.0, dist: 22 },

  // 안벽 크레인 와이어
  ...CRANES.flatMap((zc) => [
    { type: 'pipe', from: [104.5, 30, zc - 1], to: [104.5, 3.2, zc - 1], r: 0.05, mat: 'steel' },
    { type: 'pipe', from: [104.5, 30, zc + 1], to: [104.5, 3.2, zc + 1], r: 0.05, mat: 'steel' }
  ]),
  // 비계 기둥(골조 동쪽)
  ...[57, 62, 67, 72].map((z) => ({ type: 'pipe', from: [-85, 0, z], to: [-85, 13, z], r: 0.05, mat: 'steel' })),
  // 운동장 축구 골대 둘
  ...[56, 84].flatMap((z) => [
    { type: 'pipe', from: [-38, 0, z], to: [-38, 2.2, z], r: 0.06, mat: 'white' },
    { type: 'pipe', from: [-30, 0, z], to: [-30, 2.2, z], r: 0.06, mat: 'white' },
    { type: 'pipe', from: [-38, 2.2, z], to: [-30, 2.2, z], r: 0.06, mat: 'white' }
  ]),
  // 방조제 가로등
  ...[-40, -10, 20, 50].map((x) => ({ type: 'pipe', from: [x, 3, 124], to: [x, 7, 124], r: 0.07, mat: 'steel' })),

  // 나무: 언덕, 단지, 대로 화단, 공원
  tree(-120, -26, 6.5, 2.45), tree(-96, -26, 6, 2.45), tree(-120, 26, 7, 2.45), tree(-95, 27, 6, 2.45), tree(-114, 12, 5.5, 4.85), tree(-104, -14, 6, 4.85),
  tree(-118.5, -24, 5.5, 2.45), tree(-97, -16, 6, 2.45),
  tree(-112, -96, 5.5, 0.03), tree(-86, -98, 6, 0.03), tree(-58, -97, 5.5, 0.03), tree(-48, -88, 6, 0.03),
  tree(-1, -95, 5, 0.7), tree(-1, -65, 5, 0.7), tree(-1, 85, 5, 0.7),
  tree(36, 100, 6), tree(44, 98, 5.5), tree(40, 104, 6),
  tree(12, -26, 5, 0.03), tree(48, 26, 5, 0.03)
];

/* ---------------- 소품 ---------------- */

const props = [
  { type: 'barrel', x: 96, y: 0.03, z: -30 },
  { type: 'barrel', x: 95.6, y: 0.03, z: 46 },
  { type: 'crate', x: -82, y: 0.03, z: 58, size: 1 },
  { type: 'crate', x: -66, y: 0, z: 100, size: 0.9 },
  { type: 'barrel', x: -34, y: 0, z: -58 },
  { type: 'crate', x: 60, y: 0, z: -96, size: 1 }
];

/* ---------------- 배틀로얄 칸 ---------------- */

// 시작 자리 30곳: 가장자리와 큰길을 따라 고르게, 모두 바깥 바닥이다. [x, z, 바닥 y]. 부두 콘크리트·단지 잔디·모래 위는 바닥 판 높이(0.03)
const PATCH = 0.03;
const START = [
  [-120, -95, 0], [-83, -119, 0], [-45, -119, 0], [-20, -122, 0], [12, -105, 0], [60, -110, 0], [96, -121, PATCH], [96, -80, PATCH],
  [57, -62, 0], [-56, -96, PATCH], [-95, -42, 0], [-30, -40, 0], [20, -40, 0], [96, -15, PATCH], [57, 10, 0], [-77, 0, 0],
  [-120, 42, 0], [-45, 36, 0], [2, 20, 0], [20, 33, 0], [88, 60, PATCH], [60, 84, 0], [-60, 60, 0], [-100, 85, PATCH],
  [-35, 70, PATCH], [2, 100, 0], [30, 110, 0], [109, 70, PATCH], [-2, 58, 0], [-118, 118, 0]
];

// 1단 컨테이너 위(경사로로 오르는 곳)
const yardTop = climbable[0];
const LOOT = [
  // 아파트: 필로티 1층, 103동 옥상·계단참, 상가, 놀이터
  loot(-110, 0, -108.5), loot(-94, 0, -108.5), loot(-72, 0, -108.5), loot(-56, 0, -108.5),
  loot(-110, 0, -78.5), loot(-94, 0, -78.5), loot(-70, 0, -78.5), loot(-54, 0, -78.5),
  loot(-108, T103.top, -78.5, 'rare'), loot(-96, T103.top, -77, 'rare'), loot(-85.6, 6.6, -83.2),
  loot(-60, 0, -58), loot(-50, 0, -57), loot(-103, 0.03, -95),
  loot(-100, 6.6, -85.1), loot(-96, 9.9, -71.9),
  // 차고지·위판장·냉동창고·주유소·주차장
  loot(-23, 0, -92), loot(-20.1, 0, -110), loot(-29, 0, -100),
  loot(28, 0, -105), loot(46, 0, -105, 'rare'), loot(28, 0, -93), loot(46, 0, -93),
  loot(32, 0, -77.8), loot(30, 0, -73), loot(36, 0, -68),
  loot(-35, 0, -70), loot(-23, 0, -66), loot(26, 0, -55),
  // 전통시장: 가게 안, 골목, 아케이드 한가운데(희귀)
  loot(-69, 0, -11.5), loot(-60, 0, -11.5), loot(-28, 0, -11.5), loot(-17, 0, -11.5),
  loot(-69, 0, 11.5), loot(-60, 0, 11.5), loot(-28, 0, 11.5), loot(-17, 0, 11.5),
  loot(-53, 0.03, 0, 'rare'), loot(-35, 0.03, 0, 'rare'), loot(-44, 0.03, -2, 'rare'),
  loot(-53, 0, -12), loot(-35, 0, 12),
  loot(-64, MARKET_2F, -12.5), loot(-22, MARKET_2F, 12.5),
  // 홍보관(희귀가 몰린 한가운데)과 광장
  loot(20, 0.03, -8, 'rare'), loot(40, 0.03, -8, 'rare'), loot(30, 0.03, 8, 'rare'), loot(23, 0.03, 1), loot(39, 0.03, 4, 'rare'),
  loot(33, 1, -1, 'rare'), loot(24, 4, -8, 'rare'), loot(38, 4, -7, 'rare'),
  loot(36, 0.03, 20), loot(14, 0.03, -18, 'rare'),
  // 언덕공원·주차장
  loot(-109, 5.1, -1, 'rare'), loot(-104, 4.85, 10), loot(-116, 2.45, -24), loot(-96, 2.45, 24), loot(-118, 2.45, 22), loot(-80, 0, -6),
  // 공사현장: 골조 층마다, 3층(희귀), 터파기, 사무실, 자재 마당
  loot(-110, 0.03, 62), loot(-96, 0.03, 72), loot(-108, 4, 64), loot(-95, 4, 72), loot(-110, 8, 70), loot(-96, 8, 60),
  loot(-112, 12, 63, 'rare'), loot(-96, 12, 61, 'rare'),
  loot(-104, SEA_TOP + 0.2, 106, 'rare'), loot(-94, SEA_TOP + 0.2, 104),
  loot(-77, 0.03, 53), loot(-70, 0, 100), loot(-76, 0, 112),
  // 초등학교: 교실, 복도, 2층, 구령대, 운동장
  loot(-46, 0, 103), loot(-34, 0, 103), loot(-24, 0, 104), loot(-40, 0, 96),
  loot(-46, 3.9, 101), loot(-30, 3.9, 101, 'rare'), loot(-24, 3.9, 96), loot(-34, 1.2, 90.2), loot(-50, 0.03, 60),
  loot(-40, 7.5, 101, 'rare'),
  // 행정복지센터·마트·빌라·경로당
  loot(14, 0, 62), loot(26, 0, 60), loot(16, 3.9, 60), loot(24, 3.9, 62, 'rare'),
  loot(44, 0, 57), loot(44, 0, 60.5), loot(12.5, 0, 82), loot(34.5, 0, 82), loot(17, 0, 101),
  // 부두: 크레인 아래(희귀), 야적장 골목, 1단 컨테이너 위(희귀), 운영동, 보세창고, 안벽
  loot(106, 0.05, CRANES[0], 'rare'), loot(106, 0.05, CRANES[1], 'rare'),
  loot(78.85, 0.03, -100), loot(78.85, 0.03, -60), loot(78.85, 0.03, -20), loot(78.85, 0.03, 20), loot(78.85, 0.03, 50),
  loot((yardTop.x0 + yardTop.x1) / 2, CONTAINER_H, (yardTop.z0 + yardTop.z1) / 2, 'rare'),
  loot(70, 0, 70), loot(76, 0, 72), loot(72, 7.6, 70, 'rare'), loot(70, 4, 74.9),
  loot(78, 0.03, 92), loot(94, 0.03, 99, 'rare'), loot(98, 0.03, 115), loot(74, 0.03, 110), loot(95.8, 0.03, 40),
  // 방조제·길가
  loot(0, 3, 119.5), loot(-40, 3, 119.5), loot(40, 3, 119.5, 'rare'),
  loot(7.7, 0.03, -30), loot(-30, 0, 37), loot(57, 0, -28),
  loot(-1, 0.02, 36, 'rare'), loot(-1, 0.02, -40, 'rare')
];

const people = START.map(([x, z, y]) => ({ x, y, z, rotY: look(x, z, 0, 0) }));

export default {
  id: 'harbortown',
  name: '서해 항만 신도시',
  nameEn: 'West Sea Harbor Town',
  desc: '서해 매립지의 250 m 신도시. 컨테이너 부두, 아파트 단지, 전통시장, 홍보관, 공사현장, 초등학교를 돌며 무기를 줍고 봉쇄되는 구역을 피해 마지막까지 살아남는다.',
  descEn: 'A 250 m new town on reclaimed West Sea land. Sweep the container docks, apartment blocks, traditional market, showroom, construction site and elementary school for weapons, dodge the sealing sectors and be the last one alive.',
  tag: '배틀로얄 전용', tagEn: 'Battle Royale Only',
  size: { x: HALF * 2, z: HALF * 2 },
  rulesets: ['classic'],
  modes: ['br'],
  theme: {
    sky: '#c3d6e0', skyTop: '#4f7fa8', fog: [90, 330], sunDir: [0.42, 0.78, -0.46],
    sunColor: '#fff0d6', ambient: 0.56, water: '#4b6e70', ground: 'asphalt'
  },
  // 팀 스폰 칸은 검사기와 16인방 보조 자리용으로 시작 자리를 반씩 나눠 쓴다. 개인전 후보는 두 팀 스폰을 합친 것이라 ffa는 비운다(같은 자리가 두 번 들지 않게).
  // 이 맵은 배틀로얄 목록에만 나온다
  spawns: {
    owner: people.filter((_, i) => i % 2 === 0),
    charterer: people.filter((_, i) => i % 2 === 1),
    ffa: []
  },
  br: {
    grid: GRID,
    loot: LOOT,
    spawns: START.map(([x, z, y]) => [x, y, z])
  },
  solids: [
    ...ground, ...apartments, ...depot, ...fishMarket, ...coldStore, ...gasStation,
    ...market, ...hall, ...plaza, ...hill, ...frame, ...site, ...school, ...center, ...port, ...roads, ...cover, ...dike
  ].flat(),
  decor,
  pads: [],
  portals: [],
  secrets: [],
  props,
  movers: []
};
