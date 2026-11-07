/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 시나리오 7. 물리 소품을 검사한다. cannon-es가 CDN에서 오는지, 소품이 stats에 잡히는지, 폭발·총알·플레이어가 소품을 움직이는지, cannon-es를 막아도 고정 소품으로 게임이 도는지 본다.
 */
import { MAPS } from '../../../js/maps/index.js';
import { LOW_QUALITY, clickFire, lockPointer, qaInit, readyGame, richProfile, sleep, waitIdle, waitLive, waitRun, waitTicks } from '../kit.mjs';

/** 페이지에서: 지금 소품들의 위치. 그려지는 인스턴스 행렬을 읽는다 */
function propPositions() {
  const group = window.__qa.ctx.renderer.scene.getObjectByName('props');
  if (!group) return [];
  const out = [];
  for (const mesh of group.children) {
    for (let i = 0; i < mesh.count; i++) {
      const e = mesh.instanceMatrix.array;
      out.push({ mesh: mesh.name, i, pos: [e[i * 16 + 12], e[i * 16 + 13], e[i * 16 + 14]] });
    }
  }
  return out;
}

const moved = (a, b) => a.map((p, i) => Math.hypot(p.pos[0] - b[i].pos[0], p.pos[1] - b[i].pos[1], p.pos[2] - b[i].pos[2]));

async function open(t, mapId, { clean = true } = {}) {
  const page = t.page || await t.newPage();
  await page.open(`${t.base}?sandbox=${mapId}&ruleset=classic&mode=ffa&bots=1&killtarget=50&debug=1`, { width: 640, height: 360, clean, initScript: qaInit({ profile: richProfile(), settings: LOW_QUALITY }) });
  await readyGame(page, { screen: 'sandbox' });
  await waitRun(page);
  await page.eval('__qa.freezeBots()');
  await waitLive(page);
  await page.waitFor('!__qa.ui.isVisible("loadout")', 8000, { label: '무기 선택 닫힘' });
  await lockPointer(page);
  await page.eval('__qa.run.bots[0].alive = false');
  return page;
}

/** 소품 옆에서 폭발시킨다. 게임의 수류탄 경로를 그대로 탄다 */
async function blastNear(page, pos, fuse = 0.2) {
  await page.eval('__qa.clearLogs()');
  await page.fn(({ p, fuse: f }) => {
    const qa = window.__qa;
    qa.world.internals.nades.spawn([p[0] + 0.8, p[1] + 0.3, p[2] + 0.2], [0, 0, 0], { owner: qa.world.localId, fuse: f, id: `qa#${Math.random()}` });
  }, { p: pos, fuse });
  await page.waitFor(`__qa.worldEvents.some((e) => e.evt === 'explosion')`, 5000, { intervalMs: 30, label: '폭발' });
}

export default {
  name: 'props',
  title: '물리 소품: cannon-es, 폭발, 총알, 밀기, cannon-es 차단',
  timeoutMs: 6 * 60 * 1000,
  async run(t) {
    for (const mapId of ['nexus', 'alley']) {
      t.setSection(`${mapId}: cannon-es`);
      await t.newPage();
      const page = await open(t, mapId);
      await page.waitFor(`__qa.props.stats().mode === 'physics'`, 30000, { label: 'cannon-es 불러오기' });
      const cdn = page.requests.filter((r) => /cannon-es/.test(r.url));
      t.check(cdn.length >= 1 && cdn.every((r) => r.status === 200), 'cannon-es를 CDN에서 받는다', cdn);
      const want = MAPS[mapId].props.length;
      const stats = await page.eval('__qa.props.stats()');
      t.check(stats.total === want, '맵의 소품이 모두 올라온다', { stats, want });
      t.check(stats.statics > 0, '정적 충돌체가 만들어진다', stats);
      t.check(stats.drawCalls >= 1 && stats.drawCalls <= 2, '소품은 인스턴싱으로 그린다', stats);
      await page.waitFor(`__qa.props.stats().active === 0`, 20000, { label: '소품이 잠든다' });
      const rest = await page.fn(propPositions);
      t.check(rest.length === want, '소품 행렬을 읽는다', rest.length);
      t.check(rest.every((p) => p.pos.every(Number.isFinite) && p.pos[1] > -5), '소품이 제자리에 있다', rest.slice(0, 4));
      await t.shot(`${mapId}-props`);

      t.setSection(`${mapId}: 폭발`);
      const s0 = await page.eval('__qa.props.stats().steps');
      await waitTicks(page, 20);
      t.check((await page.eval('__qa.props.stats().steps')) === s0, '모두 잠들면 시뮬레이션을 돌리지 않는다');
      await blastNear(page, rest[0].pos);
      await waitTicks(page, 3);
      const awake = await page.eval('__qa.props.stats().active');
      t.check(awake > 0, '폭발이 소품을 깨운다', awake);
      t.check((await page.eval('__qa.props.stats().steps')) > s0, '폭발하면 시뮬레이션이 돈다');
      await sleep(800);
      const after = await page.fn(propPositions);
      const d = moved(rest, after);
      t.check(Math.max(...d) > 0.5, '폭발이 소품을 움직인다', d.map((v) => +v.toFixed(2)));
      await t.shot(`${mapId}-props-blast`);
      await page.waitFor(`__qa.props.stats().active === 0`, 30000, { label: '폭발 뒤 다시 잠든다' });
      const settled = await page.fn(propPositions);
      t.check(settled.every((p) => p.pos.every(Number.isFinite) && p.pos[1] > -5), '날아간 소품이 맵 안에 남는다', settled.filter((p) => !(p.pos[1] > -5)));

      t.setSection(`${mapId}: 총알`);
      // 소품 가까이 서서 진짜 총을 쏜다
      const stand = await page.fn((list) => {
        const c = window.__qa.ctx, w = c.world, P = c.physics;
        for (const prop of list) {
          for (let i = 0; i < 12; i++) {
            const a = (i / 12) * Math.PI * 2;
            const x = prop.pos[0] + Math.cos(a) * 4, z = prop.pos[2] + Math.sin(a) * 4;
            const y = P.getGroundY(w, x, z, prop.pos[1] + 1, 0.3);
            if (Math.abs(y - (prop.pos[1] - 0.45)) > 1 || P.overlapsCapsule(w, x, y + 0.05, z, 0.4, 1.8)) continue;
            if (!P.lineOfSight(w, [x, y + 1.6, z], prop.pos)) continue;
            return { prop, x, y, z };
          }
        }
        return null;
      }, settled);
      t.check(!!stand, '소품을 쏠 자리를 찾는다');
      if (stand) {
        await page.fn((s) => { const qa = window.__qa; qa.teleport(s.x, s.y, s.z); qa.ctx.player.state.onGround = true; }, stand);
        await waitTicks(page, 8);
        await waitIdle(page);
        await page.fn((p) => { window.__qa.aimAt(p); }, stand.prop.pos);
        const before = await page.fn(propPositions);
        await waitTicks(page, 2);
        await page.eval('window.__qaRng = () => 0');
        await clickFire(page, 2);
        await page.eval('window.__qaRng = null');
        await waitTicks(page, 20);
        const shotAfter = await page.fn(propPositions);
        const dShot = moved(before, shotAfter);
        t.check(Math.max(...dShot) > 0.02, '총알이 소품을 민다', dShot.map((v) => +v.toFixed(3)));
        await page.waitFor(`__qa.props.stats().active === 0`, 30000, { label: '총알 뒤 다시 잠든다' });

        t.setSection(`${mapId}: 플레이어가 민다`);
        const rest2 = await page.fn(propPositions);
        const target = rest2.find((p) => p.i === stand.prop.i && p.mesh === stand.prop.mesh) || rest2[0];
        const walk = await page.fn((p) => {
          const c = window.__qa.ctx, w = c.world, P = c.physics;
          for (let i = 0; i < 16; i++) {
            const a = (i / 16) * Math.PI * 2;
            const dx = Math.cos(a), dz = Math.sin(a);
            const x = p.pos[0] + dx * 1.6, z = p.pos[2] + dz * 1.6;
            const y = P.getGroundY(w, x, z, p.pos[1] + 0.8, 0.3);
            if (Math.abs(y - (p.pos[1] - 0.45)) > 0.7 || P.overlapsCapsule(w, x, y + 0.05, z, 0.4, 1.8)) continue;
            const ox = p.pos[0] - dx * 1.6, oz = p.pos[2] - dz * 1.6;     // 밀려 갈 쪽이 비어 있어야 한다
            if (!P.lineOfSight(w, [x, y + 0.5, z], [ox, y + 0.5, oz])) continue;
            return { x, y, z, yaw: Math.atan2(dx, dz) };
          }
          return null;
        }, target);
        if (walk) {
          await page.fn((s) => { const qa = window.__qa; qa.teleport(s.x, s.y, s.z, s.yaw); qa.ctx.player.state.onGround = true; }, walk);
          await waitTicks(page, 5);
          await page.key('KeyW', 'down');
          await waitTicks(page, 40);
          await page.key('KeyW', 'up');
          await waitTicks(page, 10);
          const pushed = moved(rest2, await page.fn(propPositions));
          t.check(Math.max(...pushed) > 0.05, '걸어 들어가면 소품이 밀린다', pushed.map((v) => +v.toFixed(3)));
        } else {
          t.note(`${mapId}: 밀어 볼 자리가 없어 플레이어 밀기를 건너뛰었다`);
        }
      }
      t.errorsOk(`${mapId} 소품`);
    }

    t.setSection('맵을 바꾸면 소품도 바뀐다');
    let page = t.page;
    await page.eval(`__qa.ctx.setScreen('menu')`);
    await page.waitFor(`__qa.ctx.screen === 'menu'`, 10000, { label: '메뉴' });
    t.check((await page.eval(`__qa.props.stats().total`)) === 0, '메뉴로 나오면 소품을 치운다');
    await page.eval(`__qa.ctx.setScreen('sandbox', { mapId: 'nexus', mode: 'ffa', ruleset: 'classic', bots: 1 })`);
    await waitRun(page);
    await page.waitFor(`__qa.props.stats().mode === 'physics'`, 15000, { label: '다음 맵 소품' });
    t.check((await page.eval(`__qa.props.stats().total`)) === MAPS.nexus.props.length, '다음 맵의 소품 수');
    t.errorsOk('맵 전환');

    t.setSection('cannon-es 차단');
    page = await t.newPage();
    await page.blockUrls(['*cannon-es*']);
    for (const mapId of ['nexus', 'alley']) {
      await open(t, mapId);
      await page.waitFor(`__qa.props.stats().mode === 'static'`, 30000, { label: `${mapId}: 고정 소품으로 대체` });
      const stats = await page.eval('__qa.props.stats()');
      t.check(stats.total === MAPS[mapId].props.length, `${mapId}: 소품은 그대로 보인다`, stats);
      t.check(stats.steps === 0 && stats.active === 0, `${mapId}: 시뮬레이션은 돌지 않는다`, stats);
      const rest = await page.fn(propPositions);
      await blastNear(page, rest[0].pos);
      await page.waitFor('__qa.arsenal.getWeapon().state === "idle"', 3000, { label: '무기 준비' });
      await page.eval('__qa.clearLogs()');
      await clickFire(page, 12);
      await waitTicks(page, 20);
      t.check((await page.eval(`__qa.worldCount('fire')`)) > 0, `${mapId}: 게임은 그대로 돈다`);
      t.check(await page.eval(`(() => { const t0 = __qa.ctx.loop.tick; return new Promise((res) => setTimeout(() => res(__qa.ctx.loop.tick > t0), 300)); })()`), `${mapId}: 게임 루프가 돈다`);
      const after = await page.fn(propPositions);
      t.check(Math.max(...moved(rest, after)) === 0, `${mapId}: 고정 소품은 움직이지 않는다`);
      await t.shot(`${mapId}-static-props`);
      const blocked = page.errors.filter((e) => /cannon-es/.test(e.text || ''));
      t.check(blocked.length >= 1, `${mapId}: 요청이 실제로 막혔다`, page.errors);
      t.errorsOk(`${mapId} cannon-es 차단`, { allow: [/cdn\.jsdelivr\.net\/npm\/cannon-es/] });   // 일부러 막은 요청
    }
    await page.blockUrls([]);
  }
};
