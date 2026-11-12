/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 좀비 물량 막기의 화면 쪽. 방장 스냅샷의 좀비·보스를 시간축으로 보간해 그리고(부위별 InstancedMesh라 수십 마리도 그리기 호출이 몇 개),
 *          투사체·장판·스킬 예고·폭발을 보여 주며, 내 사격·칼·수류탄이 맞힌 좀비를 찾는다(World가 부른다). 모형은 상자 몇 개로 직접 만들었다.
 */
import { ZF, BOSS_CODE_BASE } from './director.js';
import { zombieByCode, HORDE } from './rules.js';
import { bossByCode, SKILL_KINDS, HAZARD_KINDS, PROJECTILE_KINDS } from './bosses.js';

const MAX_Z = 96;               // 한 번에 그리는 좀비 상한(보스 포함)
const MAX_PROJ = 48;
const MAX_HAZ = 16;
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
 * @param {{ THREE, scene, fx?, play?(name, opts), shadows?: boolean }} o
 */
export function createHordeView(o) {
  const { THREE, scene } = o;
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
  const fxRings = decalPool(ringGeo, 12, 0xffffff, 0.6);
  const projMesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0xffffff }), MAX_PROJ);
  projMesh.frustumCulled = false; projMesh.count = 0; projMesh.name = 'horde:proj'; projMesh.visible = false;
  projMesh.setColorAt(0, new THREE.Color(1, 1, 1));
  scene.add(projMesh);
  // 연쇄 번개 선
  const zapMat = new THREE.LineBasicMaterial({ color: 0x9ff8ff, transparent: true, opacity: 0.95 });
  const zaps = [];

  /* ---------- 상태 ---------- */
  const ents = new Map();            // 좀비 번호 → { hist: [{t, pos, yaw, f, hp}], ... }
  let lastPushAt = 0, interval = 100, delay = 120;
  let bosses = [], projectiles = [], projAt = 0, hazards = [], hazAt = 0;
  const seenFx = new Set();
  const fxAnims = [];                // { kind, pos, r, at, color }
  const rendered = [];               // 이번 프레임에 그린 좀비(사격 판정용)
  let myHits = new Map();            // 좀비 번호 → 마지막 피격 시각(번쩍임)

  const M = new THREE.Matrix4(), T = new THREE.Matrix4(), Rm = new THREE.Matrix4(), S = new THREE.Matrix4(), P = new THREE.Matrix4();
  const C = new THREE.Color(), C2 = new THREE.Color(), SKC = new THREE.Color(), CLC = new THREE.Color();
  const DARK = new THREE.Color(0x111111);

  function setActive(on) {
    active = !!on;
    if (!active) clear();
    for (const m of Object.values(parts)) m.visible = active;
    projMesh.visible = active;
  }

  /** 방장 뷰(applyHordeSnapshot) 하나를 받은 시각 t(performance.now 기준)에 넣는다 */
  function push(view, t = performance.now()) {
    if (!active || !view) return;
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
    if (f & ZF.slow) C.lerp(C2.setHex(0x8fdcff), 0.35);
    if (f & ZF.haste) C.lerp(C2.setHex(0xff5a3c), 0.25);
    if (f & ZF.armor) C.lerp(C2.setHex(0xb8c4d0), 0.55);
    if (flash) C.lerp(C2.setHex(0xffffff), 0.7);
    const skinC = SKC.copy(C);
    if (boss) C.setHex(skin).lerp(DARK, 0.35); else C.setHex(cloth);
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

  function frame(dt, now = performance.now()) {
    if (!active) return;
    for (const k of Object.keys(ni)) ni[k] = 0;
    rendered.length = 0;
    const rt = now - delay;
    bossRings.begin();
    for (const [id, e] of ents) {
      // 사라진 지 오래되었거나 쓰러진 뒤 다 가라앉으면 지운다
      if ((e.goneAt && now - e.goneAt > (e.deadAt ? 1500 : delay + 200)) || (e.deadAt && now - e.deadAt > 1500)) { ents.delete(id); myHits.delete(id); continue; }
      const smp = sample(e, rt);
      if (!smp) continue;
      drawZombie(e, smp, now, dt);
      if (!e.deadAt) {
        const riseK = clamp((now - e.riseAt) / RISE_MS, 0, 1);
        rendered.push({ id: e.id, x: smp.pos[0], y: smp.pos[1] - (1 - riseK) * 1.7 * e.s, z: smp.pos[2], yaw: smp.yaw, s: e.s, low: e.low, boss: !!e.boss });
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
    drawTelegraphs(now);
    drawProjectiles(now);
    drawHazards(now);
    drawFx(now);
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
    hazDiscs.begin();
    const dt = now - hazAt;
    for (const h of hazards) {
      const left = h.leftMs - dt;
      if (left <= 0) continue;
      const d = hazDiscs.take();
      if (!d) break;
      d.position.set(h.pos[0], h.pos[1] + 0.03, h.pos[2]);
      d.scale.setScalar(h.r);
      d.material.color.setHex(HAZ_COLOR[h.kind] || 0x7dff3a);
      d.material.opacity = Math.min(1, left / 600) * (0.26 + 0.08 * Math.sin(now / 210 + h.id));
    }
    hazDiscs.end();
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
    bosses = []; projectiles = []; hazards = [];
    fxAnims.length = 0;
    seenFx.clear();
    for (const z of zaps) { scene.remove(z.line); z.line.geometry.dispose(); }
    zaps.length = 0;
    lastPushAt = 0;
    for (const m of Object.values(parts)) { m.count = 0; m.instanceMatrix.needsUpdate = true; }
    projMesh.count = 0;
    for (const pool of [bossRings, teleDiscs, teleRings, teleRects, hazDiscs, fxRings]) { pool.begin(); pool.end(); }
  }

  function dispose() {
    clear();
    for (const m of Object.values(parts)) { scene.remove(m); m.geometry.dispose(); m.dispose && m.dispose(); }
    scene.remove(projMesh); projMesh.geometry.dispose(); projMesh.material.dispose();
    mat.dispose(); eyeMat.dispose(); zapMat.dispose();
    ringGeo.dispose(); discGeo.dispose(); planeGeo.dispose();
    for (const pool of [bossRings, teleDiscs, teleRings, teleRects, hazDiscs, fxRings]) pool.dispose();
  }

  return {
    setActive, push, event, frame, ray, melee, blastTargets, grabbed, nearest, noteHit, clear, dispose,
    get active() { return active; },
    get count() { return rendered.length; },
    get delay() { return delay; },
    /** 시험용: 지금 그린 좀비 { id, x, y, z, yaw, s } */
    get rendered() { return rendered.map((z) => ({ ...z })); }
  };
}

export { BOSS_CODE_BASE };
