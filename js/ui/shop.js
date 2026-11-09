/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 상점. def.category로 나눈 무기 탭과 무기 카드(이름·가격·막대·스탯·구매/장착), 이모트 탭(휠 8칸 장착·구매·미리 듣기)을 보여 준다.
 *          포인트는 계정이 바뀔 때마다 바로 갱신한다. 이벤트: shop:back, shop:preview { id }, ui:sound { name:'purchase' }.
 *          카드는 다시 만들지 않고 고쳐서 키보드 포커스를 잃지 않는다.
 *          캐릭터 탭: 초상(ui.setAvatarArt로 받은 그림, 없으면 아이콘)·구매·장착. 초상은 탭을 처음 열 때 그린다.
 *          서버가 캐릭터를 모르면(account.avatarShop) 구매 버튼을 끄고 안내한다. props.tab은 show로 열 때만 따른다.
 */
import { h, btn, fmtPoints, setText } from './dom.js';
import { avatarArtEl, barMeters, makeScreen, normWeapon, pointsBadge } from './parts.js';
import { PREMIUM_PRICE } from '../weapons/defs.js';
import { EMOTES, EMOTE_WHEEL, TEAMS, TEAM_IDS } from '../core/consts.js';
import { AVATARS, DEFAULT_AVATAR } from '../core/avatar-defs.js';

const TAB_LABELS = { rifle: '라이플', sniper: '저격', smg: 'SMG·샷건', pistol: '권총', melee: '근접' };
/** 이모트 탭 id. 무기 category와 겹치지 않는다 */
export const EMOTE_TAB = 'emote';
/** 캐릭터 탭 id */
export const AVATAR_TAB = 'avatar';
/** 캐릭터 구매가 닫혀 있을 때 안내(account.avatarShop) */
const CLOSED_NOTE = '캐릭터 구매는 서버 업데이트 뒤에 열려요. 기본 캐릭터와 이미 가진 캐릭터는 지금도 입을 수 있어요.';
const CHECKING_NOTE = '캐릭터 구매를 열 수 있는지 서버에 확인하고 있어요.';
/** 상점에서 다루는 슬롯과 계정 장비 칸. 슬롯 4(수류탄)는 팔지 않는다. */
const SLOT_KEYS = { 1: 'primary', 2: 'secondary', 3: 'melee' };

export function createShop(ctx) {
  const cards = new Map();    // 무기 id → 카드
  const emoCards = new Map(); // 이모트 id → 카드
  const avCards = new Map();  // 캐릭터 id → 카드
  let artTeam = TEAM_IDS[0];  // 캐릭터 초상의 팀 색
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
          h('p', { class: 'sk-bar-sub', text: `경기와 비밀 스팟으로 모은 포인트로 무기·이모트·캐릭터를 사서 장착해요. ${fmtPoints(PREMIUM_PRICE)} 이상인 프리미엄 총은 예비 탄약이 무제한이에요.` })),
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

  // ---------- 캐릭터 탭: 지금 캐릭터 + 팀 색 보기 + 캐릭터 카드 ----------
  const avatarNow = () => (ctx.account && ctx.account.loadout && ctx.account.loadout.avatar) || DEFAULT_AVATAR;
  const avName = (id) => (AVATARS.find((a) => a.id === id) || AVATARS[0]).name;
  const nowName = h('b', { class: 'sk-av-now' });
  const teamBtns = TEAM_IDS.map((team) => {
    const el = h('button', { type: 'button', class: 'sk-btn sk-seg-btn sk-av-team', role: 'radio', 'aria-checked': 'false', 'data-team': team,
      onclick: () => { artTeam = team; paintAll(); } }, h('span', { class: 'sk-av-dot', style: `background:${TEAMS[team].light}`, 'aria-hidden': 'true' }), `${TEAMS[team].name} 팀`);
    return { team, el };
  });
  const shopNote = h('p', { class: 'sk-av-closed', role: 'status', hidden: true });
  const avBox = h('section', { class: 'sk-av-box sk-steel', 'aria-label': '내 캐릭터' },
    h('div', { class: 'sk-av-boxtext' },
      h('h3', { class: 'sk-shop-name' }, '지금 캐릭터 · ', nowName),
      h('p', { class: 'sk-lo-tagline', text: '모양만 다르고 몸 크기와 맞는 판정은 모두 같아요. 전투복과 표식은 팀 색이라 어느 캐릭터든 팀이 잘 보여요.' }),
      shopNote),
    h('div', { class: 'sk-seg sk-av-teams', role: 'radiogroup', 'aria-label': '초상 팀 색' }, ...teamBtns.map((b) => b.el)));

  function buildAvatarCard(a) {
    const art = avatarArtEl(a);
    const state = h('span', { class: 'sk-shop-state' });
    const need = h('p', { class: 'sk-shop-need' });
    const action = h('button', { type: 'button', class: 'sk-btn sk-shop-action', onclick: () => actAvatar(card) });
    const articleEl = h('article', { class: 'sk-shop-card sk-steel sk-av-card', 'aria-label': a.name, 'data-avatar': a.id },
      art.el,
      h('div', { class: 'sk-av-body' },
        h('header', { class: 'sk-shop-head' },
          h('div', { class: 'sk-shop-names' },
            h('h3', { class: 'sk-shop-name', text: a.name },
              a.price ? null : h('span', { class: 'sk-emo-free', text: '기본' })),
            h('p', { class: 'sk-lo-tagline', text: a.desc })),
          state),
        h('footer', { class: 'sk-shop-foot' }, need, action)));
    const card = { id: a.id, a, art, el: articleEl, state, need, action };
    return card;
  }

  /** 캐릭터 구매를 열었는가. 계정이 모르면(옛 계정 대역) 연 것으로 본다 */
  const avatarShopState = () => (ctx.account && typeof ctx.account.avatarShop === 'string' ? ctx.account.avatarShop : 'open');

  function paintAvatarCard(card, now, drawArt, open) {
    const a = ctx.account;
    const owned = a.isOwned(card.id);
    const equipped = owned && now === card.id;
    const closed = !owned && !open;   // 서버가 캐릭터를 알기 전에는 사지 못한다(장착은 된다)
    const short = owned || closed ? 0 : Math.max(0, (card.a.price || 0) - a.profile.points);
    card.el.classList.toggle('is-owned', owned);
    card.el.classList.toggle('is-equipped', equipped);
    setText(card.state, equipped ? '장착 중' : owned ? '보유' : fmtPoints(card.a.price));
    setText(card.need, short ? `${fmtPoints(short)} 더 필요해요` : '');
    setText(card.action, equipped ? '장착 중' : owned ? '장착' : closed ? '구매 준비 중' : `구매 ${fmtPoints(card.a.price)}`);
    card.action.disabled = equipped || closed || short > 0;
    card.action.classList.toggle('sk-btn--primary', !owned && !closed && !short);
    card.action.classList.toggle('sk-btn--ghost', equipped);
    if (drawArt) card.art.paint(ctx.avatarArt, artTeam);
  }

  function actAvatar(card) {
    const a = ctx.account;
    const name = card.a.name;
    if (!a.isOwned(card.id)) {
      const r = a.buy(card.id);
      if (r.ok) {
        ctx.emit('ui:sound', { name: 'purchase' });
        say(`${name}을(를) 샀어요. 남은 포인트 ${fmtPoints(r.points)}. 장착을 누르면 바로 입어요.`);
      } else if (r.reason === 'points') {
        say(`포인트가 모자라요. ${fmtPoints((card.a.price || 0) - r.points)} 더 필요해요.`);
      } else if (r.reason === 'closed') {
        say(CLOSED_NOTE);
      } else {
        say('이 캐릭터는 살 수 없어요.');
      }
    } else {
      const r = typeof a.equipAvatar === 'function' ? a.equipAvatar(card.id) : { ok: false };
      say(r.ok ? `${name}을(를) 장착했어요. 경기에서 다른 사람에게도 이 모습으로 보여요.` : '이 캐릭터는 장착할 수 없어요.');
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
    else if (id === AVATAR_TAB) grid.replaceChildren(avBox, ...[...avCards.values()].map((c) => c.el));
    else grid.replaceChildren(...[...cards.values()].filter((c) => c.category === id).map((c) => c.el));
    grid.classList.toggle('sk-shop-grid--av', id === AVATAR_TAB);
    grid.scrollTop = 0;
    if (id === AVATAR_TAB && ctx.account) paintAvatars();
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
    if (!avCards.size) for (const a of AVATARS) avCards.set(a.id, buildAvatarCard(a));
    const cats = [...new Set(defs.map((d) => d.category || 'etc'))];
    const known = Object.keys(TAB_LABELS).filter((c) => cats.includes(c));
    const rest = cats.filter((c) => !known.includes(c));
    const label = (id) => (id === EMOTE_TAB ? '이모트' : id === AVATAR_TAB ? '캐릭터' : TAB_LABELS[id] || id);
    tabs = [...known, ...rest, EMOTE_TAB, AVATAR_TAB].map((id) => {
      const tabEl = h('button', { type: 'button', class: 'sk-tab', role: 'tab', 'data-tab': id, onclick: () => showTab(id), text: label(id) });
      return { id, el: tabEl };
    });
    tabsEl.replaceChildren(...tabs.map((t) => t.el));
    builtFor = ctx.weapons.size;
    tabId = null;
  }

  function render(p, { first, fresh }) {
    if (!ctx.account) return;
    if (first) say('');
    if (builtFor !== ctx.weapons.size) build();
    // props의 tab은 show로 열 때만 따른다. update(계정이 바뀔 때마다)에서 따르면 보던 탭으로 되돌아가고,
    // 카드를 다시 붙이느라 누른 버튼의 포커스와 스크롤을 잃는다
    const want = fresh && p && p.tab;
    if (want && tabs.some((t) => t.id === want)) showTab(want);
    else if (tabs.length && !tabs.some((t) => t.id === tabId)) showTab(tabs[0].id);
    paintAll();
  }

  const screen = makeScreen(el, { render, onShow: () => backBtn.focus({ preventScroll: true }) });
  return screen;
}
