/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 맵 데이터 → three.js 메시. 충돌은 maps/collision.js에 맡기고 여기서는 그리기만 한다.
 *          solids를 재질별로 합치고 바닥·바깥 경치·장식·발판·포털을 만든다.
 */
/**
 * SKALA 작전 — 맵 빌더
 *
 *   const map = buildMap(data, scene);
 *   map.colliders / map.world (physics) / map.spawns / map.bounds / map.theme
 *   map.pads / map.portals / map.secrets / map.props (맵 데이터 그대로, 없으면 빈 배열) · map.world.triggers (판정 표)
 *   map.getGroundY(x, z[, fromY]) / map.raycastWorld(o, d, max) / map.traceShot(o, d, max, targets)
 *   map.update(dt, t)  // 장식·발판·포털 애니메이션
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

export { normalizeTheme, validateMap };

const NO_SHADOW_MATS = new Set(['glass', 'water', 'neon_cyan', 'neon_pink']);
const listOf = (v) => (Array.isArray(v) ? v : []);

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
    stats: { solids: solids.length, colliders: world.colliders.length, drawCalls: drawCalls + decor.lightCount + triggerFx.drawCalls, triangles: Math.round(triangles), decor: decor.counts, lights: decor.lightCount },
    getGroundY: (x, z, fromY) => physGroundY(world, x, z, fromY),
    findFloor: (x, z, o) => findFloor(world, x, z, o),
    raycastWorld: (o, d, max, op) => raycastWorld(world, o, d, max, op),
    traceShot: (o, d, max, targets, op) => traceShot(world, o, d, max, targets, op),
    sphereSweep: (body, dt, op) => sphereSweep(world, body, dt, op),
    lineOfSight: (a, b) => lineOfSight(world, a, b),
    update(dt, t) {
      animateMaterials(dt);
      if (decor.animated) decor.update(dt, t);
      triggerFx.update(dt, t);
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
