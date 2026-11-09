/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 중계 서버의 규칙. 허브 이름, 크기·속도 한도, 들어온 메시지의 형식 검사, 방 프레임을 받는 사람별로 나누기, 보낼 글자 만들기.
 *          Worker·Durable Object(worker.js)와 node 시험이 같이 쓰므로 플랫폼 API를 쓰지 않는다.
 */
/*
 * 주고받는 글자는 Supabase Realtime(Phoenix 채널 vsn 1.0.0)과 같은 모양이다. 그래서 브라우저는 js/net/realtime.js의
 * RealtimeSocket·Channel을 그대로 쓰고, room.js·lobby.js는 어느 서버에 붙었는지 모른다.
 *   { topic: 'realtime:<채널>', event, payload, ref, join_ref }
 * 허브 = Durable Object 하나. 로비 허브 하나('skalafps:lobby')와 방마다 허브 하나('skalafps:room:<id>[:<비밀 값>]')가 있고,
 * 허브마다 채널은 하나뿐이다(채널 이름 = 허브 이름).
 */

export const LOBBY_HUB = 'skalafps:lobby';        // js/core/consts.js NET.LOBBY_CHANNEL과 같다(tests/relay.test.mjs가 확인)
export const ROOM_PREFIX = 'skalafps:room:';      // NET.ROOM_CHANNEL_PREFIX
export const TOPIC_PREFIX = 'realtime:';          // Phoenix 채널 이름 앞에 붙는 글자

/** 방 허브 이름: 방 id(room.js ROOM_ID_RE)와, 비밀번호 방이면 비밀 값(js/net/secret.js의 hex 24자) */
const ROOM_HUB_RE = /^skalafps:room:[A-Za-z0-9_-]{1,40}(?::[0-9a-f]{24})?$/;
/** presence 키 = 플레이어 id(js/net/index.js ID_RE). 객체 속성 이름으로 쓰이므로 프로토타입 이름은 받지 않는다 */
const KEY_RE = /^[A-Za-z0-9_-]{1,40}$/;
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * 하트비트는 정해진 글자 하나만 쓴다. Durable Object가 잠든 채로 런타임이 바로 답하게(setWebSocketAutoResponse)
 * 하려면 요청과 응답이 글자 그대로 같아야 하기 때문이다. 클라이언트(js/net/hubsocket.js)가 보내는 글자와 같은지 시험이 확인한다.
 */
export const HEARTBEAT_REF = 'hb';
export const HEARTBEAT_REQUEST = '{"topic":"phoenix","event":"heartbeat","payload":{},"ref":"hb"}';
export const HEARTBEAT_RESPONSE = '{"topic":"phoenix","event":"phx_reply","payload":{"status":"ok","response":{}},"ref":"hb"}';

export const LIMITS = Object.freeze({
  maxMessageChars: 100000,    // 메시지 하나. room.js는 80,000자가 넘는 프레임을 나눠 보낸다
  msgPerSec: 40,              // 연결 하나가 보내는 메시지(초당). 클라이언트는 프레임을 초당 20개까지 보낸다
  msgBurst: 80,
  charsPerSec: 262144,        // 연결 하나가 보내는 글자 수(초당)
  charsBurst: 524288,
  dropLimit: 200,             // dropWindowMs 안에 이만큼 버리거나 거절하면 연결을 끊는다
  dropWindowMs: 10000,
  presencePerWindow: 12,      // track·untrack(참가 하나당). 클라이언트는 10.5초에 10번으로 스스로 줄인다
  presenceWindowMs: 10000,
  maxMetaKeys: 16,            // presence 한 줄의 칸 수
  maxMetaChars: 1024,         // presence 한 줄의 JSON 길이. 연결 상태(serializeAttachment 16 KiB)에 함께 들어간다
  maxFieldChars: 128,         // 글자 칸 하나(넘으면 자른다. 클라이언트 plainFields와 같다)
  maxFieldNameChars: 32,
  maxFrameTuples: 400,        // 프레임 하나의 메시지 수(room.js queueMax 300)
  maxEventChars: 64,          // room.js EVENT_RE
  idleMs: 75000,              // 하트비트(25초)가 세 번 오지 않으면 죽은 연결로 보고 닫는다
  warnGapMs: 2000,            // 같은 연결에 경고(system)를 다시 보내기까지
  lobby: Object.freeze({ maxConns: 2000, maxMembers: 2000 }),
  room: Object.freeze({ maxConns: 40, maxMembers: 32 })   // 방 인원 상한은 16. 재접속 중 겹치는 연결을 위한 여유
});

/** 브라우저 Origin 허용 목록의 기본값. wrangler.toml의 ALLOWED_ORIGINS가 있으면 그것을 쓴다 */
export const DEFAULT_ORIGINS = 'https://jungmk0720.github.io,http://localhost:*,http://127.0.0.1:*';

/* ---------------- 허브 이름 ---------------- */

/** 허브 이름 → { kind: 'lobby'|'room', name, topic } 또는 null */
export function parseHub(name) {
  if (name === LOBBY_HUB) return { kind: 'lobby', name, topic: TOPIC_PREFIX + name };
  if (typeof name === 'string' && ROOM_HUB_RE.test(name)) return { kind: 'room', name, topic: TOPIC_PREFIX + name };
  return null;
}

/** 기록에 남길 허브 이름. 비밀번호 방의 비밀 값은 지운다 */
export function maskHub(name) {
  return String(name).replace(/:[0-9a-f]{24}$/, ':***');
}

export function isKey(v) {
  return typeof v === 'string' && KEY_RE.test(v) && !RESERVED_KEYS.has(v);
}

/**
 * Origin 검사. 목록은 쉼표로 나누고, 'http://localhost:*'처럼 끝이 ':*'이면 모든 포트를 허용한다.
 * Origin이 없는 요청(브라우저가 아닌 node 시험·도구)은 통과시킨다. 브라우저는 WebSocket을 열 때 항상 Origin을 보낸다.
 */
export function originAllowed(origin, list = DEFAULT_ORIGINS) {
  if (!origin) return true;
  for (const raw of String(list || DEFAULT_ORIGINS).split(',')) {
    const entry = raw.trim();
    if (!entry) continue;
    if (entry === '*' || entry === origin) return true;
    if (entry.endsWith(':*')) {
      const base = entry.slice(0, -1);
      if (origin.startsWith(base) && /^\d{1,5}$/.test(origin.slice(base.length))) return true;
    }
  }
  return false;
}

/* ---------------- 들어온 메시지 ---------------- */

const isRef = (v) => v == null || ((typeof v === 'string' || typeof v === 'number') && String(v).length <= 24);
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** 글자 하나 → { msg: { topic, event, payload, ref, joinRef } } 또는 { error } */
export function parseEnvelope(text, limits = LIMITS) {
  if (typeof text !== 'string') return { error: 'not_text' };
  if (text.length > limits.maxMessageChars) return { error: 'too_large' };
  let raw;
  try { raw = JSON.parse(text); } catch (_) { return { error: 'bad_json' }; }
  if (!isPlainObject(raw)) return { error: 'bad_message' };
  const { topic, event, payload, ref, join_ref: joinRef } = raw;
  if (typeof topic !== 'string' || topic.length > 200 || typeof event !== 'string' || !event || event.length > 32) return { error: 'bad_message' };
  if (!isRef(ref) || !isRef(joinRef)) return { error: 'bad_ref' };
  if (payload != null && !isPlainObject(payload)) return { error: 'bad_payload' };
  return { msg: { topic, event, payload: payload || {}, ref: ref == null ? null : String(ref), joinRef: joinRef == null ? null : String(joinRef) } };
}

/** phx_join의 config → { key, presence, self } 또는 { error }. 방 프레임은 키에 묶이므로 키가 꼭 있어야 한다 */
export function joinConfig(payload) {
  const cfg = isPlainObject(payload) && isPlainObject(payload.config) ? payload.config : {};
  const pres = isPlainObject(cfg.presence) ? cfg.presence : {};
  const bc = isPlainObject(cfg.broadcast) ? cfg.broadcast : {};
  if (!isKey(pres.key)) return { error: 'bad_key' };
  return { key: pres.key, presence: pres.enabled === true, self: bc.self === true };
}

/**
 * presence 한 줄을 정리한다 → { meta, json } 또는 { error }.
 * 숫자·글자·참거짓·null만 남기고(객체 칸은 받는 쪽 plainFields가 어차피 버린다) 긴 글자는 자른다. phx_로 시작하는 이름은 서버 몫이다.
 * 방에서는 id 칸이 있으면 presence 키와 같아야 한다(room.js는 id로 사람을 구별한다).
 */
export function cleanMeta(raw, { key, kind }, limits = LIMITS) {
  if (!isPlainObject(raw)) return { error: 'bad_meta' };
  const meta = {};
  let n = 0;
  for (const name of Object.keys(raw)) {
    if (RESERVED_KEYS.has(name) || name.length > limits.maxFieldNameChars || name.startsWith('phx_') || name === 'presence_ref') continue;
    const v = raw[name];
    if (typeof v === 'string') meta[name] = v.length > limits.maxFieldChars ? v.slice(0, limits.maxFieldChars) : v;
    else if (v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) meta[name] = v;
    else continue;
    if (++n > limits.maxMetaKeys) return { error: 'too_many_fields' };
  }
  if (kind === 'room' && Object.prototype.hasOwnProperty.call(meta, 'id') && meta.id !== key) return { error: 'id_mismatch' };
  const json = JSON.stringify(meta);
  if (json.length > limits.maxMetaChars) return { error: 'meta_too_large' };
  return { meta, json };
}

/**
 * 방 채널 broadcast 'f'(room.js 프레임 { f, t, m: [[event, payload, to?], ...] })를 검사한다.
 *  - f는 보낸 연결의 presence 키여야 한다. 남의 이름으로 보낸 프레임은 버린다.
 *  - r(방장이 모아 다시 보내는 relay 묶음)은 받지 않는다. 서버가 직접 나눠 주므로 relay가 필요 없고, r의 보낸이는 확인할 수 없다.
 *  - 대상이 있는 메시지(to)는 대상 키 목록 targets로 따로 모은다.
 * → { frame: { f, t, m }, targets: Set|null } 또는 { error }
 */
export function checkFrame(p, senderKey, limits = LIMITS) {
  if (!isPlainObject(p)) return { error: 'bad_frame' };
  if (p.f !== senderKey) return { error: 'sender_mismatch' };
  if (p.r !== undefined) return { error: 'relay_not_allowed' };
  if (typeof p.t !== 'number' || !Number.isFinite(p.t)) return { error: 'bad_frame' };
  if (!Array.isArray(p.m) || p.m.length > limits.maxFrameTuples) return { error: 'bad_frame' };
  let targets = null;
  for (const x of p.m) {
    if (!Array.isArray(x) || x.length < 2 || x.length > 3) return { error: 'bad_message' };
    if (typeof x[0] !== 'string' || !x[0] || x[0].length > limits.maxEventChars) return { error: 'bad_message' };
    if (x.length === 3) {
      if (!isKey(x[2])) return { error: 'bad_target' };
      (targets || (targets = new Set())).add(x[2]);
    }
  }
  return { frame: { f: p.f, t: p.t, m: p.m }, targets };
}

/**
 * key에게 보낼 프레임. 대상이 정해진 메시지는 그 대상에게만 간다(key가 null이면 대상 없는 메시지만).
 * 남는 메시지가 없어도 빈 m으로 보낸다. room.js는 프레임이 오는 것으로 상대가 살아 있음을 알기 때문이다(Supabase에서는 모두가 모든 프레임을 받았다).
 */
export function frameFor(frame, targets, key) {
  if (!targets) return frame;
  return { f: frame.f, t: frame.t, m: frame.m.filter((x) => x.length < 3 || x[2] === key) };
}

/* ---------------- 보낼 글자 ---------------- */

export const replyText = (topic, ref, status, response = {}) =>
  JSON.stringify({ topic, event: 'phx_reply', payload: { status, response }, ref });

export const broadcastText = (topic, event, payload) =>
  '{"topic":' + JSON.stringify(topic) + ',"event":"broadcast","payload":{"type":"broadcast","event":' + JSON.stringify(event) +
  ',"payload":' + JSON.stringify(payload) + '},"ref":null}';

export const presenceStateText = (topic, state) => JSON.stringify({ topic, event: 'presence_state', payload: state, ref: null });

export const presenceDiffText = (topic, joins, leaves) => JSON.stringify({ topic, event: 'presence_diff', payload: { joins, leaves }, ref: null });

/** Supabase가 채널 오류를 알릴 때와 같은 모양. 클라이언트 Channel은 기록만 남긴다 */
export const systemText = (topic, message) =>
  JSON.stringify({ topic, event: 'system', payload: { status: 'error', message, extension: 'system' }, ref: null });

/* ---------------- 속도 제한 ---------------- */

/** 토큰 버킷: 초당 rate만큼 차고 burst까지 모인다. 시각(ms)을 받아서 시험에서 시간을 움직일 수 있다 */
export class Bucket {
  constructor(rate, burst, t = 0) {
    this.rate = rate;
    this.burst = burst;
    this.tokens = burst;
    this.last = t;
  }
  take(n, t) {
    if (t > this.last) {
      this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) / 1000) * this.rate);
      this.last = t;
    }
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }
}

/** 짧은 무작위 글자(presence ref, 연결 id). 겹쳐도 판정에 문제는 없고 diff 구별에만 쓴다 */
export function randomTag(len = 8) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const buf = new Uint8Array(len);
  if (globalThis.crypto && globalThis.crypto.getRandomValues) globalThis.crypto.getRandomValues(buf);
  else for (let i = 0; i < len; i++) buf[i] = Math.floor(Math.random() * 256);
  let s = '';
  for (let i = 0; i < len; i++) s += chars[buf[i] % 36];
  return s;
}
