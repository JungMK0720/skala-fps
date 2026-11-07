/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 시나리오 1. 첫 실행 닉네임 게이트를 검사한다. 닫을 수 없음, 잘못된 이름 거절, 오프라인 안내, 저장과 새로고침 유지, ?sandbox=·?autoplay=의 게이트 건너뛰기.
 */
import { qaInit, sleep } from '../kit.mjs';

const GATE = '.sk-nick';
const INPUT = '#sk-gate-nick';
const STATUS = '#sk-gate-nick-status';
const SUBMIT = '.sk-nick-submit';

async function setName(page, text) {
  await page.fn((sel) => { const el = document.querySelector(sel); el.focus(); el.select(); }, INPUT);
  if (text) await page.type(text);
  else await page.press('Backspace');
}

/** 입력 뒤 0.4초 디바운스가 지나 이 상태 클래스가 될 때까지 */
async function waitStatus(page, cls) {
  await page.waitFor(`document.querySelector(${JSON.stringify(STATUS)}).classList.contains(${JSON.stringify(cls)})`, 5000, { label: `상태 ${cls}` });
  return page.eval(`document.querySelector(${JSON.stringify(STATUS)}).textContent`);
}

const gateVisible = (page) => page.fn((sel) => { const el = document.querySelector(sel); return !!el && !el.hidden && el.getBoundingClientRect().height > 0; }, GATE);

export default {
  name: 'first-run',
  title: '닉네임 게이트, 잘못된 이름, 오프라인 안내, 새로고침, 게이트 건너뛰기',
  timeoutMs: 180000,
  async run(t) {
    const page = await t.newPage();
    t.setSection('깨끗한 저장소');
    await page.open(t.base, { clean: true, initScript: qaInit() });
    await page.waitFor(`!!document.querySelector(${JSON.stringify(GATE)}) && !document.querySelector(${JSON.stringify(GATE)}).hidden`, 30000, { label: '닉네임 게이트' });
    t.check(await gateVisible(page), '플래그 없는 첫 실행에서 게이트가 보인다');
    t.check(await page.eval(`document.activeElement && document.activeElement.id === 'sk-gate-nick'`), '입력칸에 포커스가 있다');
    await t.shot('gate');

    t.setSection('게이트는 닫을 수 없다');
    await page.press('Escape');
    await sleep(100);
    t.check(await gateVisible(page), 'Esc로 닫히지 않는다');
    await page.mouseClick(5, 5);
    await sleep(100);
    t.check(await gateVisible(page), '배경을 눌러도 닫히지 않는다');
    t.check(await page.eval(`document.activeElement && document.activeElement.id === 'sk-gate-nick'`), '배경을 눌러도 입력칸 포커스가 남는다');
    t.check(await page.fn((sel) => {
      const gate = document.querySelector(sel);
      return [...gate.parentElement.children].filter((c) => c !== gate).every((c) => c.inert);
    }, GATE), '뒤 화면은 inert라 Tab과 클릭이 닿지 않는다');
    const behind = await page.eval(`(() => { const m = document.querySelector('.sk-menu'); return { hidden: m ? m.hidden : true }; })()`);
    t.check(!behind.hidden, '메뉴는 게이트 뒤에 떠 있다');
    await page.press('Tab');
    await page.press('Tab');
    await page.press('Tab');
    t.check(await page.fn((sel) => document.querySelector(sel).contains(document.activeElement), GATE), 'Tab을 눌러도 포커스가 게이트 밖으로 나가지 않는다', await page.eval('document.activeElement && document.activeElement.tagName + "." + document.activeElement.className'));

    t.setSection('잘못된 이름');
    const bad = [
      ['a', /2~12자/], ['!!!!', /한글, 영문, 숫자/], ['ab@cd', /한글, 영문, 숫자/], ['admin', /쓸 수 없어요/],
      ['관리자', /쓸 수 없어요/], ['SYSTEM', /쓸 수 없어요/], ['철수 봇', /봇/]
    ];
    for (const [name, re] of bad) {
      await setName(page, name);
      const message = await waitStatus(page, 'is-bad');
      t.check(re.test(message), `'${name}' 거절 문구`, message);
      t.check(await page.eval(`document.querySelector(${JSON.stringify(SUBMIT)}).disabled`), `'${name}'이면 시작 버튼이 꺼진다`);
      await page.press('Enter', { text: '\r' });
      await sleep(50);
      t.check(await gateVisible(page), `'${name}'에서 Enter를 눌러도 지나가지 못한다`);
    }
    await setName(page, 'ㅁㅁㅁㅁㅁㅁㅁㅁㅁㅁㅁㅁㅁㅁㅁ');
    t.check((await page.eval(`document.querySelector(${JSON.stringify(INPUT)}).value.length`)) <= 12, '12자를 넘게 칠 수 없다');
    await setName(page, '');
    await sleep(500);
    t.check(await page.eval(`document.querySelector(${JSON.stringify(SUBMIT)}).disabled`), '비어 있으면 시작 버튼이 꺼진다');
    t.check(await gateVisible(page), '여전히 게이트가 떠 있다');
    await t.shot('bad-name');

    t.setSection('오프라인 안내');
    await setName(page, 'QA 테스터');
    const offline = await waitStatus(page, 'is-warn');
    t.check(/오프라인이라 중복 확인을 못 했어요/.test(offline), '오프라인 안내가 보인다', offline);
    t.check(!(await page.eval(`document.querySelector(${JSON.stringify(SUBMIT)}).disabled`)), '시작 버튼이 켜진다');
    await t.shot('offline-note');

    t.setSection('저장과 새로고침');
    await page.click(SUBMIT);
    await page.waitFor(`document.querySelector(${JSON.stringify(GATE)}).hidden`, 5000, { label: '게이트 닫힘' });
    t.check(await page.eval(`!document.querySelector('.sk-menu').hidden`), '메뉴로 돌아온다');
    t.check((await page.eval(`document.querySelector('.sk-name-text').textContent`)) === 'QA 테스터', '메뉴 카드에 닉네임이 보인다');
    const saved = await page.eval(`JSON.parse(localStorage.getItem('skalafps.profile.v1')).profile`);
    t.check(saved && saved.nickname === 'QA 테스터', '프로필에 저장된다', saved);
    t.check(saved && saved.points === 500, '시작 포인트는 500이다', saved && saved.points);
    await t.shot('menu');
    await page.reload();
    await page.waitFor(`!!document.querySelector('.sk-menu') && !document.querySelector('.sk-menu').hidden`, 30000, { label: '새로고침 뒤 메뉴' });
    await sleep(500);
    t.check(!(await gateVisible(page)), '새로고침해도 게이트가 다시 뜨지 않는다');
    t.check((await page.eval(`document.querySelector('.sk-name-text').textContent`)) === 'QA 테스터', '새로고침해도 닉네임이 그대로다');
    t.errorsOk('첫 실행');

    t.setSection('Enter로 바로 제출');
    const enter = await t.newPage();
    await enter.open(t.base, { clean: true, initScript: qaInit() });
    await enter.waitFor(`!!document.querySelector(${JSON.stringify(GATE)}) && !document.querySelector(${JSON.stringify(GATE)}).hidden`, 30000, { label: '닉네임 게이트' });
    await setName(enter, '엔터손님');
    await enter.press('Enter', { text: '\r' });   // 0.4초 검사를 기다리지 않고 누른다
    await enter.waitFor(`document.querySelector(${JSON.stringify(GATE)}).hidden`, 5000, { label: '검사 중에 누른 Enter가 저장된다' });
    t.check((await enter.eval(`JSON.parse(localStorage.getItem('skalafps.profile.v1')).profile.nickname`)) === '엔터손님', 'Enter로 저장된다');
    t.errorsOk('Enter 제출');

    t.setSection('?sandbox=는 게이트를 미룬다');
    const sb = await t.newPage();
    await sb.open(`${t.base}?sandbox=alley&debug=1`, { clean: true, initScript: qaInit() });
    await sb.waitFor('window.__qa && __qa.ctx && __qa.ctx.screen === "sandbox" && !!__qa.run', 60000, { label: '연습장' });
    t.check(!(await gateVisible(sb)), '연습장으로 바로 들어가면 게이트가 뜨지 않는다');
    t.check(await sb.eval(`/^플레이어\\d+$/.test(__qa.ctx.session.name)`), '임시 이름을 쓴다', await sb.eval('__qa.ctx.session.name'));
    await sb.eval(`__qa.ctx.setScreen('menu')`);
    await sb.waitFor(`__qa.ctx.screen === 'menu'`, 10000, { label: '메뉴로 나감' });
    await sb.waitFor(`!document.querySelector('.sk-nick').hidden`, 5000, { label: '메뉴로 나오면 게이트' });
    t.check(await gateVisible(sb), '메뉴로 나오면 게이트가 뜬다');
    t.errorsOk('?sandbox=');

    t.setSection('?autoplay=1은 게이트를 건너뛴다');
    const auto = await t.newPage();
    await auto.open(`${t.base}?autoplay=1&debug=1`, { clean: true, initScript: qaInit() });
    await auto.waitFor(`window.__qa && __qa.ctx && __qa.ctx.screen === 'menu'`, 30000, { label: '메뉴' });
    await sleep(300);
    t.check(!(await gateVisible(auto)), 'autoplay에서는 게이트가 뜨지 않는다');
    t.errorsOk('?autoplay=1');
  }
};
