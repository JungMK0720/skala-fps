/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 좀비 물량 막기의 방장 시뮬레이션. 스테이지 진행(준비 → 웨이브 → 카드 → 쉬는 시간), 좀비 생성·길찾기·공격, 보스 스킬,
 *          투사체·장판, 피해 확정, 카드 제안·선택, 스냅샷과 방장 이전 복원을 맡는다. 연습장(혼자)과 멀티 방장이 같은 코드를 돈다.
 *          match.js와 같은 모양(start·tick·claimHit·claimExplosion·addPlayer·removePlayer·snapshot)이라 세션의 방장 루프를 그대로 쓴다.
 *          three.js·DOM에 의존하지 않는다.
 */
/**
 * const d = createHorde({ players: [{ id, name }], world, nav, spawns, getPositions, seed });
 * let ev = d.start();             // 준비(7초) → 1스테이지
 * ev = d.tick(dtMs);               // 방장 루프. 안에서 30 Hz 고정 간격으로 나눠 돈다
 * ev = d.claimHit({ attackerId, victimId: 'z12', weaponId, part, dist, kind, count, shotId });
 * ev = d.claimExplosion({ attackerId, center, victims: [{ id: 'z3', dmg }] });
 * ev = d.cardAction(playerId, 'pick' | 'reroll', cardId?);
 * const snap = d.snapshot();       // 화면(horde/client.js)이 applyHordeSnapshot으로 푼다
 *
 * 이벤트는 드문 일만 낸다(단계 전환·출격·쓰러짐·보스·카드·밀려남·느려짐·끝). 좀비 위치·체력, 사람 체력, 폭발 같은 잦은 일은
 * 스냅샷에 싣는다. 세션의 이벤트는 3초 동안 스냅샷마다 다시 실리기 때문이다(SYNC_API.md 2절).
 */
import { moveCharacter, lineOfSight, getGroundY } from '../../engine/physics.js';
import { computeDamage, getDef } from '../../weapons/defs.js';
import {
  HORDE, ZOMBIE_TYPES, zombieByCode, zombieCount, hpMul, dmgMul, speedMul, spawnGapMs, spawnBurst, bossCount, bossHpMul,
  zombieMix, makeRng, hashSeed, pickWeighted
} from './rules.js';
import { computePerks, perkMaxHp, makeOffer, encodeCards, decodeCards, cardById } from './cards.js';
import { BOSSES, bossById, bossByCode, pickBosses, SKILL_KINDS, HAZARD_KINDS, PROJECTILE_KINDS } from './bosses.js';

export const HORDE_SNAPSHOT_VERSION = 1;
/** 단계(스냅샷 zp) */
export const HORDE_PHASES = Object.freeze(['warmup', 'prep', 'wave', 'cards', 'break', 'over']);
const PHASE_CODE = Object.freeze({ warmup: 0, prep: 1, wave: 2, cards: 3, break: 4, over: 5 });
/** 좀비 행의 깃발 비트 */
export const ZF = Object.freeze({ dead: 1, wind: 2, rise: 4, slow: 8, haste: 16, armor: 32, rage: 64, air: 128 });
const BOSS_CODE_BASE = 100;       // 좀비 행의 종류 번호가 이 값 이상이면 보스(100 + 보스 번호)
const DEAD_KEEP_MS = 1400;        // 쓰러진 좀비를 화면이 쓰러지는 모습을 그리도록 남겨 두는 시간
const FX_KEEP_MS = 700;           // 폭발 표시를 스냅샷에 남겨 두는 시간
const HURT_KEEP_MS = 900;         // 사람이 맞은 방향 표시를 남겨 두는 시간
const PLAYER_R = 0.35;
const EYE = 1.6;
const PIERCE_FALLOFF = 0.7;
const MELEE_SLACK = 2.2;          // 칼 주장 거리 여유(m, 지연 보간 몫)
const RANGE_SLACK = 1.15;
const TARGET_MS = 500;
const LOS_MS = 300;
const JUMP_GAP_MS = 1100;
const STUCK_RECYCLE_MS = 9000;    // 이만큼 사람에게 다가가지 못한 좀비는 다른 자리에서 다시 나온다
const GRAVITY = -12;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const num = (v, d = 0) => (Number.isFinite(+v) && v !== null && v !== '' ? +v : d);
const cm = (v) => Math.round(num(v) * 100);
const fromCm = (v) => num(v) / 100;
const hyp2 = (dx, dz) => Math.sqrt(dx * dx + dz * dz);
function pos3(p) {
  if (!p) return null;
  if (Array.isArray(p)) return Number.isFinite(+p[0]) && Number.isFinite(+p[2]) ? [+p[0], num(p[1]), +p[2]] : null;
  return Number.isFinite(+p.x) && Number.isFinite(+p.z) ? [+p.x, num(p.y), +p.z] : null;
}
const zid = (n) => 'z' + n;
/** 'z12' → 12, 그 밖은 0 */
export function zombieIdOf(v) {
  const s = String(v == null ? '' : v);
  if (s.length < 2 || s.length > 9 || s[0] !== 'z') return 0;
  const n = Number(s.slice(1));
  return Number.isInteger(n) && n > 0 ? n : 0;
}
const isZombieId = (v) => zombieIdOf(v) > 0;

/**
 * @param {object} o
 * @param {Array<{id,name}>} o.players
 * @param {object} o.world      맵 충돌 월드(maps/collision.js · core 맵의 .world)
 * @param {object} o.nav        navgrid(buildNavGrid). flowField·flowStep·randomPoint·nearestWalkable을 쓴다
 * @param {object} o.spawns     맵 스폰 { owner:[{x,y,z,rotY}], charterer:[...], ffa?:[...] }
 * @param {() => object} o.getPositions  살아 있는 사람 발 위치 { id: {x,y,z} | [x,y,z] }
 * @param {number} [o.seed]
 * @param {object} [o.rules]    HORDE 덮어쓰기(시험용: 짧은 준비·카드 시간)
 * @param {number} [o.startStage=1]  시험용: 이 스테이지부터
 */
export function createHorde(o = {}) {
  const R = Object.freeze({ ...HORDE, ...(o.rules || {}) });
  const world = o.world || null;
  const nav = o.nav || null;
  const spawns = o.spawns || {};
  const getPositions = typeof o.getPositions === 'function' ? o.getPositions : () => ({});
  const seed = (num(o.seed, 0) >>> 0) || ((Math.random() * 4294967296) >>> 0) || 1;
  const rng = makeRng(hashSeed(seed, 'run'));
  const STEP_MS = 1000 / R.simHz;

  const S = {
    phase: 'warmup', stage: Math.max(0, (num(o.startStage, 1) | 0) - 1), firstStage: Math.max(1, num(o.startStage, 1) | 0), clock: 0, phaseEnd: 0, startedAt: null, endedAt: null,
    queue: [], spawnAt: 0, total: 0, killedStage: 0, nextZ: 1, nextFx: 1, nextProj: 1, nextHaz: 1,
    flowAt: -Infinity, flowOk: false, recentBosses: [], over: null, disposed: false
  };
  const zombies = new Map();          // 번호 → 좀비
  const players = new Map();          // id → 사람
  const projectiles = [];
  const hazards = [];
  const fxList = [];                  // { id, kind, x, y, z, r, at }
  const shotCounts = new Map();       // 사수 → { shotId, n } (관통 순서)
  let acc = 0;

  /* ------------------------------------------------------------------ 사람 */
  function makePlayer(p) {
    const id = String(p.id);
    const P = {
      id, name: String(p.name || id).slice(0, 24), connected: true, alive: false, spawned: false,
      hp: R.baseHp, maxHp: R.baseHp, shield: 0, cards: [], perks: computePerks([]),
      kills: 0, heads: 0, bossKills: 0, damage: 0, downs: 0,
      offer: null, picked: false, secondUsed: false, regenAcc: 0, hurtAt: -Infinity, hurtFrom: null, pos: null,
      joinedStage: S.stage
    };
    return P;
  }
  for (const p of Array.isArray(o.players) ? o.players : []) if (p && p.id != null) players.set(String(p.id), makePlayer(p));
  const connected = () => [...players.values()].filter((P) => P.connected);
  const aliveList = () => [...players.values()].filter((P) => P.connected && P.alive);
  function refreshStats(P) {
    const before = P.maxHp;
    P.perks = computePerks(P.cards);
    P.maxHp = perkMaxHp(P.perks, R.baseHp);
    if (P.maxHp < before) P.hp = Math.min(P.hp, P.maxHp);
  }
  function healPlayer(P, amount) {
    if (!P.alive || !(amount > 0)) return 0;
    const before = P.hp;
    P.hp = Math.min(P.maxHp, P.hp + amount);
    return P.hp - before;
  }

  /** 사람 위치(세션·연습장이 준다)를 읽어 둔다. 모르는 사람은 마지막 자리를 쓴다 */
  function readPositions() {
    let raw = null;
    try { raw = getPositions() || {}; } catch (e) { raw = {}; }
    for (const P of players.values()) {
      const p = pos3(raw[P.id]);
      if (p) P.pos = p;
    }
  }

  /** 사람 스폰 자리(블루 진영 스폰을 돌아가며) */
  function playerSpawn(i) {
    const list = (spawns.owner && spawns.owner.length ? spawns.owner : spawns.ffa && spawns.ffa.length ? spawns.ffa : spawns.charterer) || [];
    const extra = spawns.extra && Array.isArray(spawns.extra.owner) ? spawns.extra.owner : [];
    const all = list.concat(extra);
    const sp = all.length ? all[i % all.length] : { x: 0, z: 0, rotY: 0 };
    return { x: num(sp.x), y: Number.isFinite(sp.y) ? sp.y : undefined, z: num(sp.z), rotY: num(sp.rotY) };
  }
  function spawnPlayer(P, i, ev, hpFrac = 1) {
    P.alive = true;
    P.spawned = true;
    P.hp = Math.max(1, Math.round(P.maxHp * hpFrac));
    P.hurtFrom = null;
    const sp = playerSpawn(i);
    P.pos = [sp.x, num(sp.y), sp.z];
    ev.push({ type: 'spawn', id: P.id, spawn: sp, hp: P.hp, maxHp: P.maxHp });
  }

  /* ------------------------------------------------------------------ 단계 */
  function setPhase(phase, ms, ev, extra) {
    S.phase = phase;
    S.phaseEnd = ms > 0 ? S.clock + ms : 0;
    ev.push({ type: 'phase', phase, stage: S.stage, ms: ms > 0 ? Math.round(ms) : 0, ...(extra || {}) });
  }

  function start() {
    if (S.phase !== 'warmup' || S.disposed) return [];
    const ev = [];
    let i = 0;
    for (const P of players.values()) if (P.connected) spawnPlayer(P, i++, ev);
    if (!i) return [{ type: 'reject', reason: 'need_players' }];
    setPhase('prep', R.prepMs, ev, { next: S.stage + 1 });
    return ev;
  }

  /** 인원이 많을수록 좀비가 늘고 보스가 단단해진다(혼자 1배, 4명이면 좀비 2.35배·보스 체력 3.1배) */
  const crowd = () => Math.max(1, Math.min(R.maxPlayers, connected().length));
  function buildQueue(stage) {
    const q = [];
    const nb = bossCount(stage, R);
    const mix = zombieMix(stage);
    let n = Math.round(zombieCount(stage) * (1 + 0.45 * (crowd() - 1)));
    if (nb) {
      n = Math.round(n * 0.5);
      const ids = pickBosses(nb, rng, S.recentBosses);
      S.recentBosses = ids.concat(S.recentBosses).slice(0, 10);
      for (const id of ids) q.push({ boss: id });
    }
    for (let k = 0; k < n; k++) q.push({ type: pickWeighted(mix, rng).type.id });
    return q;
  }

  function beginStage(ev) {
    S.stage += 1;
    S.queue = buildQueue(S.stage);
    S.total = S.queue.length;
    S.killedStage = 0;
    S.spawnAt = S.clock + 900;
    if (S.startedAt == null) S.startedAt = S.clock;
    for (const P of players.values()) P.secondUsed = false;
    const bosses = S.queue.filter((x) => x.boss).map((x) => { const b = bossById(x.boss); return { id: b.id, name: b.name, icon: b.icon }; });
    setPhase('wave', 0, ev, { count: S.total, bosses });
    if (bosses.length) ev.push({ type: 'boss', stage: S.stage, bosses });
  }

  function clearStage(ev) {
    for (const P of players.values()) if (P.alive) healPlayer(P, P.maxHp * R.clearHealFrac);
    projectiles.length = 0;
    hazards.length = 0;
    for (const P of players.values()) {
      P.picked = false;
      if (!P.connected) { P.offer = null; continue; }
      const count = 3 + Math.round(P.perks.offers || 0);
      P.offer = { cards: makeOffer({ seed, playerId: P.id, stage: S.stage, roll: 0, taken: P.cards, count }), roll: 0, rerolls: 1 + Math.round(P.perks.rerolls || 0), count };
    }
    setPhase('cards', R.cardMs, ev, { cleared: S.stage });
  }

  function allPicked() {
    for (const P of players.values()) if (P.connected && P.offer && !P.picked) return false;
    return true;
  }

  function endCards(ev) {
    // 시간이 지나면 아직 안 고른 사람은 첫 카드를 받는다
    for (const P of players.values()) if (P.connected && P.offer && !P.picked && P.offer.cards.length) takeCard(P, P.offer.cards[0], ev, true);
    setPhase('break', R.breakMs, ev, { next: S.stage + 1 });
  }

  function endBreak(ev) {
    let i = 0;
    for (const P of players.values()) {
      if (!P.connected) continue;
      if (!P.alive) spawnPlayer(P, i, ev, R.reviveHpFrac);
      else {
        if (P.perks.stageHeal > 0) healPlayer(P, P.maxHp * P.perks.stageHeal);
      }
      P.shield = Math.max(P.shield, Math.round(P.perks.shield || 0));
      i++;
    }
    beginStage(ev);
  }

  function gameOver(ev, reason) {
    if (S.phase === 'over') return;
    S.endedAt = S.clock;
    S.over = {
      stage: S.stage, reason, ms: Math.round(S.clock - (S.startedAt == null ? S.clock : S.startedAt)),
      // 이 판에서 실제로 깬 스테이지 수(시험용으로 중간 스테이지부터 시작했으면 그 앞은 세지 않는다 → 보상도 없다)
      cleared: Math.max(0, S.stage - S.firstStage)
    };
    zombies.clear();
    projectiles.length = 0;
    hazards.length = 0;
    setPhase('over', R.gameOverMs, ev, { ...S.over });
    ev.push({ type: 'over', ...S.over });
  }

  /* ------------------------------------------------------------------ 카드 */
  function takeCard(P, cardId, ev, auto) {
    const c = cardById(cardId);
    if (!c) return false;
    const beforeMax = P.maxHp;
    P.cards.push(c.id);
    refreshStats(P);
    const inst = c.instant || {};
    if (P.alive) {
      if (inst.heal) healPlayer(P, inst.heal);
      if (inst.healPct) healPlayer(P, P.maxHp * inst.healPct);
      // 최대 체력이 늘면 늘어난 만큼 함께 차오른다(체력 카드가 아니어도)
      if (P.maxHp > beforeMax && !inst.heal) healPlayer(P, P.maxHp - beforeMax);
    } else if (P.maxHp > beforeMax) P.hp = Math.min(P.maxHp, P.hp + (P.maxHp - beforeMax));
    P.picked = true;
    P.offer = null;
    ev.push({ type: 'card', id: P.id, card: c.id, auto: !!auto });
    return true;
  }

  /** 카드 고르기·다시 뽑기. act = 'pick' | 'reroll' */
  function cardAction(id, act, cardId) {
    const P = players.get(String(id));
    if (S.phase !== 'cards' || !P || !P.connected || !P.offer || P.picked) return [{ type: 'reject', reason: 'not_offered', id }];
    const ev = [];
    if (act === 'reroll') {
      if (P.offer.rerolls <= 0) return [{ type: 'reject', reason: 'no_reroll', id }];
      const roll = P.offer.roll + 1;
      const cards = makeOffer({ seed, playerId: P.id, stage: S.stage, roll, taken: P.cards, count: P.offer.count, exclude: P.offer.cards });
      P.offer = { cards: cards.length ? cards : P.offer.cards, roll, rerolls: P.offer.rerolls - 1, count: P.offer.count };
      ev.push({ type: 'reroll', id: P.id });
      return ev;
    }
    if (act !== 'pick' || !P.offer.cards.includes(String(cardId))) return [{ type: 'reject', reason: 'bad_card', id }];
    takeCard(P, String(cardId), ev, false);
    if (allPicked()) setPhase('break', R.breakMs, ev, { next: S.stage + 1 });
    return ev;
  }

  /* ------------------------------------------------------------------ 좀비 만들기 */
  function spawnCandidates() {
    const out = [];
    for (const k of ['charterer', 'ffa', 'owner']) for (const sp of Array.isArray(spawns[k]) ? spawns[k] : []) out.push([num(sp.x), Number.isFinite(sp.y) ? sp.y : NaN, num(sp.z)]);
    if (nav && typeof nav.randomPoint === 'function') {
      for (let i = 0; i < 10; i++) { const p = nav.randomPoint(null, rng); if (p) out.push([p.x, p.y, p.z]); }
    }
    return out;
  }
  /** 사람에게서 떨어진, 될 수 있으면 보이지 않는 자리. minDist를 못 맞추면 가장 먼 후보 */
  function pickSpawnPoint(minDist) {
    const alive = aliveList().map((P) => P.pos).filter(Boolean);
    const cands = spawnCandidates();
    if (!cands.length) return [0, 0, 0];
    let best = null, bestScore = -Infinity;
    for (let i = 0; i < cands.length; i++) {
      const c = cands[(i + Math.floor(rng() * cands.length)) % cands.length];
      let dmin = Infinity;
      for (const p of alive) dmin = Math.min(dmin, hyp2(c[0] - p[0], c[2] - p[2]));
      if (!alive.length) dmin = 50;
      let score = Math.min(dmin, 45) + rng() * 6;
      if (dmin < minDist) score -= 100;
      if (world && alive.length && dmin < 60) {
        const y = Number.isFinite(c[1]) ? c[1] : 0;
        const seen = alive.some((p) => lineOfSight(world, [c[0], y + 1.5, c[2]], [p[0], p[1] + EYE, p[2]]));
        if (!seen) score += 12;
      }
      if (score > bestScore) { bestScore = score; best = c; }
    }
    const y = Number.isFinite(best[1]) ? best[1] : world ? getGroundY(world, best[0], best[2], 50) : 0;
    return [best[0], y, best[2]];
  }

  function makeZombie(spec, at, extra = {}) {
    const boss = spec.boss ? bossById(spec.boss) : null;
    const t = boss ? null : (ZOMBIE_TYPES[spec.type] || ZOMBIE_TYPES.walker);
    const id = S.nextZ++;
    const stage = Math.max(1, S.stage);
    const jitter = 0.92 + rng() * 0.16;
    const base = boss || t;
    const maxHp = Math.round((boss ? boss.hp * bossHpMul(stage) * (1 + 0.7 * (crowd() - 1)) : t.hp * hpMul(stage)) * (extra.hpMul || 1));
    const Z = {
      id, t, boss, code: boss ? BOSS_CODE_BASE + boss.code : t.code,
      body: { pos: [at[0], at[1], at[2]], vel: [0, 0, 0], onGround: true },
      yaw: rng() * Math.PI * 2, hp: maxHp, maxHp,
      dmg: base.damage * dmgMul(stage), speed: base.speed * (boss ? 1 : speedMul(stage)) * (boss ? 1 : jitter),
      range: base.range, radius: Math.min(0.5, base.radius), scale: base.scale,
      attackMs: base.attackMs, windupMs: base.windupMs,
      state: 'rise', until: S.clock + (boss ? 1800 : 650), attackReady: S.clock + 900,
      target: null, targetAt: 0, node: -1, losAt: 0, los: false, jumpAt: 0, stuck: 0, progressAt: S.clock, bestDist: Infinity,
      slowUntil: 0, slowMul: 1, hasteUntil: 0, hasteMul: 1, armorUntil: 0, armorMul: 1, enraged: false,
      rangedAt: S.clock + 1500 + rng() * 1500, skill: null, skillReady: boss ? boss.skills.map((s, i) => S.clock + 2500 + i * 1800 + rng() * 1200) : null,
      summoned: !!extra.summoned, deadAt: 0, killer: null, exploded: false, airFrom: null
    };
    zombies.set(id, Z);
    return Z;
  }

  function spawnTick(ev) {
    if (S.clock < S.spawnAt || !S.queue.length) return;
    let alive = 0;
    for (const Z of zombies.values()) if (Z.state !== 'dead' && !Z.boss && !Z.summoned) alive++;
    const cap = S.queue.some((x) => x.boss) || [...zombies.values()].some((Z) => Z.boss && Z.state !== 'dead') ? R.maxAliveBoss : R.maxAlive;
    let n = spawnBurst(S.stage);
    while (n-- > 0 && S.queue.length) {
      const next = S.queue[0];
      if (!next.boss && alive >= cap) break;
      S.queue.shift();
      const at = pickSpawnPoint(next.boss ? R.spawnSafeM + 6 : R.spawnSafeM);
      const Z = makeZombie(next, at);
      if (Z.boss) ev.push({ type: 'bossSpawn', z: Z.id, boss: Z.boss.id, name: Z.boss.name });
      else alive++;
    }
    S.spawnAt = S.clock + spawnGapMs(S.stage) * (0.7 + rng() * 0.6);
  }

  /* ------------------------------------------------------------------ 피해 */
  /** 사람이 맞음. from = 좀비(없으면 장판 등). melee면 가시가 되돌려 준다 */
  function hurtPlayer(P, amount, from, ev, opt = {}) {
    if (!P || !P.alive || !(amount > 0) || S.phase !== 'wave') return 0;
    if (P.perks.dodge > 0 && rng() < P.perks.dodge) return 0;
    let dmg = amount * (1 - clamp(P.perks.armor || 0, 0, 0.75));
    if (P.shield > 0) { const a = Math.min(P.shield, dmg); P.shield -= a; dmg -= a; }
    dmg = Math.round(dmg);
    if (dmg <= 0) return 0;
    if (P.hp - dmg <= 0 && P.perks.secondChance > 0 && !P.secondUsed) {
      P.secondUsed = true;
      P.hp = Math.max(1, Math.round(P.maxHp * 0.3));
      ev.push({ type: 'second', id: P.id });
    } else P.hp = Math.max(0, P.hp - dmg);
    P.hurtAt = S.clock;
    P.hurtFrom = from && from.body ? [from.body.pos[0], from.body.pos[1] + 1.2, from.body.pos[2]] : opt.at || null;
    if (opt.melee && from && P.perks.thorns > 0 && from.state !== 'dead') hurtZombie(from, P.perks.thorns, P, { kind: 'thorns' }, ev);
    if (P.hp <= 0) downPlayer(P, ev);
    return dmg;
  }

  function downPlayer(P, ev) {
    if (!P.alive) return;
    P.alive = false;
    P.hp = 0;
    P.downs++;
    ev.push({ type: 'down', id: P.id, stage: S.stage });
    if (!aliveList().length) gameOver(ev, 'wiped');
  }

  /** 좀비가 맞음. P = 공격한 사람(없으면 null), info = { head, crit, kind } */
  function hurtZombie(Z, amount, P, info, ev) {
    if (!Z || Z.state === 'dead' || !(amount > 0)) return 0;
    let dmg = amount;
    if (Z.armorUntil > S.clock) dmg *= Z.armorMul;
    dmg = Math.max(1, Math.round(dmg));
    const real = Math.min(Z.hp, dmg);
    Z.hp -= dmg;
    if (P) {
      P.damage += real;
      if (P.perks.lifesteal > 0) healPlayer(P, real * P.perks.lifesteal);
      if (P.perks.slow > 0 && info.kind !== 'thorns') { Z.slowUntil = S.clock + 1200; Z.slowMul = 1 - clamp(P.perks.slow, 0, 0.6); }
    }
    if (Z.hp <= 0) killZombie(Z, P, info, ev);
    return real;
  }

  function killZombie(Z, P, info, ev) {
    Z.hp = 0;
    Z.state = 'dead';
    Z.deadAt = S.clock;
    Z.skill = null;
    Z.killer = P ? P.id : null;
    if (!Z.summoned) S.killedStage++;
    if (P) {
      P.kills++;
      if (info && info.head) P.heads++;
      if (P.perks.killHeal > 0) healPlayer(P, P.perks.killHeal);
    }
    if (Z.boss) {
      if (P) P.bossKills++;
      ev.push({ type: 'bossDown', z: Z.id, boss: Z.boss.id, name: Z.boss.name, by: P ? P.id : null });
    }
    const pos = Z.body.pos;
    // 폭발 좀비는 쓰러질 때도 터진다(가까이에서 쏘면 위험하다)
    if (Z.t && Z.t.explode && !Z.exploded) explodeAt(pos, Z.t.explode.radius, Z.dmg + Z.t.explode.dmg * dmgMul(S.stage), Z, ev, 'bomber');
    if (P && P.perks.explosive > 0 && !(info && info.chain)) {
      const dmg = Z.maxHp * P.perks.explosive;
      addFx('chain', pos, 3);
      for (const O of zombies.values()) {
        if (O === Z || O.state === 'dead') continue;
        if (hyp2(O.body.pos[0] - pos[0], O.body.pos[2] - pos[2]) <= 3) hurtZombie(O, dmg, P, { chain: true, kind: 'chain' }, ev);
      }
    }
  }

  function addFx(kind, p, r) {
    fxList.push({ id: S.nextFx++, kind, x: p[0], y: p[1], z: p[2], r, at: S.clock });
    if (fxList.length > 24) fxList.splice(0, fxList.length - 24);
  }

  /** 폭발(폭발 좀비·화약통): 사람에게만 피해(거리에 따라 줄어든다) */
  function explodeAt(p, radius, dmg, from, ev, kind) {
    if (from) from.exploded = true;
    addFx(kind || 'blast', p, radius);
    for (const P of aliveList()) {
      if (!P.pos) continue;
      const d = Math.hypot(P.pos[0] - p[0], (P.pos[1] + 1) - (p[1] + 0.6), P.pos[2] - p[2]);
      if (d > radius) continue;
      if (world && !lineOfSight(world, [p[0], p[1] + 0.8, p[2]], [P.pos[0], P.pos[1] + 1.2, P.pos[2]])) continue;
      hurtPlayer(P, dmg * (1 - 0.6 * (d / radius)), null, ev, { at: [p[0], p[1] + 1, p[2]] });
    }
  }

  /* ------------------------------------------------------------------ 주장 */
  function claimHit(c = {}) {
    if (S.phase !== 'wave') return [{ type: 'reject', reason: 'not_wave' }];
    const Z = zombies.get(zombieIdOf(c.victimId));
    const P = players.get(String(c.attackerId));
    if (!Z || Z.state === 'dead') return [{ type: 'reject', reason: 'unknown_zombie' }];
    if (!P || !P.alive) return [{ type: 'reject', reason: 'dead_attacker' }];
    const def = getDef(c.weaponId);
    if (!def || def.explosion) return [{ type: 'reject', reason: 'bad_weapon' }];
    const dist = Math.max(0, num(c.dist));
    const melee = !!def.melee;
    const reach = melee ? Math.max(def.melee.slash.range, def.melee.stab.range) + MELEE_SLACK + (Z.boss ? 1.2 : 0) : def.maxRange * RANGE_SLACK;
    if (dist > reach) return [{ type: 'reject', reason: 'out_of_range' }];
    let part = String(c.part || 'body');
    if (part === 'hand') part = 'body';
    else if (part === 'foot') part = 'legs';
    const count = clamp(num(c.count, 1) | 0, 1, Math.max(1, def.pellets || 1));
    let base = computeDamage(def.id, part, dist, c.kind === 'stab' ? 'stab' : 'slash', count);
    // 보스 머리는 몸 피해의 2.2배까지만(라이플 머리 110이 보스를 몇 초 만에 녹이지 않게)
    if (Z.boss && part === 'head' && !def.melee) base = Math.min(base, computeDamage(def.id, 'body', dist, undefined, count) * 2.2);
    const k = P.perks;
    let mul = 1 + k.dmg;
    const head = part === 'head' && !melee;
    if (head) mul *= 1 + k.head;
    if (Z.boss) mul *= 1 + k.boss;
    if (melee) mul *= 1 + k.melee;
    if (k.lastStand > 0 && P.hp < P.maxHp * 0.35) mul *= 1 + k.lastStand;
    if (k.executioner > 0 && Z.hp < Z.maxHp * 0.25) mul *= 1 + k.executioner;
    // 관통: 같은 발로 여러 좀비를 맞히면 맞은 순서대로 70%씩 줄어든다(산탄은 펠릿이 나뉘어 맞으므로 줄이지 않는다)
    const shot = num(c.shotId, 0) | 0;
    if (shot > 0 && (def.pellets || 1) === 1 && !melee) {
      const last = shotCounts.get(P.id);
      const nth = last && last.shotId === shot ? last.n + 1 : 0;
      shotCounts.set(P.id, { shotId: shot, n: nth });
      if (nth > Math.round(k.pierce || 0)) return [{ type: 'reject', reason: 'pierce' }];
      mul *= Math.pow(PIERCE_FALLOFF, nth);
    }
    let crit = false;
    if (k.crit > 0 && rng() < k.crit) { crit = true; mul *= 1.5 + k.critDmg; }
    const ev = [];
    hurtZombie(Z, base * mul, P, { head, crit, kind: melee ? 'melee' : 'shot' }, ev);
    return ev;
  }

  function claimExplosion(c = {}) {
    if (S.phase !== 'wave') return [];
    const P = players.get(String(c.attackerId));
    if (!P) return [];
    const ev = [];
    const mul = (1 + P.perks.dmg) * (1 + P.perks.nade);
    for (const v of Array.isArray(c.victims) ? c.victims : []) {
      if (!v || !isZombieId(v.id)) continue;   // 이 모드에는 아군 피해가 없다(자기 수류탄도)
      const Z = zombies.get(zombieIdOf(v.id));
      if (!Z || Z.state === 'dead') continue;
      const dmg = clamp(num(v.dmg), 0, 100) * 1.6 * mul * (Z.boss ? 1 + P.perks.boss : 1);
      hurtZombie(Z, dmg, P, { kind: 'nade' }, ev);
    }
    return ev;
  }

  /* ------------------------------------------------------------------ 길찾기 */
  function updateFlow() {
    if (!nav || typeof nav.flowField !== 'function') { S.flowOk = false; return; }
    if (S.clock - S.flowAt < R.flowMs) return;
    S.flowAt = S.clock;
    const src = aliveList().map((P) => P.pos).filter(Boolean).map((p) => ({ x: p[0], y: p[1], z: p[2] }));
    S.flowOk = src.length ? !!nav.flowField(src, 260) : false;
  }

  /* ------------------------------------------------------------------ 좀비 이동 · 공격 */
  const grid = new Map();
  function rebuildGrid() {
    grid.clear();
    for (const Z of zombies.values()) {
      if (Z.state === 'dead') continue;
      const k = (Math.floor(Z.body.pos[0] / 2) * 73856093) ^ (Math.floor(Z.body.pos[2] / 2) * 19349663);
      let a = grid.get(k);
      if (!a) { a = []; grid.set(k, a); }
      a.push(Z);
    }
  }
  function neighbors(Z, out) {
    out.length = 0;
    const cx = Math.floor(Z.body.pos[0] / 2), cz = Math.floor(Z.body.pos[2] / 2);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const a = grid.get(((cx + dx) * 73856093) ^ ((cz + dz) * 19349663));
      if (a) for (const O of a) if (O !== Z) out.push(O);
    }
    return out;
  }
  const nb = [];

  function chooseTarget(Z) {
    if (S.clock < Z.targetAt && Z.target) {
      const T = players.get(Z.target);
      if (T && T.alive && T.pos) return T;
    }
    Z.targetAt = S.clock + TARGET_MS;
    let best = null, bd = Infinity;
    for (const P of aliveList()) {
      if (!P.pos) continue;
      const d = hyp2(P.pos[0] - Z.body.pos[0], P.pos[2] - Z.body.pos[2]) + Math.abs(P.pos[1] - Z.body.pos[1]) * 2;
      if (d < bd) { bd = d; best = P; }
    }
    Z.target = best ? best.id : null;
    return best;
  }

  function faceTo(Z, tx, tz, dt, rate = 10) {
    const want = Math.atan2(-(tx - Z.body.pos[0]), -(tz - Z.body.pos[2]));
    let d = want - Z.yaw;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    Z.yaw += d * Math.min(1, dt * rate);
  }

  const wish = { x: 0, z: 0, jump: false };
  function moveZombie(Z, T, dt, speedK) {
    const p = Z.body.pos;
    let dirX = 0, dirZ = 0;
    if (T && T.pos) {
      const dx = T.pos[0] - p[0], dz = T.pos[2] - p[2];
      const d = hyp2(dx, dz);
      // 가까우면 보이는지 확인하고 곧장, 멀면 흐름장
      if (d < 9 && S.clock >= Z.losAt) {
        Z.losAt = S.clock + LOS_MS;
        Z.los = !world || (Math.abs(T.pos[1] - p[1]) < 1.2 && lineOfSight(world, [p[0], p[1] + 1.2, p[2]], [T.pos[0], T.pos[1] + 1.0, T.pos[2]]));
      } else if (d >= 9) Z.los = false;
      let step = null;
      if (!Z.los && S.flowOk) step = nav.flowStep(p, Z.node);
      if (step) Z.node = step.node;
      if (step && step.next) {
        const tx = step.next.x - p[0], tz = step.next.z - p[2];
        const l = hyp2(tx, tz) || 1;
        dirX = tx / l; dirZ = tz / l;
        if (step.next.jump && Z.body.onGround && S.clock >= Z.jumpAt) { wish.jump = true; Z.jumpAt = S.clock + JUMP_GAP_MS; }
      } else if (d > 0.01) { dirX = dx / d; dirZ = dz / d; }
      // 다가가고 있는지(막혀서 제자리면 점프해 보고, 오래 막히면 다시 나온다)
      if (d < Z.bestDist - 0.5) { Z.bestDist = d; Z.progressAt = S.clock; }
    }
    // 서로 밀어내기
    let sx = 0, sz = 0;
    for (const O of neighbors(Z, nb)) {
      const ox = p[0] - O.body.pos[0], oz = p[2] - O.body.pos[2];
      const d = hyp2(ox, oz);
      const want = (Z.radius + O.radius) * 1.15;
      if (d < want && d > 1e-4) { const k = (want - d) / want; sx += (ox / d) * k; sz += (oz / d) * k; }
    }
    dirX += sx * 1.4; dirZ += sz * 1.4;
    const l = hyp2(dirX, dirZ);
    if (l > 1) { dirX /= l; dirZ /= l; }
    const sp = Z.speed * speedK;
    wish.x = dirX * sp; wish.z = dirZ * sp;
    if (world) {
      const before = hyp2(Z.body.vel[0], Z.body.vel[2]);
      moveCharacter(world, Z.body, wish, dt, { radius: Z.radius, height: Math.min(2.4, 1.8 * Math.min(1.3, Z.scale)) });
      const after = hyp2(Z.body.vel[0], Z.body.vel[2]);
      if (sp > 0.5 && after < sp * 0.25 && before < sp * 0.4) Z.stuck += dt * 1000; else Z.stuck = Math.max(0, Z.stuck - dt * 2000);
      if (Z.stuck > 500 && Z.body.onGround && S.clock >= Z.jumpAt) { wish.jump = true; Z.jumpAt = S.clock + JUMP_GAP_MS; moveCharacter(world, Z.body, { x: wish.x, z: wish.z, jump: true }, 0.0001, { radius: Z.radius }); Z.stuck = 0; }
    } else {
      p[0] += wish.x * dt; p[2] += wish.z * dt;
      Z.body.vel[0] = wish.x; Z.body.vel[2] = wish.z;
    }
    wish.jump = false;
    if (Math.abs(wish.x) + Math.abs(wish.z) > 0.05) faceTo(Z, p[0] + wish.x, p[2] + wish.z, dt, 8);
    if (p[1] < -30) recycle(Z);
  }

  /** 떨어졌거나 오래 막힌 좀비: 다른 자리에서 다시 나온다(체력은 그대로) */
  function recycle(Z) {
    const at = pickSpawnPoint(R.spawnSafeM);
    Z.body.pos[0] = at[0]; Z.body.pos[1] = at[1]; Z.body.pos[2] = at[2];
    Z.body.vel[0] = Z.body.vel[1] = Z.body.vel[2] = 0;
    Z.state = 'rise'; Z.until = S.clock + 600; Z.node = -1; Z.progressAt = S.clock; Z.bestDist = Infinity; Z.stuck = 0;
  }

  function stepZombie(Z, dt, ev) {
    const now = S.clock;
    if (Z.state === 'dead') return;
    if (Z.slowUntil && now > Z.slowUntil) { Z.slowUntil = 0; Z.slowMul = 1; }
    if (Z.hasteUntil && now > Z.hasteUntil) { Z.hasteUntil = 0; Z.hasteMul = 1; }
    if (Z.armorUntil && now > Z.armorUntil) { Z.armorUntil = 0; Z.armorMul = 1; }
    if (Z.boss && !Z.enraged && Z.hp < Z.maxHp * Z.boss.enrage.at) { Z.enraged = true; ev.push({ type: 'enrage', z: Z.id, boss: Z.boss.id }); }
    if (Z.state === 'rise') { if (now >= Z.until) Z.state = 'move'; else return; }
    const T = chooseTarget(Z);
    const rage = Z.enraged ? Z.boss.enrage : null;
    const speedK = Z.slowMul * Z.hasteMul * (rage ? rage.speed : 1);
    if (Z.skill) { stepSkill(Z, T, dt, ev); return; }
    if (Z.boss && T && trySkill(Z, T, ev)) return;
    if (!T || !T.pos) { Z.body.vel[0] = Z.body.vel[2] = 0; if (world) moveCharacter(world, Z.body, { x: 0, z: 0 }, dt, { radius: Z.radius }); return; }
    const p = Z.body.pos;
    const dx = T.pos[0] - p[0], dz = T.pos[2] - p[2], dy = T.pos[1] - p[1];
    const d = hyp2(dx, dz);
    const reach = Z.range * (0.75 + 0.25 * Math.min(1.6, Z.scale)) + PLAYER_R;
    // 공격 예고(휘두르기) 중
    if (Z.state === 'wind') {
      faceTo(Z, T.pos[0], T.pos[2], dt, 12);
      if (world) moveCharacter(world, Z.body, { x: 0, z: 0 }, dt, { radius: Z.radius });
      if (now < Z.until) return;
      Z.state = 'move';
      Z.attackReady = now + Z.attackMs * (rage ? rage.cd : 1);
      if (Z.t && Z.t.explode) { killSelfExplode(Z, ev); return; }
      if (Z.windRanged) { Z.windRanged = false; shootSpit(Z, T); return; }
      if (d <= reach * 1.3 && Math.abs(dy) < 1.8) hurtPlayer(T, Z.dmg * (rage ? rage.dmg : 1), Z, ev, { melee: true });
      return;
    }
    // 스피터: 거리를 두고 침을 뱉는다
    const rg = Z.t && Z.t.ranged;
    if (rg && now >= Z.rangedAt && d <= rg.range && d > 3) {
      if (world && !lineOfSight(world, [p[0], p[1] + 1.4, p[2]], [T.pos[0], T.pos[1] + 1.2, T.pos[2]])) Z.rangedAt = now + 600;
      else {
        Z.state = 'wind'; Z.until = now + rg.windupMs; Z.windRanged = true; Z.rangedAt = now + rg.every * (0.8 + rng() * 0.4);
        return;
      }
    }
    if (d <= reach && Math.abs(dy) < 1.6) {
      faceTo(Z, T.pos[0], T.pos[2], dt, 12);
      if (world) moveCharacter(world, Z.body, { x: 0, z: 0 }, dt, { radius: Z.radius });
      if (now >= Z.attackReady) { Z.state = 'wind'; Z.until = now + Z.windupMs; }
      return;
    }
    if (rg && d < rg.keep) {
      // 너무 가까우면 뒤로 물러난다
      const l = d || 1;
      wish.x = (-dx / l) * Z.speed * 0.8 * speedK; wish.z = (-dz / l) * Z.speed * 0.8 * speedK;
      if (world) moveCharacter(world, Z.body, wish, dt, { radius: Z.radius });
      faceTo(Z, T.pos[0], T.pos[2], dt, 8);
      return;
    }
    moveZombie(Z, T, dt, speedK);
    if (!Z.boss && now - Z.progressAt > STUCK_RECYCLE_MS && d > 12) recycle(Z);
  }

  function killSelfExplode(Z, ev) {
    explodeAt(Z.body.pos, Z.t.explode.radius, Z.t.explode.dmg * dmgMul(S.stage), Z, ev, 'bomber');
    Z.hp = 0; Z.state = 'dead'; Z.deadAt = S.clock; Z.killer = null;
    if (!Z.summoned) S.killedStage++;
  }

  /* ------------------------------------------------------------------ 투사체 · 장판 */
  function addProjectile(kind, from, vel, opts) {
    if (projectiles.length >= R.maxProjectiles) projectiles.shift();
    projectiles.push({ id: S.nextProj++, kind, pos: from.slice(), vel: vel.slice(), arc: !!opts.arc, dmg: opts.dmg || 0, blast: opts.blast || null, pool: opts.pool || null, slow: opts.slow || null, born: S.clock, life: opts.life || 4000 });
  }
  function aimVelocity(from, to, speed, arc) {
    const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2];
    const dh = hyp2(dx, dz) || 0.001;
    if (!arc) {
      const l = Math.hypot(dx, dy, dz) || 1;
      return [(dx / l) * speed, (dy / l) * speed, (dz / l) * speed];
    }
    // 포물선: 수평 속도를 speed로 두고 걸리는 시간 동안 중력을 이기는 처음 수직 속도
    const t = clamp(dh / speed, 0.35, 2.2);
    const vy = (dy - 0.5 * GRAVITY * t * t) / t;
    return [(dx / dh) * (dh / t), vy, (dz / dh) * (dh / t)];
  }
  function shootSpit(Z, T) {
    const rg = Z.t.ranged;
    const from = [Z.body.pos[0], Z.body.pos[1] + 1.45, Z.body.pos[2]];
    const lead = 0.25;
    const tp = T.pos;
    const to = [tp[0], tp[1] + 1.1, tp[2]];
    if (T.vel) { to[0] += T.vel[0] * lead; to[2] += T.vel[2] * lead; }
    addProjectile(PROJECTILE_KINDS.spit, from, aimVelocity(from, to, rg.speed, false), { dmg: rg.dmg * dmgMul(S.stage), life: 2500 });
  }
  function addHazard(kind, x, y, z, h) {
    if (hazards.length >= R.maxHazards) hazards.shift();
    hazards.push({ id: S.nextHaz++, kind: HAZARD_KINDS[kind] || 1, kindName: kind, x, y, z, r: h.r, until: S.clock + h.ms, ms: h.ms, dps: (h.dps || 0) * dmgMul(S.stage), slow: h.slow || 0, tick: 0 });
  }
  function stepProjectiles(dt, ev) {
    for (let i = projectiles.length - 1; i >= 0; i--) {
      const pr = projectiles[i];
      const p0 = pr.pos.slice();
      if (pr.arc) pr.vel[1] += GRAVITY * dt;
      pr.pos[0] += pr.vel[0] * dt; pr.pos[1] += pr.vel[1] * dt; pr.pos[2] += pr.vel[2] * dt;
      let hitPlayer = null;
      for (const P of aliveList()) {
        if (!P.pos) continue;
        const cx = P.pos[0], cz = P.pos[2];
        const dh = hyp2(pr.pos[0] - cx, pr.pos[2] - cz);
        if (dh < 0.55 && pr.pos[1] > P.pos[1] - 0.1 && pr.pos[1] < P.pos[1] + 1.9) { hitPlayer = P; break; }
      }
      let hitWorld = false;
      if (!hitPlayer && world) {
        const gy = getGroundY(world, pr.pos[0], pr.pos[2], p0[1] + 0.2);
        if (pr.pos[1] <= gy + 0.05) { hitWorld = true; pr.pos[1] = gy + 0.05; }
        else if (!lineOfSight(world, p0, pr.pos)) hitWorld = true;
      }
      const expired = S.clock - pr.born > pr.life;
      if (!hitPlayer && !hitWorld && !expired) continue;
      projectiles.splice(i, 1);
      if (expired && !hitPlayer && !hitWorld) continue;
      const at = pr.pos;
      if (hitPlayer && pr.dmg > 0) {
        hurtPlayer(hitPlayer, pr.dmg, null, ev, { at: [p0[0], p0[1], p0[2]] });
        if (pr.slow) ev.push({ type: 'slow', id: hitPlayer.id, mul: pr.slow.mul, ms: pr.slow.ms });
      }
      if (pr.blast) explodeAt(at, pr.blast.r, pr.blast.dmg * dmgMul(S.stage), null, ev, 'barrel');
      if (pr.pool) {
        const gy = world ? getGroundY(world, at[0], at[2], at[1] + 0.5) : 0;
        addHazard(pr.pool.kind, at[0], gy, at[2], pr.pool);
      }
      if (!pr.blast && !hitPlayer) addFx('splat', at, 0.8);
    }
  }
  function stepHazards(dt, ev) {
    for (let i = hazards.length - 1; i >= 0; i--) {
      const h = hazards[i];
      if (S.clock >= h.until) { hazards.splice(i, 1); continue; }
      if (!(h.dps > 0)) continue;
      h.tick += dt;
      if (h.tick < 0.5) continue;
      const k = h.tick;
      h.tick = 0;
      for (const P of aliveList()) {
        if (!P.pos) continue;
        if (hyp2(P.pos[0] - h.x, P.pos[2] - h.z) <= h.r && Math.abs(P.pos[1] - h.y) < 1.2) hurtPlayer(P, h.dps * k, null, ev, { at: [h.x, h.y + 0.5, h.z] });
      }
    }
  }

  /* ------------------------------------------------------------------ 보스 스킬 */
  function trySkill(Z, T, ev) {
    if (Z.state !== 'move' || !T.pos) return false;
    const b = Z.boss;
    const p = Z.body.pos;
    const d = hyp2(T.pos[0] - p[0], T.pos[2] - p[2]);
    const cdMul = Z.enraged ? b.enrage.cd : 1;
    for (let i = 0; i < b.skills.length; i++) {
      const s = b.skills[i];
      if (S.clock < Z.skillReady[i]) continue;
      // 스킬마다 쓰기 좋은 거리
      const ok = s.kind === 'charge' ? d > 5 && d < 26
        : s.kind === 'slam' ? d < s.radius * 0.9
          : s.kind === 'nova' ? d < s.radius * 0.95
            : s.kind === 'leap' ? d > 6 && d < 28
              : s.kind === 'blink' ? d > 6
                : s.kind === 'chain' ? d < s.range
                  : s.kind === 'volley' || s.kind === 'pool' ? d > 3 && d < 30
                    : s.kind === 'scream' ? d < s.radius
                      : true;
      if (!ok) continue;
      if ((s.kind === 'volley' || s.kind === 'chain' || s.kind === 'pool') && world &&
        !lineOfSight(world, [p[0], p[1] + 2, p[2]], [T.pos[0], T.pos[1] + 1.2, T.pos[2]])) continue;
      Z.skillReady[i] = S.clock + s.cd * cdMul * (0.9 + rng() * 0.25);
      Z.skill = { i, s, phase: 'wind', until: S.clock + s.windup, tx: T.pos[0], ty: T.pos[1], tz: T.pos[2], target: T.id, t0: S.clock, hit: new Set(), r: 0 };
      Z.body.vel[0] = Z.body.vel[2] = 0;
      ev.push({ type: 'skill', z: Z.id, boss: b.id, kind: s.kind, x: Math.round(T.pos[0] * 100) / 100, z2: Math.round(T.pos[2] * 100) / 100, ms: s.windup });
      return true;
    }
    return false;
  }

  function stepSkill(Z, T, dt, ev) {
    const k = Z.skill;
    const s = k.s;
    const p = Z.body.pos;
    const rage = Z.enraged ? Z.boss.enrage : null;
    const dmgK = dmgMul(S.stage) * (rage ? rage.dmg : 1);
    if (k.phase === 'wind') {
      if (s.kind === 'charge' || s.kind === 'leap' || s.kind === 'volley' || s.kind === 'chain' || s.kind === 'pool') {
        // 예고 동안은 목표를 따라 돈다(마지막 0.3초는 고정 → 피할 틈)
        if (T && T.pos && k.until - S.clock > 300) { k.tx = T.pos[0]; k.ty = T.pos[1]; k.tz = T.pos[2]; }
        faceTo(Z, k.tx, k.tz, dt, 6);
      }
      if (world) moveCharacter(world, Z.body, { x: 0, z: 0 }, dt, { radius: Z.radius });
      if (S.clock < k.until) return;
      k.phase = 'act';
      k.t0 = S.clock;
      switch (s.kind) {
        case 'charge': {
          const dx = k.tx - p[0], dz = k.tz - p[2], l = hyp2(dx, dz) || 1;
          k.dx = dx / l; k.dz = dz / l; k.until = S.clock + s.maxMs;
          break;
        }
        case 'slam': {
          addFx('slam', p, s.radius);
          for (const P of aliveList()) {
            if (!P.pos) continue;
            const d = hyp2(P.pos[0] - p[0], P.pos[2] - p[2]);
            if (d <= s.radius && Math.abs(P.pos[1] - p[1]) < 2.5) {
              hurtPlayer(P, s.dmg * dmgK * (1 - 0.4 * d / s.radius), Z, ev);
              knock(P, p, s.knock, ev);
            }
          }
          Z.skill = null;
          return;
        }
        case 'nova': k.until = S.clock + (s.radius / s.speed) * 1000; addFx(s.shock ? 'shock' : 'nova', p, s.radius); break;
        case 'leap': {
          k.from = p.slice();
          const n = nav && nav.nearestWalkable ? nav.nearestWalkable({ x: k.tx, y: k.ty, z: k.tz }, 3) : null;
          k.to = n ? [n.x, n.y, n.z] : [k.tx, k.ty, k.tz];
          k.until = S.clock + s.flightMs;
          break;
        }
        case 'blink': {
          if (T && T.pos) {
            const dx = T.pos[0] - p[0], dz = T.pos[2] - p[2], l = hyp2(dx, dz) || 1;
            const want = { x: T.pos[0] + (dx / l) * s.behind, y: T.pos[1], z: T.pos[2] + (dz / l) * s.behind };
            const n = nav && nav.nearestWalkable ? nav.nearestWalkable(want, 3) : null;
            if (n) { addFx('blink', p, 1.5); p[0] = n.x; p[1] = n.y; p[2] = n.z; addFx('blink', p, 1.5); Z.node = -1; faceTo(Z, T.pos[0], T.pos[2], 1, 100); }
            Z.attackReady = S.clock + 250;
          }
          Z.skill = null;
          return;
        }
        case 'summon': {
          const t = ZOMBIE_TYPES[s.type] || ZOMBIE_TYPES.walker;
          let have = 0;
          for (const O of zombies.values()) if (O.summoned && O.state !== 'dead') have++;
          const n = Math.min(s.n, Math.max(0, R.maxSummons - have));
          for (let i = 0; i < n; i++) {
            const a = (i / Math.max(1, n)) * Math.PI * 2 + rng();
            const want = { x: p[0] + Math.cos(a) * s.radius, y: p[1], z: p[2] + Math.sin(a) * s.radius };
            const w = nav && nav.nearestWalkable ? nav.nearestWalkable(want, 3) : null;
            makeZombie({ type: t.id }, w ? [w.x, w.y, w.z] : [want.x, p[1], want.z], { summoned: true, hpMul: 0.8 });
          }
          addFx('summon', p, s.radius);
          Z.skill = null;
          return;
        }
        case 'volley': {
          const from = [p[0], p[1] + 1.8 * Math.min(1.4, Z.scale), p[2]];
          const to = [k.tx, k.ty + 1.0, k.tz];
          const n = Math.max(1, s.count);
          for (let i = 0; i < n; i++) {
            const off = (i - (n - 1) / 2) * s.fan;
            const dx = to[0] - from[0], dz = to[2] - from[2];
            const c = Math.cos(off), sn = Math.sin(off);
            const aim = [from[0] + dx * c - dz * sn, to[1], from[2] + dx * sn + dz * c];
            addProjectile(PROJECTILE_KINDS[s.proj] || 1, from, aimVelocity(from, aim, s.speed, !!s.arc), {
              arc: !!s.arc, dmg: (s.dmg || 0) * dmgK, blast: s.blast || null, pool: s.pool || null, slow: s.slow || null, life: 4000
            });
          }
          Z.skill = null;
          return;
        }
        case 'pool': {
          addHazard(s.hazard.kind, k.tx, k.ty, k.tz, s.hazard);
          Z.skill = null;
          return;
        }
        case 'scream': {
          addFx('scream', p, s.radius);
          for (const P of aliveList()) {
            if (P.pos && hyp2(P.pos[0] - p[0], P.pos[2] - p[2]) <= s.radius) ev.push({ type: 'slow', id: P.id, mul: s.slow, ms: s.ms });
          }
          for (const O of zombies.values()) {
            if (O.state === 'dead' || O === Z) continue;
            if (hyp2(O.body.pos[0] - p[0], O.body.pos[2] - p[2]) <= s.radius) { O.hasteUntil = S.clock + s.hasteMs; O.hasteMul = 1 + s.haste; }
          }
          Z.skill = null;
          return;
        }
        case 'armor': Z.armorUntil = S.clock + s.ms; Z.armorMul = 1 - s.reduce; Z.skill = null; return;
        case 'heal': {
          addFx('heal', p, s.radius);
          for (const O of zombies.values()) {
            if (O.state === 'dead') continue;
            if (O === Z) { O.hp = Math.min(O.maxHp, O.hp + O.maxHp * (s.self || 0)); continue; }
            if (hyp2(O.body.pos[0] - p[0], O.body.pos[2] - p[2]) <= s.radius) O.hp = Math.min(O.maxHp, O.hp + O.maxHp * s.frac);
          }
          Z.skill = null;
          return;
        }
        case 'chain': {
          const pts = [[p[0], p[1] + 2.2, p[2]]];
          let cur = [p[0], p[1] + 1.2, p[2]];
          const hit = new Set();
          let dmg = s.dmg * dmgK;
          for (let j = 0; j < s.jumps; j++) {
            let best = null, bd = j === 0 ? s.range : 9;
            for (const P of aliveList()) {
              if (!P.pos || hit.has(P.id)) continue;
              const d = Math.hypot(P.pos[0] - cur[0], P.pos[1] + 1 - cur[1], P.pos[2] - cur[2]);
              if (d < bd && (!world || lineOfSight(world, cur, [P.pos[0], P.pos[1] + 1.2, P.pos[2]]))) { bd = d; best = P; }
            }
            if (!best) break;
            hit.add(best.id);
            hurtPlayer(best, dmg, Z, ev);
            cur = [best.pos[0], best.pos[1] + 1.2, best.pos[2]];
            pts.push(cur);
            dmg *= 0.8;
          }
          if (pts.length > 1) ev.push({ type: 'chain', z: Z.id, pts: pts.map((q) => q.map((v) => Math.round(v * 100) / 100)) });
          Z.skill = null;
          return;
        }
        default: Z.skill = null; return;
      }
    }
    // act 단계(시간이 걸리는 스킬)
    switch (s.kind) {
      case 'charge': {
        const sp = s.speed * (rage ? rage.speed : 1);
        const before = [p[0], p[2]];
        if (world) moveCharacter(world, Z.body, { x: k.dx * sp, z: k.dz * sp }, dt, { radius: Z.radius, accel: 200 });
        else { p[0] += k.dx * sp * dt; p[2] += k.dz * sp * dt; }
        const moved = hyp2(p[0] - before[0], p[2] - before[1]);
        for (const P of aliveList()) {
          if (!P.pos || k.hit.has(P.id)) continue;
          if (hyp2(P.pos[0] - p[0], P.pos[2] - p[2]) <= s.width * 0.5 + PLAYER_R + 0.3 && Math.abs(P.pos[1] - p[1]) < 2) {
            k.hit.add(P.id);
            hurtPlayer(P, s.dmg * dmgK, Z, ev);
            knock(P, p, s.knock, ev);
          }
        }
        // 벽에 부딪혔거나 시간이 다 됐으면 끝
        if (S.clock >= k.until || (S.clock - k.t0 > 150 && moved < sp * dt * 0.3)) { Z.skill = null; Z.attackReady = S.clock + 600; }
        return;
      }
      case 'nova': {
        const r = s.speed * (S.clock - k.t0) / 1000;
        k.r = r;
        for (const P of aliveList()) {
          if (!P.pos || k.hit.has(P.id)) continue;
          const d = hyp2(P.pos[0] - p[0], P.pos[2] - p[2]);
          if (Math.abs(d - r) > s.width * 0.5) continue;
          // 점프로 피한다: 발이 바닥에서 0.45 m 넘게 떠 있으면 넘어간다
          const gy = world ? getGroundY(world, P.pos[0], P.pos[2], P.pos[1] + 0.1) : 0;
          k.hit.add(P.id);
          if (P.pos[1] - gy > 0.45) continue;
          hurtPlayer(P, s.dmg * dmgK, Z, ev);
        }
        if (world) moveCharacter(world, Z.body, { x: 0, z: 0 }, dt, { radius: Z.radius });
        if (S.clock >= k.until) Z.skill = null;
        return;
      }
      case 'leap': {
        const f = clamp((S.clock - k.t0) / s.flightMs, 0, 1);
        p[0] = k.from[0] + (k.to[0] - k.from[0]) * f;
        p[2] = k.from[2] + (k.to[2] - k.from[2]) * f;
        p[1] = k.from[1] + (k.to[1] - k.from[1]) * f + Math.sin(f * Math.PI) * 5;
        Z.body.vel[0] = Z.body.vel[1] = Z.body.vel[2] = 0;
        faceTo(Z, k.to[0], k.to[2], dt, 10);
        if (f >= 1) {
          p[1] = k.to[1];
          Z.body.onGround = true;
          Z.node = -1;
          addFx('slam', p, s.radius);
          for (const P of aliveList()) {
            if (!P.pos) continue;
            const d = hyp2(P.pos[0] - p[0], P.pos[2] - p[2]);
            if (d <= s.radius && Math.abs(P.pos[1] - p[1]) < 2.5) { hurtPlayer(P, s.dmg * dmgK * (1 - 0.4 * d / s.radius), Z, ev); knock(P, p, 7, ev); }
          }
          Z.skill = null;
          Z.attackReady = S.clock + 500;
        }
        return;
      }
      default: Z.skill = null;
    }
  }

  function knock(P, from, power, ev) {
    if (!P.pos || !(power > 0)) return;
    const dx = P.pos[0] - from[0], dz = P.pos[2] - from[2], l = hyp2(dx, dz) || 1;
    ev.push({ type: 'knock', id: P.id, v: [Math.round((dx / l) * power * 100) / 100, 4, Math.round((dz / l) * power * 100) / 100] });
  }

  /* ------------------------------------------------------------------ 한 간격 */
  function stepOnce(ms, ev) {
    S.clock += ms;
    const dt = ms / 1000;
    if (S.phase === 'prep' && S.clock >= S.phaseEnd) beginStage(ev);
    else if (S.phase === 'cards' && (S.clock >= S.phaseEnd || allPicked())) endCards(ev);
    else if (S.phase === 'break' && S.clock >= S.phaseEnd) endBreak(ev);
    else if (S.phase === 'over') return;
    if (!connected().length) { if (S.phase !== 'over' && S.phase !== 'warmup') gameOver(ev, 'left'); return; }
    // 사람: 회복
    for (const P of players.values()) {
      if (!P.alive || !(P.perks.regen > 0) || S.phase !== 'wave') continue;
      P.regenAcc += P.perks.regen * dt;
      if (P.regenAcc >= 1) { const n = Math.floor(P.regenAcc); P.regenAcc -= n; healPlayer(P, n); }
    }
    if (S.phase !== 'wave') return;
    readPositions();
    updateFlow();
    spawnTick(ev);
    rebuildGrid();
    for (const Z of zombies.values()) {
      if (S.phase !== 'wave') break;
      stepZombie(Z, dt, ev);
    }
    if (S.phase !== 'wave') return;
    stepProjectiles(dt, ev);
    stepHazards(dt, ev);
    // 쓰러진 좀비 정리
    for (const [id, Z] of zombies) if (Z.state === 'dead' && S.clock - Z.deadAt > DEAD_KEEP_MS) zombies.delete(id);
    for (let i = fxList.length - 1; i >= 0; i--) if (S.clock - fxList[i].at > FX_KEEP_MS) fxList.splice(i, 1);
    if (S.phase === 'wave' && !S.queue.length && ![...zombies.values()].some((Z) => Z.state !== 'dead')) clearStage(ev);
  }

  function tick(dtMs) {
    if (S.disposed || S.phase === 'warmup') return [];
    const ev = [];
    const d = num(dtMs, 0);
    if (!(d > 0)) return ev;
    acc += Math.min(d, 2000);
    let n = 0;
    while (acc >= STEP_MS && n < 90) { acc -= STEP_MS; stepOnce(STEP_MS, ev); n++; }
    return ev;
  }

  /* ------------------------------------------------------------------ 사람 들고 나감 */
  function addPlayer(p) {
    if (!p || p.id == null) return [];
    const id = String(p.id);
    const old = players.get(id);
    if (old) {
      if (old.connected) { if (p.name) old.name = String(p.name).slice(0, 24); return []; }
      old.connected = true;
      return [{ type: 'join', id, name: old.name, playing: false }];
    }
    if (connected().length >= R.maxPlayers) return [{ type: 'reject', reason: 'full', id }];
    const P = makePlayer(p);
    players.set(id, P);
    const ev = [{ type: 'join', id, name: P.name, playing: false }];
    // 준비 중이면 바로 나오고, 아니면 다음 스테이지에 나온다(카드 단계면 이번 제안부터)
    if (S.phase === 'prep') spawnPlayer(P, players.size - 1, ev);
    else if (S.phase === 'cards') P.offer = { cards: makeOffer({ seed, playerId: P.id, stage: S.stage, roll: 0, taken: [], count: 3 }), roll: 0, rerolls: 1, count: 3 };
    return ev;
  }

  function removePlayer(id) {
    const P = players.get(String(id));
    if (!P || !P.connected) return [];
    P.connected = false;
    const ev = [{ type: 'leave', id: P.id }];
    if (P.alive) { P.alive = false; }
    if (S.phase === 'cards' && allPicked() && connected().length) setPhase('break', R.breakMs, ev, { next: S.stage + 1 });
    if (!connected().length) gameOver(ev, 'left');
    else if (S.phase === 'wave' && !aliveList().length) gameOver(ev, 'wiped');
    return ev;
  }

  /* ------------------------------------------------------------------ 스냅샷 */
  function snapshot() {
    const now = S.clock;
    const p = [];
    for (const P of players.values()) {
      const hurt = P.hurtFrom && now - P.hurtAt < HURT_KEEP_MS ? [cm(P.hurtFrom[0]), cm(P.hurtFrom[2]), Math.round(now - P.hurtAt)] : 0;
      p.push([
        P.id, P.name, Math.round(P.hp), P.maxHp, P.alive ? 1 : 0, P.kills, P.connected ? 1 : 0, encodeCards(P.cards),
        P.offer ? encodeCards(P.offer.cards) : '', P.offer ? P.offer.rerolls : 0, P.picked ? 1 : 0, P.downs, Math.round(P.damage),
        Math.round(P.shield), P.heads, P.bossKills, hurt, P.spawned ? 1 : 0
      ]);
    }
    const z = [];
    const killers = [];
    const pids = [...players.keys()];
    for (const Z of zombies.values()) {
      let f = 0;
      if (Z.state === 'dead') f |= ZF.dead;
      if (Z.state === 'wind' || (Z.skill && Z.skill.phase === 'wind')) f |= ZF.wind;
      if (Z.state === 'rise') f |= ZF.rise;
      if (Z.slowUntil > now) f |= ZF.slow;
      if (Z.hasteUntil > now) f |= ZF.haste;
      if (Z.armorUntil > now) f |= ZF.armor;
      if (Z.enraged) f |= ZF.rage;
      if (Z.skill && Z.skill.s.kind === 'leap' && Z.skill.phase === 'act') f |= ZF.air;
      const row = [Z.id, Z.code, cm(Z.body.pos[0]), cm(Z.body.pos[1]), cm(Z.body.pos[2]), Math.round(Z.yaw * 100), Math.ceil((Z.hp / Z.maxHp) * 100), f];
      if (Z.state === 'dead' && Z.killer) { const i = pids.indexOf(Z.killer); if (i >= 0) killers.push([Z.id, i]); }
      z.push(row);
    }
    const b = [];
    for (const Z of zombies.values()) {
      if (!Z.boss || Z.state === 'dead') continue;
      const k = Z.skill;
      b.push([Z.id, Z.boss.code, Math.round(Z.hp), Z.maxHp, k ? SKILL_KINDS[k.s.kind] : 0, k ? (k.phase === 'wind' ? 1 : 2) : 0,
        k ? cm(k.tx) : 0, k ? cm(k.tz) : 0, k ? Math.max(0, Math.round(k.until - now)) : 0, k ? Math.round((k.r || 0) * 100) : 0, Z.enraged ? 1 : 0]);
    }
    const pr = projectiles.map((q) => [q.id, q.kind, cm(q.pos[0]), cm(q.pos[1]), cm(q.pos[2]), cm(q.vel[0]), cm(q.vel[1]), cm(q.vel[2]), q.arc ? 1 : 0]);
    const hz = hazards.map((h) => [h.id, h.kind, cm(h.x), cm(h.y), cm(h.z), cm(h.r), Math.max(0, Math.round(h.until - now)), h.ms]);
    const fx = fxList.map((e) => [e.id, e.kind, cm(e.x), cm(e.y), cm(e.z), cm(e.r), Math.round(now - e.at)]);
    let alive = 0;
    for (const Z of zombies.values()) if (Z.state !== 'dead') alive++;
    return {
      v: HORDE_SNAPSHOT_VERSION,
      ph: S.phase === 'over' ? 'matchEnd' : S.phase === 'warmup' ? 'warmup' : 'live',
      zp: PHASE_CODE[S.phase], st: S.stage, tl: S.phaseEnd ? Math.max(0, Math.round(S.phaseEnd - now)) : null,
      el: S.startedAt == null ? 0 : Math.round((S.endedAt != null ? S.endedAt : now) - S.startedAt),
      sd: seed, left: S.queue.length + alive, tot: S.total, kd: S.killedStage, rb: S.recentBosses.slice(0, 10), fs: S.firstStage,
      p, z, kz: killers, b, pr, hz, fx, over: S.over
    };
  }

  function dispose() { S.disposed = true; zombies.clear(); players.clear(); projectiles.length = 0; hazards.length = 0; }

  /** 방장 이전: 스냅샷의 단계·사람·좀비를 이어받는다(좀비 판단·보스 스킬 시간은 처음부터) */
  function restoreFrom(view) {
    if (!view) return;
    S.stage = view.stage;
    S.firstStage = Math.max(1, view.firstStage || 1);
    S.startedAt = 0;
    S.clock = Math.max(0, view.elapsedMs || 0);
    S.recentBosses = (view.recentBosses || []).slice(0, 10);
    S.total = view.total || 0;
    S.killedStage = view.killedStage || 0;
    for (const vp of view.players) {
      let P = players.get(vp.id);
      if (!P) { P = makePlayer({ id: vp.id, name: vp.name }); P.connected = false; players.set(vp.id, P); }
      P.cards = vp.cards.slice();
      refreshStats(P);
      P.hp = vp.hp; P.alive = !!vp.alive && P.connected; P.spawned = !!vp.spawned;
      P.kills = vp.kills; P.heads = vp.heads; P.bossKills = vp.bossKills; P.damage = vp.damage; P.downs = vp.downs; P.shield = vp.shield;
      P.picked = !!vp.picked;
      P.offer = vp.offer.length ? { cards: vp.offer.slice(), roll: 5, rerolls: vp.rerolls, count: vp.offer.length } : null;
    }
    const phase = view.phase;
    if (phase === 'wave') {
      let alive = 0;
      for (const vz of view.zombies) {
        if (vz.dead) continue;
        const spec = vz.boss ? { boss: vz.boss.id } : { type: (vz.type || ZOMBIE_TYPES.walker).id };
        const Z = makeZombie(spec, vz.pos.slice());
        // 번호를 그대로 이어 써서 화면의 좀비가 바뀌지 않게 한다
        zombies.delete(Z.id);
        Z.id = vz.id;
        zombies.set(Z.id, Z);
        S.nextZ = Math.max(S.nextZ, vz.id + 1);
        Z.hp = Math.max(1, Math.round(Z.maxHp * vz.hpFrac));
        Z.state = 'move'; Z.yaw = vz.yaw;
        if (Z.boss) { const vb = view.bosses.find((x) => x.id === vz.id); if (vb) { Z.maxHp = vb.maxHp; Z.hp = Math.max(1, vb.hp); } }
        alive++;
      }
      const mix = zombieMix(S.stage);
      for (let i = Math.max(0, view.left - alive); i > 0; i--) S.queue.push({ type: pickWeighted(mix, rng).type.id });
      S.phase = 'wave';
      S.spawnAt = S.clock + 1500;
    } else if (phase === 'cards') { S.phase = 'cards'; S.phaseEnd = S.clock + Math.max(5000, view.timeLeftMs || R.cardMs); }
    else if (phase === 'break' || phase === 'prep') { S.phase = phase; S.phaseEnd = S.clock + Math.max(1500, view.timeLeftMs || R.breakMs); }
    else { S.phase = 'break'; S.phaseEnd = S.clock + R.breakMs; }
    S.startedAt = 0;
  }
  if (o.restore) restoreFrom(o.restore);

  return {
    start, tick, claimHit, claimExplosion, cardAction, addPlayer, removePlayer, snapshot, dispose,
    /** 세션의 방장 루프가 부르는 match.js 메서드 중 이 모드에서 할 일이 없는 것 */
    setLoadout: () => [],
    respawnNow: () => [{ type: 'reject', reason: 'not_ffa' }],
    bombIntent: () => [{ type: 'reject', reason: 'not_bomb' }],
    get phase() { return S.phase; },
    get stage() { return S.stage; },
    get seed() { return seed; },
    get rules() { return R; },
    get mode() { return 'zombie'; },
    /** 시험·디버그용 내부(읽기 전용으로 쓸 것) */
    get internals() { return { S, zombies, players, projectiles, hazards, fxList }; },
    /** 이어받기(restoreHorde) 뒤 바로 다음 단계를 시작할 때 쓴다 */
    resume() {
      const ev = [];
      if (S.phase === 'wave') {
        let i = 0;
        for (const P of players.values()) if (P.connected && P.alive) ev.push({ type: 'spawn', id: P.id, spawn: null, hp: P.hp, maxHp: P.maxHp, keep: true, i: i++ });
        ev.push({ type: 'phase', phase: 'wave', stage: S.stage, ms: 0, resumed: true });
      } else ev.push({ type: 'phase', phase: S.phase, stage: S.stage, ms: S.phaseEnd ? Math.round(S.phaseEnd - S.clock) : 0, resumed: true });
      return ev;
    }
  };
}

/* ====================================================================== 화면용 풀기 */

/** 스냅샷 → 화면용 뷰. 형식이 틀리면 null(던지지 않는다) */
export function applyHordeSnapshot(s) {
  if (!s || typeof s !== 'object' || s.v !== HORDE_SNAPSHOT_VERSION || !Array.isArray(s.p) || !Array.isArray(s.z)) return null;
  const phase = HORDE_PHASES[s.zp | 0] || 'warmup';
  const players = [];
  for (const r of s.p) {
    if (!Array.isArray(r) || r.length < 12) continue;
    const hurt = Array.isArray(r[16]) ? { x: fromCm(r[16][0]), z: fromCm(r[16][1]), ago: num(r[16][2]) } : null;
    players.push({
      id: String(r[0]), name: String(r[1] || ''), hp: num(r[2]), maxHp: Math.max(1, num(r[3], 100)), alive: !!r[4], kills: num(r[5]) | 0,
      connected: !!r[6], cards: decodeCards(r[7]), offer: decodeCards(r[8]), rerolls: num(r[9]) | 0, picked: !!r[10], downs: num(r[11]) | 0,
      damage: num(r[12]) | 0, shield: num(r[13]) | 0, heads: num(r[14]) | 0, bossKills: num(r[15]) | 0, hurt, spawned: r[17] === undefined ? true : !!r[17]
    });
  }
  const zombies = [];
  for (const r of s.z) {
    if (!Array.isArray(r) || r.length < 8) continue;
    const code = num(r[1]) | 0;
    const boss = code >= BOSS_CODE_BASE ? bossByCode(code - BOSS_CODE_BASE) : null;
    const type = boss ? null : zombieByCode(code);
    if (!boss && !type) continue;
    const f = num(r[7]) | 0;
    zombies.push({
      id: num(r[0]) | 0, code, boss, type, pos: [fromCm(r[2]), fromCm(r[3]), fromCm(r[4])], yaw: num(r[5]) / 100,
      hpFrac: clamp(num(r[6]) / 100, 0, 1), flags: f, dead: !!(f & ZF.dead)
    });
  }
  const pids = players.map((p) => p.id);
  const killers = new Map();
  for (const r of Array.isArray(s.kz) ? s.kz : []) if (Array.isArray(r) && pids[r[1]]) killers.set(num(r[0]) | 0, pids[r[1]]);
  for (const z of zombies) if (z.dead && killers.has(z.id)) z.killer = killers.get(z.id);
  const bosses = [];
  for (const r of Array.isArray(s.b) ? s.b : []) {
    const def = Array.isArray(r) ? bossByCode(r[1]) : null;
    if (!def) continue;
    bosses.push({
      id: num(r[0]) | 0, def, hp: num(r[2]), maxHp: Math.max(1, num(r[3], 1)), skill: num(r[4]) | 0, skillPhase: num(r[5]) | 0,
      target: [fromCm(r[6]), fromCm(r[7])], skillLeftMs: num(r[8]), ringR: num(r[9]) / 100, enraged: !!r[10]
    });
  }
  const projectiles = (Array.isArray(s.pr) ? s.pr : []).filter(Array.isArray).map((r) => ({
    id: num(r[0]) | 0, kind: num(r[1]) | 0, pos: [fromCm(r[2]), fromCm(r[3]), fromCm(r[4])], vel: [fromCm(r[5]), fromCm(r[6]), fromCm(r[7])], arc: !!r[8]
  }));
  const hazards = (Array.isArray(s.hz) ? s.hz : []).filter(Array.isArray).map((r) => ({
    id: num(r[0]) | 0, kind: num(r[1]) | 0, pos: [fromCm(r[2]), fromCm(r[3]), fromCm(r[4])], r: fromCm(r[5]), leftMs: num(r[6]), ms: Math.max(1, num(r[7], 1))
  }));
  const fx = (Array.isArray(s.fx) ? s.fx : []).filter(Array.isArray).map((r) => ({
    id: num(r[0]) | 0, kind: String(r[1] || ''), pos: [fromCm(r[2]), fromCm(r[3]), fromCm(r[4])], r: fromCm(r[5]), ago: num(r[6])
  }));
  return {
    mode: 'zombie', phase, stage: num(s.st) | 0, firstStage: Math.max(1, num(s.fs, 1) | 0), timeLeftMs: s.tl == null ? null : num(s.tl), elapsedMs: num(s.el), seed: num(s.sd) >>> 0,
    left: num(s.left) | 0, total: num(s.tot) | 0, killedStage: num(s.kd) | 0, recentBosses: Array.isArray(s.rb) ? s.rb.map(String) : [],
    players, zombies, bosses, projectiles, hazards, fx, over: s.over && typeof s.over === 'object' ? { ...s.over } : null
  };
}

/** 방장 이전: 스냅샷으로 새 방장의 시뮬레이션을 만든다 */
export function restoreHorde(snapshot, opts = {}) {
  const view = applyHordeSnapshot(snapshot);
  if (!view) return null;
  const players = (opts.players || []).map((p) => ({ id: p.id, name: p.name }));
  return createHorde({ ...opts, players, seed: view.seed, restore: view, startStage: 1 });
}

/** 방장 화면 결과 요약(계정 기록용): 내 처치·헤드샷·도달 스테이지 */
export function hordeSummary(view, meId) {
  const me = view && view.players ? view.players.find((p) => p.id === meId) : null;
  const over = (view && view.over) || {};
  return {
    stage: num(over.stage, view ? view.stage : 0) | 0, cleared: num(over.cleared, view ? Math.max(0, view.stage - view.firstStage) : 0) | 0, ms: num(over.ms, view ? view.elapsedMs : 0),
    kills: me ? me.kills : 0, heads: me ? me.heads : 0, bossKills: me ? me.bossKills : 0, downs: me ? me.downs : 0, damage: me ? me.damage : 0,
    cards: me ? me.cards.length : 0
  };
}

export { isZombieId, BOSS_CODE_BASE, BOSSES };
