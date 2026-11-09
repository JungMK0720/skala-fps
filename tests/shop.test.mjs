/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 상점 화면 시험. 아주 작은 DOM 대역으로 탭 유지(계정이 바뀌어도 보던 탭·스크롤·버튼이 그대로), 캐릭터 구매·장착, 서버가 캐릭터를 모를 때 구매가 닫히는지 본다.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createShop } from '../js/ui/shop.js';
import { WEAPONS } from '../js/weapons/defs.js';
import { createAccount } from '../js/account/index.js';
import { AVATARS, DEFAULT_AVATAR } from '../js/core/avatar-defs.js';

class FakeNode {}
class FakeEl extends FakeNode {
  constructor(tag) {
    super();
    this.tagName = String(tag).toUpperCase();
    this.kids = [];
    this.attrs = {};
    this.own = '';
    this.handlers = {};
    this.className = '';
    this.dataset = {};
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.scrollTop = 0;
    this.replaced = 0;
    this.style = { setProperty() {} };
    const extra = new Set();
    this.classList = {
      toggle: (c, on) => { if (on === undefined ? !extra.has(c) : on) extra.add(c); else extra.delete(c); },
      add: (c) => extra.add(c),
      remove: (c) => extra.delete(c),
      contains: (c) => extra.has(c) || this.className.split(/\s+/).includes(c)
    };
  }
  get textContent() { return this.own + this.kids.map((k) => (typeof k === 'string' ? k : k.textContent)).join(''); }
  set textContent(v) { this.own = String(v); this.kids = []; }
  get children() { return this.kids.filter((k) => typeof k !== 'string'); }
  append(...list) { this.kids.push(...list); }
  prepend(...list) { this.kids.unshift(...list); }
  replaceChildren(...list) { this.kids = list; this.own = ''; this.replaced++; }
  contains(node) { return node === this || this.children.some((k) => k.contains(node)); }
  remove() {}
  focus() {}
  select() {}
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  addEventListener(type, fn) { (this.handlers[type] = this.handlers[type] || []).push(fn); }
  removeEventListener() {}
  fire(type, e = {}) { for (const fn of this.handlers[type] || []) fn({ target: this, preventDefault() {}, stopPropagation() {}, ...e }); }
  all(pred, out = []) {
    for (const k of this.children) {
      if (pred(k)) out.push(k);
      k.all(pred, out);
    }
    return out;
  }
}

const CONFIG = Object.freeze({ url: 'https://proj.supabase.co', anonKey: 'sb_publishable_test' });

/** 서버 대역. features가 null이면 schema.sql을 다시 실행하기 전의 서버(fps_features 404) */
function fakeFetch({ features = { ok: true, avatars: true } } = {}) {
  return async (url) => {
    const fn = url.split('/rpc/')[1];
    if (fn === 'fps_features' && !features) return { ok: false, status: 404, json: async () => ({ code: 'PGRST202' }) };
    const body = fn === 'fps_features' ? features : { ok: false, error: 'NOT_FOUND' };
    return { ok: true, status: 200, json: async () => body };
  };
}

describe('상점 화면', () => {
  const saved = {};
  const NAMES = ['document', 'Node', 'window'];
  before(() => {
    for (const n of NAMES) saved[n] = globalThis[n];
    globalThis.Node = FakeNode;
    globalThis.window = globalThis;
    globalThis.document = {
      activeElement: null,
      createElement: (tag) => new FakeEl(tag),
      createElementNS: (_ns, tag) => new FakeEl(tag)
    };
  });
  after(() => {
    for (const n of NAMES) { if (saved[n] === undefined) delete globalThis[n]; else globalThis[n] = saved[n]; }
  });

  function makeShop(t, account) {
    const weapons = new Map(Object.keys(WEAPONS).map((k) => [k, { id: k, ...WEAPONS[k] }]));
    const ctx = { account, weapons, emit() {}, listen() {}, avatarArt: null };
    const shop = createShop(ctx);
    const find = (pred) => shop.el.all(pred);
    const grid = find((k) => k.classList.contains('sk-shop-grid'))[0];
    return {
      shop,
      grid,
      onTab: () => find((k) => k.classList.contains('sk-tab') && k.classList.contains('is-on')).map((k) => k.textContent)[0],
      tab: (label) => find((k) => k.classList.contains('sk-tab') && k.textContent === label)[0],
      card: (name) => find((k) => k.attrs['aria-label'] === name && k.classList.contains('sk-shop-card'))[0],
      action: (card) => card.all((k) => k.classList.contains('sk-shop-action'))[0],
      note: () => find((k) => k.classList.contains('sk-av-closed'))[0]
    };
  }
  function offlineAccount(t, points = 3000) {
    const account = createAccount({ storage: null, target: null, config: { url: '', anonKey: '' } });
    t.after(() => account.dispose());
    // 포인트를 바로 넣는 공개 API가 없어 비밀 스팟 보상으로 채운다
    for (let i = 0; account.profile.points < points; i++) account.findSecret('qa', { id: 's' + i, name: 'x', points: 1000 });
    return account;
  }

  test('show의 tab은 열 때만 따른다: 계정이 바뀌어 update해도 보던 탭·스크롤이 그대로다', (t) => {
    const account = offlineAccount(t);
    const s = makeShop(t, account);
    s.shop.show({ tab: 'avatar' });               // 마이페이지 → 캐릭터 상점
    assert.equal(s.onTab(), '캐릭터');
    s.tab('권총').fire('click');
    assert.equal(s.onTab(), '권총');
    s.grid.scrollTop = 500;
    const rebuilt = s.grid.replaced;
    assert.ok(account.buy('pt_magnum').ok);
    s.shop.update();                              // ui.refreshAccount()가 하는 일
    assert.equal(s.onTab(), '권총', '캐릭터 탭으로 되돌아가지 않는다');
    assert.equal(s.grid.scrollTop, 500, '스크롤도 그대로');
    assert.equal(s.grid.replaced, rebuilt, '카드를 다시 붙이지 않는다');
    s.shop.show({ tab: null });                   // 메뉴에서 다시 열기
    assert.equal(s.onTab(), '권총', 'tab이 없으면 보던 탭');
    s.shop.show({ tab: 'avatar' });
    assert.equal(s.onTab(), '캐릭터', '새로 열 때 tab을 주면 그 탭');
  });

  test('캐릭터 탭에서 사고 입어도 누른 버튼이 그대로 붙어 있다(포커스 유지)', (t) => {
    const account = offlineAccount(t);
    const s = makeShop(t, account);
    s.shop.show({ tab: 'avatar' });
    const scout = AVATARS.find((a) => a.id === 'av_scout');
    const card = s.card(scout.name);
    const btn = s.action(card);
    const rebuilt = s.grid.replaced;
    assert.equal(btn.textContent, `구매 ${scout.price} P`);
    btn.fire('click');
    s.shop.update();
    assert.equal(account.isOwned('av_scout'), true);
    assert.equal(btn.textContent, '장착');
    btn.fire('click');
    s.shop.update();
    assert.equal(account.avatar, 'av_scout');
    assert.equal(btn.textContent, '장착 중');
    assert.equal(btn.disabled, true);
    assert.equal(s.grid.replaced, rebuilt, '카드를 다시 붙이지 않는다');
    assert.ok(s.grid.contains(btn), '누른 버튼이 화면에 남는다');
    assert.equal(s.onTab(), '캐릭터');
  });

  test('서버가 캐릭터를 모르면 캐릭터 구매 버튼이 꺼지고 안내가 보인다. 기본 캐릭터 장착은 된다', async (t) => {
    const account = createAccount({ storage: null, target: null, config: CONFIG, fetch: fakeFetch({ features: null }) });
    t.after(() => account.dispose());
    await account.ready;
    assert.equal(account.avatarShop, 'closed');
    const s = makeShop(t, account);
    s.shop.show({ tab: 'avatar' });
    assert.equal(s.note().hidden, false);
    assert.match(s.note().textContent, /서버 업데이트 뒤에 열려요/);
    for (const a of AVATARS) {
      const btn = s.action(s.card(a.name));
      if (a.id === DEFAULT_AVATAR) assert.equal(btn.textContent, '장착 중');
      else {
        assert.equal(btn.textContent, '구매 준비 중', a.name);
        assert.equal(btn.disabled, true, a.name);
      }
    }
    const points = account.profile.points;
    s.action(s.card(AVATARS[1].name)).fire('click');   // 꺼진 버튼을 눌러도(대역은 막지 않는다) 계정이 막는다
    assert.equal(account.profile.points, points);
    assert.equal(account.isOwned(AVATARS[1].id), false);
  });

  test('서버가 캐릭터를 알면 구매 버튼이 켜지고 안내가 없다', async (t) => {
    const account = createAccount({ storage: null, target: null, config: CONFIG, fetch: fakeFetch() });
    t.after(() => account.dispose());
    await account.ready;
    assert.equal(account.avatarShop, 'open');
    const s = makeShop(t, account);
    s.shop.show({ tab: 'avatar' });
    assert.equal(s.note().hidden, true);
    const scout = AVATARS.find((a) => a.id === 'av_scout');
    const btn = s.action(s.card(scout.name));
    assert.equal(btn.textContent, `구매 ${scout.price} P`);
    assert.equal(btn.disabled, false, '시작 포인트 500으로 정찰병을 살 수 있다');
  });
});
