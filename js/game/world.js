/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 게임 화면의 공용 무대(연습장·멀티 공통). 오디오·이펙트·뷰모델·로컬 무기·수류탄·HUD를 core에 잇고, 사격·칼 판정을 주장 이벤트로 내보낸다.
 *          규칙(클래식·칼전·스나전)에 맞는 무기만 쥐어 주고, 발판·포털·비밀 스팟 연출과 표시 전용 물리 소품도 여기서 붙인다.
 */
/**
 * SKALA 작전 — World: 게임 화면의 공용 무대 (연습장·멀티 공통). 계약: ./WORLD_API.md
 *
 * core(renderer·input·loop·player·avatars)는 그대로 쓰고, 여기서는 그 위에
 *   오디오(fx/audio) · 이펙트(fx/effects) · 1인칭 뷰모델 · 로컬 arsenal · 수류탄 시스템 · HUD/스코프/일시정지 연결
 * 을 얹는다. 점수·피해 확정은 하지 않는다 — 판정 결과는 이벤트('hitClaim'·'explosion')로 내보내고 match가 정한다.
 *
 * 앱에 World는 하나다: createWorld()를 여러 번 불러도 같은 World를 가리키는 핸들을 돌려준다.
 * 루프 순서: 틱 -90(core 플레이어 이동 -100 다음) · 프레임 -40(아바타 -50 다음, 카메라 보정) · 500(FX, 렌더 1000 전)
 */
import * as THREE from 'three';
import { PLAYER, MOVE, DEFAULT_EMOTE_WHEEL } from '../core/consts.js';
import { traceShot, raycastWorld, raycastPlayers, lineOfSight, findFloor, getGroundY } from '../engine/physics.js';
import { lerpAngle } from '../engine/interp.js';
import { createProps } from '../engine/props.js';
import { WEAPONS, DEG, DEFAULT_LOADOUT, getDef } from '../weapons/defs.js';
import { createArsenal, shotDirection } from '../weapons/logic.js';
import { createGrenadeSystem, stepGrenade, GRENADE_PHYSICS } from '../weapons/grenade.js';
import { createViewmodel } from '../weapons/viewmodel.js';
import { createAudio } from '../fx/audio.js';
import { createEffects } from '../fx/effects.js';
import { relativeAngle } from '../ui/dom.js';
import { droppedGunMesh } from '../engine/avatars.js';
import { avatarIdOf } from '../core/avatar-defs.js';
import { DEFAULT_RULESET, normalizeRuleset, rulesetOf, pickableWeapons, isWeaponAllowed, shotTargets } from './modes.js';
import { createDrops, DROP_RADIUS } from './drops.js';
import { normalizeMission, placeMission } from './mission.js';
import { missionCrowd } from '../maps/collision.js';
import { createBombView } from './bombview.js';
import { createMultiKill, multiKillTier } from './multikill.js';

const STEEL_MATS = new Set(['steel', 'rust', 'deck', 'tank', 'pipe', 'container_red', 'yellow', 'white', 'glass', 'metal_dark']);
const SPECTATE_DELAY_MS = 1600;
// 개인전 즉시 부활: 부활까지 이보다 적게 남으면 안내를 숨기고 E를 받지 않는다(방장은 500 ms 미만이면 거절, match.QUICK_RESPAWN_MIN_LEFT_MS)
const QUICK_HIDE_MS = 700;
const QUICK_RETRY_MS = 1500;                     // 요청한 뒤 방장 답(내 spawn)을 기다리는 동안 다시 보내지 않는 시간
const LOCK_HINT = '🖱️ 화면을 클릭하면 조작을 시작해요';
const TOUCH_LOCK_HINT = '👆 화면을 누르면 조작을 시작해요';
const BODY_R = 0.3;
const CROUCH_H = PLAYER.CROUCH_HEIGHT || 1.25;   // 앉은 키(core consts)
const FFA_KEYS = Object.freeze(['kills', 'rank', 'total', 'leaderName', 'leaderKills', 'target', 'killTarget']);
/** 부위 순위(작을수록 좋다). 산탄 한 발이 같은 사람의 여러 부위를 맞히면 가장 좋은 부위 하나로 주장한다 */
const PART_RANK = Object.freeze({ head: 0, body: 1, legs: 2, hand: 3, foot: 4 });
/** 움직이는 지형에 맞은 탄: 탄흔을 남기지 않는다(fx.impact) */
const NO_DECAL = Object.freeze({ decal: false });
/** 산탄의 예광탄은 이만큼만 그린다. 판정과 탄착은 펠릿 전부 */
const PELLET_TRACERS = 3;
/** 동시에 시뮬레이션하는 다른 사람 수류탄 상한. 한 사람에 1개가 규칙이라 정상 경기는 닿지 않는다 */
const MAX_LIVE_GRENADES = 32;
/** 무기 슬롯 → arsenal 로드아웃 키 */
const SLOT_KEYS = Object.freeze({ 1: 'primary', 2: 'secondary', 3: 'melee' });

const num = (v, d = 0) => (Number.isFinite(+v) && v !== null && v !== '' ? +v : d);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const r3 = (v) => [Math.round(v[0] * 1000) / 1000, Math.round(v[1] * 1000) / 1000, Math.round(v[2] * 1000) / 1000];
const round2 = (v) => Math.round(v * 100) / 100;
const r2 = (v) => [round2(v[0]), round2(v[1]), round2(v[2])];
/** [x,y,z] 배열이나 {x,y,z} → 새 배열 */
function arr3(v) {
  if (!v) return [0, 0, 0];
  if (Array.isArray(v)) return [num(v[0]), num(v[1]), num(v[2])];
  return [num(v.x), num(v.y), num(v.z)];
}
function norm3(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
const stepSound = (mat) => (STEEL_MATS.has(mat) ? 'footstep_steel' : 'footstep_concrete');
/** 단위 벡터 d 둘레, 반각 rad 원뿔 안의 무작위 방향(원격 산탄 연출용. 판정에는 쓰지 않는다) */
function coneDir(d, rad) {
  const r = Math.tan(rad) * Math.sqrt(Math.random()), th = Math.random() * Math.PI * 2;
  const a = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = norm3([d[1] * a[2] - d[2] * a[1], d[2] * a[0] - d[0] * a[2], d[0] * a[1] - d[1] * a[0]]);
  const v = [d[1] * u[2] - d[2] * u[1], d[2] * u[0] - d[0] * u[2], d[0] * u[1] - d[1] * u[0]];
  const c = r * Math.cos(th), s = r * Math.sin(th);
  return norm3([d[0] + u[0] * c + v[0] * s, d[1] + u[1] * c + v[1] * s, d[2] + u[2] * c + v[2] * s]);
}

/**
 * 근접(칼) 판정: 정확한 레이가 먼저, 없으면 시선 원뿔(arc) 안 + 사거리 안 + 벽에 안 가린 가장 가까운 대상.
 * @returns {{ id, part, dist, point } | null}  dist = 몸 표면까지 거리(m)
 */
export function meleeTrace(world, eye, fwd, range = 1.8, arc = 0.6, targets = [], ignoreId) {
  const f = norm3(arr3(fwd));
  const ray = raycastPlayers(eye, f, range, targets, ignoreId != null ? { ignoreId } : null);
  if (ray && (!world || lineOfSight(world, eye, ray.point))) {
    return { id: ray.id, part: ray.part, dist: round2(ray.dist), point: r3(ray.point) };
  }
  let best = null, bestScore = Infinity;
  for (const tg of targets) {
    if (!tg || tg.alive === false || (ignoreId != null && tg.id === ignoreId)) continue;
    const p = arr3(tg.pos);
    const top = tg.crouch ? 1.5 - 0.45 * Math.min(1, +tg.crouch || 0) : 1.5;   // 앉으면 몸통 윗면 1.05 m
    const cy = clamp(eye[1], p[1] + 0.5, p[1] + top);      // 눈높이에 가장 가까운 몸 높이
    const dx = p[0] - eye[0], dy = cy - eye[1], dz = p[2] - eye[2];
    const dist = Math.hypot(dx, dy, dz);
    const surf = Math.max(0, dist - BODY_R);
    if (surf > range) continue;
    const cos = dist > 1e-6 ? (dx * f[0] + dy * f[1] + dz * f[2]) / dist : 1;
    const ang = Math.acos(clamp(cos, -1, 1));
    if (ang > arc + Math.atan2(BODY_R, Math.max(BODY_R, dist))) continue;
    const pt = [p[0], cy, p[2]];
    if (world && !lineOfSight(world, eye, pt)) continue;
    const score = ang * 2 + surf;
    if (score < bestScore) { bestScore = score; best = { id: tg.id, part: 'body', dist: round2(surf), point: r3(pt) }; }
  }
  return best;
}

/* ============================================================ 공유 World */

let defaultCtx = null;
let shared = null;

/** game/index.js가 install(ctx)에서 등록한다 → createWorld({ ... })에 ctx를 안 줘도 된다 */
export function setWorldContext(ctx) { defaultCtx = ctx || null; }

/**
 * @param {{ ctx?, ui?, settings?, root? }} opts
 * @returns {Promise<object>} World 핸들 (WORLD_API.md 1절)
 */
export async function createWorld(opts = {}) {
  const ctx = (opts && opts.ctx) || defaultCtx;
  if (!ctx || !ctx.renderer || !ctx.player) throw new Error('createWorld: core ctx가 필요해요(game/index.js install 이후에 부르세요)');
  if (!shared || shared.dead || shared.ctx !== ctx) shared = buildWorld(ctx, opts || {});
  else if (opts && opts.ui && shared.ui !== opts.ui) console.warn('[world] 이미 만든 World가 있어 새 ui는 쓰지 않아요(앱에 UI는 하나)');
  return shared.handle();
}

function buildWorld(ctx, opts) {
  const { bus, renderer: R, input, player, avatars } = ctx;
  const settings = opts.settings || ctx.settings;
  const ui = opts.ui || null;
  const W = { ctx, ui, dead: false, refs: 0, handle: null };
  const listeners = new Map();
  const offs = [];

  /* ---------- 효과 · 소리 · 뷰모델 · 무기 ---------- */
  const fx = createEffects(R.scene, R.camera, { renderer: R.three });
  fx.setApplyShake(false);                       // 흔들림은 frame()에서 한 번에 더한다
  const audio = createAudio({ volume: num(settings.get('volume'), 0.8) });
  const vm = createViewmodel(R.viewCamera, { lookCamera: R.camera, muzzleFlash: true });
  try {
    vm.preload();
    if (typeof vm.prewarm === 'function') vm.prewarm(R.three);   // 셰이더·텍스처까지 미리 준비해 첫 교체에서 끊기지 않게 한다
  } catch (e) { /* 첫 교체 때 만든다 */ }
  vm.setVisible(false);
  // 휴대폰은 조준 버튼을 누르고 있을 손가락이 없어서 누를 때마다 켜고 끈다
  const zoomModeOf = () => (input.touchMode || settings.get('zoomMode') === 'toggle' ? 'toggle' : 'hold');
  // 휴대폰의 라이플은 예외다: 이동·조준·사격을 한꺼번에 누를 손가락이 없으므로 조준 버튼을 누르는 동안 조준하며 자동으로 쏜다(조준 사격)
  let aimFireOn = false;
  let aimFirePrev = false;
  const arsenalZoomMode = () => (aimFireOn ? 'hold' : zoomModeOf());
  /** 지금 장비 { primary, secondary, melee }. 계정이 있으면 계정 것, 없거나 빈 칸은 기본값 */
  function accountLoadout() {
    const acc = ctx.account && ctx.account.loadout;
    return { ...DEFAULT_LOADOUT, ...(acc && typeof acc === 'object' ? acc : null) };
  }
  const arsenal = createArsenal({ ...accountLoadout(), zoomMode: zoomModeOf() });
  const prevDelay = avatars.delay;
  avatars.setDelay(0);                           // setActorState는 이미 보간된 상태 → 그대로 그린다

  // 수류탄 모형(풀)
  const nadeGeo = new THREE.CylinderGeometry(0.06, 0.06, 0.13, 10);
  const nadeMat = new THREE.MeshLambertMaterial({ color: 0xe2b52a });
  const nadeMeshes = [];
  function nadeMesh(i) {
    while (nadeMeshes.length <= i) {
      const m = new THREE.Mesh(nadeGeo, nadeMat);
      m.name = 'world:grenade';
      m.visible = false;
      R.scene.add(m);
      nadeMeshes.push(m);
    }
    return nadeMeshes[i];
  }

  /* ---------- 상태 ---------- */
  // loadout = 이 규칙에서 직접 고른 무기(pickSlot). 아직 안 골랐으면 null이고 계정 장비를 쓴다
  const local = { id: String(ctx.session.id), name: String(ctx.session.name || ''), team: 'owner', alive: false, spawned: false, deadAt: 0, loadout: null, ownDrops: new Set() };
  const spec = { id: null, idx: 0, yaw: 0, name: '' };
  const actors = new Map();
  const rnd = { phase: null, round: 0, score: { owner: 0, charterer: 0 }, timeLeftMs: null, elapsed: 0, alive: null, teamSize: null, target: 3, bestOf: 5, ffa: null, attack: null };
  let map = null, nades = null, active = false, simPaused = false, uiPaused = false, controls = true;
  // 개인전(FFA): 모든 액터가 적. 부활 대기·보호 표시는 World가 HUD에 그린다(MODES.md 3.4)
  let mode = 'team';
  let ruleset = DEFAULT_RULESET;                  // 무기 규칙(modes.js). 모드와 직교한다
  let respawn = null;                             // { at(ms), killer, weaponName } — 내 부활 대기
  let quick = null;                               // 개인전 즉시 부활(E): { cost, ok }. 세션·연습장이 죽을 때 정하고 spawnLocal이 지운다
  let quickSentAt = -Infinity;                    // 이번 죽음에서 마지막으로 즉시 부활을 요청한 시각(ms)
  let quickTouch = false;                         // 휴대폰 '부활' 버튼(touch:use)을 보이고 있는가
  let protectUntil = 0;                           // 내 보호(무적) 표시가 끝나는 시각(ms)
  let pausedAt = 0;                               // 시뮬레이션을 멈춘 시각(ms). 멈춘 동안 부활·보호 표시 시계도 멈춘다
  const displayNow = () => (simPaused ? pausedAt : performance.now());
  let customHint = '';
  let pauseOpts = { leaveLabel: '나가기', note: undefined };
  let scoreboardProvider = null, scoreboardOpen = false, sbRefresh = 0;
  let clock = 0;                                  // World 시뮬레이션 시각(초, 일시정지 중 멈춤)
  let moverClock = null;                          // 움직이는 지형의 바깥 시계(멀티: 방장 시계). 없으면 clock
  const multiKill = createMultiKill();            // 내 연속 킬(5초 안에 이어진 처치 수). 시계는 clock
  const scheduled = [];                           // { at, name, opts, tag }
  let heartbeatAt = 0, grenadeSeq = 0, shotSeq = 0;
  const secretsNoAccount = new Set();             // 계정 모듈이 없을 때 이번 실행에서 찾은 비밀 스팟
  let loadingEl = null, loadingText = null;
  const tmpV = new THREE.Vector3();
  const latch = { fire: false, rmb: false, reload: false, slot: null, wheel: 0 };
  let rmbDown = false;
  // 바닥에 버린 총(game/drops.js). 그리는 것은 여기서 한다
  const drops = createDrops();
  const dropViews = new Map();                    // 항목 id → { group, spin, label }
  const dropRingGeo = new THREE.RingGeometry(0.42, 0.52, 28);
  dropRingGeo.rotateX(-Math.PI / 2);
  const dropRingMat = new THREE.MeshBasicMaterial({ color: 0x9fd8ff, transparent: true, opacity: 0.75, depthWrite: false });
  const dropRingPremium = new THREE.MeshBasicMaterial({ color: 0xffc83d, transparent: true, opacity: 0.85, depthWrite: false });
  let dropSeq = 0;
  // 폭파 미션 연출(game/bombview.js): 폭탄 모형·삐 소리·구역 표시·E 키 의도. 판정은 match가 한다(WORLD_API 8절)
  const bombView = createBombView({
    THREE, scene: R.scene, camera: R.camera, bus, fx,
    play: (name, o) => play(name, o),
    hud: () => (ui ? ui.hud : null),
    emit: (evt, data) => emit(evt, data),
    local: () => {
      const st = player.state;
      return {
        id: local.id, team: local.team, alive: local.spawned && local.alive, pos: st.pos, vel: st.vel, onGround: st.onGround,
        canAct: localCanMove() && input.enabled && !(ui && ui.needsCursor()) && !emoteLocal && !wheel.open, touch: !!input.touchMode
      };
    },
    posOf: (id) => { const a = actors.get(String(id)); const av = a ? avatars.get(a.id) : null; return av ? av.pos : a && a.state ? a.state.pos : null; },
    floorAt: (x, fromY, z) => (map ? getGroundY(map.world, x, z, fromY) : fromY),
    onCarrier: (prev, next) => { for (const id of [prev, next]) { const a = id ? actors.get(String(id)) : null; if (a) refreshAvatar(a); } }
  });

  function emit(evt, data) {
    const set = listeners.get(evt);
    if (!set) return;
    for (const fn of Array.from(set)) {
      try { fn(data); } catch (err) { console.error(`[world] '${evt}' 리스너 오류`, err); }
    }
  }
  function on(evt, fn) {
    if (typeof fn !== 'function') return () => {};
    let set = listeners.get(evt);
    if (!set) { set = new Set(); listeners.set(evt, set); }
    set.add(fn);
    return () => { const s = listeners.get(evt); if (s) s.delete(fn); };
  }

  /* ---------- 물리 소품 (표시 전용, DESIGN 10절) ----------
   * 판정·네트워크와 무관하다. cannon-es는 소품이 있는 맵을 처음 만날 때 props.js가 불러오고, 못 불러오면 고정 소품으로 남는다. */
  const props = createProps({
    THREE, scene: R.scene,
    getMapData: () => (map ? map.data : null),
    getColliders: () => (map ? map.colliders : null),
    getPlayerPos: () => (local.spawned && local.alive ? player.state.pos : null),
    quality: R.quality
  });

  /* core main.js가 매 프레임 player.getBodyState()를 avatars.setLocalBody에 그대로 넘긴다(3인칭 이모트 때의 내 몸).
   * 든 무기는 World가 player.state에 적어 두므로(무기 교체 이벤트) 여기서 덧붙인다. */
  const bodyStateOf = player.getBodyState;
  player.getBodyState = () => {
    const body = bodyStateOf();
    body.slot = player.state.slot;
    body.weaponId = player.state.weapon;
    body.avatar = ctx.account ? ctx.account.avatar : undefined;   // 내 캐릭터(계정 장비)
    return body;
  };
  offs.push(() => { player.getBodyState = bodyStateOf; });

  /* ---------- 소리 ---------- */
  function play(name, o) { try { return audio.play(name, o); } catch (e) { return null; } }
  function schedule(delaySec, name, o, tag) { scheduled.push({ at: clock + Math.max(0, delaySec), name, opts: o || null, tag: tag || '' }); }
  function cancelScheduled(tag) { for (let i = scheduled.length - 1; i >= 0; i--) if (scheduled[i].tag === tag) scheduled.splice(i, 1); }
  function runScheduled() {
    for (let i = scheduled.length - 1; i >= 0; i--) {
      const s = scheduled[i];
      if (clock >= s.at) { scheduled.splice(i, 1); play(s.name, s.opts || undefined); }
    }
  }
  function footstep(p, gain) {
    let mat = null;
    if (map) { const h = raycastWorld(map.world, [p[0], p[1] + 0.3, p[2]], [0, -1, 0], 0.8); if (h) mat = h.mat; }
    play(stepSound(mat), { pos: p, gain });
  }
  // 첫 사용자 입력에서 AudioContext 언락(메뉴에서 미리 풀리면 게임 중 끊김이 없다)
  let unlocked = false;
  const unlock = () => {
    if (unlocked) return;
    audio.unlock().then((ok) => { if (ok) { unlocked = true; removeUnlock(); } }, () => {});
  };
  const removeUnlock = () => {
    window.removeEventListener('pointerdown', unlock, true);
    window.removeEventListener('keydown', unlock, true);
    window.removeEventListener('touchend', unlock, true);
  };
  window.addEventListener('pointerdown', unlock, true);
  window.addEventListener('keydown', unlock, true);
  window.addEventListener('touchend', unlock, true);   // iOS Safari는 손을 뗄 때만 소리를 켜 준다

  /* ---------- 입력 래치 ---------- */
  const onMouseDown = (e) => { if (e.button === 2 && input.locked && input.enabled && !emoteBusy()) { rmbDown = true; latch.rmb = true; } };
  const onMouseUp = (e) => { if (e.button === 2) rmbDown = false; };
  document.addEventListener('mousedown', onMouseDown);
  document.addEventListener('mouseup', onMouseUp);
  offs.push(() => { document.removeEventListener('mousedown', onMouseDown); document.removeEventListener('mouseup', onMouseUp); });
  offs.push(bus.on('input:fire', (e) => {
    if (!e || !e.down) return;
    if (active && local.spawned && !local.alive) { spec.idx++; spec.id = null; }  // 관전 대상 바꾸기
    // 이모트 중·휠이 열린 동안의 좌클릭은 이모트 취소/선택에만 쓴다(사격 안 함, MODES.md 4.2·4.3)
    if (emoteBusy()) return;
    latch.fire = true;
  }));
  offs.push(bus.on('player:emote', () => { if (active) syncLocalEmote(); }));
  offs.push(bus.on('input:emoteWheel', (e) => onEmoteWheel(e)));
  // core 3인칭 전환: 'third'가 되는 즉시 뷰모델을 숨긴다(매 프레임 thirdPerson 확인과 같은 결과, 첫 프레임부터)
  offs.push(bus.on('player:view', (e) => { if (active && e && e.mode === 'third') vm.setVisible(false); }));
  offs.push(bus.on('player:emote-denied', (e) => onEmoteDenied(e)));
  offs.push(bus.on('input:aim', (e) => { if (e && e.active && e.source === 'user' && !input.locked) latch.rmb = true; }));  // autoplay 테스트용
  offs.push(bus.on('input:zoom', (e) => {   // 터치 조준 버튼. 마우스 우클릭과 같다
    if (!e || !e.down) { rmbDown = false; return; }
    if (input.locked && input.enabled && !emoteBusy()) { rmbDown = true; latch.rmb = true; }
  }));
  offs.push(bus.on('input:reload', () => { latch.reload = true; }));
  // 개인전 부활 대기 중 E(휴대폰은 '부활' 버튼, 같은 input:use) → 즉시 부활 요청. 폭파 미션의 설치·해체는 bombView가 따로 듣는다
  offs.push(bus.on('input:use', (e) => { if (e && e.down) requestQuick(); }));
  offs.push(bus.on('input:drop', () => { dropHeldGun(); }));
  offs.push(bus.on('input:slot', (e) => { latch.slot = e && e.slot; }));
  offs.push(bus.on('input:cycle', (e) => { latch.wheel = (e && e.dir) || 0; }));
  offs.push(bus.on('input:lock', (e) => { if (e && !e.locked) rmbDown = false; }));

  offs.push(bus.on('settings:change', (e) => {
    const k = e && e.key;
    if (k === 'volume' || k === '*') audio.setVolume(num(settings.get('volume'), 0.8));
    if (k === 'zoomMode' || k === '*') arsenal.setZoomMode(arsenalZoomMode());
  }));
  offs.push(bus.on('renderer:quality', (e) => {
    const low = e && e.level === 'low';
    fx.setQuality(low ? 'low' : 'high');
    audio.setQuality(low ? 'low' : 'high');
    props.setQuality(e && e.level);
  }));
  offs.push(bus.on('player:step', (e) => {
    if (!active || !local.alive) return;
    const quiet = (e && e.quiet) || player.state.crouch;   // Shift 걷기·앉아 걷기는 작게
    play(stepSound(e && e.mat), { gain: player.state.crouch ? 0.2 : quiet ? 0.3 : 0.6 });
  }));
  offs.push(bus.on('player:land', (e) => {
    if (!active || !local.alive || !e) return;
    if (e.hopped) play('bhop_land', { gain: 0.6 });   // 버니합 사슬: 착지마다 쿵쿵거리지 않게 작게
    else if (e.speed > 3) play(stepSound(e.mat), { gain: Math.min(1, e.speed / 9) });
  }));
  // 발판·포털·비밀 스팟 판정과 재발동 대기는 core player(engine/triggers.js)가 한다. 스폰할 때 상태도 거기서 비운다. World는 연출과 보상만 맡는다
  offs.push(bus.on('player:pad', (e) => {
    if (!active || !local.alive || !e) return;
    play('pad_boost');
    fx.padBurst(e.pos, e.pad && e.pad.color);
  }));
  offs.push(bus.on('player:portal', (e) => {
    if (!active || !local.alive || !e) return;
    const p = e.portal;
    play('portal');
    if (p) fx.portalFlash([p.x, p.y, p.z], p.color);   // 들어간 자리
    fx.portalFlash(e.pos, p && p.color);               // 나온 자리
  }));
  offs.push(bus.on('player:secret', (e) => onSecret(e)));
  // 재장전·꺼내기·줌 중이면 뷰모델이 알아서 무시한다. 여기서는 조작할 수 있는 상태인지만 본다
  offs.push(bus.on('input:inspect', () => { if (active && localCanAct()) vm.play({ type: 'inspect' }); }));

  /* ---------- UI: 커서 · 일시정지 · 로드아웃 · 점수판 ---------- */
  /* ---------- 무기 교체(라운드가 시작되기 전 대기 시간) ----------
   * 연습장·세션이 대기 시간이 시작될 때 openSwap으로 알린다. HUD에 "N 을 눌러 무기 교체!"가 뜨고, N(휴대폰은 그 안내를 누름)으로
   * 무기 목록(ui 'loadout'의 swap 모드)을 여닫는다. 무기를 누르면 바로 바뀌고 목록이 닫힌다('loadout:pick' → setLocalLoadout).
   * 남은 시간은 World 시각으로 잰다(연습장 일시정지 중에는 멈춘다). 시간이 끝나거나 closeSwap이 오면 안내와 목록을 치운다. */
  let swap = null;                                // { endAt: clock 기준 초, props: 로드아웃 화면에 넘길 값 }
  const swapLeft = () => (swap ? swap.endAt - clock : 0);
  function openSwap(o = {}) {
    closeSwap();
    const secs = num(o && o.seconds, 0);
    if (!active || !ui || !(secs > 0)) return;
    swap = { endAt: clock + secs, props: { ...o } };
  }
  function closeSwap() {
    if (!swap) return;
    const listed = !!(ui && ui.isVisible('loadout'));
    swap = null;
    if (listed) ui.hide('loadout');
  }
  /** N 키·휴대폰 안내: 무기 목록을 열고, 열려 있으면 고르지 않고 닫는다 */
  function toggleSwapList() {
    if (!swap || !ui || !local.spawned || !local.alive) return;
    if (ui.isVisible('loadout')) {
      ui.hide('loadout');
      if (!input.locked && !input.touchMode) input.requestLock();
      return;
    }
    const left = swapLeft();
    if (left < 0.4 || ui.isVisible('pause')) return;
    ui.show('loadout', { ...swap.props, swap: true, compact: false, seconds: Math.round(left * 10) / 10, selected: local.loadout || swap.props.selected });
  }
  offs.push(bus.on('input:loadout', () => { if (active) toggleSwapList(); }));

  // 창 화면에서 Ctrl(앉기)을 처음 누르면 전체 화면 키 잠금을 한 번 알려 준다(Ctrl+W가 탭을 닫으려 하기 전에)
  let keyLockTip = false;
  offs.push(bus.on('input:key', (e) => {
    if (keyLockTip || !e || !e.down || (e.code !== 'ControlLeft' && e.code !== 'ControlRight')) return;
    if (!active || !ui || !input.locked || !input.canKeyboardLock || input.keyboardLocked) return;
    keyLockTip = true;
    ui.hud.banner({ icon: '⌨️', title: 'F11 · 전체 화면 키 잠금', sub: '켜면 Ctrl+W(탭 닫기)·Tab도 게임이 받아요' });
  }));

  function openPause() {
    if (!ui) return;
    ui.show('pause', { leaveLabel: pauseOpts.leaveLabel, note: pauseOpts.note });
    // 결과 화면이 일시정지 메뉴를 덮어 닫으면 uiPaused가 켜진 채 남는다. 메뉴를 새로 여는 것이니 언제나 알린다
    uiPaused = true;
    emit('pause', { paused: true });
  }
  function closePause() {
    if (uiPaused) { uiPaused = false; emit('pause', { paused: false }); }
  }
  if (ui) {
    offs.push(ui.on('needCursor', (need) => {
      if (need && input.locked) input.exitLock();
      // 휴대폰에는 포인터 잠금 제한이 없다. 무기 선택 같은 화면이 닫히면 다시 누르게 하지 않고 조작을 돌려준다
      else if (!need && input.touchMode && active && !uiPaused) input.requestLock();
    }));
    offs.push(ui.on('pause:resume', () => {
      if (!active) return;
      closePause();
      input.requestLock();                       // 사용자 클릭 안 → 바로 다시 잠금(실패하면 '클릭해서 시작' 안내)
    }));
    offs.push(ui.on('pause:leave', () => {
      if (!active) return;
      closePause();
      emit('leave', {});
    }));
    offs.push(ui.on('loadout:pick', (e) => {
      if (!active) return;
      const id = e && e.id;
      setLocalLoadout(id);                       // 이 규칙에 안 맞는 무기는 안에서 거른다
      if (e && !e.auto && !input.locked) input.requestLock();
      emit('loadoutPick', { id, auto: !!(e && e.auto) });
    }));
    // 무기 교체 창을 고르지 않고 닫았다. N으로 닫았으면 그 키 입력으로 포인터를 다시 잠근다(Esc로는 잠글 수 없어 '클릭해서 시작' 안내가 뜬다)
    offs.push(ui.on('loadout:close', (e) => {
      if (active && e && e.relock && !input.locked && !input.touchMode) input.requestLock();
    }));
  }
  offs.push(bus.on('input:menu', () => {
    if (!active || !ui || ui.needsCursor() || ui.isVisible('pause')) return;
    openPause();                                 // Esc·창 전환으로 잠금이 풀림
  }));
  offs.push(bus.on('input:scoreboard', (e) => {
    if (!active || !ui) return;
    scoreboardOpen = !!(e && e.open) && !!scoreboardProvider;
    if (scoreboardOpen) { sbRefresh = 0; showScoreboard(); } else ui.hide('scoreboard');
  }));
  function showScoreboard() {
    if (!ui || !scoreboardProvider) return;
    try { const d = scoreboardProvider(); if (d) ui.show('scoreboard', d); } catch (err) { console.error('[world] scoreboard', err); }
  }

  function showLoading(on, text) {
    if (!ui) return;
    if (!loadingEl) {
      loadingEl = document.createElement('div');
      loadingEl.className = 'sk-world-loading';
      Object.assign(loadingEl.style, {
        position: 'fixed', inset: '0', zIndex: '8', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px',
        background: 'rgba(4, 12, 24, 0.78)', color: '#d8e6f5', fontWeight: '800', fontSize: '16px', pointerEvents: 'auto'
      });
      const sp = document.createElement('div');
      sp.className = 'sk-spinner';
      loadingText = document.createElement('span');
      loadingEl.append(sp, loadingText);
      ui.el.append(loadingEl);
    }
    loadingText.textContent = text || '';
    loadingEl.hidden = !on;
  }

  /* ---------- 맵 ---------- */
  let loadSeq = 0;                                // 가장 최근의 loadMap·unloadMap 번호. 늦게 끝난 loadMap을 알아챈다
  /** → 맵 정보. 불러오는 동안 unloadMap이나 새 loadMap이 불렸으면 null이고 아무것도 켜지 않는다 */
  async function loadMap(mapId, opt = {}) {
    const seq = ++loadSeq;
    const data = ctx.maps && ctx.maps.getMap ? ctx.maps.getMap(mapId) : null;
    showLoading(true, `🗺️ ${(data && data.name) || mapId} 불러오는 중…`);
    let built;
    try { built = await ctx.loadMap(mapId); }
    finally { if (seq === loadSeq) showLoading(false); }
    if (seq !== loadSeq) {
      // 방이 닫히거나 강퇴되어 이미 경기에서 나왔다. 여기서 화면을 켜면 로비를 가리는 HUD만 남아 빠져나갈 수 없다
      if (ctx.map === built) ctx.unloadMap();
      return null;
    }
    map = built;
    // 움직이는 지형의 시계: 멀티는 세션이 준 방장 시계, 그 밖에는 World 시뮬레이션 시각(연습장 일시정지 중에는 멈춘다)
    built.setMoverClock(() => { const t = moverClock ? moverClock() : NaN; return Number.isFinite(t) ? t : clock; });
    bombView.load(built.data);
    props.load(built.data, built.colliders);     // 기다리지 않는다: 표시 전용이고 cannon-es는 CDN에서 온다
    if (nades) nades.dispose();
    nades = createGrenadeSystem({ world: built.world });
    active = true;
    simPaused = false; uiPaused = false; scoreboardOpen = false;
    controls = true; customHint = '';            // 이전 모드(멀티 teardown 등)가 남긴 설정을 지운다
    local.spawned = false; local.alive = false; local.loadout = null;
    rnd.phase = null; rnd.timeLeftMs = null; rnd.alive = null; rnd.teamSize = null; rnd.score = { owner: 0, charterer: 0 }; rnd.round = 0; rnd.ffa = null; rnd.attack = null;
    respawn = null; quick = null; protectUntil = 0;
    syncQuickTouch(false);
    multiKill.reset();
    setMode(opt && opt.mode);
    setRuleset(opt && opt.ruleset);
    fx.clear(false);
    scheduled.length = 0;
    R.setFov(R.baseFov);
    input.setLookScale(1);
    ctx.setRendering(true);
    input.setEnabled(input.locked || !!(ctx.flags && ctx.flags.autoplay));
    if (ui) { ui.show('hud', { crosshair: false, hp: 100 }); ui.hud.reset(); ui.scope.set(0); }
    // 폭파 미션 칸(구역 · 진영 스폰, 스폰 높이는 빌더 스폰처럼 바닥을 찾아 채운다). 미션이 없는 맵이면 null
    // extra = 16인방(진영당 8명)에서 진영 스폰이 모자랄 때만 경기가 쓰는 보조 자리
    const mission = missionCrowd(placeMission(normalizeMission(built.data), built.world, findFloor, getGroundY), built.world, built.bounds);
    return { spawns: built.spawns, mission, mapName: built.name, mapId: built.id, map: built, data: built.data, fallback: !!(built.data && built.data.fallback), ruleset };
  }

  function unloadMap() {
    const was = active || !!map;
    loadSeq++;
    showLoading(false);
    cancelLocalEmote('unload');                  // 안 끝내면 다음 경기까지 3인칭 카메라와 입력 잠금이 남는다
    swap = null;                                 // 로드아웃 화면은 아래에서 함께 숨긴다
    active = false;
    simPaused = false; uiPaused = false; scoreboardOpen = false;
    clearActors();
    clearDrops();
    bombView.unload();
    if (nades) { nades.dispose(); nades = null; }
    for (const m of nadeMeshes) m.visible = false;
    fx.clear(false);
    fx.setSpeedAmount(0);
    props.clear();
    try { audio.stopAll(0.05); } catch (e) { /* ignore */ }
    scheduled.length = 0;
    vm.setVisible(false);
    stopSound(emoteSnd); emoteSnd = null; emoteLocal = 0; emoteBlockUntil = 0;
    closeWheel();
    local.spawned = false; local.alive = false;
    customHint = '';
    rnd.phase = null; rnd.timeLeftMs = null; rnd.ffa = null;
    respawn = null; quick = null; protectUntil = 0;
    syncQuickTouch(false);
    multiKill.reset();
    mode = 'team';
    local.loadout = null;
    setRuleset(DEFAULT_RULESET);
    player.setFrozen(false);
    player.setSpeedScale(1);
    if (ui) { for (const s of ['hud', 'scoreboard', 'pause', 'loadout']) ui.hide(s); ui.scope.set(0); }
    R.setFov(R.baseFov);
    input.setLookScale(1);
    input.exitLock();
    input.setEnabled(false);
    ctx.setRendering(false);
    map = null;
    if (was && ctx.map) ctx.unloadMap();
  }

  /** 라운드 전환: 투사체·이펙트·예약 소리·관전 정리(액터는 유지) */
  function reset() {
    closeSwap();
    if (nades) nades.clear();
    for (const m of nadeMeshes) m.visible = false;
    clearDrops();
    bombView.reset();
    fx.clear(false);
    scheduled.length = 0;
    multiKill.reset();
    spec.id = null; spec.name = '';
    if (ui) {
      ui.hud.reset(); ui.hide('scoreboard'); scoreboardOpen = false;
      if (uiPaused && !ui.isVisible('pause')) uiPaused = false;   // 다른 화면이 일시정지 메뉴를 닫은 채 새 판을 시작한다
    }
  }

  /* ---------- 로컬 플레이어 ---------- */
  function spawnLocal(o = {}) {
    if (!map) throw new Error('spawnLocal: 먼저 loadMap()을 부르세요');
    cancelLocalEmote('spawn');
    if (o.id != null && String(o.id)) { local.id = String(o.id); player.state.id = local.id; }
    if (o.name) { local.name = String(o.name); player.state.name = local.name; }
    // 팀전: owner/charterer. 개인전: 팀 없음(null) — 아군 이름표 없음, 뷰모델 소매는 남색
    const team = o.team === 'charterer' || o.team === 'owner' ? o.team : mode === 'ffa' ? null : local.team;
    local.team = team;
    player.state.team = team;
    avatars.setLocalTeam(mode === 'ffa' ? null : team);
    vm.setTeam(team || 'owner');
    const sp = o.spawn || (mode === 'ffa' && map.spawns.ffa && map.spawns.ffa[0]) || (team && map.spawns[team] && map.spawns[team][0]) || (map.spawns.owner && map.spawns.owner[0]) || { x: 0, z: 0, rotY: 0 };
    const x = num(sp.x), z = num(sp.z);
    const y = Number.isFinite(sp.y) ? sp.y : findFloor(map.world, x, z);
    player.spawn({ x, y, z, rotY: num(sp.rotY) });
    const lo = resolveLoadout(o.loadout);
    arsenal.resetRound({ ...lo, draw: true });
    local.loadout = lo[SLOT_KEYS[rulesetOf(ruleset).pickSlot]];
    local.alive = true;
    local.spawned = true;
    local.ownDrops.clear();
    spec.id = null; spec.name = '';
    latch.fire = latch.rmb = latch.reload = false; latch.slot = null; latch.wheel = 0;
    vm.setVisible(true);
    player.setSpeedScale(arsenal.getMoveMul());
    syncFrozen();
    R.setFov(R.baseFov);
    input.setLookScale(1);
    respawn = null; quick = null;
    syncQuickTouch(false);
    protectUntil = num(o.protectMs) > 0 ? performance.now() + num(o.protectMs) : 0;
    return player.state;
  }

  /* ---------- 모드 · 부활 · 보호 (개인전) ---------- */
  const avatarTeam = (a) => (mode === 'ffa' ? 'charterer' : a.team || 'charterer');   // 개인전: 다른 사람은 모두 한 가지 '적' 색
  // 이름표 앞 상태 표시: 🛡 부활 보호(개인전), 💣 폭탄을 든 아군(폭파 미션, bombView.carrier는 내가 공격 팀일 때만 채워진다).
  // 적의 이름표는 이름 없이 이 표시만 보인다(engine/nametag.js) → 개인전에서도 다른 사람의 닉네임은 머리 위에 뜨지 않는다
  const avatarBadge = (a) => [a.protectUntil > performance.now() ? '🛡' : '', mode === 'bomb' && bombView.carrier === a.id ? '💣' : ''].filter(Boolean).join(' ');
  function refreshAvatar(a) { avatars.add(a.id, { name: a.name, badge: avatarBadge(a), team: avatarTeam(a), avatar: a.avatar }); }

  /**
   * 규칙에 맞는 3슬롯 장비. pick = 규칙의 pickSlot 무기. 없거나 이 규칙에서 못 고르는 무기면 직전 선택 → 계정 장비 → 규칙 기본값 순서로 찾는다.
   * 스나전은 pickSlot이 1이라 주무기가 항상 저격총이 되고, 칼전은 슬롯 1·2·4가 잠겨 있어 칼 슬롯만 의미가 있다.
   */
  function resolveLoadout(pick) {
    const rs = rulesetOf(ruleset);
    const acc = accountLoadout();
    const key = SLOT_KEYS[rs.pickSlot];
    const allowed = pickableWeapons(ruleset);
    const chosen = [pick, local.loadout, acc[key]].find((id) => allowed.includes(id)) || rs.defaultPick;
    return { ...acc, [key]: chosen };
  }
  /** 살아 있지 않을 때의 무기 교체는 아무도 못 본다 → 다음 스폰에서 교체 소리가 나지 않게 이벤트를 비우고 모형만 맞춘다 */
  function settleArsenal() {
    if (local.spawned && local.alive) return;
    arsenal.update(0, null, null);
    vm.setWeapon(arsenal.getWeapon().id);
  }
  /** 'classic' | 'knife' | 'sniper' — 쓸 수 있는 슬롯과 무기를 맞춘다. loadMap(mapId, { ruleset })도 같다. unloadMap은 클래식으로 되돌린다 */
  function setRuleset(id) {
    ruleset = normalizeRuleset(typeof id === 'string' ? id : DEFAULT_RULESET);   // 방 메타에서 온 값일 수 있다
    if (local.loadout && !pickableWeapons(ruleset).includes(local.loadout)) local.loadout = null;
    arsenal.setAllowedSlots(rulesetOf(ruleset).slots);
    arsenal.setLoadout(resolveLoadout());
    settleArsenal();
    return ruleset;
  }

  /** 'team' | 'ffa' | 'bomb'(폭파 미션 = 팀전 화면 + 폭탄) — loadMap 직후 한 번(loadMap(mapId, { mode })도 같다). unloadMap은 'team'으로 되돌린다 */
  function setMode(m) {
    mode = m === 'ffa' || m === 'bomb' ? m : 'team';
    avatars.setLocalTeam(mode === 'ffa' ? null : local.team);
    for (const a of actors.values()) refreshAvatar(a);
    return mode;
  }
  /** 내 부활 대기 표시: { inMs, killer?, weaponName? } | null. spawnLocal이 지운다 */
  function setRespawn(o) {
    if (!o) { respawn = null; return; }
    respawn = { at: performance.now() + Math.max(0, num(o.inMs, num(o.ms, 0))), killer: o.killer ? String(o.killer) : '', weaponName: o.weaponName ? String(o.weaponName) : '' };
  }

  /**
   * 개인전 즉시 부활: { cost, ok } | null. 부활 대기 패널에 'E 즉시 부활 · cost P'를 띄우고 E(휴대폰 '부활' 버튼)를 받는다.
   * ok:false(포인트 부족)면 안내만 바뀌고 E는 알림만 띄운다. 요청은 World 'quickRespawn' { cost }로 나가고, 확정·결제는 부르는 쪽이 한다.
   * 같은 죽음에서 다시 불러도(스냅샷마다) 요청 간격은 이어진다. spawnLocal·loadMap·unloadMap이 지운다
   */
  function setQuickRespawn(o) {
    const cost = o ? Math.floor(num(o.cost, 0)) : 0;
    if (!(cost > 0)) { quick = null; return; }
    if (!quick) quickSentAt = -Infinity;
    quick = { cost, ok: o.ok !== false };
  }
  /** 지금 즉시 부활을 받을 수 있나: 개인전 · 부활 대기 중 · 부활까지 넉넉히 남음(곧 저절로 나오면 내지 않게) */
  function quickOpen(now = displayNow()) {
    return !!quick && mode === 'ffa' && active && !!respawn && !(local.spawned && local.alive) && respawn.at - now > QUICK_HIDE_MS;
  }
  function requestQuick() {
    if (simPaused || uiPaused || !quickOpen()) return;
    const t = performance.now();
    if (t - quickSentAt < QUICK_RETRY_MS) return;    // 방장 응답을 기다리는 동안 거듭 누른 것
    if (!quick.ok) { if (ui) ui.hud.callout(`포인트가 부족해요 · 즉시 부활 ${quick.cost} P`); return; }
    quickSentAt = t;
    emit('quickRespawn', { cost: quick.cost });
  }
  /** 휴대폰: 즉시 부활을 쓸 수 있는 동안 설치/해체 버튼을 '부활'로 보인다(개인전에는 폭탄이 없어 버튼이 비어 있다) */
  function syncQuickTouch(on) {
    if (on === quickTouch) return;
    quickTouch = on;
    bus.emit('touch:use', { on, label: '부활' });
  }
  /** 내 보호(무적) 표시: ms(>0) 동안 · true = 끌 때까지 · false/0 = 끔 */
  function setProtect(v) {
    protectUntil = v === true ? Infinity : num(v) > 0 ? performance.now() + num(v) : 0;
  }
  /** 다른 사람 보호 표시(이름표 🛡): ms(>0) 동안 · true = 끌 때까지 · false/0 = 끔 */
  function setActorProtect(id, v) {
    const a = actors.get(String(id));
    if (!a) return;
    const until = v === true ? Infinity : num(v) > 0 ? performance.now() + num(v) : 0;
    const was = a.protectUntil > performance.now();
    a.protectUntil = until;
    if (was !== (until > performance.now())) refreshAvatar(a);
  }

  /* ---------- 이모트 (MODES.md 4절) ----------
   * 목록·입력·3인칭 카메라·아바타 리그는 core, 휠 화면·hud.emote는 UI, 소리는 fx. World는 이들을 잇는다.
   * 전송값 = 이모트 번호(code 1~15, 0 = 없음). player.state.emote·원격 state.emote는 번호 또는 id를 모두 받는다. */
  let emoteLocal = 0;              // 지금 내 이모트 번호
  let emoteSnd = null;             // 내 이모트 소리(2D)
  let emoteBlockUntil = 0;         // 이모트가 끝난 직후(취소 클릭 등) 사격 막기
  const wheel = { open: false };
  let emoteSrc = null, emoteCache = [];
  function emoteList() {
    const E = ctx.consts && ctx.consts.EMOTES;
    if (E === emoteSrc) return emoteCache;
    emoteSrc = E;
    const arr = Array.isArray(E) ? E : E && typeof E === 'object' ? Object.values(E) : [];
    return (emoteCache = arr.filter(Boolean).map((e, i) => ({
      id: String(e.id), code: num(e.code ?? e.num ?? e.n, i + 1) | 0, name: e.name || e.id, icon: e.icon || '',
      loop: e.loop != null ? !!e.loop : !(num(e.duration ?? e.durationMs, 0) > 0), duration: num(e.duration, 0)
    })));
  }
  function emoteInfo(v) {
    if (v == null || v === 0 || v === '' || v === false) return null;
    const list = emoteList();
    return typeof v === 'number' ? list.find((e) => e.code === v) || null : list.find((e) => e.id === String(v)) || null;
  }
  const emoteCode = (v) => { if (typeof v === 'number') return v | 0; const e = emoteInfo(v); return e ? e.code : 0; };
  const localEmoteNow = () => emoteCode(player.state.emote);
  function emoteBusy() { return wheel.open || !!localEmoteNow() || performance.now() < emoteBlockUntil; }
  /** core 3인칭 정도(0..1) — 이모트 시작·끝 0.15초 전환 동안에도 뷰모델·크로스헤어를 숨긴다 */
  function thirdAmount() {
    const t = typeof player.thirdPerson === 'function' ? player.thirdPerson() : player.thirdPerson;
    return num(t, emoteLocal ? 1 : 0);
  }
  /** 이모트 소리: pos가 있으면 3D(원격, 작게), 없으면 2D(나). fx API(playEmote)가 없으면 이름 규칙으로 재생 */
  /** fx audio.emote(idOrCode, { pos? }) → { stop(fadeMs), setPos(pos) }. pos가 있으면 원격 3D(작게), 없으면 내 2D.
   *  반복형은 stop()까지 루프, 경례·손 흔들기는 한 번 재생하고 저절로 정리된다 */
  function emoteSound(code, pos) {
    const e = emoteInfo(code);
    if (!e || typeof audio.emote !== 'function') return null;
    try { return audio.emote(e.code, pos ? { pos } : {}) || null; } catch (err) { return null; }
  }
  function stopSound(h) {
    if (!h || typeof h.stop !== 'function') return;
    try { h.stop(150); } catch (err) { /* ignore */ }            // fadeMs
  }
  /* 상점 미리 듣기: 내 소리(2D)로 잠깐 재생한다. 음원 묶음을 읽는 중이면 조금(최대 3초) 기다렸다가 파일로 들려주고,
   * 그래도 늦으면 합성음으로 시작했다가 파일이 준비되는 즉시 파일로 바뀐다(fx/audio.js) */
  const PREVIEW_MS = 4000;
  let previewSnd = null, previewTimer = 0, previewSeq = 0;
  function stopEmotePreview() {
    previewSeq++;
    clearTimeout(previewTimer);
    stopSound(previewSnd);
    previewSnd = null;
  }
  async function previewEmote(id) {
    stopEmotePreview();
    const e = emoteInfo(id);
    if (!e || typeof audio.emote !== 'function') return false;
    const seq = previewSeq;
    if (typeof audio.emoteFilesReady === 'function') {
      try { await Promise.race([audio.emoteFilesReady(), new Promise((r) => setTimeout(r, 3000))]); } catch (err) { /* 합성음으로 */ }
    }
    if (seq !== previewSeq) return false;
    previewSnd = emoteSound(e.code, null);
    previewTimer = setTimeout(stopEmotePreview, PREVIEW_MS);
    return !!previewSnd;
  }
  /** 내 이모트를 취소(피해·죽음·스폰). core가 player.cancelEmote를 준다 */
  function cancelLocalEmote(reason) {
    if (localEmoteNow() && typeof player.cancelEmote === 'function') { try { player.cancelEmote(reason); } catch (err) { /* ignore */ } }
    syncLocalEmote();
  }
  /** 내 이모트 상태가 바뀌었으면 소리·뷰모델을 맞춘다(매 틱 + core 'player:emote' 이벤트) */
  function syncLocalEmote() {
    const code = local.spawned && local.alive ? localEmoteNow() : 0;
    if (code === emoteLocal) return;
    stopSound(emoteSnd);
    emoteSnd = null;
    if (emoteLocal && !code) emoteBlockUntil = performance.now() + 150;   // 취소 클릭이 곧바로 사격이 되지 않게
    emoteLocal = code;
    if (code) {
      emoteSnd = emoteSound(code, null);
      latch.fire = false;
    }
    vm.setVisible(local.spawned && local.alive && !code);
  }

  /* 이모트 휠(MODES.md 4.2) — 커서·강조 칸 계산과 B를 뗄 때의 시작은 core(input·player)가 한다.
   * World는 core 'input:emoteWheel' {open, cursor, selected, ...}를 UI 'emotes' 화면에 그대로 옮기고,
   * 시작이 거절되면('player:emote-denied') 안내를 띄운다. */
  const NOT_STILL = '멈춘 상태에서만 할 수 있어요';
  /** 휠 8칸의 이모트 id: 계정 장비(상점에서 고른 순서), 계정이 없으면 기본 휠 */
  function wheelIdsNow() {
    const ids = ctx.account && ctx.account.emoteWheel;
    return Array.isArray(ids) && ids.length ? ids : DEFAULT_EMOTE_WHEEL;
  }
  function wheelItems() {
    const list = emoteList();
    return wheelIdsNow().map((id) => list.find((e) => e.id === id)).filter(Boolean)
      .map((e) => ({ id: e.id, code: e.code, name: e.name, icon: e.icon, loop: e.loop }));
  }
  /** 입력(core)이 칸 → 이모트를 같은 목록으로 고르게 한다. 상점에서 바꾸면 account:change로 다시 맞춘다 */
  function syncWheelInput() {
    if (typeof input.setEmoteWheel === 'function') input.setEmoteWheel(wheelIdsNow().slice());
  }
  offs.push(bus.on('account:change', syncWheelInput));
  syncWheelInput();
  function onEmoteWheel(e) {
    if (!active || !ui || !e) return;
    const open = !!e.open && local.spawned && local.alive;
    const props = { selected: e.selected == null ? null : e.selected, cursor: e.cursor || { x: 0, y: 0 }, tap: !!e.tap };
    if (open) {
      latch.fire = false; rmbDown = false;
      if (!wheel.open) { wheel.open = true; ui.show('emotes', Object.assign({ items: wheelItems() }, props)); }
      else ui.update('emotes', props);
    } else closeWheel();
  }
  function closeWheel() {
    if (!wheel.open) return;
    wheel.open = false;
    emoteBlockUntil = performance.now() + 150;      // 휠을 닫은 클릭·뗌이 곧바로 사격이 되지 않게
    if (ui) ui.hide('emotes');
  }
  function onEmoteDenied(e) {
    if (!active || !ui) return;
    const r = e && e.reason;
    if (r === 'moving' || r === 'air' || r === 'crouch') ui.hud.center(NOT_STILL, 1600, { tone: 'warn' });
  }
  /** (API·시험용) 내 이모트를 바로 시작. 보통은 core가 휠 선택으로 시작한다 */
  function startLocalEmote(id) {
    if (!local.spawned || !local.alive || typeof player.startEmote !== 'function') return false;
    let ok = false;
    try { const r = player.startEmote(id); ok = r && typeof r === 'object' ? !!r.ok : r !== false; } catch (err) { ok = false; }   // core: { ok, reason }
    syncLocalEmote();
    return ok && !!emoteLocal;
  }

  /**
   * 무기 하나를 슬롯에 넣는다(주무기·보조·칼 모두). 이 규칙에서 못 쓰는 무기는 false.
   * 규칙이 고르게 하는 슬롯(pickSlot)의 무기면 다음 스폰의 기본값으로도 기억한다.
   */
  function setLocalLoadout(id) {
    const def = getDef(id);
    const key = def ? SLOT_KEYS[def.slot] : null;
    if (!key || !isWeaponAllowed(ruleset, id)) return false;
    if (pickableWeapons(ruleset).includes(id)) local.loadout = id;
    arsenal.setLoadout({ [key]: id });
    settleArsenal();
    return true;
  }

  function setLocalHp(hp) {
    const v = Math.max(0, Math.round(num(hp, player.state.hp)));
    const before = player.state.hp;
    if (v < before && local.alive) { player.addShake(Math.min(0.4, (before - v) / 150)); cancelLocalEmote('damage'); }
    player.state.hp = v;
  }

  function killLocal(info = {}) {
    if (!local.spawned || !local.alive) return;
    cancelLocalEmote('death');
    bombView.onLocalDeath();
    dropOnDeath();     // 총을 든 채 죽으면 그 총이 떨어진다(남은 탄 그대로)
    local.alive = false;
    multiKill.reset(); // 연속 킬은 살아 있는 동안만 이어진다
    local.ownDrops.clear();
    local.deadAt = performance.now();
    rmbDown = false;   // 누른 채 죽었으면 부활하자마자 조준 사격을 이어 가지 않는다
    if (ctx.renderer.applyPendingQuality) ctx.renderer.applyPendingQuality();   // 미뤄 둔 자동 품질 변경은 죽었을 때 치른다
    player.kill(info || {});
    vm.setVisible(false);
    if (ui) ui.scope.set(0);
    spec.id = null; spec.idx = 0; spec.name = '';
    spec.yaw = player.state.yaw;
    emit('localDeath', { id: local.id, info: info || {} });
  }

  /* ---------- 바닥에 버린 총 ----------
   * 살아 있을 때 G를 누르면 손에 든 주무기·보조무기를 앞 발밑에 버린다(칼로 바꿔 빨리 달리는 재미). 총을 든 채 죽으면 그 총이 떨어진다.
   * 그 총의 칸(주무기·보조)이 빈 사람이 닿으면 주워서 남은 탄 그대로 쓴다. 방금 내가 버린 총은 한 번 벗어난 뒤부터 줍는다.
   * 받은 총은 이번 목숨에만 쓴다. 다음 스폰은 자기 장비로 돌아간다(spawnLocal → resetRound). */
  function dropLabel(text, premium) {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 64;
    const g = c.getContext('2d');
    g.font = '700 30px "Noto Sans KR", "Malgun Gothic", sans-serif';
    const tw = Math.min(236, g.measureText(text).width + 28);
    g.fillStyle = 'rgba(8,14,24,0.7)';
    g.beginPath();
    if (g.roundRect) g.roundRect((256 - tw) / 2, 10, tw, 44, 12); else g.rect((256 - tw) / 2, 10, tw, 44);
    g.fill();
    g.fillStyle = premium ? '#ffd76a' : '#ffffff';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, 128, 32, 228);
    const map = new THREE.CanvasTexture(c);
    map.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map, transparent: true, depthWrite: false }));
    sprite.scale.set(0.9, 0.225, 1);
    sprite.position.y = 0.72;
    return sprite;
  }
  function addDropView(d) {
    const def = getDef(d.weaponId);
    const group = new THREE.Group();
    group.name = 'world:drop';
    group.position.set(d.pos[0], d.pos[1], d.pos[2]);
    const ring = new THREE.Mesh(dropRingGeo, def.premium ? dropRingPremium : dropRingMat);
    ring.position.y = 0.03;
    const spin = new THREE.Group();
    spin.position.y = 0.34;
    const gun = droppedGunMesh();
    gun.position.z = 0.18;                        // 모형의 가운데를 돌림축에 맞춘다
    gun.rotation.z = 0.9;
    spin.add(gun);
    const label = dropLabel(def.short, !!def.premium);
    group.add(ring, spin, label);
    R.scene.add(group);
    dropViews.set(d.id, { group, spin, label });
  }
  function removeDropView(id) {
    const v = dropViews.get(id);
    if (!v) return;
    dropViews.delete(id);
    R.scene.remove(v.group);
    v.label.material.map.dispose();
    v.label.material.dispose();
  }
  /** 항목 { id, weaponId, pos, mag, reserve }를 바닥에 놓는다. 이 규칙에서 못 쓰는 총이나 깨진 값이면 null */
  function addDrop(o) {
    if (!active || !o || !isWeaponAllowed(ruleset, o.weaponId)) return null;
    const { drop, evicted } = drops.add(o);
    for (const d of evicted) removeDropView(d.id);
    if (drop) addDropView(drop);
    return drop;
  }
  function removeDrop(id) {
    const d = drops.remove(String(id));
    if (d) removeDropView(d.id);
    return !!d;
  }
  function clearDrops() {
    for (const d of drops.clear()) removeDropView(d.id);
  }
  /** 발밑 바닥 높이. 공중에서 죽었어도 바닥에 놓는다 */
  function floorUnder(p) {
    const h = map ? raycastWorld(map.world, [p[0], p[1] + 0.5, p[2]], [0, -1, 0], 60) : null;
    return h ? p[1] + 0.5 - h.dist : p[1];
  }
  /** 내 총 { id, mag, reserve }를 pos에 놓고 모두에게 알린다. 탄이 하나도 없는 총은 쓸모가 없어 놓지 않는다 */
  function placeLocalDrop(gun, pos) {
    if (!gun || !(gun.mag > 0 || gun.reserve > 0)) return null;
    const dropId = `${local.id}#${++dropSeq}`;
    const drop = addDrop({ id: dropId, weaponId: gun.id, pos: r2(pos), mag: gun.mag, reserve: gun.reserve });
    if (!drop) return null;
    emit('weaponDrop', { dropId, weaponId: gun.id, pos: drop.pos, mag: gun.mag, reserve: gun.reserve });
    return drop;
  }
  /** (살아 있을 때 G) 손에 든 주무기·보조무기를 앞 발밑에 버린다. 앞이 벽이면 발밑에 둔다 */
  function dropHeldGun() {
    if (!active || !map || !local.spawned || !local.alive || rnd.phase !== 'live' || !localCanAct()) return false;
    const gun = arsenal.dropHeld();
    if (!gun) return false;
    const p = player.state.pos;
    const aim = player.getAimDir();
    const len = Math.hypot(aim[0], aim[2]) || 1;
    let at = [p[0] + (aim[0] / len) * 0.9, p[1], p[2] + (aim[2] / len) * 0.9];
    if (!lineOfSight(map.world, [p[0], p[1] + 0.5, p[2]], [at[0], p[1] + 0.5, at[2]])) at = [p[0], p[1], p[2]];
    at[1] = floorUnder(at);
    const d = placeLocalDrop(gun, at);
    if (d) local.ownDrops.add(d.id);   // 방금 버린 총은 한 번 벗어날 때까지 다시 줍지 않는다
    play('switch', { gain: 0.7 });
    if (ui) ui.hud.callout(`${getDef(gun.id).short} 버림`);
    return true;
  }
  /** 총을 든 채 죽으면 그 총이 바닥에 떨어진다(남은 탄 그대로). killLocal이 상태를 바꾸기 전에 부른다 */
  function dropOnDeath() {
    if (!active || !map || rnd.phase !== 'live') return;
    const held = arsenal.getWeapon();
    const def = getDef(held.id);
    if (!def || (def.slot !== 1 && def.slot !== 2) || !isWeaponAllowed(ruleset, held.id)) return;
    const a = arsenal.getAmmo(held.id);
    const p = player.state.pos;
    placeLocalDrop({ id: held.id, mag: a.mag, reserve: a.reserve }, [p[0], floorUnder(p), p[2]]);
  }
  /** 그 총의 칸이 비어 있어 주울 수 있는가 */
  const canTake = (d) => { const def = getDef(d.weaponId); return !!def && arsenal.isSlotEmpty(def.slot); };
  /** 닿은 총을 줍는다: 그 총의 칸(주무기·보조)이 비어 있을 때만. 방금 내가 버린 총은 한 번 벗어난 뒤부터 */
  function pickNearbyGun() {
    if (!drops.size) { local.ownDrops.clear(); return; }
    const p = player.state.pos;
    for (const id of local.ownDrops) {
      const own = drops.list().find((d) => d.id === id);
      if (!own || Math.hypot(own.pos[0] - p[0], own.pos[2] - p[2]) > DROP_RADIUS + 0.4) local.ownDrops.delete(id);
    }
    const d = drops.nearest(p, (x) => !local.ownDrops.has(x.id) && canTake(x));
    if (!d || !arsenal.takeWeapon(d.weaponId, { mag: d.mag, reserve: d.reserve })) return;
    removeDrop(d.id);
    play('switch');
    if (ui) ui.hud.callout(`${getDef(d.weaponId).short} 획득`);
    emit('weaponPick', { dropId: d.id, weaponId: d.weaponId });
  }
  /** 총 위에 섰는데 그 칸에 무기가 있어 줍지 못할 때의 안내 */
  function pickHint() {
    if (!local.spawned || !local.alive || !drops.size || rnd.phase !== 'live') return '';
    const d = drops.nearest(player.state.pos, (x) => !local.ownDrops.has(x.id));
    if (!d || canTake(d)) return '';
    const def = getDef(d.weaponId);
    const slotName = def.slot === 1 ? '주무기' : '보조무기';
    const how = input.touchMode ? '무기 칸을 길게 눌러' : '들고 G를 눌러';
    return `${def.short}: ${slotName}를 ${how} 버리면 주울 수 있어요`;
  }

  /* ---------- 로컬 무기 ---------- */
  function onWeaponEvent(ev) {
    vm.play(ev);
    if (ev.type === 'fire' || ev.type === 'swing' || ev.type === 'throw') bombView.onLocalFire();   // 폭파 미션: 공격하면 설치·해체 취소
    switch (ev.type) {
      case 'fire': localFire(ev); break;
      case 'melee': localMelee(ev); break;
      case 'throw': localThrow(ev); break;
      case 'swing': {
        const def = getDef(ev.weaponId);
        if (def) play(ev.kind === 'stab' ? def.heavySound : def.sound);
        const eye = player.getEye();
        emit('fire', { id: local.id, weaponId: ev.weaponId, origin: r3(eye), dir: r3(player.getAimDir()), hitPoint: null, hitKind: 'none', dist: 0, t: performance.now(), kind: ev.kind, quickscope: false, noscope: false });
        break;
      }
      case 'dryFire': play('dry_fire'); break;
      case 'reloadStart':
        cancelScheduled('reload');
        play('reload_mag_out');
        schedule(num(ev.duration, 2) * 0.62, 'reload_mag_in', null, 'reload');
        break;
      case 'reloadCancel': cancelScheduled('reload'); break;
      case 'boltCycle': schedule(0.18, 'bolt', null, 'bolt'); break;
      case 'switch':
        cancelScheduled('reload'); cancelScheduled('bolt');
        player.state.slot = ev.slot;
        player.state.weapon = ev.to;
        if (!ev.reset) play('switch', { gain: 0.7 });
        break;
      case 'prime': play('grenade_pin'); break;
      case 'zoomChange':
        if (!ev.zoomed && arsenal.getZoomMode() === 'toggle') input.resetAim();
        break;
      default: break;
    }
  }

  /** 사격 대상 = core getTargets(+앉은 상태). core 아바타가 crouch를 안 실어 주면 액터 상태에서 채운다 */
  function targets() {
    const list = ctx.getTargets();
    for (const t of list) {
      if (t.crouch !== undefined) continue;
      const a = actors.get(String(t.id));
      if (a && a.state && a.state.crouch) t.crouch = true;
    }
    return list;
  }

  /**
   * 사격 한 번. 펠릿을 모두 트레이스하고, 맞힌 사람마다 주장을 하나씩 낸다.
   * 주장의 part는 그 사람에게 맞은 펠릿 중 가장 좋은 부위, count는 맞은 펠릿 수다(데미지 = 표값 × count, computeDamage).
   * 같은 발의 주장은 t와 shotId가 같아서 match의 연사 검사를 한 번만 받는다.
   */
  function localFire(ev) {
    const st = player.state;
    const eye = player.getEye();
    const def = getDef(ev.weaponId);
    const fxKind = (def && def.fxKind) || 'rifle';
    const range = num(ev.maxRange, def ? def.maxRange : 300);
    const list = shotTargets(targets(), mode, local.team);   // 팀전: 아군 몸은 통과한다
    const m = vm.getMuzzleWorld(tmpV, R.camera);
    const pellets = ev.pellets && ev.pellets.length ? ev.pellets.length : 1;
    const byVictim = new Map();
    let muzzle = null;
    let shown = null;   // fire 이벤트에 실을 펠릿: 사람을 맞힌 첫 펠릿, 없으면 첫 펠릿
    for (let i = 0; i < pellets; i++) {
      // 앉아 있을 때 탄퍼짐 ×0.8은 arsenal이 한다(motion.crouch) — ev.pellets에 이미 반영돼 있다
      const dv = shotDirection(st.yaw, st.pitch, ev, i);
      const d = [dv[0], dv[1], dv[2]];
      const hit = traceShot(map.world, eye, d, range, list);
      if (!muzzle) muzzle = m ? [m.x, m.y, m.z] : [eye[0] + d[0] * 0.6, eye[1] + d[1] * 0.6 - 0.1, eye[2] + d[2] * 0.6];
      if (i < PELLET_TRACERS) fx.tracer(muzzle, hit.point, fxKind);
      if (hit.kind === 'world') fx.impact(hit.point, hit.normal, hit.mat, hit.collider && hit.collider.dynamic ? NO_DECAL : null);
      else if (hit.kind === 'player') fx.impact(hit.point, [-d[0], -d[1], -d[2]], 'player');
      props.bulletHit(eye, d, hit.dist);
      if (!shown || (hit.kind === 'player' && shown.hit.kind !== 'player')) shown = { hit, d };
      if (hit.kind === 'player') {
        const v = byVictim.get(hit.id);
        if (!v) byVictim.set(hit.id, { hit, count: 1 });
        else {
          v.count++;
          if (PART_RANK[hit.part] < PART_RANK[v.hit.part]) v.hit = hit;
        }
      }
    }
    fx.shellEject(muzzle, shown.d, { groundY: st.pos[1], kind: fxKind });
    play((def && def.sound) || 'rifle');
    const t = performance.now();
    const shotId = ++shotSeq;
    const { hit, d } = shown;
    const payload = {
      id: local.id, weaponId: ev.weaponId, origin: r3(eye), dir: r3(d),
      hitPoint: hit.kind === 'none' ? null : r3(hit.point), hitKind: hit.kind, dist: round2(hit.dist), t,
      quickscope: !!ev.quickscope, noscope: !!ev.noscope, spread: Math.round(num(ev.spreadDeg) * 100) / 100,
      shotId, pellets
    };
    if (hit.kind === 'player') { payload.victimId = hit.id; payload.part = hit.part; }
    if (hit.kind === 'world') { payload.normal = r3(hit.normal); payload.mat = hit.mat; }
    emit('fire', payload);
    if (byVictim.size) protectUntil = 0;         // 먼저 공격하면 보호 끝(match 규칙과 같게 표시)
    for (const [victimId, v] of byVictim) {
      emit('hitClaim', {
        victimId, part: v.hit.part, weaponId: ev.weaponId, dist: round2(v.hit.dist), kind: 'shot', t,
        point: r3(v.hit.point), origin: r3(eye), count: v.count, shotId
      });
    }
  }

  function localMelee(ev) {
    const eye = player.getEye();
    const fwd = player.getAimDir();
    const hit = meleeTrace(map.world, eye, fwd, num(ev.range, 1.8), num(ev.arc, 0.6), targets(), local.id);
    if (!hit) return;
    const def = getDef(ev.weaponId);
    if (def) play(def.hitSound);
    fx.slashSpark(hit.point, [-fwd[0], -fwd[1], -fwd[2]]);
    protectUntil = 0;
    emit('hitClaim', {
      victimId: hit.id, part: hit.part, weaponId: ev.weaponId, dist: hit.dist, kind: ev.kind === 'stab' ? 'stab' : 'slash',
      t: performance.now(), point: hit.point, origin: r3(eye), count: 1, shotId: ++shotSeq
    });
  }

  function localThrow(ev) {
    if (!nades) return;
    const st = player.state;
    const eye = player.getEye();
    const fwd = player.getAimDir();
    const gid = `${local.id}#${++grenadeSeq}`;
    const g0 = nades.throwFrom({ eye, forward: fwd, speed: ev.speed, pitchUp: ev.pitchUp, fuse: ev.fuse, owner: local.id, inherit: st.vel, inheritScale: 0.5, id: gid });
    // 보낼 값(protocol.encodeGrenade의 cm 해상도)과 내가 시뮬레이션하는 값을 똑같이 → 모든 클라이언트가 같은 궤적
    const pos = r2(g0.pos), vel = r2(g0.vel);
    nades.remove(gid);
    nades.spawn(pos, vel, { owner: local.id, fuse: g0.fuse, id: gid });
    emit('grenade', { id: local.id, grenadeId: gid, pos, vel, fuse: g0.fuse, t: performance.now(), kind: ev.kind });
  }

  /* ---------- 수류탄 ---------- */
  function onGrenadeEvent(e) {
    if (e.type === 'bounce') { play('grenade_bounce', { pos: e.pos, gain: Math.min(1, num(e.speed, 2) / 6) }); return; }
    if (e.type !== 'explode') return;
    const c = arr3(e.pos);
    fx.explosion(c, { radius: WEAPONS.gr_frag.explosion.radius });
    props.explode(c, WEAPONS.gr_frag.explosion.radius);
    play('explosion', { pos: c });
    const targets = [];
    // 앉은 사람은 판정점(다리·몸·머리)도 낮다 → height = 앉은 키 1.25 m
    if (local.spawned && local.alive) targets.push({ id: local.id, pos: player.state.pos, height: player.state.crouch ? CROUCH_H : PLAYER.HEIGHT });
    for (const a of actors.values()) if (a.alive && a.state) targets.push({ id: a.id, pos: a.state.pos, height: a.state.crouch ? CROUCH_H : PLAYER.HEIGHT });
    const res = nades ? nades.explosionDamage(c, targets) : [];
    const victims = [];
    for (const r of res) if (r.damage > 0) victims.push({ id: r.id, dmg: r.damage, dist: round2(r.dist) });
    if (e.owner === local.id) protectUntil = 0;   // 수류탄 피해 주장도 '먼저 공격' → 보호 끝(match 규칙과 같게)
    emit('explosion', { ownerId: e.owner, local: e.owner === local.id, grenadeId: e.id, center: { x: c[0], y: c[1], z: c[2] }, pos: r3(c), victims });
  }

  function actorGrenade(o = {}) {
    if (!nades || !o) return null;
    const gid = o.grenadeId != null ? String(o.grenadeId) : `${o.id}#r${++grenadeSeq}`;
    const live = nades.list();
    if (live.length >= MAX_LIVE_GRENADES || live.some((g) => g.id === gid)) return null;   // 한도(프레임 하나에 수천 개를 보내도 끄떡없게) · 중복 수신
    const fuse = num(o.fuse, WEAPONS.gr_frag.fuse);
    const g = nades.spawn(arr3(o.pos), arr3(o.vel), { owner: o.id != null ? String(o.id) : null, fuse, id: gid });
    // 늦게 받은 만큼 앞당기기(폭발 직전까지만)
    const lag = Number.isFinite(o.t) ? (performance.now() - o.t) / 1000 : 0;
    if (g && lag > 0.02) {
      let left = Math.min(lag, Math.max(0, fuse - 0.1));
      const sweep = map && map.world ? map.world.sphereSweep : null;
      while (left > 1e-4) {
        const h = Math.min(0.25, left);
        stepGrenade(g, h, sweep, { style: nades.sweepStyle, physics: GRENADE_PHYSICS, floorY: 0 });
        left -= h;
      }
    }
    return gid;
  }

  function drawGrenades() {
    const list = nades ? nades.list() : [];
    for (let i = 0; i < list.length; i++) {
      const g = list[i], m = nadeMesh(i);
      m.visible = true;
      m.position.set(g.pos[0], g.pos[1], g.pos[2]);
      if (!g.sleeping) m.rotation.set(g.age * 9, 0, g.age * 5.5);
    }
    for (let i = list.length; i < nadeMeshes.length; i++) nadeMeshes[i].visible = false;
  }

  /* ---------- 액터(원격·봇) ---------- */
  function addActor(o = {}) {
    const id = o.id != null ? String(o.id) : '';
    if (!id || id === local.id) return null;
    const team = o.team === 'owner' || o.team === 'charterer' ? o.team : mode === 'ffa' ? null : 'charterer';
    let a = actors.get(id);
    if (!a) {
      a = { id, name: String(o.name || id), team, kind: o.kind === 'bot' ? 'bot' : 'remote', alive: true, state: null, step: 0, last: null, protectUntil: 0, slot: null, weaponId: null, avatar: avatarIdOf(o.avatar) };
      actors.set(id, a);
    } else {
      if (o.name) a.name = String(o.name);
      a.team = team;
      if (o.kind) a.kind = o.kind === 'bot' ? 'bot' : 'remote';
      if (o.avatar !== undefined) a.avatar = avatarIdOf(o.avatar);
    }
    refreshAvatar(a);
    return a;
  }
  function removeActor(id) {
    const k = String(id);
    const old = actors.get(k);
    if (old) stopSound(old.emoteSnd);
    actors.delete(k);
    avatars.remove(k);
    if (spec.id === k) spec.id = null;
  }
  function clearActors() { for (const id of Array.from(actors.keys())) removeActor(id); }

  /**
   * 액터가 든 무기를 기억한다(아바타 표시, DESIGN 9절). 무기를 알려 주면 슬롯도 정해지고,
   * 슬롯만 바뀌었는데 지금 아는 무기가 그 슬롯이 아니면 무기를 지운다(아바타가 슬롯 기본 모형을 쓴다).
   */
  function noteActorWeapon(a, weaponId, slot) {
    const def = weaponId != null ? getDef(weaponId) : null;
    if (def) { a.weaponId = def.id; a.slot = def.slot; return; }
    if (slot == null) return;
    const n = num(slot, 0) | 0;
    if (n === a.slot) return;
    a.slot = n;
    const known = a.weaponId ? getDef(a.weaponId) : null;
    if (known && known.slot !== n) a.weaponId = null;
  }

  function setActorState(id, s) {
    if (!s || !s.pos) return;
    const a = actors.get(String(id)) || addActor({ id, name: s.name, team: s.team, avatar: s.avatar });
    if (!a) return;
    if (s.avatar !== undefined && avatarIdOf(s.avatar) !== a.avatar) { a.avatar = avatarIdOf(s.avatar); refreshAvatar(a); }   // 캐릭터(모르는 id는 기본)
    noteActorWeapon(a, s.weaponId, s.slot);
    const p = arr3(s.pos);
    const alive = s.alive !== false;
    const crouch = !!s.crouch;
    const emote = alive ? emoteCode(s.emote) : 0;
    // crouch → core 아바타가 앉은 자세로 그리고, 히트 대상(getTargets)에도 실린다. emote → core 아바타 리그가 재생
    const snap = { pos: p, yaw: num(s.yaw), pitch: num(s.pitch), alive, moving: !!s.moving, crouch, emote, slot: a.slot, weaponId: a.weaponId };
    const av = avatars.get(a.id);
    const now = performance.now();
    if (alive && (s.teleport || !a.alive || (av && av.death))) {
      avatars.teleport(a.id, snap, now);
      a.last = null; a.step = 0;
    } else {
      avatars.push(a.id, now, snap);
    }
    a.alive = alive;
    if (s.protect !== undefined) {
      const on = !!s.protect && alive;
      if (on !== (a.protectUntil > now)) { a.protectUntil = on ? Infinity : 0; refreshAvatar(a); }
    }
    // 3D 발소리: 걷는 중(Shift 걷기는 조용, 앉아 걷기는 작게), 바닥에 있을 때
    if (alive && a.last && s.onGround !== false && !s.walking) {
      const d = Math.hypot(p[0] - a.last[0], p[2] - a.last[2]);
      const stride = crouch ? 1.6 : 2.1;
      if (d < 2.5) { a.step += d; if (a.step >= stride) { a.step = 0; footstep(p, crouch ? 0.35 : 0.9); } }
    }
    a.last = p;
    a.state = { pos: p, yaw: snap.yaw, pitch: snap.pitch, alive, moving: snap.moving, walking: !!s.walking, crouch, emote, onGround: s.onGround !== false, hp: s.hp, slot: a.slot, weaponId: a.weaponId };
    if (emote !== (a.emote || 0)) {                // 원격 이모트 소리(3D, 작게): 바뀔 때만 시작·정지
      stopSound(a.emoteSnd);
      a.emoteSnd = emote ? emoteSound(emote, [p[0], p[1] + 1.2, p[2]]) : null;
      a.emote = emote;
    } else if (a.emoteSnd && typeof a.emoteSnd.setPos === 'function') {
      a.emoteSnd.setPos([p[0], p[1] + 1.2, p[2]]);  // 보간 위치를 따라간다(fx 권장)
    }
  }

  function actorDeath(id, info = {}) {
    const a = actors.get(String(id));
    if (!a) return;
    a.alive = false;
    stopSound(a.emoteSnd); a.emoteSnd = null; a.emote = 0;
    let dir = null;
    if (info && info.dir) { const d = info.dir; dir = [num(d[0]), num(d[d.length === 3 ? 2 : 1])]; }
    const av = avatars.get(a.id);
    if (av) av.kill({ dir });
    if (a.state) {
      a.state.alive = false;
      avatars.push(a.id, performance.now(), { pos: a.state.pos, yaw: a.state.yaw, pitch: 0, alive: false, deathDir: dir });
    }
    if (spec.id === a.id) spec.id = null;
  }

  function actorFire(o = {}) {
    if (!active || !o) return;
    const w = o.weaponId;
    const origin = arr3(o.origin);
    const d = norm3(arr3(o.dir));
    const def = getDef(w);
    const shooter = actors.get(String(o.id));
    if (shooter) noteActorWeapon(shooter, w, null);
    if (def && def.melee) {
      play(o.kind === 'stab' ? def.heavySound : def.sound, { pos: origin });
      const av = avatars.get(String(o.id));
      if (av) av.swing(o.kind);                  // 3인칭: 든 칼을 휘두른다
      return;
    }
    const kind = (def && def.fxKind) || 'rifle';
    const yaw = Math.atan2(-d[0], -d[2]);
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    const muzzle = [origin[0] + d[0] * 0.75 + rx * 0.12, origin[1] + d[1] * 0.75 - 0.2, origin[2] + d[2] * 0.75 + rz * 0.12];
    fx.muzzleFlash(muzzle, d, kind);
    const range = (def && def.maxRange) || 250;
    const end = o.hitPoint ? arr3(o.hitPoint) : [origin[0] + d[0] * range, origin[1] + d[1] * range, origin[2] + d[2] * range];
    fx.tracer(muzzle, end, kind);
    if (def && def.pellets > 1) {
      // 원격 사격은 대표 펠릿 하나만 받는다. 나머지는 탄퍼짐 안쪽으로 몇 줄만 그려 산탄처럼 보이게 한다
      const len = Math.hypot(end[0] - origin[0], end[1] - origin[1], end[2] - origin[2]);
      const cone = ((def.spread && def.spread.hip) || 0) * DEG;
      for (let i = 1; i < Math.min(def.pellets, PELLET_TRACERS); i++) {
        const dd = coneDir(d, cone);
        fx.tracer(muzzle, [origin[0] + dd[0] * len, origin[1] + dd[1] * len, origin[2] + dd[2] * len], kind);
      }
    }
    if (o.hitPoint) {
      if (o.hitKind === 'player') {
        // 내가 맞은 탄은 퍼프를 생략(눈앞을 가린다). victimId가 없으면 카메라와의 거리로 판단
        const cp = R.camera.position;
        const nearMe = Math.hypot(end[0] - cp.x, end[1] - cp.y, end[2] - cp.z) < 1.5;
        if (String(o.victimId) !== local.id && !nearMe) fx.impact(end, [-d[0], -d[1], -d[2]], 'player');
      } else {
        let n = o.normal ? arr3(o.normal) : null, mat = o.mat || null, moving = false;
        if (map) {
          const h = raycastWorld(map.world, [end[0] - d[0] * 0.3, end[1] - d[1] * 0.3, end[2] - d[2] * 0.3], d, 0.6);
          if (h) { n = n || h.normal; mat = mat || h.mat; moving = !!(h.collider && h.collider.dynamic); }
        }
        if (n) fx.impact(end, n, mat || 'concrete', moving ? NO_DECAL : null);
      }
    }
    play((def && def.sound) || 'rifle', { pos: muzzle });
  }

  /* ---------- 피드백 · 라운드 ---------- */
  /**
   * 내가 맞았거나(incoming, attackerPos) 내가 맞힌 결과의 표시.
   * 맞힌 쪽: { amount, head, kill, half }. half(= match의 halfShot, 이 이름도 받는다)면 저격 반샷이다.
   */
  function feedbackDamage(o = {}) {
    if (!o) return;
    const incoming = o.incoming === true || (o.incoming !== false && o.attackerPos != null);
    if (incoming) {
      if (ui && o.attackerPos) {
        const a = arr3(o.attackerPos), s = player.state;
        ui.hud.damageFrom(relativeAngle({ x: s.pos[0], z: s.pos[2] }, s.yaw, { x: a[0], z: a[2] }));
      }
      return;
    }
    const head = !!o.head, kill = !!o.kill, half = !!(o.half || o.halfShot);
    if (ui) {
      ui.hud.hitmarker(head, kill, { half });
      if (half) ui.hud.callout(`반샷! −${Math.round(num(o.amount))}`, 'half');
      else if (head) ui.hud.callout('헤드샷!', 'head');
    }
    // half_shot은 hit_marker 대신 난다. 반샷으로 끝낸 킬은 킬 소리와 겹친다
    play(kill ? 'kill' : head ? 'headshot' : half ? 'half_shot' : 'hit_marker');
    if (half && kill) play('half_shot');
  }

  /**
   * 킬 하나를 알린다(경기의 kill 이벤트마다: 연습장 practice.js, 멀티 session.js). { killer, victim, killerTeam?, victimTeam? }
   * 내가 살아서 적을 처치했을 때만 연속 킬을 센다. 앞 킬과 5초 안이면 이어지고 2킬부터 hud.multiKill(그림·글자)과
   * 효과음(multi_kill, 전설은 legend_kill), 안내 음성(audio.voice)을 낸다. 반환: 이어진 킬 수(세지 않았으면 0)
   */
  function noteKill(o) {
    if (!o || !active) return 0;
    const killer = o.killer == null ? '' : String(o.killer), victim = o.victim == null ? '' : String(o.victim);
    if (!killer || killer !== local.id || victim === killer || !local.spawned || !local.alive) return 0;
    if (mode !== 'ffa' && o.killerTeam && o.killerTeam === o.victimTeam) return 0;   // 같은 편은 세지 않는다
    const n = multiKill.kill(clock * 1000);
    const tier = multiKillTier(n);
    if (!tier) return n;
    const legend = tier.id === 'legend';
    if (ui) ui.hud.multiKill({ id: tier.id, title: tier.title, sub: legend ? `${n}연속 처치` : '' });
    play(legend ? 'legend_kill' : 'multi_kill', legend ? undefined : { rate: 1 + 0.06 * (tier.count - 2) });
    try { audio.voice(tier.id, { delay: 0.08 }); } catch (e) { /* 소리 없이 계속 */ }
    emit('multiKill', { count: n, id: tier.id });
    return n;
  }

  /** 비밀 스팟에 들어감: 처음이면 보상과 배너, 이미 찾은 곳이면 짧은 글자만 */
  function onSecret(e) {
    if (!active || !local.alive || !map || !e || !e.secret) return;
    const secret = e.secret;
    let res;
    if (ctx.account && typeof ctx.account.findSecret === 'function') res = ctx.account.findSecret(map.id, secret);
    else {
      const key = `${map.id}:${secret.id}`;
      res = { first: !secretsNoAccount.has(key), gained: secret.points };
      secretsNoAccount.add(key);
    }
    if (res && res.first) {
      if (ui) ui.hud.banner({ icon: '🏆', title: '비밀 스팟 발견', sub: `${secret.name} · +${res.gained} P` });
      play('secret_found');
      fx.secretSparkle(e.pos);
    } else if (ui) ui.hud.callout(`${secret.name} · 이미 찾은 곳`);
  }

  function setRound(o = {}) {
    if (!o) return;
    if (o.phase !== undefined) { rnd.phase = o.phase; syncFrozen(); }
    // 교전 중이 아닐 때(로드아웃·라운드 끝 등) 미뤄 둔 자동 그래픽 품질 변경을 적용한다
    if (o.phase !== undefined && o.phase !== 'live' && ctx.renderer.applyPendingQuality) ctx.renderer.applyPendingQuality();
    if (o.round !== undefined) rnd.round = num(o.round) | 0;
    if ((o.mode === 'ffa' || o.mode === 'team' || o.mode === 'bomb') && o.mode !== mode) setMode(o.mode);
    if (o.attack !== undefined) rnd.attack = o.attack === 'owner' || o.attack === 'charterer' ? o.attack : null;   // 폭파 미션 이번 라운드 공격 팀
    if (mode === 'ffa') {
      // 개인전 점수: 평평한 필드 또는 score:{...} — { kills, rank, total, leaderName, leaderKills, target }
      const src = o.score && typeof o.score === 'object' ? o.score : o;
      if (FFA_KEYS.some((k) => src[k] !== undefined)) {
        const f = rnd.ffa || {};
        const pick = (k, conv, d) => (src[k] !== undefined ? conv(src[k]) : f[k] !== undefined ? f[k] : d);
        const int = (v) => Math.max(0, num(v) | 0);
        rnd.ffa = {
          mode: 'ffa', kills: pick('kills', int, 0), rank: pick('rank', int, undefined), total: pick('total', int, undefined),
          leaderName: pick('leaderName', (v) => String(v == null ? '' : v), ''), leaderKills: pick('leaderKills', int, 0),
          target: src.target !== undefined || src.killTarget !== undefined ? int(src.target ?? src.killTarget) || 20 : f.target || 20
        };
      }
    } else if (o.score) rnd.score = { owner: num(o.score.owner) | 0, charterer: num(o.score.charterer) | 0 };
    if (o.timeLeftMs !== undefined) { rnd.timeLeftMs = o.timeLeftMs == null ? null : Math.max(0, num(o.timeLeftMs)); rnd.elapsed = 0; }
    if (o.alive) rnd.alive = { owner: num(o.alive.owner) | 0, charterer: num(o.alive.charterer) | 0 };
    if (o.teamSize) rnd.teamSize = { owner: num(o.teamSize.owner) | 0, charterer: num(o.teamSize.charterer) | 0 };
    if (o.roundsToWin) rnd.target = num(o.roundsToWin, 3);
    if (o.maxRounds) rnd.bestOf = num(o.maxRounds, 5);
  }

  /* ---------- 루프 ---------- */
  const localCanMove = () => controls && rnd.phase !== 'loadout' && rnd.phase !== 'matchEnd' && local.spawned && local.alive;
  /** 무기 입력을 받을 수 있는가: 움직일 수 있고, 입력이 켜져 있고, 커서가 필요한 화면·이모트·휠이 없을 때 */
  const localCanAct = () => localCanMove() && input.enabled && !(ui && ui.needsCursor()) && !emoteLocal && !wheel.open;
  /**
   * core 플레이어 틱이 이 틱보다 먼저 돈다(루프 순서 머리말). 스폰·페이즈가 바뀐 그 자리에서도 맞춰 두어야
   * 로드아웃 첫 틱에 Space를 누르고 있었다고 뛰거나 W 값을 받아 미끄러지지 않는다.
   */
  function syncFrozen() { player.setFrozen(!localCanMove()); }
  /** 들고 있는 무기에 맞춰 조준 사격을 켜고 끈다(휴대폰 + 라이플). 무기 모듈과 입력의 줌 방식, 터치 버튼 글자를 함께 바꾼다 */
  function syncAimFire() {
    const on = !!input.touchMode && arsenal.getWeapon().def.category === 'rifle';
    if (on === aimFireOn) return;
    aimFireOn = on;
    arsenal.setZoomMode(arsenalZoomMode());
    if (input.setTouchZoomHold) input.setTouchZoomHold(on);
    bus.emit('touch:aimFire', { on });
  }

  function tick(dt) {
    if (!active || !map || simPaused) return;
    clock += dt;
    runScheduled();
    const st = player.state;
    syncFrozen();
    syncLocalEmote();
    const canAct = localCanAct();
    syncAimFire();
    // 조준 사격: 누르는 동안 방아쇠도 당긴다. 반자동·점사는 손을 떼지 않아도 다음 발이 나가게 탄이 있는 동안 매 틱 다시 누른다
    const aimFire = canAct && aimFireOn && rmbDown && local.alive;
    const repress = aimFire && arsenal.getWeapon().def.fire !== 'auto' && arsenal.getAmmo().mag > 0;
    const wi = {
      fireDown: canAct && (!!input.state.fire || aimFire),
      firePressed: canAct && (latch.fire || repress || (aimFire && !aimFirePrev)),
      zoomDown: canAct && (rmbDown || (!input.locked && !!input.state.aim)),
      zoomToggle: canAct && latch.rmb,
      reloadPressed: canAct && latch.reload,
      slot: canAct ? latch.slot : null,
      wheel: canAct ? latch.wheel : 0
    };
    latch.fire = latch.rmb = latch.reload = false; latch.slot = null; latch.wheel = 0;
    aimFirePrev = aimFire;
    if (local.spawned && local.alive) {
      // crouch → 탄퍼짐 ×0.8(arsenal, 크로스헤어 getHud도 같이)
      const evs = arsenal.update(dt, wi, { speed: Math.hypot(st.vel[0], st.vel[2]), onGround: st.onGround, walking: st.walking, crouch: !!st.crouch });
      for (const ev of evs) onWeaponEvent(ev);
      player.setSpeedScale(arsenal.getMoveMul());
      if (rnd.phase === 'live') pickNearbyGun();
      else local.ownDrops.clear();
    }
    for (const d of drops.expire()) removeDropView(d.id);
    if (nades) for (const ge of nades.update(dt)) onGrenadeEvent(ge);
    if (mode === 'bomb') bombView.tick(dt);
  }

  function updateSpectate(dt) {
    const cam = R.camera;
    if (mode === 'ffa') { spec.name = ''; return; }   // 개인전: 아군이 없다 → 쓰러진 시점 그대로 부활 대기
    if (performance.now() - local.deadAt < SPECTATE_DELAY_MS) { spec.name = ''; return; }
    const list = [];
    for (const a of actors.values()) if (a.alive && a.state && a.team === local.team) list.push(a);
    if (!list.length) { spec.id = null; spec.name = ''; return; }
    let a = spec.id ? actors.get(spec.id) : null;
    if (!a || !a.alive || a.team !== local.team) {
      a = list[((spec.idx % list.length) + list.length) % list.length];
      spec.id = a.id;
      const av0 = avatars.get(a.id);
      spec.yaw = av0 ? av0.yaw : a.state.yaw;
    }
    spec.name = a.name;
    const av = avatars.get(a.id);
    const p = av ? av.pos : a.state.pos;
    const yaw = av ? av.yaw : a.state.yaw;
    spec.yaw = lerpAngle(spec.yaw, yaw, 1 - Math.exp(-dt * 6));
    const head = [p[0], p[1] + 1.65, p[2]];
    const bx = Math.sin(spec.yaw), bz = Math.cos(spec.yaw);       // 뒤쪽 = -전방
    const want = [bx * 3.2, 0.75, bz * 3.2];
    const L = Math.hypot(want[0], want[1], want[2]);
    const h = raycastWorld(map.world, head, want, L);
    const k = h ? Math.max(0.12, (h.dist - 0.25) / L) : 1;
    cam.position.set(head[0] + want[0] * k, head[1] + want[1] * k, head[2] + want[2] * k);
    cam.lookAt(head[0] - bx * 5, head[1] - 0.35, head[2] - bz * 5);
  }

  function frame(dt) {
    // core가 렌더를 끈 프레임에는 player.frame이 카메라를 다시 세우지 않는다 → 반동·흔들림을 더하면 누적되므로 건너뜀
    if (!active || !map || !ctx.rendering) return;
    const cam = R.camera;
    const baseFov = R.baseFov;
    syncLocalEmote();
    const third = thirdAmount();
    if (local.spawned && local.alive) vm.setVisible(!emoteLocal && third < 0.01);
    if (local.spawned && local.alive && (emoteLocal || third > 0.01)) {
      // 이모트(3인칭): 카메라는 core(player.frame)가 세운다 — 반동·줌·스코프·뷰모델 없이 기본 FOV
      if (Math.abs(cam.fov - baseFov) > 1e-3) R.setFov(baseFov);
      input.setLookScale(1);
      if (ui) ui.scope.set(0);
    } else if (local.spawned && local.alive) {
      const k = arsenal.getRecoilKick();
      cam.rotation.x += k.pitch;
      cam.rotation.y += k.yaw;
      const z = arsenal.getZoom(baseFov);
      if (Math.abs(cam.fov - z.fov) > 1e-3) R.setFov(z.fov);
      input.setLookScale(z.progress > 0 ? (z.fov / baseFov) * num(settings.get('zoomSensitivity'), 1) : 1);
      // 스코프 오버레이가 없는 총도 배율을 넘긴다(크로스헤어 옆 조준 배율 표시). 2단 줌은 level로 단계를 보여 준다
      if (ui) ui.scope.set(z.scopeAmount, { mag: z.mag, level: z.level, levels: z.levels });
      vm.update(dt, arsenal.getViewState(baseFov));
    } else {
      if (Math.abs(cam.fov - baseFov) > 1e-3) R.setFov(baseFov);
      input.setLookScale(1);
      if (ui) ui.scope.set(0);
      if (local.spawned) updateSpectate(dt);
    }
    const sh = fx.getShake();
    cam.rotation.x += sh.pitch;
    cam.rotation.y += sh.yaw;
    cam.rotation.z += sh.roll;
    audio.setListener(cam.position, cam.rotation.y, cam.rotation.x);
    drawGrenades();
    if (mode === 'bomb') bombView.frame(dt);
    for (const v of dropViews.values()) v.spin.rotation.y += dt * 1.4;
    // 속도 줄기: 걷기 속도부터 나타나 수평 속도 상한에서 가장 세다
    fx.setSpeedAmount(local.spawned && local.alive ? (num(player.state.speed) - PLAYER.WALK) / (MOVE.MAX_SPEED - PLAYER.WALK) : 0);
    // 체력 낮음: 심장 박동
    const nowMs = performance.now();
    if (local.alive && player.state.hp > 0 && player.state.hp <= 25 && nowMs >= heartbeatAt) { heartbeatAt = nowMs + 900; play('low_hp_heartbeat'); }
    // 다른 사람 보호 표시(🛡) 만료
    for (const a of actors.values()) if (a.protectUntil && a.protectUntil !== Infinity && a.protectUntil <= displayNow()) { a.protectUntil = 0; refreshAvatar(a); }
    hudFrame(dt);
    if (scoreboardOpen) { sbRefresh -= dt; if (sbRefresh <= 0) { sbRefresh = 0.5; showScoreboard(); } }
  }

  function lockHint() {
    if (!active || input.locked || (ctx.flags && ctx.flags.autoplay) || (ui && ui.needsCursor())) return '';
    return input.touchMode ? TOUCH_LOCK_HINT : LOCK_HINT;
  }

  function hudFrame(dt) {
    if (!ui) return;
    if (!simPaused && rnd.timeLeftMs != null) rnd.elapsed += dt * 1000;   // 멀티는 일시정지 화면이 떠도 시간이 흐른다
    const alive = local.spawned && local.alive;
    const p = alive ? arsenal.getHud(R.baseFov) : { crosshair: false };
    // 이모트 중: 크로스헤어 숨김 + hud.emote(이름·아이콘). 휠 화면은 UI 'emotes'
    const em = alive && emoteLocal ? emoteInfo(emoteLocal) : null;
    if (em || (alive && thirdAmount() > 0.01)) p.crosshair = false;
    p.emote = em ? { id: em.id, name: em.name, icon: em.icon, loop: em.loop } : null;
    p.hp = local.spawned ? player.state.hp : 100;
    p.speed = alive ? num(player.state.speed) : 0;   // 수평 속력(m/s). HUD가 0.1 단위로 잘라 바뀔 때만 DOM에 쓴다
    p.team = local.team;
    p.roundTime = rnd.timeLeftMs == null ? null : Math.max(0, rnd.timeLeftMs - rnd.elapsed) / 1000;
    const now = displayNow();
    if (mode === 'ffa') {
      p.score = rnd.ffa || { mode: 'ffa', kills: 0, target: 20 };
      const q = quickOpen(now) ? { cost: quick.cost, ok: quick.ok, touch: !!input.touchMode } : undefined;   // 즉시 부활 안내(E · 휴대폰 '부활' 버튼)
      p.respawn = respawn && !alive ? { seconds: Math.max(0, Math.ceil((respawn.at - now) / 1000)), killer: respawn.killer || undefined, weaponName: respawn.weaponName || undefined, quick: q } : null;
      p.protect = alive && protectUntil > now;
      syncQuickTouch(!!(q && q.ok && input.touchMode));
    } else {
      p.score = { owner: rnd.score.owner, charterer: rnd.score.charterer, target: rnd.target, bestOf: rnd.bestOf, round: rnd.round || undefined };
      if (mode === 'bomb') { p.score.mode = 'bomb'; p.score.attack = rnd.attack || undefined; }
      if (rnd.alive) p.alive = rnd.alive;
      if (rnd.teamSize) p.teamSize = rnd.teamSize;
      p.respawn = null;
      p.protect = false;
    }
    p.bomb = mode === 'bomb' ? bombView.hud() : null;
    p.hint = lockHint() || pickHint() || customHint || '';
    // 무기 교체 안내: 대기 시간이 끝나면 치운다. 죽었거나 관전 중이면 띄우지 않는다
    if (swap && swapLeft() <= 0) closeSwap();
    // 목록이 열려 있는 동안에는 목록의 제목과 남은 시간이 대신 알려 주므로 안내를 감춘다
    const prompt = !!swap && alive && !ui.isVisible('loadout');
    const held = prompt ? getDef(local.loadout || arsenal.getWeapon().id) : null;
    p.swap = prompt ? { seconds: swapLeft(), weaponName: held ? held.short || held.name : '' } : null;
    p.spectate = !alive && local.spawned ? spec.name : '';
    ui.hud.set(p);
  }

  offs.push(ctx.onTick(tick, -90));
  offs.push(ctx.onFrame(frame, -40));
  offs.push(ctx.onFrame((dt) => {
    if (!active) return;
    if (!simPaused) props.update(dt);
    fx.update(dt);
  }, 500));

  /* ---------- 공개 API ---------- */
  function getLocalState() {
    const st = player.state;
    const s = player.snapshot();
    s.alive = local.spawned && local.alive && st.alive;
    s.vel = [round2(st.vel[0]), round2(st.vel[1]), round2(st.vel[2])];
    s.name = local.name;
    const held = arsenal.getWeapon();
    s.weaponId = held.id;
    s.slot = held.slot;
    s.weapon = arsenal.serialize();
    s.kills = st.kills;
    s.deaths = st.deaths;
    s.crouch = !!st.crouch;                        // sync → protocol FLAG.crouch
    s.emote = s.alive ? emoteCode(st.emote) : 0;   // 이모트 번호(0 = 없음) → protocol 상태 플래그 6~9번 비트
    return s;
  }

  function destroy() {
    if (W.dead) return;
    W.dead = true;
    if (active) { try { unloadMap(); } catch (e) { /* ignore */ } }
    offs.forEach((o) => { try { o(); } catch (e) { /* ignore */ } });
    offs.length = 0;
    removeUnlock();
    try { props.dispose(); } catch (e) { /* ignore */ }
    try { bombView.dispose(); } catch (e) { /* ignore */ }
    try { vm.dispose(); } catch (e) { /* ignore */ }
    try { fx.dispose(); } catch (e) { /* ignore */ }
    try { audio.dispose(); } catch (e) { /* ignore */ }
    if (nades) nades.dispose();
    for (const m of nadeMeshes) R.scene.remove(m);
    nadeGeo.dispose(); nadeMat.dispose();
    clearDrops();
    dropRingGeo.dispose(); dropRingMat.dispose(); dropRingPremium.dispose();
    avatars.setDelay(prevDelay);
    if (loadingEl) loadingEl.remove();
    listeners.clear();
    if (shared === W) shared = null;
  }

  const api = {
    loadMap,
    /** 움직이는 지형이 쓸 시계(초를 돌려주는 함수). 멀티 세션이 방장 시계를 넘긴다. null이면 World 시각으로 돌아간다 */
    setMoverClock(fn) { moverClock = typeof fn === 'function' ? fn : null; },
    /**
     * 라운드 시작 전 대기 시간의 무기 교체를 켠다: HUD 안내("N 을 눌러 무기 교체!")와 N 키.
     * o = { seconds, weapons, ruleset, selected, round, title? } — seconds 뒤에 저절로 꺼지고, 나머지는 로드아웃 화면에 그대로 넘긴다
     */
    openSwap,
    /** 무기 교체를 끈다(라운드 시작·라운드 끝). 열려 있던 목록도 닫는다 */
    closeSwap,
    unloadMap,
    reset,
    spawnLocal,
    setLocalLoadout,
    setLocalHp,
    killLocal,
    addActor,
    removeActor,
    clearActors,
    setActorState,
    actorFire,
    actorGrenade,
    actorDeath,
    addDrop,
    removeDrop,
    feedbackDamage,
    noteKill,
    setRound,
    setMode,
    setRuleset,
    setRespawn,
    setQuickRespawn,
    setProtect,
    setActorProtect,
    /** 폭파 미션(8절): 방장 상태 { attack, state, carrier, carrierName?, actorName?, pos, site, explodeInMs, action, phase } | null, 폭탄 이벤트 하나 */
    setBomb: (info) => bombView.set(info),
    bombEvent: (ev) => bombView.event(ev),
    get bomb() { return bombView.info; },
    get bombPending() { return bombView.pending; },
    /** 맵 충돌의 바닥 높이: (x, z)에서 fromY 아래 가장 높은 윗면. 맵이 없으면 null. 방장 match가 떨어진 폭탄을 바닥에 놓을 때 쓴다 */
    floorAt: (x, fromY, z) => (map && Number.isFinite(x) && Number.isFinite(z) ? getGroundY(map.world, x, z, Number.isFinite(fromY) ? fromY : Infinity) : null),
    /** 이모트(MODES.md 4절): 휠 열기/커서/닫기(commit=시작), 내 이모트 시작·취소, 목록 */
    startEmote: startLocalEmote,
    cancelEmote: (reason) => cancelLocalEmote(reason || 'api'),
    get emotes() { return emoteList().map((e) => ({ ...e })); },
    get emoteWheelOpen() { return wheel.open; },
    get localEmote() { return emoteLocal; },
    setControlsEnabled(v) { controls = !!v; },
    setPaused(v) {
      const next = !!v;
      if (next === simPaused) return;
      if (next) pausedAt = performance.now();
      else {
        // 멈춰 있던 만큼 부활·보호 표시를 미룬다. 경기(match)의 시계도 그만큼 멈춰 있었다
        const late = performance.now() - pausedAt;
        if (respawn) respawn.at += late;
        if (protectUntil && protectUntil !== Infinity) protectUntil += late;
        for (const a of actors.values()) if (a.protectUntil && a.protectUntil !== Infinity) a.protectUntil += late;
      }
      simPaused = next;
    },
    setPauseOptions(o = {}) { pauseOpts = { leaveLabel: (o && o.leaveLabel) || '나가기', note: o ? o.note : undefined }; },
    setScoreboard(fn) { scoreboardProvider = typeof fn === 'function' ? fn : null; },
    setHint(text) { customHint = text ? String(text) : ''; },
    sound: (name, o) => play(name, o),
    /** 상점 미리 듣기(이모트 id). 반복형은 4초 뒤 멈춘다. 다시 부르면 앞의 것을 멈춘다 */
    previewEmote,
    stopEmotePreview,
    getLocalState,
    getActor(id) { const a = actors.get(String(id)); return a ? { id: a.id, name: a.name, team: a.team, kind: a.kind, alive: a.alive, state: a.state } : null; },
    getActors() { return Array.from(actors.values(), (a) => ({ id: a.id, name: a.name, team: a.team, kind: a.kind, alive: a.alive, state: a.state })); },
    getMap: () => map,
    get active() { return active; },
    get mode() { return mode; },
    get ruleset() { return ruleset; },
    get localId() { return local.id; },
    get localTeam() { return local.team; },
    get localAlive() { return local.spawned && local.alive; },
    /** 마지막 킬까지 이어진 내 연속 킬 수(죽거나 판이 바뀌면 0). 5초가 지나도 다음 킬 전까지는 그대로다 */
    get multiKillCount() { return multiKill.count; },
    get paused() { return uiPaused; },
    /** 디버그·테스트용 내부 객체(읽기 전용으로 쓸 것) */
    get internals() { return { arsenal, vm, fx, audio, nades, actors, local, rnd, props, drops, bombView }; }
  };

  W.handle = function handle() {
    const mine = new Set();
    let closed = false;
    W.refs++;
    return Object.assign(Object.create(api), {
      on(evt, fn) {
        const off = on(evt, fn);
        mine.add(off);
        return () => { off(); mine.delete(off); };
      },
      dispose() {
        if (closed) return;
        closed = true;
        mine.forEach((o) => o());
        mine.clear();
        W.refs--;
        if (W.refs <= 0) destroy();
      }
    });
  };
  return W;
}

export default createWorld;
