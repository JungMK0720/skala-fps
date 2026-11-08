/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 시나리오 14. 화면 모음. 960x540에서 주요 화면을 차례로 띄워 스크린샷을 남기고, 글자가 화면 밖으로 나가거나 버튼이 잘리지 않는지 본다. 눈으로 확인할 때 이 사진들을 본다.
 */
import { LOW_QUALITY, NICK, lockPointer, openGame, richProfile, sleep, waitLive, waitRun, waitTicks } from '../kit.mjs';

/** 페이지에서: 이 화면의 보이는 버튼 중 뷰포트 밖으로 나간 것(세로로 스크롤되는 곳은 넘어간다) */
function clippedButtons(rootSel) {
  const root = document.querySelector(rootSel);
  if (!root) return ['없는 화면: ' + rootSel];
  const out = [];
  for (const el of root.querySelectorAll('button')) {
    if (el.hidden || el.disabled) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    if (r.left < -1 || r.right > innerWidth + 1) out.push(`${(el.textContent || el.title || '').slice(0, 20)} x ${Math.round(r.left)}..${Math.round(r.right)}`);
  }
  return out;
}

export default {
  name: 'gallery',
  title: '주요 화면 사진과 가로 넘침 검사',
  timeoutMs: 5 * 60 * 1000,
  async run(t) {
    const stats = { kills: 57, deaths: 31, headshots: 12, halfShots: 3, knifeKills: 4, matches: 9, wins: 4, secondsPlayed: 3725 };
    const profile = richProfile({ points: 12345, stats, secrets: { alley: { alley_watertower: { name: '물탱크 옥상', at: 5 } } } });
    const see = async (name, sel) => {
      await sleep(350);
      await t.shot(name);
      if (sel) t.check((await t.page.fn(clippedButtons, sel)).length === 0, `${name}: 버튼이 가로로 잘리지 않는다`, await t.page.fn(clippedButtons, sel));
    };
    // Tab을 누른 채 점수판 사진. 4배속이라 그사이 라운드가 끝나 조작이 풀렸으면(무기 선택·라운드 끝) 사진만 건너뛴다
    const scoreboardShot = async (page, name) => {
      await page.key('Tab', 'down');
      const open = await page.waitFor('__qa.ui.isVisible("scoreboard")', 2000, { label: '점수판' }).then(() => true, () => false);
      if (open) await see(name);
      else {
        const st = await page.eval('({ locked: __qa.ctx.input.locked, enabled: __qa.ctx.input.enabled, phase: __qa.world.internals.rnd.phase })');
        if (st.locked && st.enabled && st.phase === 'live') t.check(false, `${name}: Tab을 누르면 점수판이 열린다`, st);
        else t.note(`${name}: 점수판을 열기 전에 라운드가 끝나 사진을 건너뛰었다 ${JSON.stringify(st)}`);
      }
      await page.key('Tab', 'up');
    };

    t.setSection('메뉴 화면');
    let page = await openGame(t, '', { profile, settings: LOW_QUALITY, screen: 'menu' });
    await see('menu', '.sk-menu');
    await page.clickText('.sk-menu-btn--wide', '연습장');
    await page.waitFor('!!document.querySelector(".sk-sheet")', 3000, { label: '연습장 시트' });
    await see('practice-sheet', '.sk-sheet');
    await page.press('Escape');
    await page.click('.sk-player-mypage');
    await page.waitFor('__qa.ui.isVisible("mypage")', 3000, { label: '마이페이지' });
    await see('mypage', '.sk-mypage');
    await page.click('.sk-mypage .sk-my-panelhead .sk-btn--sm');
    await page.waitFor('__qa.ui.isVisible("shop")', 3000, { label: '상점' });
    await see('shop-rifle', '.sk-shop');
    for (const tab of ['저격', 'SMG·샷건', '권총', '근접']) {
      await page.clickText('.sk-shop .sk-tab', tab);
      await see(`shop-${tab.replace(/\W/g, '')}`, '.sk-shop');
    }
    await page.click('.sk-shop .sk-btn--ghost');
    await page.waitFor('__qa.ui.isVisible("mypage")', 3000, { label: '마이페이지로' });
    await page.press('Escape');
    await page.waitFor('__qa.ui.isVisible("menu")', 3000, { label: '메뉴로' });
    await page.clickText('.sk-menu-btn--sub', '설정');
    await see('settings', '.sk-settings');
    await page.press('Escape');
    await page.clickText('.sk-menu-btn--sub', '조작법');
    await see('controls-panel', '.sk-menu');
    await page.press('Escape');
    t.errorsOk('메뉴 화면');

    t.setSection('개인전 경기 화면');
    page = await openGame(t, 'sandbox=nexus&ruleset=classic&mode=ffa&bots=5&killtarget=5&timescale=4', { profile, settings: LOW_QUALITY, screen: 'sandbox' });
    await waitRun(page);
    await waitLive(page);
    await page.waitFor('!__qa.ui.isVisible("loadout")', 5000, { label: '무기 선택 닫힘' });
    await page.eval(`__qa.ui.show('loadout', { ruleset: 'classic', seconds: 0, selected: 'ar_std', title: '개인전 · 무기 선택' })`);
    await see('ffa-loadout', '.sk-loadout');
    await page.eval(`__qa.ui.hide('loadout')`);
    await lockPointer(page);
    await page.waitFor(`__qa.match.some((e) => e.type === 'kill')`, 40000, { label: '첫 킬' });
    await see('ffa-hud');
    await scoreboardShot(page, 'ffa-scoreboard');
    await page.waitFor('__qa.ui.isVisible("results")', 90000, { intervalMs: 300, label: '결과 화면' });
    await sleep(1200);
    await see('ffa-results', '.sk-results');
    t.errorsOk('개인전 경기');

    t.setSection('팀전 경기 화면');
    page = await openGame(t, 'sandbox=alley&ruleset=knife&mode=team&bots=2&timescale=4', { profile, settings: LOW_QUALITY, screen: 'sandbox' });
    await waitRun(page);
    await waitLive(page);
    await page.waitFor('!__qa.ui.isVisible("loadout")', 5000, { label: '무기 선택 닫힘' });
    await page.eval(`__qa.ui.show('loadout', { ruleset: 'knife', seconds: 0, selected: 'ml_knife', round: 1 })`);
    await see('knife-loadout', '.sk-loadout');
    await page.eval(`__qa.ui.hide('loadout')`);
    await lockPointer(page);
    await waitTicks(page, 20);
    await see('team-hud');
    await scoreboardShot(page, 'team-scoreboard');
    await page.waitFor(`__qa.world.internals.rnd.phase === 'roundEnd' || __qa.run.phase === 'roundEnd'`, 90000, { intervalMs: 200, label: '라운드 끝' });
    await see('team-round-end');
    await page.waitFor('__qa.ui.isVisible("results")', 150000, { intervalMs: 300, label: '결과 화면' });
    await sleep(1200);
    await see('team-results', '.sk-results');
    t.errorsOk('팀전 경기');

    t.setSection('사격 화면');
    page = await openGame(t, 'sandbox=dojo&ruleset=knife&mode=ffa&bots=1', { profile: { nickname: NICK, createdAt: 1 }, screen: 'sandbox' });
    await waitRun(page);
    await page.eval('__qa.freezeBots()');
    await waitLive(page);
    await page.waitFor('!__qa.ui.isVisible("loadout")', 8000, { label: '무기 선택 닫힘' });
    await see('dojo-default-quality');
    await page.eval(`__qa.ui.show('pause', { leaveLabel: '연습장 나가기', note: '연습장은 일시정지하면 봇도 멈춰요.' })`);
    await see('pause', '.sk-pause');
    t.errorsOk('사격 화면');
  }
};
