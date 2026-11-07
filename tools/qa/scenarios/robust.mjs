/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 시나리오 12. 어긋난 상황을 검사한다. 깨진 저장값, 이상한 URL 플래그, 없는 맵, 플러그인 없는 core 모드, 맵을 오갈 때의 메모리 누수, 창 크기 변경, 맵 밖 낙하, 팀전 관전, 무기 선택 숫자키.
 */
import { LOW_QUALITY, NICK, lockPointer, openGame, qaInit, readyGame, richProfile, sleep, waitLive, waitRun, waitTicks } from '../kit.mjs';

const memory = (page) => page.eval(`(() => { const r = __qa.ctx.renderer.three.info; return { geometries: r.memory.geometries, textures: r.memory.textures, programs: r.programs.length }; })()`);

export default {
  name: 'robust',
  title: '깨진 저장값, 이상한 URL, 없는 맵, core 모드, 메모리 누수, 창 크기, 낙하, 관전',
  timeoutMs: 8 * 60 * 1000,
  async run(t) {
    t.setSection('깨진 저장값');
    let page = await t.newPage();
    const broken = `localStorage.getItem('skalafps.qa.seed') || (localStorage.setItem('skalafps.qa.seed', '1'),
      localStorage.setItem('skalafps.profile.v1', '{깨진 json'),
      localStorage.setItem('skalafps.settings.v1', '[1,2'),
      localStorage.setItem('skalafps.practice.v1', 'null,'),
      localStorage.setItem('skalafps.token', 'not-a-token'));\n${qaInit()}`;
    await page.open(`${t.base}?debug=1`, { width: 640, height: 360, clean: true, initScript: broken });
    await page.waitFor(`!!document.querySelector('.sk-nick') && !document.querySelector('.sk-nick').hidden`, 30000, { label: '깨진 프로필이면 처음처럼 게이트' });
    t.check((await page.eval(`__qa.ctx.account.profile.points`)) === 500, '깨진 프로필은 기본값으로 시작한다');
    t.errorsOk('깨진 저장값');

    const oddProfile = { nickname: 'a', points: -50, owned: ['없는무기', 42], loadout: { primary: 'ml_knife', secondary: 'zzz', melee: null }, stats: { kills: 'many', deaths: -1 }, secrets: { alley: 3, __proto__: {} }, createdAt: 'x' };
    page = await t.newPage();
    await page.open(`${t.base}?debug=1`, { width: 640, height: 360, clean: true, initScript: qaInit({ profile: oddProfile, settings: { sensitivity: 'fast', fov: 9999, quality: 'ultra', zoomMode: 3, volume: -1 } }) });
    await readyGame(page, { screen: 'menu' });
    const fixed = await page.eval(`({ p: __qa.profile(), fov: __qa.ctx.renderer.baseFov, sens: __qa.ctx.settings.get('sensitivity'), zoom: __qa.ctx.settings.get('zoomMode'), vol: __qa.ctx.settings.get('volume') })`);
    t.check(fixed.p.points === 0, '음수 포인트를 바로잡는다', fixed.p.points);
    t.check(fixed.p.loadout.primary === 'ar_std' && fixed.p.loadout.secondary === 'pt_std' && fixed.p.loadout.melee === 'ml_katana', '틀린 장비를 기본값으로 바꾼다', fixed.p.loadout);
    t.check(fixed.p.stats.kills === 0 && fixed.p.stats.deaths === 0, '틀린 전적을 0으로 바꾼다', fixed.p.stats);
    t.check(fixed.fov === 100 && fixed.sens === 1 && fixed.zoom === 'hold' && fixed.vol === 0, '틀린 설정을 바로잡는다', fixed);
    t.errorsOk('틀린 값');

    t.setSection('없는 맵과 이상한 URL');
    const cases = [
      ['sandbox=없는맵&mode=ffa&bots=1', { map: 'testyard' }],
      ['sandbox=testyard&mode=ffa&bots=1', { map: 'testyard' }],
      ['sandbox=alley&mode=이상함&ruleset=이상함&bots=99&killtarget=1&timescale=100&difficulty=이상함&botweapon=없는무기', { map: 'alley', mode: 'team', ruleset: 'classic', ts: 8, size: 4, target: 5, diff: 'normal' }],
      ['sandbox=alley&mode=ffa&ruleset=knife&bots=-3&killtarget=999&timescale=0', { map: 'alley', mode: 'ffa', ruleset: 'knife', bots: 1, ts: 1, target: 50 }],
      ['sandbox=alley&mode=ffa&ruleset=classic&bots=1&botweapon=ml_knife', { map: 'alley', mode: 'ffa', ruleset: 'classic', botPrimaryOk: true }]
    ];
    for (const [q, want] of cases) {
      page = await openGame(t, q, { settings: LOW_QUALITY, width: 480, height: 270, screen: 'sandbox', clean: true, reusePage: true });
      await waitRun(page);
      const got = await page.eval(`(() => { const o = __qa.run.opts; return { map: __qa.ctx.map.id, mode: o.mode, ruleset: o.ruleset, ts: o.timeScale, size: o.size, bots: o.ffaBots, target: o.killTarget, diff: o.difficulty, picks: __qa.run.bots.map((b) => b.pick) }; })()`);
      for (const k of Object.keys(want)) if (k !== 'botPrimaryOk') t.check(got[k] === want[k], `${q}: ${k}`, got);
      await waitTicks(page, 20);
      t.errorsOk(q, { allow: [/\[practice\] 맵/] });
    }

    t.setSection('core 모드(?plugins=0)');
    page = await t.newPage();
    await page.open(`${t.base}?plugins=0&debug=1`, { width: 640, height: 360, clean: true, initScript: qaInit({ settings: LOW_QUALITY }) });
    await page.waitFor(`window.__qa && __qa.ctx && __qa.ctx.screen === 'menu'`, 30000, { label: 'core 메뉴' });
    t.check(await page.eval(`__qa.ctx.plugins.every((p) => p.name === 'debug') && !__qa.ctx.provided.has('menu')`), '플러그인이 꺼진다');
    await t.shot('core-menu');
    await page.eval(`__qa.ctx.setScreen('sandbox', { mapId: 'alley' })`);
    await page.waitFor(`__qa.ctx.screen === 'sandbox' && !!__qa.ctx.map`, 20000, { label: 'core 연습장' });
    await page.click('.core-overlay .core-btn.primary');
    await page.waitFor('__qa.ctx.input.locked', 5000, { label: 'core 포인터 잠금' });
    t.check(await page.eval('!!__qa.ctx.devgun'), 'core 모드에서는 임시 총을 쓴다');
    await page.key('KeyW', 'down');
    await sleep(300);
    await page.key('KeyW', 'up');
    await page.mouseDown(0);
    await sleep(200);
    await page.mouseUp(0);
    t.check(await page.eval('__qa.ctx.player.state.pos[0] !== __qa.ctx.player.spawnPoint.x || __qa.ctx.player.state.pos[2] !== __qa.ctx.player.spawnPoint.z'), 'core 모드에서도 움직인다');
    await t.shot('core-sandbox');
    await page.eval(`__qa.ctx.setScreen('menu')`);
    await page.waitFor(`__qa.ctx.screen === 'menu'`, 8000, { label: 'core 메뉴로' });
    t.errorsOk('core 모드');

    t.setSection('맵을 오가도 메모리가 늘지 않는다');
    page = await openGame(t, '', { profile: { nickname: NICK, createdAt: 1 }, settings: LOW_QUALITY, width: 480, height: 270, screen: 'menu' });
    const cycle = async (mapId) => {
      await page.eval(`__qa.ctx.setScreen('sandbox', { mapId: ${JSON.stringify(mapId)}, mode: 'ffa', ruleset: 'classic', bots: 2 })`);
      await waitRun(page);
      await waitLive(page);
      await waitTicks(page, 20);
      await page.eval(`__qa.ctx.setScreen('menu')`);
      await page.waitFor(`__qa.ctx.screen === 'menu'`, 10000, { label: '메뉴로' });
      await sleep(200);
    };
    for (const id of ['alley', 'nexus']) await cycle(id);
    const m1 = await memory(page);
    for (const id of ['alley', 'nexus', 'alley', 'nexus']) await cycle(id);
    const m2 = await memory(page);
    t.log(`   메모리 처음 ${JSON.stringify(m1)} → 나중 ${JSON.stringify(m2)}`);
    t.check(m2.geometries <= m1.geometries + 2, '지오메트리가 늘지 않는다', { m1, m2 });
    t.check(m2.textures <= m1.textures + 2, '텍스처가 늘지 않는다', { m1, m2 });
    t.check(m2.programs <= m1.programs + 2, '셰이더 프로그램이 늘지 않는다', { m1, m2 });
    t.errorsOk('맵 전환');

    t.setSection('장착한 무기가 경기에 들어간다');
    const gear = [
      ['classic', 'alley', { primary: 'ar_rapid', secondary: 'pt_magnum', melee: 'ml_knife' }, 1, 'ar_rapid'],
      ['knife', 'dojo', { primary: 'ar_rapid', secondary: 'pt_magnum', melee: 'ml_knife' }, 3, 'ml_knife'],
      ['sniper', 'longshot', { primary: 'sr_twin', secondary: 'pt_std', melee: 'ml_katana' }, 1, 'sr_twin'],
      ['sniper', 'longshot', { primary: 'ar_rapid', secondary: 'pt_std', melee: 'ml_katana' }, 1, 'sr_bolt']
    ];
    for (const [ruleset, mapId, loadout, slot, want] of gear) {
      page = await openGame(t, `sandbox=${mapId}&ruleset=${ruleset}&mode=ffa&bots=1`, { profile: richProfile({ loadout }), settings: LOW_QUALITY, width: 480, height: 270, screen: 'sandbox', reusePage: true });
      await waitRun(page);
      await waitLive(page);
      const got = await page.eval('({ held: __qa.arsenal.getWeapon(), lo: __qa.arsenal.getLoadout() })');
      t.check(got.held.slot === slot && got.held.id === want, `${ruleset}: 장비 ${JSON.stringify(loadout)}이면 ${want}를 든다`, got.lo);
      if (ruleset === 'classic') t.check(got.lo.primary === 'ar_rapid' && got.lo.secondary === 'pt_magnum' && got.lo.melee === 'ml_knife', '클래식은 세 칸이 모두 장비대로다', got.lo);
      t.errorsOk(`${ruleset} 장비`);
    }

    t.setSection('아무도 싸우지 않은 경기');
    // 경기 시계만 빠르게 돌려(봇은 멈춰 있다) 시간 종료와 무승부 경로를 본다
    const fastClock = () => { const m = window.__qa.run.match, tick = m.tick; m.tick = (ms) => tick.call(m, ms * 30); };
    page = await openGame(t, 'sandbox=alley&ruleset=classic&mode=team&bots=1', { profile: { nickname: NICK, points: 100, createdAt: 1 }, settings: LOW_QUALITY, width: 480, height: 270, screen: 'sandbox', reusePage: true });
    await waitRun(page);
    await page.eval('__qa.freezeBots()');
    await page.fn(fastClock);
    await page.waitFor('__qa.ui.isVisible("results")', 60000, { intervalMs: 200, label: '팀전 무승부 결과' });
    const draw = await page.eval(`({ p: __qa.profile(), winner: document.querySelector('.sk-results').dataset.winner, title: __qa.text('.sk-res-title'), verdict: __qa.text('.sk-res-verdict'), rounds: document.querySelectorAll('.sk-res-round').length, end: __qa.match.filter((e) => e.type === 'matchEnd').pop() })`);
    t.log(`   팀전 무승부: ${JSON.stringify({ winner: draw.winner, title: draw.title, rounds: draw.rounds, reason: draw.end && draw.end.reason })}`);
    t.check(draw.winner === 'draw' && draw.title === '무승부', '팀전 무승부 결과 화면', draw);
    t.check(draw.p.stats.matches === 1 && draw.p.stats.draws === 1 && draw.p.stats.wins === 0, '무승부 전적', draw.p.stats);
    t.check(draw.p.points === 110, '무승부도 완주 보상을 받는다', draw.p.points);
    t.check(draw.rounds >= 1, '라운드 기록이 있다', draw.rounds);
    await t.shot('team-draw');
    t.errorsOk('팀전 무승부');

    page = await openGame(t, 'sandbox=alley&ruleset=classic&mode=ffa&bots=1', { profile: { nickname: NICK, points: 100, createdAt: 1 }, settings: LOW_QUALITY, width: 480, height: 270, screen: 'sandbox', reusePage: true });
    await waitRun(page);
    await page.eval('__qa.freezeBots()');
    await page.fn(fastClock);
    await page.waitFor('__qa.ui.isVisible("results")', 60000, { intervalMs: 200, label: '개인전 무승부 결과' });
    const ffaDraw = await page.eval(`({ p: __qa.profile(), winner: document.querySelector('.sk-results').dataset.winner, title: __qa.text('.sk-res-title'), score: __qa.text('.sk-res-score'), end: __qa.match.filter((e) => e.type === 'matchEnd').pop() })`);
    t.log(`   개인전 무승부: ${JSON.stringify({ winner: ffaDraw.winner, title: ffaDraw.title, score: ffaDraw.score, reason: ffaDraw.end && ffaDraw.end.reason })}`);
    t.check(ffaDraw.title === '무승부' && ffaDraw.winner === 'draw', '개인전 무승부 결과 화면', ffaDraw);
    t.check(ffaDraw.p.stats.matches === 1 && ffaDraw.p.stats.draws === 1, '개인전 무승부 전적', ffaDraw.p.stats);
    t.errorsOk('개인전 무승부');

    t.setSection('연타와 빠른 전환');
    page = await openGame(t, '', { profile: { nickname: NICK, createdAt: 1 }, settings: LOW_QUALITY, width: 480, height: 270, screen: 'menu', reusePage: true });
    await page.waitFor('__qa.ui.isVisible("menu")', 5000, { label: '메뉴' });
    await page.eval(`(() => { const b = document.querySelector('.sk-menu-btn--main'); b.click(); b.click(); b.click(); })()`);
    await waitRun(page);
    await sleep(1500);
    await waitRun(page);
    t.check(await page.eval('__qa.ctx.getTargets().length === __qa.run.bots.filter((b) => b.alive).length || __qa.run.phase !== "live"'), '빠른 시작을 연타해도 경기는 하나다');
    await waitLive(page);
    t.check(await page.eval(`__qa.ctx.renderer.scene.children.filter((c) => c.name === 'props').length <= 1`), '소품 묶음이 겹치지 않는다');
    await page.eval(`(() => { __qa.ctx.setScreen('menu'); __qa.ctx.setScreen('sandbox', { mapId: 'nexus', mode: 'ffa', ruleset: 'classic', bots: 1 }); __qa.ctx.setScreen('menu'); })()`);
    await page.waitFor('__qa.ctx.screen === "menu" && __qa.ui.isVisible("menu")', 20000, { label: '전환 연타 뒤 메뉴' });
    await sleep(500);
    t.check(await page.eval('!__qa.ctx.map && !__qa.ctx.rendering && !__qa.run'), '전환을 연타해도 맵이 남지 않는다');
    await page.eval(`__qa.ctx.setScreen('sandbox', { mapId: 'alley', mode: 'ffa', ruleset: 'classic', bots: 1 })`);
    await waitRun(page);
    await page.eval(`__qa.ctx.setScreen('sandbox', { mapId: 'nexus', mode: 'team', ruleset: 'sniper', size: 1 })`);
    await page.waitFor(`__qa.ctx.map && __qa.ctx.map.id === 'nexus' && !!__qa.run && __qa.run.opts.mapId === 'nexus'`, 20000, { label: '경기 중 바로 다른 맵' });
    t.check(await page.eval(`__qa.world.ruleset === 'sniper' && __qa.world.mode === 'team' && __qa.run.bots.length === 1`), '새 경기 설정이 적용된다');
    await page.eval(`__qa.ctx.setScreen('menu')`);
    await page.waitFor('__qa.ctx.screen === "menu"', 10000, { label: '메뉴' });
    t.errorsOk('연타');

    t.setSection('경기를 바꿔도 앞 경기 상태가 남지 않는다');
    const startIn = async (o) => {
      await page.fn((x) => window.__qa.ctx.setScreen('sandbox', x), { mode: 'ffa', bots: 1, ...o });
      await page.waitFor(`!!__qa.run && __qa.run.opts.mapId === ${JSON.stringify(o.mapId)} && __qa.run.opts.ruleset === ${JSON.stringify(o.ruleset)}`, 20000, { label: `${o.mapId} 시작` });
      await page.eval('__qa.hookRun(); __qa.freezeBots()');
      await waitLive(page);
      await page.waitFor('!__qa.ui.isVisible("loadout")', 8000, { label: '무기 선택 닫힘' });
      await lockPointer(page);
      await waitTicks(page, 3);
    };
    const hudSlots = () => page.eval(`[...document.querySelectorAll('.sk-slots .sk-slot')].map((e) => !e.hidden)`);
    const toMenu = async () => {
      await page.eval(`__qa.ctx.setScreen('menu')`);
      await page.waitFor('__qa.ctx.screen === "menu"', 10000, { label: '메뉴' });
    };
    await startIn({ mapId: 'longshot', ruleset: 'sniper' });
    t.check(JSON.stringify(await hudSlots()) === JSON.stringify([true, false, true, false]), '스나전 HUD 칸', await hudSlots());
    // 줌을 건 채로 나가도 다음 경기의 FOV·감도·스코프가 처음 값이다
    await page.mouseDown(2);
    await page.waitFor('__qa.arsenal.getZoom().progress >= 1', 4000, { label: '줌' });
    await toMenu();
    await page.mouseUp(2);
    await startIn({ mapId: 'dojo', ruleset: 'knife' });
    const afterZoom = await page.eval(`({ fov: __qa.ctx.renderer.camera.fov, base: __qa.ctx.renderer.baseFov, look: __qa.ctx.input.getLookScale(), scope: __qa.visible('.sk-scope'), slot: __qa.arsenal.getWeapon().slot, vm: __qa.world.internals.vm.getWeaponId(), hud: [...document.querySelectorAll('.sk-slots .sk-slot')].map((e) => !e.hidden) })`);
    t.check(afterZoom.fov === afterZoom.base && afterZoom.look === 1 && !afterZoom.scope, '줌한 채 나가도 다음 경기 시야는 처음 값이다', afterZoom);
    t.check(afterZoom.slot === 3 && /^ml_/.test(afterZoom.vm), '칼전으로 바꾸면 모형도 칼이다', afterZoom);
    t.check(JSON.stringify(afterZoom.hud) === JSON.stringify([false, false, true, false]), '칼전 HUD 칸', afterZoom.hud);
    // 이모트 중에 나가도 다음 경기는 1인칭이고 쏠 수 있다
    await page.eval(`__qa.world.startEmote('takeL')`);
    await page.waitFor('__qa.ctx.player.thirdPerson > 0.5', 3000, { label: '이모트' });
    await toMenu();
    await startIn({ mapId: 'alley', ruleset: 'classic' });
    await waitTicks(page, 10);
    const afterEmote = await page.eval(`({ emote: __qa.ctx.player.state.emote, third: __qa.ctx.player.thirdPerson, lock: __qa.ctx.input.emoteLock, vm: __qa.world.internals.vm.group.visible, id: __qa.world.internals.vm.getWeaponId(), slot: __qa.arsenal.getWeapon().slot, banner: __qa.visible('.sk-emote-banner'), hud: [...document.querySelectorAll('.sk-slots .sk-slot')].map((e) => !e.hidden) })`);
    t.check(afterEmote.emote === 0 && afterEmote.third === 0 && !afterEmote.lock && afterEmote.vm && !afterEmote.banner, '이모트 중에 나가도 다음 경기는 1인칭이다', afterEmote);
    t.check(afterEmote.slot === 1 && afterEmote.id === 'ar_std', '클래식으로 돌아오면 주무기를 든다', afterEmote);
    t.check(afterEmote.hud.every(Boolean), '클래식 HUD 칸', afterEmote.hud);
    await page.eval('__qa.clearLogs()');
    await page.mouseDown(0);
    await waitTicks(page, 8);
    await page.mouseUp(0);
    t.check((await page.eval(`__qa.worldCount('fire')`)) > 0, '바로 쏠 수 있다');
    // 키를 누른 채 나가도 다음 경기에서 혼자 움직이지 않는다
    await page.key('KeyW', 'down');
    await waitTicks(page, 3);
    await toMenu();
    await page.key('KeyW', 'up');
    await startIn({ mapId: 'alley', ruleset: 'classic' });
    t.check(await page.eval('!__qa.ctx.input.state.forward && Math.hypot(__qa.ctx.player.state.vel[0], __qa.ctx.player.state.vel[2]) < 0.01'), '누르던 키가 남지 않는다');
    await toMenu();
    t.errorsOk('경기 전환');

    t.setSection('경기가 끝나는 순간 일시정지');
    await page.eval(`__qa.ctx.setScreen('sandbox', { mapId: 'alley', mode: 'ffa', ruleset: 'knife', bots: 1, killTarget: 5 })`);
    await waitRun(page);
    await page.eval('__qa.hookRun(); __qa.freezeBots()');
    await waitLive(page);
    await page.waitFor('!__qa.ui.isVisible("loadout")', 8000, { label: '무기 선택 닫힘' });
    await page.fn(fastClock);
    await page.waitFor('__qa.run.phase === "matchEnd"', 30000, { intervalMs: 50, label: '경기 끝' });
    await page.press('Escape');
    await page.waitFor('__qa.ui.isVisible("pause")', 2000, { label: '끝난 직후 일시정지' });
    await page.waitFor('__qa.ui.isVisible("results")', 8000, { label: '일시정지 중에도 결과 화면' });
    t.check(!(await page.eval('__qa.ui.isVisible("pause")')), '결과 화면이 일시정지 메뉴를 닫는다');
    await page.click('.sk-res-actions .sk-btn--primary');
    await page.waitFor('!__qa.ui.isVisible("results") && !!__qa.run && __qa.run.phase !== "matchEnd"', 5000, { label: '다시 하기' });
    await page.eval('__qa.hookRun(); __qa.freezeBots()');
    await waitLive(page);
    await page.waitFor('!__qa.ui.isVisible("loadout")', 8000, { label: '무기 선택 닫힘' });
    t.check(!(await page.eval('__qa.run.paused')), '다시 하기로 시작한 경기는 멈춰 있지 않다');
    t.check(!(await page.eval('__qa.world.paused')), '일시정지 상태가 남지 않는다');
    await page.press('Escape');
    await page.waitFor('__qa.ui.isVisible("pause")', 2000, { label: '다시 일시정지' });
    t.check(await page.eval('__qa.run.paused'), '다음 일시정지도 경기를 멈춘다');
    await page.click('.sk-pause-btns .sk-btn--primary');
    await page.waitFor('!__qa.ui.isVisible("pause")', 2000, { label: '계속하기' });
    t.check(!(await page.eval('__qa.run.paused')), '계속하면 다시 돈다');
    await toMenu();
    t.errorsOk('끝나는 순간 일시정지');

    t.setSection('페이지를 닫을 때의 정리');
    await page.eval(`window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }))`);
    await sleep(200);
    t.check(await page.eval('!__qa.ctx.loop.running'), '메뉴에서 닫으면 루프가 멈춘다');
    t.errorsOk('메뉴에서 닫기');
    page = await openGame(t, 'sandbox=nexus&ruleset=classic&mode=ffa&bots=2', { settings: LOW_QUALITY, width: 480, height: 270, screen: 'sandbox' });
    await waitRun(page);
    await waitLive(page);
    await page.eval(`window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }))`);
    await sleep(300);
    t.check(await page.eval('!__qa.ctx.loop.running'), '경기 중 닫으면 루프가 멈춘다');
    t.errorsOk('경기 중 닫기');

    t.setSection('창 크기 변경');
    page = await openGame(t, 'sandbox=alley&ruleset=classic&mode=ffa&bots=1&killtarget=50', { settings: LOW_QUALITY, width: 800, height: 450, screen: 'sandbox' });
    await waitRun(page);
    await page.eval('__qa.freezeBots(); __qa.run.bots[0].alive = false');
    await waitLive(page);
    await page.waitFor('!__qa.ui.isVisible("loadout")', 8000, { label: '무기 선택 닫힘' });
    await lockPointer(page);
    for (const [w, h] of [[480, 270], [320, 480], [960, 540]]) {
      await page.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
      await sleep(400);
      const size = await page.eval(`({ canvas: [__qa.ctx.renderer.domElement.width, __qa.ctx.renderer.domElement.height], aspect: __qa.ctx.renderer.camera.aspect, inner: [innerWidth, innerHeight] })`);
      t.check(Math.abs(size.aspect - w / h) < 0.01, `${w}x${h}: 카메라 비율`, size);
      t.check(size.canvas[0] > 0 && Math.abs(size.canvas[0] / size.canvas[1] - w / h) < 0.02, `${w}x${h}: 캔버스 크기`, size);
      await t.shot(`resize-${w}x${h}`);
    }
    t.errorsOk('창 크기');

    t.setSection('맵 밖으로 떨어지면 돌아온다');
    await page.eval('__qa.clearLogs()');
    await page.eval('__qa.teleport(__qa.ctx.player.spawnPoint.x, -100, __qa.ctx.player.spawnPoint.z)');
    await page.waitFor(`__qa.busCount('player:fell') >= 1`, 5000, { intervalMs: 30, label: '낙하 감지' });
    await waitTicks(page, 5);
    const back = await page.eval('__qa.snapshot()');
    t.check(back.pos[1] > -5 && back.hp === 100 && back.alive, '마지막 스폰으로 돌아온다', back);
    t.errorsOk('낙하');

    t.setSection('무기 선택 숫자키');
    page = await openGame(t, 'sandbox=alley&ruleset=classic&mode=team&bots=2', { profile: richProfile(), settings: LOW_QUALITY, width: 800, height: 450, screen: 'sandbox' });
    await waitRun(page);
    await page.waitFor('__qa.ui.isVisible("loadout")', 8000, { label: '무기 선택 화면' });
    const cards = await page.eval(`[...document.querySelectorAll('.sk-lo-card')].map((c) => c.title)`);
    t.check(cards.length === 11, '보유한 주무기가 모두 보인다', cards);
    await page.press('Digit2');
    await page.waitFor('!__qa.ui.isVisible("loadout")', 2000, { label: '숫자키로 선택' });
    await waitTicks(page, 2);
    t.check((await page.eval('__qa.run.lastPick')) === 'ar_rapid', '2번 키는 두 번째 무기를 고른다', await page.eval('__qa.run.lastPick'));
    t.check((await page.eval('__qa.arsenal.getWeapon().slot')) === 1, '같은 키가 무기 슬롯을 바꾸지 않는다');

    t.setSection('팀전 라운드와 관전');
    await page.eval('__qa.freezeBots()');
    await waitLive(page);
    await lockPointer(page);
    const start = await page.eval(`({ round: __qa.run.round, weapon: __qa.arsenal.getLoadout().primary, teams: __qa.run.bots.map((b) => b.team), hud: __qa.text('.sk-tc-sub') })`);
    t.check(start.round === 1 && start.weapon === 'ar_rapid', '고른 무기로 1라운드', start);
    t.check(/5판 3선승/.test(start.hud), 'HUD 라운드 표시', start);
    t.check(await page.eval('__qa.visible(".sk-ts--owner") && __qa.visible(".sk-ts--charterer")'), 'HUD 팀 점수');
    await page.fn(() => {
      const qa = window.__qa, me = qa.ctx.player.state;
      const enemy = qa.run.bots.find((b) => b.team === 'charterer');
      qa.placeBot(qa.run.bots.indexOf(enemy), me.pos[0] + 2, me.pos[1], me.pos[2], Math.atan2(2, 0));
      enemy.pitch = -0.1;
      // 탄창이 비면 다시 넣는다. 탄퍼짐 때문에 한 탄창으로 끝나지 않을 수 있다
      enemy.brain.think = (dt, view) => ({ forward: 0, strafe: 0, jump: false, walk: false, yawDelta: 0, pitchDelta: 0, fire: true, zoom: false, reload: view.self.ammo.mag === 0, slot: null });
    });
    await page.waitFor('!__qa.world.localAlive', 25000, { intervalMs: 100, label: '내가 쓰러진다' }).catch(async () => {
      // 탄이 빗나가면 판정을 직접 넣지 않고 실패로 남긴다
      t.check(false, '봇이 나를 쓰러뜨린다', await page.eval('__qa.snapshot()'));
    });
    if (await page.eval('!__qa.world.localAlive')) {
      await page.waitFor(`/관전 중/.test(__qa.text('.sk-spec') || '')`, 6000, { label: '아군 관전' });
      t.check(await page.eval(`__qa.text('.sk-spec').includes('봇')`), '아군 봇을 관전한다', await page.eval(`__qa.text('.sk-spec')`));
      await t.shot('spectate');
    }
    t.errorsOk('팀전');
  }
};
