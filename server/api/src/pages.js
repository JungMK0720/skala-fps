/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: Worker가 직접 내보내는 결제 페이지. 토스 결제 SDK는 게임 페이지가 아니라 이 페이지(Worker 주소)에서만 돈다.
 *          그래서 외부 스크립트가 게임의 기기 토큰(localStorage)에 닿지 않고, 게임 CSP에 토스 주소를 열 필요가 없다.
 *          checkoutHtml: 주문 요약 + "결제창 열기" 버튼. 값은 data-* 속성으로만 넘기고(이스케이프) 인라인 스크립트는 없다. 동작은 CHECKOUT_JS(/pay/checkout.js).
 *          messageHtml: 주문을 찾을 수 없거나 이미 끝난 경우의 짧은 안내.
 */
import { escapeHtml, won } from './http.js';

export const TOSS_SDK_URL = 'https://js.tosspayments.com/v2/standard';

/** 결제 페이지 CSP. 스크립트는 이 Worker와 토스 SDK만, 결제창(iframe)·SDK 통신은 https만, 다른 사이트가 이 페이지를 틀에 넣지 못한다 */
export const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self' https://*.tosspayments.com",
  "style-src 'self' 'unsafe-inline' https:",
  "img-src 'self' data: https:",
  'font-src https: data:',
  "connect-src 'self' https:",
  'frame-src https:',
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'"
].join('; ');

export function pageHeaders() {
  return {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': PAGE_CSP,
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-robots-tag': 'noindex'
  };
}

const STYLE = `
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #05080f; color: #eaf1fb;
    font-family: 'Pretendard', 'Noto Sans KR', 'Malgun Gothic', 'Apple SD Gothic Neo', system-ui, sans-serif; }
  main { width: min(440px, calc(100vw - 32px)); background: rgba(12, 17, 30, 0.92); border: 1px solid rgba(255,255,255,0.1);
    border-radius: 18px; padding: 24px 26px; box-shadow: 0 20px 60px rgba(0,0,0,0.45); }
  h1 { margin: 0 0 6px; font-size: 22px; }
  .tag { display: inline-block; font-size: 12px; font-weight: 800; color: #03141b; background: #ffd36b; border-radius: 999px; padding: 3px 10px; }
  .warn { color: #ffd36b; font-size: 14px; line-height: 1.55; }
  dl { display: grid; grid-template-columns: auto 1fr; gap: 6px 14px; margin: 16px 0; font-size: 15px; }
  dt { color: #9dabc2; } dd { margin: 0; font-weight: 700; }
  .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin-top: 18px; }
  button, a.btn { font: inherit; font-weight: 800; cursor: pointer; border-radius: 12px; padding: 11px 18px; text-decoration: none; }
  button { color: #03141b; background: linear-gradient(180deg, #62e9ff, #22c6ea); border: 0; }
  button:disabled { opacity: 0.55; cursor: progress; }
  a.btn { color: #eaf1fb; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.16); }
  #msg { min-height: 1.3em; color: #ff8ab4; font-size: 14px; margin: 12px 0 0; }
  small { color: #9dabc2; font-size: 12px; line-height: 1.5; display: block; margin-top: 14px; }
`;

function layout(title, body, { script = false } = {}) {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
${body}
${script ? `<script src="${TOSS_SDK_URL}"></script>\n<script src="/pay/checkout.js"></script>` : ''}
</body>
</html>`;
}

/**
 * opts: { clientKey, order: { orderId, coins, amount, name }, orderName, customerKey, successUrl, failUrl, returnUrl, test, refundDays }
 */
export function checkoutHtml(opts) {
  const { order } = opts;
  const attrs = {
    'data-client-key': opts.clientKey,
    'data-order-id': order.orderId,
    'data-order-name': opts.orderName,
    'data-amount': String(order.amount),
    'data-customer-key': opts.customerKey,
    'data-success-url': opts.successUrl,
    'data-fail-url': opts.failUrl
  };
  const attrText = Object.entries(attrs).map(([k, v]) => `${k}="${escapeHtml(v)}"`).join(' ');
  const body = `<main id="pay" ${attrText}>
  ${opts.test ? '<span class="tag">테스트 결제</span>' : ''}
  <h1>SKALA 작전 코인 충전</h1>
  ${opts.test ? '<p class="warn">토스페이먼츠 테스트 결제예요. 결제창이 열려도 실제로 돈이 나가지 않아요.</p>' : ''}
  <dl>
    <dt>상품</dt><dd>${escapeHtml(opts.orderName)}</dd>
    <dt>금액</dt><dd>${escapeHtml(won(order.amount))}</dd>
    <dt>닉네임</dt><dd>${escapeHtml(order.name)}</dd>
  </dl>
  <div class="row">
    <button id="go" type="button">결제창 열기</button>
    <a class="btn" href="${escapeHtml(opts.returnUrl)}">취소하고 게임으로</a>
  </div>
  <p id="msg" role="status"></p>
  <small>결제를 마치면 게임으로 돌아가고 코인이 바로 들어와요. 그 코인을 쓰지 않았다면 상점의 구매 내역에서 ${escapeHtml(String(opts.refundDays))}일 안에 환불할 수 있어요.</small>
</main>`;
  return layout('SKALA 작전 테스트 결제', body, { script: true });
}

export function messageHtml({ title, text, returnUrl }) {
  const back = returnUrl ? `<div class="row"><a class="btn" href="${escapeHtml(returnUrl)}">게임으로 돌아가기</a></div>` : '';
  return layout(title, `<main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p>${back}</main>`);
}

/** /pay/checkout.js. 버튼을 누르면 토스 결제창(구버전 결제창, API 개별 연동 키 test_ck)을 연다. 결과는 successUrl·failUrl로 돌아온다 */
export const CHECKOUT_JS = `'use strict';
(function () {
  var box = document.getElementById('pay');
  var go = document.getElementById('go');
  var msg = document.getElementById('msg');
  if (!box || !go) return;
  var d = box.dataset;
  function say(text) { msg.textContent = text; }
  go.addEventListener('click', function () {
    if (typeof window.TossPayments !== 'function') { say('결제창을 불러오지 못했어요. 잠시 뒤 다시 시도해 주세요.'); return; }
    go.disabled = true;
    say('결제창을 여는 중이에요…');
    var payment;
    try {
      payment = window.TossPayments(d.clientKey).payment({ customerKey: d.customerKey });
    } catch (err) {
      go.disabled = false;
      say('결제를 준비하지 못했어요. 잠시 뒤 다시 시도해 주세요.');
      return;
    }
    Promise.resolve(payment.requestPayment({
      method: 'CARD',
      amount: { currency: 'KRW', value: Number(d.amount) },
      orderId: d.orderId,
      orderName: d.orderName,
      successUrl: d.successUrl,
      failUrl: d.failUrl,
      card: { useEscrow: false, flowMode: 'DEFAULT', useCardPoint: false, useAppCardOnly: false }
    })).catch(function (err) {
      go.disabled = false;
      say(err && err.code === 'USER_CANCEL' ? '결제를 취소했어요. 다시 열 수 있어요.' : '결제창을 열지 못했어요. 다시 시도해 주세요.');
    });
  });
})();
`;
