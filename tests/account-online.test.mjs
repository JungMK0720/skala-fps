/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 브라우저 쪽 로그인 연결·코인 흐름(js/account/online.js, account.online)을 시험한다. Supabase RPC와 API Worker는 가짜 fetch로,
 *          주소·sessionStorage·history는 가짜 객체로 바꿔 끼운다. 인가 주소(PKCE·state·nonce), 돌아온 뒤의 잇기·로그인·바꾸기·게이트에서 잇기,
 *          로그아웃, 결제 페이지로 떠나기와 결과 알림, 코인으로 사기, 코인 가격 규칙을 본다.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createAccount, coinPriceOf } from '../js/account/index.js';
import { TOKEN_KEY } from '../js/account/store.js';
import { OAUTH_KEY, authorizeUrl, cleanedUrl, pkceChallenge, readPayResult, redirectUriOf } from '../js/account/oauth.js';
import { readApiUrl } from '../js/account/api.js';
import { EMOTES } from '../js/core/consts.js';
import { AVATARS } from '../js/core/avatar-defs.js';
import { WEAPON_IDS } from '../js/weapons/defs.js';

const DB = 'https://db.test';
const API = 'https://api.test';
const GAME = 'https://game.test/skala-fps/';
const T_OLD = '1'.repeat(64);

function memStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

function fakeLocation(href) {
  let u = new URL(href);
  const loc = {
    assigned: [],
    get href() { return u.href; }, get origin() { return u.origin; }, get pathname() { return u.pathname; },
    get search() { return u.search; }, get hash() { return u.hash; },
    assign(url) { loc.assigned.push(url); },
    set(next) { u = new URL(next); }
  };
  return loc;
}

function fakeHistory(loc) {
  return { calls: [], state: null, replaceState(_s, _t, url) { this.calls.push(url); loc.set(url); } };
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Supabase RPC + API Worker를 함께 흉내 낸다(같은 사람 목록을 쓴다) */
function backend() {
  const b = { players: new Map(), tokens: new Map(), ids: new Map(), tickets: new Map(), orders: [], calls: [], subject: 'google-sub-1', seq: 0 };
  b.add = (name, token, extra = {}) => {
    b.seq += 1;
    b.players.set(b.seq, { id: b.seq, name, points: 500, owned: [], loadout: {}, stats: {}, secrets: {}, coins: 0, ...extra });
    b.tokens.set(token, b.seq);
    return b.players.get(b.seq);
  };
  const who = (t) => (b.tokens.has(t) ? b.players.get(b.tokens.get(t)) : null);
  const rpc = {
    fps_features: () => ({ ok: true, avatars: true, feedback: true }),
    fps_get_profile: ({ p_token }) => {
      if (b.failProfile) return null;   // 아래 fetch가 500으로 바꾼다
      const p = who(p_token);
      return p ? { ok: true, profile: { name: p.name, points: p.points, owned: p.owned, loadout: p.loadout, stats: p.stats, secrets: p.secrets, createdAt: 1 } } : { ok: false, error: 'NOT_FOUND' };
    },
    fps_claim_nickname: ({ p_token, p_name }) => {
      const p = who(p_token);
      if (p) p.name = p_name; else b.add(p_name, p_token);
      return { ok: true, name: p_name };
    },
    fps_save_profile: ({ p_token, p_points, p_owned }) => {
      const p = who(p_token);
      if (!p) return { ok: false, error: 'NOT_FOUND' };
      p.points = p_points;
      p.owned = [...new Set([...p.owned, ...p_owned])];
      return { ok: true, clamped: false, profile: { points: p.points, owned: p.owned, stats: p.stats } };
    }
  };
  const ticketOf = (t) => b.tickets.get(t);
  const api = {
    'GET /features': () => ({
      ok: true, db: true,
      login: { providers: [{ id: 'google', name: '구글', authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth', clientId: 'gid.test', scope: 'openid', params: { prompt: 'select_account' } }] },
      pay: { enabled: true, test: true, dailyLimit: 3, refundDays: 7, products: [{ id: 'coin_100', name: '코인 100개', coins: 100, amount: 1000 }] },
      coins: { enabled: true }
    }),
    'POST /auth/exchange': (body) => {
      if (body.code !== 'good-code') return { ok: false, error: 'OAUTH_EXCHANGE' };
      const ticket = `ticket-${b.tickets.size + 1}`;
      b.tickets.set(ticket, { sub: b.subject, used: false });
      const owner = b.ids.get(`google:${b.subject}`);
      return { ok: true, provider: 'google', ticket, linkedName: owner ? b.players.get(owner).name : null };
    },
    'POST /auth/link': ({ ticket, token }) => {
      const t = ticketOf(ticket);
      const p = who(token);
      if (!t || t.used) return { ok: false, error: 'TICKET_USED' };
      if (!p) return { ok: false, error: 'NOT_FOUND' };
      t.used = true;
      b.ids.set(`google:${t.sub}`, p.id);
      return { ok: true, name: p.name };
    },
    'POST /auth/login': ({ ticket, newToken }) => {
      const t = ticketOf(ticket);
      if (!t || t.used) return { ok: false, error: 'TICKET_USED' };
      const id = b.ids.get(`google:${t.sub}`);
      if (!id) return { ok: false, error: 'NOT_LINKED' };
      t.used = true;
      b.tokens.set(newToken, id);
      return { ok: true, name: b.players.get(id).name };
    },
    'POST /auth/logout': ({ token }) => {
      const p = who(token);
      if (p && ![...b.ids.values()].includes(p.id)) return { ok: false, error: 'NOT_LINKED' };
      b.tokens.delete(token);
      return { ok: true };
    },
    'POST /me': ({ token }) => {
      const p = who(token);
      if (!p) return { ok: false, error: 'NOT_FOUND' };
      const providers = [...b.ids.entries()].filter(([, id]) => id === p.id).map(([k]) => k.split(':')[0]);
      return { ok: true, name: p.name, coins: p.coins, providers, orders: b.orders.filter((o) => o.player === p.id) };
    },
    'POST /pay/orders': ({ token, productId, returnUrl }) => {
      const p = who(token);
      if (!p) return { ok: false, error: 'NOT_FOUND' };
      const orderId = `skala_${'0'.repeat(31)}${b.orders.length + 1}`;
      b.orders.push({ orderId, player: p.id, product: productId, coins: 100, amount: 1000, status: 'READY', returnUrl });
      return { ok: true, orderId, checkoutUrl: b.checkoutUrl || `${API}/pay/checkout?order=${orderId}`, coins: 100, amount: 1000 };
    },
    'POST /pay/cancel': ({ token, orderId }) => {
      const p = who(token);
      const o = b.orders.find((x) => x.orderId === orderId);
      if (!p || !o) return { ok: false, error: 'NOT_FOUND' };
      if (p.coins < o.coins) return { ok: false, error: 'COINS_SPENT', coins: p.coins };
      p.coins -= o.coins;
      o.status = 'CANCELED';
      return { ok: true, status: 'CANCELED', coins: p.coins };
    },
    'POST /shop/coins': ({ token, itemId }) => {
      const p = who(token);
      const price = coinPriceOf(itemId);
      if (!p) return { ok: false, error: 'NOT_FOUND' };
      if (p.coins < price) return { ok: false, error: 'COINS_SHORT', coins: p.coins, price };
      p.coins -= price;
      p.owned = [...p.owned, itemId];
      return { ok: true, coins: p.coins, spent: price, owned: p.owned };
    }
  };
  b.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    if (url.startsWith(`${DB}/rest/v1/rpc/`)) {
      const fn = url.slice(`${DB}/rest/v1/rpc/`.length);
      b.calls.push({ fn, body });
      if (!rpc[fn]) return json({ code: 'PGRST202' }, 404);
      const out = rpc[fn](body);
      return out === null ? json({ message: 'boom' }, 500) : json(out);
    }
    if (url.startsWith(API)) {
      const key = `${init.method || 'GET'} ${url.slice(API.length)}`;
      b.calls.push({ fn: key, body });
      assert.equal(init.credentials, 'omit', '쿠키를 보내지 않는다');
      return api[key] ? json(api[key](body)) : json({ ok: false, error: 'not_found' }, 404);
    }
    throw new Error(`예상하지 못한 요청 ${url}`);
  };
  b.count = (fn) => b.calls.filter((c) => c.fn === fn).length;
  return b;
}

function setup({ href = GAME, storage = memStorage(), session = memStorage(), apiUrl = API, server = backend() } = {}) {
  const loc = fakeLocation(href);
  const hist = fakeHistory(loc);
  const notices = [];
  const bus = { emit: (e, p) => { if (e === 'account:notice') notices.push(p); } };
  const account = createAccount({
    bus, storage, fetch: server.fetch, target: null,
    config: { url: DB, anonKey: 'sb_publishable_test' },
    apiConfig: { url: apiUrl }, session, location: loc, history: hist
  });
  return { account, loc, hist, server, storage, session, notices, online: account.online };
}

const savedProfile = (name) => JSON.stringify({ v: 2, profile: { nickname: name, points: 500 }, sync: { dirty: false, pendingClaim: null } });

/** 인가 화면에서 돌아온 상태를 만든다: sessionStorage에 떠날 때의 기록, 주소에 code·state */
async function returnFromGoogle(server, { storage, code = 'good-code', state = 'st-1', recordState = 'st-1' } = {}) {
  const session = memStorage({ [OAUTH_KEY]: JSON.stringify({ v: 1, provider: 'google', state: recordState, nonce: 'n'.repeat(32), verifier: 'v'.repeat(43), redirectUri: GAME, at: Date.now() }) });
  const s = setup({ href: `${GAME}?debug=1&code=${code}&state=${state}&scope=openid&authuser=0`, storage, session, server });
  await s.online.ready;
  return s;
}

describe('설정과 도우미', () => {
  test('API 주소가 없으면 꺼져 있고 API에 묻지 않는다', async () => {
    const server = backend();
    const s = setup({ apiUrl: '', server });
    await s.online.ready;
    assert.equal(s.online.state.status, 'off');
    assert.equal(server.calls.filter((c) => c.fn.startsWith('GET ') || c.fn.startsWith('POST ')).length, 0);
    assert.equal((await s.online.startLogin('google')).ok, false);
  });

  test('API 주소는 https(로컬 시험은 http://localhost)만 받는다', () => {
    assert.equal(readApiUrl({ url: 'https://skala-api.example.workers.dev/' }), 'https://skala-api.example.workers.dev');
    assert.equal(readApiUrl({ url: 'http://localhost:8789' }), 'http://localhost:8789');
    assert.equal(readApiUrl({ url: 'http://api.example.com' }), '');
    assert.equal(readApiUrl({ url: 'https://api.example.com/path' }), '', '경로가 붙은 주소는 받지 않는다');
    assert.equal(readApiUrl({ url: 'javascript:alert(1)' }), '');
  });

  test('돌아올 주소·인가 주소·주소 정리', async () => {
    assert.equal(redirectUriOf(new URL('https://game.test/skala-fps/index.html?x=1#y')), GAME);
    const url = new URL(authorizeUrl({ authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth', clientId: 'gid', scope: 'openid', params: { prompt: 'select_account', state: 'nope' } },
      { redirectUri: GAME, state: 's', nonce: 'n', challenge: 'c' }));
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('prompt'), 'select_account');
    assert.equal(url.searchParams.get('state'), 's', '제공자 추가 값이 state를 덮지 못한다');
    assert.equal(cleanedUrl(new URL(`${GAME}?debug=1&code=x&state=y&scope=openid#skala-pay=done&order=o`)), `${GAME}?debug=1`);
    assert.deepEqual(readPayResult(new URL(`${GAME}#skala-pay=done&order=o1&coins=100`)), { kind: 'done', order: 'o1', code: '', coins: 100 });
    assert.equal(readPayResult(new URL(`${GAME}#skala-pay=evil`)), null);
  });

  test('코인 가격: 꾸미기만, 포인트 가격의 10분의 1(올림). 무기와 기본 물건은 코인으로 팔지 않는다', () => {
    for (const a of AVATARS) assert.equal(coinPriceOf(a.id), a.price ? Math.ceil(a.price / 10) : null, a.id);
    for (const e of EMOTES) assert.equal(coinPriceOf(e.id), e.price ? Math.ceil(e.price / 10) : null, e.id);
    for (const id of WEAPON_IDS) assert.equal(coinPriceOf(id), null, id);
  });
});

describe('로그인', () => {
  test('인가 화면으로 보낸다: PKCE S256·state·nonce를 만들고 sessionStorage에 남긴다', async () => {
    const server = backend();
    server.add('철수', T_OLD);
    const storage = memStorage({ [TOKEN_KEY]: T_OLD, 'skalafps.profile.v1': savedProfile('철수') });
    const s = setup({ href: `${GAME}index.html?debug=1`, storage, server });
    await s.online.ready;
    assert.equal(s.online.state.status, 'ready');
    assert.deepEqual(s.online.state.providers, [{ id: 'google', name: '구글' }]);
    assert.equal((await s.online.startLogin('google')).ok, true);
    const url = new URL(s.loc.assigned[0]);
    const rec = JSON.parse(s.session.getItem(OAUTH_KEY));
    assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.equal(url.searchParams.get('client_id'), 'gid.test');
    assert.equal(url.searchParams.get('redirect_uri'), GAME, 'index.html은 떼고 쿼리는 붙이지 않는다');
    assert.equal(url.searchParams.get('state'), rec.state);
    assert.equal(url.searchParams.get('nonce'), rec.nonce);
    assert.equal(url.searchParams.get('code_challenge'), await pkceChallenge(rec.verifier));
    assert.match(rec.verifier, /^[A-Za-z0-9_-]{43}$/);
    assert.ok(!url.searchParams.has('code_verifier'), 'verifier는 보내지 않는다');
  });

  test('돌아오면 주소를 정리하고, 연결된 닉네임이 없으면 이 기기의 닉네임에 잇는다', async () => {
    const server = backend();
    server.add('철수', T_OLD);
    const storage = memStorage({ [TOKEN_KEY]: T_OLD, 'skalafps.profile.v1': savedProfile('철수') });
    const s = await returnFromGoogle(server, { storage });
    assert.equal(s.hist.calls[0], `${GAME}?debug=1`, 'code·state를 주소에서 지운다');
    assert.equal(s.session.getItem(OAUTH_KEY), null, '떠날 때의 기록은 한 번 쓰고 지운다');
    const ex = server.calls.find((c) => c.fn === 'POST /auth/exchange').body;
    assert.deepEqual(ex, { provider: 'google', code: 'good-code', codeVerifier: 'v'.repeat(43), redirectUri: GAME, nonce: 'n'.repeat(32) });
    assert.equal(server.ids.get('google:google-sub-1'), 1);
    assert.deepEqual(s.online.state.linked, ['google']);
    assert.equal(s.online.state.message.tone, 'ok');
    assert.equal(s.notices.at(-1).open, 'mypage');
  });

  test('state가 다르면 서버에 code를 보내지 않는다', async () => {
    const server = backend();
    const s = await returnFromGoogle(server, { state: 'attacker', recordState: 'st-1' });
    assert.equal(server.count('POST /auth/exchange'), 0);
    assert.equal(s.online.state.message.tone, 'bad');
  });

  test('새 기기: 연결된 닉네임으로 로그인한다(새 토큰을 서버에 더하고 이 기기 토큰을 바꾼다)', async () => {
    const server = backend();
    const chulsoo = server.add('철수', T_OLD, { points: 1234, coins: 70 });
    server.ids.set('google:google-sub-1', chulsoo.id);
    const storage = memStorage();
    const s = await returnFromGoogle(server, { storage });
    const token = storage.getItem(TOKEN_KEY);
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.notEqual(token, T_OLD);
    assert.equal(server.tokens.get(token), chulsoo.id);
    assert.equal(s.account.profile.nickname, '철수');
    assert.equal(s.account.profile.points, 1234);
    assert.equal(s.online.state.coins, 70);
  });

  test('로그인한 토큰으로 프로필을 받지 못하면 기기를 바꾸지 않는다(빈 프로필로 불러온 계정을 덮지 않게)', async () => {
    const server = backend();
    const chulsoo = server.add('철수', T_OLD, { points: 1234 });
    server.ids.set('google:google-sub-1', chulsoo.id);
    server.failProfile = true;
    const storage = memStorage();
    const s = await returnFromGoogle(server, { storage });
    try {
      assert.equal(server.count('POST /auth/login'), 1, '서버는 새 토큰을 더했다');
      const loginToken = server.calls.find((c) => c.fn === 'POST /auth/login').body.newToken;
      assert.notEqual(storage.getItem(TOKEN_KEY), loginToken, '이 기기의 토큰을 로그인 토큰으로 바꾸지 않는다');
      assert.equal(s.account.profile.nickname, '');
      assert.equal(s.online.state.message.tone, 'bad');
      assert.equal(chulsoo.name, '철수');
      assert.equal(chulsoo.points, 1234, '불러올 계정은 그대로');
    } finally {
      server.failProfile = false;
      s.account.dispose();   // 실패한 첫 동기화의 재시도 타이머를 멈춘다
    }
  });

  test('다른 탭이 이 기기의 계정을 바꾸면 이 탭은 프로필을 비우고 다시 받는다. 받기 전에는 닉네임을 정하지 못한다', async () => {
    const server = backend();
    server.add('철수', T_OLD, { points: 900 });
    const younghee = server.add('영희', '2'.repeat(64), { points: 1500 });
    const storage = memStorage({ [TOKEN_KEY]: T_OLD, 'skalafps.profile.v1': savedProfile('철수') });
    const target = new EventTarget();
    const account = createAccount({ bus: null, storage, fetch: server.fetch, target, config: { url: DB, anonKey: 'sb_publishable_test' }, apiConfig: { url: '' } });
    try {
      await account.ready;
      assert.equal(account.profile.nickname, '철수');
      // 다른 탭이 로그인해서 토큰을 영희의 것으로 바꿨다(프로필은 아직 오지 않았고, 서버도 잠깐 답하지 못한다)
      storage.setItem(TOKEN_KEY, '2'.repeat(64));
      server.failProfile = true;
      const ev = new Event('storage');
      Object.defineProperty(ev, 'key', { value: TOKEN_KEY });
      Object.defineProperty(ev, 'newValue', { value: '2'.repeat(64) });
      target.dispatchEvent(ev);
      assert.equal(account.profile.nickname, '', '앞 계정의 프로필을 비운다');
      const r = await account.setNickname('민수');
      assert.equal(r.reason, 'loading', '새 토큰의 행을 모르는 동안은 닉네임을 정하지 못한다');
      await new Promise((res) => setTimeout(res, 30));   // 실패한 첫 동기화가 끝나기를 기다린다
      assert.equal((await account.setNickname('민수')).reason, 'loading', '받지 못했으면 계속 막는다');
      assert.equal(younghee.name, '영희', '영희의 이름이 바뀌지 않았다');
      server.failProfile = false;
      await account.syncFromRemote();
      assert.equal(account.profile.nickname, '영희');
      assert.equal(account.profile.points, 1500);
    } finally {
      server.failProfile = false;
      account.dispose();
    }
  });

  test('다른 닉네임이 있는 기기는 먼저 묻고, 바꾸기를 고르면 그 닉네임으로 바꾼다', async () => {
    const server = backend();
    const chulsoo = server.add('철수', 'c'.repeat(64));
    server.ids.set('google:google-sub-1', chulsoo.id);
    server.add('영희', T_OLD);
    const storage = memStorage({ [TOKEN_KEY]: T_OLD, 'skalafps.profile.v1': savedProfile('영희') });
    const s = await returnFromGoogle(server, { storage });
    assert.deepEqual(s.online.state.pending, { kind: 'switch', provider: 'google', providerName: '구글', name: '철수' });
    assert.equal(s.account.profile.nickname, '영희', '묻기 전에는 바꾸지 않는다');
    assert.equal(server.count('POST /auth/login'), 0);
    await s.online.confirmSwitch();
    assert.equal(s.account.profile.nickname, '철수');
    assert.equal(s.online.state.pending, null);
    assert.equal(server.tokens.get(storage.getItem(TOKEN_KEY)), chulsoo.id);
  });

  test('게이트에서 로그인했는데 연결된 닉네임이 없으면, 닉네임을 정하는 즉시 그 계정에 잇는다', async () => {
    const server = backend();
    const storage = memStorage();
    const s = await returnFromGoogle(server, { storage });
    assert.equal(s.online.state.pending.kind, 'link');
    const r = await s.account.setNickname('영희');
    assert.equal(r.ok, true);
    for (let i = 0; i < 20 && !s.online.state.linked.length; i += 1) await new Promise((res) => setTimeout(res, 5));
    assert.deepEqual(s.online.state.linked, ['google']);
    assert.equal(server.players.get(server.ids.get('google:google-sub-1')).name, '영희');
  });

  test('로그아웃: 연결한 계정이 있을 때만. 끊은 뒤에는 새 기기처럼 닉네임이 없다', async () => {
    const server = backend();
    server.add('철수', T_OLD);
    const storage = memStorage({ [TOKEN_KEY]: T_OLD, 'skalafps.profile.v1': savedProfile('철수') });
    const s = setup({ storage, server });
    await s.online.ready;
    assert.equal((await s.online.logout()).reason, 'unlinked');
    assert.equal(storage.getItem(TOKEN_KEY), T_OLD);

    server.ids.set('google:google-sub-1', 1);
    await s.online.refresh();
    assert.equal((await s.online.logout()).ok, true);
    assert.notEqual(storage.getItem(TOKEN_KEY), T_OLD);
    assert.equal(s.account.profile.nickname, '');
    assert.equal(s.account.hasNickname(), false);
  });
});

describe('코인 · 테스트 결제', () => {
  async function ready(coins = 0) {
    const server = backend();
    server.add('철수', T_OLD, { coins });
    const storage = memStorage({ [TOKEN_KEY]: T_OLD, 'skalafps.profile.v1': savedProfile('철수') });
    const s = setup({ href: `${GAME}?debug=1#menu`, storage, server });
    await s.online.ready;
    return s;
  }

  test('충전: 주문을 만들고 API 서버의 결제 페이지로 떠난다. 돌아올 주소에는 해시가 없다', async () => {
    const s = await ready();
    assert.equal(s.online.state.coins, 0);
    assert.equal((await s.online.buyCoins('coin_100')).ok, true);
    assert.equal(s.server.orders[0].returnUrl, `${GAME}?debug=1`);
    assert.equal(s.loc.assigned[0], `${API}/pay/checkout?order=${s.server.orders[0].orderId}`);
  });

  test('결제 페이지가 API 서버 주소가 아니면 따라가지 않는다', async () => {
    const s = await ready();
    s.server.checkoutUrl = 'https://evil.test/pay';
    assert.equal((await s.online.buyCoins('coin_100')).ok, false);
    assert.equal(s.loc.assigned.length, 0);
  });

  test('결제를 마치고 돌아오면 결과를 알리고 상점 코인 탭을 연다', async () => {
    const server = backend();
    server.add('철수', T_OLD, { coins: 100 });
    const storage = memStorage({ [TOKEN_KEY]: T_OLD, 'skalafps.profile.v1': savedProfile('철수') });
    const s = setup({ href: `${GAME}#skala-pay=done&order=skala_x&coins=100`, storage, server });
    await s.online.ready;
    assert.equal(s.hist.calls[0], GAME, '결과 해시를 지운다');
    const n = s.online.takeNotice();
    assert.equal(n.tone, 'ok');
    assert.equal(n.open, 'shop');
    assert.equal(n.tab, 'coins');
    assert.equal(s.online.takeNotice(), null, '한 번만 가져간다');
    assert.equal(s.online.state.coins, 100);

    const f = setup({ href: `${GAME}#skala-pay=fail&code=PAY_PROCESS_CANCELED`, storage, server });
    await f.online.ready;
    assert.equal(f.online.state.message.text, '결제를 취소했어요.');
  });

  test('코인으로 꾸미기를 사면 서버가 준 owned가 프로필에 들어온다', async () => {
    const s = await ready(100);
    const r = await s.online.buyWithCoins('av_scout');
    assert.equal(r.ok, true);
    assert.equal(s.online.state.coins, 70);
    assert.ok(s.account.isOwned('av_scout'));
    assert.equal((await s.online.buyWithCoins('ar_rapid')).ok, false, '무기는 코인으로 사지 않는다');
    assert.equal(s.server.count('POST /shop/coins'), 1);
  });

  test('환불하면 구매 내역과 코인을 다시 받는다', async () => {
    const s = await ready(100);
    s.server.orders.push({ orderId: 'skala_1', player: 1, product: 'coin_100', coins: 100, amount: 1000, status: 'DONE', refundable: true });
    await s.online.refresh();
    assert.equal(s.online.state.orders[0].refundable, true);
    const r = await s.online.refund('skala_1');
    assert.equal(r.ok, true);
    assert.equal(s.online.state.coins, 0);
    assert.equal(s.online.state.orders[0].status, 'CANCELED');
  });
});
