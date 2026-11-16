/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 플레이 테스트용 가짜 로그인·결제 API(server/api Worker의 HTTP 약속만 흉내 낸다, 의존성 없음). 가짜 Supabase(fake-supabase.mjs)의
 *          플레이어 목록을 같이 써서 로그인한 기기 토큰이 실제로 그 닉네임을 불러오게 한다. 구글 인가 화면(/fake/authorize)은 곧바로
 *          redirect_uri로 code·state를 붙여 돌려보내고, 결제 페이지(/pay/checkout)는 곧바로 코인을 넣고 게임 주소#skala-pay=done으로 돌려보낸다.
 *          ID 토큰 서명·토스 승인 같은 서버 검증은 하지 않는다(단위 테스트 tests/api-worker.test.mjs가 본다). 포트는 운영체제가 고른다.
 */
import { createServer } from 'node:http';
import { coinPriceOf } from '../../js/account/economy.js';

const PRODUCTS = [{ id: 'coin_100', name: '코인 100개', coins: 100, amount: 1000 }, { id: 'coin_550', name: '코인 550개', coins: 550, amount: 5000 }];

/**
 * @param {{ supabase: { players: Map } }} opts  supabase: startFakeSupabase()의 결과(players: 토큰 → 프로필)
 * @returns {Promise<{ url, subject, exchanges, orders, seed(o), coinsOf(name), close() }>} subject: 다음 로그인이 돌려줄 구글 고유 id
 */
export async function startFakeApi({ supabase }) {
  const players = supabase.players;
  const ids = new Map();       // 'google:<sub>' → 닉네임(가짜 Supabase는 이름이 유일하다)
  const coins = new Map();     // 닉네임 → 코인
  const tickets = new Map();   // 표 → { sub, used }
  const orders = [];
  const exchanges = [];
  let base = '';

  const nameOf = (token) => (players.get(token) || {}).name || null;
  const tokenOfName = (name) => [...players.entries()].find(([, p]) => p.name === name)?.[0] || null;

  const api = {
    subject: 'qa-sub-1',
    exchanges,
    orders,
    /** 다른 기기에서 쓰던 계정을 만든다: { token, name, subject, coins } */
    seed({ token, name, subject, coins: c = 0 }) {
      players.set(token, { name, points: 777, owned: [], loadout: {}, stats: {}, secrets: {} });
      if (subject) ids.set(`google:${subject}`, name);
      coins.set(name, c);
    },
    coinsOf: (name) => coins.get(name) || 0
  };

  function features() {
    return {
      ok: true, service: 'skala-api', db: true,
      login: { providers: [{ id: 'google', name: '구글', authorizeUrl: `${base}/fake/authorize`, clientId: 'qa-client', scope: 'openid', params: { prompt: 'select_account' } }] },
      pay: { enabled: true, test: true, reason: null, dailyLimit: 3, refundDays: 7, products: PRODUCTS },
      coins: { enabled: true }
    };
  }

  const post = {
    '/auth/exchange': (b) => {
      exchanges.push(b);
      if (b.code !== 'qa-code') return { ok: false, error: 'OAUTH_EXCHANGE' };
      const ticket = `qa-ticket-${tickets.size + 1}`;
      tickets.set(ticket, { sub: api.subject, used: false });
      return { ok: true, provider: 'google', ticket, linkedName: ids.get(`google:${api.subject}`) || null };
    },
    '/auth/link': ({ ticket, token }) => {
      const t = tickets.get(ticket);
      if (!t || t.used) return { ok: false, error: 'TICKET_USED' };
      const name = nameOf(token);
      if (!name) return { ok: false, error: 'NOT_FOUND' };
      t.used = true;
      ids.set(`google:${t.sub}`, name);
      return { ok: true, name };
    },
    '/auth/login': ({ ticket, newToken }) => {
      const t = tickets.get(ticket);
      if (!t || t.used) return { ok: false, error: 'TICKET_USED' };
      const name = ids.get(`google:${t.sub}`);
      const from = name && tokenOfName(name);
      if (!from) return { ok: false, error: 'NOT_LINKED' };
      t.used = true;
      players.set(newToken, { ...players.get(from) });   // 같은 닉네임의 프로필을 이 기기 토큰으로도 읽게 한다
      return { ok: true, name };
    },
    '/auth/logout': ({ token }) => {
      const name = nameOf(token);
      if (name && ![...ids.values()].includes(name)) return { ok: false, error: 'NOT_LINKED' };
      players.delete(token);
      return { ok: true };
    },
    '/me': ({ token }) => {
      const name = nameOf(token);
      if (!name) return { ok: false, error: 'NOT_FOUND' };
      const providers = [...ids.entries()].filter(([, n]) => n === name).map(([k]) => k.split(':')[0]);
      const mine = orders.filter((o) => o.name === name).slice().reverse()
        .map((o) => ({ orderId: o.orderId, product: o.product, coins: o.coins, amount: o.amount, status: o.status, at: o.at,
          refundable: o.status === 'DONE' && (coins.get(name) || 0) >= o.coins }));
      return { ok: true, name, coins: coins.get(name) || 0, providers, orders: mine };
    },
    '/pay/orders': ({ token, productId, returnUrl }) => {
      const name = nameOf(token);
      const product = PRODUCTS.find((p) => p.id === productId);
      if (!name) return { ok: false, error: 'NOT_FOUND' };
      if (!product) return { ok: false, error: 'BAD_REQUEST' };
      const orderId = `skala_${String(orders.length + 1).padStart(32, '0')}`;
      orders.push({ orderId, name, product: product.id, coins: product.coins, amount: product.amount, status: 'READY', returnUrl, at: Date.now() });
      return { ok: true, orderId, checkoutUrl: `${base}/pay/checkout?order=${orderId}`, coins: product.coins, amount: product.amount };
    },
    '/pay/cancel': ({ token, orderId }) => {
      const name = nameOf(token);
      const o = orders.find((x) => x.orderId === orderId && x.name === name);
      if (!o) return { ok: false, error: 'NOT_FOUND' };
      if ((coins.get(name) || 0) < o.coins) return { ok: false, error: 'COINS_SPENT' };
      coins.set(name, coins.get(name) - o.coins);
      o.status = 'CANCELED';
      return { ok: true, status: 'CANCELED', coins: coins.get(name) };
    },
    '/shop/coins': ({ token, itemId }) => {
      const name = nameOf(token);
      const price = coinPriceOf(itemId);
      if (!name) return { ok: false, error: 'NOT_FOUND' };
      if (price == null) return { ok: false, error: 'ITEM_INVALID' };
      const p = players.get(token);
      const owned = Array.isArray(p.owned) ? p.owned : [];
      if (owned.includes(itemId)) return { ok: false, error: 'OWNED', owned, coins: coins.get(name) || 0 };
      if ((coins.get(name) || 0) < price) return { ok: false, error: 'COINS_SHORT', coins: coins.get(name) || 0, price };
      coins.set(name, coins.get(name) - price);
      p.owned = [...owned, itemId];
      return { ok: true, coins: coins.get(name), spent: price, owned: p.owned };
    }
  };

  const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
  const send = (res, status, body) => {
    res.writeHead(status, { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const go = (res, location) => {
    res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
    res.end();
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', base || 'http://127.0.0.1');
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
    if (req.method === 'GET') {
      if (url.pathname === '/features') return send(res, 200, features());
      if (url.pathname === '/fake/authorize') {
        // 구글 인가 화면 대신: 같은 state를 붙여 곧바로 돌려보낸다(구글처럼 scope·authuser도 붙인다).
        // redirect_uri에는 쿼리가 없어(제공자에 등록하는 주소) 게임의 ?debug=1이 빠지므로, 시험이 게임 내부(__qa.ctx)를 보도록 이 가짜만 debug=1을 붙인다
        const back = new URL(url.searchParams.get('redirect_uri'));
        back.searchParams.set('debug', '1');
        back.searchParams.set('state', url.searchParams.get('state') || '');
        back.searchParams.set('code', 'qa-code');
        back.searchParams.set('scope', 'openid');
        back.searchParams.set('authuser', '0');
        return go(res, back.toString());
      }
      if (url.pathname === '/pay/checkout') {
        // 결제 페이지 대신: 결제를 마친 것으로 치고 코인을 넣은 뒤 게임으로 돌려보낸다
        const o = orders.find((x) => x.orderId === url.searchParams.get('order'));
        if (!o || o.status !== 'READY') return send(res, 404, { ok: false, error: 'NOT_FOUND' });
        o.status = 'DONE';
        coins.set(o.name, (coins.get(o.name) || 0) + o.coins);
        return go(res, `${o.returnUrl}#skala-pay=done&order=${o.orderId}&coins=${coins.get(o.name)}`);
      }
      return send(res, 404, { ok: false, error: 'not_found' });
    }
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const handler = post[url.pathname];
      if (req.method !== 'POST' || !handler) return send(res, 404, { ok: false, error: 'not_found' });
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch (_) { return send(res, 400, { ok: false, error: 'BAD_REQUEST' }); }
      send(res, 200, handler(body));
    });
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  base = `http://127.0.0.1:${server.address().port}`;
  api.url = base;
  api.close = () => new Promise((res) => {
    server.close(() => res());
    server.closeAllConnections();
  });
  return api;
}
