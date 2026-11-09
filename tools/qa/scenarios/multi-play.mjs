/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 시나리오 11. 가짜 Supabase(tools/qa/fake-supabase.mjs)에 실제 클라이언트 둘을 붙여 멀티플레이를 끝까지 돌린다. 닉네임 서버 검사, 프로필 저장, 로비, 방, 채팅, 경기, 경기 채팅, 판정, 결과, 퇴장을 본다.
 *          개인전 중간 참가를 볼 때만 셋째 클라이언트를 잠깐 띄운다(둘 중 하나가 나가면 기권승으로 끝나기 때문이다).
 *          실서버의 인증·전송 한도·지연은 검증하지 못한다. 페이지가 둘이어야 하는 유일한 시나리오라 작은 화면과 저사양으로 돌린다.
 */
import { startFakeSupabase } from '../fake-supabase.mjs';
import { LOW_QUALITY, clickFire, lockPointer, qaInit, readyGame, sleep, startPractice, waitIdle, waitTicks } from '../kit.mjs';

const SIZE = { width: 480, height: 270 };

async function openPlayer(t, page, nickname) {
  await page.open(`${t.base}?debug=1`, { ...SIZE, clean: true, initScript: qaInit({ profile: { nickname, points: 500, createdAt: 1 }, settings: LOW_QUALITY }) });
  await readyGame(page, { screen: 'menu' });
  await page.waitFor('__qa.ui.isVisible("menu")', 5000, { label: '메뉴' });
}

async function goLobby(page) {
  await page.clickText('.sk-menu-btn', '멀티플레이');
  await page.waitFor('__qa.ctx.screen === "lobby" && __qa.ui.isVisible("lobby")', 15000, { label: '로비' });
  await page.waitFor(`!document.querySelector('.sk-lobby .sk-loading')`, 15000, { label: '방 목록' });
}

/** 현재 라운드에서 내가 상대 머리를 쏜다. 스폰이 달라도 되게 서로 마주 보는 자리로 옮긴다 */
async function arrange(host, guest, spot) {
  await host.fn((s) => { const qa = window.__qa; qa.teleport(s.a.x, s.a.y, s.a.z); qa.ctx.player.state.onGround = true; }, spot);
  await guest.fn((s) => { const qa = window.__qa; qa.teleport(s.b.x, s.b.y, s.b.z); qa.ctx.player.state.onGround = true; }, spot);
}

/** 다른 사람의 화면 값은 네트워크를 거쳐 온다. 잠시 기다려도 그렇게 되지 않으면 실패로 남긴다 */
async function eventually(t, page, expr, label, ms = 4000) {
  await page.waitFor(expr, ms, { intervalMs: 50, label }).then(() => t.check(true, label), (err) => t.check(false, label, err.message));
}

/** 쏘는 쪽 화면에 상대 아바타가 옮겨 올 때까지 기다린 뒤 상대 머리를 겨눠 진짜 무기를 쏜다 */
async function killOther(page, want) {
  await page.waitFor(`__qa.ctx.avatars.getTargets().some((x) => Math.hypot(x.pos[0] - ${want.x}, x.pos[2] - ${want.z}) < 0.5)`, 8000, { intervalMs: 50, label: '상대 위치 동기화' });
  await waitIdle(page);
  const aim = await page.fn(() => {
    const qa = window.__qa;
    const target = qa.ctx.avatars.getTargets()[0];
    return qa.aimAt(qa.partPoint(target.id, 'head'));
  });
  await page.eval('window.__qaRng = () => 0');
  await clickFire(page, 2);
  await waitTicks(page, 3);
  await page.eval('window.__qaRng = null');
  return aim;
}

export default {
  name: 'multi-play',
  title: '가짜 서버에 두 클라이언트를 붙인 멀티플레이: 닉네임, 로비, 방, 경기, 결과',
  timeoutMs: 8 * 60 * 1000,
  async run(t) {
    const fake = await startFakeSupabase({ takenNames: ['중복이름'], delayMs: Number(process.env.QA_NET_DELAY_MS) || 0 });   // QA_NET_DELAY_MS: 서버 → 클라이언트 지연을 흉내 낸다
    t.server.setConfig(fake.config);
    let guest = null;
    try {
      t.setSection('온라인 닉네임 검사');
      const host = await t.newPage();
      await host.open(`${t.base}?debug=1`, { ...SIZE, clean: true, initScript: qaInit({ settings: LOW_QUALITY }) });
      await host.waitFor(`!!document.querySelector('.sk-nick') && !document.querySelector('.sk-nick').hidden`, 30000, { label: '닉네임 게이트' });
      await host.fn(() => { const el = document.querySelector('#sk-gate-nick'); el.focus(); el.select(); });
      await host.type('중복이름');
      await host.waitFor(`document.querySelector('#sk-gate-nick-status').classList.contains('is-bad')`, 5000, { label: '중복 거절' });
      t.check(/이미 사용 중/.test(await host.eval(`document.querySelector('#sk-gate-nick-status').textContent`)), '서버 기준 중복을 알려 준다');
      await host.fn(() => { const el = document.querySelector('#sk-gate-nick'); el.focus(); el.select(); });
      await host.type('방장');
      await host.waitFor(`document.querySelector('#sk-gate-nick-status').classList.contains('is-ok')`, 5000, { label: '사용 가능' });
      t.check(/사용할 수 있는/.test(await host.eval(`document.querySelector('#sk-gate-nick-status').textContent`)), '온라인이면 오프라인 안내 없이 사용 가능이라고 한다');
      await host.click('.sk-nick-submit');
      await host.waitFor(`document.querySelector('.sk-nick').hidden`, 5000, { label: '게이트 닫힘' });
      t.check([...fake.players.values()].some((p) => p.name === '방장'), '서버에 닉네임이 등록된다');
      await readyGame(host, { screen: 'menu' });
      t.check(!(await host.eval(`[...document.querySelectorAll('.sk-menu-btn')].find((x) => /멀티플레이/.test(x.textContent)).disabled`)), '멀티 버튼이 켜진다');

      t.setSection('프로필 동기화');
      await host.eval(`__qa.ctx.account.buy('pt_magnum')`);
      await host.waitFor(`__qa.ctx.account.profile.points === 0`, 2000, { label: '구매' });
      const saveEnd = Date.now() + 8000;
      while (!fake.stats.rpc.fps_save_profile && Date.now() < saveEnd) await sleep(100);
      t.check(fake.stats.rpc.fps_save_profile >= 1, '변경이 서버에 저장된다', fake.stats.rpc);
      t.check([...fake.players.values()].some((p) => p.name === '방장' && p.points === 0 && p.owned.includes('pt_magnum')), '서버 프로필에 구매가 들어간다');
      t.errorsOk('온라인 계정');

      t.setSection('닉네임 충돌');
      guest = await t.browser.newPage({ isolated: true });
      // 손님은 공병 캐릭터를 입고 온다(경기에서 방장 화면에 그 모습으로 보여야 한다)
      await guest.open(`${t.base}?debug=1`, { ...SIZE, clean: true, initScript: `localStorage.getItem('skalafps.qa.seed') || (localStorage.setItem('skalafps.qa.seed', '1'), localStorage.setItem('skalafps.settings.v1', '{"quality":"low"}'), localStorage.setItem('skalafps.profile.v1', JSON.stringify({ v: 1, profile: { nickname: '중복이름', points: 500, owned: ['av_sapper'], loadout: { avatar: 'av_sapper' }, createdAt: 1 }, sync: { dirty: true, pendingClaim: '중복이름' } })));\n${qaInit()}` });
      await guest.waitFor(`!!document.querySelector('.sk-nick') && !document.querySelector('.sk-nick').hidden`, 30000, { label: '충돌 게이트' });
      t.check(/중복이름/.test(await guest.eval(`document.querySelector('.sk-nick .sk-alert').textContent`)), '거절된 이름을 설명한다', await guest.eval(`document.querySelector('.sk-nick .sk-alert').textContent`));
      await guest.fn(() => { const el = document.querySelector('#sk-gate-nick'); el.focus(); el.select(); });
      await guest.type('손님');
      await guest.waitFor(`!document.querySelector('.sk-nick-submit').disabled`, 5000, { label: '새 이름 사용 가능' });
      await guest.click('.sk-nick-submit');
      await guest.waitFor(`document.querySelector('.sk-nick').hidden`, 5000, { label: '충돌 해결' });
      await readyGame(guest, { screen: 'menu' });
      t.check((await guest.eval('__qa.ctx.account.nicknamePending')) === false, '새 이름이 등록된다');
      t.check((await guest.eval('__qa.ctx.session.name')) === '손님', '플레이어 이름도 바뀐다');

      t.setSection('로비와 방');
      await goLobby(host);
      t.check(await host.eval(`/열려 있는 방이 없어요/.test(document.querySelector('.sk-lobby').textContent)`), '빈 로비 안내');
      await t.shot('lobby-empty');
      await host.clickText('.sk-lobby .sk-bar-actions .sk-btn', '방 만들기');
      await host.waitFor(`!!document.querySelector('.sk-create-sheet')`, 3000, { label: '방 만들기 시트' });
      await host.fn(() => { const el = document.querySelector('.sk-create-sheet input'); el.focus(); el.select(); });
      await host.type('QA 방');
      await t.shot('create-room');
      await host.clickText('.sk-create-sheet .sk-form-actions .sk-btn', '방 만들기');
      await host.waitFor('__qa.ctx.screen === "room" && __qa.ui.isVisible("room")', 10000, { label: '대기실' });
      t.check(/QA 방/.test(await host.eval(`document.querySelector('.sk-room-title').textContent`)), '방 이름');
      await host.waitFor(`document.querySelector('.sk-room-foot .sk-btn--primary').disabled`, 2000, { label: '혼자면 시작 못 함' });

      await goLobby(guest);
      await guest.waitFor(`document.querySelectorAll('.sk-room-row').length === 1`, 10000, { label: '방 목록에 방이 뜬다' });
      const row = await guest.eval(`document.querySelector('.sk-room-row').textContent`);
      t.check(/QA 방/.test(row) && /클래식 · 팀전/.test(row) && /방장/.test(row), '방 목록 줄', row);
      await t.shot('lobby-room');
      await guest.click('.sk-room-join');
      await guest.waitFor('__qa.ctx.screen === "room" && __qa.ui.isVisible("room")', 10000, { label: '손님 대기실' });
      await host.waitFor(`/손님/.test(document.querySelector('.sk-room').textContent)`, 8000, { label: '방장 화면에 손님' });
      await guest.waitFor(`/방장/.test(document.querySelector('.sk-team-list, .sk-room').textContent)`, 8000, { label: '손님 화면에 방장' });

      t.setSection('채팅과 준비');
      await guest.fn(() => { document.querySelector('.sk-chat-form input').focus(); });
      await guest.type('안녕하세요');
      await guest.click('.sk-chat-form button');
      await host.waitFor(`/안녕하세요/.test(document.querySelector('.sk-chat-log').textContent)`, 5000, { label: '채팅 전달' });
      t.check(await host.eval(`document.querySelector('.sk-room-foot .sk-btn--primary').disabled`), '손님이 준비 전이면 시작할 수 없다');
      await guest.click('.sk-ready-btn');
      await host.waitFor(`!document.querySelector('.sk-room-foot .sk-btn--primary').disabled`, 5000, { label: '준비 전달' });
      await t.shot('room-ready');
      t.errorsOk('로비와 방');

      t.setSection('경기 시작');
      await host.click('.sk-room-foot .sk-btn--primary');
      await host.waitFor('__qa.ctx.screen === "match"', 20000, { label: '방장 경기 화면' });
      await guest.waitFor('__qa.ctx.screen === "match"', 20000, { label: '손님 경기 화면' });
      for (const page of [host, guest]) await page.eval('__qa.watch()');
      await host.waitFor('__qa.world.internals.rnd.phase === "live"', 40000, { label: '방장 live' });
      await guest.waitFor('__qa.world.internals.rnd.phase === "live"', 15000, { label: '손님 live' });
      t.check(await host.eval('__qa.world.localAlive') && await guest.eval('__qa.world.localAlive'), '둘 다 살아서 시작한다');
      const teams = [await host.eval('__qa.world.localTeam'), await guest.eval('__qa.world.localTeam')];
      t.check(teams[0] !== teams[1], '서로 다른 팀이다', teams);
      t.check((await guest.eval('__qa.ctx.account.avatar')) === 'av_sapper', '손님 계정 캐릭터는 공병');
      await eventually(t, host, `__qa.ctx.avatars.list().some((a) => a.name.includes('손님') && a.avatarId === 'av_sapper')`, '방장 화면에서 손님은 손님이 고른 캐릭터(공병)로 그려진다');
      await eventually(t, guest, `__qa.ctx.avatars.list().some((a) => a.name.includes('방장') && a.avatarId === 'av_trooper')`, '손님 화면에서 방장은 기본 캐릭터로 그려진다');
      const hostView = await host.eval(`__qa.ctx.avatars.list().map((a) => [a.name, a.avatarId, a.team])`);
      t.log(`   방장 화면의 액터: ${JSON.stringify(hostView)}`);
      await lockPointer(host);
      await host.bringToFront();
      await lockPointer(guest);
      await guest.bringToFront();

      // 평지 한 곳을 찾아 라운드마다 그 자리로 옮겨 서로 쏜다
      const spot = await host.fn(() => {
        const c = window.__qa.ctx, w = c.world, P = c.physics;
        for (let x = -30; x <= 30; x += 2) {
          for (let z = -18; z <= 18; z += 2) {
            for (const [dx, dz] of [[8, 0], [0, 8]]) {
              const bx = x + dx, bz = z + dz;
              if (P.findFloor(w, x, z) !== 0 || P.findFloor(w, bx, bz) !== 0) continue;
              if (!window.__qa.clearOfTriggers(x, z) || !window.__qa.clearOfTriggers(bx, bz)) continue;
              if (P.overlapsCapsule(w, x, 0, z, 0.4, 1.9) || P.overlapsCapsule(w, bx, 0, bz, 0.4, 1.9)) continue;
              if (P.lineOfSight(w, [x, 1.6, z], [bx, 1.6, bz]) && P.lineOfSight(w, [x, 1.6, z], [bx, 1.2, bz])) return { a: { x, y: 0, z }, b: { x: bx, y: 0, z: bz } };
            }
          }
        }
        return null;
      });
      t.check(!!spot, '서로 쏠 자리를 찾는다');
      if (!spot) throw new Error('자리를 찾지 못했어요');

      t.setSection('경기 채팅');
      t.check(await host.eval('__qa.ui.isVisible("chat")') && await guest.eval('__qa.ui.isVisible("chat")'), '경기 중에는 채팅 화면이 있다');
      await host.bringToFront();
      await host.key('KeyW', 'down');
      await host.press('Enter', { text: '\r' });
      await host.waitFor('__qa.ui.chat.isOpen() && document.activeElement === document.querySelector(".sk-cb-input")', 3000, { label: '경기 중 Enter로 채팅 입력칸' });
      t.check(await host.eval('__qa.ctx.input.locked'), '채팅을 열어도 포인터 잠금은 그대로다');
      t.check(!(await host.eval('__qa.ctx.input.state.forward')), '채팅을 열면 누르고 있던 이동 키가 풀린다');
      await host.type('왼쪽 골목으로 가요');
      await host.key('KeyW', 'up');
      await host.press('Enter', { text: '\r' });
      await host.waitFor('!__qa.ui.chat.isOpen()', 2000, { label: 'Enter로 보내면 닫힌다' });
      await eventually(t, guest, `/왼쪽 골목으로 가요/.test(__qa.text('.sk-cb-log'))`, '상대 HUD 채팅에 보인다');
      t.check(/하늘|방장/.test(await guest.eval(`__qa.text('.sk-cb-log')`)), '보낸 사람 이름이 붙는다', await guest.eval(`__qa.text('.sk-cb-log')`));
      t.check(/왼쪽 골목으로 가요/.test(await host.eval(`__qa.text('.sk-cb-log')`)), '내 HUD 채팅에도 남는다');
      t.check((await host.eval('document.querySelector(".sk-cb-input").value')) === '', '보낸 뒤 입력칸은 비운다');
      t.check(await host.eval('document.activeElement !== document.querySelector(".sk-cb-input")'), '보낸 뒤에는 키가 다시 게임으로 간다');
      await t.shot('match-chat');
      // 빈 칸에서 Enter는 아무것도 보내지 않고 닫는다
      const sentBefore = await guest.eval(`document.querySelectorAll('.sk-cb-log li').length`);
      await host.press('Enter', { text: '\r' });
      await host.waitFor('__qa.ui.chat.isOpen()', 2000, { label: '다시 열기' });
      await host.press('Enter', { text: '\r' });
      await host.waitFor('!__qa.ui.chat.isOpen()', 2000, { label: '빈 칸 Enter로 닫기' });
      await sleep(400);
      t.check((await guest.eval(`document.querySelectorAll('.sk-cb-log li').length`)) === sentBefore, '빈 칸은 보내지 않는다');
      await lockPointer(host);
      await guest.bringToFront();
      t.errorsOk('경기 채팅');

      t.setSection('방장이 쏜다');
      await arrange(host, guest, spot);
      await waitTicks(host, 10);
      const aim1 = await killOther(host, spot.b);
      t.check(aim1.kind === 'player' && aim1.part === 'head', '방장 화면에서 손님 머리를 겨눈다', aim1);
      await guest.waitFor('!__qa.world.localAlive', 5000, { intervalMs: 50, label: '손님이 쓰러진다' });
      await eventually(t, host, `__qa.text('.sk-killfeed').includes('손님')`, '방장 킬피드');
      await eventually(t, guest, `__qa.text('.sk-killfeed').includes('방장')`, '손님 킬피드');
      t.check(+(await guest.eval(`__qa.text('.sk-hp-num')`)) === 0, '손님 HUD 체력 0');
      await t.shot('host-killed-guest');

      t.setSection('손님이 쏜다');
      await guest.waitFor('__qa.world.internals.rnd.round === 2 && __qa.world.internals.rnd.phase === "live"', 30000, { label: '2라운드' });
      await host.waitFor('__qa.world.internals.rnd.round === 2 && __qa.world.internals.rnd.phase === "live" && __qa.world.localAlive', 10000, { label: '방장 2라운드' });
      await lockPointer(host);
      await lockPointer(guest);
      await arrange(host, guest, spot);
      await waitTicks(guest, 10);
      const aim2 = await killOther(guest, spot.a);
      t.check(aim2.kind === 'player' && aim2.part === 'head', '손님 화면에서 방장 머리를 겨눈다', aim2);
      await host.waitFor('!__qa.world.localAlive', 5000, { intervalMs: 50, label: '방장이 쓰러진다' });
      await eventually(t, guest, `__qa.world.internals.rnd.score[__qa.world.localTeam] === 1`, '손님 점수 1');

      t.setSection('매치 끝까지');
      for (const round of [3, 4]) {
        await host.waitFor(`__qa.world.internals.rnd.round === ${round} && __qa.world.internals.rnd.phase === "live" && __qa.world.localAlive`, 30000, { label: `${round}라운드` });
        await guest.waitFor(`__qa.world.internals.rnd.round === ${round} && __qa.world.internals.rnd.phase === "live" && __qa.world.localAlive`, 10000, { label: `손님 ${round}라운드` });
        await lockPointer(host);
        await lockPointer(guest);
        if (round === 3) {
          // 라운드 도중 연결이 끊겼다 돌아와도 경기가 이어진다
          const conns = fake.stats.connections;
          fake.dropAll();
          const reconnectEnd = Date.now() + 15000;
          while (fake.stats.connections < conns + 2 && Date.now() < reconnectEnd) await sleep(100);
          t.check(fake.stats.connections >= conns + 2, '두 클라이언트가 다시 접속한다', { conns, now: fake.stats.connections });
          await sleep(1500);
          t.check(await host.eval('__qa.ctx.screen === "match" && __qa.world.localAlive') && await guest.eval('__qa.ctx.screen === "match" && __qa.world.localAlive'), '다시 접속한 뒤에도 경기 화면이다');
        }
        await arrange(host, guest, spot);
        await waitTicks(host, 10);
        await killOther(host, spot.b);
        await guest.waitFor('!__qa.world.localAlive', 8000, { intervalMs: 50, label: '손님이 쓰러진다' });
      }
      await host.waitFor('__qa.ui.isVisible("results")', 30000, { intervalMs: 200, label: '방장 결과 화면' });
      await guest.waitFor('__qa.ui.isVisible("results")', 15000, { intervalMs: 200, label: '손님 결과 화면' });
      await t.shot('results-host');
      const pr = await host.eval('__qa.profile()');
      const pg = await guest.eval('__qa.profile()');
      t.check(pr.stats.matches === 1 && pr.stats.kills === 3 && pr.stats.deaths === 1 && pr.stats.wins === 1, '방장 전적', pr.stats);
      t.check(pg.stats.matches === 1 && pg.stats.kills === 1 && pg.stats.deaths === 3 && pg.stats.wins === 0, '손님 전적', pg.stats);
      t.check(pr.stats.headshots === 3 && pg.stats.headshots === 1, '헤드샷 전적', { host: pr.stats.headshots, guest: pg.stats.headshots });
      t.check(pr.points === 0 + 3 * 10 + 3 * 5 + 60 + 20, '방장 온라인 보상', pr.points);
      t.check(pg.points === 500 + 10 + 5 + 20, '손님 온라인 보상', pg.points);
      t.check(/우리 팀이 이겼어요/.test(await host.eval(`__qa.text('.sk-res-verdict')`)), '방장 결과 문구', await host.eval(`__qa.text('.sk-res-verdict')`));
      t.check(/패배/.test(await guest.eval(`__qa.text('.sk-res-verdict')`)), '손님 결과 문구', await guest.eval(`__qa.text('.sk-res-verdict')`));
      t.errorsOk('경기');

      t.setSection('방으로 돌아가기');
      await host.click('.sk-res-actions .sk-btn--primary');
      await host.waitFor('__qa.ctx.screen === "room" && __qa.ui.isVisible("room")', 10000, { label: '방장 대기실로' });
      await guest.click('.sk-res-actions .sk-btn--primary');
      await guest.waitFor('__qa.ctx.screen === "room" && __qa.ui.isVisible("room")', 10000, { label: '손님 대기실로' });
      await t.shot('back-to-room');

      t.setSection('규칙 바꾸기');
      await host.clickText('.sk-room-side .sk-choice', '칼전');
      await guest.waitFor(`/칼전/.test(document.querySelector('.sk-bar-sub.sk-chips').textContent)`, 5000, { label: '손님 화면에 칼전' });
      await host.click('.sk-modepick--bar .sk-mode-btn[data-mode="ffa"]');
      await guest.waitFor(`/개인전/.test(document.querySelector('.sk-bar-sub.sk-chips').textContent)`, 5000, { label: '손님 화면에 개인전' });
      const ready = await guest.eval(`document.querySelector('.sk-ready-btn').getAttribute('aria-pressed')`);
      if (ready !== 'true') await guest.click('.sk-ready-btn');
      await host.waitFor(`!document.querySelector('.sk-room-foot .sk-btn--primary').disabled`, 5000, { label: '시작 가능' });
      await host.click('.sk-room-foot .sk-btn--primary');
      await host.waitFor('__qa.ctx.screen === "match" && __qa.world.internals.rnd.phase === "live"', 40000, { label: '칼전 시작' });
      await guest.waitFor('__qa.ctx.screen === "match" && __qa.world.internals.rnd.phase === "live"', 15000, { label: '손님 칼전 시작' });
      for (const page of [host, guest]) {
        const slots = await page.eval('({ slots: __qa.arsenal.getAllowedSlots(), held: __qa.arsenal.getWeapon().slot, ruleset: __qa.world.ruleset, mode: __qa.world.mode })');
        t.check(slots.slots.join() === '3' && slots.held === 3 && slots.ruleset === 'knife' && slots.mode === 'ffa', '칼전 개인전이 양쪽에 적용된다', slots);
      }
      await t.shot('knife-ffa');
      t.errorsOk('규칙 바꾸기');

      t.setSection('칼전 개인전: 쓰러뜨리고 부활');
      await lockPointer(host);
      await lockPointer(guest);
      const close = { a: spot.a, b: { x: spot.a.x + (spot.b.x !== spot.a.x ? 1.2 : 0), y: 0, z: spot.a.z + (spot.b.z !== spot.a.z ? 1.2 : 0) } };
      // 부활 보호가 끝날 때까지 기다린 뒤 가까이 세운다
      await sleep(1700);
      await arrange(host, guest, close);
      await waitTicks(host, 10);
      await host.waitFor(`__qa.ctx.avatars.getTargets().some((x) => Math.hypot(x.pos[0] - ${close.b.x}, x.pos[2] - ${close.b.z}) < 0.5)`, 8000, { intervalMs: 50, label: '상대 위치 동기화' });
      await waitIdle(host);
      await host.fn(() => { const qa = window.__qa; qa.aimAt(qa.partPoint(qa.ctx.avatars.getTargets()[0].id, 'body')); });
      await clickFire(host, 2, 2);
      await guest.waitFor('!__qa.world.localAlive', 6000, { intervalMs: 50, label: '칼에 쓰러진다' });
      await guest.waitFor('__qa.visible(".sk-rsp")', 2000, { label: '손님 부활 패널' });
      t.check(/방장에게 당했어요/.test(await guest.eval(`__qa.text('.sk-rsp-main')`)), '누구에게 당했는지 보인다', await guest.eval(`__qa.text('.sk-rsp-main')`));
      await host.waitFor(`__qa.text('.sk-ffa-me .sk-ts-score') === '1'`, 3000, { label: '방장 킬 수' });
      await guest.waitFor('__qa.world.localAlive', 8000, { intervalMs: 50, label: '손님 부활' });
      t.check(await guest.eval('__qa.ctx.player.state.hp === 100 && !__qa.visible(".sk-rsp")'), '부활하면 체력이 찬다');
      t.errorsOk('칼전 개인전');

      t.setSection('개인전 중간 참가');
      // 경기 중인 방은 팀전만 잠긴다. 개인전은 로비에서 바로 들어가 부활 시간 뒤 출격한다
      let third = null;
      try {
        third = await t.browser.newPage({ isolated: true });
        await openPlayer(t, third, '셋째');
        await goLobby(third);
        await third.waitFor(`document.querySelectorAll('.sk-room-row').length === 1`, 10000, { label: '셋째 로비에 방' });
        const row = await third.eval(`({ text: document.querySelector('.sk-room-row').textContent, disabled: document.querySelector('.sk-room-join').disabled })`);
        t.check(/게임 중/.test(row.text) && /중간 참가/.test(row.text) && !row.disabled, '경기 중인 개인전 방도 들어갈 수 있다', row);
        await third.click('.sk-room-join');
        await third.waitFor('__qa.ctx.screen === "match"', 30000, { label: '셋째가 경기 화면으로' });
        await third.waitFor('__qa.world.localAlive', 20000, { intervalMs: 100, label: '셋째 출격' })
          .then(() => t.check(true, '중간에 들어와도 곧 출격한다'), (err) => t.check(false, '중간에 들어와도 곧 출격한다', err.message));
        const mine = await third.eval('({ ruleset: __qa.world.ruleset, mode: __qa.world.mode, slots: __qa.arsenal.getAllowedSlots() })');
        t.check(mine.ruleset === 'knife' && mine.mode === 'ffa' && mine.slots.join() === '3', '들어온 사람에게도 방 규칙이 적용된다', mine);
        await eventually(t, host, `__qa.ctx.avatars.getTargets().length >= 2`, '방장 화면에 셋째가 보인다', 10000);
        await eventually(t, third, `__qa.ctx.avatars.list().some((a) => a.name.includes('손님') && a.avatarId === 'av_sapper')`, '중간에 들어온 사람에게도 손님 캐릭터가 보인다', 10000);
        t.page = third;
        await t.shot('ffa-late-join');
        t.errorsOk('셋째: 중간 참가');
        t.page = host;
      } finally {
        t.page = host;
        if (third) await third.close();
      }
      // 셋째가 나가도 둘이 남아 경기는 이어진다
      await sleep(1500);
      t.check(await host.eval('__qa.ctx.screen === "match" && __qa.world.internals.rnd.phase === "live"'), '셋째가 나가도 경기는 이어진다');
      t.errorsOk('개인전 중간 참가');

      t.setSection('방장이 경기 중 나간다');
      await lockPointer(host);
      await host.eval(`document.exitPointerLock()`);
      await host.waitFor('__qa.ui.isVisible("pause")', 3000, { label: '방장 일시정지' });
      t.check(!(await host.eval('__qa.world.paused && __qa.run')), '멀티에서는 경기가 멈추지 않는다');
      await host.click('.sk-pause-btns .sk-btn--danger');
      await host.click('.sk-pause .sk-confirm .sk-btn--danger');
      await host.waitFor('__qa.ctx.screen === "lobby" || __qa.ctx.screen === "menu"', 10000, { label: '방장이 나감' });
      await guest.waitFor('__qa.ui.isVisible("results") || __qa.ui.isVisible("room") || __qa.world.localAlive', 15000, { label: '손님 화면이 이어진다' });
      await sleep(1000);
      const after = await guest.eval(`({ screen: __qa.ctx.screen, results: __qa.ui.isVisible('results'), room: __qa.ui.isVisible('room'), hud: __qa.ui.isVisible('hud') })`);
      t.log(`   방장이 나간 뒤 손님: ${JSON.stringify(after)}`);
      t.check(after.results || after.room || after.hud, '손님 화면이 멈추지 않는다', after);
      await t.shot('host-left');
      t.errorsOk('방장 퇴장');
      t.page = guest;
      t.errorsOk('손님: 방장 퇴장');
      t.page = host;

      // 경기에서 나온 뒤 로비로 다시 들어가 새 방을 만들고 참가할 수 있다. 앞 경기의 채널이 남아 있으면 여기서 깨진다
      t.setSection('다시 멀티로');
      // 채팅 기록에도 이름이 남으니 보이는 명단만 본다(숨은 개인전 명단은 개인전으로 바꿀 때 다시 그린다)
      await host.eval(`window.inRoster = (name) => [...document.querySelectorAll('.sk-room .sk-team:not([hidden]) .sk-team-list')].some((l) => l.textContent.includes(name))`);
      if (await host.eval('__qa.ctx.screen === "menu"')) await goLobby(host);
      await host.waitFor(`__qa.ctx.screen === "lobby" && !document.querySelector('.sk-lobby .sk-loading')`, 15000, { label: '방장 로비' });
      if (after.results) await guest.click('.sk-res-actions .sk-btn--ghost');
      else if (after.room) await guest.click('.sk-room .sk-bar .sk-btn--ghost');
      await guest.waitFor('__qa.ctx.screen === "lobby" || __qa.ctx.screen === "menu"', 10000, { label: '손님이 나감' });
      if (await guest.eval('__qa.ctx.screen === "menu"')) await goLobby(guest);
      await guest.waitFor(`__qa.ctx.screen === "lobby" && !document.querySelector('.sk-lobby .sk-loading')`, 15000, { label: '손님 로비' });
      await host.clickText('.sk-lobby .sk-bar-actions .sk-btn', '방 만들기');
      await host.waitFor(`!!document.querySelector('.sk-create-sheet')`, 3000, { label: '방 만들기 시트' });
      await host.fn(() => { const el = document.querySelector('.sk-create-sheet input'); el.focus(); el.select(); });
      await host.type('둘째 방');
      // 둘째 방은 비밀번호 방이다. 비밀번호는 채널 이름에만 섞이고 어디에도 보내지 않는다
      await host.fn(() => { document.querySelectorAll('.sk-create-sheet input')[1].focus(); });
      await host.type('1234');
      await host.clickText('.sk-create-sheet .sk-form-actions .sk-btn', '방 만들기');
      await host.waitFor('__qa.ctx.screen === "room" && __qa.ui.isVisible("room")', 10000, { label: '둘째 방 대기실' });
      await guest.waitFor(`document.querySelectorAll('.sk-room-row').length === 1 && /둘째 방/.test(document.querySelector('.sk-room-row').textContent)`, 10000, { label: '목록에 둘째 방만 있다' });
      t.check(/🔒/.test(await guest.eval(`document.querySelector('.sk-room-row').textContent`)), '비밀번호 방은 목록에 자물쇠가 보인다');
      const enter = async (pw) => {
        await guest.click('.sk-room-join');
        await guest.waitFor(`!!document.querySelector('.sk-pw-sheet')`, 3000, { label: '비밀번호를 묻는다' });
        await guest.fn(() => { document.querySelector('.sk-pw-sheet input').focus(); });
        await guest.type(pw);
        await guest.clickText('.sk-pw-sheet .sk-form-actions .sk-btn', '들어가기');
      };
      await enter('9999');
      await eventually(t, guest, `/비밀번호가 맞지 않아요/.test(document.querySelector('.sk-lobby').textContent)`, '틀린 비밀번호는 들어가지 못하고 이유를 알려 준다', 15000);
      t.check(await guest.eval('__qa.ctx.screen === "lobby"'), '틀리면 로비에 남는다');
      await t.shot('password-wrong');
      await guest.waitFor(`document.querySelectorAll('.sk-room-row').length === 1`, 10000, { label: '목록이 다시 보인다' });
      await enter('1234');
      await guest.waitFor('__qa.ctx.screen === "room" && __qa.ui.isVisible("room")', 15000, { label: '맞는 비밀번호로 들어간다' });
      t.check(true, '맞는 비밀번호로 들어간다');
      await host.waitFor(`inRoster('손님')`, 8000, { label: '방장 명단에 다시 손님' });
      await t.shot('second-room');
      await guest.click('.sk-room .sk-bar .sk-btn--ghost');
      await guest.waitFor('__qa.ctx.screen === "lobby"', 8000, { label: '손님이 로비로' });
      await host.waitFor(`!inRoster('손님')`, 8000, { label: '방장 명단에서 손님이 사라진다' });
      await host.click('.sk-room .sk-bar .sk-btn--ghost');
      await host.waitFor('__qa.ctx.screen === "lobby"', 8000, { label: '방장이 로비로' });
      await guest.waitFor(`document.querySelectorAll('.sk-room-row').length === 0`, 10000, { label: '빈 방이 목록에서 사라진다' });
      t.errorsOk('다시 멀티로');
      t.page = guest;
      t.errorsOk('손님: 다시 멀티로');
      t.page = host;

      t.setSection('폭파 미션 짧게');
      // 셋째 방: 방장이 대기실에서 폭파 미션으로 바꾸면 규칙은 클래식, 맵은 미션 맵이 된다. 방장(블루)이 A에 설치하고 손님(레드)이 해체한다
      // 방에서 나오는 동안(leaving)은 로비 화면이 먼저 뜨지만 방 만들기가 먹지 않는다. 로비가 다 뜰 때까지 기다린다
      await host.waitFor(`__qa.ctx.screen === "lobby" && !document.querySelector('.sk-lobby .sk-loading')`, 15000, { label: '방장 로비(폭파 방 전)' });
      await host.clickText('.sk-lobby .sk-bar-actions .sk-btn', '방 만들기');
      await host.waitFor(`!!document.querySelector('.sk-create-sheet')`, 3000, { label: '방 만들기 시트' });
      await host.fn(() => { const el = document.querySelector('.sk-create-sheet input'); el.focus(); el.select(); });
      await host.type('폭파 방');
      // 시트는 앞 방의 비밀번호(1234)를 그대로 들고 있다. 셋째 방은 비밀번호 없이 연다
      await host.fn(() => { const pw = document.querySelectorAll('.sk-create-sheet input')[1]; pw.value = ''; pw.dispatchEvent(new Event('input', { bubbles: true })); });
      t.check(await host.eval(`document.querySelectorAll('.sk-create-sheet input')[1].value === ''`), '셋째 방은 비밀번호를 비운다');
      await host.clickText('.sk-create-sheet .sk-form-actions .sk-btn', '방 만들기');
      await host.waitFor('__qa.ctx.screen === "room" && __qa.ui.isVisible("room")', 10000, { label: '폭파 방 대기실' });
      await guest.waitFor(`document.querySelectorAll('.sk-room-row').length === 1 && /폭파 방/.test(document.querySelector('.sk-room-row').textContent)`, 10000, { label: '목록에 폭파 방' });
      t.check(!/🔒/.test(await guest.eval(`document.querySelector('.sk-room-row').textContent`)), '폭파 방은 자물쇠 없이 보인다');
      await guest.click('.sk-room-join');
      await guest.waitFor('__qa.ctx.screen === "room" && __qa.ui.isVisible("room")', 15000, { label: '손님이 폭파 방에' });
      await host.click('.sk-modepick--bar .sk-mode-btn[data-mode="bomb"]');
      await guest.waitFor(`/폭파 미션/.test(document.querySelector('.sk-bar-sub.sk-chips').textContent)`, 5000, { label: '손님 화면에 폭파 미션' });
      await t.shot('bomb-room');
      if ((await guest.eval(`document.querySelector('.sk-ready-btn').getAttribute('aria-pressed')`)) !== 'true') await guest.click('.sk-ready-btn');
      await host.waitFor(`!document.querySelector('.sk-room-foot .sk-btn--primary').disabled`, 5000, { label: '폭파 미션 시작 가능' });
      await host.click('.sk-room-foot .sk-btn--primary');
      await host.waitFor('__qa.ctx.screen === "match" && __qa.world.internals.rnd.phase === "live"', 40000, { label: '폭파 미션 시작' });
      await guest.waitFor('__qa.ctx.screen === "match" && __qa.world.internals.rnd.phase === "live"', 15000, { label: '손님 폭파 미션 시작' });
      const side = (page) => page.eval('(() => { const h = __qa.world.internals.bombView.hud(); return { mode: __qa.world.mode, ruleset: __qa.world.ruleset, side: h && h.side, carrying: h && h.carrying, bomb: __qa.world.bomb && __qa.world.bomb.state, map: __qa.ctx.map && __qa.ctx.map.id }; })()');
      const hs = await side(host), gs = await side(guest);
      t.check(hs.mode === 'bomb' && hs.ruleset === 'classic' && hs.map === 'relay', '방장: 폭파 미션 · 클래식 · 미션 맵', hs);
      t.check(hs.side === 'attack' && hs.carrying, '방장(블루)이 공격이고 폭탄을 든다', hs);
      t.check(gs.mode === 'bomb' && gs.side === 'defense' && !gs.carrying, '손님(레드)은 수비', gs);
      await lockPointer(host);
      await lockPointer(guest);
      await host.eval(`(() => { const s = __qa.world.internals.bombView.sites.find((x) => x.id === 'A'); __qa.teleport(s.x, s.y + 0.2, s.z, 0); return true; })()`);
      await waitTicks(host, 30);
      await host.key('KeyE', 'down');
      await host.waitFor('__qa.world.bomb && __qa.world.bomb.state === "planted"', 9000, { label: '방장 설치' }).catch((e) => t.check(false, 'E를 누르고 있으면 설치된다', e.message));
      await host.key('KeyE', 'up');
      await eventually(t, guest, '__qa.world.bomb && __qa.world.bomb.state === "planted" && __qa.world.bomb.site === "A"', '손님 화면에도 A 구역에 설치됨', 5000);
      await guest.eval(`(() => { const b = __qa.world.bomb; __qa.teleport(b.pos[0] + 0.7, (b.pos[1] || 0) + 0.2, b.pos[2], 0); return true; })()`);
      await waitTicks(guest, 30);
      await guest.eval(`(() => { const b = __qa.world.bomb; __qa.aimAt([b.pos[0], (b.pos[1] || 0) + 0.1, b.pos[2]]); })()`);
      await sleep(400);   // 손님 위치가 방장에게 퍼질 때까지
      await t.shot('bomb-planted-host');
      t.page = guest;
      await t.shot('bomb-planted-guest');
      t.page = host;
      await guest.key('KeyE', 'down');
      await eventually(t, guest, '__qa.world.bomb && __qa.world.bomb.state === "defused"', '손님이 E를 누르고 있으면 해체된다', 12000);
      await guest.key('KeyE', 'up');
      const hist = await host.eval('(() => { const v = window.__skalafpsSession && window.__skalafpsSession.view; return v ? v.history : null; })()');
      t.check(Array.isArray(hist) && hist[0] && hist[0].reason === 'defuse' && hist[0].winner === 'charterer' && hist[0].attack === 'owner', '1라운드: 해체로 수비(레드) 승', hist);
      t.errorsOk('폭파 미션');
      t.page = guest;
      t.errorsOk('손님: 폭파 미션');
      t.page = host;
      // 손님이 나가면 방장 혼자 남아 기권승으로 끝난다 → 둘 다 로비로
      await guest.eval(`document.exitPointerLock()`);
      await guest.waitFor('__qa.ui.isVisible("pause")', 3000, { label: '손님 일시정지' });
      await guest.click('.sk-pause-btns .sk-btn--danger');
      await guest.click('.sk-pause .sk-confirm .sk-btn--danger');
      await guest.waitFor('__qa.ctx.screen === "lobby" || __qa.ctx.screen === "menu"', 10000, { label: '손님이 폭파 방에서 나감' });
      await host.waitFor('__qa.ui.isVisible("results")', 15000, { label: '방장 결과 화면(기권승)' }).catch((e) => t.check(false, '상대가 나가면 결과 화면', e.message));
      if (await host.eval('__qa.ui.isVisible("results")')) await host.click('.sk-res-actions .sk-btn--ghost');
      await host.waitFor('__qa.ctx.screen === "lobby" || __qa.ctx.screen === "menu"', 10000, { label: '방장이 로비로' });
      t.errorsOk('폭파 미션 끝');

      t.setSection('나가기');
      if (await host.eval('__qa.ui.isVisible("lobby")')) await host.click('.sk-lobby .sk-bar .sk-btn--ghost');
      await host.waitFor('__qa.ctx.screen === "menu" && __qa.ui.isVisible("menu")', 8000, { label: '방장 메뉴로' });
      t.check(await host.eval('!__qa.ctx.map && !__qa.ctx.rendering'), '메뉴로 돌아오면 맵을 치운다');
      await startPractice(host);
      await host.waitFor('__qa.ctx.screen === "sandbox" && !!__qa.run', 30000, { label: '멀티 뒤 연습장' });
      await host.waitFor('__qa.run.phase === "live"', 15000, { label: '멀티 뒤 연습장 live' });
      t.errorsOk('멀티 뒤 연습장');
    } finally {
      t.server.setConfig(null);
      if (guest) { await guest.close(); }
      await fake.close();
    }
    t.note('가짜 서버라서 실서버의 인증, 전송 한도, 실제 지연은 검증하지 못했다');
  }
};
