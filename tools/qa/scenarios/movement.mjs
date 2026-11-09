/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 시나리오 6. 진짜 키 입력과 게임 틱으로 이동을 검사한다. 스페이스 유지 버니합, A/D와 마우스 스윙 가속, HUD 속도계, 앉기·걷기, 그리고 새 맵 여섯의 발판·포털·비밀 스팟(한 번만 보상, 새로고침 유지)을 본다.
 */
import { MAPS } from '../../../js/maps/index.js';
import { LOW_QUALITY, lockPointer, openGame, readyGame, richProfile, sleep, waitLive, waitRun, waitTicks } from '../kit.mjs';

/** 맵마다 쓰는 규칙 */
const NEW_MAPS = [['alley', 'classic'], ['dojo', 'knife'], ['longshot', 'sniper'], ['nexus', 'classic'], ['rooftop', 'knife'], ['glasshouse', 'knife']];
const hypot3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const hypot2 = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]);

async function startMatch(t, mapId, ruleset, { clean = true } = {}) {
  const page = await openGame(t, `sandbox=${mapId}&ruleset=${ruleset}&mode=ffa&bots=1&killtarget=50`, { profile: richProfile({ points: 500 }), settings: LOW_QUALITY, width: 640, height: 360, screen: 'sandbox', clean, reusePage: !clean });
  await waitRun(page);
  await page.eval('__qa.freezeBots()');
  await waitLive(page);
  await page.waitFor('!__qa.ui.isVisible("loadout")', 8000, { label: '무기 선택 닫힘' });
  await lockPointer(page);
  // 표적 봇이 판정에 끼지 않게 땅속 멀리 치운다
  await page.eval('__qa.run.bots[0].alive = false');
  return page;
}

/** 페이지에서: 발판·포털을 지나지 않는 가장 긴 평지 직선을 찾는다 */
function findRunway(minLen) {
  const c = window.__qa.ctx, w = c.world, P = c.physics;
  const size = c.map.data.size;
  const trig = w.triggers;
  const crossesTrigger = (x, z) => [...trig.pads, ...trig.portals].some((p) => x > p.minX - 1 && x < p.maxX + 1 && z > p.minZ - 1 && z < p.maxZ + 1);
  let best = null;
  for (let x = -size.x / 2 + 2; x < size.x / 2; x += 3) {
    for (let z = -size.z / 2 + 2; z < size.z / 2; z += 3) {
      const y = P.findFloor(w, x, z);
      if (!Number.isFinite(y) || P.overlapsCapsule(w, x, y + 0.05, z, 0.4, 1.8)) continue;
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        const dx = Math.cos(a), dz = Math.sin(a);
        const hit = P.raycastWorld(w, [x, y + 1, z], [dx, 0, dz], 90);
        const hit2 = P.raycastWorld(w, [x + dz * 2, y + 1, z - dx * 2], [dx, 0, dz], 90);
        const hit3 = P.raycastWorld(w, [x - dz * 2, y + 1, z + dx * 2], [dx, 0, dz], 90);
        const len = Math.min(hit ? hit.dist : 90, hit2 ? hit2.dist : 90, hit3 ? hit3.dist : 90);
        if (len < minLen || (best && len <= best.len)) continue;
        let flat = true;
        for (let d = 0; d < len && flat; d += 2) {
          const px = x + dx * d, pz = z + dz * d;
          const fy = P.findFloor(w, px, pz);
          if (!Number.isFinite(fy) || Math.abs(fy - y) > 0.2 || crossesTrigger(px, pz)) flat = false;
        }
        if (flat) best = { x, y, z, dx, dz, len, yaw: Math.atan2(-dx, -dz) };
      }
    }
  }
  return best;
}

/** 페이지에서: 프레임마다 속력과 HUD 속도계를 기록한다 */
function startSpeedRecorder() {
  const qa = window.__qa;
  if (qa.recOff) qa.recOff();
  const rec = qa.rec = { max: 0, hudMax: 0, hudOnFrames: 0, frames: 0, maxWhileHud: 0 };
  qa.recOff = qa.ctx.onFrame(() => {
    const s = qa.ctx.player.state.speed;
    rec.frames++;
    if (s > rec.max) rec.max = s;
    if (document.querySelector('.sk-speed').classList.contains('is-on')) {
      rec.hudOnFrames++;
      const v = parseFloat(document.querySelector('.sk-speed-num').textContent);
      if (v > rec.hudMax) rec.hudMax = v;
    }
  }, 900);
}

async function placeOn(page, runway) {
  await page.fn((r) => {
    const qa = window.__qa;
    qa.teleport(r.x, r.y, r.z, r.yaw);
    qa.ctx.player.state.onGround = true;
  }, runway);
  await waitTicks(page, 5);
}

/** 눌렀던 키를 모두 뗀다 */
async function releaseKeys(page) {
  for (const code of ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft', 'KeyC']) await page.key(code, 'up');
}

/** 마우스를 ms 동안 dir 쪽으로 돌린다. 포인터 잠금 중이라 위치 차이가 그대로 시점이 된다 */
async function turnMouse(page, dir, ms, pxPerSec, state) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    state.x += dir * pxPerSec * 0.03;
    await page.mouseMove(state.x, state.y);
    await sleep(30);
  }
}

async function hopCheck(t, page) {
  t.setSection('스페이스 유지 버니합');
  const runway = await page.fn(findRunway, 12);
  t.check(!!runway, '넓은 평지를 찾는다');
  if (!runway) return null;
  await placeOn(page, runway);
  await page.eval('__qa.clearLogs()');
  await page.key('Space', 'down');
  await page.waitFor(`__qa.busCount('player:jump') >= 4`, 15000, { intervalMs: 50, label: '점프 4번' });
  const held = await page.eval(`({ jumps: __qa.busCount('player:jump'), lands: __qa.bus.filter((e) => e.evt === 'player:land').length, hopped: __qa.bus.filter((e) => e.evt === 'player:land' && e.hopped).length, chain: __qa.bus.filter((e) => e.evt === 'player:jump' && e.hopped).length })`);
  await page.key('Space', 'up');
  t.check(held.jumps >= 4 && held.lands >= 3, '꾹 누르면 계속 뛴다', held);
  t.check(held.chain >= 3, '착지 즉시 다시 뛰어 사슬이 이어진다', held);
  await page.waitFor('__qa.ctx.player.state.onGround', 3000, { intervalMs: 30, label: '착지' });
  await waitTicks(page, 10);
  const jumpsAfter = await page.eval(`__qa.busCount('player:jump')`);
  await waitTicks(page, 60);
  t.check((await page.eval(`__qa.busCount('player:jump')`)) === jumpsAfter, '떼면 더 뛰지 않는다');
  t.check(await page.eval('__qa.ctx.player.state.onGround'), '떼면 땅에 머문다');
  return runway;
}

async function strafeCheck(t, page, runway) {
  const moveMul = await page.eval('__qa.arsenal.getMoveMul()');
  const walk = await page.eval(`__qa.ctx.consts.PLAYER.WALK`) * moveMul;
  const cap = await page.eval(`__qa.ctx.consts.MOVE.MAX_SPEED`);

  t.setSection('걷기 속도');
  await placeOn(page, runway);
  await page.fn(startSpeedRecorder);
  await page.key('KeyW', 'down');
  await waitTicks(page, 40);
  await page.key('KeyW', 'up');
  const walked = await page.eval('__qa.rec.max');
  t.check(Math.abs(walked - walk) < 0.3, '걸으면 걷기 속도까지만 난다', { walked, walk });
  t.check(await page.eval(`!document.querySelector('.sk-speed').classList.contains('is-on')`) || walk > 5.5, '걷기 속도에서는 속도계가 꺼져 있다');

  t.setSection('A/D만 흔들기');
  await placeOn(page, runway);
  await page.fn(startSpeedRecorder);
  await page.key('KeyW', 'down');
  await page.key('Space', 'down');
  await waitTicks(page, 20);
  await page.key('KeyW', 'up');
  for (let i = 0; i < 10; i++) {
    const key = i % 2 ? 'KeyA' : 'KeyD';
    await page.key(key, 'down');
    await waitTicks(page, 20);
    await page.key(key, 'up');
  }
  await page.key('Space', 'up');
  const swapped = await page.eval('__qa.rec.max');
  t.check(swapped > walk + 0.5, 'A/D만 흔들어도 걷기보다 빨라진다', { swapped, walk });
  await page.waitFor('__qa.ctx.player.state.onGround', 3000, { intervalMs: 30, label: '착지' });

  t.setSection('A/D + 마우스 스윙');
  await placeOn(page, runway);
  await page.fn(startSpeedRecorder);
  const mouse = { x: 320, y: 180 };
  await page.mouseMove(mouse.x, mouse.y);
  await page.key('KeyW', 'down');
  await page.key('Space', 'down');
  await waitTicks(page, 15);
  await page.key('KeyW', 'up');
  let shot = false;
  for (let i = 0; i < 8; i++) {
    const right = i % 2 === 0;
    await page.key(right ? 'KeyD' : 'KeyA', 'down');
    await turnMouse(page, right ? 1 : -1, 420, 400, mouse);
    await page.key(right ? 'KeyD' : 'KeyA', 'up');
    if (i === 5 && !shot) { shot = true; await t.shot('strafe-speedometer'); }
  }
  await page.key('Space', 'up');
  const rec = await page.eval('__qa.rec');
  t.log(`   걷기 ${walk.toFixed(2)} m/s, A/D만 ${swapped.toFixed(2)} m/s, 스윙 ${rec.max.toFixed(2)} m/s, 속도계 ${rec.hudMax}`);
  t.check(rec.max > walk + 1, 'A/D와 마우스를 함께 흔들면 걷기보다 크게 빨라진다', { rec, walk });
  t.check(rec.max <= cap + 0.01, '수평 속도는 상한을 넘지 않는다', { max: rec.max, cap });
  t.check(rec.hudOnFrames > 0, 'HUD 속도계가 켜진다', rec);
  t.check(rec.hudMax > 5.5 && Math.abs(rec.hudMax - rec.max) < 0.6, 'HUD 속도계 값이 실제 속력을 따른다', rec);
  await page.waitFor('__qa.ctx.player.state.onGround', 3000, { intervalMs: 30, label: '착지' });
  await page.fn(() => { window.__qa.recOff(); window.__qa.recOff = null; });
  await page.mouseMove(320, 180);
}

async function postureCheck(t, page, runway) {
  t.setSection('앉기와 천천히 걷기');
  await placeOn(page, runway);
  const moveMul = await page.eval('__qa.arsenal.getMoveMul()');
  await page.key('KeyC', 'down');
  await waitTicks(page, 15);
  t.check(await page.eval('__qa.ctx.player.state.crouch'), 'C를 누르면 앉는다');
  await page.fn(startSpeedRecorder);
  await page.key('KeyW', 'down');
  await waitTicks(page, 30);
  const crouchSpeed = await page.eval('__qa.rec.max');
  await page.key('KeyW', 'up');
  await page.key('KeyC', 'up');
  await waitTicks(page, 10);
  t.check(!(await page.eval('__qa.ctx.player.state.crouch')), 'C를 떼면 일어선다');
  t.check(Math.abs(crouchSpeed - 2.6 * moveMul) < 0.2, '앉아서 걷는 속도', crouchSpeed);
  await placeOn(page, runway);
  await page.fn(startSpeedRecorder);
  await page.key('ShiftLeft', 'down');
  await page.key('KeyW', 'down');
  await waitTicks(page, 30);
  const slow = await page.eval('__qa.rec.max');
  await page.key('KeyW', 'up');
  await page.key('ShiftLeft', 'up');
  t.check(Math.abs(slow - 2.4 * moveMul) < 0.2, 'Shift로 천천히 걷는 속도', slow);
  await page.fn(() => { window.__qa.recOff(); window.__qa.recOff = null; });
}

/** 페이지에서: 발판 뒤쪽에서 목표를 보고 걸어 들어갈 자리. 사람이 발판을 타는 방향이다. 없으면 null */
function padApproach(pad) {
  const c = window.__qa.ctx, w = c.world, P = c.physics;
  const reach = Math.max(pad.w, pad.d) / 2 + 1.2;
  const goal = pad.target || [pad.x + pad.vel[0], pad.y, pad.z + pad.vel[2]];
  const toGoal = Math.atan2(goal[2] - pad.z, goal[0] - pad.x);
  for (const off of [0, 0.4, -0.4, 0.8, -0.8]) {
    const a = toGoal + Math.PI + off;
    const dx = Math.cos(a), dz = Math.sin(a);
    const x = pad.x + dx * reach, z = pad.z + dz * reach;
    const y = P.getGroundY(w, x, z, pad.y + 0.5, 0.3);
    if (!Number.isFinite(y) || Math.abs(y - pad.y) > 0.05) continue;
    if (P.overlapsCapsule(w, x, y + 0.05, z, 0.4, 1.8)) continue;
    if (!P.lineOfSight(w, [x, y + 0.5, z], [pad.x, pad.y + 0.5, pad.z])) continue;
    return { x, y, z, yaw: Math.atan2(dx, dz) };
  }
  return null;
}

/** 발판을 타고 날아가 내린다. walk면 뒤에서 걸어 들어가고, 아니면 발판 가운데에 서서 아무것도 누르지 않는다 */
async function ridePad(t, page, pad, label, { walk = false } = {}) {
  await page.eval('__qa.clearLogs()');
  const approach = walk ? await page.fn(padApproach, pad) : null;
  if (approach) {
    await page.fn((a) => { const qa = window.__qa; qa.teleport(a.x, a.y, a.z, a.yaw); qa.ctx.player.state.onGround = true; }, approach);
    await waitTicks(page, 4);
    await page.key('KeyW', 'down');
  } else {
    await page.fn((p) => { const qa = window.__qa; qa.teleport(p.x, p.y + 0.02, p.z); qa.ctx.player.state.onGround = true; }, pad);
  }
  await page.waitFor(`__qa.busCount('player:pad') >= 1`, 6000, { intervalMs: 20, label: `${label}: 발판 발동` });
  await page.key('KeyW', 'up');
  const launch = await page.eval('__qa.snapshot()');
  t.check(launch.vel[1] > 2 || !launch.onGround, `${label}: 발판이 띄워 올린다`, launch.vel);
  await page.waitFor(`__qa.bus.some((e) => e.evt === 'player:land')`, 12000, { intervalMs: 20, label: `${label}: 착지` });
  await waitTicks(page, 40);   // 착지한 뒤 미끄러짐이 멈추도록
  const s = await page.eval('__qa.snapshot()');
  if (pad.target) {
    // 내린 지점은 착지한 순간의 위치로 잰다. 그 뒤로는 관성으로 조금 미끄러진다
    const land = await page.eval(`__qa.bus.find((e) => e.evt === 'player:land')`);
    const d = hypot3(land.pos, pad.target);
    t.check(d < 1, `${label}: 목표 지점에 내린다(걸어 들어감: ${!!approach})`, { pos: land.pos, target: pad.target, d });
    t.check(Math.abs(s.pos[1] - pad.target[1]) < 0.3 && s.onGround, `${label}: 목표 높이에 머문다`, { pos: s.pos, target: pad.target });
    t.log(`   ${label}: 착지 지점이 목표에서 ${d.toFixed(2)} m, 걸어 들어감 ${!!approach}`);
  }
  return s;
}

/** 포털의 얇은 쪽으로 걸어 들어간다. 걸어 들어갈 자리가 없으면 안으로 옮긴다 */
async function enterPortal(page, portal, label) {
  const alongX = portal.w < portal.d;
  const entry = await page.fn(({ p, alongX: ax }) => {
    const c = window.__qa.ctx, w = c.world, P = c.physics;
    for (const side of [1, -1]) {
      const x = ax ? p.x + side * (p.w / 2 + 1) : p.x, z = ax ? p.z : p.z + side * (p.d / 2 + 1);
      const y = P.getGroundY(w, x, z, p.y + 0.5, 0.3);
      if (!Number.isFinite(y) || Math.abs(y - p.y) > 0.3 || P.overlapsCapsule(w, x, y + 0.05, z, 0.4, 1.8)) continue;
      return { x, y, z, yaw: ax ? Math.atan2(side, 0) : Math.atan2(0, side) };
    }
    return null;
  }, { p: portal, alongX });
  if (entry) {
    await page.fn((a) => { const qa = window.__qa; qa.teleport(a.x, a.y, a.z, a.yaw); qa.ctx.player.state.onGround = true; }, entry);
    await waitTicks(page, 4);
    await page.key('KeyW', 'down');
  } else {
    await page.fn((p) => { window.__qa.teleport(p.x, p.y + 0.1, p.z); }, portal);
  }
  await page.waitFor(`__qa.busCount('player:portal') >= 1`, 6000, { intervalMs: 20, label: `${label}: 포털 발동` });
  await page.key('KeyW', 'up');
  return !!entry;
}

async function triggersCheck(t, mapId, ruleset) {
  const data = MAPS[mapId];
  t.setSection(`${mapId}: 판정 표`);
  const page = await startMatch(t, mapId, ruleset);
  const trig = await page.eval(`(() => { const w = __qa.ctx.world.triggers; const pick = (p) => JSON.parse(JSON.stringify(p)); return { pads: w.pads.map(pick), portals: w.portals.map(pick), secrets: w.secrets.map(pick) }; })()`);
  t.check(trig.pads.length === data.pads.length, '발판이 모두 판정 표에 있다', trig.pads.length);
  t.check(trig.portals.length === data.portals.length, '포털이 모두 판정 표에 있다', trig.portals.length);
  t.check(trig.secrets.length === data.secrets.length && trig.secrets.length > 0, '비밀 스팟이 모두 판정 표에 있다', trig.secrets.length);
  const inside = (s, p) => p[0] >= s.minX && p[0] <= s.maxX && p[2] >= s.minZ && p[2] <= s.maxZ && p[1] >= s.minY - 0.1 && p[1] < s.maxY;

  t.setSection(`${mapId}: 비밀 스팟`);
  // 발판이나 포털로 실제로 갈 수 있는 경로가 있으면 그 길로 들어간다
  const secret = trig.secrets[0];
  const before = await page.eval('__qa.profile().points');
  await page.eval('__qa.clearLogs()');
  const padToSecret = trig.pads.find((p) => p.target && inside(secret, p.target));
  const portalToSecret = trig.portals.find((p) => inside(secret, [p.to.x, p.to.y, p.to.z]));
  if (padToSecret) {
    await ridePad(t, page, padToSecret, `${mapId} 비밀 발판`, { walk: true });
    t.log(`   ${mapId} 비밀: 발판으로 들어감`);
  } else if (portalToSecret) {
    await enterPortal(page, portalToSecret, `${mapId} 비밀 포털`);
    t.log(`   ${mapId} 비밀: 포털로 들어감`);
  } else {
    await page.fn((x) => { window.__qa.teleport(x.x, x.y + 0.3, x.z); }, secret);
    t.log(`   ${mapId} 비밀: 상자 안으로 옮김(발판·포털이 바로 닿지 않음)`);
  }
  await page.waitFor(`__qa.busCount('player:secret') >= 1`, 5000, { intervalMs: 20, label: `${mapId}: 비밀 스팟 발견` });
  await waitTicks(page, 3);
  const hitIds = await page.eval(`__qa.bus.filter((e) => e.evt === 'player:secret').map((e) => e.secret)`);
  const first = trig.secrets.find((x) => x.id === hitIds[0]);
  const reward = hitIds.reduce((sum, id) => sum + trig.secrets.find((x) => x.id === id).points, 0);
  const found = await page.eval('__qa.profile()');
  t.check(found.points === before + reward, `${mapId}: 포인트가 한 번 들어온다`, { before, now: found.points, reward, hitIds });
  t.check(!!(found.secrets[mapId] && found.secrets[mapId][hitIds[0]]), `${mapId}: 프로필에 기록된다`, found.secrets);
  await page.waitFor(`document.querySelector('.sk-hud-banner').classList.contains('is-show') && __qa.text('.sk-hud-banner-title') === '비밀 스팟 발견' && __qa.text('.sk-hud-banner-sub').includes(${JSON.stringify(`+${first.points} P`)})`, 8000, { intervalMs: 30, label: `${mapId}: 배너` });
  await t.shot(`${mapId}-secret-banner`);

  // 나갔다 다시 들어와도 같은 목숨에서는 다시 발동하지 않는다
  const pointsOnce = found.points;
  await page.fn((x) => { window.__qa.teleport(x.x + x.w, x.y + 5, x.z + x.d); }, first);
  await waitTicks(page, 3);
  await page.fn((x) => { window.__qa.teleport(x.x, x.y + 0.3, x.z); }, first);
  await waitTicks(page, 10);
  t.check((await page.eval('__qa.profile().points')) === pointsOnce, `${mapId}: 다시 들어가도 또 받지 않는다`);
  t.errorsOk(`${mapId} 비밀 스팟`);

  t.setSection(`${mapId}: 새로고침 뒤`);
  await page.reload();
  await readyGame(page, { screen: 'sandbox' });
  await waitRun(page);
  await page.eval('__qa.freezeBots(); __qa.run.bots[0].alive = false');
  await waitLive(page);
  await page.waitFor('!__qa.ui.isVisible("loadout")', 8000, { label: '무기 선택 닫힘' });
  const reloaded = await page.eval('__qa.profile()');
  t.check(reloaded.points === pointsOnce, `${mapId}: 새로고침해도 포인트가 그대로다`, reloaded.points);
  t.check(!!(reloaded.secrets[mapId] && reloaded.secrets[mapId][hitIds[0]]), `${mapId}: 새로고침해도 찾은 기록이 남는다`, reloaded.secrets);
  await page.eval('__qa.clearLogs()');
  await page.fn((x) => { window.__qa.teleport(x.x, x.y + 0.3, x.z); }, first);
  await page.waitFor(`__qa.busCount('player:secret') >= 1`, 5000, { intervalMs: 20, label: `${mapId}: 새로고침 뒤 다시 들어감` });
  await waitTicks(page, 3);
  t.check((await page.eval('__qa.profile().points')) === pointsOnce, `${mapId}: 새로고침 뒤 다시 들어가도 보상이 없다`);
  const calloutText = await page.eval(`[...document.querySelectorAll('.sk-callout')].map((c) => c.textContent).join('|')`);
  t.check(/이미 찾은 곳/.test(calloutText), `${mapId}: 이미 찾은 곳이라고 알려 준다`, calloutText);
  t.check(!(await page.eval(`document.querySelector('.sk-hud-banner').classList.contains('is-show')`)), `${mapId}: 다시 찾으면 배너가 뜨지 않는다`);
  t.errorsOk(`${mapId} 새로고침`);

  t.setSection(`${mapId}: 발판`);
  await lockPointer(page);
  if (!trig.pads.length) t.note(`${mapId}에는 발판이 없다(설계대로)`);
  else {
    await ridePad(t, page, trig.pads[0], `${mapId} 발판 0`);
    await sleep(450);   // 재발동 대기
    await ridePad(t, page, trig.pads[0], `${mapId} 발판 0`, { walk: true });
    await t.shot(`${mapId}-pad-landed`);
  }

  t.setSection(`${mapId}: 포털`);
  if (!trig.portals.length) t.note(`${mapId}에는 포털이 없다(설계대로)`);
  for (const portal of trig.portals.slice(0, 1)) {
    await sleep(1100);   // 포털 재발동 대기
    await page.eval('__qa.clearLogs()');
    const walked = await enterPortal(page, portal, mapId);
    const ev = await page.eval(`__qa.bus.find((e) => e.evt === 'player:portal')`);
    t.check(hypot3(ev.pos, [portal.to.x, portal.to.y, portal.to.z]) < 0.01, `${mapId}: 포털 도착지로 순간이동한다`, { pos: ev.pos, to: portal.to });
    await waitTicks(page, 20);
    const s = await page.eval('__qa.snapshot()');
    t.check(hypot2(s.pos, [portal.to.x, 0, portal.to.z]) < 1.5, `${mapId}: 도착지에 머문다`, { pos: s.pos, to: portal.to });
    t.check(s.onGround, `${mapId}: 도착지에 설 곳이 있다`, s.pos);
    if (Number.isFinite(portal.to.rotY)) t.check(Math.abs(Math.atan2(Math.sin(s.yaw - portal.to.rotY), Math.cos(s.yaw - portal.to.rotY))) < 0.02, `${mapId}: 도착 방향`, { yaw: s.yaw, want: portal.to.rotY });
    await t.shot(`${mapId}-portal-arrived`);
    t.log(`   ${mapId} 포털: 걸어 들어감 ${walked}`);
  }
  t.errorsOk(`${mapId} 발판과 포털`);
}

export default {
  name: 'movement',
  title: '버니합, 스윙 가속, 속도계, 앉기, 새 맵 여섯의 발판·포털·비밀 스팟',
  timeoutMs: 12 * 60 * 1000,
  async run(t) {
    const maps = NEW_MAPS.filter(([id]) => !t.filter || id.includes(t.filter));
    if (!t.filter) {
      const page = await startMatch(t, 'nexus', 'classic');
      try {
        const runway = await hopCheck(t, page);
        if (runway) {
          t.log(`   평지 ${runway.len.toFixed(1)} m`);
          await strafeCheck(t, page, runway);
          await postureCheck(t, page, runway);
        }
      } finally {
        await releaseKeys(page);
      }
      t.errorsOk('이동');
    }
    for (const [mapId, ruleset] of maps) await triggersCheck(t, mapId, ruleset);
  }
};
