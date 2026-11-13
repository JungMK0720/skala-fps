/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 시나리오 15. 맵 둘러보기. 새 맵 열다섯을 코어만 띄워(?plugins=0) 카메라를 스폰, 발판, 포털, 비밀 스팟, 골목, 폭파 구역, 움직이는 지형(문 포함)마다 옮겨 사진을 남긴다.
 *          기하와 분위기를 눈으로 볼 때 쓴다. 사용법: npm run qa -- --only maps [--filter dojo 또는 dojo/pad 또는 rooftop,glasshouse]
 */
import { MAPS } from '../../../js/maps/index.js';
import { buildCollision } from '../../../js/maps/collision.js';
import { getGroundY, lineOfSight, overlapsCapsule } from '../../../js/engine/physics.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { qaInit, richProfile, sleep } from '../kit.mjs';

const MAP_IDS = ['rooftop', 'glasshouse', 'dojo', 'longshot', 'nexus', 'alley', 'relay', 'railyard', 'observatory', 'cqb', 'sorthub', 'lot', 'schoolyard', 'karaoke', 'hanok', 'restarea', 'subway'];
const SHEET = { cols: 2, rows: 3, w: 480, h: 270 };
const DOWN = -Math.PI / 2 + 0.002;

/** 발 높이 y에 서서 (lx, ly, lz)를 보는 시점 */
const view = (name, x, y, z, lx, ly, lz, extra = {}) => ({ name, x, y, z, look: [lx, ly, lz], ...extra });
/** 발 높이 y에 서서 rotY 방향을 보는 시점 */
const facing = (name, x, y, z, rotY, extra = {}) => ({ name, x, y, z, yaw: rotY, pitch: 0, ...extra });
/** 하늘에서 내려다보는 시점. 안개를 걷는다 */
const air = (name, x, y, z, lx, ly, lz) => view(name, x, y, z, lx, ly, lz, { clear: true });

/* ---------------- 맵마다 직접 고른 자리 ---------------- */

const HAND = {
  rooftop: [
    view('bay-west', -8.6, 0, -10.6, -3, 1.6, -7),
    view('ac-steps', -5.6, 0, -8.6, -3.15, 1.6, -10.4),
    view('yard-sheets', 0, 0, -7.8, 0, 1.6, -2),
    view('yard-to-west', 2.5, 0, -6, -8, 1.4, -3),
    view('lane-west', -6.8, 0, -4.8, -6.5, 1.6, 4),
    view('jar-terrace', -6.4, 0, -0.2, -9.5, 1, -3),
    view('room-door', -6, 0, -0.9, -3, 1.6, -0.9),
    view('room-in', -2.5, 0, -0.9, 2.5, 1.3, 0.9),
    view('bench-east', 4.2, 0, -4.2, 9, 1, -3.7),
    view('tank-east', 4, 0, 0.8, 7, 1.4, -2),
    view('loft', 0.4, 3.04, -9.4, 0, 2, 4),
    view('city-east', 9.4, 0, -10.6, 26, 3, -14)
  ],
  glasshouse: [
    view('shed-in', -10.6, 0, -3.2, -10.1, 1.4, -6),
    view('north-door', -10.1, 0, -5.6, 0, 1.6, -5.2),
    view('bed', -8.2, 0, -6.4, 0, 1.6, -6.2),
    view('aisle-north', -11, 0, -8.4, 11, 1.6, -8.4),
    view('deck', -3, 0.45, -0.2, 3, 1.6, 0),
    view('round-pot', -8, 0, 2.8, -6, 1.2, 0),
    view('benches', -8.2, 0, 6.6, 0, 1, 6.3),
    view('center-cross', -3.8, 0, -4.4, 4, 1.6, 4.4),
    view('loft', -10, 2.75, 2.6, 0, 1.4, 0),
    view('glass-out', -4, 0, -8.6, -4, 2.4, -24)
  ],
  dojo: [
    view('court-n-pagoda', 0, 0.03, -11, 0, 3, 0),
    view('court-corner-ne', 9.5, 0.03, -9.5, -6, 1.6, 6),
    view('court-east', 11.2, 0.03, 1.8, -2, 2, 0),
    view('pagoda-door', 0, 0.43, -3.1, 0, 1.6, 2),
    view('pagoda-corridor', -2.5, 0.43, -2.5, -2.5, 1.6, 2.5),
    view('walk-n-east', -11, 0.6, -12.5, 11, 1.6, -12.5),
    view('walk-e-south', 12.5, 0.6, -10, 12.5, 1.6, 2),
    view('hall-mid', 0, 0.6, -18.8, 0, 1.6, -14),
    view('hall-west-room', -8, 0.6, -19, -3, 1.6, -19),
    view('corner-room-ne', 15.2, 0.6, -16.4, 20, 1.6, -17),
    view('corner-room-back', 16.5, 0.6, -19.8, 20.5, 1.6, -19.8),
    view('yard-east', 19, 0, -10, 15, 2, -7),
    view('gallery-east', -9, 4.7, -17.5, 9, 5.5, -17.5),
    view('gallery-view', 0, 4.7, -15.8, 0, 3, 0),
    view('store-west', -15.8, 0, 0, -17, 1.6, 0),
    view('bamboo-east', 15, 0, 3, 17, 2, 0),
    view('roof-view', 0, 8.2, -2.8, 0, 4, -12)
  ],
  longshot: [
    view('base-lookout', -47.5, 7, 3.5, 60, 2, 3.5),
    view('base-rail', -46, 7, 0, 60, 3, 0),
    view('base-court', -60, 7, 0, -50, 8, 0),
    view('lane-mid-west', -40, 0, 0, 40, 2, 0),
    view('lane-mid-center', -3, 0, 2.5, 40, 2, -1),
    view('lane-low-eye', -30, 0, -2, 30, 2, 2),
    view('ridge-walk', -36, 4, -21.5, 10, 5, -21.5),
    view('ridge-scaffold', -27, 4, -21, -10, 5, -21),
    view('ridge-plaza', -3, 0, -20, 20, 2, -18),
    view('wash-west', -41, -1.5, 17.6, -8, 0, 19),
    view('wash-exit', -10, -1.5, 18.5, 10, 2, 18),
    view('tunnel-west-in', -27, 0, -11, -15, 1.6, -11),
    view('tunnel-mid', -9, 0, -11, 5, 1.6, -11),
    view('tunnel-east-out', 3, 0, -10.8, 5, 1.6, -14),
    view('nest-slit', -24.4, 13, 10, 40, 3, 5),
    view('canyon-wall', -10, 0, 8, -10, 8, -30),
    view('arch-under', -20, 0, 0, 0, 12, 0)
  ],
  nexus: [
    view('pit-rim-west', -18, 0, 0, 0, -1, 0),
    view('pit-floor', -8, -2, 0, 8, 0, 0),
    view('pit-stairs', 0, -2, -6, 0, 0, -12),
    view('plaza-west', -30, 0, 0, -12, 3, 0),
    view('catwalk-west', -28, 6.6, -4, 0, 7, -4),
    view('catwalk-bridge', -31, 6.6, -26, -31, 7, -8),
    view('hub', 0, 6.6, -4.5, 20, 7, 4),
    view('block-room', -20, 0, -19, -8, 1.6, -19),
    view('block-lane', -24, 0, -24, -4, 1.6, -24),
    view('block-yard', 5, 0, -30, 26, 1.6, -30),
    view('block-roof', -20, 4.2, -19, 20, 5, -19),
    view('tower-ground', -39, 0, -26, -33.5, 1.6, -26),
    view('tower-mid', -37, 6.6, -26, -33, 7.5, -26),
    view('tower-top', -36, 10.4, -25, 20, 8, 10),
    view('tower-canopy', -41, 13.2, -28, 0, 16, 0),
    view('annex-roof', 37, 6.6, -29, 0, 7, 0),
    view('core-room', 0, -6.4, -4.2, 0, -4.5, 3)
  ],
  alley: [
    view('yard-west', -25, 0, -2, -20, 3, -2),
    view('lane-n', -19, 0, -12, -8, 1.6, -12),
    view('lane-mid', -19, 0, -3, -9, 1.6, -3),
    view('lane-s', -19, 0, 7, -11, 1.6, 7),
    view('link', -13, 0, -9.5, -13, 1.6, -5),
    view('bend', -11, 0, -3, -8, 1.6, 1),
    view('square-west', -5, 0, 0, 5, 3, 0),
    view('square-north', 0, 0, -4.8, 0, 6, 3),
    view('lane-side', -13, 0, 6, -13, 1.6, 15),
    view('quay', -13, 0, 15.3, -6, 1.6, 15.3),
    view('quay-sea', -10, 0, 16.5, -10, 1, 30),
    view('backyard', -9, 0, 7, -2, 1.6, 7),
    view('north-gate', -9, 0, -12, -4, 1.6, -9),
    view('north-entry', -4, 0, -13, -4, 1.6, -4),
    view('roof-run', -19, 5, -16, -3, 5.8, -16)
  ],
  relay: [
    air('overview', -10, 44, 36, 6, 0, -2),
    air('sites-air', -2, 28, 0, 16, 0, 0),
    view('spawn-attack', -35.5, 0, 0, -27.6, 1.6, 0),
    view('spawn-defense', 35, 0, 0, 27.5, 1.6, -5.6),
    view('lane-ridge', -26, 0, -19.6, 8, 2.5, -20.5),
    view('lane-ridge-end', -2, 0, -19, 8, 3, -20.5),
    view('lane-mid-road', -26, 0, 1, -4, 2, 0),
    view('mid-court', -8, 0, 4, 8, 2.5, -6),
    view('mid-deck', -3, 1.83, -0.5, 8, 2, 0),
    view('court-a-door', 1, 0, -6, 8, 3.5, -9.2),
    view('court-b-door', 0, 0, 4.5, 8, 2.4, 12),
    view('tunnel-west', -27, 0, 17, -12, 1.6, 17),
    view('switchyard', -11, 0, 17.2, -4, 1.6, 21),
    view('tunnel-east', -3.5, 0, 17, 8, 1.6, 17),
    view('site-a-ridge-door', 9, 0.3, -20.5, 15, 1.6, -15),
    view('site-a-inside', 10, 0.3, -11, 18, 1.4, -18),
    view('site-a-back', 20, 0.3, -21, 10, 2, -13),
    view('site-b-tunnel-exit', 9, 0, 17, 20, 2, 15),
    view('site-b-inside', 10, 0, 9.5, 18, 1.8, 18),
    view('site-b-mast', 12.5, 0, 21, 18.5, 14, 21.9),
    view('rotation', 24, 0, -17, 24, 1.6, 17),
    view('mid-link', 9, 0, 0, 21, 1.6, 0)
  ],
  lot: [
    view('base-exit', -15.4, 0, -2, -13, 1.6, -9),
    view('field-from-north-exit', -12.5, 0, -9.5, 0, 1.4, -2),
    view('pipes', -11.5, 0, -4.8, -8, 1.2, -8),
    view('mound-foot-west', -7.6, 0, 0.4, 0, 1.4, 0),
    view('mound-top', 0, 1, 0, 12, 1.2, -6),
    view('truck-rear', -1.2, 0, 8, -8, 1.6, 8),
    view('truck-bed', -4.4, 1.2, 8, -9, 2.2, 8),
    view('south-fence', 0, 0, 11, -10, 1.4, 6)
  ],
  schoolyard: [
    view('base-exit', -18.1, 0, -2, -15, 1.6, -8),
    view('field-from-shed', -12.9, 0, -6.5, 4, 1.4, 0),
    view('goal', -6.5, 0, 0, -13, 1.4, 0),
    view('jungle-gym', -11.6, 0, -9.6, -8, 1.3, -6.5),
    view('podium-stairs', -8.6, 0, -11.2, -2, 1.6, -11.4),
    view('podium-top', 0, 1, -11.4, 0, 1, 6),
    view('stands-top', 0, 1.2, 12.2, 0, 1.6, -8),
    view('vault-and-tree', -1, 0, 1, -5, 1.2, 4)
  ],
  karaoke: [
    view('counter', -13.9, 0, 0, -12, 1.6, -6.5),
    view('north-corridor', -10.6, 0, -6.6, 6, 1.6, -6.6),
    view('door-1-closed', -6, 0, -7.4, -6, 1.3, -5),
    view('door-1-open', -6, 0, -6.2, -5, 1.2, -2),
    view('room-1', -7.6, 0, -3.6, -3.4, 1, -1.6),
    view('room-1-to-4', -5.2, 0, -1.6, -4.5, 1.3, 3),
    view('room-2', -1.8, 0, -1.3, 1.2, 1, -3.4),
    view('west-corridor', -10.5, 0, 3.6, -10.5, 1.6, -5),
    view('side-door-open', -10.1, 0, -2.5, -6, 1.2, -2.5)
  ],
  // 좀비 전용 맵: 시작 자리, 옥상, 좀비 문 몇 곳
  restarea: [
    view('store-front', 0, 0, 6, 0, 2, -5),
    view('roof', 0, 4, -9, 0, 3.6, 10),
    view('roof-stairs', -11, 0, -2, -11, 2.6, -12),
    view('gate-restroom', -19, 0, -5, -26, 1.4, -9),
    view('gate-yard', 21, 0, -2, 28, 1.4, 1),
    view('gas-station', -8, 0, 6, -20, 1.6, 8),
    view('parking', 6, 0, 2, 20, 1.4, 12)
  ],
  subway: [
    view('platform-east', 0, 0, 0, 20, 1.6, 0),
    view('platform-west', 0, 0, 0, -20, 1.6, 0),
    view('tunnel-ne', 22, 0, -3, 30.5, 0.4, -9),
    view('transfer-n', 0, 0, -11.5, 0, 1.6, -16),
    view('north-side', -6, 0, -12.5, -20, 1.6, -12.5)
  ],
  hanok: [
    view('yard', 0, 0, 2.3, 0, 1.6, -4),
    view('yard-west', 3.4, 0, 0, -5.6, 1.5, 1.5),
    view('hall-door-open', -2, 0.3, -3.3, -1, 1.4, -8),
    view('hall-north', -4.6, 0.3, -6.2, 4, 1.4, -8),
    view('room-nw', -9.25, 0.3, -7.6, -9.25, 1.5, -4.2),
    view('room-west', -10.6, 0.3, -1.6, -5.7, 1.4, 1.5),
    view('veranda', 5, 0.3, -3.4, -5, 1.6, -3.4),
    view('alley-west', -14.3, 0, -3, -14.3, 1.6, 9),
    view('alley-north', 6, 0, -11.3, -10, 1.6, -11.3),
    view('back-door-closed', -9.25, 0, -12.1, -9.25, 1.5, -9.8)
  ]
};

/* ---------------- 맵 데이터에서 자동으로 뽑는 자리 ---------------- */

function canStand(world, x, y, z) {
  return !overlapsCapsule(world, x, y + 0.5, z, 0.3, 1.25);
}

function autoViews(id, data) {
  const { world, spawns, size } = buildCollision(data);
  const out = [];
  const sx = size.x, sz = size.z;
  const high = Math.max(sx / 2 / 1.36, sz / 2 / 0.76) + 16;
  out.push({ name: 'top', x: 0, y: high, z: 0, yaw: 0, pitch: DOWN, clear: true });
  const a = high * 0.55;
  for (const [sn, ax, az] of [['nw', -1, -1], ['ne', 1, -1], ['se', 1, 1], ['sw', -1, 1]]) out.push(air(`air-${sn}`, ax * sx * 0.62, a, az * sz * 0.62, 0, 0, 0));

  spawns.owner.forEach((p, i) => { if (i < 2) out.push(facing(`spawn-owner${i}`, p.x, p.y, p.z, p.rotY)); });
  spawns.ffa.slice(0, Math.ceil(spawns.ffa.length / 2)).forEach((p, i) => out.push(facing(`spawn-ffa${i}`, p.x, p.y, p.z, p.rotY)));

  const pads = data.pads || [], portals = data.portals || [];
  pads.slice(0, Math.ceil(pads.length / 2)).forEach((p, i) => {
    if (!p.target) return;
    const [tx, ty, tz] = p.target;
    const dx = tx - p.x, dz = tz - p.z, len = Math.hypot(dx, dz) || 1;
    for (const back of [4.5, 3, 2]) {
      const x = p.x - (dx / len) * back, z = p.z - (dz / len) * back;
      const y = getGroundY(world, x, z, p.y + 0.5, 0.3);
      if (Math.abs(y - p.y) < 0.6 && canStand(world, x, y, z)) { out.push(view(`pad${i}-see`, x, y, z, p.x, p.y, p.z)); break; }
    }
    out.push(view(`pad${i}-land`, tx, ty, tz, p.x, Math.max(p.y, ty - 2), p.z));
  });
  portals.slice(0, id === 'dojo' ? portals.length : Math.ceil(portals.length / 2)).forEach((p, i) => {
    const alongX = p.w < p.d;
    for (const side of [3, -3]) {
      const x = alongX ? p.x + side : p.x, z = alongX ? p.z : p.z + side;
      const y = getGroundY(world, x, z, p.y + 0.5, 0.3);
      const seen = lineOfSight(world, [x, y + 1.6, z], [p.x, p.y + 1.2, p.z]);
      if (seen && Math.abs(y - p.y) < 0.6 && canStand(world, x, y, z)) { out.push(view(`portal${i}-in`, x, y, z, p.x, p.y + 1.2, p.z)); break; }
    }
    out.push(facing(`portal${i}-out`, p.to.x, p.to.y, p.to.z, p.to.rotY || 0));
  });
  for (const s of data.secrets || []) out.push(facing(`secret-${s.id}`, s.x, s.y, s.z + Math.min(1.5, s.d / 3), Math.PI), facing(`secret-${s.id}-back`, s.x, s.y, s.z - Math.min(1.5, s.d / 3), 0));
  // 폭파 구역: 비스듬히 위에서 한 장, 구역 한가운데에 서서 네 쪽을 한 장씩
  for (const s of (data.mission && data.mission.sites) || []) {
    out.push(air(`site-${s.id}-over`, s.x - 9, (s.y || 0) + 11, s.z + 9, s.x, s.y || 0, s.z));
    for (const [n, rot] of [['n', 0], ['e', -Math.PI / 2], ['s', Math.PI], ['w', Math.PI / 2]]) out.push(facing(`site-${s.id}-${n}`, s.x, s.y || 0, s.z, rot));
  }
  // 움직이는 지형: 길 한가운데를 맵 중심 쪽에서 비스듬히 내려다본다(절반만, 나머지는 대칭). 벽 쪽에서 찍으면 벽만 보인다
  const movers = data.movers || [];
  movers.slice(0, Math.ceil(movers.length / 2)).forEach((m) => {
    const top = Math.max(0, (m.y || 0) + m.h);
    const cx = m.x + (m.axis === 'x' ? m.dist / 2 : 0), cz = m.z + (m.axis === 'z' ? m.dist / 2 : 0);
    const len = Math.hypot(cx, cz);
    const ux = len > 1 ? -cx / len : 0.6, uz = len > 1 ? -cz / len : 0.8;
    out.push(air(`mover-${m.id}`, cx + ux * 6 + uz * 3, top + 6, cz + uz * 6 - ux * 3, cx, Math.max(0.6, top - 1.2), cz));
  });
  return out;
}

/* ---------------- 페이지 안 ---------------- */

/** 페이지에서: 플레이어를 붙잡고 카메라를 마음대로 옮기는 장치를 건다. 화면 위 글자와 총은 숨긴다 */
function installViewer() {
  const c = window.__skalafps;
  if (c.sandbox) c.sandbox.dispose();
  c.renderer.viewScene.visible = false;
  const ui = document.getElementById('pc-ui');
  if (ui) ui.style.display = 'none';
  const fog = c.renderer.scene.fog, near = fog.near, far = fog.far;
  const sheet = document.createElement('canvas');
  const v = window.__view = {
    on: false, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, frames: 0, grab: null, sheet,
    clear(off) { fog.near = off ? 1e5 : near; fog.far = off ? 2e5 : far; }
  };
  c.onTick(() => {
    if (!v.on) return;
    const s = c.player.state;
    s.pos[0] = v.x; s.pos[1] = v.y; s.pos[2] = v.z;
    s.vel[0] = s.vel[1] = s.vel[2] = 0;
    s.onGround = true; s.alive = true;
  }, 500);
  c.onFrame(() => {
    if (!v.on) return;
    const cam = c.renderer.camera;
    cam.position.set(v.x, v.y + 1.6, v.z);
    cam.rotation.set(v.pitch, v.yaw, 0);
  }, 500);
  c.onFrame(() => {
    if (!v.on) return;
    v.frames++;
    if (v.grab) { const fn = v.grab; v.grab = null; fn(c.renderer.domElement); }
  }, 2000);
  return true;
}

/** 페이지에서: 시점을 옮긴다 */
function setView(p) {
  const v = window.__view, c = window.__skalafps;
  let yaw = p.yaw, pitch = p.pitch;
  if (p.look) {
    const dx = p.look[0] - p.x, dy = p.look[1] - (p.y + 1.6), dz = p.look[2] - p.z;
    const len = Math.hypot(dx, dy, dz) || 1;
    yaw = Math.atan2(-dx, -dz);
    pitch = Math.asin(dy / len);
  }
  Object.assign(v, { x: p.x, y: p.y, z: p.z, yaw, pitch, on: true });
  c.player.spawn({ x: p.x, y: p.y, z: p.z, rotY: yaw });
  v.clear(!!p.clear);
  return v.frames;
}

/** 페이지에서: 다음 프레임을 묶음 사진의 한 칸에 그린다 */
function grabCell({ name, col, row, reset, W, H, cols, rows }) {
  const v = window.__view;
  return new Promise((resolve) => {
    v.grab = (canvas) => {
      const s = v.sheet;
      if (reset) { s.width = cols * W; s.height = rows * H; s.getContext('2d').fillRect(0, 0, s.width, s.height); }
      const g = s.getContext('2d');
      g.drawImage(canvas, col * W, row * H, W, H);
      g.font = 'bold 15px sans-serif';
      const w = g.measureText(name).width;
      g.fillStyle = 'rgba(0,0,0,0.65)';
      g.fillRect(col * W, row * H, w + 10, 21);
      g.fillStyle = '#fff';
      g.fillText(name, col * W + 5, row * H + 16);
      resolve(true);
    };
  });
}

/* ---------------- 시나리오 ---------------- */

export default {
  name: 'maps',
  title: '새 맵 열일곱의 스폰, 발판, 포털, 비밀 스팟, 골목, 폭파 구역, 움직이는 지형·문, 좀비 전용 맵 사진',
  timeoutMs: 15 * 60 * 1000,
  async run(t) {
    for (const id of MAP_IDS) {
      if (t.filter && !t.filter.split('/')[0].split(',').includes(id)) continue;
      const data = MAPS[id];
      const wanted = t.filter && t.filter.includes('/') ? t.filter.split('/')[1].split(',') : null;
      const views = [...autoViews(id, data), ...(HAND[id] || [])].filter((v) => !wanted || wanted.some((w) => v.name.includes(w)));
      t.setSection(`${id}: ${views.length}곳`);
      const page = await t.newPage();
      await page.open(`${t.base}?sandbox=${id}&plugins=0&autoplay=1&debug=1`, { width: 960, height: 540, clean: true, initScript: qaInit({ profile: richProfile(), settings: { quality: 'high' } }) });
      await page.waitFor(`window.__skalafps && __skalafps.screen === 'sandbox' && !!__skalafps.map && !!__skalafps.sandbox`, 60000, { label: `${id} 불러오기` });
      await page.fn(installViewer);
      await sleep(300);
      const per = SHEET.cols * SHEET.rows;
      let done = 0, sheetNo = 0;
      const started = Date.now();
      const saveSheet = async () => {
        const b64 = await page.eval(`window.__view.sheet.toDataURL('image/png').split(',')[1]`);
        writeFileSync(join(t.outDir, `sheet-${id}-${String(++sheetNo).padStart(2, '0')}.png`), Buffer.from(b64, 'base64'));
      };
      for (const v of views) {
        const start = await page.fn(setView, v);
        await page.waitFor(`window.__view.frames >= ${start + 3}`, 30000, { intervalMs: 20, label: `${id}/${v.name} 그리기` });
        const cell = done % per;
        await page.fn(grabCell, { name: v.name, col: cell % SHEET.cols, row: Math.floor(cell / SHEET.cols), reset: cell === 0, W: SHEET.w, H: SHEET.h, cols: SHEET.cols, rows: SHEET.rows });
        await t.shot(`${id}-${String(done).padStart(2, '0')}-${v.name}`);
        done++;
        if (done % per === 0) await saveSheet();
      }
      if (done % per !== 0) await saveSheet();
      t.log(`   ${id}: 사진 ${done}장, ${((Date.now() - started) / 1000).toFixed(1)}초, 그리기 ${await page.eval('JSON.stringify(__skalafps.renderer.info().render)')}`);
      t.check(done > 0 || !!wanted, `${id}: 사진을 찍는다`);
      t.errorsOk(`${id} 둘러보기`);
      await t.closePage();
    }
  }
};
