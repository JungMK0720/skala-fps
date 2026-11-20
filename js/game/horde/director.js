/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 좀비 물량 막기의 방장 시뮬레이션. 스테이지 진행(준비 → 40초 스테이지가 이어짐. 시간 안에 다 잡으면 남은 1초당 경험치 1을 받고
 *          바로 다음 스테이지), 팀 경험치·레벨업, 증강 제안·선택(혼자면 고르는 동안 좀비·시간이 멈추고, 멀티는 고르는 사람만 무적이고 좀비도 노리지 않는다 ·
 *          20초 안에 안 고르면 무작위 · 고른 뒤 멀티 2초/혼자 3초 무적), 좀비 생성·길찾기·공격, 보스 스킬, 투사체·장판,
 *          피해 확정(맞은 뒤 0.1초 무적 · 밀려남), 검기 판정, 쓰러진 동료 살리기(멀티 · F 3초), 바닥 보급품(구급 상자·탄창·보스의 보물 상자),
 *          수류탄 증강(불길·빙결·분신), 스냅샷과 방장 이전 복원을 맡는다.
 *          연습장(혼자)과 멀티 방장이 같은 코드를 돈다.
 *          match.js와 같은 모양(start·tick·claimHit·claimExplosion·addPlayer·removePlayer·snapshot)이라 세션의 방장 루프를 그대로 쓴다.
 *          three.js·DOM에 의존하지 않는다.
 */
/**
 * const d = createHorde({ players: [{ id, name }], world, nav, spawns, getPositions, seed });
 * let ev = d.start();             // 준비(12초, 무기를 고르는 때) → 1스테이지
 * ev = d.tick(dtMs);               // 방장 루프. 안에서 30 Hz 고정 간격으로 나눠 돈다
 * ev = d.claimHit({ attackerId, victimId: 'z12', weaponId, part, dist, kind, count, shotId });
 * ev = d.claimExplosion({ attackerId, center, victims: [{ id: 'z3', dmg }] });
 * ev = d.cardAction(playerId, 'pick' | 'reroll', cardId?);
 * ev = d.claimLoot(playerId, lootId);   // 바닥 보급품(탄창·구급 상자·보물 상자) 줍기. 방장이 거리를 보고 확정한다
 * ev = d.reviveAction(playerId, targetId, on);   // (멀티) 쓰러진 동료 살리기. 화면이 F를 누르는 동안 0.3초마다 보내고, 떼면 on = false
 * const snap = d.snapshot();       // 화면(horde/client.js)이 applyHordeSnapshot으로 푼다
 *
 * 이벤트는 드문 일만 낸다(단계 전환·출격·쓰러짐·동료가 살림·보스·카드·레벨업·스테이지 클리어·밀려남·느려짐·보급품 줍기·끝). 좀비 위치·체력, 사람 체력,
 * 경험치, 폭발, 바닥 보급품, 불길·분신, 좀비에게 맞아 밀려남, 쓰러진 자리와 살리는 진행 같은 잦은 일은 스냅샷에 싣는다.
 * 세션의 이벤트는 3초 동안 스냅샷마다 다시 실리기 때문이다(SYNC_API.md 2절).
 * 좀비 전용 맵(o.gates)이면 좀비는 그 좀비 문에서만 나온다.
 */
import { moveCharacter, lineOfSight, getGroundY, raycastWorld } from '../../engine/physics.js';
import { PLAYER } from '../../core/consts.js';
import { computeDamage, getDef, explosionFalloff } from '../../weapons/defs.js';
import {
  HORDE, ZOMBIE_TYPES, zombieByCode, zombieCount, hpMul, dmgMul, speedMul, spawnGapMs, spawnBurst, bossCount, bossHpMul,
  zombieMix, makeRng, hashSeed, pickWeighted, LOOT_TYPES, lootByCode, rollDrop, zombieXp, xpNeed, timeBonusXp, frostSlowMs
} from './rules.js';
import { computePerks, perkMaxHp, makeOffer, encodeCards, decodeCards, cardById } from './cards.js';
import { BOSSES, bossById, bossByCode, pickBosses, SKILL_KINDS, HAZARD_KINDS, PROJECTILE_KINDS } from './bosses.js';

export const HORDE_SNAPSHOT_VERSION = 2;
/** 단계(스냅샷 zp). 'cards' = 증강을 고르는 동안(좀비·스테이지 시간이 멈춘다). 'break'는 예전 쉬는 시간 자리라 쓰지 않는다 */
export const HORDE_PHASES = Object.freeze(['warmup', 'prep', 'wave', 'cards', 'break', 'over']);
const PHASE_CODE = Object.freeze({ warmup: 0, prep: 1, wave: 2, cards: 3, break: 4, over: 5 });
/** 좀비 행의 깃발 비트 */
export const ZF = Object.freeze({ dead: 1, wind: 2, rise: 4, slow: 8, haste: 16, armor: 32, rage: 64, air: 128, frozen: 256, hook: 512 });
/** 사람이 만든 장판 종류(스냅샷 af) */
export const FIELD_KINDS = Object.freeze({ fire: 1 });
const DECOY_PREFIX = '#d';        // 분신 표적 번호(사람 id와 겹치지 않게)
const BOSS_CODE_BASE = 100;       // 좀비 행의 종류 번호가 이 값 이상이면 보스(100 + 보스 번호)
const DEAD_KEEP_MS = 1400;        // 쓰러진 좀비를 화면이 쓰러지는 모습을 그리도록 남겨 두는 시간
const FX_KEEP_MS = 700;           // 폭발 표시를 스냅샷에 남겨 두는 시간
const HURT_KEEP_MS = 900;         // 사람이 맞은 방향 표시를 남겨 두는 시간
const PLAYER_R = 0.35;
const EYE = 1.6;
const PIERCE_FALLOFF = 0.7;
const PIERCE_MIN = 0.3;           // 무제한 관통에서도 이만큼은 남는다(뚫을 때마다 70%, 최소 30%)
const GUARD_COS = 0.34;           // 방패: 바라보는 방향에서 이 각(약 70°) 안의 공격만 막는다
const DODGE_CAP = 0.9;            // 회피 확률 상한
const REDUCE_CAP = 0.9;           // 받는 피해 감소(방어·방패를 합친 값) 상한
const GRAVITY_PULL_MS = 2600;     // 특이점포에 끌려가는 시간
const GRAVITY_PULL_SPEED = 13;    // 끌려가는 속도(m/s)
const KNOCK_MAX_MS = 2500;       // 밀려 날아가는 최대 시간(땅에 닿으면 바로 끝난다)
const KNOCK_BOSS = 0.3;          // 보스는 이만큼만 밀린다
const MELEE_SLACK = 2.2;          // 칼 주장 거리 여유(m, 지연 보간 몫)
const RANGE_SLACK = 1.15;
const TARGET_MS = 500;
const LOS_MS = 300;
const JUMP_GAP_MS = 1100;
const STUCK_RECYCLE_MS = 9000;    // 이만큼 사람에게 다가가지 못한 좀비는 다른 자리에서 다시 나온다
const GRAVITY = -12;
const PULL_UP = 5 * Math.sqrt(5);   // 그랩에 끌려갈 때 위로 뜨는 속도: 예전 5 m/s보다 최고 높이 5배
const PLAYER_GRAVITY = PLAYER.GRAVITY;
const FLY_HEIGHT = 1.25;        // 비행 좀비가 바닥에서 나올 때의 발 높이(바닥 위 m)
const FLY_CRUISE = 5;           // 비행 좀비는 노리는 사람의 발보다 이만큼 높이 떠서 난다(지붕·차 위를 곧장 넘는다)
const FLY_CLIMB = 3.5;          // 오르내리는 속도(m/s)
const FLY_BODY = 1.4;           // 비행 좀비 몸 높이(천장과 띄우는 값)
const FLY_NAV_MS = 2500;        // 곧장 날다 막히면 이 시간 동안 바닥 길찾기 방향을 빌린다
const BOSS_BURN_MS = 5000;     // 40스테이지부터 보스에게 맞으면 5초 화상(초당 4 피해)
const BOSS_BURN_TICK_MS = 1000;
const BOSS_BURN_DAMAGE = 4;
const BOSS_STUN_MS = 2000;     // 50스테이지부터 보스에게 맞으면 2초 기절·띄우기
const BOSS_STUN_UP = 8;
const LEAP_LEAD_MAX = 12;      // 보스 도약이 사람의 움직임을 앞질러 잡는 최대 거리(m)
const VEL_MAX = 12;            // 사람 속도 추정의 상한(m/s). 부활·끌려감 같은 순간 이동이 튀지 않게
const NADE_RADIUS = (getDef('gr_frag') && getDef('gr_frag').explosion && getDef('gr_frag').explosion.radius) || 5;
// 질풍검(ml_yasuo): 10초 안에 두 번 맞히면 세 번째 공격이 바닥을 타고 앞으로 가는 충격파가 된다
const YASUO_STACK_MS = 10000;
const SWORD_WAVE_SPEED = 20;       // 충격파가 바닥을 타고 나아가는 속도(m/s)
const SWORD_WAVE_RANGE = 14;       // 충격파가 가는 거리(m)
const SWORD_WAVE_HALF0 = 1.0;      // 출발점의 반폭(m). 갈수록 넓어져 부채꼴로 퍼진다
const SWORD_WAVE_HALF1 = 2.2;      // 끝의 반폭(m)
const SWORD_WAVE_BOSS_MUL = 10;    // 충격파에 처음 맞은 보스 하나만 칼 피해 10배(나머지는 칼 피해 그대로)
const SWORD_WAVE_STAGGER_MS = 600; // 맞은 좀비가 비틀거려 멈추는 시간(보스는 절반)
const SWORD_WAVE_SLOW_MS = 2000;   // 그 뒤 느려지는 시간
const SWORD_WAVE_SLOW_MUL = 0.5;   // 느려지는 동안의 이동 속도 배율

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
 * @param {Array<{x,y,z}>} [o.gates]  좀비 문(좀비 전용 맵의 spawns.charterer, 바닥 높이 y 포함). 주면 좀비는 여기서만 나온다
 */
export function createHorde(o = {}) {
  const R = Object.freeze({ ...HORDE, ...(o.rules || {}) });
  const world = o.world || null;
  const nav = o.nav || null;
  const spawns = o.spawns || {};
  const gates = (Array.isArray(o.gates) ? o.gates : [])
    .filter((g) => g && Number.isFinite(+g.x) && Number.isFinite(+g.z))
    .map((g) => [+g.x, Number.isFinite(+g.y) ? +g.y : NaN, +g.z]);
  const getPositions = typeof o.getPositions === 'function' ? o.getPositions : () => ({});
  const seed = (num(o.seed, 0) >>> 0) || ((Math.random() * 4294967296) >>> 0) || 1;
  const rng = makeRng(hashSeed(seed, 'run'));
  const STEP_MS = 1000 / R.simHz;

  const S = {
    phase: 'warmup', stage: Math.max(0, (num(o.startStage, 1) | 0) - 1), firstStage: Math.max(1, num(o.startStage, 1) | 0), clock: 0, phaseEnd: 0, startedAt: null, endedAt: null,
    queue: [], spawnAt: 0, total: 0, killedStage: 0, nextZ: 1, nextFx: 1, nextProj: 1, nextHaz: 1, nextLoot: 1, nextField: 1, nextDecoy: 1,
    flowAt: -Infinity, flowOk: false, recentBosses: [], over: null, disposed: false,
    // 스테이지 시간(stageEnd = 끝나는 시각). 증강을 고르는 동안은 시계(clock)가 멈추므로 남은 시간도 그대로다
    stageEnd: 0, cardsLeft: 0, offerRound: 0,
    // 팀 경험치: level 1에서 시작, xp = 이번 레벨에서 모은 양, xpTotal = 판 전체
    level: 1, xp: 0, xpTotal: 0,
    tickAt: 0                         // 마지막 tick()이 시작한 시각(살리기 신호 끊김을 잰다)
  };
  const zombies = new Map();          // 번호 → 좀비
  const loot = new Map();             // 번호 → 바닥 보급품 { id, kind, x, y, z, until }
  const decoys = new Map();           // '#d번호' → 분신 { id, n, owner, pos, hp, maxHp, until, alive, decoy: true }
  const fields = [];                  // 사람이 만든 장판(화염 수류탄 불길) { id, kind, x, y, z, r, until, ms, dps, owner, tick }
  const players = new Map();          // id → 사람
  const projectiles = [];
  const hazards = [];
  const fxList = [];                  // { id, kind, x, y, z, r, at }
  const shotCounts = new Map();       // 사수 → { shotId, n } (관통 순서)
  const waveCounts = new Map();       // 사수 → Map(검기 shotId → 맞힌 수). 최근 검기 몇 개만 기억한다
  const swordWaves = [];              // 방장 판정 질풍검 충격파 { owner, pos, dir, left, hit, bossDone }

  const revives = new Map();          // 쓰러진 사람 id → { by: 살리는 사람 id, ms: 누른 시간, seen: 마지막 신호 시각 } (멀티)
  let acc = 0;

  /* ------------------------------------------------------------------ 사람 */
  function makePlayer(p) {
    const id = String(p.id);
    const P = {
      id, name: String(p.name || id).slice(0, 24), connected: true, alive: false, spawned: false,
      hp: R.baseHp, maxHp: R.baseHp, shield: 0, cards: [], perks: computePerks([]),
      kills: 0, heads: 0, bossKills: 0, damage: 0, downs: 0,
      offer: null, picked: false, secondUsed: false, regenAcc: 0, hurtAt: -Infinity, hurtFrom: null, pos: null,
      picks: 0, chestPicks: 0,        // 고를 증강 수(레벨업은 모두, 보물 상자는 주운 사람), 그중 보물 상자 몫
      offerUntil: 0, invulnUntil: 0,  // 이 제안의 마감 시각(멀티), 증강을 고른 뒤 무적이 끝나는 시각
      hitUntil: 0,                    // 맞은 뒤 무적이 끝나는 시각(HORDE.hitInvulnMs + 증강 '반사 신경')
      burnUntil: 0, burnNext: 0, noHealUntil: 0, // 보스 화상·마녀 저주 회복 금지(방장 이전에도 남긴다)
      vel: [0, 0, 0], movedAt: 0,     // 위치가 바뀐 간격으로 잰 수평 속도(m/s)와 마지막으로 움직인 시각. 보스 도약·침이 앞질러 노린다
      knockSeq: 0, knockAt: -Infinity, knockV: null,   // 좀비에게 맞아 밀려남: 번호, 시각, 속도 [x, y, z](m/s). 스냅샷에 knockKeepMs 동안 싣는다
      downPos: null, downAt: 0,       // 쓰러진 자리 [x, y, z]와 시각(멀티에서 동료가 여기서 살린다)
      yasuoHits: 0, yasuoExpires: 0, yasuoSwing: null, yasuoLastAt: -Infinity, yasuoLastShot: 0,
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
    if (P.noHealUntil > S.clock) return 0;   // 마녀 저주: 어떤 회복도 받지 않는다
    // 산성·화염·거미줄·냉각 등 장판 안에 서 있으면 회복량은 절반. 겹쳐도 한 번만 줄인다
    if (P.pos) for (const h of hazards) {
      if (S.clock < h.until && hyp2(P.pos[0] - h.x, P.pos[2] - h.z) <= h.r && Math.abs(P.pos[1] - h.y) < 1.2) { amount *= 0.5; break; }
    }
    const before = P.hp;
    P.hp = Math.min(P.maxHp, P.hp + amount);
    return P.hp - before;
  }

  /** 사람 위치(세션·연습장이 준다)를 읽어 둔다. 모르는 사람은 마지막 자리를 쓴다 */
  function readPositions() {
    let raw = null;
    try { raw = getPositions() || {}; } catch (e) { raw = {}; }
    for (const P of players.values()) {
      const r = raw[P.id];
      const p = pos3(r);
      if (p) { trackVelocity(P, p); P.pos = p; }
      // 방패(바라보는 방향·든 무기 슬롯)와 공중 강타(점프 중)가 읽는다. 모르면 비워 둔다(방패는 쓰이지 않는다)
      if (p && r && !Array.isArray(r)) {
        P.yaw = Number.isFinite(+r.yaw) ? +r.yaw : null;
        P.slot = Number.isFinite(+r.slot) ? +r.slot : null;
        P.air = r.air === true;
      }
    }
  }
  /** 원격 위치는 띄엄띄엄 오므로 바뀐 때만 그 간격으로 속도를 잰다. 0.3초 넘게 그대로면 멈춘 것으로 본다 */
  function trackVelocity(P, p) {
    const q = P.pos;
    if (q && (p[0] !== q[0] || p[2] !== q[2])) {
      const dt = (S.clock - P.movedAt) / 1000;
      if (dt > 0 && dt <= 0.3) {
        let vx = (p[0] - q[0]) / dt, vz = (p[2] - q[2]) / dt;
        const sp = hyp2(vx, vz);
        if (sp > VEL_MAX) { vx *= VEL_MAX / sp; vz *= VEL_MAX / sp; }
        P.vel[0] += (vx - P.vel[0]) * 0.5; P.vel[2] += (vz - P.vel[2]) * 0.5;
      }
      P.movedAt = S.clock;
    } else if (S.clock - P.movedAt > 300) P.vel[0] = P.vel[2] = 0;
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
    P.hitUntil = 0;
    P.burnUntil = P.burnNext = P.noHealUntil = 0;
    P.downPos = null;
    P.yasuoHits = 0; P.yasuoExpires = 0; P.yasuoSwing = null;
    P.yasuoLastAt = -Infinity; P.yasuoLastShot = 0;
    revives.delete(P.id);
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

  /** 다음 스테이지: 스테이지 번호를 올리고 새 좀비 줄을 세운다. 지난 스테이지에서 아직 안 나온 좀비는 버리고, 살아 있는 좀비는 남는다 */
  function beginStage(ev) {
    S.stage += 1;
    S.queue = buildQueue(S.stage);
    S.total = S.queue.length;
    S.killedStage = 0;
    S.spawnAt = S.clock + 900;
    S.stageEnd = S.clock + R.stageMs;
    if (S.startedAt == null) S.startedAt = S.clock;
    swordWaves.length = 0;
    for (const P of players.values()) {
      P.secondUsed = false;
      P.yasuoHits = 0; P.yasuoExpires = 0; P.yasuoSwing = null;
    }
    const bosses = S.queue.filter((x) => x.boss).map((x) => { const b = bossById(x.boss); return { id: b.id, name: b.name, icon: b.icon }; });
    setPhase('wave', 0, ev, { count: S.total, bosses, stageMs: R.stageMs });
    if (bosses.length) ev.push({ type: 'boss', stage: S.stage, bosses });
  }

  /** 스테이지가 넘어갈 때: 30스테이지부터 쓰러진 사람은 동료가 살려야 한다. 처음 합류한 사람은 다음 스테이지에 나온다 */
  function nextStage(ev) {
    let i = 0;
    for (const P of players.values()) {
      if (!P.connected) continue;
      if (!P.alive) {
        if (!P.spawned || S.stage + 1 < R.noAutoReviveStage) spawnPlayer(P, i, ev, R.reviveHpFrac);
      } else if (P.perks.stageHeal > 0) healPlayer(P, P.maxHp * P.perks.stageHeal);
      if (P.alive) P.shield = Math.round(P.shield + (P.perks.shield || 0));
      i++;
    }
    revives.clear();
    beginStage(ev);
  }

  /** 시간 안에 다 잡았다: 남은 시간 1초당 경험치 1, 체력 회복, 바로 다음 스테이지 */
  function clearStage(ev) {
    const leftMs = Math.max(0, S.stageEnd - S.clock);
    const bonus = timeBonusXp(leftMs, R);
    for (const P of players.values()) if (P.alive) healPlayer(P, P.maxHp * R.clearHealFrac);
    projectiles.length = 0;
    hazards.length = 0;
    ev.push({ type: 'clear', stage: S.stage, leftMs: Math.round(leftMs), bonus });
    if (bonus > 0) addXp(bonus, ev);
    nextStage(ev);
  }

  /** 스테이지 시간이 다 됐다: 남은 좀비를 둔 채 다음 스테이지 */
  function timeUp(ev) {
    let alive = 0;
    for (const Z of zombies.values()) if (Z.state !== 'dead') alive++;
    ev.push({ type: 'timeup', stage: S.stage, left: alive });
    nextStage(ev);
  }

  /* ------------------------------------------------------------------ 경험치 · 증강 */
  /** 팀 경험치. 차면 레벨이 오르고 접속한 모두가 증강 하나씩을 받는다(여러 레벨이 한꺼번에 오르면 그만큼) */
  function addXp(n, ev) {
    if (!(n > 0) || S.phase === 'over') return;
    S.xp += n;
    S.xpTotal += n;
    let ups = 0;
    while (S.xp >= xpNeed(S.level, R)) { S.xp -= xpNeed(S.level, R); S.level++; ups++; }
    if (!ups) return;
    for (const P of players.values()) if (P.connected) P.picks += ups;
    ev.push({ type: 'levelUp', level: S.level, ups });
  }

  /** 증강 제안 하나를 만든다. 보물 상자 몫이 남아 있으면 첫 장은 영웅 이상 */
  function giveOffer(P) {
    const count = 3 + Math.round(P.perks.offers || 0);
    const chest = P.chestPicks > 0;
    S.offerRound++;
    P.offer = {
      cards: makeOffer({ seed, playerId: P.id, stage: Math.max(1, S.stage), roll: 0, round: S.offerRound, taken: P.cards, count, high: chest }),
      roll: 0, round: S.offerRound, rerolls: 1 + Math.round(P.perks.rerolls || 0), count, chest
    };
    P.picked = false;
    P.offerUntil = S.clock + R.cardMs;
    S.flowAt = -Infinity;            // 고르는 사람은 좀비가 노리지 않으므로 길찾기를 바로 다시
  }

  /** 제안 중 하나를 무작위로(시간이 다 됐을 때) */
  const randomCard = (P) => P.offer.cards[Math.floor(rng() * P.offer.cards.length)];

  /** 증강을 고르는 중이거나 고른 직후라 무적인가(동료가 살려 일어난 직후도) */
  const invulnerable = (P) => !!(P && (P.offer || S.clock < P.invulnUntil));

  /** 좀비가 노릴 수 있는가: 살아 있고 자리를 알며, 증강을 고르는 중이 아니다(멀티에서 고르는 사람은 좀비가 쫓지 않는다). 분신도 같은 검사를 쓴다 */
  const targetable = (T) => !!(T && T.alive && T.pos && !T.offer);

  /** 고를 증강이 남은 사람이 있는가 */
  function anyOffers() {
    for (const P of players.values()) if (P.connected && (P.offer || P.picks > 0)) return true;
    return false;
  }
  const allPicked = () => !anyOffers();

  /**
   * 고를 증강이 생겼으면 제안을 준다.
   * 혼자(pauseOnCards): 웨이브를 멈추고 증강 고르기로 간다(좀비·스테이지 시간·보급품 시간이 모두 멈춘다).
   * 멀티: 멈추지 않는다. 제안을 받은 사람은 고르는 동안 무적이고, cardMs 안에 안 고르면 무작위로 받는다
   */
  function maybeCards(ev) {
    if (S.phase !== 'wave' || !anyOffers()) return;
    if (!R.pauseOnCards) {
      for (const P of players.values()) if (P.connected && P.picks > 0 && !P.offer) { giveOffer(P); ev.push({ type: 'offer', id: P.id, chest: !!P.offer.chest }); }
      return;
    }
    let chest = false, level = false;
    for (const P of players.values()) {
      if (!P.connected) continue;
      if (P.picks > 0 && !P.offer) giveOffer(P);
      if (P.offer) { if (P.offer.chest) chest = true; else level = true; }
    }
    S.cardsLeft = R.cardMs;
    setPhase('cards', 0, ev, { level: S.level, why: level && chest ? 'both' : chest ? 'chest' : 'level' });
  }

  /** (혼자) 증강 고르기 끝: 시간이 다 됐으면 남은 증강은 제안 중 무작위로 받고, 멈췄던 웨이브를 잇는다 */
  function endCards(ev) {
    for (const P of players.values()) {
      if (!P.connected) { P.offer = null; continue; }
      let guard = 0;
      while ((P.offer || P.picks > 0) && guard++ < 50) {
        if (!P.offer) giveOffer(P);
        if (!P.offer.cards.length) { P.offer = null; P.picks = 0; P.chestPicks = 0; break; }
        takeOffered(P, randomCard(P), ev, true);
      }
    }
    setPhase('wave', 0, ev, { resumed: true, stageLeftMs: Math.max(0, Math.round(S.stageEnd - S.clock)) });
  }

  /** (멀티) 마감이 지난 제안은 무작위로 받는다 */
  function expireOffers(ev) {
    for (const P of players.values()) {
      if (!P.offer || S.clock < P.offerUntil) continue;
      if (!P.connected || !P.offer.cards.length) { P.offer = null; P.picks = 0; P.chestPicks = 0; continue; }
      takeOffered(P, randomCard(P), ev, true);
      if (P.offer) ev.push({ type: 'offer', id: P.id, chest: !!P.offer.chest });
    }
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
    swordWaves.length = 0;
    for (const P of players.values()) { P.yasuoHits = 0; P.yasuoExpires = 0; P.yasuoSwing = null; }
    projectiles.length = 0;
    hazards.length = 0;
    revives.clear();
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
    S.flowAt = -Infinity;            // 다 고른 사람을 좀비가 다시 노린다
    ev.push({ type: 'card', id: P.id, card: c.id, auto: !!auto });
    return true;
  }

  /** 제안된 증강을 받는다: 남은 몫을 줄이고, 아직 남았으면 다음 제안을 바로 준다 */
  function takeOffered(P, cardId, ev, auto) {
    const chest = !!(P.offer && P.offer.chest);
    if (!takeCard(P, cardId, ev, auto)) { P.offer = null; return false; }
    P.picks = Math.max(0, P.picks - 1);
    if (chest) P.chestPicks = Math.max(0, P.chestPicks - 1);
    // 고른 직후 멀티는 2초, 혼자는 3초 무적(멀티는 고르는 동안에도 무적이었다)
    P.invulnUntil = S.clock + R.pickInvulnMs;
    if (P.picks > 0) giveOffer(P);
    return true;
  }

  /** 증강 고르기·다시 뽑기. act = 'pick' | 'reroll' */
  function cardAction(id, act, cardId) {
    const P = players.get(String(id));
    if (S.phase === 'over' || !P || !P.connected || !P.offer || P.picked) return [{ type: 'reject', reason: 'not_offered', id }];
    const ev = [];
    if (act === 'reroll') {
      if (P.offer.rerolls <= 0) return [{ type: 'reject', reason: 'no_reroll', id }];
      const roll = P.offer.roll + 1;
      const cards = makeOffer({ seed, playerId: P.id, stage: Math.max(1, S.stage), roll, round: P.offer.round, taken: P.cards, count: P.offer.count, exclude: P.offer.cards, high: P.offer.chest });
      P.offer = { ...P.offer, cards: cards.length ? cards : P.offer.cards, roll, rerolls: P.offer.rerolls - 1 };
      ev.push({ type: 'reroll', id: P.id });
      return ev;
    }
    if (act !== 'pick' || !P.offer.cards.includes(String(cardId))) return [{ type: 'reject', reason: 'bad_card', id }];
    takeOffered(P, String(cardId), ev, false);
    if (S.phase === 'cards' && !anyOffers()) endCards(ev);
    else if (P.offer) ev.push({ type: 'offer', id: P.id, chest: !!P.offer.chest });
    return ev;
  }

  /* ------------------------------------------------------------------ 좀비 만들기 */
  function spawnCandidates() {
    // 좀비 전용 맵: 좀비 문에서만 나온다(벽 너머·굴 속이라 사람 앞에 불쑥 생기지 않는다)
    if (gates.length) return gates;
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
    const y = Number.isFinite(best[1]) ? best[1] : world ? getGroundY(world, best[0], best[2], 2) : 0;
    // 좀비 문: 한 자리에 겹쳐 서지 않게 문 둘레 1 m 안의 같은 높이 걷기 칸으로 흩는다
    if (gates.length && nav && typeof nav.nearestWalkable === 'function') {
      const n = nav.nearestWalkable({ x: best[0] + (rng() - 0.5) * 2.2, y, z: best[2] + (rng() - 0.5) * 2.2 }, 1.5);
      if (n && Math.abs(n.y - y) < 0.6) return [n.x, n.y, n.z];
    }
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
      body: { pos: [at[0], at[1] + (t && t.flying ? FLY_HEIGHT : 0), at[2]], vel: [0, 0, 0], onGround: !(t && t.flying) },
      yaw: rng() * Math.PI * 2, hp: maxHp, maxHp,
      dmg: base.damage * dmgMul(stage), speed: base.speed * (boss ? 1 : speedMul(stage)) * (boss ? 1 : jitter),
      range: base.range, radius: Math.min(0.5, base.radius), scale: base.scale,
      attackMs: base.attackMs, windupMs: base.windupMs,
      state: 'rise', until: S.clock + (boss ? 1800 : 650), attackReady: S.clock + 900,
      target: null, targetAt: 0, node: -1, losAt: 0, los: false, jumpAt: 0, stuck: 0, progressAt: S.clock, bestDist: Infinity,
      slowUntil: 0, slowMul: 1, hasteUntil: 0, hasteMul: 1, armorUntil: 0, armorMul: 1, enraged: false,
      rangedAt: S.clock + 1500 + rng() * 1500, grabAt: S.clock + 3000 + rng() * 3000, windGrab: false, skill: null, skillReady: boss ? boss.skills.map((s, i) => S.clock + 2500 + i * 1800 + rng() * 1200) : null,
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
  function applyHpLoss(P, dmg, ev) {
    if (P.hp - dmg <= 0 && P.perks.secondChance > 0 && !P.secondUsed) {
      P.secondUsed = true;
      P.hp = Math.max(1, Math.round(P.maxHp * 0.3));
      ev.push({ type: 'second', id: P.id });
    } else P.hp = Math.max(0, P.hp - dmg);
    if (P.hp <= 0) downPlayer(P, ev);
  }
  function bossHitEffects(P, ev) {
    if (S.stage >= 40) {
      if (P.burnUntil <= S.clock) P.burnNext = S.clock + BOSS_BURN_TICK_MS;
      P.burnUntil = Math.max(P.burnUntil, S.clock + BOSS_BURN_MS);
      ev.push({ type: 'burn', id: P.id, ms: BOSS_BURN_MS });
    }
    if (S.stage >= 50) stunPlayer(P, { ms: BOSS_STUN_MS, up: BOSS_STUN_UP }, ev);
  }
  /**
   * 사람이 맞음. from = 좀비(없으면 장판 등). opt = { melee, area: 광역(회피 불가), boss: 보스 투사체·장판, at, knock, zombie }.
   * 맞으면(피하지 않았으면) 잠깐 무적이고, knock이 있으면 맞은 쪽 반대로 밀려난다(보호막이 막아도). 좀비·보스에게 맞으면 폭발 반응 장갑이 터진다
   */
  function hurtPlayer(P, amount, from, ev, opt = {}) {
    if (!P || !P.alive || !(amount > 0) || S.phase !== 'wave') return 0;
    if (invulnerable(P)) return 0;    // 증강을 고르는 중(멀티)이거나 고른 직후 3초, 동료가 살려 일어난 직후 2초
    if (S.clock < P.hitUntil) return 0;   // 맞은 뒤 무적(여러 마리에게 한꺼번에 맞아도 한 번만 들어간다)
    if (!opt.area && P.perks.dodge > 0 && rng() < Math.min(DODGE_CAP, P.perks.dodge)) return 0;
    P.hitUntil = S.clock + R.hitInvulnMs + 1000 * Math.max(0, P.perks.iframe || 0);
    if (opt.knock > 0 && !(P.perks.noKnock > 0)) pushPlayer(P, from && from.body ? from.body.pos : opt.at, opt.knock);
    if ((from || opt.zombie) && P.perks.reactive > 0) reactiveBlast(P, ev);
    // 받는 피해 감소(방탄복·벙커·불굴 + 방패 칼)는 모두 합쳐 90%까지
    let keep = 1 - clamp(P.perks.armor || 0, 0, REDUCE_CAP);
    if (guarded(P, from, opt)) keep *= 1 - clamp(P.perks.guard, 0, REDUCE_CAP);
    let dmg = amount * Math.max(1 - REDUCE_CAP, keep);
    if (P.shield > 0) { const a = Math.min(P.shield, dmg); P.shield -= a; dmg -= a; }
    dmg = Math.round(dmg);
    if (dmg <= 0) return 0;
    applyHpLoss(P, dmg, ev);
    P.hurtAt = S.clock;
    P.hurtFrom = from && from.body ? [from.body.pos[0], from.body.pos[1] + 1.2, from.body.pos[2]] : opt.at || null;
    if (P.alive && (from?.boss || opt.boss)) bossHitEffects(P, ev);
    return dmg;
  }

  /**
   * 방패 칼(증강): 칼(슬롯 3)을 들고 있고, 때린 쪽(좀비·침·장판의 자리)이 바라보는 방향의 앞쪽 약 70° 안이면 막는다.
   * 어디서 맞았는지 모르거나(자리·방향을 못 받음) 뒤에서 맞으면 막지 못한다
   */
  function guarded(P, from, opt) {
    if (!(P.perks.guard > 0) || P.slot !== 3 || !Number.isFinite(P.yaw) || !P.pos) return false;
    const src = from && from.body ? from.body.pos : opt && opt.at;
    if (!src) return false;
    const dx = num(src[0]) - P.pos[0], dz = num(src[2]) - P.pos[2];
    const l = hyp2(dx, dz);
    if (l < 0.05) return true;   // 거의 겹쳐 서 있으면 앞이라고 본다
    return (-Math.sin(P.yaw) * dx - Math.cos(P.yaw) * dz) / l >= GUARD_COS;
  }

  /**
   * 맞아 밀려남: src(때린 좀비의 발·폭발 자리)에서 사람 쪽 수평 방향으로 knockSpeed × k, 살짝 위로 knockUp.
   * 스냅샷 줄에 knockKeepMs 동안 실리고, 그 사람의 화면이 번호(knockSeq)가 바뀔 때 한 번 자기 몸을 민다
   */
  function pushPlayer(P, src, k) {
    let dx = 0, dz = 0;
    if (P.pos && src) { dx = P.pos[0] - num(src[0]); dz = P.pos[2] - num(src[2]); }
    const l = hyp2(dx, dz);
    if (l > 0.05) { dx /= l; dz /= l; }
    else { const a = rng() * Math.PI * 2; dx = Math.sin(a); dz = Math.cos(a); }   // 거의 같은 자리면 방향을 굴린다
    const sp = R.knockSpeed * k;
    P.knockSeq++;
    P.knockAt = S.clock;
    P.knockV = [dx * sp, R.knockUp * Math.min(1, k), dz * sp];
  }

  /** 밀려남 대신 속도를 그대로 싣는다(그랩·기절 띄우기). 같은 간격에 이미 밀려남이 있으면 덮어쓴다 */
  function setKnock(P, v) {
    if (P.knockAt !== S.clock) P.knockSeq++;
    P.knockAt = S.clock;
    P.knockV = v;
  }
  /** 사슬꾼 그랩: 사람을 Z 바로 앞(1.4 m)까지 날려 끌어온다. 위로 띄우고, 비행 시간에 맞춰 수평 속도를 정한다 */
  function pullPlayer(P, Z) {
    if (!P.pos) return;
    const zp = Z.body.pos;
    let ux = P.pos[0] - zp[0], uz = P.pos[2] - zp[2];
    const l = hyp2(ux, uz) || 1;
    ux /= l; uz /= l;
    const tx = zp[0] + ux * 1.4 - P.pos[0], tz = zp[2] + uz * 1.4 - P.pos[2];
    const flight = (2 * PULL_UP) / -PLAYER_GRAVITY;
    setKnock(P, [tx / flight, PULL_UP, tz / flight]);
  }
  /** 사슬꾼 평타: 기절(ms 동안 움직이지도 쏘지도 못함)하며 공중에 뜬다 */
  function stunPlayer(P, st, ev) {
    const v = P.knockAt === S.clock && P.knockV ? [P.knockV[0] * 0.3, st.up, P.knockV[2] * 0.3] : [0, st.up, 0];
    setKnock(P, v);
    ev.push({ type: 'stun', id: P.id, ms: st.ms });
  }

  /** 좀비가 노린 표적(사람 또는 분신)이 맞음 */
  function hurtTarget(T, amount, from, ev, opt = {}) {
    if (T && T.decoy) return hurtDecoy(T, amount, ev);
    return hurtPlayer(T, amount, from, ev, opt);
  }

  /** 분신이 맞음. 체력이 다 하면 사라진다 */
  function hurtDecoy(D, amount, ev) {
    if (!D || !D.alive || !(amount > 0) || S.phase !== 'wave') return 0;
    const dmg = Math.round(amount);
    D.hp = Math.max(0, D.hp - dmg);
    if (D.hp <= 0) removeDecoy(D, ev, 'down');
    return dmg;
  }

  function downPlayer(P, ev) {
    if (!P.alive) return;
    P.alive = false;
    P.yasuoHits = 0; P.yasuoExpires = 0; P.yasuoSwing = null;
    P.hp = 0;
    P.downs++;
    // 쓰러진 자리(멀티에서 동료가 여기서 살린다). 이 사람이 하던 살리기는 끊긴다.
    // 뛰다가·떨어지다가 쓰러졌으면 발 위치가 공중이라, 보급품·분신처럼 바로 아래 바닥으로 내린다(표시가 뜨지 않고 바닥에서 살릴 수 있게)
    P.downPos = P.pos ? P.pos.slice() : null;
    if (world && P.downPos) {
      const g = getGroundY(world, P.downPos[0], P.downPos[2], P.downPos[1] + 0.2);
      if (Number.isFinite(g) && g <= P.downPos[1] + 0.05 && g > P.downPos[1] - 3) P.downPos[1] = g;
    }
    P.downAt = S.clock;
    dropRevivesBy(P.id);
    ev.push({ type: 'down', id: P.id, stage: S.stage });
    if (!aliveList().length) gameOver(ev, 'wiped');
  }

  /* ------------------------------------------------------------------ 동료 살리기(멀티) */
  /** 이 사람이 하던 살리기를 끊는다 */
  function dropRevivesBy(id) {
    for (const [tid, rv] of [...revives]) if (rv.by === id) revives.delete(tid);
  }

  /** helper가 쓰러진 downed를 지금 살릴 수 있는가 → 안 되면 거절 이유, 되면 null */
  function reviveProblem(helper, downed) {
    if (S.phase !== 'wave') return 'not_wave';
    if (R.pauseOnCards) return 'solo';                       // 혼자 하기에는 살리기가 없다
    if (!helper || !helper.connected || !helper.alive) return 'dead';
    if (helper.offer) return 'picking';
    if (!downed || downed === helper || !downed.connected) return 'no_target';
    if (downed.alive || !downed.spawned || !downed.downPos) return 'not_down';
    const a = helper.pos, b = downed.downPos;
    if (!a || hyp2(a[0] - b[0], a[2] - b[2]) > R.reviveRangeM || Math.abs(a[1] - b[1]) > 2.5) return 'far';
    return null;
  }

  /**
   * 살리기 신호. on이면 시작하거나(처음) 이어 간다(같은 사람이 다시 보내면 마지막 신호 시각만 새로), 아니면 이 사람이 하던 살리기를 끊는다.
   * 한 사람은 한 명만 살리고(다른 사람으로 옮기면 앞의 것은 끊긴다), 다른 사람이 살리는 중인 사람은 'busy'로 거절한다. 시작할 때 이벤트는 없다
   */
  function reviveAction(playerId, targetId, on) {
    const helper = players.get(String(playerId));
    if (!on) { if (helper) dropRevivesBy(helper.id); return []; }
    const downed = players.get(String(targetId));
    readPositions();
    const why = reviveProblem(helper, downed);
    if (why) return [{ type: 'reject', reason: why }];
    const cur = revives.get(downed.id);
    if (cur && cur.by === helper.id) { cur.seen = S.clock; return []; }
    if (cur && S.clock - cur.seen <= R.reviveKeepMs) return [{ type: 'reject', reason: 'busy' }];
    dropRevivesBy(helper.id);
    revives.set(downed.id, { by: helper.id, ms: 0, seen: S.clock });
    return [];
  }

  /**
   * 웨이브 한 간격: 살리는 중인 것을 이어 가고, 조건이 깨졌거나 신호가 끊긴 것은 버린다. reviveHoldMs가 차면 일어난다.
   * 신호는 tick() 사이에만 들어오므로 끊김은 이번 tick이 시작한 시각으로 잰다(숨은 탭에서 방장 루프가 1초에 한 번 돌아도 살릴 수 있게)
   */
  function stepRevives(ms, ev) {
    for (const [tid, rv] of [...revives]) {
      const downed = players.get(tid);
      const helper = players.get(rv.by);
      if (reviveProblem(helper, downed) || S.tickAt - rv.seen > R.reviveKeepMs) { revives.delete(tid); continue; }
      rv.ms += ms;
      if (rv.ms >= R.reviveHoldMs) { revives.delete(tid); revivePlayer(downed, helper, ev); }
    }
  }

  /** 동료가 살렸다: 쓰러진 자리에서 체력 reviveHp로 일어나 reviveInvulnMs 동안 무적. 살린 사람 쪽을 본다 */
  function revivePlayer(P, helper, ev) {
    const at = P.downPos;
    P.alive = true;
    P.hp = Math.max(1, Math.min(P.maxHp, Math.round(R.reviveHp)));
    P.hitUntil = 0;
    P.invulnUntil = Math.max(P.invulnUntil, S.clock + R.reviveInvulnMs);
    P.burnUntil = P.burnNext = P.noHealUntil = 0;
    for (const h of hazards) if (h.afflicted) h.afflicted.delete(P.id); // 다시 장판을 밟으면 첫 타격으로 취급
    P.hurtFrom = null;
    P.pos = at.slice();
    P.downPos = null;
    const face = helper.pos || at;
    const r2 = (v) => Math.round(v * 100) / 100;
    const spawn = { x: r2(at[0]), y: r2(at[1]), z: r2(at[2]), rotY: Math.round(Math.atan2(-(face[0] - at[0]), -(face[2] - at[2])) * 1000) / 1000 };
    ev.push({ type: 'spawn', id: P.id, spawn, hp: P.hp, maxHp: P.maxHp, revive: true, by: helper.id });
    ev.push({ type: 'revive', id: P.id, by: helper.id });
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
      const area = info && (info.kind === 'nade' || info.kind === 'fire' || info.kind === 'chain') ? 0.2 : 1;
      if (P.perks.lifesteal > 0) healPlayer(P, real * P.perks.lifesteal * area);
      if (P.perks.hitHeal > 0) healPlayer(P, P.perks.hitHeal * area);
      if (P.perks.slow > 0) { Z.slowUntil = S.clock + frostSlowMs(P.perks.slow, R); Z.slowMul = 1 - clamp(P.perks.slow, 0, 0.6); }
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
    // 팀 경험치: 일반 좀비 1, 강한 특수 좀비일수록 더, 보스 HORDE.bossXp, 보스가 불러낸 좀비 1
    addXp(Z.boss ? R.bossXp : Z.summoned ? 1 : zombieXp(Z.t ? Z.t.id : ''), ev);
    dropLoot(Z, P);
    const pos = Z.body.pos;
    // 폭발 좀비는 쓰러질 때도 터진다(가까이에서 쏘면 위험하다)
    if (Z.t && Z.t.explode && !Z.exploded) explodeAt(pos, Z.t.explode.radius, Z.dmg + Z.t.explode.dmg * dmgMul(S.stage), Z, ev, 'bomber');
    if (P && P.perks.explosive > 0 && !(info && info.chain)) {
      const dmg = Z.maxHp * P.perks.explosive;
      addFx('chain', pos, 3);
      for (const O of zombies.values()) {
        if (O === Z || O.state === 'dead') continue;
        if (hyp2(O.body.pos[0] - pos[0], O.body.pos[2] - pos[2]) <= 3) hurtZombie(O, dmg * targetDamageMul(P.perks, !!O.boss), P, { chain: true, kind: 'chain' }, ev);
      }
    }
  }

  /* ------------------------------------------------------------------ 바닥 보급품 */
  /**
   * 쓰러진 좀비가 보급품을 떨어뜨린다: 일반 좀비는 구급 상자 5%·탄창 5%(잡은 사람의 증강만큼 더), 보스는 보물 상자 하나, 보스가 불러낸 좀비는 없음.
   * 상한을 넘으면 가장 오래된 것부터 치운다(보물 상자는 치우지 않는다)
   */
  function dropLoot(Z, P) {
    if (Z.summoned) return;
    const k = P ? P.perks : null;
    const kind = Z.boss ? 'chest' : rollDrop(rng, R.medChance + (k ? k.medDrop : 0), R.magChance + (k ? k.ammoDrop : 0));
    if (!kind) return;
    const p = Z.body.pos;
    let y = p[1];
    if (world) { const g = getGroundY(world, p[0], p[2], p[1] + 1.2); if (Number.isFinite(g) && g > p[1] - 3) y = g; }
    const L = { id: S.nextLoot++, kind, x: p[0], y, z: p[2], until: S.clock + (kind === 'chest' ? R.chestMs : R.lootMs) };
    loot.set(L.id, L);
    if (loot.size > R.maxLoot) {
      for (const [id, old] of loot) { if (loot.size <= R.maxLoot) break; if (old.kind !== 'chest') loot.delete(id); }
    }
  }
  function expireLoot() {
    for (const [id, L] of loot) if (L.until <= S.clock) loot.delete(id);
  }
  /**
   * 사람이 보급품을 주웠다고 알린다. 방장은 그 사람이 살아 있고 보급품에서 lootPickM 안에 있을 때만 확정한다.
   * 구급 상자는 여기서 체력을 채우고, 탄창·탄약 상자·수류탄은 주운 사람의 화면이 'loot' 이벤트를 받아 자기 무기에 넣는다.
   */
  function claimLoot(playerId, lootId) {
    const P = players.get(String(playerId));
    const L = loot.get(num(lootId) | 0);
    if (!L) return [{ type: 'reject', reason: 'gone' }];
    if (!P || !P.connected || !P.alive || S.phase === 'over' || S.phase === 'warmup') return [{ type: 'reject', reason: 'dead' }];
    readPositions();
    const pos = P.pos;
    if (!pos || hyp2(pos[0] - L.x, pos[2] - L.z) > R.lootPickM || Math.abs(pos[1] - L.y) > 2.5) return [{ type: 'reject', reason: 'far' }];
    loot.delete(L.id);
    const e = { type: 'loot', id: L.id, kind: L.kind, by: P.id };
    if (L.kind === 'med') e.heal = Math.round(healPlayer(P, R.medHeal + (P.perks.medHeal || 0)));
    const ev = [e];
    // 보물 상자: 주운 사람이 증강 하나를 고른다(첫 장은 영웅 이상). 바로 증강 고르기로 간다
    if (L.kind === 'chest') { P.picks++; P.chestPicks++; maybeCards(ev); }
    return ev;
  }

  function addFx(kind, p, r) {
    fxList.push({ id: S.nextFx++, kind, x: p[0], y: p[1], z: p[2], r, at: S.clock });
    if (fxList.length > 24) fxList.splice(0, fxList.length - 24);
  }

  /** 폭발(폭발 좀비·화약통): 사람과 분신에게 피해(거리에 따라 줄어든다) */
  function explodeAt(p, radius, dmg, from, ev, kind, boss = false) {
    if (from) from.exploded = true;
    addFx(kind || 'blast', p, radius);
    for (const T of [...aliveList(), ...decoys.values()]) {
      if (!T.pos || !T.alive) continue;
      const d = Math.hypot(T.pos[0] - p[0], (T.pos[1] + 1) - (p[1] + 0.6), T.pos[2] - p[2]);
      if (d > radius) continue;
      if (world && !lineOfSight(world, [p[0], p[1] + 0.8, p[2]], [T.pos[0], T.pos[1] + 1.2, T.pos[2]])) continue;
      hurtTarget(T, dmg * (1 - 0.6 * (d / radius)), null, ev, { at: [p[0], p[1] + 1, p[2]], knock: 1.5, zombie: true, area: true, boss });
    }
  }

  /**
   * 폭발 반응 장갑: 좀비·보스에게 맞으면 내 자리에서 손 수류탄이 터진다(수류탄을 쓰지 않는다, 아군 피해 없음).
   * 손 수류탄과 같이 수류탄 피해·폭발 반경·화염·빙결·어그로 증강이 붙는다. 다시 터지기까지 1 / reactive 초(겹치면 더 자주)
   */
  function reactiveBlast(P, ev) {
    if (!P.pos || S.clock < (P.reactAt || 0)) return;
    const k = P.perks;
    P.reactAt = S.clock + 1000 / k.reactive;
    const rk = 1 + (k.nadeRadius || 0);
    const base = getDef('gr_frag').explosion;
    const ex = { radius: base.radius * rk, inner: base.inner * rk, max: base.max };
    const c = [P.pos[0], P.pos[1] + 0.12, P.pos[2]];
    addFx('blast', c, ex.radius);
    const hit = [];
    for (const Z of zombies.values()) {
      if (Z.state === 'dead') continue;
      const zp = Z.body.pos;
      const chest = [zp[0], zp[1] + 0.9 * (Z.scale || 1), zp[2]];
      const d = Math.max(0, Math.hypot(chest[0] - c[0], chest[1] - c[1], chest[2] - c[2]) - (Z.radius || 0));
      if (d >= ex.radius) continue;
      if (world && !lineOfSight(world, [c[0], c[1] + 0.5, c[2]], chest)) continue;
      hurtZombie(Z, nadeDamage(explosionFalloff(d, ex), k, !!Z.boss, null), P, { kind: 'nade' }, ev);
      hit.push(Z);
    }
    if (k.nadeFreeze > 0) for (const Z of hit) freezeZombie(Z, P);
    if (k.nadeFire > 0) addField(P, c);
    if (k.nadeDecoy > 0) addDecoy(P, c);
  }

  /* ------------------------------------------------------------------ 수류탄 증강: 불길 · 빙결 · 분신 */
  /** 화염 수류탄 불길: fireMs 동안 안의 좀비에게 0.5초마다 피해 */
  function addField(P, c) {
    const k = P.perks;
    const r = R.fireR * (1 + (k.nadeRadius || 0));
    const dps = R.fireDps * (0.6 + 0.4 * k.nadeFire) * (1 + k.dmg) * (1 + k.nade) * Math.sqrt(hpMul(Math.max(1, S.stage)));
    let y = c[1];
    if (world) { const g = getGroundY(world, c[0], c[2], c[1] + 1); if (Number.isFinite(g) && g > c[1] - 3) y = g; }
    while (fields.length >= R.maxFields) fields.shift();
    fields.push({ id: S.nextField++, kind: FIELD_KINDS.fire, x: c[0], y, z: c[2], r, until: S.clock + R.fireMs, ms: R.fireMs, dps, owner: P.id, tick: 0 });
  }
  function stepFields(dt, ev) {
    for (let i = fields.length - 1; i >= 0; i--) {
      const f = fields[i];
      if (S.clock >= f.until) { fields.splice(i, 1); continue; }
      f.tick += dt;
      if (f.tick < 0.5) continue;
      const k = f.tick;
      f.tick = 0;
      const P = players.get(f.owner) || null;
      for (const Z of zombies.values()) {
        if (Z.state === 'dead') continue;
        if (hyp2(Z.body.pos[0] - f.x, Z.body.pos[2] - f.z) <= f.r + Z.radius && Math.abs(Z.body.pos[1] - f.y) < 1.6) hurtZombie(Z, f.dps * k * targetDamageMul(P && P.perks, !!Z.boss), P, { kind: 'fire' }, ev);
      }
    }
  }
  /** 특이점포: 이 좀비를 at(폭심)으로 끌어당긴다. 끌려가는 동안은 때리지 못한다(보스는 짧게, 휘두르던 공격은 끊긴다) */
  function pullZombie(Z, at) {
    if (!Z || Z.state === 'dead' || !at) return;
    Z.pullTo = [at[0] + (rng() - 0.5) * 1.2, at[1], at[2] + (rng() - 0.5) * 1.2];   // 한 점에 겹치지 않게 조금 흩는다
    Z.pullUntil = S.clock + GRAVITY_PULL_MS * (Z.boss ? 0.35 : 1);
    if (Z.state === 'wind') { Z.state = 'move'; Z.windRanged = false; }
    if (Z.skill && Z.skill.phase === 'wind') Z.skill = null;
  }
  /**
   * 밀어내기(공기총·BC-7 서류 가방, defs knock): from(때린 사람 발)에서 좀비 쪽으로 k.speed m/s, 위로 k.up°만큼 날린다.
   * 큰 좀비는 덜(크기만큼 나눠), 보스는 KNOCK_BOSS만 밀린다. 날아가는 동안은 때리지 못하고 휘두르던 공격·끌려가기는 끊긴다
   */
  function knockZombie(Z, from, k) {
    if (!Z || Z.state === 'dead' || !from || !k) return;
    const p = Z.body.pos;
    let dx = p[0] - from[0], dz = p[2] - from[2];
    const l = hyp2(dx, dz);
    if (l > 1e-3) { dx /= l; dz /= l; } else { dx = -Math.sin(Z.yaw || 0); dz = -Math.cos(Z.yaw || 0); }
    const s = k.speed * (Z.boss ? KNOCK_BOSS : 1 / clamp(Z.scale || 1, 1, 2));
    const a = (k.up || 0) * Math.PI / 180;
    Z.body.vel[0] = dx * s * Math.cos(a);
    Z.body.vel[2] = dz * s * Math.cos(a);
    Z.body.vel[1] = Math.max(Z.body.vel[1] || 0, s * Math.sin(a));
    Z.body.onGround = false;
    Z.knockAt = S.clock;
    Z.knockFloor = p[1];
    Z.knockUntil = S.clock + KNOCK_MAX_MS;
    Z.pullUntil = 0;
    if (Z.state === 'wind') { Z.state = 'move'; Z.windRanged = false; Z.windGrab = false; Z.grabAim = null; }
    if (Z.skill && Z.skill.phase === 'wind') Z.skill = null;
  }
  /** 밀려 날아가는 좀비 한 틱: 받은 속도 그대로 중력을 받아 날고, 땅에 닿으면 끝난다. 비행 좀비는 위아래 없이 옆으로만 밀리다 멈춘다 */
  function stepKnock(Z, dt) {
    const p = Z.body.pos, v = Z.body.vel;
    const fly = Z.t && Z.t.flying;
    if (world && !fly) {
      moveCharacter(world, Z.body, null, dt, { rawVelocity: true, radius: Z.radius, height: Math.min(2.4, 1.8 * Math.min(1.3, Z.scale)) });
      if (Z.body.onGround && S.clock - Z.knockAt > 120) Z.knockUntil = 0;
    } else {
      // 맵이 없을 때(시험)와 비행 좀비: 단순 탄도. 바닥은 처음 높이로 본다
      if (!fly) v[1] += PLAYER_GRAVITY * dt; else v[1] = 0;
      p[0] += v[0] * dt; p[1] += v[1] * dt; p[2] += v[2] * dt;
      if (fly) { v[0] *= Math.max(0, 1 - 3 * dt); v[2] *= Math.max(0, 1 - 3 * dt); if (hyp2(v[0], v[2]) < 0.5) Z.knockUntil = 0; }
      else if (v[1] < 0 && p[1] <= (Z.knockFloor ?? 0)) { p[1] = Z.knockFloor ?? 0; v[0] = v[1] = v[2] = 0; Z.knockUntil = 0; }
    }
    if (!Z.knockUntil || S.clock >= Z.knockUntil) { Z.knockUntil = 0; v[0] = v[2] = 0; }
    Z.progressAt = S.clock; Z.bestDist = Infinity; Z.stuck = 0;
    if (p[1] < -30) recycle(Z);
  }
  /** 빙결: 얼어붙은 좀비는 움직이지도 때리지도 못한다(보스는 절반 시간) */
  function freezeZombie(Z, P) {
    if (!Z || Z.state === 'dead') return;
    const ms = R.freezeMs * (1 + 0.35 * (P.perks.nadeFreeze - 1)) * (Z.boss ? 0.5 : 1);
    Z.frozenUntil = Math.max(Z.frozenUntil || 0, S.clock + ms);
    if (Z.state === 'wind') Z.state = 'move';
    if (Z.skill && Z.skill.phase === 'wind') Z.skill = null;
  }
  /** 어그로 수류탄 분신: 내 최대 체력만큼 버티며 decoyPullM 안의 좀비를 끌어모은다. 한 사람 2개, 전체 maxDecoys개까지 */
  function addDecoy(P, c) {
    const mine = [...decoys.values()].filter((D) => D.owner === P.id);
    while (mine.length >= 2) { const old = mine.shift(); decoys.delete(old.id); }
    while (decoys.size >= R.maxDecoys) decoys.delete(decoys.keys().next().value);
    let y = c[1];
    if (world) { const g = getGroundY(world, c[0], c[2], c[1] + 1); if (Number.isFinite(g) && g > c[1] - 3) y = g; }
    const n = S.nextDecoy++;
    const hp = Math.round(P.maxHp * (1 + 0.5 * (P.perks.nadeDecoy - 1)));
    const D = { id: DECOY_PREFIX + n, n, owner: P.id, pos: [c[0], y, c[2]], hp, maxHp: hp, until: S.clock + R.decoyMs, alive: true, decoy: true };
    decoys.set(D.id, D);
    addFx('decoy', D.pos, 1.2);
    S.flowAt = -Infinity;            // 길찾기를 바로 다시(분신 쪽으로)
    return D;
  }
  function removeDecoy(D, ev, why) {
    if (!D || !decoys.has(D.id)) return;
    D.alive = false;
    decoys.delete(D.id);
    addFx('decoyEnd', D.pos, 1.4);
    S.flowAt = -Infinity;
    if (ev && why === 'down') ev.push({ type: 'decoyDown', owner: D.owner });
  }
  const targetById = (id) => (typeof id === 'string' && id.startsWith(DECOY_PREFIX) ? decoys.get(id) : players.get(id));

  /* ------------------------------------------------------------------ 주장 */
  /** 검을 휘두른 사실은 빗나가도 알려야 한다. 위치·방향은 클라이언트 주장이 아닌 방장의 최신 사람 상태를 쓴다. */
  function claimSwordSwing(c = {}) {
    if (S.phase !== 'wave') return [{ type: 'reject', reason: 'not_wave' }];
    const P = players.get(String(c.attackerId));
    const def = getDef('ml_yasuo');
    if (!P || !P.connected || !P.alive || P.offer) return [{ type: 'reject', reason: 'dead_attacker' }];
    if (c.weaponId !== 'ml_yasuo' || !P.cards.includes('yasuoSword') || !def?.melee || c.kind !== 'yasuoSwing') return [{ type: 'reject', reason: 'bad_weapon' }];
    const shot = c.shotId;
    if (!Number.isSafeInteger(shot) || shot <= P.yasuoLastShot) return [{ type: 'reject', reason: 'bad_shot' }];
    readPositions();
    if (!P.pos || !Number.isFinite(P.yaw) || (P.slot != null && P.slot !== 3)) return [{ type: 'reject', reason: 'bad_position' }];
    const cooldown = Math.max(def.melee.slash.cooldown, def.melee.stab.cooldown) * 1000;
    if (S.clock - P.yasuoLastAt < cooldown - 50) return [{ type: 'reject', reason: 'fire_rate' }];
    if (S.clock >= P.yasuoExpires) P.yasuoHits = 0;
    const finisher = P.yasuoHits === 2;
    const dir = [-Math.sin(P.yaw), 0, -Math.cos(P.yaw)];
    P.yasuoSwing = { id: shot, at: S.clock, origin: P.pos.slice(), dir, hit: false, finisher };
    P.yasuoLastShot = shot;
    P.yasuoLastAt = S.clock;
    if (!finisher) return [];
    P.yasuoHits = 0; P.yasuoExpires = 0;
    const pos = [P.pos[0], P.pos[1] + 0.6, P.pos[2]];
    const ms = Math.round(SWORD_WAVE_RANGE / SWORD_WAVE_SPEED * 1000);
    swordWaves.push({ owner: P.id, pos, dir, left: SWORD_WAVE_RANGE, hit: new Set(), bossDone: false });
    return [{ type: 'yasuo', kind: 'shockwave', by: P.id, pos: P.pos.slice(), dir: dir.slice(), ms, range: SWORD_WAVE_RANGE }];
  }

  function claimHit(c = {}) {
    if (S.phase !== 'wave') return [{ type: 'reject', reason: 'not_wave' }];
    const Z = zombies.get(zombieIdOf(c.victimId));
    const P = players.get(String(c.attackerId));
    if (!Z || Z.state === 'dead') return [{ type: 'reject', reason: 'unknown_zombie' }];
    if (!P || !P.connected || !P.alive) return [{ type: 'reject', reason: 'dead_attacker' }];
    const def = getDef(c.weaponId);
    if (!def || def.explosion) return [{ type: 'reject', reason: 'bad_weapon' }];
    if (def.cardOnly && !((def.id === 'fl_horde' && P.cards.includes('flameGun')) || (def.id === 'rg_horde' && P.cards.includes('railGun')) || (def.id === 'ml_yasuo' && P.cards.includes('yasuoSword')))) return [{ type: 'reject', reason: 'bad_weapon' }];
    if (def.slot === 1 && P.perks.sideMaster > 0) return [{ type: 'reject', reason: 'bad_weapon' }];   // 보조무기 마스터: 주무기 봉인
    const dist = Math.max(0, num(c.dist));
    const melee = !!def.melee;
    const k = P.perks;
    const shot = num(c.shotId, 0) | 0;
    const yasuo = def.id === 'ml_yasuo';
    if (yasuo) {
      const sw = P.yasuoSwing;
      if (P.offer || !sw || sw.id !== c.shotId || sw.hit || S.clock - sw.at > 1200 || (c.kind !== 'slash' && c.kind !== 'stab')) return [{ type: 'reject', reason: 'bad_swing' }];
      const zp = Z.body.pos, op = sw.origin;
      const dx = zp[0] - op[0], dz = zp[2] - op[2], d = hyp2(dx, dz);
      const reach = Math.max(def.melee.slash.range, def.melee.stab.range) + MELEE_SLACK + (Z.boss ? 1.2 : 0);
      if (d > reach || Math.abs(zp[1] - op[1]) > 2.5 || (d > 0.2 && (dx * sw.dir[0] + dz * sw.dir[2]) / d < 0.2) ||
        (world && !lineOfSight(world, [op[0], op[1] + 1.1, op[2]], [zp[0], zp[1] + 1.1, zp[2]]))) return [{ type: 'reject', reason: 'out_of_range' }];
    }
    if (c.kind === 'wave') return [{ type: 'reject', reason: 'no_wave' }]; // 좌클릭 베기는 검기를 낼 수 없다
    if (c.kind === 'waveStab') {
      // 우클릭 찌르기 검기: 칼·증강·거리·검기 하나의 적중 상한을 검증한다.
      if (!melee || !(k.wave > 0)) return [{ type: 'reject', reason: 'no_wave' }];
      if (dist > k.wave + R.waveSlackM + (Z.boss ? 1.2 : 0)) return [{ type: 'reject', reason: 'out_of_range' }];
      if (!countWave(P.id, shot)) return [{ type: 'reject', reason: 'wave_cap' }];
    } else {
      const reach = melee ? Math.max(def.melee.slash.range, def.melee.stab.range) + MELEE_SLACK + (Z.boss ? 1.2 : 0) : def.maxRange * RANGE_SLACK;
      if (dist > reach) return [{ type: 'reject', reason: 'out_of_range' }];
    }
    // 관통: 같은 발로 여러 좀비를 맞히면 맞은 순서대로 70%씩 줄어든다(산탄은 펠릿이 나뉘어 맞으므로 줄이지 않는다)
    let nth = 0;
    if (shot > 0 && (def.pellets || 1) === 1 && !melee) {
      const last = shotCounts.get(P.id);
      nth = last && last.shotId === shot ? last.n + 1 : 0;
      shotCounts.set(P.id, { shotId: shot, n: nth });
      if (nth > Math.round(k.pierce || 0)) return [{ type: 'reject', reason: 'pierce' }];
    }
    // 피해 공식은 화면의 피해 숫자(client.js)와 같은 함수를 쓴다. 치명타만 방장이 굴리고, 터지면 'crit' 이벤트로 쏜 사람 화면에 큰 숫자를 띄운다
    const hit = zombieHitDamage({ ...c, dist }, k, { boss: !!Z.boss, hpFrac: Z.hp / Z.maxHp }, { myHpFrac: P.hp / Math.max(1, P.maxHp), nth, air: !!P.air });
    if (!hit) return [{ type: 'reject', reason: 'bad_weapon' }];
    let dmg = hit.dmg;
    let crit = false;
    if (k.crit > 0 && rng() < k.crit) { crit = true; dmg *= 1.5 + k.critDmg; }
    const swordSwing = yasuo ? P.yasuoSwing : null;
    if (swordSwing) swordSwing.hit = true;
    const ev = [];
    if (crit) ev.push({ type: 'crit', by: P.id, z: Z.id, dmg: Math.max(1, Math.round(dmg)) });
    hurtZombie(Z, dmg, P, { head: hit.head, crit, kind: melee ? 'melee' : 'shot' }, ev);
    if (swordSwing && P.alive && !swordSwing.finisher) {
      if (S.clock >= P.yasuoExpires) P.yasuoHits = 0;
      P.yasuoHits = Math.min(2, P.yasuoHits + 1);
      P.yasuoExpires = S.clock + YASUO_STACK_MS;
    }
    // 밀어내기(공기총·BC-7 서류 가방): 총은 'shot', 칼은 휘두르기 'slash'·우클릭 'stab'. 검기('wave'·'waveStab')는 밀지 않는다
    const knock = def.knock && def.knock[melee ? c.kind : 'shot'];
    if (knock && P.pos) knockZombie(Z, P.pos, knock);
    maybeCards(ev);
    return ev;
  }
  /** 질풍검 충격파가 맞힌 좀비: 칼 찌르기 피해(처음 맞은 보스 하나는 10배), 잠깐 비틀거림, 그 뒤 느려짐. 띄우거나 밀지 않는다 */
  function swordWaveHit(P, Z, w, ev) {
    const boss = !!Z.boss;
    const hit = zombieHitDamage({ weaponId: 'ml_yasuo', part: 'body', dist: 1, kind: 'stab' }, P.perks,
      { boss, hpFrac: Z.hp / Z.maxHp }, { myHpFrac: P.hp / Math.max(1, P.maxHp), air: false });
    const mul = boss && !w.bossDone ? SWORD_WAVE_BOSS_MUL : 1;
    if (boss) w.bossDone = true;
    const stagger = boss ? SWORD_WAVE_STAGGER_MS / 2 : SWORD_WAVE_STAGGER_MS;
    Z.frozenUntil = Math.max(Z.frozenUntil || 0, S.clock + stagger);
    if (!boss && Z.state === 'wind') Z.state = 'move';
    Z.slowUntil = Math.max(Z.slowUntil || 0, S.clock + stagger + SWORD_WAVE_SLOW_MS);
    Z.slowMul = Math.min(Z.slowMul || 1, SWORD_WAVE_SLOW_MUL);
    if (hit) hurtZombie(Z, hit.dmg * mul, P, { kind: 'melee' }, ev);
  }

  /** 충격파는 적중 주장 없이 방장이 직접 이동·충돌 판정한다. 바닥을 타고 앞으로 가며 갈수록 넓어진다. 벽 너머의 좀비는 맞지 않는다. */
  function stepSwordWaves(dt, ev) {
    for (let i = swordWaves.length - 1; i >= 0; i--) {
      const w = swordWaves[i];
      const P = players.get(w.owner);
      if (!P || !P.alive || !P.connected || w.left <= 0) { swordWaves.splice(i, 1); continue; }
      const step = Math.min(w.left, SWORD_WAVE_SPEED * dt);
      const gone = SWORD_WAVE_RANGE - w.left;
      const x0 = w.pos[0], z0 = w.pos[2], x1 = x0 + w.dir[0] * step, z1 = z0 + w.dir[2] * step;
      if (world && !lineOfSight(world, [x0, w.pos[1], z0], [x1, w.pos[1], z1])) { swordWaves.splice(i, 1); continue; }
      w.pos[0] = x1; w.pos[2] = z1; w.left -= step;
      const feet = w.pos[1] - 0.6;
      for (const Z of zombies.values()) {
        if (Z.state === 'dead' || w.hit.has(Z.id)) continue;
        const zp = Z.body.pos, along = clamp((zp[0] - x0) * w.dir[0] + (zp[2] - z0) * w.dir[2], 0, step);
        const half = SWORD_WAVE_HALF0 + (SWORD_WAVE_HALF1 - SWORD_WAVE_HALF0) * clamp((gone + along) / SWORD_WAVE_RANGE, 0, 1);
        if (hyp2(zp[0] - x0 - w.dir[0] * along, zp[2] - z0 - w.dir[2] * along) > half + Z.radius ||
          Math.abs(zp[1] - feet) > (Z.boss ? 2.4 : 1.6)) continue;
        if (world && !lineOfSight(world, [x0 + w.dir[0] * along, w.pos[1], z0 + w.dir[2] * along],
          [zp[0], zp[1] + 1, zp[2]])) continue;
        w.hit.add(Z.id);
        swordWaveHit(P, Z, w, ev);
      }
      if (w.left <= 0) swordWaves.splice(i, 1);
    }
  }


  /** 검기 하나(사수·shotId)가 맞힌 수를 센다. waveMaxHits를 넘으면 false. 사수마다 최근 검기 8개만 기억한다 */
  function countWave(id, shot) {
    let m = waveCounts.get(id);
    if (!m) { m = new Map(); waveCounts.set(id, m); }
    const n = m.get(shot) || 0;
    if (n >= R.waveMaxHits) return false;
    m.delete(shot);
    m.set(shot, n + 1);
    while (m.size > 8) m.delete(m.keys().next().value);
    return true;
  }

  /**
   * 수류탄·발사체 폭발. victims = 폭발 반경 안의 좀비와 피해(던진 사람의 폭발 반경 증강을 반영해 화면이 잰다).
   * kind = 'gl'(유탄 발사기) | 'rocket'(바주카포) | 'c4'(C4 증강으로 붙는 손 수류탄) | 없음(손으로 던진 수류탄).
   * 손으로 던진 수류탄(C4 포함)에만 수류탄 증강이 붙는다: 화염(터진 자리에 불길) · 빙결(맞은 좀비가 얼어붙음) · 어그로(분신). center가 있어야 한다
   */
  function claimExplosion(c = {}) {
    if (S.phase !== 'wave') return [];
    const P = players.get(String(c.attackerId));
    if (!P) return [];
    const ev = [];
    const k = P.perks;
    const hit = [];
    // 특이점포: 피해 없이 반경 안의 좀비를 폭심 한 점으로 끌어당긴다(무기가 특이점포일 때만, 사수 근처 90 m 안에서 터진 것만)
    if (c.kind === 'gravity') {
      const at = pos3(c.center);
      if (!P.cards.includes('sideGravity')) return [];
      if (!at || (P.pos && hyp2(at[0] - P.pos[0], at[2] - P.pos[2]) > 90)) return [];
      for (const v of Array.isArray(c.victims) ? c.victims : []) {
        if (!v || !isZombieId(v.id)) continue;
        const Z = zombies.get(zombieIdOf(v.id));
        if (!Z || Z.state === 'dead') continue;
        pullZombie(Z, at);
      }
      return ev;
    }
    // 제우스의 번개는 카드를 고른 사람만, 처음 맞은 좀비 + 다섯 번 튄 좀비까지. 투척 도끼는 닿은 좀비 하나마다 따로 주장한다
    if (c.kind === 'bolt' && !P.cards.includes('zeus')) return [];
    const cap = c.kind === 'bolt' ? 6 : c.kind === 'axe' ? 1 : Infinity;
    for (const v of Array.isArray(c.victims) ? c.victims : []) {
      if (hit.length >= cap) break;
      if (!v || !isZombieId(v.id)) continue;   // 이 모드에는 아군 피해가 없다(자기 수류탄도)
      const Z = zombies.get(zombieIdOf(v.id));
      if (!Z || Z.state === 'dead') continue;
      hurtZombie(Z, nadeDamage(v.dmg, k, !!Z.boss, c.kind), P, { kind: 'nade' }, ev);
      hit.push(Z);
    }
    const center = pos3(c.center);
    const launcher = c.kind === 'gl' || c.kind === 'rocket' || c.kind === 'stake' || c.kind === 'axe' || c.kind === 'bolt';
    // 던진 사람 근처(80 m)에서 터진 것만 효과를 붙인다(엉뚱한 자리에 분신·불길이 생기지 않게)
    if (!launcher && center && (!P.pos || hyp2(center[0] - P.pos[0], center[2] - P.pos[2]) < 80)) {
      if (k.nadeFreeze > 0) for (const Z of hit) freezeZombie(Z, P);
      if (k.nadeFire > 0) addField(P, center);
      if (k.nadeDecoy > 0) addDecoy(P, center);
    }
    maybeCards(ev);
    return ev;
  }

  /* ------------------------------------------------------------------ 길찾기 */
  function updateFlow() {
    if (!nav || typeof nav.flowField !== 'function') { S.flowOk = false; return; }
    if (S.clock - S.flowAt < R.flowMs) return;
    S.flowAt = S.clock;
    // 분신이 서 있으면 좀비는 분신으로 몰려간다(어그로). 증강을 고르는 사람(멀티)은 좀비가 쫓지 않는다
    const from = decoys.size ? [...decoys.values()].filter((D) => D.alive) : aliveList().filter(targetable);
    const src = from.map((T) => T.pos).filter(Boolean).map((p) => ({ x: p[0], y: p[1], z: p[2] }));
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

  /** 노릴 표적: 가까운 분신 → 가까운 사람. 증강을 고르는 사람은 고르지 않고, 노리던 사람이 고르기 시작하면 바로 다른 표적을 찾는다(없으면 null) */
  function chooseTarget(Z) {
    const prevId = Z.target;
    if (S.clock < Z.targetAt && prevId) {
      const T = targetById(prevId);
      if (targetable(T)) return T;
    }
    // 노리던 표적을 더는 노릴 수 없어(고르기 시작·쓰러짐·분신이 사라짐) 억지로 바꾸는가. 그때는 다가간 기록을 새로 시작한다
    // (예전 표적 옆에서 싸우던 좀비가 막힌 것으로 잘못 보여 먼 좀비 문으로 다시 나오지 않게)
    const forced = prevId != null && !targetable(targetById(prevId));
    Z.targetAt = S.clock + TARGET_MS;
    let best = null, bd = Infinity;
    // 분신(어그로 수류탄)이 decoyPullM 안에 있으면 사람보다 먼저 노린다
    for (const D of decoys.values()) {
      if (!D.alive) continue;
      const d = hyp2(D.pos[0] - Z.body.pos[0], D.pos[2] - Z.body.pos[2]) + Math.abs(D.pos[1] - Z.body.pos[1]) * 2;
      if (d < R.decoyPullM && d < bd) { bd = d; best = D; }
    }
    if (!best) {
      for (const P of aliveList()) {
        if (!targetable(P)) continue;
        const d = hyp2(P.pos[0] - Z.body.pos[0], P.pos[2] - Z.body.pos[2]) + Math.abs(P.pos[1] - Z.body.pos[1]) * 2;
        if (d < bd) { bd = d; best = P; }
      }
    }
    Z.target = best ? best.id : null;
    if (forced && Z.target !== prevId) { Z.bestDist = Infinity; Z.progressAt = S.clock; }
    return best;
  }

  function faceTo(Z, tx, tz, dt, rate = 10) {
    const want = Math.atan2(-(tx - Z.body.pos[0]), -(tz - Z.body.pos[2]));
    let d = want - Z.yaw;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    Z.yaw += d * Math.min(1, dt * rate);
  }

  /**
   * 비행 좀비: 공중에서 움직인다. 노리는 사람의 발보다 FLY_CRUISE 높이(천장이 있으면 그 아래, 바닥보다는 늘 FLY_HEIGHT 위)로
   * 오르내리며 수평으로 곧장 날고, 앞이 막히면 먼저 위로 올라 넘는다. 오를 수도 없으면(천장) 잠깐 바닥 길찾기 방향을 빌린다.
   * T가 없으면(끌려가는 중 등) 지금 높이를 지킨다.
   */
  function flyMove(Z, vx, vz, dt, T) {
    const p = Z.body.pos;
    const floorAt = (x, z) => { const g = world ? getGroundY(world, x, z, p[1] + 0.5) : -Infinity; return Number.isFinite(g) ? g : -Infinity; };
    const floor = floorAt(p[0], p[2]);
    let want = T && T.pos ? T.pos[1] + FLY_CRUISE : p[1];
    if (world) {
      const up = raycastWorld(world, [p[0], p[1] + 0.6, p[2]], [0, 1, 0], FLY_CRUISE + FLY_BODY + 2);
      if (up) want = Math.min(want, p[1] + 0.6 + up.dist - FLY_BODY - 0.2);
    }
    want = Math.max(want, floor + FLY_HEIGHT);
    const vy = clamp((want - p[1]) * 2.5, -FLY_CLIMB, FLY_CLIMB);
    const clear = (a, b) => !world || (lineOfSight(world, [a[0], a[1] + 0.12, a[2]], [b[0], b[1] + 0.12, b[2]]) &&
      lineOfSight(world, [a[0], a[1] + FLY_BODY - 0.15, a[2]], [b[0], b[1] + FLY_BODY - 0.15, b[2]]));
    let nx = p[0] + vx * dt, nz = p[2] + vz * dt;
    let ny = Math.max(p[1] + vy * dt, floorAt(nx, nz) + 0.3);
    if (!clear(p, [nx, ny, nz])) {
      // 앞이 막혔다: 제자리에서 위로 오른다. 오를 수도 없으면 잠깐 바닥 길찾기를 따른다
      nx = p[0]; nz = p[2]; ny = p[1] + FLY_CLIMB * dt;
      if (!clear(p, [nx, ny, nz])) {
        Z.flyNavUntil = S.clock + FLY_NAV_MS;
        Z.body.vel[0] = Z.body.vel[1] = Z.body.vel[2] = 0;
        return;
      }
    }
    Z.body.vel[0] = (nx - p[0]) / dt; Z.body.vel[1] = (ny - p[1]) / dt; Z.body.vel[2] = (nz - p[2]) / dt;
    p[0] = nx; p[1] = ny; p[2] = nz;
  }

  const wish = { x: 0, z: 0, jump: false };
  function moveZombie(Z, T, dt, speedK) {
    const p = Z.body.pos;
    let dirX = 0, dirZ = 0;
    if (T && T.pos) {
      const dx = T.pos[0] - p[0], dz = T.pos[2] - p[2];
      const d = hyp2(dx, dz);
      const fly = Z.t && Z.t.flying;
      // 비행 좀비는 곧장 난다(막혀서 오를 수도 없을 때만 잠깐 바닥 길찾기). 걷는 좀비는 가까우면 보이는지 확인하고 곧장, 멀면 흐름장
      if (fly) Z.los = !(S.clock < (Z.flyNavUntil || 0));
      else if (d < 9 && S.clock >= Z.losAt) {
        Z.losAt = S.clock + LOS_MS;
        Z.los = !world || (Math.abs(T.pos[1] - p[1]) < 1.2 && lineOfSight(world, [p[0], p[1] + 1.2, p[2]], [T.pos[0], T.pos[1] + 1.0, T.pos[2]]));
      } else if (d >= 9) Z.los = false;
      let step = null;
      if (!Z.los && S.flowOk) {
        const g = fly && world ? getGroundY(world, p[0], p[2], p[1] + 0.5) : NaN;
        step = nav.flowStep(fly ? { x: p[0], y: Number.isFinite(g) ? g : p[1] - FLY_HEIGHT, z: p[2] } : p, Z.node);
      }
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
      if (Math.abs(O.body.pos[1] - p[1]) > 1) continue;
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
    if (Z.t && Z.t.flying) flyMove(Z, wish.x, wish.z, dt, T);
    else if (world) {
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
    Z.body.pos[0] = at[0]; Z.body.pos[1] = at[1] + (Z.t && Z.t.flying ? FLY_HEIGHT : 0); Z.body.pos[2] = at[2];
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
    // 밀려 날아가는 중(공기총·BC-7 서류 가방): 날아가다 땅에 닿을 때까지 아무것도 못 한다(얼어 있어도 날아간다)
    if (Z.knockUntil > now) { stepKnock(Z, dt); return; }
    // 얼어붙음: 제자리에 서서 아무것도 못 한다
    if (Z.frozenUntil > now) { Z.body.vel[0] = Z.body.vel[2] = 0; if (world && !(Z.t && Z.t.flying)) moveCharacter(world, Z.body, { x: 0, z: 0 }, dt, { radius: Z.radius }); return; }
    // 특이점포에 끌려가는 중: 폭심으로 빨려 들어가고, 닿으면 그 자리에서 멈춘다(보스는 느리게). 그동안 때리지 못한다
    if (Z.pullUntil > now && Z.pullTo) {
      const p0 = Z.body.pos;
      const dx0 = Z.pullTo[0] - p0[0], dz0 = Z.pullTo[2] - p0[2];
      const d0 = hyp2(dx0, dz0);
      const sp0 = d0 > 0.35 ? GRAVITY_PULL_SPEED * (Z.boss ? 0.45 : 1) : 0;
      const wish0 = { x: sp0 > 0 ? (dx0 / d0) * sp0 : 0, z: sp0 > 0 ? (dz0 / d0) * sp0 : 0 };
      if (Z.t && Z.t.flying) flyMove(Z, wish0.x, wish0.z, dt);
      else if (world) moveCharacter(world, Z.body, wish0, dt, { radius: Z.radius, height: Math.min(2.4, 1.8 * Math.min(1.3, Z.scale)) });
      else { p0[0] += wish0.x * dt; p0[2] += wish0.z * dt; Z.body.vel[0] = wish0.x; Z.body.vel[2] = wish0.z; }
      if (sp0 > 0) faceTo(Z, Z.pullTo[0], Z.pullTo[2], dt, 8);
      Z.progressAt = now; Z.bestDist = Infinity; Z.stuck = 0;
      return;
    }
    const T = chooseTarget(Z);
    const rage = Z.enraged ? Z.boss.enrage : null;
    const speedK = Z.slowMul * Z.hasteMul * (rage ? rage.speed : 1);
    if (Z.skill) { stepSkill(Z, T, dt, ev); return; }
    if (Z.boss && T && trySkill(Z, T, ev)) return;
    if (!T || !T.pos) {
      // 노릴 사람이 없다(모두 증강을 고르는 중 등): 제자리에 선다. 막힌 것이 아니므로 다가간 기록을 새로 두고, 휘두르던 공격은 거둔다
      Z.body.vel[0] = Z.body.vel[2] = 0;
      Z.progressAt = S.clock; Z.bestDist = Infinity;
      if (Z.state === 'wind') { Z.state = 'move'; Z.windRanged = false; Z.windGrab = false; Z.grabAim = null; }
      if (world && !(Z.t && Z.t.flying)) moveCharacter(world, Z.body, { x: 0, z: 0 }, dt, { radius: Z.radius });
      return;
    }
    const p = Z.body.pos;
    const dx = T.pos[0] - p[0], dz = T.pos[2] - p[2], dy = T.pos[1] - p[1];
    const d = hyp2(dx, dz);
    const reach = Z.range * (0.75 + 0.25 * Math.min(1.6, Z.scale)) + PLAYER_R;
    // 공격 예고(휘두르기) 중
    if (Z.state === 'wind') {
      // 그랩 예고 중에는 예고를 시작할 때 겨눈 쪽을 그대로 본다(그 선 밖으로 비켜서면 피한다)
      if (Z.windGrab && Z.grabAim) faceTo(Z, Z.grabAim[0], Z.grabAim[2], dt, 12);
      else faceTo(Z, T.pos[0], T.pos[2], dt, 12);
      if (world && !(Z.t && Z.t.flying)) moveCharacter(world, Z.body, { x: 0, z: 0 }, dt, { radius: Z.radius });
      if (now < Z.until) return;
      Z.state = 'move';
      Z.attackReady = now + Z.attackMs * (rage ? rage.cd : 1);
      if (Z.t && Z.t.explode) { killSelfExplode(Z, ev); return; }
      if (Z.windRanged) { Z.windRanged = false; shootSpit(Z, T); return; }
      if (Z.windGrab) { Z.windGrab = false; shootGrab(Z, T); return; }
      // 맞으면 좀비 반대쪽으로 밀려난다(큰 좀비일수록 멀리). 사슬꾼의 평타는 기절시키며 공중에 띄운다
      if (d <= reach * 1.3 && Math.abs(dy) < 1.8) {
        const before = T.hitUntil;
        hurtTarget(T, Z.dmg * (rage ? rage.dmg : 1), Z, ev, { melee: true, knock: clamp(Z.scale, 0.8, 1.8) });
        if (Z.t && Z.t.stun && !T.decoy && T.hitUntil !== before) stunPlayer(T, Z.t.stun, ev);
      }
      return;
    }
    // 산성 좀비: 거리를 두고 침을 뱉는다(분신에게는 다가가 할퀸다)
    const rg = Z.t && Z.t.ranged && !T.decoy ? Z.t.ranged : null;
    if (rg && now >= Z.rangedAt && d <= rg.range && d > 3) {
      if (world && !lineOfSight(world, [p[0], p[1] + 1.4, p[2]], [T.pos[0], T.pos[1] + 1.2, T.pos[2]])) Z.rangedAt = now + 600;
      else {
        Z.state = 'wind'; Z.until = now + rg.windupMs; Z.windRanged = true; Z.rangedAt = now + rg.every * (0.8 + rng() * 0.4);
        return;
      }
    }
    // 사슬꾼: 그랩(쿨타임마다). 보이는 사람에게만 던진다
    const gb = Z.t && Z.t.grab && !T.decoy ? Z.t.grab : null;
    if (gb && now >= Z.grabAt && d <= gb.range && d > 3) {
      if (world && !lineOfSight(world, [p[0], p[1] + 1.4, p[2]], [T.pos[0], T.pos[1] + 1.2, T.pos[2]])) Z.grabAt = now + 600;
      else {
        Z.state = 'wind'; Z.until = now + gb.windupMs; Z.windGrab = true; Z.grabAt = now + gb.every;
        Z.grabAim = [T.pos[0], T.pos[1] + 1.0, T.pos[2]];
        Z.yaw = Math.atan2(-(T.pos[0] - p[0]), -(T.pos[2] - p[2]));  // 예고선과 실제 발사 방향을 같은 순간에 고정
        return;
      }
    }
    if (d <= reach && Math.abs(dy) < 1.6) {
      faceTo(Z, T.pos[0], T.pos[2], dt, 12);
      if (world && !(Z.t && Z.t.flying)) moveCharacter(world, Z.body, { x: 0, z: 0 }, dt, { radius: Z.radius });
      if (now >= Z.attackReady) { Z.state = 'wind'; Z.until = now + Z.windupMs; Z.windRanged = false; Z.windGrab = false; }
      return;
    }
    if (rg && d < rg.keep) {
      // 너무 가까우면 뒤로 물러난다
      const l = d || 1;
      wish.x = (-dx / l) * Z.speed * 0.8 * speedK; wish.z = (-dz / l) * Z.speed * 0.8 * speedK;
      if (Z.t && Z.t.flying) flyMove(Z, wish.x, wish.z, dt, T);
      else if (world) moveCharacter(world, Z.body, wish, dt, { radius: Z.radius });
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
    projectiles.push({ id: S.nextProj++, kind, pos: from.slice(), vel: vel.slice(), arc: !!opts.arc, dmg: opts.dmg || 0, blast: opts.blast || null, pool: opts.pool || null, slow: opts.slow || null, pull: opts.pull || 0, boss: !!opts.boss, noHeal: opts.noHeal || 0, chain: opts.chain || null, born: S.clock, life: opts.life || 4000 });
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
    // 종류(침·저주 물약)와 궤적(곧게·포물선)은 좀비 표의 ranged가 정한다
    const kind = (rg.kind && PROJECTILE_KINDS[rg.kind]) || PROJECTILE_KINDS.spit;
    addProjectile(kind, from, aimVelocity(from, to, rg.speed, !!rg.arc), { arc: !!rg.arc, dmg: rg.dmg * dmgMul(S.stage), noHeal: rg.noHealMs || 0, life: 2500 });
  }
  /** 사슬꾼 그랩: 곧게 날아가는 갈고리. 맞은 사람은 그 사슬꾼 앞으로 끌려간다 */
  function shootGrab(Z, T) {
    const gb = Z.t.grab;
    const from = [Z.body.pos[0], Z.body.pos[1] + 1.3 * Z.scale, Z.body.pos[2]];
    const to = Z.grabAim || [T.pos[0], T.pos[1] + 1.0, T.pos[2]];
    Z.grabAim = null;
    addProjectile(PROJECTILE_KINDS.hook, from, aimVelocity(from, to, gb.speed, false), { dmg: gb.dmg * dmgMul(S.stage), pull: Z.id, life: (gb.range / gb.speed) * 1000 + 150 });
  }
  function addHazard(kind, x, y, z, h, boss = false) {
    if (hazards.length >= R.maxHazards) hazards.shift();
    hazards.push({ id: S.nextHaz++, kind: HAZARD_KINDS[kind] || 1, kindName: kind, x, y, z, r: h.r, until: S.clock + h.ms, ms: h.ms, dps: (h.dps || 0) * dmgMul(S.stage), slow: h.slow || 0, boss, afflicted: boss ? new Set() : null, tick: 0 });
  }
  /**
   * 연쇄 번개 구체가 사람에게 닿으면: 그 사람에게서 hop m 안의 보이는 다른 사람 중 가장 가까운 쪽으로 새 구체가 날아간다.
   * 이미 맞은 사람·무적인 사람은 건너뛰고, 튈 때마다 피해는 80%
   */
  function chainBolt(pr, from) {
    const hit = pr.chain.hit.concat(from.id);
    const at = [from.pos[0], from.pos[1] + 1.2, from.pos[2]];
    let best = null, bd = pr.chain.hop;
    for (const P of aliveList()) {
      if (!P.pos || hit.includes(P.id) || invulnerable(P)) continue;
      const to = [P.pos[0], P.pos[1] + 1.1, P.pos[2]];
      const d = Math.hypot(to[0] - at[0], to[1] - at[1], to[2] - at[2]);
      if (d < bd && (!world || lineOfSight(world, at, to))) { bd = d; best = to; }
    }
    if (!best) return null;
    const speed = Math.hypot(pr.vel[0], pr.vel[1], pr.vel[2]) || 1;
    return {
      kind: pr.kind, at, vel: aimVelocity(at, best, speed, false),
      opts: { dmg: pr.dmg * 0.8, boss: pr.boss, chain: { left: pr.chain.left - 1, hop: pr.chain.hop, hit }, life: (bd / speed) * 1000 + 300 }
    };
  }
  function stepProjectiles(dt, ev) {
    const bounced = [];
    for (let i = projectiles.length - 1; i >= 0; i--) {
      const pr = projectiles[i];
      const p0 = pr.pos.slice();
      if (pr.arc) pr.vel[1] += GRAVITY * dt;
      pr.pos[0] += pr.vel[0] * dt; pr.pos[1] += pr.vel[1] * dt; pr.pos[2] += pr.vel[2] * dt;
      let hitPlayer = null;
      for (const P of aliveList()) {
        if (!P.pos || (pr.chain && pr.chain.hit.includes(P.id))) continue;   // 튄 번개는 이미 맞은 사람을 지나간다
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
        const before = hitPlayer.hitUntil;
        hurtPlayer(hitPlayer, pr.dmg, null, ev, { at: [p0[0], p0[1], p0[2]], knock: pr.pull ? 0 : 0.6, zombie: true, boss: pr.boss });
        if (pr.slow) ev.push({ type: 'slow', id: hitPlayer.id, mul: pr.slow.mul, ms: pr.slow.ms });
        // 마녀의 저주: 피하지 않고 맞았으면 정해진 시간 동안 회복 불가
        if (pr.noHeal > 0 && hitPlayer.hitUntil !== before) {
          hitPlayer.noHealUntil = Math.max(hitPlayer.noHealUntil || 0, S.clock + pr.noHeal);
          ev.push({ type: 'noHeal', id: hitPlayer.id, ms: pr.noHeal });
        }
        // 빗나갔거나 회피·무적이면 끌지 않는다. 맞았으면 원래 포물선은 유지한 채 2초간 조작만 막는다
        const G = pr.pull ? zombies.get(pr.pull) : null;
        if (G && G.state !== 'dead' && hitPlayer.hitUntil !== before) {
          pullPlayer(hitPlayer, G);
          ev.push({ type: 'grabbed', id: hitPlayer.id }, { type: 'stun', id: hitPlayer.id, ms: 2000 });
        }
      }
      if (hitPlayer && pr.chain && pr.chain.left > 0) {
        const nx = chainBolt(pr, hitPlayer);
        if (nx) bounced.push(nx);
      }
      if (pr.blast) explodeAt(at, pr.blast.r, pr.blast.dmg * dmgMul(S.stage), null, ev, 'barrel', pr.boss);
      if (pr.pool) {
        const gy = world ? getGroundY(world, at[0], at[2], at[1] + 0.5) : 0;
        addHazard(pr.pool.kind, at[0], gy, at[2], pr.pool, pr.boss);
      }
      if (pr.chain) addFx('shock', at, 1.2);
      else if (!pr.blast && !hitPlayer) addFx('splat', at, 0.8);
    }
    for (const b of bounced) addProjectile(b.kind, b.at, b.vel, b.opts);
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
        const inside = hyp2(P.pos[0] - h.x, P.pos[2] - h.z) <= h.r && Math.abs(P.pos[1] - h.y) < 1.2;
        if (!inside) { if (h.afflicted) h.afflicted.delete(P.id); continue; }
        if (!invulnerable(P)) {
          applyHpLoss(P, h.dps * k, ev); // 장판은 방어·방패·회피·피격 무적·회복과 관계없이 고정 피해
          P.hurtAt = S.clock; P.hurtFrom = [h.x, h.y + 0.5, h.z];
          if (P.alive && h.boss) {
            const seen = h.afflicted || (h.afflicted = new Set());
            if (!seen.has(P.id)) { seen.add(P.id); bossHitEffects(P, ev); }
          }
        }
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
                : s.kind === 'chain' || s.kind === 'barrage' ? d < s.range
                  : s.kind === 'volley' || s.kind === 'pool' ? d > 3 && d < 30
                    : s.kind === 'scream' ? d < s.radius
                      : true;
      if (!ok) continue;
      if ((s.kind === 'volley' || s.kind === 'chain' || s.kind === 'pool' || s.kind === 'barrage') && world &&
        !lineOfSight(world, [p[0], p[1] + 2, p[2]], [T.pos[0], T.pos[1] + 1.2, T.pos[2]])) continue;
      Z.skillReady[i] = S.clock + s.cd * cdMul * (0.9 + rng() * 0.25);
      Z.skill = { i, s, phase: 'wind', until: S.clock + s.windup, tx: T.pos[0], ty: T.pos[1], tz: T.pos[2], target: T.id, t0: S.clock, hit: new Set(), r: 0 };
      if (s.kind === 'leap') aimLeap(Z.skill, T);
      Z.body.vel[0] = Z.body.vel[2] = 0;
      ev.push({ type: 'skill', z: Z.id, boss: b.id, kind: s.kind, x: Math.round(Z.skill.tx * 100) / 100, z2: Math.round(Z.skill.tz * 100) / 100, ms: s.windup });
      return true;
    }
    return false;
  }
  /**
   * 도약 착지점: 예고+체공 시간 동안 사람이 지금 속도로 달려갈 자리(최대 LEAP_LEAD_MAX m 앞)를 처음에 한 번 정한다.
   * 걸을 수 없는 자리면 가까운 걸을 수 있는 칸, 그것도 없으면 지금 사람 자리 쪽 칸
   */
  function aimLeap(k, T) {
    const lead = (k.s.windup + k.s.flightMs) / 1000;
    let dx = T.vel ? T.vel[0] * lead : 0, dz = T.vel ? T.vel[2] * lead : 0;
    const l = hyp2(dx, dz);
    if (l > LEAP_LEAD_MAX) { dx *= LEAP_LEAD_MAX / l; dz *= LEAP_LEAD_MAX / l; }
    const want = { x: T.pos[0] + dx, y: T.pos[1], z: T.pos[2] + dz };
    const near = (q) => (nav && nav.nearestWalkable ? nav.nearestWalkable(q, 3) : null);
    const n = near(want) || near({ x: T.pos[0], y: T.pos[1], z: T.pos[2] });
    k.to = n ? [n.x, n.y, n.z] : [want.x, want.y, want.z];
    k.tx = k.to[0]; k.ty = k.to[1]; k.tz = k.to[2];
  }

  function stepSkill(Z, T, dt, ev) {
    const k = Z.skill;
    const s = k.s;
    const p = Z.body.pos;
    const rage = Z.enraged ? Z.boss.enrage : null;
    const dmgK = dmgMul(S.stage) * (rage ? rage.dmg : 1);
    if (k.phase === 'wind') {
      if (s.kind === 'charge' || s.kind === 'leap' || s.kind === 'volley' || s.kind === 'chain' || s.kind === 'pool' || s.kind === 'barrage') {
        // 예고 동안은 목표를 따라 돈다(마지막 0.3초는 고정 → 피할 틈). 도약은 처음 정한 예상 착지점을 바꾸지 않는다
        if (s.kind !== 'leap' && T && T.pos && k.until - S.clock > 300) { k.tx = T.pos[0]; k.ty = T.pos[1]; k.tz = T.pos[2]; }
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
              hurtPlayer(P, s.dmg * dmgK * (1 - 0.4 * d / s.radius), Z, ev, { area: true });
              knock(P, p, s.knock, ev);
            }
          }
          Z.skill = null;
          return;
        }
        case 'nova': k.until = S.clock + (s.radius / s.speed) * 1000; addFx(s.shock ? 'shock' : 'nova', p, s.radius); break;
        case 'leap': {
          k.from = p.slice();
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
              arc: !!s.arc, dmg: (s.dmg || 0) * dmgK, blast: s.blast || null, pool: s.pool || null, slow: s.slow || null, boss: true, life: 4000
            });
          }
          Z.skill = null;
          return;
        }
        case 'pool': {
          // 장판 덩어리를 포물선으로 던진다. 떨어진 자리(사람에게 맞으면 그 자리)에 장판이 생긴다
          const from = [p[0], p[1] + 1.8 * Math.min(1.4, Z.scale), p[2]];
          addProjectile(PROJECTILE_KINDS[s.proj] || PROJECTILE_KINDS.ice, from, aimVelocity(from, [k.tx, k.ty + 0.3, k.tz], s.speed, true), {
            arc: true, pool: s.hazard, boss: true, life: 4000
          });
          Z.skill = null;
          return;
        }
        case 'scream': {
          addFx('scream', p, s.radius);
          for (const P of aliveList()) {
            // 무적(증강을 고르는 중·고른 직후·살아난 직후)인 사람은 느려지지 않는다
            if (P.pos && !invulnerable(P) && hyp2(P.pos[0] - p[0], P.pos[2] - p[2]) <= s.radius) ev.push({ type: 'slow', id: P.id, mul: s.slow, ms: s.ms });
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
          // 곧게 날아가는 번개 구체. 맞은 사람에게서 다른 사람에게 튄다(stepProjectiles chainBolt)
          const from = [p[0], p[1] + 2.2, p[2]];
          const to = [k.tx, k.ty + 1.1, k.tz];
          addProjectile(PROJECTILE_KINDS.bolt, from, aimVelocity(from, to, s.speed, false), {
            dmg: s.dmg * dmgK, boss: true, chain: { left: s.jumps - 1, hop: s.hop, hit: [] }, life: (s.range / s.speed) * 1000 + 300
          });
          Z.skill = null;
          return;
        }
        case 'barrage': {
          // 포격: 제자리에서 예고한 좁은 자리에 포탄 하나를 포물선으로 떨어뜨린다. 떨어질 때까지 그 자리를 계속 보여 준다(act)
          const from = [p[0], p[1] + 2.2 * Math.min(1.4, Z.scale), p[2]];
          const to = [k.tx, k.ty + 0.2, k.tz];
          addProjectile(PROJECTILE_KINDS.orb, from, aimVelocity(from, to, s.speed, true), { arc: true, blast: s.blast, boss: true, life: 4000 });
          k.until = S.clock + clamp(hyp2(to[0] - from[0], to[2] - from[2]) / s.speed, 0.35, 2.2) * 1000;
          k.shots = (k.shots || 0) + 1;
          break;
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
          hurtPlayer(P, s.dmg * dmgK, Z, ev, { area: true });
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
            if (d <= s.radius && Math.abs(P.pos[1] - p[1]) < 2.5) { hurtPlayer(P, s.dmg * dmgK * (1 - 0.4 * d / s.radius), Z, ev, { area: true }); knock(P, p, 7, ev); }
          }
          Z.skill = null;
          Z.attackReady = S.clock + 500;
        }
        return;
      }
      case 'barrage': {
        // 포탄이 떨어질 때까지 제자리. shots발을 다 떨어뜨리면 moveMs 동안 걸어 다니다 다시 포격한다
        if (world) moveCharacter(world, Z.body, { x: 0, z: 0 }, dt, { radius: Z.radius });
        if (S.clock < k.until) return;
        if (k.shots < s.shots) {
          k.phase = 'wind';
          k.until = S.clock + s.windup;
          if (T && T.pos) { k.tx = T.pos[0]; k.ty = T.pos[1]; k.tz = T.pos[2]; k.target = T.id; }
          ev.push({ type: 'skill', z: Z.id, boss: Z.boss.id, kind: s.kind, x: Math.round(k.tx * 100) / 100, z2: Math.round(k.tz * 100) / 100, ms: s.windup });
          return;
        }
        Z.skill = null;
        Z.skillReady[k.i] = S.clock + s.moveMs * (rage ? rage.cd : 1);
        return;
      }
      default: Z.skill = null;
    }
  }

  /** 보스 스킬의 밀치기(이벤트). 무적이거나 '부동자세' 증강이 있으면 밀지 않는다 */
  function knock(P, from, power, ev) {
    if (!P.pos || !(power > 0) || invulnerable(P) || P.perks.noKnock > 0) return;
    const dx = P.pos[0] - from[0], dz = P.pos[2] - from[2], l = hyp2(dx, dz) || 1;
    ev.push({ type: 'knock', id: P.id, v: [Math.round((dx / l) * power * 100) / 100, 4, Math.round((dz / l) * power * 100) / 100] });
  }

  /* ------------------------------------------------------------------ 한 간격 */
  function stepOnce(ms, ev) {
    if (S.phase === 'over') return;
    // 증강 고르기: 시계를 멈춘다(좀비·스테이지 시간·보급품·불길·분신이 모두 그대로). 고를 시간만 줄어든다
    if (S.phase === 'cards') {
      if (!connected().length) { gameOver(ev, 'left'); return; }
      S.cardsLeft -= ms;
      if (S.cardsLeft <= 0 || !anyOffers()) endCards(ev);
      return;
    }
    S.clock += ms;
    if (loot.size) expireLoot();
    const dt = ms / 1000;
    if (S.phase === 'prep' && S.clock >= S.phaseEnd) beginStage(ev);
    if (!connected().length) { if (S.phase !== 'over' && S.phase !== 'warmup') gameOver(ev, 'left'); return; }
    if (S.phase === 'wave') readPositions();
    // 사람: 회복
    for (const P of players.values()) {
      if (!P.alive || S.phase !== 'wave') continue;
      const regen = P.perks.regen;
      if (regen <= 0) continue;
      P.regenAcc += regen * dt;
      if (P.regenAcc >= 1 - 1e-9) { const n = Math.floor(P.regenAcc + 1e-9); P.regenAcc = Math.max(0, P.regenAcc - n); healPlayer(P, n); }
    }
    if (S.phase !== 'wave') return;
    // 화상은 피격 무적·회피와 별도로 1초마다 닳는다. 재피격은 종료 시각만 연장하고 중첩 피해를 만들지 않는다
    for (const P of players.values()) {
      if (!P.alive || !P.burnUntil) continue;
      while (P.burnNext <= S.clock && P.burnNext <= P.burnUntil && P.alive) {
        P.burnNext += BOSS_BURN_TICK_MS;
        if (invulnerable(P)) continue;
        const shield = Math.min(P.shield, BOSS_BURN_DAMAGE);
        P.shield -= shield;
        const dmg = BOSS_BURN_DAMAGE - shield;
        if (dmg > 0) {
          applyHpLoss(P, dmg, ev);
          P.hurtAt = S.clock; P.hurtFrom = null;
        }
      }
      if (S.clock >= P.burnUntil) P.burnUntil = P.burnNext = 0;
    }
    if (S.phase !== 'wave') return;
    if (revives.size) stepRevives(ms, ev);
    updateFlow();
    spawnTick(ev);
    if (swordWaves.length) stepSwordWaves(dt, ev);
    rebuildGrid();
    for (const Z of zombies.values()) {
      if (S.phase !== 'wave') break;
      stepZombie(Z, dt, ev);
    }
    if (S.phase !== 'wave') return;
    stepProjectiles(dt, ev);
    stepHazards(dt, ev);
    stepFields(dt, ev);
    for (const D of [...decoys.values()]) if (S.clock >= D.until) removeDecoy(D, ev, 'time');
    // 쓰러진 좀비 정리
    for (const [id, Z] of zombies) if (Z.state === 'dead' && S.clock - Z.deadAt > DEAD_KEEP_MS) zombies.delete(id);
    for (let i = fxList.length - 1; i >= 0; i--) if (S.clock - fxList[i].at > FX_KEEP_MS) fxList.splice(i, 1);
    if (S.phase !== 'wave') return;
    if (!R.pauseOnCards) expireOffers(ev);
    // 다 잡았으면 남은 시간 경험치를 받고 바로 다음 스테이지, 시간이 다 되면 남은 좀비를 둔 채 다음 스테이지
    if (!S.queue.length && ![...zombies.values()].some((Z) => Z.state !== 'dead')) clearStage(ev);
    else if (S.clock >= S.stageEnd) timeUp(ev);
    maybeCards(ev);
  }

  function tick(dtMs) {
    if (S.disposed || S.phase === 'warmup') return [];
    const ev = [];
    const d = num(dtMs, 0);
    if (!(d > 0)) return ev;
    S.tickAt = S.clock;                // 이번 tick이 시작한 시각(살리기 신호 끊김을 잰다)
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
    // 준비 중이면 바로 나오고, 아니면 다음 스테이지에 나온다(증강은 앞으로 오르는 레벨부터 함께 받는다)
    if (S.phase === 'prep') spawnPlayer(P, players.size - 1, ev);
    return ev;
  }

  function removePlayer(id) {
    const P = players.get(String(id));
    if (!P || !P.connected) return [];
    P.connected = false;
    const ev = [{ type: 'leave', id: P.id }];
    if (P.alive) { P.alive = false; }
    P.offer = null; P.picks = 0; P.chestPicks = 0;
    P.yasuoHits = 0; P.yasuoExpires = 0; P.yasuoSwing = null;
    // 나간 사람은 쓰러진 몸도 없다(다시 들어오면 다음 스테이지에 나온다). 이 사람이 하던 살리기, 이 사람을 살리던 것도 끝
    P.downPos = null;
    revives.delete(P.id);
    dropRevivesBy(P.id);
    for (const D of [...decoys.values()]) if (D.owner === P.id) removeDecoy(D, null, 'leave');
    if (S.phase === 'cards' && !anyOffers() && connected().length) endCards(ev);
    if (!connected().length) gameOver(ev, 'left');
    else if (S.phase === 'wave' && !aliveList().length) gameOver(ev, 'wiped');
    return ev;
  }

  /* ------------------------------------------------------------------ 스냅샷 */
  function snapshot() {
    const now = S.clock;
    const p = [];
    const pids = [...players.keys()];
    for (const P of players.values()) {
      const hurt = P.hurtFrom && now - P.hurtAt < HURT_KEEP_MS ? [cm(P.hurtFrom[0]), cm(P.hurtFrom[2]), Math.round(now - P.hurtAt)] : 0;
      // 밀려남: [번호, 속도 x, y, z(cm/s), 지난 ms] (knockKeepMs 동안만) · 쓰러진 자리: [x, y, z(cm), 살리기 진행(0~1000), 살리는 사람 번호(p 순서, 없으면 -1)]
      const kn = P.knockV && now - P.knockAt < R.knockKeepMs ? [P.knockSeq, cm(P.knockV[0]), cm(P.knockV[1]), cm(P.knockV[2]), Math.round(now - P.knockAt)] : 0;
      // 쓰러진 자리는 살릴 수 있는 웨이브 동안만 싣는다(전멸 화면에 표시가 남지 않게)
      const rv = !P.alive && P.downPos ? revives.get(P.id) : null;
      const dn = !P.alive && P.downPos && S.phase === 'wave'
        ? [cm(P.downPos[0]), cm(P.downPos[1]), cm(P.downPos[2]), rv ? Math.round(clamp(rv.ms / R.reviveHoldMs, 0, 1) * 1000) : 0, rv ? pids.indexOf(rv.by) : -1]
        : 0;
      p.push([
        P.id, P.name, Math.round(P.hp), P.maxHp, P.alive ? 1 : 0, P.kills, P.connected ? 1 : 0, encodeCards(P.cards),
        P.offer ? encodeCards(P.offer.cards) : '', P.offer ? P.offer.rerolls : 0, P.picked ? 1 : 0, P.downs, Math.round(P.damage),
        Math.round(P.shield), P.heads, P.bossKills, hurt, P.spawned ? 1 : 0, P.picks, P.offer && P.offer.chest ? 1 : 0,
        P.offer && !R.pauseOnCards ? Math.max(0, Math.round(P.offerUntil - now)) : 0, invulnerable(P) ? Math.max(1, Math.round((P.offer ? 0 : P.invulnUntil - now))) : 0,
        kn, dn,
        Math.max(0, Math.round((P.burnUntil || 0) - now)), Math.max(0, Math.round((P.burnNext || 0) - now)),
        Math.max(0, Math.round((P.noHealUntil || 0) - now)),
        [P.yasuoHits, Math.max(0, Math.round(P.yasuoExpires - now)), P.yasuoLastShot, P.yasuoLastShot ? Math.max(0, Math.round(now - P.yasuoLastAt)) : 0]
      ]);
    }
    const z = [];
    const killers = [];
    for (const Z of zombies.values()) {
      let f = 0;
      if (Z.state === 'dead') f |= ZF.dead;
      if (Z.state === 'wind' || (Z.skill && Z.skill.phase === 'wind')) f |= ZF.wind;
      if (Z.state === 'rise') f |= ZF.rise;
      if (Z.slowUntil > now) f |= ZF.slow;
      if (Z.hasteUntil > now) f |= ZF.haste;
      if (Z.armorUntil > now) f |= ZF.armor;
      if (Z.enraged) f |= ZF.rage;
      if ((Z.skill && Z.skill.s.kind === 'leap' && Z.skill.phase === 'act') || Z.knockUntil > now) f |= ZF.air;
      if (Z.frozenUntil > now) f |= ZF.frozen;
      if (Z.state === 'wind' && Z.windGrab) f |= ZF.hook;   // 그랩 예고: 화면이 겨눈 쪽으로 바닥 선을 그린다
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
    // 투사체: [번호, 종류, x, y, z, vx, vy, vz(cm), 포물선, 그랩을 던진 좀비 번호(그 손에서 사슬을 그린다, 없으면 0)]
    const pr = projectiles.map((q) => [q.id, q.kind, cm(q.pos[0]), cm(q.pos[1]), cm(q.pos[2]), cm(q.vel[0]), cm(q.vel[1]), cm(q.vel[2]), q.arc ? 1 : 0, q.pull || 0]);
    const hz = hazards.map((h) => [h.id, h.kind, cm(h.x), cm(h.y), cm(h.z), cm(h.r), Math.max(0, Math.round(h.until - now)), h.ms]);
    const fx = fxList.map((e) => [e.id, e.kind, cm(e.x), cm(e.y), cm(e.z), cm(e.r), Math.round(now - e.at)]);
    // 바닥 보급품: [번호, 종류 코드, x, y, z(cm), 남은 시간(0.1초)]
    const lt = [...loot.values()].map((L) => [L.id, LOOT_TYPES[L.kind].code, cm(L.x), cm(L.y), cm(L.z), Math.max(0, Math.round((L.until - now) / 100))]);
    // 불길: [번호, 종류, x, y, z, 반지름(cm), 남은 ms, 전체 ms] · 분신: [번호, x, y, z, 체력 %, 주인 번호(p 순서), 남은 ms]
    const af = fields.map((f) => [f.id, f.kind, cm(f.x), cm(f.y), cm(f.z), cm(f.r), Math.max(0, Math.round(f.until - now)), f.ms]);
    const dc = [...decoys.values()].map((D) => [D.n, cm(D.pos[0]), cm(D.pos[1]), cm(D.pos[2]), Math.ceil((D.hp / D.maxHp) * 100), pids.indexOf(D.owner), Math.max(0, Math.round(D.until - now))]);
    // 진행 중인 질풍검 충격파는 방장 이전 뒤에도 같은 적을 두 번 맞히지 않도록 적중 번호와 보스 10배를 썼는지를 싣는다.
    const yt = swordWaves.map((w) => [pids.indexOf(w.owner), cm(w.pos[0]), cm(w.pos[1]), cm(w.pos[2]), w.dir[0], w.dir[2], cm(w.left), [...w.hit], w.bossDone ? 1 : 0]);
    let alive = 0;
    for (const Z of zombies.values()) if (Z.state !== 'dead') alive++;
    const stageLeft = S.phase === 'wave' || S.phase === 'cards' ? Math.max(0, Math.round(S.stageEnd - now)) : null;
    return {
      v: HORDE_SNAPSHOT_VERSION,
      ph: S.phase === 'over' ? 'matchEnd' : S.phase === 'warmup' ? 'warmup' : 'live',
      zp: PHASE_CODE[S.phase], st: S.stage,
      tl: S.phase === 'cards' ? Math.max(0, Math.round(S.cardsLeft)) : S.phaseEnd ? Math.max(0, Math.round(S.phaseEnd - now)) : null,
      sl: stageLeft, xp: [S.level, S.xp, xpNeed(S.level, R), S.xpTotal],
      el: S.startedAt == null ? 0 : Math.round((S.endedAt != null ? S.endedAt : now) - S.startedAt),
      sd: seed, left: S.queue.length + alive, tot: S.total, kd: S.killedStage, rb: S.recentBosses.slice(0, 10), fs: S.firstStage,
      p, z, kz: killers, b, pr, hz, fx, lt, af, dc, yt, over: S.over
    };
  }

  function dispose() { S.disposed = true; zombies.clear(); players.clear(); loot.clear(); decoys.clear(); revives.clear(); fields.length = 0; projectiles.length = 0; hazards.length = 0; swordWaves.length = 0; }

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
    if (view.xp) { S.level = Math.max(1, view.xp.level | 0); S.xp = Math.max(0, view.xp.xp | 0); S.xpTotal = Math.max(0, view.xp.total | 0); }
    S.stageEnd = S.clock + Math.max(3000, view.stageLeftMs == null ? R.stageMs : view.stageLeftMs);
    for (const vp of view.players) {
      let P = players.get(vp.id);
      if (!P) { P = makePlayer({ id: vp.id, name: vp.name }); P.connected = false; players.set(vp.id, P); }
      P.cards = vp.cards.slice();
      refreshStats(P);
      P.hp = vp.hp; P.alive = !!vp.alive && P.connected; P.spawned = !!vp.spawned;
      P.kills = vp.kills; P.heads = vp.heads; P.bossKills = vp.bossKills; P.damage = vp.damage; P.downs = vp.downs; P.shield = vp.shield;
      P.picked = !!vp.picked;
      P.picks = Math.max(0, vp.picks | 0);
      P.chestPicks = vp.chest ? 1 : 0;
      P.offer = vp.offer.length ? { cards: vp.offer.slice(), roll: 5, round: ++S.offerRound, rerolls: vp.rerolls, count: vp.offer.length, chest: !!vp.chest } : null;
      if (P.offer && P.picks < 1) P.picks = 1;
      P.offerUntil = S.clock + Math.max(5000, vp.offerLeftMs || R.cardMs);
      P.invulnUntil = vp.invuln ? S.clock + Math.min(R.pickInvulnMs, vp.invulnMs || R.pickInvulnMs) : 0;
      P.hitUntil = 0;
      P.yasuoHits = vp.yasuoHits || 0;
      P.yasuoExpires = S.clock + (vp.yasuoStackMs || 0);
      P.yasuoLastShot = vp.yasuoLastShot || 0;
      P.yasuoLastAt = P.yasuoLastShot ? S.clock - (vp.yasuoLastAgo || 0) : -Infinity;
      // 쓰러진 자리는 잇는다(동료가 그 자리에서 살린다. 하던 살리기는 처음부터). 아직 화면에 실리는 밀려남은 같은 번호로 이어 싣는다
      P.downPos = !P.alive && P.connected && vp.down ? vp.down.pos.slice() : null;
      if (vp.knock && vp.knock.ago < R.knockKeepMs) { P.knockSeq = vp.knock.seq | 0; P.knockV = vp.knock.v.slice(); P.knockAt = S.clock - vp.knock.ago; }
      P.burnUntil = S.clock + (vp.burnMs || 0);
      P.burnNext = S.clock + (vp.burnNextMs || 0);
      P.noHealUntil = S.clock + (vp.noHealMs || 0);
    }
    // 바닥 보급품은 번호와 남은 시간을 그대로 잇는다(화면의 보급품이 바뀌지 않게)
    for (const vl of view.loot || []) {
      loot.set(vl.id, { id: vl.id, kind: vl.kind, x: vl.pos[0], y: vl.pos[1], z: vl.pos[2], until: S.clock + vl.leftMs });
      S.nextLoot = Math.max(S.nextLoot, vl.id + 1);
    }
    const phase = view.phase;
    if (phase === 'wave' || phase === 'cards') {
      let alive = 0;
      for (const vz of view.zombies) {
        if (vz.dead) continue;
        const spec = vz.boss ? { boss: vz.boss.id } : { type: (vz.type || ZOMBIE_TYPES.walker).id };
        const Z = makeZombie(spec, vz.pos.slice());
        // 스냅샷에는 이미 비행 높이가 들어 있다. makeZombie의 스폰 높이를 두 번 더하지 않는다.
        if (Z.t && Z.t.flying) Z.body.pos[1] = vz.pos[1];
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
      for (const w of view.swordWaves || []) if (players.get(w.owner)?.alive && w.left > 0)
        swordWaves.push({ owner: w.owner, pos: w.pos.slice(), dir: w.dir.slice(), left: w.left, hit: new Set(w.hit), bossDone: w.bossDone });
      for (let i = Math.max(0, view.left - alive); i > 0; i--) S.queue.push({ type: pickWeighted(mix, rng).type.id });
      S.spawnAt = S.clock + 1500;
      if (phase === 'cards') { S.phase = 'cards'; S.cardsLeft = Math.max(5000, view.timeLeftMs || R.cardMs); }
      else S.phase = 'wave';
    } else if (phase === 'prep') { S.phase = 'prep'; S.phaseEnd = S.clock + Math.max(1500, view.timeLeftMs || R.prepMs); }
    else { S.phase = 'wave'; S.stageEnd = S.clock + R.stageMs; S.spawnAt = S.clock + 1500; }
    S.startedAt = 0;
  }
  if (o.restore) restoreFrom(o.restore);

  return {
    start, tick, claimHit, claimSwordSwing, claimExplosion, cardAction, claimLoot, reviveAction, addPlayer, removePlayer, snapshot, dispose,
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
    get internals() { return { S, zombies, players, projectiles, hazards, fxList, loot, gates, decoys, fields, revives, addXp: (n) => { const ev = []; addXp(n, ev); maybeCards(ev); return ev; } }; },
    /** 이어받기(restoreHorde) 뒤 바로 다음 단계를 시작할 때 쓴다 */
    resume() {
      const ev = [];
      if (S.phase === 'wave') {
        let i = 0;
        for (const P of players.values()) if (P.connected && P.alive) ev.push({ type: 'spawn', id: P.id, spawn: null, hp: P.hp, maxHp: P.maxHp, keep: true, i: i++ });
        ev.push({ type: 'phase', phase: 'wave', stage: S.stage, ms: 0, resumed: true });
      } else ev.push({ type: 'phase', phase: S.phase, stage: S.stage, ms: S.phase === 'cards' ? Math.round(S.cardsLeft) : S.phaseEnd ? Math.round(S.phaseEnd - S.clock) : 0, resumed: true });
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
  // 살리는 사람 번호는 p 줄의 순서다(틀린 줄을 건너뛰어도 어긋나지 않게 원래 줄로 찾는다)
  const rowIds = s.p.map((r) => (Array.isArray(r) ? String(r[0]) : null));
  for (const r of s.p) {
    if (!Array.isArray(r) || r.length < 12) continue;
    const hurt = Array.isArray(r[16]) ? { x: fromCm(r[16][0]), z: fromCm(r[16][1]), ago: num(r[16][2]) } : null;
    const kn = Array.isArray(r[22]) ? r[22] : null;
    const dn = Array.isArray(r[23]) ? r[23] : null;
    const by = dn ? num(dn[4], -1) | 0 : -1;
    players.push({
      id: String(r[0]), name: String(r[1] || ''), hp: num(r[2]), maxHp: Math.max(1, num(r[3], 100)), alive: !!r[4], kills: num(r[5]) | 0,
      connected: !!r[6], cards: decodeCards(r[7]), offer: decodeCards(r[8]), rerolls: num(r[9]) | 0, picked: !!r[10], downs: num(r[11]) | 0,
      damage: num(r[12]) | 0, shield: num(r[13]) | 0, heads: num(r[14]) | 0, bossKills: num(r[15]) | 0, hurt, spawned: r[17] === undefined ? true : !!r[17],
      picks: num(r[18]) | 0, chest: !!r[19], offerLeftMs: num(r[20]) | 0, invuln: num(r[21]) > 0, invulnMs: num(r[21]) | 0,
      knock: kn ? { seq: num(kn[0]) | 0, v: [fromCm(kn[1]), fromCm(kn[2]), fromCm(kn[3])], ago: num(kn[4]) } : null,
      down: dn ? { pos: [fromCm(dn[0]), fromCm(dn[1]), fromCm(dn[2])], progress: clamp(num(dn[3]) / 1000, 0, 1), by: by >= 0 && rowIds[by] ? rowIds[by] : null } : null,
      burnMs: Math.max(0, num(r[24]) | 0), burnNextMs: Math.max(0, num(r[25]) | 0), noHealMs: Math.max(0, num(r[26]) | 0),
      yasuoHits: Array.isArray(r[27]) ? clamp(num(r[27][0]) | 0, 0, 2) : 0,
      yasuoStackMs: Array.isArray(r[27]) ? Math.max(0, num(r[27][1]) | 0) : 0,
      yasuoLastShot: Array.isArray(r[27]) ? Math.max(0, num(r[27][2]) | 0) : 0,
      yasuoLastAgo: Array.isArray(r[27]) ? Math.max(0, num(r[27][3]) | 0) : 0
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
    id: num(r[0]) | 0, kind: num(r[1]) | 0, pos: [fromCm(r[2]), fromCm(r[3]), fromCm(r[4])], vel: [fromCm(r[5]), fromCm(r[6]), fromCm(r[7])], arc: !!r[8], owner: num(r[9]) | 0
  }));
  const hazards = (Array.isArray(s.hz) ? s.hz : []).filter(Array.isArray).map((r) => ({
    id: num(r[0]) | 0, kind: num(r[1]) | 0, pos: [fromCm(r[2]), fromCm(r[3]), fromCm(r[4])], r: fromCm(r[5]), leftMs: num(r[6]), ms: Math.max(1, num(r[7], 1))
  }));
  const fx = (Array.isArray(s.fx) ? s.fx : []).filter(Array.isArray).map((r) => ({
    id: num(r[0]) | 0, kind: String(r[1] || ''), pos: [fromCm(r[2]), fromCm(r[3]), fromCm(r[4])], r: fromCm(r[5]), ago: num(r[6])
  }));
  const loot = [];
  for (const r of Array.isArray(s.lt) ? s.lt : []) {
    const def = Array.isArray(r) ? lootByCode(r[1]) : null;
    if (!def) continue;
    loot.push({ id: num(r[0]) | 0, kind: def.id, pos: [fromCm(r[2]), fromCm(r[3]), fromCm(r[4])], leftMs: Math.max(0, num(r[5]) * 100) });
  }
  const fields = (Array.isArray(s.af) ? s.af : []).filter(Array.isArray).map((r) => ({
    id: num(r[0]) | 0, kind: num(r[1]) | 0, pos: [fromCm(r[2]), fromCm(r[3]), fromCm(r[4])], r: fromCm(r[5]), leftMs: num(r[6]), ms: Math.max(1, num(r[7], 1))
  }));
  const decoys = (Array.isArray(s.dc) ? s.dc : []).filter(Array.isArray).map((r) => ({
    id: num(r[0]) | 0, pos: [fromCm(r[1]), fromCm(r[2]), fromCm(r[3])], hpFrac: clamp(num(r[4]) / 100, 0, 1), owner: players[num(r[5], -1)] ? players[num(r[5])].id : null, leftMs: num(r[6])
  }));
  const swordWaves = (Array.isArray(s.yt) ? s.yt : []).filter((r) => Array.isArray(r) && rowIds[r[0]]).map((r) => ({
    owner: rowIds[r[0]], pos: [fromCm(r[1]), fromCm(r[2]), fromCm(r[3])], dir: [num(r[4]), 0, num(r[5])],
    left: fromCm(r[6]), hit: Array.isArray(r[7]) ? r[7].map((id) => num(id) | 0) : [], bossDone: r[8] === 1
  }));
  const xa = Array.isArray(s.xp) ? s.xp : [1, 0, 10, 0];
  return {
    mode: 'zombie', phase, stage: num(s.st) | 0, firstStage: Math.max(1, num(s.fs, 1) | 0), timeLeftMs: s.tl == null ? null : num(s.tl), elapsedMs: num(s.el), seed: num(s.sd) >>> 0,
    stageLeftMs: s.sl == null ? null : num(s.sl), xp: { level: Math.max(1, num(xa[0], 1) | 0), xp: num(xa[1]) | 0, need: Math.max(1, num(xa[2], 10) | 0), total: num(xa[3]) | 0 },
    left: num(s.left) | 0, total: num(s.tot) | 0, killedStage: num(s.kd) | 0, recentBosses: Array.isArray(s.rb) ? s.rb.map(String) : [],
    players, zombies, bosses, projectiles, hazards, fx, loot, fields, decoys, swordWaves, over: s.over && typeof s.over === 'object' ? { ...s.over } : null
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
    cards: me ? me.cards.length : 0, level: view && view.xp ? view.xp.level : 1
  };
}

/**
 * 폭발 종류별 배율: 손으로 던진 수류탄 10(폭심 기본 피해 1000), 유탄 발사기 1.2(여러 발), 바주카포 2.6(한 발씩), 말뚝건 4.5(반경 1.2 m 안 450),
 * 투척 도끼 7(뚫고 지나가며 닿은 좀비마다 700), 제우스의 번개 1.5(맞은 좀비와 튄 다섯 마리 모두 150)
 */
export const BLAST_MUL = Object.freeze({ nade: 10, gl: 1.2, rocket: 2.6, stake: 4.5, axe: 7, bolt: 1.5 });

/** 대상별 피해 배율: 보스 피해 증가와 일반 좀비 피해 감소를 같은 경로로 적용한다. */
function targetDamageMul(k, boss) {
  return boss ? 1 + ((k && k.boss) || 0) : 1 - Math.min(1, (k && k.normalPenalty) || 0);
}

/** 수류탄·발사체 폭발 피해(화면이 잰 피해 → 이 모드의 피해): 종류 배율 × 모든 피해 × 수류탄 피해(보스면 보스 피해도) */
export function nadeDamage(dmg, k, boss = false, kind = null) {
  const kk = k || {};
  const base = BLAST_MUL[kind] || BLAST_MUL.nade;
  const side = (kind === 'gl' || kind === 'rocket' || kind === 'stake') && (kk.sideMaster || 0) > 0 ? 6 : 1;   // 보조무기 마스터: 보조 발사기 피해 +500%
  return clamp(num(dmg), 0, 100) * base * (1 + (kk.dmg || 0)) * (1 + (kk.nade || 0)) * targetDamageMul(kk, boss) * side;
}

/**
 * 좀비 한 발의 피해(치명타·좀비 방어 버프 빼고). 방장 판정(claimHit)과 화면의 피해 숫자가 같은 공식을 쓴다.
 * c = { weaponId, part, dist, kind, count }, k = 쏜 사람의 능력치(computePerks), z = { boss, hpFrac }, o = { myHpFrac, nth(관통 순서), air(점프로 떠 있는가) }
 * kind: 'stab'·'waveStab'(찌르기의 검기)은 찌르기 피해, 'slash'·'wave'(베기의 검기)는 베기 피해. 검기도 칼 피해라 칼 증강이 붙는다
 * → { dmg, head, melee, part } | null(쓸 수 없는 무기)
 */
export function zombieHitDamage(c = {}, k = {}, z = {}, o = {}) {
  const def = getDef(c.weaponId);
  if (!def || def.explosion) return null;
  const melee = !!def.melee;
  let part = String(c.part || 'body');
  if (part === 'hand') part = 'body';
  else if (part === 'foot') part = 'legs';
  const dist = Math.max(0, num(c.dist));
  const count = clamp(num(c.count, 1) | 0, 1, Math.max(1, def.pellets || 1));
  const stab = c.kind === 'stab' || c.kind === 'waveStab';
  let base = computeDamage(def.id, part, dist, stab ? 'stab' : 'slash', count);
  // 보스 머리는 몸 피해의 2.2배까지만(라이플 머리 110이 보스를 몇 초 만에 녹이지 않게)
  if (z.boss && part === 'head' && !melee) base = Math.min(base, computeDamage(def.id, 'body', dist, undefined, count) * 2.2);
  let mul = 1 + (k.dmg || 0);
  const head = part === 'head' && !melee;
  if (head) mul *= 1 + (k.head || 0);
  else if (!melee && k.bodyPenalty > 0) mul *= 1 - Math.min(1, k.bodyPenalty);
  mul *= targetDamageMul(k, !!z.boss);
  if (melee) mul *= 1 + (k.melee || 0);
  if ((k.lastStand || 0) > 0 && num(o.myHpFrac, 1) <= 0.35) mul *= 1 + k.lastStand;
  if ((k.executioner || 0) > 0 && num(z.hpFrac, 1) <= 0.25) mul *= 1 + k.executioner;
  const nth = Math.max(0, num(o.nth, 0) | 0);
  if (nth > 0) mul *= Math.max(PIERCE_MIN, Math.pow(PIERCE_FALLOFF, nth));
  if ((k.airDmg || 0) > 0 && o.air && !melee) mul *= 1 + k.airDmg;   // 공중 강타: 총만(칼·수류탄 제외)
  if ((k.sideMaster || 0) > 0 && def.slot === 2) mul *= 6;   // 보조무기 마스터: 보조무기 피해 +500%
  return { dmg: base * mul, head, melee, part };
}

export { isZombieId, BOSS_CODE_BASE, BOSSES };
