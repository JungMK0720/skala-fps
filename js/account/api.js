/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 로그인 연결·테스트 결제 API(server/api Worker)를 부르는 얇은 fetch 클라이언트. 주소는 SKALA_CONFIG.api.url이고 비어 있으면 꺼진다.
 *          어떤 실패든 예외 없이 { ok:false, reason:'network' }로 돌려주고, 서버가 답한 업무 오류 { ok:false, error }는 그대로 전달한다.
 *          쿠키를 보내지 않는다(credentials: 'omit'). 신원은 본문의 기기 토큰이다.
 */

export const API_TIMEOUT_MS = 10000;

/** 설정의 API 주소. https 주소(로컬 시험은 http://localhost·127.0.0.1)만 받고 끝의 /는 뗀다. 아니면 '' */
export function readApiUrl(config) {
  const c = config || (globalThis.SKALA_CONFIG && globalThis.SKALA_CONFIG.api) || {};
  const url = String(c.url || '').trim().replace(/\/+$/, '');
  if (/^https:\/\/[a-z0-9.-]+(:\d{1,5})?$/i.test(url)) return url;
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(url)) return url;
  return '';
}

/** opts: { fetch?, config?: { url }, timeoutMs? }. config를 주지 않으면 globalThis.SKALA_CONFIG.api를 읽는다 */
export function createApi({ fetch: fetchImpl, config, timeoutMs = API_TIMEOUT_MS } = {}) {
  const url = readApiUrl(config);
  const enabled = !!url;
  const send = fetchImpl || ((...args) => globalThis.fetch(...args));

  async function request(method, path, body) {
    if (!enabled) return { ok: false, reason: 'offline' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await send(url + path, {
        method,
        headers: body ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { Accept: 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        credentials: 'omit',
        cache: 'no-store',
        signal: controller.signal
      });
      let data = null;
      try { data = await res.json(); } catch (_) { data = null; }
      if (data && typeof data.ok === 'boolean') return data.ok ? data : { ...data, status: res.status };
      return { ok: false, reason: 'network', status: res.status };
    } catch (_) {
      return { ok: false, reason: 'network' };
    } finally {
      clearTimeout(timer);
    }
  }

  const post = (path) => (body) => request('POST', path, body);
  return {
    enabled,
    url,
    features: () => request('GET', '/features'),
    exchange: post('/auth/exchange'),
    link: post('/auth/link'),
    login: post('/auth/login'),
    logout: post('/auth/logout'),
    me: post('/me'),
    createOrder: post('/pay/orders'),
    cancelOrder: post('/pay/cancel'),
    buyWithCoins: post('/shop/coins')
  };
}
