/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 로그인 연결·테스트 결제 API(Cloudflare Worker, 무료 플랜) 입구. 주소를 나눠 auth.js·pay.js에 맡기고, 10분마다 대사(scheduled)를 돌린다.
 *          게임(브라우저)은 허용한 Origin에서 JSON으로 부르고, 토스는 결제 페이지·성공·실패 주소로 브라우저를 보내며 웹훅을 보낸다.
 *          Supabase는 비밀 키로 fps_api_* 함수만 부른다(db.js). 설정과 배포는 server/api/README.md.
 */
/*
 * 주소
 *   GET  /health, /                 { ok:true, service:'skala-api' }
 *   GET  /features                  { ok, db, login:{ providers:[{ id, name, authorizeUrl, clientId, scope, params }] },
 *                                     pay:{ enabled, test, reason, dailyLimit, refundDays, products:[{ id, name, coins, amount }] }, coins:{ enabled } }
 *   POST /auth/exchange             { provider, code, codeVerifier, redirectUri, nonce } → { ok, provider, ticket, linkedName }
 *   POST /auth/link                 { ticket, token }      → { ok, name, already? } | { ok:false, error, name? }
 *   POST /auth/login                { ticket, newToken }   → { ok, name } | { ok:false, error }
 *   POST /auth/logout               { token }              → { ok } | { ok:false, error:'NOT_LINKED' }
 *   POST /me                        { token }              → { ok, name, coins, providers, orders:[{ orderId, product, coins, amount, status, at, refundable }] }
 *   POST /pay/orders                { token, productId, returnUrl } → { ok, orderId, checkoutUrl, coins, amount }
 *   GET  /pay/checkout?order=       결제 페이지(HTML). /pay/checkout.js가 토스 결제창을 연다
 *   GET  /pay/success, /pay/fail/<orderId>  토스가 보낸 브라우저를 처리하고 게임 주소#skala-pay=…로 돌려보낸다
 *   POST /pay/webhook               토스 웹훅(PAYMENT_STATUS_CHANGED)
 *   POST /pay/cancel                { token, orderId }     → { ok, coins } | { ok:false, error }
 *   POST /shop/coins                { token, itemId }      → { ok, coins, spent, owned } | { ok:false, error }
 */
import * as auth from './auth.js';
import { createDb } from './db.js';
import { corsHeaders, json, originAllowed, readJson } from './http.js';
import { enabledProviders, publicProvider } from './oauth.js';
import * as pay from './pay.js';
import { createToss } from './toss.js';

const POST_ROUTES = Object.freeze({
  '/auth/exchange': auth.exchange,
  '/auth/link': auth.link,
  '/auth/login': auth.login,
  '/auth/logout': auth.logout,
  '/me': auth.me,
  '/pay/orders': pay.createOrder,
  '/pay/cancel': pay.cancelOrder,
  '/shop/coins': pay.buyWithCoins
});

const defaultLog = (line) => console.log(JSON.stringify(line));

/** deps: { fetch, now?, log? }. 바깥으로 나가는 요청(Supabase·토스·구글·카카오)은 모두 deps.fetch로 간다(시험에서 바꿔 끼운다) */
export function makeContext(env, deps, origin) {
  const fetchImpl = deps.fetch;
  return {
    env,
    origin,
    fetch: fetchImpl,
    now: deps.now || (() => Date.now()),
    log: deps.log || defaultLog,
    db: createDb(env, fetchImpl),
    toss: createToss(env, fetchImpl)
  };
}

let ping = { at: -Infinity, ok: false };   // schema.sql의 이 절을 실행한 서버인가(1분 동안 기억)

export function resetPingCache() {
  ping = { at: -Infinity, ok: false };
}

async function dbReady(ctx) {
  if (!ctx.db.enabled) return false;
  const now = ctx.now();
  if (now - ping.at < 60000) return ping.ok;
  const r = await ctx.db.call('fps_api_ping', {});
  ping = { at: now, ok: r.ok === true };
  return ping.ok;
}

async function features(ctx) {
  const ready = await dbReady(ctx);
  const cfg = pay.payConfig(ctx.env);
  const providers = ready && auth.loginReady(ctx.env) ? enabledProviders(ctx.env).map((p) => publicProvider(p, ctx.env)) : [];
  return json({
    ok: true,
    service: 'skala-api',
    db: ready,
    login: { providers },
    pay: {
      enabled: ready && cfg.enabled,
      test: !!cfg.test,
      reason: !ready ? 'db' : cfg.enabled ? null : cfg.reason,
      dailyLimit: cfg.dailyLimit,
      refundDays: cfg.refundDays,
      products: pay.PRODUCT_LIST
    },
    coins: { enabled: ready }
  });
}

export async function route(request, env, deps) {
  const url = new URL(request.url);
  const origin = request.headers.get('Origin');
  const cors = corsHeaders(origin, env.ALLOWED_ORIGINS);
  const withCors = (res) => {
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    return res;
  };
  const ctx = makeContext(env, deps, url.origin);
  try {
    if (request.method === 'OPTIONS') {
      if (!origin || !originAllowed(origin, env.ALLOWED_ORIGINS)) return json({ ok: false, error: 'origin_not_allowed' }, 403);
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method === 'GET') {
      switch (url.pathname) {
        case '/':
        case '/health': return withCors(json({ ok: true, service: 'skala-api' }));
        case '/features': return withCors(await features(ctx));
        case '/pay/checkout': return await pay.checkoutPage(url, ctx);
        case '/pay/checkout.js': return pay.checkoutScript();
        case '/pay/success': return await pay.success(url, ctx);
        case '/pay/fail': return await pay.fail(url, ctx);
        default:
          if (/^\/pay\/fail\/[^/]+$/.test(url.pathname)) return await pay.fail(url, ctx);
          return withCors(json({ ok: false, error: 'not_found' }, 404));
      }
    }
    if (request.method === 'POST') {
      if (url.pathname === '/pay/webhook') return await pay.webhook(request, ctx);
      const handler = Object.prototype.hasOwnProperty.call(POST_ROUTES, url.pathname) ? POST_ROUTES[url.pathname] : null;
      if (!handler) return withCors(json({ ok: false, error: 'not_found' }, 404));
      if (!originAllowed(origin, env.ALLOWED_ORIGINS)) return json({ ok: false, error: 'origin_not_allowed' }, 403);
      const body = await readJson(request);
      if (!body) return withCors(json({ ok: false, error: 'BAD_REQUEST' }, 400));
      return withCors(await handler(body, ctx));
    }
    return withCors(json({ ok: false, error: 'method_not_allowed' }, 405));
  } catch (err) {
    ctx.log({ t: 'error', path: url.pathname, message: String((err && err.message) || err).slice(0, 200) });
    return withCors(json({ ok: false, error: 'INTERNAL' }, 500));
  }
}

export default {
  fetch(request, env) {
    return route(request, env, { fetch: (input, init) => fetch(input, init) });
  },
  scheduled(_event, env, ctx) {
    ctx.waitUntil(pay.reconcile(makeContext(env, { fetch: (input, init) => fetch(input, init) }, '')));
  }
};
