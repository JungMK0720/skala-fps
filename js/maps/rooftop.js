/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 칼전 전용 맵 '빨랫줄 옥상'. 밤의 아파트 옥상(22×24 m)에서 계단실, 가운데 옥탑방, 창고, 장독대, 평상, 빨랫줄 사이를 돌며 칼로 겨루는 좁은 맵이다.
 */
/*
 * 방위: 북 = -z(블루), 남 = +z(오렌지). 북쪽 절반을 적고 rotate180으로 남쪽을 만든다.
 *
 *   x -11            -3.2  0  3.2            11
 *   z -12 ┌──────────────── 난간 ────────────────┐
 *         │ 서쪽 칸(스폰) │실외기│ 계단실 │ 동쪽 칸(스폰) │
 *   z -8  │ 창고 ─────┘     앞마당(빨랫줄)     └── 보일러실 │
 *   z -4  │ 장독대(0.6)      ┌─ 옥탑방 ─┐         평상 │
 *   z  0  │ 서쪽 길    서문 │ 소파·냉장고 │ 동문   물탱크 │
 *   z  4  │ 평상            └──────────┘   장독대(0.6) │
 *         └ … 남쪽은 원점 기준 180° 돌린 복사본 … ┘
 *
 * 동선: 칸 → 앞마당 → 옥탑방을 끼고 서쪽 길·동쪽 길 → 적 앞마당. 옥탑방은 서문·동문으로 가로지른다.
 * 창고와 보일러실이 길마다 어긋나게 서 있어 양쪽 스폰이 서로 보이지 않는다. 이불은 눈만 가리고 몸은 지나간다.
 * 비밀: 서쪽 칸의 실외기 둘을 밟고 북쪽 계단실 지붕(비둘기장)에 오른다. 돌리지 않아 보상은 한 번이다.
 * 바닥은 theme.ground 'none'(y = 0 무한 평면)이고, 보이는 옥상 바닥·건물 몸통·이웃 건물을 solid로 세운다.
 */
import { box, cyl, pillar, ramp, clipAbove, rotate180 } from './kit.js';

const PI = Math.PI;
const PAR = 1.1;      // 난간 높이
const SH = 2.9;       // 계단실 벽 높이
const SH_TOP = 3.04;  // 계단실 지붕 윗면
const ROOM_H = 2.7;   // 옥탑방 벽 높이
const LINE_Y = 2.45;  // 빨랫줄 높이

/** 카메라가 (x,z)에서 (tx,tz)를 보는 rotY */
const look = (x, z, tx, tz) => Math.atan2(-(tx - x), -(tz - z));
const spot = (x, z, tx, tz) => ({ x, z, rotY: look(x, z, tx, tz) });

/* ---------------- 건물 몸통과 바닥 ---------------- */

const building = [
  box(0, -0.25, 0, 22, 0.25, 24, 'deck'),
  box(0, -26, 0, 22, 25.75, 24, 'plaster'),
  box(0, -27, 0, 300, 1, 300, 'asphalt')
];

/* ---------------- 절반: 난간 ---------------- */

const parapets = [
  box(0, 0, -11.85, 22, PAR, 0.3, 'plaster'),
  box(-10.85, 0, -6, 0.3, PAR, 12, 'plaster'),
  box(10.85, 0, -6, 0.3, PAR, 12, 'plaster')
];
const caps = [
  box(0, PAR, -11.85, 22.1, 0.08, 0.42, 'concrete'),
  box(-10.85, PAR, -6, 0.42, 0.08, 12, 'concrete'),
  box(10.85, PAR, -6, 0.42, 0.08, 12, 'concrete')
];

/* ---------------- 절반: 계단실과 실외기 계단 ---------------- */

const stairHouse = [
  box(0, 0, -10.2, 5.2, SH, 3, 'plaster'),
  box(0, SH, -10.2, 5.5, SH_TOP - SH, 3.3, 'concrete'),
  box(1.3, 0, -8.66, 1.1, 2.15, 0.1, 'metal_dark'),
  box(1.3, 2.35, -8.35, 1.7, 0.08, 0.75, 'metal_dark'),
  cyl(-1.35, SH_TOP, -10.3, 0.85, 1.35, 'tank'),
  // 비둘기장
  box(1.7, SH_TOP, -11.15, 1.4, 0.8, 0.8, 'wood'),
  ramp(1.7, SH_TOP + 0.8, -11.15, 1.6, 0.25, 1, '-z', 'rust'),
  // 실외기 계단: 땅 → 1.05 → 2.0 → 지붕 3.04
  box(-3.15, 0, -11.05, 1, 1.05, 1.1, 'white'),
  box(-3.15, 0, -9.85, 1, 1, 1.1, 'metal_dark'),
  box(-3.15, 1, -9.85, 1, 1, 1.1, 'white')
];

/* ---------------- 절반: 창고, 보일러실, 장독대, 평상, 물탱크 ---------------- */

const shed = [
  box(-8.45, 0, -6.6, 4.5, 2.3, 2, 'steel'),
  ramp(-8.45, 2.3, -6.6, 4.7, 0.3, 2.2, '-z', 'rust')
];
const boiler = [
  box(6.5, 0, -6.6, 4.2, 2.4, 2, 'brick'),
  box(6.5, 2.4, -6.6, 4.4, 0.12, 2.2, 'concrete'),
  cyl(7.7, 2.52, -6.9, 0.18, 1.5, 'metal_dark')
];

/** 장독 하나: 배가 부른 몸통, 좁은 어깨, 뚜껑 */
const jar = (x, y, z, r, h) => [
  cyl(x, y, z, r, h * 0.72, 'rust'),
  cyl(x, y + h * 0.72, z, r * 0.78, h * 0.2, 'rust'),
  cyl(x, y + h * 0.92, z, r * 0.62, h * 0.08, 'metal_dark')
];

/** 장독대: 돌 단(0.6)과 계단 한 칸, 위에 장독 */
const terrace = [
  box(-8.95, 0, -2.7, 3.5, 0.6, 3.4, 'stone'),
  box(-6.95, 0, -2.7, 0.5, 0.3, 2, 'stone'),
  ...[[-10, -3.9, 0.42, 0.95], [-8.9, -3.95, 0.36, 0.8], [-7.85, -3.85, 0.3, 0.65], [-9.95, -2.6, 0.38, 0.85],
    [-10, -1.45, 0.32, 0.7], [-8.75, -1.5, 0.4, 0.9]].flatMap(([x, z, r, h]) => jar(x, 0.6, z, r, h))
];

/** 평상: 걸어 오르는 나무 단(0.45)과 낮은 상 */
const bench = [
  box(8.2, 0, -3.7, 2.8, 0.45, 1.8, 'wood'),
  box(8.2, 0.45, -3.7, 1, 0.3, 0.7, 'wood_dark')
];

/** 동쪽 길 물탱크: 낮은 받침(0.3) 위 둥근 기둥. 돌면서 쫓고 쫓긴다 */
const tank = [
  box(6.2, 0, -1.3, 1.9, 0.3, 1.9, 'concrete'),
  cyl(6.2, 0.3, -1.3, 0.8, 1.75, 'tank')
];

/** 앞마당: 스티로폼 텃밭, 벽돌 더미, 옥탑방 모퉁이 실외기, 빨랫줄 기둥 */
const yard = [
  box(-1.2, 0, -5.4, 2.2, 0.55, 0.65, 'white'),
  box(-1.2, 0.55, -5.4, 2, 0.12, 0.5, 'moss'),
  box(2.6, 0, -6.6, 1.2, 1, 1, 'brick'),
  box(-2.4, 0, -2.6, 1, 0.95, 0.7, 'white'),
  pillar(-5.7, -4.4, LINE_Y + 0.1, 0.12, 'steel'),
  pillar(3.9, -4.4, LINE_Y + 0.1, 0.12, 'steel'),
  pillar(-10.45, -0.9, LINE_Y + 0.1, 0.12, 'steel'),
  pillar(10.45, -9, LINE_Y + 0.1, 0.12, 'steel')
];

/* ---------------- 가운데: 옥탑방 (절반을 적고 돌린다) ---------------- */

const roomHalf = [
  // 북쪽 벽: 눈높이보다 높은 창 하나
  box(-2.55, 0, -2.075, 1.3, ROOM_H, 0.25, 'plaster'),
  box(-1.2, 0, -2.075, 1.4, 1.65, 0.25, 'plaster'),
  box(-1.2, 2.25, -2.075, 1.4, ROOM_H - 2.25, 0.25, 'plaster'),
  box(1.35, 0, -2.075, 3.7, ROOM_H, 0.25, 'plaster'),
  // 서쪽 벽: 문(z -1.8 ~ 0)
  box(-3.075, 0, -1.95, 0.25, ROOM_H, 0.3, 'plaster'),
  box(-3.075, 2.3, -0.9, 0.25, ROOM_H - 2.3, 1.8, 'plaster'),
  box(-3.075, 0, 1.1, 0.25, ROOM_H, 2.2, 'plaster'),
  // 소파와 냉장고
  box(0.7, 0, -1.55, 2.2, 0.5, 0.8, 'container_red'),
  box(2.55, 0, -1.6, 0.7, 1.8, 0.7, 'white')
];
const roomRoof = [
  box(0, ROOM_H, 0, 6.8, 0.15, 4.8, 'rust'),
  cyl(0.9, ROOM_H + 0.15, 0.3, 1, 1.6, 'tank')
];

/* ---------------- 이웃 건물 (플레이 영역 밖, 절반) ---------------- */

/** 창 한 칸: lit이면 창호지처럼 빛나고 아니면 어두운 유리 */
const win = (x, y, z, alongX, lit, w = 0.9, h = 1.1) => box(x, y, z, alongX ? w : 0.08, h, alongX ? 0.08 : w, lit ? 'paper' : 'metal_dark');
const grid = (xs, ys, at, alongX, pattern) => xs.flatMap((u, i) => ys.map((y, j) => (alongX ? win(u, y, at, true, pattern(i, j)) : win(at, y, u, false, pattern(i, j)))));

const neighbors = [
  // 북쪽: 3 m 낮은 옆 동 옥상
  box(-4, -26, -27, 20, 23, 12, 'concrete'),
  box(-9, -3, -24, 2.4, 1, 1.6, 'white'),
  box(1, -3, -28, 3.5, 2.4, 3, 'plaster'),
  ...grid([-12, -8, -4, 0, 4], [-6.5, -10], -20.96, true, (i, j) => (i + j) % 3 !== 1),
  // 북동쪽: 6 m 높은 벽돌 건물
  box(24, -26, -22, 14, 32, 12, 'brick'),
  ...grid([18.5, 21, 23.5, 26, 28.5], [-3, 0.3, 3.6], -15.96, true, (i, j) => (i * 2 + j) % 4 !== 0),
  // 동쪽: 2 m 높은 상가, 서쪽 벽에 창
  box(23, -26, 2, 10, 28, 16, 'plaster'),
  ...grid([-4, -1, 2, 5, 8], [-4.5, -1.5], 17.96, false, (i, j) => (i + j * 2) % 3 !== 2),
  // 먼 아파트
  box(40, -26, -48, 16, 56, 14, 'tile'),
  ...grid([33.5, 36.5, 39.5, 42.5, 45.5], [6, 10, 14, 18, 22], -40.96, true, (i, j) => (i * 3 + j) % 5 > 1)
];

const half = [...parapets, ...caps, ...stairHouse, ...shed, ...boiler, ...terrace, ...bench, ...tank, ...yard, ...roomHalf, ...neighbors];
const lidsHalf = clipAbove([...caps, shed[1], boiler[1]], 8);
const lidsCenter = clipAbove(roomRoof[0], 8);

/* ---------------- 스폰 ---------------- */

const owner = [
  spot(-5.2, -10.3, -4.6, -6),
  spot(-8.3, -9.6, -5.5, -7.4),
  spot(4.9, -10.3, 3.2, -6),
  spot(8.3, -10.4, 9.6, -5)
];
const ffaHalf = [
  spot(-9.2, -10.6, -6, -8.5),
  spot(9.6, -8, 9.6, -3),
  spot(-5.4, -3.6, -5.4, 2),
  spot(-1.6, 0.6, 1.5, 0.4)
];

/* ---------------- 장식 ---------------- */

const WARM = '#ffcf7a', ROSE = '#ff8fb0';
const SHEETS = ['#f4f1e8', '#bcd8f0', '#f7c9d6', '#f5e3a4', '#d5ecc4'];

/** 빨랫줄 하나와 거기 넌 이불·수건. sheets = [줄 위 위치(0~1), 폭, 길이, 바탕색, 무늬] */
function clothesline(from, to, sheets, sag = 0.18) {
  const out = [{ type: 'rope', from, to, sag, r: 0.012, mat: 'steel' }];
  const dx = to[0] - from[0], dz = to[2] - from[2];
  const rot = Math.atan2(-dz, dx);
  for (const [f, w, h, bg, emblem] of sheets) {
    const y = from[1] + (to[1] - from[1]) * f - 4 * sag * f * (1 - f);
    out.push({ type: 'banner', x: from[0] + dx * f, y: y - h / 2, z: from[2] + dz * f, rotY: rot, w, h, bg, fg: '#ffffff', emblem });
  }
  return out;
}

/** 줄에 매단 작은 전구들 */
function bulbs(from, to, n, sag, color = WARM) {
  const out = [{ type: 'rope', from, to, sag, r: 0.01, mat: 'metal_dark' }];
  for (let i = 1; i <= n; i++) {
    const f = i / (n + 1);
    const y = from[1] + (to[1] - from[1]) * f - 4 * sag * f * (1 - f);
    out.push({ type: 'lantern', x: from[0] + (to[0] - from[0]) * f, y: y - 0.14, z: from[2] + (to[2] - from[2]) * f, r: 0.09, cord: 0.04, color: i % 3 ? color : ROSE });
  }
  return out;
}

const decorHalf = [
  // 빨랫줄: 앞마당, 서쪽 길, 동쪽 칸
  ...clothesline([-5.7, LINE_Y, -4.4], [3.9, LINE_Y, -4.4], [
    [0.16, 1.5, 1.45, SHEETS[0], 'diamond'], [0.36, 1.2, 1.2, SHEETS[1], 'circle'], [0.62, 1.6, 1.5, SHEETS[2], 'blossom'], [0.84, 1, 0.9, SHEETS[3], 'ring']
  ]),
  ...clothesline([-10.45, LINE_Y, -0.9], [-3.22, LINE_Y, -0.9], [[0.28, 1.3, 1.3, SHEETS[4], 'ring'], [0.68, 1.4, 1.35, SHEETS[1], 'diamond']]),
  ...clothesline([2.62, LINE_Y, -9], [10.45, LINE_Y, -9], [[0.25, 1.4, 1.3, SHEETS[3], 'circle'], [0.55, 1.2, 1.1, SHEETS[0], 'blossom']], 0.15),
  // 전구 줄: 계단실 지붕에서 보일러실로, 창고에서 옥탑방으로
  ...bulbs([2.75, 3.1, -8.6], [6.6, 2.55, -5.5], 6, 0.3),
  ...bulbs([-6.2, 2.4, -5.6], [-3.2, 2.8, -2.2], 5, 0.25),
  // 실외기 팬 망
  { type: 'vent', x: -3.15, y: 0.52, z: -10.48, rotY: PI / 2, w: 0.8, h: 0.7, d: 0.1, mat: 'metal_dark' },
  { type: 'vent', x: -3.15, y: 1.5, z: -9.28, rotY: 0, w: 0.8, h: 0.7, d: 0.1, mat: 'metal_dark' },
  { type: 'vent', x: -2.4, y: 0.48, z: -2.94, rotY: PI, w: 0.75, h: 0.65, d: 0.08, mat: 'metal_dark' },
  // 보일러실 배관과 안테나
  { type: 'pipe', from: [4.3, 0.3, -5.55], to: [4.3, 2.1, -5.55], r: 0.07, mat: 'pipe' },
  { type: 'pipe', from: [4.3, 2.1, -5.55], to: [8.6, 2.1, -5.55], r: 0.07, mat: 'pipe' },
  { type: 'pipe', from: [5.2, 0, -5.52], to: [5.2, 1.4, -5.52], r: 0.05, mat: 'yellow' },
  { type: 'pipe', from: [5.4, 2.52, -6.2], to: [5.4, 4.4, -6.2], r: 0.03, mat: 'steel' },
  { type: 'pipe', from: [5, 4.1, -6.2], to: [5.8, 4.1, -6.2], r: 0.02, mat: 'steel' },
  // 창고 벽 등 받침, 옥탑방 안 등
  { type: 'pipe', from: [-8.45, 2.22, -5.6], to: [-8.45, 2.22, -5.3], r: 0.03, mat: 'steel' },
  { type: 'lantern', x: -1, y: 2.25, z: -0.6, r: 0.16, cord: 0.3, color: WARM },
  // 상자 더미
  { type: 'crateStack', x: -10.1, z: -8.3, rotY: 0.2, size: 0.7, levels: 2, mat: 'wood' },
  // 이웃 옥상의 물탱크와 전구
  { type: 'pipe', from: [-9, -3, -27], to: [-9, -0.6, -27], r: 1.1, mat: 'tank' },
  ...bulbs([-13, -1.2, -21.3], [5, -1.4, -21.3], 9, 0.5)
];

const decor = [
  // 실제 조명 넷: 계단실 차양 밑과 창고 벽 등, 그 복사본
  { type: 'light', x: 1.3, y: 2.1, z: -8.35, color: '#ffd59a', intensity: 1.1, dist: 11 },
  { type: 'light', x: -8.45, y: 2.05, z: -5.3, color: '#ffc58a', intensity: 0.9, dist: 10 },
  { type: 'light', x: -1.3, y: 2.1, z: 8.35, color: '#ffd59a', intensity: 1.1, dist: 11 },
  { type: 'light', x: 8.45, y: 2.05, z: 5.3, color: '#ffc58a', intensity: 0.9, dist: 10 },
  ...decorHalf,
  ...rotate180(decorHalf),
  // 계단실 표지(팀 색)
  { type: 'sign', x: -0.9, y: 2.2, z: -8.67, rotY: 0, w: 2.2, h: 0.5, text: '옥상 출입 · 1동', bg: '#1f3a6e', fg: '#ffe9b8' },
  { type: 'sign', x: 0.9, y: 2.2, z: 8.67, rotY: PI, w: 2.2, h: 0.5, text: '옥상 출입 · 2동', bg: '#7a3a12', fg: '#ffe9b8' },
  // 이웃 건물 간판
  { type: 'sign', x: 17.94, y: 0.6, z: 2, rotY: -PI / 2, w: 4.2, h: 1, text: '세탁 · 수선', bg: '#160d24', fg: '#ff6fb0' },
  { type: 'sign', x: -17.94, y: 0.6, z: -2, rotY: PI / 2, w: 4.2, h: 1, text: '24시 국밥', bg: '#0c1a24', fg: '#5ff0ff' },
  { type: 'sign', x: 23.5, y: 7.2, z: -16, rotY: 0, w: 5, h: 1.2, text: '별빛 피아노', bg: '#120e22', fg: '#ffd166' },
  { type: 'sign', x: -23.5, y: 7.2, z: 16, rotY: PI, w: 5, h: 1.2, text: '달동네 사진관', bg: '#120e22', fg: '#9ff5d2' }
];

export default {
  id: 'rooftop',
  name: '빨랫줄 옥상',
  nameEn: 'Clothesline Roof',
  desc: '밤의 아파트 옥상. 빨랫줄 이불 밑으로 발이 보인다. 옥탑방을 가로지르고 장독대를 넘어 몇 초 만에 맞붙는다.',
  tag: '칼전 전용',
  size: { x: 22, z: 24 },
  rulesets: ['knife'],
  theme: {
    sky: '#3a3360', skyTop: '#0a1230', fog: [22, 85], sunDir: [0.35, 0.55, -0.6],
    sunColor: '#a9bdf0', sunIntensity: 0.55, ambient: 0.85, ground: 'none'
  },
  spawns: {
    owner,
    charterer: rotate180(owner),
    ffa: [...ffaHalf, ...rotate180(ffaHalf)]
  },
  solids: [...building, ...half, ...rotate180(half), ...lidsHalf, ...rotate180(lidsHalf), ...roomRoof, ...lidsCenter],
  decor,
  pads: [],
  portals: [],
  secrets: [{ id: 'rooftop_loft', name: '비둘기장', x: 1.1, y: SH_TOP, z: -9.65, w: 3, h: 2.5, d: 1.9, points: 100, reach: 'jump' }],
  props: [
    { type: 'barrel', x: -4.3, y: 0, z: -11.1 },
    { type: 'crate', x: 10, y: 0, z: -2.2, size: 0.8 },
    { type: 'barrel', x: 4.3, y: 0, z: 11.1 },
    { type: 'crate', x: -10, y: 0, z: 2.2, size: 0.8 }
  ]
};
