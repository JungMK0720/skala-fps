/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 시나리오 23. 움직이는 지형을 실제 게임에서 검사한다. 상자가 주기대로 움직이고 그림이 충돌체를 따라가는지, 길에 선 사람을 밀고 가는지,
 *          리프트가 사람을 싣고 오르내리는지, 내려오는 셔터가 사람을 끼우지 않는지, 총알이 지금 자리의 상자에 맞는지 본다.
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
      off: m.off, box: { minX: c.minX, maxX: c.maxX, minY: c.minY, maxY: c.maxY, minZ: c.minZ, maxZ: c.maxZ },
      mesh: mesh ? { x: mesh.position.x, y: mesh.position.y, z: mesh.position.z, bands: mesh.children.length } : null
    };
  });
}

/** 페이지에서: ms 동안 틱마다 플레이어를 지켜본다. id의 상자와 겹친 틱 수, 높이 범위, 땅에 붙어 있던 비율 */
function watchPlayer({ ms, id }) {
  const qa = window.__qa, st = qa.ctx.player.state, world = qa.ctx.world;
  const m = world.movers.list.find((x) => x.spec.id === id);
  const out = { ticks: 0, ground: 0, minY: Infinity, maxY: -Infinity, inside: 0, start: st.pos.slice(), end: null, carried: 0, offMin: Infinity, offMax: -Infinity };
  const R = 0.35;
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
    setTimeout(() => { off(); out.end = st.pos.slice(); resolve(out); }, ms);
  });
}

/** 페이지에서: 상자가 쉬는 자리(off ≈ at)에 올 때까지 기다린다 */
function waitOffset({ id, at, timeoutMs }) {
  const m = window.__qa.ctx.world.movers.list.find((x) => x.spec.id === id);
  return new Promise((resolve) => {
    const end = performance.now() + timeoutMs;
    const timer = setInterval(() => {
      if (Math.abs(m.off - at) < 0.02 || performance.now() > end) { clearInterval(timer); resolve(Math.abs(m.off - at) < 0.02); }
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

export default {
  name: 'movers',
  title: '움직이는 지형: 미는 엄폐물, 리프트, 셔터',
  timeoutMs: 8 * 60 * 1000,
  async run(t) {
    /* ---------- 근접전 훈련장: 길을 오가는 표적판 ---------- */
    t.setSection('근접전 훈련장: 미는 엄폐물');
    let page = await openMap(t, 'cqb');
    let list = await page.fn(moverList);
    t.check(list.length >= 2 && list.every((m) => m.axis !== 'y'), '수평으로 움직이는 상자가 둘 이상 있다', list.map((m) => `${m.id}:${m.axis}`));
    t.check(list.every((m) => m.mesh && m.mesh.bands === 1), '상자마다 그림과 띠가 있다', list.map((m) => m.mesh));
    const a0 = list.map((m) => m.off);
    await sleep(3200);
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
      // 쉬는 자리(아래)에 왔을 때 올라타서 한 주기를 탄다
      await page.fn(waitOffset, { id: lift.id, at: 0, timeoutMs: 20000 }, { timeoutMs: 30000 });
      const top0 = lift.y + lift.h;
      await page.eval(`__qa.teleport(${lift.x}, ${top0 + 0.05}, ${lift.z})`);
      await waitTicks(page, 15);
      w = await page.fn(watchPlayer, { ms: lift.period * 1000 + 300, id: lift.id }, { timeoutMs: 60000 });
      t.check(near(w.maxY, top0 + lift.dist, 0.05), '리프트가 사람을 싣고 끝까지 올라간다', { maxY: w.maxY, want: top0 + lift.dist });
      t.check(near(w.end[1], top0, 0.3) && near(w.minY, top0, 0.06), '다시 내려와 바닥 높이로 돌아온다', { end: w.end, minY: w.minY, top0 });
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
  }
};
