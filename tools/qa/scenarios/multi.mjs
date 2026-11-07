/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 시나리오 9. 멀티플레이 진입을 검사한다. 설정이 비어 있으면 친절한 비활성 상태여야 하고, 서버 주소가 있어도 닿지 않으면 예외 없이 메뉴로 돌아올 수 있어야 한다.
 *          실서버 멀티 대전은 Supabase 프로젝트가 필요해 자동화하지 않았다.
 */
import { createServer } from 'node:net';
import { LOW_QUALITY, NICK, openGame, sleep } from '../kit.mjs';

/** 지금 비어 있고 곧 닫히는 포트. 여기로 보낸 연결은 거절된다 */
function closedPort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
  });
}

export default {
  name: 'multi',
  title: '빈 설정의 멀티 비활성 상태, 닿지 않는 서버',
  timeoutMs: 180000,
  async run(t) {
    t.setSection('빈 설정');
    let page = await openGame(t, '', { profile: { nickname: NICK, createdAt: 1 }, settings: LOW_QUALITY, screen: 'menu' });
    await page.waitFor('__qa.ui.isVisible("menu")', 5000, { label: '메뉴' });
    const multi = await page.eval(`(() => {
      const b = [...document.querySelectorAll('.sk-menu-btn--wide')].find((x) => /멀티플레이/.test(x.textContent));
      return { disabled: b.disabled, locked: b.classList.contains('is-locked'), sub: b.querySelector('.sk-menu-sub').textContent, note: document.querySelector('.sk-menu-note').textContent, noteHidden: document.querySelector('.sk-menu-note').hidden, remote: __qa.ctx.account.remoteEnabled };
    })()`);
    t.check(!multi.remote, '계정은 오프라인이다', multi);
    t.check(multi.disabled && multi.locked, '멀티 버튼이 꺼지고 자물쇠로 바뀐다', multi);
    t.check(multi.sub === '지금은 쓸 수 없어요', '버튼 안내', multi);
    t.check(!multi.noteHidden && /온라인 서버가 설정되지 않아/.test(multi.note), '이유를 설명한다', multi);
    await t.shot('multi-disabled');
    await page.clickText('.sk-menu-btn--wide', '멀티플레이');
    await sleep(300);
    t.check(await page.eval('__qa.ctx.screen === "menu" && __qa.ui.isVisible("menu")'), '꺼진 버튼을 눌러도 메뉴에 남는다');
    t.check(await page.eval('!window.__skalafpsSession'), '멀티 세션을 만들지 않는다');
    t.check(page.requests.every((r) => !/supabase|\/rest\/|\/realtime\//.test(r.url)), '서버로 요청을 보내지 않는다');
    t.errorsOk('빈 설정');

    t.setSection('키보드로도 넘어가지 않는다');
    const r = await page.eval(`(() => { const b = [...document.querySelectorAll('.sk-menu-btn--wide')].find((x) => /멀티플레이/.test(x.textContent)); b.focus(); return document.activeElement === b; })()`);
    t.check(!r, '꺼진 버튼은 포커스를 받지 않는다');
    t.errorsOk('키보드');

    t.setSection('닿지 않는 서버');
    // 쓸 수 없는 주소를 넣어 네트워크 실패 경로를 탄다. 접속 실패는 여기서 의도한 것이다
    const port = await closedPort();
    t.server.setConfig(`window.SKALA_CONFIG = { supabase: { url: 'http://127.0.0.1:${port}', anonKey: 'qa-test-key' } };`);
    try {
      page = await openGame(t, '', { profile: { nickname: NICK, createdAt: 1 }, settings: LOW_QUALITY, screen: 'menu' });
      await page.waitFor('__qa.ui.isVisible("menu")', 5000, { label: '메뉴' });
      t.check(await page.eval('__qa.ctx.account.remoteEnabled'), '설정을 읽어 온라인을 시도한다');
      t.check(!(await page.eval(`[...document.querySelectorAll('.sk-menu-btn--wide')].find((x) => /멀티플레이/.test(x.textContent)).disabled`)), '멀티 버튼이 켜진다');
      await page.clickText('.sk-menu-btn--wide', '멀티플레이');
      await page.waitFor('__qa.ctx.screen === "lobby" && __qa.ui.isVisible("lobby")', 10000, { label: '로비' });
      t.check(/불러오는 중/.test(await page.eval(`__qa.text('.sk-lobby')`)), '연결하는 동안 불러오는 중이라고 한다');
      // 연결 시간 제한(15초)이 지나면 이유와 다시 시도 버튼을 보여 준다
      await page.waitFor(`!!document.querySelector('.sk-lobby .sk-alert--bad')`, 25000, { intervalMs: 200, label: '연결 실패 안내' });
      const message = await page.eval(`__qa.text('.sk-lobby .sk-alert--bad')`);
      t.check(/다시 시도/.test(message), '다시 시도 버튼이 있다', message);
      t.log(`   연결 실패 문구: ${message}`);
      await t.shot('multi-unreachable');
      await page.click('.sk-lobby .sk-alert--bad .sk-btn');
      await page.waitFor(`!document.querySelector('.sk-lobby .sk-alert--bad') || /불러오는 중/.test(__qa.text('.sk-lobby'))`, 3000, { label: '다시 시도' });
      await page.click('.sk-lobby .sk-bar .sk-btn--ghost');
      await page.waitFor('__qa.ui.isVisible("menu") && __qa.ctx.screen === "menu"', 8000, { label: '메뉴로 돌아옴' });
      await page.click('.sk-menu-btn--main');
      await page.waitFor('__qa.ctx.screen === "sandbox" && !!__qa.run', 30000, { label: '연습장은 그대로 된다' });
      t.errorsOk('닿지 않는 서버', { allow: [/127\.0\.0\.1:9\b/, /ERR_CONNECTION/, /ERR_UNSAFE_PORT/, /WebSocket/] });
    } finally {
      t.server.setConfig(null);
    }
    t.note('실서버 멀티 대전과 supabase/schema.sql 실행은 Supabase 프로젝트가 필요해 자동화하지 못했다');
  }
};
