/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 대원 GLB를 한 번 불러와 대원 × 팀 몸 지오메트리를 굽고, 아바타마다 뼈대를 복제해 움직인다(OperatorBody).
 *          이동은 모델의 동작 클립을 섞고, 조준(상체 위아래)·총 든 팔·앉기·이모트·칼 휘두르기·반동·재장전·투척은 뼈를 직접 돌린다.
 */
/*
 *   await loadOperators()                 // 처음 한 번만 받는다. 실패하면 같은 오류로 계속 거부(OPERATOR_MODEL_URL을 알려 준다)
 *   operatorsReady() → 템플릿 | null       // 다 받았으면 템플릿
 *   const body = new OperatorBody(tpl, avatarId, team)
 *   scene.add(body.root)                  // root = 아바타 공간(발바닥 원점, 정면 -Z). 위치·yaw는 부르는 쪽이 root에 넣는다
 *   body.update(dt, { moveX, moveZ, crouch, pitch, emote })   // moveX·moveZ = 로컬 속도(m/s, -Z = 앞), crouch 0..1, emote = 번호(0 = 없음)
 *   body.setLook(id, team) / setHeldKey(key) / setHeld(obj) / setAiGlasses(on)
 *   body.swing(kind) / recoil() / reload(sec) / throwNade() / kill(dirLocal) / revive()
 *
 * 좌표: GLB 원본은 +Z를 보고 1.85 m다. 모델 묶음(model)을 Y축으로 π 돌리고 MODEL_SCALE배 해서 아바타 공간에 맞춘다
 *   → 머리 중심 1.632 m(히트박스 머리 구 1.62), 키 약 1.78 m(헬멧 끝). 굽는 지오메트리는 이 아바타 공간의 바인드 자세(T자)다.
 * 뼈 돌리기: 아바타 공간 회전 R(엉뚱한 뼈 축을 몰라도 되게)을 쓴다. 뼈의 아바타 공간 회전 = R × A × 쉬는 회전.
 *   A는 T자 팔을 아래로 내린 자세로 맞추는 회전이고(다리·몸통은 거의 단위), R은 emoteanim 리그와 같은 약속
 *   (단위 = 팔·다리가 아래로 늘어지고 정면 -Z, 팔꿈치·무릎 경첩 = 로컬 X)이다. 그래서 이모트 포즈를 그대로 옮길 수 있다.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneRig } from 'three/addons/utils/SkeletonUtils.js';
import { EMOTE_BLEND } from '../core/consts.js';
import { lookOf, partsOf, colorOf, teamLookOf, TEAM_LOOK, OPERATOR_IDS } from './operator-look.js';
import { gearOf, heldGeometry, glassesGeometry, HEAD_CENTER, merge } from './operator-gear.js';
import { solveTwoBone } from './limb-ik.js';
import { sampleEmote, fk, sideRot } from './emoteanim.js';

export const OPERATOR_MODEL_URL = new URL('../../assets/models/operators/operators.glb', import.meta.url).href;
export const MODEL_SCALE = 0.96;
/**
 * 모델 공간 → 아바타 공간: 뒤(+Z)로 이만큼 민다. 원본 몸통 가운데가 발 원점보다 앞에 있어서, 밀어야 몸통·머리가
 * 히트박스(몸통 상자 z 0 중심, 머리 구 z 0)와 겹친다. 지오메트리·장비·IK 목표는 모두 밀기 전의 '모델 공간'에서 계산한다.
 */
export const MODEL_SHIFT_Z = 0.065;
/** 모델 안의 동작 이름(tools/models/build-operators.mjs KEEP_CLIPS) */
const CLIPS = Object.freeze({ idle: 'Idle', walk: 'Walk', run: 'Run', back: 'Run_Back', left: 'Run_Left', right: 'Run_Right', death: 'Death' });

/** animPose에서 뼈 하나가 차지하는 칸(위치 3 · 회전 4 · 크기 3) */
const POSE_STRIDE = 10;

/* ---------------- 총 든 자세(아바타 공간, 서 있고 조준 0) ----------------
 * 오른손은 총 손잡이, 왼손은 총몸 아래를 받친다. 이 모델은 팔이 짧아(어깨~손목 0.40 m) 예전 상자 인물보다 손이 몸에 가깝다.
 */
const HOLD_R = Object.freeze([0.13, 1.22, -0.33]);
const HOLD_L = Object.freeze([0.055, 1.21, -0.43]);
/** 손바닥 쥐는 점 ← 손목(손 틀 H 기준: 손가락 = -Y, 오른손 손바닥 = -X) */
const PALM_IN_HAND = 0.085, PALM_INSET = 0.02;
const STANCE_TWIST = -0.12;   // 상체를 조금 오른쪽으로(왼 어깨가 앞으로 나와 왼손이 총몸에 닿게)
const SQUAT_DROP = 0.43, SQUAT_BACK = 0.11, SQUAT_LEAN = 0.38;
const FINGERS = ['Index', 'Middle', 'Ring', 'Pinky'];
const SHAPES = Object.freeze({ fist: [0.25, 1.25, 1.2], grip: [0.2, 1.05, 1.1], hold: [0.1, 0.6, 0.7], flat: [0.03, 0.06, 0.05] });

const UP = new THREE.Vector3(0, 1, 0), DOWN = new THREE.Vector3(0, -1, 0);
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/* ---------------- 불러오기 ---------------- */

let loadPromise = null;
let template = null;

/** 대원 모델을 한 번만 받는다. 실패하면 이유를 담은 Error로 거부한다(다시 부르면 새로 시도) */
export function loadOperators(url = OPERATOR_MODEL_URL) {
  if (template) return Promise.resolve(template);
  if (!loadPromise) {
    loadPromise = new GLTFLoader().loadAsync(url)
      .then((gltf) => (template = buildTemplate(gltf)))
      .catch((err) => {
        loadPromise = null;
        const e = new Error(`대원 모델을 불러오지 못했어요(${url}): ${(err && err.message) || err}`);
        e.cause = err;
        throw e;
      });
  }
  return loadPromise;
}
export function operatorsReady() { return template; }

/* ---------------- 템플릿: 뼈대·쉬는 자세·지오메트리 ---------------- */

const tmpM = new THREE.Matrix4(), tmpV = new THREE.Vector3(), tmpQ = new THREE.Quaternion(), tmpS = new THREE.Vector3();

function buildTemplate(gltf) {
  const scene = gltf.scene;
  scene.updateMatrixWorld(true);
  const prims = [];
  scene.traverse((o) => { if (o.isSkinnedMesh) prims.push(o); });
  if (!prims.length) throw new Error('뼈대가 있는 메시가 없어요');
  const skeleton = prims[0].skeleton;
  for (const p of prims) if (p.skeleton.bones.length !== skeleton.bones.length) throw new Error('메시마다 뼈대가 달라요');
  skeleton.pose();
  scene.updateMatrixWorld(true);
  const armature = skeleton.bones[0].parent;   // CharacterArmature
  const M = new THREE.Matrix4().compose(new THREE.Vector3(), new THREE.Quaternion().setFromAxisAngle(UP, Math.PI), new THREE.Vector3(MODEL_SCALE, MODEL_SCALE, MODEL_SCALE));

  // 쉬는(바인드) 자세: 뼈마다 아바타 공간 위치·회전·행렬과 로컬 값
  const rest = new Map();
  const boneIndex = new Map();
  skeleton.bones.forEach((b, i) => {
    boneIndex.set(b.name, i);
    const av = new THREE.Matrix4().multiplyMatrices(M, b.matrixWorld);
    const pos = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    av.decompose(pos, q, s);
    rest.set(b.name, { av, pos, q, scale: s.x, lpos: b.position.clone(), lq: b.quaternion.clone(), lscale: b.scale.clone() });
  });
  const R = (n) => { const r = rest.get(n); if (!r) throw new Error('뼈가 없어요: ' + n); return r; };

  // 아바타 공간 몸 부품(재질 이름별)
  const parts = new Map();
  const nmat = new THREE.Matrix3();
  for (const p of prims) {
    const base = p.name.replace(/_\d+$/, '');
    const key = base + '/' + p.material.name;
    const g = p.geometry;
    const n = g.attributes.position.count;
    const toAv = new THREE.Matrix4().multiplyMatrices(M, p.matrixWorld);
    nmat.getNormalMatrix(toAv);
    const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), si = new Uint8Array(n * 4), sw = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      tmpV.fromBufferAttribute(g.attributes.position, i).applyMatrix4(toAv);
      pos[i * 3] = tmpV.x; pos[i * 3 + 1] = tmpV.y; pos[i * 3 + 2] = tmpV.z;
      tmpV.fromBufferAttribute(g.attributes.normal, i).applyMatrix3(nmat).normalize();
      nor[i * 3] = tmpV.x; nor[i * 3 + 1] = tmpV.y; nor[i * 3 + 2] = tmpV.z;
      let sum = 0;
      for (let k = 0; k < 4; k++) { si[i * 4 + k] = g.attributes.skinIndex.getComponent(i, k); sw[i * 4 + k] = g.attributes.skinWeight.getComponent(i, k); sum += sw[i * 4 + k]; }
      if (sum > 0) for (let k = 0; k < 4; k++) sw[i * 4 + k] /= sum;
    }
    parts.set(key, { pos, nor, si, sw, index: Array.from(g.index.array), count: n });
  }

  // 공유 재질 하나(정점색). 손에 든 무기·안경도 같은 재질을 쓴다(뼈대가 없는 메시는 three가 다른 셰이더로 컴파일)
  const material = new THREE.MeshLambertMaterial({ vertexColors: true });

  // 복제용 뼈대 묶음: rigRoot(아바타 공간) ─ space(모델 공간, 뒤로 MODEL_SHIFT_Z) ─ model(π 회전·축소) ─ armature ─ 뼈
  //                                                                          └ 몸 메시(바인드 행렬 = 단위)
  const rigRoot = new THREE.Group();
  rigRoot.name = 'operator';
  const space = new THREE.Group();
  space.name = 'operator:space';
  space.position.z = MODEL_SHIFT_Z;
  rigRoot.add(space);
  const model = new THREE.Group();
  model.name = 'operator:model';
  model.quaternion.setFromAxisAngle(UP, Math.PI);
  model.scale.setScalar(MODEL_SCALE);
  // 원래 부모(장면 → RootNode)의 변환을 품은 채로 옮긴다
  armature.matrixWorld.decompose(armature.position, armature.quaternion, armature.scale);
  armature.removeFromParent();
  model.add(armature);
  space.add(model);
  // 뼈 역행렬은 모델 공간 기준(정점도 모델 공간). 밀기·위치는 뼈 월드 행렬에 들어 있어 따로 더하지 않는다
  const inverses = skeleton.bones.map((b) => R(b.name).av.clone().invert());
  const mesh = new THREE.SkinnedMesh(new THREE.BufferGeometry(), material);
  mesh.name = 'operator:body';
  space.add(mesh);
  rigRoot.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton(skeleton.bones, inverses), new THREE.Matrix4());
  // 화면 밖 판정용 구(아바타 공간). 비우면 three가 정점마다 뼈 변환을 돌려 계산하므로 미리 넣는다(쓰러져 누운 몸까지 덮는다)
  const cullSphere = new THREE.Sphere(new THREE.Vector3(0, 0.9, 0), 2.0);
  mesh.boundingSphere = cullSphere.clone();

  // 팔·다리를 리그 약속(아래로 늘어진 자세)으로 맞추는 회전 A
  const dirOf = (a, b) => new THREE.Vector3().subVectors(R(b).pos, R(a).pos).normalize();
  const align = {
    R: new THREE.Quaternion().setFromUnitVectors(dirOf('UpperArmR', 'LowerArmR'), DOWN),
    L: new THREE.Quaternion().setFromUnitVectors(dirOf('UpperArmL', 'LowerArmL'), DOWN),
    legR: new THREE.Quaternion().setFromUnitVectors(dirOf('UpperLegR', 'LowerLegR'), DOWN),
    legL: new THREE.Quaternion().setFromUnitVectors(dirOf('UpperLegL', 'LowerLegL'), DOWN)
  };
  const len = (a, b) => R(a).pos.distanceTo(R(b).pos);
  const limbs = {
    upperArm: len('UpperArmR', 'LowerArmR'), foreArm: len('LowerArmR', 'WristR'),
    thigh: len('UpperLegR', 'LowerLegR'), shin: len('LowerLegR', 'FootR')
  };

  const clips = {};
  for (const [k, name] of Object.entries(CLIPS)) {
    const clip = gltf.animations.find((a) => a.name === name);
    if (!clip) throw new Error('동작이 없어요: ' + name);
    clips[k] = clip;
  }
  // 클립이 움직이는 뼈 이름(트랙 이름 '뼈.quaternion' 등의 앞부분)
  const driven = new Set();
  for (const clip of Object.values(clips)) for (const tr of clip.tracks) driven.add(THREE.PropertyBinding.parseTrackName(tr.name).nodeName);

  const tpl = {
    rigRoot, material, rest, boneIndex, parts, align, limbs, clips, driven, M,
    geometry: null, speeds: null, deathAngle: 0, sockets: null,
    cullSphere,
    shapes: new Map(), geos: new Map()
  };
  tpl.geometry = (id, team) => geometryOf(tpl, id, team);
  mesh.geometry = tpl.geometry(OPERATOR_IDS[0], 'owner');
  tpl.sockets = socketsOf(tpl);
  measureClips(tpl);
  return tpl;
}

/** 무기 소켓(오른손목)·등 소켓(가슴)·안경(머리)의 뼈 로컬 행렬 */
function socketsOf(tpl) {
  const { rest, align } = tpl;
  const local = (bone, worldAv) => {
    const r = rest.get(bone);
    return new THREE.Matrix4().copy(r.av).invert().multiply(worldAv);
  };
  // 총 든 오른손: 손 틀 H = Rx(π/2)(손가락이 앞). 손목을 원점에 둔 아바타 공간 행렬로 계산한다
  const H = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
  const wr = rest.get('WristR');
  const wristAv = new THREE.Matrix4().compose(new THREE.Vector3(), H.clone().multiply(align.R).multiply(wr.q), new THREE.Vector3(wr.scale, wr.scale, wr.scale));
  const palm = new THREE.Vector3(-PALM_INSET, -PALM_IN_HAND, 0).applyQuaternion(H);
  const gunLocal = new THREE.Matrix4().copy(wristAv).invert().multiply(new THREE.Matrix4().makeTranslation(palm.x, palm.y, palm.z));
  // 이모트 중 등에 비스듬히 멘 총(예전 리그와 같은 각도)
  const backAv = new THREE.Matrix4().makeRotationZ(0.75).multiply(new THREE.Matrix4().makeRotationY(Math.PI / 2)).setPosition(0, 1.27, 0.13);
  return { gun: gunLocal, back: local('Chest', backAv), glasses: local('Head', new THREE.Matrix4()) };
}

/** 이동 클립의 원래 속도(발이 땅을 미는 거리로 잰다)와 쓰러짐 방향 */
function measureClips(tpl) {
  const rig = cloneRig(tpl.rigRoot);
  const space = rig.getObjectByName('operator:space');
  const mixer = new THREE.AnimationMixer(rig.getObjectByName('operator:model'));
  const foot = rig.getObjectByName('FootL'), head = rig.getObjectByName('Head');
  const v = new THREE.Vector3();
  const speeds = {};
  for (const [k, axis] of [['walk', 'z'], ['run', 'z'], ['back', 'z'], ['left', 'x'], ['right', 'x']]) {
    const clip = tpl.clips[k];
    const act = mixer.clipAction(clip).play();
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i <= 24; i++) {
      act.time = (clip.duration * i) / 24; mixer.update(0);
      rig.updateMatrixWorld(true);
      foot.getWorldPosition(v);
      lo = Math.min(lo, v[axis]); hi = Math.max(hi, v[axis]);
    }
    act.stop();
    // 한 주기에 발이 두 번 디딘다(디딘 동안 땅을 미는 거리 ≈ 앞뒤 폭). 너무 작으면 기본값
    speeds[k] = Math.max(0.8, (2 * (hi - lo)) / clip.duration);
  }
  const death = mixer.clipAction(tpl.clips.death).play();
  death.time = tpl.clips.death.duration; mixer.update(0);
  rig.updateMatrixWorld(true);
  space.worldToLocal(head.getWorldPosition(v));
  tpl.deathAngle = Math.atan2(v.x, v.z);   // 쓰러진 머리 방향(모델 공간)
  death.stop();
  tpl.speeds = speeds;
}

/* ---------------- 대원 × 팀 지오메트리 ---------------- */

const ACCENT_KEY = 0xff00fe;   // 장비를 만들 때 쓰는 팀 강조색 자리표시(팀마다 바꿔 칠한다)
const UNIFORM_KEY = 0xfe01ff;
const STROBE_KEY = 0xfe00fd;   // 적외선 표시등: 팀 강조색을 흰색 쪽으로 밝힌 색(멀리서 반짝이는 점)

/** 대원 모양(팀과 상관없는 부분): 위치·법선·뼈 + 정점마다 기본 색과 팀 색 칸(0 = 기본, 1 = 강조, 2 = 전투복, 3 = 표시등) */
function shapeOf(tpl, id) {
  const look = lookOf(id);
  const key = OPERATOR_IDS.find((k) => lookOf(k) === look);
  if (tpl.shapes.has(key)) return tpl.shapes.get(key);
  const chunks = [];
  const solid = (hex) => new THREE.Color(hex);
  for (const [base, mat, slot] of partsOf(look)) {
    const p = tpl.parts.get(base + '/' + mat);
    if (!p) throw new Error(`모델에 부품이 없어요: ${base}/${mat}`);
    const team = slot === 'accent' ? 1 : slot === 'uniform' ? 2 : 0;
    const color = new Float32Array(p.count * 3);
    const c = solid(colorOf(look, 'owner', slot));
    const skin = solid(colorOf(look, 'owner', 'skin'));
    for (let i = 0; i < p.count; i++) {
      // 복면: 눈 둘레(앞쪽, 눈높이 띠)만 살색
      const eye = slot === 'balaclava' && p.pos[i * 3 + 2] < -0.1 && p.pos[i * 3 + 1] > 1.6 && p.pos[i * 3 + 1] < 1.665;
      const cc = eye ? skin : c;
      color[i * 3] = cc.r; color[i * 3 + 1] = cc.g; color[i * 3 + 2] = cc.b;
    }
    chunks.push({ pos: p.pos, nor: p.nor, si: p.si, sw: p.sw, index: p.index, count: p.count, color, team: new Uint8Array(p.count).fill(team) });
  }
  // 직접 만든 장비: 팀 색 자리표시로 만들고 정점색으로 칸을 찾는다
  const accentC = solid(ACCENT_KEY), uniformC = solid(UNIFORM_KEY), strobeC = solid(STROBE_KEY);
  const gear = gearOf(look.kit, { accent: ACCENT_KEY, uniform: UNIFORM_KEY, strobe: STROBE_KEY, gear: new THREE.Color(colorOf(look, 'owner', 'gear')).getHex() });
  for (const [bone, geo] of gear) {
    const bi = tpl.boneIndex.get(bone);
    if (bi === undefined) throw new Error('장비를 붙일 뼈가 없어요: ' + bone);
    const n = geo.attributes.position.count;
    const si = new Uint8Array(n * 4), sw = new Float32Array(n * 4), team = new Uint8Array(n);
    const col = geo.attributes.color.array;
    for (let i = 0; i < n; i++) {
      si[i * 4] = bi; sw[i * 4] = 1;
      const near = (c) => Math.abs(col[i * 3] - c.r) + Math.abs(col[i * 3 + 1] - c.g) + Math.abs(col[i * 3 + 2] - c.b) < 1e-3;
      team[i] = near(accentC) ? 1 : near(uniformC) ? 2 : near(strobeC) ? 3 : 0;
    }
    chunks.push({ pos: geo.attributes.position.array, nor: geo.attributes.normal.array, si, sw, index: Array.from(geo.index.array), count: n, color: col, team });
  }
  let vc = 0, ic = 0;
  for (const c of chunks) { vc += c.count; ic += c.index.length; }
  const pos = new Float32Array(vc * 3), nor = new Float32Array(vc * 3), si = new Uint8Array(vc * 4), sw = new Float32Array(vc * 4);
  const color = new Float32Array(vc * 3), team = new Uint8Array(vc), index = vc < 65536 ? new Uint16Array(ic) : new Uint32Array(ic);
  let vo = 0, io = 0;
  for (const c of chunks) {
    pos.set(c.pos, vo * 3); nor.set(c.nor, vo * 3); si.set(c.si, vo * 4); sw.set(c.sw, vo * 4); color.set(c.color, vo * 3); team.set(c.team, vo);
    for (const x of c.index) index[io++] = x + vo;
    vo += c.count;
  }
  const shape = {
    position: new THREE.BufferAttribute(pos, 3), normal: new THREE.BufferAttribute(nor, 3),
    skinIndex: new THREE.BufferAttribute(si, 4), skinWeight: new THREE.BufferAttribute(sw, 4),
    index: new THREE.BufferAttribute(index, 1), color, team, triangles: ic / 3
  };
  tpl.shapes.set(key, shape);
  return shape;
}

/** 대원 × 팀 → SkinnedMesh 지오메트리. 위치·법선·뼈 속성은 두 팀이 같이 쓰고 색만 다르다 */
function geometryOf(tpl, id, team) {
  const t = TEAM_LOOK[team] ? team : 'owner';
  const look = lookOf(id);
  const k = OPERATOR_IDS.find((x) => lookOf(x) === look) + ':' + t;
  if (tpl.geos.has(k)) return tpl.geos.get(k);
  const shape = shapeOf(tpl, id);
  const T = teamLookOf(t);
  const accent = new THREE.Color(T.accent), uniform = new THREE.Color(T.uniform), strobe = new THREE.Color(T.accent).lerp(new THREE.Color(0xffffff), 0.55);
  const color = new Float32Array(shape.color);
  for (let i = 0; i < shape.team.length; i++) {
    const c = shape.team[i] === 1 ? accent : shape.team[i] === 2 ? uniform : shape.team[i] === 3 ? strobe : null;
    if (c) { color[i * 3] = c.r; color[i * 3 + 1] = c.g; color[i * 3 + 2] = c.b; }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', shape.position);
  g.setAttribute('normal', shape.normal);
  g.setAttribute('skinIndex', shape.skinIndex);
  g.setAttribute('skinWeight', shape.skinWeight);
  g.setAttribute('color', new THREE.BufferAttribute(color, 3));
  g.setIndex(shape.index);
  g.boundingSphere = tpl.cullSphere.clone();
  g.userData.triangles = shape.triangles;
  tpl.geos.set(k, g);
  return g;
}

/* ---------------- 회전 도우미 ---------------- */

const EUL = new THREE.Euler();
/** three.js Euler 'XYZ' → 쿼터니언(out) */
const qe = (x, y, z, out = new THREE.Quaternion()) => out.setFromEuler(EUL.set(x, y, z, 'XYZ'));
const BX = new THREE.Vector3(), BY = new THREE.Vector3(), BZ = new THREE.Vector3(), BM = new THREE.Matrix4();
/** 마디 방향 dir(위 → 아래)과 경첩 축 hinge로 리그 약속의 회전을 만든다: 로컬 -Y = dir, 로컬 X = hinge */
function segQuat(dir, hinge, out) {
  BY.copy(dir).negate().normalize();
  BX.copy(hinge).addScaledVector(BY, -hinge.dot(BY));
  if (BX.lengthSq() < 1e-8) BX.set(1, 0, 0).addScaledVector(BY, -BY.x);
  BX.normalize();
  BZ.crossVectors(BX, BY);
  return out.setFromRotationMatrix(BM.makeBasis(BX, BY, BZ));
}

/* ---------------- 아바타 하나의 몸 ---------------- */

const V = () => new THREE.Vector3();
const Q = () => new THREE.Quaternion();

export class OperatorBody {
  constructor(tpl, avatarId, team) {
    this.tpl = tpl;
    this.root = cloneRig(tpl.rigRoot);
    this.space = this.root.getObjectByName('operator:space');
    this.model = this.space.getObjectByName('operator:model');
    this.mesh = this.space.children.find((o) => o.isSkinnedMesh);
    this.mesh.castShadow = true;
    this.bones = {};
    this.model.traverse((o) => { if (o.isBone) this.bones[o.name] = o; });
    // 뼈 되돌리기 목록. 클립이 움직이는 뼈는 지난 갱신의 '클립 자세'(덮어쓰기 전)로, 나머지는 쉬는 자세로 되돌린다(restorePose)
    this.restBones = [];
    this.animBones = [];
    for (const name in this.bones) {
      const b = this.bones[name], r = tpl.rest.get(name);
      if (tpl.driven.has(name)) this.animBones.push(b); else this.restBones.push({ b, r });
    }
    this.animPose = new Float32Array(this.animBones.length * POSE_STRIDE);   // 뼈마다 위치 3 · 회전 4 · 크기 3
    this.animBones.forEach((b, i) => {
      const r = tpl.rest.get(b.name), o = i * POSE_STRIDE;
      r.lpos.toArray(this.animPose, o); r.lq.toArray(this.animPose, o + 3); r.lscale.toArray(this.animPose, o + 7);
    });
    this.avatarId = null; this.team = null;
    this.setLook(avatarId, team);

    this.mixer = new THREE.AnimationMixer(this.model);
    this.act = {};
    for (const [k, clip] of Object.entries(tpl.clips)) {
      const a = this.mixer.clipAction(clip);
      a.setEffectiveWeight(0);
      if (k === 'death') { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; }
      else a.timeScale = 0;   // 이동 클립은 시간을 직접 넣는다(걸음 위상을 맞춘다)
      a.play();
      this.act[k] = a;
    }
    this.idleT = 0;
    this.gait = 0;            // 이동 걸음 위상 0..1
    this.crouchGait = 0;      // 앉아 걷기 위상(라디안)
    this.weights = { idle: 1, walk: 0, run: 0, back: 0, left: 0, right: 0 };

    // 손 소켓(오른손목)·등 소켓(가슴)
    this.socket = new THREE.Group(); this.socket.name = 'operator:hand';
    this.tpl.sockets.gun.decompose(this.socket.position, this.socket.quaternion, this.socket.scale);
    this.bones.WristR.add(this.socket);
    this.backSocket = new THREE.Group(); this.backSocket.name = 'operator:back';
    this.tpl.sockets.back.decompose(this.backSocket.position, this.backSocket.quaternion, this.backSocket.scale);
    this.bones.Chest.add(this.backSocket);
    this.heldKey = 'gun';
    this.heldMesh = new THREE.Mesh(heldGeometry('gun'), tpl.material);
    this.heldMesh.castShadow = true;
    this.socket.add(this.heldMesh);
    this.custom = null;       // 무기 담당이 넘긴 3인칭 모형(setHeld)
    this.glasses = null;

    // 상태
    this.emote = 0; this.lastEmote = 0; this.emoteT = 0; this.emoteW = 0;
    this.swingT = -1; this.swingStab = false; this.swingDir = -1;
    this.recoilT = -1; this.reloadT = -1; this.reloadDur = 2; this.throwT = -1;
    this.dead = false; this.deathW = 0;
    this.pose = null;
    // 계산용
    this.v = Array.from({ length: 12 }, V);
    this.q = Array.from({ length: 12 }, Q);
  }

  /** 대원·팀 모양 바꾸기(지오메트리만 바꾼다. 뼈·동작은 그대로) */
  setLook(avatarId, team) {
    const geo = this.tpl.geometry(avatarId, team);
    if (this.mesh.geometry !== geo) this.mesh.geometry = geo;
    this.avatarId = avatarId; this.team = team;
  }

  /** 기본 든 무기(heldGeometry 이름: gun·knife·katana·…) */
  setHeldKey(key) {
    if (key === this.heldKey) return;
    this.heldKey = key;
    this.heldMesh.geometry = heldGeometry(key);
  }
  /** 무기 담당의 3인칭 모형(소켓 기준, 총구 = -Z). null이면 기본 모양 */
  setHeld(obj) {
    if (this.custom) this.custom.removeFromParent();
    this.custom = obj || null;
    this.heldMesh.visible = !this.custom;
    if (this.custom) this.heldMesh.parent.add(this.custom);
  }
  setAiGlasses(on) {
    if (!!on === !!this.glasses) return;
    if (on) {
      this.glasses = new THREE.Mesh(glassesGeometry(), this.tpl.material);
      this.tpl.sockets.glasses.decompose(this.glasses.position, this.glasses.quaternion, this.glasses.scale);
      this.bones.Head.add(this.glasses);
    } else {
      this.glasses.removeFromParent();
      this.glasses = null;
    }
  }

  swing(kind) {
    this.swingStab = kind === 'stab';
    if (!this.swingStab) this.swingDir = -this.swingDir;
    this.swingT = 0;
  }
  recoil() { this.recoilT = 0; }
  reload(sec = 2) { this.reloadT = 0; this.reloadDur = Math.max(0.4, +sec || 2); }
  throwNade() { this.throwT = 0; }

  /** 쓰러짐. dirLocal = 아바타 공간에서 쓰러질 방향 [x, z] */
  kill(dirLocal) {
    if (this.dead) return;
    this.dead = true;
    const want = dirLocal ? Math.atan2(dirLocal[0], dirLocal[1]) : 0;
    this.model.rotation.y = Math.PI + (dirLocal ? want - this.tpl.deathAngle : 0);
    const d = this.act.death;
    d.reset(); d.setLoop(THREE.LoopOnce, 1); d.clampWhenFinished = true; d.timeScale = 1; d.play();
    this.swingT = this.recoilT = this.reloadT = this.throwT = -1;
  }
  revive() {
    this.dead = false;
    this.deathW = 0;
    this.act.death.setEffectiveWeight(0);
    this.model.rotation.y = Math.PI;
    this.emote = 0; this.emoteW = 0;
  }

  /** 지금 들고 있는 것을 등(이모트)·손 중 어디에 둘지, 투척 중이면 잠깐 숨긴다 */
  placeHeld() {
    const held = this.custom || this.heldMesh;
    const target = this.emoteW > 0.5 ? this.backSocket : this.socket;
    if (held.parent !== target) target.add(held);
    held.visible = !(this.throwT > 0.04 && this.throwT < 0.85);
  }

  /* ---- 뼈 공간 도우미 ---- */

  /** 물체의 아바타 공간 회전(model부터 위로 곱한다) */
  avQ(obj, out) {
    out.identity();
    for (let o = obj; o && o !== this.space; o = o.parent) out.premultiply(o.quaternion);
    return out;
  }
  /** 뼈의 아바타 공간 위치(행렬이 갱신돼 있어야 한다) */
  avPos(bone, out) {
    bone.getWorldPosition(out);
    return this.space.worldToLocal(out);
  }
  /** 뼈를 아바타 공간 회전 q로(무게 w로 섞음) */
  setAv(bone, q, w) {
    const parentQ = this.avQ(bone.parent, this.q[11]);
    const local = parentQ.invert().multiply(q);
    if (w >= 0.999) bone.quaternion.copy(local);
    else if (w > 0) bone.quaternion.slerp(local, w);
  }
  /** R × (A) × 쉬는 회전 */
  restRot(name, R, A, out) {
    out.copy(R);
    if (A) out.multiply(A);
    return out.multiply(this.tpl.rest.get(name).q);
  }

  /* ---- 매 갱신 ---- */

  update(dt, inp = {}) {
    const tpl = this.tpl;
    this.root.updateMatrixWorld(true);
    const ck = this.dead ? 0 : Math.min(1, Math.max(0, inp.crouch || 0));
    this.stepTimers(dt, inp);
    const we = this.emoteW * this.emoteW * (3 - 2 * this.emoteW);
    this.deathW = this.dead ? Math.min(1, this.deathW + dt / 0.18) : 0;
    const live = 1 - this.deathW;

    // 이동 클립 섞기
    const mx = inp.moveX || 0, mz = inp.moveZ || 0;
    const speed = Math.hypot(mx, mz);
    const move = this.dead ? 0 : smooth(0.25, 1.1, speed) * (1 - ck);
    const W = this.weights;
    let f = 0, b = 0, l = 0, r = 0;
    if (speed > 1e-3) { f = Math.max(0, -mz) / speed; b = Math.max(0, mz) / speed; r = Math.max(0, mx) / speed; l = Math.max(0, -mx) / speed; }
    const sum = f + b + l + r || 1;
    f /= sum; b /= sum; l /= sum; r /= sum;
    const runK = smooth(2.4, 4.4, speed);
    const k = Math.min(1, dt * 10);
    const ease = (key, target) => { W[key] += (target - W[key]) * k; return W[key]; };
    ease('idle', 1 - move); ease('walk', move * f * (1 - runK)); ease('run', move * f * runK);
    ease('back', move * b); ease('left', move * l); ease('right', move * r);
    // 걸음 위상: 가장 큰 클립의 원래 속도에 맞춘다
    let dom = 'run', dw = -1;
    for (const key of ['walk', 'run', 'back', 'left', 'right']) if (W[key] > dw) { dw = W[key]; dom = key; }
    const scale = Math.min(2.2, Math.max(0.5, speed / tpl.speeds[dom]));
    if (speed > 0.05) this.gait = (this.gait + (dt * scale) / tpl.clips[dom].duration) % 1;
    this.idleT = (this.idleT + dt) % tpl.clips.idle.duration;
    for (const key of ['idle', 'walk', 'run', 'back', 'left', 'right']) {
      const a = this.act[key];
      a.time = key === 'idle' ? this.idleT : this.gait * tpl.clips[key].duration;
      a.setEffectiveWeight(W[key] * live);
    }
    this.act.death.setEffectiveWeight(this.deathW);
    this.restorePose();
    this.mixer.update(this.dead ? dt : 0);
    this.saveAnimPose();

    if (live > 0.001) {
      const ow = live * (1 - we);
      if (ow > 0.001) {
        const cw = ck * ow;
        if (cw > 0.001) this.crouchDrop(cw);
        this.poseAim(inp, ck, ow);
        if (cw > 0.001) this.crouchLegs(cw, speed > 0.3 ? [mx, mz] : null, dt);
      }
      if (we > 0.001) this.poseEmote(we * live);
    }
    this.placeHeld();
  }

  /**
   * 덮어쓰기(조준·앉기·이모트) 전의 자세로 뼈를 되돌린다. 클립이 움직이는 뼈는 지난 갱신의 클립 자세(saveAnimPose), 나머지는 쉬는 자세.
   * AnimationMixer는 섞은 값이 지난 갱신과 같으면 뼈에 쓰지 않는다. 그래서 쉬는 자세(T자)로 되돌리면 값이 멈춘 클립 —
   * 끝에서 멈춘 쓰러짐 동작(clampWhenFinished) — 은 다시 쓰이지 않고 T자로 서 있게 된다(쓰러진 몸이 서 있던 버그).
   * 지난 클립 자세로 되돌리면 믹서가 건너뛴 값도 이미 뼈에 있다.
   */
  restorePose() {
    for (const { b, r } of this.restBones) { b.position.copy(r.lpos); b.quaternion.copy(r.lq); b.scale.copy(r.lscale); }
    const P = this.animPose, list = this.animBones;
    for (let i = 0; i < list.length; i++) {
      const b = list[i], o = i * POSE_STRIDE;
      b.position.fromArray(P, o); b.quaternion.fromArray(P, o + 3); b.scale.fromArray(P, o + 7);
    }
  }
  /** mixer.update 직후, 덮어쓰기 전의 클립 자세를 적어 둔다(다음 갱신의 restorePose가 쓴다) */
  saveAnimPose() {
    const P = this.animPose, list = this.animBones;
    for (let i = 0; i < list.length; i++) {
      const b = list[i], o = i * POSE_STRIDE;
      b.position.toArray(P, o); b.quaternion.toArray(P, o + 3); b.scale.toArray(P, o + 7);
    }
  }

  stepTimers(dt, inp) {
    const code = this.dead ? 0 : inp.emote | 0;
    if (code !== this.emote) {
      if (code) { this.emoteT = 0; this.lastEmote = code; }
      this.emote = code;
    }
    if (this.emote || this.emoteW > 0) this.emoteT += dt;
    const target = this.emote ? 1 : 0, step = dt / EMOTE_BLEND;
    this.emoteW = this.emoteW < target ? Math.min(target, this.emoteW + step) : Math.max(target, this.emoteW - step);
    if (this.dead) this.emoteW = 0;
    if (this.swingT >= 0) { this.swingT += dt / (this.swingStab ? 0.46 : 0.34); if (this.swingT >= 1 || this.emote) this.swingT = -1; }
    if (this.recoilT >= 0) { this.recoilT += dt / 0.14; if (this.recoilT >= 1) this.recoilT = -1; }
    if (this.reloadT >= 0) { this.reloadT += dt / this.reloadDur; if (this.reloadT >= 1 || this.emote) this.reloadT = -1; }
    if (this.throwT >= 0) { this.throwT += dt / 0.62; if (this.throwT >= 1 || this.emote) this.throwT = -1; }
  }

  /** 상체 조준 + 총 든 두 팔(IK). 칼 휘두르기·반동·재장전·투척을 손 목표에 더한다 */
  poseAim(inp, ck, w) {
    const B = this.bones, tpl = this.tpl, [v0, v1, v2, v3, v4, v5, v6] = this.v, [q0, q1, q2, q3, q4, q5] = this.q;
    const aim = Math.max(-1.1, Math.min(1.1, inp.pitch || 0));
    // 칼 휘두르기 곡선(뒤로 뺀 뒤 빠르게 지나가고 천천히 돌아온다)
    let swRx = 0, swRy = 0, swRz = 0, swZ = 0, swTwist = 0;
    if (this.swingT >= 0) {
      const t = this.swingT;
      const ease = (a, b) => smooth(a, b, t);
      if (this.swingStab) {
        const back = ease(0, 0.26) * (1 - ease(0.26, 0.38)), thrust = ease(0.26, 0.42) * (1 - ease(0.58, 1));
        swZ = 0.08 * back - 0.16 * thrust; swRx = 0.28 * back - 0.12 * thrust; swTwist = 0.32 * (thrust - back);
      } else {
        const wind = ease(0, 0.2) * (1 - ease(0.2, 0.36)), cut = ease(0.2, 0.46) * (1 - ease(0.56, 1)), d = this.swingDir;
        swRy = d * (1.05 * cut - 0.75 * wind);
        swRx = d > 0 ? 0.42 * wind - 0.34 * cut : -0.2 * wind + 0.3 * cut;
        swRz = d * 0.25 * cut; swTwist = d * 0.34 * (cut - wind);
      }
    }
    const kick = this.recoilT >= 0 ? Math.sin(Math.PI * Math.min(1, this.recoilT * 1.6)) * (1 - this.recoilT) : 0;
    const lean = -SQUAT_LEAN * ck;

    // 몸통: 엉덩이(클립) 회전에서 가슴 목표 회전으로 나눠 굽힌다
    const Rh = this.avQ(B.Hips, q0).multiply(q1.copy(tpl.rest.get('Hips').q).invert());
    const Rc = qe(aim * 0.35 + lean, STANCE_TWIST + swTwist, 0, q1);
    this.setAv(B.Abdomen, this.restRot('Abdomen', q2.copy(Rh).slerp(Rc, 0.35), null, q3), w);
    this.setAv(B.Torso, this.restRot('Torso', q2.copy(Rh).slerp(Rc, 0.7), null, q3), w);
    this.setAv(B.Chest, this.restRot('Chest', Rc, null, q3), w);
    const Rhd = qe(aim * 0.85, 0, 0, q4);
    this.setAv(B.Neck, this.restRot('Neck', q2.copy(Rc).slerp(Rhd, 0.5), null, q3), w);
    this.setAv(B.Head, this.restRot('Head', Rhd, null, q3), w);
    this.setAv(B.ShoulderR, this.restRot('ShoulderR', Rc, null, q3), w);
    this.setAv(B.ShoulderL, this.restRot('ShoulderL', Rc, null, q3), w);
    this.model.updateMatrixWorld(true);

    // 총 든 틀 G: 앞을 보고 조준만큼 위아래(칼 휘두르기는 어깨 피벗 회전처럼 더한다)
    const G = qe(aim + 0.09 * kick, 0, 0, q5);
    const S = qe(swRx, swRy, swRz, q0);
    const chest = this.avPos(B.Chest, v0);
    const restChest = tpl.rest.get('Chest').pos;
    const palm = (hold, out) => out.set(hold[0] - restChest.x, hold[1] - restChest.y, hold[2] - restChest.z + swZ + 0.035 * kick).applyQuaternion(S).applyQuaternion(G).add(chest);
    const palmR = palm(HOLD_R, v1), palmL = palm(HOLD_L, v2);
    let gripR = 'grip', gripL = 'hold';
    // 손 틀(손가락이 앞): 오른손 손바닥 = 안쪽(-X), 왼손은 총몸을 받치게 조금 위로 돌린다
    const HR = q2.copy(G).multiply(S).multiply(qe(Math.PI / 2, 0, 0, q3));
    const HL = q4.copy(G).multiply(S).multiply(qe(Math.PI / 2, 0, -0.5, q3));
    // 재장전: 왼손이 허리 탄창 주머니로 갔다 오고, 총이 옆으로 기운다
    if (this.reloadT >= 0) {
      const t = this.reloadT, out = smooth(0.05, 0.3, t) * (1 - smooth(0.62, 0.9, t)), tilt = smooth(0, 0.15, t) * (1 - smooth(0.85, 1, t));
      v3.set(-0.12, 1.0, -0.12).sub(restChest).add(chest);
      palmL.lerp(v3, out);
      HR.multiply(qe(0, -0.5 * tilt, 0, q3));
      gripL = out > 0.5 ? 'fist' : 'hold';
    }
    // 던지기: 오른손을 머리 뒤로 젖혔다가 앞으로 뿌린다. 왼손은 앞을 가리킨다
    if (this.throwT >= 0) {
      const t = this.throwT, wind = smooth(0, 0.35, t) * (1 - smooth(0.35, 0.55, t)), rel = smooth(0.35, 0.55, t) * (1 - smooth(0.7, 1, t));
      v3.set(0.24, 1.66, 0.1).sub(restChest).add(chest);
      v4.set(0.16, 1.5, -0.42).sub(restChest).add(chest);
      palmR.lerp(v3, wind).lerp(v4, rel);
      v5.set(-0.02, 1.42, -0.4).sub(restChest).add(chest);
      palmL.lerp(v5, Math.max(wind, rel));
      HR.multiply(qe(-1.6 * wind + 0.4 * rel, 0, 0, q3));
      gripR = 'fist';
    }
    this.poseArm('R', palmR, HR, gripR, G, w, v6);
    this.poseArm('L', palmL, HL, gripL, G, w, v6);
  }

  /** 손바닥 목표·손 틀로 팔 한쪽을 IK로 놓는다 */
  poseArm(s, palm, H, shape, G, w, tmp) {
    const B = this.bones, L = this.tpl.limbs, A = this.tpl.align[s];
    const sign = s === 'R' ? 1 : -1;
    const shoulder = this.avPos(B['UpperArm' + s], this.v[7]);
    // 손바닥 → 손목: 손 틀에서 손가락 반대쪽으로, 손바닥 반대쪽으로 조금
    const wrist = this.v[8].set(sign * PALM_INSET, PALM_IN_HAND, 0).applyQuaternion(H).add(palm);
    const pole = this.v[9].set(sign * 0.4, -0.9, 0.15).applyQuaternion(G);
    const ik = solveTwoBone(shoulder.toArray(), wrist.toArray(), L.upperArm, L.foreArm, pole.toArray());
    this.setArm(s, ik.mid, ik.end, shoulder, H, shape, w, tmp);
  }

  /** 어깨·팔꿈치·손목 위치와 손 틀로 팔 뼈를 돌린다 */
  setArm(s, mid, end, shoulder, H, shape, w, tmp) {
    const B = this.bones, A = this.tpl.align[s];
    const u = this.v[10].set(mid[0], mid[1], mid[2]).sub(shoulder).normalize();
    const f = tmp.set(end[0] - mid[0], end[1] - mid[1], end[2] - mid[2]).normalize();
    const hinge = this.v[11].crossVectors(u, f);
    if (hinge.lengthSq() < 1e-6) hinge.set(1, 0, 0).applyQuaternion(H);
    const qa = this.q[6], qf = this.q[7], out = this.q[8];
    segQuat(u, hinge, qa);
    segQuat(f, hinge, qf);
    this.setAv(B['UpperArm' + s], this.restRot('UpperArm' + s, qa, A, out), w);
    this.setAv(B['LowerArm' + s], this.restRot('LowerArm' + s, qf, A, out), w);
    this.setAv(B['Wrist' + s], this.restRot('Wrist' + s, H, A, out), w);
    this.setFingers(s, H, shape, w);
  }

  /** 손가락 굽히기(손 틀 Z축 둘레, 손바닥 쪽으로) */
  setFingers(s, H, shape, w) {
    const B = this.bones, A = this.tpl.align[s];
    const sign = s === 'R' ? -1 : 1;
    const curl = SHAPES[shape] || SHAPES.fist;
    const R = this.q[9], c = this.q[10], out = this.q[8];
    for (const name of FINGERS) {
      let acc = 0;
      for (let i = 1; i <= 3; i++) {
        const fc = shape === 'L' && name === 'Index' ? 0.02 : (shape === 'L' ? SHAPES.fist : curl)[i - 1];
        acc += fc;
        R.copy(H).multiply(qe(0, 0, sign * acc, c));
        this.setAv(B[name + i + s], this.restRot(name + i + s, R, A, out), w);
      }
    }
    // 엄지: 'L'이면 바깥으로 펴고, 나머지는 조금 감는다
    const thumb = shape === 'L' ? -0.6 : shape === 'flat' ? 0 : 0.5;
    R.copy(H).multiply(qe(0, 0, sign * thumb * 0.5, c));
    this.setAv(B['Thumb2' + s], this.restRot('Thumb2' + s, R, A, out), w);
  }

  /** 앉은 자세 1: Body 뼈(엉덩이·다리의 부모)를 아바타 공간에서 낮추고 뒤로 뺀다 → 상체·손 목표가 따라 내려간다 */
  crouchDrop(w) {
    const B = this.bones, rest = this.tpl.rest;
    const drop = this.v[0].set(0, -SQUAT_DROP * w, SQUAT_BACK * w);
    const rootQ = this.avQ(B.Root, this.q[0]).invert();
    drop.applyQuaternion(rootQ).divideScalar(rest.get('Root').scale);
    B.Body.position.add(drop);
    this.model.updateMatrixWorld(true);
  }

  /** 앉은 자세 2: 두 다리를 IK로 접어 발을 땅에 둔다. move = 로컬 이동 [x, z](앉아 걷기) */
  crouchLegs(w, move, dt) {
    const B = this.bones, tpl = this.tpl, rest = tpl.rest;
    this.model.updateMatrixWorld(true);
    if (move) this.crouchGait += dt * Math.hypot(move[0], move[1]) * 7;
    const amp = move ? 1 : 0;
    const mdir = move ? this.v[1].set(move[0], 0, move[1]).normalize() : this.v[1].set(0, 0, 0);
    for (const s of ['R', 'L']) {
      const hip = this.avPos(B['UpperLeg' + s], this.v[2]);
      const ph = this.crouchGait + (s === 'R' ? 0 : Math.PI);
      const foot = this.v[3].copy(rest.get('Foot' + s).pos);
      foot.z -= 0.06;
      foot.addScaledVector(mdir, 0.13 * amp * Math.sin(ph));
      foot.y += 0.07 * amp * Math.max(0, Math.cos(ph));
      const ik = solveTwoBone(hip.toArray(), foot.toArray(), tpl.limbs.thigh, tpl.limbs.shin, [s === 'R' ? 0.15 : -0.15, 0, -1]);
      const u = this.v[4].fromArray(ik.mid).sub(hip).normalize();
      const f = this.v[5].fromArray(ik.end).sub(this.v[6].fromArray(ik.mid)).normalize();
      const hinge = this.v[6].crossVectors(f, u);
      if (hinge.lengthSq() < 1e-6) hinge.set(1, 0, 0);
      const A = tpl.align['leg' + s];
      this.setAv(B['UpperLeg' + s], this.restRot('UpperLeg' + s, segQuat(u, hinge, this.q[1]), A, this.q[2]), w);
      this.setAv(B['LowerLeg' + s], this.restRot('LowerLeg' + s, segQuat(f, hinge, this.q[1]), A, this.q[2]), w);
      // 발: 땅에 평평하게(쉬는 회전), 위치는 IK 끝
      const fb = B['Foot' + s];
      this.setAv(fb, this.q[3].copy(rest.get('Foot' + s).q), w);
      const p = this.v[7].fromArray(ik.end);
      this.space.localToWorld(p);
      fb.parent.worldToLocal(p);
      fb.position.lerp(p, w);
    }
  }

  /** 이모트 포즈(emoteanim, 리그 약속) → 온몸 뼈. 손이 머리·다른 손에 닿는 자세는 이 모델 몸에 맞게 손목 목표를 고쳐 IK로 놓는다 */
  poseEmote(w) {
    const code = this.emote || this.lastEmote;
    const p = this.pose = sampleEmote(code, this.emoteT, this.pose || undefined);
    if (!p) return;
    const B = this.bones, tpl = this.tpl, rest = tpl.rest;
    const [q0, q1, q2, q3, q4, q5] = this.q;
    const Mh = qe(p.rx, p.ry, p.rz, q0);
    const Mt = q1.copy(Mh).multiply(qe(p.torso[0], p.torso[1], p.torso[2], q5));
    const Mhd = q2.copy(Mt).multiply(qe(p.head[0], p.head[1], p.head[2], q5));
    const legs = {};
    for (const [s, k] of [[1, 'R'], [-1, 'L']]) {
      const l = sideRot(p['leg' + k], s);
      const Ml = Q().copy(Mh).multiply(qe(l[0], l[1], l[2], q5));
      const Mk = Q().copy(Ml).multiply(qe(-p['knee' + k], 0, 0, q5));
      legs[k] = { Ml, Mk };
    }
    // 발 붙이기: 이 모델 다리 길이로 발바닥 높이를 계산해 엉덩이를 올리고 내린다
    const body = this.v[0].copy(rest.get('Body').pos);
    body.x += p.x; body.z += p.z;
    const sole = {};
    let low = Infinity;
    for (const k of ['R', 'L']) {
      const A = tpl.align['leg' + k];
      const hip = V().copy(rest.get('UpperLeg' + k).pos).sub(rest.get('Body').pos).applyQuaternion(Mh).add(body);
      const knee = V().copy(rest.get('LowerLeg' + k).pos).sub(rest.get('UpperLeg' + k).pos).applyQuaternion(A).applyQuaternion(legs[k].Ml).add(hip);
      const foot = V().copy(rest.get('Foot' + k).pos).sub(rest.get('LowerLeg' + k).pos).applyQuaternion(A).applyQuaternion(legs[k].Mk).add(knee);
      sole[k] = foot;
      low = Math.min(low, foot.y);
    }
    const lift = rest.get('FootR').pos.y - low + p.air;
    body.y += lift;
    sole.R.y += lift; sole.L.y += lift;

    // 몸통·머리
    const slerp = (a, b, t) => q3.copy(a).slerp(b, t);
    const rootQ = this.avQ(B.Root, q4);
    this.setEmoteBone(B.Body, this.restRot('Body', Mh, null, q5), rootQ, w);
    const rootInv = q4.invert();
    const lp = this.v[1].copy(body).sub(this.avPos(B.Root, this.v[2])).applyQuaternion(rootInv).divideScalar(rest.get('Root').scale);
    B.Body.position.lerp(lp, w);
    B.Hips.position.lerp(rest.get('Hips').lpos, w);
    this.setAv(B.Hips, this.restRot('Hips', Mh, null, q5), w);
    this.setAv(B.Abdomen, this.restRot('Abdomen', slerp(Mh, Mt, 1 / 3), null, q5), w);
    this.setAv(B.Torso, this.restRot('Torso', slerp(Mh, Mt, 2 / 3), null, q5), w);
    this.setAv(B.Chest, this.restRot('Chest', Mt, null, q5), w);
    this.setAv(B.Neck, this.restRot('Neck', slerp(Mt, Mhd, 0.5), null, q5), w);
    this.setAv(B.Head, this.restRot('Head', Mhd, null, q5), w);
    this.setAv(B.ShoulderR, this.restRot('ShoulderR', Mt, null, q5), w);
    this.setAv(B.ShoulderL, this.restRot('ShoulderL', Mt, null, q5), w);

    // 다리·발
    for (const k of ['R', 'L']) {
      const A = tpl.align['leg' + k];
      this.setAv(B['UpperLeg' + k], this.restRot('UpperLeg' + k, legs[k].Ml, A, q5), w);
      this.setAv(B['LowerLeg' + k], this.restRot('LowerLeg' + k, legs[k].Mk, A, q5), w);
      const fb = B['Foot' + k];
      this.setAv(fb, this.restRot('Foot' + k, legs[k].Mk, null, q5), w);
      const fp = this.v[3].copy(sole[k]);
      this.space.localToWorld(fp);
      fb.parent.worldToLocal(fp);
      fb.position.lerp(fp, w);
    }
    this.model.updateMatrixWorld(true);

    // 팔: 각도를 그대로 옮긴 손목 위치에서 시작해, 리그에서 손이 머리·다른 손에 닿아 있으면 이 몸의 머리·두 손 가운데로 끌어온다
    const rig = fk(p);
    const head = this.v[4].fromArray(HEAD_CENTER).sub(rest.get('Head').pos).applyQuaternion(Mhd).add(this.avPos(B.Head, this.v[5]));
    const sR = this.avPos(B.UpperArmR, V()), sL = this.avPos(B.UpperArmL, V());
    const rigMid = [(rig.wristR[0] + rig.wristL[0]) / 2, (rig.wristR[1] + rig.wristL[1]) / 2, (rig.wristR[2] + rig.wristL[2]) / 2];
    const rigSh = [(rig.shoulderR[0] + rig.shoulderL[0]) / 2, (rig.shoulderR[1] + rig.shoulderL[1]) / 2, (rig.shoulderR[2] + rig.shoulderL[2]) / 2];
    const dHands = Math.hypot(rig.wristR[0] - rig.wristL[0], rig.wristR[1] - rig.wristL[1], rig.wristR[2] - rig.wristL[2]);
    const cHands = smooth(0.32, 0.14, dHands);
    const myMid = V().addVectors(sR, sL).multiplyScalar(0.5).add(V().set(rigMid[0] - rigSh[0], rigMid[1] - rigSh[1], rigMid[2] - rigSh[2]).multiplyScalar(0.72));
    for (const [s, k] of [[1, 'R'], [-1, 'L']]) {
      const A = tpl.align[k];
      const a = sideRot(p['arm' + k], s), h = sideRot(p['hand' + k], s);
      const Ma = Q().copy(Mt).multiply(qe(a[0], a[1], a[2], q5));
      const Mf = Q().copy(Ma).multiply(qe(p['fore' + k], 0, 0, q5));
      const Mw = Q().copy(Mf).multiply(qe(h[0], h[1], h[2], q5));
      const sh = k === 'R' ? sR : sL;
      const upperV = V().copy(rest.get('LowerArm' + k).pos).sub(rest.get('UpperArm' + k).pos).applyQuaternion(A);
      const foreV = V().copy(rest.get('Wrist' + k).pos).sub(rest.get('LowerArm' + k).pos).applyQuaternion(A);
      const elbow = V().copy(upperV).applyQuaternion(Ma).add(sh);
      const wrist = V().copy(foreV).applyQuaternion(Mf).add(elbow);
      const rw = rig['wrist' + k];
      const dHead = Math.hypot(rw[0] - rig.head[0], rw[1] - rig.head[1], rw[2] - rig.head[2]);
      const cHead = smooth(0.34, 0.2, dHead);
      if (cHead > 0.001 || cHands > 0.001) {
        const t = V().copy(wrist);
        if (cHands > 0.001) t.lerp(V().set(rw[0] - rigMid[0], rw[1] - rigMid[1], rw[2] - rigMid[2]).add(myMid), cHands);
        if (cHead > 0.001) t.lerp(V().set(rw[0] - rig.head[0], rw[1] - rig.head[1], rw[2] - rig.head[2]).add(head), cHead);
        const pole = V().subVectors(elbow, sh).addScaledVector(V().subVectors(wrist, sh).normalize(), -0.5);
        const ik = solveTwoBone(sh.toArray(), t.toArray(), tpl.limbs.upperArm, tpl.limbs.foreArm, pole.toArray());
        // 각도로 구한 마디 방향을 IK 방향으로 돌리는 최소 회전만 더한다(비틀림·손 모양은 그대로)
        const u0 = V().subVectors(elbow, sh).normalize(), f0 = V().subVectors(wrist, elbow).normalize();
        const u1 = V().fromArray(ik.mid).sub(sh).normalize(), f1 = V().fromArray(ik.end).sub(V().fromArray(ik.mid)).normalize();
        const handRel = Q().copy(Mf).invert().multiply(Mw);
        Ma.premultiply(Q().setFromUnitVectors(u0, u1));
        Mf.premultiply(Q().setFromUnitVectors(f0, f1));
        Mw.copy(Mf).multiply(handRel);
      }
      this.setAv(B['UpperArm' + k], this.restRot('UpperArm' + k, Ma, A, q5), w);
      this.setAv(B['LowerArm' + k], this.restRot('LowerArm' + k, Mf, A, q5), w);
      this.setAv(B['Wrist' + k], this.restRot('Wrist' + k, Mw, A, q5), w);
      const shape = p['shape' + k] === 'L' && k === 'R' ? 'L' : p['shape' + k] === 'flat' ? 'flat' : 'fist';
      this.setFingers(k, Mw, shape, w);
    }
  }

  /** Root 바로 아래 뼈(Body)를 아바타 공간 회전으로(부모 회전을 이미 알 때) */
  setEmoteBone(bone, q, parentQ, w) {
    const local = this.q[11].copy(parentQ).invert().multiply(q);
    if (w >= 0.999) bone.quaternion.copy(local); else bone.quaternion.slerp(local, w);
  }

  dispose() {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.model);
    // 복제한 뼈대는 몸마다 따로라 뼈 텍스처(boneTexture)를 여기서 지운다. 지오메트리·재질은 템플릿과 함께 쓰므로 두고 간다
    this.mesh.skeleton.dispose();
    this.root.removeFromParent();
  }
}
