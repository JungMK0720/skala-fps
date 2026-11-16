/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 테스트 결제(토스페이먼츠)와 코인. 주문 만들기 → 결제 페이지(/pay/checkout) → 토스 인증 → successUrl에서 금액 대조 → 승인 API(멱등키) →
 *          한 트랜잭션에 주문 DONE·원장·코인(fps_api_complete_order). 실패·취소는 failUrl, 결과를 모르는 승인·환불은 웹훅과 대사(cron)가 토스에 다시 물어 정리한다.
 *          상품(코인 수·금액)은 이 파일의 PRODUCTS가 정본이다. 브라우저가 보낸 금액은 믿지 않는다.
 *          돈은 승인 API를 부를 때만 움직인다: successUrl의 금액이 주문과 다르면 승인을 부르지 않는다.
 */
import { randomHex } from './crypto.js';
import { isDbFault } from './db.js';
import { cleanReturnUrl, json, readJson, redirect } from './http.js';
import { CHECKOUT_JS, checkoutHtml, messageHtml, pageHeaders } from './pages.js';
import { isUnknownOutcome, keyMode } from './toss.js';

export const PRODUCTS = Object.freeze({
  coin_100: Object.freeze({ id: 'coin_100', name: '코인 100개', coins: 100, amount: 1000 }),
  coin_550: Object.freeze({ id: 'coin_550', name: '코인 550개', coins: 550, amount: 5000 })
});
export const PRODUCT_LIST = Object.freeze(Object.values(PRODUCTS));

export const ORDER_RE = /^skala_[0-9a-f]{32}$/;
export const TOKEN_RE = /^[0-9a-f]{64}$/;
const PAYMENT_KEY_RE = /^[\x21-\x7e]{1,200}$/;
const CODE_RE = /^[A-Za-z0-9_]{1,80}$/;
const ORDER_TTL_SEC = 3600;
const CANCEL_REASON = '구매자 환불 요청(테스트 결제)';

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

export function intEnv(value, fallback, min, max) {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

/**
 * 결제 설정. 클라이언트 키와 시크릿 키가 모두 있고 같은 환경(test_/live_)이어야 켠다.
 * 라이브 키는 PAY_ALLOW_LIVE가 'true'일 때만 쓴다(사업자 계약 전에는 실수로라도 실제 결제가 일어나지 않게).
 */
export function payConfig(env) {
  const clientKey = String(env.TOSS_CLIENT_KEY || '').trim();
  const secretKey = String(env.TOSS_SECRET_KEY || '').trim();
  const base = { dailyLimit: intEnv(env.PAY_DAILY_LIMIT, 3, 0, 100), refundDays: intEnv(env.REFUND_DAYS, 7, 0, 30) };
  if (!clientKey || !secretKey) return { ...base, enabled: false, reason: 'keys' };
  const mode = keyMode(clientKey);
  if (!mode || keyMode(secretKey) !== mode) return { ...base, enabled: false, reason: 'key_mismatch' };
  if (mode === 'live' && env.PAY_ALLOW_LIVE !== 'true') return { ...base, enabled: false, reason: 'live_key' };
  return { ...base, enabled: true, mode, test: mode === 'test', clientKey };
}

/** 결과를 게임 주소의 해시로 붙인다(#skala-pay=done&order=…). 해시라서 게임 서버(GitHub Pages)로 가지 않는다 */
export function resultUrl(returnUrl, { kind, order, code, coins }) {
  const q = new URLSearchParams({ 'skala-pay': kind });
  if (order) q.set('order', order);
  if (code) q.set('code', code);
  if (Number.isInteger(coins)) q.set('coins', String(coins));
  return `${returnUrl}#${q.toString()}`;
}

/** 토스 customerKey(구매자 식별 값). 비회원 결제라 주문마다 무작위인 주문 번호에서 만든다 */
export function customerKeyOf(orderId) {
  return `cust_${orderId.slice(6)}`;
}

const page = (html, status = 200) => new Response(html, { status, headers: pageHeaders() });
const notice = (title, text, returnUrl, status = 200) => page(messageHtml({ title, text, returnUrl }), status);

// ───────────── 주문 만들기 (게임 → POST /pay/orders) ─────────────
export async function createOrder(body, ctx) {
  const cfg = payConfig(ctx.env);
  if (!cfg.enabled) return json({ ok: false, error: 'PAY_OFF', reason: cfg.reason }, 503);
  const product = typeof body.productId === 'string' && hasOwn(PRODUCTS, body.productId) ? PRODUCTS[body.productId] : null;
  const returnUrl = cleanReturnUrl(body.returnUrl, ctx.env.ALLOWED_ORIGINS);
  if (!TOKEN_RE.test(body.token || '') || !product) return json({ ok: false, error: 'BAD_REQUEST' }, 400);
  if (!returnUrl) return json({ ok: false, error: 'BAD_RETURN_URL' }, 400);
  const orderId = `skala_${randomHex(16)}`;
  const r = await ctx.db.call('fps_api_create_order', {
    p_token: body.token, p_order_id: orderId, p_product: product.id, p_coins: product.coins, p_amount: product.amount,
    p_return_url: returnUrl, p_daily_limit: cfg.dailyLimit
  });
  if (!r.ok) return json(r, isDbFault(r) ? 503 : 200);
  ctx.log({ t: 'pay', step: 'order', orderId, product: product.id });
  return json({ ok: true, orderId, checkoutUrl: `${ctx.origin}/pay/checkout?order=${orderId}`, product: product.id, coins: product.coins, amount: product.amount });
}

// ───────────── 결제 페이지 (GET /pay/checkout?order=) ─────────────
export async function checkoutPage(url, ctx) {
  const cfg = payConfig(ctx.env);
  if (!cfg.enabled) return notice('결제를 쓸 수 없어요', '지금은 결제를 열지 않았어요. 게임으로 돌아가 주세요.', null, 503);
  const orderId = url.searchParams.get('order') || '';
  if (!ORDER_RE.test(orderId)) return notice('주문을 찾을 수 없어요', '게임의 상점에서 다시 시작해 주세요.', null, 404);
  const r = await ctx.db.call('fps_api_order', { p_order_id: orderId });
  if (!r.ok) {
    return isDbFault(r)
      ? notice('잠시 뒤 다시 시도해 주세요', '주문 정보를 읽지 못했어요.', null, 503)
      : notice('주문을 찾을 수 없어요', '게임의 상점에서 다시 시작해 주세요.', null, 404);
  }
  const order = r.order;
  if (order.status !== 'READY') return notice('이미 처리한 주문이에요', '구매 결과는 게임의 상점 구매 내역에서 볼 수 있어요.', order.returnUrl);
  if (order.ageSec > ORDER_TTL_SEC) return notice('주문 시간이 지났어요', '한 시간 안에 결제하지 않은 주문은 닫혀요. 상점에서 다시 시작해 주세요.', order.returnUrl);
  const product = hasOwn(PRODUCTS, order.product) ? PRODUCTS[order.product] : null;
  return page(checkoutHtml({
    clientKey: cfg.clientKey,
    order,
    orderName: product ? product.name : `코인 ${order.coins}개`,
    customerKey: customerKeyOf(orderId),
    successUrl: `${ctx.origin}/pay/success`,
    // 주문 번호는 경로에 넣는다: 토스가 결제창 취소(PAY_PROCESS_CANCELED)에는 orderId를 붙이지 않고, 쿼리가 이미 있는 주소에 붙이는 방식에 기대지 않게
    failUrl: `${ctx.origin}/pay/fail/${orderId}`,
    returnUrl: order.returnUrl,
    test: cfg.test,
    refundDays: cfg.refundDays
  }));
}

export function checkoutScript() {
  return new Response(CHECKOUT_JS, {
    headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=300', 'x-content-type-options': 'nosniff' }
  });
}

// ───────────── 토스 기록에 맞추기 (승인 응답·조회·웹훅·대사가 함께 쓴다) ─────────────
/**
 * 토스가 알려 준 결제(Payment 객체)로 주문을 맞춘다. → { kind:'done'|'fail'|'pending', order, code?, coins?, retry? }
 * retry = DB 쪽 문제라 나중에 다시 해야 한다(웹훅은 500으로 답해 재전송을 받는다).
 */
export async function settlePayment(ctx, payment, orderId) {
  if (!payment || payment.orderId !== orderId) return { kind: 'fail', order: orderId, code: 'ORDER_MISMATCH' };
  const status = payment.status;
  if (status === 'DONE') {
    const r = await ctx.db.call('fps_api_complete_order', {
      p_order_id: orderId, p_payment_key: payment.paymentKey, p_amount: payment.totalAmount,
      p_method: typeof payment.method === 'string' ? payment.method : null
    });
    if (r.ok) {
      if (!r.already) ctx.log({ t: 'pay', step: 'done', orderId, coins: r.coins });
      return { kind: 'done', order: orderId, coins: r.coins };
    }
    if (isDbFault(r)) return { kind: 'pending', order: orderId, retry: true };
    ctx.log({ t: 'pay', step: 'done_rejected', level: 'error', orderId, error: r.error });   // 토스는 DONE인데 주문과 맞지 않는다: 사람이 봐야 한다
    return { kind: 'fail', order: orderId, code: r.error };
  }
  if (status === 'CANCELED' || status === 'PARTIAL_CANCELED') {
    const r = await ctx.db.call('fps_api_external_cancel', { p_order_id: orderId });
    if (isDbFault(r)) return { kind: 'pending', order: orderId, retry: true };
    ctx.log({ t: 'pay', step: 'external_cancel', orderId, taken: r.taken });
    return { kind: 'fail', order: orderId, code: 'CANCELED' };
  }
  if (status === 'ABORTED' || status === 'EXPIRED') {
    const r = await ctx.db.call('fps_api_fail_order', { p_order_id: orderId, p_code: status });
    if (isDbFault(r)) return { kind: 'pending', order: orderId, retry: true };
    return { kind: 'fail', order: orderId, code: status };
  }
  return { kind: 'pending', order: orderId };   // READY · IN_PROGRESS · WAITING_FOR_DEPOSIT: 아직 끝나지 않았다
}

/** 승인 API를 부르고 결과를 주문에 맞춘다 */
async function confirmAndSettle(ctx, { orderId, paymentKey, amount }) {
  const c = await ctx.toss.confirm(paymentKey, orderId, amount);
  if (c.ok) return settlePayment(ctx, c.payment, orderId);
  if (c.code === 'ALREADY_PROCESSED_PAYMENT') {
    const g = await ctx.toss.get(paymentKey);
    return g.ok ? settlePayment(ctx, g.payment, orderId) : { kind: 'pending', order: orderId };
  }
  if (isUnknownOutcome(c)) {
    ctx.log({ t: 'pay', step: 'confirm_unknown', orderId, status: c.status, code: c.code });
    return { kind: 'pending', order: orderId };   // CONFIRMING으로 남겨 대사가 정리한다
  }
  await ctx.db.call('fps_api_fail_order', { p_order_id: orderId, p_code: c.code });
  ctx.log({ t: 'pay', step: 'confirm_failed', orderId, code: c.code });
  return { kind: 'fail', order: orderId, code: c.code };
}

// ───────────── 결제 성공 (토스 → GET /pay/success?paymentKey&orderId&amount) ─────────────
export async function success(url, ctx) {
  const q = url.searchParams;
  const paymentKey = q.get('paymentKey') || '';
  const orderId = q.get('orderId') || '';
  const amount = Number(q.get('amount'));
  if (!ORDER_RE.test(orderId) || !PAYMENT_KEY_RE.test(paymentKey) || !Number.isInteger(amount) || amount <= 0) {
    return notice('결제 정보를 읽지 못했어요', '게임으로 돌아가 구매 내역을 확인해 주세요.', null, 400);
  }
  const found = await ctx.db.call('fps_api_order', { p_order_id: orderId });
  if (!found.ok) {
    return isDbFault(found)
      ? notice('잠시 뒤 다시 시도해 주세요', '주문 정보를 읽지 못했어요. 이 화면을 새로 고치면 이어서 처리해요.', null, 503)
      : notice('주문을 찾을 수 없어요', '게임의 상점에서 다시 시작해 주세요.', null, 404);
  }
  const back = found.order.returnUrl;
  const mark = await ctx.db.call('fps_api_mark_confirming', { p_order_id: orderId, p_payment_key: paymentKey, p_amount: amount });
  if (!mark.ok) {
    if (mark.error === 'AMOUNT_MISMATCH') ctx.log({ t: 'pay', step: 'amount_mismatch', level: 'warn', orderId, amount });
    const code = isDbFault(mark) ? 'SERVER_BUSY' : mark.error;
    return redirect(resultUrl(back, { kind: 'fail', order: orderId, code }));
  }
  if (mark.status === 'DONE') return redirect(resultUrl(back, { kind: 'done', order: orderId }));   // 새로 고침
  const settled = await confirmAndSettle(ctx, { orderId, paymentKey, amount });
  return redirect(resultUrl(back, settled));
}

// ───────────── 결제 실패·취소 (토스 → GET /pay/fail/<orderId>?code&message) ─────────────
export async function fail(url, ctx) {
  const q = url.searchParams;
  const orderId = url.pathname.split('/')[3] || q.get('orderId') || '';
  const raw = q.get('code') || '';
  const code = CODE_RE.test(raw) ? raw : 'UNKNOWN';
  if (!ORDER_RE.test(orderId)) return notice('결제를 마치지 못했어요', '게임으로 돌아가 다시 시도해 주세요.', null);
  const found = await ctx.db.call('fps_api_order', { p_order_id: orderId });
  if (!found.ok) return notice('결제를 마치지 못했어요', '게임으로 돌아가 다시 시도해 주세요.', null);
  // 결제창에서 돌아온 실패는 아직 승인을 부르지 않은 주문(READY)에만 적는다. 승인 중인 주문은 승인 결과가 정한다
  if (found.order.status === 'READY') await ctx.db.call('fps_api_fail_order', { p_order_id: orderId, p_code: code });
  return redirect(resultUrl(found.order.returnUrl, { kind: 'fail', order: orderId, code }));
}

// ───────────── 웹훅 (토스 → POST /pay/webhook, 개발자센터에 등록) ─────────────
/**
 * PAYMENT_STATUS_CHANGED만 본다. 본문은 믿지 않고 paymentKey로 토스에 다시 물어 그 기록으로 맞춘다(웹훅 본문에는 서명이 없다).
 * 10초 안에 200으로 답한다. DB 쪽 문제로 처리하지 못했으면 500으로 답해 토스가 다시 보내게 한다(최대 7번, 약 3일 19시간).
 */
export async function webhook(request, ctx) {
  const body = await readJson(request, 65536);
  if (!body) return json({ ok: false, error: 'BAD_REQUEST' }, 400);
  if (body.eventType !== 'PAYMENT_STATUS_CHANGED') return json({ ok: true, ignored: true });
  const data = body.data && typeof body.data === 'object' ? body.data : {};
  const orderId = typeof data.orderId === 'string' ? data.orderId : '';
  const paymentKey = typeof data.paymentKey === 'string' ? data.paymentKey : '';
  if (!ORDER_RE.test(orderId) || !PAYMENT_KEY_RE.test(paymentKey)) return json({ ok: true, ignored: true });
  if (!payConfig(ctx.env).enabled) return json({ ok: false, error: 'PAY_OFF' }, 503);
  const g = await ctx.toss.get(paymentKey);
  if (!g.ok) return isUnknownOutcome(g) ? json({ ok: false, error: 'TOSS_UNAVAILABLE' }, 502) : json({ ok: true, ignored: true });
  const s = await settlePayment(ctx, g.payment, orderId);
  if (s.retry) return json({ ok: false, error: 'RETRY' }, 500);
  return json({ ok: true, result: s.kind });
}

// ───────────── 환불 (게임 → POST /pay/cancel) ─────────────
export async function cancelOrder(body, ctx) {
  const cfg = payConfig(ctx.env);
  if (!cfg.enabled) return json({ ok: false, error: 'PAY_OFF', reason: cfg.reason }, 503);
  if (!TOKEN_RE.test(body.token || '') || !ORDER_RE.test(body.orderId || '')) return json({ ok: false, error: 'BAD_REQUEST' }, 400);
  const begun = await ctx.db.call('fps_api_begin_cancel', { p_token: body.token, p_order_id: body.orderId, p_refund_days: cfg.refundDays });
  if (!begun.ok) return json(begun, isDbFault(begun) ? 503 : 200);
  const t = await ctx.toss.cancel(begun.paymentKey, CANCEL_REASON, body.orderId);
  if (t.ok || t.code === 'ALREADY_CANCELED_PAYMENT') {
    const done = await ctx.db.call('fps_api_end_cancel', { p_order_id: body.orderId, p_ok: true });
    ctx.log({ t: 'pay', step: 'refund', orderId: body.orderId });
    return json({ ok: true, status: 'CANCELED', coins: Number.isInteger(done.coins) ? done.coins : begun.coins });
  }
  if (isUnknownOutcome(t)) {
    ctx.log({ t: 'pay', step: 'refund_unknown', orderId: body.orderId, status: t.status, code: t.code });
    return json({ ok: false, error: 'PENDING', coins: begun.coins });   // CANCELING으로 남겨 대사가 정리한다
  }
  const undone = await ctx.db.call('fps_api_end_cancel', { p_order_id: body.orderId, p_ok: false });
  ctx.log({ t: 'pay', step: 'refund_failed', orderId: body.orderId, code: t.code });
  return json({ ok: false, error: 'CANCEL_FAILED', code: t.code, coins: undone.coins });
}

// ───────────── 코인으로 꾸미기 사기 (게임 → POST /shop/coins) ─────────────
export async function buyWithCoins(body, ctx) {
  const item = body.itemId;
  if (!TOKEN_RE.test(body.token || '') || typeof item !== 'string' || !/^[A-Za-z0-9_]{1,32}$/.test(item)) {
    return json({ ok: false, error: 'BAD_REQUEST' }, 400);
  }
  const r = await ctx.db.call('fps_api_buy_with_coins', { p_token: body.token, p_item: item });
  if (r.ok) ctx.log({ t: 'coins', step: 'spend', item, spent: r.spent });
  return json(r, isDbFault(r) ? 503 : 200);
}

// ───────────── 대사 (cron) ─────────────
/**
 * 결과를 모르는 주문(승인을 불렀는데 응답을 못 받은 CONFIRMING, 취소를 불렀는데 응답을 못 받은 CANCELING)을 토스 기록에 맞춘다.
 * 한 시간 넘게 결제하지 않은 READY는 DB가 EXPIRED로 바꾼다(fps_api_open_orders).
 */
export async function reconcile(ctx) {
  if (!payConfig(ctx.env).enabled) return { ok: false, reason: 'pay_off' };
  const list = await ctx.db.call('fps_api_open_orders', { p_limit: 20 });
  if (!list.ok) return { ok: false, reason: list.error };
  let fixed = 0;
  for (const o of list.orders || []) {
    if (!o.paymentKey) continue;
    const g = await ctx.toss.get(o.paymentKey);
    if (!g.ok) {
      if (g.status === 404 && o.status === 'CONFIRMING') {
        await ctx.db.call('fps_api_fail_order', { p_order_id: o.orderId, p_code: 'NOT_FOUND_PAYMENT' });
        fixed += 1;
      }
      continue;
    }
    const p = g.payment;
    if (o.status === 'CONFIRMING') {
      if ((p.status === 'IN_PROGRESS' || p.status === 'READY') && o.idleSec > 900) {
        // 인증은 됐지만 승인이 끝나지 않았고 승인 가능 시간(10분)도 지났다: 돈은 움직이지 않는다
        await ctx.db.call('fps_api_fail_order', { p_order_id: o.orderId, p_code: 'NOT_CONFIRMED' });
        fixed += 1;
      } else if ((await settlePayment(ctx, p, o.orderId)).kind !== 'pending') {
        fixed += 1;
      }
    } else if (o.status === 'CANCELING') {
      if (p.status === 'CANCELED' || p.status === 'PARTIAL_CANCELED') {
        await ctx.db.call('fps_api_end_cancel', { p_order_id: o.orderId, p_ok: true });
        fixed += 1;
      } else if (p.status === 'DONE' && o.idleSec > 600) {
        await ctx.db.call('fps_api_end_cancel', { p_order_id: o.orderId, p_ok: false });   // 취소가 일어나지 않았다: 코인을 돌려놓는다
        fixed += 1;
      }
    }
  }
  if (fixed) ctx.log({ t: 'pay', step: 'reconcile', fixed, seen: (list.orders || []).length });
  return { ok: true, fixed };
}
