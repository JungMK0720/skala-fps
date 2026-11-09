/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 통합 맵 '벚꽃 도장'(클래식·칼전·스나전). 해 질 녘 담장 안 절 마당으로, 탑을 둘러싼 돌 안뜰, 나무 회랑, 모퉁이 방,
 *          남북 옥상 회랑, 탑 꼭대기와 숨은 정원 비밀 스팟을 180° 회전 대칭으로 담은 순수 데이터다.
 */
/*
 * 방위: 북 = -z(블루), 남 = +z(오렌지). 절반(북쪽 건물, 동쪽 회랑, 안뜰 낮은 벽)을 쓰고 rotate180으로 나머지를 만든다.
 *
 *   z=-22 ┌───────────────── 담 + 옥상 회랑 y 4.7 (발판으로 오름) ─────────────────┐
 *         │ 모퉁이 방 │ 도장 서쪽 칸 │ 도장 가운데 칸 │ 도장 동쪽 칸 │ 모퉁이 방 │  z -21 ~ -14
 *   z=-14 ├───────┬───┴──── 나무 회랑 y 0.6 (계단·낮은 점프) ────┴───┬───────┤
 *         │ 뒤뜰  │  ◆발판                안뜰               발판◆  │ 뒤뜰  │  x ±14 ~ ±21
 *         │ 창고  │        낮은 벽 고리 ┌─ 탑 ─┐ 낮은 벽 고리        │대나무 │
 *         │       │                     └──────┘                     │ 정원  │
 *   z=+14 ├───────┴───┬──── 나무 회랑 ───────────────────┬───┴───────┤
 *         │ 모퉁이 방 │ 도장 ...                              │ 모퉁이 방 │
 *   z=+22 └─────────────────────────────────────────────────────────┘
 *
 * 동선: 안뜰 네 귀의 분홍 발판 → 옥상 회랑 → 회랑 가운데 하늘색 발판 → 탑 꼭대기(명상 지붕).
 *       동북·서남 모퉁이 방의 병풍 뒤 포털 → 숨은 정원(동쪽 대나무 담 안) → 돌아오는 포털 → 대나무 숲.
 */
import { box, ramp, cyl, pillar, stairs, doorwayWall, clipAbove, mirrorX, mirrorZ, rotate180 } from './kit.js';

const PI = Math.PI;
const DECK = 0.6;      // 회랑·건물 바닥 높이
const GAL = 4.7;       // 옥상 회랑 바닥 높이
const EAVE = 3.7;      // 남북 처마 끝 높이
const CEIL = 3.66;     // 도장·회랑 천장 높이(처마 밑면). 마루에서 뛰어도 머리가 닿지 않는다
const TOP = 8.2;       // 탑 꼭대기 마루 높이
const PAVE = 0.03;     // 안뜰 돌 포장 윗면
const INLAY = 0.05;    // 돌 포장 위 타일·모래 윗면

/* ---------------- 도형 도우미 ---------------- */

/** 낮은 벽 + 기와 갓. h가 갓까지 포함한 전체 높이다 */
function lowWall(x, z, w, d, h) {
  const cap = 0.08, over = 0.14;
  return [box(x, 0, z, w, h - cap, d, 'plaster'), box(x, h - cap, z, w + over, cap, d + over, 'tile')];
}

/** 돌 등롱: 눈높이를 가리는 기둥. 가운데 창호지가 빛난다 */
function stoneLantern(x, z, y = 0) {
  return [box(x, y, z, 0.8, 1.5, 0.8, 'stone'), box(x, y + 1.5, z, 0.62, 0.6, 0.62, 'paper'), box(x, y + 2.1, z, 1.1, 0.2, 1.1, 'tile')];
}

/** 탑의 네 변 (u = 변을 따라, v = 가운데에서 바깥으로) */
const SIDES = [(u, v) => [u, -v], (u, v) => [v, u], (u, v) => [-u, v], (u, v) => [-v, -u]];
const INWARD = ['+z', '-x', '-z', '+x'];
const CORNERS = [[-1, -1], [1, -1], [1, 1], [-1, 1]];

/** 네 변에 같은 상자를 놓는다. wu = 변 방향 길이, wv = 바깥 방향 두께 */
function ringBox(u, y, v, wu, h, wv, mat) {
  return SIDES.map((at, i) => {
    const [x, z] = at(u, v);
    return i % 2 ? box(x, y, z, wv, h, wu, mat) : box(x, y, z, wu, h, wv, mat);
  });
}

/** 네 변에서 가운데로 올라가는 지붕. outer에서 y, inner에서 y + h */
function ringRoof(inner, outer, y, h) {
  const v = (inner + outer) / 2, wv = outer - inner, wu = outer * 2;
  return SIDES.map((at, i) => {
    const [x, z] = at(0, v);
    return i % 2 ? ramp(x, y, z, wv, h, wu, INWARD[i], 'tile') : ramp(x, y, z, wu, h, wv, INWARD[i], 'tile');
  });
}

/** 네 귀 기둥 */
function cornerPosts(half, h, s, y) {
  return CORNERS.map(([sx, sz]) => pillar(sx * half, sz * half, h, s, 'wood_dark', y));
}

/* ---------------- 가운데: 탑 ---------------- */

const pagoda = [
  // 기단과 1층 마루
  box(0, 0, 0, 9.6, 0.2, 9.6, 'stone'),
  box(0, 0.2, 0, 8.4, 0.2, 8.4, 'stone'),
  box(0, 0.4, 0, 6.6, 0.03, 6.6, 'wood'),
  // 1층: 네 문과 가운데 심주. 안쪽은 한 바퀴 도는 좁은 복도다
  box(0, 0.4, 0, 2.6, 2.8, 2.6, 'wood_dark'),
  ringBox(-2.1, 0.4, 3.4, 2.2, 2.3, 0.2, 'paper'),
  ringBox(2.1, 0.4, 3.4, 2.2, 2.3, 0.2, 'paper'),
  ringBox(0, 2.7, 3.4, 6.8, 0.5, 0.3, 'plaster'),
  ringBox(-1.02, 0.4, 3.4, 0.24, 2.3, 0.34, 'wood_dark'),
  ringBox(1.02, 0.4, 3.4, 0.24, 2.3, 0.34, 'wood_dark'),
  cornerPosts(3.4, 2.8, 0.5, 0.4),
  // 복도 귀 기둥: 이웃한 두 문을 꿰는 대각선 시야를 끊는다
  cornerPosts(1.72, 2.8, 0.8, 0.4),
  // 1층 처마와 피해 다닐 기둥
  ringRoof(2.4, 6.1, 3.2, 1.5),
  box(0, 3.16, 0, 12, 0.04, 12, 'wood'),
  ringBox(0, 3.05, 6, 12.2, 0.15, 0.2, 'wood_dark'),
  ringBox(-3, 0, 5.9, 0.3, 3.05, 0.3, 'wood_dark'),
  ringBox(3, 0, 5.9, 0.3, 3.05, 0.3, 'wood_dark'),
  cornerPosts(5.9, 3.05, 0.34, 0),
  // 2층
  box(0, 3.2, 0, 4.8, 2.7, 4.8, 'paper'),
  cornerPosts(2.4, 2.7, 0.34, 3.2),
  ringRoof(2.4, 4.9, 5.9, 1),
  box(0, 5.86, 0, 9.6, 0.04, 9.6, 'wood'),
  ringBox(0, 5.75, 4.8, 9.8, 0.15, 0.2, 'wood_dark'),
  // 목과 까치발, 꼭대기 마루
  box(0, 5.9, 0, 4.8, 1.55, 4.8, 'wood_dark'),
  box(0, 7.45, 0, 5.8, 0.2, 5.8, 'wood_dark'),
  box(0, 7.65, 0, 6.7, 0.25, 6.7, 'wood_dark'),
  box(0, 7.9, 0, 7.6, 0.3, 7.6, 'wood'),
  ringBox(0, TOP, 3.72, 7.6, 0.26, 0.1, 'wood_dark'),
  // 정자 지붕과 상륜
  cornerPosts(3.45, 3.4, 0.3, TOP),
  ringRoof(1, 4.5, 11.6, 1.3),
  box(0, 11.56, 0, 9, 0.04, 9, 'wood'),
  box(0, 11.6, 0, 2, 1.3, 2, 'tile'),
  box(0, 12.9, 0, 2.3, 0.16, 2.3, 'tile'),
  cyl(0, 13.06, 0, 0.14, 2.3, 'metal_dark'),
  cyl(0, 13.6, 0, 0.42, 0.12, 'metal_dark'),
  cyl(0, 14, 0, 0.34, 0.12, 'metal_dark'),
  cyl(0, 14.4, 0, 0.26, 0.12, 'metal_dark')
].flat();

/* ---------------- 절반: 안뜰 ---------------- */

const courtHalf = [
  // 포장 무늬: 탑을 도는 갈퀴 모래 길과 나무 밑 이끼 정원. 지붕 기와와 색이 달라 위에서 봐도 길이 읽힌다
  box(0, PAVE, -6.375, 15.9, INLAY - PAVE, 3.15, 'sand'),
  box(6.375, PAVE, 0, 3.15, INLAY - PAVE, 9.6, 'sand'),
  box(5.35, PAVE, -9.75, 4.5, INLAY - PAVE, 2.3, 'moss'),
  box(-5.35, PAVE, -9.75, 4.5, INLAY - PAVE, 2.3, 'moss'),
  box(9.75, PAVE, -3.8, 2.3, INLAY - PAVE, 3.6, 'moss'),
  box(9.75, PAVE, 3.8, 2.3, INLAY - PAVE, 3.6, 'moss'),
  box(12.6, 0, 0, 3.2, PAVE, 6, 'stone'),
  // 낮은 벽 고리: 무릎 높이는 그냥 넘고 허리 높이는 뛰어넘는다
  lowWall(-3.85, -8.2, 4.1, 0.5, 0.45),
  lowWall(3.85, -8.2, 4.1, 0.5, 0.95),
  lowWall(8.2, -3.85, 0.5, 4.1, 0.45),
  lowWall(8.2, 3.85, 0.5, 4.1, 0.95),
  // 돌 등롱: 네 귀와 축 위. 안뜰을 가로지르는 시야를 끊는다
  stoneLantern(8.2, -8.2),
  stoneLantern(-8.2, -8.2),
  stoneLantern(0, -9.35),
  box(9.7, 0, 0, 2.6, 0.25, 0.5, 'stone'),
  box(9.7, 0.25, 0, 2.4, 2.05, 0.2, 'paper'),
  box(9.7, 2.3, 0, 2.7, 0.12, 0.5, 'tile'),
  // 나무 화단
  box(4.9, 0, -9.75, 1.2, 0.24, 1.2, 'stone'),
  box(-4.9, 0, -9.75, 1.2, 0.24, 1.2, 'stone'),
  box(9.75, 0, -3.8, 1.2, 0.24, 1.2, 'stone'),
  box(9.75, 0, 3.8, 1.2, 0.24, 1.2, 'stone')
].flat();

/* ---------------- 절반: 동쪽 회랑 (mirrorZ로 위아래) ---------------- */

const eastWing = [
  box(12.4, 0, -7, 2.8, DECK, 8, 'wood'),
  box(10.5, 0, -7.1, 1, DECK / 2, 2.4, 'stone'),
  doorwayWall(14, -13.8, 14, -3, 3.4, 0.4, 'plaster', { at: -8.4, w: 2.2, top: 3, sill: DECK }),
  ramp(14.8, 0, -8.4, 1.2, DECK, 2.4, '-x', 'wood_dark'),
  box(16.2, 0, -8.4, 0.2, 2.6, 3.4, 'bamboo'),
  pillar(14, -3, 3.4, 0.5, 'wood_dark'),
  ramp(13, 3.4, -7.3, 2.8, 0.8, 8.6, '+x', 'tile'),
  box(13, 3.36, -7.3, 2.8, 0.04, 8.5, 'wood'),
  box(11.7, 3.2, -7.3, 0.3, 0.2, 8.6, 'wood_dark'),
  pillar(11.7, -7.2, 2.6, 0.3, 'wood_dark', DECK),
  pillar(11.7, -3.2, 2.6, 0.3, 'wood_dark', DECK)
].flat();

/* ---------------- 절반: 북쪽 건물과 옥상 회랑 ---------------- */

const FRONT_DOORS = [-9.2, 0, 9.2];
const cornerRoom = [
  box(17.7, 0, -17.7, 7, DECK, 7, 'wood_dark'),
  doorwayWall(14, -21.2, 14, -13.8, 3.7, 0.4, 'plaster', { at: -16.4, w: 2.2, top: 3, sill: DECK }),
  doorwayWall(14.2, -14, 21.2, -14, 3.7, 0.4, 'plaster', { at: 17.8, w: 2.2, top: 3, sill: DECK }),
  ramp(17.8, 0, -13.2, 2.4, DECK, 1.2, '-z', 'wood_dark'),
  box(17.8, DECK, -15.8, 3, 2.3, 0.16, 'paper'),
  // 병풍: 뒤쪽 좁은 칸을 가린다
  box(18.9, DECK, -18.2, 4.6, 2.6, 0.2, 'paper'),
  box(18.9, 3.2, -18.2, 4.6, CEIL - 3.2, 0.3, 'wood_dark'),
  pillar(16.55, -18.2, CEIL - DECK, 0.3, 'wood_dark', DECK),
  // 동쪽 담의 높은 부분
  box(21.6, 0, -17.6, 0.8, 5.9, 7.2, 'plaster')
].flat();
const cornerCap = box(21.6, 5.9, -17.6, 1, 0.18, 7.2, 'tile');
const northCap = box(0, 5.9, -21.6, 44, 0.18, 1, 'tile');
const eastCap = box(21.6, 4.6, 0, 1, 0.16, 28, 'tile');

const galleryScreen = [
  box(5.2, GAL, -19.7, 0.2, 2.2, 3, 'paper'),
  pillar(5.2, -18.1, 2.3, 0.3, 'wood_dark', GAL)
];

const northHall = [
  // 바깥 담
  box(0, 0, -21.6, 44, 5.9, 0.8, 'plaster'),
  northCap,
  box(21.6, 0, 0, 0.8, 4.6, 28, 'plaster'),
  eastCap,
  cornerRoom,
  cornerCap,
  mirrorX(cornerRoom),
  mirrorX([cornerCap]),
  clipAbove([northCap, cornerCap, ...mirrorX([cornerCap])], 12),
  // 회랑과 도장 마루
  box(0, 0, -16.1, 27.6, DECK, 10.2, 'wood'),
  box(0, 0, -10.5, 6, DECK / 2, 1, 'stone'),
  box(0, DECK, -21.12, 42.4, 1, 0.16, 'wood_dark'),
  // 도장 정면: 창호지 벽과 문 셋
  box(-12.15, DECK, -14, 3.3, 2.4, 0.2, 'paper'),
  box(-4.6, DECK, -14, 6.6, 2.4, 0.2, 'paper'),
  box(4.6, DECK, -14, 6.6, 2.4, 0.2, 'paper'),
  box(12.15, DECK, -14, 3.3, 2.4, 0.2, 'paper'),
  box(0, 3, -14, 27.6, 0.7, 0.3, 'plaster'),
  FRONT_DOORS.flatMap((x) => [
    pillar(x - 1.3, -14, 2.4, 0.3, 'wood_dark', DECK),
    pillar(x + 1.3, -14, 2.4, 0.3, 'wood_dark', DECK)
  ]),
  // 문 안쪽 가림막: 안뜰에서 도장 안이 곧바로 보이지 않고, 뒤로 돌아 들어간다.
  // 양옆 가림막은 안쪽 끝을 x ±7.2까지 늘려 동서 뒤뜰 입구에서 옆문을 거쳐 스폰을 비스듬히 쏘는 시야를 막는다(총 규칙)
  box(-10.05, DECK, -16.1, 5.7, 2.3, 0.16, 'paper'),
  box(0, DECK, -16.1, 5, 2.3, 0.16, 'paper'),
  box(10.05, DECK, -16.1, 5.7, 2.3, 0.16, 'paper'),
  // 회랑을 곧게 꿰뚫어 보지 못하게 벽에서 내민 칸막이
  box(-6, DECK, -13.2, 0.16, 2.4, 1.3, 'paper'),
  box(6, DECK, -13.2, 0.16, 2.4, 1.3, 'paper'),
  // 칸막이: 문을 어긋나게 두어 도장을 길게 꿰뚫어 보지 못하게 한다
  doorwayWall(-5, -21.2, -5, -14.15, 3.1, 0.2, 'paper', { at: -19.4, w: 2.2, top: 2.4, y: DECK }),
  doorwayWall(5, -21.2, 5, -14.15, 3.1, 0.2, 'paper', { at: -15.9, w: 2.2, top: 2.4, y: DECK }),
  // 처마와 기둥
  ramp(0, EAVE, -13.5, 42.4, 1, 3.8, '-z', 'tile'),
  box(0, CEIL, -13.575, 42.4, EAVE - CEIL, 3.65, 'wood'),
  box(0, 3.5, -11.75, 42.4, 0.2, 0.3, 'wood_dark'),
  [-13, -8.4, -3.2, 3.2, 8.4, 13].map((x) => pillar(x, -11.75, 2.9, 0.32, 'wood_dark', DECK)),
  // 옥상 회랑
  box(0, CEIL, -18.3, 42.4, GAL - CEIL, 5.8, 'wood'),
  galleryScreen,
  mirrorX(galleryScreen),
  // 하늘색 발판 뒤의 문
  pillar(-2.4, -20.6, 3.6, 0.36, 'wood_dark', GAL),
  pillar(2.4, -20.6, 3.6, 0.36, 'wood_dark', GAL),
  box(0, GAL + 3, -20.6, 5.6, 0.2, 0.3, 'wood_dark'),
  box(0, GAL + 3.6, -20.6, 6.6, 0.28, 0.46, 'wood_dark')
].flat(2);

/* ---------------- 동쪽만: 숨은 정원 / 서쪽만: 곳간 (움직일 수 있는 윤곽은 같다) ---------------- */

const FENCE_X = 17.4, GARDEN_Z = 6.5;
const gardenCaps = [
  box(FENCE_X, 3.2, 0, 0.5, 0.12, GARDEN_Z * 2 + 0.2, 'wood_dark'),
  box(19.3, 3.4, -GARDEN_Z, 3.8, 0.12, 0.5, 'tile'),
  box(19.3, 3.4, GARDEN_Z, 3.8, 0.12, 0.5, 'tile')
];
const gardenSolids = [
  box(FENCE_X, 0, 0, 0.3, 3.2, GARDEN_Z * 2 + 0.2, 'bamboo'),
  box(19.3, 0, -GARDEN_Z, 3.8, 3.4, 0.3, 'plaster'),
  box(19.3, 0, GARDEN_Z, 3.8, 3.4, 0.3, 'plaster'),
  gardenCaps,
  clipAbove(gardenCaps, 8),
  box(19.3, 5.2, 0, 3.8, 0.3, GARDEN_Z * 2, 'clip'),
  // 연못과 돌
  box(20, 0, 2.5, 2, 0.14, 3, 'water'),
  box(20, 0, 0.9, 2.4, 0.24, 0.2, 'stone'),
  box(20, 0, 4.1, 2.4, 0.24, 0.2, 'stone'),
  box(18.9, 0, 2.5, 0.2, 0.24, 3, 'stone'),
  box(21.1, 0, 2.5, 0.2, 0.24, 3, 'stone'),
  stoneLantern(20.5, -2.2),
  box(18.4, 0, -1.2, 0.9, 0.45, 0.7, 'stone'),
  box(20.6, 0, -4.9, 0.8, 0.3, 1.6, 'wood_dark')
].flat(2);

const storeSolids = [
  box(-FENCE_X, 0, 0, 0.3, 3.2, GARDEN_Z * 2 + 0.3, 'plaster'),
  box(-19.3, 0, -GARDEN_Z, 3.8, 3.2, 0.3, 'plaster'),
  box(-19.3, 0, GARDEN_Z, 3.8, 3.2, 0.3, 'plaster'),
  ramp(-19.3, 3.2, 0, 4.1, 1.2, GARDEN_Z * 2 + 0.6, '-x', 'tile'),
  box(-FENCE_X + 0.17, 1, 0, 0.04, 1.3, 1.8, 'paper'),
  box(-19.3, 4.4, 0, 4.1, 8, GARDEN_Z * 2 + 0.6, 'clip')
];

const half = [...courtHalf, ...eastWing, ...mirrorZ(eastWing), ...northHall];

/* ---------------- 트리거 ---------------- */

const halfPads = [
  { x: 9.85, y: PAVE, z: -9.4, w: 2, d: 1.8, target: [9.2, GAL, -17.2], apex: 3.4, color: '#ff4d8d' },
  { x: -9.85, y: PAVE, z: -9.4, w: 2, d: 1.8, target: [-9.2, GAL, -17.2], apex: 3.4, color: '#ff4d8d' },
  { x: 0, y: GAL, z: -16.8, w: 2.2, d: 2.2, target: [-1.3, TOP, -1.7], apex: 1.3, color: '#35e0ff' }
];

const GARDEN_ENTRY = { x: 19.4, y: 0, z: -5, rotY: PI };

/* ---------------- 스폰 ---------------- */

/** 카메라가 (x,z)에서 (tx,tz)를 보는 rotY */
const look = (x, z, tx, tz) => Math.atan2(-(tx - x), -(tz - z));

// 가림막에 코를 박지 않게 문 쪽 틈을 보고 시작한다. 가운데 칸만 팀 족자를 정면으로 본다
const owner = [
  { x: -6.4, y: DECK, z: -19, rotY: look(-6.4, -19, -6.9, -14) },
  { x: 0, y: DECK, z: -19.7, rotY: PI },
  { x: 6.4, y: DECK, z: -19, rotY: look(6.4, -19, 6.9, -14) },
  { x: -17.7, y: DECK, z: -17, rotY: look(-17.7, -17, -14, -16.4) }
];
const ffaHalf = [
  { x: 18.6, y: DECK, z: -17, rotY: PI / 2 },
  { x: 19.8, y: 0, z: -12.4, rotY: look(19.8, -12.4, 15, -8.4) },
  { x: 19.8, y: 0, z: 12.4, rotY: look(19.8, 12.4, 15, 8.4) },
  { x: 2.4, y: 0.43, z: 0, rotY: 0 }
];

/* ---------------- 장식 ---------------- */

const AMBER = '#ffb35c', ROSE = '#ff8fb0', GOLD = '#ffd27a';
const INDIGO = '#27306e', CRIMSON = '#8c2346', PETAL = '#ffe3ec';

/** 천장(ceil)에 매단 등 */
const hang = (x, z, ceil, r = 0.3, cord = 0.4, color = AMBER) => ({ type: 'lantern', x, y: ceil - cord - r * 1.18, z, r, cord, color });

/** 처진 줄과 거기 매단 작은 등 */
function stringLights(from, to, n, sag, color = AMBER) {
  const r = 0.15, cord = 0.1;
  const at = (f, k) => from[k] + (to[k] - from[k]) * f;
  const out = [{ type: 'rope', from, to, sag, r: 0.016, mat: 'wood_dark' }];
  for (let i = 1; i <= n; i++) {
    const f = i / (n + 1);
    const y = at(f, 1) - 4 * sag * f * (1 - f);
    out.push({ type: 'lantern', x: at(f, 0), y: y - cord - r * 1.18, z: at(f, 2), r, cord, color: i % 2 ? color : ROSE });
  }
  return out;
}

/** 옥상 회랑 뒤 깃발 */
const flag = (x, bg, emblem) => [
  { type: 'pipe', from: [x, GAL, -20.85], to: [x, 9.7, -20.85], r: 0.05, mat: 'wood_dark' },
  { type: 'banner', x, y: 8.05, z: -20.72, rotY: 0, w: 0.85, h: 3, bg, fg: PETAL, emblem }
];
const northFlags = [-19, -14.5, -9.6, 9.6, 14.5, 19].flatMap((x) => flag(x, INDIGO, 'blossom'));

const courtTrees = [
  { type: 'tree', x: 4.9, y: INLAY, z: -9.75, h: 5 },
  { type: 'tree', x: -4.9, y: INLAY, z: -9.75, h: 5 },
  { type: 'tree', x: 9.75, y: INLAY, z: -3.8, h: 5 },
  { type: 'tree', x: 9.75, y: INLAY, z: 3.8, h: 5 }
];

/** 도장 뒷벽의 칼 걸이: 기둥 둘과 칼 셋 */
const swordRack = (x, z = -20.97) => [
  ...[-0.72, 0.72].map((dx) => ({ type: 'pipe', from: [x + dx, DECK + 1.05, z], to: [x + dx, DECK + 2.3, z], r: 0.035, mat: 'wood_dark' })),
  ...[1.35, 1.7, 2.05].map((h) => ({ type: 'pipe', from: [x - 0.98, DECK + h, z + 0.05], to: [x + 0.98, DECK + h, z + 0.05], r: 0.018, mat: 'steel' }))
];

const yardHalf = [
  // 도장 뒷벽의 칼 걸이
  ...swordRack(-7),
  ...swordRack(7),
  // 안뜰 처마 등
  ...[-15.3, -10.7, -5.8, 5.8, 10.7, 15.3].map((x) => hang(x, -11.75, 3.5)),
  // 동쪽 회랑 등
  hang(11.7, -5.2, 3.2), hang(11.7, 5.2, 3.2), hang(11.7, -9.4, 3.2, 0.3, 0.4, ROSE), hang(11.7, 9.4, 3.2, 0.3, 0.4, ROSE),
  // 도장 안 등
  ...[-18.4, -9.6, -2.6, 2.6, 9.6, 18.4].map((x) => hang(x, -17.6, CEIL, 0.32, 0.28)),
  // 뒤뜰
  { type: 'tree', x: 18.6, z: -8.9, h: 5.6 },
  { type: 'tree', x: 18.6, z: 8.9, h: 5.6 },
  { type: 'bamboo', x: 20.3, z: -10.4, h: 7, n: 8, r: 0.75 },
  { type: 'bamboo', x: 20.3, z: 10.4, h: 7, n: 8, r: 0.75 },
  { type: 'bamboo', x: 15.4, z: -10.9, h: 5.5, n: 4, r: 0.5 },
  { type: 'bamboo', x: 15.4, z: 10.9, h: 5.5, n: 4, r: 0.5 },
  // 뒤뜰 장대 등
  ...[-1, 1].flatMap((sz) => [
    { type: 'pipe', from: [17, 0, sz * 11.3], to: [17, 2.2, sz * 11.3], r: 0.045, mat: 'wood_dark' },
    { type: 'lantern', x: 17, y: 2.5, z: sz * 11.3, r: 0.26, cord: 0, color: AMBER },
    { type: 'pipe', from: [20.6, 0, sz * 7.4], to: [20.6, 2.2, sz * 7.4], r: 0.045, mat: 'wood_dark' },
    { type: 'lantern', x: 20.6, y: 2.5, z: sz * 7.4, r: 0.26, cord: 0, color: ROSE }
  ])
];

const decor = [
  // 실제 조명 넷: 탑 처마 아래 네 귀. 안뜰 고리 길에 따뜻한 빛을 떨군다
  ...CORNERS.flatMap(([sx, sz]) => [
    { type: 'light', x: sx * 5.1, y: 2.4, z: sz * 5.1, color: '#ffb070', intensity: 1, dist: 13 },
    { type: 'lantern', x: sx * 5.1, y: 2.4, z: sz * 5.1, r: 0.42, cord: 0.3, color: AMBER }
  ]),
  ...courtTrees,
  ...rotate180(courtTrees),
  ...yardHalf,
  ...rotate180(yardHalf),
  // 포털이 있는 두 방: 병풍 끝에 분홍 등을 달아 귀띔한다
  hang(15.5, -19.6, CEIL, 0.24, 0.5, '#ff5fa8'),
  hang(-15.5, 19.6, CEIL, 0.24, 0.5, '#ff5fa8'),
  // 탑 등: 처마 끝, 복도, 정자
  ...ringBox(-1.5, 0, 6, 0.1, 0.1, 0.1, 'wood_dark').map((b) => hang(b.x, b.z, 3.05)),
  ...ringBox(1.5, 0, 6, 0.1, 0.1, 0.1, 'wood_dark').map((b) => hang(b.x, b.z, 3.05)),
  ...CORNERS.flatMap(([sx, sz]) => [
    hang(sx * 2.75, sz * 2.75, 3.16, 0.24, 0.3),
    hang(sx * 4.75, sz * 4.75, 5.75, 0.32, 0.25, ROSE),
    hang(sx * 2.9, sz * 2.9, 11.56, 0.24, 0.3, GOLD)
  ]),
  hang(0, 0, 11.56, 0.42, 1, GOLD),
  // 심주 네 면 현수막
  { type: 'banner', x: 0, y: 1.9, z: -1.36, rotY: PI, w: 1.2, h: 2, bg: INDIGO, fg: PETAL, emblem: 'blossom' },
  { type: 'banner', x: 1.36, y: 1.9, z: 0, rotY: PI / 2, w: 1.2, h: 2, bg: CRIMSON, fg: PETAL, emblem: 'blade' },
  { type: 'banner', x: 0, y: 1.9, z: 1.36, rotY: 0, w: 1.2, h: 2, bg: CRIMSON, fg: PETAL, emblem: 'blossom' },
  { type: 'banner', x: -1.36, y: 1.9, z: 0, rotY: -PI / 2, w: 1.2, h: 2, bg: INDIGO, fg: PETAL, emblem: 'blade' },
  // 탑과 처마를 잇는 등불 줄
  ...CORNERS.flatMap(([sx, sz]) => stringLights([sx * 4.85, 5.75, sz * 4.85], [sx * 10.6, 3.55, sz * 11.6], 4, 0.45)),
  // 회랑을 가로막는 발: 지나갈 수 있지만 눈을 가린다
  ...[-6, 6].flatMap((x) => [
    { type: 'banner', x, y: 2.8, z: -12.05, rotY: PI / 2, w: 0.9, h: 1.7, bg: INDIGO, fg: PETAL, emblem: 'ring' },
    { type: 'banner', x, y: 2.8, z: 12.05, rotY: PI / 2, w: 0.9, h: 1.7, bg: CRIMSON, fg: PETAL, emblem: 'ring' }
  ]),
  ...[-6.4, 6.4].flatMap((z) => [
    { type: 'banner', x: 12.75, y: 2.55, z, rotY: 0, w: 2, h: 1.6, bg: CRIMSON, fg: PETAL, emblem: 'diamond' },
    { type: 'banner', x: -12.75, y: 2.55, z, rotY: 0, w: 2, h: 1.6, bg: INDIGO, fg: PETAL, emblem: 'diamond' }
  ]),
  // 도장 현판
  { type: 'banner', x: 0, y: 3.35, z: -13.8, rotY: 0, w: 3.4, h: 0.62, bg: INDIGO, fg: PETAL, text: '벚꽃 도장' },
  { type: 'banner', x: 0, y: 3.35, z: 13.8, rotY: PI, w: 3.4, h: 0.62, bg: CRIMSON, fg: PETAL, text: '벚꽃 도장' },
  // 가림막 족자: 스폰에서 팀 무늬가 보인다
  { type: 'banner', x: 0, y: 1.75, z: -16.22, rotY: PI, w: 1.2, h: 1.9, bg: INDIGO, fg: PETAL, emblem: 'blossom' },
  { type: 'banner', x: 0, y: 1.75, z: 16.22, rotY: 0, w: 1.2, h: 1.9, bg: CRIMSON, fg: PETAL, emblem: 'blade' },
  // 도장 뒷벽 족자
  ...[-9.6, -2.6, 2.6, 9.6].flatMap((x) => [
    { type: 'banner', x, y: 2.75, z: -20.98, rotY: 0, w: 1.3, h: 2.2, bg: INDIGO, fg: PETAL, emblem: 'blossom' },
    { type: 'banner', x, y: 2.75, z: 20.98, rotY: PI, w: 1.3, h: 2.2, bg: CRIMSON, fg: PETAL, emblem: 'blade' }
  ]),
  // 옥상 회랑 깃발과 문
  ...northFlags,
  ...rotate180(northFlags).map((d) => (d.type === 'banner' ? { ...d, bg: CRIMSON, emblem: 'blade' } : d)),
  hang(0, -20.6, GAL + 3, 0.34, 0.3, GOLD),
  hang(0, 20.6, GAL + 3, 0.34, 0.3, GOLD),
  // 대나무 숲: 정원 담 앞
  ...[[16.3, -4.9], [16.5, -2.4], [16.3, 0.2], [16.6, 2.6], [16.3, 5]].map(([x, z]) => ({ type: 'bamboo', x, z, h: 6.5, n: 10, r: 0.85 })),
  // 곳간 앞
  { type: 'bamboo', x: -16.4, z: -4.6, h: 6, n: 7, r: 0.7 },
  { type: 'bamboo', x: -16.4, z: 4.6, h: 6, n: 7, r: 0.7 },
  { type: 'banner', x: -17.2, y: 1.7, z: -5.2, rotY: PI / 2, w: 1, h: 2, bg: INDIGO, fg: PETAL, emblem: 'blossom' },
  { type: 'banner', x: -17.2, y: 1.7, z: 5.2, rotY: PI / 2, w: 1, h: 2, bg: CRIMSON, fg: PETAL, emblem: 'blade' },
  // 숨은 정원
  { type: 'tree', x: 18.9, z: -1.6, h: 4.8 },
  { type: 'bamboo', x: 20.6, z: -5.6, h: 5.5, n: 7, r: 0.5 },
  { type: 'bamboo', x: 20.5, z: 5.5, h: 5.5, n: 7, r: 0.5 },
  { type: 'lantern', x: 19.5, y: 0.34, z: 1.8, r: 0.13, cord: 0, color: ROSE },
  { type: 'lantern', x: 20.4, y: 0.34, z: 2.7, r: 0.13, cord: 0, color: AMBER },
  { type: 'lantern', x: 19.6, y: 0.34, z: 3.4, r: 0.13, cord: 0, color: GOLD },
  // 먼 산: 맵 쪽으로 눕힌 큰 원통의 끝면이 안개 속 둥근 능선으로 보인다. 해가 지는 남서쪽은 비운다
  ...[[-80, 24, 40], [-58, 18, 34], [-34, 28, 46], [-10, 20, 36], [14, 30, 48], [38, 19, 34], [62, 26, 42], [86, 17, 32], [110, 27, 44], [134, 20, 36], [158, 15, 30]].map(([deg, top, r]) => {
    const a = (deg * PI) / 180, sx = Math.sin(a), sz = -Math.cos(a), near = 118, far = near + 40, y = top - r;
    return { type: 'pipe', from: [sx * near, y, sz * near], to: [sx * far, y, sz * far], r, mat: 'asphalt' };
  }),
  // 담 밖 벚나무: 담 위로 머리가 보인다
  ...[
    [-27, -26], [-13, -28], [4, -29], [18, -27],
    [-27, 26], [-16, 28], [-2, 29], [13, 27], [27, 25],
    [-28, -12], [-27, 2], [-28, 14], [28, -15], [27, -2], [28, 10]
  ].map(([x, z], i) => ({ type: 'tree', x, z, h: 8 + (i % 3) * 1.2, r: 3.6, petals: false }))
];

export default {
  id: 'dojo',
  name: '벚꽃 도장',
  nameEn: 'Sakura Dojo',
  desc: '해 질 녘 벚꽃이 흩날리는 절 마당. 낮은 벽과 기둥 사이 안뜰에서 총으로도 칼로도 겨룬다. 발판으로 지붕에 오르고, 병풍 뒤를 살펴 보자.',
  size: { x: 44, z: 44 },
  rulesets: ['classic', 'knife', 'sniper'],
  tag: '통합',
  theme: {
    sky: '#f0a6bd', skyTop: '#2f2566', fog: [34, 150],
    sunDir: [-0.62, 0.36, 0.7], sunColor: '#ffb48a', sunIntensity: 0.85, ambient: 0.75, ground: 'moss'
  },
  spawns: {
    owner,
    charterer: rotate180(owner),
    ffa: [...ffaHalf, ...rotate180(ffaHalf)]
  },
  solids: [
    box(0, 0, 0, 22, PAVE, 22, 'stone'),
    ...pagoda,
    ...half,
    ...rotate180(half),
    ...gardenSolids,
    ...storeSolids
  ],
  decor,
  pads: [...halfPads, ...rotate180(halfPads)],
  portals: [
    { x: 20.5, y: DECK, z: -19.8, w: 0.5, h: 2.4, d: 2.2, to: GARDEN_ENTRY, color: '#ff7ac0' },
    { x: -20.5, y: DECK, z: 19.8, w: 0.5, h: 2.4, d: 2.2, to: GARDEN_ENTRY, color: '#ff7ac0' },
    { x: 19.4, y: 0, z: 5.6, w: 2.2, h: 2.4, d: 0.5, to: { x: 15, y: 0, z: 4.6, rotY: PI }, color: '#ff7ac0' }
  ],
  secrets: [
    { id: 'dojo_roof', name: '명상 지붕', x: 0, y: TOP, z: 0, w: 7.2, h: 2.6, d: 7.2, points: 100 },
    { id: 'dojo_garden', name: '숨은 정원', x: 19.4, y: 0, z: 0, w: 3.5, h: 2.6, d: 12.4, points: 80 }
  ],
  props: [
    { type: 'crate', x: -19.2, y: DECK, z: -20.2 },
    { type: 'barrel', x: -17.8, y: DECK, z: -20.3 },
    { type: 'crate', x: 11.8, y: DECK, z: -20.2 },
    { type: 'barrel', x: 19.2, y: DECK, z: 20.3 },
    { type: 'crate', x: 17.8, y: DECK, z: 20.2 },
    { type: 'barrel', x: -11.8, y: DECK, z: 20.3 }
  ]
};
