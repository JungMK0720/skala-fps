/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: QA 요청 증강 묶음 시험. 수류탄 폭심 1000, 무제한 관통, 머리 피해 2배, 재장전 시간 −50%(두 번이면 재장전 없음), 방패 칼,
 *          공중 강타(+500%), 중력건(좀비를 한 점으로 끌어당김), 기본 무기 변경 증강 삭제, 원거리 좀비 20스테이지부터를 three.js 없이 확인한다.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CARDS, computePerks, makeOffer, cardById, cardAvailable, PERK_CAPS } from '../js/game/horde/cards.js';
import { HORDE, zombieMix, ZOMBIE_TYPES } from '../js/game/horde/rules.js';
import { createHorde, zombieHitDamage, nadeDamage } from '../js/game/horde/director.js';
import { modsFromPerks } from '../js/game/horde/client.js';
import { WEAPONS } from '../js/weapons/defs.js';
import { createArsenal } from '../js/weapons/logic.js';

const STEP = 1000 / HORDE.simHz;
const FAR_SPAWNS = Object.freeze({
  owner: [{ x: 0, z: 0 }, { x: 4, z: 0 }],
  charterer: [{ x: 400, z: 0 }, { x: 400, z: 40 }, { x: -400, z: 0 }]
});
const FLAT_RULES = Object.freeze({ prepMs: 100, stageMs: 600000, cardMs: 600000 });

function runUntil(d, pred, maxMs = 120000) {
  let t = 0;
  while (t < maxMs) {
    d.tick(100);
    t += 100;
    if (pred()) return true;
  }
  return false;
}
function step(d, n = 1) { for (let i = 0; i < n; i++) d.tick(STEP); }
const alive = (d) => [...d.internals.zombies.values()].filter((Z) => Z.state !== 'dead');

/** 벽 없는 시험장. pos 하나(사람 p1)를 getPositions가 그대로 돌려준다(방패·공중 강타는 yaw·slot·air가 있는 객체를 읽는다) */
function makeFlat(pos = { p1: [0, 0, 0] }, cards = []) {
  const d = createHorde({
    players: [{ id: 'p1', name: 'P1' }], world: null, nav: null, spawns: FAR_SPAWNS, seed: 7,
    getPositions: () => pos, rules: FLAT_RULES
  });
  d.start();
  runUntil(d, () => d.phase === 'wave', 2000);
  const p = d.internals.players.get('p1');
  p.cards = cards.slice();
  p.perks = computePerks(p.cards);
  p.hp = p.maxHp = 100000;
  runUntil(d, () => alive(d).length >= 3, 12000);
  return { d, p };
}
/** 좀비 Z를 at에 세우고 다음 간격에 바로 때리게 한다 */
function swing(d, Z, at) {
  Z.body.pos[0] = at[0]; Z.body.pos[1] = at[1]; Z.body.pos[2] = at[2];
  Z.state = 'wind'; Z.until = d.internals.S.clock; Z.windRanged = false; Z.skill = null;
}

describe('QA 요청 증강 묶음', () => {
  test('수류탄 폭심 기본 피해는 1000(손 수류탄·C4), 유탄 발사기·바주카포는 그대로', () => {
    assert.equal(nadeDamage(100, {}), 1000);
    assert.equal(nadeDamage(100, {}, false, 'c4'), 1000);
    assert.equal(nadeDamage(50, {}), 500, '반경 안쪽은 거리 감쇠 그대로');
    assert.equal(nadeDamage(100, {}, false, 'gl'), 120);
    assert.equal(nadeDamage(100, {}, false, 'rocket'), 260);
  });

  test('관통탄은 무제한 한 장: 뚫을 때마다 70%지만 최소 30%, 예전 II~IV는 제안에 나오지 않는다', () => {
    const k = computePerks(['pierce1']);
    assert.equal(k.pierce, PERK_CAPS.pierce);
    assert.ok(k.pierce >= 50, '사실상 무제한');
    assert.equal(cardById('pierce1').max, 1);
    assert.ok(!cardAvailable(cardById('pierce1'), ['pierce1']), '한 장뿐');
    for (const id of ['pierce2', 'pierce3', 'pierce4']) assert.ok(cardById(id).retired, `${id}는 제안에서 빠졌다`);
    const dmg = (n) => zombieHitDamage({ weaponId: 'ar_std', part: 'body', dist: 5, kind: 'shot' }, k, {}, { nth: n }).dmg;
    assert.ok(Math.abs(dmg(1) / dmg(0) - 0.7) < 1e-9);
    assert.ok(Math.abs(dmg(2) / dmg(0) - 0.49) < 1e-9);
    assert.ok(Math.abs(dmg(30) / dmg(0) - 0.3) < 1e-9, '아무리 뚫어도 30%는 남는다');
    const { d } = makeFlat({ p1: [0, 0, 0] }, ['pierce1']);
    const Z = alive(d)[0];
    Z.hp = Z.maxHp = 1e9;
    let accepted = 0;
    for (let i = 0; i < 12; i++) {
      const ev = d.claimHit({ attackerId: 'p1', victimId: 'z' + Z.id, weaponId: 'ar_std', part: 'body', dist: 10, kind: 'shot', count: 1, shotId: 777 });
      if (!ev.some((e) => e.type === 'reject')) accepted++;
    }
    assert.equal(accepted, 12, '한 발이 12마리를 맞혀도 거절하지 않는다');
    const none = makeFlat({ p1: [0, 0, 0] }, []);
    const Z2 = alive(none.d)[0];
    let ok2 = 0;
    for (let i = 0; i < 3; i++) if (!none.d.claimHit({ attackerId: 'p1', victimId: 'z' + Z2.id, weaponId: 'ar_std', part: 'body', dist: 10, kind: 'shot', count: 1, shotId: 5 }).some((e) => e.type === 'reject')) ok2++;
    assert.equal(ok2, 1, '증강이 없으면 첫 마리만');
  });

  test('기본 무기를 바꾸는 증강(무기 교체권)은 제안에서 빠진다', () => {
    assert.ok(cardById('rearm').retired);
    for (let s = 0; s < 800; s++) for (const id of makeOffer({ seed: s, playerId: 'p', stage: 8, taken: [], count: 4 })) assert.notEqual(id, 'rearm');
  });

  test('머리 피해 증강은 예전의 2배', () => {
    assert.deepEqual(['head1', 'head2', 'head3', 'head4'].map((id) => cardById(id).fx.head), [0.24, 0.4, 0.64, 1]);
    assert.equal(cardById('perfect').fx.head, 0.6);
    const k = computePerks(['head4']);
    const head = zombieHitDamage({ weaponId: 'ar_std', part: 'head', dist: 5, kind: 'shot' }, k, {}, {}).dmg;
    assert.equal(head, WEAPONS.ar_std.damage.head * 2, '머리 +100%');
  });

  test('재장전 시간 −50%, 최대 2번, 두 번이면 재장전 없이 계속 쏜다', () => {
    const c = cardById('hands1');
    assert.equal(c.max, 2);
    assert.equal(c.fx.reloadCut, 0.5);
    for (const id of ['hands2', 'hands3', 'hands4']) assert.ok(cardById(id).retired, id);
    assert.ok(cardAvailable(c, ['hands1']) && !cardAvailable(c, ['hands1', 'hands1']), '두 번까지');
    assert.equal(computePerks(['hands1', 'hands1', 'hands1']).reloadCut, 1, '상한 100%');
    const base = modsFromPerks(computePerks([]));
    const one = modsFromPerks(computePerks(['hands1']));
    assert.equal(one.reload / base.reload, 2, '시간이 절반');
    assert.equal(one.thrift, 0);
    const two = modsFromPerks(computePerks(['hands1', 'hands1']));
    assert.equal(two.thrift, 1);
    // 실제 무기: 오래 쏴도 탄창이 줄지 않는다
    const a = createArsenal({ primary: 'ar_std', rng: () => 0.999 });
    a.setMods(two);
    a.resetRound({});
    const mag0 = a.getAmmo('ar_std').mag;
    let shots = 0;
    for (let i = 0; i < 600; i++) for (const e of a.update(1 / 60, { fireDown: true })) if (e.type === 'fire') shots++;   // 10초 동안 누르고 있는다
    assert.ok(shots > 40, `10초 동안 ${shots}발`);
    assert.equal(a.getAmmo('ar_std').mag, mag0, '쏴도 탄창이 줄지 않는다');
    // 증강이 없으면 같은 시간에 탄창이 비어 재장전한다
    const b = createArsenal({ primary: 'ar_std', rng: () => 0.999 });
    b.setMods(base);
    b.resetRound({});
    let reloads = 0;
    for (let i = 0; i < 600; i++) for (const e of b.update(1 / 60, { fireDown: true })) if (e.type === 'reload' || e.type === 'reloadStart') reloads++;
    assert.ok(reloads > 0 || b.getAmmo('ar_std').mag < mag0, '증강이 없으면 탄이 줄고 재장전이 필요하다');
  });

  test('원거리 좀비(스피터)는 20스테이지부터 나온다', () => {
    assert.equal(ZOMBIE_TYPES.spitter.from, 20);
    for (let s = 1; s < 20; s++) assert.ok(!zombieMix(s).some((m) => m.type.id === 'spitter'), `${s}`);
    assert.ok(zombieMix(20).some((m) => m.type.id === 'spitter'));
  });

  test('새 카드는 제안에 나온다', () => {
    const seen = new Set();
    for (let s = 0; s < 1500; s++) for (const id of makeOffer({ seed: s, playerId: 'p', stage: 10, taken: [] })) seen.add(id);
    for (const id of ['shieldKnife', 'airStrike', 'sideGravity', 'pierce1', 'hands1']) assert.ok(seen.has(id), id);
    assert.ok(CARDS.every((c) => !c.retired || !seen.has(c.id)), '제안에서 뺀 카드는 나오지 않는다');
  });

  test('방패 칼: 칼을 들고 앞에서 맞으면 피해 −90%, 총을 들거나 뒤에서 맞으면 그대로', () => {
    const lost = (card, slot, at) => {
      const pos = { p1: { x: 0, y: 0, z: 0, yaw: 0, slot } };
      const { d, p } = makeFlat(pos, card ? [card] : []);
      const Z = alive(d)[0];
      swing(d, Z, at);
      const before = p.hp;
      step(d, 2);
      return before - p.hp;
    };
    // yaw 0이면 바라보는 쪽은 −z
    const base = lost(null, 3, [0, 0, -1]);
    assert.ok(base > 0, `기본 피해 ${base}`);
    const front = lost('shieldKnife', 3, [0, 0, -1]);
    assert.ok(front > 0 && front <= Math.ceil(base * 0.1) + 1, `앞에서 ${front} / ${base}`);
    assert.equal(lost('shieldKnife', 1, [0, 0, -1]), base, '총을 들면 방패가 없다');
    assert.equal(lost('shieldKnife', 3, [0, 0, 1]), base, '뒤에서 맞으면 막지 못한다');
    assert.equal(cardById('shieldKnife').fx.guard, 0.9);
  });

  test('공중 강타: 점프로 떠 있을 때만 피해 +500%(방장 판정과 피해 숫자가 같다)', () => {
    const k = computePerks(['airStrike']);
    const hit = (air) => zombieHitDamage({ weaponId: 'ar_std', part: 'body', dist: 5, kind: 'shot' }, k, {}, { air }).dmg;
    assert.equal(hit(true), hit(false) * 6);
    assert.equal(zombieHitDamage({ weaponId: 'ar_std', part: 'body', dist: 5, kind: 'shot' }, computePerks([]), {}, { air: true }).dmg, hit(false), '증강이 없으면 그대로');
    const dmgOf = (air) => {
      const { d } = makeFlat({ p1: { x: 0, y: 0, z: 0, yaw: 0, slot: 1, air } }, ['airStrike']);
      const Z = alive(d)[0];
      Z.hp = Z.maxHp = 100000;
      d.claimHit({ attackerId: 'p1', victimId: 'z' + Z.id, weaponId: 'ar_std', part: 'body', dist: 10, kind: 'shot', count: 1, shotId: 1 });
      return Z.maxHp - Z.hp;
    };
    assert.equal(dmgOf(true), dmgOf(false) * 6);
  });

  test('중력건: 터진 자리로 반경 안의 좀비가 끌려와 뭉치고(피해 없음), 증강이 없으면 아무 일도 없다', () => {
    const run = (cards) => {
      const { d } = makeFlat({ p1: [0, 0, 0] }, cards);
      const zs = alive(d).slice(0, 3);
      zs.forEach((Z, i) => { Z.state = 'move'; Z.hp = Z.maxHp = 1e6; Z.body.pos[0] = 20 + i * 2; Z.body.pos[1] = 0; Z.body.pos[2] = 6 - i * 3; });
      const hp0 = zs.map((Z) => Z.hp);
      d.claimExplosion({ attackerId: 'p1', center: { x: 20, y: 0, z: 0 }, kind: 'gravity', victims: zs.map((Z) => ({ id: 'z' + Z.id, dmg: 100 })) });
      step(d, Math.ceil(2000 / STEP));
      return { hurt: zs.some((Z, i) => Z.hp !== hp0[i]), spread: Math.max(...zs.map((Z) => Math.hypot(Z.body.pos[0] - 20, Z.body.pos[2]))) };
    };
    const on = run(['sideGravity']);
    assert.ok(on.spread < 2.2, `뭉쳤다 ${on.spread.toFixed(2)} m`);
    assert.ok(!on.hurt, '피해는 없다');
    const off = run([]);
    assert.ok(off.spread > on.spread, `증강이 없으면 끌려오지 않는다 ${off.spread.toFixed(1)} m`);
    assert.equal(WEAPONS.gv_gun.projectile.kind, 'gravity');
    assert.equal(WEAPONS.gv_gun.zombieOnly, true);
    assert.equal(cardById('sideGravity').instant.side, 'gv_gun');
  });
});
