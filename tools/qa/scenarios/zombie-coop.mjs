/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 시나리오 26. 좀비 물량 막기 멀티(함께 막기). 가짜 Supabase에 방장·손님 두 클라이언트를 붙인다. 방장은 메뉴의 좀비 버튼 → '같이 하기'
 *          한 번으로 공개 좀비 방을 만들어 대기실로 가고, 손님은 로비 목록에서 들어간다(손님은 로비 방 만들기 시트의 좀비 설정도 본다).
 *          방장이 돌리는 좀비가 손님 화면에도 그려지는지, 손님의 사격과 탄창 줍기(수류탄도 채움)를 방장이 확정하는지, 팀 레벨이 오르면 둘 다 증강을
 *          고르고 고르는 사람은 무적이며 좀비가 노리지 않는지(20초 제한 · 카드 입력 잠금 · [확인] · 고른 뒤 3초 무적), 쓰러진 손님을 방장이 옆에서
 *          F를 3초 눌러 그 자리에서 체력 10으로 살리는지(바닥 표식 · 이름표 · 살리기 막대), 살리지 않으면 다음 스테이지에 절반 체력으로 일어나는지 본다.
 *          --relay node면 실시간 메시지를 Node 중계 서버로 보낸다(운영 설정과 같은 길).
 */
import { startRelay } from '../../../server/relay/src/node.js';
import { startFakeSupabase } from '../fake-supabase.mjs';
import { LOW_QUALITY, clickFire, lockPointer, qaInit, readyGame, sleep, waitTicks } from '../kit.mjs';
import { CARD_ARM_MS } from '../../../js/ui/cards.js';
import { HORDE } from '../../../js/game/horde/rules.js';
import { CARD_LOG, CARD_MID, CARD_STATE } from './zombie.mjs';

const SIZE = { width: 640, height: 360 };
const DIRECTOR = 'window.__skalafpsSession.match';
/** 방장 시뮬레이션의 한 사람 */
const PL = (id) => `${DIRECTOR}.internals.players.get(${JSON.stringify(id)})`;

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
/** 시험 구간을 차분하게: 좀비를 모두 멈추고(공격도) 새 좀비를 막고, 스테이지 시간을 처음으로 되돌린다(방장) */
const FREEZE = `(() => {
  const d = ${DIRECTOR}, S = d.internals.S;
  for (const Z of d.internals.zombies.values()) {
    Z.speed = 0; Z.attackReady = 1e12; Z.rangedAt = 1e12; Z.progressAt = S.clock + 600000;
    if (Z.state === 'wind') Z.state = 'move';
    if (Z.skillReady) { Z.skillReady = Z.skillReady.map(() => 1e12); Z.skill = null; }
  }
  S.spawnAt = Infinity;
  if (!S.queue.length) S.queue.push({ type: 'walker' });
  S.stageEnd = S.clock + d.rules.stageMs;
  return true;
})()`;
/** 페이지(방장)에서: 살아 있는 일반 좀비가 n마리가 되도록 바로 내보낸다 → 지금 수 */
function spawnSome(n) {
  const d = window.__skalafpsSession.match, S = d.internals.S;
  const alive = [...d.internals.zombies.values()].filter((Z) => Z.state !== 'dead' && !Z.boss);
  if (alive.length < n) {
    for (let i = alive.length; i < n + 1; i++) S.queue.unshift({ type: 'walker' });
    S.spawnAt = S.clock;
  }
  return alive.length;
}
async function ensureZombies(page, n) {
  for (let i = 0; i < 80; i++) {
    if ((await page.fn(spawnSome, n)) >= n) { await page.eval(FREEZE); return; }
    await sleep(120);
  }
  throw new Error(`좀비 ${n}마리를 세우지 못했어요`);
}
/**
 * 페이지(방장)에서: 좀비 하나를 그 사람 바로 옆(dist m, 방장에게서 먼 쪽)에 세운다. attack이면 바로 때릴 수 있게 둔다(노릴지는 좀비가 정한다).
 * o = { id: 사람 id, dist, attack, zid? } → 좀비 번호(0 = 못 세움)
 */
function zombieBeside(o) {
  const s = window.__skalafpsSession, d = s.match, S = d.internals.S, c = window.__qa.ctx;
  const P = d.internals.players.get(o.id), H = d.internals.players.get(s.me);
  if (!P || !P.pos) return 0;
  const alive = [...d.internals.zombies.values()].filter((Z) => Z.state !== 'dead' && !Z.boss);
  const Z = alive.find((q) => q.id === o.zid) || alive[0];
  if (!Z) return 0;
  let ux = 1, uz = 0;
  if (H && H.pos && H !== P) {
    const dx = P.pos[0] - H.pos[0], dz = P.pos[2] - H.pos[2], l = Math.hypot(dx, dz);
    if (l > 0.1) { ux = dx / l; uz = dz / l; }
  }
  let at = null;
  for (const [a, b] of [[ux, uz], [-uz, ux], [uz, -ux], [-ux, -uz]]) {
    const x = P.pos[0] + a * o.dist, z = P.pos[2] + b * o.dist;
    if (!c.physics.overlapsCapsule(c.world, x, P.pos[1] + 0.05, z, 0.4, 1.8)) { at = [x, P.pos[1], z]; break; }
  }
  if (!at) at = [P.pos[0] + ux * o.dist, P.pos[1], P.pos[2] + uz * o.dist];
  Z.body.pos[0] = at[0]; Z.body.pos[1] = at[1]; Z.body.pos[2] = at[2];
  Z.body.vel[0] = Z.body.vel[1] = Z.body.vel[2] = 0;
  Z.state = 'move'; Z.speed = 0; Z.progressAt = S.clock + 600000; Z.target = null; Z.targetAt = 0; Z.bestDist = Infinity;
  Z.attackReady = o.attack ? S.clock : 1e12;
  Z.yaw = Math.atan2(-(P.pos[0] - at[0]), -(P.pos[2] - at[2]));
  return Z.id;
}
/** 페이지(방장)에서: 좀비 하나를 좀비 문으로 치우고 멈춘다 */
function parkZombie(zid) {
  const d = window.__skalafpsSession.match;
  const Z = d.internals.zombies.get(zid), g = d.internals.gates[0];
  if (!Z || !g) return false;
  Z.body.pos[0] = g[0]; Z.body.pos[1] = Number.isFinite(g[1]) ? g[1] : 0; Z.body.pos[2] = g[2];
  Z.attackReady = 1e12; Z.target = null;
  return true;
}
/** HUD 요소들의 화면 자리와 겹침: 살리기 막대 · 관전 이름표 · 안내 줄 · 좀비 경고(무적 표시) */
const BOXES = `(() => {
  const box = (s) => { const el = document.querySelector(s); if (!el || el.hidden || !__qa.visible(s)) return null; const r = el.getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom), text: el.textContent }; };
  const hit = (a, b) => !!a && !!b && a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
  const revive = box('.sk-hz-revive'), spec = box('.sk-spec'), hint = box('.sk-hint'), warn = box('.sk-hz-warn');
  return { vw: innerWidth, vh: innerHeight, revive, spec, hint, warn, specHit: hit(revive, spec), warnHit: hit(hint, warn) };
})()`;

/** 카드 화면에서 이 카드를 눌러 선택하고 [확인]으로 정한다(잠금이 풀린 뒤) */
async function pickCard(page, index) {
  await page.waitFor(`__qa.ui.isVisible('cards') && !document.querySelector('.sk-cards').classList.contains('is-arming')`, 8000, { label: '카드 잠금 풀림' });
  const name = await page.eval(`document.querySelectorAll('.sk-cd-card .sk-cd-name')[${index}].textContent`);
  await page.clickText('.sk-cd-card .sk-cd-name', name);
  await page.waitFor(`document.querySelectorAll('.sk-cd-card')[${index}].classList.contains('is-selected') && !document.querySelector('.sk-cd-confirm').disabled`, 3000, { label: '카드 선택' });
  await page.click('.sk-cd-confirm');
  return name;
}

export default {
  name: 'zombie-coop',
  title: '좀비 물량 막기 멀티: 같이 하기 방 · 동기화 · 손님 사격 · 증강(무적 · 안 노림) · 동료 살리기 · 부활',
  timeoutMs: 10 * 60 * 1000,
  async run(t) {
    const fake = await startFakeSupabase({});
    const relay = t.relay === 'node' ? await startRelay({ port: 0 }) : null;
    const relayUrl = relay ? relay.url : (t.relay ? t.relay.replace(/\/+$/, '') : null);
    t.server.setConfig(relayUrl
      ? `window.SKALA_CONFIG = { supabase: { url: ${JSON.stringify(fake.url)}, anonKey: 'sb_qa_fake' }, transport: 'relay', relay: { url: ${JSON.stringify(relayUrl)} } };`
      : fake.config);
    let guest = null;
    try {
      t.setSection('같이 하기 한 번으로 공개 좀비 방 · 손님은 로비 목록에서');
      const host = await t.newPage();
      await openPlayer(t, host, '방장');
      guest = await t.browser.newPage({ isolated: true });
      await openPlayer(t, guest, '손님');
      // 손님: 로비 방 만들기 시트의 좀비 모드 설정(만들지는 않는다)
      await goLobby(guest);
      await guest.clickText('.sk-lobby .sk-bar-actions .sk-btn', '방 만들기');
      await guest.waitFor(`!!document.querySelector('.sk-create-sheet')`, 3000, { label: '방 만들기 시트' });
      await guest.click('.sk-create-sheet .sk-mode-btn[data-mode="zombie"]');
      await sleep(150);
      const sheet = await guest.eval(`({ max: document.querySelector('.sk-create-sheet [aria-label="최대 인원"] .sk-stepper-val').textContent, plusOff: [...document.querySelectorAll('.sk-create-sheet [aria-label="최대 인원"] .sk-btn--icon')].pop().disabled })`);
      t.check(sheet.max === '4명' && sheet.plusOff, '좀비 방은 최대 4명(처음 값도 4명)', sheet);
      const zmaps = await guest.eval(`[...document.querySelectorAll('.sk-create-sheet .sk-mapcard-name')].map((e) => e.textContent)`);
      t.check(zmaps.join() === '고속도로 휴게소,지하철 환승역', '좀비 방의 맵은 좀비 전용 맵 둘', zmaps);
      await guest.clickText('.sk-create-sheet .sk-form-actions .sk-btn', '취소');
      await guest.waitFor(`!document.querySelector('.sk-create-sheet')`, 3000, { label: '방 만들기 시트 닫힘' });
      // 방장: 메뉴 → 좀비 물량 막기 → 같이 하기(고른 채로 열린다) → 확인(로비를 거쳐 바로 대기실)
      await host.clickText('.sk-menu-btn', '좀비 물량 막기');
      await host.waitFor('!!document.querySelector(".sk-sheet.sk-zpick")', 5000, { label: '좀비 고르기 시트' });
      const zp = await host.eval(`(() => {
        const room = document.querySelector('.sk-zpick .sk-zpick-opt--room'), note = document.querySelector('.sk-zpick .sk-zpick-note');
        return { roomOff: room.disabled, roomOn: room.getAttribute('aria-checked') === 'true', roomSub: room.querySelector('.sk-zpick-sub').textContent,
          note: note.hidden ? '' : note.textContent, focusRoom: document.activeElement === room };
      })()`);
      t.check(!zp.roomOff && zp.roomOn && !zp.note && /로비에 바로 보이는 좀비 방을 만들어요 · 최대 4명/.test(zp.roomSub), '온라인이면 같이 하기가 켜져 있고 고른 채로 열린다', zp);
      t.check(zp.focusRoom, '시트를 열면 같이 하기에 포커스', zp);
      await t.shot('zombie-pick-online');
      await host.clickText('.sk-zpick .sk-btn', '확인');
      await host.waitFor('__qa.ctx.screen === "room" && __qa.ui.isVisible("room")', 20000, { label: '한 번에 대기실' });
      const meta = await host.eval(`(() => { const s = window.__skalafpsSession, m = s.room.meta;
        return { name: m.name, mode: m.mode, max: m.max, locked: !!m.locked, mapId: m.mapId, isHost: s.isHost, title: __qa.text('.sk-room-title'), map: __qa.text('.sk-room-mapcur'),
          zpick: !!document.querySelector('.sk-zpick') }; })()`);
      t.check(meta.isHost && meta.mode === 'zombie' && meta.name === '방장의 좀비 방' && meta.title === '방장의 좀비 방', '같이 하기 + 확인으로 내 이름의 좀비 방을 만들고 방장으로 대기실에 들어간다', meta);
      t.check(meta.max === 4 && !meta.locked && meta.mapId === 'restarea' && /고속도로 휴게소/.test(meta.map), '공개 방(비밀번호 없음) · 최대 4명 · 첫 좀비 전용 맵', meta);
      const solo = await host.eval(`!document.querySelector('.sk-room-foot .sk-btn--primary').disabled`);
      t.check(solo, '좀비 방은 혼자서도 시작할 수 있다');
      await guest.waitFor(`document.querySelectorAll('.sk-room-row').length === 1`, 10000, { label: '목록에 좀비 방' });
      const row = await guest.eval(`document.querySelector('.sk-room-row').textContent`);
      t.check(/좀비 물량 막기/.test(row) && /방장의 좀비 방/.test(row) && !/🔒/.test(row), '로비 목록에 공개 좀비 방(이름 · 좀비 배지 · 자물쇠 없음)', row);
      await guest.click('.sk-room-join');
      await guest.waitFor('__qa.ctx.screen === "room" && __qa.ui.isVisible("room")', 10000, { label: '손님 대기실' });
      t.check(!(await guest.eval(`!!document.querySelector('.sk-pw-sheet')`)), '공개 방이라 비밀번호를 묻지 않는다');
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
      // 준비 12초는 시험용으로 줄인다(무기 고르기 창은 단계가 바뀌면 닫힌다)
      await host.waitFor(`${DIRECTOR} && (${DIRECTOR}.phase === 'prep' || ${DIRECTOR}.phase === 'wave')`, 30000, { label: '방장 준비 단계' });
      await host.eval(`(() => { const S = ${DIRECTOR}.internals.S; if (${DIRECTOR}.phase === 'prep') S.phaseEnd = Math.min(S.phaseEnd, S.clock + 1500); return true; })()`);
      await host.waitFor(`${DIRECTOR}.phase === 'wave'`, 40000, { label: '방장 1스테이지' });
      await guest.waitFor(`__qa.visible('.sk-hz-top') && /남은 좀비/.test(__qa.text('.sk-hz-line'))`, 15000, { label: '손님 HUD 띠' });
      await guest.waitFor(`__qa.world.horde.count >= 2`, 20000, { label: '손님 화면에 좀비' });
      const g0 = await guest.eval(`({ count: __qa.world.horde.count, alive: __qa.world.localAlive, team: [...document.querySelectorAll('.sk-hz-mate')].map((e) => e.textContent) })`);
      t.check(g0.alive, '손님도 출격한다', g0);
      t.check(g0.team.length === 2, 'HUD에 두 사람의 체력', g0.team);
      const hostIds = await host.eval(`[...${DIRECTOR}.internals.zombies.values()].filter((Z) => Z.state !== 'dead').map((Z) => Z.id).sort((a, b) => a - b)`);
      const guestIds = await guest.eval(`__qa.world.horde.rendered.map((z) => z.id).sort((a, b) => a - b)`);
      t.check(guestIds.length && guestIds.every((id) => hostIds.includes(id) || id < Math.max(...hostIds) + 1), '손님 화면의 좀비 = 방장의 좀비', { hostIds, guestIds });
      const hid = await host.eval('window.__skalafpsSession.me');
      const gid = await guest.eval('window.__skalafpsSession.me');
      t.check(gid && (await host.eval('window.__skalafpsSession.state.actors')).includes(gid), '방장이 손님을 안다', gid);

      t.setSection('손님의 사격이 방장 시뮬레이션에 들어간다');
      // 방장 쪽에서 좀비 하나를 손님 앞 6 m에 세운다(손님 위치는 sync로 안다)
      const zid = await host.eval(`(() => {
        const s = window.__skalafpsSession, d = s.match;
        const r = s.sync.remote(${JSON.stringify(gid)});
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

      t.setSection('손님이 탄창을 주우면 방장이 확정한다(수류탄도 채운다)');
      t.check(await host.eval(`${DIRECTOR}.internals.gates.length === 6`), '좀비 방은 좀비 전용 맵(좀비 문 여섯)에서 한다');
      // 손님 예비 탄과 수류탄을 줄여 두고(시험용) 방장 시뮬레이션에 손님 발밑 탄창 하나를 떨어뜨린다
      await guest.eval(`__qa.arsenal.equipWith('ar_std', { mag: 12, reserve: 15 })`);
      await guest.eval(`__qa.arsenal.giveGrenade(-99)`);
      const lootId = await host.eval(`(() => {
        const s = window.__skalafpsSession, d = s.match, S = d.internals.S;
        const r = s.sync.remote(${JSON.stringify(gid)});
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
      const gn = await guest.eval(`({ nade: __qa.arsenal.getAmmo('gr_frag'), callouts: [...document.querySelectorAll('.sk-callout')].map((e) => e.textContent) })`);
      t.check(gn.nade.mag === gn.nade.magSize && gn.nade.magSize >= 1, '손님의 수류탄도 최대까지 찬다', gn.nade);
      t.check(gn.callouts.some((x) => /탄창 \+30발 · 💣 수류탄 가득/.test(x)), '손님 알림: 탄창 +30발 · 수류탄 가득', gn.callouts);

      t.setSection('팀 레벨 업 → 둘 다 증강 · 고르는 사람은 무적이고 좀비가 노리지 않는다');
      await host.eval(FREEZE);
      await guest.eval(CARD_LOG);
      const lv = await host.eval(`(() => { const d = ${DIRECTOR}, S = d.internals.S, R = d.rules;
        d.internals.addXp(R.xpBase + R.xpStep * (S.level - 1) - S.xp);
        return { level: S.level, offers: [...d.internals.players.values()].map((P) => [P.id, P.offer ? P.offer.cards.length : 0, Math.round(P.offerUntil - S.clock)]) }; })()`);
      t.check(lv.level === 2 && lv.offers.length === 2 && lv.offers.every((o) => o[1] === 3 && o[2] > HORDE.cardMs - 1000), `팀 레벨이 오르면 둘 다 증강 3장(${HORDE.cardMs / 1000}초 안에 고른다)`, lv);
      // 손님: 카드가 뜨자마자(잠금 중) 쏘던 손으로 가운데 카드를 눌러도 선택되지 않고 방장에게 고르기가 가지 않는다
      const early = JSON.parse(await guest.waitFor(CARD_MID, 15000, { intervalMs: 30, label: '손님 카드' }));
      if (early.since < 500) {
        await guest.mouseClick(early.x, early.y);
        await sleep(600);
        const st = await guest.eval(`({ visible: __qa.ui.isVisible('cards'), down: __qa.cardLog.downs[0], selected: document.querySelectorAll('.sk-cd-card.is-selected').length })`);
        const hostSaw = await host.eval(`({ cards: ${PL(gid)}.cards.length, offer: !!${PL(gid)}.offer })`);
        t.check(typeof st.down === 'number' && st.down < CARD_ARM_MS, '손님이 가운데 카드를 잠금 중에 눌렀다(카드가 뜬 뒤 ms)', st.down);
        t.check(st.visible && st.selected === 0 && hostSaw.cards === 0 && hostSaw.offer, '잠긴 동안 누른 손님의 클릭은 카드를 선택하지도 고르지도 않는다(방장에게 가지 않는다)', { ...st, hostSaw });
      } else t.note(`손님 화면이 카드가 뜬 뒤 ${Math.round(early.since)} ms가 지나서야 읽혀 잠금 중 누르기 시험을 건너뛴다`);
      // 방장이 먼저 고른다 → 손님만 고르는 중
      await host.waitFor(`__qa.ui.isVisible('cards')`, 15000, { label: '방장 카드' });
      const hostCard = await pickCard(host, 0);
      await host.waitFor(`${PL(hid)}.cards.length === 1 && !${PL(hid)}.offer`, 8000, { label: '방장 카드 반영' });
      t.check(true, `방장이 고른 카드(${hostCard})가 들어간다`);
      // 손님 바로 옆(방장에게서 먼 쪽 1 m)에 좀비를 세운다. 고르는 손님은 노리지 않고 방장을 노린다(멀어서 때리지는 못한다)
      await ensureZombies(host, 1);
      const ghp0 = await host.eval(`${PL(gid)}.hp`);
      const pz = await host.fn(zombieBeside, { id: gid, dist: 1.0, attack: true });
      t.check(pz > 0, '고르는 손님 바로 옆에 좀비를 세운다', pz);
      await sleep(1500);
      const tg = await host.eval(`(() => { const d = ${DIRECTOR}, Z = d.internals.zombies.get(${pz}), P = ${PL(gid)}, H = ${PL(hid)};
        return { target: Z && Z.target, offer: !!P.offer, hp: P.hp, dGuest: Math.hypot(Z.body.pos[0] - P.pos[0], Z.body.pos[2] - P.pos[2]), dHost: Math.hypot(Z.body.pos[0] - H.pos[0], Z.body.pos[2] - H.pos[2]) }; })()`);
      t.check(tg.offer && tg.target === hid && tg.dGuest < tg.dHost, '증강을 고르는 손님은 바로 옆 좀비도 노리지 않는다(더 먼 방장을 노린다)', tg);
      t.check(tg.hp === ghp0, '고르는 동안 손님은 맞지 않는다', { before: ghp0, after: tg.hp });
      const gc = await guest.eval(`({ ...${CARD_STATE}, warn: __qa.text('.sk-hz-warn') })`);
      const secs = Number((/⏳ (\d+)초/.exec(gc.timer || '') || [])[1]);
      t.check(gc.cards.length === 3 && /레벨 업! Lv 2/.test(gc.title), '손님에게도 레벨 업 증강 3장', gc);
      t.check(/고르는 동안 무적이에요/.test(gc.sub) && secs > 5 && secs <= HORDE.cardMs / 1000, `손님 카드: 고르는 동안 무적 · ${HORDE.cardMs / 1000}초 제한 표시`, gc);
      const team = await host.eval(`[...document.querySelectorAll('.sk-hz-mate')].map((e) => e.textContent)`);
      t.check(team.some((x) => /손님/.test(x) && /증강 고르는 중 🛡/.test(x)), '방장 HUD 동료 줄: 손님 · 증강 고르는 중 🛡', team);
      t.page = guest;
      await t.shot('guest-cards');
      t.page = host;
      // 손님이 고른다 → 좀비가 손님을 다시 노리지만 고른 뒤 3초는 맞아도 피해가 없다
      const guestCard = await pickCard(guest, 0);
      await host.waitFor(`${PL(gid)}.cards.length === 1 && !${PL(gid)}.offer`, 8000, { label: '방장에게 손님 카드 반영' }).then(
        () => t.check(true, `손님이 [확인]으로 고른 카드(${guestCard})가 방장 시뮬레이션에 들어간다`),
        (err) => t.check(false, '손님이 고른 카드가 방장 시뮬레이션에 들어간다', err.message));
      const inv = await host.eval(`({ left: ${PL(gid)}.invulnUntil - ${DIRECTOR}.internals.S.clock, hp: ${PL(gid)}.hp })`);
      t.check(inv.left > HORDE.pickInvulnMs - 1200 && inv.left <= HORDE.pickInvulnMs, `손님은 고른 직후 ${HORDE.pickInvulnMs / 1000}초 무적(방장)`, inv);
      await host.waitFor(`(${DIRECTOR}.internals.zombies.get(${pz}) || {}).target === ${JSON.stringify(gid)}`, 3000, { label: '좀비가 손님을 다시 노림' }).then(
        () => t.check(true, '다 고른 손님을 좀비가 다시 노린다'), (err) => t.check(false, '다 고른 손님을 좀비가 다시 노린다', err.message));
      await guest.waitFor(`/무적/.test(__qa.text('.sk-hz-warn') || '')`, 3000, { label: '손님 무적 표시' }).then(
        () => t.check(true, '손님 HUD에 고른 뒤 무적 표시'), (err) => t.check(false, '손님 HUD에 고른 뒤 무적 표시', err.message));
      const swing0 = await host.eval(`(${DIRECTOR}.internals.zombies.get(${pz}) || {}).attackReady`);
      await host.waitFor(`(${DIRECTOR}.internals.zombies.get(${pz}) || {}).attackReady > ${swing0} || ${PL(gid)}.hp < ${inv.hp}`, 3000, { label: '좀비가 휘두름' }).catch(() => {});
      const mid = await host.eval(`({ hp: ${PL(gid)}.hp, left: ${PL(gid)}.invulnUntil - ${DIRECTOR}.internals.S.clock, swung: (${DIRECTOR}.internals.zombies.get(${pz}) || {}).attackReady > ${swing0} })`);
      t.check(mid.swung && mid.left > 0 && mid.hp === inv.hp, '무적인 동안 좀비에게 맞아도 피해가 없다', mid);
      await host.waitFor(`${PL(gid)}.hp < ${inv.hp}`, 5000, { label: '무적이 끝나고 맞음' }).then(
        () => t.check(true, '무적이 끝나면 다시 맞는다'), (err) => t.check(false, '무적이 끝나면 다시 맞는다', err.message));
      await host.fn(parkZombie, pz);
      // 20초 제한: 마감이 지나면 제안 중 하나를 무작위로 받는다(시험용으로 마감을 당긴다)
      await host.eval(`(() => { const d = ${DIRECTOR}, S = d.internals.S, R = d.rules; d.internals.addXp(R.xpBase + R.xpStep * (S.level - 1) - S.xp); return true; })()`);
      await guest.waitFor(`__qa.ui.isVisible('cards')`, 8000, { label: '두 번째 손님 카드' });
      await host.eval(`(() => { const S = ${DIRECTOR}.internals.S; for (const P of ${DIRECTOR}.internals.players.values()) if (P.offer) P.offerUntil = S.clock + 800; return true; })()`);
      await host.waitFor(`[...${DIRECTOR}.internals.players.values()].every((P) => !P.offer && P.cards.length === 2)`, 6000, { label: '마감 지나 무작위' }).then(
        () => t.check(true, '시간 안에 안 고르면 둘 다 제안 중 하나를 무작위로 받는다'), (err) => t.check(false, '시간 안에 안 고르면 제안 중 하나를 무작위로 받는다', err.message));
      await guest.waitFor(`!__qa.ui.isVisible('cards') && [...document.querySelectorAll('.sk-callout')].some((e) => /시간 초과/.test(e.textContent))`, 5000, { label: '손님 시간 초과 알림' }).then(
        () => t.check(true, '손님 카드 화면이 닫히고 (시간 초과) 알림'), (err) => t.check(false, '손님 카드 화면이 닫히고 (시간 초과) 알림', err.message));
      for (const page of [host, guest]) { t.page = page; t.errorsOk(page === host ? '방장: 증강' : '손님: 증강'); }
      t.page = host;

      t.setSection('쓰러진 손님을 방장이 옆에서 F를 3초 눌러 살린다');
      await host.eval(FREEZE);
      await ensureZombies(host, 1);
      // 방장 시뮬레이션의 좀비 공격으로 손님을 쓰러뜨린다(시험용: 체력 1)
      await host.eval(`(() => { const P = ${PL(gid)}; P.hp = 1; P.invulnUntil = 0; P.hitUntil = 0; P.shield = 0; return true; })()`);
      const kz = await host.fn(zombieBeside, { id: gid, dist: 1.0, attack: true });
      await host.waitFor(`!${PL(gid)}.alive`, 6000, { label: '손님 쓰러짐(방장)' });
      await host.fn(parkZombie, kz);
      const down = await host.eval(`({ pos: ${PL(gid)}.downPos, phase: ${DIRECTOR}.phase })`);
      t.check(Array.isArray(down.pos) && down.phase === 'wave', '좀비에게 쓰러진 자리(downPos)를 방장이 기억하고 경기는 이어진다', down);
      await guest.waitFor(`!__qa.world.localAlive`, 8000, { label: '손님 쓰러짐' }).then(() => t.check(true, '손님 화면도 쓰러진다'), (err) => t.check(false, '손님 화면도 쓰러진다', err.message));
      const gsub = await guest.waitFor(`/동료가 F를/.test(__qa.text('.sk-center-sub') || '') && __qa.text('.sk-center-sub')`, 3000, { label: '쓰러짐 안내' }).catch(() => '');
      t.check(/동료가 F를 3초 누르면 일어나요 · 아니면 다음 스테이지에/.test(gsub), '쓰러진 손님 안내: 동료가 F를 3초 누르면 · 아니면 다음 스테이지', gsub);
      await host.waitFor(`__qa.world.horde.downs.length === 1`, 4000, { label: '방장 화면의 쓰러진 동료 표시' });
      const mark = await host.eval(`({ downs: __qa.world.horde.downs, stats: __qa.world.horde.stats, team: [...document.querySelectorAll('.sk-hz-mate')].map((e) => e.textContent) })`);
      const md = mark.downs[0];
      t.check(md.id === gid && md.name === '손님' && Math.hypot(md.pos[0] - down.pos[0], md.pos[2] - down.pos[2]) < 0.05 && !md.by && md.progress === 0, '방장 화면: 쓰러진 자리에 손님 표식(아직 살리는 사람 없음)', mark.downs);
      t.check(mark.stats.downs === 1, '쓰러진 동료 표시 하나', mark.stats);
      t.check(mark.team.some((x) => /💀 손님/.test(x) && /곁에서 3초 눌러 살리기/.test(x)), '방장 HUD 동료 줄: 💀 손님 · 곁에서 3초 눌러 살리기', mark.team);
      // 방장이 쓰러진 자리 1 m 옆으로 가서 그쪽을 본다
      await host.bringToFront();
      await lockPointer(host);
      await host.eval(`(() => {
        const c = __qa.ctx, p = ${JSON.stringify(down.pos)};
        let spot = null;
        for (const [a, b] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
          const x = p[0] + a, z = p[2] + b;
          if (!c.physics.overlapsCapsule(c.world, x, p[1] + 0.05, z, 0.4, 1.8)) { spot = [x, z]; break; }
        }
        if (!spot) spot = [p[0] + 1, p[2]];
        __qa.teleport(spot[0], p[1] + 0.05, spot[1], Math.atan2(-(p[0] - spot[0]), -(p[2] - spot[1])));
        c.player.state.pitch = -0.45;
        return true;
      })()`);
      await host.waitFor(`/F 길게 눌러 🩹 손님 살리기 \\(3초\\)/.test(__qa.text('.sk-hint') || '')`, 4000, { label: '살리기 안내' }).then(
        () => t.check(true, '쓰러진 동료 옆에 서면 안내: F 길게 눌러 🩹 손님 살리기 (3초)'), async (err) => t.check(false, '쓰러진 동료 옆에 서면 살리기 안내', { err: err.message, hint: await host.eval(`__qa.text('.sk-hint')`) }));
      const hbox = await host.eval(BOXES);
      if (hbox.warnHit) t.note(`방장 화면(${hbox.vw}x${hbox.vh}): 살리기 안내 줄과 무적 표시(.sk-hz-warn)가 겹친다 ${JSON.stringify({ hint: hbox.hint, warn: hbox.warn })}`);
      await t.shot('revive-marker');
      const t0 = Date.now();
      await host.key('KeyF', 'down');
      await sleep(1400);
      const hold = await host.eval(`(() => {
        const r = ${DIRECTOR}.internals.revives.get(${JSON.stringify(gid)});
        const fill = /scaleX\\(([\\d.]+)\\)/.exec(document.querySelector('.sk-hz-revive-bar i').style.transform || '');
        return { rv: r ? { by: r.by, ms: r.ms } : null, bar: __qa.visible('.sk-hz-revive') ? __qa.text('.sk-hz-revive-t') : '', fill: fill ? Number(fill[1]) : 0,
          hint: __qa.text('.sk-hint'), downs: __qa.world.horde.downs, team: [...document.querySelectorAll('.sk-hz-mate')].map((e) => e.textContent), interact: __qa.ctx.input.state.interact };
      })()`);
      t.check(hold.interact && hold.rv && hold.rv.by === hid && hold.rv.ms > 500, 'F를 누르고 있는 동안 방장이 살리기 시간을 센다', hold);
      t.check(/🩹 손님 살리는 중/.test(hold.bar) && hold.fill > 0.1 && hold.fill < 0.95, '방장 화면: 크로스헤어 아래 살리기 막대가 찬다', hold);
      t.check(/🩹 손님 살리는 중…/.test(hold.hint), '안내 줄: 🩹 손님 살리는 중…', hold.hint);
      t.check(hold.downs.length === 1 && hold.downs[0].by === hid && hold.downs[0].progress > 0.1, '쓰러진 자리 표식에 살리는 사람과 진행이 실린다(이름표 %)', hold.downs);
      t.check(hold.team.some((x) => /살리는 중 \d+%/.test(x)), '동료 줄: 살리는 중 NN%', hold.team);
      await t.shot('revive-host');
      const gbar = await guest.eval(`({ bar: __qa.visible('.sk-hz-revive') ? __qa.text('.sk-hz-revive-t') : '', raw: __qa.text('.sk-hz-revive-t'), alive: __qa.world.localAlive,
        cursor: !!document.querySelector('.sk-ui.sk-cursor'), locked: __qa.ctx.input.locked })`);
      t.check(!gbar.alive && /🩹 방장님이 살리는 중/.test(gbar.bar), '쓰러진 손님 화면: 🩹 방장님이 살리는 중 막대', gbar);
      // 쓰러진 사람은 관전 이름표('관전 중 · 방장')와 살리기 막대를 함께 본다: 둘이 겹치면 안 된다(640x360 화면)
      const gbox = await guest.eval(BOXES);
      if (gbox.spec) t.check(!gbox.specHit, `쓰러진 손님 화면(${gbox.vw}x${gbox.vh}): 살리기 막대와 관전 이름표가 겹치지 않는다`, gbox);
      else t.note(`쓰러진 손님 화면에 관전 이름표가 없어 겹침을 보지 못했다 ${JSON.stringify(gbox)}`);
      t.page = guest;
      await t.shot('revive-guest');
      t.page = host;
      await host.waitFor(`${PL(gid)}.alive`, 5000, { intervalMs: 50, label: '손님이 일어남(방장)' }).then(
        () => t.check(true, 'F를 3초 누르고 있으면 손님이 일어난다'), (err) => t.check(false, 'F를 3초 누르고 있으면 손님이 일어난다', err.message));
      const took = Date.now() - t0;
      await host.key('KeyF', 'up');
      t.check(took >= HORDE.reviveHoldMs - 300 && took < HORDE.reviveHoldMs + 2500, `살리는 데 걸린 시간이 ${HORDE.reviveHoldMs / 1000}초쯤`, took);
      const up = await host.eval(`({ hp: ${PL(gid)}.hp, inv: ${PL(gid)}.invulnUntil - ${DIRECTOR}.internals.S.clock, downPos: ${PL(gid)}.downPos, revives: ${DIRECTOR}.internals.revives.size })`);
      t.check(up.hp === HORDE.reviveHp && up.inv > 0 && up.inv <= HORDE.reviveInvulnMs && !up.downPos && up.revives === 0, `살아난 손님: 체력 ${HORDE.reviveHp} · ${HORDE.reviveInvulnMs / 1000}초 무적(방장)`, up);
      await guest.waitFor(`__qa.world.localAlive && __qa.ctx.player.state.hp === ${HORDE.reviveHp}`, 5000, { label: '손님 화면에서 일어남' }).then(
        () => t.check(true, `손님 화면도 그 자리에서 체력 ${HORDE.reviveHp}으로 일어난다`), (err) => t.check(false, '손님 화면도 일어난다', err.message));
      const gup = await guest.eval(`({ pos: __qa.ctx.player.state.pos.slice(), main: __qa.text('.sk-center-main'), sub: __qa.text('.sk-center-sub') })`);
      t.check(Math.hypot(gup.pos[0] - down.pos[0], gup.pos[2] - down.pos[2]) < 0.6, '쓰러진 자리에서 일어난다(다음 스테이지 스폰 자리가 아니다)', { pos: gup.pos, down: down.pos });
      t.check(/다시 일어났어요!/.test(gup.main) && /방장님이 살렸어요 · 2초 무적/.test(gup.sub), '손님 안내: 다시 일어났어요! · 방장님이 살렸어요 · 2초 무적', gup);
      const hcall = await host.eval(`({ callouts: [...document.querySelectorAll('.sk-callout')].map((e) => e.textContent), downs: __qa.world.horde.downs.length, hint: __qa.text('.sk-hint') || '' })`);
      t.check(hcall.callouts.some((x) => /🩹 손님님을 살렸어요/.test(x)), '방장 알림: 🩹 손님님을 살렸어요', hcall.callouts);
      t.check(hcall.downs === 0 && !/살리/.test(hcall.hint), '살린 뒤 표식과 안내가 사라진다', hcall);
      await guest.bringToFront();
      for (const page of [host, guest]) { t.page = page; t.errorsOk(page === host ? '방장: 살리기' : '손님: 살리기'); }
      t.page = host;

      t.setSection('살리지 않으면 다음 스테이지에 절반 체력으로 일어난다');
      await host.eval(FREEZE);
      await ensureZombies(host, 1);
      await host.eval(`(() => { const P = ${PL(gid)}; P.hp = 1; P.invulnUntil = 0; P.hitUntil = 0; P.shield = 0; return true; })()`);
      const kz2 = await host.fn(zombieBeside, { id: gid, dist: 1.0, attack: true });
      await host.waitFor(`!${PL(gid)}.alive`, 6000, { label: '손님 다시 쓰러짐' });
      await host.fn(parkZombie, kz2);
      await guest.waitFor(`!__qa.world.localAlive`, 8000, { label: '손님 화면 쓰러짐' });
      t.check(await host.eval(`${DIRECTOR}.phase === 'wave'`), '한 사람만 쓰러지면 경기는 이어진다');
      const st0 = await host.eval(`({ stage: ${DIRECTOR}.stage, max: ${PL(gid)}.maxHp })`);
      await host.eval(KILL_ALL);
      await host.waitFor(`${DIRECTOR}.stage === ${st0.stage + 1}`, 10000, { label: '다음 스테이지' });
      await guest.waitFor(`__qa.world.localAlive && __qa.text('.sk-hz-stage-n') === '${st0.stage + 1}'`, 15000, { label: '손님이 다음 스테이지에 일어남' }).then(
        () => t.check(true, '쓰러졌던 손님이 다음 스테이지에 일어난다'),
        (err) => t.check(false, '쓰러졌던 손님이 다음 스테이지에 일어난다', err.message));
      const ghp = await guest.eval('__qa.ctx.player.state.hp');
      // 앞에서 무작위로 받은 증강에 '재생'이 섞이면 일어난 뒤 확인하기까지 체력이 조금 오른다(초당 회복 × 3초까지 봐준다)
      const half = Math.max(1, Math.round(st0.max * HORDE.reviveHpFrac));
      const regen = Number(await host.eval(`${PL(gid)}.perks.regen || 0`)) || 0;
      t.check(ghp >= half && ghp <= half + Math.ceil(regen * 3), '다음 스테이지에 일어난 사람의 체력은 절반', { hp: ghp, max: st0.max, regen });
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
