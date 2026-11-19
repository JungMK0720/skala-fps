/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 맵 데이터 → three.js 메시. 충돌은 maps/collision.js에 맡기고 여기서는 그리기만 한다.
 *          solids를 재질별로 합치고 바닥·바깥 경치·장식·발판·포털·움직이는 지형을 만든다.
 */
/**
 * SKALA 작전 — 맵 빌더
 *
 *   const map = buildMap(data, scene);
 *   map.colliders / map.world (physics) / map.spawns / map.bounds / map.theme
 *   map.pads / map.portals / map.secrets / map.props (맵 데이터 그대로, 없으면 빈 배열) · map.world.triggers (판정 표)
 *   map.getGroundY(x, z[, fromY]) / map.raycastWorld(o, d, max) / map.traceShot(o, d, max, targets)
 *   map.update(dt, t, alpha)  // 장식·발판·포털 애니메이션, 움직이는 지형 메시 자리(alpha = 틱 사이 보간 비율)
 *   map.movers / map.tickMovers(dt) / map.setMoverClock(fn)  // 움직이는 지형(engine/movers.js). tickMovers는 틱마다 몸보다 먼저 부른다
 *   map.setMoverBodies(fn)    // 문이 볼 사람들(살아 있는 사람의 발 위치 목록을 돌려주는 함수). 문이 없는 맵에서는 부르지 않는다
 *   map.dispose()
 *
 * 렌더: solids는 재질별로 한 메시에 합친다(드로우콜 ≈ 재질 수). 바닥(y=0)은 플레이 영역을 덮는 슬래브로 만들고,
 *       윗면이 y≤0.05인 '바닥 높이/가라앉은' box(물 웅덩이·구덩이)는 그 자리를 바닥에서 도려낸다.
 * 충돌: solids + 바닥 슬래브 + 보이지 않는 외곽 벽(noRay — 총알은 통과, 사람·수류탄은 막음). maps/collision.js 참고.
 *
 * theme 확장(선택): ground: 바닥 mat 이름(기본 'asphalt', 'none'이면 바닥 없음) · waterLevel: 바다 높이(기본 -0.8)
 *                  sunIntensity: 태양 세기 배율
 */
import * as THREE from 'three';
import { getGroundY as physGroundY, findFloor, raycastWorld, traceShot, sphereSweep, lineOfSight } from '../engine/physics.js';
import { GeoBatch } from '../engine/geom.js';
import { getMaterial, getGroundMaterial, matScale, hasMat, setWaterColor, animateMaterials } from '../engine/materials.js';
import { buildDecor, buildTriggerVisuals } from '../engine/decor.js';
import { buildCollision, normalizeTheme, validateMap } from './collision.js';
import { stepMovers } from '../engine/movers.js';

export { normalizeTheme, validateMap };

const NO_SHADOW_MATS = new Set(['glass', 'water', 'neon_cyan', 'neon_pink']);
const listOf = (v) => (Array.isArray(v) ? v : []);
const BORDER_H = 14;     // 맵 끝 표시 벽 높이(m)
const BORDER_TILE = 2;   // 빗금 무늬 한 칸(m)

/** 맵 끝 표시 무늬: 투명 바탕에 대각선 빗금. 캔버스가 없는 곳(node 도구)에서는 null(단색 반투명) */
function borderTexture() {
  if (typeof document === 'undefined') return null;
  const n = 64, c = document.createElement('canvas');
  c.width = c.height = n;
  const g = c.getContext('2d');
  g.clearRect(0, 0, n, n);
  g.strokeStyle = 'rgba(255,255,255,0.9)';
  g.lineWidth = 9;
  // 칸 경계에서 이어지게 같은 기울기 선 셋(왼쪽 아래 → 오른쪽 위)
  for (const o of [-n, 0, n]) { g.beginPath(); g.moveTo(o, n); g.lineTo(o + n, 0); g.stroke(); }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

/**
 * @param {object} data 맵 데이터 (ARCHITECTURE 4절 + DESIGN 5절 형식)
 * @param {THREE.Scene|THREE.Object3D} scene 추가할 부모
 * @param {{ onWarn?: (msg:string)=>void }} [opts]
 */
export function buildMap(data, scene, opts = {}) {
  const check = validateMap(data);
  if (!check.ok) throw new Error('invalid map: ' + check.errors.join('; '));
  const warnings = check.warnings.slice();
  const warn = (m) => { warnings.push(m); if (opts.onWarn) opts.onWarn(m); };
  const id = String(data.id || 'map');
  const solids = data.solids || [];

  // --- 충돌 ---
  const col = buildCollision(data);
  const { world, theme, bounds, holes, waterCols, seaLevel, spawns } = col;

  // --- 렌더: 재질별 배치 ---
  const group = new THREE.Group();
  group.name = 'map:' + id;
  const batches = new Map();
  const batch = (mat) => {
    if (!hasMat(mat)) mat = 'concrete';
    let b = batches.get(mat);
    if (!b) { b = new GeoBatch(); b.scale = matScale(mat); batches.set(mat, b); }
    return b;
  };
  for (const c of col.solidColliders) {
    if (c.mat === 'invisible') continue;   // clip 막이는 그리지 않는다
    const b = batch(c.mat);
    const skipBottom = c.minY <= 0.001;
    if (c.kind === 'box') b.addBox(c.minX, c.minY, c.minZ, c.maxX, c.maxY, c.maxZ, b.scale, { skipBottom });
    else if (c.kind === 'ramp') b.addRamp(c.minX, c.minY, c.minZ, c.maxX, c.maxY, c.maxZ, c.dir, b.scale, { skipBottom });
    else b.addCylinder(c.x, c.minY, c.z, c.r, c.maxY - c.minY, b.scale, { skipBottom });
  }

  // --- 바닥 슬래브 (플레이 영역 − 구멍) ---
  const disposables = [];
  if (theme.ground !== 'none') {
    const gb = new GeoBatch();
    const gs = matScale(theme.ground);
    for (const r of col.groundRects) gb.addBox(r.minX, -col.groundDepth, r.minZ, r.maxX, 0, r.maxZ, gs, { skipBottom: true });
    if (!gb.empty) {
      const geo = gb.build();
      const mesh = new THREE.Mesh(geo, getGroundMaterial(theme.ground));
      mesh.receiveShadow = true;
      mesh.name = 'ground';
      group.add(mesh);
      disposables.push(geo);
    }
  }

  // --- 바깥 경치: 바다 또는 연장 지면 (충돌 없음) ---
  {
    const FAR = 1200;
    if (theme.water) {
      setWaterColor(theme.water);
      const geo = new THREE.PlaneGeometry(FAR * 2, FAR * 2);
      geo.rotateX(-Math.PI / 2);
      const uv = geo.attributes.uv;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (FAR * 2) / matScale('water'), uv.getY(i) * (FAR * 2) / matScale('water'));
      const sea = new THREE.Mesh(geo, getMaterial('water'));
      sea.position.y = seaLevel;
      sea.receiveShadow = true;
      sea.name = 'sea';
      group.add(sea);
      disposables.push(geo);
    } else if (theme.ground !== 'none') {
      // 플레이 영역 둘레 4장(구멍 아래가 비치지 않게 가운데는 비움)
      const ob = new GeoBatch();
      const s = matScale(theme.ground), y = -0.04;
      const q = (x0, z0, x1, z1) => ob.quad([x0, y, z1, x0, -z1], [x1, y, z1, x1, -z1], [x1, y, z0, x1, -z0], [x0, y, z0, x0, -z0], [0, 1, 0], s);
      q(-FAR, -FAR, FAR, bounds.minZ); q(-FAR, bounds.maxZ, FAR, FAR);
      q(-FAR, bounds.minZ, bounds.minX, bounds.maxZ); q(bounds.maxX, bounds.minZ, FAR, bounds.maxZ);
      const geo = ob.build();
      const mesh = new THREE.Mesh(geo, getGroundMaterial(theme.ground));
      mesh.receiveShadow = true;
      mesh.name = 'outskirts';
      group.add(mesh);
      disposables.push(geo);
    }
  }

  // --- 맵 끝 표시: 플레이 영역 둘레에 대각선 빗금이 그려진 반투명 벽(충돌은 collision.js의 보이지 않는 외곽 벽) ---
  {
    const H = BORDER_H, s = BORDER_TILE;
    const bb = new GeoBatch();
    const { minX: x0, maxX: x1, minZ: z0, maxZ: z1 } = bounds;
    // 벽마다 u = 벽을 따라간 거리(m), v = 높이(m). 빗금이 벽 사이에서 끊기지 않게 둘레 길이를 이어 붙인다
    const wx = x1 - x0, wz = z1 - z0;
    bb.quad([x0, 0, z0, 0, 0], [x1, 0, z0, wx, 0], [x1, H, z0, wx, H], [x0, H, z0, 0, H], [0, 0, 1], s);
    bb.quad([x1, 0, z0, wx, 0], [x1, 0, z1, wx + wz, 0], [x1, H, z1, wx + wz, H], [x1, H, z0, wx, H], [-1, 0, 0], s);
    bb.quad([x1, 0, z1, wx + wz, 0], [x0, 0, z1, 2 * wx + wz, 0], [x0, H, z1, 2 * wx + wz, H], [x1, H, z1, wx + wz, H], [0, 0, -1], s);
    bb.quad([x0, 0, z1, 2 * wx + wz, 0], [x0, 0, z0, 2 * (wx + wz), 0], [x0, H, z0, 2 * (wx + wz), H], [x0, H, z1, 2 * wx + wz, H], [1, 0, 0], s);
    const geo = bb.build();
    const tex = borderTexture();
    const mat = new THREE.MeshBasicMaterial({
      color: 0x8fe6ff, map: tex, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'map-border';
    mesh.renderOrder = 5;
    group.add(mesh);
    disposables.push(geo, mat);
    if (tex) disposables.push(tex);
  }

  // --- 장식 ---
  const inRect = (c, x, z) => x >= c.minX && x <= c.maxX && z >= c.minZ && z <= c.maxZ;
  const waterY = (x, z) => {
    let best = -Infinity;
    for (const c of waterCols) if (inRect(c, x, z)) best = Math.max(best, c.maxY);
    if (best > -Infinity) return best;
    const outside = x < bounds.minX || x > bounds.maxX || z < bounds.minZ || z > bounds.maxZ;
    if (theme.water && (outside || holes.some((h) => inRect(h, x, z)))) return seaLevel;
    return physGroundY(world, x, z);
  };
  const decor = buildDecor(data.decor || [], { batch, material: getMaterial, group, waterY, warn });

  // --- 발판·포털 (실제 조명 없음) ---
  const triggerFx = buildTriggerVisuals(col.triggers, { group });

  // --- 배치 → 메시 ---
  let triangles = 0, drawCalls = 0;
  for (const [mat, b] of batches) {
    if (b.empty) continue;
    const geo = b.build();
    const mesh = new THREE.Mesh(geo, getMaterial(mat));
    mesh.name = 'solids:' + mat;
    mesh.castShadow = !NO_SHADOW_MATS.has(mat);
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    if (mat === 'glass') mesh.renderOrder = 2;
    group.add(mesh);
    disposables.push(geo);
    triangles += geo.index.count / 3;
    drawCalls++;
  }

  // --- 움직이는 지형(문 포함): 하나마다 메시 하나(원점 기준 상자). 움직이는 것임을 알아보게 위아래에 띠를 두른다 ---
  const moverMeshes = [];
  for (const m of world.movers.list) {
    const s = m.spec;
    const gb = new GeoBatch();
    gb.addBox(-s.w / 2, 0, -s.d / 2, s.w / 2, s.h, s.d / 2, matScale(s.mat));
    const geo = gb.build();
    const mesh = new THREE.Mesh(geo, getMaterial(s.mat));
    mesh.name = 'mover:' + s.id;
    mesh.castShadow = !NO_SHADOW_MATS.has(s.mat);
    mesh.receiveShadow = true;
    mesh.position.set(s.x, s.y, s.z);
    // 오가는 지형은 노란 띠로 조심하라고 알리고, 문은 위아래에 문틀 같은 어두운 띠를 두른다
    const trimMat = s.door ? (s.mat === 'wood_dark' ? 'metal_dark' : 'wood_dark') : (s.mat === 'yellow' ? 'metal_dark' : 'yellow');
    const tb = new GeoBatch();
    const edge = 0.02, ts = matScale(trimMat);
    const band = (y0, y1) => tb.addBox(-s.w / 2 - edge, y0, -s.d / 2 - edge, s.w / 2 + edge, y1, s.d / 2 + edge, ts, { skipTop: true, skipBottom: true });
    band(Math.max(0, s.h - 0.24), s.h - 0.1);
    if (s.h >= 0.9) band(0.1, 0.24);
    const trimGeo = tb.build();
    const trim = new THREE.Mesh(trimGeo, getMaterial(trimMat));
    trim.receiveShadow = true;
    mesh.add(trim);
    group.add(mesh);
    disposables.push(geo, trimGeo);
    moverMeshes.push({ m, mesh });
    triangles += (geo.index.count + trimGeo.index.count) / 3;
    drawCalls += 2;
  }
  /** 메시를 직전 틱과 이번 틱 자리 사이에 놓는다(플레이어 보간과 같은 비율이라 위에 탄 몸과 어긋나지 않는다) */
  function placeMovers(alpha) {
    for (const { m, mesh } of moverMeshes) {
      const s = m.spec, off = m.prevOff + (m.off - m.prevOff) * alpha;
      mesh.position.set(s.x + (s.axis === 'x' ? off : 0), s.y + (s.axis === 'y' ? off : 0), s.z + (s.axis === 'z' ? off : 0));
    }
  }
  let moverClock = null, moverTime = 0, moverBodies = null;

  if (scene) scene.add(group);

  let disposed = false;
  return {
    id,
    data,
    name: data.name || id,
    theme,
    group,
    world,
    colliders: world.colliders,
    spawns,
    bounds,
    seaLevel,
    warnings,
    pads: listOf(data.pads),
    portals: listOf(data.portals),
    secrets: listOf(data.secrets),
    props: listOf(data.props),
    movers: world.movers,
    stats: { solids: solids.length, colliders: world.colliders.length, drawCalls: drawCalls + decor.lightCount + triggerFx.drawCalls, triangles: Math.round(triangles), decor: decor.counts, lights: decor.lightCount, movers: moverMeshes.length },
    getGroundY: (x, z, fromY) => physGroundY(world, x, z, fromY),
    findFloor: (x, z, o) => findFloor(world, x, z, o),
    raycastWorld: (o, d, max, op) => raycastWorld(world, o, d, max, op),
    traceShot: (o, d, max, targets, op) => traceShot(world, o, d, max, targets, op),
    sphereSweep: (body, dt, op) => sphereSweep(world, body, dt, op),
    lineOfSight: (a, b) => lineOfSight(world, a, b),
    /** 움직이는 지형의 시계: 초를 돌려주는 함수(멀티는 방장 시계). null이거나 숫자가 아니면 맵을 불러온 뒤 흐른 틱 시간을 쓴다 */
    setMoverClock(fn) { moverClock = typeof fn === 'function' ? fn : null; },
    /** 문(가까이 오면 열리는 움직이는 지형)이 볼 사람들: 살아 있는 사람의 발 위치 목록([x, y, z] 또는 { x, y, z })을 돌려주는 함수. null이면 문은 닫힌 채다 */
    setMoverBodies(fn) { moverBodies = typeof fn === 'function' ? fn : null; },
    /** 틱마다 한 번, 몸을 움직이기 전에 부른다. 충돌체를 이번 틱의 자리로 옮긴다 */
    tickMovers(dt) {
      if (world.movers.empty) return;
      moverTime += dt;
      const t = moverClock ? moverClock() : NaN;
      stepMovers(world, Number.isFinite(t) ? t : moverTime, world.movers.doors && moverBodies ? moverBodies() : null);
    },
    update(dt, t, alpha = 1) {
      animateMaterials(dt);
      if (decor.animated) decor.update(dt, t);
      triggerFx.update(dt, t);
      if (moverMeshes.length) placeMovers(alpha);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (group.parent) group.parent.remove(group);
      for (const d of disposables) d.dispose();
      decor.dispose();
      triggerFx.dispose();
    }
  };
}
