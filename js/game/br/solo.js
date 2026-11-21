/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 배틀로얄(연습장 혼자) 진행. 연습장 개인전 엔진(practice.js의 봇·match.js) 위에 격자 구역 봉쇄 일정, 봉쇄 구역 피해,
 *          보급품 놓기·줍기(봇), 구급상자, 탈락 기록·순위, 봇 목표(보급품 → 안전 구역), HUD·미니맵·3D 봉쇄 연출을 얹는다.
 *          규칙 값과 결정적 계산은 br/rules.js, 그리기는 br/view.js(World)와 ui/hud.js. 계약: docs/MODES.md 15절
 */
import { BR, brMapData, buildSchedule, createZone, rollLoot, placements, sectorAt, sectorName, mulberry32 } from './rules.js';
import { getDef } from '../../weapons/defs.js';
import { DROP_RADIUS, DROP_HEIGHT } from '../drops.js';

const HUD_EVERY_MS = 150;            // HUD 패널을 다시 쓰는 간격(실제 시간)
const PICK_EVERY_MS = 100;           // 봇 줍기 검사 간격(시뮬레이션 시간)
const BOT_LOOT_RANGE = 45;           // 봇이 보급품을 보러 가는 거리(m)
const BOT_LOOT_GIVEUP_MS = 20000;    // 이만큼 가도 못 주우면 그 보급품은 포기한다
const BOT_ROAM_MS = 22000;           // 안전 구역 안에서 다음 자리로 옮기는 간격
const BOT_HEAL_HP = 60;              // 봇이 구급상자를 쓰는 체력(교전이 없을 때)
const SPOT_JITTER = 0.6;
const SPREAD_CAP = 60;               // 봇 자리 고르기: 다른 사람과 이만큼(m) 넘게 떨어지면 똑같이 좋다
// 속도 조절(봇, 12명 판이 6~9분 가게): 먼저 싸울 수 있는 거리를 봉쇄 단계마다 늘린다.
// k번째 봉쇄 전까지 ENGAGE[k-1] m(둘째 봉쇄 전 0 = 먼저 쏘지 않는다), 넷째 봉쇄 뒤에는 제한 없음.
// 주무기가 없으면(권총뿐) PISTOL_RANGE를 넘지 않는다. 자기를 쏜 적은 HURT_MS 동안 거리와 상관없이 본다
const ENGAGE = Object.freeze([0, 0, 12, 25]);
const PISTOL_RANGE = 15;
const HURT_MS = 4000;

/** 칸 목록 → 'B-2, C-3 외 4곳' */
function sectorList(grid, list) {
  const names = list.slice().sort((a, b) => a - b).map((i) => sectorName(grid, i));
  return names.length <= 4 ? names.join(', ') : `${names.slice(0, 3).join(', ')} 외 ${names.length - 3}곳`;
}
const secText = (ms) => `${Math.max(0, Math.ceil(ms / 1000))}초`;

/**
 * @param {object} host 연습장 한 판(practice.js startRun)이 넘기는 것
 *   { ctx, world, ui, data(맵 데이터), opts, me:{id,name}, bots, match, apply(evs), nameOf(id), simMs(), meAlive(), myPos(), statsOf(id) → {kills, head} }
 * @returns 판 진행 객체(아래 return 참고). 맵에 br 칸이 없으면 null
 */
export function createRoyaleRun(host) {
  const { ctx, world, ui, opts, me, bots, match, apply, nameOf } = host;
  const br = brMapData(host.data);
  if (!br) return null;
  const grid = br.grid;
  const seed = (host.seed >>> 0) || (opts.seed >>> 0) || ((Date.now() ^ 0x2545f491) >>> 0);
  const rng = mulberry32(seed ^ 0x68e31da4);
  // 마지막 안전 칸 후보: 보급품이나 출발 지점이 있는 칸(걸을 수 있는 곳)
  const anchors = [...br.loot.map((l) => l.pos), ...br.spawns];
  const candidates = [...new Set(anchors.map((p) => sectorAt(grid, p[0], p[2])).filter((i) => i >= 0))];
  const schedule = buildSchedule({ seed, grid, candidates });
  const zone = createZone(schedule);
  const ys = br.loot.map((l) => l.pos[1]).sort((a, b) => a - b);
  const zoneView = { grid, closed: zone.closed, closing: zone.closing, floorY: ys[Math.floor(ys.length / 2)] || 0 };
  const anchorsBySector = new Map();
  for (const p of anchors) {
    const i = sectorAt(grid, p[0], p[2]);
    if (!anchorsBySector.has(i)) anchorsBySector.set(i, []);
    anchorsBySector.get(i).push(p);
  }
  const ids = [me.id, ...bots.map((b) => b.id)];
  const total = ids.length;
  const deaths = [];                     // [{ id, at }] 탈락 순서(봉쇄 시계 ms)
  const out = new Set();                 // 탈락한 id
  const claims = new Map();              // 보급품 id → 그것을 가지러 가는 봇 id
  const heals = new Map();               // id → { left(남은 회복량), acc }
  const offs = [];
  let liveAt = -1, dmgAcc = 0, pickAcc = 0, hudAt = 0, dropSeq = 0, myMedkits = 0;
  let over = false, winnerId = null, myResult = null;

  /* ---------- 시작: 보급품 ---------- */
  world.setRoyale({ medkits: 0, medkitMax: BR.medkitMax, watch: null, hud: null });
  function placeLoot() {
    for (const it of rollLoot(seed, br.loot)) {
      const id = `loot#${it.i}`;
      if (it.kind === 'gun') {
        const def = getDef(it.weaponId);
        world.addDrop({ id, weaponId: it.weaponId, pos: it.pos, mag: def.mag, reserve: def.mag * (it.tier === 'rare' ? 1 : 2) });
      } else world.addDrop({ id, kind: it.kind, pos: it.pos });
    }
  }

  /* ---------- 사람 ---------- */
  const participants = () => [{ id: me.id, alive: host.meAlive(), pos: host.myPos() }, ...bots.map((b) => ({ id: b.id, alive: b.alive, pos: b.body.pos, bot: b }))];
  const aliveCount = () => ids.filter((id) => !out.has(id)).length;
  const zoneT = () => (liveAt < 0 ? 0 : host.simMs() - liveAt);
  /** 이 자리가 지금 봉쇄 구역인가(격자 밖은 첫 봉쇄부터 봉쇄로 본다) */
  function closedAt(p) {
    if (zone.overtime) return true;
    const i = sectorAt(grid, p[0], p[2]);
    return i < 0 ? zone.phase > 0 : zone.closed[i] === 1;
  }
  function carriedOf(b) {
    const lo = b.arsenal.getLoadout();
    return { primary: b.arsenal.isSlotEmpty(1) ? null : lo.primary, secondary: b.arsenal.isSlotEmpty(2) ? null : lo.secondary, melee: lo.melee, grenade: null };
  }

  /** 출격(match 'spawn') 뒤: 봇은 권총·칼만 들고 주무기 칸을 비운다. 나는 World가 같은 일을 한다 */
  function spawned(b) {
    b.arsenal.emptySlot(1);
    b.medkits = 0;
    b.royLoot = null; b.royRoam = null; b.royBad = new Set();
    b.brain.setCarried(carriedOf(b));
  }

  /* ---------- 줍기(봇) ---------- */
  function botWants(b, d) {
    if (d.kind === 'medkit') return (b.medkits || 0) < 2;
    if (d.kind === 'ammo') {
      if (b.arsenal.isSlotEmpty(1)) return false;
      const a = b.arsenal.getAmmo(b.arsenal.getLoadout().primary);
      return a.kind === 'mag' && Number.isFinite(a.reserveMax) && a.reserve < a.reserveMax * 0.5;
    }
    const def = getDef(d.weaponId);
    return !!def && def.slot === 1 && b.arsenal.isSlotEmpty(1);
  }
  function botTake(b, d) {
    if (d.kind === 'medkit') b.medkits = (b.medkits || 0) + 1;
    else if (d.kind === 'ammo') {
      for (const s of [1, 2]) {
        if (b.arsenal.isSlotEmpty(s)) continue;
        const id = b.arsenal.getLoadout()[s === 1 ? 'primary' : 'secondary'];
        const a = b.arsenal.getAmmo(id);
        if (a.kind === 'mag' && a.magSize > 0) b.arsenal.addReserve(a.magSize * BR.ammoMags, id);
      }
    } else if (!b.arsenal.takeWeapon(d.weaponId, { mag: d.mag, reserve: d.reserve })) return;
    world.removeDrop(d.id);
    claims.delete(d.id);
    if (b.royLoot && b.royLoot.id === d.id) b.royLoot = null;
    if (!d.kind) b.brain.setCarried(carriedOf(b));
  }
  function botPickups() {
    const list = world.listDrops();
    for (const b of bots) {
      if (!b.alive) continue;
      const p = b.body.pos;
      for (const d of list) {
        if (Math.abs(d.pos[1] - p[1]) > DROP_HEIGHT || Math.hypot(d.pos[0] - p[0], d.pos[2] - p[2]) > DROP_RADIUS) continue;
        if (botWants(b, d)) { botTake(b, d); break; }   // 목록이 바뀌었다. 다음 검사에서 계속
      }
    }
  }

  /* ---------- 구급상자 ---------- */
  function startHeal(id) {
    if (heals.has(id)) return false;
    heals.set(id, { left: BR.medkitHeal, acc: 0 });
    return true;
  }
  function useMyMedkit() {
    if (!host.meAlive() || myMedkits <= 0 || heals.has(me.id)) return;
    if ((ctx.player && ctx.player.state && ctx.player.state.hp) >= 100) { if (ui) ui.hud.callout('체력이 가득 찼어요'); return; }
    myMedkits--;
    startHeal(me.id);
    world.setRoyale({ medkits: myMedkits });
    world.sound('loot_pick');
  }
  function stepHeals(dtMs) {
    const rate = BR.medkitHeal / BR.medkitMs;
    for (const [id, h] of heals) {
      h.acc += Math.min(h.left, rate * dtMs);
      const n = Math.floor(h.acc);
      if (n >= 1) { h.acc -= n; h.left -= n; apply(match.heal(id, n)); }
      if (h.left <= 0.001 || out.has(id)) heals.delete(id);
    }
  }

  /* ---------- 봉쇄 ---------- */
  function onZoneEvent(ev) {
    if (!ui) return;
    if (ev.type === 'announce') {
      const sub = `${sectorList(grid, ev.sectors)} · ${secText(ev.closeAt - ev.at)} 뒤 봉쇄`;
      ui.hud.banner({ icon: '⚠️', title: `구역 봉쇄 예고 ${ev.n}/${schedule.phases.length}`, sub, ms: 5200 });
      world.sound('bomb_beep');
    } else if (ev.type === 'close') {
      ui.hud.banner({ icon: '⛔', title: `구역 봉쇄 ${ev.n}/${schedule.phases.length}`, sub: `${sectorList(grid, ev.sectors)} 봉쇄 · 봉쇄 구역 안 초당 ${zone.dps} 피해`, ms: 4800 });
      world.sound('bomb_armed');
    } else if (ev.type === 'overtime') {
      ui.hud.banner({ icon: '⛔', title: '전면 봉쇄', sub: `모든 구역이 봉쇄됐어요 · 초당 ${zone.dps} 피해`, ms: 5200 });
      world.sound('bomb_armed');
    }
  }
  function hurtZone() {
    const dps = zone.dps;
    if (!(dps > 0)) return;
    for (const p of participants()) {
      if (over) return;
      if (!p.alive || out.has(p.id) || !p.pos || !closedAt(p.pos)) continue;
      apply(match.claimHazard(p.id, dps, 'zone'));
    }
  }

  /* ---------- 봇 목표 (BOTS_API 12절 view.objective) ---------- */
  /**
   * set 칸의 지점 중 다른 사람(그 사람이 가는 자리 또는 지금 자리)과 가장 떨어진 곳. nearW만큼 내 자리에서 가까운 쪽을 더 쳐준다.
   * 봇이 같은 지점에 몰려 있다가 싸울 거리가 풀리자마자 한꺼번에 쓰러지지 않게 안전 구역 안에 흩어 둔다
   */
  function spacedAnchor(b, set, nearW) {
    const others = [host.myPos()];
    for (const o of bots) if (o !== b && o.alive) others.push(o.royRoam ? o.royRoam.pos : o.body.pos);
    const p = b.body.pos;
    let best = null, bs = -Infinity;
    for (const i of set) {
      for (const a of anchorsBySector.get(i) || []) {
        let sep = SPREAD_CAP;
        for (const q of others) sep = Math.min(sep, Math.hypot(a[0] - q[0], a[2] - q[2]));
        const s = sep - nearW * Math.hypot(a[0] - p[0], a[2] - p[2]) + rng() * 2;
        if (s > bs) { bs = s; best = a; }
      }
    }
    return best;
  }
  const allSectors = [...anchorsBySector.keys()].filter((i) => i >= 0);
  function lootGoal(b) {
    const now = host.simMs();
    if (b.royLoot) {
      const d = world.listDrops().find((x) => x.id === b.royLoot.id);
      if (d && botWants(b, d) && now - b.royLoot.since < BOT_LOOT_GIVEUP_MS) return d;
      if (d && now - b.royLoot.since >= BOT_LOOT_GIVEUP_MS) b.royBad.add(d.id);
      claims.delete(b.royLoot.id);
      b.royLoot = null;
    }
    const p = b.body.pos;
    let best = null, bd = BOT_LOOT_RANGE;
    for (const d of world.listDrops()) {
      if (b.royBad.has(d.id) || !botWants(b, d)) continue;
      const owner = claims.get(d.id);
      if (owner && owner !== b.id && !out.has(owner)) continue;
      const sec = sectorAt(grid, d.pos[0], d.pos[2]);
      if (sec >= 0 && (zone.closed[sec] || zone.closing[sec])) continue;
      if (Math.abs(d.pos[1] - p[1]) > 6) continue;
      // 총이 가장 급하다: 같은 거리면 총을 먼저
      const dist = Math.hypot(d.pos[0] - p[0], d.pos[2] - p[2]) * (d.kind ? 1.6 : 1);
      if (dist < bd) { bd = dist; best = d; }
    }
    if (best) { claims.set(best.id, b.id); b.royLoot = { id: best.id, since: now }; }
    return best;
  }
  function objectiveFor(b) {
    if (liveAt < 0 || over || !b.alive) return null;
    const p = b.body.pos;
    const target = zone.target;                 // 다음 봉쇄 뒤에도 안전한 칸(처음엔 null = 전부)
    const targetSet = target && target.length ? target : null;
    const sec = sectorAt(grid, p[0], p[2]);
    const danger = zone.overtime ? false : sec < 0 ? zone.phase > 0 : !!(zone.closed[sec] || zone.closing[sec]);
    if (targetSet && danger) {
      // 다음 안전 구역 안으로: 이미 고른 자리가 그 안이면 그대로, 아니면 가까우면서 다른 사람과 떨어진 지점
      const keep = b.royRoam && targetSet.includes(sectorAt(grid, b.royRoam.pos[0], b.royRoam.pos[2]));
      if (!keep) {
        const a = spacedAnchor(b, targetSet, 0.5);
        b.royRoam = a ? { pos: a, until: host.simMs() + BOT_ROAM_MS } : null;
      }
      if (b.royRoam) return { pos: b.royRoam.pos, radius: 3, hold: true, urgent: !!(sec >= 0 && zone.closed[sec]) };
    }
    const d = lootGoal(b);
    if (d) return { pos: d.pos, radius: 0.5, hold: true };
    const set = targetSet || allSectors;
    const now = host.simMs();
    const roamSec = b.royRoam ? sectorAt(grid, b.royRoam.pos[0], b.royRoam.pos[2]) : -1;
    if (!b.royRoam || now >= b.royRoam.until || !set.includes(roamSec)) {
      const a = spacedAnchor(b, set, 0.15);
      b.royRoam = a ? { pos: [a[0] + (rng() - 0.5) * SPOT_JITTER, a[1], a[2] + (rng() - 0.5) * SPOT_JITTER], until: now + BOT_ROAM_MS * (0.6 + rng() * 0.8) } : null;
    }
    return b.royRoam ? { pos: b.royRoam.pos, radius: 2.5, hold: true } : null;
  }

  /* ---------- 탈락 ---------- */
  function dropBotLoot(b) {
    const p = b.body.pos;
    const at = [p[0], p[1], p[2]];
    let k = 0;
    const spot = () => { const a = (k++ * 2.1) % (Math.PI * 2); return [at[0] + Math.cos(a) * 0.5 * Math.min(1, k), at[1], at[2] + Math.sin(a) * 0.5 * Math.min(1, k)]; };
    for (const s of [1, 2]) {
      if (b.arsenal.isSlotEmpty(s)) continue;
      const id = b.arsenal.getLoadout()[s === 1 ? 'primary' : 'secondary'];
      const a = b.arsenal.getAmmo(id);
      if (!(a.mag > 0 || a.reserve > 0)) continue;
      world.addDrop({ id: `${b.id}#br${++dropSeq}`, weaponId: id, pos: spot(), mag: a.mag, reserve: a.reserve });
    }
    for (let i = 0; i < (b.medkits || 0); i++) world.addDrop({ id: `${b.id}#br${++dropSeq}`, kind: 'medkit', pos: spot() });
    b.medkits = 0;
  }
  function dropMyMedkits() {
    const p = host.myPos();
    for (let i = 0; i < myMedkits; i++) world.addDrop({ id: `${me.id}#brm${++dropSeq}`, kind: 'medkit', pos: [p[0] + 0.4 * (i + 1), p[1], p[2] - 0.3] });
    myMedkits = 0;
    world.setRoyale({ medkits: 0 });
  }
  /** match 'kill' 뒤(practice가 화면·기록을 마친 다음). 탈락을 적고 경기에서 뺀다 → 한 명 남으면 match가 matchEnd(forfeit)를 낸다 */
  function onKill(ev) {
    const id = ev.victim;
    if (out.has(id)) return;
    out.add(id);
    heals.delete(id);
    deaths.push({ id, at: zoneT(), cause: ev.cause === 'zone' ? 'zone' : 'fight' });
    const b = bots.find((x) => x.id === id);
    if (b) { dropBotLoot(b); if (b.royLoot) claims.delete(b.royLoot.id); }
    if (id === me.id) {
      dropMyMedkits();
      const place = placeOf(me.id);
      myResult = { place, survivedMs: zoneT() };
      world.setRoyale({ watch: ev.killer !== ev.victim ? ev.killer : null, hud: null });
      if (ui) ui.hud.center(`탈락 · #${place} / ${total}`, 0, { sub: ev.cause === 'zone' ? '봉쇄 구역에서 버티지 못했어요' : `${nameOf(ev.killer)}에게 당했어요`, tone: 'warn' });
      world.setHint('E 결과 보기 · 클릭하면 관전 대상을 바꿔요');
      if (host.onEliminated) host.onEliminated(myResult);
    }
    apply(match.removePlayer(id));
  }
  function placeOf(id) { return placements(ids, deaths).get(id) || total; }

  /* ---------- 초반 속도 조절 ---------- */
  /** 지금 봇이 먼저 싸울 수 있는 거리(m) */
  function engageRange(t) {
    const P = schedule.phases;
    for (let k = 0; k < ENGAGE.length; k++) if (t < P[k].closeAt) return ENGAGE[k];
    return Infinity;
  }
  /** 봇 b가 지금 볼 적(brain view.enemies): 봉쇄 단계에 따른 거리 안의 적 + 자기를 쏜 적 */
  function visibleEnemies(b, list) {
    if (liveAt < 0) return list;
    const hurt = b.royHurtBy && host.simMs() - b.royHurtAt < HURT_MS ? b.royHurtBy : null;
    let range = engageRange(zoneT());
    if (b.arsenal.isSlotEmpty(1)) range = Math.min(range, PISTOL_RANGE);
    if (range === Infinity) return list;
    const p = b.body.pos;
    return list.filter((e) => e.id === hurt || (e.pos && Math.hypot(e.pos[0] - p[0], e.pos[2] - p[2]) <= range));
  }
  /** 총소리를 따라갈 수 있는가: 싸움 거리 제한이 풀린 뒤(넷째 봉쇄 뒤)에만, 권총뿐이면 아니다. 그 전에는 소리를 쫓아 몰려들지 않는다 */
  function canHear(b) {
    return liveAt >= 0 && engageRange(zoneT()) === Infinity && !b.arsenal.isSlotEmpty(1);
  }
  function noteHurt(b, attacker) {
    if (!attacker || attacker === b.id) return;
    b.royHurtBy = attacker; b.royHurtAt = host.simMs();
  }

  /** 결과·점수판 줄: 순위(탈락 순서) · 킬 · 헤드샷 · 생존 시간. 살아 있는 사람은 alive */
  function ranking() {
    const pl = placements(ids, deaths);
    const t = zoneT();
    const deadAt = new Map(deaths.map((d) => [d.id, d.at]));
    return ids.map((id) => {
      const st = host.statsOf(id);
      return {
        id, name: nameOf(id), bot: id !== me.id, place: pl.get(id) || total,
        kills: st.kills, head: st.head, survivedMs: deadAt.has(id) ? deadAt.get(id) : t, alive: !out.has(id)
      };
    }).sort((a, b) => a.place - b.place || b.kills - a.kills);
  }

  /* ---------- HUD ---------- */
  function pushHud() {
    if (!host.meAlive()) return;
    const p = host.myPos();
    const i = sectorAt(grid, p[0], p[2]);
    const t = zoneT();
    const state = zone.overtime || (i >= 0 && zone.closed[i]) ? 'closed' : i < 0 ? (zone.phase > 0 ? 'out' : 'safe') : zone.closing[i] ? 'closing' : 'safe';
    const nx = zone.next;
    let next = '';
    if (zone.warning) next = `봉쇄 예고 · ${sectorList(grid, zone.warning.closes)} · ${secText(zone.warning.closeAt - t)}`;
    else if (nx && nx.type === 'announce') next = `다음 봉쇄 예고까지 ${secText(nx.at - t)}`;
    else if (nx && nx.type === 'overtime') next = `전면 봉쇄까지 ${secText(nx.at - t)}`;
    else if (zone.overtime) next = '전면 봉쇄 · 모든 구역';
    const h = heals.get(me.id);
    world.setRoyale({ hud: { sector: i >= 0 ? sectorName(grid, i) : '', state, next, medkits: myMedkits, medkitMax: BR.medkitMax, heal: h ? 1 - h.left / BR.medkitHeal : null, dps: zone.dps } });
  }

  /* ---------- 입력 ---------- */
  offs.push(world.on('lootPick', (e) => {
    if (!e || e.kind !== 'medkit') return;
    myMedkits = Math.min(BR.medkitMax, myMedkits + 1);
    world.setRoyale({ medkits: myMedkits });
  }));
  if (ctx.bus && typeof ctx.bus.on === 'function') {
    offs.push(ctx.bus.on('input:use', (e) => {
      if (!e || !e.down || liveAt < 0) return;
      if (host.meAlive()) useMyMedkit();
      else if (out.has(me.id) && host.showResults) host.showResults();
    }));
  }

  return {
    seed, schedule, total,
    get zone() { return zone; },
    get over() { return over; },
    get winnerId() { return winnerId; },
    get myResult() { return myResult; },
    get aliveCount() { return aliveCount(); },
    get myMedkits() { return myMedkits; },
    visibleEnemies,
    canHear,
    noteHurt,
    /** 탈락 기록 [{ id, at(봉쇄 시계 ms) }] 사본(시험용) */
    get deaths() { return deaths.map((d) => ({ ...d })); },
    /** 봉쇄 시계(ms, live 시작부터) */
    get clock() { return zoneT(); },
    /** 처음 출격 전에 한 번: 보급품을 놓고 봉쇄 연출을 켠다 */
    prepare() {
      placeLoot();
      world.setRoyaleZone(zoneView);
    },
    /** match live 시작 = 봉쇄 시계 0 */
    start() { if (liveAt < 0) liveAt = host.simMs(); },
    spawned,
    objectiveFor,
    onKill,
    placeOf,
    ranking,
    /** 경기 끝(matchEnd): 마지막 남은 사람 */
    finish(winner) { over = true; winnerId = winner || null; heals.clear(); world.setRoyale({ hud: null }); },
    /** 시뮬레이션 한 틱(dt 초) */
    step(dt) {
      if (liveAt < 0 || over) return;
      const dtMs = dt * 1000;
      const evs = zone.advance(zoneT());
      if (evs.length) { world.setRoyaleZone(zoneView); for (const ev of evs) onZoneEvent(ev); }
      dmgAcc += dtMs;
      while (dmgAcc >= BR.tickMs && !over) { dmgAcc -= BR.tickMs; hurtZone(); }
      if (over) return;
      stepHeals(dtMs);
      pickAcc += dtMs;
      if (pickAcc >= PICK_EVERY_MS) {
        pickAcc = 0;
        botPickups();
        for (const b of bots) {
          if (!b.alive || !(b.medkits > 0) || heals.has(b.id) || b.hp > BOT_HEAL_HP || b.brain.targetId != null) continue;
          b.medkits--;
          startHeal(b.id);
        }
      }
    },
    /** 화면 한 프레임(실제 시간): HUD 패널 */
    frame() {
      const now = performance.now();
      if (now - hudAt < HUD_EVERY_MS) return;
      hudAt = now;
      pushHud();
    },
    /** 다음 봉쇄 일까지 남은 시간(ms, 시뮬레이션) | null */
    nextInMs() {
      const nx = zone.next;
      return liveAt < 0 || over || !nx ? null : Math.max(0, nx.at - zoneT());
    },
    dispose() {
      offs.forEach((o) => { try { o(); } catch (e) { /* ignore */ } });
      offs.length = 0;
      world.setRoyale(null);
    }
  };
}
