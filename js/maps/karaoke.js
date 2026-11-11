/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 코인 노래방(Coin Karaoke). 네온 복도가 방 여섯을 한 바퀴 두르는 32×17 m 실내 맵으로, 가까이 가면 옆으로 열리는 자동문 여덟 개 뒤에서 갑자기 맞붙는다.
 */
import { TEAMS } from '../core/consts.js';
import { box, wall, doorwayWall, rotate180 } from './kit.js';

// 방위: 북 = -z, 남 = +z. 블루 = -x(서쪽 카운터), 레드 = +x(동쪽 카운터). 북쪽 절반만 적고 rotate180으로 남쪽을 만든다.
//
//        x -16   -12        -9          -3           3           9        12    16
//  z -8.5 ┌───────┬──────────────────── 북쪽 복도(폭 3.1) ─────────────────┬───────┐
//         │       ╎           자판기         ▒▒ 화분            자판기      ╎       │
//  z -5   │ 블루  │ 서쪽 ┌──[문]─────┬──[문]──────┬─────[문]──┐ 동쪽      │ 레드  │
//         │ 카운터│ 복도 │ 1번 방    │ 2번 방     │ 3번 방    │ 복도      │ 카운터│
//         │       │    [문]  탁자·소파│            │           │           │       │
//  z  0   │       │      ├──╎틈╎─────┼────╎틈╎────┼────╎틈╎───┤           │       │
//         │       │      │ 4번 방    │ 5번 방     │ 6번 방   [문]          │       │
//  z  5   │       │      └─────[문]──┴──────[문]──┴──[문]─────┘           │       │
//         │       ╎                                                        ╎       │
//  z  8.5 └───────┴──────────────────── 남쪽 복도 ─────────────────────────┴───────┘
//
//  방은 북쪽 줄 셋(1~3번)과 남쪽 줄 셋(4~6번)이다. 같은 칸의 위아래 방은 가운데 벽의 틈(문 없음)으로 이어져 복도에서 복도로 가로지르는 지름길이 된다.
//  복도 쪽 문 여섯과 옆 복도 쪽 문 둘은 자동문이다. 사람이 1.4 m 안에 오면 0.22초 만에 옆 벽 속으로 들어가고, 아무도 없으면 닫힌다.
//  문이 닫혀 있으면 방 안이 보이지 않는다. 복도 가운데나 바깥 벽 쪽으로 걸으면 문이 열리지 않아 방 앞을 몰래 지나갈 수 있다.
//  두 팀은 양 끝 카운터에서 시작한다. 카운터와 복도 사이 벽이 두 카운터 사이의 시야를 끊는다.

/* ---------------- 치수 ---------------- */

const HALF_X = 16;       // 맵 반폭
const HALF_Z = 8.5;
const OUT_T = 0.4;       // 바깥 벽 두께
const WALL_T = 0.3;      // 방 벽 두께. 자동문(두께 0.1)이 이 속으로 들어간다
const WALL_H = 3.2;      // 벽 높이 = 천장 밑면
const DOOR_W = 1.8;      // 문 폭 = 문간 폭
const DOOR_H = 2.3;      // 문 높이 = 문간 윗변
const DOOR_T = 0.1;      // 문짝 두께
const DOOR_RUN = DOOR_W + 0.03;   // 열릴 때 가는 거리. 문짝 끝이 문설주 면보다 조금 더 들어가 벽 속에 숨는다
const BLOCK_X = 9;       // 방 덩어리의 동서 끝(벽 중심선)
const BLOCK_Z = 5;       // 방 덩어리의 남북 끝(벽 중심선)
const LOBBY_X = 12.15;   // 카운터와 복도 사이 벽(중심선)
const SEAT = 0.45;       // 소파 앉는 높이
const TABLE = 0.75;      // 탁자 높이

const FACE = { '+x': Math.PI / 2, '-x': -Math.PI / 2, '+z': 0, '-z': Math.PI };
const out = (dir) => (dir[0] === '+' ? 1 : -1);

/** 자동문이 사람을 알아보는 거리와 여닫는 시간 */
const AUTO = Object.freeze({ range: 1.4, open: 0.22, close: 0.5, linger: 0.7 });

/* ---------------- 도형 도우미 ---------------- */

const rect = (x0, z0, x1, z1, y0, y1, mat) => box((x0 + x1) / 2, y0, (z0 + z1) / 2, x1 - x0, y1 - y0, z1 - z0, mat);
/** 바닥에 붙인 네온 띠. 얇아서 걸리지 않는다 */
const glow = (x0, z0, x1, z1, mat) => rect(x0, z0, x1, z1, 0, 0.04, mat);

/** 방 안 가구: 탁자 하나와 벽에 붙인 소파(앉는 판과 등받이). wallX = 소파가 붙는 벽의 안쪽 면, side = 그 벽이 방의 어느 쪽인가(+1 동, -1 서) */
const furniture = (tableX, tableZ, wallX, side, z0, z1) => [
  rect(tableX - 0.8, tableZ - 0.4, tableX + 0.8, tableZ + 0.4, 0, TABLE, 'wood_dark'),
  rect(Math.min(wallX, wallX - side * 0.85), z0, Math.max(wallX, wallX - side * 0.85), z1, 0, SEAT, 'tank'),
  rect(Math.min(wallX, wallX - side * 0.25), z0, Math.max(wallX, wallX - side * 0.25), z1, SEAT, 1, 'tank')
];

/* ---------------- 북쪽 절반: 바깥 벽, 카운터 벽, 방 덩어리 ---------------- */

const shell = [
  // 북쪽 바깥 벽은 맵 폭 전체다(돌리면 남쪽 벽). 서쪽 바깥 벽은 그 사이를 잇는다(돌리면 동쪽 벽)
  rect(-HALF_X, -HALF_Z, HALF_X, -HALF_Z + OUT_T, 0, WALL_H, 'steel'),
  rect(-HALF_X, -HALF_Z + OUT_T, -HALF_X + OUT_T, HALF_Z - OUT_T, 0, WALL_H, 'steel'),
  // 서쪽 카운터와 복도 사이 벽: 북쪽·남쪽 복도 끝에 문간(문 없음)
  doorwayWall(-LOBBY_X, -HALF_Z + OUT_T, -LOBBY_X, HALF_Z - OUT_T, WALL_H, WALL_T, 'steel', { at: [-6.55, 6.55], w: 2, top: DOOR_H }),
  // 카운터 책상(서쪽 벽 앞)
  rect(-HALF_X + OUT_T, -1.6, -15, 1.6, 0, 1.1, 'wood_dark'),
  rect(-HALF_X + OUT_T, -1.6, -14.9, 1.6, 1.1, 1.16, 'neon_cyan')
].flat();

const block = [
  // 방 덩어리의 북쪽 벽: 1~3번 방 문간 셋. 문짝은 문간 옆 벽 속으로 들어간다
  doorwayWall(-BLOCK_X - WALL_T / 2, -BLOCK_Z, BLOCK_X + WALL_T / 2, -BLOCK_Z, WALL_H, WALL_T, 'steel', { at: [-6, -1.5, 6], w: DOOR_W, top: DOOR_H }),
  // 방 덩어리의 서쪽 벽: 1번 방 옆문 하나(돌리면 6번 방 옆문이 있는 동쪽 벽)
  doorwayWall(-BLOCK_X, -BLOCK_Z + WALL_T / 2, -BLOCK_X, BLOCK_Z - WALL_T / 2, WALL_H, WALL_T, 'steel', { at: -2.5, w: DOOR_W, top: DOOR_H }),
  // 방 사이 벽(1번|2번, 돌리면 5번|6번). 가운데 벽과 겹치는 자리까지 한 장이다
  wall(-3, -BLOCK_Z + WALL_T / 2, -3, 0, WALL_H, WALL_T, 'wood'),
  wall(3, -BLOCK_Z + WALL_T / 2, 3, 0, WALL_H, WALL_T, 'wood'),
  // 가구: 1번 방(소파는 동쪽 벽), 2번 방(서쪽 벽), 3번 방(동쪽 벽)
  furniture(-6.4, -2.4, -3.15, 1, -4.3, -1.3),
  furniture(1.2, -2.7, -2.85, -1, -4.3, -1.3),
  furniture(5.4, -2.2, 8.85, 1, -4.3, -1.5),
  // 복도의 자판기 둘과 화분(북쪽 바깥 벽 앞)
  rect(-8.2, -HALF_Z + OUT_T, -7.2, -7.3, 0, 1.9, 'container_red'),
  rect(8.6, -HALF_Z + OUT_T, 9.6, -7.3, 0, 1.9, 'tank'),
  rect(1.6, -HALF_Z + OUT_T, 2.4, -7.3, 0, 0.9, 'stone'),
  // 네온 띠: 방 덩어리 북쪽 벽 밑(분홍)과 북쪽 바깥 벽 밑(하늘)
  glow(-BLOCK_X, -BLOCK_Z - WALL_T / 2 - 0.08, BLOCK_X, -BLOCK_Z - WALL_T / 2, 'neon_pink'),
  glow(-LOBBY_X + WALL_T / 2, -HALF_Z + OUT_T, LOBBY_X - WALL_T / 2, -HALF_Z + OUT_T + 0.08, 'neon_cyan'),
  glow(-BLOCK_X - WALL_T / 2 - 0.08, -BLOCK_Z, -BLOCK_X - WALL_T / 2, BLOCK_Z, 'neon_pink')
].flat();

const half = [...shell, ...block];

/* ---------------- 가운데 (돌리지 않는다. 스스로 180° 대칭이다) ---------------- */

const center = [
  // 북쪽 줄과 남쪽 줄 사이 벽: 칸마다 틈 하나(문 없음)
  ...doorwayWall(-BLOCK_X + WALL_T / 2, 0, BLOCK_X - WALL_T / 2, 0, WALL_H, WALL_T, 'wood', { at: [-4.5, 0, 4.5], w: DOOR_W, top: DOOR_H }),
  // 천장
  rect(-HALF_X, -HALF_Z, HALF_X, HALF_Z, WALL_H, WALL_H + 0.3, 'metal_dark')
];

/* ---------------- 자동문 ---------------- */

/** 동서로 놓인 벽의 문(문짝이 x로 길다). slide = 열릴 때 가는 방향(+1 동, -1 서) */
const doorX = (id, x, z, slide, mat) => ({ id, x, y: 0, z, w: DOOR_W, h: DOOR_H, d: DOOR_T, mat, axis: 'x', dist: slide * DOOR_RUN, door: AUTO });
/** 남북으로 놓인 벽의 문(문짝이 z로 길다). slide = 열릴 때 가는 방향(+1 남, -1 북) */
const doorZ = (id, x, z, slide, mat) => ({ id, x, y: 0, z, w: DOOR_T, h: DOOR_H, d: DOOR_W, mat, axis: 'z', dist: slide * DOOR_RUN, door: AUTO });

// 북쪽 줄의 문 넷. 돌린 복사본이 남쪽 줄의 문 넷이 된다(4~6번 방 문과 6번 방 옆문)
const doorsNorth = [
  doorX('door_1', -6, -BLOCK_Z, 1, 'neon_cyan'),
  doorX('door_2', -1.5, -BLOCK_Z, 1, 'neon_cyan'),
  doorX('door_3', 6, -BLOCK_Z, -1, 'neon_cyan'),
  doorZ('door_1w', -BLOCK_X, -2.5, 1, 'neon_pink')
];
const SOUTH_ID = { door_1_r: 'door_6', door_2_r: 'door_5', door_3_r: 'door_4', door_1w_r: 'door_6e' };

/* ---------------- 장식 ---------------- */

/** 벽면(dir 쪽을 보는 면, 좌표 fixed) 앞 off만큼 떨어진 자리와 그 벽이 보는 방향. c = 벽 방향 좌표 */
const on = (dir, fixed, c, y, off = 0.05) => (dir[1] === 'x'
  ? { x: fixed + out(dir) * off, y, z: c, rotY: FACE[dir] }
  : { x: c, y, z: fixed + out(dir) * off, rotY: FACE[dir] });

const sign = (dir, fixed, c, y, w, h, text, bg = '#1a1430', fg = '#7df3ff') => ({ type: 'sign', ...on(dir, fixed, c, y), w, h, text, bg, fg });

/** 절반마다 글자가 다른 표지(방 번호). 남쪽은 돌려서 쓴다. rooms = 서쪽 문부터 방 번호 셋, side = 옆문이 있는 방 번호 */
const labelled = ({ rooms, side }) => [
  // 복도 쪽 문 위
  sign('-z', -BLOCK_Z - WALL_T / 2, -6, 2.72, 1.5, 0.42, `${rooms[0]}번 방`),
  sign('-z', -BLOCK_Z - WALL_T / 2, -1.5, 2.72, 1.5, 0.42, `${rooms[1]}번 방`),
  sign('-z', -BLOCK_Z - WALL_T / 2, 6, 2.72, 1.5, 0.42, `${rooms[2]}번 방`),
  sign('-x', -BLOCK_X - WALL_T / 2, -2.5, 2.72, 1.5, 0.42, `${side}번 방`, '#1a1430', '#ff8ad0')
];

const decorHalf = [
  // 방 안 화면(소파 맞은편 벽)
  sign('+x', -8.85, -0.9, 1.7, 1.5, 0.9, '♪ 노래를 예약하세요', '#101a3a', '#ffe36e'),
  sign('-x', 2.85, -3.1, 1.7, 1.5, 0.9, '♪ 다음 곡 준비 중', '#2a1038', '#7df3ff'),
  sign('+x', 3.15, -3.1, 1.7, 1.5, 0.9, '♪ 100점에 도전!', '#101a3a', '#ff8ad0'),
  // 복도 벽의 안내
  sign('+z', -HALF_Z + OUT_T, -3.5, 1.9, 3.2, 0.6, '자동문 · 가까이 오면 열려요', '#1a1430', '#ffe36e'),
  sign('+z', -HALF_Z + OUT_T, 5.6, 1.9, 2.6, 0.6, '음료 자판기 →', '#1a1430', '#7df3ff'),
  // 카운터 벽의 간판
  sign('+x', -HALF_X + OUT_T, 0, 2.3, 3.4, 0.9, '코인 노래방', '#2a1038', '#ff8ad0'),
  // 조명: 북쪽 복도 가운데와 서쪽 카운터(실제 조명), 방 안과 복도 귀퉁이(빛나는 등)
  { type: 'light', x: 0, y: 2.95, z: -6.6, color: '#ffd9f0', intensity: 3.2, dist: 18 },
  { type: 'light', x: -13.9, y: 2.95, z: 0, color: '#d9f6ff', intensity: 2.6, dist: 14 },
  { type: 'lantern', x: -6, y: 2.85, z: -2.5, r: 0.2, color: '#ff8ad0', cord: 0.3 },
  { type: 'lantern', x: 0, y: 2.85, z: -2.5, r: 0.2, color: '#7df3ff', cord: 0.3 },
  { type: 'lantern', x: 6, y: 2.85, z: -2.5, r: 0.2, color: '#ffe36e', cord: 0.3 },
  { type: 'lantern', x: -10.5, y: 2.85, z: -6.6, r: 0.2, color: '#7df3ff', cord: 0.3 },
  { type: 'lantern', x: 10.5, y: 2.85, z: -6.6, r: 0.2, color: '#ff8ad0', cord: 0.3 }
];

/** 팀 색 깃발. 카운터 안에서 바로 보이는 벽(복도 쪽 벽의 서쪽 면)에 건다 */
const teamDecor = (team) => [-2.6, 2.6].map((z) => (
  { type: 'banner', x: -LOBBY_X - WALL_T / 2 - 0.1, y: 1.7, z, rotY: FACE['-x'], w: 1.5, h: 2, text: team.name, emblem: 'ring', bg: team.color, fg: '#f4f1e8' }
));

/* ---------------- 스폰 ---------------- */

/** 카메라가 (x,z)에서 (tx,tz)를 보는 rotY */
const look = (x, z, tx, tz) => Math.atan2(-(tx - x), -(tz - z));
const spot = (x, z, tx, tz) => ({ x, z, rotY: look(x, z, tx, tz) });

// 카운터 앞 한 줄 여덟 곳(16명 방은 한 팀이 여덟이다). 가까운 문간을 보고 선다
const blue = [-4.55, -3.25, -1.95, -0.65, 0.65, 1.95, 3.25, 4.55].map((z) => spot(-13.9, z, -LOBBY_X, z > 0 ? 6.55 : -6.55));

const ffaHalf = [
  spot(-14.3, 7.1, -LOBBY_X, 6.55),   // 서쪽 카운터 남쪽 끝
  spot(-10.6, 1.2, -10.6, -6),        // 서쪽 복도 가운데
  spot(2.2, -3.9, -1.5, -5),          // 2번 방 안(탁자 뒤)
  spot(7.6, -6.8, -4, -6.6)           // 북쪽 복도 동쪽(자판기 앞)
];

/* ---------------- 소품 ---------------- */

const propsHalf = [
  { type: 'crate', x: -15, y: 0, z: -7.4, size: 0.8 },
  { type: 'crate', x: 4.6, y: 0, z: -7.5, size: 0.7 }
];

export default {
  id: 'karaoke',
  name: '코인 노래방',
  nameEn: 'Coin Karaoke',
  desc: '네온 복도가 방 여섯을 두른 노래방. 가까이 가면 열리는 자동문 뒤에 누가 있는지 문이 열려야 보인다.',
  tag: '좁은 맵',
  size: { x: HALF_X * 2, z: HALF_Z * 2 },
  rulesets: ['classic', 'knife'],
  theme: {
    // 천장이 덮여 하늘과 해는 보이지 않는다. 하늘색은 실내 간접광의 색으로만 쓰이므로 어둡지 않은 보랏빛으로 둔다
    sky: '#4a4470', skyTop: '#c4c8ff', fog: [34, 120], sunDir: [0.2, 0.95, 0.2],
    sunColor: '#c9d4ff', sunIntensity: 0.55, ambient: 1.25, ground: 'tile'
  },
  spawns: {
    owner: blue,
    charterer: rotate180(blue),
    ffa: [...ffaHalf, ...rotate180(ffaHalf)]
  },
  solids: [...half, ...rotate180(half), ...center],
  decor: [
    ...decorHalf,
    ...rotate180(decorHalf),
    ...labelled({ rooms: [1, 2, 3], side: 1 }),
    ...rotate180(labelled({ rooms: [6, 5, 4], side: 6 })),
    ...teamDecor(TEAMS.owner),
    ...rotate180(teamDecor(TEAMS.charterer))
  ],
  pads: [],
  movers: [...doorsNorth, ...rotate180(doorsNorth).map((m) => ({ ...m, id: SOUTH_ID[m.id] || m.id }))],
  portals: [],
  secrets: [],
  props: [...propsHalf, ...rotate180(propsHalf)]
};
