/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 이모트 동작을 키프레임으로 정의하고 시간에 따른 포즈를 계산한다. three.js에 의존하지 않아 node에서 테스트할 수 있다.
 */
/**
 * SKALA 작전 — 이모트 애니메이션 (순수, three.js 의존 없음 → node에서 테스트 가능)
 *
 * 관절 리그(아바타 로컬, 발바닥 원점, 정면 -Z, 오른쪽 +X)
 *   hips(0.95) ─ torso ─ head(목 0.55)
 *              │       ├ 오른 어깨(+0.31, 0.5) ─ 팔꿈치(-0.30) ─ 손목(-0.26)
 *              │       └ 왼 어깨(-0.31, 0.5)  ─ …
 *              ├ 오른 엉덩이(+0.11, 0) ─ 무릎(-0.45) ─ 발바닥(-0.50)
 *              └ 왼 엉덩이(-0.11, 0)  ─ …
 *
 * 포즈(모두 라디안). 팔·다리는 좌우가 같은 의미(좌우 대칭 숫자 = 대칭 동작):
 *   arm  [앞으로 들기 +, 비틀기, 옆으로(바깥) 들기 +]   fore = 팔꿈치 굽힘(+ = 손이 앞·위로)   hand [x, y(비틀기), z]
 *   leg  [앞으로 차기 +, 비틀기, 옆으로(바깥) 벌리기 +]  knee = 무릎 굽힘(+ = 정강이가 뒤로)
 *   torso·head [rx, ry, rz] (three.js 회전 그대로: rx + = 뒤로 젖힘, ry + = 왼쪽으로 돌기, rz + = 왼쪽으로 기울기)
 *   x, z, rx, ry, rz = 엉덩이 위치·회전, air = 공중 높이(점프). 엉덩이 높이는 발이 바닥에 닿게 자동 계산(plant).
 *   shapeR/shapeL = 손 모양 'fist' | 'L' | 'flat'
 *
 * 동작은 모두 이 파일에서 직접 설계한 키프레임이다(상용 게임 애니메이션 복제 아님 — MODES.md 4.1 설명대로).
 * 손이 머리·이마에 닿는 자세는 키프레임에 손목 목표 위치(handTo)를 적고 작은 수치 IK로 관절각을 구한다(모듈 로드 시 1번).
 */
import { EMOTES, emoteById } from '../core/consts.js';

export const RIG = Object.freeze({
  hipY: 0.95, shoulderX: 0.31, shoulderY: 0.5, neckY: 0.55, hipX: 0.11,
  upperArm: 0.3, foreArm: 0.26, hand: 0.12, thigh: 0.45, shin: 0.38, foot: 0.12
});

function basePose() {
  return {
    x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, air: 0,
    torso: [0, 0, 0], head: [0, 0, 0],
    armR: [0.05, 0, 0.1], foreR: 0.2, handR: [0, 0, 0],
    armL: [0.05, 0, 0.1], foreL: 0.2, handL: [0, 0, 0],
    legR: [0, 0, 0], kneeR: 0, legL: [0, 0, 0], kneeL: 0,
    shapeR: 'fist', shapeL: 'fist'
  };
}
const ARR = ['torso', 'head', 'armR', 'handR', 'armL', 'handL', 'legR', 'legL'];
const NUM = ['x', 'y', 'z', 'rx', 'ry', 'rz', 'air', 'foreR', 'foreL', 'kneeR', 'kneeL'];

export function makePose(p = {}) {
  const o = basePose();
  for (const k of NUM) if (p[k] != null) o[k] = +p[k];
  for (const k of ARR) if (p[k]) o[k] = [p[k][0] || 0, p[k][1] || 0, p[k][2] || 0];
  if (p.shapeR) o.shapeR = p.shapeR;
  if (p.shapeL) o.shapeL = p.shapeL;
  return o;
}
function freezePose(p) { return Object.freeze(makePose(p)); }

/** 평소 아바타(총 든 자세)와 같은 팔 각도 — 이모트 시작·끝 0.15초 전환의 기준 */
export const NEUTRAL = freezePose({
  armR: [1.25, 0, -0.12], foreR: 0, armL: [1.15, 0, -0.55], foreL: 0
});
/** 차렷에 가까운 편한 선 자세 */
export const REST = freezePose({});

/** a→b 보간(t 0..1). 손 모양은 절반에서 바뀐다. out 재사용 가능 */
export function lerpPose(a, b, t, out = basePose()) {
  for (const k of NUM) out[k] = a[k] + (b[k] - a[k]) * t;
  for (const k of ARR) { const A = a[k], B = b[k], O = out[k]; O[0] = A[0] + (B[0] - A[0]) * t; O[1] = A[1] + (B[1] - A[1]) * t; O[2] = A[2] + (B[2] - A[2]) * t; }
  out.shapeR = t < 0.5 ? a.shapeR : b.shapeR;
  out.shapeL = t < 0.5 ? a.shapeL : b.shapeL;
  return out;
}

/* ---------------- 3×3 회전(three.js Euler 'XYZ' = Rx·Ry·Rz) ---------------- */

function rot(x, y, z) {
  const a = Math.cos(x), b = Math.sin(x), c = Math.cos(y), d = Math.sin(y), e = Math.cos(z), f = Math.sin(z);
  // three.js Matrix4.makeRotationFromEuler, order XYZ
  const ae = a * e, af = a * f, be = b * e, bf = b * f;
  return [
    c * e, -c * f, d,
    af + be * d, ae - bf * d, -b * c,
    bf - ae * d, be + af * d, a * c
  ];
}
function mul(A, B) {
  const o = new Array(9);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
  return o;
}
function app(M, v) { return [M[0] * v[0] + M[1] * v[1] + M[2] * v[2], M[3] * v[0] + M[4] * v[1] + M[5] * v[2], M[6] * v[0] + M[7] * v[1] + M[8] * v[2]]; }
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

/** 오른쪽(s=1)·왼쪽(s=-1) 관절 회전값 → three.js rotation (y·z는 좌우 반전) */
export function sideRot(v, s) { return [v[0], v[1] * s, v[2] * s]; }

/**
 * 순운동학: 포즈 → 주요 점(아바타 로컬, 엉덩이 높이 = 0.95 + y + air)
 * @returns {{ hips, head, shoulderR, elbowR, wristR, shoulderL, elbowL, wristL, kneeR, soleR, kneeL, soleL }}
 */
export function fk(p, withY = true) {
  const R = RIG;
  const hy = R.hipY + (withY ? p.y + p.air : 0);
  const hipsP = [p.x, hy, p.z];
  const Mh = rot(p.rx, p.ry, p.rz);
  const Mt = mul(Mh, rot(p.torso[0], p.torso[1], p.torso[2]));
  const out = { hips: hipsP };
  out.head = add(hipsP, app(Mt, [0, R.neckY + 0.12, 0]));
  for (const [s, k] of [[1, 'R'], [-1, 'L']]) {
    const sh = add(hipsP, app(Mt, [R.shoulderX * s, R.shoulderY, 0]));
    const a = sideRot(p['arm' + k], s);
    const Ma = mul(Mt, rot(a[0], a[1], a[2]));
    const el = add(sh, app(Ma, [0, -R.upperArm, 0]));
    const Mf = mul(Ma, rot(p['fore' + k], 0, 0));
    const wr = add(el, app(Mf, [0, -R.foreArm, 0]));
    const hd = sideRot(p['hand' + k], s);
    const Mw = mul(Mf, rot(hd[0], hd[1], hd[2]));
    out['shoulder' + k] = sh; out['elbow' + k] = el; out['wrist' + k] = wr;
    out['fingers' + k] = add(wr, app(Mw, [0, -R.hand, 0]));
    const hp = add(hipsP, app(Mh, [R.hipX * s, 0, 0]));
    const l = sideRot(p['leg' + k], s);
    const Ml = mul(Mh, rot(l[0], l[1], l[2]));
    const kn = add(hp, app(Ml, [0, -R.thigh, 0]));
    const Mk = mul(Ml, rot(-p['knee' + k], 0, 0));
    out['knee' + k] = kn;
    out['sole' + k] = add(kn, app(Mk, [0, -(R.shin + R.foot), 0]));
  }
  return out;
}

/** 발이 바닥에 닿도록 엉덩이 높이 보정값(y) 계산: 더 낮은 발바닥이 y=0 */
export function plantY(p) {
  const f = fk(p, false);
  return -Math.min(f.soleR[1], f.soleL[1]);
}

/* ---------------- 작은 IK: 손목을 목표 위치로 (어깨 3 + 팔꿈치 1 자유도, 패턴 탐색) ---------------- */

/**
 * @param {object} pose 기준 포즈(몸통 자세 포함). side 'R'|'L'
 * @param {number[]} target 손목 목표(아바타 로컬, 엉덩이 높이 0.95 + y 기준 — plant 전)
 * @param {number[]} pref 선호 관절각 [flex, twist, abduct, fore] (자연스러운 팔 모양으로 끌어당김)
 */
export function solveArm(pose, side, target, pref) {
  const p = makePose(pose);
  const k = side;
  const cost = (v) => {
    p['arm' + k] = [v[0], v[1], v[2]];
    p['fore' + k] = v[3];
    const w = fk(p, false)['wrist' + k];
    const dx = w[0] - target[0], dy = w[1] - target[1], dz = w[2] - target[2];
    let reg = 0;
    for (let i = 0; i < 4; i++) reg += (v[i] - pref[i]) * (v[i] - pref[i]);
    const elbowLimit = v[3] < 0 ? v[3] * v[3] * 50 : v[3] > 2.6 ? (v[3] - 2.6) ** 2 * 50 : 0; // 팔꿈치는 앞으로만
    return dx * dx + dy * dy + dz * dz + 0.0008 * reg + elbowLimit;
  };
  let v = pref.slice(), c = cost(v), step = 0.5;
  while (step > 1e-4) {
    let improved = false;
    for (let i = 0; i < 4; i++) {
      for (const dir of [1, -1]) {
        const n = v.slice(); n[i] += dir * step;
        const nc = cost(n);
        if (nc < c) { v = n; c = nc; improved = true; }
      }
    }
    if (!improved) step *= 0.5;
  }
  return { arm: [v[0], v[1], v[2]], fore: v[3], err: Math.sqrt(Math.max(0, c - 0)) };
}

/* ---------------- 키프레임 ---------------- */

const smooth = (t) => t * t * (3 - 2 * t);

/**
 * 키프레임 정의 → 실행용 트랙. keys: [{ t: 박자(beat), p: 포즈 일부, handTo?: { R: [x,y,z], L: [...] }, prefR?, prefL?, ease?: 'linear' }]
 * loopBeats: 반복 길이(박자). 한 번만 하는 동작은 seconds 기준(t: 초) + loop false.
 */
function track(def) {
  const keys = def.keys.map((k) => {
    const p = makePose(k.p || {});
    if (k.handTo) {
      for (const side of ['R', 'L']) {
        const tg = k.handTo[side];
        if (!tg) continue;
        const pref = k['pref' + side] || [p['arm' + side][0], p['arm' + side][1], p['arm' + side][2], p['fore' + side]];
        const r = solveArm(p, side, tg, pref);
        p['arm' + side] = r.arm; p['fore' + side] = r.fore;
      }
    }
    p.y = plantY(p);
    return { t: k.t, p, ease: k.ease || 'smooth' };
  });
  return Object.assign({}, def, { keys });
}

const pose = (o) => o;
// 자주 쓰는 다리 모양
const STAND = { legR: [0, 0, 0.02], legL: [0, 0, 0.02] };
const BOUNCE = { legR: [0.32, 0, 0.04], kneeR: 0.62, legL: [0.32, 0, 0.04], kneeL: 0.62, torso: [-0.06, 0, 0] };
/** 포즈 조각 합치기(뒤가 이김) */
const P = (...parts) => Object.assign({}, ...parts);
// 몸통을 돌린 키에서 손목 목표도 엉덩이를 축으로 같이 돌린다(IK 목표는 몸통 회전 전 좌표)
const turnY = (p, a) => [p[0] * Math.cos(a) + p[2] * Math.sin(a), p[1], -p[0] * Math.sin(a) + p[2] * Math.cos(a)];

// 1 작전 성공: 주먹 장전(어깨 앞) ↔ 하늘로 찌르기, 가슴 치기, 두 팔 굽혀 힘주기
const COCK_R = { armR: [0.35, 0, 0.55], foreR: 2.3, shapeR: 'fist', armL: [0.15, 0, 0.3], foreL: 1.1, shapeL: 'fist' };
const PUMP_R = { armR: [0.3, 0, 2.75], foreR: 0.05, shapeR: 'fist', armL: [0.1, 0, 0.35], foreL: 1.3, shapeL: 'fist' };
const FLEX = { armR: [1.57, 0, 1.55], foreR: 1.9, armL: [1.57, 0, 1.55], foreL: 1.9, shapeR: 'fist', shapeL: 'fist' };
// 2 무전 확인: 왼손은 귀(헤드셋)에 붙인 채
const EAR_L = [-0.18, 1.5, -0.04], EAR_PREF = [0.4, 0, 0.6, 2.4];
// 3 경계 이동: 낮은 자세, 보이지 않는 총을 겨눈 팔
const AIM = { armR: [1.2, 0, -0.15], foreR: 0.35, armL: [1.1, 0, -0.5], foreL: 0.25, shapeL: 'flat' };
const CROUCH = { legR: [0.45, 0, 0.05], kneeR: 0.85, legL: [0.45, 0, 0.05], kneeL: 0.85 };
// 4 몸풀기: 두 팔을 옆으로 올려 머리 위에서 깍지(관절각 직접 — 몸통을 기울이면 팔도 함께 기운다)
const UP_ARMS = { armR: [-0.03, 0, 3.64], foreR: 0.25, armL: [-0.03, 0, 3.64], foreL: 0.25, shapeR: 'flat', shapeL: 'flat' };
// 5 제자리 행진: 높이 든 무릎, 앞뒤로 크게 흔드는 팔
const KNEE_UP = [1.2, 0, 0.02], ARM_FWD = [0.6, 0, 0.06], ARM_BACK = [-0.45, 0, 0.06];
// 9 수신호: 오른 주먹을 어깨 높이 옆으로 들고 아래팔을 세운 '정지'
const FREEZE = { armR: [1.57, 0, 1.5], foreR: 1.57, shapeR: 'fist', armL: [0.08, 0, 0.12], foreL: 0.25 };
// 집결: 머리 위에서 손목이 반지름 13 cm 원을 그리는 네 점(오른쪽 → 앞 → 왼쪽 → 뒤)의 [앞으로 들기, 옆으로 들기, 팔꿈치]
const RALLY = [[0.38, 3.14, 1.11], [-0.03, 3.41, 0.73], [0.16, 3.66, 0.55], [0.61, 3.43, 0.97]];
// 10 쌍안경 정찰: 두 주먹을 눈앞에
const BINO_R = [0.07, 1.6, -0.25], BINO_L = [-0.07, 1.6, -0.25], BINO_PREF = [1.3, -0.3, -0.4, 2.0];
const SCOUT_LEGS = { legL: [0.12, 0, 0.06], kneeL: 0.1, legR: [-0.05, 0, 0.06], kneeR: 0.15 };
// 11 깃발 흔들기: 세운 깃대를 두 손으로 앞머리 위에서 쥔다(오른손 위). 흔들 때는 몸통째 기운다
const POLE = { armR: [2.41, 0, -0.43], foreR: 0.34, armL: [1.65, 0, -0.87], foreL: 0.78, shapeR: 'fist', shapeL: 'fist' };

/** 동작 정의 (박자 = 60/bpm 초). 모두 직접 설계한 오리지널 키프레임 */
const DEFS = {
  // 1. 작전 성공(4박): 무릎 반동과 함께 주먹을 하늘로 두 번(0.5·1.5박) → 오른 주먹으로 왼 가슴을 치고(2박) →
  //    다리를 벌리고 두 팔을 굽혀 힘을 준다(3박)
  takeL: {
    loop: true, beats: 4,
    keys: [
      { t: 0, p: pose(P(BOUNCE, COCK_R, { head: [0, 0, 0] })) },
      { t: 0.5, p: pose(P(PUMP_R, { air: 0.08, legR: [0.15, 0, 0.04], kneeR: 0.25, legL: [0.15, 0, 0.04], kneeL: 0.25, head: [0.25, 0, 0], torso: [0.08, 0, 0.04] })) },
      { t: 1, p: pose(P(BOUNCE, COCK_R, { head: [0, 0, 0] })) },
      { t: 1.5, p: pose(P(PUMP_R, { air: 0.08, legR: [0.15, 0, 0.04], kneeR: 0.25, legL: [0.15, 0, 0.04], kneeL: 0.25, head: [0.25, 0, 0], torso: [0.08, 0, 0.04] })) },
      { t: 2, p: pose({ legR: [0, 0, 0.08], legL: [0, 0, 0.08], armL: [0.1, 0, 0.2], foreL: 0.4, shapeR: 'fist', head: [-0.1, 0, 0], torso: [0.04, 0, 0] }),
        handTo: { R: [-0.06, 1.3, -0.2] }, prefR: [0.9, 0.3, -0.5, 2.0] },
      { t: 2.5, p: pose({ legR: [0, 0, 0.08], legL: [0, 0, 0.08], armL: [0.1, 0, 0.2], foreL: 0.4, shapeR: 'fist', head: [-0.04, 0, 0], torso: [0.02, 0, 0] }),
        handTo: { R: [0.02, 1.32, -0.34] }, prefR: [0.9, 0.3, -0.5, 2.0] },
      { t: 3, p: pose(P(FLEX, { legR: [0.05, 0, 0.2], kneeR: 0.35, legL: [0.05, 0, 0.2], kneeL: 0.35, torso: [0.1, 0, 0], head: [0.15, 0, 0] })) },
      { t: 3.7, p: pose(P(FLEX, { foreR: 2.0, foreL: 2.0, legR: [0.05, 0, 0.2], kneeR: 0.4, legL: [0.05, 0, 0.2], kneeL: 0.4, torso: [0.12, 0, 0], head: [0.18, 0, 0] })) }
    ]
  },
  // 2. 무전 확인(4박): 왼손을 귀에 대고 듣다가 박자마다 고개를 끄덕(0.5·1.5박) → 오른손을 펴서 앞을 가리키며 한 걸음(2박) →
  //    제자리로 돌아와 엄지를 들며 끄덕(3박). 왼손은 내내 귀에
  veggie: {
    loop: true, beats: 4,
    keys: [
      { t: 0, p: pose(P(STAND, { armR: [0.1, 0, 0.15], foreR: 0.35, shapeL: 'flat', head: [0.02, 0.05, 0.14], torso: [0, 0, 0.03] })),
        handTo: { L: EAR_L }, prefL: EAR_PREF },
      { t: 0.5, p: pose(P(STAND, { armR: [0.1, 0, 0.15], foreR: 0.35, shapeL: 'flat', head: [0.28, 0.05, 0.12], torso: [-0.04, 0, 0.03] })),
        handTo: { L: EAR_L }, prefL: EAR_PREF },
      { t: 1, p: pose(P(STAND, { armR: [0.1, 0, 0.15], foreR: 0.35, shapeL: 'flat', head: [0.02, 0.05, 0.14], torso: [0, 0, 0.03] })),
        handTo: { L: EAR_L }, prefL: EAR_PREF },
      { t: 1.5, p: pose(P(STAND, { armR: [0.1, 0, 0.15], foreR: 0.35, shapeL: 'flat', head: [0.28, 0.05, 0.12], torso: [-0.04, 0, 0.03] })),
        handTo: { L: EAR_L }, prefL: EAR_PREF },
      { t: 2, p: pose({ z: -0.06, legR: [0.35, 0, 0.03], kneeR: 0.15, legL: [-0.15, 0, 0.03], kneeL: 0.25, armR: [1.5, 0, 0.12], foreR: 0.05,
        shapeR: 'flat', shapeL: 'flat', torso: [-0.06, -0.15, 0], head: [0, -0.1, 0.05] }),
        handTo: { L: turnY(EAR_L, -0.15) }, prefL: EAR_PREF },
      { t: 2.6, p: pose({ z: -0.06, legR: [0.35, 0, 0.03], kneeR: 0.15, legL: [-0.15, 0, 0.03], kneeL: 0.25, armR: [1.52, 0, 0.1], foreR: 0.05,
        shapeR: 'flat', shapeL: 'flat', torso: [-0.07, -0.15, 0], head: [0, -0.12, 0.05] }),
        handTo: { L: turnY(EAR_L, -0.15) }, prefL: EAR_PREF },
      { t: 3, p: pose(P(STAND, { armR: [0.45, 0, 0.35], foreR: 2.0, shapeR: 'fist', shapeL: 'flat', head: [0.18, 0, 0.08] })),
        handTo: { L: EAR_L }, prefL: EAR_PREF },
      { t: 3.6, p: pose(P(STAND, { armR: [0.45, 0, 0.35], foreR: 2.05, shapeR: 'fist', shapeL: 'flat', head: [0.04, 0, 0.1] })),
        handTo: { L: EAR_L }, prefL: EAR_PREF }
    ]
  },
  // 3. 경계 이동(4박): 무릎을 굽힌 낮은 자세로 총을 겨눈 채 반 박자마다 오른쪽으로 게걸음 두 번 → 왼쪽으로 두 번.
  //    몸통(과 겨눈 팔)은 왼쪽 끝에서 왼쪽을, 오른쪽 끝에서 오른쪽을 살핀다
  sideToSide: {
    loop: true, beats: 4,
    keys: [
      [0, -0.16, 0.35, null], [0.5, -0.06, 0.18, 'R'], [1, 0.04, 0, null], [1.5, 0.12, -0.18, 'R'],
      [2, 0.18, -0.35, null], [2.5, 0.08, -0.18, 'L'], [3, -0.02, 0, null], [3.5, -0.1, 0.18, 'L']
    ].map(([t, x, ry, out]) => ({
      t, p: pose(P(CROUCH, AIM, out ? { ['leg' + out]: [0.4, 0, 0.3], ['knee' + out]: 0.7 } : null,
        { x, torso: [-0.12, ry, 0], head: [0.04, ry * 0.4, 0] }))
    }))
  },
  // 4. 몸풀기(8박): 머리 위로 깍지 → 왼쪽 옆구리 늘이기(1박) → 가운데 → 오른쪽(3박) → 가운데(4박) →
  //    팔을 내리고 반 박자마다 다리를 번갈아 들며 손목을 턴다(4.5~7박) → 다시 머리 위로
  crissCross: {
    loop: true, beats: 8,
    keys: [
      ...[[0, 0], [1, 0.32], [1.6, 0.34], [2, 0], [3, -0.32], [3.6, -0.34], [4, 0]].map(([t, a]) => ({
        t, p: pose(P(UP_ARMS, { legR: [0, 0, 0.12], legL: [0, 0, 0.12], torso: [0, 0, a], head: [a ? 0.05 : 0.1, 0, a * 0.3] }))
      })),
      ...[4.5, 5, 5.5, 6, 6.5, 7].map((t, i) => {
        const up = i % 2 ? 'L' : 'R', s = i % 2 ? -1 : 1;
        return { t, p: pose({ ['leg' + up]: [0.35, 0, 0.05], ['knee' + up]: 0.7, rz: 0.03 * s,
          armR: [0.05, 0, 0.3], foreR: 0.25, handR: [0, 0, 0.5 * s], armL: [0.05, 0, 0.3], foreL: 0.25, handL: [0, 0, -0.5 * s],
          shapeR: 'flat', shapeL: 'flat', head: [0, 0, -0.06 * s] }) };
      }),
      { t: 7.4, p: pose({ legR: [0, 0, 0.08], legL: [0, 0, 0.08], armR: [0.1, 0, 0.5], foreR: 0.4, armL: [0.1, 0, 0.5], foreL: 0.4, shapeR: 'flat', shapeL: 'flat' }) }
    ]
  },
  // 5. 제자리 행진(4박): 왼 무릎(0.5박)·오른 무릎(1.5박)·왼 무릎(2.5박)을 높이 들며 팔을 반대로 크게 흔든다 →
  //    3박에 발을 쿵 모으고 차렷으로 멈춘다
  tango: {
    loop: true, beats: 4,
    keys: [
      { t: 0, p: pose(P(STAND, { armR: [0.05, 0, 0.06], foreR: 0.2, armL: [0.05, 0, 0.06], foreL: 0.2, torso: [0.04, 0, 0], head: [0.04, 0, 0] })) },
      ...[[0.5, 'L'], [1.5, 'R'], [2.5, 'L']].map(([t, up]) => {
        const fwd = up === 'L' ? 'R' : 'L';
        return { t, p: pose({ ['leg' + up]: KNEE_UP, ['knee' + up]: 1.5, ['leg' + fwd]: [0, 0, 0.02],
          ['arm' + fwd]: ARM_FWD, ['fore' + fwd]: 0.35, ['arm' + up]: ARM_BACK, ['fore' + up]: 0.1, torso: [0.04, 0, 0], head: [0.04, 0, 0] }) };
      }),
      ...[1, 2].map((t) => ({ t, p: pose(P(STAND, { armR: [0.05, 0, 0.06], foreR: 0.2, armL: [0.05, 0, 0.06], foreL: 0.2, torso: [0.04, 0, 0], head: [0.04, 0, 0] })) })),
      { t: 3, p: pose({ legR: [0.12, 0, 0], kneeR: 0.25, legL: [0.12, 0, 0], kneeL: 0.25, armR: [0, 0, 0.04], foreR: 0.05, armL: [0, 0, 0.04], foreL: 0.05, head: [0, 0, 0] }) },
      { t: 3.3, ease: 'linear', p: pose({ legR: [0, 0, -0.01], legL: [0, 0, -0.01], armR: [0, 0, 0.04], foreR: 0.05, armL: [0, 0, 0.04], foreL: 0.05, torso: [0.05, 0, 0], head: [0.06, 0, 0] }) },
      { t: 3.8, p: pose({ legR: [0, 0, -0.01], legL: [0, 0, -0.01], armR: [0, 0, 0.04], foreR: 0.05, armL: [0, 0, 0.04], foreL: 0.05, torso: [0.05, 0, 0], head: [0.06, 0, 0] }) }
    ].sort((a, b) => a.t - b.t)
  },
  // 6. 경례: 차렷 → 오른손 경례 → 내림 (2.5초, 시간 단위: 초)
  salute: {
    loop: false, seconds: 2.5,
    keys: [
      { t: 0, p: pose({ armR: [0, 0, 0.04], foreR: 0.05, armL: [0, 0, 0.04], foreL: 0.05, legR: [0, 0, -0.01], legL: [0, 0, -0.01], torso: [0.04, 0, 0], head: [0.05, 0, 0] }) },
      { t: 0.35, p: pose({ armR: [0, 0, 0.04], foreR: 0.05, armL: [0, 0, 0.04], foreL: 0.05, legR: [0, 0, -0.01], legL: [0, 0, -0.01], torso: [0.06, 0, 0], head: [0.06, 0, 0] }) },
      { t: 0.75, p: pose({ armL: [0, 0, 0.04], foreL: 0.05, legR: [0, 0, -0.01], legL: [0, 0, -0.01], torso: [0.06, 0, 0], head: [0.06, 0, 0], shapeR: 'flat', handR: [0.2, -1.2, 0.3] }),
        handTo: { R: [0.2, 1.6, -0.17] }, prefR: [0.8, 0.2, 1.3, 2.2] },
      { t: 1.9, p: pose({ armL: [0, 0, 0.04], foreL: 0.05, legR: [0, 0, -0.01], legL: [0, 0, -0.01], torso: [0.06, 0, 0], head: [0.06, 0, 0], shapeR: 'flat', handR: [0.2, -1.2, 0.3] }),
        handTo: { R: [0.2, 1.6, -0.17] }, prefR: [0.8, 0.2, 1.3, 2.2] },
      { t: 2.25, p: pose({ armR: [0, 0, 0.04], foreR: 0.05, armL: [0, 0, 0.04], foreL: 0.05, legR: [0, 0, -0.01], legL: [0, 0, -0.01], torso: [0.04, 0, 0], head: [0.05, 0, 0] }) },
      { t: 2.5, p: pose({ armR: [0, 0, 0.04], foreR: 0.05, armL: [0, 0, 0.04], foreL: 0.05, legR: [0, 0, -0.01], legL: [0, 0, -0.01], torso: [0.04, 0, 0], head: [0.05, 0, 0] }) }
    ]
  },
  // 7. 손 흔들기: 오른팔을 높이 들어 크게 좌우로 (2.5초)
  wave: {
    loop: false, seconds: 2.5,
    keys: [
      { t: 0, p: pose({}) },
      { t: 0.3, p: pose({ armR: [0.2, 0, 2.35], foreR: 0.55, shapeR: 'flat', rz: 0.03, head: [0.05, 0.1, 0] }) },
      ...[0.55, 0.8, 1.05, 1.3, 1.55, 1.8].map((t, i) => ({ t, p: pose({ armR: [0.2, 0, i % 2 ? 2.45 : 2.05], foreR: i % 2 ? 0.25 : 0.85, handR: [0, 0, i % 2 ? -0.25 : 0.25], shapeR: 'flat', rz: i % 2 ? -0.03 : 0.04, torso: [0, 0, i % 2 ? -0.05 : 0.05], head: [0.05, 0.1, i % 2 ? -0.06 : 0.06] }) })),
      { t: 2.1, p: pose({ armR: [0.2, 0, 2.2], foreR: 0.5, shapeR: 'flat', head: [0.05, 0.1, 0] }) },
      { t: 2.5, p: pose({}) }
    ]
  },
  // 8. 환호 박수: 머리 위에서 박수(반 박자마다), 박자마다 깡충
  cheer: {
    loop: true, beats: 2,
    keys: [
      { t: 0, p: pose(Object.assign({}, BOUNCE, { shapeR: 'flat', shapeL: 'flat', head: [0.25, 0, 0] })),
        handTo: { R: [0.06, 1.9, -0.12], L: [-0.06, 1.9, -0.12] }, prefR: [0.6, 0, 2.2, 1.0], prefL: [0.6, 0, 2.2, 1.0] },
      { t: 0.5, p: pose({ air: 0.12, legR: [0.2, 0, 0.05], kneeR: 0.35, legL: [0.2, 0, 0.05], kneeL: 0.35, shapeR: 'flat', shapeL: 'flat', head: [0.3, 0, 0] }),
        handTo: { R: [0.36, 1.86, -0.16], L: [-0.36, 1.86, -0.16] }, prefR: [0.6, 0, 2.2, 1.0], prefL: [0.6, 0, 2.2, 1.0] },
      { t: 1, p: pose(Object.assign({}, BOUNCE, { shapeR: 'flat', shapeL: 'flat', head: [0.25, 0, 0] })),
        handTo: { R: [0.06, 1.9, -0.12], L: [-0.06, 1.9, -0.12] }, prefR: [0.6, 0, 2.2, 1.0], prefL: [0.6, 0, 2.2, 1.0] },
      { t: 1.5, p: pose({ air: 0.12, legR: [0.2, 0, 0.05], kneeR: 0.35, legL: [0.2, 0, 0.05], kneeL: 0.35, shapeR: 'flat', shapeL: 'flat', head: [0.3, 0, 0] }),
        handTo: { R: [0.36, 1.86, -0.16], L: [-0.36, 1.86, -0.16] }, prefR: [0.6, 0, 2.2, 1.0], prefL: [0.6, 0, 2.2, 1.0] }
    ]
  },
  // 9. 수신호(8박): 정지 — 오른 주먹을 들어 세움(0박) → 집결 — 머리 위에서 손을 크게 돌림(1.8~3.8박) →
  //    전진 — 편 손날로 앞을 가르며 한 걸음(4.4박) → 엎드려 — 손바닥으로 두 번 눌러 내리며 무릎을 굽힘(6·7박)
  creamCheese: {
    loop: true, beats: 8,
    keys: [
      { t: 0, p: pose(P(STAND, FREEZE, { head: [0.04, -0.2, 0] })) },
      { t: 1.2, p: pose(P(STAND, FREEZE, { head: [0.04, -0.26, 0], torso: [0, -0.04, 0] })) },
      ...[0, 1, 2, 3, 4].map((i) => {
        const [flex, abd, fore] = RALLY[i % 4];
        return { t: 1.8 + i * 0.5, ease: i ? 'linear' : 'smooth',
          p: pose(P(STAND, { armR: [flex, 0, abd], foreR: fore, armL: [0.08, 0, 0.12], foreL: 0.25, shapeR: 'flat', head: [0.12, 0, 0] })) };
      }),
      { t: 4.4, p: pose({ z: -0.07, legR: [0.32, 0, 0.03], kneeR: 0.12, legL: [-0.15, 0, 0.03], kneeL: 0.22, armR: [1.5, 0, 0], foreR: 0.05, handR: [0, -1.3, 0],
        armL: [0.08, 0, 0.12], foreL: 0.25, shapeR: 'flat', torso: [-0.08, -0.05, 0], head: [0, -0.04, 0] }) },
      { t: 5.4, p: pose({ z: -0.07, legR: [0.32, 0, 0.03], kneeR: 0.12, legL: [-0.15, 0, 0.03], kneeL: 0.22, armR: [1.52, 0, 0], foreR: 0.05, handR: [0, -1.3, 0],
        armL: [0.08, 0, 0.12], foreL: 0.25, shapeR: 'flat', torso: [-0.09, -0.05, 0], head: [0, -0.04, 0] }) },
      ...[[6, 0.9, false], [6.5, 0.6, true], [7, 0.9, false], [7.4, 0.6, true]].map(([t, flex, low]) => ({
        t, p: pose(P(low ? BOUNCE : STAND, { armR: [flex, 0, 0.22], foreR: low ? 0.55 : 0.45, armL: [flex * 0.8, 0, 0.18], foreL: 0.4,
          shapeR: 'flat', shapeL: 'flat', torso: [low ? -0.14 : -0.04, 0, 0], head: [low ? -0.05 : 0.02, 0, 0] }))
      }))
    ]
  },
  // 10. 쌍안경 정찰(8박): 두 주먹을 눈앞에 대고 왼쪽(0박)에서 천천히 오른쪽(4.5박)까지 훑다가 멈칫(5박) →
  //     오른손으로 그쪽을 가리키고(5.6박) → 쌍안경을 내리고 엄지를 들며 끄덕(6.6박)
  fromYou: {
    loop: true, beats: 8,
    keys: [
      ...[[0, 0.45, 'smooth'], [1.5, 0.45, 'smooth'], [3, 0, 'linear'], [4.5, -0.45, 'linear']].map(([t, ry, ease]) => ({
        t, ease, p: pose(P(SCOUT_LEGS, { torso: [0, ry, 0], head: [0.02, 0, 0] })),
        handTo: { R: turnY(BINO_R, ry), L: turnY(BINO_L, ry) }, prefR: BINO_PREF, prefL: BINO_PREF
      })),
      { t: 5, p: pose(P(SCOUT_LEGS, { torso: [-0.08, -0.45, 0], head: [-0.04, 0, 0] })),
        handTo: { R: turnY(BINO_R, -0.45), L: turnY(BINO_L, -0.45) }, prefR: BINO_PREF, prefL: BINO_PREF },
      { t: 5.6, p: pose(P(SCOUT_LEGS, { torso: [-0.06, -0.35, 0], head: [0, -0.05, 0], armR: [1.5, 0, 0.1], foreR: 0.05, shapeR: 'flat' })),
        handTo: { L: turnY(BINO_L, -0.35) }, prefL: BINO_PREF },
      { t: 6.6, p: pose(P(SCOUT_LEGS, { torso: [0.02, -0.1, 0], head: [0.16, 0, 0], armR: [0.45, 0, 0.35], foreR: 2.0, armL: [0.1, 0, 0.15], foreL: 0.3 })) },
      { t: 7.3, p: pose(P(SCOUT_LEGS, { torso: [0.02, -0.1, 0], head: [0.04, 0, 0], armR: [0.45, 0, 0.35], foreR: 2.05, armL: [0.1, 0, 0.15], foreL: 0.3 })) }
    ]
  },
  // 11. 깃발 흔들기(8박): 두 손으로 세운 깃대를 머리 위에서 박자마다 왼쪽·오른쪽으로 크게 흔든다(1~4박) →
  //     가운데로 들어 올렸다가(5박) 땅에 내리꽂고(5.6박) → 일어나 오른손은 허리에, 왼손은 깃대에(6.6박)
  selfie: {
    loop: true, beats: 8,
    keys: [
      ...[[0, 0], [1, 0.3], [2, -0.3], [3, 0.3], [4, -0.3], [5, 0]].map(([t, a]) => ({
        t, p: pose(P(POLE, { air: t === 5 ? 0.06 : 0, legR: [0.1, 0, 0.14], kneeR: 0.2, legL: [0.1, 0, 0.14], kneeL: 0.2, torso: [0.02, 0, a], head: [0.18, 0, a * -0.4] }))
      })),
      { t: 5.6, ease: 'linear', p: pose({ legR: [0.55, 0, 0.1], kneeR: 0.95, legL: [0.55, 0, 0.1], kneeL: 0.95, torso: [-0.25, 0, 0], head: [0.1, 0, 0],
        armR: [0.27, 0, -0.71], foreR: 1.49, armL: [0.36, 0, -0.87], foreL: 1.14, shapeR: 'fist', shapeL: 'fist' }) },
      { t: 6.1, p: pose({ legR: [0.28, 0, 0.1], kneeR: 0.5, legL: [0.28, 0, 0.1], kneeL: 0.5, torso: [-0.08, 0, 0], head: [0.1, 0.06, 0],
        armR: [-0.08, 0, -0.39], foreR: 1.3, armL: [0.35, 0, -0.54], foreL: 1.38, shapeR: 'fist', shapeL: 'fist' }) },
      ...[[6.6, 0.1, 0.15], [7.4, 0.12, 0.18]].map(([t, chest, look]) => ({
        t, p: pose({ legR: [0, 0, 0.1], legL: [0, 0, 0.1], torso: [chest, 0, 0], head: [chest + 0.02, look, 0],
          armR: [-0.42, 0, -0.07], foreR: 1.12, armL: [0.33, 0, -0.21], foreL: 1.62, shapeR: 'fist', shapeL: 'fist' })
      }))
    ]
  }
};

/** 실행용 트랙 (모듈 로드 시 IK·발 높이 계산) */
export const TRACKS = Object.freeze(Object.fromEntries(Object.entries(DEFS).map(([id, d]) => [id, track(d)])));

/**
 * 이모트 id(또는 번호)·경과 시간(초) → 포즈 (반복형은 순환, 한 번형은 마지막 키에서 멈춤)
 * @returns {object|null} 포즈 (out 재사용)
 */
export function sampleEmote(idOrCode, time, out = basePose()) {
  const e = emoteById(idOrCode);
  const tr = e && TRACKS[e.id];
  if (!tr) return null;
  const keys = tr.keys;
  let t, len;
  if (tr.loop) {
    const beat = 60 / (e.bpm || 120);
    len = tr.beats;
    t = ((time / beat) % len + len) % len;
  } else {
    len = tr.seconds;
    t = Math.max(0, Math.min(len, time));
  }
  // 구간 찾기 (반복형은 마지막 → 처음으로 이어짐)
  let i = keys.length - 1;
  while (i > 0 && keys[i].t > t) i--;
  const a = keys[i];
  let b = keys[i + 1], tb;
  if (b) tb = b.t;
  else if (tr.loop) { b = keys[0]; tb = len + keys[0].t; }
  else { return lerpPose(a.p, a.p, 0, out); }
  const span = tb - a.t;
  let f = span > 0 ? (t - a.t) / span : 0;
  f = b.ease === 'linear' ? f : smooth(f);
  return lerpPose(a.p, b.p, f, out);
}

/** 이모트 길이(초): 반복형은 1주기, 한 번형은 전체 */
export function emoteLength(idOrCode) {
  const e = emoteById(idOrCode);
  const tr = e && TRACKS[e.id];
  if (!tr) return 0;
  return tr.loop ? tr.beats * 60 / (e.bpm || 120) : tr.seconds;
}

export const EMOTE_ANIM_IDS = Object.freeze(EMOTES.map((e) => e.id).filter((id) => TRACKS[id]));
