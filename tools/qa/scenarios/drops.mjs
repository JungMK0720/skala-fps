/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 시나리오 6. 프리미엄 탄약과 칼 상점, 죽은 뒤 G로 총 버리기, 탄약이 떨어지면 줍기, 3인칭 칼 휘두르기를 실제 경기 화면에서 돌려 본다.
 */
import { PREMIUM_PRICE, WEAPONS } from '../../../js/weapons/defs.js';
import { LOW_QUALITY, lockPointer, openGame, richProfile, sleep, waitLive, waitRun, waitTicks } from '../kit.mjs';

const dropCount = `__qa.world.internals.drops.size`;
const dropMeshes = `__qa.ctx.renderer.scene.children.filter((o) => o.name === 'world:drop').length`;

/** 페이지에서: 서로 보이는 평지 두 곳. 발판·포털과 떨어져 있어야 한다 */
function openSpots() {
  const c = window.__qa.ctx, w = c.world, P = c.physics;
  for (let x = -30; x <= 30; x += 2) {
    for (let z = -18; z <= 18; z += 2) {
      for (const [dx, dz] of [[6, 0], [0, 6]]) {
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

/** 표적 봇이 플레이어를 겨누고 쏘게 해서 쓰러뜨린다 */
async function dieToBot(page, spot) {
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
}

export default {
  name: 'drops',
  title: '프리미엄 탄약, 칼 상점, 죽은 뒤 G로 총 버리기, 탄약이 떨어지면 줍기, 3인칭 칼 휘두르기',
  timeoutMs: 5 * 60 * 1000,
  async run(t) {
    t.setSection('상점: 기본 칼과 프리미엄');
    let page = await openGame(t, '', { profile: { nickname: '상점손님', points: 1300, createdAt: 1 }, settings: LOW_QUALITY, screen: 'menu', width: 960, height: 540 });
    await page.waitFor('__qa.ui.isVisible("menu")', 5000, { label: '메뉴' });
    t.check((await page.eval('__qa.ctx.account.loadout.melee')) === 'ml_knife', '처음 칼은 호크빌 나이프다');
    t.check(await page.eval(`__qa.ctx.account.isOwned('ml_knife') && !__qa.ctx.account.isOwned('ml_katana') && !__qa.ctx.account.isOwned('ml_gurkha') && !__qa.ctx.account.isOwned('ml_tanto')`), '나머지 칼은 사야 한다');
    await page.click('.sk-player-mypage');
    await page.waitFor('__qa.ui.isVisible("mypage")', 3000, { label: '마이페이지' });
    await page.click('.sk-mypage .sk-my-panelhead .sk-btn--sm');
    await page.waitFor('__qa.ui.isVisible("shop")', 3000, { label: '상점' });
    t.check(new RegExp(`${PREMIUM_PRICE.toLocaleString('en-US')}`).test(await page.eval(`__qa.text('.sk-shop .sk-bar-sub')`)), '상점이 프리미엄 기준을 알려 준다', await page.eval(`__qa.text('.sk-shop .sk-bar-sub')`));
    const badges = {};
    for (const tab of ['라이플', '저격', 'SMG·샷건', '권총', '근접']) {
      await page.clickText('.sk-shop .sk-tab', tab);
      badges[tab] = await page.eval(`[...document.querySelectorAll('.sk-shop-grid .sk-shop-card')].filter((c) => c.querySelector('.sk-premium')).map((c) => c.getAttribute('aria-label'))`);
    }
    const premiumNames = Object.values(badges).flat().sort();
    const want = Object.values(WEAPONS).filter((d) => d.premium).map((d) => d.name).sort();
    t.check(JSON.stringify(premiumNames) === JSON.stringify(want), '프리미엄 표시가 무기 표와 같다', badges);
    t.check(badges['근접'].length === 0, '칼에는 프리미엄 표시가 없다');
    const cards = await page.eval(`[...document.querySelectorAll('.sk-shop-grid .sk-shop-card')].map((c) => [c.getAttribute('aria-label'), c.querySelector('.sk-shop-state').textContent])`);
    t.check(cards.length === 4 && cards[0][1] === '장착 중', '근접 탭: 칼 넷, 기본 칼을 장착 중', cards);
    t.check(cards.some(([n, s]) => n === WEAPONS.ml_katana.name && /1,200/.test(s)), '카타나는 가격이 붙어 있다', cards);
    await t.shot('shop-melee');
    const buy = await page.eval(`__qa.ctx.account.buy('ml_katana')`);
    t.check(buy.ok && buy.points === 100, '카타나를 산다', buy);
    t.check((await page.eval(`__qa.ctx.account.equip('melee', 'ml_katana').ok`)) && (await page.eval('__qa.ctx.account.loadout.melee')) === 'ml_katana', '산 칼을 장착한다');
    t.errorsOk('상점');

    t.setSection('죽은 뒤 G로 총 버리기');
    const profile = richProfile({ loadout: { primary: 'ar_std', secondary: 'pt_std', melee: 'ml_knife' } });
    page = await openGame(t, 'sandbox=alley&ruleset=classic&mode=ffa&bots=1&botweapon=ar_std&killtarget=50', { profile, settings: LOW_QUALITY, width: 960, height: 540, screen: 'sandbox' });
    await waitRun(page);
    await page.eval('__qa.freezeBots()');
    await waitLive(page);
    await page.waitFor('!__qa.ui.isVisible("loadout")', 8000, { label: '무기 선택 닫힘' });
    await lockPointer(page);
    const spot = await page.fn(openSpots);
    if (!spot) throw new Error('평지를 찾지 못했어요');
    await page.press('KeyG');
    await waitTicks(page, 2);
    t.check((await page.eval(dropCount)) === 0, '살아 있으면 G를 눌러도 버리지 않는다');
    // 탄을 조금 쓰고 죽어 남은 탄약이 그대로 넘어가는지 본다
    await page.mouseDown(0);
    await sleep(350);
    await page.mouseUp(0);
    const left = await page.eval(`__qa.arsenal.getAmmo('ar_std')`);
    t.check(left.mag < WEAPONS.ar_std.mag, '탄을 조금 쓴다', left);
    await dieToBot(page, spot);
    await waitTicks(page, 2);
    t.check(/G 키로 RX-4 버리기/.test(await page.eval(`__qa.text('.sk-hint')`)), '버릴 수 있다고 알려 준다', await page.eval(`__qa.text('.sk-hint')`));
    await sleep(300);
    await t.shot('drop-hint');
    const deathPos = await page.eval('__qa.ctx.player.state.pos');
    await page.press('KeyG');
    await page.waitFor(`${dropCount} === 1`, 2000, { intervalMs: 30, label: '총이 떨어진다' });
    const d0 = await page.eval(`(() => { const d = __qa.world.internals.drops.list()[0]; return { weaponId: d.weaponId, pos: d.pos, mag: d.mag, reserve: d.reserve }; })()`);
    t.check(d0.weaponId === 'ar_std' && d0.mag === left.mag && d0.reserve === left.reserve, '남은 탄약을 들고 떨어진다', { d0, left });
    t.check(Math.hypot(d0.pos[0] - deathPos[0], d0.pos[2] - deathPos[2]) < 0.1, '죽은 자리에 떨어진다', { d0, deathPos });
    t.check((await page.eval(dropMeshes)) === 1, '바닥에 총이 보인다');
    await waitTicks(page, 2);
    t.check(!/버리기/.test(await page.eval(`__qa.text('.sk-hint') || ''`)), '버린 뒤에는 안내가 사라진다');
    await t.shot('dropped-gun');
    await page.press('KeyG');
    await waitTicks(page, 2);
    t.check((await page.eval(dropCount)) === 1, '한 번 죽을 때 한 자루만 버린다');

    t.setSection('탄약이 떨어져야 줍는다');
    await page.waitFor('__qa.world.localAlive', 12000, { intervalMs: 50, label: '부활' });
    t.check((await page.eval(dropCount)) === 1, '부활해도 총은 바닥에 남아 있다');
    t.check((await page.eval(`__qa.arsenal.getAmmo('ar_std').mag`)) === WEAPONS.ar_std.mag, '부활하면 내 총은 다시 찬다');
    await page.eval(`__qa.world.setLocalLoadout('sm_vx3')`);   // 줍는 총과 구별되게 다른 총으로 바꾼다
    await lockPointer(page);
    await page.fn((s) => {   // 떨어져서 바라본 모습
      const qa = window.__qa;
      const x = s.a.x + (s.b.x - s.a.x) * 0.5, z = s.a.z + (s.b.z - s.a.z) * 0.5;
      qa.teleport(x, 0, z, Math.atan2(-(s.a.x - x), -(s.a.z - z)));
      qa.ctx.player.state.onGround = true;
      qa.ctx.player.state.pitch = -0.32;
    }, spot);
    await waitTicks(page, 4);
    await t.shot('gun-from-afar');
    await page.fn((d) => { const qa = window.__qa; qa.teleport(d.pos[0], d.pos[1], d.pos[2]); qa.ctx.player.state.onGround = true; }, d0);
    await waitTicks(page, 5);
    t.check((await page.eval(dropCount)) === 1 && (await page.eval('__qa.arsenal.getPrimary()')) === 'sm_vx3', '탄이 남아 있으면 줍지 않는다');
    t.check(/다 쓰면 주울 수/.test(await page.eval(`__qa.text('.sk-hint') || ''`)), '주울 수 없는 이유를 알려 준다', await page.eval(`__qa.text('.sk-hint')`));
    await t.shot('cannot-pick');
    await page.eval(`__qa.clearLogs()`);
    await page.eval(`__qa.arsenal.takePrimary('sm_vx3', { mag: 0, reserve: 0 })`);   // 다 쏘는 데 오래 걸려서 탄만 비운다
    await page.waitFor(`__qa.arsenal.getPrimary() === 'ar_std'`, 3000, { intervalMs: 30, label: '총을 줍는다' });
    await page.waitFor(`__qa.arsenal.getWeapon().id === 'ar_std'`, 2000, { intervalMs: 30, label: '바로 꺼낸다' });
    const got = await page.eval(`__qa.arsenal.getAmmo('ar_std')`);
    t.check(got.mag === d0.mag && got.reserve === d0.reserve, '주운 총은 남은 탄약 그대로다', got);
    t.check((await page.eval(dropCount)) === 0 && (await page.eval(dropMeshes)) === 0, '주우면 바닥에서 사라진다');
    t.check(/획득/.test(await page.eval(`__qa.text('.sk-hud') || ''`)), '주웠다고 알려 준다');
    await t.shot('picked-gun');
    await page.waitFor(`__qa.arsenal.getWeapon().state === 'idle'`, 3000, { intervalMs: 30, label: '꺼내기 끝' });
    await page.mouseDown(0);
    await sleep(250);
    await page.mouseUp(0);
    t.check((await page.eval(`__qa.arsenal.getAmmo('ar_std').mag`)) < d0.mag, '주운 총을 쏠 수 있다');

    t.setSection('다음 목숨은 내 장비');
    await page.eval(`__qa.arsenal.takePrimary('dm_mark', { mag: 1 })`);   // 내 장비에 없는 총을 들고 죽는다
    await dieToBot(page, spot);
    await page.waitFor('__qa.world.localAlive', 12000, { intervalMs: 50, label: '부활' });
    t.check((await page.eval('__qa.arsenal.getPrimary()')) === 'ar_std', '주운 총은 이번 목숨에만 쓴다', await page.eval('__qa.arsenal.getPrimary()'));
    t.check((await page.eval(`__qa.arsenal.getAmmo('ar_std').mag`)) === WEAPONS.ar_std.mag, '내 총은 다시 찬다');

    t.setSection('4초가 지나면 버릴 수 없다');
    await dieToBot(page, spot);
    await page.eval('__qa.world.internals.local.deadAt -= 4100');
    await waitTicks(page, 2);
    t.check(!/버리기/.test(await page.eval(`__qa.text('.sk-hint') || ''`)), '시간이 지나면 안내도 사라진다');
    await page.press('KeyG');
    await waitTicks(page, 2);
    t.check((await page.eval(dropCount)) === 0, '시간이 지나면 G가 듣지 않는다');
    t.errorsOk('총 버리기');

    t.setSection('3인칭 칼 휘두르기');
    await page.waitFor('__qa.world.localAlive', 12000, { intervalMs: 50, label: '부활' });
    await lockPointer(page);
    await page.fn((s) => {
      const qa = window.__qa;
      qa.teleport(s.a.x, 0, s.a.z, Math.atan2(-(s.b.x - s.a.x), -(s.b.z - s.a.z)));
      qa.ctx.player.state.onGround = true;
      const b = qa.run.bots[0];
      qa.placeBot(0, s.b.x, 0, s.b.z, Math.atan2(s.b.x - s.a.x, s.b.z - s.a.z));
      qa.world.setActorState(b.id, { pos: b.body.pos, yaw: b.yaw, pitch: 0, alive: true, slot: 3, weaponId: 'ml_gurkha' });
    }, spot);
    await waitTicks(page, 3);
    const botId = await page.eval('__qa.run.bots[0].id');
    const swing = async (kind) => {
      await page.fn((a) => { window.__qa.world.actorFire({ id: a.id, weaponId: 'ml_gurkha', origin: [0, 1.6, 0], dir: [0, 0, -1], kind: a.kind }); }, { id: botId, kind });
      const seen = [];
      for (let i = 0; i < 6; i++) {
        seen.push(await page.eval(`(() => { const a = __qa.ctx.avatars.get(${JSON.stringify(botId)}); return { t: a.swingT, y: a.armsPivot.rotation.y, z: a.armsPivot.position.z }; })()`));
        if (i === 1) await t.shot(`third-person-${kind}`);
        await sleep(40);
      }
      return seen;
    };
    await t.shot('third-person-before');
    const cut = await swing('slash');
    t.check(cut.some((s) => s.t >= 0) && cut.some((s) => Math.abs(s.y) > 0.05), '베면 팔이 가로로 움직인다', cut);
    await sleep(500);
    const stab = await swing('stab');
    t.check(stab.some((s) => s.t >= 0) && stab.some((s) => Math.abs(s.z) > 0.01), '찌르면 팔이 앞뒤로 움직인다', stab);
    await sleep(700);
    const rest = await page.eval(`(() => { const a = __qa.ctx.avatars.get(${JSON.stringify(botId)}); return { t: a.swingT, y: a.armsPivot.rotation.y, z: a.armsPivot.position.z }; })()`);
    t.check(rest.t < 0 && rest.y === 0 && rest.z === 0, '끝나면 자세가 돌아온다', rest);
    t.errorsOk('3인칭 칼');

    t.setSection('칼전에는 버릴 총이 없다');
    page = await openGame(t, 'sandbox=dojo&ruleset=knife&mode=ffa&bots=1&killtarget=50', { profile, settings: LOW_QUALITY, width: 640, height: 360, screen: 'sandbox' });
    await waitRun(page);
    await page.eval('__qa.freezeBots()');
    await waitLive(page);
    await page.waitFor('!__qa.ui.isVisible("loadout")', 8000, { label: '무기 선택 닫힘' });
    await lockPointer(page);
    await page.eval('__qa.world.killLocal({})');
    await waitTicks(page, 2);
    t.check(!/버리기/.test(await page.eval(`__qa.text('.sk-hint') || ''`)), '칼전에는 안내가 없다');
    await page.press('KeyG');
    await waitTicks(page, 2);
    t.check((await page.eval(dropCount)) === 0, '칼전에는 G가 듣지 않는다');
    t.errorsOk('칼전');
  }
};
