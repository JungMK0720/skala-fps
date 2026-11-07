/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 시나리오 4. 살아 있는 페이지에서 모든 무기를 로드아웃 경로로 쥐고 진짜 키·마우스로 사격, 재장전, 교체, 줌, 점사, 산탄, 칼 베기·강타, 수류탄, F 살펴보기를 검사한다.
 *          칼전과 스나전이 다른 슬롯을 정말 막는지도 본다.
 */
import { MELEE_IDS, PRIMARY_IDS, SECONDARY_IDS, WEAPONS, zoomFov } from '../../../js/weapons/defs.js';
import { LOW_QUALITY, clickFire, lockPointer, openGame, richProfile, sleep, waitIdle, waitLive, waitRun, waitTicks } from '../kit.mjs';

const near = (a, b, eps = 0.05) => Math.abs(a - b) <= eps;
const snap = (page) => page.eval('__qa.snapshot()');

async function startMatch(t, query) {
  const page = await openGame(t, query, { profile: richProfile(), settings: LOW_QUALITY, width: 640, height: 360, screen: 'sandbox' });
  await waitRun(page);
  await page.eval('__qa.freezeBots()');
  await waitLive(page);
  await page.waitFor('!__qa.ui.isVisible("loadout")', 8000, { label: '무기 선택 닫힘' });
  await lockPointer(page);
  return page;
}

/** 로드아웃 화면을 열어 진짜 클릭으로 이 무기를 고른다. 주무기는 카드, 보조·근접은 빠른 교체 줄이다 */
async function pickThroughLoadout(t, page, id, ruleset = 'classic') {
  const def = WEAPONS[id];
  await page.fn((o) => {
    const ids = o.ruleset === 'knife' ? o.melee : o.primary;
    window.__qa.ui.show('loadout', { weapons: ids, ruleset: o.ruleset, seconds: 0, selected: window.__qa.run.lastPick });
  }, { ruleset, melee: MELEE_IDS, primary: ruleset === 'sniper' ? PRIMARY_IDS.filter((x) => WEAPONS[x].kind === 'sniper') : PRIMARY_IDS });
  await page.waitFor('__qa.ui.isVisible("loadout") && !__qa.ctx.input.locked', 3000, { label: '무기 선택 화면이 잠금을 푼다' });
  const isCard = ruleset === 'knife' ? def.slot === 3 : def.slot === 1;
  if (isCard) {
    await page.click(`.sk-lo-card[title="${def.name}"]`);
  } else {
    await page.click(`.sk-lo-extra .sk-choice[title="${def.name}"]`);
    await page.eval('__qa.ui.hide("loadout")');
  }
  await page.waitFor('!__qa.ui.isVisible("loadout")', 3000, { label: '무기 선택 닫힘' });
  await lockPointer(page);
  await page.press(`Digit${def.slot}`);
  await page.waitFor(`__qa.arsenal.getWeapon().id === ${JSON.stringify(id)}`, 3000, { label: `${id} 들기` });
  await waitIdle(page);
  await page.waitFor(`__qa.world.internals.vm.getWeaponId() === ${JSON.stringify(id)}`, 2000, { label: `${id} 모형` });
  t.check((await page.eval('__qa.ctx.player.state.weapon')) === id, `${id}: 플레이어 상태의 무기`);
}

/** 총 하나의 사격·재장전을 검사한다 */
async function fireAndReload(t, page, id) {
  const def = WEAPONS[id];
  const s0 = await snap(page);
  t.check(s0.mag === def.mag && s0.reserve === def.reserve, `${id}: 처음 탄약`, s0);
  t.check(near(+(await page.eval(`document.querySelector('.sk-ammo-mag').textContent`)), def.mag, 0), `${id}: HUD 탄약`, await page.eval(`document.querySelector('.sk-ammo-mag').textContent`));
  await page.eval('__qa.clearLogs()');

  if (def.fire === 'auto') {
    await clickFire(page, 12);
    await waitTicks(page, 2);
  } else {
    await clickFire(page, 2);
    await waitTicks(page, def.fire === 'burst' ? 20 : 2);
  }
  const fired = await page.eval(`__qa.worldEvents.filter((e) => e.evt === 'fire')`);
  const s1 = await snap(page);
  const used = s0.mag - s1.mag;
  t.check(fired.length > 0 && fired.every((e) => e.weaponId === id), `${id}: 사격 이벤트`, fired.length);
  t.check(used === fired.length, `${id}: 쏜 만큼 탄이 준다`, { used, fired: fired.length });
  if (def.fire === 'auto') t.check(fired.length >= 2, `${id}: 누르는 동안 연사한다`, fired.length);
  if (def.fire === 'semi' || def.fire === 'bolt') t.check(fired.length === 1, `${id}: 한 번 눌러 한 발`, fired.length);
  if (def.fire === 'burst') t.check(fired.length === def.burst.count, `${id}: 한 번 눌러 ${def.burst.count}발`, fired.length);
  if (def.pellets > 1) t.check(fired[0].pellets === def.pellets, `${id}: 펠릿 ${def.pellets}개`, fired[0].pellets);
  else t.check(fired[0].pellets === 1, `${id}: 펠릿 1개`, fired[0].pellets);
  t.check(!!fired[0].origin && fired[0].hitKind !== undefined, `${id}: 사격 이벤트 내용`, fired[0]);
  if (def.fire === 'bolt') t.check(s1.state === 'bolt', `${id}: 쏜 뒤 볼트를 당긴다`, s1.state);

  await waitIdle(page);
  await page.press('KeyR');
  await page.waitFor('__qa.arsenal.getWeapon().state === "reload"', 3000, { label: `${id} 재장전 시작` });
  t.check(await page.eval(`document.querySelector('.sk-reload') && !document.querySelector('.sk-reload').hidden`), `${id}: HUD 재장전 막대`);
  await waitIdle(page, (def.reload + 2) * 1000 * 4);
  const s2 = await snap(page);
  t.check(s2.mag === def.mag, `${id}: 재장전으로 탄창이 찬다`, s2.mag);
  t.check(s2.reserve === def.reserve - used, `${id}: 예비탄이 줄어든다`, { reserve: s2.reserve, used });
}

/** 우클릭 조준과 FOV, 스코프 표시를 검사한다 */
async function zoomCheck(t, page, id) {
  const def = WEAPONS[id];
  const base = await page.eval('__qa.ctx.renderer.baseFov');
  if (!def.zoom) {
    await page.mouseDown(2);
    await waitTicks(page, 15);
    const s = await snap(page);
    await page.mouseUp(2);
    t.check(near(s.fov, base), `${id}: 줌이 없는 무기는 FOV가 그대로다`, s.fov);
    t.check(!(await page.eval('__qa.visible(".sk-scope")')), `${id}: 스코프가 뜨지 않는다`);
    return;
  }
  if (def.zoom.levels) {
    const [m1, m2] = def.zoom.levels;
    t.check((await snap(page)).zoom.level === 0, `${id}: 처음은 줌 아님`);
    await clickFire(page, 2, 2);
    await page.waitFor('__qa.arsenal.getZoom().progress >= 1', 3000, { label: '1단 줌' });
    await waitTicks(page, 3);
    let s = await snap(page);
    t.check(s.zoom.level === 1 && s.zoom.mag === m1, `${id}: 1단 ${m1}배`, s.zoom);
    t.check(near(s.fov, zoomFov(base, m1), 0.2), `${id}: 1단 FOV`, { fov: s.fov, want: zoomFov(base, m1) });
    t.check(await page.eval('__qa.visible(".sk-scope")'), `${id}: 스코프 오버레이`);
    t.check((await page.eval(`document.querySelector('.sk-scope-zoom .sk-zoom-num').textContent`)) === `×${m1}`, `${id}: 1단 배율 표시`);
    await t.shot(`${id}-zoom1`);
    await clickFire(page, 2, 2);
    await sleep(100);
    await page.waitFor(`Math.abs(__qa.ctx.renderer.camera.fov - ${zoomFov(base, m2)}) < 0.2`, 3000, { label: '2단 FOV' });
    s = await snap(page);
    t.check(s.zoom.level === 2 && s.zoom.mag === m2, `${id}: 2단 ${m2}배`, s.zoom);
    t.check((await page.eval(`document.querySelector('.sk-scope-zoom .sk-zoom-num').textContent`)) === `×${m2}`, `${id}: 2단 배율 표시`);
    t.check((await page.eval(`document.querySelectorAll('.sk-scope-zoom .sk-zoom-pips .is-on').length`)) === 2, `${id}: 단계 점 2개`);
    await t.shot(`${id}-zoom2`);
    await clickFire(page, 2, 2);
    await page.waitFor('__qa.arsenal.getZoom().progress <= 0', 3000, { label: '줌 해제' });
    await waitTicks(page, 3);
    s = await snap(page);
    t.check(s.zoom.level === 0 && near(s.fov, base), `${id}: 세 번째 우클릭으로 해제`, s);
    t.check(!(await page.eval('__qa.visible(".sk-scope")')), `${id}: 스코프가 사라진다`);
    // 쏘면 풀리고, 다음 우클릭은 1단부터다
    await clickFire(page, 2, 2);
    await clickFire(page, 2, 2);
    await page.waitFor('__qa.arsenal.getZoom().level === 2', 3000, { label: '다시 2단' });
    await clickFire(page, 2);
    await waitTicks(page, 3);
    t.check((await snap(page)).zoom.level === 0, `${id}: 사격하면 줌이 풀린다`);
    await waitIdle(page, 8000);
    await page.waitFor('__qa.arsenal.getZoom().progress <= 0', 3000, { label: '줌 해제' });
    await clickFire(page, 2, 2);
    await page.waitFor('__qa.arsenal.getZoom().progress >= 1', 3000, { label: '다시 1단' });
    t.check((await snap(page)).zoom.level === 1, `${id}: 사격 뒤 우클릭은 1단부터`);
    await clickFire(page, 2, 2);
    await clickFire(page, 2, 2);
    await page.waitFor('__qa.arsenal.getZoom().progress <= 0', 3000, { label: '줌 해제' });
    return;
  }
  await page.mouseDown(2);
  await page.waitFor('__qa.arsenal.getZoom().progress >= 1', 4000, { label: `${id} 줌` });
  await waitTicks(page, 3);
  const s = await snap(page);
  t.check(near(s.fov, zoomFov(base, def.zoom.mag), 0.2), `${id}: 조준 FOV ${def.zoom.mag}배`, { fov: s.fov, want: zoomFov(base, def.zoom.mag) });
  t.check(s.fov < base, `${id}: 조준하면 FOV가 줄어든다`, s.fov);
  const scope = await page.eval('__qa.visible(".sk-scope")');
  const ads = await page.eval('__qa.visible(".sk-ads")');
  const look = await page.eval('__qa.ctx.input.getLookScale()');
  t.check(look < 1, `${id}: 조준 중 감도가 줄어든다`, look);
  if (def.zoom.overlay === 'scope') {
    t.check(scope, `${id}: 스코프 오버레이`);
    t.check(await page.eval('__qa.arsenal.getZoom(__qa.ctx.renderer.baseFov).hideViewmodel'), `${id}: 스코프가 덮이면 무기 모형을 숨긴다`);
    await t.shot(`${id}-scope`);
  } else {
    t.check(!scope, `${id}: 스코프 오버레이가 없다`);
    const tag = await page.eval(`document.querySelector('.sk-ads .sk-zoom-num').textContent`);
    t.check(ads && tag === `×${def.zoom.mag}`, `${id}: 크로스헤어 옆 배율 표시`, { ads, tag });
    await t.shot(`${id}-ads`);
  }
  await page.mouseUp(2);
  await page.waitFor('__qa.arsenal.getZoom().progress <= 0', 3000, { label: `${id} 줌 해제` });
  await waitTicks(page, 3);
  t.check(near((await snap(page)).fov, base), `${id}: 놓으면 FOV가 돌아온다`);
  t.check(near(await page.eval('__qa.ctx.input.getLookScale()'), 1, 0.001), `${id}: 놓으면 감도가 돌아온다`);
}

async function inspectCheck(t, page, id) {
  await waitIdle(page);
  await sleep(150);
  await page.press('KeyF');
  await page.waitFor('__qa.world.internals.vm.isInspecting()', 3000, { label: `${id} 살펴보기` }).catch(() => t.check(false, `${id}: F로 살펴보기가 시작된다`));
  await t.shot(`${id}-inspect`);
  await page.press('Digit3');
  await waitTicks(page, 3);
  t.check(!(await page.eval('__qa.world.internals.vm.isInspecting()')), `${id}: 무기를 바꾸면 살펴보기가 끝난다`);
  await page.press(`Digit${WEAPONS[id].slot}`);
  await waitIdle(page);
}

async function meleeCheck(t, page, id) {
  const def = WEAPONS[id];
  for (const [kind, button, label] of [['slash', 0, '베기'], ['stab', 2, '강타']]) {
    await page.eval('__qa.clearLogs()');
    await clickFire(page, 2, button);
    await page.waitFor(`__qa.weaponEvents.some((e) => e.type === 'melee')`, 3000, { intervalMs: 20, label: `${id} ${label} 판정` });
    const evs = await page.eval(`__qa.weaponEvents.filter((e) => e.type === 'swing' || e.type === 'melee')`);
    const swing = evs.find((e) => e.type === 'swing');
    const hit = evs.find((e) => e.type === 'melee');
    const m = def.melee[kind];
    t.check(evs.filter((e) => e.type === 'swing').length === 1 && swing.kind === kind && swing.weaponId === id, `${id}: ${label} 동작`, evs);
    t.check(near(swing.duration, m.cooldown, 0.001) && near(swing.windup, m.windup, 0.001), `${id}: ${label} 쿨다운과 선딜`, swing);
    t.check(hit.at >= swing.at && hit.kind === kind && hit.damage === m.damage && near(hit.range, m.range, 0.001), `${id}: ${label} 판정 값`, hit);
    const shown = await page.eval(`__qa.worldEvents.filter((e) => e.evt === 'fire').map((e) => [e.weaponId, e.kind])`);
    t.check(shown.length === 1 && shown[0][0] === id && shown[0][1] === kind, `${id}: ${label} 월드 이벤트`, shown);
    if (kind === 'slash') await t.shot(`${id}-slash`);
    await waitIdle(page);
  }
  await sleep(100);
  await page.press('KeyF');
  await page.waitFor('__qa.world.internals.vm.isInspecting()', 3000, { label: `${id} 살펴보기` }).catch(() => t.check(false, `${id}: F로 칼을 살펴본다`));
  await t.shot(`${id}-inspect`);
  await clickFire(page, 2);
  await waitTicks(page, 2);
  t.check(!(await page.eval('__qa.world.internals.vm.isInspecting()')), `${id}: 베면 살펴보기가 끝난다`);
  await waitIdle(page);
}

async function grenadeCheck(t, page) {
  t.setSection('수류탄');
  await page.press('Digit4');
  await page.waitFor('__qa.arsenal.getWeapon().id === "gr_frag"', 3000, { label: '수류탄 들기' });
  await waitIdle(page);
  await page.eval('__qa.clearLogs()');
  await page.mouseDown(0);
  await waitTicks(page, 5);
  t.check((await page.eval('__qa.arsenal.getWeapon().state')) === 'prime', '누르는 동안 핀을 뽑고 있다');
  await page.mouseUp(0);
  await page.waitFor(`__qa.worldEvents.some((e) => e.evt === 'grenade')`, 3000, { label: '수류탄 던짐' });
  t.check((await page.eval('__qa.world.internals.nades.list().length')) === 1, '수류탄이 하나 날아간다');
  await t.shot('grenade-flying');
  await page.waitFor('__qa.arsenal.getWeapon().id !== "gr_frag"', 5000, { label: '던진 뒤 무기로 돌아옴' });
  t.check(await page.eval(`__qa.text('.sk-slots .sk-slot:nth-child(4) .sk-slot-nm') === '비어 있음'`), 'HUD 수류탄 칸이 빈다', await page.eval(`__qa.text('.sk-slots .sk-slot:nth-child(4) .sk-slot-nm')`));
  await page.press('Digit4');
  await waitTicks(page, 5);
  t.check((await page.eval('__qa.arsenal.getWeapon().id')) !== 'gr_frag', '다 던지면 수류탄 칸으로 바꿀 수 없다');
  await page.waitFor(`__qa.worldEvents.some((e) => e.evt === 'explosion')`, 8000, { intervalMs: 50, label: '폭발' });
  await t.shot('grenade-explosion');
  t.check((await page.eval('__qa.world.internals.nades.list().length')) === 0, '터지면 수류탄이 사라진다');

  await page.eval('__qa.arsenal.giveGrenade(1)');
  await waitTicks(page, 2);
  await page.press('Digit4');
  await page.waitFor('__qa.arsenal.getWeapon().id === "gr_frag"', 3000, { label: '수류탄 다시 들기' });
  await waitIdle(page);
  await page.eval('__qa.clearLogs()');
  await clickFire(page, 2, 2);
  await page.waitFor(`__qa.worldEvents.some((e) => e.evt === 'grenade')`, 3000, { label: '굴리기' });
  const roll = await page.eval(`__qa.worldEvents.find((e) => e.evt === 'grenade')`);
  t.check(roll.kind === 'underhand', '우클릭은 낮게 굴린다', roll);
  await page.waitFor('__qa.arsenal.getWeapon().id !== "gr_frag"', 5000, { label: '던진 뒤 무기로 돌아옴' });
}

async function switchCheck(t, page) {
  t.setSection('무기 교체');
  await page.eval('__qa.arsenal.giveGrenade(1)');
  await waitTicks(page, 2);
  for (const slot of [2, 3, 1, 4, 2]) {
    await page.press(`Digit${slot}`);
    await page.waitFor(`__qa.arsenal.getWeapon().slot === ${slot}`, 3000, { label: `${slot}번 키` });
    t.check((await page.eval('__qa.arsenal.getWeapon().state')) === 'draw', `${slot}번 키: 꺼내는 동작`);
    await page.waitFor(`document.querySelector('.sk-slots .sk-slot:nth-child(${slot})').classList.contains('is-active')`, 2000, { label: `HUD ${slot}번 칸` });
    await waitIdle(page);
  }
  const before = await page.eval('__qa.arsenal.getWeapon().slot');
  await page.wheel(120);
  await waitTicks(page, 3);
  const after = await page.eval('__qa.arsenal.getWeapon().slot');
  t.check(after !== before, '휠로 무기를 바꾼다', { before, after });
  await waitIdle(page);
  await page.press('Digit1');
  await waitIdle(page);
}

export default {
  name: 'weapons',
  title: '모든 무기의 사격, 재장전, 교체, 줌, 칼, 수류탄, 살펴보기, 규칙 제한',
  timeoutMs: 15 * 60 * 1000,
  async run(t) {
    const guns = [...PRIMARY_IDS, ...SECONDARY_IDS].filter((id) => !t.filter || id.includes(t.filter));
    let page = await startMatch(t, 'sandbox=alley&mode=ffa&ruleset=classic&bots=1&killtarget=50');
    let count = 0;
    for (const id of guns) {
      if (count > 0 && count % 6 === 0) page = await startMatch(t, 'sandbox=alley&mode=ffa&ruleset=classic&bots=1&killtarget=50');   // 개인전 5분 제한 안에서 돈다
      count++;
      t.setSection(id);
      await pickThroughLoadout(t, page, id);
      await t.shot(`${id}-held`);
      await fireAndReload(t, page, id);
      await zoomCheck(t, page, id);
      await inspectCheck(t, page, id);
      t.errorsOk(id);
    }
    if (t.filter) return;

    page = await startMatch(t, 'sandbox=alley&mode=ffa&ruleset=classic&bots=1&killtarget=50');
    for (const id of MELEE_IDS) {
      t.setSection(id);
      await pickThroughLoadout(t, page, id);
      await t.shot(`${id}-held`);
      await meleeCheck(t, page, id);
      t.errorsOk(id);
    }
    await pickThroughLoadout(t, page, 'ar_std');
    await grenadeCheck(t, page);
    await switchCheck(t, page);
    t.errorsOk('수류탄과 교체');

    t.setSection('칼전은 다른 슬롯을 막는다');
    page = await startMatch(t, 'sandbox=dojo&mode=ffa&ruleset=knife&bots=1&killtarget=50');
    const knifeInfo = await page.eval(`({ slots: __qa.arsenal.getAllowedSlots(), held: __qa.arsenal.getWeapon().slot, list: __qa.arsenal.getSlots().map((s) => [s.slot, s.id, s.allowed]), hud: [...document.querySelectorAll('.sk-slots .sk-slot')].map((e) => !e.hidden) })`);
    t.check(knifeInfo.slots.join() === '3' && knifeInfo.held === 3, '칼전은 처음부터 칼을 든다', knifeInfo);
    t.check(knifeInfo.list.filter((x) => x[2]).length === 1, '쓸 수 있는 슬롯이 하나다', knifeInfo);
    t.check(JSON.stringify(knifeInfo.hud) === JSON.stringify([false, false, true, false]), 'HUD에 칼 칸만 보인다', knifeInfo.hud);
    for (const slot of [1, 2, 4]) {
      await page.press(`Digit${slot}`);
      await waitTicks(page, 4);
      t.check((await page.eval('__qa.arsenal.getWeapon().slot')) === 3, `${slot}번 키로 다른 무기를 들 수 없다`);
    }
    await page.wheel(120);
    await waitTicks(page, 4);
    t.check((await page.eval('__qa.arsenal.getWeapon().slot')) === 3, '휠로 다른 무기를 들 수 없다');
    t.check(!(await page.eval(`__qa.world.setLocalLoadout('ar_std')`)), '칼전에서 총을 쥘 수 없다');
    t.check(!(await page.eval(`__qa.arsenal.select(1)`)), '칼전에서 코드로도 총을 고를 수 없다');
    const rejected = await page.eval(`(() => { const r = __qa.run.match; const me = __qa.world.localId; const b = __qa.run.bots[0].id; const a = r.claimHit({ attackerId: me, victimId: b, weaponId: 'ar_std', part: 'head', dist: 3, count: 1 }); const c = r.claimExplosion({ attackerId: me, center: { x: 0, y: 0, z: 0 }, victims: [{ id: b, dmg: 100 }] }); return [a[0] && a[0].reason, c[0] && c[0].reason]; })()`);
    t.check(rejected[0] === 'ruleset' && rejected[1] === 'ruleset', '방장 판정도 칼전에서 총과 수류탄을 거절한다', rejected);
    await pickThroughLoadout(t, page, 'ml_knife', 'knife');
    t.check((await page.eval('__qa.arsenal.getWeapon().id')) === 'ml_knife', '칼전 무기 선택 카드로 나이프를 고른다');
    await meleeCheck(t, page, 'ml_knife');
    t.errorsOk('칼전');

    t.setSection('스나전은 저격총과 칼만 쓴다');
    page = await startMatch(t, 'sandbox=longshot&mode=ffa&ruleset=sniper&bots=1&killtarget=50');
    const sniperInfo = await page.eval(`({ slots: __qa.arsenal.getAllowedSlots(), kind: __qa.arsenal.getWeapon().def.kind, hud: [...document.querySelectorAll('.sk-slots .sk-slot')].map((e) => !e.hidden) })`);
    t.check(sniperInfo.slots.join() === '1,3' && sniperInfo.kind === 'sniper', '스나전은 저격총을 든다', sniperInfo);
    t.check(JSON.stringify(sniperInfo.hud) === JSON.stringify([true, false, true, false]), 'HUD에 1·3번 칸만 보인다', sniperInfo.hud);
    for (const slot of [2, 4]) {
      await page.press(`Digit${slot}`);
      await waitTicks(page, 4);
      t.check((await page.eval('__qa.arsenal.getWeapon().slot')) === 1, `${slot}번 키로 다른 무기를 들 수 없다`);
    }
    t.check(!(await page.eval(`__qa.world.setLocalLoadout('ar_std')`)), '스나전에서 라이플을 쥘 수 없다');
    await page.press('Digit3');
    await page.waitFor('__qa.arsenal.getWeapon().slot === 3', 3000, { label: '칼 들기' });
    await waitIdle(page);
    t.errorsOk('스나전');
  }
};
