/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: ?debug=1 전용 개발 도구. F3 상태 패널, F4 판정 부위 표시, F6 충돌체 와이어프레임을 켜고 끈다.
 *          모두 닫혀 있으면 프레임 비용이 없고, ctx의 일부가 없어도 멈추지 않는다. 사용법은 docs/DEBUGGING.md.
 */
/**
 *   const debug = createDebug(ctx);   // main.js가 ?debug=1일 때만 동적으로 불러서 부른다
 *   debug.dispose();
 *
 * - three.js는 ctx.THREE로 받는다. 그래서 이 파일은 node에서도 import되고, 순수 함수는 tests/log.test.mjs가 검사한다.
 * - F4 선은 consts의 HITBOX를 그대로 그린다. physics.raycastPlayers의 좌표 변환과 같아야 하며 테스트가 이를 확인한다.
 * - ctx는 다른 모듈이 계속 바꾸는 객체다. 어떤 값을 읽든 없을 수 있다고 보고, 패널은 줄마다 오류를 따로 잡는다.
 * - 켜 놓은 동안 ctx.logs(= window.__skalafps.logs)로 로그 버퍼를 읽을 수 있다.
 */
import { HITBOX, HITBOX_CROUCH, PLAYER } from '../core/consts.js';
import { createLogger, getLogs } from '../core/log.js';
import { buildTriggers, padVelocity, PAD_HEIGHT_TOL } from './triggers.js';

const log = createLogger('debug');

const PANEL_INTERVAL = 0.2;     // 패널 글자 갱신 주기(초). 초당 5번
const FRAME_ORDER = 900;        // 아바타 갱신(-50) 뒤, 렌더(1000) 앞
const SPHERE_SEGMENTS = 12;     // 구를 그리는 원 하나의 선분 수
const CYL_SEGMENTS = 16;        // 원통 둘레의 선분 수
const PAD_ARC_SEGMENTS = 20;    // 발판 궤적의 선분 수
const MARKER_SIZE = 0.3;        // 도착 지점 십자 표시의 반지름(m)
const WIRE_INFLATE = 0.015;     // 벽면과 겹쳐 깜빡이지 않게 충돌체 선을 살짝 바깥으로 민다(m)
const MIN_POOL_TARGETS = 16;

/** 판정 부위 색 */
export const PART_COLORS = Object.freeze({ head: '#ff4d4d', body: '#ffd24d', legs: '#4dff7a', hand: '#4dd2ff', foot: '#d07dff' });
/** 충돌체·트리거 색 */
export const WIRE_COLORS = Object.freeze({
  box: '#ffffff', cyl: '#ff9f1c', ramp: '#39ff14', ground: '#55656f', clip: '#ff2d2d', bounds: '#8f4040',
  pad: '#35e0ff', portal: '#ff4dff', secret: '#ffe14d'
});

/** 박스의 12개 모서리를 이루는 꼭짓점 번호 쌍. 번호의 비트: 1 = maxX, 2 = maxZ, 4 = maxY */
const BOX_EDGE_CORNERS = Object.freeze([0, 1, 1, 3, 3, 2, 2, 0, 4, 5, 5, 7, 7, 6, 6, 4, 0, 4, 1, 5, 2, 6, 3, 7]);
const BOX_VERTS = BOX_EDGE_CORNERS.length;
const SPHERE_VERTS = 3 * 2 * SPHERE_SEGMENTS;   // 서로 수직인 원 3개
const SPHERE_CIRCLE = Object.freeze(Array.from({ length: SPHERE_SEGMENTS }, (_, i) => {
  const a = (i / SPHERE_SEGMENTS) * Math.PI * 2;
  return Object.freeze([Math.cos(a), Math.sin(a)]);
}));

/** '#rrggbb' → 선형 RGB. 정점색은 선형 값으로 넣어야 화면에서 적은 색 그대로 나온다 */
function linearRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
}

const mix = (a, b, k) => a + (b - a) * k;

/** 대상의 crouch 값 → 0..1. physics.raycastPlayers와 같은 규칙이다(true = 1, 숫자는 전환 중 비율) */
function crouchRatio(v) {
  if (v === true) return 1;
  const n = +v;
  return n > 0 ? (n >= 1 ? 1 : n) : 0;
}

/**
 * 앉음 비율에 맞춘 판정 부위 목록(발바닥 기준 로컬 좌표, 로컬 -Z = 정면).
 * @returns {object[]} { part, kind:'sphere', x,y,z,r } 또는 { part, kind:'box', minX,maxX,minY,maxY,minZ,maxZ }
 */
export function hitVolumes(crouch) {
  const k = crouchRatio(crouch);
  const S = HITBOX, C = HITBOX_CROUCH;
  const box = (part, s, c) => {
    const hw = mix(s.hw, c.hw, k), hd = mix(s.hd, c.hd, k), cz = mix(s.cz || 0, c.cz || 0, k);
    return { part, kind: 'box', minX: -hw, maxX: hw, minY: mix(s.y0, c.y0, k), maxY: mix(s.y1, c.y1, k), minZ: cz - hd, maxZ: cz + hd };
  };
  const sphere = (part, s, c) => ({ part, kind: 'sphere', x: mix(s.x || 0, c.x || 0, k), y: mix(s.y, c.y, k), z: mix(s.z || 0, c.z || 0, k), r: mix(s.r, c.r, k) });
  return [
    sphere('head', S.HEAD, C.HEAD),
    box('body', S.BODY, C.BODY),
    box('legs', S.LEGS, C.LEGS),
    box('foot', S.FOOT, C.FOOT),
    ...S.HANDS.map((h, i) => sphere('hand', h, C.HANDS[i] || h))
  ];
}

/** 부위 하나가 차지하는 선 꼭짓점 수 */
export function volumeVertexCount(volume) {
  return volume.kind === 'box' ? BOX_VERTS : SPHERE_VERTS;
}

const STANDING_VOLUMES = hitVolumes(0);
const TARGET_VERTS = STANDING_VOLUMES.reduce((sum, v) => sum + volumeVertexCount(v), 0);

/**
 * 대상 하나의 판정 부위 선을 buf(xyz 나열)에 쓴다. 쓰는 순서와 양은 hitVolumes 순서를 따른다.
 * @param {Float32Array|number[]} buf
 * @param {number} offset 쓰기 시작할 배열 위치
 * @param {{pos:number[]|{x,y,z}, yaw?:number, crouch?:boolean|number}} target
 * @returns {number} 다음 쓰기 위치
 */
export function writeTargetLines(buf, offset, target) {
  const p = target.pos;
  const px = p[0] ?? p.x, py = p[1] ?? p.y, pz = p[2] ?? p.z;
  const yaw = target.yaw || 0, cs = Math.cos(yaw), sn = Math.sin(yaw);
  let o = offset;
  // 로컬 → 월드(rotation.y = yaw). physics.raycastPlayers의 월드 → 로컬 변환의 역이다
  const put = (lx, ly, lz) => {
    buf[o++] = px + lx * cs + lz * sn;
    buf[o++] = py + ly;
    buf[o++] = pz - lx * sn + lz * cs;
  };
  for (const v of hitVolumes(target.crouch)) {
    if (v.kind === 'box') {
      for (const i of BOX_EDGE_CORNERS) put(i & 1 ? v.maxX : v.minX, i & 4 ? v.maxY : v.minY, i & 2 ? v.maxZ : v.minZ);
      continue;
    }
    for (let s = 0; s < SPHERE_SEGMENTS; s++) {
      const a = SPHERE_CIRCLE[s], b = SPHERE_CIRCLE[(s + 1) % SPHERE_SEGMENTS];
      put(v.x + a[0] * v.r, v.y, v.z + a[1] * v.r); put(v.x + b[0] * v.r, v.y, v.z + b[1] * v.r);
      put(v.x + a[0] * v.r, v.y + a[1] * v.r, v.z); put(v.x + b[0] * v.r, v.y + b[1] * v.r, v.z);
      put(v.x, v.y + a[0] * v.r, v.z + a[1] * v.r); put(v.x, v.y + b[0] * v.r, v.z + b[1] * v.r);
    }
  }
  return o;
}

/** 대상 capacity명 분량의 정점색 배열. 부위 순서가 고정이라 한 번만 채우면 된다 */
function targetColors(capacity) {
  const colors = new Float32Array(capacity * TARGET_VERTS * 3);
  let o = 0;
  for (let t = 0; t < capacity; t++) {
    for (const v of STANDING_VOLUMES) {
      const rgb = linearRgb(PART_COLORS[v.part]);
      for (let i = volumeVertexCount(v); i > 0; i--) { colors[o++] = rgb[0]; colors[o++] = rgb[1]; colors[o++] = rgb[2]; }
    }
  }
  return colors;
}

/* ---------------- 충돌체 선 (순수 함수) ---------------- */

function addBox(seg, rgb, minX, minY, minZ, maxX, maxY, maxZ) {
  const corner = (i) => [i & 1 ? maxX : minX, i & 4 ? maxY : minY, i & 2 ? maxZ : minZ];
  for (let e = 0; e < BOX_EDGE_CORNERS.length; e += 2) {
    const a = corner(BOX_EDGE_CORNERS[e]), b = corner(BOX_EDGE_CORNERS[e + 1]);
    seg(rgb, a[0], a[1], a[2], b[0], b[1], b[2]);
  }
}

function addCylinder(seg, rgb, c) {
  const r = c.r + WIRE_INFLATE, y0 = c.minY - WIRE_INFLATE, y1 = c.maxY + WIRE_INFLATE;
  const at = (i) => {
    const a = (i / CYL_SEGMENTS) * Math.PI * 2;
    return [c.x + Math.cos(a) * r, c.z + Math.sin(a) * r];
  };
  for (let i = 0; i < CYL_SEGMENTS; i++) {
    const a = at(i), b = at(i + 1);
    seg(rgb, a[0], y0, a[1], b[0], y0, b[1]);
    seg(rgb, a[0], y1, a[1], b[0], y1, b[1]);
    if (i % (CYL_SEGMENTS / 4) === 0) seg(rgb, a[0], y0, a[1], a[0], y1, a[1]);
  }
}

/** 쐐기: 높은 변(hi)에서 maxY, 낮은 변(lo)에서 minY. dir 방향으로 올라간다(physics.rampHeight와 같다) */
function addRamp(seg, rgb, c) {
  const e = WIRE_INFLATE;
  const x0 = c.minX - e, x1 = c.maxX + e, z0 = c.minZ - e, z1 = c.maxZ + e, y0 = c.minY - e, y1 = c.maxY + e;
  let hi, lo;
  if (c.dir === '-x') { hi = [[x0, z0], [x0, z1]]; lo = [[x1, z0], [x1, z1]]; }
  else if (c.dir === '+z') { hi = [[x0, z1], [x1, z1]]; lo = [[x0, z0], [x1, z0]]; }
  else if (c.dir === '-z') { hi = [[x0, z0], [x1, z0]]; lo = [[x0, z1], [x1, z1]]; }
  else { hi = [[x1, z0], [x1, z1]]; lo = [[x0, z0], [x0, z1]]; }   // '+x'
  // 바닥 사각형
  seg(rgb, lo[0][0], y0, lo[0][1], lo[1][0], y0, lo[1][1]);
  seg(rgb, lo[1][0], y0, lo[1][1], hi[1][0], y0, hi[1][1]);
  seg(rgb, hi[1][0], y0, hi[1][1], hi[0][0], y0, hi[0][1]);
  seg(rgb, hi[0][0], y0, hi[0][1], lo[0][0], y0, lo[0][1]);
  // 높은 변의 세로선과 윗선
  seg(rgb, hi[0][0], y0, hi[0][1], hi[0][0], y1, hi[0][1]);
  seg(rgb, hi[1][0], y0, hi[1][1], hi[1][0], y1, hi[1][1]);
  seg(rgb, hi[0][0], y1, hi[0][1], hi[1][0], y1, hi[1][1]);
  // 경사면의 양옆
  seg(rgb, lo[0][0], y0, lo[0][1], hi[0][0], y1, hi[0][1]);
  seg(rgb, lo[1][0], y0, lo[1][1], hi[1][0], y1, hi[1][1]);
}

function addMarker(seg, rgb, x, y, z) {
  const s = MARKER_SIZE;
  seg(rgb, x - s, y, z, x + s, y, z);
  seg(rgb, x, y - s, z, x, y + s, z);
  seg(rgb, x, y, z - s, x, y, z + s);
}

/** 발판 가운데에서 출발하는 궤적. target이 있으면 그 높이까지, 없으면 출발 높이로 돌아올 때까지 */
function addPadArc(seg, rgb, pad) {
  const v = pad.target ? padVelocity([pad.x, pad.y, pad.z], pad.target, pad.apex) : pad.vel;
  if (!v) return;
  const g = Math.abs(PLAYER.GRAVITY);
  const endY = pad.target ? pad.target[1] : pad.y;
  const time = (v[1] + Math.sqrt(Math.max(0, v[1] * v[1] + 2 * g * (pad.y - endY)))) / g;
  let ax = pad.x, ay = pad.y, az = pad.z;
  for (let i = 1; i <= PAD_ARC_SEGMENTS; i++) {
    const t = (time * i) / PAD_ARC_SEGMENTS;
    const bx = pad.x + v[0] * t, by = pad.y + v[1] * t - 0.5 * g * t * t, bz = pad.z + v[2] * t;
    seg(rgb, ax, ay, az, bx, by, bz);
    ax = bx; ay = by; az = bz;
  }
  if (pad.target) addMarker(seg, rgb, pad.target[0], pad.target[1], pad.target[2]);
}

function colliderColorName(c) {
  if (c.tag === 'ground' || c.tag === 'clip' || c.tag === 'bounds') return c.tag;
  return c.kind === 'cyl' || c.kind === 'ramp' ? c.kind : 'box';
}

/**
 * 충돌체와 트리거를 선 하나로 합친 배열을 만든다.
 * @param {object[]} colliders map.colliders
 * @param {{pads?:object[], portals?:object[], secrets?:object[]}} [triggers] world.triggers 또는 buildTriggers 결과
 * @returns {{positions:Float32Array, colors:Float32Array, counts:object}} counts는 WIRE_COLORS 이름별 개수
 */
export function buildWireLines(colliders, triggers) {
  const positions = [], colors = [];
  const counts = Object.fromEntries(Object.keys(WIRE_COLORS).map((name) => [name, 0]));
  const rgbOf = Object.fromEntries(Object.entries(WIRE_COLORS).map(([name, hex]) => [name, linearRgb(hex)]));
  const seg = (rgb, ax, ay, az, bx, by, bz) => {
    positions.push(ax, ay, az, bx, by, bz);
    colors.push(rgb[0], rgb[1], rgb[2], rgb[0], rgb[1], rgb[2]);
  };
  const e = WIRE_INFLATE;
  for (const c of colliders || []) {
    if (!c) continue;
    const name = colliderColorName(c);
    counts[name]++;
    if (c.kind === 'cyl') addCylinder(seg, rgbOf[name], c);
    else if (c.kind === 'ramp') addRamp(seg, rgbOf[name], c);
    else addBox(seg, rgbOf[name], c.minX - e, c.minY - e, c.minZ - e, c.maxX + e, c.maxY + e, c.maxZ + e);
  }
  for (const pad of (triggers && triggers.pads) || []) {
    counts.pad++;
    // 발동 범위: 사각형 안에서 발 높이 차가 PAD_HEIGHT_TOL 이내
    addBox(seg, rgbOf.pad, pad.minX, pad.y - PAD_HEIGHT_TOL, pad.minZ, pad.maxX, pad.y + PAD_HEIGHT_TOL, pad.maxZ);
    addPadArc(seg, rgbOf.pad, pad);
  }
  for (const portal of (triggers && triggers.portals) || []) {
    counts.portal++;
    addBox(seg, rgbOf.portal, portal.minX, portal.minY, portal.minZ, portal.maxX, portal.maxY, portal.maxZ);
    if (portal.to) {
      seg(rgbOf.portal, portal.x, (portal.minY + portal.maxY) / 2, portal.z, portal.to.x, portal.to.y, portal.to.z);
      addMarker(seg, rgbOf.portal, portal.to.x, portal.to.y, portal.to.z);
    }
  }
  for (const secret of (triggers && triggers.secrets) || []) {
    counts.secret++;
    addBox(seg, rgbOf.secret, secret.minX, secret.minY, secret.minZ, secret.maxX, secret.maxY, secret.maxZ);
  }
  return { positions: new Float32Array(positions), colors: new Float32Array(colors), counts };
}

/* ---------------- 키 ---------------- */

const NON_TEXT_INPUTS = new Set(['button', 'checkbox', 'color', 'file', 'image', 'radio', 'range', 'reset', 'submit']);

/** 이 요소에 포커스가 있으면 키 입력은 그 요소 몫이다. SELECT는 F4가 목록을 여는 키라 함께 뺀다 */
export function isTextEntry(el) {
  if (!el || !el.tagName) return false;
  const tag = String(el.tagName).toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') return !NON_TEXT_INPUTS.has(String(el.type || 'text').toLowerCase());
  return !!el.isContentEditable;
}

/* ---------------- 패널 글자 도우미 ---------------- */

const fix = (v, digits = 2) => (Number.isFinite(v) ? v.toFixed(digits) : '-');
const cell = (v, digits = 2) => fix(v, digits).padStart(8);
const vec3Text = (a) => (a ? [a[0], a[1], a[2]].map((v) => cell(v)).join('') : '-');
const degrees = (rad) => (Number.isFinite(rad) ? (rad * 180) / Math.PI : NaN);
const grouped = (n) => (Number.isFinite(n) ? n.toLocaleString('en-US') : '-');
const kilobytes = (bytes) => (Number.isFinite(bytes) ? `${(bytes / 1024).toFixed(1)}kB` : '-');
const orDash = (v) => (v === undefined || v === null || v === '' ? '-' : String(v));
const LABEL_WIDTH = 8;
const row = (label, text) => label.padEnd(LABEL_WIDTH) + text;

function zoomText(z) {
  if (!z) return '-';
  const level = z.level ?? (z.zoomed ? 1 : 0);
  const levels = z.levels ?? (z.mag > 1 ? 1 : 0);
  return `${level}/${levels} x${fix(z.curMag ?? z.mag, 1)}`;
}

function debugFlagIn(search) {
  const query = new URLSearchParams(search || '');
  return query.has('debug') && query.get('debug') !== '0';
}

/* ---------------- 본체 ---------------- */

/**
 * 디버그 도구를 만든다. ?debug=1이 아니거나 DOM이 없으면 아무 일도 하지 않는 객체를 돌려준다.
 * @param {object} ctx main.js의 ctx
 * @returns {{dispose:()=>void}}
 */
export function createDebug(ctx) {
  const noop = { dispose() {} };
  if (typeof window === 'undefined' || typeof document === 'undefined') return noop;
  const enabled = ctx && ctx.flags ? !!ctx.flags.debug : debugFlagIn(globalThis.location && globalThis.location.search);
  if (!enabled || !ctx) return noop;

  const warned = new Set();
  const warnOnce = (key, ...args) => { if (!warned.has(key)) { warned.add(key); log.warn(...args); } };
  const busOffs = [];

  let disposed = false;
  let offFrame = null;
  let panel = null;       // F3이 켜져 있으면 { root, text, time, frames, maxDt, shown }
  let hit = null;         // F4가 켜져 있으면 { THREE, lines, material, capacity, positions, targets }
  let wire = null;        // F6이 켜져 있으면 { THREE, scene, lines, material, map, counts }
  let lastTrigger = null; // 마지막으로 발동한 트리거 { label, pos, at }

  /* ---------- ctx 읽기 ---------- */
  const gameApi = () => {
    const list = ctx.plugins;
    const game = Array.isArray(list) ? list.find((p) => p && p.name === 'game') : null;
    return (game && game.api) || null;
  };
  const multiSession = () => globalThis.__skalafpsSession || null;
  const threeKit = () => {
    const THREE = ctx.THREE, scene = ctx.renderer && ctx.renderer.scene;
    return THREE && scene ? { THREE, scene } : null;
  };

  /* ---------- 패널 줄 ---------- */
  const rowTitle = () => {
    const hitText = hit ? `켬(대상 ${hit.targets})` : '끔';
    const wireText = wire ? `켬(선 ${wire.lines ? grouped(wire.lines.geometry.attributes.position.count / 2) : 0})` : '끔';
    return `디버그  F3 패널  F4 판정 ${hitText}  F6 충돌체 ${wireText}`;
  };
  const rowPerf = () => {
    const seconds = panel.time, frames = panel.frames;
    const fps = seconds > 0 && frames > 0 ? frames / seconds : ctx.loop && ctx.loop.fps;
    const frameMs = frames > 0 ? (seconds / frames) * 1000 : NaN;
    return row('fps', `${fix(fps, 1)}  frame ${fix(frameMs, 1)}ms  max ${fix(panel.maxDt * 1000, 1)}ms`);
  };
  const rowDraw = () => {
    const r = ctx.renderer;
    const info = (r && r.three && r.three.info) || (r && typeof r.info === 'function' ? r.info() : null);
    if (!info || !info.render) return row('draw', '-');
    const mem = info.memory || {};
    return row('draw', `${grouped(info.render.calls)} calls  ${grouped(info.render.triangles)} tris  geo ${orDash(mem.geometries)}  tex ${orDash(mem.textures)}`);
  };
  const rowPos = () => {
    const s = ctx.player && ctx.player.state;
    if (!s) return row('pos', '-');
    return row('pos', `${vec3Text(s.pos)}  yaw ${fix(degrees(s.yaw), 1)}  pitch ${fix(degrees(s.pitch), 1)}`);
  };
  const rowVel = () => {
    const s = ctx.player && ctx.player.state;
    if (!s) return row('vel', '-');
    const speed = s.vel ? Math.hypot(s.vel[0], s.vel[2]) : NaN;
    return row('vel', `${vec3Text(s.vel)}  speed ${fix(speed)}`);
  };
  const rowState = () => {
    const s = ctx.player && ctx.player.state;
    if (!s) return row('state', '-');
    return row('state', `onGround=${orDash(s.onGround)}  crouch=${orDash(s.crouch)}  hp=${orDash(s.hp)}  alive=${orDash(s.alive)}`);
  };
  const rowWeapon = () => {
    const world = gameApi() && gameApi().world;
    const arsenal = world && world.internals && world.internals.arsenal;
    const fov = ctx.renderer && ctx.renderer.getFov ? ctx.renderer.getFov() : NaN;
    if (arsenal) {
      const w = arsenal.getWeapon ? arsenal.getWeapon() : null;
      const z = arsenal.getZoom ? arsenal.getZoom(ctx.renderer && ctx.renderer.baseFov) : null;
      return row('weapon', `${orDash(w && w.id)}  slot ${orDash(w && w.slot)}  ${orDash(w && w.state)}  zoom ${zoomText(z)}  fov ${fix(fov, 1)}`);
    }
    const s = ctx.player && ctx.player.state;
    return row('weapon', `${orDash(s && s.weapon)}  slot ${orDash(s && s.slot)}  zoom -  fov ${fix(fov, 1)}`);
  };
  const rowMap = () => {
    const m = ctx.map;
    if (!m) return row('map', '-');
    const st = m.stats || {};
    const colliders = st.colliders ?? (m.colliders && m.colliders.length);
    const trig = (m.world && m.world.triggers) || m.data || {};
    const size = (list) => (Array.isArray(list) ? list.length : 0);
    return [
      row('map', `${orDash(m.id)}  solids ${orDash(st.solids)}  colliders ${orDash(colliders)}  calls ${orDash(st.drawCalls)}  tris ${grouped(st.triangles)}  lights ${orDash(st.lights)}`),
      row('', `pads ${size(trig.pads)}  portals ${size(trig.portals)}  secrets ${size(trig.secrets)}`)
    ].join('\n');
  };
  const rowRules = () => {
    const game = gameApi(), world = game && game.world;
    const run = game && game.practice && game.practice.run;
    const room = multiSession() && multiSession().room;
    const ruleset = (world && world.ruleset) ?? (run && run.opts && run.opts.ruleset) ?? (run && run.match && run.match.rules && run.match.rules.ruleset)
      ?? (room && room.meta && room.meta.ruleset);
    const mode = (world && world.mode) ?? (run && run.mode);
    return row('rules', `ruleset ${orDash(ruleset)}  mode ${orDash(mode)}  screen ${orDash(ctx.screen)}`);
  };
  /** 조준선이 지금 무엇을 맞히는지. 부위 판정을 볼 때 F4 선 색과 비교한다 */
  const rowAim = () => {
    const p = ctx.player;
    if (!p || !p.getEye || !p.getAimDir || typeof ctx.traceShot !== 'function' || !ctx.map) return row('aim', '-');
    const res = ctx.traceShot(p.getEye(), p.getAimDir(), 1000, { ignoreId: p.state && p.state.id });
    if (!res || res.kind === 'none') return row('aim', '없음');
    if (res.kind === 'player') return row('aim', `player ${orDash(res.id)}  part ${orDash(res.part)}  dist ${fix(res.dist)}`);
    const c = res.collider;
    const where = c ? `${orDash(c.kind)}${c.index >= 0 ? ` solids[${c.index}]` : ''}${c.tag ? ` ${c.tag}` : ''}` : '바닥';
    return row('aim', `world ${where}  mat ${orDash(res.mat)}  dist ${fix(res.dist)}`);
  };
  const rowTrigger = () => {
    if (!lastTrigger) return row('trigger', '-');
    const ago = (performance.now() - lastTrigger.at) / 1000;
    return row('trigger', `${lastTrigger.label}  ${fix(ago, 1)}초 전  at${vec3Text(lastTrigger.pos)}`);
  };
  const rowNet = () => {
    const net = ctx.net || (multiSession() && multiSession().net);
    const s = net && typeof net.stats === 'function' ? net.stats() : null;
    if (!s) return null;
    const room = s.room ? `  room ${orDash(s.room.rate)}/s dropped ${orDash(s.room.dropped)}` : '';
    return row('net', `${orDash(s.state)}  rtt ${fix(s.rtt, 0)}ms  in ${grouped(s.framesIn)}f ${kilobytes(s.bytesIn)}  out ${grouped(s.framesOut)}f ${kilobytes(s.bytesOut)}${room}`);
  };
  const rowSync = () => {
    const sync = ctx.sync || (multiSession() && multiSession().sync);
    const s = sync && typeof sync.stats === 'function' ? sync.stats() : null;
    if (!s) return null;
    const recv = s.recv || {}, sent = s.sent || {};
    return row('sync', `host=${orDash(s.isHost)}  players ${orDash(s.players)}  turn ${fix(sent.turnsPerSec, 1)}/s  in ${kilobytes(recv.bytesPerSec)}/s  out ${kilobytes(sent.bytesPerSec)}/s  events ${fix(s.estEventsPerSec, 0)}/s`);
  };
  const rowWire = () => {
    if (!wire || !wire.counts) return null;
    return row('wire', Object.entries(wire.counts).map(([name, count]) => `${name} ${count}`).join('  '));
  };
  const PANEL_ROWS = [rowTitle, rowPerf, rowDraw, rowPos, rowVel, rowState, rowWeapon, rowMap, rowRules, rowAim, rowTrigger, rowNet, rowSync, rowWire];

  function panelText() {
    const lines = [];
    for (const build of PANEL_ROWS) {
      try {
        const text = build();
        if (text) lines.push(text);
      } catch (err) {
        lines.push(`읽기 실패: ${(err && err.message) || err}`);
      }
    }
    return lines.join('\n');
  }

  /* ---------- F3 패널 ---------- */
  function openPanel() {
    const root = document.createElement('div');
    root.className = 'skala-debug-panel';
    Object.assign(root.style, {
      position: 'fixed', left: '8px', top: '8px', zIndex: '2147483000', padding: '6px 8px', borderRadius: '4px',
      background: 'rgba(6, 12, 20, 0.78)', color: '#d7e6f2', font: "12px/1.35 Consolas, 'D2Coding', 'Courier New', monospace",
      pointerEvents: 'none', userSelect: 'none', maxWidth: 'calc(100vw - 16px)', overflow: 'hidden'
    });
    const text = document.createElement('pre');
    Object.assign(text.style, { margin: '0', font: 'inherit', whiteSpace: 'pre' });
    const legend = document.createElement('div');
    Object.assign(legend.style, { marginTop: '4px', whiteSpace: 'nowrap' });
    for (const colors of [PART_COLORS, WIRE_COLORS]) {
      const line = document.createElement('div');
      for (const [name, color] of Object.entries(colors)) {
        const item = document.createElement('span');
        item.textContent = name;
        Object.assign(item.style, { color, marginRight: '8px' });
        line.append(item);
      }
      legend.append(line);
    }
    root.append(text, legend);
    ((ctx.ui && ctx.ui.app) || document.body).append(root);
    panel = { root, text, time: 0, frames: 0, maxDt: 0, shown: '' };
    refreshPanel();
  }

  function refreshPanel() {
    const next = panelText();
    if (next !== panel.shown) { panel.shown = next; panel.text.textContent = next; }
    panel.time = 0; panel.frames = 0; panel.maxDt = 0;
  }

  function closePanel() {
    panel.root.remove();
    panel = null;
  }

  /* ---------- F4 판정 부위 ---------- */
  function openHit() {
    const kit = threeKit();
    if (!kit) { warnOnce('hit', 'F4: ctx.THREE 또는 renderer.scene이 없어 켤 수 없어요'); return; }
    const { THREE, scene } = kit;
    // 몸 메시 안쪽에 있는 선이므로 깊이 검사를 끄고 맨 마지막에 그린다
    const material = new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, depthWrite: false, transparent: true, fog: false, toneMapped: false });
    const lines = new THREE.LineSegments(new THREE.BufferGeometry(), material);
    lines.name = 'debug:hit-volumes';
    lines.frustumCulled = false;
    lines.renderOrder = 9000;
    scene.add(lines);
    hit = { THREE, lines, material, capacity: 0, positions: null, targets: 0 };
    updateHit();
  }

  /** 대상 수가 용량을 넘을 때만 지오메트리를 다시 만든다. 그 외에는 같은 버퍼를 계속 쓴다 */
  function reserveHit(count) {
    if (count <= hit.capacity) return;
    const { THREE } = hit;
    hit.capacity = Math.max(count, hit.capacity * 2, MIN_POOL_TARGETS);
    hit.positions = new Float32Array(hit.capacity * TARGET_VERTS * 3);
    const geometry = new THREE.BufferGeometry();
    const attribute = new THREE.BufferAttribute(hit.positions, 3);
    attribute.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', attribute);
    geometry.setAttribute('color', new THREE.BufferAttribute(targetColors(hit.capacity), 3));
    hit.lines.geometry.dispose();
    hit.lines.geometry = geometry;
  }

  function updateHit() {
    const targets = typeof ctx.getTargets === 'function' ? ctx.getTargets() : (ctx.avatars && ctx.avatars.getTargets ? ctx.avatars.getTargets() : []);
    const list = Array.isArray(targets) ? targets : [];
    reserveHit(list.length);
    let o = 0, shown = 0;
    for (const target of list) {
      if (!target || !target.pos || target.alive === false) continue;   // raycastPlayers가 건너뛰는 대상
      o = writeTargetLines(hit.positions, o, target);
      shown++;
    }
    hit.targets = shown;
    const geometry = hit.lines.geometry;
    geometry.setDrawRange(0, shown * TARGET_VERTS);
    if (geometry.attributes.position) geometry.attributes.position.needsUpdate = true;
  }

  function closeHit() {
    hit.lines.removeFromParent();
    hit.lines.geometry.dispose();
    hit.material.dispose();
    hit = null;
  }

  /* ---------- F6 충돌체 ---------- */
  function openWire() {
    const kit = threeKit();
    if (!kit) { warnOnce('wire', 'F6: ctx.THREE 또는 renderer.scene이 없어 켤 수 없어요'); return; }
    wire = { ...kit, lines: null, material: new kit.THREE.LineBasicMaterial({ vertexColors: true, fog: false, toneMapped: false }), map: undefined, counts: null };
    syncWire();
  }

  function removeWireLines() {
    if (!wire.lines) return;
    wire.lines.removeFromParent();
    wire.lines.geometry.dispose();
    wire.lines = null;
    wire.counts = null;
  }

  /** 맵이 바뀌면 선을 다시 만든다(맵 로드·해제를 따로 듣지 않고 프레임마다 비교) */
  function syncWire() {
    const map = ctx.map || null;
    if (wire.map === map) return;
    wire.map = map;
    removeWireLines();
    if (!map) return;
    const { THREE, scene } = wire;
    const triggers = (map.world && map.world.triggers) || buildTriggers(map.data);
    const data = buildWireLines(map.colliders || (map.world && map.world.colliders) || [], triggers);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(data.colors, 3));
    const lines = new THREE.LineSegments(geometry, wire.material);
    lines.name = 'debug:colliders';
    lines.frustumCulled = false;
    scene.add(lines);
    wire.lines = lines;
    wire.counts = data.counts;
  }

  function closeWire() {
    removeWireLines();
    wire.material.dispose();
    wire = null;
  }

  /* ---------- 프레임: 무언가 열려 있는 동안에만 구독한다 ---------- */
  function onFrame(dt) {
    if (disposed) return;
    try {
      if (hit) updateHit();
      if (wire) syncWire();
      if (panel) {
        panel.time += dt > 0 ? dt : 0;
        panel.frames++;
        if (dt > panel.maxDt) panel.maxDt = dt;
        if (panel.time >= PANEL_INTERVAL) refreshPanel();
      }
    } catch (err) {
      warnOnce('frame', '프레임 갱신 실패', err);
    }
  }

  function subscribeFrame() {
    if (typeof ctx.onFrame === 'function') return ctx.onFrame(onFrame, FRAME_ORDER);
    if (ctx.loop && typeof ctx.loop.onFrame === 'function') return ctx.loop.onFrame(onFrame, FRAME_ORDER);
    let raf = 0, last = performance.now();
    const tick = (now) => {
      raf = requestAnimationFrame(tick);
      onFrame(Math.min(0.25, (now - last) / 1000));
      last = now;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }

  function syncFrameHook() {
    const needed = !!(panel || hit || wire);
    if (needed && !offFrame) offFrame = subscribeFrame();
    else if (!needed && offFrame) { offFrame(); offFrame = null; }
  }

  /* ---------- 키 ---------- */
  function toggle(isOpen, open, close) {
    try {
      if (isOpen) close(); else open();
      syncFrameHook();
    } catch (err) {
      warnOnce('toggle', '디버그 도구를 켜거나 끄지 못했어요', err);
    }
  }
  function onKeyDown(e) {
    let action = null;
    if (e.code === 'F3') action = () => toggle(!!panel, openPanel, closePanel);
    else if (e.code === 'F4') action = () => toggle(!!hit, openHit, closeHit);
    else if (e.code === 'F6') action = () => toggle(!!wire, openWire, closeWire);
    if (!action) return;
    if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;   // Alt+F4, Shift+F3 등은 브라우저 몫
    if (isTextEntry(e.target)) return;
    e.preventDefault();
    if (!e.repeat) action();
  }
  const KEY_LISTEN = { capture: true };
  window.addEventListener('keydown', onKeyDown, KEY_LISTEN);

  /* ---------- 트리거 기록: 이벤트가 있을 때만 불리므로 닫혀 있어도 비용이 없다 ---------- */
  function noteTrigger(label, event) {
    const p = event && event.pos;   // 플레이어 위치 배열이 그대로 올 수 있으므로 값을 복사한다
    lastTrigger = { label, pos: p ? [p[0] ?? p.x, p[1] ?? p.y, p[2] ?? p.z] : null, at: performance.now() };
  }
  if (ctx.bus && typeof ctx.bus.on === 'function') {
    const indexText = (item) => (item && item.index !== undefined ? `#${item.index}` : '');
    busOffs.push(ctx.bus.on('player:pad', (e) => noteTrigger(`pad${indexText(e && e.pad)}`, e)));
    busOffs.push(ctx.bus.on('player:portal', (e) => noteTrigger(`portal${indexText(e && e.portal)}`, e)));
    busOffs.push(ctx.bus.on('player:secret', (e) => noteTrigger(`secret ${orDash(e && e.secret && e.secret.id)}`, e)));
  }

  /* ---------- window.__skalafps.logs ---------- */
  let ownsLogs = false;
  if (!('logs' in ctx)) {
    try {
      Object.defineProperty(ctx, 'logs', { configurable: true, get: getLogs });
      ownsLogs = true;
    } catch (err) {
      warnOnce('logs', 'ctx.logs를 만들지 못했어요', err);
    }
  }

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      window.removeEventListener('keydown', onKeyDown, KEY_LISTEN);
      for (const off of busOffs) { try { off(); } catch (err) { /* 이미 해제됨 */ } }
      busOffs.length = 0;
      if (offFrame) { offFrame(); offFrame = null; }
      if (panel) closePanel();
      if (hit) closeHit();
      if (wire) closeWire();
      if (ownsLogs) delete ctx.logs;
    }
  };
}
