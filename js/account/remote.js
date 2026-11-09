/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: Supabase RPC를 부르는 얇은 fetch 클라이언트. 어떤 실패든 { ok:false, reason:'network' }로 돌려주고 예외를 던지지 않는다.
 *          서버가 답한 업무 오류 { ok:false, error }는 그대로 전달한다. 설정 방법은 docs/SUPABASE_SETUP.md.
 */

export const RPC_TIMEOUT_MS = 6000;

function readConfig(config) {
  const c = config || (globalThis.SKALA_CONFIG && globalThis.SKALA_CONFIG.supabase) || {};
  return {
    url: String(c.url || '').trim().replace(/\/+$/, ''),
    key: String(c.anonKey || '').trim()
  };
}

/**
 * Publishable key(sb_...)는 JWT가 아니므로 apikey 헤더에만 넣는다(Supabase API keys 문서의 Known limitations).
 * 예전 anon key는 JWT라서 Authorization에도 함께 넣는다.
 */
export function authHeaders(key) {
  return key.startsWith('sb_') ? { apikey: key } : { apikey: key, Authorization: `Bearer ${key}` };
}

/** opts: { fetch?, config?: { url, anonKey }, timeoutMs? }. config를 주지 않으면 globalThis.SKALA_CONFIG.supabase를 읽는다. */
export function createRemote({ fetch: fetchImpl, config, timeoutMs = RPC_TIMEOUT_MS } = {}) {
  const { url, key } = readConfig(config);
  const enabled = !!(url && key);
  const send = fetchImpl || ((...args) => globalThis.fetch(...args));
  let warned = false;

  /** quiet: HTTP 오류여도 경고를 남기지 않는다(옛 서버에 없는 함수를 물어볼 때 404는 정상이다) */
  async function call(fn, args = {}, { keepalive = false, quiet = false } = {}) {
    if (!enabled) return { ok: false, reason: 'network' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await send(`${url}/rest/v1/rpc/${fn}`, {
        method: 'POST',
        headers: { ...authHeaders(key), 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(args),
        signal: controller.signal,
        keepalive
      });
      if (!res.ok) {
        // 키가 틀렸거나 schema.sql을 실행하지 않은 경우. 게임은 오프라인으로 계속되니 원인을 한 번만 남긴다.
        if (!warned && !quiet) {
          warned = true;
          console.warn(`[account] Supabase RPC ${fn} 실패: HTTP ${res.status}. docs/SUPABASE_SETUP.md의 문제 해결을 확인하세요.`);
        }
        return { ok: false, reason: 'network', status: res.status };
      }
      const body = await res.json();
      return body && typeof body.ok === 'boolean' ? body : { ok: false, reason: 'network' };
    } catch (_) {
      return { ok: false, reason: 'network' };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    enabled,
    call,
    checkNickname: (name) => call('fps_check_nickname', { p_name: name }),
    claimNickname: (token, name) => call('fps_claim_nickname', { p_token: token, p_name: name }),
    getProfile: (token) => call('fps_get_profile', { p_token: token }),
    saveProfile: (token, profile, opts) => call('fps_save_profile', {
      p_token: token,
      p_points: profile.points,
      p_owned: profile.owned,
      p_loadout: profile.loadout,
      p_stats: profile.stats,
      p_secrets: profile.secrets
    }, opts),
    topPlayers: (limit) => call('fps_top_players', { p_limit: limit }),
    /** 서버가 아는 기능 { ok:true, avatars:true }. schema.sql을 다시 실행하기 전의 서버는 404(PGRST202)라 { ok:false, status:404 } */
    features: () => call('fps_features', {}, { quiet: true })
  };
}
