/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 멀티플레이 메시지 스키마와 압축 직렬화. 상태·사격·히트 주장·수류탄·경기·로드아웃·채팅·핑을 작은 배열로 바꾸고,
 *          믿을 수 없는 입력을 받아도 던지지 않고 null을 돌려준다. 엔진·three.js·DOM에 의존하지 않는다.
 */
/**
 * SKALA 작전 — 게임 동기화 프로토콜 (메시지 스키마 + 압축 직렬화). 순수 모듈(엔진·three.js·DOM 없음).
 *
 * net의 room.send(event, payload)에 논리 메시지 하나씩 싣는다. net이 같은 JS 턴의 메시지를
 * 프레임 하나로 묶고(Supabase 계수 = 프레임 수), { merge:true }는 다음 프레임 전까지 마지막 값만 남긴다.
 *
 * 이벤트 이름 = 'g' + 버전 + 타입문자 (호환 안 되는 옛 클라이언트와 섞이지 않게). 아래 표의 g2는 지금 버전이다.
 *   g2s 상태(merge)   [seq, t, x,y,z, yaw,pitch, vx,vy,vz, slot, flags, hp]
 *   g2f 사격 연출     [weaponId, t, ox,oy,oz, dx,dy,dz, (hx,hy,hz, hitKind)]
 *   g2h 히트 주장     [id, victimId, part, weaponId, distCm, kind, shotT, count, shotId?]   → sendTo(방장)
 *   g2x 수류탄        [id, px,py,pz, vx,vy,vz, t]
 *   g2m 경기(merge)   [mseq, phase, round, scoreOwner, scoreCharterer, endsAt, players, events, rest?]
 *   g2l 로드아웃(merge) [id, {...}]
 *   g2c 채팅          [id, text]
 *   g2d 총 버림       [id, dropId, weaponId, x,y,z, mag, reserve]   reserve −1 = 무제한
 *   g2k 총 주움       [id, dropId]
 *   g2p 핑/퐁(merge)  [pid, t0, d0?] → sendTo(방장) / [pid, t0, t1, t2, d2?, e0?] → sendTo(요청자)
 *                     d = 보낸 쪽 room.now()(있으면). 받는 쪽이 net 프레임 시각(msg.t)과 비교해
 *                     net 큐에서 기다린 시간(e)을 알아내 t0·t2를 보정한다.
 *
 * 시각: 상태·사격의 t = 보낸 쪽 로컬 시계(performance.now, ms 정수).
 *       shotT, 수류탄 t, endsAt = 방장 시계(sync.hostNow()). 핑 t0/t3는 요청자, t1/t2는 방장 로컬 시계.
 * 단위: 위치 cm 정수, 속도 cm/s 정수, 각도 0.01 rad 정수, 방향 단위벡터 ×1000 정수.
 * 디코더는 신뢰할 수 없는 입력을 가정한다: 형식이 틀리면 null. 절대 throw하지 않는다.
 */

export const PROTOCOL_VERSION = 2;
const PFX = 'g' + PROTOCOL_VERSION;

/** net 이벤트 이름 */
export const EV = Object.freeze({
  state: PFX + 's', fire: PFX + 'f', hit: PFX + 'h', grenade: PFX + 'x',
  match: PFX + 'm', loadout: PFX + 'l', chat: PFX + 'c', ping: PFX + 'p',
  drop: PFX + 'd', pick: PFX + 'k'
});

const TAU = Math.PI * 2;
const HALF_PI = Math.PI / 2;
const MAX_CM = 1e7;          // ±100 km — 비정상 값만 막는다
const MAX_ID = 64;
const MAX_WEAPON = 16;
const MAX_CHAT = 120;
const MAX_HIT_COUNT = 64;    // 한 주장의 펠릿 수 상한. 정확한 값(def.pellets)은 match가 무기별로 자른다
const MAX_SHOT_ID = 0x7fffffff;

/** 상태 플래그 비트 (crouch = 앉기). 6~9번 비트(64·128·256·512)는 이모트 번호 0~15(EMOTE_SHIFT). 1024 이상은 엔진이 자유롭게 써도 된다 — 그대로 전달 */
export const FLAG = Object.freeze({ onGround: 1, zoom: 2, walking: 4, alive: 8, reloading: 16, crouch: 32 });
const FLAG_KEYS = Object.keys(FLAG);
export const EMOTE_SHIFT = 6;
export const EMOTE_MASK = 15 << EMOTE_SHIFT;

/** 코드 표 — 알려진 문자열은 작은 정수로, 모르는 문자열은 그대로(디코더는 둘 다 받는다) */
export const PART_CODES = Object.freeze(['head', 'body', 'legs', 'hand', 'foot']);   // 앞 순서는 바꾸지 않고 뒤에만 더한다
export const KIND_CODES = Object.freeze(['shot', 'slash', 'stab', 'grenade', 'other']);
export const PHASE_CODES = Object.freeze(['lobby', 'warmup', 'loadout', 'live', 'roundEnd', 'matchEnd']);
export const TEAM_CODES = Object.freeze(['owner', 'charterer']);
export const IMPACT_CODES = Object.freeze(['none', 'world', 'player']);

/** 경기 이벤트별 위치 필드(이 순서로 배열에 담고, 나머지 키는 끝 객체 하나로 — 무손실) */
export const MATCH_EVENT_FIELDS = Object.freeze({
  kill: ['killer', 'victim', 'weaponId', 'part'],
  damage: ['attacker', 'victim', 'amount', 'part', 'hp'],
  roundStart: ['round'],
  roundEnd: ['round', 'winner', 'reason'],
  matchEnd: ['winner'],
  explode: ['gid', 'pos'],
  team: ['player', 'team']
});

const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/* ------------------------------------------------------------------ 기본 도우미 */

/** 라디안 → (-π, π] */
export function wrapAngle(a) {
  a = +a;
  if (!Number.isFinite(a)) return 0;
  a %= TAU;
  if (a > Math.PI) a -= TAU;
  else if (a <= -Math.PI) a += TAU;
  return a;
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const fin = (v, d = 0) => (isNum(v) ? v : (typeof v === 'string' && v !== '' && Number.isFinite(+v) ? +v : d));
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const toInt = (v) => Math.round(v) || 0; // NaN·-0 → 0

/** [x,y,z] | {x,y,z} → [x,y,z] (숫자 아님 → 0) */
export function vec3(v) {
  if (!v) return [0, 0, 0];
  if (Array.isArray(v) || ArrayBuffer.isView(v)) return [fin(v[0]), fin(v[1]), fin(v[2])];
  return [fin(v.x), fin(v.y), fin(v.z)];
}

const cm = (m) => clamp(toInt(fin(m) * 100), -MAX_CM, MAX_CM);
/** 받은 cm 값 → m. 터무니없는 값은 ±100 km에서 자른다(그대로 두면 렌더·충돌 계산까지 간다) */
const fromCm = (v) => clamp(v, -MAX_CM, MAX_CM) / 100;
const ang = (a) => toInt(wrapAngle(fin(a)) * 100);
const pitchQ = (a) => toInt(clamp(fin(a), -HALF_PI, HALF_PI) * 100);
const ms = (t) => toInt(fin(t));

function code(v, table) {
  const i = table.indexOf(v);
  if (i >= 0) return i;
  return typeof v === 'string' ? v.slice(0, 24) : 0;
}
function uncode(v, table) {
  if (typeof v === 'number') return table[v] === undefined ? null : table[v];
  return typeof v === 'string' ? v.slice(0, 24) : null;
}
function idStr(v) {
  if (isNum(v)) return String(v);
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_ID ? v : null;
}

/** 신뢰할 수 없는 객체의 키를 out에 얕게 복사 (프로토타입 오염 키 제외, 이미 있는 키는 유지) */
function copyKeys(src, out) {
  if (src && typeof src === 'object' && !Array.isArray(src)) {
    for (const k of Object.keys(src)) if (!BAD_KEYS.has(k) && !(k in out)) out[k] = src[k];
  }
  return out;
}

/** JSON 직렬화 UTF-8 바이트 수 */
export function byteSize(obj) {
  const s = typeof obj === 'string' ? obj : JSON.stringify(obj);
  if (s === undefined) return 0;
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

const MAX_EXTRA = 8192; // 경기 스냅샷 부가 키·이벤트 하나의 한도(B). match.js 최악 1.7KB
let warnedSize = false;

/** JSON으로 보낼 수 있는 값만 (함수·순환·NaN 제거). maxBytes 초과면 null(한 번 경고) */
function jsonSafe(v, maxBytes, what) {
  if (v === undefined) return null;
  try {
    const s = JSON.stringify(v);
    if (s === undefined) return null;
    if (byteSize(s) > maxBytes) {
      if (what && !warnedSize) { warnedSize = true; console.warn('[protocol] ' + what + '이(가) ' + maxBytes + 'B를 넘어 버렸습니다'); }
      return null;
    }
    return JSON.parse(s);
  } catch (_) { return null; }
}

/* ------------------------------------------------------------------ 상태 */

/**
 * 로컬 상태 → 상태 몸통 11개 [x,y,z, yaw,pitch, vx,vy,vz, slot, flags, hp]
 * 입력: { pos:[x,y,z] (또는 x,y,z), vel:[...], yaw, pitch, slot, hp, onGround, zoom, walking, alive, reloading, flags? }
 *  - flags 숫자를 주면 그 비트를 바탕으로 불리언 필드가 덮어쓴다. 둘 다 없으면 alive·onGround = true.
 */
export function encodeStateBody(s) {
  if (!s || typeof s !== 'object') return null;
  const p = s.pos ? vec3(s.pos) : [fin(s.x), fin(s.y), fin(s.z)];
  const v = s.vel ? vec3(s.vel) : [fin(s.vx), fin(s.vy), fin(s.vz)];
  const given = isNum(s.flags);
  let flags = given ? (s.flags & 0xffff) : 0;
  for (const k of FLAG_KEYS) {
    if (s[k] !== undefined) flags = s[k] ? (flags | FLAG[k]) : (flags & ~FLAG[k]);
    else if (!given && (k === 'alive' || k === 'onGround')) flags |= FLAG[k];
  }
  // 이모트 번호(0 = 없음, 1~15) — MODES.md 4절
  if (s.emote !== undefined) flags = (flags & ~EMOTE_MASK) | (clamp(toInt(fin(s.emote, 0)), 0, 15) << EMOTE_SHIFT);
  return [
    cm(p[0]), cm(p[1]), cm(p[2]),
    ang(s.yaw), pitchQ(s.pitch),
    cm(v[0]), cm(v[1]), cm(v[2]),
    clamp(toInt(fin(s.slot, 1)), 0, 9),
    flags,
    clamp(toInt(fin(s.hp, 100)), 0, 999)
  ];
}

/** 상태 메시지 [seq, t, ...몸통] */
export function encodeState(seq, t, s) {
  const body = Array.isArray(s) ? s : encodeStateBody(s);
  return body ? [seq | 0, ms(t)].concat(body) : null;
}

/** → { seq, t, pos, vel, yaw, pitch, slot, flags, hp, onGround, zoom, walking, alive, reloading } | null */
export function decodeState(a) {
  if (!Array.isArray(a) || a.length < 13) return null;
  for (let i = 0; i < 13; i++) if (!isNum(a[i])) return null;
  const flags = a[11] & 0xffff;
  const out = {
    seq: Math.floor(a[0]),
    t: a[1],
    pos: [clamp(a[2], -MAX_CM, MAX_CM) / 100, clamp(a[3], -MAX_CM, MAX_CM) / 100, clamp(a[4], -MAX_CM, MAX_CM) / 100],
    vel: [clamp(a[7], -MAX_CM, MAX_CM) / 100, clamp(a[8], -MAX_CM, MAX_CM) / 100, clamp(a[9], -MAX_CM, MAX_CM) / 100],
    yaw: wrapAngle(a[5] / 100),
    pitch: clamp(a[6] / 100, -HALF_PI, HALF_PI),
    slot: clamp(a[10] | 0, 0, 9),
    flags,
    hp: clamp(a[12] | 0, 0, 999)
  };
  for (const k of FLAG_KEYS) out[k] = !!(flags & FLAG[k]);
  out.emote = (flags & EMOTE_MASK) >> EMOTE_SHIFT;
  return out;
}

/** 로컬 상태를 전송 해상도로 반올림한 값 */
export function quantizeState(s) {
  const d = decodeState(encodeState(0, 0, s));
  if (d) { delete d.seq; delete d.t; }
  return d;
}

/**
 * 두 상태 몸통이 '거의 같다'(유휴 판정): 위치 ±posCm, 각도 ±angU, 양쪽 속도 모두 |v| ≤ velCm, 이산 필드 동일
 */
export function bodyNearlyEqual(a, b, posCm = 1, angU = 1, velCm = 5) {
  if (!a || !b) return false;
  if (Math.abs(a[0] - b[0]) > posCm || Math.abs(a[1] - b[1]) > posCm || Math.abs(a[2] - b[2]) > posCm) return false;
  let dy = Math.abs(a[3] - b[3]);
  if (dy > 314) dy = 628 - dy; // ±π 경계
  if (dy > angU || Math.abs(a[4] - b[4]) > angU) return false;
  for (let i = 5; i < 8; i++) if (Math.abs(a[i]) > velCm || Math.abs(b[i]) > velCm) return false;
  return a[8] === b[8] && a[9] === b[9] && a[10] === b[10];
}

/* ------------------------------------------------------------------ 사격 연출 */

/**
 * @param {number} t 사격 시각(보낸 쪽 로컬 ms)
 * @param {{weaponId:string, origin:number[], dir:number[], hit?:number[]|null, hitKind?:'world'|'player'}} f
 */
export function encodeFire(t, f) {
  const o = vec3(f && f.origin);
  let d = vec3(f && f.dir);
  const len = Math.hypot(d[0], d[1], d[2]);
  d = len > 1e-9 ? [d[0] / len, d[1] / len, d[2] / len] : [0, 0, -1];
  const a = [String((f && f.weaponId) || '').slice(0, MAX_WEAPON), ms(t),
    cm(o[0]), cm(o[1]), cm(o[2]), toInt(d[0] * 1000), toInt(d[1] * 1000), toInt(d[2] * 1000)];
  if (f && f.hit) {
    const h = vec3(f.hit);
    a.push(cm(h[0]), cm(h[1]), cm(h[2]), code(f.hitKind || 'world', IMPACT_CODES));
  }
  return a;
}

export function decodeFire(a) {
  if (!Array.isArray(a) || a.length < 8 || typeof a[0] !== 'string') return null;
  for (let i = 1; i < 8; i++) if (!isNum(a[i])) return null;
  const dl = Math.hypot(a[5], a[6], a[7]) || 1;
  const out = {
    weaponId: a[0].slice(0, MAX_WEAPON), t: a[1],
    origin: [fromCm(a[2]), fromCm(a[3]), fromCm(a[4])],
    dir: [a[5] / dl, a[6] / dl, a[7] / dl],
    hit: null, hitKind: null
  };
  if (a.length >= 11 && isNum(a[8]) && isNum(a[9]) && isNum(a[10])) {
    out.hit = [fromCm(a[8]), fromCm(a[9]), fromCm(a[10])];
    out.hitKind = uncode(a[11], IMPACT_CODES) || 'world';
  }
  return out;
}

/* ------------------------------------------------------------------ 히트 주장 */

/** 맞은 펠릿 수. 숫자가 아니거나 1보다 작으면 1 */
function hitCount(v) {
  const n = Math.floor(fin(v, 1));
  return n < 1 ? 1 : n > MAX_HIT_COUNT ? MAX_HIT_COUNT : n;
}
/** 같은 발의 주장을 묶는 번호. 양의 정수만 인정하고, 아니면 0(번호 없음) */
function shotIdOf(v) {
  const n = fin(v, 0);
  return Number.isInteger(n) && n > 0 && n <= MAX_SHOT_ID ? n : 0;
}

/**
 * @param {{victimId, part, weaponId, dist (m), kind, shotT (방장 시계 ms), count?, shotId?}} h
 *   count = 이 주장에 담은 펠릿 수(기본 1), shotId = 같은 발을 묶는 양의 정수(산탄이 여러 명을 맞혔을 때 match가 연사 검사를 한 번만 한다)
 */
export function encodeHit(id, h) {
  const o = h && typeof h === 'object' ? h : {};
  const a = [id | 0, String(o.victimId == null ? '' : o.victimId).slice(0, MAX_ID), code(o.part || 'body', PART_CODES),
    String(o.weaponId || '').slice(0, MAX_WEAPON), clamp(toInt(fin(o.dist) * 100), 0, MAX_CM),
    code(o.kind || 'shot', KIND_CODES), ms(o.shotT), hitCount(o.count)];
  const shotId = shotIdOf(o.shotId);
  if (shotId) a.push(shotId);
  return a;
}

/** → { id, victimId, part, weaponId, dist, kind, shotT, count, shotId } | null. 끝의 두 칸은 없어도 된다(count 1, shotId null) */
export function decodeHit(a) {
  if (!Array.isArray(a) || a.length < 7 || !isNum(a[0]) || !isNum(a[4]) || !isNum(a[6])) return null;
  const victimId = idStr(a[1]);
  if (!victimId) return null;
  return {
    id: a[0] | 0, victimId, part: uncode(a[2], PART_CODES) || 'body',
    weaponId: typeof a[3] === 'string' ? a[3].slice(0, MAX_WEAPON) : '',
    dist: clamp(a[4], 0, MAX_CM) / 100, kind: uncode(a[5], KIND_CODES) || 'shot', shotT: a[6],
    count: hitCount(a[7]), shotId: shotIdOf(a[8]) || null
  };
}

/* ------------------------------------------------------------------ 수류탄 */

/** @param {{pos, vel, t (방장 시계 ms)}} g */
export function encodeGrenade(id, g) {
  const p = vec3(g.pos), v = vec3(g.vel);
  return [id | 0, cm(p[0]), cm(p[1]), cm(p[2]), cm(v[0]), cm(v[1]), cm(v[2]), ms(g.t)];
}

export function decodeGrenade(a) {
  if (!Array.isArray(a) || a.length < 8) return null;
  for (let i = 0; i < 8; i++) if (!isNum(a[i])) return null;
  return { id: a[0] | 0, pos: [fromCm(a[1]), fromCm(a[2]), fromCm(a[3])], vel: [fromCm(a[4]), fromCm(a[5]), fromCm(a[6])], t: a[7] };
}

/* ------------------------------------------------------------------ 경기 스냅샷 + 이벤트 */

function packFields(obj, keys) {
  const vals = keys.map((k) => (obj[k] === undefined ? null : obj[k]));
  let rest = null;
  for (const k of Object.keys(obj)) {
    if (k === 'type' || k === 'eid' || keys.includes(k) || obj[k] === undefined) continue;
    (rest || (rest = {}))[k] = obj[k];
  }
  return rest ? vals.concat([rest]) : vals;
}

/** 경기 이벤트 {type, ...} → [eid, type, ...] */
export function encodeMatchEvent(eid, ev) {
  const e = ev && typeof ev === 'object' ? ev : {};
  const type = String(e.type || 'event').slice(0, 24);
  const body = jsonSafe(packFields(e, MATCH_EVENT_FIELDS[type] || []), MAX_EXTRA, '경기 이벤트(' + type + ')') || [];
  return [eid | 0, type].concat(body);
}

/** [eid, type, ...] → { eid, type, ...필드 } | null */
export function decodeMatchEvent(a) {
  if (!Array.isArray(a) || a.length < 2 || !isNum(a[0]) || typeof a[1] !== 'string') return null;
  const type = a[1].slice(0, 24);
  const keys = MATCH_EVENT_FIELDS[type] || [];
  const out = { eid: a[0] | 0, type };
  for (let i = 0; i < keys.length; i++) out[keys[i]] = a[2 + i] === undefined ? null : a[2 + i];
  return copyKeys(a[2 + keys.length], out);
}

const SNAP_KEYS = ['phase', 'round', 'score', 'endsAt', 'players'];
const PLAYER_KEYS = ['id', 'team', 'hp', 'alive', 'kills', 'deaths'];

/**
 * 경기 스냅샷 → 경기 메시지 페이로드
 * snapshot = { phase, round, score:{owner,charterer}|[a,b], endsAt(방장 시계 ms, 0=없음),
 *              players:{ [id]:{team,hp,alive,kills,deaths,...} } | [{id,...}], ...기타 키(무손실) }
 * encodedEvents = encodeMatchEvent 결과 배열(최근 이벤트 — 받는 쪽이 eid로 중복 제거)
 */
export function encodeMatch(mseq, snapshot, encodedEvents = []) {
  const s = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const sc = Array.isArray(s.score) ? s.score : [s.score && s.score.owner, s.score && s.score.charterer];
  const players = [];
  const src = s.players || {};
  const list = Array.isArray(src) ? src.map((p) => [p && p.id, p]) : Object.keys(src).map((id) => [id, src[id]]);
  for (const [id, p] of list) {
    const pid = idStr(id);
    if (!pid || !p || typeof p !== 'object') continue;
    const row = [pid, code(p.team == null ? '' : p.team, TEAM_CODES), clamp(toInt(fin(p.hp)), 0, 999), p.alive ? 1 : 0,
      toInt(fin(p.kills)), toInt(fin(p.deaths))];
    let rest = null;
    for (const k of Object.keys(p)) if (!PLAYER_KEYS.includes(k) && p[k] !== undefined) (rest || (rest = {}))[k] = p[k];
    if (rest) { const r = jsonSafe(rest, 1024, '경기 플레이어 부가 키'); if (r) row.push(r); }
    players.push(row);
  }
  let rest = null;
  for (const k of Object.keys(s)) if (!SNAP_KEYS.includes(k) && s[k] !== undefined) (rest || (rest = {}))[k] = s[k];
  const a = [mseq | 0, code(s.phase || 'lobby', PHASE_CODES), toInt(fin(s.round)), toInt(fin(sc[0])), toInt(fin(sc[1])),
    ms(s.endsAt), players, encodedEvents];
  if (rest) { const r = jsonSafe(rest, MAX_EXTRA, '경기 스냅샷 부가 키'); if (r) a.push(r); }
  return a;
}

/** → { seq, snapshot, events } | null */
export function decodeMatch(a) {
  if (!Array.isArray(a) || a.length < 8 || !isNum(a[0]) || !Array.isArray(a[6]) || !Array.isArray(a[7])) return null;
  const snapshot = {
    phase: uncode(a[1], PHASE_CODES) || 'lobby',
    round: fin(a[2]) | 0,
    score: { owner: fin(a[3]) | 0, charterer: fin(a[4]) | 0 },
    endsAt: fin(a[5]),
    players: {}
  };
  for (const row of a[6]) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const id = idStr(row[0]);
    if (!id || BAD_KEYS.has(id)) continue;
    const p = { team: uncode(row[1], TEAM_CODES), hp: fin(row[2]) | 0, alive: !!row[3], kills: fin(row[4]) | 0, deaths: fin(row[5]) | 0 };
    snapshot.players[id] = copyKeys(row[6], p);
  }
  copyKeys(a[8], snapshot);
  const events = [];
  for (const e of a[7]) { const d = decodeMatchEvent(e); if (d) events.push(d); }
  return { seq: a[0] | 0, snapshot, events };
}

/* ------------------------------------------------------------------ 로드아웃 · 채팅 · 핑 */

export function encodeLoadout(id, loadout) { return [id | 0, jsonSafe(loadout, 256, '로드아웃') || {}]; }
export function decodeLoadout(a) {
  if (!Array.isArray(a) || a.length < 2 || !isNum(a[0]) || !a[1] || typeof a[1] !== 'object' || Array.isArray(a[1])) return null;
  return { id: a[0] | 0, loadout: copyKeys(a[1], {}) };
}

/** 제어문자 제거 + 길이 제한 (화면에는 반드시 textContent로) */
export function cleanText(v, max = MAX_CHAT) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}
export function encodeChat(id, text) { return [id | 0, cleanText(text)]; }
export function decodeChat(a) {
  if (!Array.isArray(a) || a.length < 2 || !isNum(a[0]) || typeof a[1] !== 'string') return null;
  const text = cleanText(a[1]);
  return text ? { id: a[0] | 0, text } : null;
}

/** 핑 [pid, t0(요청자 로컬), d0?(요청자 room.now)] */
export function encodePing(pid, t0, d0) {
  const a = [pid | 0, ms(t0)];
  if (isNum(d0)) a.push(ms(d0));
  return a;
}
/** 퐁 [pid, t0, t1(방장 수신), t2(방장 송신), d2?(방장 room.now), e0?(핑이 요청자 net 큐에서 기다린 ms)] */
export function encodePong(pid, t0, t1, t2, d2, e0) {
  const a = [pid | 0, ms(t0), ms(t1), ms(t2)];
  if (isNum(d2)) a.push(ms(d2), clamp(ms(e0), 0, 60000));
  return a;
}
/** → { pid, t0, d0 } (핑) | { pid, t0, t1, t2, d2, e0 } (퐁) | null */
export function decodePing(a) {
  if (!Array.isArray(a) || !isNum(a[0]) || !isNum(a[1])) return null;
  if (a.length <= 3) return { pid: a[0] | 0, t0: a[1], d0: isNum(a[2]) ? a[2] : null };
  if (!isNum(a[2]) || !isNum(a[3])) return null;
  return { pid: a[0] | 0, t0: a[1], t1: a[2], t2: a[3], d2: isNum(a[4]) ? a[4] : null, e0: isNum(a[5]) ? clamp(a[5], 0, 60000) : 0 };
}

/* ------------------------------------------------------------------ 바닥에 버린 총 */

/** @param {{ dropId, weaponId, pos, mag, reserve }} d  reserve가 Infinity(프리미엄)면 −1로 보낸다 */
export function encodeDrop(id, d) {
  const o = d && typeof d === 'object' ? d : {};
  const p = vec3(o.pos);
  return [id | 0, String(o.dropId == null ? '' : o.dropId).slice(0, MAX_ID), String(o.weaponId || '').slice(0, MAX_WEAPON),
    cm(p[0]), cm(p[1]), cm(p[2]), clamp(toInt(fin(o.mag)), 0, 9999), o.reserve === Infinity ? -1 : clamp(toInt(fin(o.reserve)), 0, 9999)];
}

/** → { id, dropId, weaponId, pos, mag, reserve } | null. 탄약 상한과 무기 종류는 받는 쪽(drops.js)이 무기 표로 다시 자른다 */
export function decodeDrop(a) {
  if (!Array.isArray(a) || a.length < 8 || !isNum(a[0]) || typeof a[2] !== 'string') return null;
  const dropId = idStr(a[1]);
  if (!dropId) return null;
  for (let i = 3; i < 8; i++) if (!isNum(a[i])) return null;
  return {
    id: a[0] | 0, dropId, weaponId: a[2].slice(0, MAX_WEAPON),
    pos: [fromCm(a[3]), fromCm(a[4]), fromCm(a[5])],
    mag: clamp(a[6] | 0, 0, 9999), reserve: a[7] < 0 ? Infinity : clamp(a[7] | 0, 0, 9999)
  };
}

export function encodePick(id, dropId) { return [id | 0, String(dropId == null ? '' : dropId).slice(0, MAX_ID)]; }

/** → { id, dropId } | null */
export function decodePick(a) {
  if (!Array.isArray(a) || a.length < 2 || !isNum(a[0])) return null;
  const dropId = idStr(a[1]);
  return dropId ? { id: a[0] | 0, dropId } : null;
}

/* ------------------------------------------------------------------ 이벤트 이름 → 디코더 */

const DECODERS = {
  [EV.state]: ['state', decodeState], [EV.fire]: ['fire', decodeFire], [EV.hit]: ['hit', decodeHit],
  [EV.grenade]: ['grenade', decodeGrenade], [EV.match]: ['match', decodeMatch], [EV.loadout]: ['loadout', decodeLoadout],
  [EV.chat]: ['chat', decodeChat], [EV.ping]: ['ping', decodePing], [EV.drop]: ['drop', decodeDrop], [EV.pick]: ['pick', decodePick]
};

const decoderOf = (event) => (typeof event === 'string' && Object.prototype.hasOwnProperty.call(DECODERS, event) ? DECODERS[event] : null);

/** 이 프로토콜의 이벤트인지 */
export function isGameEvent(event) { return !!decoderOf(event); }

/** (event, payload) → { type, data } | null (모르는 이벤트·형식 오류) */
export function decodeMessage(event, payload) {
  const d = decoderOf(event);
  if (!d) return null;
  try {
    const data = d[1](payload);
    return data ? { type: d[0], data } : null;
  } catch (_) { return null; }
}
