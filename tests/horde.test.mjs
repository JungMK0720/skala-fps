/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 좀비 물량 막기 시험. 카드 100장 이상·제안·다시 뽑기·능력치 상한, 보스 10종과 스테이지별 보스 수, 탄약 3배와 무기 배율,
 *          방장 시뮬레이션(스테이지 진행·처치·카드·전멸·스냅샷 왕복·방장 이전)을 three.js 없이 확인한다.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCollision } from '../js/maps/collision.js';
import { buildNavGrid } from '../js/game/navgrid.js';
import { CARDS, CARD_COUNT, TIERS, computePerks, perkMaxHp, makeOffer, encodeCards, decodeCards, cardById, cardAvailable, PERK_CAPS } from '../js/game/horde/cards.js';
import { BOSSES, pickBosses, SKILL_KINDS } from '../js/game/horde/bosses.js';
import { HORDE, bossCount, zombieCount, hpMul, hordeAmmo, makeRng, zombieMix } from '../js/game/horde/rules.js';
import { createHorde, applyHordeSnapshot, restoreHorde, hordeSummary, zombieIdOf } from '../js/game/horde/director.js';
import { modsFromPerks } from '../js/game/horde/client.js';
import { zombieReward } from '../js/account/economy.js';
import { WEAPONS } from '../js/weapons/defs.js';
import { createArsenal } from '../js/weapons/logic.js';

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

  test('5스테이지마다 보스, 50부터 2마리, 100부터 3마리', () => {
    assert.equal(bossCount(4), 0);
    assert.equal(bossCount(5), 1);
    assert.equal(bossCount(45), 1);
    assert.equal(bossCount(49), 0);
    assert.equal(bossCount(50), 2);
    assert.equal(bossCount(95), 2);
    assert.equal(bossCount(100), 3);
    assert.equal(bossCount(150), 3);
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
    const { d } = makeDirector({ startStage: 12 });
    d.start();
    const ev = runUntil(d, () => d.phase === 'over', 120000);
    assert.equal(d.phase, 'over');
    assert.ok(ev.some((e) => e.type === 'down' && e.id === 'p1'));
    const over = ev.find((e) => e.type === 'over');
    assert.equal(over.stage, 12);
    const v = applyHordeSnapshot(JSON.parse(JSON.stringify(d.snapshot())));
    assert.equal(v.phase, 'over');
    assert.equal(hordeSummary(v, 'p1').stage, 12);
  });

  test('보스 스테이지: 5에 1마리, 50에 2마리, 100에 3마리', () => {
    for (const [stage, n] of [[5, 1], [50, 2], [100, 3]]) {
      const { d } = makeDirector({ startStage: stage });
      d.start();
      const ev = runUntil(d, (all) => all.filter((e) => e.type === 'bossSpawn').length >= n, 20000);
      assert.equal(ev.filter((e) => e.type === 'bossSpawn').length, n, `${stage}스테이지`);
      const bosses = [...d.internals.zombies.values()].filter((Z) => Z.boss);
      assert.equal(new Set(bosses.map((Z) => Z.boss.id)).size, n, '서로 다른 보스');
    }
  });

  test('보스가 스킬을 쓴다', () => {
    const { d } = makeDirector({ startStage: 5 });
    d.start();
    const ev = runUntil(d, (all) => all.some((e) => e.type === 'skill'), 60000);
    assert.ok(ev.some((e) => e.type === 'skill'));
  });

  test('관통: 같은 발로 맞힌 두 번째 좀비는 관통 카드가 없으면 거절한다', () => {
    const { d } = makeDirector({ startStage: 3 });
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
