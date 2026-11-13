/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 무기 상태 머신. 로드아웃과 허용 슬롯을 기준으로 사격·점사·다단 줌·재장전·교체를 진행하고 프레임마다 이벤트 배열을 돌려준다.
 *          three.js·엔진·DOM에 의존하지 않는 순수 모듈이다. 레이캐스트와 피해 적용은 엔진이 한다.
 */

/*
 * 각도 규약: 모두 라디안, three.js 카메라 Euler('YXZ')와 같다.
 *   yaw + = 왼쪽으로 돌기(rotation.y),  pitch + = 위로 보기(rotation.x).
 * 자세한 API는 README.md 참고.
 */
import {
  WEAPONS, WEAPON_IDS, PRIMARY_IDS, SECONDARY_IDS, MELEE_IDS, GRENADE_IDS, DEFAULT_LOADOUT,
  DEG, WALK_SPEED, BASE_FOV, getDef, zoomFov, minShotInterval, vec3, toVec3,
} from './defs.js';

export { computeDamage, damage, getDef, WEAPONS, WEAPON_IDS, PRIMARY_IDS, SECONDARY_IDS, MELEE_IDS, vec3 } from './defs.js';

const EPS = 1e-9;
const SEMI_BUFFER = 0.1;        // 반자동·점사: 쿨다운이 끝나기 0.1초 전까지 누른 클릭은 기억했다가 쏜다
const MAX_SHOTS_PER_UPDATE = 4; // 긴 프레임에서도 한 번에 너무 많이 쏘지 않게
const MAX_DT = 0.25;
const CROUCH_SPREAD = 0.8;      // 앉아 있으면 탄퍼짐 ×0.8 (core consts.CROUCH_SPREAD_MUL와 같은 값)
const MELEE_RANGE_SLACK = 1.2;  // 방장 검증: 칼 사거리에 더하는 지연 보간 여유(m)

const SLOTS = Object.freeze([1, 2, 3, 4]);
const GRENADE_ID = GRENADE_IDS[0];
/** 로드아웃 키 → 슬롯과 고를 수 있는 무기 */
const LOADOUT_KEYS = Object.freeze([
  ['primary', 1, PRIMARY_IDS],
  ['secondary', 2, SECONDARY_IDS],
  ['melee', 3, MELEE_IDS],
]);

/** serialize().s 값 목록 */
export const STATES = Object.freeze(['idle', 'draw', 'reload', 'bolt', 'swing', 'prime', 'throw']);

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const approach = (cur, target, rate, dt) => (dt > 0 ? target + (cur - target) * Math.exp(-rate * dt) : cur);
const easeOutQuad = (t) => 1 - (1 - t) * (1 - t);

/** 슬롯 목록을 1~4 오름차순으로 정리한다. 쓸 수 있는 슬롯이 하나도 없으면 null. */
function normSlots(list) {
  if (!Array.isArray(list)) return null;
  const out = SLOTS.filter((s) => list.includes(s));
  return out.length ? out : null;
}

/**
 * yaw/pitch(라디안, three.js YXZ 규약)를 단위 방향 벡터로(vec3: 배열 겸 {x,y,z}).
 * 오프셋에 쓰면 '카메라 로컬' 방향이 된다(−z가 정면).
 */
export function dirFromYawPitch(yaw, pitch) {
  const cp = Math.cos(pitch);
  return vec3(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp);
}

/** 벡터 v([x,y,z] 또는 {x,y,z})를 Euler(pitch, yaw, 0, 'YXZ')로 회전(카메라 로컬 → 월드). */
export function rotateYXZ(v, yaw, pitch) {
  const p = toVec3(v);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const y1 = p.y * cp - p.z * sp;
  const z1 = p.y * sp + p.z * cp;
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  return vec3(p.x * cy + z1 * sy, y1, -p.x * sy + z1 * cy);
}

/**
 * fire 이벤트의 탄 방향(월드 단위 벡터). 엔진이 시점을 yaw/pitch 숫자로 관리할 때 쓴다.
 * lookYaw/lookPitch = 반동을 더하기 전 플레이어 시점. 산탄은 pellet 번호를 넘긴다.
 */
export function shotDirection(lookYaw, lookPitch, ev, pellet = 0) {
  const p = (ev && ev.pellets && ev.pellets[pellet]) || ev || { dir: { x: 0, y: 0, z: -1 } };
  const r = (ev && ev.recoil) || { yaw: 0, pitch: 0 };
  return rotateYXZ(p.dir || dirFromYawPitch(p.yaw || 0, p.pitch || 0), lookYaw + r.yaw, lookPitch + r.pitch);
}

/**
 * 방장(host)용 간단 검증: 거리와 연사 간격만 본다. 모든 무기에 쓸 수 있다.
 * 연사 기준은 그 무기의 가장 짧은 사격 간격이다(점사는 점사 안 간격, 칼은 빠른 쪽 쿨다운).
 * @param {string} weaponId
 * @param {{dist?:number, interval?:number, kind?:string, tolerance?:number}} info
 *   interval = 같은 사수의 직전 사격(또는 타격)과의 시간 차(초). tolerance = 간격 허용 비율(기본 0.6).
 * @returns {{ok:boolean, reason?:'weapon'|'range'|'rate'}}
 */
export function validateHit(weaponId, info = {}) {
  const d = getDef(weaponId);
  if (!d) return { ok: false, reason: 'weapon' };
  const dist = Number.isFinite(info.dist) ? info.dist : 0;
  const interval = Number.isFinite(info.interval) ? info.interval : Infinity;
  const tol = Number.isFinite(info.tolerance) ? info.tolerance : 0.6;
  if (d.explosion) return dist <= d.explosion.radius + 0.5 ? { ok: true } : { ok: false, reason: 'range' };
  const reach = d.melee ? d.melee[info.kind === 'stab' ? 'stab' : 'slash'].range + MELEE_RANGE_SLACK : d.maxRange;
  if (dist > reach) return { ok: false, reason: 'range' };
  if (interval < minShotInterval(weaponId) * tol) return { ok: false, reason: 'rate' };
  return { ok: true };
}

/**
 * 플레이어 한 명의 무기 세트.
 * @param {object} [opts]
 * @param {string} [opts.primary]    슬롯 1 무기(PRIMARY_IDS). 잘못된 값이면 DEFAULT_LOADOUT
 * @param {string} [opts.secondary]  슬롯 2 무기(SECONDARY_IDS)
 * @param {string} [opts.melee]      슬롯 3 무기(MELEE_IDS)
 * @param {number[]} [opts.allowedSlots=[1,2,3,4]] 쓸 수 있는 슬롯. 금지된 슬롯은 어떤 입력으로도 고를 수 없다
 * @param {'hold'|'toggle'} [opts.zoomMode='hold'] 단일 배율 무기의 우클릭 방식
 * @param {boolean} [opts.stageCycle=true]  false면 다단 줌 무기도 1단만 쓰는 단일 배율처럼 동작한다.
 *        zoomDown을 '줌을 원하는 동안 true'로 보내는 봇처럼 버튼을 누르는 주체가 사람이 아닐 때 쓴다
 * @param {() => number} [opts.rng=Math.random]    탄퍼짐 난수(테스트에서 고정 가능)
 * @param {number} [opts.walkSpeed=5.2]            이동 탄퍼짐 기준 속도
 * @param {boolean} [opts.draw=false]              true면 첫 무기를 꺼내는 동작부터 시작
 */
export function createArsenal(opts = {}) {
  const rng = typeof opts.rng === 'function' ? opts.rng : Math.random;
  const walkSpeed = opts.walkSpeed > 0 ? +opts.walkSpeed : WALK_SPEED;
  const stageCycle = opts.stageCycle !== false;
  let zoomMode = opts.zoomMode === 'toggle' ? 'toggle' : 'hold';

  const loadout = {
    1: PRIMARY_IDS.includes(opts.primary) ? opts.primary : DEFAULT_LOADOUT.primary,
    2: SECONDARY_IDS.includes(opts.secondary) ? opts.secondary : DEFAULT_LOADOUT.secondary,
    3: MELEE_IDS.includes(opts.melee) ? opts.melee : DEFAULT_LOADOUT.melee,
    4: GRENADE_ID,
  };
  let allowed = normSlots(opts.allowedSlots) || SLOTS;
  /** 이번 목숨에 바닥에 버려 비어 있는 칸(1·2). 다음 목숨(resetRound)에 자기 장비로 돌아온다 */
  const emptied = new Set();

  /**
   * 무기 배율(좀비 물량 막기의 카드·탄약 규칙, setMods). 기본값은 모두 '바꾸지 않음'이라 다른 모드는 표의 값 그대로다.
   * mag·magAdd: 탄창 크기, fire: 연사(사격 간격·볼트·점사 간격·칼 쿨다운을 나눈다), reload·draw: 재장전·꺼내기 속도,
   * spread·recoil: 탄퍼짐·반동 배율, reserve: 예비 탄 배율, finiteMags > 0이면 예비가 무제한인 총도 '탄창 × finiteMags × reserve'로 제한,
   * nades: 최대 수류탄 +, thrift: 쏴도 탄이 줄지 않을 확률
   */
  const MOD_BASE = Object.freeze({ mag: 1, magAdd: 0, fire: 1, reload: 1, draw: 1, spread: 1, recoil: 1, reserve: 1, finiteMags: 0, nades: 0, thrift: 0 });
  const mods = { ...MOD_BASE };
  const pos = (v, d) => (Number.isFinite(v) && v > 0 ? v : d);
  /** 이 무기의 탄창 크기(배율 반영). 탄창이 없는 무기는 null */
  const magOf = (id) => {
    const d = WEAPONS[id];
    return d.mag == null ? null : Math.max(1, Math.round(d.mag * mods.mag) + (mods.magAdd | 0));
  };
  /** 이 무기의 최대 예비 탄(배율 반영). 무제한이면 Infinity */
  const reserveOf = (id) => {
    const d = WEAPONS[id];
    if (d.reserve == null) return null;
    if (!Number.isFinite(d.reserve)) return mods.finiteMags > 0 ? Math.max(0, Math.round(d.mag * mods.finiteMags * mods.reserve)) : Infinity;
    return Math.max(0, Math.round(d.reserve * mods.reserve));
  };
  const countOf = (id) => (WEAPONS[id].count == null ? null : WEAPONS[id].count + Math.max(0, mods.nades | 0));
  const intervalOf = (d) => d.fireInterval / mods.fire;
  const drawOf = (id) => WEAPONS[id].drawTime / mods.draw;

  const fresh = (id) => {
    return {
      mag: magOf(id), reserve: reserveOf(id), count: countOf(id),
      nextFireAt: 0, lastShotAt: -1e9, boltUntil: 0, bloom: 0, shotIndex: 0, swingIndex: 0,
    };
  };
  const inv = Object.create(null);
  for (const id of WEAPON_IDS) inv[id] = fresh(id);

  /** 금지된 슬롯이면 null */
  const slotWeapon = (slot) => (allowed.includes(slot) && !emptied.has(slot) ? loadout[slot] || null : null);
  /** 지금 로드아웃에 있고 허용된 슬롯의 무기인가 */
  function carried(id) {
    const d = getDef(id);
    return !!d && slotWeapon(d.slot) === id;
  }
  function available(id) {
    const d = getDef(id);
    if (!d) return false;
    if (d.count != null) return inv[id].count > 0;
    return true;
  }
  function firstAllowedWeapon() {
    const ids = allowed.map(slotWeapon);
    return ids.find(available) || ids[0];
  }
  /** except가 아닌, 지금 꺼낼 수 있는 무기를 order 순서로 찾는다 */
  function otherWeapon(except, order = SLOTS) {
    for (const slot of order) {
      const id = slotWeapon(slot);
      if (id && id !== except && available(id)) return id;
    }
    return null;
  }

  let time = 0;
  let cur = firstAllowedWeapon();
  let prev = otherWeapon(cur, [2, 1, 3, 4]);
  let state = 'idle', stateT = 0, stateDur = 0;
  let swing = null;   // { kind, windup, hit, index }
  let prime = null;   // { kind, released }
  let burst = null;   // { left: 남은 발 수, nextAt: 다음 발 예약 시각 }
  let reloadQueued = false;
  let reloadEmpty = false;
  let semiAt = -1e9;

  // 줌. zoomP(0~1)는 조준 진행도이고, 배율은 lerp(1, stageMag, ease(zoomP))로 계산한다.
  // 단계 사이를 옮길 때는 zoomP가 1로 머물고 stageMag만 움직여서, 줌 인·단계 이동·줌 아웃 어디서 끊겨도 FOV가 튀지 않는다.
  let zoomP = 0, zoomTarget = 0, zoomToggleOn = false, zoomLatch = false;
  let zoomLevel = 0;    // 다단 줌: 버튼으로 고른 단계(0 = 해제). 볼트 중에 눌렀으면 끝난 뒤에 걸린다
  let activeLevel = 0;  // 실제로 걸려 있는 단계. getZoom().level
  let stageMag = 1, stageFrom = 1, stageTo = 1, stageT = 1;

  let moveF = 0, airF = 0;
  const motion = { speed: 0, onGround: true, walking: false, crouch: false };
  const recoil = { yaw: 0, pitch: 0 };
  let recoilCfg = null, lastShotAt = -1e9;

  let prevFire = false, prevZoom = false, prevToggle = false;
  let queue = [];

  const def = () => WEAPONS[cur];
  const wst = () => inv[cur];

  function emit(type, data) {
    const ev = { type, weaponId: cur, t: time };
    if (data) Object.assign(ev, data);
    queue.push(ev);
  }
  function setState(s, dur = 0) { state = s; stateT = 0; stateDur = dur; }
  function bolting(id = cur) { return WEAPONS[id].fire === 'bolt' && time + EPS < inv[id].boltUntil; }
  function publicState() { return state === 'idle' && bolting() ? 'bolt' : state; }

  /** 조준 계수 0~1. 저격은 퀵스코프 경계(accurateAt)에서 0→1로 끊긴다. */
  function aimFactor(d = def()) {
    const z = d.zoom;
    if (!z) return 0;
    if (z.accurateAt != null) return zoomP + 1e-6 >= z.accurateAt ? 1 : 0;
    return zoomP;
  }

  function spreadDeg(d = def(), w = wst()) {
    const s = d.spread;
    if (!s) return 0;
    const a = aimFactor(d);
    const base = lerp(s.hip, s.ads ?? s.hip, a);
    const mv = lerp(s.move ?? 0, s.adsMove ?? s.move ?? 0, a) * moveF;
    const air = lerp(s.air ?? 0, s.adsAir ?? s.air ?? 0, a) * airF;
    const bloom = (w.bloom || 0) * lerp(1, s.adsBloomMul ?? 1, a);
    return clamp((base + mv + air + bloom) * (motion.crouch ? CROUCH_SPREAD : 1) * mods.spread, 0, s.max ?? 45);
  }

  // ── 입력 정규화 ───────────────────────────────────────────────
  function normInput(i) {
    i = i || {};
    const fireDown = !!i.fireDown;
    const zoomDown = !!i.zoomDown;
    const firePressed = i.firePressed === undefined ? fireDown && !prevFire : !!i.firePressed;
    const zoomPressed = zoomDown && !prevZoom;
    const zoomToggleRaw = !!i.zoomToggle;
    // zoomToggle은 '이번 프레임에 눌림' 신호. 계속 true로 와도 처음 한 번만 센다.
    const zoomTogglePressed = i.zoomToggle === undefined ? zoomPressed : zoomToggleRaw && !prevToggle;
    let slot = i.slot == null || i.slot === false ? null : Number(i.slot);
    if (!(Number.isInteger(slot) && slot >= 1 && slot <= 4)) slot = null;
    const wheelN = Number(i.wheel);
    const wheel = Number.isFinite(wheelN) ? Math.sign(wheelN) : 0;
    return { fireDown, firePressed, zoomDown, zoomPressed, zoomToggleRaw, zoomTogglePressed,
      // 입력 계층은 두 신호를 함께 보낸다. 같은 클릭이 두 신호로 와도 다단 줌은 한 번만 넘어간다.
      zoomCycle: zoomPressed || zoomTogglePressed,
      reloadPressed: !!i.reloadPressed, slot, wheel };
  }

  function readMotion(m, dt) {
    m = m || {};
    const speed = Number.isFinite(m.speed) ? Math.max(0, m.speed) : 0;
    motion.speed = speed;
    motion.onGround = m.onGround !== false;
    motion.walking = !!m.walking;
    motion.crouch = !!m.crouch;
    let target = clamp((speed - 0.25) / Math.max(0.1, walkSpeed - 0.25), 0, 1.5);
    if (motion.walking) target *= 0.5;
    moveF = approach(moveF, target, 14, dt);
    airF = approach(airF, motion.onGround ? 0 : 1, motion.onGround ? 10 : 20, dt);
  }

  // ── 반동·탄퍼짐 회복 ───────────────────────────────────────────
  function recover(dt) {
    if (recoilCfg && time - lastShotAt > recoilCfg.recoverDelay) {
      const k = Math.exp(-recoilCfg.recoverRate * dt);
      recoil.yaw *= k;
      recoil.pitch *= k;
      if (Math.abs(recoil.yaw) < 1e-6) recoil.yaw = 0;
      if (Math.abs(recoil.pitch) < 1e-6) recoil.pitch = 0;
    }
    for (const slot of SLOTS) {
      const id = loadout[slot];
      const d = WEAPONS[id], w = inv[id];
      const delay = d.recoil ? d.recoil.recoverDelay : 0.1;
      if (time - w.lastShotAt <= delay) continue;
      if (d.recoil && w.shotIndex > 0) w.shotIndex = Math.max(0, w.shotIndex - dt * (d.recoil.patternRecover ?? 20));
      if (d.spread && w.bloom > 0) w.bloom = Math.max(0, w.bloom - dt * (d.spread.bloomDecay ?? 5));
    }
  }

  function kickRecoil(d, w, a) {
    const r = d.recoil;
    if (!r || !r.pattern || !r.pattern.length) return { yaw: 0, pitch: 0 };
    const pat = r.pattern, n = pat.length;
    let i = Math.floor(w.shotIndex + EPS);
    if (i >= n) {
      const lf = clamp(r.loopFrom ?? n - 1, 0, n - 1);
      i = lf + ((i - lf) % (n - lf));
    }
    const mul = lerp(1, r.adsMul ?? 1, a) * mods.recoil;
    const kYaw = -pat[i][0] * DEG * mul;   // 패턴 x(오른쪽 +) → yaw는 왼쪽이 +
    const kPitch = pat[i][1] * DEG * mul;
    recoil.yaw = clamp(recoil.yaw + kYaw, -r.maxYaw * DEG, r.maxYaw * DEG);
    recoil.pitch = clamp(recoil.pitch + kPitch, -r.maxPitch * DEG, r.maxPitch * DEG);
    recoilCfg = r;
    w.shotIndex = Math.floor(w.shotIndex + EPS) + 1;
    return { yaw: kYaw, pitch: kPitch };
  }

  // ── 줌 ────────────────────────────────────────────────────────
  /** 줌 목표를 내리고 고른 단계를 지운다. 다음 누름은 1단부터 시작한다. */
  function releaseZoom() {
    if (zoomTarget) {
      zoomTarget = 0;
      activeLevel = 0;
      emit('zoomChange', { zoomed: false, level: 0 });
    }
    zoomToggleOn = false;
    zoomLevel = 0;
  }

  function dropZoom(instant) {
    releaseZoom();
    zoomLatch = false;
    if (instant) {
      zoomP = 0;
      stageMag = stageFrom = stageTo = 1;
      stageT = 1;
    }
  }

  /** 다단 줌의 배율을 옮긴다. 조준이 풀려 있으면 화면에 보이지 않으니 곧바로 맞춘다. */
  function stepStageMag(z, dt) {
    const goal = z.levels[Math.max(zoomLevel, 1) - 1];
    if (zoomP <= 0) {
      stageMag = stageFrom = stageTo = goal;
      stageT = 1;
      return;
    }
    // zoomLevel이 0이면 줌 아웃 중이다. 마지막 배율을 그대로 두고 zoomP만 내려간다.
    if (zoomLevel > 0 && goal !== stageTo) {
      stageFrom = stageMag;
      stageTo = goal;
      stageT = 0;
    }
    if (stageT < 1) {
      stageT = Math.min(1, stageT + dt / (z.levelTime ?? z.inTime));
      stageMag = lerp(stageFrom, stageTo, easeOutQuad(stageT));
    }
  }

  function updateZoom(dt, inp) {
    const z = def().zoom;
    if (!z) { zoomP = 0; zoomTarget = 0; activeLevel = 0; return; }
    const cycling = !!z.levels && stageCycle;
    let want;
    if (cycling) {
      // 다단 줌은 설정과 관계없이 누를 때마다 0 → 1단 → … → 0으로 돈다
      if (inp.zoomCycle) zoomLevel = (zoomLevel + 1) % (z.levels.length + 1);
      want = zoomLevel > 0;
    } else if (zoomMode === 'hold') {
      if (!inp.zoomDown) zoomLatch = false;   // 저격 사격 후 줌은 버튼을 뗐다가 다시 눌러야 한다
      want = inp.zoomDown && !zoomLatch;
    } else {
      if (inp.zoomTogglePressed) zoomToggleOn = !zoomToggleOn;
      want = zoomToggleOn;
    }
    const can = state === 'idle' && !bolting();
    const target = want && can ? 1 : 0;
    const level = target ? (cycling ? zoomLevel : 1) : 0;
    if (target !== zoomTarget || level !== activeLevel) {
      zoomTarget = target;
      activeLevel = level;
      emit('zoomChange', { zoomed: target === 1, level });
    }
    if (z.levels) stepStageMag(z, dt);
    zoomP = target ? Math.min(1, zoomP + dt / z.inTime) : Math.max(0, zoomP - dt / z.outTime);
  }

  // ── 무기 교체 ──────────────────────────────────────────────────
  function cancelAction() {
    if (state === 'reload') emit('reloadCancel', {});
    else if (state === 'prime') emit('primeCancel', { kind: prime ? prime.kind : null });
    else if (state === 'swing' && swing && !swing.hit) emit('swingCancel', { kind: swing.kind });
    swing = null;
    prime = null;
    burst = null;   // 남은 점사는 버린다. 재사격 대기(nextFireAt)는 무기에 남아 교체로 건너뛸 수 없다
  }

  /** 진행 중인 동작을 끊고 id를 꺼낸다. 허용 여부는 부르는 쪽이 확인한다. */
  function drawWeapon(id) {
    cancelAction();
    dropZoom(true);
    const from = cur;
    cur = id;
    reloadQueued = false;
    semiAt = -1e9;
    setState('draw', drawOf(id));
    emit('switch', { from, to: id, slot: WEAPONS[id].slot, drawTime: drawOf(id) });
  }

  function switchTo(id) {
    if (!carried(id) || !available(id) || state === 'throw' || id === cur) return false;
    prev = cur;
    drawWeapon(id);
    return true;
  }

  /** 슬롯의 무기를 바꾼다. 새 무기는 탄약을 채워 받고, 바뀐 무기를 들고 있었다면 새 무기를 다시 꺼낸다. */
  function replaceSlot(slot, id) {
    const old = loadout[slot];
    if (id === old) return;
    loadout[slot] = id;
    inv[id] = fresh(id);
    if (prev === old) prev = id;
    if (cur === old) drawWeapon(id);
  }

  function cycleTarget(dir) {
    const list = SLOTS.map(slotWeapon).filter((id) => id && available(id));
    if (list.length < 2) return null;
    const i = list.indexOf(cur);
    if (i < 0) {
      const s = WEAPONS[cur].slot;
      let j = list.findIndex((id) => WEAPONS[id].slot > s);
      if (j < 0) j = 0;
      return dir > 0 ? list[j] : list[(j - 1 + list.length) % list.length];
    }
    return list[(i + dir + list.length) % list.length];
  }

  function handleSwitch(inp) {
    if (state === 'throw') return;
    let target = null;
    if (inp.slot) target = slotWeapon(inp.slot);   // 금지된 슬롯은 null이라 아무 일도 없다
    else if (inp.wheel) target = cycleTarget(inp.wheel);
    if (target && target !== cur) switchTo(target);
  }

  // ── 상태 타이머 ────────────────────────────────────────────────
  function advance(dt, inp) {
    stateT += dt;
    const d = def();
    switch (state) {
      case 'draw':
        if (stateT + EPS >= stateDur) setState('idle');
        break;
      case 'reload':
        if (stateT + EPS >= stateDur) finishReload();
        break;
      case 'swing': {
        if (swing && !swing.hit && stateT + EPS >= swing.windup) {
          swing.hit = true;
          const m = d.melee[swing.kind];
          emit('melee', { kind: swing.kind, damage: m.damage, range: m.range, arc: m.arc * DEG, index: swing.index });
        }
        if (stateT + EPS >= stateDur) { swing = null; setState('idle'); }
        break;
      }
      case 'prime': {
        if (!prime) { setState('idle'); break; }
        const held = prime.kind === 'underhand' ? inp.zoomDown : inp.fireDown;
        if (!held) prime.released = true;
        if (prime.released && stateT + EPS >= d.primeTime) doThrow();
        break;
      }
      case 'throw':
        if (stateT + EPS >= stateDur) finishThrow();
        break;
      default:
        break;
    }
  }

  // ── 재장전 ────────────────────────────────────────────────────
  function startReload() {
    const d = def(), w = wst();
    reloadEmpty = w.mag === 0;
    const dur = (reloadEmpty && d.reloadEmpty ? d.reloadEmpty : d.reload) / mods.reload;
    reloadQueued = false;
    releaseZoom();
    setState('reload', dur);
    emit('reloadStart', { duration: dur, empty: reloadEmpty, mag: w.mag, reserve: w.reserve });
  }

  function finishReload() {
    const w = wst();
    const take = Math.max(0, Math.min(magOf(cur) - w.mag, w.reserve));
    w.mag += take;
    w.reserve -= take;
    setState('idle');
    emit('reloadEnd', { mag: w.mag, reserve: w.reserve });
  }

  function handleReload(inp) {
    const d = def(), w = wst();
    if (d.mag == null) { reloadQueued = false; return; }
    if (inp.reloadPressed) reloadQueued = true;
    if (w.mag >= magOf(cur) || w.reserve <= 0) { reloadQueued = false; return; }
    if (!reloadQueued && w.mag !== 0) return;        // 탄창이 비면 자동 재장전
    if (state !== 'idle' || bolting() || time + EPS < w.nextFireAt) return;
    startReload();
  }

  // ── 사격 ─────────────────────────────────────────────────────
  function shoot() {
    const d = def(), w = wst();
    const a = aimFactor(d);
    const sd = spreadDeg(d, w);
    const sr = sd * DEG;
    const pellets = [];
    const count = Math.max(1, d.pellets | 0);
    for (let i = 0; i < count; i++) {
      const r = sr * rng();                  // 가운데로 몰리는 분포(원뿔 안)
      const th = rng() * Math.PI * 2;
      const yaw = r * Math.cos(th), pitch = r * Math.sin(th);
      pellets.push({ yaw, pitch, dir: dirFromYawPitch(yaw, pitch) });
    }
    const recoilAtShot = { yaw: recoil.yaw, pitch: recoil.pitch };
    // 탄 절약(좀비 모드 카드): 이 확률로 탄창이 줄지 않는다
    if (!(mods.thrift > 0 && rng() < mods.thrift)) w.mag -= 1;
    w.lastShotAt = time;
    lastShotAt = time;
    const shotIndex = Math.floor(w.shotIndex + EPS);
    const kick = kickRecoil(d, w, a);
    if (d.spread && d.spread.bloomPerShot) w.bloom = Math.min(d.spread.bloomMax ?? Infinity, w.bloom + d.spread.bloomPerShot);
    if (d.fire !== 'auto') w.nextFireAt = time + intervalOf(d);
    const isScope = !!(d.zoom && d.zoom.accurateAt != null);
    const scoped = d.zoom ? (isScope ? a >= 1 : zoomP >= 0.5) : false;
    const p0 = pellets[0];
    emit('fire', {
      slot: d.slot, yaw: p0.yaw, pitch: p0.pitch, dir: p0.dir, pellets,
      spread: sr, spreadDeg: sd, aim: a, zoom: zoomP, level: activeLevel, scoped,
      quickscope: isScope && scoped && zoomP < 1, noscope: isScope && !scoped,
      recoil: recoilAtShot, kick, shotIndex,
      mag: w.mag, reserve: w.reserve, maxRange: d.maxRange,
    });
    if (d.zoom && d.zoom.unzoomOnFire) {
      releaseZoom();
      zoomLatch = zoomMode === 'hold';
    }
    if (d.fire === 'bolt') {
      if (w.mag > 0) {
        w.boltUntil = time + d.bolt / mods.fire;
        w.nextFireAt = w.boltUntil;
        emit('boltCycle', { duration: d.bolt / mods.fire });
      } else {
        w.boltUntil = 0;
        w.nextFireAt = time + (d.emptyShotRecover ?? 0.3);
      }
    }
  }

  /** 쏠 수 있으면 start를 부른다. 'busy'면 아직 쿨다운 중이다. */
  function tryShoot(inp, start = shoot) {
    const w = wst();
    if (state !== 'idle' || bolting() || time + EPS < w.nextFireAt) return 'busy';
    if (w.mag <= 0) {
      if (w.reserve > 0) { reloadQueued = true; return 'reload'; }
      if (inp.firePressed) emit('dryFire', {});
      return 'dry';
    }
    start();
    return 'fired';
  }

  function fireAuto(inp, dt) {
    const d = def(), w = wst();
    if (state !== 'idle') return;
    if (w.mag <= 0) {
      if (inp.firePressed && w.reserve <= 0) emit('dryFire', {});
      return;
    }
    let n = 0;
    while (w.mag > 0 && time + EPS >= w.nextFireAt && n < MAX_SHOTS_PER_UPDATE) {
      // 계속 누르고 있었다면 예약 시각 기준으로 박자를 유지, 새로 눌렀다면 지금부터
      const continuous = (n > 0 || prevFire) && w.nextFireAt >= time - dt - EPS;
      const base = continuous ? w.nextFireAt : time;
      shoot();
      w.nextFireAt = base + intervalOf(d);
      n++;
      if (state !== 'idle') break;
    }
  }

  function openBurst() {
    burst = { left: def().burst.count, nextAt: time };
  }

  /** 예약된 점사 탄을 쏜다. 버튼을 떼도 끝까지 나가고, 탄이 떨어지면 거기서 끝난다. */
  function runBurst() {
    const d = def(), w = wst();
    const gap = d.burst.gap / mods.fire;
    while (burst && time + EPS >= burst.nextAt) {
      const at = burst.nextAt;
      shoot();
      burst.left -= 1;
      if (burst.left > 0 && w.mag > 0) {
        burst.nextAt = at + gap;
        // 남은 발까지 쏘고 쉬는 시점까지 잠가 둔다. 점사 중에 교체해서 재사격 대기를 건너뛰지 못하게 한다.
        w.nextFireAt = burst.nextAt + gap * (burst.left - 1) + intervalOf(d);
      } else {
        w.nextFireAt = at + intervalOf(d);
        burst = null;
      }
    }
  }

  function tryMelee(inp) {
    const d = def(), w = wst();
    if (state !== 'idle' || time + EPS < w.nextFireAt) return;
    let kind = null;
    if (inp.fireDown || inp.firePressed) kind = 'slash';
    else if (inp.zoomDown || inp.zoomTogglePressed) kind = 'stab';
    if (!kind) return;
    const m = d.melee[kind];
    const cooldown = m.cooldown / mods.fire;
    swing = { kind, windup: Math.min(m.windup, cooldown * 0.8), hit: false, index: w.swingIndex++ };
    w.nextFireAt = time + cooldown;
    w.lastShotAt = time;
    setState('swing', cooldown);
    emit('swing', { kind, duration: cooldown, windup: swing.windup, index: swing.index, damage: m.damage, range: m.range });
  }

  function tryPrime(inp) {
    const d = def(), w = wst();
    if (state !== 'idle' || !(w.count > 0)) return;
    let kind = null;
    if (inp.firePressed) kind = 'overhand';
    else if (inp.zoomPressed || inp.zoomTogglePressed) kind = 'underhand';
    if (!kind) return;
    const held = kind === 'overhand' ? inp.fireDown : inp.zoomDown;
    prime = { kind, released: !held };
    setState('prime', Infinity);
    emit('prime', { kind, primeTime: d.primeTime });
  }

  function doThrow() {
    const d = def(), w = wst();
    const kind = prime.kind;
    const t = kind === 'underhand' ? d.lob : d.throw;
    w.count = Math.max(0, w.count - 1);
    w.lastShotAt = time;
    prime = null;
    setState('throw', d.throwRecover);
    emit('throw', { kind, speed: t.speed, pitchUp: t.pitchUp * DEG, fuse: d.fuse, count: w.count });
  }

  function finishThrow() {
    setState('idle');
    if (available(cur)) {           // 여러 개를 들 수 있게 바뀌면 다시 꺼낸다
      setState('draw', drawOf(cur));
      emit('switch', { from: cur, to: cur, slot: def().slot, drawTime: drawOf(cur) });
      return;
    }
    const back = prev && prev !== cur && carried(prev) && available(prev) ? prev : otherWeapon(cur);
    if (back) switchTo(back);
  }

  function handleAttack(inp, dt) {
    const d = def();
    switch (d.fire) {
      case 'auto':
        if (inp.fireDown || inp.firePressed) fireAuto(inp, dt);
        break;
      case 'semi': {
        if (inp.firePressed) semiAt = time;
        if (time - semiAt <= SEMI_BUFFER + EPS) {
          if (tryShoot(inp) !== 'busy') semiAt = -1e9;
        }
        break;
      }
      case 'burst': {
        // 누르고 있어도 다시 쏘지 않는다. 클릭 한 번이 점사 한 번이다.
        if (inp.firePressed) semiAt = time;
        if (!burst && time - semiAt <= SEMI_BUFFER + EPS && tryShoot(inp, openBurst) !== 'busy') semiAt = -1e9;
        if (burst) runBurst();
        break;
      }
      case 'bolt':
        if (inp.firePressed) tryShoot(inp);
        break;
      case 'melee':
        tryMelee(inp);
        break;
      case 'throw':
        tryPrime(inp);
        break;
      default:
        break;
    }
  }

  // ── 공개 API ─────────────────────────────────────────────────
  /**
   * 한 프레임 진행.
   * @param {number} dt 초
   * @param {{fireDown?:boolean, firePressed?:boolean, zoomDown?:boolean, zoomToggle?:boolean,
   *          reloadPressed?:boolean, slot?:number|null, wheel?:number}} input
   * @param {{speed?:number, onGround?:boolean, walking?:boolean, crouch?:boolean}} motion  speed = 수평 속력(m/s), crouch = 앉음(탄퍼짐 ×0.8)
   * @returns {object[]} 이벤트 배열(새 배열)
   */
  function update(dt, input, motionIn) {
    dt = Number.isFinite(dt) ? clamp(dt, 0, MAX_DT) : 0;
    time += dt;
    const inp = normInput(input);
    readMotion(motionIn, dt);
    recover(dt);
    advance(dt, inp);
    handleSwitch(inp);
    updateZoom(dt, inp);
    handleReload(inp);
    handleAttack(inp, dt);
    prevFire = inp.fireDown;
    prevZoom = inp.zoomDown;
    prevToggle = inp.zoomToggleRaw;
    const out = queue;
    queue = [];
    return out;
  }

  function getZoom(baseFov = BASE_FOV) {
    const z = def().zoom;
    const base = Number.isFinite(baseFov) && baseFov > 0 ? baseFov : BASE_FOV;
    if (!z) {
      return { progress: 0, target: 0, zoomed: false, mag: 1, curMag: 1, fov: base, targetFov: base,
        overlay: null, scopeAmount: 0, hideViewmodel: false, accurate: false, level: 0, levels: 0 };
    }
    let mag = z.mag, baseMag = z.mag;
    if (z.levels) {
      // 줌 아웃 중에는 마지막 단계 배율을 그대로 알려서 사라지는 스코프의 표시가 바뀌지 않게 한다
      mag = activeLevel > 0 ? z.levels[activeLevel - 1] : zoomP > 0 ? stageTo : z.levels[0];
      baseMag = stageMag;
    }
    const curMag = lerp(1, baseMag, easeOutQuad(zoomP));
    return {
      progress: zoomP, target: zoomTarget, zoomed: zoomTarget === 1,
      mag, curMag, fov: zoomFov(base, curMag), targetFov: zoomFov(base, mag),
      overlay: z.overlay || null,
      // 스코프 오버레이 불투명도: 0.55부터 나타나 0.9(모형이 숨는 시점)에 완전히 덮는다
      scopeAmount: z.overlay === 'scope' ? clamp((zoomP - 0.55) / 0.35, 0, 1) : 0,
      hideViewmodel: !!z.overlay && z.hideViewmodelAt != null && zoomP > z.hideViewmodelAt,
      accurate: z.accurateAt != null ? aimFactor() >= 1 : zoomP >= 1,
      level: activeLevel,
      levels: z.levels ? z.levels.length : 1,
    };
  }

  function getSpread() {
    const deg = spreadDeg();
    const d = def();
    return { rad: deg * DEG, deg, accurate: !!(d.spread && d.zoom && d.zoom.accurateAt != null && aimFactor(d) >= 1) };
  }

  function getAmmo(id = cur) {
    const d = getDef(id);
    if (!d) return null;
    const w = inv[id];
    // 수류탄 슬롯이 금지된 규칙에서는 0개로 알린다. 봇이 던지려고 슬롯을 바꾸다 멈추지 않게 한다.
    if (d.count != null) return { weaponId: id, kind: 'count', mag: carried(id) ? w.count : 0, magSize: countOf(id), reserve: 0, infinite: false, reloading: false };
    if (d.mag == null) return { weaponId: id, kind: 'none', mag: null, magSize: null, reserve: null, infinite: true, reloading: false };
    return { weaponId: id, kind: 'mag', mag: w.mag, magSize: magOf(id), reserve: w.reserve, reserveMax: reserveOf(id), infinite: w.reserve === Infinity,
      reloading: id === cur && state === 'reload' };
  }

  /**
   * 손에 든 주무기·보조무기를 이번 목숨 동안 내려놓는다(바닥에 버리기). 그 칸은 비고 다른 무기를 꺼낸다.
   * 재장전·점사·줌은 끊긴다. 탄약은 지금 남은 그대로 돌려준다(바닥의 총이 이어받는다).
   * @returns {{ id:string, slot:number, mag:number, reserve:number } | null} 총을 들고 있지 않거나 꺼낼 다른 무기가 없으면 null
   */
  function dropHeld() {
    const d = WEAPONS[cur];
    if (!d || (d.slot !== 1 && d.slot !== 2) || state === 'throw' || state === 'prime') return null;
    const next = otherWeapon(cur, [1, 2, 3, 4].filter((s) => s !== d.slot));
    if (!next) return null;
    const w = inv[cur];
    const out = { id: cur, slot: d.slot, mag: Math.max(0, w.mag ?? 0), reserve: w.reserve === Infinity ? Infinity : Math.max(0, w.reserve ?? 0) };
    emptied.add(d.slot);
    drawWeapon(next);
    prev = otherWeapon(cur, [2, 1, 3, 4]);
    return out;
  }

  /** 이 칸을 이번 목숨에 버려서 비어 있는가(그래야 바닥의 총을 주울 수 있다) */
  function isSlotEmpty(slot) {
    return allowed.includes(slot) && emptied.has(slot);
  }

  /** 칸 slot에 총 id를 넣고 바로 꺼낸다. 탄약은 남은 만큼 이어받되 정의의 최대를 넘지 못한다(프리미엄 예비는 무제한 그대로) */
  function putInSlot(slot, id, ammo, draw = true) {
    const left = (v, max) => (Number.isFinite(v) ? clamp(Math.floor(v), 0, max) : max);
    const w = fresh(id);
    w.mag = left(ammo && ammo.mag, magOf(id));
    if (w.reserve !== Infinity) w.reserve = left(ammo && ammo.reserve, w.reserve);
    emptied.delete(slot);
    loadout[slot] = id;
    inv[id] = w;
    if (state === 'throw' || !draw) { prev = id; return true; }
    if (cur !== id) prev = cur;
    drawWeapon(id);
    return true;
  }

  /**
   * 바닥에서 주운 총을 그 총의 칸(주무기 1, 보조 2)에 넣는다. 그 칸이 비어 있을 때만 된다(먼저 버려야 줍는다).
   * 다음 목숨은 resetRound가 자기 장비로 되돌린다.
   * @returns {boolean} 총이 아니거나, 칸이 막혔거나, 칸에 이미 무기가 있으면 false
   */
  function takeWeapon(id, ammo = {}) {
    const d = WEAPONS[id];
    if (!d || (d.slot !== 1 && d.slot !== 2) || !isSlotEmpty(d.slot)) return false;
    // 칼·수류탄을 들고 있거나 권총을 들고 주무기를 주웠을 때만 바로 꺼낸다. 싸우는 중에 권총을 주웠다고 소총이 바뀌지 않게 한다
    const held = WEAPONS[cur];
    const draw = !held || held.slot > 2 || d.slot < held.slot;
    return putInSlot(d.slot, id, ammo, draw);
  }

  /** 주무기를 더 쏠 수 없는가(탄창과 예비가 모두 비었다). 주무기 슬롯이 막힌 규칙에서는 false */
  function isPrimaryEmpty() {
    if (!allowed.includes(1)) return false;
    const w = inv[loadout[1]];
    return w.mag <= 0 && w.reserve <= 0;
  }

  /**
   * 바닥에서 주운 총을 슬롯 1에 넣고 바로 꺼낸다. 탄약은 남은 만큼 이어받되 정의의 최대를 넘지 못한다(프리미엄 예비는 무제한 그대로).
   * 수류탄을 던지는 중이면 다 던진 뒤 이 총으로 돌아온다. 다음 목숨은 resetRound가 자기 장비로 되돌린다.
   * @returns {boolean} 주무기가 아니거나 슬롯이 막혀 있으면 false
   */
  function takePrimary(id, ammo = {}) {
    if (!PRIMARY_IDS.includes(id) || !allowed.includes(1)) return false;
    return putInSlot(1, id, ammo);
  }

  function stateProgress() {
    return stateDur > 0 && Number.isFinite(stateDur) ? clamp(stateT / stateDur, 0, 1) : 0;
  }

  function getWeapon() {
    const d = def();
    let progress = stateProgress();
    const s = publicState();
    if (s === 'bolt') progress = clamp(1 - (inv[cur].boltUntil - time) / (d.bolt / mods.fire), 0, 1);
    return { id: cur, slot: d.slot, name: d.name, nameEn: d.nameEn, short: d.short, def: d,
      state: s, progress, elapsed: stateT, duration: Number.isFinite(stateDur) ? stateDur : 0, previous: prev };
  }

  /** 슬롯 4칸. 금지된 슬롯은 id·이름이 null이고 allowed가 false다. */
  function getSlots() {
    return SLOTS.map((slot) => {
      const id = slotWeapon(slot);
      if (!id) return { slot, id: null, name: null, short: null, icon: null, empty: true, active: false, allowed: isSlotEmpty(slot), dropped: isSlotEmpty(slot) };
      const d = WEAPONS[id];
      return { slot, id, name: d.name, short: d.short, icon: d.icon, empty: !available(id), active: id === cur, allowed: true };
    });
  }

  function getMoveMul() {
    const d = def();
    return d.moveMul * (d.zoom ? lerp(1, d.zoom.moveMul ?? 1, zoomP) : 1);
  }

  /** viewmodel.update(dt, state)에 그대로 넘기는 표시용 상태 */
  function getViewState(baseFov) {
    const d = def(), w = wst();
    const z = getZoom(baseFov);
    const s = publicState();
    return {
      weaponId: cur, phase: s, phaseT: s === 'bolt' ? getWeapon().progress : stateProgress(),
      phaseDur: Number.isFinite(stateDur) ? stateDur : 0,
      zoom: zoomP, level: z.level, levels: z.levels, curMag: z.curMag, overlay: z.overlay, hideViewmodel: z.hideViewmodel, aim: aimFactor(d),
      speed: motion.speed, onGround: motion.onGround, walking: motion.walking,
      mag: w.mag, count: w.count, reloadEmpty: state === 'reload' && reloadEmpty,
      swingKind: swing ? swing.kind : null, primeKind: prime ? prime.kind : null,
    };
  }

  /** UI hud.set()에 그대로 넣는 값(ammo·reserve·mag·reloading·reload·slots·slot·spread·fov·crosshair) */
  function getHud(baseFov) {
    const d = def();
    const a = getAmmo();
    const z = getZoom(baseFov);
    return {
      ammo: a.kind === 'none' ? null : a.mag,
      reserve: a.kind === 'mag' ? a.reserve : null,
      mag: a.kind === 'none' ? null : a.magSize,
      reloading: state === 'reload',
      reload: state === 'reload' ? stateProgress() : null,
      slots: SLOTS.map((s) => { const id = slotWeapon(s); return id && available(id) ? id : null; }),
      slot: d.slot,
      spread: getSpread().rad,
      fov: z.fov,
      crosshair: !(d.zoom && zoomP > 0.5),
    };
  }

  /** 없는 키는 유지한다. 잘못된 id는 무시한다. */
  function setLoadout(o) {
    if (o && typeof o === 'object') {
      for (const [key, slot, ids] of LOADOUT_KEYS) if (ids.includes(o[key])) replaceSlot(slot, o[key]);
    }
    return getLoadout();
  }

  function getLoadout() {
    return { primary: loadout[1], secondary: loadout[2], melee: loadout[3] };
  }

  /** 슬롯 제한을 바꾼다(칼전 등). 들고 있는 무기가 금지되면 허용된 첫 슬롯을 꺼낸다. 쓸 슬롯이 없으면 false. */
  function setAllowedSlots(list) {
    const next = normSlots(list);
    if (!next) return false;
    allowed = next;
    if (!carried(cur)) drawWeapon(firstAllowedWeapon());
    if (!prev || !carried(prev)) prev = otherWeapon(cur, [2, 1, 3, 4]);
    return true;
  }

  function resetRound(o = {}) {
    emptied.clear();
    for (const [key, slot, ids] of LOADOUT_KEYS) if (ids.includes(o[key])) loadout[slot] = o[key];
    for (const id of WEAPON_IDS) inv[id] = fresh(id);
    recoil.yaw = 0; recoil.pitch = 0; recoilCfg = null; lastShotAt = -1e9;
    zoomP = 0; zoomTarget = 0; zoomToggleOn = false; zoomLatch = false;
    zoomLevel = 0; activeLevel = 0;
    stageMag = stageFrom = stageTo = 1; stageT = 1;
    swing = null; prime = null; burst = null; reloadQueued = false; semiAt = -1e9;
    moveF = 0; airF = 0;
    const from = cur;
    cur = firstAllowedWeapon();
    prev = otherWeapon(cur, [2, 1, 3, 4]);
    const drawDur = o.draw ? drawOf(cur) : 0;
    setState(o.draw ? 'draw' : 'idle', drawDur);
    emit('switch', { from, to: cur, slot: def().slot, drawTime: drawDur, reset: true });
  }

  if (opts.draw) {
    setState('draw', drawOf(cur));
    emit('switch', { from: null, to: cur, slot: def().slot, drawTime: drawOf(cur) });
  }

  /**
   * 배율을 바꾼다(없는 키는 그대로, null이면 기본값으로). 지금 든 탄은 그대로 두고, 예비 탄이 새 최대를 넘으면 자른다.
   * → 지금 배율(사본)
   */
  function setMods(o) {
    if (o === null) Object.assign(mods, MOD_BASE);
    else if (o && typeof o === 'object') {
      for (const k of Object.keys(MOD_BASE)) {
        if (!(k in o)) continue;
        const v = Number(o[k]);
        if (!Number.isFinite(v)) continue;
        if (k === 'magAdd' || k === 'nades') mods[k] = Math.max(0, Math.round(v));
        else if (k === 'thrift') mods[k] = clamp(v, 0, 0.9);
        else if (k === 'finiteMags') mods[k] = Math.max(0, v);
        else mods[k] = clamp(pos(v, MOD_BASE[k]), 0.05, 20);
      }
    }
    for (const id of WEAPON_IDS) {
      const w = inv[id];
      const rmax = reserveOf(id);
      if (w.reserve != null && rmax != null && w.reserve > rmax) w.reserve = rmax;
      if (w.reserve === Infinity && Number.isFinite(rmax)) w.reserve = rmax;
      if (w.count != null) w.count = Math.min(w.count, countOf(id));
    }
    return { ...mods };
  }

  /** 들고 있는 총들(주무기·보조)의 예비 탄을 최대까지 채운다 */
  function refillReserve() {
    for (const slot of [1, 2]) {
      const id = loadout[slot];
      const rmax = reserveOf(id);
      if (rmax != null) inv[id].reserve = rmax;
    }
  }
  /** 수류탄을 최대까지 채운다 */
  function refillGrenades() {
    const g = inv[GRENADE_ID];
    g.count = countOf(GRENADE_ID);
    return g.count;
  }
  /** 든 총의 탄창에 n발을 바로 넣는다(탄창 크기까지, 좀비 모드 '탄약 회수') → 넣은 수 */
  function addMagAmmo(n, id = cur) {
    const w = inv[id], mx = magOf(id);
    if (!w || mx == null || !(n > 0)) return 0;
    const add = Math.max(0, Math.min(mx - w.mag, Math.floor(n)));
    w.mag += add;
    return add;
  }
  /** 총의 예비 탄에 n발 더하기(최대까지) → 더한 수 */
  function addReserve(n, id = cur) {
    const w = inv[id], rmax = reserveOf(id);
    if (!w || rmax == null || !Number.isFinite(rmax) || !(n > 0)) return 0;
    const add = Math.max(0, Math.min(rmax - w.reserve, Math.floor(n)));
    w.reserve += add;
    return add;
  }

  /**
   * 무기 id를 제 칸(주무기·보조·근접)에 넣는다. ammo { mag, reserve }를 주면 그 탄으로(최대를 넘지 않게), 안 주면 새 탄으로 채운다.
   * 그 칸을 들고 있었으면 새 무기를 바로 꺼낸다. 버려서 빈 칸도 다시 채운다.
   * 좀비 물량 막기의 무기 교체가 '한 번 쓴 총은 남은 탄 그대로'를 지키려고 쓴다. → 넣었으면 true
   */
  function equipWith(id, ammo) {
    const d = WEAPONS[id];
    const entry = LOADOUT_KEYS.find(([, , ids]) => ids.includes(id));
    if (!d || !entry) return false;
    const slot = entry[1];
    const old = loadout[slot];
    const wasEmpty = emptied.has(slot);
    emptied.delete(slot);
    loadout[slot] = id;
    const w = fresh(id);
    if (ammo && d.mag != null) {
      const left = (v, max) => (Number.isFinite(v) ? clamp(Math.floor(v), 0, max) : max);
      w.mag = left(ammo.mag, magOf(id));
      if (w.reserve !== Infinity) w.reserve = left(ammo.reserve, w.reserve);
    }
    inv[id] = w;
    if (id !== old || wasEmpty) {
      if (prev === old) prev = id;
      if (cur === old && !wasEmpty) drawWeapon(id);
    }
    return true;
  }

  function setPrimary(id) {
    if (!PRIMARY_IDS.includes(id)) return false;
    replaceSlot(1, id);
    return true;
  }

  return {
    update,
    getZoom,
    getSpread,
    /** 카메라에 '더할' 반동 오프셋(누적값, 라디안). 매 프레임 내 각도에 누적하지 말 것. */
    getRecoilKick: () => ({ yaw: recoil.yaw, pitch: recoil.pitch }),
    getAmmo,
    isPrimaryEmpty,
    takePrimary,
    takeWeapon,
    dropHeld,
    isSlotEmpty,
    getWeapon,
    getSlots,
    getMoveMul,
    getViewState,
    getHud,
    /** 네트워크 표시용 최소 상태 { w: 무기 id, s: 상태, z: 줌 0|1 } */
    serialize: () => ({ w: cur, s: publicState(), z: zoomTarget ? 1 : 0 }),
    /** 슬롯 번호(1~4) 또는 무기 id로 교체. 로드아웃에 없거나 금지된 무기는 false. 이벤트는 다음 update()에서 나온다. */
    select: (slotOrId) => switchTo(typeof slotOrId === 'number' ? slotWeapon(slotOrId) : slotOrId),
    setPrimary,
    getPrimary: () => loadout[1],
    setLoadout,
    getLoadout,
    setAllowedSlots,
    getAllowedSlots: () => allowed.slice(),
    /** 이 무기를 지금 들 수 있는가(로드아웃에 있고 슬롯이 허용됨) */
    carries: carried,
    /** validateHit + 로드아웃 검사. 들고 있지 않은 무기의 타격이면 reason:'weapon' */
    validateHit: (id, info) => (carried(id) ? validateHit(id, info) : { ok: false, reason: 'weapon' }),
    setZoomMode: (m) => { zoomMode = m === 'toggle' ? 'toggle' : 'hold'; zoomToggleOn = false; zoomLatch = false; },
    getZoomMode: () => zoomMode,
    resetRound,
    giveGrenade: (n = 1) => {
      const g = inv[GRENADE_ID];
      g.count = clamp((g.count || 0) + (n | 0), 0, countOf(GRENADE_ID));
      return g.count;
    },
    setMods,
    getMods: () => ({ ...mods }),
    refillReserve,
    refillGrenades,
    addMagAmmo,
    addReserve,
    equipWith,
    getTime: () => time,
    dispose: () => { queue = []; },
  };
}
