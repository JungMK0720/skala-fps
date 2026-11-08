/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 상점. def.category로 나눈 무기 탭과 무기 카드(이름·가격·막대·스탯·구매/장착), 이모트 탭(휠 8칸 장착·구매·미리 듣기)을 보여 준다.
 *          포인트는 계정이 바뀔 때마다 바로 갱신한다. 이벤트: shop:back, shop:preview { id }, ui:sound { name:'purchase' }.
 *          카드는 다시 만들지 않고 고쳐서 키보드 포커스를 잃지 않는다.
 */
import { h, btn, fmtPoints, setText } from './dom.js';
import { barMeters, makeScreen, normWeapon, pointsBadge } from './parts.js';
import { PREMIUM_PRICE } from '../weapons/defs.js';
import { EMOTES, EMOTE_WHEEL } from '../core/consts.js';

const TAB_LABELS = { rifle: '라이플', sniper: '저격', smg: 'SMG·샷건', pistol: '권총', melee: '근접' };
/** 이모트 탭 id. 무기 category와 겹치지 않는다 */
export const EMOTE_TAB = 'emote';
/** 상점에서 다루는 슬롯과 계정 장비 칸. 슬롯 4(수류탄)는 팔지 않는다. */
const SLOT_KEYS = { 1: 'primary', 2: 'secondary', 3: 'melee' };

export function createShop(ctx) {
  const cards = new Map();    // 무기 id → 카드
  const emoCards = new Map(); // 이모트 id → 카드
  let tabs = [];              // [{ id, label, el }]
  let tabId = null;
  let builtFor = 0;           // 카드를 만들 때 본 무기 수. setWeapons로 바뀌면 다시 만든다
  let slot = 0;               // 이모트 탭에서 고른 휠 칸(0 = 12시)

  const points = pointsBadge('sk-points--big');
  const tabsEl = h('div', { class: 'sk-tabs', role: 'tablist', 'aria-label': '상점 종류' });
  const grid = h('div', { class: 'sk-shop-grid', role: 'tabpanel', 'aria-label': '상품 목록' });
  const note = h('p', { class: 'sk-shop-note', role: 'status' });
  const backBtn = btn('← 메뉴', () => ctx.emit('shop:back', {}), 'sk-btn--ghost');

  const el = h('section', { class: 'sk-screen sk-page sk-shop', hidden: true, tabindex: '-1', 'aria-label': '상점' },
    h('div', { class: 'sk-page-inner' },
      h('header', { class: 'sk-bar' },
        backBtn,
        h('div', { class: 'sk-bar-title' },
          h('h1', { class: 'sk-h1 sk-stencil', text: '상점' }),
          h('p', { class: 'sk-bar-sub', text: `경기와 비밀 스팟으로 모은 포인트로 무기와 이모트를 사서 장착해요. ${fmtPoints(PREMIUM_PRICE)} 이상인 프리미엄 총은 예비 탄약이 무제한이에요.` })),
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

  // ---------- 무기 카드 ----------
  function buildCard(def) {
    const w = normWeapon(ctx.weapons, def);
    const state = h('span', { class: 'sk-shop-state' });
    const need = h('p', { class: 'sk-shop-need' });
    const action = h('button', { type: 'button', class: 'sk-btn sk-shop-action', onclick: () => act(card) });
    const articleEl = h('article', { class: 'sk-shop-card sk-steel', 'aria-label': w.name },
      h('header', { class: 'sk-shop-head' },
        h('span', { class: 'sk-lo-ico', text: w.icon, 'aria-hidden': 'true' }),
        h('div', { class: 'sk-shop-names' },
          h('h3', { class: 'sk-shop-name', text: w.name },
            w.premium ? h('span', { class: 'sk-premium', text: '프리미엄' }) : null),
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

  // ---------- 이모트 탭: 휠 8칸 + 이모트 카드 ----------
  const wheelOf = () => {
    const w = ctx.account && ctx.account.emoteWheel;
    return Array.isArray(w) ? w : [];
  };
  const emoteName = (id) => (EMOTES.find((e) => e.id === id) || { name: '' }).name;

  const chips = Array.from({ length: EMOTE_WHEEL.SLOTS }, (_, i) => {
    const ico = h('span', { class: 'sk-emo-slot-ico', 'aria-hidden': 'true' });
    const name = h('span', { class: 'sk-emo-slot-name' });
    const chipEl = h('button', { type: 'button', class: 'sk-emo-slot', role: 'radio', 'aria-checked': 'false',
      onclick: () => { slot = i; paintAll(); } },
    h('span', { class: 'sk-emo-slot-num', text: String(i + 1) }), ico, name);
    return { i, el: chipEl, ico, name };
  });
  const wheelBox = h('section', { class: 'sk-emo-wheelbox sk-steel', 'aria-label': '내 이모트 휠' },
    h('header', { class: 'sk-emo-wheelhead' },
      h('h3', { class: 'sk-shop-name', text: '내 이모트 휠' }),
      h('p', { class: 'sk-lo-tagline', text: '칸을 고른 뒤 아래 이모트에서 넣기를 누르세요. 1번이 12시, 시계 방향이에요. 경기에서 B를 누르면 이 순서로 나와요.' })),
    h('div', { class: 'sk-emo-slots', role: 'radiogroup', 'aria-label': '휠 칸' }, ...chips.map((c) => c.el)));

  function buildEmoteCard(e) {
    const state = h('span', { class: 'sk-shop-state' });
    const need = h('p', { class: 'sk-shop-need' });
    const action = h('button', { type: 'button', class: 'sk-btn sk-shop-action', onclick: () => actEmote(card) });
    const preview = h('button', { type: 'button', class: 'sk-btn sk-btn--ghost sk-emo-preview', text: '▶ 듣기', title: `${e.name} 미리 듣기`,
      onclick: () => { ctx.emit('shop:preview', { id: e.id }); say(`${e.name} 미리 듣는 중…`); } });
    const articleEl = h('article', { class: 'sk-shop-card sk-steel sk-emo-card', 'aria-label': e.name },
      h('header', { class: 'sk-shop-head' },
        h('span', { class: 'sk-lo-ico', text: e.icon, 'aria-hidden': 'true' }),
        h('div', { class: 'sk-shop-names' },
          h('h3', { class: 'sk-shop-name', text: e.name },
            e.price ? null : h('span', { class: 'sk-emo-free', text: '기본' })),
          e.desc ? h('p', { class: 'sk-lo-tagline', text: e.desc }) : null),
        state),
      h('footer', { class: 'sk-shop-foot' }, need, h('div', { class: 'sk-emo-actions' }, preview, action)));
    const card = { id: e.id, e, el: articleEl, state, need, action, preview };
    return card;
  }

  function paintEmoteCard(card, wheel) {
    const a = ctx.account;
    const owned = a.isOwned(card.id);
    const at = wheel.indexOf(card.id);
    const here = owned && at === slot;
    const short = owned ? 0 : Math.max(0, (card.e.price || 0) - a.profile.points);
    const n = slot + 1;
    card.el.classList.toggle('is-owned', owned);
    card.el.classList.toggle('is-equipped', at >= 0);
    setText(card.state, at >= 0 ? `휠 ${at + 1}번` : owned ? '보유' : fmtPoints(card.e.price));
    setText(card.need, short ? `${fmtPoints(short)} 더 필요해요` : '');
    setText(card.action, !owned ? `구매 ${fmtPoints(card.e.price)}` : here ? `${n}번 칸에 있음` : at >= 0 ? `${n}번 칸과 바꾸기` : `${n}번 칸에 넣기`);
    card.action.disabled = here || short > 0;
    card.action.classList.toggle('sk-btn--primary', !here && !short);
    card.action.classList.toggle('sk-btn--ghost', here);
  }

  function paintChips(wheel) {
    for (const c of chips) {
      const e = EMOTES.find((x) => x.id === wheel[c.i]);
      setText(c.ico, e ? e.icon : '');
      setText(c.name, e ? e.name : '빈 칸');
      const on = c.i === slot;
      c.el.classList.toggle('is-on', on);
      c.el.setAttribute('aria-checked', on ? 'true' : 'false');
      c.el.title = `${c.i + 1}번 칸: ${e ? e.name : '빈 칸'}`;
    }
  }

  function actEmote(card) {
    const a = ctx.account;
    const n = slot + 1;
    if (!a.isOwned(card.id)) {
      const r = a.buy(card.id);
      if (r.ok) {
        ctx.emit('ui:sound', { name: 'purchase' });
        say(`${card.e.name}을(를) 샀어요. 남은 포인트 ${fmtPoints(r.points)}. 넣을 칸을 고르고 한 번 더 누르세요.`);
      } else if (r.reason === 'points') {
        say(`포인트가 모자라요. ${fmtPoints((card.e.price || 0) - r.points)} 더 필요해요.`);
      } else {
        say('이 이모트는 살 수 없어요.');
      }
    } else if (typeof a.equipEmote === 'function') {
      const before = wheelOf();
      const from = before.indexOf(card.id);
      const out = before[slot];
      const r = a.equipEmote(slot, card.id);
      if (!r.ok) say('이 이모트는 넣을 수 없어요.');
      else if (from >= 0 && from !== slot) say(`${from + 1}번과 ${n}번 칸을 바꿨어요.`);
      else say(`${n}번 칸에 ${card.e.name}을(를) 넣었어요${out && out !== card.id ? ` (${emoteName(out)} 뺌)` : ''}.`);
    }
    paintAll();
  }

  function paintAll() {
    if (!ctx.account) return;
    points.set(ctx.account.profile.points);
    for (const card of cards.values()) paintCard(card);
    const wheel = wheelOf();
    paintChips(wheel);
    for (const card of emoCards.values()) paintEmoteCard(card, wheel);
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
    if (id === EMOTE_TAB) grid.replaceChildren(wheelBox, ...[...emoCards.values()].map((c) => c.el));
    else grid.replaceChildren(...[...cards.values()].filter((c) => c.category === id).map((c) => c.el));
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
    if (!emoCards.size) for (const e of EMOTES) emoCards.set(e.id, buildEmoteCard(e));
    const cats = [...new Set(defs.map((d) => d.category || 'etc'))];
    const known = Object.keys(TAB_LABELS).filter((c) => cats.includes(c));
    const rest = cats.filter((c) => !known.includes(c));
    tabs = [...known, ...rest, EMOTE_TAB].map((id) => {
      const tabEl = h('button', { type: 'button', class: 'sk-tab', role: 'tab', onclick: () => showTab(id), text: id === EMOTE_TAB ? '이모트' : TAB_LABELS[id] || id });
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
    const want = p && p.tab;
    if (want && tabs.some((t) => t.id === want)) showTab(want);
    else if (tabs.length && !tabs.some((t) => t.id === tabId)) showTab(tabs[0].id);
    paintAll();
  }

  const screen = makeScreen(el, { render, onShow: () => backBtn.focus({ preventScroll: true }) });
  return screen;
}
