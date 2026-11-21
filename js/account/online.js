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
import { t, fmtNum } from '../core/i18n.js';
import { coinPriceOf } from './economy.js';
import {
  OAUTH_MAX_AGE_MS, authorizeUrl, cleanedUrl, createPendingStore, pkceChallenge, randomB64url, readCallback, readPayResult, redirectUriOf
} from './oauth.js';

const TICKET_MS = 9 * 60 * 1000;   // 서버의 로그인 표는 10분짜리다. 화면에서 기다리는 표는 조금 일찍 버린다
/** 제공자 id → 화면 이름 키(js/core/lang/account.js). 모르는 제공자는 서버가 보낸 이름을 그대로 쓴다 */
const PROVIDER_NAME_KEYS = Object.freeze({ google: 'account.provider.google', kakao: 'account.provider.kakao' });

const ERRORS = {
  network: t('account.errNetwork'),
  offline: t('account.errOffline'),
  OAUTH_EXCHANGE: t('account.errOauthExchange'),
  ID_TOKEN_INVALID: t('account.errIdTokenInvalid'),
  TICKET_EXPIRED: t('account.errTicketExpired'),
  TICKET_INVALID: t('account.errTicketInvalid'),
  TICKET_USED: t('account.errTicketUsed'),
  LOGIN_OFF: t('account.errLoginOff'),
  PROVIDER_OFF: t('account.errProviderOff'),
  PROVIDER_LINKED: t('account.errProviderLinked'),
  NOT_FOUND: t('account.errNotFound'),
  NOT_LINKED: t('account.errNotLinked'),
  TOKEN_TAKEN: t('account.errOauthExchange'),
  PAY_OFF: t('account.errPayOff'),
  RATE_LIMITED: t('account.errRateLimited'),
  BAD_RETURN_URL: t('account.errBadReturnUrl'),
  ORDER_STATE: t('account.errOrderState'),
  COINS_SPENT: t('account.errCoinsSpent'),
  PENDING: t('account.errPending'),
  CANCEL_FAILED: t('account.errCancelFailed'),
  OWNED: t('account.errOwned'),
  ITEM_INVALID: t('account.errItemInvalid')
};

const PAY_FAIL = {
  PAY_PROCESS_CANCELED: t('account.payPayProcessCanceled'),
  PAY_PROCESS_ABORTED: t('account.payPayProcessAborted'),
  REJECT_CARD_COMPANY: t('account.payRejectCardCompany'),
  AMOUNT_MISMATCH: t('account.payAmountMismatch'),
  ORDER_EXPIRED: t('account.payOrderExpired'),
  SERVER_BUSY: t('account.payServerBusy')
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
    if (key === 'IDENTITY_TAKEN') return r.name ? t('account.identityTakenName', { name: r.name }) : t('account.identityTaken');
    if (key === 'DAILY_LIMIT') return t('account.dailyLimit', { n: Number.isInteger(r.limit) ? r.limit : pay.dailyLimit });
    if (key === 'REFUND_EXPIRED') return t('account.refundExpired', { days: pay.refundDays });
    if (key === 'COINS_SHORT') return Number.isInteger(r.price) && Number.isInteger(r.coins) ? t('account.coinsShortBy', { n: r.price - r.coins }) : t('account.coinsShort');
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
        // 서버는 한국어 이름을 보낸다. 아는 제공자는 화면 언어의 이름으로 바꾼다(언어를 바꾸면 페이지를 다시 읽으므로 한 번만 정하면 된다)
        id: p.id, name: PROVIDER_NAME_KEYS[p.id] ? t(PROVIDER_NAME_KEYS[p.id]) : p.name, authorizeUrl: p.authorizeUrl, clientId: p.clientId,
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
      say('bad', t('account.loginOpenFail'));
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
      const text = r.already ? t('account.alreadyLinked', { name }) : t('account.linkedDone', { name });
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
      say('bad', t('account.loadNameFail'));
      changed();
      return { ok: false, reason: 'profile' };
    }
    pending = null;
    me = null;
    await hooks.switchToken(fresh, prof.profile);   // 이 기기의 프로필을 그 계정의 서버 프로필로 바꾼다
    busy = null;
    const text = t('account.loadedName', { provider: providerName(provider), name: r.name });
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
        say('bad', t('account.loginReqFail'));
        changed();
      }
      return;
    }
    if (cb.error) {
      say('warn', t('account.loginCanceled'));
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
      say('warn', t('account.noLinkedName', { name: p.name }));
      changed();
      return;
    }
    if (hooks.registered() && linkedName === hooks.nickname()) {
      const text = t('account.alreadyLinked', { name: p.name });
      say('ok', text);
      tell('ok', text, 'mypage');
      changed();
      return;
    }
    if (hooks.registered()) {
      // 이 기기에는 다른 닉네임이 있다: 바꿀지 먼저 묻는다(마이페이지의 계정 연결 칸)
      pending = { kind: 'switch', ticket: ex.ticket, provider: p.id, providerName: p.name, name: linkedName, at: Date.now() };
      say('warn', t('account.linkedTo', { provider: p.name, name: linkedName }));
      tell('warn', t('account.linkedToSwitch', { provider: p.name, name: linkedName }), 'mypage');
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
      say('bad', t('account.linkExpired', { provider: p.providerName }));
    }
    refresh();
  }

  async function logout() {
    if (busy) return { ok: false, reason: 'busy' };
    if (status !== 'ready' || !hooks.registered()) return { ok: false, reason: 'off' };
    if (!me || !me.providers.length) {
      say('bad', t('account.logoutNoLink'));
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
    say('ok', t('account.loggedOut'));
    changed();
    return { ok: true };
  }

  // ───────────── 코인 · 테스트 결제 ─────────────
  function canPay() {
    if (status !== 'ready' || !pay.enabled) return ERRORS.PAY_OFF;
    if (!hooks.registered()) return t('account.payNeedName');
    return '';
  }

  async function buyCoins(productId) {
    if (busy) return { ok: false, reason: 'busy' };
    const why = canPay();
    const product = pay.products.find((p) => p.id === productId);
    if (why || !product) {
      say('bad', why || t('account.unknownProduct'));
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
      text = res.coins != null ? t('account.payDoneCoins', { coins: fmtNum(res.coins) }) : t('account.payDone');
    } else if (res.kind === 'pending') {
      tone = 'warn';
      text = t('account.payPending');
    } else {
      tone = res.code === 'PAY_PROCESS_CANCELED' ? 'warn' : 'bad';
      text = PAY_FAIL[res.code] || (res.code ? t('account.payFailCode', { code: res.code }) : t('account.payFail'));
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
    if (r.ok) say('ok', t('account.refunded'));
    else say(r.error === 'PENDING' ? 'warn' : 'bad', errorText(r));
    await refresh();
    return r;
  }

  async function buyWithCoins(itemId) {
    if (busy) return { ok: false, reason: 'busy' };
    const price = coinPriceOf(itemId);
    if (price == null || status !== 'ready' || !coinsEnabled || !hooks.registered()) {
      say('bad', price == null ? ERRORS.ITEM_INVALID : t('account.coinsOff'));
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
    say(r.ok ? 'ok' : 'bad', r.ok ? t('account.boughtCoins', { price }) : errorText(r));
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
