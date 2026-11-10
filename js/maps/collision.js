/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 맵 데이터 → 물리 월드(three.js 없음). 브라우저 빌더와 node 도구가 똑같은 충돌체를 쓰도록
 *          충돌체 구성(움직이는 지형 포함), 테마 정규화, 스폰 배치, 맵 데이터 검사를 이 파일에 모았다.
 */
import { createWorld, solidToCollider, makeBox, rectSubtract, getGroundY, findFloor } from '../engine/physics.js';
import { buildTriggers, padVelocity, vec3 } from '../engine/triggers.js';
import { createMovers, normalizeMover, moverPeakSpeed, moverSweep, MOVER_AXES, MOVER_MAX_SPEED, MOVER_MIN_TRAVEL } from '../engine/movers.js';
import { toRad, LIMITS, TEAM_IDS, MATS, MOVE } from '../core/consts.js';

/** 맵이 rulesets를 안 적었을 때 쓰는 값(DESIGN 5절) */
export const DEFAULT_RULESETS = Object.freeze(['classic', 'sniper']);
/** game/modes.js의 RULESET_IDS와 같다. 맵 쪽이 무기 정의까지 끌어오지 않게 이름만 둔다 */
export const RULESET_NAMES = Object.freeze(['classic', 'knife', 'sniper']);
export const DECOR_TYPES = Object.freeze([
  'pipe', 'sign', 'light', 'loadingArm', 'flare', 'buoy',
  'tree', 'bamboo', 'lantern', 'banner', 'rope', 'vent', 'crateStack'
]);
export const PROP_TYPES = Object.freeze(['crate', 'barrel']);

/** 보이지 않는 막이. 충돌만 있고 총알·시야는 통과한다 */
const CLIP_MAT = 'clip';
const RAMP_DIRS = ['+x', '-x', '+z', '-z'];
const MAX_PORTALS = LIMITS.PADS;
const PAD_SPEED_LIMIT = MOVE.MAX_SPEED * 2;

const DEFAULT_THEME = Object.freeze({
  sky: '#a9cde8', skyTop: '#3f78b5', fog: [60, 240], sunDir: [-0.45, 0.8, -0.35],
  sunColor: '#fff1d8', ambient: 0.5, water: null
});

const isNum = (v) => v !== null && v !== '' && v !== undefined && typeof v !== 'boolean' && Number.isFinite(+v);
const isPos = (v) => isNum(v) && +v > 0;
const isHex = (v) => typeof v === 'string' && /^#?[0-9a-f]{3,8}$/i.test(v.trim());

function hexOr(v, d) {
  return isHex(v) ? v.trim() : d;
}

/** theme 정규화 (빠진 값은 기본값) */
export function normalizeTheme(t) {
  t = t && typeof t === 'object' ? t : {};
  const fog = Array.isArray(t.fog) ? t.fog : DEFAULT_THEME.fog;
  let near = Number(fog[0]), far = Number(fog[1]);
  if (!Number.isFinite(near)) near = DEFAULT_THEME.fog[0];
  if (!Number.isFinite(far) || far <= near) far = Math.max(near + 40, DEFAULT_THEME.fog[1]);
  const sd = Array.isArray(t.sunDir) && t.sunDir.length === 3 && t.sunDir.every(Number.isFinite) ? t.sunDir : DEFAULT_THEME.sunDir;
  const sl = Math.hypot(sd[0], sd[1], sd[2]) || 1;
  const ground = t.ground ?? t.floor;
  return {
    sky: hexOr(t.sky, DEFAULT_THEME.sky),
    skyTop: hexOr(t.skyTop, DEFAULT_THEME.skyTop),
    fog: [near, far],
    sunDir: [sd[0] / sl, sd[1] / sl, sd[2] / sl],
    sunColor: hexOr(t.sunColor, DEFAULT_THEME.sunColor),
    sunIntensity: Number.isFinite(+t.sunIntensity) && t.sunIntensity !== null ? +t.sunIntensity : 1,
    ambient: Number.isFinite(+t.ambient) ? Math.max(0, Math.min(2, +t.ambient)) : DEFAULT_THEME.ambient,
    water: t.water ? hexOr(t.water, null) : null,
    waterLevel: Number.isFinite(+t.waterLevel) && t.waterLevel !== null ? +t.waterLevel : null,
    ground: ground === 'none' ? 'none' : MATS.includes(ground) ? ground : 'asphalt'
  };
}

/* ---------------- 검사 ---------------- */

const round = (v, n = 2) => Math.round(v * 10 ** n) / 10 ** n;

function outOfBounds(size, x, z) {
  return !!size && (Math.abs(+x) > size.x / 2 || Math.abs(+z) > size.z / 2);
}

function checkCount(name, value, limit, errors) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) { errors.push(`${name} must be an array`); return []; }
  if (value.length > limit) errors.push(`${name} ${value.length} > limit ${limit}`);
  return value;
}

function checkSolids(solids, warnings) {
  solids.forEach((s, i) => {
    const tag = `solids[${i}]`;
    if (Array.isArray(s)) { warnings.push(`${tag} is a nested array; flatten the list (kit helpers like stairs return arrays)`); return; }
    if (!solidToCollider(s, i)) { warnings.push(`${tag} invalid (${s && s.type}): needs type box|ramp|cyl and sizes > 0`); return; }
    if (s.type === 'ramp' && !RAMP_DIRS.includes(s.dir)) warnings.push(`${tag} ramp dir "${s.dir}" → +x`);
    const mat = typeof s.mat === 'string' ? s.mat : 'concrete';
    if (mat !== CLIP_MAT && !MATS.includes(mat)) warnings.push(`${tag} unknown mat "${mat}" → concrete`);
  });
}

function checkDecor(decor, warnings) {
  decor.forEach((d, i) => {
    const tag = `decor[${i}]`;
    if (Array.isArray(d)) { warnings.push(`${tag} is a nested array; flatten the list`); return; }
    if (!d || typeof d !== 'object') { warnings.push(`${tag} is not an object`); return; }
    if (!DECOR_TYPES.includes(d.type)) { warnings.push(`${tag} unknown decor type "${d.type}"`); return; }
    if (d.type === 'pipe' || d.type === 'rope') {
      if (!vec3(d.from) || !vec3(d.to)) warnings.push(`${tag} ${d.type} needs from and to [x,y,z]`);
    } else if (!isNum(d.x) || !isNum(d.z)) warnings.push(`${tag} ${d.type} needs x and z`);
    if (d.type === 'banner' && !d.text && !d.emblem) warnings.push(`${tag} banner needs text or emblem`);
    if (d.mat !== undefined && !MATS.includes(d.mat)) warnings.push(`${tag} unknown mat "${d.mat}" → concrete`);
  });
}

function checkPads(pads, size, warnings) {
  pads.forEach((p, i) => {
    const tag = `pads[${i}]`;
    if (!p || typeof p !== 'object') { warnings.push(`${tag} is not an object`); return; }
    for (const k of ['x', 'y', 'z']) if (!isNum(p[k])) warnings.push(`${tag} ${k} must be a number`);
    for (const k of ['w', 'd']) if (!isPos(p[k])) warnings.push(`${tag} ${k} must be > 0`);
    const target = vec3(p.target), vel = vec3(p.vel);
    if (!target && !vel) warnings.push(`${tag} needs target [x,y,z] or vel [vx,vy,vz]; ignored without one`);
    if (target && vel) warnings.push(`${tag} has both target and vel; target wins`);
    if (outOfBounds(size, p.x, p.z)) warnings.push(`${tag} is outside size`);
    if (target && outOfBounds(size, target[0], target[2])) warnings.push(`${tag} target is outside size`);
    if (p.apex !== undefined && !isPos(p.apex)) warnings.push(`${tag} apex must be > 0`);
    if (p.color !== undefined && !isHex(p.color)) warnings.push(`${tag} color "${p.color}" is not #rrggbb`);
    if (isNum(p.x) && isNum(p.y) && isNum(p.z) && (target || vel)) {
      // 이동 코드가 발판 속도를 깎지는 않지만, 이보다 빠르면 날아가는 모습이 어색하다
      const v = target ? padVelocity([+p.x, +p.y, +p.z], target, p.apex) : vel;
      const hs = Math.hypot(v[0], v[2]);
      if (hs > PAD_SPEED_LIMIT) warnings.push(`${tag} horizontal speed ${round(hs)} m/s > ${PAD_SPEED_LIMIT}; raise apex so the flight lasts longer`);
    }
  });
}

function checkPortals(portals, size, warnings) {
  portals.forEach((p, i) => {
    const tag = `portals[${i}]`;
    if (!p || typeof p !== 'object') { warnings.push(`${tag} is not an object`); return; }
    for (const k of ['x', 'y', 'z']) if (!isNum(p[k])) warnings.push(`${tag} ${k} must be a number`);
    for (const k of ['w', 'h', 'd']) if (!isPos(p[k])) warnings.push(`${tag} ${k} must be > 0`);
    const to = vec3(p.to);
    if (!to) warnings.push(`${tag} needs to {x,y,z,rotY}; ignored without it`);
    else if (outOfBounds(size, to[0], to[2])) warnings.push(`${tag} destination is outside size`);
    if (outOfBounds(size, p.x, p.z)) warnings.push(`${tag} is outside size`);
    if (p.color !== undefined && !isHex(p.color)) warnings.push(`${tag} color "${p.color}" is not #rrggbb`);
  });
}

function checkSecrets(secrets, size, warnings) {
  const seen = new Set();
  secrets.forEach((s, i) => {
    const tag = `secrets[${i}]`;
    if (!s || typeof s !== 'object') { warnings.push(`${tag} is not an object`); return; }
    if (!s.id) warnings.push(`${tag} needs id (account rewards are keyed by it)`);
    else if (seen.has(String(s.id))) warnings.push(`${tag} duplicate id "${s.id}"`);
    else seen.add(String(s.id));
    if (!s.name) warnings.push(`${tag} needs name (shown in the banner)`);
    for (const k of ['x', 'y', 'z']) if (!isNum(s[k])) warnings.push(`${tag} ${k} must be a number`);
    for (const k of ['w', 'h', 'd']) if (!isPos(s[k])) warnings.push(`${tag} ${k} must be > 0`);
    if (s.points !== undefined && !(isNum(s.points) && +s.points >= 0)) warnings.push(`${tag} points must be >= 0`);
    if (s.reach !== undefined && s.reach !== 'jump') warnings.push(`${tag} reach "${s.reach}" unknown (only 'jump')`);
    if (outOfBounds(size, s.x, s.z)) warnings.push(`${tag} is outside size`);
  });
}

function checkProps(props, size, warnings) {
  props.forEach((p, i) => {
    const tag = `props[${i}]`;
    if (!p || typeof p !== 'object') { warnings.push(`${tag} is not an object`); return; }
    if (!PROP_TYPES.includes(p.type)) warnings.push(`${tag} type "${p.type}" must be crate or barrel`);
    for (const k of ['x', 'y', 'z']) if (!isNum(p[k])) warnings.push(`${tag} ${k} must be a number`);
    for (const k of ['size', 'mass']) if (p[k] !== undefined && !isPos(p[k])) warnings.push(`${tag} ${k} must be > 0`);
    if (outOfBounds(size, p.x, p.z)) warnings.push(`${tag} is outside size`);
  });
}

function checkMovers(movers, size, warnings) {
  const seen = new Set();
  movers.forEach((m, i) => {
    const tag = `movers[${i}]`;
    if (!m || typeof m !== 'object') { warnings.push(`${tag} is not an object`); return; }
    for (const k of ['x', 'y', 'z']) if (!isNum(m[k])) warnings.push(`${tag} ${k} must be a number`);
    for (const k of ['w', 'h', 'd']) if (!isPos(m[k])) warnings.push(`${tag} ${k} must be > 0`);
    if (!MOVER_AXES.includes(m.axis)) warnings.push(`${tag} axis "${m.axis}" must be x, y or z`);
    if (!isNum(m.dist) || +m.dist === 0) warnings.push(`${tag} dist must be a non-zero number`);
    if (!isPos(m.period)) warnings.push(`${tag} period must be > 0`);
    if (m.hold !== undefined && !(isNum(m.hold) && +m.hold >= 0)) warnings.push(`${tag} hold must be >= 0`);
    if (m.phase !== undefined && !isNum(m.phase)) warnings.push(`${tag} phase must be a number (0..1)`);
    if (m.mat !== undefined && !MATS.includes(m.mat)) warnings.push(`${tag} unknown mat "${m.mat}" → steel`);
    if (m.id !== undefined && m.id !== null) {
      if (seen.has(String(m.id))) warnings.push(`${tag} duplicate id "${m.id}"`);
      seen.add(String(m.id));
    }
    const spec = normalizeMover(m, i);
    if (!spec) { warnings.push(`${tag} is ignored: it needs x, z, w, h, d, axis, dist, period and period/2 > hold`); return; }
    if (spec.travel < MOVER_MIN_TRAVEL) warnings.push(`${tag} travels one way in ${round(spec.travel)} s (< ${MOVER_MIN_TRAVEL}); raise period or lower hold`);
    const speed = moverPeakSpeed(spec);
    if (speed > MOVER_MAX_SPEED) warnings.push(`${tag} peak speed ${round(speed)} m/s > ${MOVER_MAX_SPEED}; raise period or shorten dist`);
    const sweep = moverSweep(spec);
    if (size && (sweep.minX < -size.x / 2 || sweep.maxX > size.x / 2 || sweep.minZ < -size.z / 2 || sweep.maxZ > size.z / 2)) warnings.push(`${tag} leaves size while moving`);
  });
}

function checkSpawns(data, size, warnings) {
  for (const team of TEAM_IDS) {
    const sp = data.spawns && data.spawns[team];
    if (!Array.isArray(sp) || !sp.length) warnings.push(`spawns.${team} missing`);
    else if (sp.length < 4) warnings.push(`spawns.${team}: ${sp.length} < 4`);
  }
  for (const team of [...TEAM_IDS, 'ffa']) {
    const sp = data.spawns && data.spawns[team];
    if (sp === undefined) continue;
    if (!Array.isArray(sp)) { warnings.push(`spawns.${team} must be an array`); continue; }
    sp.forEach((p, i) => {
      const tag = `spawns.${team}[${i}]`;
      if (!p || !isNum(p.x) || !isNum(p.z)) warnings.push(`${tag} needs x and z`);
      else if (outOfBounds(size, p.x, p.z)) warnings.push(`${tag} is outside size (pulled back in)`);
    });
  }
}

/**
 * 맵 데이터 검사. 치명적이면 errors(한도 초과 포함), 고칠 수 있으면 warnings.
 * @returns {{ ok:boolean, errors:string[], warnings:string[] }}
 */
export function validateMap(data) {
  const errors = [], warnings = [];
  if (!data || typeof data !== 'object') return { ok: false, errors: ['map data is not an object'], warnings };
  if (!data.id) warnings.push('id missing');
  if (!Array.isArray(data.solids)) errors.push('solids must be an array');
  const hasSize = data.size && +data.size.x > 0 && +data.size.z > 0;
  if (!hasSize) warnings.push('size {x,z} missing → computed');
  const size = hasSize ? { x: +data.size.x, z: +data.size.z } : null;

  const solids = checkCount('solids', Array.isArray(data.solids) ? data.solids : undefined, LIMITS.SOLIDS, errors);
  const decor = checkCount('decor', data.decor, LIMITS.DECOR, errors);
  const pads = checkCount('pads', data.pads, LIMITS.PADS, errors);
  const portals = checkCount('portals', data.portals, MAX_PORTALS, errors);
  const secrets = checkCount('secrets', data.secrets, LIMITS.SECRETS, errors);
  const props = checkCount('props', data.props, LIMITS.PROPS, errors);
  const movers = checkCount('movers', data.movers, LIMITS.MOVERS, errors);

  checkSpawns(data, size, warnings);
  checkSolids(solids, warnings);
  checkDecor(decor, warnings);
  checkPads(pads, size, warnings);
  checkPortals(portals, size, warnings);
  checkSecrets(secrets, size, warnings);
  checkProps(props, size, warnings);
  checkMovers(movers, size, warnings);

  if (data.rulesets !== undefined) {
    if (!Array.isArray(data.rulesets) || !data.rulesets.length) warnings.push('rulesets must be a non-empty array');
    else for (const r of data.rulesets) if (!RULESET_NAMES.includes(r)) warnings.push(`rulesets: unknown "${r}"`);
  }
  if (data.tag !== undefined && typeof data.tag !== 'string') warnings.push('tag must be a string');
  const ground = data.theme && (data.theme.ground ?? data.theme.floor);
  if (ground !== undefined && ground !== null && ground !== 'none' && !MATS.includes(ground)) warnings.push(`theme.ground unknown "${ground}" → asphalt`);

  return { ok: errors.length === 0, errors, warnings };
}

/* ---------------- 충돌 ---------------- */

const pullIn = (v, a, b) => Math.min(b - 0.5, Math.max(a + 0.5, v));

/** 스폰 1곳 → 실제 위치. y를 적으면 그 높이 근처의 바닥을, 안 적으면 아래부터 첫 빈 바닥을 쓴다 */
function placeSpawn(world, bounds, p) {
  const x = pullIn(+p.x, bounds.minX, bounds.maxX), z = pullIn(+p.z, bounds.minZ, bounds.maxZ);
  const opt = isNum(p.y) ? { fromY: getGroundY(world, x, z, +p.y + 0.5, 0.3) } : undefined;
  return { x, y: findFloor(world, x, z, opt), z, rotY: toRad(p.rotY || 0) };
}

const validSpawns = (list) => (Array.isArray(list) ? list : []).filter((p) => p && Number.isFinite(+p.x) && Number.isFinite(+p.z));

function buildSpawns(data, world, bounds, sx) {
  if (!world) return null;
  const spawns = {};
  for (const team of TEAM_IDS) {
    let list = validSpawns(data.spawns && data.spawns[team]);
    if (!list.length) {
      const other = data.spawns && data.spawns[team === 'owner' ? 'charterer' : 'owner'];
      list = Array.isArray(other) && other.length
        ? other.map((p) => ({ x: -p.x, y: p.y, z: -p.z, rotY: (toRad(p.rotY || 0) + Math.PI) }))
        : [0, 1, 2, 3].map((i) => ({ x: (team === 'owner' ? -1 : 1) * (sx / 2 - 4), z: (i - 1.5) * 3, rotY: team === 'owner' ? -Math.PI / 2 : Math.PI / 2 }));
    }
    spawns[team] = list.map((p) => placeSpawn(world, bounds, p));
  }
  spawns.ffa = validSpawns(data.spawns && data.spawns.ffa).map((p) => placeSpawn(world, bounds, p));
  return spawns;
}

/**
 * 맵 데이터 → 물리 월드. buildMap과 도구가 함께 쓴다.
 * 잘못된 solids는 빼고 모르는 mat은 concrete로 친다(이유는 validateMap이 알려 준다).
 * @returns {{
 *   world:object, colliders:object[], solidColliders:object[], holes:object[], waterCols:object[],
 *   bounds:object, size:{x:number,z:number}, theme:object, seaLevel:number, groundDepth:number,
 *   groundRects:object[], spawns:object, triggers:object, movers:object
 * }} solidColliders = solids에서 온 충돌체(그릴 대상), groundRects = 바닥 슬래브 사각형, 그 외 colliders에는 바닥·외곽 벽도 들어 있다.
 *    movers = 움직이는 지형 상태(engine/movers.js). 그 충돌체는 쉬는 자리로 colliders에 들어 있고 world.movers로도 닿는다.
 *    스폰은 움직이는 지형이 없는 월드에서 놓는다(쉬는 자리에 놓인 상자 위로 스폰이 올라가지 않게). 길 찾기도 solidColliders만 본다
 */
export function buildCollision(data) {
  const theme = normalizeTheme(data && data.theme);
  const solids = data && Array.isArray(data.solids) ? data.solids : [];

  const solidColliders = [], holes = [], waterCols = [];
  const ext = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  solids.forEach((s, i) => {
    const c = solidToCollider(s, i);
    if (!c) return;
    if (c.mat === CLIP_MAT) {
      c.mat = 'invisible'; c.noRay = true; c.tag = CLIP_MAT;
      solidColliders.push(c);
      return;
    }
    if (!MATS.includes(c.mat)) c.mat = 'concrete';
    solidColliders.push(c);
    ext.minX = Math.min(ext.minX, c.minX); ext.maxX = Math.max(ext.maxX, c.maxX);
    ext.minZ = Math.min(ext.minZ, c.minZ); ext.maxZ = Math.max(ext.maxZ, c.maxZ);
    if (c.kind === 'box' && c.maxY <= 0.05 && c.minY < -0.001) holes.push(c);
    if (c.mat === 'water') waterCols.push(c);
  });

  const size = data && data.size;
  const sx = +(size && size.x) > 0 ? +size.x : (Number.isFinite(ext.minX) ? Math.max(Math.abs(ext.minX), Math.abs(ext.maxX)) * 2 + 4 : 60);
  const sz = +(size && size.z) > 0 ? +size.z : (Number.isFinite(ext.minZ) ? Math.max(Math.abs(ext.minZ), Math.abs(ext.maxZ)) * 2 + 4 : 60);
  const bounds = { minX: -sx / 2, maxX: sx / 2, minZ: -sz / 2, maxZ: sz / 2 };

  let seaLevel = theme.waterLevel;
  if (seaLevel == null) {
    const tops = waterCols.filter((c) => c.maxY <= 0.05).map((c) => c.maxY);
    seaLevel = tops.length ? Math.max(...tops) : -0.8;
  }

  const colliders = solidColliders.slice();

  // 바닥 슬래브: 플레이 영역 − 구멍
  const groundDepth = theme.water ? Math.max(1.2, -seaLevel + 0.8) : 2.5;
  let groundRects = [];
  if (theme.ground !== 'none') {
    groundRects = [{ minX: bounds.minX, minZ: bounds.minZ, maxX: bounds.maxX, maxZ: bounds.maxZ }];
    for (const h of holes) {
      const next = [];
      for (const r of groundRects) next.push(...rectSubtract(r, h));
      groundRects = next;
    }
    for (const r of groundRects) colliders.push(makeBox(r.minX, -groundDepth, r.minZ, r.maxX, 0, r.maxZ, theme.ground, { tag: 'ground' }));
  }

  // 보이지 않는 외곽 벽: 사람·수류탄은 막고 총알은 통과
  const T = 2, Y0 = -20, Y1 = 80;
  colliders.push(
    makeBox(bounds.minX - T, Y0, bounds.minZ - T, bounds.maxX + T, Y1, bounds.minZ, 'invisible', { noRay: true, tag: 'bounds' }),
    makeBox(bounds.minX - T, Y0, bounds.maxZ, bounds.maxX + T, Y1, bounds.maxZ + T, 'invisible', { noRay: true, tag: 'bounds' }),
    makeBox(bounds.minX - T, Y0, bounds.minZ, bounds.minX, Y1, bounds.maxZ, 'invisible', { noRay: true, tag: 'bounds' }),
    makeBox(bounds.maxX, Y0, bounds.minZ, bounds.maxX + T, Y1, bounds.maxZ, 'invisible', { noRay: true, tag: 'bounds' })
  );

  const worldOpts = { bounds, groundMat: theme.ground === 'none' ? 'concrete' : theme.ground, floorY: theme.ground === 'none' ? 0 : null };
  const movers = createMovers(data && data.movers);
  // 스폰 높이는 움직이는 지형을 뺀 월드에서 찾는다. createWorld가 충돌체에 id를 매기므로 스폰용 월드를 먼저 만들고 버린다
  const spawns = buildSpawns(data || {}, movers.empty ? null : createWorld(colliders.slice(), worldOpts), bounds, sx);
  for (const m of movers.list) colliders.push(m.collider);
  const world = createWorld(colliders, worldOpts);
  const triggers = buildTriggers(data);
  world.triggers = triggers;
  world.movers = movers;

  return {
    world,
    colliders: world.colliders,
    solidColliders,
    holes,
    waterCols,
    bounds,
    size: { x: sx, z: sz },
    theme,
    seaLevel,
    groundDepth,
    groundRects,
    spawns: movers.empty ? buildSpawns(data || {}, world, bounds, sx) : spawns,
    triggers,
    movers
  };
}
