/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 좀비 물량 막기 전용 맵 '고속도로 휴게소'(Highway Rest Stop). 문 닫은 밤 휴게소의 편의점 앞에서 시작해,
 *          고속도로 갓길·화장실·정비 마당·숲길 여섯 곳에서 몰려오는 좀비를 막는다. 편의점 옥상은 바깥 계단 하나로만 오른다.
 */
import { box, cyl, wall, stairs, doorwayWall, clipAbove } from './kit.js';

// 방위: 북 = -z(고속도로), 남 = +z(숲). 사람은 편의점 앞(z -2)에서 남쪽을 보고 시작한다.
//
//  z -24 ┌ 갓길 ─ [G1] ───────────────── 고속도로 갓길 ──────────────────── [G2] ┐
//  z -19 ├ 방음벽 ━━━━┥틈┝━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┥틈┝━━━━━━━┤
//        │ 화장실 [G3]   │  계단 ▤ ┌──── 편의점(옥상 4 m) ────┐   트레일러 ▬▬▬▬▬▬▬ │
//  z  -9 │  └문 ▏가림벽  │       ▤ │ 진열대   진열대   계산대 문│              ┌──┤
//  z  -5 │               │         └─ 창 ── 문 ── 창 ───────────┘   정비 마당 │G4│
//  z  -2 │                     사람 스폰 ▫▫▫▫▫▫ (차양 아래)                   틈 │
//  z   3 │  ┌── 주유소 캐노피(높이 5.2) ──┐                주차장 ▭ ▭   ▭ ▭     └──┤
//  z   8 │  │  주유기 ▣▣    주유기 ▣▣      │                     ▭   ▭   ▭          │
//  z  13 │  └─────────────────────────────┘          ▬▬▬ 관광버스 ▬▬▬             │
//  z  21 ├ 생울타리 ━━━━━┥틈┝━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┥틈┝━━━━━━━━━━━━━━┤
//  z  24 └ [G5] 숲길 ──────────────────────────────────────────── 숲길 [G6] ─────┘
//
//  좀비 문(G1~G6)은 모두 벽·울타리·가림벽 뒤라 시작 자리에서 바로 보이지 않는다. 좀비는 문에서 나와 가장 가까운 사람에게 몰려온다.
//  편의점은 앞문·옆문·뒷문이 있어 안팎을 돌 수 있고, 옥상은 서쪽 바깥 계단(폭 2.1 m) 하나로만 올라 지키기 좋은 대신 막히면 끝이다.

/* ---------------- 치수 ---------------- */

const HALF_X = 32;
const HALF_Z = 24;
const STORE = { x0: -10, x1: 10, z0: -15, z1: -5 };   // 편의점 바깥 테두리
const WALL_T = 0.3;
const STORE_H = 3.7;     // 벽 높이 = 옥상 슬래브 밑면
const ROOF = 4;          // 옥상 바닥
const PARAPET = 0.8;     // 옥상 난간 높이
const NOISE_Z = -19.15;  // 방음벽 중심선
const NOISE_H = 4.5;
const HEDGE_Z = 20.9;    // 생울타리 중심선
const CANOPY_Y = 5.2;    // 주유소 캐노피 밑면

const R = Math.PI;
const rect = (x0, z0, x1, z1, y0, y1, mat) => box((x0 + x1) / 2, y0, (z0 + z1) / 2, x1 - x0, y1 - y0, z1 - z0, mat);
/** 카메라가 (x,z)에서 (tx,tz)를 보는 rotY */
const look = (x, z, tx, tz) => Math.atan2(-(tx - x), -(tz - z));

/* ---------------- 편의점 ---------------- */

const FRONT_Z0 = STORE.z1 - WALL_T, FRONT_Z1 = STORE.z1;
const store = [
  // 뒷벽(북): 뒷문 하나. 서쪽 벽은 막혀 있고 바깥에 옥상 계단이 붙는다. 동쪽 벽에 옆문
  doorwayWall(STORE.x0, STORE.z0 + WALL_T / 2, STORE.x1, STORE.z0 + WALL_T / 2, STORE_H, WALL_T, 'plaster', { at: 5, w: 1.8, top: 2.4 }),
  wall(STORE.x0 + WALL_T / 2, STORE.z0 + WALL_T, STORE.x0 + WALL_T / 2, STORE.z1 - WALL_T, STORE_H, WALL_T, 'plaster'),
  doorwayWall(STORE.x1 - WALL_T / 2, STORE.z0 + WALL_T, STORE.x1 - WALL_T / 2, STORE.z1 - WALL_T, STORE_H, WALL_T, 'plaster', { at: -10, w: 2, top: 2.5 }),
  // 앞벽(남): 깨진 큰 창 둘(턱 1 m)과 가운데 출입문(폭 3.6 m)
  rect(-10, FRONT_Z0, -8.5, FRONT_Z1, 0, STORE_H, 'plaster'),
  rect(-8.5, FRONT_Z0, -3.5, FRONT_Z1, 0, 1, 'plaster'),
  rect(-8.5, FRONT_Z0, -3.5, FRONT_Z1, 2.6, STORE_H, 'plaster'),
  rect(-3.5, FRONT_Z0, -1.8, FRONT_Z1, 0, STORE_H, 'plaster'),
  rect(-1.8, FRONT_Z0, 1.8, FRONT_Z1, 2.8, STORE_H, 'plaster'),
  rect(1.8, FRONT_Z0, 3.5, FRONT_Z1, 0, STORE_H, 'plaster'),
  rect(3.5, FRONT_Z0, 8.5, FRONT_Z1, 0, 1, 'plaster'),
  rect(3.5, FRONT_Z0, 8.5, FRONT_Z1, 2.6, STORE_H, 'plaster'),
  rect(8.5, FRONT_Z0, 10, FRONT_Z1, 0, STORE_H, 'plaster'),
  // 옥상 슬래브와 난간. 서쪽 난간은 계단 꼭대기(z -15 ~ -13)에서 끊긴다
  rect(STORE.x0, STORE.z0, STORE.x1, STORE.z1, STORE_H, ROOF, 'concrete'),
  rect(STORE.x0, STORE.z0, STORE.x1, STORE.z0 + 0.2, ROOF, ROOF + PARAPET, 'concrete'),
  rect(STORE.x0, STORE.z1 - 0.2, STORE.x1, STORE.z1, ROOF, ROOF + PARAPET, 'concrete'),
  rect(STORE.x1 - 0.2, STORE.z0 + 0.2, STORE.x1, STORE.z1 - 0.2, ROOF, ROOF + PARAPET, 'concrete'),
  rect(STORE.x0, -13, STORE.x0 + 0.2, STORE.z1 - 0.2, ROOF, ROOF + PARAPET, 'concrete'),
  // 옥상 냉방기(앉으면 가려진다)
  rect(3, -12.5, 6, -10.5, ROOF, ROOF + 1.2, 'steel'),
  rect(-5, -9, -3, -7.5, ROOF, ROOF + 1, 'steel'),
  // 앞 차양(출입문 위). 사람 스폰이 이 아래다
  rect(-10, STORE.z1, 10, -3.4, 3.2, 3.4, 'metal_dark'),
  // 안: 진열대 넷(높이 1.6), 계산대, 뒤쪽 냉장고 줄
  rect(-7.5, -11.6, -1.5, -11, 0, 1.6, 'wood'),
  rect(1.5, -11.6, 6.5, -11, 0, 1.6, 'wood'),
  rect(-7.5, -8.4, -1.5, -7.8, 0, 1.6, 'wood'),
  rect(1.5, -8.4, 4.5, -7.8, 0, 1.6, 'wood'),
  rect(6.2, -7.2, 9.2, -6.4, 0, 1.1, 'metal_dark'),
  rect(-9.7, -14.7, -1, -14.1, 0, 2.2, 'glass')
].flat();

// 옥상 바깥 계단(서쪽 벽에 붙임): z -6에서 올라 z -13의 계단참(높이 4 m)에서 옥상으로 들어간다
const roofStairs = [
  stairs(-11.05, 0, -9.5, 2.1, ROOF, 7, '-z', 'steel'),
  rect(-12.1, -15, -10, -13, 0, ROOF, 'concrete')
].flat();

/* ---------------- 화장실(서쪽) · 좀비 문 G3 ---------------- */

const restroom = [
  doorwayWall(-25.65, -14, -25.65, -4, 3.2, WALL_T, 'tile', { at: -9, w: 2, top: 2.4 }),
  wall(-31, -13.85, -25.5, -13.85, 3.2, WALL_T, 'tile'),
  wall(-31, -4.15, -25.5, -4.15, 3.2, WALL_T, 'tile'),
  wall(-30.85, -13.7, -30.85, -4.3, 3.2, WALL_T, 'tile'),
  rect(-31, -14, -25.5, -4, 3.2, 3.45, 'concrete'),
  rect(-30.7, -12.5, -30.1, -10.5, 0, 0.9, 'white'),
  // 입구 앞 가림벽: 화장실 안이 바깥에서 바로 보이지 않는다. 문과의 틈은 2.2 m(좀비 무리가 빠져나올 폭)
  rect(-23.3, -11, -23, -7, 0, 2.3, 'tile')
].flat();

/* ---------------- 방음벽(북) · 갓길 · 좀비 문 G1·G2 ---------------- */

const noiseWall = [
  rect(-HALF_X, NOISE_Z - 0.15, -27, NOISE_Z + 0.15, 0, NOISE_H, 'concrete'),
  rect(-24, NOISE_Z - 0.15, 24, NOISE_Z + 0.15, 0, NOISE_H, 'concrete'),
  rect(27, NOISE_Z - 0.15, HALF_X, NOISE_Z + 0.15, 0, NOISE_H, 'concrete')
];
const shoulder = [
  // 갓길에 버려진 승용차(앉으면 가려진다)
  rect(-17, -22.9, -12.8, -21.1, 0, 0.9, 'container_red'),
  rect(-16, -22.8, -13.8, -21.2, 0.9, 1.45, 'glass'),
  rect(8, -23.2, 12.2, -21.4, 0, 0.9, 'white'),
  rect(9, -23.1, 11.2, -21.5, 0.9, 1.45, 'glass')
];

/* ---------------- 북동: 트레일러 · 뒷골목 ---------------- */

const northEast = [
  rect(13, -15.5, 27, -12.9, 0, 3.9, 'container_red'),
  rect(27, -15.3, 30, -13.1, 0, 3.2, 'white'),
  // 편의점 뒷골목 쓰레기 컨테이너
  rect(-6, -18.6, -3.6, -17.3, 0, 1.4, 'steel'),
  rect(2, -18.6, 4.4, -17.3, 0, 1.4, 'steel')
];

/* ---------------- 정비 마당(동) · 좀비 문 G4 ---------------- */

const yard = [
  // 서쪽 울타리: 가운데 틈(z -1.5 ~ 1.5)으로만 드나든다
  rect(25.85, -9, 26.15, -1.5, 0, 2.6, 'rust'),
  rect(25.85, 1.5, 26.15, 7, 0, 2.6, 'rust'),
  rect(26.15, -9, HALF_X, -8.7, 0, 2.6, 'rust'),
  rect(26.15, 6.7, HALF_X, 7, 0, 2.6, 'rust'),
  // 마당 안 기름통 더미
  cyl(30.4, 0, -6.8, 0.6, 1.2, 'tank'),
  cyl(30.4, 0, -5.3, 0.6, 1.2, 'tank')
];

/* ---------------- 주유소(남서) ---------------- */

const station = [
  // 캐노피: 기둥 넷과 지붕(높이 5.2). 지붕 위는 막이로 덮어 올라서지 못하게 한다
  ...[[-25.5, 4.5], [-13.5, 4.5], [-25.5, 11.5], [-13.5, 11.5]].map(([x, z]) => rect(x - 0.35, z - 0.35, x + 0.35, z + 0.35, 0, CANOPY_Y, 'white')),
  rect(-27, 3, -12, 13, CANOPY_Y, CANOPY_Y + 0.4, 'white'),
  rect(-27, 3, -12, 13, CANOPY_Y + 0.4, CANOPY_Y + 4.4, 'clip'),
  // 주유기 섬 둘(턱 0.25)과 주유기 넷(높이 1.7)
  rect(-24, 7.4, -20, 8.6, 0, 0.25, 'concrete'),
  rect(-18, 7.4, -14, 8.6, 0, 0.25, 'concrete'),
  ...[-23.2, -20.8, -17.2, -14.8].map((x) => rect(x - 0.4, 7.7, x + 0.4, 8.3, 0.25, 1.7, 'yellow')),
  // 계산 부스(서쪽 끝)
  rect(-30.6, 6, -28.2, 10, 0, 2.6, 'plaster'),
  rect(-30.8, 5.8, -28, 10.2, 2.6, 2.8, 'metal_dark')
];

/* ---------------- 주차장(남동) ---------------- */

/** 남북으로 세운 승용차: 차체(0.9 m)와 유리 지붕(1.45 m) */
const car = (x, z, mat) => [
  rect(x - 0.95, z - 2.1, x + 0.95, z + 2.1, 0, 0.9, mat),
  rect(x - 0.85, z - 1.1, x + 0.85, z + 0.9, 0.9, 1.45, 'glass')
];
const parking = [
  car(11.5, 7, 'white'), car(14.7, 7, 'container_red'), car(21, 7, 'steel'), car(24.2, 7, 'white'),
  car(13.2, 13.4, 'steel'), car(19.4, 13.4, 'white'), car(25.6, 13.4, 'container_red'),
  // 관광버스(몸을 다 가린다)
  rect(8.5, 16.9, 21, 19.3, 0, 3.1, 'white'),
  rect(8.5, 16.85, 21, 16.95, 1.4, 2.4, 'glass')
].flat();

/* ---------------- 앞마당 · 생울타리(남) · 좀비 문 G5·G6 ---------------- */

const front = [
  // 피크닉 탁자(앉으면 가려진다)
  rect(-8.2, 1, -5.6, 2.2, 0, 0.75, 'wood'),
  rect(5.6, 1, 8.2, 2.2, 0, 0.75, 'wood'),
  // 자판기 셋(차양 기둥 옆)
  rect(-14.5, -4.6, -13.6, -3.4, 0, 1.9, 'container_red'),
  rect(-13.4, -4.6, -12.5, -3.4, 0, 1.9, 'white'),
  rect(12.5, -4.6, 13.4, -3.4, 0, 1.9, 'container_red')
];
const hedge = [
  rect(-HALF_X, HEDGE_Z - 0.35, -22.5, HEDGE_Z + 0.35, 0, 1.9, 'moss'),
  rect(-19.5, HEDGE_Z - 0.35, 19.5, HEDGE_Z + 0.35, 0, 1.9, 'moss'),
  rect(22.5, HEDGE_Z - 0.35, HALF_X, HEDGE_Z + 0.35, 0, 1.9, 'moss')
];

/* ---------------- 맵 밖 경치 ---------------- */

const scenery = [
  // 고속도로 너머 방음벽과 표지판 기둥
  rect(-60, -34, 60, -33.5, 0, 6, 'concrete'),
  rect(-2, -29.5, -1.6, -29.1, 0, 7.5, 'steel'),
  rect(1.6, -29.5, 2, -29.1, 0, 7.5, 'steel'),
  rect(-4.5, -29.6, 4.5, -29, 5.5, 7.8, 'metal_dark'),
  // 숲 너머 낮은 언덕
  rect(-60, 34, 60, 50, 0, 3.5, 'moss')
];

/* ---------------- 장식 ---------------- */

const decor = [
  // 간판과 표지
  { type: 'sign', x: 0, y: ROOF + 0.4, z: STORE.z1 + 0.06, rotY: 0, w: 7.5, h: 0.9, text: '행복 휴게소 · 편의점 24시', bg: '#1d3b6b', fg: '#f4f1e8' },
  { type: 'sign', x: -19.5, y: CANOPY_Y + 0.2, z: 13.06, rotY: 0, w: 5.2, h: 0.5, text: '셀프 주유소', bg: '#c8352c', fg: '#ffffff' },
  { type: 'sign', x: -25.35, y: 2.75, z: -11.8, rotY: Math.PI / 2, w: 1.6, h: 0.45, text: '화장실', bg: '#2b4c7e', fg: '#ffffff' },
  { type: 'banner', x: 0, y: 2.4, z: NOISE_Z + 0.2, rotY: 0, w: 6, h: 1.1, text: '대피 완료 · 출입 통제', bg: '#a3201b', fg: '#fff3e6' },
  { type: 'banner', x: 26.1 - 0.17, y: 1.7, z: 4.3, rotY: -Math.PI / 2, w: 2.2, h: 0.9, text: '정비 구역', bg: '#e2b21a', fg: '#1d1d1b' },
  { type: 'sign', x: 0, y: 7.1, z: -29.62, rotY: 0, w: 8.4, h: 1.6, text: '서울 42 km · 대전 98 km', bg: '#1e6a3a', fg: '#ffffff' },
  // 조명(실제 조명 넷: 출입문, 주유소 캐노피, 주차장, 뒷골목)
  { type: 'light', x: 0, y: 3.05, z: -3.9, color: '#fff1d6', intensity: 1.6, dist: 16 },
  { type: 'light', x: -19.5, y: 4.9, z: 8, color: '#e8f4ff', intensity: 2.2, dist: 22 },
  { type: 'light', x: 17.5, y: 6.4, z: 10, color: '#ffb35c', intensity: 1.8, dist: 22 },
  { type: 'light', x: -1, y: 4.2, z: -17, color: '#ffc27a', intensity: 1.1, dist: 14 },
  // 주차장 가로등 기둥
  { type: 'pipe', from: [17.5, 0, 10], to: [17.5, 6.5, 10], r: 0.08, mat: 'steel' },
  { type: 'pipe', from: [-1, 0, -18.8], to: [-1, 4.3, -18.8], r: 0.06, mat: 'steel' },
  // 옥상 계단 난간
  { type: 'pipe', from: [-12.05, 1.1, -6], to: [-12.05, 5.1, -13], r: 0.04, mat: 'yellow' },
  // 구석 상자 더미
  { type: 'crateStack', x: 30.6, z: 1.2, rotY: 0.2, size: 0.9, levels: 2 },
  { type: 'crateStack', x: -29, z: 17.5, rotY: -0.3, size: 0.8, levels: 2 },
  // 숲(맵 밖)
  ...[-26, -18, -10, -2, 6, 14, 22, 30].map((x, i) => ({ type: 'tree', x, z: 27 + (i % 2) * 2.5, h: 6.5 + (i % 3), petals: false }))
];

/* ---------------- 스폰 ---------------- */

// 사람: 편의점 앞 차양 아래 여섯 자리. 남쪽(주유소·주차장 쪽)을 본다
const people = [-6.25, -3.75, -1.25, 1.25, 3.75, 6.25].map((x) => ({ x, z: -2.2, rotY: R }));

// 좀비 문: 벽·울타리 뒤의 여섯 자리. 문에서 가장 가까운 열린 쪽을 본다
const GATES = [
  { id: 'shoulder_w', name: '고속도로 서쪽 갓길', x: -29.5, z: -21.7, rotY: look(-29.5, -21.7, -25.5, -17) },
  { id: 'shoulder_e', name: '고속도로 동쪽 갓길', x: 29.5, z: -21.7, rotY: look(29.5, -21.7, 25.5, -17) },
  { id: 'restroom', name: '화장실', x: -28.5, z: -7, rotY: look(-28.5, -7, -24, -9) },
  { id: 'yard', name: '정비 마당', x: 29.5, z: 4.5, rotY: look(29.5, 4.5, 26, 0) },
  { id: 'forest_w', name: '서쪽 숲길', x: -26, z: 22.6, rotY: look(-26, 22.6, -21, 20) },
  { id: 'forest_e', name: '동쪽 숲길', x: 26, z: 22.6, rotY: look(26, 22.6, 21, 20) }
];

/* ---------------- 소품 ---------------- */

const props = [
  { type: 'barrel', x: -11.2, y: 0, z: 9.5 },
  { type: 'barrel', x: -27.3, y: 0, z: 12.2 },
  { type: 'crate', x: 6.2, y: 0, z: -17.6, size: 0.8 },
  { type: 'crate', x: 28.6, y: 0, z: -3.2 }
];

export default {
  id: 'restarea',
  name: '고속도로 휴게소',
  nameEn: 'Highway Rest Stop',
  desc: '문 닫은 밤 휴게소. 편의점 앞에서 시작해 갓길·화장실·정비 마당·숲길로 몰려오는 좀비를 막는다. 옥상은 바깥 계단 하나로만 오른다.',
  tag: '좀비 전용',
  size: { x: HALF_X * 2, z: HALF_Z * 2 },
  rulesets: ['classic'],
  modes: ['zombie'],
  horde: { gates: GATES },
  theme: {
    sky: '#2a3354', skyTop: '#090e1f', fog: [26, 100], sunDir: [-0.3, 0.78, -0.42],
    sunColor: '#a7b9ee', sunIntensity: 0.5, ambient: 0.82, ground: 'asphalt'
  },
  spawns: {
    owner: people,
    charterer: GATES.map(({ x, z, rotY }) => ({ x, z, rotY })),
    ffa: []
  },
  solids: [
    ...store, ...roofStairs, ...restroom, ...noiseWall, ...clipAbove(noiseWall, 6), ...shoulder,
    ...northEast, ...yard, ...station, ...parking, ...front, ...hedge, ...scenery
  ],
  decor,
  pads: [],
  portals: [],
  secrets: [],
  props,
  movers: []
};
