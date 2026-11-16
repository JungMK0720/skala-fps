/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: OAuth 2.0 인가 코드 + PKCE와 OpenID Connect ID 토큰 검증(구글·카카오). 게임은 인가 화면으로 보내고 돌아온 code를 이 Worker에 넘긴다.
 *          Worker는 client secret과 code_verifier로 code를 토큰으로 바꾸고, ID 토큰의 서명(JWKS, RS256)·발급자·대상·만료·nonce를 확인해 고유 id(sub)를 얻는다.
 *          액세스 토큰은 쓰지 않고 버린다. 이메일·이름 같은 개인정보는 받지 않는다(scope=openid).
 */
import { b64urlDecode, parseB64urlJson } from './crypto.js';
import { originAllowed } from './http.js';

export const PROVIDERS = Object.freeze({
  google: Object.freeze({
    id: 'google',
    name: '구글',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs',
    issuers: Object.freeze(['https://accounts.google.com', 'accounts.google.com']),
    scope: 'openid',
    params: Object.freeze({ prompt: 'select_account' }),   // 같이 쓰는 PC에서 다른 사람 계정으로 바로 들어가지 않게
    env: 'GOOGLE',
    needsSecret: true
  }),
  kakao: Object.freeze({
    id: 'kakao',
    name: '카카오',
    authorizeUrl: 'https://kauth.kakao.com/oauth/authorize',
    tokenUrl: 'https://kauth.kakao.com/oauth/token',
    jwksUrl: 'https://kauth.kakao.com/.well-known/jwks.json',
    issuers: Object.freeze(['https://kauth.kakao.com']),
    scope: 'openid',
    params: Object.freeze({}),
    env: 'KAKAO',
    needsSecret: false   // 카카오는 콘솔에서 Client Secret을 켰을 때만 보낸다
  })
});

const CODE_RE = /^[\x21-\x7e]{1,2048}$/;
const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;   // RFC 7636 4.1
const NONCE_RE = /^[A-Za-z0-9_-]{16,128}$/;
const JWKS_TTL_MS = 3600000;
const CLOCK_SKEW_SEC = 120;

const clientIdOf = (p, env) => String(env[`${p.env}_CLIENT_ID`] || '').trim();
const secretOf = (p, env) => String(env[`${p.env}_CLIENT_SECRET`] || '').trim();

/** 설정된 제공자(클라이언트 id가 있고, 필요하면 secret도 있다) */
export function enabledProviders(env) {
  return Object.values(PROVIDERS).filter((p) => clientIdOf(p, env) && (!p.needsSecret || secretOf(p, env)));
}

/** 게임에 알려 주는 공개 정보: 인가 주소를 만들 때 쓴다 */
export function publicProvider(p, env) {
  return { id: p.id, name: p.name, authorizeUrl: p.authorizeUrl, clientId: clientIdOf(p, env), scope: p.scope, params: { ...p.params } };
}

/** 게임이 보낸 redirect_uri: 허용한 Origin의 절대 주소이고 해시가 없다. 맞으면 받은 글자 그대로(제공자가 글자 단위로 비교한다), 아니면 null */
export function validRedirectUri(raw, list) {
  if (typeof raw !== 'string' || raw.length > 512) return null;
  let u;
  try {
    u = new URL(raw);
  } catch (_) {
    return null;
  }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return null;
  if (u.hash || u.username || u.password || !originAllowed(u.origin, list)) return null;
  return raw;
}

/** 교환 요청의 모양 검사. → { ok:true, code, codeVerifier, nonce, redirectUri } 또는 { ok:false } */
export function readExchange(body, list) {
  const code = body && body.code;
  const codeVerifier = body && body.codeVerifier;
  const nonce = body && body.nonce;
  const redirectUri = validRedirectUri(body && body.redirectUri, list);
  if (typeof code !== 'string' || !CODE_RE.test(code)) return { ok: false };
  if (typeof codeVerifier !== 'string' || !VERIFIER_RE.test(codeVerifier)) return { ok: false };
  if (typeof nonce !== 'string' || !NONCE_RE.test(nonce) || !redirectUri) return { ok: false };
  return { ok: true, code, codeVerifier, nonce, redirectUri };
}

/** 인가 코드 → ID 토큰. 실패는 { ok:false, error:'OAUTH_EXCHANGE', status, reason } */
export async function exchangeCode(p, { code, codeVerifier, redirectUri }, env, fetchImpl) {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientIdOf(p, env),
    code_verifier: codeVerifier
  });
  if (secretOf(p, env)) form.set('client_secret', secretOf(p, env));
  let res;
  let data = null;
  try {
    res = await fetchImpl(p.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded;charset=utf-8', accept: 'application/json' },
      body: form.toString()
    });
    data = await res.json().catch(() => null);
  } catch (_) {
    return { ok: false, error: 'OAUTH_EXCHANGE', status: 0, reason: 'network' };
  }
  if (!res.ok || !data || typeof data.id_token !== 'string') {
    return { ok: false, error: 'OAUTH_EXCHANGE', status: res.status, reason: (data && (data.error || data.error_code)) || 'no_id_token' };
  }
  return { ok: true, idToken: data.id_token };
}

// ───────────── ID 토큰 검증 ─────────────
const jwksCache = new Map();   // jwksUrl → { at, keys: Map(kid → Promise<CryptoKey>) }

export function resetJwksCache() {
  jwksCache.clear();
}

async function loadJwks(url, fetchImpl, nowMs) {
  const res = await fetchImpl(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`JWKS HTTP ${res.status}`);
  const data = await res.json();
  const keys = new Map();
  for (const jwk of (data && Array.isArray(data.keys) ? data.keys : [])) {
    if (!jwk || jwk.kty !== 'RSA' || typeof jwk.kid !== 'string' || typeof jwk.n !== 'string' || typeof jwk.e !== 'string') continue;
    if (jwk.alg && jwk.alg !== 'RS256') continue;
    if (jwk.use && jwk.use !== 'sig') continue;
    keys.set(jwk.kid, crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']));
  }
  const entry = { at: nowMs, keys };
  jwksCache.set(url, entry);
  return entry;
}

/** kid의 공개 열쇠. 캐시에 없으면(열쇠를 바꿨을 수 있음) 1분에 한 번까지 다시 받는다 */
async function keyFor(url, kid, fetchImpl, nowMs) {
  let entry = jwksCache.get(url);
  if (!entry || nowMs - entry.at > JWKS_TTL_MS) entry = await loadJwks(url, fetchImpl, nowMs);
  if (!entry.keys.has(kid) && nowMs - entry.at > 60000) entry = await loadJwks(url, fetchImpl, nowMs);
  return entry.keys.get(kid) || null;
}

/**
 * ID 토큰을 검증하고 고유 id(sub)를 돌려준다. 확인하는 것: RS256 서명(제공자 JWKS), iss, aud(우리 client id), exp·iat(2분 여유), nonce.
 * → { ok:true, subject } 또는 { ok:false, error:'ID_TOKEN_INVALID', reason }
 */
export async function verifyIdToken(idToken, { provider, clientId, nonce }, fetchImpl, nowMs = Date.now()) {
  const fail = (reason) => ({ ok: false, error: 'ID_TOKEN_INVALID', reason });
  if (typeof idToken !== 'string' || idToken.length > 8192) return fail('shape');
  const parts = idToken.split('.');
  if (parts.length !== 3) return fail('shape');
  const header = parseB64urlJson(parts[0]);
  const claims = parseB64urlJson(parts[1]);
  const sig = b64urlDecode(parts[2]);
  if (!header || !claims || !sig) return fail('shape');
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') return fail('alg');
  let key;
  try {
    key = await keyFor(provider.jwksUrl, header.kid, fetchImpl, nowMs);
  } catch (_) {
    return fail('jwks');
  }
  if (!key) return fail('kid');
  let good = false;
  try {
    good = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', await key, sig, new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  } catch (_) {
    good = false;
  }
  if (!good) return fail('signature');
  const now = Math.floor(nowMs / 1000);
  if (!provider.issuers.includes(claims.iss)) return fail('iss');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!clientId || !aud.includes(clientId)) return fail('aud');
  if (!Number.isFinite(claims.exp) || claims.exp + CLOCK_SKEW_SEC < now) return fail('exp');
  if (Number.isFinite(claims.iat) && claims.iat - CLOCK_SKEW_SEC > now) return fail('iat');
  if (typeof nonce !== 'string' || claims.nonce !== nonce) return fail('nonce');
  if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255) return fail('sub');
  return { ok: true, subject: claims.sub };
}

export { clientIdOf };
