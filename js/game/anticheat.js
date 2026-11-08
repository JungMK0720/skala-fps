/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: (방장) 원격 플레이어가 보낸 값을 방장이 아는 위치로 다시 확인한다. 사격 거리·벽 가림, 이동 속도·상승·순간이동, 위반 누적.
 *          게임 서버가 없는 구조라 방장 브라우저가 맡는다(방장 자신의 조작은 막지 못한다). three.js·DOM 없이 도는 순수 모듈이다.
 */
import { PLAYER, MOVE } from '../core/consts.js';
import { padVelocity } from '../engine/triggers.js';

export const GUARD = Object.freeze({
  /** 쏜 사람 화면의 상대는 보간 지연과 전송 시간만큼 늦게 그려진다. 이 시각들 중 하나라도 맞으면 인정한다(ms) */
  VICTIM_LAG_MS: Object.freeze([0, 100, 200, 300, 450]),
  /** 쏜 사람 자신의 위치 후보(ms 전) */
  SHOOTER_LAG_MS: Object.freeze([0, 100, 200]),
  /** 위치 지연으로 생기는 거리 오차(m). 쏜 사람이 이보다 더 가깝다고 우기면 방장이 잰 거리를 쓴다 */
  DIST_TOL: 3,
  MELEE_TOL: 1.5,
  /** 이동 속도·상승 속도 여유 배수와 덧셈 여유 */
  SPEED_MUL: 1.35,
  SPEED_ADD: 1,
  /** 한 번에 이만큼 넘게 옮겨졌고 속도로도 설명되지 않으면 순간이동이다(m) */
  TELEPORT_M: 8,
  /** 포털 출구·스폰 지점에서 이 거리 안이면 순간이동을 허용한다(m) */
  EXIT_R: 3,
  /** 이 간격보다 길게 소식이 끊기면 비교하지 않고 새로 시작한다(ms) */
  GAP_MS: 2000,
  /** 위반 점수: 이 시간 안에 LIMIT점이 쌓이면 내보낸다 */
  STRIKE_WINDOW_MS: 20000,
  STRIKE_LIMIT: 6,
  /** 위반별 점수. 지연으로도 생길 수 있는 것은 1, 정상 클라이언트에서는 나오지 않는 것은 2 */
  STRIKE_WEIGHT: Object.freeze({ no_los: 1, speed: 1, rise: 1, out_of_range: 1, teleport: 2, too_fast: 2 })
});

const okPos = (s) => !!(s && Array.isArray(s.pos) && s.pos.length >= 3 && s.pos.every((n) => Number.isFinite(n)));

function eyeOf(a) {
  return [a.pos[0], a.pos[1] + (a.crouch ? PLAYER.CROUCH_EYE : PLAYER.EYE), a.pos[2]];
}

/** 상대 몸에서 겨눌 만한 점: 머리·가슴·다리 */
function aimPoints(v) {
  const [x, y, z] = v.pos;
  const c = !!v.crouch;
  return [[x, y + (c ? 1.12 : 1.62), z], [x, y + (c ? 0.85 : 1.25), z], [x, y + 0.45, z]];
}

function safeLos(los, a, b) {
  try { return los(a, b) !== false; } catch (e) { return true; }   // 판정 함수가 깨지면 막지 않는다
}

/**
 * 히트 주장 하나를 위치로 확인한다.
 * @param {object} o
 * @param {number} o.dist 쏜 사람이 적어 보낸 거리(m)
 * @param {boolean} [o.melee] 근접 무기
 * @param {Array<{pos:number[], crouch?:boolean}>} o.shooter 쏜 사람이 그 시각 있었을 자리 후보
 * @param {Array<{pos:number[], crouch?:boolean}>} o.victim 맞은 사람이 쏜 사람 화면에 있었을 자리 후보
 * @param {(a:number[], b:number[]) => boolean} [o.los] 맵 벽에 막히지 않았는가
 * @returns {{ ok:boolean, dist:number, checked:boolean, reason?:'no_los' }}
 *   dist는 방장이 다시 잰 거리다. 쏜 사람이 더 가깝다고 우겨도 (잰 거리 - 여유) 아래로는 내려가지 않는다.
 *   위치를 모르면 checked=false로 주장한 거리를 그대로 돌려준다(막 들어온 사람 등).
 */
export function checkHitClaim({ dist, melee = false, shooter = [], victim = [], los = null }) {
  const claimed = Number.isFinite(+dist) && +dist >= 0 ? +dist : 0;
  const S = (Array.isArray(shooter) ? shooter : []).filter(okPos);
  const V = (Array.isArray(victim) ? victim : []).filter(okPos);
  if (!S.length || !V.length) return { ok: true, dist: claimed, checked: false };
  let best = Infinity;
  let seen = !los;
  for (const a of S) {
    const eye = eyeOf(a);
    for (const v of V) {
      for (const p of aimPoints(v)) {
        const d = Math.hypot(p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]);
        if (d < best) best = d;
        if (!seen && safeLos(los, eye, p)) seen = true;   // 보이는 짝을 하나 찾으면 벽 검사는 그만한다
      }
    }
  }
  const out = Math.max(claimed, best - (melee ? GUARD.MELEE_TOL : GUARD.DIST_TOL));
  return seen ? { ok: true, dist: out, checked: true } : { ok: false, dist: out, checked: true, reason: 'no_los' };
}

/** 맵에서 낼 수 있는 가장 빠른 수평·상승 속도(발판 포함)와 순간이동이 허용되는 지점(포털 출구·스폰) */
export function moveLimits(map) {
  let h = MOVE.MAX_SPEED;
  let v = PLAYER.JUMP_V;
  for (const p of (map && Array.isArray(map.pads)) ? map.pads : []) {
    if (!p) continue;
    let vel = null;
    if (p.target) vel = padVelocity([+p.x || 0, +p.y || 0, +p.z || 0], p.target, p.apex);
    else if (Array.isArray(p.vel)) vel = p.vel;
    if (!vel) continue;
    h = Math.max(h, Math.hypot(+vel[0] || 0, +vel[2] || 0));
    v = Math.max(v, +vel[1] || 0);
  }
  const exits = [];
  for (const q of (map && Array.isArray(map.portals)) ? map.portals : []) {
    if (q && q.to && Number.isFinite(+q.to.x) && Number.isFinite(+q.to.z)) exits.push([+q.to.x, +q.to.y || 0, +q.to.z]);
  }
  const spawns = map && map.spawns && typeof map.spawns === 'object' ? map.spawns : {};
  for (const list of Object.values(spawns)) {
    for (const s of Array.isArray(list) ? list : []) {
      if (s && Number.isFinite(+s.x) && Number.isFinite(+s.z)) exits.push([+s.x, +s.y || 0, +s.z]);
    }
  }
  return { h: h * GUARD.SPEED_MUL + GUARD.SPEED_ADD, v: v * GUARD.SPEED_MUL + GUARD.SPEED_ADD, exits };
}

/**
 * 원격 플레이어의 위치가 물리적으로 가능한지 본다.
 * feed(id, { t, pos, alive }) → null | { reason: 'teleport'|'speed'|'rise', moved, dt }
 *   t는 보낸 사람 시계(ms)다. 같은 사람의 연속 메시지 간격만 쓰므로 시계 차이와 상관없다.
 * reset(id)는 스폰·부활처럼 정상적으로 옮겨질 때 부른다.
 * @param {{ getMap?: () => object }} [o]
 */
export function createMoveGuard({ getMap = () => null } = {}) {
  const last = new Map();
  let mapRef, limits = moveLimits(null);
  function currentLimits() {
    const m = getMap();
    if (m !== mapRef) { mapRef = m; limits = moveLimits(m); }
    return limits;
  }
  const nearExit = (pos, L) => L.exits.some((e) => Math.hypot(pos[0] - e[0], pos[2] - e[2]) <= GUARD.EXIT_R && Math.abs(pos[1] - e[1]) <= 4);
  return {
    feed(id, s) {
      const key = String(id);
      if (!s || !okPos(s) || !Number.isFinite(+s.t)) return null;
      const cur = { t: +s.t, pos: s.pos.slice(0, 3), alive: s.alive !== false };
      const prev = last.get(key);
      last.set(key, cur);
      if (!prev || !prev.alive || !cur.alive) return null;
      const dtMs = cur.t - prev.t;
      if (!(dtMs > 15) || dtMs > GUARD.GAP_MS) return null;
      const dt = dtMs / 1000;
      const L = currentLimits();
      const moved = Math.hypot(cur.pos[0] - prev.pos[0], cur.pos[2] - prev.pos[2]);
      const rise = cur.pos[1] - prev.pos[1];
      const maxMove = L.h * dt + 1.5;
      if (moved > maxMove) {
        if (moved > GUARD.TELEPORT_M) return nearExit(cur.pos, L) ? null : { reason: 'teleport', moved, dt };
        return { reason: 'speed', moved, dt };
      }
      if (rise > L.v * dt + PLAYER.STEP + 0.35 && !nearExit(cur.pos, L)) return { reason: 'rise', moved: rise, dt };
      return null;
    },
    reset(id) { last.delete(String(id)); },
    resetAll() { last.clear(); },
    get limits() { return currentLimits(); }
  };
}

/**
 * 위반 점수. add가 true를 돌려주면 한도를 넘었다(내보낼 때다).
 * @param {{ now?: () => number, windowMs?: number, limit?: number }} [o]
 */
export function createStrikes({ now = () => Date.now(), windowMs = GUARD.STRIKE_WINDOW_MS, limit = GUARD.STRIKE_LIMIT } = {}) {
  const log = new Map();
  const live = (id) => {
    const t = now();
    const list = (log.get(String(id)) || []).filter((x) => t - x.t < windowMs);
    log.set(String(id), list);
    return list;
  };
  return {
    add(id, reason) {
      const w = GUARD.STRIKE_WEIGHT[reason] || 1;
      const list = live(id);
      list.push({ t: now(), w, reason });
      return list.reduce((sum, x) => sum + x.w, 0) >= limit;
    },
    score(id) { return live(id).reduce((sum, x) => sum + x.w, 0); },
    clear(id) { log.delete(String(id)); },
    reset() { log.clear(); }
  };
}
