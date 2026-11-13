/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 시나리오 26. 좀비 물량 막기 멀티(함께 막기). 가짜 Supabase에 방장·손님 두 클라이언트를 붙여 좀비 방을 만들고(최대 4명),
 *          방장이 돌리는 좀비가 손님 화면에도 그려지는지, 손님의 사격이 방장 시뮬레이션에 피해로 들어가는지, 스테이지를 깨면 둘 다 카드를 고르고
 *          고른 카드가 방장에게 반영돼 다음 스테이지로 가는지(카드가 뜬 직후 잠금 중 누른 손님의 클릭은 방장에게 가지 않는지),
 *          한 사람이 쓰러지면 다음 스테이지에 일어나는지 본다.
 *          --relay node면 실시간 메시지를 Node 중계 서버로 보낸다(운영 설정과 같은 길).
 */
import { startRelay } from '../../../server/relay/src/node.js';
import { startFakeSupabase } from '../fake-supabase.mjs';
import { LOW_QUALITY, clickFire, lockPointer, qaInit, readyGame, sleep, waitTicks } from '../kit.mjs';
import { CARD_ARM_MS } from '../../../js/ui/cards.js';
import { CARD_LOG, CARD_MID } from './zombie.mjs';

const SIZE = { width: 640, height: 360 };
const DIRECTOR = 'window.__skalafpsSession.match';

async function openPlayer(t, page, nickname, initExtra = '') {
  await page.open(`${t.base}?debug=1`, { ...SIZE, clean: true, initScript: `${initExtra}${qaInit({ profile: { nickname, points: 500, createdAt: 1 }, settings: LOW_QUALITY })}` });
  await readyGame(page, { screen: 'menu' });
  await page.waitFor('__qa.ui.isVisible("menu")', 5000, { label: '메뉴' });
}
async function goLobby(page) {
  await page.clickText('.sk-menu-btn', '멀티플레이');
  await page.waitFor('__qa.ctx.screen === "lobby" && __qa.ui.isVisible("lobby")', 15000, { label: '로비' });
  await page.waitFor(`!document.querySelector('.sk-lobby .sk-loading')`, 15000, { label: '방 목록' });
}
/** 방장 시뮬레이션의 살아 있는 좀비를 모두 쓰러뜨린다(시험용) */
const KILL_ALL = `(() => {
  const d = ${DIRECTOR}, me = window.__skalafpsSession.me;
  let shot = 800000;
  for (const Z of d.internals.zombies.values()) { let g = 0; while (Z.state !== 'dead' && g++ < 300) d.claimHit({ attackerId: me, victimId: 'z' + Z.id, weaponId: 'sr_heavy', part: 'body', dist: 5, kind: 'shot', count: 1, shotId: ++shot }); }
  d.internals.S.queue.length = 0;
  return d.internals.zombies.size;
})()`;

export default {
  name: 'zombie-coop',
  title: '좀비 물량 막기 멀티: 방 · 동기화 · 손님 사격 · 카드 · 부활',
  timeoutMs: 8 * 60 * 1000,
  async run(t) {
    const fake = await startFakeSupabase({});
    const relay = t.relay === 'node' ? await startRelay({ port: 0 }) : null;
    const relayUrl = relay ? relay.url : (t.relay ? t.relay.replace(/\/+$/, '') : null);
    t.server.setConfig(relayUrl
      ? `window.SKALA_CONFIG = { supabase: { url: ${JSON.stringify(fake.url)}, anonKey: 'sb_qa_fake' }, transport: 'relay', relay: { url: ${JSON.stringify(relayUrl)} } };`
      : fake.config);
    let guest = null;
    try {
      t.setSection('좀비 방 만들기');
      const host = await t.newPage();
      await openPlayer(t, host, '방장');
      guest = await t.browser.newPage({ isolated: true });
      await openPlayer(t, guest, '손님');
      await goLobby(host);
      await host.clickText('.sk-lobby .sk-bar-actions .sk-btn', '방 만들기');
      await host.waitFor(`!!document.querySelector('.sk-create-sheet')`, 3000, { label: '방 만들기 시트' });
      await host.click('.sk-create-sheet .sk-mode-btn[data-mode="zombie"]');
      await sleep(150);
      const sheet = await host.eval(`({ max: document.querySelector('.sk-create-sheet [aria-label="최대 인원"] .sk-stepper-val').textContent, plusOff: [...document.querySelectorAll('.sk-create-sheet [aria-label="최대 인원"] .sk-btn--icon')].pop().disabled,
        rulesOff: [...document.querySelectorAll('.sk-create-sheet .sk-choice-row button, .sk-create-sheet [aria-label="규칙 선택"] button')].every((b) => b.disabled) })`);
      t.check(sheet.max === '4명' && sheet.plusOff, '좀비 방은 최대 4명(처음 값도 4명)', sheet);
      const zmaps = await host.eval(`[...document.querySelectorAll('.sk-create-sheet .sk-mapcard-name')].map((e) => e.textContent)`);
      t.check(zmaps.join() === '고속도로 휴게소,지하철 환승역', '좀비 방의 맵은 좀비 전용 맵 둘', zmaps);
      await host.fn(() => { const el = document.querySelector('.sk-create-sheet input'); el.focus(); el.select(); });
      await host.type('좀비 방');
      await host.clickText('.sk-create-sheet .sk-form-actions .sk-btn', '방 만들기');
      await host.waitFor('__qa.ctx.screen === "room" && __qa.ui.isVisible("room")', 10000, { label: '대기실' });
      const solo = await host.eval(`!document.querySelector('.sk-room-foot .sk-btn--primary').disabled`);
      t.check(solo, '좀비 방은 혼자서도 시작할 수 있다');
      await goLobby(guest);
      await guest.waitFor(`document.querySelectorAll('.sk-room-row').length === 1`, 10000, { label: '목록에 좀비 방' });
      const row = await guest.eval(`document.querySelector('.sk-room-row').textContent`);
      t.check(/좀비 물량 막기/.test(row), '방 목록 배지에 좀비 물량 막기', row);
      await guest.click('.sk-room-join');
      await guest.waitFor('__qa.ctx.screen === "room" && __qa.ui.isVisible("room")', 10000, { label: '손님 대기실' });
      const roster = await guest.eval(`({ ffa: !document.querySelector('.sk-team--ffa').hidden, title: document.querySelector('.sk-team--ffa .sk-team-name').textContent })`);
      t.check(roster.ffa && /함께 막는 사람/.test(roster.title), '팀 칼럼 없이 한 명단(모두 같은 편)', roster);
      await guest.click('.sk-ready-btn');
      await host.waitFor(`!document.querySelector('.sk-room-foot .sk-btn--primary').disabled`, 5000, { label: '준비 전달' });
      await t.shot('room');
      t.errorsOk('좀비 방');

      t.setSection('경기 시작과 동기화');
      await host.click('.sk-room-foot .sk-btn--primary');
      await host.waitFor('__qa.ctx.screen === "match"', 20000, { label: '방장 경기 화면' });
      await guest.waitFor('__qa.ctx.screen === "match"', 20000, { label: '손님 경기 화면' });
      for (const page of [host, guest]) await page.eval('__qa.watch()');
      await host.waitFor(`${DIRECTOR} && ${DIRECTOR}.phase === 'wave'`, 40000, { label: '방장 1스테이지' });
      await guest.waitFor(`__qa.visible('.sk-hz-top') && /남은 좀비/.test(__qa.text('.sk-hz-line'))`, 15000, { label: '손님 HUD 띠' });
      await guest.waitFor(`__qa.world.horde.count >= 2`, 20000, { label: '손님 화면에 좀비' });
      const g0 = await guest.eval(`({ count: __qa.world.horde.count, alive: __qa.world.localAlive, team: [...document.querySelectorAll('.sk-hz-mate')].map((e) => e.textContent) })`);
      t.check(g0.alive, '손님도 출격한다', g0);
      t.check(g0.team.length === 2, 'HUD에 두 사람의 체력', g0.team);
      const hostIds = await host.eval(`[...${DIRECTOR}.internals.zombies.values()].filter((Z) => Z.state !== 'dead').map((Z) => Z.id).sort((a, b) => a - b)`);
      const guestIds = await guest.eval(`__qa.world.horde.rendered.map((z) => z.id).sort((a, b) => a - b)`);
      t.check(guestIds.length && guestIds.every((id) => hostIds.includes(id) || id < Math.max(...hostIds) + 1), '손님 화면의 좀비 = 방장의 좀비', { hostIds, guestIds });

      t.setSection('손님의 사격이 방장 시뮬레이션에 들어간다');
      // 방장 쪽에서 좀비 하나를 손님 앞 6 m에 세운다(손님 위치는 sync로 안다)
      const zid = await host.eval(`(() => {
        const s = window.__skalafpsSession, d = s.match;
        const gid = s.state.actors[0];
        const r = s.sync.remote(gid);
        const gp = r && r.state && r.state.pos;
        const Z = [...d.internals.zombies.values()].find((q) => q.state !== 'dead');
        if (!gp || !Z) return 0;
        Z.body.pos[0] = gp[0] + 6; Z.body.pos[1] = gp[1]; Z.body.pos[2] = gp[2];
        Z.state = 'move'; Z.speed = 0; Z.attackReady = 1e12;
        return Z.id;
      })()`);
      t.check(zid > 0, '좀비를 손님 앞에 세운다', zid);
      await guest.waitFor(`__qa.world.horde.rendered.some((z) => z.id === ${zid} && Math.hypot(z.x - __qa.ctx.player.state.pos[0], z.z - __qa.ctx.player.state.pos[2]) < 7)`, 8000, { label: '손님 화면에 옮긴 좀비' });
      await lockPointer(guest);
      const hpBefore = await host.eval(`(${DIRECTOR}.internals.zombies.get(${zid}) || { hp: 0 }).hp`);
      await guest.eval(`(() => { const z = __qa.world.horde.rendered.find((q) => q.id === ${zid}); __qa.aimAt([z.x, z.y + 1.2 * z.s, z.z]); window.__qaRng = () => 0; })()`);
      await clickFire(guest, 4);
      await waitTicks(guest, 6);
      await host.waitFor(`(${DIRECTOR}.internals.zombies.get(${zid}) || { hp: 0 }).hp < ${hpBefore}`, 6000, { label: '방장 쪽 좀비 체력' }).then(
        () => t.check(true, '손님이 쏜 탄이 방장 시뮬레이션의 좀비 체력을 깎는다'),
        (err) => t.check(false, '손님이 쏜 탄이 방장 시뮬레이션의 좀비 체력을 깎는다', err.message));
      await t.shot('guest-shot');

      t.setSection('손님이 탄창을 주우면 방장이 확정한다');
      t.check(await host.eval(`${DIRECTOR}.internals.gates.length === 6`), '좀비 방은 좀비 전용 맵(좀비 문 여섯)에서 한다');
      // 손님 예비 탄을 줄여 두고(시험용) 방장 시뮬레이션에 손님 발밑 탄창 하나를 떨어뜨린다
      await guest.eval(`__qa.arsenal.equipWith('ar_std', { mag: 12, reserve: 15 })`);
      const lootId = await host.eval(`(() => {
        const s = window.__skalafpsSession, d = s.match, S = d.internals.S;
        const gid = s.state.actors[0];
        const r = s.sync.remote(gid);
        const gp = r && r.state && r.state.pos;
        if (!gp) return 0;
        const id = S.nextLoot++;
        d.internals.loot.set(id, { id, kind: 'mag', x: gp[0] + 0.3, y: gp[1], z: gp[2], until: S.clock + 30000 });
        return id;
      })()`);
      t.check(lootId > 0, '손님 발밑에 탄창을 떨어뜨린다', lootId);
      await host.waitFor(`!${DIRECTOR}.internals.loot.has(${lootId})`, 8000, { label: '방장이 줍기를 확정' }).then(
        () => t.check(true, '손님이 닿은 탄창을 방장이 확정해 바닥에서 치운다'),
        (err) => t.check(false, '손님이 닿은 탄창을 방장이 확정해 바닥에서 치운다', err.message));
      await guest.waitFor(`__qa.arsenal.getAmmo('ar_std').reserve > 15`, 6000, { label: '손님 예비 탄' }).then(
        async () => t.check((await guest.eval(`__qa.arsenal.getAmmo('ar_std').reserve`)) === 15 + 30, '손님의 예비 탄이 탄창 하나(30발)만큼 는다'),
        (err) => t.check(false, '손님의 예비 탄이 탄창 하나(30발)만큼 는다', err.message));

      t.setSection('한 사람이 쓰러지면 다음 스테이지에 일어난다');
      await host.eval(`(() => { const d = ${DIRECTOR}; const gid = window.__skalafpsSession.state.actors[0]; const P = d.internals.players.get(gid); P.hp = 1; d.internals.S.phase = 'wave'; })()`);
      // 방장 시뮬레이션의 피해 길로 쓰러뜨린다(좀비 공격과 같은 hurtPlayer)
      await host.eval(`(() => { const d = ${DIRECTOR}; const gid = window.__skalafpsSession.state.actors[0]; const P = d.internals.players.get(gid); P.alive && (P.hp = 0, P.alive = false, P.downs++); })()`);
      await guest.waitFor(`!__qa.world.localAlive`, 8000, { label: '손님 쓰러짐' }).then(() => t.check(true, '손님 화면도 쓰러진다'), (err) => t.check(false, '손님 화면도 쓰러진다', err.message));
      t.check(await host.eval(`${DIRECTOR}.phase === 'wave'`), '한 사람만 쓰러지면 경기는 이어진다');

      t.setSection('스테이지 클리어 → 둘 다 카드');
      await guest.eval(CARD_LOG);
      await host.eval(KILL_ALL);
      const gid = await guest.eval('window.__skalafpsSession.me');
      // 손님: 카드가 뜨자마자(잠금 중) 쏘던 손으로 가운데 카드를 눌러도 방장에게 고르기가 가지 않는다
      const early = JSON.parse(await guest.waitFor(CARD_MID, 15000, { intervalMs: 30, label: '손님 카드' }));
      if (early.since < 500) {
        await guest.mouseClick(early.x, early.y);
        await sleep(600);
        const st = await guest.eval(`({ visible: __qa.ui.isVisible('cards'), down: __qa.cardLog.downs[0] })`);
        const hostSaw = await host.eval(`${DIRECTOR}.internals.players.get(${JSON.stringify(gid)}).cards.length`);
        t.check(typeof st.down === 'number' && st.down < CARD_ARM_MS, '손님이 가운데 카드를 잠금 중에 눌렀다(카드가 뜬 뒤 ms)', st.down);
        t.check(st.visible && hostSaw === 0, '잠긴 동안 누른 손님의 클릭은 카드를 고르지 않는다(방장에게 가지 않는다)', { ...st, hostSaw });
      } else t.note(`손님 화면이 카드가 뜬 뒤 ${Math.round(early.since)} ms가 지나서야 읽혀 잠금 중 누르기 시험을 건너뛴다`);
      await host.waitFor(`__qa.ui.isVisible('cards')`, 15000, { label: '방장 카드' });
      await guest.waitFor(`!document.querySelector('.sk-cards').classList.contains('is-arming')`, 5000, { label: '손님 카드 잠금 풀림' });
      const gc = await guest.eval(`[...document.querySelectorAll('.sk-cd-card .sk-cd-name')].map((e) => e.textContent)`);
      t.check(gc.length === 3, '손님에게도 카드 3장', gc);
      await t.shot('guest-cards');
      await guest.clickText('.sk-cd-card .sk-cd-name', gc[0]);
      await host.waitFor(`${DIRECTOR}.internals.players.get(${JSON.stringify(gid)}).cards.length === 1`, 8000, { label: '방장에게 손님 카드 반영' }).then(
        () => t.check(true, '손님이 고른 카드가 방장 시뮬레이션에 들어간다'),
        (err) => t.check(false, '손님이 고른 카드가 방장 시뮬레이션에 들어간다', err.message));
      const hostWait = await host.eval(`__qa.text('.sk-cd-wait') || __qa.text('.sk-hz-warn') || ''`);
      t.note(`방장 화면 기다림 안내: ${hostWait}`);
      const hc = await host.eval(`[...document.querySelectorAll('.sk-cd-card .sk-cd-name')].map((e) => e.textContent)`);
      await host.waitFor(`!document.querySelector('.sk-cards').classList.contains('is-arming')`, 5000, { label: '방장 카드 잠금 풀림' });
      await host.clickText('.sk-cd-card .sk-cd-name', hc[2]);
      await host.waitFor(`${DIRECTOR}.phase === 'wave' && ${DIRECTOR}.stage === 2`, 15000, { label: '2스테이지' });
      await guest.waitFor(`__qa.world.localAlive && __qa.text('.sk-hz-stage-n') === '2'`, 15000, { label: '손님이 2스테이지에 일어남' }).then(
        () => t.check(true, '쓰러졌던 손님이 다음 스테이지에 일어난다'),
        (err) => t.check(false, '쓰러졌던 손님이 다음 스테이지에 일어난다', err.message));
      const ghp = await guest.eval('__qa.ctx.player.state.hp');
      t.check(ghp > 0 && ghp <= 60, '일어난 사람의 체력은 절반쯤', ghp);
      await t.shot('stage2');
      for (const page of [host, guest]) { t.page = page; t.errorsOk(page === host ? '방장' : '손님'); }
      t.page = host;
    } finally {
      t.server.setConfig(null);
      if (guest) await guest.close();
      await fake.close();
      if (relay) await relay.close();
    }
    if (relayUrl) t.note('실시간 메시지는 Node 중계 서버로 보냈다');
    t.note('가짜 서버라서 실서버의 지연·전송 한도는 검증하지 못했다');
  }
};
