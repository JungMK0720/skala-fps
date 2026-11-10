/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 시나리오 19. 연속 킬. 봇 일곱을 한 줄로 세우고 라이플 머리 1발로 차례로 쓰러뜨려 더블 킬부터 '당신은 전설입니다'까지
 *          그림·글자, 효과음과 안내 음성(파일 디코드·재생 기록)을 확인한다. 5초가 지난 다음 킬은 1부터 다시 세는지, 휴대폰 배치도 본다.
 *          소리는 귀로 듣지 못한다(--mute-audio). 파일을 받아 디코드했는지와 어떤 문장을 냈는지만 본다.
 */
import { MULTI_KILL_TIERS, MULTI_KILL_WINDOW_MS } from '../../../js/game/multikill.js';
import { LOW_QUALITY, clickFire, lockPointer, openGame, qaInit, readyGame, richProfile, sleep, waitIdle, waitLive, waitRun, waitTicks } from '../kit.mjs';

const BOTS = 7;
const SPACING = 1.7;

/** 페이지에서: 서 있을 자리 a와, a에서 dist m 앞에 옆으로 n명이 나란히 설 자리. 모두 머리와 가슴이 보여야 한다 */
function lineUp({ n, spacing }) {
  const c = window.__qa.ctx, w = c.world, P = c.physics, size = c.map.data.size;
  const ground = (x, z) => {
    const y = P.getGroundY(w, x, z, Infinity, 0.4);
    if (!Number.isFinite(y) || y < -5 || y > 25) return null;
    if (!window.__qa.clearOfTriggers(x, z) || P.overlapsCapsule(w, x, y + 0.02, z, 0.4, 1.9)) return null;
    return y;
  };
  for (const dist of [16, 13, 20, 10]) {
    for (let x = -size.x / 2 + 4; x < size.x / 2 - 4; x += 3) {
      for (let z = -size.z / 2 + 4; z < size.z / 2 - 4; z += 3) {
        const ay = ground(x, z);
        if (ay == null) continue;
        const eye = [x, ay + 1.6, z];
        for (let k = 0; k < 8; k++) {
          const ang = (k * Math.PI) / 4, fx = Math.sin(ang), fz = Math.cos(ang);
          const spots = [];
          for (let i = 0; i < n; i++) {
            const off = (i - (n - 1) / 2) * spacing;
            const bx = x + fx * dist + fz * off, bz = z + fz * dist - fx * off;
            const by = ground(bx, bz);
            if (by == null || Math.abs(by - ay) > 1.2) break;
            if (!P.lineOfSight(w, eye, [bx, by + 1.62, bz]) || !P.lineOfSight(w, eye, [bx, by + 1.2, bz])) break;
            spots.push({ x: bx, y: by, z: bz });
          }
          if (spots.length === n) return { a: { x, y: ay, z }, spots, dist };
        }
      }
    }
  }
  return null;
}

/** 페이지에서: 나와 봇들을 세운다(only를 주면 그 번호의 봇만). 봇은 나를 본다 */
function stage({ a, spots, only = null }) {
  const qa = window.__qa;
  const c = spots[Math.floor(spots.length / 2)];
  qa.teleport(a.x, a.y, a.z, Math.atan2(-(c.x - a.x), -(c.z - a.z)));
  qa.ctx.player.state.onGround = true;
  spots.forEach((s, i) => { if (only == null || only === i) qa.placeBot(i, s.x, s.y, s.z, Math.atan2(-(a.x - s.x), -(a.z - s.z))); });
  return true;
}

const allReady = (ids) => `(() => { const ps = __qa.run.match.state.players; return ${JSON.stringify(ids)}.every((id) => { const b = __qa.run.bots.find((x) => x.id === id); const v = ps.find((p) => p.id === id); return b && b.alive && v && v.alive && !v.protect; }); })()`;
/**
 * 페이지에서: 도구를 심는다. __mkState() = 연속 킬 표시 요소의 상태, __mkFreeze(on) = 사진용으로 마지막 모습에 고정,
 * __mkLog = hud.multiKill이 불릴 때마다 그 직후의 상태와 게임 틱. 시험 브라우저는 소프트웨어 렌더링이라 느려서
 * 2.2초 표시가 다음 검사 전에 끝날 수 있다. 그래서 불린 순간을 기록해서 본다
 */
function installMk() {
  const qa = window.__qa, hud = qa.ui.hud;
  window.__mkState = () => {
    const e = document.querySelector('.sk-mk');
    if (!e) return null;
    const r = e.getBoundingClientRect(), sub = e.querySelector('.sk-mk-sub');
    return {
      show: e.classList.contains('is-show'), id: e.dataset.mk || '', title: (e.querySelector('.sk-mk-title') || {}).textContent || '',
      sub: sub && !sub.hidden ? sub.textContent : '', art: !!e.querySelector('svg.sk-mk-art'), vis: getComputedStyle(e).visibility,
      top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right)
    };
  };
  window.__mkFreeze = (on) => {
    let css = document.getElementById('qa-mk-freeze');
    if (!css) {
      css = document.createElement('style');
      css.id = 'qa-mk-freeze';
      css.textContent = '.sk-mk.qa-freeze { visibility: visible !important; opacity: 1 !important; animation: none !important; } .sk-mk.qa-freeze * { animation: none !important; }';
      document.head.append(css);
    }
    document.querySelector('.sk-mk').classList.toggle('qa-freeze', !!on);
  };
  window.__mkLog = [];
  if (!hud.__mkWrapped) {
    const orig = hud.multiKill;
    hud.multiKill = (o) => { orig(o); window.__mkLog.push({ ...window.__mkState(), tick: qa.ctx.loop.tick }); };
    hud.__mkWrapped = true;
  }
  return true;
}
const hudMk = '__mkState()';
const audioStats = '(() => { const s = __qa.world.internals.audio.getStats(); return { state: s.state, files: s.voiceFiles, last: s.voiceLast, plays: s.voicePlays, cached: s.cached }; })()';

/** 표시를 고정해 사진을 찍고 지운다. 사진 속 상태를 돌려준다 */
async function shotMultiKill(t, page, name, o) {
  await page.fn((x) => { window.__qa.ui.hud.multiKill(x); window.__mkFreeze(true); return true; }, o);
  await sleep(150);
  const st = await page.eval(hudMk);
  await t.shot(name);
  await page.fn(() => { window.__mkFreeze(false); window.__qa.ui.hud.multiKill(null); return true; });
  return st;
}

/** 봇 하나의 머리를 겨눠 한 발 쏘고 그 봇의 kill 이벤트를 기다린다 */
async function headshot(page, botId) {
  await page.waitFor('Math.abs(__qa.arsenal.getRecoilKick().pitch) < 2e-4 && Math.abs(__qa.arsenal.getRecoilKick().yaw) < 2e-4', 4000, { intervalMs: 30, label: '반동 회복' });
  await waitIdle(page, 4000);
  const aim = await page.fn((id) => { const qa = window.__qa; const p = qa.partPoint(id, 'head'); return p ? qa.aimAt(p) : null; }, botId);
  await waitTicks(page, 1);
  await page.eval('window.__qaRng = () => 0');
  await clickFire(page, 2);
  const ok = await page.waitFor(`__qa.match.some((e) => e.type === 'kill' && e.victim === ${JSON.stringify(botId)})`, 3000, { intervalMs: 20, label: `${botId} 처치` }).then(() => true, () => false);
  await page.eval('window.__qaRng = null');
  return { aim, ok };
}

export default {
  name: 'multikill',
  title: '연속 킬: 더블 킬부터 전설까지 그림·글자·안내 음성, 5초 뒤 다시 세기, 휴대폰 배치',
  timeoutMs: 6 * 60 * 1000,
  async run(t) {
    t.setSection('준비');
    let page = await openGame(t, `sandbox=longshot&ruleset=classic&mode=ffa&bots=${BOTS}&killtarget=50`, { profile: richProfile(), settings: LOW_QUALITY, width: 960, height: 540, screen: 'sandbox' });
    await waitRun(page);
    await page.eval('__qa.freezeBots()');
    await waitLive(page);
    await page.waitFor('!__qa.ui.isVisible("loadout")', 8000, { label: '무기 선택 닫힘' });
    await lockPointer(page);
    const ids = await page.eval('__qa.run.bots.map((b) => b.id)');
    t.check(ids.length === BOTS, `봇 ${BOTS}명`, ids.length);
    // 언락(포인터 잠금 클릭)에서 안내 음성을 받아 디코드한다
    const decoded = await page.waitFor('__qa.world.internals.audio.getStats().voiceFiles.length === 6', 15000, { label: '안내 음성 디코드' }).then(() => true, () => false);
    t.check(decoded, '안내 음성 6개를 받아 디코드한다', await page.eval(audioStats));
    const line = await page.fn(lineUp, { n: BOTS, spacing: SPACING });
    if (!line) throw new Error('봇을 한 줄로 세울 자리를 찾지 못했어요');
    t.log(`   ${line.dist} m 앞에 ${BOTS}명, 간격 ${SPACING} m`);
    await page.fn(stage, line);
    await waitTicks(page, 6);
    await page.waitFor(allReady(ids), 15000, { label: '봇 보호 끝' });
    await page.fn(stage, line);
    await waitTicks(page, 4);
    if ((await page.eval('__qa.arsenal.getLoadout().primary')) !== 'ar_std') await page.fn(() => window.__qa.world.setLocalLoadout('ar_std'));
    await waitTicks(page, 2);
    await page.press('Digit1');
    await page.waitFor('__qa.arsenal.getWeapon().id === "ar_std"', 3000, { label: '라이플 들기' });

    t.setSection('더블 킬 ~ 전설');
    await page.fn(installMk);
    await page.eval('__qa.clearLogs()');
    const killTicks = [];
    for (let i = 0; i < BOTS; i++) {
      const r = await headshot(page, ids[i]);
      t.check(r.aim && r.aim.kind === 'player' && r.aim.id === ids[i] && r.aim.part === 'head', `${i + 1}번째: 조준선이 그 봇의 머리를 가리킨다`, r.aim);
      t.check(r.ok, `${i + 1}번째: 머리 1발에 쓰러진다`);
      if (!r.ok) break;
      killTicks.push(await page.eval('__qa.ctx.loop.tick'));
      const count = await page.eval('__qa.world.multiKillCount');
      t.check(count === i + 1, `${i + 1}번째: 이어진 킬 수 ${i + 1}`, count);
      const log = await page.eval('__mkLog.slice()');
      t.check(log.length === i, `${i + 1}번째: 연속 킬 표시는 2킬부터 킬마다 한 번`, log.length);
      if (i === 0) continue;
      const tier = MULTI_KILL_TIERS[Math.min(i + 1, 7) - 2], mk = log[log.length - 1] || {};
      t.check(mk.show && mk.vis === 'visible' && mk.art, `${i + 1}킬: 그림과 함께 뜬다`, mk);
      t.check(mk.id === tier.id && mk.title === tier.title, `${i + 1}킬: "${tier.title}"`, mk);
      if (tier.id === 'legend') t.check(mk.sub === `${i + 1}연속 처치`, '전설: 몇 연속인지 아래에 적는다', mk.sub);
      else t.check(mk.sub === '', `${i + 1}킬: 아래 줄 없음`, mk.sub);
      const au = await page.eval(audioStats);
      t.check(au.last === tier.id, `${i + 1}킬: 안내 음성 "${tier.title}"`, au);
    }
    // 시험 브라우저는 소프트웨어 렌더링이라 실제 시간이 게임 시간보다 길다. 연속 킬은 게임 시간(60 Hz 틱)으로 잰다
    const gaps = killTicks.slice(1).map((v, i) => +((v - killTicks[i]) / 60).toFixed(2));
    t.log(`   킬 사이 게임 시간(초): ${gaps.join(', ')}`);
    t.check(gaps.length === BOTS - 1 && gaps.every((g) => g < MULTI_KILL_WINDOW_MS / 1000), '킬 사이가 모두 게임 시간 5초 안이다', gaps);
    const evs = await page.eval(`__qa.worldEvents.filter((e) => e.evt === 'multiKill').map((e) => e.id)`);
    t.check(JSON.stringify(evs) === JSON.stringify(['double', 'triple', 'quadra', 'penta', 'hexa', 'legend']), 'World multiKill 이벤트 순서', evs);
    const au = await page.eval(audioStats);
    t.check(au.plays >= 6 && au.last === 'legend', '안내 음성을 단계마다 냈다', au);
    t.check(await page.eval(`__qa.world.internals.audio.getStats().cached > 0`), '효과음 합성 캐시가 돈다');
    t.errorsOk('연속 킬');

    t.setSection('5초가 지나면 처음부터');
    const t0 = await page.eval('__qa.ctx.loop.tick');
    await page.waitFor(`__qa.ctx.loop.tick >= ${t0} + ${Math.ceil((MULTI_KILL_WINDOW_MS / 1000 + 0.6) * 60)}`, 30000, { label: '게임 시간 5초 넘게 기다리기' });
    await page.waitFor('!document.querySelector(".sk-mk").classList.contains("is-show")', 8000, { label: '전설 표시 사라짐' });
    await page.waitFor(allReady([ids[0]]), 20000, { label: '첫 봇 부활과 보호 끝' });
    await page.fn(stage, { ...line, only: 0 });
    await waitTicks(page, 4);
    const before = (await page.eval('__mkLog.length'));
    const again = await headshot(page, ids[0]);
    t.check(again.ok, '부활한 봇을 다시 쓰러뜨린다');
    t.check((await page.eval('__qa.world.multiKillCount')) === 1, '5초 뒤의 킬은 1부터 다시 센다', await page.eval('__qa.world.multiKillCount'));
    t.check((await page.eval('__mkLog.length')) === before, '그 킬에는 연속 킬 표시가 없다');

    t.setSection('PC 배치 사진');
    for (const tier of [MULTI_KILL_TIERS[0], MULTI_KILL_TIERS[4], MULTI_KILL_TIERS[5]]) {
      const st = await shotMultiKill(t, page, `multikill-${tier.id}`, { id: tier.id, title: tier.title, sub: tier.id === 'legend' ? '7연속 처치' : '' });
      t.check(st.top > 540 / 2 + 60 && st.bottom <= 540 && st.left >= 0 && st.right <= 960, `PC ${tier.title}: 크로스헤어 아래, 화면 안`, st);
    }
    t.errorsOk('PC 배치');
    await page.close();

    t.setSection('휴대폰 배치');
    page = await t.newPage();
    const W = 844, H = 390;
    await page.open(`${t.base}?debug=1&sandbox=alley&ruleset=classic&mode=ffa&bots=1&killtarget=50`, { width: W, height: H, mobile: true, clean: true, initScript: qaInit({ profile: richProfile() }) });
    await readyGame(page, { screen: 'sandbox' });
    await waitRun(page);
    await page.eval('__qa.freezeBots()');
    await waitLive(page);
    await page.waitFor('!__qa.ui.isVisible("loadout")', 8000, { label: '무기 선택 닫힘' });
    await page.fn(installMk);
    // '작전 개시!'가 떠 있으면 연속 킬이 크로스헤어 아래로 내려가므로(hud.js mkAvoidCenter) 사라진 뒤에 평소 자리를 본다
    const centerShown = '(() => document.querySelector(".sk-center").classList.contains("is-show"))()';
    await page.waitFor(`!${centerShown}`, 8000, { label: '작전 개시 안내가 사라짐' });
    const top = await page.eval(`(() => { const r = document.querySelector('.sk-top').getBoundingClientRect(); return { bottom: Math.round(r.bottom) }; })()`);
    for (const tier of [MULTI_KILL_TIERS[1], MULTI_KILL_TIERS[5]]) {
      const mk = await shotMultiKill(t, page, `multikill-touch-${tier.id}`, { id: tier.id, title: tier.title, sub: tier.id === 'legend' ? '7연속 처치' : '' });
      t.check(mk.show && mk.top >= 0 && mk.bottom <= H / 2 && mk.left >= 0 && mk.right <= W, `휴대폰 ${tier.title}: 크로스헤어 위, 화면 안`, mk);
      t.check(mk.top >= top.bottom - 2, `휴대폰 ${tier.title}: 위쪽 점수판과 겹치지 않는다`, { mk, top });
    }

    // 가운데 메시지(라운드 결과·합류 안내 등)와 같이 뜨면 크로스헤어 아래로 내려 겹치지 않는다. 마지막 적을 잡는 킬은 연속 킬 다음에 라운드 결과가 뜬다
    t.setSection('휴대폰: 가운데 메시지와 같이');
    const boxes = `(() => {
      const box = (s) => { const r = document.querySelector(s).getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) }; };
      return { center: box('.sk-center'), slots: box('.sk-br'), below: document.querySelector('.sk-mk').classList.contains('is-below') };
    })()`;
    const apart = (a, b) => a.bottom <= b.top + 1 || b.bottom <= a.top + 1 || a.right <= b.left + 1 || b.right <= a.left + 1;
    const banner = { text: '블루 팀 승리', sub: '전멸 · 블루 3 : 1 레드' };
    for (const order of ['center-first', 'mk-first']) {
      for (const tier of [MULTI_KILL_TIERS[1], MULTI_KILL_TIERS[5]]) {
        const o = { id: tier.id, title: tier.title, sub: tier.id === 'legend' ? '7연속 처치' : '' };
        await page.fn(({ order, o, banner }) => {
          const hud = window.__qa.ui.hud;
          if (order === 'center-first') { hud.center(banner.text, 6000, { sub: banner.sub }); hud.multiKill(o); }
          else { hud.multiKill(o); hud.center(banner.text, 6000, { sub: banner.sub }); }
          window.__mkFreeze(true);
          return true;
        }, { order, o, banner });
        await sleep(200);
        const mk = await page.eval(hudMk), b = await page.eval(boxes);
        if (order === 'mk-first' && tier.id === 'triple') await t.shot('multikill-touch-center');
        t.check(mk.show && b.below && mk.top >= H / 2, `${order} ${tier.title}: 크로스헤어 아래로 내려간다`, { mk, b });
        t.check(apart(mk, b.center), `${order} ${tier.title}: 가운데 메시지와 겹치지 않는다`, { mk, center: b.center });
        t.check(mk.bottom <= b.slots.top + 1, `${order} ${tier.title}: 무기 칸에 닿지 않는다`, { mk, slots: b.slots });
        await page.fn(() => { window.__mkFreeze(false); window.__qa.ui.hud.multiKill(null); window.__qa.ui.hud.center(''); return true; });
      }
    }
    const reset = await page.eval(boxes);
    t.check(!reset.below, '연속 킬이 사라지면 다음에는 다시 크로스헤어 위에서 시작한다', reset);
    t.errorsOk('휴대폰 배치');
  }
};
