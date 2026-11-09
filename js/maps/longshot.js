/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 스나 전용 맵 협곡 저격장(Long Canyon) 데이터. 해 질 녘 금빛 사암 협곡 양끝의 고지대 진지와 세 저격 레인, 중앙 갱도, 포털로 가는 비밀 관측소를 180° 회전 대칭으로 담았다.
 */
import { box, ramp, cyl, stairs, platform, clipAbove, rotate180 } from './kit.js';

/*
 * 위에서 본 모습 (북 = -z). 절반만 적고 rotate180으로 나머지 절반을 만든다.
 * 회전 대칭이라 능선과 강바닥은 맵 가운데에서 남북이 서로 바뀐다. 양 팀 모두 왼쪽이 능선, 오른쪽이 강바닥이다.
 *
 *  x: -65     -46      -24        0        24      46     65
 *  z=-30 ████████████████ 협곡 북벽 ██████████████████████
 *  z=-25 █ 블루 █ 능선길(y=4) █ 북쪽 광장 █ 마른 강(y=-1.5) █ 오렌지 █
 *  z=-15 █ 진지 █  ▲ 갱도 ─────────┐ 바위 등줄기 (오렌지 첨탑) █ 진지 █
 *  z=-5  █ y=7  █ 중앙 레인 (폭 4 m 빈 길, 약 100 m 시야선) ── █ y=7 █
 *  z=+5  █      █ (블루 첨탑) 바위 등줄기 └───────── 갱도 ▲ █      █
 *  z=+15 █      █ 마른 강(y=-1.5) █ 남쪽 광장 █ 능선길(y=4) █      █
 *  z=+30 ████████████████ 협곡 남벽 ██████████████████████
 *
 * 긴 시야선: 진지 앞 은신처 ↔ 맞은편 진지(중앙 레인, 100 m 이상), 능선길 ↔ 맞은편 마른 강(z=±20 줄, 85 m).
 * 중앙 레인은 z=-2..2를 비워 두고 엄폐물은 양옆으로만 둔다. 건너는 순간이 위험하다.
 * 관측소는 원점 위 자연 아치 꼭대기(y=20)에 있고, 갱도 안 바위 뒤에 숨은 포털로만 올라간다.
 */

// 재질 역할. sand 무늬의 가는 물결은 수직면에서 가로 지층처럼 보여서 벼랑을 금빛 사암으로 그린다.
// stone 무늬는 쌓은 돌로 읽혀서 사람이 만든 낮은 벽에 쓴다
const CLIFF = 'sand';   // 금빛 사암: 벼랑, 등줄기, 버섯바위
const STRATA = 'rust';  // 짙은 붉은 지층
const BOULDER = 'rust'; // 엄폐 바위. 사암 바닥에서 또렷하게 보인다
const PATH = 'sand';    // 다진 흙길, 경사로
const MASON = 'stone';  // 돌담, 낮은 벽
const FORT = 'wood';    // 진지 목책

const FIRE = 7;      // 진지 윗면
const RIDGE = 4;     // 능선길 윗면
const BED = -1.5;    // 강바닥 윗면
const NEST = 13;     // 저격 둥지 바닥
const EYRIE = 20;    // 아치 윗면
const DECK = EYRIE + 0.12; // 관측소 바닥

const FACE_EAST = -Math.PI / 2; // 스폰·포털 시선 +x
const FACE_WEST = Math.PI / 2;  // 스폰·포털 시선 -x
const SHOW_EAST = Math.PI / 2;  // 표지판 앞면 +x
const SHOW_WEST = -Math.PI / 2; // 표지판 앞면 -x
const SHOW_NORTH = Math.PI;     // 표지판 앞면 -z
const SHOW_SOUTH = 0;           // 표지판 앞면 +z

/** 카메라가 (x,z)에서 (tx,tz)를 보는 rotY */
const look = (x, z, tx, tz) => Math.atan2(-(tx - x), -(tz - z));

/** 둥근 바위. 높으면 작은 돌을 하나 얹어 윗선을 깨뜨린다 */
function boulder(x, y, z, r, h, mat = BOULDER) {
  const out = [cyl(x, y, z, r, h, mat)];
  if (h >= 1.9) out.push(cyl(x + r * 0.22, y + h, z - r * 0.18, r * 0.62, r * 0.55, mat));
  return out;
}

/**
 * 판자 가림막. 양 끝 돌에 걸린 얇은 판자가 바닥에서 14 cm 떠 있어 몸은 가려도 발은 보인다.
 * 두께가 12 cm라 판자에 바짝 붙으면 손끝이 앞으로 삐져나온다. 저격총으로는 둘 다 반샷이다.
 */
function footGap(x, y, z0, z1, h, postMat = MASON) {
  const mid = (z0 + z1) / 2;
  return [
    box(x, y + 0.14, mid, 0.12, h - 0.14, z1 - z0, 'wood_dark'),
    box(x, y, z0, 0.7, h + 0.25, 0.6, postMat),
    box(x, y, z1, 0.7, h + 0.25, 0.6, postMat)
  ];
}

/** 판자 한 장: 양 끝을 이미 있는 바위나 벽에 물린다. 기둥이 없어 solid 하나로 끝난다 */
function plank(x, y, z0, z1, h) {
  return box(x, y + 0.14, (z0 + z1) / 2, 0.12, h - 0.14, z1 - z0, 'wood_dark');
}

/* ---------------- 협곡 벽 ---------------- */

const canyonWall = [
  // 벼랑: 턱들보다 높은 곳에 붉은 지층이 끊기지 않고 지나간다
  box(0, -2, -28, 130, 15.6, 4, CLIFF),
  box(0, 13.6, -28.2, 130, 1.6, 3.6, STRATA),
  box(0, 15.2, -28.4, 130, 1.8, 3.2, CLIFF),
  // 안쪽으로 튀어나온 바위 턱: [x0, x1, 안쪽 z, 윗면]
  ...[
    [-65, -57, -24.9, 12.5], [-57, -49, -25.3, 10.4], [-49, -41, -24.7, 13.4], [-41, -33.5, -25.5, 9.6], [-33.5, -26, -25, 11.8],
    [-15, -6.5, -25.2, 10.8], [-6.5, 3, -25.6, 12.6], [13, 22, -25.2, 12.9], [30, 38, -25, 11.4], [48, 56, -25.3, 10.2], [56, 65, -24.8, 13]
  ].map(([x0, x1, zIn, top]) => box((x0 + x1) / 2, -2, (zIn - 26) / 2, x1 - x0, top + 2, zIn + 26, CLIFF)),
  // 턱 앞을 지나는 가는 붉은 지층과 벼랑 밑단의 짙은 층: 바닥과 벼랑의 경계를 또렷하게 한다
  box(0, 8.9, -25.3, 130, 0.5, 1.4, STRATA),
  box(-24, RIDGE, -25.25, 44, 1, 1.5, STRATA),
  box(24, 0, -25.25, 44, 1.5, 1.5, STRATA),
  // 둥근 벼랑 기둥
  cyl(-20, -2, -27.6, 3.2, 14.6, CLIFF),
  cyl(8.5, -2, -27.8, 3.4, 13.4, CLIFF),
  cyl(26, -2, -27.6, 3.2, 12.6, CLIFF),
  cyl(43, -2, -27.7, 3.3, 15.2, CLIFF),
  // 벽 위 능선 실루엣
  box(-54, 17, -28.6, 13, 2, 2.4, CLIFF),
  box(-33, 17, -28.8, 9, 3.4, 2.2, CLIFF),
  cyl(-21, 17, -28.5, 1.9, 4.2, CLIFF),
  box(14, 17, -28.6, 8, 2.8, 2.4, CLIFF),
  box(52, 17, -28.7, 12, 2.2, 2.2, CLIFF)
];

/* ---------------- 블루 진지 (y=7) ---------------- */

const firebase = [
  // 바위 기단(윗면이 다진 흙길이다)과 앞면 지층
  box(-55.5, 0, 0, 19, FIRE, 52, CLIFF),
  box(-46, FIRE - 1.1, -21, 0.2, 0.55, 10, STRATA),
  box(-46, FIRE - 1.1, 2, 0.2, 0.55, 22, STRATA),
  // 뒤쪽 벼랑
  box(-64, FIRE - 0.4, 0, 2, 7, 52, CLIFF),
  box(-64.2, 13.6, 0, 1.6, 1.6, 52.8, STRATA),
  box(-64.3, 15.2, 0, 1.4, 1.8, 53.6, CLIFF),
  box(-62.6, FIRE, -18, 0.8, 5.2, 16, CLIFF),
  box(-62.6, FIRE, 18, 0.8, 6.2, 16, CLIFF),
  cyl(-63.6, FIRE, 0, 2.2, 6.4, CLIFF),
  // 앞면: 바위 받침과 돌담
  box(-45.3, 0, -14.6, 1.4, 5.3, 5.8, MASON),
  box(-45.2, -2, 17.5, 1.6, 7.8, 6, MASON),
  cyl(-46, -2, 14.6, 2, 7.4, CLIFF),

  // 앞 경사로: 남쪽에서 올라 앞 보루에 닿는다 + 바깥쪽 턱
  ramp(-43.75, 0, 3, 4.5, FIRE, 18, '-z', PATH),
  ramp(-41.3, 0, 3, 0.4, FIRE + 1, 18, '-z', MASON),
  box(-43.75, 0, -9, 4.5, FIRE, 6, MASON),
  box(-43.75, FIRE, -11.85, 4.5, 1.15, 0.3, MASON),
  box(-41.65, FIRE, -9, 0.3, 1.25, 5.4, MASON),

  // 남쪽 계단과 자갈 경사로: 강바닥에서 진지로
  ramp(-34.5, BED, 22.5, 15, 6, 4, '-x', PATH),
  box(-44, BED, 22.5, 4, 6, 4, MASON),
  ...stairs(-44, 4.5, 22.5, 4, 2.5, 4, '-x', MASON, 6),

  // 북쪽 경사로: 능선길로
  ramp(-42.5, RIDGE, -22.5, 7, FIRE - RIDGE, 5, '-x', PATH),

  // 스폰 안뜰: 돌 기단 위 목책(동쪽 벽은 관측소 높이에서도 안 보이게 높다)
  box(-54.2, FIRE, 0, 1, 1.5, 17, MASON),
  box(-54.25, FIRE + 1.5, 0, 0.8, 1.1, 16.6, FORT),
  box(-54.3, FIRE + 2.6, 0, 0.3, 0.9, 16.2, 'wood_dark'),
  box(-61.1, FIRE, -8, 3.8, 2.5, 0.9, FORT),
  box(-55.6, FIRE, -8, 1.8, 2.3, 0.9, FORT),
  box(-61.1, FIRE, 8, 3.8, 2.5, 0.9, FORT),
  box(-55.6, FIRE, 8, 1.8, 2.3, 0.9, FORT),
  box(-58, FIRE, -11.2, 4.4, 2.2, 0.8, FORT),
  box(-58, FIRE, 11.2, 4.4, 2.2, 0.8, FORT),
  // 쌓아 둔 탄약 상자(장식)에 부딪히게 하는 막이
  box(-61.5, FIRE, -6.4, 2.2, 2.2, 2.2, 'clip'),
  box(-50, FIRE, 21.5, 3.4, 3.3, 3.4, 'clip'),

  // 앞 난간: 틈으로 내다본다
  box(-46.6, FIRE, -16.2, 0.7, 1.2, 7.6, MASON),
  box(-46.6, FIRE, 9.5, 0.7, 1.15, 7, MASON),
  box(-46.6, FIRE, 17, 0.7, 1.25, 6.8, MASON)
];

/** 진지 앞 저격 은신처: 양철 지붕을 얹은 나무 상자, 앞면 전체가 눈높이 틈이다 */
function hide(zc) {
  const L = 4.2;
  return [
    box(-46.4, FIRE, zc, 0.3, 1.4, L + 0.1, 'wood_dark'),
    box(-47.45, FIRE + 1.9, zc, 2.5, 0.5, L + 0.2, 'rust'),
    box(-47.45, FIRE, zc - L / 2 + 0.1, 2.3, 1.9, 0.2, 'wood_dark'),
    box(-47.45, FIRE, zc + L / 2 - 0.1, 2.3, 1.9, 0.2, 'wood_dark')
  ];
}

/* ---------------- 북쪽: 능선길 (y=4) ---------------- */

const ridge = [
  box(-36.5, 0, -21.75, 19, RIDGE, 8.5, CLIFF),
  ...platform(-24, RIDGE, -22, 6, 7, 'wood_dark', { t: 0.25, leg: 0.35 }),
  box(-17, 0, -21.5, 8, RIDGE, 9, CLIFF),
  ...platform(-10.5, RIDGE, -22, 5, 7, 'wood_dark', { t: 0.25, leg: 0.35 }),
  box(-7, 0, -22.5, 2, RIDGE, 7, CLIFF),
  // 올라가는 길: 분지에서, 북쪽 광장에서
  ramp(-34, 0, -16, 10, RIDGE, 3, '+x', PATH),
  ramp(-1, 0, -23, 10, RIDGE, 4, '-x', PATH),
  // 길을 가로지르는 낮은 돌담(엇갈려 놓아 지그재그로 달린다)
  box(-35, RIDGE, -23, 0.5, 1.15, 4, MASON),
  box(-30.8, RIDGE, -19.6, 0.5, 1.25, 4, MASON),
  box(-18.5, RIDGE, -23.6, 0.5, 1.2, 4, MASON),
  box(-14.6, RIDGE, -19, 0.5, 1.1, 4, MASON),
  ...footGap(-24, RIDGE, -22.6, -19.4, 1.9, 'wood_dark'),
  // 남쪽 가장자리 바위
  box(-37.5, RIDGE, -17.9, 3.2, 0.9, 0.8, BOULDER)
];

/* ---------------- 남쪽: 마른 강바닥 (y=-1.5) ---------------- */

const riverbed = [
  // 바닥 상자가 땅을 도려낸다. 내비는 몸이 한 구멍 안에 통째로 들어가야 지나가므로 이웃 구역을 1 m 겹치고,
  // 겹친 곳이 깜빡이지 않게 윗면 높이를 4 cm 어긋낸다
  box(-39.25, BED - 0.5, 20, 13.5, 0.5, 9, 'sand'),
  box(-26.5, BED - 0.5, 19.25, 14, 0.54, 8.5, 'sand'),
  box(-15.5, BED - 0.5, 20.25, 10, 0.5, 7.5, 'sand'),
  box(-9.25, BED - 0.5, 18.5, 4.5, 0.54, 6, 'sand'),
  // 나가는 길: 북쪽 둑으로, 남쪽 광장으로
  ramp(-35.5, BED, 17.5, 4, -BED, 4, '-z', PATH),
  ramp(-9, BED, 18.5, 4, -BED, 6, '+x', PATH),
  // 둑 너머로 내다보는 돌 발판
  box(-39.8, BED, 16, 3, 0.42, 1, BOULDER),
  box(-20, BED, 15.5, 2.6, 0.42, 1, BOULDER),
  // 엄폐 바위와 판자 가림막
  ...boulder(-38, BED, 19.6, 1.5, 2),
  ...boulder(-29, BED, 18.2, 1.4, 2.2),
  ...footGap(-23.5, BED, 18.4, 21.8, 1.9),
  ...boulder(-17.5, BED, 22, 1.5, 1.9),
  ...boulder(-13.6, BED, 18.6, 1.2, 1.3),
  plank(-29, BED, 14.9, 17, 1.9),
  plank(-13.6, BED, 16.4, 17.6, 1.8)
];

/* ---------------- 바위 등줄기와 갱도 (북쪽 것을 적으면 회전 복사가 남쪽이 된다) ---------------- */

const tunnel = [
  // 복도: x -24..6, z -13..-9, 천장 3.2. 벽 바깥이 그대로 등줄기 바위다
  box(-10.25, 0, -14, 27.5, 6, 2, CLIFF),
  box(4.75, 3.2, -14, 2.5, 2.8, 2, CLIFF),
  box(7, 0, -12, 2, 6, 6, CLIFF),
  box(-22, 0, -6.75, 4, 6, 4.5, CLIFF),
  box(-14.5, 0, -5, 11, 6, 1, CLIFF),
  box(-5.5, 0, -6.75, 7, 6, 4.5, CLIFF),
  box(5, 0, -6.75, 6, 6, 4.5, CLIFF),
  box(-9, 3.2, -11, 30, 2.8, 4, CLIFF),
  box(-14.5, 3.2, -7.25, 11, 2.8, 3.5, CLIFF),
  box(0, 3.2, -6.75, 4, 2.8, 4.5, CLIFF),
  // 동쪽 절반의 속이 찬 등줄기
  box(16, 0, -11, 16, 6, 8, CLIFF),
  // 등줄기 윗면: 붉은 덮개 지층이 살짝 튀어나오고 그 위에 바위가 솟는다
  box(-8, 6, -9.75, 32.4, 0.6, 10.9, STRATA),
  box(16.2, 6, -11, 16, 0.6, 8.4, STRATA),
  box(-19, 6.6, -12, 5, 1.6, 5, CLIFF),
  box(-10, 6.6, -13.2, 6, 1.1, 3, CLIFF),
  cyl(-14, 6.6, -7.4, 1.8, 1.3, CLIFF),
  box(12, 6.6, -10.5, 6, 2.4, 5, CLIFF),
  cyl(19.5, 6.6, -11.8, 2.4, 1.7, CLIFF),
  // 갱도 안 엄폐
  cyl(-22, 0, -11.9, 0.9, 1.15, BOULDER),
  ...footGap(-5.5, 0, -12.7, -11.1, 1.9),
  box(3.4, 0, -10, 0.6, 1.15, 2, MASON),
  box(0.8, 0, -12.4, 1.1, 1.1, 1.1, 'wood'),
  // 비밀 포털을 가리는 바위 세 개. 틈은 동쪽 한 곳뿐이다
  cyl(-14.2, 0, -8.9, 1.9, 2.9, BOULDER),
  cyl(-18.8, 0, -8.4, 1.6, 2.6, BOULDER),
  cyl(-11.3, 0, -8.1, 1.1, 2.2, BOULDER),
  // 입구를 지키는 바위, 북쪽 광장의 바위
  ...boulder(-27.4, 0, -12.6, 1.7, 2.4),
  ...boulder(1.6, 0, -18.6, 1.4, 2.2)
];

/* ---------------- 중앙 레인과 분지 (서쪽 절반). z=-2..2는 비워 둔다 ---------------- */

const lane = [
  ...boulder(-36, 0, 4, 2, 2.6),
  box(-33, 0, -4.4, 0.7, 1.15, 4.4, MASON),
  ...footGap(-29.5, 0, 2.5, 6, 1.9),
  ...boulder(-26.5, 0, -4.1, 1.7, 2.1),
  ...boulder(-38, 0, -9, 1.5, 1.6),
  box(-35.5, 0, 9.5, 0.7, 1.1, 4.6, MASON),
  ...boulder(-21, 0, 3.8, 1.5, 2.4),
  ...boulder(-14.5, 0, 4.2, 1.3, 1.25),
  ...boulder(-17, 0, -3.4, 1.1, 1.7),
  ...boulder(-10.5, 0, 3.1, 1, 1.1),
  ...footGap(-6.5, 0, -4.2, -2.4, 1.45),
  plank(-21, 0, 5, 7.2, 1.9),
  plank(-10.5, 0, 3.8, 7.1, 1.45)
];

/* ---------------- 첨탑과 저격 둥지 (블루 쪽, y=13) ---------------- */

const nestRoof = box(-25.6, NEST + 1.9, 11.5, 4.6, 0.5, 7.2, 'rust');
const spire = [
  // 버섯바위: 굵은 밑동, 잘록한 목, 넓은 머리
  cyl(-27.6, -2, 11.4, 4.3, 8.5, CLIFF),
  cyl(-27.3, 6.5, 11.7, 3.5, 3.1, CLIFF),
  cyl(-27.8, 9.6, 11.4, 3, 1.6, CLIFF),
  cyl(-27.6, 11.2, 11.5, 4.6, 1.4, STRATA),
  box(-27.7, NEST - 0.4, 11.5, 8.6, 0.4, 7.2, 'wood_dark'),
  // 사격실: 허리 벽 + 틈 + 덮개. 틈은 폭 1 m로 좁고, 발밑 강바닥과 레인을 내려다보도록 위아래로 조금 길다
  box(-23.75, NEST, 11.5, 0.3, 1, 6.8, 'wood_dark'),
  box(-25.65, NEST, 8.35, 3.9, 1, 0.3, 'wood_dark'),
  box(-25.65, NEST, 14.65, 3.9, 1, 0.3, 'wood_dark'),
  box(-23.75, NEST + 1, 8.8, 0.3, 0.9, 1.4, 'wood_dark'),
  box(-23.75, NEST + 1, 11.5, 0.3, 0.9, 2, 'wood_dark'),
  box(-23.75, NEST + 1, 14.2, 0.3, 0.9, 1.4, 'wood_dark'),
  box(-26.85, NEST + 1, 8.35, 1.5, 0.9, 0.3, 'wood_dark'),
  box(-24.4, NEST + 1, 8.35, 1.4, 0.9, 0.26, 'wood_dark'),
  box(-26.85, NEST + 1, 14.65, 1.5, 0.9, 0.3, 'wood_dark'),
  box(-24.4, NEST + 1, 14.65, 1.4, 0.9, 0.26, 'wood_dark'),
  nestRoof,
  // 착지 마당의 벽은 점프로 못 넘는 높이다. 서쪽은 발판 궤적과 뛰어내리는 길이라 비워 둔다. 지붕 위에는 못 선다
  box(-29.8, NEST, 8.3, 4.4, 1.6, 0.3, 'wood_dark'),
  box(-29.8, NEST, 14.7, 4.4, 1.6, 0.3, 'wood_dark'),
  ...clipAbove(nestRoof, 5)
];

/* ---------------- 아치와 관측소 (북쪽 다리, 회전 복사가 남쪽 다리) ---------------- */

const archLeg = [
  cyl(0.4, 6, -11.2, 4.6, 5.6, CLIFF),
  cyl(0, 11.6, -10, 4.2, 3.2, STRATA),
  box(0, 14.8, -8.4, 8, 2.6, 7.2, CLIFF),
  // 관측소 기둥
  box(-2.2, DECK, -1.8, 0.2, 2.4, 0.2, 'wood_dark'),
  box(2.2, DECK, -1.8, 0.2, 2.4, 0.2, 'wood_dark'),
  // 진지 쪽을 가리는 낮은 난간
  box(-3.4, EYRIE, 1.2, 0.4, 1, 3.6, MASON)
];

/* ---------------- 보이지 않는 막이: 벼랑 턱과 뒷벽 위로 못 오른다 ---------------- */

const clips = [
  box(0, 8, -27, 130, 32, 6.4, 'clip'),
  box(-63.5, 11, 0, 3, 29, 52, 'clip')
];

/* ---------------- 합치기 ---------------- */

const half = [
  canyonWall, firebase, hide(-3.5), hide(3.5), ridge, riverbed, tunnel, lane, spire, archLeg, clips
].flat(Infinity);

const center = [
  box(0, 17.4, 0, 7.2, EYRIE - 17.4, 14, CLIFF),
  box(0, EYRIE, 0, 6, 0.12, 9, 'wood_dark'),
  box(0, DECK + 2.4, 0, 5, 0.2, 4.2, 'rust'),
  cyl(0, 0, 0, 1.15, 1.05, BOULDER)
];

/* ---------------- 스폰 ---------------- */

// 안뜰 출구 쪽을 보고 시작한다. 출구는 목책 양 끝이다
const owner = [
  { x: -60, y: FIRE, z: -4.8, rotY: look(-60, -4.8, -57.85, -8) },
  { x: -60, y: FIRE, z: 5, rotY: look(-60, 5, -57.85, 8) },
  { x: -57, y: FIRE, z: -2, rotY: look(-57, -2, -57.85, -8) },
  { x: -57, y: FIRE, z: 2, rotY: look(-57, 2, -57.85, 8) },
  { x: -60.5, y: FIRE, z: 0, rotY: FACE_EAST }
];

// 개인전 스폰: 모두 지붕 밑이나 바위·판자 바로 뒤라 일어서도 몸이 바로 보이지 않는다. 가림막을 등지고 길을 본다
const ffaHalf = [
  { x: -47.4, y: FIRE, z: 2.6, rotY: FACE_EAST },
  { x: -24.2, y: 0, z: -22, rotY: Math.PI },
  { x: -24.9, y: RIDGE, z: -21, rotY: FACE_WEST },
  { x: -24.6, y: BED, z: 20, rotY: look(-24.6, 20, -33, 21) },
  { x: -41, y: BED, z: 17.6, rotY: look(-41, 17.6, -30, 17.2) },
  { x: -7, y: 0, z: -12, rotY: FACE_WEST },
  { x: -0.7, y: 0, z: -18.5, rotY: look(-0.7, -18.5, -20, -16.8) },
  { x: -39, y: 0, z: 4.2, rotY: look(-39, 4.2, -24, -1) }
];

/* ---------------- 장식 ---------------- */

const WARM = { bg: '#3a2a1c', fg: '#ffe2b0' };

/** 말라 죽은 나무: 줄기 하나와 가지 셋. 충돌 없음 */
function deadTree(x, y, z, h = 3.4, turn = 0) {
  const arm = (a, up, len) => ({ type: 'pipe', from: [x, y + h * up, z], to: [x + Math.cos(turn + a) * len, y + h * (up + 0.34), z + Math.sin(turn + a) * len], r: 0.045, mat: 'wood_dark' });
  return [
    { type: 'pipe', from: [x, y, z], to: [x + 0.1, y + h * 0.82, z - 0.08], r: 0.09, mat: 'wood_dark' },
    arm(0.4, 0.5, 1.1), arm(2.6, 0.62, 1), arm(4.4, 0.7, 0.8)
  ];
}

/** 멀리 서 있는 메사: 사암 몸통, 붉은 층, 좁아지는 머리. 벼랑 너머로 윗부분이 보인다 */
function mesa(x, z, r, h) {
  return [
    { type: 'pipe', from: [x, -1, z], to: [x, h * 0.62, z], r, mat: CLIFF },
    { type: 'pipe', from: [x, h * 0.62, z], to: [x, h * 0.72, z], r: r * 0.95, mat: STRATA },
    { type: 'pipe', from: [x, h * 0.72, z], to: [x, h, z], r: r * 0.8, mat: CLIFF }
  ];
}

/** 벼랑 위 첨탑: 능선을 들쭉날쭉하게 깨뜨린다. 막이 위라 충돌이 필요 없다 */
const pinnacle = (x, top, r, z = -30) => ({ type: 'pipe', from: [x, 14, z], to: [x, top, z], r, mat: CLIFF });

const decorHalf = [
  // 표지판
  { type: 'sign', x: -53.82, y: FIRE + 2.05, z: 5, rotY: SHOW_EAST, w: 3.2, h: 0.7, text: '장거리 사격 구역', ...WARM },
  { type: 'sign', x: -37, y: RIDGE + 1.6, z: -25.45, rotY: SHOW_SOUTH, w: 3, h: 0.7, text: '능선길 RIDGE WALK', ...WARM },
  { type: 'pipe', from: [-39.2, 0, 15.2], to: [-39.2, 1.7, 15.2], r: 0.05, mat: 'wood_dark' },
  { type: 'sign', x: -39.2, y: 1.35, z: 15.26, rotY: SHOW_SOUTH, w: 2.6, h: 0.6, text: '마른 강 DRY WASH', ...WARM },
  { type: 'sign', x: -24.05, y: 3.95, z: -11, rotY: -Math.PI / 2, w: 3.4, h: 0.6, text: '중앙 갱도 MID TUNNEL', ...WARM },
  { type: 'sign', x: -14, y: 2.1, z: -12.95, rotY: SHOW_SOUTH, w: 3.6, h: 0.55, text: '낙석 구역: 바위 뒤 출입 금지', bg: '#7a2f18', fg: '#fff0d8' },
  // 안뜰 안쪽 길잡이: 양 팀 모두 왼쪽이 능선길, 오른쪽이 마른 강이다
  { type: 'sign', x: -54.75, y: FIRE + 2.1, z: -3.9, rotY: SHOW_WEST, w: 3, h: 0.62, text: '◀ 능선길 RIDGE', ...WARM },
  { type: 'sign', x: -54.75, y: FIRE + 2.1, z: 3.9, rotY: SHOW_WEST, w: 3, h: 0.62, text: '마른 강 WASH ▶', ...WARM },
  // 환기구
  { type: 'vent', x: -24.01, y: 5, z: -13.9, rotY: -Math.PI / 2, w: 1.1, h: 0.7 },
  { type: 'vent', x: -6, y: 2.4, z: -12.98, rotY: SHOW_SOUTH, w: 1.2, h: 0.7 },
  { type: 'vent', x: -47.4, y: FIRE + 1.2, z: -5.62, rotY: SHOW_NORTH, w: 0.9, h: 0.6 },
  // 밧줄
  { type: 'pipe', from: [-27, RIDGE, -18.7], to: [-27, RIDGE + 1.25, -18.7], r: 0.05, mat: 'wood_dark' },
  { type: 'pipe', from: [-21, RIDGE, -18.7], to: [-21, RIDGE + 1.25, -18.7], r: 0.05, mat: 'wood_dark' },
  { type: 'rope', from: [-27, RIDGE + 1.2, -18.7], to: [-21, RIDGE + 1.2, -18.7], sag: 0.18, r: 0.03 },
  { type: 'pipe', from: [-13, RIDGE, -18.7], to: [-13, RIDGE + 1.25, -18.7], r: 0.05, mat: 'wood_dark' },
  { type: 'pipe', from: [-8, RIDGE, -18.7], to: [-8, RIDGE + 1.25, -18.7], r: 0.05, mat: 'wood_dark' },
  { type: 'rope', from: [-13, RIDGE + 1.2, -18.7], to: [-8, RIDGE + 1.2, -18.7], sag: 0.16, r: 0.03 },
  { type: 'rope', from: [-22, 11, -25], to: [-12, 7.6, -13.5], sag: 0.8, r: 0.03 },
  // 상자 더미
  { type: 'crateStack', x: -61.5, y: FIRE, z: -6.4, rotY: 0.2, levels: 2 },
  { type: 'crateStack', x: -50, y: FIRE, z: 21.5, rotY: -0.3, levels: 3 },
  { type: 'crateStack', x: -21.5, y: 1.5, z: 25.2, rotY: 1.1, levels: 1 },
  // 비계 가새
  { type: 'pipe', from: [-26.8, 0.2, -18.7], to: [-21.2, 3.6, -18.7], r: 0.05, mat: 'wood_dark' },
  { type: 'pipe', from: [-21.2, 0.2, -18.7], to: [-26.8, 3.6, -18.7], r: 0.05, mat: 'wood_dark' },
  { type: 'pipe', from: [-26.8, 0.2, -18.7], to: [-26.8, 3.6, -24.4], r: 0.05, mat: 'wood_dark' },
  { type: 'pipe', from: [-12.8, 0.2, -18.7], to: [-8.2, 3.6, -18.7], r: 0.05, mat: 'wood_dark' },
  { type: 'pipe', from: [-8.2, 0.2, -18.7], to: [-12.8, 3.6, -18.7], r: 0.05, mat: 'wood_dark' },
  // 둥지 안 표지판과 등
  { type: 'sign', x: -23.92, y: NEST + 0.62, z: 11.5, rotY: -Math.PI / 2, w: 2.2, h: 0.5, text: '둥지: 발은 숨기고 숨은 참기', bg: '#7a2f18', fg: '#fff0d8' },
  { type: 'lantern', x: -26.2, y: NEST + 1.62, z: 11.5, r: 0.14, color: '#ffb35c', cord: 0.12 },
  // 깃대
  { type: 'pipe', from: [-50, FIRE, 0], to: [-50, FIRE + 6.6, 0], r: 0.06, mat: 'wood_dark' },
  // 갱도 등
  { type: 'light', x: -18, y: 2.98, z: -11, color: '#ffc27a', intensity: 1, dist: 12 },
  { type: 'light', x: -3, y: 2.98, z: -11, color: '#ffc27a', intensity: 1, dist: 12 },
  // 안뜰 목책의 팔걸이 등
  ...[-6.6, 6.6].flatMap((z) => [
    { type: 'pipe', from: [-54.7, FIRE + 3.3, z], to: [-55.3, FIRE + 3.3, z], r: 0.03, mat: 'wood_dark' },
    { type: 'lantern', x: -55.3, y: FIRE + 2.85, z, r: 0.2, cord: 0.2, color: '#ffb35c' }
  ]),
  // 마른 나무
  ...deadTree(-20.8, BED, 22.9, 3.6, 0.3),
  ...deadTree(-41, 0, -13.4, 3.2, 1.7),
  ...deadTree(6.6, 0, -24, 3.8, 3.1),
  // 벼랑 위 첨탑
  pinnacle(-58, 22, 2.6), pinnacle(-44, 21, 1.8), pinnacle(-28, 23.5, 3), pinnacle(-9, 20.5, 2.2),
  pinnacle(6, 24, 3.4), pinnacle(20, 20, 1.6), pinnacle(35, 22.5, 2.8), pinnacle(58, 21, 2),
  // 먼 메사: 동쪽 것을 돌리면 서쪽이 된다. 레인 끝 벼랑 위로 머리가 보인다
  ...mesa(330, -60, 70, 96), ...mesa(420, 110, 90, 130), ...mesa(260, 170, 60, 78), ...mesa(300, -210, 80, 92), ...mesa(90, -260, 70, 74), ...mesa(-60, -340, 90, 88)
];

const bannerBlue = [
  { type: 'banner', x: -44.5, y: 3.05, z: -14.6, rotY: SHOW_EAST, w: 2.2, h: 4.2, text: '블루', bg: '#22407a', fg: '#e6efff', emblem: 'ring' },
  { type: 'banner', x: -44.3, y: 3.2, z: 17.5, rotY: SHOW_EAST, w: 2.2, h: 4.2, text: '블루', bg: '#22407a', fg: '#e6efff', emblem: 'ring' },
  { type: 'banner', x: -53.8, y: FIRE + 2, z: -3, rotY: SHOW_EAST, w: 1.2, h: 1.9, emblem: 'ring', bg: '#22407a', fg: '#e6efff' },
  { type: 'banner', x: -50, y: FIRE + 4.9, z: 0.9, rotY: SHOW_EAST, w: 1.5, h: 2.8, emblem: 'ring', bg: '#22407a', fg: '#e6efff' },
  // 안뜰 안쪽: 스폰에서 팀 색이 보인다
  { type: 'banner', x: -54.78, y: FIRE + 2.2, z: 0, rotY: SHOW_WEST, w: 1.5, h: 2.2, emblem: 'ring', bg: '#22407a', fg: '#e6efff' }
];
const bannerOrange = rotate180(bannerBlue).map((b) => ({ ...b, text: b.text ? '레드' : b.text, bg: '#b8323b', fg: '#ffeaea', emblem: 'diamond' }));

const decorCenter = [
  { type: 'sign', x: 0, y: DECK + 2.05, z: 2.15, rotY: SHOW_SOUTH, w: 3.4, h: 0.6, text: '독수리 관측소', bg: '#1f2d3a', fg: '#ffe2b0' },
  { type: 'sign', x: 0, y: DECK + 2.05, z: -2.15, rotY: SHOW_NORTH, w: 3.4, h: 0.6, text: '독수리 관측소', bg: '#1f2d3a', fg: '#ffe2b0' }
];

/* ---------------- 발판·포털 ---------------- */

const padsHalf = [
  { x: -43.5, y: BED, z: 17.8, w: 2.6, d: 2.6, target: [-29.6, NEST, 11.5], apex: 3 },
  { x: -50.5, y: FIRE, z: 15, w: 2.6, d: 2.6, target: [-29.6, NEST, 11.5], apex: 3 },
  { x: 0, y: DECK, z: -4.6, w: 2.4, d: 2.4, target: [-17, RIDGE, -20.5], apex: 1, color: '#ffd166' }
];

const portalsHalf = [
  { x: -14.6, y: 0, z: -6.25, w: 0.7, h: 2.5, d: 1.5, to: { x: 0, y: DECK, z: -0.8, rotY: FACE_EAST }, color: '#ffd166' }
];

const propsHalf = [
  { type: 'barrel', x: -50.5, y: FIRE, z: -10 },
  { type: 'crate', x: -49, y: FIRE, z: -9.2 },
  { type: 'barrel', x: -51.5, y: FIRE, z: 12 }
];

export default {
  id: 'longshot',
  name: '협곡 저격장',
  nameEn: 'Long Canyon',
  desc: '해 질 녘 금빛 협곡의 저격 전용 맵. 양끝 고지대 진지 사이로 100 m 시야선이 뻗고, 능선길과 마른 강바닥, 중앙 갱도가 갈린다. 독수리 관측소를 찾아보자.',
  size: { x: 130, z: 60 },
  rulesets: ['sniper'],
  tag: '스나 전용',
  theme: {
    sky: '#f7c78e', skyTop: '#6d84aa', fog: [300, 1100],
    sunDir: [0.06, 0.6, 0.8], sunColor: '#ffd29a', sunIntensity: 1.15, ambient: 0.7, ground: 'sand'
  },
  spawns: {
    owner,
    charterer: rotate180(owner),
    ffa: [...ffaHalf, ...rotate180(ffaHalf)]
  },
  solids: [...half, ...rotate180(half), ...center],
  decor: [...decorHalf, ...rotate180(decorHalf), ...bannerBlue, ...bannerOrange, ...decorCenter],
  pads: [...padsHalf, ...rotate180(padsHalf)],
  portals: [...portalsHalf, ...rotate180(portalsHalf)],
  secrets: [{ id: 'longshot_eyrie', name: '독수리 관측소', x: 0, y: EYRIE, z: 0, w: 7.2, h: 3, d: 14, points: 150 }],
  props: [...propsHalf, ...rotate180(propsHalf)]
};
