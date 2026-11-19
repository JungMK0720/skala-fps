/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 시나리오 25. 좀비 물량 막기(혼자). 메뉴의 좀비 버튼이 여는 고르기 시트(같이 하기 · 혼자 하기 · 로비에서 찾기, 오프라인이면 같이 하기는 꺼진다),
 *          연습장 설정 시트의 모드와 좀비 전용 맵, 준비 시간에만 되는 N 무기 교체(모든 무기 · 한 번 쓴 총은 남은 탄 그대로),
 *          좀비 전용 기관총 MG-100(목록 맨 끝 · 탄창 100 · 예비 600 · 이동 70%/조준 42% · HUD 이름 · 연사 · 조준 · 재장전, 스크린샷 mg-*), 1스테이지 → 좀비가 좀비 문에서
 *          나와 다가오는지, 내 사격이 방장 시뮬레이션에 피해로 들어가는지, 팀 경험치로 레벨이 오르면 증강 3장(혼자는 게임이 멈춤 · 카드 입력 잠금 ·
 *          R 길게 다시 뽑기 · 카드를 누르고 [확인] · 고른 뒤 3초 무적), 40초가 지나면 남은 좀비를 둔 채 다음 스테이지, C4 수류탄(좀비에 붙어 따라가다 터짐),
 *          검기(칼을 휘두르면 초승달이 날아가 4~8 m 좀비에게 칼 피해), 좀비에게 맞으면 밀려남(부동자세면 버팀), 바닥 보급품(탄창은 예비 탄과 수류탄을
 *          채움 · 구급 상자 +10), 다 잡으면 쉬지 않고 다음 스테이지, 3스테이지 보스 체력 막대·스킬 예고·보물 상자, 전멸 뒤 결과 화면과 계정 기록을 본다.
 */
import { LOW_QUALITY, lockPointer, openGame, richProfile, sleep, waitRun, waitTicks, waitIdle, clickFire } from '../kit.mjs';
import { WEAPONS } from '../../../js/weapons/defs.js';
import { HORDE, hordeAmmo, xpNeed } from '../../../js/game/horde/rules.js';
import { zombieHitDamage } from '../../../js/game/horde/director.js';
import { c4WorldPos } from '../../../js/game/horde/contact.js';
import { CARD_ARM_MS, REROLL_HOLD_MS } from '../../../js/ui/cards.js';

/**
 * 레벨 업에서 고를 카드: 뒤 시험을 흔드는 카드(무기 목록을 여는 교체권, 맞아도 체력이 그대로인 보호막·회피, 뒤에서 따로 주는 검기·부동자세·C4,
 * C4 폭발에 불길·얼음·분신을 붙이거나 여러 개를 던지게 하는 수류탄 증강, 보급품 양(구급 키트·탄띠)·탄창 크기(탄창 확장·드럼 탄창·전술 재장전)·
 * 초당 회복(재생·불굴·회복 주사)을 바꾸는 카드. 바닥 보급품 시험이 기본 값(구급 상자 +10, 탄창 장전 1회분)과 정확히 같은 값을 기대한다)는 피한다.
 * 칼 피해·치명타 같은 능력치는 검기 시험이 내 능력치로 기대 피해를 계산하므로 상관없다
 */
const SHAKY_CARD = /무기 교체권|보호막|회피|행운의 동전|벙커|검기|부동자세|C4 수류탄|화염 수류탄|빙결 수류탄|어그로 수류탄|다연발 투척|구급 키트|탄띠|탄창 확장|드럼 탄창|전술 재장전|재생|불굴|회복 주사/;

/** 방장 공식(zombieHitDamage)으로 검기 한 번의 피해. 치명타가 있으면 치명타 값도 돌려준다 */
function expectedHit(perks, weaponId, kind, z, myHpFrac) {
  const h = zombieHitDamage({ weaponId, part: 'body', dist: 3, kind, count: 1 }, perks, { boss: false, hpFrac: z.hp / z.maxHp }, { myHpFrac });
  const base = Math.max(1, Math.round(h.dmg));
  return perks.crit > 0 ? [base, Math.max(1, Math.round(h.dmg * (1.5 + (perks.critDmg || 0))))] : [base];
}

/** 방장 시뮬레이션의 살아 있는 좀비를 모두 쓰러뜨린다(시험용: 스테이지를 빨리 깬다) → 쓰러뜨린 수 */
const KILL_ALL = `(() => {
  const d = __qa.run.director, me = __qa.world.localId;
  let n = 0, shot = 900000;
  for (const Z of d.internals.zombies.values()) {
    if (Z.state === 'dead') continue;
    let g = 0;
    while (Z.state !== 'dead' && g++ < 300) d.claimHit({ attackerId: me, victimId: 'z' + Z.id, weaponId: 'sr_heavy', part: 'body', dist: 5, kind: 'shot', count: 1, shotId: ++shot });
    if (Z.state === 'dead') n++;
  }
  d.internals.S.queue.length = 0;
  return n;
})()`;

/**
 * 시험 구간을 차분하게: 좀비를 모두 멈추고(공격·스킬도) 새 좀비를 막는다. 줄이 비면 스테이지가 저절로 끝나지 않게 한 마리를 남겨 두고,
 * 스테이지 시간을 처음(40초)으로 되돌린다(구간 중에 시간이 다 돼 다음 스테이지로 넘어가지 않게)
 */
const FREEZE = `(() => {
  const d = __qa.run.director, S = d.internals.S;
  for (const Z of d.internals.zombies.values()) {
    Z.speed = 0; Z.attackReady = 1e12; Z.rangedAt = 1e12; Z.progressAt = S.clock + 600000;
    if (Z.state === 'wind') Z.state = 'move';
    if (Z.skillReady) { Z.skillReady = Z.skillReady.map(() => 1e12); Z.skill = null; }
  }
  S.spawnAt = Infinity;
  if (!S.queue.length) S.queue.push({ type: 'walker' });
  S.stageEnd = S.clock + d.rules.stageMs;
  d.internals.loot.clear();
  return true;
})()`;

/** 페이지에서: 살아 있는 일반 좀비가 n마리가 되도록 바로 내보낸다(줄 앞에 워커를 세우고 나올 시각을 당긴다) → 지금 수 */
function spawnSome(n) {
  const d = window.__qa.run.director, S = d.internals.S;
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
 * 페이지에서: 시험할 곧은 길. 바닥이 평평하고(시작 자리와 같은 높이), 무릎·가슴·눈 높이에서 len m 앞까지 벽이 없고, 양옆 0.7 m도 비었고,
 * 발판·포털이 없는 곳. 지금 내 자리부터, 안 되면 맵을 4 m 간격으로 찾는다 → { x, y, z, yaw, dx, dz } | null (dx, dz = 앞 방향)
 */
function findLane(o) {
  const qa = window.__qa, c = qa.ctx, w = c.world, P = c.physics;
  const s = c.player.state;
  const starts = [[s.pos[0], s.pos[2]]];
  for (let x = -28; x <= 28; x += 4) for (let z = -18; z <= 18; z += 4) starts.push([x, z]);
  for (const [sx, sz] of starts) {
    const y0 = P.findFloor(w, sx, sz);
    if (!Number.isFinite(y0) || Math.abs(y0) > 0.6) continue;
    if (P.overlapsCapsule(w, sx, y0 + 0.05, sz, 0.45, 1.9) || !qa.clearOfTriggers(sx, sz)) continue;
    for (let k = 0; k < 24; k++) {
      const yaw = (k * Math.PI) / 12;
      const dx = -Math.sin(yaw), dz = -Math.cos(yaw);
      const px = dz, pz = -dx;   // 오른쪽
      let ok = true;
      for (const side of [0, -0.7, 0.7]) {
        for (const hgt of [0.5, 1.1, 1.6]) {
          const ax = sx + px * side, az = sz + pz * side;
          if (!P.lineOfSight(w, [ax, y0 + hgt, az], [ax + dx * o.len, y0 + hgt, az + dz * o.len])) { ok = false; break; }
        }
        if (!ok) break;
      }
      for (let d = 1; ok && d <= o.len; d += 1) {
        const x = sx + dx * d, z = sz + dz * d;
        if (Math.abs(P.findFloor(w, x, z) - y0) > 0.05 || !qa.clearOfTriggers(x, z, 0.8) || P.overlapsCapsule(w, x, y0 + 0.05, z, 0.45, 1.9)) ok = false;
      }
      if (ok) return { x: sx, y: y0, z: sz, yaw, dx, dz };
    }
  }
  return null;
}

/** 페이지에서: 플레이어를 길 시작에 세우고 길 쪽을 본다 */
function standOnLane(lane) {
  window.__qa.teleport(lane.x, lane.y + 0.05, lane.z, lane.yaw);
  return true;
}

/**
 * 페이지에서: 좀비 몇 마리를 길 위 자리(dist m 앞, side m 옆)에 세워 나를 보게 하고, 나머지 좀비는 좀비 문으로 치운다.
 * o = { spots: [{ dist, side }], lane, ids?: 먼저 세울 좀비 번호 } → 자리마다 세운 좀비 번호(모자라면 그만큼 적다)
 */
function placeOnLane(o) {
  const d = window.__qa.run.director, S = d.internals.S;
  const L = o.lane;
  const alive = [...d.internals.zombies.values()].filter((Z) => Z.state !== 'dead' && !Z.boss);
  const chosen = (Array.isArray(o.ids) ? o.ids : []).map((id) => alive.find((Z) => Z.id === id)).filter(Boolean);
  for (const Z of alive) { if (chosen.length >= o.spots.length) break; if (!chosen.includes(Z)) chosen.push(Z); }
  const ids = [];
  let parked = 0;
  for (const Z of alive) {
    const i = chosen.indexOf(Z);
    let x, z, y = L.y;
    if (i >= 0 && i < o.spots.length) {
      const spot = o.spots[i];
      x = L.x + L.dx * spot.dist + L.dz * (spot.side || 0);
      z = L.z + L.dz * spot.dist - L.dx * (spot.side || 0);
      ids[i] = Z.id;
    } else {
      const g = d.internals.gates[parked++ % d.internals.gates.length];
      x = g[0]; z = g[2]; y = Number.isFinite(g[1]) ? g[1] : 0;
    }
    Z.body.pos[0] = x; Z.body.pos[1] = y; Z.body.pos[2] = z;
    Z.body.vel[0] = Z.body.vel[1] = Z.body.vel[2] = 0;
    Z.state = 'move'; Z.speed = 0; Z.attackReady = 1e12; Z.progressAt = S.clock + 600000; Z.bestDist = Infinity;
    Z.yaw = Math.atan2(x - L.x, z - L.z);   // 나(길 시작)를 본다
  }
  return ids;
}
/** 세운 좀비가 화면에도 그 자리에 다 올라와 있을 때까지(보간·솟아오름이 끝날 때까지) */
async function waitPlaced(page, ids, timeoutMs = 6000) {
  await page.waitFor(`(() => {
    const d = __qa.run.director;
    return ${JSON.stringify(ids)}.every((id) => {
      const Z = d.internals.zombies.get(id), z = __qa.world.horde.zombieAt(id);
      return Z && z && !z.rising && Math.hypot(z.x - Z.body.pos[0], z.z - Z.body.pos[2]) < 0.05;
    });
  })()`, timeoutMs, { intervalMs: 50, label: '세운 좀비가 화면에 그려진다' });
}

/**
 * 페이지에서: 내게 증강 하나를 방장 시뮬레이션으로 준다(제안 하나를 만들어 cardAction으로 고른다. 실제 고르기와 같은 길이라 능력치·스냅샷이 함께 바뀐다).
 * 고른 직후 3초 무적은 이 시험에서는 끈다 → { ok, cards, perks }
 */
function giveCard(id) {
  const qa = window.__qa, d = qa.run.director, me = qa.world.localId;
  const P = d.internals.players.get(me);
  if (!P) return { ok: false };
  P.offer = { cards: [id], roll: 0, round: 9000 + P.cards.length, rerolls: 0, count: 1, chest: false };
  P.picked = false; P.picks = 1; P.chestPicks = 0;
  const ev = d.cardAction(me, 'pick', id);
  P.invulnUntil = 0;
  qa.run.flush();
  return { ok: ev.some((e) => e.type === 'card' && e.card === id), cards: P.cards.slice(), perks: { ...P.perks } };
}

/** 페이지에서: 방장 시뮬레이션의 나 */
const ME = `__qa.run.director.internals.players.get(__qa.world.localId)`;
/** 피해 숫자는 0.8초 만에 사라지므로, 띄운 숫자를 __dn에 적어 둔다(시험용 기록. 띄우는 것은 그대로) */
const COUNT_NUMBERS = `(() => {
  const h = __qa.world.internals.horde;
  if (!h.__dn) { const f = h.damageNumber; h.__dn = []; h.damageNumber = (pos, amount, kind) => { h.__dn.push({ amount: Math.round(Number(amount) || 0), kind }); return f(pos, amount, kind); }; }
  h.__dn.length = 0;
  return true;
})()`;
const callouts = (page) => page.eval(`[...document.querySelectorAll('.sk-callout')].map((e) => e.textContent)`);

/** 카드 화면이 뜬 시각과 그 위에서 누른 시각(뜬 뒤 ms)을 __qa.cardLog에 남긴다. 카드가 뜨기 전에 한 번 부른다 */
export const CARD_LOG = `(() => {
  const ov = document.querySelector('.sk-cards');
  const log = __qa.cardLog = { shownAt: 0, downs: [] };
  new MutationObserver(() => { if (!ov.hidden && !log.shownAt) log.shownAt = performance.now(); }).observe(ov, { attributes: true, attributeFilter: ['hidden'] });
  ov.addEventListener('pointerdown', () => log.downs.push(performance.now() - log.shownAt), true);
  return true;
})()`;

/** 카드 화면이 떠 있으면 가운데 카드의 화면 자리와 뜬 뒤 지난 ms를 JSON 글자로(아니면 false). waitFor로 기다리며 바로 받는다 */
export const CARD_MID = `__qa.ui.isVisible('cards') && __qa.cardLog && __qa.cardLog.shownAt > 0 && (() => {
  const c = document.querySelectorAll('.sk-cd-card')[1];
  if (!c) return false;
  const r = c.getBoundingClientRect();
  return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2, since: performance.now() - __qa.cardLog.shownAt });
})()`;

/** 카드 화면 상태: 카드 이름·선택된 카드 수·확인 단추 */
export const CARD_STATE = `({ cards: [...document.querySelectorAll('.sk-cd-card .sk-cd-name')].map((e) => e.textContent),
  tiers: [...document.querySelectorAll('.sk-cd-card')].map((e) => (/sk-cd--(\\w+)/.exec(e.className) || [])[1] || ''),
  selected: document.querySelectorAll('.sk-cd-card.is-selected').length, confirm: __qa.text('.sk-cd-confirm'), confirmOff: document.querySelector('.sk-cd-confirm').disabled,
  reroll: __qa.text('.sk-cd-reroll'), title: __qa.text('.sk-cd-title'), sub: __qa.text('.sk-cd-sub'), wait: __qa.text('.sk-cd-wait'), timer: __qa.text('.sk-cd-timer') })`;

const HUD = `({
  hz: __qa.visible('.sk-hz-top'), line: __qa.text('.sk-hz-line'), stage: __qa.text('.sk-hz-stage-n'), time: __qa.visible('.sk-hz-time') ? __qa.text('.sk-hz-time') : '',
  lv: __qa.text('.sk-hz-lv'), xp: __qa.text('.sk-hz-xpnum'),
  bosses: [...document.querySelectorAll('.sk-hz-boss')].filter((e) => !e.hidden).map((e) => e.textContent),
  phase: __qa.run && __qa.run.phase, count: __qa.world.horde.count, alive: __qa.world.localAlive,
  hp: __qa.ctx.player.state.hp, cards: __qa.ui.isVisible('cards'), top: __qa.visible('.sk-top'), swap: __qa.visible('.sk-swap') ? __qa.text('.sk-swap') : ''
})`;

export default {
  name: 'zombie',
  title: '좀비 물량 막기(혼자): 고르기 시트 · 스테이지 · 증강 · C4 · 검기 · 밀려남 · 보스 · 결과',
  timeoutMs: 11 * 60 * 1000,
  async run(t) {
    t.setSection('메뉴의 좀비 물량 막기: 같이 하기 · 혼자 하기 고르기 시트');
    let page = await openGame(t, '', { profile: richProfile(), settings: LOW_QUALITY, width: 960, height: 540, screen: 'menu' });
    await page.clickText('.sk-menu-btn', '좀비 물량 막기');
    // 메뉴 버튼은 먼저 고르기 시트(같이 하기 · 혼자 하기 · 로비에서 찾기)를 연다. 혼자 하기가 예전 바로가기다
    await page.waitFor('!!document.querySelector(".sk-sheet.sk-zpick")', 5000, { label: '좀비 고르기 시트' });
    const pick = await page.eval(`[...document.querySelectorAll('.sk-zpick .sk-zpick-opt, .sk-zpick .sk-zpick-find')].map((b) => b.textContent)`);
    t.check(pick.some((s) => /같이 하기/.test(s)) && pick.some((s) => /혼자 하기/.test(s)) && pick.some((s) => /로비에서 좀비 방 찾기/.test(s)),
      '메뉴 버튼은 같이 하기 · 혼자 하기 · 로비에서 찾기를 고르는 시트를 연다', pick);
    const zp = await page.eval(`(() => {
      const room = document.querySelector('.sk-zpick .sk-zpick-opt--room');
      const solo = [...document.querySelectorAll('.sk-zpick .sk-zpick-opt')].find((b) => /혼자 하기/.test(b.textContent));
      const find = document.querySelector('.sk-zpick .sk-zpick-find'), note = document.querySelector('.sk-zpick .sk-zpick-note');
      return { title: __qa.text('.sk-zpick .sk-sheet-title'), roomOff: room.disabled, roomSub: room.querySelector('.sk-zpick-sub').textContent,
        soloOff: solo.disabled, soloSub: solo.querySelector('.sk-zpick-sub').textContent, findOff: find.disabled,
        note: note.hidden ? '' : note.textContent, focusSolo: document.activeElement === solo };
    })()`);
    t.check(/좀비 물량 막기/.test(zp.title), '시트 제목', zp.title);
    // 시험 서버는 온라인 설정이 비어 있다(오프라인): 같이 하기와 로비에서 찾기는 꺼지고 사유가 보인다. 혼자 하기는 언제나 된다
    t.check(zp.roomOff && /지금은 쓸 수 없어요/.test(zp.roomSub) && zp.findOff && /온라인 서버가 설정되지 않아/.test(zp.note),
      '오프라인이면 같이 하기·로비에서 찾기가 꺼지고 사유를 보여 준다', zp);
    t.check(!zp.soloOff && /증강을 고르는 동안 게임이 멈춰요/.test(zp.soloSub), '혼자 하기는 켜져 있고 멈춤 안내가 붙는다', zp);
    t.check(zp.focusSolo, '같이 하기가 꺼져 있으면 포커스는 혼자 하기에', zp);
    await t.shot('zombie-pick');
    await page.press('Escape');
    await page.waitFor('!document.querySelector(".sk-zpick")', 3000, { label: 'Esc로 고르기 시트 닫힘' }).then(
      () => t.check(true, 'Esc로 고르기 시트를 닫는다'), (err) => t.check(false, 'Esc로 고르기 시트를 닫는다', err.message));
    t.check(await page.eval(`__qa.ui.isVisible('menu') && __qa.ctx.screen === 'menu'`), '닫으면 메뉴 그대로');
    await page.clickText('.sk-menu-btn', '좀비 물량 막기');
    await page.waitFor('!!document.querySelector(".sk-sheet.sk-zpick")', 5000, { label: '좀비 고르기 시트 다시' });
    await page.clickText('.sk-zpick-opt', '혼자 하기');
    await page.waitFor('!!document.querySelector(".sk-sheet .sk-sheet-foot")', 5000, { label: '바로가기 시트' });
    t.check(await page.eval(`!document.querySelector('.sk-zpick')`), '혼자 하기를 누르면 고르기 시트는 닫힌다');
    const quick = await page.eval(`({ on: (document.querySelector('.sk-sheet [aria-label="모드"] .sk-seg-btn.is-on') || {}).textContent || '',
      hint: [...document.querySelectorAll('.sk-sheet .sk-field-hint')].map((e) => e.textContent).join(' | ') })`);
    t.check(/좀비 물량 막기/.test(quick.on) && /예비 탄 3배/.test(quick.hint), '혼자 하기는 좀비 모드를 고른 연습장 시트를 연다', quick);
    t.check(/40초/.test(quick.hint) && /레벨이 오르면 증강/.test(quick.hint) && /같이 하기/.test(quick.hint), '안내는 지금 규칙(40초 스테이지 · 레벨 업 증강 · 같이 하기)', quick.hint);
    const green = await page.eval(`(() => { const b = [...document.querySelectorAll('.sk-menu-btn')].find((x) => /좀비 물량 막기/.test(x.textContent)); const cs = getComputedStyle(b); return { bg: cs.backgroundImage, cls: b.className }; })()`);
    const rgb = (green.bg.match(/rgb\((\d+), (\d+), (\d+)\)/) || []).slice(1).map(Number);
    t.check(/sk-menu-btn--zombie/.test(green.cls) && rgb.length === 3 && rgb[1] > rgb[0] && rgb[1] > rgb[2], '메인 메뉴의 좀비 물량 막기 버튼은 초록색이다', green);
    const quickMaps = await page.eval(`[...document.querySelectorAll('.sk-sheet .sk-mapcard-name')].map((e) => e.textContent)`);
    t.check(quickMaps.join() === '고속도로 휴게소,지하철 환승역', '좀비 모드는 좀비 전용 맵 둘만 고른다', quickMaps);
    await t.shot('menu-quick');
    await page.clickText('.sk-sheet-foot .sk-btn', '취소');
    await page.waitFor('!document.querySelector(".sk-sheet .sk-sheet-foot")', 3000, { label: '시트 닫힘' });
    t.errorsOk('고르기 시트');

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

    t.setSection('준비 시간: N 무기 교체(모든 무기 · 한 번 쓴 총은 남은 탄 그대로)');
    // 준비 시간을 넉넉히 두고 교체를 본 뒤, 시험용으로 준비를 바로 끝낸다
    page = await openGame(t, 'sandbox=restarea&mode=zombie&prep=60', { profile: richProfile(), settings: LOW_QUALITY, width: 960, height: 540, screen: 'sandbox' });
    await waitRun(page);
    await page.waitFor(`__qa.run.phase === 'prep' && __qa.world.localAlive`, 10000, { label: '준비 단계' });
    await page.waitFor(`__qa.visible('.sk-hz-top') && /작전 준비/.test(__qa.text('.sk-hz-line'))`, 5000, { label: '준비 HUD' });
    let s = await page.eval(HUD);
    t.check(s.hz && !s.top, '좀비 HUD 띠가 뜨고 팀 점수 줄은 숨는다', s);
    t.check(s.alive, '내가 블루 진영 스폰에 나온다', s);
    t.check(/작전 준비 · \d+초 뒤 1스테이지 · 무기는 지금만 고를 수 있어요/.test(s.line) && s.stage === '1' && !s.time, '준비 HUD: 남은 준비 시간 · 무기는 지금만', s);
    t.check(/무기 교체/.test(s.swap) && /시작 전에만/.test(s.swap), '준비 시간에는 N 무기 교체 안내가 뜬다', s.swap);
    t.check(/Lv 1/.test(s.lv) && /^0 \/ 10$/.test(s.xp), '팀 레벨 1 · 경험치 0 / 10', s);
    const ammo = await page.eval(`__qa.arsenal.getAmmo(__qa.arsenal.getLoadout().primary)`);
    const want = hordeAmmo(WEAPONS[ammo.weaponId]);
    t.check(want && ammo.reserve === want.reserve, `예비 탄이 기존 맵의 3배(${ammo.weaponId} ${want && want.reserve})`, ammo);
    await lockPointer(page);
    // RX-4로 몇 발 쏴서(바닥) 탄창을 줄여 둔다
    t.check(await page.eval(`__qa.arsenal.getLoadout().primary === 'ar_std'`), '시험 프로필의 주무기는 RX-4', await page.eval(`__qa.arsenal.getLoadout()`));
    await page.eval(`(() => { const s = __qa.ctx.player.state; s.pitch = -1.2; return true; })()`);
    await clickFire(page, 8);
    await waitTicks(page, 6);
    const rx4 = await page.eval(`(() => { const a = __qa.arsenal.getAmmo('ar_std'); return { mag: a.mag, reserve: a.reserve }; })()`);
    t.check(rx4.mag < WEAPONS.ar_std.mag, '쏜 만큼 탄창이 줄었다', rx4);
    await page.press('KeyN');
    await page.waitFor(`__qa.ui.isVisible('loadout')`, 3000, { label: '무기 목록' });
    const list = await page.eval(`({ cards: [...document.querySelectorAll('.sk-loadout .sk-lo-card .sk-lo-name')].map((e) => e.textContent),
      extras: [...document.querySelectorAll('.sk-loadout .sk-lo-extra')].filter((e) => !e.hidden).map((e) => e.querySelectorAll('.sk-choice').length),
      title: __qa.text('.sk-lo-title'), count: !document.querySelector('.sk-lo-count').hidden })`);
    const primaries = Object.values(WEAPONS).filter((w) => w.slot === 1 && !w.cardOnly).length;
    t.check(list.cards.length === primaries && list.cards[primaries - 1] === WEAPONS.mg_m249.name, `준비 시간에 고를 수 있는 주무기 ${primaries}자루(카드 전용 무기 제외, 좀비 전용 기관총이 맨 끝)`, list.cards);
    t.check(list.extras.length === 2 && list.extras[0] === 2 && list.extras[1] === 4, '보조 2·근접 4 빠른 교체 줄도 모두(좀비 전용 발사기는 증강으로만)', list.extras);
    t.check(/좀비 물량 막기/.test(list.title) && !list.count, '좀비 모드 교체 창은 시간 막대 없이 준비 시간 동안 열린다', list);
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
    t.errorsOk('준비 시간 무기 교체');

    t.setSection('기관총 MG-100(좀비 전용): 고르기 · 탄창 100발 · 이동 70% · 사격 · 조준 · 재장전');
    await page.press('KeyN');
    await page.waitFor(`__qa.ui.isVisible('loadout')`, 3000, { label: '무기 목록(기관총)' });
    await page.clickText('.sk-loadout .sk-lo-card .sk-lo-name', WEAPONS.mg_m249.name);
    await page.waitFor(`!__qa.ui.isVisible('loadout') && __qa.arsenal.getLoadout().primary === 'mg_m249'`, 3000, { label: '기관총으로 바뀜' });
    await waitIdle(page);
    await page.waitFor(`__qa.world.internals.vm.getWeaponId() === 'mg_m249'`, 3000, { label: '기관총 모형' });
    const mg0 = await page.eval(`(() => { const a = __qa.arsenal.getAmmo('mg_m249'); return { mag: a.mag, size: a.magSize, reserve: a.reserve, move: __qa.arsenal.getMoveMul(), scale: __qa.ctx.player.state.speedScale }; })()`);
    const mgWant = hordeAmmo(WEAPONS.mg_m249);
    t.check(mg0.mag === 100 && mg0.size === 100 && mg0.reserve === mgWant.reserve && mgWant.reserve === 600, '기관총: 탄창 100발 · 예비 600(좀비 모드는 예비 3배)', mg0);
    t.check(Math.abs(mg0.move - 0.7) < 1e-6 && Math.abs(mg0.scale - 0.7) < 1e-3, '기관총을 든 동안 이동 속도가 70%로 느리다', mg0);
    const hudMag = await page.eval(`document.querySelector('.sk-ammo-mag').textContent`);
    t.check(hudMag === '100', 'HUD 탄약이 100으로 보인다', hudMag);
    const hudNames = await page.eval(`({ slot: (document.querySelector('.sk-slot.is-active .sk-slot-nm') || {}).textContent, ammo: (document.querySelector('.sk-ammo-wpn') || {}).textContent })`);
    t.check(hudNames.slot === 'MG-100' && /MG-100/.test(hudNames.ammo || '') && !/mg_m249|✖/.test(`${hudNames.slot} ${hudNames.ammo}`), 'HUD 슬롯·탄약 칸이 id가 아니라 MG-100 이름으로 보인다', hudNames);
    await sleep(300);
    await t.shot('mg-hip');
    // 사격: 누르는 동안 연사하고 쏜 만큼 탄이 준다(바닥을 보고 쏜다)
    await page.eval(`(() => { const s = __qa.ctx.player.state; s.pitch = -1.2; return true; })()`);
    await page.eval('__qa.clearLogs()');
    await clickFire(page, 36);
    await waitTicks(page, 2);
    const mgShots = await page.eval(`__qa.worldEvents.filter((e) => e.evt === 'fire')`);
    const mg1 = await page.eval(`__qa.arsenal.getAmmo('mg_m249')`);
    t.check(mgShots.length >= 8 && mgShots.every((e) => e.weaponId === 'mg_m249'), '기관총: 누르는 동안 연사한다(초당 12발쯤)', mgShots.length);
    t.check(100 - mg1.mag === mgShots.length, '기관총: 쏜 만큼 탄이 준다', { used: 100 - mg1.mag, fired: mgShots.length });
    await t.shot('mg-fire');
    // 조준: 이동 속도가 더 느려진다(70% × 60% = 42%)
    await waitIdle(page);
    await page.mouseDown(2);
    await page.waitFor('__qa.arsenal.getZoom().progress >= 1', 4000, { label: '기관총 조준' });
    await waitTicks(page, 4);
    const mgAds = await page.eval(`({ scale: __qa.ctx.player.state.speedScale, ads: __qa.visible('.sk-ads') })`);
    t.check(Math.abs(mgAds.scale - 0.42) < 0.01, '기관총: 조준하면 이동 속도가 42%로 더 느려진다', mgAds);
    await t.shot('mg-ads');
    await page.mouseUp(2);
    await page.waitFor('__qa.arsenal.getZoom().progress <= 0', 3000, { label: '기관총 조준 해제' });
    // 재장전: 급탄 덮개가 열리고 상자가 빠졌다 들어온다. 끝나면 탄창 100발, 예비는 쓴 만큼 준다
    await waitIdle(page);
    await page.press('KeyR');
    await page.waitFor('__qa.arsenal.getWeapon().state === "reload"', 3000, { label: '기관총 재장전 시작' });
    await sleep(Math.round(WEAPONS.mg_m249.reload * 1000 * 0.3));
    await t.shot('mg-reload');
    await waitIdle(page, 30000);
    const mg2 = await page.eval(`__qa.arsenal.getAmmo('mg_m249')`);
    t.check(mg2.mag === 100 && mg2.reserve === mgWant.reserve - (100 - mg1.mag), '기관총: 재장전으로 탄창이 100발로 차고 예비가 준다', mg2);
    // 칼로 바꾸면 빨라지고(칼 110%), 다시 기관총을 들면 느려진다
    await page.press('Digit3');
    await page.waitFor(`__qa.arsenal.getWeapon().id === 'ml_knife'`, 3000, { label: '칼 들기' });
    await waitIdle(page);
    const knifeScale = await page.eval('__qa.ctx.player.state.speedScale');
    t.check(Math.abs(knifeScale - WEAPONS.ml_knife.moveMul) < 1e-3, '기관총을 내려놓고 칼을 들면 이동이 다시 빨라진다', knifeScale);
    await page.press('Digit1');
    await page.waitFor(`__qa.arsenal.getWeapon().id === 'mg_m249'`, 3000, { label: '기관총 다시 들기' });
    await waitIdle(page);
    t.check(Math.abs((await page.eval('__qa.ctx.player.state.speedScale')) - 0.7) < 1e-3, '다시 기관총을 들면 70%로 느려진다');
    // 동료가 버린 기관총(바닥 총)도 좀비 모드의 월드는 받는다(팀전 월드는 받지 않는다: swap 시나리오)
    const mgDrop = await page.eval(`(() => { const w = __qa.world; const d = w.addDrop({ id: 'qa#mg', weaponId: 'mg_m249', pos: [...__qa.ctx.player.state.pos], mag: 10, reserve: 10 }); w.removeDrop('qa#mg'); return !!d; })()`);
    t.check(mgDrop, '좀비 모드의 월드는 바닥에 놓인 기관총을 받는다', mgDrop);
    t.errorsOk('기관총');
    // 이어지는 시험을 위해 RX-4로 돌아온다
    await page.press('KeyN');
    await page.waitFor(`__qa.ui.isVisible('loadout')`, 3000, { label: '무기 목록(RX-4로)' });
    await page.clickText('.sk-loadout .sk-lo-card .sk-lo-name', WEAPONS.ar_std.name);
    await page.waitFor(`!__qa.ui.isVisible('loadout') && __qa.arsenal.getLoadout().primary === 'ar_std'`, 3000, { label: 'RX-4로 돌아옴(기관총 뒤)' });
    await waitIdle(page);

    t.setSection('1스테이지: 좀비가 다가오고 내 사격이 맞는다');
    await page.eval(`(() => { const S = __qa.run.director.internals.S; S.phaseEnd = S.clock; return true; })()`);   // 시험용: 준비를 바로 끝낸다
    await page.waitFor(`__qa.run.phase === 'wave'`, 10000, { label: '1스테이지' });
    await page.waitFor(`!__qa.visible('.sk-swap')`, 3000, { label: '교체 안내가 사라진다' }).then(
      () => t.check(true, '1스테이지가 시작되면 무기 교체 안내가 사라진다'), (err) => t.check(false, '1스테이지가 시작되면 무기 교체 안내가 사라진다', err.message));
    await page.press('KeyN');
    await sleep(400);
    t.check(!(await page.eval(`__qa.ui.isVisible('loadout')`)), '스테이지 중에는 N을 눌러도 무기 목록이 열리지 않는다(무기는 준비 시간에만)');
    await page.waitFor(`__qa.world.horde.count >= 3`, 20000, { label: '좀비가 그려진다' });
    s = await page.eval(HUD);
    t.check(s.stage === '1' && /남은 좀비 \d+/.test(s.line), 'HUD: 스테이지 1 · 남은 좀비', s);
    const secs = Number((/⏱ (\d+)초/.exec(s.time) || [])[1]);
    t.check(secs > 20 && secs <= HORDE.stageMs / 1000, `HUD: 스테이지 남은 시간(${HORDE.stageMs / 1000}초에서 준다)`, s.time);
    const gateCheck = await page.eval(`(() => { const d = __qa.run.director; const g = d.internals.gates; return { gates: g.length, map: __qa.run.opts.mapId }; })()`);
    t.check(gateCheck.gates === 6 && gateCheck.map === 'restarea', '좀비 전용 맵의 좀비 문 여섯 곳을 쓴다', gateCheck);
    await lockPointer(page);
    // 가장 가까운 좀비를 보며 기다린다(다가오는 모습)
    const dist0 = await page.eval(`(() => { const p = __qa.ctx.player.state.pos; return Math.min(...__qa.world.horde.rendered.map((z) => Math.hypot(z.x - p[0], z.z - p[2]))); })()`);
    await sleep(3500);
    const dist1 = await page.eval(`(() => { const p = __qa.ctx.player.state.pos; return Math.min(...__qa.world.horde.rendered.map((z) => Math.hypot(z.x - p[0], z.z - p[2]))); })()`);
    t.check(dist1 < dist0 - 1, '좀비가 나에게 다가온다', { dist0, dist1 });
    // 벽 뒤 좀비를 겨누지 않게, 좀비 하나를 내 앞 7 m로 옮겨 세운다(시험용). 나머지는 멈춘다
    await page.eval(FREEZE);
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
    await page.waitFor(`__qa.world.horde.rendered.some((z) => z.id === __qa.ZID && !z.rising && Math.hypot(z.x - __qa.ctx.player.state.pos[0], z.z - __qa.ctx.player.state.pos[2]) < 8)`, 5000, { label: '앞에 세운 좀비가 그려진다' });
    await waitTicks(page, 10);
    const AIM = `(() => {
      const z = __qa.world.horde.rendered.find((q) => q.id === __qa.ZID);
      if (!z) return null;
      const pt = [z.x, z.y + 1.2 * z.s, z.z];
      const r = __qa.aimAt(pt);
      const eye = __qa.ctx.player.getEye();
      const d = [pt[0] - eye[0], pt[1] - eye[1], pt[2] - eye[2]];
      const hits = __qa.world.horde.ray([eye[0], eye[1], eye[2]], d, 200, 1);
      return { id: z.id, hits, world: r.kind, hp: (__qa.run.director.internals.zombies.get(z.id) || {}).hp };
    })()`;
    const aim = await page.eval(AIM);
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
    t.errorsOk('1스테이지');

    t.setSection('팀 레벨 업 → 증강 3장(혼자는 게임이 멈춘다) · 입력 잠금 · 다시 뽑기 · [확인]');
    // 경험치를 한 칸 앞에 두고 내 총으로 그 좀비를 쓰러뜨린다(실제 처치 → 경험치 → 레벨 업 → 증강 제안)
    await page.eval(CARD_LOG);
    await page.eval(`(() => { const d = __qa.run.director, S = d.internals.S; S.level = 1; S.xp = ${xpNeed(1) - 1}; const Z = d.internals.zombies.get(__qa.ZID); if (Z) Z.hp = 1; return true; })()`);
    await page.eval(AIM);
    await clickFire(page, 3);
    // 카드가 뜬 바로 그때의 가운데 카드 자리(커서가 놓이는 곳)를 한 번에 받는다
    const early = JSON.parse(await page.waitFor(CARD_MID, 15000, { intervalMs: 30, label: '카드 화면' }));
    if (early.since < 500) {
      // 쏘던 손: 잠긴 동안 가운데 카드를 누르고(떼기는 잠금이 풀린 뒤) 무기 교체 1도 누른다. 풀린 뒤에는 점프 Space를 누른다
      await page.mouseMove(early.x, early.y);
      await page.mouseDown(0);
      await page.press('Digit1');
      await page.waitFor(`!document.querySelector('.sk-cards').classList.contains('is-arming')`, 5000, { intervalMs: 30, label: '카드 잠금 풀림' });
      await sleep(150);
      await page.mouseUp(0);
      await page.press('Space');
      await waitTicks(page, 4);
      const held = await page.eval(`({ visible: __qa.ui.isVisible('cards'), picked: ${ME}.cards.length, selected: document.querySelectorAll('.sk-cd-card.is-selected').length,
        down: __qa.cardLog.downs[0], focus: document.activeElement ? String(document.activeElement.className) : '' })`);
      t.check(typeof held.down === 'number' && held.down < CARD_ARM_MS, '가운데 카드를 잠금 중에 눌렀다(카드가 뜬 뒤 ms)', held.down);
      t.check(held.visible && held.picked === 0 && held.selected === 0, '잠긴 동안 누른 클릭(풀린 뒤 뗌)·숫자 키 1, 풀린 뒤의 Space는 카드를 고르지도 선택하지도 않는다', held);
      t.check(!/sk-cd-card/.test(held.focus), '눌린 카드도 포커스를 가져가지 않는다(점프 Space·Enter로 눌리지 않게)', held.focus);
    } else t.note(`카드가 뜬 뒤 ${Math.round(early.since)} ms가 지나서야 화면을 읽어 잠금 중 누르기 시험을 건너뛴다(느린 화면)`);
    await page.waitFor(`!document.querySelector('.sk-cards').classList.contains('is-arming')`, 5000, { label: '카드 잠금 풀림' });
    const offer = await page.eval(`({ ...${CARD_STATE}, locked: __qa.ctx.input.locked, phase: __qa.run.director.phase, level: __qa.run.director.internals.S.level })`);
    t.check(offer.cards.length === 3, '카드 3장이 뜬다', offer);
    t.check(offer.phase === 'cards' && offer.level === 2 && /레벨 업! Lv 2/.test(offer.title), '내 처치로 팀 경험치가 차서 레벨 2 증강 제안(스테이지를 깰 때가 아니다)', offer);
    t.check(/다시 뽑기 \(1\)/.test(offer.reroll) && /R 길게/.test(offer.wait), '다시 뽑기 1번 · R 길게 누르기 안내', offer);
    t.check(/\[확인\]/.test(offer.sub) && /고르는 동안 게임이 멈춰 있어요/.test(offer.sub) && !offer.timer && !offer.locked, '안내(누르고 확인 · 게임 멈춤) · 시간 제한 없음 · 커서', offer);
    t.check(offer.selected === 0 && offer.confirmOff, '아직 고른 카드가 없으면 [확인]은 꺼져 있다', offer);
    const banner = await page.waitFor(`/레벨 업! Lv 2/.test(__qa.text('.sk-hud-banner-title') || '')`, 3000, { label: '레벨 업 알림' }).then(() => true, () => false);
    t.check(banner, '레벨 업 알림(⭐ 레벨 업! Lv 2)이 뜬다');
    // 혼자 하는 판은 고르는 동안 멈춘다: 시계·스테이지 남은 시간·좀비가 그대로
    const pause0 = await page.eval(`({ clock: __qa.run.director.internals.S.clock, left: __qa.run.director.internals.S.stageEnd - __qa.run.director.internals.S.clock, time: __qa.text('.sk-hz-time'), line: __qa.text('.sk-hz-line') })`);
    await sleep(1200);
    const pause1 = await page.eval(`({ clock: __qa.run.director.internals.S.clock, phase: __qa.run.director.phase, time: __qa.text('.sk-hz-time'), line: __qa.text('.sk-hz-line') })`);
    t.check(pause1.phase === 'cards' && pause1.clock === pause0.clock && pause1.time === pause0.time, '고르는 동안 방장 시계와 스테이지 남은 시간이 멈춘다', { pause0, pause1 });
    t.check(/증강 고르는 중\(게임 멈춤\)/.test(pause1.line), 'HUD: 레벨 업 · 증강 고르는 중(게임 멈춤)', pause1.line);
    await t.shot('cards');
    // R을 짧게 누르면(재장전 버릇) 다시 뽑지 않는다. 길게 누르면 다시 뽑는다
    await page.press('KeyR');
    await sleep(REROLL_HOLD_MS + 400);
    const tap = await page.eval(`({ cards: [...document.querySelectorAll('.sk-cd-card .sk-cd-name')].map((e) => e.textContent), reroll: __qa.text('.sk-cd-reroll') })`);
    t.check(tap.cards.join() === offer.cards.join() && /\(1\)/.test(tap.reroll), 'R을 짧게 누르면(재장전) 다시 뽑지 않는다', tap);
    await page.press('KeyR', { holdMs: REROLL_HOLD_MS + 700 });
    await page.waitFor(`[...document.querySelectorAll('.sk-cd-card .sk-cd-name')].map((e) => e.textContent).join() !== ${JSON.stringify(offer.cards.join())}`, 5000, { label: '다시 뽑은 카드' });
    const re = await page.eval(`({ cards: [...document.querySelectorAll('.sk-cd-card .sk-cd-name')].map((e) => e.textContent), reroll: __qa.text('.sk-cd-reroll'), off: document.querySelector('.sk-cd-reroll').disabled })`);
    t.check(re.cards.length === 3 && re.cards.every((c) => !offer.cards.includes(c)), 'R을 길게 누르면 다른 카드 3장', re);
    t.check(re.off && /\(0\)/.test(re.reroll), '다시 뽑기는 한 번뿐', re);
    // 다시 뽑은 카드도 잠깐 잠긴다 → 풀린 뒤 카드를 눌러 선택하고 [확인]으로 정한다
    await page.waitFor(`!document.querySelector('.sk-cards').classList.contains('is-arming')`, 5000, { label: '다시 뽑은 카드 잠금 풀림' });
    const before = await page.eval(`({ mods: __qa.arsenal.getMods(), perk: { ...__qa.world.internals.hordePerk } })`);
    let pickAt = re.cards.findIndex((c, i) => i >= 1 && !SHAKY_CARD.test(c));
    if (pickAt < 0) pickAt = re.cards.findIndex((c) => !SHAKY_CARD.test(c));
    if (pickAt < 0) { pickAt = 1; t.note(`뒤 시험을 흔들 수 있는 카드만 나왔다: ${re.cards.join(', ')}`); }
    await page.clickText('.sk-cd-card .sk-cd-name', re.cards[pickAt]);
    await page.waitFor(`document.querySelectorAll('.sk-cd-card')[${pickAt}].classList.contains('is-selected')`, 3000, { label: '카드 선택' });
    const sel = await page.eval(`({ ...${CARD_STATE}, visible: __qa.ui.isVisible('cards'), picked: ${ME}.cards.length })`);
    t.check(sel.visible && sel.picked === 0 && sel.selected === 1, '카드를 누르면 선택만 된다(아직 정해지지 않는다)', sel);
    t.check(!sel.confirmOff && sel.confirm.includes(re.cards[pickAt]), '[확인] 단추에 고른 카드 이름이 붙고 켜진다', sel);
    await page.click('.sk-cd-confirm');
    await page.waitFor(`!__qa.ui.isVisible('cards')`, 5000, { label: '카드 닫힘' });
    await page.waitFor(`${ME}.cards.length === 1 && __qa.run.director.phase === 'wave'`, 5000, { label: '카드 반영' });
    const after = await page.eval(`({ cards: ${ME}.cards, mods: __qa.arsenal.getMods(), perk: { ...__qa.world.internals.hordePerk }, locked: __qa.ctx.input.locked,
      invuln: ${ME}.invulnUntil - __qa.run.director.internals.S.clock })`);
    t.check(after.cards.length === 1, '[확인]을 누르면 고른 카드가 내 카드가 되고 게임이 다시 돈다', after);
    t.check(after.locked, '확인 클릭으로 포인터가 다시 잠긴다', after);
    t.check(after.invuln > HORDE.pickInvulnMs - 1000 && after.invuln <= HORDE.pickInvulnMs, `고른 직후 ${HORDE.pickInvulnMs / 1000}초 무적(방장)`, after.invuln);
    await page.waitFor(`/무적/.test(__qa.text('.sk-hz-warn') || '')`, 2000, { label: '무적 표시' }).then(
      () => t.check(true, 'HUD에 고른 뒤 무적 표시'), (err) => t.check(false, 'HUD에 고른 뒤 무적 표시', err.message));
    t.note(`고른 카드 ${re.cards[pickAt]} · 배율 ${JSON.stringify(before.mods)} → ${JSON.stringify(after.mods)} · 이동 ${before.perk.speed} → ${after.perk.speed}`);
    if (await page.eval(`__qa.ui.isVisible('loadout')`)) { await page.press('KeyN'); await sleep(300); }   // 교체권이었다면 목록을 닫는다
    t.errorsOk('레벨 업 증강');

    t.setSection('40초가 지나면 남은 좀비를 둔 채 다음 스테이지');
    await ensureZombies(page, 2);
    const tu0 = await page.eval(`(() => { const d = __qa.run.director, S = d.internals.S; const ids = [...d.internals.zombies.values()].filter((Z) => Z.state !== 'dead').map((Z) => Z.id); S.stageEnd = S.clock + 400; return { stage: S.stage, ids }; })()`);
    await page.waitFor(`__qa.run.director.stage === ${tu0.stage + 1} && __qa.run.director.phase === 'wave'`, 6000, { label: '시간이 다 돼 다음 스테이지' });
    const tu1 = await page.eval(`({ ids: [...__qa.run.director.internals.zombies.values()].filter((Z) => Z.state !== 'dead').map((Z) => Z.id), left: __qa.run.director.internals.S.stageEnd - __qa.run.director.internals.S.clock })`);
    t.check(tu0.ids.length >= 2 && tu0.ids.every((id) => tu1.ids.includes(id)), '살아 있던 좀비는 그대로 남아 다음 스테이지와 이어진다', { before: tu0.ids, after: tu1.ids });
    t.check(tu1.left > HORDE.stageMs - 2000, '새 스테이지 시간은 다시 40초', tu1.left);
    await page.waitFor(`[...document.querySelectorAll('.sk-callout')].some((e) => /시간 끝 · 남은 좀비 \\d+마리와 다음 스테이지/.test(e.textContent))`, 3000, { label: '시간 끝 알림' }).then(
      () => t.check(true, '시간 끝 알림(남은 좀비와 다음 스테이지)'), async (err) => t.check(false, '시간 끝 알림(남은 좀비와 다음 스테이지)', { err: err.message, callouts: await callouts(page) }));
    s = await page.eval(HUD);
    t.check(s.stage === String(tu0.stage + 1), 'HUD 스테이지 번호가 오른다', s);
    await t.shot('timeup');
    t.errorsOk('스테이지 시간 끝');

    t.setSection('C4 수류탄: 좀비에 붙어 따라가다 터진다');
    await page.eval(FREEZE);
    await page.eval(`(() => { __qa.run.director.internals.S.xp = 0; return true; })()`);   // 이 뒤 시험의 처치로 레벨이 올라 멈추지 않게
    const nade0 = await page.eval(`({ ammo: __qa.arsenal.getAmmo('gr_frag'), nades: ${ME}.perks.nades })`);
    const gave = await page.fn(giveCard, 'c4');
    t.check(gave.ok && gave.perks.stickyNade === 1 && gave.perks.nades === nade0.nades + 2, 'C4 증강: 붙는 수류탄 + 최대 수류탄 +2(방장 능력치)', { gave, before: nade0 });
    await page.waitFor(`__qa.world.internals.hordePerk.sticky === true`, 3000, { label: '내 화면에 C4 반영' });
    const nade = await page.eval(`__qa.arsenal.getAmmo('gr_frag')`);
    t.check(nade.magSize === nade0.ammo.magSize + 2, '수류탄 증강은 최대 수류탄을 2개 늘린다', { before: nade0.ammo, after: nade });
    t.check(nade.mag === nade.magSize, '수류탄 증강을 고르면 수류탄을 새 최대까지 가득 채운다', { before: nade0.ammo, after: nade });
    const lane = await page.fn(findLane, { len: 16 });
    t.check(!!lane, '시험할 곧은 길(16 m)을 찾는다', lane);
    if (!lane) throw new Error('시험할 길을 찾지 못했어요');
    t.log(`   길: ${JSON.stringify(lane)}`);
    await page.fn(standOnLane, lane);
    await ensureZombies(page, 1);
    const [cz] = await page.fn(placeOnLane, { lane, spots: [{ dist: 4.5 }] });
    await waitPlaced(page, [cz]);
    await waitTicks(page, 6);
    if (!(nade.mag > 0)) { t.note('던질 수류탄이 없어 한 개를 넣고 C4 시험을 잇는다'); await page.eval('__qa.arsenal.giveGrenade(1)'); }
    await lockPointer(page);
    await page.press('Digit4');
    await page.waitFor(`__qa.arsenal.getWeapon().id === 'gr_frag' && __qa.arsenal.getWeapon().state === 'idle'`, 5000, { label: '수류탄 꺼냄' });
    const czHp = await page.eval(`(__qa.run.director.internals.zombies.get(${cz}) || {}).hp`);
    await page.eval(`(() => { const z = __qa.world.horde.zombieAt(${cz}); __qa.aimAt([z.x, z.y + 1.0 * z.s, z.z]); return true; })()`);
    await page.eval('__qa.clearLogs()');
    await clickFire(page, 3);
    const thrown = JSON.parse(await page.waitFor(`(() => { const g = __qa.world.internals.nades.list().find((x) => x.owner === __qa.world.localId); return g ? JSON.stringify(g) : false; })()`, 3000, { intervalMs: 30, label: '던진 수류탄' }));
    t.check(thrown.kind === 'c4', '던진 수류탄은 C4다', thrown);
    t.check(await page.eval(`__qa.worldEvents.some((e) => e.evt === 'grenade' && e.kind === 'c4')`), '던지기 알림(grenade)도 kind c4로 나간다(다른 화면에서도 붙는다)');
    const stuck = JSON.parse(await page.waitFor(`(() => {
      const g = __qa.world.internals.nades.list().find((x) => x.id === ${JSON.stringify(thrown.id)});
      if (!g) return JSON.stringify({ gone: true });
      if (!g.stuck) return false;
      const s = __qa.world.internals.c4Stuck.get(g.id), z = s ? __qa.world.horde.zombieAt(s.zid) : null;
      return JSON.stringify({ pos: g.pos, age: g.age, zid: s && s.zid, off: s ? { x: s.x, y: s.y, z: s.z } : null, z: z ? { x: z.x, y: z.y, z: z.z, yaw: z.yaw, s: z.s } : null });
    })()`, 3000, { intervalMs: 20, label: 'C4가 좀비에 붙음' }));
    t.check(!stuck.gone && stuck.zid === cz, 'C4가 닿은 좀비에 붙는다', stuck);
    if (stuck.z) {
      const axis = Math.hypot(stuck.pos[0] - stuck.z.x, stuck.pos[2] - stuck.z.z);
      t.check(axis < 0.45 && Math.abs(stuck.pos[1] - stuck.z.y - 1.1 * stuck.z.s) < 0.15, 'C4는 좀비 가슴 높이의 몸 겉면에 붙는다', { axis, h: stuck.pos[1] - stuck.z.y });
    }
    // 좀비를 옆으로 가까이 옮긴다(방장 시뮬레이션) → 붙은 C4가 따라온다
    await page.fn(placeOnLane, { lane, ids: [cz], spots: [{ dist: 2.0, side: 0.5 }] });
    await waitPlaced(page, [cz], 3000);
    await waitTicks(page, 3);
    const follow = await page.eval(`(() => {
      const g = __qa.world.internals.nades.list().find((x) => x.id === ${JSON.stringify(thrown.id)});
      const s = __qa.world.internals.c4Stuck.get(${JSON.stringify(thrown.id)}), z = __qa.world.horde.zombieAt(${cz});
      return g && z ? { pos: g.pos, stuck: g.stuck, age: g.age, z: { x: z.x, y: z.y, z: z.z, yaw: z.yaw, s: z.s }, off: s ? { x: s.x, y: s.y, z: s.z } : null } : null;
    })()`);
    if (follow && follow.off) {
      const want = c4WorldPos(follow.z, follow.off);
      const err = Math.hypot(want[0] - follow.pos[0], want[1] - follow.pos[1], want[2] - follow.pos[2]);
      const moved = Math.hypot(follow.pos[0] - stuck.pos[0], follow.pos[2] - stuck.pos[2]);
      t.check(follow.stuck && err < 0.05 && moved > 1.5, '좀비가 움직이면 붙은 C4가 그 몸에 붙은 채 따라간다', { err, moved, follow });
    } else t.check(false, '좀비가 움직이면 붙은 C4가 따라간다', follow);
    // 사진: C4가 크로스헤어 바로 아래에 오게 조금 위를 본다
    await page.eval(`(() => { const g = __qa.world.internals.nades.list().find((x) => x.id === ${JSON.stringify(thrown.id)}); if (g) __qa.aimAt([g.pos[0], g.pos[1] + 0.2, g.pos[2]]); return true; })()`);
    await waitTicks(page, 2);
    await t.shot('c4-stuck');
    await page.waitFor(`!__qa.world.internals.nades.list().some((x) => x.id === ${JSON.stringify(thrown.id)})`, 4000, { intervalMs: 50, label: 'C4가 터짐' });
    await waitTicks(page, 4);
    const boom = await page.eval(`(() => {
      const e = __qa.worldEvents.find((x) => x.evt === 'explosion' && x.grenadeId === ${JSON.stringify(thrown.id)});
      const Z = __qa.run.director.internals.zombies.get(${cz});
      return { e: e ? { kind: e.kind, pos: e.pos, local: e.local } : null, dead: !Z || Z.state === 'dead', hp: Z ? Z.hp : 0 };
    })()`);
    t.check(boom.e && boom.e.kind === 'c4' && boom.e.local, '붙은 C4가 신관이 다 되면 터진다(내 폭발 · kind c4)', boom);
    if (boom.e && follow) t.check(Math.hypot(boom.e.pos[0] - follow.z.x, boom.e.pos[2] - follow.z.z) < 0.6, '옮겨 간 좀비 몸에서 터진다', { at: boom.e.pos, zombie: follow.z });
    t.check(boom.dead || boom.hp < czHp, '붙은 좀비가 폭발 피해를 받는다(방장)', { before: czHp, after: boom });
    t.errorsOk('C4 수류탄');

    t.setSection('검기: 칼을 휘두르면 초승달이 날아가 4~8 m 좀비를 벤다');
    await page.eval(FREEZE);
    const gw = await page.fn(giveCard, 'wave3');
    t.check(gw.ok && gw.perks.wave === 10, '검기 III: 검기 10 m(방장 능력치)', gw);
    await page.waitFor(`__qa.world.internals.hordePerk.waveRange === 10`, 3000, { label: '내 화면에 검기 반영' });
    await page.fn(standOnLane, lane);
    await ensureZombies(page, 4);
    // 4 · 6 · 8 m는 닿고 14 m는 검기 거리(10 m) 밖이다
    const wz = await page.fn(placeOnLane, { lane, spots: [{ dist: 4 }, { dist: 6 }, { dist: 8 }, { dist: 14 }] });
    t.check(wz.length === 4, '좀비 넷을 길 위 4·6·8·14 m에 세운다', wz);
    await waitPlaced(page, wz);
    await lockPointer(page);
    await page.press('Digit3');
    await page.waitFor(`__qa.arsenal.getWeapon().slot === 3`, 3000, { label: '칼 꺼냄' });
    await waitIdle(page);
    await page.fn(standOnLane, lane);   // 정면(길 방향), 수평으로 본다
    await waitTicks(page, 6);
    const melee = await page.eval(`__qa.arsenal.getLoadout().melee`);
    // 좀비 체력과 내 능력치(레벨 업에서 고른 카드 포함). 기대 피해는 방장과 같은 공식으로 계산한다
    const ZST = `${JSON.stringify(wz)}.map((id) => { const Z = __qa.run.director.internals.zombies.get(id); return Z && Z.state !== 'dead' ? { hp: Z.hp, maxHp: Z.maxHp } : { hp: 0, maxHp: 1 }; })`;
    const MYST = `({ perks: { ...${ME}.perks }, frac: ${ME}.hp / Math.max(1, ${ME}.maxHp) })`;
    const zs0 = await page.eval(ZST), my0 = await page.eval(MYST);
    await page.eval('__qa.clearLogs()');
    await page.eval(COUNT_NUMBERS);
    await clickFire(page, 2);
    await page.waitFor(`__qa.world.horde.stats.waves > 0`, 3000, { intervalMs: 15, label: '검기가 날아간다' });
    // 사진: 검기는 0.4초 만에 지나가므로, 2~3 m쯤 날았을 때 World를 잠깐 멈춰(검기는 그 자리에 그려진다) 찍고 다시 돌린다
    await sleep(60);
    await page.eval('__qa.world.setPaused(true)');
    await t.shot('wave-crescent');
    const crescent = (await page.eval(`__qa.world.horde.stats.waves`)) > 0;
    await page.eval('__qa.world.setPaused(false)');
    if (!crescent) t.note('검기 사진: 멈추기 전에 검기가 사라졌다(사진을 눈으로 확인)');
    await page.waitFor(`__qa.worldEvents.filter((e) => e.evt === 'hitClaim' && e.kind === 'wave').length >= 3`, 3000, { label: '검기 주장 셋' }).catch(() => {});
    await waitTicks(page, 10);
    const wv = await page.eval(`({ claims: __qa.worldEvents.filter((e) => e.evt === 'hitClaim' && (e.kind === 'wave' || e.kind === 'waveStab')).map((e) => ({ id: e.victimId, kind: e.kind, dist: e.dist, shot: e.shotId, weapon: e.weaponId })),
      zs: ${ZST}, numbers: __qa.world.internals.horde.__dn.slice() })`);
    const near = wz.slice(0, 3).map((id) => 'z' + id);
    t.check(wv.claims.length === 3 && near.every((id) => wv.claims.some((c) => c.id === id && c.kind === 'wave')), '검기가 4·6·8 m 좀비 셋에 닿아 주장(kind wave)이 나간다', wv.claims);
    t.check(!wv.claims.some((c) => c.id === 'z' + wz[3]), '검기 거리(10 m) 밖 14 m 좀비는 맞지 않는다', wv.claims);
    t.check(new Set(wv.claims.map((c) => c.shot)).size === 1 && wv.claims.every((c) => c.weapon === melee), '검기 하나는 shotId 하나 · 칼 무기로 주장', wv.claims);
    t.check(wv.claims.every((c) => { const i = near.indexOf(c.id); return i >= 0 && c.dist > [4, 6, 8][i] - 1.5 && c.dist < [4, 6, 8][i]; }), '주장 거리 = 검기가 날아간 거리(좀비 앞 겉면)', wv.claims);
    const slashWant = [0, 1, 2].map((i) => expectedHit(my0.perks, melee, 'wave', zs0[i], my0.frac));
    t.check([0, 1, 2].every((i) => slashWant[i].includes(zs0[i].hp - wv.zs[i].hp)) && wv.zs[3].hp === zs0[3].hp,
      `방장: 셋 모두 칼 베기와 같은 피해(${WEAPONS[melee].melee.slash.damage} · 칼 증강 포함), 14 m 좀비는 그대로`, { before: zs0, after: wv.zs, want: slashWant });
    const nums = wv.numbers.filter((n) => n.kind === 'melee').map((n) => n.amount).sort((a, b) => a - b);
    t.check(nums.length === 3 && nums.join() === slashWant.map((w) => w[0]).sort((a, b) => a - b).join(), '맞은 좀비마다 칼 피해 숫자(하늘색)가 하나씩 뜬다', { numbers: wv.numbers, want: slashWant });
    // 찌르기(우클릭)도 검기를 날린다: kind waveStab, 찌르기 피해
    await waitIdle(page);
    await page.fn(standOnLane, lane);
    await waitTicks(page, 3);
    await page.eval('__qa.clearLogs()');
    const zs1 = await page.eval(ZST), my1 = await page.eval(MYST);
    await clickFire(page, 3, 2);
    await page.waitFor(`__qa.worldEvents.filter((e) => e.evt === 'hitClaim' && e.kind === 'waveStab').length >= 3`, 3000, { label: '찌르기 검기 주장 셋' }).catch(() => {});
    await waitTicks(page, 10);
    const ws = await page.eval(`({ claims: __qa.worldEvents.filter((e) => e.evt === 'hitClaim' && String(e.kind).startsWith('wave')).map((e) => ({ id: e.victimId, kind: e.kind })), zs: ${ZST} })`);
    t.check(ws.claims.length === 3 && ws.claims.every((c) => c.kind === 'waveStab'), '찌르기도 검기를 날린다(kind waveStab)', ws.claims);
    const stabWant = [0, 1, 2].map((i) => expectedHit(my1.perks, melee, 'waveStab', zs1[i], my1.frac).map((v) => Math.min(zs1[i].hp, v)));
    t.check([0, 1, 2].every((i) => stabWant[i].includes(zs1[i].hp - ws.zs[i].hp)), `찌르기 검기는 찌르기 피해(${WEAPONS[melee].melee.stab.damage} · 칼 증강 포함)`, { before: zs1, after: ws.zs, want: stabWant });
    t.errorsOk('검기');

    t.setSection('밀려남: 좀비에게 맞으면 그 반대쪽으로 밀려난다 · 부동자세면 버틴다');
    const KNOCK = async (label) => {
      await page.eval(FREEZE);
      await page.fn(standOnLane, lane);
      await ensureZombies(page, 1);
      const [kz] = await page.fn(placeOnLane, { lane, spots: [{ dist: 1.15 }] });
      await waitPlaced(page, [kz]);
      await waitTicks(page, 8);
      const k0 = await page.eval(`(() => {
        const d = __qa.run.director, S = d.internals.S, P = ${ME}, Z = d.internals.zombies.get(${kz});
        P.invulnUntil = 0; P.hitUntil = 0; P.shield = 0; P.hp = P.maxHp;
        Z.attackReady = S.clock;
        return { pos: __qa.ctx.player.state.pos.slice(), hp: P.hp, seq: P.knockSeq, z: Z.body.pos.slice(), scale: Z.scale };
      })()`);
      // 맞은 순간(피하지 않고 들어간 공격)에 방장이 맞은 뒤 무적(hitUntil)을 건다
      await page.waitFor(`${ME}.hitUntil > 0`, 5000, { intervalMs: 30, label: `${label}: 좀비에게 맞음` });
      await page.eval(`(() => { const Z = __qa.run.director.internals.zombies.get(${kz}); if (Z) Z.attackReady = 1e12; return true; })()`);
      await sleep(800);
      const k1 = await page.eval(`({ pos: __qa.ctx.player.state.pos.slice(), seq: ${ME}.knockSeq, v: ${ME}.knockV, hp: ${ME}.hp })`);
      const dx = k1.pos[0] - k0.pos[0], dz = k1.pos[2] - k0.pos[2];
      const ux = k0.pos[0] - k0.z[0], uz = k0.pos[2] - k0.z[2], ul = Math.hypot(ux, uz) || 1;
      return { k0, k1, moved: Math.hypot(dx, dz), along: (dx * ux + dz * uz) / ul };
    };
    const kn = await KNOCK('밀려남');
    t.check(kn.k1.hp < kn.k0.hp, '좀비 공격이 들어가 체력이 준다', kn.k1);
    t.check(kn.k1.seq === kn.k0.seq + 1 && kn.k1.v && Math.abs(Math.hypot(kn.k1.v[0], kn.k1.v[2]) - HORDE.knockSpeed * Math.min(1.8, Math.max(0.8, kn.k0.scale))) < 0.05,
      `방장이 밀려남을 정한다(수평 ${HORDE.knockSpeed} m/s × 좀비 크기)`, kn.k1);
    t.check(kn.moved > 0.5 && kn.along > 0.85 * kn.moved, '내 화면의 몸이 좀비 반대쪽으로 밀려난다', { moved: kn.moved, along: kn.along });
    await t.shot('knock');
    const ga = await page.fn(giveCard, 'anchor');
    t.check(ga.ok && ga.perks.noKnock === 1, '부동자세 증강(방장 능력치)', ga);
    const an = await KNOCK('부동자세');
    t.check(an.k1.hp < an.k0.hp && an.k1.seq === an.k0.seq && an.moved < 0.15, '부동자세면 맞아도(체력은 준다) 밀려나지 않는다', { moved: an.moved, seq: [an.k0.seq, an.k1.seq], hp: [an.k0.hp, an.k1.hp] });
    t.errorsOk('밀려남');

    t.setSection('바닥 보급품: 탄창(예비 탄 · 수류탄 채움) · 구급 상자');
    await page.eval(FREEZE);
    await page.fn(placeOnLane, { lane, spots: [] });   // 좀비는 모두 좀비 문으로(사진이 가리지 않게)
    await page.fn(standOnLane, lane);
    await page.press('Digit1');
    await page.waitFor(`__qa.arsenal.getWeapon().slot === 1`, 3000, { label: '주무기' });
    // 예비 탄과 수류탄을 줄여 두고(시험용), 바로 옆에 탄창 하나, 4 m 앞에 탄창 하나를 떨어뜨린다
    await page.eval(`__qa.arsenal.equipWith('ar_std', { mag: 10, reserve: 20 })`);
    await page.eval(`__qa.arsenal.giveGrenade(-99)`);
    await page.eval(`(() => {
      const d = __qa.run.director, S = d.internals.S, p = __qa.ctx.player.state.pos, s = __qa.ctx.player.state;
      const f = [-Math.sin(s.yaw), -Math.cos(s.yaw)];
      const put = (kind, x, z) => { const id = S.nextLoot++; d.internals.loot.set(id, { id, kind, x, y: p[1], z, until: S.clock + 30000 }); return id; };
      __qa.LOOT_FAR = put('mag', p[0] + f[0] * 4, p[2] + f[1] * 4);
      __qa.LOOT_MAG = put('mag', p[0] + 0.4, p[2]);
      __qa.run.flush();
      return true;
    })()`);
    await page.waitFor(`!__qa.run.director.internals.loot.has(__qa.LOOT_MAG)`, 5000, { label: '탄창 주움' });
    await waitTicks(page, 3);
    const mag = await page.eval(`({ ammo: __qa.arsenal.getAmmo('ar_std'), nade: __qa.arsenal.getAmmo('gr_frag'), far: __qa.run.director.internals.loot.has(__qa.LOOT_FAR), drawn: __qa.world.horde.loot.map((L) => L.kind) })`);
    t.check(mag.ammo.reserve === 20 + WEAPONS.ar_std.mag, `닿은 탄창을 주워 든 총의 예비 탄이 탄창 하나(${WEAPONS.ar_std.mag}발)만큼 는다`, mag.ammo);
    t.check(mag.nade.mag === mag.nade.magSize && mag.nade.magSize >= 3, '탄창을 주우면 수류탄도 최대까지 채운다(0 → 최대)', mag.nade);
    await page.waitFor(`[...document.querySelectorAll('.sk-callout')].some((e) => /탄창 \\+\\d+발 · 💣 수류탄 가득/.test(e.textContent))`, 2000, { label: '탄창 알림' }).then(
      () => t.check(true, '알림: 탄창 +N발 · 수류탄 가득'), async (err) => t.check(false, '알림: 탄창 +N발 · 수류탄 가득', { err: err.message, callouts: await callouts(page) }));
    t.check(mag.far && mag.drawn.includes('mag'), '닿지 않은 보급품은 그대로 바닥에 그려진다', mag);
    await t.shot('loot');
    await page.eval(`(() => { __qa.run.director.internals.loot.delete(__qa.LOOT_FAR); return true; })()`);
    // 칼을 든 채 주운 탄창은 주무기에 들어간다(수류탄이 가득하면 수류탄 알림은 없다)
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
    const medBase = await page.eval(`(() => {
      const d = __qa.run.director, S = d.internals.S, p = __qa.ctx.player.state.pos, P = ${ME};
      P.hp = 40;
      const id = S.nextLoot++; d.internals.loot.set(id, { id, kind: 'med', x: p[0] - 0.3, y: p[1], z: p[2], until: S.clock + 30000 });
      __qa.LOOT_MED = id;
      __qa.run.flush();
      return { heal: d.rules.medHeal + (P.perks.medHeal || 0), max: P.maxHp };
    })()`);
    await page.waitFor(`!__qa.run.director.internals.loot.has(__qa.LOOT_MED)`, 5000, { label: '구급 상자 주움' });
    await waitTicks(page, 4);
    const hp = await page.eval(`({ sim: ${ME}.hp, local: __qa.ctx.player.state.hp })`);
    const wantHp = Math.min(medBase.max, 40 + medBase.heal);
    t.check(medBase.heal === HORDE.medHeal && hp.sim === wantHp && hp.local === wantHp, `구급 상자는 체력을 ${HORDE.medHeal} 채운다(방장 확정 → 내 화면)`, { hp, wantHp });
    t.errorsOk('보급품');

    t.setSection('다 잡으면 남은 시간 경험치를 받고 쉬지 않고 다음 스테이지');
    // 처치 경험치로 레벨이 올라 증강 고르기로 멈추지 않게 이 시험 동안만 레벨을 높여 둔다(시험용)
    const cl0 = await page.eval(`(() => { const d = __qa.run.director, S = d.internals.S, P = ${ME}; const level = S.level, xp = S.xp; S.level = 50; S.xp = 0; P.hp = Math.round(P.maxHp / 2); S.stageEnd = S.clock + d.rules.stageMs;
      return { stage: S.stage, hp: P.hp, maxHp: P.maxHp, xpTotal: S.xpTotal, level, xp }; })()`);
    const killed = await page.eval(KILL_ALL);
    t.check(killed >= 1, '남은 좀비를 쓰러뜨린다(시험용)', killed);
    await page.waitFor(`__qa.run.director.stage === ${cl0.stage + 1}`, 6000, { label: '다음 스테이지' });
    const cl1 = await page.eval(`({ phase: __qa.run.director.phase, hp: ${ME}.hp, xpTotal: __qa.run.director.internals.S.xpTotal })`);
    t.check(cl1.phase === 'wave', '스테이지를 깨면 쉬는 시간 없이 바로 다음 스테이지(카드 화면 없음)', cl1);
    t.check(Math.abs(cl1.hp - Math.min(cl0.maxHp, cl0.hp + cl0.maxHp * HORDE.clearHealFrac)) < 1, '시간 안에 깨면 최대 체력의 25% 회복', { before: cl0.hp, after: cl1.hp, max: cl0.maxHp });
    const bonus = cl1.xpTotal - cl0.xpTotal - killed;
    t.check(bonus >= 15 && bonus <= HORDE.stageMs / HORDE.timeXpMs, '남은 시간 2초당 경험치 1(처치 경험치 따로)', { bonus, killed });
    await page.eval(`(() => { const S = __qa.run.director.internals.S; S.level = ${cl0.level}; S.xp = ${cl0.xp}; return true; })()`);   // 시험용 레벨을 되돌린다
    await page.waitFor(`[...document.querySelectorAll('.sk-callout')].some((e) => /스테이지 클리어! · 남은 시간 경험치 \\+\\d+ · 체력 25% 회복/.test(e.textContent))`, 3000, { label: '클리어 알림' }).then(
      () => t.check(true, '클리어 알림(남은 시간 경험치 · 체력 25% 회복)'), async (err) => t.check(false, '클리어 알림(남은 시간 경험치 · 체력 25% 회복)', { err: err.message, callouts: await callouts(page) }));
    await t.shot('stage-clear');
    t.errorsOk('스테이지 클리어');

    t.setSection('3스테이지 보스: 체력 막대 · 스킬 예고 · 보물 상자');
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
    // 보스를 쓰러뜨리면 보물 상자를 떨어뜨린다. 주우면 증강 하나(첫 장은 영웅 이상). 처치 경험치의 레벨 업은 이 시험 동안 막는다(시험용)
    await page.eval(FREEZE);
    const bd = await page.eval(`(() => {
      const d = __qa.run.director, me = __qa.world.localId; d.internals.S.level = 50;
      const B = [...d.internals.zombies.values()].find((Z) => Z.boss && Z.state !== 'dead');
      if (!B) return null;
      const ev = []; let shot = 700000, g = 0;
      while (B.state !== 'dead' && g++ < 400) ev.push(...d.claimHit({ attackerId: me, victimId: 'z' + B.id, weaponId: 'sr_heavy', part: 'body', dist: 5, kind: 'shot', count: 1, shotId: ++shot }));
      const chest = [...d.internals.loot.values()].find((L) => L.kind === 'chest');
      d.internals.S.level = 1; d.internals.S.xp = 0;   // 시험용 레벨을 되돌린다(더 잡지 않으므로 레벨이 오르지 않는다)
      return { dead: B.state === 'dead', down: ev.some((e) => e.type === 'bossDown'), at: B.body.pos.slice(), chest: chest ? { id: chest.id, x: chest.x, y: chest.y, z: chest.z, left: chest.until - d.internals.S.clock } : null };
    })()`);
    t.check(bd && bd.dead && bd.down, '보스를 쓰러뜨린다(시험용)', bd);
    t.check(bd && bd.chest && Math.hypot(bd.chest.x - bd.at[0], bd.chest.z - bd.at[2]) < 0.5 && bd.chest.left > HORDE.chestMs - 2000, `보스가 쓰러진 자리에 보물 상자(${HORDE.chestMs / 1000}초 동안)`, bd);
    if (bd && bd.chest) {
      await page.waitFor(`__qa.world.horde.loot.some((L) => L.kind === 'chest')`, 4000, { label: '보물 상자가 그려진다' }).then(
        () => t.check(true, '화면에도 보물 상자가 그려진다'), (err) => t.check(false, '화면에도 보물 상자가 그려진다', err.message));
      await page.eval(`(() => { const c = ${JSON.stringify(bd.chest)}; __qa.teleport(c.x + 0.3, c.y + 0.3, c.z, __qa.ctx.player.state.yaw); return true; })()`);
      await page.waitFor(`__qa.ui.isVisible('cards')`, 6000, { label: '보물 상자 증강' }).then(
        () => t.check(true, '보물 상자를 주우면 증강 고르기가 뜬다'), (err) => t.check(false, '보물 상자를 주우면 증강 고르기가 뜬다', err.message));
      const ch = await page.eval(`({ ...${CARD_STATE}, phase: __qa.run.director.phase, loot: __qa.run.director.internals.loot.has(${bd.chest.id}), callouts: [...document.querySelectorAll('.sk-callout')].map((e) => e.textContent) })`);
      t.check(/보물 상자/.test(ch.title) && ch.cards.length >= 3 && (ch.tiers[0] === 'epic' || ch.tiers[0] === 'legend'), '보물 상자 제안: 첫 장은 영웅 이상', ch);
      t.check(!ch.loot && ch.phase === 'cards' && ch.callouts.some((x) => /보물 상자! · 증강 하나를 고르세요/.test(x)), '주운 상자는 바닥에서 사라지고 알림이 뜬다(혼자는 멈춤)', ch);
      await page.waitFor(`!document.querySelector('.sk-cards').classList.contains('is-arming')`, 5000, { label: '상자 카드 잠금 풀림' });
      await t.shot('chest');
    }
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
      gain: __qa.text('.sk-res-gain-num'), back: __qa.text('.sk-res-actions .sk-btn'), stats: __qa.profile().stats, stage: __qa.run.director.stage })`);
    t.check(res.mode === 'zombie' && res.stage >= 25 && new RegExp(`스테이지 ${res.stage}`).test(res.title), '결과: 도달한 스테이지(40초마다 넘어가므로 25 이상)', res);
    t.check(/생존/.test(res.score) && !/클리어/.test(res.score), '결과: 생존 시간(시험용 중간 시작이라 깬 스테이지는 0)', res.score);
    t.check((res.stats.zombieRuns || 0) === runsBefore + 1 && (res.stats.zombieBest || 0) >= 25, '계정에 좀비 기록이 남는다', res.stats);
    t.check((res.stats.kills | 0) === (statsBefore.kills | 0), '좀비 처치는 사람 킬 전적에 넣지 않는다', { before: statsBefore.kills, after: res.stats.kills });
    await t.shot('results');
    t.errorsOk('전멸과 결과');
  }
};
