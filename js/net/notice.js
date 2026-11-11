/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 전체 공지. 운영자가 서명한 한 줄을 중계 서버 로비 허브의 presence에 올리면, 게임 화면을 연 모든 사람이 서명을 확인한 뒤 화면 맨 위에 띄운다.
 *          서명·검증(ECDSA P-256), 공지 줄 형식, 받는 쪽(게임 화면)과 보내는 쪽(운영자 패널 dev/notice.html)의 연결을 여기에 둔다.
 */
/*
 * 왜 서명인가
 *   로비 허브의 presence는 누구나 올릴 수 있다(server/relay/README.md). 그래서 "누가 올렸는가"를 서버가 아니라 받는 화면이 확인한다.
 *   공개 열쇠는 js/config.js의 notice.key에 있고(모두에게 공개), 비밀 열쇠는 운영자만 가진다(tools/make-notice-key.mjs).
 *   비밀 열쇠 없이는 맞는 서명을 만들 수 없으므로 남이 올린 줄은 조용히 버려진다. 서버를 고치거나 다시 배포할 필요가 없다.
 *
 * 공지 한 줄(presence 한 줄. 숫자·글자만 쓴다. 중계 서버가 글자 칸을 128자에서 자르므로 본문은 100자씩 나눠 싣는다)
 *   { nv: 1, id, at, ttl, k, t0, t1?, t2?, sig }
 *     id  공지 이름(영문 소문자·숫자 10자)        at  만든 시각(ms, 운영자 PC 시계)
 *     ttl 화면에 떠 있는 시간(초, 5~3600)          k   'n' 공지 | 'x' 그 id의 공지 내리기
 *     t0~t2 본문(합쳐서 200자까지)                  sig 서명(base64url 86자)
 *   서명 대상 = JSON.stringify(['skala-notice', 1, id, at, ttl, k, 본문])의 UTF-8 바이트.
 *   서명 글자는 64바이트를 base64url로 쓴 한 가지 모양만 받는다(마지막 글자의 남는 4비트가 0. 같은 서명의 다른 표기는 버린다).
 *
 * 다시 올리기(남이 옛 공지를 그대로 베껴 올리는 것) 대책
 *   받는 쪽은 at + ttl이 지난 줄을 버린다(시계 차이 5분까지 봐준다). 그래서 베낀 줄은 원래 떠 있을 시간 안에서만 통하고 내용도 바꿀 수 없다.
 *   내린 공지는 이 화면이 내리기 줄을 본 뒤로는 다시 뜨지 않는다.
 *
 * 받는 쪽: createNoticeFeed({ url, publicKey, onShow, onHide }).start()
 *   로비 허브에 따로 연결 하나를 열고(게임의 로비·방 연결과 별개) presence를 읽기만 한다. 자기 자리 표시 { nf: 1 } 한 줄을 올려
 *   운영자 패널이 "지금 접속 몇 명"을 셀 수 있게 한다. 메뉴·연습장·경기 어디에 있든 받는다.
 * 보내는 쪽: createNoticeSender({ url, privateKey }) → send({ text, ttl }) / retract()
 *   패널을 닫으면 줄이 사라진다. 이미 받은 화면은 ttl 동안 계속 띄우고, 그 뒤에 접속한 화면에는 가지 않는다.
 */
import { NET } from '../core/consts.js';
import { Emitter, RealtimeSocket, randomId } from './realtime.js';
import { hubEndpoint, HUB_HEARTBEAT_REF, HUB_PRESENCE_LIMIT } from './hubsocket.js';

export const NOTICE = Object.freeze({
  VERSION: 1,
  MAX_TEXT: 200,        // 본문 글자 수(UTF-16 단위)
  CHUNK: 100,           // presence 한 칸에 싣는 글자 수
  MIN_TTL: 5,           // 화면에 떠 있는 시간(초)
  MAX_TTL: 3600,
  DEFAULT_TTL: 30,
  RETRACT_TTL: 120,     // 내리기 줄을 올려 두는 시간(초)
  SKEW_MS: 300000,      // 운영자 PC와 받는 PC의 시계 차이를 이만큼(5분) 봐준다
  MIN_SHOW_MS: 4000     // 늦게 받았어도 이만큼은 띄운다
});

/** 운영자 패널이 접속한 화면을 셀 때 보는 자리 표시 */
export const NOTICE_VIEWER_FIELD = 'nf';

const ALGO = Object.freeze({ name: 'ECDSA', namedCurve: 'P-256' });
const SIGN = Object.freeze({ name: 'ECDSA', hash: 'SHA-256' });
const SIG_RE = /^[A-Za-z0-9_-]{86}$/;
const SIG_BYTES = 64;   // P-256 서명(r, s 32바이트씩)
const ID_RE = /^[a-z0-9]{6,16}$/;
const TEXT_KEYS = ['t0', 't1', 't2'];
const JUDGED_MAX = 300;

const subtle = () => (globalThis.crypto && globalThis.crypto.subtle) || null;

/** 이 환경에서 서명·검증을 할 수 있는가(https 또는 localhost 페이지, Node 20 이상) */
export function noticeCryptoAvailable() {
  return !!subtle();
}

/* ---------------- base64url ---------------- */

export function toBase64Url(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** → Uint8Array. 글자가 base64url이 아니면 null */
export function fromBase64Url(text) {
  const s = String(text == null ? '' : text).trim();
  if (!s || !/^[A-Za-z0-9_-]+$/.test(s)) return null;
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch (_) {
    return null;
  }
}

/* ---------------- 본문 ---------------- */

const isHigh = (c) => c >= 0xd800 && c <= 0xdbff;

/** 글자를 n 단위까지 자른다. 한 글자(이모지 등 두 단위짜리)의 가운데에서는 자르지 않는다 */
function cutUnits(s, n) {
  if (s.length <= n) return s;
  return s.slice(0, isHigh(s.charCodeAt(n - 1)) ? n - 1 : n);
}

/** 공지 본문 정리: 한 줄로, 제어 문자 없이, 앞뒤 공백 없이, MAX_TEXT까지 */
export function cleanNoticeText(v) {
  const s = String(v == null ? '' : v).normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  return cutUnits(s, NOTICE.MAX_TEXT).trim();
}

/** 본문을 presence 칸에 실을 토막으로 나눈다(토막마다 CHUNK 단위까지, 최대 3토막) */
export function splitNoticeText(text) {
  const out = [];
  let rest = String(text);
  while (rest && out.length < TEXT_KEYS.length) {
    const head = cutUnits(rest, NOTICE.CHUNK);
    out.push(head);
    rest = rest.slice(head.length);
  }
  return rest ? null : out;
}

const clampTtl = (v, lo = NOTICE.MIN_TTL) => Math.min(NOTICE.MAX_TTL, Math.max(lo, Math.round(Number(v) || NOTICE.DEFAULT_TTL)));

/** 서명 대상 바이트 */
function noticeBytes(n) {
  return new TextEncoder().encode(JSON.stringify(['skala-notice', NOTICE.VERSION, n.id, n.at, n.ttl, n.kind, n.text]));
}

/* ---------------- 열쇠 ---------------- */

/**
 * 새 열쇠 한 쌍. → { publicKey, privateKey }(둘 다 base64url 글자: 공개 열쇠는 raw 65바이트, 비밀 열쇠는 PKCS#8)
 * 공개 열쇠는 js/config.js에 넣고, 비밀 열쇠는 운영자만 보관한다(tools/make-notice-key.mjs).
 */
export async function generateNoticeKeys() {
  const s = subtle();
  if (!s) throw new Error('이 환경에서는 서명을 쓸 수 없습니다(WebCrypto 없음)');
  const pair = await s.generateKey(ALGO, true, ['sign', 'verify']);
  const [pub, priv] = await Promise.all([s.exportKey('raw', pair.publicKey), s.exportKey('pkcs8', pair.privateKey)]);
  return { publicKey: toBase64Url(pub), privateKey: toBase64Url(priv) };
}

/** 공개 열쇠 글자 → 검증용 CryptoKey. 글자가 틀리면 예외 */
export async function importNoticePublicKey(text) {
  const s = subtle();
  const raw = fromBase64Url(text);
  if (!s) throw new Error('이 환경에서는 서명을 확인할 수 없습니다(WebCrypto 없음)');
  if (!raw || raw.length !== 65 || raw[0] !== 4) throw new Error('공지 공개 열쇠의 모양이 틀립니다');
  return s.importKey('raw', raw, ALGO, true, ['verify']);
}

/** 비밀 열쇠 글자 → 서명용 CryptoKey. 기본은 꺼낼 수 없는 열쇠다(저장해 두어도 글자로 되돌릴 수 없다). 글자가 틀리면 예외 */
export async function importNoticePrivateKey(text, { extractable = false } = {}) {
  const s = subtle();
  const der = fromBase64Url(String(text == null ? '' : text).replace(/\s+/g, ''));
  if (!s) throw new Error('이 환경에서는 서명을 쓸 수 없습니다(WebCrypto 없음)');
  if (!der || der.length < 100) throw new Error('운영자 열쇠의 모양이 틀립니다');
  try {
    return await s.importKey('pkcs8', der, ALGO, extractable, ['sign']);
  } catch (_) {
    throw new Error('운영자 열쇠를 읽을 수 없습니다');
  }
}

/** 이 비밀 열쇠가 이 공개 열쇠의 짝인가(아무 글자나 서명해 보고 확인한다) */
export async function noticeKeysMatch(privateKey, publicKey) {
  const s = subtle();
  if (!s || !privateKey || !publicKey) return false;
  try {
    const probe = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const sig = await s.sign(SIGN, privateKey, probe);
    return await s.verify(SIGN, publicKey, sig, probe);
  } catch (_) {
    return false;
  }
}

/* ---------------- 공지 줄 ---------------- */

/**
 * 공지 줄을 만들어 서명한다. → presence에 올릴 한 줄
 * @param {CryptoKey} privateKey
 * @param {{ text?:string, ttl?:number, kind?:'n'|'x', id?:string, at?:number }} o
 *   kind 'n': text가 꼭 있어야 한다. kind 'x': id(내릴 공지)가 꼭 있어야 하고 본문은 비운다
 */
export async function signNotice(privateKey, o = {}) {
  const s = subtle();
  if (!s) throw new Error('이 환경에서는 서명을 쓸 수 없습니다(WebCrypto 없음)');
  const kind = o.kind === 'x' ? 'x' : 'n';
  const text = kind === 'x' ? '' : cleanNoticeText(o.text);
  if (kind === 'n' && !text) throw new Error('공지 내용이 비어 있습니다');
  const id = o.id != null ? String(o.id) : randomId(10);
  if (!ID_RE.test(id)) throw new Error('공지 이름이 틀립니다');
  const at = Number.isFinite(o.at) ? Math.round(o.at) : Date.now();
  const ttl = clampTtl(o.ttl, kind === 'x' ? 1 : NOTICE.MIN_TTL);
  const parts = splitNoticeText(text);
  if (!parts) throw new Error('공지 내용이 너무 깁니다');
  const sig = toBase64Url(await s.sign(SIGN, privateKey, noticeBytes({ id, at, ttl, kind, text })));
  const line = { nv: NOTICE.VERSION, id, at, ttl, k: kind, sig };
  parts.forEach((p, i) => { line[TEXT_KEYS[i]] = p; });
  return line;
}

/**
 * presence 한 줄(믿을 수 없는 값) → { id, at, ttl, kind, text, sig } 또는 null. 모양만 본다(서명은 verifyNotice).
 * 본문은 정리한 모양 그대로여야 한다(줄바꿈·제어 문자·앞뒤 공백이 있으면 버린다)
 */
export function readNoticeLine(line) {
  if (!line || typeof line !== 'object' || line.nv !== NOTICE.VERSION) return null;
  const { id, at, ttl, k, sig } = line;
  if (typeof id !== 'string' || !ID_RE.test(id)) return null;
  if (typeof at !== 'number' || !Number.isSafeInteger(at) || at <= 0) return null;
  if (k !== 'n' && k !== 'x') return null;
  if (typeof ttl !== 'number' || !Number.isInteger(ttl) || ttl < (k === 'x' ? 1 : NOTICE.MIN_TTL) || ttl > NOTICE.MAX_TTL) return null;
  if (typeof sig !== 'string' || !SIG_RE.test(sig)) return null;
  // 서명 글자는 한 가지 모양만 받는다: 64바이트를 base64url로 쓴 그대로(마지막 글자의 남는 비트가 0)여야 한다
  const sigBytes = fromBase64Url(sig);
  if (!sigBytes || sigBytes.length !== SIG_BYTES || toBase64Url(sigBytes) !== sig) return null;
  let text = '';
  for (const key of TEXT_KEYS) {
    const part = line[key];
    if (part === undefined) continue;
    if (typeof part !== 'string' || part.length > NOTICE.CHUNK) return null;
    text += part;
  }
  if (text !== cleanNoticeText(text)) return null;
  if (k === 'n' ? !text : !!text) return null;
  return { id, at, ttl, kind: k, text, sig };
}

/**
 * 공지 줄을 확인한다: 모양, 유효 시간, 서명.
 * @returns {Promise<{ ok:true, notice:{ id, at, ttl, kind, text, until } } | { ok:false, reason:'format'|'future'|'expired'|'signature' }>}
 *   until = 이 공지가 끝나는 시각(ms)
 */
export async function verifyNotice(publicKey, line, now = Date.now()) {
  const n = readNoticeLine(line);
  if (!n) return { ok: false, reason: 'format' };
  const until = n.at + n.ttl * 1000;
  if (n.at > now + NOTICE.SKEW_MS) return { ok: false, reason: 'future' };
  if (now >= until + NOTICE.SKEW_MS) return { ok: false, reason: 'expired' };
  const s = subtle();
  const sig = fromBase64Url(n.sig);
  let good = false;
  try { good = !!s && !!sig && await s.verify(SIGN, publicKey, sig, noticeBytes(n)); } catch (_) { good = false; }
  if (!good) return { ok: false, reason: 'signature' };
  return { ok: true, notice: { id: n.id, at: n.at, ttl: n.ttl, kind: n.kind, text: n.text, until } };
}

/** 붙여 넣은 글자나 열쇠 파일 내용에서 비밀 열쇠 글자를 찾는다(설명 줄이 섞여 있어도 된다. 가장 긴 base64url 토막). 없으면 '' */
export function findNoticePrivateKey(text) {
  const tokens = String(text == null ? '' : text).match(/[A-Za-z0-9_-]{150,}/g) || [];
  return tokens.sort((a, b) => b.length - a.length)[0] || '';
}

/** 지금부터 이 공지를 띄울 시간(ms). 늦게 받았으면 남은 시간만큼, 그래도 MIN_SHOW_MS는 띄운다 */
export function noticeShowMs(notice, now = Date.now()) {
  const full = notice.ttl * 1000;
  return Math.round(Math.min(full, Math.max(NOTICE.MIN_SHOW_MS, notice.until - now)));
}

/* ---------------- 연결(로비 허브) ---------------- */

/** 로비 허브에 붙는 소켓 하나. hubsocket.js의 링크와 같은 설정이다(하트비트 글자 고정, presence 한도) */
function lobbySocket(url, opts = {}) {
  return new RealtimeSocket({
    endpoint: hubEndpoint(url, NET.LOBBY_CHANNEL),
    heartbeatRef: HUB_HEARTBEAT_REF,
    presenceLimit: { ...HUB_PRESENCE_LIMIT },
    ...opts
  });
}

/** presence 상태에서 공지 줄(nv가 있는 줄)만 모은다 */
function noticeLines(presence) {
  const out = [];
  for (const { metas } of presence.list()) for (const m of metas) if (m && m.nv === NOTICE.VERSION) out.push(m);
  return out;
}

/**
 * 같은 줄을 두 번 확인하지 않으려고 쓰는 이름. 서명만이 아니라 줄 전체로 만든다
 * (서명을 베끼고 본문만 고친 줄을 먼저 본 탓에 진짜 줄을 건너뛰면 안 된다)
 */
function lineKey(m) {
  return JSON.stringify([m.sig, m.id, m.at, m.ttl, m.k, m.t0, m.t1, m.t2]);
}

/** presence 상태에서 게임 화면(자리 표시 nf를 올린 연결)의 수 */
export function countNoticeViewers(presence) {
  let n = 0;
  for (const { metas } of presence.list()) if (metas.some((m) => m && m[NOTICE_VIEWER_FIELD] === 1)) n++;
  return n;
}

/**
 * 받는 쪽(게임 화면). 로비 허브의 presence에서 서명이 맞는 공지를 골라 알려 준다.
 * @param {{ url:string, publicKey:string|CryptoKey, onShow:(n:{id,text,ms,at})=>void, onHide?:(id:string)=>void,
 *           now?:()=>number, socket?:object, log?:(...a)=>void }} o
 *   url = 중계 서버 주소, publicKey = js/config.js의 notice.key, socket = RealtimeSocket 옵션(시험용 WebSocket 등)
 * @returns {{ start():void, dispose():void, state():{ started, connected, shown, current } }}
 */
export function createNoticeFeed(o = {}) {
  const now = typeof o.now === 'function' ? o.now : () => Date.now();
  const log = typeof o.log === 'function' ? o.log : () => {};
  const judged = new Map();      // 줄 이름(lineKey) → true(이미 확인한 줄)
  const shown = new Set();       // 이 화면이 띄운 공지 id
  const retracted = new Set();   // 내린 공지 id
  let current = null;            // 지금 떠 있는 공지 { id, at, until }
  let sock = null, ch = null, keyP = null, disposed = false, started = false;

  function accept(n) {
    if (disposed) return;
    if (n.kind === 'x') {
      retracted.add(n.id);
      if (current && current.id === n.id) {
        current = null;
        if (typeof o.onHide === 'function') o.onHide(n.id);
      }
      return;
    }
    const t = now();
    if (current && t >= current.until) current = null;
    if (retracted.has(n.id) || shown.has(n.id)) return;
    if (current && current.at > n.at) return;      // 더 새 공지가 떠 있다
    shown.add(n.id);
    // 방금 올라온 줄은 정한 시간을 다 띄운다(이 PC의 시계가 틀려도 짧아지지 않게). 접속했을 때 이미 올라와 있던 줄은 시계로 남은 시간을 잰다
    const ms = n.fresh ? n.ttl * 1000 : noticeShowMs(n, t);
    current = { id: n.id, at: n.at, until: Math.max(n.until, t + ms) };
    if (typeof o.onShow === 'function') o.onShow({ id: n.id, text: n.text, ms, at: n.at });
  }

  /** fresh = 접속한 뒤에 새로 올라온 줄의 이름(lineKey) 모음 */
  async function scan(fresh) {
    if (disposed || !ch) return;
    const lines = noticeLines(ch.presence).filter((m) => !judged.has(lineKey(m)));
    if (!lines.length) return;
    for (const m of lines) {
      judged.set(lineKey(m), true);
      if (judged.size > JUDGED_MAX) judged.delete(judged.keys().next().value);
    }
    let key;
    try { key = await keyP; } catch (e) { log('notice key', e && e.message); return; }
    // 내리기 줄을 먼저 본다(같이 올라와 있는 옛 공지가 잠깐 뜨지 않게)
    const checked = [];
    for (const m of lines) {
      const r = await verifyNotice(key, m, now());
      if (r.ok) checked.push({ ...r.notice, fresh: fresh.has(lineKey(m)) }); else log('notice dropped', r.reason);
    }
    checked.sort((a, b) => (a.kind === b.kind ? a.at - b.at : a.kind === 'x' ? -1 : 1));
    for (const n of checked) accept(n);
  }

  return {
    start() {
      if (started || disposed) return;
      started = true;
      if (!noticeCryptoAvailable()) { log('notice feed off: no WebCrypto'); return; }
      keyP = typeof o.publicKey === 'string' ? importNoticePublicKey(o.publicKey) : Promise.resolve(o.publicKey);
      keyP.catch(() => {});
      try {
        sock = lobbySocket(o.url, o.socket);
        ch = sock.channel(NET.LOBBY_CHANNEL, { presence: true, presenceKey: 'nf' + randomId(12) });
        ch.on('presence', (_state, info) => {
          // 처음 받는 목록(sync)이 아니라 그 뒤의 변화로 들어온 줄은 방금 올라온 것이다
          const fresh = new Set();
          if (info && info.sync === false) {
            for (const metas of Object.values(info.joins || {})) for (const m of metas) if (m && m.nv === NOTICE.VERSION) fresh.add(lineKey(m));
          }
          scan(fresh).catch((e) => log('notice scan', e && e.message));
        });
        sock.start();
        ch.join({ timeoutMs: 30000 }).catch(() => {});   // 못 붙어도 소켓이 백오프로 계속 다시 시도한다
        ch.track({ [NOTICE_VIEWER_FIELD]: 1 });
      } catch (e) {
        log('notice feed off', e && e.message);
        sock = null; ch = null;
      }
    },
    dispose() {
      disposed = true;
      const s = sock;
      sock = null; ch = null;
      if (s) { try { s.close(); } catch (_) { /* 이미 닫힘 */ } }
    },
    state: () => ({ started, connected: !!(ch && ch.state === 'joined'), shown: shown.size, current: current ? { ...current } : null })
  };
}

/**
 * 보내는 쪽(운영자 패널). 로비 허브에 연결 하나를 열고 서명한 공지 줄을 presence에 올린다.
 * 이벤트: 'state'({ connected }), 'viewers'(n: 게임 화면을 연 사람 수), 'notice'(지금 올려 둔 공지 또는 null)
 * @param {{ url:string, privateKey:CryptoKey|(()=>CryptoKey|null), now?:()=>number, socket?:object }} o
 *   privateKey는 열쇠나, 열쇠를 돌려주는 함수다(연결을 먼저 열고 열쇠는 나중에 넣을 때). 열쇠가 없으면 send·retract가 예외를 던진다
 */
export function createNoticeSender(o = {}) {
  const now = typeof o.now === 'function' ? o.now : () => Date.now();
  const keyOf = () => {
    const key = typeof o.privateKey === 'function' ? o.privateKey() : o.privateKey;
    if (!key) throw new Error('운영자 열쇠가 없습니다');
    return key;
  };
  const em = new Emitter();
  const sock = lobbySocket(o.url, o.socket);
  const ch = sock.channel(NET.LOBBY_CHANNEL, { presence: true, presenceKey: 'notice-' + randomId(10) });
  let current = null;          // { id, text, ttl, at, until }
  let clearTimer = null, closed = false;
  const connected = () => ch.state === 'joined';

  ch.on('presence', () => em.emit('viewers', countNoticeViewers(ch.presence)));
  ch.on('joined', () => em.emit('state', { connected: true }));
  ch.on('interrupted', () => em.emit('state', { connected: false }));
  sock.on('state', () => em.emit('state', { connected: connected() }));

  function setCurrent(n) {
    current = n;
    em.emit('notice', n ? { ...n } : null);
  }
  function untrackLater(ms) {
    clearTimeout(clearTimer);
    clearTimer = setTimeout(() => { clearTimer = null; if (!closed) { ch.untrack(); setCurrent(null); } }, ms);
  }

  return {
    on: (ev, fn) => em.on(ev, fn),
    get connected() { return connected(); },
    get viewers() { return countNoticeViewers(ch.presence); },
    get current() { return current ? { ...current } : null; },
    /** 연결을 연다. 처음 붙을 때까지 기다린다(시간 안에 못 붙으면 예외. 그 뒤에도 계속 다시 시도한다) */
    open(timeoutMs = 15000) {
      sock.start();
      return ch.join({ timeoutMs });
    },
    /**
     * 공지를 올린다. 앞서 올린 공지가 있으면 바뀐다.
     * @returns {Promise<{ ok:boolean, status:string, notice?:object }>} status: 'ok' | 'error' | 'timeout' | 'disconnected'
     */
    async send({ text, ttl } = {}) {
      const line = await signNotice(keyOf(), { text, ttl, at: now() });
      const status = await ch.track(line);
      if (status !== 'ok') return { ok: false, status };
      const n = readNoticeLine(line);
      setCurrent({ id: n.id, text: n.text, ttl: n.ttl, at: n.at, until: n.at + n.ttl * 1000 });
      untrackLater(n.ttl * 1000 + 1500);
      return { ok: true, status, notice: { ...current } };
    },
    /** 올려 둔 공지를 내린다(받은 화면에서도 사라진다). 올려 둔 것이 없으면 아무 일도 하지 않는다 */
    async retract() {
      if (!current) return { ok: false, status: 'none' };
      const id = current.id;
      const line = await signNotice(keyOf(), { kind: 'x', id, ttl: NOTICE.RETRACT_TTL, at: now() });
      const status = await ch.track(line);
      if (status !== 'ok') return { ok: false, status };
      setCurrent(null);
      untrackLater(15000);       // 내리기 줄은 잠깐만 올려 둔다(그 사이 접속한 화면까지 받는다)
      return { ok: true, status, id };
    },
    close() {
      if (closed) return;
      closed = true;
      clearTimeout(clearTimer);
      clearTimer = null;
      try { sock.close(); } catch (_) { /* 이미 닫힘 */ }
      em.removeAll();
    }
  };
}
