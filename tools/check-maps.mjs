/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 맵 데이터 검사기(npm run check:maps). 게임과 같은 물리 코드로 스폰, 발판 궤적, 포털, 비밀 스팟, 길 찾기, 폭파 미션 구역,
 *          움직이는 지형을 시뮬레이션해 맵 제작 실수를 찾는다. 오류가 있으면 종료 코드 1. 사용법: node tools/check-maps.mjs [맵 id] [--json] [--file 경로]
 */
import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PLAYER, TEAM_IDS, TICK_DT } from '../js/core/consts.js';
import { findFloor, getGroundY, moveCharacter, overlapsCapsule, raycastWorld } from '../js/engine/physics.js';
import { PAD_HEIGHT_TOL, stepTriggers } from '../js/engine/triggers.js';
import { moverBox, moverSweep, moverPeakSpeed } from '../js/engine/movers.js';
import { SITE_IDS, normalizeMission, placeMission, siteAt, siteContains } from '../js/game/mission.js';
import { NAV_EDGE, buildNavGrid } from '../js/game/navgrid.js';
import { CROWD, buildCollision, missionCrowd, validateMap } from '../js/maps/collision.js';

/** 새 맵 전용 요구 사항(팀 스폰 수, 개인전 스폰 수, 경고를 오류로 취급)을 적용할 id. rulesets가 있는 맵도 같다(테스트 맵 제외) */
const NEW_MAPS = new Set(['alley', 'dojo', 'longshot', 'nexus', 'relay', 'railyard', 'observatory', 'cqb', 'sorthub']);
const EXEMPT_MAPS = new Set(['testyard']);
const MIN_TEAM_SPAWNS = 4;
const MIN_FFA_SPAWNS = 6;
const MIN_MISSION_SPAWNS = 4;    // 폭파 미션 진영마다 스폰 수
const MIN_SITE_NODES = 16;       // 구역 안 걷기 칸(내비 1 m 칸) 수
const MISSION_LEAD = 10;         // 수비가 공격보다 이만큼(m) 먼저 구역에 닿아야 한다
const MISSION_SIDES = ['attack', 'defense'];

const PAD_XZ_TOLERANCE = 2;      // 착지와 target의 수평 거리(m)
const PAD_Y_TOLERANCE = 0.6;     // 착지 바닥과 target의 높이 차(m)
const SECRET_NEAR = 2;           // 착지·도착이 비밀 상자에서 이 안이면 닿은 것으로 친다(m)
const MAX_FLIGHT_TICKS = 8 / TICK_DT;
const SLIDE_TICKS = 90;          // 착지 후 미끄러짐을 지켜보는 틱
const SPAWN_MIN_GAP = 1;         // 같은 팀 스폰끼리 이보다 가까우면 경고(m)
const PERCH_PROBE = 0.7;         // 스폰 둘레 바닥을 살피는 거리(m)
const FINE_CELL = 0.5;           // 비밀 스팟·발판 도달 분석용 내비 칸(m)
const PORTAL_MAX_DROP = 1;       // 포털 도착 높이가 바닥보다 이만큼까지 위여도 된다(m)
const MOVER_STOP_GAP = 1.5;      // 수평으로 움직이는 상자가 멈춘 자리와 그 앞 벽 사이에 남겨야 하는 거리(m)
const MOVER_SIDE_GAP = 1.5;      // 수평으로 움직이는 상자 옆에 남겨야 하는 걷는 폭(m, 몸 지름 포함해 약 1.9)
const MOVER_HEADROOM = 2.2;      // 타고 올라가는 상자 윗면 위에 비어 있어야 하는 높이(m)
const MOVER_STAND_MIN = 1;       // 윗면의 짧은 변이 이보다 길면 사람이 타는 상자로 본다(m)
const FLOOR_MARK_H = 0.06;       // 이보다 얇은 바닥 도형(차선·레일)은 움직이는 지형과 겹쳐도 된다(m)

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

/**
 * 16인방 보조 자리(maps/collision.js crowdSpots): 팀마다 스폰 + 보조 자리가 CROWD.TEAM(8), 개인전 후보가 CROWD.FFA(16)에 닿아야 하고,
 * 보조 자리도 스폰처럼 설 수 있어야 한다. 모자라면 경기가 사람을 1.2 m씩 옆으로 비켜 세워서 벽에 낄 수 있다
 */
function checkCrowd(col, out) {
  const extra = col.spawns.extra || {};
  const totals = {};
  for (const team of [...TEAM_IDS, 'ffa']) {
    const list = extra[team] || [];
    list.forEach((p, i) => checkStanding(col.world, `spawns.extra.${team}[${i}]`, p.x, p.y, p.z, out));
    const base = team === 'ffa' ? TEAM_IDS.reduce((n, t) => n + (col.spawns[t] || []).length, 0) + (col.spawns.ffa || []).length : (col.spawns[team] || []).length;
    const want = team === 'ffa' ? CROWD.FFA : CROWD.TEAM;
    totals[team] = base + list.length;
    if (totals[team] < want) out.errors.push(`spawns.${team}: ${base} spawns + ${list.length} crowd spots < ${want}; a 16-player room would stack people 1.2 m apart (add spawns or clear room around them)`);
  }
  return totals;
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

/* ---------------- 움직이는 지형 ---------------- */

const boxHit = (a, b, eps = 0.02) => a.minX < b.maxX - eps && b.minX < a.maxX - eps && a.minZ < b.maxZ - eps && b.minZ < a.maxZ - eps && a.minY < b.maxY - eps && b.minY < a.maxY - eps;
const footprintInside = (a, b, eps = 0.02) => a.minX >= b.minX - eps && a.maxX <= b.maxX + eps && a.minZ >= b.minZ - eps && a.maxZ <= b.maxZ + eps;

/**
 * 움직이는 지형 검사(docs/MAP_GUIDE.md 11절). 판정은 게임과 같은 engine/movers.js로 읽는다.
 * 지나가는 부피에 스폰·발판·포털·폭파 구역·소품·도형이 없는지, 수평으로 움직이는 상자가 사람을 벽에 끼우지 않는지(멈추는 자리 앞 1.5 m),
 * 옆으로 비켜 갈 폭이 있는지, 타는 상자 위에 머리 공간이 있는지를 본다.
 * @param data 맵 데이터 @param col buildCollision(data) @param out 오류·경고를 더할 { errors, warnings }
 * @returns {{ id, axis, dist, period, hold, speed }[]}
 */
export function checkMovers(data, col, out = { errors: [], warnings: [] }) {
  const list = col.movers ? col.movers.list : [];
  if (!list.length) return [];
  // 움직이는 지형이 없는 월드: 쉬는 자리의 상자가 자기 검사를 가리지 않게 한다
  const still = buildCollision({ ...data, movers: undefined });
  const statics = still.solidColliders.filter((c) => c.maxY - c.minY > FLOOR_MARK_H);
  const spots = [];
  for (const team of [...TEAM_IDS, 'ffa']) (still.spawns[team] || []).forEach((p, i) => spots.push([`spawns.${team}[${i}]`, p]));
  const mission = normalizeMission(data);
  if (mission) {
    const placed = placeMission(mission, still.world, findFloor, getGroundY);
    for (const side of MISSION_SIDES) placed[side].forEach((p, i) => spots.push([`mission.${side}[${i}]`, p]));
  }
  const report = [];
  for (const { spec } of list) {
    const tag = `movers[${spec.src}] "${spec.id}"`;
    const sweep = moverSweep(spec);
    const horizontal = spec.axis !== 'y';
    report.push({ id: spec.id, axis: spec.axis, dist: spec.dist, period: spec.period, hold: spec.hold, speed: r2(moverPeakSpeed(spec)) });

    const grown = { minX: sweep.minX - R - 0.1, maxX: sweep.maxX + R + 0.1, minZ: sweep.minZ - R - 0.1, maxZ: sweep.maxZ + R + 0.1 };
    for (const [label, p] of spots) {
      if (p.x > grown.minX && p.x < grown.maxX && p.z > grown.minZ && p.z < grown.maxZ && p.y < sweep.maxY + 0.1 && p.y + H > sweep.minY) {
        out.errors.push(`${label} ${fmt(p.x, p.y, p.z)} stands in the path of ${tag}`);
      }
    }
    for (const pad of col.triggers.pads) {
      const body = { minX: pad.minX, maxX: pad.maxX, minZ: pad.minZ, maxZ: pad.maxZ, minY: pad.y - PAD_HEIGHT_TOL, maxY: pad.y + H };
      if (boxHit(body, sweep)) out.errors.push(`pads[${pad.src}] lies in the path of ${tag}`);
      if (pad.target && insideBody(sweep, pad.target[0], pad.target[1], pad.target[2])) out.warnings.push(`pads[${pad.src}] target is in the path of ${tag}`);
    }
    for (const portal of col.triggers.portals) {
      if (boxHit(portal, sweep)) out.errors.push(`portals[${portal.src}] lies in the path of ${tag}`);
      if (insideBody(sweep, portal.to.x, portal.to.y, portal.to.z)) out.errors.push(`portals[${portal.src}] destination is in the path of ${tag}`);
    }
    if (mission) for (const s of mission.sites) if (boxHit(s, sweep)) out.errors.push(`mission site ${s.id} overlaps the path of ${tag}; a bomb planted there would be run over`);
    (Array.isArray(data.props) ? data.props : []).forEach((p, i) => {
      if (p && Number.isFinite(+p.x) && Number.isFinite(+p.z) && insideBody(sweep, +p.x, +p.y || 0, +p.z, +p.size > 0 ? +p.size : 1)) out.warnings.push(`props[${i}] starts in the path of ${tag}`);
    });

    // 도형과 겹침: 위아래로 움직이는 상자는 자기보다 넓은 도형 속(문 위 벽)으로 들어가도 된다
    for (const c of statics) {
      if (!boxHit(c, sweep)) continue;
      if (!horizontal && footprintInside(sweep, c)) continue;
      out.errors.push(`${tag} passes through solids[${c.index}] (${c.mat}) at x ${r2(c.minX)}..${r2(c.maxX)}, z ${r2(c.minZ)}..${r2(c.maxZ)}, y ${r2(c.minY)}..${r2(c.maxY)}`);
    }

    if (horizontal) {
      // 멈추는 자리 앞: 밀려 온 사람이 설 자리가 있어야 한다(없으면 벽과 상자 사이에 끼인다)
      const alongX = spec.axis === 'x';
      const lo = alongX ? sweep.minX : sweep.minZ, hi = alongX ? sweep.maxX : sweep.maxZ;
      const y0 = sweep.minY + STEP, y1 = sweep.minY + Math.max(spec.h, H);
      for (const [name, a, b] of [['low', lo - MOVER_STOP_GAP, lo], ['high', hi, hi + MOVER_STOP_GAP]]) {
        const zone = alongX
          ? { minX: a, maxX: b, minZ: sweep.minZ, maxZ: sweep.maxZ, minY: y0, maxY: y1 }
          : { minX: sweep.minX, maxX: sweep.maxX, minZ: a, maxZ: b, minY: y0, maxY: y1 };
        const hit = statics.find((c) => boxHit(c, zone));
        const edge = alongX ? (name === 'low' ? still.bounds.minX : still.bounds.maxX) : (name === 'low' ? still.bounds.minZ : still.bounds.maxZ);
        if (hit) out.errors.push(`${tag} stops less than ${MOVER_STOP_GAP} m from solids[${hit.index}] (${hit.mat}) at its ${name}-${spec.axis} end; a player pushed along would be pinned`);
        else if (name === 'low' ? a < edge : b > edge) out.errors.push(`${tag} stops less than ${MOVER_STOP_GAP} m from the map edge at its ${name}-${spec.axis} end`);
      }
      // 옆으로 비켜 갈 폭: 길 전체에서 적어도 한쪽에 몸이 설 자리가 이어져야 한다
      const floor = sweep.minY;
      const sideFree = (sign) => {
        for (let k = 0; k <= 8; k++) {
          const t = lo + ((hi - lo) * k) / 8;
          for (const gap of [R + 0.15, MOVER_SIDE_GAP]) {
            const off = (alongX ? spec.d : spec.w) / 2 + gap;
            const px = alongX ? t : spec.x + sign * off, pz = alongX ? spec.z + sign * off : t;
            if (overlapsCapsule(still.world, px, floor + STEP, pz, R - 0.02, H - STEP)) return false;
          }
        }
        return true;
      };
      if (!sideFree(1) && !sideFree(-1)) out.warnings.push(`${tag} has no ${r2(MOVER_SIDE_GAP + R)} m wide walkway beside its whole path; players and bots cannot step aside`);
    } else if (Math.min(spec.w, spec.d) >= MOVER_STAND_MIN) {
      // 타는 상자: 가장 높이 올라간 윗면 위에 머리 공간
      const top = sweep.maxY;
      const head = { minX: sweep.minX + 0.1, maxX: sweep.maxX - 0.1, minZ: sweep.minZ + 0.1, maxZ: sweep.maxZ - 0.1, minY: top + 0.05, maxY: top + MOVER_HEADROOM };
      const hit = still.solidColliders.find((c) => boxHit(c, head));
      if (hit) out.errors.push(`${tag} has less than ${MOVER_HEADROOM} m of headroom above its top at y ${r2(top)} (solids[${hit.index}] ${hit.mat}); a rider would be pushed into it`);
    }
  }
  return report;
}

/* ---------------- 폭파 미션 ---------------- */

/** 출발점부터 경유점을 따라간 길이(m) */
function pathLength(from, path) {
  let len = 0, px = from.x, py = from.y, pz = from.z;
  for (const w of path) {
    len += Math.hypot(w.x - px, w.y - py, w.z - pz);
    px = w.x; py = w.y; pz = w.z;
  }
  return len;
}

const r1 = (v) => Math.round(v * 10) / 10;
const boxesOverlap = (a, b) => a.minX < b.maxX && b.minX < a.maxX && a.minZ < b.maxZ && b.minZ < a.maxZ && a.minY < b.maxY && b.minY < a.maxY;

/**
 * 폭파 미션 칸 검사(docs/MAP_GUIDE.md 10절). 게임과 같은 normalizeMission·siteContains로 읽는다.
 * 구역 A·B, 구역 안 걷기 칸 수, 진영 스폰(수, 설 자리, 구역 밖), 스폰에서 각 구역까지 내비 경로 길이를 본다.
 * 경로 끝은 구역 중심에 가장 가까운 걷기 칸이다.
 * @param data 맵 데이터 @param nav buildNavGrid(data) @param out 오류·경고를 더할 { errors, warnings } @param col buildCollision(data)
 * @returns {null | { sites: [{ id, name, nodes, area, attack: {min, avg, n}|null, defense }], attack, defense, los }} mission이 없으면 null
 */
export function checkMission(data, nav, out = { errors: [], warnings: [] }, col = buildCollision(data)) {
  if (!data || data.mission === undefined || data.mission === null) return null;
  const report = { sites: [], attack: 0, defense: 0, los: 0 };
  const m = normalizeMission(data);
  if (!m) { out.errors.push('mission: no valid site; sites needs [{ id, x, y, z, w, h, d }]'); return report; }
  const { world, size } = col;

  // 구역: A·B가 있는지, 맵 안인지, 서로 겹치지 않는지, 바닥 칸이 넉넉한지
  const ids = m.sites.map((s) => s.id);
  for (const id of SITE_IDS) if (!ids.includes(id)) out.errors.push(`mission.sites: site ${id} is missing (got ${ids.join(', ')})`);
  for (const id of ids) if (!SITE_IDS.includes(id)) out.warnings.push(`mission.sites: site ${id} is not one of ${SITE_IDS.join(', ')}`);
  const d = nav.debug();
  const sites = m.sites.map((s) => {
    if (s.minX < -size.x / 2 || s.maxX > size.x / 2 || s.minZ < -size.z / 2 || s.maxZ > size.z / 2) {
      out.errors.push(`mission site ${s.id}: box x ${s.minX}..${s.maxX}, z ${s.minZ}..${s.maxZ} is outside size ${size.x} x ${size.z}`);
    }
    const cells = [];
    for (let n = 0; n < d.x.length; n++) if (d.good[n] && siteContains(s, { x: d.x[n], y: d.y[n], z: d.z[n] })) cells.push(n);
    if (cells.length < MIN_SITE_NODES) out.errors.push(`mission site ${s.id}: ${cells.length} walkable navgrid cells inside (need ${MIN_SITE_NODES}); clear the floor or move the box onto it`);
    let target = null, best = Infinity;
    for (const n of cells) {
      const score = Math.hypot(d.x[n] - s.x, d.z[n] - s.z) + Math.abs(d.y[n] - s.y);
      if (score < best) { best = score; target = { x: d.x[n], y: d.y[n], z: d.z[n] }; }
    }
    return { site: s, target, entry: { id: s.id, name: s.name, nodes: cells.length, area: r1(cells.length * d.cell * d.cell), attack: null, defense: null } };
  });
  for (let i = 0; i < m.sites.length; i++) {
    for (let j = 0; j < i; j++) if (boxesOverlap(m.sites[i], m.sites[j])) out.errors.push(`mission sites ${m.sites[j].id} and ${m.sites[i].id} overlap`);
  }

  // 진영 스폰: 수, 설 자리, 구역 밖, 서로 간격
  const placed = placeMission(m, world, findFloor, getGroundY);
  for (const side of MISSION_SIDES) {
    const list = placed[side];
    report[side] = list.length;
    if (list.length < MIN_MISSION_SPAWNS) out.errors.push(`mission.${side}: ${list.length} < ${MIN_MISSION_SPAWNS} spawns`);
    list.forEach((p, i) => {
      const label = `mission.${side}[${i}]`;
      if (Math.abs(p.x) > size.x / 2 || Math.abs(p.z) > size.z / 2) out.errors.push(`${label} ${fmt(p.x, p.y, p.z)} is outside size`);
      checkStanding(world, label, p.x, p.y, p.z, out);
      if (isNarrowPerch(world, p.x, p.y, p.z)) out.errors.push(`${label} ${fmt(p.x, p.y, p.z)}: stands on a narrow top; it was probably placed inside a solid and lifted by the floor search`);
      const inside = siteAt(m.sites, p);
      if (inside) out.errors.push(`${label} ${fmt(p.x, p.y, p.z)} is inside site ${inside.id}; spawns must stand outside the sites`);
      const n = nav.nodeAt(p, false), q = n >= 0 ? nav.node(n) : null;
      if (!q || Math.hypot(q.x - p.x, q.z - p.z) > 1.6) out.warnings.push(`${label} has no navgrid node nearby; bots spawned here will wander`);
      for (let j = 0; j < i; j++) {
        const o = list[j];
        if (Math.hypot(p.x - o.x, p.z - o.z) < SPAWN_MIN_GAP && Math.abs(p.y - o.y) < H) out.warnings.push(`${label} is within ${SPAWN_MIN_GAP} m of mission.${side}[${j}]`);
      }
    });
  }
  // 16인방 보조 자리: 진영마다 스폰 + 보조 자리가 CROWD.TEAM(8). 보조 자리도 설 수 있고 구역 밖이어야 한다
  const crowd = missionCrowd(placed, world, col.bounds);
  for (const side of MISSION_SIDES) {
    const list = (crowd && crowd.extra && crowd.extra[side]) || [];
    list.forEach((p, i) => {
      const label = `mission.extra.${side}[${i}]`;
      checkStanding(world, label, p.x, p.y, p.z, out);
      const inside = siteAt(m.sites, p);
      if (inside) out.errors.push(`${label} ${fmt(p.x, p.y, p.z)} is inside site ${inside.id}`);
    });
    if (placed[side].length + list.length < CROWD.TEAM) out.errors.push(`mission.${side}: ${placed[side].length} spawns + ${list.length} crowd spots < ${CROWD.TEAM}; a 16-player room would stack people 1.2 m apart`);
    report[`${side}Crowd`] = list.length;
  }
  const far = col.theme.fog[1];
  const seen = [];
  placed.attack.forEach((a, i) => placed.defense.forEach((b, j) => {
    if (hasEnemySight(world, a, b, far)) seen.push(`attack[${i}] <-> defense[${j}] (${r2(Math.hypot(a.x - b.x, a.z - b.z))} m)`);
  }));
  if (seen.length) out.warnings.push(`line of sight between mission spawns: ${seen.slice(0, 3).join(', ')}${seen.length > 3 ? ` and ${seen.length - 3} more` : ''}`);
  report.los = seen.length;

  // 길: 진영 스폰마다 구역 중심 쪽 걷기 칸까지. 수비가 공격보다 MISSION_LEAD m 이상 가까워야 한다
  for (const { site, target, entry } of sites) {
    for (const side of MISSION_SIDES) {
      const lens = [];
      placed[side].forEach((p, i) => {
        const path = target && nav.findPath(p, target);
        if (!path) { out.errors.push(`mission.${side}[${i}] cannot reach site ${site.id} on the navgrid`); return; }
        lens.push(pathLength(p, path));
      });
      if (lens.length) entry[side] = { min: r1(Math.min(...lens)), avg: r1(lens.reduce((a, b) => a + b, 0) / lens.length), n: lens.length };
    }
    if (entry.attack && entry.defense && entry.defense.min > entry.attack.min - MISSION_LEAD) {
      out.warnings.push(`mission site ${site.id}: defense needs ${entry.defense.min} m and attack ${entry.attack.min} m; defense should be at least ${MISSION_LEAD} m closer`);
    }
    report.sites.push(entry);
  }
  return report;
}

/**
 * 맵 데이터 하나를 검사한다.
 * @returns {{id, strict, ok, errors, warnings, counts, nav, pads, secrets, los, mission}} mission은 checkMission 결과(없으면 null)
 */
export function checkMap(id, data) {
  const strict = !EXEMPT_MAPS.has(id) && (NEW_MAPS.has(id) || Array.isArray(data && data.rulesets));
  const out = { id, strict, ok: false, errors: [], warnings: [], counts: null, nav: null, pads: [], secrets: [], los: 0, mission: null, movers: [] };
  const v = validateMap(data);
  out.errors.push(...v.errors);
  (strict ? out.errors : out.warnings).push(...v.warnings);
  if (!v.ok) return out;

  const col = buildCollision(data);
  const { world, triggers } = col;
  out.counts = {
    solids: data.solids.length, decor: Array.isArray(data.decor) ? data.decor.length : 0,
    pads: triggers.pads.length, portals: triggers.portals.length, secrets: triggers.secrets.length,
    props: Array.isArray(data.props) ? data.props.length : 0, movers: col.movers.list.length,
    owner: col.spawns.owner.length, charterer: col.spawns.charterer.length, ffa: col.spawns.ffa.length
  };

  out.los = checkSpawns(data, col, strict, out);
  out.counts.crowd = EXEMPT_MAPS.has(id) ? null : checkCrowd(col, out);
  const nav = checkWalkability(data, col, out);
  out.nav = { nodes: nav.info.nodes, good: nav.info.good, ms: Math.round(nav.info.buildMs) };
  out.mission = checkMission(data, nav, out, col);
  out.movers = checkMovers(data, col, out);
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
    ['movers', 7, (r) => (r.counts ? r.counts.movers : '-')],
    ['team', 6, (r) => (r.counts ? `${r.counts.owner}/${r.counts.charterer}` : '-')], ['ffa', 4, (r) => (r.counts ? r.counts.ffa : '-')],
    ['nav', 7, (r) => (r.nav ? r.nav.nodes : '-')], ['los', 4, (r) => r.los], ['err', 4, (r) => r.errors.length], ['warn', 4, (r) => r.warnings.length]
  ];
  const line = (cells) => cells.map((c, i) => (i < 2 ? String(c).padEnd(cols[i][1]) : String(c).padStart(cols[i][1]))).join(' ');
  console.log(line(cols.map((c) => c[0])));
  console.log(line(cols.map((c) => '-'.repeat(c[1]))));
  for (const r of reports) console.log(line(cols.map((c) => c[2](r))));
}

/** 폭파 미션 줄: 진영 스폰 수, 구역마다 진영별 최단·평균 경로와 바닥 칸 */
function printMission(m) {
  const crowd = (n) => (n ? ` + 보조 ${n}` : '');
  console.log(`  mission: 공격 스폰 ${m.attack}${crowd(m.attackCrowd)} · 수비 스폰 ${m.defense}${crowd(m.defenseCrowd)}${m.los ? ` · 서로 보이는 쌍 ${m.los}` : ''}`);
  const side = (v) => (v ? `${Math.round(v.min)} m(평균 ${Math.round(v.avg)})` : '길 없음');
  for (const s of m.sites) console.log(`  ${s.id}: 공격 ${side(s.attack)} / 수비 ${side(s.defense)} · 바닥 ${s.nodes}칸 ${s.area} m² · ${s.name}`);
}

function printDetails(reports) {
  for (const r of reports) {
    if (!r.errors.length && !r.warnings.length && !r.pads.length && !r.secrets.length && !r.mission && !r.movers.length) continue;
    console.log(`\n[${r.id}]${r.strict ? ' (new-map rules)' : ''}`);
    for (const p of r.pads) {
      console.log(p.landing
        ? `  pad ${p.index}: lands at (${p.landing.join(', ')})${p.dist === null ? '' : `, ${p.dist} m from target`}, ${p.time} s, top y ${p.top}, ${p.speed} m/s`
        : `  pad ${p.index}: no landing`);
    }
    for (const s of r.secrets) console.log(`  secret ${s.id}: ${s.via ? `via ${s.via}` : 'unreachable'}`);
    if (r.mission) printMission(r.mission);
    for (const m of r.movers) console.log(`  mover ${m.id}: ${m.axis} ${m.dist > 0 ? '+' : ''}${m.dist} m, ${m.period} s cycle (hold ${m.hold} s), peak ${m.speed} m/s`);
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
    if (t.error) return { id: t.id, strict: true, ok: false, errors: [t.error], warnings: [], counts: null, nav: null, pads: [], secrets: [], los: 0, mission: null, movers: [] };
    try {
      return checkMap(t.id, t.data);
    } catch (err) {
      return { id: t.id, strict: true, ok: false, errors: [`checker crashed: ${err && err.stack ? err.stack : err}`], warnings: [], counts: null, nav: null, pads: [], secrets: [], los: 0, mission: null, movers: [] };
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
