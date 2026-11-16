/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: Supabase RPC 클라이언트(Worker 전용). supabase/schema.sql의 fps_api_* 함수를 Supabase 비밀 키(service_role)로 부른다.
 *          비밀 키(sb_secret_…)는 JWT가 아니라 apikey 헤더에만 넣고, 예전 service_role 키(JWT)는 Authorization에도 넣는다.
 *          어떤 실패든 예외 없이 { ok:false, error } 로 돌려준다: DB_OFF(설정 없음), DB_MISSING(404, schema.sql을 아직 실행하지 않음), DB_HTTP, DB_NETWORK, DB_SHAPE.
 */

export const DB_TIMEOUT_MS = 8000;

export function dbHeaders(key) {
  return key.startsWith('sb_') ? { apikey: key } : { apikey: key, authorization: `Bearer ${key}` };
}

export function createDb(env, fetchImpl) {
  const url = String(env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const key = String(env.SUPABASE_SECRET_KEY || '').trim();
  const enabled = !!(url && key);

  async function call(fn, args = {}) {
    if (!enabled) return { ok: false, error: 'DB_OFF' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DB_TIMEOUT_MS);
    try {
      const res = await fetchImpl(`${url}/rest/v1/rpc/${fn}`, {
        method: 'POST',
        headers: { ...dbHeaders(key), 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(args),
        signal: controller.signal
      });
      if (!res.ok) return { ok: false, error: res.status === 404 ? 'DB_MISSING' : 'DB_HTTP', status: res.status };
      const body = await res.json();
      return body && typeof body.ok === 'boolean' ? body : { ok: false, error: 'DB_SHAPE' };
    } catch (_) {
      return { ok: false, error: 'DB_NETWORK' };
    } finally {
      clearTimeout(timer);
    }
  }

  return { enabled, call };
}

/** DB가 아닌 우리 쪽 문제(연결·설정)인가. 이런 실패는 다시 시도하면 될 수 있다 */
export function isDbFault(r) {
  return !!r && r.ok === false && typeof r.error === 'string' && r.error.startsWith('DB_');
}
