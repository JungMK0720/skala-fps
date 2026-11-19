/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 좀비 물량 막기 시험. 카드 180장 넘게·전송 번호 고정·제안·다시 뽑기·능력치 상한, 보스 10종과 스테이지별 보스 수, 탄약 3배와 무기 배율,
 *          방장 시뮬레이션(40초 스테이지·남은 시간 경험치·팀 레벨과 증강 고르기(혼자는 멈추고 멀티는 고르는 사람만 무적)·처치·전멸·스냅샷 왕복·방장 이전),
 *          좀비 문·바닥 보급품(구급 상자·탄창·보물 상자), 무기 교체의 탄 기억, 좀비 전용 맵(검사기·모드별 맵 목록·시뮬레이션), 카드 고르기 입력 잠금,
 *          고르는 사람은 좀비가 노리지 않음·수류탄 증강 +2·맞은 뒤 무적·밀려남·멀티 동료 살리기·검기·새 카드를 three.js 없이 확인한다.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCollision, isZombieMap } from '../js/maps/collision.js';
import { buildNavGrid } from '../js/game/navgrid.js';
import { getGroundY } from '../js/engine/physics.js';
import { CARDS, CARD_COUNT, TIERS, computePerks, perkMaxHp, perkSummary, makeOffer, encodeCards, decodeCards, cardById, cardAvailable, PERK_CAPS } from '../js/game/horde/cards.js';
import { BOSSES, pickBosses, SKILL_KINDS } from '../js/game/horde/bosses.js';
import {
  HORDE, bossCount, zombieCount, hpMul, hordeAmmo, makeRng, zombieMix, LOOT_TYPES, rollDrop, lootByCode, xpNeed, timeBonusXp, zombieXp, ZOMBIE_IDS
} from '../js/game/horde/rules.js';
import { createHorde, applyHordeSnapshot, restoreHorde, hordeSummary, zombieIdOf, zombieHitDamage, nadeDamage } from '../js/game/horde/director.js';
import { modsFromPerks } from '../js/game/horde/client.js';
import { hordeSpawnPrimary } from '../js/game/horde/solo.js';
import { zombieReward } from '../js/account/economy.js';
import { WEAPONS } from '../js/weapons/defs.js';
import { createArsenal } from '../js/weapons/logic.js';
import { createPickGate, CARD_ARM_MS, CARD_REARM_MS, REROLL_HOLD_MS } from '../js/ui/cards.js';

/** 시험장: 가운데 벽 하나와 상자 몇 개(맵 파일에 기대지 않는다) */
const ARENA = Object.freeze({
  id: 'horde-arena',
  size: { x: 70, z: 50 },
  theme: { ground: 'concrete', fog: [60, 240] },
  spawns: {
    owner: [{ x: -28, z: -4 }, { x: -28, z: 0 }, { x: -28, z: 4 }, { x: -28, z: 8 }],
    charterer: [{ x: 28, z: -10 }, { x: 28, z: 0 }, { x: 28, z: 10 }, { x: 10, z: 20 }]
  },
  solids: [
    { type: 'box', x: 0, y: 0, z: -8, w: 1, h: 3, d: 20, mat: 'concrete' },
    { type: 'box', x: -12, y: 0, z: 12, w: 3, h: 1, d: 3, mat: 'concrete' },
    { type: 'box', x: 12, y: 0, z: -14, w: 3, h: 2.4, d: 3, mat: 'concrete' }
  ]
});
const ZOMBIE_MAP_IDS = ['restarea', 'subway'];
const col = buildCollision(ARENA);
const nav = buildNavGrid(ARENA);
/** 시뮬레이션 한 간격(30 Hz) */
const STEP = 1000 / HORDE.simHz;

function makeDirector({ rules = {}, ...extra } = {}) {
  const me = { pos: [-28, 0, 0] };
  const d = createHorde({
    players: [{ id: 'p1', name: '하늘' }], world: col.world, nav, spawns: col.spawns, seed: 11,
    getPositions: () => ({ p1: me.pos }), rules: { prepMs: 300, cardMs: 2000, ...rules }, ...extra
  });
  return { d, me };
}
/** 가장 가까운 살아 있는 좀비를 몸통 사격으로 쓰러뜨린다 */
function killAll(d, attackerId = 'p1') {
  const ev = [];
  let shot = 0;
  for (const Z of d.internals.zombies.values()) {
    let guard = 0;
    while (Z.state !== 'dead' && guard++ < 400) ev.push(...d.claimHit({ attackerId, victimId: 'z' + Z.id, weaponId: 'sr_heavy', part: 'body', dist: 10, kind: 'shot', count: 1, shotId: ++shot }));
  }
  return ev;
}
function runUntil(d, pred, maxMs = 120000, onTick) {
  let t = 0;
  const all = [];
  while (t < maxMs) {
    const ev = d.tick(100);
    all.push(...ev);
    t += 100;
    if (onTick) all.push(...(onTick() || []));
    if (pred(all)) return all;
  }
  return all;
}
/** n 간격만큼 돈다 → 이벤트 */
function step(d, n = 1) {
  const ev = [];
  for (let i = 0; i < n; i++) ev.push(...d.tick(STEP));
  return ev;
}
const alive = (d) => [...d.internals.zombies.values()].filter((Z) => Z.state !== 'dead');

/**
 * 벽 없는 시험장(world·nav 없음): 좀비는 곧장 걷고, 좀비가 나오는 자리는 400 m 밖이라 일부러 옮기지 않으면 사람에게 닿지 않는다.
 * 사람 i는 (4i, 0, 0)에 선다. 스테이지·증강 시간은 길게 둔다(시험이 직접 넘긴다)
 */
const FAR_SPAWNS = Object.freeze({
  owner: [{ x: 0, z: 0 }, { x: 4, z: 0 }, { x: 8, z: 0 }, { x: 12, z: 0 }],
  charterer: [{ x: 400, z: 0 }, { x: 400, z: 40 }, { x: -400, z: 0 }]
});
const FLAT_RULES = Object.freeze({ prepMs: 100, stageMs: 600000, cardMs: 600000 });
function makeFlat({ ids = ['p1'], rules = {}, nav: navOverride = null, ...extra } = {}) {
  const pos = {};
  ids.forEach((id, i) => { pos[id] = [i * 4, 0, 0]; });
  const d = createHorde({
    players: ids.map((id) => ({ id, name: id.toUpperCase() })), world: null, nav: navOverride, spawns: FAR_SPAWNS, seed: 7,
    getPositions: () => pos, rules: { ...FLAT_RULES, ...rules }, ...extra
  });
  d.start();
  runUntil(d, () => d.phase === 'wave', 2000);
  return { d, pos, P: (id) => d.internals.players.get(id) };
}
/** at(발 자리) 가슴 높이에 침 한 발. vel을 주면 그쪽으로 날아와 다음 간격에 맞는다 */
let spitSeq = 90000;
function spitAt(d, at, dmg, vel = [0, 0, 0]) {
  const S = d.internals.S;
  d.internals.projectiles.push({
    id: ++spitSeq, kind: 1, pos: [at[0] - vel[0] / HORDE.simHz, at[1] + 1, at[2] - vel[2] / HORDE.simHz], vel: vel.slice(), arc: false,
    dmg, blast: null, pool: null, slow: null, born: S.clock, life: 4000
  });
}
/** 좀비 Z를 at에 세우고 다음 간격에 바로 때리게 한다(휘두르기가 막 끝난 상태) */
function swing(d, Z, at) {
  Z.body.pos[0] = at[0]; Z.body.pos[1] = at[1]; Z.body.pos[2] = at[2];
  Z.state = 'wind'; Z.until = d.internals.S.clock; Z.windRanged = false; Z.skill = null;
}
/** 보스 하나를 바로 세운다(일어나는 동작 없이). skill만 곧 쓰게 하고 다른 스킬과 근접 공격은 막는다 */
function bossAt(d, bossId, at, skill) {
  const S = d.internals.S;
  const before = new Set(d.internals.zombies.keys());
  S.queue.unshift({ boss: bossId });
  S.spawnAt = 0;
  step(d);
  const Z = [...d.internals.zombies.values()].find((z) => z.boss && !before.has(z.id));
  Z.state = 'move';
  Z.body.pos[0] = at[0]; Z.body.pos[1] = at[1]; Z.body.pos[2] = at[2];
  Z.skillReady = Z.boss.skills.map((s) => (s.kind === skill ? 0 : Infinity));
  Z.attackReady = Infinity;
  return Z;
}
/** id를 지금 자리에서 쓰러뜨린다(체력 1에 침 한 발) → 이벤트 */
function knockDown(d, pos, id) {
  d.internals.players.get(id).hp = 1;
  spitAt(d, pos[id], 50);
  return step(d);
}
/** 살리기를 누르고 있다: 화면처럼 0.3초마다 신호를 보내며 ms만큼 돈다 → 이벤트 */
function holdRevive(d, helper, target, ms, onStep) {
  const ev = [];
  const n = Math.round(ms / STEP);
  for (let i = 1; i <= n; i++) {
    ev.push(...step(d));
    if (i % 9 === 0) ev.push(...d.reviveAction(helper, target, true));
    if (onStep) onStep(i * STEP);
  }
  return ev;
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

describe('카드', () => {
  test('100장 이상이고 id·번호가 겹치지 않으며 네 등급이 모두 있다', () => {
    assert.ok(CARD_COUNT >= 100, `카드 ${CARD_COUNT}장`);
    assert.equal(new Set(CARDS.map((c) => c.id)).size, CARD_COUNT);
    assert.deepEqual(CARDS.map((c) => c.idx), CARDS.map((_, i) => i));
    for (const t of Object.keys(TIERS)) assert.ok(CARDS.some((c) => c.tier === t), t);
    for (const c of CARDS) { assert.ok(c.name && c.desc && c.icon, c.id); assert.ok(TIERS[c.tier], c.id); }
  });

  test('요청에 있던 카드: 최대 탄창·연사·재장전 탄창(기본만큼 늘리고 가득)·이동·최대 속도·체력', () => {
    assert.ok(cardById('mag1').fx.mag > 0);
    assert.ok(cardById('trigger1').fx.fireRate > 0);
    const ammo = cardById('ammo2');
    assert.equal(ammo.fx.reserve, 1);
    assert.equal(ammo.instant.refill, true);
    assert.match(ammo.desc, /기본 재장전 탄창만큼/);
    assert.ok(cardById('sprint1').fx.move > 0);
    assert.ok(cardById('limit1').fx.maxSpeed > 0);
    assert.ok(cardById('hp1').fx.maxHp > 0);
  });

  test('능력치 계산과 상한', () => {
    const many = Array(60).fill('trigger4');
    const k = computePerks(many);
    assert.equal(k.fireRate, PERK_CAPS.fireRate);
    assert.ok(!cardAvailable(cardById('trigger4'), many, k), '상한이 찬 카드는 제안에서 빠진다');
    assert.equal(perkMaxHp(computePerks(['hp1', 'hp2'])), 140);
    assert.equal(perkMaxHp(computePerks(['glass'])), 75);
    assert.ok(cardAvailable(cardById('glass'), [], null));
    assert.ok(!cardAvailable(cardById('glass'), ['glass'], null), '한 장뿐인 카드');
  });

  test('제안: 3장(넓은 선택이면 4장), 서로 다르고 같은 묶음이 겹치지 않으며 재현된다', () => {
    const a = makeOffer({ seed: 5, playerId: 'p1', stage: 3, roll: 0, taken: [] });
    assert.equal(a.length, 3);
    assert.equal(new Set(a).size, 3);
    assert.equal(new Set(a.map((id) => cardById(id).family)).size, 3);
    assert.deepEqual(makeOffer({ seed: 5, playerId: 'p1', stage: 3, roll: 0, taken: [] }), a);
    const four = makeOffer({ seed: 5, playerId: 'p1', stage: 3, roll: 0, taken: ['wide'], count: 4 });
    assert.equal(four.length, 4);
    const re = makeOffer({ seed: 5, playerId: 'p1', stage: 3, roll: 1, taken: [], exclude: a });
    assert.ok(re.every((id) => !a.includes(id)), '다시 뽑으면 앞 제안의 카드는 빠진다');
  });

  test('보물 상자 제안(high)의 첫 장은 영웅 이상, 전설은 4스테이지부터', () => {
    for (let s = 0; s < 40; s++) {
      const o = makeOffer({ seed: s, playerId: 'x', stage: 5, roll: 0, taken: [], high: true });
      assert.ok(['epic', 'legend'].includes(cardById(o[0]).tier), o[0]);
      const early = makeOffer({ seed: s, playerId: 'x', stage: 2, roll: 0, taken: [], high: true });
      assert.equal(cardById(early[0]).tier, 'epic', `4스테이지 전 보물 상자의 첫 장 ${early[0]}`);
      assert.ok(early.every((id) => cardById(id).tier !== 'legend'));
      const plain = makeOffer({ seed: s, playerId: 'x', stage: 2, roll: 0, taken: [] });
      assert.ok(plain.every((id) => cardById(id).tier !== 'legend'));
    }
  });

  test('짧은 글자로 싣고 다시 푼다', () => {
    const ids = ['mag1', 'second', 'ammo2', 'mag1'];
    assert.deepEqual(decodeCards(encodeCards(ids)), ids);
    assert.deepEqual(decodeCards('zz!!'), []);
  });
});

describe('새 카드: 이미 있는 카드의 전송 번호는 그대로', () => {
  // 새 카드를 더하기 전의 순서(묶음은 I~IV 네 장씩, 그 뒤 특수 카드). 번호는 방 안의 모두가 카드를 주고받는 값이라 바뀌면 안 된다
  const OLD_FAMILIES = ('hp regen leech armor ration power head boss blade demo trigger hands mag ammo steady grip swap sprint limit leap ' +
    'pouch medic kit supply belt blast pierce scav weak wound frost thorn dodge exec last rest shield forge frenzy').split(' ');
  const OLD_SPECIALS = ('second glass wall chain luck wide medkit syringe drop hunter thrift perfect giant thirst runngun drum samurai iron ' +
    'tactical react dread coin adrenaline bunker fireNade iceNade decoyNade multiNade rearm sideGl sideRl').split(' ');
  const OLD = [...OLD_FAMILIES.flatMap((f) => [1, 2, 3, 4].map((n) => `${f}${n}`)), ...OLD_SPECIALS];
  const ADDED = ['reflex1', 'reflex2', 'reflex3', 'reflex4', 'wave1', 'wave2', 'wave3', 'wave4', 'anchor', 'c4', 'shieldKnife', 'airStrike', 'sideGravity'];

  test('예전 카드 187장은 번호가 같고, 새 카드 13장은 그 뒤에 붙는다', () => {
    assert.equal(OLD.length, 187);
    OLD.forEach((id, i) => assert.equal(cardById(id) && cardById(id).idx, i, id));
    assert.deepEqual(CARDS.slice(OLD.length).map((c) => c.id), ADDED);
    assert.equal(CARD_COUNT, OLD.length + ADDED.length);
    assert.equal(encodeCards(['hp1', 'sideRl']), '00' + (186).toString(36), '예전 카드의 짧은 글자도 그대로');
    assert.deepEqual(decodeCards(encodeCards([...ADDED, 'mag1'])), [...ADDED, 'mag1']);
    assert.ok(CARD_COUNT <= 36 * 36, '36진수 두 자리 안');
  });

  test('반사 신경·검기·부동자세·C4: 등급·능력치·상한·요약', () => {
    const tiers = (ids) => ids.map((id) => cardById(id).tier);
    assert.deepEqual(tiers(ADDED.slice(0, 4)), ['common', 'rare', 'epic', 'legend']);
    assert.deepEqual(tiers(ADDED.slice(4, 8)), ['rare', 'rare', 'epic', 'legend'], '검기는 희귀부터');
    assert.deepEqual(ADDED.slice(0, 4).map((id) => cardById(id).fx.iframe), [0.1, 0.15, 0.2, 0.25]);
    assert.deepEqual(ADDED.slice(4, 8).map((id) => cardById(id).fx.wave), [6, 8, 10, 13]);
    assert.match(cardById('reflex1').desc, /맞은 뒤 무적 시간 \+0\.1초/);
    assert.match(cardById('wave3').desc, /검기가 10 m/);
    const anchor = cardById('anchor'), c4 = cardById('c4');
    assert.deepEqual([anchor.tier, anchor.max, anchor.fx.noKnock, anchor.icon], ['epic', 1, 1, '⚓']);
    assert.deepEqual([c4.tier, c4.max, c4.fx.stickyNade, c4.nade, c4.icon], ['epic', 1, 1, true, '🧲']);
    assert.ok(!cardAvailable(anchor, ['anchor']) && !cardAvailable(c4, ['c4']), '한 장뿐');
    const base = computePerks([]);
    for (const k of ['iframe', 'noKnock', 'stickyNade', 'wave']) assert.equal(base[k], 0, k);
    const k = computePerks(['reflex4', 'reflex4', 'wave4', 'wave4', 'wave1']);
    assert.equal(k.iframe, PERK_CAPS.iframe);
    assert.equal(PERK_CAPS.iframe, 0.4);
    assert.equal(k.wave, PERK_CAPS.wave);
    assert.equal(PERK_CAPS.wave, 18);
    assert.equal(computePerks(['wave1', 'wave2']).wave, 14, '검기는 겹치면 더 멀리');
    assert.ok(!cardAvailable(cardById('wave1'), ['wave4', 'wave4'], null), '검기 거리 상한이 차면 제안에서 빠진다');
    const rows = perkSummary(computePerks(['reflex1', 'anchor', 'c4', 'wave1']));
    const row = (label) => (rows.find((r) => r.label === label) || {}).value;
    assert.deepEqual([row('맞은 뒤 무적'), row('밀려남'), row('C4'), row('검기')], ['+0.1초', '없음', '붙음', '6 m']);
    assert.equal(perkSummary(base).length, 0, '증강이 없으면 요약도 없다');
  });

  test('새 카드도 제안에 나온다', () => {
    const seen = new Set();
    for (let s = 0; s < 600; s++) for (const id of makeOffer({ seed: s, playerId: 'p', stage: 6, taken: [] })) seen.add(cardById(id).family);
    for (const f of ['reflex', 'wave', 'anchor', 'c4']) assert.ok(seen.has(f), f);
  });
});

describe('수류탄 증강: 최대 수류탄 +2 · C4', () => {
  test('수류탄 증강은 모두 최대 수류탄 +2와 가득 채움, 수류탄 주머니는 2·2·3·4, 상한 14', () => {
    const nade = CARDS.filter((c) => c.nade);
    assert.ok(nade.length >= 14, `수류탄 증강 ${nade.length}장`);
    for (const c of nade) {
      assert.equal(c.fx.nades, 2, c.id);
      assert.equal(c.instant && c.instant.nades, true, c.id);
      assert.match(c.desc, /최대 수류탄 \+2 \(가득 채움\)/, c.id);
    }
    for (const id of ['fireNade', 'iceNade', 'decoyNade', 'multiNade', 'react', 'demo1', 'blast4', 'c4']) assert.ok(cardById(id).nade, id);
    const pouch = ['pouch1', 'pouch2', 'pouch3', 'pouch4'].map(cardById);
    assert.deepEqual(pouch.map((c) => c.fx.nades), [2, 2, 3, 4]);
    assert.ok(pouch.every((c) => c.instant.nades));
    assert.equal(PERK_CAPS.nades, 14);
    assert.equal(computePerks(Array(10).fill('pouch4')).nades, 14);
    assert.ok(!cardAvailable(cardById('pouch1'), Array(10).fill('pouch4'), null), '상한이 차면 주머니는 빠진다');
    // 무기: 기본 1개에 증강만큼
    const a = createArsenal({ primary: 'ar_std' });
    a.setMods(modsFromPerks(computePerks(['fireNade'])));
    assert.equal(a.refillGrenades(), 3);
    a.setMods(modsFromPerks(computePerks(['fireNade', 'pouch1', 'c4'])));
    assert.equal(a.refillGrenades(), 7);
  });

  test('C4 폭발은 손으로 던진 수류탄과 같다(배율 10 · 빙결 같은 수류탄 증강이 붙는다)', () => {
    assert.equal(nadeDamage(50, {}, false, 'c4'), nadeDamage(50, {}, false));
    const { d, pos, P } = makeFlat();
    runUntil(d, () => alive(d).length >= 2, 8000);
    const [a, b] = alive(d);
    a.hp = a.maxHp = 10000;
    b.hp = b.maxHp = 10000;
    const p = P('p1');
    p.cards = ['iceNade', 'c4'];
    p.perks = computePerks(p.cards);
    const center = { x: pos.p1[0] + 5, y: 0, z: pos.p1[2] };
    d.claimExplosion({ attackerId: 'p1', center, kind: 'c4', victims: [{ id: 'z' + a.id, dmg: 50 }] });
    assert.equal(a.hp, 10000 - Math.round(50 * 10));   // 폭심 100 → 1000(QA 요청: 수류탄 기본 피해 1000)
    assert.ok(a.frozenUntil > d.internals.S.clock, 'C4에도 빙결이 붙는다');
    d.claimExplosion({ attackerId: 'p1', center, kind: 'gl', victims: [{ id: 'z' + b.id, dmg: 50 }] });
    assert.ok(!(b.frozenUntil > d.internals.S.clock), '유탄에는 수류탄 증강이 붙지 않는다');
  });
});

describe('보스 · 스테이지 규칙', () => {
  test('보스 10종, 번호가 겹치지 않고 스킬이 2개 이상', () => {
    assert.equal(BOSSES.length, 10);
    assert.equal(new Set(BOSSES.map((b) => b.code)).size, 10);
    for (const b of BOSSES) {
      assert.ok(b.skills.length >= 2, b.id);
      for (const s of b.skills) assert.ok(SKILL_KINDS[s.kind], `${b.id}:${s.kind}`);
    }
  });

  test('3스테이지마다 보스, 50이 넘으면 2마리, 100이 넘으면 3마리', () => {
    assert.equal(HORDE.bossEvery, 3);
    assert.equal(bossCount(1), 0);
    assert.equal(bossCount(2), 0);
    assert.equal(bossCount(3), 1);
    assert.equal(bossCount(4), 0);
    assert.equal(bossCount(5), 0);
    assert.equal(bossCount(6), 1);
    assert.equal(bossCount(48), 1);
    assert.equal(bossCount(49), 0);
    assert.equal(bossCount(50), 0, '50은 3의 배수가 아니다');
    assert.equal(bossCount(51), 2);
    assert.equal(bossCount(99), 2);
    assert.equal(bossCount(102), 3);
    assert.equal(bossCount(150), 3);
    const first = (n) => { for (let s = 1; s < 400; s++) if (bossCount(s) === n) return s; return -1; };
    assert.deepEqual([first(1), first(2), first(3)], [3, 51, 102]);
  });

  test('보스 고르기: 한 스테이지 안에서 겹치지 않고 바로 앞 보스를 피한다', () => {
    const rng = makeRng(3);
    const three = pickBosses(3, rng, []);
    assert.equal(new Set(three).size, 3);
    const next = pickBosses(1, rng, ['butcher']);
    assert.notEqual(next[0], 'butcher');
  });

  test('스테이지가 오를수록 좀비 수·체력이 늘고 종류가 열린다', () => {
    assert.ok(zombieCount(10) > zombieCount(1));
    assert.ok(hpMul(20) > hpMul(10));
    assert.ok(zombieMix(1).every((m) => m.type.id === 'walker'));
    assert.ok(zombieMix(12).length === 5, '원거리 스피터는 20스테이지부터');
    assert.ok(!zombieMix(19).some((m) => m.type.id === 'spitter'));
    assert.ok(zombieMix(20).some((m) => m.type.id === 'spitter'));
    assert.ok(zombieMix(20).length === 6);
  });

  test('경험치: 레벨마다 10·20·30…, 시간 안에 다 잡으면 남은 2초당 1, 강한 좀비일수록 많다', () => {
    assert.deepEqual([1, 2, 3, 4].map((l) => xpNeed(l)), [10, 20, 30, 40]);
    assert.equal(timeBonusXp(0), 0);
    assert.equal(timeBonusXp(3999), 1);
    assert.equal(timeBonusXp(26000), 13);
    for (const id of ZOMBIE_IDS) assert.ok(zombieXp(id) >= 1, id);
    assert.ok(zombieXp('brute') > zombieXp('walker'));
    assert.equal(zombieXp('nope'), 1);
    assert.equal(HORDE.bossXp, 20);
  });

  test('탄약: 재장전 탄창은 기존 맵의 3배(무제한 총은 탄창 2개 × 3)', () => {
    assert.deepEqual(hordeAmmo(WEAPONS.ar_std), { mag: 30, reserve: 180 });
    assert.deepEqual(hordeAmmo(WEAPONS.ar_line), { mag: 25, reserve: 150 });
    assert.equal(hordeAmmo(WEAPONS.ml_knife), null);
  });

  test('보상: 깬 스테이지·보스·처치, 판당 상한', () => {
    const r = zombieReward({ online: true, stage: 11, cleared: 10, bossKills: 2, kills: 230 });
    assert.equal(r.gained, 10 * 12 + 2 * 30 + 23 * 5);
    assert.equal(r.breakdown.reduce((s, x) => s + x.points, 0), r.gained);
    assert.equal(zombieReward({ online: false, stage: 400, cleared: 399, bossKills: 100, kills: 9999 }).gained, 1500);
  });
});

describe('무기 배율(카드)', () => {
  test('예비 탄 3배 · 탄창 · 연사 · 무제한 총 제한', () => {
    const a = createArsenal({ primary: 'ar_std' });
    a.setMods(modsFromPerks(computePerks(['mag4', 'trigger4'])));
    a.resetRound({});
    const am = a.getAmmo('ar_std');
    assert.equal(am.magSize, 45);
    assert.equal(am.reserve, 180);
    const b = createArsenal({ primary: 'ar_line' });
    b.setMods(modsFromPerks(computePerks([])));
    b.resetRound({});
    assert.equal(b.getAmmo('ar_line').reserve, 150, '무제한이던 프리미엄 총도 이 모드에서는 셀 수 있는 탄');
    const c = createArsenal({ primary: 'ar_std' });
    c.setMods(modsFromPerks(computePerks(['ammo2'])));
    c.resetRound({});
    assert.equal(c.getAmmo('ar_std').reserve, 360, '탄약 상자 II: 기본 재장전 탄창(180)만큼 더');
  });

  test('연사 배율은 사격 간격을 줄인다', () => {
    const shots = (mods) => {
      const a = createArsenal({ primary: 'ar_std', rng: () => 0.5 });
      if (mods) a.setMods(mods);
      a.resetRound({});
      let n = 0;
      for (let i = 0; i < 60; i++) for (const e of a.update(1 / 60, { fireDown: true }, { speed: 0, onGround: true })) if (e.type === 'fire') n++;
      return n;
    };
    const base = shots(null), fast = shots({ fire: 1.5 });
    assert.ok(fast >= Math.floor(base * 1.4), `${base} → ${fast}`);
  });

  test('배율이 없으면 표의 값 그대로', () => {
    const a = createArsenal({ primary: 'sm_vx3' });
    assert.equal(a.getAmmo('sm_vx3').magSize, 32);
    assert.equal(a.getAmmo('sm_vx3').reserve, 64);
  });
});

describe('방장 시뮬레이션', () => {
  test('혼자: 준비 → 1스테이지 → 팀 경험치가 차면 증강 고르기(시계가 멈춤) → 다시 뽑기 한 번 → 고르면 같은 스테이지를 잇는다', () => {
    const { d } = makeDirector({ rules: { pauseOnCards: true } });
    const ev0 = d.start();
    assert.ok(ev0.some((e) => e.type === 'spawn' && e.id === 'p1'));
    runUntil(d, () => d.phase === 'wave', 2000);
    assert.equal(d.stage, 1);
    const ev = runUntil(d, () => d.phase === 'cards', 90000, () => killAll(d));
    assert.equal(d.phase, 'cards');
    assert.ok(ev.some((e) => e.type === 'levelUp' && e.level === 2), '팀 레벨 2');
    const S = d.internals.S;
    const P = d.internals.players.get('p1');
    assert.equal(P.offer.cards.length, 3);
    assert.equal(P.offer.rerolls, 1);
    const clock = S.clock, stageLeft = S.stageEnd - S.clock;
    d.tick(1000);
    assert.equal(S.clock, clock, '고르는 동안 좀비·스테이지 시계가 멈춘다');
    assert.equal(d.snapshot().sl, Math.round(stageLeft));
    const before = P.offer.cards.slice();
    d.cardAction('p1', 'reroll');
    assert.notDeepEqual(P.offer.cards, before);
    assert.equal(P.offer.rerolls, 0);
    assert.equal(d.cardAction('p1', 'reroll')[0].type, 'reject', '다시 뽑기는 제안마다 한 번');
    const pick = P.offer.cards[1];
    const ev2 = d.cardAction('p1', 'pick', pick);
    assert.ok(ev2.some((e) => e.type === 'card' && e.card === pick && !e.auto));
    assert.ok(ev2.some((e) => e.type === 'phase' && e.phase === 'wave' && e.resumed));
    assert.equal(d.phase, 'wave');
    assert.equal(d.stage, 1, '증강을 골라도 스테이지는 그대로');
    assert.deepEqual(P.cards, [pick]);
    assert.ok(S.clock < P.invulnUntil, '고른 뒤 3초 무적');
  });

  test('혼자: 증강 고르기 시간이 지나면 제안 중 하나를 받고 웨이브를 잇는다', () => {
    const { d } = makeDirector({ rules: { pauseOnCards: true, cardMs: 2000 } });
    d.start();
    runUntil(d, () => d.phase === 'cards', 90000, () => killAll(d));
    const P = d.internals.players.get('p1');
    const offered = P.offer.cards.slice();
    const ev = runUntil(d, () => d.phase === 'wave', 3000);
    assert.equal(d.phase, 'wave');
    const got = ev.find((e) => e.type === 'card' && e.id === 'p1');
    assert.ok(got && got.auto, '시간이 다 돼 자동으로 받았다');
    assert.ok(offered.includes(got.card), got.card);
    assert.equal(P.cards[0], got.card);
  });

  test('멀티: 팀 레벨이 오르면 모두에게 제안(멈추지 않음) · 고르는 동안 무적 · 고른 뒤 3초 무적 · 시간이 다 되면 제안 중 하나', () => {
    const { d, pos, P } = makeFlat({ ids: ['p1', 'p2'], rules: { cardMs: 2000 } });
    const ev = d.internals.addXp(xpNeed(1));
    assert.ok(ev.some((e) => e.type === 'levelUp' && e.level === 2));
    assert.deepEqual(ev.filter((e) => e.type === 'offer').map((e) => e.id).sort(), ['p1', 'p2']);
    assert.equal(d.phase, 'wave', '멀티는 고르는 동안에도 멈추지 않는다');
    spitAt(d, pos.p1, 30);
    step(d);
    assert.equal(P('p1').hp, 100, '고르는 사람은 무적');
    const pick = P('p2').offer.cards[2];
    d.cardAction('p2', 'pick', pick);
    assert.deepEqual(P('p2').cards, [pick]);
    const hp2 = P('p2').hp;
    spitAt(d, pos.p2, 30);
    step(d);
    assert.equal(P('p2').hp, hp2, '고른 직후 무적');
    const left = P('p2').invulnUntil - d.internals.S.clock;
    assert.ok(left > 2800 && left <= HORDE.pickInvulnMs, `무적 ${left}ms`);
    const v = applyHordeSnapshot(JSON.parse(JSON.stringify(d.snapshot())));
    assert.ok(v.players.find((p) => p.id === 'p2').invuln);
    assert.ok(v.players.find((p) => p.id === 'p1').offerLeftMs > 0, '멀티 제안의 남은 시간');
    // p1: 2초가 지나면 제안 중 하나를 받는다
    const offered = P('p1').offer.cards.slice();
    const ev2 = runUntil(d, () => !P('p1').offer, 3000);
    const auto = ev2.find((e) => e.type === 'card' && e.id === 'p1');
    assert.ok(auto && auto.auto && offered.includes(auto.card));
    // 3초가 지나면 다시 맞는다
    runUntil(d, () => d.internals.S.clock > P('p2').invulnUntil, 4000);
    step(d, 4);
    spitAt(d, pos.p2, 30);
    step(d);
    assert.ok(P('p2').hp < hp2, '무적이 끝나면 맞는다');
  });

  test('40초 스테이지: 시간이 다 되면 남은 좀비를 둔 채 다음 스테이지, 다 잡으면 남은 2초당 경험치 1을 받고 바로 다음 스테이지', () => {
    assert.equal(HORDE.stageMs, 40000);
    const { d } = makeFlat({ rules: { stageMs: 3000 } });
    const ev = runUntil(d, (all) => all.some((e) => e.type === 'timeup'), 5000);
    const tu = ev.find((e) => e.type === 'timeup');
    assert.ok(tu && tu.stage === 1 && tu.left > 0, '남은 좀비 수를 알린다');
    assert.equal(d.stage, 2);
    assert.ok(alive(d).length > 0, '남은 좀비는 그대로');
    const { d: d2 } = makeDirector();
    d2.start();
    runUntil(d2, () => d2.phase === 'wave', 2000);
    const xp0 = d2.internals.S.xpTotal;
    const ev2 = runUntil(d2, (all) => all.some((e) => e.type === 'clear'), 60000, () => killAll(d2));
    const cl = ev2.find((e) => e.type === 'clear');
    assert.ok(cl, '다 잡았다');
    assert.equal(cl.stage, 1);
    assert.ok(cl.bonus > 0);
    assert.equal(cl.bonus, timeBonusXp(cl.leftMs));
    assert.ok(d2.internals.S.xpTotal >= xp0 + cl.bonus);
    assert.equal(d2.stage, 2);
    assert.equal(d2.phase, 'wave');
  });

  test('좀비가 다가와 때리고, 혼자 쓰러지면 끝난다', () => {
    const { d } = makeDirector({ startStage: 13 });
    d.start();
    const ev = runUntil(d, () => d.phase === 'over', 120000);
    assert.equal(d.phase, 'over');
    assert.ok(ev.some((e) => e.type === 'down' && e.id === 'p1'));
    const over = ev.find((e) => e.type === 'over');
    assert.equal(over.stage, 13);
    const v = applyHordeSnapshot(JSON.parse(JSON.stringify(d.snapshot())));
    assert.equal(v.phase, 'over');
    assert.equal(hordeSummary(v, 'p1').stage, 13);
  });

  test('보스 스테이지: 3에 1마리, 51에 2마리, 102에 3마리', () => {
    for (const [stage, n] of [[3, 1], [51, 2], [102, 3]]) {
      const { d } = makeDirector({ startStage: stage });
      d.start();
      const ev = runUntil(d, (all) => all.filter((e) => e.type === 'bossSpawn').length >= n, 20000);
      assert.equal(ev.filter((e) => e.type === 'bossSpawn').length, n, `${stage}스테이지`);
      const bosses = [...d.internals.zombies.values()].filter((Z) => Z.boss);
      assert.equal(new Set(bosses.map((Z) => Z.boss.id)).size, n, '서로 다른 보스');
    }
  });

  test('보스가 스킬을 쓴다', () => {
    const { d } = makeDirector({ startStage: 6 });
    d.start();
    const ev = runUntil(d, (all) => all.some((e) => e.type === 'skill'), 60000);
    assert.ok(ev.some((e) => e.type === 'skill'));
  });

  test('관통: 같은 발로 맞힌 두 번째 좀비는 관통 카드가 없으면 거절한다', () => {
    const { d } = makeDirector({ startStage: 4 });
    d.start();
    runUntil(d, () => [...d.internals.zombies.values()].filter((Z) => Z.state !== 'rise').length >= 2, 30000);
    const zs = [...d.internals.zombies.values()].filter((Z) => Z.state !== 'dead');
    const a = d.claimHit({ attackerId: 'p1', victimId: 'z' + zs[0].id, weaponId: 'ar_std', part: 'body', dist: 10, kind: 'shot', count: 1, shotId: 77 });
    const b = d.claimHit({ attackerId: 'p1', victimId: 'z' + zs[1].id, weaponId: 'ar_std', part: 'body', dist: 12, kind: 'shot', count: 1, shotId: 77 });
    assert.ok(!a.some((e) => e.type === 'reject'));
    assert.equal(b[0].reason, 'pierce');
  });

  test('좀비 전용 기관총(mg_m249)의 사격은 방장이 받아 몸 22 · 머리 90 · 25 m 밖 감쇠로 좀비에게 들어간다', () => {
    const k = computePerks([]);
    const hit = (part, dist) => zombieHitDamage({ weaponId: 'mg_m249', part, dist, kind: 'shot', count: 1 }, k, { boss: false, hpFrac: 1 }, {}).dmg;
    assert.equal(hit('body', 5), 22);
    assert.equal(hit('head', 5), 90);
    assert.equal(hit('legs', 5), 16);
    assert.equal(hit('hand', 5), 22, '손은 몸으로 친다(이 모드의 부위 규칙)');
    assert.equal(hit('body', 70), Math.round(22 * 0.7));
    assert.ok(hit('head', 5) < 100, '머리 한 방으로 1스테이지 워커(100)를 쓰러뜨리지 못한다');
    const { d } = makeDirector({ startStage: 1 });
    d.start();
    runUntil(d, () => [...d.internals.zombies.values()].some((Z) => Z.state !== 'rise' && Z.state !== 'dead'), 30000);
    const Z = [...d.internals.zombies.values()].find((q) => q.state !== 'dead' && q.state !== 'rise');
    const before = Z.hp;
    const ev = d.claimHit({ attackerId: 'p1', victimId: 'z' + Z.id, weaponId: 'mg_m249', part: 'body', dist: 10, kind: 'shot', count: 1, shotId: 1 });
    assert.ok(!ev.some((e) => e.type === 'reject'), '방장이 기관총 사격을 거절하지 않는다');
    assert.equal(before - Z.hp, 22);
    // 사거리: 220 m 밖은 거절
    const far = d.claimHit({ attackerId: 'p1', victimId: 'z' + Z.id, weaponId: 'mg_m249', part: 'body', dist: 400, kind: 'shot', count: 1, shotId: 2 });
    assert.equal(far[0].reason, 'out_of_range');
  });

  test('혼자 하기의 스폰 주무기: 고른 좀비 전용 기관총은 그대로 쓰고(쓰러졌다 일어날 때도), 없는 값은 기본 주무기다', () => {
    assert.equal(hordeSpawnPrimary('mg_m249'), 'mg_m249', '좀비 전용 기관총을 이 모드에서는 쓴다');
    assert.equal(hordeSpawnPrimary('sr_heavy'), 'sr_heavy');
    assert.equal(hordeSpawnPrimary('ar_line'), 'ar_line', '계정이 안 가진 총도 이 모드에서는 고른다');
    for (const bad of [null, undefined, '', 'nope', 42, {}]) assert.equal(hordeSpawnPrimary(bad), 'ar_std', String(bad));
  });

  test('스냅샷 → 뷰 왕복, 방장 이전으로 같은 스테이지를 잇는다', () => {
    const { d, me } = makeDirector({ startStage: 4 });
    d.start();
    runUntil(d, () => d.internals.zombies.size >= 3, 30000);
    const snap = JSON.parse(JSON.stringify(d.snapshot()));
    assert.ok(JSON.stringify(snap).length < 8000, '스냅샷은 8 KB 안');
    const v = applyHordeSnapshot(snap);
    assert.equal(v.stage, 4);
    assert.equal(v.phase, 'wave');
    assert.ok(v.zombies.length >= 3);
    const r = restoreHorde(snap, { players: [{ id: 'p1', name: '하늘' }], world: col.world, nav, spawns: col.spawns, getPositions: () => ({ p1: me.pos }) });
    assert.equal(r.stage, 4);
    assert.equal(r.phase, 'wave');
    const ids = new Set(v.zombies.filter((z) => !z.dead).map((z) => z.id));
    for (const Z of r.internals.zombies.values()) assert.ok(ids.has(Z.id), '좀비 번호를 그대로 잇는다');
    r.tick(500);
  });

  test('여럿: 늦게 온 사람은 다음 스테이지에 나오고, 4명을 넘으면 받지 않는다', () => {
    const pos = { p1: [-28, 0, 0], p2: [-28, 0, 4] };
    const d = createHorde({ players: [{ id: 'p1', name: 'a' }, { id: 'p2', name: 'b' }], world: col.world, nav, spawns: col.spawns, seed: 2, getPositions: () => pos, rules: { prepMs: 200, cardMs: 1000 } });
    d.start();
    runUntil(d, () => d.phase === 'wave', 1000);
    const j = d.addPlayer({ id: 'p3', name: 'c' });
    assert.equal(j[0].type, 'join');
    assert.equal(d.internals.players.get('p3').alive, false);
    d.addPlayer({ id: 'p4', name: 'd' });
    assert.equal(d.addPlayer({ id: 'p5', name: 'e' })[0].reason, 'full');
    // 다 잡으면 바로 다음 스테이지(멀티는 증강을 고르는 동안에도 멈추지 않는다)
    const ev = runUntil(d, () => d.stage >= 2, 90000, () => killAll(d));
    assert.ok(ev.some((e) => e.type === 'clear' && e.stage === 1));
    assert.ok(!ev.some((e) => e.type === 'phase' && e.phase === 'cards'), '멀티는 증강 고르기로 멈추지 않는다');
    assert.ok(ev.some((e) => e.type === 'spawn' && e.id === 'p3'), '늦게 온 사람이 나온다');
    assert.equal(d.internals.players.get('p3').alive, true);
    assert.equal(zombieIdOf('z12'), 12);
    assert.equal(zombieIdOf('p1'), 0);
  });

  test('규칙 값: 최대 4인 · 탄약 3배', () => {
    assert.equal(HORDE.maxPlayers, 4);
    assert.equal(HORDE.reserveMul, 3);
  });
});

describe('좀비 문 · 바닥 보급품', () => {
  test('좀비 문을 주면 좀비는 그 문 둘레에서만 나온다', () => {
    const gates = col.spawns.charterer;
    const { d } = makeDirector({ gates, startStage: 4 });
    d.start();
    // 처음 보인 순간(일어나는 동작 중이라 아직 걷지 않는다)의 자리를 잰다
    const first = new Map();
    runUntil(d, () => first.size >= 10, 30000, () => {
      for (const Z of d.internals.zombies.values()) if (!first.has(Z.id)) first.set(Z.id, Z.body.pos.slice());
    });
    assert.ok(first.size >= 10, `좀비 ${first.size}`);
    for (const [id, p] of first) {
      const dmin = Math.min(...gates.map((g) => Math.hypot(g.x - p[0], g.z - p[2])));
      assert.ok(dmin < 1.7, `좀비 ${id}가 문에서 ${dmin.toFixed(2)} m에서 나왔다`);
    }
    assert.equal(d.internals.gates.length, gates.length);
  });

  test('보급품 굴림: 구급 상자 5% → 탄창 10% 순서, 증강으로 오른 확률, 종류는 탄창·구급 상자·보물 상자', () => {
    assert.equal(HORDE.medChance, 0.05);
    assert.equal(HORDE.magChance, 0.1);
    assert.equal(rollDrop(() => 0), 'med', '앞에서부터 처음 맞은 하나');
    assert.equal(rollDrop(() => 0.049), 'med');
    assert.equal(rollDrop(() => 0.05), 'mag');
    assert.equal(rollDrop(() => 0.149), 'mag');
    assert.equal(rollDrop(() => 0.16), null);
    assert.equal(rollDrop(() => 0.99), null, '굴림이 크면 아무것도 없다');
    assert.equal(rollDrop(() => 0.3, 0.1, 0.25), 'mag', '증강으로 오른 확률');
    assert.equal(rollDrop(() => 0.08, 0.1, 0.25), 'med');
    assert.deepEqual(Object.keys(LOOT_TYPES).sort(), ['chest', 'mag', 'med']);
    for (const L of Object.values(LOOT_TYPES)) assert.equal(lootByCode(L.code), L);
    assert.equal(lootByCode(2), null, '예전 탄약 상자 자리는 비어 있다');
    assert.equal(lootByCode(3), null, '예전 수류탄 자리는 비어 있다');
    assert.equal(lootByCode(99), null);
  });

  test('보스를 쓰러뜨리면 보물 상자 하나가 떨어지고, 스냅샷에 실리고, 가까이 간 사람만 줍는다(그 증강의 첫 장은 영웅 이상)', () => {
    const { d, me } = makeDirector({ startStage: 3, rules: { cardMs: 600000 } });
    d.start();
    runUntil(d, () => [...d.internals.zombies.values()].some((Z) => Z.boss && Z.state !== 'rise'), 30000);
    const boss = [...d.internals.zombies.values()].find((Z) => Z.boss);
    let shot = 500;
    while (boss.state !== 'dead') d.claimHit({ attackerId: 'p1', victimId: 'z' + boss.id, weaponId: 'sr_heavy', part: 'head', dist: 10, kind: 'shot', count: 1, shotId: ++shot });
    const drops = [...d.internals.loot.values()].filter((L) => Math.hypot(L.x - boss.body.pos[0], L.z - boss.body.pos[2]) < 2);
    assert.deepEqual(drops.map((L) => L.kind), ['chest']);
    const chest = drops[0];
    // 스냅샷 왕복: 보물 상자는 일반 보급품보다 오래 남는다
    const v = applyHordeSnapshot(JSON.parse(JSON.stringify(d.snapshot())));
    const vc = v.loot.find((x) => x.id === chest.id);
    assert.ok(vc && vc.kind === 'chest' && Math.abs(vc.pos[0] - chest.x) < 0.02);
    assert.ok(vc.leftMs > HORDE.lootMs && vc.leftMs <= HORDE.chestMs, `${vc.leftMs}`);
    // 멀리서는 못 줍는다
    me.pos = [chest.x + 8, chest.y, chest.z];
    assert.equal(d.claimLoot('p1', chest.id)[0].reason, 'far');
    // 가까이 가면 줍고 증강 하나를 더 고른다
    const P = d.internals.players.get('p1');
    const picks = P.picks;
    me.pos = [chest.x + 1, chest.y, chest.z];
    const ev = d.claimLoot('p1', chest.id);
    assert.deepEqual([ev[0].type, ev[0].kind, ev[0].by], ['loot', 'chest', 'p1']);
    assert.equal(P.picks, picks + 1);
    assert.equal(P.chestPicks, 1);
    assert.equal(d.claimLoot('p1', chest.id)[0].reason, 'gone', '두 번 주울 수 없다');
    // 보스 경험치로 받은 레벨업 증강을 먼저 고르면 다음 제안이 보물 상자 몫(첫 장은 영웅 이상)
    let guard = 0;
    while (P.offer && !P.offer.chest && guard++ < 5) d.cardAction('p1', 'pick', P.offer.cards[0]);
    assert.ok(P.offer && P.offer.chest, '보물 상자 제안');
    assert.ok(['epic', 'legend'].includes(cardById(P.offer.cards[0]).tier));
    d.cardAction('p1', 'pick', P.offer.cards[0]);
    assert.equal(P.chestPicks, 0);
  });

  test('구급 상자: 가까이 가면 체력을 채우고, 멀면 거절, 두 번 줍지 못하고, 없는 사람은 못 줍는다', () => {
    const { d, me } = makeDirector({ rules: { medChance: 1 } });
    d.start();
    runUntil(d, () => d.internals.loot.size > 0, 30000, () => killAll(d));
    const med = [...d.internals.loot.values()].find((L) => L.kind === 'med');
    assert.ok(med, '구급 상자가 떨어졌다');
    assert.equal(d.claimLoot('nobody', med.id)[0].reason, 'dead', '방에 없는 사람');
    me.pos = [med.x + 8, med.y, med.z];
    assert.equal(d.claimLoot('p1', med.id)[0].reason, 'far');
    const P = d.internals.players.get('p1');
    P.hp = 40;
    me.pos = [med.x + 1, med.y, med.z];
    const ev = d.claimLoot('p1', med.id);
    assert.deepEqual([ev[0].type, ev[0].kind, ev[0].by], ['loot', 'med', 'p1']);
    assert.equal(ev[0].heal, HORDE.medHeal);
    assert.equal(P.hp, 40 + HORDE.medHeal);
    assert.equal(d.claimLoot('p1', med.id)[0].reason, 'gone', '두 번 주울 수 없다');
  });

  test('보급품은 정해진 시간이 지나면 사라지고, 상한을 넘으면 오래된 것부터 치운다(보물 상자는 남는다)', () => {
    const { d } = makeDirector({ startStage: 3, rules: { lootMs: 1500, maxLoot: 4, magChance: 1 } });
    d.start();
    runUntil(d, () => [...d.internals.zombies.values()].some((Z) => Z.boss && Z.state !== 'rise'), 30000);
    const boss = [...d.internals.zombies.values()].find((Z) => Z.boss);
    let shot = 900;
    while (boss.state !== 'dead') d.claimHit({ attackerId: 'p1', victimId: 'z' + boss.id, weaponId: 'sr_heavy', part: 'head', dist: 10, kind: 'shot', count: 1, shotId: ++shot });
    let kills = 0;
    runUntil(d, () => kills >= 6, 20000, () => { const ev = killAll(d); kills = d.internals.players.get('p1').kills - 1; return ev; });
    const loot = d.internals.loot;
    assert.ok(loot.size <= 4, `상한 4, 지금 ${loot.size}`);
    assert.ok(loot.size >= 3);
    assert.ok([...loot.values()].some((L) => L.kind === 'chest'), '보물 상자는 치우지 않는다');
    runUntil(d, () => [...loot.values()].every((L) => L.kind === 'chest'), 4000);
    assert.deepEqual([...loot.values()].map((L) => L.kind), ['chest'], '1.5초 뒤 일반 보급품은 모두 사라지고 보물 상자만 남는다');
  });

  test('방장 이전: 바닥 보급품의 번호와 자리를 잇는다', () => {
    const { d, me } = makeDirector({ startStage: 3 });
    d.start();
    runUntil(d, () => [...d.internals.zombies.values()].some((Z) => Z.boss && Z.state !== 'rise'), 30000);
    const boss = [...d.internals.zombies.values()].find((Z) => Z.boss);
    let shot = 1300;
    while (boss.state !== 'dead') d.claimHit({ attackerId: 'p1', victimId: 'z' + boss.id, weaponId: 'sr_heavy', part: 'head', dist: 10, kind: 'shot', count: 1, shotId: ++shot });
    const snap = JSON.parse(JSON.stringify(d.snapshot()));
    const r = restoreHorde(snap, { world: col.world, nav, spawns: col.spawns, getPositions: () => ({ p1: me.pos }), players: [{ id: 'p1', name: '하늘' }] });
    const before = [...d.internals.loot.values()].map((L) => `${L.id}:${L.kind}`).sort();
    const after = [...r.internals.loot.values()].map((L) => `${L.id}:${L.kind}`).sort();
    assert.deepEqual(after, before);
    const L = [...r.internals.loot.values()][0];
    me.pos = [L.x, L.y, L.z];
    assert.equal(r.claimLoot('p1', L.id)[0].type, 'loot');
  });
});

describe('증강을 고르는 사람(멀티): 좀비가 노리지 않는다', () => {
  test('고르는 사람은 표적·흐름장 출발점에서 빠지고 고르지 않는 사람은 그대로 노린다. 아무도 노릴 수 없으면 좀비는 선다', () => {
    const flows = [];
    const fakeNav = { flowField: (src) => { flows.push(src.map((p) => [p.x, p.z])); return true; }, flowStep: () => null, randomPoint: () => null, nearestWalkable: () => null };
    const { d, pos, P } = makeFlat({ ids: ['p1', 'p2'], nav: fakeNav });
    pos.p1 = [0, 0, 0];
    pos.p2 = [30, 0, 0];
    runUntil(d, () => alive(d).length >= 3, 10000);
    const three = alive(d).slice(0, 3);
    // 때리지는 않게(휘두르는 동안은 서 있으므로) 하고 p1 바로 옆에 둔다
    three.forEach((Z, i) => { Z.state = 'move'; Z.attackReady = Infinity; Z.body.pos[0] = 1.2; Z.body.pos[1] = 0; Z.body.pos[2] = i - 1; Z.targetAt = 0; });
    step(d, 2);
    assert.deepEqual(three.map((Z) => Z.target), ['p1', 'p1', 'p1'], '가까운 p1을 노린다');
    // 레벨업: 둘 다 제안을 받고 p2만 바로 고른다 → p1만 고르는 중(바로 옆에 있어도 노리지 않는다)
    d.internals.addXp(xpNeed(1));
    d.cardAction('p2', 'pick', P('p2').offer.cards[0]);
    assert.ok(P('p1').offer && !P('p2').offer);
    flows.length = 0;
    step(d);
    assert.deepEqual(three.map((Z) => Z.target), ['p2', 'p2', 'p2'], '노리던 p1이 고르기 시작하면 바로 p2로 바꾼다');
    assert.ok(flows.length >= 1, '고르기가 바뀌면 흐름장을 바로 다시 만든다');
    assert.deepEqual(flows[flows.length - 1], [[30, 0]], '흐름장 출발점은 고르지 않는 p2뿐');
    step(d, 10);
    assert.ok(three.every((Z) => Z.target === 'p2' && Z.body.pos[0] > 1.5), '좀비가 p2 쪽으로 간다');
    // p1이 다 고르면 다시 노린다
    d.cardAction('p1', 'pick', P('p1').offer.cards[0]);
    flows.length = 0;
    step(d, 20);
    assert.deepEqual(flows[0].map((p) => p[0]).sort((a, b) => a - b), [0, 30], '다 고른 p1이 흐름장 출발점으로 돌아온다');
    assert.deepEqual(three.map((Z) => Z.target), ['p1', 'p1', 'p1'], '다 고른 p1을 다시 노린다');
    // 둘 다 고르는 중이면 아무도 노리지 않고 제자리에 선다
    d.internals.addXp(xpNeed(2));
    assert.ok(P('p1').offer && P('p2').offer);
    step(d);
    const at = three.map((Z) => Z.body.pos.slice());
    step(d, 15);
    assert.deepEqual(three.map((Z) => Z.target), [null, null, null]);
    assert.deepEqual(three.map((Z) => Z.body.pos), at, '노릴 사람이 없으면 선다');
  });

  test('무적인 사람(고르는 중)에게는 보스의 비명·연쇄 번개가 닿지 않는다', () => {
    for (const [bossId, skill] of [['banshee', 'scream'], ['volt', 'chain']]) {
      const { d, pos, P } = makeFlat({ ids: ['p1', 'p2'] });
      pos.p1 = [0, 0, 0];
      pos.p2 = [3, 0, 0];
      d.internals.addXp(xpNeed(1));
      d.cardAction('p2', 'pick', P('p2').offer.cards[0]);
      runUntil(d, () => d.internals.S.clock > P('p2').invulnUntil + 100, 4000);   // p2의 고른 뒤 무적이 끝날 때까지
      assert.ok(P('p1').offer && !P('p2').offer);
      const hp1 = P('p1').hp, hp2 = P('p2').hp;
      const Z = bossAt(d, bossId, [0, 0, 6], skill);
      const si = Z.boss.skills.findIndex((s) => s.kind === skill);
      // 스킬을 쓰기 시작하면 다시 쓸 시각이 정해지고, 다 쓰면 Z.skill이 빈다
      const ev = runUntil(d, () => !Z.skill && Z.skillReady[si] > 0 && Number.isFinite(Z.skillReady[si]), 3000);
      assert.ok(!Z.skill && Number.isFinite(Z.skillReady[si]), `${bossId}: ${skill}을 썼다`);
      if (skill === 'scream') {
        const slows = ev.filter((e) => e.type === 'slow').map((e) => e.id);
        assert.deepEqual(slows, ['p2'], '비명은 고르는 사람을 느리게 하지 않는다');
      } else {
        const ch = ev.find((e) => e.type === 'chain');
        assert.ok(ch, '연쇄 번개');
        assert.equal(ch.pts.length, 2, '번개는 p2에게만 튀었다');
        assert.equal(P('p1').hp, hp1);
        assert.ok(P('p2').hp < hp2);
      }
    }
  });
});

describe('맞은 뒤 무적', () => {
  test('한 번 맞으면 0.1초 동안 다른 피해를 받지 않는다(한꺼번에 맞아도 한 번)', () => {
    assert.equal(HORDE.hitInvulnMs, 100);
    const { d, pos, P } = makeFlat();
    const p = P('p1');
    spitAt(d, pos.p1, 10);
    spitAt(d, pos.p1, 10);
    step(d);
    assert.equal(p.hp, 90, '같은 순간 두 발은 한 번만');
    const t0 = d.internals.S.clock;
    assert.ok(near(p.hitUntil, t0 + 100));
    step(d);
    spitAt(d, pos.p1, 10);
    step(d);                       // 약 67 ms 뒤
    assert.equal(p.hp, 90, '0.1초 안의 두 번째 피해는 들어가지 않는다');
    step(d);
    spitAt(d, pos.p1, 10);
    step(d);                       // 약 133 ms 뒤
    assert.equal(p.hp, 80, '0.1초가 지나면 다시 맞는다');
  });

  test('반사 신경 증강만큼 늘고, 피한 공격은 무적을 만들지 않으며, 보호막이 막아도 무적은 시작된다', () => {
    const { d, pos, P } = makeFlat();
    const p = P('p1');
    p.cards = ['reflex4'];
    p.perks = computePerks(p.cards);
    spitAt(d, pos.p1, 10);
    step(d);
    const t0 = d.internals.S.clock;
    assert.equal(p.hp, 90);
    assert.ok(near(p.hitUntil, t0 + 100 + 250), '기본 0.1초 + 0.25초');
    step(d, 5);
    spitAt(d, pos.p1, 10);
    step(d);                       // 약 200 ms 뒤: 증강이 없으면 맞았을 때
    assert.equal(p.hp, 90, '반사 신경으로 늘어난 무적');
    step(d, 5);
    spitAt(d, pos.p1, 10);
    step(d);                       // 약 400 ms 뒤
    assert.equal(p.hp, 80);
    // 피하면(회피) 무적이 생기지 않는다
    const { d: d2, pos: pos2, P: P2 } = makeFlat();
    const q = P2('p1');
    q.perks.dodge = 1;
    spitAt(d2, pos2.p1, 10);
    step(d2);
    assert.equal(q.hp, 100);
    assert.equal(q.hitUntil, 0, '피한 공격은 무적을 만들지 않는다');
    q.perks.dodge = 0;
    spitAt(d2, pos2.p1, 10);
    step(d2);
    assert.equal(q.hp, 90, '피한 바로 다음 공격은 맞는다');
    // 보호막이 막아도 무적은 시작된다
    const { d: d3, pos: pos3, P: P3 } = makeFlat();
    const s = P3('p1');
    s.shield = 50;
    spitAt(d3, pos3.p1, 10);
    step(d3);
    assert.deepEqual([s.hp, s.shield], [100, 40]);
    assert.ok(s.hitUntil > d3.internals.S.clock);
    spitAt(d3, pos3.p1, 10);
    step(d3);
    assert.equal(s.shield, 40, '보호막도 무적 동안은 깎이지 않는다');
  });
});

describe('밀려남', () => {
  test('좀비에게 맞으면 좀비 반대쪽으로 밀려나고, 스냅샷 줄에 0.4초 동안 실린다', () => {
    const { d, pos, P } = makeFlat();
    runUntil(d, () => alive(d).length >= 1, 5000);
    const Z = alive(d)[0];
    swing(d, Z, [pos.p1[0] + 1, 0, pos.p1[2]]);
    step(d);
    const p = P('p1');
    assert.ok(p.hp < 100, '맞았다');
    assert.equal(p.knockSeq, 1);
    assert.ok(near(Z.scale, 1));
    assert.ok(near(p.knockV[0], -HORDE.knockSpeed) && near(p.knockV[1], HORDE.knockUp) && near(p.knockV[2], 0), `${p.knockV}`);
    const v = applyHordeSnapshot(JSON.parse(JSON.stringify(d.snapshot())));
    const me = v.players.find((x) => x.id === 'p1');
    assert.equal(me.knock.seq, 1);
    assert.deepEqual(me.knock.v, [-4.2, 2, 0]);
    assert.ok(me.knock.ago >= 0 && me.knock.ago < HORDE.knockKeepMs);
    step(d, Math.ceil(HORDE.knockKeepMs / STEP) + 1);
    assert.equal(applyHordeSnapshot(d.snapshot()).players[0].knock, null, '0.4초가 지나면 싣지 않는다');
    // 다음에 맞으면 번호가 오른다(화면은 번호가 바뀔 때 한 번만 민다)
    swing(d, Z, [pos.p1[0], 0, pos.p1[2] - 1]);
    step(d);
    assert.equal(p.knockSeq, 2);
    assert.ok(near(p.knockV[2], HORDE.knockSpeed) && near(p.knockV[0], 0), '이번에는 +z 쪽으로');
  });

  test('침(투사체)은 날아온 쪽 반대로 조금(0.6배), 폭발(화약통·폭발 좀비)은 터진 자리 반대로 크게(1.5배) 민다', () => {
    const { d, pos, P } = makeFlat();
    spitAt(d, pos.p1, 5, [-6, 0, 0]);   // +x 쪽에서 날아온다
    step(d);
    const p = P('p1');
    assert.equal(p.hp, 95);
    assert.ok(near(p.knockV[0], -HORDE.knockSpeed * 0.6) && near(p.knockV[1], HORDE.knockUp * 0.6) && near(p.knockV[2], 0), `${p.knockV}`);
    // 화약통: 사람 0.5 m 옆(+x)에서 터진다
    const { d: d2, pos: pos2, P: P2 } = makeFlat();
    d2.internals.projectiles.push({
      id: ++spitSeq, kind: 3, pos: [pos2.p1[0] + 0.5, 1, pos2.p1[2]], vel: [0, 0, 0], arc: false, dmg: 0,
      blast: { r: 3.6, dmg: 20 }, pool: null, slow: null, born: d2.internals.S.clock, life: 4000
    });
    step(d2);
    const q = P2('p1');
    assert.ok(q.hp < 100, '폭발에 맞았다');
    assert.ok(near(q.knockV[0], -HORDE.knockSpeed * 1.5) && near(q.knockV[1], HORDE.knockUp) && near(q.knockV[2], 0), `${q.knockV}`);
  });

  test('부동자세 증강이 있으면 맞아도 밀려나지 않는다(피해는 그대로)', () => {
    const { d, pos, P } = makeFlat();
    runUntil(d, () => alive(d).length >= 1, 5000);
    const p = P('p1');
    p.cards = ['anchor'];
    p.perks = computePerks(p.cards);
    assert.equal(p.perks.noKnock, 1);
    swing(d, alive(d)[0], [pos.p1[0] + 1, 0, pos.p1[2]]);
    step(d);
    assert.ok(p.hp < 100, '피해는 받는다');
    assert.equal(p.knockSeq, 0);
    assert.equal(applyHordeSnapshot(d.snapshot()).players[0].knock, null);
  });

  test('보스의 밀치기(내려찍기)는 부동자세 증강이 있거나 무적이면 없다', () => {
    const run = (setup) => {
      const { d, pos, P } = makeFlat();
      const p = P('p1');
      setup(p, d);
      bossAt(d, 'butcher', [pos.p1[0] + 3, 0, pos.p1[2]], 'slam');
      const hp = p.hp;
      const ev = runUntil(d, () => d.internals.fxList.some((f) => f.kind === 'slam'), 3000);
      assert.ok(d.internals.fxList.some((f) => f.kind === 'slam'), '내려찍었다');
      return { knock: ev.find((e) => e.type === 'knock' && e.id === 'p1'), hurt: p.hp < hp };
    };
    const plain = run(() => {});
    assert.ok(plain.knock && plain.hurt, '보통은 맞고 밀려난다');
    assert.ok(plain.knock.v[0] < 0, '보스 반대쪽으로');
    const anchored = run((p) => { p.cards = ['anchor']; p.perks = computePerks(p.cards); });
    assert.ok(!anchored.knock && anchored.hurt, '부동자세: 맞지만 밀리지 않는다');
    const shielded = run((p, d) => { p.invulnUntil = d.internals.S.clock + 60000; });
    assert.ok(!shielded.knock && !shielded.hurt, '무적: 맞지도 밀리지도 않는다');
  });
});

describe('동료 살리기(멀티)', () => {
  test('쓰러진 자리에서 동료가 3초 동안 F를 누르면 체력 10 · 2초 무적으로 그 자리에서 일어난다(살린 사람 쪽을 본다)', () => {
    const { d, pos, P } = makeFlat({ ids: ['p1', 'p2'] });
    const ev0 = knockDown(d, pos, 'p2');
    assert.ok(ev0.some((e) => e.type === 'down' && e.id === 'p2'));
    assert.deepEqual(P('p2').downPos, [4, 0, 0]);
    // 쓰러진 뒤 다른 자리가 와도(지연된 위치) 쓰러진 자리는 그대로. 세션은 쓰러진 사람의 위치를 보내지 않는다
    pos.p2 = [20, 0, 5];
    step(d);
    assert.deepEqual(P('p2').downPos, [4, 0, 0]);
    delete pos.p2;
    let v = applyHordeSnapshot(JSON.parse(JSON.stringify(d.snapshot())));
    assert.deepEqual(v.players.find((x) => x.id === 'p2').down, { pos: [4, 0, 0], progress: 0, by: null });
    assert.equal(v.players.find((x) => x.id === 'p1').down, null, '산 사람은 쓰러진 자리가 없다');
    // 몸 옆에서 누르기 시작(시작할 때는 이벤트가 없다)
    pos.p1 = [5, 0, 0];
    assert.deepEqual(d.reviveAction('p1', 'p2', true), []);
    assert.equal(d.internals.revives.get('p2').by, 'p1');
    let half = null;
    const ev = holdRevive(d, 'p1', 'p2', 2900, (t) => { if (!half && t >= 1500) half = applyHordeSnapshot(JSON.parse(JSON.stringify(d.snapshot()))); });
    assert.ok(!ev.some((e) => e.type === 'revive'), '3초가 되기 전에는 일어나지 않는다');
    assert.equal(P('p2').alive, false);
    const hd = half.players.find((x) => x.id === 'p2').down;
    assert.equal(hd.by, 'p1');
    assert.ok(Math.abs(hd.progress - 0.5) < 0.03, `진행 ${hd.progress}`);
    const ev2 = holdRevive(d, 'p1', 'p2', 200);
    const sp = ev2.find((e) => e.type === 'spawn' && e.id === 'p2');
    assert.ok(sp, '일어남');
    assert.deepEqual([sp.revive, sp.by, sp.hp, sp.maxHp], [true, 'p1', HORDE.reviveHp, 100]);
    assert.deepEqual([sp.spawn.x, sp.spawn.y, sp.spawn.z], [4, 0, 0]);
    assert.ok(Math.abs(sp.spawn.rotY - Math.atan2(-(5 - 4), -(0 - 0))) < 0.002, `살린 사람 쪽을 본다 ${sp.spawn.rotY}`);
    assert.ok(ev2.some((e) => e.type === 'revive' && e.id === 'p2' && e.by === 'p1'));
    const p2 = P('p2');
    assert.deepEqual([p2.alive, p2.hp, p2.downPos], [true, 10, null]);
    assert.deepEqual(p2.pos, [4, 0, 0]);
    const inv = p2.invulnUntil - d.internals.S.clock;
    assert.ok(inv > 1800 && inv <= HORDE.reviveInvulnMs, `무적 ${inv}ms`);
    assert.equal(d.internals.revives.size, 0);
    v = applyHordeSnapshot(JSON.parse(JSON.stringify(d.snapshot())));
    const vp2 = v.players.find((x) => x.id === 'p2');
    assert.deepEqual([vp2.alive, vp2.down, vp2.invuln], [true, null, true]);
    // 2초 무적이 끝나면 다시 맞는다
    spitAt(d, p2.pos, 5);
    step(d);
    assert.equal(p2.hp, 10, '살아난 직후 무적');
    runUntil(d, () => d.internals.S.clock > p2.invulnUntil, 2500);
    spitAt(d, p2.pos, 5);
    step(d);
    assert.equal(p2.hp, 5);
  });

  test('살리기가 끊기는 경우: 멀어짐 · 손을 뗌 · 신호가 0.9초 넘게 끊김 · 살리는 사람이 증강을 고름·쓰러짐·나감', () => {
    const { d, pos, P } = makeFlat({ ids: ['p1', 'p2', 'p3'] });
    knockDown(d, pos, 'p2');
    delete pos.p2;
    pos.p1 = [5, 0, 0];
    const R = d.internals.revives;
    // 멀어지면 끊긴다
    d.reviveAction('p1', 'p2', true);
    step(d, 3);
    assert.ok(R.get('p2').ms > 0);
    pos.p1 = [9, 0, 0];
    step(d);
    assert.equal(R.size, 0, '멀어지면 끊긴다');
    assert.equal(d.reviveAction('p1', 'p2', true)[0].reason, 'far');
    // 손을 떼면 끊긴다
    pos.p1 = [5, 0, 0];
    d.reviveAction('p1', 'p2', true);
    assert.deepEqual(d.reviveAction('p1', 'p2', false), []);
    assert.equal(R.size, 0, '손을 떼면 끊긴다');
    // 신호가 0.9초 넘게 안 오면 끊긴다
    d.reviveAction('p1', 'p2', true);
    step(d, 25);
    assert.equal(R.size, 1, '0.83초는 버틴다');
    step(d, 4);
    assert.equal(R.size, 0, '0.97초 동안 신호가 없으면 끊긴다');
    // 살리는 사람이 증강을 고르기 시작하면 끊기고, 고르는 동안은 시작할 수 없다
    d.reviveAction('p1', 'p2', true);
    d.internals.addXp(xpNeed(d.internals.S.level));
    step(d);
    assert.equal(R.size, 0, '고르기 시작하면 끊긴다');
    assert.equal(d.reviveAction('p1', 'p2', true)[0].reason, 'picking');
    d.cardAction('p1', 'pick', P('p1').offer.cards[0]);
    if (P('p3').offer) d.cardAction('p3', 'pick', P('p3').offer.cards[0]);
    // 살리는 사람이 쓰러지면 끊긴다(고른 뒤 무적이 끝난 다음)
    runUntil(d, () => d.internals.S.clock > P('p1').invulnUntil + 50, 4000);
    d.reviveAction('p1', 'p2', true);
    assert.equal(R.size, 1);
    knockDown(d, pos, 'p1');
    assert.equal(P('p1').alive, false);
    assert.equal(R.size, 0, '살리는 사람이 쓰러지면 끊긴다');
    // 나간 사람: 살리던 것도 살려지던 것도 끝
    pos.p3 = [6, 0, 0];
    d.reviveAction('p3', 'p2', true);
    assert.equal(R.get('p2').by, 'p3');
    d.removePlayer('p2');
    assert.equal(R.size, 0, '쓰러진 사람이 나가면 끝');
    assert.equal(P('p2').downPos, null);
    assert.equal(d.reviveAction('p3', 'p2', true)[0].reason, 'no_target');
    d.reviveAction('p3', 'p1', true);
    assert.equal(R.size, 1);
    d.addPlayer({ id: 'p4', name: 'P4' });
    d.removePlayer('p3');
    assert.equal(R.size, 0, '살리던 사람이 나가면 끝');
  });

  test('거절: 다른 사람이 살리는 중(busy) · 자기 자신 · 산 사람 · 쓰러진 사람이 살리기 · 모르는 사람. 한 사람은 한 명만 살린다', () => {
    const { d, pos, P } = makeFlat({ ids: ['p1', 'p2', 'p3', 'p4'] });
    knockDown(d, pos, 'p2');
    knockDown(d, pos, 'p3');
    delete pos.p2;
    delete pos.p3;
    pos.p1 = [6, 0, 0];   // 두 몸(4, 0, 0)·(8, 0, 0) 사이
    pos.p4 = [6, 0, 1];
    const R = d.internals.revives;
    assert.deepEqual(d.reviveAction('p1', 'p2', true), []);
    assert.equal(d.reviveAction('p4', 'p2', true)[0].reason, 'busy', '다른 사람이 살리는 중');
    assert.deepEqual(d.reviveAction('p1', 'p2', true), [], '같은 사람이 다시 보내면 이어 간다');
    assert.equal(d.reviveAction('p1', 'p1', true)[0].reason, 'no_target');
    assert.equal(d.reviveAction('p1', 'p4', true)[0].reason, 'not_down');
    assert.equal(d.reviveAction('p2', 'p3', true)[0].reason, 'dead');
    assert.equal(d.reviveAction('p1', 'nobody', true)[0].reason, 'no_target');
    assert.equal(d.reviveAction('ghost', 'p2', true)[0].reason, 'dead');
    // 다른 사람으로 옮기면 앞의 것은 끊긴다
    step(d, 3);
    assert.deepEqual(d.reviveAction('p1', 'p3', true), []);
    assert.deepEqual([...R.keys()], ['p3']);
    assert.equal(R.get('p3').ms, 0);
    // 앞사람이 손을 떼면 다른 사람이 이어받을 수 있다
    assert.deepEqual(d.reviveAction('p4', 'p2', true), []);
    assert.equal(R.get('p2').by, 'p4');
    assert.equal(R.size, 2, '서로 다른 두 사람을 동시에 살릴 수 있다');
    const v = applyHordeSnapshot(JSON.parse(JSON.stringify(d.snapshot())));
    assert.equal(v.players.find((x) => x.id === 'p2').down.by, 'p4');
    assert.equal(v.players.find((x) => x.id === 'p3').down.by, 'p1');
  });

  test('혼자(고르는 동안 멈춤)에는 살리기가 없다', () => {
    const { d, pos } = makeFlat({ ids: ['p1', 'p2'], rules: { pauseOnCards: true } });
    knockDown(d, pos, 'p2');
    pos.p1 = [5, 0, 0];
    assert.equal(d.reviveAction('p1', 'p2', true)[0].reason, 'solo');
    assert.equal(d.internals.revives.size, 0);
  });

  test('다음 스테이지가 되면 쓰러진 사람은 지금처럼 체력 50%로 일어나고, 하던 살리기는 끝난다', () => {
    const { d, pos, P } = makeFlat({ ids: ['p1', 'p2'] });
    knockDown(d, pos, 'p2');
    delete pos.p2;
    pos.p1 = [5, 0, 0];
    d.reviveAction('p1', 'p2', true);
    holdRevive(d, 'p1', 'p2', 1000);
    assert.equal(d.internals.revives.size, 1);
    d.internals.S.stageEnd = d.internals.S.clock;   // 스테이지 시간 끝
    const ev = step(d);
    assert.ok(ev.some((e) => e.type === 'timeup'));
    const sp = ev.find((e) => e.type === 'spawn' && e.id === 'p2');
    assert.ok(sp && !sp.revive, '다음 스테이지 부활');
    const p2 = P('p2');
    assert.equal(p2.alive, true);
    assert.equal(p2.hp, Math.round(p2.maxHp * HORDE.reviveHpFrac));
    assert.equal(p2.downPos, null);
    assert.equal(d.internals.revives.size, 0);
    assert.equal(d.stage, 2);
  });

  test('방장 이전: 쓰러진 자리는 스냅샷으로 이어지고 하던 살리기는 처음부터. 옛 스냅샷 줄(22칸)도 풀린다', () => {
    const { d, pos } = makeFlat({ ids: ['p1', 'p2'] });
    knockDown(d, pos, 'p2');
    delete pos.p2;
    pos.p1 = [5, 0, 0];
    d.reviveAction('p1', 'p2', true);
    holdRevive(d, 'p1', 'p2', 1200);
    const snap = JSON.parse(JSON.stringify(d.snapshot()));
    const v = applyHordeSnapshot(snap);
    const down = v.players.find((x) => x.id === 'p2').down;
    assert.deepEqual(down.pos, [4, 0, 0]);
    assert.equal(down.by, 'p1');
    assert.ok(down.progress > 0.35 && down.progress < 0.45, `진행 ${down.progress}`);
    const r = restoreHorde(snap, {
      players: [{ id: 'p1', name: 'P1' }, { id: 'p2', name: 'P2' }], world: null, nav: null, spawns: FAR_SPAWNS, getPositions: () => pos, rules: FLAT_RULES
    });
    assert.equal(r.phase, 'wave');
    assert.deepEqual(r.internals.players.get('p2').downPos, [4, 0, 0]);
    assert.equal(r.internals.players.get('p2').alive, false);
    assert.equal(r.internals.revives.size, 0, '하던 살리기는 이어받지 않는다');
    assert.deepEqual(r.reviveAction('p1', 'p2', true), []);
    const ev = holdRevive(r, 'p1', 'p2', 3100);
    assert.ok(ev.some((e) => e.type === 'revive' && e.id === 'p2' && e.by === 'p1'), '새 방장에서 처음부터 3초');
    // 옛 방장의 스냅샷(밀려남·쓰러진 자리 칸이 없다)
    const old = JSON.parse(JSON.stringify(snap));
    for (const row of old.p) row.length = 22;
    const ov = applyHordeSnapshot(old);
    assert.ok(ov.players.every((p) => p.knock === null && p.down === null));
    assert.equal(ov.players.length, 2);
  });

  test('전멸하면 끝나고 살리기도 없다', () => {
    const { d, pos } = makeFlat({ ids: ['p1', 'p2'] });
    knockDown(d, pos, 'p2');
    delete pos.p2;
    pos.p1 = [5, 0, 0];
    d.reviveAction('p1', 'p2', true);
    const ev = knockDown(d, pos, 'p1');
    assert.ok(ev.some((e) => e.type === 'over'));
    assert.equal(d.phase, 'over');
    assert.equal(d.internals.revives.size, 0);
    assert.equal(d.reviveAction('p1', 'p2', true)[0].reason, 'not_wave');
  });
});

describe('검기', () => {
  test('피해 공식: 베기 검기는 베기, 찌르기 검기는 찌르기 피해(칼 증강이 붙고 거리와 상관없다)', () => {
    const k0 = computePerks([]), k1 = computePerks(['blade1']);
    const dmg = (kind, k, dist = 12) => zombieHitDamage({ weaponId: 'ml_knife', part: 'body', dist, kind }, k, {}, {}).dmg;
    const slash = WEAPONS.ml_knife.melee.slash.damage, stab = WEAPONS.ml_knife.melee.stab.damage;
    assert.equal(dmg('wave', k0), slash);
    assert.equal(dmg('waveStab', k0), stab);
    assert.equal(dmg('slash', k0, 1), slash, '칼 베기는 그대로');
    assert.equal(dmg('stab', k0, 1), stab, '칼 찌르기는 그대로');
    assert.ok(near(dmg('wave', k1), slash * 1.2));
    assert.ok(near(dmg('waveStab', k1), stab * 1.2));
    assert.equal(zombieHitDamage({ weaponId: 'ml_knife', kind: 'wave' }, k0, {}, {}).melee, true);
    assert.equal(zombieHitDamage({ weaponId: 'ml_katana', kind: 'waveStab' }, k0, {}, {}).dmg, WEAPONS.ml_katana.melee.stab.damage);
  });

  test('방장 판정: 증강이 없거나 총이면 거절, 검기 거리 + 여유 안은 칼과 같은 피해, 밖은 거절, 검기 하나에 6마리까지', () => {
    assert.equal(HORDE.waveMaxHits, 6);
    const { d, P } = makeFlat();
    runUntil(d, () => alive(d).length >= 1, 5000);
    const Z = alive(d)[0];
    Z.hp = Z.maxHp = 100000;
    let lastHp = Z.hp;
    const took = () => { const n = lastHp - Z.hp; lastHp = Z.hp; return n; };
    let shot = 0;
    const claim = (o = {}) => d.claimHit({ attackerId: 'p1', victimId: 'z' + Z.id, weaponId: 'ml_knife', part: 'body', dist: 5, kind: 'wave', count: 1, shotId: ++shot, ...o });
    const p = P('p1');
    assert.equal(claim()[0].reason, 'no_wave', '검기 증강이 없다');
    assert.equal(took(), 0);
    p.cards = ['wave1'];
    p.perks = computePerks(p.cards);
    assert.ok(!claim({ dist: 8 }).some((e) => e.type === 'reject'), '6 m + 여유 2.5 m 안');
    assert.equal(took(), WEAPONS.ml_knife.melee.slash.damage);
    claim({ dist: 8, kind: 'waveStab' });
    assert.equal(took(), WEAPONS.ml_knife.melee.stab.damage);
    assert.equal(claim({ dist: 9 })[0].reason, 'out_of_range');
    assert.equal(claim({ weaponId: 'ar_std' })[0].reason, 'no_wave', '총은 검기가 없다');
    assert.equal(took(), 0);
    // 칼의 보통 베기는 그대로(검기 거리를 받지 않는다)
    assert.ok(!claim({ kind: 'slash', dist: 3 }).some((e) => e.type === 'reject'));
    assert.equal(took(), WEAPONS.ml_knife.melee.slash.damage);
    assert.equal(claim({ kind: 'slash', dist: 8 })[0].reason, 'out_of_range');
    // 칼 증강이 붙는다 · 겹치면 더 멀리
    p.cards = ['wave1', 'wave2', 'blade1'];
    p.perks = computePerks(p.cards);
    claim({ dist: 16 });
    assert.equal(took(), Math.round(WEAPONS.ml_knife.melee.slash.damage * 1.2));
    // 검기 하나(shotId)에 6마리까지, 다른 검기는 따로 센다(날아가는 검기 둘이 섞여도)
    for (let i = 0; i < 6; i++) assert.ok(!claim({ shotId: 500 }).some((e) => e.type === 'reject'), `${i + 1}번째`);
    assert.equal(claim({ shotId: 500 })[0].reason, 'wave_cap');
    assert.ok(!claim({ shotId: 501 }).some((e) => e.type === 'reject'));
    for (let i = 0; i < 5; i++) claim({ shotId: 501 });
    assert.ok(!claim({ shotId: 502 }).some((e) => e.type === 'reject'));
    assert.equal(claim({ shotId: 501 })[0].reason, 'wave_cap');
    assert.equal(claim({ shotId: 500 })[0].reason, 'wave_cap');
  });
});

describe('좀비 모드 무기 교체: 한 번 쓴 총은 남은 탄 그대로', () => {
  test('equipWith: 탄을 주면 그 탄으로, 안 주면 새 탄으로 칸을 바꾸고 든 칸이면 바로 꺼낸다', () => {
    const a = createArsenal({ primary: 'ar_std', secondary: 'pt_std', melee: 'ml_knife' });
    a.setMods({ reserve: HORDE.reserveMul, finiteMags: HORDE.premiumReserveMags });
    a.resetRound({ primary: 'ar_std', secondary: 'pt_std', melee: 'ml_knife' });
    assert.equal(a.getWeapon().id, 'ar_std');
    assert.ok(a.equipWith('ar_rapid'));
    assert.equal(a.getLoadout().primary, 'ar_rapid');
    const fresh = a.getAmmo('ar_rapid');
    assert.equal(fresh.mag, WEAPONS.ar_rapid.mag);
    assert.equal(fresh.reserve, hordeAmmo(WEAPONS.ar_rapid).reserve);
    assert.ok(a.equipWith('ar_std', { mag: 7, reserve: 33 }));
    assert.deepEqual([a.getAmmo('ar_std').mag, a.getAmmo('ar_std').reserve], [7, 33]);
    assert.ok(a.equipWith('ar_std', { mag: 999, reserve: 99999 }));
    assert.equal(a.getAmmo('ar_std').mag, WEAPONS.ar_std.mag, '최대를 넘지 않는다');
    assert.equal(a.getAmmo('ar_std').reserve, hordeAmmo(WEAPONS.ar_std).reserve);
    assert.ok(a.equipWith('ml_tanto'));
    assert.equal(a.getLoadout().melee, 'ml_tanto');
    assert.equal(a.equipWith('nope'), false);
  });
});

describe('좀비 전용 맵', () => {
  test('restarea·subway: 검사기 통과, 사람 스폰 4곳 이상, 좀비 문 4곳 이상이 사람에게서 16 m 밖', async () => {
    const realWarn = console.warn;
    console.warn = () => {};
    const maps = await import('../js/maps/index.js').finally(() => { console.warn = realWarn; });
    const { checkMap } = await import('../tools/check-maps.mjs');
    for (const id of ZOMBIE_MAP_IDS) {
      const data = maps.MAPS[id];
      assert.ok(isZombieMap(data), id);
      const r = checkMap(id, data);
      assert.deepEqual(r.errors, [], `${id}: ${r.errors.join(' | ')}`);
      assert.deepEqual(r.warnings, [], `${id}: ${r.warnings.join(' | ')}`);
      assert.ok(r.horde.people >= 4 && r.horde.gates >= 4, `${id} ${JSON.stringify(r.horde)}`);
      assert.ok(r.horde.nearest >= HORDE.spawnSafeM, `${id} 가장 가까운 문 ${r.horde.nearest} m`);
      assert.equal(r.los, 0, `${id}: 시작 자리에서 좀비 문이 보이지 않는다`);
      assert.deepEqual(data.modes, ['zombie']);
      assert.equal(data.horde.gates.length, data.spawns.charterer.length);
    }
    assert.deepEqual(maps.mapsForMode('zombie').map((m) => m.id), ZOMBIE_MAP_IDS, '좀비 모드는 좀비 전용 맵만');
    for (const rs of ['classic', 'knife', 'sniper']) {
      assert.ok(!maps.mapsForRuleset(rs).some((m) => m.zombie), `${rs}: 다른 모드에는 좀비 전용 맵이 없다`);
    }
    assert.ok(!maps.mapsForMode('bomb').some((m) => m.zombie));
    assert.ok(!maps.mapsForMode('team', 'classic').some((m) => m.zombie));
    assert.ok(!isZombieMap(maps.MAPS.alley), '일반 맵은 좀비 전용이 아니다');
  });

  test('좀비 전용 맵에서 방장 시뮬레이션이 돈다: 문에서 나온 좀비가 사람에게 다가간다', async () => {
    const realWarn = console.warn;
    console.warn = () => {};
    const maps = await import('../js/maps/index.js').finally(() => { console.warn = realWarn; });
    for (const id of ZOMBIE_MAP_IDS) {
      const data = maps.MAPS[id];
      const c = buildCollision(data);
      const n = buildNavGrid(data);
      const pos = { p1: [c.spawns.owner[0].x, c.spawns.owner[0].y, c.spawns.owner[0].z] };
      const d = createHorde({ players: [{ id: 'p1', name: 'a' }], world: c.world, nav: n, spawns: c.spawns, gates: c.spawns.charterer, seed: 5, getPositions: () => pos, rules: { prepMs: 200 } });
      d.start();
      runUntil(d, () => d.internals.zombies.size >= 6, 20000);
      const dist = () => Math.min(...[...d.internals.zombies.values()].map((Z) => Math.hypot(Z.body.pos[0] - pos.p1[0], Z.body.pos[2] - pos.p1[2])));
      const d0 = dist();
      runUntil(d, () => false, 6000);
      assert.ok(dist() < d0 - 3, `${id}: 좀비가 다가온다 ${d0.toFixed(1)} → ${dist().toFixed(1)} m`);
    }
  });
});

describe('카드 고르기 입력 잠금: 쏘던 클릭·무기 키·재장전으로 잘못 고르지 않는다', () => {
  const clock = () => { const c = { t: 1000 }; c.now = () => c.t; return c; };

  test('잠금 시간은 처음 1초, 다시 뽑은 뒤 0.4초, 다시 뽑기는 R 0.5초 누르기', () => {
    assert.equal(CARD_ARM_MS, 1000);
    assert.ok(CARD_REARM_MS > 0 && CARD_REARM_MS < CARD_ARM_MS);
    assert.equal(REROLL_HOLD_MS, 500);
  });

  test('잠긴 동안의 클릭·숫자 키는 고르지 않고, 풀린 뒤 새로 누른 것만 고른다', () => {
    const c = clock();
    const g = createPickGate(c.now);
    g.arm(CARD_ARM_MS);
    assert.equal(g.armed(), false);
    g.press(); c.t += 50;
    assert.equal(g.clickOk(1), false, '카드가 뜨자마자 누른 클릭');
    assert.equal(g.keyOk(false), false, '카드가 뜨자마자 누른 숫자 키(무기 교체)');
    g.press(); c.t += CARD_ARM_MS;   // 잠금 중에 누르기 시작해 풀린 뒤에 뗐다
    assert.equal(g.armed(), true);
    assert.equal(g.clickOk(1), false, '잠금 중에 누르기 시작한 클릭은 풀린 뒤 떼어도 고르지 않는다');
    assert.equal(g.keyOk(true), false, '누르고 있어 반복되는 키');
    assert.equal(g.keyOk(false), true, '풀린 뒤 새로 누른 숫자 키');
    g.press(); c.t += 80;
    assert.equal(g.clickOk(1), true, '풀린 뒤 새로 누른 클릭');
    assert.equal(g.clickOk(0), true, '풀린 뒤 키보드로 누른 단추');
  });

  test('다시 잠그면 앞서 누른 것은 무효가 되고, R은 잠금이 풀린 뒤 새로 눌러야 센다', () => {
    const c = clock();
    const g = createPickGate(c.now);
    g.arm(0);
    g.press();
    assert.equal(g.clickOk(1), true);
    g.arm(CARD_REARM_MS);
    c.t += CARD_REARM_MS + 1;
    assert.equal(g.clickOk(1), false, '다시 뽑기 전에 누른 클릭은 새 카드를 고르지 않는다');
    g.arm(CARD_ARM_MS);
    assert.equal(g.holdStart(), false, '잠긴 동안 누른 R(재장전)은 다시 뽑기로 세지 않는다');
    assert.equal(g.holding(), false);
    c.t += CARD_ARM_MS;
    assert.equal(g.holdStart(), true);
    assert.equal(g.holding(), true);
    g.holdCancel();
    assert.equal(g.holding(), false, '짧게 떼면 다시 뽑지 않는다');
  });
});

describe('검토 뒤 고친 것(방장)', () => {
  /** 일반 좀비 하나를 at에 바로 세운다(일어나는 동작 없이) */
  function walkerAt(d, at) {
    const S = d.internals.S;
    const before = new Set(d.internals.zombies.keys());
    S.queue.unshift({ type: 'walker' });
    S.spawnAt = 0;
    step(d);
    const Z = [...d.internals.zombies.values()].find((z) => !before.has(z.id));
    Z.state = 'move';
    Z.body.pos[0] = at[0]; Z.body.pos[1] = at[1]; Z.body.pos[2] = at[2];
    S.queue.length = 0;
    S.spawnAt = Infinity;
    return Z;
  }
  /** 증강을 고르는 중으로 만든다(마감은 멀리: 시험 중에 저절로 무작위로 받지 않게) */
  const picking = (P) => { P.offer = { cards: ['hp1', 'regen1', 'leech1'], roll: 0, round: 1, rerolls: 1, count: 3, chest: false }; P.picks = 1; P.offerUntil = Infinity; };

  test('표적이 증강을 고르기 시작해 다른 사람으로 바뀌어도 좀비가 먼 좀비 문으로 다시 나오지 않는다(10초 넘게 붙어 싸운 뒤)', () => {
    const { d, pos, P } = makeFlat({ ids: ['p1', 'p2'] });
    pos.p2 = [30, 0, 0];
    P('p1').invulnUntil = Infinity;                           // 오래 맞아도 쓰러지지 않게
    const Z = walkerAt(d, [7, 0, 0]);
    step(d, 90);                                               // 걸어서 p1에게 붙는다(다가간 기록 = 1~2 m)
    assert.ok(Math.hypot(Z.body.pos[0], Z.body.pos[2]) < 2, `붙었다 ${Z.body.pos}`);
    step(d, 330);                                              // 11초 동안 p1 옆에서 때린다(다가간 기록은 그대로)
    assert.equal(Z.target, 'p1');
    const at = Z.body.pos.slice();
    picking(P('p1'));                                          // p1이 증강을 고르기 시작
    step(d, 3);
    assert.equal(Z.target, 'p2', '다른 사람을 노린다');
    assert.notEqual(Z.state, 'rise', '다시 나오지 않는다');
    assert.ok(Math.hypot(Z.body.pos[0] - at[0], Z.body.pos[2] - at[2]) < 2, `제자리 근처 ${Z.body.pos}`);
    step(d, 30);
    assert.notEqual(Z.state, 'rise');
    assert.ok(Z.body.pos[0] > at[0] + 1, '새 표적 쪽으로 걸어간다');
  });

  test('모두 증강을 고르는 동안 선 좀비: 휘두르던 공격을 거두고, 고르기가 끝나도 다시 나오지 않는다', () => {
    const { d, pos, P } = makeFlat({ ids: ['p1', 'p2'] });
    pos.p2 = [30, 0, 0];
    const Z = walkerAt(d, [9, 0, 0]);
    step(d, 15);                                               // p1 쪽으로 조금 걸어 다가간 기록이 생긴다
    const at = Z.body.pos.slice();
    Z.state = 'wind'; Z.until = d.internals.S.clock + 400;
    picking(P('p1')); picking(P('p2'));
    step(d, 330);
    assert.equal(Z.target, null);
    assert.equal(Z.state, 'move', '휘두르기 자세로 굳어 있지 않다');
    P('p2').offer = null; P('p2').picks = 0;
    step(d, 3);
    assert.equal(Z.target, 'p2');
    assert.notEqual(Z.state, 'rise');
    assert.ok(Math.hypot(Z.body.pos[0] - at[0], Z.body.pos[2] - at[2]) < 2, `제자리 근처 ${Z.body.pos}`);
  });

  test('뛰다가 공중에서 쓰러져도 쓰러진 자리는 바로 아래 바닥이다(표시가 뜨지 않고 바닥에서 살린다)', () => {
    const { d, me } = makeDirector();
    d.start();
    runUntil(d, () => d.phase === 'wave', 5000);
    const floor = getGroundY(col.world, me.pos[0], me.pos[2], 0.5);
    me.pos = [me.pos[0], floor + 1.98, me.pos[2]];
    step(d);
    const P1 = d.internals.players.get('p1');
    P1.hp = 1;
    spitAt(d, me.pos, 50);
    step(d);
    assert.equal(P1.alive, false);
    assert.ok(Math.abs(P1.downPos[1] - floor) < 1e-6, `바닥 ${floor}, 쓰러진 자리 ${P1.downPos}`);
    assert.deepEqual([P1.downPos[0], P1.downPos[2]], [me.pos[0], me.pos[2]]);
  });

  test('방장 루프가 1초에 한 번만 돌아도(숨은 탭) 살리기가 끝난다', () => {
    const { d, pos, P } = makeFlat({ ids: ['p1', 'p2'] });
    knockDown(d, pos, 'p2');
    pos.p1 = [5, 0, 0];
    let up = false;
    for (let i = 0; i < 6 && !up; i++) {
      d.reviveAction('p1', 'p2', true);                        // 화면은 0.3초마다 보내지만 방장은 tick 사이에만 받는다
      up = d.tick(1000).some((e) => e.type === 'revive' && e.id === 'p2');
    }
    assert.ok(up, '1초 tick으로도 3초 뒤에 일어난다');
    assert.equal(P('p2').alive, true);
  });

  test('전멸하면 쓰러진 자리를 더 싣지 않는다(전멸 화면에 살리기 표시가 남지 않게)', () => {
    const { d, pos } = makeFlat({ ids: ['p1', 'p2'] });
    knockDown(d, pos, 'p2');
    let v = applyHordeSnapshot(JSON.parse(JSON.stringify(d.snapshot())));
    assert.ok(v.players.find((x) => x.id === 'p2').down, '웨이브 중에는 싣는다');
    knockDown(d, pos, 'p1');
    assert.equal(d.phase, 'over');
    v = applyHordeSnapshot(JSON.parse(JSON.stringify(d.snapshot())));
    assert.ok(v.players.every((x) => x.down == null), JSON.stringify(v.players.map((x) => x.down)));
  });
});
