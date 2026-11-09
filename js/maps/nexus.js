/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 통합 맵 넥서스. 칼전 구덩이, 라이플 골목, 저격 탑과 캣워크를 한 판에 합친 야간 훈련장(180° 대칭)이고 비밀 스팟이 두 곳 있다.
 */
import { box, ramp, cyl, wall, stairs, clipAbove, rotate180 } from './kit.js';

//  x: -45        -33   -26      -12     0     12      26   33        45
//  z=-35 ┌ 탑 A ─┬ 마당 ┬ 북쪽 블록(방·골목·서비스 마당) ┬ 마당 ┬ 별관 ┐
//  z=-16 │ 마당  │     └ 구덩이 북쪽 테두리 ────────────┘     │ 마당 │
//  z=  0 │ 블루 스폰 │ 서쪽 광장 │ 칼전 구덩이 │ 동쪽 광장 │ 오렌지 스폰 │
//  z= 16 │ 마당  │     ┌ 구덩이 남쪽 테두리 ────────────┐     │ 마당 │
//  z= 35 └ 별관 ─┴ 마당 ┴ 남쪽 블록 ──────────────────┴ 마당 ┴ 탑 B ┘
//  탑 A → 다리(x=-31) → 서쪽 캣워크(z=-4) → 허브(구덩이 위) → 동쪽 캣워크(z=4) → 다리(x=31) → 탑 B
//  허브 기둥 위 y=18.4에 스카이 데크, 구덩이 바닥 아래 y=-6.4에 코어 룸이 있다.
//  북쪽 절반을 쓰고 rotate180으로 남쪽을 만든다. 네온은 x<0이 시안(블루 쪽), x>0이 핑크(오렌지 쪽)다.

const PIT = -2;          // 구덩이 바닥
const CORE = -6.4;       // 코어 룸 바닥
const ROOF = 4.2;        // 블록 지붕
const HALL_TOP = 4.45;   // 스폰 건물 지붕
const DECK = 6.6;        // 캣워크·별관 지붕
const TOWER = 10.4;      // 탑 꼭대기 층
const CANOPY = 13.2;     // 탑 차양 지붕
const PLATE = 12.2;      // 스카이 데크 아래 받침판
const SKY = 18.4;        // 스카이 데크
const WALL_H = 4;        // 블록 벽
const RAIL_H = 1.25;     // 난간. 앉으면 몸이 다 가려진다

const CYAN = '#35e0ff', PINK = '#ff4d8d', GOLD = '#ffd166', VIOLET = '#b77dff';
const WALL = 'tank';     // 블록, 탑, 스폰 건물의 밝은 벽 패널
const COVER = 'steel';   // 낮은 엄폐물과 턱

const door = (at, w = 2.2, top = 2.7) => ({ at, w, top });
const slot = (at, w = 2.4, sill = 1.05, top = 2.4) => ({ at, w, top, sill });

/** 문과 창을 섞어 뚫은 벽. 구멍 사이 기둥을 한 조각으로 만들어 solid 수를 아낀다. holes는 벽 방향 좌표 순서대로 */
function wallWith(x0, z0, x1, z1, h, t, mat, holes = [], y = 0) {
  const alongX = z0 === z1;
  const fixed = alongX ? z0 : x0;
  const a = alongX ? Math.min(x0, x1) : Math.min(z0, z1), b = alongX ? Math.max(x0, x1) : Math.max(z0, z1);
  const seg = (p, q, y0, hh) => (alongX ? box((p + q) / 2, y0, fixed, q - p, hh, t, mat) : box(fixed, y0, (p + q) / 2, t, hh, q - p, mat));
  const out = [];
  let cur = a;
  for (const { at, w, top, sill = 0 } of holes) {
    const p = at - w / 2, q = at + w / 2;
    if (p > cur + 1e-6) out.push(seg(cur, p, y, h));
    if (top < h) out.push(seg(p, q, y + top, h - top));
    if (sill > 0) out.push(seg(p, q, y, sill));
    cur = q;
  }
  if (b > cur + 1e-6) out.push(seg(cur, b, y, h));
  return out;
}

/* ---------------- 바깥 벽 ---------------- */

const shellTop = [wall(-45.5, -35, 45.5, -35, 9, 1, 'metal_dark', 5), wall(-45, -34.5, -45, 34.5, 9, 1, 'metal_dark', 5)];
const shell = [
  wall(-45.5, -35, 45.5, -35, 5, 1, WALL),
  wall(-45, -34.5, -45, 34.5, 5, 1, WALL),
  ...shellTop,
  clipAbove(shellTop, 16)
];

/* ---------------- 칼전 구덩이 ---------------- */

const pit = [
  // 네 귀를 단으로 메워 원에 가깝게 깎는다. 구덩이 구멍 안이라 바닥을 더 도려내지 않는다
  ...[-1, 1].flatMap((s) => [
    box(s * 11.25, PIT, -6.5, 1.5, -PIT, 3, 'tile'),
    box(s * 10, PIT, -9.25, 4, -PIT, 2.5, 'tile'),
    box(s * 7.75, PIT, -11.25, 8.5, -PIT, 1.5, 'tile'),
    box(s * 11, PIT, -3.75, 2, 1, 2.5, 'tile')       // 뛰어 나가는 턱
  ]),
  // 서쪽 경사로: 구덩이 벽 밖으로 판 도랑에 놓는다. 도랑 구멍을 구덩이 쪽으로 2 m 겹쳐야 봇이 이음매를 지나간다
  box(-14, PIT - 0.6, 0, 8, 0.55, 5, 'tile'),
  ramp(-15, PIT, 0, 6, -PIT, 5, '-x', 'tile'),
  // 북쪽 계단
  stairs(0, PIT, -10.625, 7, -PIT, 2.75, '-z', 'steel', 5),
  // 낮은 기둥과 턱
  box(-7, PIT, -6.4, 2.6, 1.2, 1, COVER),
  box(0, PIT, -6.9, 3.2, 1.05, 0.8, COVER),
  box(-6.5, PIT, -2.2, 1, 2.3, 1, COVER),
  box(7, PIT, -2, 1.2, 1.3, 1.2, COVER),
  // 코어 룸 포털을 가리는 ㄱ자 기둥. 벽과의 틈으로 돌아 들어간다
  box(6.5, PIT, -7.2, 3, 2.4, 1, COVER),
  box(4.6, PIT, -8.5, 0.5, 2.4, 1.6, COVER)
];

/* ---------------- 캣워크 ---------------- */

const catwalk = [
  // 바닥: 다리, 서쪽 구간, 발판 착지 자리
  box(-31, DECK - 0.25, -15.625, 3.5, 0.25, 26.75, 'metal_dark'),
  box(-16.625, DECK - 0.25, -4, 25.25, 0.25, 3.5, 'metal_dark'),
  box(-14, DECK - 0.25, -7, 6, 0.25, 2.5, 'metal_dark'),
  // 유리 난간
  box(-32.7, DECK, -14.05, 0.1, RAIL_H, 23.4, 'glass'),
  box(-31, DECK, -28.95, 3.5, RAIL_H, 0.1, 'glass'),
  box(-29.3, DECK, -17.325, 0.1, RAIL_H, 23.15, 'glass'),
  box(-18.375, DECK, -2.3, 28.75, RAIL_H, 0.1, 'glass'),
  box(-23.125, DECK, -5.7, 12.25, RAIL_H, 0.1, 'glass'),
  box(-7.5, DECK, -5.7, 7, RAIL_H, 0.1, 'glass'),
  box(-14, DECK, -8.2, 6, RAIL_H, 0.1, 'glass'),
  box(-16.95, DECK, -6.95, 0.1, RAIL_H, 2.4, 'glass'),
  // 서서 몸을 가리는 방패판
  box(-24, DECK, -5.5, 2.2, 2.2, 0.3, COVER),
  box(-9, DECK, -2.5, 2.2, 2.2, 0.3, COVER),
  box(-29.5, DECK, -18, 0.3, 2.2, 2.2, COVER),
  box(-32.5, DECK, -9, 0.3, 2.2, 2.2, COVER),
  // 기둥
  box(-31, 0, -20, 0.7, DECK - 0.25, 0.7, 'tile'),
  box(-31, 0, -11, 0.7, DECK - 0.25, 0.7, 'tile'),
  box(-31, 0, -4, 0.7, DECK - 0.25, 0.7, 'tile'),
  box(-20, 0, -4, 0.7, DECK - 0.25, 0.7, 'tile'),
  box(-9.5, PIT, -4, 0.7, DECK - 0.25 - PIT, 0.7, 'tile'),
  // 허브 난간과 빈 귀퉁이 기둥(나머지 반은 대칭 복사)
  box(0, DECK, -5.7, 8, RAIL_H, 0.1, 'glass'),
  box(3.95, DECK, -1.7, 0.1, RAIL_H, 7.9, 'glass'),
  box(3.4, PIT, -5.1, 0.7, DECK - 0.25 - PIT, 0.7, 'tile'),
  // 스카이 데크 턱과 받침판
  box(0, SKY, -3.1, 6.4, 0.35, 0.2, 'steel'),
  box(3.1, SKY, 0, 0.2, 0.35, 6, 'steel'),
  box(0, PLATE - 0.3, -4.7, 3, 0.3, 3, 'metal_dark'),
  box(0, PLATE - 0.3, -1.8, 0.3, 0.3, 2.8, 'metal_dark')
];

/* ---------------- 탑 A (북서쪽 구석, 북·서쪽 벽은 바깥 벽을 쓴다) ---------------- */

const tower = [
  // 아래층 벽(바닥 ~ 다리 높이)
  wallWith(-44.5, -22, -32.75, -22, DECK, 0.5, WALL, [door(-38, 2.4, 3)]),
  wallWith(-33, -34.5, -33, -22.25, DECK, 0.5, WALL, [door(-26, 2.4, 3)]),
  // 가운데 층 벽(다리 높이 ~ 꼭대기)
  wallWith(-44.5, -22, -32.75, -22, TOWER - DECK, 0.5, WALL, [slot(-37, 3, 1, 2.6)], DECK),
  wallWith(-33, -34.5, -33, -22.25, TOWER - DECK, 0.5, WALL, [door(-27, 2.4, 2.8)], DECK),
  // 바깥 벽 윗단이 어두워서 탑 안쪽에 밝은 판을 댄다
  box(-38.875, 5, -34.45, 11.25, TOWER - 5.25, 0.1, WALL),
  box(-44.45, 5, -28.325, 0.1, TOWER - 5.25, 12.15, WALL),
  // 오르는 길: 북쪽 경사로 → 층계참 → 서쪽 경사로 → 가운데 층 → 북쪽 경사로 → 꼭대기
  stairs(-35.8, 0, -33.125, 2.2, 1.6, 2.75, '-x', WALL, 4),
  box(-39.325, 0, -33.125, 4.85, 1.6, 2.75, 'tile'),
  ramp(-39.325, 1.6, -33.125, 4.85, 1.7, 2.75, '-x', 'tile'),
  box(-43.125, 0, -33.125, 2.75, 3.3, 2.75, 'tile'),
  ramp(-43.125, 3.3, -27, 2.75, DECK - 3.3, 9.5, '+z', 'tile'),
  box(-37.5, DECK - 0.25, -27, 8.5, 0.25, 9.5, 'tile'),
  ramp(-38.375, DECK, -30.5, 6.75, TOWER - DECK, 2.5, '+x', 'tile'),
  // 꼭대기 층
  box(-38.875, TOWER - 0.25, -25.75, 11.25, 0.25, 7, 'tile'),
  box(-34.125, TOWER - 0.25, -30.5, 1.75, 0.25, 2.5, 'tile'),
  // 난간과 총안
  box(-38.625, TOWER, -22, 11.75, 1.2, 0.5, 'tile'),
  box(-33, TOWER, -28.375, 0.5, 1.2, 12.25, 'tile'),
  box(-33.575, TOWER + 1.2, -22, 1.65, 0.9, 0.5, 'tile'),
  box(-37.6, TOWER + 1.2, -22, 1.6, 0.9, 0.5, 'tile'),
  box(-41.8, TOWER + 1.2, -22, 1.6, 0.9, 0.5, 'tile'),
  box(-33, TOWER + 1.2, -25, 0.5, 0.9, 1.6, 'tile'),
  box(-33, TOWER + 1.2, -29, 0.5, 0.9, 1.6, 'tile'),
  // 차양 지붕과 오르는 경사로
  box(-41.5, CANOPY - 0.3, -28.375, 6, 0.3, 12.25, 'tile'),
  box(-38.75, TOWER, -22.75, 0.5, CANOPY - 0.3 - TOWER, 0.5, 'tile'),
  box(-38.75, TOWER, -28.9, 0.5, CANOPY - 0.3 - TOWER, 0.5, 'tile'),
  ramp(-35.875, TOWER, -33.125, 5.25, CANOPY - TOWER, 2.75, '-x', 'tile')
];

/* ---------------- 블루 스폰 건물 ---------------- */

const hallRoof = box(-40.1, 4.2, 0, 8.8, 0.25, 20.5, 'tile');
const hall = [
  wallWith(-36, -10.25, -36, 10.25, 4.2, 0.6, WALL, [door(-6, 2.6, 3), door(6, 2.6, 3)]),
  wallWith(-44.5, -10, -36.3, -10, 4.2, 0.5, WALL, [door(-40, 2.4, 4.2)]),
  wallWith(-44.5, 10, -36.3, 10, 4.2, 0.5, WALL, [door(-40, 2.4, 4.2)]),
  hallRoof,
  clipAbove(hallRoof, 12),
  box(-39, 0, 0, 1, 1.2, 4.5, COVER),
  // 문 앞 가림벽: 탑과 광장에서 문이 곧바로 보이지 않게 한다
  box(-33.2, 0, -6, 0.6, 3, 7, COVER),
  box(-33.2, 0, 6, 0.6, 3, 7, COVER),
  box(-36.55, 0, 12.25, 0.5, 3, 4, COVER)
];

/* ---------------- 북쪽 블록 ---------------- */

const block = [
  // 구덩이와 마주 보는 긴 벽
  wallWith(-26.2, -16, 26.2, -16, WALL_H, 0.4, WALL, [door(-20.5), slot(-16.5), door(-8.5), door(0, 2.6), door(8.5), slot(16.5), door(20.5)]),
  // 서쪽: 방과 골목 사이, 골목과 뒷방 사이
  wallWith(-26, -22, -2, -22, WALL_H, 0.4, WALL, [door(-22.5, 2.2, WALL_H), slot(-17.5), door(-10, 2.2, WALL_H)]),
  wallWith(-26.2, -26, -1.8, -26, WALL_H, 0.4, WALL, [door(-19, 2.2, WALL_H), door(-7, 2.2, WALL_H)]),
  // 동쪽: 방과 서비스 마당 사이
  wallWith(1.8, -26, 26.2, -26, WALL_H, 0.4, WALL, [door(6, 2.2, WALL_H), slot(12), door(20, 2.2, WALL_H)]),
  // 끝 벽과 칸막이(방 안쪽 문은 지붕까지 튼다)
  wallWith(-26, -21.8, -26, -16.2, WALL_H, 0.4, WALL, [door(-19, 2.2, WALL_H)]),
  wallWith(-26, -34.5, -26, -26.2, WALL_H, 0.4, WALL, [door(-30, 2.2, WALL_H)]),
  wallWith(-14, -21.8, -14, -16.2, WALL_H, 0.4, WALL, [door(-19, 2.2, WALL_H)]),
  wallWith(-2, -21.8, -2, -16.2, WALL_H, 0.4, WALL, [door(-19, 2.2, WALL_H)]),
  wallWith(-2, -34.5, -2, -26.2, WALL_H, 0.4, WALL, [door(-30, 2.2, WALL_H)]),
  wallWith(2, -25.8, 2, -16.2, WALL_H, 0.4, WALL, [door(-21, 2.2, WALL_H)]),
  wallWith(14, -25.8, 14, -16.2, WALL_H, 0.4, WALL, [door(-21, 2.2, WALL_H)]),
  wallWith(26, -25.8, 26, -16.2, WALL_H, 0.4, WALL, [door(-21, 2.2, WALL_H)]),
  // 지붕과 골목 위 널빤지
  box(0, WALL_H, -19, 52.4, 0.2, 6.4, 'tile'),
  box(14, WALL_H, -24.2, 24.4, 0.2, 4, 'tile'),
  box(-14, WALL_H, -30.15, 24.4, 0.2, 8.7, 'tile'),
  box(-14.5, WALL_H, -24, 3, 0.2, 3.6, 'tile'),
  // 지붕 위 환기 설비(엄폐)
  box(-9, ROOF, -19, 2.4, 1.2, 1.6, 'metal_dark'),
  box(11, ROOF, -22, 1.6, 1.2, 3, 'metal_dark'),
  box(-13, ROOF, -30.5, 2, 1.2, 2, 'metal_dark'),
  // 골목 엄폐
  box(-18.5, 0, -24.9, 1.8, 1.2, 1.2, COVER),
  box(-7.5, 0, -23.1, 1.8, 1.2, 1.2, COVER),
  // 방 안 집기
  box(-21, 0, -20.4, 2.4, 1.1, 1, COVER),
  box(9.5, 0, -19, 1.2, 1.2, 3.4, COVER),
  box(-14, 0, -30, 1.2, 1.2, 4, COVER),
  // 서비스 마당 엄폐
  box(9, 0, -31, 3, 2.4, 3, COVER),
  box(17, 0, -28.3, 5, 1.2, 0.9, COVER),
  box(24.5, 0, -32, 2.6, 2.4, 3.6, COVER)
];

/* ---------------- 북동쪽 별관(높은 지붕) ---------------- */

const annex = [
  // 문을 둘 두어 방에 갇히지 않는다
  wallWith(32, -34.5, 32, -24.25, DECK - 0.3, 0.5, WALL, [door(-31.6, 2.2, 2.8), door(-26.8, 2.2, 2.8)]),
  wall(31.75, -24, 44.5, -24, DECK - 0.3, 0.5, WALL),
  box(38.125, DECK - 0.3, -29.125, 12.75, 0.3, 10.75, 'tile'),
  box(32, DECK, -29.125, 0.4, 0.5, 10.75, 'tile'),
  box(36.95, DECK, -24, 9.5, 0.5, 0.4, 'tile'),
  ramp(36.875, 0, -22.5, 9.75, DECK, 2.5, '+x', 'tile'),
  box(43.125, 0, -22.5, 2.75, DECK, 2.5, 'tile'),
  box(40, 0, -30, 2.4, 1.2, 1.2, COVER)
];

/* ---------------- 광장과 테두리 ---------------- */

const plaza = [
  box(-24.5, 0, -10, 3, 2.6, 3, COVER),
  box(-29, 0, 6, 3, 2.6, 3, COVER),
  box(-23.5, 0, 9.5, 1, 1.2, 7, COVER),
  box(-39, 0, -16.5, 3.4, 1.2, 1, COVER),
  // 지붕으로 오르는 경사로와 층계참
  ramp(-27.6, 0, -11.5, 2.8, ROOF, 9, '-z', 'tile'),
  box(-27.6, WALL_H - 0.1, -17.5, 2.8, 0.3, 3, 'tile'),
  // 테두리 낮은 벽
  box(-18, 0, -13.4, 3.5, 1.2, 0.7, COVER),
  box(14.5, 0, -13.6, 3.5, 1.2, 0.7, COVER)
];

/* ---------------- 가운데(대칭 복사 없이 한 번만) ---------------- */

const center = [
  box(0, PIT - 0.6, 0, 24, 0.6, 24, 'tile'),                 // 구덩이 바닥
  cyl(0, PIT, 0, 1.9, 0.35, 'steel'),
  cyl(0, PIT, 0, 1.5, DECK - 0.25 - PIT, 'metal_dark'),
  box(0, DECK - 0.25, 0, 8, 0.25, 11.5, 'metal_dark'),       // 허브
  box(0, DECK, 0, 0.5, 2.3, 6.4, COVER),                 // 양쪽 캣워크 시야를 끊는 벽
  cyl(0, DECK, 0, 0.45, SKY - 0.3 - DECK, 'metal_dark'),     // 스카이 데크 기둥
  box(0, SKY - 0.3, 0, 6.4, 0.3, 6.4, 'metal_dark'),
  // 코어 룸: 천장은 구덩이 바닥(아랫면이 그려지지 않아 장식 판으로 덮는다)
  box(0, CORE - 0.6, 0, 15, 0.6, 13, 'tile'),
  box(0, CORE, -6.25, 15, PIT - 0.6 - CORE, 0.5, 'steel'),
  box(0, CORE, 6.25, 15, PIT - 0.6 - CORE, 0.5, 'steel'),
  box(7.25, CORE, 0, 0.5, PIT - 0.6 - CORE, 12, 'steel'),
  box(-7.25, CORE, 0, 0.5, PIT - 0.6 - CORE, 12, 'steel'),
  cyl(0, CORE, 0, 1.6, 0.5, 'metal_dark'),
  cyl(0, CORE + 0.5, 0, 1.25, 2.6, 'glass'),
  cyl(0, CORE + 0.5, 0, 0.55, 1.3, 'neon_cyan'),
  cyl(0, CORE + 1.8, 0, 0.55, 1.3, 'neon_pink'),
  cyl(0, CORE + 3.1, 0, 1.6, 0.7, 'metal_dark'),
  ...[[-5, -4.4], [5, 4.4]].map(([x, z]) => box(x, CORE, z, 2.2, 1, 1.4, 'metal_dark'))
];

const half = [shell, pit, catwalk, tower, hall, block, annex, plaza].flat(Infinity);

/* ---------------- 장식 ---------------- */

/** 네온 관. 색은 맨 끝에서 x 부호로 정한다 */
const tube = (from, to, r = 0.035) => ({ type: 'pipe', from, to, r, mat: 'neon_cyan' });
const polyline = (pts, y, r) => pts.slice(1).map((p, i) => tube([pts[i][0], y, pts[i][1]], [p[0], y, p[1]], r));
const vent = (x, y, z, rotY, w = 1.4, h = 0.9) => ({ type: 'vent', x, y, z, rotY, w, h, d: 0.16 });
const flag = (x, y, z, rotY, w, h, text, emblem) => ({ type: 'banner', x, y, z, rotY, w, h, text, emblem, team: true });
/** 천장 판: vent의 앞뒤 깊이를 바닥판처럼 쓴다. x는 가운데, z는 북쪽 끝. 어두운 지붕 아랫면이 구멍처럼 보이는 것을 막는다 */
const ceiling = (x, y, z, w, d, mat = 'steel') => ({ type: 'vent', x, y, z, rotY: 0, w, h: 0.1, d, mat });
/** 바깥 벽 위 조명탑: 기둥과 불 켜진 등 패널. rotY = 패널이 맵 안쪽을 보는 방향 */
const mast = (x, z, rotY) => [
  { type: 'pipe', from: [x, 13, z], to: [x, 21, z], r: 0.16, mat: 'steel' },
  { type: 'sign', x, y: 21.5, z, rotY, w: 3.8, h: 1.6, text: '● ● ● ●\n● ● ● ●', bg: '#7f96bd', fg: '#ffffff' }
];

const decorHalf = [
  // 실내 천장
  ceiling(0, WALL_H - 0.08, -22, 52, 6),
  ceiling(14, WALL_H - 0.08, -26, 24, 4),
  ceiling(-14, WALL_H - 0.08, -34.5, 24, 8.5),
  ceiling(-40.1, 4.12, -10, 8.4, 20),
  ceiling(-37.5, DECK - 0.33, -31.75, 8.5, 9.5),
  ceiling(-38.875, TOWER - 0.33, -29.25, 11.25, 7),
  ceiling(38.125, DECK - 0.38, -34.5, 12.75, 10.5),
  // 구덩이 테두리
  ...polyline([[-18, -2.5], [-12, -2.5], [-12, -5], [-10.5, -5], [-10.5, -8], [-8, -8], [-8, -10.5], [-3.5, -10.5], [-3.5, -12], [0, -12]], 0.03, 0.03),
  ...polyline([[0, -12], [3.5, -12], [3.5, -10.5], [8, -10.5], [8, -8], [10.5, -8], [10.5, -5], [12, -5], [12, -2.5], [18, -2.5]], 0.03, 0.03),
  // 스폰 가림벽 틈에서 경사로까지 이어지는 유도선
  tube([-32.5, 0.03, -2.5], [-18, 0.03, -2.5], 0.025),
  tube([-32.5, 0.03, 2.5], [-18, 0.03, 2.5], 0.025),
  // 캣워크 난간 윗선
  tube([-32.7, DECK + RAIL_H, -25.75], [-32.7, DECK + RAIL_H, -2.3], 0.02),
  tube([-29.3, DECK + RAIL_H, -29], [-29.3, DECK + RAIL_H, -5.7], 0.02),
  tube([-32.7, DECK + RAIL_H, -2.3], [-4, DECK + RAIL_H, -2.3], 0.02),
  tube([-29.3, DECK + RAIL_H, -5.7], [-17, DECK + RAIL_H, -5.7], 0.02),
  tube([-17, DECK + RAIL_H, -8.2], [-11, DECK + RAIL_H, -8.2], 0.02),
  tube([-11, DECK + RAIL_H, -5.7], [-4, DECK + RAIL_H, -5.7], 0.02),
  tube([-4, DECK + RAIL_H, -5.7], [0, DECK + RAIL_H, -5.7], 0.02),
  tube([0, DECK + RAIL_H, -5.7], [4, DECK + RAIL_H, -5.7], 0.02),
  tube([3.95, DECK + RAIL_H, -5.7], [3.95, DECK + RAIL_H, 2.25], 0.02),
  // 탑
  tube([-32.72, 0, -21.72], [-32.72, TOWER + 1.2, -21.72], 0.05),
  tube([-44.5, DECK, -21.72], [-32.72, DECK, -21.72]),
  tube([-32.72, DECK, -34.5], [-32.72, DECK, -21.72]),
  tube([-44.5, TOWER + 1.2, -21.72], [-32.72, TOWER + 1.2, -21.72]),
  tube([-32.72, TOWER + 1.2, -34.5], [-32.72, TOWER + 1.2, -21.72]),
  tube([-34.7, 0.6, -31.72], [-41.75, 3.9, -31.72], 0.025),
  tube([-41.72, 3.9, -31.75], [-41.72, 7.2, -22.25], 0.025),
  tube([-41.75, 7.2, -29.22], [-35, 11, -29.22], 0.025),
  tube([-33.28, 9.6, -31.7], [-33.28, 9.6, -22.3], 0.025),
  tube([-41.7, 9.6, -22.28], [-33.3, 9.6, -22.28], 0.025),
  vent(-39.5, 4.2, -21.74, 0),
  vent(-32.74, 4.2, -30, Math.PI / 2),
  // 스폰 건물
  tube([-35.68, 4.2, -10.25], [-35.68, 4.2, 10.25], 0.04),
  tube([-35.68, 3.05, -7.3], [-35.68, 3.05, -4.7]),
  tube([-35.68, 3.05, 4.7], [-35.68, 3.05, 7.3]),
  tube([-36.32, 3.6, -9.7], [-36.32, 3.6, 9.7], 0.025),
  tube([-44.4, 3.6, -9.7], [-44.4, 3.6, 9.7], 0.025),
  tube([-44.2, 3.6, -9.73], [-36.5, 3.6, -9.73], 0.025),
  tube([-44.2, 3.6, 9.73], [-36.5, 3.6, 9.73], 0.025),
  flag(-35.6, 2, 0, Math.PI / 2, 2.4, 3.2, 'TEAM', 'diamond'),
  flag(-36.36, 2.1, 0, -Math.PI / 2, 2, 2.8, 'TEAM', 'diamond'),
  vent(-35.68, 3.4, -2.6, Math.PI / 2),
  vent(-35.68, 3.4, 2.6, Math.PI / 2),
  // 북쪽 블록
  tube([-26.2, 3.98, -15.78], [0, 3.98, -15.78]),
  tube([0, 3.98, -15.78], [26.2, 3.98, -15.78]),
  tube([-26, 3.2, -22.22], [-2, 3.2, -22.22], 0.025),
  tube([2, 3.2, -26.22], [26, 3.2, -26.22], 0.025),
  tube([-25.7, 3.6, -21.78], [-14.3, 3.6, -21.78], 0.025),
  tube([-13.7, 3.6, -21.78], [-2.3, 3.6, -21.78], 0.025),
  tube([2.3, 3.6, -16.22], [13.7, 3.6, -16.22], 0.025),
  tube([14.3, 3.6, -16.22], [25.7, 3.6, -16.22], 0.025),
  vent(-4, 2.9, -15.78, 0),
  vent(4, 2.9, -15.78, 0),
  // 별관
  tube([31.72, DECK, -34.5], [31.72, DECK, -23.75]),
  tube([31.75, DECK, -23.72], [44.5, DECK, -23.72]),
  tube([31.72, 2.9, -32.7], [31.72, 2.9, -30.5]),
  tube([31.72, 2.9, -27.9], [31.72, 2.9, -25.7]),
  tube([32, 0.05, -21.22], [41.75, DECK + 0.05, -21.22], 0.03),
  vent(31.74, 4.8, -26, -Math.PI / 2),
  // 바깥 벽
  tube([-44.5, 5, -34.48], [0, 5, -34.48], 0.04),
  tube([0, 5, -34.48], [44.5, 5, -34.48], 0.04),
  tube([-44.48, 5, -21.7], [-44.48, 5, 34.5], 0.04),
  tube([-32.5, 13.9, -34.48], [0, 13.9, -34.48], 0.04),
  tube([0, 13.9, -34.48], [44.5, 13.9, -34.48], 0.04),
  tube([-44.48, 13.9, -22], [-44.48, 13.9, 34.5], 0.04),
  ...[-24, -8, 8, 24].map((x) => tube([x, 5, -34.48], [x, 13.9, -34.48])),
  ...[-16, 16].map((z) => tube([-44.48, 5, z], [-44.48, 13.9, z])),
  flag(-16, 9.2, -34.3, 0, 2.2, 7, 'NEXUS', 'diamond'),
  flag(16, 9.2, -34.3, 0, 2.2, 7, 'NEXUS', 'diamond'),
  flag(-44.3, 9.2, 0, Math.PI / 2, 2.2, 7, 'NEXUS', 'blade'),
  // 구덩이 벽 환기구
  vent(-6, -1, -10.48, 0),
  vent(6, -1, -10.48, 0),
  // 스카이 데크 받침줄
  { type: 'pipe', from: [-1.4, PLATE, -6.1], to: [-1.4, SKY - 0.3, -3.1], r: 0.025, mat: 'steel' },
  { type: 'pipe', from: [1.4, PLATE, -6.1], to: [1.4, SKY - 0.3, -3.1], r: 0.025, mat: 'steel' },
  // 먼 도시 윤곽
  ...[[-112, -104, 10, 92], [-46, -132, 13, 118], [24, -124, 9, 84], [98, -112, 12, 104], [-138, -28, 11, 88], [-128, 44, 9, 98]].flatMap(([x, z, r, h]) => [
    { type: 'pipe', from: [x, -0.04, z], to: [x, h, z], r, mat: 'metal_dark' },
    tube([x + r + 0.02, 8, z], [x + r + 0.02, h - 3, z], 0.3),
    { type: 'lantern', x, y: h + 1.6, z, r: 1, cord: 0, color: '#ff5a5a' }
  ]),
  // 조명탑: 돌린 쪽까지 네 변에 고루 선다
  ...mast(-24, -35.6, 0),
  ...mast(8, -35.6, 0),
  ...mast(-45.6, 16, Math.PI / 2)
];

/** 구역 이름. 돌린 쪽은 글자가 다르다 */
const zoneSigns = ([west, east, tower]) => {
  const plate = (x, y, z, w, text) => ({ type: 'sign', x, y, z, rotY: 0, w, h: 0.6, text, bg: '#10203a', fg: '#bfe6ff' });
  return [plate(-12, 3, -15.76, 1.6, west), plate(12, 3, -15.76, 1.6, east), plate(-38, 3.7, -21.72, 2.2, tower)];
};

const decorCenter = [
  // 실제 조명 네 개: 구덩이, 코어 룸, 양쪽 블록 교차로(배열 앞쪽부터 실제 조명이 된다)
  { type: 'light', x: 0, y: 6.1, z: -3, color: '#bfe6ff', intensity: 1.3, dist: 20 },
  { type: 'light', x: 0, y: -3, z: -3.5, color: '#d9c8ff', intensity: 1, dist: 12 },
  { type: 'light', x: 1.7, y: 3.4, z: -24, color: '#ffd2e4', intensity: 0.9, dist: 16 },
  { type: 'light', x: -1.7, y: 3.4, z: 24, color: '#c8f2ff', intensity: 0.9, dist: 16 },
  // 가운데 기둥과 데크
  ...[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sz]) => tube([sx * 1.08, PIT + 0.4, sz * 1.08], [sx * 1.08, DECK - 0.25, sz * 1.08], 0.04)),
  tube([-0.47, DECK, 0], [-0.47, SKY - 0.3, 0], 0.03),
  tube([0.47, DECK, 0], [0.47, SKY - 0.3, 0], 0.03),
  ...polyline([[-3.2, -3.2], [-3.2, 3.2]], SKY + 0.36, 0.03),
  ...polyline([[3.2, -3.2], [3.2, 3.2]], SKY + 0.36, 0.03),
  tube([-3.2, SKY + 0.36, -3.2], [0, SKY + 0.36, -3.2], 0.03),
  tube([0, SKY + 0.36, -3.2], [3.2, SKY + 0.36, -3.2], 0.03),
  tube([-3.2, SKY + 0.36, 3.2], [0, SKY + 0.36, 3.2], 0.03),
  tube([0, SKY + 0.36, 3.2], [3.2, SKY + 0.36, 3.2], 0.03),
  { type: 'pipe', from: [0, SKY, 0], to: [0, SKY + 1.2, 0], r: 0.09, mat: 'neon_cyan', keep: true },
  { type: 'pipe', from: [0, SKY + 1.2, 0], to: [0, SKY + 2.4, 0], r: 0.09, mat: 'neon_pink', keep: true },
  { type: 'sign', x: 0.26, y: DECK + 1.65, z: 0, rotY: Math.PI / 2, w: 3.2, h: 0.7, text: 'NEXUS', bg: '#10203a', fg: '#ff4d8d' },
  { type: 'sign', x: -0.26, y: DECK + 1.65, z: 0, rotY: -Math.PI / 2, w: 3.2, h: 0.7, text: 'NEXUS', bg: '#10203a', fg: '#35e0ff' },
  // 코어 룸 천장 판(9장)
  ...[-6, -2, 2].map((z) => ({ type: 'vent', x: 0, y: PIT - 0.7, z, rotY: 0, w: 14, h: 0.1, d: 4, mat: 'steel' })),
  // 코어 룸 네온
  tube([-7, CORE + 3.3, -6], [0, CORE + 3.3, -6]),
  tube([0, CORE + 3.3, -6], [7, CORE + 3.3, -6]),
  tube([-7, CORE + 3.3, 6], [0, CORE + 3.3, 6]),
  tube([0, CORE + 3.3, 6], [7, CORE + 3.3, 6]),
  tube([-6.98, CORE + 3.3, -6], [-6.98, CORE + 3.3, 6]),
  tube([6.98, CORE + 3.3, -6], [6.98, CORE + 3.3, 6]),
  { type: 'sign', x: 0, y: CORE + 2.4, z: -5.97, rotY: 0, w: 3.4, h: 0.8, text: 'CORE · 코어', bg: '#10203a', fg: '#d9c8ff' },
  { type: 'sign', x: 0, y: CORE + 2.4, z: 5.97, rotY: Math.PI, w: 3.4, h: 0.8, text: 'CORE · 코어', bg: '#10203a', fg: '#d9c8ff' }
];

const TEAM_LOOK = {
  blue: { bg: '#0c2f5c', fg: '#35e0ff', word: '블루' },
  orange: { bg: '#5c1a1f', fg: '#ff5a5f', word: '레드' }
};

/** 쪽(x 부호)에 맞춰 네온·현수막 색을 정한다. 대칭 복사가 끝난 뒤에 부른다 */
function paintSide(d) {
  if (d.keep) { const { keep, ...rest } = d; return rest; }
  if (d.type === 'pipe' && d.mat === 'neon_cyan') {
    const x = (d.from[0] + d.to[0]) / 2, z = (d.from[2] + d.to[2]) / 2;
    return { ...d, mat: x < 0 || (x === 0 && z < 0) ? 'neon_cyan' : 'neon_pink' };
  }
  if (d.type === 'banner' && d.team) {
    const { team, ...rest } = d;
    const look = d.x < 0 ? TEAM_LOOK.blue : TEAM_LOOK.orange;
    const text = d.text === 'TEAM' ? look.word : d.text;
    return { ...rest, text, bg: look.bg, fg: look.fg };
  }
  return d;
}

/* ---------------- 발판·포털·비밀 ---------------- */

const padsHalf = [
  // 구덩이 테두리 → 서쪽 캣워크
  { x: -10.5, y: 0, z: -11.5, w: 2.2, d: 2.2, target: [-14, DECK, -5.5], apex: 3 },
  // 동쪽 광장 → 북쪽 블록 지붕
  { x: 20.8, y: 0, z: -12.4, w: 2.2, d: 2.2, target: [20, ROOF, -19], apex: 2.5 },
  // 북쪽 블록 지붕 → 탑 꼭대기
  { x: -21, y: ROOF, z: -30, w: 2.2, d: 2.2, target: [-36, TOWER, -25.8], apex: 2.5 },
  // 탑 꼭대기 → 반대쪽 별관 지붕
  { x: -37.3, y: TOWER, z: -27, w: 2, d: 2, target: [37, DECK, -29], apex: 13 },
  // 별관 지붕 → 허브
  { x: 40, y: DECK, z: -31, w: 2.2, d: 2.2, target: [1.8, DECK, -2], apex: 8 },
  // 탑 차양 지붕 → 스카이 데크
  { x: -41, y: CANOPY, z: -28, w: 2.2, d: 2.2, target: [-0.8, SKY, -0.6], apex: 5, gold: true },
  // 허브의 수직 발판: 그냥 두면 허브로 떨어지고, 꼭대기에서 옆으로 정확히 흘려야 받침판에 올라탄다
  { x: 2.9, y: DECK, z: -4.7, w: 1.4, d: 1.4, target: [2.9, DECK, -2.9], apex: 7.1, gold: true },
  // 받침판 → 스카이 데크
  { x: 0, y: PLATE, z: -5.2, w: 2.4, d: 1.6, target: [0, SKY, -1.5], apex: 3, gold: true }
];

function paintPad(p) {
  const { gold, ...rest } = p;
  return { ...rest, color: gold ? GOLD : p.x < 0 ? CYAN : PINK };
}

const portalsHalf = [
  // 구덩이 기둥 뒤 → 코어 룸
  { x: 6.6, y: PIT, z: -9.1, w: 1.2, h: 1.9, d: 2.4, to: { x: 0, y: CORE, z: -4.2, rotY: Math.PI }, color: VIOLET },
  // 코어 룸 → 구덩이 테두리
  { x: -6.2, y: CORE, z: 0, w: 1, h: 2.6, d: 2.4, to: { x: -14.5, y: 0, z: -6, rotY: -Math.PI / 2 }, color: VIOLET }
];

const blueSpawns = [
  { x: -41.5, z: -7, rotY: -Math.PI / 2 },
  { x: -41.5, z: -3, rotY: -Math.PI / 2 },
  { x: -41.5, z: 3, rotY: -Math.PI / 2 },
  { x: -41.5, z: 7, rotY: -Math.PI / 2 },
  { x: -42.8, z: 0, rotY: -Math.PI / 2 }
];

const ffaHalf = [
  { x: -20, z: -18.5, rotY: Math.PI },
  { x: -8, z: -30, rotY: Math.PI },
  { x: 8, z: -21, rotY: Math.PI },
  { x: 20, z: -31, rotY: Math.PI / 2 },
  { x: 38, z: -26.8, rotY: Math.PI / 2 },
  { x: -37, z: -27, rotY: -Math.PI / 2 }
];

const propsHalf = [
  { type: 'crate', x: -12.5, y: 0, z: -14.7 },
  { type: 'crate', x: -12.5, y: 0.9, z: -14.7, size: 0.7 },
  { type: 'barrel', x: 9.5, y: 0, z: -13.4 },
  { type: 'barrel', x: -15.5, y: 0, z: -23.2 },
  { type: 'crate', x: -4.5, y: 0, z: -24.8 },
  { type: 'crate', x: 14, y: 0, z: -31.5 },
  { type: 'barrel', x: 20.5, y: 0, z: -33.2 }
];

export default {
  id: 'nexus',
  name: '넥서스',
  nameEn: 'Nexus',
  desc: '칼전 구덩이, 라이플 골목, 저격 탑과 캣워크를 한 판에 합친 야간 훈련장. 발판을 이어 타면 맵 어디로든 날아간다.',
  size: { x: 90, z: 70 },
  rulesets: ['classic', 'knife', 'sniper'],
  tag: '통합',
  theme: {
    sky: '#12203f', skyTop: '#060b1c', fog: [70, 230], sunDir: [0.25, 0.85, 0.4],
    sunColor: '#b9ccf5', sunIntensity: 0.6, ambient: 0.9, ground: 'tile'
  },
  spawns: {
    owner: blueSpawns,
    charterer: rotate180(blueSpawns),
    ffa: [...ffaHalf, ...rotate180(ffaHalf)]
  },
  solids: [...center, ...half, ...rotate180(half)],
  decor: [...decorCenter, ...decorHalf, ...rotate180(decorHalf), ...zoneSigns(['A동', 'B동', 'A 타워']), ...rotate180(zoneSigns(['C동', 'D동', 'B 타워']))].map(paintSide),
  pads: [...padsHalf, ...rotate180(padsHalf)].map(paintPad),
  portals: [...portalsHalf, ...rotate180(portalsHalf)],
  secrets: [
    { id: 'nexus_core', name: '코어 룸', x: 0, y: CORE, z: 0, w: 14, h: 3, d: 12, points: 120 },
    { id: 'nexus_sky', name: '스카이 데크', x: 0, y: SKY, z: 0, w: 6.4, h: 2.5, d: 6.4, points: 150 }
  ],
  props: [...propsHalf, ...rotate180(propsHalf)]
};
