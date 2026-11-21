/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 로그인 연결·코인 화면이 함께 쓰는 작은 도우미. account.online.state 읽기, 결과 문구의 색(is-ok·is-warn·is-bad), 진행 중 문구,
 *          제공자 버튼 줄(제공자 목록이 바뀔 때만 다시 만들어 키보드 포커스를 잃지 않는다), 주문 상태 이름.
 */
import { h, setText } from './dom.js';
import { t } from '../core/i18n.js';

/** account.online.state. 옛 계정 대역(online이 없는 계정)이면 null */
export function onlineState(ctx) {
  const online = ctx.account && ctx.account.online;
  return online && online.state && typeof online.state === 'object' ? online.state : null;
}

export const TONE_CLASS = Object.freeze({ ok: 'is-ok', warn: 'is-warn', bad: 'is-bad' });

const BUSY_TEXT = Object.freeze({
  login: t('account.busyLogin'),
  logout: t('account.busyLogout'),
  pay: t('account.busyPay'),
  refund: t('account.busyRefund'),
  coins: t('account.busyCoins')
});

/** 상태 줄 하나를 결과 문구로 칠한다. busy가 있으면 진행 중 문구가 앞선다 */
export function paintNote(el, state, { kinds = null } = {}) {
  const busy = state && state.busy && (!kinds || kinds.includes(state.busy)) ? BUSY_TEXT[state.busy] : '';
  const msg = !busy && state && state.message ? state.message : null;
  el.classList.remove('is-ok', 'is-warn', 'is-bad');
  if (msg && TONE_CLASS[msg.tone]) el.classList.add(TONE_CLASS[msg.tone]);
  setText(el, busy || (msg ? msg.text : ''));
  el.hidden = !busy && !msg;
}

/**
 * 제공자 버튼 줄. paint(list, { disabled }) list = [{ id, label }]. 같은 목록이면 버튼을 다시 만들지 않는다.
 */
export function createProviderRow(cls, onPick) {
  const el = h('div', { class: cls });
  let key = '';
  let buttons = [];
  return {
    el,
    paint(list, { disabled = false } = {}) {
      const next = list.map((p) => `${p.id}:${p.label}`).join('|');
      if (next !== key) {
        key = next;
        buttons = list.map((p) => h('button', {
          type: 'button', class: `sk-btn sk-login-btn sk-login-btn--${p.id}`, 'data-provider': p.id, onclick: () => onPick(p.id), text: p.label
        }));
        el.replaceChildren(...buttons);
      }
      for (const b of buttons) b.disabled = !!disabled;
      el.hidden = !list.length;
    }
  };
}

const ORDER_STATUS = Object.freeze({ DONE: t('account.orderDone'), CANCELING: t('account.orderCanceling'), CANCELED: t('account.orderCanceled'), FAILED: t('account.orderFailed') });
export const orderStatusText = (s) => ORDER_STATUS[s] || s;

export const providerLabel = (state, id) => ((state && state.providers.find((p) => p.id === id)) || { name: id }).name;
