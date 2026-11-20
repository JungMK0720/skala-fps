/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 로그인 연결과 코인(테스트 결제)의 브라우저 쪽 흐름. account.online으로 화면에 내보낸다. API 주소(SKALA_CONFIG.api.url)가 없으면 꺼진다.
 *          로그인: 인가 화면 → 돌아온 code를 서버가 검증 → 로그인 표 → (연결된 계정이 없으면) 이 기기의 닉네임에 잇기 /
 *                  (있으면) 이 기기에 그 계정으로 로그인: 새 토큰을 만들어 서버에 더하고 기기 토큰을 바꾼다. 다른 닉네임이 있는 기기는 먼저 묻는다.
 *          코인: 충전은 주문을 만들고 결제 페이지(Worker)로 떠난다. 돌아오면 #skala-pay=… 결과를 알린다. 환불·코인으로 사기는 서버가 정한 값을 따른다.
 *          게임 화면은 state(읽기 전용 스냅샷)를 그리고, 결과 알림은 bus 'account:notice'와 takeNotice()로 받는다.
 */
import { createApi } from './api.js';
import { coinPriceOf } from './economy.js';
import {
  OAUTH_MAX_AGE_MS, authorizeUrl, cleanedUrl, createPendingStore, pkceChallenge, randomB64url, readCallback, readPayResult, redirectUriOf
} from './oauth.js';

const TICKET_MS = 9 * 60 * 1000;   // 서버의 로그인 표는 10분짜리다. 화면에서 기다리는 표는 조금 일찍 버린다

const ERRORS = {
  network: '서버에 연결하지 못했어요. 잠시 뒤 다시 시도해 주세요.',
  offline: '지금은 쓸 수 없어요.',
  OAUTH_EXCHANGE: '로그인을 마치지 못했어요. 다시 시도해 주세요.',
  ID_TOKEN_INVALID: '로그인 정보를 확인하지 못했어요. 다시 시도해 주세요.',
  TICKET_EXPIRED: '로그인 시간이 지났어요. 다시 로그인해 주세요.',
  TICKET_INVALID: '로그인 정보를 확인하지 못했어요. 다시 로그인해 주세요.',
  TICKET_USED: '이미 쓴 로그인이에요. 다시 로그인해 주세요.',
  LOGIN_OFF: '지금은 로그인을 쓸 수 없어요.',
  PROVIDER_OFF: '지금은 이 계정으로 로그인할 수 없어요.',
  PROVIDER_LINKED: '이 닉네임은 같은 서비스의 다른 계정과 이미 연결돼 있어요.',
  NOT_FOUND: '닉네임이 아직 서버에 등록되지 않았어요. 잠시 뒤 다시 시도해 주세요.',
  NOT_LINKED: '연결한 계정이 없어요. 먼저 계정을 연결해 주세요.',
  TOKEN_TAKEN: '로그인을 마치지 못했어요. 다시 시도해 주세요.',
  PAY_OFF: '지금은 테스트 결제를 쓸 수 없어요.',
  RATE_LIMITED: '요청이 많아요. 잠시 뒤 다시 시도해 주세요.',
  BAD_RETURN_URL: '이 주소에서는 결제를 열 수 없어요.',
  ORDER_STATE: '이미 처리한 주문이에요.',
  COINS_SPENT: '그 주문의 코인을 이미 써서 환불할 수 없어요.',
  PENDING: '환불을 확인하는 중이에요. 잠시 뒤 구매 내역을 다시 확인해 주세요.',
  CANCEL_FAILED: '환불을 마치지 못했어요. 코인은 그대로예요.',
  OWNED: '이미 가지고 있어요.',
  ITEM_INVALID: '코인으로 살 수 없는 물건이에요.'
};

const PAY_FAIL = {
  PAY_PROCESS_CANCELED: '결제를 취소했어요.',
  PAY_PROCESS_ABORTED: '결제가 중간에 멈췄어요. 다시 시도해 주세요.',
  REJECT_CARD_COMPANY: '카드사에서 결제를 거절했어요.',
  AMOUNT_MISMATCH: '결제 금액이 주문과 달라 결제하지 않았어요.',
  ORDER_EXPIRED: '주문 시간이 지나 결제하지 않았어요. 다시 충전해 주세요.',
  SERVER_BUSY: '서버가 바빠 결제를 마치지 못했어요. 다시 시도해 주세요.'
};

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const k of Object.keys(o)) deepFreeze(o[k]);
  }
  return o;
}

const isText = (v, max = 200) => typeof v === 'string' && v.length > 0 && v.length <= max;
/** 인가 화면 주소는 https만(로컬 시험 서버는 http://localhost·127.0.0.1도). javascript: 같은 주소로 보내지 않게 한다 */
const isAuthorizeUrl = (u) => /^https:\/\/[^/]+\//.test(u) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?\//.test(u);
const validProvider = (p) => !!p && isText(p.id, 20) && isText(p.name, 20) && isAuthorizeUrl(String(p.authorizeUrl || '')) && isText(p.clientId, 300);

function readOrders(list) {
  return (Array.isArray(list) ? list : []).filter((o) => o && isText(o.orderId, 64)).slice(0, 10).map((o) => ({
    orderId: o.orderId,
    product: typeof o.product === 'string' ? o.product : '',
    coins: Number.isInteger(o.coins) ? o.coins : 0,
    amount: Number.isInteger(o.amount) ? o.amount : 0,
    status: typeof o.status === 'string' ? o.status : '',
    at: Number.isFinite(o.at) ? o.at : 0,
    refundable: o.refundable === true
  }));
}

/**
 * opts: { fetch?, config?: { url }, session?, location?, history?, hooks }
 * hooks(계정이 넘긴다): token(), registered(), nickname(), fetchProfile(token) → Promise<{ ok, profile }>, freshToken(),
 *                       switchToken(token, serverProfile?) → Promise, adoptOwned(list), flush() → Promise, announce(), emit(event, payload),
 *                       ready(Promise: 시작 동기화)
 */
export function createOnline({ fetch: fetchImpl, config, session, location, history, hooks }) {
  const api = createApi({ fetch: fetchImpl, config });
  const pendingStore = createPendingStore(session);
  const loc = location || globalThis.location;
  const hist = history || globalThis.history;

  let status = api.enabled ? 'checking' : 'off';   // off(API 주소 없음) · checking · ready · error(서버에 닿지 못함)
  let providers = [];
  let pay = { enabled: false, test: true, products: [], dailyLimit: 0, refundDays: 0 };
  let coinsEnabled = false;
  let me = null;          // { name, coins, providers, orders }
  let busy = null;        // 'login' | 'logout' | 'pay' | 'refund' | 'coins'
  let message = null;     // { tone, text } 마지막 결과(계정 연결 칸·상점 코인 칸·게이트가 보여 준다)
  let pending = null;     // { kind:'switch'|'link', ticket, provider, providerName, name?, at }
  let notice = null;      // 게임이 가져갈 알림 { tone, text, open, tab }
  let snapshot = null;
  let disposed = false;

  const errorText = (r) => {
    const key = (r && (r.error || r.reason)) || 'network';
    if (key === 'IDENTITY_TAKEN') return r.name ? `이 계정은 이미 '${r.name}' 닉네임에 연결돼 있어요.` : '이 계정은 이미 다른 닉네임에 연결돼 있어요.';
    if (key === 'DAILY_LIMIT') return `테스트 결제는 24시간에 ${Number.isInteger(r.limit) ? r.limit : pay.dailyLimit}번까지예요.`;
    if (key === 'REFUND_EXPIRED') return `결제한 지 ${pay.refundDays}일이 지나 환불할 수 없어요.`;
    if (key === 'COINS_SHORT') return Number.isInteger(r.price) && Number.isInteger(r.coins) ? `코인이 모자라요. ${r.price - r.coins}개 더 필요해요.` : '코인이 모자라요.';
    return ERRORS[key] || ERRORS.network;
  };

  function changed() {
    snapshot = null;
    if (!disposed) hooks.announce();
  }

  function say(tone, text) {
    message = text ? { tone, text } : null;
  }

  /** 게임에 알린다(토스트, 필요하면 화면 열기). 게이트에서 보는 결과는 message로 충분해 open을 비운다 */
  function tell(tone, text, open = null, tab = null) {
    notice = { tone, text, open, tab };
    if (!disposed) hooks.emit('account:notice', { tone, text, open, tab });
  }

  const providerName = (id) => (providers.find((p) => p.id === id) || { name: id }).name;
  const expired = (p) => !p || Date.now() - p.at > TICKET_MS;

  // ───────────── 서버 기능 · 내 정보 ─────────────
  async function loadFeatures() {
    const r = await api.features();
    if (disposed) return;
    if (r && r.ok) {
      providers = (r.login && Array.isArray(r.login.providers) ? r.login.providers : []).filter(validProvider).map((p) => ({
        id: p.id, name: p.name, authorizeUrl: p.authorizeUrl, clientId: p.clientId,
        scope: typeof p.scope === 'string' ? p.scope : 'openid', params: p.params && typeof p.params === 'object' ? { ...p.params } : {}
      }));
      const pp = r.pay && typeof r.pay === 'object' ? r.pay : {};
      pay = {
        enabled: pp.enabled === true,
        test: pp.test !== false,
        dailyLimit: Number.isInteger(pp.dailyLimit) ? pp.dailyLimit : 0,
        refundDays: Number.isInteger(pp.refundDays) ? pp.refundDays : 0,
        products: (Array.isArray(pp.products) ? pp.products : [])
          .filter((p) => p && isText(p.id, 32) && isText(p.name, 40) && Number.isInteger(p.coins) && Number.isInteger(p.amount))
          .map((p) => ({ id: p.id, name: p.name, coins: p.coins, amount: p.amount }))
      };
      coinsEnabled = !!(r.coins && r.coins.enabled === true);
      status = 'ready';
    } else {
      status = 'error';
    }
    changed();
  }

  /** 이름·코인·이은 제공자·구매 내역을 다시 받는다 */
  async function refresh() {
    if (status !== 'ready' || !hooks.registered()) {
      if (me) { me = null; changed(); }
      return { ok: false, reason: 'offline' };
    }
    const r = await api.me({ token: hooks.token() });
    if (disposed) return r;
    if (r.ok) {
      me = {
        name: typeof r.name === 'string' ? r.name : '',
        coins: Number.isInteger(r.coins) ? r.coins : 0,
        providers: (Array.isArray(r.providers) ? r.providers : []).filter((p) => typeof p === 'string'),
        orders: readOrders(r.orders)
      };
    } else if (r.error === 'NOT_FOUND' || r.error === 'TOKEN_INVALID') {
      me = null;
    }
    changed();
    return r;
  }

  // ───────────── 로그인 ─────────────
  async function startLogin(id) {
    if (busy) return { ok: false, reason: 'busy' };
    const p = providers.find((x) => x.id === id);
    if (status !== 'ready' || !p || !loc) {
      say('bad', ERRORS.LOGIN_OFF);
      changed();
      return { ok: false, reason: 'off' };
    }
    busy = 'login';
    say(null);
    changed();
    try {
      await hooks.flush();   // 다른 페이지로 떠나기 전에 진행 상황을 서버에 올린다
      const verifier = randomB64url(32);
      const record = { v: 1, provider: p.id, state: randomB64url(16), nonce: randomB64url(24), verifier, redirectUri: redirectUriOf(loc), at: Date.now() };
      const url = authorizeUrl(p, { redirectUri: record.redirectUri, state: record.state, nonce: record.nonce, challenge: await pkceChallenge(verifier) });
      pendingStore.save(record);
      loc.assign(url);
      return { ok: true };
    } catch (_) {
      busy = null;
      say('bad', '로그인 화면을 열지 못했어요. 다시 시도해 주세요.');
      changed();
      return { ok: false, reason: 'error' };
    }
  }

  async function linkNow(provider, ticket) {
    busy = 'login';
    changed();
    const r = await api.link({ ticket, token: hooks.token() });
    busy = null;
    if (disposed) return r;
    const name = providerName(provider);
    if (r.ok) {
      const text = r.already ? `이미 ${name} 계정과 연결된 닉네임이에요.` : `${name} 계정을 연결했어요. 다른 기기에서도 ${name}로 로그인하면 이 닉네임을 써요.`;
      say('ok', text);
      tell('ok', text, 'mypage');
      await refresh();
    } else {
      say('bad', errorText(r));
      tell('bad', errorText(r), 'mypage');
      changed();
    }
    return r;
  }

  async function loginNow(provider, ticket) {
    busy = 'login';
    changed();
    const fresh = hooks.freshToken();
    const r = await api.login({ ticket, newToken: fresh });
    if (disposed) return r;
    if (!r.ok) {
      busy = null;
      say('bad', errorText(r));
      changed();
      return r;
    }
    // 서버가 새 토큰을 그 계정에 더했다. 기기 토큰을 바꾸기 전에 그 토큰으로 프로필을 받아 둔다. 못 받으면 바꾸지 않는다:
    // 이미 행이 있는 토큰으로 빈 프로필을 들고 있다가 닉네임을 정하면 불러온 계정의 이름과 진행 상황을 덮어쓰기 때문이다
    const prof = await hooks.fetchProfile(fresh);
    if (disposed) return prof;
    if (!prof || !prof.ok || !prof.profile) {
      busy = null;
      say('bad', '닉네임을 불러오지 못했어요. 잠시 뒤 다시 로그인해 주세요.');
      changed();
      return { ok: false, reason: 'profile' };
    }
    pending = null;
    me = null;
    await hooks.switchToken(fresh, prof.profile);   // 이 기기의 프로필을 그 계정의 서버 프로필로 바꾼다
    busy = null;
    const text = `${providerName(provider)}로 '${r.name}' 닉네임을 불러왔어요.`;
    say('ok', text);
    tell('ok', text);
    await refresh();
    return r;
  }

  /** 인가 화면에서 돌아왔다 */
  async function handleCallback(cb) {
    const rec = pendingStore.take();
    if (!rec || rec.state !== cb.state || Date.now() - Number(rec.at || 0) > OAUTH_MAX_AGE_MS) {
      if (cb.state || rec) {
        say('bad', '로그인 요청을 확인하지 못했어요. 다시 시작해 주세요.');
        changed();
      }
      return;
    }
    if (cb.error) {
      say('warn', '로그인을 취소했어요.');
      changed();
      return;
    }
    const p = providers.find((x) => x.id === rec.provider);
    if (!p) {
      say('bad', ERRORS.LOGIN_OFF);
      changed();
      return;
    }
    busy = 'login';
    changed();
    const ex = await api.exchange({ provider: p.id, code: cb.code, codeVerifier: rec.verifier, redirectUri: rec.redirectUri, nonce: rec.nonce });
    busy = null;
    if (disposed) return;
    if (!ex.ok || typeof ex.ticket !== 'string') {
      say('bad', errorText(ex));
      if (hooks.registered()) tell('bad', errorText(ex), 'mypage');
      changed();
      return;
    }
    const linkedName = typeof ex.linkedName === 'string' && ex.linkedName ? ex.linkedName : null;
    if (!linkedName) {
      if (hooks.registered()) return linkNow(p.id, ex.ticket);
      // 아직 닉네임이 없는 기기: 닉네임을 정하면(onRegistered) 이 표로 잇는다
      pending = { kind: 'link', ticket: ex.ticket, provider: p.id, providerName: p.name, at: Date.now() };
      say('warn', `이 ${p.name} 계정에 연결된 닉네임이 없어요. 닉네임을 정하면 바로 연결할게요.`);
      changed();
      return;
    }
    if (hooks.registered() && linkedName === hooks.nickname()) {
      const text = `이미 ${p.name} 계정과 연결된 닉네임이에요.`;
      say('ok', text);
      tell('ok', text, 'mypage');
      changed();
      return;
    }
    if (hooks.registered()) {
      // 이 기기에는 다른 닉네임이 있다: 바꿀지 먼저 묻는다(마이페이지의 계정 연결 칸)
      pending = { kind: 'switch', ticket: ex.ticket, provider: p.id, providerName: p.name, name: linkedName, at: Date.now() };
      say('warn', `이 ${p.name} 계정은 '${linkedName}' 닉네임에 연결돼 있어요.`);
      tell('warn', `이 ${p.name} 계정은 '${linkedName}' 닉네임에 연결돼 있어요. 요원 기록부에서 이 기기를 바꿀지 골라 주세요.`, 'mypage');
      changed();
      return;
    }
    await loginNow(p.id, ex.ticket);
  }

  async function confirmSwitch() {
    if (busy || !pending || pending.kind !== 'switch') return { ok: false, reason: 'none' };
    const p = pending;
    if (expired(p)) {
      pending = null;
      say('bad', ERRORS.TICKET_EXPIRED);
      changed();
      return { ok: false, reason: 'expired' };
    }
    await hooks.flush();
    return loginNow(p.provider, p.ticket);
  }

  function cancelSwitch() {
    if (!pending) return;
    pending = null;
    say(null);
    changed();
  }

  /** 이 기기의 닉네임이 서버에 등록됐다(닉네임 등록·동기화 뒤 계정이 부른다) */
  function onRegistered() {
    if (disposed || status !== 'ready') return;
    if (pending && pending.kind === 'link') {
      const p = pending;
      pending = null;
      if (!expired(p)) {
        linkNow(p.provider, p.ticket);
        return;
      }
      say('bad', `${p.providerName} 로그인 시간이 지나 연결하지 못했어요. 요원 기록부에서 다시 연결해 주세요.`);
    }
    refresh();
  }

  async function logout() {
    if (busy) return { ok: false, reason: 'busy' };
    if (status !== 'ready' || !hooks.registered()) return { ok: false, reason: 'off' };
    if (!me || !me.providers.length) {
      say('bad', '연결한 계정이 없어요. 연결하지 않은 닉네임은 로그아웃하면 다시 찾을 수 없어요.');
      changed();
      return { ok: false, reason: 'unlinked' };
    }
    busy = 'logout';
    changed();
    await hooks.flush();
    const r = await api.logout({ token: hooks.token() });
    if (disposed) return r;
    if (!r.ok) {
      busy = null;
      say('bad', errorText(r));
      changed();
      return r;
    }
    me = null;
    pending = null;
    await hooks.switchToken(hooks.freshToken());   // 새 기기처럼: 닉네임 게이트가 뜬다
    busy = null;
    say('ok', '이 기기에서 로그아웃했어요. 연결한 계정으로 다시 로그인하면 이어서 할 수 있어요.');
    changed();
    return { ok: true };
  }

  // ───────────── 코인 · 테스트 결제 ─────────────
  function canPay() {
    if (status !== 'ready' || !pay.enabled) return ERRORS.PAY_OFF;
    if (!hooks.registered()) return '닉네임이 서버에 등록된 뒤에 충전할 수 있어요.';
    return '';
  }

  async function buyCoins(productId) {
    if (busy) return { ok: false, reason: 'busy' };
    const why = canPay();
    const product = pay.products.find((p) => p.id === productId);
    if (why || !product) {
      say('bad', why || '모르는 상품이에요.');
      changed();
      return { ok: false, reason: 'off' };
    }
    busy = 'pay';
    say(null);
    changed();
    await hooks.flush();
    const r = await api.createOrder({ token: hooks.token(), productId, returnUrl: cleanedUrl(loc).split('#')[0] });
    if (disposed) return r;
    // 결제 페이지는 API 서버 주소에만 있다. 다른 주소로 보내라는 응답은 따르지 않는다
    if (!r.ok || typeof r.checkoutUrl !== 'string' || !r.checkoutUrl.startsWith(`${api.url}/pay/checkout?order=`)) {
      busy = null;
      say('bad', r.ok ? ERRORS.network : errorText(r));
      changed();
      return r.ok ? { ok: false, reason: 'network' } : r;
    }
    loc.assign(r.checkoutUrl);
    return { ok: true };
  }

  function handlePayResult(res) {
    let tone = 'bad';
    let text;
    if (res.kind === 'done') {
      tone = 'ok';
      text = res.coins != null ? `코인 충전을 마쳤어요. 지금 코인 ${res.coins.toLocaleString('ko-KR')}개예요(테스트 결제).` : '코인 충전을 마쳤어요(테스트 결제).';
    } else if (res.kind === 'pending') {
      tone = 'warn';
      text = '결제를 확인하는 중이에요. 잠시 뒤 구매 내역을 다시 확인해 주세요.';
    } else {
      tone = res.code === 'PAY_PROCESS_CANCELED' ? 'warn' : 'bad';
      text = PAY_FAIL[res.code] || `결제를 마치지 못했어요${res.code ? ` (${res.code})` : ''}.`;
    }
    say(tone, text);
    tell(tone, text, 'shop', 'coins');
    changed();
  }

  async function refund(orderId) {
    if (busy) return { ok: false, reason: 'busy' };
    if (status !== 'ready' || !hooks.registered()) return { ok: false, reason: 'off' };
    busy = 'refund';
    changed();
    const r = await api.cancelOrder({ token: hooks.token(), orderId });
    busy = null;
    if (disposed) return r;
    if (r.ok) say('ok', '환불했어요(테스트 결제 취소). 그 주문의 코인은 빠졌어요.');
    else say(r.error === 'PENDING' ? 'warn' : 'bad', errorText(r));
    await refresh();
    return r;
  }

  async function buyWithCoins(itemId) {
    if (busy) return { ok: false, reason: 'busy' };
    const price = coinPriceOf(itemId);
    if (price == null || status !== 'ready' || !coinsEnabled || !hooks.registered()) {
      say('bad', price == null ? ERRORS.ITEM_INVALID : '지금은 코인을 쓸 수 없어요.');
      changed();
      return { ok: false, reason: 'off' };
    }
    busy = 'coins';
    changed();
    const r = await api.buyWithCoins({ token: hooks.token(), itemId });
    busy = null;
    if (disposed) return r;
    if (Array.isArray(r.owned)) hooks.adoptOwned(r.owned);   // 산 물건(이미 가진 경우도)은 서버의 owned에 있다
    if (me && Number.isInteger(r.coins)) me = { ...me, coins: r.coins };
    say(r.ok ? 'ok' : 'bad', r.ok ? `코인 ${price}개로 샀어요.` : errorText(r));
    changed();
    return r.ok ? { ok: true, coins: r.coins, spent: r.spent } : r;
  }

  // ───────────── 시작 ─────────────
  async function boot() {
    if (!api.enabled || !loc) return;
    const cb = readCallback(loc);
    const payRes = readPayResult(loc);
    if (cb || payRes) {
      try { hist.replaceState(hist.state, '', cleanedUrl(loc)); } catch (_) { /* 주소를 못 바꿔도 계속 */ }
    }
    await Promise.all([loadFeatures(), Promise.resolve(hooks.ready).catch(() => null)]);
    if (disposed || status !== 'ready') return;
    if (cb) await handleCallback(cb);
    if (payRes) handlePayResult(payRes);
    if (hooks.registered()) await refresh();
  }

  function state() {
    if (!snapshot) {
      snapshot = deepFreeze({
        status,
        providers: providers.map((p) => ({ id: p.id, name: p.name })),
        linked: me ? [...me.providers] : [],
        name: me ? me.name : null,
        coins: me ? me.coins : null,
        orders: me ? me.orders.map((o) => ({ ...o })) : [],
        pay: { ...pay, products: pay.products.map((p) => ({ ...p })) },
        coinsEnabled,
        busy,
        message: message ? { ...message } : null,
        pending: pending ? { kind: pending.kind, provider: pending.provider, providerName: pending.providerName, name: pending.name || null } : null
      });
    }
    return snapshot;
  }

  const ready = boot();

  return {
    ready,
    onRegistered,
    dispose() { disposed = true; },
    api: Object.freeze({
      get state() { return state(); },
      ready,
      startLogin,
      confirmSwitch,
      cancelSwitch,
      logout,
      refresh,
      buyCoins,
      refund,
      buyWithCoins,
      coinPrice: coinPriceOf,
      /** 아직 보여 주지 않은 결과 알림(결제·로그인을 마치고 돌아왔을 때). 한 번 가져가면 비운다 */
      takeNotice() {
        const n = notice;
        notice = null;
        return n;
      },
      clearMessage() {
        if (!message) return;
        message = null;
        changed();
      }
    })
  };
}
