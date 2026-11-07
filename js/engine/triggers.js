/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 점프 발판·포털·비밀 스팟 판정(순수 모듈, three.js 없음). 맵 데이터를 판정 표로 바꾸고,
 *          틱마다 몸 위치를 검사해 발판 속도를 넣고 포털·비밀 진입을 호출한 쪽에 알려 준다.
 */
import { PLAYER, TICK_DT, toRad } from '../core/consts.js';

/** 발판 재발동 대기(초) */
export const PAD_COOLDOWN = 0.35;
/** 발과 발판 높이 차가 이 안이어야 발동(m) */
export const PAD_HEIGHT_TOL = 0.35;
/** 포털 전체 재발동 대기(초). 도착지가 다른 포털 근처여도 왕복하지 않게 한다 */
export const PORTAL_COOLDOWN = 1;
/** apex를 안 적었을 때 쓰는 값(m) */
export const DEFAULT_PAD_APEX = 3;
/** 색을 안 적었을 때 쓰는 값 */
export const DEFAULT_TRIGGER_COLOR = '#35e0ff';
/** 비밀 스팟 보상을 안 적었을 때 쓰는 값 */
export const DEFAULT_SECRET_POINTS = 100;

const MIN_APEX = 0.05;
const NO_SECRETS = Object.freeze([]);
const NOTHING = Object.freeze({ pad: null, portal: null, secrets: NO_SECRETS });

const isNum = (v) => v !== null && v !== '' && v !== undefined && typeof v !== 'boolean' && Number.isFinite(+v);
const numOr = (v, d) => (isNum(v) ? +v : d);
const posOr = (v, d) => (isNum(v) && +v > 0 ? +v : d);
const listOf = (v) => (Array.isArray(v) ? v : []);

/** [x,y,z] 또는 {x,y,z} → [x,y,z] (숫자가 아니면 null) */
export function vec3(v) {
  if (!v || typeof v !== 'object') return null;
  const x = Array.isArray(v) ? v[0] : v.x, y = Array.isArray(v) ? v[1] : v.y, z = Array.isArray(v) ? v[2] : v.z;
  return isNum(x) && isNum(y) && isNum(z) ? [+x, +y, +z] : null;
}

/**
 * from에서 target에 떨어지는 초기 속도. 최고점은 둘 중 높은 쪽보다 apex만큼 위다.
 * @param {number[]|{x,y,z}} from 출발(발 위치)
 * @param {number[]|{x,y,z}} target 도착(발 위치)
 * @param {number} [apex] 높은 쪽 위 여유(m)
 * @param {number} [gravity] 중력(부호 무관)
 * @returns {number[]} [vx, vy, vz]
 */
export function padVelocity(from, target, apex = DEFAULT_PAD_APEX, gravity = PLAYER.GRAVITY) {
  const a = vec3(from), b = vec3(target);
  if (!a || !b) return [0, 0, 0];
  const g = Math.abs(+gravity) || Math.abs(PLAYER.GRAVITY);
  const rise = apex === null || apex === undefined ? DEFAULT_PAD_APEX : Math.max(MIN_APEX, numOr(apex, MIN_APEX));
  const top = Math.max(a[1], b[1]) + rise;
  const vy = Math.sqrt(2 * g * (top - a[1]));
  const time = vy / g + Math.sqrt((2 * (top - b[1])) / g);
  return [(b[0] - a[0]) / time, vy, (b[2] - a[2]) / time];
}

function padEntry(p, i) {
  if (!p || typeof p !== 'object' || !isNum(p.x) || !isNum(p.z)) return null;
  const target = vec3(p.target), vel = vec3(p.vel);
  if (!target && !vel) return null;
  const x = +p.x, y = numOr(p.y, 0), z = +p.z, w = posOr(p.w, 2.4), d = posOr(p.d, 2.4);
  return {
    ...p, src: i, x, y, z, w, d, target, vel,
    apex: posOr(p.apex, DEFAULT_PAD_APEX),
    color: typeof p.color === 'string' && p.color ? p.color : DEFAULT_TRIGGER_COLOR,
    minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2
  };
}

function portalEntry(p, i) {
  if (!p || typeof p !== 'object' || !isNum(p.x) || !isNum(p.z)) return null;
  const dest = vec3(p.to);
  if (!dest) return null;
  const x = +p.x, y = numOr(p.y, 0), z = +p.z, w = posOr(p.w, 2), h = posOr(p.h, 2.6), d = posOr(p.d, 0.8);
  const rawYaw = Array.isArray(p.to) ? undefined : p.to.rotY;
  const to = { x: dest[0], y: dest[1], z: dest[2] };
  if (isNum(rawYaw)) to.rotY = toRad(rawYaw);
  return {
    ...p, src: i, x, y, z, w, h, d, to,
    color: typeof p.color === 'string' && p.color ? p.color : DEFAULT_TRIGGER_COLOR,
    minX: x - w / 2, maxX: x + w / 2, minY: y, maxY: y + h, minZ: z - d / 2, maxZ: z + d / 2
  };
}

function secretEntry(s, i) {
  if (!s || typeof s !== 'object' || !isNum(s.x) || !isNum(s.z)) return null;
  const x = +s.x, y = numOr(s.y, 0), z = +s.z, w = posOr(s.w, 2), h = posOr(s.h, 2), d = posOr(s.d, 2);
  const id = s.id === undefined || s.id === null || s.id === '' ? `secret${i}` : String(s.id);
  return {
    ...s, src: i, id, name: s.name ? String(s.name) : id, x, y, z, w, h, d,
    points: isNum(s.points) && +s.points >= 0 ? +s.points : DEFAULT_SECRET_POINTS,
    minX: x - w / 2, maxX: x + w / 2, minY: y, maxY: y + h, minZ: z - d / 2, maxZ: z + d / 2
  };
}

/**
 * 맵 데이터 → 판정 표(world.triggers). 잘못된 항목은 뺀다(이유는 validateMap이 알려 준다).
 * 각 항목은 원본 필드를 그대로 갖고 index(표 위치), src(원본 위치), minX…maxZ가 더해진다.
 * @returns {{pads:object[], portals:object[], secrets:object[], empty:boolean}}
 */
export function buildTriggers(data) {
  const src = data && typeof data === 'object' ? data : {};
  const collect = (items, make) => {
    const out = [];
    items.forEach((item, i) => {
      const entry = make(item, i);
      if (entry) { entry.index = out.length; out.push(entry); }
    });
    return out;
  };
  const pads = collect(listOf(src.pads), padEntry);
  const portals = collect(listOf(src.portals), portalEntry);
  const secrets = collect(listOf(src.secrets), secretEntry);
  return { pads, portals, secrets, empty: !pads.length && !portals.length && !secrets.length };
}

function stateOf(state) {
  if (state.time === undefined) {
    state.time = 0;
    state.padReadyAt = {};   // 발판 index → 다시 발동할 수 있는 시각
    state.portalReadyAt = 0; // 포털 전체
    state.inPortal = {};     // 포털 index → 지금 안에 있음(나갔다 들어와야 다시 발동)
    state.seenSecrets = {};  // 비밀 id → true
  }
  return state;
}

const insideXZ = (t, x, z) => x >= t.minX && x <= t.maxX && z >= t.minZ && z <= t.maxZ;
const insideBox = (t, x, feet, head, z) => insideXZ(t, x, z) && feet < t.maxY && head > t.minY;

/**
 * 틱마다 호출한다. 발판은 여기서 body.vel과 onGround를 바꾸고, 포털은 알리기만 한다(순간이동은 호출한 쪽 몫).
 * @param {object} world world.triggers가 있는 physics world
 * @param {{pos:number[], vel:number[], onGround:boolean}} body
 * @param {number} height 지금 키(앉으면 작다)
 * @param {object} state 이 몸의 트리거 상태. 빈 객체를 넘기면 여기서 채운다. 목숨마다 새로 만들면 비밀도 다시 잡힌다
 * @param {number} [dt] 틱 길이(초). 기본은 고정 틱(TICK_DT)
 * @returns {{pad:object|null, portal:object|null, secrets:object[]}} 이번 틱에 발동한 것
 */
export function stepTriggers(world, body, height = PLAYER.HEIGHT, state = {}, dt = TICK_DT) {
  const trig = world && world.triggers;
  if (!trig || trig.empty || !body || !body.pos) return NOTHING;
  const st = stateOf(state);
  st.time += dt > 0 ? dt : 0;
  const now = st.time;
  const x = body.pos[0], feet = body.pos[1], z = body.pos[2];
  const head = feet + (height > 0 ? height : PLAYER.HEIGHT);
  let pad = null, portal = null, secrets = null;

  for (const p of trig.pads) {
    if (!insideXZ(p, x, z) || Math.abs(feet - p.y) > PAD_HEIGHT_TOL) continue;
    if (now < (st.padReadyAt[p.index] || 0)) continue;
    const v = p.target ? padVelocity(body.pos, p.target, p.apex, PLAYER.GRAVITY) : p.vel;
    if (!body.vel) body.vel = [0, 0, 0];
    body.vel[0] = v[0]; body.vel[1] = v[1]; body.vel[2] = v[2];
    body.onGround = false;
    st.padReadyAt[p.index] = now + PAD_COOLDOWN;
    pad = p;
    break;
  }

  for (const p of trig.portals) {
    const inside = insideBox(p, x, feet, head, z);
    const entered = inside && !st.inPortal[p.index];
    st.inPortal[p.index] = inside;
    if (entered && !portal && now >= st.portalReadyAt) {
      st.portalReadyAt = now + PORTAL_COOLDOWN;
      portal = p;
    }
  }

  for (const s of trig.secrets) {
    if (st.seenSecrets[s.id] || !insideBox(s, x, feet, head, z)) continue;
    st.seenSecrets[s.id] = true;
    (secrets || (secrets = [])).push(s);
  }

  if (!pad && !portal && !secrets) return NOTHING;
  return { pad, portal, secrets: secrets || NO_SECRETS };
}
