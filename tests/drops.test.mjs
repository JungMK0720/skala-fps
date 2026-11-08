/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 프리미엄 탄약과 바닥에 버린 총을 시험한다. 무기 표 규칙, arsenal의 줍기, drops.js의 형식 검사·상한·수명·거리, 프로토콜 왕복.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { WEAPONS, PRIMARY_IDS, SECONDARY_IDS, PREMIUM_PRICE, isPremium } from '../js/weapons/defs.js';
import { createArsenal } from '../js/weapons/logic.js';
import { DROP_HEIGHT, DROP_MAX, DROP_RADIUS, DROP_TTL_MS, createDrops, normalizeDrop } from '../js/game/drops.js';
import { EV, decodeDrop, decodeMessage, decodePick, encodeDrop, encodePick, isGameEvent } from '../js/game/protocol.js';

const DT = 1 / 60;
const GUNS = [...PRIMARY_IDS, ...SECONDARY_IDS];
const wire = (v) => JSON.parse(JSON.stringify(v));

/** 탄창이 빌 때까지 쏘고 재장전한다. 예비가 없으면 멈춘다 */
function drain(a, id, maxSeconds = 300) {
  for (let t = 0; t < maxSeconds; t += DT) {
    a.update(DT, { fireDown: true, firePressed: true, slot: null });
    a.update(DT, {});
    const left = a.getAmmo(id);
    if (left.mag <= 0 && left.reserve <= 0) return true;
  }
  return false;
}

describe('프리미엄 총', () => {
  test('상점 가격 기준으로 정해지고 네 자루다', () => {
    const premium = GUNS.filter(isPremium).sort();
    assert.deepEqual(premium, ['ar_line', 'dm_mark', 'sr_heavy', 'sr_twin']);
    for (const id of GUNS) assert.equal(WEAPONS[id].premium, WEAPONS[id].price >= PREMIUM_PRICE, id);
    assert.equal(isPremium('ml_katana'), false, '칼은 탄약이 없다');
    assert.equal(isPremium('없는무기'), false);
  });

  test('프리미엄은 예비가 무제한이고 나머지는 예비 2탄창이다', () => {
    for (const id of GUNS) {
      const d = WEAPONS[id];
      assert.equal(d.reserve, d.premium ? Infinity : d.mag * 2, id);
    }
  });

  test('프리미엄 총은 재장전해도 예비가 줄지 않고 탄창 크기는 그대로다', () => {
    const a = createArsenal({ primary: 'ar_line' });
    const ammo0 = a.getAmmo();
    assert.equal(ammo0.reserve, Infinity);
    assert.equal(ammo0.infinite, true);
    assert.equal(a.getHud(75).reserve, Infinity);
    for (let i = 0; i < 12; i++) a.update(DT, { fireDown: true });
    a.update(DT, {});
    const fired = a.getAmmo().mag;
    assert.ok(fired < WEAPONS.ar_line.mag);
    a.update(DT, { reloadPressed: true });
    for (let t = 0; t < WEAPONS.ar_line.reload + 0.2; t += DT) a.update(DT, {});
    assert.equal(a.getAmmo().mag, WEAPONS.ar_line.mag);
    assert.equal(a.getAmmo().reserve, Infinity);
    assert.equal(a.isPrimaryEmpty(), false);
  });

  test('일반 총은 다 쓰면 비고, 다음 목숨에 다시 찬다', () => {
    const a = createArsenal({ primary: 'sg_bx12' });
    assert.equal(a.getAmmo().infinite, false);
    assert.equal(a.isPrimaryEmpty(), false);
    assert.ok(drain(a, 'sg_bx12'), '다 쓰지 못했다');
    assert.equal(a.isPrimaryEmpty(), true);
    a.resetRound({ primary: 'sg_bx12' });
    assert.equal(a.isPrimaryEmpty(), false);
    assert.equal(a.getAmmo('sg_bx12').reserve, WEAPONS.sg_bx12.reserve);
  });
});

describe('총 줍기(arsenal)', () => {
  function emptyGun(primary = 'ar_std') {
    const a = createArsenal({ primary, secondary: 'pt_std', melee: 'ml_knife' });
    a.takePrimary(primary, { mag: 0, reserve: 0 });
    a.update(DT, {});
    return a;
  }

  test('주운 총을 바로 꺼내고 남은 탄약을 이어받는다', () => {
    const a = emptyGun();
    assert.equal(a.isPrimaryEmpty(), true);
    assert.equal(a.takePrimary('ar_rapid', { mag: 7, reserve: 11 }), true);
    const evs = a.update(DT, {});
    const sw = evs.find((e) => e.type === 'switch');
    assert.equal(sw.to, 'ar_rapid');
    assert.equal(a.getWeapon().id, 'ar_rapid');
    assert.equal(a.getPrimary(), 'ar_rapid');
    assert.equal(a.getAmmo().mag, 7);
    assert.equal(a.getAmmo().reserve, 11);
    assert.equal(a.isPrimaryEmpty(), false);
  });

  test('권총을 들고 있어도 주운 총으로 바꾸고, 휠로 돌아올 무기는 권총이다', () => {
    const a = emptyGun();
    a.update(DT, { slot: 2 });
    for (let t = 0; t < 0.6; t += DT) a.update(DT, {});
    assert.equal(a.getWeapon().id, 'pt_std');
    a.takePrimary('sm_vx3', { mag: 3, reserve: 0 });
    a.update(DT, {});
    assert.equal(a.getWeapon().id, 'sm_vx3');
    assert.equal(a.getWeapon().previous, 'pt_std');
  });

  test('탄약은 그 총의 최대를 넘지 못하고, 프리미엄 예비는 무제한이다', () => {
    const a = emptyGun();
    a.takePrimary('ar_std', { mag: 999, reserve: 999 });
    assert.equal(a.getAmmo('ar_std').mag, WEAPONS.ar_std.mag);
    assert.equal(a.getAmmo('ar_std').reserve, WEAPONS.ar_std.reserve);
    a.takePrimary('sr_twin', { mag: 2, reserve: 0 });
    assert.equal(a.getAmmo('sr_twin').mag, 2);
    assert.equal(a.getAmmo('sr_twin').reserve, Infinity);
    a.takePrimary('ar_std', { mag: -5, reserve: Number.NaN });
    assert.equal(a.getAmmo('ar_std').mag, 0);
    assert.equal(a.getAmmo('ar_std').reserve, WEAPONS.ar_std.reserve, '값이 없으면 가득 준다');
  });

  test('주무기가 아니거나 주무기 슬롯이 막힌 규칙이면 거절한다', () => {
    const a = emptyGun();
    for (const id of ['pt_std', 'ml_knife', 'gr_frag', '없는무기', null]) assert.equal(a.takePrimary(id, {}), false, String(id));
    const knife = createArsenal({ melee: 'ml_knife', allowedSlots: [3] });
    assert.equal(knife.isPrimaryEmpty(), false, '칼전에는 주무기가 없다');
    assert.equal(knife.takePrimary('ar_std', {}), false);
  });

  test('수류탄을 던지는 중에 주우면 던진 뒤 그 총으로 돌아온다', () => {
    const a = emptyGun();
    a.update(DT, { slot: 4 });
    for (let t = 0; t < 0.7; t += DT) a.update(DT, {});
    a.update(DT, { fireDown: true });
    for (let t = 0; t < 0.35; t += DT) a.update(DT, { fireDown: true });
    a.update(DT, {});
    a.update(DT, {});
    assert.equal(a.getWeapon().state, 'throw');
    a.takePrimary('ar_rapid', { mag: 5, reserve: 0 });
    assert.equal(a.getWeapon().id, 'gr_frag', '던지는 동작은 끊지 않는다');
    for (let t = 0; t < 0.6; t += DT) a.update(DT, {});
    assert.equal(a.getWeapon().id, 'ar_rapid');
  });

  test('주운 총은 이번 목숨에만 쓴다', () => {
    const a = emptyGun('ar_std');
    a.takePrimary('sr_heavy', { mag: 1, reserve: 0 });
    a.resetRound({ primary: 'ar_std', secondary: 'pt_std', melee: 'ml_knife' });
    assert.equal(a.getPrimary(), 'ar_std');
    assert.equal(a.getAmmo('ar_std').mag, WEAPONS.ar_std.mag);
  });
});

describe('들고 있는 총 버리기와 빈 칸 줍기(arsenal)', () => {
  const fresh = () => {
    const a = createArsenal({ primary: 'ar_std', secondary: 'pt_std', melee: 'ml_knife' });
    a.update(DT, {});
    return a;
  };

  test('주무기를 버리면 남은 탄을 돌려주고 칸이 비며 보조무기를 꺼낸다', () => {
    const a = fresh();
    a.update(DT, { fireDown: true, firePressed: true });
    const left = a.getAmmo('ar_std');
    const out = a.dropHeld();
    assert.deepEqual(out, { id: 'ar_std', slot: 1, mag: left.mag, reserve: left.reserve });
    assert.equal(a.isSlotEmpty(1), true);
    a.update(DT, {});
    assert.equal(a.getWeapon().id, 'pt_std');
    assert.equal(a.getSlots()[0].id, null, 'HUD에는 빈 칸');
    assert.equal(a.getSlots()[0].dropped, true);
    assert.equal(a.update(DT, { slot: 1 }).some((e) => e.type === 'switch'), false, '빈 칸으로는 바꿀 수 없다');
  });

  test('보조무기도 버리면 칼이 남고, 칼과 수류탄은 버리지 않는다', () => {
    const a = fresh();
    a.dropHeld();
    a.update(DT, {});
    assert.equal(a.dropHeld().id, 'pt_std');
    a.update(DT, {});
    assert.equal(a.getWeapon().id, 'ml_knife');
    assert.equal(a.dropHeld(), null);
    assert.ok(a.getMoveMul() > WEAPONS.ar_std.moveMul, '칼을 들면 더 빠르다');
  });

  test('빈 칸이어야 줍는다: 그 칸에 무기가 있으면 거절하고, 비어 있으면 남은 탄 그대로 꺼낸다', () => {
    const a = fresh();
    assert.equal(a.takeWeapon('ar_rapid', { mag: 9, reserve: 20 }), false, '주무기 칸에 총이 있다');
    a.dropHeld();
    assert.equal(a.takeWeapon('pt_magnum', { mag: 2, reserve: 3 }), false, '보조 칸은 비지 않았다');
    assert.equal(a.takeWeapon('ar_rapid', { mag: 9, reserve: 20 }), true);
    a.update(DT, {});
    assert.equal(a.getWeapon().id, 'ar_rapid');
    assert.deepEqual([a.getAmmo().mag, a.getAmmo().reserve], [9, 20]);
    assert.equal(a.isSlotEmpty(1), false);
    assert.equal(a.takeWeapon('ml_tanto', {}), false, '칼은 줍지 않는다');
  });

  test('다음 목숨에는 버린 칸이 자기 장비로 돌아온다', () => {
    const a = fresh();
    a.dropHeld();
    a.resetRound({ primary: 'ar_std', secondary: 'pt_std', melee: 'ml_knife' });
    assert.equal(a.isSlotEmpty(1), false);
    assert.equal(a.getSlots()[0].id, 'ar_std');
  });

  test('주울 수 있는 총만 고르는 조건을 nearest에 줄 수 있다', () => {
    const d = createDrops({ now: () => 0 });
    d.add({ id: 'mine', weaponId: 'ar_std', pos: [0.2, 0, 0], mag: 1, reserve: 0 });
    d.add({ id: 'other', weaponId: 'ar_rapid', pos: [0.6, 0, 0], mag: 1, reserve: 0 });
    assert.equal(d.nearest([0, 0, 0]).id, 'mine');
    assert.equal(d.nearest([0, 0, 0], (x) => x.id !== 'mine').id, 'other');
  });
});

describe('바닥의 총 목록(drops.js)', () => {
  const gun = (over = {}) => ({ id: 'a#1', weaponId: 'ar_std', pos: [1, 0, 2], mag: 10, reserve: 20, ...over });

  test('형식이 맞으면 그대로 받고 탄약은 최대로 자른다', () => {
    assert.deepEqual(normalizeDrop(gun()), { id: 'a#1', weaponId: 'ar_std', pos: [1, 0, 2], mag: 10, reserve: 20 });
    const big = normalizeDrop(gun({ mag: 9999, reserve: 9999 }));
    assert.equal(big.mag, WEAPONS.ar_std.mag);
    assert.equal(big.reserve, WEAPONS.ar_std.reserve);
    assert.equal(normalizeDrop(gun({ weaponId: 'sr_twin', reserve: 3 })).reserve, Infinity, '프리미엄은 언제나 무제한');
    assert.equal(normalizeDrop(gun({ mag: 3.9 })).mag, 3);
  });

  test('믿을 수 없는 값은 버린다', () => {
    const bad = [
      null, 'x', 7, {},
      gun({ id: '' }), gun({ id: 'x'.repeat(65) }), gun({ id: 5 }),
      gun({ weaponId: 'ml_knife' }), gun({ weaponId: 'gr_frag' }), gun({ weaponId: '없는무기' }), gun({ weaponId: {} }), gun({ weaponId: '__proto__' }),
      gun({ pos: null }), gun({ pos: [1, 2] }), gun({ pos: [1, Number.NaN, 3] }), gun({ pos: [1, Infinity, 3] }), gun({ pos: { x: 1 } }),
      gun({ mag: 0, reserve: 0 }), gun({ mag: -3, reserve: -3 }), gun({ mag: 'many', reserve: null }),
    ];
    for (const v of bad) assert.equal(normalizeDrop(v), null, JSON.stringify(v));
    assert.equal(normalizeDrop(gun({ weaponId: 'pt_std' })).weaponId, 'pt_std', '보조무기(권총)도 바닥에 놓을 수 있다');
  });

  test('같은 id는 한 번만 들어가고, 없는 id를 빼도 괜찮다', () => {
    const d = createDrops({ now: () => 0 });
    assert.ok(d.add(gun()).drop);
    assert.equal(d.add(gun({ mag: 1 })).drop, null);
    assert.equal(d.size, 1);
    assert.equal(d.list()[0].mag, 10);
    assert.equal(d.remove('없는 id'), null);
    assert.equal(d.remove('a#1').id, 'a#1');
    assert.equal(d.size, 0);
  });

  test('상한을 넘으면 가장 오래된 것부터 밀려난다', () => {
    const d = createDrops({ now: () => 0 });
    for (let i = 0; i < DROP_MAX; i++) assert.deepEqual(d.add(gun({ id: `g${i}` })).evicted, []);
    const { drop, evicted } = d.add(gun({ id: 'new' }));
    assert.ok(drop);
    assert.deepEqual(evicted.map((x) => x.id), ['g0']);
    assert.equal(d.size, DROP_MAX);
  });

  test('수명이 다하면 사라진다', () => {
    let t = 1000;
    const d = createDrops({ now: () => t });
    d.add(gun());
    t += DROP_TTL_MS - 1;
    assert.deepEqual(d.expire(), []);
    t += 1;
    assert.deepEqual(d.expire().map((x) => x.id), ['a#1']);
    assert.equal(d.size, 0);
  });

  test('닿는 거리 안의 가장 가까운 총을 찾는다', () => {
    const d = createDrops({ now: () => 0 });
    d.add(gun({ id: 'far', pos: [0, 0, 0] }));
    d.add(gun({ id: 'near', pos: [1, 0, 0] }));
    assert.equal(d.nearest([0.9, 0, 0]).id, 'near');
    assert.equal(d.nearest([0, 0, DROP_RADIUS + 0.01]), null);
    assert.equal(d.nearest([0, DROP_HEIGHT + 0.5, 0]), null, '위층의 총은 줍지 못한다');
    assert.equal(d.nearest([0, DROP_HEIGHT - 0.5, 0]).id, 'far');
    assert.equal(d.clear().length, 2);
    assert.equal(d.nearest([0, 0, 0]), null);
  });
});

describe('프로토콜(g2d·g2k)', () => {
  test('버린 총이 왕복한다. 위치는 cm 해상도, 무제한은 −1로 간다', () => {
    const a = wire(encodeDrop(5, { dropId: 'p1#2', weaponId: 'ar_std', pos: [1.234, 0.5, -7.891], mag: 12, reserve: 30 }));
    assert.deepEqual(decodeDrop(a), { id: 5, dropId: 'p1#2', weaponId: 'ar_std', pos: [1.23, 0.5, -7.89], mag: 12, reserve: 30 });
    const b = wire(encodeDrop(6, { dropId: 'p1#3', weaponId: 'sr_twin', pos: [0, 0, 0], mag: 2, reserve: Infinity }));
    assert.equal(b[7], -1, 'JSON에 Infinity를 싣지 않는다');
    assert.equal(decodeDrop(b).reserve, Infinity);
    assert.deepEqual(decodeMessage(EV.drop, a).type, 'drop');
  });

  test('주웠다는 알림이 왕복한다', () => {
    assert.deepEqual(decodePick(wire(encodePick(9, 'p1#2'))), { id: 9, dropId: 'p1#2' });
    assert.equal(decodeMessage(EV.pick, wire(encodePick(9, 'p1#2'))).type, 'pick');
    assert.ok(isGameEvent(EV.drop) && isGameEvent(EV.pick));
  });

  test('형식이 틀리면 던지지 않고 null이다', () => {
    const bad = [null, 7, 'x', {}, [], [1], [1, '', 'ar_std', 0, 0, 0, 1, 1], [1, 'a', 5, 0, 0, 0, 1, 1], [1, 'a', 'ar_std', 'x', 0, 0, 1, 1], ['a', 'a', 'ar_std', 0, 0, 0, 1, 1], [1, 'a', 'ar_std', 0, 0, 0, 1]];
    for (const v of bad) assert.equal(decodeDrop(v), null, JSON.stringify(v));
    for (const v of [null, 7, [], [1], [1, ''], ['a', 'b'], [1, {}]]) assert.equal(decodePick(v), null, JSON.stringify(v));
  });

  test('큰 좌표는 제한 안으로 자른다', () => {
    const d = decodeDrop([1, 'a', 'ar_std', 1e12, -1e12, 0, 1e9, 1e9]);
    assert.ok(Math.abs(d.pos[0]) <= 1e5 && Math.abs(d.pos[1]) <= 1e5);
    assert.ok(d.mag <= 9999 && d.reserve <= 9999);
  });
});
