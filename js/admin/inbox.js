/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 건의 받은편지함(dev/inbox.html)의 순수 로직. Supabase Auth(이메일·비밀번호, 선택 TOTP)와 PostgREST를 supabase-js 없이 fetch로 부른다.
 *          요청 만들기, 응답 정리, 오류 → 화면 문구, 세션 보관(메모리·sessionStorage)을 한곳에 두고, DOM에 닿지 않는다.
 *          그리는 일은 inbox-view.js, 화면 연결은 inbox-panel.js가 맡는다. 설계와 이유는 docs/FEEDBACK.md 6절, 처음 켜는 절차는 docs/FEEDBACK_INBOX_SOP.md.
 */
import {
  FEEDBACK_KINDS, FEEDBACK_KIND_NAMES, FEEDBACK_MAX, FEEDBACK_REPLY_MAX, FEEDBACK_STATUS_NAMES, cleanFeedback, feedbackLength
} from '../account/feedback.js';
import { authHeaders } from '../account/remote.js';

export { FEEDBACK_KINDS, FEEDBACK_KIND_NAMES, FEEDBACK_STATUS_NAMES };

export const INBOX = Object.freeze({
  TABLE: 'fps_feedback',
  /** supabase/schema.sql의 `grant select (...)` 열과 같다(tests/inbox.test.mjs가 대조한다) */
  COLUMNS: Object.freeze(['id', 'player_id', 'name', 'kind', 'body', 'info', 'status', 'reply', 'replied_at', 'created_at']),
  /** 한 번에 불러오는 글 수 */
  PAGE_SIZE: 100,
  REPLY_MAX: FEEDBACK_REPLY_MAX,
  /** 화면의 상태 단추. 서버의 status 값(new는 처음 상태라 단추가 없다) */
  STATUS_ACTIONS: Object.freeze(['read', 'done', 'hold']),
  STATUSES: Object.freeze(Object.keys(FEEDBACK_STATUS_NAMES)),
  STORAGE_KEY: 'skala.inbox.session.v1',
  TIMEOUT_MS: 10000,
  /** 만료 이만큼 전부터 요청 전에 미리 새 토큰으로 바꾼다 */
  REFRESH_SKEW_MS: 60000,
  /** 인증 앱에 보이는 이름 */
  ISSUER: 'SKALA 작전 받은편지함',
  INFO_KEYS: 12
});

/** reason → 화면에 보이는 문구. SOP 번호는 docs/FEEDBACK_INBOX_SOP.md의 절이다 */
export const INBOX_MESSAGES = Object.freeze({
  config: '서버 주소가 설정돼 있지 않아요(js/config.js의 supabase).',
  fields: '이메일과 비밀번호를 넣어 주세요.',
  credentials: '이메일이나 비밀번호가 맞지 않아요.',
  unconfirmed: '이메일 확인이 끝나지 않은 계정이에요. 대시보드 Authentication → Users에서 이 계정을 지우고 "Auto Confirm User"를 켠 채 다시 만드세요(SOP 2절).',
  rate: '시도가 너무 잦아요. 몇 분 뒤에 다시 해 주세요.',
  mfaFormat: '인증 앱에 보이는 6자리 숫자를 넣어 주세요.',
  mfaCode: '인증 코드가 맞지 않거나 시간이 지났어요. 인증 앱에 지금 보이는 6자리를 다시 넣어 주세요.',
  mfaFactor: '등록된 인증 앱이 없어요.',
  aal: '인증 앱 코드로 로그인한 상태에서만 할 수 있어요. 로그아웃하고 코드까지 넣어 다시 로그인하세요.',
  expired: '로그인이 풀렸어요. 다시 로그인해 주세요.',
  network: '서버에 닿지 못했어요. 인터넷 연결을 확인하고 다시 해 주세요.',
  server: '서버가 오류를 냈어요. 잠시 뒤 다시 해 주세요.',
  denied: '권한이 없어요. schema.sql을 실행했는지, 이 계정을 관리자로 등록했는지 확인하세요(SOP 4·5절).',
  missing: '서버에 받은편지함 기능이 없어요. supabase/schema.sql을 처음부터 끝까지 실행하세요(SOP 4절).',
  noRow: '저장되지 않았어요. 글이 없어졌거나 권한이 없어요. 목록을 새로 불러와 확인하세요.',
  invalid: '입력을 다시 확인해 주세요.',
  replyLong: `답은 ${FEEDBACK_REPLY_MAX}자까지 보낼 수 있어요.`,
  nochange: '바뀐 내용이 없어요.',
  badItem: '글 번호를 알 수 없어요.',
  badFilter: '모르는 거르기 값이에요.',
  unknown: '알 수 없는 오류가 났어요.'
});

const fail = (reason, extra = {}) => ({ ok: false, reason, message: INBOX_MESSAGES[reason] || INBOX_MESSAGES.unknown, ...extra });

/* ------------------------------------------------------------------ 설정 · 토큰 모양 */

/** js/config.js의 supabase 칸 → { url, key, enabled }. 끝의 /는 지운다 */
export function inboxConfig(config) {
  const c = config || (globalThis.SKALA_CONFIG && globalThis.SKALA_CONFIG.supabase) || {};
  const url = String(c.url || '').trim().replace(/\/+$/, '');
  const key = String(c.anonKey || '').trim();
  return { url, key, enabled: !!(url && key) };
}

const b64urlToText = (s) => {
  const std = String(s).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(std + '='.repeat((4 - (std.length % 4)) % 4));
  return new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)));
};

/** JWT의 가운데 덩어리를 읽는다. 서명은 확인하지 않는다(브라우저는 확인할 열쇠가 없다. 화면 표시용: aal, 만료). 모양이 틀리면 null */
export function decodeJwtPayload(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3 || !parts[1]) return null;
    const payload = JSON.parse(b64urlToText(parts[1]));
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
  } catch (_) {
    return null;
  }
}

const isText = (v, max = 4096) => typeof v === 'string' && v.length > 0 && v.length <= max;

/** 서버의 사용자 factors → [{ id, status, friendlyName }] (TOTP만) */
function totpFactors(user) {
  const list = user && Array.isArray(user.factors) ? user.factors : [];
  return list
    .filter((f) => f && typeof f === 'object' && f.factor_type === 'totp' && isText(f.id, 64))
    .map((f) => ({ id: f.id, status: f.status === 'verified' ? 'verified' : 'unverified', friendlyName: typeof f.friendly_name === 'string' ? f.friendly_name : '' }));
}

/**
 * 토큰 응답(로그인·새로고침·2단계 인증 확인) → 세션. 쓸 수 없는 모양이면 null.
 * 만료는 서버의 expires_in(초)을 내 시계에 더해 정한다(내 시계가 틀려도 상대 시간은 맞다). 없으면 JWT의 exp.
 */
export function sessionFromAuthBody(body, now, prev = null) {
  if (!body || typeof body !== 'object' || !isText(body.access_token, 8192) || !isText(body.refresh_token, 1024)) return null;
  const payload = decodeJwtPayload(body.access_token) || {};
  const user = body.user && typeof body.user === 'object' ? body.user : {};
  const id = isText(user.id, 64) ? user.id : isText(payload.sub, 64) ? payload.sub : '';
  if (!id) return null;
  let expiresAt = Number(body.expires_in) > 0 ? now + Number(body.expires_in) * 1000 : Number(payload.exp) > 0 ? Number(payload.exp) * 1000 : 0;
  if (!(expiresAt > now)) expiresAt = now + 5 * 60 * 1000;
  const factors = Array.isArray(user.factors) ? totpFactors(user) : prev ? prev.factors : [];
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt,
    user: { id, email: isText(user.email, 320) ? user.email : prev && prev.user.id === id ? prev.user.email : isText(payload.email, 320) ? payload.email : '' },
    aal: payload.aal === 'aal2' ? 'aal2' : 'aal1',
    factors
  };
}

/** 인증 앱 확인이 더 필요한가: 확인된 TOTP가 있는데 이 토큰은 아직 aal2가 아니다 */
export const needsMfa = (session) => !!session && session.aal !== 'aal2' && session.factors.some((f) => f.status === 'verified');
const verifiedFactor = (session) => (session ? session.factors.find((f) => f.status === 'verified') || null : null);

/** sessionStorage에 남은 글 → 세션. 모양이 틀리면 null */
function storedSession(text) {
  try {
    const s = JSON.parse(text);
    if (!s || s.v !== 1 || !isText(s.accessToken, 8192) || !isText(s.refreshToken, 1024) || !Number.isFinite(s.expiresAt)) return null;
    if (!s.user || !isText(s.user.id, 64)) return null;
    return {
      accessToken: s.accessToken,
      refreshToken: s.refreshToken,
      expiresAt: s.expiresAt,
      user: { id: s.user.id, email: typeof s.user.email === 'string' ? s.user.email : '' },
      aal: s.aal === 'aal2' ? 'aal2' : 'aal1',
      factors: Array.isArray(s.factors) ? s.factors.filter((f) => f && isText(f.id, 64)).map((f) => ({ id: f.id, status: f.status === 'verified' ? 'verified' : 'unverified', friendlyName: typeof f.friendlyName === 'string' ? f.friendlyName : '' })) : []
    };
  } catch (_) {
    return null;
  }
}

/* ------------------------------------------------------------------ 오류 정리 */

/** Supabase Auth의 오류 응답 → { reason, detail }. 새 형식({error_code, msg})과 옛 형식({error, error_description})을 모두 읽는다 */
export function authFailure(res) {
  const j = res && res.json && typeof res.json === 'object' ? res.json : {};
  const code = String(j.error_code || j.error || '');
  const detail = String(j.msg || j.message || j.error_description || '').slice(0, 200);
  const status = res ? res.status : 0;
  let reason = 'unknown';
  if (status === 429 || /rate_limit/.test(code)) reason = 'rate';
  else if (code === 'email_not_confirmed' || /email not confirmed/i.test(detail)) reason = 'unconfirmed';
  else if (code === 'insufficient_aal') reason = 'aal';
  else if (/^mfa_/.test(code) && code !== 'mfa_factor_name_conflict') reason = 'mfaCode';
  else if (code === 'invalid_credentials' || code === 'invalid_grant' || /invalid login credentials/i.test(detail)) reason = 'credentials';
  else if (/^(refresh_token_|session_)/.test(code) || /refresh token/i.test(detail)) reason = 'expired';
  else if (status >= 500) reason = 'server';
  else if (status === 401) reason = 'expired';
  return { reason, detail };
}

/** PostgREST의 오류 응답 → { reason, detail } */
export function restFailure(res) {
  const j = res && res.json && typeof res.json === 'object' ? res.json : {};
  const code = String(j.code || '');
  const detail = String(j.message || j.msg || '').slice(0, 200);
  const status = res ? res.status : 0;
  let reason = 'unknown';
  if (status === 401 || code === 'PGRST301' || code === 'PGRST303') reason = 'expired';
  else if (status === 403 || code === '42501') reason = 'denied';
  else if (status === 404 || code === 'PGRST202' || code === 'PGRST205' || code === '42P01') reason = 'missing';
  else if (status === 400 && /^(22|23)/.test(code)) reason = 'invalid';
  else if (status === 429) reason = 'rate';
  else if (status >= 500) reason = 'server';
  return { reason, detail };
}

/* ------------------------------------------------------------------ 요청 만들기 · 응답 정리 (순수) */

const isId = (n) => Number.isSafeInteger(n) && n > 0;

/** 거르기 값 검사. '' 또는 없음 = 거르지 않음. 서버 글에 쓰는 값만 받는다(검사하지 않은 글자를 주소에 넣지 않는다) */
export function validFilter({ kind = '', status = '' } = {}) {
  if (kind && !FEEDBACK_KINDS.includes(kind)) return false;
  if (status && !INBOX.STATUSES.includes(status)) return false;
  return true;
}

/** 쪽 매기기 값을 안전한 정수로: offset은 0 이상, limit은 1~PAGE_SIZE */
export function pageArgs({ offset = 0, limit = INBOX.PAGE_SIZE } = {}) {
  return {
    offset: Math.max(0, Math.floor(Number(offset)) || 0),
    limit: Math.min(INBOX.PAGE_SIZE, Math.max(1, Math.floor(Number(limit)) || INBOX.PAGE_SIZE))
  };
}

/**
 * 목록 요청의 주소(경로+질의). 새 글이 위로 오게 만든 시각 → 번호 내림차순, 100건씩.
 * @returns {string|null} 거르기 값이 틀리면 null
 */
export function buildListPath({ kind = '', status = '', offset = 0, limit = INBOX.PAGE_SIZE } = {}) {
  if (!validFilter({ kind, status })) return null;
  const { offset: n, limit: l } = pageArgs({ offset, limit });
  let q = `select=${INBOX.COLUMNS.join(',')}&order=created_at.desc,id.desc&limit=${l}&offset=${n}`;
  if (kind) q += `&kind=eq.${kind}`;
  if (status) q += `&status=eq.${status}`;
  return `/rest/v1/${INBOX.TABLE}?${q}`;
}

/** 글 하나를 고치는 요청의 주소. 돌려받는 열은 읽기 권한이 있는 열로 줄인다 */
export const buildPatchPath = (id) => (isId(id) ? `/rest/v1/${INBOX.TABLE}?id=eq.${id}&select=${INBOX.COLUMNS.join(',')}` : null);

/** Content-Range('0-99/1234', '*\/0') → 전체 개수. 모르면 null */
export function parseContentRange(value) {
  const m = /^(?:\d+-\d+|\*)\/(\d+)$/.exec(String(value || '').trim());
  return m ? Number(m[1]) : null;
}

/** 답 입력 → { ok, reply, length } | { ok:false, reason, message }. 정리 규칙은 본문과 같다(cleanFeedback). 빈 글은 답 지우기(reply: null) */
export function validateReply(text) {
  const clean = cleanFeedback(text);
  const length = feedbackLength(clean);
  if (length > INBOX.REPLY_MAX) return { ...fail('replyLong'), length };
  return { ok: true, reply: clean || null, length };
}

const toMs = (v) => {
  if (typeof v !== 'string' || !v) return null;
  const t = Date.parse(v.replace(/(\.\d{3})\d+/, '$1'));
  return Number.isFinite(t) ? t : null;
};

/** 서버의 진단 정보 → 짧은 문자열·숫자·참거짓 칸만 */
function cleanInfo(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const k of Object.keys(raw).sort()) {
    if (Object.keys(out).length >= INBOX.INFO_KEYS) break;
    const v = raw[k];
    if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) out[k] = v;
    else if (typeof v === 'string' && v.length <= 200) out[k] = v;
  }
  return out;
}

/** 서버의 행 → 화면이 믿고 쓰는 글. 쓸 수 없으면 null */
export function normalizeInboxItem(row) {
  if (!row || typeof row !== 'object' || !isId(Number(row.id)) || typeof row.body !== 'string') return null;
  const reply = typeof row.reply === 'string' && row.reply.trim() ? row.reply : null;
  return {
    id: Number(row.id),
    playerId: isId(Number(row.player_id)) ? Number(row.player_id) : null,
    name: typeof row.name === 'string' ? row.name : '',
    kind: FEEDBACK_KINDS.includes(row.kind) ? row.kind : 'other',
    body: Array.from(row.body).slice(0, FEEDBACK_MAX).join(''),
    info: cleanInfo(row.info),
    status: INBOX.STATUSES.includes(row.status) ? row.status : 'new',
    reply,
    repliedAt: reply ? toMs(row.replied_at) : null,
    createdAt: toMs(row.created_at)
  };
}

export const normalizeInboxItems = (rows) => (Array.isArray(rows) ? rows.map(normalizeInboxItem).filter(Boolean) : []);

/* ------------------------------------------------------------------ 보여 주기 도우미 (순수) */

const KST = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});

/** 한국 시간. 짧게 '11-17 10:23', long이면 '2026-11-17 10:23'. 값이 없으면 '–' */
export function formatKst(ms, { long = false } = {}) {
  if (!Number.isFinite(ms)) return '–';
  const p = Object.fromEntries(KST.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${long ? `${p.year}-` : ''}${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/** 목록에 보이는 한 줄: 줄바꿈·연속 공백을 한 칸으로 줄이고 max자(코드 포인트)에서 자른다 */
export function snippet(body, max = 90) {
  const one = String(body ?? '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(one);
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : one;
}

const INFO_LABELS = Object.freeze({ where: '연 곳', ver: '버전', scr: '화면 크기', touch: '터치 기기', br: '브라우저', mode: '모드', map: '맵' });
const INFO_WHERE = Object.freeze({ menu: '메인 메뉴', pause: '일시정지 메뉴' });
const INFO_ORDER = Object.freeze(['where', 'mode', 'map', 'ver', 'br', 'scr', 'touch']);

/** 진단 정보 → [[이름, 값]]. 아는 칸을 먼저, 모르는 칸은 키 그대로 뒤에 둔다 */
export function infoRows(info) {
  const src = info && typeof info === 'object' ? info : {};
  const known = INFO_ORDER.filter((k) => k in src);
  const rest = Object.keys(src).filter((k) => !INFO_ORDER.includes(k)).sort();
  return [...known, ...rest].map((k) => {
    const v = src[k];
    let text;
    if (typeof v === 'boolean') text = v ? '예' : '아니요';
    else if (k === 'where' && INFO_WHERE[v]) text = INFO_WHERE[v];
    else text = String(v);
    return [INFO_LABELS[k] || k, text];
  });
}

/** 상태별 개수 → 칩에 쓰는 목록 [{ status, label, count }] ('' = 전체) */
export function statusChips(counts) {
  const c = counts || {};
  const total = INBOX.STATUSES.reduce((sum, s) => sum + (Number(c[s]) || 0), 0);
  return [{ status: '', label: '전체', count: total }, ...INBOX.STATUSES.map((s) => ({ status: s, label: FEEDBACK_STATUS_NAMES[s], count: Number(c[s]) || 0 }))];
}

/* ------------------------------------------------------------------ 클라이언트 */

/**
 * @param {{ fetch?, config?: { url, anonKey }, storage?, now?: () => number, timeoutMs? }} [opts]
 *   storage: sessionStorage 모양({ getItem, setItem, removeItem }). 없으면 globalThis.sessionStorage(막혀 있으면 메모리만).
 * 모든 메서드는 예외를 던지지 않고 { ok:true, ... } 또는 { ok:false, reason, message }를 돌려준다.
 */
export function createInboxClient({ fetch: fetchImpl, config, storage, now = Date.now, timeoutMs = INBOX.TIMEOUT_MS } = {}) {
  const { url, key, enabled } = inboxConfig(config);
  const send = fetchImpl || ((...args) => globalThis.fetch(...args));
  let session = null;
  let refreshing = null;

  function store() {
    if (storage) return storage;
    try { return globalThis.sessionStorage || null; } catch (_) { return null; }
  }
  function persist() {
    try {
      const s = store();
      if (!s) return;
      if (!session) { s.removeItem(INBOX.STORAGE_KEY); return; }
      s.setItem(INBOX.STORAGE_KEY, JSON.stringify({ v: 1, ...session }));
    } catch (_) { /* 저장소가 막혀 있어도 메모리로 계속한다 */ }
  }
  const setSession = (next) => { session = next; persist(); };
  const clearSession = () => setSession(null);

  /** 한 번 부르고 { status, ok, json, range } 또는 { network:true }. 시간이 지나면 끊는다 */
  async function raw(method, path, headers, body) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => { if (controller) controller.abort(); resolve({ network: true }); }, timeoutMs); });
    const call = (async () => {
      try {
        const res = await send(`${url}${path}`, {
          method,
          headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: controller ? controller.signal : undefined
        });
        let json = null;
        try {
          if (typeof res.text === 'function') { const t = await res.text(); json = t ? JSON.parse(t) : null; }
          else if (typeof res.json === 'function') json = await res.json();
        } catch (_) { json = null; }
        const range = res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-range') : null;
        return { status: res.status, ok: !!res.ok, json, range };
      } catch (_) {
        return { network: true };
      }
    })();
    try { return await Promise.race([call, timeout]); } finally { clearTimeout(timer); }
  }

  async function refresh() {
    if (!session) return fail('expired');
    if (refreshing) return refreshing;
    const mine = session;
    refreshing = (async () => {
      const res = await raw('POST', '/auth/v1/token?grant_type=refresh_token', authHeaders(key), { refresh_token: mine.refreshToken });
      if (res.network) return fail('network');
      const next = res.ok ? sessionFromAuthBody(res.json, now(), mine) : null;
      if (!next) { clearSession(); return fail('expired'); }
      setSession(next);
      return { ok: true };
    })().finally(() => { refreshing = null; });
    return refreshing;
  }

  /** 로그인한 사용자로 부른다. 토큰이 곧 끝나거나 401이면 한 번 새로 받아 다시 부른다 */
  async function user(method, path, { body, headers, retry = true } = {}) {
    if (!enabled) return fail('config');
    if (!session) return fail('expired');
    if (session.expiresAt - now() < INBOX.REFRESH_SKEW_MS) {
      const r = await refresh();
      if (!r.ok) return r;
    }
    const res = await raw(method, path, { apikey: key, Authorization: `Bearer ${session.accessToken}`, ...headers }, body);
    if (res.network) return fail('network');
    if (res.status === 401 && retry) {
      const r = await refresh();
      return r.ok ? user(method, path, { body, headers, retry: false }) : r;
    }
    return res;
  }

  /** 로그인 전에 부른다(공개 키만) */
  async function anon(method, path, body) {
    if (!enabled) return fail('config');
    const res = await raw(method, path, authHeaders(key), body);
    return res.network ? fail('network') : res;
  }

  /** 내가 만든 실패({ ok:false, reason, message })인가. 서버 응답({ status, ok, json })과 구별한다 */
  const isFail = (r) => !!r && r.ok === false && typeof r.reason === 'string';
  const authError = (res) => { const f = authFailure(res); return fail(f.reason, f.detail ? { detail: f.detail } : {}); };
  const restError = (res) => { const f = restFailure(res); return fail(f.reason, f.detail ? { detail: f.detail } : {}); };

  /** 첫 번째 확인된 TOTP로 도전 → 확인. 성공하면 aal2 세션으로 바뀐다 */
  async function challengeAndVerify(factorId, code) {
    const digits = String(code ?? '').replace(/\s+/g, '');
    if (!/^\d{6}$/.test(digits)) return fail('mfaFormat');
    const id = encodeURIComponent(factorId);
    const ch = await user('POST', `/auth/v1/factors/${id}/challenge`, { body: {} });
    if (isFail(ch)) return ch;
    if (!ch.ok || !ch.json || !isText(ch.json.id, 64)) return authError(ch);
    const v = await user('POST', `/auth/v1/factors/${id}/verify`, { body: { challenge_id: ch.json.id, code: digits } });
    if (isFail(v)) return v;
    if (!v.ok) {
      const f = authFailure(v);
      return fail(f.reason === 'unknown' || f.reason === 'credentials' ? 'mfaCode' : f.reason, f.detail ? { detail: f.detail } : {});
    }
    const next = sessionFromAuthBody(v.json, now(), session);
    if (!next) return fail('unknown');
    setSession(next);
    return { ok: true, aal: next.aal };
  }

  return {
    enabled,
    /** 지금 세션의 겉모습(토큰은 내보내지 않는다) */
    state() {
      return session
        ? { signedIn: true, email: session.user.email, userId: session.user.id, aal: session.aal, needsMfa: needsMfa(session), factors: session.factors.map((f) => ({ ...f })), expiresAt: session.expiresAt }
        : { signedIn: false, email: '', userId: '', aal: null, needsMfa: false, factors: [], expiresAt: 0 };
    },

    /** 이 탭(sessionStorage)에 남은 세션을 되살린다. 만료됐으면 새 토큰을 받아 본다 */
    async restore() {
      if (!enabled) return fail('config');
      let saved = null;
      try { const s = store(); saved = s ? s.getItem(INBOX.STORAGE_KEY) : null; } catch (_) { saved = null; }
      const s = saved ? storedSession(saved) : null;
      if (!s) { if (saved) clearSession(); return { ok: true, restored: false }; }
      session = s;
      if (session.expiresAt - now() < INBOX.REFRESH_SKEW_MS) {
        const r = await refresh();
        if (!r.ok) return r.reason === 'network' ? r : { ok: true, restored: false };
      }
      return { ok: true, restored: true };
    },

    /** 이메일·비밀번호로 로그인. → { ok, email, needsMfa } */
    async signIn(email, password) {
      const e = String(email ?? '').trim().toLowerCase();   // Supabase Auth는 이메일을 소문자로 저장한다
      const p = String(password ?? '');
      if (!e || !p) return fail('fields');
      const res = await anon('POST', '/auth/v1/token?grant_type=password', { email: e, password: p });
      if (isFail(res)) return res;
      if (!res.ok) return authError(res);
      const next = sessionFromAuthBody(res.json, now());
      if (!next) return fail('unknown');
      setSession(next);
      return { ok: true, email: next.user.email, needsMfa: needsMfa(next) };
    },

    /** 로그인 뒤 인증 앱 코드로 aal2가 된다 */
    async verifyTotp(code) {
      const f = verifiedFactor(session);
      if (!f) return fail('mfaFactor');
      return challengeAndVerify(f.id, code);
    },

    /** 이 기기의 로그인만 끝낸다(다른 기기 세션은 그대로). 서버가 실패해도 이 탭의 토큰은 지운다 */
    async signOut() {
      const had = session;
      clearSession();
      if (had && enabled) await raw('POST', '/auth/v1/logout?scope=local', { apikey: key, Authorization: `Bearer ${had.accessToken}` }, undefined);
      return { ok: true };
    },

    /** 이 계정이 건의함 관리자인가(fps_is_admin). false면 목록은 늘 비어 있다 */
    async isAdmin() {
      const res = await user('POST', '/rest/v1/rpc/fps_is_admin', { body: {} });
      if (isFail(res)) return res;
      if (!res.ok) return restError(res);
      return { ok: true, admin: res.json === true };
    },

    /** 목록 한 쪽. → { ok, items, total, hasMore }. total은 같은 거르기의 전체 개수 */
    async list(opts = {}) {
      const path = buildListPath(opts);
      if (!path) return fail('badFilter');
      const res = await user('GET', path, { headers: { Prefer: 'count=exact' } });
      if (isFail(res)) return res;
      if (!res.ok) return restError(res);
      const { offset, limit } = pageArgs(opts);
      const rows = Array.isArray(res.json) ? res.json.length : 0;
      const total = parseContentRange(res.range);
      return {
        ok: true,
        items: normalizeInboxItems(res.json),
        total: total ?? offset + rows,
        hasMore: total != null ? offset + rows < total : rows >= limit
      };
    },

    /** 상태별 개수. → { ok, counts: { new, read, done, hold } } */
    async counts() {
      const counts = {};
      const rest = await Promise.all(INBOX.STATUSES.map(async (status) => {
        const res = await user('GET', `/rest/v1/${INBOX.TABLE}?select=id&status=eq.${status}&limit=1`, { headers: { Prefer: 'count=exact' } });
        if (isFail(res)) return res;
        if (!res.ok) return restError(res);
        counts[status] = parseContentRange(res.range) ?? 0;
        return null;
      }));
      const bad = rest.find(Boolean);
      return bad || { ok: true, counts };
    },

    /** 답을 저장한다. 빈 글이면 답을 지운다. → { ok, item } */
    async saveReply(id, text) {
      const v = validateReply(text);
      if (!v.ok) return v;
      return patch(id, { reply: v.reply });
    },

    /** 상태 단추. → { ok, item } */
    async saveStatus(id, status) {
      if (!INBOX.STATUS_ACTIONS.includes(status)) return fail('invalid');
      return patch(id, { status });
    },

    /** 2단계 인증 등록 시작(TOTP). → { ok, factorId, secret, uri, qrSvg } */
    async mfaEnroll() {
      const friendlyName = `inbox-${new Date(now()).toISOString().replace(/[-:T]/g, '').slice(0, 14)}`;
      const res = await user('POST', '/auth/v1/factors', { body: { factor_type: 'totp', friendly_name: friendlyName, issuer: INBOX.ISSUER } });
      if (isFail(res)) return res;
      if (!res.ok) return authError(res);
      const j = res.json || {};
      const t = j.totp || {};
      if (!isText(j.id, 64) || !isText(t.secret, 256)) return fail('unknown');
      const svg = typeof t.qr_code === 'string' && /^\s*<svg[\s>]/.test(t.qr_code) && t.qr_code.length <= 200000 ? t.qr_code.trim() : '';
      return { ok: true, factorId: j.id, secret: t.secret, uri: typeof t.uri === 'string' && t.uri.startsWith('otpauth://') ? t.uri : '', qrSvg: svg };
    },

    /** 등록 확인: 인증 앱의 6자리 코드를 맞춰 본다. 맞으면 이 세션이 aal2가 된다 */
    async mfaConfirm(factorId, code) {
      if (!isText(factorId, 64)) return fail('mfaFactor');
      const r = await challengeAndVerify(factorId, code);
      if (r.ok && session) {
        const mark = (f) => (f.id === factorId ? { ...f, status: 'verified' } : f);
        setSession({ ...session, factors: session.factors.some((f) => f.id === factorId) ? session.factors.map(mark) : [...session.factors, { id: factorId, status: 'verified', friendlyName: '' }] });
      }
      return r;
    },

    /** 끝내지 않은 등록을 버린다(확인되지 않은 factor만 지울 수 있다) */
    async mfaDiscard(factorId) {
      if (!isText(factorId, 64)) return fail('mfaFactor');
      const res = await user('DELETE', `/auth/v1/factors/${encodeURIComponent(factorId)}`);
      if (isFail(res)) return res;
      if (res.ok && session) setSession({ ...session, factors: session.factors.filter((f) => f.id !== factorId) });
      return res.ok ? { ok: true } : authError(res);
    }
  };

  async function patch(id, fields) {
    const path = buildPatchPath(Number(id));
    if (!path) return fail('badItem');
    const res = await user('PATCH', path, { body: fields, headers: { Prefer: 'return=representation' } });
    if (isFail(res)) return res;
    if (!res.ok) return restError(res);
    const item = Array.isArray(res.json) && res.json.length === 1 ? normalizeInboxItem(res.json[0]) : null;
    return item ? { ok: true, item } : fail('noRow');
  }
}
