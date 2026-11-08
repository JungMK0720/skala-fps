/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 이모트 음원 묶음(.bin)의 형식과 키. 브라우저는 WebCrypto(AES-GCM)로 풀어 재생하고, tools/pack-emote-audio.mjs는 같은 키로 묶는다.
 *          원본 음원은 저장소에 두지 않는다. 키가 사이트 코드에 있으니 DRM이 아니라 "파일을 받아도 바로 들을 수 없게" 하는 정도다.
 */
/**
 * 형식: 'SKE1'(4바이트) + IV(12바이트) + 암호문‖GCM 태그(16바이트). 암호문을 풀면 WAV(PCM)가 나온다.
 * IV는 묶는 도구가 내용 해시로 정해서, 같은 음원을 다시 묶어도 같은 파일이 나온다(키 하나에 내용이 다르면 IV도 다르다).
 */
export const EMOTE_PACK = Object.freeze({ MAGIC: 'SKE1', IV_BYTES: 12, TAG_BYTES: 16 });
export const EMOTE_KEY_HEX = '5f3069088f94ea2b18799b8fe9249ab73c65dc611f3ef28c964866bc31cac1f8';

const MAGIC_BYTES = Object.freeze([...EMOTE_PACK.MAGIC].map((c) => c.charCodeAt(0)));
const HEAD = MAGIC_BYTES.length + EMOTE_PACK.IV_BYTES;

export function keyBytes() {
  const out = new Uint8Array(EMOTE_KEY_HEX.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(EMOTE_KEY_HEX.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** 묶음 형식이 맞는가(머리 글자와 최소 길이) */
export function isEmotePack(buf) {
  const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf || new ArrayBuffer(0));
  if (u.length < HEAD + EMOTE_PACK.TAG_BYTES) return false;
  return MAGIC_BYTES.every((b, i) => u[i] === b);
}

let keyPromise = null;
function cryptoKey(subtle) {
  if (!keyPromise) {
    keyPromise = subtle.importKey('raw', keyBytes(), { name: 'AES-GCM' }, false, ['decrypt']);
    keyPromise.catch(() => { keyPromise = null; });
  }
  return keyPromise;
}

/**
 * 묶음(ArrayBuffer) → 풀린 음원(ArrayBuffer, WAV). 형식이 틀리거나 내용이 바뀌었거나 WebCrypto가 없으면 예외.
 * WebCrypto는 보안 연결(https·localhost)에서만 있다. 없으면 부르는 쪽(fx/audio.js)이 합성음으로 돌아간다.
 */
export async function decryptEmote(buf, subtle = globalThis.crypto && globalThis.crypto.subtle) {
  if (!subtle || typeof subtle.decrypt !== 'function') throw new Error('WebCrypto 없음');
  const u = new Uint8Array(buf);
  if (!isEmotePack(u)) throw new Error('묶음 형식이 아님');
  const iv = u.slice(MAGIC_BYTES.length, HEAD);
  const key = await cryptoKey(subtle);
  try {
    return await subtle.decrypt({ name: 'AES-GCM', iv, tagLength: EMOTE_PACK.TAG_BYTES * 8 }, key, u.slice(HEAD));
  } catch {
    throw new Error('풀기 실패');
  }
}
