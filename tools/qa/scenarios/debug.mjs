/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 시나리오 8. 디버그 도구(F3 패널, F4 판정 선, F6 충돌체 선)와 dev/ 데모 페이지 네 개가 /skala-fps/ 아래에서 오류 없이 도는지 본다.
 */
import { LOW_QUALITY, lockPointer, openGame, qaInit, richProfile, sleep, waitLive, waitRun, waitTicks } from '../kit.mjs';

/** 페이지에서: 보이는 버튼 목록. 위험한 것(페이지를 떠나는 링크 등)은 없다 */
function visibleButtons(selector) {
  return [...document.querySelectorAll(selector)].filter((b) => { const r = b.getBoundingClientRect(); return !b.disabled && r.width > 0 && r.height > 0; }).map((b) => (b.id ? `#${b.id}` : null));
}

export default {
  name: 'debug',
  title: '?debug=1 패널과 F3·F4·F6, dev 데모 페이지',
  timeoutMs: 6 * 60 * 1000,
  async run(t) {
    t.setSection('F3 패널');
    let page = await openGame(t, 'sandbox=nexus&ruleset=classic&mode=ffa&bots=1&killtarget=50', { profile: richProfile(), settings: LOW_QUALITY, width: 960, height: 540, screen: 'sandbox' });
    await waitRun(page);
    await page.eval('__qa.freezeBots()');
    await waitLive(page);
    await page.waitFor('!__qa.ui.isVisible("loadout")', 8000, { label: '무기 선택 닫힘' });
    await lockPointer(page);
    await page.waitFor(`__qa.ctx.plugins.some((p) => p.name === 'debug')`, 5000, { label: '디버그 도구 로드' });
    t.check(await page.eval('Array.isArray(__qa.ctx.logs)'), '__skalafps.logs가 있다');
    t.check(!(await page.eval(`!!document.querySelector('.skala-debug-panel')`)), '처음에는 패널이 없다');
    await page.press('F3');
    await page.waitFor(`!!document.querySelector('.skala-debug-panel')`, 2000, { label: 'F3 패널' });
    await sleep(600);
    const text = await page.eval(`document.querySelector('.skala-debug-panel pre').textContent`);
    for (const label of ['fps', 'draw', 'pos', 'vel', 'state', 'weapon', 'map', 'rules', 'aim', 'trigger']) t.check(new RegExp(`^${label}\\s`, 'm').test(text), `패널의 ${label} 줄`, text);
    t.check(!/읽기 실패/.test(text), '패널에 읽기 실패가 없다', text);
    t.check(/ar_std/.test(text) && /nexus/.test(text) && /classic/.test(text), '패널 내용이 지금 상태를 보여 준다', text);
    await t.shot('f3-panel');

    t.setSection('F4 판정 선');
    await page.press('F4');
    await page.waitFor(`!!__qa.ctx.renderer.scene.getObjectByName('debug:hit-volumes')`, 2000, { label: 'F4 선' });
    await sleep(500);
    const hit = await page.eval(`(() => { const o = __qa.ctx.renderer.scene.getObjectByName('debug:hit-volumes'); return { draw: o.geometry.drawRange.count, n: __qa.ctx.getTargets().length }; })()`);
    t.check(hit.draw > 0 && hit.n >= 1, 'F4가 대상의 부위 선을 그린다', hit);
    t.check(/F4 판정 켬\(대상 \d+\)/.test(await page.eval(`document.querySelector('.skala-debug-panel pre').textContent`)), '패널에 F4 상태가 보인다');
    await t.shot('f4-hit-volumes');

    t.setSection('F6 충돌체 선');
    await page.press('F6');
    await page.waitFor(`!!__qa.ctx.renderer.scene.getObjectByName('debug:colliders')`, 3000, { label: 'F6 선' });
    await sleep(500);
    const wire = await page.eval(`(() => { const o = __qa.ctx.renderer.scene.getObjectByName('debug:colliders'); return { verts: o.geometry.attributes.position.count }; })()`);
    t.check(wire.verts > 100, 'F6이 충돌체 선을 그린다', wire);
    const wireText = await page.eval(`document.querySelector('.skala-debug-panel pre').textContent`);
    t.check(/^wire\s/m.test(wireText) && /pad [1-9]/.test(wireText) && /portal [1-9]/.test(wireText) && /secret [1-9]/.test(wireText), '패널에 충돌체 수가 보인다', wireText);
    await t.shot('f6-colliders');

    t.setSection('맵을 바꿔도 디버그 도구가 따라간다');
    await page.eval(`__qa.ctx.setScreen('menu')`);
    await page.waitFor(`__qa.ctx.screen === 'menu'`, 10000, { label: '메뉴' });
    await sleep(300);
    t.check(!(await page.eval(`!!__qa.ctx.renderer.scene.getObjectByName('debug:colliders')`)), '맵을 치우면 충돌체 선도 사라진다');
    await page.eval(`__qa.ctx.setScreen('sandbox', { mapId: 'alley', mode: 'ffa', ruleset: 'classic', bots: 1 })`);
    await waitRun(page);
    await page.waitFor(`!!__qa.ctx.renderer.scene.getObjectByName('debug:colliders')`, 8000, { label: '새 맵 충돌체 선' });
    await waitLive(page);
    await page.waitFor('!__qa.ui.isVisible("loadout")', 8000, { label: '무기 선택 닫힘' });
    await lockPointer(page);

    t.setSection('끄기');
    await page.press('F3');
    await page.press('F4');
    await page.press('F6');
    await page.waitFor(`!document.querySelector('.skala-debug-panel') && !__qa.ctx.renderer.scene.getObjectByName('debug:hit-volumes') && !__qa.ctx.renderer.scene.getObjectByName('debug:colliders')`, 2000, { label: '모두 꺼짐' });
    await waitTicks(page, 10);
    t.errorsOk('디버그 키');

    t.setSection('?debug 없이는 꺼져 있다');
    page = await t.newPage();
    await page.open(`${t.base}?sandbox=alley&mode=ffa&bots=1&autoplay=1`, { width: 640, height: 360, clean: true, initScript: qaInit({ profile: richProfile(), settings: LOW_QUALITY }) });
    await page.waitFor(`!!document.querySelector('.sk-hud') && !document.querySelector('.sk-hud').hidden`, 30000, { label: 'HUD' });
    t.check(await page.eval('typeof window.__skalafps === "undefined"'), '__skalafps가 없다');
    await page.press('F3');
    await page.press('F4');
    await page.press('F6');
    await sleep(300);
    t.check(!(await page.eval(`!!document.querySelector('.skala-debug-panel')`)), 'F3을 눌러도 패널이 없다');
    t.errorsOk('디버그 없음');

    t.setSection('?log·?logns 플래그');
    page = await openGame(t, 'sandbox=alley&mode=ffa&bots=1&log=debug&logns=props', { profile: richProfile(), settings: LOW_QUALITY, width: 480, height: 270, screen: 'sandbox' });
    await waitRun(page);
    await sleep(500);
    const logs = await page.eval(`__qa.ctx.logs.map((l) => [l.level, l.ns])`);
    t.check(logs.every(([level, ns]) => ns === 'props' || level === 'error'), 'logns에 적은 이름표만 남는다', logs.slice(0, 8));
    t.errorsOk('로그 플래그');

    t.setSection('dev/ui-demo.html');
    page = await t.newPage();
    const screens = ['menu', 'menu-account', 'settings', 'controls', 'lobby', 'lobby-empty', 'lobby-loading', 'lobby-error', 'create', 'room', 'room-guest', 'loadout', 'hud', 'hud-low', 'scope', 'scoreboard', 'results', 'pause', 'create-ffa', 'room-ffa', 'room-ffa-guest', 'loadout-ffa', 'hud-ffa', 'respawn', 'scoreboard-ffa', 'results-ffa', 'emotes-idle', 'emotes', 'emote-active',
      'create-bomb', 'room-bomb', 'hud-bomb', 'hud-bomb-plant', 'scoreboard-bomb', 'results-bomb'];
    for (const screen of screens) {
      await page.open(`${t.base}dev/ui-demo.html?screen=${screen}`, { width: 960, height: 540 });
      await page.waitFor(`document.querySelector('.sk-ui') && document.querySelector('.sk-ui').children.length > 0`, 15000, { label: `ui-demo ${screen}` });
      await sleep(120);
      t.errorsOk(`ui-demo ${screen}`);
    }
    await t.shot('ui-demo');

    t.setSection('dev/fx-demo.html?smoke=1');
    page = await t.newPage();
    await page.open(`${t.base}dev/fx-demo.html?smoke=1`, { width: 640, height: 360 });
    await page.waitFor('!!window.__fxSmoke', 120000, { intervalMs: 300, label: 'fx 스모크 테스트' });
    const smoke = await page.eval('window.__fxSmoke');
    const failed = (smoke.checks || []).filter((c) => !c.ok);
    t.check(smoke.ok === true, 'fx 스모크 테스트 통과', failed);
    t.log(`   fx 스모크 검사 ${(smoke.checks || []).length}개, 실패 ${failed.length}개`);
    await t.shot('fx-demo');
    t.errorsOk('fx-demo');

    t.setSection('dev/viewmodel-demo.html');
    page = await t.newPage();
    await page.open(`${t.base}dev/viewmodel-demo.html`, { width: 640, height: 360 });
    await page.waitFor(`document.querySelectorAll('#weapons button').length > 0`, 30000, { label: '뷰모델 데모' });
    const weaponCount = await page.eval(`document.querySelectorAll('#weapons button').length`);
    t.check(weaponCount >= 16, '무기 버튼이 모두 있다', weaponCount);
    for (let i = 0; i < weaponCount; i++) {
      await page.click(`#weapons button:nth-child(${i + 1})`);
      await sleep(60);
    }
    const actions = await page.eval(`document.querySelectorAll('#actions button').length`);
    for (let i = 0; i < actions; i++) {
      await page.click(`#actions button:nth-child(${i + 1})`);
      await sleep(40);
    }
    const views = await page.eval(`document.querySelectorAll('#views button').length`);
    for (let i = 0; i < views; i++) {
      await page.click(`#views button:nth-child(${i + 1})`);
      await sleep(60);
    }
    t.check((await page.eval(`document.querySelector('#err').textContent`)) === '', '데모 오류 칸이 비어 있다', await page.eval(`document.querySelector('#err').textContent`));
    await t.shot('viewmodel-demo');
    t.errorsOk('viewmodel-demo');

    t.setSection('dev/props-demo.html');
    page = await t.newPage();
    await page.open(`${t.base}dev/props-demo.html`, { width: 640, height: 360 });
    await page.waitFor(`document.querySelector('#stats').textContent.length > 0`, 30000, { label: '소품 데모' });
    await page.waitFor(`/physics/.test(document.querySelector('#stats').textContent)`, 30000, { label: '소품 데모 cannon-es' });
    for (const id of await page.fn(visibleButtons, '#panel button')) {
      if (!id) continue;
      await page.click(id);
      await sleep(150);
    }
    await sleep(500);
    await t.shot('props-demo');
    t.errorsOk('props-demo');
  }
};
