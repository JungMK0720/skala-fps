/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 시나리오 27. 건의함을 실제 화면으로 검사한다. 가짜 Supabase에 닉네임을 등록한 뒤 메인 메뉴의 건의하기 시트에서
 *          종류를 고르고 글을 보내면 서버에 정리된 글·진단 정보가 들어가는지, 같은 글은 거절되는지, 운영자가 답을 달면 다음 접속에
 *          메뉴 버튼에 새 답 표시가 뜨고 시트를 열면 꺼지는지, 경기 중 일시정지에서 보내면 모드·맵이 함께 가고 친 글자가 게임 조작으로
 *          새지 않는지, 건의함 함수가 없는 서버에서는 쓰기 전에 막는지, 휴대폰 폭에서 시트가 화면 안에 들어가는지 본다.
 */
import { startFakeSupabase } from '../fake-supabase.mjs';
import { LOW_QUALITY, lockPointer, qaInit, readyGame, richProfile, sleep, startPractice, waitLive, waitRun } from '../kit.mjs';

const SIZE = { width: 960, height: 540 };
const NICK = '건의왕';

/** 페이지에서: 건의하기 시트의 상태 */
function sheetState() {
  const el = document.querySelector('.sk-feedback');
  if (!el || !el.isConnected) return null;
  const vis = (n) => !!n && !n.hidden && n.getBoundingClientRect().height > 0;
  const on = el.querySelector('.sk-fb-kinds .is-on');
  const send = el.querySelector('.sk-fb-send');
  const r = el.getBoundingClientRect();
  return {
    kind: on ? on.dataset.kind : null,
    sendOff: send.disabled,
    status: el.querySelector('.sk-fb-status').textContent,
    tone: el.querySelector('.sk-fb-status').dataset.tone || '',
    gate: vis(el.querySelector('.sk-fb-gate')) ? el.querySelector('.sk-fb-gate').textContent : '',
    count: el.querySelector('.sk-fb-count').textContent,
    text: el.querySelector('.sk-fb-text').value,
    items: [...el.querySelectorAll('.sk-fb-item')].map((li) => ({
      kind: li.querySelector('.sk-chip').textContent,
      status: li.querySelector('.sk-fb-st').textContent,
      body: li.querySelector('.sk-fb-body').textContent,
      reply: li.querySelector('.sk-fb-reply-text') ? li.querySelector('.sk-fb-reply-text').textContent : null
    })),
    listNote: el.querySelector('.sk-fb-list-note').textContent,
    listShown: vis(el.querySelector('.sk-fb-mine')),
    // 새 답 강조와 시트 안에서 보이는지
    newItem: (() => {
      const n = el.querySelector('.sk-fb-item.is-new');
      if (!n) return null;
      const b = el.querySelector('.sk-sheet-body').getBoundingClientRect(), ir = n.getBoundingClientRect();
      return { visible: ir.top >= b.top - 1 && ir.top < b.bottom - 10, top: Math.round(ir.top), body: [Math.round(b.top), Math.round(b.bottom)] };
    })(),
    rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
    fits: r.left >= 0 && r.right <= innerWidth + 0.5 && r.top >= 0 && r.bottom <= innerHeight + 0.5,
    noHScroll: document.documentElement.scrollWidth <= innerWidth + 1
  };
}

/** 페이지에서: 건의 글 칸에 글을 넣는다(input 이벤트로 글자 수와 버튼을 다시 그린다) */
function fillText(text) {
  const a = document.querySelector('.sk-feedback .sk-fb-text');
  a.focus();
  a.value = text;
  a.dispatchEvent(new Event('input', { bubbles: true }));
}

const menuFeedbackBtn = `[...document.querySelectorAll('.sk-menu-btn')].find((b) => /건의하기/.test(b.textContent))`;

async function waitNode(cond, timeoutMs, label) {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`시간 초과: ${label}`);
    await sleep(100);
  }
}

export default {
  name: 'feedback',
  title: '건의함: 메뉴·일시정지에서 보내기 · 중복 거절 · 운영자 답 표시 · 닫힌 서버 · 휴대폰 폭',
  timeoutMs: 6 * 60 * 1000,
  async run(t) {
    const fake = await startFakeSupabase({});
    t.server.setConfig(fake.config);
    let closedFake = null;
    try {
      /* ---------- 메뉴: 시트 열기 ---------- */
      t.setSection('메뉴에서 건의하기 시트');
      const page = await t.newPage();
      const init = qaInit({ profile: richProfile({ nickname: NICK }), settings: LOW_QUALITY });
      await page.open(`${t.base}?debug=1`, { ...SIZE, clean: true, initScript: init });
      await readyGame(page, { screen: 'menu' });
      await waitNode(() => [...fake.players.values()].some((p) => p.name === NICK), 15000, '닉네임 등록');
      await page.waitFor('__qa.ctx.account.feedbackBox === "open"', 10000, { label: '건의함 열림(fps_features)' });
      t.check(await page.eval(`!!(${menuFeedbackBtn})`), '메인 메뉴에 건의하기 버튼이 있다');
      await page.clickText('.sk-menu-btn', '건의하기');
      await page.waitFor(`!!document.querySelector('.sk-menu .sk-modal:not([hidden]) .sk-feedback')`, 3000, { label: '건의 시트' });
      await page.waitFor(`document.querySelector('.sk-feedback .sk-fb-list-note').textContent !== '불러오는 중…'`, 5000, { label: '내 건의 목록' });
      let st = await page.fn(sheetState);
      t.check(st.kind === 'idea' && st.sendOff && !st.gate, '처음 종류는 제안, 글이 없으면 보내기가 꺼져 있다', st);
      t.check(st.listShown && /아직 보낸 건의가 없어요/.test(st.listNote), '보낸 건의가 없다고 알려 준다', st.listNote);
      t.check(await page.eval(`document.activeElement === document.querySelector('.sk-feedback .sk-fb-text')`), '글 칸에 바로 쓸 수 있다(포커스)');

      await page.fn(fillText, '짧음');
      st = await page.fn(sheetState);
      t.check(st.sendOff && st.count === `2 / 1000`, '5자 미만이면 보내기가 꺼져 있고 글자 수를 센다', st);

      /* ---------- 보내기 ---------- */
      t.setSection('보내기');
      await page.clickText('.sk-feedback .sk-seg-btn', '버그');
      const BODY = '중계 기지 B 구역 계단을 오르면   \n\n\n\n벽에 끼어요';
      await page.fn(fillText, BODY);
      st = await page.fn(sheetState);
      t.check(st.kind === 'bug' && !st.sendOff, '종류를 버그로 바꾸고 보낼 수 있다', st);
      await t.shot('sheet-filled');
      await page.click('.sk-feedback .sk-fb-send');
      await page.waitFor(`document.querySelector('.sk-feedback .sk-fb-status').dataset.tone === 'good'`, 8000, { label: '보냄' });
      st = await page.fn(sheetState);
      t.check(/보냈어요/.test(st.status) && st.text === '', '보냈다고 알리고 글 칸을 비운다', st);
      t.check(fake.feedback.length === 1, '서버에 한 건이 들어간다', fake.feedback.length);
      const sent = fake.feedback[0] || {};
      t.check(sent.kind === 'bug' && sent.body === '중계 기지 B 구역 계단을 오르면\n\n벽에 끼어요', '정리한 본문(줄 끝 공백·긴 빈 줄)과 종류가 간다', sent.body);
      t.check(sent.info && sent.info.where === 'menu' && sent.info.ver && /^\d+x\d+$/.test(sent.info.scr) && sent.info.touch === false && /\S/.test(sent.info.br), '진단 정보: 연 곳·버전·화면 크기·터치·브라우저', sent.info);
      t.check(!('mode' in (sent.info || {})) && !('map' in (sent.info || {})), '메뉴에서 보내면 모드·맵은 없다', sent.info);
      await page.waitFor(`document.querySelectorAll('.sk-feedback .sk-fb-item').length === 1`, 5000, { label: '목록에 한 건' });
      st = await page.fn(sheetState);
      t.check(st.items.length === 1 && st.items[0].kind === '버그' && st.items[0].status === '접수' && st.items[0].reply === null, '내가 보낸 건의가 목록에 접수로 보인다', st.items);
      t.check(await page.eval(`JSON.parse(localStorage.getItem('skalafps.feedback.v1') || '{}').sent === true`), '이 기기에서 보낸 적이 있다고 적어 둔다');

      /* ---------- 같은 글 ---------- */
      t.setSection('같은 글은 거절');
      await page.fn(fillText, BODY);
      await page.click('.sk-feedback .sk-fb-send');
      await page.waitFor(`document.querySelector('.sk-feedback .sk-fb-status').dataset.tone === 'bad'`, 8000, { label: '거절' });
      st = await page.fn(sheetState);
      t.check(/이미 보냈어요/.test(st.status) && st.text.length > 0 && fake.feedback.length === 1, '같은 내용은 거절하고 쓴 글은 남긴다', st);
      await page.press('Escape');
      await page.waitFor(`!document.querySelector('.sk-menu .sk-modal:not([hidden])')`, 3000, { label: 'Esc로 닫힘' });
      t.check(await page.eval('__qa.ui.isVisible("menu")'), 'Esc로 시트만 닫히고 메뉴는 그대로');
      t.errorsOk('메뉴 건의');

      /* ---------- 운영자 답 → 다음 접속에 새 답 표시 ---------- */
      t.setSection('운영자 답');
      t.check(fake.reply(1, '알려 줘서 고마워요. 다음 배포에서 고칠게요!'), '운영자가 답을 단다(가짜 서버)');
      await page.open(`${t.base}?debug=1`, { ...SIZE, clean: false, initScript: init });
      await readyGame(page, { screen: 'menu' });
      await page.waitFor(`(${menuFeedbackBtn}).classList.contains('has-new')`, 10000, { label: '새 답 표시' });
      const sub = await page.eval(`(${menuFeedbackBtn}).querySelector('.sk-menu-sub').textContent`);
      t.check(/새 답/.test(sub), '메뉴 버튼에 새 답이 있다고 보인다', sub);
      await t.shot('menu-new-reply');
      await page.clickText('.sk-menu-btn', '건의하기');
      await page.waitFor(`!!document.querySelector('.sk-feedback .sk-fb-reply-text')`, 5000, { label: '답 보임' });
      st = await page.fn(sheetState);
      t.check(st.items[0] && st.items[0].reply === '알려 줘서 고마워요. 다음 배포에서 고칠게요!' && st.items[0].status === '확인함', '시트에 운영자 답과 상태(확인함)가 보인다', st.items);
      t.check(st.newItem && st.newItem.visible, '새 답을 강조하고 글 칸 아래에 있어도 보이게 굴린다', st.newItem);
      t.check(!(await page.eval(`(${menuFeedbackBtn}).classList.contains('has-new')`)), '답을 보면 새 답 표시가 꺼진다');
      await t.shot('sheet-reply');
      await page.press('Escape');
      await sleep(150);

      /* ---------- 일시정지에서 ---------- */
      t.setSection('경기 중 일시정지에서');
      await startPractice(page);
      await waitRun(page);
      await waitLive(page);
      await lockPointer(page);
      await page.eval('document.exitPointerLock()');
      await page.waitFor('__qa.ui.isVisible("pause")', 3000, { label: '일시정지' });
      await page.clickText('.sk-pause-btns .sk-btn', '건의하기');
      await page.waitFor(`!!document.querySelector('.sk-pause .sk-modal:not([hidden]) .sk-feedback')`, 3000, { label: '일시정지 건의 시트' });
      await page.clickText('.sk-pause .sk-feedback .sk-seg-btn', '밸런스');
      await page.click('.sk-pause .sk-feedback .sk-fb-text');
      // 게임 조작 글자(b 이모트, r 재장전, Enter 채팅)를 쳐도 글 칸에만 들어간다
      for (const [code, ch] of [['KeyB', 'b'], ['KeyR', 'r'], ['KeyG', 'g'], ['Space', ' '], ['Digit1', '1']]) await page.press(code, { text: ch });
      await page.type(' 저격총 한 방이 너무 세요');
      await page.press('Enter', { text: '\r' });
      await page.type('다리는 두 방이면 좋겠어요');
      st = await page.fn(sheetState);
      t.check(st.text.startsWith('brg 1 저격총') && st.text.includes('\n다리는'), '친 글자가 글 칸에 들어간다(Enter는 줄바꿈)', st.text);
      t.check(!(await page.eval('__qa.ui.isVisible("emotes")')) && (await page.eval('__qa.ui.isVisible("pause")')), '글을 쳐도 이모트 휠·게임 조작이 열리지 않는다');
      await page.click('.sk-pause .sk-feedback .sk-fb-send');
      await page.waitFor(`document.querySelector('.sk-pause .sk-feedback .sk-fb-status').dataset.tone === 'good'`, 8000, { label: '일시정지에서 보냄' });
      const second = fake.feedback[1] || {};
      t.check(second.kind === 'balance' && second.info && second.info.where === 'pause' && typeof second.info.mode === 'string' && typeof second.info.map === 'string', '일시정지에서 보내면 연 곳·모드·맵이 함께 간다', second.info);
      await t.shot('pause-sheet');
      await page.press('Escape');
      await page.waitFor(`!document.querySelector('.sk-pause .sk-modal:not([hidden])')`, 3000, { label: '시트 닫힘' });
      t.check(await page.eval('__qa.ui.isVisible("pause")'), 'Esc는 시트만 닫고 일시정지 메뉴는 남는다');
      t.errorsOk('일시정지 건의');

      /* ---------- 휴대폰 폭 ---------- */
      t.setSection('휴대폰 폭');
      const phone = await t.newPage();
      await phone.open(`${t.base}?debug=1`, { width: 375, height: 740, clean: true, mobile: true, initScript: qaInit({ profile: richProfile({ nickname: '폰건의' }), settings: LOW_QUALITY }) });
      await readyGame(phone, { screen: 'menu' });
      await phone.waitFor('__qa.ctx.account.feedbackBox === "open"', 10000, { label: '건의함 열림' });
      await phone.clickText('.sk-menu-btn', '건의하기');
      await phone.waitFor(`!!document.querySelector('.sk-feedback')`, 3000, { label: '폰 시트' });
      await sleep(200);
      const ps = await phone.fn(sheetState);
      t.check(ps.fits && ps.noHScroll, '시트가 화면 안에 들어가고 가로 스크롤이 없다', ps.rect);
      await t.shot('phone-sheet');
      t.errorsOk('휴대폰 폭');

      /* ---------- 건의함이 없는 서버 ---------- */
      t.setSection('건의함 함수가 없는 서버');
      closedFake = await startFakeSupabase({ feedback: false });
      t.server.setConfig(closedFake.config);
      const old = await t.newPage();
      await old.open(`${t.base}?debug=1`, { ...SIZE, clean: true, initScript: qaInit({ profile: richProfile({ nickname: '옛서버' }), settings: LOW_QUALITY }) });
      await readyGame(old, { screen: 'menu' });
      await old.waitFor('__qa.ctx.account.feedbackBox === "closed"', 10000, { label: '건의함 닫힘' });
      await old.clickText('.sk-menu-btn', '건의하기');
      await old.waitFor(`!!document.querySelector('.sk-feedback')`, 3000, { label: '시트' });
      await old.fn(fillText, '닫힌 서버에서 쓰는 글이에요');
      const os = await old.fn(sheetState);
      t.check(/아직 열리지 않았어요/.test(os.gate) && os.sendOff && !os.listShown, '쓰기 전에 아직 열리지 않았다고 알리고 보내기를 막는다', os);
      t.check(!closedFake.stats.rpc.fps_send_feedback && !closedFake.stats.rpc.fps_my_feedback, '없는 함수를 부르지 않는다', closedFake.stats.rpc);
      await t.shot('closed-sheet');
      t.errorsOk('닫힌 서버');
    } finally {
      t.server.setConfig(null);
      await fake.close();
      if (closedFake) await closedFake.close();
    }
  }
};
