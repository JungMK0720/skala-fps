/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 시나리오 5. 표적 봇을 알려진 위치에 세우고 플레이어 시선을 머리·몸·다리·손·발에 돌려 진짜 무기를 쏜다. 부위 판정, 피해량, 반샷 표시, 라이플 헤드 1발, 칼, 수류탄, 피격과 부활을 검사한다.
 *          탄퍼짐은 이 시나리오의 대상이 아니라서 쏘는 순간만 Math.random을 0으로 고정한다(부위 판정을 흔들리지 않게 보려는 것이고 반동은 그대로다).
 *          사격 원점은 카메라 위치라서 쏘기 전에 눈높이가 가라앉기를 기다리고, 조준한 눈 위치에서 쏘는지도 함께 검사한다.
 */
import { WEAPONS, computeDamage, falloffMul } from '../../../js/weapons/defs.js';
import { LOW_QUALITY, clickFire, lockPointer, openGame, richProfile, sleep, waitIdle, waitLive, waitRun, waitTicks } from '../kit.mjs';

const RESPAWN_WAIT_MS = 15000;

/** 페이지에서: 맵에서 서로 보이는 가장 먼 두 자리를 찾는다. 눈에서 표적의 머리, 가슴, 발끝이 모두 보여야 한다 */
function longestSightLine(minDist) {
  const c = window.__qa.ctx, w = c.world, P = c.physics;
  const size = c.map.data.size;
  const spots = [];
  for (let x = -size.x / 2 + 3; x < size.x / 2 - 2; x += 6) {
    for (let z = -size.z / 2 + 3; z < size.z / 2 - 2; z += 6) {
      const y = P.getGroundY(w, x, z, Infinity, 0.4);
      if (!Number.isFinite(y) || y < -5 || y > 25 || !window.__qa.clearOfTriggers(x, z) || P.overlapsCapsule(w, x, y + 0.02, z, 0.4, 1.9)) continue;
      spots.push({ x, y, z });
    }
  }
  let best = null;
  for (const a of spots) {
    const eye = [a.x, a.y + 1.6, a.z];
    for (const b of spots) {
      const dist = Math.hypot(a.x - b.x, a.z - b.z);
      if (dist < minDist || (best && dist <= best.dist)) continue;
      if (P.lineOfSight(w, eye, [b.x, b.y + 1.62, b.z]) && P.lineOfSight(w, eye, [b.x, b.y + 1.2, b.z]) && P.lineOfSight(w, eye, [b.x, b.y + 0.06, b.z])) best = { a, b, dist };
    }
  }
  return best;
}

/** 페이지에서: 플레이어와 표적을 세우고 표적이 플레이어를 보게 한다 */
function stage({ a, b }) {
  const qa = window.__qa;
  qa.teleport(a.x, a.y, a.z);
  const yaw = Math.atan2(-(a.x - b.x), -(a.z - b.z));
  qa.placeBot(0, b.x, b.y, b.z, yaw);
  return true;
}

/** 표적이 살아 있고 부활 보호가 끝날 때까지 기다린 뒤 다시 세운다 */
async function readyTarget(page, pair) {
  await page.waitFor(`(() => { const v = __qa.run.match.state.players.find((p) => p.id === __qa.run.bots[0].id); return __qa.run.bots[0].alive && v && v.alive && !v.protect; })()`, RESPAWN_WAIT_MS, { label: '표적 부활과 보호 끝' });
  await page.fn(stage, pair);
  await waitTicks(page, 6);
}

/**
 * 쏘는 눈(카메라)이 선 눈높이에 가라앉을 때까지 기다린다. 사격 원점이 카메라 위치라서 순간이동 뒤 착지 출렁임이 남아 있으면
 * 조준한 높이와 다른 곳에서 쏜다. 느린 프레임에서 출렁임이 커지던 버그(engine/player.js LAND_SPRING_STEP)가 돌아오면 여기서 드러난다
 */
async function settleEye(t, page, label) {
  const off = '(() => { const p = __qa.ctx.player, P = __qa.ctx.consts.PLAYER; return p.getEye()[1] - p.state.pos[1] - (p.state.crouch ? P.CROUCH_EYE : P.EYE); })()';
  const ok = await page.waitFor(`Math.abs(${off}) < 1e-3`, 4000, { intervalMs: 50, label: `${label} 눈높이` }).then(() => true, () => false);
  t.check(ok, `${label}: 쏘기 전에 눈높이가 가라앉는다`, ok ? undefined : { offset: await page.eval(off) });
}

/** 무기를 쥐고 조준 준비를 한다. 조준경이 있으면 우클릭을 누른 채 끝까지 줌한다 */
async function ready(page, id, { ads }) {
  const def = WEAPONS[id];
  const held = await page.eval(`__qa.arsenal.getLoadout()[${JSON.stringify(def.slot === 1 ? 'primary' : def.slot === 2 ? 'secondary' : 'melee')}]`);
  if (held !== id) await page.fn((w) => window.__qa.world.setLocalLoadout(w), id);
  await waitTicks(page, 2);
  await page.press(`Digit${def.slot}`);
  await page.waitFor(`__qa.arsenal.getWeapon().id === ${JSON.stringify(id)}`, 3000, { label: `${id} 들기` });
  await waitIdle(page, 10000);
  await page.waitFor('Math.abs(__qa.arsenal.getRecoilKick().pitch) < 2e-4 && Math.abs(__qa.arsenal.getRecoilKick().yaw) < 2e-4', 8000, { label: '반동 회복' });
  if (ads && def.zoom) {
    await page.mouseDown(2);
    await page.waitFor('__qa.arsenal.getZoom().progress >= 1', 4000, { label: `${id} 줌` });
  }
}

/** 부위를 겨눠 쏜다. 맞을 거라고 판정 함수가 말한 부위와 실제 경기 이벤트를 돌려준다 */
async function shootPart(t, page, id, part, { ads = true, handIndex = 0 } = {}) {
  await ready(page, id, { ads });
  const def = WEAPONS[id];
  if (part === 'hand') {
    // 손 뒤에 몸통이 있으면 몸통으로 판정된다. 손끝만 맞는 각도가 되도록 표적을 옆으로 돌려 세운다
    await page.fn(() => {
      const qa = window.__qa, b = qa.run.bots[0];
      qa.placeBot(0, b.body.pos[0], b.body.pos[1], b.body.pos[2], b.yaw + Math.PI / 2);
    });
    await waitTicks(page, 6);
  }
  await settleEye(t, page, `${id} ${part}`);
  const aim = await page.fn(({ part: p, handIndex: h }) => {
    const qa = window.__qa;
    const point = qa.partPoint(qa.run.bots[0].id, p, h);
    return point ? qa.aimAt(point) : null;
  }, { part, handIndex });
  await waitTicks(page, 2);
  await page.eval('__qa.clearLogs(); window.__qaRng = () => 0');
  await clickFire(page, 2);
  await page.waitFor(`__qa.worldEvents.some((e) => e.evt === 'fire')`, 5000, { label: `${id} 사격` });
  await waitTicks(page, 3);
  await page.eval('window.__qaRng = null');
  if (ads && def.zoom) await page.mouseUp(2);
  const res = await page.eval(`(() => {
    const f = __qa.worldEvents.filter((e) => e.evt === 'fire')[0];
    const c = __qa.worldEvents.filter((e) => e.evt === 'hitClaim')[0];
    const d = __qa.match.filter((e) => e.type === 'damage')[0];
    const k = __qa.match.filter((e) => e.type === 'kill')[0];
    const r = __qa.match.filter((e) => e.type === 'reject');
    return { fire: f, claim: c, damage: d, kill: k, rejects: r, hp: __qa.run.bots[0].hp, alive: __qa.run.bots[0].alive };
  })()`);
  t.check(aim && aim.kind === 'player' && aim.part === part, `${id} ${part}: 조준선이 그 부위를 가리킨다`, aim);
  t.check(res.fire && res.fire.weaponId === id, `${id} ${part}: 그 무기로 쏜다`, res.fire);
  const drift = aim && res.fire && res.fire.origin ? Math.hypot(...res.fire.origin.map((v, i) => v - aim.eye[i])) : Infinity;
  t.check(drift < 0.005, `${id} ${part}: 조준한 눈 위치에서 쏜다`, { eye: aim && aim.eye, origin: res.fire && res.fire.origin });
  t.check(res.fire && res.fire.hitKind === 'player' && res.fire.part === part, `${id} ${part}: 탄이 그 부위를 맞힌다`, res.fire);
  t.check(res.claim && res.claim.part === part, `${id} ${part}: 주장 부위`, res.claim);
  t.check(res.rejects.length === 0, `${id} ${part}: 판정이 거절되지 않는다`, res.rejects);
  return { ...res, dist: aim ? aim.dist : 0 };
}

export default {
  name: 'damage',
  title: '부위별 피해, 라이플 헤드 1발, 저격 반샷 표시, 칼, 수류탄, 피격과 부활',
  timeoutMs: 15 * 60 * 1000,
  async run(t) {
    t.setSection('라이플 헤드 1발(먼 거리)');
    let page = await openGame(t, 'sandbox=longshot&ruleset=classic&mode=ffa&bots=1&killtarget=50', { profile: richProfile(), settings: LOW_QUALITY, width: 640, height: 360, screen: 'sandbox' });
    await waitRun(page);
    await page.eval('__qa.freezeBots()');
    await waitLive(page);
    await page.waitFor('!__qa.ui.isVisible("loadout")', 8000, { label: '무기 선택 닫힘' });
    await lockPointer(page);
    const far = await page.fn(longestSightLine, 40);
    t.check(!!far && far.dist >= 60, 'longshot에 60 m 넘는 시야선이 있다', far);
    if (!far) throw new Error('시야선을 찾지 못했어요');
    t.log(`   시야선 ${far.dist.toFixed(1)} m`);
    await readyTarget(page, far);
    for (const id of ['ar_std', 'ar_rapid', 'ar_line', 'ar_burst']) {
      const r = await shootPart(t, page, id, 'head');
      t.check(r.damage && r.damage.part === 'head' && r.damage.head && r.damage.amount === 100, `${id}: 먼 거리 머리 피해로 체력 100이 모두 닳는다`, r.damage);
      t.check(computeDamage(id, 'head', far.dist) === WEAPONS[id].damage.head, `${id}: 머리 피해는 거리 감쇠가 없다`);
      t.check(r.kill && r.kill.head === true, `${id}: 먼 거리 머리 1발 킬`, r.kill);
      t.check((await page.eval(`__qa.text('.sk-killfeed')`)).length > 0, `${id}: 킬피드가 뜬다`);
      if (id === 'ar_std') await t.shot('rifle-head-kill');
      await readyTarget(page, far);
    }

    t.setSection('라이플 몸은 거리 감쇠를 받는다');
    const body = await shootPart(t, page, 'ar_std', 'body');
    const wantBody = computeDamage('ar_std', 'body', body.claim ? body.claim.dist : far.dist);
    t.check(body.damage && body.damage.amount === wantBody, '몸 피해', { got: body.damage && body.damage.amount, wantBody });
    t.check(wantBody < WEAPONS.ar_std.damage.body && falloffMul(WEAPONS.ar_std.falloff, far.dist) < 1, '먼 거리 몸 피해는 표값보다 작다', wantBody);
    t.check(body.hp === 100 - wantBody, '표적 체력', body.hp);
    t.errorsOk('라이플');

    t.setSection('저격 몸·다리·머리');
    const finish = await shootPart(t, page, 'sr_bolt', 'body');
    t.check(finish.kill && !finish.kill.halfShot, '체력이 깎인 표적도 몸 1발에 쓰러진다', finish.kill);
    await readyTarget(page, far);
    for (const part of ['body', 'legs', 'head']) {
      const r = await shootPart(t, page, 'sr_bolt', part);
      t.check(r.damage && r.damage.part === part && r.damage.amount === 100 && !r.damage.halfShot, `SK-7 ${part}: 체력 100이 한 번에 닳는다`, r.damage);
      t.check(r.kill && !r.kill.halfShot, `SK-7 ${part} 1발 킬`, r.kill);
      t.check(r.kill && r.kill.head === (part === 'head'), `SK-7 ${part}: 킬피드 헤드샷 표시`, r.kill);
      if (part === 'body') await t.shot('sniper-body-kill');
      if (part === 'head') {
        const call = await page.eval(`[...document.querySelectorAll('.sk-callout')].map((c) => [c.textContent, c.dataset.tone]).filter((c) => /헤드샷/.test(c[0]))`);
        t.check(call.length === 1 && call[0][1] === 'head', '헤드샷 콜아웃', call);
      }
      await readyTarget(page, far);
    }

    t.setSection('저격 반샷');
    const hand = await shootPart(t, page, 'sr_bolt', 'hand');
    t.check(hand.damage && hand.damage.amount === 50 && hand.damage.part === 'hand' && hand.damage.halfShot === true, 'SK-7 손 피해 50, 반샷', hand.damage);
    t.check(!hand.kill && hand.alive && hand.hp === 50, '손에 맞으면 죽지 않는다', { hp: hand.hp, alive: hand.alive });
    const callout = await page.eval(`[...document.querySelectorAll('.sk-callout')].map((c) => [c.textContent, c.dataset.tone]).filter((c) => /반샷/.test(c[0]))`);
    t.check(callout.length === 1 && callout[0][0] === '반샷! −50' && callout[0][1] === 'half', '반샷 콜아웃', callout);
    t.check(await page.eval(`document.querySelector('.sk-hit').classList.contains('is-half')`), '히트마커 반샷 표시');
    t.check(!(await page.eval(`document.querySelector('.sk-hit').classList.contains('is-kill')`)), '히트마커 킬 표시는 없다');
    await t.shot('half-shot');
    await page.waitFor('__qa.arsenal.getWeapon().state === "idle"', 8000, { label: '볼트 끝' });

    const foot = await shootPart(t, page, 'sr_bolt', 'foot');
    t.check(foot.damage && foot.damage.amount === 50 && foot.damage.part === 'foot' && foot.damage.halfShot === true, 'SK-7 발 피해 50, 반샷', foot.damage);
    t.check(foot.kill && foot.kill.halfShot === true, '반샷 두 번이면 쓰러진다', foot.kill);
    const halfStat = await page.eval(`__qa.run.match.state.players.find((p) => p.id === __qa.world.localId).halfShots`);
    t.check(halfStat === 2, '경기 전적의 반샷 수', halfStat);
    t.check(await page.eval(`document.querySelector('.sk-hit').classList.contains('is-half') && document.querySelector('.sk-hit').classList.contains('is-kill')`), '반샷 킬은 두 표시가 함께 나온다');
    await readyTarget(page, far);

    t.setSection('다른 저격총');
    for (const id of ['sr_twin', 'sr_heavy']) {
      const h = await shootPart(t, page, id, 'hand');
      t.check(h.damage && h.damage.amount === WEAPONS[id].damage.hand && h.damage.halfShot === true, `${id} 손 반샷`, h.damage);
      t.check(h.alive, `${id}: 손에 맞으면 죽지 않는다`);
      const b2 = await shootPart(t, page, id, 'body');
      t.check(b2.damage && !b2.damage.halfShot && b2.kill, `${id} 몸 1발 킬`, b2.damage);
      await readyTarget(page, far);
    }
    const swiftBody = await shootPart(t, page, 'sr_swift', 'body');
    t.check(swiftBody.damage && swiftBody.damage.amount === WEAPONS.sr_swift.damage.body && !swiftBody.kill && swiftBody.alive, 'S-3 몸은 1발 킬이 아니다', swiftBody.damage);
    const swiftHand = await shootPart(t, page, 'sr_swift', 'hand');
    t.check(swiftHand.damage && swiftHand.damage.halfShot === true && swiftHand.kill, 'S-3 몸+손이면 쓰러진다', swiftHand.damage);
    t.errorsOk('저격');

    t.setSection('가까운 거리 부위표');
    page = await openGame(t, 'sandbox=alley&ruleset=classic&mode=ffa&bots=1&killtarget=50&botweapon=ar_std', { profile: richProfile(), settings: LOW_QUALITY, width: 640, height: 360, screen: 'sandbox' });
    await waitRun(page);
    await page.eval('__qa.freezeBots()');
    await waitLive(page);
    await page.waitFor('!__qa.ui.isVisible("loadout")', 8000, { label: '무기 선택 닫힘' });
    await lockPointer(page);
    // 항구 골목 광장 근처의 빈 땅에 세운다
    const open = await page.fn(() => {
      const c = window.__qa.ctx, w = c.world;
      for (let x = -30; x <= 30; x += 2) {
        for (let z = -18; z <= 18; z += 2) {
          const y = c.physics.findFloor(w, x, z);
          if (!(y >= -0.1 && y <= 0.1) || !window.__qa.clearOfTriggers(x, z)) continue;
          for (const [dx, dz] of [[6, 0], [-6, 0], [0, 6], [0, -6]]) {
            const bx = x + dx, bz = z + dz;
            const by = c.physics.findFloor(w, bx, bz);
            if (!(by >= -0.1 && by <= 0.1) || !window.__qa.clearOfTriggers(bx, bz)) continue;
            const eye = [x, y + 1.6, z];
            if (c.physics.lineOfSight(w, eye, [bx, by + 1.6, bz]) && c.physics.lineOfSight(w, eye, [bx, by + 0.05, bz]) && !c.physics.overlapsCapsule(w, x, y, z, 0.35, 1.8) && !c.physics.overlapsCapsule(w, bx, by, bz, 0.35, 1.8)) {
              return { a: { x, y, z }, b: { x: bx, y: by, z: bz }, dist: 6 };
            }
          }
        }
      }
      return null;
    });
    t.check(!!open, '가까운 표적을 세울 자리를 찾는다');
    if (!open) throw new Error('자리를 찾지 못했어요');
    await readyTarget(page, open);
    for (const id of ['dm_mark', 'sm_vx3', 'pt_std', 'pt_magnum', 'ar_burst']) {
      const r = await shootPart(t, page, id, 'legs');
      const want = computeDamage(id, 'legs', r.claim ? r.claim.dist : 6);
      t.check(r.damage && r.damage.amount === want, `${id} 다리 피해`, { got: r.damage && r.damage.amount, want });
      await sleep(600);   // 점사가 끝나고 표적 체력이 안정될 때까지
      // 다음 무기를 위해 체력을 채우려면 한 번 쓰러뜨린다
      if (await page.eval('__qa.run.bots[0].alive')) {
        const k = await shootPart(t, page, 'sr_heavy', 'body');
        t.check(!!k.kill, 'H-50 몸 1발 킬', k.damage);
      }
      await readyTarget(page, open);
    }

    t.setSection('샷건 펠릿');
    const sg = await shootPart(t, page, 'sg_bx12', 'body');
    t.check(sg.claim && sg.claim.count === 8, '탄퍼짐 없이 쏘면 8발이 모두 맞는다', sg.claim);
    t.check(sg.fire && sg.fire.pellets === 8, '펠릿 8개', sg.fire);
    t.check(computeDamage('sg_bx12', 'body', sg.claim ? sg.claim.dist : 6, undefined, 8) === 14 * 8, '가까운 샷건 몸 8발은 112');
    t.check(sg.damage && sg.damage.amount === 100 && sg.damage.count === 8 && sg.kill, '샷건 1발 킬', sg.damage);
    await readyTarget(page, open);

    t.setSection('칼');
    const closeIn = { a: open.a, b: { x: open.a.x + Math.sign(open.b.x - open.a.x) * 1.3, y: open.a.y, z: open.a.z + Math.sign(open.b.z - open.a.z) * 1.3 } };
    for (const [id, slashDmg] of [['ml_knife', 50], ['ml_gurkha', 55], ['ml_katana', 65]]) {
      await readyTarget(page, closeIn);
      await page.fn((w) => window.__qa.world.setLocalLoadout(w), id);
      await page.press('Digit3');
      await page.waitFor(`__qa.arsenal.getWeapon().id === ${JSON.stringify(id)}`, 3000, { label: `${id} 들기` });
      await waitIdle(page);
      await page.fn(() => { const qa = window.__qa; return qa.aimAt(qa.partPoint(qa.run.bots[0].id, 'body')); });
      await page.eval('__qa.clearLogs()');
      await clickFire(page, 2);
      await page.waitFor(`__qa.match.some((e) => e.type === 'damage')`, 3000, { label: `${id} 베기 피해` });
      const slash = await page.eval(`__qa.match.find((e) => e.type === 'damage')`);
      t.check(slash.amount === slashDmg && slash.weaponId === id && slash.kind === 'slash', `${id} 베기 피해 ${slashDmg}`, slash);
      await waitIdle(page);
      await page.eval('__qa.clearLogs()');
      await clickFire(page, 2);
      await page.waitFor(`__qa.match.some((e) => e.type === 'kill')`, 4000, { label: `${id} 베기 2번에 킬` });
      await waitIdle(page);
      await readyTarget(page, closeIn);
      await page.fn(() => { const qa = window.__qa; return qa.aimAt(qa.partPoint(qa.run.bots[0].id, 'body')); });
      await page.eval('__qa.clearLogs()');
      await clickFire(page, 2, 2);
      await page.waitFor(`__qa.match.some((e) => e.type === 'kill')`, 5000, { label: `${id} 강타 1번에 킬` });
      const stab = await page.eval(`__qa.match.find((e) => e.type === 'damage')`);
      t.check(stab.amount === 100 && stab.kind === 'stab' && stab.weaponId === id, `${id} 강타는 1번에 쓰러뜨린다`, stab);
      await waitIdle(page);
      await t.shot(`${id}-kill`);
    }
    t.errorsOk('칼');

    t.setSection('수류탄 피해');
    await readyTarget(page, open);
    await page.press('Digit1');
    await page.waitFor('__qa.arsenal.getWeapon().slot === 1', 3000, { label: '주무기' });
    await waitIdle(page);
    await page.eval('__qa.clearLogs()');
    // 표적 발밑에 터지게 던진다
    await page.fn(() => {
      const qa = window.__qa;
      const b = qa.run.bots[0];
      const eyeY = b.body.pos[1] + 1.0;
      qa.world.internals.nades.spawn([b.body.pos[0] + 0.6, eyeY, b.body.pos[2]], [0, 0, 0], { owner: qa.world.localId, fuse: 0.3, id: 'qa#1' });
    });
    await page.waitFor(`__qa.worldEvents.some((e) => e.evt === 'explosion')`, 5000, { intervalMs: 50, label: '폭발' });
    await waitTicks(page, 3);
    const blast = await page.eval(`__qa.match.filter((e) => e.type === 'damage' && e.victim === __qa.run.bots[0].id)`);
    t.check(blast.length === 1 && blast[0].amount >= 90, '가까운 폭발은 큰 피해를 준다', blast);
    t.check(blast.length === 1 && blast[0].weaponId === 'gr_frag', '폭발 피해 무기', blast);
    await sleep(1000);

    t.setSection('피격과 부활');
    await readyTarget(page, open);
    await page.eval('__qa.clearLogs()');
    // 표적이 플레이어를 겨누고 실제 무기로 쏘게 한다(botweapon=ar_std)
    await page.fn(() => {
      const qa = window.__qa, p = qa.ctx.player.state, b = qa.run.bots[0];
      const dx = p.pos[0] - b.body.pos[0], dz = p.pos[2] - b.body.pos[2], dy = (p.pos[1] + 1.2) - (b.body.pos[1] + 1.6);
      b.yaw = Math.atan2(-dx, -dz);
      b.pitch = Math.atan2(dy, Math.hypot(dx, dz));
      b.brain.think = (dt, view) => ({ forward: 0, strafe: 0, jump: false, walk: false, yawDelta: 0, pitchDelta: 0, fire: true, zoom: false, reload: view.self.ammo.mag === 0, slot: null });
    });
    const hpBefore = await page.eval('__qa.ctx.player.state.hp');
    await page.waitFor(`__qa.ctx.player.state.hp < ${hpBefore}`, 8000, { intervalMs: 50, label: '봇에게 맞음' });
    t.check(+(await page.eval(`__qa.text('.sk-hp-num')`)) < 100, 'HUD 체력이 줄어든다');
    await page.waitFor(`document.querySelectorAll('.sk-dmgs .sk-dmg').length > 0`, 3000, { intervalMs: 50, label: '피격 방향 표시' }).catch(() => t.check(false, '피격 방향 표시가 뜬다'));
    await t.shot('taking-damage');
    await page.waitFor('!__qa.world.localAlive', 20000, { intervalMs: 50, label: '봇에게 쓰러짐' });
    await page.fn(() => { const qa = window.__qa; qa.run.bots[0].brain.think = () => ({ forward: 0, strafe: 0, jump: false, walk: false, yawDelta: 0, pitchDelta: 0, fire: false, zoom: false, reload: false, slot: null }); });
    await waitTicks(page, 3);
    t.check(await page.eval('__qa.visible(".sk-rsp")'), '부활 패널이 뜬다');
    t.check(/당했어요/.test(await page.eval(`__qa.text('.sk-rsp-main')`)), '누구에게 당했는지 보인다', await page.eval(`__qa.text('.sk-rsp-main')`));
    t.check(await page.eval('__qa.ui.isVisible("loadout")'), '다음 무기를 고르는 작은 패널이 뜬다');
    t.check(await page.eval('__qa.ctx.input.locked'), '작은 패널은 포인터 잠금을 풀지 않는다');
    await t.shot('respawn-panel');
    const names = await page.eval(`[...document.querySelectorAll('.sk-lc-card')].length`);
    t.check(names >= 2, '작은 패널에 무기 카드가 있다', names);
    await page.press('Digit2');
    await waitTicks(page, 2);
    t.check(await page.eval(`document.querySelectorAll('.sk-lc-card')[1].classList.contains('is-sel')`), '숫자키로 다음 무기를 고른다');
    const nextPick = await page.eval('__qa.run.lastPick');
    // 연습장은 일시정지하면 부활 시간도 멈춘다
    await page.eval('document.exitPointerLock()');
    await page.waitFor('__qa.ui.isVisible("pause") && __qa.run.paused', 3000, { label: '일시정지' });
    const secondsBefore = await page.eval(`__qa.text('.sk-rsp-num')`);
    await sleep(2500);
    t.check((await page.eval(`__qa.text('.sk-rsp-num')`)) === secondsBefore, '일시정지 중에는 부활 숫자가 줄지 않는다', { secondsBefore, now: await page.eval(`__qa.text('.sk-rsp-num')`) });
    t.check(await page.eval('!__qa.world.localAlive'), '일시정지 중에는 부활하지 않는다');
    await page.click('.sk-pause-btns .sk-btn--primary');
    await page.waitFor('!__qa.ui.isVisible("pause") && !__qa.run.paused', 3000, { label: '계속하기' });
    await page.waitFor('__qa.world.localAlive', 10000, { intervalMs: 50, label: '부활' });
    await waitTicks(page, 2);
    const reborn = await page.eval(`({ hp: __qa.ctx.player.state.hp, weapon: __qa.arsenal.getLoadout().primary, loadout: __qa.ui.isVisible('loadout'), respawn: __qa.visible('.sk-rsp') })`);
    t.check(reborn.hp === 100, '부활하면 체력이 찬다', reborn);
    t.check(reborn.weapon === nextPick, '고른 무기로 부활한다', { reborn, nextPick });
    t.check(!reborn.loadout, '부활하면 작은 패널이 닫힌다', reborn);
    t.check(!reborn.respawn, '부활하면 부활 패널이 닫힌다', reborn);
    t.errorsOk('피격과 부활');

    t.setSection('즉시 부활(E)');
    // 다시 쓰러진 뒤 부활 패널의 'E 즉시 부활 · 5 P'를 보고 E를 누르면 3초를 기다리지 않고 나온다(연습장 = 봇 킬 보상 한 번).
    // 저절로 부활해도 값은 나가지 않으므로, 5 P가 줄었는지와 경기의 instant spawn이 즉시 부활의 증거다
    await readyTarget(page, open);
    await lockPointer(page);   // 일시정지에서 돌아온 뒤 잠금이 풀려 있으면 입력이 꺼져 E가 들어가지 않는다
    await page.fn(() => {
      const qa = window.__qa, p = qa.ctx.player.state, b = qa.run.bots[0];
      const dx = p.pos[0] - b.body.pos[0], dz = p.pos[2] - b.body.pos[2], dy = (p.pos[1] + 1.2) - (b.body.pos[1] + 1.6);
      b.yaw = Math.atan2(-dx, -dz);
      b.pitch = Math.atan2(dy, Math.hypot(dx, dz));
      b.brain.think = (dt, view) => ({ forward: 0, strafe: 0, jump: false, walk: false, yawDelta: 0, pitchDelta: 0, fire: true, zoom: false, reload: view.self.ammo.mag === 0, slot: null });
    });
    await page.waitFor('!__qa.world.localAlive', 20000, { intervalMs: 50, label: '봇에게 다시 쓰러짐' });
    // 부활(3초)이 저절로 오기 전에 한 번에 읽고 바로 누른다(느린 헤드리스에서는 화면을 찍는 동안 3초가 지날 수 있다)
    const dead = await page.fn(() => {
      const qa = window.__qa;
      qa.run.bots[0].brain.think = () => ({ forward: 0, strafe: 0, jump: false, walk: false, yawDelta: 0, pitchDelta: 0, fire: false, zoom: false, reload: false, slot: null });
      return { quick: qa.text('.sk-rsp-quick'), points: qa.ctx.account.profile.points, left: qa.text('.sk-rsp-num'), enabled: qa.ctx.input.enabled };
    });
    await page.press('KeyE');
    const quick = await page.waitFor('__qa.world.localAlive', 2500, { intervalMs: 50, label: '즉시 부활' }).then(() => true, () => false);
    t.check(/E\s*즉시 부활 · 5 P/.test(dead.quick), '부활 패널에 E 즉시 부활 · 5 P', dead);
    t.check(quick, 'E를 누르면 나온다', dead);
    const pointsBefore = dead.points;
    t.check((await page.eval('__qa.ctx.account.profile.points')) === pointsBefore - 5, '즉시 부활에 5 P를 낸다', { pointsBefore, now: await page.eval('__qa.ctx.account.profile.points') });
    t.check(await page.eval(`!__qa.visible('.sk-rsp') && __qa.ctx.player.state.hp === 100`), '부활 패널이 닫히고 체력이 찬다');
    t.check(await page.eval(`__qa.match.some((e) => e.type === 'spawn' && e.instant === true)`), '경기가 즉시 부활로 내보낸 spawn에 instant가 붙는다');
    t.errorsOk('즉시 부활(E)');

    t.setSection('내가 이기는 경기');
    page = await openGame(t, 'sandbox=alley&ruleset=knife&mode=ffa&bots=1&killtarget=5&difficulty=hard&timescale=2', { profile: { nickname: '테스터', points: 500, createdAt: 1 }, settings: LOW_QUALITY, width: 640, height: 360, screen: 'sandbox' });
    await waitRun(page);
    await page.eval('__qa.freezeBots()');
    await waitLive(page);
    await page.waitFor('!__qa.ui.isVisible("loadout")', 8000, { label: '무기 선택 닫힘' });
    await lockPointer(page);
    const near = await page.fn(() => {
      const c = window.__qa.ctx, w = c.world;
      for (let x = -30; x <= 30; x += 2) {
        for (let z = -18; z <= 18; z += 2) {
          const y = c.physics.findFloor(w, x, z);
          if (y !== 0 || c.physics.findFloor(w, x + 1.4, z) !== 0) continue;
          if (!window.__qa.clearOfTriggers(x, z) || !window.__qa.clearOfTriggers(x + 1.4, z)) continue;
          if (c.physics.overlapsCapsule(w, x, 0, z, 0.4, 1.9) || c.physics.overlapsCapsule(w, x + 1.4, 0, z, 0.4, 1.9)) continue;
          return { a: { x, y: 0, z }, b: { x: x + 1.4, y: 0, z } };
        }
      }
      return null;
    });
    for (let i = 0; i < 5; i++) {
      await readyTarget(page, near);
      await waitIdle(page);   // 첫 판은 칼을 꺼내는 중일 수 있다. 꺼내는 동안의 짧은 클릭은 받지 않는다
      await page.fn(() => { const qa = window.__qa; return qa.aimAt(qa.partPoint(qa.run.bots[0].id, 'body')); });
      await page.eval('__qa.clearLogs()');
      await clickFire(page, 2, 2);
      await page.waitFor(`__qa.match.some((e) => e.type === 'kill') || __qa.run.phase === 'matchEnd'`, 5000, { label: `${i + 1}번째 킬` }).catch(async (err) => {
        const why = await page.eval(`JSON.stringify({ state: __qa.arsenal.getWeapon().state, locked: __qa.ctx.input.locked, enabled: __qa.ctx.input.enabled, world: __qa.worldEvents.slice(-6), match: __qa.match.slice(-6), alive: __qa.world.localAlive, phase: __qa.run.phase, me: __qa.ctx.player.state.pos, bot: __qa.run.bots[0].body.pos })`);
        throw new Error(`${err.message} ${why}`);
      });
    }
    await page.waitFor('__qa.ui.isVisible("results")', 8000, { label: '결과 화면' });
    await sleep(1100);
    const won = await page.eval(`({ p: __qa.profile(), title: __qa.text('.sk-res-title'), verdict: __qa.text('.sk-res-verdict'), gain: __qa.text('.sk-res-gain-num'), lines: [...document.querySelectorAll('.sk-res-line')].map((l) => [l.children[0].textContent, l.children[1].textContent]), total: __qa.text('.sk-res-total') })`);
    t.check(won.p.stats.kills === 5 && won.p.stats.knifeKills === 5 && won.p.stats.wins === 1 && won.p.stats.matches === 1 && won.p.stats.deaths === 0, '내 전적', won.p.stats);
    // 5킬 판이라 승리 보상은 30 × 5/20 = 7.5 → 8 (account/economy.js FFA_FULL_WIN_KILLS)
    const gainedWin = Math.round((5 * 5 + Math.round(30 * 5 / 20) + 10) * 1.4);
    t.check(won.p.points === 500 + gainedWin, '승리와 난이도 보상', won.p.points);
    t.check(won.gain === `+${gainedWin}`, '결과 화면 획득 포인트', won.gain);
    t.check(won.lines.length === 4 && won.lines.some(([k]) => /킬 ×5/.test(k)) && won.lines.some(([k, v]) => k === '승리(5킬 판)' && v === '+8') && won.lines.some(([k]) => k === '완주') && won.lines.some(([k]) => /어려움/.test(k)), '보상 내역', won.lines);
    t.check(/테스터 우승/.test(won.title) && /내가 우승했어요/.test(won.verdict), '우승 문구', won);
    t.check(won.total.includes(String(500 + gainedWin)), '보유 포인트', won.total);
    await t.shot('player-won');
    t.errorsOk('내가 이기는 경기');
  }
};
