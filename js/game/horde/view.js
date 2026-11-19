/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 좀비 물량 막기의 화면 쪽. 방장 스냅샷의 좀비·보스를 시간축으로 보간해 그리고(부위별 InstancedMesh라 수십 마리도 그리기 호출이 몇 개),
 *          투사체·장판·스킬 예고·폭발·바닥 보급품(탄창·구급 상자·보물 상자)·화염 수류탄 불길·어그로 분신을 보여 주며, 다친 좀비 머리 위 체력바와
 *          내가 준 피해 숫자(머리는 크고 노랗게, 몸은 작게)를 띄운다. 내 사격·칼·수류탄이 맞힌 좀비를 찾는다(World가 부른다). 모형은 상자 몇 개로 직접 만들었다.
 *          칼의 검기(빛나는 초승달)를 날려 내 검기가 지나간 좀비를 알리고, 쓰러진 동료 자리에 고리와 벽 너머로 보이는 이름표를 띄운다.
 */
import { ZF, BOSS_CODE_BASE, FIELD_KINDS } from './director.js';
import { zombieByCode, HORDE, LOOT_TYPES } from './rules.js';
import { bossByCode, SKILL_KINDS, HAZARD_KINDS, PROJECTILE_KINDS } from './bosses.js';
import { waveHitT, waveHitPoint, losReach } from './contact.js';

const MAX_Z = 96;               // 한 번에 그리는 좀비 상한(보스 포함)
const MAX_PROJ = 48;
const MAX_HAZ = 16;
const MAX_LOOT = HORDE.maxLoot + 4;
const LOOT_BLINK_MS = 5000;     // 사라지기 이만큼 전부터 깜박인다
// 보급품 모양(가로·높이·세로 m)과 바닥 고리 색
const LOOT_SIZE = Object.freeze({ mag: [0.3, 0.12, 0.2], med: [0.44, 0.26, 0.3], chest: [0.7, 0.46, 0.46] });
const LOOT_RING = Object.freeze({ mag: 0xffd34a, med: 0xff5c5c, chest: 0xffc83a });
const MAX_BARS = 48;            // 한 번에 그리는 체력바(다친 좀비·분신)
const BAR_RANGE = 40;           // 이 거리 안의 다친 좀비만 체력바를 띄운다
const MAX_NUMS = 28;            // 한 번에 떠 있는 피해 숫자
const MAX_DECOYS = 8;
const MAX_FIELDS = 12;
const MAX_WAVES = 16;           // 한 번에 나는 검기 상한(내 것·남의 것)
const MAX_REVIVE = 4;           // 한 번에 띄우는 쓰러진 동료 표시
// 검기: 속도(m/s)·판정 반지름(m)·검기 하나가 맞히는 좀비 상한(rules.js HORDE)
const WAVE_SPEED = HORDE.waveSpeed || 26;
const WAVE_R = HORDE.waveRadius || 0.7;
const WAVE_HITS = HORDE.waveMaxHits || 6;
const WAVE_FADE_MS = 160;       // 끝까지 갔거나 벽에 막힌 검기가 사라지는 시간
const WAVE_IN_M = 1.4;          // 이만큼 날아갈 때까지 커지며 또렷해진다(내 눈앞을 가리지 않게)
const WAVE_DT_MAX = 0.1;        // 한 프레임에 검기를 움직이는 최대 시간(초). 프레임이 끊겨도 순간이동하지 않는다
const REVIVE_HOLD_MS = HORDE.reviveHoldMs || 3000;
const REVIVE_RING_R = 0.95;     // 쓰러진 자리 고리 반지름(m)
const LABEL_W = 384;            // 쓰러진 동료 이름표 캔버스 폭(높이 64). 긴 닉네임과 '62%'가 한 줄에 들어가게
// 피해 숫자 모양: 머리는 크고 노랗게, 몸은 작게 하양, 다리는 더 작게, 칼은 하늘색, 수류탄은 주황(scale = 화면 높이 기준 크기)
const NUM_STYLE = Object.freeze({
  head: { color: '#ffd23a', scale: 0.085, dur: 950, rise: 0.8 },
  body: { color: '#ffffff', scale: 0.052, dur: 750, rise: 0.55 },
  legs: { color: '#d4dae2', scale: 0.046, dur: 700, rise: 0.5 },
  melee: { color: '#8ff3ff', scale: 0.064, dur: 800, rise: 0.6 },
  nade: { color: '#ff9a3c', scale: 0.066, dur: 900, rise: 0.7 }
});
const DELAY_MIN = 45, DELAY_MAX = 260;
const EXTRAP_MS = 140;
const RISE_MS = 650;
const FALL_MS = 520;
const HIT_FLASH_MS = 90;
const GROAN_MIN = 3500, GROAN_SPREAD = 6000;
const SKILL_CODE = Object.freeze(Object.fromEntries(Object.entries(SKILL_KINDS).map(([k, v]) => [v, k])));
const HAZ_COLOR = Object.freeze({ [HAZARD_KINDS.acid]: 0x7dff3a, [HAZARD_KINDS.fire]: 0xff7a1a, [HAZARD_KINDS.web]: 0xe8e2d0, [HAZARD_KINDS.frost]: 0x8fdcff, [HAZARD_KINDS.shock]: 0x6ff0ff });
const PROJ_COLOR = Object.freeze({ [PROJECTILE_KINDS.spit]: 0x9dff4a, [PROJECTILE_KINDS.acid]: 0x6dff2a, [PROJECTILE_KINDS.barrel]: 0x8a4b1c, [PROJECTILE_KINDS.web]: 0xf2ecdc, [PROJECTILE_KINDS.shard]: 0xbfeaff });
const PROJ_SIZE = Object.freeze({ [PROJECTILE_KINDS.barrel]: 0.34, [PROJECTILE_KINDS.shard]: 0.14 });

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
function lerpAngle(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

/* ------------------------------------------------------------------ 히트박스(모형 기준, 발 = 0, 정면 = -z) */
/** 서 있는 좀비 */
const HB_STAND = Object.freeze({ head: { y: 1.66, z: -0.03, r: 0.18 }, body: { y0: 0.9, y1: 1.52, hw: 0.28, hd: 0.2 }, legs: { y0: 0, y1: 0.9, hw: 0.25, hd: 0.17 } });
/** 기어 다니는 좀비(크롤러): 낮고 길다 */
const HB_LOW = Object.freeze({ head: { y: 0.55, z: -0.62, r: 0.17 }, body: { y0: 0.18, y1: 0.68, hw: 0.28, hd: 0.5 }, legs: { y0: 0, y1: 0.3, hw: 0.25, hd: 0.25 } });

function raySphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r) {
  const rx = ox - cx, ry = oy - cy, rz = oz - cz;
  const b = rx * dx + ry * dy + rz * dz;
  const c = rx * rx + ry * ry + rz * rz - r * r;
  if (c <= 0) return 0;
  if (b > 0) return -1;
  const disc = b * b - c;
  if (disc < 0) return -1;
  return -b - Math.sqrt(disc);
}
function rayBox(ox, oy, oz, dx, dy, dz, x0, y0, z0, x1, y1, z1) {
  let t0 = 0, t1 = Infinity;
  const o = [ox, oy, oz], d = [dx, dy, dz], lo = [x0, y0, z0], hi = [x1, y1, z1];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-9) { if (o[i] < lo[i] || o[i] > hi[i]) return -1; continue; }
    let a = (lo[i] - o[i]) / d[i], b = (hi[i] - o[i]) / d[i];
    if (a > b) { const q = a; a = b; b = q; }
    if (a > t0) t0 = a;
    if (b < t1) t1 = b;
    if (t0 > t1) return -1;
  }
  return t0;
}

/**
 * 검기 모형: 앞(-z)으로 볼록한 초승달 띠. 가로 ±0.85 m, 가운데 두께 0.34 m에서 양 끝으로 0이 되고 끝이 살짝 위로 휜다(뒤에서 보면 초승달).
 * 정점 색은 가운데 줄이 밝은 하늘색, 위아래 가장자리가 검정이라 더하기 혼합으로 그리면 가장자리가 부드럽게 사라진다
 */
function crescentGeometry(THREE) {
  const N = 18, W = 0.85, TH = Math.PI / 3, H = 0.34, BOW = 0.16;
  const rc = W / Math.sin(TH);
  const pos = [], col = [], idx = [];
  for (let i = 0; i <= N; i++) {
    const u = (i / N) * 2 - 1;
    const th = u * TH;
    const x = rc * Math.sin(th), z = rc * (1 - Math.cos(th));   // 가운데가 가장 앞(z = 0), 끝은 뒤로 처진다
    const taper = Math.cos((u * Math.PI) / 2);
    const h = H * taper, yc = BOW * u * u;
    pos.push(x, yc + h / 2, z, x, yc, z, x, yc - h / 2, z);
    const k = 0.3 + 0.7 * taper;
    col.push(0, 0.04, 0.06, 0.72 * k, 1 * k, 1 * k, 0, 0.04, 0.06);
  }
  for (let i = 0; i < N; i++) {
    const a = i * 3, b = (i + 1) * 3;
    idx.push(a, a + 1, b, b, a + 1, b + 1, a + 1, a + 2, b + 1, b + 1, a + 2, b + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

/**
 * @param {{ THREE, scene, fx?, play?(name, opts), shadows?: boolean }} o
 */
export function createHordeView(o) {
  const { THREE, scene } = o;
  const camera = o.camera || null;
  const fx = o.fx || null;
  const play = typeof o.play === 'function' ? o.play : () => null;
  let active = false;

  /* ---------- 모형(부위별 InstancedMesh) ---------- */
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const eyeMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const parts = {
    leg: new THREE.InstancedMesh(new THREE.BoxGeometry(0.2, 0.86, 0.22), mat, MAX_Z * 2),
    torso: new THREE.InstancedMesh(new THREE.BoxGeometry(0.54, 0.64, 0.32), mat, MAX_Z),
    head: new THREE.InstancedMesh(new THREE.BoxGeometry(0.32, 0.34, 0.32), mat, MAX_Z),
    arm: new THREE.InstancedMesh(new THREE.BoxGeometry(0.14, 0.14, 0.62), mat, MAX_Z * 2),
    eye: new THREE.InstancedMesh(new THREE.BoxGeometry(0.07, 0.045, 0.03), eyeMat, MAX_Z * 2),
    pad: new THREE.InstancedMesh(new THREE.ConeGeometry(0.12, 0.34, 5), mat, MAX_Z * 2)
  };
  for (const [name, m] of Object.entries(parts)) {
    m.name = 'horde:' + name;
    m.frustumCulled = false;         // 인스턴스가 맵 곳곳에 있어 기본 경계 구로 거르면 사라진다
    m.count = 0;
    m.castShadow = name !== 'eye';
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.setColorAt(0, new THREE.Color(1, 1, 1));
    m.instanceColor.setUsage(THREE.DynamicDrawUsage);
    m.visible = false;
    scene.add(m);
  }
  // 보스 발밑 고리
  const ringGeo = new THREE.RingGeometry(0.85, 1, 40);
  ringGeo.rotateX(-Math.PI / 2);
  const discGeo = new THREE.CircleGeometry(1, 40);
  discGeo.rotateX(-Math.PI / 2);
  const planeGeo = new THREE.PlaneGeometry(1, 1);
  planeGeo.rotateX(-Math.PI / 2);
  planeGeo.translate(0, 0, -0.5);    // 앞(-z)으로 길게
  function decalMat(color, opacity) {
    return new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
  }
  /** 다시 쓰는 장식(고리·원판·직사각형) 묶음 */
  function decalPool(geo, n, color, opacity) {
    const list = [];
    for (let i = 0; i < n; i++) {
      const m = new THREE.Mesh(geo, decalMat(color, opacity));
      m.visible = false; m.renderOrder = 2; m.name = 'horde:decal';
      scene.add(m);
      list.push(m);
    }
    let used = 0;
    return {
      begin() { used = 0; },
      take() { if (used >= list.length) return null; const m = list[used++]; m.visible = true; return m; },
      end() { for (let i = used; i < list.length; i++) list[i].visible = false; },
      dispose() { for (const m of list) { scene.remove(m); m.material.dispose(); } }
    };
  }
  const bossRings = decalPool(ringGeo, 4, 0xff3c3c, 0.6);
  const teleDiscs = decalPool(discGeo, 10, 0xff2a2a, 0.28);
  const teleRings = decalPool(ringGeo, 10, 0xff4a2a, 0.7);
  const teleRects = decalPool(planeGeo, 4, 0xff2a2a, 0.3);
  const hazDiscs = decalPool(discGeo, MAX_HAZ, 0x7dff3a, 0.32);
  const hazRings = decalPool(ringGeo, MAX_HAZ, 0x7dff3a, 0.65);
  // 장판 위로 피어오르는 색 입자. 한 InstancedMesh로 묶어 장판 수만큼 draw call이 늘지 않게 한다.
  const wispGeo = new THREE.CylinderGeometry(0.02, 0.11, 1, 5);
  const wispMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.65, depthWrite: false, blending: THREE.AdditiveBlending });
  const wisps = new THREE.InstancedMesh(wispGeo, wispMat, (MAX_HAZ + MAX_FIELDS) * 3);
  wisps.frustumCulled = false; wisps.count = 0; wisps.name = 'horde:field-wisps'; wisps.renderOrder = 3;
  wisps.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  wisps.setColorAt(0, new THREE.Color(1, 1, 1));
  wisps.instanceColor.setUsage(THREE.DynamicDrawUsage);
  scene.add(wisps);
  const fxRings = decalPool(ringGeo, 12, 0xffffff, 0.6);
  // 바닥 보급품: 종류별 색 상자와 발밑 고리(밤 맵에서도 보이게 고리는 빛나는 색)
  const lootMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const lootMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), lootMat, MAX_LOOT);
  lootMesh.frustumCulled = false; lootMesh.count = 0; lootMesh.name = 'horde:loot'; lootMesh.visible = false; lootMesh.castShadow = true;
  lootMesh.setColorAt(0, new THREE.Color(1, 1, 1));
  scene.add(lootMesh);
  const lootRings = decalPool(ringGeo, MAX_LOOT, 0xffffff, 0.6);
  // 화염 수류탄 불길(바닥 원판 두 겹이 일렁인다)과 어그로 분신(푸른 반투명 사람 + 발밑 고리)
  const fireDiscs = decalPool(discGeo, MAX_FIELDS, 0xff5a12, 0.38);
  const fireRings = decalPool(ringGeo, MAX_FIELDS, 0xffc24a, 0.7);
  const decoyRings = decalPool(ringGeo, MAX_DECOYS, 0x5ee8ff, 0.7);
  const decoyMat = new THREE.MeshLambertMaterial({ color: 0x5ee8ff, emissive: 0x1a6f8a, transparent: true, opacity: 0.72, depthWrite: false });
  const decoyBodyGeo = new THREE.CylinderGeometry(0.24, 0.2, 1.3, 10);
  decoyBodyGeo.translate(0, 0.65, 0);
  const decoyHeadGeo = new THREE.SphereGeometry(0.2, 12, 10);
  decoyHeadGeo.translate(0, 1.55, 0);
  const decoyMeshes = [];
  for (let i = 0; i < MAX_DECOYS; i++) {
    const g = new THREE.Group();
    g.add(new THREE.Mesh(decoyBodyGeo, decoyMat), new THREE.Mesh(decoyHeadGeo, decoyMat));
    g.visible = false; g.name = 'horde:decoy';
    scene.add(g);
    decoyMeshes.push(g);
  }
  // 체력바: 카메라를 보는 납작한 판 두 겹(바탕·채움) InstancedMesh → 그리기 호출 두 번
  const barGeo = new THREE.PlaneGeometry(1, 1);
  const barBgMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.6, depthWrite: false });
  const barFgMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, depthWrite: false });
  const barBg = new THREE.InstancedMesh(barGeo, barBgMat, MAX_BARS);
  const barFg = new THREE.InstancedMesh(barGeo, barFgMat, MAX_BARS);
  for (const m of [barBg, barFg]) {
    m.frustumCulled = false; m.count = 0; m.name = 'horde:hpbar'; m.visible = false; m.renderOrder = 4;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(m);
  }
  barFg.setColorAt(0, new THREE.Color(1, 1, 1));
  const bars = [];                   // 이번 프레임에 그릴 체력바 { x, y, z, w, frac, color }
  const BQ = new THREE.Quaternion(), BP = new THREE.Vector3(), BS = new THREE.Vector3(), BR = new THREE.Vector3();
  // 피해 숫자: 캔버스 글자 스프라이트(필요할 때 만들어 다시 쓴다). 화면 크기가 거리와 상관없이 같다
  const nums = [];
  const projMesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0xffffff }), MAX_PROJ);
  projMesh.frustumCulled = false; projMesh.count = 0; projMesh.name = 'horde:proj'; projMesh.visible = false;
  projMesh.setColorAt(0, new THREE.Color(1, 1, 1));
  scene.add(projMesh);
  // 연쇄 번개 선
  const zapMat = new THREE.LineBasicMaterial({ color: 0x9ff8ff, transparent: true, opacity: 0.95 });
  const zaps = [];
  // 검기: 빛나는 초승달(더하기 혼합, 사라질 때 흐려지게 검기마다 재질 하나). 풀로 다시 쓴다
  const waveGeo = crescentGeometry(THREE);
  const waves = [];
  const candZ = new Array(MAX_Z).fill(null), candT = new Float64Array(MAX_Z);   // 이번 프레임 검기 구간에 닿은 좀비(가까운 순)
  const WC = [0, 0, 0], WP = [0, 0, 0];                                         // 검기 벽 가림 검사의 두 점(다시 쓴다)
  const WX = new THREE.Vector3(), WY = new THREE.Vector3(), WZ = new THREE.Vector3(), WM = new THREE.Matrix4();
  // 쓰러진 동료: 바닥의 빨간 고리(맥박), 살리는 만큼 커지는 초록 원판, 벽 너머로도 보이는 이름표
  const reviveRings = decalPool(ringGeo, MAX_REVIVE, 0xff3c3c, 0.7);
  const reviveDiscs = decalPool(discGeo, MAX_REVIVE, 0x4dff7a, 0.45);
  const reviveLabels = [];

  /* ---------- 상태 ---------- */
  const ents = new Map();            // 좀비 번호 → { hist: [{t, pos, yaw, f, hp}], ... }
  let lastPushAt = 0, interval = 100, delay = 120;
  let bosses = [], projectiles = [], projAt = 0, hazards = [], hazAt = 0, loot = [], lootAt = 0, fields = [], fieldAt = 0, decoys = [], decoyAt = 0;
  let wispCount = 0;
  const seenFx = new Set();
  const fxAnims = [];                // { kind, pos, r, at, color }
  const rendered = [];               // 이번 프레임에 그린 좀비(사격 판정용)
  let myHits = new Map();            // 좀비 번호 → 마지막 피격 시각(번쩍임)
  let downs = [], downAt = 0;        // 쓰러진 동료 { id, name, pos, progress, by } (마지막으로 받은 뷰, 나는 빼고)

  const M = new THREE.Matrix4(), T = new THREE.Matrix4(), Rm = new THREE.Matrix4(), S = new THREE.Matrix4(), P = new THREE.Matrix4();
  const C = new THREE.Color(), C2 = new THREE.Color(), SKC = new THREE.Color(), CLC = new THREE.Color();
  const DARK = new THREE.Color(0x111111);

  function setActive(on) {
    active = !!on;
    if (!active) clear();
    for (const m of Object.values(parts)) m.visible = active;
    projMesh.visible = active;
    lootMesh.visible = active;
    wisps.visible = active;
    barBg.visible = barFg.visible = active;
  }

  /** 방장 뷰(applyHordeSnapshot) 하나를 받은 시각 t(performance.now 기준)에 넣는다. meId = 내 id(내 쓰러진 자리 표시는 띄우지 않는다) */
  function push(view, t = performance.now(), meId = null) {
    if (!active || !view) return;
    // 쓰러진 동료(접속 중, 나는 빼고): 쓰러진 자리와 살리는 진행도
    const me = meId == null ? null : String(meId);
    downs = [];
    downAt = t;
    for (const p of Array.isArray(view.players) ? view.players : []) {
      if (downs.length >= MAX_REVIVE) break;
      const d = p && !p.alive && p.connected ? p.down : null;
      if (!d || !Array.isArray(d.pos) || String(p.id) === me) continue;
      const pos = [Number(d.pos[0]), Number(d.pos[1]), Number(d.pos[2])];
      if (!Number.isFinite(pos[0] + pos[1] + pos[2])) continue;
      downs.push({ id: String(p.id), name: String(p.name || ''), pos, progress: clamp(Number(d.progress) || 0, 0, 1), by: d.by == null ? null : String(d.by) });
    }
    if (lastPushAt) interval = lerp(interval, clamp(t - lastPushAt, 16, 600), 0.2);
    lastPushAt = t;
    delay = clamp(interval * 1.45, DELAY_MIN, DELAY_MAX);
    const seen = new Set();
    for (const z of view.zombies) {
      seen.add(z.id);
      let e = ents.get(z.id);
      if (!e) {
        const boss = z.boss || null, type = z.type || null;
        e = {
          id: z.id, boss, type, s: boss ? boss.scale : type ? type.scale : 1, low: !!(type && type.low), hist: [], firstAt: t, riseAt: (z.flags & ZF.rise) ? t : -1e9,
          deadAt: z.dead ? t - FALL_MS : 0, walk: Math.random() * 6, prev: null, groanAt: t + GROAN_MIN * Math.random(), lastF: z.flags, hp: z.hpFrac, flashAt: -1e9,
          fallDir: Math.random() < 0.5 ? 1 : -1
        };
        ents.set(z.id, e);
        if (z.flags & ZF.rise) play('zombie_rise', { pos: z.pos });
        if (boss) play('boss_roar', { pos: z.pos });
      }
      const f = z.flags;
      if ((f & ZF.dead) && !e.deadAt) { e.deadAt = t; play(e.boss ? 'boss_down' : 'zombie_die', { pos: z.pos }); }
      if ((f & ZF.rise) && !(e.lastF & ZF.rise)) e.riseAt = t;
      if ((f & ZF.wind) && !(e.lastF & ZF.wind) && !e.boss) play('zombie_attack', { pos: z.pos });
      if (z.hpFrac < e.hp - 1e-3) e.flashAt = t;
      e.hp = z.hpFrac;
      e.lastF = f;
      e.hist.push({ t, pos: z.pos, yaw: z.yaw, f });
      if (e.hist.length > 6) e.hist.shift();
    }
    for (const [id, e] of ents) if (!seen.has(id)) { if (!e.goneAt) e.goneAt = t; }
    bosses = view.bosses || [];
    projectiles = view.projectiles || []; projAt = t;
    hazards = view.hazards || []; hazAt = t;
    loot = view.loot || []; lootAt = t;
    fields = view.fields || []; fieldAt = t;
    decoys = view.decoys || []; decoyAt = t;
    for (const x of view.fx || []) {
      if (seenFx.has(x.id)) continue;
      seenFx.add(x.id);
      if (x.ago > 400) continue;
      startFx(x);
    }
    if (seenFx.size > 400) { const keep = [...seenFx].slice(-200); seenFx.clear(); for (const k of keep) seenFx.add(k); }
  }

  /** 폭발·내려찍기 같은 한 번짜리 연출 */
  function startFx(x) {
    const p = x.pos;
    switch (x.kind) {
      case 'blast': case 'barrel': case 'bomber':
        if (fx && fx.explosion) fx.explosion(p, { radius: Math.max(2.5, x.r) });
        play('explosion', { pos: p });
        break;
      case 'slam': case 'nova': case 'shock':
        fxAnims.push({ kind: 'ring', pos: p, r: x.r, at: performance.now(), dur: x.kind === 'slam' ? 450 : 900, color: x.kind === 'shock' ? 0x6ff0ff : 0xffb27a });
        play(x.kind === 'shock' ? 'zap' : 'ground_slam', { pos: p });
        break;
      case 'scream': fxAnims.push({ kind: 'ring', pos: p, r: x.r, at: performance.now(), dur: 700, color: 0xdff4ff }); break;
      case 'summon': fxAnims.push({ kind: 'ring', pos: p, r: x.r + 1, at: performance.now(), dur: 900, color: 0x8a5cff }); break;
      case 'heal': fxAnims.push({ kind: 'ring', pos: p, r: x.r, at: performance.now(), dur: 800, color: 0x5cffb0 }); break;
      case 'blink': fxAnims.push({ kind: 'ring', pos: p, r: 1.4, at: performance.now(), dur: 380, color: 0xb36bff }); break;
      case 'chain': fxAnims.push({ kind: 'ring', pos: p, r: x.r, at: performance.now(), dur: 420, color: 0xffd36b }); if (fx && fx.explosion) fx.explosion(p, { radius: 2 }); break;
      case 'splat': if (fx && fx.impact) fx.impact(p, [0, 1, 0], 'grass'); play('acid_splash', { pos: p }); break;
      case 'decoy': fxAnims.push({ kind: 'ring', pos: p, r: 2.2, at: performance.now(), dur: 600, color: 0x5ee8ff }); break;
      case 'decoyEnd': fxAnims.push({ kind: 'ring', pos: p, r: 1.8, at: performance.now(), dur: 500, color: 0x9ff4ff }); break;
      default: break;
    }
  }

  /** 방장 이벤트 중 화면 연출이 필요한 것(스킬 예고 소리·연쇄 번개) */
  function event(ev) {
    if (!active || !ev) return;
    if (ev.type === 'skill') {
      const e = ents.get(ev.z);
      const pos = e && e.hist.length ? e.hist[e.hist.length - 1].pos : null;
      play(ev.kind === 'chain' ? 'zap' : ev.kind === 'volley' && ev.boss === 'frost' ? 'ice_crack' : 'boss_skill', pos ? { pos } : undefined);
    } else if (ev.type === 'chain' && Array.isArray(ev.pts)) {
      const pts = ev.pts.map((q) => new THREE.Vector3(q[0], q[1], q[2]));
      const jag = [];
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        for (let k = 0; k <= 6; k++) {
          const u = k / 6;
          const v = a.clone().lerp(b, u);
          if (k > 0 && k < 6) v.add(new THREE.Vector3((Math.random() - 0.5) * 0.6, (Math.random() - 0.5) * 0.6, (Math.random() - 0.5) * 0.6));
          jag.push(v);
        }
      }
      const g = new THREE.BufferGeometry().setFromPoints(jag);
      const line = new THREE.Line(g, zapMat);
      line.name = 'horde:zap';
      scene.add(line);
      zaps.push({ line, at: performance.now() });
      play('zap', { pos: ev.pts[ev.pts.length - 1] });
    } else if (ev.type === 'enrage') {
      const e = ents.get(ev.z);
      if (e && e.hist.length) play('boss_roar', { pos: e.hist[e.hist.length - 1].pos });
    } else if (ev.type === 'bossSpawn') {
      // 등장 포효는 처음 보는 보스 행에서 낸다(push)
    }
  }

  /** 내 사격이 이 좀비를 맞혔다(방장 확인 전, 번쩍임만) */
  function noteHit(id) { myHits.set(zombieNumber(id), performance.now()); }
  const zombieNumber = (v) => { const s = String(v); return s[0] === 'z' ? Number(s.slice(1)) | 0 : Number(s) | 0; };

  /* ---------- 보간 ---------- */
  function sample(e, rt) {
    const h = e.hist;
    if (!h.length) return null;
    if (rt <= h[0].t) return { pos: h[0].pos.slice(), yaw: h[0].yaw, f: h[0].f };
    for (let i = h.length - 1; i > 0; i--) {
      const a = h[i - 1], b = h[i];
      if (rt >= a.t && rt <= b.t) {
        const u = b.t > a.t ? (rt - a.t) / (b.t - a.t) : 1;
        // 순간이동(방장이 다시 내보냄·보스 순간이동)은 보간하지 않는다
        const jump = Math.hypot(b.pos[0] - a.pos[0], b.pos[2] - a.pos[2]) > 6;
        const k = jump ? (u < 0.5 ? 0 : 1) : u;
        return { pos: [lerp(a.pos[0], b.pos[0], k), lerp(a.pos[1], b.pos[1], k), lerp(a.pos[2], b.pos[2], k)], yaw: lerpAngle(a.yaw, b.yaw, k), f: b.f };
      }
    }
    const last = h[h.length - 1];
    if (h.length >= 2 && !(last.f & ZF.dead)) {
      const prev = h[h.length - 2];
      const span = Math.max(16, last.t - prev.t);
      const ex = Math.min(EXTRAP_MS, rt - last.t) / span;
      if (Math.hypot(last.pos[0] - prev.pos[0], last.pos[2] - prev.pos[2]) < 6) {
        return { pos: [last.pos[0] + (last.pos[0] - prev.pos[0]) * ex, last.pos[1], last.pos[2] + (last.pos[2] - prev.pos[2]) * ex], yaw: last.yaw, f: last.f };
      }
    }
    return { pos: last.pos.slice(), yaw: last.yaw, f: last.f };
  }

  /* ---------- 그리기 ---------- */
  let ni = { leg: 0, torso: 0, head: 0, arm: 0, eye: 0, pad: 0 };
  function put(part, m, color) {
    const mesh = parts[part];
    const i = ni[part]++;
    if (i >= mesh.instanceMatrix.count) return;
    mesh.setMatrixAt(i, m);
    mesh.setColorAt(i, color);
  }
  function partM(base, x, y, z, rx, ry, rz, offY = 0, offZ = 0) {
    T.makeTranslation(x, y, z);
    Rm.makeRotationFromEuler(tmpE.set(rx, ry, rz, 'YXZ'));
    P.copy(base).multiply(T).multiply(Rm);
    if (offY || offZ) { T.makeTranslation(0, offY, offZ); P.multiply(T); }
    return P;
  }
  const tmpE = new THREE.Euler();

  function drawZombie(e, smp, now, dt) {
    const f = smp.f;
    const s = e.s;
    const boss = e.boss, type = e.type;
    const dead = e.deadAt > 0;
    // 걷는 박자: 그린 위치가 움직인 만큼
    let speed = 0;
    if (e.prev) speed = Math.hypot(smp.pos[0] - e.prev[0], smp.pos[2] - e.prev[2]) / Math.max(1e-3, dt);
    e.prev = smp.pos;
    if (!dead) e.walk += dt * clamp(speed, 0, 9) * 2.4 / Math.max(0.6, s);
    const swing = Math.sin(e.walk) * clamp(speed / 2.5, 0, 1) * 0.6;
    const riseK = clamp((now - e.riseAt) / RISE_MS, 0, 1);
    const fallK = dead ? clamp((now - e.deadAt) / FALL_MS, 0, 1) : 0;
    const sink = dead ? clamp((now - e.deadAt - 700) / 700, 0, 1) * 0.9 : 0;
    const wind = !!(f & ZF.wind) && !dead;
    // 몸 기준 행렬
    M.makeTranslation(smp.pos[0], smp.pos[1] - (1 - riseK) * 1.7 * s - sink * s, smp.pos[2]);
    Rm.makeRotationY(smp.yaw);
    M.multiply(Rm);
    S.makeScale(s, s, s);
    M.multiply(S);
    if (dead) {
      // 뒤로(또는 옆으로) 넘어진다
      T.makeTranslation(0, 0.1, 0);
      Rm.makeRotationFromEuler(tmpE.set(fallK * 1.45, 0, fallK * 0.25 * e.fallDir, 'YXZ'));
      M.multiply(Rm);
    }
    // 색
    const skin = boss ? boss.color : type ? type.color : 0x6f8f4e;
    const cloth = boss ? boss.accent : type ? type.cloth : 0x4d4a3e;
    const flash = now - Math.max(e.flashAt, myHits.get(e.id) || -1e9) < HIT_FLASH_MS;
    C.setHex(skin);
    const frozen = !!(f & ZF.frozen) && !dead;
    if (frozen) C.lerp(C2.setHex(0xbfefff), 0.7);
    if (f & ZF.slow) C.lerp(C2.setHex(0x8fdcff), 0.35);
    if (f & ZF.haste) C.lerp(C2.setHex(0xff5a3c), 0.25);
    if (f & ZF.armor) C.lerp(C2.setHex(0xb8c4d0), 0.55);
    if (flash) C.lerp(C2.setHex(0xffffff), 0.7);
    const skinC = SKC.copy(C);
    if (boss) C.setHex(skin).lerp(DARK, 0.35); else C.setHex(cloth);
    if (frozen) C.lerp(C2.setHex(0xa8e6ff), 0.6);
    if (flash) C.lerp(C2.setHex(0xffffff), 0.6);
    const clothC = CLC.copy(C);
    if (e.low) {
      // 크롤러: 몸을 눕혀 앞으로 기어간다
      put('torso', partM(M, 0, 0.42, -0.1, -1.35, 0, 0), clothC);
      put('head', partM(M, 0, 0.5, -0.62, -0.2, 0, 0), skinC);
      put('leg', partM(M, -0.14, 0.25, 0.35, -1.45 + swing * 0.5, 0, 0, -0.35), clothC);
      put('leg', partM(M, 0.14, 0.25, 0.35, -1.45 - swing * 0.5, 0, 0, -0.35), clothC);
      put('arm', partM(M, -0.3, 0.32, -0.45, -0.25 - swing * 0.6 + (wind ? 0.9 : 0), 0, 0, 0, -0.25), skinC);
      put('arm', partM(M, 0.3, 0.32, -0.45, -0.25 + swing * 0.6 + (wind ? 0.9 : 0), 0, 0, 0, -0.25), skinC);
      C.setHex(wind ? 0xff2a2a : 0xfff27a);
      put('eye', partM(M, -0.07, 0.53, -0.79, 0, 0, 0), C);
      put('eye', partM(M, 0.07, 0.53, -0.79, 0, 0, 0), C);
      return;
    }
    if (type && type.flying) {
      // Airborne feet are already in the snapshot position. Keep the torso and head
      // on the standing hitboxes, while the legs fold back and the arms form wings.
      put('torso', partM(M, 0, 1.2, 0, -0.12, 0, 0), clothC);
      put('head', partM(M, 0, 1.67, -0.08, -0.05, 0, 0), skinC);
      put('leg', partM(M, -0.13, 0.88, 0.12, -1.15, 0, 0, -0.43), clothC);
      put('leg', partM(M, 0.13, 0.88, 0.12, -1.15, 0, 0, -0.43), clothC);
      const flap = Math.sin(now * 0.009 + e.walk) * 0.18;
      put('arm', partM(M, -0.35, 1.43, -0.04, wind ? 0.4 : 0, 1.35, -0.18 - flap, 0, -0.65).multiply(S.makeScale(1.4, 1.5, 2.2)), clothC);
      put('arm', partM(M, 0.35, 1.43, -0.04, wind ? 0.4 : 0, -1.35, 0.18 + flap, 0, -0.65).multiply(S.makeScale(1.4, 1.5, 2.2)), clothC);
      C.setHex(wind ? 0xff2a2a : 0xfff27a);
      put('eye', partM(M, -0.075, 1.71, -0.25, 0, 0, 0), C);
      put('eye', partM(M, 0.075, 1.71, -0.25, 0, 0, 0), C);
      return;
    }
    const lean = boss ? 0.12 : 0.22;
    put('leg', partM(M, -0.13, 0.88, 0, swing, 0, 0, -0.43), clothC);
    put('leg', partM(M, 0.13, 0.88, 0, -swing, 0, 0, -0.43), clothC);
    put('torso', partM(M, 0, 1.2, 0, -lean, 0, Math.sin(e.walk * 0.5) * 0.05), clothC);
    put('head', partM(M, 0, 1.67, -0.08, -lean * 0.4 + Math.sin(e.walk * 0.7 + 1) * 0.08, Math.sin(e.walk * 0.33) * 0.2, 0.12 * Math.sin(e.walk * 0.21)), skinC);
    // 팔: 앞으로 뻗고(0 = 수평) 걸을 때 흔들, 공격 예고면 위로 들었다가 내리친다
    const armUp = wind ? 1.15 : -0.08 + Math.sin(e.walk + 0.5) * 0.12;
    put('arm', partM(M, -0.34, 1.43, -0.05, armUp + swing * 0.2, 0.08, 0, 0, -0.29), skinC);
    put('arm', partM(M, 0.34, 1.43, -0.05, armUp - swing * 0.2, -0.08, 0, 0, -0.29), skinC);
    const rage = !!(f & ZF.rage);
    C.setHex(boss ? (rage ? 0xff1a1a : boss.accent) : wind ? 0xff2a2a : 0xfff27a);
    put('eye', partM(M, -0.075, 1.71, -0.25, 0, 0, 0), C);
    put('eye', partM(M, 0.075, 1.71, -0.25, 0, 0, 0), C);
    if (boss) {
      C.setHex(boss.accent);
      if (rage) C.lerp(C2.setHex(0xff2a2a), 0.5);
      put('pad', partM(M, -0.3, 1.58, 0.02, 0, 0, 0.5), C);
      put('pad', partM(M, 0.3, 1.58, 0.02, 0, 0, -0.5), C);
    }
  }

  /** 한 프레임 그리기. frozen이면 검기를 멈춰 둔다(시뮬레이션 일시정지: 멈춘 좀비를 맞히지 않게) */
  function frame(dt, now = performance.now(), frozen = false) {
    if (!active) return;
    for (const k of Object.keys(ni)) ni[k] = 0;
    rendered.length = 0;
    bars.length = 0;
    const rt = now - delay;
    const cam = camera ? camera.position : null;
    bossRings.begin();
    for (const [id, e] of ents) {
      // 사라진 지 오래되었거나 쓰러진 뒤 다 가라앉으면 지운다
      if ((e.goneAt && now - e.goneAt > (e.deadAt ? 1500 : delay + 200)) || (e.deadAt && now - e.deadAt > 1500)) { ents.delete(id); myHits.delete(id); continue; }
      const smp = sample(e, rt);
      if (!smp) continue;
      drawZombie(e, smp, now, dt);
      if (!e.deadAt) {
        const riseK = clamp((now - e.riseAt) / RISE_MS, 0, 1);
        rendered.push({ id: e.id, x: smp.pos[0], y: smp.pos[1] - (1 - riseK) * 1.7 * e.s, z: smp.pos[2], yaw: smp.yaw, s: e.s, low: e.low, boss: !!e.boss, rising: riseK < 1 });
        // 다친 좀비는 머리 위 체력바(보스는 화면 위 막대가 따로 있어도 같이 띄운다)
        if (e.hp < 0.999 && riseK >= 1 && (!cam || Math.hypot(cam.x - smp.pos[0], cam.z - smp.pos[2]) < BAR_RANGE)) {
          const top = (e.low ? 0.95 : 2.08) * e.s + (e.boss ? 0.2 : 0);
          bars.push({ x: smp.pos[0], y: smp.pos[1] + top, z: smp.pos[2], w: (e.boss ? 1.5 : 0.78) * Math.min(1.5, e.s), frac: e.hp, color: e.boss ? 0xff3c6e : e.hp > 0.6 ? 0x6be36b : e.hp > 0.3 ? 0xffd23a : 0xff4a3a });
        }
        if (now >= e.groanAt) { e.groanAt = now + GROAN_MIN + Math.random() * GROAN_SPREAD; play('zombie_groan', { pos: [smp.pos[0], smp.pos[1] + 1.5 * e.s, smp.pos[2]], gain: e.boss ? 1 : 0.7 }); }
        if (e.boss) {
          const r = bossRings.take();
          if (r) {
            r.position.set(smp.pos[0], smp.pos[1] + 0.04, smp.pos[2]);
            r.scale.setScalar(e.s * 0.85);
            r.material.color.setHex(e.boss.accent);
            r.material.opacity = 0.45 + 0.2 * Math.sin(now / 160);
          }
        }
      }
    }
    bossRings.end();
    for (const [k, m] of Object.entries(parts)) {
      m.count = Math.min(ni[k], m.instanceMatrix.count);
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
    stepWaves(dt, now, frozen);        // 이번 프레임에 그린 좀비로 판정한다(맞히면 피해 숫자가 이 프레임에 뜬다)
    drawTelegraphs(now);
    drawProjectiles(now);
    wispCount = 0;
    drawHazards(now);
    drawFields(now);
    wisps.count = wispCount;
    wisps.instanceMatrix.needsUpdate = true;
    if (wisps.instanceColor) wisps.instanceColor.needsUpdate = true;
    drawDecoys(now);
    drawLoot(now);
    drawRevives(now);
    drawFx(now);
    drawBars();
    drawNumbers(now);
  }

  /** 바닥 장판에서 위로 떠오르는 입자 세 개. 위치·크기·색만 프레임마다 갱신한다. */
  function drawWisps(f, now, color, height) {
    for (let j = 0; j < 3 && wispCount < wisps.instanceMatrix.count; j++) {
      const u = (now * 0.0008 + f.id * 0.17 + j / 3) % 1;
      const a = f.id * 2.4 + j * 2.094 + now * 0.0003;
      const radius = f.r * (0.2 + 0.38 * u);
      M.makeTranslation(f.pos[0] + Math.cos(a) * radius, f.pos[1] + 0.12 + u * height, f.pos[2] + Math.sin(a) * radius);
      const width = 1.8 * (1 - 0.6 * u);
      S.makeScale(width, 0.3 + 0.35 * (1 - u), width);
      wisps.setMatrixAt(wispCount, M.multiply(S));
      wisps.setColorAt(wispCount++, C.setHex(color).multiplyScalar(1 - 0.7 * u));
    }
  }

  /** 화염 수류탄 불길: 주황 원판이 일렁이고 테두리가 빛난다. 꺼지기 0.6초 전부터 흐려진다 */
  function drawFields(now) {
    fireDiscs.begin(); fireRings.begin();
    const dt = now - fieldAt;
    for (const f of fields) {
      if (f.kind !== FIELD_KINDS.fire) continue;
      const left = f.leftMs - dt;
      if (left <= 0) continue;
      const fade = Math.min(1, left / 600);
      drawWisps(f, now, 0xff7a1a, 1.4);
      const d = fireDiscs.take();
      if (d) {
        d.position.set(f.pos[0], f.pos[1] + 0.035, f.pos[2]);
        d.scale.setScalar(f.r * (0.94 + 0.06 * Math.sin(now / 90 + f.id)));
        d.material.opacity = fade * (0.32 + 0.12 * Math.sin(now / 70 + f.id * 3));
      }
      const r = fireRings.take();
      if (r) {
        r.position.set(f.pos[0], f.pos[1] + 0.05, f.pos[2]);
        r.scale.setScalar(f.r);
        r.material.opacity = fade * (0.55 + 0.25 * Math.sin(now / 120 + f.id));
      }
    }
    fireDiscs.end(); fireRings.end();
  }

  /** 어그로 분신: 푸른 반투명 사람과 발밑 고리, 머리 위 체력바 */
  function drawDecoys(now) {
    decoyRings.begin();
    const dt = now - decoyAt;
    let n = 0;
    for (const d of decoys) {
      if (n >= decoyMeshes.length || d.leftMs - dt <= 0) continue;
      const g = decoyMeshes[n++];
      g.visible = true;
      g.position.set(d.pos[0], d.pos[1], d.pos[2]);
      g.rotation.y = now / 900;
      const r = decoyRings.take();
      if (r) {
        r.position.set(d.pos[0], d.pos[1] + 0.04, d.pos[2]);
        r.scale.setScalar(0.9 + 0.15 * Math.sin(now / 160));
        r.material.opacity = 0.5 + 0.25 * Math.sin(now / 140);
      }
      bars.push({ x: d.pos[0], y: d.pos[1] + 2.05, z: d.pos[2], w: 0.9, frac: d.hpFrac, color: 0x5ee8ff });
    }
    for (let i = n; i < decoyMeshes.length; i++) decoyMeshes[i].visible = false;
    decoyRings.end();
  }

  /** 체력바: 카메라 쪽을 보게 돌리고, 채움은 왼쪽에 붙여 남은 체력만큼 늘인다 */
  function drawBars() {
    const n = Math.min(bars.length, MAX_BARS);
    if (camera) BQ.copy(camera.quaternion); else BQ.identity();
    BR.set(1, 0, 0).applyQuaternion(BQ);
    const h = 0.085;
    for (let i = 0; i < n; i++) {
      const b = bars[i];
      BP.set(b.x, b.y, b.z);
      BS.set(b.w + 0.05, h + 0.04, 1);
      M.compose(BP, BQ, BS);
      barBg.setMatrixAt(i, M);
      const fw = Math.max(0.001, b.w * clamp(b.frac, 0, 1));
      BP.set(b.x, b.y, b.z).addScaledVector(BR, -(b.w - fw) / 2);
      BS.set(fw, h, 1);
      M.compose(BP, BQ, BS);
      barFg.setMatrixAt(i, M);
      barFg.setColorAt(i, C.setHex(b.color));
    }
    barBg.count = barFg.count = n;
    barBg.instanceMatrix.needsUpdate = true;
    barFg.instanceMatrix.needsUpdate = true;
    if (barFg.instanceColor) barFg.instanceColor.needsUpdate = true;
  }

  /* ---------- 피해 숫자 ---------- */
  function makeNum() {
    const canvas = document.createElement('canvas');
    canvas.width = 128; canvas.height = 64;
    const tex = new THREE.CanvasTexture(canvas);
    const sm = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, sizeAttenuation: false, fog: false });
    const sp = new THREE.Sprite(sm);
    sp.renderOrder = 12; sp.visible = false; sp.name = 'horde:dmg';
    scene.add(sp);
    return { sp, canvas, g: canvas.getContext('2d'), tex, at: -1e9, dur: 1, alive: false, x: 0, y: 0, z: 0, style: NUM_STYLE.body };
  }
  /** 좀비에게 준 피해 숫자 하나를 pos 위에 띄운다. kind = 'head' | 'body' | 'legs' | 'melee' | 'nade' */
  function damageNumber(pos, amount, kind) {
    if (!active || !pos || typeof document === 'undefined') return;
    const v = Math.max(0, Math.round(Number(amount) || 0));
    if (!v) return;
    const style = NUM_STYLE[kind] || NUM_STYLE.body;
    let n = nums.find((x) => !x.alive);
    if (!n) n = nums.length < MAX_NUMS ? (nums.push(makeNum()), nums[nums.length - 1]) : nums.reduce((a, b) => (a.at < b.at ? a : b));
    const g = n.g;
    g.clearRect(0, 0, 128, 64);
    g.font = '900 44px system-ui, -apple-system, "Segoe UI", sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineJoin = 'round'; g.lineWidth = 8; g.strokeStyle = 'rgba(0, 0, 0, 0.85)';
    g.strokeText(String(v), 64, 34);
    g.fillStyle = style.color;
    g.fillText(String(v), 64, 34);
    n.tex.needsUpdate = true;
    n.x = pos[0] + (Math.random() - 0.5) * 0.35; n.y = pos[1] + 0.1; n.z = pos[2] + (Math.random() - 0.5) * 0.35;
    n.at = performance.now(); n.dur = style.dur; n.style = style; n.alive = true;
    n.sp.visible = true;
  }
  function drawNumbers(now) {
    for (const n of nums) {
      if (!n.alive) continue;
      const u = (now - n.at) / n.dur;
      if (u >= 1) { n.alive = false; n.sp.visible = false; continue; }
      const pop = u < 0.12 ? 1 + (1 - u / 0.12) * 0.45 : 1;   // 처음에 살짝 크게 튀어나온다
      const s = n.style.scale * pop;
      n.sp.scale.set(s * 2, s, 1);
      n.sp.position.set(n.x, n.y + n.style.rise * (1 - (1 - u) * (1 - u)), n.z);
      n.sp.material.opacity = u < 0.6 ? 1 : 1 - (u - 0.6) / 0.4;
    }
  }

  /** 바닥 보급품: 천천히 돌며 떠 있고, 사라지기 5초 전부터 깜박인다 */
  function drawLoot(now) {
    lootRings.begin();
    let n = 0;
    for (const L of loot) {
      if (n >= MAX_LOOT) break;
      const left = L.leftMs - (now - lootAt);
      if (left <= 0) continue;
      if (left < LOOT_BLINK_MS && Math.floor(now / 180) % 2) continue;
      const sz = LOOT_SIZE[L.kind] || LOOT_SIZE.mag;
      const y = L.pos[1] + 0.22 + sz[1] / 2 + 0.05 * Math.sin(now / 320 + L.id);
      M.makeTranslation(L.pos[0], y, L.pos[2]);
      Rm.makeRotationY(now / 650 + L.id);
      S.makeScale(sz[0], sz[1], sz[2]);
      M.multiply(Rm).multiply(S);
      lootMesh.setMatrixAt(n, M);
      lootMesh.setColorAt(n, C.setHex((LOOT_TYPES[L.kind] || LOOT_TYPES.mag).color));
      n++;
      const r = lootRings.take();
      if (r) {
        r.position.set(L.pos[0], L.pos[1] + 0.03, L.pos[2]);
        r.scale.setScalar(0.42);
        r.material.color.setHex(LOOT_RING[L.kind] || 0xffffff);
        r.material.opacity = 0.45 + 0.25 * Math.sin(now / 200 + L.id);
      }
    }
    lootMesh.count = n;
    lootMesh.instanceMatrix.needsUpdate = true;
    if (lootMesh.instanceColor) lootMesh.instanceColor.needsUpdate = true;
    lootRings.end();
  }

  /** 보스 스킬 예고: 떨어질 자리 원, 돌진 길, 내려찍기·충격파 고리 */
  function drawTelegraphs(now) {
    teleDiscs.begin(); teleRings.begin(); teleRects.begin();
    for (const b of bosses) {
      const e = ents.get(b.id);
      if (!e || !b.skill) continue;
      const kind = SKILL_CODE[b.skill];
      const sk = b.def.skills.find((s) => s.kind === kind) || {};
      const bp = e.prev || (e.hist.length ? e.hist[e.hist.length - 1].pos : null);
      if (!bp) continue;
      const tx = b.target[0], tz = b.target[1];
      const blink = 0.55 + 0.35 * Math.sin(now / 70);
      if (b.skillPhase === 1) {
        if (kind === 'leap' || kind === 'pool' || kind === 'volley') {
          const d = teleDiscs.take();
          if (d) {
            const r = kind === 'leap' ? sk.radius || 4 : kind === 'pool' ? (sk.hazard && sk.hazard.r) || 3 : (sk.pool && sk.pool.r) || (sk.blast && sk.blast.r) || 1.8;
            d.position.set(tx, groundNear(bp[1]) + 0.05, tz);
            d.scale.setScalar(r);
            d.material.opacity = 0.18 + 0.2 * blink;
          }
        } else if (kind === 'charge') {
          const rect = teleRects.take();
          if (rect) {
            const dx = tx - bp[0], dz = tz - bp[2], len = Math.max(4, Math.hypot(dx, dz) + 4);
            rect.position.set(bp[0], bp[1] + 0.05, bp[2]);
            rect.rotation.set(0, Math.atan2(-dx, -dz), 0);
            rect.scale.set(sk.width || 1.6, 1, Math.min(len, (sk.speed || 15) * ((sk.maxMs || 1000) / 1000)));
            rect.material.opacity = 0.16 + 0.22 * blink;
          }
        } else if (kind === 'slam' || kind === 'nova' || kind === 'scream' || kind === 'summon' || kind === 'heal') {
          const r = teleRings.take();
          if (r) {
            const rr = sk.radius || 5;
            r.position.set(bp[0], bp[1] + 0.06, bp[2]);
            r.scale.setScalar(rr);
            r.material.color.setHex(kind === 'heal' ? 0x5cffb0 : kind === 'summon' ? 0x8a5cff : 0xff4a2a);
            r.material.opacity = 0.35 + 0.4 * blink;
          }
        }
      } else if (b.skillPhase === 2 && kind === 'nova') {
        const r = teleRings.take();
        if (r) {
          r.position.set(bp[0], bp[1] + 0.08, bp[2]);
          r.scale.setScalar(Math.max(0.5, b.ringR));
          r.material.color.setHex(sk.shock ? 0x6ff0ff : 0xffb27a);
          r.material.opacity = 0.9;
        }
      } else if (b.skillPhase === 2 && kind === 'leap') {
        const d = teleDiscs.take();
        if (d) { d.position.set(tx, groundNear(bp[1]) + 0.05, tz); d.scale.setScalar(sk.radius || 4); d.material.opacity = 0.42; }
      }
    }
    teleDiscs.end(); teleRings.end(); teleRects.end();
  }
  /** 바닥 높이를 모를 때 쓰는 근사(보스 발 높이) */
  const groundNear = (y) => y;

  function drawProjectiles(now) {
    const dt = (now - projAt) / 1000;
    let n = 0;
    for (const p of projectiles) {
      if (n >= MAX_PROJ) break;
      const t = Math.min(dt, 0.6);
      const x = p.pos[0] + p.vel[0] * t, z = p.pos[2] + p.vel[2] * t;
      const y = p.pos[1] + p.vel[1] * t + (p.arc ? 0.5 * -12 * t * t : 0);
      const sz = PROJ_SIZE[p.kind] || 0.2;
      M.makeTranslation(x, y, z);
      S.makeScale(sz, sz, sz);
      M.multiply(S);
      projMesh.setMatrixAt(n, M);
      projMesh.setColorAt(n, C.setHex(PROJ_COLOR[p.kind] || 0x9dff4a));
      n++;
    }
    projMesh.count = n;
    projMesh.instanceMatrix.needsUpdate = true;
    if (projMesh.instanceColor) projMesh.instanceColor.needsUpdate = true;
  }

  function drawHazards(now) {
    hazDiscs.begin(); hazRings.begin();
    const dt = now - hazAt;
    for (const h of hazards) {
      const left = h.leftMs - dt;
      if (left <= 0) continue;
      const d = hazDiscs.take();
      if (!d) break;
      d.position.set(h.pos[0], h.pos[1] + 0.03, h.pos[2]);
      d.scale.setScalar(h.r);
      const color = HAZ_COLOR[h.kind] || 0x7dff3a;
      d.material.color.setHex(color);
      d.material.opacity = Math.min(1, left / 600) * (0.26 + 0.08 * Math.sin(now / 210 + h.id));
      const ring = hazRings.take();
      if (ring) {
        ring.position.set(h.pos[0], h.pos[1] + 0.05, h.pos[2]);
        ring.scale.setScalar(h.r);
        ring.material.color.setHex(color);
        ring.material.opacity = Math.min(1, left / 600) * (0.5 + 0.15 * Math.sin(now / 180 + h.id));
      }
      drawWisps(h, now, color, h.kind === HAZARD_KINDS.fire ? 1.4 : 0.9);
    }
    hazDiscs.end(); hazRings.end();
  }

  function drawFx(now) {
    fxRings.begin();
    for (let i = fxAnims.length - 1; i >= 0; i--) {
      const a = fxAnims[i];
      const u = (now - a.at) / a.dur;
      if (u >= 1) { fxAnims.splice(i, 1); continue; }
      const r = fxRings.take();
      if (!r) continue;
      r.position.set(a.pos[0], a.pos[1] + 0.1, a.pos[2]);
      r.scale.setScalar(Math.max(0.3, a.r * (0.25 + 0.75 * u)));
      r.material.color.setHex(a.color);
      r.material.opacity = 0.8 * (1 - u);
    }
    fxRings.end();
    for (let i = zaps.length - 1; i >= 0; i--) {
      const z = zaps[i];
      const u = (now - z.at) / 320;
      if (u >= 1) { scene.remove(z.line); z.line.geometry.dispose(); zaps.splice(i, 1); continue; }
    }
    zapMat.opacity = zaps.length ? 0.95 : 0;
  }

  /* ---------- 쓰러진 동료 표시 ---------- */
  function makeReviveLabel() {
    const canvas = document.createElement('canvas');
    canvas.width = LABEL_W; canvas.height = 64;
    const tex = new THREE.CanvasTexture(canvas);
    if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
    const sm = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, sizeAttenuation: false, fog: false });
    const sp = new THREE.Sprite(sm);
    sp.renderOrder = 13; sp.visible = false; sp.name = 'horde:revive';
    // 화면 높이 기준 크기(거리와 상관없이 같다). 글자가 몸 피해 숫자만 하게(작은 화면에서도 읽히게)
    sp.scale.set(0.08 * LABEL_W / 64, 0.08, 1);
    scene.add(sp);
    return { sp, canvas, g: canvas.getContext('2d'), tex, text: '' };
  }
  /** 이름표 글자를 다시 그린다(글자가 바뀔 때만). busy = 누군가 살리는 중(초록) */
  function paintReviveLabel(L, text, busy) {
    const g = L.g;
    L.text = text;
    if (!g) return;
    g.clearRect(0, 0, LABEL_W, 64);
    g.font = '800 42px "Noto Sans KR", "Malgun Gothic", system-ui, sans-serif';
    const tw = Math.min(LABEL_W - 8, g.measureText(text).width + 30);
    g.fillStyle = busy ? 'rgba(8, 40, 18, 0.78)' : 'rgba(44, 8, 8, 0.72)';
    g.beginPath();
    if (g.roundRect) g.roundRect((LABEL_W - tw) / 2, 5, tw, 54, 16); else g.rect((LABEL_W - tw) / 2, 5, tw, 54);
    g.fill();
    g.fillStyle = busy ? '#8dffaa' : '#ff9d9d';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(text, LABEL_W / 2, 33, LABEL_W - 24);
    L.tex.needsUpdate = true;
  }
  /** 쓰러진 동료 자리: 맥박 치는 빨간 고리, 살리는 만큼 커지는 초록 원판(받은 진행도에서 이어서 늘린다), 머리 위 이름표 */
  function drawRevives(now) {
    reviveRings.begin(); reviveDiscs.begin();
    const pulse = 0.5 + 0.5 * Math.sin(now / 170);
    let n = 0;
    for (const d of downs) {
      const r = reviveRings.take();
      if (r) {
        r.position.set(d.pos[0], d.pos[1] + 0.05, d.pos[2]);
        r.scale.setScalar(REVIVE_RING_R * (0.92 + 0.1 * pulse));
        r.material.opacity = 0.4 + 0.45 * pulse;
      }
      let prog = d.progress;
      if (d.by && prog > 0) prog = Math.min(1, prog + Math.min(0.15, Math.max(0, now - downAt) / REVIVE_HOLD_MS));
      if (prog > 0.001) {
        const disc = reviveDiscs.take();
        if (disc) {
          disc.position.set(d.pos[0], d.pos[1] + 0.04, d.pos[2]);
          disc.scale.setScalar(REVIVE_RING_R * 0.88 * prog);
          disc.material.opacity = 0.5;
        }
      }
      if (typeof document === 'undefined') continue;
      if (n >= reviveLabels.length) reviveLabels.push(makeReviveLabel());
      const L = reviveLabels[n++];
      const busy = !!d.by;
      const text = busy ? `✚ ${d.name} ${Math.round(d.progress * 100)}%` : `✚ ${d.name}`;
      if (L.text !== text) paintReviveLabel(L, text, busy);
      L.sp.visible = true;
      L.sp.position.set(d.pos[0], d.pos[1] + 1.1, d.pos[2]);
    }
    for (let i = n; i < reviveLabels.length; i++) reviveLabels[i].sp.visible = false;
    reviveRings.end(); reviveDiscs.end();
  }

  /* ---------- 검기 ---------- */
  function waveSlot() {
    let free = null, oldest = null;
    for (const w of waves) {
      if (!w.on) { free = w; break; }
      if (!oldest || w.age > oldest.age) oldest = w;
    }
    if (free) return free;
    if (waves.length < MAX_WAVES) {
      const mat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
      const mesh = new THREE.Mesh(waveGeo, mat);
      mesh.name = 'horde:wave'; mesh.visible = false; mesh.renderOrder = 5;
      scene.add(mesh);
      const w = { mesh, mat, on: false, local: false, stab: false, ox: 0, oy: 0, oz: 0, dx: 0, dy: 0, dz: -1, range: 0, stop: 0, dist: 0, wait: 0, age: 0, fade: -1, hits: 0, hit: [], exclude: -1, onHit: null, seed: 0 };
      waves.push(w);
      return w;
    }
    endWave(oldest);
    return oldest;
  }
  function endWave(w) {
    w.on = false;
    w.onHit = null;
    w.los = null;
    w.hit.length = 0;
    w.mesh.visible = false;
  }

  /**
   * 검기 하나를 날린다. o = { origin:[x,y,z], dir:[x,y,z], range, local, kind:'wave'|'waveStab', exclude:'z12'|null, los(a,b), onHit(hit), delayMs? }
   * HORDE.waveSpeed로 날아가 range나 벽(los가 false인 곳)에서 멈춘다. local이면 이번 프레임에 그린 좀비를 한 번씩, HORDE.waveMaxHits마리까지 맞히고
   * onHit({ id:'z12', dist(출발점에서 날아간 거리), point, boss })를 부른다(exclude는 건너뛴다). 남의 검기(local:false)는 보이기만 한다
   * → 날렸으면 true
   */
  function wave(o) {
    if (!active || !o || !o.origin || !o.dir) return false;
    const ox = Number(o.origin[0]), oy = Number(o.origin[1]), oz = Number(o.origin[2]);
    let dx = Number(o.dir[0]), dy = Number(o.dir[1]), dz = Number(o.dir[2]);
    const dl = Math.hypot(dx, dy, dz);
    if (!Number.isFinite(ox + oy + oz) || !(dl > 1e-6)) return false;
    dx /= dl; dy /= dl; dz /= dl;
    const range = clamp(Number(o.range) || 0, 0, 60);
    if (!(range > 0)) return false;
    const w = waveSlot();
    w.on = true;
    w.local = !!o.local;
    w.stab = o.kind === 'waveStab';
    w.ox = ox; w.oy = oy; w.oz = oz; w.dx = dx; w.dy = dy; w.dz = dz;
    w.range = range;
    w.los = typeof o.los === 'function' ? o.los : null;
    w.stop = w.los ? losReach(w.los, [ox, oy, oz], [dx, dy, dz], range) : range;
    w.dist = 0; w.age = 0; w.fade = -1; w.hits = 0; w.hit.length = 0;
    w.wait = Math.max(0, Number(o.delayMs) || 0);
    w.exclude = o.exclude == null || o.exclude === '' ? -1 : zombieNumber(o.exclude);
    w.onHit = w.local && typeof o.onHit === 'function' ? o.onHit : null;
    w.seed = Math.random() * 100;
    // 방향: 모형의 -z를 진행 방향으로, x를 수평 오른쪽으로. 찌르기는 진행 방향을 축으로 90° 돌려 세운다
    WX.set(-dz, 0, dx);
    if (WX.lengthSq() < 1e-8) WX.set(1, 0, 0); else WX.normalize();
    WY.set(WX.y * dz - WX.z * dy, WX.z * dx - WX.x * dz, WX.x * dy - WX.y * dx);
    WZ.set(-dx, -dy, -dz);
    if (w.stab) { WX.negate(); WM.makeBasis(WY, WX, WZ); } else WM.makeBasis(WX, WY, WZ);
    w.mesh.quaternion.setFromRotationMatrix(WM);
    w.mesh.visible = false;
    return true;
  }

  /** 검기 하나가 이번 프레임에 d0 → d1을 지나며 닿은 좀비(가까운 순, 상한까지)를 알린다 */
  function waveHits(w, d0, d1) {
    let n = 0;
    // 수평 진행 방향(앞뒤 판정용). 거의 수직으로 휘두르면 앞뒤를 가리지 않는다
    const hl = Math.hypot(w.dx, w.dz);
    for (const z of rendered) {
      if (n >= candZ.length) break;
      if (z.id === w.exclude || w.hit.includes(z.id)) continue;
      // 검기는 앞으로만 날아간다: 출발점보다 뒤(옆 포함)에 선 좀비는 처음 겹쳐 있어도 맞지 않는다
      if (hl > 0.2 && ((z.x - w.ox) * w.dx + (z.z - w.oz) * w.dz) / hl <= 0) continue;
      const t = waveHitT(w.ox, w.oy, w.oz, w.dx, w.dy, w.dz, d0, d1, z, WAVE_R);
      if (t < 0) continue;
      let i = n++;
      while (i > 0 && candT[i - 1] > t) { candZ[i] = candZ[i - 1]; candT[i] = candT[i - 1]; i--; }
      candZ[i] = z; candT[i] = t;
    }
    for (let i = 0; i < n; i++) {
      const z = candZ[i];
      candZ[i] = null;
      if (w.hits >= WAVE_HITS || !w.onHit) continue;
      const point = waveHitPoint(w.ox, w.oy, w.oz, w.dx, w.dy, w.dz, candT[i], z, WAVE_R);
      // 벽 너머: 닿은 순간의 검기 중심에서 좀비 몸이 보여야 맞는다(가려졌으면 다음 프레임에 다시 본다)
      if (w.los) {
        const t = candT[i];
        WC[0] = w.ox + w.dx * t; WC[1] = w.oy + w.dy * t; WC[2] = w.oz + w.dz * t;
        WP[0] = z.x; WP[1] = point[1]; WP[2] = z.z;
        let clear = true;
        try { clear = !!w.los(WC, WP); } catch (e) { clear = false; }
        if (!clear) continue;
      }
      w.hits++;
      w.hit.push(z.id);
      try { w.onHit({ id: 'z' + z.id, dist: candT[i], point, boss: !!z.boss }); } catch (e) { console.error('[horde] 검기', e); }
    }
  }

  /** 검기를 움직이고(frozen이면 그대로) 그린다. 내 검기는 지나간 구간의 좀비를 맞힌다 */
  function stepWaves(dt, now, frozen) {
    const ms = Math.min(Math.max(0, Number(dt) || 0), WAVE_DT_MAX) * 1000;
    for (const w of waves) {
      if (!w.on) continue;
      if (!frozen) {
        if (w.wait > 0) w.wait -= ms;
        else {
          w.age += ms;
          if (w.fade < 0) {
            const d0 = w.dist, d1 = Math.min(w.stop, d0 + WAVE_SPEED * ms / 1000);
            if (w.onHit && w.hits < WAVE_HITS && d1 > d0) waveHits(w, d0, d1);
            w.dist = d1;
            if (d1 >= w.stop - 1e-6) w.fade = 0;
          } else w.fade += ms;
        }
        if (!w.on) continue;               // onHit 안에서 지웠다(clear)
        if (w.fade >= WAVE_FADE_MS) { endWave(w); continue; }
      }
      const m = w.mesh;
      if (w.wait > 0) { m.visible = false; continue; }
      m.visible = true;
      m.position.set(w.ox + w.dx * w.dist, w.oy + w.dy * w.dist, w.oz + w.dz * w.dist);
      const grow = clamp(w.dist / WAVE_IN_M, 0, 1);
      m.scale.setScalar((w.stab ? 0.8 : 1) * (0.55 + 0.45 * grow) * (1 + 0.2 * clamp(w.dist / w.range, 0, 1)));
      const out = w.fade < 0 ? 1 : clamp(1 - w.fade / WAVE_FADE_MS, 0, 1);
      w.mat.opacity = (0.12 + 0.83 * grow) * out * (0.88 + 0.12 * Math.sin(now / 23 + w.seed));
    }
  }

  /* ---------- 판정(내 화면 기준, World가 부른다) ---------- */
  /**
   * 레이에 맞은 좀비들(가까운 순, 최대 n개). maxDist는 벽·사람에 막힌 거리.
   * → [{ id: 'z12', part: 'head'|'body'|'legs', dist, point:[x,y,z] }]
   */
  function ray(origin, dir, maxDist, n = 1) {
    if (!active || !rendered.length) return [];
    const dl = Math.hypot(dir[0], dir[1], dir[2]) || 1;
    const dx = dir[0] / dl, dy = dir[1] / dl, dz = dir[2] / dl;
    const out = [];
    for (const z of rendered) {
      // 넓은 거르기: 세로축까지의 수평 거리
      const rx = origin[0] - z.x, rz = origin[2] - z.z;
      const reach = (z.low ? 0.8 : 0.45) * z.s + 0.2;
      const a2 = dx * dx + dz * dz;
      if (a2 > 1e-9) {
        const tc = -(rx * dx + rz * dz) / a2;
        const cx = rx + dx * Math.max(0, tc), cz = rz + dz * Math.max(0, tc);
        if (cx * cx + cz * cz > reach * reach) continue;
      }
      const hb = z.low ? HB_LOW : HB_STAND;
      // 월드 → 좀비 로컬(회전 yaw의 역, 배율 s의 역)
      const cs = Math.cos(z.yaw), sn = Math.sin(z.yaw);
      const ox = rx * cs - rz * sn, oz = rx * sn + rz * cs, oy = origin[1] - z.y;
      const ldx = dx * cs - dz * sn, ldz = dx * sn + dz * cs;
      const s = z.s;
      let best = Infinity, part = null;
      const th = raySphere(ox, oy, oz, ldx, dy, ldz, 0, hb.head.y * s, hb.head.z * s, hb.head.r * s * (z.boss ? 1.15 : 1));
      if (th >= 0 && th < best) { best = th; part = 'head'; }
      const tb = rayBox(ox, oy, oz, ldx, dy, ldz, -hb.body.hw * s, hb.body.y0 * s, -hb.body.hd * s, hb.body.hw * s, hb.body.y1 * s, hb.body.hd * s);
      if (tb >= 0 && tb < best) { best = tb; part = 'body'; }
      const tl = rayBox(ox, oy, oz, ldx, dy, ldz, -hb.legs.hw * s, hb.legs.y0 * s, -hb.legs.hd * s, hb.legs.hw * s, hb.legs.y1 * s, hb.legs.hd * s);
      if (tl >= 0 && tl < best) { best = tl; part = 'legs'; }
      if (part && best <= maxDist) out.push({ id: 'z' + z.id, part, dist: best, point: [origin[0] + dx * best, origin[1] + dy * best, origin[2] + dz * best], boss: z.boss });
    }
    out.sort((a, b) => a.dist - b.dist);
    return out.slice(0, Math.max(1, n));
  }

  /** AI 안경: 전방 15° 안의 보이는 좀비 몸통 중심을 고른다. 가장 조준점에 가까운 대상, 동률이면 가까운 대상. */
  function autoAim(origin, dir, maxDist, los) {
    if (!active) return null;
    const len = Math.hypot(dir[0], dir[1], dir[2]);
    if (!(len > 0)) return null;
    const dx = dir[0] / len, dy = dir[1] / len, dz = dir[2] / len;
    let best = null, bestDot = Math.cos(15 * Math.PI / 180), bestDist = Infinity;
    for (const z of rendered) {
      if (z.rising) continue;
      const hb = z.low ? HB_LOW : HB_STAND;
      const x = z.x - origin[0], y = z.y + (hb.body.y0 + hb.body.y1) * 0.5 * z.s - origin[1], zz = z.z - origin[2];
      const dist = Math.hypot(x, y, zz);
      if (!(dist > 0) || dist > maxDist) continue;
      const dot = (x * dx + y * dy + zz * dz) / dist;
      if (dot < bestDot || (dot === bestDot && dist >= bestDist)) continue;
      const point = [origin[0] + x, origin[1] + y, origin[2] + zz];
      if (los && !los(origin, point)) continue;
      best = [x / dist, y / dist, zz / dist];
      bestDot = dot;
      bestDist = dist;
    }
    return best;
  }

  /** 칼: 눈 앞 사거리·원뿔 안에서 가장 가까운 좀비 → { id, part, dist, point } | null (벽 가림은 World가 본다) */
  function melee(eye, fwd, range, arc, los) {
    if (!active) return null;
    const fl = Math.hypot(fwd[0], fwd[1], fwd[2]) || 1;
    const fx0 = fwd[0] / fl, fy0 = fwd[1] / fl, fz0 = fwd[2] / fl;
    const hit = ray(eye, [fx0, fy0, fz0], range + 0.5, 1)[0];
    if (hit && hit.dist <= range + 0.3 && (!los || los(eye, hit.point))) return hit;
    let best = null, bestScore = Infinity;
    for (const z of rendered) {
      const r = (z.low ? 0.45 : 0.32) * z.s;
      const top = z.y + (z.low ? 0.7 : 1.5) * z.s, bot = z.y + (z.low ? 0.1 : 0.5) * z.s;
      const cy = clamp(eye[1], bot, top);
      const dx = z.x - eye[0], dy = cy - eye[1], dz = z.z - eye[2];
      const dist = Math.hypot(dx, dy, dz);
      const surf = Math.max(0, dist - r);
      if (surf > range) continue;
      const cos = dist > 1e-6 ? (dx * fx0 + dy * fy0 + dz * fz0) / dist : 1;
      const ang = Math.acos(clamp(cos, -1, 1));
      if (ang > arc + Math.atan2(r, Math.max(r, dist))) continue;
      const pt = [z.x, cy, z.z];
      if (los && !los(eye, pt)) continue;
      const score = ang * 2 + surf;
      if (score < bestScore) { bestScore = score; best = { id: 'z' + z.id, part: 'body', dist: Math.round(surf * 100) / 100, point: pt, boss: z.boss }; }
    }
    return best;
  }

  /** 수류탄 피해 대상(발 위치·키). World의 수류탄 시스템이 엄폐와 거리로 피해를 정한다 */
  function blastTargets() {
    return rendered.map((z) => ({ id: 'z' + z.id, pos: [z.x, z.y, z.z], height: (z.low ? 0.8 : 1.8) * z.s }));
  }

  /** 이 점(발사체)이 좀비 몸에 닿았는가(그린 위치 기준). 유탄·로켓은 좀비에 닿으면 바로 터진다 */
  function touching(p, r = 0.5) {
    if (!active || !p) return false;
    for (const z of rendered) {
      const top = z.y + (z.low ? 0.8 : 1.85) * z.s;
      if (p[1] < z.y - 0.1 || p[1] > top + 0.15) continue;
      if (Math.hypot(p[0] - z.x, p[2] - z.z) < (z.low ? 0.5 : 0.32) * z.s + r) return true;
    }
    return false;
  }

  /**
   * touching과 같은 판정으로, 닿은 좀비 중 가장 가까운 것(C4가 붙을 좀비)
   * → { id(번호), x, y, z, yaw, s, low, boss } | null
   */
  function touchingZombie(p, r = 0.5) {
    if (!active || !p) return null;
    let best = null, bestD = Infinity;
    for (const z of rendered) {
      // 땅에서 솟아오르는 중인 좀비는 몸이 바닥 아래에 있어 붙이지 않는다(C4가 바닥 밑으로 들어간다)
      if (z.rising) continue;
      const top = z.y + (z.low ? 0.8 : 1.85) * z.s;
      if (p[1] < z.y - 0.1 || p[1] > top + 0.15) continue;
      const d = Math.hypot(p[0] - z.x, p[2] - z.z);
      if (d < (z.low ? 0.5 : 0.32) * z.s + r && d < bestD) { bestD = d; best = z; }
    }
    return best ? { id: best.id, x: best.x, y: best.y, z: best.z, yaw: best.yaw, s: best.s, low: best.low, boss: best.boss } : null;
  }

  /**
   * 이번 프레임에 그린(살아 있는) 좀비 하나 — id는 번호나 'z12'. 쓰러졌거나 사라졌으면 null.
   * 돌려주는 객체는 이번 프레임 목록 그대로라 읽기만 한다 → { id, x, y, z, yaw, s, low, boss } | null
   */
  function zombieAt(id) {
    if (!active || id == null) return null;
    const n = typeof id === 'number' ? id | 0 : zombieNumber(id);
    for (const z of rendered) if (z.id === n) return z;
    return null;
  }

  /** 이 자리(내 발)를 좀비가 붙잡고 있는가: 좀비 몸과 겹치면 느려진다 */
  function grabbed(pos) {
    if (!active) return false;
    for (const z of rendered) {
      const r = HORDE.grabRadius + (z.low ? 0.25 : 0.1) * z.s;
      if (Math.abs(z.y - pos[1]) < 1.5 && Math.hypot(z.x - pos[0], z.z - pos[2]) < r) return true;
    }
    return false;
  }

  /** 화면 밖 좀비 방향 표시용: 내 위치에서 가까운 좀비 몇 마리 */
  function nearest(pos, n = 3) {
    return rendered.map((z) => ({ id: z.id, x: z.x, z: z.z, boss: z.boss, d: Math.hypot(z.x - pos[0], z.z - pos[2]) })).sort((a, b) => a.d - b.d).slice(0, n);
  }

  function clear() {
    ents.clear();
    myHits.clear();
    rendered.length = 0;
    bosses = []; projectiles = []; hazards = []; loot = []; fields = []; decoys = []; downs = [];
    for (const n of nums) { n.alive = false; n.sp.visible = false; }
    for (const g of decoyMeshes) g.visible = false;
    for (const w of waves) endWave(w);
    for (const L of reviveLabels) L.sp.visible = false;
    barBg.count = barFg.count = 0;
    fxAnims.length = 0;
    seenFx.clear();
    for (const z of zaps) { scene.remove(z.line); z.line.geometry.dispose(); }
    zaps.length = 0;
    lastPushAt = 0;
    for (const m of Object.values(parts)) { m.count = 0; m.instanceMatrix.needsUpdate = true; }
    projMesh.count = 0;
    lootMesh.count = 0;
    wisps.count = 0;
    for (const pool of [bossRings, teleDiscs, teleRings, teleRects, hazDiscs, hazRings, fxRings, lootRings, fireDiscs, fireRings, decoyRings, reviveRings, reviveDiscs]) { pool.begin(); pool.end(); }
  }

  function dispose() {
    clear();
    scene.remove(wisps); wispGeo.dispose(); wispMat.dispose();
    for (const m of Object.values(parts)) { scene.remove(m); m.geometry.dispose(); m.dispose && m.dispose(); }
    scene.remove(projMesh); projMesh.geometry.dispose(); projMesh.material.dispose();
    scene.remove(lootMesh); lootMesh.geometry.dispose(); lootMat.dispose();
    mat.dispose(); eyeMat.dispose(); zapMat.dispose();
    ringGeo.dispose(); discGeo.dispose(); planeGeo.dispose();
    for (const pool of [bossRings, teleDiscs, teleRings, teleRects, hazDiscs, hazRings, fxRings, lootRings, fireDiscs, fireRings, decoyRings, reviveRings, reviveDiscs]) pool.dispose();
    for (const g of decoyMeshes) scene.remove(g);
    decoyBodyGeo.dispose(); decoyHeadGeo.dispose(); decoyMat.dispose();
    for (const m of [barBg, barFg]) scene.remove(m);
    barGeo.dispose(); barBgMat.dispose(); barFgMat.dispose();
    for (const n of nums) { scene.remove(n.sp); n.tex.dispose(); n.sp.material.dispose(); }
    nums.length = 0;
    for (const w of waves) { scene.remove(w.mesh); w.mat.dispose(); }
    waves.length = 0;
    waveGeo.dispose();
    for (const L of reviveLabels) { scene.remove(L.sp); L.tex.dispose(); L.sp.material.dispose(); }
    reviveLabels.length = 0;
  }

  return {
    setActive, push, event, frame, ray, autoAim, melee, blastTargets, grabbed, touching, touchingZombie, zombieAt, wave, nearest, noteHit, damageNumber, clear, dispose,
    get active() { return active; },
    get count() { return rendered.length; },
    get delay() { return delay; },
    /** 시험용: 지금 그린 좀비 { id, x, y, z, yaw, s } */
    get rendered() { return rendered.map((z) => ({ ...z })); },
    /** 지금 바닥에 그리는 보급품 { id, kind, pos, leftMs } (마지막으로 받은 뷰 기준) */
    get loot() { return loot.map((L) => ({ ...L, pos: L.pos.slice() })); },
    /** 지금 띄우는 쓰러진 동료 { id, name, pos, progress, by } (마지막으로 받은 뷰 기준, 나는 빼고) */
    get downs() { return downs.map((d) => ({ ...d, pos: d.pos.slice() })); },
    /** 시험용: 이번 프레임 체력바 수, 떠 있는 피해 숫자 수, 분신·불길 수, 날고 있는 검기 수, 쓰러진 동료 표시 수 */
    get stats() {
      return { bars: barBg.count, numbers: nums.filter((n) => n.alive).length, decoys: decoys.length, fields: fields.length, waves: waves.filter((w) => w.on).length, downs: downs.length };
    }
  };
}

export { BOSS_CODE_BASE };
