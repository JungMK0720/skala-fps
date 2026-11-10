/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 시나리오 22. 전체 화면 키 잠금을 검사한다. F11과 일시정지 메뉴의 버튼으로 앱의 전체 화면을 켜고 끄는지, 설정이 실제 상태를 따라가는지,
 *          키 잠금 중 Esc가 전체 화면을 풀지 않고 일시정지 메뉴만 여는지, 창 화면에서 Ctrl을 처음 누르면 안내 배너가 뜨는지 본다.
 */
import { LOW_QUALITY, lockPointer, openGame, richProfile, sleep, waitLive, waitRun, waitTicks } from '../kit.mjs';

const state = `({
  fullscreen: !!document.fullscreenElement,
  setting: __qa.ctx.settings.get('fullscreen'),
  kb: __qa.ctx.input.keyboardLocked,
  can: __qa.ctx.input.canKeyboardLock,
  locked: __qa.ctx.input.locked,
  pause: __qa.ui.isVisible('pause')
})`;

export default {
  name: 'keys',
  title: '전체 화면 키 잠금(F11 · 일시정지 버튼 · Esc)',
  timeoutMs: 4 * 60 * 1000,
  async run(t) {
    t.setSection('창 화면: Ctrl 안내 배너');
    const page = await openGame(t, 'sandbox=alley&ruleset=classic&mode=ffa&bots=1&killtarget=50', { profile: richProfile(), settings: LOW_QUALITY, width: 960, height: 540, screen: 'sandbox' });
    await waitRun(page);
    await page.eval('__qa.freezeBots(); __qa.run.bots[0].alive = false');
    await waitLive(page);
    await page.waitFor('!__qa.ui.isVisible("loadout")', 8000, { label: '무기 선택 닫힘' });
    await lockPointer(page);
    let s = await page.eval(state);
    t.check(!s.fullscreen && s.setting === 'off' && !s.kb, '처음은 창 화면이고 키 잠금이 없다', s);
    if (s.can) {
      await page.key('ControlLeft', 'down');
      await waitTicks(page, 5);
      await page.key('ControlLeft', 'up');
      await page.waitFor(`__qa.visible('.sk-hud-banner.is-show')`, 3000, { label: '키 잠금 안내 배너' }).catch(() => {});
      const banner = await page.eval(`__qa.text('.sk-hud-banner')`);
      t.check(/F11/.test(banner || ''), '창 화면에서 Ctrl을 처음 누르면 F11 안내 배너가 뜬다', banner);
    } else {
      t.note('이 브라우저는 Keyboard Lock이 없어 안내 배너를 띄우지 않는다');
    }

    t.setSection('F11 → 앱의 전체 화면');
    await page.press('F11');
    await sleep(800);
    s = await page.eval(state);
    if (!s.fullscreen) {
      // 헤드리스 등 전체 화면을 못 쓰는 환경: 설정이 '끔'으로 돌아와 표시와 실제가 어긋나지 않는지만 본다
      t.note('이 브라우저 환경은 전체 화면을 허용하지 않는다 → 거절 경로만 검사한다');
      t.check(s.setting === 'off', '전체 화면이 거절되면 설정이 끔으로 돌아온다', s);
      t.errorsOk('전체 화면 거절');
      return;
    }
    t.check(s.setting === 'on', '전체 화면에 들어가면 설정이 켬이 된다', s);
    if (s.can) {
      await page.waitFor('__qa.ctx.input.keyboardLocked', 3000, { label: '키 잠금' }).catch(() => {});
      s = await page.eval(state);
      t.check(s.kb, '전체 화면에서 키 잠금이 걸린다', s);
    }
    await t.shot('fullscreen');

    if (s.kb) {
      t.setSection('키 잠금 중 Esc');
      await lockPointer(page);
      await page.press('Escape');
      await page.waitFor('__qa.ui.isVisible("pause")', 3000, { label: '일시정지 메뉴' });
      s = await page.eval(state);
      t.check(s.fullscreen && !s.locked, 'Esc는 전체 화면을 풀지 않고 일시정지 메뉴만 연다', s);
      const label = await page.eval(`[...document.querySelectorAll('.sk-pause-btns button')].map((b) => b.textContent).find((x) => /전체 화면/.test(x))`);
      t.check(label === '전체 화면 끄기', '일시정지 메뉴의 버튼이 지금 상태를 보여 준다', label);
      await page.clickText('.sk-pause-btns .sk-btn', '계속하기');
      await page.waitFor('__qa.ctx.input.locked && !__qa.ui.isVisible("pause")', 4000, { label: '다시 잠금' });
      s = await page.eval(state);
      t.check(s.fullscreen && s.kb, '계속하면 전체 화면과 키 잠금이 그대로다', s);
    }

    t.setSection('F11로 나가기');
    await page.press('F11');
    await page.waitFor('!document.fullscreenElement', 4000, { label: '전체 화면 나감' });
    await sleep(300);
    s = await page.eval(state);
    t.check(!s.fullscreen && s.setting === 'off' && !s.kb, '나가면 설정이 끔이 되고 키 잠금이 풀린다', s);
    t.errorsOk('전체 화면 키 잠금');
  }
};
