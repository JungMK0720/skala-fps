/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: three.js 렌더러 래퍼. 씬, 카메라, 뷰모델 패스, 하늘, 그림자, 자동 품질을 관리한다.
 */
/**
 * SKALA 작전 — 렌더러 (three.js 0.170)
 *
 *   const R = createRenderer({ container, settings, bus });
 *   R.scene / R.camera(원근, FOV 75, rotation.order 'YXZ')
 *   R.viewScene / R.viewCamera   — 무기 뷰모델 전용 씬(깊이 지운 뒤 위에 그림, 벽에 안 파묻힘)
 *   R.setTheme(theme)            — 하늘 그라데이션·안개·태양·반구광
 *   R.setFov(deg) / R.zoomTo(deg, ms) / R.getFov() / R.getZoomProgress() / R.setBaseFov(deg) / R.baseFov
 *   R.setShadowFocus(x, y, z)    — 그림자 영역을 플레이어 주변으로
 *   R.update(dt) → R.render()
 *
 * 성능: pixelRatio ≤ 1.5, 그림자 1장(1024, 플레이어 주변 ±36 m), 'low' 품질 = 그림자 끔 + pixelRatio 1.
 *       'auto'는 프레임이 계속 느리면(>24 ms) 단계적으로 품질을 낮춘다.
 */
import * as THREE from 'three';
import { VIEW } from '../core/consts.js';
import { setAnisotropy } from './materials.js';

const SKY_VS = `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}`;
const SKY_FS = `
uniform vec3 uTop;
uniform vec3 uHorizon;
uniform vec3 uBottom;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 col;
  if (h >= 0.0) col = mix(uHorizon, uTop, pow(smoothstep(0.0, 1.0, h), 0.55));
  else col = mix(uHorizon, uBottom, smoothstep(0.0, 0.2, -h));
  float s = max(dot(d, uSunDir), 0.0);
  col += uSunColor * (pow(s, 1200.0) * 4.0 + pow(s, 60.0) * 0.25 + pow(s, 8.0) * 0.06);
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

const QUALITY = {
  high: { maxPR: 1.5, shadows: true, shadowSize: 1024, antialias: true },
  medium: { maxPR: 1.25, shadows: true, shadowSize: 1024, antialias: false },
  low: { maxPR: 1, shadows: false, shadowSize: 512, antialias: false }
};

export function createRenderer({ container, settings, bus, preferLow = false } = {}) {
  const qSetting = (settings && settings.get('quality')) || 'auto';
  // 휴대폰(preferLow)은 '자동'이면 저사양으로 시작한다. 자동 품질은 낮추기만 하고 올리지 않는다
  let level = qSetting === 'low' || (preferLow && qSetting === 'auto') ? 'low' : 'high';
  const dpr = window.devicePixelRatio || 1;
  // 고해상도 화면은 MSAA 대신 pixelRatio로 (비용 절약)
  const antialias = QUALITY[level].antialias && dpr < 1.5;
  const renderer = new THREE.WebGLRenderer({ antialias, powerPreference: 'high-performance', stencil: false, alpha: false });
  renderer.setPixelRatio(Math.min(dpr, QUALITY[level].maxPR));
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = QUALITY[level].shadows;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.autoClear = false;
  renderer.info.autoReset = false; // 두 패스(월드+뷰모델)를 합쳐 집계 → render()에서 직접 reset
  renderer.setClearColor(0x0b1624, 1);
  const canvas = renderer.domElement;
  canvas.className = 'core-canvas';
  canvas.tabIndex = 0;
  if (container) container.appendChild(canvas);
  setAnisotropy(Math.min(8, renderer.capabilities.getMaxAnisotropy()));

  // --- 씬 · 카메라 ---
  const scene = new THREE.Scene();
  scene.name = 'world';
  let baseFov = (settings && settings.get('fov')) || VIEW.FOV;
  const camera = new THREE.PerspectiveCamera(baseFov, 1, VIEW.NEAR, VIEW.FAR);
  camera.rotation.order = 'YXZ';
  camera.position.set(0, 1.6, 0);
  scene.add(camera);

  // --- 조명 ---
  const hemi = new THREE.HemisphereLight(0xcfe3ff, 0x5a5040, 1.0);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffffff, 2.6);
  sun.castShadow = QUALITY[level].shadows;
  sun.shadow.mapSize.set(QUALITY[level].shadowSize, QUALITY[level].shadowSize);
  const SH = 36;
  Object.assign(sun.shadow.camera, { left: -SH, right: SH, top: SH, bottom: -SH, near: 1, far: 260 });
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.045;
  scene.add(sun, sun.target);
  const sunDir = new THREE.Vector3(-0.45, 0.8, -0.35).normalize();

  // --- 하늘 ---
  const skyU = {
    uTop: { value: new THREE.Color('#3f78b5') },
    uHorizon: { value: new THREE.Color('#a9cde8') },
    uBottom: { value: new THREE.Color('#6d7f8c') },
    uSunDir: { value: sunDir.clone() },
    uSunColor: { value: new THREE.Color('#fff1d8') }
  };
  const skyMat = new THREE.ShaderMaterial({
    uniforms: skyU, vertexShader: SKY_VS, fragmentShader: SKY_FS,
    side: THREE.BackSide, depthWrite: false, fog: false, toneMapped: false
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), skyMat);
  sky.scale.setScalar(VIEW.FAR * 0.8);
  sky.renderOrder = -1000;
  sky.frustumCulled = false;
  sky.name = 'sky';
  scene.add(sky);
  scene.fog = new THREE.Fog(0xa9cde8, 60, 240);

  // --- 뷰모델 씬 ---
  const viewScene = new THREE.Scene();
  viewScene.name = 'viewmodel';
  const viewCamera = new THREE.PerspectiveCamera(VIEW.VIEWMODEL_FOV, 1, 0.01, 30);
  viewScene.add(viewCamera);
  const viewHemi = new THREE.HemisphereLight(0xcfe3ff, 0x5a5040, 1.0);
  const viewSun = new THREE.DirectionalLight(0xffffff, 2.2);
  viewScene.add(viewHemi, viewSun, viewSun.target);
  const viewLightCount = viewScene.children.length;

  // --- 테마 ---
  let theme = null;
  function setTheme(t) {
    theme = t || theme;
    if (!theme) return;
    const horizon = new THREE.Color(theme.sky);
    const top = new THREE.Color(theme.skyTop);
    skyU.uHorizon.value.copy(horizon);
    skyU.uTop.value.copy(top);
    skyU.uBottom.value.copy(horizon).lerp(new THREE.Color(theme.water || '#55606a'), 0.55);
    sunDir.set(theme.sunDir[0], theme.sunDir[1], theme.sunDir[2]).normalize();
    updateLightSpace();
    skyU.uSunDir.value.copy(sunDir);
    skyU.uSunColor.value.set(theme.sunColor);
    scene.fog.color.copy(horizon);
    scene.fog.near = theme.fog[0];
    scene.fog.far = theme.fog[1];
    const amb = theme.ambient;
    const sunUp = Math.max(0.15, sunDir.y);
    sun.color.set(theme.sunColor);
    sun.intensity = 2.7 * Math.min(1.2, sunUp + 0.25) * (theme.sunIntensity ?? 1);
    hemi.color.copy(top).lerp(new THREE.Color(0xffffff), 0.45);
    hemi.groundColor.set(0x6b5f4e).lerp(horizon, 0.25);
    hemi.intensity = 0.55 + amb * 1.6;
    viewSun.color.copy(sun.color); viewSun.intensity = sun.intensity * 0.85;
    viewHemi.color.copy(hemi.color); viewHemi.groundColor.copy(hemi.groundColor); viewHemi.intensity = hemi.intensity;
    renderer.setClearColor(horizon, 1);
  }

  // --- FOV / 줌 ---
  let fovFrom = baseFov, fovTo = baseFov, fovT = 1, fovDur = 0;
  function applyFov(f) {
    camera.fov = f;
    camera.updateProjectionMatrix();
  }
  /** 즉시 FOV 지정 */
  function setFov(deg) {
    fovFrom = fovTo = deg; fovT = 1; fovDur = 0;
    applyFov(deg);
  }
  /** ms 동안 부드럽게 FOV 변경 (줌 인/아웃) */
  function zoomTo(deg, ms = 120) {
    if (!(ms > 0)) return setFov(deg);
    fovFrom = camera.fov; fovTo = deg; fovT = 0; fovDur = ms / 1000;
  }
  /** 현재 트윈 진행도 0..1 (줌 중이 아니면 1) */
  function getZoomProgress() { return fovT; }
  function setBaseFov(deg) {
    const wasBase = Math.abs(fovTo - baseFov) < 1e-3;
    baseFov = Math.max(60, Math.min(100, deg));
    if (wasBase) setFov(baseFov);
  }

  // --- 크기 ---
  let width = 1, height = 1;
  function resize() {
    const el = container || canvas.parentElement || document.body;
    width = Math.max(1, el.clientWidth || window.innerWidth);
    height = Math.max(1, el.clientHeight || window.innerHeight);
    renderer.setSize(width, height, true);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    viewCamera.aspect = width / height;
    viewCamera.updateProjectionMatrix();
  }
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => resize()) : null;
  if (ro && container) ro.observe(container);
  window.addEventListener('resize', resize);
  resize();

  // --- 그림자 초점 (빛 좌표계에서 텍셀 단위로 맞춰 흔들림 방지, 프레임당 할당 없음) ---
  const lightSpace = new THREE.Matrix4(), lightSpaceInv = new THREE.Matrix4();
  const tmpV = new THREE.Vector3(), ORIGIN = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0), negSun = new THREE.Vector3();
  function updateLightSpace() {
    negSun.copy(sunDir).negate();
    UP.set(Math.abs(sunDir.y) > 0.99 ? 1 : 0, Math.abs(sunDir.y) > 0.99 ? 0 : 1, 0);
    lightSpace.lookAt(ORIGIN, negSun, UP);
    lightSpaceInv.copy(lightSpace).invert();
  }
  function setShadowFocus(x, y, z) {
    const texel = (SH * 2) / sun.shadow.mapSize.x;
    tmpV.set(x, y, z).applyMatrix4(lightSpaceInv);
    tmpV.x = Math.round(tmpV.x / texel) * texel;
    tmpV.y = Math.round(tmpV.y / texel) * texel;
    tmpV.applyMatrix4(lightSpace);
    sun.target.position.copy(tmpV);
    sun.position.copy(tmpV).addScaledVector(sunDir, 120);
    sun.target.updateMatrixWorld();
  }
  updateLightSpace();
  setTheme({ sky: '#a9cde8', skyTop: '#3f78b5', fog: [60, 240], sunDir: [-0.45, 0.8, -0.35], sunColor: '#fff1d8', ambient: 0.5 });
  setShadowFocus(0, 0, 0);

  // --- 품질 / 자동 조절 ---
  let slowTime = 0, fastTime = 0;
  function setQuality(q) {
    level = QUALITY[q] ? q : 'high';
    const Q = QUALITY[level];
    renderer.setPixelRatio(Math.min(dpr, Q.maxPR));
    if (renderer.shadowMap.enabled !== Q.shadows) {
      renderer.shadowMap.enabled = Q.shadows;
      sun.castShadow = Q.shadows;
      // 그림자 켜고 끌 때 재질 셰이더 재컴파일 필요
      scene.traverse((o) => { if (o.material) [].concat(o.material).forEach((m) => { m.needsUpdate = true; }); });
    }
    if (sun.shadow.mapSize.x !== Q.shadowSize) {
      sun.shadow.mapSize.set(Q.shadowSize, Q.shadowSize);
      if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
    }
    resize();
    if (bus) bus.emit('renderer:quality', { level });
  }
  if (settings && bus) {
    bus.on('settings:change', (e) => {
      if (e.key === 'quality') setQuality(e.value === 'low' ? 'low' : 'high');
      if (e.key === 'fov') setBaseFov(e.value);
    });
  }

  function autoQuality(dt) {
    if (!settings || settings.get('quality') !== 'auto' || document.hidden) return;
    if (dt > 0.024 && dt < 0.25) { slowTime += dt; fastTime = 0; }
    else if (dt < 0.018) { fastTime += dt; slowTime = Math.max(0, slowTime - dt * 0.5); }
    if (slowTime > 3) {
      slowTime = 0;
      const next = level === 'high' ? 'medium' : level === 'medium' ? 'low' : null;
      if (!next) return;
      // 그림자를 켜고 끄는 단계(medium → low)는 모든 재질 셰이더를 다시 컴파일해 0.4~0.9초 멈춘다.
      // 그래서 바로 바꾸지 않고 미뤄 두었다가 안전한 때(로드아웃·라운드 끝·사망·맵 로드) applyPendingQuality()로 바꾼다.
      if (QUALITY[next].shadows !== renderer.shadowMap.enabled) pendingAuto = next;
      else setQuality(next);
    }
  }
  let pendingAuto = null;
  /** 미뤄 둔 자동 품질 변경을 지금 적용한다(잠깐 멈춰도 되는 때 부른다). 바꿨으면 true */
  function applyPendingQuality() {
    const q = pendingAuto;
    pendingAuto = null;
    if (!q || !settings || settings.get('quality') !== 'auto' || q === level) return false;
    setQuality(q);
    return true;
  }
  if (bus) bus.on('map:loading', () => { applyPendingQuality(); });

  const camPos = new THREE.Vector3();
  const camQ = new THREE.Quaternion();
  function update(dt) {
    if (fovT < 1) {
      fovT = Math.min(1, fovT + dt / fovDur);
      const k = 1 - Math.pow(1 - fovT, 3); // ease-out
      applyFov(fovFrom + (fovTo - fovFrom) * k);
    }
    camera.getWorldPosition(camPos);
    sky.position.copy(camPos);
    // 뷰모델 조명: 월드 태양 방향을 카메라 좌표로
    camera.getWorldQuaternion(camQ);
    viewSun.position.copy(sunDir).applyQuaternion(camQ.invert()).multiplyScalar(10);
    autoQuality(dt);
  }

  function render() {
    renderer.info.reset();
    renderer.clear(true, true, false);
    renderer.render(scene, camera);
    if (viewScene.children.length > viewLightCount) {
      renderer.clearDepth();
      renderer.render(viewScene, viewCamera);
    }
  }

  function dispose() {
    window.removeEventListener('resize', resize);
    if (ro) ro.disconnect();
    sky.geometry.dispose();
    skyMat.dispose();
    renderer.dispose();
    if (canvas.parentElement) canvas.parentElement.removeChild(canvas);
  }

  return {
    three: renderer,
    renderer,
    domElement: canvas,
    scene,
    camera,
    viewScene,
    viewCamera,
    sun,
    hemi,
    get baseFov() { return baseFov; },
    get quality() { return level; },
    get size() { return { width, height }; },
    get theme() { return theme; },
    setTheme,
    setFov,
    zoomTo,
    getFov: () => camera.fov,
    getZoomProgress,
    setBaseFov,
    setShadowFocus,
    setQuality,
    applyPendingQuality,
    get pendingQuality() { return pendingAuto; },
    resize,
    update,
    render,
    info: () => renderer.info,
    dispose
  };
}
