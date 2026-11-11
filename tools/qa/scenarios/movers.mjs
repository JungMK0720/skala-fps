/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 시나리오 23. 움직이는 지형을 실제 게임에서 검사한다. 상자가 주기대로 움직이고 그림이 충돌체를 따라가는지, 길에 선 사람을 밀고 가는지,
 *          리프트가 사람을 싣고 오르내리는지, 내려오는 셔터가 사람을 끼우지 않는지, 총알이 지금 자리의 상자에 맞는지 본다.
 *          가까이 오면 열리는 문(코인 노래방·한옥 민박)은 다가가면 열려 걸어서 지나가는지, 떠나면 닫히는지, 닫힌 문이 총알을 막는지, 봇도 문을 여는지 본다.
 */
import { LOW_QUALITY, lockPointer, openGame, richProfile, sleep, waitLive, waitRun, waitTicks } from '../kit.mjs';

/** 페이지에서: 움직이는 지형 목록 */
function moverList() {
  const map = window.__qa.ctx.map;
  const meshes = new Map(map.group.children.filter((o) => o.name.startsWith('mover:')).map((o) => [o.name.slice(6), o]));
  return map.movers.list.map((m) => {
    const s = m.spec, mesh = meshes.get(s.id);
    const c = m.collider;
    return {
      id: s.id, axis: s.axis, dist: s.dist, period: s.period, hold: s.hold, x: s.x, y: s.y, z: s.z, w: s.w, h: s.h, d: s.d,
      door: s.door ? { ...s.door } : null, open: m.open,
      off: m.off, box: { minX: c.minX, maxX: c.maxX, minY: c.minY, maxY: c.maxY, minZ: c.minZ, maxZ: c.maxZ },
      mesh: mesh ? { x: mesh.position.x, y: mesh.position.y, z: mesh.position.z, bands: mesh.children.length } : null
    };
  });
}

/**
 * 페이지에서: 게임 시계로 ms 동안 틱마다 플레이어를 지켜본다. id의 상자와 겹친 틱 수, 높이 범위, 땅에 붙어 있던 비율.
 * 벽시계가 아니라 지형의 시계(world.movers.time)로 잰다. 헤드리스 화면이 초당 10프레임 아래로 느려지면 루프가 한 프레임에
 * 6틱까지만 돌려 게임 시계가 벽시계보다 늦게 가는데, 지형은 게임 시계를 따라 움직이기 때문이다. seconds = 지켜본 게임 시간
 */
function watchPlayer({ ms, id }) {
  const qa = window.__qa, st = qa.ctx.player.state, world = qa.ctx.world;
  const m = world.movers.list.find((x) => x.spec.id === id);
  const out = { ticks: 0, seconds: 0, ground: 0, minY: Infinity, maxY: -Infinity, inside: 0, start: st.pos.slice(), end: null, carried: 0, offMin: Infinity, offMax: -Infinity };
  const R = 0.35;
  const t0 = world.movers.time;
  const giveUp = performance.now() + ms * 5 + 5000;   // 게임 시계가 아주 느리거나 멈췄을 때만 여기서 끝난다
  return new Promise((resolve) => {
    const off = qa.ctx.onTick(() => {
      out.ticks++;
      if (st.onGround) out.ground++;
      out.minY = Math.min(out.minY, st.pos[1]);
      out.maxY = Math.max(out.maxY, st.pos[1]);
      const c = m.collider;
      out.offMin = Math.min(out.offMin, m.off);
      out.offMax = Math.max(out.offMax, m.off);
      // 몸 원(반지름 R)이 상자 속으로 2 cm 넘게 들어가 있고 높이도 겹치면 끼인 것이다(윗면에 선 것은 뺀다)
      const qx = Math.max(c.minX, Math.min(c.maxX, st.pos[0])), qz = Math.max(c.minZ, Math.min(c.maxZ, st.pos[2]));
      const gap = Math.hypot(st.pos[0] - qx, st.pos[2] - qz);
      if (gap < R - 0.02 && st.pos[1] + 1.7 > c.minY && st.pos[1] + 0.46 < c.maxY) out.inside++;
      if (Math.abs(st.pos[1] - c.maxY) < 0.02) out.carried++;
    }, 950);
    const timer = setInterval(() => {
      out.seconds = world.movers.time - t0;
      if (out.seconds < ms / 1000 && performance.now() < giveUp) return;
      clearInterval(timer);
      off();
      out.end = st.pos.slice();
      resolve(out);
    }, 15);
  });
}

/** 페이지에서: 게임 시계(지형의 시계)로 seconds초가 지날 때까지 기다린다. → 실제로 지난 게임 시간 */
function waitGameSeconds({ seconds, timeoutMs }) {
  const st = window.__qa.ctx.world.movers;
  const t0 = st.time, end = performance.now() + timeoutMs;
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (st.time - t0 >= seconds || performance.now() > end) { clearInterval(timer); resolve(st.time - t0); }
    }, 20);
  });
}

/**
 * 페이지에서: 상자가 쉬는 자리(off ≈ at)에 올 때까지 기다린다.
 * arrive면 지금 그 자리에 있어도 한 번 떠났다가 돌아올 때까지 기다린다(쉬는 시간이 막 시작된 때를 잡는다. 얼마나 쉬었는지 모르는 채로 시작하지 않게)
 */
function waitOffset({ id, at, timeoutMs, arrive = false }) {
  const m = window.__qa.ctx.world.movers.list.find((x) => x.spec.id === id);
  return new Promise((resolve) => {
    const end = performance.now() + timeoutMs;
    let left = !arrive;
    const timer = setInterval(() => {
      const there = Math.abs(m.off - at) < 0.02;
      if (!there) left = true;
      if ((there && left) || performance.now() > end) { clearInterval(timer); resolve(there && left); }
    }, 30);
  });
}

async function openMap(t, mapId) {
  const page = await openGame(t, `sandbox=${mapId}&ruleset=classic&mode=ffa&bots=1&killtarget=50`, { profile: richProfile(), settings: LOW_QUALITY, width: 960, height: 540, screen: 'sandbox' });
  await waitRun(page);
  await page.eval('__qa.freezeBots(); __qa.run.bots[0].alive = false');
  await waitLive(page);
  await page.waitFor('!__qa.ui.isVisible("loadout")', 8000, { label: '무기 선택 닫힘' });
  await lockPointer(page);
  await waitTicks(page, 5);
  return page;
}

const near = (a, b, eps) => Math.abs(a - b) <= eps;

/** 문 맵을 연다. 봇 하나를 살려 둔 채 멈춰 세운다(문은 봇이 다가가도 열려야 한다) */
async function openDoorMap(t, mapId) {
  const page = await openGame(t, `sandbox=${mapId}&ruleset=classic&mode=ffa&bots=1&killtarget=50`, { profile: richProfile(), settings: LOW_QUALITY, width: 960, height: 540, screen: 'sandbox' });
  await waitRun(page);
  await page.eval('__qa.freezeBots()');
  await waitLive(page);
  await page.waitFor('!__qa.ui.isVisible("loadout")', 8000, { label: '무기 선택 닫힘' });
  await lockPointer(page);
  await waitTicks(page, 5);
  return page;
}

/** 페이지에서: 문 id의 열린 비율이 want(0 또는 1)가 될 때까지 기다린다 */
function waitDoor({ id, want, timeoutMs }) {
  const m = window.__qa.ctx.world.movers.list.find((x) => x.spec.id === id);
  return new Promise((resolve) => {
    const end = performance.now() + timeoutMs;
    const timer = setInterval(() => {
      if (m.open === want || performance.now() > end) { clearInterval(timer); resolve({ open: m.open, off: m.off }); }
    }, 20);
  });
}

/** 페이지에서: (from)에서 dir 쪽으로 쏜 레이가 무엇에 맞는가 */
function rayHit({ from, dir }) {
  const h = window.__qa.ctx.raycastWorld(from, dir, 30);
  return h ? { dist: h.dist, dynamic: !!(h.collider && h.collider.dynamic) } : null;
}

/**
 * 문 하나를 검사한다. door = moverList의 항목, side = 문 앞에서 문을 보는 쪽으로 나가는 단위 벡터 [x, z](문에서 바깥쪽),
 * far = 문이 열리지 않을 만큼 먼 자리, yaw = 바깥쪽에서 문을 보는 방향
 */
async function checkDoor(t, page, door, { side, yaw, label }) {
  const at = (dist) => [door.x + side[0] * dist, door.y, door.z + side[1] * dist];
  const range = door.door.range;
  const others = async () => (await page.fn(moverList)).filter((m) => m.id !== door.id && m.open > 0).map((m) => m.id);

  // 멀리서는 닫혀 있고 총알을 막는다
  const farPos = at(range + 1.2);
  await page.eval(`__qa.teleport(${farPos[0]}, ${farPos[1] + 0.05}, ${farPos[2]}, ${yaw})`);
  let d = await page.fn(waitDoor, { id: door.id, want: 0, timeoutMs: 4000 }, { timeoutMs: 8000 });
  t.check(d.open === 0 && d.off === 0, `${label}: 멀리 있으면 닫혀 있다`, d);
  let hit = await page.fn(rayHit, { from: [farPos[0], farPos[1] + 1.5, farPos[2]], dir: [-side[0], 0, -side[1]] });
  t.check(hit && hit.dynamic && near(hit.dist, range + 1.2, 0.2), `${label}: 닫힌 문이 총알을 막는다`, hit);

  // 다가가면 열리고 그림이 따라간다. 다른 문은 그대로다
  const nearPos = at(Math.min(1, range - 0.3));
  await page.eval(`__qa.teleport(${nearPos[0]}, ${nearPos[1] + 0.05}, ${nearPos[2]}, ${yaw})`);
  d = await page.fn(waitDoor, { id: door.id, want: 1, timeoutMs: 4000 }, { timeoutMs: 8000 });
  t.check(d.open === 1 && near(d.off, door.dist, 0.001), `${label}: 다가가면 다 열린다`, d);
  await waitTicks(page, 3);
  const now = (await page.fn(moverList)).find((m) => m.id === door.id);
  const want = { x: now.x + (now.axis === 'x' ? now.off : 0), z: now.z + (now.axis === 'z' ? now.off : 0) };
  t.check(now.mesh && near(now.mesh.x, want.x, 0.02) && near(now.mesh.z, want.z, 0.02) && now.mesh.bands === 1, `${label}: 그림이 문짝을 따라가고 문틀 띠가 있다`, { mesh: now.mesh, want });
  t.check((await others()).length === 0, `${label}: 다른 문은 닫혀 있다`, await others());
  hit = await page.fn(rayHit, { from: [nearPos[0], nearPos[1] + 1.5, nearPos[2]], dir: [-side[0], 0, -side[1]] });
  t.check(!hit || !hit.dynamic, `${label}: 열린 문으로 총알이 지나간다`, hit);

  // 앞으로 걸어 문을 지나간다(진짜 키 입력)
  const startPos = at(range + 0.6);
  await page.eval(`__qa.teleport(${startPos[0]}, ${startPos[1] + 0.05}, ${startPos[2]}, ${yaw})`);
  await page.fn(waitDoor, { id: door.id, want: 0, timeoutMs: 4000 }, { timeoutMs: 8000 });
  await waitTicks(page, 3);
  await page.key('KeyW', 'down');
  await sleep(1300);
  await page.key('KeyW', 'up');
  await waitTicks(page, 5);
  const pos = await page.eval('__qa.ctx.player.state.pos.slice()');
  const through = -((pos[0] - door.x) * side[0] + (pos[2] - door.z) * side[1]);   // 문 안쪽으로 들어간 거리
  t.check(through > 0.8, `${label}: 걸어가면 문이 열려 그대로 지나간다`, { pos, through });
  await t.shot(`${label}-through`);

  // 떠나면 닫힌다
  await page.eval(`__qa.teleport(${farPos[0]}, ${farPos[1] + 0.05}, ${farPos[2]}, ${yaw})`);
  d = await page.fn(waitDoor, { id: door.id, want: 0, timeoutMs: 5000 }, { timeoutMs: 9000 });
  t.check(d.open === 0, `${label}: 떠나면 닫힌다`, d);
}

export default {
  name: 'movers',
  title: '움직이는 지형: 미는 엄폐물, 리프트, 셔터, 가까이 오면 열리는 문',
  timeoutMs: 12 * 60 * 1000,
  async run(t) {
    /* ---------- 근접전 훈련장: 길을 오가는 표적판 ---------- */
    t.setSection('근접전 훈련장: 미는 엄폐물');
    let page = await openMap(t, 'cqb');
    let list = await page.fn(moverList);
    t.check(list.length >= 2 && list.every((m) => m.axis !== 'y'), '수평으로 움직이는 상자가 둘 이상 있다', list.map((m) => `${m.id}:${m.axis}`));
    t.check(list.every((m) => m.mesh && m.mesh.bands === 1), '상자마다 그림과 띠가 있다', list.map((m) => m.mesh));
    const a0 = list.map((m) => m.off);
    await page.fn(waitGameSeconds, { seconds: 3.2, timeoutMs: 40000 }, { timeoutMs: 50000 });
    list = await page.fn(moverList);
    t.check(list.some((m, i) => Math.abs(m.off - a0[i]) > 0.3), '시간이 지나면 자리가 바뀐다', { before: a0, after: list.map((m) => m.off) });
    for (const m of list) {
      const want = { x: m.x + (m.axis === 'x' ? m.off : 0), y: m.y + (m.axis === 'y' ? m.off : 0), z: m.z + (m.axis === 'z' ? m.off : 0) };
      // 그림은 직전 틱과 이번 틱 사이에 있으므로 한 틱 이동 거리(3 m/s ÷ 60)만큼은 다를 수 있다
      t.check(near(m.mesh.x, want.x, 0.08) && near(m.mesh.y, want.y, 0.08) && near(m.mesh.z, want.z, 0.08), `그림이 충돌체를 따라간다: ${m.id}`, { mesh: m.mesh, want });
    }

    // 길 한가운데에 서서 한 주기를 기다린다 → 밀려나고, 상자 속에 끼이지 않는다
    const sled = list.find((m) => m.axis === 'x') || list[0];
    const alongX = sled.axis === 'x';
    const mid = alongX ? [sled.x + sled.dist / 2, sled.y, sled.z] : [sled.x, sled.y, sled.z + sled.dist / 2];
    await page.fn(waitOffset, { id: sled.id, at: 0, timeoutMs: 20000 }, { timeoutMs: 30000 });
    await page.eval(`__qa.teleport(${mid[0]}, ${mid[1] + 0.05}, ${mid[2]})`);
    await waitTicks(page, 10);
    let w = await page.fn(watchPlayer, { ms: (sled.period / 2 + 0.5) * 1000, id: sled.id }, { timeoutMs: 60000 });
    const pushed = alongX ? w.end[0] - w.start[0] : w.end[2] - w.start[2];
    t.check(Math.abs(pushed) > 0.5 && Math.sign(pushed) === Math.sign(sled.dist), '길에 서 있으면 상자가 가는 쪽으로 밀려난다', { pushed, start: w.start, end: w.end });
    t.check(w.inside === 0, '밀리는 동안 상자 속에 끼이지 않는다', w);
    t.check(near(w.minY, sled.y, 0.06) && near(w.maxY, sled.y, 0.12), '밀려도 바닥에 서 있다', { minY: w.minY, maxY: w.maxY });
    t.check(!(await page.eval(`__qa.ctx.physics.overlapsCapsule(__qa.ctx.world, ${w.end[0]}, ${w.end[1]} + 0.5, ${w.end[2]}, 0.3, 1.25)`)), '멈춘 자리에서 벽에 끼이지 않는다', w.end);

    // 총알은 지금 자리의 상자에 맞는다
    list = await page.fn(moverList);
    const now = list.find((m) => m.id === sled.id);
    const cx = (now.box.minX + now.box.maxX) / 2, cz = (now.box.minZ + now.box.maxZ) / 2, cy = now.box.minY + 1.2;
    const from = alongX ? [cx, cy, now.box.maxZ + 2.5] : [now.box.maxX + 2.5, cy, cz];
    const dir = alongX ? [0, 0, -1] : [-1, 0, 0];
    const hit = await page.eval(`(() => { const h = __qa.ctx.raycastWorld(${JSON.stringify(from)}, ${JSON.stringify(dir)}, 20); return h ? { dist: h.dist, dynamic: !!(h.collider && h.collider.dynamic), tag: h.collider && h.collider.tag } : null; })()`);
    t.check(hit && hit.dynamic && near(hit.dist, 2.5, 0.2), '총알이 지금 자리의 상자에 맞는다', hit);
    await t.shot('cqb-sled');
    t.errorsOk('근접전 훈련장');

    /* ---------- 택배 분류 센터: 리프트 · 셔터 · 수레 ---------- */
    t.setSection('택배 분류 센터: 리프트');
    page = await openMap(t, 'sorthub');
    list = await page.fn(moverList);
    const lift = list.find((m) => m.axis === 'y' && Math.min(m.w, m.d) >= 1);
    const shutter = list.find((m) => m.axis === 'y' && Math.min(m.w, m.d) < 1);
    const cart = list.find((m) => m.axis !== 'y');
    t.check(!!lift && !!shutter && !!cart, '리프트·셔터·수레가 모두 있다', list.map((m) => `${m.id}:${m.axis}`));
    if (lift) {
      // 쉬는 자리(아래)에 막 내려왔을 때 올라타서 한 주기를 탄다(쉬는 시간이 얼마 안 남은 때에 타면 한 주기 뒤에는 다시 올라가는 중이다)
      await page.fn(waitOffset, { id: lift.id, at: 0, timeoutMs: 45000, arrive: true }, { timeoutMs: 55000 });
      const top0 = lift.y + lift.h;
      await page.eval(`__qa.teleport(${lift.x}, ${top0 + 0.05}, ${lift.z})`);
      await waitTicks(page, 15);
      w = await page.fn(watchPlayer, { ms: lift.period * 1000 + 300, id: lift.id }, { timeoutMs: 70000 });
      t.check(near(w.seconds, lift.period + 0.3, 0.2), '게임 시계로 한 주기를 지켜봤다', { seconds: w.seconds, ticks: w.ticks });
      t.check(near(w.maxY, top0 + lift.dist, 0.05), '리프트가 사람을 싣고 끝까지 올라간다', { maxY: w.maxY, want: top0 + lift.dist });
      t.check(near(w.end[1], top0, 0.3) && near(w.minY, top0, 0.06), '다시 내려와 바닥 높이로 돌아온다', { end: w.end, minY: w.minY, top0, seconds: w.seconds, ticks: w.ticks });
      t.check(w.ground / w.ticks > 0.97, '오르내리는 동안 발이 붙어 있다', { ground: w.ground, ticks: w.ticks });
      t.check(w.carried / w.ticks > 0.97, '발이 늘 리프트 윗면에 있다', { carried: w.carried, ticks: w.ticks });
      await t.shot('sorthub-lift');
    }

    if (shutter) {
      t.setSection('택배 분류 센터: 셔터');
      // 다 올라갔을 때(열림) 문턱 한가운데에 선다 → 닫히면서 옆으로 밀려나고 끼이지 않는다
      await page.fn(waitOffset, { id: shutter.id, at: shutter.dist, timeoutMs: 20000 }, { timeoutMs: 30000 });
      await page.eval(`__qa.teleport(${shutter.x}, ${shutter.y + 0.05}, ${shutter.z})`);
      await waitTicks(page, 5);
      w = await page.fn(watchPlayer, { ms: (shutter.period / 2 + 0.5) * 1000, id: shutter.id }, { timeoutMs: 60000 });
      const thin = shutter.w < shutter.d ? 0 : 2;
      const out = Math.abs(w.end[thin] - (thin === 0 ? shutter.x : shutter.z));
      t.check(out >= Math.min(shutter.w, shutter.d) / 2 + 0.3, '닫히는 셔터가 문턱에 선 사람을 옆으로 밀어낸다', { out, end: w.end });
      t.check(near(w.minY, shutter.y, 0.06) && near(w.maxY, shutter.y, 0.12), '밀려도 바닥에 서 있다', { minY: w.minY, maxY: w.maxY });
      t.check(w.inside <= 2, '셔터 속에 끼이지 않는다', w);
    }

    if (cart) {
      t.setSection('택배 분류 센터: 수레');
      const ax = cart.axis === 'x';
      const midC = ax ? [cart.x + cart.dist / 2, cart.y, cart.z] : [cart.x, cart.y, cart.z + cart.dist / 2];
      await page.fn(waitOffset, { id: cart.id, at: 0, timeoutMs: 20000 }, { timeoutMs: 30000 });
      await page.eval(`__qa.teleport(${midC[0]}, ${midC[1] + 0.05}, ${midC[2]})`);
      await waitTicks(page, 10);
      w = await page.fn(watchPlayer, { ms: (cart.period / 2 + 0.5) * 1000, id: cart.id }, { timeoutMs: 60000 });
      const moved = ax ? w.end[0] - w.start[0] : w.end[2] - w.start[2];
      t.check(Math.abs(moved) > 0.5 && Math.sign(moved) === Math.sign(cart.dist), '수레가 길에 선 사람을 밀고 간다', { moved, start: w.start, end: w.end });
      t.check(w.inside === 0, '수레 속에 끼이지 않는다', w);
    }
    t.errorsOk('택배 분류 센터');

    /* ---------- 코인 노래방: 가까이 오면 옆으로 열리는 자동문 ---------- */
    t.setSection('코인 노래방: 자동문');
    page = await openDoorMap(t, 'karaoke');
    list = await page.fn(moverList);
    t.check(list.length === 8 && list.every((m) => m.door && m.axis !== 'y'), '문 여덟이 모두 옆으로 여는 문이다', list.map((m) => `${m.id}:${m.axis}`));
    t.check(list.every((m) => m.open === 0 && m.off === 0), '스폰한 자리에서는 모든 문이 닫혀 있다', list.filter((m) => m.open > 0).map((m) => m.id));
    // 봇을 먼 카운터에 세워 두고(문이 열리지 않는 자리) 문을 본다
    await page.eval('__qa.placeBot(0, 13.9, 0, 0, 0)');
    await waitTicks(page, 10);
    const door1 = list.find((m) => m.id === 'door_1');
    const sideDoor = list.find((m) => m.id === 'door_1w');
    t.check(!!door1 && !!sideDoor, '1번 방 문과 옆문이 있다');
    if (door1) await checkDoor(t, page, door1, { side: [0, -1], yaw: Math.PI, label: 'karaoke-door-1' });
    if (sideDoor) await checkDoor(t, page, sideDoor, { side: [-1, 0], yaw: -Math.PI / 2, label: 'karaoke-door-1w' });
    // 봇이 다가가도 열린다(문은 살아 있는 사람이면 누구에게나 열린다)
    const door5 = list.find((m) => m.id === 'door_5');
    if (door5) {
      await page.eval('__qa.teleport(-13.9, 0.05, 0, 0)');
      await page.eval(`__qa.placeBot(0, ${door5.x}, 0, ${door5.z + 1}, 0)`);
      let d = await page.fn(waitDoor, { id: 'door_5', want: 1, timeoutMs: 4000 }, { timeoutMs: 8000 });
      t.check(d.open === 1, '봇이 문 앞에 서면 열린다', d);
      await page.eval('__qa.placeBot(0, 13.9, 0, 0, 0)');
      d = await page.fn(waitDoor, { id: 'door_5', want: 0, timeoutMs: 5000 }, { timeoutMs: 9000 });
      t.check(d.open === 0, '봇이 떠나면 닫힌다', d);
    }
    t.errorsOk('코인 노래방');

    /* ---------- 한옥 민박: 기단 위의 미닫이문 ---------- */
    t.setSection('한옥 민박: 미닫이문');
    page = await openDoorMap(t, 'hanok');
    list = await page.fn(moverList);
    t.check(list.length === 8 && list.every((m) => m.door && m.axis !== 'y'), '문 여덟이 모두 옆으로 여는 문이다', list.map((m) => `${m.id}:${m.axis}`));
    t.check(list.every((m) => m.open === 0), '스폰한 자리에서는 모든 문이 닫혀 있다', list.filter((m) => m.open > 0).map((m) => m.id));
    await page.eval('__qa.placeBot(0, 14.3, 0, 0, 0)');
    await waitTicks(page, 10);
    const hall = list.find((m) => m.id === 'door_hall_n');
    const back = list.find((m) => m.id === 'door_back_nw');
    t.check(!!hall && !!back, '대청 문과 건넌방 뒷문이 있다');
    // 마당(바닥 0)에서 기단(0.3) 위의 문으로: 문 바닥 높이가 달라도 알아본다
    if (hall) await checkDoor(t, page, { ...hall, y: 0 }, { side: [0, 1], yaw: 0, label: 'hanok-hall' });
    // 뒷문은 좁은 뒤안길(폭 2.6 m)에 있다. 뒤안길을 따라 다가가면 열리고 멀어지면 닫힌다
    if (back) {
      await page.eval(`__qa.teleport(${back.x + 5}, 0.05, -11.3, ${Math.PI / 2})`);
      let d = await page.fn(waitDoor, { id: back.id, want: 0, timeoutMs: 5000 }, { timeoutMs: 9000 });
      t.check(d.open === 0, '뒷문: 뒤안길 저쪽에 있으면 닫혀 있다', d);
      await page.eval(`__qa.teleport(${back.x}, 0.05, -11, ${Math.PI})`);
      d = await page.fn(waitDoor, { id: back.id, want: 1, timeoutMs: 4000 }, { timeoutMs: 8000 });
      t.check(d.open === 1, '뒷문: 문 앞에 서면 열린다', d);
      await page.key('KeyW', 'down');
      await sleep(900);
      await page.key('KeyW', 'up');
      await waitTicks(page, 5);
      const p = await page.eval('__qa.ctx.player.state.pos.slice()');
      t.check(p[2] > back.z + 0.8 && Math.abs(p[1] - 0.3) < 0.05, '뒷문: 걸어서 기단 위 방으로 들어간다', p);
      await t.shot('hanok-back-through');
    }
    const inside = await page.eval('__qa.ctx.player.state.pos.slice()');
    t.errorsOk('한옥 민박');
    t.note(`문은 화면마다 보이는 사람 위치로 여닫는다. 두 화면에서 같은 문이 같이 열리는지는 이 시나리오로는 보지 못했다(마지막 자리 ${inside.map((v) => v.toFixed(1)).join(', ')})`);
  }
};
