/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: Web Crypto 도우미. base64url, 무작위 hex, SHA-256, HMAC-SHA256 서명·검증(검증은 crypto.subtle.verify라 시간 차이로 새지 않는다).
 *          Workers와 Node 20 모두 globalThis.crypto를 쓴다.
 */

const enc = new TextEncoder();

export function b64urlEncode(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < view.length; i += 1) s += String.fromCharCode(view[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** base64url 글자 → 바이트. 형식이 틀리면 null */
export function b64urlDecode(text) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text)) return null;
  const pad = text.length % 4;
  if (pad === 1) return null;
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/') + (pad ? '='.repeat(4 - pad) : '');
  try {
    const raw = atob(b64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
    return out;
  } catch (_) {
    return null;
  }
}

export function b64urlJson(value) {
  return b64urlEncode(enc.encode(JSON.stringify(value)));
}

/** base64url JSON → 값. 깨졌으면 null */
export function parseB64urlJson(text) {
  const bytes = b64urlDecode(text);
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (_) {
    return null;
  }
}

/** n바이트 무작위 값을 hex로(n=16이면 32글자) */
export function randomHex(n = 16) {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256B64url(text) {
  return b64urlEncode(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text))));
}

const keys = new Map();   // 비밀 값 → CryptoKey. Worker 한 인스턴스 안에서만 남는다

function hmacKey(secret) {
  if (!keys.has(secret)) {
    keys.set(secret, crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']));
  }
  return keys.get(secret);
}

export async function hmacSign(secret, text) {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(text));
  return b64urlEncode(new Uint8Array(sig));
}

export async function hmacVerify(secret, text, sig) {
  const bytes = b64urlDecode(sig);
  if (!bytes || bytes.length !== 32) return false;
  return crypto.subtle.verify('HMAC', await hmacKey(secret), bytes, enc.encode(text));
}

/** 토스 API의 Basic 인증 헤더: 시크릿 키 뒤에 ':'을 붙여 base64로 */
export function basicAuth(secretKey) {
  return `Basic ${btoa(`${secretKey}:`)}`;
}
