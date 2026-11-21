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
  }, { ruleset, melee: MELEE_IDS, primary: ruleset === 'sniper' ? PRIMARY_IDS.filter((x) => WEAPONS[x].kind === 'sniper') : PRIMARY_IDS.filter((x) => !WEAPONS[x].zombieOnly) });
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
  const premium = def.reserve === Infinity;
  t.check(s0.mag === def.mag && s0.reserve === (premium ? 'unlimited' : def.reserve), `${id}: 처음 탄약`, s0);
  t.check(near(+(await page.eval(`document.querySelector('.sk-ammo-mag').textContent`)), def.mag, 0), `${id}: HUD 탄약`, await page.eval(`document.querySelector('.sk-ammo-mag').textContent`));
  await page.eval('__qa.clearLogs()');

  if (def.fire === 'auto') {
    await clickFire(page, Math.max(12, Math.ceil(def.fireInterval * 60 * 2.6)));   // 느린 자동 총(자동 샷건 0.3초)도 두 발 이상 나가게
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
  if (premium) t.check(s2.reserve === 'unlimited' && /∞/.test(await page.eval(`document.querySelector('.sk-ammo-res').textContent`)), `${id}: 프리미엄은 예비탄이 줄지 않고 ∞로 보인다`, s2.reserve);
  else t.check(s2.reserve === def.reserve - used, `${id}: 예비탄이 줄어든다`, { reserve: s2.reserve, used });
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
/** 페이지에서: 길 가운데에 서서 봇(b)을 본다 */
function stageMid({ a, b }) {
  const qa = window.__qa, c = qa.ctx, x = (a.x + b.x) / 2, z = (a.z + b.z) / 2;
  const y = c.physics.getGroundY(c.world, x, z, a.y + 1, 0.4);
  qa.teleport(x, Number.isFinite(y) ? y : a.y, z, Math.atan2(-(b.x - x), -(b.z - z)));
  return true;
}

/** 페이지에서: 서로 보이는 두 자리(나 · 봇) 중 minDist 이상에서 가장 가까운 쌍. 지금 내가 선 높이(골목 바닥)의 이어진 평지만(지붕 위 제외) */
function openLane(minDist) {
  const c = window.__qa.ctx, w = c.world, P = c.physics, size = c.map.data.size, y0 = c.player.state.pos[1];
  const spots = [];
  for (let x = -size.x / 2 + 3; x < size.x / 2 - 2; x += 3) {
    for (let z = -size.z / 2 + 3; z < size.z / 2 - 2; z += 3) {
      const y = P.getGroundY(w, x, z, Infinity, 0.4);
      if (!Number.isFinite(y) || Math.abs(y - y0) > 1 || !window.__qa.clearOfTriggers(x, z) || P.overlapsCapsule(w, x, y + 0.02, z, 0.4, 1.9)) continue;
      spots.push({ x, y, z });
    }
  }
  let best = null;
  for (const a of spots) {
    for (const b of spots) {
      const dist = Math.hypot(a.x - b.x, a.z - b.z);
      if (dist < minDist || Math.abs(a.y - b.y) > 0.3 || (best && dist >= best.dist)) continue;
      let flat = true;   // 가운데 바닥도 같은 높이(굴린 투척이 길에 멈춘다)
      for (const k of [0.25, 0.5, 0.75]) {
        const gy = P.getGroundY(w, a.x + (b.x - a.x) * k, a.z + (b.z - a.z) * k, a.y + 1, 0.4);
        if (!Number.isFinite(gy) || Math.abs(gy - a.y) > 0.3) flat = false;
      }
      if (flat && P.lineOfSight(w, [a.x, a.y + 1.6, a.z], [b.x, b.y + 1.62, b.z]) && P.lineOfSight(w, [a.x, a.y + 0.3, a.z], [b.x, b.y + 0.3, b.z])) best = { a, b, dist };
    }
  }
  return best;
}
/** 페이지에서: 나를 a에, 봇을 b에 세우고 서로 마주 보게 한다 */
function stageLane({ a, b }) {
  const qa = window.__qa;
  qa.teleport(a.x, a.y, a.z, Math.atan2(-(b.x - a.x), -(b.z - a.z)));
  qa.placeBot(0, b.x, b.y, b.z, Math.atan2(-(a.x - b.x), -(a.z - b.z)));
  return true;
}
/** 페이지에서: 봇 쪽으로 d m 앞 바닥을 본다(back이면 반대쪽) */
function aimGround({ d, back }) {
  const qa = window.__qa, p = qa.ctx.player.state.pos, b = qa.run.bots[0].body.pos;
  const dx = b[0] - p[0], dz = b[2] - p[2], L = Math.hypot(dx, dz) || 1, s = back ? -1 : 1;
  qa.aimAt([p[0] + (dx / L) * d * s, p[1] + (back ? 1.6 : 0), p[2] + (dz / L) * d * s]);
  return true;
}
const EYES = `(() => { const qa = __qa, b = qa.run.bots[0].body.pos; return { me: qa.ctx.player.getEye(), bot: [b[0], b[1] + 1.6, b[2]] }; })()`;

/** 연막탄·섬광탄: 진짜 로드아웃 줄로 쥐고 굴려 던져, 연기가 나와 봇 사이를 막았다 걷히고 섬광이 내 화면과 봇의 눈을 멀게 하는지 본다 */
async function tacticalCheck(t, page) {
  t.setSection('연막탄');
  // 긴 길(22 m 이상, 없으면 16 m): 가운데에서 던져 구름이 길 가운데에 서게 하고, 길 끝으로 물러나 구름 너머의 봇을 본다
  const lane = (await page.fn(openLane, 22)) || (await page.fn(openLane, 16));
  t.check(!!lane, '연막탄 시험 자리(서로 보이는 16 m 이상 평지)', lane);
  if (!lane) return;
  await page.fn(stageLane, lane);
  await waitTicks(page, 6);
  await pickThroughLoadout(t, page, 'gr_smoke');
  await t.shot('smoke-held');
  const clearBefore = await page.eval(`(() => { const e = ${EYES}; return !__qa.world.smokeBlocks(e.me, e.bot); })()`);
  t.check(clearBefore, '던지기 전에는 봇이 보인다');
  await page.fn(stageMid, lane);
  await waitTicks(page, 6);
  await page.fn(aimGround, { d: 1.5 });
  await page.eval('__qa.clearLogs()');
  await clickFire(page, 2, 2);
  await page.waitFor(`__qa.worldEvents.some((e) => e.evt === 'grenade' && e.kind === 'smoke')`, 3000, { label: '연막탄 던짐' });
  await page.waitFor(`__qa.worldEvents.some((e) => e.evt === 'smoke')`, 6000, { intervalMs: 50, label: '연기 구름' });
  t.check((await page.eval(`__qa.worldEvents.filter((e) => e.evt === 'explosion').length`)) === 0, '연막탄은 폭발 피해를 내지 않는다');
  await page.fn(stageLane, lane);
  await page.waitFor('(() => { const i = __qa.world.internals, l = i.smoke.list(i.clock); return l.length === 1 && l[0].age > 2.4; })()', 15000, { intervalMs: 100, label: '연기가 다 퍼짐' });
  t.check((await page.eval('__qa.world.internals.tfx.cloudCount')) === 1, '연기 구름이 하나 그려진다');
  const view = await page.eval(`(() => { const e = ${EYES}, i = __qa.world.internals; return { smoke: __qa.world.smokeBlocks(e.me, e.bot), wall: !__qa.ctx.physics.lineOfSight(__qa.ctx.world, e.me, e.bot), fog: i.tfx.fogAmount(), cloud: i.smoke.list(i.clock)[0].center }; })()`);
  t.check(view.smoke && !view.wall, '벽이 아니라 연기가 나와 봇 사이의 시선을 막는다', view);
  await page.fn(() => { const qa = window.__qa; return qa.aimAt(qa.partPoint(qa.run.bots[0].id, 'head')); });
  await waitTicks(page, 3);
  await t.shot('smoke-blocks-bot');
  // 봇을 풀어도 연기 너머의 나를 쏘지 못한다
  await page.eval('__qa.clearLogs(); __qa.unfreezeBots()');
  await sleep(2500);
  const hits = await page.eval(`__qa.match.filter((e) => e.type === 'damage' && e.victim === __qa.world.localId).length`);
  const botFire = await page.eval(`__qa.run.bots[0].brain.stats.shots`);
  await page.eval('__qa.freezeBots()');
  t.check(hits === 0, '봇은 연기 너머의 나를 맞히지 못한다', { hits, botFire });
  await page.waitFor('(() => { const i = __qa.world.internals; return i.smoke.list(i.clock).length === 0; })()', 60000, { intervalMs: 250, label: '연기가 걷힘' });
  await page.fn(stageLane, lane);
  await waitTicks(page, 6);
  const clearAfter = await page.eval(`(() => { const e = ${EYES}; return !__qa.world.smokeBlocks(e.me, e.bot); })()`);
  t.check(clearAfter, '연기가 걷히면 다시 보인다');
  t.errorsOk('연막탄');

  t.setSection('섬광탄');
  // 가까운 길(9 m 이상): 봇이 화면에 크게 보이게
  const near = (await page.fn(openLane, 9)) || lane;
  await page.fn(stageLane, near);
  await waitTicks(page, 6);
  await pickThroughLoadout(t, page, 'gr_flash');
  await t.shot('flash-held');
  await page.fn(aimGround, { d: 2 });
  await page.eval('__qa.clearLogs()');
  await clickFire(page, 2, 2);
  await page.waitFor(`__qa.worldEvents.some((e) => e.evt === 'grenade' && e.kind === 'flash')`, 3000, { label: '섬광탄 던짐' });
  await page.fn(aimGround, { d: 2 });   // 터지는 쪽을 본다
  await page.waitFor(`__qa.worldEvents.some((e) => e.evt === 'flash')`, 6000, { intervalMs: 20, label: '섬광' });
  await waitTicks(page, 3);
  const white = await page.eval('__qa.world.internals.tfx.blindAmount()');
  t.check(white >= 0.6, '바라본 섬광은 화면을 하얗게 만든다', { white });
  await t.shot('flash-whiteout');
  const botBlind = await page.eval(`(() => { const b = __qa.run.bots[0], a = __qa.world.internals.actors.get(b.id); return { until: b.blindUntil, badge: !!a && a.blindUntil > performance.now() }; })()`);
  t.check(botBlind.until > 0 && botBlind.badge, '마주 본 봇도 눈이 먼다(💫)', botBlind);
  t.check((await page.eval(`__qa.worldEvents.filter((e) => e.evt === 'explosion').length`)) === 0, '섬광탄은 폭발 피해를 내지 않는다');
  await page.waitFor('__qa.world.internals.tfx.blindAmount() === 0', 5000, { intervalMs: 50, label: '하얀 화면이 걷힘' });

  // 등을 돌린 채 터지면 나는 거의 멀쩡하고, 봇은 눈이 먼다
  await page.fn(stageLane, near);
  await waitTicks(page, 6);
  await page.eval('__qa.arsenal.giveGrenade(1)');
  await page.press('Digit4');
  await page.waitFor('__qa.arsenal.getWeapon().id === "gr_flash"', 3000, { label: '섬광탄 다시 들기' });
  await waitIdle(page);
  await page.fn(aimGround, { d: 2 });
  await page.eval('__qa.clearLogs()');
  await clickFire(page, 2, 2);
  await page.waitFor(`__qa.worldEvents.some((e) => e.evt === 'grenade' && e.kind === 'flash')`, 3000, { label: '섬광탄 던짐(2)' });
  await page.fn(aimGround, { d: 6, back: true });
  await page.waitFor(`__qa.worldEvents.some((e) => e.evt === 'flash')`, 6000, { intervalMs: 20, label: '섬광(2)' });
  await waitTicks(page, 3);
  const away = await page.eval('__qa.world.internals.tfx.blindAmount()');
  t.check(away < 0.6, '등을 돌리면 덜 하얗다', { away, facing: white });
  await sleep(450);
  await page.fn(() => { const qa = window.__qa; return qa.aimAt(qa.partPoint(qa.run.bots[0].id, 'head')); });
  await waitTicks(page, 3);
  const still = await page.eval(`(() => { const b = __qa.run.bots[0], a = __qa.world.internals.actors.get(b.id); return !!a && a.blindUntil > performance.now(); })()`);
  t.check(still, '돌아보면 봇은 아직 눈이 멀어 있다(💫)');
  await t.shot('bot-blinded');
  await page.eval(`__qa.world.setLocalLoadout('gr_frag')`);
  t.errorsOk('섬광탄');
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
    // 좀비 전용 무기(유탄 발사기·바주카포, defs zombieOnly)는 장비 화면에 없고 좀비 모드 증강으로만 얻는다(zombie 시나리오가 본다)
    // --filter throwables: 투척(수류탄·연막탄·섬광탄)만 본다
    if (t.filter === 'throwables') {
      const page = await startMatch(t, 'sandbox=alley&mode=ffa&ruleset=classic&bots=1&killtarget=50');
      await pickThroughLoadout(t, page, 'ar_std');
      await grenadeCheck(t, page);
      await tacticalCheck(t, page);
      t.errorsOk('투척');
      return;
    }
    const guns = [...PRIMARY_IDS, ...SECONDARY_IDS].filter((id) => !WEAPONS[id].zombieOnly && (!t.filter || id.includes(t.filter)));
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
    await tacticalCheck(t, page);

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
