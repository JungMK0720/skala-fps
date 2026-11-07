/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 플레이어 이동(moveQuake)을 고정 틱으로 시뮬레이션해 조작감 수치를 검증하고,
 *          player.js의 점프·앉기·이모트·발판·포털 규칙과 input.js의 KeyF·잠금 해제 동작을 확인한다.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { PLAYER, MOVE } from '../js/core/consts.js';
import { createBus } from '../js/core/bus.js';
import { createWorld, makeBox, moveCharacter, solidToCollider } from '../js/engine/physics.js';
import { moveQuake, resetMoveMemory } from '../js/engine/movement.js';
import { buildTriggers } from '../js/engine/triggers.js';
import { createLocalPlayer } from '../js/engine/player.js';

const DT = 1 / 60;
const WALK = PLAYER.WALK;
const rad = (deg) => (deg * Math.PI) / 180;
const hs = (b) => Math.hypot(b.vel[0], b.vel[2]);
const floorBox = () => makeBox(-3000, -1, -3000, 3000, 0, 3000);
const flatWorld = (...extra) => createWorld([floorBox(), ...extra]);
const newBody = (vel = [0, 0, 0], pos = [0, 0, 0], onGround = true) => ({ pos: [...pos], vel: [...vel], onGround });

/** player.js와 같은 식: yaw + 키(f = W−S, s = D−A) → wish */
function keys(yaw, { f = 0, s = 0, jump = false, speed = WALK } = {}) {
  const len = Math.hypot(f, s) || 1;
  const nf = f / len, ns = s / len;
  const sy = Math.sin(yaw), cy = Math.cos(yaw);
  return { dirX: -sy * nf + cy * ns, dirZ: -cy * nf - sy * ns, speed, jump, strafeSign: Math.sign(s) };
}

/** yaw = 0(-Z 방향)으로 W를 누른 wish */
const forward = (over) => keys(0, { f: 1, ...over });
const noKeys = (over) => keys(0, over);

/** body를 땅에서 띄웠다가 착지 틱까지 진행한다(마지막 ev 반환). wish의 jump는 첫 틱에만 켠다 */
function hopOnce(world, body, wishFn) {
  moveQuake(world, body, wishFn(true), DT);
  for (let i = 0; i < 200; i++) {
    const ev = moveQuake(world, body, wishFn(false), DT);
    if (body.onGround) return ev;
  }
  throw new Error('착지하지 못했다');
}

describe('지면', () => {
  test('정지에서 5.2 m/s까지 0.15초 이내, 예전처럼 약 0.1초', () => {
    const world = flatWorld(), b = newBody();
    let t = 0;
    while (hs(b) < WALK - 1e-6 && t < 1) { moveQuake(world, b, forward(), DT); t += DT; }
    assert.ok(t <= 0.15 + 1e-9, `걸린 시간 ${t.toFixed(3)}초`);
    assert.ok(t <= 0.1 + 1e-9, `예전 60 m/s²(6틱)보다 굼뜨면 안 된다: ${t.toFixed(3)}초`);
    for (let i = 0; i < 60; i++) {
      moveQuake(world, b, forward(), DT);
      assert.ok(Math.abs(hs(b) - WALK) < 1e-6, '달리는 동안 목표 속도를 유지한다');
    }
  });

  test('5.2 m/s에서 입력 없이 0.2초 이내에 멈춘다', () => {
    const world = flatWorld(), b = newBody([0, 0, -WALK]);
    let t = 0;
    while (hs(b) > 0 && t < 1) { moveQuake(world, b, noKeys(), DT); t += DT; }
    assert.equal(hs(b), 0);
    assert.ok(t <= 0.2 + 1e-9, `걸린 시간 ${t.toFixed(3)}초`);
  });

  test('느린 목표 속도(앉기·천천히 걷기·줌)도 묶이지 않고 같은 시간에 붙고 넘지 않는다', () => {
    for (const speed of [0.6, 1.2, PLAYER.SLOW_WALK, PLAYER.CROUCH_SPEED, WALK * 1.1]) {
      const world = flatWorld(), b = newBody();
      let t = 0;
      while (hs(b) < speed - 1e-6 && t < 1) { moveQuake(world, b, forward({ speed }), DT); t += DT; }
      assert.ok(t <= 0.15 + 1e-9, `목표 ${speed} m/s: ${t.toFixed(3)}초`);
      for (let i = 0; i < 30; i++) {
        moveQuake(world, b, forward({ speed }), DT);
        assert.ok(hs(b) <= speed + 1e-6, `목표 ${speed} m/s를 넘었다: ${hs(b)}`);
      }
    }
  });

  test('땅에서 방향을 돌려도 걷기 속도를 넘지 않고(지면 스트레이프 없음), 반대로 누르면 바로 돌아선다', () => {
    const world = flatWorld(), b = newBody([0, 0, -WALK]);
    for (let i = 0; i < 180; i++) {
      moveQuake(world, b, keys(rad(i * 3), { f: 1, s: i % 2 ? 1 : 0 }), DT);
      assert.ok(hs(b) <= WALK + 1e-6, `걷기보다 빨라졌다: ${hs(b)}`);
    }
    const c = newBody([WALK, 0, 0]);
    let ticks = 0;
    while (c.vel[0] > -WALK + 1e-6 && ticks < 60) { moveQuake(flatWorld(), c, { dirX: -1, dirZ: 0, speed: WALK }, DT); ticks++; }
    assert.ok(ticks * DT <= 0.2, `돌아서는 데 ${ticks}틱`);
  });
});

describe('점프 · 버니합', () => {
  test('점프 최고 높이는 약 1.24 m로 그대로다', () => {
    const world = flatWorld(), b = newBody();
    moveQuake(world, b, noKeys({ jump: true }), DT);
    let apex = b.pos[1];
    while (!b.onGround) { moveQuake(world, b, noKeys(), DT); apex = Math.max(apex, b.pos[1]); }
    assert.ok(Math.abs(apex - 1.24) < 0.01, `최고 높이 ${apex}`);
    assert.equal(b.pos[1], 0);
  });

  test('누른 채 직선으로 뛰면 마찰 없이 이어지고, 뛸 때마다 2% 넘게 잃지도 얻지도 않는다', () => {
    for (const v0 of [WALK, 8, 12, MOVE.MAX_SPEED]) {
      const world = flatWorld(), b = newBody([0, 0, -v0]);
      let hops = 0, last = v0, airTicks = 0;
      for (let i = 0; i < 60 * 12; i++) {
        const ev = moveQuake(world, b, forward({ jump: true }), DT);
        if (b.onGround) airTicks = 0; else airTicks++;
        if (ev.jumped) {
          const ratio = hs(b) / last;
          assert.ok(ratio >= 0.98, `${v0} m/s: 한 번에 ${((1 - ratio) * 100).toFixed(2)}% 잃었다`);
          assert.ok(ratio <= 1 + 1e-9, `${v0} m/s: 직선 뜀뛰기로 빨라졌다 ${hs(b)}`);
          if (hops > 0) assert.equal(ev.hopped, true);
          last = hs(b);
          hops++;
        }
        if (ev.landed) assert.equal(ev.hopped, true, '누르고 있으면 착지도 버니합이다');
      }
      assert.ok(hops >= 14, `12초에 ${hops}번 뛰었다`);
      assert.ok(Math.abs(hs(b) - v0) < 1e-6, `끝 속도 ${hs(b)}, 시작 ${v0}`);
    }
  });

  test('제자리에서 Space + W를 누르고 있으면 걷기 속도까지 올라가고 그 위로는 안 간다', () => {
    const world = flatWorld(), b = newBody();
    let peak = 0, t = 0, reached = null;
    for (let i = 0; i < 60 * 8; i++) {
      moveQuake(world, b, forward({ jump: true }), DT);
      t += DT;
      peak = Math.max(peak, hs(b));
      if (reached === null && hs(b) >= WALK - 1e-6) reached = t;
    }
    assert.ok(reached !== null && reached <= 5, `걷기 속도까지 ${reached}초`);
    assert.ok(peak <= WALK + 1e-6, `걷기를 넘었다: ${peak}`);
  });

  test('착지 뒤 HOP_GRACE 안의 점프는 마찰을 먹지 않고, 그 뒤에는 먹는다', () => {
    const graceTicks = Math.round(MOVE.HOP_GRACE / DT);
    const run = (waitTicks) => {
      const world = flatWorld(), b = newBody([0, 0, -10]);
      hopOnce(world, b, (jump) => forward({ jump }));
      const landed = hs(b);
      for (let i = 0; i < waitTicks; i++) moveQuake(world, b, forward(), DT);
      const ev = moveQuake(world, b, forward({ jump: true }), DT);
      assert.equal(ev.jumped, true);
      return { kept: hs(b) / landed, hopped: ev.hopped };
    };
    assert.deepEqual(run(0), { kept: 1, hopped: true });
    assert.deepEqual(run(graceTicks - 1), { kept: 1, hopped: true });
    const late = run(graceTicks + 3);
    assert.equal(late.hopped, false);
    assert.ok(late.kept < 0.8, `늦은 점프인데 속도가 ${late.kept}배 남았다`);
  });

  test('hopped: 첫 점프와 그냥 착지는 아니고, 뛸 예고가 있는 착지와 이어 뛰기는 맞다', () => {
    const world = flatWorld(), b = newBody();
    const first = moveQuake(world, b, noKeys({ jump: true }), DT);
    assert.equal(first.jumped, true);
    assert.equal(first.hopped, false);
    let ev;
    do { ev = moveQuake(world, b, noKeys(), DT); } while (!b.onGround);
    assert.equal(ev.landed, true);
    assert.equal(ev.hopped, false);
    for (let i = 0; i < 30; i++) moveQuake(world, b, noKeys(), DT);
    moveQuake(world, b, noKeys({ jump: true }), DT);
    do { ev = moveQuake(world, b, noKeys({ jump: true }), DT); } while (!b.onGround);
    assert.equal(ev.landed, true);
    assert.equal(ev.hopped, true);
    const again = moveQuake(world, b, noKeys({ jump: true }), DT);
    assert.equal(again.jumped, true);
    assert.equal(again.hopped, true);
  });

  test('ev.speed는 이동 뒤 수평 속력이고, resetMoveMemory 뒤의 점프는 버니합이 아니다', () => {
    const world = flatWorld(), b = newBody([3, 0, 4]);
    const ev = moveQuake(world, b, noKeys({ jump: true }), DT);
    assert.equal(ev.speed, hs(b));
    while (!b.onGround) moveQuake(world, b, noKeys(), DT);
    resetMoveMemory(b);
    assert.equal(moveQuake(world, b, noKeys({ jump: true }), DT).hopped, false);
  });
});

describe('공중 스트레이프', () => {
  /** 마우스로 yaw를 돌려 wishdir을 진행 방향에서 angleFn(t)도로 유지하고, 한 번 뛸 때마다 A/D를 바꾼다 */
  function strafeRun(angleFn, seconds) {
    const world = flatWorld(), b = newBody([0, 0, -WALK]);
    let side = 1, t = 0, t8 = null, t11 = null, peak = 0;
    for (let i = 0; i < seconds * 60; i++) {
      const heading = Math.atan2(b.vel[2], b.vel[0]);
      // D면 오른쪽(atan2 각이 커지는 쪽). right(yaw) = (cos, -sin), left = -right
      const wishAngle = heading + side * rad(angleFn(t));
      const rx = side * Math.cos(wishAngle), rz = side * Math.sin(wishAngle);
      const yaw = Math.atan2(-rz, rx);
      const ev = moveQuake(world, b, keys(yaw, { s: side, jump: true }), DT);
      if (ev.landed) side = -side;
      t += DT;
      const v = hs(b);
      peak = Math.max(peak, v);
      if (t8 === null && v > 8) t8 = t;
      if (t11 === null && v > 11) t11 = t;
    }
    return { t8, t11, peak };
  }

  const WOBBLE = (t) => 82.5 + 2.5 * Math.sin((t * 2 * Math.PI) / 0.53); // 사람처럼 80~85°를 오간다

  for (const [name, angleFn] of [['80~85° 사이를 오가는', WOBBLE], ['85°를 지키는', () => 85], ['82.5°를 지키는', () => 82.5]]) {
    test(`${name} 스트레이프: 10초 안에 8 m/s, 25초 안에 11 m/s, MAX_SPEED는 넘지 않는다`, () => {
      const r = strafeRun(angleFn, 25);
      assert.ok(r.t8 !== null && r.t8 <= 10, `8 m/s까지 ${r.t8}초`);
      assert.ok(r.t11 !== null && r.t11 <= 25, `11 m/s까지 ${r.t11}초`);
      assert.ok(r.peak <= MOVE.MAX_SPEED + 1e-9, `최고 ${r.peak}`);
    });
  }

  test('80°에 고정된 서툰 스트레이프도 8 m/s는 넘고, MAX_SPEED를 넘지 않는다', () => {
    const r = strafeRun(() => 80, 15);
    assert.ok(r.t8 !== null && r.t8 <= 10, `8 m/s까지 ${r.t8}초`);
    assert.ok(r.peak <= MOVE.MAX_SPEED + 1e-9);
  });

  /** 사람의 손: 마우스를 일정한 빠르기로 돌리다가 착지마다 방향과 A/D를 함께 바꾼다. 착지 때의 속도 목록을 돌려준다 */
  function swingRun(sweepDegPerHop, hops) {
    const world = flatWorld(), b = newBody([0, 0, -WALK]);
    const rate = rad(sweepDegPerHop) / 0.8; // 0.8초 = 한 번 뛰는 시간
    const log = [];
    let side = 1, yaw = 0;
    while (log.length < hops) {
      yaw -= side * rate * DT; // D + 오른쪽으로 돌리기(yaw 감소)
      const ev = moveQuake(world, b, keys(yaw, { s: side, jump: true }), DT);
      if (ev.landed) { log.push(hs(b)); side = -side; }
    }
    return log;
  }

  test('사람 빠르기의 45° 스윙: 몇 번 뛰면 뚜렷이 빨라지고, 한 번에 다 차지는 않는다', () => {
    const log = swingRun(45, 12);
    assert.ok(log[3] >= 8, `4번 뛰고 ${log[3].toFixed(2)} m/s`);
    assert.ok(log[7] >= 11, `8번 뛰고 ${log[7].toFixed(2)} m/s`);
    assert.ok(log[1] < 9, `2번 만에 ${log[1].toFixed(2)} m/s면 너무 쉽다`);
    assert.ok(Math.max(...log) <= MOVE.MAX_SPEED + 1e-9);
  });

  test('스윙이 지나치게 크면 최고 속도까지 못 간다(따라갈 수 있는 마우스 빠르기의 한계)', () => {
    const big = swingRun(135, 16);
    assert.ok(big[15] < 11, `135° 스윙 ${big[15].toFixed(2)} m/s`);
    assert.ok(big[15] > WALK, '그래도 걷기보다는 빠르다');
  });

  test('마우스 없이 A/D만 바꾸면 SWAP_BONUS_MAX 근처까지 오르고 더 가지 않는다', () => {
    for (const period of [20, 30, 48]) { // 교체 간격(틱)
      const world = flatWorld(), b = newBody([0, 0, -WALK]);
      let side = 1, peak = 0, reached = null;
      for (let i = 0; i < 60 * 40; i++) {
        if (i % period === 0) side = -side;
        moveQuake(world, b, keys(0, { s: side, jump: true }), DT);
        peak = Math.max(peak, hs(b));
        if (reached === null && hs(b) >= MOVE.SWAP_BONUS_MAX - 0.05) reached = i * DT;
      }
      assert.ok(reached !== null, `간격 ${period}틱: 최고 ${peak.toFixed(2)} m/s`);
      assert.ok(peak <= MOVE.SWAP_BONUS_MAX + 0.2, `간격 ${period}틱: ${peak} m/s까지 갔다`);
      assert.ok(b.vel[2] < -8, `정면으로 계속 나아간다: vz ${b.vel[2]}`);
      assert.ok(Math.abs(b.vel[0]) <= MOVE.AIR_WISH_CAP + 0.05, `옆 속도 ${b.vel[0]}`);
    }
  });

  test('초당 3번 흔들면 A/D만으로 5초 안에 체감되는 속도(8 m/s)가 난다', () => {
    const world = flatWorld(), b = newBody([0, 0, -WALK]);
    let side = 1;
    for (let i = 0; i < 60 * 5; i++) {
      if (i % 20 === 0) side = -side;
      moveQuake(world, b, keys(0, { s: side, jump: true }), DT);
    }
    assert.ok(hs(b) >= 8, `5초 뒤 ${hs(b).toFixed(2)} m/s`);
  });

  test('W를 누른 채 A/D를 바꿔도 보너스는 붙고, SWAP_BONUS_MAX에서 멈춘다', () => {
    const world = flatWorld(), b = newBody([0, 0, -WALK]);
    let side = 1, peak = 0;
    for (let i = 0; i < 60 * 30; i++) {
      if (i % 20 === 0) side = -side;
      moveQuake(world, b, keys(0, { f: 1, s: side, jump: true }), DT);
      peak = Math.max(peak, hs(b));
    }
    assert.ok(peak >= MOVE.SWAP_BONUS_MAX - 0.05 && peak <= MOVE.SWAP_BONUS_MAX + 0.2, `최고 ${peak}`);
  });

  test('A/D 연타는 SWAP_GAP보다 빠르게 보너스를 받지 못한다', () => {
    const world = flatWorld(), b = newBody([0, 0, -WALK], [0, 0, 0], false);
    b.pos[1] = 200; // 착지하지 않게
    let side = 1, total = 0, count = 0;
    const ticks = 120;
    for (let i = 0; i < ticks; i++) {
      side = -side;
      const ev = moveQuake(world, b, keys(0, { s: side }), DT);
      if (ev.swapBonus > 0) { total += ev.swapBonus; count++; }
    }
    assert.ok(count <= Math.ceil((ticks * DT) / MOVE.SWAP_GAP) + 1, `${count}번 받았다`);
    assert.ok(total <= (count * MOVE.SWAP_BONUS) + 1e-9);
    assert.ok(count >= 2);
  });

  test('swapBonus: 공중에서 방향이 실제로 바뀔 때만, 손을 뗐다 바꿔도 한 번, 땅에서는 없음', () => {
    const world = flatWorld();
    const air = () => { const b = newBody([0, 0, -6], [0, 200, 0], false); return { b, step: (s) => moveQuake(world, b, keys(0, { s }), DT).swapBonus }; };
    const a = air();
    assert.equal(a.step(1), 0, '첫 입력은 교체가 아니다');
    assert.equal(a.step(1), 0, '같은 방향 유지');
    assert.equal(a.step(0), 0, '손을 뗐다');
    assert.equal(a.step(1), 0, '같은 방향으로 다시');
    assert.equal(a.step(0), 0);
    const bonus = a.step(-1);
    assert.equal(bonus, MOVE.SWAP_BONUS, 'D → 없음 → A는 교체 한 번');
    for (let i = 0; i < 60; i++) a.step(0);
    assert.equal(a.step(-1), 0, '같은 방향은 오래 뒤에도 보너스가 아니다');

    const g = newBody();
    assert.equal(moveQuake(world, g, keys(0, { s: 1 }), DT).swapBonus, 0);
    assert.equal(moveQuake(world, g, keys(0, { s: -1 }), DT).swapBonus, 0, '땅에서 바꾸면 없다');
    moveQuake(world, g, keys(0, {}), DT); // 땅에서 손을 떼면 잊는다
    moveQuake(world, g, keys(0, { jump: true }), DT);
    assert.equal(moveQuake(world, g, keys(0, { s: 1 }), DT).swapBonus, 0, '묵은 방향으로 보너스가 붙지 않는다');
  });

  test('공중에서 S로 멈출 수 있고 입력이 없으면 수평 속도는 그대로다', () => {
    const world = flatWorld();
    const b = newBody([0, 0, -9], [0, 200, 0], false);
    for (let i = 0; i < 30; i++) moveQuake(world, b, noKeys(), DT);
    assert.equal(hs(b), 9);
    for (let i = 0; i < 30; i++) moveQuake(world, b, keys(0, { f: -1 }), DT);
    assert.ok(hs(b) <= MOVE.AIR_LOW_SPEED + 1e-9, `S를 0.5초 눌렀는데 ${hs(b)} m/s`);
  });

  test('제자리 점프 뒤 W는 낮은 공중 상한까지만 올라가 약 2.3 m를 간다', () => {
    const world = flatWorld();
    const b = newBody([0, 0, 0], [0, MOVE.JUMP_V ?? 6.3, 0], false);
    const start = b.pos[2];
    let peak = 0, guard = 0;
    while (!b.onGround && guard++ < 200) {
      moveQuake(world, b, keys(0, { f: 1 }), DT);
      peak = Math.max(peak, hs(b));
    }
    assert.ok(peak <= MOVE.AIR_LOW_SPEED + 1e-9, `공중 속도 ${peak} m/s`);
    const travel = Math.abs(b.pos[2] - start);
    assert.ok(travel > 1.8 && travel < 2.8, `이동 거리 ${travel} m`);
  });
});

describe('착지 · 상한', () => {
  test('점프를 멈추고 착지하면 0.7초 안에 걷기 속도로 돌아온다', () => {
    for (const wish of [forward, noKeys]) {
      const world = flatWorld(), b = newBody([0, 0, -MOVE.MAX_SPEED]);
      hopOnce(world, b, (jump) => wish({ jump }));
      assert.ok(Math.abs(hs(b) - MOVE.MAX_SPEED) < 1e-6, '공중에서는 잃지 않는다');
      let t = 0;
      while (hs(b) > WALK + 1e-6 && t < 2) { moveQuake(world, b, wish(), DT); t += DT; }
      assert.ok(t <= 0.7, `${t.toFixed(3)}초`);
    }
  });

  test('착지 직후 HOP_GRACE 동안은 속도가 그대로이고, 그 뒤 곧바로 줄기 시작한다', () => {
    const world = flatWorld(), b = newBody([0, 0, -12]);
    hopOnce(world, b, (jump) => noKeys({ jump }));
    const graceTicks = Math.round(MOVE.HOP_GRACE / DT);
    for (let i = 0; i < graceTicks; i++) {
      moveQuake(world, b, noKeys(), DT);
      assert.equal(hs(b), 12, `${i}번째 틱`);
    }
    moveQuake(world, b, noKeys(), DT);
    assert.ok(hs(b) < 12);
  });

  test('발판 속도는 MAX_SPEED를 넘어도 깎이지 않는다(궤적 유지), 입력으로 더 빨라지지도 않는다', () => {
    const world = flatWorld();
    const free = newBody([24, 9, 0], [0, 50, 0], false);
    for (let i = 0; i < 60; i++) moveQuake(world, free, noKeys(), DT);
    assert.equal(hs(free), 24);
    const steered = newBody([24, 9, 0], [0, 50, 0], false);
    for (let i = 0; i < 60; i++) {
      const before = hs(steered);
      moveQuake(world, steered, keys(0, { s: i % 2 ? 1 : -1 }), DT);
      assert.ok(hs(steered) <= before + 1e-9);
    }
  });
});

describe('충돌', () => {
  const R = PLAYER.RADIUS;

  test('MAX_SPEED로 0.3 m 벽에 부딪혀도 뚫지 않는다(땅·공중, 모든 위상)', () => {
    const wallX = 6;
    for (const jump of [false, true]) {
      for (let phase = 0; phase < 0.24; phase += 0.02) {
        const world = flatWorld(makeBox(wallX, 0, -50, wallX + 0.3, 6, 50));
        const b = newBody([MOVE.MAX_SPEED, 0, 0], [wallX - 3 - phase, 0, 0]);
        for (let i = 0; i < 90; i++) {
          moveQuake(world, b, { dirX: 1, dirZ: 0, speed: WALK, jump, strafeSign: 0 }, DT);
          assert.ok(b.pos[0] <= wallX - R + 0.01, `벽을 뚫었다: x=${b.pos[0]} (jump=${jump}, phase=${phase})`);
        }
        assert.ok(Math.abs(b.vel[0]) < 1e-9, '벽 쪽 속도는 사라진다');
      }
    }
  });

  test('비스듬히 부딪히면 벽을 따라 미끄러진다', () => {
    const world = flatWorld(makeBox(2, 0, -500, 2.3, 6, 500));
    const b = newBody([10, 0, -10], [0, 0, 0]);
    for (let i = 0; i < 40; i++) moveQuake(world, b, { dirX: Math.SQRT1_2, dirZ: -Math.SQRT1_2, speed: WALK, jump: true, strafeSign: 0 }, DT);
    assert.ok(b.pos[0] <= 2 - R + 0.01);
    assert.ok(b.pos[2] < -4, `벽을 따라 갔어야 한다: z=${b.pos[2]}`);
    assert.ok(hs(b) > 5, `옆 속도는 남는다: ${hs(b)}`);
  });

  test('턱 끝에서 걸어 나가면 떨어진다', () => {
    const world = createWorld([floorBox(), makeBox(-10, 0, -10, 10, 5, 10)]);
    const b = newBody([WALK, 0, 0], [8, 5, 0]);
    let fell = false, landed = false;
    for (let i = 0; i < 120 && !landed; i++) {
      const ev = moveQuake(world, b, { dirX: 1, dirZ: 0, speed: WALK, jump: false, strafeSign: 0 }, DT);
      if (!b.onGround) fell = true;
      if (ev.landed) landed = true;
    }
    assert.equal(fell, true);
    assert.equal(landed, true);
    assert.equal(b.pos[1], 0);
    assert.ok(b.pos[0] > 10);
  });

  test('걸어 나간 공중에서는 마찰이 없고 점프로 이어지지 않는다', () => {
    const world = createWorld([floorBox(), makeBox(-10, 0, -10, 10, 5, 10)]);
    const b = newBody([WALK, 0, 0], [9.5, 5, 0]);
    let ticks = 0;
    while (b.onGround && ticks < 60) { moveQuake(world, b, { dirX: 1, dirZ: 0, speed: WALK }, DT); ticks++; }
    assert.equal(b.onGround, false);
    for (let i = 0; i < 10; i++) {
      const ev = moveQuake(world, b, noKeys({ jump: true }), DT);
      assert.equal(ev.jumped, false, '공중에서는 뛰지 않는다');
      assert.ok(Math.abs(hs(b) - WALK) < 1e-9, `떠난 뒤 속도가 변했다: ${hs(b)}`);
    }
  });

  test('고속으로 0.3 m 턱을 그대로 올라선다', () => {
    const world = flatWorld(makeBox(2, 0, -50, 40, 0.3, 50));
    const east = (jump) => ({ dirX: 1, dirZ: 0, speed: WALK, jump, strafeSign: 0 });

    // 땅을 달려서: 마찰로 줄고 있어도 턱에서 멈추지 않는다
    const run = newBody([MOVE.MAX_SPEED, 0, 0], [1.5, 0, 0]);
    let stepUp = 0, speedAtStep = 0;
    for (let i = 0; i < 30; i++) {
      const ev = moveQuake(world, run, east(false), DT);
      if (ev.stepUp > 0 && !stepUp) { stepUp = ev.stepUp; speedAtStep = hs(run); }
      assert.ok(run.onGround, `${i}틱: 땅에서 떨어졌다`);
    }
    assert.ok(Math.abs(stepUp - 0.3) < 1e-6, `올라선 높이 ${stepUp}`);
    assert.ok(speedAtStep > 8, `턱에서 멈추지 않았다: ${speedAtStep} m/s`);
    assert.equal(run.pos[1], 0.3);
    assert.ok(run.pos[0] > 3);

    // 뛰어와 턱 바로 앞에 내려앉아서: 마찰이 없는 HOP_GRACE 동안 MAX_SPEED 그대로 올라선다
    const hop = newBody([MOVE.MAX_SPEED, 0, 0], [-9.8, 0, 0]);
    moveQuake(world, hop, east(true), DT);
    while (!hop.onGround) moveQuake(world, hop, east(false), DT);
    assert.equal(hop.pos[1], 0, '턱 앞 바닥에 내려앉았어야 시험이 된다');
    let fullSpeedStep = false;
    for (let i = 0; i < 3; i++) {
      const ev = moveQuake(world, hop, east(false), DT);
      if (ev.stepUp > 0 && hs(hop) === MOVE.MAX_SPEED) fullSpeedStep = true;
    }
    assert.equal(fullSpeedStep, true);
    assert.equal(hop.pos[1], 0.3);
  });

  test('0.3 m 계단을 달려 올라가도 턱마다 막히지 않는다', () => {
    const stairs = [];
    for (let i = 0; i < 6; i++) stairs.push(makeBox(2 + i * 0.8, 0, -5, 2 + (i + 1) * 0.8, (i + 1) * 0.3, 5));
    stairs.push(makeBox(2 + 6 * 0.8, 0, -5, 30, 6 * 0.3, 5));
    const world = flatWorld(...stairs);
    const b = newBody([MOVE.MAX_SPEED, 0, 0]);
    for (let i = 0; i < 120; i++) moveQuake(world, b, { dirX: 1, dirZ: 0, speed: WALK, jump: false, strafeSign: 0 }, DT);
    assert.ok(Math.abs(b.pos[1] - 1.8) < 1e-6, `계단 끝 높이 ${b.pos[1]}`);
    assert.ok(b.pos[0] > 2 + 6 * 0.8);
    assert.ok(Math.abs(hs(b) - WALK) < 1e-6, `계단에서 걸음이 끊겼다: ${hs(b)}`);
  });

  test('Space를 누른 채 0.3 m 계단으로 뛰어 올라도 챌판에 걸려 멈추지 않는다', () => {
    for (const tread of [0.4, 0.6, 0.8]) {
      for (const v0 of [WALK, 9, 12]) {
        for (let start = 0; start < 40; start++) {
          const boxes = [];
          for (let i = 0; i < 10; i++) boxes.push(makeBox(2 + i * tread, 0, -5, 2 + (i + 1) * tread, (i + 1) * 0.3, 5));
          boxes.push(makeBox(2 + 10 * tread, 0, -5, 60, 3, 5));
          const world = flatWorld(...boxes);
          const b = newBody([v0, 0, 0], [-2 - start * 0.137, 0, 0]);
          let low = v0, t = 0;
          while (b.pos[0] < 2 + 10 * tread + 1 && t < 10) {
            moveQuake(world, b, { dirX: 1, dirZ: 0, speed: WALK, jump: true, strafeSign: 0 }, DT);
            low = Math.min(low, hs(b));
            t += DT;
          }
          assert.ok(b.pos[1] >= 3 - 1e-6, `계단 위에 못 올랐다: y=${b.pos[1]} (디딤판 ${tread}, ${v0} m/s, 출발 ${start})`);
          assert.ok(low >= v0 * 0.98, `디딤판 ${tread}, ${v0} m/s, 출발 ${start}: 최저 ${low.toFixed(2)} m/s`);
        }
      }
    }
  });

  test('Space를 누른 채 경사로를 뛰어 올라도 속도를 잃지 않는다', () => {
    for (const v0 of [WALK, 9, MOVE.MAX_SPEED]) {
      const world = flatWorld(
        solidToCollider({ type: 'ramp', x: 14, y: 0, z: 0, w: 8, h: 2.6, d: 20, dir: '+x', mat: 'steel' }),
        solidToCollider({ type: 'box', x: 38, y: 0, z: 0, w: 40, h: 2.6, d: 20, mat: 'steel' })
      );
      const b = newBody([v0, 0, 0], [-2, 0, 0]);
      let low = v0;
      while (b.pos[0] < 30) {
        moveQuake(world, b, { dirX: 1, dirZ: 0, speed: WALK, jump: true, strafeSign: 0 }, DT);
        low = Math.min(low, hs(b));
      }
      assert.ok(low >= v0 * 0.98, `${v0} m/s: 최저 ${low.toFixed(2)} m/s`);
      assert.ok(b.pos[1] >= 2.6 - 1e-6, `위로 못 올랐다: y=${b.pos[1]}`);
    }
  });

  test('뛰는 틱에 챌판 위로 올라서면 점프로 치지 않고 턱으로 알리며, 다음 틱에 이어 뛴다', () => {
    const world = flatWorld(makeBox(1, 0, -5, 40, 0.3, 5));
    const b = newBody([9, 0, 0], [0.6, 0, 0]);
    const east = { dirX: 1, dirZ: 0, speed: WALK, jump: true, strafeSign: 0 };
    const ev = moveQuake(world, b, east, DT);
    assert.equal(ev.jumped, false);
    assert.equal(b.onGround, true);
    assert.equal(b.pos[1], 0.3);
    assert.ok(Math.abs(ev.stepUp - 0.3) < 1e-9);
    assert.equal(hs(b), 9, '속도를 잃지 않는다');
    const next = moveQuake(world, b, east, DT);
    assert.equal(next.jumped, true);
    assert.equal(next.hopped, true, '버니합 사슬은 이어진다');
    assert.equal(b.onGround, false);
  });

  test('공중 턱 한도는 바닥에 거의 닿았을 때만 넓어져서, 점프로 닿는 높이는 그대로다', () => {
    // 최고점(1.24 m) 근처에서 벽에 닿도록 달려 뛴다: 공중 한도 0.225 m까지만 올라타므로 1.4 m는 되고 1.5 m는 안 된다
    const tryBox = (top) => {
      const world = flatWorld(makeBox(1.9, 0, -5, 40, top, 5));
      const b = newBody([WALK, 0, 0], [-0.5, 0, 0]);
      const east = (jump) => ({ dirX: 1, dirZ: 0, speed: WALK, jump, strafeSign: 0 });
      moveQuake(world, b, east(true), DT);
      for (let i = 0; i < 120; i++) moveQuake(world, b, east(false), DT);
      return Math.abs(b.pos[1] - top) < 1e-6;
    };
    assert.equal(tryBox(1.4), true);
    assert.equal(tryBox(1.5), false);
    // 바닥에서 멀리 뜬 공중에서는 0.3 m 차이의 턱도 벽이다
    const world = flatWorld(makeBox(1, 0, -5, 40, 2.3, 5));
    const b = newBody([9, 0, 0], [0, 2, 0], false);
    for (let i = 0; i < 12; i++) moveQuake(world, b, noKeys(), DT);
    assert.equal(b.vel[0], 0, '멀리 떠 있으면 벽에 막힌다');
    assert.ok(b.pos[0] <= 1 - PLAYER.RADIUS + 0.01);
  });

  test('낮은 천장에 머리를 찧으면 떨어지고, 꽉 막힌 천장이면 뛰지 않는다', () => {
    const tight = flatWorld(makeBox(-5, PLAYER.HEIGHT, -5, 5, 3, 5));
    const stuck = newBody();
    const blocked = moveQuake(tight, stuck, noKeys({ jump: true }), DT);
    assert.equal(blocked.jumped, false, '땅을 떠나지 못하면 점프가 아니다');
    assert.equal(stuck.onGround, true);
    assert.equal(stuck.pos[1], 0);

    const world = flatWorld(makeBox(-5, 2.3, -5, 5, 3, 5));
    const b = newBody();
    const ev = moveQuake(world, b, noKeys({ jump: true }), DT);
    assert.equal(ev.jumped, true);
    let peak = 0, ceiling = false;
    while (!b.onGround) {
      const e = moveQuake(world, b, noKeys(), DT);
      ceiling = ceiling || e.ceiling;
      peak = Math.max(peak, b.pos[1]);
    }
    assert.equal(ceiling, true);
    assert.ok(peak <= 2.3 - PLAYER.HEIGHT + 1e-6, `천장을 뚫었다: ${peak}`);
  });
});

describe('봇 경로(moveCharacter 기본값)', () => {
  test('rawVelocity가 없으면 예전 가속 그대로: 지면 60, 멈춤 45, 공중 10 m/s²', () => {
    const world = flatWorld();
    const b = newBody();
    const seen = [];
    for (let i = 0; i < 7; i++) { moveCharacter(world, b, { x: 5.2, z: 0 }, DT); seen.push(b.vel[0]); }
    const want = [1, 2, 3, 4, 5, 5.2, 5.2];
    seen.forEach((v, i) => assert.ok(Math.abs(v - want[i]) < 1e-9, `${i}틱: ${v}`));

    const stop = newBody([5.2, 0, 0]);
    moveCharacter(world, stop, { x: 0, z: 0 }, DT);
    assert.ok(Math.abs(stop.vel[0] - (5.2 - 0.75)) < 1e-9);

    const air = newBody([0, 0, 0], [0, 100, 0], false);
    moveCharacter(world, air, { x: 5.2, z: 0 }, DT);
    assert.ok(Math.abs(air.vel[0] - 10 / 60) < 1e-9);

    const idleAir = newBody([3, 0, 0], [0, 100, 0], false);
    moveCharacter(world, idleAir, { x: 0, z: 0 }, DT);
    assert.equal(idleAir.vel[0], 3);

    const custom = newBody();
    moveCharacter(world, custom, { x: 5.2, z: 0 }, DT, { accel: 30 });
    assert.ok(Math.abs(custom.vel[0] - 0.5) < 1e-9);
  });

  test('rawVelocity면 수평 속도를 건드리지 않고, 점프·수직 이동은 같다', () => {
    const world = flatWorld();
    const a = newBody([2, 0, 3]), c = newBody([2, 0, 3]);
    moveCharacter(world, a, { x: 5.2, z: 0, jump: true }, DT, { rawVelocity: true });
    assert.deepEqual([a.vel[0], a.vel[2]], [2, 3]);
    moveCharacter(world, c, { x: 2, z: 3, jump: true }, DT);
    assert.deepEqual(a.vel, c.vel);
    assert.deepEqual(a.pos, c.pos);
    assert.equal(a.onGround, c.onGround);
  });
});

/* ---------- player.js: 입력 규칙 ---------- */

function makePlayer(world, spawn = { x: 0, y: 0, z: 0 }) {
  const bus = createBus();
  const events = [];
  bus.on('*', (name, data) => { events.push({ name, data }); });
  const input = {
    enabled: true,
    state: { forward: false, back: false, left: false, right: false, jump: false, walk: false, crouch: false, aim: false },
    consumeLook: () => ({ dx: 0, dy: 0 }),
    setEmoteLock() {}
  };
  const cam = { position: { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } }, rotation: { set() {} } };
  const player = createLocalPlayer({ bus, input, camera: cam, getWorld: () => world });
  player.spawn(spawn);
  events.length = 0;
  const run = (ticks, fn) => { for (let i = 0; i < ticks; i++) { player.tick(DT); if (fn) fn(i); } };
  const count = (name) => events.filter((e) => e.name === name).length;
  const list = (name) => events.filter((e) => e.name === name).map((e) => e.data);
  const press = () => { input.state.jump = true; bus.emit('input:jump', {}); };
  return { bus, input, player, state: player.state, events, run, count, list, press, cam };
}

describe('player', () => {
  test('Space를 누르고 있으면 착지마다 다시 뛰고, 떼면 멈춘다. 이벤트에 hopped가 실린다', () => {
    const g = makePlayer(flatWorld());
    g.press();
    g.run(60 * 4 + 12); // 공중에 있을 때 끊는다
    assert.equal(g.state.onGround, false);
    const jumps = g.list('player:jump');
    assert.ok(jumps.length >= 5, `${jumps.length}번 뛰었다`);
    assert.equal(jumps[0].hopped, false);
    assert.ok(jumps.slice(1).every((j) => j.hopped === true));
    assert.ok(jumps.every((j) => Array.isArray(j.pos)));
    const lands = g.list('player:land');
    assert.ok(lands.length >= 4);
    assert.ok(lands.every((l) => l.hopped === true && typeof l.speed === 'number' && 'mat' in l));
    g.input.state.jump = false;
    const before = g.count('player:jump');
    g.run(120);
    assert.equal(g.count('player:jump'), before, '떼면 더 뛰지 않는다');
    assert.equal(g.state.onGround, true);
    assert.equal(g.list('player:land').at(-1).hopped, false, '떼고 내린 착지는 버니합이 아니다');
  });

  test('누른 직후 0.12초 버퍼: 착지 직전에 톡 누르면 뛰고, 그보다 일찍 누르면 안 뛴다', () => {
    const tap = (ticksBeforeLanding) => {
      const g = makePlayer(flatWorld());
      g.press(); g.input.state.jump = false;
      let air = 0;
      g.run(1);
      while (!g.state.onGround) { g.run(1); air++; }
      const h = makePlayer(flatWorld());
      h.press(); h.input.state.jump = false;
      h.run(1);
      h.run(air - ticksBeforeLanding);
      h.press(); h.input.state.jump = false;
      const before = h.count('player:jump');
      h.run(ticksBeforeLanding + 2);
      return h.count('player:jump') - before;
    };
    assert.equal(tap(5), 1, '5틱 전에 누른 점프는 버퍼로 이어진다');
    assert.equal(tap(12), 0, '12틱(0.2초) 전에 누른 점프는 사라진다');
  });

  test('state.speed는 수평 속력이고, 머리 흔들림은 고속에서도 걷기 수준이다', () => {
    const g = makePlayer(flatWorld());
    g.input.state.forward = true;
    g.run(30);
    assert.ok(Math.abs(g.state.speed - WALK) < 1e-6);
    assert.equal(g.state.moving, true);
    g.input.state.forward = false;
    g.run(30);
    assert.equal(g.state.speed, 0);
    assert.equal(g.state.moving, false);

    // 같은 시간 동안 흔들림 위상이 도는 양: 걷기와 MAX_SPEED가 같아야 한다(빠른 무기 여유 안에서)
    const eyeSwings = (speed) => {
      const h = makePlayer(flatWorld());
      const heights = [];
      for (let i = 0; i < 60 * 4; i++) {
        h.state.vel[2] = -speed; h.state.onGround = true; // 프레임 계산만 본다
        h.player.frame(DT, 1);
        heights.push(h.cam.position.y);
      }
      let crossings = 0;
      const mid = PLAYER.EYE;
      for (let i = 121; i < heights.length; i++) if ((heights[i - 1] - mid) * (heights[i] - mid) < 0) crossings++;
      return { crossings, top: Math.max(...heights.slice(120)) - mid };
    };
    const walk = eyeSwings(WALK), fast = eyeSwings(MOVE.MAX_SPEED);
    assert.ok(fast.crossings <= walk.crossings * 1.25, `걷기 ${walk.crossings}번, 고속 ${fast.crossings}번`);
    assert.ok(fast.top <= walk.top + 1e-6, '흔들림 폭은 걷기를 넘지 않는다');
  });

  test('버니합 착지의 카메라 출렁임은 일반 착지보다 작다', () => {
    const dip = (holdJump) => {
      const g = makePlayer(flatWorld());
      g.press();
      g.input.state.jump = holdJump;
      g.player.tick(DT);
      while (!g.state.onGround) g.player.tick(DT);
      // 착지 직후의 카메라 높이를 지면 눈높이와 비교
      g.input.state.jump = false; // 다음 틱에 뛰지 않게 해서 출렁임만 잰다
      let low = Infinity;
      for (let i = 0; i < 30; i++) { g.player.frame(DT, 1); low = Math.min(low, g.cam.position.y - g.state.pos[1] - PLAYER.EYE); }
      return -low;
    };
    const normal = dip(false), hop = dip(true);
    assert.ok(normal > 0.01, `일반 착지 ${normal}`);
    assert.ok(hop < normal * 0.5, `버니합 ${hop}, 일반 ${normal}`);
  });

  test('A/D가 strafeSign으로 이어져 공중에서 보너스가 붙는다', () => {
    const g = makePlayer(flatWorld());
    g.state.vel[2] = -6;
    g.press();
    g.input.state.right = true;
    g.run(5);
    const v0 = g.state.speed;
    g.input.state.right = false;
    g.input.state.left = true;
    g.run(1);
    assert.ok(g.state.speed > v0, `${v0} → ${g.state.speed}`);
  });

  test('앉은 채 Space: 자리가 있으면 일어서며 뛰고, 착지하면 키가 눌린 만큼 다시 앉는다', () => {
    const g = makePlayer(flatWorld());
    g.input.state.crouch = true;
    g.run(3);
    assert.equal(g.state.crouch, true);
    g.press(); g.input.state.jump = false;
    g.run(1);
    assert.equal(g.state.crouch, false);
    assert.equal(g.state.onGround, false);
    assert.equal(g.count('player:jump'), 1);
    let ticks = 0;
    while (!g.state.onGround && ticks++ < 100) { g.run(1); assert.equal(g.state.crouch, false, '공중에서는 선 채로'); }
    g.run(1);
    assert.equal(g.state.crouch, true, '착지하면 다시 앉는다');
  });

  test('머리 위가 막혀 있으면 앉은 채 Space를 눌러도(누르고 있어도) 뛰지 않는다', () => {
    const world = flatWorld(makeBox(-5, 1.5, -5, 5, 3, 5));
    const g = makePlayer(world);
    g.input.state.crouch = true;
    g.run(3);
    g.press();
    g.run(30);
    assert.equal(g.count('player:jump'), 0);
    assert.equal(g.state.crouch, true);
    assert.equal(g.state.onGround, true);
    // 키를 떼도 앉은 채
    g.input.state.crouch = false;
    g.input.state.jump = false;
    g.run(5);
    assert.equal(g.state.crouch, true);
  });

  test('Space와 앉기를 함께 누르고 있으면 선 채로 계속 뛰고, Space를 떼면 착지하며 앉는다', () => {
    const g = makePlayer(flatWorld());
    g.input.state.crouch = true;
    g.run(2);
    g.press();
    g.run(60 * 3, () => {});
    assert.ok(g.count('player:jump') >= 3);
    assert.equal(g.list('player:crouch').filter((e) => e.crouch).length, 1, '처음 앉은 뒤로 다시 앉지 않는다');
    g.input.state.jump = false;
    g.run(60);
    assert.equal(g.state.crouch, true);
    assert.equal(g.state.onGround, true);
  });

  test('Space와 앉기를 같은 틱에 누르면 예전처럼 앉아 뛰기가 된다', () => {
    const g = makePlayer(flatWorld());
    g.input.state.crouch = true;
    g.press(); g.input.state.jump = false;
    g.run(1);
    assert.equal(g.state.onGround, false);
    assert.equal(g.state.crouch, true);
  });

  test('이모트: Space로 취소, Space를 누르고 있으면 시작이 거부된다', () => {
    const g = makePlayer(flatWorld());
    assert.equal(g.player.startEmote('wave').ok, true);
    g.run(2);
    assert.equal(g.state.emote !== 0, true);
    g.press();
    assert.equal(g.state.emote, 0, 'input:jump로 바로 취소');
    assert.equal(g.list('player:emote').at(-1).reason, 'jump');
    g.run(1);
    assert.equal(g.count('player:jump'), 1);

    const h = makePlayer(flatWorld());
    h.input.state.jump = true;
    const denied = h.player.startEmote('wave');
    assert.equal(denied.ok, false);
    assert.equal(denied.reason, 'moving');
    assert.equal(h.state.emote, 0);
  });

  test('이모트가 시작된 뒤 자동 점프가 일어나면 점프 사유로 끝난다', () => {
    const g = makePlayer(flatWorld());
    assert.equal(g.player.startEmote('wave').ok, true);
    g.input.state.jump = true; // 키 이벤트 없이 상태만 켜진 경우(다른 입력 장치 등)
    g.run(1);
    assert.equal(g.state.emote, 0);
    assert.equal(g.list('player:emote').at(-1).reason, 'jump');
  });

  test('frozen이면 뛰지도 움직이지도 않지만 미끄러짐은 멈춘다. 입력을 끄거나 죽어도 뛰지 않는다', () => {
    const g = makePlayer(flatWorld());
    g.player.setFrozen(true);
    g.press();
    g.input.state.forward = true;
    g.state.vel[2] = -5;
    g.run(30);
    assert.equal(g.count('player:jump'), 0);
    assert.equal(g.state.speed, 0);
    g.player.setFrozen(false);
    g.input.enabled = false;
    g.run(5);
    assert.equal(g.count('player:jump'), 0);
    g.input.enabled = true;
    g.player.kill({});
    g.run(5);
    assert.equal(g.count('player:jump'), 0);
  });

  test('speedScale은 지면 목표 속도에 그대로 들어간다', () => {
    const g = makePlayer(flatWorld());
    g.player.setSpeedScale(0.5);
    g.input.state.forward = true;
    g.run(30);
    assert.ok(Math.abs(g.state.speed - WALK * 0.5) < 1e-6, `${g.state.speed}`);
    g.input.state.walk = true;
    g.run(30);
    assert.ok(Math.abs(g.state.speed - PLAYER.SLOW_WALK * 0.5) < 1e-6, `${g.state.speed}`);
  });

  test('spawn은 이동 기억을 지운다: 착지 직후 스폰해도 다음 점프는 버니합이 아니고 묵은 A/D도 잊는다', () => {
    const g = makePlayer(flatWorld());
    g.state.vel[2] = -6;
    g.press(); g.input.state.jump = false;
    g.input.state.right = true;
    g.run(1);
    while (!g.state.onGround) g.run(1);
    assert.ok(g.state.moveMem.sinceLand < MOVE.HOP_GRACE);
    assert.equal(g.state.moveMem.lastSign, 1);
    g.input.state.right = false;
    g.player.spawn({ x: 1, y: 0, z: 2 });
    assert.equal(g.state.speed, 0);
    assert.deepEqual(g.state.vel, [0, 0, 0]);
    assert.equal(g.state.moveMem.sinceLand, Infinity);
    assert.equal(g.state.moveMem.lastSign, 0);
    g.events.length = 0;
    g.press(); g.input.state.jump = false;
    g.run(1);
    assert.equal(g.list('player:jump')[0].hopped, false);
    // 스폰이 버퍼도 지운다
    const h = makePlayer(flatWorld());
    h.press(); h.input.state.jump = false;
    h.player.spawn({ x: 0, y: 0, z: 0 });
    h.run(2);
    assert.equal(h.count('player:jump'), 0);
  });

  test('월드 밖으로 떨어지면 스폰으로 돌아오고 체력은 유지된다', () => {
    const world = createWorld([makeBox(-1, -1, -1, 1, 0, 1)]);
    const g = makePlayer(world);
    g.player.damage(10);
    g.state.pos[0] = 50;
    g.state.onGround = false;
    g.run(60 * 4);
    assert.equal(g.count('player:fell'), 1);
    assert.equal(g.state.hp, PLAYER.HP - 10);
    assert.equal(g.state.pos[0], 0);
  });
});

describe('player + 트리거', () => {
  function triggerWorld(data) {
    const world = flatWorld(makeBox(30, 0, -5, 40, 0.5, 5));
    world.triggers = buildTriggers(data);
    return world;
  }

  test('world.triggers가 없으면 건너뛴다', () => {
    const g = makePlayer(flatWorld());
    g.run(5);
    assert.equal(g.count('player:pad') + g.count('player:portal') + g.count('player:secret'), 0);
  });

  test('발판: 올라서면 속도를 받아 뜨고 player:pad를 내며, 목표 지점에 내려앉는다', () => {
    const world = triggerWorld({ pads: [{ x: 0, y: 0, z: 0, w: 2, d: 2, target: [20, 0, 0], apex: 3 }] });
    const g = makePlayer(world, { x: 0, y: 0, z: 0 });
    g.run(1);
    const pads = g.list('player:pad');
    assert.equal(pads.length, 1);
    assert.equal(pads[0].pad.target[0], 20);
    assert.ok(Array.isArray(pads[0].pos));
    assert.equal(g.state.onGround, false);
    assert.ok(g.state.vel[1] > 0);
    assert.ok(g.state.speed > 0, 'state.speed에 발판 속도가 바로 보인다');
    let t = 0;
    while (!g.state.onGround && t++ < 400) g.run(1);
    assert.ok(Math.hypot(g.state.pos[0] - 20, g.state.pos[2]) < 0.5, `도착 ${g.state.pos}`);
  });

  test('MAX_SPEED보다 빠른 발판도 목표 근처에 떨어진다', () => {
    const world = triggerWorld({ pads: [{ x: 0, y: 0, z: 0, w: 2, d: 2, target: [28, 0, 0], apex: 0.8 }] });
    const g = makePlayer(world, { x: 0, y: 0, z: 0 });
    g.run(1);
    assert.ok(g.state.speed > MOVE.MAX_SPEED, `발판 수평 속도 ${g.state.speed}`);
    let t = 0;
    while (!g.state.onGround && t++ < 400) g.run(1);
    assert.ok(Math.abs(g.state.pos[0] - 28) < 0.5, `도착 ${g.state.pos}`);
  });

  test('포털: 위치·yaw를 옮기고 속도를 0으로, 카메라 보간(prev)도 맞춘다', () => {
    const world = triggerWorld({ portals: [{ x: 3, y: 0, z: 0, w: 2, h: 3, d: 2, to: { x: 35, y: 0.5, z: 1, rotY: 1.25 } }] });
    const g = makePlayer(world, { x: 0, y: 0, z: 0 });
    g.state.vel[0] = 5;
    g.input.state.right = true;
    g.state.yaw = 0;
    g.run(60, () => { if (g.count('player:portal')) g.input.state.right = false; });
    const ev = g.list('player:portal');
    assert.equal(ev.length, 1);
    assert.equal(ev[0].portal.to.x, 35);
    assert.deepEqual(ev[0].pos, [35, 0.5, 1]);
    assert.equal(g.state.yaw, 1.25);
    assert.equal(g.state.pos[0], 35);
    assert.equal(g.state.pos[1], 0.5);
    assert.equal(g.state.onGround, true);
    assert.equal(g.state.speed, 0);
  });

  test('포털을 지나는 틱의 카메라는 이전 자리를 거쳐 보간되지 않는다', () => {
    const world = triggerWorld({ portals: [{ x: 0, y: 0, z: 0, w: 2, h: 3, d: 2, to: { x: 35, y: 0.5, z: 0 } }] });
    const g = makePlayer(world, { x: 5, y: 0, z: 0 });
    g.player.tick(DT);
    g.state.pos[0] = 0.5; // 포털 안으로 옮긴다
    g.player.tick(DT);
    assert.equal(g.count('player:portal'), 1);
    g.player.frame(0, 0); // alpha = 0: 틱 시작 위치
    assert.equal(g.cam.position.x, 35, 'prev가 도착지여야 한다');
    assert.equal(g.state.yaw, 0, 'rotY가 없으면 시점은 그대로');
  });

  test('비밀 스팟: 들어가면 한 번 알리고, 스폰 뒤에는 다시 알린다', () => {
    const world = triggerWorld({ secrets: [{ id: 'roof', name: '옥상', x: 0, y: 0, z: 0, w: 4, h: 3, d: 4, points: 100 }] });
    const g = makePlayer(world, { x: 0, y: 0, z: 0 });
    g.run(10);
    const found = g.list('player:secret');
    assert.equal(found.length, 1);
    assert.equal(found[0].secret.id, 'roof');
    assert.ok(Array.isArray(found[0].pos));
    g.player.spawn({ x: 0, y: 0, z: 0 });
    g.run(5);
    assert.equal(g.count('player:secret'), 2);
  });

  test('죽었거나 frozen이면 트리거가 발동하지 않는다', () => {
    const data = { pads: [{ x: 0, y: 0, z: 0, w: 4, d: 4, vel: [0, 8, 0] }] };
    const dead = makePlayer(triggerWorld(data));
    dead.player.kill({});
    dead.run(5);
    assert.equal(dead.count('player:pad'), 0);
    const frozen = makePlayer(triggerWorld(data));
    frozen.player.setFrozen(true);
    frozen.run(5);
    assert.equal(frozen.count('player:pad'), 0);
    frozen.player.setFrozen(false);
    frozen.run(1);
    assert.equal(frozen.count('player:pad'), 1);
  });
});

/* ---------- input.js: 브라우저 없이 가짜 DOM으로 키·잠금만 확인 ---------- */

function fakeTarget() {
  const handlers = new Map();
  return {
    addEventListener(type, fn) { if (!handlers.has(type)) handlers.set(type, new Set()); handlers.get(type).add(fn); },
    removeEventListener(type, fn) { const s = handlers.get(type); if (s) s.delete(fn); },
    fire(type, e = {}) { const s = handlers.get(type); if (s) for (const fn of [...s]) fn(e); }
  };
}

async function withFakeDom(fn) {
  const saved = {};
  for (const k of ['window', 'document', 'navigator']) saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
  const win = fakeTarget(), doc = fakeTarget();
  win.innerWidth = 800; win.innerHeight = 600;
  doc.body = fakeTarget();
  doc.pointerLockElement = null;
  doc.fullscreenElement = null;
  const lockCalls = [];
  const nav = { keyboard: { lock(keys) { lockCalls.push(keys); return Promise.resolve(); }, unlock() {} } };
  const define = (k, value) => Object.defineProperty(globalThis, k, { value, configurable: true, writable: true });
  define('window', win); define('document', doc); define('navigator', nav);
  try {
    const { createInput } = await import('../js/engine/input.js');
    const el = fakeTarget();
    const bus = createBus();
    const events = [];
    bus.on('*', (name, data) => events.push({ name, data }));
    const input = createInput({ element: el, bus });
    const key = (type, code, extra = {}) => win.fire(type, { code, repeat: false, target: doc.body, preventDefault() {}, ...extra });
    await fn({ input, win, doc, el, key, events, lockCalls });
    input.dispose();
  } finally {
    for (const k of ['window', 'document', 'navigator']) {
      if (saved[k]) Object.defineProperty(globalThis, k, saved[k]);
      else delete globalThis[k];
    }
  }
}

describe('input', () => {
  test('KeyF는 input:inspect를 한 번 내고 키 반복으로 다시 내지 않는다', async () => {
    await withFakeDom(({ key, events }) => {
      key('keydown', 'KeyF');
      key('keydown', 'KeyF', { repeat: true });
      key('keyup', 'KeyF');
      assert.equal(events.filter((e) => e.name === 'input:inspect').length, 1);
    });
  });

  test('입력을 끄면 KeyF는 아무것도 하지 않는다', async () => {
    await withFakeDom(({ input, key, events }) => {
      input.setEnabled(false);
      key('keydown', 'KeyF');
      assert.equal(events.filter((e) => e.name === 'input:inspect').length, 0);
    });
  });

  test('Space: 누르는 동안 state.jump, 잠금을 잃으면 풀리고 키 반복으로는 다시 켜지지 않는다', async () => {
    await withFakeDom(({ input, doc, el, key, events }) => {
      doc.pointerLockElement = el;
      doc.fire('pointerlockchange');
      assert.equal(input.locked, true);
      key('keydown', 'Space');
      assert.equal(input.state.jump, true);
      assert.equal(events.filter((e) => e.name === 'input:jump').length, 1);
      key('keydown', 'Space', { repeat: true });
      assert.equal(events.filter((e) => e.name === 'input:jump').length, 1, '반복은 input:jump가 아니다');

      doc.pointerLockElement = null;
      doc.fire('pointerlockchange');
      assert.equal(input.locked, false);
      assert.equal(input.state.jump, false, '잠금을 잃으면 자동 점프가 멈춘다');
      key('keydown', 'Space', { repeat: true });
      assert.equal(input.state.jump, false, '계속 누르고 있어도 키 반복으로 다시 켜지지 않는다');
      key('keyup', 'Space');
      key('keydown', 'Space');
      assert.equal(input.state.jump, true, '새로 누르면 다시 켜진다');
      key('keyup', 'Space');
      assert.equal(input.state.jump, false);
    });
  });

  test('창 포커스를 잃어도 state.jump가 풀린다', async () => {
    await withFakeDom(({ input, win, key }) => {
      key('keydown', 'Space');
      win.fire('blur');
      assert.equal(input.state.jump, false);
    });
  });

  test('전체 화면 키 잠금 목록에 KeyF가 들어 있다', async () => {
    await withFakeDom(({ doc, lockCalls }) => {
      doc.fullscreenElement = {};
      doc.fire('fullscreenchange');
      assert.equal(lockCalls.length, 1);
      assert.ok(lockCalls[0].includes('KeyF'));
      assert.ok(lockCalls[0].includes('Space'));
    });
  });
});
