/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 원격 아바타(저폴리 인물: 전술 헬멧 + 전투복 + 조끼, 블루 팀 남색 / 오렌지 팀 주황). 총·칼을 든 평소 몸, 앉기, 이모트 리그를 그린다.
 */

/*
 *   const avatars = createAvatars({ scene, camera });
 *   avatars.add(id, { name, team })          // 이미 있으면 갱신
 *   avatars.push(id, t, state)               // 스냅샷 { pos:[x,y,z], yaw, pitch, moving, walking, crouch, alive, slot, weaponId, ... }, t = ms
 *   avatars.update(now, dt)                  // 매 프레임: now − delay(100 ms) 시점으로 보간 → 메시·히트박스 갱신
 *   avatars.getTargets()                     // raycastPlayers용 [{ id, pos, yaw, alive, crouch(0..1), team, name }] (보간된 화면 위치·자세)
 *   avatars.get(id).kill({ dir:[x,z] }) / .revive() / .setHeld(object3d) / .setName() / .setTeam()
 *   avatars.setLocalTeam(team)               // 아군 이름표는 벽 너머로도 보임
 *   avatars.setLocalBody({ visible, pos, yaw, team, name, emote, crouch, slot, weaponId })  // 3인칭(이모트) 때 내 몸 (player.getBodyState())
 *   avatars.remove(id) / clear() / dispose()
 *   await avatars.prewarm(fn)                // 맵 로드 때: 두 팀의 평소 몸·앉은 다리·이모트 리그 부품을 장면에 잠깐 넣고 fn(컴파일·한 번 그리기)
 *   avatars.compileWarm(webglRenderer, camera) // 그림자 켬·끔 등 품질이 바뀐 뒤 셰이더만 다시 준비
 *
 * 든 무기: state.slot === 3이면 총 대신 칼(weaponId 'ml_knife'면 나이프, 그 밖은 카타나). 슬롯 없이 weaponId가 'ml_'로 시작해도 칼이다.
 *   메시를 늘리지 않고 팔 메시의 지오메트리만 바꾼다(아바타당 메시 4개 유지). 수류탄 등 나머지는 기본 총.
 *   칼을 들어도 두 손 위치는 총을 든 자세와 같아서 손 히트박스(consts HITBOX.HANDS)가 그대로 맞는다.
 *
 * 이모트(MODES.md 4.5): 스냅샷 emote(번호 1~15, 0 = 없음)가 오면 그때만 관절 리그(몸통·머리·위팔·아래팔·손·허벅지·정강이,
 *   메시 12개)로 바꿔 engine/emoteanim.js의 키프레임을 처음부터 재생한다(반복형은 계속). 0이 되면 0.15초 만에 평소 자세로
 *   돌아와 평소 메시 4개로 되돌린다 → 평소 draw call은 늘지 않는다. 히트박스는 이모트 중에도 서 있는 그대로.
 * 모델 좌표: 발바닥 원점, 정면 = 로컬 -Z (yaw 0이면 -Z를 봄). 히트박스(consts HITBOX)와 같은 치수.
 * 앉기: state.crouch → 0.12초에 걸쳐 쪼그려 앉은 자세(엉덩이를 뒤로 낮추고 무릎 굽힘, 상체 앞으로)
 *       머리 중심 ≈ 1.13 m = HITBOX_CROUCH.HEAD. getTargets().crouch가 같은 비율이라 히트박스도 자세와 맞는다.
 */
import * as THREE from 'three';
import { TEAMS, TEAM_IDS, NET, HITBOX, PLAYER, EMOTE_BLEND, emoteById } from '../core/consts.js';
import { SnapshotBuffer, lerpAngle } from './interp.js';
import { RIG, NEUTRAL, makePose, lerpPose, sampleEmote, sideRot } from './emoteanim.js';

const FONT = "'Pretendard','Noto Sans KR','Malgun Gothic','Apple SD Gothic Neo',system-ui,sans-serif";

/* ---------------- 공유 지오메트리 (정점색) ---------------- */

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
function merge(geos) {
  let vc = 0, ic = 0;
  for (const g of geos) { vc += g.attributes.position.count; ic += g.index.count; }
  const pos = new Float32Array(vc * 3), nor = new Float32Array(vc * 3), col = new Float32Array(vc * 3), idx = new Uint16Array(ic);
  let vo = 0, io = 0;
  for (const g of geos) {
    pos.set(g.attributes.position.array, vo * 3);
    nor.set(g.attributes.normal.array, vo * 3);
    col.set(g.attributes.color.array, vo * 3);
    for (let i = 0; i < g.index.count; i++) idx[io++] = g.index.getX(i) + vo;
    vo += g.attributes.position.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  return out;
}

/** 손(무기 소켓) 위치: 어깨 피벗 기준 */
const HAND = [0.1, -0.22, -0.32];
/** 앉은 자세: 허벅지 앞으로 α, 정강이 뒤로 β, 엉덩이 높이·뒤로 뺀 거리, 상체 숙임 */
const SQUAT = { thigh: 1.35, shin: 0.75, hipY: 0.51, hipZ: 0.2, lean: 0.4 };
const STAND_HIP = 0.95;
/** 오른손 장갑 중심(어깨 피벗 기준). consts HITBOX.HANDS는 이 자세에서 계산한다(서 있을 때 y = 1.45 + 아래 y) */
const HAND_R = [0.2442, -0.1722, -0.5181];
const SKIN = 0xd9a77e, BOOT = 0x2b2622, GLOVE = 0x3a3a36, TAPE = 0x33363a, BELT = 0x25211d, EYES = 0x1c1a18, GUN = 0x2c3034;
const HELMET = 0x3c4038, HELMET_DK = 0x24262a, VEST = 0x2f322e, POUCH = 0x3b3e38;
const STEEL = 0xc9d2da, STEEL_DK = 0x6f7884, WRAP = 0x4a1525, BRASS = 0x8f7038;

/* 부품 빌더 — 평소 몸(메시 4개)과 이모트 리그(메시 12개)가 같이 쓴다 */
function torsoGeo(suit, accent) {
  return merge([
    box(0.5, 0.56, 0.3, 0, 0.27, 0, suit),                 // 몸통 0.95~1.51
    box(0.42, 0.36, 0.33, 0, 0.31, 0, VEST),               // 방탄 조끼
    box(0.11, 0.11, 0.03, -0.12, 0.2, -0.17, POUCH),       // 탄창 주머니
    box(0.11, 0.11, 0.03, 0.12, 0.2, -0.17, POUCH),
    box(0.1, 0.06, 0.02, -0.11, 0.42, -0.17, accent),      // 가슴 팀 표식
    box(0.52, 0.07, 0.32, 0, 0.02, 0, BELT),               // 벨트
    box(0.16, 0.16, 0.06, 0.12, 0.08, 0.18, 0x3b3b3b),     // 허리 주머니(뒤)
    box(0.13, 0.06, 0.14, 0, 0.58, 0, SKIN)                // 목
  ]);
}
/** 머리 + 전술 헬멧 (목 피벗 기준, 위로). 헬멧은 무채색이고 옆줄 하나만 팀 색이다 */
function headGeo(accent) {
  const shell = new THREE.SphereGeometry(0.15, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.56);
  shell.scale(1, 0.84, 1.1); shell.translate(0, 0.175, 0.006); colored(shell, HELMET);
  return merge([
    box(0.22, 0.25, 0.24, 0, 0.12, 0, SKIN),               // 머리 (히트박스 구 중심 1.62)
    box(0.05, 0.04, 0.03, 0, 0.07, -0.13, 0xc28f6a),       // 코
    box(0.04, 0.018, 0.012, -0.05, 0.125, -0.122, EYES),   // 눈
    box(0.04, 0.018, 0.012, 0.05, 0.125, -0.122, EYES),
    shell,
    box(0.022, 0.05, 0.17, 0.149, 0.145, 0.006, HELMET_DK), // 옆 레일
    box(0.022, 0.05, 0.17, -0.149, 0.145, 0.006, HELMET_DK),
    box(0.012, 0.022, 0.1, 0.161, 0.145, 0.006, accent),    // 팀 색 줄
    box(0.012, 0.022, 0.1, -0.161, 0.145, 0.006, accent),
    box(0.09, 0.045, 0.024, 0, 0.222, -0.158, HELMET_DK),   // 앞쪽 장착대
    box(0.2, 0.014, 0.012, 0, 0.012, -0.112, HELMET_DK)     // 턱끈
  ]);
}
/** 기본 소지 무기(손 소켓 기준, 총구 = -Z) */
function gunGeo() {
  return merge([
    box(0.06, 0.09, 0.62, 0, 0, -0.18, GUN),
    box(0.05, 0.14, 0.06, 0, -0.1, -0.05, GUN),
    box(0.04, 0.05, 0.2, 0, 0.065, -0.2, 0x3e4448),
    box(0.05, 0.1, 0.16, 0, -0.03, 0.18, 0x5a4632)
  ]);
}
/**
 * 저폴리 칼날(원점 = 밑동, -Z = 칼끝, +Y = 등, -Y = 날). 면마다 정점을 따로 둬 각이 살아 있다. 팔 메시에 합쳐 쓰므로 draw call이 늘지 않는다.
 */
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
/** 카타나(손 소켓 기준, 칼끝 = -Z, 등 = +Y). 긴 곡선 날, 코등이, 끈 감은 손잡이 */
function katanaGeo() {
  const blade = bladeGeo(0.98, 0.05, 0.036, 0.027, 0.009, STEEL_DK, STEEL);
  blade.translate(0, 0, -0.05);
  return merge([
    blade,
    discGeo(0.04, 0.046, 0.007, -0.048, HELMET_DK),
    box(0.026, 0.034, 0.25, 0, 0, 0.08, WRAP),             // 손잡이
    box(0.0275, 0.014, 0.022, 0, 0, 0.13, 0xd8d4c8),       // 끈 사이 마름모
    box(0.0275, 0.014, 0.022, 0, 0, 0.17, 0xd8d4c8),
    box(0.03, 0.038, 0.02, 0, 0, 0.21, BRASS)              // 손잡이 끝
  ]);
}
/** 나이프(손 소켓 기준). 짧은 날 + 작은 코등이 */
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
/** 지오메트리의 -Z를 D로, -Y를 E로 돌려 pos에 놓는다 */
function aimGeo(geo, pos, D, E) {
  const d = new THREE.Vector3(D[0], D[1], D[2]).normalize();
  const e = new THREE.Vector3(E[0], E[1], E[2]);
  e.addScaledVector(d, -e.dot(d)).normalize();
  const z = d.clone().negate(), y = e.clone().negate(), x = new THREE.Vector3().crossVectors(y, z);
  geo.applyMatrix4(new THREE.Matrix4().makeBasis(x, y, z).setPosition(pos[0], pos[1], pos[2]));
  return geo;
}
const place = (g, x, y, z, rx = 0, ry = 0, rz = 0) => {
  const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(1, 1, 1));
  g.applyMatrix4(m);
  return g;
};

const geoCache = new Map();
/** team → { upper(몸통+머리), legL, legR, armsGun·armsKatana·armsKnife(두 팔+든 무기), armsOnly } (팀 색이 정점색으로 들어감) */
function teamGeometry(team) {
  if (geoCache.has(team)) return geoCache.get(team);
  const T = TEAMS[team] || TEAMS.owner;
  const suit = new THREE.Color(T.color).getHex();
  const accent = new THREE.Color(T.light).getHex();
  // 다리(엉덩이 피벗, 아래로) + 장화
  const leg = () => merge([
    box(0.17, 0.83, 0.2, 0, -0.415, 0, suit),
    box(0.175, 0.045, 0.205, 0, -0.5, 0, TAPE),
    box(0.17, 0.13, 0.28, 0, -0.885, -0.035, BOOT)
  ]);
  // 팔(어깨 피벗 기준, 아래로) + 장갑
  const arm = () => merge([
    box(0.13, 0.5, 0.14, 0, -0.25, 0, suit),
    box(0.135, 0.04, 0.145, 0, -0.33, 0, TAPE),
    box(0.11, 0.12, 0.12, 0, -0.55, 0, GLOVE)
  ]);
  // 드로우콜 절약: 머리는 몸통에, 두 팔 + 총은 '어깨 피벗' 메시 하나로 굽는다(아바타당 메시 4개)
  const head = headGeo(accent);
  head.translate(0, 0.55, 0);
  const upper = merge([torsoGeo(suit, accent), head]);
  // 어깨 피벗(상체 기준 y=0.5)에서 본 좌표. +X 회전 = 팔이 앞(-Z)으로 들림, Z 회전 = 몸 안쪽으로
  const armsOnly = () => merge([place(arm(), 0.31, 0, 0, 1.25, 0, -0.12), place(arm(), -0.31, 0, 0, 1.15, 0, 0.55)]);
  const armsGun = merge([armsOnly(), place(gunGeo(), HAND[0], HAND[1], HAND[2])]);
  // 칼을 들어도 두 팔은 그대로다. 오른손에 칼을 쥐고 왼손은 앞에 둔 경계 자세
  const armsKatana = merge([armsOnly(), aimGeo(katanaGeo(), HAND_R, [-0.14, 0.56, -0.82], [0.0, -0.82, -0.56])]);
  const armsKnife = merge([armsOnly(), aimGeo(knifeGeo(), HAND_R, [-0.1, 0.24, -0.96], [0.0, -0.96, -0.24])]);
  // 앉은 다리(엉덩이 피벗): 허벅지 0.45 m를 앞으로 굽히고 정강이 0.38 m를 뒤로, 장화는 바닥과 평평하게
  const legBent = () => {
    const a = SQUAT.thigh, b = SQUAT.shin;
    const thigh = place(merge([box(0.17, 0.45, 0.2, 0, -0.225, 0, suit)]), 0, 0, 0, a);
    const kneeY = -0.45 * Math.cos(a), kneeZ = -0.45 * Math.sin(a);
    const shin = place(merge([box(0.17, 0.38, 0.2, 0, -0.19, 0, suit), box(0.175, 0.045, 0.205, 0, -0.08, 0, TAPE)]), 0, kneeY, kneeZ, -b);
    const ankleY = kneeY - 0.38 * Math.cos(b), ankleZ = kneeZ + 0.38 * Math.sin(b);
    const boot = box(0.17, 0.13, 0.28, 0, ankleY - 0.065, ankleZ - 0.035, BOOT);
    return merge([thigh, shin, boot]);
  };
  const set = { upper, legL: leg(), legR: leg(), legBent: legBent(), armsGun, armsKatana, armsKnife, armsOnly: armsOnly() };
  geoCache.set(team, set);
  return set;
}

const rigCache = new Map();
/**
 * 이모트용 관절 리그 부품(팀별). 각 부품의 원점 = 관절(피벗).
 * torso(엉덩이 피벗, 등에 맨 총 포함) · head(목) · upperArm(어깨) · foreArm(팔꿈치) · hand_fist/flat/L(손목) · thigh(엉덩이) · shin(무릎, 장화 포함)
 */
function rigGeometry(team) {
  if (rigCache.has(team)) return rigCache.get(team);
  const T = TEAMS[team] || TEAMS.owner;
  const suit = new THREE.Color(T.color).getHex();
  const accent = new THREE.Color(T.light).getHex();
  // 등에 비스듬히 맨 총(이모트 중에는 손을 비운다)
  const sling = gunGeo();
  sling.applyMatrix4(new THREE.Matrix4().makeRotationZ(0.75).multiply(new THREE.Matrix4().makeRotationY(Math.PI / 2)).setPosition(0, 0.3, 0.2));
  const L = RIG;
  const set = {
    torso: merge([torsoGeo(suit, accent), sling]),
    head: headGeo(accent),
    upperArm: merge([box(0.13, L.upperArm + 0.02, 0.14, 0, -L.upperArm / 2, 0, suit), box(0.135, 0.04, 0.145, 0, -0.2, 0, TAPE)]),
    foreArm: merge([box(0.12, L.foreArm + 0.02, 0.13, 0, -L.foreArm / 2, 0, suit)]),
    hand_fist: merge([box(0.11, 0.12, 0.12, 0, -0.06, 0, GLOVE)]),
    hand_flat: merge([box(0.1, 0.16, 0.04, 0, -0.08, 0, GLOVE)]),
    // 엄지·검지 'L': 검지는 손 방향(-Y)으로 길게, 엄지는 몸 안쪽(-X)으로
    hand_L: merge([box(0.1, 0.08, 0.06, 0, -0.04, 0, GLOVE), box(0.035, 0.11, 0.035, 0.03, -0.135, 0, GLOVE), box(0.09, 0.035, 0.035, -0.085, -0.03, 0, GLOVE)]),
    thigh: merge([box(0.17, L.thigh + 0.02, 0.2, 0, -L.thigh / 2, 0, suit)]),
    shin: merge([box(0.17, L.shin, 0.2, 0, -L.shin / 2, 0, suit), box(0.175, 0.045, 0.205, 0, -0.08, 0, TAPE), box(0.17, 0.13, 0.28, 0, -L.shin - 0.06, -0.035, BOOT)])
  };
  rigCache.set(team, set);
  return set;
}

/** 슬롯·무기 id → 팔 지오메트리 이름. 칼만 바꾸고 나머지(수류탄 포함)는 기본 총 */
function armsKeyOf(slot, weaponId) {
  const s = Number(slot);
  const melee = s === 3 || (!(s > 0) && typeof weaponId === 'string' && weaponId.startsWith('ml_'));
  if (!melee) return 'armsGun';
  return weaponId === 'ml_knife' ? 'armsKnife' : 'armsKatana';
}

let sharedMat = null;
function bodyMaterial() {
  if (!sharedMat) sharedMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  return sharedMat;
}

/* ---------------- 이름표 ---------------- */

function makeNameTexture(name, team) {
  const T = TEAMS[team] || TEAMS.owner;
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const g = c.getContext('2d');
  g.font = `700 30px ${FONT}`;
  const text = String(name || '').slice(0, 16);
  const tw = Math.min(236, g.measureText(text).width + 28);
  const x0 = (256 - tw) / 2;
  g.fillStyle = 'rgba(8,14,24,0.62)';
  g.beginPath();
  if (g.roundRect) g.roundRect(x0, 10, tw, 44, 12); else g.rect(x0, 10, tw, 44);
  g.fill();
  g.fillStyle = T.light;
  g.fillRect(x0 + 10, 47, tw - 20, 3);
  g.fillStyle = '#ffffff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 128, 31, 228);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/* ---------------- 아바타 ---------------- */

class Avatar {
  constructor(id, opts, mgr) {
    this.id = id;
    this.mgr = mgr;
    this.name = opts.name || String(id);
    this.team = TEAMS[opts.team] ? opts.team : 'charterer';
    this.buffer = new SnapshotBuffer({ maxExtrapolate: 150 });
    this.sample = { pos: [0, 0, 0], yaw: 0, pitch: 0, alive: true, moving: false };
    this.pos = [0, 0, 0];          // 화면(보간) 위치 = 히트박스 위치
    this.yaw = 0;
    this.pitch = 0;
    this.alive = true;
    this.visible = true;
    this.walkPhase = 0;
    this.walkAmp = 0;
    this.crouch = 0;               // 앉은 자세 비율 0..1 (0.12초 전환) — 히트박스도 이 값
    this.crouchTarget = false;
    this.emote = 0;                // 지금 이모트 번호(0 = 없음)
    this.emoteT = 0;               // 이모트 시작 뒤 경과(초)
    this.emoteW = 0;               // 리그 섞음 0..1 (0.15초 전환)
    this.lastEmote = 0;            // 끝난 뒤 되돌아오는 동안 쓰는 번호
    this.rig = null;               // 이모트 때만 만드는 관절 리그
    this.isLocal = false;          // 3인칭 때의 내 몸
    this.pose = makePose();
    this.blendPose = makePose();
    this.death = null;             // { t, dirX, dirZ }
    this.lastPos = null;
    this.data = opts.data || {};   // 자유 메타데이터(무기 등)
    this.armsKey = 'armsGun';      // 든 무기에 맞는 팔 지오메트리 이름
    this.root = new THREE.Group();
    this.root.name = 'avatar:' + id;
    this.body = new THREE.Group();  // 쓰러질 때 회전
    this.root.add(this.body);
    this.build();
    mgr.scene.add(this.root);
  }

  build() {
    const G = teamGeometry(this.team);
    const mat = bodyMaterial();
    const mk = (geo) => { const m = new THREE.Mesh(geo, mat); m.castShadow = true; return m; };
    this.body.clear();
    this.rig = null; // 팀이 바뀌면 리그도 새 색으로(다음 이모트 때 다시 만듦)
    this.hips = new THREE.Group(); this.hips.position.set(0, 0.95, 0);
    this.upper = new THREE.Group();          // 상체(조준 pitch로 살짝 젖힘/숙임)
    this.hips.add(this.upper);
    this.upper.add(mk(G.upper));
    this.armsPivot = new THREE.Group(); this.armsPivot.position.set(0, 0.5, 0); // 어깨선
    this.upper.add(this.armsPivot);
    this.arms = mk(this.held ? G.armsOnly : G[this.armsKey]);
    this.armsPivot.add(this.arms);
    this.hand = new THREE.Group(); this.hand.position.set(HAND[0], HAND[1], HAND[2]);
    this.armsPivot.add(this.hand);
    if (this.held) this.hand.add(this.held);
    this.legL = mk(G.legL); this.legL.position.set(-0.11, 0, 0); this.hips.add(this.legL);
    this.legR = mk(G.legR); this.legR.position.set(0.11, 0, 0); this.hips.add(this.legR);
    this.body.add(this.hips);
    // 이름표
    if (this.tag) { this.tag.material.map.dispose(); this.tag.material.dispose(); this.root.remove(this.tag); }
    const tex = makeNameTexture(this.name, this.team);
    const smat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: false });
    this.tag = new THREE.Sprite(smat);
    this.tag.scale.set(1.1, 0.275, 1);
    this.tag.position.set(0, 2.18, 0);
    this.tag.renderOrder = 10;
    this.root.add(this.tag);
    this.applyTagMode();
  }

  applyTagMode() {
    const ally = this.mgr.localTeam && this.mgr.localTeam === this.team;
    this.tag.material.depthTest = !ally;  // 아군은 벽 너머로도
    this.tag.userData.ally = ally;
  }

  setName(name) { if (name && name !== this.name) { this.name = String(name); this.build(); } }
  setTeam(team) { if (TEAMS[team] && team !== this.team) { this.team = team; this.build(); } }

  /** 이모트용 관절 리그 만들기(처음 이모트할 때 한 번) */
  buildRig() {
    const G = rigGeometry(this.team);
    const mat = bodyMaterial();
    const mk = (geo) => { const m = new THREE.Mesh(geo, mat); m.castShadow = true; return m; };
    const L = RIG;
    const r = { root: new THREE.Group(), G };
    r.hips = new THREE.Group(); r.root.add(r.hips);
    r.torso = new THREE.Group(); r.hips.add(r.torso); r.torso.add(mk(G.torso));
    r.head = new THREE.Group(); r.head.position.set(0, L.neckY, 0); r.torso.add(r.head); r.head.add(mk(G.head));
    for (const [k, s] of [['R', 1], ['L', -1]]) {
      const sh = new THREE.Group(); sh.position.set(L.shoulderX * s, L.shoulderY, 0); r.torso.add(sh); sh.add(mk(G.upperArm));
      const el = new THREE.Group(); el.position.set(0, -L.upperArm, 0); sh.add(el); el.add(mk(G.foreArm));
      const wr = new THREE.Group(); wr.position.set(0, -L.foreArm, 0); el.add(wr);
      const hand = mk(G.hand_fist); wr.add(hand);
      const hp = new THREE.Group(); hp.position.set(L.hipX * s, 0, 0); r.hips.add(hp); hp.add(mk(G.thigh));
      const kn = new THREE.Group(); kn.position.set(0, -L.thigh, 0); hp.add(kn); kn.add(mk(G.shin));
      r['shoulder' + k] = sh; r['elbow' + k] = el; r['wrist' + k] = wr; r['hand' + k] = hand; r['hip' + k] = hp; r['knee' + k] = kn;
    }
    r.root.visible = false;
    this.body.add(r.root);
    this.rig = r;
    return r;
  }

  /** 포즈(emoteanim 형식) → 리그 관절 */
  applyPose(p) {
    const r = this.rig;
    r.hips.position.set(p.x, RIG.hipY + p.y + p.air, p.z);
    r.hips.rotation.set(p.rx, p.ry, p.rz);
    r.torso.rotation.set(p.torso[0], p.torso[1], p.torso[2]);
    r.head.rotation.set(p.head[0], p.head[1], p.head[2]);
    for (const [k, s] of [['R', 1], ['L', -1]]) {
      const a = sideRot(p['arm' + k], s);
      r['shoulder' + k].rotation.set(a[0], a[1], a[2]);
      r['elbow' + k].rotation.set(p['fore' + k], 0, 0);
      const h = sideRot(p['hand' + k], s);
      r['wrist' + k].rotation.set(h[0], h[1], h[2]);
      const shape = p['shape' + k] === 'L' && k === 'R' ? 'L' : p['shape' + k] === 'flat' ? 'flat' : 'fist';
      const geo = r.G['hand_' + shape];
      if (r['hand' + k].geometry !== geo) r['hand' + k].geometry = geo;
      const l = sideRot(p['leg' + k], s);
      r['hip' + k].rotation.set(l[0], l[1], l[2]);
      r['knee' + k].rotation.set(-p['knee' + k], 0, 0);
    }
  }

  /** 이모트 상태 진행 + 리그/평소 몸 전환 (update에서 부름) */
  updateEmote(code, dt) {
    if (!this.alive || this.death) code = 0;
    if (code !== this.emote) {
      if (code) { this.emoteT = 0; this.lastEmote = code; } // 새 번호 → 처음부터
      this.emote = code;
    }
    if (this.emote || this.emoteW > 0) this.emoteT += dt;
    const target = this.emote ? 1 : 0;
    const step = dt / EMOTE_BLEND;
    this.emoteW = this.emoteW < target ? Math.min(target, this.emoteW + step) : Math.max(target, this.emoteW - step);
    if (this.death) this.emoteW = 0;
    if (this.emoteW > 0) {
      const r = this.rig || this.buildRig();
      const pose = sampleEmote(this.emote || this.lastEmote, this.emoteT, this.pose) || NEUTRAL;
      const w = this.emoteW * this.emoteW * (3 - 2 * this.emoteW);
      this.applyPose(lerpPose(NEUTRAL, pose, w, this.blendPose));
      if (!r.root.visible) { r.root.visible = true; this.hips.visible = false; }
      return true;
    }
    if (this.rig && this.rig.root.visible) { this.rig.root.visible = false; this.hips.visible = true; }
    return false;
  }

  /** 무기 담당의 3인칭 모델로 교체(null이면 기본 모양). obj는 손 소켓 기준(총구 = -Z) */
  setHeld(obj) {
    if (this.held) this.hand.remove(this.held);
    this.held = obj || null;
    if (this.held) this.hand.add(this.held);
    this.arms.geometry = teamGeometry(this.team)[this.held ? 'armsOnly' : this.armsKey];
  }

  /** 즉시 쓰러짐 (피 없음). dir: 쓰러질 방향 [x, z] (총알 진행 방향 등) */
  kill(opt = {}) {
    if (this.death) return;
    this.alive = false;
    let dx = 0, dz = 1;
    if (opt.dir) { dx = opt.dir[0]; dz = opt.dir[opt.dir.length === 3 ? 2 : 1]; }
    const l = Math.hypot(dx, dz) || 1;
    this.death = { t: 0, dirX: dx / l, dirZ: dz / l };
    this.tag.visible = false;
  }

  revive() {
    this.alive = true;
    this.death = null;
    this.crouch = 0;
    this.crouchTarget = false;
    this.emote = 0; this.emoteW = 0; this.emoteCode = 0;
    if (this.rig) { this.rig.root.visible = false; this.hips.visible = true; }
    this.body.rotation.set(0, 0, 0);
    this.body.position.set(0, 0, 0);
    this.tag.visible = true;
  }

  update(renderTime, dt) {
    const s = this.buffer.sample(renderTime, this.sample);
    if (s) {
      this.pos[0] = s.pos[0]; this.pos[1] = s.pos[1]; this.pos[2] = s.pos[2];
      this.yaw = s.yaw; this.pitch = s.pitch || 0;
      if (s.alive === false && !this.death) this.kill({ dir: s.deathDir || null });
      else if (s.alive !== false && this.death && this.death.t > 0.05 && s.respawned) this.revive();
      if (s.name && s.name !== this.name) this.setName(s.name);
      if (s.team && s.team !== this.team && TEAMS[s.team]) this.setTeam(s.team);
      this.crouchTarget = !!s.crouch && s.alive !== false;
      const ec = typeof s.emote === 'number' ? s.emote | 0 : s.emote ? ((emoteById(s.emote) || {}).code || 0) : 0;
      this.emoteCode = ec;
      const key = armsKeyOf(s.slot, s.weaponId);
      if (key !== this.armsKey) {
        this.armsKey = key;
        if (!this.held) this.arms.geometry = teamGeometry(this.team)[key];
      }
    }
    // 앉기 자세 전환
    const ct = this.crouchTarget ? 1 : 0, cstep = dt / PLAYER.CROUCH_TIME;
    if (!this.death) this.crouch = this.crouch < ct ? Math.min(ct, this.crouch + cstep) : Math.max(ct, this.crouch - cstep);
    const ck = this.crouch * this.crouch * (3 - 2 * this.crouch);
    this.root.position.set(this.pos[0], this.pos[1], this.pos[2]);
    this.root.rotation.y = this.yaw;

    // 걷기 애니메이션: 실제 이동 거리로 위상 진행
    let speed = 0;
    if (this.lastPos && dt > 0) speed = Math.hypot(this.pos[0] - this.lastPos[0], this.pos[2] - this.lastPos[2]) / dt;
    if (!this.lastPos) this.lastPos = [0, 0, 0];
    this.lastPos[0] = this.pos[0]; this.lastPos[1] = this.pos[1]; this.lastPos[2] = this.pos[2];
    speed = Math.min(speed, 8);
    const moving = this.alive && speed > 0.35;
    this.walkAmp += ((moving ? Math.min(1, speed / 5) : 0) - this.walkAmp) * Math.min(1, dt * 10);
    this.walkPhase += speed * dt * 3.9;
    const sw = Math.sin(this.walkPhase) * (0.62 - 0.4 * ck) * this.walkAmp;
    this.legL.rotation.x = sw;
    this.legR.rotation.x = -sw;
    // 엉덩이: 서 있으면 0.95 / 앉으면 0.51로 낮추고 뒤로. 다리는 반쯤 앉으면 굽은 모양으로 바꾸고, 발이 바닥에 닿게 늘이고 줄인다
    const hipY = STAND_HIP + (SQUAT.hipY - STAND_HIP) * ck;
    this.hips.position.set(0, hipY + Math.abs(Math.cos(this.walkPhase)) * 0.025 * this.walkAmp * (1 - ck), SQUAT.hipZ * ck);
    const bent = ck >= 0.5;
    const G = teamGeometry(this.team);
    const legGeo = bent ? G.legBent : null;
    if (this.legL.geometry !== (legGeo || G.legL)) { this.legL.geometry = legGeo || G.legL; this.legR.geometry = legGeo || G.legR; }
    const ls = hipY / (bent ? SQUAT.hipY : STAND_HIP);
    this.legL.scale.y = this.legR.scale.y = ls;
    // 총을 든 자세 + 조준 pitch (상체가 조금, 팔·총이 더). 앉으면 상체를 숙이고 팔은 그만큼 들어 총을 수평으로
    const aim = Math.max(-0.9, Math.min(0.9, this.pitch));
    this.upper.rotation.x = aim * 0.35 - SQUAT.lean * ck;
    this.armsPivot.rotation.x = aim * 0.6 + sw * 0.03 + SQUAT.lean * ck;
    this.tag.position.y = 2.18 - 0.5 * ck;
    // 이모트: 번호가 있으면 관절 리그로 재생(평소 메시는 숨김)
    this.updateEmote(this.emoteCode | 0, dt);

    // 쓰러짐: 발을 축으로 총알 방향으로 넘어짐
    if (this.death) {
      const d = this.death;
      d.t = Math.min(1, d.t + dt / 0.65);
      const k = d.t * d.t; // 가속하며 넘어짐
      const ang = k * (Math.PI / 2) * 0.96;
      // 월드 방향 → 로컬(아바타 yaw 기준)
      const cy = Math.cos(-this.yaw), sy = Math.sin(-this.yaw);
      const lx = d.dirX * cy + d.dirZ * sy, lz = -d.dirX * sy + d.dirZ * cy;
      this.body.rotation.set(lz * ang, 0, -lx * ang);
      this.body.position.y = Math.sin(ang) * 0.12;
      this.walkAmp = 0;
    }

    // 이름표: 적은 35 m 넘으면 숨김
    if (this.tag.visible !== (this.alive && this.visible)) this.tag.visible = this.alive && this.visible;
    if (this.tag.visible && !this.tag.userData.ally && this.mgr.camera) {
      const cp = this.mgr.camera.position;
      const dist = Math.hypot(cp.x - this.pos[0], cp.z - this.pos[2]);
      this.tag.visible = dist < 35;
    }
    if (this.isLocal) this.tag.visible = false;
    this.root.visible = this.visible;
  }

  dispose() {
    this.mgr.scene.remove(this.root);
    if (this.tag) { this.tag.material.map.dispose(); this.tag.material.dispose(); }
  }
}

export function createAvatars({ scene, camera, delay = NET.INTERP_DELAY_MS } = {}) {
  const map = new Map();
  const mgr = { scene, camera, localTeam: null };
  let interpDelay = delay;
  let lastNow = 0;
  let local = null; // 3인칭(이모트) 때 보이는 내 몸 — 히트 대상·목록에는 넣지 않는다
  let warmGroup = null;

  /**
   * 미리 준비용 묶음: 두 팀의 평소 몸(4종+앉은 다리)과 이모트 리그 부품(손 모양 3종 포함) 메시.
   * 지오메트리·재질은 실제 아바타와 공유하므로 한 번 그리면 GPU 버퍼·셰이더·그리기 상태가 모두 준비된다.
   * 화면 아래 멀리(y −1000)에 두고 frustumCulled=false라 보이지 않게 그려진다(그림자 패스 포함).
   */
  function getWarmGroup() {
    if (warmGroup) return warmGroup;
    const g = new THREE.Group();
    g.name = 'avatars:prewarm';
    const mat = bodyMaterial();
    for (const team of TEAM_IDS) {
      const T = teamGeometry(team), R = rigGeometry(team);
      for (const geo of [T.upper, T.legL, T.legR, T.legBent, T.armsGun, T.armsKatana, T.armsKnife, T.armsOnly, ...Object.values(R)]) {
        const m = new THREE.Mesh(geo, mat);
        m.frustumCulled = false;
        m.castShadow = true;
        m.position.set(0, -1000, 0);
        g.add(m);
      }
    }
    warmGroup = g;
    return g;
  }

  function add(id, opts = {}) {
    let a = map.get(id);
    if (a) {
      if (opts.name) a.setName(opts.name);
      if (opts.team) a.setTeam(opts.team);
      return a;
    }
    a = new Avatar(id, opts, mgr);
    map.set(id, a);
    return a;
  }

  function remove(id) {
    const a = map.get(id);
    if (!a) return;
    a.dispose();
    map.delete(id);
  }

  return {
    add,
    remove,
    get: (id) => map.get(id) || null,
    has: (id) => map.has(id),
    list: () => Array.from(map.values()),
    get size() { return map.size; },
    clear() { for (const id of Array.from(map.keys())) remove(id); },
    /** 스냅샷 넣기. 아바타가 없으면 자동 생성 */
    push(id, t, state) {
      const a = map.get(id) || add(id, { name: state && state.name, team: state && state.team });
      a.buffer.push(t, state);
      return a;
    },
    /** 순간이동(보간 없이) — 스폰 등 */
    teleport(id, state, t = performance.now()) {
      const a = map.get(id);
      if (!a) return;
      a.buffer.clear();
      a.buffer.push(t - 1000, state);
      a.buffer.push(t, state);
      a.lastPos = null;
      if (state && state.alive !== false) a.revive();
    },
    update(now = performance.now(), dt = 0) {
      lastNow = now;
      const rt = now - interpDelay;
      for (const a of map.values()) a.update(rt, dt);
      if (local && local.visible) local.update(0, dt);
    },
    /**
     * 3인칭(이모트) 때 내 몸을 그린다. player.getBodyState()를 매 프레임 그대로 넘기면 된다(core main.js가 함).
     * { visible, pos:[x,y,z](보간된 화면 위치), yaw, pitch, team, name, emote(번호), crouch, slot?, weaponId? }. visible:false면 숨김.
     */
    setLocalBody(o) {
      if (!o || !o.visible) {
        if (local && local.visible) { local.visible = false; local.root.visible = false; }
        return;
      }
      const team = TEAMS[o.team] ? o.team : 'owner';
      if (!local) { local = new Avatar('__local', { name: o.name || '', team }, mgr); local.isLocal = true; local.tag.visible = false; }
      else if (team !== local.team) local.setTeam(team);
      local.visible = true;
      local.buffer.clear();
      local.buffer.push(0, { pos: [o.pos[0], o.pos[1], o.pos[2]], yaw: o.yaw || 0, pitch: o.pitch || 0, alive: true, crouch: !!o.crouch, emote: o.emote | 0, slot: o.slot, weaponId: o.weaponId });
    },
    /**
     * 맵 로드 때 부른다: 준비용 메시를 장면에 넣고 fn()(예: compileAsync + 한 번 그리기)을 기다린 뒤 뺀다.
     * → 첫 이모트·처음 보는 팀 아바타가 나올 때 셰이더 컴파일·버퍼 업로드로 끊기지 않는다.
     */
    async prewarm(fn) {
      const g = getWarmGroup();
      scene.add(g);
      try { if (fn) await fn(g); }
      finally { scene.remove(g); }
      return g.children.length;
    },
    /** 품질(그림자 켬·끔)이 바뀐 뒤: 셰이더만 다시 준비(그리지 않음). three r170 compile(object, camera, targetScene) */
    compileWarm(three, cam) {
      const g = getWarmGroup();
      scene.add(g);
      try { if (three && three.compile) three.compile(g, cam || mgr.camera, scene); }
      catch (err) { /* 미지원 */ }
      finally { scene.remove(g); }
    },
    /** 내 몸 아바타(없으면 null) */
    get localBody() { return local; },
    /** raycastPlayers 대상 — 화면에 보이는(보간된) 위치·방향과 같다 */
    getTargets(out = []) {
      out.length = 0;
      for (const a of map.values()) {
        if (!a.alive || !a.visible) continue;
        out.push({ id: a.id, pos: a.pos, yaw: a.yaw, alive: true, crouch: a.crouch, team: a.team, name: a.name });
      }
      return out;
    },
    setLocalTeam(team) {
      mgr.localTeam = team;
      for (const a of map.values()) a.applyTagMode();
    },
    setCamera(cam) { mgr.camera = cam; },
    setDelay(ms) { interpDelay = Math.max(0, +ms || 0); },
    get delay() { return interpDelay; },
    get lastUpdate() { return lastNow; },
    HITBOX,
    lerpAngle,
    dispose() {
      for (const id of Array.from(map.keys())) remove(id);
      if (local) { local.dispose(); local = null; }
    }
  };
}
