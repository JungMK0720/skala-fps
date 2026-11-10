/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: three.js 전투·이동 이펙트(총구 섬광, 예광탄, 피격, 폭발, 탄피, 발판, 포털, 비밀 스팟, 칼날 불꽃, 속도 줄기). 도형·캔버스 텍스처만 쓴다.
 */
// createEffects(scene, camera, opts?) → { muzzleFlash, tracer, impact, explosion, shellEject, padBurst, portalFlash,
//   secretSparkle, slashSpark, setSpeedAmount, update, dispose, ... }
// 모든 파티클·메시는 생성 시 한 번 만든 풀을 재사용한다(프레임당 할당 없음). 그림자 없음, 포인트 라이트 최대 2개.
import * as THREE from 'three';

const QUALITY = {
  high: { pts: 1600, streaks: 320, mult: 1, decals: 96, shells: 24, muzzleLight: true, speedLines: 44, extraRing: true },
  low: { pts: 500, streaks: 96, mult: 0.45, decals: 32, shells: 8, muzzleLight: false, speedLines: 16, extraRing: false }
};
const CAP_PTS = QUALITY.high.pts, CAP_STREAK = QUALITY.high.streaks;
const CAP_DECAL = QUALITY.high.decals, CAP_SHELL = QUALITY.high.shells, CAP_SPEED = QUALITY.high.speedLines;
const N_FLASH = 8, N_TRACER = 28, N_RING = 8, N_BURST = 3, N_LIGHT = 2;

// 재질 팔레트(ARCHITECTURE 4절) → 피격 이펙트 계열
const METAL = new Set(['steel', 'rust', 'deck', 'tank', 'pipe', 'container_red', 'yellow', 'white', 'metal_dark']);
const GLASSY = new Set(['glass', 'neon_cyan', 'neon_pink']);   // 네온도 유리 관이라 조각이 튄다
const DUST = {
  concrete: { dust: [0.73, 0.70, 0.64], chip: [0.44, 0.42, 0.39], decal: 0x2c2a27 },
  asphalt: { dust: [0.47, 0.45, 0.43], chip: [0.18, 0.17, 0.16], decal: 0x121212 },
  grass: { dust: [0.55, 0.50, 0.36], chip: [0.30, 0.42, 0.18], decal: 0x2b2a1e },
  wood: { dust: [0.78, 0.68, 0.52], chip: [0.42, 0.29, 0.17], decal: 0x2a1d12 },
  stone: { dust: [0.68, 0.66, 0.62], chip: [0.42, 0.41, 0.38], decal: 0x262522 },
  brick: { dust: [0.70, 0.50, 0.42], chip: [0.46, 0.24, 0.17], decal: 0x2a1a14 },
  plaster: { dust: [0.90, 0.87, 0.80], chip: [0.72, 0.69, 0.62], decal: 0x3a372f },
  tile: { dust: [0.62, 0.64, 0.66], chip: [0.26, 0.31, 0.37], decal: 0x15181c },
  sand: { dust: [0.84, 0.76, 0.58], chip: [0.66, 0.58, 0.42], decal: 0x6e6248 },
  moss: { dust: [0.50, 0.56, 0.36], chip: [0.26, 0.36, 0.17], decal: 0x1c2414 },
  wood_dark: { dust: [0.58, 0.46, 0.34], chip: [0.30, 0.20, 0.13], decal: 0x140d08 },
  bamboo: { dust: [0.78, 0.76, 0.52], chip: [0.55, 0.57, 0.29], decal: 0x2a2a14 },
  paper: { dust: [0.95, 0.93, 0.87], chip: [0.85, 0.82, 0.72], decal: 0x3a342a }
};

const TRACER_KIND = {
  rifle: { color: 0xffd27a, r: 0.012, speed: 480, seg: 3.5, trail: false },
  sniper: { color: 0xfff1c9, r: 0.016, speed: 900, seg: 7, trail: true },
  pistol: { color: 0xffc66b, r: 0.010, speed: 360, seg: 2.2, trail: false }
};
const FLASH_KIND = {
  rifle: { w: 0.22, len: 0.38, core: 0.30, life: 0.05, light: 6, side: false },
  sniper: { w: 0.34, len: 0.60, core: 0.50, life: 0.07, light: 10, side: true },  // 머즐 브레이크 측면 화염
  pistol: { w: 0.16, len: 0.24, core: 0.22, life: 0.045, light: 4, side: false }
};
const SHELL_KIND = {                         // scale: 탄피 크기 배율, speed: 튕겨 나가는 속도 배율
  rifle: { scale: 1, speed: 1 },
  sniper: { scale: 1.45, speed: 0.85 },
  pistol: { scale: 0.72, speed: 1.1 }
};
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

// fxKind('rifle'|'sniper'|'pistol') 또는 무기 id → 표 키. 모르는 값(null, 오타, 칼의 fxKind 등)은 소총으로 처리한다.
function kindOf(kind) {
  if (typeof kind !== 'string') return 'rifle';
  const k = kind.toLowerCase();
  if (k.includes('snip') || k.startsWith('sr_')) return 'sniper';
  if (k.includes('pist') || k.startsWith('pt_')) return 'pistol';
  return 'rifle';
}

function v3(src, out) {                     // Vector3 | {x,y,z} | [x,y,z] → out
  if (!src) return out.set(0, 0, 0);
  if (Array.isArray(src)) return out.set(+src[0] || 0, +src[1] || 0, +src[2] || 0);
  return out.set(+src.x || 0, +src.y || 0, +src.z || 0);
}

const rand = (a, b) => a + (b - a) * Math.random();

/* ───────────── 캔버스 텍스처 ───────────── */

function canvasTex(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d', { willReadFrequently: true }), w, h);   // CPU 캔버스 → WebGL 업로드 시 GPU 역방향 복사 없음
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function makeTextures() {
  const flash = canvasTex(64, 64, (g, w) => {               // 둥근 섬광
    const r = g.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
    r.addColorStop(0, 'rgba(255,255,240,1)'); r.addColorStop(0.25, 'rgba(255,220,140,0.9)');
    r.addColorStop(0.6, 'rgba(255,140,40,0.35)'); r.addColorStop(1, 'rgba(255,90,0,0)');
    g.fillStyle = r; g.fillRect(0, 0, w, w);
  });
  const petal = canvasTex(64, 128, (g, w, h) => {           // 앞으로 뻗는 화염 꽃잎(아래가 총구)
    g.translate(w / 2, h * 0.08);
    for (let i = 0; i < 3; i++) {
      const s = 1 - i * 0.28;
      const r = g.createRadialGradient(0, 0, 0, 0, 0, h * 0.9 * s);
      r.addColorStop(0, 'rgba(255,250,225,1)'); r.addColorStop(0.35, 'rgba(255,196,96,0.85)');
      r.addColorStop(1, 'rgba(255,100,20,0)');
      g.fillStyle = r;
      g.beginPath(); g.ellipse(0, h * 0.38 * s, w * 0.42 * s, h * 0.45 * s, 0, 0, Math.PI * 2); g.fill();
    }
  });
  const hole = canvasTex(32, 32, (g, w) => {                // 탄흔 마스크(흰색+알파, 색은 인스턴스 컬러)
    const r = g.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
    r.addColorStop(0, 'rgba(255,255,255,0.95)'); r.addColorStop(0.35, 'rgba(255,255,255,0.85)');
    r.addColorStop(0.55, 'rgba(255,255,255,0.3)'); r.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = r; g.fillRect(0, 0, w, w);
  });
  return { flash, petal, hole };
}

/* ───────────── 포인트 파티클 시스템 (packed 배열, swap-remove) ───────────── */

const PT_VS = /* glsl */`
attribute vec4 aColor;
attribute vec2 aSize;
uniform float uScale, uFogNear, uFogFar;
varying vec4 vColor;
varying float vShape, vFog;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(aSize.x * uScale / max(0.05, -mv.z), 1.0, 480.0);
  vColor = aColor; vShape = aSize.y;
  vFog = uFogFar > 0.0 ? smoothstep(uFogNear, uFogFar, -mv.z) : 0.0;
}`;
const PT_FS = /* glsl */`
uniform vec3 uFogColor;
uniform float uAdd;
varying vec4 vColor;
varying float vShape, vFog;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float d = dot(c, c);
  if (d > 1.0) discard;
  float a = vColor.a * mix(pow(1.0 - d, 1.5), 1.0 - smoothstep(0.55, 1.0, d), vShape);
  vec3 col = vColor.rgb;
  if (uAdd > 0.5) a *= 1.0 - vFog; else col = mix(col, uFogColor, vFog);
  gl_FragColor = vec4(col, a);
}`;

// 상태 레이아웃(stride 21): p(3) v(3) age life s0 s1 a fin grav drag c0(3) c1(3) shape
const PS = 21;

function makePoints(additive, renderOrder, shared) {
  const st = new Float32Array(CAP_PTS * PS);
  const pos = new Float32Array(CAP_PTS * 3), col = new Float32Array(CAP_PTS * 4), siz = new Float32Array(CAP_PTS * 2);
  const geo = new THREE.BufferGeometry();
  const aPos = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
  const aCol = new THREE.BufferAttribute(col, 4).setUsage(THREE.DynamicDrawUsage);
  const aSiz = new THREE.BufferAttribute(siz, 2).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', aPos); geo.setAttribute('aColor', aCol); geo.setAttribute('aSize', aSiz);
  geo.setDrawRange(0, 0);
  const flush = makeUploader([aPos, aCol, aSiz]);
  const mat = new THREE.ShaderMaterial({
    uniforms: { uScale: shared.uScale, uFogNear: shared.uFogNear, uFogFar: shared.uFogFar,
      uFogColor: shared.uFogColor, uAdd: { value: additive ? 1 : 0 } },
    vertexShader: PT_VS, fragmentShader: PT_FS, transparent: true, depthWrite: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending
  });
  const obj = new THREE.Points(geo, mat);
  obj.frustumCulled = false; obj.renderOrder = renderOrder; obj.name = additive ? 'fx-points-add' : 'fx-points';
  const sys = {
    obj, n: 0, cap: CAP_PTS, dropped: 0,
    // P(프리셋): { life:[a,b], s0, s1, sj, a, fin, grav, drag, c0:[r,g,b], c1, shape }
    add(x, y, z, vx, vy, vz, P) {
      if (sys.n >= sys.cap) { sys.dropped++; return; }
      const o = sys.n++ * PS, sj = 1 + (Math.random() * 2 - 1) * (P.sj ?? 0.25), c1 = P.c1 || P.c0;
      st[o] = x; st[o + 1] = y; st[o + 2] = z; st[o + 3] = vx; st[o + 4] = vy; st[o + 5] = vz;
      st[o + 6] = 0; st[o + 7] = rand(P.life[0], P.life[1]);
      st[o + 8] = P.s0 * sj; st[o + 9] = P.s1 * sj; st[o + 10] = P.a ?? 1; st[o + 11] = P.fin ?? 0.04;
      st[o + 12] = P.grav ?? 0; st[o + 13] = P.drag ?? 0;
      st[o + 14] = P.c0[0]; st[o + 15] = P.c0[1]; st[o + 16] = P.c0[2];
      st[o + 17] = c1[0]; st[o + 18] = c1[1]; st[o + 19] = c1[2]; st[o + 20] = P.shape ?? 0;
    },
    update(dt) {
      let i = 0;
      while (i < sys.n) {
        const o = i * PS;
        const age = (st[o + 6] += dt), life = st[o + 7];
        if (age >= life) {                                  // 죽은 입자 자리에 마지막 입자를 옮긴다
          sys.n--;
          if (i !== sys.n) st.copyWithin(o, sys.n * PS, sys.n * PS + PS);
          continue;
        }
        const dg = Math.exp(-st[o + 13] * dt);
        st[o + 3] *= dg; st[o + 4] = st[o + 4] * dg + st[o + 12] * dt; st[o + 5] *= dg;
        st[o + 0] += st[o + 3] * dt; st[o + 1] += st[o + 4] * dt; st[o + 2] += st[o + 5] * dt;
        const u = age / life, inv = 1 - u;
        const alpha = st[o + 10] * Math.min(1, u / st[o + 11]) * inv;
        const p3 = i * 3, p4 = i * 4, p2 = i * 2;
        pos[p3] = st[o]; pos[p3 + 1] = st[o + 1]; pos[p3 + 2] = st[o + 2];
        col[p4] = st[o + 14] + (st[o + 17] - st[o + 14]) * u;
        col[p4 + 1] = st[o + 15] + (st[o + 18] - st[o + 15]) * u;
        col[p4 + 2] = st[o + 16] + (st[o + 19] - st[o + 16]) * u;
        col[p4 + 3] = alpha;
        siz[p2] = st[o + 8] + (st[o + 9] - st[o + 8]) * (1 - inv * inv); siz[p2 + 1] = st[o + 20];
        i++;
      }
      geo.setDrawRange(0, sys.n);
      if (sys.n) flush(sys.n);
    },
    clear() { sys.n = 0; geo.setDrawRange(0, 0); },
    dispose() { geo.dispose(); mat.dispose(); }
  };
  return sys;
}

// 활성 개수만큼만 GPU에 올린다. three.js가 업로드 뒤 범위 목록을 비우므로 같은 범위 객체를 다시 넣어 프레임당 할당을 없앤다.
function makeUploader(attrs) {
  const ranges = attrs.map(() => ({ start: 0, count: 0 }));
  return (n) => {
    for (let i = 0; i < attrs.length; i++) {
      const a = attrs[i];
      ranges[i].count = n * a.itemSize;
      a.updateRanges[0] = ranges[i];
      a.updateRanges.length = 1;
      a.needsUpdate = true;
    }
  };
}

/* ───────────── 불꽃 줄기(LineSegments, 가산 혼합) ───────────── */
// 상태(stride 14): p(3) v(3) age life grav drag c(3) stretch
const SS = 14;

function makeStreaks(renderOrder) {
  const st = new Float32Array(CAP_STREAK * SS);
  const pos = new Float32Array(CAP_STREAK * 6), col = new Float32Array(CAP_STREAK * 6);
  const geo = new THREE.BufferGeometry();
  const aPos = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
  const aCol = new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', aPos); geo.setAttribute('color', aCol);
  geo.setDrawRange(0, 0);
  const flush = makeUploader([aPos, aCol]);
  const mat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending, fog: false });
  const obj = new THREE.LineSegments(geo, mat);
  obj.frustumCulled = false; obj.renderOrder = renderOrder; obj.name = 'fx-streaks';
  const sys = {
    obj, n: 0, cap: CAP_STREAK, dropped: 0,
    add(x, y, z, vx, vy, vz, life, c, grav = -9.8, drag = 1.2, stretch = 0.022) {
      if (sys.n >= sys.cap) { sys.dropped++; return; }
      const o = sys.n++ * SS;
      st[o] = x; st[o + 1] = y; st[o + 2] = z; st[o + 3] = vx; st[o + 4] = vy; st[o + 5] = vz;
      st[o + 6] = 0; st[o + 7] = life; st[o + 8] = grav; st[o + 9] = drag;
      st[o + 10] = c[0]; st[o + 11] = c[1]; st[o + 12] = c[2]; st[o + 13] = stretch;
    },
    update(dt) {
      let i = 0;
      while (i < sys.n) {
        const o = i * SS;
        const age = (st[o + 6] += dt), life = st[o + 7];
        if (age >= life) {
          sys.n--;
          if (i !== sys.n) st.copyWithin(o, sys.n * SS, sys.n * SS + SS);
          continue;
        }
        const dg = Math.exp(-st[o + 9] * dt);
        st[o + 3] *= dg; st[o + 4] = st[o + 4] * dg + st[o + 8] * dt; st[o + 5] *= dg;
        st[o] += st[o + 3] * dt; st[o + 1] += st[o + 4] * dt; st[o + 2] += st[o + 5] * dt;
        const f = 1 - age / life, k = st[o + 13], p = i * 6;
        pos[p] = st[o]; pos[p + 1] = st[o + 1]; pos[p + 2] = st[o + 2];
        pos[p + 3] = st[o] - st[o + 3] * k; pos[p + 4] = st[o + 1] - st[o + 4] * k; pos[p + 5] = st[o + 2] - st[o + 5] * k;
        col[p] = st[o + 10] * f; col[p + 1] = st[o + 11] * f; col[p + 2] = st[o + 12] * f;
        col[p + 3] = col[p] * 0.15; col[p + 4] = col[p + 1] * 0.15; col[p + 5] = col[p + 2] * 0.15;
        i++;
      }
      geo.setDrawRange(0, sys.n * 2);
      if (sys.n) flush(sys.n * 2);
    },
    clear() { sys.n = 0; geo.setDrawRange(0, 0); },
    dispose() { geo.dispose(); mat.dispose(); }
  };
  return sys;
}

/* ───────────── 속도 줄기(카메라 공간 LineSegments, 가산 혼합) ───────────── */
// 시야 앞쪽에서 카메라 뒤로 흐르는 가는 선. 화면 가운데는 비우고 바깥으로 갈수록 밝아져 조준을 가리지 않는다.
// 상태(stride 5): x y r z len (카메라 공간, -Z가 정면). r = 축에서 떨어진 거리
const SL = 5, SPEED_FAR = -12, SPEED_NEAR = -0.6;
const SPEED_TAN0 = 0.3, SPEED_TAN1 = 1;      // 시선축과 이루는 각의 탄젠트. TAN0 안쪽은 0, TAN1 바깥은 최대 밝기

function makeSpeedLines(renderOrder) {
  const st = new Float32Array(CAP_SPEED * SL);
  const pos = new Float32Array(CAP_SPEED * 6), col = new Float32Array(CAP_SPEED * 6);
  const geo = new THREE.BufferGeometry();
  const aPos = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
  const aCol = new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', aPos); geo.setAttribute('color', aCol);
  geo.setDrawRange(0, 0);
  // 불꽃 줄기와 같은 설정 → 셰이더를 함께 쓰므로 처음 빨라지는 순간 컴파일 끊김이 없다(depthTest는 셰이더와 무관)
  const mat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, depthTest: false,
    blending: THREE.AdditiveBlending, fog: false });
  const obj = new THREE.LineSegments(geo, mat);
  obj.frustumCulled = false; obj.renderOrder = renderOrder; obj.name = 'fx-speed'; obj.visible = false;
  obj.matrixAutoUpdate = false;
  // 그리기 직전에 현재 카메라 공간으로 맞춘다 → 흔들림·갱신 순서와 상관없이 한 프레임도 밀리지 않는다
  obj.onBeforeRender = (_r, _s, cam) => { obj.matrixWorld.copy(cam.matrixWorld); };
  const spawn = (i, anywhere) => {
    const o = i * SL, ang = Math.random() * Math.PI * 2, r = rand(1.25, 3.4);
    st[o] = Math.cos(ang) * r; st[o + 1] = Math.sin(ang) * r; st[o + 2] = r;
    st[o + 3] = rand(SPEED_FAR, anywhere ? SPEED_NEAR : SPEED_FAR + 4);
    st[o + 4] = rand(1, 2.4);
  };
  for (let i = 0; i < CAP_SPEED; i++) spawn(i, true);
  const K_TAN = 1 / (SPEED_TAN1 - SPEED_TAN0);
  const sys = {
    obj, n: 0,
    target: 0, cur: 0,                       // 세기 0..1. 객체 필드라 갱신해도 숫자를 새로 만들지 않는다(클로저 변수는 만든다)
    // 세기에 따라 줄기 수·속도·길이·밝기가 함께 늘어난다. off: 동작 줄이기
    update(dt, cap, off) {
      const want = off ? 0 : sys.target;
      sys.cur += (want - sys.cur) * (1 - Math.exp(-dt * (want > sys.cur ? 5 : 9)));   // 천천히 켜지고 빨리 꺼진다
      if (want === 0 && sys.cur < 0.01) sys.cur = 0;
      const amount = sys.cur, n = Math.round(amount * cap);
      sys.n = n;
      obj.visible = n > 0;
      geo.setDrawRange(0, n * 2);
      if (!n) return;
      const step = (16 + 30 * amount) * dt, stretch = 0.3 + 0.4 * amount, peak = 0.02 + 0.07 * amount;
      for (let i = 0; i < n; i++) {
        const o = i * SL;
        if ((st[o + 3] += step) > SPEED_NEAR) spawn(i, false);
        const x = st[o], y = st[o + 1], r = st[o + 2], z = st[o + 3], z1 = z + st[o + 4] * stretch;
        // 화면 바깥쪽일수록 밝다(양 끝점의 시선축 탄젠트로 계산)
        const u0 = (r / Math.max(0.05, -z) - SPEED_TAN0) * K_TAN, u1 = (r / Math.max(0.05, -z1) - SPEED_TAN0) * K_TAN;
        const b0 = u0 <= 0 ? 0 : u0 >= 1 ? peak : peak * u0, b1 = u1 <= 0 ? 0 : u1 >= 1 ? peak : peak * u1;
        const p = i * 6;
        pos[p] = x; pos[p + 1] = y; pos[p + 2] = z;
        pos[p + 3] = x; pos[p + 4] = y; pos[p + 5] = z1;
        col[p] = 0.78 * b0; col[p + 1] = 0.9 * b0; col[p + 2] = b0;
        col[p + 3] = 0.78 * b1; col[p + 4] = 0.9 * b1; col[p + 5] = b1;
      }
      aPos.needsUpdate = true; aCol.needsUpdate = true;      // 작은 고정 버퍼라 통째로 올린다
    },
    clear() { sys.n = 0; sys.target = 0; sys.cur = 0; obj.visible = false; geo.setDrawRange(0, 0); },
    dispose() { geo.dispose(); mat.dispose(); }
  };
  return sys;
}

/* ───────────── 파티클 프리셋 (공유 상수 → 생성 시 할당 없음) ───────────── */
const P = {
  sparkDot: { life: [0.08, 0.2], s0: 0.05, s1: 0.015, a: 1, grav: -9.8, drag: 2, c0: [1, 0.9, 0.6], c1: [1, 0.45, 0.1], shape: 1 },
  sparkFlash: { life: [0.05, 0.07], s0: 0.28, s1: 0.06, sj: 0.1, a: 1, c0: [1, 0.92, 0.7], c1: [1, 0.6, 0.2] },
  wisp: { life: [0.5, 0.8], s0: 0.08, s1: 0.4, a: 0.28, fin: 0.15, grav: 0.3, drag: 3, c0: [0.55, 0.55, 0.55], c1: [0.7, 0.7, 0.7] },
  muzzleSmoke: { life: [0.6, 0.9], s0: 0.08, s1: 0.45, a: 0.22, fin: 0.12, grav: 0.35, drag: 2.5, c0: [0.62, 0.62, 0.6], c1: [0.75, 0.75, 0.74] },
  dust: { life: [0.6, 1.1], s0: 0.08, s1: 0.5, a: 0.55, fin: 0.08, grav: -0.5, drag: 3, c0: [0.73, 0.7, 0.64], shape: 0 },
  chip: { life: [0.4, 0.7], s0: 0.035, s1: 0.03, a: 1, grav: -9.8, drag: 0.5, c0: [0.44, 0.42, 0.39], shape: 1 },
  drop: { life: [0.5, 0.9], s0: 0.055, s1: 0.03, a: 0.9, grav: -9.8, drag: 0.3, c0: [0.85, 0.93, 1], shape: 1 },
  mist: { life: [0.5, 0.8], s0: 0.15, s1: 0.7, a: 0.35, fin: 0.1, grav: 0.2, drag: 2.5, c0: [0.92, 0.96, 1] },
  shard: { life: [0.3, 0.6], s0: 0.03, s1: 0.02, a: 0.95, grav: -9.8, drag: 0.4, c0: [0.85, 0.95, 1], shape: 1 },
  glint: { life: [0.06, 0.1], s0: 0.2, s1: 0.04, a: 1, c0: [0.9, 0.97, 1] },
  hitPuff: { life: [0.07, 0.1], s0: 0.32, s1: 0.1, a: 1, c0: [1, 0.96, 0.82], c1: [1, 0.7, 0.3] },
  fire: { life: [0.35, 0.6], s0: 0.6, s1: 2.2, a: 1, fin: 0.05, grav: 1.5, drag: 3.5, c0: [1, 0.93, 0.7], c1: [0.9, 0.28, 0.04] },
  smoke: { life: [2.2, 3.6], s0: 1.0, s1: 4.2, a: 0.55, fin: 0.12, grav: 0.6, drag: 1.2, c0: [0.22, 0.21, 0.2], c1: [0.46, 0.45, 0.43] },
  groundDust: { life: [1.2, 1.8], s0: 0.6, s1: 2.4, a: 0.45, fin: 0.1, drag: 2.5, c0: [0.55, 0.5, 0.42], c1: [0.62, 0.58, 0.5] },
  ember: { life: [0.5, 1.0], s0: 0.07, s1: 0.03, a: 1, grav: -9.8, drag: 0.8, c0: [1, 0.85, 0.45], c1: [1, 0.35, 0.05], shape: 1 },
  // 발판·포털: c0·c1·a는 호출할 때 색과 동작 줄이기 설정에 맞춰 채운다
  padFlash: { life: [0.12, 0.18], s0: 1.1, s1: 0.4, sj: 0.1, a: 0.85, c0: [1, 1, 1], c1: [1, 1, 1] },
  padDot: { life: [0.3, 0.6], s0: 0.085, s1: 0.02, a: 1, grav: -6, drag: 1.4, c0: [1, 1, 1], c1: [1, 1, 1], shape: 1 },
  portalCore: { life: [0.16, 0.22], s0: 1.4, s1: 3.2, sj: 0.08, a: 0.8, c0: [1, 1, 1], c1: [1, 1, 1] },
  portalDot: { life: [0.35, 0.75], s0: 0.09, s1: 0.015, a: 1, drag: 2.2, c0: [1, 1, 1], c1: [1, 1, 1], shape: 1 },
  secretDot: { life: [0.7, 1.3], s0: 0.07, s1: 0.012, a: 1, fin: 0.12, grav: 0.5, drag: 1.4, c0: [1, 0.97, 0.72], c1: [1, 0.72, 0.2], shape: 1 },
  secretGlint: { life: [0.5, 0.9], s0: 0.22, s1: 0.03, a: 0.9, fin: 0.55, grav: 0.3, drag: 1, c0: [1, 1, 0.9], c1: [1, 0.85, 0.4] },
  slashFlash: { life: [0.05, 0.08], s0: 0.34, s1: 0.06, sj: 0.12, a: 1, c0: [1, 1, 0.96], c1: [0.72, 0.86, 1] },
  slashDot: { life: [0.1, 0.24], s0: 0.045, s1: 0.012, a: 1, grav: -9.8, drag: 2.2, c0: [1, 0.98, 0.9], c1: [1, 0.66, 0.3], shape: 1 }
};
// 줄기 색은 LineBasicMaterial 정점색(선형 공간 → 출력 시 sRGB 변환)이라 채도를 높게 잡는다
const SPARK_C = [1, 0.42, 0.08], EMBER_C = [1, 0.34, 0.05], HIT_C = [1, 0.72, 0.36];
const STEEL_C = [1, 0.66, 0.34], GOLD_C = [1, 0.6, 0.12];

export function createEffects(scene, camera, opts = {}) {
  const tex = makeTextures();
  const root = new THREE.Group();
  root.name = 'fx-root';
  scene.add(root);

  const shared = {
    uScale: { value: 600 }, uFogNear: { value: 0 }, uFogFar: { value: 0 }, uFogColor: { value: new THREE.Color(0x888888) }
  };
  const ptsAlpha = makePoints(false, 20, shared);
  const ptsAdd = makePoints(true, 21, shared);
  const streaks = makeStreaks(22);
  const speedLines = makeSpeedLines(24);
  root.add(ptsAlpha.obj, ptsAdd.obj, streaks.obj, speedLines.obj);

  let quality = 'high', Q = QUALITY.high;
  const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  let rmOverride = null, reduced = !!mq?.matches;
  const onMQ = (e) => { if (rmOverride === null) reduced = e.matches; };
  mq?.addEventListener?.('change', onMQ);
  let applyShake = opts.applyShake !== false;
  let disposed = false, time = 0;

  // 임시 벡터(재사용)
  const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _n = new THREE.Vector3(), _t1 = new THREE.Vector3();
  const _t2 = new THREE.Vector3(), _d = new THREE.Vector3(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
  const _m = new THREE.Matrix4(), _s = new THREE.Vector3(), _v2 = new THREE.Vector2(), _c = new THREE.Color();
  const Z = new THREE.Vector3(0, 0, 1), UP = new THREE.Vector3(0, 1, 0);

  /* ── 포인트 라이트 풀(정확히 2개, 항상 씬에 둔다 → 라이트 개수 변화로 인한 셰이더 재컴파일 없음) ── */
  const lights = [];
  for (let i = 0; i < N_LIGHT; i++) {
    const l = new THREE.PointLight(0xffaa55, 0, 8, 2);
    l.castShadow = false; l.name = 'fx-light';
    root.add(l);
    lights.push({ l, active: false, t: 0, life: 0, i0: 0, prio: 0 });
  }
  function useLight(pos, color, intensity, dist, life, prio) {
    let s = lights.find((x) => !x.active);
    if (!s) {
      s = lights.reduce((m, x) => (x.prio < m.prio || (x.prio === m.prio && x.t > m.t) ? x : m));
      if (s.prio > prio) return;                            // 폭발 라이트는 총구 섬광이 빼앗지 못한다
    }
    s.active = true; s.t = 0; s.life = life; s.i0 = intensity; s.prio = prio;
    s.l.position.copy(pos); s.l.color.setHex(color); s.l.distance = dist; s.l.intensity = intensity;
  }

  /* ── 총구 섬광 풀 ── */
  const petalGeo = (() => {                                // +Z로 뻗는 십자 평면 2장
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([
      -0.5, 0, 0, 0.5, 0, 0, 0.5, 0, 1, -0.5, 0, 1, 0, -0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1], 2));
    g.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
    return g;
  })();
  const flashes = [];
  for (let i = 0; i < N_FLASH; i++) {
    const g = new THREE.Group();
    const pm = new THREE.MeshBasicMaterial({ map: tex.petal, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false });
    const petal = new THREE.Mesh(petalGeo, pm);
    const sideL = new THREE.Mesh(petalGeo, pm), sideR = new THREE.Mesh(petalGeo, pm);
    sideL.rotation.y = Math.PI / 2; sideR.rotation.y = -Math.PI / 2;
    const sm = new THREE.SpriteMaterial({ map: tex.flash, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, fog: false });
    const core = new THREE.Sprite(sm);
    g.add(petal, sideL, sideR, core);
    g.visible = false; g.renderOrder = 23;
    for (const o of g.children) o.renderOrder = 23;
    root.add(g);
    flashes.push({ g, petal, sideL, sideR, core, pm, sm, active: false, t: 0, life: 0.05, K: FLASH_KIND.rifle, a: 1 });
  }

  /* ── 예광탄 풀 ── */
  const tracerGeo = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true);
  tracerGeo.rotateX(Math.PI / 2); tracerGeo.translate(0, 0, 0.5);       // z: 0..1
  const tracers = [];
  for (let i = 0; i < N_TRACER; i++) {
    const m = new THREE.MeshBasicMaterial({ color: 0xffd27a, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, fog: false });
    const mesh = new THREE.Mesh(tracerGeo, m);
    mesh.visible = false; mesh.renderOrder = 22; mesh.frustumCulled = false;
    root.add(mesh);
    tracers.push({ mesh, m, active: false, trail: false, from: new THREE.Vector3(), dir: new THREE.Vector3(),
      dist: 0, t: 0, life: 0, speed: 0, seg: 0, r: 0 });
  }

  /* ── 링 풀(충격파·물결) ── */
  const ringGeo = new THREE.RingGeometry(0.82, 1, 48, 1);
  const rings = [];
  for (let i = 0; i < N_RING; i++) {
    const m = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(ringGeo, m);
    mesh.visible = false; mesh.renderOrder = 21;
    root.add(mesh);
    rings.push({ mesh, m, active: false, t: 0, life: 0, r0: 0, r1: 0, a0: 0 });
  }

  /* ── 폭발 섬광 스프라이트 풀 ── */
  const bursts = [];
  for (let i = 0; i < N_BURST; i++) {
    const m = new THREE.SpriteMaterial({ map: tex.flash, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, fog: false });
    const s = new THREE.Sprite(m);
    s.visible = false; s.renderOrder = 23;
    root.add(s);
    bursts.push({ s, m, active: false, t: 0, life: 0.28, size: 7, a: 1 });
  }

  /* ── 탄흔(InstancedMesh 1 draw call, 링 버퍼) ── */
  const decalMat = new THREE.MeshBasicMaterial({ map: tex.hole, transparent: true, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
  const decalGeo = new THREE.PlaneGeometry(1, 1);
  const decals = new THREE.InstancedMesh(decalGeo, decalMat, CAP_DECAL);
  decals.count = 0; decals.frustumCulled = false; decals.renderOrder = 19; decals.name = 'fx-decals';
  decals.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  decals.setColorAt(0, _c.set(0x222222));
  root.add(decals);
  let decalNext = 0, decalUsed = 0;

  /* ── 탄피(InstancedMesh) ── */
  const shellGeo = new THREE.CylinderGeometry(0.0055, 0.0055, 0.024, 6, 1);
  const shellMat = new THREE.MeshLambertMaterial({ color: 0xc8a046, emissive: 0x2a1c05 });
  const shellMesh = new THREE.InstancedMesh(shellGeo, shellMat, CAP_SHELL);
  shellMesh.frustumCulled = false; shellMesh.name = 'fx-shells';
  shellMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
  for (let i = 0; i < CAP_SHELL; i++) shellMesh.setMatrixAt(i, ZERO);
  root.add(shellMesh);
  const shells = [];
  for (let i = 0; i < CAP_SHELL; i++) {
    shells.push({ active: false, p: new THREE.Vector3(), v: new THREE.Vector3(), q: new THREE.Quaternion(),
      axis: new THREE.Vector3(1, 0, 0), spin: 0, t: 0, life: 0, ground: 0, bounces: 0, scale: 1 });
  }

  /* ── 화면 흔들림 ── */
  let trauma = 0;
  const shake = { pitch: 0, yaw: 0, roll: 0 };
  const applied = { on: false, x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 };

  const cnt = (n) => Math.max(1, Math.round(n * Q.mult));
  const flashK = () => (reduced ? 0.4 : 1);                // 감소된 동작: 섬광 세기 ↓

  function basis(n) {                                      // n에 수직인 t1, t2
    _t1.copy(Math.abs(n.y) < 0.9 ? UP : Z).cross(n).normalize();
    _t2.copy(n).cross(_t1);
  }
  function coneDir(n, spread, out) {                       // n 주위 원뿔 안의 무작위 방향(basis 선행 필요)
    const th = Math.random() * spread, ph = Math.random() * Math.PI * 2, s = Math.sin(th);
    return out.copy(n).multiplyScalar(Math.cos(th))
      .addScaledVector(_t1, Math.cos(ph) * s).addScaledVector(_t2, Math.sin(ph) * s);
  }
  function sphereDir(out) {
    const u = Math.random() * 2 - 1, ph = Math.random() * Math.PI * 2, s = Math.sqrt(1 - u * u);
    return out.set(s * Math.cos(ph), u, s * Math.sin(ph));
  }

  function addDecal(p, n, color) {
    if (!Q.decals) return;
    _q.setFromUnitVectors(Z, n);
    _q2.setFromAxisAngle(Z, Math.random() * Math.PI * 2);
    _q.multiply(_q2);
    const sc = rand(0.06, 0.1);
    _m.compose(_a.copy(p).addScaledVector(n, 0.004), _q, _s.set(sc, sc, sc));
    const i = decalNext;
    decals.setMatrixAt(i, _m);
    decals.setColorAt(i, _c.setHex(color));
    decalNext = (decalNext + 1) % Q.decals;
    decalUsed = Math.min(Q.decals, decalUsed + 1);
    decals.count = decalUsed;
    decals.instanceMatrix.needsUpdate = true;
    decals.instanceColor.needsUpdate = true;
  }

  /** 총구 섬광. pos: 총구 위치, dir: 사격 방향(정규화), kind: 'rifle'|'sniper'|'pistol' */
  function muzzleFlash(pos, dir, kind = 'rifle') {
    if (disposed) return;
    const K = FLASH_KIND[kindOf(kind)];
    v3(pos, _a);
    v3(dir, _d);
    if (_d.lengthSq() < 1e-8) camera.getWorldDirection(_d); else _d.normalize();
    const f = flashes.find((x) => !x.active) || flashes.reduce((m, x) => (x.t > m.t ? x : m));
    f.active = true; f.t = 0; f.K = K; f.life = K.life; f.a = flashK();
    f.g.position.copy(_a);
    _q.setFromUnitVectors(Z, _d);
    _q2.setFromAxisAngle(Z, Math.random() * Math.PI);
    f.g.quaternion.multiplyQuaternions(_q, _q2);
    f.petal.scale.set(K.w, K.w, K.len * rand(0.85, 1.15));
    f.sideL.visible = f.sideR.visible = K.side;
    if (K.side) { f.sideL.scale.set(K.w * 0.55, K.w * 0.55, K.len * 0.5); f.sideR.scale.copy(f.sideL.scale); }
    f.core.scale.setScalar(K.core);
    f.pm.opacity = f.sm.opacity = f.a;
    f.g.visible = true;
    if (Q.muzzleLight && !reduced) useLight(_b.copy(_a).addScaledVector(_d, 0.3), 0xffb35a, K.light, 7, K.life + 0.02, 1);
    // 옅은 총구 연기
    for (let i = 0, n = cnt(K.side ? 4 : 2); i < n; i++) {
      ptsAlpha.add(_a.x, _a.y, _a.z, _d.x * rand(0.3, 1) + rand(-0.2, 0.2), _d.y * rand(0.3, 1) + rand(0, 0.3),
        _d.z * rand(0.3, 1) + rand(-0.2, 0.2), P.muzzleSmoke);
    }
  }

  /** 예광탄. from→to 로 빛줄기가 날아간다. 저격은 옅은 공기 궤적이 잠시 남는다. */
  function tracer(from, to, kind = 'rifle') {
    if (disposed) return;
    const K = TRACER_KIND[kindOf(kind)];
    v3(from, _a); v3(to, _b);
    const dist = _a.distanceTo(_b);
    if (dist < 0.05) return;
    _d.subVectors(_b, _a).divideScalar(dist);
    const spawn = (trail) => {
      const tr = tracers.find((x) => !x.active) || tracers.reduce((m, x) => (x.t > m.t ? x : m));
      tr.active = true; tr.trail = trail; tr.t = 0; tr.from.copy(_a); tr.dir.copy(_d); tr.dist = dist;
      tr.speed = K.speed; tr.seg = K.seg; tr.r = trail ? 0.006 : K.r;
      tr.life = trail ? 0.45 : dist / K.speed + K.seg / K.speed;
      tr.m.color.setHex(trail ? 0xcfe8ff : K.color);
      tr.m.opacity = trail ? 0.3 : 0.9;
      tr.mesh.quaternion.setFromUnitVectors(Z, _d);
      tr.mesh.position.copy(_a);
      tr.mesh.scale.set(tr.r, tr.r, trail ? dist : Math.min(dist, 0.01));
      tr.mesh.visible = true;
    };
    spawn(false);
    if (K.trail) spawn(true);
  }

  /**
   * 피격 이펙트. mat: 재질 팔레트 이름(강판=불꽃, 콘크리트=먼지, 물=물보라 …) 또는 'player'(갑옷 불꽃, 피 없음).
   * opt.decal === false면 탄흔을 남기지 않는다(움직이는 지형에 남기면 지형이 떠난 자리에 탄흔만 떠 있다)
   */
  function impact(point, normal, mat = 'concrete', opt = null) {
    if (disposed) return;
    const mark = !(opt && opt.decal === false);
    v3(point, _a);
    v3(normal || UP, _n);
    if (_n.lengthSq() < 1e-8) _n.copy(UP); else _n.normalize();
    basis(_n);
    const m = String(mat || 'concrete');
    if (m === 'water') {
      for (let i = 0, n = cnt(14); i < n; i++) {
        ptsAlpha.add(_a.x, _a.y + 0.02, _a.z, rand(-1.2, 1.2), rand(2.5, 5.5), rand(-1.2, 1.2), P.drop);
      }
      for (let i = 0, n = cnt(4); i < n; i++) ptsAlpha.add(_a.x, _a.y + 0.05, _a.z, rand(-0.4, 0.4), rand(0.3, 1), rand(-0.4, 0.4), P.mist);
      ring(_a, UP, 0.05, 0.9, 0.8, 0.5, 0xe6f4ff);
    } else if (m === 'player' || m === 'body') {
      ptsAdd.add(_a.x, _a.y, _a.z, 0, 0, 0, P.hitPuff);
      for (let i = 0, n = cnt(6); i < n; i++) {
        coneDir(_n, 1.2, _d).multiplyScalar(rand(3, 6));
        streaks.add(_a.x, _a.y, _a.z, _d.x, _d.y, _d.z, rand(0.12, 0.25), HIT_C, -6, 2, 0.018);
      }
    } else if (GLASSY.has(m)) {
      ptsAdd.add(_a.x, _a.y, _a.z, 0, 0, 0, P.glint);
      for (let i = 0, n = cnt(10); i < n; i++) {
        coneDir(_n, 1.1, _d).multiplyScalar(rand(1.5, 4));
        ptsAlpha.add(_a.x, _a.y, _a.z, _d.x, _d.y, _d.z, P.shard);
      }
      if (mark) addDecal(_a, _n, m === 'glass' ? 0xcfd8dc : 0x1c1d20);
    } else if (METAL.has(m)) {
      ptsAdd.add(_a.x, _a.y, _a.z, 0, 0, 0, P.sparkFlash);
      for (let i = 0, n = cnt(12); i < n; i++) {
        coneDir(_n, 1.0, _d).multiplyScalar(rand(4, 11));
        streaks.add(_a.x, _a.y, _a.z, _d.x, _d.y, _d.z, rand(0.18, 0.42), SPARK_C, -9.8, 1.5, 0.02);
      }
      for (let i = 0, n = cnt(3); i < n; i++) {
        coneDir(_n, 0.9, _d).multiplyScalar(rand(2, 6));
        ptsAdd.add(_a.x, _a.y, _a.z, _d.x, _d.y, _d.z, P.sparkDot);
      }
      for (let i = 0, n = cnt(2); i < n; i++) ptsAlpha.add(_a.x, _a.y, _a.z, _n.x * 0.5, _n.y * 0.5 + 0.2, _n.z * 0.5, P.wisp);
      if (mark) addDecal(_a, _n, 0x1c1d20);
    } else {
      const D = Object.prototype.hasOwnProperty.call(DUST, m) ? DUST[m] : DUST.concrete;   // 모르는 재질은 콘크리트
      for (let i = 0, n = cnt(8); i < n; i++) {
        coneDir(_n, 0.8, _d).multiplyScalar(rand(0.6, 2.2));
        P.dust.c0 = D.dust;
        ptsAlpha.add(_a.x, _a.y, _a.z, _d.x, _d.y, _d.z, P.dust);
      }
      for (let i = 0, n = cnt(5); i < n; i++) {
        coneDir(_n, 1.0, _d).multiplyScalar(rand(2, 5));
        P.chip.c0 = D.chip;
        ptsAlpha.add(_a.x, _a.y, _a.z, _d.x, _d.y, _d.z, P.chip);
      }
      if (mark) addDecal(_a, _n, D.decal);
    }
  }

  function ring(p, n, r0, r1, life, a0, color) {
    const r = rings.find((x) => !x.active) || rings.reduce((m, x) => (x.t / x.life > m.t / m.life ? x : m));
    r.active = true; r.t = 0; r.life = life; r.r0 = r0; r.r1 = r1; r.a0 = a0;
    r.m.color.setHex(color); r.m.opacity = a0;
    r.mesh.position.copy(p).addScaledVector(n, 0.03);
    r.mesh.quaternion.setFromUnitVectors(Z, n);
    r.mesh.scale.setScalar(Math.max(0.001, r0));
    r.mesh.visible = true;
  }

  /** 폭발: 섬광 + 화염 + 연기 + 지면 먼지 + 불씨 + 충격파 링 + 짧은 포인트 라이트 + 흔들림 */
  function explosion(pos, o = {}) {
    if (disposed) return;
    const radius = o.radius ?? 6;
    v3(pos, _a);
    const p = _a;
    const b = bursts.find((x) => !x.active) || bursts.reduce((m, x) => (x.t > m.t ? x : m));
    b.active = true; b.t = 0; b.life = 0.28; b.size = (reduced ? 0.7 : 1) * radius * 1.2; b.a = flashK();
    b.s.position.copy(p).y += 0.4; b.s.scale.setScalar(0.5); b.m.opacity = b.a; b.s.visible = true;
    for (let i = 0, n = cnt(26); i < n; i++) {
      sphereDir(_d).multiplyScalar(rand(3, 9)); _d.y = Math.abs(_d.y) + 1.5;
      ptsAdd.add(p.x, p.y + 0.3, p.z, _d.x, _d.y, _d.z, P.fire);
    }
    for (let i = 0, n = cnt(22); i < n; i++) {
      sphereDir(_d).multiplyScalar(rand(1, 3.5)); _d.y = Math.abs(_d.y) * 0.8 + 0.4;
      ptsAlpha.add(p.x + rand(-0.5, 0.5), p.y + rand(0.2, 1), p.z + rand(-0.5, 0.5), _d.x, _d.y, _d.z, P.smoke);
    }
    for (let i = 0, n = cnt(14); i < n; i++) {
      const ang = (i / n) * Math.PI * 2 + rand(-0.2, 0.2), sp = rand(5, 8);
      ptsAlpha.add(p.x, p.y + 0.2, p.z, Math.cos(ang) * sp, rand(0, 0.4), Math.sin(ang) * sp, P.groundDust);
    }
    for (let i = 0, n = cnt(28); i < n; i++) {
      sphereDir(_d); _d.y = Math.abs(_d.y) * 1.2 + 0.2; _d.normalize().multiplyScalar(rand(8, 18));
      streaks.add(p.x, p.y + 0.3, p.z, _d.x, _d.y, _d.z, rand(0.6, 1.2), EMBER_C, -9.8, 0.6, 0.03);
    }
    for (let i = 0, n = cnt(12); i < n; i++) {
      sphereDir(_d); _d.y = Math.abs(_d.y) + 0.3; _d.multiplyScalar(rand(4, 10));
      ptsAdd.add(p.x, p.y + 0.3, p.z, _d.x, _d.y, _d.z, P.ember);
    }
    ring(p, UP, 0.3, radius * 1.2, 0.38, reduced ? 0.3 : 0.6, 0xfff0d0);
    useLight(_b.copy(p).setY(p.y + 1), 0xffa040, (reduced ? 0.4 : 1) * 80, 22, 0.4, 2);
    const dc = camera.getWorldPosition(_b).distanceTo(p);
    addShake(Math.max(0, 1.1 - dc / (radius * 3)));
  }

  /** 탄피 배출(선택). dir: 사격 방향. o.groundY: 바닥 높이(기본 pos.y-1.45). o.kind: fxKind(크기·튕김이 달라진다, 모르면 소총) */
  function shellEject(pos, dir, o) {
    if (disposed) return;
    const K = SHELL_KIND[kindOf(o?.kind)];
    v3(pos, _a); v3(dir, _d);
    if (_d.lengthSq() < 1e-8) camera.getWorldDirection(_d); else _d.normalize();
    let s = null;
    for (let i = 0; i < Q.shells; i++) if (!shells[i].active) { s = shells[i]; break; }
    if (!s) { s = shells[0]; for (let i = 1; i < Q.shells; i++) if (shells[i].t > s.t) s = shells[i]; }
    _t1.copy(_d).cross(UP);                                 // 오른쪽
    if (_t1.lengthSq() < 1e-6) _t1.set(1, 0, 0); else _t1.normalize();
    s.active = true; s.t = 0; s.life = 1.4; s.bounces = 0; s.scale = K.scale;
    s.ground = o?.groundY ?? _a.y - 1.45;
    s.p.copy(_a).addScaledVector(_t1, 0.06);
    s.v.copy(_t1).multiplyScalar(rand(1.6, 2.6)).addScaledVector(UP, rand(1.6, 2.4)).addScaledVector(_d, rand(-0.6, 0.2)).multiplyScalar(K.speed);
    s.q.setFromAxisAngle(_t1, Math.PI / 2);
    s.axis.set(rand(-1, 1), rand(-1, 1), rand(-1, 1)).normalize();
    s.spin = rand(14, 26);
  }

  function addShake(amount) { trauma = Math.min(1, trauma + Math.max(0, +amount || 0)); }

  /* ── 발판·포털 색: '#35e0ff' | 0x35e0ff | THREE.Color. 입자는 값을 그대로 출력하고 줄기는 선형 공간이라 둘 다 만들어 둔다 ── */
  const tint = { hex: 0, srgb: [0, 0, 0], hot: [0, 0, 0], lin: [0, 0, 0] };
  function setTint(color, fallback) {
    if (typeof color === 'number' && Number.isFinite(color)) _c.setHex(color & 0xffffff);
    else if (typeof color === 'string' && HEX_COLOR.test(color)) _c.setStyle(color);
    else if (color && color.isColor) _c.copy(color);
    else _c.setHex(fallback);
    const h = _c.getHex();
    tint.hex = h;
    tint.lin[0] = _c.r; tint.lin[1] = _c.g; tint.lin[2] = _c.b;
    for (let i = 0; i < 3; i++) {
      const v = ((h >> (16 - i * 8)) & 255) / 255;
      tint.srgb[i] = v;
      tint.hot[i] = v + (1 - v) * 0.6;                     // 입자 머리는 흰빛에 가깝게
    }
  }

  /** 점프 발판 발동. pos: 발 위치(발판 표면), color: 발판 색(기본 시안). 위로 뿜는 불꽃과 퍼지는 링. 라이트 없음 */
  function padBurst(pos, color) {
    if (disposed) return;
    v3(pos, _a);
    setTint(color, 0x35e0ff);
    const p = _a;
    ring(p, UP, 0.12, 1.5, 0.42, 0.8, tint.hex);
    if (Q.extraRing) ring(p, UP, 0.06, 0.9, 0.3, 0.55, tint.hex);
    P.padFlash.c0 = tint.hot; P.padFlash.c1 = tint.srgb; P.padFlash.a = 0.85 * flashK();
    ptsAdd.add(p.x, p.y + 0.12, p.z, 0, 0.8, 0, P.padFlash);
    for (let i = 0, n = cnt(22); i < n; i++) {
      const ang = Math.random() * Math.PI * 2, c = Math.cos(ang), s = Math.sin(ang), r = rand(0.1, 0.75), out = rand(0.2, 1.6);
      streaks.add(p.x + c * r, p.y + 0.05, p.z + s * r, c * out, rand(5, 11), s * out, rand(0.28, 0.55), tint.lin, -9.8, 1, 0.028);
    }
    P.padDot.c0 = tint.hot; P.padDot.c1 = tint.srgb;
    for (let i = 0, n = cnt(12); i < n; i++) {
      const ang = Math.random() * Math.PI * 2, c = Math.cos(ang), s = Math.sin(ang), r = rand(0.1, 0.7), out = rand(0.2, 1.1);
      ptsAdd.add(p.x + c * r, p.y + 0.08, p.z + s * r, c * out, rand(3, 7), s * out, P.padDot);
    }
  }

  /** 포털 통과. pos: 발 위치(출발·도착 양쪽에 한 번씩 불러도 된다), color: 포털 색(기본 보라). 섬광·소용돌이·링. 라이트 없음 */
  function portalFlash(pos, color) {
    if (disposed) return;
    v3(pos, _a);
    setTint(color, 0xb06bff);
    const k = flashK(), x = _a.x, y = _a.y + 1, z = _a.z;
    _b.set(x, y, z);
    camera.getWorldPosition(_d).sub(_b).setY(0);            // 세운 링이 카메라를 보게 한다(바로 옆이면 +Z)
    if (_d.lengthSq() < 1e-4) _n.copy(Z); else _n.copy(_d).normalize();
    ring(_b, _n, 0.25, 1.7, 0.42, 0.75 * k, tint.hex);
    if (Q.extraRing) ring(_a, UP, 0.2, 1.3, 0.5, 0.5 * k, tint.hex);
    P.portalCore.c0 = tint.hot; P.portalCore.c1 = tint.srgb; P.portalCore.a = 0.8 * k;
    ptsAdd.add(x, y, z, 0, 0, 0, P.portalCore);
    P.portalDot.c0 = tint.hot; P.portalDot.c1 = tint.srgb;
    for (let i = 0, n = cnt(28); i < n; i++) {             // 몸 둘레를 도는 소용돌이
      const ang = Math.random() * Math.PI * 2, c = Math.cos(ang), s = Math.sin(ang), r = rand(0.45, 0.95), sp = rand(2, 4.5);
      ptsAdd.add(x + c * r, y + rand(-1, 1), z + s * r, -s * sp - c * 0.8, rand(0.2, 1.4), c * sp - s * 0.8, P.portalDot);
    }
    for (let i = 0, n = cnt(10); i < n; i++) {             // 가운데서 튀어 나가는 줄기
      sphereDir(_d).multiplyScalar(rand(2.5, 6));
      streaks.add(x, y, z, _d.x, _d.y, _d.z, rand(0.18, 0.36), tint.lin, 0, 2.2, 0.03);
    }
  }

  /** 비밀 스팟 발견. pos: 발 위치. 금빛 반짝임이 나선으로 피어오르고 잔불이 천천히 사라진다. 라이트 없음 */
  function secretSparkle(pos) {
    if (disposed) return;
    v3(pos, _a);
    const p = _a;
    ring(p, UP, 0.2, 1.6, 0.7, 0.55, 0xffd768);
    for (let i = 0, n = cnt(34); i < n; i++) {             // 나선
      const u = i / n, ang = u * Math.PI * 6 + rand(-0.3, 0.3), c = Math.cos(ang), s = Math.sin(ang), r = 0.65 - 0.3 * u;
      ptsAdd.add(p.x + c * r, p.y + 0.1 + u * 2, p.z + s * r, c * rand(0.1, 0.5), rand(0.2, 0.9), s * rand(0.1, 0.5), P.secretDot);
    }
    for (let i = 0, n = cnt(10); i < n; i++) {             // 늦게 피는 큰 반짝임
      ptsAdd.add(p.x + rand(-0.8, 0.8), p.y + rand(0.3, 2.2), p.z + rand(-0.8, 0.8), 0, rand(0.1, 0.5), 0, P.secretGlint);
    }
    for (let i = 0, n = cnt(12); i < n; i++) {
      const ang = Math.random() * Math.PI * 2, c = Math.cos(ang), s = Math.sin(ang), out = rand(0.3, 1.2);
      streaks.add(p.x + c * 0.3, p.y + 0.1, p.z + s * 0.3, c * out, rand(3, 6.5), s * out, rand(0.4, 0.8), GOLD_C, -4, 1.2, 0.03);
    }
  }

  /** 칼날이 맞았을 때 강철 불꽃. pos: 맞은 지점, normal: 맞은 면 또는 칼 반대 방향(없으면 위). 탄흔·라이트 없음 */
  function slashSpark(pos, normal) {
    if (disposed) return;
    v3(pos, _a);
    v3(normal || UP, _n);
    if (_n.lengthSq() < 1e-8) _n.copy(UP); else _n.normalize();
    basis(_n);
    P.slashFlash.a = flashK();
    ptsAdd.add(_a.x, _a.y, _a.z, 0, 0, 0, P.slashFlash);
    for (let i = 0, n = cnt(16); i < n; i++) {
      coneDir(_n, 1.35, _d).multiplyScalar(rand(3.5, 10));
      streaks.add(_a.x, _a.y, _a.z, _d.x, _d.y, _d.z, rand(0.1, 0.3), STEEL_C, -9.8, 2.4, 0.02);
    }
    for (let i = 0, n = cnt(5); i < n; i++) {
      coneDir(_n, 1.1, _d).multiplyScalar(rand(1.5, 5));
      ptsAdd.add(_a.x, _a.y, _a.z, _d.x, _d.y, _d.z, P.slashDot);
    }
  }

  /** 속도 줄기 세기 0..1. 매 프레임 불러도 된다. 0이면 그리지 않는다. 동작 줄이기가 켜져 있으면 나오지 않는다 */
  function setSpeedAmount(v) { speedLines.target = Math.min(1, Math.max(0, +v || 0)); }

  /* ───────── 매 프레임 ───────── */

  function refreshShared() {
    let h = 0;
    if (opts.renderer?.getDrawingBufferSize) h = opts.renderer.getDrawingBufferSize(_v2).y;
    else if (typeof window !== 'undefined') h = window.innerHeight * Math.min(2, window.devicePixelRatio || 1);
    const fov = camera.isPerspectiveCamera ? camera.fov : 70;
    shared.uScale.value = (h || 720) / (2 * Math.tan((fov * Math.PI) / 360));
    const fog = scene.fog;
    if (fog?.isFog) { shared.uFogNear.value = fog.near; shared.uFogFar.value = fog.far; shared.uFogColor.value.copy(fog.color); }
    else if (fog?.isFogExp2) { shared.uFogNear.value = 0; shared.uFogFar.value = 2.2 / Math.max(1e-4, fog.density); shared.uFogColor.value.copy(fog.color); }
    else shared.uFogFar.value = 0;
  }

  function updateMeshes(dt) {
    for (const f of flashes) {
      if (!f.active) continue;
      f.t += dt;
      const u = f.t / f.life;
      if (u >= 1) { f.active = false; f.g.visible = false; continue; }
      const k = (1 - u) ** 1.5;
      f.pm.opacity = f.sm.opacity = f.a * k;
      f.core.scale.setScalar(f.K.core * (1 + 0.4 * u));
    }
    for (const tr of tracers) {
      if (!tr.active) continue;
      tr.t += dt;
      if (tr.trail) {
        const u = tr.t / tr.life;
        if (u >= 1) { tr.active = false; tr.mesh.visible = false; continue; }
        tr.m.opacity = 0.3 * (1 - u) ** 2;
        const r = tr.r * (1 + 2.5 * u);
        tr.mesh.scale.x = tr.mesh.scale.y = r;
        continue;
      }
      const run = tr.t * tr.speed;                         // 머리는 목표에서 멈추고 꼬리는 계속 따라가 소멸
      const head = Math.min(tr.dist, run), tail = Math.max(0, run - tr.seg);
      if (tail >= tr.dist - 1e-3) { tr.active = false; tr.mesh.visible = false; continue; }
      tr.mesh.position.copy(tr.from).addScaledVector(tr.dir, tail);
      tr.mesh.scale.z = Math.max(0.01, head - tail);
    }
    for (const r of rings) {
      if (!r.active) continue;
      r.t += dt;
      const u = r.t / r.life;
      if (u >= 1) { r.active = false; r.mesh.visible = false; continue; }
      r.mesh.scale.setScalar(r.r0 + (r.r1 - r.r0) * (1 - (1 - u) ** 3));
      r.m.opacity = r.a0 * (1 - u) ** 1.5;
    }
    for (const b of bursts) {
      if (!b.active) continue;
      b.t += dt;
      const u = b.t / b.life;
      if (u >= 1) { b.active = false; b.s.visible = false; continue; }
      b.s.scale.setScalar(0.5 + b.size * Math.min(1, u * 2.4));
      b.m.opacity = b.a * (1 - u) ** 2;
    }
    for (const s of lights) {
      if (!s.active) continue;
      s.t += dt;
      const u = s.t / s.life;
      if (u >= 1) { s.active = false; s.l.intensity = 0; continue; }
      s.l.intensity = s.i0 * (1 - u) ** 2;
    }
    let shellDirty = false;
    for (let i = 0; i < CAP_SHELL; i++) {
      const s = shells[i];
      if (!s.active) continue;
      s.t += dt; shellDirty = true;
      if (s.t >= s.life || i >= Q.shells) { s.active = false; shellMesh.setMatrixAt(i, ZERO); continue; }
      s.v.y -= 9.8 * dt;
      s.p.addScaledVector(s.v, dt);
      if (s.p.y < s.ground + 0.006) {                      // 바닥에서 한두 번 튕긴다
        s.p.y = s.ground + 0.006;
        if (s.v.y < 0) { s.v.y *= -0.35; s.v.x *= 0.5; s.v.z *= 0.5; s.spin *= 0.4; s.bounces++; }
      }
      s.q.multiply(_q.setFromAxisAngle(s.axis, s.spin * dt));
      const sc = s.scale * (s.t > s.life - 0.25 ? (s.life - s.t) / 0.25 : 1);
      shellMesh.setMatrixAt(i, _m.compose(s.p, s.q, _s.set(sc, sc, sc)));
    }
    if (shellDirty) shellMesh.instanceMatrix.needsUpdate = true;
  }

  function updateShake(dt) {
    const r = camera.rotation;
    if (applied.on) {                                      // 엔진이 덮어쓰지 않은 축만 이전 오프셋을 되돌린다
      if (r.x === applied.rx) r.x -= applied.x;
      if (r.y === applied.ry) r.y -= applied.y;
      if (r.z === applied.rz) r.z -= applied.z;
      applied.on = false;
    }
    trauma = Math.max(0, trauma - dt * 1.4);
    const k = trauma * trauma * (reduced ? 0.2 : 1);
    shake.pitch = 0.03 * k * (Math.sin(time * 37.1) * 0.6 + Math.sin(time * 21.7 + 1.3) * 0.4);
    shake.yaw = 0.022 * k * (Math.sin(time * 31.3 + 0.7) * 0.6 + Math.sin(time * 17.9 + 2.1) * 0.4);
    shake.roll = 0.028 * k * Math.sin(time * 27.7 + 0.4);
    if (applyShake && k > 1e-5) {
      r.x += shake.pitch; r.y += shake.yaw; r.z += shake.roll;
      applied.on = true; applied.x = shake.pitch; applied.y = shake.yaw; applied.z = shake.roll;
      applied.rx = r.x; applied.ry = r.y; applied.rz = r.z;
    }
  }

  function update(dt) {
    if (disposed) return;
    dt = Math.min(0.1, Math.max(0, +dt || 0));
    time += dt;
    refreshShared();
    ptsAlpha.update(dt); ptsAdd.update(dt); streaks.update(dt);
    speedLines.update(dt, Q.speedLines, reduced);
    updateMeshes(dt);
    updateShake(dt);
  }

  /** 진행 중인 이펙트를 즉시 모두 끈다(라운드 리셋). 탄흔은 keepDecals=false면 함께 지운다. */
  function clear(keepDecals = false) {
    ptsAlpha.clear(); ptsAdd.clear(); streaks.clear(); speedLines.clear();
    for (const f of flashes) { f.active = false; f.g.visible = false; }
    for (const t of tracers) { t.active = false; t.mesh.visible = false; }
    for (const r of rings) { r.active = false; r.mesh.visible = false; }
    for (const b of bursts) { b.active = false; b.s.visible = false; }
    for (const s of lights) { s.active = false; s.l.intensity = 0; }
    for (let i = 0; i < CAP_SHELL; i++) { shells[i].active = false; shellMesh.setMatrixAt(i, ZERO); }
    shellMesh.instanceMatrix.needsUpdate = true;
    if (!keepDecals) { decalUsed = 0; decalNext = 0; decals.count = 0; }
    trauma = 0;
  }

  function setQuality(q) {
    quality = q === 'low' ? 'low' : 'high';
    Q = QUALITY[quality];
    ptsAlpha.cap = ptsAdd.cap = Q.pts; streaks.cap = Q.streaks;
    if (decalUsed > Q.decals) { decalUsed = Q.decals; decals.count = decalUsed; }
    decalNext %= Q.decals;
  }

  const live = (arr) => arr.reduce((n, x) => n + (x.active ? 1 : 0), 0);

  return {
    muzzleFlash, tracer, impact, explosion, shellEject, update, clear, setQuality, addShake,
    padBurst, portalFlash, secretSparkle, slashSpark, setSpeedAmount,
    /** null이면 OS 설정(prefers-reduced-motion)을 따른다 */
    setReducedMotion(v) { rmOverride = v === null || v === undefined ? null : !!v; reduced = rmOverride ?? !!mq?.matches; },
    /** applyShake:false 일 때 엔진이 직접 더할 흔들림(라디안) */
    getShake() { return shake; },
    setApplyShake(v) { applyShake = !!v; },
    getStats() {
      return {
        quality, reducedMotion: reduced,
        particles: ptsAlpha.n + ptsAdd.n, particleCap: ptsAlpha.cap + ptsAdd.cap, streaks: streaks.n, streakCap: streaks.cap,
        flashes: live(flashes), tracers: live(tracers), rings: live(rings), bursts: live(bursts),
        lights: live(lights), shells: live(shells), decals: decalUsed,
        speedAmount: speedLines.cur, speedLines: speedLines.n, speedLineCap: Q.speedLines,
        dropped: ptsAlpha.dropped + ptsAdd.dropped + streaks.dropped,
        objects: root.children.length, trauma
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      const r = camera.rotation;
      if (applied.on) {
        if (r.x === applied.rx) r.x -= applied.x;
        if (r.y === applied.ry) r.y -= applied.y;
        if (r.z === applied.rz) r.z -= applied.z;
        applied.on = false;
      }
      mq?.removeEventListener?.('change', onMQ);
      scene.remove(root);
      ptsAlpha.dispose(); ptsAdd.dispose(); streaks.dispose(); speedLines.dispose();
      for (const f of flashes) { f.pm.dispose(); f.sm.dispose(); }
      for (const t of tracers) t.m.dispose();
      for (const x of rings) x.m.dispose();
      for (const b of bursts) b.m.dispose();
      for (const s of lights) s.l.dispose();
      petalGeo.dispose(); tracerGeo.dispose(); ringGeo.dispose();
      decals.dispose(); decalGeo.dispose(); decalMat.dispose();
      shellMesh.dispose(); shellGeo.dispose(); shellMat.dispose();
      tex.flash.dispose(); tex.petal.dispose(); tex.hole.dispose();
      root.clear();
    }
  };
}
