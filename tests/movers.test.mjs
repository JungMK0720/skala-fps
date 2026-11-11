/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 움직이는 지형(engine/movers.js) 테스트. 왕복 운동 표, 충돌체 옮기기, 위에 선 몸 실어 나르기, 옆에서 밀기,
 *          총알 판정, 맵 데이터 검사와 kit 뒤집기, 가까이 오면 열리는 문을 확인한다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIMITS, PLAYER, TICK_DT } from '../js/core/consts.js';
import { moveCharacter, raycastWorld, lineOfSight } from '../js/engine/physics.js';
import {
  MOVER_MAX_SPEED, MOVER_MIN_TRAVEL, normalizeMover, normalizeMovers, moverProgress, moverOffset, moverPeakSpeed, moverBox, moverSweep,
  createMovers, stepMovers, carryBody,
  DOOR_DEFAULTS, DOOR_LIMITS, DOOR_CLEARANCE, normalizeDoor, doorNear, doorPassable
} from '../js/engine/movers.js';
import { buildCollision, validateMap } from '../js/maps/collision.js';
import { buildNavGrid } from '../js/game/navgrid.js';
import { rotate180, mirrorX, mirrorZ } from '../js/maps/kit.js';
import { checkMap } from '../tools/check-maps.mjs';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);

const SLED = { id: 'sled', x: -4, y: 0, z: 0, w: 2, h: 2.2, d: 0.5, mat: 'steel', axis: 'x', dist: 8, period: 12, hold: 1.5 };
const LIFT = { id: 'lift', x: 6, y: -3, z: 6, w: 2.6, h: 3.2, d: 2.6, axis: 'y', dist: 2.8, period: 10, hold: 2 };

const spawns = {
  owner: [-12, -11, -10, -9].map((x) => ({ x, z: -8, rotY: 0 })),
  charterer: [12, 11, 10, 9].map((x) => ({ x, z: 8, rotY: 0 }))
};
const mapWith = (movers, solids = []) => ({ id: 'movers_test', size: { x: 30, z: 20 }, spawns, solids, movers });

/** 맵을 만들고 t초까지 틱을 돌린다 */
function worldAt(data, t = 0) {
  const col = buildCollision(data);
  stepMovers(col.world, t);
  return col;
}

test('운동 표: 쉬는 자리에서 hold초, 부드럽게 가서 끝에서 hold초, 다시 돌아온다', () => {
  const s = normalizeMover(SLED);
  assert.equal(s.travel, 4.5);
  assert.equal(moverProgress(s, 0), 0);
  assert.equal(moverProgress(s, 1.49), 0, '쉬는 동안은 움직이지 않는다');
  near(moverProgress(s, 1.5 + 2.25), 0.5);                       // 가는 길 한가운데
  assert.equal(moverProgress(s, 6), 1);
  assert.equal(moverProgress(s, 7.4), 1, '끝에서도 쉰다');
  near(moverProgress(s, 7.5 + 2.25), 0.5);                       // 돌아오는 길 한가운데
  near(moverProgress(s, 12), 0);
  near(moverProgress(s, 12 * 7 + 3.75), 0.5);                    // 주기마다 같다
  near(moverProgress(s, -12 + 3.75), 0.5);                       // 음수 시각도 같은 주기
  near(moverOffset(s, 6), 8);
  // 출발과 도착은 느리다(smoothstep): 이동 시간의 10% 지점에서 거리의 10%보다 적게 갔다
  assert.ok(moverProgress(s, 1.5 + 0.45) < 0.1);
  // 단조 증가
  let prev = -1;
  for (let t = 1.5; t <= 6; t += 0.05) { const p = moverProgress(s, t); assert.ok(p >= prev); prev = p; }
});

test('phase는 주기를 그만큼 앞당기고, dist가 음수면 반대쪽으로 간다', () => {
  const s = normalizeMover({ ...SLED, phase: 0.5 });
  assert.equal(moverProgress(s, 0), 1, '반 주기 앞: 끝에서 쉬는 중');
  const back = normalizeMover({ ...SLED, dist: -8 });
  near(moverOffset(back, 6), -8);
  assert.equal(normalizeMover({ ...SLED, phase: 1.25 }).phase, 0.25);
  assert.equal(normalizeMover({ ...SLED, phase: -0.25 }).phase, 0.75);
});

test('가장 빠른 순간의 속력은 1.5 × 거리 ÷ 편도 시간', () => {
  const s = normalizeMover(SLED);
  near(moverPeakSpeed(s), (1.5 * 8) / 4.5);
  // 수치 미분으로 확인
  let peak = 0;
  for (let t = 1.5; t < 6; t += 0.001) peak = Math.max(peak, (moverOffset(s, t + 0.001) - moverOffset(s, t)) / 0.001);
  near(peak, moverPeakSpeed(s), 0.01);
});

test('잘못된 항목은 버리고 기본값을 채운다', () => {
  assert.equal(normalizeMover(null), null);
  assert.equal(normalizeMover({ ...SLED, axis: 'w' }), null);
  assert.equal(normalizeMover({ ...SLED, dist: 0 }), null);
  assert.equal(normalizeMover({ ...SLED, w: 0 }), null);
  assert.equal(normalizeMover({ ...SLED, period: 3, hold: 1.5 }), null, '쉬는 시간이 반 주기를 다 쓰면 움직일 수 없다');
  const s = normalizeMover({ x: 1, z: 2, w: 1, h: 1, d: 1, axis: 'z', dist: 3, period: 8 }, 4);
  assert.deepEqual([s.id, s.y, s.mat, s.hold, s.travel, s.phase], ['mover4', 0, 'steel', 1, 3, 0]);
  assert.equal(normalizeMover({ ...SLED, mat: 'unobtainium' }).mat, 'steel');
  const many = Array.from({ length: LIMITS.MOVERS + 3 }, (_, i) => ({ ...SLED, id: 'm' + i }));
  assert.equal(normalizeMovers(many).length, LIMITS.MOVERS);
  assert.deepEqual(normalizeMovers('nope'), []);
});

test('moverBox·moverSweep: 쉬는 자리, 옮긴 자리, 지나가는 부피', () => {
  const s = normalizeMover(SLED);
  assert.deepEqual(moverBox(s, 0), { minX: -5, maxX: -3, minY: 0, maxY: 2.2, minZ: -0.25, maxZ: 0.25 });
  assert.deepEqual(moverBox(s, 8), { minX: 3, maxX: 5, minY: 0, maxY: 2.2, minZ: -0.25, maxZ: 0.25 });
  assert.deepEqual(moverSweep(s), { minX: -5, maxX: 5, minY: 0, maxY: 2.2, minZ: -0.25, maxZ: 0.25 });
  const l = normalizeMover(LIFT);
  near(moverBox(l, 2.8).maxY, 3);
  near(moverSweep(l).minY, -3);
});

test('buildCollision: 움직이는 지형은 world.movers와 world.colliders에 들어가고 solidColliders에는 없다', () => {
  const col = buildCollision(mapWith([SLED, LIFT], [{ type: 'box', x: 0, y: 0, z: -6, w: 2, h: 2, d: 2, mat: 'concrete' }]));
  assert.equal(col.movers.list.length, 2);
  assert.equal(col.world.movers, col.movers);
  assert.equal(col.solidColliders.length, 1);
  const dyn = col.world.colliders.filter((c) => c.dynamic);
  assert.equal(dyn.length, 2);
  assert.deepEqual(dyn.map((c) => c.tag), ['mover', 'mover']);
  assert.equal(buildCollision(mapWith(undefined)).movers.empty, true);
});

test('stepMovers: 충돌체가 그 시각의 자리로 옮겨지고, 길 찾기 칸은 움직이는 지형을 무시한다', () => {
  const data = mapWith([SLED]);
  const col = buildCollision(data);
  const c = col.movers.list[0].collider;
  stepMovers(col.world, 0);
  assert.deepEqual([c.minX, c.maxX], [-5, -3]);
  assert.equal(col.movers.list[0].prevOff, 0);
  stepMovers(col.world, 6);
  assert.deepEqual([c.minX, c.maxX], [3, 5]);
  assert.equal(col.movers.list[0].prevOff, 0, '직전 자리를 남긴다');
  assert.equal(col.movers.list[0].off, 8);
  // 격자에 들어 있지 않으므로 어느 자리에서든 질의에 걸린다
  assert.ok(col.world.query(3.5, -0.1, 4.5, 0.1).includes(c));
  assert.ok(!col.world.query(-4.5, -0.1, -3.5, 0.1).includes(c));
  // 내비: 쉬는 자리도 걸을 수 있는 칸이다
  const nav = buildNavGrid(data);
  const n = nav.nodeAt({ x: -4, y: 0, z: 0 }, false);
  assert.ok(n >= 0);
  const q = nav.node(n);
  assert.ok(Math.hypot(q.x + 4, q.z) < 1, '상자가 쉬는 자리에도 노드가 있다');
});

test('처음 stepMovers는 직전 자리도 지금 자리로 맞춘다(맵을 불러오자마자 실려 가지 않는다)', () => {
  const col = buildCollision(mapWith([SLED]));
  stepMovers(col.world, 6);
  const m = col.movers.list[0];
  assert.equal(m.off, 8);
  assert.equal(m.prevOff, 8);
  const body = { pos: [4, 2.2, 0], vel: [0, 0, 0], onGround: true };
  carryBody(col.world, body);
  assert.deepEqual(body.pos, [4, 2.2, 0]);
});

test('총알은 지금 자리의 상자에 맞고, 떠난 자리는 지나간다', () => {
  const col = worldAt(mapWith([SLED]), 0);
  const shoot = (x) => raycastWorld(col.world, [x, 1, -5], [0, 0, 1], 20);
  const a = shoot(-4);
  assert.ok(a && a.collider.dynamic, '쉬는 자리에서 맞는다');
  near(a.dist, 4.75);
  assert.equal(shoot(4), null, '아직 오지 않은 자리');
  stepMovers(col.world, 6);
  assert.equal(shoot(-4), null, '떠난 자리');
  assert.ok(shoot(4).collider.dynamic);
});

test('시야 검사는 움직이는 지형에 막히지만, 거르면(방장의 벽 가림 검사) 통과한다', () => {
  const col = worldAt(mapWith([SLED], [{ type: 'box', x: 8, y: 0, z: 0, w: 1, h: 3, d: 6, mat: 'brick' }]), 0);
  const a = [-4, 1, -5], b = [-4, 1, 5];
  assert.equal(lineOfSight(col.world, a, b), false, '쉬는 자리의 상자가 가린다');
  assert.equal(lineOfSight(col.world, a, b, { filter: (c) => !c.dynamic }), true, '움직이는 지형을 빼면 보인다');
  assert.equal(lineOfSight(col.world, [6, 1, 0], [10, 1, 0], { filter: (c) => !c.dynamic }), false, '고정 벽은 그대로 가린다');
  stepMovers(col.world, 6);
  assert.equal(lineOfSight(col.world, a, b), true, '상자가 떠난 뒤에는 보인다');
});

test('수평으로 움직이는 상자는 길에 선 몸을 밀고 간다', () => {
  const col = worldAt(mapWith([SLED]), 0);
  const body = { pos: [-1, 0, 0], vel: [0, 0, 0], onGround: true };
  let maxStep = 0;
  for (let t = 0; t <= 6; t += TICK_DT) {
    stepMovers(col.world, t);
    const x0 = body.pos[0];
    carryBody(col.world, body);
    moveCharacter(col.world, body, { x: 0, z: 0 }, TICK_DT);
    maxStep = Math.max(maxStep, Math.abs(body.pos[0] - x0));
  }
  const c = col.movers.list[0].collider;
  assert.ok(body.pos[0] >= c.maxX + PLAYER.RADIUS - 0.01, `몸이 상자 앞에 있다: ${body.pos[0]} / ${c.maxX}`);
  assert.ok(body.pos[0] < c.maxX + PLAYER.RADIUS + 0.1);
  assert.ok(maxStep < 0.12, `한 틱에 밀리는 거리 ${maxStep}`);
  assert.equal(body.pos[1], 0);
  assert.ok(body.onGround);
});

test('위에 선 몸은 수평으로 같이 실려 간다', () => {
  const cart = { ...SLED, h: 1, d: 2 };
  const col = worldAt(mapWith([cart]), 0);
  const body = { pos: [-4, 1, 0], vel: [0, 0, 0], onGround: true };
  for (let t = 0; t <= 6; t += TICK_DT) {
    stepMovers(col.world, t);
    carryBody(col.world, body);
    moveCharacter(col.world, body, { x: 0, z: 0 }, TICK_DT);
    assert.ok(body.onGround, `t=${t.toFixed(2)}에 떨어졌다`);
  }
  near(body.pos[0], 4, 0.02);
  near(body.pos[1], 1, 1e-6);
});

test('리프트(바닥에 묻힌 기둥): 올라갈 때도 내려올 때도 발이 붙어 있다', () => {
  const col = worldAt(mapWith([LIFT]), 0);
  const body = { pos: [6, 0.2, 6], vel: [0, 0, 0], onGround: true };
  let stepUps = 0, top = 0;
  for (let t = 0; t <= 10; t += TICK_DT) {
    stepMovers(col.world, t);
    carryBody(col.world, body);
    const ev = moveCharacter(col.world, body, { x: 0, z: 0 }, TICK_DT);
    if (ev.stepUp > 0.02) stepUps++;
    assert.ok(body.onGround, `t=${t.toFixed(2)}에 발이 떨어졌다`);
    near(body.pos[1], col.movers.list[0].collider.maxY, 1e-6);
    top = Math.max(top, body.pos[1]);
  }
  near(top, 3, 1e-6);
  near(body.pos[1], 0.2, 0.01);
  assert.equal(stepUps, 0, '턱을 오른 것으로 치지 않는다(카메라가 출렁이지 않게)');
});

test('리프트 옆 바닥에서는 실려 가지 않고, 올라온 기둥은 벽이 된다', () => {
  const col = worldAt(mapWith([LIFT]), 0);
  const beside = { pos: [3.5, 0, 6], vel: [0, 0, 0], onGround: true };
  for (let t = 0; t <= 5; t += TICK_DT) {
    stepMovers(col.world, t);
    carryBody(col.world, beside);
    moveCharacter(col.world, beside, { x: 0, z: 0 }, TICK_DT);
  }
  assert.deepEqual(beside.pos, [3.5, 0, 6]);
  // 기둥이 올라와 있는 동안 걸어 들어가면 막힌다
  const walker = { pos: [3.5, 0, 6], vel: [0, 0, 0], onGround: true };
  for (let i = 0; i < 60; i++) moveCharacter(col.world, walker, { x: PLAYER.WALK, z: 0 }, TICK_DT);
  assert.ok(walker.pos[0] < 6 - 1.3 - PLAYER.RADIUS + 0.01, `기둥 옆면에서 멈춘다: ${walker.pos[0]}`);
});

test('내려오는 셔터는 문턱에 선 몸을 옆으로 밀어낸다(끼이지 않는다)', () => {
  // 문(폭 2.4) 위에 숨어 있다가 내려오는 얇은 판. 쉬는 자리 = 닫힘
  const shutter = { id: 'shutter', x: 0, y: 0, z: 0, w: 0.2, h: 2.6, d: 2.4, axis: 'y', dist: 2.6, period: 14, hold: 4 };
  const col = worldAt(mapWith([shutter]), 7);        // 끝에서 쉬는 중 = 열림
  const body = { pos: [0, 0, 0], vel: [0, 0, 0], onGround: true };
  for (let t = 7; t <= 14; t += TICK_DT) {
    stepMovers(col.world, t);
    carryBody(col.world, body);
    moveCharacter(col.world, body, { x: 0, z: 0 }, TICK_DT);
  }
  assert.ok(Math.abs(body.pos[0]) >= 0.1 + PLAYER.RADIUS - 0.01, `판 밖으로 밀려났다: ${body.pos[0]}`);
  assert.ok(Math.abs(body.pos[0]) < 1);
  assert.equal(body.pos[1], 0);
});

test('시계가 튀어 한 틱에 너무 많이 움직였으면 실어 나르지 않는다', () => {
  const cart = { ...SLED, h: 1, d: 2 };
  const col = worldAt(mapWith([cart]), 0);
  const body = { pos: [-4, 1, 0], vel: [0, 0, 0], onGround: true };
  stepMovers(col.world, 6);                           // 6초를 건너뜀: 8 m 이동
  const m = carryBody(col.world, body);
  assert.ok(m, '서 있던 상자는 알려 준다');
  assert.deepEqual(body.pos, [-4, 1, 0]);
});

test('validateMap: movers 형식·한도·속도·범위를 검사한다', () => {
  const ok = validateMap(mapWith([SLED, LIFT]));
  assert.deepEqual(ok.warnings, []);
  assert.ok(ok.ok);
  const warn = (m) => validateMap(mapWith([m])).warnings.join('\n');
  assert.match(warn({ ...SLED, axis: 'q' }), /axis/);
  assert.match(warn({ ...SLED, dist: 0 }), /dist/);
  assert.match(warn({ ...SLED, period: 0 }), /period/);
  assert.match(warn({ ...SLED, mat: 'jelly' }), /unknown mat/);
  assert.match(warn({ ...SLED, period: 6, hold: 2 }), new RegExp(`< ${MOVER_MIN_TRAVEL}`));
  assert.match(warn({ ...SLED, dist: 12, period: 8, hold: 1 }), new RegExp(`> ${MOVER_MAX_SPEED}`));
  assert.match(warn({ ...SLED, dist: 20, period: 40 }), /leaves size/);
  assert.match(validateMap(mapWith([SLED, { ...LIFT, id: 'sled' }])).warnings.join('\n'), /duplicate id/);
  const tooMany = validateMap(mapWith(Array.from({ length: LIMITS.MOVERS + 1 }, (_, i) => ({ ...SLED, id: 'm' + i }))));
  assert.ok(!tooMany.ok);
  assert.match(tooMany.errors.join('\n'), /movers 9 > limit 8/);
  assert.match(validateMap({ ...mapWith([]), movers: {} }).errors.join('\n'), /movers must be an array/);
});

test('kit 뒤집기: 자리와 가는 방향을 함께 뒤집고 id에 꼬리표를 붙인다', () => {
  const [r] = rotate180([SLED]);
  assert.deepEqual([r.x, r.z, r.dist, r.axis, r.id], [4, 0, -8, 'x', 'sled_r']);
  assert.equal(r.rotY, undefined, '스폰이 아니므로 rotY를 붙이지 않는다');
  const [mx] = mirrorX([SLED]);
  assert.deepEqual([mx.x, mx.dist, mx.id], [4, -8, 'sled_mx']);
  const [mz] = mirrorZ([SLED]);
  assert.deepEqual([mz.x, mz.dist, mz.id], [-4, 8, 'sled_mz'], 'z로 뒤집으면 x 방향 이동은 그대로다');
  const zSled = { ...SLED, axis: 'z', z: 3 };
  assert.deepEqual([mirrorZ([zSled])[0].z, mirrorZ([zSled])[0].dist], [-3, -8]);
  const [lift] = rotate180([LIFT]);
  assert.deepEqual([lift.x, lift.z, lift.dist], [-6, -6, 2.8], '위아래 이동은 뒤집지 않는다');
  // 원본은 그대로
  assert.equal(SLED.dist, 8);
  // 돌린 쌍은 같은 시각에 서로 대칭인 자리에 있다
  const a = normalizeMover(SLED), b = normalizeMover(r);
  for (const t of [0, 2, 3.75, 6, 9]) near(a.x + moverOffset(a, t), -(b.x + moverOffset(b, t)));
});

/* ---------------- 문(가까이 오면 열리는 움직이는 지형) ---------------- */

// 동서로 놓인 벽(z 0)의 문간 하나: 문간 x -0.9 ~ 0.9, 문짝은 동쪽 벽 속으로 1.8 m 들어간다
const DOOR = { id: 'door', x: 0, y: 0, z: 0, w: 1.8, h: 2.2, d: 0.1, mat: 'paper', axis: 'x', dist: 1.8, door: true };
const DOOR_WALL = [
  { type: 'box', x: -3.45, y: 0, z: 0, w: 5.1, h: 3, d: 0.3, mat: 'plaster' },
  { type: 'box', x: 3.45, y: 0, z: 0, w: 5.1, h: 3, d: 0.3, mat: 'plaster' },
  { type: 'box', x: 0, y: 2.2, z: 0, w: 1.8, h: 0.8, d: 0.3, mat: 'plaster' }
];

test('문: door 칸은 기본값을 채우고 범위를 벗어난 값은 자른다. 주기는 필요 없다', () => {
  assert.equal(normalizeDoor(undefined), null);
  assert.equal(normalizeDoor(false), null);
  assert.deepEqual(normalizeDoor(true), { ...DOOR_DEFAULTS });
  assert.deepEqual(normalizeDoor({ range: 2.5, open: 0.4 }), { ...DOOR_DEFAULTS, range: 2.5, open: 0.4 });
  assert.deepEqual(normalizeDoor({ range: 99, open: 0, close: 99, linger: -1 }),
    { range: DOOR_LIMITS.maxRange, open: DOOR_LIMITS.minTime, close: DOOR_LIMITS.maxTime, linger: 0 });
  const s = normalizeMover(DOOR);
  assert.deepEqual([s.period, s.hold, s.phase, s.travel], [0, 0, 0, DOOR_DEFAULTS.open]);
  assert.deepEqual(s.door, { ...DOOR_DEFAULTS });
  assert.equal(moverProgress(s, 123.4), 0, '시각만으로는 움직이지 않는다');
  assert.equal(moverOffset(s, 5), 0);
  assert.equal(normalizeMover(SLED).door, null, '주기로 움직이는 지형은 문이 아니다');
  assert.equal(normalizeMover({ ...DOOR, dist: 0 }), null);
  assert.ok(normalizeMover({ ...DOOR, axis: 'y', dist: 2.3 }), '위아래로 여는 문');
  assert.equal(createMovers([DOOR, SLED]).doors, 1);
});

test('문: 다 열리면 지나갈 수 있어야 한다(옆으로, 위로, 아래로)', () => {
  const pass = (m) => doorPassable(normalizeMover({ ...DOOR, ...m }));
  assert.equal(pass({}), true);
  assert.equal(pass({ dist: -1.8 }), true);
  assert.equal(pass({ dist: 1.2 }), false, '문짝이 문간에 남는다');
  assert.equal(pass({ w: 0.1, d: 1.8, axis: 'z', dist: -1.8 }), true);
  assert.equal(pass({ w: 0.1, d: 1.8, axis: 'z', dist: 1 }), false);
  assert.equal(pass({ axis: 'y', dist: DOOR_CLEARANCE }), true);
  assert.equal(pass({ axis: 'y', dist: 1.7 }), false, '머리가 걸린다');
  assert.equal(pass({ axis: 'y', dist: -2.2 }), true, '바닥 속으로 다 내려간다');
  assert.equal(pass({ axis: 'y', dist: -1.5 }), false, '윗부분이 턱으로 남는다');
});

test('문: 닫힌 문짝에서 잰 거리로 사람을 알아보고, 다른 층은 세지 않는다', () => {
  const s = normalizeMover({ ...DOOR, door: { range: 1.5 } });
  assert.equal(doorNear(s, [[0, 0, 1.4]]), true);
  assert.equal(doorNear(s, [[0, 0, 1.7]]), false);
  assert.equal(doorNear(s, [[0.9 + 1.4, 0, 0]]), true, '문짝 끝에서 잰다');
  assert.equal(doorNear(s, [[0.9 + 1.2, 0, 1.2]]), false, '모서리에서는 대각선 거리');
  assert.equal(doorNear(s, [{ x: 0, y: 0, z: -1 }]), true, '{ x, y, z }도 받는다');
  assert.equal(doorNear(s, [new Float32Array([0, 0, 1])]), true);
  assert.equal(doorNear(s, [[0, 3.2, 0.5]]), false, '위층');
  assert.equal(doorNear(s, [[0, -2, 0.5]]), false, '아래층');
  assert.equal(doorNear(s, [[0, 1.1, 0.5]]), true, '뛰어오른 사람');
  assert.equal(doorNear(s, [null, [20, 0, 20], [0, 0, 0.5]]), true);
  assert.equal(doorNear(s, []), false);
  assert.equal(doorNear(s, null), false);
  assert.equal(doorNear(normalizeMover(SLED), [[-4, 0, 0]]), false, '문이 아니면 늘 false');
});

test('문: 사람이 오면 open초에 열리고, 떠나면 linger초 뒤 close초에 닫힌다. 시계가 멈추면 문도 멈춘다', () => {
  const col = buildCollision(mapWith([{ ...DOOR, door: { range: 1.5, open: 0.25, close: 0.5, linger: 0.6 } }], DOOR_WALL));
  const m = col.movers.list[0];
  const here = [[0, 0, 1]], away = [[0, 0, 6]];
  stepMovers(col.world, 10, here);
  assert.equal(m.off, 0, '처음 부를 때는 흐른 시간이 없다');
  let t = 10;
  const run = (sec, bodies) => { for (let i = Math.round(sec / TICK_DT); i > 0; i--) { t += TICK_DT; stepMovers(col.world, t, bodies); } };
  run(0.125, here);
  near(m.open, 0.5, 0.05);
  assert.ok(m.off > 1.8 * 0.7 && m.off < 1.8, `빨리 열리기 시작한다: ${m.off}`);
  run(0.2, here);
  assert.equal(m.open, 1);
  near(m.off, 1.8);
  near(m.collider.minX, 0.9);                        // 문짝이 동쪽 벽 속에 있다
  run(1, here);
  assert.equal(m.open, 1, '사람이 있는 동안은 닫히지 않는다');
  run(0.5, away);
  assert.equal(m.open, 1, 'linger가 지나기 전에는 그대로다');
  run(0.2, away);
  assert.ok(m.open < 1 && m.open > 0, `닫히는 중: ${m.open}`);
  const paused = m.open;
  for (let i = 0; i < 30; i++) stepMovers(col.world, t, away);   // 시계가 멈춤(연습장 일시정지)
  assert.equal(m.open, paused);
  run(0.1, here);
  assert.ok(m.open > paused, '닫히다가도 사람이 오면 다시 열린다');
  run(0.3, here);
  run(2, away);
  assert.equal(m.open, 0);
  assert.equal(m.off, 0);
  near(m.collider.minX, -0.9);
  run(1, null);
  assert.equal(m.open, 0, '사람 목록이 없으면 닫힌 채다');
  // 시계가 크게 튀어도 한 번에 0.25초만 진행한다
  stepMovers(col.world, t + 500, here);
  assert.equal(m.open, 1);
  stepMovers(col.world, t + 400, here);
  assert.equal(m.open, 1, '시계가 뒤로 가면 진행하지 않는다');
});

test('문: 닫혀 있으면 사람·총알·시야를 막고, 다가가면 열려 지나간다', () => {
  const col = buildCollision(mapWith([DOOR], DOOR_WALL));
  stepMovers(col.world, 0, null);
  const eyeA = [0, 1.5, -3], eyeB = [0, 1.5, 3];
  assert.equal(lineOfSight(col.world, eyeA, eyeB), false, '닫힌 문 너머는 보이지 않는다');
  assert.ok(raycastWorld(col.world, eyeA, [0, 0, 1], 10).collider.dynamic, '총알은 문짝에 맞는다');
  assert.equal(lineOfSight(col.world, eyeA, eyeB, { filter: (c) => !c.dynamic }), true, '방장의 벽 가림 검사는 문을 빼고 본다');
  // 아무도 알아보지 않으면(목록 없음) 문에 막힌다
  const blocked = { pos: [0, 0, -3], vel: [0, 0, 0], onGround: true };
  for (let i = 0; i < 90; i++) { stepMovers(col.world, i * TICK_DT, null); moveCharacter(col.world, blocked, { x: 0, z: PLAYER.WALK }, TICK_DT); }
  assert.ok(blocked.pos[2] < -0.05 - PLAYER.RADIUS + 0.02, `문 앞에서 멈춘다: ${blocked.pos[2]}`);
  // 걸어오는 사람을 알아보면 열려서 그대로 지나간다
  const col2 = buildCollision(mapWith([DOOR], DOOR_WALL));
  const walker = { pos: [0, 0, -4], vel: [0, 0, 0], onGround: true };
  let slowest = Infinity;
  for (let i = 0; i < 120; i++) {
    stepMovers(col2.world, i * TICK_DT, [walker.pos]);
    const z0 = walker.pos[2];
    moveCharacter(col2.world, walker, { x: 0, z: PLAYER.WALK }, TICK_DT);
    if (i > 20 && z0 < 1) slowest = Math.min(slowest, (walker.pos[2] - z0) / TICK_DT);
  }
  assert.ok(walker.pos[2] > 3, `문을 지나갔다: ${walker.pos[2]}`);
  assert.ok(slowest > PLAYER.WALK * 0.9, `걷는 속도 그대로 지나간다: ${slowest}`);
  // 문을 지난 사람이 아직 가까이 있어 문은 열려 있다
  stepMovers(col2.world, 120 * TICK_DT, [[0, 0, 0.5]]);
  assert.equal(lineOfSight(col2.world, eyeA, eyeB), true, '열린 문으로는 보인다');
});

test('validateMap: 문은 주기·속도 검사를 받지 않고, door 값과 열림 폭을 검사한다', () => {
  assert.deepEqual(validateMap(mapWith([DOOR], DOOR_WALL)).warnings, []);
  assert.deepEqual(validateMap(mapWith([{ ...DOOR, door: { range: 2, open: 0.2, close: 0.4, linger: 1 } }], DOOR_WALL)).warnings, []);
  const warn = (m) => validateMap(mapWith([{ ...DOOR, ...m }], DOOR_WALL)).warnings.join('\n');
  assert.match(warn({ door: 'yes' }), /door must be true or/);
  assert.match(warn({ door: { range: 0.2 } }), /door\.range must be/);
  assert.match(warn({ door: { open: 9 } }), /door\.open must be/);
  assert.match(warn({ door: { linger: -1 } }), /door\.linger must be/);
  assert.match(warn({ dist: 1 }), /must clear its doorway/);
  assert.match(warn({ axis: 'y', dist: 1.5 }), /rises only/);
  assert.match(warn({ axis: 'y', dist: -1 }), /stays above the floor/);
  assert.match(warn({ axis: 'q' }), /axis/);
  assert.doesNotMatch(warn({}), /peak speed|travels one way|period/);
});

test('검사기: 옆으로 여는 문은 들어갈 벽이 있어야 하고, 문간 앞뒤에 설 자리가 있어야 한다', () => {
  const run = (movers, solids) => checkMap('door_test', mapWith(movers, solids));
  const ok = run([DOOR], DOOR_WALL);
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.movers.map((m) => [m.id, m.axis, m.dist, !!m.door]), [['door', 'x', 1.8, true]]);
  // 벽 없이 여는 문: 문짝이 사람이 서는 자리를 쓸고 지나간다
  assert.match(run([DOOR], []).errors.join('\n'), /slides into open space/);
  // 문짝보다 짧은 벽: 문짝이 벽 밖으로 삐져나온다
  const stub = { type: 'box', x: 1.4, y: 0, z: 0, w: 1, h: 3, d: 0.3, mat: 'plaster' };
  assert.match(run([DOOR], [DOOR_WALL[0], stub]).errors.join('\n'), /passes through solids\[1\]/);
  // 문 바로 앞을 가구가 막고 있다
  const desk = { type: 'box', x: 0, y: 0, z: 0.7, w: 1.6, h: 1, d: 0.8, mat: 'wood' };
  assert.match(run([DOOR], [...DOOR_WALL, desk]).errors.join('\n'), /no standing room on its \+z side/);
  // 문간에 스폰이 있다
  const data = mapWith([DOOR], DOOR_WALL);
  const onDoor = checkMap('door_test', { ...data, spawns: { ...data.spawns, ffa: [{ x: 0, z: 0.2, rotY: 0 }] } });
  assert.match(onDoor.errors.join('\n'), /spawns\.ffa\[0\].*stands in the path of movers\[0\] "door"/);
  // 위로 여는 문: 문 위 벽 속으로 들어간다(문보다 넓은 도형이면 된다)
  const tall = DOOR_WALL.map((s) => (s.y > 0 ? { ...s, h: 2.8 } : { ...s, h: 5 }));
  assert.deepEqual(run([{ ...DOOR, axis: 'y', dist: 2.2 }], tall).errors, []);
  // 주기로 움직이는 수평 상자의 규칙(멈추는 자리 앞 1.5 m)은 문에는 적용하지 않는다
  assert.doesNotMatch(run([DOOR], DOOR_WALL).errors.concat(run([DOOR], DOOR_WALL).warnings).join('\n'), /pinned|walkway/);
});

test('kit 뒤집기: 문도 자리와 여는 방향을 함께 뒤집는다', () => {
  const [r] = rotate180([DOOR]);
  assert.deepEqual([r.x, r.z, r.dist, r.axis, r.id, r.door], [0, 0, -1.8, 'x', 'door_r', true]);
  const zDoor = { ...DOOR, w: 0.1, d: 1.8, axis: 'z', x: -5, z: 2 };
  assert.deepEqual([mirrorX([zDoor])[0].x, mirrorX([zDoor])[0].dist], [5, 1.8], 'x로 뒤집어도 z 방향 문은 그대로 연다');
  assert.deepEqual([mirrorZ([zDoor])[0].z, mirrorZ([zDoor])[0].dist], [-2, -1.8]);
});
