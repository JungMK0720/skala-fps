/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 좀비 물량 막기의 카드 고르기 화면. 스테이지를 깨면 3장(넓은 선택이면 4장)이 뜨고 하나를 누르거나 숫자 키로 고른다.
 *          제안마다 다시 뽑기 1번(행운 카드로 더). 여럿이 하면 고른 뒤 다른 사람을 기다리는 동안 내 카드를 보여 준다.
 *          'cards:pick' { id } · 'cards:reroll' {} 이벤트를 낸다.
 */
import { h, btn, setText, num } from './dom.js';
import { makeScreen } from './parts.js';

export function createCardPicker(ctx) {
  const title = h('h2', { class: 'sk-cd-title sk-stencil' });
  const sub = h('p', { class: 'sk-cd-sub' });
  const timer = h('span', { class: 'sk-cd-timer' });
  const grid = h('div', { class: 'sk-cd-grid', role: 'list' });
  const rerollBtn = btn('', () => { if (!state.picked) ctx.emit('cards:reroll', {}); }, 'sk-btn--ghost sk-cd-reroll');
  const wait = h('p', { class: 'sk-cd-wait', role: 'status' });
  const perks = h('ul', { class: 'sk-cd-perks', 'aria-label': '지금까지 오른 능력치' });
  const el = h('section', { class: 'sk-screen sk-overlay sk-cards', hidden: true, role: 'dialog', 'aria-modal': 'true', 'aria-label': '강화 카드 고르기' },
    h('div', { class: 'sk-cd-panel' },
      h('header', { class: 'sk-cd-head' }, h('div', {}, title, sub), timer),
      grid,
      h('footer', { class: 'sk-cd-foot' }, rerollBtn, wait),
      perks));
  const state = { picked: false, ids: [], sig: '', mine: null };

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
      onclick: () => pick(c.id)
    }, kids);
  }

  function pick(id) {
    if (state.picked || !state.ids.includes(id)) return;
    state.picked = true;
    state.mine = id;
    ctx.emit('cards:pick', { id });
    for (const b of grid.children) b.disabled = true;
    const i = state.ids.indexOf(id);
    if (grid.children[i]) grid.children[i].classList.add('is-picked');
  }

  function render(p) {
    const cards = Array.isArray(p.cards) ? p.cards : [];
    const ids = cards.map((c) => c.id);
    const sig = JSON.stringify([ids, p.picked, p.mine]);
    if (sig !== state.sig) {
      state.sig = sig;
      state.ids = ids;
      state.picked = !!p.picked;
      state.mine = p.mine || (p.picked ? state.mine : null);
      grid.replaceChildren(...cards.map(cardEl));
      grid.classList.toggle('is-four', cards.length >= 4);
    }
    setText(title, `스테이지 ${Math.max(1, num(p.stage, 1) | 0)} 클리어!`);
    setText(sub, p.picked ? '고른 카드는 다음 스테이지부터 적용돼요' : '강화 카드 하나를 고르세요 · 숫자 키로도 고를 수 있어요');
    const secs = Math.max(0, Math.ceil(num(p.seconds, 0)));
    setText(timer, secs ? `⏳ ${secs}초` : '');
    timer.classList.toggle('is-urgent', secs > 0 && secs <= 5);
    const rr = Math.max(0, num(p.rerolls, 0) | 0);
    setText(rerollBtn, `🔄 다시 뽑기 (${rr})`);
    rerollBtn.disabled = !!p.picked || rr <= 0;
    const waiting = Array.isArray(p.waiting) ? p.waiting : [];
    setText(wait, p.picked ? (waiting.length ? `다른 생존자를 기다리는 중 · ${waiting.join(', ')}` : '곧 다음 스테이지가 시작돼요') : 'R: 다시 뽑기');
    const rows = Array.isArray(p.perks) ? p.perks : [];
    perks.hidden = !rows.length;
    perks.replaceChildren(...rows.map((r) => h('li', {}, h('span', { text: r.label }), h('b', { text: r.value }))));
  }

  // 숫자 키 1~4로 고르기, R로 다시 뽑기(화면이 떠 있을 때만. 엔진 쪽 무기 교체로 새지 않게 막는다)
  ctx.listen(window, 'keydown', (e) => {
    if (!api.visible || e.repeat) return;
    const m = /^(?:Digit|Numpad)([1-4])$/.exec(e.code);
    if (m) {
      const id = state.ids[Number(m[1]) - 1];
      if (id) { e.preventDefault(); e.stopPropagation(); pick(id); }
      return;
    }
    if (e.code === 'KeyR' && !state.picked && !rerollBtn.disabled) { e.preventDefault(); e.stopPropagation(); ctx.emit('cards:reroll', {}); }
  }, true);

  const api = makeScreen(el, {
    render,
    onShow: () => { const first = grid.querySelector('button:not([disabled])'); if (first && first.focus) first.focus({ preventScroll: true }); },
    onHide: () => { state.sig = ''; state.picked = false; state.mine = null; }
  });
  return api;
}
