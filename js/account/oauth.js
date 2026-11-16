/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 브라우저 쪽 OAuth 도우미(인가 코드 + PKCE). state·nonce·code_verifier를 만들어 sessionStorage에 두고 인가 화면 주소를 만든다.
 *          돌아온 주소에서 code·state와 결제 결과(#skala-pay=…)를 읽고, 읽은 값은 주소에서 지운다(새로 고침이나 공유로 다시 쓰이지 않게).
 *          code를 토큰으로 바꾸는 일과 ID 토큰 검증은 서버(server/api)가 한다. 여기에는 비밀 값이 없다.
 */

export const OAUTH_KEY = 'skalafps.oauth';
export const OAUTH_MAX_AGE_MS = 600000;   // 인가 화면에서 10분 안에 돌아와야 한다(제공자의 인가 코드도 10분짜리다)
/** 제공자가 돌려보낼 때 붙이는 쿼리. 게임 주소에서 지운다 */
export const CALLBACK_PARAMS = Object.freeze(['code', 'state', 'scope', 'authuser', 'prompt', 'hd', 'iss', 'session_state', 'error', 'error_description', 'error_uri']);
export const PAY_HASH_KEY = 'skala-pay';

const enc = new TextEncoder();

export function b64url(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** n바이트 무작위 값을 base64url로(32바이트 → 43글자) */
export function randomB64url(n = 32) {
  const bytes = new Uint8Array(n);
  globalThis.crypto.getRandomValues(bytes);
  return b64url(bytes);
}

/** PKCE S256: base64url(SHA-256(verifier)) */
export async function pkceChallenge(verifier) {
  return b64url(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', enc.encode(verifier))));
}

/** 제공자에 등록할 돌아올 주소: 이 페이지의 폴더 주소(…/index.html도 …/로). 쿼리·해시는 붙이지 않는다 */
export function redirectUriOf(loc) {
  const path = String(loc.pathname || '/').replace(/index\.html$/, '');
  return `${loc.origin}${path}`;
}

/** 인가 화면 주소. provider = /features의 { authorizeUrl, clientId, scope, params } */
export function authorizeUrl(provider, { redirectUri, state, nonce, challenge }) {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: provider.clientId,
    redirect_uri: redirectUri,
    scope: provider.scope || 'openid',
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256'
  });
  const extra = provider.params && typeof provider.params === 'object' ? provider.params : {};
  for (const [k, v] of Object.entries(extra)) if (typeof v === 'string' && !q.has(k)) q.set(k, v);
  return `${provider.authorizeUrl}?${q.toString()}`;
}

/** 돌아온 주소의 인가 결과. code나 error가 없으면 null */
export function readCallback(loc) {
  const q = new URLSearchParams(loc.search || '');
  const code = q.get('code');
  const error = q.get('error');
  if (!code && !error) return null;
  return { code: code || '', state: q.get('state') || '', error: error || '' };
}

/** 결제 결과(#skala-pay=done&order=…&coins=…). 없으면 null */
export function readPayResult(loc) {
  const hash = String(loc.hash || '').replace(/^#/, '');
  if (!hash.includes(`${PAY_HASH_KEY}=`)) return null;
  const q = new URLSearchParams(hash);
  const kind = q.get(PAY_HASH_KEY);
  if (!['done', 'fail', 'pending'].includes(kind)) return null;
  const coins = Number(q.get('coins'));
  return { kind, order: q.get('order') || '', code: q.get('code') || '', coins: Number.isInteger(coins) ? coins : null };
}

/** 인가 결과 쿼리와 결제 결과 해시를 뺀 주소(history.replaceState용). 다른 쿼리(?debug=1 등)는 남긴다 */
export function cleanedUrl(loc) {
  const u = new URL(loc.href);
  for (const k of CALLBACK_PARAMS) u.searchParams.delete(k);
  if (readPayResult(loc)) u.hash = '';
  return u.toString();
}

function sessionOf(injected) {
  if (injected !== undefined) return injected;
  try {
    return globalThis.sessionStorage || null;
  } catch (_) {
    return null;
  }
}

/** 인가 화면으로 떠나기 전의 기록. 한 번 읽으면 지운다 */
export function createPendingStore(storage) {
  const backing = sessionOf(storage);
  return {
    save(record) {
      try { if (backing) backing.setItem(OAUTH_KEY, JSON.stringify(record)); } catch (_) { /* 저장소 차단 */ }
    },
    take() {
      let raw = null;
      try {
        raw = backing ? backing.getItem(OAUTH_KEY) : null;
        if (backing) backing.removeItem(OAUTH_KEY);
      } catch (_) {
        raw = null;
      }
      if (!raw) return null;
      try {
        const r = JSON.parse(raw);
        return r && typeof r === 'object' && typeof r.state === 'string' ? r : null;
      } catch (_) {
        return null;
      }
    }
  };
}
