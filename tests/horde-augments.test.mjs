/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: QA 요청 증강 묶음 시험. 수류탄 폭심 1000, 무제한 관통, 머리 피해 2배, 재장전 시간 −50%(두 번이면 재장전 없음), 방패 칼,
 *          공중 강타(+500%), 중력건(좀비를 한 점으로 끌어당김), 기본 무기 변경 증강 삭제, 원거리 좀비 20스테이지부터를 three.js 없이 확인한다.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CARDS, computePerks, perkMaxHp, makeOffer, cardById, cardAvailable } from '../js/game/horde/cards.js';
import { HORDE, zombieMix, ZOMBIE_TYPES, frostSlowMs, hordeAmmo } from '../js/game/horde/rules.js';
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
    assert.equal(k.pierce, 99);
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
    const k = computePerks(['head4']);
    const head = zombieHitDamage({ weaponId: 'ar_std', part: 'head', dist: 5, kind: 'shot' }, k, {}, {}).dmg;
    assert.equal(head, WEAPONS.ar_std.damage.head * 2, '머리 +100%');
  });

  test('재장전 시간 −50%, 최대 2번, 두 번이면 재장전이 거의 즉시지만 탄은 그대로 줄어든다', () => {
    const c = cardById('hands1');
    assert.equal(c.max, 2);
    assert.equal(c.fx.reloadCut, 0.5);
    for (const id of ['hands2', 'hands3', 'hands4']) assert.ok(cardById(id).retired, id);
    assert.ok(cardAvailable(c, ['hands1']) && !cardAvailable(c, ['hands1', 'hands1']), '두 번까지');
    assert.equal(computePerks(['hands1', 'hands1']).reloadCut, 1, '두 번이면 100%');
    const base = modsFromPerks(computePerks([]));
    const one = modsFromPerks(computePerks(['hands1']));
    assert.equal(one.reload / base.reload, 2, '시간이 절반');
    assert.equal(one.thrift, 0);
    const two = modsFromPerks(computePerks(['hands1', 'hands1']));
    assert.equal(two.thrift, 0, '빠른 손은 탄을 아껴 주지 않는다');
    // 실제 무기: 재장전이 거의 즉시라 계속 쏘지만, 쏜 만큼 예비 탄이 줄고 가진 탄만큼만 쏜다
    const a = createArsenal({ primary: 'ar_std', rng: () => 0.999 });
    a.setMods(two);
    a.resetRound({});
    const start = a.getAmmo('ar_std');
    const total = start.mag + start.reserve;
    let shots = 0;
    for (let i = 0; i < 600; i++) for (const e of a.update(1 / 60, { fireDown: true })) if (e.type === 'fire') shots++;   // 10초 동안 누르고 있는다
    const end = a.getAmmo('ar_std');
    assert.ok(shots > 40, `10초 동안 ${shots}발`);
    assert.ok(shots <= total, '가진 탄보다 많이 쏘지 못한다');
    assert.equal(end.mag + end.reserve, total - shots, '쏜 만큼 탄이 줄었다');
    // 증강이 없으면 같은 시간에 탄창이 비어 재장전한다
    const b = createArsenal({ primary: 'ar_std', rng: () => 0.999 });
    b.setMods(base);
    b.resetRound({});
    let reloads = 0;
    for (let i = 0; i < 600; i++) for (const e of b.update(1 / 60, { fireDown: true })) if (e.type === 'reload' || e.type === 'reloadStart') reloads++;
    assert.ok(reloads > 0 || b.getAmmo('ar_std').mag < mag0, '증강이 없으면 탄이 줄고 재장전이 필요하다');
  });

  test('원거리 좀비(스피터)는 11스테이지부터 나온다', () => {
    assert.equal(ZOMBIE_TYPES.spitter.from, 11);
    for (let s = 1; s < 11; s++) assert.ok(!zombieMix(s).some((m) => m.type.id === 'spitter'), `${s}`);
    assert.ok(zombieMix(11).some((m) => m.type.id === 'spitter'));
  });

  test('새 카드는 제안에 나온다', () => {
    const seen = new Set();
    for (let s = 0; s < 1500; s++) for (const id of makeOffer({ seed: s, playerId: 'p', stage: 10, taken: [] })) seen.add(id);
    for (const id of ['shieldKnife', 'airStrike', 'sideGravity', 'pierce1', 'hands1']) assert.ok(seen.has(id), id);
    assert.ok(CARDS.every((c) => !c.retired || !seen.has(c.id)), '제안에서 뺀 카드는 나오지 않는다');
  });

  test('방패 칼: 칼을 들고 앞에서 맞으면 피해 −45%, 총을 들거나 뒤에서 맞으면 그대로', () => {
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
    assert.equal(front, Math.round(base * 0.55), `앞에서 ${front} / ${base}`);
    assert.equal(lost('shieldKnife', 1, [0, 0, -1]), base, '총을 들면 방패가 없다');
    assert.equal(lost('shieldKnife', 3, [0, 0, 1]), base, '뒤에서 맞으면 막지 못한다');
    assert.equal(cardById('shieldKnife').fx.guard, 0.45);
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

describe('상점·증강 새 무기(2026-11-20)', () => {
  /** p1(원점)에서 +x로 dist m 떨어진 곳에 살아 있는 좀비 하나를 세운다(체력 넉넉히) */
  function zombieAt(d, dist) {
    const Z = alive(d)[0];
    Z.state = 'move'; Z.skill = null; Z.hp = Z.maxHp = 1e6;
    Z.body.pos[0] = dist; Z.body.pos[1] = 0; Z.body.pos[2] = 0;
    Z.body.vel[0] = Z.body.vel[1] = Z.body.vel[2] = 0;
    return Z;
  }

  test('공기총: 맞은 좀비가 사수 반대쪽 위 45°로 날아갔다가 내려앉고, 피해는 약하다', () => {
    const { d } = makeFlat();
    const Z = zombieAt(d, 4);
    d.claimHit({ attackerId: 'p1', victimId: 'z' + Z.id, weaponId: 'pn_air', part: 'body', dist: 4, kind: 'shot', count: 5, shotId: 1 });
    assert.equal(Z.maxHp - Z.hp, 10, '펠릿 5발 × 몸 2');
    const [vx, vy] = Z.body.vel;
    assert.ok(vx > 4 && Math.abs(vx - vy) < 1e-6, `사수 반대쪽(+x)으로 위 45°: ${vx.toFixed(2)}, ${vy.toFixed(2)}`);
    let top = 0;
    for (let i = 0; i < 400 && Z.knockUntil; i++) { step(d); top = Math.max(top, Z.body.pos[1]); }
    assert.ok(top > 1 && Z.body.pos[0] > 6, `높이 ${top.toFixed(2)} m · 거리 ${Z.body.pos[0].toFixed(2)} m`);
    assert.equal(Z.knockUntil, 0, '내려앉으면 끝난다');
    assert.ok(Math.abs(Z.body.pos[1]) < 1e-6, '처음 높이에 내려앉는다');
  });

  test('007 가방: 휘두르기는 약하게, 우클릭 내려치기는 더 세게 밀고, 다른 칼은 밀지 않는다', () => {
    const push = (weaponId, kind) => {
      const { d } = makeFlat();
      const Z = zombieAt(d, 1.5);
      d.claimHit({ attackerId: 'p1', victimId: 'z' + Z.id, weaponId, part: 'body', dist: 1.5, kind, count: 1 });
      return Math.hypot(Z.body.vel[0], Z.body.vel[1]);
    };
    const slash = push('ml_case', 'slash'), stab = push('ml_case', 'stab');
    assert.ok(slash > 0 && stab > slash * 1.5, `휘두르기 ${slash.toFixed(2)} · 내려치기 ${stab.toFixed(2)} m/s`);
    assert.equal(push('ml_knife', 'slash'), 0);
  });

  test('말뚝건 450 · 투척 도끼는 주장 하나에 한 마리 700 · 제우스의 번개는 카드가 있어야 하고 여섯 마리까지 150씩', () => {
    const dealt = (cards, kind, times) => {
      const { d } = makeFlat({ p1: [0, 0, 0] }, cards);
      const Z = zombieAt(d, 6);
      d.claimExplosion({ attackerId: 'p1', center: { x: 6, y: 1, z: 0 }, kind, victims: Array.from({ length: times }, () => ({ id: 'z' + Z.id, dmg: 100 })) });
      return Z.maxHp - Z.hp;
    };
    assert.equal(dealt([], 'stake', 1), 450);
    assert.equal(dealt([], 'axe', 3), 700, '도끼는 닿은 좀비 하나마다 따로 주장한다');
    assert.equal(nadeDamage(100, { sideMaster: 1 }, false, 'axe'), 700, '투척 칸 도끼는 보조무기 마스터 효과를 받지 않는다');
    assert.equal(dealt([], 'bolt', 1), 0, '카드 없이는 번개 주장을 받지 않는다');
    assert.equal(dealt(['zeus'], 'bolt', 9), 6 * 150, '처음 하나 + 다섯 번 튄 것까지, 피해는 줄지 않는다');
    assert.equal(cardById('zeus').instant.primary, 'zs_bolt');
  });

  test('제우스의 번개는 좀비 모드의 프리미엄 탄창 제한(finiteMags)을 받지 않고 예비가 무제한이다', () => {
    assert.equal(hordeAmmo(WEAPONS.zs_bolt).reserve, Infinity);
    const a = createArsenal({ primary: 'zs_bolt', secondary: 'pt_std', melee: 'ml_knife' });
    a.setMods(modsFromPerks(computePerks([])));
    a.resetRound({});
    assert.equal(a.getAmmo('zs_bolt').reserve, Infinity);
    assert.ok(Number.isFinite(a.getAmmo('dm_mark').reserve), '다른 프리미엄 총은 좀비 모드에서 정해진 탄창 수');
  });
});

describe('완벽주의자', () => {
  test('머리 총 피해 ×4, 몸·손·다리·발 총 피해 ×0.1, 칼은 그대로', () => {
    const base = computePerks([]);
    const perfect = computePerks(['perfect']);
    const hit = (part, weaponId = 'ar_std') => {
      const c = { weaponId, part, dist: 5, kind: 'shot' };
      return [zombieHitDamage(c, base, {}, {}).dmg, zombieHitDamage(c, perfect, {}, {}).dmg];
    };
    assert.equal(hit('head')[1], hit('head')[0] * 4);
    for (const part of ['body', 'hand', 'legs', 'foot']) {
      const [normal, reduced] = hit(part);
      assert.ok(Math.abs(reduced - normal * 0.1) < 1e-9, part);
    }
    const [knife, perfectKnife] = hit('body', 'ml_knife');
    assert.equal(perfectKnife, knife);
    assert.equal(modsFromPerks(perfect).spread, 1, '예전 탄퍼짐 감소 효과는 없다');
    assert.ok(!cardAvailable(cardById('perfect'), ['perfect']), '한 번만 고른다');
  });
});

describe('거인 학살자', () => {
  test('보스는 네 배, 일반 좀비는 절반: 총·칼·수류탄 피해에 적용', () => {
    const base = computePerks([]);
    const giant = computePerks(['giant']);
    for (const weaponId of ['ar_std', 'ml_knife']) for (const boss of [false, true]) {
      const c = { weaponId, part: 'body', dist: 2, kind: 'shot' };
      const normal = zombieHitDamage(c, base, { boss }, {}).dmg;
      const boosted = zombieHitDamage(c, giant, { boss }, {}).dmg;
      assert.equal(boosted, normal * (boss ? 4 : 0.5), `${weaponId} ${boss ? '보스' : '일반'}`);
    }
    for (const boss of [false, true]) assert.equal(nadeDamage(80, giant, boss), nadeDamage(80, base, boss) * (boss ? 4 : 0.5));
    assert.ok(!cardAvailable(cardById('giant'), ['giant']));
  });
  test('화염 수류탄 장판도 일반 좀비에게 절반만 준다', () => {
    const burn = (cards) => {
      const { d } = makeFlat({ p1: [0, 0, 0] }, ['fireNade', ...cards]);
      const Z = alive(d)[0];
      Z.hp = Z.maxHp = 1e6;
      Z.body.pos[0] = 20; Z.body.pos[1] = 0; Z.body.pos[2] = 0;
      Z.state = 'wind'; Z.until = d.internals.S.clock + 10000;
      d.claimExplosion({ attackerId: 'p1', center: { x: 20, y: 0, z: 0 }, victims: [] });
      step(d, 18);
      return 1e6 - Z.hp;
    };
    const base = burn([]);
    assert.ok(base > 0);
    assert.equal(burn(['giant']), Math.round(base * 0.5));
  });
});

describe('고정 회복', () => {
  test('불굴과 회복 주사는 최대 체력과 상관없이 초당 체력 0.5씩 회복한다', () => {
    const healed = (cards, maxHp) => {
      const { d, p } = makeFlat({ p1: [0, 0, 0] }, cards);
      p.maxHp = maxHp;
      p.hp = 20;
      p.regenAcc = 0;
      d.tick(1000);
      d.tick(1000);
      return p.hp - 20;
    };
    assert.equal(healed([], 100), 0);
    assert.equal(healed(['iron'], 100), 1);
    assert.equal(healed(['iron'], 200), 1);
    assert.equal(healed(['syringe'], 100), 1);
    assert.equal(healed(['iron', 'syringe'], 100), 2);
  });
});

describe('희귀 증강', () => {
  test('다연발 투척은 희귀 등급으로 네 번까지 겹쳐 던지는 수를 늘린다', () => {
    const card = cardById('multiNade');
    assert.equal(card.tier, 'rare');
    assert.ok(cardAvailable(card, ['multiNade', 'multiNade', 'multiNade']));
    assert.ok(!cardAvailable(card, ['multiNade', 'multiNade', 'multiNade', 'multiNade']));
    assert.equal(computePerks(['multiNade', 'multiNade', 'multiNade']).nadeMulti, 3);
  });

  test('사냥 본능 피해 증가와 전술 재장전 탄창 증가가 실제 무기 피해·탄 수에 반영된다', () => {
    const c = { weaponId: 'ar_std', part: 'body', dist: 5, kind: 'shot' };
    const base = zombieHitDamage(c, computePerks([]), {}, {}).dmg;
    assert.ok(Math.abs(zombieHitDamage(c, computePerks(['hunter']), {}, {}).dmg - base * 1.24) < 1e-9);
    const a = createArsenal({ primary: 'ar_std' });
    a.setMods(modsFromPerks(computePerks(['tactical'])));
    a.resetRound({});
    assert.equal(a.getAmmo('ar_std').magSize, 60);
  });
});

describe('철벽', () => {
  test('최대 체력은 200, 연사는 20% 감소하고 이동 속도는 그대로다', () => {
    const k = computePerks(['wall']);
    assert.equal(perkMaxHp(k), 200);
    assert.equal(k.move, 0);
    const shots = (cards) => {
      const a = createArsenal({ primary: 'ar_std', rng: () => 0.5 });
      a.setMods(modsFromPerks(computePerks(cards)));
      a.resetRound({});
      let n = 0;
      for (let i = 0; i < 60; i++) for (const e of a.update(1 / 60, { fireDown: true }, { speed: 0, onGround: true })) if (e.type === 'fire') n++;
      return n;
    };
    assert.equal(shots([]), 10);
    assert.equal(shots(['wall']), 8);
  });
});

describe('탄약 절약', () => {
  test('한 장은 45% 확률로 탄을 보존하고 두 장은 90%까지 쌓인다', () => {
    const spent = (cards, roll) => {
      const a = createArsenal({ primary: 'ar_std', rng: () => roll });
      a.setMods(modsFromPerks(computePerks(cards)));
      a.resetRound({});
      const before = a.getAmmo('ar_std').mag;
      a.update(1 / 60, { fireDown: true }, { speed: 0, onGround: true });
      return before - a.getAmmo('ar_std').mag;
    };
    assert.equal(spent(['thrift'], 0.44), 0);
    assert.equal(spent(['thrift'], 0.45), 1);
    assert.equal(spent(['thrift', 'thrift'], 0.89), 0);
    assert.equal(spent(['thrift', 'thrift'], 0.9), 1);
    assert.ok(cardAvailable(cardById('thrift'), ['thrift']));
    assert.ok(!cardAvailable(cardById('thrift'), ['thrift', 'thrift']), '효과 없는 세 번째 선택은 제안하지 않는다');
  });
});

describe('유리 대포', () => {
  test('총과 수류탄 피해가 50% 늘어난다', () => {
    const base = computePerks([]);
    const glass = computePerks(['glass']);
    const c = { weaponId: 'ar_std', part: 'body', dist: 5, kind: 'shot' };
    assert.equal(zombieHitDamage(c, glass, {}, {}).dmg, zombieHitDamage(c, base, {}, {}).dmg * 1.5);
    assert.equal(nadeDamage(100, glass), nadeDamage(100, base) * 1.5);
  });
});

describe('아드레날린', () => {
  test('체력 35% 이하에서만 총 피해가 두 배가 된다', () => {
    const k = computePerks(['adrenaline']);
    const c = { weaponId: 'ar_std', part: 'body', dist: 5, kind: 'shot' };
    const dmg = (hpFrac) => zombieHitDamage(c, k, {}, { myHpFrac: hpFrac }).dmg;
    const normal = zombieHitDamage(c, computePerks([]), {}, { myHpFrac: 0.35 }).dmg;
    assert.equal(dmg(0.36), normal);
    assert.equal(dmg(0.35), normal * 2);
    assert.equal(dmg(0.1), normal * 2);
  });
});

describe('벙커', () => {
  test('좀비 피해를 45% 줄이고 스테이지마다 남은 보호막에 100을 더한다', () => {
    const damageTaken = (cards) => {
      const { d, p } = makeFlat({ p1: [0, 0, 0] }, cards);
      swing(d, alive(d)[0], [1.2, 0, 0]);
      const before = p.hp;
      step(d);
      return before - p.hp;
    };
    const base = damageTaken([]);
    assert.ok(base > 0);
    assert.equal(damageTaken(['bunker']), Math.round(base * 0.55));

    const d = createHorde({ players: [{ id: 'p1', name: 'P1' }], world: null, nav: null, spawns: FAR_SPAWNS, seed: 7, getPositions: () => ({ p1: [0, 0, 0] }), rules: { prepMs: 100, stageMs: 1000, cardMs: 600000 } });
    d.start();
    runUntil(d, () => d.phase === 'wave', 2000);
    const p = d.internals.players.get('p1');
    p.cards = ['bunker'];
    p.perks = computePerks(p.cards);
    p.shield = 50;
    const stage = d.internals.S.stage;
    runUntil(d, () => d.internals.S.stage === stage + 1, 3000);
    assert.equal(p.shield, 150);
  });
});

describe('여덟 번째 요청 증강', () => {
  test('냉각탄: 25%까지 1초, 넘게 겹치면 시간도 비례해서 늘어난다(느려짐 세기는 60%에서 멈춤)', () => {
    assert.deepEqual([0.08, 0.25, 0.5, 0.75].map((s) => frostSlowMs(s)), [1000, 1000, 2000, 3000]);
    const slowOf = (cards) => {
      const { d } = makeFlat({ p1: [0, 0, 0] }, cards);
      const Z = alive(d)[0];
      Z.hp = Z.maxHp = 100000;
      const t0 = d.internals.S.clock;
      d.claimHit({ attackerId: 'p1', victimId: 'z' + Z.id, weaponId: 'ar_std', part: 'body', dist: 10, kind: 'shot', count: 1, shotId: 1 });
      return { ms: Math.round(Z.slowUntil - t0), mul: Z.slowMul };
    };
    assert.deepEqual(slowOf(['frost4']), { ms: 1000, mul: 0.75 });
    assert.deepEqual(slowOf(['frost4', 'frost4']), { ms: 2000, mul: 0.5 });
    const three = slowOf(['frost4', 'frost4', 'frost4']);
    assert.equal(three.ms, 3000);
    assert.ok(Math.abs(three.mul - 0.4) < 1e-9, '세기는 60%에서 멈추고 시간만 는다');
  });

  test('폭발 반응 장갑: 좀비에게 맞으면 내 자리에서 손 수류탄이 터지고(수류탄 피해·반경 증강), 단계만큼 기다렸다 다시 터진다', () => {
    const run = (cards) => {
      const { d } = makeFlat({ p1: [0, 0, 0] }, cards);
      const [Z, near, far] = alive(d);
      for (const X of [Z, near, far]) X.hp = X.maxHp = 1e6;
      near.body.pos[0] = 0; near.body.pos[1] = 0; near.body.pos[2] = 3; near.state = 'move';
      far.body.pos[0] = 0; far.body.pos[1] = 0; far.body.pos[2] = 7.5; far.state = 'move';
      const fx0 = d.internals.fxList.length;
      swing(d, Z, [1.2, 0, 0]);
      step(d);
      const lost = (X) => 1e6 - X.hp;
      return { d, Z, near, far, lost, blasts: d.internals.fxList.slice(fx0).filter((x) => x.kind === 'blast').length };
    };
    const off = run([]);
    assert.equal(off.blasts, 0, '증강이 없으면 터지지 않는다');
    assert.equal(off.lost(off.near), 0);
    const on = run(['thorn4']);
    assert.equal(on.blasts, 1, '맞으면 한 번 터진다');
    assert.ok(on.lost(on.near) >= 500, `3 m 안 좀비는 수류탄 피해: ${on.lost(on.near)}`);
    assert.equal(on.lost(on.far), 0, '6 m 밖은 맞지 않는다');
    const wide = run(['thorn4', 'blast4']);
    assert.ok(wide.lost(wide.far) > 0, '폭발 반경 증강이 붙는다');
    const strong = run(['thorn4', 'demo4']);
    assert.ok(strong.lost(strong.near) > on.lost(on.near), '수류탄 피해 증강이 붙는다');
    const effects = run(['thorn4', 'fireNade', 'iceNade', 'decoyNade']);
    assert.ok(effects.near.frozenUntil > effects.d.internals.S.clock, '빙결 효과');
    assert.equal(effects.d.internals.fields.length, 1, '화염 장판');
    assert.equal(effects.d.internals.decoys.size, 1, '어그로 분신');
    // 1초(IV)가 지나기 전에 다시 맞으면 터지지 않는다
    const { d, Z } = on;
    step(d, 10);
    const n0 = d.internals.fxList.filter((x) => x.kind === 'blast').length;
    swing(d, Z, [1.2, 0, 0]);
    step(d);
    assert.equal(d.internals.fxList.filter((x) => x.kind === 'blast').length, n0, '대기 중에는 터지지 않는다');
    assert.deepEqual(['thorn1', 'thorn2', 'thorn3', 'thorn4'].map((id) => +(1 / cardById(id).fx.reactive).toFixed(2)), [4, 3, 2, 1]);
  });

  test('보호막: 스테이지가 시작할 때마다 남은 보호막에 더해진다', () => {
    const d = createHorde({ players: [{ id: 'p1', name: 'P1' }], world: null, nav: null, spawns: FAR_SPAWNS, seed: 7, getPositions: () => ({ p1: [0, 0, 0] }), rules: { prepMs: 100, stageMs: 1000, cardMs: 600000 } });
    d.start();
    runUntil(d, () => d.phase === 'wave', 2000);
    const p = d.internals.players.get('p1');
    p.cards = ['shield1'];
    p.perks = computePerks(p.cards);
    p.shield = 50;
    const stage = d.internals.S.stage;
    runUntil(d, () => d.internals.S.stage === stage + 1, 3000);
    assert.equal(p.shield, 80, '깨지지 않은 50에 기본 등급의 30을 더한다');
    assert.deepEqual(['shield1', 'shield2', 'shield3', 'shield4'].map((id) => cardById(id).fx.shield), [30, 50, 80, 120]);
  });
});
