/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 시나리오 2. 메인 메뉴, 마이페이지(이름 변경·전적·장비), 상점(구매·포인트 부족·장착·새로고침 유지·이모트 휠), 빠른 시작, 연습장 설정 시트를 진짜 클릭으로 검사한다.
 */
import { MAPS, mapsForRuleset } from '../../../js/maps/index.js';
import { RULESET_IDS, RULESETS } from '../../../js/game/modes.js';
import { LOW_QUALITY, NICK, lockPointer, openGame, readyGame, sleep, waitRun, waitTicks } from '../kit.mjs';

const shown = (page, sel) => page.fn((s) => window.__qa.visible(s), sel);
const textOf = (page, sel) => page.fn((s) => window.__qa.text(s), sel);

async function retype(page, selector, text) {
  await page.fn((sel) => { const el = document.querySelector(sel); el.focus(); el.select(); }, selector);
  await page.type(text);
}

/** 게임 화면을 일시정지 메뉴로 나간다: Esc → 나가기 → 확인 */
async function leaveToMenu(t, page) {
  await page.waitFor('!__qa.ui.isVisible("loadout")', 15000, { label: '무기 선택이 닫힘' });
  await page.press('Escape');
  await page.waitFor('__qa.ui.isVisible("pause")', 5000, { label: '일시정지 메뉴' });
  await page.click('.sk-pause-btns .sk-btn--danger');
  await page.click('.sk-pause .sk-confirm .sk-btn--danger');
  await page.waitFor('__qa.ctx.screen === "menu" && __qa.ui.isVisible("menu")', 10000, { label: '메뉴로 돌아옴' });
  t.check(await page.eval('!__qa.ctx.map && !__qa.ctx.rendering'), '메뉴로 나오면 맵을 치우고 렌더링을 멈춘다');
}

export default {
  name: 'menus',
  title: '메뉴, 마이페이지, 상점, 빠른 시작, 연습장 설정 시트',
  timeoutMs: 240000,
  async run(t) {
    t.setSection('메뉴');
    const profile = { nickname: NICK, points: 500, createdAt: 1 };
    let page = await openGame(t, '', { profile, settings: LOW_QUALITY, screen: 'menu' });
    await page.waitFor('__qa.ui.isVisible("menu")', 5000, { label: '메뉴' });
    t.check((await textOf(page, '.sk-name-text')) === NICK, '메뉴 카드의 닉네임');
    t.check((await textOf(page, '.sk-player .sk-points-val')) === '500 P', '메뉴 카드의 포인트', await textOf(page, '.sk-player .sk-points-val'));
    t.check(/항구 골목 · 개인전 · 봇 5/.test(await textOf(page, '.sk-menu-btn--main .sk-menu-sub')), '빠른 시작 기본 설정 문구', await textOf(page, '.sk-menu-btn--main .sk-menu-sub'));

    t.setSection('마이페이지: 이름 변경');
    await page.click('.sk-player-mypage');
    await page.waitFor('__qa.ui.isVisible("mypage") && !__qa.ui.isVisible("menu")', 3000, { label: '마이페이지' });
    t.check((await textOf(page, '.sk-my-name')) === NICK, '지금 닉네임');
    await retype(page, '#sk-my-nick', 'a');
    await page.waitFor(`document.querySelector('#sk-my-nick-status').classList.contains('is-bad')`, 3000, { label: '잘못된 이름 표시' });
    t.check(await page.eval(`document.querySelector('.sk-my-save').disabled`), '잘못된 이름이면 저장이 꺼진다');
    await retype(page, '#sk-my-nick', NICK);
    t.check(/지금 쓰는 닉네임/.test(await textOf(page, '#sk-my-nick-status')), '같은 이름이면 안내', await textOf(page, '#sk-my-nick-status'));
    t.check(await page.eval(`document.querySelector('.sk-my-save').disabled`), '같은 이름이면 저장이 꺼진다');
    await retype(page, '#sk-my-nick', '바꾼이름');
    await page.waitFor(`!document.querySelector('.sk-my-save').disabled`, 3000, { label: '저장 켜짐' });
    await page.click('.sk-my-save');
    await page.waitFor(`document.querySelector('.sk-my-name').textContent === '바꾼이름'`, 3000, { label: '이름 바뀜' });
    t.check((await page.eval('__qa.profile().nickname')) === '바꾼이름', '프로필 닉네임');
    t.check((await page.eval('__qa.ctx.session.name')) === '바꾼이름', '플레이어 이름도 따라 바뀐다');

    t.setSection('마이페이지: 전적·장비');
    const stats = await page.eval(`[...document.querySelectorAll('.sk-my-stats .sk-my-stat')].map((c) => [c.querySelector('dt').textContent, c.querySelector('dd').textContent])`);
    t.check(stats.length === 9, '전적 칸 9개', stats);
    t.check(stats.filter(([k]) => k !== 'K/D' && k !== '플레이 시간').every(([, v]) => v === '0'), '새 프로필 전적은 0', stats);
    const choiceTitles = () => page.eval(`[...document.querySelectorAll('.sk-my-equiprow')].map((r) => [...r.querySelectorAll('.sk-choice')].map((b) => b.title))`);
    const rows = await choiceTitles();
    t.check(rows.length === 3, '장비 칸 3개', rows);
    t.check(rows[0].length === 2 && rows[1].length === 1 && rows[2].length === 1, '기본 지급 무기만 고를 수 있다', rows);
    t.check((await page.eval('__qa.ctx.account.loadout.melee')) === 'ml_knife', '기본 칼은 호크빌 나이프다');
    t.check(await page.eval(`document.querySelector('.sk-my-equiprow .sk-choice[title="호크빌 나이프"]').classList.contains('is-on')`), '장착한 칸이 표시된다');
    await t.shot('mypage');

    t.setSection('상점: 포인트 부족');
    await page.click('.sk-mypage .sk-my-panelhead .sk-btn--sm');
    await page.waitFor('__qa.ui.isVisible("shop") && !__qa.ui.isVisible("mypage")', 3000, { label: '상점' });
    t.check((await textOf(page, '.sk-shop .sk-points-val')) === '500 P', '상점 포인트');
    const tabs = await page.eval(`[...document.querySelectorAll('.sk-shop .sk-tab')].map((b) => b.textContent)`);
    t.check(tabs.join() === '라이플,저격,SMG·샷건,권총,근접,이모트', '탭 6개(무기 5 + 이모트)', tabs);
    const rapid = `.sk-shop-card[aria-label="RX-9 스톰"]`;
    t.check(await page.eval(`document.querySelector('${rapid} .sk-shop-action').disabled`), '비싼 무기는 살 수 없다');
    t.check((await textOf(page, `${rapid} .sk-shop-need`)) === '300 P 더 필요해요', '모자란 포인트 표시', await textOf(page, `${rapid} .sk-shop-need`));
    t.check((await page.eval(`__qa.ctx.account.buy('ar_rapid').reason`)) === 'points', 'API도 포인트 부족으로 거절한다');
    t.check((await page.eval(`__qa.ctx.account.buy('없는무기').reason`)) === 'unknown', 'API는 없는 무기를 거절한다');
    t.check((await page.eval(`__qa.ctx.account.buy('ar_std').reason`)) === 'owned', 'API는 가진 무기를 거절한다');
    await t.shot('shop-rifle');

    t.setSection('상점: 구매와 장착');
    await page.clickText('.sk-shop .sk-tab', '권총');
    const magnum = `.sk-shop-card[aria-label="M-44 매그넘"]`;
    t.check((await textOf(page, `${magnum} .sk-shop-action`)) === '구매 500 P', '살 수 있는 무기 버튼', await textOf(page, `${magnum} .sk-shop-action`));
    await page.click(`${magnum} .sk-shop-action`);
    await page.waitFor(`document.querySelector('.sk-shop .sk-points-val').textContent === '0 P'`, 2000, { label: '포인트 차감' });
    t.check(/샀어요/.test(await textOf(page, '.sk-shop-note')), '구매 안내', await textOf(page, '.sk-shop-note'));
    t.check((await textOf(page, `${magnum} .sk-shop-action`)) === '장착', '산 무기는 장착 버튼으로 바뀐다');
    await page.click(`${magnum} .sk-shop-action`);
    t.check((await textOf(page, `${magnum} .sk-shop-action`)) === '장착 중', '장착 표시');
    t.check(await page.eval(`document.querySelector('${magnum} .sk-shop-action').disabled`), '장착한 무기 버튼은 꺼진다');
    t.check((await page.eval('__qa.ctx.account.loadout.secondary')) === 'pt_magnum', '보조 장비가 바뀐다');
    await page.clickText('.sk-shop .sk-tab', '저격');
    t.check((await textOf(page, `.sk-shop-card[aria-label="S-3 스위프트"] .sk-shop-need`)) === '1,000 P 더 필요해요', '포인트 0에서는 다른 무기도 부족 표시', await textOf(page, `.sk-shop-card[aria-label="S-3 스위프트"] .sk-shop-need`));
    await t.shot('shop-after-buy');
    await page.click('.sk-shop .sk-btn--ghost');
    await page.waitFor('__qa.ui.isVisible("mypage")', 3000, { label: '마이페이지로 돌아옴' });
    t.check(await page.eval(`!!document.querySelector('.sk-my-equiprow .sk-choice[title="M-44 매그넘"].is-on')`), '마이페이지에도 산 무기가 장착돼 보인다');
    t.check((await textOf(page, '.sk-mypage .sk-points-val')) === '0 P', '마이페이지 포인트');

    t.setSection('새로고침 뒤 유지');
    await page.reload();
    await readyGame(page, { screen: 'menu' });
    await page.waitFor('__qa.ui.isVisible("menu")', 5000, { label: '메뉴' });
    const after = await page.eval('__qa.profile()');
    t.check(after.points === 0, '포인트 유지', after.points);
    t.check(after.owned.includes('pt_magnum'), '산 무기 유지', after.owned);
    t.check(after.loadout.secondary === 'pt_magnum' && after.loadout.melee === 'ml_knife', '장비 유지', after.loadout);
    t.check(after.nickname === '바꾼이름', '바꾼 이름 유지', after.nickname);
    t.check((await textOf(page, '.sk-player .sk-points-val')) === '0 P', '메뉴 포인트');
    t.errorsOk('마이페이지와 상점');

    t.setSection('쌓인 전적 표시');
    page = await openGame(t, '', {
      screen: 'menu', settings: LOW_QUALITY,
      profile: { nickname: NICK, points: 1234, createdAt: 1, stats: { kills: 10, deaths: 4, headshots: 3, halfShots: 2, knifeKills: 1, matches: 5, wins: 2, secondsPlayed: 750 }, secrets: { alley: { alley_watertower: { name: '물탱크 옥상', at: 5 } } } }
    });
    await page.click('.sk-player-mypage');
    await page.waitFor('__qa.ui.isVisible("mypage")', 3000, { label: '마이페이지' });
    const grid = await page.eval(`Object.fromEntries([...document.querySelectorAll('.sk-my-stats .sk-my-stat')].map((c) => [c.querySelector('dt').textContent, c.querySelector('dd').textContent]))`);
    t.check(grid['킬'] === '10' && grid['데스'] === '4' && grid['K/D'] === '2.50' && grid['헤드샷'] === '3' && grid['반샷'] === '2' && grid['칼 킬'] === '1' && grid['경기'] === '5' && grid['승'] === '2', '전적 값', grid);
    t.check(/12분 30초/.test(grid['플레이 시간']), '플레이 시간', grid['플레이 시간']);
    t.check((await textOf(page, '.sk-mypage .sk-points-val')) === '1,234 P', '천 단위 포인트', await textOf(page, '.sk-mypage .sk-points-val'));
    t.check(/찾은 비밀 스팟 1곳/.test(await page.eval(`document.querySelector('.sk-mypage').textContent`)), '찾은 비밀 스팟 수');
    t.check(/물탱크 옥상/.test(await textOf(page, '.sk-my-secrets')), '찾은 비밀 스팟 이름');
    const secretCounts = await page.eval(`Object.fromEntries([...document.querySelectorAll('.sk-my-secret')].map((r) => [r.querySelector('b').textContent, r.querySelector('.sk-my-secretcount').textContent]))`);
    t.check(secretCounts['항구 골목'] === '1 / 1', '맵별 비밀 스팟 수', secretCounts);
    await t.shot('mypage-stats');
    await page.press('Escape');
    await page.waitFor('__qa.ui.isVisible("menu")', 3000, { label: 'Esc로 메뉴' });

    t.setSection('데이터 초기화');
    await page.click('.sk-player-mypage');
    await page.waitFor('__qa.ui.isVisible("mypage")', 3000, { label: '마이페이지' });
    await page.click('.sk-my-resetbtn');
    await page.waitFor(`!document.querySelector('.sk-mypage .sk-confirm').hidden`, 2000, { label: '확인 상자' });
    await page.clickText('.sk-mypage .sk-confirm .sk-btn', '취소');
    t.check((await page.eval('__qa.profile().points')) === 1234, '취소하면 그대로다');
    await page.click('.sk-my-resetbtn');
    await page.clickText('.sk-mypage .sk-confirm .sk-btn', '네, 지워요');
    await page.waitFor('__qa.ui.isVisible("menu") && __qa.ui.isVisible("nickname")', 3000, { label: '초기화하면 메뉴와 게이트' });
    const wiped = await page.eval('__qa.profile()');
    t.check(wiped.nickname === '' && wiped.points === 500 && wiped.stats.kills === 0 && Object.keys(wiped.secrets).length === 0, '프로필이 처음으로 돌아간다', wiped);
    await page.fn(() => { const el = document.querySelector('#sk-gate-nick'); el.focus(); el.select(); });
    await page.type('새손님');
    await page.waitFor(`!document.querySelector('.sk-nick-submit').disabled`, 3000, { label: '새 이름' });
    await page.click('.sk-nick-submit');
    await page.waitFor('!__qa.ui.isVisible("nickname")', 3000, { label: '게이트 닫힘' });
    t.check((await textOf(page, '.sk-name-text')) === '새손님', '새 닉네임으로 메뉴가 그려진다');

    t.setSection('설정과 조작법 창');
    await page.clickText('.sk-menu-btn--sub', '설정');
    await page.waitFor(`!document.querySelector('.sk-menu .sk-modal').hidden`, 2000, { label: '설정 창' });
    await t.shot('settings');
    await page.press('Escape');
    await page.waitFor(`document.querySelector('.sk-menu .sk-modal').hidden`, 2000, { label: '설정 창 닫힘' });
    await page.clickText('.sk-menu-btn--sub', '조작법');
    await page.waitFor(`!document.querySelector('.sk-menu .sk-modal').hidden`, 2000, { label: '조작법 창' });
    await t.shot('controls');
    await page.press('Escape');
    await page.waitFor(`document.querySelector('.sk-menu .sk-modal').hidden`, 2000, { label: '조작법 창 닫힘' });
    t.check(await page.eval('__qa.ui.isVisible("menu")'), 'Esc로 창만 닫히고 메뉴는 남는다');
    t.errorsOk('설정·조작법');

    t.setSection('빠른 시작');
    page = await openGame(t, '', { profile: { nickname: NICK, points: 500, createdAt: 1 }, settings: LOW_QUALITY, screen: 'menu', width: 640, height: 360 });
    await page.waitFor('__qa.ui.isVisible("menu")', 5000, { label: '메뉴' });
    await page.click('.sk-menu-btn--main');
    await waitRun(page);
    const quick = await page.eval(`(() => { const o = __qa.run.opts; return { mapId: o.mapId, mode: o.mode, ruleset: o.ruleset, bots: o.ffaBots, difficulty: o.difficulty, n: __qa.run.bots.length, menu: __qa.ui.isVisible('menu'), hud: __qa.ui.isVisible('hud') }; })()`);
    t.check(quick.mapId === 'alley' && quick.mode === 'ffa' && quick.ruleset === 'classic' && quick.n === 5, '빠른 시작 기본값(항구 골목·개인전·봇 5)', quick);
    t.check(!quick.menu && quick.hud, '메뉴가 닫히고 HUD가 뜬다', quick);
    await page.waitFor('__qa.ui.isVisible("loadout")', 5000, { label: '무기 선택 화면' });
    await t.shot('quick-start-loadout');
    await page.waitFor('__qa.run.phase === "live"', 15000, { label: 'live 단계' });
    await sleep(300);
    await t.shot('quick-start-live');
    await leaveToMenu(t, page);
    t.check((await page.eval('__qa.profile().stats.matches')) === 0, '중간에 나가면 전적을 남기지 않는다');
    t.errorsOk('빠른 시작');

    t.setSection('연습장 설정 시트');
    await page.clickText('.sk-menu-btn--wide', '연습장');
    await page.waitFor('!!document.querySelector(".sk-sheet")', 3000, { label: '설정 시트' });
    await page.waitFor('document.querySelectorAll(".sk-mapcards .sk-mapcard").length > 0', 3000, { label: '맵 카드' });
    const seg = (label) => `.sk-seg[aria-label="${label}"] .sk-seg-btn`;
    for (const id of RULESET_IDS) {
      await page.clickText(seg('규칙'), RULESETS[id].name);
      const want = mapsForRuleset(id).map((m) => m.name);
      const got = await page.eval(`[...document.querySelectorAll('.sk-mapcards .sk-mapcard-name')].map((n) => n.textContent)`);
      t.check(JSON.stringify(got) === JSON.stringify(want), `${id}: 고를 수 있는 맵 목록`, { got, want });
      for (const m of mapsForRuleset(id)) t.check(MAPS[m.id] && (MAPS[m.id].rulesets || ['classic', 'sniper']).includes(id), `${id}: ${m.id}의 rulesets가 맞다`);
      const on = await page.eval(`[...document.querySelectorAll('.sk-mapcards .sk-mapcard.is-on .sk-mapcard-name')].map((n) => n.textContent)`);
      t.check(on.length === 1 && want.includes(on[0]), `${id}: 고른 맵이 하나이고 목록 안에 있다`, on);
      t.check(new RegExp(RULESETS[id].desc).test(await textOf(page, '.sk-sheet .sk-field-hint')), `${id}: 규칙 설명`);
    }
    await t.shot('practice-sheet');
    await page.clickText(seg('규칙'), RULESETS.knife.name);
    await page.clickText(seg('모드'), '팀전');
    const teamCounts = await page.eval(`[...document.querySelectorAll('.sk-seg[aria-label="인원"] .sk-seg-btn')].map((b) => b.textContent)`);
    t.check(teamCounts.join() === '1 vs 1,2 vs 2,3 vs 3,4 vs 4', '팀전 인원 선택', teamCounts);
    await page.clickText(seg('모드'), '개인전');
    const ffaCounts = await page.eval(`[...document.querySelectorAll('.sk-seg[aria-label="인원"] .sk-seg-btn')].length`);
    t.check(ffaCounts === 7, '개인전 봇 수 선택 7칸', ffaCounts);
    await page.clickText(seg('모드'), '팀전');
    await page.clickText(seg('인원'), '1 vs 1');
    await page.clickText(seg('난이도'), '쉬움');
    await page.clickText('.sk-mapcards .sk-mapcard', '벚꽃 도장');
    await page.clickText('.sk-sheet-foot .sk-btn', '취소');
    await page.waitFor('!document.querySelector(".sk-sheet")', 2000, { label: '시트 닫힘' });
    t.check(await page.eval('__qa.ctx.screen === "menu"'), '취소하면 메뉴에 남는다');

    await page.clickText('.sk-menu-btn--wide', '연습장');
    await page.waitFor('!!document.querySelector(".sk-sheet")', 3000, { label: '설정 시트' });
    await page.clickText(seg('규칙'), RULESETS.knife.name);
    await page.clickText(seg('모드'), '팀전');
    await page.clickText(seg('인원'), '1 vs 1');
    await page.clickText(seg('난이도'), '쉬움');
    await page.clickText('.sk-mapcards .sk-mapcard', '벚꽃 도장');
    await page.clickText('.sk-sheet-foot .sk-btn', '출격');
    await waitRun(page);
    const started = await page.eval(`(() => { const o = __qa.run.opts; return { mapId: o.mapId, mode: o.mode, ruleset: o.ruleset, size: o.size, difficulty: o.difficulty, n: __qa.run.bots.length, world: __qa.world.ruleset, slots: __qa.arsenal.getAllowedSlots() }; })()`);
    t.check(started.mapId === 'dojo' && started.mode === 'team' && started.ruleset === 'knife' && started.size === 1 && started.difficulty === 'easy' && started.n === 1, '시트에서 고른 대로 시작한다', started);
    t.check(started.world === 'knife' && started.slots.join() === '3', '칼전은 칼 슬롯만 쓴다', started);
    await page.waitFor('__qa.run.phase === "live"', 15000, { label: 'live 단계' });
    await leaveToMenu(t, page);
    const label = await textOf(page, '.sk-menu-btn--main .sk-menu-sub');
    t.check(/벚꽃 도장 · 팀전 · 1 vs 1/.test(label), '빠른 시작 문구가 지난 설정을 따른다', label);
    await page.click('.sk-menu-btn--main');
    await waitRun(page);
    const again = await page.eval(`(() => { const o = __qa.run.opts; return { mapId: o.mapId, mode: o.mode, ruleset: o.ruleset, size: o.size, difficulty: o.difficulty, n: __qa.run.bots.length }; })()`);
    t.check(again.mapId === 'dojo' && again.mode === 'team' && again.ruleset === 'knife' && again.size === 1 && again.n === 1, '빠른 시작이 지난 설정으로 시작한다', again);
    await page.waitFor('__qa.run.phase === "live"', 15000, { label: 'live 단계' });
    await leaveToMenu(t, page);
    t.errorsOk('연습장 시트');

    t.setSection('상점: 이모트 휠');
    page = await openGame(t, '', { profile: { nickname: NICK, points: 1000, createdAt: 1 }, settings: LOW_QUALITY, screen: 'menu' });
    await page.waitFor('__qa.ui.isVisible("menu")', 5000, { label: '메뉴' });
    await page.clickText('.sk-menu-btn--sub', '상점');
    await page.waitFor('__qa.ui.isVisible("shop")', 3000, { label: '상점' });
    await page.clickText('.sk-shop .sk-tab', '이모트');
    const emo = (id) => `.sk-emo-card[aria-label="${id}"]`;
    const chipNames = () => page.eval(`[...document.querySelectorAll('.sk-emo-slot .sk-emo-slot-name')].map((n) => n.textContent)`);
    const first = await chipNames();
    t.check(first.join() === 'L을 가져가,야채,크림치즈 허니,크리스 크로스,탱고,경례,손 흔들기,환호 박수', '처음 휠 8칸', first);
    t.check((await page.eval(`document.querySelectorAll('.sk-emo-card').length`)) === 11, '이모트 카드 11장');
    for (const name of ['L을 가져가', '야채', '크림치즈 허니']) {
      t.check(await page.eval(`!!document.querySelector('${emo(name)} .sk-emo-free')`), `${name}: 기본 지급 표시`);
    }
    t.check((await textOf(page, `${emo('당신에게서')} .sk-shop-action`)) === '구매 600 P', '당신에게서 600 P', await textOf(page, `${emo('당신에게서')} .sk-shop-action`));
    t.check((await textOf(page, `${emo('셀카')} .sk-shop-action`)) === '구매 400 P', '셀카 400 P');
    await page.click(`${emo('셀카')} .sk-shop-action`);
    await page.waitFor(`document.querySelector('.sk-shop .sk-points-val').textContent === '600 P'`, 2000, { label: '셀카 구매' });
    t.check((await textOf(page, `${emo('셀카')} .sk-shop-action`)) === '1번 칸에 넣기', '산 이모트는 고른 칸에 넣는 버튼', await textOf(page, `${emo('셀카')} .sk-shop-action`));
    t.check((await textOf(page, `${emo('당신에게서')} .sk-shop-need`)) === '', '600 P 남으면 당신에게서도 살 수 있다');
    await page.clickText('.sk-emo-slot', '경례');
    t.check(await page.eval(`document.querySelectorAll('.sk-emo-slot')[5].classList.contains('is-on')`), '6번 칸을 고른다');
    t.check((await textOf(page, `${emo('셀카')} .sk-shop-action`)) === '6번 칸에 넣기', '버튼이 고른 칸을 따른다');
    await page.click(`${emo('셀카')} .sk-shop-action`);
    t.check((await chipNames())[5] === '셀카', '6번 칸이 셀카로 바뀐다', await chipNames());
    t.check((await textOf(page, `${emo('셀카')} .sk-shop-state`)) === '휠 6번', '카드에 휠 칸 표시');
    t.check((await textOf(page, `${emo('경례')} .sk-shop-state`)) === '보유', '빠진 이모트는 보유로 남는다');
    await page.click('.sk-emo-slot');
    await page.click(`${emo('환호 박수')} .sk-shop-action`);
    const swapped = await page.eval('__qa.profile().loadout.emotes');
    t.check(swapped[0] === 'cheer' && swapped[7] === 'takeL' && swapped[5] === 'selfie', '이미 휠에 있는 이모트는 칸을 맞바꾼다', swapped);
    t.check(/바꿨어요/.test(await textOf(page, '.sk-shop-note')), '맞바꿈 안내', await textOf(page, '.sk-shop-note'));
    await t.shot('shop-emotes');

    // 미리 듣기와 음원 묶음: 클릭이 오디오를 켜고 묶음 6개를 풀어 디코드한다
    await page.click(`${emo('셀카')} .sk-emo-preview`);
    await page.waitFor('__qa.world.internals.audio.getStats().emoteFiles.length === 6', 8000, { label: '음원 묶음 6개' });
    const files = await page.eval('__qa.world.internals.audio.getStats().emoteFiles.slice().sort()');
    t.check(files.join() === 'creamCheese,crissCross,fromYou,selfie,takeL,veggie', '묶음 6개를 읽는다', files);
    await page.waitFor('__qa.world.internals.audio.getStats().emoteVoices2d >= 1', 3000, { label: '미리 듣기 재생' });
    const src = await page.eval(`(() => { const a = __qa.world.internals.audio; const h = a.emote('takeL'), s = a.emote('sideToSide'); const r = [h.source, s.source]; h.stop(10); s.stop(10); return r; })()`);
    t.check(src[0] === 'file' && src[1] === 'synth', '묶음이 있는 이모트는 파일, 나머지는 합성음', src);
    await page.click('.sk-shop .sk-btn--ghost');
    await page.waitFor('__qa.ui.isVisible("menu")', 3000, { label: '메뉴로 돌아옴' });
    await page.waitFor('__qa.world.internals.audio.getStats().emoteVoices2d === 0', 3000, { label: '상점을 나가면 미리 듣기가 멈춘다' });

    // 경기 휠이 장착한 순서를 따른다
    await page.reload();
    await readyGame(page, { screen: 'menu' });
    t.check((await page.eval('__qa.profile().loadout.emotes'))[0] === 'cheer', '새로고침 뒤에도 휠 유지');
    await page.click('.sk-menu-btn--main');
    await waitRun(page);
    await page.waitFor('__qa.run.phase === "live" && !__qa.ui.isVisible("loadout")', 20000, { label: 'live 단계' });
    await lockPointer(page);
    t.check((await page.eval('__qa.ctx.input.emoteWheelIds')).join() === swapped.join(), '입력의 휠 = 계정 휠', await page.eval('__qa.ctx.input.emoteWheelIds'));
    await page.mouseMove(400, 225);
    await waitTicks(page, 3);
    await page.key('KeyB', 'down');
    await page.waitFor('__qa.ui.isVisible("emotes")', 2000, { label: 'B 이모트 휠' });
    await page.mouseMove(400, 125);
    await page.waitFor('__qa.ctx.input.emoteWheel.selected === 0', 3000, { label: '12시 칸 강조' });
    await waitTicks(page, 3);
    t.check((await page.eval(`__qa.text('.sk-emo-hub-name')`)) === '환호 박수', '휠 1번 칸이 장착한 이모트다', await page.eval(`__qa.text('.sk-emo-hub-name')`));
    await page.key('KeyB', 'up');
    await page.waitFor('__qa.ctx.player.state.emoteId === "cheer"', 2000, { label: '고른 이모트 시작' });
    await leaveToMenu(t, page);
    t.errorsOk('이모트 휠');
  }
};
