/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 무기 플러그인 없이 코어만 띄울 때 쓰는 임시 히트스캔 총. 판정과 렌더링 시험용이다.
 */
/**
 * SKALA FPS — 임시 히트스캔 총 (core 시연용)
 * 무기 플러그인(weapons/index.js가 provides:['weapons'])이 붙으면 만들어지지 않는다.
 *
 * - 좌클릭 연사 600 rpm, 우클릭 1.6배 줌, R 재장전(30발), 피해: 머리 100 · 몸 30 · 다리 22
 * - 판정: ctx.traceShot (벽이 먼저 막으면 사람을 맞히지 않음)
 * - bus: weapon:fire / hit:world / hit:player / weapon:ammo / weapon:reload 를 무기 모듈과 같은 형식으로 발행
 */
import * as THREE from 'three';
import { CROUCH_SPREAD_MUL } from '../core/consts.js';

const DAMAGE = { head: 100, body: 30, legs: 22, hand: 15, foot: 15 };
const MAG = 30;
const INTERVAL = 60 / 600;
const RELOAD_S = 1.4;
const ZOOM = 1.6;

export function createDevGun(ctx) {
  const { bus, player, renderer, input, settings } = ctx;
  const offs = [];
  let firing = false, cooldown = 0, ammo = MAG, reloading = 0, aiming = false;
  let flashT = 0, recoilAnim = 0, aimBlend = 0, swayX = 0, swayY = 0;
  let shotSeq = 0;
  const weaponId = 'devgun';

  // --- 뷰모델 (viewScene, 카메라 좌표계) ---
  const vm = new THREE.Group();
  vm.name = 'devgun-viewmodel';
  const dark = new THREE.MeshLambertMaterial({ color: 0x2c3136 });
  const mid = new THREE.MeshLambertMaterial({ color: 0x4a5258 });
  const wood = new THREE.MeshLambertMaterial({ color: 0x6b4f33 });
  const accent = new THREE.MeshLambertMaterial({ color: 0xe8731c });
  // 카메라 좌표(뷰모델 FOV 60): 총구는 화면 오른쪽 아래에서 중앙 쪽으로
  const parts = [
    [new THREE.BoxGeometry(0.042, 0.058, 0.34), dark, 0, 0, -0.2],        // 몸통(리시버)
    [new THREE.BoxGeometry(0.02, 0.02, 0.27), mid, 0, 0.012, -0.5],       // 총열
    [new THREE.BoxGeometry(0.034, 0.085, 0.042), dark, 0, -0.068, -0.08], // 손잡이
    [new THREE.BoxGeometry(0.032, 0.085, 0.05), dark, 0, -0.07, -0.24],   // 탄창
    [new THREE.BoxGeometry(0.038, 0.062, 0.15), wood, 0, -0.012, 0.04],   // 개머리
    [new THREE.BoxGeometry(0.018, 0.024, 0.1), mid, 0, 0.041, -0.17],     // 가늠자 레일
    [new THREE.BoxGeometry(0.044, 0.01, 0.08), accent, 0, 0.022, -0.3]    // 주황 띠
  ];
  for (const [g, m, x, y, z] of parts) { const mesh = new THREE.Mesh(g, m); mesh.position.set(x, y, z); vm.add(mesh); }
  const flashMat = new THREE.SpriteMaterial({ color: 0xffd28a, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, opacity: 0.95 });
  const flash = new THREE.Sprite(flashMat);
  flash.position.set(0, 0.012, -0.66);
  flash.scale.set(0.13, 0.13, 1);
  flash.visible = false;
  vm.add(flash);
  const HIP = new THREE.Vector3(0.17, -0.165, -0.3), ADS = new THREE.Vector3(0, -0.045, -0.22);
  vm.scale.setScalar(0.8);
  vm.position.copy(HIP);
  renderer.viewScene.add(vm);

  // --- 예광선 (한 개의 LineSegments) ---
  const MAX_TR = 24;
  const trPos = new Float32Array(MAX_TR * 6);
  const trCol = new Float32Array(MAX_TR * 6);
  const trLife = new Float32Array(MAX_TR);
  const trGeo = new THREE.BufferGeometry();
  trGeo.setAttribute('position', new THREE.BufferAttribute(trPos, 3).setUsage(THREE.DynamicDrawUsage));
  trGeo.setAttribute('color', new THREE.BufferAttribute(trCol, 3).setUsage(THREE.DynamicDrawUsage));
  const trMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
  const tracers = new THREE.LineSegments(trGeo, trMat);
  tracers.frustumCulled = false;
  renderer.scene.add(tracers);
  let trNext = 0;

  // --- 탄흔 (InstancedMesh, 오래된 것부터 덮어씀) ---
  const MAX_DEC = 80;
  const decGeo = new THREE.CircleGeometry(0.045, 8);
  const decMat = new THREE.MeshBasicMaterial({ color: 0x15130f, transparent: true, opacity: 0.85, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const decals = new THREE.InstancedMesh(decGeo, decMat, MAX_DEC);
  decals.count = 0;
  decals.frustumCulled = false;
  renderer.scene.add(decals);
  let decNext = 0;
  const spark = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0xfff0c0, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }));
  spark.scale.set(0.35, 0.35, 1);
  spark.visible = false;
  renderer.scene.add(spark);
  let sparkT = 0;

  const tmpM = new THREE.Matrix4(), tmpQ = new THREE.Quaternion(), tmpS = new THREE.Vector3(1, 1, 1);
  const zAxis = new THREE.Vector3(0, 0, 1), nrm = new THREE.Vector3(), pos = new THREE.Vector3();
  const muzzle = new THREE.Vector3();

  function emitAmmo() { bus.emit('weapon:ammo', { weapon: weaponId, slot: 1, ammo, mag: MAG, reserve: Infinity, reloading: reloading > 0 }); }

  function addTracer(a, b) {
    const i = trNext; trNext = (trNext + 1) % MAX_TR;
    trPos.set([a[0], a[1], a[2], b[0], b[1], b[2]], i * 6);
    trLife[i] = 1;
    trGeo.attributes.position.needsUpdate = true;
  }
  function addDecal(point, normal) {
    nrm.set(normal[0], normal[1], normal[2]);
    pos.set(point[0], point[1], point[2]).addScaledVector(nrm, 0.012);
    tmpQ.setFromUnitVectors(zAxis, nrm);
    tmpM.compose(pos, tmpQ, tmpS.set(0.8 + Math.random() * 0.5, 0.8 + Math.random() * 0.5, 1));
    decals.setMatrixAt(decNext, tmpM);
    decNext = (decNext + 1) % MAX_DEC;
    decals.count = Math.min(MAX_DEC, decals.count + 1);
    decals.instanceMatrix.needsUpdate = true;
  }

  function fire() {
    const st = player.state;
    const origin = player.getEye();
    const dir = player.getAimDir();
    // 탄퍼짐: 정조준 < 서서 < 이동 < 공중
    const hs = Math.hypot(st.vel[0], st.vel[2]);
    let spread = aiming ? 0.0012 : 0.009;
    spread += Math.min(1, hs / 5.2) * (aiming ? 0.004 : 0.014);
    if (!st.onGround) spread += 0.035;
    if (st.crouch) spread *= CROUCH_SPREAD_MUL; // 앉으면 ×0.8
    const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * spread;
    // 조준 방향에 수직인 두 축
    const rx = Math.cos(st.yaw), rz = -Math.sin(st.yaw);
    const ux = -dir[1] * rz, uy = dir[2] * rx - dir[0] * rz, uz = dir[1] * rx; // up = dir × right ... (근사)
    const ul = Math.hypot(ux, uy, uz) || 1;
    dir[0] += (rx * Math.cos(a) + (ux / ul) * Math.sin(a)) * r;
    dir[1] += ((uy / ul) * Math.sin(a)) * r;
    dir[2] += (rz * Math.cos(a) + (uz / ul) * Math.sin(a)) * r;
    const dl = Math.hypot(dir[0], dir[1], dir[2]);
    dir[0] /= dl; dir[1] /= dl; dir[2] /= dl;

    const shotId = st.id + ':' + (++shotSeq);
    const res = ctx.traceShot(origin, dir, 400, { ignoreId: st.id });
    bus.emit('weapon:fire', { shooterId: st.id, weapon: weaponId, slot: 1, origin, dir, aimed: aiming, shotId });
    if (res.kind === 'player') {
      const damage = DAMAGE[res.part] || 0;
      bus.emit('hit:player', { shooterId: st.id, weapon: weaponId, targetId: res.id, part: res.part, damage, point: res.point, dist: res.dist, dir, shotId });
    } else if (res.kind === 'world') {
      bus.emit('hit:world', { shooterId: st.id, weapon: weaponId, point: res.point, normal: res.normal, mat: res.mat, dist: res.dist, dir, shotId });
      addDecal(res.point, res.normal);
      spark.position.set(res.point[0] + res.normal[0] * 0.05, res.point[1] + res.normal[1] * 0.05, res.point[2] + res.normal[2] * 0.05);
      spark.visible = true; sparkT = 0.06;
    }
    // 예광선: 총구 위치(뷰모델 끝을 월드로 근사)
    muzzle.set(aiming ? 0 : 0.16, aiming ? -0.06 : -0.14, -0.7).applyQuaternion(renderer.camera.quaternion).add(renderer.camera.position);
    addTracer([muzzle.x, muzzle.y, muzzle.z], res.point);
    // 반동
    player.kick(0.016 + Math.random() * 0.006, (Math.random() - 0.5) * 0.008);
    player.addRecoil(aiming ? 0.0016 : 0.0028, (Math.random() - 0.5) * 0.0024);
    flashT = 0.045; recoilAnim = 1;
    ammo--;
    if (ammo <= 0) startReload();
    emitAmmo();
  }

  function startReload() {
    if (reloading > 0 || ammo >= MAG) return;
    reloading = RELOAD_S;
    bus.emit('weapon:reload', { weapon: weaponId, slot: 1, time: RELOAD_S });
    emitAmmo();
  }

  function setAim(active) {
    aiming = active;
    const base = renderer.baseFov;
    renderer.zoomTo(active ? base / ZOOM : base, 110);
    input.setLookScale(active ? (1 / ZOOM) * ((settings && settings.get('zoomSensitivity')) || 1) : 1);
    bus.emit('weapon:zoom', { weapon: weaponId, active, fov: active ? base / ZOOM : base });
  }

  offs.push(bus.on('input:fire', (e) => {
    firing = !!e.down;
    if (firing && cooldown <= 0 && ammo <= 0) startReload();
  }));
  offs.push(bus.on('input:aim', (e) => setAim(!!e.active)));
  offs.push(bus.on('input:reload', () => startReload()));
  offs.push(bus.on('player:death', () => { firing = false; if (aiming) setAim(false); }));
  offs.push(bus.on('player:spawn', () => { ammo = MAG; reloading = 0; emitAmmo(); }));

  function tick(dt) {
    if (cooldown > 0) cooldown -= dt;
    if (reloading > 0) {
      reloading -= dt;
      if (reloading <= 0) { reloading = 0; ammo = MAG; emitAmmo(); }
      return;
    }
    if (firing && cooldown <= 0 && ammo > 0 && player.state.alive) {
      fire();
      cooldown += INTERVAL;
      if (cooldown < 0) cooldown = 0;
    }
    if (!firing && cooldown < 0) cooldown = 0;
  }

  let lastYaw = player.state.yaw, lastPitch = player.state.pitch;
  function frame(dt) {
    // 예광선 페이드
    let dirty = false;
    for (let i = 0; i < MAX_TR; i++) {
      if (trLife[i] <= 0) continue;
      trLife[i] = Math.max(0, trLife[i] - dt / 0.09);
      const k = trLife[i];
      trCol.set([1 * k, 0.85 * k, 0.5 * k, 0.6 * k, 0.4 * k, 0.15 * k], i * 6);
      dirty = true;
    }
    if (dirty) trGeo.attributes.color.needsUpdate = true;
    if (sparkT > 0) { sparkT -= dt; if (sparkT <= 0) spark.visible = false; }
    // 뷰모델: 정조준 위치, 흔들림, 반동
    aimBlend += ((aiming ? 1 : 0) - aimBlend) * Math.min(1, dt * 14);
    const st = player.state;
    const dyaw = st.yaw - lastYaw, dpitch = st.pitch - lastPitch;
    lastYaw = st.yaw; lastPitch = st.pitch;
    swayX += (Math.max(-0.04, Math.min(0.04, dyaw * 0.6)) - swayX) * Math.min(1, dt * 10);
    swayY += (Math.max(-0.04, Math.min(0.04, -dpitch * 0.6)) - swayY) * Math.min(1, dt * 10);
    recoilAnim = Math.max(0, recoilAnim - dt * 9);
    const hs = Math.hypot(st.vel[0], st.vel[2]);
    const bob = st.onGround ? Math.min(1, hs / 5.2) * (1 - aimBlend * 0.8) : 0;
    const t = performance.now() / 1000;
    vm.position.lerpVectors(HIP, ADS, aimBlend);
    vm.position.x += swayX * (1 - aimBlend * 0.7) + Math.cos(t * 6.2) * 0.008 * bob;
    vm.position.y += swayY * (1 - aimBlend * 0.7) + Math.abs(Math.sin(t * 6.2)) * 0.01 * bob - (reloading > 0 ? 0.12 : 0);
    vm.position.z += recoilAnim * 0.05;
    vm.rotation.set(recoilAnim * 0.08 + (reloading > 0 ? -0.5 : 0), 0, reloading > 0 ? 0.4 : 0);
    vm.visible = st.alive && !(player.thirdPerson > 0); // 이모트 3인칭이면 뷰모델 숨김
    flash.visible = flashT > 0;
    if (flashT > 0) { flashT -= dt; flash.material.rotation = Math.random() * Math.PI; }
  }

  const offTick = ctx.loop.onTick(tick);
  const offFrame = ctx.loop.onFrame(frame);
  emitAmmo();

  return {
    id: weaponId,
    get ammo() { return ammo; },
    get aiming() { return aiming; },
    /** 테스트용: 한 발 즉시 발사 */
    fireOnce() { if (ammo > 0 && reloading <= 0) fire(); },
    dispose() {
      offs.forEach((o) => o()); offs.length = 0;
      offTick(); offFrame();
      if (aiming) setAim(false);
      renderer.viewScene.remove(vm);
      renderer.scene.remove(tracers, decals, spark);
      vm.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
      [dark, mid, wood, accent, flashMat, trMat, decMat, spark.material].forEach((m) => m.dispose());
      trGeo.dispose(); decGeo.dispose(); decals.dispose();
    }
  };
}
