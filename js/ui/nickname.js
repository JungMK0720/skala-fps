/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 닉네임 입력칸(0.4초 디바운스 실시간 검사)과 첫 실행 게이트. 게이트는 닉네임이 없으면 닫을 수 없고, 메뉴 위에 뜨는 UI 오버레이다.
 *          입력칸은 마이페이지의 닉네임 변경도 같이 쓴다. 규칙과 결과 모양은 docs/DESIGN.md 7절, js/account/index.js.
 */
import { h, setText } from './dom.js';
import { makeScreen } from './parts.js';
import { NICKNAME_MAX, NICKNAME_MIN, cleanNickname } from '../account/nickname.js';

export const NICKNAME_CHECK_DELAY_MS = 400;

const RULE_TEXT = `${NICKNAME_MIN}~${NICKNAME_MAX}자 · 한글, 영문, 숫자, _, -, 공백`;
const OFFLINE_TAIL = '일단 저장하고 멀티 입장 때 다시 확인해요.';
const STATE_CLASS = { ok: 'is-ok', saved: 'is-ok', savedOffline: 'is-warn', offline: 'is-warn', bad: 'is-bad', checking: 'is-busy', saving: 'is-busy' };

/**
 * 닉네임 입력칸과 상태줄. 상태: idle(비었음) · same(지금 이름) · checking · ok · offline · bad · saving · saved · savedOffline
 * @param {object} ctx UI 내부 ctx (account, later, cancel)
 * @param {{ id:string, label?:string, current?:()=>string, onState?:(state:string)=>void, onSaved?:(result:object)=>void }} options
 */
export function createNicknameField(ctx, { id, label = '닉네임', current = () => '', onState, onSaved }) {
  let state = 'idle';
  let timer = null;
  let token = 0;              // 늦게 온 응답을 버리는 번호
  let submitQueued = false;   // 검사가 끝나면 바로 저장한다(Enter를 검사 중에 눌렀을 때)
  let disposed = false;

  const input = h('input', {
    id, class: 'sk-input sk-nick-input', type: 'text', maxlength: NICKNAME_MAX, placeholder: '닉네임 입력',
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
    if (name === current()) { setState('same', '지금 쓰는 닉네임이에요.'); return; }
    setState('checking', '확인하는 중…');
    timer = ctx.later(() => { timer = null; runCheck(); }, NICKNAME_CHECK_DELAY_MS);
  }

  async function save() {
    const mine = ++token;
    setState('saving', '저장하는 중…');
    const r = await ctx.account.setNickname(input.value);
    if (disposed || mine !== token) return;
    if (!r.ok) { setState('bad', r.message); return; }
    input.value = r.name;
    if (r.offline) setState('savedOffline', `닉네임을 저장했어요. ${r.message} 멀티 입장 때 다시 확인해요.`);
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

const SUBMIT_LABEL = { checking: '확인 중…', saving: '저장 중…' };

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
    label: '닉네임',
    onState: syncSubmit,
    onSaved: () => { if (!needed()) ctx.hideSelf('nickname'); },
  });
  const form = h('form', { class: 'sk-nick-form', novalidate: true, onsubmit: (e) => { e.preventDefault(); field.submit(); } },
    field.el, submitBtn);
  const el = h('section', { class: 'sk-screen sk-nick', hidden: true, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'sk-nick-title' },
    h('div', { class: 'sk-nick-card sk-steel' },
      h('div', { class: 'sk-hazard', 'aria-hidden': 'true' }),
      h('div', { class: 'sk-nick-body' },
        h('p', { class: 'sk-nick-kicker', text: 'SKALA FPS' }),
        titleEl, leadEl, explain, form)));

  // 배경을 눌러도 입력칸의 포커스를 뺏기지 않는다(닫히지 않는 화면이다)
  el.addEventListener('pointerdown', (e) => { if (e.target === el) e.preventDefault(); });

  function syncSubmit(state) {
    submitBtn.disabled = !field.canSubmit;
    setText(submitBtn, SUBMIT_LABEL[state] || '이 닉네임으로 시작');
  }

  function conflictText(p) {
    const name = ctx.account.nicknameConflict;
    if (!name) return '';
    const message = (p.conflict && p.conflict.message) || '다른 플레이어가 먼저 등록한 닉네임이에요. 새 닉네임을 정해 주세요.';
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
    setText(titleEl, text ? '닉네임을 다시 정해 주세요' : '닉네임을 정해 주세요');
    setText(leadEl, text
      ? '멀티플레이에서 다른 플레이어에게 보이는 이름이에요.'
      : '게임에서 쓸 이름이에요. 정한 뒤에도 마이페이지에서 언제든 바꿀 수 있어요.');
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
