/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 시나리오 6. 프리미엄 탄약과 칼 상점, 들고 있는 총 G로 버리기(주무기·보조), 죽으면 든 총이 떨어짐, 빈 칸이면 줍기(남은 탄 그대로),
 *          봇이 죽으며 떨어뜨린 총, 3인칭 칼 휘두르기를 실제 경기 화면에서 돌려 본다.
 */
import { PREMIUM_PRICE, WEAPONS } from '../../../js/weapons/defs.js';
import { DROP_TTL_MS } from '../../../js/game/drops.js';
import { LOW_QUALITY, clickFire, lockPointer, openGame, richProfile, sleep, waitIdle, waitLive, waitRun, waitTicks } from '../kit.mjs';

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
  title: '프리미엄 탄약, 칼 상점, 들고 있는 총 G로 버리기, 죽으면 떨어짐, 빈 칸이면 줍기, 3인칭 칼 휘두르기',
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

    t.setSection('살아 있을 때 G로 총 버리기');
    const profile = richProfile({ loadout: { primary: 'ar_std', secondary: 'pt_std', melee: 'ml_knife' } });
    page = await openGame(t, 'sandbox=alley&ruleset=classic&mode=ffa&bots=1&botweapon=ar_std&killtarget=50', { profile, settings: LOW_QUALITY, width: 960, height: 540, screen: 'sandbox' });
    await waitRun(page);
    await page.eval('__qa.freezeBots()');
    await waitLive(page);
    await page.waitFor('!__qa.ui.isVisible("loadout")', 8000, { label: '무기 선택 닫힘' });
    await lockPointer(page);
    const spot = await page.fn(openSpots);
    if (!spot) throw new Error('평지를 찾지 못했어요');
    const goTo = (p) => page.fn((q) => { const qa = window.__qa; qa.teleport(q[0], q[1], q[2]); qa.ctx.player.state.onGround = true; }, p);
    await page.fn((s) => { const qa = window.__qa; qa.teleport(s.a.x, 0, s.a.z, Math.atan2(-(s.b.x - s.a.x), -(s.b.z - s.a.z))); qa.ctx.player.state.onGround = true; qa.placeBot(0, s.b.x + 20, 0, s.b.z + 20); }, spot);
    await waitIdle(page);
    // 탄을 조금 써서 남은 탄약이 그대로 넘어가는지 본다
    await page.mouseDown(0);
    await sleep(350);
    await page.mouseUp(0);
    const left = await page.eval(`__qa.arsenal.getAmmo('ar_std')`);
    t.check(left.mag < WEAPONS.ar_std.mag, '탄을 조금 쓴다', left);
    const at0 = await page.eval('__qa.ctx.player.state.pos.slice()');
    await page.press('KeyG');
    await page.waitFor(`${dropCount} === 1`, 2000, { intervalMs: 30, label: '총이 떨어진다' });
    const d0 = await page.eval(`(() => { const d = __qa.world.internals.drops.list()[0]; return { id: d.id, weaponId: d.weaponId, pos: d.pos, mag: d.mag, reserve: d.reserve }; })()`);
    t.check(d0.weaponId === 'ar_std' && d0.mag === left.mag && d0.reserve === left.reserve, '들고 있던 주무기가 남은 탄약 그대로 떨어진다', { d0, left });
    const gap = Math.hypot(d0.pos[0] - at0[0], d0.pos[2] - at0[2]);
    t.check(gap > 0.4 && gap < 1.3, '발 앞에 떨어진다', { gap });
    t.check(await page.eval('__qa.arsenal.isSlotEmpty(1)'), '주무기 칸이 빈다');
    await page.waitFor(`__qa.arsenal.getWeapon().id === 'pt_std'`, 2000, { intervalMs: 30, label: '보조무기를 꺼낸다' });
    t.check(await page.eval(`document.querySelector('.sk-slot:nth-child(1)').classList.contains('is-empty')`), 'HUD의 주무기 칸이 비어 보인다');
    t.check((await page.eval(dropMeshes)) === 1, '바닥에 총이 보인다');
    await waitTicks(page, 3);
    t.check((await page.eval(dropCount)) === 1 && (await page.eval('__qa.arsenal.isSlotEmpty(1)')), '방금 버린 총을 바로 다시 줍지 않는다');
    await page.waitFor(`__qa.arsenal.getWeapon().state === 'idle'`, 3000, { intervalMs: 30, label: '보조무기 준비' });
    await page.press('KeyG');
    await page.waitFor(`${dropCount} === 2`, 2000, { intervalMs: 30, label: '보조무기도 버린다' });
    await page.waitFor(`__qa.arsenal.getWeapon().id === 'ml_knife'`, 2000, { intervalMs: 30, label: '칼만 남는다' });
    const mul = await page.eval('__qa.arsenal.getMoveMul()');
    t.check(mul > WEAPONS.ar_std.moveMul, '칼을 들면 더 빨리 달린다', { mul, rifle: WEAPONS.ar_std.moveMul });
    await page.press('KeyG');
    await waitTicks(page, 3);
    t.check((await page.eval(dropCount)) === 2, '칼은 버리지 않는다');

    t.setSection('빈 칸이면 주워서 남은 탄 그대로');
    await goTo([d0.pos[0] + 4, d0.pos[1], d0.pos[2]]);
    await waitTicks(page, 2);
    await goTo(d0.pos);
    await page.waitFor(`__qa.arsenal.getPrimary() === 'ar_std' && !__qa.arsenal.isSlotEmpty(1)`, 3000, { intervalMs: 30, label: '주무기를 줍는다' });
    await page.waitFor(`__qa.arsenal.getWeapon().id === 'ar_std'`, 2000, { intervalMs: 30, label: '바로 꺼낸다' });
    const got = await page.eval(`__qa.arsenal.getAmmo('ar_std')`);
    t.check(got.mag === d0.mag && got.reserve === d0.reserve, '주운 총은 남은 탄약 그대로다', got);
    t.check(/획득/.test(await page.eval(`__qa.text('.sk-hud') || ''`)), '주웠다고 알려 준다');
    // 두 총이 같은 자리에 있으니 권총도 함께 줍는다. 주무기를 든 채 권총을 주우면 주무기를 그대로 든다
    await page.waitFor(`${dropCount} === 0 && !__qa.arsenal.isSlotEmpty(2)`, 3000, { intervalMs: 30, label: '같은 자리의 보조무기도 줍는다' });
    t.check((await page.eval(dropMeshes)) === 0, '주운 총은 바닥에서 사라진다');
    t.check((await page.eval('__qa.arsenal.getWeapon().id')) === 'ar_std', '주무기를 든 채 권총을 주우면 주무기를 그대로 든다');
    await t.shot('picked-back');

    t.setSection('떨어진 총은 4초 뒤 사라진다');
    await waitIdle(page);
    await page.press('KeyG');
    await page.waitFor(`${dropCount} === 1`, 2000, { intervalMs: 30, label: '다시 버린다' });
    const bornAt = Date.now();
    await t.shot('dropped-gun');
    await goTo([d0.pos[0] + 6, d0.pos[1], d0.pos[2]]);
    await page.waitFor(`${dropCount} === 0`, DROP_TTL_MS + 3000, { intervalMs: 100, label: '시간이 지나 사라진다' });
    const lived = Date.now() - bornAt;
    t.check(lived >= DROP_TTL_MS - 400 && lived <= DROP_TTL_MS + 1500, '떨어진 총은 4초쯤 뒤에 사라진다', { lived });
    t.check((await page.eval(dropMeshes)) === 0, '사라지면 바닥에서도 안 보인다');

    t.setSection('총을 든 채 죽으면 떨어진다');
    await page.waitFor(`__qa.arsenal.getWeapon().id === 'pt_std' && __qa.arsenal.getWeapon().state === 'idle'`, 3000, { intervalMs: 30, label: '권총을 든다' });
    const dying = await page.eval(`__qa.arsenal.getAmmo('pt_std')`);
    await dieToBot(page, spot);
    await page.waitFor(`${dropCount} === 1`, 2000, { intervalMs: 30, label: '죽으면 든 총이 떨어진다' });
    const deathPos = await page.eval('__qa.ctx.player.state.pos');
    const d1 = await page.eval(`(() => { const d = __qa.world.internals.drops.list()[0]; return { id: d.id, weaponId: d.weaponId, pos: d.pos, mag: d.mag, reserve: d.reserve }; })()`);
    t.check(d1.weaponId === 'pt_std' && d1.mag === dying.mag && d1.reserve === dying.reserve, '들고 있던 권총이 남은 탄약 그대로 떨어진다', { d1, dying });
    t.check(Math.hypot(d1.pos[0] - deathPos[0], d1.pos[2] - deathPos[2]) < 0.1, '죽은 자리에 떨어진다', { d1, deathPos });
    await t.shot('death-drop');
    await page.waitFor('__qa.world.localAlive', 12000, { intervalMs: 50, label: '부활' });
    t.check(!(await page.eval('__qa.arsenal.isSlotEmpty(1)')) && (await page.eval(`__qa.arsenal.getAmmo('ar_std').mag`)) === WEAPONS.ar_std.mag, '부활하면 버린 주무기까지 내 장비가 다시 찬다');

    t.setSection('봇이 죽으며 떨어뜨린 총: 칸이 차 있으면 버려야 줍는다');
    await page.waitFor(`${dropCount} === 0`, DROP_TTL_MS + 2000, { intervalMs: 100, label: '앞의 총이 사라진다' });
    await lockPointer(page);
    await page.fn((s) => {
      const qa = window.__qa;
      qa.teleport(s.a.x, 0, s.a.z, Math.atan2(-(s.b.x - s.a.x), -(s.b.z - s.a.z)));
      qa.ctx.player.state.onGround = true;
      qa.placeBot(0, s.b.x, 0, s.b.z, Math.atan2(s.b.x - s.a.x, s.b.z - s.a.z));
    }, spot);
    await waitTicks(page, 4);
    await waitIdle(page);
    await page.fn(() => { const qa = window.__qa; return qa.aimAt(qa.partPoint(qa.run.bots[0].id, 'head')); });
    await waitTicks(page, 2);
    await page.eval('window.__qaRng = () => 0');
    await clickFire(page, 2);
    await page.waitFor('!__qa.run.bots[0].alive', 4000, { intervalMs: 30, label: '봇이 쓰러진다' });
    await page.eval('window.__qaRng = null');
    await page.waitFor(`${dropCount} === 1`, 2000, { intervalMs: 30, label: '봇의 총이 떨어진다' });
    const bd = await page.eval(`(() => { const d = __qa.world.internals.drops.list()[0]; return { id: d.id, weaponId: d.weaponId, pos: d.pos, mag: d.mag, reserve: d.reserve }; })()`);
    t.check(bd.weaponId === 'ar_std' && Math.hypot(bd.pos[0] - spot.b.x, bd.pos[2] - spot.b.z) < 1, '봇이 들던 총이 그 자리에 떨어진다', bd);
    await goTo(bd.pos);
    await waitTicks(page, 3);
    t.check((await page.eval(dropCount)) === 1, '주무기 칸이 차 있으면 줍지 않는다');
    t.check(/버리면 주울 수/.test(await page.eval(`__qa.text('.sk-hint') || ''`)), '버리면 주울 수 있다고 알려 준다', await page.eval(`__qa.text('.sk-hint')`));
    await page.waitFor(`__qa.arsenal.getWeapon().id === 'ar_std' && __qa.arsenal.getWeapon().state === 'idle'`, 2000, { intervalMs: 30, label: '주무기 준비' });
    await page.press('KeyG');
    await page.waitFor(`__qa.world.internals.drops.list().every((d) => d.id !== ${JSON.stringify(bd.id)})`, 2000, { intervalMs: 30, label: '내 총을 버리고 봇의 총을 줍는다' });
    const swapped = await page.eval(`__qa.arsenal.getAmmo('ar_std')`);
    t.check(swapped.mag === bd.mag && swapped.reserve === bd.reserve, '주운 총은 봇이 남긴 탄약 그대로다', { swapped, bd });
    await t.shot('swap');
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
    await page.press('KeyG');
    await waitTicks(page, 2);
    t.check((await page.eval(dropCount)) === 0, '칼전에는 G가 듣지 않는다');
    await page.eval('__qa.world.killLocal({})');
    await waitTicks(page, 2);
    t.check((await page.eval(dropCount)) === 0, '칼을 든 채 죽으면 아무것도 떨어지지 않는다');
    t.errorsOk('칼전');
  }
};
