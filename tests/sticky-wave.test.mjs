/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 좀비 물량 막기의 C4 수류탄과 검기 시험. C4는 손으로 던진 수류탄과 같은 중력으로 날고(NaN 없음) 유탄·로켓은 그대로이며,
 *          붙이면 멈춘 채 신관이 계속 가 제시간에 터지고, 옮기기·떼어 내기가 된다. 검기가 좀비 몸에 닿는 거리·자리, 벽까지의 거리,
 *          C4가 붙는 자리를 검사하고, three.js 대역 위의 horde/view.js에서 검기 판정·쓰러진 동료 표시·좀비 찾기를 확인한다.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { createGrenade, stepGrenade, createGrenadeSystem, PROJECTILES, GRENADE_PHYSICS, projectileCode, projectileKind } from '../js/weapons/grenade.js';
import { waveHitT, waveHitPoint, losReach, c4Offset, c4WorldPos, C4_STICK_H, C4_STICK_H_LOW } from '../js/game/horde/contact.js';
import { createHordeView } from '../js/game/horde/view.js';
import { HAZARD_KINDS } from '../js/game/horde/bosses.js';
import { ZF } from '../js/game/horde/director.js';
import { HORDE } from '../js/game/horde/rules.js';
import { createWorld, makeBox } from '../js/engine/physics.js';

const H = 1 / 120;
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const finite3 = (v) => Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2]);
const xyz = (v) => [v[0], v[1], v[2]];
const close3 = (a, b, eps = 1e-6) => near(a[0], b[0], eps) && near(a[1], b[1], eps) && near(a[2], b[2], eps);

/** 시스템을 seconds만큼 1/60초씩 진행 → 그동안 나온 이벤트(시각 at 포함) */
function run(sys, seconds, clock = { t: 0 }) {
  const out = [];
  const n = Math.round(seconds * 60);
  for (let i = 0; i < n; i++) {
    clock.t += 1 / 60;
    for (const e of sys.update(1 / 60)) out.push({ ...e, at: clock.t });
  }
  return out;
}

/* ================================================================== C4 물리 */

describe('C4 수류탄 물리(grenade.js)', () => {
  test('종류 표: c4는 번호 3, 중력을 덮어쓰지 않고 붙는 발사체다. 유탄·로켓은 그대로', () => {
    assert.deepEqual({ ...PROJECTILES.c4 }, { code: 3, impact: false, sticky: true });
    assert.equal(PROJECTILES.c4.gravity, undefined);
    assert.ok(Object.isFrozen(PROJECTILES.c4));
    assert.deepEqual({ ...PROJECTILES.gl }, { code: 1, gravity: -9, impact: true });
    assert.deepEqual({ ...PROJECTILES.rocket }, { code: 2, gravity: 0, impact: true });
    assert.equal(projectileCode('c4'), 3);
    assert.equal(projectileKind(3), 'c4');
    assert.equal(projectileKind(1), 'gl');
    assert.equal(projectileKind(2), 'rocket');
    assert.equal(createGrenade({ kind: 'c4' }).kind, 'c4');
    assert.equal(createGrenade({ kind: 'c4' }).stuck, false);
    assert.equal(createGrenade({ kind: 'nope' }).kind, null);
  });

  test('c4는 손으로 던진 수류탄과 같은 중력으로 같은 궤적을 그리고 NaN이 생기지 않는다', () => {
    const a = createGrenade({ pos: [0, 2, 0], vel: [3, 4, -5], kind: 'c4', fuse: 9 });
    const b = createGrenade({ pos: [0, 2, 0], vel: [3, 4, -5], fuse: 9 });
    for (let i = 0; i < 180; i++) {
      stepGrenade(a, 1 / 60, null, { floorY: 0 });
      stepGrenade(b, 1 / 60, null, { floorY: 0 });
      assert.ok(finite3(a.pos) && finite3(a.vel), `step ${i}`);
      assert.ok(close3(a.pos, b.pos, 1e-12), `같은 궤적 ${i}`);
    }
    // 공중 0.25초: 손 수류탄 중력(-12)만큼 속도가 줄었다
    const c = createGrenade({ pos: [0, 50, 0], vel: [0, 4, 0], kind: 'c4', fuse: 9 });
    stepGrenade(c, 0.25, null, { floorY: 0 });
    assert.ok(near(c.vel[1], 4 + GRENADE_PHYSICS.gravity * 0.25, 1e-9), String(c.vel[1]));
  });

  test('c4는 바닥에 닿아도 터지지 않고 튀다가 신관에 맞춰 터진다(유탄은 닿자마자)', () => {
    const sys = createGrenadeSystem({ floorY: 0 });
    sys.spawn([0, 1, 0], [2, -4, 0], { kind: 'c4', fuse: 2.5, id: 'c4' });
    sys.spawn([5, 1, 0], [2, -4, 0], { kind: 'gl', fuse: 2.5, id: 'gl' });
    const ev = run(sys, 3);
    const boom = ev.filter((e) => e.type === 'explode');
    const c4 = boom.find((e) => e.id === 'c4'), gl = boom.find((e) => e.id === 'gl');
    assert.ok(gl && gl.at < 0.5, '유탄은 바닥에 닿자마자');
    assert.ok(c4 && c4.at >= 2.5 - 1e-6 && c4.at < 2.5 + 1 / 60 + 1e-6, `c4는 신관대로 ${c4 && c4.at}`);
    assert.equal(c4.kind, 'c4');
    assert.ok(ev.some((e) => e.type === 'bounce' && e.id === 'c4'), 'c4는 튄다');
    assert.ok(finite3(c4.pos));
  });

  test('유탄·로켓은 예전 그대로: 유탄 중력 -9, 로켓은 곧게 날아간다', () => {
    const r = createGrenade({ pos: [0, 1, 0], vel: [20, 0, 0], kind: 'rocket', fuse: 3 });
    stepGrenade(r, 0.25, null, { floorY: 0 });
    stepGrenade(r, 0.25, null, { floorY: 0 });
    assert.equal(r.pos[1], 1);
    assert.equal(r.vel[1], 0);
    assert.ok(near(r.pos[0], 10, 1e-9));
    const g = createGrenade({ pos: [0, 50, 0], vel: [10, 0, 0], kind: 'gl', fuse: 3 });
    stepGrenade(g, 0.25, null, { floorY: 0 });
    stepGrenade(g, 0.25, null, { floorY: 0 });
    assert.ok(near(g.vel[1], -4.5, 1e-9), String(g.vel[1]));
    assert.equal(g.exploded, false);
  });

  test('core 적분기(맵 충돌)에서도 c4는 NaN 없이 바닥에 멈췄다가 제시간에 터진다', () => {
    const world = createWorld([makeBox(-20, -1, -20, 20, 0, 20)]);
    const sys = createGrenadeSystem({ world });
    assert.equal(sys.sweepStyle, 'integrator');
    sys.spawn([0, 1.5, 0], [6, 3, -2], { kind: 'c4', fuse: 2.5, id: 'k' });
    let seen = null;
    const clock = { t: 0 };
    for (let i = 0; i < 200 && !seen; i++) {
      const ev = run(sys, 1 / 60, clock);
      for (const g of sys.list()) assert.ok(finite3(g.pos) && finite3(g.vel));
      seen = ev.find((e) => e.type === 'explode') || null;
    }
    assert.ok(seen, '터졌다');
    assert.ok(seen.at >= 2.5 - 1e-6 && seen.at < 2.5 + 1 / 60 + 1e-6, String(seen.at));
    assert.ok(seen.pos[1] > -0.01 && seen.pos[1] < 0.3, `바닥 위 ${seen.pos[1]}`);
  });

  test('stick: 그 자리에 멈추고(속도 0) 신관은 계속 가서 제시간에 터진다', () => {
    const sys = createGrenadeSystem({ floorY: 0 });
    sys.spawn([0, 3, 0], [4, 6, 0], { kind: 'c4', fuse: 2.5, id: 'c' });
    const clock = { t: 0 };
    assert.equal(run(sys, 0.5, clock).filter((e) => e.type === 'explode').length, 0);
    assert.equal(sys.list()[0].stuck, false);
    assert.equal(sys.stick('c'), true);
    const g0 = sys.list()[0];
    assert.equal(g0.stuck, true);
    assert.equal(g0.sleeping, true);
    assert.deepEqual(xyz(g0.vel), [0, 0, 0]);
    const p0 = xyz(g0.pos);
    assert.ok(p0[1] > 1, '공중에 붙었다');
    assert.equal(run(sys, 1, clock).length, 0, '붙어 있는 동안 아무 일도 없다');
    const g1 = sys.list()[0];
    assert.deepEqual(xyz(g1.pos), p0, '움직이지 않는다');
    assert.ok(near(g1.age, 1.5, 1e-6), `신관은 계속 간다 ${g1.age}`);
    const ev = run(sys, 1.2, clock);
    const boom = ev.filter((e) => e.type === 'explode');
    assert.equal(boom.length, 1);
    assert.ok(boom[0].at >= 2.5 - 1e-6 && boom[0].at < 2.5 + 1 / 60 + 1e-6, String(boom[0].at));
    assert.deepEqual(xyz(boom[0].pos), p0, '붙은 자리에서 터진다');
    assert.equal(sys.count, 0);
    assert.equal(sys.stick('c'), false, '터진 뒤에는 없다');
  });

  test('place: 붙은 C4를 옮긴다(잘못된 좌표·없는 id는 false)', () => {
    const sys = createGrenadeSystem({ floorY: 0 });
    sys.spawn([0, 2, 0], [1, 0, 0], { kind: 'c4', fuse: 2.5, id: 'p' });
    run(sys, 0.1);
    assert.equal(sys.stick('p'), true);
    assert.equal(sys.place('p', [5, 1.2, -3]), true);
    assert.ok(close3(xyz(sys.list()[0].pos), [5, 1.2, -3]));
    run(sys, 0.3);
    assert.ok(close3(xyz(sys.list()[0].pos), [5, 1.2, -3]), '옮긴 자리에 그대로');
    assert.equal(sys.place('p', { x: 6, y: 1, z: 2 }), true, '{x,y,z}도 받는다');
    assert.ok(close3(xyz(sys.list()[0].pos), [6, 1, 2]));
    assert.equal(sys.place('p', [NaN, 0, 0]), false);
    assert.equal(sys.place('p', null), false);
    assert.ok(close3(xyz(sys.list()[0].pos), [6, 1, 2]), '잘못된 좌표면 그대로');
    assert.equal(sys.place('nope', [0, 0, 0]), false);
    assert.equal(sys.unstick('nope'), false);
    assert.equal(sys.stick('nope'), false);
  });

  test('unstick: 떼면 다시 중력을 받아 떨어지고 바닥에 멈췄다가 제시간에 터진다', () => {
    const sys = createGrenadeSystem({ floorY: 0 });
    sys.spawn([0, 2, 0], [0, 0, 0], { kind: 'c4', fuse: 2.5, id: 'u' });
    const clock = { t: 0 };
    sys.stick('u');
    run(sys, 0.4, clock);
    assert.ok(near(sys.list()[0].pos[1], 2), '붙어 있는 동안 떨어지지 않는다');
    assert.equal(sys.unstick('u'), true);
    let g = sys.list()[0];
    assert.equal(g.stuck, false);
    assert.equal(g.sleeping, false);
    run(sys, 0.3, clock);
    g = sys.list()[0];
    assert.ok(g.pos[1] < 2 - 0.3, `떨어진다 ${g.pos[1]}`);
    assert.ok(g.vel[1] < 0);
    run(sys, 1.2, clock);
    g = sys.list()[0];
    assert.ok(g && g.pos[1] < 0.2 && g.pos[1] > 0, `바닥에 ${g && g.pos[1]}`);
    const boom = run(sys, 0.8, clock).filter((e) => e.type === 'explode');
    assert.equal(boom.length, 1);
    assert.ok(boom[0].at >= 2.5 - 1e-6 && boom[0].at < 2.5 + 1 / 60 + 1e-6, String(boom[0].at));
  });

  test('붙은 C4도 detonate는 다음 진행에서 바로 터뜨린다', () => {
    const sys = createGrenadeSystem({ floorY: 0 });
    sys.spawn([0, 2, 0], [0, 0, 0], { kind: 'c4', fuse: 2.5, id: 'd' });
    sys.stick('d');
    assert.equal(sys.detonate('d'), true);
    const ev = run(sys, 1 / 60);
    assert.equal(ev.filter((e) => e.type === 'explode').length, 1);
  });
});

/* ================================================================== 검기 판정 수학 */

describe('검기 판정 수학(contact.js)', () => {
  const R = 0.7;
  const walker = (x, z, o = {}) => ({ x, y: o.y || 0, z, yaw: 0, s: o.s || 1, low: !!o.low });

  test('정면 좀비: 부풀린 몸 겉면(0.32 + 0.7 m)에서 닿는다', () => {
    const t = waveHitT(0, 1.6, 0, 0, 0, -1, 0, 18, walker(0, -5), R);
    assert.ok(near(t, 5 - 1.02, 1e-9), String(t));
  });

  test('옆으로 비켜 지나가면 닿지 않고, 스치면 늦게 닿는다', () => {
    assert.equal(waveHitT(0, 1.6, 0, 0, 0, -1, 0, 18, walker(1.2, -5), R), -1);
    const t = waveHitT(0, 1.6, 0, 0, 0, -1, 0, 18, walker(1.0, -5), R);
    assert.ok(near(t, 5 - Math.sqrt(1.02 * 1.02 - 1), 1e-9), String(t));
  });

  test('구간 밖이면 -1, 구간 시작에 이미 닿아 있으면 그 시작 거리', () => {
    const z = walker(0, -5);
    assert.equal(waveHitT(0, 1.6, 0, 0, 0, -1, 0, 3, z, R), -1, '아직 못 미쳤다');
    assert.equal(waveHitT(0, 1.6, 0, 0, 0, -1, 4.5, 6, z, R), 4.5, '몸 안에서 시작');
    assert.equal(waveHitT(0, 1.6, 0, 0, 0, -1, 6.1, 8, z, R), -1, '이미 지나갔다');
    assert.equal(waveHitT(0, 1.6, 0, 0, 0, -1, 5, 4, z, R), -1, '거꾸로 된 구간');
    assert.equal(waveHitT(0, 1.6, 0, 0, 0, -1, 0, 18, null, R), -1);
  });

  test('높이: 눈높이 검기는 기어 다니는 좀비 위로 지나가고, 내려 겨누면 맞는다', () => {
    const crawler = walker(0, -5, { low: true, s: 0.9 });
    assert.equal(waveHitT(0, 1.6, 0, 0, 0, -1, 0, 18, crawler, R), -1);
    const a = 15 * Math.PI / 180;
    const t = waveHitT(0, 1.6, 0, 0, -Math.sin(a), -Math.cos(a), 0, 18, crawler, R);
    assert.ok(t > 3 && t < 5.5, String(t));
    // 서 있는 좀비 머리 위 높이(1.85 + 0.7 m 위)로 지나가면 닿지 않는다
    assert.equal(waveHitT(0, 2.6, 0, 0, 0, -1, 0, 18, walker(0, -5), R), -1);
  });

  test('곧게 내려가는 검기(수평 이동 없음)도 계산하고, 크기 배율은 몸을 키운다', () => {
    const t = waveHitT(0, 5, -5, 0, -1, 0, 0, 10, walker(0, -5), R);
    assert.ok(near(t, 5 - (1.85 + R), 1e-9), String(t));
    assert.equal(waveHitT(2, 5, -5, 0, -1, 0, 0, 10, walker(0, -5), R), -1, '옆에서 내려가면 안 닿는다');
    const boss = waveHitT(0, 1.6, 0, 0, 0, -1, 0, 18, walker(0, -5, { s: 2 }), R);
    assert.ok(near(boss, 5 - (0.64 + R), 1e-9), String(boss));
    const bad = waveHitT(0, 1.6, 0, 0, 0, -1, 0, 18, { x: 0, y: 0, z: -5, s: NaN }, R);
    assert.ok(near(bad, 5 - 1.02, 1e-9), '배율이 이상하면 1');
  });

  test('waveHitPoint: 검기 중심에서 좀비 쪽으로 r만큼, 높이는 몸 안', () => {
    const z = walker(0, -5);
    const t = waveHitT(0, 1.6, 0, 0, 0, -1, 0, 18, z, R);
    const p = waveHitPoint(0, 1.6, 0, 0, 0, -1, t, z, R);
    assert.ok(close3(p, [0, 1.6, -(t + R)], 1e-9), JSON.stringify(p));
    const high = waveHitPoint(0, 3, 0, 0, 0, -1, 4, z, R);
    assert.ok(near(high[1], 1.7), '머리 위로 높게 지나가도 몸 높이로 자른다');
    const out = [9, 9, 9];
    assert.equal(waveHitPoint(0, 1.6, 0, 0, 0, -1, t, z, R, out), out, 'out에 쓴다');
    const onAxis = waveHitPoint(0, 1, -5, 0, -1, 0, 0, z, R);
    assert.ok(finite3(onAxis) && near(onAxis[0], 0) && near(onAxis[2], -5), '축 위에서도 NaN 없이');
  });

  test('losReach: 벽까지의 거리(끝까지 보이면 range, 이상한 입력은 안전하게)', () => {
    const o = [0, 1.6, 0], d = [0, 0, -1];
    const wallAt = (w) => (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) <= w;
    assert.equal(losReach(wallAt(100), o, d, 18), 18);
    const r = losReach(wallAt(7.3), o, d, 18);
    assert.ok(r <= 7.3 && r > 7.3 - 18 / 128, String(r));
    assert.equal(losReach(wallAt(0), o, d, 18), 0, '바로 앞이 벽');
    assert.equal(losReach(() => { throw new Error('x'); }, o, d, 18), 0, '시선 함수가 던지면 막힌 것으로');
    assert.equal(losReach(null, o, d, 18), 18, '시선 함수가 없으면 range');
    assert.equal(losReach(wallAt(5), o, d, -3), 0);
    assert.equal(losReach(wallAt(5), o, d, NaN), 0);
  });
});

/* ================================================================== C4가 붙는 자리 */

describe('C4가 붙는 자리(contact.js)', () => {
  test('수류탄이 온 쪽 몸 겉면, 가슴 높이(1.1·s)', () => {
    const z = { x: 2, y: 0.5, z: 3, yaw: 0, s: 1, low: false };
    const off = c4Offset(z, 2, 1.2, 3.5, 0, -6);
    assert.ok(near(off.x, 0) && near(off.y, C4_STICK_H) && near(off.z, 0.24), JSON.stringify(off));
    assert.ok(close3(c4WorldPos(z, off), [2, 0.5 + 1.1, 3.24]));
    const side = c4Offset(z, 1, 1, 3, 5, 0);
    assert.ok(close3(c4WorldPos(z, side), [2 - 0.24, 1.6, 3]), '왼쪽에서 오면 왼쪽');
  });

  test('좀비가 돌면 붙은 자리도 같이 돈다(모형 회전과 같은 방향)', () => {
    const z = { x: 0, y: 0, z: 0, yaw: 0, s: 1, low: false };
    const off = c4Offset(z, 0, 1, -2, 0, 0);       // 정면(-z)에 붙음
    assert.ok(close3(c4WorldPos(z, off), [0, 1.1, -0.24]));
    // three.js makeRotationY(π/2): 로컬 -z → 월드 -x
    const turned = c4WorldPos({ ...z, yaw: Math.PI / 2 }, off);
    assert.ok(close3(turned, [-0.24, 1.1, 0], 1e-9), JSON.stringify(turned));
    // 돌아 있는 좀비에 붙여도 닿은 쪽에 붙고, 그대로 되돌리면 같은 자리
    const yz = { x: 1, y: 0, z: 1, yaw: 1.1, s: 1.35, low: false };
    const o2 = c4Offset(yz, 3, 1, 1, 0, 0);
    assert.ok(close3(c4WorldPos(yz, o2), [1 + 0.24 * 1.35, 1.1 * 1.35, 1], 1e-9));
  });

  test('머리 위로 떨어지면 날아온 쪽, 그것도 없으면 정면. 기어 다니는 좀비는 낮게', () => {
    const z = { x: 0, y: 0, z: 0, yaw: 0, s: 1, low: false };
    const top = c4Offset(z, 0.01, 1.9, 0, 0, -4);  // -z로 날아오다 위에 떨어짐 → 온 쪽(+z)
    assert.ok(close3(c4WorldPos(z, top), [0, 1.1, 0.24], 1e-9), JSON.stringify(top));
    const still = c4Offset(z, 0, 1.9, 0, 0, 0);
    assert.ok(close3(c4WorldPos(z, still), [0, 1.1, -0.24], 1e-9), '정면');
    const crawl = c4Offset({ x: 0, y: 0, z: 0, yaw: 0, s: 0.9, low: true }, 0, 0.3, 1, 0, 0);
    assert.ok(near(crawl.y, C4_STICK_H_LOW * 0.9) && near(crawl.z, 0.3 * 0.9), JSON.stringify(crawl));
    const out = [0, 0, 0];
    assert.equal(c4WorldPos(z, still, out), out, 'out에 쓴다');
    const nanYaw = c4WorldPos({ ...z, yaw: NaN }, still);
    assert.ok(finite3(nanYaw));
  });
});

/* ================================================================== view.js (three.js 대역) */

/** horde/view.js가 쓰는 three.js 조각만 흉내 낸다(행렬·색은 계산하지 않는다) */
function fakeThree() {
  class Vector3 {
    constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
    setScalar(s) { return this.set(s, s, s); }
    copy(v) { return this.set(v.x, v.y, v.z); }
    applyQuaternion() { return this; }
    addScaledVector(v, s) { this.x += v.x * s; this.y += v.y * s; this.z += v.z * s; return this; }
    lengthSq() { return this.x * this.x + this.y * this.y + this.z * this.z; }
    normalize() { const l = Math.sqrt(this.lengthSq()) || 1; return this.set(this.x / l, this.y / l, this.z / l); }
    negate() { return this.set(-this.x, -this.y, -this.z); }
  }
  class Quaternion { copy() { return this; } identity() { return this; } setFromRotationMatrix() { return this; } setFromUnitVectors() { return this; } }
  class Matrix4 {
    makeTranslation() { return this; } makeRotationY() { return this; } makeScale() { return this; } multiply() { return this; }
    copy() { return this; } compose() { return this; } makeRotationFromEuler() { return this; } makeBasis() { return this; }
  }
  class Euler { set() { return this; } }
  class Color { setHex() { return this; } multiplyScalar() { return this; } lerp() { return this; } copy() { return this; } }
  class Geometry { rotateX() { return this; } translate() { return this; } setAttribute() { return this; } setIndex() { return this; } computeBoundingSphere() {} setFromPoints() { return this; } dispose() {} }
  class Material { constructor(o = {}) { Object.assign(this, o); this.color = new Color(); } dispose() {} }
  class Object3D {
    constructor(geometry, material) {
      this.geometry = geometry; this.material = material; this.visible = true; this.children = [];
      this.position = new Vector3(); this.scale = new Vector3(1, 1, 1); this.rotation = new Vector3(); this.quaternion = new Quaternion();
    }
    add(...c) { this.children.push(...c); }
  }
  class InstancedMesh extends Object3D {
    constructor(g, m, n) { super(g, m); this.count = n; this.instanceMatrix = { count: n, needsUpdate: false, setUsage() {} }; this.instanceColor = null; }
    setMatrixAt() {}
    setColorAt() { if (!this.instanceColor) this.instanceColor = { needsUpdate: false, setUsage() {} }; }
    dispose() {}
  }
  return {
    Vector3, Quaternion, Matrix4, Euler, Color, InstancedMesh, Mesh: Object3D, Group: Object3D, Line: Object3D, Sprite: Object3D,
    BoxGeometry: Geometry, ConeGeometry: Geometry, RingGeometry: Geometry, CircleGeometry: Geometry, PlaneGeometry: Geometry,
    CylinderGeometry: Geometry, SphereGeometry: Geometry, IcosahedronGeometry: Geometry, BufferGeometry: Geometry,
    Float32BufferAttribute: class {}, CanvasTexture: class { dispose() {} },
    MeshLambertMaterial: Material, MeshBasicMaterial: Material, LineBasicMaterial: Material, SpriteMaterial: Material,
    DynamicDrawUsage: 1, AdditiveBlending: 2, DoubleSide: 2, SRGBColorSpace: 'srgb'
  };
}
function fakeScene() {
  return { children: [], add(o) { this.children.push(o); }, remove(o) { this.children = this.children.filter((c) => c !== o); } };
}

describe('검기·쓰러진 동료·좀비 찾기(view.js, three.js 대역)', () => {
  const zombie = (id, x, z, o = {}) => ({
    id, boss: null, type: { scale: o.s || 1, low: !!o.low }, pos: [x, o.y || 0, z], yaw: o.yaw || 0, hpFrac: 1, flags: o.flags || 0, dead: !!o.dead
  });
  function setup(zs, players = []) {
    const scene = fakeScene();
    const v = createHordeView({ THREE: fakeThree(), scene });
    v.setActive(true);
    v.push({ zombies: zs, players }, 1000, 'me');
    let now = 1000;
    const frame = (n = 1, frozen = false) => { for (let i = 0; i < n; i++) { now += 1000 / 60; v.frame(1 / 60, now, frozen); } };
    frame();
    return { v, scene, frame };
  }

  test('보스 장판은 종류별 상승 입자를 그리고 만료되면 걷힌다', () => {
    const { v, scene, frame } = setup([]);
    const wisps = scene.children.find((o) => o.name === 'horde:field-wisps');
    v.push({ zombies: [], hazards: [
      { id: 1, kind: HAZARD_KINDS.acid, pos: [1, 0, 2], r: 3, leftMs: 1000 },
      { id: 2, kind: HAZARD_KINDS.fire, pos: [4, 0, 2], r: 2, leftMs: 1000 }
    ] }, 1000, 'me');
    frame();
    assert.equal(wisps.count, 6);
    frame(60);
    assert.equal(wisps.count, 0);
    v.dispose();
  });

  test('검기 상수는 규칙 값을 따른다', () => {
    assert.equal(HORDE.waveSpeed, 26);
    assert.equal(HORDE.waveRadius, 0.7);
    assert.equal(HORDE.waveMaxHits, 1);
  });

  test('AI 안경은 전방 15° 안의 보이는 몸통으로만 탄도를 돌린다', () => {
    const eye = [0, 1.6, 0], forward = [0, 0, -1];
    const { v } = setup([zombie(1, 1, -8), zombie(2, 4, -8), zombie(3, 0, 6)]);
    const aim = v.autoAim(eye, forward, 30, () => true);
    assert.ok(aim && aim[0] > 0 && aim[2] < 0);
    assert.equal(v.ray(eye, aim, 30)[0].part, 'body');
    assert.equal(v.autoAim(eye, forward, 30, () => false), null, '벽 너머는 조준하지 않는다');
    assert.equal(v.autoAim(eye, forward, 5, () => true), null, '사거리 밖은 조준하지 않는다');
    v.setActive(false);
    assert.equal(v.autoAim(eye, forward, 30), null);
  });

  test('내 검기: 지나가는 좀비 중 가장 가까운 한 마리만(exclude는 건너뛴다) 맞힌다', () => {
    const zs = [];
    for (let i = 1; i <= 8; i++) zs.push(zombie(i, 0, -(1 + 2 * i)));   // 3, 5, …, 17 m
    zs.push(zombie(20, 3, -6));                                         // 옆으로 비켜 선 좀비
    const { v, frame } = setup(zs);
    const hits = [];
    assert.equal(v.wave({ origin: [0, 1.6, 0], dir: [0, 0, -2], range: 30, local: true, kind: 'wave', exclude: 'z1', onHit: (h) => hits.push(h) }), true);
    assert.equal(v.stats.waves, 1);
    frame(90);
    assert.deepEqual(hits.map((h) => h.id), ['z2']);
    for (const h of hits) {
      const n = Number(h.id.slice(1));
      assert.ok(near(h.dist, 1 + 2 * n - (0.32 + 0.7), 1e-6), `${h.id} ${h.dist}`);
      assert.ok(finite3(h.point) && h.point[1] >= 0.5 && h.point[1] <= 1.7);
      assert.equal(h.boss, false);
    }
    assert.equal(v.stats.waves, 0, '끝까지 가서 사라졌다');
  });

  test('벽(los false)에서 멈춰 그 뒤 좀비는 맞히지 않는다', () => {
    const { v, frame } = setup([zombie(1, 0, -3), zombie(2, 0, -6)]);
    const hits = [];
    const los = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) <= 4;
    v.wave({ origin: [0, 1.6, 0], dir: [0, 0, -1], range: 12, local: true, kind: 'wave', los, onHit: (h) => hits.push(h.id) });
    frame(60);
    assert.deepEqual(hits, ['z1']);
  });

  test('검기는 앞으로만: 출발할 때 겹쳐 있던 뒤·옆 좀비는 맞지 않는다', () => {
    // 뒤 0.9 m, 옆 0.95 m는 부풀린 몸(0.32 + 0.7 m) 안이라 예전에는 거리 0으로 맞았다
    const { v, frame } = setup([zombie(1, 0, 0.9), zombie(2, 0.95, 0), zombie(3, 0, -3)]);
    const hits = [];
    v.wave({ origin: [0, 1.6, 0], dir: [0, 0, -1], range: 8, local: true, kind: 'wave', onHit: (h) => hits.push(h.id) });
    frame(40);
    assert.deepEqual(hits, ['z3']);
  });

  test('검기는 벽 너머 좀비를 맞히지 않는다(멈춘 자리 바로 뒤, 길 옆 벽 너머)', () => {
    // 앞을 막는 벽(z = -2): 멈춘 검기의 판정 구가 벽 뒤 좀비(z = -2.5)에 닿아도 가려져 있다
    const front = (a, b) => !(Math.min(a[2], b[2]) < -2 && Math.max(a[2], b[2]) > -2);
    const a = setup([zombie(1, 0, -2.5)]);
    const hitsA = [];
    a.v.wave({ origin: [0, 1.6, 0], dir: [0, 0, -1], range: 10, local: true, kind: 'wave', los: front, onHit: (h) => hitsA.push(h.id) });
    a.frame(40);
    assert.deepEqual(hitsA, []);
    // 길을 따라 선 벽(x = 0.4): 벽 너머 좀비(x = 0.9)는 판정 구에 닿아도 맞지 않고, 길 위 좀비는 맞는다
    const side = (p, q) => (p[0] - 0.4) * (q[0] - 0.4) >= 0;
    const b = setup([zombie(1, 0.9, -4), zombie(2, 0, -6)]);
    const hitsB = [];
    b.v.wave({ origin: [0, 1.6, 0], dir: [0, 0, -1], range: 10, local: true, kind: 'wave', los: side, onHit: (h) => hitsB.push(h.id) });
    b.frame(40);
    assert.deepEqual(hitsB, ['z2']);
  });

  test('남의 검기(local:false)는 보이기만 하고 맞히지 않는다. delayMs 동안은 날지 않는다', () => {
    const { v, frame } = setup([zombie(1, 0, -2)]);
    let called = 0;
    v.wave({ origin: [0, 1.6, 0], dir: [0, 0, -1], range: 8, local: false, kind: 'waveStab', onHit: () => { called++; } });
    frame(60);
    assert.equal(called, 0);
    const hits = [];
    v.wave({ origin: [0, 1.6, 0], dir: [0, 0, -1], range: 8, local: true, kind: 'wave', delayMs: 200, onHit: (h) => hits.push(h.id) });
    frame(6);                                                           // 100 ms: 아직 기다린다
    assert.deepEqual(hits, []);
    assert.equal(v.stats.waves, 1);
    frame(12);
    assert.deepEqual(hits, ['z1']);
  });

  test('일시정지(frozen) 동안 검기는 멈춰 있고 맞히지 않는다', () => {
    const { v, frame } = setup([zombie(1, 0, -4)]);
    const hits = [];
    v.wave({ origin: [0, 1.6, 0], dir: [0, 0, -1], range: 8, local: true, kind: 'wave', onHit: (h) => hits.push(h.id) });
    frame(120, true);
    assert.deepEqual(hits, []);
    assert.equal(v.stats.waves, 1, '사라지지도 않는다');
    frame(30);
    assert.deepEqual(hits, ['z1']);
  });

  test('쓰러진 좀비는 맞히지 않고, 이상한 입력은 날리지 않는다', () => {
    const { v, frame } = setup([zombie(1, 0, -3, { flags: ZF.dead, dead: true }), zombie(2, 0, -5)]);
    const hits = [];
    v.wave({ origin: [0, 1.6, 0], dir: [0, 0, -1], range: 10, local: true, kind: 'wave', onHit: (h) => hits.push(h.id) });
    frame(40);
    assert.deepEqual(hits, ['z2']);
    assert.equal(v.wave({ origin: [0, 0, 0], dir: [0, 0, 0], range: 5, local: true }), false);
    assert.equal(v.wave({ origin: [NaN, 0, 0], dir: [0, 0, -1], range: 5, local: true }), false);
    assert.equal(v.wave({ origin: [0, 0, 0], dir: [0, 0, -1], range: 0, local: true }), false);
    assert.equal(v.wave(null), false);
    v.setActive(false);
    assert.equal(v.wave({ origin: [0, 0, 0], dir: [0, 0, -1], range: 5, local: true }), false, '꺼져 있으면 날리지 않는다');
  });

  test('검기 풀: 한꺼번에 많이 날려도 상한 안에서 다시 쓰고, clear·dispose가 정리한다', () => {
    const { v, scene, frame } = setup([zombie(1, 0, -3)]);
    for (let i = 0; i < 40; i++) v.wave({ origin: [0, 1.6, 0], dir: [Math.sin(i), 0, -Math.cos(i)], range: 10, local: false, kind: 'wave' });
    assert.ok(v.stats.waves <= 16, String(v.stats.waves));
    assert.ok(scene.children.filter((m) => m.name === 'horde:wave').length <= 16);
    frame(2);
    v.clear();
    assert.equal(v.stats.waves, 0);
    assert.doesNotThrow(() => v.dispose());
    assert.equal(scene.children.filter((m) => m.name === 'horde:wave').length, 0);
  });

  test('쓰러진 동료 표시: 접속 중인 쓰러진 동료만, 나는 빼고', () => {
    const players = [
      { id: 'me', name: '나', alive: false, connected: true, down: { pos: [0, 0, 0], progress: 0, by: null } },
      { id: 'b', name: '을', alive: false, connected: true, down: { pos: [3, 0.5, -2], progress: 0.62, by: 'c' } },
      { id: 'c', name: '병', alive: true, connected: true, down: null },
      { id: 'd', name: '정', alive: false, connected: false, down: { pos: [1, 0, 1], progress: 0, by: null } },
      { id: 'e', name: '무', alive: false, connected: true, down: null },
      { id: 'f', name: '기', alive: false, connected: true, down: { pos: [NaN, 0, 0], progress: 0, by: null } }
    ];
    const { v, frame } = setup([], players);
    assert.equal(v.stats.downs, 1);
    assert.deepEqual(v.downs, [{ id: 'b', name: '을', pos: [3, 0.5, -2], progress: 0.62, by: 'c' }]);
    frame(3);
    v.push({ zombies: [], players: players.map((p) => (p.id === 'b' ? { ...p, alive: true, down: null } : p)) }, 1200, 'me');
    assert.equal(v.stats.downs, 0, '일어나면 사라진다');
    v.push({ zombies: [], players }, 1300);
    assert.equal(v.stats.downs, 2, 'meId를 안 주면 나도 보인다');
    v.clear();
    assert.equal(v.stats.downs, 0);
  });

  test('touchingZombie·zombieAt: 그린 좀비 중 닿은 것·번호로 찾기(쓰러진 좀비는 없다)', () => {
    const { v } = setup([zombie(3, 0, -5, { yaw: 0.5 }), zombie(4, 0.5, -5), zombie(5, 9, 9, { flags: ZF.dead, dead: true })]);
    const t = v.touchingZombie([0.05, 1, -5], 0.45);
    assert.equal(t.id, 3, '가장 가까운 좀비');
    assert.deepEqual([t.x, t.y, t.z, t.yaw, t.s, t.low, t.boss], [0, 0, -5, 0.5, 1, false, false]);
    assert.equal(v.touchingZombie([0, 2.5, -5], 0.45), null, '머리 위 높이');
    assert.equal(v.touchingZombie([3, 1, -5], 0.45), null);
    assert.equal(v.touchingZombie(null), null);
    assert.equal(v.zombieAt('z4').x, 0.5);
    assert.equal(v.zombieAt(3).yaw, 0.5);
    assert.equal(v.zombieAt('z5'), null, '쓰러진 좀비');
    assert.equal(v.zombieAt('z99'), null);
    assert.equal(v.zombieAt(null), null);
    v.setActive(false);
    assert.equal(v.zombieAt(3), null);
    assert.equal(v.touchingZombie([0, 1, -5]), null);
  });

  test('touchingZombie: 땅에서 솟아오르는 중인 좀비에는 C4가 붙지 않고, 다 올라오면 붙는다', () => {
    const { v, frame } = setup([zombie(7, 0, -5, { flags: ZF.rise })]);
    assert.equal(v.touchingZombie([0, 0.1, -5], 0.45), null, '솟아오르는 중(몸이 바닥 아래)');
    assert.ok(v.zombieAt(7), '그려지기는 한다');
    v.push({ zombies: [zombie(7, 0, -5)], players: [] }, 1800, 'me');
    frame(45);                                                          // 650 ms가 지나 다 올라왔다
    const t = v.touchingZombie([0, 1, -5], 0.45);
    assert.ok(t && t.id === 7, JSON.stringify(t));
  });
});
