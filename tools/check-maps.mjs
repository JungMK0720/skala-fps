/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 맵 데이터 검사기(npm run check:maps). 게임과 같은 물리 코드로 스폰, 발판 궤적, 포털, 비밀 스팟, 길 찾기를 시뮬레이션해
 *          맵 제작 실수를 찾는다. 오류가 있으면 종료 코드 1. 사용법: node tools/check-maps.mjs [맵 id] [--json] [--file 경로]
 */
import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PLAYER, TEAM_IDS, TICK_DT } from '../js/core/consts.js';
import { getGroundY, moveCharacter, overlapsCapsule, raycastWorld } from '../js/engine/physics.js';
import { PAD_HEIGHT_TOL, stepTriggers } from '../js/engine/triggers.js';
import { NAV_EDGE, buildNavGrid } from '../js/game/navgrid.js';
import { buildCollision, validateMap } from '../js/maps/collision.js';

/** 새 맵 전용 요구 사항(팀 스폰 수, 개인전 스폰 수, 경고를 오류로 취급)을 적용할 id. rulesets가 있는 맵도 같다(테스트 맵 제외) */
const NEW_MAPS = new Set(['alley', 'dojo', 'longshot', 'nexus']);
const EXEMPT_MAPS = new Set(['testyard']);
const MIN_TEAM_SPAWNS = 4;
const MIN_FFA_SPAWNS = 6;

const PAD_XZ_TOLERANCE = 2;      // 착지와 target의 수평 거리(m)
const PAD_Y_TOLERANCE = 0.6;     // 착지 바닥과 target의 높이 차(m)
const SECRET_NEAR = 2;           // 착지·도착이 비밀 상자에서 이 안이면 닿은 것으로 친다(m)
const MAX_FLIGHT_TICKS = 8 / TICK_DT;
const SLIDE_TICKS = 90;          // 착지 후 미끄러짐을 지켜보는 틱
const SPAWN_MIN_GAP = 1;         // 같은 팀 스폰끼리 이보다 가까우면 경고(m)
const PERCH_PROBE = 0.7;         // 스폰 둘레 바닥을 살피는 거리(m)
const FINE_CELL = 0.5;           // 비밀 스팟·발판 도달 분석용 내비 칸(m)
const PORTAL_MAX_DROP = 1;       // 포털 도착 높이가 바닥보다 이만큼까지 위여도 된다(m)

const JUMP_SIMS = 20000;         // 점프 탐색 한도(시뮬레이션 횟수). 한 번에 수십 µs라 몇 초를 넘지 않는다
const JUMP_DIRS = 16;
const JUMP_TICKS = 150;
const JUMP_RADIUS = 28;          // 비밀 상자에서 이만큼 떨어진 곳까지만 탐색(m)
const JUMP_STARTS = 48;

const H = PLAYER.HEIGHT, R = PLAYER.RADIUS, STEP = PLAYER.STEP, EYE = PLAYER.EYE;
const NO_WISH = Object.freeze({ x: 0, z: 0 });

// 플레이어 실제 이동 코드. 착지 후 미끄러짐을 볼 때만 쓰고, 없으면 moveCharacter로 대신한다
const moveQuake = await import('../js/engine/movement.js').then((m) => m.moveQuake).catch(() => null);

const r2 = (v) => Math.round(v * 100) / 100;
const fmt = (x, y, z) => `(${r2(x)}, ${r2(y)}, ${r2(z)})`;
const insideBody = (b, x, feet, z, height = H) =>
  x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ && feet < b.maxY && feet + height > b.minY;
const distToRect = (b, x, z) => Math.hypot(Math.max(b.minX - x, 0, x - b.maxX), Math.max(b.minZ - z, 0, z - b.maxZ));

/** 바닥에 설 때까지 떨어뜨려 본다 */
function settle(world, x, y, z) {
  const body = { pos: [x, y, z], vel: [0, 0, 0], onGround: false };
  for (let i = 0; i < 48 && !(body.onGround && i > 1); i++) moveCharacter(world, body, NO_WISH, TICK_DT);
  return { x: body.pos[0], y: body.pos[1], z: body.pos[2], onGround: body.onGround, drop: y - body.pos[1], shift: Math.hypot(body.pos[0] - x, body.pos[2] - z) };
}

/** (x,y,z)에 사람이 설 수 있는지 검사하고 실제로 멈춘 곳을 돌려준다 */
function checkStanding(world, label, x, y, z, out, maxDrop = 0.1) {
  const at = `${label} ${fmt(x, y, z)}`;
  if (overlapsCapsule(world, x, y + STEP, z, R - 0.02, H - STEP)) out.errors.push(`${at}: body is inside a wall or under a low ceiling`);
  else if (overlapsCapsule(world, x, y, z, R - 0.02, H)) out.warnings.push(`${at}: body overlaps a low ledge and gets lifted onto it`);
  const rest = settle(world, x, y, z);
  if (!rest.onGround || rest.drop > maxDrop) {
    out.errors.push(`${at}: no floor under the feet (fell ${r2(rest.drop)} m)`);
    return rest;
  }
  if (rest.shift > 0.1) out.warnings.push(`${at}: pushed ${r2(rest.shift)} m by a wall`);
  const hit = raycastWorld(world, [rest.x, rest.y + 0.3, rest.z], [0, -1, 0], 0.8);
  if (hit && hit.mat === 'water') out.errors.push(`${at}: stands on water`);
  return rest;
}

/* ---------------- 발판 ---------------- */

/** 발판 발동부터 착지까지(입력 없음). 착지 뒤에는 플레이어 이동 코드로 얼마나 미끄러지는지도 본다 */
function simulatePad(world, pad, x, y, z, secrets) {
  const body = { pos: [x, y, z], vel: [0, 0, 0], onGround: true };
  const fired = stepTriggers(world, body, H, {});
  if (fired.pad !== pad) return { fired: false, by: fired.pad };
  const speed = Math.hypot(body.vel[0], body.vel[2]), vy = body.vel[1];
  const passes = new Set();
  let ticks = 0, top = y, ceiling = false, walls = 0;
  while (ticks < MAX_FLIGHT_TICKS && !body.onGround) {
    const ev = moveCharacter(world, body, NO_WISH, TICK_DT);
    ticks++;
    if (ev.ceiling) ceiling = true;
    walls += ev.walls;
    if (body.pos[1] > top) top = body.pos[1];
    for (const s of secrets) if (insideBody(s, body.pos[0], body.pos[1], body.pos[2])) passes.add(s.id);
  }
  const landing = body.pos.slice();
  const landed = body.onGround;
  let mat = null;
  if (landed) {
    const hit = raycastWorld(world, [landing[0], landing[1] + 0.3, landing[2]], [0, -1, 0], 0.8);
    mat = hit ? hit.mat : null;
    for (let i = 0; i < SLIDE_TICKS; i++) {
      if (moveQuake) moveQuake(world, body, null, TICK_DT);
      else moveCharacter(world, body, NO_WISH, TICK_DT);
    }
  }
  return { fired: true, landed, landing, rest: body.pos.slice(), time: ticks * TICK_DT, top, ceiling, walls, speed, vy, mat, passes };
}

function padStarts(p) {
  const ix = Math.min(0.3, p.w / 4), iz = Math.min(0.3, p.d / 4);
  return [
    ['center', p.x, p.z],
    ['corner -x-z', p.minX + ix, p.minZ + iz], ['corner +x-z', p.maxX - ix, p.minZ + iz],
    ['corner -x+z', p.minX + ix, p.maxZ - iz], ['corner +x+z', p.maxX - ix, p.maxZ - iz]
  ];
}

/** 발판 하나를 가운데와 네 귀퉁이에서 쏘아 보고 문제를 모은다. 가운데 결과(없으면 null)를 돌려준다 */
function checkPad(world, pad, secrets, out) {
  const tag = `pads[${pad.src}]`;
  const once = new Set();
  const fail = (key, list, msg) => { if (!once.has(key)) { once.add(key); list.push(`${tag} ${msg}`); } };
  let center = null;
  for (const [where, x, z] of padStarts(pad)) {
    const isCenter = where === 'center';
    const floor = getGroundY(world, x, z, pad.y + PAD_HEIGHT_TOL, R - 0.01);
    if (Math.abs(floor - pad.y) > PAD_HEIGHT_TOL) {
      if (isCenter) fail('float', out.errors, `has no floor within ${PAD_HEIGHT_TOL} m of y=${pad.y} (floor ${r2(floor)}); it can never fire`);
      else fail('edge', out.warnings, `hangs over a ledge at its ${where}`);
      continue;
    }
    if (overlapsCapsule(world, x, floor + STEP, z, R - 0.02, H - STEP)) {
      if (isCenter) fail('blocked', out.errors, 'center is inside a wall');
      continue; // 벽에 걸린 귀퉁이에는 사람이 설 수 없다
    }
    const sim = simulatePad(world, pad, x, floor, z, secrets);
    if (!sim.fired) {
      fail('other', out.warnings, `overlaps pads[${sim.by ? sim.by.src : '?'}], which fires first at its ${where}`);
      continue;
    }
    if (isCenter) center = sim;
    if (!sim.landed) { fail('noland', out.errors, `from its ${where}: never lands within ${MAX_FLIGHT_TICKS * TICK_DT} s`); continue; }
    if (sim.ceiling) fail('bonk', out.errors, `from its ${where}: hits a ceiling in flight; lower apex or clear the path`);
    if (sim.walls > 0) fail('wall', out.warnings, `from its ${where}: scrapes a wall in flight`);
    if (sim.mat === 'water') fail('water', out.errors, `from its ${where}: lands on water at ${fmt(...sim.landing)}`);
    if (pad.target) {
      const dist = Math.hypot(sim.landing[0] - pad.target[0], sim.landing[2] - pad.target[2]);
      const dy = Math.abs(sim.landing[1] - pad.target[1]);
      if (dist > PAD_XZ_TOLERANCE) fail('far', out.errors, `from its ${where}: lands ${r2(dist)} m from target at ${fmt(...sim.landing)}`);
      if (dy > PAD_Y_TOLERANCE) fail('height', out.errors, `from its ${where}: lands on a floor ${r2(dy)} m away from target height at ${fmt(...sim.landing)}`);
    }
    if (isCenter && sim.rest[1] < sim.landing[1] - PAD_Y_TOLERANCE) fail('slide', out.warnings, `slides off the landing spot after touching down and drops ${r2(sim.landing[1] - sim.rest[1])} m; add a lip or widen the ledge`);
  }
  return center;
}

/* ---------------- 도달 분석 ---------------- */

/** (x,y,z) 근처의 내비 노드(없으면 -1) */
function nodeNear(nav, x, y, z, maxXZ = 1, maxY = 0.7) {
  const n = nav.nodeAt({ x, y, z }, false);
  if (n < 0) return -1;
  const q = nav.node(n);
  return Math.hypot(q.x - x, q.z - z) <= maxXZ && Math.abs(q.y - y) <= maxY ? n : -1;
}

/**
 * 스폰에서 걷기·뛰어내리기·점프·넘어가기와 발판·포털로 갈 수 있는 노드를 모두 찾는다.
 * @param links [{ kind:'pad'|'portal', index, inside(x,y,z):boolean, dest:number }]
 */
function explore(nav, seeds, links) {
  const d = nav.debug();
  const N = d.x.length, cell = d.cell;
  const onNode = new Map();
  for (let n = 0; n < N; n++) {
    for (const link of links) {
      if (!link.inside(d.x[n], d.y[n], d.z[n])) continue;
      if (!onNode.has(n)) onNode.set(n, []);
      onNode.get(n).push(link);
    }
  }
  const seen = new Uint8Array(N);
  const reached = new Set();
  const stack = [];
  const push = (n) => { if (n >= 0 && !seen[n]) { seen[n] = 1; stack.push(n); } };
  seeds.forEach(push);
  const DX = [1, -1, 0, 0], DZ = [0, 0, 1, -1];
  while (stack.length) {
    const n = stack.pop();
    for (let k = 0; k < 8; k++) push(d.nb[n * 8 + k]);
    // 넘어가기 점프 간선은 debug에 없어서 2~3칸 앞 노드를 edgeType으로 확인한다
    const ci = Math.floor((d.x[n] - d.ox) / cell), ck = Math.floor((d.z[n] - d.oz) / cell);
    for (let k = 0; k < 4; k++) {
      if (d.nb[n * 8 + k] >= 0) continue;
      for (let st = 2; st <= 3; st++) {
        const ni = ci + DX[k] * st, nk = ck + DZ[k] * st;
        if (ni < 0 || nk < 0 || ni >= d.nx || nk >= d.nz) break;
        const c = ni + nk * d.nx;
        for (let m = d.colStart[c]; m < d.colStart[c + 1]; m++) {
          if (!seen[m] && nav.edgeType(n, m) === NAV_EDGE.JUMP) push(m);
        }
      }
    }
    const here = onNode.get(n);
    if (here) for (const link of here) { reached.add(`${link.kind}:${link.index}`); push(link.dest); }
  }
  return { seen, reached, debug: d };
}

/** 내비 노드가 비밀 상자 안에 있나 (칸 간격만큼 여유) */
function walkableInto(reach, s) {
  const { seen, debug: d } = reach;
  const m = d.cell / 2;
  for (let n = 0; n < seen.length; n++) {
    if (!seen[n]) continue;
    const x = d.x[n], y = d.y[n], z = d.z[n];
    if (x >= s.minX - m && x <= s.maxX + m && z >= s.minZ - m && z <= s.maxZ + m && y < s.maxY && y + H > s.minY) return true;
  }
  return false;
}

/**
 * 갈 수 있는 노드에서 달려서 점프해 보는 탐색(입력은 진행 방향 유지). 몸이 상자에 들어가면 성공.
 * 착지한 곳을 다시 출발점으로 삼는다. 상자와 높이 차가 작은 곳을 먼저 살피고, 같은 높이면 가까운 곳부터 살핀다.
 */
function jumpProbe(world, reach, s) {
  const { seen, debug: d } = reach;
  const cost = (x, y, z) => Math.max(0, s.minY - y) * 100 + distToRect(s, x, z);
  const inRange = (x, z) => distToRect(s, x, z) <= JUMP_RADIUS;
  const cands = [];
  for (let n = 0; n < seen.length; n++) {
    if (seen[n] && inRange(d.x[n], d.z[n])) cands.push([cost(d.x[n], d.y[n], d.z[n]), n]);
  }
  cands.sort((a, b) => a[0] - b[0]);
  const open = [];
  const seenKey = new Set();
  const add = (x, y, z, jumps) => {
    const key = `${Math.round(x / 0.5)},${Math.round(y / 0.25)},${Math.round(z / 0.5)}`;
    if (seenKey.has(key)) return;
    seenKey.add(key);
    open.push({ x, y, z, jumps, c: cost(x, y, z) });
  };
  for (const [, n] of cands) {
    if (open.length >= JUMP_STARTS) break;
    add(d.x[n], d.y[n], d.z[n], 0);
  }
  let sims = 0;
  while (open.length && sims < JUMP_SIMS) {
    let best = 0;
    for (let i = 1; i < open.length; i++) if (open[i].c + open[i].jumps * 0.5 < open[best].c + open[best].jumps * 0.5) best = i;
    const cur = open.splice(best, 1)[0];
    for (let k = 0; k < JUMP_DIRS; k++) {
      sims++;
      const a = (k / JUMP_DIRS) * Math.PI * 2;
      const vx = Math.cos(a) * PLAYER.WALK, vz = Math.sin(a) * PLAYER.WALK;
      const body = { pos: [cur.x, cur.y, cur.z], vel: [vx, 0, vz], onGround: true };
      const wish = { x: vx, z: vz, jump: true };
      for (let t = 0; t < JUMP_TICKS; t++) {
        moveCharacter(world, body, wish, TICK_DT);
        wish.jump = false;
        if (insideBody(s, body.pos[0], body.pos[1], body.pos[2])) return { ok: true, jumps: cur.jumps + 1, sims };
        if (body.onGround && t > 0) break;
      }
      if (body.onGround && inRange(body.pos[0], body.pos[2])) add(body.pos[0], body.pos[1], body.pos[2], cur.jumps + 1);
    }
  }
  return { ok: false, sims };
}

/** 발판 착지(또는 통과)나 포털 도착으로 비밀 상자에 닿나 */
function triggerInto(s, reach, padSims, portalRests) {
  const near = (x, y, z) => distToRect(s, x, z) <= SECRET_NEAR && y < s.maxY + PAD_Y_TOLERANCE && y + H > s.minY - PAD_Y_TOLERANCE;
  for (const { pad, sim } of padSims) {
    if (!sim || !sim.landed || !reach.reached.has(`pad:${pad.index}`)) continue;
    if (sim.passes.has(s.id) || near(sim.landing[0], sim.landing[1], sim.landing[2])) return `pad ${pad.src}`;
  }
  for (const { portal, rest } of portalRests) {
    if (reach.reached.has(`portal:${portal.index}`) && near(rest.x, rest.y, rest.z)) return `portal ${portal.src}`;
  }
  return null;
}

/* ---------------- 맵 하나 ---------------- */

function hasEnemySight(world, a, b, far) {
  const A = [a.x, a.y + EYE, a.z];
  const dir = [b.x - a.x, b.y - a.y, b.z - a.z];
  const len = Math.hypot(dir[0], dir[1], dir[2]);
  if (len < 1e-3 || len > far) return false;
  const hit = raycastWorld(world, A, dir, len, { filter: (c) => c.mat !== 'glass' });
  return !hit || hit.dist >= len - 1e-3;
}

/**
 * 몸 둘레 대부분이 낭떠러지인가. 스폰 높이 자동 찾기는 벽 속 스폰을 벽 위로 올려 놓으므로,
 * 겹침 검사를 통과해도 벽이나 기둥 꼭대기에 선 스폰은 여기서 잡는다.
 */
function isNarrowPerch(world, x, y, z) {
  let drops = 0;
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    if (getGroundY(world, x + Math.cos(a) * PERCH_PROBE, z + Math.sin(a) * PERCH_PROBE, y + STEP, 0.05) < y - STEP) drops++;
  }
  return drops >= 6;
}

function checkSpawns(data, col, strict, out) {
  const { world, spawns } = col;
  const severe = strict ? out.errors : out.warnings;
  for (const team of [...TEAM_IDS, 'ffa']) {
    const list = spawns[team] || [];
    const raw = (data.spawns && Array.isArray(data.spawns[team]) ? data.spawns[team] : []).filter((p) => p && Number.isFinite(+p.x) && Number.isFinite(+p.z));
    list.forEach((p, i) => {
      const label = `spawns.${team}[${i}]`;
      checkStanding(world, label, p.x, p.y, p.z, out);
      if (isNarrowPerch(world, p.x, p.y, p.z)) severe.push(`${label} ${fmt(p.x, p.y, p.z)}: stands on a narrow top; it was probably placed inside a solid and lifted by the floor search`);
      const wanted = raw[i] && raw[i].y;
      if (Number.isFinite(wanted) && Math.abs(wanted - p.y) > PAD_Y_TOLERANCE) severe.push(`${label}: y ${wanted} was asked for but the first free floor is at y ${r2(p.y)}`);
      for (let j = 0; j < i; j++) {
        const q = list[j];
        if (Math.hypot(p.x - q.x, p.z - q.z) < SPAWN_MIN_GAP && Math.abs(p.y - q.y) < H) out.warnings.push(`spawns.${team}[${i}] is within ${SPAWN_MIN_GAP} m of spawns.${team}[${j}]`);
      }
    });
    if (strict && team !== 'ffa' && list.length < MIN_TEAM_SPAWNS) out.errors.push(`spawns.${team}: ${list.length} < ${MIN_TEAM_SPAWNS}`);
    if (strict && team === 'ffa' && list.length < MIN_FFA_SPAWNS) out.errors.push(`spawns.ffa: ${list.length} < ${MIN_FFA_SPAWNS}`);
  }
  const far = col.theme.fog[1];
  const seen = [];
  (spawns[TEAM_IDS[0]] || []).forEach((a, i) => (spawns[TEAM_IDS[1]] || []).forEach((b, j) => {
    if (hasEnemySight(world, a, b, far)) seen.push(`${TEAM_IDS[0]}[${i}] <-> ${TEAM_IDS[1]}[${j}] (${r2(Math.hypot(a.x - b.x, a.z - b.z))} m)`);
  }));
  if (seen.length) out.warnings.push(`line of sight between enemy spawns: ${seen.slice(0, 3).join(', ')}${seen.length > 3 ? ` and ${seen.length - 3} more` : ''}`);
  return seen.length;
}

function checkWalkability(data, col, out) {
  const nav = buildNavGrid(data);
  const { spawns } = col;
  const pathExists = (a, list) => list.some((b) => b !== a && nav.findPath(a, b, { smooth: false }));
  for (const team of TEAM_IDS) {
    const enemy = team === TEAM_IDS[0] ? TEAM_IDS[1] : TEAM_IDS[0];
    (spawns[team] || []).forEach((p, i) => {
      const n = nav.nodeAt(p, false), q = n >= 0 ? nav.node(n) : null;
      if (!q || Math.hypot(q.x - p.x, q.z - p.z) > 1.6) out.warnings.push(`spawns.${team}[${i}] has no navgrid node nearby; bots spawned here will wander`);
      if (!pathExists(p, spawns[enemy] || [])) out.errors.push(`spawns.${team}[${i}] cannot reach any ${enemy} spawn on the navgrid`);
    });
  }
  const all = [...(spawns.owner || []), ...(spawns.charterer || []), ...(spawns.ffa || [])];
  (spawns.ffa || []).forEach((p, i) => {
    if (!pathExists(p, all)) out.errors.push(`spawns.ffa[${i}] cannot reach any other spawn on the navgrid`);
  });
  return nav;
}

function checkProps(data, world, out) {
  (Array.isArray(data.props) ? data.props : []).forEach((p, i) => {
    if (!p || !Number.isFinite(+p.x) || !Number.isFinite(+p.z)) return;
    const size = +p.size > 0 ? +p.size : 1;
    if (overlapsCapsule(world, +p.x, +p.y || 0, +p.z, size / 2, size)) out.warnings.push(`props[${i}] starts inside a solid at ${fmt(+p.x, +p.y || 0, +p.z)}`);
  });
}

/**
 * 맵 데이터 하나를 검사한다.
 * @returns {{id, strict, ok, errors, warnings, counts, nav, pads, secrets, los}}
 */
export function checkMap(id, data) {
  const strict = !EXEMPT_MAPS.has(id) && (NEW_MAPS.has(id) || Array.isArray(data && data.rulesets));
  const out = { id, strict, ok: false, errors: [], warnings: [], counts: null, nav: null, pads: [], secrets: [], los: 0 };
  const v = validateMap(data);
  out.errors.push(...v.errors);
  (strict ? out.errors : out.warnings).push(...v.warnings);
  if (!v.ok) return out;

  const col = buildCollision(data);
  const { world, triggers } = col;
  out.counts = {
    solids: data.solids.length, decor: Array.isArray(data.decor) ? data.decor.length : 0,
    pads: triggers.pads.length, portals: triggers.portals.length, secrets: triggers.secrets.length,
    props: Array.isArray(data.props) ? data.props.length : 0,
    owner: col.spawns.owner.length, charterer: col.spawns.charterer.length, ffa: col.spawns.ffa.length
  };

  out.los = checkSpawns(data, col, strict, out);
  const nav = checkWalkability(data, col, out);
  out.nav = { nodes: nav.info.nodes, good: nav.info.good, ms: Math.round(nav.info.buildMs) };
  checkProps(data, world, out);

  const padSims = triggers.pads.map((pad) => ({ pad, sim: checkPad(world, pad, triggers.secrets, out) }));
  const portalRests = triggers.portals.map((portal) => {
    const rest = checkStanding(world, `portals[${portal.src}] destination`, portal.to.x, portal.to.y, portal.to.z, out, PORTAL_MAX_DROP);
    for (const other of triggers.portals) {
      if (insideBody(other, portal.to.x, portal.to.y, portal.to.z)) out.warnings.push(`portals[${portal.src}] destination is inside portals[${other.src}]`);
    }
    return { portal, rest };
  });
  out.pads = padSims.map(({ pad, sim }) => (sim && sim.landed ? {
    index: pad.src, landing: sim.landing.map(r2), rest: sim.rest.map(r2), time: r2(sim.time), top: r2(sim.top),
    speed: r2(sim.speed), vy: r2(sim.vy),
    dist: pad.target ? r2(Math.hypot(sim.landing[0] - pad.target[0], sim.landing[2] - pad.target[2])) : null
  } : { index: pad.src, landing: null }));

  if (triggers.empty) { out.ok = !out.errors.length; return out; }

  // 발판·포털·비밀 도달 분석: 칸을 줄이고, 플레이어는 어느 높이에서든 뛰어내릴 수 있으니 낙하 제한을 푼다
  const fine = buildNavGrid(data, { cell: FINE_CELL, maxDrop: 60, strategicSpacing: 0 });
  const seeds = [];
  for (const team of [...TEAM_IDS, 'ffa']) for (const p of col.spawns[team] || []) seeds.push(fine.nodeAt(p, false));
  const links = [];
  const m = FINE_CELL / 2;
  for (const { pad, sim } of padSims) {
    const dest = sim && sim.landed ? nodeNear(fine, sim.landing[0], sim.landing[1], sim.landing[2]) : -1;
    links.push({
      kind: 'pad', index: pad.index, dest,
      inside: (x, y, z) => x >= pad.minX - m && x <= pad.maxX + m && z >= pad.minZ - m && z <= pad.maxZ + m && Math.abs(y - pad.y) <= PAD_HEIGHT_TOL
    });
  }
  for (const { portal, rest } of portalRests) {
    links.push({
      kind: 'portal', index: portal.index, dest: nodeNear(fine, rest.x, rest.y, rest.z),
      inside: (x, y, z) => x >= portal.minX - m && x <= portal.maxX + m && z >= portal.minZ - m && z <= portal.maxZ + m && y < portal.maxY && y + H > portal.minY
    });
  }
  const reach = explore(fine, seeds, links);
  for (const { pad } of padSims) if (!reach.reached.has(`pad:${pad.index}`)) out.warnings.push(`pads[${pad.src}] at ${fmt(pad.x, pad.y, pad.z)} cannot be reached from any spawn`);
  for (const { portal } of portalRests) if (!reach.reached.has(`portal:${portal.index}`)) out.warnings.push(`portals[${portal.src}] at ${fmt(portal.x, portal.y, portal.z)} cannot be reached from any spawn`);

  for (const s of triggers.secrets) {
    let via = walkableInto(reach, s) ? 'walk' : triggerInto(s, reach, padSims, portalRests);
    if (!via && s.reach === 'jump') {
      const probe = jumpProbe(world, reach, s);
      if (probe.ok) via = `jump x${probe.jumps}`;
      else out.errors.push(`secrets[${s.src}] "${s.id}" has reach:'jump' but ${probe.sims} simulated running jumps never entered its box`);
    } else if (!via) {
      out.errors.push(`secrets[${s.src}] "${s.id}" at ${fmt(s.x, s.y, s.z)} is unreachable: no walk or jump route, no reachable pad landing or portal destination within ${SECRET_NEAR} m; add one, or mark reach:'jump' if a jump route exists`);
    }
    out.secrets.push({ id: s.id, via: via || null });
  }

  out.ok = !out.errors.length;
  return out;
}

/* ---------------- 출력 ---------------- */

function printTable(reports) {
  const cols = [
    ['map', 10, (r) => r.id], ['status', 7, (r) => (r.errors.length ? 'FAIL' : r.warnings.length ? 'WARN' : 'OK')],
    ['solids', 7, (r) => (r.counts ? r.counts.solids : '-')], ['decor', 6, (r) => (r.counts ? r.counts.decor : '-')],
    ['pads', 5, (r) => (r.counts ? r.counts.pads : '-')], ['portals', 8, (r) => (r.counts ? r.counts.portals : '-')],
    ['secrets', 8, (r) => (r.counts ? r.counts.secrets : '-')], ['props', 6, (r) => (r.counts ? r.counts.props : '-')],
    ['team', 6, (r) => (r.counts ? `${r.counts.owner}/${r.counts.charterer}` : '-')], ['ffa', 4, (r) => (r.counts ? r.counts.ffa : '-')],
    ['nav', 7, (r) => (r.nav ? r.nav.nodes : '-')], ['los', 4, (r) => r.los], ['err', 4, (r) => r.errors.length], ['warn', 4, (r) => r.warnings.length]
  ];
  const line = (cells) => cells.map((c, i) => (i < 2 ? String(c).padEnd(cols[i][1]) : String(c).padStart(cols[i][1]))).join(' ');
  console.log(line(cols.map((c) => c[0])));
  console.log(line(cols.map((c) => '-'.repeat(c[1]))));
  for (const r of reports) console.log(line(cols.map((c) => c[2](r))));
}

function printDetails(reports) {
  for (const r of reports) {
    if (!r.errors.length && !r.warnings.length && !r.pads.length && !r.secrets.length) continue;
    console.log(`\n[${r.id}]${r.strict ? ' (new-map rules)' : ''}`);
    for (const p of r.pads) {
      console.log(p.landing
        ? `  pad ${p.index}: lands at (${p.landing.join(', ')})${p.dist === null ? '' : `, ${p.dist} m from target`}, ${p.time} s, top y ${p.top}, ${p.speed} m/s`
        : `  pad ${p.index}: no landing`);
    }
    for (const s of r.secrets) console.log(`  secret ${s.id}: ${s.via ? `via ${s.via}` : 'unreachable'}`);
    for (const e of r.errors) console.log(`  ERROR ${e}`);
    for (const w of r.warnings) console.log(`  warn  ${w}`);
  }
}

/* ---------------- 실행 ---------------- */

async function loadTargets(args) {
  const fileAt = args.indexOf('--file');
  if (fileAt >= 0) {
    const path = resolve(args[fileAt + 1] || '');
    const mod = await import(pathToFileURL(path).href);
    const data = mod.default;
    return [{ id: (data && data.id) || basename(path).replace(/\.[^.]+$/, ''), data }];
  }
  // 없는 맵 파일은 일부러 건너뛰므로 목록을 불러오는 동안의 대체 경고는 감춘다
  const realWarn = console.warn;
  console.warn = () => {};
  const { MAP_IDS, MAP_STATUS, TEST_MAP, getMap } = await import('../js/maps/index.js').finally(() => { console.warn = realWarn; });
  const fileExists = (id) => existsSync(new URL(`../js/maps/${id}.js`, import.meta.url));
  const only = args.find((a) => !a.startsWith('--'));
  if (only === TEST_MAP.id) return [{ id: only, data: TEST_MAP }];
  if (only && !MAP_IDS.includes(only)) return [{ id: only, error: `unknown map id; known: ${[...MAP_IDS, TEST_MAP.id].join(', ')}` }];
  if (only && !fileExists(only)) return [{ id: only, error: `js/maps/${only}.js does not exist` }];
  const targets = [];
  for (const id of only ? [only] : MAP_IDS.filter(fileExists)) {
    if (MAP_STATUS[id].ok) { targets.push({ id, data: getMap(id) }); continue; }
    // 다시 불러와 줄 번호가 담긴 원래 오류를 보여 준다
    const detail = await import(`../js/maps/${id}.js`).then(() => MAP_STATUS[id].error, (err) => String((err && err.stack) || err).split('\n').slice(0, 5).join('\n'));
    targets.push({ id, error: `js/maps/${id}.js failed to load: ${detail}` });
  }
  return targets;
}

async function main() {
  const args = process.argv.slice(2);
  const targets = await loadTargets(args);
  const reports = targets.map((t) => {
    if (t.error) return { id: t.id, strict: true, ok: false, errors: [t.error], warnings: [], counts: null, nav: null, pads: [], secrets: [], los: 0 };
    try {
      return checkMap(t.id, t.data);
    } catch (err) {
      return { id: t.id, strict: true, ok: false, errors: [`checker crashed: ${err && err.stack ? err.stack : err}`], warnings: [], counts: null, nav: null, pads: [], secrets: [], los: 0 };
    }
  });
  const ok = reports.length > 0 && reports.every((r) => !r.errors.length);
  if (args.includes('--json')) {
    console.log(JSON.stringify({ ok, maps: reports }, null, 2));
  } else if (!reports.length) {
    console.log('no map files found');
  } else {
    printTable(reports);
    printDetails(reports);
    const errors = reports.reduce((a, r) => a + r.errors.length, 0), warnings = reports.reduce((a, r) => a + r.warnings.length, 0);
    console.log(`\n${reports.length} map(s), ${errors} error(s), ${warnings} warning(s)`);
  }
  process.exitCode = ok ? 0 : 1;
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href.toLowerCase() === import.meta.url.toLowerCase();
if (isMain) await main();
