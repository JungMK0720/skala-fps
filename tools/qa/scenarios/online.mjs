/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 시나리오 28. 로그인 연결·코인(테스트 결제)을 실제 화면과 실제 페이지 이동으로 검사한다. 가짜 Supabase와 가짜 API(fake-api.mjs)를 쓴다.
 *          새 기기의 닉네임 게이트에서 구글로 불러오기(인가 화면으로 갔다가 code·state를 달고 돌아오기) → 다른 기기의 닉네임·코인이 들어오고 주소가 정리되는지,
 *          마이페이지 계정 연결 칸, 상점 코인 탭에서 충전(결제 페이지로 갔다가 #skala-pay=done으로 돌아오기) → 알림과 코인 탭·구매 내역,
 *          캐릭터를 코인으로 사기, 환불, 로그아웃하면 게이트로 돌아가는지, 새 닉네임을 만든 뒤 마이페이지에서 구글 계정을 잇는지 본다.
 */
import { startFakeSupabase } from '../fake-supabase.mjs';
import { startFakeApi } from '../fake-api.mjs';
import { LOW_QUALITY, qaInit, readyGame } from '../kit.mjs';

const SIZE = { width: 1100, height: 640 };
const OLD_TOKEN = 'c'.repeat(64);

/** 페이지에서: 로그인·코인 화면 상태 */
function onlineView() {
  const vis = (sel) => {
    const el = document.querySelector(sel);
    if (!el || el.hidden) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const text = (sel) => { const el = document.querySelector(sel); return el ? el.textContent : null; };
  const s = window.__qa && __qa.ctx && __qa.ctx.account.online.state;
  return {
    search: location.search,
    hash: location.hash,
    token: localStorage.getItem('skalafps.token'),
    nickname: __qa.ctx.account.profile.nickname,
    status: s && s.status,
    coins: s && s.coins,
    linked: s ? [...s.linked] : [],
    gate: __qa.ui.isVisible('nickname'),
    gateLogin: vis('.sk-nick-login .sk-login-btn'),
    gateNote: text('.sk-nick-loginnote'),
    toast: vis('.sk-game-toast') ? text('.sk-game-toast') : '',
    linkPanel: vis('.sk-my-link'),
    linkState: text('.sk-my-linkstate'),
    logout: vis('.sk-my-logout'),
    coinTab: vis('.sk-tab[data-tab="coins"]'),
    coinTabOn: !!document.querySelector('.sk-tab[data-tab="coins"].is-on'),
    balance: text('.sk-coin-balance'),
    coinNote: vis('.sk-coin-note') ? text('.sk-coin-note') : '',
    products: document.querySelectorAll('.sk-shop-grid .sk-coin-card').length,
    orders: [...document.querySelectorAll('.sk-coin-order')].map((o) => ({
      status: o.querySelector('.sk-coin-order-status').textContent, refund: !!o.querySelector('.sk-coin-refund')
    })),
    noHScroll: document.documentElement.scrollWidth <= innerWidth + 1
  };
}

/** 페이지에서: 게이트 닉네임 칸에 글자를 넣는다 */
function typeNick(name) {
  const input = document.querySelector('#sk-gate-nick');
  input.focus();
  input.value = name;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

export default {
  name: 'online',
  title: '로그인 연결·코인: 게이트에서 불러오기 · 계정 연결 칸 · 코인 탭 충전·환불 · 코인으로 사기 · 로그아웃 · 새 닉네임 잇기',
  timeoutMs: 5 * 60 * 1000,
  async run(t) {
    const supa = await startFakeSupabase({});
    const api = await startFakeApi({ supabase: supa });
    t.server.setConfig(`window.SKALA_CONFIG = { supabase: { url: ${JSON.stringify(supa.url)}, anonKey: 'sb_qa_fake' }, api: { url: ${JSON.stringify(api.url)} } };`);
    // 다른 기기에서 쓰던 계정: 구글에 연결된 '철수', 코인 120개
    api.seed({ token: OLD_TOKEN, name: '철수', subject: 'qa-sub-1', coins: 120 });
    const view = (page) => page.fn(onlineView);
    try {
      /* ---------- 새 기기: 게이트에서 구글로 불러오기 ---------- */
      t.setSection('게이트에서 불러오기');
      const page = await t.newPage();
      await page.open(`${t.base}?debug=1`, { ...SIZE, clean: true, initScript: qaInit({ profile: null, settings: LOW_QUALITY }) });
      await readyGame(page, { screen: 'menu' });
      await page.waitFor('__qa.ui.isVisible("nickname") && __qa.ctx.account.online.state.status === "ready"', 15000, { label: '게이트와 API 준비' });
      let v = await view(page);
      t.check(v.gate && v.gateLogin, '닉네임 게이트에 구글로 불러오기 버튼이 있다', v);
      await t.shot('gate-login');
      await page.clickText('.sk-nick-login .sk-login-btn', '구글로 불러오기');
      await page.waitFor('window.__qa && __qa.ctx && __qa.ctx.account && __qa.ctx.account.profile.nickname === "철수"', 40000, { label: '철수로 로그인' });
      await page.waitFor('__qa.ctx.account.online.state.coins === 120 && !__qa.ui.isVisible("nickname")', 15000, { label: '코인·게이트 닫힘' });
      v = await view(page);
      t.check(v.search === '?debug=1', '돌아온 주소에서 code·state·scope를 지우고 다른 쿼리는 남긴다', v.search);
      t.check(/^[0-9a-f]{64}$/.test(v.token) && v.token !== OLD_TOKEN, '이 기기는 새 토큰을 만들어 쓴다(다른 기기의 토큰을 옮기지 않는다)', v.token);
      t.check(supa.players.get(v.token) && supa.players.get(v.token).name === '철수', '서버가 새 토큰을 그 닉네임에 더했다');
      const ex = api.exchanges[0] || {};
      t.check(ex.codeVerifier && ex.codeVerifier.length === 43 && ex.redirectUri === t.base && ex.code === 'qa-code' && ex.nonce, 'code와 PKCE verifier·nonce·돌아올 주소를 서버에 넘긴다', ex);
      t.check(/불러왔어요/.test(v.toast), '불러왔다고 알린다', v.toast);
      t.check(await page.eval('__qa.ctx.account.profile.points') === 777, '다른 기기의 포인트가 들어온다');
      await t.shot('after-login');
      t.errorsOk('게이트 로그인');

      /* ---------- 마이페이지: 계정 연결 칸 ---------- */
      t.setSection('마이페이지 계정 연결 칸');
      await page.eval('__qa.ui.show("mypage")');
      await page.waitFor('!!document.querySelector(".sk-my-link:not([hidden])")', 5000, { label: '계정 연결 칸' });
      v = await view(page);
      t.check(/구글 계정과 연결됐어요/.test(v.linkState) && v.logout, '연결됐다고 보여 주고 로그아웃 버튼이 있다', v);
      t.check(v.noHScroll, '가로 스크롤이 생기지 않는다');
      await t.shot('mypage-linked');

      /* ---------- 상점: 코인 탭과 충전 ---------- */
      t.setSection('코인 탭 충전');
      await page.eval('__qa.ui.show("shop", { tab: "coins" })');
      await page.waitFor('!!document.querySelector(".sk-tab[data-tab=coins].is-on")', 5000, { label: '코인 탭' });
      v = await view(page);
      t.check(v.coinTab && v.balance === '120개' && v.products === 2 && v.orders.length === 0, '잔액·충전 상품 둘·빈 구매 내역', v);
      await t.shot('shop-coins');
      await page.eval('document.querySelector(".sk-game-toast").hidden = true');   // 로그인 알림(7초)이 아래쪽 버튼을 가리지 않게 닫는다
      await page.click('.sk-coin-card .sk-shop-action');
      await page.waitFor('window.__qa && __qa.ctx && __qa.ui && __qa.ctx.account.online.state.coins === 220 && __qa.ui.isVisible("shop")', 40000, { label: '충전 뒤 상점' });
      await page.waitFor('document.querySelectorAll(".sk-coin-order").length === 1', 8000, { label: '구매 내역 한 줄' });
      v = await view(page);
      t.check(v.hash === '' && v.search === '?debug=1', '결제 결과 해시를 주소에서 지운다', v);
      t.check(v.coinTabOn && /코인 충전을 마쳤어요/.test(v.coinNote) && v.balance === '220개', '돌아오면 코인 탭을 열고 결과를 보여 준다', v);
      t.check(v.orders[0].status === '완료' && v.orders[0].refund, '구매 내역에 완료와 환불 버튼', v.orders);
      await t.shot('shop-after-pay');
      t.errorsOk('충전');

      /* ---------- 캐릭터를 코인으로 사기 ---------- */
      t.setSection('코인으로 사기');
      await page.click('.sk-tab[data-tab="avatar"]');
      await page.waitFor('!!document.querySelector("[data-avatar=av_scout] .sk-coin-buy:not([hidden])")', 5000, { label: '코인으로 사기 버튼' });
      const label = await page.eval('document.querySelector("[data-avatar=av_scout] .sk-coin-buy").textContent');
      t.check(label === '코인 30개로 사기', '정찰병(300 P)은 코인 30개', label);
      t.check(await page.eval('!document.querySelector("[data-avatar=av_trooper] .sk-coin-buy:not([hidden])")'), '기본 캐릭터에는 코인 버튼이 없다');
      await page.click('[data-avatar="av_scout"] .sk-coin-buy');
      await page.waitFor('__qa.ctx.account.isOwned("av_scout") && __qa.ctx.account.online.state.coins === 190', 8000, { label: '코인으로 삼' });
      t.check(await page.eval('document.querySelector("[data-avatar=av_scout] .sk-coin-buy").hidden'), '산 뒤에는 코인 버튼이 사라진다');
      await t.shot('shop-coin-buy');

      /* ---------- 환불 ---------- */
      t.setSection('환불');
      await page.click('.sk-tab[data-tab="coins"]');
      await page.click('.sk-coin-refund');
      await page.waitFor('__qa.ctx.account.online.state.coins === 90', 8000, { label: '환불' });
      await page.waitFor('[...document.querySelectorAll(".sk-coin-order-status")].some((e) => e.textContent === "환불함")', 5000, { label: '환불함 표시' });
      v = await view(page);
      t.check(/환불했어요/.test(v.coinNote) && !v.orders[0].refund, '환불했다고 알리고 환불 버튼이 사라진다', v);
      t.errorsOk('코인으로 사기·환불');

      /* ---------- 로그아웃 ---------- */
      t.setSection('로그아웃');
      await page.eval('__qa.ui.show("mypage")');
      await page.click('.sk-my-logout');
      await page.clickText('.sk-mypage .sk-btn', '네, 로그아웃');
      await page.waitFor('__qa.ui.isVisible("nickname") && __qa.ctx.account.profile.nickname === ""', 10000, { label: '로그아웃 뒤 게이트' });
      v = await view(page);
      t.check(/로그아웃했어요/.test(v.gateNote) && v.gateLogin, '게이트가 로그아웃을 알리고 다시 불러올 수 있다', v);
      t.check(v.token !== OLD_TOKEN && !supa.players.has(v.token), '이 기기는 아무 닉네임에도 묶이지 않은 새 토큰이다');
      await t.shot('logout-gate');
      t.errorsOk('로그아웃');

      /* ---------- 새 닉네임을 만들고 마이페이지에서 잇기 ---------- */
      t.setSection('새 닉네임 잇기');
      api.subject = 'qa-sub-2';   // 아직 아무 닉네임에도 연결되지 않은 구글 계정
      await page.fn(typeNick, '영희');
      await page.waitFor('!document.querySelector(".sk-nick-submit").disabled', 5000, { label: '닉네임 확인' });
      await page.click('.sk-nick-submit');
      await page.waitFor('!__qa.ui.isVisible("nickname") && __qa.ctx.account.profile.nickname === "영희" && !__qa.ctx.account.nicknamePending', 10000, { label: '영희 등록' });
      await page.eval('__qa.ui.show("mypage")');
      await page.waitFor('!!document.querySelector(".sk-my-linkrow .sk-login-btn:not([disabled])")', 8000, { label: '계정 연결 버튼' });
      await page.clickText('.sk-my-linkrow .sk-login-btn', '구글 계정 연결');
      await page.waitFor('window.__qa && __qa.ctx && __qa.ui && __qa.ctx.account.online.state.linked.includes("google") && __qa.ui.isVisible("mypage")', 40000, { label: '연결 뒤 마이페이지' });
      v = await view(page);
      t.check(v.nickname === '영희' && /구글 계정과 연결됐어요/.test(v.linkState), '이 기기의 닉네임에 구글 계정을 이었다', v);
      t.check(/구글 계정을 연결했어요/.test(v.toast), '연결했다고 알린다', v.toast);
      await t.shot('mypage-linked-new');
      t.errorsOk('새 닉네임 잇기');

      /* ---------- 휴대폰 폭: 코인 탭과 계정 연결 칸이 화면 안에 들어간다 ---------- */
      t.setSection('휴대폰 폭');
      await page.open(`${t.base}?debug=1`, { width: 390, height: 844, mobile: true, clean: false, initScript: qaInit({ settings: LOW_QUALITY }) });
      await readyGame(page, { screen: 'menu' });
      await page.waitFor('__qa.ctx.account.online.state.status === "ready" && __qa.ctx.account.online.state.coins !== null', 15000, { label: 'API 준비' });
      await page.eval('__qa.ui.show("shop", { tab: "coins" })');
      await page.waitFor('!!document.querySelector(".sk-tab[data-tab=coins].is-on")', 5000, { label: '코인 탭' });
      v = await view(page);
      t.check(v.noHScroll && v.products === 2, '휴대폰 폭에서 코인 탭이 가로로 넘치지 않는다', v);
      await t.shot('phone-coins');
      await page.eval('__qa.ui.show("mypage")');
      await page.waitFor('!!document.querySelector(".sk-my-link:not([hidden])")', 5000, { label: '계정 연결 칸' });
      t.check((await view(page)).noHScroll, '휴대폰 폭에서 마이페이지가 가로로 넘치지 않는다');
      await t.shot('phone-mypage');
      t.errorsOk('휴대폰 폭');
    } finally {
      await t.closePage();
      await api.close();
      await supa.close();
    }
  }
};
