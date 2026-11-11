/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 발판·포털·비밀 판정, 맵 제작 도우미(kit)의 대칭 변환, 맵 검사기를 실제 물리 코드로 검증한다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LIMITS, MATS, MOVE, PLAYER, TICK_DT } from '../js/core/consts.js';
import { moveQuake } from '../js/engine/movement.js';
import { createWorld, makeBox, moveCharacter, rampHeight, solidToCollider } from '../js/engine/physics.js';
import { PAD_COOLDOWN, PORTAL_COOLDOWN, buildTriggers, padVelocity, stepTriggers } from '../js/engine/triggers.js';
import { DECOR_TYPES, buildCollision, validateMap } from '../js/maps/collision.js';
import { box, clipAbove, cyl, doorwayWall, mirrorX, mirrorZ, pillar, platform, ramp, rotate180, stairs, wall } from '../js/maps/kit.js';
import { checkMap } from '../tools/check-maps.mjs';

const NO_WISH = { x: 0, z: 0 };

/** 입력 없이 착지할 때까지 날린다 */
function fly(world, body) {
  let top = body.pos[1], ticks = 0, ceiling = false;
  while (!body.onGround && ticks < 900) {
    const ev = moveCharacter(world, body, NO_WISH, TICK_DT);
    ceiling = ceiling || ev.ceiling;
    top = Math.max(top, body.pos[1]);
    ticks++;
  }
  return { top, ceiling, landed: body.onGround };
}

const triggerWorld = (data) => ({ triggers: buildTriggers(data) });
const body = (x, y, z) => ({ pos: [x, y, z], vel: [0, 0, 0], onGround: true });

/* ---------------- padVelocity ---------------- */

const LANDINGS = [
  { name: 'flat', from: [0, 0, 0], target: [12, 0, 6], apex: 2.5 },
  { name: 'up', from: [0, 0, 0], target: [10, 5, -4], apex: 2 },
  { name: 'down', from: [0, 7, 0], target: [14, 0, 3], apex: 1.5 }
];

for (const c of LANDINGS) {
  test(`padVelocity lands on target: ${c.name}`, () => {
    const colliders = [makeBox(c.target[0] - 3, -1, c.target[2] - 3, c.target[0] + 3, c.target[1], c.target[2] + 3, 'concrete')];
    const world = createWorld(colliders, { floorY: 0 });
    const b = { pos: c.from.slice(), vel: padVelocity(c.from, c.target, c.apex), onGround: false };
    const r = fly(world, b);
    assert.ok(r.landed, 'landed');
    assert.ok(!r.ceiling, 'no ceiling');
    assert.ok(Math.hypot(b.pos[0] - c.target[0], b.pos[2] - c.target[2]) < 0.25, `xz ${b.pos}`);
    assert.ok(Math.abs(b.pos[1] - c.target[1]) < 0.01, `y ${b.pos}`);
    assert.ok(Math.abs(r.top - (Math.max(c.from[1], c.target[1]) + c.apex)) < 0.06, `apex ${r.top}`);
  });
}

test('a pad flight through the player movement code lands on target, even above MOVE.MAX_SPEED', () => {
  const target = [34, 4, 0];
  const world = createWorld([makeBox(30, 0, -4, 38, 4, 4, 'concrete')], { floorY: 0 });
  world.triggers = buildTriggers({ pads: [{ x: 0, y: 0, z: 0, w: 2, d: 2, target, apex: 1 }] });
  const b = { pos: [0.4, 0, -0.3], vel: [3, 0, 2], onGround: true };
  assert.ok(stepTriggers(world, b, PLAYER.HEIGHT, {}).pad);
  assert.ok(Math.hypot(b.vel[0], b.vel[2]) > MOVE.MAX_SPEED, 'this flight is fast');
  let ticks = 0;
  while (!b.onGround && ticks++ < 600) moveQuake(world, b, null, TICK_DT);
  assert.ok(b.onGround);
  assert.ok(Math.hypot(b.pos[0] - target[0], b.pos[2] - target[2]) < 0.4, `${b.pos}`);
  assert.ok(Math.abs(b.pos[1] - target[1]) < 0.01);
});

test('padVelocity accepts {x,y,z} and either gravity sign', () => {
  const a = padVelocity([1, 2, 3], [4, 2, 7], 3, -16);
  const b = padVelocity({ x: 1, y: 2, z: 3 }, { x: 4, y: 2, z: 7 }, 3, 16);
  assert.deepEqual(a, b);
  assert.deepEqual(padVelocity(null, [0, 0, 0]), [0, 0, 0]);
});

/* ---------------- stepTriggers: 발판 ---------------- */

const PAD = { x: 0, y: 1, z: 0, w: 4, d: 4, target: [10, 1, 0], apex: 2 };

test('pad fires inside the rectangle within the height tolerance and sets velocity', () => {
  const world = triggerWorld({ pads: [PAD] });
  const b = body(1, 1.3, -1);
  const res = stepTriggers(world, b, PLAYER.HEIGHT, {});
  assert.equal(res.pad.x, PAD.x);
  assert.equal(res.portal, null);
  assert.deepEqual(res.secrets, []);
  assert.equal(b.onGround, false);
  assert.deepEqual(b.vel, padVelocity([1, 1.3, -1], PAD.target, PAD.apex));
  assert.ok(b.vel[1] > 0);
});

test('pad ignores bodies outside the rectangle or the height tolerance', () => {
  const world = triggerWorld({ pads: [PAD] });
  for (const b of [body(2.1, 1, 0), body(0, 1.36, 0), body(0, 0.64, 0)]) {
    const res = stepTriggers(world, b, PLAYER.HEIGHT, {});
    assert.equal(res.pad, null);
    assert.equal(b.onGround, true);
    assert.deepEqual(b.vel, [0, 0, 0]);
  }
});

test('pad with vel uses it as given; target wins when both exist', () => {
  const b = body(0, 0, 0);
  stepTriggers(triggerWorld({ pads: [{ x: 0, y: 0, z: 0, w: 2, d: 2, vel: [1, 9, -2] }] }), b, PLAYER.HEIGHT, {});
  assert.deepEqual(b.vel, [1, 9, -2]);
  const c = body(0, 0, 0);
  stepTriggers(triggerWorld({ pads: [{ x: 0, y: 0, z: 0, w: 2, d: 2, vel: [1, 9, -2], target: [5, 0, 0] }] }), c, PLAYER.HEIGHT, {});
  assert.notDeepEqual(c.vel, [1, 9, -2]);
});

test('pad cooldown: no refire for 0.35 s on the default tick, then fires again', () => {
  const world = triggerWorld({ pads: [PAD] });
  const state = {};
  assert.ok(stepTriggers(world, body(0, 1, 0), PLAYER.HEIGHT, state).pad, 'first');
  let ticks = 0;
  for (;;) {
    ticks++;
    assert.ok(ticks < 100, 'must fire again');
    if (stepTriggers(world, body(0, 1, 0), PLAYER.HEIGHT, state).pad) break;
  }
  assert.ok(Math.abs(ticks * TICK_DT - PAD_COOLDOWN) <= TICK_DT * 1.01, `waited ${ticks} ticks`);
});

test('pad cooldown follows the optional dt argument and is per pad', () => {
  const second = { ...PAD, x: 20, target: [30, 1, 0] };
  const world = triggerWorld({ pads: [PAD, second] });
  const state = {};
  assert.ok(stepTriggers(world, body(0, 1, 0), PLAYER.HEIGHT, state, 0.1).pad);
  assert.equal(stepTriggers(world, body(0, 1, 0), PLAYER.HEIGHT, state, 0.1).pad, null);
  assert.ok(stepTriggers(world, body(20, 1, 0), PLAYER.HEIGHT, state, 0.1).pad, 'other pad is free');
  assert.equal(stepTriggers(world, body(0, 1, 0), PLAYER.HEIGHT, state, 0.1).pad, null);
  assert.ok(stepTriggers(world, body(0, 1, 0), PLAYER.HEIGHT, state, 0.1).pad, 'after 0.4 s');
});

test('invalid entries are dropped and missing triggers report nothing', () => {
  const t = buildTriggers({ pads: [{ x: 0, z: 0 }, null, { x: 1, y: 0, z: 1, w: 1, d: 1, target: [0, 0, 0] }], portals: [{ x: 0, z: 0 }], secrets: [{}] });
  assert.equal(t.pads.length, 1);
  assert.equal(t.pads[0].src, 2);
  assert.equal(t.pads[0].index, 0);
  assert.equal(t.portals.length, 0);
  assert.equal(t.secrets.length, 0);
  for (const world of [null, {}, { triggers: buildTriggers({}) }]) {
    const res = stepTriggers(world, body(0, 0, 0), PLAYER.HEIGHT, {});
    assert.deepEqual([res.pad, res.portal, res.secrets.length], [null, null, 0]);
  }
});

/* ---------------- stepTriggers: 포털 ---------------- */

const PORTAL = { x: 0, y: 0, z: 0, w: 2, h: 3, d: 1, to: { x: 30, y: 2, z: -5, rotY: 1.2 }, color: '#ff4d8d' };

test('portal is only reported: body keeps its position and velocity', () => {
  const world = triggerWorld({ portals: [PORTAL] });
  const b = { pos: [0.5, 0, 0], vel: [3, 0, 1], onGround: true };
  const res = stepTriggers(world, b, PLAYER.HEIGHT, {});
  assert.deepEqual(res.portal.to, PORTAL.to);
  assert.equal(res.portal.color, PORTAL.color);
  assert.equal(res.pad, null);
  assert.deepEqual(b.pos, [0.5, 0, 0]);
  assert.deepEqual(b.vel, [3, 0, 1]);
  assert.equal(b.onGround, true);
});

test('portal needs the body to overlap it vertically, using the current height', () => {
  const world = triggerWorld({ portals: [{ ...PORTAL, y: 2 }] });
  assert.ok(stepTriggers(world, body(0, 0.5, 0), PLAYER.HEIGHT, {}).portal, 'standing head reaches');
  assert.equal(stepTriggers(world, body(0, 0.5, 0), PLAYER.CROUCH_HEIGHT, {}).portal, null, 'crouched is below');
});

test('portal fires on entry only and waits for its cooldown', () => {
  const world = triggerWorld({ portals: [PORTAL] });
  const state = {};
  const inside = () => stepTriggers(world, body(0, 0, 0), PLAYER.HEIGHT, state, 0.1).portal;
  const outside = () => stepTriggers(world, body(9, 0, 9), PLAYER.HEIGHT, state, 0.1).portal;
  assert.ok(inside());
  for (let i = 0; i < 20; i++) assert.equal(inside(), null, 'staying inside does not refire');
  assert.equal(outside(), null);
  assert.ok(inside(), 'leaving and coming back fires again after the cooldown');
  assert.equal(outside(), null);
  assert.equal(inside(), null, 'still cooling down');
  assert.ok(PORTAL_COOLDOWN > 0.2);
});

test('arriving inside another portal does not bounce back', () => {
  const back = { ...PORTAL, x: 30, z: -5, to: { x: 0, y: 0, z: 0 } };
  const world = triggerWorld({ portals: [PORTAL, back] });
  const state = {};
  assert.equal(stepTriggers(world, body(0, 0, 0), PLAYER.HEIGHT, state, 0.1).portal.x, 0);
  for (let i = 0; i < 30; i++) assert.equal(stepTriggers(world, body(30, 0, -5), PLAYER.HEIGHT, state, 0.1).portal, null);
});

/* ---------------- stepTriggers: 비밀 ---------------- */

const SECRET = { id: 'roof', name: '옥상', x: 0, y: 4, z: 0, w: 4, h: 3, d: 4, points: 150 };

test('secret fires once per state, and again on a new state', () => {
  const world = triggerWorld({ secrets: [SECRET] });
  const state = {};
  const first = stepTriggers(world, body(0, 4, 0), PLAYER.HEIGHT, state);
  assert.equal(first.secrets.length, 1);
  assert.equal(first.secrets[0].id, 'roof');
  assert.equal(first.secrets[0].points, 150);
  assert.equal(first.pad, null);
  for (let i = 0; i < 5; i++) assert.equal(stepTriggers(world, body(0, 4, 0), PLAYER.HEIGHT, state).secrets.length, 0);
  assert.equal(stepTriggers(world, body(9, 4, 0), PLAYER.HEIGHT, state).secrets.length, 0);
  assert.equal(stepTriggers(world, body(0, 4, 0), PLAYER.HEIGHT, state).secrets.length, 0, 'not after leaving either');
  assert.equal(stepTriggers(world, body(0, 4, 0), PLAYER.HEIGHT, {}).secrets.length, 1);
});

test('secret ignores bodies above or below its box; points default to 100', () => {
  const t = buildTriggers({ secrets: [{ id: 'a', x: 0, y: 4, z: 0, w: 2, h: 2, d: 2 }] });
  assert.equal(t.secrets[0].points, 100);
  const world = { triggers: t };
  assert.equal(stepTriggers(world, body(0, 6, 0), PLAYER.HEIGHT, {}).secrets.length, 0);
  assert.equal(stepTriggers(world, body(0, 2, 0), PLAYER.HEIGHT, {}).secrets.length, 0);
  assert.equal(stepTriggers(world, body(0, 3, 0), PLAYER.HEIGHT, {}).secrets.length, 1);
});

/* ---------------- kit: 대칭 ---------------- */

const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
const sameAngle = (a, b) => near(Math.cos(a), Math.cos(b)) && near(Math.sin(a), Math.sin(b));

test('rotate180 flips ramps: position, dir, and the height at the matching point', () => {
  const src = ramp(4, 1, -6, 6, 3, 2, '+x', 'steel');
  const [out] = rotate180([src]);
  assert.deepEqual(out, { type: 'ramp', x: -4, y: 1, z: 6, w: 6, h: 3, d: 2, dir: '-x', mat: 'steel' });
  assert.equal(rotate180([ramp(0, 0, 0, 2, 1, 2, '+z')])[0].dir, '-z');
  assert.equal(rotate180([ramp(0, 0, 0, 2, 1, 2, '-z')])[0].dir, '+z');
  const a = solidToCollider(src), b = solidToCollider(out);
  for (const [x, z] of [[2, -6], [4, -6.5], [6.5, -5.2]]) assert.ok(near(rampHeight(a, x, z), rampHeight(b, -x, -z)));
  assert.deepEqual(src, ramp(4, 1, -6, 6, 3, 2, '+x', 'steel'), 'source untouched');
});

test('mirrorX and mirrorZ only flip the ramp dir on their own axis', () => {
  assert.equal(mirrorX([ramp(1, 0, 2, 2, 1, 2, '+x')])[0].dir, '-x');
  assert.equal(mirrorX([ramp(1, 0, 2, 2, 1, 2, '+z')])[0].dir, '+z');
  assert.equal(mirrorZ([ramp(1, 0, 2, 2, 1, 2, '+x')])[0].dir, '+x');
  assert.equal(mirrorZ([ramp(1, 0, 2, 2, 1, 2, '-z')])[0].dir, '+z');
  const mx = mirrorX([ramp(1, 0, 2, 2, 1, 2, '+x')])[0], mz = mirrorZ([ramp(1, 0, 2, 2, 1, 2, '+x')])[0];
  assert.deepEqual([mx.x, mx.z], [-1, 2]);
  assert.deepEqual([mz.x, mz.z], [1, -2]);
  const a = solidToCollider(ramp(1, 0, 2, 2, 1, 2, '+x')), b = solidToCollider(mx);
  assert.ok(near(rampHeight(a, 1.5, 2), rampHeight(b, -1.5, 2)));
});

test('rotate180 and mirrors flip pads including target and vel', () => {
  const pad = { x: 3, y: 1, z: -2, w: 2, d: 3, target: [9, 4, 5], apex: 2, color: '#ff4d8d' };
  const vp = { x: 3, y: 0, z: -2, w: 2, d: 2, vel: [4, 9, -3] };
  assert.deepEqual(rotate180([pad])[0], { ...pad, x: -3, z: 2, target: [-9, 4, -5] });
  assert.deepEqual(mirrorX([pad])[0], { ...pad, x: -3, target: [-9, 4, 5] });
  assert.deepEqual(mirrorZ([pad])[0], { ...pad, z: 2, target: [9, 4, -5] });
  assert.deepEqual(rotate180([vp])[0].vel, [-4, 9, 3]);
  assert.deepEqual(mirrorX([vp])[0].vel, [-4, 9, -3]);
  assert.deepEqual(mirrorZ([vp])[0].vel, [4, 9, 3]);
});

test('a flipped pad really lands on its flipped target', () => {
  const pad = { x: 3, y: 0, z: -2, w: 2, d: 2, target: [12, 3, 5], apex: 2 };
  const world = createWorld([makeBox(-15, 0, -8, -9, 3, -2, 'concrete'), makeBox(9, 0, 2, 15, 3, 8, 'concrete')], { floorY: 0 });
  world.triggers = buildTriggers({ pads: [pad, ...rotate180([pad])] });
  const b = body(-3, 0, 2);
  assert.equal(stepTriggers(world, b, PLAYER.HEIGHT, {}).pad.src, 1);
  assert.ok(fly(world, b).landed);
  assert.ok(Math.hypot(b.pos[0] + 12, b.pos[2] + 5) < 0.25, `${b.pos}`);
  assert.ok(near(b.pos[1], 3, 0.01));
});

test('rotate180 flips spawns, signs, portals, pipes, secrets, and is its own inverse', () => {
  const spawn = { x: 5, z: -7, rotY: Math.PI / 2 };
  const [s] = rotate180([spawn]);
  assert.deepEqual([s.x, s.z], [-5, 7]);
  // 카메라 yaw: 전방 = (-sin, -cos). 돌린 뒤에는 정반대를 본다
  assert.ok(sameAngle(s.rotY, -Math.PI / 2));
  assert.ok(sameAngle(rotate180([{ x: 1, z: 1 }])[0].rotY, Math.PI), 'bare spawn counts as rotY 0');
  const [again] = rotate180(rotate180([spawn]));
  assert.deepEqual([again.x, again.z], [5, -7]);
  assert.ok(sameAngle(again.rotY, spawn.rotY));

  const [portal] = rotate180([{ x: 1, y: 0, z: 2, w: 2, h: 3, d: 1, to: { x: 4, y: 1, z: -5, rotY: 0.5 } }]);
  assert.deepEqual([portal.x, portal.z, portal.to.x, portal.to.y, portal.to.z], [-1, -2, -4, 1, 5]);
  assert.ok(sameAngle(portal.to.rotY, 0.5 + Math.PI));

  const [pipe] = rotate180([{ type: 'pipe', from: [1, 2, 3], to: [4, 5, 6], r: 0.2 }]);
  assert.deepEqual([pipe.from, pipe.to], [[-1, 2, -3], [-4, 5, -6]]);

  const [secret] = rotate180([{ id: 'roof', name: '옥상', x: 1, y: 5, z: 2, w: 2, h: 2, d: 2 }]);
  assert.equal(secret.id, 'roof_r');
  assert.equal(mirrorX([{ id: 'roof', x: 1, z: 2 }])[0].id, 'roof_mx');
  assert.equal(mirrorZ([{ id: 'roof', x: 1, z: 2 }])[0].id, 'roof_mz');

  assert.equal(Object.is(rotate180([box(0, 0, 0, 1, 1, 1)])[0].x, -0), false, 'no negative zero');
});

test('mirrors keep facing directions consistent for spawns and signs', () => {
  for (const a of [0, 0.7, Math.PI / 2, 2.4, -1.1]) {
    const facing = (t) => [-Math.sin(t), -Math.cos(t)]; // 스폰 전방
    const [fx, fz] = facing(a);
    const mx = mirrorX([{ x: 1, z: 1, rotY: a }])[0].rotY;
    assert.ok(near(facing(mx)[0], -fx) && near(facing(mx)[1], fz), 'mirrorX spawn');
    const mz = mirrorZ([{ x: 1, z: 1, rotY: a }])[0].rotY;
    assert.ok(near(facing(mz)[0], fx) && near(facing(mz)[1], -fz), 'mirrorZ spawn');
    const r = rotate180([{ x: 1, z: 1, rotY: a }])[0].rotY;
    assert.ok(near(facing(r)[0], -fx) && near(facing(r)[1], -fz), 'rotate180 spawn');
  }
  const sign = mirrorZ([{ type: 'sign', x: 1, y: 2, z: 3, w: 1, h: 1, text: 'A' }])[0];
  assert.ok(sameAngle(sign.rotY, Math.PI), 'sign without rotY counts as facing +z');
});

test('flips accept nested lists from helpers and return flat copies', () => {
  const out = rotate180([box(1, 0, 1, 1, 1, 1), stairs(2, 0, 2, 2, 0.6, 1, '+x')]);
  assert.ok(out.every((o) => o && o.type === 'box'));
  assert.equal(out.length, 3);
});

/* ---------------- kit: 도형 ---------------- */

test('wall builds an axis-aligned segment and rejects diagonals', () => {
  assert.deepEqual(wall(-10, 4, 6, 4, 3, 0.4, 'brick'), { type: 'box', x: -2, y: 0, z: 4, w: 16, h: 3, d: 0.4, mat: 'brick' });
  assert.deepEqual(wall(2, 9, 2, 1, 3, 0.5, 'brick', 1), { type: 'box', x: 2, y: 1, z: 5, w: 0.5, h: 3, d: 8, mat: 'brick' });
  assert.throws(() => wall(0, 0, 3, 3, 3));
  assert.throws(() => wall(1, 1, 1, 1, 3));
});

test('stairs fill the same footprint as a ramp, step by climbable rises, and can be walked', () => {
  for (const [dir, wish] of [['+x', { x: 4, z: 0 }], ['-x', { x: -4, z: 0 }], ['+z', { x: 0, z: 4 }], ['-z', { x: 0, z: -4 }]]) {
    const steps = stairs(0, 0, 0, 6, 3, 6, dir, 'stone');
    assert.equal(steps.length, 10);
    let lastTop = 0;
    for (const s of steps) {
      assert.ok(s.h - lastTop <= PLAYER.STEP + 1e-9);
      lastTop = s.h;
      const c = solidToCollider(s);
      assert.ok(c.minX >= -3 - 1e-9 && c.maxX <= 3 + 1e-9 && c.minZ >= -3 - 1e-9 && c.maxZ <= 3 + 1e-9);
    }
    assert.ok(near(lastTop, 3));
    const world = createWorld(steps.map(solidToCollider), { floorY: 0 });
    const b = { pos: [-Math.sign(wish.x) * 4, 0, -Math.sign(wish.z) * 4], vel: [0, 0, 0], onGround: true };
    let peak = 0;
    for (let i = 0; i < 180; i++) { moveCharacter(world, b, wish, TICK_DT); peak = Math.max(peak, b.pos[1]); }
    assert.ok(near(peak, 3, 1e-6), `${dir} climbs to the top, got ${peak}`);
  }
  assert.throws(() => stairs(0, 0, 0, 2, 3, 2, '+x', 'stone', 2), /PLAYER.STEP/);
});

test('platform puts the walking surface at top and adds legs', () => {
  const parts = platform(1, 3, 2, 4, 6, 'wood', { t: 0.2, leg: 0.4, legMat: 'steel' });
  assert.equal(parts.length, 5);
  assert.deepEqual(parts[0], { type: 'box', x: 1, y: 2.8, z: 2, w: 4, h: 0.2, d: 6, mat: 'wood' });
  for (const leg of parts.slice(1)) {
    assert.equal(leg.mat, 'steel');
    assert.equal(leg.y, 0);
    assert.ok(near(leg.h, 2.8));
    assert.ok(Math.abs(Math.abs(leg.x - 1) - 1.8) < 1e-9);
  }
  assert.equal(platform(0, 3, 0, 2, 2, 'wood', { legs: false }).length, 1);
  assert.equal(pillar(1, 2, 4).h, 4);
  assert.equal(cyl(0, 1, 0, 2, 3).type, 'cyl');
});

test('doorwayWall leaves a gap the player can walk through', () => {
  const parts = doorwayWall(-5, 0, 5, 0, 4, 0.4, 'plaster', { at: 1, w: 1.6, top: 2.4 });
  assert.equal(parts.length, 3);
  const world = createWorld(parts.map(solidToCollider), { floorY: 0 });
  const through = { pos: [1, 0, -2], vel: [0, 0, 0], onGround: true };
  const blocked = { pos: [-3, 0, -2], vel: [0, 0, 0], onGround: true };
  for (let i = 0; i < 90; i++) {
    moveCharacter(world, through, { x: 0, z: 4 }, TICK_DT);
    moveCharacter(world, blocked, { x: 0, z: 4 }, TICK_DT);
  }
  assert.ok(through.pos[2] > 1, 'walked through');
  assert.ok(blocked.pos[2] < 0, 'wall holds');
  assert.equal(doorwayWall(0, -4, 0, 4, 3, 0.3, 'brick', { at: [-2, 2], w: 1 }).length, 5, 'two doors, three wall pieces, two lintels');
  assert.equal(doorwayWall(0, -4, 0, 4, 3, 0.3, 'brick', { w: 2, top: 2.2, sill: 1 }).length, 4, 'window adds a sill');
  assert.throws(() => doorwayWall(-5, 0, 5, 0, 4, 0.4, 'brick', { at: 4.9 }), /leaves the wall/);
  assert.throws(() => doorwayWall(-5, 0, 5, 0, 4, 0.4, 'brick', { w: 0.5 }), /door needs/);
});

test('clipAbove stacks invisible blockers on solids', () => {
  const [a, b] = clipAbove([box(1, 0, 2, 4, 1.2, 0.4, 'stone'), cyl(5, 1, 5, 2, 3, 'tank')], 6);
  assert.deepEqual(a, { type: 'box', x: 1, y: 1.2, z: 2, w: 4, h: 6, d: 0.4, mat: 'clip' });
  assert.deepEqual(b, { type: 'cyl', x: 5, y: 4, z: 5, r: 2, h: 6, mat: 'clip' });
  const c = buildCollision({ id: 'c', size: { x: 20, z: 20 }, solids: [a] }).solidColliders[0];
  assert.equal(c.tag, 'clip');
  assert.equal(c.noRay, true);
});

/* ---------------- collision · validateMap ---------------- */

test('buildCollision makes a physics world with triggers and spawns', () => {
  const data = {
    id: 'c', size: { x: 40, z: 30 }, theme: { ground: 'sand' },
    spawns: { owner: [{ x: -15, z: 0, rotY: 1 }], charterer: [{ x: 15, z: 0 }], ffa: [{ x: 0, y: 3, z: 0 }] },
    solids: [box(0, 0, 0, 4, 3, 4, 'stone'), box(0, -1, 10, 6, 1, 6, 'water')],
    pads: [{ x: 5, y: 0, z: 5, w: 2, d: 2, target: [0, 3, 0] }],
    secrets: [{ id: 's', name: 'S', x: 0, y: 3, z: 0, w: 2, h: 2, d: 2 }]
  };
  const c = buildCollision(data);
  assert.equal(c.world.triggers.pads.length, 1);
  assert.equal(c.world.triggers, c.triggers);
  assert.deepEqual(c.bounds, { minX: -20, maxX: 20, minZ: -15, maxZ: 15 });
  assert.equal(c.holes.length, 1);
  assert.equal(c.waterCols.length, 1);
  assert.equal(c.theme.ground, 'sand');
  assert.equal(c.solidColliders.length, 2);
  assert.ok(c.colliders.some((k) => k.tag === 'ground') && c.colliders.some((k) => k.tag === 'bounds'));
  assert.equal(c.spawns.owner[0].y, 0);
  assert.equal(c.spawns.ffa[0].y, 3, 'spawn y picks the floor near it');
  assert.equal(buildCollision({ solids: [] }).spawns.ffa.length, 0);
});

test('validateMap enforces LIMITS and explains bad trigger data', () => {
  const many = (n, make) => Array.from({ length: n }, (_, i) => make(i));
  const base = { id: 'v', size: { x: 40, z: 40 }, solids: [] };
  assert.equal(validateMap(base).ok, true);
  for (const [field, limit, make] of [
    ['solids', LIMITS.SOLIDS, () => box(0, 0, 0, 1, 1, 1)],
    ['decor', LIMITS.DECOR, () => ({ type: 'tree', x: 0, z: 0 })],
    ['pads', LIMITS.PADS, () => ({ x: 0, y: 0, z: 0, w: 1, d: 1, vel: [0, 9, 0] })],
    ['secrets', LIMITS.SECRETS, (i) => ({ id: `s${i}`, name: 'n', x: 0, y: 0, z: 0, w: 1, h: 1, d: 1 })],
    ['props', LIMITS.PROPS, () => ({ type: 'crate', x: 0, y: 0, z: 0 })]
  ]) {
    assert.equal(validateMap({ ...base, [field]: many(limit, make) }).ok, true, `${field} at limit`);
    const over = validateMap({ ...base, [field]: many(limit + 1, make) });
    assert.equal(over.ok, false, `${field} over limit`);
    assert.match(over.errors.join(), new RegExp(field));
  }
  const has = (data, re) => assert.match(validateMap({ ...base, ...data }).warnings.join('\n'), re);
  has({ pads: [{ x: 0, y: 0, z: 0, w: 1, d: 1 }] }, /needs target/);
  has({ pads: [{ x: 0, y: 0, z: 0, w: 0, d: 1, vel: [0, 9, 0] }] }, /w must be > 0/);
  has({ pads: [{ x: 99, y: 0, z: 0, w: 1, d: 1, vel: [0, 9, 0] }] }, /outside size/);
  has({ pads: [{ x: 0, y: 0, z: 0, w: 1, d: 1, target: [19, 0, 0], apex: 0.1 }] }, /horizontal speed/);
  has({ pads: [{ x: 0, y: 0, z: 0, w: 1, d: 1, vel: [0, 9, 0], color: 'cyan' }] }, /color/);
  has({ portals: [{ x: 0, y: 0, z: 0, w: 1, h: 2, d: 1 }] }, /needs to/);
  has({ secrets: [{ id: 'a', name: 'n', x: 0, y: 0, z: 0, w: 1, h: 1, d: 1 }, { id: 'a', name: 'n', x: 1, y: 0, z: 0, w: 1, h: 1, d: 1 }] }, /duplicate id/);
  has({ secrets: [{ id: 'a', name: 'n', x: 0, y: 0, z: 0, w: 1, h: 1, d: 1, reach: 'fly' }] }, /reach/);
  has({ props: [{ type: 'sofa', x: 0, y: 0, z: 0 }] }, /crate or barrel/);
  has({ decor: [{ type: 'dragon', x: 0, z: 0 }] }, /unknown decor type/);
  has({ decor: [{ type: 'rope', from: [0, 0, 0] }] }, /needs from and to/);
  has({ solids: [box(0, 0, 0, 1, 1, 1, 'lava')] }, /unknown mat/);
  has({ solids: [stairs(0, 0, 0, 2, 1, 2, '+x')] }, /nested array/);
  has({ rulesets: ['classic', 'chess'] }, /unknown "chess"/);
});

test('map index lists every map with rulesets and filters by ruleset', async () => {
  const realWarn = console.warn;
  console.warn = () => {}; // 아직 없는 맵 파일은 조용히 테스트 맵으로 대신한다
  const index = await import('../js/maps/index.js').finally(() => { console.warn = realWarn; });

  const { MAP_IDS, MAPS, MAP_LIST, TEST_MAP, getMap, mapsForRuleset } = index;
  assert.deepEqual([...MAP_IDS], [
    'rooftop', 'glasshouse', 'alley', 'cqb', 'sorthub', 'lot', 'schoolyard', 'karaoke', 'hanok',
    'longshot', 'dojo', 'nexus', 'jetty', 'tankfarm', 'vlcc', 'relay', 'railyard', 'observatory'
  ]);
  assert.deepEqual(Object.keys(MAPS), [...MAP_IDS]);
  const entry = (id) => MAP_LIST.find((m) => m.id === id);
  assert.deepEqual(entry('jetty').rulesets, ['classic', 'sniper']);
  assert.deepEqual(entry('dojo').rulesets, ['classic', 'knife', 'sniper']);
  assert.equal(entry('dojo').name, '벚꽃 도장');
  assert.equal(entry('dojo').tag, '통합');
  // 좁은 칼전 전용 맵: 플레이 영역 한 변이 26 m 이하
  for (const id of ['rooftop', 'glasshouse']) {
    assert.deepEqual(entry(id).rulesets, ['knife'], id);
    assert.equal(entry(id).tag, '칼전 전용', id);
    assert.ok(MAPS[id].size.x <= 26 && MAPS[id].size.z <= 26, `${id} size ${JSON.stringify(MAPS[id].size)}`);
  }
  assert.equal(MAP_LIST[MAP_LIST.length - 1].id, TEST_MAP.id);
  assert.equal(entry(TEST_MAP.id).test, true);
  const ids = (r) => mapsForRuleset(r).map((m) => m.id);
  assert.ok(ids('knife').includes('dojo') && !ids('knife').includes('jetty'));
  assert.ok(ids('sniper').includes('longshot') && !ids('sniper').includes('alley'));
  assert.ok(ids('classic').includes('alley') && ids('classic').includes('dojo') && !ids('classic').includes('rooftop'));
  // 규칙마다 목록의 첫 맵이 방 만들기·대기실의 기본 맵이다. 칼전은 좁은 칼전 맵이 먼저 온다
  assert.deepEqual([ids('classic')[0], ids('knife')[0], ids('sniper')[0]], ['alley', 'rooftop', 'longshot']);
  assert.deepEqual(ids('knife').slice(0, 2), ['rooftop', 'glasshouse']);
  assert.ok(!ids('classic').includes(TEST_MAP.id), 'the test map is never offered');
  assert.deepEqual(ids('bogus'), ids('classic'));
  assert.equal(getMap(TEST_MAP.id), TEST_MAP);
  assert.equal(getMap('nope'), null);
  // 맵 id는 방장이 보낸 값일 수 있다. 물려받은 속성을 맵으로 착각하면 안 된다
  for (const id of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', '', null, undefined, {}]) assert.equal(getMap(id), null, String(id));
  for (const id of MAP_IDS) assert.equal(getMap(id).id, id);
  assert.equal(validateMap(TEST_MAP).ok, true);
});

test('every palette mat and decor type is implemented in the browser modules', () => {
  const materials = readFileSync(new URL('../js/engine/materials.js', import.meta.url), 'utf8');
  for (const mat of MATS) {
    assert.match(materials, new RegExp(`^\\s*${mat}:\\s+\\{ scale`, 'm'), `MAT_INFO.${mat}`);
    if (mat !== 'glass') assert.match(materials, new RegExp(`^\\s*${mat}\\(ctx, S`, 'm'), `PAINT.${mat}`);
  }
  const decor = readFileSync(new URL('../js/engine/decor.js', import.meta.url), 'utf8');
  for (const type of DECOR_TYPES) assert.ok(decor.includes(`case '${type}':`), `decor ${type}`);
});

/* ---------------- 맵 검사기 ---------------- */

const ROOF = 6;
function sampleMap(over = {}) {
  const owner = [-25, -22, -19, -16].map((x) => ({ x, z: -14, rotY: Math.PI }));
  return {
    id: 'sample',
    size: { x: 60, z: 40 },
    rulesets: ['classic'],
    spawns: {
      owner,
      charterer: rotate180(owner),
      ffa: [[-24, 14], [-12, 14], [0, 14], [12, 14], [24, 14], [0, -14]].map(([x, z]) => ({ x, z, rotY: 0 }))
    },
    solids: [
      box(0, 0, 0, 8, ROOF, 8, 'stone'),
      wall(-20, -8, -20, 8, 4, 0.4, 'brick'),
      wall(20, -8, 20, 8, 4, 0.4, 'brick')
    ],
    pads: [{ x: -10, y: 0, z: 0, w: 2.4, d: 2.4, target: [0, ROOF, 0], apex: 3 }],
    portals: [{ x: 10, y: 0, z: 12, w: 2, h: 3, d: 1, to: { x: 24, y: 0, z: -12, rotY: 0 } }],
    secrets: [{ id: 'roof', name: '옥상', x: 0, y: ROOF, z: 0, w: 6, h: 2.5, d: 6, points: 100 }],
    ...over
  };
}
const report = (over) => checkMap('sample', sampleMap(over));
const errorsMatch = (r, re) => assert.match(r.errors.join('\n'), re);

test('checker passes a sound map and reports how the secret is reached', () => {
  const r = report();
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
  assert.equal(r.counts.pads, 1);
  assert.equal(r.counts.ffa, 6);
  assert.ok(r.pads[0].dist < 0.3, `landing ${r.pads[0].dist}`);
  assert.equal(r.secrets[0].via, 'walk', 'the pad landing node connects to the box');
});

test('checker catches spawns in walls, spawns over a hole, and too few spawns', () => {
  const withOwner0 = (spawn) => {
    const m = sampleMap();
    m.spawns.owner[0] = spawn;
    return checkMap('sample', m);
  };
  errorsMatch(withOwner0({ x: -19.49, z: 0, rotY: 0 }), /spawns\.owner\[0\].*inside a wall or under a low ceiling/);
  // 벽 속 스폰은 바닥 찾기가 벽 위로 올려 놓는다
  errorsMatch(withOwner0({ x: -20, z: 0, rotY: 0 }), /spawns\.owner\[0\].*narrow top/);
  errorsMatch(withOwner0({ x: 0, y: 2, z: 0, rotY: 0 }), /spawns\.owner\[0\]: y 2 was asked for/);
  // 옥상에 혼자 있는 스폰은 적에게 갈 길이 없다
  errorsMatch(withOwner0({ x: 0, z: 0, rotY: 0 }), /spawns\.owner\[0\] cannot reach/);
  errorsMatch(report({ spawns: { owner: sampleMap().spawns.owner.slice(0, 3), charterer: sampleMap().spawns.charterer, ffa: sampleMap().spawns.ffa } }), /spawns\.owner: 3 < 4/);
  errorsMatch(report({ spawns: { owner: sampleMap().spawns.owner, charterer: sampleMap().spawns.charterer, ffa: [] } }), /spawns\.ffa: 0 < 6/);
  const holes = sampleMap({ solids: [...sampleMap().solids, box(-16, -3, -14, 4, 2, 4, 'water')] });
  errorsMatch(checkMap('sample', holes), /spawns\.owner\[3\]/);
});

test('checker catches pads that miss, bonk, float, or lead nowhere', () => {
  errorsMatch(report({ pads: [{ x: -10, y: 0, z: 0, w: 2.4, d: 2.4, target: [-1, ROOF + 3, 0], apex: 2 }] }), /lands.*(from target|target height)/);
  errorsMatch(report({ solids: [...sampleMap().solids, box(-6, 3.6, 0, 6, 0.3, 6, 'steel')] }), /hits a ceiling/);
  errorsMatch(report({ pads: [{ x: -10, y: 3, z: 0, w: 2, d: 2, vel: [0, 9, 0] }] }), /no floor within/);
  errorsMatch(report({ pads: [{ x: 0, y: 0, z: 0, w: 1, d: 1, vel: [0, 9, 0] }] }), /inside a wall|no floor within/);
  const r = report({ pads: [{ x: -10, y: 0, z: 0, w: 2.4, d: 2.4, vel: [2, 8, 0] }] });
  assert.equal(r.pads[0].dist, null, 'vel pads have no target distance');
  errorsMatch(r, /secrets\[0\] "roof".*unreachable/);
});

test('checker requires portal destinations to stand clear', () => {
  const portal = (to) => [{ x: 10, y: 0, z: 12, w: 2, h: 3, d: 1, to }];
  errorsMatch(report({ portals: portal({ x: 0, y: 1, z: 0 }) }), /portals\[0\] destination.*inside a wall/);
  errorsMatch(report({ portals: portal({ x: 24, y: 9, z: -12 }) }), /portals\[0\] destination.*no floor/);
  assert.match(report({ portals: [...portal({ x: 11, y: 0, z: 12 })] }).warnings.join('\n'), /destination is inside portals\[0\]/);
});

test('checker accepts a portal or pad route to a secret and flags an unreachable one', () => {
  const tower = [box(12, 0, -12, 4, ROOF, 4, 'stone')];
  const secret = [{ id: 'tower', name: '탑', x: 12, y: ROOF, z: -12, w: 3, h: 2.5, d: 3 }];
  errorsMatch(report({ solids: [...sampleMap().solids, ...tower], secrets: secret }), /"tower".*unreachable/);
  const byPortal = report({ solids: [...sampleMap().solids, ...tower], secrets: secret, portals: [{ x: 10, y: 0, z: 12, w: 2, h: 3, d: 1, to: { x: 12, y: ROOF, z: -12 } }] });
  assert.deepEqual(byPortal.errors, []);
  assert.equal(byPortal.secrets[0].via, 'walk');
  const byPad = report({ solids: [...sampleMap().solids, ...tower], secrets: secret, pads: [{ x: 20, y: 0, z: -12, w: 2, d: 2, target: [12, ROOF, -12], apex: 2 }] });
  assert.deepEqual(byPad.errors, []);
  // 도달할 수 없는 발판을 타는 경로는 인정하지 않는다(3 m 벽은 점프로 못 넘는다)
  const cage = sampleMap({ solids: [...sampleMap().solids, ...tower], secrets: secret });
  cage.pads = [{ x: 28, y: 0, z: -12, w: 2, d: 2, target: [12, ROOF, -12], apex: 3 }];
  cage.solids.push(wall(25, -16, 25, -8, 3, 0.4, 'stone'), wall(25, -8, 30, -8, 3, 0.4, 'stone'), wall(25, -16, 30, -16, 3, 0.4, 'stone'));
  const caged = checkMap('sample', cage);
  errorsMatch(caged, /"tower".*unreachable/);
  assert.match(caged.warnings.join('\n'), /pads\[0\].*cannot be reached/);
});

test('checker verifies reach:jump with simulated running jumps', () => {
  // 계단으로 오르는 탑과, 3 m 틈 건너편의 탑. 틈을 건너는 길은 내비에 없다
  const climb = [...stairs(8, 0, -16, 8, 3, 4, '+x', 'stone'), box(14, 0, -16, 4, 3, 4, 'stone')];
  const secret = { id: 'gap', name: '건너편', x: 21, y: 3, z: -16, w: 3, h: 2.5, d: 3 };
  const near = [...sampleMap().solids, ...climb, box(21, 0, -16, 4, 3, 4, 'stone')];
  errorsMatch(report({ solids: near, secrets: [secret] }), /"gap".*unreachable.*reach:'jump'/);
  const jump = report({ solids: near, secrets: [{ ...secret, reach: 'jump' }] });
  assert.deepEqual(jump.errors, []);
  assert.match(jump.secrets[0].via, /^jump x\d+$/);
  const tooFar = report({
    solids: [...sampleMap().solids, ...climb, box(27, 0, -16, 4, 3, 4, 'stone')],
    secrets: [{ ...secret, x: 27, reach: 'jump' }]
  });
  errorsMatch(tooFar, /"gap" has reach:'jump' but/);
});

test('the jump probe chains ledges that are too high for the navgrid', () => {
  // 1.4 m씩 오르는 턱: 내비 점프 한계(1.2 m)는 넘지만 달리기 점프로는 올라간다
  const steps = [box(10, 0, -16, 3, 1.4, 3, 'stone'), box(14, 0, -16, 3, 2.8, 3, 'stone'), box(18, 0, -16, 3, 4.2, 3, 'stone')];
  const secret = { id: 'top', name: '꼭대기', x: 18, y: 4.2, z: -16, w: 2.5, h: 2.5, d: 2.5, points: 100 };
  errorsMatch(report({ solids: [...sampleMap().solids, ...steps], secrets: [secret] }), /"top".*unreachable/);
  const r = report({ solids: [...sampleMap().solids, ...steps], secrets: [{ ...secret, reach: 'jump' }] });
  assert.deepEqual(r.errors, []);
  assert.match(r.secrets[0].via, /^jump x\d+$/);
  assert.ok(+r.secrets[0].via.split('x')[1] >= 3, 'three ledges take at least three jumps');
});

test('checker warns when a landing is too small to stop on', () => {
  const pole = box(0, 0, -14, 0.8, 4, 0.8, 'stone');
  const r = report({
    solids: [...sampleMap().solids, pole],
    pads: [{ x: 14, y: 0, z: -14, w: 2, d: 2, target: [0, 4, -14], apex: 1 }],
    secrets: [],
    spawns: { ...sampleMap().spawns, ffa: sampleMap().spawns.ffa.map((p) => (p.z === -14 ? { ...p, x: 6, z: -8 } : p)) }
  });
  assert.deepEqual(r.errors, []);
  assert.match(r.warnings.join('\n'), /pads\[0\] slides off/);
});

test('legacy maps skip the new-map requirements; their validation warnings stay warnings', () => {
  const legacy = sampleMap({ rulesets: undefined, pads: [], portals: [], secrets: [] });
  delete legacy.spawns.ffa;
  legacy.spawns.owner = legacy.spawns.owner.slice(0, 3);
  const r = checkMap('oldmap', legacy);
  assert.deepEqual(r.errors, []);
  assert.match(r.warnings.join('\n'), /spawns\.owner: 3 < 4/);
  const n = checkMap('alley', legacy);
  assert.equal(n.strict, true, 'new ids are strict without rulesets');
  errorsMatch(n, /spawns\.owner: 3 < 4/);
});
