/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 상점 = 무기고(ARMORY). 큰 탭에 선 아이콘을 붙인다. 무기는 큰 탭(주무기·보조무기·근접무기·투척무기) 아래 def.category로 나눈 작은 탭으로 보여 주고, 무기 카드(이름·가격·막대·스탯·구매/장착), 이모트 탭(휠 8칸 장착·구매·미리 듣기)을 보여 준다.
 *          포인트는 계정이 바뀔 때마다 바로 갱신한다. 이벤트: shop:back, shop:preview { id }, ui:sound { name:'purchase' }.
 *          카드는 다시 만들지 않고 고쳐서 키보드 포커스를 잃지 않는다.
 *          캐릭터 탭: 초상(ui.setAvatarArt로 받은 그림, 없으면 아이콘)·구매·장착. 초상은 탭을 처음 열 때 그린다.
 *          서버가 캐릭터를 모르면(account.avatarShop) 구매 버튼을 끄고 안내한다. props.tab은 show로 열 때만 따른다.
 *          코인 탭(account.online, 서버가 켜져 있을 때만): 잔액, 테스트 결제 충전 상품, 구매 내역과 환불. 이모트·캐릭터 카드에는 "코인으로 사기"가 붙는다.
 */
import { h, btn, fmtPoints, setText } from './dom.js';
import { avatarArtEl, barMeters, makeScreen, normWeapon, pointsBadge } from './parts.js';
import { uiIcon, weaponGlyph } from './icons.js';
import { onlineState, orderStatusText, paintNote } from './online.js';
import { PREMIUM_PRICE } from '../weapons/defs.js';
import { EMOTES, EMOTE_WHEEL, TEAMS, TEAM_IDS } from '../core/consts.js';
import { AVATARS, DEFAULT_AVATAR } from '../core/avatar-defs.js';
import { t, loc, fmtNum, getLang } from '../core/i18n.js';
import { platform } from '../platform/index.js';

/** 무기 큰 탭. 무기는 슬롯으로 나누고 투척 장비는 별도 탭에 모은다 */
const GROUPS = Object.freeze([['primary', t('shop.tab.primary')], ['secondary', t('shop.tab.secondary')], ['melee', t('shop.tab.melee')], ['throw', t('shop.tab.throw')]]);
/** 큰 탭 안의 작은 탭(def.category) 이름과 순서 */
const SUB_LABELS = { rifle: t('shop.sub.rifle'), sniper: t('shop.sub.sniper'), smg: 'SMG', pistol: t('shop.sub.pistol'), shotgun: t('shop.sub.shotgun'), lmg: t('shop.sub.lmg'), melee: t('shop.sub.melee'), grenade: t('shop.sub.grenade'), launcher: t('shop.sub.launcher') };
/** 이모트 탭 id. 무기 category와 겹치지 않는다 */
export const EMOTE_TAB = 'emote';
/** 캐릭터 탭 id */
export const AVATAR_TAB = 'avatar';
/** 코인(테스트 결제) 탭 id. 서버(account.online)가 켜져 있을 때만 보인다 */
export const COIN_TAB = 'coins';
const won = (n) => t('shop.won', { n: fmtNum(n) });
const count = (n) => fmtNum(n);
/** 캐릭터 구매가 닫혀 있을 때 안내(account.avatarShop) */
const CLOSED_NOTE = t('shop.av.closed');
const CHECKING_NOTE = t('shop.av.checking');
/** 서버 가격표에 아직 없는 물건(account.canSell이 false)을 사려 할 때 */
export const NOT_READY_NOTE = t('shop.notReady');
/** 계정이 지금 팔 수 있는 물건인가. canSell이 없는 옛 계정 대역은 판다고 본다 */
const sellable = (a, id) => typeof a.canSell !== 'function' || a.canSell(id);
/** 상점에서 다루는 슬롯과 계정 장비 칸. 기본 수류탄 카드에는 구매/장착 동작이 없다. */
const SLOT_KEYS = { 1: 'primary', 2: 'secondary', 3: 'melee', 4: 'grenade' };
/** 큰 탭 → 선 아이콘 이름 */
const TAB_GLYPH = Object.freeze({ primary: 'rifle', secondary: 'pistol', melee: 'knife', throw: 'grenade', emote: 'emote', avatar: 'helmet', coins: 'coin' });
const groupOf = (d) => (d.slot === 4 ? 'throw' : SLOT_KEYS[d.slot]);

export function createShop(ctx) {
  const cards = new Map();    // 무기 id → 카드
  const emoCards = new Map(); // 이모트 id → 카드
  const avCards = new Map();  // 캐릭터 id → 카드
  let artTeam = TEAM_IDS[0];  // 캐릭터 초상의 팀 색
  let tabs = [];              // 큰 탭 [{ id, el }]
  let tabId = null;
  let subTabs = [];           // 지금 큰 탭의 작은 탭 [{ id, el }]
  const subOf = new Map();    // 큰 탭 → 마지막으로 본 작은 탭(category)
  let builtFor = 0;           // 카드를 만들 때 본 무기 수. setWeapons로 바뀌면 다시 만든다
  let slot = 0;               // 이모트 탭에서 고른 휠 칸(0 = 12시)

  const points = pointsBadge('sk-points--big');
  const tabsEl = h('div', { class: 'sk-tabs', role: 'tablist', 'aria-label': t('shop.aria.tabs') });
  const subTabsEl = h('div', { class: 'sk-tabs sk-subtabs', role: 'tablist', 'aria-label': t('shop.aria.subtabs'), hidden: true });
  const subBreak = h('span', { class: 'sk-shop-break', 'aria-hidden': 'true', hidden: true });
  const grid = h('div', { class: 'sk-shop-grid', role: 'tabpanel', 'aria-label': t('shop.aria.grid') });
  const note = h('p', { class: 'sk-shop-note', role: 'status' });
  const backBtn = btn([uiIcon('back'), h('span', { text: t('shop.back') })], () => ctx.emit('shop:back', {}), 'sk-btn--ghost');

  const el = h('section', { class: 'sk-screen sk-page sk-shop', hidden: true, tabindex: '-1', 'aria-label': t('shop.title') },
    h('div', { class: 'sk-page-inner' },
      h('header', { class: 'sk-bar' },
        backBtn,
        h('div', { class: 'sk-bar-title' },
          h('p', { class: 'sk-kicker', text: 'ARMORY // SUPPLY', 'aria-hidden': 'true' }),
          h('h1', { class: 'sk-h1 sk-stencil', text: t('shop.title') }),
          h('p', { class: 'sk-bar-sub', text: t('shop.sub', { price: fmtPoints(PREMIUM_PRICE) }) })),
        points.el),
      // 작은 탭 줄은 큰 탭 아래 새 줄(sk-shop-break)에 둔다. 같은 sk-shop-bar 안이라 휴대폰에서도 함께 위에 붙어 있다
      h('div', { class: 'sk-shop-bar' }, tabsEl, note, subBreak, subTabsEl),
      grid));

  ctx.listen(window, 'keydown', (e) => {
    if (e.key !== 'Escape' || !screen.visible || el.inert) return;
    e.preventDefault();
    ctx.emit('shop:back', {});
  }, true);

  const say = (text) => setText(note, text);

  // ---------- 코인 (account.online) ----------
  const registered = () => !!ctx.account && ctx.account.remoteEnabled && ctx.account.hasNickname() && !ctx.account.nicknamePending;
  const coinAvailable = (s) => !platform.isPortal && !!s && s.status === 'ready' && (s.pay.enabled || s.coinsEnabled);
  const coinPriceFor = (id) => {
    const online = ctx.account && ctx.account.online;
    return online && typeof online.coinPrice === 'function' ? online.coinPrice(id) : null;
  };

  /** 이모트·캐릭터 카드의 "코인으로 사기" 버튼 */
  function coinButton(getCard) {
    if (platform.isPortal) return null;   // CrazyGames 안에서는 외부 결제를 열 수 없다
    return h('button', { type: 'button', class: 'sk-btn sk-btn--ghost sk-coin-buy', hidden: true, onclick: () => buyWithCoins(getCard()) });
  }

  function paintCoinButton(card, owned) {
    if (!card.coinBtn) return;
    const s = onlineState(ctx);
    const price = coinPriceFor(card.id);
    const show = !owned && price != null && !!s && s.status === 'ready' && s.coinsEnabled && registered();
    card.coinBtn.hidden = !show;
    if (!show) return;
    const short = s.coins == null ? price : Math.max(0, price - s.coins);
    setText(card.coinBtn, t('shop.coin.buy', { n: count(price) }));
    card.coinBtn.disabled = !!s.busy || short > 0;
    card.coinBtn.title = short > 0 ? t('shop.coin.short', { n: count(short) }) : '';
  }

  async function buyWithCoins(card) {
    const name = loc(card.e || card.a || {}, 'name') || '';
    const r = await ctx.account.online.buyWithCoins(card.id);
    if (r.ok) {
      ctx.emit('ui:sound', { name: 'purchase' });
      say(t('shop.coin.bought', { name, spent: count(r.spent), coins: count(r.coins) }));
    } else {
      const s = onlineState(ctx);
      say((s && s.message && s.message.text) || t('shop.coin.failed'));
    }
    paintAll();
  }

  const coinBalance = h('b', { class: 'sk-coin-balance' });
  const coinTest = h('span', { class: 'sk-coin-test', text: t('shop.coin.test') });
  const coinDesc = h('p', { class: 'sk-lo-tagline sk-coin-desc' });
  const coinNote = h('p', { class: 'sk-nick-status sk-coin-note', role: 'status', hidden: true });
  const coinBox = h('section', { class: 'sk-av-box sk-steel sk-coin-box', 'aria-label': t('shop.coin.mine') },
    h('div', { class: 'sk-av-boxtext' },
      h('h3', { class: 'sk-shop-name' }, t('shop.coin.mine') + ' · ', coinBalance, ' ', coinTest),
      coinDesc, coinNote));
  const ordersList = h('div', { class: 'sk-coin-orders' });
  const ordersBox = h('section', { class: 'sk-av-box sk-steel sk-coin-ordersbox', 'aria-label': t('shop.coin.orders') },
    h('div', { class: 'sk-coin-ordershead' },
      h('h3', { class: 'sk-shop-name', text: t('shop.coin.orders') }),
      btn(t('shop.coin.refresh'), () => ctx.account.online.refresh(), 'sk-btn--sm sk-btn--ghost')),
    ordersList);
  const productCards = new Map();   // 상품 id → { el, action }
  let productKey = '';
  let ordersKey = '';

  function buildProductCard(p) {
    const action = h('button', { type: 'button', class: 'sk-btn sk-btn--primary sk-shop-action', text: t('shop.coin.topUp'),
      onclick: () => ctx.account.online.buyCoins(p.id) });
    const el = h('article', { class: 'sk-shop-card sk-steel sk-coin-card', 'aria-label': p.name },
      h('header', { class: 'sk-shop-head' },
        h('span', { class: 'sk-lo-ico', 'aria-hidden': 'true' }, uiIcon('coin')),
        h('div', { class: 'sk-shop-names' },
          h('h3', { class: 'sk-shop-name', text: p.name }),
          h('p', { class: 'sk-lo-tagline', text: t('shop.coin.productTag', { n: count(p.coins) }) })),
        h('span', { class: 'sk-shop-state', text: won(p.amount) })),
      h('footer', { class: 'sk-shop-foot' }, action));
    return { el, action };
  }

  function orderRow(o, s) {
    const at = o.at ? new Date(o.at).toLocaleString(getLang() === 'en' ? 'en-US' : 'ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
    return h('div', { class: `sk-coin-order is-${String(o.status).toLowerCase()}` },
      h('span', { class: 'sk-coin-order-name', text: t('shop.coin.n', { n: count(o.coins) }) }),
      h('span', { class: 'sk-coin-order-amount', text: won(o.amount) }),
      h('span', { class: 'sk-coin-order-status', text: orderStatusText(o.status) }),
      h('span', { class: 'sk-coin-order-date', text: at }),
      o.refundable ? btn(t('shop.coin.refund'), () => ctx.account.online.refund(o.orderId), 'sk-btn--sm sk-btn--ghost sk-coin-refund',
        { title: t('shop.coin.refundTip', { n: count(o.coins), days: s.pay.refundDays }) }) : null);
  }

  function paintCoins() {
    const s = onlineState(ctx);
    const tab = tabs.find((t) => t.id === COIN_TAB);
    if (tab) tab.el.hidden = !coinAvailable(s);
    if (!s || s.status !== 'ready') return;
    setText(coinBalance, s.coins == null ? '—' : t('shop.coin.balance', { n: count(s.coins) }));
    coinTest.hidden = !s.pay.test;
    let desc;
    if (!registered()) desc = t('shop.coin.needNick');
    else if (!s.pay.enabled) desc = t('shop.coin.payClosed');
    else desc = t('shop.coin.desc', { limit: s.pay.dailyLimit, days: s.pay.refundDays });
    setText(coinDesc, desc);
    paintNote(coinNote, s, { kinds: ['pay', 'refund', 'coins'] });

    const pk = s.pay.products.map((p) => `${p.id}:${p.coins}:${p.amount}`).join('|');
    if (pk !== productKey) {
      productKey = pk;
      productCards.clear();
      for (const p of s.pay.products) productCards.set(p.id, buildProductCard(p));
      if (tabId === COIN_TAB) showTab(COIN_TAB);
    }
    for (const c of productCards.values()) {
      setText(c.action, s.busy === 'pay' ? t('shop.coin.opening') : t('shop.coin.topUp'));
      c.action.disabled = !!s.busy || !s.pay.enabled || !registered();
    }
    const ok = s.orders.map((o) => `${o.orderId}:${o.status}:${o.refundable}`).join('|');
    if (ok !== ordersKey) {
      ordersKey = ok;
      ordersList.replaceChildren(...(s.orders.length ? s.orders.map((o) => orderRow(o, s)) : [h('p', { class: 'sk-set-hint', text: t('shop.coin.noOrders') })]));
    }
    for (const b of ordersList.querySelectorAll('button')) b.disabled = !!s.busy;
  }

  // ---------- 무기 카드 ----------
  function buildCard(def) {
    const w = normWeapon(ctx.weapons, def);
    const state = h('span', { class: 'sk-shop-state' });
    const need = h('p', { class: 'sk-shop-need' });
    const action = h('button', { type: 'button', class: 'sk-btn sk-shop-action', onclick: () => act(card) });
    const articleEl = h('article', { class: 'sk-shop-card sk-steel', 'aria-label': w.name },
      h('header', { class: 'sk-shop-head' },
        h('span', { class: 'sk-lo-ico', 'aria-hidden': 'true' }, uiIcon(weaponGlyph(w.id, w.slot))),
        h('div', { class: 'sk-shop-names' },
          h('h3', { class: 'sk-shop-name', text: w.name },
            w.premium ? h('span', { class: 'sk-premium', text: t('shop.premium') }) : null),
          w.tagline ? h('p', { class: 'sk-lo-tagline', text: w.tagline }) : null),
        state),
      w.bars.length ? barMeters(w.bars, 'sk-shop-bars') : null,
      w.stats.length ? h('dl', { class: 'sk-shop-stats' },
        w.stats.map((s) => h('div', { class: 'sk-shop-stat' }, h('dt', { text: s.label }), h('dd', { text: s.value })))) : null,
      h('footer', { class: 'sk-shop-foot' }, need, action));
    const card = { id: def.id, w, slotKey: def.id === 'gr_frag' ? null : SLOT_KEYS[def.slot] || null, el: articleEl, state, need, action };
    return card;
  }

  function paintCard(card) {
    const a = ctx.account;
    // 수류탄은 모두에게 기본으로 주는 무기라 사거나 장착하지 않는다
    card.action.hidden = !card.slotKey;
    if (!card.slotKey) { setText(card.state, t('shop.issued')); setText(card.need, ''); card.el.classList.add('is-owned'); return; }
    const owned = a.isOwned(card.id);
    const equipped = owned && a.loadout[card.slotKey] === card.id;
    const closed = !owned && !sellable(a, card.id);   // 서버 가격표에 아직 없다
    const short = owned || closed ? 0 : Math.max(0, card.w.price - a.profile.points);
    card.el.classList.toggle('is-owned', owned);
    card.el.classList.toggle('is-equipped', equipped);
    setText(card.state, equipped ? t('shop.equipped') : owned ? t('shop.owned') : fmtPoints(card.w.price));
    setText(card.need, short ? t('shop.need', { p: fmtPoints(short) }) : '');
    setText(card.action, equipped ? t('shop.equipped') : owned ? t('shop.equip') : closed ? t('shop.soon') : t('shop.buy', { p: fmtPoints(card.w.price) }));
    card.action.disabled = equipped || closed || short > 0;
    card.action.classList.toggle('sk-btn--primary', !owned && !closed && !short);
    card.action.classList.toggle('sk-btn--ghost', equipped);
  }

  function buy(card) {
    const r = ctx.account.buy(card.id);
    if (r.ok) {
      ctx.emit('ui:sound', { name: 'purchase' });
      say(t('shop.w.bought', { name: card.w.name, p: fmtPoints(r.points) }));
    } else if (r.reason === 'points') {
      say(t('shop.shortPts', { p: fmtPoints(card.w.price - r.points) }));
    } else if (r.reason === 'owned') {
      say(t('shop.w.owned', { name: card.w.name }));
    } else if (r.reason === 'closed') {
      say(NOT_READY_NOTE);
    } else {
      say(t('shop.w.cantBuy'));
    }
  }

  function equip(card) {
    const r = ctx.account.equip(card.slotKey, card.id);
    say(r.ok ? t('shop.w.equipped', { name: card.w.name }) : t('shop.w.cantEquip'));
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
  const emoteName = (id) => loc(EMOTES.find((e) => e.id === id) || { name: '' }, 'name');

  const chips = Array.from({ length: EMOTE_WHEEL.SLOTS }, (_, i) => {
    const ico = h('span', { class: 'sk-emo-slot-ico', 'aria-hidden': 'true' });
    const name = h('span', { class: 'sk-emo-slot-name' });
    const chipEl = h('button', { type: 'button', class: 'sk-emo-slot', role: 'radio', 'aria-checked': 'false',
      onclick: () => { slot = i; paintAll(); } },
    h('span', { class: 'sk-emo-slot-num', text: String(i + 1) }), ico, name);
    return { i, el: chipEl, ico, name };
  });
  const wheelBox = h('section', { class: 'sk-emo-wheelbox sk-steel', 'aria-label': t('shop.emo.myWheel') },
    h('header', { class: 'sk-emo-wheelhead' },
      h('h3', { class: 'sk-shop-name', text: t('shop.emo.myWheel') }),
      h('p', { class: 'sk-lo-tagline', text: t('shop.emo.wheelTip') })),
    h('div', { class: 'sk-emo-slots', role: 'radiogroup', 'aria-label': t('shop.emo.slots') }, ...chips.map((c) => c.el)));

  function buildEmoteCard(e) {
    const state = h('span', { class: 'sk-shop-state' });
    const need = h('p', { class: 'sk-shop-need' });
    const action = h('button', { type: 'button', class: 'sk-btn sk-shop-action', onclick: () => actEmote(card) });
    const coinBtn = coinButton(() => card);
    const preview = h('button', { type: 'button', class: 'sk-btn sk-btn--ghost sk-emo-preview', title: t('shop.emo.previewTip', { name: loc(e, 'name') }),
      onclick: () => { ctx.emit('shop:preview', { id: e.id }); say(t('shop.emo.previewing', { name: loc(e, 'name') })); } }, uiIcon('play'), t('shop.emo.listen'));
    const articleEl = h('article', { class: 'sk-shop-card sk-steel sk-emo-card', 'aria-label': loc(e, 'name') },
      h('header', { class: 'sk-shop-head' },
        h('span', { class: 'sk-lo-ico', text: e.icon, 'aria-hidden': 'true' }),
        h('div', { class: 'sk-shop-names' },
          h('h3', { class: 'sk-shop-name', text: loc(e, 'name') },
            e.price ? null : h('span', { class: 'sk-emo-free', text: t('shop.free') })),
          e.desc ? h('p', { class: 'sk-lo-tagline', text: loc(e, 'desc') }) : null),
        state),
      h('footer', { class: 'sk-shop-foot' }, need, h('div', { class: 'sk-emo-actions' }, preview, action), coinBtn));
    const card = { id: e.id, e, el: articleEl, state, need, action, preview, coinBtn };
    return card;
  }

  function paintEmoteCard(card, wheel) {
    const a = ctx.account;
    const owned = a.isOwned(card.id);
    const at = wheel.indexOf(card.id);
    const here = owned && at === slot;
    const closed = !owned && !sellable(a, card.id);
    const short = owned || closed ? 0 : Math.max(0, (card.e.price || 0) - a.profile.points);
    const n = slot + 1;
    card.el.classList.toggle('is-owned', owned);
    card.el.classList.toggle('is-equipped', at >= 0);
    setText(card.state, at >= 0 ? t('shop.emo.onWheel', { n: at + 1 }) : owned ? t('shop.owned') : fmtPoints(card.e.price));
    setText(card.need, short ? t('shop.need', { p: fmtPoints(short) }) : '');
    setText(card.action, !owned ? (closed ? t('shop.soon') : t('shop.buy', { p: fmtPoints(card.e.price) })) : here ? t('shop.emo.inSlot', { n }) : at >= 0 ? t('shop.emo.swap', { n }) : t('shop.emo.set', { n }));
    card.action.disabled = here || closed || short > 0;
    card.action.classList.toggle('sk-btn--primary', !here && !closed && !short);
    card.action.classList.toggle('sk-btn--ghost', here);
    paintCoinButton(card, owned);
  }

  function paintChips(wheel) {
    for (const c of chips) {
      const e = EMOTES.find((x) => x.id === wheel[c.i]);
      setText(c.ico, e ? e.icon : '');
      setText(c.name, e ? loc(e, 'name') : t('shop.emo.empty'));
      const on = c.i === slot;
      c.el.classList.toggle('is-on', on);
      c.el.setAttribute('aria-checked', on ? 'true' : 'false');
      c.el.title = t('shop.emo.slotTip', { n: c.i + 1, name: e ? loc(e, 'name') : t('shop.emo.empty') });
    }
  }

  function actEmote(card) {
    const a = ctx.account;
    const n = slot + 1;
    if (!a.isOwned(card.id)) {
      const r = a.buy(card.id);
      if (r.ok) {
        ctx.emit('ui:sound', { name: 'purchase' });
        say(t('shop.emo.bought', { name: loc(card.e, 'name'), p: fmtPoints(r.points) }));
      } else if (r.reason === 'points') {
        say(t('shop.shortPts', { p: fmtPoints((card.e.price || 0) - r.points) }));
      } else if (r.reason === 'closed') {
        say(NOT_READY_NOTE);
      } else {
        say(t('shop.emo.cantBuy'));
      }
    } else if (typeof a.equipEmote === 'function') {
      const before = wheelOf();
      const from = before.indexOf(card.id);
      const out = before[slot];
      const r = a.equipEmote(slot, card.id);
      if (!r.ok) say(t('shop.emo.cantSet'));
      else if (from >= 0 && from !== slot) say(t('shop.emo.swapped', { a: from + 1, b: n }));
      else if (out && out !== card.id) say(t('shop.emo.setReplaced', { n, name: loc(card.e, 'name'), old: emoteName(out) }));
      else say(t('shop.emo.setDone', { n, name: loc(card.e, 'name') }));
    }
    paintAll();
  }

  // ---------- 캐릭터 탭: 지금 캐릭터 + 팀 색 보기 + 캐릭터 카드 ----------
  const avatarNow = () => (ctx.account && ctx.account.loadout && ctx.account.loadout.avatar) || DEFAULT_AVATAR;
  const avName = (id) => loc(AVATARS.find((a) => a.id === id) || AVATARS[0], 'name');
  const nowName = h('b', { class: 'sk-av-now' });
  const teamBtns = TEAM_IDS.map((team) => {
    const el = h('button', { type: 'button', class: 'sk-btn sk-seg-btn sk-av-team', role: 'radio', 'aria-checked': 'false', 'data-team': team,
      onclick: () => { artTeam = team; paintAll(); } }, h('span', { class: 'sk-av-dot', style: `background:${TEAMS[team].light}`, 'aria-hidden': 'true' }), t('shop.av.team', { team: loc(TEAMS[team], 'name') }));
    return { team, el };
  });
  const shopNote = h('p', { class: 'sk-av-closed', role: 'status', hidden: true });
  const avBox = h('section', { class: 'sk-av-box sk-steel', 'aria-label': t('shop.av.mine') },
    h('div', { class: 'sk-av-boxtext' },
      h('h3', { class: 'sk-shop-name' }, t('shop.av.now') + ' · ', nowName),
      h('p', { class: 'sk-lo-tagline', text: t('shop.av.tip') }),
      shopNote),
    h('div', { class: 'sk-seg sk-av-teams', role: 'radiogroup', 'aria-label': t('shop.av.teamColor') }, ...teamBtns.map((b) => b.el)));

  function buildAvatarCard(a) {
    const art = avatarArtEl(a);
    const state = h('span', { class: 'sk-shop-state' });
    const need = h('p', { class: 'sk-shop-need' });
    const action = h('button', { type: 'button', class: 'sk-btn sk-shop-action', onclick: () => actAvatar(card) });
    const coinBtn = coinButton(() => card);
    const articleEl = h('article', { class: 'sk-shop-card sk-steel sk-av-card', 'aria-label': loc(a, 'name'), 'data-avatar': a.id },
      art.el,
      h('div', { class: 'sk-av-body' },
        h('header', { class: 'sk-shop-head' },
          h('div', { class: 'sk-shop-names' },
            h('h3', { class: 'sk-shop-name', text: loc(a, 'name') },
              a.price ? null : h('span', { class: 'sk-emo-free', text: t('shop.free') })),
            h('p', { class: 'sk-lo-tagline', text: loc(a, 'desc') })),
          state),
        h('footer', { class: 'sk-shop-foot' }, need, action, coinBtn)));
    const card = { id: a.id, a, art, el: articleEl, state, need, action, coinBtn };
    return card;
  }

  /** 캐릭터 구매를 열었는가. 계정이 모르면(옛 계정 대역) 연 것으로 본다 */
  const avatarShopState = () => (ctx.account && typeof ctx.account.avatarShop === 'string' ? ctx.account.avatarShop : 'open');

  function paintAvatarCard(card, now, drawArt, open) {
    const a = ctx.account;
    const owned = a.isOwned(card.id);
    const equipped = owned && now === card.id;
    const closed = !owned && (!open || !sellable(a, card.id));   // 서버가 캐릭터를 알기 전에는 사지 못한다(장착은 된다)
    const short = owned || closed ? 0 : Math.max(0, (card.a.price || 0) - a.profile.points);
    card.el.classList.toggle('is-owned', owned);
    card.el.classList.toggle('is-equipped', equipped);
    setText(card.state, equipped ? t('shop.equipped') : owned ? t('shop.owned') : fmtPoints(card.a.price));
    setText(card.need, short ? t('shop.need', { p: fmtPoints(short) }) : '');
    setText(card.action, equipped ? t('shop.equipped') : owned ? t('shop.equip') : closed ? t('shop.soon') : t('shop.buy', { p: fmtPoints(card.a.price) }));
    card.action.disabled = equipped || closed || short > 0;
    card.action.classList.toggle('sk-btn--primary', !owned && !closed && !short);
    card.action.classList.toggle('sk-btn--ghost', equipped);
    paintCoinButton(card, owned);
    if (drawArt) card.art.paint(ctx.avatarArt, artTeam);
  }

  function actAvatar(card) {
    const a = ctx.account;
    const name = loc(card.a, 'name');
    if (!a.isOwned(card.id)) {
      const r = a.buy(card.id);
      if (r.ok) {
        ctx.emit('ui:sound', { name: 'purchase' });
        say(t('shop.av.bought', { name, p: fmtPoints(r.points) }));
      } else if (r.reason === 'points') {
        say(t('shop.shortPts', { p: fmtPoints((card.a.price || 0) - r.points) }));
      } else if (r.reason === 'closed') {
        say(CLOSED_NOTE);
      } else {
        say(t('shop.av.cantBuy'));
      }
    } else {
      const r = typeof a.equipAvatar === 'function' ? a.equipAvatar(card.id) : { ok: false };
      say(r.ok ? t('shop.av.equipped', { name }) : t('shop.av.cantEquip'));
    }
    paintAll();
  }

  function paintAvatars() {
    const now = avatarNow();
    const state = avatarShopState();
    setText(nowName, avName(now));
    setText(shopNote, state === 'checking' ? CHECKING_NOTE : state === 'closed' ? CLOSED_NOTE : '');
    shopNote.hidden = state === 'open';
    for (const b of teamBtns) {
      const on = b.team === artTeam;
      b.el.classList.toggle('is-on', on);
      b.el.setAttribute('aria-checked', on ? 'true' : 'false');
    }
    const drawArt = tabId === AVATAR_TAB;   // 초상은 캐릭터 탭이 보일 때만 그린다(처음 한 번만 실제로 그리고 그 뒤로는 저장한 그림)
    for (const card of avCards.values()) paintAvatarCard(card, now, drawArt, state === 'open');
  }

  function paintAll() {
    if (!ctx.account) return;
    points.set(ctx.account.profile.points);
    for (const card of cards.values()) paintCard(card);
    const wheel = wheelOf();
    paintChips(wheel);
    for (const card of emoCards.values()) paintEmoteCard(card, wheel);
    paintAvatars();
    paintCoins();
  }

  // ---------- 탭 ----------
  /** 큰 탭: 무기 묶음 · 이모트 · 캐릭터 · 코인. 무기 묶음은 작은 탭(종류)을 그리고 마지막으로 본 종류를 연다 */
  function showTab(id, sub) {
    tabId = id;
    for (const t of tabs) {
      const on = t.id === id;
      t.el.classList.toggle('is-on', on);
      t.el.setAttribute('aria-selected', on ? 'true' : 'false');
      t.el.tabIndex = on ? 0 : -1;
    }
    const weapons = GROUPS.some(([g]) => g === id);
    grid.classList.toggle('sk-shop-grid--av', id === AVATAR_TAB);
    grid.scrollTop = 0;
    if (weapons) {
      const cats = categoriesOf(id);
      subTabs = cats.map((c) => ({ id: c, el: h('button', { type: 'button', class: 'sk-subtab', role: 'tab', 'data-sub': c, onclick: () => showSub(c), text: SUB_LABELS[c] || c }) }));
      subTabsEl.replaceChildren(...subTabs.map((t) => t.el));
      subTabsEl.hidden = subBreak.hidden = subTabs.length < 2;   // 종류가 하나뿐이면(근접) 작은 탭 줄을 숨긴다
      const want = [sub, subOf.get(id)].find((c) => c && cats.includes(c)) || cats[0];
      showSub(want);
      return;
    }
    subTabs = [];
    subTabsEl.hidden = subBreak.hidden = true;
    subTabsEl.replaceChildren();
    if (id === EMOTE_TAB) grid.replaceChildren(wheelBox, ...[...emoCards.values()].map((c) => c.el));
    else if (id === AVATAR_TAB) grid.replaceChildren(avBox, ...[...avCards.values()].map((c) => c.el));
    else if (id === COIN_TAB) grid.replaceChildren(coinBox, ...[...productCards.values()].map((c) => c.el), ordersBox);
    if (id === AVATAR_TAB && ctx.account) paintAvatars();
  }

  /** 작은 탭(무기 종류): 지금 큰 탭 안에서 그 종류의 카드만 */
  function showSub(cat) {
    subOf.set(tabId, cat);
    for (const t of subTabs) {
      const on = t.id === cat;
      t.el.classList.toggle('is-on', on);
      t.el.setAttribute('aria-selected', on ? 'true' : 'false');
      t.el.tabIndex = on ? 0 : -1;
    }
    grid.replaceChildren(...[...cards.values()].filter((c) => c.group === tabId && c.category === cat).map((c) => c.el));
    grid.scrollTop = 0;
  }

  /** 이 큰 탭에 있는 무기 종류(SUB_LABELS 순서, 모르는 종류는 뒤에) */
  function categoriesOf(group) {
    const cats = [...new Set([...cards.values()].filter((c) => c.group === group).map((c) => c.category))];
    const known = Object.keys(SUB_LABELS).filter((c) => cats.includes(c));
    return [...known, ...cats.filter((c) => !known.includes(c))];
  }

  function moveIn(list, current, step, open) {
    const shown = list.filter((t) => !t.el.hidden);
    const i = shown.findIndex((t) => t.id === current);
    const next = shown[(i + step + shown.length) % shown.length];
    if (!next) return;
    open(next.id);
    next.el.focus();
  }

  tabsEl.addEventListener('keydown', (e) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    moveIn(tabs, tabId, step, (id) => showTab(id));
  });
  subTabsEl.addEventListener('keydown', (e) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    moveIn(subTabs, subOf.get(tabId), step, showSub);
  });

  function build() {
    // 좀비 물량 막기 전용 무기(zombieOnly)는 파는 물건이 아니다. shop이 붙은 것(공기총·말뚝건·투척 도끼)만 판다(좀비 모드에서만 든다)
    const defs = [...ctx.weapons.values()].filter((d) => groupOf(d) && (!d.zombieOnly || d.shop));
    cards.clear();
    for (const d of defs) {
      const card = buildCard(d);
      card.group = groupOf(d);
      card.category = d.category || 'etc';
      cards.set(d.id, card);
    }
    if (!emoCards.size) for (const e of EMOTES) emoCards.set(e.id, buildEmoteCard(e));
    if (!avCards.size) for (const a of AVATARS) avCards.set(a.id, buildAvatarCard(a));
    const groups = GROUPS.filter(([g]) => defs.some((d) => groupOf(d) === g));
    const label = Object.fromEntries([...groups, [EMOTE_TAB, t('shop.tab.emote')], [AVATAR_TAB, t('shop.tab.avatar')], [COIN_TAB, t('shop.tab.coins')]]);
    tabs = [...groups.map(([g]) => g), EMOTE_TAB, AVATAR_TAB, COIN_TAB].map((id) => {
      const tabEl = h('button', { type: 'button', class: 'sk-tab', role: 'tab', 'data-tab': id, onclick: () => showTab(id) },
        TAB_GLYPH[id] ? uiIcon(TAB_GLYPH[id], 'sk-tab-ico') : null, label[id]);
      return { id, el: tabEl };
    });
    tabsEl.replaceChildren(...tabs.map((t) => t.el));
    builtFor = ctx.weapons.size;
    tabId = null;
    subOf.clear();
  }

  function render(p, { first, fresh }) {
    if (!ctx.account) return;
    if (first) say('');
    if (builtFor !== ctx.weapons.size) build();
    // props의 tab은 show로 열 때만 따른다. update(계정이 바뀔 때마다)에서 따르면 보던 탭으로 되돌아가고,
    // 카드를 다시 붙이느라 누른 버튼의 포커스와 스크롤을 잃는다
    const want = fresh && p && p.tab;
    const coinsOn = coinAvailable(onlineState(ctx));
    // 예전 탭 이름(무기 종류 'rifle' 등)으로 열어도 그 종류가 든 큰 탭과 작은 탭을 연다
    const legacy = want && !tabs.some((t) => t.id === want) ? [...cards.values()].find((c) => c.category === want) : null;
    if (legacy) showTab(legacy.group, want);
    else if (want && tabs.some((t) => t.id === want) && (want !== COIN_TAB || coinsOn)) showTab(want);
    else if (tabs.length && (!tabs.some((t) => t.id === tabId) || (tabId === COIN_TAB && !coinsOn))) showTab(tabs[0].id);
    paintAll();
  }

  const screen = makeScreen(el, { render, onShow: () => backBtn.focus({ preventScroll: true }) });
  return screen;
}
