/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 시나리오 25. 좀비 물량 막기(혼자). 메뉴의 초록 바로가기, 연습장 설정 시트의 모드와 좀비 전용 맵, 준비 → 1스테이지 →
 *          좀비가 좀비 문에서 나와 다가오는지, 내 사격이 좀비를 맞혀 방장 시뮬레이션에 피해가 들어가는지, N 무기 교체(모든 무기·한 번 쓴
 *          총은 남은 탄 그대로), 바닥 보급품(탄창·구급 상자) 줍기, 스테이지를 깨면 카드 3장·다시 뽑기·고른 카드 효과,
 *          3스테이지 보스 체력 막대와 스킬 예고, 전멸 뒤 결과 화면과 계정 기록을 본다.
 */
import { LOW_QUALITY, lockPointer, openGame, richProfile, sleep, waitRun, waitTicks, clickFire } from '../kit.mjs';
import { WEAPONS } from '../../../js/weapons/defs.js';
import { hordeAmmo } from '../../../js/game/horde/rules.js';

/** 방장 시뮬레이션의 살아 있는 좀비를 모두 쓰러뜨린다(시험용: 스테이지를 빨리 깬다) */
const KILL_ALL = `(() => {
  const d = __qa.run.director, me = __qa.world.localId;
  let n = 0, shot = 900000;
  for (const Z of d.internals.zombies.values()) {
    let g = 0;
    while (Z.state !== 'dead' && g++ < 300) d.claimHit({ attackerId: me, victimId: 'z' + Z.id, weaponId: 'sr_heavy', part: 'body', dist: 5, kind: 'shot', count: 1, shotId: ++shot });
    n++;
  }
  d.internals.S.queue.length = 0;
  return n;
})()`;

const HUD = `({
  hz: __qa.visible('.sk-hz-top'), line: __qa.text('.sk-hz-line'), stage: __qa.text('.sk-hz-stage-n'),
  bosses: [...document.querySelectorAll('.sk-hz-boss')].filter((e) => !e.hidden).map((e) => e.textContent),
  phase: __qa.run && __qa.run.phase, count: __qa.world.horde.count, alive: __qa.world.localAlive,
  hp: __qa.ctx.player.state.hp, cards: __qa.ui.isVisible('cards'), top: __qa.visible('.sk-top')
})`;

export default {
  name: 'zombie',
  title: '좀비 물량 막기(혼자): 스테이지 · 카드 · 보스 · 결과',
  timeoutMs: 8 * 60 * 1000,
  async run(t) {
    t.setSection('메뉴의 좀비 물량 막기 바로가기');
    let page = await openGame(t, '', { profile: richProfile(), settings: LOW_QUALITY, width: 960, height: 540, screen: 'menu' });
    await page.clickText('.sk-menu-btn', '좀비 물량 막기');
    await page.waitFor('!!document.querySelector(".sk-sheet .sk-sheet-foot")', 5000, { label: '바로가기 시트' });
    const quick = await page.eval(`({ on: (document.querySelector('.sk-sheet [aria-label="모드"] .sk-seg-btn.is-on') || {}).textContent || '',
      hint: [...document.querySelectorAll('.sk-sheet .sk-field-hint')].map((e) => e.textContent).join(' | ') })`);
    t.check(/좀비 물량 막기/.test(quick.on) && /예비 탄 3배/.test(quick.hint), '메뉴 버튼은 좀비 모드를 고른 연습장 시트를 연다', quick);
    const green = await page.eval(`(() => { const b = [...document.querySelectorAll('.sk-menu-btn')].find((x) => /좀비 물량 막기/.test(x.textContent)); const cs = getComputedStyle(b); return { bg: cs.backgroundImage, cls: b.className }; })()`);
    const rgb = (green.bg.match(/rgb\((\d+), (\d+), (\d+)\)/) || []).slice(1).map(Number);
    t.check(/sk-menu-btn--zombie/.test(green.cls) && rgb.length === 3 && rgb[1] > rgb[0] && rgb[1] > rgb[2], '메인 메뉴의 좀비 물량 막기 버튼은 초록색이다', green);
    const quickMaps = await page.eval(`[...document.querySelectorAll('.sk-sheet .sk-mapcard-name')].map((e) => e.textContent)`);
    t.check(quickMaps.join() === '고속도로 휴게소,지하철 환승역', '좀비 모드는 좀비 전용 맵 둘만 고른다', quickMaps);
    await t.shot('menu-quick');
    await page.clickText('.sk-sheet-foot .sk-btn', '취소');
    await page.waitFor('!document.querySelector(".sk-sheet .sk-sheet-foot")', 3000, { label: '시트 닫힘' });

    t.setSection('연습장 설정 시트');
    await page.clickText('.sk-menu-btn', '연습장');
    await page.waitFor('!!document.querySelector(".sk-sheet .sk-sheet-foot")', 5000, { label: '연습장 설정 시트' });
    const modes = await page.eval(`[...document.querySelectorAll('.sk-sheet [aria-label="모드"] .sk-seg-btn')].map((b) => b.textContent)`);
    t.check(modes.some((m) => /좀비 물량 막기/.test(m)), '모드에 좀비 물량 막기가 있다', modes);
    const teamMaps = await page.eval(`[...document.querySelectorAll('.sk-sheet .sk-mapcard-name')].map((e) => e.textContent)`);
    t.check(!teamMaps.some((m) => /고속도로 휴게소|지하철 환승역/.test(m)), '다른 모드의 맵 목록에는 좀비 전용 맵이 없다', teamMaps);
    await page.clickText('.sk-sheet [aria-label="모드"] .sk-seg-btn', '좀비 물량 막기');
    await sleep(150);
    const sheet = await page.eval(`({ hint: [...document.querySelectorAll('.sk-sheet .sk-field-hint')].map((e) => e.textContent).join(' | '),
      rules: [...document.querySelectorAll('.sk-sheet [aria-label="규칙"] .sk-seg-btn')].map((b) => b.textContent),
      botsHidden: [...document.querySelectorAll('.sk-sheet .sk-field')].filter((f) => /인원|난이도/.test(f.textContent)).every((f) => f.hidden) })`);
    t.check(/예비 탄 3배/.test(sheet.hint) && /최대 4명/.test(sheet.hint), '좀비 모드 안내(탄 3배·멀티 4명)', sheet.hint);
    t.check(sheet.rules.length === 1 && /클래식/.test(sheet.rules[0]), '규칙은 클래식 하나', sheet.rules);
    t.check(sheet.botsHidden, '봇 인원·난이도 칸은 숨는다', sheet);
    await t.shot('setup');
    await page.clickText('.sk-sheet-foot .sk-btn', '출격');
    await waitRun(page);
    t.check(await page.eval(`__qa.run.mode === 'zombie'`), '출격하면 좀비 모드로 시작한다');
    t.errorsOk('설정 시트에서 출격');

    t.setSection('준비 → 1스테이지');
    page = await openGame(t, 'sandbox=restarea&mode=zombie&prep=1.5', { profile: richProfile(), settings: LOW_QUALITY, width: 960, height: 540, screen: 'sandbox' });
    await waitRun(page);
    await page.waitFor(`__qa.run.phase === 'prep' || __qa.run.phase === 'wave'`, 10000, { label: '준비 단계' });
    let s = await page.eval(HUD);
    t.check(s.hz && !s.top, '좀비 HUD 띠가 뜨고 팀 점수 줄은 숨는다', s);
    t.check(s.alive, '내가 블루 진영 스폰에 나온다', s);
    const ammo = await page.eval(`__qa.arsenal.getAmmo(__qa.arsenal.getLoadout().primary)`);
    const want = hordeAmmo(WEAPONS[ammo.weaponId]);
    t.check(want && ammo.reserve === want.reserve, `예비 탄이 기존 맵의 3배(${ammo.weaponId} ${want && want.reserve})`, ammo);
    await page.waitFor(`__qa.run.phase === 'wave'`, 10000, { label: '1스테이지' });
    await page.waitFor(`__qa.world.horde.count >= 3`, 20000, { label: '좀비가 그려진다' });
    s = await page.eval(HUD);
    t.check(s.stage === '1' && /남은 좀비 \d+/.test(s.line), 'HUD: 스테이지 1 · 남은 좀비', s);
    const gateCheck = await page.eval(`(() => { const d = __qa.run.director; const g = d.internals.gates; return { gates: g.length, map: __qa.run.opts.mapId }; })()`);
    t.check(gateCheck.gates === 6 && gateCheck.map === 'restarea', '좀비 전용 맵의 좀비 문 여섯 곳을 쓴다', gateCheck);
    await lockPointer(page);
    // 가장 가까운 좀비를 보며 기다린다(다가오는 모습)
    const dist0 = await page.eval(`(() => { const p = __qa.ctx.player.state.pos; return Math.min(...__qa.world.horde.rendered.map((z) => Math.hypot(z.x - p[0], z.z - p[2]))); })()`);
    await sleep(3500);
    const dist1 = await page.eval(`(() => { const p = __qa.ctx.player.state.pos; return Math.min(...__qa.world.horde.rendered.map((z) => Math.hypot(z.x - p[0], z.z - p[2]))); })()`);
    t.check(dist1 < dist0 - 1, '좀비가 나에게 다가온다', { dist0, dist1 });

    t.setSection('내 사격이 좀비를 맞힌다');
    // 벽 뒤 좀비를 겨누지 않게, 좀비 하나를 내 앞 7 m로 옮겨 세운다(시험용)
    await page.eval(`(() => {
      const s = __qa.ctx.player.state, d = __qa.run.director;
      const Z = [...d.internals.zombies.values()].find((q) => q.state !== 'dead');
      if (!Z) return false;
      const f = [-Math.sin(s.yaw), -Math.cos(s.yaw)];
      Z.body.pos[0] = s.pos[0] + f[0] * 7; Z.body.pos[1] = s.pos[1]; Z.body.pos[2] = s.pos[2] + f[1] * 7;
      Z.state = 'move'; Z.speed = 0; Z.attackReady = 1e12;
      __qa.ZID = Z.id;
      return true;
    })()`);
    await page.waitFor(`__qa.world.horde.rendered.some((z) => z.id === __qa.ZID && Math.hypot(z.x - __qa.ctx.player.state.pos[0], z.z - __qa.ctx.player.state.pos[2]) < 8)`, 5000, { label: '앞에 세운 좀비가 그려진다' });
    await waitTicks(page, 10);
    const aim = await page.eval(`(() => {
      const z = __qa.world.horde.rendered.find((q) => q.id === __qa.ZID);
      if (!z) return null;
      const pt = [z.x, z.y + 1.2 * z.s, z.z];
      const r = __qa.aimAt(pt);
      const eye = __qa.ctx.player.getEye();
      const d = [pt[0] - eye[0], pt[1] - eye[1], pt[2] - eye[2]];
      const hits = __qa.world.horde.ray([eye[0], eye[1], eye[2]], d, 200, 1);
      return { id: z.id, hits, world: r.kind, hp: (__qa.run.director.internals.zombies.get(z.id) || {}).hp };
    })()`);
    t.check(aim && aim.hits.length && aim.hits[0].id === 'z' + aim.id, '조준한 좀비가 판정에 잡힌다', aim);
    await page.eval('__qa.clearLogs()');
    await page.eval('window.__qaRng = () => 0');   // 탄퍼짐 0: 조준한 곳에 맞는다
    await clickFire(page, 4);
    await waitTicks(page, 8);
    const hit = await page.eval(`({ claims: __qa.worldEvents.filter((e) => e.evt === 'hitClaim' && String(e.victimId)[0] === 'z').length,
      hp: (__qa.run.director.internals.zombies.get(${aim ? aim.id : 0}) || { hp: 0 }).hp })`);
    t.check(hit.claims >= 1, '좀비 히트 주장이 나간다', hit);
    t.check(!aim || hit.hp < aim.hp, '방장 시뮬레이션의 좀비 체력이 준다', { before: aim && aim.hp, after: hit.hp });
    await t.shot('wave1');

    t.setSection('N 무기 교체: 모든 무기 · 한 번 쓴 총은 남은 탄 그대로');
    // 이 구간 동안 다른 좀비가 끼어들지 않게 멈추고 새 좀비를 막는다(시험용. 다음 구간의 KILL_ALL이 스테이지를 끝낸다)
    await page.eval(`(() => { const d = __qa.run.director; for (const Z of d.internals.zombies.values()) { Z.speed = 0; Z.attackReady = 1e12; } d.internals.S.spawnAt = Infinity; return true; })()`);
    const rx4 = await page.eval(`(() => { const a = __qa.arsenal.getAmmo('ar_std'); return { mag: a.mag, reserve: a.reserve, primary: __qa.arsenal.getLoadout().primary }; })()`);
    await page.press('KeyN');
    await page.waitFor(`__qa.ui.isVisible('loadout')`, 3000, { label: '무기 목록' });
    const list = await page.eval(`({ cards: [...document.querySelectorAll('.sk-loadout .sk-lo-card .sk-lo-name')].map((e) => e.textContent),
      extras: [...document.querySelectorAll('.sk-loadout .sk-lo-extra')].filter((e) => !e.hidden).map((e) => e.querySelectorAll('.sk-choice').length),
      title: __qa.text('.sk-lo-title'), count: !document.querySelector('.sk-lo-count').hidden })`);
    t.check(list.cards.length === 11, '주무기 11자루가 모두 나온다(가진 것과 상관없이)', list.cards);
    t.check(list.extras.length === 2 && list.extras[0] === 2 && list.extras[1] === 4, '보조 2·근접 4 빠른 교체 줄도 모두', list.extras);
    t.check(/좀비 물량 막기/.test(list.title) && !list.count, '좀비 모드 교체 창은 시간 제한이 없다', list);
    await t.shot('swap-list');
    await page.clickText('.sk-loadout .sk-lo-card .sk-lo-name', WEAPONS.ar_rapid.name);
    await page.waitFor(`!__qa.ui.isVisible('loadout') && __qa.arsenal.getLoadout().primary === 'ar_rapid'`, 3000, { label: 'RX-9로 바뀜' });
    const rx9 = await page.eval(`__qa.arsenal.getAmmo('ar_rapid')`);
    t.check(rx9.mag === WEAPONS.ar_rapid.mag && rx9.reserve === hordeAmmo(WEAPONS.ar_rapid).reserve, '처음 드는 총은 탄을 가득 받는다(예비 3배)', rx9);
    await page.press('KeyN');
    await page.waitFor(`__qa.ui.isVisible('loadout')`, 3000, { label: '무기 목록 다시' });
    await page.clickText('.sk-loadout .sk-lo-card .sk-lo-name', WEAPONS.ar_std.name);
    await page.waitFor(`!__qa.ui.isVisible('loadout') && __qa.arsenal.getLoadout().primary === 'ar_std'`, 3000, { label: 'RX-4로 돌아옴' });
    const back = await page.eval(`__qa.arsenal.getAmmo('ar_std')`);
    t.check(back.mag === rx4.mag && back.reserve === rx4.reserve, '한 번 쓴 총으로 돌아오면 남은 탄 그대로(채워지지 않는다)', { before: rx4, after: back });
    t.check(rx4.mag < WEAPONS.ar_std.mag, '앞에서 쏜 만큼 줄어 있던 탄창이다', rx4);

    t.setSection('바닥 보급품: 탄창 · 구급 상자');
    // 예비 탄을 줄여 두고(시험용), 바로 옆에 탄창 하나, 4 m 앞에 수류탄 하나를 떨어뜨린다
    await page.eval(`__qa.arsenal.equipWith('ar_std', { mag: 10, reserve: 20 })`);
    await page.eval(`(() => {
      const d = __qa.run.director, S = d.internals.S, p = __qa.ctx.player.state.pos;
      const put = (kind, dx, dz) => { const id = S.nextLoot++; d.internals.loot.set(id, { id, kind, x: p[0] + dx, y: p[1], z: p[2] + dz, until: S.clock + 30000 }); return id; };
      __qa.LOOT_FAR = put('nade', 4, 0);
      __qa.LOOT_MAG = put('mag', 0.4, 0);
      __qa.run.flush();
      return true;
    })()`);
    await page.waitFor(`!__qa.run.director.internals.loot.has(__qa.LOOT_MAG)`, 5000, { label: '탄창 주움' });
    await waitTicks(page, 3);
    const mag = await page.eval(`({ ammo: __qa.arsenal.getAmmo('ar_std'), far: __qa.run.director.internals.loot.has(__qa.LOOT_FAR), drawn: __qa.world.horde.loot.map((L) => L.kind) })`);
    t.check(mag.ammo.reserve === 20 + WEAPONS.ar_std.mag, `닿은 탄창을 주워 든 총의 예비 탄이 탄창 하나(${WEAPONS.ar_std.mag}발)만큼 는다`, mag.ammo);
    t.check(mag.far && mag.drawn.includes('nade'), '닿지 않은 보급품은 그대로 바닥에 그려진다', mag);
    await t.shot('loot');
    // 칼을 든 채 주운 탄창은 주무기에 들어간다
    await page.eval(`(() => {
      __qa.arsenal.equipWith('ar_std', { mag: 10, reserve: 20 });
      __qa.arsenal.select(3);
      const d = __qa.run.director, S = d.internals.S, p = __qa.ctx.player.state.pos;
      const id = S.nextLoot++; d.internals.loot.set(id, { id, kind: 'mag', x: p[0] + 0.3, y: p[1], z: p[2] - 0.2, until: S.clock + 30000 });
      __qa.LOOT_MAG2 = id;
      __qa.run.flush();
      return true;
    })()`);
    await page.waitFor(`!__qa.run.director.internals.loot.has(__qa.LOOT_MAG2)`, 5000, { label: '칼을 든 채 탄창 주움' });
    await waitTicks(page, 3);
    const knifeMag = await page.eval(`({ held: __qa.arsenal.getAmmo().weaponId, melee: __qa.arsenal.getLoadout().melee, ammo: __qa.arsenal.getAmmo('ar_std') })`);
    t.check(knifeMag.held === knifeMag.melee && knifeMag.ammo.reserve === 20 + WEAPONS.ar_std.mag, '칼을 든 채 주운 탄창은 주무기의 예비 탄이 된다', knifeMag);
    await page.eval(`__qa.arsenal.select(1)`);
    await page.eval(`(() => {
      const d = __qa.run.director, S = d.internals.S, p = __qa.ctx.player.state.pos;
      d.internals.players.get(__qa.world.localId).hp = 40;
      const id = S.nextLoot++; d.internals.loot.set(id, { id, kind: 'med', x: p[0] - 0.3, y: p[1], z: p[2], until: S.clock + 30000 });
      __qa.LOOT_MED = id;
      __qa.run.flush();
      return true;
    })()`);
    await page.waitFor(`!__qa.run.director.internals.loot.has(__qa.LOOT_MED)`, 5000, { label: '구급 상자 주움' });
    await waitTicks(page, 4);
    const hp = await page.eval(`({ sim: __qa.run.director.internals.players.get(__qa.world.localId).hp, local: __qa.ctx.player.state.hp })`);
    t.check(hp.sim === 70 && hp.local === 70, '구급 상자는 체력을 30 채운다(방장 확정 → 내 화면)', hp);
    t.errorsOk('무기 교체와 보급품');

    t.setSection('스테이지 클리어 → 카드');
    const killed = await page.eval(KILL_ALL);
    t.check(killed >= 1, '남은 좀비를 쓰러뜨린다(시험용)', killed);
    await page.waitFor(`__qa.ui.isVisible('cards')`, 15000, { label: '카드 화면' });
    await waitTicks(page, 5);
    const offer = await page.eval(`({ cards: [...document.querySelectorAll('.sk-cd-card')].map((c) => c.querySelector('.sk-cd-name').textContent),
      reroll: __qa.text('.sk-cd-reroll'), title: __qa.text('.sk-cd-title'), locked: __qa.ctx.input.locked })`);
    t.check(offer.cards.length === 3, '카드 3장이 뜬다', offer);
    t.check(/다시 뽑기 \(1\)/.test(offer.reroll), '다시 뽑기 1번', offer.reroll);
    t.check(/스테이지 1 클리어/.test(offer.title) && !offer.locked, '제목과 커서', offer);
    await t.shot('cards');
    await page.press('KeyR');
    await page.waitFor(`[...document.querySelectorAll('.sk-cd-card .sk-cd-name')].map((e) => e.textContent).join() !== ${JSON.stringify(offer.cards.join())}`, 5000, { label: '다시 뽑은 카드' });
    const re = await page.eval(`({ cards: [...document.querySelectorAll('.sk-cd-card .sk-cd-name')].map((e) => e.textContent), reroll: __qa.text('.sk-cd-reroll'), off: document.querySelector('.sk-cd-reroll').disabled })`);
    t.check(re.cards.length === 3 && re.cards.every((c) => !offer.cards.includes(c)), 'R로 다시 뽑으면 다른 카드 3장', re);
    t.check(re.off && /\(0\)/.test(re.reroll), '다시 뽑기는 한 번뿐', re);
    const before = await page.eval(`({ mods: __qa.arsenal.getMods(), perk: { ...__qa.world.internals.hordePerk } })`);
    await page.clickText('.sk-cd-card .sk-cd-name', re.cards[1]);
    await page.waitFor(`!__qa.ui.isVisible('cards')`, 5000, { label: '카드 닫힘' });
    await page.waitFor(`__qa.run.director.internals.players.get(__qa.world.localId).cards.length === 1`, 5000, { label: '카드 반영' });
    const after = await page.eval(`({ cards: __qa.run.director.internals.players.get(__qa.world.localId).cards, mods: __qa.arsenal.getMods(), perk: { ...__qa.world.internals.hordePerk }, locked: __qa.ctx.input.locked })`);
    t.check(after.cards.length === 1, '고른 카드가 내 카드가 된다', after);
    t.check(after.locked, '고른 클릭으로 포인터가 다시 잠긴다', after);
    t.note(`고른 카드 ${re.cards[1]} · 배율 ${JSON.stringify(before.mods)} → ${JSON.stringify(after.mods)} · 이동 ${before.perk.speed} → ${after.perk.speed}`);
    await page.waitFor(`__qa.run.phase === 'wave' && __qa.run.stage === 2`, 15000, { label: '2스테이지' });
    t.check(true, '쉬는 시간 뒤 2스테이지가 시작된다');
    t.errorsOk('1~2스테이지');

    t.setSection('3스테이지 보스');
    page = await openGame(t, 'sandbox=restarea&mode=zombie&prep=1&stage=3', { profile: richProfile(), settings: LOW_QUALITY, width: 960, height: 540, screen: 'sandbox' });
    await waitRun(page);
    await page.waitFor(`[...document.querySelectorAll('.sk-hz-boss')].some((e) => !e.hidden)`, 25000, { label: '보스 체력 막대' });
    s = await page.eval(HUD);
    t.check(s.bosses.length === 1 && /%/.test(s.bosses[0]), '보스 1마리의 이름과 체력', s);
    await lockPointer(page);
    // 보스 쪽을 본다
    await page.eval(`(() => { const b = __qa.world.horde.rendered.find((z) => z.boss); if (b) __qa.aimAt([b.x, b.y + 2, b.z]); })()`);
    await page.waitFor(`__qa.run.director.internals.zombies.size && [...__qa.run.director.internals.zombies.values()].some((Z) => Z.boss && Z.skill)`, 40000, { label: '보스 스킬' }).catch(() => {});
    await waitTicks(page, 20);
    await page.eval(`(() => { const b = __qa.world.horde.rendered.find((z) => z.boss); if (b) __qa.aimAt([b.x, b.y + 2, b.z]); })()`);
    await t.shot('boss');
    t.errorsOk('보스 스테이지');

    t.setSection('전멸 → 결과');
    const statsBefore = (await page.eval('__qa.profile()')).stats;
    const runsBefore = statsBefore.zombieRuns || 0;
    page = await openGame(t, 'sandbox=restarea&mode=zombie&prep=0.5&stage=25', { profile: richProfile(), settings: LOW_QUALITY, width: 960, height: 540, screen: 'sandbox', clean: false });
    await waitRun(page);
    await page.waitFor(`__qa.run.over`, 120000, { label: '전멸' });
    await page.waitFor(`__qa.ui.isVisible('results')`, 15000, { label: '결과 화면' });
    await waitTicks(page, 5);
    const res = await page.eval(`({ mode: document.querySelector('.sk-results').dataset.mode, title: __qa.text('.sk-res-title'), score: __qa.text('.sk-res-score'),
      gain: __qa.text('.sk-res-gain-num'), back: __qa.text('.sk-res-actions .sk-btn'), stats: __qa.profile().stats })`);
    t.check(res.mode === 'zombie' && /스테이지 25/.test(res.title), '결과: 도달한 스테이지', res);
    t.check(/생존/.test(res.score) && !/클리어/.test(res.score), '결과: 생존 시간(시험용 중간 시작이라 깬 스테이지는 0)', res.score);
    t.check((res.stats.zombieRuns || 0) === runsBefore + 1 && (res.stats.zombieBest || 0) >= 25, '계정에 좀비 기록이 남는다', res.stats);
    t.check((res.stats.kills | 0) === (statsBefore.kills | 0), '좀비 처치는 사람 킬 전적에 넣지 않는다', { before: statsBefore.kills, after: res.stats.kills });
    await t.shot('results');
    t.errorsOk('전멸과 결과');
  }
};

