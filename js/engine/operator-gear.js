/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 대원 몸에 붙는 직접 만든 장비(머리 장비·완장·무전기·어깨 장갑 등)와 손에 드는 무기·떨어진 총 모형의 지오메트리를 만든다.
 *          모든 좌표는 아바타 공간(발바닥 원점, 정면 -Z, 오른쪽 +X, 미터)의 바인드 자세(T자)다. 장비는 뼈 하나에 통째로 붙는다.
 */
/*
 *   gearOf(kit, colors) → [[뼈 이름, BufferGeometry(position·normal·color, 색 = 정점색)], ...]
 *   heldGeometry(key) → 손 소켓 기준 무기 지오메트리(소켓 원점 = 오른손 손바닥 쥐는 점, -Z = 총구, +Y = 위)
 *   glassesGeometry() → 좀비 증강 AI 안경(Head 뼈 기준이 아니라 아바타 공간. 붙이는 쪽이 뼈 공간으로 옮긴다)
 *   HEAD_CENTER, HEAD_ORIGIN: 머리 장비 기준점(아바타 공간)
 *
 * 머리 장비 좌표는 예전 상자 머리의 '목 피벗' 기준(머리 중심 = +0.12) 그대로 쓰고 HEAD_ORIGIN으로 옮긴다.
 * 새 머리(맨머리 0.205×0.30×0.228 m)는 예전 상자 머리(0.22×0.25×0.24)와 크기·높이가 거의 같아서 모자·헬멧 치수를 그대로 쓸 수 있다.
 * 팔 장비는 바인드 자세(T자, 팔이 ±X로 뻗음)에서 만든다. 오른팔 위팔 중심선: y 1.388, z -0.05, x 0.147~0.321.
 */
import * as THREE from 'three';

const TAU = Math.PI * 2;

/** 머리 중심(히트박스 머리 구 1.62 근처)과 머리 장비 기준점 */
export const HEAD_CENTER = Object.freeze([0, 1.632, -0.058]);
export const HEAD_ORIGIN = Object.freeze([0, 1.512, -0.058]);

/* ---------------- 정점색 지오메트리 도우미 ---------------- */

function colored(geo, hex) {
  const c = new THREE.Color(hex);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}
function box(w, h, d, x, y, z, hex) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return colored(g, hex);
}
/** 정점색 지오메트리 여러 개 → 색인 지오메트리 하나(원본은 버린다) */
export function merge(geos) {
  let vc = 0, ic = 0;
  for (const g of geos) { vc += g.attributes.position.count; ic += g.index ? g.index.count : g.attributes.position.count; }
  const pos = new Float32Array(vc * 3), nor = new Float32Array(vc * 3), col = new Float32Array(vc * 3), idx = new Uint32Array(ic);
  let vo = 0, io = 0;
  for (const g of geos) {
    const n = g.attributes.position.count;
    pos.set(g.attributes.position.array, vo * 3);
    nor.set(g.attributes.normal.array, vo * 3);
    col.set(g.attributes.color.array, vo * 3);
    if (g.index) for (let i = 0; i < g.index.count; i++) idx[io++] = g.index.getX(i) + vo;
    else for (let i = 0; i < n; i++) idx[io++] = i + vo;
    vo += n;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.setIndex(new THREE.BufferAttribute(vc < 65536 ? new Uint16Array(idx) : idx, 1));
  out.computeBoundingSphere();
  return out;
}
const place = (g, x, y, z, rx = 0, ry = 0, rz = 0) => {
  g.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(1, 1, 1)));
  return g;
};
/** 돌린 상자: (x,y,z)에 놓고 자기 중심으로 rx·ry·rz만큼 돌린다 */
const rbox = (w, h, d, x, y, z, rx, ry, rz, hex) => place(box(w, h, d, 0, 0, 0, hex), x, y, z, rx, ry, rz);
/** 부품 묶음을 한 덩어리로 놓는다(묶음 원점 기준 회전) */
const group = (parts, x, y, z, rx = 0, ry = 0, rz = 0) => place(merge(parts), x, y, z, rx, ry, rz);
/** 세운 원기둥. t0·tl로 일부만 두르면 그 사이가 트인다(0 = 뒤 +Z, π = 앞 -Z) */
function cyl(rTop, rBot, h, seg, x, y, z, hex, open = false, t0 = 0, tl = TAU) {
  const g = new THREE.CylinderGeometry(rTop, rBot, h, seg, 1, open, t0, tl);
  g.translate(x, y, z);
  return colored(g, hex);
}
/** 좌우(X축)로 누운 원기둥 */
function cylX(r, len, seg, x, y, z, hex) {
  const g = new THREE.CylinderGeometry(r, r, len, seg);
  g.rotateZ(Math.PI / 2);
  g.translate(x, y, z);
  return colored(g, hex);
}
/** 앞뒤(Z축)로 누운 원기둥 */
function cylZ(r, len, seg, x, y, z, hex) {
  const g = new THREE.CylinderGeometry(r, r, len, seg);
  g.rotateX(Math.PI / 2);
  g.translate(x, y, z);
  return colored(g, hex);
}
/** 구의 일부(φ: 0 = 왼쪽 -X, π/2 = 뒤, π = 오른쪽, 3π/2 = 앞 / θ: 0 = 꼭대기)를 늘리고 옮긴다 */
function shell(r, ws, hs, p0, pl, t0, tl, sx, sy, sz, x, y, z, hex) {
  const g = new THREE.SphereGeometry(r, ws, hs, p0, pl, t0, tl);
  g.scale(sx, sy, sz);
  g.translate(x, y, z);
  return colored(g, hex);
}
/** 안쪽 면(감는 순서·법선 뒤집기). 트인 후드 안감처럼 안에서 보이는 면에 쓴다 */
function flipped(g) {
  const idx = g.index.array;
  for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
  const n = g.attributes.normal.array;
  for (let i = 0; i < n.length; i++) n[i] = -n[i];
  return g;
}
/** 지오메트리의 -Z를 D로, -Y를 E로 돌려 pos에 놓는다 */
function aimGeo(geo, pos, D, E) {
  const d = new THREE.Vector3(D[0], D[1], D[2]).normalize();
  const e = new THREE.Vector3(E[0], E[1], E[2]);
  e.addScaledVector(d, -e.dot(d)).normalize();
  const z = d.clone().negate(), y = e.clone().negate(), x = new THREE.Vector3().crossVectors(y, z);
  geo.applyMatrix4(new THREE.Matrix4().makeBasis(x, y, z).setPosition(pos[0], pos[1], pos[2]));
  return geo;
}
/** a에서 b까지 이어진 가는 막대(안테나·마이크 대). X축과 나란한 막대에는 쓰지 말 것 */
function rod(a, b, t, hex) {
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const len = Math.hypot(d[0], d[1], d[2]);
  const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  return aimGeo(box(t, t, len, 0, 0, 0, hex), mid, d, [1, 0, 0]);
}
/** 예전 목 피벗 좌표로 만든 머리 장비를 새 머리 자리로 옮긴다 */
const atHead = (geos) => geos.map((g) => g.translate(HEAD_ORIGIN[0], HEAD_ORIGIN[1], HEAD_ORIGIN[2]));
/** 색을 섞는다(k = 0이면 a, 1이면 b) */
const mix = (a, b, k) => new THREE.Color(a).lerp(new THREE.Color(b), k).getHex();

/* ---------------- 모든 대원 공통: 팀 강조(완장·어깨 패치·가슴·등 표식) ----------------
 * 강조색이 멀리서도 보이게(화면 면적 15~25%, PRODUCT_PLAN.md 4.3) 위팔 완장을 넓게 두르고 어깨 위·가슴·등에 판을 붙인다.
 */
const ARM_Y = 1.388, ARM_Z = -0.05;
function teamMarks(c, { chest = true, back = true } = {}) {
  const out = [];
  for (const s of [1, -1]) {
    const bone = s > 0 ? 'UpperArmR' : 'UpperArmL';
    out.push([bone, merge([
      box(0.075, 0.136, 0.128, s * 0.232, ARM_Y, ARM_Z, c.accent),             // 완장(위팔을 한 바퀴)
      box(0.07, 0.012, 0.075, s * 0.195, ARM_Y + 0.07, ARM_Z, c.accent)         // 어깨 패치(T자에서 위 = 팔을 내리면 바깥)
    ])]);
  }
  const torso = [];
  if (chest) torso.push(box(0.17, 0.06, 0.014, 0, 1.275, -0.192, c.accent));   // 가슴 표식 띠
  if (back) torso.push(box(0.2, 0.09, 0.014, 0, 1.28, 0.062, c.accent));        // 등 표식 판
  if (torso.length) out.push(['Chest', merge(torso)]);
  return out;
}

/* ---------------- 대원별 장비 ---------------- */

// 정찰병
const HOOD_IN = 0x262b25, GOGGLE = 0x1e2124, AMBER = 0xd9932e, BINO = 0x232628, LENS_DK = 0x5d7a8c;
// 공병
const MUFF = 0x2b2e33, LAMP = 0x6f757c, LAMP_LENS = 0xfff1b8, WRENCH = 0x9aa3ad, REFLECT = 0xc9cfd4;
// 통신병
const HEADSET = 0x1f2226, MIC = 0x2b2f33, ANTENNA = 0x161819, KNOB = 0x8c9196, LED = 0x6ef08a;
// 사막 레인저
const SHADES = 0x14171a, SCARF = 0xcdb68b, SCARF_DK = 0x8e714a, CANTEEN = 0x5c6650, CANTEEN_DK = 0x2e332a;
// 야간 작전병
const BUMP = 0x2b2e32, BUMP_DK = 0x1b1d20, NVG = 0x2c3035, NVG_LENS = 0x63ff8f;
// 중장갑병
const VISOR = 0x1a2833, VISOR_HI = 0x4f8fb8;

/** 올려 둔 야간 투시경(앞 -Z = 대물렌즈) */
function nvgParts() {
  return [
    cylZ(0.021, 0.085, 10, -0.032, 0, 0, NVG), cylZ(0.021, 0.085, 10, 0.032, 0, 0, NVG),
    cylZ(0.017, 0.008, 10, -0.032, 0, -0.045, NVG_LENS), cylZ(0.017, 0.008, 10, 0.032, 0, -0.045, NVG_LENS),
    box(0.05, 0.028, 0.05, 0, 0, 0.015, NVG)
  ];
}
/** 무릎 보호대(정강이 뼈, 무릎 앞) */
const kneePads = (hex) => [1, -1].map((s) => [s > 0 ? 'LowerLegR' : 'LowerLegL', merge([box(0.125, 0.12, 0.045, s * 0.116, 0.5, -0.165, hex)])]);

const KITS = Object.freeze({
  // 보병: SWAT 헬멧(GLB) 옆 팀 색 띠와 뒤쪽 적외선 표시등, 허리 뒤 주머니
  trooper: (c) => [
    ['Head', merge([
      box(0.014, 0.03, 0.15, 0.119, 1.69, -0.05, c.accent),
      box(0.014, 0.03, 0.15, -0.119, 1.69, -0.05, c.accent),
      box(0.034, 0.03, 0.034, 0, 1.775, 0.035, c.accent),                      // 적외선 표시등(팀 색)
      box(0.05, 0.04, 0.03, 0, 1.73, -0.165, c.gearDark)                        // 앞쪽 장착대
    ])],
    ['Hips', merge([box(0.15, 0.13, 0.06, 0.07, 0.98, 0.08, c.gearDark)])],
    ...teamMarks(c)
  ],

  // 정찰병: 앞이 트인 후드 + 이마에 올린 고글, 등 물주머니
  scout: (c) => {
    const open = 0.78, t0 = Math.PI + open, tl = TAU - 2 * open;   // 얼굴 트임 반각
    return [
      ['Head', merge(atHead([
        cyl(0.166, 0.176, 0.24, 14, 0, 0.1, 0.012, c.gear, true, t0, tl),               // 후드 옆·뒤
        flipped(cyl(0.159, 0.169, 0.24, 14, 0, 0.1, 0.012, HOOD_IN, true, t0, tl)),     // 안감
        shell(0.169, 14, 5, 0, TAU, 0, Math.PI / 2, 1, 0.6, 1, 0, 0.22, 0.012, c.gear), // 후드 윗부분
        cyl(0.167, 0.167, 0.022, 14, 0, 0.245, 0.012, GOGGLE, true),                    // 고글 끈
        box(0.014, 0.03, 0.12, 0.168, 0.16, 0.03, c.accent),                            // 후드 옆 팀 색 띠
        box(0.014, 0.03, 0.12, -0.168, 0.16, 0.03, c.accent),
        group([
          box(0.07, 0.048, 0.03, -0.04, 0, 0, GOGGLE), box(0.07, 0.048, 0.03, 0.04, 0, 0, GOGGLE),
          box(0.056, 0.034, 0.012, -0.04, 0, -0.016, AMBER), box(0.056, 0.034, 0.012, 0.04, 0, -0.016, AMBER),
          box(0.02, 0.016, 0.02, 0, 0, 0, GOGGLE)
        ], 0, 0.25, -0.166, 0.35)                                                       // 이마에 올린 고글
      ]))],
      ['Neck', merge([cyl(0.105, 0.12, 0.07, 12, 0, 1.47, -0.05, c.gear)])],            // 목둘레(후드 아래)
      ['Chest', merge([
        box(0.2, 0.26, 0.05, 0, 1.24, 0.085, c.gear),                                   // 등 물주머니
        cylZ(0.026, 0.08, 10, -0.03, 1.12, -0.205, BINO), cylZ(0.026, 0.08, 10, 0.03, 1.12, -0.205, BINO),   // 쌍안경
        cylZ(0.02, 0.01, 10, -0.03, 1.12, -0.25, LENS_DK), cylZ(0.02, 0.01, 10, 0.03, 1.12, -0.25, LENS_DK)
      ])],
      ...teamMarks(c, { back: false })
    ];
  },

  // 공병: 안전모(GLB) 옆 팀 색 줄, 귀마개, 헤드램프, 공구 주머니·렌치, 무릎 보호대
  sapper: (c) => [
    ['Head', merge([
      box(0.012, 0.028, 0.15, 0.118, 1.715, -0.06, c.accent),
      box(0.012, 0.028, 0.15, -0.118, 1.715, -0.06, c.accent),
      cylX(0.047, 0.045, 12, 0.118, 1.61, -0.05, MUFF), cylX(0.047, 0.045, 12, -0.118, 1.61, -0.05, MUFF),   // 귀마개
      box(0.016, 0.08, 0.028, 0.132, 1.665, -0.05, MUFF), box(0.016, 0.08, 0.028, -0.132, 1.665, -0.05, MUFF),
      box(0.055, 0.04, 0.032, 0, 1.712, -0.205, LAMP),                                  // 헤드램프
      cylZ(0.015, 0.008, 10, 0, 1.712, -0.224, LAMP_LENS)
    ])],
    ['Hips', merge([
      box(0.08, 0.12, 0.1, 0.17, 0.92, -0.06, c.gearDark), box(0.08, 0.12, 0.1, -0.17, 0.92, -0.06, c.gearDark),   // 공구 주머니
      box(0.012, 0.16, 0.024, 0.215, 0.89, -0.06, WRENCH), box(0.016, 0.034, 0.06, 0.215, 0.98, -0.06, WRENCH)    // 렌치
    ])],
    ['Chest', merge([box(0.29, 0.025, 0.012, 0, 1.2, -0.19, REFLECT), box(0.29, 0.025, 0.012, 0, 1.2, 0.058, REFLECT)])],   // 반사띠
    ...kneePads(c.gearDark),
    ...teamMarks(c)
  ],

  // 통신병: 정찰모 + 헤드셋·마이크, 등에 멘 무전기와 긴 안테나
  signal: (c) => [
    ['Head', merge(atHead([
      cyl(0.14, 0.157, 0.085, 14, 0, 0.215, 0.006, c.gear),                   // 정찰모(위가 조금 좁다)
      rbox(0.2, 0.012, 0.085, 0, 0.18, -0.19, 0.16, 0, 0, c.gearDark),        // 챙
      box(0.055, 0.03, 0.01, 0, 0.225, -0.152, c.accent),                     // 모자 팀 표식
      cyl(0.159, 0.159, 0.018, 14, 0, 0.185, 0.006, c.accent, true),          // 모자 둘레 팀 색 띠
      cylX(0.05, 0.045, 12, 0.125, 0.1, 0.012, HEADSET),                      // 헤드셋
      cylX(0.05, 0.045, 12, -0.125, 0.1, 0.012, HEADSET),
      box(0.014, 0.16, 0.022, 0.16, 0.18, 0.012, HEADSET),
      box(0.014, 0.16, 0.022, -0.16, 0.18, 0.012, HEADSET),
      box(0.33, 0.012, 0.022, 0, 0.264, 0.012, HEADSET),
      rod([-0.12, 0.07, -0.025], [-0.05, 0.045, -0.16], 0.013, MIC),          // 마이크
      box(0.03, 0.024, 0.028, -0.048, 0.044, -0.166, MIC)
    ]))],
    ['Chest', merge([
      box(0.22, 0.3, 0.09, 0, 1.24, 0.11, c.gear),                            // 등에 멘 무전기
      box(0.225, 0.035, 0.095, 0, 1.1, 0.11, c.gearDark),
      box(0.1, 0.07, 0.012, 0.04, 1.31, 0.16, c.gearDark),
      cylZ(0.016, 0.02, 8, -0.06, 1.33, 0.162, KNOB), cylZ(0.016, 0.02, 8, -0.06, 1.27, 0.162, KNOB),
      box(0.016, 0.016, 0.008, 0.08, 1.35, 0.161, LED),
      box(0.03, 0.05, 0.03, -0.085, 1.415, 0.125, c.gearDark),                // 안테나 받침
      rod([-0.085, 1.44, 0.125], [-0.085, 1.94, 0.19], 0.018, ANTENNA),
      box(0.03, 0.03, 0.03, -0.085, 1.94, 0.19, c.accent),                    // 안테나 끝(팀 색)
      box(0.04, 0.02, 0.27, -0.09, 1.4, -0.06, c.gearDark), box(0.04, 0.02, 0.27, 0.09, 1.4, -0.06, c.gearDark)   // 멜빵
    ])],
    ...teamMarks(c, { back: false })
  ],

  // 사막 레인저: 챙 넓은 모자(GLB, 띠 = 팀 색) + 선글라스, 목 스카프, 수통
  ranger: (c) => [
    ['Head', merge([
      box(0.19, 0.032, 0.014, 0, 1.632, -0.185, SHADES),                      // 선글라스
      box(0.012, 0.014, 0.13, 0.103, 1.638, -0.12, SHADES),
      box(0.012, 0.014, 0.13, -0.103, 1.638, -0.12, SHADES)
    ])],
    ['Neck', merge([
      cyl(0.105, 0.12, 0.075, 12, 0, 1.46, -0.05, SCARF),                     // 목에 두른 스카프
      cyl(0.124, 0.124, 0.014, 12, 0, 1.44, -0.05, SCARF_DK, true),
      rbox(0.09, 0.14, 0.02, -0.04, 1.37, -0.17, 0.12, 0, 0.16, SCARF)        // 앞으로 늘어진 끝
    ])],
    ['Hips', merge([cyl(0.05, 0.05, 0.14, 12, -0.16, 0.93, 0.03, CANTEEN), cyl(0.02, 0.02, 0.03, 8, -0.16, 1.015, 0.03, CANTEEN_DK)])],
    ...teamMarks(c)
  ],

  // 야간 작전병: 복면(GLB 맨머리를 검게) + 가벼운 헬멧과 올려 둔 투시경, 검은 판
  night: (c) => [
    ['Head', merge(atHead([
      shell(0.15, 14, 8, 0, TAU, 0, Math.PI * 0.52, 1, 0.78, 1.1, 0, 0.18, 0.006, BUMP),   // 가벼운 헬멧
      box(0.022, 0.05, 0.17, 0.149, 0.15, 0.006, BUMP_DK),
      box(0.022, 0.05, 0.17, -0.149, 0.15, 0.006, BUMP_DK),
      box(0.012, 0.024, 0.11, 0.161, 0.15, 0.006, c.accent),                  // 팀 색 줄
      box(0.012, 0.024, 0.11, -0.161, 0.15, 0.006, c.accent),
      box(0.03, 0.026, 0.03, 0, 0.3, 0.06, c.accent),                         // 적외선 표시등
      box(0.07, 0.045, 0.03, 0, 0.228, -0.158, BUMP_DK),                      // 투시경 장착대
      group(nvgParts(), 0, 0.29, -0.178, 1.15)                                // 이마 위로 올린 투시경
    ]))],
    ['Chest', merge([box(0.27, 0.22, 0.04, 0, 1.22, -0.2, c.gearDark), box(0.24, 0.2, 0.03, 0, 1.22, 0.07, c.gearDark)])],
    ...kneePads(c.gearDark),
    ...teamMarks(c)
  ],

  // 중장갑병: 머리를 감싼 헬멧(가리개·팀 색 볏), 가슴·등판, 어깨 장갑(위팔), 무릎 판
  heavy: (c) => {
    const plate = c.gear, dark = c.gearDark, light = mix(c.gear, '#ffffff', 0.12);
    const pads = [1, -1].map((s) => [s > 0 ? 'UpperArmR' : 'UpperArmL', merge([
      rbox(0.17, 0.07, 0.17, s * 0.2, 1.47, -0.05, 0, 0, -s * 0.12, plate),     // 어깨 장갑(T자에서 위팔 위)
      rbox(0.172, 0.014, 0.172, s * 0.2, 1.51, -0.05, 0, 0, -s * 0.12, c.accent),
      rbox(0.13, 0.05, 0.15, s * 0.29, 1.44, -0.05, 0, 0, -s * 0.3, dark)
    ])]);
    return [
      ['Head', merge(atHead([
        // 헬멧이 머리를 감싼다. 중심이 히트박스 머리 구 중심이고 크기도 거의 같다
        shell(0.152, 16, 10, 0, TAU, 0, Math.PI * 0.8, 1, 1.05, 1.07, 0, 0.12, 0.006, plate),
        shell(0.157, 12, 5, Math.PI * 1.5 - 0.82, 1.64, Math.PI * 0.36, Math.PI * 0.26, 1, 1.05, 1.07, 0, 0.12, 0.006, VISOR),   // 얼굴 가리개
        shell(0.159, 12, 1, Math.PI * 1.5 - 0.7, 1.4, Math.PI * 0.485, Math.PI * 0.03, 1, 1.05, 1.07, 0, 0.12, 0.006, VISOR_HI), // 가리개 빛줄
        shell(0.152, 10, 5, 0, TAU, 0, Math.PI * 0.3, 0.11, 1.12, 1.12, 0, 0.12, 0.006, c.accent),  // 팀 색 볏
        box(0.2, 0.055, 0.07, 0, 0, -0.125, dark),                            // 턱 보호대
        cylX(0.055, 0.03, 12, 0.152, 0.11, 0.01, dark),                       // 귀 판
        cylX(0.055, 0.03, 12, -0.152, 0.11, 0.01, dark)
      ]))],
      ['Chest', merge([
        box(0.31, 0.28, 0.05, 0, 1.22, -0.2, plate),                          // 가슴판
        box(0.25, 0.035, 0.012, 0, 1.3, -0.228, c.accent),                    // 가슴 팀 띠
        box(0.28, 0.26, 0.05, 0, 1.22, 0.08, dark),                           // 등판
        box(0.22, 0.06, 0.2, 0, 1.43, -0.05, light)                           // 목 보호대
      ])],
      ...pads,
      ...kneePads(dark),
      ...teamMarks(c, { chest: false })
    ];
  }
});

export const GEAR_KITS = Object.freeze(Object.keys(KITS));

/** 장비 묶음 → [[뼈 이름, 지오메트리], ...]. colors = { uniform, accent, gear, gearDark } (hex 숫자) */
export function gearOf(kit, colors) {
  const make = KITS[kit];
  if (!make) throw new Error('모르는 장비 묶음: ' + kit);
  const c = { ...colors, gearDark: mix(colors.gear, '#000000', 0.35) };
  return make(c);
}

/* ---------------- 손에 드는 무기(손 소켓 기준) ----------------
 * 소켓 = 오른손 손바닥이 쥐는 점. 총을 든 자세에서 아바타와 같은 방향(-Z = 앞)이다. 무기 담당이 setHeld로 넘기는 모형도 이 기준이다.
 */
const GUN = 0x2c3034, HELMET_DK = 0x24262a, STEEL = 0xc9d2da, STEEL_DK = 0x6f7884, WRAP = 0x4a1525, BRASS = 0x8f7038;

/** 기본 소지 무기(총 원점 기준, 총구 = -Z). 손잡이 = (0, -0.1, -0.05) */
function gunGeo() {
  return merge([
    box(0.06, 0.09, 0.62, 0, 0, -0.18, GUN),
    box(0.05, 0.14, 0.06, 0, -0.1, -0.05, GUN),
    box(0.04, 0.05, 0.2, 0, 0.065, -0.2, 0x3e4448),
    box(0.05, 0.1, 0.16, 0, -0.03, 0.18, 0x5a4632)
  ]);
}
/** 저폴리 칼날(원점 = 밑동, -Z = 칼끝, +Y = 등, -Y = 날). 면마다 정점을 따로 둬 각이 살아 있다 */
function bladeGeo(L, sag, W0, W1, T, hexHi, hexLo) {
  const Rc = sag > 0 ? (L * L) / (8 * sag) + sag / 2 : 0;
  const rings = 7, tipStart = 0.9;
  const ring = (u) => {
    const s = u * L, th = Rc ? s / Rc : 0;
    const cy = Rc ? Rc * (1 - Math.cos(th)) : 0, cz = Rc ? -Rc * Math.sin(th) : -s, ny = Math.cos(th), nz = Math.sin(th);
    const q = u > tipStart ? (u - tipStart) / (1 - tipStart) : 0;
    const W = W0 + (W1 - W0) * Math.min(u / tipStart, 1), t = T * (1 - q * q);
    const a = 0.38 * W, r0 = 0.08 * W, r = r0 + (a - r0) * q, e = -0.62 * W + W * Math.pow(q, 2.2);
    const P = (x, n) => [x, cy + n * ny, cz + n * nz];
    return { back: P(0, a), rp: P(t / 2, r), rn: P(-t / 2, r), edge: P(0, e) };
  };
  const faces = [['back', 'rp', hexHi], ['rp', 'edge', hexLo], ['rn', 'back', hexHi], ['edge', 'rn', hexLo]];
  return merge(faces.map(([A, B, hex]) => {
    const pos = [], idx = [];
    for (let i = 0; i <= rings; i++) { const R = ring(i / rings); pos.push(...R[A], ...R[B]); }
    for (let i = 0; i < rings; i++) { const v = i * 2; idx.push(v, v + 1, v + 2, v + 2, v + 1, v + 3); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return colored(g, hex);
  }));
}
/** 코등이 타원판(z 위치) */
function discGeo(rx, ry, th, z, hex) {
  const d = new THREE.CylinderGeometry(1, 1, th, 10);
  d.rotateX(Math.PI / 2);
  d.scale(rx, ry, 1);
  d.translate(0, 0, z);
  return colored(d, hex);
}
/** 카타나(칼끝 = -Z, 등 = +Y). 긴 곡선 날, 코등이, 끈 감은 손잡이 */
function katanaGeo() {
  const blade = bladeGeo(0.98, 0.05, 0.036, 0.027, 0.009, STEEL_DK, STEEL);
  blade.translate(0, 0, -0.05);
  return merge([
    blade,
    discGeo(0.04, 0.046, 0.007, -0.048, HELMET_DK),
    box(0.026, 0.034, 0.25, 0, 0, 0.08, WRAP),
    box(0.0275, 0.014, 0.022, 0, 0, 0.13, 0xd8d4c8),
    box(0.0275, 0.014, 0.022, 0, 0, 0.17, 0xd8d4c8),
    box(0.03, 0.038, 0.02, 0, 0, 0.21, BRASS)
  ]);
}
/** 나이프. 짧은 날 + 작은 코등이 */
function knifeGeo() {
  const blade = bladeGeo(0.2, 0, 0.032, 0.028, 0.007, 0x2d3036, STEEL);
  blade.translate(0, 0, -0.05);
  return merge([
    blade,
    box(0.014, 0.058, 0.012, 0, -0.004, -0.048, HELMET_DK),
    box(0.024, 0.032, 0.11, 0, 0, 0.005, 0x1d2024),
    box(0.027, 0.035, 0.018, 0, 0, 0.066, HELMET_DK)
  ]);
}
/** 구르카 나이프. 곧은 뿌리에서 앞쪽 날이 아래로 꺾인다 */
function gurkhaGeo() {
  const root = bladeGeo(0.13, 0, 0.034, 0.04, 0.008, 0x8a8f96, STEEL);
  root.translate(0, 0, -0.05);
  const head = bladeGeo(0.2, 0, 0.056, 0.032, 0.008, 0x8a8f96, STEEL);
  head.rotateX(-0.38);
  head.translate(0, -0.008, -0.17);
  return merge([
    root, head,
    box(0.016, 0.05, 0.012, 0, -0.002, -0.048, BRASS),
    box(0.026, 0.034, 0.11, 0, -0.004, 0.005, 0x5b3a1e),
    box(0.03, 0.038, 0.016, 0, -0.008, 0.066, BRASS)
  ]);
}
/** 007 가방: 손잡이(z축)를 쥐고 아래(-Y)로 늘어뜨린 서류 가방 */
function caseGeo() {
  const parts = [
    box(0.024, 0.024, 0.12, 0, 0, 0, 0x1c1c20),
    box(0.02, 0.05, 0.02, 0, -0.035, 0.05, HELMET_DK),
    box(0.02, 0.05, 0.02, 0, -0.035, -0.05, HELMET_DK),
    box(0.1, 0.32, 0.46, 0, -0.22, 0, 0x3b3b44),
    box(0.106, 0.03, 0.04, 0, -0.085, 0.13, BRASS),
    box(0.106, 0.03, 0.04, 0, -0.085, -0.13, BRASS)
  ];
  for (const sy of [1, -1]) for (const sz of [1, -1]) parts.push(box(0.106, 0.04, 0.04, 0, -0.22 + sy * 0.145, sz * 0.215, STEEL));
  return merge(parts);
}
/** 전기톱(소켓 = 뒤 손잡이). 노란 엔진 몸통, 위 손잡이, -Z로 뻗은 안내판과 체인 */
function sawGeo() {
  const DARK = 0x24272b, CHAIN = 0x2a2d31;
  return merge([
    box(0.03, 0.03, 0.14, 0, 0, 0.04, DARK),
    box(0.11, 0.16, 0.24, 0, -0.02, -0.15, 0xe8a317),
    box(0.09, 0.03, 0.2, 0, 0.07, -0.15, DARK),
    box(0.02, 0.05, 0.02, -0.05, 0.085, -0.2, DARK),
    box(0.12, 0.022, 0.022, 0, 0.11, -0.2, DARK),
    box(0.012, 0.07, 0.4, 0, -0.06, -0.47, STEEL_DK),
    box(0.016, 0.012, 0.4, 0, -0.022, -0.47, CHAIN),
    box(0.016, 0.012, 0.4, 0, -0.098, -0.47, CHAIN),
    cylX(0.035, 0.012, 10, 0, -0.06, -0.67, STEEL_DK)
  ]);
}

/** 총을 손 소켓에 맞춘다: 손잡이 윗부분(0, -0.06, -0.05)이 소켓 원점에 오게 */
const GUN_IN_HAND = [0, 0.06, 0.05];
const heldCache = new Map();
const HELD = {
  gun: () => gunGeo().translate(GUN_IN_HAND[0], GUN_IN_HAND[1], GUN_IN_HAND[2]),
  katana: () => aimGeo(katanaGeo(), [0, 0, 0], [-0.14, 0.56, -0.82], [0.0, -0.82, -0.56]),
  knife: () => aimGeo(knifeGeo(), [0, 0, 0], [-0.1, 0.24, -0.96], [0.0, -0.96, -0.24]),
  gurkha: () => aimGeo(gurkhaGeo(), [0, 0, 0], [-0.1, 0.34, -0.93], [0.0, -0.93, -0.34]),
  case: () => aimGeo(caseGeo(), [0, 0, 0], [-0.1, 0, -1], [0, -1, 0]),
  saw: () => aimGeo(sawGeo(), [0, 0, 0], [-0.06, 0.08, -1], [0, -1, 0.08])
};
export const HELD_KEYS = Object.freeze(Object.keys(HELD));

/** 든 무기 이름 → 소켓 기준 지오메트리(한 번 만들어 나눠 쓴다. 지우지 말 것) */
export function heldGeometry(key) {
  const k = HELD[key] ? key : 'gun';
  if (!heldCache.has(k)) heldCache.set(k, HELD[k]());
  return heldCache.get(k);
}

/** 칼 무기 id → 든 무기 이름 */
const MELEE_HELD = Object.freeze({ ml_katana: 'katana', ml_gurkha: 'gurkha', ml_case: 'case', ml_saw: 'saw' });
/** 슬롯·무기 id → 든 무기 이름. 칼만 바꾸고 나머지(수류탄 포함)는 기본 총 */
export function heldKeyOf(slot, weaponId) {
  const s = Number(slot);
  const melee = s === 3 || (!(s > 0) && typeof weaponId === 'string' && weaponId.startsWith('ml_'));
  if (!melee) return 'gun';
  return MELEE_HELD[weaponId] || 'knife';
}

let droppedGeo = null;
/** 바닥에 떨어진 총 모형 지오메트리(손에 든 총과 같은 모양, 총 원점 기준, 총구 = -Z) */
export function droppedGunGeometry() {
  if (!droppedGeo) droppedGeo = gunGeo();
  return droppedGeo;
}

let glassesGeo = null;
/** 좀비 증강 AI 안경(아바타 공간, 눈 앞) */
export function glassesGeometry() {
  if (!glassesGeo) glassesGeo = merge(atHead([
    box(0.092, 0.046, 0.018, -0.054, 0.12, -0.13, 0x35eaff),
    box(0.092, 0.046, 0.018, 0.054, 0.12, -0.13, 0x35eaff),
    box(0.026, 0.012, 0.024, 0, 0.125, -0.132, 0x132a35),
    box(0.018, 0.012, 0.145, -0.112, 0.125, -0.05, 0x132a35),
    box(0.018, 0.012, 0.145, 0.112, 0.125, -0.05, 0x132a35)
  ]));
  return glassesGeo;
}
