/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 시나리오 10. 게임 중 조작 화면을 검사한다. 클릭 안내와 포인터 잠금, 일시정지와 재개, 설정 적용(감도·시야각·줌 방식), 점수판, 이모트 휠과 3인칭, 비율이 다른 작은 창을 본다.
 */
import { EMOTES } from '../../../js/core/consts.js';
import { LOW_QUALITY, clickFire, lockPointer, openGame, richProfile, sleep, waitIdle, waitLive, waitRun, waitTicks } from '../kit.mjs';

const near = (a, b, eps = 0.05) => Math.abs(a - b) <= eps;

export default {
  name: 'controls',
  title: '포인터 잠금, 일시정지, 설정 적용, 점수판, 이모트 휠',
  timeoutMs: 5 * 60 * 1000,
  async run(t) {
    t.setSection('클릭 안내와 포인터 잠금');
    const page = await openGame(t, 'sandbox=alley&ruleset=classic&mode=ffa&bots=1&killtarget=50', { profile: richProfile(), settings: LOW_QUALITY, width: 800, height: 450, screen: 'sandbox' });
    await waitRun(page);
    await page.eval('__qa.freezeBots(); __qa.run.bots[0].alive = false');
    await waitLive(page);
    await page.waitFor('!__qa.ui.isVisible("loadout")', 8000, { label: '무기 선택 닫힘' });
    await waitTicks(page, 3);
    t.check(await page.eval('!__qa.ctx.input.locked && !__qa.ctx.input.enabled'), '시간이 끝나 저절로 고른 뒤에는 아직 잠금 전이다');
    t.check(/화면을 클릭/.test(await page.eval(`__qa.text('.sk-hint')`)), '클릭하라는 안내가 보인다', await page.eval(`__qa.text('.sk-hint')`));
    await page.key('KeyW', 'down');
    await waitTicks(page, 10);
    await page.key('KeyW', 'up');
    t.check(await page.eval(`Math.hypot(__qa.ctx.player.state.vel[0], __qa.ctx.player.state.vel[2]) < 0.01`), '잠금 전에는 움직이지 않는다');
    await t.shot('click-to-start');
    await lockPointer(page);
    await waitTicks(page, 3);
    t.check((await page.eval(`__qa.text('.sk-hint')`)) === '', '잠그면 안내가 사라진다', await page.eval(`__qa.text('.sk-hint')`));

    t.setSection('마우스 시점');
    await page.mouseMove(400, 225);
    await waitTicks(page, 2);
    const look = async (dx, dy) => {
      const a = await page.eval('({ yaw: __qa.ctx.player.state.yaw, pitch: __qa.ctx.player.state.pitch })');
      await page.mouseMove(400 + dx, 225 + dy);
      await waitTicks(page, 3);
      const b = await page.eval('({ yaw: __qa.ctx.player.state.yaw, pitch: __qa.ctx.player.state.pitch })');
      await page.mouseMove(400, 225);
      await waitTicks(page, 3);
      return { yaw: b.yaw - a.yaw, pitch: b.pitch - a.pitch };
    };
    const base = await look(100, 0);
    t.check(near(base.yaw, -100 * 0.0022, 0.02), '오른쪽으로 움직이면 오른쪽을 본다', base);
    const up = await look(0, -50);
    t.check(near(up.pitch, 50 * 0.0022, 0.02), '위로 움직이면 위를 본다', up);

    t.setSection('일시정지');
    await page.eval('document.exitPointerLock()');
    await page.waitFor('__qa.ui.isVisible("pause")', 3000, { label: '잠금이 풀리면 일시정지' });
    t.check(await page.eval('__qa.run.paused && __qa.world.paused'), '연습장은 멈춘다');
    const ticks = await page.eval('__qa.run.stats.ticks');
    await sleep(400);
    t.check((await page.eval('__qa.run.stats.ticks')) === ticks, '일시정지 중에는 경기가 돌지 않는다');
    t.check(/봇도 멈춰요/.test(await page.eval(`__qa.text('.sk-pause-note')`)), '일시정지 안내', await page.eval(`__qa.text('.sk-pause-note')`));
    await t.shot('pause');

    t.setSection('일시정지 안의 설정');
    await page.clickText('.sk-pause-btns .sk-btn', '설정');
    await page.waitFor(`!document.querySelector('.sk-pause .sk-modal').hidden`, 2000, { label: '설정 창' });
    await page.clickText('.sk-pause .sk-settings .sk-seg-btn', '토글');
    t.check((await page.eval(`__qa.ctx.settings.get('zoomMode')`)) === 'toggle', '줌 방식이 바뀐다');
    t.check((await page.eval(`__qa.arsenal.getZoomMode()`)) === 'toggle', '무기에 바로 적용된다');
    await page.fn(() => {
      const input = document.querySelector('.sk-pause .sk-settings input[aria-label="시야각"]');
      input.value = '90';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const sens = document.querySelector('.sk-pause .sk-settings input[aria-label="마우스 감도"]');
      sens.value = '2';
      sens.dispatchEvent(new Event('input', { bubbles: true }));
    });
    t.check((await page.eval(`__qa.ctx.settings.get('fov')`)) === 90, '시야각이 바뀐다');
    t.check((await page.eval(`__qa.ctx.renderer.baseFov`)) === 90, '시야각이 렌더러에 적용된다');
    await page.clickText('.sk-pause .sk-settings .sk-btn', '완료');
    await page.waitFor(`document.querySelector('.sk-pause .sk-modal').hidden`, 2000, { label: '설정 창 닫힘' });

    t.setSection('재개');
    await page.click('.sk-pause-btns .sk-btn--primary');
    await page.waitFor('!__qa.ui.isVisible("pause")', 2000, { label: '일시정지 닫힘' });
    t.check(await page.eval('!__qa.run.paused'), '재개한다');
    await lockPointer(page);
    const t0 = await page.eval('__qa.run.stats.ticks');
    await waitTicks(page, 10);
    t.check((await page.eval('__qa.run.stats.ticks')) > t0, '경기가 다시 돈다');
    await waitTicks(page, 5);
    t.check(near(await page.eval('__qa.ctx.renderer.camera.fov'), 90, 0.01), '게임 화면 시야각이 90이다', await page.eval('__qa.ctx.renderer.camera.fov'));
    const fast = await look(100, 0);
    t.check(near(fast.yaw, -200 * 0.0022, 0.03), '감도 2배면 두 배로 돈다', fast);

    t.setSection('토글 줌');
    await page.press('Digit1');
    await waitIdle(page);
    await clickFire(page, 2, 2);
    await page.waitFor('__qa.arsenal.getZoom().progress >= 1', 3000, { label: '토글로 줌' });
    await waitTicks(page, 10);
    t.check((await page.eval('__qa.arsenal.getZoom().zoomed')), '버튼을 떼도 줌이 유지된다');
    await clickFire(page, 2, 2);
    await page.waitFor('__qa.arsenal.getZoom().progress <= 0', 3000, { label: '다시 눌러 해제' });
    await page.fn(() => { const s = window.__qa.ctx.settings; s.set('zoomMode', 'hold'); s.set('fov', 75); s.set('sensitivity', 1); });

    t.setSection('점수판');
    t.check(!(await page.eval('__qa.ui.isVisible("scoreboard")')), '처음에는 닫혀 있다');
    await page.key('Tab', 'down');
    await page.waitFor('__qa.ui.isVisible("scoreboard")', 2000, { label: 'Tab 점수판' });
    const board = await page.eval(`document.querySelector('.sk-scoreboard').textContent`);
    t.check(board.includes('테스터') && board.includes('봇'), '점수판에 나와 봇이 있다', board.slice(0, 200));
    t.check(await page.eval('__qa.ctx.input.locked'), '점수판은 잠금을 풀지 않는다');
    await t.shot('scoreboard');
    await page.key('Tab', 'up');
    await page.waitFor('!__qa.ui.isVisible("scoreboard")', 2000, { label: 'Tab 떼면 닫힘' });

    t.setSection('이모트 휠');
    await page.mouseMove(400, 225);
    await waitTicks(page, 3);
    await page.key('KeyB', 'down');
    await page.waitFor('__qa.ui.isVisible("emotes")', 2000, { label: 'B 이모트 휠' });
    const yawBefore = await page.eval('__qa.ctx.player.state.yaw');
    await page.mouseMove(400, 125);
    await page.waitFor('__qa.ctx.input.emoteWheel.selected === 0', 3000, { label: '12시 칸 강조' });
    await waitTicks(page, 3);
    t.check(near(await page.eval('__qa.ctx.player.state.yaw'), yawBefore, 1e-6), '휠이 열린 동안 시점이 멈춘다');
    t.check(await page.eval(`__qa.text('.sk-emo-hub-name')`) === EMOTES[0].name, '가운데에 고른 이모트 이름이 보인다', await page.eval(`__qa.text('.sk-emo-hub-name')`));
    await t.shot('emote-wheel');
    await page.key('KeyB', 'up');
    await page.waitFor(`__qa.ctx.player.state.emoteId === ${JSON.stringify(EMOTES[0].id)}`, 2000, { label: '이모트 시작' });
    await page.waitFor('__qa.ctx.player.thirdPerson > 0.5', 3000, { label: '3인칭 전환' });
    t.check(await page.eval(`__qa.text('.sk-emote-banner').includes(${JSON.stringify(EMOTES[0].name)})`), '하단에 이모트 이름이 보인다', await page.eval(`__qa.text('.sk-emote-banner')`));
    t.check(await page.eval('!__qa.world.internals.vm.group.visible'), '이모트 중에는 무기 모형을 숨긴다');
    const covered = await page.eval(`(() => { const a = document.querySelector('.sk-emote-banner').getBoundingClientRect(), b = document.querySelector('.sk-slots').getBoundingClientRect(); return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom; })()`);
    t.check(!covered, '이모트 안내가 무기 슬롯과 겹치지 않는다');
    await sleep(300);
    await t.shot('emote-third-person');
    await page.eval('__qa.clearLogs()');
    await clickFire(page, 2);
    await page.waitFor('__qa.ctx.player.state.emote === 0', 2000, { label: '클릭으로 취소' });
    await waitTicks(page, 3);
    t.check((await page.eval(`__qa.worldCount('fire')`)) === 0, '이모트를 취소한 클릭은 사격이 되지 않는다');
    await page.waitFor('__qa.ctx.player.thirdPerson < 0.01', 3000, { label: '1인칭으로 돌아옴' });
    await waitTicks(page, 3);
    t.check(await page.eval('__qa.world.internals.vm.group.visible'), '무기 모형이 돌아온다');

    t.setSection('이모트 거절과 이동 취소');
    await page.key('KeyB', 'down');
    await page.waitFor('__qa.ui.isVisible("emotes")', 2000, { label: '휠' });
    await page.mouseMove(500, 225);
    await page.waitFor('__qa.ctx.input.emoteWheel.selected != null', 2000, { label: '칸 강조' });
    await page.key('KeyW', 'down');
    await page.key('KeyB', 'up');
    await page.waitFor('!__qa.ui.isVisible("emotes")', 2000, { label: '휠 닫힘' });
    await waitTicks(page, 3);
    t.check((await page.eval('__qa.ctx.player.state.emote')) === 0, '움직이는 중에는 시작하지 않는다');
    await page.key('KeyW', 'up');
    await page.waitFor('Math.hypot(__qa.ctx.player.state.vel[0], __qa.ctx.player.state.vel[2]) < 0.1', 3000, { label: '멈춤' });
    t.check(await page.eval(`/멈춘 상태/.test(__qa.text('.sk-center-main'))`), '거절 이유를 알려 준다', await page.eval(`__qa.text('.sk-center-main')`));
    await page.mouseMove(400, 225);
    await waitTicks(page, 3);
    await page.key('KeyB', 'down');
    await page.waitFor('__qa.ui.isVisible("emotes")', 2000, { label: '휠' });
    await page.mouseMove(500, 225);
    await page.waitFor('__qa.ctx.input.emoteWheel.selected != null', 2000, { label: '칸 강조' });
    await page.key('KeyB', 'up');
    await page.waitFor('__qa.ctx.player.state.emote !== 0', 2000, { label: '이모트 시작' });
    await page.key('KeyW', 'down');
    await page.waitFor('__qa.ctx.player.state.emote === 0', 2000, { label: '움직이면 취소' });
    await page.key('KeyW', 'up');
    t.errorsOk('조작');
  }
};
