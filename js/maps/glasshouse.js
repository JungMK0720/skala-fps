/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 칼전 전용 맵 '선인장 온실'. 한낮의 유리 온실(24×20 m)에서 분갈이실, 선인장 화단, 화분 작업대, 가운데 선인장 분수 단상 사이를 돌며 칼로 겨루는 좁은 맵이다.
 */
/*
 * 방위: 서 = -x(블루), 동 = +x(오렌지). 서쪽 절반을 적고 rotate180으로 동쪽을 만든다.
 *
 *   x -12      -8.4        -3.4   0   3.4        8.4       12
 *   z -10 ┌─────────────── 유리 벽(벽돌 허리벽) ──────────────┐
 *         │ 화분길  │ 선인장 화단(0.8)   │   작업대 ×2 (0.95)   │
 *   z -4.5│ ┌문┐   │                  ┌──────┐              │
 *         │ │분갈이│ 둥근 화분     │ 단상 0.45 │     둥근 화분 │분갈이│
 *         │ │실 A │ (선인장)      │ 선인장 분수│              │실 B │
 *   z 4.5 │ └문┘   │                  └──────┘              │
 *         │       │ 작업대 ×2 (0.95)  │  선인장 화단(0.8)     │
 *   z 10  └──────────────────────────────────────────────┘
 *
 * 스폰은 분갈이실 안이라 양 팀이 서로 보이지 않는다. 문은 남북으로 나 있어 나가자마자 두 갈래로 갈린다.
 * 비밀: 서쪽 남문 옆 작업대 → 상자 더미 → 분갈이실 A 지붕(씨앗 다락). 돌리지 않아 보상은 한 번이다.
 */
import { box, cyl, pillar, platform, doorwayWall, rotate180 } from './kit.js';

const PI = Math.PI;
const KNEE = 0.7;      // 벽돌 허리벽
const ROOF = 5;        // 유리 지붕 높이
const SHED_H = 2.6;    // 분갈이실 벽 높이
const SHED_TOP = 2.75; // 분갈이실 지붕 윗면
const DECK = 0.45;     // 가운데 단상
const BED = 0.8;       // 선인장 화단
const BENCH = 0.95;    // 작업대 윗면

/** 카메라가 (x,z)에서 (tx,tz)를 보는 rotY */
const look = (x, z, tx, tz) => Math.atan2(-(tx - x), -(tz - z));
const spot = (x, z, tx, tz) => ({ x, z, rotY: look(x, z, tx, tz) });

/**
 * 기둥 선인장: 몸통 하나와 팔. arms = [[방향 x, 방향 z, 붙는 높이, 팔 길이]]
 * 몸통 반지름 r, 높이 h, 바닥 y
 */
function cactus(x, y, z, r, h, arms = []) {
  const out = [cyl(x, y, z, r, h, 'grass')];
  for (const [ax, az, at, len] of arms) {
    const ar = r * 0.55, off = r + ar + 0.06, inner = r * 0.6;
    // 몸통 안쪽에서 팔 가운데까지 가로로 뻗은 마디 + 위로 솟은 팔
    const reach = off - inner, mid = (inner + off) / 2, thick = ar * 1.7;
    out.push(box(x + ax * mid, y + at, z + az * mid, ax ? reach : thick, thick, az ? reach : thick, 'grass'));
    out.push(cyl(x + ax * off, y + at, z + az * off, ar, len, 'grass'));
  }
  return out;
}

/** 테라코타 화분과 작은 공 선인장 */
const pot = (x, y, z, r = 0.32, h = 0.45) => [cyl(x, y, z, r, h, 'brick'), cyl(x, y + h, z, r * 0.7, r * 0.9, 'moss')];

/* ---------------- 껍데기: 허리벽, 유리, 흰 기둥 ---------------- */

const shell = [
  box(-6, 0, -9.875, 12, KNEE, 0.25, 'brick'),
  box(-6, KNEE, -9.875, 12, ROOF - KNEE, 0.06, 'glass'),
  box(-6, 0, 9.875, 12, KNEE, 0.25, 'brick'),
  box(-6, KNEE, 9.875, 12, ROOF - KNEE, 0.06, 'glass'),
  box(-11.875, 0, 0, 0.25, KNEE, 20, 'brick'),
  box(-11.875, KNEE, 0, 0.06, ROOF - KNEE, 20, 'glass'),
  ...[-11.65, -8, -4].map((x) => pillar(x, -9.65, ROOF, 0.22, 'white')),
  ...[-11.65, -8, -4].map((x) => pillar(x, 9.65, ROOF, 0.22, 'white')),
  pillar(-11.65, -6.8, ROOF, 0.22, 'white'),
  pillar(-11.65, 6.8, ROOF, 0.22, 'white')
];
const ridge = [
  box(0, ROOF, 0, 24, 0.06, 20, 'glass'),
  pillar(0, -9.65, ROOF, 0.22, 'white'),
  pillar(0, 9.65, ROOF, 0.22, 'white')
];

/* ---------------- 분갈이실 (스폰) ---------------- */

const shedA = [
  box(-11.6, 0, 0, 0.3, SHED_H, 9, 'brick'),
  box(-8.55, 0, 0, 0.3, SHED_H, 9, 'brick'),
  doorwayWall(-11.75, -4.35, -8.4, -4.35, SHED_H, 0.3, 'brick', { at: -10.1, w: 1.9, top: 2.2 }),
  doorwayWall(-11.75, 4.35, -8.4, 4.35, SHED_H, 0.3, 'brick', { at: -10.1, w: 1.9, top: 2.2 }),
  box(-10.075, SHED_H, 0, 3.85, SHED_TOP - SHED_H, 9.3, 'wood_dark'),
  // 안쪽 선반
  box(-9, 0, -2.4, 0.6, 1.8, 1.6, 'wood'),
  box(-9, 0, 2.4, 0.6, 1.8, 1.6, 'wood')
].flat();

/* ---------------- 서쪽 절반: 화단, 작업대, 둥근 화분 ---------------- */

/** 선인장 화단: 벽돌 테두리(0.8)와 모래 윗면, 키 큰 선인장 셋 */
const bed = [
  box(-3.8, 0, -6.15, 4.4, BED - 0.04, 1.7, 'brick'),
  box(-3.8, BED - 0.04, -6.15, 4.2, 0.04, 1.5, 'sand'),
  ...cactus(-5.2, BED, -6.2, 0.3, 1.9, [[0, -1, 0.8, 0.7]]),
  ...cactus(-3.6, BED, -6.0, 0.36, 2.3, [[1, 0, 1, 0.8], [-1, 0, 0.7, 0.6]]),
  ...cactus(-2.3, BED, -6.4, 0.26, 1.4)
];

/** 화분 작업대 둘: 다리 사이로 발이 보인다 */
const benches = [
  ...platform(-6.1, BENCH, 6.3, 2.6, 1.2, 'wood', { legMat: 'wood_dark' }),
  ...platform(-2.5, BENCH, 6.3, 2.6, 1.2, 'wood', { legMat: 'wood_dark' }),
  ...pot(-6.8, BENCH, 6.1, 0.24, 0.3),
  ...pot(-1.9, BENCH, 6.5, 0.26, 0.32)
];

/** 서쪽 가운데 둥근 화분: 돌며 쫓는 기둥 */
const roundPot = [
  cyl(-6, 0, 0, 0.8, 0.6, 'brick'),
  ...cactus(-6, 0.6, 0, 0.32, 2.1, [[0, 1, 0.9, 0.7]])
];

/** 통로 모래길: 남북 화분길 */
const paths = [
  box(-5.4, 0, -8.35, 12.4, 0.03, 1.5, 'sand'),
  box(-5.4, 0, 8.35, 12.4, 0.03, 1.5, 'sand')
];

/** 화분길: 유리 벽을 따라 놓은 화분, 큰 화분의 대나무, 비밀로 가는 상자 더미 */
const pots = [
  cyl(0, 0, -8.6, 0.55, 0.7, 'brick'),
  cyl(-1, 0, -6.2, 0.45, 0.65, 'brick'),
  ...pot(-9.6, 0, -9.3, 0.34, 0.5),
  ...pot(-6.4, 0, -9.35, 0.3, 0.45),
  ...pot(-1.6, 0, -9.3, 0.36, 0.55),
  ...pot(-11.2, 0, -8.6, 0.3, 0.45),
  box(-7.7, 0, 5.1, 1, 1.85, 1, 'wood')
];

/* ---------------- 서쪽만: 씨앗 다락 ---------------- */

/** 씨앗 다락(분갈이실 A 지붕)의 씨앗 자루. 비밀 스팟이 한 곳이라 돌리지 않는다 */
const loft = [
  box(-11.15, SHED_TOP, 3.7, 0.7, 0.45, 0.55, 'sand'),
  box(-11.2, SHED_TOP, 3.0, 0.6, 0.38, 0.5, 'sand'),
  box(-11.15, SHED_TOP + 0.45, 3.65, 0.55, 0.3, 0.45, 'sand')
];

/* ---------------- 가운데: 단상과 선인장 분수 (돌리지 않는 것) ---------------- */

const center = [
  ...loft,
  box(0, 0, 0, 6.8, DECK, 6.8, 'wood'),
  cyl(0, DECK, 0, 1.5, 0.15, 'stone'),
  cyl(0, DECK + 0.15, 0, 1.3, 0.03, 'sand'),
  ...cactus(0, DECK + 0.18, 0, 0.48, 3, [[1, 0, 1.1, 1.1], [-1, 0, 1.5, 0.9], [0, 1, 0.8, 0.7]]),
  ...ridge
];

/** 온실 밖 잔디(플레이 영역 밖) */
const lawn = [box(0, -0.02, -160, 600, 0.03, 300, 'grass'), box(-162, -0.02, 0, 300, 0.03, 20, 'grass')];

const half = [...shell, ...shedA, ...bed, ...benches, ...roundPot, ...paths, ...pots, ...lawn];

/* ---------------- 스폰 ---------------- */

const owner = [
  spot(-10.6, -2.6, -10.1, -6),
  spot(-10.6, -0.8, -10.1, -6),
  spot(-10.6, 0.9, -10.1, 6),
  spot(-10.6, 2.7, -10.1, 6)
];
const ffaHalf = [
  spot(-10.2, -7.6, -6, -8.4),
  spot(-4.6, -8.4, 0, -8.4),
  spot(-6.4, 2.8, -3, 2.8),
  spot(-9.6, 7.8, -6, 8.4)
];

/* ---------------- 장식 ---------------- */

const BLUE = '#2f5fae', ORANGE = '#d9792b';

/** 지붕 흰 살: 가로세로 격자 */
const rafters = [
  ...[-8, -4, 0, 4, 8].map((x) => ({ type: 'pipe', from: [x, ROOF - 0.08, -9.8], to: [x, ROOF - 0.08, 9.8], r: 0.06, mat: 'white' })),
  ...[-6, -2, 2, 6].map((z) => ({ type: 'pipe', from: [-11.8, ROOF - 0.12, z], to: [11.8, ROOF - 0.12, z], r: 0.045, mat: 'white' })),
  // 물 뿌리개 관: 분갈이실 지붕 위로는 지나가지 않는다(지붕에 선 사람 머리에 걸린다)
  { type: 'pipe', from: [-8.1, ROOF - 0.5, -3], to: [8.1, ROOF - 0.5, -3], r: 0.03, mat: 'pipe' },
  { type: 'pipe', from: [-8.1, ROOF - 0.5, 3], to: [8.1, ROOF - 0.5, 3], r: 0.03, mat: 'pipe' }
];

const decorHalf = [
  // 큰 화분의 대나무
  { type: 'bamboo', x: 0, y: 0.7, z: -8.6, h: 3.6, n: 7, r: 0.35 },
  { type: 'bamboo', x: -1, y: 0.65, z: -6.2, h: 3, n: 6, r: 0.3 },
  // 모서리 대숲(유리 벽 안쪽)
  { type: 'bamboo', x: -11, z: -9, h: 4.4, n: 6, r: 0.45 },
  { type: 'bamboo', x: -11, z: 9, h: 4.4, n: 6, r: 0.45 },
  // 바깥 산울타리 너머 대숲
  { type: 'bamboo', x: -14, z: -4, h: 6.5, n: 10, r: 1.2 },
  { type: 'bamboo', x: -14.5, z: 6, h: 7, n: 10, r: 1.2 },
  { type: 'bamboo', x: -6, z: -13.5, h: 6, n: 9, r: 1.1 },
  { type: 'bamboo', x: 4, z: -14, h: 6.8, n: 10, r: 1.2 },
  // 작업대 위 물뿌리개 대신 작은 상자
  { type: 'crateStack', x: -3.1, y: BENCH, z: 6.2, rotY: 0.3, size: 0.45, levels: 1, mat: 'wood' },
  // 호스
  { type: 'rope', from: [-8.3, 0.9, -3], to: [-7, 0.05, -2.2], sag: 0.05, r: 0.035, mat: 'yellow' },
  { type: 'rope', from: [-7, 0.05, -2.2], to: [-4.5, 0.05, -3.3], sag: 0.02, r: 0.035, mat: 'yellow' }
];

const decor = [
  ...rafters,
  ...decorHalf,
  ...rotate180(decorHalf),
  // 분갈이실 안 등: 실제 조명
  { type: 'light', x: -10.1, y: 2.3, z: 0, color: '#ffe2b0', intensity: 0.9, dist: 7 },
  { type: 'light', x: 10.1, y: 2.3, z: 0, color: '#ffe2b0', intensity: 0.9, dist: 7 },
  { type: 'lantern', x: -10.1, y: 2.2, z: 0, r: 0.16, cord: 0.25, color: '#ffe2b0' },
  { type: 'lantern', x: 10.1, y: 2.2, z: 0, r: 0.16, cord: 0.25, color: '#ffe2b0' },
  // 문패
  { type: 'sign', x: -10.1, y: 2.42, z: -4.52, rotY: PI, w: 1.9, h: 0.34, text: '분갈이실 A', bg: BLUE, fg: '#ffffff' },
  { type: 'sign', x: -10.1, y: 2.42, z: 4.52, rotY: 0, w: 1.9, h: 0.34, text: '분갈이실 A', bg: BLUE, fg: '#ffffff' },
  { type: 'sign', x: 10.1, y: 2.42, z: 4.52, rotY: 0, w: 1.9, h: 0.34, text: '분갈이실 B', bg: ORANGE, fg: '#ffffff' },
  { type: 'sign', x: 10.1, y: 2.42, z: -4.52, rotY: PI, w: 1.9, h: 0.34, text: '분갈이실 B', bg: ORANGE, fg: '#ffffff' },
  { type: 'sign', x: 0, y: 4.3, z: -9.8, rotY: 0, w: 4, h: 0.7, text: '선인장 온실', bg: '#25553a', fg: '#fff6d8' }
];

export default {
  id: 'glasshouse',
  name: '선인장 온실',
  nameEn: 'Cactus Glasshouse',
  desc: '한낮의 유리 온실. 분갈이실에서 나가면 선인장 화단과 작업대 사이로 몇 걸음 만에 맞붙는다. 가운데 분수 단상을 돌며 쫓고 쫓긴다.',
  tag: '칼전 전용',
  size: { x: 24, z: 20 },
  rulesets: ['knife'],
  theme: {
    sky: '#cfe9f2', skyTop: '#4a8fd6', fog: [40, 170], sunDir: [0.35, 0.85, 0.4],
    sunColor: '#fff3d6', sunIntensity: 1.05, ambient: 0.72, ground: 'stone'
  },
  spawns: {
    owner,
    charterer: rotate180(owner),
    ffa: [...ffaHalf, ...rotate180(ffaHalf)]
  },
  solids: [...half, ...rotate180(half), ...center],
  decor,
  pads: [],
  portals: [],
  secrets: [{ id: 'glasshouse_loft', name: '씨앗 다락', x: -10.1, y: SHED_TOP, z: 2.2, w: 3.4, h: 2, d: 4.2, points: 100, reach: 'jump' }],
  props: []
};
