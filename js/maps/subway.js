/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 좀비 물량 막기 전용 맵 '지하철 환승역'(Transfer Station). 천장이 덮인 지하 승강장 한가운데에서 시작해,
 *          양 끝 터널 넷과 남북 환승 통로 둘에서 몰려오는 좀비를 막는다. 선로는 0.4 m 낮아 걸어서 오르내린다.
 */
import { box, wall, doorwayWall } from './kit.js';

// 방위: 북 = -z, 남 = +z. 사람은 섬식 승강장 가운데(z 0 근처)에서 시작한다.
//
//  z -18        ┌─ 북쪽 환승 통로 [GN] ───┐
//  z -14 ┌──────┴───────────── 북벽 ──┤틈├──────────────────────────────┐
//        │  북쪽 옆 승강장(폭 3.5 m) · 매점 · 의자                         │
//  z -10 │═[GT1]══════════ 북쪽 선로(0.4 m 낮음) ═══════════════[GT2]═│ ← 양 끝 터널
//  z  -5 │  기둥 ▪   ▪   ▪   ▪          ▪   ▪   ▪   ▪   기계실 ▉       │
//  z   0 │ ▉ 기계실   신문 가판대   사람 스폰 ▫▫▫▫  자판기         ▉     │  섬식 승강장(폭 11 m)
//  z   5 │  기둥 ▪   ▪   ▪   ▪          ▪   ▪   ▪   ▪                 │
//  z  10 │═[GT3]══════════ 남쪽 선로 ════════════════════════════[GT4]═│
//        │  남쪽 옆 승강장 · 의자                                       │
//  z  14 └──────────────────────────┤틈├──────────── 남벽 ─────┬──────┘
//  z  18                            └──── 남쪽 환승 통로 [GS] ──┘
//
//  터널 입구는 선로 폭 안에서 한쪽으로 치우친 2.5 m 틈이고, 좀비는 그 뒤 굴 속(벽 너머)에서 나온다. 환승 통로도 ㄱ자로 꺾여
//  시작 자리에서 좀비 문이 바로 보이지 않는다. 선로는 0.4 m 낮아 어디서든 걸어서 오르내리고, 기둥과 기계실이 엄폐다.

/* ---------------- 치수 ---------------- */

const HALF_X = 33;
const HALF_Z = 18;
const HALL_X = 30;       // 역사 벽 중심선의 x(양 끝)
const HALL_Z = 14;       // 역사 벽 중심선의 z(남북)
const T = 0.3;           // 벽 두께
const CEIL = 4.6;        // 역사 천장 밑면
const TRACK_IN = 5.5;    // 선로 안쪽 가장자리(승강장 끝)
const TRACK_OUT = 10.5;  // 선로 바깥 가장자리(옆 승강장 시작)
const TRACK_Y = -0.4;    // 선로 바닥
const POCKET_CEIL = 3.4; // 터널 굴·환승 통로 천장 밑면

const rect = (x0, z0, x1, z1, y0, y1, mat) => box((x0 + x1) / 2, y0, (z0 + z1) / 2, x1 - x0, y1 - y0, z1 - z0, mat);
const look = (x, z, tx, tz) => Math.atan2(-(tx - x), -(tz - z));

/* ---------------- 역사 벽 · 천장 ---------------- */

// 터널 입구: 선로 폭 안에서 승강장 반대쪽(바깥)으로 치우친 2.5 m 틈. 굴 속 좀비 문은 승강장 쪽 벽 뒤에 선다
const TUNNEL_AT = [-(TRACK_OUT - 1.5), TRACK_OUT - 1.5];   // 북·남 선로의 틈 가운데(z)
const shell = [
  doorwayWall(-HALL_X, -HALL_Z - T / 2, HALL_X, -HALL_Z - T / 2, CEIL, T, 'tile', { at: 0, w: 3, top: 3.2 }),
  doorwayWall(-HALL_X, HALL_Z + T / 2, HALL_X, HALL_Z + T / 2, CEIL, T, 'tile', { at: 0, w: 3, top: 3.2 }),
  doorwayWall(-HALL_X - T / 2, -HALL_Z - T, -HALL_X - T / 2, HALL_Z + T, CEIL, T, 'tile', { at: TUNNEL_AT, w: 2.5, top: 3.2 }),
  doorwayWall(HALL_X + T / 2, -HALL_Z - T, HALL_X + T / 2, HALL_Z + T, CEIL, T, 'tile', { at: TUNNEL_AT, w: 2.5, top: 3.2 }),
  rect(-HALL_X - T, -HALL_Z - T, HALL_X + T, HALL_Z + T, CEIL, CEIL + 0.4, 'concrete')
].flat();

/* ---------------- 선로(0.4 m 낮은 바닥이 땅을 도려낸다) ---------------- */

const tracks = [
  rect(-HALF_X, -TRACK_OUT, HALF_X, -TRACK_IN, TRACK_Y - 0.3, TRACK_Y, 'stone'),
  rect(-HALF_X, TRACK_IN, HALF_X, TRACK_OUT, TRACK_Y - 0.3, TRACK_Y, 'stone')
];

/* ---------------- 터널 굴(양 끝 넷) · 좀비 문 GT1~GT4 ---------------- */

/**
 * 역사 벽 바깥(x: 역사 벽 바깥면 ~ 맵 끝)의 굴. 선로 z0~z1을 남북 벽으로 두르고 맵 끝을 막고 천장을 덮는다. 바닥은 선로가 이어진다.
 * east = true면 동쪽 끝(x 30.3 ~ 33), 아니면 서쪽 끝(x -33 ~ -30.3)
 */
const pocket = (east, z0, z1) => {
  const xa = east ? HALL_X + T : -HALF_X, xb = east ? HALF_X : -HALL_X - T;
  const endA = east ? HALF_X - T : -HALF_X, endB = east ? HALF_X : -HALF_X + T;
  return [
    rect(xa, z0 - T, xb, z0, TRACK_Y, POCKET_CEIL, 'concrete'),
    rect(xa, z1, xb, z1 + T, TRACK_Y, POCKET_CEIL, 'concrete'),
    rect(endA, z0, endB, z1, TRACK_Y, POCKET_CEIL, 'concrete'),
    rect(xa, z0 - T, xb, z1 + T, POCKET_CEIL, POCKET_CEIL + 0.3, 'concrete')
  ];
};
const tunnels = [
  pocket(true, -TRACK_OUT, -TRACK_IN), pocket(true, TRACK_IN, TRACK_OUT),
  pocket(false, -TRACK_OUT, -TRACK_IN), pocket(false, TRACK_IN, TRACK_OUT)
].flat();

/* ---------------- 환승 통로(남북 ㄱ자) · 좀비 문 GN·GS ---------------- */

const WALL_OUT = HALL_Z + T;   // 남북 역사 벽의 바깥면(|z|)
// 북쪽: 벽 틈(x -1.5 ~ 1.5)으로 나가 서쪽으로 꺾인 통로(안쪽 x -13.2 ~ 1.5, z -17.7 ~ -14.3)
const transferN = [
  rect(-13.5, -HALF_Z, 1.8, -HALF_Z + T, 0, POCKET_CEIL, 'tile'),       // 바깥 벽(맵 끝)
  rect(-13.5, -HALF_Z, -13.2, -WALL_OUT, 0, POCKET_CEIL, 'tile'),        // 막다른 서쪽 끝
  rect(1.5, -HALF_Z, 1.8, -WALL_OUT, 0, POCKET_CEIL, 'tile'),            // 틈 동쪽 옆 벽
  rect(-13.5, -HALF_Z, 1.8, -WALL_OUT, POCKET_CEIL, POCKET_CEIL + 0.3, 'concrete')
];
// 남쪽: 북쪽을 거울처럼 동쪽으로 꺾었다(안쪽 x -1.5 ~ 13.2, z 14.3 ~ 17.7)
const transferS = [
  rect(-1.8, HALF_Z - T, 13.5, HALF_Z, 0, POCKET_CEIL, 'tile'),
  rect(13.2, WALL_OUT, 13.5, HALF_Z, 0, POCKET_CEIL, 'tile'),
  rect(-1.8, WALL_OUT, -1.5, HALF_Z, 0, POCKET_CEIL, 'tile'),
  rect(-1.8, WALL_OUT, 13.5, HALF_Z, POCKET_CEIL, POCKET_CEIL + 0.3, 'concrete')
];
const transfers = [...transferN, ...transferS];

/* ---------------- 섬식 승강장 ---------------- */

const PILLAR_X = [-24, -18, -12, -6, 6, 12, 18, 24];
const island = [
  // 기둥 두 줄(천장까지)
  ...PILLAR_X.flatMap((x) => [-2.9, 2.9].map((z) => rect(x - 0.45, z - 0.45, x + 0.45, z + 0.45, 0, CEIL, 'tile'))),
  // 양 끝 기계실(천장까지, 몸을 다 가린다)
  rect(-29.7, -2.6, -26.5, 2.6, 0, CEIL, 'metal_dark'),
  rect(26.5, -2.6, 29.7, 2.6, 0, CEIL, 'metal_dark'),
  // 신문 가판대와 자판기 줄
  rect(-10, -0.9, -7.6, 0.9, 0, 2.3, 'wood_dark'),
  rect(7.6, -0.6, 8.5, 0.6, 0, 1.9, 'container_red'),
  rect(8.6, -0.6, 9.5, 0.6, 0, 1.9, 'white'),
  // 의자(앉으면 가려진다)
  ...[-21, -15, 15, 21].map((x) => rect(x - 1.1, -0.35, x + 1.1, 0.35, 0, 0.5, 'steel'))
];

/* ---------------- 옆 승강장(남북 벽 쪽) ---------------- */

const sides = [
  // 북쪽: 문 닫은 매점, 의자 둘
  rect(-19, -13.8, -13, -11.6, 0, 2.8, 'wood_dark'),
  rect(-19.2, -13.85, -12.8, -11.4, 2.8, 3, 'container_red'),
  rect(8, -13.6, 10.4, -12.9, 0, 0.5, 'steel'),
  rect(18, -13.6, 20.4, -12.9, 0, 0.5, 'steel'),
  // 남쪽: 물품 보관함 줄, 의자 둘
  rect(13, 11.6, 19, 13.8, 0, 2.2, 'steel'),
  rect(-10.4, 12.9, -8, 13.6, 0, 0.5, 'steel'),
  rect(-20.4, 12.9, -18, 13.6, 0, 0.5, 'steel')
];

/* ---------------- 장식 ---------------- */

const yLine = 0.02;
const decor = [
  // 선로 레일(충돌 없는 관)
  ...[-1, 1].flatMap((s) => [-0.75, 0.75].map((o) => ({ type: 'pipe', from: [-HALF_X, TRACK_Y + 0.07, s * 8 + o], to: [HALF_X, TRACK_Y + 0.07, s * 8 + o], r: 0.05, mat: 'steel' }))),
  // 역 이름판과 안내
  { type: 'sign', x: -15, y: 3.3, z: -HALL_Z + 0.06, rotY: 0, w: 6, h: 0.9, text: '한빛 환승역 · Hanbit', bg: '#1f5f9e', fg: '#ffffff' },
  { type: 'sign', x: 15, y: 3.3, z: HALL_Z - 0.06, rotY: Math.PI, w: 6, h: 0.9, text: '한빛 환승역 · Hanbit', bg: '#1f5f9e', fg: '#ffffff' },
  { type: 'sign', x: 0, y: 3.55, z: -HALL_Z + 0.06, rotY: 0, w: 3, h: 0.5, text: '2호선 환승 ↑', bg: '#2f9b3c', fg: '#ffffff' },
  { type: 'sign', x: 0, y: 3.55, z: HALL_Z - 0.06, rotY: Math.PI, w: 3, h: 0.5, text: '7호선 환승 ↓', bg: '#6b6b25', fg: '#ffffff' },
  { type: 'banner', x: -26.45, y: 2.2, z: 0, rotY: Math.PI / 2, w: 2.6, h: 1, text: '운행 중단', bg: '#a3201b', fg: '#fff3e6' },
  { type: 'banner', x: 26.45, y: 2.2, z: 0, rotY: -Math.PI / 2, w: 2.6, h: 1, text: '관계자 외 출입 금지', bg: '#e2b21a', fg: '#1d1d1b' },
  { type: 'sign', x: 8, y: 1.6, z: -HALL_Z + 0.06, rotY: 0, w: 2.6, h: 1.6, text: '노선도', bg: '#f2f2ee', fg: '#20323f' },
  { type: 'sign', x: -8, y: 1.6, z: HALL_Z - 0.06, rotY: Math.PI, w: 2.6, h: 1.6, text: '노선도', bg: '#f2f2ee', fg: '#20323f' },
  // 조명(실제 조명 넷) — 천장 형광등 줄은 빛나는 띠로
  ...[-18, -6, 6, 18].map((x) => ({ type: 'light', x, y: CEIL - 0.3, z: 0, color: '#e9f3ff', intensity: 1.5, dist: 18 })),
  ...[-2.9, 2.9].map((z) => ({ type: 'pipe', from: [-26, CEIL - 0.08, z * 1.6], to: [26, CEIL - 0.08, z * 1.6], r: 0.06, mat: 'neon_cyan' }))
];

/* ---------------- 바닥 안전선(얇은 노란 띠) ---------------- */

const lines = [
  rect(-HALL_X, -TRACK_IN, HALL_X, -TRACK_IN + 0.3, 0, yLine, 'yellow'),
  rect(-HALL_X, TRACK_IN - 0.3, HALL_X, TRACK_IN, 0, yLine, 'yellow')
];

/* ---------------- 스폰 ---------------- */

// 사람: 승강장 가운데 여섯 자리. 양 끝 터널 쪽을 나눠 본다
const people = [
  { x: -4.5, z: -0.7, rotY: Math.PI / 2 }, { x: -1.5, z: -0.7, rotY: Math.PI / 2 },
  { x: 1.5, z: -0.7, rotY: -Math.PI / 2 }, { x: 4.5, z: -0.7, rotY: -Math.PI / 2 },
  { x: -3, z: 0.9, rotY: Math.PI / 2 }, { x: 3, z: 0.9, rotY: -Math.PI / 2 }
];

// 좀비 문: 굴 넷(승강장 쪽 벽 뒤, 선로 바닥)과 환승 통로 둘(꺾인 끝)
const GATES = [
  { id: 'tunnel_nw', name: '북쪽 선로 서쪽 터널', x: -31.8, z: -TRACK_IN - 0.8, rotY: look(-31.8, -6.3, -31.8, -9) },
  { id: 'tunnel_ne', name: '북쪽 선로 동쪽 터널', x: 31.8, z: -TRACK_IN - 0.8, rotY: look(31.8, -6.3, 31.8, -9) },
  { id: 'tunnel_sw', name: '남쪽 선로 서쪽 터널', x: -31.8, z: TRACK_IN + 0.8, rotY: look(-31.8, 6.3, -31.8, 9) },
  { id: 'tunnel_se', name: '남쪽 선로 동쪽 터널', x: 31.8, z: TRACK_IN + 0.8, rotY: look(31.8, 6.3, 31.8, 9) },
  { id: 'transfer_n', name: '북쪽 환승 통로', x: -12.2, z: -16.2, rotY: look(-12.2, -16.2, 0, -16.2) },
  { id: 'transfer_s', name: '남쪽 환승 통로', x: 12.2, z: 16.2, rotY: look(12.2, 16.2, 0, 16.2) }
];

/* ---------------- 소품 ---------------- */

const props = [
  { type: 'crate', x: -22.5, y: 0, z: -12.6, size: 0.8 },
  { type: 'barrel', x: 22.6, y: 0, z: 12.6 },
  { type: 'crate', x: 4.5, y: 0, z: 12.8 }
];

export default {
  id: 'subway',
  name: '지하철 환승역',
  nameEn: 'Transfer Station',
  desc: '운행이 끊긴 지하 환승역. 섬식 승강장 한가운데에서 시작해 양 끝 터널과 남북 환승 통로로 몰려오는 좀비를 막는다. 선로는 0.4 m 낮다.',
  tag: '좀비 전용',
  size: { x: HALF_X * 2, z: HALF_Z * 2 },
  rulesets: ['classic'],
  modes: ['zombie'],
  horde: { gates: GATES },
  theme: {
    // 천장이 덮여 하늘과 해는 보이지 않는다. 하늘색은 실내 간접광 색으로만 쓰인다
    sky: '#3a4254', skyTop: '#a7b3c6', fog: [30, 110], sunDir: [0.15, 0.95, 0.2],
    sunColor: '#d4def0', sunIntensity: 0.4, ambient: 1.2, ground: 'tile'
  },
  spawns: {
    owner: people,
    charterer: GATES.map(({ x, z, rotY }) => ({ x, z, rotY })),
    ffa: []
  },
  solids: [...shell, ...tracks, ...tunnels, ...transfers, ...island, ...sides, ...lines],
  decor,
  pads: [],
  portals: [],
  secrets: [],
  props,
  movers: []
};
