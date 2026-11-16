/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 로그인 연결 API. /auth/exchange(인가 코드 → ID 토큰 검증 → 로그인 표), /auth/link(이 기기의 계정에 잇기), /auth/login(이은 계정으로
 *          이 기기에 로그인: 기기가 새로 만든 토큰을 더한다), /auth/logout(이 기기의 토큰을 끊는다), /me(이름·코인·이은 제공자·구매 내역).
 *          신원은 기기 토큰(64자 hex, 본문)으로 확인한다. 쿠키를 쓰지 않으므로 게임 주소와 Worker 주소가 달라도 된다.
 */
import { isDbFault } from './db.js';
import { json } from './http.js';
import { PROVIDERS, clientIdOf, enabledProviders, exchangeCode, readExchange, verifyIdToken } from './oauth.js';
import { TOKEN_RE, payConfig } from './pay.js';
import { signTicket, ticketReady, verifyTicket } from './ticket.js';

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const pass = (r) => json(r, isDbFault(r) ? 503 : 200);

export function loginReady(env) {
  return ticketReady(env.AUTH_SECRET) && enabledProviders(env).length > 0;
}

/** 게임: { provider, code, codeVerifier, redirectUri, nonce } → { ok, provider, ticket, linkedName } */
export async function exchange(body, ctx) {
  if (!ticketReady(ctx.env.AUTH_SECRET)) return json({ ok: false, error: 'LOGIN_OFF' }, 503);
  const provider = typeof body.provider === 'string' && hasOwn(PROVIDERS, body.provider) ? PROVIDERS[body.provider] : null;
  if (!provider || !enabledProviders(ctx.env).includes(provider)) return json({ ok: false, error: 'PROVIDER_OFF' }, 400);
  const req = readExchange(body, ctx.env.ALLOWED_ORIGINS);
  if (!req.ok) return json({ ok: false, error: 'BAD_REQUEST' }, 400);
  const ex = await exchangeCode(provider, req, ctx.env, ctx.fetch);
  if (!ex.ok) {
    ctx.log({ t: 'auth', step: 'exchange_failed', provider: provider.id, status: ex.status, reason: ex.reason });
    return json({ ok: false, error: ex.error });
  }
  const v = await verifyIdToken(ex.idToken, { provider, clientId: clientIdOf(provider, ctx.env), nonce: req.nonce }, ctx.fetch, ctx.now());
  if (!v.ok) {
    ctx.log({ t: 'auth', step: 'id_token_rejected', provider: provider.id, reason: v.reason });
    return json({ ok: false, error: v.error });
  }
  const owner = await ctx.db.call('fps_api_identity_owner', { p_provider: provider.id, p_subject: v.subject });
  if (!owner.ok) return json(owner, 503);
  const ticket = await signTicket({ provider: provider.id, subject: v.subject }, ctx.env.AUTH_SECRET, ctx.now());
  return json({ ok: true, provider: provider.id, ticket, linkedName: typeof owner.name === 'string' ? owner.name : null });
}

/** 게임: { ticket, token } → fps_api_link 결과 */
export async function link(body, ctx) {
  const t = await verifyTicket(body.ticket, ctx.env.AUTH_SECRET, ctx.now());
  if (!t.ok) return json(t);
  if (!TOKEN_RE.test(body.token || '')) return json({ ok: false, error: 'BAD_REQUEST' }, 400);
  const r = await ctx.db.call('fps_api_link', { p_token: body.token, p_provider: t.provider, p_subject: t.subject, p_jti: t.jti });
  if (r.ok && !r.already) ctx.log({ t: 'auth', step: 'linked', provider: t.provider });
  return pass(r);
}

/** 게임: { ticket, newToken } → fps_api_login 결과. 게임은 성공하면 이 기기의 토큰을 newToken으로 바꾼다 */
export async function login(body, ctx) {
  const t = await verifyTicket(body.ticket, ctx.env.AUTH_SECRET, ctx.now());
  if (!t.ok) return json(t);
  if (!TOKEN_RE.test(body.newToken || '')) return json({ ok: false, error: 'BAD_REQUEST' }, 400);
  const r = await ctx.db.call('fps_api_login', { p_provider: t.provider, p_subject: t.subject, p_new_token: body.newToken, p_jti: t.jti });
  if (r.ok) ctx.log({ t: 'auth', step: 'login', provider: t.provider });
  return pass(r);
}

/** 게임: { token } → fps_api_logout 결과 */
export async function logout(body, ctx) {
  if (!TOKEN_RE.test(body.token || '')) return json({ ok: false, error: 'BAD_REQUEST' }, 400);
  return pass(await ctx.db.call('fps_api_logout', { p_token: body.token }));
}

/** 게임: { token } → { ok, name, coins, providers, orders } */
export async function me(body, ctx) {
  if (!TOKEN_RE.test(body.token || '')) return json({ ok: false, error: 'BAD_REQUEST' }, 400);
  return pass(await ctx.db.call('fps_api_me', { p_token: body.token, p_refund_days: payConfig(ctx.env).refundDays }));
}
