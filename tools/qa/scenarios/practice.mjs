/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 시나리오 3. 규칙 × 맵 × 모드의 모든 조합을 봇 2명과 빠른 시간 배율로 결과 화면까지 돌린다. 봇이 실제로 싸우는지, 보상이 한 번만 기록되는지, 다시 하기와 메뉴 복귀가 되는지 본다.
 */
import { MAPS, MAP_IDS, mapsForRuleset } from '../../../js/maps/index.js';
import { RULESET_IDS, isWeaponAllowed } from '../../../js/game/modes.js';
import { LOW_QUALITY, NICK, openGame, sleep, waitRun } from '../kit.mjs';

const MATCH_TIMEOUT_MS = 240000;
/** 경기 전체를 한 번 더 돌려 다시 하기를 검사하는 조합 */
const RESTART_COMBOS = new Set(['classic/alley/ffa', 'knife/rooftop/team']);
/**
 * 봇 사격에서 생길 수 있는 정상적인 거절(부활 보호, 이미 죽은 상대, 라운드가 끝난 뒤 맞은 탄, 사이에 낀 아군).
 * grenade_limit: 시간 배율 8에서는 수류탄 신관만 실제 시간으로 흘러 경기 시간 20초 뒤에 터진다. 그 사이에 부활해 다시 던진 봇은 한 목숨에 두 번 터진 것으로 보인다.
 * 배율 1에서는 부활(3초)이 신관(2.5초)보다 길어 생기지 않는다.
 */
const EXPECTED_REJECTS = new Set(['protected', 'victim_dead', 'attacker_dead', 'not_live', 'friendly_fire', 'grenade_limit']);

export function allCombos() {
  const list = [];
  for (const rs of RULESET_IDS) {
    for (const m of mapsForRuleset(rs)) for (const mode of ['ffa', 'team']) list.push({ rs, mapId: m.id, mode, key: `${rs}/${m.id}/${mode}` });
  }
  return list;
}

/** 페이지에서: 경기 이벤트 요약 */
function matchSummary() {
  const log = window.__qa.match;
  const me = window.__qa.world.localId;
  const of = (type) => log.filter((e) => e.type === type);
  const damage = of('damage'), kills = of('kill'), rejects = of('reject'), rounds = of('roundEnd');
  const end = of('matchEnd').pop() || null;
  const bots = new Set(window.__qa.run.bots.map((b) => b.id));
  const reasons = {};
  for (const r of rejects) reasons[r.reason] = (reasons[r.reason] || 0) + 1;
  return {
    damage: damage.length,
    damageTotal: damage.reduce((sum, e) => sum + (e.amount || 0), 0),
    botDealt: damage.filter((e) => bots.has(e.attacker)).length,
    botTook: damage.filter((e) => bots.has(e.victim)).length,
    hitMe: damage.filter((e) => e.victim === me).length,
    kills: kills.length,
    botKills: kills.filter((e) => bots.has(e.killer) && e.killer !== e.victim).length,
    selfKills: kills.filter((e) => e.killer === e.victim).length,
    weapons: [...new Set([...damage, ...kills].map((e) => e.weaponId))],
    reasons,
    roundEnds: rounds.length,
    roundReasons: rounds.map((r) => r.reason),
    matchEnds: of('matchEnd').length,
    winner: end ? end.winner : undefined,
    endReason: end ? end.reason : undefined,
    score: window.__qa.run.score,
    ranking: window.__qa.run.ranking
  };
}

/** 페이지에서: 결과 화면 요약 */
function resultsView() {
  const el = document.querySelector('.sk-results');
  const q = (s) => { const n = el.querySelector(s); return n ? n.textContent : ''; };
  return {
    mode: el.dataset.mode, winner: el.dataset.winner, title: q('.sk-res-title'), kicker: q('.sk-res-kicker'), score: q('.sk-res-score'), verdict: q('.sk-res-verdict'),
    gain: q('.sk-res-gain-num'), total: q('.sk-res-total'), rewardHidden: el.querySelector('.sk-res-reward').hidden,
    rows: el.querySelectorAll('.sk-res-table tbody tr').length, rounds: el.querySelectorAll('.sk-res-round').length,
    back: el.querySelector('.sk-res-actions .sk-btn--primary').textContent, lobby: el.querySelector('.sk-res-actions .sk-btn--ghost').textContent
  };
}

async function checkMatch(t, page, combo, expectedMatches, pointsBefore) {
  const sum = await page.fn(matchSummary);
  const view = await page.fn(resultsView);
  const prof = await page.eval('__qa.profile()');
  const line = `${combo.key}: 킬 ${sum.kills}(봇 ${sum.botKills}, 자살 ${sum.selfKills}) 피해 ${sum.damage}건 ${sum.damageTotal} 나에게 ${sum.hitMe}건 결과 ${sum.winner || '무승부'}/${sum.endReason} 라운드 ${sum.roundEnds} 무기 ${sum.weapons.join(',')} 거절 ${JSON.stringify(sum.reasons)} 얻은 점수 ${prof.points - pointsBefore}`;
  t.log(`   ${line}`);

  t.check(sum.botDealt > 0, '봇이 피해를 입힌다', sum);
  t.check(sum.botTook > 0, '봇이 피해를 입는다', sum);
  t.check(sum.kills > 0, '킬이 나온다', sum);
  t.check(sum.botKills > 0, '봇이 킬을 낸다', sum);
  t.check(sum.matchEnds === 1, '경기는 한 번 끝난다', sum.matchEnds);
  for (const w of sum.weapons) t.check(isWeaponAllowed(combo.rs, w), `${combo.rs}에서 쓸 수 없는 무기로 피해가 났다: ${w}`);
  for (const [reason, n] of Object.entries(sum.reasons)) t.check(EXPECTED_REJECTS.has(reason), `예상하지 못한 판정 거절 ${reason} ${n}건`);

  t.check(prof.stats.matches === expectedMatches, '경기 기록은 경기당 한 번이다', prof.stats.matches);
  const gained = prof.points - pointsBefore;
  t.check(gained > 0, '보상 포인트가 들어온다', gained);
  t.check(!view.rewardHidden, '결과 화면에 획득 포인트가 보인다');
  await page.waitFor(`document.querySelector('.sk-res-gain-num').textContent === ${JSON.stringify(`+${gained.toLocaleString('ko-KR')}`)}`, 4000, { label: `획득 포인트 숫자 +${gained}` }).catch((err) => t.check(false, '획득 포인트 숫자가 실제 증가분과 같다', err.message));
  t.check(view.back === '다시 하기' && view.lobby === '메뉴로', '결과 화면 버튼 문구', view);
  t.check(!!view.title, '결과 화면 제목이 있다', view);

  if (combo.mode === 'team') {
    t.check(view.mode === 'team', '팀전 결과 화면', view);
    t.check(view.kicker === 'MATCH RESULT', '팀전 결과 머리말', view);
    t.check(['owner', 'charterer', 'draw'].includes(view.winner), '팀전은 승패가 정해진다', view);
    t.check(/블루 \d+ : \d+ 레드/.test(view.score), '팀전 점수 표시', view);
    t.check(view.rounds >= 1, '라운드 기록이 있다', view);
    t.check(view.rows === 4, '팀전 표에 4명이 있다', view);
    t.check(sum.roundEnds >= 1, '라운드가 끝난다', sum);
    const decisive = sum.roundReasons.filter((r) => r === 'elimination').length;
    if (!decisive) t.note(`${combo.key}: 전멸로 끝난 라운드가 없다 (${sum.roundReasons.join(',')})`);
    t.check(sum.endReason !== undefined, '경기 결과 이유가 있다', sum);
  } else {
    t.check(view.mode === 'ffa', '개인전 결과 화면', view);
    t.check(view.rows === 3, '개인전 표에 3명이 있다', view);
    t.check(['kills', 'time', 'draw'].includes(sum.endReason), '개인전 끝난 이유', sum.endReason);
    if (sum.endReason !== 'kills') t.note(`${combo.key}: 목표 킬 전에 시간이 끝났다 (킬 ${sum.kills})`);
  }
  return gained;
}

/** 봇이 맵에서 정상적으로 움직였는지 본다 */
async function checkBots(t, page, combo) {
  const stats = await page.eval('__qa.botStats');
  const rows = Object.entries(stats).map(([id, s]) => `${id}(${s.weapon}) 거리 ${s.dist.toFixed(0)} m 최대정지 ${s.stillMax.toFixed(0)} s 발판 ${s.flights} 박힘 ${s.solid}/${s.samples}`);
  t.log(`   ${rows.join(' | ')}`);
  for (const [id, s] of Object.entries(stats)) {
    t.check(s.minY > -6, `${id}: 맵 밖으로 떨어지지 않는다`, s.minY);
    t.check(s.solid <= Math.max(2, s.samples * 0.05), `${id}: 벽 안에 박혀 있지 않는다`, { solid: s.solid, samples: s.samples });
    if (!s.human && s.dist < 3) t.note(`${combo.key}: ${id}(${s.weapon})가 거의 움직이지 않았다(${s.dist.toFixed(1)} m)`);
  }
}

export default {
  name: 'practice',
  title: '규칙 × 맵 × 모드 전체 조합의 봇전을 결과 화면까지',
  timeoutMs: 75 * 60 * 1000,
  async run(t) {
    const wanted = (key) => !t.filter || key.includes(t.filter);
    const combos = allCombos().filter((c) => wanted(c.key));
    t.log(`조합 ${combos.length}개`);
    if (!t.filter) t.check(combos.length > 0, '돌릴 조합이 있다');
    const profile = { nickname: NICK, points: 500, createdAt: 1 };
    for (const combo of combos) {
      t.setSection(combo.key);
      const started = Date.now();
      const q = `sandbox=${combo.mapId}&ruleset=${combo.rs}&mode=${combo.mode}&bots=2&autoplay=1&timescale=8&killtarget=5`;
      const page = await openGame(t, q, { profile, settings: LOW_QUALITY, width: 320, height: 180, reusePage: true, screen: 'sandbox' });
      await waitRun(page);
      const opts = await page.eval(`(() => { const o = __qa.run.opts; return { mapId: o.mapId, mode: o.mode, ruleset: o.ruleset, world: __qa.world.ruleset, worldMode: __qa.world.mode, map: __qa.ctx.map.id, n: __qa.run.bots.length, ts: o.timeScale, target: o.killTarget }; })()`);
      t.check(opts.map === combo.mapId && opts.mapId === combo.mapId, '고른 맵이 열린다', opts);
      t.check(opts.ruleset === combo.rs && opts.world === combo.rs, '고른 규칙', opts);
      t.check(opts.mode === combo.mode && opts.worldMode === combo.mode, '고른 모드', opts);
      t.check(opts.n === (combo.mode === 'ffa' ? 2 : 3), '봇 수', opts);
      await page.eval('__qa.trackBots()');
      await page.waitFor('__qa.run && __qa.run.phase === "live"', 30000, { label: 'live 단계' });
      await page.waitFor('__qa.ui.isVisible("results")', MATCH_TIMEOUT_MS, { intervalMs: 500, label: '결과 화면' });
      let gained = await checkMatch(t, page, combo, 1, 500);
      await checkBots(t, page, combo);
      await sleep(400);
      t.check((await page.eval('__qa.profile().stats.matches')) === 1, '시간이 지나도 기록이 늘지 않는다');
      if (combos.indexOf(combo) % 6 === 0) await t.shot(`results-${combo.key.replace(/\//g, '-')}`);

      if (RESTART_COMBOS.has(combo.key)) {
        const points = await page.eval('__qa.profile().points');
        await page.eval('(window.__qaOldRun = __qa.run, 1)');
        await page.eval('__qa.clearLogs()');
        await page.click('.sk-res-actions .sk-btn--primary');
        await page.waitFor('__qa.run !== window.__qaOldRun && !__qa.ui.isVisible("results")', 5000, { label: '다시 하기: 새 경기' });
        await page.eval('__qa.hookRun()');
        t.check(await page.eval('__qa.ui.isVisible("hud")'), '다시 하기: HUD가 뜬다');
        await page.waitFor('__qa.run.phase === "live"', 30000, { label: '다시 하기: live 단계' });
        const alive = await page.eval('__qa.world.localAlive');
        t.check(alive, '다시 하기: 내가 살아 있다');
        await page.waitFor('__qa.ui.isVisible("results")', MATCH_TIMEOUT_MS, { intervalMs: 500, label: '다시 하기: 결과 화면' });
        gained = await checkMatch(t, page, combo, 2, points);
        t.log(`   다시 하기까지 ${gained} P`);
      }

      await page.click('.sk-res-actions .sk-btn--ghost');
      await page.waitFor('__qa.ctx.screen === "menu" && __qa.ui.isVisible("menu")', 10000, { label: '메뉴 복귀' });
      t.check(await page.eval('!__qa.ctx.map && !__qa.ctx.rendering && !__qa.ui.isVisible("hud") && !__qa.ui.isVisible("results") && !__qa.run'), '메뉴로 나오면 경기가 정리된다');
      const menuPoints = await page.eval(`document.querySelector('.sk-player .sk-points-val').textContent`);
      const points = await page.eval('__qa.profile().points');
      t.check(menuPoints === `${points.toLocaleString('ko-KR')} P`, '메뉴 포인트가 갱신된다', menuPoints);
      t.errorsOk(combo.key);
      t.log(`   ${((Date.now() - started) / 1000).toFixed(1)}초`);
    }

    // 사람이 실제로 하는 속도(시간 배율 1), 기본 품질, 봇 5명으로 한 판을 끝까지 돌린다
    if (wanted('realtime')) {
      t.setSection('realtime: 시간 배율 1, 봇 5명');
      const started = Date.now();
      const page = await openGame(t, 'sandbox=alley&ruleset=classic&mode=ffa&bots=5&killtarget=5&difficulty=hard&autoplay=1', { profile, width: 640, height: 360, reusePage: true, screen: 'sandbox' });
      await waitRun(page);
      await page.eval('__qa.trackBots()');
      await page.waitFor('__qa.run && __qa.run.phase === "live"', 30000, { label: 'live 단계' });
      const memory = () => page.eval('({ ...__qa.ctx.renderer.three.info.memory, programs: __qa.ctx.renderer.three.info.programs.length, heapMb: Math.round(performance.memory.usedJSHeapSize / 1048576) })');
      await sleep(3000);
      const memBefore = await memory();
      await page.waitFor('__qa.ui.isVisible("results")', MATCH_TIMEOUT_MS, { intervalMs: 500, label: '결과 화면' });
      const memAfter = await memory();
      t.log(`   메모리 ${JSON.stringify(memBefore)} → ${JSON.stringify(memAfter)}`);
      t.check(memAfter.geometries <= memBefore.geometries + 40 && memAfter.textures <= memBefore.textures + 10, '한 경기 동안 지오메트리와 텍스처가 쌓이지 않는다', { memBefore, memAfter });
      await checkBots(t, page, { key: 'realtime' });
      const sum = await page.fn(matchSummary);
      t.log(`   realtime: 킬 ${sum.kills} 피해 ${sum.damage}건 결과 ${sum.winner}/${sum.endReason} 무기 ${sum.weapons.join(',')} 거절 ${JSON.stringify(sum.reasons)} ${((Date.now() - started) / 1000).toFixed(1)}초, 품질 ${await page.eval('__qa.ctx.renderer.quality')}`);
      t.check(sum.kills >= 5 && sum.botDealt > 0 && sum.botTook > 0, '봇이 싸워 목표 킬에 닿는다', sum);
      t.check(sum.endReason === 'kills', '목표 킬로 끝난다', sum.endReason);
      for (const [reason, n] of Object.entries(sum.reasons)) t.check(reason !== 'grenade_limit' && EXPECTED_REJECTS.has(reason), `시간 배율 1에서 예상하지 못한 판정 거절 ${reason} ${n}건`);
      t.check((await page.eval('__qa.profile().stats.matches')) === 1, '경기 기록 1번');
      t.log(`   봇·경기 틱 비용: ${JSON.stringify(await page.eval('__qa.run.stats'))}`);
      await t.shot('realtime-results');
      t.errorsOk('realtime');
    }

    // 사람이 가장 많은 경우: 개인전 8명은 스폰이 겹칠 수 있고, 팀전 4:4는 팀 스폰을 모두 쓴다
    const crowded = [];
    for (const id of MAP_IDS) {
      const rs = (MAPS[id].rulesets || ['classic', 'sniper'])[0];
      crowded.push({ rs, mapId: id, mode: 'ffa', bots: 7, key: `crowd/${id}/ffa` });
    }
    for (const id of ['nexus', 'tankfarm']) crowded.push({ rs: 'classic', mapId: id, mode: 'team', bots: 4, key: `crowd/${id}/team` });
    for (const combo of crowded) {
      if (!wanted(combo.key)) continue;
      t.setSection(combo.key);
      const crowd = await openGame(t, `sandbox=${combo.mapId}&ruleset=${combo.rs}&mode=${combo.mode}&bots=${combo.bots}&autoplay=1&timescale=8&killtarget=5`, { profile, settings: LOW_QUALITY, width: 320, height: 180, reusePage: true, screen: 'sandbox' });
      await waitRun(crowd);
      t.check((await crowd.eval('__qa.run.bots.length')) === 7, '봇 7명', await crowd.eval('__qa.run.bots.length'));
      await crowd.eval('__qa.trackBots()');
      await crowd.waitFor('__qa.ui.isVisible("results")', MATCH_TIMEOUT_MS, { intervalMs: 500, label: '결과 화면' });
      await checkBots(t, crowd, combo);
      const crowdSum = await crowd.fn(matchSummary);
      t.log(`   ${combo.key}: 킬 ${crowdSum.kills} 피해 ${crowdSum.damage}건 결과 ${crowdSum.winner || '무승부'}/${crowdSum.endReason} 거절 ${JSON.stringify(crowdSum.reasons)}`);
      t.check(crowdSum.kills > 0, '킬이 나온다', crowdSum);
      t.errorsOk(combo.key);
    }
  }
};
