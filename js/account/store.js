/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 프로필과 기기 토큰의 localStorage 저장, 저장 형식 정규화, 서버 프로필 병합 규칙.
 *          값이 깨졌거나 없거나 저장소를 쓸 수 없어도 예외 없이 기본값으로 동작한다.
 */
import { DEFAULT_LOADOUT, WEAPON_IDS, getDef } from '../weapons/defs.js';
import { START_POINTS, clampPoints, defaultOwned } from './economy.js';
import { validateNickname } from './nickname.js';

export const PROFILE_KEY = 'skalafps.profile.v1';
export const TOKEN_KEY = 'skalafps.token';
export const PROFILE_VERSION = 1;
export const STAT_KEYS = Object.freeze(['kills', 'deaths', 'headshots', 'halfShots', 'matches', 'wins', 'draws', 'knifeKills', 'secondsPlayed']);
/** 장비 칸 → 무기 정의의 slot 번호 */
export const LOADOUT_SLOTS = Object.freeze({ primary: 1, secondary: 2, melee: 3 });
/** supabase/schema.sql의 fps_save_profile과 같은 상한 */
export const STAT_MAX = 1000000000;

const TOKEN_RE = /^[0-9a-f]{64}$/;
const SECRET_ID_MAX = 40;
const SECRET_NAME_MAX = 40;

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isRecord = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** 있는 무기만 정의 순서대로. 기본 지급 무기는 항상 포함한다. */
export function normalizeOwned(list) {
  const have = new Set(Array.isArray(list) ? list : []);
  for (const id of defaultOwned()) have.add(id);
  return WEAPON_IDS.filter((id) => have.has(id));
}

function normalizeLoadout(raw, owned) {
  const src = isRecord(raw) ? raw : {};
  const out = {};
  for (const key of Object.keys(LOADOUT_SLOTS)) {
    const id = src[key];
    const def = typeof id === 'string' ? getDef(id) : null;
    out[key] = def && def.slot === LOADOUT_SLOTS[key] && owned.includes(id) ? id : DEFAULT_LOADOUT[key];
  }
  return out;
}

/** 모르는 항목은 버리고 음수·문자는 0으로 */
export function normalizeStats(raw) {
  const src = isRecord(raw) ? raw : {};
  const out = {};
  for (const key of STAT_KEYS) {
    const n = Number(src[key]);
    out[key] = Number.isFinite(n) && n > 0 ? Math.min(STAT_MAX, Math.floor(n)) : 0;
  }
  return out;
}

/** 맵·비밀 스팟 id로 쓸 수 있는 값. __proto__는 객체 키로 넣으면 프로토타입을 건드리므로 막는다. */
export function isSecretId(id) {
  return typeof id === 'string' && id.length >= 1 && id.length <= SECRET_ID_MAX && id !== '__proto__';
}

/** 형식: { [mapId]: { [secretId]: { name, at } } }. at은 처음 찾은 시각(ms). */
function normalizeSecrets(raw) {
  const out = {};
  if (!isRecord(raw)) return out;
  for (const mapId of Object.keys(raw)) {
    if (!isSecretId(mapId) || !isRecord(raw[mapId])) continue;
    for (const id of Object.keys(raw[mapId])) {
      if (!isSecretId(id)) continue;
      const entry = isRecord(raw[mapId][id]) ? raw[mapId][id] : {};
      if (!hasOwn(out, mapId)) out[mapId] = {};
      out[mapId][id] = secretEntry(entry.name, entry.at);
    }
  }
  return out;
}

export function secretEntry(name, at) {
  return {
    name: typeof name === 'string' ? name.slice(0, SECRET_NAME_MAX) : '',
    at: Number.isFinite(at) && at > 0 ? at : 0
  };
}

/** 어떤 값이 들어와도 온전한 프로필을 돌려준다. 깨진 항목만 기본값으로 바뀐다. */
export function normalizeProfile(raw, now = Date.now()) {
  const src = isRecord(raw) ? raw : {};
  const nickname = validateNickname(src.nickname);
  const owned = normalizeOwned(src.owned);
  return {
    nickname: nickname.ok ? nickname.name : '',
    points: Number.isFinite(src.points) ? clampPoints(src.points) : START_POINTS,
    owned,
    loadout: normalizeLoadout(src.loadout, owned),
    stats: normalizeStats(src.stats),
    secrets: normalizeSecrets(src.secrets),
    createdAt: Number.isFinite(src.createdAt) && src.createdAt > 0 ? src.createdAt : now
  };
}

export function defaultProfile(now = Date.now()) {
  return normalizeProfile({}, now);
}

function mergeSecrets(a, b) {
  const out = normalizeSecrets(a);
  for (const mapId of Object.keys(b)) {
    if (!hasOwn(out, mapId)) out[mapId] = {};
    for (const id of Object.keys(b[mapId])) {
      const mine = hasOwn(out[mapId], id) ? out[mapId][id] : null;
      const theirs = b[mapId][id];
      if (!mine || (theirs.at > 0 && (mine.at === 0 || theirs.at < mine.at))) out[mapId][id] = { ...theirs };
    }
  }
  return out;
}

/**
 * 서버 프로필을 로컬에 합친다. local, server 모두 normalizeProfile을 거친 값이다.
 *
 * 포인트와 전적은 클라이언트가 계산해 보내는 값이라 치트를 막지 못한다. 순위표는 재미용이고 신뢰 데이터가 아니다.
 *  - 닉네임 : 서버 값. 단 서버에 아직 등록하지 못한 이름이 있으면(keepNickname) 로컬 값
 *  - 무기   : 합집합
 *  - 비밀   : 합집합, 먼저 찾은 시각을 유지
 *  - 전적   : 항목별로 큰 값
 *  - 포인트 : 둘 중 큰 값. 단 서버에 올리지 못한 변경이 있으면(dirty) 로컬 값.
 *             큰 값을 그대로 쓰면 오프라인 구매가 다음 접속 때 환불되어 무기가 공짜가 된다
 *  - 장비   : dirty면 로컬, 아니면 서버 값. 가지지 않은 무기는 기본 장비로
 *  - 생성일 : 더 이른 값
 */
export function mergeProfiles(local, server, { dirty = false, keepNickname = false } = {}) {
  const owned = normalizeOwned([...local.owned, ...server.owned]);
  const stats = {};
  for (const key of STAT_KEYS) stats[key] = Math.max(local.stats[key], server.stats[key]);
  return {
    nickname: keepNickname ? local.nickname : server.nickname || local.nickname,
    points: dirty ? local.points : Math.max(local.points, server.points),
    owned,
    loadout: normalizeLoadout(dirty ? local.loadout : server.loadout, owned),
    stats,
    secrets: mergeSecrets(local.secrets, server.secrets),
    createdAt: Math.min(local.createdAt, server.createdAt)
  };
}

function stableJson(v) {
  if (Array.isArray(v)) return '[' + v.map(stableJson).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableJson(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

export function sameProfile(a, b) {
  return stableJson(a) === stableJson(b);
}

/** 서버의 fps_save_profile이 저장하는 항목만 비교한다 */
export function sameProgress(a, b) {
  const pick = ({ points, owned, loadout, stats, secrets }) => ({ points, owned, loadout, stats, secrets });
  return sameProfile(pick(a), pick(b));
}

/** 256비트 무작위 hex */
export function generateToken() {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function resolveStorage(injected) {
  if (injected !== undefined) return injected;
  try {
    return globalThis.localStorage || null; // 샌드박스나 쿠키 차단 환경에서는 접근만으로 예외가 난다
  } catch (_) {
    return null;
  }
}

/**
 * opts.storage: localStorage와 같은 getItem·setItem·removeItem 객체. null이면 저장하지 않는다.
 * 저장 형식: { v, profile, sync: { dirty, pendingClaim } }
 */
export function createStore({ storage } = {}) {
  const backing = resolveStorage(storage);
  let sessionToken = null; // 저장소를 못 쓸 때도 이번 세션 동안은 같은 토큰을 쓴다

  function read(key) {
    try {
      return backing ? backing.getItem(key) : null;
    } catch (_) {
      return null;
    }
  }

  function write(key, value) {
    try {
      if (backing) backing.setItem(key, value);
    } catch (_) { /* 용량 초과나 차단: 메모리의 값으로 계속 진행한다 */ }
  }

  function load() {
    const raw = read(PROFILE_KEY);
    if (!raw) return null;
    let data;
    try {
      data = JSON.parse(raw);
    } catch (_) {
      return null;
    }
    if (!isRecord(data) || data.v !== PROFILE_VERSION || !isRecord(data.profile)) return null;
    const sync = isRecord(data.sync) ? data.sync : {};
    const pending = validateNickname(sync.pendingClaim);
    return { profile: normalizeProfile(data.profile), dirty: sync.dirty === true, pendingClaim: pending.ok ? pending.name : null };
  }

  function save({ profile, dirty, pendingClaim }) {
    write(PROFILE_KEY, JSON.stringify({ v: PROFILE_VERSION, profile, sync: { dirty, pendingClaim } }));
  }

  /** 프로필만 지운다. 토큰은 서버 행과 닉네임의 소유 증명이라 남긴다. */
  function clear() {
    try {
      if (backing) backing.removeItem(PROFILE_KEY);
    } catch (_) { /* 저장소 차단 */ }
  }

  /** 매번 저장소를 먼저 읽어 다른 탭이 만든 토큰과 갈라지지 않게 한다 */
  function token() {
    const saved = read(TOKEN_KEY);
    if (TOKEN_RE.test(saved || '')) return saved;
    if (!sessionToken) sessionToken = generateToken();
    write(TOKEN_KEY, sessionToken);
    return sessionToken;
  }

  return { load, save, clear, token };
}
