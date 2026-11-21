/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 로그인 연결·테스트 결제 API Worker(server/api)를 시험한다. 바깥 요청(Supabase·토스·구글·카카오)은 가짜 fetch로 바꿔 끼우고,
 *          DB는 schema.sql의 fps_api_* 함수를 흉내 낸 메모리 모델로 둔다. PKCE·로그인 표·ID 토큰 검증, 주소별 처리,
 *          결제(주문 → 결제 페이지 → 금액 대조 → 승인 → 코인), 실패·결과를 모르는 승인·웹훅·환불·대사를 본다.
 */
import { before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { route, resetPingCache } from '../server/api/src/worker.js';
import { b64urlEncode, b64urlJson, basicAuth, sha256B64url } from '../server/api/src/crypto.js';
import { signTicket, verifyTicket } from '../server/api/src/ticket.js';
import { PROVIDERS, resetJwksCache, verifyIdToken } from '../server/api/src/oauth.js';
import { cleanReturnUrl, escapeHtml, originAllowed } from '../server/api/src/http.js';
import { PRODUCTS, payConfig, resultUrl } from '../server/api/src/pay.js';
import { PAGE_CSP } from '../server/api/src/pages.js';

const enc = new TextEncoder();
const GAME = 'https://game.test';
const RETURN = `${GAME}/skala-fps/`;
const API = 'https://api.test';
const SUPA = 'https://db.test';
const SECRET = 's'.repeat(40);
const T1 = 'a'.repeat(64);   // 기기 토큰(닉네임 등록됨)
const T2 = 'b'.repeat(64);   // 새 기기가 만든 토큰
const ENV = Object.freeze({
  ALLOWED_ORIGINS: `${GAME},http://localhost:*`,
  SUPABASE_URL: SUPA,
  SUPABASE_SECRET_KEY: 'sb_secret_test',
  AUTH_SECRET: SECRET,
  GOOGLE_CLIENT_ID: 'gid.apps.test',
  GOOGLE_CLIENT_SECRET: 'g-secret',
  KAKAO_CLIENT_ID: 'kakao-rest-key',
  TOSS_CLIENT_KEY: 'test_ck_client',
  TOSS_SECRET_KEY: 'test_sk_secret',
  PAY_DAILY_LIMIT: '3',
  REFUND_DAYS: '7'
});

const res = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// ───────────── RSA 열쇠와 ID 토큰 ─────────────
let rsa;
let other;
let jwks;
before(async () => {
  const algo = { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' };
  rsa = await crypto.subtle.generateKey(algo, true, ['sign', 'verify']);
  other = await crypto.subtle.generateKey(algo, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', rsa.publicKey);
  jwks = { keys: [{ kty: 'RSA', n: jwk.n, e: jwk.e, kid: 'k1', alg: 'RS256', use: 'sig' }] };
});

async function signJwt(claims, { kid = 'k1', key = rsa.privateKey, alg = 'RS256' } = {}) {
  const head = b64urlJson({ alg, kid, typ: 'JWT' });
  const body = b64urlJson(claims);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(`${head}.${body}`));
  return `${head}.${body}.${b64urlEncode(new Uint8Array(sig))}`;
}

const nowSec = () => Math.floor(Date.now() / 1000);
const googleClaims = (over = {}) => ({
  iss: 'https://accounts.google.com', aud: ENV.GOOGLE_CLIENT_ID, sub: 'google-user-1', iat: nowSec(), exp: nowSec() + 3600,
  nonce: 'n'.repeat(24), ...over
});

// ───────────── 가짜 DB(fps_api_*) ─────────────
function fakeDb() {
  const db = { up: true, calls: [], players: new Map(), tokens: new Map(), ids: new Map(), used: new Set(), orders: new Map(), ledger: [] };
  let seq = 0;
  db.addPlayer = (name, token, coins = 0) => {
    seq += 1;
    db.players.set(seq, { id: seq, name, coins, owned: [] });
    db.tokens.set(token, seq);
    return seq;
  };
  const who = (token) => (db.tokens.has(token) ? db.players.get(db.tokens.get(token)) : null);
  const once = (jti) => (db.used.has(jti) ? false : (db.used.add(jti), true));
  const credit = (p, delta, reason, order, item) => {
    p.coins += delta;
    db.ledger.push({ player: p.id, delta, balance: p.coins, reason, order, item });
  };
  const fns = {
    fps_api_ping: () => ({ ok: true, v: 1 }),
    fps_api_identity_owner: ({ p_provider, p_subject }) => {
      const id = db.ids.get(`${p_provider}:${p_subject}`);
      return { ok: true, name: id ? db.players.get(id).name : null };
    },
    fps_api_link: ({ p_token, p_provider, p_subject, p_jti }) => {
      const p = who(p_token);
      if (!p) return { ok: false, error: 'NOT_FOUND' };
      const key = `${p_provider}:${p_subject}`;
      if (db.ids.has(key)) return db.ids.get(key) === p.id ? { ok: true, name: p.name, already: true } : { ok: false, error: 'IDENTITY_TAKEN', name: db.players.get(db.ids.get(key)).name };
      if (!once(p_jti)) return { ok: false, error: 'TICKET_USED' };
      db.ids.set(key, p.id);
      return { ok: true, name: p.name };
    },
    fps_api_login: ({ p_provider, p_subject, p_new_token, p_jti }) => {
      const id = db.ids.get(`${p_provider}:${p_subject}`);
      if (!id) return { ok: false, error: 'NOT_LINKED' };
      if (db.tokens.has(p_new_token)) return { ok: false, error: 'TOKEN_TAKEN' };
      if (!once(p_jti)) return { ok: false, error: 'TICKET_USED' };
      db.tokens.set(p_new_token, id);
      return { ok: true, name: db.players.get(id).name };
    },
    fps_api_logout: ({ p_token }) => {
      if (!db.tokens.has(p_token)) return { ok: true, already: true };
      db.tokens.delete(p_token);
      return { ok: true };
    },
    fps_api_me: ({ p_token }) => {
      const p = who(p_token);
      if (!p) return { ok: false, error: 'NOT_FOUND' };
      const providers = [...db.ids.entries()].filter(([, id]) => id === p.id).map(([k]) => k.split(':')[0]);
      const orders = [...db.orders.values()].filter((o) => o.player === p.id && o.status !== 'READY')
        .map((o) => ({ orderId: o.orderId, coins: o.coins, amount: o.amount, status: o.status, refundable: o.status === 'DONE' && p.coins >= o.coins }));
      return { ok: true, name: p.name, coins: p.coins, providers, orders };
    },
    fps_api_create_order: ({ p_token, p_order_id, p_product, p_coins, p_amount, p_return_url, p_daily_limit }) => {
      const p = who(p_token);
      if (!p) return { ok: false, error: 'NOT_FOUND' };
      const done = [...db.orders.values()].filter((o) => o.player === p.id && ['CONFIRMING', 'DONE', 'CANCELING'].includes(o.status)).length;
      if (done >= p_daily_limit) return { ok: false, error: 'DAILY_LIMIT', limit: p_daily_limit };
      db.orders.set(p_order_id, { orderId: p_order_id, player: p.id, product: p_product, coins: p_coins, amount: p_amount, status: 'READY', paymentKey: null, returnUrl: p_return_url, ageSec: 5, idleSec: 0 });
      return { ok: true, orderId: p_order_id, name: p.name };
    },
    fps_api_order: ({ p_order_id }) => {
      const o = db.orders.get(p_order_id);
      return o ? { ok: true, order: { ...o, name: db.players.get(o.player).name } } : { ok: false, error: 'NOT_FOUND' };
    },
    fps_api_mark_confirming: ({ p_order_id, p_payment_key, p_amount }) => {
      const o = db.orders.get(p_order_id);
      if (!o) return { ok: false, error: 'NOT_FOUND' };
      if (o.amount !== p_amount) return { ok: false, error: 'AMOUNT_MISMATCH' };
      if (o.status === 'READY') {
        Object.assign(o, { status: 'CONFIRMING', paymentKey: p_payment_key });
        return { ok: true, status: 'CONFIRMING' };
      }
      if (o.paymentKey === p_payment_key && ['CONFIRMING', 'DONE'].includes(o.status)) return { ok: true, status: o.status };
      return { ok: false, error: 'ORDER_STATE', status: o.status };
    },
    fps_api_complete_order: ({ p_order_id, p_payment_key, p_amount }) => {
      const o = db.orders.get(p_order_id);
      if (!o) return { ok: false, error: 'NOT_FOUND' };
      if (o.amount !== p_amount) return { ok: false, error: 'AMOUNT_MISMATCH' };
      if (o.paymentKey && o.paymentKey !== p_payment_key) return { ok: false, error: 'ORDER_STATE' };
      const p = db.players.get(o.player);
      if (['DONE', 'CANCELING', 'CANCELED'].includes(o.status)) return { ok: true, already: true, status: o.status, coins: p.coins };
      credit(p, o.coins, 'purchase', o.orderId);
      Object.assign(o, { status: 'DONE', paymentKey: p_payment_key });
      return { ok: true, status: 'DONE', coins: p.coins, added: o.coins };
    },
    fps_api_fail_order: ({ p_order_id, p_code }) => {
      const o = db.orders.get(p_order_id);
      if (!o || !['READY', 'CONFIRMING'].includes(o.status)) return { ok: true, changed: false };
      Object.assign(o, { status: p_code === 'EXPIRED' ? 'EXPIRED' : 'FAILED', failCode: p_code });
      return { ok: true, changed: true };
    },
    fps_api_begin_cancel: ({ p_token, p_order_id }) => {
      const p = who(p_token);
      const o = db.orders.get(p_order_id);
      if (!p || !o || o.player !== p.id) return { ok: false, error: 'NOT_FOUND' };
      if (o.status !== 'DONE') return { ok: false, error: 'ORDER_STATE', status: o.status };
      if (p.coins < o.coins) return { ok: false, error: 'COINS_SPENT', coins: p.coins };
      credit(p, -o.coins, 'refund', o.orderId);
      o.status = 'CANCELING';
      return { ok: true, paymentKey: o.paymentKey, amount: o.amount, coins: p.coins };
    },
    fps_api_end_cancel: ({ p_order_id, p_ok }) => {
      const o = db.orders.get(p_order_id);
      const p = db.players.get(o.player);
      if (o.status !== 'CANCELING') return o.status === 'CANCELED' && p_ok ? { ok: true, already: true } : { ok: false, error: 'ORDER_STATE' };
      if (p_ok) {
        o.status = 'CANCELED';
        return { ok: true, status: 'CANCELED', coins: p.coins };
      }
      credit(p, o.coins, 'refund_undo', o.orderId);
      o.status = 'DONE';
      return { ok: true, status: 'DONE', coins: p.coins };
    },
    fps_api_external_cancel: ({ p_order_id }) => {
      const o = db.orders.get(p_order_id);
      const p = db.players.get(o.player);
      if (o.status === 'DONE') {
        const take = Math.min(p.coins, o.coins);
        if (take) credit(p, -take, 'refund', o.orderId);
        o.status = 'CANCELED';
        return { ok: true, status: 'CANCELED', taken: take };
      }
      if (o.status === 'CANCELING') o.status = 'CANCELED';
      return { ok: true, status: o.status };
    },
    fps_api_buy_with_coins: ({ p_token, p_item }) => {
      const p = who(p_token);
      if (!p) return { ok: false, error: 'NOT_FOUND' };
      const price = { av_scout: 30, selfie: 40 }[p_item];
      if (!price) return { ok: false, error: 'ITEM_INVALID' };
      if (p.owned.includes(p_item)) return { ok: false, error: 'OWNED' };
      if (p.coins < price) return { ok: false, error: 'COINS_SHORT', coins: p.coins, price };
      credit(p, -price, 'spend', null, p_item);
      p.owned.push(p_item);
      return { ok: true, coins: p.coins, spent: price, owned: [...p.owned] };
    },
    fps_api_open_orders: () => ({
      ok: true,
      orders: [...db.orders.values()].filter((o) => ['CONFIRMING', 'CANCELING'].includes(o.status))
        .map((o) => ({ orderId: o.orderId, status: o.status, paymentKey: o.paymentKey, amount: o.amount, idleSec: o.idleSec }))
    })
  };
  db.handle = async (fn, init) => {
    if (!db.up) throw new TypeError('db down');
    if (!fns[fn]) return res({ code: 'PGRST202' }, 404);
    const args = JSON.parse(init.body);
    db.calls.push({ fn, args, headers: init.headers });
    return res(fns[fn](args));
  };
  db.count = (fn) => db.calls.filter((c) => c.fn === fn).length;
  return db;
}

// ───────────── 가짜 토스 ─────────────
function fakeToss() {
  const t = { calls: [], payments: new Map(), confirmMode: 'ok', cancelMode: 'ok' };
  t.handle = async (url, init) => {
    t.calls.push({ method: init.method || 'GET', path: url.pathname, headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
    const parts = url.pathname.split('/');
    if (url.pathname === '/v1/payments/confirm') {
      const { paymentKey, orderId, amount } = JSON.parse(init.body);
      if (t.confirmMode === 'reject') return res({ code: 'REJECT_CARD_COMPANY', message: '카드사에서 거절했어요' }, 403);
      const payment = { paymentKey, orderId, status: 'DONE', totalAmount: amount, method: '카드' };
      t.payments.set(paymentKey, payment);
      if (t.confirmMode === 'network') throw new TypeError('connection reset');   // 토스는 처리했지만 응답을 못 받았다
      if (t.confirmMode === 'garbage') return new Response('<html>gateway</html>', { status: 200 });   // 2xx인데 본문을 읽을 수 없다
      return res(payment);
    }
    if (parts.length === 5 && parts[4] === 'cancel') {
      const p = t.payments.get(decodeURIComponent(parts[3]));
      if (t.cancelMode === 'reject') return res({ code: 'NOT_CANCELABLE_PAYMENT', message: '취소할 수 없어요' }, 403);
      p.status = 'CANCELED';
      return res(p);
    }
    if (parts.length === 4 && (init.method || 'GET') === 'GET') {
      const p = t.payments.get(decodeURIComponent(parts[3]));
      return p ? res(p) : res({ code: 'NOT_FOUND_PAYMENT' }, 404);
    }
    return res({ code: 'UNEXPECTED' }, 500);
  };
  return t;
}

// ───────────── 가짜 구글 ─────────────
function fakeGoogle() {
  const g = { tokenCalls: [], jwksCalls: 0, idToken: null };
  g.handle = async (url, init) => {
    if (url.href === PROVIDERS.google.jwksUrl) {
      g.jwksCalls += 1;
      return res(jwks);
    }
    if (url.href === PROVIDERS.google.tokenUrl) {
      g.tokenCalls.push(Object.fromEntries(new URLSearchParams(init.body)));
      return g.idToken ? res({ access_token: 'at', id_token: g.idToken, token_type: 'Bearer' }) : res({ error: 'invalid_grant' }, 400);
    }
    return null;
  };
  return g;
}

function world(envOver = {}) {
  const w = { db: fakeDb(), toss: fakeToss(), google: fakeGoogle(), logs: [], env: { ...ENV, ...envOver } };
  w.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.origin === SUPA) return w.db.handle(url.pathname.split('/').pop(), init);
    if (url.origin === 'https://api.tosspayments.com') return w.toss.handle(url, init);
    const g = await w.google.handle(url, init);
    if (g) return g;
    throw new Error(`예상하지 못한 요청: ${url.href}`);
  };
  w.call = (method, path, { body, origin = GAME, headers = {} } = {}) => {
    const h = { ...headers };
    if (origin) h.Origin = origin;
    if (body !== undefined) h['content-type'] = 'application/json';
    const req = new Request(API + path, { method, headers: h, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    return route(req, w.env, { fetch: w.fetch, log: (line) => w.logs.push(line) });
  };
  w.post = async (path, body, opts) => {
    const r = await w.call('POST', path, { ...opts, body });
    return { status: r.status, body: await r.json(), headers: r.headers };
  };
  return w;
}

beforeEach(() => {
  resetPingCache();
  resetJwksCache();
});

// ─────────────────────────────── 부품 ───────────────────────────────
describe('부품: PKCE·로그인 표·HTTP 도우미', () => {
  test('PKCE S256: RFC 7636 부록 B의 예와 같다', async () => {
    assert.equal(await sha256B64url('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  test('로그인 표: 서명을 확인하고, 고치거나 시간이 지나면 거절한다', async () => {
    const now = Date.now();
    const t = await signTicket({ provider: 'google', subject: 'u1' }, SECRET, now);
    const ok = await verifyTicket(t, SECRET, now);
    assert.equal(ok.ok, true);
    assert.equal(ok.subject, 'u1');
    assert.match(ok.jti, /^[0-9a-f]{32}$/);
    const [payload, sig] = t.split('.');
    const forged = b64urlJson({ p: 'google', s: 'someone-else', exp: nowSec() + 600, jti: ok.jti });
    assert.equal((await verifyTicket(`${forged}.${sig}`, SECRET, now)).error, 'TICKET_INVALID');
    assert.equal((await verifyTicket(`${payload}.${sig}`, 'x'.repeat(40), now)).error, 'TICKET_INVALID', '다른 비밀 값');
    assert.equal((await verifyTicket(t, SECRET, now + 601000)).error, 'TICKET_EXPIRED');
    assert.equal((await verifyTicket('garbage', SECRET, now)).ok, false);
    await assert.rejects(() => signTicket({ provider: 'google', subject: 'u1' }, 'short', now));
  });

  test('Origin·되돌아갈 주소·HTML 이스케이프', () => {
    assert.ok(originAllowed(GAME, ENV.ALLOWED_ORIGINS));
    assert.ok(originAllowed('http://localhost:8080', ENV.ALLOWED_ORIGINS));
    assert.ok(!originAllowed('https://evil.test', ENV.ALLOWED_ORIGINS));
    assert.ok(!originAllowed('http://localhost:80a', ENV.ALLOWED_ORIGINS));
    const portal = 'https://*.game-files.crazygames.com';
    assert.ok(originAllowed('https://skala-ops.game-files.crazygames.com', portal), 'CrazyGames 게임 파일 하위 도메인');
    assert.ok(!originAllowed('https://game-files.crazygames.com.evil.test', portal));
    assert.ok(!originAllowed('http://skala-ops.game-files.crazygames.com', portal));
    assert.equal(cleanReturnUrl(`${RETURN}#old`, ENV.ALLOWED_ORIGINS), RETURN, '해시는 뗀다');
    assert.equal(cleanReturnUrl('https://evil.test/', ENV.ALLOWED_ORIGINS), null);
    assert.equal(cleanReturnUrl('http://game.test/', 'http://game.test'), null, 'http는 로컬만');
    assert.equal(cleanReturnUrl('javascript:alert(1)', ENV.ALLOWED_ORIGINS), null);
    assert.equal(escapeHtml(`<a href="x">'&`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
    assert.equal(basicAuth('test_sk_abc'), `Basic ${Buffer.from('test_sk_abc:').toString('base64')}`);
  });

  test('결제 설정: 두 키가 같은 환경이어야 켜고, 라이브 키는 PAY_ALLOW_LIVE 없이는 끈다', () => {
    assert.equal(payConfig(ENV).enabled, true);
    assert.equal(payConfig(ENV).test, true);
    assert.equal(payConfig({ ...ENV, TOSS_SECRET_KEY: '' }).reason, 'keys');
    assert.equal(payConfig({ ...ENV, TOSS_SECRET_KEY: 'live_sk_x' }).reason, 'key_mismatch');
    assert.equal(payConfig({ ...ENV, TOSS_CLIENT_KEY: 'live_ck_x', TOSS_SECRET_KEY: 'live_sk_x' }).reason, 'live_key');
    assert.equal(payConfig({ ...ENV, TOSS_CLIENT_KEY: 'live_ck_x', TOSS_SECRET_KEY: 'live_sk_x', PAY_ALLOW_LIVE: 'true' }).enabled, true);
    assert.equal(payConfig({ ...ENV, PAY_DAILY_LIMIT: 'lots' }).dailyLimit, 3, '잘못된 값은 기본값');
    assert.equal(resultUrl(RETURN, { kind: 'done', order: 'skala_x', coins: 100 }), `${RETURN}#skala-pay=done&order=skala_x&coins=100`);
  });
});

describe('ID 토큰 검증', () => {
  const opts = () => ({ provider: PROVIDERS.google, clientId: ENV.GOOGLE_CLIENT_ID, nonce: 'n'.repeat(24) });
  const fetchJwks = async () => res(jwks);

  test('서명·발급자·대상·만료·nonce가 맞으면 sub를 돌려준다', async () => {
    const r = await verifyIdToken(await signJwt(googleClaims()), opts(), fetchJwks);
    assert.deepEqual(r, { ok: true, subject: 'google-user-1' });
  });

  test('하나라도 틀리면 거절한다', async () => {
    const cases = [
      [googleClaims({ aud: 'someone-else' }), 'aud'],
      [googleClaims({ iss: 'https://evil.test' }), 'iss'],
      [googleClaims({ exp: nowSec() - 600 }), 'exp'],
      [googleClaims({ nonce: 'm'.repeat(24) }), 'nonce'],
      [googleClaims({ sub: '' }), 'sub']
    ];
    for (const [claims, reason] of cases) {
      const r = await verifyIdToken(await signJwt(claims), opts(), fetchJwks);
      assert.equal(r.reason, reason, reason);
    }
    assert.equal((await verifyIdToken(await signJwt(googleClaims(), { key: other.privateKey }), opts(), fetchJwks)).reason, 'signature');
    assert.equal((await verifyIdToken(await signJwt(googleClaims(), { alg: 'HS256' }), opts(), fetchJwks)).reason, 'alg');
    assert.equal((await verifyIdToken('a.b', opts(), fetchJwks)).reason, 'shape');
  });

  test('모르는 kid면 JWKS를 다시 받되 1분에 한 번까지만', async () => {
    let calls = 0;
    const counting = async () => { calls += 1; return res(jwks); };
    const t0 = Date.now();
    await verifyIdToken(await signJwt(googleClaims()), opts(), counting, t0);
    const unknown = await signJwt(googleClaims(), { kid: 'k9' });
    assert.equal((await verifyIdToken(unknown, opts(), counting, t0 + 1000)).reason, 'kid');
    assert.equal(calls, 1, '1분 안에는 다시 받지 않는다');
    await verifyIdToken(unknown, opts(), counting, t0 + 61000);
    assert.equal(calls, 2);
  });
});

// ─────────────────────────────── 주소 ───────────────────────────────
describe('주소와 CORS', () => {
  test('/features: 설정이 없으면 모두 닫고, 다 있으면 제공자·상품을 알린다', async () => {
    const empty = world({ SUPABASE_SECRET_KEY: '', TOSS_CLIENT_KEY: '', GOOGLE_CLIENT_ID: '', KAKAO_CLIENT_ID: '' });
    const off = await (await empty.call('GET', '/features')).json();
    assert.equal(off.db, false);
    assert.deepEqual(off.login.providers, []);
    assert.equal(off.pay.enabled, false);
    assert.equal(off.pay.reason, 'db');

    const w = world();
    const r = await w.call('GET', '/features');
    assert.equal(r.headers.get('access-control-allow-origin'), GAME);
    const on = await r.json();
    assert.deepEqual(on.login.providers.map((p) => p.id), ['google', 'kakao']);
    const google = on.login.providers[0];
    assert.equal(google.clientId, ENV.GOOGLE_CLIENT_ID);
    assert.equal(google.scope, 'openid');
    assert.ok(!JSON.stringify(on).includes(ENV.GOOGLE_CLIENT_SECRET), 'secret은 내보내지 않는다');
    assert.ok(!JSON.stringify(on).includes(ENV.TOSS_SECRET_KEY));
    assert.equal(on.pay.enabled, true);
    assert.equal(on.pay.test, true);
    assert.deepEqual(on.pay.products.map((p) => [p.id, p.coins, p.amount]), [['coin_100', 100, 1000], ['coin_550', 550, 5000]]);
  });

  test('구글 secret이 없으면 구글은 빠지고, schema.sql을 실행하지 않은 서버(404)면 닫는다', async () => {
    const w = world({ GOOGLE_CLIENT_SECRET: '' });
    const f = await (await w.call('GET', '/features')).json();
    assert.deepEqual(f.login.providers.map((p) => p.id), ['kakao']);
    resetPingCache();
    const old = world();
    old.db.handle = async () => res({ code: 'PGRST202' }, 404);
    const g = await (await old.call('GET', '/features')).json();
    assert.equal(g.db, false);
    assert.equal(g.pay.enabled, false);
  });

  test('허용한 Origin만 CORS를 열고 다른 Origin의 POST는 막는다', async () => {
    const w = world();
    const pre = await w.call('OPTIONS', '/me', { headers: { 'Access-Control-Request-Method': 'POST' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), GAME);
    assert.equal((await w.call('OPTIONS', '/me', { origin: 'https://evil.test' })).status, 403);
    assert.equal((await w.post('/me', { token: T1 }, { origin: 'https://evil.test' })).status, 403);
    assert.equal((await w.post('/me', 'not json')).status, 400);
    assert.equal((await w.post('/nope', {})).status, 404);
  });
});

describe('로그인 연결', () => {
  const nonce = 'n'.repeat(24);
  const exchangeBody = (over = {}) => ({
    provider: 'google', code: '4/abc-code', codeVerifier: 'v'.repeat(43), redirectUri: RETURN, nonce, ...over
  });

  test('인가 코드를 secret·verifier와 함께 바꾸고, ID 토큰을 검증해 로그인 표를 준다', async () => {
    const w = world();
    w.google.idToken = await signJwt(googleClaims());
    const r = await w.post('/auth/exchange', exchangeBody());
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
    assert.equal(r.body.linkedName, null);
    assert.ok(r.body.ticket);
    const sent = w.google.tokenCalls[0];
    assert.equal(sent.grant_type, 'authorization_code');
    assert.equal(sent.client_secret, ENV.GOOGLE_CLIENT_SECRET);
    assert.equal(sent.code_verifier, 'v'.repeat(43));
    assert.equal(sent.redirect_uri, RETURN);
    assert.deepEqual(Object.keys(r.body).sort(), ['linkedName', 'ok', 'provider', 'ticket'], '액세스 토큰·ID 토큰은 돌려주지 않는다');
  });

  test('다른 Origin의 redirect_uri·짧은 verifier·꺼진 제공자는 받지 않는다', async () => {
    const w = world({ KAKAO_CLIENT_ID: '' });
    assert.equal((await w.post('/auth/exchange', exchangeBody({ redirectUri: 'https://evil.test/' }))).status, 400);
    assert.equal((await w.post('/auth/exchange', exchangeBody({ codeVerifier: 'short' }))).status, 400);
    assert.equal((await w.post('/auth/exchange', exchangeBody({ provider: 'kakao' }))).body.error, 'PROVIDER_OFF');
    assert.equal(w.google.tokenCalls.length, 0, '구글에 묻지도 않는다');
  });

  test('nonce가 다른 ID 토큰은 거절한다(다른 요청의 토큰을 다시 쓰지 못한다)', async () => {
    const w = world();
    w.google.idToken = await signJwt(googleClaims({ nonce: 'x'.repeat(24) }));
    assert.equal((await w.post('/auth/exchange', exchangeBody())).body.error, 'ID_TOKEN_INVALID');
  });

  test('잇기 → 새 기기에서 로그인 → 같은 표는 다시 못 쓴다 → 로그아웃', async () => {
    const w = world();
    w.db.addPlayer('철수', T1, 0);
    w.google.idToken = await signJwt(googleClaims());
    const first = await w.post('/auth/exchange', exchangeBody());
    const linked = await w.post('/auth/link', { ticket: first.body.ticket, token: T1 });
    assert.deepEqual(linked.body, { ok: true, name: '철수' });
    assert.equal((await w.post('/auth/link', { ticket: first.body.ticket, token: T1 })).body.already, true);

    const second = await w.post('/auth/exchange', exchangeBody());
    assert.equal(second.body.linkedName, '철수', '새 기기는 이은 닉네임을 안다');
    const login = await w.post('/auth/login', { ticket: second.body.ticket, newToken: T2 });
    assert.deepEqual(login.body, { ok: true, name: '철수' });
    assert.equal((await w.post('/auth/login', { ticket: second.body.ticket, newToken: 'c'.repeat(64) })).body.error, 'TICKET_USED');
    assert.equal((await w.post('/me', { token: T2 })).body.name, '철수');
    assert.deepEqual((await w.post('/me', { token: T2 })).body.providers, ['google']);
    assert.equal((await w.post('/auth/logout', { token: T2 })).body.ok, true);
    assert.equal((await w.post('/me', { token: T2 })).body.error, 'NOT_FOUND');
    assert.equal((await w.post('/auth/login', { ticket: 'forged.ticket', newToken: T2 })).body.error, 'TICKET_INVALID');
  });
});

// ─────────────────────────────── 결제 ───────────────────────────────
describe('테스트 결제', () => {
  async function order(w, productId = 'coin_100') {
    const r = await w.post('/pay/orders', { token: T1, productId, returnUrl: `${RETURN}#shop` });
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
    return r.body;
  }
  const visit = (w, path) => w.call('GET', path, { origin: null });
  const locationOf = (r) => r.headers.get('location');

  test('주문 → 결제 페이지 → 승인 → 코인. 토스에는 시크릿 키 Basic 인증과 주문 멱등키로 보낸다', async () => {
    const w = world();
    w.db.addPlayer('철수"<b>', T1);
    const o = await order(w);
    assert.equal(o.checkoutUrl, `${API}/pay/checkout?order=${o.orderId}`);
    assert.equal(w.db.orders.get(o.orderId).returnUrl, RETURN, '되돌아갈 주소의 해시는 뗀다');

    const page = await visit(w, `/pay/checkout?order=${o.orderId}`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('content-security-policy'), PAGE_CSP);
    const html = await page.text();
    assert.ok(html.includes(`data-order-id="${o.orderId}"`));
    assert.ok(html.includes('data-amount="1000"'));
    assert.ok(html.includes('data-client-key="test_ck_client"'));
    assert.ok(!html.includes('test_sk_secret'), '시크릿 키는 페이지에 없다');
    assert.ok(html.includes('철수&quot;&lt;b&gt;'), '닉네임을 이스케이프한다');
    assert.ok(!/<script>(?!<\/script>)/.test(html) && !/<script>[^<]/.test(html), '인라인 스크립트가 없다');
    assert.ok(html.includes(`data-fail-url="${API}/pay/fail/${o.orderId}"`));

    const done = await visit(w, `/pay/success?paymentKey=pk_1&orderId=${o.orderId}&amount=1000`);
    assert.equal(done.status, 303);
    assert.equal(locationOf(done), `${RETURN}#skala-pay=done&order=${o.orderId}&coins=100`);
    const confirm = w.toss.calls.find((c) => c.path === '/v1/payments/confirm');
    assert.equal(confirm.headers.authorization, basicAuth(ENV.TOSS_SECRET_KEY));
    assert.equal(confirm.headers['idempotency-key'], `confirm-${o.orderId}`);
    assert.deepEqual(confirm.body, { paymentKey: 'pk_1', orderId: o.orderId, amount: 1000 });
    assert.equal(w.db.players.get(1).coins, 100);
    assert.deepEqual(w.db.ledger.map((l) => [l.delta, l.reason]), [[100, 'purchase']]);

    // 새로 고침: 승인을 다시 부르지 않고 같은 결과로 보낸다
    const again = await visit(w, `/pay/success?paymentKey=pk_1&orderId=${o.orderId}&amount=1000`);
    assert.match(locationOf(again), /#skala-pay=done/);
    assert.equal(w.toss.calls.filter((c) => c.path === '/v1/payments/confirm').length, 1);
    assert.equal(w.db.players.get(1).coins, 100, '코인은 한 번만');
    // 끝난 주문의 결제 페이지는 다시 열리지 않는다
    assert.ok((await (await visit(w, `/pay/checkout?order=${o.orderId}`)).text()).includes('이미 처리한 주문이에요'));
  });

  test('돌아온 금액이 주문과 다르면 승인을 부르지 않는다', async () => {
    const w = world();
    w.db.addPlayer('철수', T1);
    const o = await order(w);
    const r = await visit(w, `/pay/success?paymentKey=pk_1&orderId=${o.orderId}&amount=10`);
    assert.equal(locationOf(r), `${RETURN}#skala-pay=fail&order=${o.orderId}&code=AMOUNT_MISMATCH`);
    assert.equal(w.toss.calls.length, 0);
    assert.equal(w.db.players.get(1).coins, 0);
  });

  test('승인 응답을 못 받으면 기다림으로 두고, 웹훅이 토스 기록으로 코인을 넣는다(한 번만)', async () => {
    const w = world();
    w.db.addPlayer('철수', T1);
    const o = await order(w);
    w.toss.confirmMode = 'network';
    const r = await visit(w, `/pay/success?paymentKey=pk_2&orderId=${o.orderId}&amount=1000`);
    assert.equal(locationOf(r), `${RETURN}#skala-pay=pending&order=${o.orderId}`);
    assert.equal(w.db.orders.get(o.orderId).status, 'CONFIRMING');
    assert.equal(w.db.players.get(1).coins, 0);

    const hook = { eventType: 'PAYMENT_STATUS_CHANGED', data: { paymentKey: 'pk_2', orderId: o.orderId, status: 'DONE', totalAmount: 1 } };
    const h1 = await w.post('/pay/webhook', hook, { origin: null });
    assert.deepEqual(h1.body, { ok: true, result: 'done' });
    assert.equal(w.db.players.get(1).coins, 100, '웹훅 본문의 금액(1)이 아니라 토스 조회 결과로 맞춘다');
    await w.post('/pay/webhook', hook, { origin: null });
    assert.equal(w.db.players.get(1).coins, 100, '같은 웹훅이 다시 와도 한 번만');
    assert.equal((await w.post('/pay/webhook', { eventType: 'DEPOSIT_CALLBACK', data: {} }, { origin: null })).body.ignored, true);
  });

  test('2xx인데 본문을 읽지 못한 승인은 실패가 아니라 결과를 모름으로 두고, 대사가 토스 기록으로 코인을 넣는다', async () => {
    const { reconcile } = await import('../server/api/src/pay.js');
    const { makeContext } = await import('../server/api/src/worker.js');
    const w = world();
    w.db.addPlayer('철수', T1);
    const o = await order(w);
    w.toss.confirmMode = 'garbage';
    const r = await visit(w, `/pay/success?paymentKey=pk_g&orderId=${o.orderId}&amount=1000`);
    assert.equal(locationOf(r), `${RETURN}#skala-pay=pending&order=${o.orderId}`);
    assert.equal(w.db.orders.get(o.orderId).status, 'CONFIRMING', 'FAILED로 적지 않는다');
    w.db.orders.get(o.orderId).idleSec = 180;
    await reconcile(makeContext(w.env, { fetch: w.fetch, log: () => {} }, ''));
    assert.equal(w.db.orders.get(o.orderId).status, 'DONE');
    assert.equal(w.db.players.get(1).coins, 100);
  });

  test('웹훅을 DB 문제로 처리하지 못하면 500으로 답해 다시 받는다', async () => {
    const w = world();
    w.db.addPlayer('철수', T1);
    const o = await order(w);
    w.toss.confirmMode = 'network';
    await visit(w, `/pay/success?paymentKey=pk_3&orderId=${o.orderId}&amount=1000`);
    w.db.handle = async () => { throw new TypeError('db down'); };
    const h = await w.post('/pay/webhook', { eventType: 'PAYMENT_STATUS_CHANGED', data: { paymentKey: 'pk_3', orderId: o.orderId } }, { origin: null });
    assert.equal(h.status, 500);
  });

  test('카드사 거절은 실패로 적고, 결제창 취소(failUrl)도 실패로 돌려보낸다', async () => {
    const w = world();
    w.db.addPlayer('철수', T1);
    const a = await order(w);
    w.toss.confirmMode = 'reject';
    const r = await visit(w, `/pay/success?paymentKey=pk_4&orderId=${a.orderId}&amount=1000`);
    assert.equal(locationOf(r), `${RETURN}#skala-pay=fail&order=${a.orderId}&code=REJECT_CARD_COMPANY`);
    assert.equal(w.db.orders.get(a.orderId).status, 'FAILED');

    const b = await order(w);
    const f = await visit(w, `/pay/fail/${b.orderId}?code=PAY_PROCESS_CANCELED&message=x`);
    assert.equal(locationOf(f), `${RETURN}#skala-pay=fail&order=${b.orderId}&code=PAY_PROCESS_CANCELED`);
    assert.equal(w.db.orders.get(b.orderId).status, 'FAILED');
    assert.equal((await visit(w, '/pay/fail?code=X')).status, 200, '주문을 모르면 안내 페이지');
  });

  test('하루 한도·잘못된 상품·다른 사이트로 돌아가기는 막는다', async () => {
    const w = world({ PAY_DAILY_LIMIT: '1' });
    w.db.addPlayer('철수', T1);
    const o = await order(w);
    await visit(w, `/pay/success?paymentKey=pk_5&orderId=${o.orderId}&amount=1000`);
    assert.equal((await w.post('/pay/orders', { token: T1, productId: 'coin_100', returnUrl: RETURN })).body.error, 'DAILY_LIMIT');
    assert.equal((await w.post('/pay/orders', { token: T1, productId: 'coin_999', returnUrl: RETURN })).status, 400);
    assert.equal((await w.post('/pay/orders', { token: T1, productId: 'coin_100', returnUrl: 'https://evil.test/' })).body.error, 'BAD_RETURN_URL');
    assert.equal((await w.post('/pay/orders', { token: T1, productId: '__proto__', returnUrl: RETURN })).status, 400);
    const live = world({ TOSS_CLIENT_KEY: 'live_ck_x', TOSS_SECRET_KEY: 'live_sk_x' });
    assert.equal((await live.post('/pay/orders', { token: T1, productId: 'coin_100', returnUrl: RETURN })).body.reason, 'live_key');
  });

  test('환불: 코인을 빼고 토스 취소(멱등키) → CANCELED. 쓴 코인은 환불하지 않고, 취소가 거절되면 코인을 돌려놓는다', async () => {
    const w = world();
    w.db.addPlayer('철수', T1);
    const a = await order(w);
    await visit(w, `/pay/success?paymentKey=pk_6&orderId=${a.orderId}&amount=1000`);
    const ok = await w.post('/pay/cancel', { token: T1, orderId: a.orderId });
    assert.deepEqual(ok.body, { ok: true, status: 'CANCELED', coins: 0 });
    const cancelCall = w.toss.calls.find((c) => c.path.endsWith('/cancel'));
    assert.equal(cancelCall.headers['idempotency-key'], `cancel-${a.orderId}`);
    assert.ok(cancelCall.body.cancelReason);

    const b = await order(w);
    await visit(w, `/pay/success?paymentKey=pk_7&orderId=${b.orderId}&amount=1000`);
    await w.post('/shop/coins', { token: T1, itemId: 'av_scout' });   // 30코인 씀 → 70 남음 < 100
    assert.equal((await w.post('/pay/cancel', { token: T1, orderId: b.orderId })).body.error, 'COINS_SPENT');

    const c = await order(w);
    await visit(w, `/pay/success?paymentKey=pk_8&orderId=${c.orderId}&amount=1000`);
    w.toss.cancelMode = 'reject';
    const no = await w.post('/pay/cancel', { token: T1, orderId: c.orderId });
    assert.equal(no.body.error, 'CANCEL_FAILED');
    assert.equal(w.db.orders.get(c.orderId).status, 'DONE');
    assert.equal(w.db.players.get(1).coins, 170, '빼 둔 코인을 돌려놓았다');
    assert.deepEqual(w.db.ledger.map((l) => l.reason), ['purchase', 'refund', 'purchase', 'spend', 'purchase', 'refund', 'refund_undo']);
  });

  test('코인으로 꾸미기를 산다', async () => {
    const w = world();
    w.db.addPlayer('철수', T1, 50);
    const r = await w.post('/shop/coins', { token: T1, itemId: 'av_scout' });
    assert.deepEqual(r.body, { ok: true, coins: 20, spent: 30, owned: ['av_scout'] });
    assert.equal((await w.post('/shop/coins', { token: T1, itemId: 'selfie' })).body.error, 'COINS_SHORT');
    assert.equal((await w.post('/shop/coins', { token: T1, itemId: '<x>' })).status, 400);
  });

  test('대사: 결과를 모르는 승인은 토스 기록으로, 오래 멈춘 환불은 되돌린다', async () => {
    const { reconcile } = await import('../server/api/src/pay.js');
    const { makeContext } = await import('../server/api/src/worker.js');
    const w = world();
    w.db.addPlayer('철수', T1);
    const a = await order(w);
    w.toss.confirmMode = 'network';
    await visit(w, `/pay/success?paymentKey=pk_9&orderId=${a.orderId}&amount=1000`);
    const ctx = makeContext(w.env, { fetch: w.fetch, log: (l) => w.logs.push(l) }, '');
    assert.deepEqual(await reconcile(ctx), { ok: true, fixed: 1 });
    assert.equal(w.db.orders.get(a.orderId).status, 'DONE');
    assert.equal(w.db.players.get(1).coins, 100);

    w.db.orders.get(a.orderId).status = 'CANCELING';   // 취소를 불렀는데 응답을 못 받은 채 10분이 지났다
    w.db.orders.get(a.orderId).idleSec = 700;
    w.db.players.get(1).coins = 0;
    await reconcile(ctx);
    assert.equal(w.db.orders.get(a.orderId).status, 'DONE', '토스는 아직 DONE: 취소가 일어나지 않았다');
    assert.equal(w.db.players.get(1).coins, 100);
  });
});

test('상품표: 코인 수와 금액이 양수 정수이고 id가 주문 모양에 맞다', () => {
  for (const p of Object.values(PRODUCTS)) {
    assert.ok(Number.isInteger(p.coins) && p.coins > 0 && Number.isInteger(p.amount) && p.amount >= 100, p.id);
    assert.match(p.id, /^[a-z0-9_]{1,32}$/);
  }
});
