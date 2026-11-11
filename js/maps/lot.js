/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 재개발 공터(Vacant Lot). 가설 울타리로 둘러친 36×26 m 흙바닥 공터로, 움직이는 것 없이 흙더미·흄관·덤프트럭·벽돌 더미만 놓인 개활지 맵이다.
 */
import { TEAMS } from '../core/consts.js';
import { box, ramp, cyl, rotate180 } from './kit.js';

// 방위: 북 = -z, 남 = +z. 블루 = -x, 레드 = +x. 서쪽 절반만 적고 rotate180으로 동쪽을 만든다. 아래 그림은 서쪽 절반이다.
//
//        x -18      -13        -10        -6          -2    0
//  z -13  ┌──────────────── 울타리(높이 2.8) ─────────────────
//         │ 간이      ╎ 북쪽 출구   ◯ 흄관 셋            벽돌 더미
//  z -6   │ 화장실    ┃                ◯ ◯
//         │           ┃ 방호벽 ━━━━━
//  z  0   │ 블루      ┃ 가림막         ┃     ／▔▔▔▔▔▔▔＼
//         │ 대기 자리 ┃(높이 2.6)      방호벽  ／ 가운데 흙더미 ＼
//         │           ┃   ◯ 타이어          모래주머니
//  z  6   │           ┃           ┌──┬─────────┐   ◯ 전선 드럼
//         │           ╎ 남쪽 출구 │운전석│ 짐칸 → │▫ 디딤 상자
//         │ 팰릿                  └──┴─────────┘        철근 다발
//  z  13  └───────────────────────────────────────────────────
//
//  두 팀은 가림막 뒤 대기 자리에서 시작해 북쪽·남쪽 출구로 나온다. 가림막이 두 대기 자리 사이의 시야를 끊는다.
//  공터 안은 사방이 트여 있다. 몸을 다 가리는 것은 흄관·덤프트럭·간이 화장실뿐이고, 나머지는 앉아야 가려지는 낮은 엄폐물이다.
//  가운데 흙더미(높이 1 m)는 동서 비탈로만 오른다. 꼭대기 남북 가장자리에 모래주머니 턱(0.6 m)이 있어 앉으면 남북에서 가려진다.
//  덤프트럭 짐칸(바닥 1.2 m)은 뒤쪽 디딤 상자를 밟고 뛰어 오른다. 짐칸 안이 비밀 스팟이다(돌리지 않은 서쪽 트럭만).
//  울타리 위는 clip으로 덮어 운전석 지붕에서 뛰어도 올라서지 못한다.

/* ---------------- 치수 ---------------- */

const HALF_X = 18;       // 맵 반폭
const HALF_Z = 13;
const FENCE_T = 0.3;     // 울타리 두께
const FENCE_H = 2.8;     // 울타리 높이
const SCREEN_H = 2.6;    // 대기 자리 가림막 높이
const MOUND = 1;         // 가운데 흙더미 윗면
const BERM = 0.6;        // 흙더미 꼭대기 모래주머니 턱 높이
const LOW = 1.1;         // 앉으면 가려지는 엄폐물 높이
const BED = 1.2;         // 덤프트럭 짐칸 바닥
const BED_WALL = 1.9;    // 짐칸 옆판 윗면
const CAB = 2.3;         // 운전석 지붕
const LID_TOP = 9;       // 막이 윗면

const FACE = { '+x': Math.PI / 2, '-x': -Math.PI / 2, '+z': 0, '-z': Math.PI };
const out = (dir) => (dir[0] === '+' ? 1 : -1);

/* ---------------- 도형 도우미 ---------------- */

const rect = (x0, z0, x1, z1, y0, y1, mat) => box((x0 + x1) / 2, y0, (z0 + z1) / 2, x1 - x0, y1 - y0, z1 - z0, mat);

/** 울타리 한 줄: 콘크리트 밑단, 녹슨 골판, 그 위 막이 */
const fence = (x0, z0, x1, z1) => [
  rect(x0, z0, x1, z1, 0, 0.4, 'concrete'),
  rect(x0, z0, x1, z1, 0.4, FENCE_H, 'rust'),
  rect(x0, z0, x1, z1, FENCE_H, LID_TOP, 'clip')
];

/** 벽돌이나 자재를 쌓은 낮은 더미: 팰릿 위에 한 덩이. 옆면을 맞춰 발이 걸리는 턱을 두지 않는다 */
const pile = (x0, z0, x1, z1, top, mat) => [
  rect(x0, z0, x1, z1, 0, 0.14, 'wood_dark'),
  rect(x0, z0, x1, z1, 0.14, top, mat)
];

/* ---------------- 절반: 울타리와 대기 자리 ---------------- */

const yard = [
  // 북쪽 울타리는 맵 폭 전체다(돌리면 남쪽 울타리). 서쪽 울타리는 그 사이를 잇는다(돌리면 동쪽 울타리)
  fence(-HALF_X, -HALF_Z, HALF_X, -HALF_Z + FENCE_T),
  fence(-HALF_X, -HALF_Z + FENCE_T, -HALF_X + FENCE_T, HALF_Z - FENCE_T),
  // 대기 자리 가림막: 흰 가설 패널과 노란 윗띠. 남북 끝이 출구다(폭 6.7 m)
  rect(-13.15, -6, -12.85, 6, 0, SCREEN_H, 'white'),
  rect(-13.15, -6, -12.85, 6, SCREEN_H, SCREEN_H + 0.15, 'yellow'),
  // 대기 자리 구석: 간이 화장실(몸을 다 가린다)과 폐타이어
  rect(-17.3, -12.3, -16.1, -11.1, 0, 2.3, 'tank'),
  cyl(-12.25, 0, 3.8, 0.55, 0.75, 'metal_dark')
].flat();

/* ---------------- 절반: 공터의 지형지물 ---------------- */

const field = [
  // 세워 둔 흄관 셋: 둘은 몸을 다 가리고 하나는 앉아야 가려진다
  cyl(-8, 0, -7.5, 1, 2.2, 'concrete'),
  cyl(-9.7, 0, -9.5, 0.8, 2.2, 'concrete'),
  cyl(-5.9, 0, -8.7, 0.8, LOW, 'concrete'),
  // 벽돌 더미 둘(북쪽 울타리 앞)
  pile(-3.4, -10.3, -1.8, -9.1, LOW, 'brick'),
  pile(-1.6, -10.3, -0.4, -9.3, 0.6, 'brick'),
  // 방호벽: 가림막 앞 한 줄과 흙더미 비탈 앞 한 토막
  rect(-10.2, -3.3, -7.4, -2.7, 0, 0.9, 'concrete'),
  rect(-7.2, -1.2, -6.6, 1.2, 0, 0.9, 'concrete'),
  // 모래주머니와 전선 드럼(흙더미 남서쪽)
  rect(-6.4, 2.7, -4.2, 3.3, 0, 1, 'sand'),
  cyl(-2.6, 0, 5.4, 0.9, LOW, 'wood'),
  // 덤프트럭: 운전석, 차대와 짐칸 바닥(같은 평면), 짐칸 옆판 둘과 앞판. 뒤쪽은 열려 있다
  rect(-10.4, 6.8, -8.2, 9.2, 0, CAB, 'yellow'),
  rect(-8.2, 6.75, -3.6, 9.25, 0, 0.7, 'metal_dark'),
  rect(-8.2, 6.75, -3.6, 9.25, 0.7, BED, 'steel'),
  rect(-8.2, 6.75, -3.6, 6.9, BED, BED_WALL, 'steel'),
  rect(-8.2, 9.1, -3.6, 9.25, BED, BED_WALL, 'steel'),
  rect(-8.2, 6.9, -8.05, 9.1, BED, CAB, 'steel'),
  // 짐칸으로 오르는 디딤 상자(0.6 m)
  rect(-3.5, 7.4, -2.7, 8.6, 0, 0.6, 'wood'),
  // 팰릿 더미와 철근 다발(남쪽 울타리 앞)
  rect(-11.6, 10.6, -10.2, 11.8, 0, 0.6, 'wood'),
  rect(-6, 11.4, -2.5, 12, 0, 0.35, 'rust')
].flat();

const half = [...yard, ...field];

/* ---------------- 가운데: 흙더미 (돌리지 않는다. 스스로 180° 대칭이다) ---------------- */

const mound = [
  rect(-2.2, -2, 2.2, 2, 0, MOUND, 'sand'),
  ramp(-3.7, 0, 0, 3, MOUND, 4, '+x', 'sand'),
  ramp(3.7, 0, 0, 3, MOUND, 4, '-x', 'sand'),
  rect(-2.2, -2, 2.2, -1.6, MOUND, MOUND + BERM, 'sand'),
  rect(-2.2, 1.6, 2.2, 2, MOUND, MOUND + BERM, 'sand')
];

/* ---------------- 맵 밖 경치: 울타리 너머 동네 건물 ---------------- */

const scenery = [
  rect(-15, -22, -5, -15.5, 0, 9, 'brick'),
  rect(-3, -24, 7, -16, 0, 13, 'plaster'),
  rect(9, -21, 17, -15, 0, 7, 'brick'),
  rect(-16, 15.5, -6, 21, 0, 8, 'plaster'),
  rect(-4, 16, 6, 23, 0, 11, 'brick'),
  rect(8, 15, 17, 22, 0, 14, 'plaster'),
  // 옥상 물탱크
  cyl(4, 13, -19, 1.2, 1.8, 'tank'),
  cyl(-11, 8, 18.5, 1.1, 1.6, 'tank')
];

/* ---------------- 장식 ---------------- */

/** 벽면(dir 쪽을 보는 면, 좌표 fixed) 앞 off만큼 떨어진 자리와 그 벽이 보는 방향. c = 벽 방향 좌표 */
const on = (dir, fixed, c, y, off = 0.05) => (dir[1] === 'x'
  ? { x: fixed + out(dir) * off, y, z: c, rotY: FACE[dir] }
  : { x: c, y, z: fixed + out(dir) * off, rotY: FACE[dir] });

const sign = (dir, fixed, c, y, w, h, text, bg = '#27333d', fg = '#f1e9d0') => ({ type: 'sign', ...on(dir, fixed, c, y), w, h, text, bg, fg });
const notice = (dir, fixed, c, y, w, h, text, bg = '#e2b21a', fg = '#1d1d1b') => ({ type: 'banner', ...on(dir, fixed, c, y, 0.1), w, h, text, bg, fg });

const decorHalf = [
  // 가림막 바깥쪽(공터 쪽)과 울타리 안쪽의 공사장 표지
  notice('+x', -12.85, -3, 1.7, 2.4, 0.6, '안전 제일'),
  notice('+x', -12.85, 3, 1.7, 2.4, 0.6, '안전모 착용'),
  sign('+z', -HALF_Z + FENCE_T, -9, 2.05, 5.2, 0.8, '재개발 예정 구역 · 관계자 외 출입 금지', '#8f241f', '#f6efe0'),
  sign('+x', -HALF_X + FENCE_T, 8.5, 2, 3, 0.7, '자재 적치장', '#27333d', '#f1e9d0'),
  // 덤프트럭 짐칸 옆판
  sign('-z', 6.75, -5.9, 1.56, 2.6, 0.5, '흙 · 골재 운반', '#30414c', '#f1e9d0'),
  // 울타리 귀퉁이 작업등(빛나는 구)과 기둥
  { type: 'pipe', from: [-17.5, 0, -12.5], to: [-17.5, 5.2, -12.5], r: 0.06, mat: 'steel' },
  { type: 'light', x: -17.2, y: 5.3, z: -12.2, color: '#ffe2b0', intensity: 1.1, dist: 16 },
  // 구석 상자 더미
  { type: 'crateStack', x: -16.9, z: 11.6, rotY: 0.3, size: 0.8, levels: 2 }
];

/** 팀 색 깃발. 대기 자리 안쪽, 가림막의 서쪽 면에 건다 */
const teamDecor = (team) => [-3.6, 3.6].map((z) => (
  { type: 'banner', x: -13.26, y: 1.5, z, rotY: FACE['-x'], w: 1.5, h: 1.9, text: team.name, emblem: 'ring', bg: team.color, fg: '#f4f1e8' }
));

/* ---------------- 스폰 ---------------- */

/** 카메라가 (x,z)에서 (tx,tz)를 보는 rotY */
const look = (x, z, tx, tz) => Math.atan2(-(tx - x), -(tz - z));
const spot = (x, z, tx, tz) => ({ x, z, rotY: look(x, z, tx, tz) });

// 가림막 뒤 한 줄 여덟 곳(16명 방은 한 팀이 여덟이다). 가까운 출구를 보고 선다
const blue = [-4.55, -3.25, -1.95, -0.65, 0.65, 1.95, 3.25, 4.55].map((z) => spot(-15.4, z, -13, z > 0 ? 8.5 : -8.5));

const ffaHalf = [
  spot(-15.4, -9.6, -9, -8),      // 북서 구석(간이 화장실 옆)
  spot(-11.4, 9.7, -6, 5),        // 덤프트럭 운전석 뒤
  spot(-0.9, -11.6, 0, -4),       // 북쪽 울타리 앞, 벽돌 더미 옆
  spot(-8, 0.5, -3, 0)            // 방호벽 토막 뒤(흙더미 서쪽 비탈 앞)
];

/* ---------------- 소품 ---------------- */

const propsHalf = [
  { type: 'barrel', x: -4.6, y: 0, z: -5.6 },
  { type: 'barrel', x: -11.2, y: 0, z: 5.2 },
  { type: 'crate', x: -14.6, y: 0, z: 11.3, size: 0.8 },
  { type: 'crate', x: -1.4, y: 0, z: 10.2 }
];

export default {
  id: 'lot',
  name: '재개발 공터',
  nameEn: 'Vacant Lot',
  desc: '울타리로 둘러친 흙바닥 공터. 흙더미와 흄관, 덤프트럭 말고는 가릴 것이 없는 개활지에서 맞붙는다.',
  tag: '좁은 맵',
  size: { x: HALF_X * 2, z: HALF_Z * 2 },
  rulesets: ['classic', 'knife'],
  theme: {
    sky: '#f0c59c', skyTop: '#5f86b4', fog: [45, 170], sunDir: [-0.5, 0.62, 0.36],
    sunColor: '#ffdcae', sunIntensity: 0.95, ambient: 0.62, ground: 'sand'
  },
  spawns: {
    owner: blue,
    charterer: rotate180(blue),
    ffa: [...ffaHalf, ...rotate180(ffaHalf)]
  },
  solids: [...half, ...rotate180(half), ...mound, ...scenery],
  decor: [
    ...decorHalf,
    ...rotate180(decorHalf),
    ...teamDecor(TEAMS.owner),
    ...rotate180(teamDecor(TEAMS.charterer))
  ],
  pads: [],
  movers: [],
  portals: [],
  secrets: [{ id: 'lot_truck_bed', name: '덤프트럭 짐칸', x: -6, y: BED, z: 8, w: 3.6, h: 2.2, d: 2, points: 100, reach: 'jump' }],
  props: [...propsHalf, ...rotate180(propsHalf)]
};
