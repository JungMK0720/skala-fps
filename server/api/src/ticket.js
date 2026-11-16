/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 로그인 표(ticket). 구글·카카오의 ID 토큰을 검증한 뒤 "이 브라우저는 (제공자, 고유 id)의 주인이다"를 10분 동안 증명하는 서명 글자다.
 *          게임은 이 표로 계정을 잇거나(link) 이 기기에 로그인한다(login). 표마다 jti가 있어 DB(fps_ticket_once)가 한 번만 쓰게 한다.
 *          모양: base64url(JSON { p, s, exp, jti }) + '.' + HMAC-SHA256(AUTH_SECRET). 비밀 값이 32글자보다 짧으면 쓰지 않는다.
 */
import { b64urlJson, hmacSign, hmacVerify, parseB64urlJson, randomHex } from './crypto.js';

export const TICKET_TTL_SEC = 600;
export const SECRET_MIN = 32;
const SCOPE = 'skala-ticket.v1.';
const PROVIDER_IDS = new Set(['google', 'kakao']);

export function ticketReady(secret) {
  return typeof secret === 'string' && secret.length >= SECRET_MIN;
}

export async function signTicket({ provider, subject }, secret, now = Date.now()) {
  if (!ticketReady(secret)) throw new Error('AUTH_SECRET이 없거나 너무 짧습니다');
  const payload = b64urlJson({ p: provider, s: subject, exp: Math.floor(now / 1000) + TICKET_TTL_SEC, jti: randomHex(16) });
  return `${payload}.${await hmacSign(secret, SCOPE + payload)}`;
}

/** → { ok:true, provider, subject, jti } 또는 { ok:false, error:'TICKET_INVALID'|'TICKET_EXPIRED' } */
export async function verifyTicket(ticket, secret, now = Date.now()) {
  const bad = { ok: false, error: 'TICKET_INVALID' };
  if (!ticketReady(secret) || typeof ticket !== 'string' || ticket.length > 1024) return bad;
  const dot = ticket.indexOf('.');
  if (dot <= 0 || dot !== ticket.lastIndexOf('.')) return bad;
  const payload = ticket.slice(0, dot);
  if (!(await hmacVerify(secret, SCOPE + payload, ticket.slice(dot + 1)))) return bad;
  const body = parseB64urlJson(payload);
  if (!body || !PROVIDER_IDS.has(body.p) || typeof body.s !== 'string' || !body.s || body.s.length > 255) return bad;
  if (typeof body.jti !== 'string' || !/^[0-9a-f]{32}$/.test(body.jti) || !Number.isInteger(body.exp)) return bad;
  if (body.exp <= Math.floor(now / 1000)) return { ok: false, error: 'TICKET_EXPIRED' };
  return { ok: true, provider: body.p, subject: body.s, jti: body.jti };
}
