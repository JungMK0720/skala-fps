/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 좀비 물량 막기 시험. 카드 100장 이상·제안·다시 뽑기·능력치 상한, 보스 10종과 스테이지별 보스 수, 탄약 3배와 무기 배율,
 *          방장 시뮬레이션(스테이지 진행·처치·카드·전멸·스냅샷 왕복·방장 이전), 좀비 문·바닥 보급품, 무기 교체의 탄 기억,
 *          좀비 전용 맵(검사기·모드별 맵 목록·시뮬레이션), 카드 고르기 입력 잠금을 three.js 없이 확인한다.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCollision, isZombieMap } from '../js/maps/collision.js';
import { buildNavGrid } from '../js/game/navgrid.js';
import { CARDS, CARD_COUNT, TIERS, computePerks, perkMaxHp, makeOffer, encodeCards, decodeCards, cardById, cardAvailable, PERK_CAPS } from '../js/game/horde/cards.js';
import { BOSSES, pickBosses, SKILL_KINDS } from '../js/game/horde/bosses.js';
import { HORDE, bossCount, zombieCount, hpMul, hordeAmmo, makeRng, zombieMix, LOOT_TYPES, LOOT_TABLE, BOSS_LOOT, rollLoot, lootByCode, ZOMBIE_IDS as ZOMBIE_TYPES_IDS } from '../js/game/horde/rules.js';
import { createHorde, applyHordeSnapshot, restoreHorde, hordeSummary, zombieIdOf } from '../js/game/horde/director.js';
import { modsFromPerks } from '../js/game/horde/client.js';
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

function makeDirector(extra = {}) {
  const me = { pos: [-28, 0, 0] };
  const d = createHorde({
    players: [{ id: 'p1', name: '하늘' }], world: col.world, nav, spawns: col.spawns, seed: 11,
    getPositions: () => ({ p1: me.pos }), rules: { prepMs: 300, cardMs: 2000, breakMs: 300, ...(extra.rules || {}) }, ...extra
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

  test('보스를 깬 제안의 첫 장은 영웅 이상, 전설은 4스테이지부터', () => {
    for (let s = 0; s < 40; s++) {
      const o = makeOffer({ seed: s, playerId: 'x', stage: 5, roll: 0, taken: [] });
      assert.ok(['epic', 'legend'].includes(cardById(o[0]).tier), o[0]);
      const early = makeOffer({ seed: s, playerId: 'x', stage: 2, roll: 0, taken: [] });
      assert.ok(early.every((id) => cardById(id).tier !== 'legend'));
    }
  });

  test('짧은 글자로 싣고 다시 푼다', () => {
    const ids = ['mag1', 'second', 'ammo2', 'mag1'];
    assert.deepEqual(decodeCards(encodeCards(ids)), ids);
    assert.deepEqual(decodeCards('zz!!'), []);
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
    assert.ok(zombieMix(12).length === 6);
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
  test('준비 → 1스테이지 → 다 잡으면 카드 → 고르면 다음 스테이지', () => {
    const { d } = makeDirector();
    const ev0 = d.start();
    assert.ok(ev0.some((e) => e.type === 'spawn' && e.id === 'p1'));
    runUntil(d, () => d.phase === 'wave', 2000);
    assert.equal(d.stage, 1);
    runUntil(d, () => d.phase === 'cards', 90000, () => killAll(d));
    assert.equal(d.phase, 'cards');
    const P = d.internals.players.get('p1');
    assert.equal(P.offer.cards.length, 3);
    assert.equal(P.offer.rerolls, 1);
    const before = P.offer.cards.slice();
    d.cardAction('p1', 'reroll');
    assert.notDeepEqual(P.offer.cards, before);
    assert.equal(d.internals.players.get('p1').offer.rerolls, 0);
    assert.equal(d.cardAction('p1', 'reroll')[0].type, 'reject', '다시 뽑기는 제안마다 한 번');
    const pick = P.offer.cards[1];
    const ev = d.cardAction('p1', 'pick', pick);
    assert.ok(ev.some((e) => e.type === 'card' && e.card === pick));
    assert.equal(d.phase, 'break');
    runUntil(d, () => d.phase === 'wave', 2000);
    assert.equal(d.stage, 2);
    assert.deepEqual(d.internals.players.get('p1').cards, [pick]);
  });

  test('카드 시간이 지나면 첫 카드를 받는다', () => {
    const { d } = makeDirector();
    d.start();
    runUntil(d, () => d.phase === 'cards', 90000, () => killAll(d));
    const first = d.internals.players.get('p1').offer.cards[0];
    runUntil(d, () => d.phase === 'break', 3000);
    assert.deepEqual(d.internals.players.get('p1').cards, [first]);
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
    const d = createHorde({ players: [{ id: 'p1', name: 'a' }, { id: 'p2', name: 'b' }], world: col.world, nav, spawns: col.spawns, seed: 2, getPositions: () => pos, rules: { prepMs: 200, cardMs: 1000, breakMs: 200 } });
    d.start();
    runUntil(d, () => d.phase === 'wave', 1000);
    const j = d.addPlayer({ id: 'p3', name: 'c' });
    assert.equal(j[0].type, 'join');
    assert.equal(d.internals.players.get('p3').alive, false);
    d.addPlayer({ id: 'p4', name: 'd' });
    assert.equal(d.addPlayer({ id: 'p5', name: 'e' })[0].reason, 'full');
    runUntil(d, () => d.phase === 'cards', 90000, () => killAll(d));
    for (const id of ['p1', 'p2', 'p3', 'p4']) d.cardAction(id, 'pick', d.internals.players.get(id).offer.cards[0]);
    const ev = runUntil(d, () => d.phase === 'wave', 2000);
    assert.ok(ev.some((e) => e.type === 'spawn' && e.id === 'p3'), '늦게 온 사람이 나온다');
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
      const near = Math.min(...gates.map((g) => Math.hypot(g.x - p[0], g.z - p[2])));
      assert.ok(near < 1.7, `좀비 ${id}가 문에서 ${near.toFixed(2)} m에서 나왔다`);
    }
    assert.equal(d.internals.gates.length, gates.length);
  });

  test('떨어뜨리는 표: 종류는 넷 중 하나, 확률은 0~1, 보스는 셋', () => {
    for (const [type, list] of Object.entries(LOOT_TABLE)) {
      assert.ok(ZOMBIE_TYPES_IDS.includes(type), type);
      for (const [kind, p] of list) { assert.ok(LOOT_TYPES[kind], `${type}:${kind}`); assert.ok(p > 0 && p < 1, `${type}:${kind} ${p}`); }
    }
    assert.deepEqual([...BOSS_LOOT].sort(), ['ammo', 'med', 'nade']);
    assert.equal(rollLoot('walker', () => 0.99), null, '굴림이 크면 아무것도 없다');
    assert.equal(rollLoot('walker', () => 0), 'mag', '앞에서부터 처음 맞은 하나');
    assert.equal(lootByCode(LOOT_TYPES.med.code), LOOT_TYPES.med);
    assert.equal(lootByCode(99), null);
  });

  test('보스를 쓰러뜨리면 보급품 셋이 떨어지고, 스냅샷에 실리고, 가까이 간 사람만 줍는다', () => {
    const { d, me } = makeDirector({ startStage: 3 });
    d.start();
    runUntil(d, () => [...d.internals.zombies.values()].some((Z) => Z.boss && Z.state !== 'rise'), 30000);
    const boss = [...d.internals.zombies.values()].find((Z) => Z.boss);
    let shot = 500;
    while (boss.state !== 'dead') d.claimHit({ attackerId: 'p1', victimId: 'z' + boss.id, weaponId: 'sr_heavy', part: 'head', dist: 10, kind: 'shot', count: 1, shotId: ++shot });
    const drops = [...d.internals.loot.values()].filter((L) => Math.hypot(L.x - boss.body.pos[0], L.z - boss.body.pos[2]) < 2);
    assert.deepEqual(drops.map((L) => L.kind).sort(), ['ammo', 'med', 'nade']);
    // 스냅샷 왕복
    const v = applyHordeSnapshot(JSON.parse(JSON.stringify(d.snapshot())));
    for (const L of drops) assert.ok(v.loot.some((x) => x.id === L.id && x.kind === L.kind && Math.abs(x.pos[0] - L.x) < 0.02), `뷰에 ${L.kind}`);
    assert.ok(v.loot.every((x) => x.leftMs > 0 && x.leftMs <= HORDE.lootMs));
    // 멀리서는 못 줍는다
    const med = drops.find((L) => L.kind === 'med');
    me.pos = [med.x + 8, med.y, med.z];
    assert.equal(d.claimLoot('p1', med.id)[0].reason, 'far');
    // 다치고 가까이 가면 구급 상자가 체력을 채운다
    const P = d.internals.players.get('p1');
    P.hp = 40;
    me.pos = [med.x + 1, med.y, med.z];
    const ev = d.claimLoot('p1', med.id);
    assert.equal(ev[0].type, 'loot');
    assert.equal(ev[0].kind, 'med');
    assert.equal(ev[0].by, 'p1');
    assert.equal(ev[0].heal, LOOT_TYPES.med.heal);
    assert.equal(P.hp, 40 + LOOT_TYPES.med.heal);
    assert.equal(d.claimLoot('p1', med.id)[0].reason, 'gone', '두 번 주울 수 없다');
    assert.equal(d.claimLoot('nobody', drops[0].id)[0].reason, 'dead');
  });

  test('보급품은 정해진 시간이 지나면 사라지고, 상한을 넘으면 오래된 것부터 치운다', () => {
    const { d } = makeDirector({ startStage: 3, rules: { lootMs: 1500, maxLoot: 4 } });
    d.start();
    runUntil(d, () => [...d.internals.zombies.values()].some((Z) => Z.boss && Z.state !== 'rise'), 30000);
    const boss = [...d.internals.zombies.values()].find((Z) => Z.boss);
    let shot = 900;
    while (boss.state !== 'dead') d.claimHit({ attackerId: 'p1', victimId: 'z' + boss.id, weaponId: 'sr_heavy', part: 'head', dist: 10, kind: 'shot', count: 1, shotId: ++shot });
    killAll(d);
    assert.ok(d.internals.loot.size <= 4, `상한 4, 지금 ${d.internals.loot.size}`);
    assert.ok(d.internals.loot.size >= 3);
    runUntil(d, () => d.internals.loot.size === 0, 4000);
    assert.equal(d.internals.loot.size, 0, '1.5초 뒤 모두 사라진다');
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
