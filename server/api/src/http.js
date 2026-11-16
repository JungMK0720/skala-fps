/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: API Worker의 HTTP 도우미. JSON 응답, 브라우저 Origin 허용 목록과 CORS, 크기를 제한한 JSON 본문 읽기, 되돌아갈 주소 검사, HTML 이스케이프.
 *          Origin 규칙은 중계 서버(server/relay/src/rules.js originAllowed)와 같다: 목록의 ':*'는 모든 포트, Origin이 없으면(브라우저가 아님) 통과.
 */

export const BODY_LIMIT = 8192;   // 요청 본문 상한(바이트). 인가 코드·티켓을 넣어도 2 KB를 넘지 않는다

/** Origin이 허용 목록에 있는가. 없으면(서버 간 호출, curl) true */
export function originAllowed(origin, list) {
  if (!origin) return true;
  for (const raw of String(list || '').split(',')) {
    const entry = raw.trim();
    if (!entry) continue;
    if (entry === origin) return true;
    if (entry.endsWith(':*')) {
      const base = entry.slice(0, -1);
      if (origin.startsWith(base) && /^\d{1,5}$/.test(origin.slice(base.length))) return true;
    }
  }
  return false;
}

/** 허용한 Origin에만 붙이는 CORS 헤더. 쿠키는 쓰지 않으므로 credentials를 열지 않는다 */
export function corsHeaders(origin, list) {
  if (!origin || !originAllowed(origin, list)) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '600',
    vary: 'Origin'
  };
}

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }
  });
}

/** 다른 페이지로 보낸다(결제 결과). 303이라 POST였더라도 GET으로 간다 */
export function redirect(location, status = 303) {
  return new Response(null, { status, headers: { location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
}

/** JSON 본문을 읽는다. 너무 크거나 깨졌거나 객체가 아니면 null */
export async function readJson(request, limit = BODY_LIMIT) {
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > limit) return null;
  let text;
  try {
    text = await request.text();
  } catch (_) {
    return null;
  }
  if (text.length > limit) return null;
  try {
    const body = JSON.parse(text);
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  } catch (_) {
    return null;
  }
}

/**
 * 결제가 끝난 뒤 돌아갈 게임 주소. 절대 주소이고, 허용한 Origin이며, http는 localhost·127.0.0.1만 된다. 해시(#…)는 떼고 돌려준다.
 * 아니면 null(다른 사이트로 보내는 데 쓰이지 않게)
 */
export function cleanReturnUrl(raw, list) {
  if (typeof raw !== 'string' || raw.length > 512) return null;
  let u;
  try {
    u = new URL(raw);
  } catch (_) {
    return null;
  }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return null;
  if (u.username || u.password) return null;
  if (!originAllowed(u.origin, list)) return null;
  u.hash = '';
  return u.toString();
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** HTML 본문·속성에 넣을 글자 */
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
}

/** 숫자 금액을 "1,000원"으로 */
export function won(amount) {
  return `${Number(amount || 0).toLocaleString('ko-KR')}원`;
}
