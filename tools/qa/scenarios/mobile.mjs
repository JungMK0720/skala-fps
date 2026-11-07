/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 시나리오 7. 휴대폰 화면(가로 844x390, 터치 에뮬레이션)에서 경기를 터치로만 조작한다. 조이스틱, 시점, 두 손가락 동시 입력, 발사·조준·점프·앉기·장전·무기 칸, 일시정지, 점수판, 이모트, 죽은 뒤 총 버리기, 세로 안내.
 *          실제 휴대폰의 성능과 손맛은 재지 못한다. PC 화면에서 터치 조작이 켜지지 않는지도 함께 본다.
 */
import { LOW_QUALITY, qaInit, readyGame, richProfile, sleep, waitLive, waitRun, waitTicks } from '../kit.mjs';

const W = 844, H = 390;
const visible = (sel) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; const r = e.getBoundingClientRect(); const c = getComputedStyle(e); return r.width > 0 && r.height > 0 && c.display !== 'none' && c.visibility !== 'hidden'; })()`;

/** 페이지에서: 요소 가운데 좌표 */
const center = (page, sel) => page.eval(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);

/** 한 손가락으로 눌렀다 뗀다 */
async function tap(page, at, holdMs = 60) {
  await page.touch('touchStart', [{ id: 1, x: at.x, y: at.y }]);
  await sleep(holdMs);
  await page.touch('touchEnd', []);
  await sleep(40);
}
const tapButton = async (page, act, holdMs) => tap(page, await center(page, `.pc-tb--${act}`), holdMs);

/** 페이지에서: 서로 보이는 평지 두 곳 */
function openSpots() {
  const c = window.__qa.ctx, w = c.world, P = c.physics;
  for (let x = -30; x <= 30; x += 2) {
    for (let z = -18; z <= 18; z += 2) {
      for (const [dx, dz] of [[8, 0], [0, 8]]) {
        const bx = x + dx, bz = z + dz;
        if (P.findFloor(w, x, z) !== 0 || P.findFloor(w, bx, bz) !== 0) continue;
        if (!window.__qa.clearOfTriggers(x, z) || !window.__qa.clearOfTriggers(bx, bz)) continue;
        if (P.overlapsCapsule(w, x, 0, z, 0.4, 1.9) || P.overlapsCapsule(w, bx, 0, bz, 0.4, 1.9)) continue;
        if (P.lineOfSight(w, [x, 1.6, z], [bx, 1.6, bz])) return { a: { x, z }, b: { x: bx, z: bz } };
      }
    }
  }
  return null;
}

export default {
  name: 'mobile',
  title: '휴대폰 화면에서 터치로만 하는 경기: 조이스틱, 시점, 버튼, 일시정지, 이모트, 총 버리기, 세로 안내',
  timeoutMs: 6 * 60 * 1000,
  async run(t) {
    t.setSection('터치 기기 판별');
    let page = await t.newPage();
    const profile = richProfile({ loadout: { primary: 'ar_std', secondary: 'pt_std', melee: 'ml_knife' } });
    await page.open(`${t.base}?debug=1&sandbox=alley&ruleset=classic&mode=ffa&bots=1&botweapon=ar_std&killtarget=50`, { width: W, height: H, mobile: true, clean: true, initScript: qaInit({ profile }) });
    await readyGame(page, { screen: 'sandbox' });
    t.check(await page.eval(`document.documentElement.classList.contains('pc-touch') && __qa.ctx.input.touchMode`), '터치 기기면 터치 조작이 켜진다');
    t.check((await page.eval('__qa.ctx.renderer.quality')) === 'low', '휴대폰은 저사양으로 시작한다', await page.eval('__qa.ctx.renderer.quality'));

    t.setSection('조작 시작');
    await waitRun(page);
    await page.eval('__qa.freezeBots()');
    await waitLive(page);
    await page.waitFor('!__qa.ui.isVisible("loadout")', 8000, { label: '무기 선택 닫힘' });
    // 무기 선택이 닫히면 다시 누르지 않아도 조작이 돌아온다
    await page.waitFor('__qa.ctx.input.locked', 3000, { label: '조작 돌아옴' }).catch(() => t.check(false, '무기 선택이 닫히면 조작이 돌아온다'));
    if (!(await page.eval('__qa.ctx.input.locked'))) await tap(page, { x: W / 2, y: H / 2 });
    await page.waitFor('__qa.ctx.input.locked && __qa.ctx.input.enabled', 3000, { label: '조작 시작' });
    t.check(await page.eval(visible('.pc-tb--fire')) && await page.eval(visible('.pc-tb--jump')), '터치 버튼이 보인다');
    await t.shot('hud-touch');

    t.setSection('조이스틱');
    const spot = await page.fn(openSpots);
    if (!spot) throw new Error('평지를 찾지 못했어요');
    await page.fn((s) => { const qa = window.__qa; qa.teleport(s.a.x, 0, s.a.z, Math.atan2(-(s.b.x - s.a.x), -(s.b.z - s.a.z))); qa.ctx.player.state.onGround = true; }, spot);
    await waitTicks(page, 5);
    const p0 = await page.eval('__qa.ctx.player.state.pos.slice()');
    await page.touch('touchStart', [{ id: 1, x: 110, y: 270 }]);
    await page.touch('touchMove', [{ id: 1, x: 110, y: 200 }]);
    await waitTicks(page, 25);
    t.check(await page.eval('__qa.ctx.input.state.forward && !__qa.ctx.input.state.walk'), '위로 끝까지 밀면 앞으로 달린다');
    const p1 = await page.eval('__qa.ctx.player.state.pos.slice()');
    t.check(Math.hypot(p1[0] - p0[0], p1[2] - p0[2]) > 0.3, '실제로 움직인다', { p0, p1 });
    await t.shot('stick-held');
    await page.touch('touchMove', [{ id: 1, x: 80, y: 270 }]);
    await waitTicks(page, 3);
    t.check(await page.eval('__qa.ctx.input.state.left && !__qa.ctx.input.state.forward && __qa.ctx.input.state.walk'), '왼쪽으로 조금 밀면 왼쪽으로 걷는다');
    await page.touch('touchEnd', []);
    await waitTicks(page, 3);
    t.check(await page.eval('!__qa.ctx.input.state.left && !__qa.ctx.input.state.forward && !__qa.ctx.input.state.walk'), '손을 떼면 멈춘다');

    t.setSection('시점');
    let yaw0 = await page.eval('__qa.ctx.player.state.yaw');
    await page.touch('touchStart', [{ id: 1, x: 560, y: 150 }]);
    await page.touch('touchMove', [{ id: 1, x: 640, y: 150 }]);
    await waitTicks(page, 3);
    await page.touch('touchEnd', []);
    let yaw1 = await page.eval('__qa.ctx.player.state.yaw');
    t.check(yaw1 < yaw0 - 0.1, '오른쪽으로 끌면 오른쪽으로 돈다', { yaw0, yaw1 });
    const pitch0 = await page.eval('__qa.ctx.player.state.pitch');
    await page.touch('touchStart', [{ id: 1, x: 560, y: 200 }]);
    await page.touch('touchMove', [{ id: 1, x: 560, y: 150 }]);
    await waitTicks(page, 3);
    await page.touch('touchEnd', []);
    t.check((await page.eval('__qa.ctx.player.state.pitch')) > pitch0 + 0.05, '위로 끌면 위를 본다');

    t.setSection('두 손가락 동시');
    yaw0 = await page.eval('__qa.ctx.player.state.yaw');
    const p2 = await page.eval('__qa.ctx.player.state.pos.slice()');
    await page.touch('touchStart', [{ id: 1, x: 110, y: 270 }]);
    await page.touch('touchStart', [{ id: 1, x: 110, y: 270 }, { id: 2, x: 560, y: 150 }]);
    await page.touch('touchMove', [{ id: 1, x: 110, y: 200 }, { id: 2, x: 500, y: 150 }]);
    await waitTicks(page, 15);
    yaw1 = await page.eval('__qa.ctx.player.state.yaw');
    const p3 = await page.eval('__qa.ctx.player.state.pos.slice()');
    await page.touch('touchEnd', []);
    t.check(yaw1 > yaw0 + 0.05 && Math.hypot(p3[0] - p2[0], p3[2] - p2[2]) > 0.1, '걸으면서 시점을 돌린다', { yaw0, yaw1, p2, p3 });
    t.errorsOk('이동');

    t.setSection('발사와 장전');
    await page.waitFor(`__qa.arsenal.getWeapon().state === 'idle'`, 5000, { intervalMs: 30, label: '무기 준비' });
    const mag0 = await page.eval(`__qa.arsenal.getAmmo().mag`);
    const fire = await center(page, '.pc-tb--fire');
    yaw0 = await page.eval('__qa.ctx.player.state.yaw');
    await page.touch('touchStart', [{ id: 1, x: fire.x, y: fire.y }]);
    await sleep(250);
    t.check(await page.eval('__qa.ctx.input.state.fire'), '누르는 동안 쏜다');
    await page.touch('touchMove', [{ id: 1, x: fire.x - 40, y: fire.y }]);
    await waitTicks(page, 3);
    await page.touch('touchEnd', []);
    await waitTicks(page, 3);
    t.check(!(await page.eval('__qa.ctx.input.state.fire')), '떼면 멈춘다');
    const mag1 = await page.eval(`__qa.arsenal.getAmmo().mag`);
    t.check(mag1 < mag0, '탄이 줄어든다', { mag0, mag1 });
    t.check((await page.eval('__qa.ctx.player.state.yaw')) > yaw0 + 0.03, '쏘면서 끌면 시점도 돈다');
    await tapButton(page, 'reload');
    await page.waitFor(`__qa.arsenal.getWeapon().state === 'reload'`, 2000, { intervalMs: 30, label: '장전 시작' });
    await page.waitFor(`__qa.arsenal.getWeapon().state === 'idle'`, 6000, { intervalMs: 30, label: '장전 끝' });
    t.check((await page.eval(`__qa.arsenal.getAmmo().mag`)) === 30, '장전하면 탄창이 찬다');

    t.setSection('조준');
    await tapButton(page, 'zoom');
    await page.waitFor('__qa.arsenal.getZoom().zoomed', 2000, { intervalMs: 30, label: '줌 켜짐' });
    await waitTicks(page, 15);
    t.check(await page.eval('__qa.arsenal.getZoom().zoomed'), '손을 떼도 줌이 유지된다');
    await t.shot('zoom');
    await tapButton(page, 'zoom');
    await page.waitFor('!__qa.arsenal.getZoom().zoomed', 2000, { intervalMs: 30, label: '줌 꺼짐' });

    t.setSection('점프와 앉기');
    const jump = await center(page, '.pc-tb--jump');
    await page.touch('touchStart', [{ id: 1, x: jump.x, y: jump.y }]);
    await page.waitFor('__qa.ctx.player.state.onGround === false', 2000, { intervalMs: 20, label: '뛰어오름' });
    await page.waitFor('__qa.ctx.player.state.onGround === true', 3000, { intervalMs: 20, label: '착지' });
    await page.waitFor('__qa.ctx.player.state.onGround === false', 1500, { intervalMs: 20, label: '꾹 누르면 다시 뜀' });
    await page.touch('touchEnd', []);
    t.check(true, '점프를 꾹 누르면 착지하자마자 다시 뛴다');
    await page.waitFor('__qa.ctx.player.state.onGround === true', 3000, { intervalMs: 20, label: '착지' });
    await tapButton(page, 'crouch');
    await waitTicks(page, 3);
    t.check(await page.eval(`__qa.ctx.player.state.crouch && document.querySelector('.pc-tb--crouch').classList.contains('is-on')`), '앉기를 누르면 앉고 버튼이 켜진다');
    await tapButton(page, 'crouch');
    await waitTicks(page, 3);
    t.check(!(await page.eval('__qa.ctx.player.state.crouch')), '다시 누르면 일어난다');

    t.setSection('무기 칸과 칼');
    await tap(page, await center(page, '.sk-slot:nth-child(2)'));
    await page.waitFor(`__qa.arsenal.getWeapon().id === 'pt_std'`, 2000, { intervalMs: 30, label: '권총으로' });
    await tap(page, await center(page, '.sk-slot:nth-child(3)'));
    await page.waitFor(`__qa.arsenal.getWeapon().id === 'ml_knife'`, 2000, { intervalMs: 30, label: '칼로' });
    await page.waitFor(`__qa.arsenal.getWeapon().state === 'idle'`, 3000, { intervalMs: 30, label: '칼 준비' });
    await page.eval('__qa.clearLogs()');
    await tapButton(page, 'fire');
    await page.waitFor(`__qa.weaponEvents.some((e) => e.type === 'swing' && e.kind === 'slash')`, 2000, { intervalMs: 20, label: '베기' });
    await t.shot('knife-slash');
    await page.waitFor(`__qa.arsenal.getWeapon().state === 'idle'`, 3000, { intervalMs: 30, label: '베기 끝' });
    await page.eval('__qa.clearLogs()');
    await tapButton(page, 'zoom');
    await page.waitFor(`__qa.weaponEvents.some((e) => e.type === 'swing' && e.kind === 'stab')`, 2000, { intervalMs: 20, label: '찌르기' });
    await page.waitFor(`__qa.arsenal.getWeapon().state === 'idle'`, 3000, { intervalMs: 30, label: '찌르기 끝' });
    await tap(page, await center(page, '.sk-slot:nth-child(1)'));
    await page.waitFor(`__qa.arsenal.getWeapon().id === 'ar_std'`, 2000, { intervalMs: 30, label: '주무기로' });
    t.errorsOk('버튼');

    t.setSection('점수판과 일시정지');
    const score = await center(page, '.pc-tb--score');
    await page.touch('touchStart', [{ id: 1, x: score.x, y: score.y }]);
    await page.waitFor('__qa.ui.isVisible("scoreboard")', 2000, { label: '점수판' });
    await t.shot('scoreboard');
    await page.touch('touchEnd', []);
    await page.waitFor('!__qa.ui.isVisible("scoreboard")', 2000, { label: '점수판 닫힘' });
    await tapButton(page, 'pause');
    await page.waitFor('__qa.ui.isVisible("pause")', 2000, { label: '일시정지' });
    t.check(!(await page.eval('__qa.ctx.input.locked')) && !(await page.eval(visible('.pc-tb--fire'))), '일시정지 중에는 터치 버튼이 숨는다');
    await t.shot('pause');
    await tap(page, await page.fn(() => {
      const b = [...document.querySelectorAll('.sk-pause-btns .sk-btn')].find((x) => /계속|돌아/.test(x.textContent));
      const r = b.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }));
    await page.waitFor('__qa.ctx.input.locked && !__qa.ui.isVisible("pause")', 2000, { label: '계속' });
    t.check(await page.eval(visible('.pc-tb--fire')), '계속하면 버튼이 돌아온다');

    t.setSection('이모트');
    await waitTicks(page, 5);
    const emote = await center(page, '.pc-tb--emote');
    await page.touch('touchStart', [{ id: 1, x: emote.x, y: emote.y }]);
    await page.waitFor('__qa.ui.isVisible("emotes")', 2000, { label: '이모트 휠' });
    await page.touch('touchMove', [{ id: 1, x: emote.x, y: emote.y + 120 }]);
    await waitTicks(page, 2);
    await t.shot('emote-wheel');
    t.check((await page.eval('__qa.ctx.input.emoteWheel.selected')) != null, '끌면 칸이 골라진다');
    await page.touch('touchEnd', []);
    await page.waitFor('__qa.world.localEmote > 0', 2000, { intervalMs: 30, label: '이모트 시작' });
    await sleep(300);
    await tapButton(page, 'fire');
    await page.waitFor('__qa.world.localEmote === 0', 2000, { intervalMs: 30, label: '발사 버튼으로 이모트 취소' });
    t.errorsOk('이모트');

    t.setSection('죽은 뒤 총 버리기');
    await page.fn((s) => {
      const qa = window.__qa;
      qa.teleport(s.a.x, 0, s.a.z);
      qa.ctx.player.state.onGround = true;
      qa.placeBot(0, s.b.x, 0, s.b.z);
      const p = qa.ctx.player.state, b = qa.run.bots[0];
      const dx = p.pos[0] - b.body.pos[0], dz = p.pos[2] - b.body.pos[2], dy = (p.pos[1] + 1.2) - (b.body.pos[1] + 1.6);
      b.yaw = Math.atan2(-dx, -dz);
      b.pitch = Math.atan2(dy, Math.hypot(dx, dz));
      b.brain.think = (dt, view) => ({ forward: 0, strafe: 0, jump: false, walk: false, yawDelta: 0, pitchDelta: 0, fire: true, zoom: false, reload: view.self.ammo.mag === 0, slot: null });
    }, spot);
    await page.waitFor('!__qa.world.localAlive', 20000, { intervalMs: 50, label: '봇에게 쓰러짐' });
    await page.eval('__qa.freezeBots()');
    await waitTicks(page, 2);
    t.check(/여기를 눌러 RX-4 버리기/.test(await page.eval(`__qa.text('.sk-hint') || ''`)), '죽으면 눌러서 버리라고 알려 준다', await page.eval(`__qa.text('.sk-hint')`));
    t.check(!(await page.eval(visible('.pc-tb--fire'))), '죽어 있는 동안 전투 버튼이 숨는다');
    await sleep(250);
    await t.shot('dead');
    await tap(page, await center(page, '.sk-hint'));
    await page.waitFor('__qa.world.internals.drops.size === 1', 2000, { intervalMs: 30, label: '총이 떨어진다' });
    t.check(true, '안내를 누르면 총이 떨어진다');
    await page.waitFor('__qa.world.localAlive', 12000, { intervalMs: 50, label: '부활' });
    await waitTicks(page, 2);
    t.check(await page.eval(visible('.pc-tb--fire')), '부활하면 전투 버튼이 돌아온다');
    t.errorsOk('총 버리기');

    t.setSection('세로 화면');
    t.check(!(await page.eval(visible('.pc-rotate'))), '가로 화면에는 안내가 없다');
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 540, deviceScaleFactor: 1, mobile: true });
    await sleep(300);
    t.check(await page.eval(visible('.pc-rotate')), '세로로 들면 가로로 돌리라고 알려 준다');
    await t.shot('portrait');
    await page.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: true });
    t.errorsOk('세로 화면');

    t.setSection('PC 화면');
    page = await t.newPage();
    await page.open(`${t.base}?debug=1`, { width: 960, height: 540, clean: true, initScript: qaInit({ profile, settings: LOW_QUALITY }) });
    await readyGame(page, { screen: 'menu' });
    t.check(await page.eval(`!document.documentElement.classList.contains('pc-touch') && !__qa.ctx.input.touchMode && !document.querySelector('.pc-touch-layer')`), 'PC에서는 터치 조작이 켜지지 않는다');
    t.errorsOk('PC 화면');
  }
};
