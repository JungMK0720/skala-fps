/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 물리 소품(js/engine/props.js) 시험. 순수 도우미와 cannon-es 실패 경로는 항상 돌고,
 *          실제 시뮬레이션 시험은 node에서 cannon-es를 불러올 수 있을 때만 돈다(없으면 건너뜀).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { LIMITS, PLAYER } from '../js/core/consts.js';
import { makeBox, rampHeight, solidToCollider } from '../js/engine/physics.js';
import {
  blastImpulse,
  clampAccumulator,
  createProps,
  groundPlaneY,
  isOutOfWorld,
  normalizeProps,
  propMass,
  propShape,
  qualityProfile,
  rampWedge,
  selectStaticColliders,
  worldLimits
} from '../js/engine/props.js';

const STEP = 1 / 60;
const CANNON = await import('cannon-es').catch(() => null);
const needsCannon = CANNON ? false : 'cannon-es를 불러올 수 없어 건너뜀';

/* ---------------- three.js 대역 ---------------- */

function fakeThree() {
  const disposed = [];
  class Vector3 {
    constructor(x = 0, y = 0, z = 0) { this.set(x, y, z); }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  }
  class Vector2 { constructor(x = 0, y = 0) { this.x = x; this.y = y; } }
  class Quaternion {
    constructor() { this.set(0, 0, 0, 1); }
    set(x, y, z, w) { this.x = x; this.y = y; this.z = z; this.w = w; return this; }
  }
  class Color { set(hex) { this.hex = hex; return this; } }
  class Matrix4 {
    compose(p, q, s) { this.p = [p.x, p.y, p.z]; this.q = [q.x, q.y, q.z, q.w]; this.s = [s.x, s.y, s.z]; return this; }
  }
  class Group {
    constructor() { this.children = []; }
    add(o) { this.children.push(o); }
  }
  class Geometry {
    constructor() { this.attributes = { uv: { count: 0 }, position: {} }; }
    dispose() { disposed.push(this); }
  }
  class BoxGeometry extends Geometry {}
  class LatheGeometry extends Geometry {}
  class MeshLambertMaterial {
    constructor(o) { Object.assign(this, o); }
    dispose() { disposed.push(this); }
  }
  class InstancedMesh {
    constructor(geometry, material, capacity) {
      this.geometry = geometry;
      this.material = material;
      this.capacity = capacity;
      this.count = capacity;
      this.instanceMatrix = { setUsage() {}, needsUpdate: false };
      this.instanceColor = null;
      this.matrices = [];
    }
    setMatrixAt(i, m) { this.matrices[i] = { p: m.p.slice(), q: m.q.slice(), s: m.s.slice() }; }
    setColorAt() { this.instanceColor = this.instanceColor || { needsUpdate: false }; }
    dispose() { disposed.push(this); }
  }
  return {
    disposed,
    THREE: { Vector3, Vector2, Quaternion, Color, Matrix4, Group, BoxGeometry, LatheGeometry, MeshLambertMaterial, InstancedMesh, DynamicDrawUsage: 1, SRGBColorSpace: 'srgb' }
  };
}

function fakeScene() {
  return {
    children: [],
    add(o) { if (!this.children.includes(o)) this.children.push(o); },
    remove(o) { this.children = this.children.filter((c) => c !== o); }
  };
}

/** 대역 위에 createProps를 올린다. 시험은 mesh.matrices로 위치를 읽는다 */
function makeProps(opt = {}) {
  const { THREE, disposed } = fakeThree();
  const scene = fakeScene();
  const player = { pos: opt.playerPos || null };
  const props = createProps({
    THREE,
    scene,
    getPlayerPos: () => player.pos,
    getMapData: opt.getMapData,
    getColliders: opt.getColliders,
    quality: opt.quality,
    loadCannon: opt.loadCannon || (async () => CANNON)
  });
  const crates = () => scene.children[0].children[0];
  const barrels = () => scene.children[0].children[1];
  const run = (seconds, dt = STEP) => { for (let t = 0; t < seconds; t += dt) props.update(dt); };
  return { props, scene, player, disposed, crates, barrels, run };
}

/** console.warn을 잠깐 가로챈다 */
async function captureWarnings(fn) {
  const original = console.warn;
  const calls = [];
  console.warn = (...args) => calls.push(args);
  try { await fn(); } finally { console.warn = original; }
  return calls;
}

const failingLoader = () => Promise.reject(new Error('네트워크 없음'));
const crate = (x, y = 0, z = 0, extra = {}) => ({ type: 'crate', x, y, z, ...extra });
const horizontal = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]);

/* ---------------- 형태 · 명세 ---------------- */

test('propShape: 상자는 정육면체, 드럼통은 세로 원통으로 매핑한다', () => {
  assert.deepEqual(propShape('crate', 1), { kind: 'box', hx: 0.5, hy: 0.5, hz: 0.5 });
  const barrel = propShape('barrel', 1);
  assert.equal(barrel.kind, 'cyl');
  assert.equal(barrel.hy, 0.5);
  assert.equal(barrel.hx, barrel.hz);
  assert.ok(barrel.hx > 0.2 && barrel.hx < 0.5);
  assert.equal(propShape('tank', 1), null);
  assert.equal(propShape('constructor', 1), null);
});

test('propShape: size가 없거나 이상하면 기본값, 범위 밖이면 자른다', () => {
  const base = propShape('crate');
  assert.ok(base.hx > 0);
  assert.deepEqual(propShape('crate', -3), base);
  assert.deepEqual(propShape('crate', NaN), base);
  assert.deepEqual(propShape('crate', 'big'), base);
  assert.ok(propShape('crate', 1000).hx <= 1.5);
  assert.ok(propShape('crate', 0.001).hx >= 0.1);
});

test('propMass: 지정값을 쓰고, 없으면 큰 소품이 더 무겁다', () => {
  const small = propShape('crate', 0.6), big = propShape('crate', 1.2);
  assert.equal(propMass('crate', small, 33), 33);
  assert.ok(propMass('crate', big) > propMass('crate', small));
  assert.ok(propMass('barrel', propShape('barrel')) > 0);
  assert.ok(propMass('crate', big, 1e9) <= 200);
  assert.equal(propMass('crate', small, -1), propMass('crate', small));
});

test('normalizeProps: 잘못된 항목을 버리고 밑면 y·기본값을 채운다', () => {
  const list = [
    crate(1, 2, 3, { size: 1, mass: 10 }),
    { type: 'barrel', x: 0, z: 0 },
    { type: 'tank', x: 0, y: 0, z: 0 },
    { type: 'crate', x: 'a', y: 0, z: 0 },
    null,
    7
  ];
  const out = normalizeProps(list);
  assert.equal(out.length, 2);
  assert.deepEqual(
    { x: out[0].x, y: out[0].y, z: out[0].z, hy: out[0].hy, mass: out[0].mass, kind: out[0].kind },
    { x: 1, y: 2, z: 3, hy: 0.5, mass: 10, kind: 'box' }
  );
  assert.equal(out[1].y, 0);
  assert.equal(out[1].kind, 'cyl');
  assert.deepEqual(normalizeProps(undefined), []);
  assert.deepEqual(normalizeProps({ length: 3 }), []);
});

test('normalizeProps: LIMITS.PROPS개에서 자른다', () => {
  const many = Array.from({ length: LIMITS.PROPS + 25 }, (_, i) => crate(i));
  assert.equal(normalizeProps(many).length, LIMITS.PROPS);
  assert.equal(normalizeProps(many, 5).length, 5);
  assert.equal(normalizeProps(many, 9999).length, LIMITS.PROPS);
  assert.equal(normalizeProps(many)[0].x, 0);
});

/* ---------------- 품질 · 시간 · 폭발 ---------------- */

test('qualityProfile: low는 활성 수·솔버 반복·서브스텝을 줄인다', () => {
  const low = qualityProfile('low'), high = qualityProfile('high');
  assert.equal(high.maxActive, LIMITS.PROPS);
  assert.ok(low.maxActive < high.maxActive);
  assert.ok(low.iterations < high.iterations);
  assert.ok(low.maxSubSteps <= high.maxSubSteps);
  assert.deepEqual(qualityProfile(undefined), high);
});

test('clampAccumulator: 긴 프레임이 쌓여도 maxSub 스텝을 넘지 않는다', () => {
  assert.ok(Math.abs(clampAccumulator(0, 0.01, STEP, 3) - 0.01) < 1e-12);
  assert.equal(clampAccumulator(0, 10, STEP, 3), STEP * 3);
  assert.equal(clampAccumulator(STEP * 3, 10, STEP, 3), STEP * 3);
  assert.equal(clampAccumulator(0.01, -5, STEP, 3), 0.01);
  assert.equal(clampAccumulator(0.01, NaN, STEP, 3), 0.01);
  assert.equal(clampAccumulator(0.01, Infinity, STEP, 3), 0.01);
});

test('blastImpulse: 중심에서 최대, 멀수록 줄고 반경 밖은 0', () => {
  assert.equal(blastImpulse(0, 6, 100), 100);
  assert.equal(blastImpulse(-2, 6, 100), 100);
  assert.equal(blastImpulse(3, 6, 100), 50);
  assert.equal(blastImpulse(6, 6, 100), 0);
  assert.equal(blastImpulse(9, 6, 100), 0);
  assert.equal(blastImpulse(1, 0, 100), 0);
  assert.equal(blastImpulse(1, 6, -5), 0);
  assert.equal(blastImpulse(NaN, 6, 100), 0);
  assert.ok(blastImpulse(1, 6, 100) > blastImpulse(2, 6, 100));
});

/* ---------------- 정적 세계 ---------------- */

test('groundPlaneY: 슬래브가 없거나 1장이면 평면, 구멍이 있으면 상자로', () => {
  assert.equal(groundPlaneY([]), 0);
  assert.equal(groundPlaneY(null), 0);
  assert.equal(groundPlaneY([makeBox(0, 0, 0, 1, 2, 1)]), 0);
  assert.equal(groundPlaneY([makeBox(-9, -2, -9, 9, 0, 9, 'asphalt', { tag: 'ground' })]), 0);
  assert.equal(groundPlaneY([makeBox(-9, -2, -9, 9, 1.5, 9, 'asphalt', { tag: 'ground' })]), 1.5);
  const slabs = [makeBox(-9, -2, -9, 0, 0, 9, 'asphalt', { tag: 'ground' }), makeBox(2, -2, -9, 9, 0, 9, 'asphalt', { tag: 'ground' })];
  assert.equal(groundPlaneY(slabs), null);
  // 구멍이 맵 가장자리에 있으면 슬래브가 1장만 남아도 평면을 쓰면 안 된다
  assert.equal(groundPlaneY([makeBox(-9, -2, -9, 5, 0, 9, 'asphalt', { tag: 'ground' }), makeBox(5, -3, -9, 9, 0, 9, 'water')]), null);
  // 슬래브 없는 맵(physics floorY 0)의 물 상자는 평면을 바꾸지 않는다
  assert.equal(groundPlaneY([makeBox(5, -3, -9, 9, 0, 9, 'water')]), 0);
});

test('selectStaticColliders: 소품 근처만 고르고 외곽 벽은 항상 넣는다', () => {
  const specs = normalizeProps([crate(0)]);
  const near = makeBox(2, 0, 0, 3, 2, 1);
  const far = makeBox(50, 0, 0, 51, 2, 1);
  const high = makeBox(0, 40, 0, 1, 41, 1);
  const bounds = makeBox(100, -20, -100, 102, 80, 100, 'invisible', { tag: 'bounds', noRay: true });
  const out = selectStaticColliders([near, far, high, bounds, null, { kind: 'mystery' }], specs);
  assert.ok(out.includes(near));
  assert.ok(out.includes(bounds));
  assert.ok(!out.includes(far));
  assert.ok(!out.includes(high));
  assert.equal(out.length, 2);
  assert.deepEqual(selectStaticColliders(null, specs), []);
});

test('selectStaticColliders: clip 막이와 물은 빼고, 평면을 쓰면 슬래브도 뺀다', () => {
  const specs = normalizeProps([crate(0)]);
  const clip = makeBox(1, 0, 0, 2, 5, 1, 'invisible', { tag: 'clip', noRay: true });
  const water = makeBox(1, -3, 2, 3, 0, 4, 'water');
  const slab = makeBox(-9, -2, -9, 9, 0, 9, 'asphalt', { tag: 'ground' });
  assert.deepEqual(selectStaticColliders([clip, water, slab], specs, { planeY: 0 }), []);
  assert.deepEqual(selectStaticColliders([clip, water, slab], specs, { planeY: null }), [slab]);
});

test('selectStaticColliders: max를 넘으면 가까운 것부터 남긴다', () => {
  const specs = normalizeProps([crate(0)]);
  const list = [8, 2, 6, 4].map((x) => makeBox(x, 0, 0, x + 0.5, 2, 1));
  const out = selectStaticColliders(list, specs, { max: 2 });
  assert.deepEqual(out.map((c) => c.minX), [2, 4]);
});

test('selectStaticColliders: 원통·경사로도 고른다', () => {
  const specs = normalizeProps([crate(0)]);
  const cyl = solidToCollider({ type: 'cyl', x: 2, y: 0, z: 0, r: 0.5, h: 3 });
  const ramp = solidToCollider({ type: 'ramp', x: 0, y: 0, z: 3, w: 4, h: 1, d: 2, dir: '+x' });
  assert.deepEqual(selectStaticColliders([cyl, ramp], specs).map((c) => c.kind).sort(), ['cyl', 'ramp']);
});

for (const dir of ['+x', '-x', '+z', '-z']) {
  test(`rampWedge ${dir}: 면이 바깥을 보고 경사면이 physics.rampHeight와 같다`, () => {
    const c = solidToCollider({ type: 'ramp', x: 1, y: 0.5, z: -2, w: 4, h: 1.5, d: 3, dir });
    const { center, vertices, faces } = rampWedge(c);
    assert.equal(vertices.length, 6);
    assert.equal(faces.length, 5);
    const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    let slope = null;
    for (const face of faces) {
      const [a, b, d] = [vertices[face[0]], vertices[face[1]], vertices[face[2]]];
      const n = cross(sub(b, a), sub(d, b));
      assert.ok(dot(n, a) > 1e-9, `면 ${face}의 법선이 안쪽을 본다`);
      if (n[1] > 1e-9 && (Math.abs(n[0]) > 1e-9 || Math.abs(n[2]) > 1e-9)) slope = { a, n };
    }
    assert.ok(slope, '경사면이 있어야 한다');
    for (const [fx, fz] of [[0.2, 0.3], [0.5, 0.5], [0.9, 0.7]]) {
      const x = c.minX + (c.maxX - c.minX) * fx, z = c.minZ + (c.maxZ - c.minZ) * fz;
      // 경사 평면의 높이를 local 좌표로 풀어 월드 y와 비교한다
      const lx = x - center[0], lz = z - center[2];
      const ly = slope.a[1] - (slope.n[0] * (lx - slope.a[0]) + slope.n[2] * (lz - slope.a[2])) / slope.n[1];
      assert.ok(Math.abs(ly + center[1] - rampHeight(c, x, z)) < 1e-9);
    }
  });
}

test('worldLimits · isOutOfWorld: 외곽 벽이 있으면 벽 밖, 없으면 넉넉히, NaN은 밖', () => {
  const specs = normalizeProps([crate(0)]);
  const walled = worldLimits([makeBox(-20, -20, -20, 20, 80, 20, 'invisible', { tag: 'bounds' }), makeBox(0, -4, 0, 1, 0, 1)], specs);
  assert.deepEqual([walled.minX, walled.maxX, walled.minZ, walled.maxZ], [-20, 20, -20, 20]);
  assert.ok(walled.minY < -4);
  assert.ok(walled.minY > -20, '외곽 벽의 바닥은 낙하 한계에 넣지 않는다');
  assert.equal(isOutOfWorld(0, 0, 0, walled), false);
  assert.equal(isOutOfWorld(21, 0, 0, walled), true);
  assert.equal(isOutOfWorld(0, -100, 0, walled), true);
  assert.equal(isOutOfWorld(NaN, 0, 0, walled), true);
  assert.equal(isOutOfWorld(0, NaN, 0, walled), true);
  const open = worldLimits([], specs);
  assert.ok(open.maxX >= 10, '벽 없는 맵에서 조금 밀었다고 제자리로 돌아가면 안 된다');
  assert.equal(isOutOfWorld(5, 0, 5, open), false);
  assert.equal(isOutOfWorld(5000, 0, 5, open), true);
});

/* ---------------- cannon-es 실패 경로 (항상 돈다) ---------------- */

test('cannon-es를 못 받으면 한 번만 경고하고 고정 소품으로 그린다', async () => {
  const env = makeProps({ loadCannon: failingLoader });
  const map = { props: [crate(1, 0, 2), { type: 'barrel', x: 3, y: 1, z: 4 }] };
  const warnings = await captureWarnings(async () => {
    await env.props.load(map, []);
    await env.props.load(map, []);
  });
  assert.equal(warnings.length, 1);
  assert.equal(env.props.stats().mode, 'static');
  assert.equal(env.props.stats().total, 2);
  assert.equal(env.crates().count, 1);
  assert.equal(env.barrels().count, 1);
  assert.equal(env.crates().matrices[0].p[1], propShape('crate').hy, '중심 = 밑면 + 반높이');
  assert.equal(env.barrels().matrices[0].p[1], 1 + propShape('barrel').hy);
});

test('기본 불러오기: node에 cannon-es가 없어도 던지지 않는다', async () => {
  const { THREE } = fakeThree();
  const props = createProps({ THREE, scene: fakeScene() });
  await captureWarnings(() => props.load({ props: [crate(0)] }, []));
  assert.equal(props.stats().mode, CANNON ? 'physics' : 'static');
  props.update(STEP);
  props.dispose();
});

test('고정 소품에서도 게임 쪽 호출은 조용히 지나간다', async () => {
  const env = makeProps({ loadCannon: failingLoader });
  await captureWarnings(() => env.props.load({ props: [crate(0)] }, []));
  const before = env.crates().matrices[0].p.slice();
  env.props.update(STEP);
  env.props.update(NaN);
  env.props.explode([0, 0, 0], 6, 100);
  assert.equal(env.props.bulletHit([0, 1, -5], [0, 0, 1], 50), false);
  assert.deepEqual(env.crates().matrices[0].p, before);
});

test('소품이 없는 맵에서는 cannon-es를 부르지 않는다', async () => {
  let calls = 0;
  const env = makeProps({ loadCannon: async () => { calls++; return CANNON; } });
  await env.props.load({ id: 'empty' }, []);
  await env.props.load({ props: [] }, []);
  await env.props.load(null, []);
  assert.equal(calls, 0);
  assert.equal(env.props.stats().mode, 'idle');
  assert.equal(env.props.bulletHit([0, 0, 0], [1, 0, 0], 10), false);
});

test('모듈이 이상해도 던지지 않고 고정 소품이 된다', async () => {
  const env = makeProps({ loadCannon: async () => ({}) });
  const warnings = await captureWarnings(() => env.props.load({ props: [crate(0)] }, []));
  assert.equal(warnings.length, 1);
  assert.equal(env.props.stats().mode, 'static');
});

test('load 인자를 생략하면 getMapData·getColliders를 쓴다', async () => {
  const env = makeProps({ loadCannon: failingLoader, getMapData: () => ({ props: [crate(4)] }), getColliders: () => [] });
  await captureWarnings(() => env.props.load());
  assert.equal(env.props.stats().total, 1);
  assert.equal(env.crates().matrices[0].p[0], 4);
});

test('불러오는 사이에 clear하면 늦게 도착한 모듈을 쓰지 않는다', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const env = makeProps({ loadCannon: () => gate });
  const pending = env.props.load({ props: [crate(0)] }, []);
  assert.equal(env.props.stats().mode, 'loading');
  env.props.clear();
  release({ World: class {} });
  await pending;
  assert.equal(env.props.stats().mode, 'idle');
  assert.equal(env.props.stats().total, 0);
});

test('clear와 dispose: 장면에서 빼고 형상·재질·인스턴스를 해제한다', async () => {
  const env = makeProps({ loadCannon: failingLoader });
  await captureWarnings(() => env.props.load({ props: [crate(0), { type: 'barrel', x: 2, y: 0, z: 0 }] }, []));
  assert.equal(env.scene.children.length, 1);
  const group = env.scene.children[0];
  assert.equal(env.props.stats().drawCalls, 2);
  env.props.clear();
  assert.equal(env.scene.children.length, 0);
  assert.equal(env.props.stats().total, 0);
  assert.equal(group.children[0].count, 0);
  assert.equal(env.disposed.length, 0, 'clear는 다음 맵을 위해 자원을 남긴다');
  env.props.dispose();
  // 형상 2 + 재질 2 + 인스턴스 메시 2 (node에는 캔버스가 없어 텍스처는 없다)
  assert.equal(env.disposed.length, 6);
  env.props.dispose();
  assert.equal(env.disposed.length, 6, '두 번 불러도 한 번만 해제한다');
  await env.props.load({ props: [crate(0)] }, []);
  env.props.update(STEP);
  env.props.explode([0, 0, 0]);
  assert.equal(env.props.bulletHit([0, 0, 0], [1, 0, 0]), false);
  assert.equal(env.scene.children.length, 0, 'dispose 뒤에는 다시 올리지 않는다');
});

test('드로우콜: 종류마다 하나, 한 종류만 있으면 하나', async () => {
  const env = makeProps({ loadCannon: failingLoader });
  await captureWarnings(() => env.props.load({ props: Array.from({ length: 30 }, (_, i) => crate(i)) }, []));
  assert.equal(env.props.stats().drawCalls, 1);
  assert.equal(env.crates().capacity, LIMITS.PROPS);
});

/* ---------------- 실제 시뮬레이션 (cannon-es가 있을 때만) ---------------- */

const floorMap = (list) => ({ props: list });
const WALLS = [
  makeBox(-30, -20, -32, 30, 80, -30, 'invisible', { tag: 'bounds' }),
  makeBox(-30, -20, 30, 30, 80, 32, 'invisible', { tag: 'bounds' }),
  makeBox(-32, -20, -30, -30, 80, 30, 'invisible', { tag: 'bounds' }),
  makeBox(30, -20, -30, 32, 80, 30, 'invisible', { tag: 'bounds' })
];

test('시뮬레이션: 떨어지고, 쌓이고, 잠든 뒤 세계를 돌리지 않는다', { skip: needsCannon }, async () => {
  const env = makeProps();
  await env.props.load(floorMap([crate(0, 0), crate(0, 0.9), crate(0, 1.8), crate(4, 3), { type: 'barrel', x: -3, y: 2, z: 0 }]), WALLS);
  assert.equal(env.props.stats().mode, 'physics');
  env.run(4);
  const s = env.props.stats();
  assert.equal(s.active, 0, '4초 안에 모두 잠든다');
  const c = env.crates().matrices;
  const half = propShape('crate').hy;
  assert.ok(Math.abs(c[3].p[1] - half) < 0.02, '떨어진 상자가 바닥에 닿는다');
  assert.ok(Math.abs(c[2].p[1] - half * 5) < 0.05, '3단 탑이 무너지지 않는다');
  assert.ok(horizontal(c[2].p, [0, 0, 0]) < 0.05);
  env.run(1);
  assert.equal(env.props.stats().steps, s.steps, '모두 잠들었고 플레이어가 없으면 스텝을 돌리지 않는다');
});

test('시뮬레이션: 긴 프레임에도 스텝 수가 제한된다', { skip: needsCannon }, async () => {
  const env = makeProps();
  await env.props.load(floorMap([crate(0, 3)]), []);
  env.props.update(10);
  assert.ok(env.props.stats().steps <= qualityProfile('high').maxSubSteps);
  env.props.update(0);
  env.props.update(-1);
  env.props.update(NaN);
  assert.ok(env.props.stats().steps <= qualityProfile('high').maxSubSteps + 1);
});

test('시뮬레이션: 폭발은 가까운 소품을 더 멀리 보내고 반경 밖은 건드리지 않는다', { skip: needsCannon }, async () => {
  const env = makeProps();
  await env.props.load(floorMap([crate(1.2), crate(3.5, 0, 4), crate(20)]), WALLS);
  env.run(2);
  const start = env.crates().matrices.map((m) => m.p.slice());
  env.props.explode({ x: 0, y: 0.1, z: 0 }, 6, 240);
  env.run(1);
  const moved = env.crates().matrices.map((m, i) => horizontal(m.p, start[i]));
  assert.ok(moved[0] > 1, `가까운 상자가 날아간다 (${moved[0]})`);
  assert.ok(moved[1] < moved[0], '먼 상자는 덜 움직인다');
  assert.ok(moved[2] < 0.001, '반경 밖 상자는 그대로다');
  assert.equal(env.props.stats().respawns, 0);
});

test('시뮬레이션: 벽 뒤 소품은 폭발에 맞지 않는다', { skip: needsCannon }, async () => {
  const env = makeProps();
  const wall = makeBox(1, 0, -3, 1.4, 3, 3);
  await env.props.load(floorMap([crate(2.2), crate(-2)]), [wall]);
  env.run(2);
  const start = env.crates().matrices.map((m) => m.p.slice());
  env.props.explode([0, 0.3, 0], 6, 240);
  env.run(0.5);
  assert.ok(horizontal(env.crates().matrices[0].p, start[0]) < 0.001, '벽 뒤 상자');
  assert.ok(horizontal(env.crates().matrices[1].p, start[1]) > 0.5, '열린 쪽 상자');
});

test('시뮬레이션: 폭발 입력이 이상해도 조용히 무시한다', { skip: needsCannon }, async () => {
  const env = makeProps();
  await env.props.load(floorMap([crate(1)]), []);
  env.run(2);
  const start = env.crates().matrices[0].p.slice();
  env.props.explode(null);
  env.props.explode([NaN, 0, 0], 6, 100);
  env.props.explode([0, 0, 0], -1, 100);
  env.props.explode([0, 0, 0], 6, 0);
  env.run(0.2);
  assert.deepEqual(env.crates().matrices[0].p, start);
  assert.equal(env.props.stats().mode, 'physics');
});

test('시뮬레이션: bulletHit은 맞힌 소품만 살짝 밀고 true를 돌려준다', { skip: needsCannon }, async () => {
  const env = makeProps();
  await env.props.load(floorMap([crate(0, 0, 5)]), WALLS);
  env.run(2);
  const start = env.crates().matrices[0].p.slice();
  assert.equal(env.props.bulletHit([0, 0.45, 0], [0, 0, 1], 100), true, '정면으로 쏘면 맞는다');
  env.run(1);
  const moved = env.crates().matrices[0].p;
  assert.ok(moved[2] > start[2], '총알 방향으로 밀린다');
  assert.ok(moved[2] - start[2] < 1, '작은 충격량이다');
  assert.equal(env.props.bulletHit([0, 0.45, 0], [0, 0, -1], 100), false, '반대쪽');
  assert.equal(env.props.bulletHit([0, 0.45, 0], [0, 0, 1], 2), false, 'maxDist(벽까지 거리) 안쪽만 맞는다');
  assert.equal(env.props.bulletHit([0, 0.45, 0], [0, 0, 0], 100), false, '방향 없음');
  assert.equal(env.props.bulletHit([NaN, 0, 0], [0, 0, 1], 100), false);
  assert.equal(env.props.bulletHit([0, 0.45, 0], [0, 0, 10], 100), true, '방향 길이는 상관없다');
});

test('시뮬레이션: 플레이어는 살살 밀고, 무거운 소품은 덜 움직이며, 플레이어 값은 그대로다', { skip: needsCannon }, async () => {
  async function walk(prop, speed) {
    const env = makeProps({ playerPos: [-3, 0, 0] });
    await env.props.load(floorMap([prop]), WALLS);
    env.run(1.5);
    assert.equal(env.props.stats().active, 0, '걷기 전에 잠들어 있다');
    const m = env.crates().matrices;
    const start = m[0].p.slice();
    let prev = start, peak = 0, x = env.player.pos[0];
    for (let i = 0; i < 120; i++) {
      x += speed * STEP;
      env.player.pos[0] = x;
      env.props.update(STEP);
      peak = Math.max(peak, horizontal(m[0].p, prev) / STEP);
      prev = m[0].p.slice();
      assert.deepEqual(env.player.pos, [x, 0, 0], '소품은 플레이어를 움직이지 않는다');
    }
    env.run(1.5);
    return { peak, moved: m[0].p[0] - start[0] };
  }
  const normal = await walk(crate(0), PLAYER.WALK);
  assert.ok(normal.moved > 0.2, `걸어서 밀면 움직인다 (${normal.moved})`);
  assert.ok(normal.peak <= 3.1, `날아가지 않는다 (${normal.peak} m/s)`);
  const slow = await walk(crate(0), PLAYER.SLOW_WALK);
  assert.ok(slow.moved > 1.5, `천천히 밀면 계속 밀린다 (${slow.moved})`);
  const heavy = await walk(crate(0, 0, 0, { mass: 150 }), PLAYER.WALK);
  assert.ok(heavy.moved < normal.moved, '무거운 상자는 덜 움직인다');
});

test('시뮬레이션: 멀리 밀려 간 소품도 처음에 고르지 않은 벽을 통과하지 않는다', { skip: needsCannon }, async () => {
  const env = makeProps({ playerPos: [-2, 0, 0] });
  const wall = makeBox(25, 0, -6, 26, 3, 6);
  await env.props.load(floorMap([crate(0)]), [wall]);
  env.run(1);
  const before = env.props.stats().statics;
  assert.equal(before, 1, '처음에는 바닥 평면뿐이다');
  let x = -2;
  for (let i = 0; i < 60 * 14; i++) {
    x += PLAYER.SLOW_WALK * STEP;
    if (x < 24.5) env.player.pos[0] = x;
    env.props.update(STEP);
  }
  assert.equal(env.props.stats().statics, before + 1, '가까워지면 벽을 강체로 만든다');
  const m = env.crates().matrices[0].p;
  assert.ok(m[0] > 15, `상자가 밀려 간다 (${m[0]})`);
  assert.ok(m[0] < 25, `벽을 통과하지 않는다 (${m[0]})`);
});

test('시뮬레이션: 가벼운 소품도 폭발에 너무 멀리 날아가지 않는다', { skip: needsCannon }, async () => {
  const env = makeProps();
  await env.props.load(floorMap([crate(0.5, 0, 0, { size: 0.4 })]), WALLS);
  env.run(1);
  env.props.explode([0, 0.1, 0], 6, 500);
  env.run(4);
  const p = env.crates().matrices[0].p;
  assert.ok(Math.hypot(p[0], p[2]) < 14, `속력 상한 덕에 맵 끝까지 날아가지 않는다 (${p})`);
});

test('시뮬레이션: 플레이어가 없으면 잠든 소품을 깨우지 않는다', { skip: needsCannon }, async () => {
  const env = makeProps({ playerPos: null });
  await env.props.load(floorMap([crate(0)]), []);
  env.run(1.5);
  const steps = env.props.stats().steps;
  env.player.pos = [50, 0, 50];
  env.run(0.5);
  assert.equal(env.props.stats().steps, steps, '멀리 있는 플레이어는 세계를 돌리지 않는다');
  env.player.pos = [0.2, 0, 0];     // 바로 옆으로 부활해도 튀지 않는다
  env.run(1);
  assert.ok(horizontal(env.crates().matrices[0].p, [0, 0, 0]) < 0.5);
});

test('시뮬레이션: 구멍으로 떨어진 소품은 제자리로 돌아온다', { skip: needsCannon }, async () => {
  const env = makeProps();
  const slabs = [
    makeBox(-2, -2, -2, 2, 0, 2, 'asphalt', { tag: 'ground' }),
    makeBox(10, -2, -2, 12, 0, 2, 'asphalt', { tag: 'ground' })
  ];
  await env.props.load(floorMap([crate(1.2)]), slabs);
  env.run(1);
  const origin = env.crates().matrices[0].p.slice();
  env.props.explode([-0.5, 0.2, 0], 6, 240);
  let respawned = false;
  for (let i = 0; i < 60 * 6 && !respawned; i++) {
    env.props.update(STEP);
    respawned = env.props.stats().respawns > 0;
  }
  assert.ok(respawned, '슬래브 밖으로 날아가 떨어지면 돌아온다');
  env.run(2);
  const now = env.crates().matrices[0].p;
  assert.ok(horizontal(now, origin) < 0.05, '원래 자리');
  assert.ok(Math.abs(now[1] - origin[1]) < 0.05, '원래 높이');
});

test('시뮬레이션: 시작 자리가 구멍 위면 끝없이 떨어지지 않고 그 자리에서 멈춘다', { skip: needsCannon }, async () => {
  const env = makeProps();
  const slabs = [
    makeBox(-2, -2, -2, 2, 0, 2, 'asphalt', { tag: 'ground' }),
    makeBox(10, -2, -2, 12, 0, 2, 'asphalt', { tag: 'ground' })
  ];
  await env.props.load(floorMap([crate(6, 1)]), slabs);
  env.run(8);
  const s = env.props.stats();
  assert.equal(s.active, 0, '잠든다');
  assert.equal(s.respawns, 2, '한 번 더 떨어져 본 뒤 멈춘다');
  const p = env.crates().matrices[0].p;
  assert.ok(horizontal(p, [6, 0, 0]) < 0.001 && Math.abs(p[1] - (1 + propShape('crate').hy)) < 0.001, `시작 자리 (${p})`);
  env.run(1);
  assert.equal(env.props.stats().steps, s.steps, '더는 세계를 돌리지 않는다');
});

test('시뮬레이션: 벽 틈에 끼어 계속 떨리는 소품도 결국 잠든다', { skip: needsCannon }, async () => {
  const env = makeProps();
  const slab = makeBox(-20, -4, -20, 20, 0, 20, 'asphalt', { tag: 'ground' });
  const left = makeBox(-3, 0, -2.72, 3, 2.6, -0.28);
  const right = makeBox(-3, 0, 0.28, 3, 2.6, 2.72);
  await env.props.load(floorMap([crate(0, 0.3)]), [slab, left, right]);
  env.run(13);
  assert.equal(env.props.stats().active, 0);
  const steps = env.props.stats().steps;
  env.run(1);
  assert.equal(env.props.stats().steps, steps);
});

test('시뮬레이션: 물과 clip은 통과하고 원통·경사로에는 얹힌다', { skip: needsCannon }, async () => {
  const env = makeProps();
  const ramp = solidToCollider({ type: 'ramp', x: 0, y: 0, z: 0, w: 4, h: 1, d: 3, dir: '+x' });
  const pillar = solidToCollider({ type: 'cyl', x: 6, y: 0, z: 0, r: 0.8, h: 1.2 });
  const water = makeBox(9, -3, -2, 12, 0.5, 2, 'water');
  const clip = makeBox(14, 0, -2, 15, 3, 2, 'invisible', { tag: 'clip', noRay: true });
  await env.props.load(floorMap([crate(0, 2), crate(6, 2), crate(10.5, 1.5), crate(14.5, 2)]), [ramp, pillar, water, clip]);
  env.run(1.5);
  const m = env.crates().matrices;
  const half = propShape('crate').hy;
  assert.ok(m[1].p[1] > 1.2, `원통 위에 얹힌다 (${m[1].p[1]})`);
  assert.ok(Math.abs(m[2].p[1] - half) < 0.05, `물 상자는 통과해 바닥까지 간다 (${m[2].p[1]})`);
  assert.ok(Math.abs(m[3].p[1] - half) < 0.05, `clip도 통과한다 (${m[3].p[1]})`);
  assert.ok(m[0].p[1] > half + 0.1, `경사로 위에 머문다 (${m[0].p[1]})`);
});

test('시뮬레이션: low 품질은 폭발에도 활성 수를 제한한다', { skip: needsCannon }, async () => {
  const list = Array.from({ length: 30 }, (_, i) => crate((i % 6) * 1.2 - 3, 0, Math.floor(i / 6) * 1.2 - 3));
  const env = makeProps({ quality: 'low' });
  await env.props.load(floorMap(list), WALLS);
  env.run(4);
  assert.equal(env.props.stats().active, 0);
  assert.equal(env.props.stats().iterations, qualityProfile('low').iterations);
  env.props.explode([0, 0.2, 0], 8, 200);
  const cap = qualityProfile('low').maxActive;
  assert.equal(env.props.stats().active, cap, '가까운 소품만 깨운다');
  let peak = 0;
  for (let i = 0; i < 120; i++) {
    env.props.update(STEP);
    peak = Math.max(peak, env.props.stats().active);
  }
  assert.ok(peak <= cap, `연쇄로 부딪혀도 제한을 넘지 않는다 (${peak})`);
  env.props.setQuality('high');
  assert.equal(env.props.stats().maxActive, LIMITS.PROPS);
});

test('시뮬레이션: 세계 안에서 오류가 나면 던지지 않고 고정 소품으로 멈춘다', { skip: needsCannon }, async () => {
  class BrokenWorld extends CANNON.World { step() { throw new Error('solver'); } }
  const env = makeProps({ loadCannon: async () => ({ ...CANNON, World: BrokenWorld }) });
  await env.props.load(floorMap([crate(0, 2)]), []);
  const warnings = await captureWarnings(() => {
    env.props.update(STEP * 2);
    env.props.update(STEP * 2);
    env.props.explode([0, 0, 0]);
  });
  assert.equal(warnings.length, 1);
  assert.equal(env.props.stats().mode, 'static');
  assert.equal(env.props.stats().total, 1);
});
