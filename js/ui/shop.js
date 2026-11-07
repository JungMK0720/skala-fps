/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 상점. def.category로 나눈 탭과 무기 카드(이름·가격·막대·스탯·구매/장착)를 보여 준다. 포인트는 계정이 바뀔 때마다 바로 갱신한다.
 *          이벤트: shop:back, ui:sound { name:'purchase' }. 카드는 다시 만들지 않고 고쳐서 키보드 포커스를 잃지 않는다.
 */
import { h, btn, fmtPoints, setText } from './dom.js';
import { barMeters, makeScreen, normWeapon, pointsBadge } from './parts.js';

const TAB_LABELS = { rifle: '라이플', sniper: '저격', smg: 'SMG·샷건', pistol: '권총', melee: '근접' };
/** 상점에서 다루는 슬롯과 계정 장비 칸. 슬롯 4(수류탄)는 팔지 않는다. */
const SLOT_KEYS = { 1: 'primary', 2: 'secondary', 3: 'melee' };

export function createShop(ctx) {
  const cards = new Map();    // 무기 id → 카드
  let tabs = [];              // [{ id, label, el }]
  let tabId = null;
  let builtFor = 0;           // 카드를 만들 때 본 무기 수. setWeapons로 바뀌면 다시 만든다

  const points = pointsBadge('sk-points--big');
  const tabsEl = h('div', { class: 'sk-tabs', role: 'tablist', 'aria-label': '무기 종류' });
  const grid = h('div', { class: 'sk-shop-grid', role: 'tabpanel', 'aria-label': '무기 목록' });
  const note = h('p', { class: 'sk-shop-note', role: 'status' });
  const backBtn = btn('← 메뉴', () => ctx.emit('shop:back', {}), 'sk-btn--ghost');

  const el = h('section', { class: 'sk-screen sk-page sk-shop', hidden: true, tabindex: '-1', 'aria-label': '상점' },
    h('div', { class: 'sk-page-inner' },
      h('header', { class: 'sk-bar' },
        backBtn,
        h('div', { class: 'sk-bar-title' },
          h('h1', { class: 'sk-h1 sk-stencil', text: '상점' }),
          h('p', { class: 'sk-bar-sub', text: '경기와 비밀 스팟으로 모은 포인트로 무기를 사서 장착해요.' })),
        points.el),
      h('div', { class: 'sk-hazard sk-hazard--thin', 'aria-hidden': 'true' }),
      h('div', { class: 'sk-shop-bar' }, tabsEl, note),
      grid));

  ctx.listen(window, 'keydown', (e) => {
    if (e.key !== 'Escape' || !screen.visible || el.inert) return;
    e.preventDefault();
    ctx.emit('shop:back', {});
  }, true);

  const say = (text) => setText(note, text);

  // ---------- 카드 ----------
  function buildCard(def) {
    const w = normWeapon(ctx.weapons, def);
    const state = h('span', { class: 'sk-shop-state' });
    const need = h('p', { class: 'sk-shop-need' });
    const action = h('button', { type: 'button', class: 'sk-btn sk-shop-action', onclick: () => act(card) });
    const articleEl = h('article', { class: 'sk-shop-card sk-steel', 'aria-label': w.name },
      h('header', { class: 'sk-shop-head' },
        h('span', { class: 'sk-lo-ico', text: w.icon, 'aria-hidden': 'true' }),
        h('div', { class: 'sk-shop-names' },
          h('h3', { class: 'sk-shop-name', text: w.name }),
          w.tagline ? h('p', { class: 'sk-lo-tagline', text: w.tagline }) : null),
        state),
      w.bars.length ? barMeters(w.bars, 'sk-shop-bars') : null,
      w.stats.length ? h('dl', { class: 'sk-shop-stats' },
        w.stats.map((s) => h('div', { class: 'sk-shop-stat' }, h('dt', { text: s.label }), h('dd', { text: s.value })))) : null,
      h('footer', { class: 'sk-shop-foot' }, need, action));
    const card = { id: def.id, w, slotKey: SLOT_KEYS[def.slot], el: articleEl, state, need, action };
    return card;
  }

  function paintCard(card) {
    const a = ctx.account;
    const owned = a.isOwned(card.id);
    const equipped = owned && a.loadout[card.slotKey] === card.id;
    const short = owned ? 0 : Math.max(0, card.w.price - a.profile.points);
    card.el.classList.toggle('is-owned', owned);
    card.el.classList.toggle('is-equipped', equipped);
    setText(card.state, equipped ? '장착 중' : owned ? '보유' : fmtPoints(card.w.price));
    setText(card.need, short ? `${fmtPoints(short)} 더 필요해요` : '');
    setText(card.action, equipped ? '장착 중' : owned ? '장착' : `구매 ${fmtPoints(card.w.price)}`);
    card.action.disabled = equipped || short > 0;
    card.action.classList.toggle('sk-btn--primary', !owned && !short);
    card.action.classList.toggle('sk-btn--ghost', equipped);
  }

  function paintAll() {
    if (!ctx.account) return;
    points.set(ctx.account.profile.points);
    for (const card of cards.values()) paintCard(card);
  }

  function buy(card) {
    const r = ctx.account.buy(card.id);
    if (r.ok) {
      ctx.emit('ui:sound', { name: 'purchase' });
      say(`${card.w.name}을(를) 샀어요. 남은 포인트 ${fmtPoints(r.points)}.`);
    } else if (r.reason === 'points') {
      say(`포인트가 모자라요. ${fmtPoints(card.w.price - r.points)} 더 필요해요.`);
    } else if (r.reason === 'owned') {
      say(`${card.w.name}은(는) 이미 가지고 있어요.`);
    } else {
      say('이 무기는 살 수 없어요.');
    }
  }

  function equip(card) {
    const r = ctx.account.equip(card.slotKey, card.id);
    say(r.ok ? `${card.w.name}을(를) 장착했어요.` : '이 무기는 장착할 수 없어요.');
  }

  function act(card) {
    if (ctx.account.isOwned(card.id)) equip(card);
    else buy(card);
    paintAll();
  }

  // ---------- 탭 ----------
  function showTab(id) {
    tabId = id;
    for (const t of tabs) {
      const on = t.id === id;
      t.el.classList.toggle('is-on', on);
      t.el.setAttribute('aria-selected', on ? 'true' : 'false');
      t.el.tabIndex = on ? 0 : -1;
    }
    grid.replaceChildren(...[...cards.values()].filter((c) => c.category === id).map((c) => c.el));
    grid.scrollTop = 0;
  }

  function moveTab(step) {
    const i = tabs.findIndex((t) => t.id === tabId);
    const next = tabs[(i + step + tabs.length) % tabs.length];
    if (!next) return;
    showTab(next.id);
    next.el.focus();
  }

  tabsEl.addEventListener('keydown', (e) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    moveTab(step);
  });

  function build() {
    const defs = [...ctx.weapons.values()].filter((d) => SLOT_KEYS[d.slot]);
    cards.clear();
    for (const d of defs) {
      const card = buildCard(d);
      card.category = d.category || 'etc';
      cards.set(d.id, card);
    }
    const cats = [...new Set(defs.map((d) => d.category || 'etc'))];
    const known = Object.keys(TAB_LABELS).filter((c) => cats.includes(c));
    const rest = cats.filter((c) => !known.includes(c));
    tabs = [...known, ...rest].map((id) => {
      const tabEl = h('button', { type: 'button', class: 'sk-tab', role: 'tab', onclick: () => showTab(id), text: TAB_LABELS[id] || id });
      return { id, el: tabEl };
    });
    tabsEl.replaceChildren(...tabs.map((t) => t.el));
    builtFor = ctx.weapons.size;
    tabId = null;
  }

  function render(p, { first }) {
    if (!ctx.account) return;
    if (first) say('');
    if (builtFor !== ctx.weapons.size) build();
    if (tabs.length && !tabs.some((t) => t.id === tabId)) showTab(tabs[0].id);
    paintAll();
  }

  const screen = makeScreen(el, { render, onShow: () => backBtn.focus({ preventScroll: true }) });
  return screen;
}
