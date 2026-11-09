/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 원격 아바타(저폴리 인물: 전술 헬멧 + 전투복 + 조끼, 블루 팀 남색 / 오렌지 팀 주황). 총·칼을 든 평소 몸, 앉기, 이모트 리그를 그린다.
 */

/*
 *   const avatars = createAvatars({ scene, camera });
 *   avatars.add(id, { name, team, avatar })  // 이미 있으면 갱신. avatar = 캐릭터 id(core/avatar-defs.js), 모르는 값은 기본 캐릭터
 *   avatars.push(id, t, state)               // 스냅샷 { pos:[x,y,z], yaw, pitch, moving, walking, crouch, alive, slot, weaponId, ... }, t = ms
 *   avatars.update(now, dt)                  // 매 프레임: now − delay(100 ms) 시점으로 보간 → 메시·히트박스 갱신
 *   avatars.getTargets()                     // raycastPlayers용 [{ id, pos, yaw, alive, crouch(0..1), team, name }] (보간된 화면 위치·자세)
 *   avatars.get(id).kill({ dir:[x,z] }) / .revive() / .setHeld(object3d) / .setName() / .setTeam() / .setAvatar(id)
 *   avatars.setLocalTeam(team)               // 아군 이름표는 벽 너머로도 보임
 *   avatars.setLocalBody({ visible, pos, yaw, team, name, emote, crouch, slot, weaponId, avatar })  // 3인칭(이모트) 때 내 몸 (player.getBodyState())
 *   avatars.remove(id) / clear() / dispose()
 *   await avatars.prewarm(fn)                // 맵 로드 때: 모든 캐릭터 × 두 팀의 평소 몸·앉은 다리·이모트 리그 부품을 장면에 잠깐 넣고 fn(컴파일·한 번 그리기)
 *   avatars.compileWarm(webglRenderer, camera) // 그림자 켬·끔 등 품질이 바뀐 뒤 셰이더만 다시 준비
 *   createAvatarPortraits(webglRenderer).get(id, team) → 'data:image/png…' | null   // 상점·마이페이지 초상(게임 렌더러로 한 번씩 그려 둔다)
 *
 * 캐릭터(core/avatar-defs.js): 몸 치수·히트박스는 모두 같고 머리 장비·조끼·부착물만 다르다(STYLES). 전투복(팀 color)과 표식·완장(팀 light)은
 *   팀 색이라 어느 캐릭터든 팀이 잘 보인다. 개인전은 world가 다른 사람을 모두 한 팀 색으로 넘기므로 '적은 한 가지 색'도 그대로다.
 *   부품은 캐릭터×팀마다 한 번 굽고 메시 수는 그대로다(평소 4개, 이모트 중 12개) → 캐릭터를 바꿔도 draw call이 늘지 않는다.
 *
 * 든 무기: state.slot === 3이면 총 대신 칼(카타나·구르카는 제 모양, 그 밖은 나이프). 슬롯 없이 weaponId가 'ml_'로 시작해도 칼이다.
 * avatar.swing(kind)는 칼을 휘두르는 동작을 시작한다. 'stab'은 앞으로 내지르고, 나머지는 좌우를 번갈아 벤다.
 *   메시를 늘리지 않고 팔 메시의 지오메트리만 바꾼다(아바타당 메시 4개 유지). 수류탄 등 나머지는 기본 총.
 *   칼을 들어도 두 손 위치는 총을 든 자세와 같아서 손 히트박스(consts HITBOX.HANDS)가 그대로 맞는다.
 *
 * 이모트(MODES.md 4.5): 스냅샷 emote(번호 1~15, 0 = 없음)가 오면 그때만 관절 리그(몸통·머리·위팔·아래팔·손·허벅지·정강이,
 *   메시 12개)로 바꿔 engine/emoteanim.js의 키프레임을 처음부터 재생한다(반복형은 계속). 0이 되면 0.15초 만에 평소 자세로
 *   돌아와 평소 메시 4개로 되돌린다 → 평소 draw call은 늘지 않는다. 히트박스는 이모트 중에도 서 있는 그대로.
 *   리그에도 캐릭터 부품이 그대로 붙는다(머리 장비는 머리, 어깨 보호대는 위팔, 무릎 보호대는 정강이).
 * 모델 좌표: 발바닥 원점, 정면 = 로컬 -Z (yaw 0이면 -Z를 봄). 히트박스(consts HITBOX)와 같은 치수.
 * 앉기: state.crouch → 0.12초에 걸쳐 쪼그려 앉은 자세(엉덩이를 뒤로 낮추고 무릎 굽힘, 상체 앞으로)
 *       머리 중심 ≈ 1.13 m = HITBOX_CROUCH.HEAD. getTargets().crouch가 같은 비율이라 히트박스도 자세와 맞는다.
 */
import * as THREE from 'three';
import { TEAMS, TEAM_IDS, NET, HITBOX, PLAYER, EMOTE_BLEND, emoteById } from '../core/consts.js';
import { AVATAR_IDS, DEFAULT_AVATAR, avatarIdOf } from '../core/avatar-defs.js';
import { SnapshotBuffer, lerpAngle } from './interp.js';
import { RIG, NEUTRAL, makePose, lerpPose, sampleEmote, sideRot } from './emoteanim.js';

const FONT = "'Pretendard','Noto Sans KR','Malgun Gothic','Apple SD Gothic Neo',system-ui,sans-serif";
const TAU = Math.PI * 2;

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
const place = (g, x, y, z, rx = 0, ry = 0, rz = 0) => {
  const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(1, 1, 1));
  g.applyMatrix4(m);
  return g;
};
/** 돌린 상자: (x,y,z)에 놓고 자기 중심으로 rx·ry·rz만큼 돌린다 */
const rbox = (w, h, d, x, y, z, rx, ry, rz, hex) => place(box(w, h, d, 0, 0, 0, hex), x, y, z, rx, ry, rz);
/** 부품 묶음을 한 덩어리로 놓는다(묶음 원점 기준 회전) */
const group = (parts, x, y, z, rx = 0, ry = 0, rz = 0) => place(merge(parts), x, y, z, rx, ry, rz);
/** 세운 원기둥(위·아래 반지름이 다를 수 있다). t0·tl로 일부만 두르면 그 사이가 트인다(0 = 뒤 +Z, π = 앞 -Z) */
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
/** a에서 b까지 이어진 가는 막대(안테나·마이크 대). 옆 방향을 X축으로 정하므로 X축과 나란한 막대에는 쓰지 말 것 */
function rod(a, b, t, hex) {
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const len = Math.hypot(d[0], d[1], d[2]);
  const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  return aimGeo(box(t, t, len, 0, 0, 0, hex), mid, d, [1, 0, 0]);
}

/** 손(무기 소켓) 위치: 어깨 피벗 기준 */
const HAND = [0.1, -0.22, -0.32];
/** 앉은 자세: 허벅지 앞으로 α, 정강이 뒤로 β, 엉덩이 높이·뒤로 뺀 거리, 상체 숙임 */
const SQUAT = { thigh: 1.35, shin: 0.75, hipY: 0.51, hipZ: 0.2, lean: 0.4 };
const STAND_HIP = 0.95;
/** 오른손 장갑 중심(어깨 피벗 기준). consts HITBOX.HANDS는 이 자세에서 계산한다(서 있을 때 y = 1.45 + 아래 y) */
const HAND_R = [0.2442, -0.1722, -0.5181];
const SKIN = 0xd9a77e, NOSE = 0xc28f6a, BOOT = 0x2b2622, GLOVE = 0x3a3a36, TAPE = 0x33363a, BELT = 0x25211d, EYES = 0x1c1a18, GUN = 0x2c3034;
const HELMET = 0x3c4038, HELMET_DK = 0x24262a, VEST = 0x2f322e, POUCH = 0x3b3e38;
const STEEL = 0xc9d2da, STEEL_DK = 0x6f7884, WRAP = 0x4a1525, BRASS = 0x8f7038;

/* ---------------- 캐릭터 부품 ----------------
 * 좌표: head = 목 피벗(서 있으면 1.50 m) 기준, 위로. 머리 상자 0.22×0.25×0.24(중심 0.12 = 히트박스 머리 1.62).
 *       torso = 엉덩이 피벗(0.95 m) 기준. 몸통 0.5×0.56×0.3(y 0~0.55), 정면 -Z.
 *       shoulder = 어깨 피벗(몸통 기준 ±0.31, 0.5). 평소 몸은 몸통에, 리그는 위팔에 붙인다. s = 1 오른쪽 / -1 왼쪽(바깥 = s·X).
 *       arm = 곧게 편 팔(어깨 피벗, 아래로 -Y). upper는 0~-0.3(위팔), fore는 그 아래(아래팔). 리그는 fore를 위팔 길이만큼 올린다.
 *       leg = 곧게 편 다리(엉덩이 피벗, 아래로). thigh는 0~-0.45, shin은 그 아래(무릎 -0.45). 리그·앉은 다리는 shin을 무릎 기준으로 옮긴다.
 * c: { suit(팀 color), accent(팀 light), tint(hex, k)(팀 색을 k만큼 섞음), glove, boot, neck, sleeve }
 * 머리 장비는 히트박스 머리 구(반지름 0.14) 둘레에서 크게 벗어나지 않게 한다. 실루엣을 줄이거나 머리를 가리지 않는다.
 */

/** 맨얼굴 머리. bevel이면 윗모서리를 깎아 모자·헬멧 안에 숨는다(모서리가 밖으로 비치지 않게) */
function face({ skin = SKIN, bevel = false } = {}) {
  const head = bevel
    ? [box(0.22, 0.2, 0.24, 0, 0.095, 0, skin), box(0.19, 0.05, 0.21, 0, 0.22, 0, skin)]
    : [box(0.22, 0.25, 0.24, 0, 0.12, 0, skin)];             // 머리 (히트박스 구 중심 1.62)
  return [
    ...head,
    box(0.05, 0.04, 0.03, 0, 0.07, -0.13, NOSE),             // 코
    box(0.04, 0.018, 0.012, -0.05, 0.125, -0.122, EYES),     // 눈
    box(0.04, 0.018, 0.012, 0.05, 0.125, -0.122, EYES)
  ];
}
/** 위팔 팀 완장 */
const armband = (c, y = -0.1) => box(0.137, 0.05, 0.147, 0, y, 0, c.accent);

// 정찰병
const HOOD = 0x4d5547, HOOD_IN = 0x262b25, GOGGLE = 0x1e2124, AMBER = 0xd9932e, RIG_G = 0x3d4438, RIG_G_DK = 0x2a2f28, BINO = 0x232628, LENS_DK = 0x5d7a8c;
// 공병
const HARDHAT = 0xe2dfd3, HARDHAT_DK = 0xb9b5a6, MUFF = 0x2b2e33, LAMP = 0x6f757c, LAMP_LENS = 0xfff1b8, WORKVEST = 0x3b3f35, WORKVEST_DK = 0x2b2e27;
const REFLECT = 0xc9cfd4, TOOLBELT = 0x5b4127, TOOLBELT_DK = 0x3e2c1b, WRENCH = 0x9aa3ad, KNEE = 0x26282b;
// 통신병
const CAP = 0x434a3c, CAP_DK = 0x2f352a, HEADSET = 0x1f2226, MIC = 0x2b2f33, SIGVEST = 0x353b30, STRAP = 0x25291f;
const RADIO = 0x39402f, RADIO_DK = 0x262b22, ANTENNA = 0x161819, KNOB = 0x8c9196, LED = 0x6ef08a;
// 사막 레인저
const BOONIE = 0xb89d6c, SHADES = 0x14171a, SCARF = 0xcdb68b, SCARF_DK = 0x8e714a, RIG_S = 0x9d8b63, RIG_S_DK = 0x7d6c49, CANTEEN = 0x5c6650, CANTEEN_DK = 0x2e332a;
// 야간 작전병
const BALA = 0x17191c, BUMP = 0x2b2e32, BUMP_DK = 0x1b1d20, NVG = 0x2c3035, NVG_LENS = 0x63ff8f, PLATE = 0x1e2023, PLATE_LT = 0x2a2c30;
// 중장갑병
const ARMOR = 0x4c5359, ARMOR_DK = 0x353b40, ARMOR_LT = 0x5f676e, VISOR = 0x1a2833, VISOR_HI = 0x4f8fb8;

/** 올려 둔 야간 투시경(앞 -Z = 대물렌즈) */
function nvgParts() {
  return [
    cylZ(0.021, 0.085, 10, -0.032, 0, 0, NVG), cylZ(0.021, 0.085, 10, 0.032, 0, 0, NVG),
    cylZ(0.017, 0.008, 10, -0.032, 0, -0.045, NVG_LENS), cylZ(0.017, 0.008, 10, 0.032, 0, -0.045, NVG_LENS),
    box(0.05, 0.028, 0.05, 0, 0, 0.015, NVG)
  ];
}
/** 중장갑병 판 색: 회색에 팀 색을 조금 섞는다(팀이 더 잘 보이게) */
const heavyTone = (c) => ({ plate: c.tint(ARMOR, 0.24), dark: c.tint(ARMOR_DK, 0.2), light: c.tint(ARMOR_LT, 0.24) });

const STYLES = Object.freeze({
  // 보병(기본): 전술 헬멧 + 방탄 조끼
  av_trooper: {
    head: (c) => [
      ...face(),
      shell(0.15, 14, 8, 0, TAU, 0, Math.PI * 0.56, 1, 0.84, 1.1, 0, 0.175, 0.006, HELMET),   // 헬멧(무채색)
      box(0.022, 0.05, 0.17, 0.149, 0.145, 0.006, HELMET_DK),     // 옆 레일
      box(0.022, 0.05, 0.17, -0.149, 0.145, 0.006, HELMET_DK),
      box(0.012, 0.022, 0.1, 0.161, 0.145, 0.006, c.accent),      // 팀 색 줄
      box(0.012, 0.022, 0.1, -0.161, 0.145, 0.006, c.accent),
      box(0.09, 0.045, 0.024, 0, 0.222, -0.158, HELMET_DK),       // 앞쪽 장착대
      box(0.2, 0.014, 0.012, 0, 0.012, -0.112, HELMET_DK)         // 턱끈
    ],
    torso: (c) => [
      box(0.42, 0.36, 0.33, 0, 0.31, 0, VEST),                    // 방탄 조끼
      box(0.11, 0.11, 0.03, -0.12, 0.2, -0.17, POUCH),            // 탄창 주머니
      box(0.11, 0.11, 0.03, 0.12, 0.2, -0.17, POUCH),
      box(0.1, 0.06, 0.02, -0.11, 0.42, -0.17, c.accent),         // 가슴 팀 표식
      box(0.16, 0.16, 0.06, 0.12, 0.08, 0.18, 0x3b3b3b)           // 허리 주머니(뒤)
    ]
  },

  // 정찰병: 앞이 트인 후드 + 이마에 올린 고글, 가벼운 가슴 조끼, 배 앞의 쌍안경, 오른 허벅지 주머니
  av_scout: {
    glove: 0x34372f,
    boot: 0x3a3127,
    head: (c) => {
      const open = 0.78, t0 = Math.PI + open, tl = TAU - 2 * open;   // 얼굴 트임 반각
      return [
        ...face({ bevel: true }),
        cyl(0.166, 0.176, 0.24, 14, 0, 0.1, 0.012, HOOD, true, t0, tl),               // 후드 옆·뒤
        flipped(cyl(0.159, 0.169, 0.24, 14, 0, 0.1, 0.012, HOOD_IN, true, t0, tl)),   // 안감
        shell(0.169, 14, 5, 0, TAU, 0, Math.PI / 2, 1, 0.6, 1, 0, 0.22, 0.012, HOOD), // 후드 윗부분
        cyl(0.19, 0.205, 0.06, 14, 0, -0.005, 0.03, HOOD),                           // 목둘레
        cyl(0.167, 0.167, 0.022, 14, 0, 0.245, 0.012, GOGGLE, true),                  // 고글 끈
        group([
          box(0.07, 0.048, 0.03, -0.04, 0, 0, GOGGLE), box(0.07, 0.048, 0.03, 0.04, 0, 0, GOGGLE),
          box(0.056, 0.034, 0.012, -0.04, 0, -0.016, AMBER), box(0.056, 0.034, 0.012, 0.04, 0, -0.016, AMBER),
          box(0.02, 0.016, 0.02, 0, 0, 0, GOGGLE)
        ], 0, 0.25, -0.166, 0.35)                                                     // 이마에 올린 고글
      ];
    },
    torso: (c) => [
      box(0.4, 0.24, 0.05, 0, 0.35, -0.165, RIG_G),               // 가슴 조끼 앞판
      box(0.4, 0.05, 0.315, 0, 0.25, 0, RIG_G_DK),                // 조끼 허리끈
      box(0.06, 0.02, 0.33, -0.13, 0.555, 0, RIG_G),              // 어깨끈
      box(0.06, 0.02, 0.33, 0.13, 0.555, 0, RIG_G),
      box(0.085, 0.1, 0.04, -0.105, 0.33, -0.205, RIG_G_DK),      // 탄창 주머니
      box(0.085, 0.1, 0.04, 0, 0.33, -0.205, RIG_G_DK),
      box(0.085, 0.1, 0.04, 0.105, 0.33, -0.205, RIG_G_DK),
      box(0.1, 0.05, 0.02, -0.11, 0.43, -0.2, c.accent),          // 가슴 팀 표식
      cylZ(0.03, 0.1, 10, -0.034, 0.17, -0.205, BINO),            // 쌍안경
      cylZ(0.03, 0.1, 10, 0.034, 0.17, -0.205, BINO),
      box(0.035, 0.03, 0.07, 0, 0.18, -0.205, BINO),
      cylZ(0.024, 0.01, 10, -0.034, 0.17, -0.258, LENS_DK),
      cylZ(0.024, 0.01, 10, 0.034, 0.17, -0.258, LENS_DK),
      box(0.26, 0.3, 0.05, 0, 0.3, 0.175, HOOD)                   // 등 물주머니
    ],
    arm: (c) => ({ upper: [armband(c)], fore: [] }),
    leg: (c, s) => ({ thigh: s > 0 ? [box(0.05, 0.13, 0.14, 0.105, -0.25, 0, RIG_G_DK)] : [], shin: [] })
  },

  // 공병: 흰 안전모(가운데 골·챙) + 귀마개 + 헤드램프, 반사띠 작업 조끼, 공구 벨트·렌치, 무릎 보호대
  av_sapper: {
    glove: 0x6b5236,
    boot: 0x4a3523,
    head: (c) => {
      const brim = new THREE.CylinderGeometry(0.2, 0.2, 0.016, 18);
      brim.scale(1, 1, 1.12);
      brim.translate(0, 0.19, -0.018);
      return [
        ...face({ bevel: true }),
        shell(0.158, 14, 7, 0, TAU, 0, Math.PI / 2, 1, 0.86, 1.07, 0, 0.19, 0.004, HARDHAT),      // 안전모
        colored(brim, HARDHAT),                                                                 // 챙(앞이 조금 길다)
        shell(0.158, 10, 6, 0, TAU, 0, Math.PI / 2, 0.12, 0.92, 1.1, 0, 0.19, 0.004, HARDHAT_DK), // 가운데 골
        box(0.012, 0.03, 0.12, 0.152, 0.235, 0.004, c.accent),      // 팀 색 줄
        box(0.012, 0.03, 0.12, -0.152, 0.235, 0.004, c.accent),
        cylX(0.052, 0.045, 12, 0.133, 0.1, 0.01, MUFF),             // 귀마개
        cylX(0.052, 0.045, 12, -0.133, 0.1, 0.01, MUFF),
        box(0.014, 0.1, 0.03, 0.15, 0.15, 0.01, MUFF),
        box(0.014, 0.1, 0.03, -0.15, 0.15, 0.01, MUFF),
        box(0.06, 0.042, 0.032, 0, 0.237, -0.168, LAMP),            // 헤드램프
        cylZ(0.016, 0.008, 10, 0, 0.237, -0.187, LAMP_LENS)
      ];
    },
    torso: (c) => [
      box(0.42, 0.36, 0.33, 0, 0.31, 0, WORKVEST),                // 작업 조끼
      box(0.425, 0.03, 0.335, 0, 0.23, 0, REFLECT),               // 반사띠
      box(0.425, 0.03, 0.335, 0, 0.385, 0, REFLECT),
      box(0.1, 0.06, 0.02, -0.11, 0.445, -0.17, c.accent),        // 가슴 팀 표식
      box(0.1, 0.07, 0.025, 0.11, 0.305, -0.172, WORKVEST_DK),    // 가슴 주머니
      box(0.56, 0.08, 0.35, 0, 0, 0, TOOLBELT),                   // 공구 벨트
      box(0.09, 0.13, 0.11, 0.255, -0.06, -0.05, TOOLBELT_DK),    // 공구 주머니
      box(0.09, 0.13, 0.11, -0.255, -0.06, -0.05, TOOLBELT_DK),
      box(0.012, 0.17, 0.024, 0.306, -0.09, -0.05, WRENCH),       // 렌치
      box(0.016, 0.034, 0.064, 0.306, 0, -0.05, WRENCH)
    ],
    arm: (c) => ({ upper: [armband(c)], fore: [] }),
    leg: () => ({ thigh: [], shin: [box(0.19, 0.13, 0.07, 0, -0.45, -0.1, KNEE), box(0.195, 0.025, 0.21, 0, -0.45, 0, KNEE)] })
  },

  // 통신병: 정찰모 + 헤드셋·마이크, 조끼, 등에 멘 무전기와 긴 안테나
  av_signal: {
    sling: [0, 0.3, 0.3],
    head: (c) => [
      ...face({ bevel: true }),
      cyl(0.152, 0.164, 0.11, 14, 0, 0.25, 0.006, CAP),            // 정찰모
      rbox(0.21, 0.014, 0.09, 0, 0.2, -0.19, 0.14, 0, 0, CAP_DK),  // 챙
      box(0.06, 0.035, 0.01, 0, 0.255, -0.157, c.accent),          // 모자 팀 표식
      cylX(0.055, 0.045, 12, 0.133, 0.105, 0.012, HEADSET),        // 헤드셋
      cylX(0.055, 0.045, 12, -0.133, 0.105, 0.012, HEADSET),
      box(0.016, 0.2, 0.024, 0.164, 0.2, 0.012, HEADSET),
      box(0.016, 0.2, 0.024, -0.164, 0.2, 0.012, HEADSET),
      box(0.344, 0.016, 0.024, 0, 0.307, 0.012, HEADSET),
      rod([-0.128, 0.07, -0.025], [-0.055, 0.045, -0.142], 0.013, MIC),   // 마이크
      box(0.03, 0.024, 0.028, -0.052, 0.044, -0.148, MIC)
    ],
    torso: (c) => [
      box(0.42, 0.36, 0.33, 0, 0.31, 0, SIGVEST),                 // 조끼
      box(0.11, 0.11, 0.03, -0.12, 0.2, -0.17, POUCH),
      box(0.11, 0.11, 0.03, 0.12, 0.2, -0.17, POUCH),
      box(0.1, 0.06, 0.02, -0.11, 0.42, -0.17, c.accent),         // 가슴 팀 표식
      box(0.05, 0.02, 0.36, -0.12, 0.555, 0.03, STRAP),           // 무전기 멜빵
      box(0.05, 0.02, 0.36, 0.12, 0.555, 0.03, STRAP),
      box(0.3, 0.36, 0.1, 0, 0.3, 0.215, RADIO),                  // 등에 멘 무전기
      box(0.31, 0.04, 0.105, 0, 0.14, 0.215, RADIO_DK),
      box(0.13, 0.08, 0.012, 0.045, 0.39, 0.27, RADIO_DK),
      cylZ(0.018, 0.02, 8, -0.08, 0.41, 0.272, KNOB),
      cylZ(0.018, 0.02, 8, -0.08, 0.34, 0.272, KNOB),
      box(0.016, 0.016, 0.008, 0.1, 0.43, 0.271, LED),
      box(0.034, 0.06, 0.034, -0.11, 0.505, 0.235, RADIO_DK),     // 안테나 받침
      rod([-0.11, 0.53, 0.235], [-0.11, 1.03, 0.3], 0.02, ANTENNA),
      box(0.03, 0.03, 0.03, -0.11, 1.03, 0.3, ANTENNA)            // 안테나 끝
    ],
    arm: (c) => ({ upper: [armband(c)], fore: [] })
  },

  // 사막 레인저: 챙 넓은 모자(팀 색 띠) + 선글라스, 목에 두른 스카프, 모래색 가슴 조끼, 수통, 걷어 올린 소매
  av_ranger: {
    glove: 0x7a6545,
    boot: 0x8b7350,
    sleeve: SKIN,
    head: (c) => [
      ...face({ bevel: true }),
      box(0.205, 0.034, 0.014, 0, 0.128, -0.127, SHADES),          // 선글라스
      box(0.012, 0.014, 0.13, 0.114, 0.134, -0.06, SHADES),
      box(0.012, 0.014, 0.13, -0.114, 0.134, -0.06, SHADES),
      cyl(0.15, 0.163, 0.1, 14, 0, 0.245, 0.004, BOONIE),          // 모자 머리
      cyl(0.162, 0.162, 0.026, 14, 0, 0.235, 0.004, c.accent, true), // 팀 색 띠
      cyl(0.168, 0.235, 0.034, 18, 0, 0.196, 0.004, BOONIE)        // 처진 챙
    ],
    torso: (c) => [
      cyl(0.17, 0.18, 0.07, 12, 0, 0.57, 0, SCARF),                // 목에 두른 스카프
      cyl(0.177, 0.177, 0.014, 12, 0, 0.57, 0, SCARF_DK, true),
      box(0.014, 0.072, 0.01, -0.07, 0.57, -0.166, SCARF_DK),
      box(0.014, 0.072, 0.01, 0, 0.57, -0.178, SCARF_DK),
      box(0.014, 0.072, 0.01, 0.07, 0.57, -0.166, SCARF_DK),
      rbox(0.1, 0.16, 0.02, -0.075, 0.47, -0.205, 0.06, 0, 0.16, SCARF),   // 앞으로 늘어진 끝
      box(0.4, 0.24, 0.05, 0, 0.35, -0.165, RIG_S),               // 가슴 조끼
      box(0.4, 0.05, 0.315, 0, 0.25, 0, RIG_S_DK),
      box(0.06, 0.02, 0.33, -0.13, 0.555, 0, RIG_S),
      box(0.06, 0.02, 0.33, 0.13, 0.555, 0, RIG_S),
      box(0.09, 0.1, 0.04, 0, 0.32, -0.205, RIG_S_DK),            // 탄창 주머니
      box(0.09, 0.1, 0.04, 0.105, 0.32, -0.205, RIG_S_DK),
      box(0.1, 0.05, 0.02, 0.11, 0.435, -0.2, c.accent),          // 가슴 팀 표식(오른쪽)
      cyl(0.052, 0.052, 0.15, 12, -0.17, -0.02, 0.17, CANTEEN),   // 수통(왼쪽 허리 뒤)
      cyl(0.02, 0.02, 0.03, 8, -0.17, 0.068, 0.17, CANTEEN_DK)
    ],
    arm: (c) => ({ upper: [armband(c, -0.12), box(0.145, 0.05, 0.155, 0, -0.285, 0, c.suit)], fore: [] })
  },

  // 야간 작전병: 검은 복면 + 가벼운 헬멧과 올려 둔 투시경, 검은 판 조끼, 검은 장갑·무릎 보호대
  av_night: {
    neck: BALA,
    glove: 0x1a1b1d,
    boot: 0x1c1b1a,
    head: (c) => [
      box(0.22, 0.25, 0.24, 0, 0.12, 0, BALA),                     // 복면 쓴 머리
      box(0.05, 0.04, 0.03, 0, 0.07, -0.13, BALA),
      box(0.16, 0.048, 0.01, 0, 0.125, -0.121, SKIN),              // 눈구멍
      box(0.04, 0.018, 0.012, -0.05, 0.125, -0.125, EYES),
      box(0.04, 0.018, 0.012, 0.05, 0.125, -0.125, EYES),
      shell(0.15, 14, 8, 0, TAU, 0, Math.PI * 0.52, 1, 0.78, 1.1, 0, 0.18, 0.006, BUMP),   // 가벼운 헬멧
      box(0.022, 0.05, 0.17, 0.149, 0.15, 0.006, BUMP_DK),
      box(0.022, 0.05, 0.17, -0.149, 0.15, 0.006, BUMP_DK),
      box(0.012, 0.022, 0.1, 0.161, 0.15, 0.006, c.accent),        // 팀 색 줄
      box(0.012, 0.022, 0.1, -0.161, 0.15, 0.006, c.accent),
      box(0.07, 0.045, 0.03, 0, 0.228, -0.158, BUMP_DK),           // 투시경 장착대
      group(nvgParts(), 0, 0.29, -0.178, 1.15)                     // 이마 위로 올린 투시경
    ],
    torso: (c) => [
      box(0.42, 0.35, 0.33, 0, 0.31, 0, PLATE),                   // 검은 판 조끼
      box(0.34, 0.25, 0.035, 0, 0.33, -0.18, PLATE_LT),
      box(0.08, 0.1, 0.035, -0.1, 0.25, -0.212, PLATE),
      box(0.08, 0.1, 0.035, 0, 0.25, -0.212, PLATE),
      box(0.08, 0.1, 0.035, 0.1, 0.25, -0.212, PLATE),
      box(0.1, 0.06, 0.02, -0.11, 0.42, -0.205, c.accent),        // 가슴 팀 표식
      box(0.16, 0.16, 0.06, 0.12, 0.08, 0.18, PLATE)
    ],
    arm: (c) => ({ upper: [armband(c)], fore: [] }),
    leg: () => ({ thigh: [], shin: [box(0.19, 0.12, 0.065, 0, -0.45, -0.1, PLATE_LT)] })
  },

  // 중장갑병: 머리를 감싼 헬멧(가리개·팀 색 볏), 두꺼운 판 갑옷, 어깨 보호대, 팔 보호대, 허벅지·무릎·정강이 판
  av_heavy: {
    glove: (c) => heavyTone(c).dark,
    head: (c) => {
      const t = heavyTone(c);
      return [
        // 헬멧이 곧 머리다. 중심이 히트박스 머리 구 중심(0.12)이고 크기도 거의 같다
        shell(0.152, 16, 10, 0, TAU, 0, Math.PI * 0.8, 1, 1.05, 1.07, 0, 0.12, 0.006, t.plate),
        shell(0.157, 12, 5, Math.PI * 1.5 - 0.82, 1.64, Math.PI * 0.36, Math.PI * 0.26, 1, 1.05, 1.07, 0, 0.12, 0.006, VISOR),   // 얼굴 가리개
        shell(0.159, 12, 1, Math.PI * 1.5 - 0.7, 1.4, Math.PI * 0.485, Math.PI * 0.03, 1, 1.05, 1.07, 0, 0.12, 0.006, VISOR_HI), // 가리개 빛줄
        shell(0.152, 10, 5, 0, TAU, 0, Math.PI * 0.3, 0.11, 1.12, 1.12, 0, 0.12, 0.006, c.accent),  // 팀 색 볏
        box(0.2, 0.055, 0.07, 0, 0, -0.125, t.dark),                 // 턱 보호대
        cylX(0.055, 0.03, 12, 0.152, 0.11, 0.01, t.dark),            // 귀 판
        cylX(0.055, 0.03, 12, -0.152, 0.11, 0.01, t.dark)
      ];
    },
    torso: (c) => {
      const t = heavyTone(c);
      return [
        box(0.48, 0.42, 0.37, 0, 0.3, 0, t.plate),                // 판 갑옷
        box(0.4, 0.28, 0.04, 0, 0.33, -0.2, t.light),             // 가슴판
        box(0.4, 0.035, 0.012, 0, 0.42, -0.222, c.accent),        // 가슴 팀 띠
        box(0.34, 0.08, 0.3, 0, 0.56, 0, t.dark),                 // 목 보호대
        box(0.3, 0.15, 0.04, 0, -0.07, -0.17, t.dark),            // 앞 허리 보호판
        box(0.32, 0.24, 0.05, 0, 0.32, 0.205, t.dark)             // 등판
      ];
    },
    shoulder: (c, s) => {
      const t = heavyTone(c);
      return [
        group([box(0.19, 0.075, 0.22, 0, 0, 0, t.plate), box(0.194, 0.014, 0.224, 0, 0.044, 0, c.accent)], s * 0.02, 0.03, 0, 0, 0, -s * 0.28),
        rbox(0.17, 0.06, 0.2, s * 0.05, -0.045, 0, 0, 0, -s * 0.5, t.dark)
      ];
    },
    arm: (c) => ({ upper: [armband(c, -0.17)], fore: [box(0.15, 0.17, 0.16, 0, -0.41, 0, heavyTone(c).dark)] }),
    leg: (c) => {
      const t = heavyTone(c);
      return {
        thigh: [box(0.19, 0.22, 0.05, 0, -0.2, -0.11, t.dark)],
        shin: [box(0.2, 0.14, 0.08, 0, -0.45, -0.115, t.plate), box(0.185, 0.24, 0.045, 0, -0.66, -0.11, t.dark)]
      };
    }
  }
});

/** 캐릭터 부품 표(engine 쪽 정본). core/avatar-defs.js의 모든 id가 여기 있어야 한다 */
export const AVATAR_STYLE_IDS = Object.freeze(Object.keys(STYLES));

function styleOf(id) { return STYLES[avatarIdOf(id)] || STYLES[DEFAULT_AVATAR]; }

/** 캐릭터 × 팀 → 색 묶음 */
function colorsOf(st, team) {
  const T = TEAMS[team] || TEAMS.owner;
  const suit = new THREE.Color(T.color).getHex();
  const accent = new THREE.Color(T.light).getHex();
  const tint = (hex, k) => new THREE.Color(hex).lerp(new THREE.Color(suit), k).getHex();
  const c = { suit, accent, tint };
  const pick = (v, d) => (typeof v === 'function' ? v(c) : v != null ? v : d);
  c.glove = pick(st.glove, GLOVE);
  c.boot = pick(st.boot, BOOT);
  c.neck = pick(st.neck, SKIN);
  c.sleeve = pick(st.sleeve, null);
  return c;
}

const noArm = { upper: [], fore: [] };
const noLeg = { thigh: [], shin: [] };
const lift = (geos, dy) => geos.map((g) => g.translate(0, dy, 0));

/** 몸통 + 캐릭터 조끼·부착물(엉덩이 피벗 기준) */
function torsoParts(st, c) {
  return [
    box(0.5, 0.56, 0.3, 0, 0.27, 0, c.suit),                 // 몸통 0.95~1.51
    box(0.52, 0.07, 0.32, 0, 0.02, 0, BELT),                 // 벨트
    box(0.13, 0.06, 0.14, 0, 0.58, 0, c.neck),               // 목
    ...st.torso(c)
  ];
}
/** 곧게 편 팔 한쪽(어깨 피벗 기준, 아래로) + 장갑 + 캐릭터 부착물 */
function straightArm(st, c, s) {
  const x = st.arm ? st.arm(c, s) : noArm;
  const sleeve = c.sleeve
    ? [box(0.13, 0.3, 0.14, 0, -0.15, 0, c.suit), box(0.13, 0.2, 0.14, 0, -0.4, 0, c.sleeve)]
    : [box(0.13, 0.5, 0.14, 0, -0.25, 0, c.suit), box(0.135, 0.04, 0.145, 0, -0.33, 0, TAPE)];
  return merge([...sleeve, box(0.11, 0.12, 0.12, 0, -0.55, 0, c.glove), ...x.upper, ...x.fore]);
}
/** 곧게 편 다리 한쪽(엉덩이 피벗 기준, 아래로) + 장화 + 캐릭터 부착물 */
function straightLeg(st, c, s) {
  const x = st.leg ? st.leg(c, s) : noLeg;
  return merge([
    box(0.17, 0.83, 0.2, 0, -0.415, 0, c.suit),
    box(0.175, 0.045, 0.205, 0, -0.5, 0, TAPE),
    box(0.17, 0.13, 0.28, 0, -0.885, -0.035, c.boot),
    ...x.thigh, ...x.shin
  ]);
}
/** 앉은 다리(엉덩이 피벗): 허벅지 0.45 m를 앞으로 굽히고 정강이 0.38 m를 뒤로, 장화는 바닥과 평평하게 */
function bentLeg(st, c, s) {
  const x = st.leg ? st.leg(c, s) : noLeg;
  const a = SQUAT.thigh, b = SQUAT.shin;
  const thigh = place(merge([box(0.17, 0.45, 0.2, 0, -0.225, 0, c.suit), ...x.thigh]), 0, 0, 0, a);
  const kneeY = -0.45 * Math.cos(a), kneeZ = -0.45 * Math.sin(a);
  const shin = place(merge([box(0.17, 0.38, 0.2, 0, -0.19, 0, c.suit), box(0.175, 0.045, 0.205, 0, -0.08, 0, TAPE), ...lift(x.shin, 0.45)]), 0, kneeY, kneeZ, -b);
  const ankleY = kneeY - 0.38 * Math.cos(b), ankleZ = kneeZ + 0.38 * Math.sin(b);
  const boot = box(0.17, 0.13, 0.28, 0, ankleY - 0.065, ankleZ - 0.035, c.boot);
  return merge([thigh, shin, boot]);
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
/** 구르카 나이프(손 소켓 기준). 곧은 뿌리에서 앞쪽 날이 아래로 꺾인다 */
function gurkhaGeo() {
  const root = bladeGeo(0.13, 0, 0.034, 0.04, 0.008, 0x8a8f96, STEEL);
  root.translate(0, 0, -0.05);
  const head = bladeGeo(0.2, 0, 0.056, 0.032, 0.008, 0x8a8f96, STEEL);
  head.rotateX(-0.38);                                     // 칼끝(-Z)을 아래로
  head.translate(0, -0.008, -0.17);
  return merge([
    root,
    head,
    box(0.016, 0.05, 0.012, 0, -0.002, -0.048, BRASS),
    box(0.026, 0.034, 0.11, 0, -0.004, 0.005, 0x5b3a1e),
    box(0.03, 0.038, 0.016, 0, -0.008, 0.066, BRASS)
  ]);
}

/**
 * 든 무기·등에 맨 총은 캐릭터·팀과 상관없다 → 한 번만 만들어 손 소켓 자리에 놓아 두고, 캐릭터마다 복사해 합친다
 * (합칠 때 원본이 버려지지 않게 늘 clone을 넘긴다). 캐릭터 × 팀 수만큼 칼날을 다시 계산하지 않는다.
 */
let heldGeo = null;
function heldWeapons() {
  if (!heldGeo) {
    heldGeo = {
      armsGun: place(gunGeo(), HAND[0], HAND[1], HAND[2]),
      armsKatana: aimGeo(katanaGeo(), HAND_R, [-0.14, 0.56, -0.82], [0.0, -0.82, -0.56]),
      armsKnife: aimGeo(knifeGeo(), HAND_R, [-0.1, 0.24, -0.96], [0.0, -0.96, -0.24]),
      armsGurkha: aimGeo(gurkhaGeo(), HAND_R, [-0.1, 0.34, -0.93], [0.0, -0.93, -0.34])
    };
  }
  return heldGeo;
}
const slingCache = new Map();
/** 등에 비스듬히 맨 총(이모트 중에는 손을 비운다). 등에 무전기가 있으면 그 뒤에 맨다 */
function slingGeo(sl) {
  const key = sl.join(',');
  if (!slingCache.has(key)) {
    const g = gunGeo();
    g.applyMatrix4(new THREE.Matrix4().makeRotationZ(0.75).multiply(new THREE.Matrix4().makeRotationY(Math.PI / 2)).setPosition(sl[0], sl[1], sl[2]));
    slingCache.set(key, g);
  }
  return slingCache.get(key);
}

const geoKey = (id, team) => avatarIdOf(id) + ':' + (TEAMS[team] ? team : 'owner');
const geoCache = new Map();
/**
 * 캐릭터 × 팀 → 평소 몸 지오메트리 (팀 색이 정점색으로 들어감)
 * { upper(몸통+머리+어깨 보호대), legL, legR, legBentL, legBentR, armsGun·armsKatana·armsKnife·armsGurkha(두 팔+든 무기), armsOnly }
 */
function bodyGeometry(id, team) {
  const key = geoKey(id, team);
  if (geoCache.has(key)) return geoCache.get(key);
  const st = styleOf(id);
  const c = colorsOf(st, team);
  // 드로우콜 절약: 머리·어깨 보호대는 몸통에, 두 팔 + 총은 '어깨 피벗' 메시 하나로 굽는다(아바타당 메시 4개)
  const head = merge(st.head(c));
  head.translate(0, 0.55, 0);
  const pads = st.shoulder ? [1, -1].map((s) => place(merge(st.shoulder(c, s)), s * RIG.shoulderX, RIG.shoulderY, 0)) : [];
  const upper = merge([...torsoParts(st, c), head, ...pads]);
  // 어깨 피벗(상체 기준 y=0.5)에서 본 좌표. +X 회전 = 팔이 앞(-Z)으로 들림, Z 회전 = 몸 안쪽으로
  const armsOnly = merge([place(straightArm(st, c, 1), 0.31, 0, 0, 1.25, 0, -0.12), place(straightArm(st, c, -1), -0.31, 0, 0, 1.15, 0, 0.55)]);
  // 칼을 들어도 두 팔은 그대로다. 오른손에 칼을 쥐고 왼손은 앞에 둔 경계 자세(무기 자리는 heldWeapons)
  const W = heldWeapons();
  const withHeld = (key) => merge([armsOnly.clone(), W[key].clone()]);
  const set = {
    upper, legL: straightLeg(st, c, -1), legR: straightLeg(st, c, 1), legBentL: bentLeg(st, c, -1), legBentR: bentLeg(st, c, 1),
    armsGun: withHeld('armsGun'), armsKatana: withHeld('armsKatana'), armsKnife: withHeld('armsKnife'), armsGurkha: withHeld('armsGurkha'), armsOnly
  };
  geoCache.set(key, set);
  return set;
}

const rigCache = new Map();
/**
 * 이모트용 관절 리그 부품(캐릭터 × 팀). 각 부품의 원점 = 관절(피벗).
 * torso(엉덩이 피벗, 등에 맨 총 포함) · head(목) · upperArmR/L(어깨, 어깨 보호대 포함) · foreArmR/L(팔꿈치) · hand_fist/flat/L(손목)
 * · thighR/L(엉덩이) · shinR/L(무릎, 장화 포함)
 */
function rigGeometry(id, team) {
  const key = geoKey(id, team);
  if (rigCache.has(key)) return rigCache.get(key);
  const st = styleOf(id);
  const c = colorsOf(st, team);
  const L = RIG;
  const set = {
    torso: merge([...torsoParts(st, c), slingGeo(st.sling || [0, 0.3, 0.2]).clone()]),
    head: merge(st.head(c)),
    hand_fist: merge([box(0.11, 0.12, 0.12, 0, -0.06, 0, c.glove)]),
    hand_flat: merge([box(0.1, 0.16, 0.04, 0, -0.08, 0, c.glove)]),
    // 엄지·검지 'L': 검지는 손 방향(-Y)으로 길게, 엄지는 몸 안쪽(-X)으로
    hand_L: merge([box(0.1, 0.08, 0.06, 0, -0.04, 0, c.glove), box(0.035, 0.11, 0.035, 0.03, -0.135, 0, c.glove), box(0.09, 0.035, 0.035, -0.085, -0.03, 0, c.glove)])
  };
  for (const [k, s] of [['R', 1], ['L', -1]]) {
    const a = st.arm ? st.arm(c, s) : noArm;
    set['upperArm' + k] = merge([
      box(0.13, L.upperArm + 0.02, 0.14, 0, -L.upperArm / 2, 0, c.suit),
      ...(c.sleeve ? [] : [box(0.135, 0.04, 0.145, 0, -0.2, 0, TAPE)]),
      ...a.upper,
      ...(st.shoulder ? st.shoulder(c, s) : [])
    ]);
    set['foreArm' + k] = merge([box(0.12, L.foreArm + 0.02, 0.13, 0, -L.foreArm / 2, 0, c.sleeve || c.suit), ...lift(a.fore, L.upperArm)]);
    const l = st.leg ? st.leg(c, s) : noLeg;
    set['thigh' + k] = merge([box(0.17, L.thigh + 0.02, 0.2, 0, -L.thigh / 2, 0, c.suit), ...l.thigh]);
    set['shin' + k] = merge([
      box(0.17, L.shin, 0.2, 0, -L.shin / 2, 0, c.suit), box(0.175, 0.045, 0.205, 0, -0.08, 0, TAPE),
      box(0.17, 0.13, 0.28, 0, -L.shin - 0.06, -0.035, c.boot), ...lift(l.shin, L.thigh)
    ]);
  }
  rigCache.set(key, set);
  return set;
}

/** 리그 메시 묶음 만들기(이모트·상점 초상이 같이 쓴다). mk(geo) → Mesh */
function buildRigMeshes(G, mk) {
  const L = RIG;
  const r = { root: new THREE.Group(), G };
  r.hips = new THREE.Group(); r.root.add(r.hips);
  r.torso = new THREE.Group(); r.hips.add(r.torso); r.torso.add(mk(G.torso));
  r.head = new THREE.Group(); r.head.position.set(0, L.neckY, 0); r.torso.add(r.head); r.head.add(mk(G.head));
  for (const [k, s] of [['R', 1], ['L', -1]]) {
    const sh = new THREE.Group(); sh.position.set(L.shoulderX * s, L.shoulderY, 0); r.torso.add(sh); sh.add(mk(G['upperArm' + k]));
    const el = new THREE.Group(); el.position.set(0, -L.upperArm, 0); sh.add(el); el.add(mk(G['foreArm' + k]));
    const wr = new THREE.Group(); wr.position.set(0, -L.foreArm, 0); el.add(wr);
    const hand = mk(G.hand_fist); wr.add(hand);
    const hp = new THREE.Group(); hp.position.set(L.hipX * s, 0, 0); r.hips.add(hp); hp.add(mk(G['thigh' + k]));
    const kn = new THREE.Group(); kn.position.set(0, -L.thigh, 0); hp.add(kn); kn.add(mk(G['shin' + k]));
    r['shoulder' + k] = sh; r['elbow' + k] = el; r['wrist' + k] = wr; r['hand' + k] = hand; r['hip' + k] = hp; r['knee' + k] = kn;
  }
  return r;
}

/** 포즈(emoteanim 형식) → 리그 관절 */
function applyRigPose(r, p) {
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

/** 슬롯·무기 id → 팔 지오메트리 이름. 칼만 바꾸고 나머지(수류탄 포함)는 기본 총 */
function armsKeyOf(slot, weaponId) {
  const s = Number(slot);
  const melee = s === 3 || (!(s > 0) && typeof weaponId === 'string' && weaponId.startsWith('ml_'));
  if (!melee) return 'armsGun';
  return weaponId === 'ml_katana' ? 'armsKatana' : weaponId === 'ml_gurkha' ? 'armsGurkha' : 'armsKnife';
}

let sharedMat = null;
function bodyMaterial() {
  if (!sharedMat) sharedMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  return sharedMat;
}

let droppedGeo = null;
/** 바닥에 떨어진 총 모형. 몸에 든 총과 같은 모양이고 지오메트리와 재질은 모두 나눠 쓴다(지우지 말 것). 총구 = -Z */
export function droppedGunMesh() {
  if (!droppedGeo) droppedGeo = gunGeo();
  return new THREE.Mesh(droppedGeo, bodyMaterial());
}

/* ---------------- 상점 초상 ----------------
 * 게임 렌더러 하나로 캐릭터 × 팀마다 한 번 그려 PNG data URL로 둔다(두 번째 WebGL 컨텍스트를 만들지 않는다).
 * 1) 리그를 편한 선 자세로 세워 2배 크기 렌더 타깃(선형, 가능하면 half float)에 그리고
 * 2) 화면과 같은 톤 매핑(Neutral)·sRGB 변환을 하며 1배로 줄여(2×2 평균) 8비트 타깃에 옮긴 뒤 읽는다.
 *    three는 렌더 타깃에 그릴 때 톤 매핑·색 공간 변환을 하지 않으므로 2단계에서 직접 한다. 배경은 투명.
 */
const PORTRAIT_POSE = makePose({
  armR: [0.12, 0, 0.17], foreR: 0.32, armL: [0.1, 0, 0.15], foreL: 0.26,
  torso: [0, 0.05, 0], head: [0.03, -0.14, 0], legR: [0.02, 0, 0.05], legL: [-0.02, 0, 0.04]
});
const POST_VERT = 'varying vec2 vUv;\nvoid main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';
const POST_FRAG = [
  'uniform sampler2D tSrc;',
  'varying vec2 vUv;',
  // three r170 NeutralToneMapping(노출 1)과 같다
  'vec3 neutral(vec3 color) {',
  '  const float StartCompression = 0.8 - 0.04;',
  '  const float Desaturation = 0.15;',
  '  float x = min(color.r, min(color.g, color.b));',
  '  float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;',
  '  color -= offset;',
  '  float peak = max(color.r, max(color.g, color.b));',
  '  if (peak < StartCompression) return color;',
  '  float d = 1. - StartCompression;',
  '  float newPeak = 1. - d * d / (peak + d - StartCompression);',
  '  color *= newPeak / peak;',
  '  float g = 1. - 1. / (Desaturation * (peak - newPeak) + 1.);',
  '  return mix(color, vec3(newPeak), g);',
  '}',
  'vec3 toSrgb(vec3 c) { return mix(pow(c, vec3(0.41666)) * 1.055 - vec3(0.055), c * 12.92, vec3(lessThanEqual(c, vec3(0.0031308)))); }',
  'void main() {',
  '  vec4 s = texture2D(tSrc, vUv);',            // 2×2 텍셀 한가운데를 선형 보간으로 읽어 평균(가장자리는 덮인 만큼 알파)
  '  vec3 c = s.a > 0.0001 ? s.rgb / s.a : vec3(0.0);',
  '  gl_FragColor = vec4(toSrgb(clamp(neutral(max(c, vec3(0.0))), 0.0, 1.0)), s.a);',
  '}'
].join('\n');

/**
 * three: 게임의 WebGLRenderer(main.js ctx.renderer.three). get(id, team)은 처음 한 번만 그리고 그 뒤로는 저장한 값을 준다.
 * 그릴 수 없으면(WebGL 오류 등) null → UI는 아이콘을 보여 준다.
 */
export function createAvatarPortraits(three, { width = 240, height = 320 } = {}) {
  const cache = new Map();
  let P = null;
  let broken = !three || typeof three.setRenderTarget !== 'function' || typeof document === 'undefined';

  function setup(type) {
    const src = new THREE.WebGLRenderTarget(width * 2, height * 2, { type, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: true, generateMipmaps: false });
    const out = new THREE.WebGLRenderTarget(width, height, { type: THREE.UnsignedByteType, depthBuffer: false, generateMipmaps: false });
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xd6e6ff, 0x5a5040, 1.45));
    const sun = new THREE.DirectionalLight(0xffffff, 2.6);
    sun.position.set(-1.8, 3.4, -3.2);
    scene.add(sun);
    // 무릎 위부터 머리 장비·안테나 끝(약 2 m)까지 담는다. 머리 장비가 캐릭터를 가장 잘 구별하므로 전신보다 크게 보인다
    const cam = new THREE.PerspectiveCamera(31, width / height, 0.1, 20);
    cam.position.set(0, 1.32, -2.96);
    cam.lookAt(0, 1.24, 0);
    const post = new THREE.ShaderMaterial({
      uniforms: { tSrc: { value: src.texture } }, vertexShader: POST_VERT, fragmentShader: POST_FRAG,
      depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: false
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), post);
    quad.frustumCulled = false;
    const postScene = new THREE.Scene();
    postScene.add(quad);
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    return {
      type, src, out, scene, cam, post, quad, postScene, postCam: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1),
      canvas, g2: canvas.getContext('2d'), buf: new Uint8Array(width * height * 4)
    };
  }
  function release() {
    if (!P) return;
    P.src.dispose(); P.out.dispose(); P.post.dispose(); P.quad.geometry.dispose();
    P = null;
  }
  function floatOk() {
    try { return !!(three.extensions && (three.extensions.has('EXT_color_buffer_float') || three.extensions.has('EXT_color_buffer_half_float'))); }
    catch (e) { return false; }
  }

  /** 한 장 그리기 → 덮인 픽셀이 있으면 true */
  function draw(id, team) {
    const rig = buildRigMeshes(rigGeometry(id, team), (geo) => new THREE.Mesh(geo, bodyMaterial()));
    applyRigPose(rig, PORTRAIT_POSE);
    rig.root.rotation.y = 0.5;                       // 오른쪽 앞에서 본 3/4 모습
    P.scene.add(rig.root);
    const prevTarget = three.getRenderTarget();
    const prevClear = three.getClearColor(new THREE.Color());
    const prevAlpha = three.getClearAlpha();
    const prevAuto = three.autoClear;
    try {
      three.autoClear = true;
      three.setClearColor(0x000000, 0);
      three.setRenderTarget(P.src);
      three.render(P.scene, P.cam);
      three.setRenderTarget(P.out);
      three.render(P.postScene, P.postCam);
      three.readRenderTargetPixels(P.out, 0, 0, width, height, P.buf);
    } finally {
      three.setRenderTarget(prevTarget);
      three.setClearColor(prevClear, prevAlpha);
      three.autoClear = prevAuto;
      P.scene.remove(rig.root);
    }
    for (let i = 3; i < P.buf.length; i += 4) if (P.buf[i] > 0) return true;
    return false;
  }

  function get(id, team) {
    const key = geoKey(id, team);
    if (cache.has(key)) return cache.get(key);
    if (broken) return null;
    let url = null;
    try {
      if (!P) P = setup(floatOk() ? THREE.HalfFloatType : THREE.UnsignedByteType);
      let ok = draw(id, team);
      if (!ok && P.type !== THREE.UnsignedByteType) { release(); P = setup(THREE.UnsignedByteType); ok = draw(id, team); }   // half float에 못 그리는 기기
      if (ok) {
        const img = P.g2.createImageData(width, height);
        const row = width * 4;
        for (let y = 0; y < height; y++) img.data.set(P.buf.subarray((height - 1 - y) * row, (height - y) * row), y * row);   // 아래부터 읽힌 줄을 뒤집는다
        P.g2.putImageData(img, 0, 0);
        url = P.canvas.toDataURL('image/png');
      }
    } catch (err) {
      console.warn('[avatars] 초상을 그리지 못했어요', err);
      broken = true;
      release();
    }
    cache.set(key, url);
    return url;
  }

  return {
    get,
    get size() { return cache.size; },
    dispose() { release(); cache.clear(); }
  };
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
    this.avatarId = avatarIdOf(opts.avatar);   // 캐릭터(모르는 값은 기본)
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
    this.swingT = -1;              // 칼 휘두르기 진행도 0..1(-1 = 안 함)
    this.swingStab = false;
    this.swingDir = -1;            // 베기 방향. 벨 때마다 뒤집어 좌우를 번갈아 간다
    this.root = new THREE.Group();
    this.root.name = 'avatar:' + id;
    this.body = new THREE.Group();  // 쓰러질 때 회전
    this.root.add(this.body);
    this.build();
    mgr.scene.add(this.root);
  }

  /** 지금 캐릭터·팀의 평소 몸 지오메트리(build가 정한다. 매 프레임 찾지 않는다) */
  geo() { return this.G || (this.G = bodyGeometry(this.avatarId, this.team)); }

  build() {
    this.G = bodyGeometry(this.avatarId, this.team);
    const G = this.G;
    const mat = bodyMaterial();
    const mk = (geo) => { const m = new THREE.Mesh(geo, mat); m.castShadow = true; return m; };
    this.body.clear();
    this.rig = null; // 팀·캐릭터가 바뀌면 리그도 새 모양으로(다음 이모트 때 다시 만듦)
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
  /** 캐릭터 바꾸기(모르는 id는 기본 캐릭터). 쓰러져 있거나 이모트 중이어도 다음 프레임부터 새 모양이다 */
  setAvatar(id) {
    const v = avatarIdOf(id);
    if (v === this.avatarId) return;
    const rigOn = !!(this.rig && this.rig.root.visible);
    this.avatarId = v;
    this.build();
    if (rigOn) { const r = this.buildRig(); r.root.visible = true; this.hips.visible = false; }
  }

  /** 이모트용 관절 리그 만들기(처음 이모트할 때 한 번) */
  buildRig() {
    const mat = bodyMaterial();
    const r = buildRigMeshes(rigGeometry(this.avatarId, this.team), (geo) => { const m = new THREE.Mesh(geo, mat); m.castShadow = true; return m; });
    r.root.visible = false;
    this.body.add(r.root);
    this.rig = r;
    return r;
  }

  /** 포즈(emoteanim 형식) → 리그 관절 */
  applyPose(p) { applyRigPose(this.rig, p); }

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
    this.arms.geometry = this.geo()[this.held ? 'armsOnly' : this.armsKey];
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

  /** 칼을 휘두르기 시작한다. 'stab'은 앞으로 내지르고, 나머지는 좌우를 번갈아 벤다 */
  swing(kind) {
    this.swingStab = kind === 'stab';
    if (!this.swingStab) this.swingDir = -this.swingDir;
    this.swingT = 0;
  }

  /** 어깨 피벗을 돌려 휘두른다. 뒤로 뺀 뒤 빠르게 지나가고 천천히 돌아온다. 조준 pitch는 이미 rotation.x에 들어 있다 */
  updateSwing(dt) {
    const pivot = this.armsPivot, upper = this.upper;
    if (this.swingT < 0) return;
    this.swingT += dt / (this.swingStab ? 0.46 : 0.34);
    if (this.swingT >= 1 || this.death || this.emoteCode) {
      this.swingT = -1;
      pivot.rotation.y = 0; pivot.rotation.z = 0; pivot.position.z = 0;
      upper.rotation.y = 0;
      return;
    }
    const t = this.swingT;
    const ease = (a, b) => { const u = Math.max(0, Math.min(1, (t - a) / (b - a))); return u * u * (3 - 2 * u); };
    if (this.swingStab) {
      const back = ease(0, 0.26) * (1 - ease(0.26, 0.38));
      const thrust = ease(0.26, 0.42) * (1 - ease(0.58, 1));
      pivot.position.z = 0.1 * back - 0.3 * thrust;       // -Z = 앞
      pivot.rotation.x += 0.28 * back - 0.12 * thrust;
      upper.rotation.y = 0.32 * (thrust - back);
    } else {
      const wind = ease(0, 0.2) * (1 - ease(0.2, 0.36));
      const cut = ease(0.2, 0.46) * (1 - ease(0.56, 1));
      const d = this.swingDir;
      pivot.rotation.y = d * (1.05 * cut - 0.75 * wind);  // +Y = 왼쪽으로 돈다
      pivot.rotation.x += d > 0 ? 0.42 * wind - 0.34 * cut : -0.2 * wind + 0.3 * cut;
      pivot.rotation.z = d * 0.25 * cut;
      upper.rotation.y = d * 0.34 * (cut - wind);
    }
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
      if (s.avatar && s.avatar !== this.avatarId) this.setAvatar(s.avatar);
      this.crouchTarget = !!s.crouch && s.alive !== false;
      const ec = typeof s.emote === 'number' ? s.emote | 0 : s.emote ? ((emoteById(s.emote) || {}).code || 0) : 0;
      this.emoteCode = ec;
      const key = armsKeyOf(s.slot, s.weaponId);
      if (key !== this.armsKey) {
        this.armsKey = key;
        if (!this.held) this.arms.geometry = this.geo()[key];
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
    const G = this.geo();
    const geoL = bent ? G.legBentL : G.legL, geoR = bent ? G.legBentR : G.legR;
    if (this.legL.geometry !== geoL) { this.legL.geometry = geoL; this.legR.geometry = geoR; }
    const ls = hipY / (bent ? SQUAT.hipY : STAND_HIP);
    this.legL.scale.y = this.legR.scale.y = ls;
    // 총을 든 자세 + 조준 pitch (상체가 조금, 팔·총이 더). 앉으면 상체를 숙이고 팔은 그만큼 들어 총을 수평으로
    const aim = Math.max(-0.9, Math.min(0.9, this.pitch));
    this.upper.rotation.x = aim * 0.35 - SQUAT.lean * ck;
    this.armsPivot.rotation.x = aim * 0.6 + sw * 0.03 + SQUAT.lean * ck;
    this.updateSwing(dt);
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
   * 미리 준비용 묶음: 모든 캐릭터 × 두 팀의 평소 몸(4종+앉은 다리)과 이모트 리그 부품(손 모양 3종 포함) 메시.
   * 지오메트리·재질은 실제 아바타와 공유하므로 한 번 그리면 GPU 버퍼·셰이더·그리기 상태가 모두 준비된다.
   * 화면 아래 멀리(y −1000)에 두고 frustumCulled=false라 보이지 않게 그려진다(그림자 패스 포함).
   * 처음 보는 캐릭터가 늦게 들어와도 끊기지 않게 고르지 않은 캐릭터까지 모두 넣는다(재질은 하나라 셰이더 컴파일은 그대로 한 번).
   */
  function getWarmGroup() {
    if (warmGroup) return warmGroup;
    const g = new THREE.Group();
    g.name = 'avatars:prewarm';
    const mat = bodyMaterial();
    for (const id of AVATAR_IDS) {
      for (const team of TEAM_IDS) {
        const T = bodyGeometry(id, team), R = rigGeometry(id, team);
        for (const geo of [...Object.values(T), ...Object.values(R)]) {
          const m = new THREE.Mesh(geo, mat);
          m.frustumCulled = false;
          m.castShadow = true;
          m.position.set(0, -1000, 0);
          g.add(m);
        }
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
      if (opts.avatar !== undefined) a.setAvatar(opts.avatar);
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
      const a = map.get(id) || add(id, { name: state && state.name, team: state && state.team, avatar: state && state.avatar });
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
     * { visible, pos:[x,y,z](보간된 화면 위치), yaw, pitch, team, name, emote(번호), crouch, slot?, weaponId?, avatar? }. visible:false면 숨김.
     * avatar(캐릭터 id)는 game World가 계정 장비에서 채운다. 없으면 기본 캐릭터.
     */
    setLocalBody(o) {
      if (!o || !o.visible) {
        if (local && local.visible) { local.visible = false; local.root.visible = false; }
        return;
      }
      const team = TEAMS[o.team] ? o.team : 'owner';
      if (!local) { local = new Avatar('__local', { name: o.name || '', team, avatar: o.avatar }, mgr); local.isLocal = true; local.tag.visible = false; }
      else {
        if (team !== local.team) local.setTeam(team);
        local.setAvatar(o.avatar);
      }
      local.visible = true;
      local.buffer.clear();
      local.buffer.push(0, { pos: [o.pos[0], o.pos[1], o.pos[2]], yaw: o.yaw || 0, pitch: o.pitch || 0, alive: true, crouch: !!o.crouch, emote: o.emote | 0, slot: o.slot, weaponId: o.weaponId });
    },
    /**
     * 맵 로드 때 부른다: 준비용 메시를 장면에 넣고 fn()(예: compileAsync + 한 번 그리기)을 기다린 뒤 뺀다.
     * → 첫 이모트·처음 보는 팀·캐릭터 아바타가 나올 때 셰이더 컴파일·버퍼 업로드로 끊기지 않는다.
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
