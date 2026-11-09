/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 1인칭 무기 모형(뷰모델). 17종 무기와 수류탄을 도형·캔버스 텍스처로 만들고 사격·재장전·베기·점검 동작을 재생한다.
 */

/*
 * 사용법
 *   const vm = createViewmodel(R.viewCamera, { lookCamera: R.camera });   // core 렌더러의 뷰모델 씬
 *   vm.preload();                      // 모형을 미리 만든다(첫 교체 때 끊김 방지)
 *   vm.prewarm(R.three);               // 선택: 셰이더·텍스처·환경맵까지 미리 준비(로딩 화면에서 한 번)
 *   vm.play(ev)                        // arsenal.update()가 돌려준 이벤트를 그대로
 *   vm.play({ type: 'inspect' })       // 점검 동작(F). 발사·재장전·교체·줌으로 취소된다
 *   vm.update(dt, arsenal.getViewState())
 *   vm.dispose()
 *
 * 모형은 전부 오리지널 설계다. 외부 파일 없이 도형(Box·Cylinder·Extrude·직접 만든 로프트)과 캔버스 텍스처만 쓴다.
 *
 * 붙이는 위치
 *  - camera.parent가 Scene이면(core의 viewScene·viewCamera 포함) 그 씬에 넣고 매 프레임 카메라를 따라간다.
 *  - 아니면 camera의 자식으로 붙인다.
 *  - 메시는 전용 레이어(VIEWMODEL_LAYER)에만 두고 그 카메라에서만 켠다 → 월드 레이캐스트·다른 카메라에 안 걸린다.
 *  - 월드와 같은 패스에서 그려져도 벽에 파묻히지 않게, 그리기 직전에 깊이를 한 번 지운다(clearDepth 옵션).
 * 저격 스코프: 줌 진행도 > 0.9면 모형을 숨긴다(오버레이는 UI 담당).
 *
 * 좌표(모형 로컬): 원점 = 손잡이 근처, -z = 총구·칼끝, +y = 위(칼은 등 쪽), +x = 오른쪽.
 * 칼 동작은 카메라 좌표의 키프레임이다. K(손 위치, 칼끝 방향 D, 날 방향 E)로 적으면 회전을 계산해 준다.
 */
import * as THREE from 'three';
import { getDef } from './defs.js';

export const VIEWMODEL_LAYER = 30;
/** 모형을 가진 무기 id(DESIGN 3.2 표 순서) */
export const VIEWMODEL_IDS = Object.freeze([
  'ar_std', 'ar_rapid', 'ar_line', 'ar_burst', 'dm_mark', 'sm_vx3', 'sg_bx12',
  'sr_bolt', 'sr_twin', 'sr_swift', 'sr_heavy', 'pt_std', 'pt_magnum', 'ml_knife', 'ml_tanto', 'ml_gurkha', 'ml_katana', 'gr_frag',
]);

const RO = 10000;                 // renderOrder 기준(월드의 투명 물체보다 뒤에 그려지도록 크게)
const DEG = Math.PI / 180;

const COLOR = {
  gunmetal: 0x2c3138, black: 0x16181c, gray: 0x59606a, steel: 0xc3cad3, hazard: 0xf2c230,
  drum: 0xe2b52a, drumDark: 0x9a7612, glove: 0x565a60, cuff: 0x24262a, sleeve: 0x3a4a5c,
  lens: 0x3d8fe0, lensDark: 0x0d1a2a, dot: 0xff3a30, tritium: 0x9dff6a, brass: 0x8f7038, iron: 0x24272c, lacquer: 0x0c0d10,
};
/** 팀별 소매 색(core TEAMS 색과 맞춤) */
const TEAM_SLEEVE = { owner: 0x22407a, charterer: 0xb8323b };
/** 표에 있지만 빌더가 없는 무기는 kind로 닮은 모형을 쓴다 */
const KIND_FALLBACK = { rifle: 'ar_std', dmr: 'dm_mark', smg: 'sm_vx3', shotgun: 'sg_bx12', sniper: 'sr_bolt', pistol: 'pt_std', melee: 'ml_knife', grenade: 'gr_frag' };

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const num = (v, d = 0) => (Number.isFinite(v) ? v : d);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const easeOutCubic = (t) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);
const approach = (cur, target, rate, dt) => target + (cur - target) * Math.exp(-rate * dt);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const EASE = {
  lin: (u) => u,
  in: (u) => u * u,
  out: (u) => 1 - (1 - u) * (1 - u),
  io: (u) => u * u * (3 - 2 * u),
  out3: (u) => 1 - Math.pow(1 - u, 3),
};

function spring(k = 260, damp = 0.85) { return { x: 0, v: 0, k, c: 2 * Math.sqrt(k) * damp }; }
function stepSpring(s, dt, target = 0) {
  const n = Math.max(1, Math.ceil(dt / 0.008));
  const h = dt / n;
  for (let i = 0; i < n; i++) { s.v += (-s.k * (s.x - target) - s.c * s.v) * h; s.x += s.v * h; }
}

/* 캔버스 무늬용 결정적 잡음(매번 같은 모양) */
function hash2(x, y) { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); }
function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/**
 * 여러 지오메트리를 비색인 하나로 합친다(위치·법선·uv).
 * @param {{geo:THREE.BufferGeometry, matrix?:THREE.Matrix4}[]} list
 */
function mergeGeos(list) {
  const flat = list.map(({ geo, matrix }) => ({ g: geo.index ? geo.toNonIndexed() : geo, src: geo, matrix }));
  let total = 0;
  for (const f of flat) total += f.g.attributes.position.count;
  const pos = new Float32Array(total * 3), nor = new Float32Array(total * 3), uv = new Float32Array(total * 2);
  const v = new THREE.Vector3(), nm = new THREE.Matrix3();
  let o = 0;
  for (const f of flat) {
    const P = f.g.attributes.position, N = f.g.attributes.normal, T = f.g.attributes.uv;
    if (f.matrix) nm.getNormalMatrix(f.matrix);
    for (let i = 0; i < P.count; i++, o++) {
      v.fromBufferAttribute(P, i);
      if (f.matrix) v.applyMatrix4(f.matrix);
      pos[o * 3] = v.x; pos[o * 3 + 1] = v.y; pos[o * 3 + 2] = v.z;
      v.fromBufferAttribute(N, i);
      if (f.matrix) v.applyMatrix3(nm).normalize();
      nor[o * 3] = v.x; nor[o * 3 + 1] = v.y; nor[o * 3 + 2] = v.z;
      if (T) { uv[o * 2] = T.getX(i); uv[o * 2 + 1] = T.getY(i); }
    }
    if (f.g !== f.src) f.g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return out;
}

/** 비색인 지오메트리를 x축으로 뒤집는다(왼손 만들기). 삼각형 감김도 되돌린다 */
function mirrorGeoX(geo) {
  const P = geo.attributes.position, N = geo.attributes.normal, T = geo.attributes.uv;
  for (let i = 0; i < P.count; i++) { P.setX(i, -P.getX(i)); N.setX(i, -N.getX(i)); }
  for (let t = 0; t + 2 < P.count; t += 3) {
    for (const A of [P, N]) {
      const x = A.getX(t + 1), y = A.getY(t + 1), z = A.getZ(t + 1);
      A.setXYZ(t + 1, A.getX(t + 2), A.getY(t + 2), A.getZ(t + 2));
      A.setXYZ(t + 2, x, y, z);
    }
    const u = T.getX(t + 1), w = T.getY(t + 1);
    T.setXY(t + 1, T.getX(t + 2), T.getY(t + 2));
    T.setXY(t + 2, u, w);
  }
  return geo;
}

/** 모형 -z를 D로, 모형 -y(칼날 쪽)를 E로 돌리는 회전 */
function quatFrom(D, E) {
  const d = new THREE.Vector3(D[0], D[1], D[2]).normalize();
  const e = new THREE.Vector3(E[0], E[1], E[2]);
  e.addScaledVector(d, -e.dot(d)).normalize();
  const z = d.clone().negate(), y = e.clone().negate();
  const x = new THREE.Vector3().crossVectors(y, z);
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}
/** 칼 키프레임: 손 위치 p, 칼끝 방향 d, 날 방향 e (카메라 좌표) */
const K = (p, d, e) => ({ p: new THREE.Vector3(p[0], p[1], p[2]), q: quatFrom(d, e) });
/** a→b 회전의 비율 w 지점 + 손 위치 p */
const between = (a, b, w, p) => ({ p: new THREE.Vector3(p[0], p[1], p[2]), q: a.q.clone().slerp(b.q, w) });

/**
 * 짧은 칼(호크빌·탄토·구르카)의 동작. 카타나처럼 카메라 좌표 키프레임으로 적는다.
 * 지킬 것: 손은 화면 오른쪽 아래에 머물러 소매가 화면을 가로막지 않는다. 뒤로 빼는 동작은 작게 해서 칼이 화면 밖으로 나가지 않는다.
 * 맞는 순간(windup)에 칼끝이 조준점 가까이를 지나간다. 베는 동안 날(e)은 움직이는 쪽을 향한다.
 * @param {{ heavy?: 'stab'|'chop', push?: number }} [o] heavy = 우클릭 동작(찌르기·내려찍기), push = 칼이 길어 앞으로 더 내미는 거리
 */
function shortBladeClips({ heavy = 'stab', push = 0 } = {}) {
  const at = (x, y, z) => [x, y, z - push];
  const idle = K(at(0.13, -0.128, -0.29), [-0.435, 0.223, -0.872], [-0.781, -0.575, 0.243]);
  // 베기 A: 오른쪽 위 → 조준점 → 왼쪽 아래
  const aW = K(at(0.178, -0.096, -0.285), [-0.08, 0.5, -0.86], [-0.95, -0.2, 0.2]);
  const aM = K(at(0.075, -0.098, -0.36), [-0.56, 0.3, -0.77], [-0.68, -0.62, 0.38]);
  const aE = K(at(-0.05, -0.155, -0.35), [-0.9, -0.2, -0.39], [-0.2, -0.92, 0.34]);
  const aA = K(at(-0.07, -0.168, -0.34), [-0.92, -0.3, -0.25], [-0.26, -0.9, 0.34]);
  // 베기 B: 왼쪽 아래 → 조준점 → 오른쪽 위(되돌아 벤다)
  const bW = K(at(0.05, -0.15, -0.3), [-0.74, -0.06, -0.67], [0.42, 0.72, -0.55]);
  const bM = K(at(0.085, -0.09, -0.37), [-0.35, 0.55, -0.76], [0.85, 0.35, -0.15]);
  const bE = K(at(0.215, -0.06, -0.33), [0.2, 0.82, -0.53], [0.72, -0.3, 0.62]);
  const bA = K(at(0.232, -0.068, -0.325), [0.3, 0.8, -0.52], [0.68, -0.42, 0.6]);
  let hv;
  if (heavy === 'chop') {
    // 내려찍기: 칼을 들어 올렸다가 조준점을 지나 아래로
    const W = K(at(0.17, -0.055, -0.3), [-0.1, 0.9, -0.42], [0.02, 0.42, -0.9]);
    const M = K(at(0.095, -0.1, -0.38), [-0.16, 0.42, -0.89], [-0.05, -0.89, -0.42]);
    const E = K(at(0.09, -0.165, -0.37), [-0.2, -0.08, -0.975], [-0.1, -0.98, 0.12]);
    hv = { wind: W, hold: between(W, W, 0, at(0.172, -0.045, -0.292)), mid: M, end: E, after: between(M, E, 1.08, at(0.09, -0.175, -0.365)) };
  } else {
    // 찌르기: 뒤로 당겼다가 조준점으로 곧게. 날의 넓은 면이 계속 보이게 돌리지 않는다
    const W = K(at(0.165, -0.142, -0.225), [-0.3, 0.2, -0.93], [-0.72, -0.68, 0.09]);
    const M = K(at(0.115, -0.112, -0.38), [-0.33, 0.22, -0.92], [-0.72, -0.68, 0.1]);
    const E = K(at(0.095, -0.095, -0.47), [-0.3, 0.2, -0.93], [-0.72, -0.68, 0.08]);
    hv = { wind: W, hold: between(W, W, 0, at(0.17, -0.146, -0.215)), mid: M, end: E, after: between(M, E, 1, at(0.097, -0.097, -0.46)) };
  }
  return {
    idle,
    span: 0.075, heavySpan: 0.075, heavyAfter: 0.09,
    slashA: { wind: aW, mid: aM, end: aE, after: aA },
    slashB: { wind: bW, mid: bM, end: bE, after: bA },
    heavy: hv,
    // 점검: 칼을 눈앞에 가로로 들어 한쪽 면을 보고, 손목을 뒤집어 반대쪽 면을 본다
    inspect: [
      { t: 0, ...idle },
      { t: 0.42, ...K(at(0.12, -0.115, -0.27), [-0.9, 0.2, -0.39], [-0.1, -0.92, -0.34]), e: 'io' },
      { t: 1.05, ...K(at(0.125, -0.105, -0.275), [-0.88, 0.26, -0.4], [-0.14, -0.9, -0.38]), e: 'io' },
      { t: 1.32, ...K(at(0.12, -0.105, -0.27), [-0.88, 0.26, -0.4], [-0.3, 0.1, 0.94]), e: 'io' },
      { t: 1.55, ...K(at(0.115, -0.105, -0.27), [-0.88, 0.28, -0.38], [0.14, 0.9, 0.42]), e: 'io' },
      { t: 2.15, ...K(at(0.125, -0.095, -0.28), [-0.84, 0.36, -0.4], [0.22, 0.86, 0.46]), e: 'io' },
      { t: 2.6, ...idle, e: 'io' },
    ],
    inspectDur: 2.6,
    // 꺼내기(진행도 u 0..1): 화면 아래에서 칼끝을 앞세워 올라와 살짝 넘겼다가 자세를 잡는다
    draw: [
      { t: 0, ...K(at(0.2, -0.42, -0.24), [-0.3, -0.25, -0.92], [-0.85, 0.3, 0.2]) },
      { t: 0.6, ...K(at(0.14, -0.11, -0.28), [-0.3, 0.42, -0.86], [-0.85, -0.42, 0.1]), e: 'out' },
      { t: 1, ...idle, e: 'io' },
    ],
  };
}

/**
 * @param {THREE.Camera} camera  모형을 그리는 카메라(core: R.viewCamera, 또는 월드 카메라)
 * @param {object} [opts]
 * @param {THREE.Object3D} [opts.lookCamera]  시점 흔들림(sway)·총구 월드 좌표 계산에 쓸 월드 카메라(기본 camera)
 * @param {THREE.Scene} [opts.scene]          강제로 이 씬에 붙인다
 * @param {boolean} [opts.clearDepth=true]    그리기 직전 깊이 지우기(월드와 같은 패스일 때 필요)
 * @param {boolean} [opts.muzzleFlash=true]   내장 총구 섬광(FX 쪽에서 1인칭 섬광을 그리면 false)
 * @param {number}  [opts.scale=1]            전체 크기 배율
 * @param {'owner'|'charterer'|null} [opts.team]
 */
export function createViewmodel(camera, opts = {}) {
  if (!camera || !camera.isCamera) throw new Error('createViewmodel(camera): three.js 카메라가 필요합니다');
  const hasDOM = typeof document !== 'undefined' && typeof document.createElement === 'function';
  const lookCam = opts.lookCamera && opts.lookCamera.isObject3D ? opts.lookCamera : camera;
  const S = num(opts.scale, 1) > 0 ? num(opts.scale, 1) : 1;
  const useFlash = opts.muzzleFlash !== false;
  const owned = { geos: new Set(), mats: new Set(), texs: new Set() };

  // ── 붙이기 ──────────────────────────────────────────────────
  const root = new THREE.Group();
  root.name = 'weapons-viewmodel';
  const pose = new THREE.Group();
  root.add(pose);
  let mountScene = null;
  if (opts.scene && opts.scene.isScene) mountScene = opts.scene;
  else if (camera.parent && camera.parent.isScene) mountScene = camera.parent;
  let followCamera = false;
  if (mountScene) {
    mountScene.add(root);
    let p = camera.parent;
    while (p) { if (p === mountScene) { followCamera = true; break; } p = p.parent; }
  } else {
    camera.add(root);
  }
  camera.layers.enable(VIEWMODEL_LAYER);

  // ── 캔버스 텍스처 ───────────────────────────────────────────
  function canvasTexture(w, h, draw, srgb = true) {
    if (!hasDOM) return null;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    if (!g) return null;
    draw(g, w, h);
    const t = new THREE.CanvasTexture(c);
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    owned.texs.add(t);
    return t;
  }

  /** 금속이 비출 스튜디오 조명 그림(모형 전용 환경맵). viewScene은 카메라와 함께 고정이라 칼이 움직일 때만 빛이 미끄러진다 */
  function makeEnv() {
    const t = canvasTexture(512, 256, (c, w, h) => {
      const sky = c.createLinearGradient(0, 0, 0, h);
      sky.addColorStop(0, '#9fb7d2');
      sky.addColorStop(0.42, '#dbe6f2');
      sky.addColorStop(0.52, '#59626e');
      sky.addColorStop(1, '#14171c');
      c.fillStyle = sky;
      c.fillRect(0, 0, w, h);
      // 카메라 뒤쪽(u≈0.75)의 어두운 벽: 평평한 도신이 비추는 곳이라 대비를 만든다
      const back = c.createLinearGradient(w * 0.55, 0, w * 0.95, 0);
      back.addColorStop(0, 'rgba(18,22,30,0)');
      back.addColorStop(0.5, 'rgba(18,22,30,0.72)');
      back.addColorStop(1, 'rgba(18,22,30,0)');
      c.fillStyle = back;
      c.fillRect(0, 0, w, h);
      // 소프트박스 띠
      c.filter = 'blur(3px)';
      c.fillStyle = '#ffffff';
      c.fillRect(w * 0.70, h * 0.10, w * 0.022, h * 0.66);
      c.fillRect(w * 0.80, h * 0.18, w * 0.05, h * 0.40);
      c.fillRect(w * 0.60, h * 0.28, w * 0.012, h * 0.38);
      c.fillRect(w * 0.18, h * 0.08, w * 0.09, h * 0.22);
      c.fillStyle = '#bfe4ff';
      c.fillRect(w * 0.90, h * 0.30, w * 0.02, h * 0.5);
      c.filter = 'none';
    });
    if (t) t.mapping = THREE.EquirectangularReflectionMapping;
    return t;
  }
  const envTex = makeEnv();

  // ── 재질 ────────────────────────────────────────────────────
  // 모두 transparent(불투명도 1): 월드 패스에서도 투명 물체 뒤에 그려지고, 깊이 지우기 뒤에 순서대로 그려진다.
  function std(color, { rough = 0.62, metal = 0.25, glow = 0.1, env = metal >= 0.3, envI = 1 } = {}) {
    const m = new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, transparent: true, depthWrite: true, fog: false });
    m.emissive = new THREE.Color(color).multiplyScalar(glow);
    if (env && envTex) { m.envMap = envTex; m.envMapIntensity = envI; }
    owned.mats.add(m);
    return m;
  }
  const paintCache = new Map();
  /** 같은 색·질감이면 재질을 나눠 쓴다(무기별 색 파라미터용) */
  function paint(color, o = {}) {
    const key = `${color}|${o.rough ?? ''}|${o.metal ?? ''}|${o.glow ?? ''}`;
    let m = paintCache.get(key);
    if (!m) { m = std(color, o); paintCache.set(key, m); }
    return m;
  }
  const M = {
    gunmetal: std(COLOR.gunmetal, { rough: 0.42, metal: 0.6 }),
    black: std(COLOR.black, { rough: 0.62, metal: 0.3, glow: 0.12 }),
    gray: std(COLOR.gray, { rough: 0.38, metal: 0.62 }),
    steel: std(COLOR.steel, { rough: 0.26, metal: 0.85, glow: 0.04 }),
    hazard: std(COLOR.hazard, { rough: 0.5, metal: 0.05, glow: 0.12 }),
    drum: std(COLOR.drum, { rough: 0.5, metal: 0.2, glow: 0.1 }),
    drumDark: std(COLOR.drumDark, { rough: 0.6, metal: 0.3 }),
    glove: std(COLOR.glove, { rough: 0.85, metal: 0, glow: 0.14 }),
    cuff: std(COLOR.cuff, { rough: 0.8, metal: 0, glow: 0.12 }),
    sleeve: std(COLOR.sleeve, { rough: 0.95, metal: 0, glow: 0.12 }),
    lens: std(COLOR.lens, { rough: 0.1, metal: 0.6, glow: 0.45 }),
    lensDark: std(COLOR.lensDark, { rough: 0.1, metal: 0.4, glow: 0.05 }),
    brass: std(COLOR.brass, { rough: 0.32, metal: 0.95, glow: 0.04 }),
    iron: std(COLOR.iron, { rough: 0.44, metal: 0.9, glow: 0.06 }),
    lacquer: std(COLOR.lacquer, { rough: 0.2, metal: 0.4, glow: 0.04 }),
  };
  M.dot = new THREE.MeshBasicMaterial({ color: COLOR.dot, transparent: true, depthWrite: false, fog: false, toneMapped: false });
  M.tritium = new THREE.MeshBasicMaterial({ color: COLOR.tritium, transparent: true, fog: false, toneMapped: false });
  M.glass = new THREE.MeshStandardMaterial({ color: 0x88c4ff, roughness: 0.05, metalness: 0.3, transparent: true, opacity: 0.16, depthWrite: false, fog: false, side: THREE.DoubleSide });
  owned.mats.add(M.dot); owned.mats.add(M.tritium); owned.mats.add(M.glass);

  // ── 도형 도우미 ─────────────────────────────────────────────
  function add(geo, mat, parent, x = 0, y = 0, z = 0, order = 0) {
    owned.geos.add(geo);
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.userData.vmOrder = order;
    parent.add(m);
    return m;
  }
  const box = (w, h, d, mat, parent, x, y, z) => add(new THREE.BoxGeometry(w, h, d), mat, parent, x, y, z);
  function cyl(rTop, rBot, l, mat, parent, axis, x, y, z, seg = 14) {
    const g = new THREE.CylinderGeometry(rTop, rBot, l, seg);
    if (axis === 'z') g.rotateX(Math.PI / 2);      // 위(rTop) → +z(뒤쪽)
    else if (axis === 'x') g.rotateZ(-Math.PI / 2); // 위(rTop) → +x(오른쪽)
    return add(g, mat, parent, x, y, z);
  }
  const sphere = (r, mat, parent, x, y, z) => add(new THREE.SphereGeometry(r, 12, 8), mat, parent, x, y, z);
  const torus = (r, tube, mat, parent, x, y, z) => add(new THREE.TorusGeometry(r, tube, 6, 18), mat, parent, x, y, z);

  /**
   * 옆모습 다각형을 좌우로 밀어낸 판. 총의 윤곽 대부분을 이것으로 만든다.
   * @param {number[][]} points [[z, y], ...]  옆에서 본 윤곽(앞 = -z)
   * @param {number} w 두께(x)
   * @param {number[][][]} [holes] 구멍 윤곽들
   */
  function prof(points, w, mat, parent, x = 0, y = 0, z = 0, bevel = 0.0012, holes = null) {
    const s = new THREE.Shape();
    points.forEach((p, i) => (i ? s.lineTo(-p[0], p[1]) : s.moveTo(-p[0], p[1])));
    s.closePath();
    if (holes) {
      for (const h of holes) {
        const path = new THREE.Path();
        h.forEach((p, i) => (i ? path.lineTo(-p[0], p[1]) : path.moveTo(-p[0], p[1])));
        path.closePath();
        s.holes.push(path);
      }
    }
    const inner = Math.max(0.0005, w - bevel * 2);
    const g = new THREE.ExtrudeGeometry(s, { depth: inner, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelOffset: -bevel, bevelSegments: 1, curveSegments: 6 });
    g.translate(0, 0, -inner / 2);
    g.rotateY(Math.PI / 2);        // 다각형 x(= -z) → z, 두께 → x
    return add(g, mat, parent, x, y, z);
  }

  /** 돌림 단면(r, z) 경통. 바깥을 앞→뒤, 안쪽을 뒤→앞으로 적으면 속이 뚫린 통이 된다 */
  function lathe(points, mat, parent, x = 0, y = 0, z = 0, seg = 18) {
    const g = new THREE.LatheGeometry(points.map(([r, zz]) => new THREE.Vector2(r, zz)), seg);
    g.rotateX(Math.PI / 2);
    return add(g, mat, parent, x, y, z);
  }

  function textDraw(lines) {
    return (g, w, h) => {
      g.clearRect(0, 0, w, h);
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      for (const L of lines) {
        g.font = `${L.weight || 900} ${Math.round(L.size * h)}px "Arial Black", "Segoe UI", Arial, sans-serif`;
        if (L.stroke) { g.lineWidth = Math.max(2, h * 0.05); g.strokeStyle = L.stroke; g.strokeText(L.text, w / 2, L.y * h); }
        g.fillStyle = L.color;
        g.fillText(L.text, w / 2, L.y * h, w * 0.96);
      }
    };
  }
  /** 평면 데칼(글자·표식). rotY=-π/2면 왼쪽 면(-x)에 붙는다. */
  function decal(parent, w, h, x, y, z, rotY, draw, px = 512) {
    const tex = canvasTexture(px, Math.max(16, Math.round((px * h) / w)), draw);
    if (!tex) return null;
    const mat = new THREE.MeshLambertMaterial({ map: tex, transparent: true, depthWrite: false, fog: false, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.18 });
    owned.mats.add(mat);
    const m = add(new THREE.PlaneGeometry(w, h), mat, parent, x, y, z, 1);
    m.rotation.y = rotY;
    return m;
  }
  const label = (parent, text, w, h, x, y, z, color, stroke = 'rgba(0,0,0,0.55)') =>
    decal(parent, w, h, x, y, z, -Math.PI / 2, textDraw([{ text, size: 0.78, y: 0.54, color, stroke }]));
  const shortOf = (id) => { const d = getDef(id); return (d && d.short) || id; };
  const accentOf = (id, fallback) => { const d = getDef(id); return d && d.color ? new THREE.Color(d.color).getHex() : fallback; };

  // ── 손·장갑·소매 ────────────────────────────────────────────
  const AXIS_Z = new THREE.Vector3(0, 0, 1);
  const handCache = new Map();
  /** 손가락이 손잡이를 감싼 장갑 지오메트리. 감싸는 축 = 로컬 z(검지 쪽 -z), 손등 = +x(오른손 기준) */
  function handGeos(side, r) {
    const key = side + r.toFixed(4);
    let h = handCache.get(key);
    if (h) return h;
    const glove = [];
    const f = 0.0086;
    for (const [z, k] of [[-0.0285, 1], [-0.0095, 1.04], [0.0095, 0.98], [0.0275, 0.86]]) {
      const t = f * k;
      const g = new THREE.TorusGeometry(r + t * 0.85, t, 6, 9, 3.85);
      g.rotateZ(2.55);             // 손가락 끝(왼쪽 위) → 아래 → 손등 쪽
      g.translate(0, 0, z);
      glove.push({ geo: g });
    }
    const back = new THREE.SphereGeometry(1, 9, 7);
    back.scale(0.0175, 0.034, 0.047);
    back.translate(r + 0.0145, 0.004, 0);
    glove.push({ geo: back });
    const seg = (a, b, rad) => {
      const A = new THREE.Vector3(a[0], a[1], a[2]), B = new THREE.Vector3(b[0], b[1], b[2]);
      const d = new THREE.Vector3().subVectors(B, A);
      const g = new THREE.CapsuleGeometry(rad, d.length(), 3, 7);
      g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()));
      g.translate((A.x + B.x) / 2, (A.y + B.y) / 2, (A.z + B.z) / 2);
      return { geo: g };
    };
    const t0 = [r * 0.62 + 0.012, r * 0.92 + 0.012, 0.02], t1 = [-r * 0.1, r + 0.012, -0.01], t2 = [-r * 0.72, r * 0.62 + 0.006, -0.034];
    glove.push(seg(t0, t1, 0.0098), seg(t1, t2, 0.0088));
    const plate = [];
    const p0 = new THREE.BoxGeometry(0.004, 0.026, 0.05); p0.translate(r + 0.0312, 0.006, 0);   // 손등 보호판
    const p1 = new THREE.BoxGeometry(0.006, 0.008, 0.066); p1.translate(r + 0.0245, -0.022, 0);  // 너클 줄
    plate.push({ geo: p0 }, { geo: p1 });
    const gg = mergeGeos(glove), pg = mergeGeos(plate);
    for (const it of glove) it.geo.dispose();
    for (const it of plate) it.geo.dispose();
    if (side === 'L') { mirrorGeoX(gg); mirrorGeoX(pg); }
    h = { glove: gg, plate: pg };
    handCache.set(key, h);
    return h;
  }

  /**
   * 손 + 소매. 팔꿈치 쪽은 매 프레임 aimArms가 카메라 아래를 향하게 돌린다(칼을 크게 휘둘러도 팔이 어깨 쪽으로 이어져 보인다).
   * @param {'R'|'L'} side
   * @param {number[]} pos 감싸는 원의 중심(모형 로컬)
   * @param {number[]} axis 손가락이 감싸는 축(검지 → 새끼손가락 방향)
   * @param {number[]} back 손등이 향하는 방향
   * @param {number} r 잡는 부분 반지름
   */
  function makeArm(side, pos, axis, back, r = 0.0165) {
    const g = new THREE.Group();
    g.position.set(pos[0], pos[1], pos[2]);
    const s = side === 'R' ? 1 : -1;
    const Z = new THREE.Vector3(axis[0], axis[1], axis[2]).normalize();
    const X = new THREE.Vector3(back[0], back[1], back[2]).multiplyScalar(s);
    X.addScaledVector(Z, -X.dot(Z)).normalize();
    const Y = new THREE.Vector3().crossVectors(Z, X);
    const hand = new THREE.Group();
    hand.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(X, Y, Z));
    g.add(hand);
    const G = handGeos(side, r);
    add(G.glove, M.glove, hand);
    add(G.plate, M.black, hand);
    const fore = new THREE.Group();
    fore.position.set(s * (r + 0.014), -0.002, 0.016).applyQuaternion(hand.quaternion);
    g.add(fore);
    cyl(0.0285, 0.0305, 0.05, M.cuff, fore, 'z', 0, 0, 0.022);
    cyl(0.037, 0.0295, 0.66, M.sleeve, fore, 'z', 0, 0, 0.375);
    g.userData.base = g.position.clone();
    g.userData.fore = fore;
    g.userData.side = side;
    return g;
  }

  // ── 칼날 로프트 ─────────────────────────────────────────────
  /**
   * 등·능선·날이 있는 곡선 칼날. 원점 = 칼날 밑동, -z = 칼끝, +y = 등, -y = 날, x = 두께.
   * 칼끝(kissaki)은 따로 만들어 경계선이 각지게 보인다. uv: u = 길이(0 밑동..1 끝), v = 폭(0 날..1 등).
   */
  function bladeLoft({ L, W0, W1, T0, T1, sag = 0, tipLen, ridge = 0.72, tipPow = 2.3, rings = 30, tipRings = 9, sub = 4, niku = 0.14 }) {
    const Rc = sag > 1e-5 ? (L * L) / (8 * sag) + sag / 2 : Infinity;
    const frame = (s) => {
      if (Rc === Infinity) return { y: 0, z: -s, ny: 1, nz: 0 };
      const th = s / Rc, c = Math.cos(th), sn = Math.sin(th);
      return { y: Rc * (1 - c), z: -Rc * sn, ny: c, nz: sn };
    };
    const sk = L - tipLen;
    const secAt = (s) => {
      const u = clamp(s / sk, 0, 1);
      const W = lerp(W0, W1, u), T = lerp(T0, T1, u);
      const a = 0.38 * W, e = -0.62 * W, r = e + ridge * W, m = 0.33 * W;
      if (s <= sk) return { t: T, a, m, r, e };
      const q = (s - sk) / tipLen;
      return { t: T * (1 - Math.pow(q, 1.7)), a, m: lerp(m, a, q), r: lerp(r, a, Math.pow(q, 1.15)), e: lerp(e, a, Math.pow(q, tipPow)) };
    };
    const pos = [], nor = [], uv = [], idx = [];
    const n3 = new THREE.Vector3(), pi = new THREE.Vector3(), pj = new THREE.Vector3();
    function strip(S, side, build) {
      const grid = S.map((s) => {
        const f = frame(s), sec = secAt(s);
        return build(sec, side).map(([x, n]) => [x, f.y + n * f.ny, f.z + n * f.nz, s / L, clamp((n - sec.e) / Math.max(1e-6, sec.a - sec.e), 0, 1)]);
      });
      const base = pos.length / 3, ni = grid.length, nj = grid[0].length;
      const normals = [];
      for (let i = 0; i < ni; i++) {
        for (let j = 0; j < nj; j++) {
          const A = grid[Math.min(i + 1, ni - 1)][j], B = grid[Math.max(i - 1, 0)][j];
          const C = grid[i][Math.min(j + 1, nj - 1)], D = grid[i][Math.max(j - 1, 0)];
          pi.set(A[0] - B[0], A[1] - B[1], A[2] - B[2]);
          pj.set(C[0] - D[0], C[1] - D[1], C[2] - D[2]);
          if (side > 0) n3.crossVectors(pj, pi); else n3.crossVectors(pi, pj);
          if (n3.lengthSq() < 1e-16) {
            const prev = normals[(i - 1) * nj + j] || [side, 0, 0];
            n3.set(prev[0], prev[1], prev[2]);
          } else n3.normalize();
          normals[i * nj + j] = [n3.x, n3.y, n3.z];
          const P = grid[i][j];
          pos.push(P[0], P[1], P[2]);
          nor.push(n3.x, n3.y, n3.z);
          uv.push(P[3], P[4]);
        }
      }
      for (let i = 0; i + 1 < ni; i++) {
        for (let j = 0; j + 1 < nj; j++) {
          const a = base + i * nj + j, b = a + nj, c = a + 1, d = b + 1;
          if (side > 0) idx.push(a, c, b, b, c, d); else idx.push(a, b, c, b, d, c);
        }
      }
    }
    const muneA = (sec, s) => [[0, sec.a], [s * 0.3 * sec.t, sec.m]];                    // 등마루 경사
    const muneB = (sec, s) => [[s * 0.3 * sec.t, sec.m], [s * 0.5 * sec.t, sec.r]];      // 능선 위쪽 면
    const flat = (sec, s) => {                                                            // 능선 → 날(살짝 볼록)
      const out = [];
      for (let k = 0; k <= sub; k++) {
        const v = k / sub;
        out.push([s * 0.5 * sec.t * ((1 - v) + niku * Math.sin(Math.PI * v)), lerp(sec.r, sec.e, v)]);
      }
      return out;
    };
    const main = [], tip = [];
    for (let i = 0; i <= rings; i++) main.push((i / rings) * sk);
    for (let i = 0; i <= tipRings; i++) tip.push(sk + (i / tipRings) * tipLen);
    for (const S of [main, tip]) for (const side of [1, -1]) for (const b of [muneA, muneB, flat]) strip(S, side, b);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    return { geo, frame, secAt, Rc, L, tipLen };
  }

  /** 날 끝을 따라 바깥으로 번지는 얇은 빛 띠(가산 혼합). RGBA 정점색으로 바깥쪽이 사라진다 */
  function edgeSheet(B, width) {
    const n = 44, pos = [], col = [], idx = [];
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const s = lerp(0.012 * B.L, B.L, i / n), f = B.frame(s), sec = B.secAt(s);
      pts.push([f.y + sec.e * f.ny, f.z + sec.e * f.nz, f.ny, f.nz, s]);
    }
    for (let i = 0; i <= n; i++) {
      const a = pts[Math.max(i - 1, 0)], b = pts[Math.min(i + 1, n)], P = pts[i];
      let ox = b[1] - a[1], oy = -(b[0] - a[0]);       // 접선에 수직((y,z) 평면)
      if (ox * P[2] + oy * P[3] > 0) { ox = -ox; oy = -oy; }
      const l = Math.hypot(ox, oy) || 1;
      const w = width * (1 - 0.55 * (i / n));
      const fade = smooth(0, 0.05, i / n) * (1 - 0.35 * smooth(0.9, 1, i / n));
      pos.push(0, P[0], P[1], 0, P[0] + (ox / l) * w, P[1] + (oy / l) * w);
      col.push(1, 1, 1, fade, 1, 1, 1, 0);
      if (i < n) { const v = i * 2; idx.push(v, v + 1, v + 2, v + 1, v + 3, v + 2); }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
    geo.setIndex(idx);
    return geo;
  }

  /**
   * 호를 따라가는 타원 통(손잡이·칼집). 단면 하나 = { s, ex, ey, n }: s = 호 위치, ex·ey = 반지름, n = 호에서 등 쪽으로 민 거리.
   * stations는 z가 커지는 순서(s가 줄어드는 순서)로 적는다. uv: u = 둘레, v = 길이.
   */
  function arcTube(frame, stations, seg = 16) {
    const pos = [], uv = [], idx = [];
    const s0 = stations[0].s, s1 = stations[stations.length - 1].s;
    stations.forEach((st) => {
      const f = frame(st.s);
      for (let j = 0; j <= seg; j++) {
        const ph = -Math.PI / 2 + (j / seg) * Math.PI * 2;
        const n = (st.n || 0) + st.ey * Math.sin(ph);
        pos.push(st.ex * Math.cos(ph), f.y + n * f.ny, f.z + n * f.nz);
        uv.push(j / seg, (st.s - s0) / (s1 - s0 || 1));
      }
    });
    const row = seg + 1;
    for (let i = 0; i + 1 < stations.length; i++) {
      for (let j = 0; j < seg; j++) {
        const a = i * row + j, b = a + row, c = a + 1, d = b + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const N = geo.attributes.normal;   // 이음매 법선 맞추기
    for (let i = 0; i < stations.length; i++) {
      const a = i * row, b = a + seg;
      const x = N.getX(a) + N.getX(b), y = N.getY(a) + N.getY(b), z = N.getZ(a) + N.getZ(b);
      const l = Math.hypot(x, y, z) || 1;
      N.setXYZ(a, x / l, y / l, z / l);
      N.setXYZ(b, x / l, y / l, z / l);
    }
    return geo;
  }

  // ── 카타나 텍스처 ───────────────────────────────────────────
  /** 도신 무늬: 담금질 경계(하몬)가 파도치고, 날 쪽은 서리처럼 희고, 능선 위는 어둡게 닦였다 */
  function katanaTextures(L, tipLen, RIDGE) {
    if (!hasDOM) return {};
    const KI = 1 - tipLen / L;
    const hamonAt = (u) => {
      const gun = Math.pow(Math.abs(Math.sin(u * Math.PI * 2 * 7.5 + 0.6)), 0.7) * 0.085;
      let m = 0.235 + gun + 0.03 * Math.sin(u * Math.PI * 2 * 3.1 + 1.7) + 0.022 * Math.sin(u * Math.PI * 2 * 17.3) + (vnoise(u * 60, 3.3) - 0.5) * 0.05;
      m = lerp(0.13, m, smooth(0.02, 0.1, u));         // 밑동은 낮게 시작
      if (u > KI) m = lerp(m, 0.66, smooth(KI, 1, u));  // 칼끝에서 등 쪽으로 돈다
      return m;
    };
    const map = canvasTexture(1536, 96, (c, w, h) => {
      const img = c.createImageData(w, h), d = img.data;
      for (let x = 0; x < w; x++) {
        const u = x / (w - 1), ham = hamonAt(u);
        for (let y = 0; y < h; y++) {
          const v = 1 - y / (h - 1), i = (y * w + x) * 4;
          const grain = vnoise(u * 150, v * 7) * 0.6 + vnoise(u * 460, v * 22) * 0.4;
          let val, tint = 1.05;
          if (v > RIDGE) {
            val = 66 + grain * 16;
            const groove = u > 0.035 && u < 0.72 && v > RIDGE + 0.075 && v < RIDGE + 0.2;
            if (groove) val -= 26 * smooth(0.035, 0.05, u) * (1 - smooth(0.68, 0.72, u));   // 긴 홈
            tint = 1.1;
          } else {
            const t = smooth(ham - 0.012, ham + 0.022, v);
            const yaki = 226 + (vnoise(u * 70, v * 12) - 0.5) * 20;
            const ji = 112 + (grain - 0.5) * 42;
            val = lerp(yaki, ji, t);
            val += Math.exp(-Math.pow((v - ham) / 0.014, 2)) * 22;                          // 경계의 밝은 안개
            if (Math.abs(v - ham - 0.018) < 0.05 && hash2(Math.floor(x / 2), y) > 0.965) val += 46;   // 경계의 작은 반짝임
            const streak = Math.sin(u * 900 + vnoise(u * 40, 1) * 6) > 0.93 ? 1 : 0;        // 경계에서 날 쪽으로 내려오는 옅은 줄
            if (v < ham && v > ham - 0.11) val -= streak * 14;
            val = lerp(val, 250, Math.exp(-Math.pow(v / 0.03, 2)));                          // 날끝
          }
          if (Math.abs(v - RIDGE) < 0.007) val += 58;                                        // 능선
          if (u > KI) val += 10;
          if (Math.abs(u - KI) < 0.0011 && v < RIDGE + 0.02) val += 70;                      // 칼끝 경계선
          d[i] = clamp(val / tint, 0, 255);
          d[i + 1] = clamp(val * 0.985, 0, 255);
          d[i + 2] = clamp(val * tint, 0, 255);
          d[i + 3] = 255;
        }
      }
      c.putImageData(img, 0, 0);
    });
    // 표면 거칠기(G)·금속성(B): 날 쪽은 서리처럼 거칠고, 지(地)와 능선 위는 거울에 가깝다
    const orm = canvasTexture(512, 48, (c, w, h) => {
      const img = c.createImageData(w, h), d = img.data;
      for (let x = 0; x < w; x++) {
        const u = x / (w - 1), ham = hamonAt(u);
        for (let y = 0; y < h; y++) {
          const v = 1 - y / (h - 1), i = (y * w + x) * 4;
          const t = smooth(ham - 0.02, ham + 0.03, v);
          let rough = lerp(0.5, 0.17, t);
          if (v > RIDGE) rough = 0.14;
          if (v < 0.03) rough = 0.2;
          d[i] = 0; d[i + 1] = rough * 255; d[i + 2] = lerp(0.72, 1, t) * 255; d[i + 3] = 255;
        }
      }
      c.putImageData(img, 0, 0);
    }, false);
    // 스스로 내는 차가운 빛: 날끝에 강하게, 하몬 선에 옅게
    const glow = canvasTexture(768, 48, (c, w, h) => {
      const img = c.createImageData(w, h), d = img.data;
      for (let x = 0; x < w; x++) {
        const u = x / (w - 1), ham = hamonAt(u), f = smooth(0.0, 0.06, u);
        for (let y = 0; y < h; y++) {
          const v = 1 - y / (h - 1), i = (y * w + x) * 4;
          const e = f * (Math.exp(-Math.pow(v / 0.05, 2)) + 0.16 * Math.exp(-Math.pow((v - ham) / 0.016, 2)));
          const g = clamp(e, 0, 1) * 255;
          d[i] = g; d[i + 1] = g; d[i + 2] = g; d[i + 3] = 255;
        }
      }
      c.putImageData(img, 0, 0);
    });
    // 날을 스치는 빛줄기: 비스듬한 흰 띠(칼을 꺼내거나 점검할 때 uv를 밀어 지나가게 한다)
    const gleam = canvasTexture(256, 32, (c, w, h) => {
      c.fillStyle = '#000';
      c.fillRect(0, 0, w, h);
      for (let y = 0; y < h; y++) {
        const cx = w / 2 + (y / h - 0.5) * 34;
        const g = c.createLinearGradient(cx - 34, 0, cx + 34, 0);
        g.addColorStop(0, 'rgba(255,255,255,0)');
        g.addColorStop(0.5, 'rgba(255,255,255,1)');
        g.addColorStop(1, 'rgba(255,255,255,0)');
        c.fillStyle = g;
        c.fillRect(0, y, w, 1);
      }
    });
    return { map, orm, glow, gleam };
  }

  /** 손잡이 끈: 마름모 창 사이로 밝은 상어 가죽이 보이고, 끈은 어두운 진홍. 한 칸이 반복된다 */
  function tsukaTexture() {
    const CORD = '#2c0b16', LIT = '#6e1a30', EDGE = 'rgba(4,0,2,0.9)';
    const tex = canvasTexture(256, 256, (c, w, h) => {
      c.fillStyle = '#d8d4c8';
      c.fillRect(0, 0, w, h);
      for (let i = 0; i < 1100; i++) {                   // 오돌토돌한 가죽 알갱이
        const x = hash2(i, 1) * w, y = hash2(i, 2) * h, r = 1 + hash2(i, 3) * 2.6;
        c.fillStyle = hash2(i, 4) > 0.5 ? 'rgba(255,255,250,0.85)' : 'rgba(120,114,100,0.45)';
        c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
      }
      const diamond = (k) => {
        c.moveTo(w / 2, h * (0.5 - 0.47 * k)); c.lineTo(w * (0.5 + 0.37 * k), h / 2);
        c.lineTo(w / 2, h * (0.5 + 0.47 * k)); c.lineTo(w * (0.5 - 0.37 * k), h / 2);
        c.closePath();
      };
      c.save();
      c.beginPath(); c.rect(0, 0, w, h); diamond(1);
      c.clip('evenodd');
      c.fillStyle = CORD;
      c.fillRect(0, 0, w, h);
      // 끈 결: 두 방향 사선. 위쪽 절반과 아래쪽 절반이 서로 엇갈린다
      c.lineWidth = 2;
      for (const [sy, flip] of [[0, 1], [h / 2, -1]]) {
        c.save();
        c.beginPath(); c.rect(0, sy, w, h / 2); c.clip();
        for (let i = -h; i < w + h; i += 9) {
          c.strokeStyle = i % 18 ? LIT : 'rgba(0,0,0,0.55)';
          c.beginPath(); c.moveTo(i, 0); c.lineTo(i + flip * h * 1.2, h); c.stroke();
        }
        c.restore();
      }
      // 끈 윤곽 입체: 가운데 밝고 가장자리가 어둡다
      const shade = c.createLinearGradient(0, 0, w, 0);
      shade.addColorStop(0, 'rgba(0,0,0,0.5)');
      shade.addColorStop(0.5, 'rgba(255,140,170,0.14)');
      shade.addColorStop(1, 'rgba(0,0,0,0.5)');
      c.fillStyle = shade;
      c.fillRect(0, 0, w, h);
      c.restore();
      // 창 테두리 그림자
      c.lineJoin = 'round';
      c.strokeStyle = EDGE; c.lineWidth = 9;
      c.beginPath(); diamond(1); c.stroke();
      c.strokeStyle = 'rgba(0,0,0,0.26)'; c.lineWidth = 15;
      c.beginPath(); diamond(0.93); c.stroke();
      // 교차 매듭 강조
      c.strokeStyle = 'rgba(255,170,190,0.28)'; c.lineWidth = 2;
      for (const yy of [2, h - 2]) { c.beginPath(); c.moveTo(w * 0.36, yy); c.lineTo(w * 0.64, yy); c.stroke(); }
    });
    if (tex) { tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.repeat.set(2, 7.5); }
    return tex;
  }

  // ── 카타나 ──────────────────────────────────────────────────
  function buildMlKatana() {
    const g = new THREE.Group();
    const parts = {};
    const GRIP = 0.13;                         // 코등이 ~ 두 손 가운데
    const sword = new THREE.Group();
    sword.position.z = -GRIP;
    g.add(sword);
    const RIDGE = 0.7;
    const B = bladeLoft({ L: 1.12, W0: 0.042, W1: 0.03, T0: 0.0092, T1: 0.0056, sag: 0.064, tipLen: 0.092, ridge: RIDGE, tipPow: 2.25, rings: 34, tipRings: 10 });
    const T = katanaTextures(B.L, B.tipLen, RIDGE);
    const bladeMat = new THREE.MeshStandardMaterial({
      color: 0xffffff, map: T.map || null, roughness: T.orm ? 1 : 0.28, metalness: T.orm ? 1 : 0.85,
      roughnessMap: T.orm || null, metalnessMap: T.orm || null, envMap: envTex, envMapIntensity: 1.55,
      emissive: 0x8fdcff, emissiveMap: T.glow || null, emissiveIntensity: T.glow ? 0.7 : 0.02, transparent: true, fog: false,
    });
    owned.mats.add(bladeMat);
    const blade = add(B.geo, bladeMat, sword);

    // 날끝 빛 띠: 평소에는 옅고 휘두를 때 밝아진다
    const edgeMat = new THREE.MeshBasicMaterial({ color: 0x9fe6ff, vertexColors: true, transparent: true, opacity: 0.32, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false, toneMapped: false });
    owned.mats.add(edgeMat);
    const edge = add(edgeSheet(B, 0.012), edgeMat, sword, 0, 0, 0, 3);

    // 도신을 스치는 빛줄기(도신 지오메트리를 그대로 쓰는 메시 하나, 지나갈 때만 켠다)
    let gleam = null;
    if (T.gleam) {
      T.gleam.wrapS = T.gleam.wrapT = THREE.ClampToEdgeWrapping;
      const gm = new THREE.MeshBasicMaterial({ map: T.gleam, color: 0xdff4ff, transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, toneMapped: false });
      owned.mats.add(gm);
      const mesh = add(B.geo, gm, sword, 0, 0, 0, 2);
      mesh.visible = false;
      mesh.userData.noBake = true;
      gleam = { mesh, tex: T.gleam, t: -1, next: 3 };
    }
    blade.userData.noBake = true;
    edge.userData.noBake = true;

    // 칼날 옷(금색 고리)·와셔·코등이
    const f0 = B.secAt(0);
    const cy = (f0.a + f0.e) / 2;                                 // 칼날 단면 가운데(손잡이 축과 맞춘다)
    const habakiW = (f0.a - f0.e) * 0.54, habakiT = f0.t * 0.68;
    const habaki = arcTube(B.frame, [
      { s: 0.036, ex: habakiT * 0.92, ey: habakiW * 0.95, n: cy }, { s: 0.034, ex: habakiT, ey: habakiW, n: cy },
      { s: 0.004, ex: habakiT * 1.04, ey: habakiW * 1.04, n: cy }, { s: 0, ex: habakiT * 1.04, ey: habakiW * 1.04, n: cy },
    ], 10);
    add(habaki, M.brass, sword);
    const ovalDisc = (ex, ey, th, mat, z) => {
      const d = new THREE.CylinderGeometry(1, 1, th, 18);
      d.rotateX(Math.PI / 2);
      d.scale(ex, ey, 1);
      return add(d, mat, sword, 0, cy, z);
    };
    ovalDisc(0.0122, 0.024, 0.002, M.brass, 0.004);
    ovalDisc(0.0122, 0.024, 0.002, M.brass, 0.013);
    // 코등이: 둥근 사각 철판에 초승달 구멍 두 개를 뚫은 오리지널 문양
    const superEllipse = (a, b, n, path, cw = false) => {
      const steps = 48;
      for (let i = 0; i <= steps; i++) {
        const t = ((cw ? -i : i) / steps) * Math.PI * 2, ct = Math.cos(t), st = Math.sin(t);
        const x = a * Math.sign(ct) * Math.pow(Math.abs(ct), 2 / n), y = b * Math.sign(st) * Math.pow(Math.abs(st), 2 / n);
        if (i) path.lineTo(x, y); else path.moveTo(x, y);
      }
      path.closePath();
    };
    const crescent = (sign) => {
      const h = new THREE.Path();
      const cx = sign * 0.0148, R = 0.0145, cx2 = sign * 0.009, R2 = 0.0136, A = 1.02;
      const n = 12;
      for (let i = 0; i <= n; i++) {
        const t = -A + (2 * A * i) / n, x = cx + sign * R * Math.cos(t), y = R * Math.sin(t);
        if (i) h.lineTo(x, y); else h.moveTo(x, y);
      }
      for (let i = n; i >= 0; i--) {
        const t = -A + (2 * A * i) / n;
        h.lineTo(cx2 + sign * R2 * Math.cos(t) * 1.06, R * 0.86 * Math.sin(t));
      }
      h.closePath();
      return h;
    };
    const tsubaShape = new THREE.Shape();
    superEllipse(0.0395, 0.0465, 2.7, tsubaShape);
    tsubaShape.holes.push(crescent(1), crescent(-1));
    const tsuba = new THREE.ExtrudeGeometry(tsubaShape, { depth: 0.0042, bevelEnabled: true, bevelThickness: 0.001, bevelSize: 0.001, bevelOffset: -0.001, bevelSegments: 2, curveSegments: 6 });
    tsuba.translate(0, 0, -0.0021);
    add(tsuba, M.iron, sword, 0, cy, 0.0085);
    const rimShape = new THREE.Shape();
    superEllipse(0.0404, 0.0474, 2.7, rimShape);
    const rimHole = new THREE.Path();
    superEllipse(0.0382, 0.0452, 2.7, rimHole, true);
    rimShape.holes.push(rimHole);
    const rim = new THREE.ExtrudeGeometry(rimShape, { depth: 0.0058, bevelEnabled: false, curveSegments: 6 });
    rim.translate(0, 0, -0.0029);
    add(rim, M.brass, sword, 0, cy, 0.0085);

    // 손잡이: 칼날 곡선을 이어 받는 타원 통에 끈 무늬. 호는 칼날보다 완만하다
    const Rh = (B.Rc === Infinity ? 1e6 : B.Rc) * 1.7;
    const hFrame = (s) => { const th = s / Rh, c = Math.cos(th), sn = Math.sin(th); return { y: Rh * (1 - c), z: -Rh * sn, ny: c, nz: sn }; };
    const HL = 0.268;                                             // 손잡이 길이
    const ex = 0.0138, ey = 0.0178;
    const stations = [];
    for (let i = 0; i <= 14; i++) {
      const t = i / 14;                                           // 0 = 코등이 쪽
      const waist = 1 - 0.08 * Math.sin(Math.PI * t);
      stations.push({ s: -(0.03 + t * (HL - 0.03)), ex: ex * waist * lerp(1, 1.05, t), ey: ey * waist * lerp(1.02, 1.03, t), n: cy });
    }
    const tsukaTex = tsukaTexture();
    const tsukaMat = std(0xffffff, { rough: 0.8, metal: 0, glow: 0, env: false });
    if (tsukaTex) tsukaMat.map = tsukaTex; else tsukaMat.color.setHex(0x2c0b16);
    add(arcTube(hFrame, stations, 18), tsukaMat, sword);
    // 금속 고리(후치)·손잡이 끝 마개(카시라)
    const fuchi = arcTube(hFrame, [
      { s: -0.0145, ex: ex * 1.1, ey: ey * 1.1, n: cy }, { s: -0.016, ex: ex * 1.14, ey: ey * 1.14, n: cy },
      { s: -0.03, ex: ex * 1.12, ey: ey * 1.12, n: cy }, { s: -0.0315, ex: ex * 1.02, ey: ey * 1.02, n: cy },
    ], 16);
    add(fuchi, M.iron, sword);
    const kashira = arcTube(hFrame, [
      { s: -HL + 0.004, ex: ex * 1.03, ey: ey * 1.03, n: cy }, { s: -HL, ex: ex * 1.1, ey: ey * 1.1, n: cy },
      { s: -HL - 0.018, ex: ex * 1.12, ey: ey * 1.12, n: cy }, { s: -HL - 0.024, ex: ex * 0.86, ey: ey * 0.88, n: cy },
      { s: -HL - 0.027, ex: ex * 0.32, ey: ey * 0.34, n: cy }, { s: -HL - 0.0275, ex: 0.0003, ey: 0.0003, n: cy },
    ], 16);
    add(kashira, M.iron, sword);
    const kashiraRing = arcTube(hFrame, [
      { s: -HL - 0.0015, ex: ex * 1.13, ey: ey * 1.13, n: cy }, { s: -HL - 0.006, ex: ex * 1.13, ey: ey * 1.13, n: cy },
    ], 16);
    add(kashiraRing, M.brass, sword);
    // 손잡이 장식(메누키): 끈 사이로 보이는 금속 마름모
    for (const s of [1, -1]) {
      const fm = hFrame(-0.145);
      const orn = new THREE.OctahedronGeometry(1, 0);
      orn.scale(0.0032, 0.0085, 0.0135);
      add(orn, M.brass, sword, s * (ex * 0.93), fm.y + cy * fm.ny, fm.z);
    }

    // 칼집(꺼낼 때만 보인다). 호의 중심을 축으로 돌리면 칼날과 같은 곡선으로 미끄러진다
    const Rc = B.Rc === Infinity ? 1e6 : B.Rc;
    const sayaPivot = new THREE.Group();
    sayaPivot.position.set(0, Rc, 0);
    sword.add(sayaPivot);
    const sayaBody = new THREE.Group();
    sayaBody.position.set(0, -Rc, 0);
    sayaPivot.add(sayaBody);
    const sayaW = 0.039, sayaT = 0.0125;
    const sayaSt = [];
    for (let i = 0; i <= 22; i++) {
      const t = i / 22, s = lerp(B.L + 0.022, 0.03, t);
      sayaSt.push({ s, ex: lerp(sayaT * 0.82, sayaT, t), ey: lerp(sayaW * 0.8, sayaW, t), n: lerp(-0.0015, cy, t) });
    }
    add(arcTube(B.frame, sayaSt, 16), M.lacquer, sayaBody);
    const sayaEnd = arcTube(B.frame, [
      { s: B.L + 0.046, ex: 0.0004, ey: 0.0004, n: -0.0015 }, { s: B.L + 0.045, ex: sayaT * 0.5, ey: sayaW * 0.52, n: -0.0015 },
      { s: B.L + 0.038, ex: sayaT * 0.84, ey: sayaW * 0.82, n: -0.0015 }, { s: B.L + 0.018, ex: sayaT * 0.88, ey: sayaW * 0.84, n: -0.0015 },
    ], 16);
    add(sayaEnd, M.iron, sayaBody);
    const mouth = arcTube(B.frame, [
      { s: 0.032, ex: sayaT * 1.04, ey: sayaW * 1.03, n: cy }, { s: 0.008, ex: sayaT * 1.1, ey: sayaW * 1.08, n: cy },
      { s: 0.006, ex: sayaT * 0.5, ey: sayaW * 0.6, n: cy },
    ], 16);
    add(mouth, M.brass, sayaBody);
    const cordWrap = arcTube(B.frame, [
      { s: 0.1, ex: sayaT * 1.08, ey: sayaW * 1.05, n: cy }, { s: 0.072, ex: sayaT * 1.08, ey: sayaW * 1.05, n: cy },
    ], 16);
    add(cordWrap, paint(0x571224, { rough: 0.85, metal: 0, glow: 0.14 }), sayaBody);
    sayaPivot.userData.hiddenIdle = true;
    parts.saya = sayaPivot;

    // 궤적 기준점(모형 로컬)
    const F = (s, n) => { const f = B.frame(s); return new THREE.Vector3(0, f.y + n * f.ny, f.z + n * f.nz - GRIP); };
    const tipP = F(B.L, B.secAt(B.L).a);
    const midP = F(B.L * 0.64, cy);
    const mouthP = F(0.01, cy);

    // 손: 오른손은 코등이 바로 뒤, 왼손은 손잡이 끝 쪽
    const hy = (z) => { const f = hFrame(-(z + GRIP)); return f.y + cy * f.ny; };
    const armR = makeArm('R', [0, hy(-0.066), -0.066], [0, 0, 1], [1, 0, 0], 0.0168);
    const armL = makeArm('L', [0, hy(0.074), 0.074], [0, 0, 1], [-1, 0, 0], 0.0168);
    armL.userData.hiddenIdle = true;                              // 평소에는 한 손으로 든다. 강타·꺼내기 때만 왼손이 온다

    // 키프레임(카메라 좌표)
    const idle = K([0.262, -0.175, -0.49], [-0.42, 0.62, -0.66], [-0.82, -0.42, 0.08]);
    // 베기 A: 오른쪽 위 → 조준점 → 왼쪽 아래. 손은 화면 아래쪽에 두고 칼끝이 크게 돈다
    const aW = K([0.335, -0.115, -0.47], [0.12, 0.84, -0.53], [-0.95, 0.06, -0.3]);
    const aM = K([0.17, -0.155, -0.47], [-0.56, 0.4, -0.73], [-0.64, -0.68, 0.36]);
    const aE = K([0.02, -0.205, -0.45], [-0.92, -0.2, -0.34], [-0.2, -0.9, 0.39]);
    const aA = K([-0.015, -0.215, -0.44], [-0.94, -0.28, -0.2], [-0.25, -0.88, 0.4]);
    // 베기 B: 왼쪽 아래 → 조준점 → 오른쪽 위(되돌아 벤다)
    const bW = K([0.06, -0.205, -0.46], [-0.84, -0.04, -0.54], [0.36, 0.78, -0.51]);
    const bM = K([0.17, -0.15, -0.48], [-0.08, 0.5, -0.86], [0.84, 0.42, 0.33]);
    const bE = K([0.335, -0.115, -0.46], [0.45, 0.75, -0.48], [0.68, -0.6, 0.42]);
    const bA = K([0.355, -0.122, -0.45], [0.52, 0.7, -0.49], [0.62, -0.68, 0.38]);
    // 강타: 두 손으로 머리 위로 들었다가(칼끝은 앞을 향해 화면에 남는다) 조준점을 지나 내려친다
    const hW = K([0.17, -0.055, -0.47], [-0.06, 0.9, -0.43], [0.02, 0.43, -0.9]);
    const hM = K([0.14, -0.13, -0.53], [-0.1, 0.22, -0.97], [-0.03, -0.97, -0.22]);
    const hE = K([0.15, -0.205, -0.5], [-0.14, -0.13, -0.98], [-0.08, -0.98, 0.14]);
    const melee = {
      idle,
      span: 0.105, heavySpan: 0.085, heavyAfter: 0.13,
      slashA: { wind: aW, mid: aM, end: aE, after: aA },
      slashB: { wind: bW, mid: bM, end: bE, after: bA },
      heavy: {
        wind: hW, hold: between(hW, hW, 0, [0.172, -0.04, -0.46]), mid: hM, end: hE,
        after: between(hM, hE, 1.06, [0.15, -0.218, -0.495]),
      },
      // 점검: 칼을 눈앞에 가로로 들고 → 빛을 따라 기울이고 → 뒤집어 반대쪽 면을 본다
      inspect: [
        { t: 0, ...idle },
        { t: 0.52, ...K([0.235, -0.15, -0.42], [-0.93, 0.1, -0.35], [-0.03, -0.96, -0.2]), e: 'io' },
        { t: 1.25, ...K([0.25, -0.13, -0.43], [-0.9, 0.2, -0.39], [-0.1, -0.92, -0.34]), e: 'io' },
        { t: 1.5, ...K([0.235, -0.13, -0.42], [-0.9, 0.22, -0.38], [-0.3, 0.1, 0.94]), e: 'io' },
        { t: 1.75, ...K([0.225, -0.13, -0.42], [-0.9, 0.24, -0.37], [0.14, 0.9, 0.42]), e: 'io' },
        { t: 2.55, ...K([0.24, -0.11, -0.44], [-0.86, 0.34, -0.38], [0.22, 0.86, 0.46]), e: 'io' },
        { t: 3.2, ...idle, e: 'io' },
      ],
      inspectDur: 3.2,
      // 꺼내기(진행도 u 0..1): 허리에서 칼집째 올라옴 → 뽑아 냄 → 칼끝을 위로 튕김 → 자세 잡기
      draw: [
        { t: 0, ...K([0.2, -0.52, -0.3], [-0.82, -0.12, -0.56], [0.17, 0.82, -0.55]) },
        { t: 0.16, ...K([0.1, -0.17, -0.4], [-0.82, -0.12, -0.56], [0.17, 0.82, -0.55]), e: 'out' },
        { t: 0.5, ...K([0.5, -0.12, -0.36], [-0.84, -0.06, -0.54], [0.13, 0.84, -0.53]), e: 'io' },
        { t: 0.76, ...K([0.3, -0.06, -0.5], [-0.3, 0.84, -0.45], [-0.86, -0.2, 0.2]), e: 'out' },
        { t: 1, ...idle, e: 'io' },
      ],
    };
    return {
      g, parts, muzzle: null,
      arms: { R: armR, L: armL },
      hip: [idle.p.x, idle.p.y, idle.p.z], hipRot: [0, 0, 0],
      ads: null,
      kick: { z: 0, pitch: 0, roll: 0 }, flash: 0,
      elbowR: new THREE.Vector3(0.62, -0.62, -0.1), elbowL: new THREE.Vector3(0.0, -0.8, 0.0),
      melee, tipP, midP, mouthP, trailColor: 0xa9eaff, trailGain: 1,
      blade: bladeMat, edge: edgeMat, gleam, sayaRc: Rc, sayaLen: B.L + 0.06, swordZ: -GRIP,
    };
  }

  // ── 호크빌 나이프 ───────────────────────────────────────────
  /** 기본 칼: 안으로 굽은 갈고리 날과 톱니, 밧줄을 감은 손잡이 */
  function buildMlKnife() {
    const g = new THREE.Group();
    const parts = {};
    const rope = paint(0xc29d63, { rough: 0.95, metal: 0, glow: 0.08 });
    const ropeDark = paint(0x7a5a33, { rough: 0.95, metal: 0 });
    cyl(0.0155, 0.017, 0.11, ropeDark, g, 'z', 0, 0, 0.035);             // 손잡이
    for (let i = 0; i < 6; i++) torus(0.0168, 0.0032, rope, g, 0, 0, -0.01 + i * 0.018);   // 밧줄 감기
    box(0.014, 0.054, 0.012, M.black, g, 0, -0.004, -0.024);             // 날밑
    cyl(0.0175, 0.014, 0.016, M.black, g, 'z', 0, 0, 0.098);             // 손잡이 끝
    torus(0.009, 0.0022, M.cuff, g, 0, -0.012, 0.11).rotation.y = Math.PI / 2;   // 끈 고리
    const s = new THREE.Shape();
    s.moveTo(0, 0.011);
    s.lineTo(0.115, 0.011);
    s.quadraticCurveTo(0.156, 0.009, 0.168, -0.018);
    s.lineTo(0.162, -0.021);
    s.quadraticCurveTo(0.142, -0.004, 0.11, -0.006);
    for (let u = 0.11; u > 0.03; u -= 0.012) { s.lineTo(u - 0.006, -0.013); s.lineTo(u - 0.012, -0.007); }   // 톱니
    s.lineTo(0, -0.012);
    s.lineTo(0, 0.011);
    const bg = new THREE.ExtrudeGeometry(s, { depth: 0.004, bevelEnabled: true, bevelThickness: 0.0012, bevelSize: 0.001, bevelSegments: 1, curveSegments: 8 });
    bg.translate(0, 0, -0.002);
    bg.rotateY(Math.PI / 2);                                             // 길이 → -z, 두께 → x
    parts.blade = add(bg, M.steel, g, 0, 0, -0.03);
    const melee = shortBladeClips({ heavy: 'stab' });
    return {
      g, parts, muzzle: null,
      arms: { R: makeArm('R', [0, 0, 0.035], [0, 0, 1], [1, 0, 0], 0.0172), L: null },
      hip: [melee.idle.p.x, melee.idle.p.y, melee.idle.p.z], hipRot: [0, 0, 0],
      ads: null,
      kick: { z: 0, pitch: 0, roll: 0 }, flash: 0,
      melee, tipP: new THREE.Vector3(0, -0.018, -0.198), midP: new THREE.Vector3(0, -0.002, -0.11), trailColor: 0xe6d9c0, trailGain: 0.6,
    };
  }

  // ── 구르카 나이프 ───────────────────────────────────────────
  /** 곧은 뿌리에서 앞쪽이 아래로 꺾이고 배가 넓어지는 날. 나무 손잡이와 황동 장식 */
  function buildMlGurkha() {
    const g = new THREE.Group();
    const parts = {};
    const wood = paint(0x5b3a1e, { rough: 0.55, metal: 0.05, glow: 0.1 });
    prof([[-0.03, 0.015], [0.0, 0.017], [0.05, 0.013], [0.092, 0.003], [0.11, -0.012], [0.1, -0.026], [0.055, -0.021], [0.0, -0.021], [-0.03, -0.017]], 0.027, wood, g, 0, 0, 0, 0.002);
    box(0.03, 0.052, 0.012, M.brass, g, 0, -0.002, -0.034);              // 날밑
    box(0.0285, 0.043, 0.006, M.brass, g, 0, -0.002, 0.006);             // 손잡이 띠
    box(0.0285, 0.04, 0.006, M.brass, g, 0, -0.005, 0.066);
    box(0.03, 0.03, 0.01, M.brass, g, 0, -0.012, 0.107);                 // 손잡이 끝
    const s = new THREE.Shape();
    // x = 밑동에서 칼끝 쪽, y = 등(+) / 날(-)
    s.moveTo(0, 0.012);
    s.lineTo(0.07, 0.014);                                               // 등: 곧게 나가다가
    s.quadraticCurveTo(0.13, 0.014, 0.19, -0.016);                       // 앞으로 꺾인다
    s.quadraticCurveTo(0.235, -0.04, 0.275, -0.07);                      // 칼끝
    s.quadraticCurveTo(0.225, -0.082, 0.175, -0.066);                    // 넓은 배
    s.quadraticCurveTo(0.12, -0.046, 0.06, -0.019);                      // 안으로 굽은 날
    s.lineTo(0.02, -0.016);
    s.lineTo(0.014, -0.009);                                             // 날 뿌리의 작은 홈
    s.lineTo(0.008, -0.016);
    s.lineTo(0, -0.015);
    s.lineTo(0, 0.012);
    const bg = new THREE.ExtrudeGeometry(s, { depth: 0.005, bevelEnabled: true, bevelThickness: 0.0014, bevelSize: 0.0012, bevelSegments: 1, curveSegments: 10 });
    bg.translate(0, 0, -0.0025);
    bg.rotateY(Math.PI / 2);                                             // 길이 → -z, 두께 → x
    parts.blade = add(bg, M.steel, g, 0, 0, -0.038);
    const melee = shortBladeClips({ heavy: 'chop', push: 0.03 });
    return {
      g, parts, muzzle: null,
      arms: { R: makeArm('R', [0, -0.003, 0.034], [0, 0, 1], [1, 0, 0], 0.0185), L: null },
      hip: [melee.idle.p.x, melee.idle.p.y, melee.idle.p.z], hipRot: [0, 0, 0],
      ads: null,
      kick: { z: 0, pitch: 0, roll: 0 }, flash: 0,
      melee, tipP: new THREE.Vector3(0, -0.07, -0.313), midP: new THREE.Vector3(0, -0.02, -0.16), trailColor: 0xffe2a8, trailGain: 0.8,
    };
  }

  // ── 탄토 ────────────────────────────────────────────────────
  /** 짧고 빠른 칼: 무광 흑색 도신에 날만 밝게 갈았다. 칼끝은 각진 탄토형 */
  function buildMlTanto() {
    const g = new THREE.Group();
    const parts = {};
    const blade = new THREE.Group();
    blade.position.z = -0.028;
    g.add(blade);
    const RIDGE = 0.46;
    const B = bladeLoft({ L: 0.178, W0: 0.031, W1: 0.029, T0: 0.0052, T1: 0.0046, sag: 0, tipLen: 0.036, ridge: RIDGE, tipPow: 1.05, rings: 6, tipRings: 3, sub: 2, niku: 0.06 });
    const tex = canvasTexture(256, 64, (c, w, h) => {
      c.fillStyle = '#23262b';
      c.fillRect(0, 0, w, h);
      const ridgeY = h * (1 - RIDGE);
      const grind = c.createLinearGradient(0, ridgeY, 0, h);
      grind.addColorStop(0, '#6d747e');
      grind.addColorStop(0.72, '#c6ccd4');
      grind.addColorStop(1, '#f4f7fa');
      c.fillStyle = grind;
      c.fillRect(0, ridgeY, w, h - ridgeY);
      c.fillStyle = 'rgba(255,255,255,0.5)';
      c.fillRect(0, ridgeY - 1, w, 2);
      c.fillStyle = '#ff7a1a';                // 작은 표식
      c.fillRect(w * 0.1, h * 0.2, w * 0.1, h * 0.05);
      c.fillStyle = '#14161a';                // 등 쪽 홈
      c.fillRect(w * 0.1, h * 0.28, w * 0.5, h * 0.06);
    });
    const bm = new THREE.MeshStandardMaterial({ color: 0xffffff, map: tex, roughness: 0.34, metalness: 0.78, envMap: envTex, envMapIntensity: 1.25, transparent: true, fog: false });
    owned.mats.add(bm);
    add(B.geo, bm, blade);
    parts.blade = blade;
    // 코등이·손잡이·손잡이 끝
    prof([[-0.032, 0.02], [-0.024, 0.02], [-0.024, -0.03], [-0.032, -0.03]], 0.0115, M.iron, g, 0, 0, 0, 0.001);
    const hFrame = (s) => ({ y: 0, z: -s, ny: 1, nz: 0 });
    const st = [];
    for (let i = 0; i <= 8; i++) {
      const t = i / 8, wave = 1 + 0.07 * Math.cos(t * Math.PI * 6);
      st.push({ s: lerp(0.024, -0.086, t), ex: 0.0125 * wave, ey: 0.0165 * wave, n: -0.003 });
    }
    add(arcTube(hFrame, st, 12), paint(0x1d2024, { rough: 0.82, metal: 0.05, glow: 0.14 }), g);
    for (let i = 0; i < 4; i++) {
      const band = arcTube(hFrame, [{ s: 0.01 - i * 0.026, ex: 0.0136, ey: 0.0178, n: -0.003 }, { s: 0.004 - i * 0.026, ex: 0.0136, ey: 0.0178, n: -0.003 }], 12);
      add(band, paint(0xff7a1a, { rough: 0.7, metal: 0, glow: 0.2 }), g);
    }
    const cap = arcTube(hFrame, [
      { s: -0.084, ex: 0.0138, ey: 0.018, n: -0.003 }, { s: -0.096, ex: 0.0128, ey: 0.0165, n: -0.003 }, { s: -0.102, ex: 0.006, ey: 0.008, n: -0.003 }, { s: -0.1025, ex: 0.0003, ey: 0.0003, n: -0.003 },
    ], 12);
    add(cap, M.iron, g);
    const F = (s) => new THREE.Vector3(0, B.secAt(s).a, -s - 0.028);
    const melee = shortBladeClips({ heavy: 'stab' });
    return {
      g, parts, muzzle: null,
      arms: { R: makeArm('R', [0, -0.003, 0.038], [0, 0, 1], [1, 0, 0], 0.0145), L: null },
      hip: [melee.idle.p.x, melee.idle.p.y, melee.idle.p.z], hipRot: [0, 0, 0],
      ads: null,
      kick: { z: 0, pitch: 0, roll: 0 }, flash: 0,
      melee, tipP: F(B.L), midP: new THREE.Vector3(0, -0.005, -0.11), trailColor: 0xdfe8f2, trailGain: 0.6,
    };
  }

  // ── 수류탄 ──────────────────────────────────────────────────
  function buildGrFrag() {
    const g = new THREE.Group();
    const parts = {};
    const nade = new THREE.Group();                                         // 드럼형 수류탄
    g.add(nade);
    cyl(0.032, 0.032, 0.078, M.drum, nade, 'y', 0, 0, 0, 20);
    cyl(0.0326, 0.0326, 0.01, M.black, nade, 'y', 0, 0.027, 0, 20);
    cyl(0.0326, 0.0326, 0.01, M.black, nade, 'y', 0, -0.027, 0, 20);
    torus(0.0332, 0.0026, M.drumDark, nade, 0, 0.012, 0).rotation.x = Math.PI / 2;   // 굴림테
    torus(0.0332, 0.0026, M.drumDark, nade, 0, -0.012, 0).rotation.x = Math.PI / 2;
    cyl(0.0305, 0.032, 0.006, M.drum, nade, 'y', 0, 0.042, 0, 20);
    cyl(0.01, 0.012, 0.02, M.gunmetal, nade, 'y', 0, 0.055, 0);            // 신관
    cyl(0.006, 0.006, 0.006, M.black, nade, 'y', 0.016, 0.046, 0.008);      // 주입구 마개
    box(0.012, 0.07, 0.005, M.steel, nade, -0.034, 0.024, 0).rotation.z = -0.08;  // 안전 손잡이
    box(0.026, 0.005, 0.012, M.steel, nade, -0.023, 0.062, 0);
    const pin = new THREE.Group();
    pin.position.set(0.012, 0.058, 0);
    nade.add(pin);
    torus(0.011, 0.0018, M.steel, pin, 0.012, 0, 0).rotation.y = Math.PI / 2;
    cyl(0.0015, 0.0015, 0.026, M.steel, pin, 'x', 0, 0, 0);
    parts.pin = pin;
    parts.nade = nade;
    // 둥근 몸통 라벨(곡면): FRAG / 신관 시간
    const tex = canvasTexture(512, 160, textDraw([
      { text: 'FRAG', size: 0.5, y: 0.38, color: '#15171a' },
      { text: 'FUSE 2.5 S', size: 0.24, y: 0.78, color: '#15171a', weight: 700 },
    ]));
    if (tex) {
      const lm = new THREE.MeshLambertMaterial({ map: tex, transparent: true, depthWrite: false, fog: false });
      owned.mats.add(lm);
      // 라벨 중심 θ=-0.1 → 손에 든 각도(hipRot y -0.35)에서 카메라 쪽(-0.45rad)을 본다
      add(new THREE.CylinderGeometry(0.0328, 0.0328, 0.034, 20, 1, true, -0.1 - 0.95, 1.9), lm, nade, 0, 0, 0, 1);
    }
    const L = makeArm('L', [-0.09, -0.13, 0.06], [0, 0, 1], [-0.3, -0.9, 0.3], 0.018);
    L.userData.hiddenIdle = true;
    return {
      g, parts, muzzle: null,
      arms: { R: makeArm('R', [0.006, -0.002, 0.004], [0, -1, 0.05], [0.72, -0.1, 0.68], 0.0332), L },
      hip: [0.115, -0.085, -0.27], hipRot: [0.15, -0.35, 0.05],
      ads: null,
      kick: { z: 0, pitch: 0, roll: 0 }, flash: 0,
    };
  }

  // ── 조준기 ──────────────────────────────────────────────────
  const reticle = (parent, y, z, r = 0.0017) => add(new THREE.CircleGeometry(r, 12), M.dot, parent, 0, y, z, 3);
  /** 열린 틀 홀로 조준기. 돌려주는 값 = 조준점 높이(모형 로컬) */
  function sightHolo(g, y, z) {
    const s = new THREE.Group();
    s.position.set(0, y, z);
    g.add(s);
    box(0.036, 0.012, 0.06, M.black, s, 0, 0, 0);
    box(0.004, 0.034, 0.008, M.black, s, 0.0175, 0.023, -0.022);
    box(0.004, 0.034, 0.008, M.black, s, -0.0175, 0.023, -0.022);
    box(0.039, 0.004, 0.008, M.black, s, 0, 0.042, -0.022);
    add(new THREE.PlaneGeometry(0.031, 0.03), M.glass, s, 0, 0.023, -0.022, 2);
    reticle(s, 0.023, -0.0235);
    return y + 0.023;
  }
  /** 짧은 원통 조준기 */
  function sightDot(g, y, z, accent) {
    const s = new THREE.Group();
    s.position.set(0, y, z);
    g.add(s);
    box(0.026, 0.01, 0.04, M.black, s, 0, 0, 0);
    const r = 0.0135, h = 0.024;
    lathe([[r + 0.0012, -0.025], [r, -0.022], [r, 0.022], [r + 0.0012, 0.025], [r - 0.0012, 0.025], [r - 0.0012, -0.025], [r + 0.0012, -0.025]], M.black, s, 0, h, 0);
    add(new THREE.CircleGeometry(r - 0.0012, 18), M.glass, s, 0, h, -0.012, 2).rotation.y = Math.PI;
    reticle(s, h, -0.0125, 0.0014);
    if (accent) box(0.004, 0.004, 0.016, accent, s, 0, h + r + 0.002, 0.004);
    return y + h;
  }
  /** 속이 뚫린 짧은 배율 조준경(오버레이 없는 무기). 조준하면 통 안으로 들여다본다 */
  function sightScope(g, y, z, { r = 0.0165, len = 0.2, bell = 0.024, eye = 0.0205, body = M.black, ring = null } = {}) {
    const s = new THREE.Group();
    s.position.set(0, y, z);
    g.add(s);
    const f = -len / 2, b = len / 2, wall = 0.0024;
    lathe([
      [bell, f], [bell, f + 0.042], [r, f + 0.074], [r, b - 0.05], [eye, b - 0.016], [eye, b],
      [eye - wall, b], [r - wall, b - 0.05], [r - wall, f + 0.074], [bell - wall, f + 0.042], [bell - wall, f], [bell, f],
    ], body, s, 0, 0, 0, 20);
    add(new THREE.CircleGeometry(bell - wall, 20), M.glass, s, 0, 0, f + 0.012, 2).rotation.y = Math.PI;
    reticle(s, 0, f + 0.01, 0.00085);
    cyl(0.0075, 0.0075, 0.012, M.gunmetal, s, 'y', 0, r + 0.004, -0.008);
    cyl(0.0075, 0.0075, 0.012, M.gunmetal, s, 'x', r + 0.004, 0, -0.008);
    if (ring) lathe([[r + 0.0006, -0.004], [r + 0.0006, 0.004], [r - 0.0005, 0.004], [r - 0.0005, -0.004], [r + 0.0006, -0.004]], ring, s, 0, 0, b - 0.066);
    box(0.02, r + 0.008, 0.016, M.gunmetal, s, 0, -r - 0.003, -0.04);
    box(0.02, r + 0.008, 0.016, M.gunmetal, s, 0, -r - 0.003, 0.04);
    return y;
  }
  /** 위쪽 레일 톱니 */
  function railTeeth(g, y, z0, z1, w = 0.022) {
    box(w, 0.005, Math.abs(z1 - z0), M.black, g, 0, y, (z0 + z1) / 2);
    for (let z = Math.min(z0, z1) + 0.004; z < Math.max(z0, z1); z += 0.0115) box(w + 0.003, 0.0035, 0.0058, M.black, g, 0, y + 0.0035, z);
  }
  /** 권총 손잡이(아래가 뒤로 젖혀진다) */
  function pistolGrip(g, top, z, mat, w = 0.03, len = 0.095) {
    prof([[z - 0.023, top], [z + 0.022, top], [z + 0.048, top - len * 0.92], [z + 0.008, top - len]], w, mat, g, 0, 0, 0, 0.003);
    prof([[z - 0.0235, top - 0.018], [z - 0.0185, top - 0.018], [z + 0.0045, top - len + 0.004], [z + 0.002, top - len]], w + 0.0015, M.black, g, 0, 0, 0, 0.0006);   // 앞면 미끄럼 방지
  }
  function triggerGroup(g, top, z) {
    box(0.0075, 0.0055, 0.056, M.black, g, 0, top - 0.024, z - 0.003);
    box(0.0075, 0.026, 0.0055, M.black, g, 0, top - 0.012, z - 0.03);
    prof([[z - 0.008, top], [z - 0.002, top], [z - 0.004, top - 0.018], [z - 0.009, top - 0.016]], 0.004, M.steel, g);
  }
  /** 뒤쪽 끝이 z = zs가 되는 총구 장치. 돌려주는 값 = 앞 끝 z */
  function muzzleDevice(type, g, y, zs, mat = M.black) {
    switch (type) {
      case 'comp': {                  // 위로 구멍 뚫린 보정기
        cyl(0.0165, 0.0165, 0.062, mat, g, 'z', 0, y, zs - 0.031);
        for (let i = 0; i < 3; i++) box(0.012, 0.004, 0.009, M.gunmetal, g, 0, y + 0.0155, zs - 0.015 - i * 0.015);
        return zs - 0.062;
      }
      case 'triple': {                // 고리 3개
        cyl(0.0105, 0.0105, 0.06, M.gunmetal, g, 'z', 0, y, zs - 0.03);
        for (let i = 0; i < 3; i++) cyl(0.0165, 0.0165, 0.012, mat, g, 'z', 0, y, zs - 0.01 - i * 0.02);
        return zs - 0.06;
      }
      case 'long': {                  // 길고 가는 소염기
        cyl(0.0125, 0.0105, 0.082, mat, g, 'z', 0, y, zs - 0.041);
        for (let i = 0; i < 4; i++) box(0.0245, 0.0028, 0.012, M.gunmetal, g, 0, y, zs - 0.024 - i * 0.015);
        return zs - 0.082;
      }
      default: {                      // 평범한 소염기
        cyl(0.0148, 0.0148, 0.05, mat, g, 'z', 0, y, zs - 0.025);
        for (let i = 0; i < 3; i++) box(0.0028, 0.03, 0.022, M.gunmetal, g, 0, y, zs - 0.03);
        return zs - 0.05;
      }
    }
  }

  // ── 공용 라이플 ─────────────────────────────────────────────
  /**
   * @param {object} P
   *   id, upper·lower·guard·stockColor·magColor(색), guardLen(총열덮개 길이), barrel(노출 총열), barrelR,
   *   muzzle('flash'|'comp'|'triple'|'long'), magLen·magCurve(탄창 길이 배율·앞으로 굽는 정도), stock('fixed'|'skeleton'|'tube'|'none'),
   *   optic('holo'|'dot'|'lpvo'), layout('std'|'bullpup'), hip·hipRot, kick, flash
   */
  function buildRifle(P) {
    const g = new THREE.Group();
    const parts = {};
    const accent = paint(accentOf(P.id, P.accent ?? 0xc0392b), { rough: 0.45, metal: 0.15, glow: 0.24 });
    const cUpper = paint(P.upper, { rough: 0.5, metal: 0.45 });
    const cLower = paint(P.lower, { rough: 0.55, metal: 0.4 });
    const cGuard = paint(P.guard, { rough: 0.6, metal: 0.3 });
    const cStock = paint(P.stockColor, { rough: 0.78, metal: 0.08, glow: 0.12 });
    const cMag = paint(P.magColor, { rough: 0.6, metal: 0.25 });
    const bull = P.layout === 'bullpup';
    const gripZ = bull ? -0.092 : 0.04;
    const magZ = bull ? 0.082 : -0.095;
    const rearZ = bull ? 0.268 : 0.08;
    const frontZ = -0.2;
    const gf = -0.195, ge = gf - P.guardLen;
    const gw = P.guardW ?? 0.054;

    // 리시버
    prof([[frontZ, 0.037], [rearZ - 0.006, 0.037], [rearZ, 0.02], [rearZ - 0.002, -0.012], [frontZ, -0.012]], 0.048, cUpper, g);
    if (bull) {
      prof([[-0.145, -0.012], [rearZ - 0.002, -0.012], [rearZ, -0.058], [rearZ - 0.03, -0.066], [0.04, -0.054], [-0.05, -0.05], [-0.14, -0.04]], 0.044, cLower, g, 0, 0, 0, 0.002);
      box(0.046, 0.082, 0.018, M.black, g, 0, -0.016, rearZ + 0.006);     // 개머리판
      box(0.0012, 0.006, 0.17, accent, g, -0.0226, -0.03, 0.14);
    } else {
      prof([[-0.125, -0.012], [0.058, -0.012], [0.062, -0.03], [0.04, -0.05], [-0.12, -0.05]], 0.042, cLower, g);
    }
    // 총열덮개
    prof([[ge, 0.03], [ge + 0.007, 0.036], [gf, 0.036], [gf, -0.024], [ge + 0.007, -0.024], [ge, -0.018]], gw, cGuard, g, 0, 0, 0, 0.003);
    const vents = Math.max(2, Math.floor((P.guardLen - 0.05) / 0.042));
    for (let i = 0; i < vents; i++) {
      for (const s of [1, -1]) box(0.0014, 0.014, 0.026, M.black, g, s * (gw / 2 + 0.0002), 0.012, gf - 0.03 - i * 0.042);
    }
    box(0.0012, 0.005, P.guardLen * 0.62, accent, g, -(gw / 2 + 0.0005), -0.01, gf - P.guardLen * 0.45);
    railTeeth(g, 0.04, ge + 0.006, rearZ - 0.012);
    // 총열·가스 블록·총구
    const by = 0.008;
    cyl(P.barrelR, P.barrelR, P.barrel + 0.02, M.gunmetal, g, 'z', 0, by, ge - P.barrel / 2 + 0.01);
    box(0.02, 0.026, 0.02, M.black, g, 0, by + 0.012, ge - 0.014);
    const mz = muzzleDevice(P.muzzle, g, by, ge - P.barrel + 0.006);
    // 개머리
    if (!bull && P.stock === 'fixed') {
      prof([[0.076, 0.03], [0.125, 0.03], [0.262, 0.012], [0.268, -0.056], [0.238, -0.062], [0.13, -0.022], [0.076, -0.016]], 0.04, cStock, g, 0, 0, 0, 0.003);
      box(0.044, 0.078, 0.02, M.black, g, 0, -0.022, 0.276);
    } else if (!bull && P.stock === 'skeleton') {
      prof([[0.076, 0.03], [0.255, 0.012], [0.262, -0.056], [0.232, -0.06], [0.076, -0.016]], 0.03, cStock, g, 0, 0, 0, 0.002,
        [[[0.112, 0.014], [0.226, 0.002], [0.232, -0.038], [0.112, -0.004]]]);
      box(0.036, 0.074, 0.016, M.black, g, 0, -0.022, 0.268);
    } else if (!bull && P.stock === 'tube') {
      cyl(0.0145, 0.0145, 0.17, M.black, g, 'z', 0, 0.012, 0.16);
      prof([[0.15, 0.036], [0.255, 0.03], [0.262, -0.054], [0.232, -0.058], [0.17, -0.012], [0.15, -0.006]], 0.036, cStock, g, 0, 0, 0, 0.003);
      box(0.03, 0.012, 0.09, accent, g, 0, 0.04, 0.205);                   // 뺨받침
      box(0.04, 0.07, 0.016, M.black, g, 0, -0.012, 0.268);
    }
    // 손잡이·방아쇠·장전 손잡이
    pistolGrip(g, -0.04, gripZ, M.black);
    triggerGroup(g, -0.05 + 0.012, gripZ - 0.026);
    box(0.02, 0.008, 0.02, M.gunmetal, g, 0, 0.04, bull ? -0.04 : 0.07);
    box(0.016, 0.012, 0.03, M.gray, g, 0.027, 0.018, -0.03);                // 탄피 배출구 덮개
    // 탄창
    const mag = new THREE.Group();
    mag.position.set(0, bull ? -0.05 : -0.048, magZ);
    g.add(mag);
    const ml = P.magLen ?? 1, c = P.magCurve ?? 0.05, mh = 0.13 * ml;
    prof([[-0.028, 0.006], [0.028, 0.006], [0.025 - c * 0.28, -mh * 0.48], [0.026 - c, -mh], [-0.03 - c, -mh * 0.93], [-0.033 - c * 0.3, -mh * 0.44]], 0.03, cMag, mag, 0, 0, 0, 0.002);
    prof([[0.029 - c, -mh + 0.001], [-0.033 - c, -mh * 0.93 + 0.001], [-0.034 - c, -mh * 0.93 - 0.009], [0.03 - c, -mh - 0.008]], 0.034, M.black, mag, 0, 0, 0, 0.001);
    box(0.0012, 0.012, 0.028, accent, mag, -0.0157, -mh * 0.5, -c * 0.45);
    parts.mag = mag;
    // 조준기
    let aimY, adsZ;
    if (P.optic === 'dot') { aimY = sightDot(g, 0.05, -0.08, accent); adsZ = -0.2; }
    else if (P.optic === 'lpvo') { aimY = sightScope(g, 0.083, -0.09, { r: 0.0148, len: 0.178, bell: 0.0205, eye: 0.018, ring: accent }); adsZ = -0.078; }
    else { aimY = sightHolo(g, 0.052, -0.1); adsZ = -0.2; }
    label(g, shortOf(P.id), 0.09, 0.022, -0.0247, 0.014, bull ? 0.1 : -0.06, '#e8ecf2');
    const muzzle = new THREE.Object3D();
    muzzle.position.set(0, by, mz - 0.004);
    g.add(muzzle);
    const armR = makeArm('R', [0, -0.09, gripZ + 0.012], [0, -0.089, 0.0275], [0.78, 0, 0.62], 0.0172);
    const armL = makeArm('L', [0, 0.006, ge + P.guardLen * 0.38], [0, 0, 1], [-0.32, -0.95, 0], 0.031);
    return {
      g, parts, muzzle,
      arms: { R: armR, L: armL },
      hip: P.hip ?? [0.14, -0.155, -0.31], hipRot: P.hipRot ?? [0, 0.03, 0],
      ads: [0, -aimY, adsZ],
      kick: P.kick ?? { z: 0.022, pitch: 0.035, roll: 0.012 }, flash: P.flash ?? 1,
    };
  }

  // ── 저격총 ──────────────────────────────────────────────────
  /** 앞이 넓어지는 닫힌 조준경(0.9에서 모형이 숨으니 뚫을 필요가 없다). 앞 끝·뒤 끝을 돌려준다 */
  function closedScope(parent, { r, len, bell, bellLen = 0.07, eye, eyeLen = 0.05, y = 0, z = 0, lens = M.lens, body = M.black }) {
    cyl(r, r, len, body, parent, 'z', 0, y, z);
    const fz = z - len / 2, bz = z + len / 2;
    cyl(r + 0.001, bell, bellLen, body, parent, 'z', 0, y, fz - bellLen / 2 + 0.006);
    cyl(eye, r + 0.003, eyeLen, body, parent, 'z', 0, y, bz + eyeLen / 2 - 0.006);
    cyl(bell - 0.002, bell - 0.002, 0.002, lens, parent, 'z', 0, y, fz - bellLen + 0.0055);
    cyl(eye - 0.002, eye - 0.002, 0.002, M.lensDark, parent, 'z', 0, y, bz + eyeLen - 0.0055);
    return { fz: fz - bellLen, bz: bz + eyeLen };
  }

  /**
   * @param {object} P
   *   id, body, accent, k(굵기 배율), w(리시버 폭), fore(앞덮개 길이), barrel, barrelR, brake('std'|'slim'|'huge'),
   *   stock('solid'|'thumb'|'heavy'), optic('std'|'twin'|'slim'|'huge'), mag{w,h,d}, bipod('folded'|'open'|null), hip·hipRot, kick, flash, scopeY
   */
  function buildSniper(P) {
    const g = new THREE.Group();
    const parts = {};
    const k = P.k ?? 1;
    const w = P.w ?? 0.046;
    const body = paint(P.body, { rough: 0.55, metal: 0.18 });
    const accent = paint(accentOf(P.id, P.accent ?? 0xf2c230), { rough: 0.5, metal: 0.05, glow: 0.2 });
    const gripTop = -0.022 * k;
    // 리시버·앞덮개
    prof([[-0.19, 0.03 * k], [0.072, 0.03 * k], [0.085, 0.012 * k], [0.08, gripTop], [-0.19, gripTop]], w, body, g, 0, 0, 0, 0.0025);
    const fe = -0.19 - P.fore;
    prof([[fe, 0.018 * k], [-0.19, 0.024 * k], [-0.19, -0.03 * k], [fe + 0.024, -0.03 * k], [fe, -0.016 * k]], w + 0.002, body, g, 0, 0, 0, 0.003);
    box(w + 0.004, 0.044 * k, 0.018, accent, g, 0, -0.003 * k, fe + 0.04);       // 앞쪽 색 띠
    box(0.03 * k, 0.01, 0.23, M.black, g, 0, 0.034 * k, -0.06);                   // 상부 레일
    // 총열·총구
    const by = 0.008 * k, R = P.barrelR;
    cyl(R * 1.28, R, P.barrel + 0.02, M.gunmetal, g, 'z', 0, by, fe - P.barrel / 2 + 0.01);
    if (P.fluted) for (const s of [1, -1]) box(0.0012, 0.003, P.barrel * 0.5, M.black, g, s * R * 1.08, by, fe - P.barrel * 0.28);
    let mz = fe - P.barrel;
    if (P.brake === 'huge') {
      const bm = paint(0x2a2d33, { rough: 0.45, metal: 0.7 });
      cyl(R * 1.5, R * 1.5, 0.05, M.gunmetal, g, 'z', 0, by, mz - 0.012);
      prof([[mz - 0.17, by + 0.03], [mz - 0.03, by + 0.03], [mz - 0.03, by - 0.03], [mz - 0.17, by - 0.03]], 0.05, bm, g, 0, 0, 0, 0.004,
        [[[mz - 0.09, by + 0.021], [mz - 0.05, by + 0.021], [mz - 0.05, by - 0.021], [mz - 0.09, by - 0.021]],
          [[mz - 0.152, by + 0.021], [mz - 0.106, by + 0.021], [mz - 0.106, by - 0.021], [mz - 0.152, by - 0.021]]]);
      cyl(R * 0.9, R * 0.9, 0.14, M.black, g, 'z', 0, by, mz - 0.1);
      mz -= 0.17;
    } else if (P.brake === 'slim') {
      cyl(R * 1.45, R * 1.3, 0.04, M.black, g, 'z', 0, by, mz - 0.018);
      mz -= 0.038;
    } else {
      cyl(R * 1.65, R * 1.65, 0.06, M.black, g, 'z', 0, by, mz - 0.028);
      box(0.038, 0.008, 0.012, M.black, g, 0, by, mz - 0.012);
      box(0.038, 0.008, 0.012, M.black, g, 0, by, mz - 0.034);
      mz -= 0.058;
    }
    // 개머리
    if (P.stock === 'thumb') {
      prof([[0.07, 0.028], [0.12, 0.03], [0.285, 0.016], [0.292, -0.062], [0.262, -0.068], [0.18, -0.06], [0.09, -0.112], [0.058, -0.112], [0.03, gripTop]], w * 0.66, body, g, 0, 0, 0, 0.002,
        [[[0.078, 0.008], [0.135, 0.008], [0.14, -0.05], [0.104, -0.078]], [[0.158, 0.012], [0.264, 0.002], [0.268, -0.046], [0.17, -0.044]]]);
      box(w * 0.7, 0.084, 0.012, M.black, g, 0, -0.024, 0.296);
    } else if (P.stock === 'heavy') {
      prof([[0.076, 0.034 * k], [0.15, 0.03 * k], [0.318, 0.022 * k], [0.328, -0.078 * k], [0.285, -0.086 * k], [0.21, -0.05 * k], [0.13, -0.04 * k], [0.076, -0.03 * k]], 0.052, body, g, 0, 0, 0, 0.004);
      box(0.04, 0.02, 0.15, accent, g, 0, 0.044 * k, 0.21);                       // 뺨받침
      box(0.058, 0.122, 0.03, M.black, g, 0, -0.03, 0.34);                        // 큰 완충 패드
      cyl(0.008, 0.008, 0.075, M.gunmetal, g, 'y', 0, -0.135, 0.25);              // 받침다리
      box(0.03, 0.008, 0.03, M.black, g, 0, -0.174, 0.25);
    } else {
      prof([[0.076, 0.024], [0.16, 0.02], [0.285, 0.012], [0.29, -0.062], [0.25, -0.068], [0.15, -0.03], [0.076, -0.026]], 0.042, body, g, 0, 0, 0, 0.003);
      box(0.03, 0.02, 0.12, accent, g, 0, 0.03, 0.16);                            // 뺨받침
      box(0.044, 0.086, 0.02, M.black, g, 0, -0.024, 0.298);
    }
    if (P.stock !== 'thumb') pistolGrip(g, gripTop + 0.004, 0.044, M.black, 0.03, 0.098);
    triggerGroup(g, gripTop - 0.006, 0.02);
    // 탄창
    const m = P.mag ?? { w: 0.034, h: 0.05, d: 0.075 };
    const mag = new THREE.Group();
    mag.position.set(0, gripTop, -0.09);
    g.add(mag);
    prof([[-m.d / 2, 0.004], [m.d / 2, 0.004], [m.d / 2 - 0.004, -m.h], [-m.d / 2 - 0.004, -m.h]], m.w, M.gunmetal, mag, 0, 0, 0, 0.002);
    box(m.w + 0.002, 0.008, m.d + 0.004, M.black, mag, 0, -m.h - 0.002, -0.002);
    box(0.0012, 0.01, m.d * 0.5, accent, mag, -(m.w / 2 + 0.0003), -m.h * 0.5, 0);
    parts.mag = mag;
    // 조준경
    const sy = P.scopeY ?? 0.072 * k;
    const scope = new THREE.Group();
    scope.position.set(0, sy, -0.07);
    g.add(scope);
    if (P.optic === 'twin') {
      // 2단 조준경: 큰 관 위에 작은 관을 얹고 앞뒤 고리로 묶었다. 옆의 드럼이 배율을 바꾼다
      closedScope(scope, { r: 0.0185, len: 0.25, bell: 0.03, eye: 0.023 });
      const up = paint(0x20242b, { rough: 0.5, metal: 0.5 });
      const amber = std(0xff9d2e, { rough: 0.12, metal: 0.5, glow: 0.5 });
      closedScope(scope, { r: 0.0108, len: 0.16, bell: 0.0165, bellLen: 0.04, eye: 0.0135, eyeLen: 0.03, y: 0.037, z: 0.012, lens: amber, body: up });
      box(0.024, 0.024, 0.02, up, scope, 0, 0.022, -0.05);
      box(0.024, 0.024, 0.02, up, scope, 0, 0.022, 0.07);
      const drum = new THREE.Group();
      drum.position.set(-0.024, 0.014, 0.01);
      scope.add(drum);
      cyl(0.016, 0.016, 0.018, accent, drum, 'x', 0, 0, 0);
      cyl(0.0125, 0.0125, 0.0035, M.black, drum, 'x', -0.0105, 0, 0);
      box(0.003, 0.004, 0.012, M.tritium, drum, -0.0125, 0, 0.0035);
      parts.stage = drum;
    } else if (P.optic === 'slim') {
      closedScope(scope, { r: 0.0122, len: 0.2, bell: 0.0185, bellLen: 0.05, eye: 0.0155, eyeLen: 0.036 });
      cyl(0.0125, 0.0125, 0.008, accent, scope, 'z', 0, 0, -0.06);
      cyl(0.0075, 0.0075, 0.016, M.gunmetal, scope, 'y', 0, 0.018, -0.005);
    } else if (P.optic === 'huge') {
      closedScope(scope, { r: 0.0235, len: 0.33, bell: 0.042, bellLen: 0.1, eye: 0.029, eyeLen: 0.06 });
      cyl(0.0245, 0.0245, 0.012, accent, scope, 'z', 0, 0, -0.1);
      cyl(0.014, 0.014, 0.038, M.gunmetal, scope, 'y', 0, 0.036, -0.012);
      cyl(0.014, 0.014, 0.038, M.gunmetal, scope, 'x', 0.036, 0, -0.012);
      cyl(0.044, 0.042, 0.05, M.black, scope, 'z', 0, 0, -0.33);                  // 긴 차광 후드
    } else {
      closedScope(scope, { r: 0.017, len: 0.26, bell: 0.027, eye: 0.022 });
      cyl(0.0178, 0.0178, 0.012, accent, scope, 'z', 0, 0, -0.1);
      cyl(0.011, 0.011, 0.028, M.gunmetal, scope, 'y', 0, 0.028, -0.01);
      cyl(0.011, 0.011, 0.028, M.gunmetal, scope, 'x', 0.028, 0, -0.01);
    }
    const mountH = sy - 0.034 * k;
    box(0.022, mountH, 0.022, M.gunmetal, g, 0, 0.034 * k + mountH / 2, -0.14);
    box(0.022, mountH, 0.022, M.gunmetal, g, 0, 0.034 * k + mountH / 2, 0);
    // 볼트 손잡이(오른쪽)
    const bolt = new THREE.Group();
    bolt.position.set(w / 2 + 0.001, 0.014 * k, 0.035);
    g.add(bolt);
    cyl(0.005, 0.005, 0.05, M.steel, bolt, 'x', 0.025, 0, 0);
    sphere(0.0095, M.black, bolt, 0.052, 0, 0);
    parts.bolt = bolt;
    // 양각대
    if (P.bipod === 'open') {
      const lz = fe + 0.03;
      box(0.03, 0.012, 0.03, M.black, g, 0, -0.036 * k, lz);
      for (const s of [1, -1]) {
        const leg = cyl(0.0058, 0.0058, 0.2, M.gunmetal, g, 'y', s * 0.032, -0.128 * k, lz - 0.012);
        leg.rotation.z = s * 0.3;
        leg.rotation.x = 0.12;
        box(0.018, 0.008, 0.028, M.black, g, s * 0.062, -0.228 * k, lz - 0.024);
      }
    } else if (P.bipod === 'folded') {
      cyl(0.004, 0.004, 0.16, M.gunmetal, g, 'z', 0.014, -0.036 * k, fe + 0.12);
      cyl(0.004, 0.004, 0.16, M.gunmetal, g, 'z', -0.014, -0.036 * k, fe + 0.12);
    }
    label(g, shortOf(P.id), 0.1, 0.026, -(w / 2 + 0.0006), 0.0, -0.05, '#f4f4ee');
    const muzzle = new THREE.Object3D();
    muzzle.position.set(0, by, mz - 0.004);
    g.add(muzzle);
    const gripR = P.stock === 'thumb' ? [0, -0.066, 0.058] : [0, gripTop - 0.05, 0.058];
    return {
      g, parts, muzzle,
      arms: {
        R: makeArm('R', gripR, [0, -0.092, 0.03], [0.78, 0, 0.62], 0.0172),
        L: makeArm('L', [0, -0.004 * k, fe + P.fore * 0.42], [0, 0, 1], [-0.3, -0.95, 0], 0.031 * Math.max(1, k * 0.92)),
      },
      hip: P.hip ?? [0.15, -0.165, -0.36], hipRot: P.hipRot ?? [0, 0.03, 0],
      ads: [0, -sy, P.adsZ ?? -0.3],             // 스코프 접안부가 눈앞으로(0.9 넘으면 숨김)
      kick: P.kick ?? { z: 0.075, pitch: 0.17, roll: 0.03 }, flash: P.flash ?? 1.5,
    };
  }

  // ── 지정사수 소총 MK-14 ─────────────────────────────────────
  /** 긴 총신·각진 몸통·타공 총열덮개·3배 조준경. 조준하면 조준경 통 안으로 들여다본다 */
  function buildDmMark() {
    const g = new THREE.Group();
    const parts = {};
    const id = 'dm_mark';
    const body = paint(0x3a3f33, { rough: 0.6, metal: 0.3 });
    const dark = paint(0x1e211c, { rough: 0.6, metal: 0.35 });
    const accent = paint(accentOf(id, 0x6fbf4a), { rough: 0.45, metal: 0.1, glow: 0.22 });
    prof([[-0.22, 0.04], [0.058, 0.04], [0.085, 0.018], [0.08, -0.02], [-0.02, -0.03], [-0.03, -0.05], [-0.14, -0.05], [-0.15, -0.024], [-0.22, -0.024]], 0.05, body, g, 0, 0, 0, 0.0025);
    // 긴 육각 총열덮개(구멍 뚫림)
    const gf = -0.215, ge = -0.54;
    const holes = [];
    for (let i = 0; i < 6; i++) {
      const z = gf - 0.035 - i * 0.046;
      holes.push([[z - 0.016, 0.006], [z, 0.018], [z + 0.016, 0.006], [z, -0.006]]);
    }
    prof([[ge, 0.024], [ge + 0.01, 0.034], [gf, 0.036], [gf, -0.026], [ge + 0.01, -0.024], [ge, -0.014]], 0.052, dark, g, 0, 0, 0, 0.004, holes);
    cyl(0.0105, 0.0105, 0.34, M.gunmetal, g, 'z', 0, 0.008, -0.38);                 // 총열덮개 속 총열(구멍으로 보인다)
    railTeeth(g, 0.043, ge + 0.012, 0.05);
    box(0.0012, 0.012, 0.16, accent, g, -0.0268, -0.012, -0.4);
    // 총열·총구
    cyl(0.0108, 0.0092, 0.18, M.gunmetal, g, 'z', 0, 0.008, ge - 0.085);
    const mz0 = ge - 0.17;
    prof([[mz0 - 0.08, 0.026], [mz0, 0.026], [mz0, -0.01], [mz0 - 0.08, -0.01]], 0.03, M.black, g, 0, 0, 0, 0.003,
      [[[mz0 - 0.034, 0.018], [mz0 - 0.012, 0.018], [mz0 - 0.012, -0.002], [mz0 - 0.034, -0.002]], [[mz0 - 0.068, 0.018], [mz0 - 0.046, 0.018], [mz0 - 0.046, -0.002], [mz0 - 0.068, -0.002]]]);
    // 개머리: 관 + 조절식 뺨받침 + 두꺼운 패드
    cyl(0.014, 0.014, 0.19, M.black, g, 'z', 0, 0.012, 0.17);
    prof([[0.13, 0.024], [0.268, 0.018], [0.276, -0.066], [0.24, -0.072], [0.16, -0.02], [0.13, -0.006]], 0.034, dark, g, 0, 0, 0, 0.003);
    prof([[0.1, 0.052], [0.23, 0.05], [0.23, 0.033], [0.1, 0.034]], 0.03, dark, g, 0, 0, 0, 0.003);
    box(0.0012, 0.006, 0.09, accent, g, -0.0156, 0.043, 0.165);
    cyl(0.004, 0.004, 0.03, M.gunmetal, g, 'y', 0.008, 0.028, 0.13);
    cyl(0.004, 0.004, 0.03, M.gunmetal, g, 'y', -0.008, 0.028, 0.13);
    box(0.04, 0.094, 0.018, M.black, g, 0, -0.024, 0.285);
    pistolGrip(g, -0.02, 0.046, M.black);
    triggerGroup(g, -0.034, 0.018);
    box(0.016, 0.014, 0.03, M.gray, g, 0.0265, 0.018, -0.04);
    // 넓은 상자 탄창(15발)
    const mag = new THREE.Group();
    mag.position.set(0, -0.05, -0.085);
    g.add(mag);
    prof([[-0.042, 0.006], [0.042, 0.006], [0.03, -0.102], [-0.05, -0.098]], 0.03, dark, mag, 0, 0, 0, 0.002);
    box(0.033, 0.009, 0.086, M.black, mag, 0, -0.104, -0.01).rotation.x = 0.05;
    box(0.0012, 0.01, 0.042, accent, mag, -0.0157, -0.05, -0.006);
    parts.mag = mag;
    const aimY = sightScope(g, 0.086, -0.105, { r: 0.0172, len: 0.2, bell: 0.0255, eye: 0.021, ring: accent });
    label(g, shortOf(id), 0.11, 0.025, -0.0257, 0.01, -0.09, '#eef2e4');
    const muzzle = new THREE.Object3D();
    muzzle.position.set(0, 0.008, mz0 - 0.084);
    g.add(muzzle);
    return {
      g, parts, muzzle,
      arms: {
        R: makeArm('R', [0, -0.07, 0.058], [0, -0.09, 0.0275], [0.78, 0, 0.62], 0.0172),
        L: makeArm('L', [0, 0.004, -0.42], [0, 0, 1], [-0.3, -0.95, 0], 0.031),
      },
      hip: [0.15, -0.165, -0.35], hipRot: [0, 0.03, 0],
      ads: [0, -aimY, -0.085],
      kick: { z: 0.045, pitch: 0.09, roll: 0.018 }, flash: 1.2,
    };
  }

  // ── 기관단총 VX-3 ───────────────────────────────────────────
  function buildSmVx3() {
    const g = new THREE.Group();
    const parts = {};
    const id = 'sm_vx3';
    const body = paint(0x20262b, { rough: 0.52, metal: 0.35 });
    const shell = paint(0x2f3a3d, { rough: 0.62, metal: 0.15 });
    const accent = paint(accentOf(id, 0x18c98a), { rough: 0.42, metal: 0.1, glow: 0.3 });
    prof([[-0.125, 0.034], [0.062, 0.034], [0.074, 0.016], [0.07, -0.022], [-0.125, -0.022]], 0.042, body, g, 0, 0, 0, 0.0025);
    prof([[-0.225, 0.024], [-0.125, 0.03], [-0.125, -0.02], [-0.205, -0.02], [-0.225, -0.008]], 0.04, shell, g, 0, 0, 0, 0.003,
      [[[-0.205, 0.016], [-0.14, 0.02], [-0.14, 0.008], [-0.205, 0.006]]]);
    box(0.0012, 0.006, 0.09, accent, g, -0.0207, -0.008, -0.17);
    railTeeth(g, 0.037, -0.205, 0.05, 0.02);
    // 짧은 총열·소음 덮개
    cyl(0.0088, 0.0088, 0.04, M.gunmetal, g, 'z', 0, 0.006, -0.24);
    cyl(0.0135, 0.0135, 0.04, M.black, g, 'z', 0, 0.006, -0.272);
    // 긴 곧은 탄창
    const mag = new THREE.Group();
    mag.position.set(0, -0.022, -0.05);
    g.add(mag);
    prof([[-0.019, 0.004], [0.019, 0.004], [0.022, -0.158], [-0.016, -0.166]], 0.024, M.gunmetal, mag, 0, 0, 0, 0.002);
    box(0.027, 0.008, 0.042, M.black, mag, 0, -0.166, 0.002).rotation.x = -0.1;
    box(0.0012, 0.01, 0.018, accent, mag, -0.0127, -0.08, 0.002);
    parts.mag = mag;
    pistolGrip(g, -0.018, 0.034, M.black, 0.028);
    triggerGroup(g, -0.026, 0.008);
    // 앞 손잡이
    prof([[-0.188, -0.018], [-0.148, -0.018], [-0.14, -0.092], [-0.176, -0.096]], 0.024, shell, g, 0, 0, 0, 0.003);
    // 철사 개머리(펼친 상태)
    for (const s of [1, -1]) cyl(0.0042, 0.0042, 0.21, M.gray, g, 'z', s * 0.016, 0.004, 0.172);
    cyl(0.0042, 0.0042, 0.1, M.gray, g, 'y', 0.016, -0.038, 0.276);
    cyl(0.0042, 0.0042, 0.1, M.gray, g, 'y', -0.016, -0.038, 0.276);
    box(0.038, 0.012, 0.012, M.black, g, 0, -0.09, 0.276);
    box(0.038, 0.012, 0.012, M.black, g, 0, 0.006, 0.276);
    box(0.012, 0.012, 0.03, M.gray, g, 0.024, 0.016, -0.04);
    const aimY = sightDot(g, 0.046, -0.06, accent);
    label(g, shortOf(id), 0.08, 0.02, -0.0216, 0.008, -0.03, '#d8fff0');
    const muzzle = new THREE.Object3D();
    muzzle.position.set(0, 0.006, -0.294);
    g.add(muzzle);
    return {
      g, parts, muzzle,
      arms: {
        R: makeArm('R', [0, -0.066, 0.046], [0, -0.09, 0.0275], [0.78, 0, 0.62], 0.0165),
        L: makeArm('L', [0, -0.058, -0.162], [0.02, -1, 0.14], [-0.72, 0, 0.7], 0.0165),
      },
      hip: [0.125, -0.142, -0.29], hipRot: [0.02, 0.05, -0.04],
      ads: [0, -aimY, -0.18],
      kick: { z: 0.012, pitch: 0.022, roll: 0.01 }, flash: 0.7,
    };
  }

  // ── 산탄총 BX-12 ────────────────────────────────────────────
  /** 펌프 연사 산탄총. 앞 손잡이(parts.pump)가 왼손과 함께 앞뒤로 움직인다 */
  function buildSgBx12() {
    const g = new THREE.Group();
    const parts = {};
    const id = 'sg_bx12';
    const body = paint(0x1f2124, { rough: 0.48, metal: 0.55 });
    const wood = paint(0x3a2f26, { rough: 0.72, metal: 0.05, glow: 0.14 });
    const accent = paint(accentOf(id, 0xd9a441), { rough: 0.45, metal: 0.3, glow: 0.24 });
    prof([[-0.145, 0.034], [0.05, 0.034], [0.066, 0.012], [0.056, -0.03], [-0.145, -0.03]], 0.046, body, g, 0, 0, 0, 0.0025);
    box(0.03, 0.012, 0.13, M.gunmetal, g, 0.0165, 0.012, -0.05);                     // 탄 배출구
    // 굵은 총열·탄창 관
    cyl(0.0135, 0.0125, 0.42, M.gunmetal, g, 'z', 0, 0.018, -0.35);
    cyl(0.0132, 0.0132, 0.32, M.black, g, 'z', 0, -0.012, -0.3);
    cyl(0.0142, 0.0142, 0.024, M.gray, g, 'z', 0, -0.012, -0.468);
    box(0.012, 0.028, 0.014, M.black, g, 0, 0.003, -0.46);                           // 관 묶음
    // 문 부수기용 톱니 총구
    const mz = -0.56;
    cyl(0.0185, 0.017, 0.03, M.black, g, 'z', 0, 0.018, mz);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const t = box(0.009, 0.009, 0.024, M.gray, g, Math.cos(a) * 0.0155, 0.018 + Math.sin(a) * 0.0155, mz - 0.024);
      t.rotation.z = a;
    }
    // 가늠쇠·가늠자
    box(0.004, 0.018, 0.012, accent, g, 0, 0.04, -0.54);
    box(0.003, 0.004, 0.003, M.tritium, g, 0, 0.0505, -0.54);
    torus(0.009, 0.0022, M.black, g, 0, 0.056, -0.02);
    box(0.022, 0.018, 0.008, M.black, g, 0, 0.042, -0.02);
    // 왼쪽 면 여분 탄(색 표식)
    const shellMat = paint(0xc23a2b, { rough: 0.55, metal: 0.05, glow: 0.2 });
    for (let i = 0; i < 4; i++) {
      cyl(0.0078, 0.0078, 0.04, shellMat, g, 'y', -0.031, 0.002, -0.118 + i * 0.0185);
      cyl(0.0082, 0.0082, 0.009, M.brass, g, 'y', -0.031, -0.02, -0.118 + i * 0.0185);
    }
    box(0.004, 0.03, 0.082, M.black, g, -0.0245, 0.002, -0.09);
    // 짧은 개머리·손잡이
    pistolGrip(g, -0.026, 0.034, wood, 0.03);
    triggerGroup(g, -0.036, 0.008);
    prof([[0.056, 0.022], [0.1, 0.022], [0.222, 0.006], [0.228, -0.066], [0.198, -0.072], [0.098, -0.03], [0.056, -0.026]], 0.038, wood, g, 0, 0, 0, 0.003);
    box(0.042, 0.082, 0.02, M.black, g, 0, -0.03, 0.236);
    // 펌프 앞 손잡이
    const pump = new THREE.Group();
    pump.position.set(0, -0.012, -0.325);
    g.add(pump);
    prof([[-0.066, 0.016], [0.066, 0.016], [0.066, -0.016], [-0.066, -0.016]], 0.05, wood, pump, 0, 0, 0, 0.004);
    for (let i = 0; i < 7; i++) {
      for (const s of [1, -1]) box(0.0014, 0.022, 0.0048, M.black, pump, s * 0.0252, -0.002, -0.052 + i * 0.0175);
    }
    parts.pump = pump;
    label(g, shortOf(id), 0.1, 0.024, -0.0236, 0.018, 0.02, '#f2e2bc');
    const muzzle = new THREE.Object3D();
    muzzle.position.set(0, 0.018, mz - 0.038);
    g.add(muzzle);
    // 재장전 때 왼손이 넣는 탄
    const shell = new THREE.Group();
    g.add(shell);
    cyl(0.0078, 0.0078, 0.05, shellMat, shell, 'z', 0, 0, 0);
    cyl(0.0082, 0.0082, 0.01, M.brass, shell, 'z', 0, 0, 0.026);
    shell.userData.hiddenIdle = true;
    parts.shell = shell;
    return {
      g, parts, muzzle,
      arms: {
        R: makeArm('R', [0, -0.076, 0.046], [0, -0.09, 0.0275], [0.78, 0, 0.62], 0.0172),
        L: makeArm('L', [0, -0.012, -0.325], [0, 0, 1], [-0.3, -0.95, 0], 0.027),
      },
      hip: [0.145, -0.16, -0.32], hipRot: [0, 0.03, 0],
      ads: null,
      kick: { z: 0.07, pitch: 0.16, roll: 0.03 }, flash: 1.5,
      reloadFn: shellReload,
      pumpTime: 0.62,
    };
  }

  // ── 권총 P-9 ────────────────────────────────────────────────
  function buildPtStd() {
    const g = new THREE.Group();
    const parts = {};
    const accent = paint(accentOf('pt_std', 0x9aa5b1), { rough: 0.45, metal: 0.4, glow: 0.12 });
    const slide = new THREE.Group();
    slide.position.set(0, 0.032, -0.07);
    g.add(slide);
    prof([[-0.095, 0.012], [-0.08, 0.016], [0.095, 0.016], [0.095, -0.016], [-0.095, -0.016]], 0.03, M.gray, slide, 0, 0, 0, 0.0018);
    for (let i = 0; i < 5; i++) for (const s of [1, -1]) box(0.002, 0.022, 0.0042, M.black, slide, s * 0.0152, 0, 0.056 + i * 0.0085);
    box(0.012, 0.006, 0.044, M.black, slide, 0.0132, 0.008, -0.01);          // 배출구
    box(0.022, 0.009, 0.008, M.black, slide, 0, 0.02, 0.085);
    box(0.005, 0.009, 0.006, M.black, slide, 0, 0.02, -0.088);
    box(0.003, 0.003, 0.002, M.tritium, slide, 0, 0.022, -0.0915);
    box(0.003, 0.003, 0.002, M.tritium, slide, -0.007, 0.022, 0.0895);
    box(0.003, 0.003, 0.002, M.tritium, slide, 0.007, 0.022, 0.0895);
    cyl(0.0065, 0.0065, 0.012, M.black, slide, 'z', 0, 0.002, -0.098);
    label(slide, 'P-9', 0.07, 0.016, -0.0156, 0.002, -0.02, '#f2f4f7');
    parts.slide = slide;
    prof([[-0.146, 0.01], [0.025, 0.018], [0.03, -0.012], [-0.04, -0.016], [-0.146, -0.008]], 0.028, M.black, g, 0, 0, 0, 0.002);
    prof([[-0.022, -0.012], [0.024, -0.012], [0.052, -0.092], [0.012, -0.102]], 0.03, M.black, g, 0, 0, 0, 0.003);
    prof([[-0.012, -0.02], [0.02, -0.02], [0.045, -0.086], [0.012, -0.094]], 0.0312, accent, g, 0, 0, 0, 0.0006);   // 손잡이 패널
    triggerGroup(g, -0.002, -0.036);
    const mag = new THREE.Group();
    g.add(mag);
    prof([[-0.008, -0.05], [0.03, -0.05], [0.058, -0.105], [0.022, -0.113]], 0.022, M.gunmetal, mag, 0, 0, 0, 0.001);
    prof([[0.016, -0.102], [0.06, -0.094], [0.064, -0.106], [0.018, -0.116]], 0.028, M.gray, mag, 0, 0, 0, 0.001);
    parts.mag = mag;
    const muzzle = new THREE.Object3D();
    muzzle.position.set(0, 0.034, -0.172);
    g.add(muzzle);
    return {
      g, parts, muzzle,
      arms: {
        R: makeArm('R', [0, -0.056, 0.02], [0, -0.088, 0.03], [0.78, 0, 0.62], 0.0172),
        L: makeArm('L', [-0.006, -0.075, 0.012], [0.1, -0.085, 0.03], [-0.76, -0.14, 0.62], 0.0195),
      },
      hip: [0.122, -0.098, -0.325], hipRot: [0.02, 0.15, -0.05],    // 슬라이드 왼쪽 면(P-9 표기)이 보이게
      ads: null,
      kick: { z: 0.035, pitch: 0.12, roll: 0.02 }, flash: 0.75,
    };
  }

  // ── 매그넘 M-44 ─────────────────────────────────────────────
  /** 긴 총열의 6연발 회전식. 쏠 때마다 약실 뭉치가 돌고 공이치기가 튄다 */
  function buildPtMagnum() {
    const g = new THREE.Group();
    const parts = {};
    const id = 'pt_magnum';
    const frame = paint(0x8d939b, { rough: 0.3, metal: 0.9, glow: 0.03 });
    const wood = paint(0x5f3a20, { rough: 0.62, metal: 0.05, glow: 0.14 });
    const accent = paint(accentOf(id, 0xb5651d), { rough: 0.4, metal: 0.5, glow: 0.2 });
    prof([[-0.082, 0.041], [0.036, 0.041], [0.054, 0.024], [0.05, -0.012], [0.012, -0.018], [-0.018, -0.018], [-0.032, -0.006], [-0.082, -0.006]], 0.024, frame, g, 0, 0, 0, 0.0016,
      [[[-0.06, 0.033], [0.0, 0.033], [0.0, -0.006], [-0.06, -0.006]]]);
    // 긴 총열 + 위쪽 리브 + 아래 무게 덮개
    cyl(0.0098, 0.0098, 0.17, frame, g, 'z', 0, 0.018, -0.165);
    box(0.012, 0.009, 0.165, M.gray, g, 0, 0.031, -0.164);
    for (let i = 0; i < 4; i++) box(0.0125, 0.0025, 0.022, M.black, g, 0, 0.0355, -0.112 - i * 0.033);
    prof([[-0.252, 0.008], [-0.082, 0.008], [-0.082, -0.012], [-0.242, -0.012]], 0.016, frame, g, 0, 0, 0, 0.0012);
    prof([[-0.246, 0.046], [-0.232, 0.046], [-0.226, 0.034], [-0.246, 0.034]], 0.005, accent, g);     // 가늠쇠
    box(0.003, 0.004, 0.003, M.tritium, g, 0, 0.0475, -0.24);
    box(0.016, 0.006, 0.014, M.black, g, 0, 0.044, 0.026);                                              // 가늠자
    cyl(0.0102, 0.0102, 0.006, M.black, g, 'z', 0, 0.018, -0.252);
    // 약실 뭉치
    const cyln = new THREE.Group();
    cyln.position.set(0, 0.0135, -0.03);
    g.add(cyln);
    cyl(0.0225, 0.0225, 0.056, M.gray, cyln, 'z', 0, 0, 0, 18);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
      cyl(0.0052, 0.0052, 0.034, M.black, cyln, 'z', Math.cos(a) * 0.0222, Math.sin(a) * 0.0222, -0.009, 8);    // 바깥 홈
      const b = a + Math.PI / 6;
      cyl(0.0052, 0.0052, 0.0014, M.black, cyln, 'z', Math.cos(b) * 0.0135, Math.sin(b) * 0.0135, 0.0284, 8);    // 뒤쪽 약실 구멍
      cyl(0.0052, 0.0052, 0.0014, M.black, cyln, 'z', Math.cos(b) * 0.0135, Math.sin(b) * 0.0135, -0.0284, 8);
    }
    cyl(0.005, 0.005, 0.06, M.gunmetal, cyln, 'z', 0, 0, 0, 8);
    parts.cylinder = cyln;
    // 공이치기
    const hammer = new THREE.Group();
    hammer.position.set(0, 0.024, 0.044);
    g.add(hammer);
    prof([[-0.006, 0.0], [0.008, 0.0], [0.022, 0.03], [0.014, 0.034], [0.002, 0.018]], 0.007, M.gunmetal, hammer);
    parts.hammer = hammer;
    // 나무 손잡이·금속 끝
    prof([[0.008, -0.01], [0.05, -0.008], [0.09, -0.086], [0.082, -0.104], [0.046, -0.108], [0.03, -0.06]], 0.032, wood, g, 0, 0, 0, 0.004);
    prof([[0.046, -0.104], [0.082, -0.1], [0.088, -0.11], [0.046, -0.114]], 0.03, frame, g, 0, 0, 0, 0.001);
    cyl(0.0065, 0.0065, 0.0345, accent, g, 'x', 0, -0.05, 0.05);                  // 손잡이 메달
    const guard = torus(0.018, 0.0024, M.gunmetal, g, 0, -0.03, -0.006);
    guard.rotation.y = Math.PI / 2;
    guard.scale.set(1.08, 0.9, 1);
    prof([[-0.008, -0.016], [-0.002, -0.016], [-0.004, -0.034], [-0.009, -0.032]], 0.004, M.steel, g);
    label(g, shortOf(id), 0.05, 0.012, -0.0128, -0.0, 0.03, '#3a2a18', 'rgba(255,255,255,0.15)');
    const muzzle = new THREE.Object3D();
    muzzle.position.set(0, 0.018, -0.258);
    g.add(muzzle);
    return {
      g, parts, muzzle,
      arms: {
        R: makeArm('R', [0, -0.054, 0.05], [0, -0.075, 0.042], [0.8, 0, 0.6], 0.0178),
        L: makeArm('L', [-0.006, -0.082, 0.04], [0.1, -0.07, 0.042], [-0.76, -0.14, 0.62], 0.0205),
      },
      hip: [0.128, -0.104, -0.345], hipRot: [0.02, 0.14, -0.05],
      ads: null,
      kick: { z: 0.055, pitch: 0.3, roll: 0.03 }, flash: 1.1,
      reloadFn: cylinderReload,
    };
  }

  // ── 모형 등록 ───────────────────────────────────────────────
  const BUILDERS = {
    ar_std: () => buildRifle({
      id: 'ar_std', upper: 0x1b1d20, lower: 0x24272b, guard: 0x30343a, stockColor: 0x202226, magColor: 0x2b2d31,
      guardLen: 0.23, barrel: 0.165, barrelR: 0.0095, muzzle: 'flash', magLen: 1, magCurve: 0.05, stock: 'fixed', optic: 'holo',
      kick: { z: 0.022, pitch: 0.035, roll: 0.012 }, flash: 1,
    }),
    ar_rapid: () => buildRifle({
      id: 'ar_rapid', upper: 0x1d1e20, lower: 0x26272a, guard: 0x7d6f52, stockColor: 0x6d6147, magColor: 0x2d2d2b,
      guardLen: 0.165, barrel: 0.085, barrelR: 0.0098, muzzle: 'comp', magLen: 1.24, magCurve: 0.07, stock: 'skeleton', optic: 'dot',
      hip: [0.135, -0.15, -0.3], kick: { z: 0.018, pitch: 0.05, roll: 0.02 }, flash: 0.9,
    }),
    ar_line: () => buildRifle({
      id: 'ar_line', upper: 0xa7aeb6, lower: 0x8f969e, guard: 0xc4cad0, stockColor: 0xb4bac1, magColor: 0x3a3f45,
      guardLen: 0.3, barrel: 0.235, barrelR: 0.0078, guardW: 0.046, muzzle: 'long', magLen: 0.86, magCurve: 0.02, stock: 'tube', optic: 'lpvo',
      hip: [0.15, -0.16, -0.34], kick: { z: 0.011, pitch: 0.016, roll: 0.005 }, flash: 0.85,
    }),
    ar_burst: () => buildRifle({
      id: 'ar_burst', upper: 0x2b2736, lower: 0x363044, guard: 0x3f3852, stockColor: 0x2b2736, magColor: 0x25222e,
      guardLen: 0.145, barrel: 0.115, barrelR: 0.0098, muzzle: 'triple', magLen: 0.96, magCurve: 0.035, optic: 'holo', layout: 'bullpup',
      hip: [0.14, -0.15, -0.34], kick: { z: 0.02, pitch: 0.03, roll: 0.01 }, flash: 0.95,
    }),
    dm_mark: buildDmMark,
    sm_vx3: buildSmVx3,
    sg_bx12: buildSgBx12,
    sr_bolt: () => buildSniper({
      id: 'sr_bolt', body: 0x1f3557, fore: 0.27, barrel: 0.5, barrelR: 0.0105, brake: 'std', stock: 'solid', optic: 'std', bipod: 'folded',
    }),
    sr_twin: () => buildSniper({
      id: 'sr_twin', body: 0x28303c, fore: 0.3, barrel: 0.52, barrelR: 0.011, brake: 'std', stock: 'solid', optic: 'twin', scopeY: 0.074,
      mag: { w: 0.034, h: 0.056, d: 0.08 }, bipod: 'folded', kick: { z: 0.08, pitch: 0.18, roll: 0.03 },
    }),
    sr_swift: () => buildSniper({
      id: 'sr_swift', body: 0x8c98a4, k: 0.84, w: 0.034, fore: 0.25, barrel: 0.46, barrelR: 0.0072, fluted: true, brake: 'slim', stock: 'thumb', optic: 'slim', scopeY: 0.056,
      mag: { w: 0.024, h: 0.05, d: 0.062 }, bipod: null, hip: [0.145, -0.155, -0.34], kick: { z: 0.05, pitch: 0.11, roll: 0.02 }, flash: 1.15,
    }),
    sr_heavy: () => buildSniper({
      id: 'sr_heavy', body: 0x3b4149, k: 1.32, w: 0.062, fore: 0.36, barrel: 0.54, barrelR: 0.0165, brake: 'huge', stock: 'heavy', optic: 'huge', scopeY: 0.098,
      mag: { w: 0.05, h: 0.092, d: 0.112 }, bipod: 'open', hip: [0.185, -0.205, -0.45], adsZ: -0.38, kick: { z: 0.12, pitch: 0.26, roll: 0.05 }, flash: 2.2,
    }),
    pt_std: buildPtStd,
    pt_magnum: buildPtMagnum,
    ml_knife: buildMlKnife,
    ml_tanto: buildMlTanto,
    ml_gurkha: buildMlGurkha,
    ml_katana: buildMlKatana,
    gr_frag: buildGrFrag,
  };
  /** 알 수 없는 id도 던지지 않고 비슷한 모형으로 그린다 */
  function builderIdFor(id) {
    if (typeof id === 'string' && has(BUILDERS, id)) return id;
    const d = typeof id === 'string' ? getDef(id) : null;
    return (d && KIND_FALLBACK[d.kind]) || 'ar_std';
  }
  const models = Object.create(null);

  /** 움직이지 않는 메시를 재질별로 합쳐 draw call을 줄인다 */
  function bake(rootObj, skip) {
    rootObj.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(rootObj.matrixWorld).invert();
    const groups = new Map();
    (function walk(o) {
      for (const c of o.children) {
        if (skip.has(c) || c.userData.noBake) continue;
        if (c.isMesh) {
          if (!c.geometry.attributes.uv) continue;
          const key = `${c.material.uuid}|${c.userData.vmOrder || 0}`;
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(c);
        } else walk(c);
      }
    })(rootObj);
    for (const list of groups.values()) {
      if (list.length < 2) continue;
      const items = list.map((m) => ({ geo: m.geometry, matrix: new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld) }));
      const merged = mergeGeos(items);
      for (const m of list) { m.removeFromParent(); owned.geos.delete(m.geometry); m.geometry.dispose(); }
      add(merged, list[0].material, rootObj, 0, 0, 0, list[0].userData.vmOrder || 0);
    }
  }

  function finalize(model) {
    const partList = Object.values(model.parts);
    const skip = new Set(partList);
    bake(model.g, skip);
    for (const p of partList) if (p.isGroup) bake(p, skip);
    for (const a of [model.arms.R, model.arms.L]) if (a) model.g.add(a);
    model.g.traverse((o) => {
      o.layers.set(VIEWMODEL_LAYER);
      if (o.isMesh) {
        o.renderOrder = RO + (o.userData.vmOrder || 0);
        o.frustumCulled = false;
        o.castShadow = false;
        o.receiveShadow = false;
      }
    });
    for (const p of partList) {
      p.userData.base = { pos: p.position.clone(), rot: p.rotation.clone() };
      p.visible = !p.userData.hiddenIdle;
    }
    model.g.visible = false;
    pose.add(model.g);
    return model;
  }

  function ensureModel(id) {
    const key = builderIdFor(id);
    if (!models[key]) {
      const m = BUILDERS[key]();
      m.id = key;
      m.def = getDef(key) || {};
      models[key] = finalize(m);
    }
    return models[key];
  }

  function resetParts(m) {
    if (!m) return;
    for (const k of Object.keys(m.parts)) {
      const p = m.parts[k];
      const b = p.userData.base;
      if (b) { p.position.copy(b.pos); p.rotation.copy(b.rot); }
      p.visible = !p.userData.hiddenIdle;
    }
    for (const a of [m.arms.R, m.arms.L]) {
      if (!a) continue;
      a.position.copy(a.userData.base);
      a.visible = !a.userData.hiddenIdle;
    }
  }

  // ── 깊이 지우기 센티넬 ─────────────────────────────────────
  // 투명 목록에서 가장 먼저 그려져 깊이를 지운다 → 뒤이어 그려지는 무기 모형은 벽에 파묻히지 않는다.
  const sentinelMat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, depthTest: false, transparent: true });
  owned.mats.add(sentinelMat);
  const sentinel = add(new THREE.PlaneGeometry(1e-4, 1e-4), sentinelMat, root, 0, 0, -0.5);
  sentinel.renderOrder = RO - 1;
  sentinel.frustumCulled = false;
  sentinel.layers.set(VIEWMODEL_LAYER);
  let clearDepth = opts.clearDepth !== false;
  sentinel.onBeforeRender = (renderer, scene, cam) => {
    if (!clearDepth || cam !== camera || !renderer) return;
    if (renderer.state && renderer.state.buffers) renderer.state.buffers.depth.setMask(true);
    renderer.clearDepth();
  };

  // ── 총구 섬광(내장) ───────────────────────────────────────
  let flash = null;
  if (useFlash) {
    const tex = canvasTexture(128, 128, (c, w, h) => {
      c.clearRect(0, 0, w, h);
      c.translate(w / 2, h / 2);
      const gr = c.createRadialGradient(0, 0, 0, 0, 0, w / 2);
      gr.addColorStop(0, 'rgba(255,252,230,1)');
      gr.addColorStop(0.3, 'rgba(255,205,100,0.9)');
      gr.addColorStop(1, 'rgba(255,120,20,0)');
      c.fillStyle = gr;
      c.beginPath();
      for (let i = 0; i < 14; i++) {
        const r = i % 2 ? w * 0.16 : w * 0.5;
        const a = (i / 14) * Math.PI * 2;
        c.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      c.closePath();
      c.fill();
    });
    const fm = new THREE.MeshBasicMaterial({ map: tex, color: tex ? 0xffffff : 0xffc060, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, fog: false, toneMapped: false, side: THREE.DoubleSide, opacity: tex ? 1 : 0.6 });
    owned.mats.add(fm);
    const fg = new THREE.Group();
    const front = add(new THREE.PlaneGeometry(0.11, 0.11), fm, fg, 0, 0, -0.01, 5);
    const sideA = add(new THREE.PlaneGeometry(0.07, 0.2), fm, fg, 0, 0, -0.09, 5);
    sideA.rotation.set(-Math.PI / 2, 0, 0);
    const sideB = add(new THREE.PlaneGeometry(0.07, 0.2), fm, fg, 0, 0, -0.09, 5);
    sideB.rotation.set(-Math.PI / 2, Math.PI / 2, 0);
    fg.traverse((o) => { o.layers.set(VIEWMODEL_LAYER); if (o.isMesh) { o.renderOrder = RO + 5; o.frustumCulled = false; } });
    fg.visible = false;
    flash = { g: fg, front, t: 0 };
  }

  // ── 휘두르기 궤적(리본) ─────────────────────────────────────
  // 칼끝과 도신 중간점을 기록해 그 사이를 띠로 잇는다. 뒤로 갈수록 투명해지고 폭이 좁아져 초승달처럼 사라진다.
  // 메시 2개를 돌려 쓰고 정점 버퍼를 다시 만들지 않는다. 궤적이 없으면 그리지 않는다.
  const TRAIL_MAX = 30, TRAIL_SUB = 3, TRAIL_LIFE = 0.17;
  const trailMat = new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false, toneMapped: false });
  owned.mats.add(trailMat);
  function makeTrail() {
    const segs = (TRAIL_MAX - 1) * TRAIL_SUB, rows = segs + 1;
    const pos = new Float32Array(rows * 3 * 3), col = new Float32Array(rows * 3 * 4), idx = new Uint16Array(segs * 2 * 6);
    for (let i = 0, k = 0; i < segs; i++) {
      for (let j = 0; j < 2; j++) {
        const a = i * 3 + j, b = a + 1, c = a + 3, d = a + 4;
        idx[k++] = a; idx[k++] = c; idx[k++] = b; idx[k++] = b; idx[k++] = c; idx[k++] = d;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 4).setUsage(THREE.DynamicDrawUsage));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    const mesh = add(geo, trailMat, root, 0, 0, 0, 4);
    mesh.renderOrder = RO + 4;
    mesh.frustumCulled = false;
    mesh.layers.set(VIEWMODEL_LAYER);
    mesh.visible = false;
    return { mesh, geo, s: new Float32Array(TRAIL_MAX * 7), n: 0, last: -1, gain: 1 };
  }
  const trails = [makeTrail(), makeTrail()];
  let trailNow = null;
  function trailBegin(gain, color) {
    trailNow = trails[0].n <= trails[1].n ? trails[0] : trails[1];
    trailNow.n = 0;
    trailNow.last = -1;
    trailNow.gain = gain;
    trailMat.color.setHex(color);
  }
  function trailEnd() { trailNow = null; }
  function trailClear() { trailNow = null; for (const t of trails) { t.n = 0; t.mesh.visible = false; } }
  function trailPush(tr, tip, base, now) {
    let i;
    if (tr.n > 0 && now - tr.last < 1 / 90) i = tr.n - 1;                 // 너무 촘촘하면 마지막 점만 고친다
    else {
      if (tr.n === TRAIL_MAX) { tr.s.copyWithin(0, 7); tr.n--; }
      i = tr.n++;
      tr.last = now;
      tr.s[i * 7 + 6] = now;
    }
    tr.s[i * 7] = tip.x; tr.s[i * 7 + 1] = tip.y; tr.s[i * 7 + 2] = tip.z;
    tr.s[i * 7 + 3] = base.x; tr.s[i * 7 + 4] = base.y; tr.s[i * 7 + 5] = base.z;
  }
  const catmull = (p0, p1, p2, p3, t) => {
    const t2 = t * t, t3 = t2 * t;
    return 0.5 * (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (3 * p1 - p0 - 3 * p2 + p3) * t3);
  };
  function trailBuild(tr, now) {
    const s = tr.s;
    let drop = 0;
    while (drop < tr.n && now - s[drop * 7 + 6] > TRAIL_LIFE) drop++;
    if (drop) { s.copyWithin(0, drop * 7, tr.n * 7); tr.n -= drop; }
    if (tr.n < 2) { tr.mesh.visible = false; return; }
    const P = tr.geo.attributes.position.array, C = tr.geo.attributes.color.array;
    const n = tr.n, rows = (n - 1) * TRAIL_SUB + 1;
    for (let r = 0; r < rows; r++) {
      const fi = r / TRAIL_SUB, i = Math.min(Math.floor(fi), n - 2), t = fi - i;
      const a = Math.max(i - 1, 0) * 7, b = i * 7, c = (i + 1) * 7, d = Math.min(i + 2, n - 1) * 7;
      const age = clamp((now - lerp(s[b + 6], s[c + 6], t)) / TRAIL_LIFE, 0, 1);
      const alpha = Math.pow(1 - age, 1.5) * tr.gain * smooth(0, 3, r);    // 꼬리·머리 둘 다 부드럽게
      const width = 1 - 0.85 * age * age;                                  // 오래된 쪽일수록 칼끝 쪽으로 좁아진다
      const o = r * 9, q = r * 12;
      for (let ax = 0; ax < 3; ax++) {
        const tip = catmull(s[a + ax], s[b + ax], s[c + ax], s[d + ax], t);
        const base = catmull(s[a + 3 + ax], s[b + 3 + ax], s[c + 3 + ax], s[d + 3 + ax], t);
        const inner = lerp(tip, base, width);
        P[o + ax] = inner;
        P[o + 3 + ax] = lerp(inner, tip, 0.86);
        P[o + 6 + ax] = tip;
      }
      C[q] = 1; C[q + 1] = 1; C[q + 2] = 1; C[q + 3] = 0;
      C[q + 4] = 1; C[q + 5] = 1; C[q + 6] = 1; C[q + 7] = alpha * 0.22;
      C[q + 8] = 1; C[q + 9] = 1; C[q + 10] = 1; C[q + 11] = alpha * 0.9;
    }
    tr.geo.attributes.position.needsUpdate = true;
    tr.geo.attributes.color.needsUpdate = true;
    tr.geo.setDrawRange(0, (rows - 1) * 12);
    tr.mesh.visible = true;
  }

  // ── 애니메이션 상태 ────────────────────────────────────────
  let curId = null, cur = null;
  let visible = true;
  let time = 0;
  let drawT = 1, drawDur = 0.5;
  let reloadT = -1, reloadDur = 2, reloadEmpty = false;
  let act = null;               // { type: 'bolt'|'pump'|'prime'|'throw'|'inspect'|'clip', t, dur, ... }. 칼의 베기·강타·점검은 'clip'
  let slideT = 1, hammerT = 1, cylTurn = 0, cylAngle = 0, stageA = 0;
  let adsBlend = 0, bobPhase = 0, bobAmt = 0, airTime = 0, wasOnGround = true;
  let refFov = camera.fov || 60;
  let lastPhase = null, lastZoom = 0, wasDrawing = false, edgeK = 0;
  const kz = spring(240, 0.8), kp = spring(240, 0.75), kr = spring(200, 0.8), land = spring(120, 0.7);
  const swayX = spring(90, 0.9), swayY = spring(90, 0.9);
  const qPrev = new THREE.Quaternion(), qNow = new THREE.Quaternion(), qDelta = new THREE.Quaternion();
  const eDelta = new THREE.Euler(0, 0, 0, 'YXZ');
  let qInit = false;
  const tmpV = new THREE.Vector3(), tmpS = new THREE.Vector3(), tmpW = new THREE.Vector3(), tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3();
  const clipP = new THREE.Vector3(), clipQ = new THREE.Quaternion(), qOff = new THREE.Quaternion(), qInv = new THREE.Quaternion(), qTmp = new THREE.Quaternion();
  const eOff = new THREE.Euler(0, 0, 0, 'XYZ');
  const AWAY = new THREE.Vector3(0.02, -0.55, 0.12);        // 왼손이 칼에서 떨어져 내려가는 방향(카메라 좌표)
  const ELBOW_R = new THREE.Vector3(0.4, -0.62, 0.16), ELBOW_L = new THREE.Vector3(-0.26, -0.74, 0.1);
  const fade = { t: 1, p: new THREE.Vector3(), q: new THREE.Quaternion() };
  let warnedMount = false;

  /** 지금 자세에서 다음 자세로 잠깐 섞는다(취소·끼어들기에서 튀지 않게) */
  function startFade() { fade.t = 0; fade.p.copy(pose.position); fade.q.copy(pose.quaternion); }

  function setWeapon(id) {
    if (!id) return false;
    if (id === curId && cur) return true;
    const m = ensureModel(id);
    for (const k of Object.keys(models)) models[k].g.visible = models[k] === m;
    curId = id;
    cur = m;
    const d = getDef(id);
    if (d) m.def = d;
    resetParts(m);
    act = null;
    trailClear();
    reloadT = -1;
    slideT = 1;
    hammerT = 1;
    adsBlend = 0;
    drawT = 0;
    drawDur = Math.max(0.05, num(m.def.drawTime, 0.5));
    wasDrawing = false;
    fade.t = 1;
    if (flash) {
      (m.muzzle || pose).add(flash.g);
      flash.g.visible = false;
      flash.t = 0;
    }
    return true;
  }

  function kick() {
    if (!cur) return;
    const k = cur.kick;
    const ads = 1 - 0.55 * adsBlend;
    kz.x = clamp(kz.x + k.z * ads, -0.2, 0.2);
    kp.x = clamp(kp.x + k.pitch * ads, -0.5, 0.5);
    kr.x = clamp(kr.x + (Math.random() - 0.5) * 2 * k.roll, -0.2, 0.2);
    if (cur.parts.slide) slideT = 0;
    if (cur.parts.cylinder) { cylTurn += Math.PI / 3; hammerT = 0; }
    if (cur.parts.pump) act = { type: 'pump', t: -0.14, dur: cur.pumpTime ?? 0.6 };
    if (flash && cur.muzzle && cur.flash > 0) {
      flash.t = 0.05;
      flash.g.visible = true;
      flash.g.rotation.z = Math.random() * Math.PI;
      const s = cur.flash * (0.85 + Math.random() * 0.3);
      flash.g.scale.set(s, s, s);
    }
  }

  /**
   * 칼의 베기·강타 클립. 맞는 순간(windup)에 mid 자세가 오도록 시간을 맞춘다.
   * 뒤로 빼기는 감속, 맞히러 갈 때 가속, 지나간 뒤 감속해서 빠른 순간이 판정과 겹친다. 남은 쿨다운 동안 천천히 자세를 되찾는다.
   */
  function bladeSwing(M_, heavy, index, wu, dur) {
    const I = M_.idle;
    if (heavy) {
      const H = M_.heavy;
      const t1 = wu * 0.74, t2 = wu * 0.9, t3 = wu, t4 = wu + M_.heavySpan, t5 = t4 + M_.heavyAfter, t6 = dur * 0.95;
      return {
        type: 'clip', kind: 'heavy', t: 0, dur, trail: [t2, t4 + 0.02], grab: [t1 * 0.8, t5 + 0.1],
        keys: [{ t: 0, ...I }, { t: t1, ...H.wind, e: 'out3' }, { t: t2, ...H.hold, e: 'lin' }, { t: t3, ...H.mid, e: 'in' }, { t: t4, ...H.end, e: 'out' }, { t: t5, ...H.after, e: 'lin' }, { t: t6, ...I, e: 'io' }],
      };
    }
    const C = index % 2 ? M_.slashB : M_.slashA;
    const t1 = wu * 0.62, t2 = wu, t3 = wu + M_.span, t4 = t3 + M_.span * 0.6, t5 = dur * 0.92;
    return {
      type: 'clip', kind: 'slash', t: 0, dur, trail: [t1 * 0.9, t3 + 0.02],
      keys: [{ t: 0, ...I }, { t: t1, ...C.wind, e: 'out' }, { t: t2, ...C.mid, e: 'in' }, { t: t3, ...C.end, e: 'out' }, { t: t4, ...C.after, e: 'lin' }, { t: t5, ...I, e: 'io' }],
    };
  }

  function sampleKeys(keys, t) {
    let i = 0;
    while (i < keys.length - 2 && t >= keys[i + 1].t) i++;
    const a = keys[i], b = keys[i + 1];
    const u = clamp((t - a.t) / Math.max(1e-5, b.t - a.t), 0, 1);
    const w = (EASE[b.e] || EASE.io)(u);
    clipP.lerpVectors(a.p, b.p, w);
    clipQ.slerpQuaternions(a.q, b.q, w);
  }

  function triggerGleam(m) {
    if (!m.gleam) return;
    m.gleam.t = 0;
    m.gleam.mesh.visible = true;
  }

  const INSPECT_CANCEL = new Set(['fire', 'dryFire', 'reloadStart', 'switch', 'swing', 'melee', 'prime', 'throw', 'boltCycle']);
  function cancelInspect() {
    startFade();
    act = null;
    resetParts(cur);
  }

  /** arsenal 이벤트를 그대로 넘긴다. { type: 'inspect' }는 점검 동작을 시작한다. */
  function play(ev) {
    if (!ev || typeof ev !== 'object') return;
    if (act && act.inspect && INSPECT_CANCEL.has(ev.type)) cancelInspect();
    switch (ev.type) {
      case 'switch':
        if (ev.to) {
          if (ev.to !== curId) setWeapon(ev.to);
          else resetParts(cur);
          act = null;
          trailClear();
          reloadT = -1;
          drawDur = num(ev.drawTime, 0) > 0 ? ev.drawTime : 0.0001;
          drawT = num(ev.drawTime, 0) > 0 ? 0 : 1;
        }
        break;
      case 'fire': kick(); break;
      case 'dryFire': kp.v -= 0.6; break;
      case 'reloadStart':
        if (act && act.type === 'pump') { act = null; resetParts(cur); }
        reloadT = 0;
        reloadDur = Math.max(0.1, num(ev.duration, 2));
        reloadEmpty = !!ev.empty;
        break;
      case 'reloadEnd':
      case 'reloadCancel':
        reloadT = -1;
        resetParts(cur);
        break;
      case 'boltCycle': act = { type: 'bolt', t: 0, dur: Math.max(0.2, num(ev.duration, 1.2)) }; break;
      case 'swing': {
        if (!cur || !cur.melee) break;
        const heavy = ev.kind === 'stab' || ev.kind === 'heavy';
        act = bladeSwing(cur.melee, heavy, ev.index | 0, num(ev.windup, heavy ? 0.34 : 0.12), num(ev.duration, heavy ? 1.25 : 0.62));
        break;
      }
      case 'swingCancel':
        if (act && (act.kind === 'slash' || act.kind === 'heavy')) { startFade(); act = null; }
        break;
      case 'prime': act = { type: 'prime', t: 0, dur: Infinity, kind: ev.kind }; break;
      case 'primeCancel': act = null; resetParts(cur); break;
      case 'throw': act = { type: 'throw', t: 0, dur: 0.36, kind: ev.kind }; break;
      case 'inspect':
        if (!cur || act || reloadT >= 0 || drawT < 1 || lastZoom > 0.01) break;
        if (lastPhase && lastPhase !== 'idle') break;
        if (cur.melee) act = { type: 'clip', inspect: true, t: 0, dur: cur.melee.inspectDur, keys: cur.melee.inspect };
        else act = { type: 'inspect', inspect: true, t: 0, dur: num(ev.duration, cur.inspectDur ?? 2.4) };
        break;
      default: break;
    }
  }

  // ── 동작별 오프셋(o: 위치 px/py/pz, 회전 rx/ry/rz 누적) ──────────────
  function reloadAnim(m, u, o) {
    // 총을 시계 방향으로 눕히고(탄창 구멍이 왼손 쪽) 총구를 안쪽·위로 → 화면을 가로지르는 자세
    const down = smooth(0, 0.16, u) * (1 - smooth(0.84, 1, u));
    o.py -= 0.03 * down; o.px -= 0.01 * down; o.pz += 0.05 * down;
    o.rx += 0.12 * down; o.ry += 0.35 * down; o.rz -= 0.45 * down;
    const mag = m.parts.mag;
    if (mag) {
      const b = mag.userData.base.pos;
      const off = smooth(0.18, 0.36, u) * (1 - smooth(0.52, 0.74, u));
      mag.position.set(b.x, b.y - 0.16 * off, b.z + 0.03 * off);
      mag.visible = !(u > 0.37 && u < 0.51);
      const L = m.arms.L;
      if (L) {
        const lb = L.userData.base;
        const grab = smooth(0.06, 0.2, u) * (1 - smooth(0.78, 0.94, u));
        L.position.set(lerp(lb.x, b.x - 0.01, grab), lerp(lb.y, b.y - 0.07 - 0.16 * off, grab), lerp(lb.z, b.z + 0.02 + 0.03 * off, grab));
      }
    }
    if (m.parts.bolt && reloadEmpty) boltParts(m, smooth(0.8, 0.97, u) * 0.999, o, false);
    if (m.parts.slide) {
      const s = m.parts.slide, b = s.userData.base.pos;
      const locked = reloadEmpty && u < 0.82;
      s.position.z = b.z + (locked ? 0.026 : 0.026 * (reloadEmpty ? 1 - smooth(0.82, 0.88, u) : 0));
    }
  }

  function boltParts(m, u, o, tiltGun = true) {
    const bolt = m.parts.bolt;
    if (!bolt) return;
    if (tiltGun) {
      const tilt = smooth(0.04, 0.18, u) * (1 - smooth(0.78, 0.96, u));
      o.rz -= 0.22 * tilt; o.py -= 0.012 * tilt; o.rx += 0.05 * tilt; o.px -= 0.01 * tilt;
    }
    const b = bolt.userData.base.pos;
    const lift = smooth(0.18, 0.3, u) - smooth(0.62, 0.74, u);
    const pull = smooth(0.3, 0.44, u) - smooth(0.48, 0.62, u);
    bolt.rotation.z = 1.1 * lift;
    bolt.position.z = b.z + 0.055 * pull;
    const R = m.arms.R;
    if (R) {
      const rb = R.userData.base;
      const reach = smooth(0.08, 0.2, u) * (1 - smooth(0.72, 0.86, u));
      R.position.set(lerp(rb.x, b.x + 0.06, reach), lerp(rb.y, b.y + 0.01 + 0.03 * lift, reach), lerp(rb.z, b.z + 0.03 + 0.055 * pull, reach));
    }
  }

  /** 펌프 앞 손잡이를 당겼다 민다(왼손이 함께 움직인다) */
  function pumpParts(m, u, o) {
    const p = m.parts.pump;
    if (!p) return;
    const back = smooth(0.06, 0.42, u) - smooth(0.52, 0.9, u);
    p.position.z = p.userData.base.pos.z + 0.1 * back;
    const L = m.arms.L;
    if (L) L.position.z = L.userData.base.z + 0.1 * back;
    o.rz -= 0.1 * back; o.py -= 0.012 * back; o.rx += 0.05 * back; o.pz += 0.018 * back;
  }

  /** 산탄총 재장전: 총을 눕히고 왼손이 탄을 하나씩 밀어 넣는다. 탄이 비었으면 끝에 펌프 */
  function shellReload(m, u, o) {
    const down = smooth(0, 0.14, u) * (1 - smooth(0.86, 1, u));
    o.py -= 0.02 * down; o.pz += 0.03 * down; o.rx += 0.2 * down; o.ry += 0.3 * down; o.rz -= 0.62 * down;
    const L = m.arms.L, shell = m.parts.shell;
    if (L && shell) {
      const lb = L.userData.base;
      const away = smooth(0.08, 0.16, u) * (1 - smooth(0.74, 0.82, u));
      const cyc = clamp((u - 0.16) / 0.58, 0, 0.9999) * 3;
      const f = cyc - Math.floor(cyc);
      const push = smooth(0.3, 0.74, f);
      const hx = -0.002, hy = lerp(-0.13, -0.052, push), hz = lerp(-0.03, -0.075, push);
      L.position.set(lerp(lb.x, hx, away), lerp(lb.y, hy, away), lerp(lb.z, hz, away));
      shell.visible = away > 0.9 && f < 0.82;
      shell.position.set(hx, hy + 0.02, hz);
    }
    if (reloadEmpty) pumpParts(m, clamp((u - 0.8) / 0.18, 0, 1), o);
  }

  /** 회전식 재장전: 약실 뭉치를 왼쪽으로 빼 돌리고 다시 넣는다 */
  function cylinderReload(m, u, o) {
    const down = smooth(0, 0.14, u) * (1 - smooth(0.86, 1, u));
    o.rx += 0.55 * down; o.rz -= 0.25 * down; o.py -= 0.015 * down; o.pz += 0.03 * down;
    const shake = smooth(0.3, 0.36, u) * (1 - smooth(0.36, 0.44, u));
    o.rx += 0.28 * shake;
    const cy = m.parts.cylinder, L = m.arms.L;
    if (cy) {
      const b = cy.userData.base.pos;
      const out = smooth(0.12, 0.24, u) * (1 - smooth(0.78, 0.9, u));
      cy.position.x = b.x - 0.04 * out;
      cy.position.y = b.y - 0.014 * out;
      cy.rotation.z = cylAngle + out * smooth(0.25, 0.8, u) * 9;
      if (L) {
        const lb = L.userData.base;
        const grab = smooth(0.08, 0.2, u) * (1 - smooth(0.82, 0.94, u));
        L.position.set(lerp(lb.x, b.x - 0.052, grab), lerp(lb.y, b.y - 0.02, grab), lerp(lb.z, b.z, grab));
      }
    }
  }

  function primeAnim(m, u, kind, o) {
    const k = smooth(0, 1, u);
    if (kind === 'underhand') { o.py -= 0.04 * k; o.pz += 0.05 * k; o.rx -= 0.3 * k; }
    else { o.py += 0.03 * k; o.pz += 0.04 * k; o.rx += 0.45 * k; o.px += 0.015 * k; }
    const pin = m.parts.pin, L = m.arms.L;
    const reach = smooth(0, 0.45, u), pull = smooth(0.5, 0.9, u);
    if (L) {
      const lb = L.userData.base;
      L.visible = true;
      L.position.set(lerp(lb.x, 0.0, reach) - 0.09 * pull, lerp(lb.y, 0.05, reach) - 0.03 * pull, lerp(lb.z, 0.03, reach) + 0.03 * pull);
    }
    if (pin) {
      const pb = pin.userData.base.pos;
      pin.position.set(pb.x - 0.09 * pull, pb.y - 0.03 * pull, pb.z + 0.03 * pull);
      pin.visible = u < 0.95;
    }
  }

  function throwAnim(m, u, kind, o) {
    const sw = smooth(0, 0.35, u), drop = smooth(0.35, 1, u);
    if (kind === 'underhand') {
      o.py += -0.04 + 0.07 * sw - 0.3 * drop; o.pz += 0.05 - 0.3 * sw; o.rx += -0.3 + 0.5 * sw;
    } else {
      o.py += 0.03 - 0.01 * sw - 0.3 * drop; o.pz += 0.04 - 0.32 * sw; o.rx += 0.45 - 1.3 * sw; o.px += 0.015 - 0.05 * sw;
    }
    if (m.parts.nade) m.parts.nade.visible = u < 0.22;
    if (m.parts.pin) m.parts.pin.visible = false;
    if (m.arms.L) m.arms.L.visible = u < 0.3;
  }

  /** 총 점검: 가까이 끌어와 오른쪽 면, 왼쪽 면을 차례로 살핀다 */
  function inspectGun(m, u, o) {
    const I = m.inspectAmt ?? 1;
    const a = smooth(0, 0.14, u) * (1 - smooth(0.86, 1, u));
    const b = smooth(0.12, 0.32, u) * (1 - smooth(0.44, 0.6, u));
    const c = smooth(0.5, 0.68, u) * (1 - smooth(0.82, 0.96, u));
    o.px -= 0.055 * a * I; o.py += 0.04 * a; o.pz += 0.05 * a;
    o.rx += 0.14 * a;
    o.ry += (0.8 * b - 0.32 * c) * I;
    o.rz += (-0.55 * b + 0.7 * c) * I;
    if (m.parts.slide) {
      const s = m.parts.slide, sb = s.userData.base.pos;
      s.position.z = sb.z + 0.022 * smooth(0.55, 0.62, u) * (1 - smooth(0.72, 0.78, u));
    }
  }

  /** 왼손을 칼에서 떼어 k만큼 아래로 내린다(카메라 기준) */
  function leftHandAway(m, k, q) {
    const L = m.arms.L;
    if (!L) return;
    qTmp.copy(q).invert();
    tmpV.copy(AWAY).applyQuaternion(qTmp);
    L.position.copy(L.userData.base).addScaledVector(tmpV, k);
  }

  /** 꺼내기: 키프레임대로 올린다. 칼집이 있는 칼은 칼집을 호를 따라 밀어내고 왼손이 칼집을 잡고 따라간다 */
  function bladeDraw(m, u) {
    sampleKeys(m.melee.draw, u);
    const saya = m.parts.saya, L = m.arms.L;
    if (!saya) return;
    const slide = smooth(0.14, 0.5, u), drop = smooth(0.5, 0.6, u) * 0.75;
    const alpha = (slide * m.sayaLen) / m.sayaRc;
    saya.visible = u < 0.58;
    saya.rotation.x = alpha;
    saya.position.y = saya.userData.base.pos.y + drop;
    if (!L) return;
    if (u < 0.5) {
      L.visible = true;
      // 칼집 입구(호 중심 기준으로 돌린 자리)
      const px = m.mouthP.y - m.sayaRc, pz = m.mouthP.z - m.swordZ;
      const ca = Math.cos(alpha), sa = Math.sin(alpha);
      L.position.set(0, m.sayaRc + drop + px * ca - pz * sa, m.swordZ + px * sa + pz * ca);
    } else {
      L.visible = false;
    }
  }

  const o = { px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0 };

  /** 소매가 손에서 카메라 아래쪽 팔꿈치 자리로 이어지게 돌린다 */
  function aimArms(m) {
    qInv.copy(pose.quaternion).invert();
    for (const a of [m.arms.R, m.arms.L]) {
      if (!a || !a.visible) continue;
      const u = a.userData;
      tmpA.copy(u.fore.position).add(a.position).applyQuaternion(pose.quaternion).add(pose.position);
      tmpB.copy(u.side === 'R' ? (m.elbowR || ELBOW_R) : (m.elbowL || ELBOW_L));
      tmpB.x += (pose.position.x - m.hip[0]) * 0.65;              // 손이 멀리 가면 팔꿈치도 조금 따라간다(팔이 화면을 가로막지 않게)
      tmpB.y += (pose.position.y - m.hip[1]) * 0.35;
      tmpB.sub(tmpA).normalize().applyQuaternion(qInv);
      u.fore.quaternion.setFromUnitVectors(AXIS_Z, tmpB);
    }
  }

  /**
   * @param {number} dt
   * @param {object} [s] arsenal.getViewState() — { weaponId, phase, phaseT, zoom, level, overlay, hideViewmodel, speed, onGround, mag, ... }
   */
  function update(dt, s = {}) {
    dt = clamp(num(dt, 0), 0, 0.1);
    s = s || {};
    if (s.weaponId && s.weaponId !== curId) setWeapon(s.weaponId);
    if (!cur) setWeapon('ar_std');
    const m = cur;
    time += dt;
    if (!warnedMount && !mountScene && !camera.parent) {
      warnedMount = true;
      if (typeof console !== 'undefined') console.warn('[weapons/viewmodel] camera가 씬에 없어 무기 모형이 보이지 않습니다. scene.add(camera) 또는 opts.scene을 쓰세요.');
    }

    // 카메라 따라가기(씬에 붙인 경우)
    if (followCamera) {
      camera.updateWorldMatrix(true, false);
      camera.matrixWorld.decompose(root.position, root.quaternion, tmpS);
    }

    // 보이기/숨기기(스코프)
    const zoom = clamp(num(s.zoom, 0), 0, 1);
    const zoomDef = m.def.zoom || null;
    const overlay = s.overlay !== undefined ? s.overlay : zoomDef ? zoomDef.overlay : null;
    const hide = s.hideViewmodel !== undefined ? !!s.hideViewmodel : !!overlay && zoom > 0.9;
    root.visible = visible && !hide;
    lastZoom = zoom;

    // 카메라 FOV가 줌으로 좁아져도 모형 크기는 그대로(월드 카메라에 붙인 경우)
    if (!(zoom > 0)) refFov = camera.fov || refFov;
    const kf = camera.fov > 0 ? Math.max(1, Math.tan((refFov * DEG) / 2) / Math.tan((camera.fov * DEG) / 2)) : 1;
    root.scale.set(S / kf, S / kf, S);

    // 상태(s.phase)가 오면 그것을 따르고, 없으면 이벤트로 시작한 내부 타이머를 쓴다
    const hasPhase = typeof s.phase === 'string';
    lastPhase = hasPhase ? s.phase : null;

    // 점검은 다른 상태가 시작되거나 줌을 하면 끊는다
    if (act && act.inspect && ((hasPhase && s.phase !== 'idle') || zoom > 0.01)) cancelInspect();

    // 타이머
    if (drawT < 1) drawT = Math.min(1, drawT + dt / drawDur);
    if (reloadT >= 0) { reloadT += dt / reloadDur; if (reloadT >= 1 && s.phase !== 'reload') { reloadT = -1; resetParts(m); } }
    const tPrev = act ? act.t : 0;
    if (act) {
      act.t += dt;
      if (act.t >= act.dur) {
        if (act.type === 'bolt' || act.type === 'pump' || act.inspect) resetParts(m);
        act = null;
      }
    }
    if (s.phase === 'bolt' && (!act || act.type !== 'bolt')) {
      const bd = Math.max(0.2, num(m.def.bolt, 1.2));
      act = { type: 'bolt', t: num(s.phaseT, 0) * bd, dur: bd };
    }
    if (s.phase === 'prime' && (!act || act.type !== 'prime')) act = { type: 'prime', t: 0.3, dur: Infinity, kind: s.primeKind };
    slideT = Math.min(1, slideT + dt / 0.075);
    hammerT = Math.min(1, hammerT + dt / 0.16);
    if (flash && flash.t > 0) { flash.t -= dt; if (flash.t <= 0) flash.g.visible = false; }

    o.px = o.py = o.pz = o.rx = o.ry = o.rz = 0;

    // 꺼내기(교체 올리기)
    let drawU = -1;
    if (s.phase === 'draw') drawU = clamp(num(s.phaseT, 1), 0, 1);
    else if (!hasPhase && drawT < 1) drawU = drawT;
    let useClip = false;
    if (m.melee) {
      if (drawU >= 0) { bladeDraw(m, drawU); useClip = true; wasDrawing = true; }
      else if (wasDrawing) { wasDrawing = false; resetParts(m); triggerGleam(m); }
    } else if (drawU >= 0) {
      const drawK = 1 - easeOutCubic(drawU);
      o.py -= 0.24 * drawK; o.pz += 0.05 * drawK; o.rx -= 0.9 * drawK; o.rz += 0.25 * drawK;
    }

    // 재장전(내리기 + 탄창)
    const rT = hasPhase ? (s.phase === 'reload' ? clamp(num(s.phaseT, 0), 0, 1) : -1)
      : reloadT >= 0 ? clamp(reloadT, 0, 1) : -1;
    if (s.reloadEmpty !== undefined && s.phase === 'reload') reloadEmpty = !!s.reloadEmpty;
    if (rT >= 0) (m.reloadFn || reloadAnim)(m, rT, o);
    else if (hasPhase && reloadT >= 0) { reloadT = -1; resetParts(m); }

    // 동작
    if (act) {
      const u = Number.isFinite(act.dur) ? clamp(act.t / act.dur, 0, 1) : act.t;
      if (act.type === 'bolt') boltParts(m, u, o, true);
      else if (act.type === 'pump') pumpParts(m, u, o);
      else if (act.type === 'prime') primeAnim(m, clamp(act.t / 0.3, 0, 1), act.kind, o);
      else if (act.type === 'throw') throwAnim(m, u, act.kind, o);
      else if (act.type === 'inspect') inspectGun(m, u, o);
      else if (act.type === 'clip' && m.melee && drawU < 0) {
        sampleKeys(act.keys, act.t);
        useClip = true;
        if (act.inspect && ((tPrev < 0.62 && act.t >= 0.62) || (tPrev < 1.85 && act.t >= 1.85))) triggerGleam(m);
        if (act.kind === 'heavy' && m.arms.L) {
          const lk = smooth(0, act.grab[0], act.t) * (1 - smooth(act.grab[1], act.grab[1] + 0.2, act.t));
          m.arms.L.visible = lk > 0.01;
          if (lk > 0.01) leftHandAway(m, 1 - lk, clipQ);
        }
      }
    }

    // 권총 슬라이드: 쏠 때 뒤로, 탄이 0이면 젖혀진 채로
    if (m.parts.slide && rT < 0 && !(act && act.type === 'inspect')) {
      const b = m.parts.slide.userData.base.pos;
      const u = slideT;
      let back = u < 1 ? 0.026 * (u < 0.35 ? u / 0.35 : 1 - (u - 0.35) / 0.65) : 0;
      if (s.mag === 0) back = 0.026;
      m.parts.slide.position.z = b.z + back;
    }
    // 회전식: 약실 뭉치가 한 칸 돌고 공이치기가 튄다
    if (m.parts.cylinder) {
      cylAngle = approach(cylAngle, cylTurn, 26, dt);
      if (rT < 0) m.parts.cylinder.rotation.z = cylAngle;
      if (m.parts.hammer) m.parts.hammer.rotation.x = -0.75 * (hammerT < 0.3 ? 1 - hammerT / 0.3 : 0);
    }
    // 2단 조준경: 단계에 따라 옆 드럼이 돈다
    if (m.parts.stage) {
      stageA = approach(stageA, num(s.level, 0) * 2.1, 14, dt);
      m.parts.stage.rotation.x = stageA;
    }

    // 조준(ADS): 소총은 조준경을 화면 가운데로, 저격은 스코프 쪽으로 당기다가 0.9에서 숨김
    const adsTarget = m.ads && zoomDef ? (zoomDef.overlay ? Math.min(1, zoom / 0.9) * 0.9 : zoom) : 0;
    adsBlend = approach(adsBlend, adsTarget, 28, dt);

    // 걷기 흔들림 + 숨쉬기
    const speed = Math.max(0, num(s.speed, 0));
    const onGround = s.onGround !== false;
    bobAmt = approach(bobAmt, clamp(speed / 5.2, 0, 1.3) * (onGround ? 1 : 0.15), 8, dt);
    bobPhase += dt * (4 + speed * 1.15);
    const amp = bobAmt * (1 - 0.8 * adsBlend);
    const breathe = 1 - 0.85 * adsBlend;
    o.px += Math.sin(bobPhase) * 0.011 * amp + Math.cos(time * 0.9) * 0.0012 * breathe;
    o.py += (-Math.abs(Math.cos(bobPhase)) + 0.5) * 0.012 * amp + Math.sin(time * 1.7) * 0.0016 * breathe;
    o.rz += Math.sin(bobPhase) * 0.02 * amp;

    // 착지 출렁임
    if (!onGround) airTime += dt;
    if (onGround && !wasOnGround) land.v -= 0.5 * clamp(airTime / 0.6, 0.3, 1.2);
    if (!onGround && wasOnGround) land.v += 0.15;
    if (onGround) airTime = 0;
    wasOnGround = onGround;
    stepSpring(land, dt);
    o.py += land.x * 0.06;
    o.rx += land.x * 0.15;

    // 시점 회전에 끌려오는 흔들림(sway)
    lookCam.getWorldQuaternion(qNow);
    if (qInit && dt > 0) {
      qDelta.copy(qPrev).invert().multiply(qNow);
      eDelta.setFromQuaternion(qDelta, 'YXZ');
      const yawRate = clamp(eDelta.y / dt, -12, 12), pitchRate = clamp(eDelta.x / dt, -12, 12);
      const f = 1 - 0.75 * adsBlend;
      stepSpring(swayX, dt, clamp(yawRate * 0.0035, -0.024, 0.024) * f);
      stepSpring(swayY, dt, clamp(-pitchRate * 0.0035, -0.02, 0.02) * f);
    }
    qPrev.copy(qNow);
    qInit = true;
    o.px += swayX.x; o.py += swayY.x; o.rz -= swayX.x * 2.5; o.rx -= swayY.x * 1.5;

    // 반동 킥(스프링)
    stepSpring(kz, dt); stepSpring(kp, dt); stepSpring(kr, dt);
    o.pz += kz.x; o.rx += kp.x; o.rz += kr.x; o.py += kp.x * 0.04;

    // 합성
    if (m.melee) {
      const P = useClip ? clipP : m.melee.idle.p, Q = useClip ? clipQ : m.melee.idle.q;
      pose.position.set(P.x + o.px, P.y + o.py, P.z + o.pz);
      eOff.set(o.rx, o.ry, o.rz);
      pose.quaternion.copy(Q).premultiply(qOff.setFromEuler(eOff));
    } else {
      const hip = m.hip, ads = m.ads || m.hip, hr = m.hipRot;
      pose.position.set(lerp(hip[0], ads[0], adsBlend) + o.px, lerp(hip[1], ads[1], adsBlend) + o.py, lerp(hip[2], ads[2], adsBlend) + o.pz);
      pose.rotation.set(hr[0] * (1 - adsBlend) + o.rx, hr[1] * (1 - adsBlend) + o.ry, hr[2] * (1 - adsBlend) + o.rz, 'XYZ');
    }
    if (fade.t < 1) {
      fade.t = Math.min(1, fade.t + dt / 0.13);
      const w = EASE.io(fade.t);
      pose.position.lerpVectors(fade.p, pose.position, w);
      qTmp.copy(pose.quaternion);
      pose.quaternion.slerpQuaternions(fade.q, qTmp, w);
    }
    aimArms(m);

    // 칼날 빛: 평소에는 숨쉬듯 옅게, 휘두를 때 밝게
    if (m.edge) {
      const inTrail = act && act.trail && act.t >= act.trail[0] && act.t <= act.trail[1] + 0.08;
      const hot = inTrail || (drawU > 0.48 && drawU < 0.8) ? 1 : 0;
      edgeK = approach(edgeK, hot, hot ? 34 : 5, dt);
      const breath = 0.5 + 0.5 * Math.sin(time * 1.6);
      m.edge.opacity = lerp(0.26 + 0.08 * breath, 1, edgeK);
      m.blade.emissiveIntensity = m.blade.emissiveMap ? lerp(0.62 + 0.14 * breath, 1.9, edgeK) : 0.02;
    }
    if (m.gleam) {
      const gl = m.gleam;
      if (gl.t < 0 && !act && drawU < 0) {
        gl.next -= dt;
        if (gl.next <= 0) { gl.next = 5 + Math.random() * 6; triggerGleam(m); }
      }
      if (gl.t >= 0) {
        gl.t += dt / 0.62;
        if (gl.t >= 1) { gl.t = -1; gl.mesh.visible = false; }
        else gl.tex.offset.x = 0.5 - lerp(-0.3, 1.25, gl.t);
      }
    }

    // 궤적
    const tw = act && act.trail;
    const trailOn = m.tipP && ((tw && act.t >= tw[0] && act.t <= tw[1]) || (m.melee && drawU > 0.5 && drawU < 0.8));
    if (trailOn) {
      if (!trailNow) trailBegin(m.trailGain ?? 1, m.trailColor ?? 0xffffff);
      tmpA.copy(m.tipP).applyQuaternion(pose.quaternion).add(pose.position);
      tmpB.copy(m.midP).applyQuaternion(pose.quaternion).add(pose.position);
      trailPush(trailNow, tmpA, tmpB, time);
    } else if (trailNow) trailEnd();
    for (const t of trails) if (t.n > 0) trailBuild(t, time);
  }

  /**
   * 총구 위치(월드 좌표). FX의 섬광·예광탄 시작점용.
   * 뷰모델 전용 카메라를 쓰는 경우, 화면에서 같은 자리에 보이도록 worldCamera의 시선 위로 옮겨 준다.
   * @param {THREE.Vector3} [out]
   * @param {THREE.Camera} [worldCamera=opts.lookCamera]
   * @returns {THREE.Vector3|null} 칼·수류탄이면 null
   */
  function getMuzzleWorld(out = new THREE.Vector3(), worldCamera = lookCam) {
    if (!cur || !cur.muzzle) return null;
    root.updateWorldMatrix(true, true);
    cur.muzzle.getWorldPosition(out);
    if (!worldCamera || worldCamera === camera || !worldCamera.isCamera) return out;
    camera.updateWorldMatrix(true, false);
    camera.getWorldPosition(tmpV);
    const d = out.distanceTo(tmpV);
    out.project(camera);
    out.z = 0.5;
    worldCamera.updateWorldMatrix(true, false);
    out.unproject(worldCamera);
    worldCamera.getWorldPosition(tmpW);
    return out.sub(tmpW).normalize().multiplyScalar(d).add(tmpW);
  }

  function setTeam(team) {
    const c = TEAM_SLEEVE[team] ?? COLOR.sleeve;
    M.sleeve.color.setHex(c);
    M.sleeve.emissive.setHex(c).multiplyScalar(0.12);
  }
  if (opts.team) setTeam(opts.team);

  /** 모든 모형을 만들고 셰이더·텍스처·환경맵을 미리 준비한다. 첫 교체·첫 베기에서 끊기지 않게 로딩 화면에서 한 번 부른다 */
  function prewarm(renderer) {
    for (const id of VIEWMODEL_IDS) ensureModel(id);
    if (!renderer) return;
    try {
      renderer.compile(root, camera, mountScene || undefined);
      if (renderer.initTexture) for (const t of owned.texs) if (t !== envTex) renderer.initTexture(t);
    } catch (e) { /* 지원하지 않으면 첫 사용 때 준비된다 */ }
  }

  function dispose() {
    root.removeFromParent();
    camera.layers.disable(VIEWMODEL_LAYER);
    for (const g of owned.geos) g.dispose();
    for (const mm of owned.mats) mm.dispose();
    for (const t of owned.texs) t.dispose();
    owned.geos.clear(); owned.mats.clear(); owned.texs.clear();
    handCache.clear();
    paintCache.clear();
    for (const k of Object.keys(models)) delete models[k];
    trailNow = null;
    cur = null; curId = null;
  }

  return {
    /** 최상위 그룹(디버그용) */
    group: root,
    setWeapon,
    play,
    update,
    setTeam,
    getMuzzleWorld,
    /** 사망·관전 때 숨기기 */
    setVisible: (v) => { visible = !!v; root.visible = visible; },
    setClearDepth: (v) => { clearDepth = !!v; },
    getWeaponId: () => curId,
    /** 점검 동작 중인가 */
    isInspecting: () => !!(act && act.inspect),
    /** 미리 만들어 두기(첫 교체 때 끊김 방지) */
    preload: (ids = VIEWMODEL_IDS) => { for (const id of ids) ensureModel(id); },
    prewarm,
    dispose,
  };
}
