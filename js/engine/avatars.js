/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 원격 아바타(현대 특수부대 대원 7명, 뼈대 있는 GLB 모델). 스냅샷을 보간해 몸을 움직이고 이름표·히트 대상·상점 초상을 맡는다.
 */
/*
 *   const avatars = createAvatars({ scene, camera });   // 대원 모델(assets/models/operators/operators.glb)을 바로 받기 시작한다
 *   avatars.add(id, { name, team, avatar, badge })  // 이미 있으면 갱신. avatar = 캐릭터 id(core/avatar-defs.js), 모르는 값은 기본 캐릭터
 *                                            // badge = 이름표 앞 상태 표시('🛡'·'💣'). 적의 이름표는 이름 없이 badge만(engine/nametag.js)
 *   avatars.push(id, t, state)               // 스냅샷 { pos:[x,y,z], yaw, pitch, moving, crouch, alive, emote, slot, weaponId, ... }, t = ms
 *   avatars.update(now, dt)                  // 매 프레임: now − delay(100 ms) 시점으로 보간 → 몸·히트박스 갱신(먼 대원은 몸 동작을 덜 자주)
 *   avatars.getTargets()                     // raycastPlayers용 [{ id, pos, yaw, alive, crouch(0..1), team, name }] (보간된 화면 위치·자세)
 *   avatars.get(id).kill({ dir:[x,z] }) / .revive() / .setHeld(object3d) / .setName() / .setTeam() / .setAvatar(id)
 *                                            // kill: 쓰러짐 동작 → 누운 채 잠깐 → 땅으로 가라앉아 약 3초 뒤 숨김(engine/corpse.js), 히트 대상·이름표에서 빠진다
 *   avatars.get(id).swing(kind) / .recoil() / .reload(sec) / .throwNade()   // 칼 휘두르기 · 사격 반동 · 재장전 · 투척
 *   avatars.setLocalTeam(team)               // 아군 이름표는 벽 너머로도 보임. 적(개인전은 모두)은 이름을 숨기고 상태 표시만 35 m 안에서
 *   avatars.setLocalBody({ visible, pos, yaw, team, name, emote, crouch, slot, weaponId, avatar })  // 3인칭(이모트) 때 내 몸 (player.getBodyState())
 *   avatars.remove(id) / clear() / dispose()
 *   await avatars.prewarm(fn)                // 맵 로드 때: 모델을 기다리고(실패하면 던진다) 모든 대원 × 두 팀 몸·든 무기를 장면에 잠깐 넣고 fn(컴파일·한 번 그리기)
 *   avatars.compileWarm(webglRenderer, camera) // 그림자 켬·끔 등 품질이 바뀐 뒤 셰이더만 다시 준비
 *   createAvatarPortraits(webglRenderer).get(id, team) → 'data:image/png…' | null   // 상점·마이페이지 초상(같은 모델로 한 번씩 그려 둔다)
 *
 * 모델(engine/operator-model.js): Quaternius Ultimate Modular Men SWAT(CC0) 몸에 대원마다 다른 머리 장비를 붙였다(PRODUCT_PLAN.md 4절).
 *   몸 치수·히트박스는 모두 같다. 전투복은 어두운 팀 색, 완장·어깨 패치·가슴·등 표식·헬멧 띠는 밝은 팀 색이다.
 *   그리기 호출: 몸 1(뼈대 메시, 장비까지 한 덩어리) + 든 무기 1 + 이름표 1 (+ AI 안경 1). 대원·팀을 바꿔도 지오메트리만 바꾼다.
 *   모델을 아직 받는 중이면 몸 없이 이름표·히트 대상만 있고, 받으면 바로 몸이 붙는다.
 *   받지 못하면 prewarm이 이유를 담아 던진다 → 맵 불러오기가 실패로 끝나고 화면에 오류가 뜬다(예전 상자 인물로 몰래 대신하지 않는다).
 * 든 무기: state.slot === 3이면 총 대신 칼(카타나·구르카·가방·전기톱은 제 모양, 그 밖은 나이프). 슬롯 없이 weaponId가 'ml_'로 시작해도 칼이다.
 * 이모트(MODES.md 4.5): 스냅샷 emote(번호, 0 = 없음)면 engine/emoteanim.js의 포즈를 뼈에 옮겨 재생한다. 총은 등에 멘다. 히트박스는 서 있는 그대로.
 * 모델 좌표: 발바닥 원점, 정면 = 로컬 -Z (yaw 0이면 -Z를 봄). 머리 중심 1.62 m = HITBOX.HEAD.
 * 앉기: state.crouch → 0.12초에 걸쳐 엉덩이를 낮춘 자세(머리 ≈ 1.12 m = HITBOX_CROUCH.HEAD). getTargets().crouch가 같은 비율이다.
 */
import * as THREE from 'three';
import { TEAMS, TEAM_IDS, NET, HITBOX, PLAYER, emoteById } from '../core/consts.js';
import { avatarIdOf } from '../core/avatar-defs.js';
import { SnapshotBuffer, lerpAngle } from './interp.js';
import { tagText, tagShown } from './nametag.js';
import { OPERATOR_IDS } from './operator-look.js';
import { heldGeometry, heldKeyOf, droppedGunGeometry, glassesGeometry, HELD_KEYS } from './operator-gear.js';
import { OperatorBody, loadOperators, operatorsReady } from './operator-model.js';
import { corpseState } from './corpse.js';

const FONT = "'Pretendard','Noto Sans KR','Malgun Gothic','Apple SD Gothic Neo',system-ui,sans-serif";

/** 몸 동작 갱신 간격(프레임): 카메라에서 멀거나 화면 밖이면 덜 자주 계산한다(히트박스·위치는 매 프레임) */
const LOD = Object.freeze([[18, 1], [32, 2], [55, 3], [Infinity, 4]]);
const LOD_OFFSCREEN = 6;

let gunMaterial = null;
/** 바닥에 떨어진 총 모형. 손에 든 총과 같은 모양이고 지오메트리와 재질은 모두 나눠 쓴다(지우지 말 것). 총구 = -Z */
export function droppedGunMesh() {
  if (!gunMaterial) gunMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });
  return new THREE.Mesh(droppedGunGeometry(), gunMaterial);
}

/* ---------------- 이름표 ---------------- */

function makeNameTexture(name, team) {
  const T = TEAMS[team] || TEAMS.owner;
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const g = c.getContext('2d');
  g.font = `700 30px ${FONT}`;
  const text = String(name || '').slice(0, 16);
  const tw = Math.min(236, g.measureText(text).width + 28);
  const x0 = (256 - tw) / 2;
  g.fillStyle = 'rgba(8,14,24,0.62)';
  g.beginPath();
  if (g.roundRect) g.roundRect(x0, 10, tw, 44, 12); else g.rect(x0, 10, tw, 44);
  g.fill();
  g.fillStyle = T.light;
  g.fillRect(x0 + 10, 47, tw - 20, 3);
  g.fillStyle = '#ffffff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 128, 31, 228);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/* ---------------- 아바타 ---------------- */

let lodSeed = 0;

class Avatar {
  constructor(id, opts, mgr) {
    this.id = id;
    this.mgr = mgr;
    this.name = opts.name || String(id);
    this.badge = opts.badge ? String(opts.badge) : '';
    this.team = TEAMS[opts.team] ? opts.team : 'charterer';
    this.avatarId = avatarIdOf(opts.avatar);
    this.buffer = new SnapshotBuffer({ maxExtrapolate: 150 });
    this.sample = { pos: [0, 0, 0], yaw: 0, pitch: 0, alive: true, moving: false };
    this.pos = [0, 0, 0];          // 화면(보간) 위치 = 히트박스 위치
    this.yaw = 0;
    this.pitch = 0;
    this.alive = true;
    this.visible = true;
    this.crouch = 0;               // 앉은 자세 비율 0..1 (0.12초 전환) — 히트박스도 이 값
    this.crouchTarget = false;
    this.emoteCode = 0;
    this.heldKey = 'gun';
    this.held = null;              // 무기 담당의 3인칭 모형(setHeld)
    this.aiGlasses = false;
    this.death = null;             // { t, dir:[x,z] } 쓰러진 때와 방향(월드). 몸은 engine/corpse.js 시간표대로 누웠다가 가라앉아 숨는다
    this.corpse = { sink: 0, shown: true };
    this.lastPos = null;
    this.vel = [0, 0];             // 로컬 속도(m/s, 부드럽게)
    this.isLocal = false;          // 3인칭 때의 내 몸
    this.data = opts.data || {};
    this.lodFrame = lodSeed++ % 6; // 먼 대원들의 갱신 프레임을 흩어 놓는다
    this.lodDt = 0;
    this.root = new THREE.Group();
    this.root.name = 'avatar:' + id;
    this.body = null;
    if (mgr.tpl) this.attachBody(mgr.tpl);
    this.buildTag();
    mgr.scene.add(this.root);
  }

  /** 모델을 받으면 몸을 붙인다(그 전에 바뀐 팀·대원·무기·쓰러짐도 그대로) */
  attachBody(tpl) {
    if (this.body) return;
    const b = this.body = new OperatorBody(tpl, this.avatarId, this.team);
    this.root.add(b.root);
    b.setHeldKey(this.heldKey);
    if (this.held) b.setHeld(this.held);
    if (this.aiGlasses) b.setAiGlasses(true);
    if (this.death) b.kill(this.localDir(this.death.dir));
  }

  isAlly() { return !!this.mgr.localTeam && this.mgr.localTeam === this.team; }

  /** 이름표를 (다시) 만든다. 아군 = 상태 표시 + 이름(벽 너머로도), 적 = 상태 표시만(없으면 이름표 없음). 규칙은 engine/nametag.js */
  buildTag() {
    const ally = this.isAlly();
    const text = tagText(this.name, this.badge, ally);
    const y = this.tag ? this.tag.position.y : 2.18;
    if (this.tag) { this.tag.material.map.dispose(); this.tag.material.dispose(); this.root.remove(this.tag); }
    const tex = makeNameTexture(text, this.team);
    const smat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: !ally, fog: false });
    this.tag = new THREE.Sprite(smat);
    this.tag.scale.set(1.1, 0.275, 1);
    this.tag.position.set(0, y, 0);
    this.tag.renderOrder = 10;
    this.tag.userData.ally = ally;
    this.tag.userData.text = text;
    this.tag.visible = !!text && this.alive && !this.isLocal;
    this.root.add(this.tag);
  }

  /** 내 팀이 바뀌면(setLocalTeam) 아군·적이 바뀐 이름표만 다시 만든다 */
  applyTagMode() {
    if (!this.tag || this.tag.userData.ally !== this.isAlly()) this.buildTag();
  }

  setName(name) { if (name && name !== this.name) { this.name = String(name); this.buildTag(); } }
  setBadge(badge) { const b = badge ? String(badge) : ''; if (b !== this.badge) { this.badge = b; this.buildTag(); } }
  setTeam(team) {
    if (!TEAMS[team] || team === this.team) return;
    this.team = team;
    if (this.body) this.body.setLook(this.avatarId, team);
    this.buildTag();
  }
  /** 캐릭터 바꾸기(모르는 id는 기본 캐릭터). 쓰러져 있거나 이모트 중이어도 다음 프레임부터 새 모양이다 */
  setAvatar(id) {
    const v = avatarIdOf(id);
    if (v === this.avatarId) return;
    this.avatarId = v;
    if (this.body) this.body.setLook(v, this.team);
  }
  setAiGlasses(on) {
    this.aiGlasses = !!on;
    if (this.body) this.body.setAiGlasses(this.aiGlasses);
  }
  /** 무기 담당의 3인칭 모형으로 교체(null이면 기본 모양). obj는 손 소켓 기준(총구 = -Z) */
  setHeld(obj) {
    this.held = obj || null;
    if (this.body) this.body.setHeld(this.held);
  }

  /** 칼을 휘두르기 시작한다. 'stab'은 앞으로 내지르고, 나머지는 좌우를 번갈아 벤다 */
  swing(kind) { if (this.body) this.body.swing(kind); }
  /** 사격 반동(총을 쏠 때마다) */
  recoil() { if (this.body) this.body.recoil(); }
  /** 재장전 동작(sec초) */
  reload(sec) { if (this.body) this.body.reload(sec); }
  /** 수류탄·투척 무기를 던지는 동작 */
  throwNade() { if (this.body) this.body.throwNade(); }

  /** 월드 방향 [x, z] → 아바타 공간(yaw를 뺀다) */
  localDir(dir) {
    if (!dir) return null;
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
    return [dir[0] * c - dir[1] * s, dir[0] * s + dir[1] * c];
  }

  /** 즉시 쓰러짐(피 없음). dir: 쓰러질 방향 [x, z] (총알 진행 방향 등) */
  kill(opt = {}) {
    if (this.death) return;
    this.alive = false;
    let dx = 0, dz = 1;
    if (opt.dir) { dx = opt.dir[0]; dz = opt.dir[opt.dir.length === 3 ? 2 : 1]; }
    const l = Math.hypot(dx, dz) || 1;
    this.death = { t: 0, dir: [dx / l, dz / l] };
    if (this.body) this.body.kill(this.localDir(this.death.dir));
    this.tag.visible = false;
  }

  revive() {
    this.alive = true;
    this.death = null;
    this.crouch = 0;
    this.crouchTarget = false;
    this.emoteCode = 0;
    if (this.body) this.body.revive();
    this.tag.visible = !!this.tag.userData.text && !this.isLocal;   // 거리·생존은 다음 update가 다시 본다
  }

  update(renderTime, dt) {
    const s = this.buffer.sample(renderTime, this.sample);
    if (s) {
      this.pos[0] = s.pos[0]; this.pos[1] = s.pos[1]; this.pos[2] = s.pos[2];
      this.yaw = s.yaw; this.pitch = s.pitch || 0;
      if (s.alive === false && !this.death) this.kill({ dir: s.deathDir || null });
      else if (s.alive !== false && this.death && this.death.t > 0.05 && s.respawned) this.revive();
      if (s.name && s.name !== this.name) this.setName(s.name);
      if (s.team && s.team !== this.team && TEAMS[s.team]) this.setTeam(s.team);
      if (s.avatar && s.avatar !== this.avatarId) this.setAvatar(s.avatar);
      this.crouchTarget = !!s.crouch && s.alive !== false;
      this.emoteCode = typeof s.emote === 'number' ? s.emote | 0 : s.emote ? ((emoteById(s.emote) || {}).code || 0) : 0;
      this.heldKey = heldKeyOf(s.slot, s.weaponId);
    }
    if (this.death) this.death.t += dt;
    // 앉기 자세 전환(히트박스와 같은 비율)
    const ct = this.crouchTarget ? 1 : 0, cstep = dt / PLAYER.CROUCH_TIME;
    if (!this.death) this.crouch = this.crouch < ct ? Math.min(ct, this.crouch + cstep) : Math.max(ct, this.crouch - cstep);
    const ck = this.crouch * this.crouch * (3 - 2 * this.crouch);
    // 쓰러진 몸: 누운 채 잠깐 있다가 땅으로 가라앉고, 다 가라앉으면 부활할 때까지 숨긴다(살아 있는 사람처럼 보이지 않게)
    const corpse = this.death ? corpseState(this.death.t, this.corpse) : null;
    this.root.position.set(this.pos[0], this.pos[1] - (corpse ? corpse.sink : 0), this.pos[2]);
    this.root.rotation.y = this.yaw;

    // 실제 이동(보간된 위치 차이) → 로컬 속도. 순간이동(큰 점프)은 무시한다
    if (this.lastPos && dt > 0) {
      const dx = this.pos[0] - this.lastPos[0], dz = this.pos[2] - this.lastPos[2];
      const c = Math.cos(this.yaw), sn = Math.sin(this.yaw);
      let lx = (dx * c - dz * sn) / dt, lz = (dx * sn + dz * c) / dt;
      if (Math.hypot(lx, lz) > 12) lx = lz = 0;
      const k = Math.min(1, dt * 12);
      this.vel[0] += (lx - this.vel[0]) * k; this.vel[1] += (lz - this.vel[1]) * k;
    }
    if (!this.lastPos) this.lastPos = [0, 0, 0];
    this.lastPos[0] = this.pos[0]; this.lastPos[1] = this.pos[1]; this.lastPos[2] = this.pos[2];
    this.tag.position.y = 2.18 - 0.5 * ck;

    if (this.body && (!corpse || corpse.shown)) {
      this.body.setHeldKey(this.heldKey);
      // 애니메이션 LOD: 먼 대원·화면 밖 대원은 몇 프레임에 한 번(밀린 시간을 한꺼번에) 계산한다
      const cam = this.mgr.camera && this.mgr.camera.position;
      const dist = cam ? Math.hypot(cam.x - this.pos[0], cam.y - this.pos[1] - 1, cam.z - this.pos[2]) : 0;
      let every = 1;
      if (!this.isLocal) {
        for (const [d, n] of LOD) if (dist < d) { every = n; break; }
        if (this.mgr.frustum && !this.mgr.inView(this.pos)) every = LOD_OFFSCREEN;
      }
      this.lodDt += dt;
      this.lodFrame = (this.lodFrame + 1) % every;
      if (this.lodFrame === 0 || every === 1) {
        this.body.update(this.lodDt, { moveX: this.vel[0], moveZ: this.vel[1], crouch: ck, pitch: this.pitch, emote: this.emoteCode });
        this.lodDt = 0;
      }
    }

    // 이름표: 아군은 이름(벽 너머로도), 적은 이름 없이 상태 표시만 35 m 안에서(engine/nametag.js)
    const cam = this.mgr.camera && this.mgr.camera.position;
    const show = tagShown({
      text: this.tag.userData.text, ally: this.tag.userData.ally, alive: this.alive, visible: this.visible, local: this.isLocal,
      dist: cam ? Math.hypot(cam.x - this.pos[0], cam.z - this.pos[2]) : 0
    });
    if (this.tag.visible !== show) this.tag.visible = show;
    this.root.visible = this.visible && (!corpse || corpse.shown);
  }

  dispose() {
    this.mgr.scene.remove(this.root);
    if (this.body) this.body.dispose();
    if (this.tag) { this.tag.material.map.dispose(); this.tag.material.dispose(); }
  }
}

export function createAvatars({ scene, camera, delay = NET.INTERP_DELAY_MS } = {}) {
  const map = new Map();
  const frustum = new THREE.Frustum();
  const projView = new THREE.Matrix4();
  const sphere = new THREE.Sphere(new THREE.Vector3(), 1.3);
  const mgr = {
    scene, camera, localTeam: null, tpl: operatorsReady(), frustum: null,
    inView(p) { sphere.center.set(p[0], p[1] + 0.9, p[2]); return frustum.intersectsSphere(sphere); }
  };
  let interpDelay = delay;
  let lastNow = 0;
  let local = null; // 3인칭(이모트) 때 보이는 내 몸 — 히트 대상·목록에는 넣지 않는다
  let warm = null;

  function onReady(tpl) {
    mgr.tpl = tpl;
    for (const a of map.values()) a.attachBody(tpl);
    if (local) local.attachBody(tpl);
    return tpl;
  }
  // 부팅하자마자 받기 시작한다(맵 로드의 prewarm이 결과를 기다린다). 실패는 prewarm이 다시 시도하며 화면에 알린다
  if (!mgr.tpl) loadOperators().then(onReady, (err) => console.error('[avatars]', err.message || err));

  /**
   * 미리 준비용 묶음: 대원 하나의 뼈대에 모든 대원 × 두 팀 지오메트리를 붙인 메시와 든 무기·안경 메시.
   * 지오메트리·재질은 실제 아바타와 같아서 한 번 그리면 GPU 버퍼·셰이더(그림자 포함)가 모두 준비된다.
   * 화면 아래 멀리(y −1000)에 두고 frustumCulled=false라 보이지 않게 그려진다.
   */
  function getWarm(tpl) {
    if (warm) return warm;
    const body = new OperatorBody(tpl, OPERATOR_IDS[0], TEAM_IDS[0]);
    body.root.name = 'avatars:prewarm';
    body.root.position.set(0, -1000, 0);
    body.update(0, {});
    const skeleton = body.mesh.skeleton;
    const add = (m) => { m.frustumCulled = false; m.castShadow = true; return m; };
    add(body.mesh);
    for (const id of OPERATOR_IDS) {
      for (const team of TEAM_IDS) {
        const m = new THREE.SkinnedMesh(tpl.geometry(id, team), tpl.material);
        body.root.add(add(m));
        m.bind(skeleton, new THREE.Matrix4());
      }
    }
    for (const key of HELD_KEYS) body.root.add(add(new THREE.Mesh(heldGeometry(key), tpl.material)));
    body.root.add(add(new THREE.Mesh(glassesGeometry(), tpl.material)));
    warm = body;
    return warm;
  }

  function add(id, opts = {}) {
    let a = map.get(id);
    if (a) {
      if (opts.name) a.setName(opts.name);
      if (opts.badge !== undefined) a.setBadge(opts.badge);
      if (opts.team) a.setTeam(opts.team);
      if (opts.avatar !== undefined) a.setAvatar(opts.avatar);
      return a;
    }
    a = new Avatar(id, opts, mgr);
    map.set(id, a);
    return a;
  }

  function remove(id) {
    const a = map.get(id);
    if (!a) return;
    a.dispose();
    map.delete(id);
  }

  return {
    add,
    remove,
    get: (id) => map.get(id) || null,
    has: (id) => map.has(id),
    list: () => Array.from(map.values()),
    get size() { return map.size; },
    clear() { for (const id of Array.from(map.keys())) remove(id); },
    /** 스냅샷 넣기. 아바타가 없으면 자동 생성 */
    push(id, t, state) {
      const a = map.get(id) || add(id, { name: state && state.name, team: state && state.team, avatar: state && state.avatar });
      a.buffer.push(t, state);
      return a;
    },
    /** 순간이동(보간 없이) — 스폰 등 */
    teleport(id, state, t = performance.now()) {
      const a = map.get(id);
      if (!a) return;
      a.buffer.clear();
      a.buffer.push(t - 1000, state);
      a.buffer.push(t, state);
      a.lastPos = null;
      a.vel[0] = a.vel[1] = 0;
      if (state && state.alive !== false) a.revive();
    },
    update(now = performance.now(), dt = 0) {
      lastNow = now;
      if (mgr.camera && mgr.camera.projectionMatrix) {
        mgr.camera.updateMatrixWorld();
        frustum.setFromProjectionMatrix(projView.multiplyMatrices(mgr.camera.projectionMatrix, mgr.camera.matrixWorldInverse));
        mgr.frustum = frustum;
      } else mgr.frustum = null;
      const rt = now - interpDelay;
      for (const a of map.values()) a.update(rt, dt);
      if (local && local.visible) local.update(0, dt);
    },
    /**
     * 3인칭(이모트) 때 내 몸을 그린다. player.getBodyState()를 매 프레임 그대로 넘기면 된다(core main.js가 함).
     * { visible, pos:[x,y,z](보간된 화면 위치), yaw, pitch, team, name, emote(번호), crouch, slot?, weaponId?, avatar? }. visible:false면 숨김.
     */
    setLocalBody(o) {
      if (!o || !o.visible) {
        if (local && local.visible) { local.visible = false; local.root.visible = false; }
        return;
      }
      const team = TEAMS[o.team] ? o.team : 'owner';
      if (!local) { local = new Avatar('__local', { name: o.name || '', team, avatar: o.avatar }, mgr); local.isLocal = true; local.tag.visible = false; }
      else {
        if (team !== local.team) local.setTeam(team);
        local.setAvatar(o.avatar);
      }
      local.visible = true;
      local.buffer.clear();
      local.buffer.push(0, { pos: [o.pos[0], o.pos[1], o.pos[2]], yaw: o.yaw || 0, pitch: o.pitch || 0, alive: true, crouch: !!o.crouch, emote: o.emote | 0, slot: o.slot, weaponId: o.weaponId });
      local.setAiGlasses(!!o.aiGlasses);
    },
    /**
     * 맵 로드 때 부른다: 대원 모델을 기다리고(받지 못하면 이유를 담아 던진다 → 맵 불러오기 실패로 화면에 알린다),
     * 준비용 메시를 장면에 넣고 fn()(예: compileAsync + 한 번 그리기)을 기다린 뒤 뺀다.
     */
    async prewarm(fn) {
      const tpl = mgr.tpl || onReady(await loadOperators());
      const g = getWarm(tpl).root;
      scene.add(g);
      try { if (fn) await fn(g); }
      finally { scene.remove(g); }
      return g.children.length;
    },
    /** 품질(그림자 켬·끔)이 바뀐 뒤: 셰이더만 다시 준비(그리지 않음). three r170 compile(object, camera, targetScene) */
    compileWarm(three, cam) {
      if (!mgr.tpl) return;
      const g = getWarm(mgr.tpl).root;
      scene.add(g);
      try { if (three && three.compile) three.compile(g, cam || mgr.camera, scene); }
      catch (err) { /* 미지원 */ }
      finally { scene.remove(g); }
    },
    /** 대원 모델을 받았는가 */
    get modelReady() { return !!mgr.tpl; },
    /** 내 몸 아바타(없으면 null) */
    get localBody() { return local; },
    /** raycastPlayers 대상 — 화면에 보이는(보간된) 위치·방향과 같다 */
    getTargets(out = []) {
      out.length = 0;
      for (const a of map.values()) {
        if (!a.alive || !a.visible) continue;
        out.push({ id: a.id, pos: a.pos, yaw: a.yaw, alive: true, crouch: a.crouch, team: a.team, name: a.name });
      }
      return out;
    },
    setLocalTeam(team) {
      mgr.localTeam = team;
      for (const a of map.values()) a.applyTagMode();
    },
    setCamera(cam) { mgr.camera = cam; },
    setDelay(ms) { interpDelay = Math.max(0, +ms || 0); },
    get delay() { return interpDelay; },
    get lastUpdate() { return lastNow; },
    HITBOX,
    lerpAngle,
    dispose() {
      for (const id of Array.from(map.keys())) remove(id);
      if (local) { local.dispose(); local = null; }
      if (warm) { warm.dispose(); warm = null; }
    }
  };
}

/* ---------------- 상점 초상 ----------------
 * 게임 렌더러 하나로 대원 × 팀마다 한 번 그려 PNG data URL로 둔다(두 번째 WebGL 컨텍스트를 만들지 않는다).
 * 1) 같은 대원 모델을 총 든 자세로 세워 2배 크기 렌더 타깃(선형, 가능하면 half float)에 그리고
 * 2) 화면과 같은 톤 매핑(Neutral)·sRGB 변환을 하며 1배로 줄여(2×2 평균) 8비트 타깃에 옮긴 뒤 읽는다.
 *    three는 렌더 타깃에 그릴 때 톤 매핑·색 공간 변환을 하지 않으므로 2단계에서 직접 한다. 배경은 투명.
 * 모델을 아직 받는 중이면 null(저장하지 않음)을 주고, ready가 풀리면 UI가 다시 그린다.
 */
const POST_VERT = 'varying vec2 vUv;\nvoid main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';
const POST_FRAG = [
  'uniform sampler2D tSrc;',
  'varying vec2 vUv;',
  // three r170 NeutralToneMapping(노출 1)과 같다
  'vec3 neutral(vec3 color) {',
  '  const float StartCompression = 0.8 - 0.04;',
  '  const float Desaturation = 0.15;',
  '  float x = min(color.r, min(color.g, color.b));',
  '  float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;',
  '  color -= offset;',
  '  float peak = max(color.r, max(color.g, color.b));',
  '  if (peak < StartCompression) return color;',
  '  float d = 1. - StartCompression;',
  '  float newPeak = 1. - d * d / (peak + d - StartCompression);',
  '  color *= newPeak / peak;',
  '  float g = 1. - 1. / (Desaturation * (peak - newPeak) + 1.);',
  '  return mix(color, vec3(newPeak), g);',
  '}',
  'vec3 toSrgb(vec3 c) { return mix(pow(c, vec3(0.41666)) * 1.055 - vec3(0.055), c * 12.92, vec3(lessThanEqual(c, vec3(0.0031308)))); }',
  'void main() {',
  '  vec4 s = texture2D(tSrc, vUv);',            // 2×2 텍셀 한가운데를 선형 보간으로 읽어 평균(가장자리는 덮인 만큼 알파)
  '  vec3 c = s.a > 0.0001 ? s.rgb / s.a : vec3(0.0);',
  '  gl_FragColor = vec4(toSrgb(clamp(neutral(max(c, vec3(0.0))), 0.0, 1.0)), s.a);',
  '}'
].join('\n');

/**
 * three: 게임의 WebGLRenderer(main.js ctx.renderer.three). get(id, team)은 처음 한 번만 그리고 그 뒤로는 저장한 값을 준다.
 * 그릴 수 없으면(WebGL 오류 등) null → UI는 아이콘을 보여 준다. ready = 모델을 받으면 풀리는 Promise(실패하면 거부).
 */
export function createAvatarPortraits(three, { width = 240, height = 320 } = {}) {
  const cache = new Map();
  let P = null;
  let poser = null;
  let broken = !three || typeof three.setRenderTarget !== 'function' || typeof document === 'undefined';
  const ready = loadOperators();
  ready.catch(() => {});

  function setup(type) {
    const src = new THREE.WebGLRenderTarget(width * 2, height * 2, { type, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: true, generateMipmaps: false });
    const out = new THREE.WebGLRenderTarget(width, height, { type: THREE.UnsignedByteType, depthBuffer: false, generateMipmaps: false });
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xd6e6ff, 0x5a5040, 1.45));
    const sun = new THREE.DirectionalLight(0xffffff, 2.6);
    sun.position.set(-1.8, 3.4, -3.2);
    scene.add(sun);
    // 무릎(약 0.5 m)부터 모자·헬멧 끝(약 1.85 m)까지 꽉 차게 담는다. 머리 장비가 대원을 가장 잘 구별하므로 전신보다 크게 보인다
    const cam = new THREE.PerspectiveCamera(27, width / height, 0.1, 20);
    cam.position.set(0, 1.3, -2.85);
    cam.lookAt(0, 1.18, 0);
    const post = new THREE.ShaderMaterial({
      uniforms: { tSrc: { value: src.texture } }, vertexShader: POST_VERT, fragmentShader: POST_FRAG,
      depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: false
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), post);
    quad.frustumCulled = false;
    const postScene = new THREE.Scene();
    postScene.add(quad);
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    return {
      type, src, out, scene, cam, post, quad, postScene, postCam: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1),
      canvas, g2: canvas.getContext('2d'), buf: new Uint8Array(width * height * 4)
    };
  }
  function release() {
    if (!P) return;
    P.src.dispose(); P.out.dispose(); P.post.dispose(); P.quad.geometry.dispose();
    P = null;
  }
  function floatOk() {
    try { return !!(three.extensions && (three.extensions.has('EXT_color_buffer_float') || three.extensions.has('EXT_color_buffer_half_float'))); }
    catch (e) { return false; }
  }

  /** 한 장 그리기 → 덮인 픽셀이 있으면 true */
  function draw(tpl, id, team) {
    if (!poser) {
      poser = new OperatorBody(tpl, id, team);
      poser.root.rotation.y = 0.5;                   // 오른쪽 앞에서 본 3/4 모습
    }
    poser.setLook(id, team);
    poser.idleT = 0.4;
    poser.update(0, { pitch: 0.05 });
    P.scene.add(poser.root);
    const prevTarget = three.getRenderTarget();
    const prevClear = three.getClearColor(new THREE.Color());
    const prevAlpha = three.getClearAlpha();
    const prevAuto = three.autoClear;
    try {
      three.autoClear = true;
      three.setClearColor(0x000000, 0);
      three.setRenderTarget(P.src);
      three.render(P.scene, P.cam);
      three.setRenderTarget(P.out);
      three.render(P.postScene, P.postCam);
      three.readRenderTargetPixels(P.out, 0, 0, width, height, P.buf);
    } finally {
      three.setRenderTarget(prevTarget);
      three.setClearColor(prevClear, prevAlpha);
      three.autoClear = prevAuto;
      P.scene.remove(poser.root);
    }
    for (let i = 3; i < P.buf.length; i += 4) if (P.buf[i] > 0) return true;
    return false;
  }

  function get(id, team) {
    const key = avatarIdOf(id) + ':' + (TEAMS[team] ? team : 'owner');
    if (cache.has(key)) return cache.get(key);
    const tpl = operatorsReady();
    if (broken || !tpl) return null;   // 모델을 받는 중이면 저장하지 않고 나중에 다시 그린다
    let url = null;
    try {
      if (!P) P = setup(floatOk() ? THREE.HalfFloatType : THREE.UnsignedByteType);
      let ok = draw(tpl, id, team);
      if (!ok && P.type !== THREE.UnsignedByteType) { release(); P = setup(THREE.UnsignedByteType); ok = draw(tpl, id, team); }   // half float에 못 그리는 기기
      if (ok) {
        const img = P.g2.createImageData(width, height);
        const row = width * 4;
        for (let y = 0; y < height; y++) img.data.set(P.buf.subarray((height - 1 - y) * row, (height - y) * row), y * row);   // 아래부터 읽힌 줄을 뒤집는다
        P.g2.putImageData(img, 0, 0);
        url = P.canvas.toDataURL('image/png');
      }
    } catch (err) {
      console.warn('[avatars] 초상을 그리지 못했어요', err);
      broken = true;
      release();
    }
    cache.set(key, url);
    return url;
  }

  return {
    get,
    ready,
    get size() { return cache.size; },
    dispose() { release(); cache.clear(); if (poser) { poser.dispose(); poser = null; } }
  };
}
