/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 토스페이먼츠 결제 API 클라이언트(Worker 전용, 시크릿 키). 승인(confirm), paymentKey로 조회, 취소. 승인·취소는 주문마다 정한 멱등키를 보낸다
 *          (같은 요청을 다시 보내도 토스가 한 번만 처리하고 처음 응답을 돌려준다, 15일 유효).
 *          결과: { ok:true, payment } 또는 { ok:false, status, code, message }. status 0 = 네트워크(결과를 모른다).
 *          키 접두사로 테스트·라이브를 가른다(test_… / live_…). 라이브 키는 PAY_ALLOW_LIVE가 'true'일 때만 쓴다(pay.js payConfig).
 */
import { basicAuth } from './crypto.js';

export const TOSS_API = 'https://api.tosspayments.com';
export const TOSS_TIMEOUT_MS = 15000;

/** 'test' | 'live' | null */
export function keyMode(key) {
  const k = String(key || '');
  if (k.startsWith('test_')) return 'test';
  if (k.startsWith('live_')) return 'live';
  return null;
}

/** 결과를 모르는 실패인가(네트워크·토스 서버 오류·같은 멱등 요청이 아직 처리 중). 이런 주문은 대사가 나중에 정리한다 */
export function isUnknownOutcome(r) {
  return !!r && r.ok === false && (r.status === 0 || r.status >= 500 || r.code === 'IDEMPOTENT_REQUEST_PROCESSING');
}

export function createToss(env, fetchImpl) {
  const secret = String(env.TOSS_SECRET_KEY || '').trim();
  const auth = basicAuth(secret);

  async function request(method, path, body, idempotencyKey) {
    const headers = { authorization: auth, accept: 'application/json' };
    if (body) headers['content-type'] = 'application/json';
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TOSS_TIMEOUT_MS);
    try {
      const res = await fetchImpl(TOSS_API + path, {
        method, headers, body: body ? JSON.stringify(body) : undefined, signal: controller.signal
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data && typeof data === 'object') return { ok: true, status: res.status, payment: data };
      // 성공(2xx)인데 본문을 읽지 못했다(시간 초과로 본문 중간에 끊김 등): 토스는 처리했을 수 있으니 실패가 아니라 "결과를 모른다"로 둔다
      if (res.ok) return { ok: false, status: 0, code: 'BAD_RESPONSE', message: '' };
      return {
        ok: false,
        status: res.status,
        code: (data && typeof data.code === 'string' && data.code) || `HTTP_${res.status}`,
        message: (data && typeof data.message === 'string' && data.message.slice(0, 200)) || ''
      };
    } catch (_) {
      return { ok: false, status: 0, code: 'NETWORK', message: '' };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    ready: !!secret,
    confirm: (paymentKey, orderId, amount) =>
      request('POST', '/v1/payments/confirm', { paymentKey, orderId, amount }, `confirm-${orderId}`),
    get: (paymentKey) => request('GET', `/v1/payments/${encodeURIComponent(paymentKey)}`),
    cancel: (paymentKey, reason, orderId) =>
      request('POST', `/v1/payments/${encodeURIComponent(paymentKey)}/cancel`, { cancelReason: reason }, `cancel-${orderId}`)
  };
}
