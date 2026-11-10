/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 로컬 플레이어. 입력을 이동(moveQuake)·앉기·이모트·발판/포털 판정으로 옮기고 카메라(보간·흔들림·3인칭)를 움직인다.
 */
/**
 * SKALA 작전 — 로컬 플레이어
 *
 *   const player = createLocalPlayer({ bus, input, camera, getWorld: () => map && map.world });
 *   player.state            // PlayerState (아래)
 *   player.spawn({ x, y, z, rotY })
 *   player.tick(dt)         // 고정 틱: 입력 → 물리 이동
 *   player.frame(dt, alpha) // 렌더 프레임: 마우스 시점 + 카메라(보간·흔들림)
 *   player.addRecoil(pitchRad, yawRad)  // 조준 자체를 움직이는 반동(무기 담당)
 *   player.kick(pitchRad, yawRad)       // 화면만 튀었다 돌아오는 반동
 *   player.addShake(0..1)               // 폭발 등 화면 흔들림(트라우마)
 *   player.damage(amount, { from, part, weapon, dir }) → { hp, killed }
 *   player.getEye(out?) / player.getAimDir(out?)   // 사격 원점·방향 (카메라 기준, 흔들림 제외)
 *   player.snapshot()       // 네트워크 전송용 작은 객체 (crouch 포함)
 *
 * PlayerState = { id, name, team, pos:[x,y,z](발), vel:[x,y,z], speed(수평 m/s), yaw, pitch, onGround, hp, alive,
 *                 slot, weapon, moving, walking, crouch, aiming, speedScale, frozen, kills, deaths }
 *
 * 이동: engine/movement.js의 moveQuake(DESIGN.md 4절). Space를 누르고 있으면 착지 즉시 다시 뛴다(input.state.jump), 누른 직후 0.12초 버퍼도 유지.
 *   bus: player:jump {pos, hopped} · player:land {pos, speed(충격), mat, hopped}. hopped = 버니합 사슬(착지 카메라 출렁임을 줄인다).
 * 트리거: engine/triggers.js의 stepTriggers(world.triggers가 있을 때만). bus: player:pad {pad, pos} · player:secret {secret, pos} ·
 *   player:portal {portal, pos(도착지)}. 발판 속도는 stepTriggers가 넣고, 포털 순간이동은 여기서 한다. 스폰하면 대기 시간과 본 비밀을 잊는다.
 *
 * 이모트(MODES.md 4.3): player.startEmote(id|code) → { ok, id, code } | { ok:false, reason:'unknown'|'dead'|'air'|'crouch'|'moving' }
 *   player.cancelEmote(reason) · state.emote(번호, 0 = 없음) · state.emoteId · player.emoteTime · snapshot().emote
 *   input:emotePick을 받으면 스스로 시작(player.autoEmote = false로 끌 수 있음). 이동키·점프·앉기·클릭·R·무기 교체·B 다시 누름·
 *   피해·죽음·스폰이면 자동 취소, 한 번형은 끝나면 자동 종료. bus: player:emote {id,code,active,reason?} · player:emote-denied {id,code,reason}
 *   이모트 중 3인칭 카메라(캐릭터 앞 비스듬히 ~3 m, 마우스로 궤도, 벽은 레이로 당김, 0.15초 전환) → player.thirdPerson(0..1) ·
 *   bus player:view {mode:'third'|'first'} · player.getBodyState()(3인칭 때 내 몸 그리기용)
 *
 * 앉기: input.state.crouch(Ctrl·C 누르는 동안) → state.crouch. 키 1.25 m·눈 1.1 m·2.6 m/s, 발소리 작게.
 *   머리 위가 막혀 있으면 키를 떼도 앉은 채 유지. 앉은 채 Space = 일어설 수 있으면 일어서며 점프(착지 뒤 키가
 *   눌려 있으면 다시 앉음), 막혀 있으면 점프하지 않음. 바뀔 때 bus 'player:crouch' { crouch }.
 */
import { PLAYER, EMOTE_BLEND, emoteById } from '../core/consts.js';
import { raycastWorld, canStand } from './physics.js';
import { moveQuake, resetMoveMemory } from './movement.js';
import { stepTriggers } from './triggers.js';
import { carryBody } from './movers.js';
import { lerpAngle } from './interp.js';

/** 3인칭(이모트) 카메라: 시작 궤도각(+ = 캐릭터 왼쪽 앞), 높이각, 거리, 바라보는 높이 */
const ORBIT = Object.freeze({ yaw: 0.6, pitch: 0.18, dist: 3.0, target: 1.15, minPitch: -0.35, maxPitch: 1.1 });
/** 버니합 착지의 카메라 출렁임 배율. 0.8초마다 착지하므로 그대로 두면 화면이 계속 꿀렁인다 */
const HOP_LAND_DIP = 0.3;
/**
 * 착지 출렁임 스프링을 한 번에 적분하는 가장 긴 시간(초). 이보다 긴 프레임은 같은 길이로 나눠 돈다.
 * 한 번에 약 0.106초를 넘게 적분하면 진동이 줄지 않고 커진다. 사격 원점이 카메라 위치라 느린 기기에서는 쏘는 높이도 함께 흔들린다
 */
const LAND_SPRING_STEP = 0.02;
/** 머리 흔들림 주기를 정하는 속도의 상한(m/s). 빠른 무기(걷기의 1.1배)까지는 그대로 두고, 버니합 속도에서 발걸음 주기가 치솟지 않게 자른다 */
const BOB_SPEED_LIMIT = PLAYER.WALK * 1.2;

export function createPlayerState(init = {}) {
  return Object.assign({
    id: 'local',
    name: '',
    team: 'owner',
    pos: [0, 0, 0],
    vel: [0, 0, 0],
    speed: 0,
    yaw: 0,
    pitch: 0,
    onGround: true,
    hp: PLAYER.HP,
    alive: true,
    slot: 1,
    weapon: null,
    moving: false,
    walking: false,
    crouch: false,
    emote: 0,
    emoteId: null,
    emoteEndedAt: 0,
    aiming: false,
    speedScale: 1,
    frozen: false,
    kills: 0,
    deaths: 0
  }, init);
}

const PITCH_LIMIT = (89 * Math.PI) / 180;

export function createLocalPlayer({ bus, input, camera, getWorld, state: initState } = {}) {
  const state = createPlayerState(initState);
  const prev = [0, 0, 0];
  let jumpBuffer = 0;
  let spawnPoint = { x: 0, y: 0, z: 0, rotY: 0 };
  // 카메라 효과
  let bobPhase = 0, bobAmp = 0;
  let landDip = 0, landVel = 0;
  let stepOffset = 0;
  let trauma = 0, shakeT = 0;
  let kickP = 0, kickY = 0;
  let deathT = 0;
  let stepDist = 0;
  let time = 0;
  let crouchT = 0;          // 앉은 자세 비율 0..1 (카메라용, 0.12초 전환)
  let crouchHold = false;   // 앉은 채 점프한 뒤 착지 전까지 다시 앉지 않음
  let trigState = {};       // stepTriggers가 채운다(발판·포털 대기 시간, 본 비밀). 스폰마다 새로
  const moveOpt = { height: PLAYER.HEIGHT };
  // 이모트 · 3인칭 카메라
  let emoteDef = null, emoteT = 0;
  let tpBlend = 0, tpTarget = 0, tpDist = ORBIT.dist, viewMode = 'first';
  let orbitYaw = ORBIT.yaw, orbitPitch = ORBIT.pitch;
  let wheelOpen = false, autoEmote = true;
  const fpEye = [0, 0, 0], renderPos = [0, 0, 0];
  const emit = (e, d) => { if (bus) bus.emit(e, d); };
  const offs = [];
  if (bus) offs.push(bus.on('input:jump', () => { endEmote('jump'); jumpBuffer = 0.12; }));
  if (bus) {
    offs.push(bus.on('input:emotePick', (e) => { if (autoEmote && e && e.id) startEmote(e.id); }));
    offs.push(bus.on('input:emoteWheel', (e) => {
      const open = !!(e && e.open);
      if (open && !wheelOpen) endEmote('wheel'); // B 다시 누름
      wheelOpen = open;
    }));
    offs.push(bus.on('input:emoteCancel', (e) => endEmote((e && e.reason) || 'input')));
    offs.push(bus.on('input:crouch', (e) => { if (e && e.down) endEmote('crouch'); }));
    offs.push(bus.on('input:reload', () => endEmote('reload')));
    offs.push(bus.on('input:slot', () => endEmote('weapon')));
    offs.push(bus.on('input:cycle', () => endEmote('weapon')));
    offs.push(bus.on('input:fire', (e) => { if (e && e.down) endEmote('fire'); }));
    offs.push(bus.on('input:aim', (e) => { if (e && e.active && e.source === 'user') endEmote('aim'); }));
  }
  if (bus) offs.push(bus.on('camera:shake', (e) => addShake((e && e.amount) || 0.3)));
  if (bus) offs.push(bus.on('camera:kick', (e) => kick((e && e.pitch) || 0, (e && e.yaw) || 0)));

  function spawn(sp = {}) {
    spawnPoint = { x: +sp.x || 0, y: +sp.y || 0, z: +sp.z || 0, rotY: +sp.rotY || 0 };
    state.pos[0] = spawnPoint.x; state.pos[1] = spawnPoint.y; state.pos[2] = spawnPoint.z;
    prev[0] = state.pos[0]; prev[1] = state.pos[1]; prev[2] = state.pos[2];
    state.vel[0] = state.vel[1] = state.vel[2] = 0;
    state.speed = 0;
    state.yaw = spawnPoint.rotY;
    state.pitch = 0;
    state.onGround = true;
    state.hp = PLAYER.HP;
    state.alive = true;
    state.moving = false;
    state.crouch = false;
    crouchT = 0;
    crouchHold = false;
    endEmote('spawn');
    tpBlend = tpTarget = 0;
    landDip = landVel = stepOffset = trauma = kickP = kickY = 0;
    deathT = 0;
    jumpBuffer = 0;
    resetMoveMemory(state);
    trigState = {};
    emit('player:spawn', { state, point: spawnPoint });
  }

  /** 순간이동: 속도 0, prev까지 맞춰서 카메라가 벽을 뚫고 보간되지 않게 한다. to = { x, y, z, rotY? } */
  function teleport(to) {
    state.pos[0] = prev[0] = to.x;
    state.pos[1] = prev[1] = to.y;
    state.pos[2] = prev[2] = to.z;
    state.vel[0] = state.vel[1] = state.vel[2] = 0;
    if (Number.isFinite(to.rotY)) state.yaw = to.rotY;
    state.onGround = false; // 도착지가 바닥이면 다음 틱에 바로 착지하고, 공중이면 그대로 떨어진다
    stepOffset = 0;
    resetMoveMemory(state);
  }

  /** 발판·비밀·포털 판정을 돌리고 알린다. 발판 속도는 stepTriggers가 이미 넣었다 */
  function applyTriggers(world, dt) {
    const hit = stepTriggers(world, state, moveOpt.height, trigState, dt);
    if (hit.pad) emit('player:pad', { pad: hit.pad, pos: state.pos.slice() });
    for (const secret of hit.secrets) emit('player:secret', { secret, pos: state.pos.slice() });
    if (hit.portal) {
      teleport(hit.portal.to);
      emit('player:portal', { portal: hit.portal, pos: state.pos.slice() });
    }
  }

  function forward(out = [0, 0, 0]) {
    out[0] = -Math.sin(state.yaw); out[1] = 0; out[2] = -Math.cos(state.yaw);
    return out;
  }

  function groundMat(world) {
    const h = raycastWorld(world, [state.pos[0], state.pos[1] + 0.2, state.pos[2]], [0, -1, 0], 0.6);
    return h ? h.mat : null;
  }

  function setCrouch(v) {
    if (state.crouch === v) return;
    state.crouch = v;
    emit('player:crouch', { crouch: v });
  }
  const roomToStand = (world) => canStand(world, state.pos[0], state.pos[1], state.pos[2]);

  /* ---------- 이모트 ---------- */
  function denyEmote(v, reason) {
    const e = emoteById(v);
    emit('player:emote-denied', { id: e ? e.id : (v == null ? null : String(v)), code: e ? e.code : 0, reason });
    return { ok: false, reason, id: e ? e.id : null, code: e ? e.code : 0 };
  }
  /** 이모트 시작: 살아 있고, 땅 위에 있고, 앉아 있지 않고, 멈춰 있을 때만 */
  function startEmote(v) {
    const def = emoteById(typeof v === 'string' ? v : Number(v));
    if (!def) return denyEmote(v, 'unknown');
    if (!state.alive) return denyEmote(def.id, 'dead');
    if (!state.onGround) return denyEmote(def.id, 'air');
    if (state.crouch) return denyEmote(def.id, 'crouch');
    const inp = (input && input.state) || {};
    // Space를 누르고 있으면 다음 틱에 바로 뛰어 취소될 테니 시작하지 않는다(시작·취소가 깜빡이지 않게)
    if (inp.forward || inp.back || inp.left || inp.right || inp.jump || Math.hypot(state.vel[0], state.vel[2]) > 0.5) return denyEmote(def.id, 'moving');
    if (state.emote) endEmote('switch');
    emoteDef = def;
    emoteT = 0;
    state.emote = def.code;
    state.emoteId = def.id;
    if (tpBlend <= 0.001) { orbitYaw = ORBIT.yaw; orbitPitch = ORBIT.pitch; tpDist = ORBIT.dist; }
    tpTarget = 1;
    jumpBuffer = 0;
    if (input && input.setEmoteLock) input.setEmoteLock(true);
    emit('player:emote', { id: def.id, code: def.code, active: true, loop: def.loop, duration: def.duration });
    return { ok: true, id: def.id, code: def.code };
  }
  /** 이모트 끝내기(취소 포함). 진행 중이 아니면 false */
  function endEmote(reason = 'manual') {
    if (!state.emote) return false;
    const def = emoteDef;
    state.emote = 0;
    state.emoteId = null;
    emoteDef = null;
    state.emoteEndedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
    tpTarget = 0;
    if (input && input.setEmoteLock) input.setEmoteLock(false);
    emit('player:emote', { id: def ? def.id : null, code: def ? def.code : 0, active: false, reason });
    return true;
  }

  const wish = { dirX: 0, dirZ: 0, speed: 0, jump: false, strafeSign: 0 };
  function tick(dt) {
    time += dt;
    prev[0] = state.pos[0]; prev[1] = state.pos[1]; prev[2] = state.pos[2];
    if (jumpBuffer > 0) jumpBuffer -= dt;
    const world = getWorld && getWorld();
    if (!world) return;
    // 움직이는 지형 위에 서 있으면 같이 간다(prev를 잡은 뒤라 화면 보간에도 들어간다)
    if (world.movers && !world.movers.empty && state.alive) carryBody(world, state);
    const inp = (input && input.state) || {};
    // 이모트: 움직이면(이동키·공중) 취소, 한 번형은 길이가 끝나면 종료
    if (state.emote) {
      emoteT += dt;
      if (!state.alive) endEmote('death');
      else if (inp.forward || inp.back || inp.left || inp.right) endEmote('move');
      else if (!state.onGround) endEmote('air');
      else if (emoteDef && !emoteDef.loop && emoteT >= emoteDef.duration) endEmote('done');
    }
    const canMove = state.alive && !state.frozen && (!input || input.enabled !== false);
    let f = 0, s = 0;
    if (canMove) {
      f = (inp.forward ? 1 : 0) - (inp.back ? 1 : 0);
      s = (inp.right ? 1 : 0) - (inp.left ? 1 : 0);
    }
    const len = Math.hypot(f, s);
    state.walking = !!inp.walk && canMove;
    state.aiming = !!inp.aim && canMove;

    // 점프: Space를 누르고 있거나 방금 눌렀다(0.12초 버퍼). 앉아 있으면 일어설 수 있을 때만 일어서며 점프
    const wantJump = canMove && (jumpBuffer > 0 || !!inp.jump);
    let jump = wantJump && state.onGround;
    if (jump && state.crouch) {
      if (roomToStand(world)) { setCrouch(false); crouchHold = true; }
      else { jump = false; jumpBuffer = 0; }
    } else if (jump && jumpBuffer <= 0) {
      // 누르고 있어서 뛰는 틱: 앉기 키도 함께 누른 채 착지해도 매번 앉았다 일어서지 않고 선 채로 이어 뛴다.
      // 방금 누른 점프는 건드리지 않는다(Space와 앉기를 동시에 누르는 앉아 뛰기는 그대로). 키가 없으면 아래에서 바로 풀린다
      crouchHold = true;
    }
    if (jump) endEmote('jump');
    // 앉기 / 일어서기 (죽은 동안은 자세 유지)
    if (state.alive) {
      const held = !!inp.crouch && (!input || input.enabled !== false);
      if (!held) crouchHold = false;
      const want = held && !crouchHold;
      if (want && !state.crouch) setCrouch(true);
      else if (!want && state.crouch && roomToStand(world)) setCrouch(false);
    }

    const base = state.crouch
      ? (state.walking ? Math.min(PLAYER.SLOW_WALK, PLAYER.CROUCH_SPEED) : PLAYER.CROUCH_SPEED)
      : (state.walking ? PLAYER.SLOW_WALK : PLAYER.WALK);
    wish.speed = base * (state.speedScale || 1);
    wish.strafeSign = Math.sign(s); // A = -1, D = +1, 둘 다 누르면 0
    if (len > 0) { f /= len; s /= len; }
    const sy = Math.sin(state.yaw), cy = Math.cos(state.yaw);
    // 전방 (-sin, -cos), 오른쪽 (cos, -sin)
    wish.dirX = -sy * f + cy * s;
    wish.dirZ = -cy * f - sy * s;
    // 공중의 jump는 "착지하면 바로 뛴다"는 예고다: 착지 틱에 ev.hopped를 켜서 카메라 출렁임을 줄인다
    wish.jump = jump || (wantJump && !state.onGround);

    const wasGround = state.onGround;
    const y0 = state.pos[1];
    moveOpt.height = state.crouch ? PLAYER.CROUCH_HEIGHT : PLAYER.HEIGHT;
    const ev = moveQuake(world, state, wish, dt, moveOpt);
    if (ev.jumped) jumpBuffer = 0; // 챌판에 올라서느라 땅에 남은 점프는 버퍼를 남겨 다음 틱에 다시 뛴다
    if (state.onGround && !ev.jumped) crouchHold = false; // 착지(또는 턱에 올라섬) → 키가 눌려 있으면 다시 앉음
    // 턱에 올라선 만큼 카메라를 천천히 따라 올린다. 공중에서 턱 위로 내려앉을 때도 같다
    const rose = state.pos[1] - y0;
    if (rose > 0.05 && state.onGround && (ev.stepUp > 0.05 || !wasGround)) stepOffset -= rose;
    if (ev.jumped) emit('player:jump', { pos: state.pos.slice(), hopped: ev.hopped });
    if (ev.landed) {
      landVel -= Math.min(2.2, ev.impact * 0.13) * (ev.hopped ? HOP_LAND_DIP : 1);
      emit('player:land', { pos: state.pos.slice(), speed: ev.impact, mat: groundMat(world), hopped: ev.hopped });
    }
    if (world.triggers && state.alive && !state.frozen) applyTriggers(world, dt);
    const hs = Math.hypot(state.vel[0], state.vel[2]);
    state.speed = hs;
    state.moving = hs > 0.3;
    if (state.onGround && hs > 0.5) {
      stepDist += hs * dt;
      const quiet = state.walking || state.crouch;
      const stride = quiet ? 1.5 : 1.95;
      if (stepDist >= stride) {
        stepDist -= stride;
        emit('player:step', { pos: state.pos.slice(), speed: hs, quiet, crouch: state.crouch, mat: groundMat(world) });
      }
    }
    // 월드 밖으로 떨어지면 마지막 스폰으로
    if (state.pos[1] < -40) {
      emit('player:fell', { pos: state.pos.slice() });
      const keepHp = state.hp;
      spawn(spawnPoint);
      state.hp = keepHp;
    }
  }

  function addRecoil(pitch = 0, yaw = 0) {
    state.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, state.pitch + pitch));
    state.yaw += yaw;
  }
  function kick(pitch = 0, yaw = 0) { kickP += pitch; kickY += yaw; }
  function addShake(amount = 0.3) { trauma = Math.min(1, trauma + amount); }

  function damage(amount, info = {}) {
    if (!state.alive) return { hp: state.hp, killed: false };
    const a = Math.max(0, Math.round(+amount || 0));
    if (a > 0) endEmote('damage');
    state.hp = Math.max(0, state.hp - a);
    addShake(Math.min(0.5, a / 120));
    emit('player:damage', Object.assign({ amount: a, hp: state.hp }, info));
    if (state.hp <= 0) { kill(info); return { hp: 0, killed: true }; }
    return { hp: state.hp, killed: false };
  }

  function kill(info = {}) {
    if (!state.alive) return;
    endEmote('death');
    state.alive = false;
    state.hp = 0;
    state.deaths++;
    state.vel[0] = state.vel[2] = 0;
    deathT = 0;
    emit('player:death', Object.assign({ id: state.id }, info));
  }

  // 시점 + 카메라
  function noise(t, seed) { return Math.sin(t * 1.0 + seed) * 0.6 + Math.sin(t * 2.3 + seed * 1.7) * 0.3 + Math.sin(t * 5.1 + seed * 0.3) * 0.1; }

  function frame(dt, alpha = 1) {
    if (input && state.alive) {
      const look = input.consumeLook();
      if (state.emote) {
        // 이모트 중: 마우스는 3인칭 카메라 궤도(몸 방향은 그대로)
        orbitYaw -= look.dx;
        orbitPitch = Math.max(ORBIT.minPitch, Math.min(ORBIT.maxPitch, orbitPitch + look.dy));
      } else {
        state.yaw -= look.dx;
        state.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, state.pitch - look.dy));
      }
    } else if (input) input.consumeLook();
    if (state.yaw > Math.PI * 4 || state.yaw < -Math.PI * 4) state.yaw %= Math.PI * 2;
    if (!camera) return;

    const x = prev[0] + (state.pos[0] - prev[0]) * alpha;
    const y = prev[1] + (state.pos[1] - prev[1]) * alpha;
    const z = prev[2] + (state.pos[2] - prev[2]) * alpha;
    renderPos[0] = x; renderPos[1] = y; renderPos[2] = z;

    // 걷기 흔들림
    const hs = Math.hypot(state.vel[0], state.vel[2]);
    const targetAmp = state.onGround && state.alive ? Math.min(1, hs / PLAYER.WALK) * (state.walking ? 0.45 : 1) * (state.crouch ? 0.6 : 1) * (state.aiming ? 0.35 : 1) : 0;
    bobAmp += (targetAmp - bobAmp) * Math.min(1, dt * 8);
    bobPhase += dt * (4 + Math.min(hs, BOB_SPEED_LIMIT) * 1.25);
    const bobY = Math.sin(bobPhase * 2) * 0.03 * bobAmp;
    const bobX = Math.cos(bobPhase) * 0.018 * bobAmp;
    // 착지 출렁임(스프링). 느린 프레임은 LAND_SPRING_STEP 이하로 나눠 적분한다(50 fps 이상은 한 번)
    const springSteps = Math.max(1, Math.ceil(dt / LAND_SPRING_STEP));
    const springDt = dt / springSteps;
    for (let i = 0; i < springSteps; i++) {
      landVel += (-landDip * 90 - landVel * 14) * springDt;
      landDip += landVel * springDt;
      if (landDip < -0.3) { landDip = -0.3; landVel = 0; }
    }
    stepOffset *= Math.exp(-dt * 14);
    // 반동 복귀 · 트라우마 흔들림
    const kd = Math.exp(-dt * 11);
    kickP *= kd; kickY *= kd;
    trauma = Math.max(0, trauma - dt * 1.4);
    shakeT += dt * 22;
    const sh = trauma * trauma;
    const shP = sh * 0.035 * noise(shakeT, 1.3), shY = sh * 0.035 * noise(shakeT, 7.1), shR = sh * 0.05 * noise(shakeT, 4.2);

    // 앉기 자세 전환(0.12초, 부드럽게)
    const ct = state.crouch ? 1 : 0;
    const cstep = dt / PLAYER.CROUCH_TIME;
    crouchT = crouchT < ct ? Math.min(ct, crouchT + cstep) : Math.max(ct, crouchT - cstep);
    const ce = crouchT * crouchT * (3 - 2 * crouchT);
    const eyeBase = PLAYER.EYE + (PLAYER.CROUCH_EYE - PLAYER.EYE) * ce;

    let eye = eyeBase + bobY + landDip + stepOffset;
    let roll = Math.cos(bobPhase) * 0.0035 * bobAmp + shR;
    if (!state.alive) {
      deathT = Math.min(1, deathT + dt / 0.7);
      const k = deathT * deathT * (3 - 2 * deathT);
      eye = eyeBase + (0.35 - eyeBase) * k;
      roll += 0.55 * k;
    }
    const sy = Math.sin(state.yaw), cy = Math.cos(state.yaw);
    const fx = x + cy * bobX, fy = y + eye, fz = z - sy * bobX;
    fpEye[0] = fx; fpEye[1] = fy; fpEye[2] = fz;
    const fPitch = state.pitch + kickP + shP, fYaw = state.yaw + kickY + shY;

    // 3인칭(이모트) 전환 0.15초
    const tstep = dt / EMOTE_BLEND;
    tpBlend = tpBlend < tpTarget ? Math.min(tpTarget, tpBlend + tstep) : Math.max(tpTarget, tpBlend - tstep);
    const mode = tpBlend > 0 ? 'third' : 'first';
    if (mode !== viewMode) { viewMode = mode; emit('player:view', { mode }); }
    if (tpBlend <= 0) {
      camera.position.set(fx, fy, fz);
      camera.rotation.set(fPitch, fYaw, roll, 'YXZ');
      return;
    }
    // 캐릭터 앞쪽 비스듬히(궤도각 orbitYaw) ~3 m에서 캐릭터를 본다. 벽에 묻히지 않게 레이로 당김
    const tx = x, ty = y + ORBIT.target, tz = z;
    const ang = state.yaw + orbitYaw;
    const oc = Math.cos(orbitPitch), os = Math.sin(orbitPitch);
    const dx = -Math.sin(ang) * oc, dy = os, dz = -Math.cos(ang) * oc;
    let want = ORBIT.dist;
    const world = getWorld && getWorld();
    if (world) {
      const hit = raycastWorld(world, [tx, ty, tz], [dx, dy, dz], ORBIT.dist + 0.3);
      if (hit) want = Math.max(0.6, hit.dist - 0.3);
    }
    tpDist = want < tpDist ? want : tpDist + (want - tpDist) * Math.min(1, dt * 6);
    const px = tx + dx * tpDist, py = ty + dy * tpDist, pz = tz + dz * tpDist;
    const tYaw = Math.atan2(px - tx, pz - tz);
    const tPitch = Math.atan2(ty - py, Math.hypot(tx - px, tz - pz));
    const k = tpBlend * tpBlend * (3 - 2 * tpBlend);
    camera.position.set(fx + (px - fx) * k, fy + (py - fy) * k, fz + (pz - fz) * k);
    camera.rotation.set(fPitch + (tPitch - fPitch) * k, lerpAngle(fYaw, tYaw, k), roll * (1 - k), 'YXZ');
  }

  /** 사격 원점 = 현재 카메라 위치(보이는 그대로) */
  function getEye(out = [0, 0, 0]) {
    if (camera && tpBlend > 0) { out[0] = fpEye[0]; out[1] = fpEye[1]; out[2] = fpEye[2]; } // 3인칭 중에도 1인칭 눈 위치
    else if (camera) { out[0] = camera.position.x; out[1] = camera.position.y; out[2] = camera.position.z; }
    else { out[0] = state.pos[0]; out[1] = state.pos[1] + (state.crouch ? PLAYER.CROUCH_EYE : PLAYER.EYE); out[2] = state.pos[2]; }
    return out;
  }
  /** 조준 방향(반동 kick·흔들림 제외, yaw/pitch만) */
  function getAimDir(out = [0, 0, 0]) {
    const cp = Math.cos(state.pitch);
    out[0] = -Math.sin(state.yaw) * cp;
    out[1] = Math.sin(state.pitch);
    out[2] = -Math.cos(state.yaw) * cp;
    return out;
  }

  function snapshot() {
    const p = state.pos;
    return {
      id: state.id,
      pos: [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100, Math.round(p[2] * 100) / 100],
      yaw: Math.round(state.yaw * 1000) / 1000,
      pitch: Math.round(state.pitch * 1000) / 1000,
      moving: state.moving,
      walking: state.walking,
      crouch: state.crouch,
      emote: state.emote,
      aiming: state.aiming,
      onGround: state.onGround,
      alive: state.alive,
      hp: state.hp,
      slot: state.slot,
      team: state.team
    };
  }

  return {
    state,
    spawn,
    tick,
    frame,
    addRecoil,
    kick,
    addShake,
    damage,
    kill,
    getEye,
    getAimDir,
    forward,
    snapshot,
    setFrozen(v) { state.frozen = !!v; },
    setSpeedScale(s) { state.speedScale = Number.isFinite(s) && s > 0 ? s : 1; },
    get spawnPoint() { return spawnPoint; },
    /** 카메라용 앉은 자세 비율 0..1 (전환 중 보간) */
    get crouchAmount() { return crouchT; },
    /** 지금 자리에서 일어설 수 있는지 */
    canStand() { const w = getWorld && getWorld(); return w ? roomToStand(w) : true; },
    startEmote,
    cancelEmote: (reason = 'manual') => endEmote(reason),
    /** 지금 이모트 정의(EMOTES 항목) 또는 null */
    get emote() { return emoteDef; },
    /** 이모트 시작 뒤 경과(초) */
    get emoteTime() { return emoteT; },
    /** 3인칭 정도 0..1 (이모트 전환 중 보간, 0이면 1인칭) */
    get thirdPerson() { return tpBlend * tpBlend * (3 - 2 * tpBlend); },
    get viewMode() { return viewMode; },
    /** input:emotePick을 받아 스스로 시작할지(기본 true) */
    get autoEmote() { return autoEmote; },
    set autoEmote(v) { autoEmote = !!v; },
    /** 3인칭 때 내 몸 그리기용 상태(avatars.setLocalBody에 그대로) */
    getBodyState() {
      return { visible: tpBlend > 0 && state.alive, pos: renderPos, yaw: state.yaw, pitch: 0, team: state.team, name: state.name, emote: state.emote, crouch: state.crouch };
    },
    dispose() { offs.forEach((o) => o()); offs.length = 0; }
  };
}
