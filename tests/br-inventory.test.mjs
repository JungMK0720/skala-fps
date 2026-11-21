/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 배틀로얄 가방 인벤토리를 시험한다. 구급상자 채널링(취소하면 남고, 다 쓰면 한 번 회복, 봇도 같은 규칙), 가방 등급 상한(일부만 줍기·
 *          더 좋은 가방으로 바꾸면 옛 가방을 떨어뜨림), 부착물 장착 조건·교체 규칙·스탯 효과, 주무기 두 자루(키 1·2) 장비, 보급품 굴림·항목
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createArsenal } from '../js/weapons/logic.js';
import { getDef } from '../js/weapons/defs.js';
import { createPack, ammoFamily, ammoCap, canAttach, isUpgrade, attachStats, PACK_TIERS } from '../js/game/br/pack.js';
import { MEDKIT, createChannel, channelInput, botMayStartHeal, botMustCancelHeal, botChannelInput } from '../js/game/br/medkit.js';
import { createRoyaleKit, START_LIGHT_AMMO, supplyLabel } from '../js/game/br/kit.js';
import { createRoyaleRun } from '../js/game/br/solo.js';
import { rollLoot, LOOT_KINDS, BR } from '../js/game/br/rules.js';
import { createDrops } from '../js/game/drops.js';
import { getMap } from '../js/maps/index.js';

/** 배틀로얄처럼 권총·칼로 출발하는 내 무기 모듈 + 가방 */
function setup() {
  const arsenal = createArsenal({ primary: 'ar_std', secondary: 'pt_std', melee: 'ml_knife', grenade: 'gr_frag', rng: () => 0.5 });
  arsenal.setMods({ finiteMags: BR.finiteMags });
  arsenal.resetRound({ draw: false });
  arsenal.emptySlot(1);
  const kit = createRoyaleKit({ arsenal });
  kit.reset();
  return { arsenal, kit };
}
/** 무기 모듈을 dt초씩 n번 돌린다(꺼내기 끝내기 등) → 모든 이벤트 */
function run(arsenal, kit, input = {}, n = 8, dt = 0.25) {
  const evs = [];
  for (let i = 0; i < n; i++) {
    const wi = { fireDown: false, firePressed: false, zoomDown: false, reloadPressed: false, slot: null, wheel: 0, ...(i === 0 ? input : {}) };
    if (kit) kit.filterInput(wi);
    evs.push(...arsenal.update(dt, wi, { speed: 0, onGround: true }));
    if (kit) kit.afterUpdate();
  }
  return evs;
}
const gunDrop = (weaponId, o = {}) => ({ id: `g-${weaponId}-${Math.random()}`, weaponId, pos: [0, 0, 0], mag: getDef(weaponId).mag, reserve: 0, ...o });

describe('구급상자 채널링', () => {
  test('채널: 4초가 차야 한 번 끝나고, 취소하면 아무것도 쓰지 않는다', () => {
    const ch = createChannel();
    assert.equal(MEDKIT.ms, 4000);
    assert.equal(ch.step(1000), false);
    assert.equal(ch.start(), true);
    assert.equal(ch.start(), false);
    assert.equal(ch.step(3999), false);
    assert.ok(ch.progress > 0.99 && ch.progress < 1);
    assert.equal(ch.cancel(), true);
    assert.equal(ch.active, false);
    assert.equal(ch.progress, null);
    ch.start();
    assert.equal(ch.step(4000), true);
    assert.equal(ch.step(4000), false, '끝난 뒤에는 다시 끝나지 않는다');
  });

  test('사용 중 입력: 누르고 있는 사격·조준·재장전은 막고, 새 사격·교체는 취소로 받는다', () => {
    const a = channelInput({ fireDown: true, firePressed: false, zoomDown: true, zoomToggle: true, reloadPressed: true, slot: null, wheel: 0 });
    assert.equal(a.cancel, false);
    assert.deepEqual([a.wi.fireDown, a.wi.zoomDown, a.wi.zoomToggle, a.wi.reloadPressed], [false, false, false, false]);
    assert.equal(channelInput({ firePressed: true, fireDown: true }).cancel, true);
    assert.equal(channelInput({ slot: 3 }).cancel, true);
    assert.equal(channelInput({ wheel: -1 }).cancel, true);
  });

  test('내 구급상자: 취소하면 남고, 다 쓰면 40을 한 번만 회복한다', () => {
    const { arsenal, kit } = setup();
    assert.equal(kit.useMedkit(50), 'none');
    const r = kit.offer({ id: 'm', kind: 'medkit', pos: [0, 0, 0], n: 1 });
    assert.equal(r.ok, true);
    assert.equal(kit.medkits, 1);
    assert.equal(kit.useMedkit(100), 'full');
    assert.equal(kit.useMedkit(50), 'start');
    assert.equal(kit.channelling, true);
    // 사격을 새로 누르면 취소 → 구급상자는 그대로
    assert.equal(kit.filterInput({ fireDown: true, firePressed: true, zoomDown: false, reloadPressed: false, slot: null, wheel: 0 }).cancelled, true);
    assert.equal(kit.channelling, false);
    assert.equal(kit.medkits, 1);
    // E를 다시 눌러도 취소, 점프도 취소
    kit.useMedkit(50);
    assert.equal(kit.useMedkit(50), 'cancel');
    kit.useMedkit(50);
    assert.equal(kit.cancelHeal(), true);
    assert.equal(kit.medkits, 1);
    // 끝까지: 한 번 회복하고 하나를 쓴다
    kit.useMedkit(50);
    assert.equal(kit.stepHeal(2000), 0);
    assert.equal(kit.medkits, 1);
    assert.equal(kit.stepHeal(2000), MEDKIT.heal);
    assert.equal(kit.medkits, 0);
    assert.equal(kit.stepHeal(4000), 0);
    assert.equal(kit.channelling, false);
    // 사용 중에는 총이 나가지 않는다(누르고 있는 사격)
    kit.offer(gunDrop('ar_std'));
    run(arsenal, kit);
    kit.offer({ id: 'm2', kind: 'medkit', pos: [0, 0, 0], n: 1 });
    kit.useMedkit(50);
    const wi = { fireDown: true, firePressed: false, zoomDown: true, reloadPressed: false, slot: null, wheel: 0 };
    kit.filterInput(wi);
    assert.equal(arsenal.update(0.1, wi, { speed: 0, onGround: true }).filter((e) => e.type === 'fire').length, 0);
    assert.equal(kit.channelling, true);
  });

  test('봇 규칙: 보이는 적·맞은 직후에는 시작하지 않고, 사용 중 적이 보이면 취소, 사용 중에는 쏘지 않는다', () => {
    const base = { alive: true, hp: 40, medkits: 1, healHp: 60, targetId: null, hurt: false };
    assert.equal(botMayStartHeal(base), true);
    assert.equal(botMayStartHeal({ ...base, targetId: 'p1' }), false);
    assert.equal(botMayStartHeal({ ...base, hurt: true }), false);
    assert.equal(botMayStartHeal({ ...base, medkits: 0 }), false);
    assert.equal(botMayStartHeal({ ...base, hp: 80 }), false);
    assert.equal(botMustCancelHeal({ targetId: 'p1' }), true);
    assert.equal(botMustCancelHeal({ targetId: null, hurt: false }), false);
    const a = createArsenal({ primary: 'ar_std', rng: () => 0.5 });
    a.update(1, {}, {});
    const wi = botChannelInput({ fireDown: true, zoomDown: true, reloadPressed: true, slot: 2, wheel: 1 });
    assert.equal(a.update(0.1, wi, { speed: 0, onGround: true }).filter((e) => e.type === 'fire' || e.type === 'switch').length, 0);
  });

  test('봇 구급상자(br/solo.js): 적이 없을 때 시작 → 적이 보이면 취소(남음) → 다시 4초를 채우면 한 번 회복', () => {
    let simMs = 0;
    const heals = [];
    const world = {
      drops: [], setRoyale() {}, setRoyaleZone() {}, sound() {}, setHint() {},
      addDrop(o) { this.drops.push(o); return o; }, listDrops() { return this.drops; }, removeDrop() { return true; },
      on() { return () => {}; }
    };
    const bot = {
      id: 'b1', alive: true, hp: 40, body: { pos: [0, 0, 0] },
      arsenal: createArsenal({ primary: 'ar_std', rng: () => 0.5 }),
      brain: { targetId: null, setCarried() {} }
    };
    const match = { heal: (id, n) => { heals.push([id, n]); return []; }, claimHazard: () => [], removePlayer: () => [] };
    const royale = createRoyaleRun({
      ctx: {}, world, ui: null, data: getMap('harbortown'), opts: {}, me: { id: 'me', name: 'me' }, bots: [bot], match, seed: 3,
      apply() {}, nameOf: (id) => id, simMs: () => simMs, meAlive: () => true, myPos: () => [9999, 0, 9999], statsOf: () => ({ kills: 0, head: 0 })
    });
    royale.spawned(bot);
    bot.pack.addMedkit(1);
    royale.start();
    const tick = (ms) => { simMs += ms; royale.step(ms / 1000); };
    tick(100);
    assert.equal(royale.botBusy(bot), true, '적이 없고 체력이 낮으면 시작');
    bot.brain.targetId = 'me';
    tick(50);
    assert.equal(royale.botBusy(bot), false, '적이 보이면 취소');
    assert.equal(bot.pack.medkits, 1, '취소한 구급상자는 남는다');
    tick(100);
    assert.equal(royale.botBusy(bot), false, '적이 보이는 동안에는 시작하지 않는다');
    bot.brain.targetId = null;
    tick(100);
    assert.equal(royale.botBusy(bot), true);
    for (let i = 0; i < 45; i++) tick(100);
    assert.deepEqual(heals, [['b1', MEDKIT.heal]]);
    assert.equal(bot.pack.medkits, 0);
    assert.equal(royale.botBusy(bot), false);
    royale.dispose();
  });
});

describe('가방 등급 상한', () => {
  test('등급표: 없음 60/2/2 → 대형 240/7/5, 계열 배율(산탄 ½·저격탄 ¼)', () => {
    assert.deepEqual(PACK_TIERS.map((p) => [p.ammo, p.throws, p.medkits]), [[60, 2, 2], [120, 3, 3], [180, 5, 4], [240, 7, 5]]);
    assert.equal(ammoCap(0, 'rifle'), 60);
    assert.equal(ammoCap(3, 'shell'), 120);
    assert.equal(ammoCap(1, 'sniper'), 30);
    assert.equal(ammoFamily('ar_std'), 'rifle');
    assert.equal(ammoFamily('dm_mark'), 'rifle');
    assert.equal(ammoFamily('sm_vx3'), 'light');
    assert.equal(ammoFamily('pt_std'), 'light');
    assert.equal(ammoFamily('sg_pump'), 'shell');
    assert.equal(ammoFamily('sr_bolt'), 'sniper');
    assert.equal(ammoFamily('ml_knife'), null);
  });

  test('상한을 넘으면 들어가는 만큼만 받는다', () => {
    const p = createPack();
    assert.equal(p.addAmmo('rifle', 100), 60);
    assert.equal(p.addAmmo('rifle', 5), 0);
    assert.equal(p.addMedkit(3), 2);
    assert.equal(p.addThrow('gr_frag', 5), 2);
    assert.equal(p.addThrow('gr_frag', 1), 0);
    assert.equal(p.useAmmo('rifle', 70), 60);
  });

  test('줍기: 넘친 수량은 바닥에 남고(left), 계열 탄약은 가방 상한까지', () => {
    const { kit } = setup();
    let r = kit.offer({ id: 'm', kind: 'medkit', pos: [0, 0, 0], n: 3 });
    assert.equal(r.ok, true);
    assert.equal(r.left, 1);
    assert.equal(kit.medkits, 2);
    assert.equal(kit.offer({ id: 'm2', kind: 'medkit', pos: [0, 0, 0], n: 1 }, true).ok, false, '가득 차면 줍지 않는다');
    r = kit.offer({ id: 'a', kind: 'ammo', ref: 'rifle', pos: [0, 0, 0], n: 100 });
    assert.equal(r.left, 40);
    assert.equal(kit.pack.ammoOf('rifle'), 60);
    assert.equal(kit.pack.ammoOf('light'), START_LIGHT_AMMO);
    // 총에 딸린 예비 탄도 상한까지만, 넘친 탄은 탄약으로 떨어진다
    r = kit.offer(gunDrop('ar_std', { reserve: 30 }));
    assert.deepEqual(r.spawn, [{ kind: 'ammo', ref: 'rifle', n: 30 }]);
  });

  test('더 좋은 가방으로 바꾸면 옛 가방을 떨어뜨리고, 같거나 나쁜 가방은 줍지 않는다', () => {
    const { kit } = setup();
    let r = kit.offer({ id: 'p1', kind: 'backpack', ref: '1', pos: [0, 0, 0] });
    assert.equal(r.ok, true);
    assert.deepEqual(r.spawn, [], '가방 없음은 떨어뜨릴 것이 없다');
    assert.equal(kit.pack.tier, 1);
    assert.equal(kit.offer({ id: 'p1b', kind: 'backpack', ref: '1', pos: [0, 0, 0] }, true).ok, false);
    r = kit.offer({ id: 'p3', kind: 'backpack', ref: '3', pos: [0, 0, 0] });
    assert.deepEqual(r.spawn, [{ kind: 'backpack', ref: '1', n: 1 }]);
    assert.equal(kit.pack.tier, 3);
    assert.equal(kit.pack.medkitCap, 5);
    assert.equal(kit.pack.ammoCap('rifle'), 240);
    assert.equal(kit.offer({ id: 'p2', kind: 'backpack', ref: '2', pos: [0, 0, 0] }).ok, false);
  });

  test('탈락하면 총·부착물·탄약·투척·구급상자·가방을 모두 떨어뜨리고 비운다', () => {
    const { arsenal, kit } = setup();
    kit.offer(gunDrop('ar_std'));
    kit.offer({ id: 'o', kind: 'attach', ref: 'op_4x', pos: [0, 0, 0] });
    kit.offer({ id: 'p', kind: 'backpack', ref: '2', pos: [0, 0, 0] });
    kit.offer({ id: 'm', kind: 'medkit', pos: [0, 0, 0], n: 2 });
    kit.offer({ id: 't', kind: 'throw', ref: 'gr_frag', pos: [0, 0, 0], n: 1 });
    run(arsenal, kit);
    const items = kit.deathItems();
    const kinds = items.map((x) => x.weaponId || `${x.kind}:${x.ref || ''}`).sort();
    assert.deepEqual(kinds, ['ammo:light', 'ar_std', 'attach:op_4x', 'backpack:2', 'medkit:', 'pt_std', 'throw:gr_frag'].sort());
    assert.equal(kit.pack.tier, 0);
    assert.equal(kit.medkits, 0);
    assert.deepEqual(kit.guns, [null, null]);
  });
});

describe('부착물', () => {
  test('끼울 수 있는 총: 4배율은 소총·지정사수, 6배율은 저격총까지, 확장 탄창은 소총·기관단총·지정사수', () => {
    assert.equal(canAttach('op_4x', 'ar_std'), true);
    assert.equal(canAttach('op_4x', 'dm_mark'), true);
    assert.equal(canAttach('op_4x', 'sm_vx3'), false);
    assert.equal(canAttach('op_4x', 'sr_bolt'), false);
    assert.equal(canAttach('op_6x', 'sr_bolt'), true);
    assert.equal(canAttach('op_red', 'sg_pump'), true);
    assert.equal(canAttach('mg_ext', 'sm_vx3'), true);
    assert.equal(canAttach('mg_ext', 'sg_pump'), false);
    assert.equal(canAttach('gp_vert', 'sr_bolt'), false);
    assert.equal(canAttach('op_red', 'pt_std'), false, '권총에는 달지 않는다');
    assert.equal(canAttach('op_red', 'sm_uzi_dual'), false, '쌍권총은 자리가 없다');
  });

  test('교체 규칙: 빈 자리이거나 더 좋은 조준경일 때만, 손잡이끼리는 바꾸지 않는다', () => {
    assert.equal(isUpgrade('op_red', {}, 'ar_std'), true);
    assert.equal(isUpgrade('op_2x', { optic: 'op_red' }, 'ar_std'), true);
    assert.equal(isUpgrade('op_red', { optic: 'op_2x' }, 'ar_std'), false);
    assert.equal(isUpgrade('gp_angle', { grip: 'gp_vert' }, 'ar_std'), false);
    assert.equal(isUpgrade('op_4x', {}, 'sm_vx3'), false);
  });

  test('스탯: 확장 탄창 +50%, 수직 손잡이 세로 반동 −20%, 앵글 손잡이 가로 반동 −15%·빠른 조준, 소염기는 불꽃을 줄이고 조용하다', () => {
    const s = attachStats('ar_std', { mag: 'mg_ext', grip: 'gp_vert', muzzle: 'mz_hider' });
    assert.equal(s.mag, 1.5);
    assert.equal(s.recoilV, 0.8);
    assert.equal(s.recoilH, 1);
    assert.ok(s.flash < 1 && s.quiet);
    const g = attachStats('ar_std', { grip: 'gp_angle' });
    assert.equal(g.recoilH, 0.85);
    assert.ok(g.zoom.inTime < getDef('ar_std').zoom.inTime);
    // 부착물이 없으면 원래 조준 정의
    assert.equal(attachStats('ar_std', {}).zoom, undefined);
  });

  test('무기 모듈에 실제로 걸린다: 탄창 45발, 세로 반동 0.8배, 4배율 조준(스코프 오버레이·조준경 레티클)', () => {
    const plain = setup();
    plain.kit.offer(gunDrop('ar_std'));
    run(plain.arsenal, plain.kit);
    const kicked = (a, kit) => run(a, kit, { fireDown: true, firePressed: true }, 1, 0.01).find((e) => e.type === 'fire').kick;
    const k0 = kicked(plain.arsenal, plain.kit);

    const { arsenal, kit } = setup();
    kit.offer(gunDrop('ar_std'));
    run(arsenal, kit);
    let r = kit.offer({ id: 'x', kind: 'attach', ref: 'mg_ext', pos: [0, 0, 0] });
    assert.equal(r.ok, true);
    assert.equal(arsenal.getAmmo().magSize, 45);
    kit.offer({ id: 'v', kind: 'attach', ref: 'gp_vert', pos: [0, 0, 0] });
    const k1 = kicked(arsenal, kit);
    assert.ok(Math.abs(k1.pitch - k0.pitch * 0.8) < 1e-9, `${k1.pitch} vs ${k0.pitch}`);
    assert.ok(Math.abs(k1.yaw - k0.yaw) < 1e-9);

    r = kit.offer({ id: 'o', kind: 'attach', ref: 'op_red', pos: [0, 0, 0] });
    assert.equal(r.ok, true);
    r = kit.offer({ id: 'o4', kind: 'attach', ref: 'op_4x', pos: [0, 0, 0] });
    assert.deepEqual(r.spawn, [{ kind: 'attach', ref: 'op_red', n: 1 }], '빠진 조준경은 바닥에');
    run(arsenal, kit, {}, 4);
    const z = arsenal.getZoom(75);
    assert.equal(z.fov, 75, '조준 전에는 기본 FOV');
    run(arsenal, kit, { zoomDown: true }, 1, 0.01);
    for (let i = 0; i < 10; i++) arsenal.update(0.05, { zoomDown: true }, { speed: 0, onGround: true });
    const zz = arsenal.getZoom(75);
    assert.equal(zz.mag, 4);
    assert.equal(zz.overlay, 'scope');
    assert.equal(zz.reticle, 'optic');
    assert.ok(zz.fov < 30, `4배율 FOV ${zz.fov}`);
  });

  test('저격총은 6배율만 받아 기본 스코프 배율을 6으로 올린다', () => {
    const { arsenal, kit } = setup();
    kit.offer(gunDrop('sr_bolt'));
    run(arsenal, kit);
    assert.equal(kit.offer({ id: 'o4', kind: 'attach', ref: 'op_4x', pos: [0, 0, 0] }, true).ok, false);
    assert.equal(kit.offer({ id: 'o6', kind: 'attach', ref: 'op_6x', pos: [0, 0, 0] }).ok, true);
    for (let i = 0; i < 10; i++) arsenal.update(0.05, { zoomDown: true }, { speed: 0, onGround: true });
    const z = arsenal.getZoom(75);
    assert.equal(z.mag, 6);
    assert.equal(z.reticle, null, '저격총은 원래 저격 레티클');
  });
});

describe('주무기 두 자루', () => {
  test('아무 종류 두 자루: 첫 총은 손에, 둘째는 등에. 셋째는 줍지 않는다(G로 버리기 안내)', () => {
    const { arsenal, kit } = setup();
    assert.equal(kit.offer(gunDrop('sr_bolt')).ok, true);
    run(arsenal, kit);
    assert.equal(arsenal.getWeapon().id, 'sr_bolt');
    assert.equal(kit.offer(gunDrop('ar_std')).ok, true);
    run(arsenal, kit);
    assert.equal(arsenal.getWeapon().id, 'sr_bolt', '둘째 총은 바로 꺼내지 않는다');
    assert.deepEqual(kit.guns.map((g) => g && g.id), ['sr_bolt', 'ar_std']);
    const third = kit.offer(gunDrop('sm_vx3'), true);
    assert.equal(third.ok, false);
    assert.equal(third.hint, null);
    const h = kit.hud();
    assert.deepEqual(h.slots, ['sr_bolt', 'ar_std', 'pt_std', 'ml_knife', null]);
    assert.equal(h.slot, 1);
  });

  test('키 1·2로 바꿔 들고, 탄창 수는 총마다 따로 남는다. 예비 탄은 계열 공용', () => {
    const { arsenal, kit } = setup();
    kit.offer(gunDrop('ar_std', { mag: 30 }));
    kit.offer(gunDrop('ar_std', { mag: 7 }));
    kit.offer({ id: 'a', kind: 'ammo', ref: 'rifle', n: 50, pos: [0, 0, 0] });
    run(arsenal, kit);
    assert.equal(arsenal.getAmmo().mag, 30);
    assert.equal(arsenal.getAmmo().reserve, 50);
    run(arsenal, kit, { fireDown: true, firePressed: true }, 1, 0.05);
    const left = arsenal.getAmmo().mag;
    assert.ok(left < 30);
    run(arsenal, kit, { slot: 2 });
    assert.equal(kit.active, 1);
    assert.equal(arsenal.getWeapon().id, 'ar_std');
    assert.equal(arsenal.getAmmo().mag, 7);
    assert.equal(arsenal.getAmmo().reserve, 50, '같은 계열 예비 탄');
    run(arsenal, kit, { slot: 1 });
    assert.equal(kit.active, 0);
    assert.equal(arsenal.getAmmo().mag, left);
    // 재장전은 가방의 계열 탄을 쓴다
    run(arsenal, kit, { reloadPressed: true }, 16);
    assert.equal(arsenal.getAmmo().mag, 30);
    assert.equal(kit.pack.ammoOf('rifle'), 50 - (30 - left));
  });

  test('키 3 = 권총, 4 = 근접, 5 = 투척(누를 때마다 종류), 휠은 다섯 칸을 돈다', () => {
    const { arsenal, kit } = setup();
    kit.offer(gunDrop('ar_std'));
    run(arsenal, kit);
    run(arsenal, kit, { slot: 3 });
    assert.equal(arsenal.getWeapon().id, 'pt_std');
    assert.equal(kit.hud().slot, 3);
    run(arsenal, kit, { slot: 4 });
    assert.equal(arsenal.getWeapon().id, 'ml_knife');
    run(arsenal, kit, { slot: 5 });
    assert.equal(arsenal.getWeapon().id, 'ml_knife', '투척이 없으면 바뀌지 않는다');
    kit.offer({ id: 't', kind: 'throw', ref: 'gr_frag', n: 1, pos: [0, 0, 0] });
    run(arsenal, kit, { slot: 5 });
    assert.equal(arsenal.getWeapon().id, 'gr_frag');
    assert.equal(arsenal.getAmmo().mag, 1);
    run(arsenal, kit, { wheel: 1 });
    assert.equal(kit.hud().slot, 1, '휠: 5 다음은 1');
  });

  test('들고 있는 주무기를 버리면 부착물이 옆에 떨어지고 등의 총이 칸 1로 온다', () => {
    const { arsenal, kit } = setup();
    kit.offer(gunDrop('ar_std'));
    kit.offer(gunDrop('sm_vx3'));
    run(arsenal, kit);
    kit.offer({ id: 'o', kind: 'attach', ref: 'op_4x', pos: [0, 0, 0] });
    const r = kit.dropHeld();
    assert.equal(r.gun.id, 'ar_std');
    assert.equal(r.gun.reserve, 0, '예비 탄은 가방에 남는다');
    assert.deepEqual(r.items, [{ kind: 'attach', ref: 'op_4x', n: 1 }], '기관단총은 4배율을 못 단다');
    assert.deepEqual(kit.guns.map((g) => g && g.id), [null, 'sm_vx3']);
    assert.equal(arsenal.getLoadout().primary, 'sm_vx3');
    run(arsenal, kit, { slot: 2 });
    assert.equal(arsenal.getWeapon().id, 'sm_vx3');
  });

  test('다른 모드는 가방 없이 원래대로(칸 4개, 예비 탄은 총마다)', () => {
    const a = createArsenal({ primary: 'ar_std', rng: () => 0.5 });
    a.update(1, {}, {});
    assert.equal(a.getAmmo().reserve, getDef('ar_std').reserve);
    assert.equal(a.getHud(75).slots.length, 4);
    assert.equal(a.update(0.1, { slot: 5 }, {}).filter((e) => e.type === 'switch').length, 0);
  });
});

describe('보급품', () => {
  const pts = Array.from({ length: 600 }, (_, i) => ({ pos: [i, 0, 0], tier: i % 2 ? 'rare' : 'common' }));
  test('굴림: 가방·부착물·투척도 나오고, 이름(ref)이 맞다', () => {
    const items = rollLoot(9, pts);
    assert.deepEqual(items, rollLoot(9, pts));
    const kinds = new Set(items.map((x) => x.kind));
    for (const k of LOOT_KINDS) assert.ok(kinds.has(k), k);
    for (const it of items) {
      if (it.kind === 'backpack') assert.ok(['1', '2', '3'].includes(it.ref));
      if (it.kind === 'backpack' && it.tier === 'common') assert.notEqual(it.ref, '3', '대형 가방은 희귀 지점에만');
      if (it.kind === 'attach') assert.ok(supplyLabel({ kind: 'attach', ref: it.ref }));
      if (it.kind === 'throw') { assert.ok(getDef(it.ref)); assert.ok(it.n >= 1); }
    }
  });
  test('항목: 보급품은 ref·n을 지니고, 배틀로얄은 탄이 없는 총도 놓는다', () => {
    const d = createDrops({ now: () => 0, max: 50 });
    const a = d.add({ id: 'b', kind: 'backpack', ref: 2, pos: [0, 0, 0] }, { supply: true, ttl: Infinity }).drop;
    assert.equal(a.ref, '2');
    assert.equal(a.n, 0);
    assert.equal(d.add({ id: 'x', kind: 'attach', ref: 'op_6x', n: 1.7, pos: [0, 0, 0] }, { supply: true }).drop.n, 1);
    assert.equal(d.add({ id: 'e', weaponId: 'ar_std', pos: [0, 0, 0], mag: 0, reserve: 0 }).drop, null);
    assert.ok(d.add({ id: 'e2', weaponId: 'ar_std', pos: [0, 0, 0], mag: 0, reserve: 0 }, { supply: true }).drop);
  });
});
