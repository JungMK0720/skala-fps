/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 좀비 물량 막기의 카드 고르기 화면. 스테이지를 깨면 3장(넓은 선택이면 4장)이 뜨고 하나를 누르거나 숫자 키로 고른다.
 *          제안마다 다시 뽑기 1번(행운 카드로 더). 여럿이 하면 고른 뒤 다른 사람을 기다리는 동안 내 카드를 보여 준다.
 *          'cards:pick' { id } · 'cards:reroll' {} 이벤트를 낸다.
 *          카드는 마지막 좀비를 쏘던 손 아래에 뜬다(포인터 잠금이 풀리면 커서가 가운데 카드 위에 온다). 그래서 쏘던 클릭·무기 교체 숫자 키·
 *          점프(Space)·재장전(R)으로 잘못 고르지 않게, 처음 1초는 잠그고 잠금이 풀린 뒤 새로 누른 것만 받는다. 다시 뽑기는 R을 길게 누른다.
 */
import { h, btn, setText, num } from './dom.js';
import { makeScreen } from './parts.js';

/** 카드가 처음 뜬 뒤 잠그는 시간(ms). 그동안 누른 클릭·터치·숫자 키는 카드를 고르지 않는다(숫자 키는 게임의 무기 교체로 간다) */
export const CARD_ARM_MS = 1000;
/** 다시 뽑아 카드가 바뀌었을 때의 짧은 잠금(ms) */
export const CARD_REARM_MS = 400;
/** R을 이만큼 누르고 있어야 다시 뽑는다(ms). 짧게 누른 R은 게임의 재장전으로 간다 */
export const REROLL_HOLD_MS = 500;

const defaultNow = () => (globalThis.performance && performance.now ? performance.now() : Date.now());

/**
 * 카드 고르기의 입력 문. 화면(DOM)과 떼어 두어 시험할 수 있다. now() = ms 시각.
 * - arm(ms): 지금부터 ms 동안 잠근다. armed(): 잠금이 풀렸는가. left(): 남은 ms
 * - press(): 마우스 단추·손가락을 누른 순간. 잠금이 풀린 뒤에 누른 것이어야 그 클릭으로 고를 수 있다
 * - clickOk(detail): 이 클릭으로 골라도 되는가. detail 0 = 키보드로 누른 단추(포커스한 카드에서 Enter)는 잠금만 본다
 * - keyOk(repeat): 이 숫자 키로 골라도 되는가(누르고 있어 반복되는 키는 아니다)
 * - holdStart() · holding() · holdCancel(): 다시 뽑기 R 길게 누르기. 잠금이 풀린 뒤 새로 누른 것만 센다
 */
export function createPickGate(now = defaultNow) {
  let until = 0, pressOk = false, holdAt = -1;
  const armed = () => now() >= until;
  return {
    arm(ms) { until = now() + Math.max(0, num(ms, 0)); pressOk = false; holdAt = -1; },
    armed,
    left: () => Math.max(0, until - now()),
    press() { pressOk = armed(); },
    clickOk(detail) { return armed() && (detail === 0 || pressOk); },
    keyOk(repeat) { return !repeat && armed(); },
    holdStart() { if (!armed()) return false; holdAt = now(); return true; },
    holding: () => holdAt >= 0,
    holdCancel() { holdAt = -1; }
  };
}

export function createCardPicker(ctx) {
  const gate = createPickGate();
  const title = h('h2', { class: 'sk-cd-title sk-stencil' });
  const sub = h('p', { class: 'sk-cd-sub' });
  const timer = h('span', { class: 'sk-cd-timer' });
  const grid = h('div', { class: 'sk-cd-grid', role: 'list' });
  const armBar = h('div', { class: 'sk-cd-arm', 'aria-hidden': 'true' }, h('i'));
  const noFocus = (e) => e.preventDefault();
  const rerollBtn = btn('', (e) => {
    if (!state.picked && gate.clickOk(e ? e.detail : 0)) ctx.emit('cards:reroll', {});
    else if (e) e.stopPropagation();
  }, 'sk-btn--ghost sk-cd-reroll', { onmousedown: noFocus });
  const wait = h('p', { class: 'sk-cd-wait', role: 'status' });
  const perks = h('ul', { class: 'sk-cd-perks', 'aria-label': '지금까지 오른 능력치' });
  const panel = h('div', { class: 'sk-cd-panel', tabindex: '-1' },
    h('header', { class: 'sk-cd-head' }, h('div', {}, title, sub), timer),
    armBar,
    grid,
    h('footer', { class: 'sk-cd-foot' }, rerollBtn, wait),
    perks);
  const el = h('section', { class: 'sk-screen sk-overlay sk-cards', hidden: true, role: 'dialog', 'aria-modal': 'true', 'aria-label': '강화 카드 고르기' }, panel);
  const state = { picked: false, ids: [], sig: '', mine: null, p: {} };
  let armTimer = 0, holdTimer = 0;
  rerollBtn.style.setProperty('--cd-hold-ms', `${REROLL_HOLD_MS}ms`);

  function cardEl(c, i) {
    const owned = num(c.owned, 0) | 0;
    const kids = [
      h('span', { class: 'sk-cd-key', text: String(i + 1), 'aria-hidden': 'true' }),
      h('span', { class: 'sk-cd-icon', text: c.icon || '🃏', 'aria-hidden': 'true' }),
      h('b', { class: 'sk-cd-name', text: c.name }),
      h('span', { class: 'sk-cd-tier', text: c.tierName || '' }),
      h('span', { class: 'sk-cd-desc', text: c.desc || '' }),
      owned ? h('span', { class: 'sk-cd-owned', text: `가진 수 ${owned}` }) : null
    ];
    return h('button', {
      type: 'button', class: `sk-cd-card sk-cd--${c.tier || 'common'}` + (state.mine === c.id ? ' is-picked' : ''), role: 'listitem',
      style: { '--cd-color': c.color || '#c9d4e0' }, disabled: state.picked, 'aria-label': `${i + 1}번 ${c.name} · ${c.tierName || ''} · ${c.desc || ''}`,
      // 잠금이 풀린 뒤 새로 누른 클릭만 고른다(쏘던 클릭을 떼며 고르지 않게)
      onclick: (e) => { if (gate.clickOk(e ? e.detail : 0)) pick(c.id); else if (e) e.stopPropagation(); },   // 막힌 클릭은 단추 소리도 내지 않는다
      // 마우스·손가락으로 눌러도 포커스를 가져가지 않는다. 쏘던 클릭이 카드에 포커스를 주면 뒤이은 점프(Space)가 그 카드를 누른다
      onmousedown: noFocus
    }, kids);
  }

  function pick(id) {
    if (state.picked || !state.ids.includes(id)) return;
    holdStop();
    state.picked = true;
    state.mine = id;
    ctx.emit('cards:pick', { id });
    for (const b of grid.children) b.disabled = true;
    const i = state.ids.indexOf(id);
    if (grid.children[i]) grid.children[i].classList.add('is-picked');
  }

  /** ms 동안 잠근다: 카드를 흐리게 하고 위에 채워지는 막대를 띄운다. 풀리면 안내 글을 바꾼다 */
  function arm(ms) {
    gate.arm(ms);
    holdStop();
    el.classList.add('is-arming');
    el.style.setProperty('--cd-arm-ms', `${ms}ms`);
    armBar.classList.remove('is-run');
    void armBar.offsetWidth;   // 막대 애니메이션을 처음부터 다시
    armBar.classList.add('is-run');
    if (armTimer) ctx.cancel(armTimer);
    const done = () => {
      if (!gate.armed()) { armTimer = ctx.later(done, gate.left() + 5); return; }
      armTimer = 0;
      el.classList.remove('is-arming');
      renderSub();
    };
    armTimer = ctx.later(done, ms);
    renderSub();
  }

  /** R 길게 누르기를 그만둔다(뗐거나, 골랐거나, 창을 벗어났거나) */
  function holdStop() {
    gate.holdCancel();
    if (holdTimer) { ctx.cancel(holdTimer); holdTimer = 0; }
    rerollBtn.classList.remove('is-holding');
  }

  function renderSub() {
    const p = state.p;
    setText(sub, p.picked ? '고른 카드는 다음 스테이지부터 적용돼요'
      : gate.armed() ? '강화 카드 하나를 고르세요 · 숫자 키로도 고를 수 있어요'
        : '잠깐! 쏘던 클릭으로 잘못 고르지 않게 잠시 잠가 뒀어요');
  }

  function render(p, info = {}) {
    state.p = p;
    const cards = Array.isArray(p.cards) ? p.cards : [];
    const ids = cards.map((c) => c.id);
    const sig = JSON.stringify([ids, p.picked, p.mine]);
    if (sig !== state.sig) {
      const before = state.ids.join();
      state.sig = sig;
      state.ids = ids;
      state.picked = !!p.picked;
      state.mine = p.mine || (p.picked ? state.mine : null);
      grid.replaceChildren(...cards.map(cardEl));
      grid.classList.toggle('is-four', cards.length >= 4);
      // 처음 뜬 카드는 1초, 다시 뽑아 바뀐 카드는 0.4초 잠근다
      if (!p.picked && ids.length) {
        if (info.first || !before) arm(CARD_ARM_MS);
        else if (before !== ids.join()) arm(CARD_REARM_MS);
      }
    }
    setText(title, `스테이지 ${Math.max(1, num(p.stage, 1) | 0)} 클리어!`);
    renderSub();
    const secs = Math.max(0, Math.ceil(num(p.seconds, 0)));
    setText(timer, secs ? `⏳ ${secs}초` : '');
    timer.classList.toggle('is-urgent', secs > 0 && secs <= 5);
    const rr = Math.max(0, num(p.rerolls, 0) | 0);
    setText(rerollBtn, `🔄 다시 뽑기 (${rr})`);
    rerollBtn.disabled = !!p.picked || rr <= 0;
    if (rerollBtn.disabled) holdStop();
    const waiting = Array.isArray(p.waiting) ? p.waiting : [];
    setText(wait, p.picked ? (waiting.length ? `다른 생존자를 기다리는 중 · ${waiting.join(', ')}` : '곧 다음 스테이지가 시작돼요') : 'R 길게 누르기: 다시 뽑기');
    const rows = Array.isArray(p.perks) ? p.perks : [];
    perks.hidden = !rows.length;
    perks.replaceChildren(...rows.map((r) => h('li', {}, h('span', { text: r.label }), h('b', { text: r.value }))));
  }

  // 누른 순간을 기록한다(잠금 중에 누르기 시작한 클릭은 잠금이 풀린 뒤 떼어도 고르지 않는다)
  ctx.listen(el, 'pointerdown', () => gate.press(), true);

  // 숫자 키 1~4로 고르기, R 길게 눌러 다시 뽑기(화면이 떠 있을 때만).
  // 잠긴 동안의 숫자 키와 짧게 누른 R은 막지 않고 게임으로 보낸다(무기 교체·재장전).
  ctx.listen(window, 'keydown', (e) => {
    if (!api.visible || e.repeat) return;
    const m = /^(?:Digit|Numpad)([1-4])$/.exec(e.code);
    if (m) {
      const id = state.ids[Number(m[1]) - 1];
      if (id && !state.picked && gate.keyOk(e.repeat)) { e.preventDefault(); e.stopPropagation(); pick(id); }
      return;
    }
    if (e.code === 'KeyR' && !state.picked && !rerollBtn.disabled && !gate.holding() && gate.holdStart()) {
      rerollBtn.classList.add('is-holding');
      holdTimer = ctx.later(() => {
        holdTimer = 0;
        const go = gate.holding() && api.visible && !state.picked && !rerollBtn.disabled;
        holdStop();
        if (go) ctx.emit('cards:reroll', {});
      }, REROLL_HOLD_MS);
    }
  }, true);
  ctx.listen(window, 'keyup', (e) => { if (e.code === 'KeyR') holdStop(); }, true);
  ctx.listen(window, 'blur', () => holdStop());

  const api = makeScreen(el, {
    render,
    // 첫 카드에 포커스를 주지 않는다(점프 Space·Enter가 1번 카드를 누르지 않게). 대화 상자에 포커스를 두고 Tab으로 카드에 간다
    onShow: () => { if (panel.focus) panel.focus({ preventScroll: true }); },
    onHide: () => {
      holdStop();
      if (armTimer) { ctx.cancel(armTimer); armTimer = 0; }
      el.classList.remove('is-arming');
      state.sig = ''; state.ids = []; state.picked = false; state.mine = null;
    }
  });
  return api;
}
