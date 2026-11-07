/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 수류탄 투척 물리와 폭발 피해 계산. 충돌 함수를 주입받는 순수 모듈이다.
 */
/**
 * SKALA FPS — 수류탄 투척 물리 (weapons 담당)
 *
 * three.js·엔진 비의존 순수 모듈. 충돌은 함수로 주입받는다. 두 방식을 모두 받는다.
 *
 *  (A) 선분 스윕(기본 계약) — 이 모듈이 포물선·바운스를 직접 적분한다.
 *      sphereSweep(from, to, r) → { hit, point, normal, t?, center? }
 *        from→to로 반지름 r 구를 쓸었을 때 처음 닿는 곳. point는 '닿는 순간 구의 중심'을 권장.
 *        t(0~1)나 center를 주면 그것을 우선 쓰고, point가 표면 접점이어도 판별해서 보정한다.
 *  (B) core 적분기 — js/engine/physics.js의 world.sphereSweep(body, dt, opt)
 *        createGrenadeSystem({ world }) 처럼 world를 넘기거나, 함수만 넘겨도 자동으로 알아챈다.
 *        이때 이동·바운스는 core가 계산하고(반발·마찰·중력은 이 모듈 값으로 넘김) 이 모듈은 신관·이벤트·피해를 맡는다.
 *
 *  lineOfSight(a, b) → true(가리는 것 없음) | false.  { hit:true } 같은 객체도 된다(hit이면 막힘).
 *
 * 벡터 입력은 [x,y,z] 배열과 {x,y,z} 객체를 모두 받는다. 출력 벡터는 vec3(배열이면서 .x/.y/.z도 있음).
 * 고정 시간 간격(1/120초)으로 적분해서, 같은 투척은 프레임 속도와 상관없이 같은 궤적을 그린다.
 */
import { WEAPONS, DEG, explosionFalloff, vec3, toVec3 } from './defs.js';

const G = WEAPONS.gr_frag;
/** 기본 물리 상수(defs.js의 gr_frag.physics) */
export const GRENADE_PHYSICS = G.physics;
export const GRENADE_FUSE = G.fuse;

const SKIN = 0.002;          // 접촉 후 표면에서 띄우는 거리
const MAX_ITER = 4;          // 한 스텝 안에서 연속 충돌 처리 횟수
const MAX_STEPS_PER_CALL = 64;
const KILL_Y = -60;          // 이 아래로 떨어지면 그 자리에서 폭발 처리

let nextId = 1;

const num = (v, d = 0) => (Number.isFinite(v) ? v : d);
const P3 = (v) => { const t = toVec3(v); return { x: t.x, y: t.y, z: t.z }; };   // 내부 계산용 평범한 객체
const out3 = (v) => vec3(v.x, v.y, v.z);
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const len = (a) => Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
const dist = (a, b) => len(sub(a, b));
const lerpV = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const finiteV = (v) => !!v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
const readV = (v) => {           // 결과 객체의 벡터(배열/객체)를 읽되, 없거나 NaN이면 null
  if (!v) return null;
  const a = Array.isArray(v) ? v : [v.x, v.y, v.z];
  const o = { x: +a[0], y: +a[1], z: +a[2] };
  return finiteV(o) ? o : null;
};

function normalize(v, fallback = { x: 0, y: 1, z: 0 }) {
  const p = readV(v);
  if (!p) return { ...fallback };
  const l = len(p);
  if (!(l > 1e-9)) return { ...fallback };
  return { x: p.x / l, y: p.y / l, z: p.z / l };
}

function distPointSeg(p, a, b) {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  const t = l2 > 1e-12 ? clamp(dot(sub(p, a), ab) / l2, 0, 1) : 0;
  return dist(p, lerpV(a, b, t));
}

/**
 * 시선 방향과 속력으로 초기 속도를 만든다.
 * @param {number[]|{x,y,z}} forward  시선 방향(정규화 안 돼도 됨)
 * @param {number} speed     m/s (기본 16)
 * @param {number} pitchUp   시선보다 위로 더 올리는 각(라디안, 기본 6°)
 * @param {number[]|{x,y,z}} [inherit] 던지는 사람 속도(선택)
 * @param {number} [inheritScale=0.5]
 * @returns vec3
 */
export function throwVelocity(forward, speed = G.throw.speed, pitchUp = G.throw.pitchUp * DEG, inherit = null, inheritScale = 0.5) {
  const f = normalize(forward, { x: 0, y: 0, z: -1 });
  const horiz = Math.hypot(f.x, f.z);
  const elev = clamp(Math.atan2(f.y, horiz) + num(pitchUp), -89 * DEG, 89 * DEG);
  const hx = horiz > 1e-6 ? f.x / horiz : 0;
  const hz = horiz > 1e-6 ? f.z / horiz : -1;
  const c = Math.cos(elev);
  const s = num(speed, G.throw.speed);
  const v = { x: hx * c * s, y: Math.sin(elev) * s, z: hz * c * s };
  if (inherit) {
    const k = num(inheritScale, 0.5);
    const iv = P3(inherit);
    v.x += iv.x * k; v.y += iv.y * k; v.z += iv.z * k;
  }
  return out3(v);
}

/** 수류탄 상태 객체 하나를 만든다(순수 데이터). pos/vel은 vec3. */
export function createGrenade({ pos, vel, fuse = G.fuse, owner = null, id } = {}) {
  return {
    id: id ?? nextId++, owner,
    pos: toVec3(pos), vel: toVec3(vel),
    age: 0, fuse: num(fuse, G.fuse), acc: 0,
    exploded: false, sleeping: false, onGround: false, groundT: 0,
    bounces: 0, lastNormal: vec3(0, 1, 0),
  };
}

// ───────────────────────── (A) 선분 스윕 적분 ─────────────────────────

/** sweep 결과에서 '닿는 순간 구의 중심'을 구한다. */
function contactCenter(from, to, res, r, n, sweep) {
  const c = readV(res.center);
  if (c) return c;
  if (Number.isFinite(res.t)) return lerpV(from, to, clamp(res.t, 0, 1));
  const p = readV(res.point);
  if (!p) return { ...from };
  // point가 이동 선분에서 떨어져 있으면 표면 접점 → 법선 방향으로 r만큼 밀어낸 곳이 중심
  if (distPointSeg(p, from, to) > r * 0.5) return { x: p.x + n.x * r, y: p.y + n.y * r, z: p.z + n.z * r };
  // 선분 위에 있으면 둘 다 가능(정면 충돌). 법선 쪽 1.5r → 0.5r로 짧게 쓸어 보면 구분된다:
  // p가 중심이면 표면은 p에서 r 떨어져 있어 닿지 않고, p가 표면이면 0.5r 지점에서 닿는다.
  if (sweep) {
    let probe = null;
    try {
      probe = sweep(
        vec3(p.x + n.x * r * 1.5, p.y + n.y * r * 1.5, p.z + n.z * r * 1.5),
        vec3(p.x + n.x * r * 0.5, p.y + n.y * r * 0.5, p.z + n.z * r * 0.5), r);
    } catch (e) { probe = null; }
    if (probe && probe.hit) return { x: p.x + n.x * r, y: p.y + n.y * r, z: p.z + n.z * r };
  }
  return p;
}

function sweepWorld(from, to, r, sweep, floorY) {
  let best = null;
  const move = sub(to, from);
  const moveLen = len(move);
  if (sweep) {
    let res = null;
    try { res = sweep(out3(from), out3(to), r); } catch (e) { res = null; }
    if (res && res.hit) {
      const back = moveLen > 1e-9 ? { x: -move.x / moveLen, y: -move.y / moveLen, z: -move.z / moveLen } : { x: 0, y: 1, z: 0 };
      let n = normalize(res.normal, back);
      if (moveLen > 1e-9 && dot(n, move) > 0) n = { x: -n.x, y: -n.y, z: -n.z };   // 법선은 이동 반대쪽
      const center = contactCenter(from, to, res, r, n, sweep);
      const frac = Number.isFinite(res.t) ? clamp(res.t, 0, 1)
        : moveLen > 1e-9 ? clamp(dist(center, from) / moveLen, 0, 1) : 0;
      best = { center, normal: n, frac };
    }
  }
  if (floorY != null && Number.isFinite(floorY)) {
    const minY = floorY + r;
    if (from.y < minY - 1e-6) {
      best = { center: { x: from.x, y: minY, z: from.z }, normal: { x: 0, y: 1, z: 0 }, frac: 0 };
    } else if (to.y < minY) {
      const frac = from.y - to.y > 1e-12 ? clamp((from.y - minY) / (from.y - to.y), 0, 1) : 0;
      if (!best || frac < best.frac) {
        const c = lerpV(from, to, frac);
        c.y = minY;
        best = { center: c, normal: { x: 0, y: 1, z: 0 }, frac };
      }
    }
  }
  return best;
}

function integrateSegment(g, h, sweep, P, floorY, out) {
  let pos = P3(g.pos);
  let vel = P3(g.vel);
  vel.y += P.gravity * h;
  let remaining = 1;
  let touchedGround = false;
  for (let it = 0; it < MAX_ITER && remaining > 1e-4; it++) {
    const to = { x: pos.x + vel.x * h * remaining, y: pos.y + vel.y * h * remaining, z: pos.z + vel.z * h * remaining };
    const hit = sweepWorld(pos, to, P.radius, sweep, floorY);
    if (!hit) { pos = to; break; }
    const n = hit.normal;
    pos = { x: hit.center.x + n.x * SKIN, y: hit.center.y + n.y * SKIN, z: hit.center.z + n.z * SKIN };
    const vn = dot(vel, n);
    if (vn < 0) {
      const vN = { x: n.x * vn, y: n.y * vn, z: n.z * vn };
      const vT = sub(vel, vN);
      const impact = -vn;
      if (impact > P.restSpeed) {
        const keep = 1 - P.friction;
        vel = { x: vT.x * keep - vN.x * P.restitution, y: vT.y * keep - vN.y * P.restitution, z: vT.z * keep - vN.z * P.restitution };
        g.bounces++;
        if (impact > P.bounceEventSpeed) {
          out.push({ type: 'bounce', id: g.id, owner: g.owner, pos: out3(pos), normal: out3(n), speed: impact, mat: null });
        }
      } else {
        vel = vT;   // 약하게 닿으면 튀지 않고 면을 따라 미끄러진다
      }
    }
    if (n.y > 0.6) touchedGround = true;
    g.lastNormal = out3(n);
    remaining *= 1 - hit.frac;
  }
  g.groundT = touchedGround ? 0.06 : g.groundT - h;
  g.onGround = g.groundT > 0;
  if (g.onGround) {
    const k = Math.exp(-P.rollDamp * h);
    vel.x *= k;
    vel.z *= k;
    if (touchedGround && Math.hypot(vel.x, vel.z) < P.sleepSpeed && Math.abs(vel.y) < P.restSpeed) {
      vel = { x: 0, y: 0, z: 0 };
      g.sleeping = true;
    }
  }
  g.pos = out3(pos);
  g.vel = out3(vel);
}

// ───────────────────────── (B) core 적분기 ─────────────────────────

function integrateCore(g, h, coreSweep, P, out) {
  const body = { pos: [g.pos.x, g.pos.y, g.pos.z], vel: [g.vel.x, g.vel.y, g.vel.z] };
  let res = null;
  try {
    res = coreSweep(body, h, { radius: P.radius, gravity: P.gravity, restitution: P.restitution, friction: 1 - P.friction });
  } catch (e) { res = null; }
  const pos = readV(body.pos), vel = readV(body.vel);
  if (!pos || !vel) { g.vel = vec3(NaN, NaN, NaN); return; }   // stepGrenade가 처리
  g.pos = out3(pos);
  g.vel = out3(vel);
  const hits = res && Array.isArray(res.hits) ? res.hits : [];
  let ground = false;
  for (const hit of hits) {
    const n = normalize(hit.normal);
    if (n.y > 0.6) ground = true;
    g.lastNormal = out3(n);
    g.bounces++;
    const speed = num(hit.speed);
    if (speed > P.bounceEventSpeed) {
      const pt = readV(hit.point);
      out.push({ type: 'bounce', id: g.id, owner: g.owner, pos: pt ? out3(pt) : out3(pos), normal: out3(n), speed, mat: hit.mat ?? null });
    }
  }
  g.groundT = ground ? 0.06 : g.groundT - h;
  g.onGround = g.groundT > 0 || !!(res && res.resting);
  if (res && res.resting) { g.vel = vec3(0, 0, 0); g.sleeping = true; }
}

/**
 * 주입된 sphereSweep이 어느 방식인지 알아낸다.
 * core 적분기(body, dt, opt)는 {hits:[], resting} 객체를 돌려주므로, 월드 아래쪽 더미 body로 한 번 불러 본다.
 * @returns {'segment'|'integrator'}
 */
export function detectSweepStyle(fn) {
  if (typeof fn !== 'function') return 'segment';
  try {
    const body = { pos: [0, -9999, 0], vel: [0, 0, 0] };
    const r = fn(body, 1e-4, { radius: 0.07, gravity: 0, restitution: 0, friction: 1 });
    if (r && typeof r === 'object' && Array.isArray(r.hits)) return 'integrator';
  } catch (e) { /* 선분 스윕 함수는 이상한 인자에 예외를 낼 수 있다 */ }
  return 'segment';
}

/**
 * 수류탄 하나를 dt만큼 진행. 고정 스텝(physics.step)으로 나눠 계산한다.
 * @param {object} g          createGrenade 결과
 * @param {number} dt         초
 * @param {Function} [sphereSweep]
 * @param {{floorY?:number|null, physics?:object, style?:'segment'|'integrator'}} [opts]
 *        floorY: 선분 방식에서 쓰는 암묵적 바닥(기본 0, 끄려면 null). style 기본 'segment'.
 * @returns {object[]} 이벤트: {type:'bounce', id, owner, pos, normal, speed, mat} | {type:'explode', id, owner, pos}
 */
export function stepGrenade(g, dt, sphereSweep, opts = {}) {
  const out = [];
  if (!g || g.exploded) return out;
  const P = opts.physics ? { ...GRENADE_PHYSICS, ...opts.physics } : GRENADE_PHYSICS;
  const floorY = opts.floorY === undefined ? 0 : opts.floorY;
  const core = opts.style === 'integrator' && typeof sphereSweep === 'function';
  const step = P.step > 0 ? P.step : 1 / 120;
  g.acc += clamp(num(dt), 0, 0.25);
  let n = 0;
  while (g.acc + 1e-12 >= step && !g.exploded && n < MAX_STEPS_PER_CALL) {
    g.acc -= step;
    n++;
    g.age += step;
    const before = out3(g.pos);
    if (!g.sleeping) {
      if (core) integrateCore(g, step, sphereSweep, P, out);
      else integrateSegment(g, step, sphereSweep, P, floorY, out);
    }
    if (!finiteV(g.pos) || !finiteV(g.vel)) {   // 잘못된 충돌 결과로 NaN이 생기면 직전 위치에서 터뜨린다
      g.pos = before;
      g.vel = vec3(0, 0, 0);
      g.age = Math.max(g.age, g.fuse);
    }
    if (g.pos.y < KILL_Y) g.age = Math.max(g.age, g.fuse);
    if (g.age + 1e-9 >= g.fuse) {
      g.exploded = true;
      out.push({ type: 'explode', id: g.id, owner: g.owner, pos: out3(g.pos) });
    }
  }
  if (n >= MAX_STEPS_PER_CALL) g.acc = Math.min(g.acc, step);
  return out;
}

// ───────────────────────── 폭발 피해 ─────────────────────────

function losClear(r) {
  if (typeof r === 'boolean') return r;
  if (r && typeof r === 'object') {
    if ('clear' in r) return !!r.clear;
    if ('visible' in r) return !!r.visible;
    if ('hit' in r) return !r.hit;
  }
  return !!r;
}

function samplePoints(t) {
  if (Array.isArray(t.points) && t.points.length) return t.points.map(P3);
  const p = t.pos || t.position;
  if (!p) return [];
  const b = P3(p);
  const h = Number.isFinite(t.height) ? t.height : 1.8;
  return [
    { x: b.x, y: b.y + h * 0.14, z: b.z },   // 다리
    { x: b.x, y: b.y + h * 0.55, z: b.z },   // 몸
    { x: b.x, y: b.y + h * 0.86, z: b.z },   // 머리
  ];
}

/**
 * 폭발 피해 계산.
 * @param {number[]|{x,y,z}} center 폭심
 * @param {Array<{id:any, pos?:number[]|{x,y,z}, height?:number, points?:Array}>} targets
 *        pos = 발 위치(바닥). points를 주면 그 점들로 판정한다.
 * @param {(a,b)=>boolean|object} [lineOfSight] 없으면 차폐 없이 계산
 * @param {{radius?:number, inner?:number, max?:number, lift?:number}} [opts]
 * @returns {Array<{id:any, damage:number, dist:number, visible:boolean}>} 입력 순서 그대로
 *        dist = 보이는 가장 가까운 판정점까지 거리(안 보이면 가장 가까운 점까지 거리)
 */
export function explosionDamage(center, targets, lineOfSight, opts = {}) {
  const ex = { ...G.explosion };
  for (const k of ['radius', 'inner', 'max']) if (Number.isFinite(opts[k])) ex[k] = opts[k];
  const c = P3(center);
  const origin = vec3(c.x, c.y + (Number.isFinite(opts.lift) ? opts.lift : 0.12), c.z);
  const res = [];
  for (const t of targets || []) {
    if (!t) continue;
    const pts = samplePoints(t).map((p) => ({ p, d: dist(c, p) })).sort((a, b) => a.d - b.d);
    let best = Infinity;
    for (const { p, d } of pts) {
      if (d > ex.radius) break;
      let clear = true;
      if (typeof lineOfSight === 'function') {
        try { clear = losClear(lineOfSight(origin, out3(p))); } catch (e) { clear = false; }
      }
      if (clear) { best = d; break; }
    }
    const visible = best < Infinity;
    res.push({
      id: t.id,
      damage: visible ? explosionFalloff(best, ex) : 0,
      dist: visible ? best : pts.length ? pts[0].d : Infinity,
      visible,
    });
  }
  return res;
}

// ───────────────────────── 시스템 ─────────────────────────

/**
 * 여러 수류탄을 관리한다.
 * @param {object} cfg
 * @param {object} [cfg.world]         core world(createWorld 결과). sphereSweep·lineOfSight를 여기서 꺼낸다.
 * @param {Function} [cfg.sphereSweep] (A) (from,to,r) 또는 (B) core 적분기. 방식은 자동 판별
 * @param {Function} [cfg.lineOfSight] (a,b) → boolean
 * @param {'auto'|'segment'|'integrator'} [cfg.sweepStyle='auto']
 * @param {number|null} [cfg.floorY=0] (A) 방식의 암묵적 바닥 평면(없애려면 null). (B)는 core 월드 설정을 따른다.
 * @param {object} [cfg.physics]       GRENADE_PHYSICS 덮어쓰기
 * @param {(ev)=>void} [cfg.onEvent]   bounce/explode 콜백(선택)
 */
export function createGrenadeSystem(cfg = {}) {
  const world = cfg.world && typeof cfg.world === 'object' ? cfg.world : null;
  const sphereSweep = typeof cfg.sphereSweep === 'function' ? cfg.sphereSweep
    : world && typeof world.sphereSweep === 'function' ? world.sphereSweep : null;
  const lineOfSight = typeof cfg.lineOfSight === 'function' ? cfg.lineOfSight
    : world && typeof world.lineOfSight === 'function' ? world.lineOfSight : null;
  let style = cfg.sweepStyle === 'segment' || cfg.sweepStyle === 'integrator' ? cfg.sweepStyle : null;
  if (!style) style = sphereSweep ? detectSweepStyle(sphereSweep) : 'segment';
  const floorY = cfg.floorY === undefined ? 0 : cfg.floorY;
  const physics = cfg.physics ? { ...GRENADE_PHYSICS, ...cfg.physics } : GRENADE_PHYSICS;
  const onEvent = typeof cfg.onEvent === 'function' ? cfg.onEvent : null;
  const stepOpts = { floorY, physics, style };
  let list = [];

  function spawn(pos, vel, o = {}) {
    const g = createGrenade({ pos, vel, fuse: o.fuse, owner: o.owner ?? null, id: o.id });
    list.push(g);
    return g;
  }

  /**
   * 눈 위치·시선에서 던진다. arsenal의 throw 이벤트 값(speed, pitchUp, fuse)을 그대로 넘기면 된다.
   * @param {{eye, forward, speed?:number, pitchUp?:number, owner?:any, fuse?:number,
   *          inherit?, inheritScale?:number, id?:any, offset?:number}} o  벡터는 배열/객체 모두 가능
   */
  function throwFrom(o = {}) {
    const eye = P3(o.eye);
    const f = normalize(o.forward, { x: 0, y: 0, z: -1 });
    const vel = throwVelocity(f, o.speed, o.pitchUp, o.inherit, o.inheritScale);
    const off = Number.isFinite(o.offset) ? o.offset : 0.3;
    let start = { x: eye.x + f.x * off, y: eye.y + f.y * off - 0.06, z: eye.z + f.z * off };
    // 벽에 붙어서 던지면 벽 안에서 생기지 않게 눈 위치에서 시작
    let blocked = false;
    if (lineOfSight) {
      try { blocked = !losClear(lineOfSight(out3(eye), out3(start))); } catch (e) { blocked = false; }
    } else if (sphereSweep && style === 'segment') {
      try { const r = sphereSweep(out3(eye), out3(start), physics.radius); blocked = !!(r && r.hit); } catch (e) { blocked = false; }
    }
    if (blocked) start = { ...eye };
    return spawn(start, vel, o);
  }

  function update(dt) {
    const events = [];
    for (const g of list) {
      const evs = stepGrenade(g, dt, sphereSweep, stepOpts);
      for (const e of evs) { events.push(e); if (onEvent) onEvent(e); }
    }
    if (events.length) list = list.filter((g) => !g.exploded);
    return events;
  }

  return {
    spawn,
    throwFrom,
    update,
    /** 주입받은 lineOfSight로 폭발 피해 계산 */
    explosionDamage: (center, targets, o) => explosionDamage(center, targets, lineOfSight, o),
    /** 살아 있는 수류탄 목록(렌더링용 사본: {id, owner, pos, vel, age, fuse, sleeping}) */
    list: () => list.map((g) => ({ id: g.id, owner: g.owner, pos: out3(g.pos), vel: out3(g.vel), age: g.age, fuse: g.fuse, sleeping: g.sleeping })),
    get count() { return list.length; },
    /** 'segment' | 'integrator' — 실제로 쓰는 충돌 방식 */
    get sweepStyle() { return style; },
    remove: (id) => { const n = list.length; list = list.filter((g) => g.id !== id); return n !== list.length; },
    clear: () => { list = []; },
    dispose: () => { list = []; },
  };
}
