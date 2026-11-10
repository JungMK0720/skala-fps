/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 근접전 훈련장(CQB Yard). 합판 벽과 모래주머니로 세운 30×20 m 야외 훈련장으로, 사로 둘과 표적동 지붕 통로, 레일 위를 오가는 이동 표적대가 있는 좁은 맵이다.
 */
import { TEAMS } from '../core/consts.js';
import { box, ramp, cyl, wall, pillar, doorwayWall, rotate180 } from './kit.js';

// 방위: 북 = -z, 남 = +z. 블루 = -x, 레드 = +x. 서쪽 절반만 적고 rotate180으로 동쪽을 만들어 양 팀이 공정하다. 아래 그림은 서쪽 절반이다.
//
//        x -15    -11.5    -9.1   -7  -6            -3.5         -1   0
//  z -10  ┌──────────────────────── 바깥 벽(높이 5) ────────────────────────
//         │        ║ 출구 통로 → 주머니 ┃ 타이어   날개벽         1번 사로 바깥 띠
//  z -7.3 │        ╠═ 통로 벽 ═╗   ↓   ┃
//         │ 블루   ║                  ┃ ─ ─ ─ 이동 표적대 레일 (z -5.75, x ±5.5) ─ ─ ─
//  z -4.5 │ 대기실 ║  북쪽 앞마당    가림벽 끝   모래주머니   낮은 합판      안쪽 띠
//  z -2   │        ║        ┏━━ 칸막이 ━━┳━━━━━━━[ 창 ]━━━━━━━┳ 가운데
//  z  0   │        ║ 샛길   ▶ 도약대 발판 ┃ 표적실 · 위는 지붕 통로 ┃ 통로 · 위는 구름다리
//  z  2   │        ║        ┗━━ 칸막이 ━━┻━━━━━━━[ 창 ]━━━━━━━┻
//  z  4.5 │        ║  남쪽 앞마당    가림벽 끝   모래주머니     통제탑 ▣    안쪽 띠
//         │        ║                  ┃ ─ ─ ─ 이동 표적대 레일 (z 5.75) ─ ─ ─
//  z  7.3 │        ╠═ 통로 벽 ═╝   ↑   ┃
//         │        ║ 출구 통로 → 주머니 ┃ 타이어   낮은 모래주머니   2번 사로 바깥 띠
//  z  10  └─────────────────────────────────────────────────────────────────
//
//  동선: 대기실 → 출구 통로 → 주머니에서 꺾어 앞마당 → 가림벽 끝을 돌아 사로 안쪽 띠. 약 3초 뒤 사로 가운데에서 맞붙는다.
//  사로는 표적동(가운데 건물) 양옆에 하나씩 있고, 가운데 통로와 마주 뚫린 창 두 쌍으로 서로 쏜다.
//  이동 표적대는 사로 가운데 줄을 12초에 한 번 왕복하는 강철 판이다. 지나가면서 시야를 끊고, 길에 선 사람을 밀고 간다.
//  지붕 통로는 팀마다 하나뿐인 도약대 발판으로 오른다. 두 사로가 다 보이지만 양쪽 주머니에서 훤히 보인다. 난간을 넘어 어디로든 뛰어내린다.
//  통제탑은 사로마다 하나씩 있고 지붕에서 난간을 넘어 건너간다. 1번 사로 쪽 꼭대기가 비밀 스팟이다(돌리지 않아 보상은 한 번).
//  전체 높이 합판 벽은 위를 clip으로 덮어 발판이나 지붕에서 뛰어도 올라서지 못한다.

/* ---------------- 치수 ---------------- */

const YARD_X = 14.5;     // 바깥 벽 안쪽 면
const YARD_Z = 9.5;
const WALL_H = 5;        // 바깥 벽 높이
const ROOM_H = 4.5;      // 대기실 벽 높이. 지붕 난간 위에서 뛰어도 대기실 안이 넘겨다보이지 않는다
const PLINTH = 1;        // 방호벽 밑단 돌 띠. 벽과 같은 평면이라 턱이 생기지 않는다
const COPING = 0.12;     // 방호벽 갓돌 두께
const LID_TOP = 12;      // 막이 윗면. 발판 비행 때 머리가 닿는 높이(7.8)보다 높다
const SHED_H = 2.8;      // 표적동 벽 높이
const ROOF = 3;          // 지붕 통로 바닥
const RAIL_TOP = ROOF + 0.6;   // 난간 윗면
const DOOR_TOP = 3.2;    // 가운데 통로 윗변(구름다리 밑면). 뛰어도 머리가 닿지 않는다
const BRIDGE = 3.4;      // 구름다리 바닥
const SCREEN_H = WALL_H; // 출구 가림벽 높이. 통제탑 위에서 뛰어도 출구가 넘겨다보이지 않는다
const SCREEN_W = -7.1;   // 가림벽 서쪽 면(주머니 쪽)
const SCREEN_E = -6.75;  // 가림벽 동쪽 면(사로 쪽). 이동 표적대가 멈추는 자리에서 1.55 m 떨어져 있다
const PLY_H = 2.4;       // 사로 합판 벽 높이
const LOW = 1.1;         // 앉아서 숨는 엄폐물 높이
const TOWER_TOP = 3.9;   // 사로 통제탑 윗면. 이동 표적대 위에서 뛰어서는 닿지 않는다
const TRACK_Z = 5.75;    // 사로 가운데 줄(이동 표적대 레일)
const SLED_FROM = -4;    // 이동 표적대가 쉬는 자리(판 가운데)
const SLED_RUN = 8;      // 이동 표적대가 가는 거리
const SLED_W = 2.4;      // 이동 표적대 폭
const SLED_H = 2.1;      // 이동 표적대 높이. 선 사람을 다 가리고, 그 위에서 뛰어도 지붕 난간(3.6)에 3.5 cm 모자란다

const PLY_T = 0.2;       // 합판 벽 두께

const FACE = { '+x': Math.PI / 2, '-x': -Math.PI / 2, '+z': 0, '-z': Math.PI };
const out = (dir) => (dir[0] === '+' ? 1 : -1);

/* ---------------- 도형 도우미 ---------------- */

const rect = (x0, z0, x1, z1, y0, y1, mat) => box((x0 + x1) / 2, y0, (z0 + z1) / 2, x1 - x0, y1 - y0, z1 - z0, mat);
const lid = (x0, z0, x1, z1, y0) => rect(x0, z0, x1, z1, y0, LID_TOP, 'clip');

/** 높은 방호벽: 돌 밑단, 회벽, 갓돌, 그 위 막이. over = 갓돌이 [서, 북, 동, 남]으로 내민 길이 */
function blastWall(x0, z0, x1, z1, top, over = [0, 0, 0, 0]) {
  const cap = [x0 - over[0], z0 - over[1], x1 + over[2], z1 + over[3]];
  return [
    rect(x0, z0, x1, z1, 0, PLINTH, 'stone'),
    rect(x0, z0, x1, z1, PLINTH, top, 'plaster'),
    rect(...cap, top, top + COPING, 'concrete'),
    lid(...cap, top + COPING)
  ];
}

/**
 * 전체 높이 합판 벽: 판, 끝 기둥, 위를 덮는 막이. (x0,z0)→(x1,z1)이 중심선이고 기둥까지 넣은 길이다.
 * 기둥은 판과 같은 두께라 벽면에 턱이 없고, 막이도 벽과 같은 폭이라 벽에 붙어 뛰어도 머리가 걸리지 않는다.
 * @param {string} ends 기둥을 세울 끝. 'a' = (x0,z0), 'b' = (x1,z1). 다른 벽에 붙은 끝에는 세우지 않는다
 */
function ply(x0, z0, x1, z1, h, ends = 'ab') {
  const alongX = z0 === z1, t = PLY_T / 2;
  const dir = Math.sign(alongX ? x1 - x0 : z1 - z0);
  const a = ends.includes('a') ? PLY_T : 0, b = ends.includes('b') ? PLY_T : 0;
  const post = (x, z) => pillar(x, z, h + 0.1, PLY_T, 'wood_dark');
  if (alongX) {
    return [
      wall(x0 + dir * a, z0, x1 - dir * b, z0, h, PLY_T, 'wood'),
      ...(a ? [post(x0 + dir * t, z0)] : []),
      ...(b ? [post(x1 - dir * t, z0)] : []),
      lid(Math.min(x0, x1), z0 - t, Math.max(x0, x1), z0 + t, h)
    ];
  }
  return [
    wall(x0, z0 + dir * a, x0, z1 - dir * b, h, PLY_T, 'wood'),
    ...(a ? [post(x0, z0 + dir * t)] : []),
    ...(b ? [post(x0, z1 - dir * t)] : []),
    lid(x0 - t, Math.min(z0, z1), x0 + t, Math.max(z0, z1), h)
  ];
}

/** 낮은 합판 벽: 앉으면 가려지고 뛰어넘을 수 있다 */
const lowPly = (x0, z0, x1, z1) => [
  wall(x0, z0, x1, z1, LOW, PLY_T, 'wood'),
  pillar(x0, z0, LOW + 0.08, PLY_T + 0.02, 'wood_dark'),
  pillar(x1, z1, LOW + 0.08, PLY_T + 0.02, 'wood_dark')
];

/**
 * 모래주머니 더미: 아랫단과 조금 좁은 윗단.
 * 아랫단 턱은 0.9 m다. 0.86 m보다 낮으면 그 턱에 앉은 사람의 머리가 창 윗변(2.1) 밑으로 들어가 창틀에 걸려 떨린다
 */
const bags = (x0, z0, x1, z1, top = LOW) => [
  rect(x0, z0, x1, z1, 0, top - 0.2, 'sand'),
  rect(x0 + 0.07, z0 + 0.07, x1 - 0.07, z1 - 0.07, top - 0.2, top, 'sand')
];

/** 타이어 더미 */
const tires = (x, z, n = 4) => cyl(x, 0, z, 0.4, 0.24 * n, 'metal_dark');

/* ---------------- 절반: 바깥 벽과 대기실 ---------------- */

const yard = [
  // 북쪽 벽은 맵 폭 전체다(돌리면 남쪽 벽). 서쪽 벽은 그 사이를 잇는다(돌리면 동쪽 벽)
  blastWall(-15, -10, 15, -YARD_Z, WALL_H, [0, 0, 0, 0.06]),
  blastWall(-15, -YARD_Z, -YARD_X, YARD_Z, WALL_H, [0, -0.06, 0.06, -0.06]),
  // 대기실 벽. 남북 끝이 출구다(폭 2.1 m)
  blastWall(-11.7, -7.4, -11.3, 7.4, ROOM_H, [0.06, 0.06, 0.06, 0.06]),
  // 대기실 안: 총기 거치대와 긴 의자
  rect(-YARD_X, -0.9, -14.12, 0.9, 0, 1.9, 'metal_dark'),
  rect(-YARD_X, 3.2, -14.05, 5.2, 0, 0.45, 'wood_dark'),
  rect(-YARD_X, -5.2, -14.05, -3.2, 0, 0.45, 'wood_dark')
].flat();

/* ---------------- 절반: 출구 가림벽과 도약대 ---------------- */

const forecourt = [
  // 출구 통로 벽: 대기실 벽에서 동쪽으로 뻗어 통로를 만든다. 발판으로 날아오른 사람에게도 출구가 보이지 않는 높이다
  blastWall(-11.3, -7.4, -9.1, -7.1, ROOM_H, [0, 0.06, 0.06, 0.06]),
  blastWall(-11.3, 7.1, -9.1, 7.4, ROOM_H, [0, 0.06, 0.06, 0.06]),
  // 가림벽: 통로 끝 주머니를 사로에서 가린다. 가림벽 동쪽 어디에서도 출구로 가는 직선이 없다
  blastWall(SCREEN_W, -YARD_Z, SCREEN_E, -4.5, SCREEN_H, [0.06, 0, 0.06, 0.06]),
  blastWall(SCREEN_W, 4.5, SCREEN_E, YARD_Z, SCREEN_H, [0.06, 0.06, 0.06, 0]),
  // 도약대 칸막이: 발판을 지나가는 길에서 떼어 놓고, 앞마당 남북을 가로지르는 시야를 끊는다
  ply(-9.1, -1.5, -6, -1.5, SHED_H, 'a'),
  ply(-9.1, 1.5, -6, 1.5, SHED_H, 'a'),
  // 앞마당 구석 타이어
  tires(-10.75, 6.6), tires(-9.9, 6.62, 3)
].flat();

/* ---------------- 절반: 표적동 서쪽 칸과 지붕 통로 ---------------- */

const WINDOW = { at: -3.5, w: 2, top: 2.1, sill: 1.1 };

const shed = [
  // 긴 벽: 마주 뚫린 창(문턱 1.1, 윗변 2.1). 사람은 못 지나가고 총알만 사로에서 사로로 간다
  doorwayWall(-6, -1.85, -1, -1.85, SHED_H, 0.3, 'wood', WINDOW),
  doorwayWall(-6, 1.85, -1, 1.85, SHED_H, 0.3, 'wood', WINDOW),
  // 마구리 벽: 서쪽 끝과 가운데 통로 쪽
  rect(-6, -1.7, -5.7, 1.7, 0, SHED_H, 'wood'),
  rect(-1.3, -1.7, -1, 1.7, 0, SHED_H, 'wood'),
  // 귀 기둥: 난간 위까지 올라간다
  pillar(-5.85, -1.85, RAIL_TOP + 0.05, 0.34, 'wood_dark'),
  pillar(-5.85, 1.85, RAIL_TOP + 0.05, 0.34, 'wood_dark'),
  pillar(-1.15, -1.85, RAIL_TOP + 0.05, 0.34, 'wood_dark'),
  pillar(-1.15, 1.85, RAIL_TOP + 0.05, 0.34, 'wood_dark'),
  // 지붕 통로 바닥(폭 3.6 m)
  rect(-6, -2, -1, 2, SHED_H, ROOF, 'steel'),
  // 난간(0.6): 긴 변과 서쪽 끝을 끊김 없이 두른다. 빈 칸이 있으면 이동 표적대 위에서 지붕으로 뛰어오를 수 있다.
  // 서쪽 끝을 막은 것은 그리로 내려서면 도약대 발판을 다시 밟기 때문이다
  rect(-6, -2, -1, -1.8, ROOF, RAIL_TOP, 'wood_dark'),
  rect(-6, 1.8, -1, 2, ROOF, RAIL_TOP, 'wood_dark'),
  rect(-6, -1.8, -5.8, 1.8, ROOF, RAIL_TOP, 'wood_dark'),
  // 구름다리로 오르는 비탈과 구름다리 북쪽 옆판(돌리면 남쪽 옆판). 옆판은 다리 바닥보다 0.2 m만 높아 걸어서 내려선다
  ramp(-1.5, ROOF, 0, 1, BRIDGE - ROOF, 3.6, '+x', 'steel'),
  rect(-1, -2, 1, -1.8, DOOR_TOP, RAIL_TOP, 'wood_dark')
].flat();

/* ---------------- 절반: 사로 엄폐물 ---------------- */

// 이동 표적대가 지나가는 띠(가운데 줄 ±0.25, x ±6.7)에는 레일만 둔다.
// 띠 바깥쪽(바깥 벽 쪽) 1.9 m는 길 전체에서 비워 두어 언제든 옆으로 비켜 간다.
const lanes = [
  // 1번 사로 서쪽: 바깥 벽에서 내민 날개벽, 창 옆 모래주머니, 창 앞 낮은 합판, 과녁 밑 모래주머니(가운데라서 돌리면 2번 사로 것이 된다)
  ply(-3.2, -YARD_Z, -3.2, -7.9, PLY_H, 'b'),
  bags(-5.1, -3.5, -4.5, -2),
  lowPly(-3.6, -4.5, -1.6, -4.5),
  bags(-0.7, -YARD_Z, 0.7, -8.9),
  tires(-6.15, -8.95), tires(-5.3, -9.05, 3),
  // 2번 사로 서쪽: 통제탑과 이음벽(문 서쪽에서 안쪽 띠를 끊는다), 창 옆 모래주머니, 바깥 띠 모래주머니.
  // 이음벽 윗면은 통제탑과 같은 높이라 지붕에서 난간을 넘어 그 위로 건너간다
  rect(-1.85, 2, -1.55, 3.4, 0, TOWER_TOP, 'wood'),
  rect(-2.3, 3.4, -1.1, 4.6, 0, TOWER_TOP - 0.15, 'wood'),
  rect(-2.4, 3.4, -1, 4.7, TOWER_TOP - 0.15, TOWER_TOP, 'steel'),
  bags(-5.1, 2, -4.5, 3.5),
  bags(-3.9, 8, -3.3, YARD_Z),
  tires(-2.7, 9), tires(-6.2, 9, 3),
  // 이동 표적대 레일(높이 3 cm)과 띠 양옆 노란 안전선(1 cm). 맵을 가로지르므로 한 번만 적는다(돌리면 2번 사로 것이 된다)
  rect(-5.5, -TRACK_Z - 0.21, 5.5, -TRACK_Z - 0.13, 0, 0.03, 'rust'),
  rect(-5.5, -TRACK_Z + 0.13, 5.5, -TRACK_Z + 0.21, 0, 0.03, 'rust'),
  rect(-5.5, -TRACK_Z - 0.4, 5.5, -TRACK_Z - 0.32, 0, 0.01, 'yellow'),
  rect(-5.5, -TRACK_Z + 0.32, 5.5, -TRACK_Z + 0.4, 0, 0.01, 'yellow')
].flat();

const half = [...yard, ...forecourt, ...shed, ...lanes];

/* ---------------- 가운데: 구름다리 (돌리지 않는다) ---------------- */

const center = [
  box(0, DOOR_TOP, 0, 2, BRIDGE - DOOR_TOP, 3.6, 'steel')
];

/* ---------------- 맵 밖 경치: 북쪽 벽 너머 관측탑 ---------------- */

const scenery = [
  ...[[6.7, -11.6], [9.3, -11.6], [6.7, -14.2], [9.3, -14.2]].map(([x, z]) => pillar(x, z, 6.6, 0.3, 'wood_dark')),
  rect(6.2, -14.7, 9.8, -11.1, 6.6, 6.8, 'wood'),
  rect(6.6, -14.3, 9.4, -11.5, 6.8, 7.9, 'wood'),
  ...[[6.7, -11.6], [9.3, -11.6], [6.7, -14.2], [9.3, -14.2]].map(([x, z]) => pillar(x, z, 2.2, 0.16, 'wood_dark', 6.8)),
  rect(6.1, -14.8, 9.9, -11, 9, 9.18, 'rust')
];

/* ---------------- 장식 도우미 ---------------- */

/** 벽면(dir 쪽을 보는 면, 좌표 fixed) 앞 off만큼 떨어진 자리와 그 벽이 보는 방향. c = 벽 방향 좌표 */
const on = (dir, fixed, c, y, off = 0.05) => (dir[1] === 'x'
  ? { x: fixed + out(dir) * off, y, z: c, rotY: FACE[dir] }
  : { x: c, y, z: fixed + out(dir) * off, rotY: FACE[dir] });

const sign = (dir, fixed, c, y, w, h, text, bg = '#27333d', fg = '#f1e9d0') => ({ type: 'sign', ...on(dir, fixed, c, y), w, h, text, bg, fg });
const notice = (dir, fixed, c, y, w, h, text, bg = '#e2b21a', fg = '#1d1d1b') => ({ type: 'banner', ...on(dir, fixed, c, y, 0.1), w, h, text, bg, fg });

/** 종이 표적: 둥근 과녁을 찍은 천 */
const target = (dir, fixed, c, y = 1.45) => ({ type: 'banner', ...on(dir, fixed, c, y, 0.1), w: 0.7, h: 0.9, emblem: 'ring', bg: '#ece5cf', fg: '#22262b' });

/** 깃대와 사격 중을 알리는 붉은 깃발. 깃발은 깃대에서 rotY의 오른쪽으로 날린다 */
function flag(x, y, z, rotY = 0, h = 2.4) {
  const w = 1.05, reach = w / 2 + 0.06;
  return [
    { type: 'pipe', from: [x, y, z], to: [x, y + h, z], r: 0.04, mat: 'steel' },
    { type: 'banner', x: x + Math.cos(rotY) * reach, y: y + h - 0.42, z: z - Math.sin(rotY) * reach, rotY, w, h: 0.66, emblem: 'diamond', bg: '#c4362f', fg: '#f3e6c2' }
  ];
}

/* ---------------- 절반: 장식 ---------------- */

const decorHalf = [
  // 이동 표적대 경고: 레일 끝이 닿는 가림벽에 건다
  notice('+x', SCREEN_E, -TRACK_Z, 1.9, 1.7, 0.46, '이동 표적 주의'),
  notice('+x', SCREEN_E, TRACK_Z, 1.9, 1.7, 0.46, '이동 표적 주의'),
  // 표적실 창 위
  notice('-z', -2, -3.5, 2.46, 1.8, 0.42, '표적실 · 출입 금지', '#ece5cf', '#8f241f'),
  notice('+z', 2, -3.5, 2.46, 1.8, 0.42, '표적실 · 출입 금지', '#ece5cf', '#8f241f'),
  // 도약대 안쪽 벽
  sign('-x', -6, 0, 2.05, 2, 0.5, '지붕 통로 ▲', '#e2b21a', '#1d1d1b'),
  // 종이 표적: 날개벽, 가림벽, 바깥 벽, 대기실 벽 바깥쪽, 표적실 안, 가운데 통로, 통제탑과 이음벽
  target('-x', -3.3, -8.8), target('+x', -3.1, -8.8),
  target('+x', SCREEN_E, -7.6, 1.6), target('+x', SCREEN_E, 7.6, 1.6),
  target('+z', -YARD_Z, -1.6, 1.7), target('-z', YARD_Z, -5.2, 1.6),
  target('+x', -11.3, -4.4, 1.6), target('+x', -11.3, 4.4, 1.6),
  target('+x', -5.7, 0.7), target('-x', -1.3, -0.7), target('+x', -1, 0.5, 1.5),
  target('+z', 4.6, -1.7, 1.7), target('-x', -1.85, 2.7, 1.6),
  // 깃발: 바깥 벽 귀퉁이와 통제탑 꼭대기
  flag(-14.75, WALL_H + COPING, -9.75, 0),
  flag(-14.75, WALL_H + COPING, 9.75, 0),
  flag(-2.25, TOWER_TOP, 4.55, 0, 1.9),
  // 대기실 구석 상자 더미
  { type: 'crateStack', x: -14.05, z: 9.05, rotY: 0.2, size: 0.7, levels: 1 }
].flat();

/** 절반마다 글자가 다른 표지. 동쪽은 돌려서 쓴다. near = 그 절반의 북쪽 자리에 오는 사로, far = 남쪽 자리에 오는 사로 */
const labelled = ({ near, far }) => [
  // 대기실 안에서 두 출구를 가리킨다
  sign('-x', -11.7, -6.3, 2.4, 1.9, 0.5, `← ${near}`),
  sign('-x', -11.7, 6.3, 2.4, 1.9, 0.5, `${far} →`),
  // 주머니에서 사로 입구 쪽을 가리킨다
  sign('-x', SCREEN_W, -8.45, 2.3, 1.9, 0.5, `${near} →`),
  sign('-x', SCREEN_W, 8.45, 2.3, 1.9, 0.5, `← ${far}`),
  // 바깥 벽에 크게 적은 사로 이름
  sign('+z', -YARD_Z, -4.9, 3.5, 2.6, 0.8, near),
  sign('-z', YARD_Z, -1.4, 3.5, 2.6, 0.8, far),
  // 통제탑
  sign('+z', 4.6, -1.7, 3.1, 1.1, 0.34, `${far} 통제탑`)
];

/** 팀 색 깃발. 대기실 안에서 바로 보이는 벽에 건다 */
const teamDecor = (team) => [-3.7, 3.7].map((z) => (
  { type: 'banner', x: -11.84, y: 2.85, z, rotY: FACE['-x'], w: 1.5, h: 2.7, text: team.name, emblem: 'ring', bg: team.color, fg: '#f4f1e8' }
));

const decorCenter = [
  // 가운데 통로 위 구름다리 옆판
  sign('-z', -2, 0, BRIDGE, 1.7, 0.32, '가운데 통로'),
  sign('+z', 2, 0, BRIDGE, 1.7, 0.32, '가운데 통로'),
  // 관측탑: 버팀대, 사다리, 깃발, 이름판
  { type: 'pipe', from: [6.7, 0.3, -11.6], to: [9.3, 6.4, -11.6], r: 0.05, mat: 'wood_dark' },
  { type: 'pipe', from: [9.3, 0.3, -11.6], to: [6.7, 6.4, -11.6], r: 0.05, mat: 'wood_dark' },
  { type: 'pipe', from: [6.7, 0.3, -14.2], to: [6.7, 6.4, -11.6], r: 0.05, mat: 'wood_dark' },
  { type: 'pipe', from: [9.3, 0.3, -14.2], to: [9.3, 6.4, -11.6], r: 0.05, mat: 'wood_dark' },
  { type: 'pipe', from: [7.7, 0, -11.25], to: [7.7, 6.8, -11.25], r: 0.035, mat: 'steel' },
  { type: 'pipe', from: [8.3, 0, -11.25], to: [8.3, 6.8, -11.25], r: 0.035, mat: 'steel' },
  ...flag(9.6, 9.18, -11.3, 0, 2.2),
  sign('+z', -11.5, 8, 7.35, 2.2, 0.6, '관측탑', '#27333d', '#f1e9d0')
];

/* ---------------- 스폰 ---------------- */

/** 카메라가 (x,z)에서 (tx,tz)를 보는 rotY */
const look = (x, z, tx, tz) => Math.atan2(-(tx - x), -(tz - z));
const spot = (x, z, tx, tz) => ({ x, z, rotY: look(x, z, tx, tz) });

// 대기실 가운데 줄. 가까운 출구를 보고 선다
const blue = [-5.6, -2.8, 0, 2.8, 5.6].map((z) => spot(-13.1, z, -11.5, z > 0 ? 8.45 : -8.45));

const ffaHalf = [
  spot(-4.5, -8.3, 0, -7),                                 // 1번 사로 서쪽 날개벽 뒤
  spot(-5.3, 8.3, 0, 7),                                   // 2번 사로 서쪽 바깥 띠
  spot(0, -3.4, 0, -8),                                    // 가운데 통로 북쪽 문 앞
  spot(-8.6, -3.4, -6, -3.4)                               // 지붕 통로 서쪽 끝 아래 앞마당
];

/* ---------------- 발판, 움직이는 지형, 소품 ---------------- */

const padsHalf = [
  // 도약대 → 지붕 통로 서쪽 끝. 칸막이 사이 어디를 밟아도 난간 너머 같은 자리에 내린다
  { x: -7.9, y: 0, z: 0, w: 2, d: 2.2, target: [-4.3, ROOF, 0], apex: 3, color: '#ffd23e' }
];

// 이동 표적대: 1번 사로 가운데 줄을 서쪽 끝에서 동쪽 끝으로 8 m 갔다가 돌아온다(12초 주기, 양 끝에서 1.5초 쉼, 가장 빠를 때 2.7 m/s).
// 돌린 복사본은 2번 사로에서 같은 시각에 반대쪽으로 움직여 양 팀이 같은 박자를 본다.
const sledNorth = [
  { id: 'sled_n', x: SLED_FROM, y: 0, z: -TRACK_Z, w: SLED_W, h: SLED_H, d: 0.5, mat: 'steel', axis: 'x', dist: SLED_RUN, period: 12, hold: 1.5, phase: 0 }
];

const propsHalf = [
  { type: 'barrel', x: -13.9, y: 0, z: -8.9 },
  { type: 'crate', x: -10.7, y: 0, z: -6.5 },
  { type: 'crate', x: -2.5, y: 0, z: -8.95, size: 0.8 },
  { type: 'barrel', x: -8.7, y: 0, z: 2.3 }
];

export default {
  id: 'cqb',
  name: '근접전 훈련장',
  nameEn: 'CQB Yard',
  desc: '합판 벽과 모래주머니로 세운 야외 훈련장에서 사로 둘과 지붕 통로, 레일 위를 오가는 이동 표적대를 끼고 몇 초 만에 맞붙는다.',
  tag: '좁은 맵',
  size: { x: 30, z: 20 },
  rulesets: ['classic', 'knife'],
  theme: {
    sky: '#c6ccce', skyTop: '#8d98a1', fog: [30, 120], sunDir: [0.22, 0.93, 0.3],
    sunColor: '#f4f1e8', sunIntensity: 0.85, ambient: 0.72, ground: 'concrete'
  },
  spawns: {
    owner: blue,
    charterer: rotate180(blue),
    ffa: [...ffaHalf, ...rotate180(ffaHalf)]
  },
  solids: [...half, ...rotate180(half), ...center, ...scenery],
  decor: [
    ...decorCenter,
    ...decorHalf,
    ...rotate180(decorHalf),
    ...labelled({ near: '1번 사로', far: '2번 사로' }),
    ...rotate180(labelled({ near: '2번 사로', far: '1번 사로' })),
    ...teamDecor(TEAMS.owner),
    ...rotate180(teamDecor(TEAMS.charterer))
  ],
  pads: [...padsHalf, ...rotate180(padsHalf)],
  movers: [...sledNorth, ...rotate180(sledNorth)],
  portals: [],
  secrets: [{ id: 'cqb_lane_tower', name: '1번 사로 통제탑', x: 1.7, y: TOWER_TOP, z: -4, w: 1.4, h: 2.5, d: 1.4, points: 100, reach: 'jump' }],
  props: [...propsHalf, ...rotate180(propsHalf)]
};
