/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 시나리오 21. 라운드가 시작되기 전 대기 시간의 무기 교체를 검사한다. "N 을 눌러 무기 교체!" 안내, N으로 목록 열고 닫기,
 *          무기를 누르면 바로 바뀌고 목록이 닫히는지, 몇 번이든 다시 바꿀 수 있는지, 시작하면 안내와 N이 꺼지는지,
 *          개인전은 예전처럼 무기 선택 화면이 바로 뜨는지, 휴대폰에서는 안내를 눌러 바꾸는지 본다.
 */
import { LOW_QUALITY, lockPointer, openGame, qaInit, richProfile, sleep, waitLive, waitRun, waitTicks } from '../kit.mjs';

const state = `({
  phase: __qa.run.phase,
  list: __qa.ui.isVisible('loadout'),
  prompt: __qa.visible('.sk-swap'),
  promptText: __qa.text('.sk-swap'),
  held: __qa.arsenal.getWeapon().id,
  primary: __qa.arsenal.getLoadout().primary,
  locked: __qa.ctx.input.locked,
  pause: __qa.ui.isVisible('pause'),
  frozen: Math.hypot(__qa.ctx.player.state.vel[0], __qa.ctx.player.state.vel[2]) < 0.01
})`;

export default {
  name: 'swap',
  title: '라운드 시작 전 대기: N 키 무기 교체',
  timeoutMs: 5 * 60 * 1000,
  async run(t) {
    t.setSection('대기 시간: 안내와 N 키');
    // 대기 시간을 20초로 늘려 차근차근 본다(&loadout=20은 시험용)
    let page = await openGame(t, 'sandbox=alley&ruleset=classic&mode=team&bots=1&loadout=20', { profile: richProfile(), settings: LOW_QUALITY, width: 960, height: 540, screen: 'sandbox' });
    await waitRun(page);
    await page.eval('__qa.freezeBots()');
    await page.waitFor('__qa.run.phase === "loadout" && __qa.world.localAlive', 15000, { label: '대기 단계' });
    await waitTicks(page, 5);
    let s = await page.eval(state);
    t.check(!s.list, '라운드가 시작될 때 무기 선택 화면이 저절로 뜨지 않는다', s);
    t.check(s.prompt && /을 눌러 무기 교체!/.test(s.promptText), '"N 을 눌러 무기 교체!" 안내가 뜬다', s);
    t.check(/지금 .+ · \d+초 뒤 시작/.test(s.promptText), '지금 든 무기와 남은 시간을 보여 준다', s.promptText);
    const first = s.held;
    await lockPointer(page);
    await waitTicks(page, 3);
    await t.shot('prompt');

    // N → 목록
    await page.press('KeyN');
    await page.waitFor('__qa.ui.isVisible("loadout")', 3000, { label: '무기 목록' });
    await waitTicks(page, 3);
    s = await page.eval(state);
    t.check(!s.locked && !s.pause, '목록이 열리면 커서가 풀리고 일시정지 메뉴는 뜨지 않는다', s);
    t.check(!s.prompt, '목록이 열린 동안에는 안내를 감춘다', s);
    const sheet = await page.eval(`({
      title: __qa.text('.sk-lo-title'), sub: __qa.text('.sk-lo-sub'), foot: __qa.text('.sk-lo-foot'),
      cards: [...document.querySelectorAll('.sk-lo-card')].map((c) => c.getAttribute('title')),
      selected: (document.querySelector('.sk-lo-card.is-sel') || { getAttribute: () => null }).getAttribute('title'),
      count: __qa.text('.sk-lo-count')
    })`);
    t.check(/무기 교체/.test(sheet.title), '제목이 무기 교체다', sheet);
    t.check(/바로 바뀌어요/.test(sheet.sub) && /N 또는 Esc/.test(sheet.sub), '누르면 바로 바뀐다는 안내와 닫는 키', sheet);
    t.check(/몇 번이든/.test(sheet.foot), '라운드 전까지 다시 바꿀 수 있다고 알린다', sheet);
    t.check(sheet.cards.length >= 4, '가진 주무기가 모두 나온다', sheet.cards);
    await t.shot('list');

    // 무기를 누르면 바로 바뀌고 닫힌다
    t.setSection('무기를 누르면 바로 교체');
    const target = sheet.cards.find((c) => c !== sheet.selected);
    await page.clickText('.sk-lo-card .sk-lo-name', target);
    await page.waitFor('!__qa.ui.isVisible("loadout")', 3000, { label: '목록 닫힘' });
    await waitTicks(page, 20);
    s = await page.eval(state);
    const picked = s.primary;
    t.check(picked !== first, '누른 무기로 바뀐다', { first, picked, target });
    t.check(s.held === picked, '손에 든 무기도 바로 바뀐다', s);
    t.check(s.locked, '고른 클릭으로 포인터가 다시 잠긴다', s);
    t.check(s.prompt && s.phase === 'loadout', '창이 닫히고 안내가 다시 보인다(아직 대기 중)', s);
    const sent = await page.eval(`__qa.run.match.state.players.find((p) => p.id === __qa.world.localId).loadout`);
    t.check(sent === picked, '경기에도 바뀐 무기가 들어간다', { sent, picked });

    // 다시 열어 숫자키로 고른다
    await page.press('KeyN');
    await page.waitFor('__qa.ui.isVisible("loadout")', 3000, { label: '무기 목록 다시' });
    t.check((await page.eval(`(document.querySelector('.sk-lo-card.is-sel') || { getAttribute: () => null }).getAttribute('title')`)) === target, '방금 고른 무기가 선택돼 있다');
    // 지금 고른 것이 아닌 칸의 숫자키
    const digit = sheet.cards.findIndex((c) => c !== target) + 1;
    await page.press(`Digit${digit}`);
    await page.waitFor('!__qa.ui.isVisible("loadout")', 3000, { label: '숫자키로 고르고 닫힘' });
    await waitTicks(page, 20);
    s = await page.eval(state);
    t.check(s.primary !== picked && s.held === s.primary, '숫자키로도 바로 바뀐다', s);
    t.check(s.locked, '숫자키 입력으로 포인터가 다시 잠긴다', s);
    const second = s.primary;

    // N으로 고르지 않고 닫는다
    t.setSection('고르지 않고 닫기');
    await page.press('KeyN');
    await page.waitFor('__qa.ui.isVisible("loadout")', 3000, { label: '무기 목록' });
    await page.press('KeyN');
    await page.waitFor('!__qa.ui.isVisible("loadout")', 3000, { label: 'N으로 닫힘' });
    await waitTicks(page, 5);
    s = await page.eval(state);
    t.check(s.primary === second && s.locked && !s.pause, 'N으로 닫으면 무기는 그대로고 포인터가 다시 잠긴다', s);
    // Esc로 닫는다: 일시정지 메뉴가 뜨지 않는다
    await page.press('KeyN');
    await page.waitFor('__qa.ui.isVisible("loadout")', 3000, { label: '무기 목록' });
    await page.press('Escape');
    await page.waitFor('!__qa.ui.isVisible("loadout")', 3000, { label: 'Esc로 닫힘' });
    await waitTicks(page, 5);
    s = await page.eval(state);
    t.check(!s.pause && s.primary === second, 'Esc로 닫아도 일시정지 메뉴가 뜨지 않고 무기는 그대로다', s);
    t.check(s.frozen, '대기 중에는 움직이지 않는다', s);
    t.errorsOk('대기 시간 무기 교체');

    // 라운드가 시작되면 안내와 N이 꺼진다
    t.setSection('라운드 시작 뒤');
    page = await openGame(t, 'sandbox=alley&ruleset=classic&mode=team&bots=1', { profile: richProfile(), settings: LOW_QUALITY, width: 960, height: 540, screen: 'sandbox' });
    await waitRun(page);
    await page.eval('__qa.freezeBots()');
    await page.waitFor('__qa.run.phase === "loadout" && __qa.world.localAlive', 15000, { label: '대기 단계' });
    await lockPointer(page);
    await page.press('KeyN');
    await page.waitFor('__qa.ui.isVisible("loadout")', 3000, { label: '무기 목록' });
    await waitLive(page);
    await waitTicks(page, 5);
    s = await page.eval(state);
    t.check(!s.list, '고르지 않고 열어 둔 목록은 라운드가 시작되면 닫힌다', s);
    t.check(!s.prompt, '시작하면 안내가 사라진다', s);
    await lockPointer(page);
    await page.press('KeyN');
    await sleep(300);
    s = await page.eval(state);
    t.check(!s.list && s.locked, '시작한 뒤의 N은 아무것도 하지 않는다', s);
    t.errorsOk('라운드 시작 뒤');

    // 개인전: 출격 전이라 무기 선택 화면이 바로 뜬다(예전 그대로)
    t.setSection('개인전은 처음 무기 선택 화면');
    page = await openGame(t, 'sandbox=alley&ruleset=classic&mode=ffa&bots=1&killtarget=50', { profile: richProfile(), settings: LOW_QUALITY, width: 960, height: 540, screen: 'sandbox' });
    await waitRun(page);
    await page.waitFor('__qa.ui.isVisible("loadout")', 8000, { label: '개인전 무기 선택' });
    s = await page.eval(`({ title: __qa.text('.sk-lo-title'), prompt: __qa.visible('.sk-swap') })`);
    t.check(/무기 선택/.test(s.title) && !s.prompt, '개인전은 무기 선택 화면이 바로 뜨고 N 안내는 없다', s);
    t.errorsOk('개인전');

    // 휴대폰: 키가 없으니 안내를 눌러 목록을 열고, 카드를 눌러 바꾼다
    t.setSection('휴대폰: 안내를 눌러 무기 교체');
    const W = 844, H = 390;
    const mob = await t.newPage();
    await mob.open(`${t.base}?debug=1&sandbox=alley&ruleset=classic&mode=team&bots=1&loadout=20`,
      { width: W, height: H, mobile: true, clean: true, initScript: qaInit({ profile: richProfile(), settings: LOW_QUALITY }) });
    await mob.waitFor('window.__qa && __qa.ctx && __qa.world && __qa.ctx.screen === "sandbox"', 60000, { label: '휴대폰 게임 부팅' });
    await mob.eval('__qa.watch()');
    await waitRun(mob);
    await mob.eval('__qa.freezeBots()');
    await mob.waitFor('__qa.run.phase === "loadout" && __qa.world.localAlive', 15000, { label: '대기 단계' });
    const tap = async (selector) => {
      const at = await mob.eval(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      await mob.touch('touchStart', [{ id: 1, x: at.x, y: at.y }]);
      await sleep(60);
      await mob.touch('touchEnd', []);
    };
    if (!(await mob.eval('__qa.ctx.input.locked'))) {
      await mob.touch('touchStart', [{ id: 1, x: W * 0.75, y: H * 0.3 }]);
      await sleep(60);
      await mob.touch('touchEnd', []);
    }
    await mob.waitFor('__qa.ctx.input.locked && __qa.ctx.input.enabled', 5000, { label: '휴대폰 조작 시작' });
    await waitTicks(mob, 5);
    t.page = mob;
    const prompt = await mob.eval(`({ text: __qa.text('.sk-swap-main'), keyShown: __qa.visible('.sk-swap-key'), visible: __qa.visible('.sk-swap') })`);
    t.check(prompt.visible && prompt.text === '눌러서 무기 교체!' && !prompt.keyShown, '휴대폰 안내는 키 표시 없이 누르라고 알린다', prompt);
    await t.shot('mobile-prompt');
    const beforeM = await mob.eval('__qa.arsenal.getLoadout().primary');
    await tap('.sk-swap');
    await mob.waitFor('__qa.ui.isVisible("loadout")', 3000, { label: '휴대폰 무기 목록' }).catch((e) => t.check(false, '안내를 누르면 무기 목록이 열린다', e.message));
    await sleep(200);
    await t.shot('mobile-list');
    await tap('.sk-lo-card:not(.is-sel)');
    await mob.waitFor('!__qa.ui.isVisible("loadout")', 3000, { label: '휴대폰 목록 닫힘' }).catch((e) => t.check(false, '카드를 누르면 목록이 닫힌다', e.message));
    await waitTicks(mob, 20);
    const m = await mob.eval(state);
    t.check(m.primary !== beforeM && m.held === m.primary, '누른 무기로 바로 바뀐다', { beforeM, m });
    t.check(m.locked && m.prompt, '목록이 닫히면 조작이 바로 돌아오고 안내가 다시 보인다', m);
    t.errorsOk('휴대폰 무기 교체');
  }
};
