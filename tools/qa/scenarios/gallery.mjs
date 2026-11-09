/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 시나리오 14. 화면 모음. 960x540에서 주요 화면을 차례로 띄워 스크린샷을 남기고, 글자가 화면 밖으로 나가거나 버튼이 잘리지 않는지 본다. 눈으로 확인할 때 이 사진들을 본다.
 *          캐릭터 절은 상점 초상(두 팀 색)과 경기 장면에 모든 캐릭터를 줄 세운 사진(두 팀, 이모트 리그)을 남긴다. --filter avatars면 그 절만 돈다.
 */
import { AVATARS, AVATAR_IDS } from '../../../js/core/avatar-defs.js';
import { TEAM_IDS } from '../../../js/core/consts.js';
import { WEAPON_IDS } from '../../../js/weapons/defs.js';
import { LOW_QUALITY, NICK, lockPointer, openGame, richProfile, sleep, waitLive, waitRun, waitTicks } from '../kit.mjs';

/** 페이지에서: 이 화면의 보이는 버튼 중 뷰포트 밖으로 나간 것(세로로 스크롤되는 곳은 넘어간다) */
function clippedButtons(rootSel) {
  const root = document.querySelector(rootSel);
  if (!root) return ['없는 화면: ' + rootSel];
  const out = [];
  for (const el of root.querySelectorAll('button')) {
    if (el.hidden || el.disabled) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    if (r.left < -1 || r.right > innerWidth + 1) out.push(`${(el.textContent || el.title || '').slice(0, 20)} x ${Math.round(r.left)}..${Math.round(r.right)}`);
  }
  return out;
}

/** 페이지에서: 초상 그림마다 덮인 픽셀 비율과 간단한 지문(서로 다른 그림인가) */
async function portraitStats() {
  const out = [];
  for (const img of document.querySelectorAll('.sk-av-card .sk-av-img')) {
    if (img.hidden || !img.src) { out.push(null); continue; }
    await img.decode().catch(() => {});
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let cover = 0, hash = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] > 8) cover++;
      if (i % 64 === 0) hash = (hash * 31 + d[i] + d[i + 1] * 3 + d[i + 2] * 7) >>> 0;
    }
    out.push({ w: c.width, h: c.height, cover: cover / (c.width * c.height), hash, team: img.parentElement.dataset.team });
  }
  return out;
}

/**
 * 페이지에서: 평평하고 막힘없는 줄(n칸, 간격 gap)과 그 앞 back m의 카메라 자리를 찾아 QA 액터를 세운다.
 * 플레이어는 카메라 자리에서 줄을 바라본다. → { ok, ids }
 */
function lineup({ ids, team, gap, back, yaw, emote }) {
  const qa = window.__qa, c = qa.ctx, P = c.physics, W = c.world, n = ids.length;
  const flat = (x, z, y0) => { const y = P.findFloor(W, x, z); return Math.abs(y - y0) < 0.05 && !P.overlapsCapsule(W, x, y0, z, 0.45, 1.95) && qa.clearOfTriggers(x, z, 1); };
  let spot = window.__qaLineSpot || null;
  for (let x0 = -40; !spot && x0 <= 40; x0 += 1) {
    for (let z0 = -40; !spot && z0 <= 40; z0 += 1) {
      const y0 = P.findFloor(W, x0, z0);
      if (!Number.isFinite(y0) || y0 < -5) continue;
      const xs = Array.from({ length: n }, (_, i) => x0 + i * gap);
      const cx = x0 + ((n - 1) * gap) / 2, cz = z0 - back;
      if (!xs.every((x) => flat(x, z0, y0)) || !flat(cx, cz, y0)) continue;
      const eye = [cx, y0 + 1.6, cz];
      if (!xs.every((x) => P.lineOfSight(W, eye, [x, y0 + 1.0, z0]) && P.lineOfSight(W, eye, [x, y0 + 1.7, z0]) && P.lineOfSight(W, eye, [x, y0 + 0.2, z0]))) continue;
      spot = { x0, z0, y0, cx, cz };
    }
  }
  if (!spot) return { ok: false };
  window.__qaLineSpot = spot;
  const made = [];
  ids.forEach((avatar, i) => {
    const id = `qa-${avatar}`;
    qa.world.addActor({ id, name: avatar.replace('av_', ''), team, kind: 'remote', avatar });
    qa.world.setActorState(id, { pos: [spot.x0 + i * gap, spot.y0, spot.z0], yaw, pitch: 0, alive: true, teleport: true, slot: 1, weaponId: 'ar_std', emote: emote || 0 });
    made.push(id);
  });
  qa.teleport(spot.cx, spot.y0, spot.cz, Math.PI);
  c.player.state.onGround = true;
  c.player.state.pitch = -0.12;
  return { ok: true, ids: made, spot };
}

/** 캐릭터: 상점 초상과 경기 장면 줄 세우기 */
async function avatarSection(t) {
  t.setSection('캐릭터: 상점 초상');
  let page = await openGame(t, '', { profile: richProfile({ points: 12345 }), settings: LOW_QUALITY, screen: 'menu', width: 1280, height: 720 });
  const styleIds = await page.eval(`import('./js/engine/avatars.js').then((m) => [...m.AVATAR_STYLE_IDS])`);
  t.check(JSON.stringify(styleIds) === JSON.stringify(AVATAR_IDS), '모든 캐릭터에 모양이 있다(engine STYLES = core AVATARS)', { styleIds });
  await page.clickText('.sk-menu-btn--sub', '상점');
  await page.waitFor('__qa.ui.isVisible("shop")', 3000, { label: '상점' });
  await page.clickText('.sk-shop .sk-tab', '캐릭터');
  await page.waitFor(`document.querySelectorAll('.sk-av-card .sk-av-img:not([hidden])').length === ${AVATARS.length}`, 8000, { label: '초상 그리기' })
    .catch(() => {});
  for (const team of TEAM_IDS) {
    if (team !== TEAM_IDS[0]) {
      await page.click(`.sk-av-team[data-team="${team}"]`);
      await page.waitFor(`[...document.querySelectorAll('.sk-av-card .sk-av-art')].every((a) => a.dataset.team === '${team}')`, 5000, { label: `${team} 초상` });
    }
    const st = await page.fn(portraitStats);
    t.check(st.length === AVATARS.length && st.every((s) => s && s.w === 240 && s.h === 320), `${team}: 초상 ${AVATARS.length}장(240×320)`, st);
    t.check(st.every((s) => s && s.cover > 0.12 && s.cover < 0.6), `${team}: 초상에 사람이 그려지고 배경은 투명하다`, st && st.map((s) => s && s.cover.toFixed(3)));
    t.check(new Set(st.map((s) => s && s.hash)).size === AVATARS.length, `${team}: 캐릭터마다 다른 그림`, st && st.map((s) => s && s.hash));
    await sleep(300);
    await t.shot(`avatars-shop-${team}`);
  }
  // 확대 사진: 초상 그림만 크게 늘어놓아 모양을 자세히 본다(사진용 덧판, 찍고 나서 지운다)
  const zoomShot = async (name) => {
    const n = await page.fn(() => {
      const el = document.createElement('div');
      el.id = 'qa-av-zoom';
      el.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;flex-wrap:wrap;gap:6px;align-content:center;justify-content:center;background:#0b111d;padding:8px';
      for (const img of document.querySelectorAll('.sk-av-card .sk-av-img')) {
        const c = img.cloneNode();
        c.hidden = false;
        c.style.cssText = 'width:170px;height:227px;border-radius:8px;background:#1a2638';
        el.append(c);
      }
      document.body.append(el);
      return el.children.length;
    });
    t.check(n === AVATARS.length, `${name}: 확대 사진`);
    await sleep(300);
    await t.shot(name);
    await page.fn(() => document.getElementById('qa-av-zoom').remove());
  };
  await zoomShot(`avatars-portraits-${TEAM_IDS[TEAM_IDS.length - 1]}`);
  await page.click(`.sk-av-team[data-team="${TEAM_IDS[0]}"]`);
  await page.waitFor(`[...document.querySelectorAll('.sk-av-card .sk-av-art')].every((a) => a.dataset.team === '${TEAM_IDS[0]}')`, 5000, { label: '첫 팀 초상' });
  await zoomShot(`avatars-portraits-${TEAM_IDS[0]}`);
  t.errorsOk('캐릭터 상점 초상');

  t.setSection('캐릭터: 경기 장면 줄 세우기');
  const all = [...AVATAR_IDS];
  page = await openGame(t, 'sandbox=jetty&ruleset=classic&mode=team&bots=1', { profile: richProfile({ owned: [...WEAPON_IDS, 'av_night'], loadout: { avatar: 'av_night' } }), screen: 'sandbox', width: 1280, height: 720 });
  await waitRun(page);
  await page.eval('__qa.freezeBots()');
  await waitLive(page);
  await page.waitFor('!__qa.ui.isVisible("loadout")', 8000, { label: '무기 선택 닫힘' });
  await page.eval(`__qa.ui.setSettings({ fov: 60 })`);
  await page.eval(`__qa.world.internals.vm.setVisible(false)`);
  for (const team of TEAM_IDS) {
    const r = await page.fn(lineup, { ids: all, team, gap: 1.05, back: 4.4, yaw: 0.35, emote: 0 });
    t.check(r.ok, `${team}: 줄 세울 평평한 자리를 찾는다`, r);
    if (!r.ok) break;
    await waitTicks(page, 12);
    const got = await page.fn((ids) => ids.map((id) => { const a = window.__qa.ctx.avatars.get(id); return a ? `${a.avatarId}:${a.team}` : null; }), r.ids);
    t.check(got.every((g, i) => g === `${all[i]}:${team}`), `${team}: 액터가 고른 캐릭터·팀으로 그려진다`, got);
    await page.eval(`__qa.world.internals.vm.setVisible(false)`);
    await sleep(250);
    await t.shot(`avatars-lineup-${team}`);
  }
  // 이모트 리그: 머리 장비·어깨 보호대가 리그에도 붙는다(손 흔들기 = 7)
  const r2 = await page.fn(lineup, { ids: all, team: TEAM_IDS[0], gap: 1.05, back: 4.4, yaw: 0.35, emote: 7 });
  if (r2.ok) {
    await waitTicks(page, 30);
    const rigs = await page.fn((ids) => ids.map((id) => { const a = window.__qa.ctx.avatars.get(id); return !!(a && a.rig && a.rig.root.visible); }), r2.ids);
    t.check(rigs.every(Boolean), '이모트 중에는 모든 캐릭터가 관절 리그로 바뀐다', rigs);
    await page.eval(`__qa.world.internals.vm.setVisible(false)`);
    await sleep(200);
    await t.shot('avatars-lineup-emote');
  }
  // 앉기: 굽은 다리에도 무릎 보호대 같은 부품이 붙는다
  const r3 = await page.fn((ids) => {
    for (const id of ids) {
      const a = window.__qa.ctx.avatars.get(id);
      window.__qa.world.setActorState(id, { pos: a.pos.slice(), yaw: 0.35, pitch: 0, alive: true, crouch: true, emote: 0, slot: 1, weaponId: 'ar_std' });
    }
    return ids.length;
  }, r2.ids || []);
  if (r3) {
    await waitTicks(page, 20);
    await page.eval(`__qa.world.internals.vm.setVisible(false)`);
    await t.shot('avatars-lineup-crouch');
  }
  // 내 몸(3인칭 이모트)도 내 캐릭터다
  await page.fn((ids) => { for (const id of ids) window.__qa.world.removeActor(id); }, r2.ids || []);
  const em = await page.eval(`__qa.ctx.player.startEmote('wave')`);
  t.check(em && em.ok, '이모트 시작', em);
  await page.waitFor('!!__qa.ctx.avatars.localBody && __qa.ctx.avatars.localBody.visible', 3000, { label: '3인칭 내 몸' }).catch(() => {});
  t.check((await page.eval('__qa.ctx.avatars.localBody && __qa.ctx.avatars.localBody.avatarId')) === 'av_night', '3인칭 이모트의 내 몸은 장착한 캐릭터다');
  await sleep(600);
  await t.shot('avatars-local-emote');
  t.errorsOk('캐릭터 경기 장면');
}

export default {
  name: 'gallery',
  title: '주요 화면 사진과 가로 넘침 검사',
  timeoutMs: 8 * 60 * 1000,
  async run(t) {
    await avatarSection(t);
    if (t.filter === 'avatars') return;
    const stats = { kills: 57, deaths: 31, headshots: 12, halfShots: 3, knifeKills: 4, matches: 9, wins: 4, secondsPlayed: 3725 };
    const profile = richProfile({ points: 12345, stats, secrets: { alley: { alley_watertower: { name: '물탱크 옥상', at: 5 } } } });
    const see = async (name, sel) => {
      await sleep(350);
      await t.shot(name);
      if (sel) t.check((await t.page.fn(clippedButtons, sel)).length === 0, `${name}: 버튼이 가로로 잘리지 않는다`, await t.page.fn(clippedButtons, sel));
    };
    // Tab을 누른 채 점수판 사진. 4배속이라 그사이 라운드가 끝나 조작이 풀렸으면(무기 선택·라운드 끝) 사진만 건너뛴다
    const scoreboardShot = async (page, name) => {
      await page.key('Tab', 'down');
      const open = await page.waitFor('__qa.ui.isVisible("scoreboard")', 2000, { label: '점수판' }).then(() => true, () => false);
      if (open) await see(name);
      else {
        const st = await page.eval('({ locked: __qa.ctx.input.locked, enabled: __qa.ctx.input.enabled, phase: __qa.world.internals.rnd.phase })');
        if (st.locked && st.enabled && st.phase === 'live') t.check(false, `${name}: Tab을 누르면 점수판이 열린다`, st);
        else t.note(`${name}: 점수판을 열기 전에 라운드가 끝나 사진을 건너뛰었다 ${JSON.stringify(st)}`);
      }
      await page.key('Tab', 'up');
    };

    t.setSection('메뉴 화면');
    let page = await openGame(t, '', { profile, settings: LOW_QUALITY, screen: 'menu' });
    await see('menu', '.sk-menu');
    await page.clickText('.sk-menu-btn', '연습장');
    await page.waitFor('!!document.querySelector(".sk-sheet")', 3000, { label: '연습장 시트' });
    await see('practice-sheet', '.sk-sheet');
    await page.press('Escape');
    await page.click('.sk-player-mypage');
    await page.waitFor('__qa.ui.isVisible("mypage")', 3000, { label: '마이페이지' });
    await see('mypage', '.sk-mypage');
    await page.click('.sk-mypage .sk-my-panelhead .sk-btn--sm');
    await page.waitFor('__qa.ui.isVisible("shop")', 3000, { label: '상점' });
    await see('shop-rifle', '.sk-shop');
    for (const tab of ['저격', 'SMG·샷건', '권총', '근접']) {
      await page.clickText('.sk-shop .sk-tab', tab);
      await see(`shop-${tab.replace(/\W/g, '')}`, '.sk-shop');
    }
    await page.click('.sk-shop .sk-btn--ghost');
    await page.waitFor('__qa.ui.isVisible("mypage")', 3000, { label: '마이페이지로' });
    await page.press('Escape');
    await page.waitFor('__qa.ui.isVisible("menu")', 3000, { label: '메뉴로' });
    await page.clickText('.sk-menu-btn--sub', '설정');
    await see('settings', '.sk-settings');
    await page.press('Escape');
    await page.clickText('.sk-menu-btn--sub', '조작법');
    await see('controls-panel', '.sk-menu');
    await page.press('Escape');
    t.errorsOk('메뉴 화면');

    t.setSection('개인전 경기 화면');
    page = await openGame(t, 'sandbox=nexus&ruleset=classic&mode=ffa&bots=5&killtarget=5&timescale=4', { profile, settings: LOW_QUALITY, screen: 'sandbox' });
    await waitRun(page);
    await waitLive(page);
    await page.waitFor('!__qa.ui.isVisible("loadout")', 5000, { label: '무기 선택 닫힘' });
    await page.eval(`__qa.ui.show('loadout', { ruleset: 'classic', seconds: 0, selected: 'ar_std', title: '개인전 · 무기 선택' })`);
    await see('ffa-loadout', '.sk-loadout');
    await page.eval(`__qa.ui.hide('loadout')`);
    await lockPointer(page);
    await page.waitFor(`__qa.match.some((e) => e.type === 'kill')`, 40000, { label: '첫 킬' });
    await see('ffa-hud');
    await scoreboardShot(page, 'ffa-scoreboard');
    await page.waitFor('__qa.ui.isVisible("results")', 90000, { intervalMs: 300, label: '결과 화면' });
    await sleep(1200);
    await see('ffa-results', '.sk-results');
    t.errorsOk('개인전 경기');

    t.setSection('팀전 경기 화면');
    page = await openGame(t, 'sandbox=alley&ruleset=knife&mode=team&bots=2&timescale=4', { profile, settings: LOW_QUALITY, screen: 'sandbox' });
    await waitRun(page);
    await waitLive(page);
    await page.waitFor('!__qa.ui.isVisible("loadout")', 5000, { label: '무기 선택 닫힘' });
    await page.eval(`__qa.ui.show('loadout', { ruleset: 'knife', seconds: 0, selected: 'ml_knife', round: 1 })`);
    await see('knife-loadout', '.sk-loadout');
    await page.eval(`__qa.ui.hide('loadout')`);
    await lockPointer(page);
    await waitTicks(page, 20);
    await see('team-hud');
    await scoreboardShot(page, 'team-scoreboard');
    await page.waitFor(`__qa.world.internals.rnd.phase === 'roundEnd' || __qa.run.phase === 'roundEnd'`, 90000, { intervalMs: 200, label: '라운드 끝' });
    await see('team-round-end');
    await page.waitFor('__qa.ui.isVisible("results")', 150000, { intervalMs: 300, label: '결과 화면' });
    await sleep(1200);
    await see('team-results', '.sk-results');
    t.errorsOk('팀전 경기');

    t.setSection('사격 화면');
    page = await openGame(t, 'sandbox=dojo&ruleset=knife&mode=ffa&bots=1', { profile: { nickname: NICK, createdAt: 1 }, screen: 'sandbox' });
    await waitRun(page);
    await page.eval('__qa.freezeBots()');
    await waitLive(page);
    await page.waitFor('!__qa.ui.isVisible("loadout")', 8000, { label: '무기 선택 닫힘' });
    await see('dojo-default-quality');
    await page.eval(`__qa.ui.show('pause', { leaveLabel: '연습장 나가기', note: '연습장은 일시정지하면 봇도 멈춰요.' })`);
    await see('pause', '.sk-pause');
    t.errorsOk('사격 화면');
  }
};
