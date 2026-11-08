/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 비밀번호 방의 채널 이름에 붙일 비밀 값. 비밀번호와 방 id로 PBKDF2(SHA-256, 10만 번)를 돌려 hex 24자를 만든다.
 *          비밀번호는 어디에도 보내지 않는다. 같은 비밀번호를 아는 사람만 같은 채널을 찾는다(서버가 검사하는 잠금이 아니라 채널 이름을 숨기는 잠금).
 */
export const PASSWORD_MAX = 32;
const ITERATIONS = 100000;
const SALT_PREFIX = 'skalafps-room:';

/** 앞뒤 공백을 뺀 비밀번호(최대 32자). 문자열이 아니거나 비어 있으면 '' */
export function cleanPassword(v) {
  return typeof v === 'string' ? v.trim().slice(0, PASSWORD_MAX) : '';
}

/**
 * 방 id와 비밀번호로 채널 이름에 붙일 비밀 값을 만든다. 비밀번호가 비면 ''(공개 방).
 * WebCrypto는 https나 localhost에서만 쓸 수 있다.
 * @returns {Promise<string>} hex 24자 또는 ''
 */
export async function roomSecret(roomId, password) {
  const pw = cleanPassword(password);
  if (!pw) return '';
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (!subtle) {
    const e = new Error('이 브라우저는 비밀번호 방을 지원하지 않아요');
    e.code = 'NO_CRYPTO';
    throw e;
  }
  const enc = new TextEncoder();
  const key = await subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(SALT_PREFIX + String(roomId)), iterations: ITERATIONS }, key, 96);
  return Array.from(new Uint8Array(bits), (b) => b.toString(16).padStart(2, '0')).join('');
}
