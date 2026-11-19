/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 좀비 물량 막기 전용 맵 '고속도로 휴게소'(Highway Rest Stop). 문 닫은 밤 휴게소의 편의점 앞에서 시작해,
 *          고속도로 갓길·화장실·정비 마당·숲길 여섯 곳에서 몰려오는 좀비를 막는다. 편의점 옥상은 바깥 계단 하나로, 화장실 옥상은 동쪽 벽 사다리로 오른다.
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
  // 동쪽 난간은 트레일러로 건너가는 판자 다리 자리(z -14.4 ~ -13.4)에서 끊긴다
  rect(STORE.x1 - 0.2, STORE.z0 + 0.2, STORE.x1, -14.4, ROOF, ROOF + PARAPET, 'concrete'),
  rect(STORE.x1 - 0.2, -13.4, STORE.x1, STORE.z1 - 0.2, ROOF, ROOF + PARAPET, 'concrete'),
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
  rect(-9.7, -14.7, -1, -14.1, 0, 2.2, 'glass'),
  ...storeDetail()
].flat();

/**
 * 편의점 꾸밈: 바깥 밑단 띠·차양 위 브랜드 띠·창틀·문틀, 안의 진열대 상품 줄·냉장고 문살과 조명·계산대 금전 등록기,
 * 앞의 아이스박스와 쓰레기통. 벽 밖으로 몇 cm만 나와 길과 시야는 예전과 같다
 */
function storeDetail() {
  const { x0, x1, z0, z1 } = STORE;
  const out = [
    // 밑단 띠(문 자리는 비운다)
    rect(x0, z1, -1.8, z1 + 0.05, 0, 0.3, 'metal_dark'), rect(1.8, z1, x1, z1 + 0.05, 0, 0.3, 'metal_dark'),
    rect(x0 - 0.05, z0, x0, z1, 0, 0.3, 'metal_dark'),
    rect(x1, z0, x1 + 0.05, -11, 0, 0.3, 'metal_dark'), rect(x1, -9, x1 + 0.05, z1, 0, 0.3, 'metal_dark'),
    rect(x0, z0 - 0.05, 4.1, z0, 0, 0.3, 'metal_dark'), rect(5.9, z0 - 0.05, x1, z0, 0, 0.3, 'metal_dark'),
    // 브랜드 띠(차양 위 앞·옆)
    rect(x0, z1, x1, z1 + 0.06, 3.4, 3.7, 'container_red'),
    rect(x0 - 0.06, z0, x0, z1, 3.3, 3.7, 'container_red'),
    rect(x1, z0, x1 + 0.06, z1, 3.3, 3.7, 'container_red'),
    // 큰 창 두 개: 가운데 창살과 창턱
    rect(-6.05, FRONT_Z0, -5.95, FRONT_Z1, 1, 2.6, 'metal_dark'), rect(5.95, FRONT_Z0, 6.05, FRONT_Z1, 1, 2.6, 'metal_dark'),
    rect(-8.5, FRONT_Z1, -3.5, FRONT_Z1 + 0.1, 0.95, 1.05, 'metal_dark'), rect(3.5, FRONT_Z1, 8.5, FRONT_Z1 + 0.1, 0.95, 1.05, 'metal_dark'),
    // 출입문 틀
    rect(-1.8, FRONT_Z1, -1.7, FRONT_Z1 + 0.06, 0, 2.8, 'metal_dark'), rect(1.7, FRONT_Z1, 1.8, FRONT_Z1 + 0.06, 0, 2.8, 'metal_dark'),
    rect(-1.8, FRONT_Z1, 1.8, FRONT_Z1 + 0.06, 2.7, 2.8, 'metal_dark'),
    // 냉장고: 문살과 위 조명 띠
    ...[-8.5, -7.3, -6.1, -4.9, -3.7, -2.5].map((x) => rect(x - 0.04, -14.1, x + 0.04, -14.06, 0, 2.2, 'metal_dark')),
    rect(-9.7, -14.1, -1, -14.06, 2.08, 2.2, 'neon_cyan'),
    // 계산대 금전 등록기와 화면
    rect(7.2, -7.0, 7.7, -6.6, 1.1, 1.3, 'metal_dark'), rect(7.3, -6.6, 7.6, -6.56, 1.15, 1.28, 'neon_cyan'),
    // 문 옆 쓰레기통 둘과 아이스박스(표시 띠)
    rect(-2.7, -4.9, -2.2, -4.4, 0, 0.9, 'metal_dark'), rect(2.2, -4.9, 2.7, -4.4, 0, 0.9, 'metal_dark'),
    rect(4.0, -4.9, 5.2, -4.3, 0, 0.9, 'white'), rect(4.1, -4.3, 5.1, -4.27, 0.5, 0.75, 'neon_cyan')
  ];
  // 진열대 넷: 양면에 상품 줄 두 단(색을 바꿔 가며)
  const shelves = [[-7.5, -1.5, -11.6, -11], [1.5, 6.5, -11.6, -11], [-7.5, -1.5, -8.4, -7.8], [1.5, 4.5, -8.4, -7.8]];
  const goods = ['neon_pink', 'yellow', 'neon_cyan', 'container_red'];
  shelves.forEach(([a, b, c, d], i) => {
    for (const [y, k] of [[0.5, 0], [1.05, 1]]) {
      out.push(rect(a + 0.1, c - 0.04, b - 0.1, c, y, y + 0.22, goods[(i + k) % 4]));
      out.push(rect(a + 0.1, d, b - 0.1, d + 0.04, y, y + 0.22, goods[(i + k + 2) % 4]));
    }
  });
  return out;
}

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
  rect(-23.3, -11, -23, -7, 0, 2.3, 'tile'),
  // 옥상 사다리(동쪽 벽 바깥): 경로 격자와 좀비 무리가 가장자리에서 떨어지지 않게 폭 2.4 m로 확보
  stairs(-24.375, 0, -13, 2.25, 3.45, 2.4, '-x', 'metal_dark', 9),
  // 양쪽 난간은 충돌체로 둔다. 좀비가 몰려 서로 밀어도 계단 옆으로 빠지지 않는다.
  ...Array.from({ length: 9 }, (_, i) => {
    const x = -23.25 - (i + 0.5) * 0.25;
    const y = (i + 1) * 3.45 / 9;
    return [
      rect(x - 0.125, -14.25, x + 0.125, -14.15, y, y + 1.6, 'steel'),
      rect(x - 0.125, -11.85, x + 0.125, -11.75, y, y + 1.6, 'steel')
    ];
  }).flat()
].flat();

/* ---------------- 방음벽(북) · 갓길 · 좀비 문 G1·G2 ---------------- */

// 방음벽 구간(사이 두 틈으로 갓길에 드나든다). 위로 넘지 못하게 막는 clip은 이 구간 그대로 덮는다
const NOISE_SPANS = [[-HALF_X, -27], [-24, 24], [27, HALF_X]];
const noiseSpans = NOISE_SPANS.map(([x0, x1]) => rect(x0, NOISE_Z - 0.15, x1, NOISE_Z + 0.15, 0, NOISE_H, 'concrete'));
/**
 * 고속도로 방음벽: 두꺼운 콘크리트 아랫단(1 m) 위에 철판 패널(4.3 m까지), 맨 위 콘크리트 덮개, 4 m마다 H형 철 기둥.
 * 바깥 크기(높이 4.5, 두께 0.3)는 예전과 같아 갓길이 보이지 않는다
 */
const noiseWall = NOISE_SPANS.flatMap(([x0, x1]) => {
  const out = [
    rect(x0, NOISE_Z - 0.2, x1, NOISE_Z + 0.2, 0, 1.0, 'concrete'),     // 아랫단
    rect(x0, NOISE_Z - 0.1, x1, NOISE_Z + 0.1, 1.0, 4.3, 'steel'),      // 철판 패널
    rect(x0, NOISE_Z - 0.18, x1, NOISE_Z + 0.18, 4.3, NOISE_H, 'concrete')   // 덮개
  ];
  const n = Math.max(1, Math.round((x1 - x0) / 4));
  for (let i = 0; i <= n; i++) {
    const x = Math.min(x1 - 0.15, Math.max(x0 + 0.15, x0 + ((x1 - x0) * i) / n));
    out.push(rect(x - 0.15, NOISE_Z - 0.22, x + 0.15, NOISE_Z + 0.22, 0, NOISE_H, 'metal_dark'));   // H형 기둥
  }
  return out;
});
const shoulder = [
  // 갓길에 버려진 승용차(동서로 섬, 앉으면 가려진다)
  sedan(-14.9, -22, 'container_red', 'x'),
  sedan(10.1, -22.3, 'white', 'x')
].flat();

/* ---------------- 북동: 트레일러 · 뒷골목 ---------------- */

/**
 * 세미 트레일러 트럭(동서로 길게, 운전석은 동쪽). 빨간 컨테이너(골판 무늬 띠·뒷문 잠금대)가 차대 위에 얹혀 있고,
 * 뒤 2축 바퀴와 앞쪽 받침 다리, 흰 운전석(앞 유리·옆 창·라디에이터 그릴·전조등·범퍼·연료 탱크·배기관·앞 2축)이 붙는다.
 * 컨테이너 밑(0.9 m)은 사람이 지나가지 못하는 높이다
 */
const truck = (() => {
  const z0 = -15.5, z1 = -12.9, zc = (z0 + z1) / 2;
  const out = [
    rect(13, z0, 26.6, z1, 1.2, 3.9, 'container_red'),              // 컨테이너
    rect(13.2, zc - 0.5, 27.6, zc + 0.5, 0.9, 1.2, 'metal_dark'),   // 차대
    rect(12.96, z0 + 0.1, 13, z1 - 0.1, 1.3, 3.8, 'rust'),          // 뒷문
    rect(12.92, zc - 0.03, 12.96, zc + 0.03, 1.3, 3.8, 'metal_dark'),   // 문 가운데 이음매
    rect(13.2, z0 + 0.05, 26.4, z1 - 0.05, 3.9, 3.96, 'steel')      // 지붕 테두리
  ];
  for (const z of [zc - 0.75, zc - 0.35, zc + 0.35, zc + 0.75]) out.push(rect(12.88, z - 0.04, 12.92, z + 0.04, 1.35, 3.75, 'steel'));   // 뒷문 잠금대
  for (let x = 13.6; x < 26.4; x += 1.4) {                          // 옆면 골판 띠(양쪽)
    out.push(rect(x, z0 - 0.04, x + 0.12, z0, 1.25, 3.85, 'rust'));
    out.push(rect(x, z1, x + 0.12, z1 + 0.04, 1.25, 3.85, 'rust'));
  }
  for (const x of [14.4, 15.6]) out.push(rect(x - 0.5, z0 + 0.05, x + 0.5, z1 - 0.05, 0, 1.0, 'metal_dark'));   // 뒤 2축 바퀴
  for (const z of [zc - 0.7, zc + 0.7]) out.push(rect(24.4, z - 0.06, 24.52, z + 0.06, 0, 0.9, 'steel'));          // 받침 다리
  // 운전석(x 27.1~30)
  const c0 = -15.3, c1 = -13.1;
  out.push(
    rect(27.1, c0, 30, c1, 0.9, 2.9, 'white'),                        // 운전석 몸통
    rect(27.3, c0 + 0.15, 29.4, c1 - 0.15, 2.9, 3.6, 'white'),        // 지붕 바람막이
    rect(30, c0 + 0.15, 30.04, c1 - 0.15, 1.8, 2.7, 'glass'),         // 앞 유리
    rect(28.8, c0 - 0.04, 29.8, c0, 1.8, 2.6, 'glass'),               // 옆 창(양쪽)
    rect(28.8, c1, 29.8, c1 + 0.04, 1.8, 2.6, 'glass'),
    rect(30, c0 + 0.4, 30.06, c1 - 0.4, 1.0, 1.65, 'metal_dark'),     // 라디에이터 그릴
    rect(30, c0 + 0.1, 30.05, c0 + 0.35, 1.1, 1.35, 'yellow'),        // 전조등
    rect(30, c1 - 0.35, 30.05, c1 - 0.1, 1.1, 1.35, 'yellow'),
    rect(30, c0, 30.16, c1, 0.5, 0.9, 'metal_dark'),                  // 범퍼
    rect(27.9, c0 - 0.25, 28.8, c0, 0.55, 1.05, 'steel'),             // 연료 탱크(남쪽)
    rect(29.0, c0 - 0.12, 29.7, c0, 1.0, 1.25, 'metal_dark')          // 발판
  );
  out.push(cyl(27.25, 2.9, c1 - 0.05, 0.08, 1.2, 'steel'));          // 배기관
  for (const x of [27.8, 29.3]) out.push(rect(x - 0.48, c0 - 0.05, x + 0.48, c1 + 0.05, 0, 1.0, 'metal_dark'));   // 운전석 바퀴
  return out;
})();

/**
 * 편의점 옥상(4 m)에서 트레일러 지붕(3.96 m)으로 건너가는 나무 판자 다리(폭 1 m, 난간 없음).
 * 바닥 판 위에 가로 판자 줄과 양옆 받침 보를 댄다. 판자 턱은 2 cm라 그냥 걸어간다
 */
const plankBridge = (() => {
  const za = -14.4, zb = -13.4, xa = 9.8, xb = 13.4;
  const out = [
    rect(xa, za, xb, zb, 3.88, 3.98, 'wood'),                     // 바닥 판
    rect(xa, za - 0.06, xb, za, 3.7, 3.98, 'wood_dark'),          // 받침 보(양옆)
    rect(xa, zb, xb, zb + 0.06, 3.7, 3.98, 'wood_dark')
  ];
  for (let x = xa + 0.15; x < xb - 0.1; x += 0.45) out.push(rect(x, za + 0.03, x + 0.3, zb - 0.03, 3.98, 4.0, 'wood_dark'));   // 가로 판자
  return out;
})();

const northEast = [
  ...truck,
  ...plankBridge,
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
  cyl(30.4, 0, -5.3, 0.6, 1.2, 'tank'),
  // 정비 리프트 기둥 둘(움직이는 판은 movers의 yard_lift, 북쪽 가장자리)과 위 가로대. 드나드는 길(남쪽)은 비워 둔다
  rect(27.25, -4.25, 27.55, -3.95, 0, 3.4, 'metal_dark'),
  rect(30.45, -4.25, 30.75, -3.95, 0, 3.4, 'metal_dark'),
  rect(27.25, -4.25, 30.75, -3.95, 3.4, 3.6, 'yellow')
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
  rect(-30.8, 5.8, -28, 10.2, 2.6, 2.8, 'metal_dark'),
  // 부스 꾸밈: 밑단 띠, 남쪽 큰 창(창틀·창턱), 동쪽 계산 창과 작은 차양·받침대, 북쪽 문, 지붕 빛 띠, 서쪽 냉방기
  rect(-30.65, 5.95, -28.15, 10.05, 0, 0.25, 'metal_dark'),
  rect(-30.2, 10, -28.6, 10.04, 1, 2.2, 'glass'),
  rect(-30.3, 10, -28.5, 10.08, 0.92, 1.0, 'metal_dark'), rect(-30.3, 10, -28.5, 10.08, 2.2, 2.28, 'metal_dark'),
  rect(-29.44, 10.04, -29.36, 10.08, 1, 2.2, 'metal_dark'),
  rect(-28.2, 6.3, -28.16, 7.3, 1.1, 2.0, 'glass'),
  rect(-28.2, 6.2, -27.9, 7.4, 1.0, 1.08, 'steel'),
  rect(-28.2, 6.1, -27.7, 7.5, 2.2, 2.26, 'container_red'),
  rect(-29.8, 5.96, -29, 6, 0, 2.1, 'wood_dark'), rect(-29.15, 5.94, -29.07, 5.96, 1.0, 1.1, 'steel'),
  rect(-30.8, 10.2, -28, 10.24, 2.62, 2.78, 'neon_cyan'), rect(-28, 5.8, -27.96, 7.5, 2.62, 2.78, 'neon_cyan'),
  rect(-31.2, 7.2, -30.6, 8.4, 1.6, 2.2, 'steel'),
  // 계산 부스 옥상 사다리(동쪽 벽 바깥, 주유소 쪽): 가파른 철제 계단(한 칸 0.35 m). 위가 부스 지붕(2.8 m)
  ...stairs(-27.15, 0, 8, 2.1, 2.8, 0.9, '-x', 'metal_dark', 8)
];

/* ---------------- 주차장(남동) ---------------- */

/**
 * 승용차 한 대(길이 4.2 · 폭 1.9). axis = 길이 방향('z' 남북 · 'x' 동서). 앞은 −쪽(앞 범퍼·전조등), 뒤는 +쪽(후미등).
 * 차체는 바퀴 위(0.3~0.85 m)에 있고, 그 위에 좁은 유리 객실과 지붕이 앉는다. 앉으면 가려지는 높이(1.48 m)는 예전과 같다
 */
function sedan(cx, cz, mat, axis = 'z') {
  const L = 2.1, Wd = 0.95;
  // 길이(a)·폭(b) 좌표 → 맵 좌표
  const part = (a0, b0, a1, b1, y0, y1, m) => (axis === 'z'
    ? rect(cx + b0, cz + a0, cx + b1, cz + a1, y0, y1, m)
    : rect(cx + a0, cz + b0, cx + a1, cz + b1, y0, y1, m));
  const out = [
    part(-L, -Wd, L, Wd, 0.3, 0.85, mat),                 // 차체
    part(-1.0, -0.8, 0.8, 0.8, 0.85, 1.4, 'glass'),       // 유리 객실(앞 유리가 보닛 쪽)
    part(-0.9, -0.78, 0.7, 0.78, 1.4, 1.48, mat),         // 지붕
    part(-L - 0.06, -Wd, -L, Wd, 0.3, 0.5, 'metal_dark'), // 앞 범퍼
    part(L, -Wd, L + 0.06, Wd, 0.3, 0.5, 'metal_dark'),   // 뒤 범퍼
    part(-L - 0.04, -0.85, -L, -0.5, 0.55, 0.7, 'yellow'),  // 전조등
    part(-L - 0.04, 0.5, -L, 0.85, 0.55, 0.7, 'yellow'),
    part(L, -0.85, L + 0.04, -0.5, 0.55, 0.7, 'container_red'), // 후미등
    part(L, 0.5, L + 0.04, 0.85, 0.55, 0.7, 'container_red')
  ];
  // 바퀴 넷: 차체 밖으로 살짝 나온 검은 타이어
  for (const a of [-1.35, 1.35]) for (const s of [-1, 1]) out.push(part(a - 0.34, s > 0 ? Wd - 0.15 : -Wd - 0.05, a + 0.34, s > 0 ? Wd + 0.05 : -Wd + 0.15, 0, 0.62, 'metal_dark'));
  return out;
}

/**
 * 관광버스(동서로 길게, 앞은 서쪽 x 8.5). 흰 차체에 빨간 띠, 양옆 창문 띠, 큰 앞 유리·앞문, 지붕 냉방기, 바퀴 3축.
 * 차체 바깥 크기(x 8.5~21, z 16.9~19.3, 높이 3.1)는 예전과 같아 몸 전체를 가린다
 */
const bus = (() => {
  const x0 = 8.5, x1 = 21, z0 = 16.9, z1 = 19.3;
  const out = [
    rect(x0, z0 + 0.05, x1, z1 - 0.05, 0.35, 3.0, 'white'),         // 차체
    rect(x0 + 0.2, z0 + 0.1, x1 - 0.2, z1 - 0.1, 3.0, 3.1, 'white'), // 지붕
    rect(12.5, z0 + 0.6, 16.5, z1 - 0.6, 3.1, 3.45, 'steel'),        // 지붕 냉방기
    // 남쪽 주차장 쪽 사다리: 밟고 오르는 철제 계단, 끝은 버스 지붕과 겹친다
    ...stairs(17.2, 0, 15.9, 1.4, 3.1, 2.4, '+z', 'metal_dark', 11),
    // 양옆 창문 띠(앞쪽 문 자리 다음부터 뒤 끝 앞까지)와 빨간 띠
    rect(10.2, z0, 20.4, z0 + 0.05, 1.6, 2.6, 'glass'),
    rect(9.0, z1 - 0.05, 20.4, z1, 1.6, 2.6, 'glass'),
    rect(x0, z0, x1, z0 + 0.05, 1.05, 1.3, 'container_red'),
    rect(x0, z1 - 0.05, x1, z1, 1.05, 1.3, 'container_red'),
    rect(9.0, z0, 10.0, z0 + 0.05, 0.4, 2.7, 'glass'),               // 앞문(남쪽, 유리문)
    // 앞(서쪽): 큰 앞 유리, 행선지 표시, 전조등, 범퍼
    rect(x0 - 0.05, z0 + 0.2, x0, z1 - 0.2, 1.2, 2.7, 'glass'),
    rect(x0 - 0.05, z0 + 0.5, x0, z1 - 0.5, 2.75, 2.95, 'yellow'),
    rect(x0 - 0.05, z0 + 0.2, x0, z0 + 0.6, 0.55, 0.8, 'yellow'),
    rect(x0 - 0.05, z1 - 0.6, x0, z1 - 0.2, 0.55, 0.8, 'yellow'),
    rect(x0 - 0.12, z0 + 0.05, x0, z1 - 0.05, 0.3, 0.5, 'metal_dark'),
    // 뒤(동쪽): 뒤 창, 후미등, 범퍼
    rect(x1, z0 + 0.5, x1 + 0.05, z1 - 0.5, 2.0, 2.7, 'glass'),
    rect(x1, z0 + 0.2, x1 + 0.05, z0 + 0.5, 0.55, 1.0, 'container_red'),
    rect(x1, z1 - 0.5, x1 + 0.05, z1 - 0.2, 0.55, 1.0, 'container_red'),
    rect(x1, z0 + 0.05, x1 + 0.12, z1 - 0.05, 0.3, 0.5, 'metal_dark')
  ];
  // 바퀴: 앞 1축, 뒤 2축(차체 밖으로 살짝 나온다)
  for (const ax of [10.4, 18.0, 19.3]) out.push(rect(ax - 0.5, z0 - 0.05, ax + 0.5, z1 + 0.05, 0, 0.9, 'metal_dark'));
  return out;
})();

const parking = [
  sedan(11.5, 7, 'white'), sedan(14.7, 7, 'container_red'), sedan(21, 7, 'steel'), sedan(24.2, 7, 'white'),
  sedan(13.2, 13.4, 'steel'), sedan(19.4, 13.4, 'white'), sedan(25.6, 13.4, 'container_red'),
  ...bus
].flat();

/* ---------------- 앞마당 · 생울타리(남) · 좀비 문 G5·G6 ---------------- */

/**
 * 피크닉 탁자(동서 2.6 m · 남북 1.2 m): 널빤지 상판 셋, 양옆 긴 의자, 양 끝 다리·의자 받침, 가운데 파라솔.
 * 상판(0.78 m) 아래로 몸을 숙이면 상판·의자에 가려진다. canopy = 파라솔 천 재질
 */
function picnic(cx, cz, canopy) {
  const r = (x0, z0, x1, z1, y0, y1, m) => rect(cx + x0, cz + z0, cx + x1, cz + z1, y0, y1, m);
  const out = [];
  for (const z of [-0.33, -0.11, 0.11]) out.push(r(-1.3, z, 1.3, z + 0.21, 0.72, 0.78, 'wood'));   // 상판 널빤지 셋(틈 0.01)
  for (const s of [-1, 1]) {
    out.push(r(-1.3, s * 0.45 - 0.14, 1.3, s * 0.45 + 0.14, 0.42, 0.47, 'wood'));                    // 긴 의자
    out.push(r(s * 1.0 - 0.05, -0.6, s * 1.0 + 0.05, 0.6, 0.36, 0.42, 'wood_dark'));                 // 의자 받침(양 끝)
    out.push(r(s * 1.0 - 0.05, -0.12, s * 1.0 + 0.05, 0.12, 0, 0.72, 'wood_dark'));                  // 탁자 다리(양 끝)
    out.push(r(s * 1.0 - 0.05, -0.5, s * 1.0 + 0.05, -0.38, 0, 0.42, 'wood_dark'));                  // 의자 다리
    out.push(r(s * 1.0 - 0.05, 0.38, s * 1.0 + 0.05, 0.5, 0, 0.42, 'wood_dark'));
  }
  out.push(cyl(cx, 0.78, cz, 0.04, 1.5, 'steel'));                                                      // 파라솔 기둥
  out.push(r(-0.9, -0.9, 0.9, 0.9, 2.28, 2.34, canopy));                                               // 파라솔 천
  out.push(r(-0.55, -0.55, 0.55, 0.55, 2.34, 2.42, canopy));
  return out;
}

/**
 * 자판기(폭 x0~x1, 앞면은 남쪽 z −3.4). 몸통 위에 진열창(유리 뒤로 색색 음료 줄 셋), 오른쪽 동전·버튼 판,
 * 아래 꺼내는 칸, 위 빛나는 이름판, 밑받침. 몸통 크기(높이 1.9)는 예전과 같다
 */
function vending(x0, x1, body, sign) {
  const zb = -4.6, zf = -3.4;
  const out = [
    rect(x0 - 0.03, zb - 0.03, x1 + 0.03, zf + 0.03, 0, 0.08, 'metal_dark'),   // 밑받침
    rect(x0, zb, x1, zf, 0.08, 1.9, body),                                      // 몸통
    rect(x0 + 0.06, zf, x1 - 0.25, zf + 0.02, 0.9, 1.72, 'metal_dark'),         // 진열창 바탕
    rect(x0 + 0.06, zf + 0.04, x1 - 0.25, zf + 0.06, 0.9, 1.72, 'glass'),       // 진열창 유리
    rect(x1 - 0.22, zf, x1 - 0.05, zf + 0.03, 0.95, 1.65, 'metal_dark'),        // 동전·버튼 판
    rect(x1 - 0.17, zf + 0.03, x1 - 0.1, zf + 0.05, 1.45, 1.55, 'neon_cyan'),   // 버튼
    rect(x0 + 0.1, zf, x1 - 0.1, zf + 0.04, 0.2, 0.45, 'metal_dark'),           // 꺼내는 칸
    rect(x0 + 0.03, zf, x1 - 0.03, zf + 0.03, 1.76, 1.88, sign)                 // 이름판(빛남)
  ];
  // 진열창 안 음료 줄 셋(색이 다른 캔)
  const rows = [['container_red', 1.5], ['yellow', 1.25], ['neon_pink', 1.0]];
  for (const [m, y] of rows) out.push(rect(x0 + 0.1, zf + 0.02, x1 - 0.29, zf + 0.04, y, y + 0.14, m));
  return out;
}

const front = [
  // 피크닉 탁자 둘(차양 앞)
  ...picnic(-6.9, 1.6, 'container_red'),
  ...picnic(6.9, 1.6, 'yellow'),
  // 자판기 셋(차양 기둥 옆)
  ...vending(-14.5, -13.6, 'container_red', 'neon_pink'),
  ...vending(-13.4, -12.5, 'white', 'neon_cyan'),
  ...vending(12.5, 13.4, 'container_red', 'neon_pink')
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
  // 화장실 옥상 사다리 양옆 손잡이
  { type: 'pipe', from: [-23.25, 0, -14.22], to: [-25.5, 4.3, -14.22], r: 0.04, mat: 'steel' },
  { type: 'pipe', from: [-23.25, 0, -11.78], to: [-25.5, 4.3, -11.78], r: 0.04, mat: 'steel' },
  // 관광버스 지붕 사다리 양옆 손잡이
  { type: 'pipe', from: [16.48, 0, 14.7], to: [16.48, 3.8, 17.1], r: 0.04, mat: 'steel' },
  { type: 'pipe', from: [17.92, 0, 14.7], to: [17.92, 3.8, 17.1], r: 0.04, mat: 'steel' },
  // 판자 다리 양옆 밧줄(장식)
  { type: 'pipe', from: [9.9, 4.8, -14.42], to: [13.3, 4.75, -14.42], r: 0.025, mat: 'wood_dark' },
  { type: 'pipe', from: [9.9, 4.8, -13.38], to: [13.3, 4.75, -13.38], r: 0.025, mat: 'wood_dark' },
  { type: 'pipe', from: [13.3, 3.96, -14.42], to: [13.3, 4.75, -14.42], r: 0.04, mat: 'wood_dark' },
  { type: 'pipe', from: [13.3, 3.96, -13.38], to: [13.3, 4.75, -13.38], r: 0.04, mat: 'wood_dark' },
  // 계산 부스 옥상 사다리 양옆 손잡이
  { type: 'pipe', from: [-26.1, 0, 7.53], to: [-28.2, 3.6, 7.53], r: 0.04, mat: 'steel' },
  { type: 'pipe', from: [-26.1, 0, 8.47], to: [-28.2, 3.6, 8.47], r: 0.04, mat: 'steel' },
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
  { type: 'crate', x: 27.4, y: 0, z: -7.6 }
];

export default {
  id: 'restarea',
  name: '고속도로 휴게소',
  nameEn: 'Highway Rest Stop',
  desc: '문 닫은 밤 휴게소. 편의점 앞에서 시작해 갓길·화장실·정비 마당·숲길로 몰려오는 좀비를 막는다. 편의점 옥상은 바깥 계단, 화장실과 관광버스 지붕은 사다리로 오른다.',
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
    ...store, ...roofStairs, ...restroom, ...noiseWall, ...clipAbove(noiseSpans, 6), ...shoulder,
    ...northEast, ...yard, ...station, ...parking, ...front, ...hedge, ...scenery
  ],
  decor,
  pads: [],
  portals: [],
  secrets: [],
  props,
  // 정비 마당 리프트: 바닥에 묻힌 판(높이 2.6)이 2.4 m 올라와 울타리 높이(2.6 m)까지 오른다. 쉴 때 윗면은 0.2라 그냥 올라선다
  movers: [
    { id: 'yard_lift', x: 29, y: -2.4, z: -2.5, w: 2.6, h: 2.6, d: 2.6, mat: 'yellow', axis: 'y', dist: 2.4, period: 12, hold: 3, phase: 0 }
  ]
};
