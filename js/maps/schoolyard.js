/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 초등학교 운동장(Schoolyard). 구령대와 스탠드 사이 40×26 m 모래 운동장으로, 움직이는 것 없이 정글짐·골대·뜀틀·화단만 놓인 개활지 맵이다.
 */
import { TEAMS } from '../core/consts.js';
import { box, cyl, pillar, stairs, mirrorX } from './kit.js';

// 방위: 북 = -z(교사 쪽), 남 = +z(스탠드 쪽). 블루 = -x, 레드 = +x. 서쪽 절반만 적고 mirrorX로 동쪽을 만든다(좌우 대칭).
// 북쪽 구령대와 남쪽 스탠드는 가운데에 하나씩 있고 그 자체로 좌우 대칭이다. 아래 그림은 서쪽 절반이다.
//
//        x -20   -16.4 -13.6   -11.5      -8          -4        0
//  z -13  ┌──────────────────── 교사 벽(높이 8) ─────────────────────
//         │ 북쪽 출구       수돗가              계단 ▟██ 구령대(1 m) ██
//  z -10  │                                          ▔▔▔ 난간 ▔▔▔▔▔▔
//         │               ┆      ▦▦▦ 정글짐
//  z -5   │ ┌────────┐    ┆      ▦▦▦                 ▭ 뜀틀과 매트
//         │ │ 체육   │  골대                                      │
//  z  0   │ │ 창고   │  ┃                                 가운데 선│
//         │ │(2.8 m) │  ┃                                          │
//  z  5   │ └────────┘    ┆         ▣ 화단과 벚나무               │
//         │ 블루 대기 자리        ◯◯◯ 타이어
//  z  10  │ 남쪽 출구   ╥╥ 철봉   ▬ 긴 의자   ▁▁▁▁ 스탠드 3단(0.4·0.8·1.2 m) ▁▁
//  z  13  └──────────────────── 남쪽 벽(높이 3) ─────────────────────
//
//  두 팀은 체육 창고 뒤 대기 자리에서 시작해 창고 남북 끝을 돌아 나온다. 창고가 두 대기 자리 사이의 시야를 끊는다.
//  운동장 한가운데는 비어 있다. 몸을 다 가리는 것은 창고와 벚나무 줄기뿐이고, 나머지는 앉아야 가려지거나 틈으로 총알이 지나가는 것들이다.
//  구령대(1 m)는 양옆 계단으로 오르고 앞 난간(0.5 m)에 앉아 가릴 수 있다. 스탠드는 한 단이 0.4 m라 걸어서 오른다.
//  정글짐은 지나갈 수 없지만 살 사이로 보이고 총알도 지나간다.

/* ---------------- 치수 ---------------- */

const HALF_X = 20;       // 맵 반폭
const HALF_Z = 13;
const WALL_T = 0.3;      // 담장 두께
const SCHOOL_H = 8;      // 교사 벽 높이
const SIDE_H = 2.6;      // 동서 담장 높이
const BACK_H = 3;        // 스탠드 뒤 벽 높이
const SHED_H = 2.8;      // 체육 창고 높이
const STAGE = 1;         // 구령대 바닥
const RAIL = 0.5;        // 구령대 난간 높이
const ROOF = 3.6;        // 구령대 지붕 밑면
const TIER = 0.4;        // 스탠드 한 단 높이. 걸어서 오르는 턱(0.45)보다 낮다
const GYM_H = 2.4;       // 정글짐 높이
const LID_TOP = 10;      // 막이 윗면

const FACE = { '+x': Math.PI / 2, '-x': -Math.PI / 2, '+z': 0, '-z': Math.PI };
const out = (dir) => (dir[0] === '+' ? 1 : -1);

/* ---------------- 도형 도우미 ---------------- */

const rect = (x0, z0, x1, z1, y0, y1, mat) => box((x0 + x1) / 2, y0, (z0 + z1) / 2, x1 - x0, y1 - y0, z1 - z0, mat);
/** 운동장에 그은 흰 선. 얇아서 걸리지 않는다 */
const line = (x0, z0, x1, z1) => rect(x0, z0, x1, z1, 0, 0.02, 'white');

/**
 * 정글짐: 가로세로 3 m, 기둥 아홉과 두 높이(1.2 m, 꼭대기)의 가로대.
 * 가로대가 몸을 막아 지나갈 수 없고, 살 사이로는 보이고 총알도 지나간다
 */
function jungleGym(cx, cz) {
  const at = [-1.5, 0, 1.5];
  const list = [];
  for (const dx of at) for (const dz of at) list.push(pillar(cx + dx, cz + dz, GYM_H, 0.12, 'yellow'));
  for (const y of [1.2, GYM_H]) {
    for (const d of at) {
      list.push(rect(cx - 1.5, cz + d - 0.05, cx + 1.5, cz + d + 0.05, y - 0.1, y, 'pipe'));
      list.push(rect(cx + d - 0.05, cz - 1.5, cx + d + 0.05, cz + 1.5, y - 0.1, y, 'pipe'));
    }
  }
  return list;
}

/* ---------------- 절반: 담장과 체육 창고 ---------------- */

const yard = [
  // 서쪽 담장(뒤집으면 동쪽 담장)과 그 위 막이
  rect(-HALF_X, -HALF_Z + 0.4, -HALF_X + WALL_T, HALF_Z - WALL_T, 0, SIDE_H, 'brick'),
  rect(-HALF_X, -HALF_Z + 0.4, -HALF_X + WALL_T, HALF_Z - WALL_T, SIDE_H, LID_TOP, 'clip'),
  // 체육 창고: 벽돌 몸통과 내민 지붕. 남북 끝이 대기 자리의 출구다
  rect(-16.4, -5, -13.6, 5, 0, SHED_H, 'brick'),
  rect(-16.6, -5.2, -13.4, 5.2, SHED_H, SHED_H + 0.2, 'rust'),
  rect(-16.6, -5.2, -13.4, 5.2, SHED_H + 0.2, LID_TOP, 'clip'),
  // 창고 문(닫혀 있다)
  rect(-13.62, -1.1, -13.56, 1.1, 0, 2.2, 'metal_dark')
];

/* ---------------- 절반: 운동장의 지형지물 ---------------- */

const field = [
  // 축구 골대: 기둥 둘, 가로대, 뒤 버팀대 둘
  pillar(-11.5, -2.2, 2.2, 0.14, 'white'),
  pillar(-11.5, 2.2, 2.2, 0.14, 'white'),
  rect(-11.57, -2.27, -11.43, 2.27, 2.2, 2.34, 'white'),
  pillar(-12.7, -2.2, 1.3, 0.1, 'white'),
  pillar(-12.7, 2.2, 1.3, 0.1, 'white'),
  // 정글짐(북서쪽)
  jungleGym(-8, -6.5),
  // 수돗가: 낮은 수조와 뒤판
  rect(-12.4, -11.5, -9.4, -10.7, 0, 0.9, 'tile'),
  rect(-12.4, -11.7, -9.4, -11.5, 0, 1.3, 'tile'),
  // 뜀틀과 매트(가운데 선 서쪽)
  rect(-3.4, -4.4, -2, -3.4, 0, 1, 'wood'),
  rect(-1.9, -4.5, -0.3, -3.3, 0, 0.18, 'tank'),
  // 화단과 벚나무 줄기
  rect(-5.6, 3, -3.4, 5.2, 0, 0.5, 'brick'),
  cyl(-4.5, 0.5, 4.1, 0.24, 2.6, 'wood_dark'),
  // 반쯤 묻은 타이어 셋
  cyl(-9.6, 0, 7.4, 0.5, 0.55, 'metal_dark'),
  cyl(-8.3, 0, 7.4, 0.5, 0.55, 'metal_dark'),
  cyl(-7, 0, 7.4, 0.5, 0.55, 'metal_dark'),
  // 철봉: 기둥 셋과 높이가 다른 봉 둘(서서 지나간다)
  pillar(-13.6, 9.6, 2.3, 0.1, 'pipe'),
  pillar(-12.1, 9.6, 2.3, 0.1, 'pipe'),
  pillar(-10.6, 9.6, 2.1, 0.1, 'pipe'),
  rect(-13.6, 9.56, -12.1, 9.64, 2.22, 2.3, 'pipe'),
  rect(-12.1, 9.56, -10.6, 9.64, 1.98, 2.06, 'pipe'),
  // 스탠드 앞 긴 의자
  rect(-7.6, 8.9, -5.2, 9.4, 0, 0.45, 'wood'),
  // 운동장 선: 골 구역과 옆줄
  line(-11.4, -4.2, -8.6, -4.1), line(-11.4, 4.1, -8.6, 4.2), line(-8.7, -4.2, -8.6, 4.2),
  line(-11.4, -9.4, 0, -9.3), line(-11.4, 8.3, 0, 8.4), line(-11.5, -9.4, -11.4, 8.4)
].flat();

const half = [...yard, ...field];

/* ---------------- 가운데: 교사 벽, 구령대, 스탠드 (뒤집지 않는다. 스스로 좌우 대칭이다) ---------------- */

const center = [
  // 교사 벽과 밑단, 위층 창문(유리)
  rect(-HALF_X, -HALF_Z, HALF_X, -HALF_Z + 0.4, 0, SCHOOL_H, 'plaster'),
  rect(-HALF_X, -HALF_Z + 0.4, HALF_X, -HALF_Z + 0.44, 0, 0.9, 'stone'),
  ...[-17, -13, -9, 9, 13, 17].map((x) => rect(x - 1.3, -HALF_Z + 0.4, x + 1.3, -HALF_Z + 0.44, 4.3, 5.9, 'glass')),
  ...[-4, 0, 4].map((x) => rect(x - 1.3, -HALF_Z + 0.4, x + 1.3, -HALF_Z + 0.44, 4.9, 6.3, 'glass')),
  // 구령대: 바닥, 앞 난간, 기둥 넷, 지붕
  rect(-4, -HALF_Z + 0.4, 4, -10.2, 0, STAGE, 'concrete'),
  rect(-4, -10.4, 4, -10.2, STAGE, STAGE + RAIL, 'concrete'),
  ...[[-3.7, -12.3], [3.7, -12.3], [-3.7, -10.55], [3.7, -10.55]].map(([x, z]) => pillar(x, z, ROOF - STAGE, 0.3, 'white', STAGE)),
  rect(-4.4, -HALF_Z + 0.4, 4.4, -9.9, ROOF, ROOF + 0.25, 'tank'),
  // 구령대 양옆 계단(네 단)
  ...stairs(-5, 0, -11.4, 2, STAGE, 2.4, '+x', 'concrete'),
  ...stairs(5, 0, -11.4, 2, STAGE, 2.4, '-x', 'concrete'),
  // 남쪽 벽과 그 위 막이
  rect(-HALF_X, HALF_Z - WALL_T, HALF_X, HALF_Z, 0, BACK_H, 'concrete'),
  rect(-HALF_X, HALF_Z - WALL_T, HALF_X, HALF_Z, BACK_H, LID_TOP, 'clip'),
  // 스탠드 3단
  rect(-9, 10, 9, 10.9, 0, TIER, 'concrete'),
  rect(-9, 10.9, 9, 11.8, 0, TIER * 2, 'concrete'),
  rect(-9, 11.8, 9, HALF_Z - WALL_T, 0, TIER * 3, 'concrete'),
  // 가운데 선
  line(-0.05, -9.4, 0.05, 8.4)
];

/* ---------------- 맵 밖 경치: 교사 지붕 띠와 남쪽 담 너머 건물 ---------------- */

const scenery = [
  rect(-HALF_X - 2, -19, HALF_X + 2, -HALF_Z, SCHOOL_H, SCHOOL_H + 0.5, 'concrete'),
  rect(-14, 15.5, -4, 21, 0, 7, 'plaster'),
  rect(3, 16, 15, 23, 0, 10, 'brick')
];

/* ---------------- 장식 ---------------- */

/** 벽면(dir 쪽을 보는 면, 좌표 fixed) 앞 off만큼 떨어진 자리와 그 벽이 보는 방향. c = 벽 방향 좌표 */
const on = (dir, fixed, c, y, off = 0.05) => (dir[1] === 'x'
  ? { x: fixed + out(dir) * off, y, z: c, rotY: FACE[dir] }
  : { x: c, y, z: fixed + out(dir) * off, rotY: FACE[dir] });

const sign = (dir, fixed, c, y, w, h, text, bg = '#27333d', fg = '#f1e9d0') => ({ type: 'sign', ...on(dir, fixed, c, y), w, h, text, bg, fg });

const decorHalf = [
  // 체육 창고 문 위와 수돗가
  sign('+x', -13.6, 0, 2.45, 2.2, 0.45, '체육 창고', '#1f4d3a', '#f4f1e8'),
  sign('+z', -11.5, -10.9, 1.62, 2.2, 0.4, '물을 아껴 써요', '#2a6fa8', '#f4f1e8'),
  // 벚나무(줄기는 solids에 있다)
  { type: 'tree', x: -4.5, y: 0.5, z: 4.1, h: 5.2 },
  // 창고 옆 상자 더미
  { type: 'crateStack', x: -18.9, z: -11.6, rotY: 0.2, size: 0.8, levels: 2 }
];

const decorCenter = [
  sign('+z', -HALF_Z + 0.44, 0, 7.1, 9, 1, '스칼라초등학교', '#1f3f73', '#f4f1e8'),
  sign('+z', -10.2, 0, 0.55, 5, 0.6, '참되게 · 씩씩하게 · 슬기롭게', '#e8e2cf', '#27333d'),
  // 스탠드 뒤 벽의 응원 현수막
  { type: 'banner', x: -5, y: 2.1, z: HALF_Z - WALL_T - 0.1, rotY: FACE['-z'], w: 4.6, h: 0.9, text: '가을 운동회', bg: '#c4362f', fg: '#f6efe0' },
  { type: 'banner', x: 5, y: 2.1, z: HALF_Z - WALL_T - 0.1, rotY: FACE['-z'], w: 4.6, h: 0.9, text: '청군 백군 모두 힘내라', bg: '#1f3f73', fg: '#f6efe0' },
  // 구령대 지붕 위 깃대
  { type: 'pipe', from: [0, ROOF + 0.25, -11.4], to: [0, ROOF + 2.6, -11.4], r: 0.04, mat: 'steel' },
  { type: 'banner', x: 0.6, y: ROOF + 2.2, z: -11.4, rotY: 0, w: 1.1, h: 0.7, emblem: 'circle', bg: '#f4f1e8', fg: '#1f3f73' }
];

/** 팀 색 깃발. 대기 자리 안쪽, 창고의 서쪽 면에 건다 */
const teamDecor = (team) => [-3, 3].map((z) => (
  { type: 'banner', x: -16.51, y: 1.6, z, rotY: FACE['-x'], w: 1.5, h: 2, text: team.name, emblem: 'ring', bg: team.color, fg: '#f4f1e8' }
));

/* ---------------- 스폰 ---------------- */

/** 카메라가 (x,z)에서 (tx,tz)를 보는 rotY */
const look = (x, z, tx, tz) => Math.atan2(-(tx - x), -(tz - z));
const spot = (x, z, tx, tz) => ({ x, z, rotY: look(x, z, tx, tz) });

// 창고 뒤 한 줄 여덟 곳(16명 방은 한 팀이 여덟이다). 가까운 출구를 보고 선다
const blue = [-4.55, -3.25, -1.95, -0.65, 0.65, 1.95, 3.25, 4.55].map((z) => spot(-18.1, z, -15, z > 0 ? 7.5 : -7.5));

const ffaHalf = [
  spot(-18.1, -9.6, -10, -8),     // 대기 자리 북쪽 끝
  spot(-18.1, 9.8, -10, 8),       // 대기 자리 남쪽 끝
  spot(-7.4, -11.2, -2, -4),      // 수돗가 옆(구령대 계단 서쪽)
  spot(-6, 11.35, -2, 4)          // 스탠드 둘째 단
];

/* ---------------- 소품 ---------------- */

const propsHalf = [
  { type: 'barrel', x: -17.6, y: 0, z: 6.4 },
  { type: 'crate', x: -14.9, y: 0, z: -6.1, size: 0.8 },
  { type: 'crate', x: -11.3, y: 0, z: 11.6, size: 0.8 }
];

export default {
  id: 'schoolyard',
  name: '초등학교 운동장',
  nameEn: 'Schoolyard',
  desc: '구령대와 스탠드 사이 모래 운동장. 정글짐과 골대, 뜀틀 말고는 가릴 것이 없는 한낮의 개활지다.',
  tag: '좁은 맵',
  size: { x: HALF_X * 2, z: HALF_Z * 2 },
  rulesets: ['classic', 'knife'],
  theme: {
    sky: '#c3e2f6', skyTop: '#4d8fd0', fog: [60, 220], sunDir: [0.32, 0.9, 0.28],
    sunColor: '#fff6df', sunIntensity: 1, ambient: 0.7, ground: 'sand'
  },
  spawns: {
    owner: blue,
    charterer: mirrorX(blue),
    ffa: [...ffaHalf, ...mirrorX(ffaHalf)]
  },
  solids: [...half, ...mirrorX(half), ...center, ...scenery],
  decor: [
    ...decorCenter,
    ...decorHalf,
    ...mirrorX(decorHalf),
    ...teamDecor(TEAMS.owner),
    ...mirrorX(teamDecor(TEAMS.charterer))
  ],
  pads: [],
  movers: [],
  portals: [],
  secrets: [],
  props: [...propsHalf, ...mirrorX(propsHalf)]
};
