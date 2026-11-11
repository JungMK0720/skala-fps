/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 한옥 민박(Hanok Stay). 마당을 방 여덟이 ㅁ자로 두른 32×26 m 맵으로, 가까이 가면 옆으로 열리는 창호지 미닫이문 여덟 개 너머에서 갑자기 맞붙는다.
 */
import { TEAMS } from '../core/consts.js';
import { box, cyl, pillar, wall, doorwayWall, rotate180 } from './kit.js';

// 방위: 북 = -z, 남 = +z. 블루 = -x(서쪽 뒤안길), 레드 = +x(동쪽 뒤안길). 북서쪽 절반만 적고 rotate180으로 남동쪽을 만든다.
//
//        x -16    -13          -5.5                    5.5          13     16
//  z -13  ┌─────────────────────── 담장(높이 2.2) ───────────────────────────┐
//         │ 뒤안길       장작       [뒷문]          뒤안길                    │
//  z -10  │      ┌──────[   ]───────┬───────────────────────┬────────────┐   │
//         │      │ 건넌방(북서)     ╎ 대청(북)   병풍       ╎ 건넌방(북동)[뒷문]
//  z -4   │ 블루 ├──────╎틈╎────────┼─────[문]──────────────┼────╎틈╎────┤   │
//         │ 대기 │                  │ ▁▁▁▁▁ 툇마루 ▁▁▁▁▁▁▁ │            │레드│
//  z  0   │ 자리 │ 사랑방(서)      [문]    마당  ▭ 평상    [문] 부엌(동)  │대기│
//         │      │                  │ ▔▔▔▔▔ 툇마루 ▔▔▔▔▔▔▔ │            │자리│
//  z  4   │      ├──────╎틈╎────────┼──────────────[문]─────┼────╎틈╎────┤   │
//       [뒷문]   │ 건넌방(남서)     ╎ 대청(남)              ╎ 건넌방(남동)│   │
//  z  10  │      └──────────────────┴───────────────────────┴──[   ]─────┘   │
//         │                         뒤안길            [뒷문]      장작        │
//  z  13  └──────────────────────────────────────────────────────────────────┘
//
//  방은 기단(0.3 m) 위에 있고 기와지붕이 덮는다. 마당만 하늘이 열려 있다. 방끼리는 문 없는 틈으로 이어져 한 바퀴를 돈다.
//  마당으로 나가는 문 넷(대청 둘, 사랑방, 부엌)과 뒤안길로 나가는 뒷문 넷(건넌방마다 하나)은 창호지 미닫이문이다.
//  사람이 1.5 m 안에 오면 0.25초 만에 옆 벽 속으로 들어가고, 아무도 없으면 닫힌다. 닫혀 있으면 건너편이 보이지 않는다.
//  마당과 뒤안길 사이를 오가려면 반드시 방 둘과 문 둘을 지나야 한다.
//  두 팀은 동서 뒤안길에서 시작한다. 집채가 두 대기 자리 사이의 시야를 끊는다.

/* ---------------- 치수 ---------------- */

const HALF_X = 16;       // 맵 반폭
const HALF_Z = 13;
const FENCE_T = 0.4;     // 담장 두께
const FENCE_H = 2.2;     // 담장 높이
const HOUSE_X = 13;      // 집채의 동서 끝(기단 가장자리)
const HOUSE_Z = 10;      // 집채의 남북 끝
const YARD_X = 5.5;      // 마당 쪽 벽의 바깥 면(동서)
const YARD_Z = 4;        // 마당 쪽 벽의 바깥 면(남북)
const FLOOR = 0.3;       // 기단 = 방바닥 높이. 걸어서 오른다
const MAT = FLOOR + 0.02;   // 방바닥 장판 윗면
const WALL_T = 0.3;      // 벽 두께. 미닫이문(두께 0.08)이 이 속으로 들어간다
const WALL_H = 2.5;      // 방바닥에서 벽 윗면까지
const BEAM = 0.3;        // 벽 위 들보 높이
const EAVES = FLOOR + WALL_H + BEAM;   // 지붕 밑면(3.1)
const DOOR_W = 1.8;      // 문 폭 = 문간 폭
const DOOR_H = 2.1;      // 문 높이 = 문간 윗변(방바닥 기준)
const DOOR_T = 0.08;     // 문짝 두께
const DOOR_RUN = DOOR_W + 0.03;   // 열릴 때 가는 거리. 문짝 끝이 문설주 면보다 조금 더 들어가 벽 속에 숨는다
const LID_TOP = 9;       // 막이 윗면

// 벽 중심선: 바깥 면이 기단 가장자리와 맞도록 반 두께만큼 안으로 들인다
const NORTH_Z = -HOUSE_Z + WALL_T / 2;   // 북쪽 바깥 벽
const WEST_X = -HOUSE_X + WALL_T / 2;    // 서쪽 바깥 벽
const HALL_Z = -YARD_Z - WALL_T / 2;     // 대청과 마당 사이 벽(동서로 집 전체를 가로지른다)
const ROOM_X = -YARD_X - WALL_T / 2;     // 사랑방과 마당 사이 벽(남북으로 집 전체를 가로지른다)

const FACE = { '+x': Math.PI / 2, '-x': -Math.PI / 2, '+z': 0, '-z': Math.PI };
const out = (dir) => (dir[0] === '+' ? 1 : -1);

/** 미닫이문이 사람을 알아보는 거리와 여닫는 시간 */
const SLIDE = Object.freeze({ range: 1.5, open: 0.25, close: 0.6, linger: 0.8 });

/* ---------------- 도형 도우미 ---------------- */

const rect = (x0, z0, x1, z1, y0, y1, mat) => box((x0 + x1) / 2, y0, (z0 + z1) / 2, x1 - x0, y1 - y0, z1 - z0, mat);
const DOORWAY = { w: DOOR_W, top: DOOR_H, y: FLOOR };

/** 담장 한 줄: 돌 몸통, 기와 갓, 그 위 막이 */
const fence = (x0, z0, x1, z1) => [
  rect(x0, z0, x1, z1, 0, FENCE_H, 'stone'),
  rect(x0, z0, x1, z1, FENCE_H, FENCE_H + 0.18, 'metal_dark'),
  rect(x0, z0, x1, z1, FENCE_H + 0.18, LID_TOP, 'clip')
];

/** 장독 셋: 낮은 돌 받침 위의 항아리. 가장 큰 것은 앉으면 가려진다 */
const jars = (x, z) => [
  cyl(x, 0, z, 0.48, 1.05, 'rust'),
  cyl(x + 0.95, 0, z + 0.2, 0.38, 0.8, 'rust'),
  cyl(x + 0.3, 0, z + 0.95, 0.34, 0.65, 'rust')
];

/* ---------------- 절반: 담장, 기단, 벽 ---------------- */

const grounds = [
  // 북쪽 담장은 맵 폭 전체다(돌리면 남쪽 담장). 서쪽 담장은 그 사이를 잇는다(돌리면 동쪽 담장)
  fence(-HALF_X, -HALF_Z, HALF_X, -HALF_Z + FENCE_T),
  fence(-HALF_X, -HALF_Z + FENCE_T, -HALF_X + FENCE_T, HALF_Z - FENCE_T),
  // 기단: 북쪽 채(집 폭 전체)와 서쪽 채(마당 옆). 돌리면 남쪽 채와 동쪽 채
  rect(-HOUSE_X, -HOUSE_Z, HOUSE_X, -YARD_Z, 0, FLOOR, 'stone'),
  rect(-HOUSE_X, -YARD_Z, -YARD_X, YARD_Z, 0, FLOOR, 'stone'),
  // 툇마루: 대청 앞(북쪽)과 사랑방 앞(서쪽). 방바닥과 같은 높이의 나무 마루다
  rect(-YARD_X, -YARD_Z, YARD_X, -YARD_Z + 1, 0, FLOOR, 'wood'),
  rect(-YARD_X, -YARD_Z + 1, -YARD_X + 1, YARD_Z - 1, 0, FLOOR, 'wood'),
  // 문 앞 댓돌(마당에서 마루로 오르는 낮은 돌)
  rect(-2.7, -YARD_Z + 1, -1.3, -YARD_Z + 1.45, 0, 0.15, 'stone'),
  rect(-YARD_X + 1, 0.8, -YARD_X + 1.45, 2.2, 0, 0.15, 'stone'),
  // 방바닥 장판(2 cm): 북쪽 채의 방 셋과 사랑방. 벽 안쪽 면까지만 깔아 문간에는 기단의 돌이 문지방처럼 보인다
  rect(-HOUSE_X + WALL_T, -HOUSE_Z + WALL_T, ROOM_X - WALL_T / 2, HALL_Z - WALL_T / 2, FLOOR, MAT, 'wood'),
  rect(ROOM_X + WALL_T / 2, -HOUSE_Z + WALL_T, -ROOM_X - WALL_T / 2, HALL_Z - WALL_T / 2, FLOOR, MAT, 'wood'),
  rect(-ROOM_X + WALL_T / 2, -HOUSE_Z + WALL_T, HOUSE_X - WALL_T, HALL_Z - WALL_T / 2, FLOOR, MAT, 'wood'),
  rect(-HOUSE_X + WALL_T, HALL_Z + WALL_T / 2, ROOM_X - WALL_T / 2, -HALL_Z - WALL_T / 2, FLOOR, MAT, 'wood')
].flat();

const walls = [
  // 북쪽 바깥 벽: 북서 건넌방 뒷문 하나
  doorwayWall(-HOUSE_X, NORTH_Z, HOUSE_X, NORTH_Z, WALL_H, WALL_T, 'plaster', { ...DOORWAY, at: -9.25 }),
  // 서쪽 바깥 벽: 남서 건넌방 뒷문 하나
  doorwayWall(WEST_X, -HOUSE_Z + WALL_T, WEST_X, HOUSE_Z - WALL_T, WALL_H, WALL_T, 'plaster', { ...DOORWAY, at: 7 }),
  // 북쪽 채의 남쪽 벽: 건넌방과 사랑방 사이 틈, 대청에서 마당으로 나가는 문, 건넌방과 부엌 사이 틈
  doorwayWall(-HOUSE_X + WALL_T, HALL_Z, HOUSE_X - WALL_T, HALL_Z, WALL_H, WALL_T, 'plaster', { ...DOORWAY, at: [-9.25, -2, 9.25] }),
  // 서쪽 채의 동쪽 벽: 건넌방과 대청 사이 틈(북), 사랑방에서 마당으로 나가는 문, 건넌방과 대청 사이 틈(남)
  doorwayWall(ROOM_X, -HOUSE_Z + WALL_T, ROOM_X, HOUSE_Z - WALL_T, WALL_H, WALL_T, 'plaster', { ...DOORWAY, at: [-7, 1.5, 7] }),
  // 벽 위 들보(벽과 같은 평면)
  wall(-HOUSE_X, NORTH_Z, HOUSE_X, NORTH_Z, BEAM, WALL_T, 'wood_dark', FLOOR + WALL_H),
  wall(WEST_X, -HOUSE_Z + WALL_T, WEST_X, HOUSE_Z - WALL_T, BEAM, WALL_T, 'wood_dark', FLOOR + WALL_H),
  wall(-HOUSE_X + WALL_T, HALL_Z, HOUSE_X - WALL_T, HALL_Z, BEAM, WALL_T, 'wood_dark', FLOOR + WALL_H),
  wall(ROOM_X, -HOUSE_Z + WALL_T, ROOM_X, HOUSE_Z - WALL_T, BEAM, WALL_T, 'wood_dark', FLOOR + WALL_H)
].flat();

const roofs = [
  // 기와지붕: 북쪽 채(처마가 툇마루와 뒤안길 위로 내민다)와 서쪽 채. 그 위 용마루
  rect(-HOUSE_X - 0.8, -HOUSE_Z - 0.8, HOUSE_X + 0.8, -YARD_Z + 1.1, EAVES, EAVES + 0.3, 'metal_dark'),
  rect(-HOUSE_X - 0.8, -YARD_Z + 1.1, -YARD_X + 1.1, YARD_Z - 1.1, EAVES, EAVES + 0.3, 'metal_dark'),
  rect(-HOUSE_X + 1.5, -7.6, HOUSE_X - 1.5, -6.4, EAVES + 0.3, EAVES + 0.75, 'metal_dark'),
  rect(-9.9, -YARD_Z + 1.1, -8.7, YARD_Z - 1.1, EAVES + 0.3, EAVES + 0.75, 'metal_dark'),
  // 툇마루 기둥(처마를 받친다)
  // 문 앞은 비워 둔다(북쪽 대청 문 x -2, 돌린 남쪽 대청 문 x 2, 사랑방 문 z 1.5, 돌린 부엌 문 z -1.5)
  ...[-5.3, -3.6, 0, 3.6, 5.3].map((x) => pillar(x, -YARD_Z + 0.9, WALL_H + BEAM, 0.2, 'wood_dark', FLOOR)),
  ...[-2.4, -0.3].map((z) => pillar(-YARD_X + 0.9, z, WALL_H + BEAM, 0.2, 'wood_dark', FLOOR))
];

/* ---------------- 절반: 방 안과 마당, 뒤안길의 살림 ---------------- */

const stuff = [
  // 북쪽 대청: 병풍(몸을 다 가린다), 소반, 뒤주
  rect(2.6, -8.9, 2.8, -6.3, FLOOR, FLOOR + 1.9, 'paper'),
  rect(-0.6, -7.8, 0.8, -6.9, FLOOR, FLOOR + 0.4, 'wood_dark'),
  rect(-5.1, -9.6, -4, -8.9, FLOOR, FLOOR + 0.9, 'wood_dark'),
  // 북서 건넌방: 이불장(서쪽 벽)과 반닫이
  rect(-12.6, -8.6, -12, -6.4, FLOOR, FLOOR + 1.9, 'wood_dark'),
  rect(-7.4, -5.5, -6.2, -4.7, FLOOR, FLOOR + 0.8, 'wood'),
  // 사랑방: 서안(낮은 책상)과 책장
  rect(-10.4, -0.5, -9, 0.4, FLOOR, FLOOR + 0.45, 'wood_dark'),
  rect(-12.6, 1.6, -12.1, 3.4, FLOOR, FLOOR + 1.7, 'wood'),
  // 남서 건넌방(돌리면 북동 건넌방): 뒤주와 쌀가마
  rect(-8.2, 8.8, -6.8, 9.6, FLOOR, FLOOR + 0.9, 'wood_dark'),
  rect(-11, 4.8, -10, 5.6, FLOOR, FLOOR + 0.7, 'sand'),
  // 마당 북서 구석의 장독대
  rect(-4.3, -2.9, -2.3, -1.2, 0, 0.12, 'stone'),
  ...jars(-3.8, -2.5),
  // 뒤안길: 북쪽 담장 앞 장작더미, 서쪽 뒤안길 북쪽 끝의 굴뚝
  rect(-1.6, -HALF_Z + FENCE_T, 1, -11.9, 0, 1, 'wood'),
  pillar(-13.3, -9.2, 3.6, 0.6, 'brick')
];

const half = [...grounds, ...walls, ...roofs, ...stuff];

/* ---------------- 가운데: 마당의 평상 (돌리지 않는다) ---------------- */

const center = [
  rect(-1.5, -0.9, 1.5, 0.9, 0.3, 0.45, 'wood'),
  ...[[-1.35, -0.75], [1.35, -0.75], [-1.35, 0.75], [1.35, 0.75]].map(([x, z]) => pillar(x, z, 0.3, 0.16, 'wood_dark'))
];

/* ---------------- 미닫이문 ---------------- */

/** 동서로 놓인 벽의 문(문짝이 x로 길다). slide = 열릴 때 가는 방향(+1 동, -1 서) */
const doorX = (id, x, z, slide) => ({ id, x, y: FLOOR, z, w: DOOR_W, h: DOOR_H, d: DOOR_T, mat: 'paper', axis: 'x', dist: slide * DOOR_RUN, door: SLIDE });
/** 남북으로 놓인 벽의 문(문짝이 z로 길다). slide = 열릴 때 가는 방향(+1 남, -1 북) */
const doorZ = (id, x, z, slide) => ({ id, x, y: FLOOR, z, w: DOOR_T, h: DOOR_H, d: DOOR_W, mat: 'paper', axis: 'z', dist: slide * DOOR_RUN, door: SLIDE });

// 북서쪽 절반의 문 넷. 돌린 복사본이 남동쪽 절반의 문 넷이 된다
const doorsHalf = [
  doorX('door_hall_n', -2, HALL_Z, 1),          // 북쪽 대청 → 마당
  doorZ('door_room_w', ROOM_X, 1.5, -1),        // 사랑방 → 마당
  doorX('door_back_nw', -9.25, NORTH_Z, 1),     // 북서 건넌방 → 북쪽 뒤안길
  doorZ('door_back_sw', WEST_X, 7, -1)          // 남서 건넌방 → 서쪽 뒤안길
];
const TWIN_ID = { door_hall_n_r: 'door_hall_s', door_room_w_r: 'door_room_e', door_back_nw_r: 'door_back_se', door_back_sw_r: 'door_back_ne' };

/* ---------------- 장식 ---------------- */

/** 벽면(dir 쪽을 보는 면, 좌표 fixed) 앞 off만큼 떨어진 자리와 그 벽이 보는 방향. c = 벽 방향 좌표 */
const on = (dir, fixed, c, y, off = 0.05) => (dir[1] === 'x'
  ? { x: fixed + out(dir) * off, y, z: c, rotY: FACE[dir] }
  : { x: c, y, z: fixed + out(dir) * off, rotY: FACE[dir] });

const sign = (dir, fixed, c, y, w, h, text, bg = '#3a2a1c', fg = '#f1e9d0') => ({ type: 'sign', ...on(dir, fixed, c, y), w, h, text, bg, fg });
/** 처마 밑에 매단 청사초롱 */
const lamp = (x, z, color) => ({ type: 'lantern', x, y: EAVES - 0.55, z, r: 0.2, color, cord: 0.3 });

/** 절반마다 글자가 다른 문패. 남동쪽은 돌려서 쓴다 */
const labelled = ({ hall, room, backA, backB }) => [
  sign('+z', -YARD_Z, -2, FLOOR + 2.32, 1.5, 0.36, hall),
  sign('+x', -YARD_X, 1.5, FLOOR + 2.32, 1.5, 0.36, room),
  sign('-z', -HOUSE_Z, -9.25, FLOOR + 2.32, 1.5, 0.36, backA),
  sign('-x', -HOUSE_X, 7, FLOOR + 2.32, 1.5, 0.36, backB)
];

const decorHalf = [
  // 처마 밑 청사초롱: 대청 앞 툇마루, 사랑방 앞 툇마루, 뒷문 옆
  // (툇마루 기둥 x -5.3·-3.6·0·3.6·5.3, z -2.4·-0.3과 겹치지 않는 자리)
  lamp(-4.45, -YARD_Z + 0.9, '#ff7a6b'), lamp(-1.8, -YARD_Z + 0.9, '#6bb8ff'), lamp(1.8, -YARD_Z + 0.9, '#ff7a6b'), lamp(4.45, -YARD_Z + 0.9, '#6bb8ff'),
  lamp(-YARD_X + 0.9, 1.5, '#ff7a6b'),
  lamp(-11, -HOUSE_Z - 0.5, '#ffd27a'), lamp(-HOUSE_X - 0.5, 5.2, '#ffd27a'),
  // 방 안 등(실제 조명은 대청과 사랑방)
  { type: 'light', x: 0, y: EAVES - 0.35, z: -7, color: '#ffe2b8', intensity: 1.2, dist: 13 },
  { type: 'light', x: -9.3, y: EAVES - 0.35, z: 0, color: '#ffe2b8', intensity: 1.1, dist: 11 },
  lamp(-9.3, -7, '#ffe2b8'), lamp(-9.3, 7, '#ffe2b8'),
  // 담장 밖 대나무와 벚나무
  { type: 'bamboo', x: -6, y: 0, z: -14.2, h: 6.5, n: 7 },
  { type: 'bamboo', x: 9, y: 0, z: -14.4, h: 7, n: 8 },
  { type: 'bamboo', x: -17.4, y: 0, z: 4, h: 6.5, n: 7 },
  { type: 'tree', x: 13, y: 0, z: -15.4, h: 6.2 },
  { type: 'tree', x: -18.2, y: 0, z: -8.5, h: 5.6 },
  // 뒤안길 벽의 안내
  sign('-z', -HOUSE_Z, 3, FLOOR + 1.5, 2.6, 0.5, '미닫이문 · 다가가면 열려요', '#e8dcc0', '#3a2a1c')
];

/** 팀 색 깃발. 대기 자리에서 바로 보이는 집채 서쪽 벽에 건다 */
const teamDecor = (team) => [-2.4, 2.4].map((z) => (
  { type: 'banner', x: -HOUSE_X - 0.1, y: 1.75, z, rotY: FACE['-x'], w: 1.5, h: 1.9, text: team.name, emblem: 'ring', bg: team.color, fg: '#f4f1e8' }
));

/* ---------------- 스폰 ---------------- */

/** 카메라가 (x,z)에서 (tx,tz)를 보는 rotY */
const look = (x, z, tx, tz) => Math.atan2(-(tx - x), -(tz - z));
const spot = (x, z, tx, tz) => ({ x, z, rotY: look(x, z, tx, tz) });

// 서쪽 뒤안길 한 줄 여덟 곳(16명 방은 한 팀이 여덟이다). 북쪽은 뒤안길 모퉁이를, 남쪽은 남서 건넌방 뒷문을 보고 선다
const blue = [-4.55, -3.25, -1.95, -0.65, 0.65, 1.95, 3.25, 4.55].map((z) => spot(-14.3, z, -14.3, z > 0 ? 7 : -11));

const ffaHalf = [
  spot(4.2, -7.6, -2, -4.2),        // 북쪽 대청 안(병풍 뒤). 마당에는 스폰을 두지 않는다: 마당은 문이 열리며 마주치는 자리다
  spot(-9.25, -7, -9.25, -4),       // 북서 건넌방 안
  spot(6, -11.3, 0, -11.3),         // 북쪽 뒤안길
  spot(-10.6, -1.6, -6, 1.5)        // 사랑방 안
];

/* ---------------- 소품 ---------------- */

const propsHalf = [
  { type: 'crate', x: -14.9, y: 0, z: -11.9, size: 0.8 },
  { type: 'barrel', x: 3.4, y: 0, z: -11.8 },
  { type: 'crate', x: 10.4, y: MAT, z: -8.9, size: 0.7 }
];

export default {
  id: 'hanok',
  name: '한옥 민박',
  nameEn: 'Hanok Stay',
  desc: '마당을 방 여덟이 두른 한옥. 창호지 미닫이문이 열리기 전에는 건너편에 누가 있는지 알 수 없다.',
  tag: '좁은 맵',
  size: { x: HALF_X * 2, z: HALF_Z * 2 },
  rulesets: ['classic', 'knife'],
  theme: {
    sky: '#bcd9ee', skyTop: '#5b8fc4', fog: [45, 170], sunDir: [-0.35, 0.86, 0.36],
    sunColor: '#fff0d2', sunIntensity: 0.95, ambient: 0.82, ground: 'sand'
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
    ...labelled({ hall: '대청', room: '사랑방', backA: '건넌방 뒷문', backB: '건넌방 뒷문' }),
    ...rotate180(labelled({ hall: '대청', room: '부엌', backA: '건넌방 뒷문', backB: '건넌방 뒷문' })),
    ...teamDecor(TEAMS.owner),
    ...rotate180(teamDecor(TEAMS.charterer))
  ],
  pads: [],
  movers: [...doorsHalf, ...rotate180(doorsHalf).map((m) => ({ ...m, id: TWIN_ID[m.id] || m.id }))],
  portals: [],
  secrets: [],
  props: [...propsHalf, ...rotate180(propsHalf)]
};
