/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 턱 오르기·넘기(engine/mantle.js)의 높이 창·길 검사와 낙하 피해(engine/falldamage.js)의 곡선·면제,
 *          로컬 플레이어(player.js)에 붙인 동작(오르기·넘기·낙하 이벤트)을 확인한다.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { createBus } from '../js/core/bus.js';
import { createWorld, makeBox } from '../js/engine/physics.js';
import { createLocalPlayer } from '../js/engine/player.js';
import { findMantle, mantlePose, MANTLE } from '../js/engine/mantle.js';
import { fallDamage, createFallTracker, FALL } from '../js/engine/falldamage.js';

const DT = 1 / 60;
const floorBox = () => makeBox(-100, -1, -100, 100, 0, 100);
const world = (...extra) => createWorld([floorBox(), ...extra]);

describe('낙하 피해 곡선', () => {
  test('4 m → 0, 6 m → 25, 9 m → 62.5, 12 m → 100', () => {
    assert.equal(fallDamage(4), 0);
    assert.equal(fallDamage(6), 25);
    assert.equal(fallDamage(9), 62.5);
    assert.equal(fallDamage(12), 100);
  });
  test('4 m 이하는 0, 12 m 이상은 즉사, 사이는 직선', () => {
    assert.equal(fallDamage(0), 0);
    assert.equal(fallDamage(3.3), 0);
    assert.equal(fallDamage(-2), 0);
    assert.equal(fallDamage(NaN), 0);
    assert.equal(fallDamage(30), FALL.MAX);
    assert.equal(fallDamage(8), 50);
    assert.ok(fallDamage(4.01) > 0 && fallDamage(4.01) < 1);
  });
});

/** 높이 h에서 걸어 떨어지는 몸의 y 기록을 추적기에 넣는다 */
function dropFrom(fall, h, land = 0) {
  fall.step(h, true, true);
  let r = null;
  for (let y = h; y > land; y -= 0.5) r = fall.step(y, false, true) || r;
  return fall.step(land, true, false);
}

describe('낙하 추적기', () => {
  test('가장 높은 지점(점프 꼭대기)에서 착지까지 잰다', () => {
    const fall = createFallTracker(6);
    fall.step(6, true, true);
    fall.step(7.2, false, true);   // 뛰어오른 꼭대기
    fall.step(3, false, false);
    const r = fall.step(0, true, false);
    assert.equal(r.height, 7.2);
    assert.equal(r.damage, fallDamage(7.2));
    assert.equal(r.exempt, null);
  });
  test('땅에 붙어 있는 틱·공중 틱에는 결과가 없다', () => {
    const fall = createFallTracker(0);
    assert.equal(fall.step(0, true, true), null);
    assert.equal(fall.step(1, false, true), null);
  });
  test('발판 면제: 날아가 내려앉은 착지는 피해 없음, 다음 낙하는 다시 센다', () => {
    const fall = createFallTracker(0);
    fall.step(0, true, true);
    fall.exempt('pad');                 // 발판이 속도를 넣은 틱(아직 땅)
    fall.step(0, true, true);
    fall.step(10, false, true);
    const r = fall.step(0, true, false);
    assert.equal(r.damage, 0);
    assert.equal(r.exempt, 'pad');
    assert.equal(dropFrom(fall, 9).damage, 62.5);
  });
  test('포털 면제: 공중 출구에서 떨어져도 피해 없음', () => {
    const fall = createFallTracker(0);
    fall.reset(14);                     // 순간이동
    fall.exempt('portal');
    fall.step(10, false, false);
    const r = fall.step(0, true, false);
    assert.equal(r.damage, 0);
    assert.equal(r.exempt, 'portal');
  });
  test('면제 표시는 땅에 몇 틱 붙어 있으면 잊는다', () => {
    const fall = createFallTracker(0);
    fall.exempt('pad');
    for (let i = 0; i < 5; i++) fall.step(6, true, true);
    assert.equal(dropFrom(fall, 6).damage, 25);
  });
  test('턱 오르기(맨틀) 면제: 끝난 자리에서 다시 재고, 넘기는 넘기 전 바닥 높이에서 잰다', () => {
    const fall = createFallTracker(0);
    fall.reset(2);                      // 오르기 끝: 땅 위 2 m
    assert.equal(fall.step(2, true, false).height, 0);
    fall.reset(4.32, 3.3);              // 3.3 m 복도에서 1 m 난간을 넘었다
    fall.step(3, false, false);
    const r = fall.step(0, true, false);
    assert.ok(Math.abs(r.height - 3.3) < 1e-9, `높이 ${r.height}`);
    assert.equal(r.damage, 0);
  });
});

describe('턱 찾기(높이 창)', () => {
  const at = [0, 0, -0.6];
  for (const [h, kind] of [[0.3, null], [0.45, null], [0.5, 'climb'], [1.0, 'climb'], [1.5, 'climb'], [2.0, 'climb'], [2.1, null], [3, null]]) {
    test(`앞 ${h} m 턱 → ${kind || '없음'}`, () => {
      const p = findMantle(world(makeBox(-2, 0, -3, 2, h, -1)), at, 0, -1);
      assert.equal(p ? p.kind : null, kind);
      if (p) {
        assert.ok(Math.abs(p.to[1] - h) < 1e-9);
        assert.ok(p.to[2] < -1.3, '몸 전체가 턱 위에 올라선다');
      }
    });
  }
  test('얇은 난간(1 m)은 넘는다: 끝 자리는 난간 너머 공중', () => {
    const p = findMantle(world(makeBox(-2, 0, -1.1, 2, 1, -1)), at, 0, -1);
    assert.equal(p.kind, 'vault');
    assert.ok(p.to[2] < -1.1 - 0.35);
    assert.ok(p.to[1] > 1);
    assert.equal(p.floor, 0);
  });
  test('창턱(1 m) 위 1.2 m 구멍으로 넘어간다', () => {
    const p = findMantle(world(makeBox(-2, 0, -1.3, 2, 1, -1), makeBox(-2, 2.2, -1.3, 2, 3.6, -1)), at, 0, -1);
    assert.equal(p && p.kind, 'vault');
  });
  test('멀리 있는 턱, 머리 위 천장, 턱 위가 막힌 자리는 오르지 않는다', () => {
    assert.equal(findMantle(world(makeBox(-2, 0, -3, 2, 1, -1.6)), at, 0, -1), null);
    assert.equal(findMantle(world(makeBox(-2, 0, -3, 2, 1.5, -1), makeBox(-2, 2.2, -1, 2, 2.5, 1)), at, 0, -1), null);
    assert.equal(findMantle(world(makeBox(-2, 0, -3, 2, 1, -1), makeBox(-2, 1.6, -3, 2, 3, -1)), at, 0, -1), null);
  });
  test('공중에서는 발밑 바닥 기준: 바닥에서 2 m를 넘는 턱은 뛰어도 잡지 못한다', () => {
    const w = world(makeBox(-2, 0, -3, 2, 2.6, -1));
    assert.equal(findMantle(w, [0, 1.2, -0.6], 0, -1, { floor: 0 }), null);
    const low = world(makeBox(-2, 0, -3, 2, 1.8, -1));
    assert.equal(findMantle(low, [0, 1.0, -0.6], 0, -1, { floor: 0 }).kind, 'climb');
  });
  test('동작 길: 들어 올리는 동안 높이는 일정한 속도, 끝나면 to', () => {
    const p = findMantle(world(makeBox(-2, 0, -3, 2, 2, -1)), at, 0, -1);
    const out = [0, 0, 0];
    assert.equal(mantlePose(p, p.dur * MANTLE.LIFT_FRAC * 0.5, out), false);
    assert.ok(Math.abs(out[1] - 1) < 1e-9);
    assert.equal(mantlePose(p, p.dur, out), true);
    assert.deepEqual(out, p.to);
    // 점프 초속(6.3 m/s)보다 느리게 들어 올린다(부정행위 상승 검사)
    assert.ok(2 / (p.dur * MANTLE.LIFT_FRAC) < 6.3);
  });
});

/* ---------- player.js ---------- */

function makePlayer(w, spawn = { x: 0, y: 0, z: 0 }) {
  const bus = createBus();
  const events = [];
  bus.on('*', (name, data) => { events.push({ name, data }); });
  const input = {
    enabled: true,
    state: { forward: false, back: false, left: false, right: false, jump: false, walk: false, crouch: false, aim: false },
    consumeLook: () => ({ dx: 0, dy: 0 }),
    setEmoteLock() {}
  };
  const player = createLocalPlayer({ bus, input, getWorld: () => w });
  player.spawn(spawn);
  events.length = 0;
  const run = (ticks) => { for (let i = 0; i < ticks; i++) player.tick(DT); };
  const list = (name) => events.filter((e) => e.name === name).map((e) => e.data);
  return { bus, input, player, state: player.state, run, list };
}

describe('player: 턱 오르기·넘기', () => {
  test('W + Space로 1.8 m 상자에 오른다(점프로는 닿지 않는 높이)', () => {
    const g = makePlayer(world(makeBox(-2, 0, -3, 2, 1.8, -1)), { x: 0, y: 0, z: -0.6 });
    g.input.state.forward = true;
    g.input.state.jump = true;
    g.run(2);
    assert.ok(g.player.mantling, '동작 중');
    g.input.state.jump = false;
    g.input.state.forward = false;   // 오르기는 키를 떼도 끝까지 간다(계속 누르면 상자 너머로 걸어 떨어진다)
    g.run(60);
    assert.equal(g.list('player:mantle')[0].kind, 'climb');
    assert.equal(g.list('player:jump').length, 0, '점프하지 않았다');
    assert.ok(Math.abs(g.state.pos[1] - 1.8) < 1e-6, `y=${g.state.pos[1]}`);
    assert.equal(g.state.onGround, true);
    assert.equal(g.player.mantling, null);
  });
  test('앞으로 가지 않고 누르면 그냥 뛴다', () => {
    const g = makePlayer(world(makeBox(-2, 0, -3, 2, 1.0, -1)), { x: 0, y: 0, z: -0.6 });
    g.input.state.jump = true;
    g.run(1);
    assert.equal(g.list('player:mantle').length, 0);
    assert.equal(g.list('player:jump').length, 1);
  });
  test('난간을 넘어 3.3 m 아래로 떨어져도 낙하 피해가 없다(배틀로얄 켬)', () => {
    // 3.3 m 복도 바닥, 끝에 1 m 난간, 그 너머는 땅
    const g = makePlayer(world(makeBox(-5, 3, -5, 5, 3.3, -1), makeBox(-5, 3.3, -5.2, 5, 4.3, -5)), { x: 0, y: 3.3, z: -4.6 });
    g.player.setFallDamage(true);
    g.input.state.forward = true;
    g.input.state.jump = true;
    g.run(1);
    g.input.state.jump = false;
    g.run(120);
    assert.equal(g.list('player:mantle')[0].kind, 'vault');
    assert.ok(g.state.pos[1] < 0.01 && g.state.pos[2] < -5.2, `pos=${g.state.pos}`);
    assert.equal(g.list('player:fall').length, 0);
  });
  test('달려오면 한 걸음 앞(약 1 m)에서 눌러도 점프 대신 넘는다', () => {
    const g = makePlayer(world(makeBox(-5, 0, -8.2, 5, 1, -8)), { x: 0, y: 0, z: -2 });
    g.input.state.forward = true;
    while (g.state.pos[2] > -7.05) g.run(1);   // 몸 가장자리와 난간 사이 약 0.6 m(멈춰 있으면 0.55 m 밖)
    g.input.state.jump = true;
    g.run(1);
    assert.equal(g.list('player:jump').length, 0, '뛰지 않았다');
    assert.equal(g.list('player:mantle')[0].kind, 'vault');
  });
  test('뛰어오른 뒤 Space를 누르고 있으면 공중에서 턱을 잡는다(발밑 바닥 기준 2 m까지)', () => {
    const g = makePlayer(world(makeBox(-5, 0, -4, 5, 1.9, -1.6)), { x: 0, y: 0, z: 0 });
    g.input.state.jump = true;
    g.run(1);                                  // 제자리 점프
    assert.equal(g.list('player:jump').length, 1);
    g.input.state.forward = true;
    for (let i = 0; i < 40 && !g.list('player:mantle').length; i++) g.run(1);
    assert.equal(g.list('player:mantle').length, 1);
    g.input.state.jump = false;               // 올라선 뒤에도 누르고 있으면 다시 뛴다
    g.input.state.forward = false;
    g.run(60);
    assert.ok(Math.abs(g.state.pos[1] - 1.9) < 1e-6, `y=${g.state.pos[1]}`);
  });
});

describe('player: 낙하 피해', () => {
  const ledge = () => world(makeBox(-5, 0, -5, 5, 6, 5));
  test('켜면 6 m 낙하에 25 피해 이벤트', () => {
    const g = makePlayer(ledge(), { x: 4.5, y: 6, z: 0 });
    g.player.setFallDamage(true);
    g.state.yaw = -Math.PI / 2;      // +x(동쪽)으로 걷는다
    g.input.state.forward = true;
    g.run(150);
    const ev = g.list('player:fall');
    assert.equal(ev.length, 1);
    assert.ok(Math.abs(ev[0].height - 6) < 1e-6, `높이 ${ev[0].height}`);
    assert.ok(Math.abs(ev[0].damage - 25) < 1e-6);
  });
  test('끄면(기본, 배틀로얄이 아닌 모드) 이벤트가 없다', () => {
    const g = makePlayer(ledge(), { x: 4.5, y: 6, z: 0 });
    g.state.yaw = -Math.PI / 2;
    g.input.state.forward = true;
    g.run(150);
    assert.equal(g.player.fallDamage, false);
    assert.equal(g.list('player:fall').length, 0);
  });
});
