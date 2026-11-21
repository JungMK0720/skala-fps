/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 닉네임 입력칸(0.4초 디바운스 실시간 검사)과 첫 실행 게이트. 게이트는 닉네임이 없으면 닫을 수 없고, 메뉴 위에 뜨는 UI 오버레이다.
 *          입력칸은 마이페이지의 닉네임 변경도 같이 쓴다. 규칙과 결과 모양은 docs/DESIGN.md 7절, js/account/index.js.
 *          게이트 아래에는 다른 기기에서 쓰던 닉네임을 구글·카카오 로그인으로 불러오는 버튼이 있다(account.online, 서버가 켜져 있을 때만).
 */
import { h, setText } from './dom.js';
import { t, isEnglish } from '../core/i18n.js';
import { platform } from '../platform/index.js';
import { makeScreen } from './parts.js';
import { createProviderRow, onlineState, paintNote } from './online.js';
import { NICKNAME_MAX, NICKNAME_MIN, cleanNickname } from '../account/nickname.js';
import { BRAND } from '../core/brand.js';

export const NICKNAME_CHECK_DELAY_MS = 400;

const RULE_TEXT = t('account.nameRule', { min: NICKNAME_MIN, max: NICKNAME_MAX });
const OFFLINE_TAIL = t('account.offlineTail');
const STATE_CLASS = { ok: 'is-ok', saved: 'is-ok', savedOffline: 'is-warn', offline: 'is-warn', bad: 'is-bad', checking: 'is-busy', saving: 'is-busy' };

/**
 * 닉네임 입력칸과 상태줄. 상태: idle(비었음) · same(지금 이름) · checking · ok · offline · bad · saving · saved · savedOffline
 * @param {object} ctx UI 내부 ctx (account, later, cancel)
 * @param {{ id:string, label?:string, current?:()=>string, onState?:(state:string)=>void, onSaved?:(result:object)=>void }} options
 */
export function createNicknameField(ctx, { id, label = t('account.nickname'), current = () => '', onState, onSaved }) {
  let state = 'idle';
  let timer = null;
  let token = 0;              // 늦게 온 응답을 버리는 번호
  let submitQueued = false;   // 검사가 끝나면 바로 저장한다(Enter를 검사 중에 눌렀을 때)
  let disposed = false;

  const input = h('input', {
    id, class: 'sk-input sk-nick-input', type: 'text', maxlength: NICKNAME_MAX, placeholder: t('account.nickPlaceholder'),
    autocomplete: 'off', spellcheck: 'false', 'aria-describedby': `${id}-status ${id}-rule`,
  });
  const statusEl = h('p', { id: `${id}-status`, class: 'sk-nick-status', role: 'status' });
  const el = h('div', { class: 'sk-nick-field' },
    h('label', { class: 'sk-field-label', for: id, text: label }),
    input,
    statusEl,
    h('p', { id: `${id}-rule`, class: 'sk-field-hint', text: RULE_TEXT }));

  function setState(next, message = '') {
    state = next;
    statusEl.className = 'sk-nick-status' + (STATE_CLASS[next] ? ' ' + STATE_CLASS[next] : '');
    setText(statusEl, message);
    input.setAttribute('aria-invalid', next === 'bad' ? 'true' : 'false');
    input.readOnly = next === 'saving';
    if (onState) onState(next);
  }

  function cancelTimer() {
    if (timer != null) { ctx.cancel(timer); timer = null; }
  }

  function applyCheck(r) {
    if (!r.ok) {
      submitQueued = false;
      setState('bad', r.message);
      return;
    }
    setState(r.offline ? 'offline' : 'ok', r.offline ? `${r.message} ${OFFLINE_TAIL}` : r.message);
    if (submitQueued) {
      submitQueued = false;
      submit();
    }
  }

  async function runCheck() {
    const mine = ++token;
    const r = await ctx.account.checkNickname(input.value);
    if (!disposed && mine === token) applyCheck(r);
  }

  /** 입력이 바뀌었다: 진행 중인 검사를 버리고 다시 예약한다 */
  function onInput() {
    token += 1;
    submitQueued = false;
    cancelTimer();
    const name = cleanNickname(input.value);
    if (!name) { setState('idle'); return; }
    if (name === current()) { setState('same', t('account.nickSame')); return; }
    setState('checking', t('account.nickChecking'));
    timer = ctx.later(() => { timer = null; runCheck(); }, NICKNAME_CHECK_DELAY_MS);
  }

  async function save() {
    const mine = ++token;
    setState('saving', t('account.nickSaving'));
    const r = await ctx.account.setNickname(input.value);
    if (disposed || mine !== token) return;
    if (!r.ok) { setState('bad', r.message); return; }
    input.value = r.name;
    if (r.offline) setState('savedOffline', t('account.nickSavedOffline', { message: r.message }));
    else setState('saved', r.message);
    if (onSaved) onSaved(r);
  }

  /** 저장을 시도한다. 아직 검사 중이면 검사를 앞당기고 결과가 괜찮을 때 이어서 저장한다. */
  function submit() {
    if (state === 'checking') {
      submitQueued = true;
      if (timer != null) { cancelTimer(); runCheck(); }
      return;
    }
    if (state === 'ok' || state === 'offline') save();
  }

  /** 입력칸을 이 값으로 맞춘다. 값이 있으면 바로 검사 흐름을 탄다. */
  function reset(value = '') {
    input.value = value;
    onInput();
  }

  input.addEventListener('input', onInput);
  // 한글 조합 중의 Enter는 조합을 끝내는 키다. 조합이 끝난 뒤 다시 오는 keydown에서 저장한다.
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    submit();
  });

  return {
    el, input, submit, reset,
    get state() { return state; },
    get canSubmit() { return state === 'ok' || state === 'offline'; },
    value: () => input.value,
    /** 화면이 닫힐 때: 진행 중인 검사를 버린다 */
    stop() {
      token += 1;
      submitQueued = false;
      cancelTimer();
    },
    dispose() {
      disposed = true;
      cancelTimer();
    },
  };
}

const SUBMIT_LABEL = { checking: t('account.submitChecking'), saving: t('account.submitSaving') };

/**
 * 첫 실행 게이트. ui.show('nickname', { conflict? }) 로 연다.
 * conflict: bus 'account:nickname-conflict'의 값 { name, reason, message }. 없으면 account.nicknameConflict로 설명을 만든다.
 * 닉네임이 생기고 충돌도 없어지면 스스로 닫힌다(index.js가 계정 변경 때 다시 그린다).
 */
export function createNicknameGate(ctx) {
  const needed = () => !!ctx.account && (!ctx.account.hasNickname() || !!ctx.account.nicknameConflict);

  const titleEl = h('h1', { id: 'sk-nick-title', class: 'sk-nick-title sk-stencil' });
  const leadEl = h('p', { class: 'sk-nick-lead' });
  const explain = h('p', { class: 'sk-alert sk-alert--warn', role: 'alert', hidden: true });
  const submitBtn = h('button', { type: 'submit', class: 'sk-btn sk-btn--primary sk-btn--big sk-nick-submit', disabled: true });
  const field = createNicknameField(ctx, {
    id: 'sk-gate-nick',
    label: t('account.nickname'),
    onState: syncSubmit,
    onSaved: () => { if (!needed()) ctx.hideSelf('nickname'); },
  });
  const form = h('form', { class: 'sk-nick-form', novalidate: true, onsubmit: (e) => { e.preventDefault(); field.submit(); } },
    field.el, submitBtn);
  // 다른 기기에서 쓰던 닉네임을 구글·카카오 로그인으로 불러온다(account.online, 서버가 켜져 있을 때만).
  // 포털(CrazyGames) 안에서는 바깥 로그인을 쓰지 않으므로 이 줄을 만들지 않는다. 기기 토큰 계정은 그대로 쓴다
  const loginRow = platform.isPortal ? null : createProviderRow('sk-row sk-nick-loginrow', (id) => ctx.account.online.startLogin(id));
  const loginNote = loginRow && h('p', { class: 'sk-nick-status sk-nick-loginnote', role: 'status', hidden: true });
  const loginBox = loginRow && h('div', { class: 'sk-nick-login', hidden: true },
    h('p', { class: 'sk-nick-or', text: t('account.gateHaveName') }), loginRow.el, loginNote);
  const el = h('section', { class: 'sk-screen sk-nick', hidden: true, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'sk-nick-title' },
    h('div', { class: 'sk-nick-card sk-steel' },
      h('div', { class: 'sk-hazard', 'aria-hidden': 'true' }),
      h('div', { class: 'sk-nick-body' },
        h('p', { class: 'sk-nick-kicker', text: `${BRAND.nameEn} // ENLISTMENT` }),
        isEnglish() ? null : h('p', { class: 'sk-nick-brand', text: BRAND.name }),   // 영어에서는 위 줄의 영어 이름이 브랜드다
        titleEl, leadEl, explain, form, loginBox)));

  function renderLogin() {
    if (!loginBox) return;
    const s = onlineState(ctx);
    const on = !!s && s.status === 'ready' && s.providers.length > 0;
    loginBox.hidden = !on;
    if (!on) return;
    loginRow.paint(s.providers.map((p) => ({ id: p.id, label: t('account.loadVia', { name: p.name }) })), { disabled: !!s.busy });
    paintNote(loginNote, s, { kinds: ['login', 'logout'] });
  }

  // 배경을 눌러도 입력칸의 포커스를 뺏기지 않는다(닫히지 않는 화면이다)
  el.addEventListener('pointerdown', (e) => { if (e.target === el) e.preventDefault(); });

  function syncSubmit(state) {
    submitBtn.disabled = !field.canSubmit;
    setText(submitBtn, SUBMIT_LABEL[state] || t('account.gateStart'));
  }

  function conflictText(p) {
    const name = ctx.account.nicknameConflict;
    if (!name) return '';
    const message = (p.conflict && p.conflict.message) || t('account.gateTaken');
    return `'${name}': ${message}`;
  }

  function render(p, { first }) {
    if (!needed()) {
      if (screen.visible) ctx.hideSelf('nickname');
      return;
    }
    const text = conflictText(p);
    setText(explain, text);
    explain.hidden = !text;
    setText(titleEl, text ? t('account.gateTitleRetry') : t('account.gateTitle'));
    setText(leadEl, text
      ? t('account.gateLeadRetry')
      : t('account.gateLead'));
    renderLogin();
    if (first) field.reset(ctx.account.nicknameConflict || '');
  }

  const screen = makeScreen(el, {
    render,
    onShow: () => field.input.focus({ preventScroll: true }),
    onHide: () => field.stop(),
    onDispose: () => field.dispose(),
  });
  /** 게이트가 필요한 상태인가: 닉네임이 없거나 서버가 닉네임을 거절했다 */
  screen.needed = needed;
  return screen;
}
