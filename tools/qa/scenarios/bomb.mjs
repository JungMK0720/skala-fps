/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 시나리오 19. 연습장 폭파 미션을 봇과 돈다. 내가 E로 설치 → 35초 뒤 폭발(공격 승), 설치 뒤 수비 봇의 해체(수비 승), 공수 교대, 결과 화면까지 보고 HUD를 찍는다.
 *          사용법: npm run qa:hidden -- --only bomb
 */
import { LOW_QUALITY, openGame, qaInit, richProfile, sleep, waitLive, waitRun, waitTicks } from '../kit.mjs';

const TIMESCALE = 4;

/** 페이지에서: 폭탄 상태와 HUD 값 요약 */
function bombState() {
  const run = window.__qa.run;
  const bv = window.__qa.world.internals.bombView;
  const hud = bv.hud();
  const v = run.match.state;
  return {
    phase: run.phase, round: run.round, score: run.score, bomb: run.bomb, attack: v.attack,
    view: v.bomb, side: hud && hud.side, goal: hud && hud.goal, status: hud && hud.status, prompt: hud && hud.prompt,
    timer: hud && hud.timer, progress: hud && hud.progress, carrying: hud && hud.carrying,
    markers: hud ? hud.markers.filter((m) => m.on).map((m) => m.id) : [],
    alive: window.__qa.world.localAlive, pos: window.__qa.ctx.player.state.pos.slice(),
    pending: window.__qa.world.bombPending
  };
}
/** 페이지에서: 구역 하나의 바닥 중심과 크기 */
function siteOf(id) {
  const m = window.__qa.run.info.mission;
  const s = m && m.sites.find((x) => x.id === id);
  return s ? { x: s.x, y: s.y, z: s.z, w: s.w, d: s.d } : null;
}
/** 페이지에서: 경기 기록 중 폭탄 이벤트·라운드 끝 */
function bombLog() {
  const log = window.__qa.match;
  return {
    bomb: log.filter((e) => e.type === 'bomb').map((e) => ({ act: e.act, id: e.id, site: e.site, reason: e.reason })),
    rounds: log.filter((e) => e.type === 'roundEnd').map((e) => ({ round: e.round, winner: e.winner, reason: e.reason, attack: e.attack })),
    rejects: log.filter((e) => e.type === 'reject').map((e) => e.reason),
    me: window.__qa.world.localId
  };
}

/** 나를 구역 가운데에 세우고 그 구역을 보게 한다 */
async function standIn(page, site) {
  await page.eval(`__qa.teleport(${site.x}, ${site.y + 0.2}, ${site.z}, 0)`);
  await waitTicks(page, 25);
  await page.waitFor('__qa.ctx.player.state.onGround && Math.hypot(__qa.ctx.player.state.vel[0], __qa.ctx.player.state.vel[2]) < 0.2', 5000, { label: '구역에 서기' });
}
/**
 * 폭탄이 보이는 dist m 근처 자리에 서서 폭탄을 본다(폭발을 보고도 살아남을 거리를 고를 때).
 * 둘레를 돌며 바닥이 폭탄과 비슷한 높이이고, 몸이 들어가고, 눈에서 폭탄이 보이는 곳을 찾는다
 */
async function viewBombFrom(page, dist) {
  const ok = await page.fn((d) => {
    const qa = window.__qa, P = qa.ctx.physics, w = qa.ctx.world;
    const b = qa.run.match.state.bomb;
    if (!b || !b.pos) return false;
    const by = b.pos[1] || 0;
    for (const r of [d, d + 1, d - 0.5, d + 2, d + 3]) {
      for (let k = 0; k < 24; k++) {
        const a = (k / 24) * Math.PI * 2;
        const x = b.pos[0] + Math.cos(a) * r, z = b.pos[2] + Math.sin(a) * r;
        const fy = P.findFloor(w, x, z);
        if (!Number.isFinite(fy) || Math.abs(fy - by) > 1.2) continue;
        if (P.overlapsCapsule(w, x, fy + 0.05, z, 0.4, 1.8)) continue;
        if (!P.lineOfSight(w, [x, fy + 1.6, z], [b.pos[0], by + 0.4, b.pos[2]])) continue;
        qa.teleport(x, fy + 0.1, z);
        return true;
      }
    }
    return false;
  }, dist);
  await waitTicks(page, 20);
  await page.eval(`(() => { const b = __qa.run.match.state.bomb; if (b && b.pos) __qa.aimAt([b.pos[0], (b.pos[1] || 0) + 0.4, b.pos[2]]); })()`);
  await waitTicks(page, 2);
  return ok;
}

/** 폭탄 쪽을 내려다본다(dist m 떨어져서) */
async function lookAtBomb(page, dist = 4) {
  await page.eval(`(() => {
    const b = __qa.run.match.state.bomb;
    if (!b || !b.pos) return false;
    const p = __qa.ctx.player.state.pos;
    const dx = p[0] - b.pos[0], dz = p[2] - b.pos[2], l = Math.hypot(dx, dz) || 1;
    __qa.teleport(b.pos[0] + dx / l * ${dist}, (b.pos[1] || 0) + 0.3, b.pos[2] + dz / l * ${dist});
    return true;
  })()`);
  await waitTicks(page, 20);
  await page.eval(`(() => { const b = __qa.run.match.state.bomb; if (b && b.pos) __qa.aimAt([b.pos[0], (b.pos[1] || 0) + 0.15, b.pos[2]]); })()`);
  await waitTicks(page, 2);
}

/** E를 누르고 있다가 설치가 끝나면 뗀다 */
async function plantHere(t, page) {
  const before = await page.fn(bombState);
  t.check(/설치/.test(before.prompt || ''), '구역 안에서 설치 안내가 보인다', before.prompt);
  await page.key('KeyE', 'down');
  await sleep(250);
  const mid = await page.fn(bombState);
  t.check(!!mid.progress && mid.progress.kind === 'plant' && mid.progress.ratio > 0, '설치 진행 막대가 찬다', mid.progress);
  await t.shot(`planting-r${mid.round}`);
  await page.waitFor('__qa.run.bomb.state === "planted"', 8000, { label: '설치 완료' }).catch((e) => t.check(false, '설치가 끝난다', e.message));
  await page.key('KeyE', 'up');
  return page.fn(bombState);
}

export default {
  name: 'bomb',
  title: '연습장 폭파 미션: 설치 → 폭발(공격 승), 봇 해체(수비 승), 공수 교대, 결과 화면, 새 폭파 맵 둘',
  timeoutMs: 22 * 60 * 1000,
  async run(t) {
    t.setSection('경기 시작');
    const q = `sandbox=relay&mode=bomb&bots=2&autoplay=1&timescale=${TIMESCALE}&bombcarrier=me&bombsite=A&difficulty=easy`;
    const page = await openGame(t, q, { profile: richProfile(), settings: LOW_QUALITY, width: 960, height: 540, screen: 'sandbox' });
    await waitRun(page);
    t.check((await page.eval('__qa.run.mode')) === 'bomb', '연습장이 폭파 미션으로 열린다', await page.eval('__qa.run.mode'));
    t.check(!!(await page.fn(siteOf, 'A')) && !!(await page.fn(siteOf, 'B')), '맵에 A·B 구역이 있다');
    await page.eval('__qa.freezeBots()');   // 1라운드는 모든 봇이 서 있는다(아군 봇이 수비를 전멸시키면 폭발까지 못 본다)
    await waitLive(page);
    let s = await page.fn(bombState);
    t.check(s.attack === 'owner' && s.side === 'attack', '1라운드: 블루(나) 공격', s);
    t.check(s.bomb.carrier === (await page.eval('__qa.world.localId')) && s.carrying, '폭탄은 내가 든다(bombcarrier=me)', s.bomb);
    t.check(/A 또는 B/.test(s.goal || ''), '목표 문장이 보인다', s.goal);
    t.check(s.markers.includes('A') && s.markers.includes('B'), 'A·B 구역 표시가 있다', s.markers);
    await t.shot('round1-start');
    // 점수판: 팀 머리글에 공격·수비, 폭탄을 든 아군 줄에 💣
    await page.key('Tab', 'down');
    const sbOpen = await page.waitFor('__qa.ui.isVisible("scoreboard")', 3000, { label: '점수판' }).then(() => true, () => false);
    if (sbOpen) {
      const sb = await page.eval(`(() => { const el = document.querySelector('.sk-scoreboard') || document.querySelector('[class*="sk-sb"]'); return el ? el.textContent : ''; })()`);
      t.check(/공격/.test(sb) && /수비/.test(sb), '점수판에 공격·수비가 보인다', sb.slice(0, 200));
      t.check(/💣/.test(sb), '점수판에 폭탄을 든 사람이 보인다(공격 팀 화면)', sb.slice(0, 200));
      await t.shot('scoreboard');
    } else t.check(false, '점수판이 열린다');
    await page.key('Tab', 'up');

    t.setSection('1라운드: 내가 A에 설치 → 폭발');
    const siteA = await page.fn(siteOf, 'A');
    await standIn(page, siteA);
    s = await plantHere(t, page);
    t.check(s.view.state === 'planted' && s.view.site === 'A', 'A 구역에 설치됨', s.view);
    // HUD 타이머는 화면 시간(시간 배율로 나눈 값)이고 경기가 센 남은 시간과 같아야 한다(바쁜 기계에서도 같은 순간을 잰다)
    const fuse = s.view.explodeInMs / 1000 / TIMESCALE;
    t.check(s.timer > 0 && s.timer <= 35 / TIMESCALE && Math.abs(s.timer - fuse) < 0.6, `폭발까지 남은 시간이 보인다(HUD ${s.timer} · 경기 ${fuse})`);
    t.check(/A 구역/.test(s.status || ''), '설치된 구역이 상태 줄에 보인다', s.status);
    await lookAtBomb(page, 3);
    await t.shot('planted-bomb');
    // 물러나서 폭발을 본다(12 m: 큰 피해지만 살아남는 거리)
    const viewOk = await viewBombFrom(page, 12);
    if (!viewOk) t.note('폭탄이 보이는 12 m 자리를 못 찾아 폭탄 옆에서 본다');
    await page.waitFor('__qa.run.bomb.state === "exploded"', 40000 / TIMESCALE * 1.6 + 8000, { label: '폭발' }).catch((e) => t.check(false, '35초 뒤 터진다', e.message));
    await sleep(120);
    await t.shot('explosion');
    // 폭발 피해는 경기 기록으로 본다(다음 라운드가 시작되면 체력이 다시 차므로 화면 값은 늦게 읽으면 틀린다)
    const blast = await page.eval('__qa.match.filter((e) => e.type === "damage" && e.weaponId === "bomb" && e.victim === __qa.world.localId).map((e) => ({ amount: e.amount, hp: e.hp }))');
    if (viewOk) t.check(blast.length === 1 && blast[0].amount > 0 && blast[0].hp > 0, '12 m에서는 큰 피해를 받고 살아남는다', blast);
    await page.waitFor('__qa.match.some((e) => e.type === "roundEnd" && e.round === 1)', 5000, { label: '1라운드 끝' });
    let log = await page.fn(bombLog);
    t.check(log.rounds[0] && log.rounds[0].winner === 'owner' && log.rounds[0].reason === 'bomb', '1라운드: 폭탄 폭파로 공격 승', log.rounds);
    t.check(log.bomb.some((e) => e.act === 'plant' && e.id === log.me && e.site === 'A'), '설치 이벤트는 나', log.bomb);
    await sleep(300);
    await t.shot('round1-end');

    t.setSection('2라운드: 내가 B에 설치 → 수비 봇이 해체');
    await page.waitFor('__qa.run.round === 2 && __qa.run.phase === "live"', 30000, { label: '2라운드 live' });
    s = await page.fn(bombState);
    t.check(s.attack === 'owner', '2라운드도 블루 공격', s.attack);
    const siteB = await page.fn(siteOf, 'B');
    await standIn(page, siteB);
    await plantHere(t, page);
    // 나는 공격 진영으로 물러나고, 수비 봇을 풀어 준다
    await page.eval(`(() => { const sp = __qa.run.info.mission.attack[0]; __qa.teleport(sp.x, (sp.y || 0) + 0.2, sp.z, sp.rotY); return true; })()`);
    await page.eval('__qa.unfreezeBots("charterer")');
    await page.waitFor('!!(__qa.run.bomb && __qa.run.bomb.actor)', 30000, { label: '수비 봇 해체 시작' }).catch((e) => t.check(false, '수비 봇이 폭탄으로 가서 해체를 시작한다', e.message));
    await t.shot('defusing');
    await page.waitFor('__qa.match.some((e) => e.type === "roundEnd" && e.round === 2)', 40000, { label: '2라운드 끝' }).catch((e) => t.check(false, '2라운드가 끝난다', e.message));
    log = await page.fn(bombLog);
    const r2 = log.rounds.find((r) => r.round === 2);
    t.check(r2 && r2.winner === 'charterer' && r2.reason === 'defuse', '2라운드: 폭탄 해체로 수비 승', log.rounds);
    t.check(log.bomb.some((e) => e.act === 'defuse'), '해체 이벤트가 있다', log.bomb);

    t.setSection('3라운드: 공수 교대 → 끝까지');
    await page.waitFor('__qa.run.round === 3 && __qa.run.phase === "live"', 30000, { label: '3라운드 live' });
    s = await page.fn(bombState);
    t.check(s.attack === 'charterer' && s.side === 'defense', '3라운드: 공수 교대로 블루(나)가 수비', s);
    t.check(!s.carrying && s.bomb.carrier && s.bomb.carrier.startsWith('bot-c'), '폭탄은 레드 봇이 든다', s.bomb);
    t.check(/지키/.test(s.goal || ''), '수비 목표 문장', s.goal);
    t.check(s.status === '', '수비는 누가 폭탄을 들었는지 모른다', s.status);
    await t.shot('round3-swap');
    await page.eval('__qa.unfreezeBots()');
    await page.waitFor('__qa.run.phase === "matchEnd"', 240000, { label: '경기 끝' }).catch((e) => t.check(false, '경기가 끝난다', e.message));
    log = await page.fn(bombLog);
    t.log(`   라운드: ${log.rounds.map((r) => `${r.round}R ${r.attack}공격 → ${r.winner}/${r.reason}`).join(' · ')}`);
    t.check(log.rounds.every((r) => ['bomb', 'defuse', 'elimination', 'time'].includes(r.reason)), '라운드 사유는 넷 중 하나', log.rounds);
    const bad = log.rejects.filter((r) => !['victim_dead', 'attacker_dead', 'not_live', 'friendly_fire', 'grenade_limit', 'busy', 'not_in_site', 'too_far'].includes(r));
    t.check(bad.length === 0, '예상하지 못한 판정 거절이 없다', bad);

    t.setSection('결과 화면');
    await page.waitFor('__qa.visible(".sk-results")', 15000, { label: '결과 화면' }).catch((e) => t.check(false, '결과 화면이 뜬다', e.message));
    const view = await page.eval(`(() => { const el = document.querySelector('.sk-results'); return el ? { mode: el.dataset.mode, winner: el.dataset.winner, rounds: el.querySelectorAll('.sk-res-round').length, text: el.textContent.slice(0, 400) } : null; })()`);
    t.check(view && view.mode === 'bomb', '결과 화면이 폭파 미션 모양이다', view);
    t.check(view && view.rounds === log.rounds.length, '라운드 칩 수 = 끝난 라운드 수', { view, rounds: log.rounds.length });
    t.check(view && /폭탄 폭파|폭탄 해체/.test(view.text), '라운드 사유가 결과에 보인다', view && view.text);
    // 쉬움 난이도(difficulty=easy)는 보상을 ×0.7로 줄이므로 난이도 줄이 음수다. "+-4"처럼 부호를 겹쳐 찍지 않는다
    const lines = await page.eval(`[...document.querySelectorAll('.sk-res-line')].map((l) => [...l.children].map((c) => c.textContent))`);
    const easy = lines.find(([label]) => /난이도 쉬움/.test(label));
    t.check(!!easy && /^-\d/.test(easy[1]), '쉬움 난이도 줄은 깎인 값(-)으로 보인다', lines);
    t.check(lines.length > 0 && lines.every(([, v]) => /^[+-]\d/.test(v) && !/^\+-/.test(v)), '포인트 줄에 +-처럼 부호가 겹치지 않는다', lines);
    await t.shot('results');
    t.errorsOk('폭파 미션 경기');

    // 새 폭파 맵: 봇 셋씩 시간 배율 8로 끝까지 돌린다. 폭탄은 봇이 든다(나는 스폰에 서 있는다).
    // 봇이 구역까지 걸어가 설치하는지, 라운드가 정해진 사유로 끝나는지, 판정 거절과 페이지 오류가 없는지 본다
    for (const mapId of ['railyard', 'observatory']) {
      t.setSection(`${mapId}: 봇끼리 끝까지`);
      const p2 = await openGame(t, `sandbox=${mapId}&mode=bomb&bots=3&autoplay=1&timescale=8&bombcarrier=bot`, { profile: richProfile(), settings: LOW_QUALITY, width: 960, height: 540, screen: 'sandbox' });
      await waitRun(p2);
      t.check((await p2.eval('__qa.run.mode')) === 'bomb' && (await p2.eval('__qa.run.opts.mapId')) === mapId, `${mapId}: 폭파 미션으로 열린다`);
      t.check(!!(await p2.fn(siteOf, 'A')) && !!(await p2.fn(siteOf, 'B')), `${mapId}: A·B 구역이 있다`);
      await p2.waitFor('__qa.run.phase === "matchEnd"', 420000, { label: `${mapId} 경기 끝` }).catch((e) => t.check(false, `${mapId}: 경기가 끝난다`, e.message));
      const lg = await p2.fn(bombLog);
      t.log(`   ${mapId} 라운드: ${lg.rounds.map((r) => `${r.round}R ${r.attack}공격 → ${r.winner}/${r.reason}`).join(' · ')}`);
      t.check(lg.rounds.length >= 3 && lg.rounds.every((r) => ['bomb', 'defuse', 'elimination', 'time'].includes(r.reason)), `${mapId}: 세 라운드 이상, 사유는 넷 중 하나`, lg.rounds);
      t.check(lg.bomb.some((e) => e.act === 'plant'), `${mapId}: 봇이 구역까지 가서 폭탄을 설치한다`, lg.bomb.map((e) => `${e.act}@${e.site || ''}`));
      const badR = lg.rejects.filter((r) => !['victim_dead', 'attacker_dead', 'not_live', 'friendly_fire', 'grenade_limit', 'busy', 'not_in_site', 'too_far'].includes(r));
      t.check(badR.length === 0, `${mapId}: 예상하지 못한 판정 거절이 없다`, badR);
      await sleep(300);
      await t.shot(`${mapId}-end`);
      t.errorsOk(`${mapId} 폭파 미션`);
    }

    t.setSection('휴대폰: 설치 버튼');
    // 터치 조작: 설치/해체 버튼은 구역 안(폭탄을 들었을 때)에서만 나타나고, 누르고 있으면 설치한다
    const W = 844, H = 390;
    const mob = await t.newPage();
    await mob.open(`${t.base}?debug=1&sandbox=relay&mode=bomb&bots=1&timescale=${TIMESCALE}&bombcarrier=me&bombsite=A&difficulty=easy`,
      { width: W, height: H, mobile: true, clean: true, initScript: qaInit({ profile: richProfile(), settings: LOW_QUALITY }) });
    await mob.waitFor('window.__qa && __qa.ctx && __qa.world && __qa.ctx.screen === "sandbox"', 60000, { label: '휴대폰 게임 부팅' });
    await mob.eval('__qa.watch()');
    await waitRun(mob);
    await mob.eval('__qa.freezeBots()');
    await waitLive(mob);
    await mob.waitFor('!__qa.ui.isVisible("loadout")', 8000, { label: '무기 선택 닫힘' }).catch(() => {});
    if (!(await mob.eval('__qa.ctx.input.locked'))) {
      await mob.touch('touchStart', [{ id: 1, x: W / 2, y: H / 2 }]);
      await sleep(60);
      await mob.touch('touchEnd', []);
    }
    await mob.waitFor('__qa.ctx.input.locked && __qa.ctx.input.enabled', 5000, { label: '휴대폰 조작 시작' });
    const useVisible = `(() => { const e = document.querySelector('.pc-tb--use'); if (!e) return false; const r = e.getBoundingClientRect(); const c = getComputedStyle(e); return !e.hidden && r.width > 0 && r.height > 0 && c.display !== 'none' && c.visibility !== 'hidden'; })()`;
    t.check(!(await mob.eval(useVisible)), '구역 밖에서는 설치 버튼이 없다');
    const siteM = await mob.fn(siteOf, 'A');
    await mob.eval(`__qa.teleport(${siteM.x}, ${siteM.y + 0.2}, ${siteM.z}, 0)`);
    await waitTicks(mob, 25);
    await mob.waitFor(useVisible, 4000, { label: '설치 버튼 나타남' }).catch((e) => t.check(false, '구역 안에서 설치 버튼이 나타난다', e.message));
    t.check(/설치/.test(await mob.eval(`(document.querySelector('.pc-tb--use') || {}).textContent || ''`)), '버튼 글자는 설치');
    t.page = mob;
    await t.shot('mobile-use-button');
    const at = await mob.eval(`(() => { const r = document.querySelector('.pc-tb--use').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await mob.touch('touchStart', [{ id: 1, x: at.x, y: at.y }]);
    await sleep(250);
    const mp = await mob.fn(bombState);
    t.check(!!mp.progress && mp.progress.kind === 'plant', '버튼을 누르고 있으면 설치 진행 막대', mp.progress);
    await t.shot('mobile-planting');
    await mob.waitFor('__qa.run.bomb.state === "planted"', 8000, { label: '휴대폰 설치 완료' }).catch((e) => t.check(false, '버튼을 누르고 있으면 설치된다', e.message));
    await mob.touch('touchEnd', []);
    await waitTicks(mob, 5);
    t.check(!(await mob.eval(useVisible)), '설치하고 나면 버튼이 사라진다(공격 팀)');
    await t.shot('mobile-planted');
    t.errorsOk('휴대폰 폭파 미션');
  }
};

