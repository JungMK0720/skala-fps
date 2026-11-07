/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 봇 두뇌와 내비 그리드 시험. 실제 무기 상태 머신과 이동 물리로 칼전·스나전·모든 주무기를 시뮬레이션하고,
 *          규칙별 무기 뽑기와 발판 위 걷기 칸을 확인한다. three.js가 필요 없다.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { PLAYER, TICK_DT } from '../js/core/consts.js';
import { lineOfSight, moveCharacter } from '../js/engine/physics.js';
import { stepTriggers } from '../js/engine/triggers.js';
import { buildCollision } from '../js/maps/collision.js';
import { BOT_DIFFICULTY, BOT_WEAPON_INFO, botLoadout, botPickWeights, createBot, loadoutKey, pickBotWeapon } from '../js/game/bots.js';
import { RULESET_IDS, defaultPick, isWeaponAllowed, pickableWeapons, rulesetOf } from '../js/game/modes.js';
import { buildNavGrid } from '../js/game/navgrid.js';
import { MELEE_IDS, PRIMARY_IDS, SECONDARY_IDS, WEAPONS, WEAPON_IDS, getDef } from '../js/weapons/defs.js';
import { createArsenal } from '../js/weapons/logic.js';

/** 시험장: 가운데 긴 벽(남쪽이 트임), 낮은 벽, 상자. 맵 파일에 기대지 않으려고 여기 적는다 */
const ARENA = Object.freeze({
  id: 'bot-arena',
  size: { x: 80, z: 50 },
  theme: { ground: 'concrete', fog: [60, 240] },
  spawns: {
    owner: [{ x: -30, z: -10 }, { x: -30, z: -5 }, { x: -30, z: 5 }, { x: -30, z: 10 }],
    charterer: [{ x: 30, z: -10 }, { x: 30, z: -5 }, { x: 30, z: 5 }, { x: 30, z: 10 }]
  },
  solids: [
    { type: 'box', x: 0, y: 0, z: -5, w: 1, h: 5, d: 40, mat: 'concrete' },
    { type: 'box', x: -12, y: 0, z: 2, w: 0.6, h: 0.9, d: 10, mat: 'concrete' },
    { type: 'box', x: 12, y: 0, z: -8, w: 3, h: 2.4, d: 3, mat: 'concrete' }
  ]
});
const col = buildCollision(ARENA);
const nav = buildNavGrid(ARENA);
const los = (a, b) => lineOfSight(col.world, a, b);

function mulberry(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** practice.js의 봇 한 명과 같은 방식: 10 Hz로 판단하고 60 Hz로 움직인다 */
function makeRunner({ pick, ruleset = 'classic', difficulty = 'normal', start = [-30, -10], yaw = -Math.PI / 2, seed = 7, map = col, grid = nav, tuning }) {
  const rs = rulesetOf(ruleset);
  const rng = mulberry(seed);
  const gear = botLoadout(rs.id, pick, rng);
  const brain = createBot({ id: 'bot-under-test', mode: 'ffa', ruleset: rs.id, difficulty, primary: pick, secondary: gear.secondary, melee: gear.melee, seed, tuning });
  const arsenal = createArsenal({ ...gear, allowedSlots: rs.slots, stageCycle: false, zoomMode: 'hold', rng });
  const body = { pos: [start[0], 0, start[1]], vel: [0, 0, 0], onGround: true };
  const log = { slots: [], events: {}, firePulses: 0, doubleFire: 0, fires: [], maxLevel: 0, thinks: 0 };
  let cmd = {}, y = yaw, p = 0, rate = 0, pRate = 0, ticks = 0, acc = 0.1, edgeSlot = null, edgeReload = false, edgeJump = false, prevFire = false, time = 0, flying = false;
  const trig = {};
  return {
    brain, arsenal, body, log, gear,
    get yaw() { return y; },
    get pitch() { return p; },
    /** 한 틱. enemies = [{ id, pos, alive?, ... }] */
    tick(enemies) {
      const dt = TICK_DT;
      time += dt;
      acc += dt;
      if (acc >= 0.1 - 1e-6) {
        const tdt = Math.min(0.1, acc);
        acc = 0;
        cmd = brain.think(tdt, {
          self: {
            pos: body.pos, vel: body.vel, onGround: body.onGround, yaw: y, pitch: p, hp: 100, alive: true, crouch: false,
            slot: arsenal.getWeapon().slot, ammo: arsenal.getAmmo(), weapon: arsenal.getWeapon(), zoom: arsenal.getZoom().progress,
            recoil: arsenal.getRecoilKick(), grenades: arsenal.getAmmo('gr_frag').mag
          },
          enemies, allies: [], nav: grid, los
        });
        log.thinks++;
        const n = Math.max(1, Math.round(tdt / dt));
        rate = cmd.yawDelta / n; pRate = cmd.pitchDelta / n; ticks = n;
        if (cmd.slot) { edgeSlot = cmd.slot; log.slots.push(cmd.slot); }
        if (cmd.reload) edgeReload = true;
        if (cmd.jump) edgeJump = true;
        if (cmd.fire) { log.firePulses++; if (prevFire) log.doubleFire++; }
        prevFire = !!cmd.fire;
      }
      if (ticks > 0) { y += rate; p = Math.max(-1.5, Math.min(1.5, p + pRate)); ticks--; }
      const speed = (cmd.walk ? PLAYER.SLOW_WALK : PLAYER.WALK) * arsenal.getMoveMul();
      const sy = Math.sin(y), cy = Math.cos(y);
      let f = cmd.forward || 0, s = cmd.strafe || 0;
      const len = Math.hypot(f, s);
      if (len > 1) { f /= len; s /= len; }
      const wish = { x: (-sy * f + cy * s) * speed, z: (-cy * f - sy * s) * speed, jump: edgeJump && body.onGround };
      edgeJump = false;
      if (flying) { if (body.onGround) flying = false; else { wish.x = 0; wish.z = 0; } }
      moveCharacter(map.world, body, wish, dt);
      const fired = map.world.triggers ? stepTriggers(map.world, body, PLAYER.HEIGHT, trig, dt) : null;
      if (fired && fired.pad) {
        flying = !!fired.pad.target || Math.hypot(body.vel[0], body.vel[2]) > 1;   // practice.js와 같은 규칙
        brain.onLaunch();
        log.launched = (log.launched || 0) + 1;
      }
      const evs = arsenal.update(dt, { fireDown: !!cmd.fire, zoomDown: !!cmd.zoom, reloadPressed: edgeReload, slot: edgeSlot, wheel: 0 },
        { speed: Math.hypot(body.vel[0], body.vel[2]), onGround: body.onGround, walking: !!cmd.walk });
      edgeReload = false; edgeSlot = null;
      for (const ev of evs) {
        (log.events[ev.type] || (log.events[ev.type] = [])).push({ ...ev, at: time, pitch: p });
      }
      log.maxLevel = Math.max(log.maxLevel, arsenal.getZoom().level);
      return cmd;
    }
  };
}

const enemyAt = (x, z, extra) => ({ id: 'target', pos: [x, 0, z], alive: true, ...extra });
const count = (log, type) => (log.events[type] ? log.events[type].length : 0);
const horiz = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]);

describe('칼전 봇', () => {
  for (const melee of MELEE_IDS) {
    test(`${melee}: 벽을 돌아 다가가서 벤다`, () => {
      const target = enemyAt(30, -14);
      const r = makeRunner({ pick: melee, ruleset: 'knife', start: [-30, -14] });
      let closest = Infinity;
      for (let i = 0; i < 60 * 40 && !count(r.log, 'melee'); i++) {
        r.tick([target]);
        closest = Math.min(closest, horiz(r.body.pos, target.pos));
      }
      const def = getDef(melee);
      assert.ok(closest < def.melee.slash.range + 0.5, `가장 가까이 ${closest.toFixed(2)} m`);
      assert.ok(count(r.log, 'swing') > 0, '휘두르지 않았다');
      assert.ok(count(r.log, 'melee') > 0, '판정이 나오지 않았다');
      assert.equal(r.log.events.melee[0].weaponId, melee);
      assert.ok(r.brain.stats.swings > 0);
    });
  }

  test('총이나 수류탄으로 바꾸려 하지 않는다', () => {
    for (const difficulty of ['easy', 'normal', 'hard']) {
      const target = enemyAt(-20, -10);
      const r = makeRunner({ pick: 'ml_knife', ruleset: 'knife', difficulty, start: [-24, -10] });
      for (let i = 0; i < 60 * 25; i++) r.tick([target]);
      assert.deepEqual(r.log.slots.filter((s) => s !== 3), [], difficulty);
      assert.equal(r.arsenal.getWeapon().slot, 3);
      assert.equal(count(r.log, 'fire'), 0);
      assert.equal(count(r.log, 'throw'), 0);
    }
  });

  test('가까우면 좌우로 움직이고 가끔 강타를 쓴다', () => {
    const target = enemyAt(-20, 18);
    const r = makeRunner({ pick: 'ml_katana', ruleset: 'knife', difficulty: 'hard', start: [-22, 18], seed: 3 });
    let strafed = false;
    for (let i = 0; i < 60 * 30; i++) {
      const c = r.tick([target]);
      if (Math.abs(c.strafe || 0) > 0.2) strafed = true;
    }
    assert.ok(strafed, '옆걸음이 없다');
    assert.ok(r.brain.stats.heavies > 0, '강타가 없다');
    assert.ok(r.log.events.swing.some((e) => e.kind === 'stab'), '강타 이벤트가 없다');
    assert.ok(r.log.events.swing.some((e) => e.kind === 'slash'), '베기 이벤트가 없다');
  });

  test('낮은 벽 앞에서 막히면 뛴다', () => {
    const lowWall = {
      id: 'low-wall', size: { x: 40, z: 40 }, theme: { ground: 'concrete' },
      spawns: { owner: [{ x: -10, z: 0 }], charterer: [{ x: 10, z: 0 }] },
      // 양쪽 끝까지 막은 낮은 벽: 넘어가는 수밖에 없다
      solids: [{ type: 'box', x: 0, y: 0, z: 0, w: 0.6, h: 0.9, d: 40, mat: 'concrete' }]
    };
    const c = buildCollision(lowWall);
    const r = makeRunner({ pick: 'ml_knife', ruleset: 'knife', start: [-10, 0], map: c, grid: buildNavGrid(lowWall) });
    const target = enemyAt(10, 0);
    let jumped = false;
    for (let i = 0; i < 60 * 15 && r.body.pos[0] < 1; i++) {
      if (r.tick([target]).jump) jumped = true;
    }
    assert.ok(jumped, '뛰지 않았다');
    assert.ok(r.body.pos[0] > 1, `벽을 넘지 못했다 x=${r.body.pos[0].toFixed(2)}`);
  });

  test('보호 중인 적은 베지 않는다', () => {
    const target = enemyAt(-20, 18, { protect: true });
    const r = makeRunner({ pick: 'ml_katana', ruleset: 'knife', start: [-23, 18] });
    for (let i = 0; i < 60 * 6; i++) r.tick([target]);
    assert.equal(count(r.log, 'swing'), 0);
  });
});

describe('스나전 봇', () => {
  const snipers = pickableWeapons('sniper');

  test('슬롯 2·4를 고르지 않는다', () => {
    for (const pick of snipers) {
      for (const difficulty of ['easy', 'normal', 'hard']) {
        for (let seed = 1; seed <= 3; seed++) {
          const r = makeRunner({ pick, ruleset: 'sniper', difficulty, seed, start: [-30, 18] });
          // 코앞(예전이면 권총) → 멀리 → 벽 뒤로 사라짐(예전이면 수류탄)
          const script = [[-26, 18, 8], [0, 18, 10], [-14, -10, 8]];
          for (const [x, z, secs] of script) {
            const target = enemyAt(x, z);
            for (let i = 0; i < 60 * secs; i++) r.tick([target]);
          }
          assert.deepEqual(r.log.slots.filter((s) => s === 2 || s === 4), [], `${pick} ${difficulty}`);
          assert.equal(count(r.log, 'throw'), 0);
          assert.equal(r.brain.stats.grenades, 0);
        }
      }
    }
  });

  test('저격총으로 쏘고 볼트를 기다린다', () => {
    for (const pick of snipers) {
      const target = enemyAt(-5, 20);
      const r = makeRunner({ pick, ruleset: 'sniper', difficulty: 'hard', start: [-30, 18], seed: 5 });
      for (let i = 0; i < 60 * 20; i++) r.tick([target]);
      const shots = r.log.events.fire || [];
      assert.ok(shots.length >= 2, `${pick}: ${shots.length}발`);
      assert.ok(shots.every((e) => e.weaponId === pick));
      const def = getDef(pick);
      for (let i = 1; i < shots.length; i++) {
        // 빈 탄창에서는 재장전을 거치므로 볼트보다 항상 길다
        assert.ok(shots[i].at - shots[i - 1].at >= def.bolt - 1e-6, `${pick}: 간격 ${(shots[i].at - shots[i - 1].at).toFixed(2)}`);
      }
    }
  });

  test('다단 줌 저격총도 1단만 쓴다', () => {
    const target = enemyAt(-5, 20);
    const r = makeRunner({ pick: 'sr_twin', ruleset: 'sniper', difficulty: 'hard', start: [-30, 18] });
    for (let i = 0; i < 60 * 15; i++) r.tick([target]);
    assert.ok(count(r.log, 'fire') > 0);
    assert.equal(r.log.maxLevel, 1);
    assert.equal(r.arsenal.getZoom().levels, 2);
  });

  test('코앞에서 볼트 중이면 칼을 들 수 있다(슬롯 3은 허용)', () => {
    const target = enemyAt(-27, 18);
    const r = makeRunner({ pick: 'sr_bolt', ruleset: 'sniper', difficulty: 'hard', start: [-30, 18], seed: 2 });
    for (let i = 0; i < 60 * 12; i++) r.tick([target]);
    assert.ok(r.log.slots.includes(3), '칼로 바꾸지 않았다');
    assert.ok(count(r.log, 'swing') > 0, '휘두르지 않았다');
  });
});

describe('모든 주무기', () => {
  for (const id of PRIMARY_IDS) {
    test(`${id}: 예외 없이 싸운다`, () => {
      for (const difficulty of ['easy', 'normal', 'hard']) {
        let fired = 0;
        for (const dist of [6, 20, 48]) {
          const target = enemyAt(-30 + dist, 18);
          const r = makeRunner({ pick: id, ruleset: 'classic', difficulty, start: [-30, 18] });
          assert.equal(r.brain.primary, id);
          assert.equal(r.brain.role, getDef(id).kind);
          for (let i = 0; i < 60 * 40; i++) r.tick([target]);   // 판단 400번
          assert.ok(r.log.thinks >= 300);
          fired += count(r.log, 'fire');
          assert.equal(r.log.doubleFire && getDef(id).fire !== 'auto' ? r.log.doubleFire : 0, 0, `${id}: 눌림이 이어졌다`);
          // 쓴 무기는 전부 로드아웃 안의 것이다
          for (const ev of r.log.events.fire || []) assert.ok(Object.values(r.gear).includes(ev.weaponId), ev.weaponId);
        }
        assert.ok(fired > 0, `${id} ${difficulty}: 한 발도 쏘지 않았다`);
      }
    });
  }

  test('점사 총은 방아쇠 한 번에 점사 한 번이다', () => {
    const def = getDef('ar_burst');
    const target = enemyAt(-14, 18);
    const r = makeRunner({ pick: 'ar_burst', ruleset: 'classic', difficulty: 'hard', start: [-30, 18], seed: 4 });
    for (let i = 0; i < 60 * 15; i++) r.tick([target]);
    const shots = (r.log.events.fire || []).filter((e) => e.weaponId === 'ar_burst');
    assert.ok(shots.length >= def.burst.count * 2, `${shots.length}발`);
    assert.equal(r.log.doubleFire, 0, '방아쇠를 누른 채 있었다');
    // 점사 안 간격은 gap, 점사 사이는 쉬는 시간 이상이다
    let groups = 1, inGroup = 1;
    for (let i = 1; i < shots.length; i++) {
      const gap = shots[i].at - shots[i - 1].at;
      if (gap < def.burst.gap + 0.03) { inGroup++; assert.ok(inGroup <= def.burst.count, '한 번에 3발을 넘었다'); }
      else {
        assert.ok(gap >= def.fireInterval - 0.03, `쉬는 시간이 짧다 ${gap.toFixed(3)}`);
        groups++; inGroup = 1;
      }
    }
    assert.ok(groups >= 2);
    assert.ok(r.log.firePulses >= groups, `방아쇠 ${r.log.firePulses}번, 점사 ${groups}번`);
  });

  test('연사 총은 거리에 따라 끊어 쏜다', () => {
    const shotsPerBurst = (dist) => {
      const target = enemyAt(-30 + dist, 18);
      // 조준 허용치를 넓혀 점사가 조준 때문에 끊기지 않게 한다
      const r = makeRunner({ pick: 'ar_std', difficulty: 'hard', start: [-30, 18], seed: 9, tuning: { fireTol: 50 } });
      for (let i = 0; i < 60 * 10; i++) r.tick([target]);
      // 첫 탄창의 앞부분만 본다(뒤에는 재장전과 권총이 섞인다)
      const shots = (r.log.events.fire || []).filter((e) => e.weaponId === 'ar_std' && e.mag >= 10);
      assert.ok(shots.length > 10, `${dist} m: ${shots.length}발`);
      let bursts = 1;
      for (let i = 1; i < shots.length; i++) if (shots[i].at - shots[i - 1].at > 0.14) bursts++;
      return shots.length / bursts;
    };
    const near = shotsPerBurst(8), far = shotsPerBurst(45);
    assert.ok(near > far + 1, `가까울수록 길게 쏘지 않는다: ${near.toFixed(1)} vs ${far.toFixed(1)}`);
  });

  test('머리 전용 총은 머리를 더 자주 노린다', () => {
    // 사격 순간의 시선 높이로 잰다(몸통 조준 1.08 m, 머리 1.62 m)
    const headRate = (pick) => {
      let high = 0, total = 0;
      for (let seed = 1; seed <= 12; seed++) {
        const target = enemyAt(-14, 20);
        const r = makeRunner({ pick, difficulty: 'normal', start: [-30, 20], seed });
        for (let i = 0; i < 60 * 15; i++) r.tick([target]);
        for (const ev of r.log.events.fire || []) {
          total++;
          if (PLAYER.EYE + Math.tan(ev.pitch) * 16 > 1.38) high++;
        }
      }
      assert.ok(total > 50, `${pick}: ${total}발`);
      return high / total;
    };
    assert.ok(BOT_WEAPON_INFO.ar_line.headRatio >= 5 && BOT_WEAPON_INFO.ar_std.headRatio < 5);
    const line = headRate('ar_line'), std = headRate('ar_std');
    assert.ok(line > std + 0.1, `머리 조준 비율이 높지 않다: LN-3 ${line.toFixed(2)}, RX-4 ${std.toFixed(2)}`);
  });

  test('근거리 무기는 다가가고 지정사수는 거리를 둔다', () => {
    const closestTo = (pick) => {
      const target = enemyAt(15, 20);
      const r = makeRunner({ pick, difficulty: 'normal', start: [-30, 20] });
      let closest = Infinity;
      for (let i = 0; i < 60 * 25; i++) { r.tick([target]); closest = Math.min(closest, horiz(r.body.pos, target.pos)); }
      return closest;
    };
    assert.ok(closestTo('sg_bx12') <= 9, 'BX-12가 붙지 않았다');
    assert.ok(closestTo('sm_vx3') <= 16, 'VX-3이 붙지 않았다');
    assert.ok(closestTo('dm_mark') >= 30, 'DM-4가 너무 가까이 갔다');
  });

  test('샷건은 펠릿 수만큼 낸다', () => {
    const target = enemyAt(-24, 18);
    const r = makeRunner({ pick: 'sg_bx12', difficulty: 'hard', start: [-30, 18] });
    for (let i = 0; i < 60 * 6; i++) r.tick([target]);
    const shot = r.log.events.fire && r.log.events.fire[0];
    assert.ok(shot, '쏘지 않았다');
    assert.equal(shot.pellets.length, getDef('sg_bx12').pellets);
  });

  /** 무기를 든 상태를 직접 넣어 슬롯 선택만 본다 */
  const scriptedView = (slot, ammo, target) => ({
    self: { pos: [-30, 0, 18], vel: [0, 0, 0], yaw: -Math.PI / 2, pitch: 0, hp: 100, alive: true, slot, ammo: { ...ammo, reloading: false }, zoom: 0, grenades: 1 },
    enemies: [target], allies: [], nav, los
  });

  test('탄을 다 쓰면 칼로 싸운다', () => {
    const brain = createBot({ id: 'dry', mode: 'ffa', primary: 'sg_bx12', difficulty: 'hard', seed: 3 });
    const target = enemyAt(-20, 18);
    // 적이 보이도록 먼저 몇 번 판단한다
    for (let i = 0; i < 12; i++) brain.think(0.1, scriptedView(1, { mag: 0, reserve: 0 }, target));
    assert.equal(brain.debug().wantSlot, 2, '주무기가 바닥나면 권총');
    let out = null;
    for (let i = 0; i < 12; i++) out = brain.think(0.1, scriptedView(2, { mag: 0, reserve: 0 }, target));
    assert.equal(out.slot, 3, '권총도 바닥나면 칼');
    assert.equal(brain.debug().wantSlot, 3);
  });

  test('권총이 비었으면 주무기로 돌아가 재장전한다', () => {
    const brain = createBot({ id: 'dry2', mode: 'ffa', primary: 'sg_bx12', difficulty: 'hard', seed: 3 });
    const target = enemyAt(-20, 18);
    for (let i = 0; i < 12; i++) brain.think(0.1, scriptedView(1, { mag: 0, reserve: 24 }, target));
    assert.equal(brain.debug().wantSlot, 2, '주무기가 비었고 적이 가까우면 권총');
    let out = null;
    for (let i = 0; i < 12; i++) out = brain.think(0.1, scriptedView(2, { mag: 0, reserve: 36 }, target));
    assert.equal(out.slot, 1);
    let reload = false;
    for (let i = 0; i < 30; i++) reload = brain.think(0.1, scriptedView(1, { mag: 0, reserve: 24 }, target)).reload || reload;
    assert.equal(brain.debug().wantSlot, 1, '무기를 바꾸기만 되풀이한다');
    assert.ok(reload, '재장전하지 않았다');
  });

  test('권총을 든 동안 주무기로 되돌아가지 않는다', () => {
    const brain = createBot({ id: 'flip', mode: 'ffa', primary: 'ar_std', difficulty: 'hard', seed: 8 });
    const target = enemyAt(-22, 18);
    for (let i = 0; i < 12; i++) brain.think(0.1, scriptedView(1, { mag: 0, reserve: 60 }, target));
    const slots = [];
    for (let i = 0; i < 30; i++) {
      const out = brain.think(0.1, scriptedView(2, { mag: 10, reserve: 36 }, target));
      if (out.slot) slots.push(out.slot);
    }
    assert.deepEqual(slots, [], `무기를 바꿨다: ${slots}`);
  });

  test('클래식은 수류탄을 쓸 수 있다(스나전과 대조)', () => {
    let threw = 0;
    for (let seed = 1; seed <= 12 && !threw; seed++) {
      const r = makeRunner({ pick: 'ar_std', difficulty: 'hard', seed, start: [-30, -10] });
      let target = enemyAt(-14, -10);
      for (let i = 0; i < 60 * 3; i++) r.tick([target]);
      target = enemyAt(-14, 14);   // 멀리 사라진다: 이제 보이지 않지만 기억에는 있다
      for (let i = 0; i < 60 * 8; i++) r.tick([{ ...target, pos: [40, 0, 24] }]);
      threw += count(r.log, 'throw');
    }
    assert.ok(threw > 0, '한 번도 던지지 않았다');
  });
});

describe('무기 지정', () => {
  test('setLoadout과 respawn은 규칙이 허용한 무기만 받는다', () => {
    const sniper = createBot({ id: 's', mode: 'ffa', ruleset: 'sniper', primary: 'sr_bolt' });
    assert.equal(sniper.setLoadout('ar_std'), false);
    assert.equal(sniper.setLoadout('sr_heavy'), true);
    sniper.respawn({ x: 0, y: 0, z: 0 });
    assert.equal(sniper.primary, 'sr_heavy');
    sniper.respawn({ x: 0, y: 0, z: 0, loadout: 'pt_std' });
    assert.equal(sniper.primary, 'sr_heavy');
    sniper.respawn({ spawn: { x: 1, z: 1 }, loadout: 'sr_swift' });
    assert.equal(sniper.primary, 'sr_swift');

    const knife = createBot({ id: 'k', mode: 'ffa', ruleset: 'knife' });
    assert.equal(knife.primary, defaultPick('knife'));
    assert.equal(knife.role, 'melee');
    knife.respawn({ x: 0, y: 0, z: 0, loadout: 'ml_knife' });
    assert.equal(knife.primary, 'ml_knife');
    knife.respawn({ x: 0, y: 0, z: 0, loadout: 'ar_std' });
    assert.equal(knife.primary, 'ml_knife');

    const classic = createBot({ id: 'c', mode: 'ffa' });
    assert.equal(classic.primary, 'ar_std');
    for (const id of PRIMARY_IDS) {
      classic.respawn({ x: 0, y: 0, z: 0, loadout: id });
      assert.equal(classic.primary, id);
      assert.equal(classic.role, getDef(id).kind);
    }
  });

  test('createBot은 규칙에 맞지 않는 무기를 무시한다', () => {
    assert.equal(createBot({ id: 'a', ruleset: 'knife', primary: 'ar_std' }).primary, defaultPick('knife'));
    assert.equal(createBot({ id: 'b', ruleset: 'sniper', primary: 'ar_std' }).primary, defaultPick('sniper'));
    assert.equal(createBot({ id: 'c', primary: 'no_such_gun' }).primary, 'ar_std');
    assert.equal(createBot({ id: 'd', primary: 'gr_frag' }).primary, 'ar_std');
  });

  test('시험용으로 보조 무기나 칼을 평소 무기로 줄 수 있다', () => {
    const target = enemyAt(-24, 18);
    const pistol = makeRunner({ pick: 'pt_magnum', difficulty: 'hard', start: [-30, 18] });
    assert.equal(pistol.gear.secondary, 'pt_magnum');
    for (let i = 0; i < 60 * 8; i++) pistol.tick([target]);
    assert.ok((pistol.log.events.fire || []).some((e) => e.weaponId === 'pt_magnum'), '매그넘을 쏘지 않았다');
    const blade = makeRunner({ pick: 'ml_knife', ruleset: 'classic', difficulty: 'hard', start: [-30, 18] });
    assert.equal(blade.gear.melee, 'ml_knife');
    for (let i = 0; i < 60 * 8; i++) blade.tick([target]);
    assert.ok(count(blade.log, 'swing') > 0, '칼을 휘두르지 않았다');
    assert.equal(count(blade.log, 'fire'), 0);
  });

  test('죽어 있는 동안과 입력이 없는 뷰에서도 예외가 없다', () => {
    for (const ruleset of RULESET_IDS) {
      const b = createBot({ id: 'x', ruleset });
      assert.equal(b.think(0.1, { self: { alive: false } }).fire, false);
      b.think(0.1, { self: { pos: [0, 0, 0], yaw: 0, pitch: 0, hp: 100 } });
      b.think(0.1, {});
      b.think(0.1, undefined);
      b.hearShot([1, 0, 1], { id: 'y' });
      b.onDamage({ from: [1, 0, 1], amount: 10 });
      b.onLaunch();
      assert.equal(typeof b.debug().weapon, 'string');
      b.dispose();
    }
  });
});

describe('무기 정보', () => {
  test('BOT_WEAPON_INFO는 defs에서 만든다', () => {
    assert.deepEqual(Object.keys(BOT_WEAPON_INFO).sort(), [...WEAPON_IDS].sort());
    for (const id of WEAPON_IDS) {
      const d = WEAPONS[id], w = BOT_WEAPON_INFO[id];
      assert.equal(w.slot, d.slot, id);
      assert.equal(w.kind, d.kind, id);
      assert.equal(w.fire, d.fire, id);
      assert.equal(w.draw, d.drawTime, id);
      if (d.melee) {
        assert.equal(w.range, d.melee.slash.range, id);
        assert.equal(w.interval, d.melee.slash.cooldown, id);
        assert.equal(w.heavyRange, d.melee.stab.range, id);
      } else if (d.mag != null) {
        assert.equal(w.mag, d.mag, id);
        assert.equal(w.reload, d.reload, id);
        assert.equal(w.interval, d.fireInterval, id);
        assert.equal(w.bolt, d.bolt ?? 0, id);
        assert.equal(w.pellets, d.pellets, id);
      }
    }
    assert.equal(BOT_WEAPON_INFO.gr_frag.speed, WEAPONS.gr_frag.throw.speed);
    assert.equal(BOT_WEAPON_INFO.gr_frag.prime, WEAPONS.gr_frag.primeTime);
  });

  test('createBot({ weaponInfo })로 덮어쓸 수 있다', () => {
    const target = enemyAt(-5, 20);
    const r = makeRunner({ pick: 'sr_bolt', ruleset: 'sniper', difficulty: 'hard', start: [-30, 18] });
    const b = createBot({ id: 'w', mode: 'ffa', ruleset: 'sniper', primary: 'sr_bolt', weaponInfo: { sr_bolt: { bolt: 0.2 } } });
    assert.equal(b.primary, 'sr_bolt');
    for (let i = 0; i < 60 * 3; i++) r.tick([target]);
    assert.equal(Object.isFrozen(BOT_WEAPON_INFO.sr_bolt), true);
    assert.equal(BOT_WEAPON_INFO.sr_bolt.bolt, WEAPONS.sr_bolt.bolt);
  });

  test('난이도 표의 기본 값은 그대로다', () => {
    assert.equal(BOT_DIFFICULTY.easy.reaction, 0.6);
    assert.equal(BOT_DIFFICULTY.normal.reaction, 0.38);
    assert.equal(BOT_DIFFICULTY.hard.reaction, 0.22);
    assert.deepEqual([BOT_DIFFICULTY.easy.grenade, BOT_DIFFICULTY.normal.grenade, BOT_DIFFICULTY.hard.grenade], [0, 0.3, 0.5]);
    assert.deepEqual([BOT_DIFFICULTY.easy.headAim, BOT_DIFFICULTY.normal.headAim, BOT_DIFFICULTY.hard.headAim], [0, 0.06, 0.32]);
  });
});

describe('봇 무기 뽑기', () => {
  const drawMany = (ruleset, n = 20000) => {
    const rng = mulberry(1234);
    const seen = new Map();
    for (let i = 0; i < n; i++) {
      const id = pickBotWeapon(ruleset, rng);
      seen.set(id, (seen.get(id) || 0) + 1);
    }
    return seen;
  };

  for (const ruleset of RULESET_IDS) {
    test(`${ruleset}: 쓸 수 있는 무기만 나온다`, () => {
      const seen = drawMany(ruleset);
      const allowed = pickableWeapons(ruleset);
      for (const id of seen.keys()) {
        assert.ok(allowed.includes(id), id);
        assert.ok(isWeaponAllowed(ruleset, id), id);
      }
      assert.deepEqual([...seen.keys()].sort(), [...allowed].sort(), '안 나온 무기가 있다');
      const table = botPickWeights(ruleset);
      assert.deepEqual(table.map((r) => r.id), allowed);
      assert.ok(Math.abs(table.reduce((a, r) => a + r.weight, 0) - 1) < 1e-9);
      assert.ok(table.every((r) => r.weight > 0));
    });
  }

  test('클래식: 대부분 기본 소총, 저격 25 %, 나머지도 조금씩', () => {
    const n = 40000;
    const seen = drawMany('classic', n);
    const share = (id) => (seen.get(id) || 0) / n;
    assert.ok(share('ar_std') > 0.35 && share('ar_std') < 0.45, `RX-4 ${share('ar_std')}`);
    const snipers = pickableWeapons('sniper').reduce((a, id) => a + share(id), 0);
    assert.ok(Math.abs(snipers - 0.25) < 0.02, `저격 ${snipers}`);
    for (const id of PRIMARY_IDS) assert.ok(share(id) > 0.01, `${id} ${share(id)}`);
    assert.equal(Math.max(...PRIMARY_IDS.map(share)), share('ar_std'));
  });

  test('스나전은 모두 저격총, 칼전은 나이프와 카타나', () => {
    assert.ok([...drawMany('sniper').keys()].every((id) => getDef(id).kind === 'sniper'));
    assert.deepEqual([...drawMany('knife').keys()].sort(), [...MELEE_IDS].sort());
  });

  test('botWeapon 지정: 쓸 수 있는 무기면 그대로, 아니면 확률표', () => {
    const rng = mulberry(5);
    for (const id of PRIMARY_IDS) assert.equal(pickBotWeapon('classic', rng, id), id);
    assert.equal(pickBotWeapon('classic', rng, 'pt_magnum'), 'pt_magnum');
    assert.equal(pickBotWeapon('knife', rng, 'ml_knife'), 'ml_knife');
    assert.ok(pickableWeapons('knife').includes(pickBotWeapon('knife', rng, 'ar_std')));
    assert.ok(pickableWeapons('sniper').includes(pickBotWeapon('sniper', rng, 'ar_std')));
    assert.ok(pickableWeapons('classic').includes(pickBotWeapon('classic', rng, 'mix')));
    assert.ok(pickableWeapons('classic').includes(pickBotWeapon('classic', rng, 'gr_frag')));
    assert.ok(pickableWeapons('classic').includes(pickBotWeapon('classic', rng, 'nope')));
  });

  test('botLoadout: 고른 무기가 제자리에 들어간다', () => {
    const rng = mulberry(99);
    for (const ruleset of RULESET_IDS) {
      for (const pick of pickableWeapons(ruleset)) {
        const lo = botLoadout(ruleset, pick, rng);
        assert.equal(lo[loadoutKey(pick)], pick);
        assert.ok(PRIMARY_IDS.includes(lo.primary));
        assert.ok(SECONDARY_IDS.includes(lo.secondary));
        assert.ok(MELEE_IDS.includes(lo.melee));
        const a = createArsenal({ ...lo, allowedSlots: rulesetOf(ruleset).slots, stageCycle: false });
        assert.equal(a.getWeapon().id, pick);
      }
    }
    assert.equal(loadoutKey('gr_frag'), null);
    assert.equal(loadoutKey('nope'), null);
  });
});

describe('내비 그리드', () => {
  const PADS = {
    id: 'pad-yard', size: { x: 60, z: 40 }, theme: { ground: 'concrete' },
    spawns: { owner: [{ x: -20, z: 0 }], charterer: [{ x: 20, z: 0 }] },
    solids: [
      // 벽으로 둘러싸인 높은 지붕: 걸어서는 못 올라간다
      { type: 'box', x: 10, y: 0, z: 10, w: 8, h: 6, d: 8, mat: 'concrete' },
      // 단 위의 발판
      { type: 'box', x: -10, y: 0, z: -10, w: 6, h: 1, d: 6, mat: 'concrete' }
    ],
    pads: [
      { x: 0, y: 0, z: 10, w: 2.4, d: 2.4, target: [10, 6, 10], apex: 2 },
      { x: -10, y: 1, z: -10, w: 2, d: 2, vel: [0, 7, 0] }
    ]
  };

  test('발판 위도 걷기 칸이다', () => {
    const g = buildNavGrid(PADS);
    assert.ok(g.isWalkable({ x: 0, y: 0, z: 10 }), '바닥 위 발판');
    assert.ok(g.isWalkable({ x: -10, y: 1, z: -10 }), '단 위 발판');
    assert.ok(g.findPath({ x: -20, y: 0, z: 10 }, { x: 0, y: 0, z: 10 }), '발판까지 가는 경로');
    // 발판 없는 같은 맵과 걷기 칸이 같다
    const plain = buildNavGrid({ ...PADS, pads: [] });
    assert.deepEqual([...g.debug().y], [...plain.debug().y]);
    assert.deepEqual([...g.debug().good], [...plain.debug().good]);
  });

  test('지붕에 내려도 경로로 돌아온다', () => {
    const g = buildNavGrid(PADS);
    const roof = { x: 10, y: 6, z: 10 }, ground = { x: -20, y: 0, z: 0 };
    assert.equal(g.node(g.nodeAt(roof)).good, false, '지붕은 걸어서 못 간다');
    const path = g.findPath(roof, ground);
    assert.ok(path && path.length, '내려오는 경로가 없다');
    assert.ok(path.some((p) => p.drop), '뛰어내리는 경유점이 없다');
    // 바닥에서 지붕으로 올라가는 경로는 여전히 없다(발판 경로는 계획하지 않는다)
    assert.equal(g.findPath(ground, roof).at(-1).y, 0);
    assert.ok(g.info.escapeEdges > 0);
  });

  test('난간이 둘러싼 높은 층에서도 내려오는 경로가 있다', () => {
    const data = {
      id: 'railed', size: { x: 40, z: 40 }, theme: { ground: 'concrete' },
      spawns: { owner: [{ x: -15, z: 0 }], charterer: [{ x: 15, z: 0 }] },
      solids: [
        { type: 'cyl', x: 0, y: 0, z: 0, r: 0.5, h: 12, mat: 'steel' },
        { type: 'box', x: 0, y: 12, z: 0, w: 6.4, h: 0.3, d: 6.4, mat: 'steel' },
        // 걸어서 넘을 수 있는 낮은 난간
        { type: 'box', x: 0, y: 12.3, z: -3.1, w: 6.4, h: 0.35, d: 0.2, mat: 'steel' },
        { type: 'box', x: 0, y: 12.3, z: 3.1, w: 6.4, h: 0.35, d: 0.2, mat: 'steel' },
        { type: 'box', x: -3.1, y: 12.3, z: 0, w: 0.2, h: 0.35, d: 6.4, mat: 'steel' },
        { type: 'box', x: 3.1, y: 12.3, z: 0, w: 0.2, h: 0.35, d: 6.4, mat: 'steel' }
      ]
    };
    const g = buildNavGrid(data);
    const c = buildCollision(data);
    const top = { x: 1.5, y: 12.3, z: 0.5 };
    assert.equal(g.node(g.nodeAt(top)).good, false);
    const path = g.findPath(top, { x: -15, y: 0, z: 0 });
    assert.ok(path && path.some((p) => p.drop), '내려오는 경로가 없다');
    // 실제 몸으로 따라가 본다
    const body = { pos: [top.x, top.y, top.z], vel: [0, 0, 0], onGround: true };
    const r = makeRunner({ pick: 'ml_knife', ruleset: 'knife', start: [top.x, top.z], map: c, grid: g });
    r.body.pos[1] = top.y;
    const target = enemyAt(-15, 0);
    for (let i = 0; i < 60 * 10 && r.body.pos[1] > 0.1; i++) r.tick([target]);
    assert.ok(body && r.body.pos[1] < 0.1, `내려오지 못했다 y=${r.body.pos[1].toFixed(2)}`);
  });

  test('경로가 없는 적은 건너뛰고 다음 적을 찾는다', () => {
    const data = {
      id: 'two-floors', size: { x: 40, z: 40 }, theme: { ground: 'concrete' },
      spawns: { owner: [{ x: -15, z: 0 }], charterer: [{ x: 15, z: 0 }] },
      // 사방이 막힌 높은 방(들어갈 길이 없다)
      solids: [{ type: 'box', x: 12, y: 0, z: 12, w: 8, h: 6, d: 8, mat: 'concrete' }]
    };
    const g = buildNavGrid(data);
    const c = buildCollision(data);
    const r = makeRunner({ pick: 'ml_knife', ruleset: 'knife', start: [-15, 0], map: c, grid: g });
    const onRoof = { id: 'roof', pos: [12, 6, 12], alive: true };
    const reachable = { id: 'ground', pos: [15, 0, -12], alive: true };
    let closest = Infinity;
    for (let i = 0; i < 60 * 15; i++) { r.tick([onRoof, reachable]); closest = Math.min(closest, horiz(r.body.pos, reachable.pos)); }
    assert.ok(closest < 3, `닿을 수 있는 적에게 가지 않았다 ${closest.toFixed(1)} m`);
    // 아무에게도 갈 수 없으면 제자리에 서 있지 않고 돌아다닌다
    const alone = makeRunner({ pick: 'ml_knife', ruleset: 'knife', start: [-15, 0], map: c, grid: g });
    const from = alone.body.pos.slice();
    let far = 0;
    for (let i = 0; i < 60 * 15; i++) { alone.tick([onRoof]); far = Math.max(far, horiz(alone.body.pos, from)); }
    assert.ok(far > 5, `제자리에 있다 ${far.toFixed(1)} m`);
  });

  test('제자리 발판에 올라서도 계속 튀지 않고 벗어난다', () => {
    const c = buildCollision(PADS);
    const g = buildNavGrid(PADS);
    for (const [ruleset, pick] of [['knife', 'ml_knife'], ['classic', 'ar_std'], ['sniper', 'sr_bolt']]) {
      const r = makeRunner({ pick, ruleset, start: [-10, -10], map: c, grid: g });
      r.body.pos[1] = 1;
      const target = enemyAt(25, 15);
      for (let i = 0; i < 60 * 12; i++) r.tick([target]);
      assert.ok(r.log.launched >= 1, `${ruleset}: 발판이 발동하지 않았다`);
      assert.ok(r.log.launched <= 3, `${ruleset}: 발판에서 ${r.log.launched}번 튀었다`);
      assert.ok(Math.hypot(r.body.pos[0] + 10, r.body.pos[2] + 10) > 3, `${ruleset}: 발판을 벗어나지 못했다`);
    }
  });

  test('경로가 없는 곳에 갇혀도 서 있지 않는다', () => {
    const data = {
      id: 'closed-room', size: { x: 60, z: 40 }, theme: { ground: 'concrete' },
      spawns: { owner: [{ x: -25, z: 0 }], charterer: [{ x: 25, z: 0 }] },
      solids: [
        { type: 'box', x: 0, y: 0, z: -5, w: 12, h: 6, d: 0.4, mat: 'concrete' },
        { type: 'box', x: 0, y: 0, z: 5, w: 12, h: 6, d: 0.4, mat: 'concrete' },
        { type: 'box', x: -6, y: 0, z: 0, w: 0.4, h: 6, d: 10, mat: 'concrete' },
        { type: 'box', x: 6, y: 0, z: 0, w: 0.4, h: 6, d: 10, mat: 'concrete' }
      ]
    };
    const g = buildNavGrid(data);
    const c = buildCollision(data);
    for (const [ruleset, pick] of [['knife', 'ml_knife'], ['classic', 'ar_std'], ['sniper', 'sr_bolt']]) {
      const r = makeRunner({ pick, ruleset, start: [0, 0], map: c, grid: g });
      const target = enemyAt(-25, 15);
      let moved = 0, stopped = 0, longestStop = 0;
      let last = r.body.pos.slice();
      for (let i = 0; i < 60 * 20; i++) {
        r.tick([target]);
        const d = Math.hypot(r.body.pos[0] - last[0], r.body.pos[2] - last[2]);
        moved += d;
        last = r.body.pos.slice();
        stopped = d < 1e-3 ? stopped + 1 : 0;
        longestStop = Math.max(longestStop, stopped);
      }
      assert.ok(r.brain.stats.pathFails > 0, `${ruleset}: 경로 실패가 없었다`);
      assert.ok(moved > 10, `${ruleset}: ${moved.toFixed(1)} m만 움직였다`);
      assert.ok(longestStop < 60 * 8, `${ruleset}: ${(longestStop / 60).toFixed(1)}초 동안 서 있었다`);
    }
  });

  test('봇이 발판을 타고 지붕에 내렸다가 돌아온다', () => {
    const c = buildCollision(PADS);
    const g = buildNavGrid(PADS);
    const r = makeRunner({ pick: 'ml_knife', ruleset: 'knife', start: [0, 10], yaw: 0, map: c, grid: g });
    const target = enemyAt(-25, -15);
    let top = 0, landedHigh = false;
    for (let i = 0; i < 60 * 25 && !(landedHigh && r.body.pos[1] < 0.1); i++) {
      r.tick([target]);
      top = Math.max(top, r.body.pos[1]);
      if (r.body.onGround && r.body.pos[1] > 5) landedHigh = true;
    }
    assert.ok(r.log.launched >= 1, '발판이 발동하지 않았다');
    assert.ok(top > 5, `지붕까지 못 갔다 ${top.toFixed(2)}`);
    assert.ok(landedHigh, '지붕에 내리지 못했다');
    assert.ok(r.body.pos[1] < 0.1, `내려오지 못했다 y=${r.body.pos[1].toFixed(2)}`);
  });

  test('충돌체 해석은 buildCollision과 같다', () => {
    const data = {
      id: 'parse', size: { x: 40, z: 40 }, theme: { ground: 'concrete' },
      spawns: { owner: [{ x: -15, z: 0 }], charterer: [{ x: 15, z: 0 }] },
      solids: [
        { type: 'box', x: 0, y: 0, z: 0, w: 1, h: 1.1, d: 40, mat: 'clip' },
        { type: 'box', x: 8, y: -1, z: 8, w: 6, h: 1, d: 6, mat: 'water' },
        { type: 'cyl', x: -8, y: 0, z: -8, r: 2, h: 3, mat: 'tank' },
        { type: 'ramp', x: -8, y: 0, z: 10, w: 6, h: 2, d: 4, dir: '+x', mat: 'steel' },
        { type: 'box', x: 1, y: 0, z: 1, w: 0, h: 1, d: 1 },
        null
      ]
    };
    const g = buildNavGrid(data);
    assert.equal(g.info.solids, buildCollision(data).solidColliders.length);
    assert.equal(g.info.holes, buildCollision(data).holes.length);
    assert.equal(g.raycast({ x: -5, y: 1, z: 0 }, { x: 5, y: 1, z: 0 }), true, 'clip은 시야를 막지 않는다');
    assert.equal(g.walkStraight({ x: -5, y: 0, z: 0 }, { x: 5, y: 0, z: 0 }), false, 'clip은 걷기를 막는다');
    assert.equal(g.isWalkable({ x: 8, y: 0, z: 8 }), false, '구멍(물) 위는 걸을 수 없다');
    assert.deepEqual(g.bounds, buildCollision(data).bounds);
    assert.ok(buildNavGrid(data, { ignoreMats: ['clip'] }).walkStraight({ x: -5, y: 0, z: 0 }, { x: 5, y: 0, z: 0 }), 'ignoreMats는 맵에 적힌 이름으로 고른다');
  });
});
