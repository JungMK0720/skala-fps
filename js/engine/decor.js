/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 충돌 없는 장식 모형과 발판·포털 표시. 재질별 배치와 인스턴싱으로 드로우콜을 줄이고 실제 조명은 쓰지 않는다.
 */
/**
 * SKALA 작전 — 장식(decor) 모형: 충돌 없음, 총알 통과.
 *   pipe · sign · light · loadingArm · flare · buoy · tree · bamboo · lantern · banner · rope · vent · crateStack
 *
 * 정적인 부품은 builder가 넘겨준 재질별 GeoBatch에 합쳐 드로우콜을 줄이고,
 * 움직이는 부품(불꽃·부표·나무·대나무·현수막)과 개별 텍스처(표지판·현수막)만 따로 메시로 만든다.
 * 같은 종류는 인스턴스 한 묶음으로 그린다. 조명을 켜는 타입은 light와 flare뿐이다.
 *
 * 필드(y를 생략하면 0, rotY는 three.js rotation.y 라디안, 0이면 앞면이 +z)
 *   tree       { x, y, z, h=5.5, r=h×0.46, petals=true }                 y = 밑동. 분홍 벚나무
 *   bamboo     { x, y, z, h=6, n=7, r=0.9 }                              y = 밑동. n줄기 무더기, r = 퍼짐
 *   lantern    { x, y, z, r=0.28, color='#ffb35c', cord=0.5 }            y = 몸통 중심
 *   banner     { x, y, z, rotY, w=1.2, h=3, text, bg, fg, emblem }       y = 천 중심. emblem: circle|ring|diamond|blossom|blade
 *   rope       { from, to, sag=길이×0.06, r=0.022, mat='wood' }          늘어진 줄
 *   vent       { x, y, z, rotY, w=1.2, h=0.8, d=0.16, mat='metal_dark' } y = 중심. 벽에 붙이면 +z로 튀어나온다
 *   crateStack { x, y, z, rotY, size=1.1, levels=2, mat='wood' }         y = 바닥. 보기만 하는 상자 더미
 */
import * as THREE from 'three';
import { GeoBatch, pipeMatrix } from './geom.js';
import { toRad, LIMITS } from '../core/consts.js';

const FONT = "'Pretendard','Noto Sans KR','Malgun Gothic','Apple SD Gothic Neo',system-ui,sans-serif";
const TAU = Math.PI * 2;
const LANTERN_TALL = 1.18;  // 등 몸통 세로/가로
const numOr = (v, d) => (v !== null && v !== '' && v !== undefined && Number.isFinite(+v) ? +v : d);

/* ---------------- 공용 리소스 ---------------- */

let unitCyl = null, unitSphere = null, glowTex = null, flameTex = null;
function getUnitCyl() {
  if (!unitCyl) { unitCyl = new THREE.CylinderGeometry(1, 1, 1, 12, 1, false); unitCyl.translate(0, 0.5, 0); }
  return unitCyl;
}
function getUnitSphere() {
  if (!unitSphere) unitSphere = new THREE.SphereGeometry(1, 12, 8);
  return unitSphere;
}
function radialTex(stops, size = 64) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  stops.forEach(([o, col]) => gr.addColorStop(o, col));
  g.fillStyle = gr;
  g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function getGlowTex() {
  if (!glowTex) glowTex = radialTex([[0, 'rgba(255,255,255,1)'], [0.25, 'rgba(255,255,255,0.45)'], [1, 'rgba(255,255,255,0)']]);
  return glowTex;
}
function getFlameTex() {
  if (!flameTex) {
    const W = 64, H = 128;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    // 아래가 넓고 위로 갈수록 가늘어지는 불꽃
    for (let i = 0; i < 3; i++) {
      const gr = g.createRadialGradient(W / 2, H * 0.78, 2, W / 2, H * 0.6, H * 0.55);
      const col = ['255,240,190', '255,170,60', '255,90,20'][i];
      gr.addColorStop(0, `rgba(${col},${0.9 - i * 0.2})`);
      gr.addColorStop(1, `rgba(${col},0)`);
      g.fillStyle = gr;
      g.beginPath();
      g.moveTo(W / 2, 4 + i * 6);
      g.bezierCurveTo(W * (0.95 - i * 0.05), H * 0.45, W * 0.9, H * 0.95, W / 2, H - 2);
      g.bezierCurveTo(W * 0.1, H * 0.95, W * (0.05 + i * 0.05), H * 0.45, W / 2, 4 + i * 6);
      g.fill();
    }
    flameTex = new THREE.CanvasTexture(c);
    flameTex.colorSpace = THREE.SRGBColorSpace;
  }
  return flameTex;
}

/** 위치로 씨앗을 정하는 난수: 같은 자리에는 늘 같은 모양이 나온다 */
function seededRand(x, z, salt = 0) {
  let a = (Math.round(x * 64) * 73856093) ^ (Math.round(z * 64) * 19349663) ^ (salt * 83492791);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function canvasTexture(W, H, paint, repeat = false) {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  paint(c.getContext('2d'), W, H);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function tintGeometry(g, hex) {
  const c = new THREE.Color(hex), n = g.attributes.position.count, arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

let blossomGeo = null, stalkGeo = null, petalTex = null, ribTex = null;

/** 벚꽃 덩어리: 작은 구를 뭉친 반지름 약 1짜리 모양. 아래쪽을 어둡게 칠해 입체감을 준다 */
function getBlossomGeo() {
  if (blossomGeo) return blossomGeo;
  const BLOBS = [
    [0, 0.12, 0, 0.7], [0.6, 0.02, 0.12, 0.5], [-0.58, 0.04, -0.16, 0.52], [0.12, 0.02, 0.62, 0.48],
    [-0.16, -0.02, -0.62, 0.48], [0.3, 0.44, -0.24, 0.44], [-0.28, 0.46, 0.24, 0.42]
  ];
  const tones = ['#ffc6dd', '#ffb4d2', '#ffa8ca', '#ffd6e6'].map((c) => new THREE.Color(c));
  const parts = BLOBS.map(([bx, by, bz, r], n) => {
    const g = new THREE.IcosahedronGeometry(1, 1);
    const p = g.attributes.position;
    const col = new Float32Array(p.count * 3);
    const tone = tones[n % tones.length];
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      // 좌표로 정한 울퉁불퉁함이라 같은 꼭짓점은 같이 움직여 틈이 생기지 않는다
      const k = 1 + 0.12 * Math.sin(x * 5 + n) * Math.cos(z * 4 + y * 3);
      const wy = by + y * r * k * 0.86;
      p.setXYZ(i, bx + x * r * k, wy, bz + z * r * k);
      const light = 0.68 + 0.32 * Math.min(1, Math.max(0, (wy + 0.6) / 1.4));
      col[i * 3] = tone.r * light; col[i * 3 + 1] = tone.g * light; col[i * 3 + 2] = tone.b * light;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return g;
  });
  blossomGeo = mergeSimple(parts);
  parts.forEach((g) => g.dispose());
  return blossomGeo;
}

/** 대나무 한 줄기(높이 6 m): 마디 줄기 + 위쪽 잎. 인스턴스 크기로 높이를 맞춘다 */
function getStalkGeo() {
  if (stalkGeo) return stalkGeo;
  const parts = [];
  const H = 6, ROWS = 6, R0 = 0.055;
  const radius = (f) => R0 * (1 - f * 0.45);
  for (let i = 0; i < ROWS; i++) {
    const f0 = i / ROWS, f1 = (i + 1) / ROWS, len = H / ROWS;
    const body = new THREE.CylinderGeometry(radius(f1), radius(f0), len, 6, 1, true);
    body.translate(0, f0 * H + len / 2, 0);
    parts.push(tintGeometry(body, i % 2 ? '#7da548' : '#86ad4e'));
    if (i > 0) {
      const ring = new THREE.CylinderGeometry(radius(f0) * 1.25, radius(f0) * 1.25, 0.035, 6, 1, false);
      ring.translate(0, f0 * H, 0);
      parts.push(tintGeometry(ring, '#55702f'));
    }
  }
  const rnd = seededRand(1.7, 9.3);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), euler = new THREE.Euler();
  for (let i = 0; i < 10; i++) {
    const leaf = new THREE.OctahedronGeometry(1, 0);
    const a = rnd() * TAU, y = H * (0.62 + 0.38 * rnd()), out = 0.25 + 0.35 * rnd();
    euler.set(0.25 * rnd(), -a, -0.35 - 0.4 * rnd());
    m.compose(new THREE.Vector3(Math.cos(a) * out, y, Math.sin(a) * out), q.setFromEuler(euler), new THREE.Vector3(0.42, 0.018, 0.075));
    leaf.applyMatrix4(m);
    parts.push(tintGeometry(leaf, rnd() < 0.5 ? '#4f8a38' : '#6aa344'));
  }
  stalkGeo = mergeSimple(parts);
  parts.forEach((g) => g.dispose());
  return stalkGeo;
}

/** 나무 밑에 흩어진 꽃잎 */
function getPetalTex() {
  if (!petalTex) {
    petalTex = canvasTexture(256, 256, (g, S) => {
      const rnd = seededRand(3.1, 4.7);
      for (let i = 0; i < 420; i++) {
        const a = rnd() * TAU, rr = Math.pow(rnd(), 0.75) * S * 0.48;
        const fade = 1 - rr / (S * 0.5);
        g.fillStyle = `rgba(255,${(170 + rnd() * 50) | 0},${(205 + rnd() * 30) | 0},${0.35 + 0.6 * fade})`;
        g.beginPath();
        g.ellipse(S / 2 + Math.cos(a) * rr, S / 2 + Math.sin(a) * rr, 2.2 + rnd() * 2.2, 1.2 + rnd() * 1.2, rnd() * TAU, 0, TAU);
        g.fill();
      }
    });
  }
  return petalTex;
}

/** 등 몸통: 종이 살 + 위아래가 살짝 어둡다 */
function getRibTex() {
  if (!ribTex) {
    ribTex = canvasTexture(32, 64, (g, W, H) => {
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, W, H);
      g.fillStyle = 'rgba(110,70,40,0.32)';
      for (let y = 4; y < H; y += 7) g.fillRect(0, y, W, 1);
      const shade = g.createLinearGradient(0, 0, 0, H);
      shade.addColorStop(0, 'rgba(60,30,10,0.45)'); shade.addColorStop(0.28, 'rgba(60,30,10,0)');
      shade.addColorStop(0.72, 'rgba(60,30,10,0)'); shade.addColorStop(1, 'rgba(60,30,10,0.45)');
      g.fillStyle = shade;
      g.fillRect(0, 0, W, H);
    });
  }
  return ribTex;
}

/* ---------------- 표지판 텍스처 ---------------- */

/** 표지판 캔버스 텍스처 (한글·영문, 여러 줄 '\n' 지원) */
export function makeSignTexture(text, w, h, bg = '#0b2545', fg = '#ffffff') {
  const ppm = 128; // px per m
  let cw = Math.max(64, Math.round(w * ppm)), ch = Math.max(32, Math.round(h * ppm));
  const k = Math.min(1, 1024 / cw, 512 / ch);
  cw = Math.round(cw * k); ch = Math.round(ch * k);
  const c = document.createElement('canvas');
  c.width = cw; c.height = ch;
  const g = c.getContext('2d');
  g.fillStyle = bg;
  g.fillRect(0, 0, cw, ch);
  const border = Math.max(2, Math.round(Math.min(cw, ch) * 0.05));
  g.strokeStyle = fg;
  g.globalAlpha = 0.85;
  g.lineWidth = border * 0.6;
  g.strokeRect(border, border, cw - border * 2, ch - border * 2);
  g.globalAlpha = 1;
  const lines = String(text == null ? '' : text).split('\n').map((s) => s.trim()).filter((s, i, a) => s || a.length === 1);
  const pad = border * 2.2;
  let size = Math.floor((ch - pad * 2) / (lines.length * 1.18));
  g.fillStyle = fg;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const fit = () => {
    g.font = `800 ${size}px ${FONT}`;
    return Math.max(...lines.map((l) => g.measureText(l).width));
  };
  while (size > 8 && fit() > cw - pad * 2) size -= 2;
  const lh = size * 1.18;
  const y0 = ch / 2 - ((lines.length - 1) * lh) / 2;
  lines.forEach((l, i) => g.fillText(l, cw / 2, y0 + i * lh + size * 0.04));
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function drawEmblem(g, kind, cx, cy, r, fg, bg) {
  g.save();
  g.fillStyle = fg; g.strokeStyle = fg;
  g.translate(cx, cy);
  if (kind === 'circle') {
    g.beginPath(); g.arc(0, 0, r, 0, TAU); g.fill();
  } else if (kind === 'diamond') {
    g.beginPath(); g.moveTo(0, -r); g.lineTo(r * 0.72, 0); g.lineTo(0, r); g.lineTo(-r * 0.72, 0); g.closePath(); g.fill();
  } else if (kind === 'blossom') {
    for (let i = 0; i < 5; i++) {
      g.save();
      g.rotate((i / 5) * TAU);
      g.beginPath(); g.ellipse(0, -r * 0.58, r * 0.34, r * 0.46, 0, 0, TAU); g.fill();
      g.restore();
    }
    g.fillStyle = bg;
    g.beginPath(); g.arc(0, 0, r * 0.2, 0, TAU); g.fill();
  } else if (kind === 'blade') {
    g.beginPath(); g.moveTo(0, -r); g.lineTo(r * 0.11, r * 0.42); g.lineTo(-r * 0.11, r * 0.42); g.closePath(); g.fill();
    g.fillRect(-r * 0.36, r * 0.42, r * 0.72, r * 0.1);
    g.fillRect(-r * 0.07, r * 0.52, r * 0.14, r * 0.48);
  } else {
    g.lineWidth = r * 0.2;
    g.beginPath(); g.arc(0, 0, r * 0.88, 0, TAU); g.stroke();
  }
  g.restore();
}

/** 현수막 캔버스 텍스처. 세로로 길면 글자를 위에서 아래로 쌓고 아랫단을 제비꼬리로 자른다 */
export function makeBannerTexture(text, w, h, bg = '#7a1f3d', fg = '#ffe9f0', emblem = null) {
  const ppm = 96;
  let cw = Math.max(64, Math.round(w * ppm)), ch = Math.max(64, Math.round(h * ppm));
  const k = Math.min(1, 512 / cw, 1024 / ch);
  cw = Math.round(cw * k); ch = Math.round(ch * k);
  const c = document.createElement('canvas');
  c.width = cw; c.height = ch;
  const g = c.getContext('2d');
  g.fillStyle = bg;
  g.fillRect(0, 0, cw, ch);
  // 천의 짜임
  g.fillStyle = 'rgba(0,0,0,0.05)';
  for (let y = 0; y < ch; y += 3) g.fillRect(0, y, cw, 1);
  g.fillStyle = 'rgba(255,255,255,0.03)';
  for (let x = 0; x < cw; x += 3) g.fillRect(x, 0, 1, ch);

  const portrait = ch >= cw * 1.3;
  const inset = Math.max(3, Math.round(Math.min(cw, ch) * 0.06));
  const tail = portrait ? Math.round(cw * 0.3) : 0;
  g.strokeStyle = fg;
  g.globalAlpha = 0.85;
  g.lineWidth = Math.max(2, inset * 0.35);
  g.beginPath();
  g.moveTo(inset, ch - tail - inset);
  g.lineTo(inset, inset);
  g.lineTo(cw - inset, inset);
  g.lineTo(cw - inset, ch - tail - inset);
  if (!tail) g.closePath();
  g.stroke();
  g.globalAlpha = 1;

  const pad = inset * 1.8;
  let top = pad;
  const bottom = ch - tail - pad;
  const str = String(text == null ? '' : text).trim();
  if (emblem) {
    const r = str ? Math.min((cw - pad * 2) * 0.42, (bottom - top) * 0.2) : Math.min(cw - pad * 2, bottom - top) * 0.42;
    drawEmblem(g, emblem, cw / 2, str ? top + r : (top + bottom) / 2, r, fg, bg);
    top += r * 2 + pad * 0.6;
  }
  if (str) {
    g.fillStyle = fg;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const areaW = cw - pad * 2, areaH = Math.max(8, bottom - top);
    const lines = portrait && !str.includes('\n') ? Array.from(str).filter((s) => s.trim()) : str.split('\n').map((s) => s.trim()).filter(Boolean);
    let size = Math.floor(Math.min(areaH / (lines.length * 1.14), portrait ? areaW : areaH));
    const fit = () => {
      g.font = `800 ${size}px ${FONT}`;
      return Math.max(...lines.map((l) => g.measureText(l).width));
    };
    while (size > 8 && fit() > areaW) size -= 2;
    const lh = size * 1.14;
    const y0 = top + areaH / 2 - ((lines.length - 1) * lh) / 2;
    lines.forEach((l, i) => g.fillText(l, cw / 2, y0 + i * lh + size * 0.04));
  }
  if (tail) {
    g.globalCompositeOperation = 'destination-out';
    g.beginPath(); g.moveTo(0, ch); g.lineTo(cw / 2, ch - tail); g.lineTo(cw, ch); g.closePath(); g.fill();
    g.globalCompositeOperation = 'source-over';
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/* ---------------- 장식 빌드 ---------------- */

const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpS = new THREE.Vector3();
const tmpP = new THREE.Vector3();
const tmpC = new THREE.Color();

/** 현수막 천 한 면: 앞면·뒷면을 따로 넣어 어느 쪽에서 봐도 글자가 바로 읽힌다 */
const BANNER_COLS = 5, BANNER_ROWS = 8;
function addBannerSheet(b, T, nx, nz, w, h, back, phase) {
  const base = b.pos.length / 3;
  const side = back ? -1 : 1;
  for (let j = 0; j <= BANNER_ROWS; j++) {
    for (let i = 0; i <= BANNER_COLS; i++) {
      const u = i / BANNER_COLS, down = j / BANNER_ROWS;
      const fold = Math.sin(u * TAU * 1.25 + phase) * 0.035 * (0.35 + 0.65 * down);
      const p = T([(u - 0.5) * w, h / 2 - down * h, fold]);
      b.pos.push(p[0], p[1], p[2]);
      b.nor.push(nx * side, 0, nz * side);
      b.uv.push(back ? 1 - u : u, 1 - down);
      b.sway.push(nx, nz, 0.05 * down * down, u * 3 + phase);
    }
  }
  for (let j = 0; j < BANNER_ROWS; j++) {
    for (let i = 0; i < BANNER_COLS; i++) {
      const a = base + j * (BANNER_COLS + 1) + i, e = a + BANNER_COLS + 1, f = e + 1, d = a + 1;
      if (back) b.idx.push(a, f, e, a, d, f); else b.idx.push(a, e, f, a, f, d);
    }
  }
}

/**
 * @param {object[]} list map.decor
 * @param {object} env { batch(mat) → GeoBatch, group: THREE.Group, waterY(x,z) → number, warn(msg) }
 * @returns {{ update(dt:number, t:number):void, dispose():void, counts:object }}
 */
export function buildDecor(list, env) {
  const disposables = [];
  const counts = { pipe: 0, sign: 0, light: 0, loadingArm: 0, flare: 0, buoy: 0, tree: 0, bamboo: 0, lantern: 0, banner: 0, rope: 0, vent: 0, crateStack: 0, skipped: 0 };
  const pipes = new Map(); // mat → [matrix]
  const bulbs = [];        // { pos, color, intensity, dist }
  const buoys = [];
  const flames = [];
  const trees = [];        // { x, y, z, s, yaw, phase, tone }
  const petals = [];       // { x, y, z, r, rot }
  const stalks = [];       // { x, y, z, h, w, yaw, leanX, leanZ, phase, tone }
  const lanterns = [];     // { x, y, z, r, color }
  const banners = new Map(); // 같은 그림끼리 한 메시: key → { tex, pos, nor, uv, idx, sway }
  const unitCylG = getUnitCyl();

  const addPipe = (mat, from, to, r) => {
    if (!pipes.has(mat)) pipes.set(mat, []);
    pipes.get(mat).push(pipeMatrix(from, to, r));
  };
  /** 로컬 좌표(rotY 회전 + 원점 이동) 파이프 */
  const localPipe = (mat, T, a, b, r) => addPipe(mat, T(a), T(b), r);
  const localBox = (mat, T, rot, cx, cy, cz, w, h, d) => {
    const geo = new THREE.BoxGeometry(w, h, d);
    const p = T([cx, cy, cz]);
    tmpM.compose(tmpP.set(p[0], p[1], p[2]), tmpQ.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rot), tmpS.set(1, 1, 1));
    env.batch(mat).addGeometry(geo, tmpM);
    geo.dispose();
  };
  const localCylY = (mat, T, cx, y0, cz, r, h) => {
    const p = T([cx, y0, cz]);
    const b = env.batch(mat);
    b.addCylinder(p[0], p[1], p[2], r, h, b.scale || 1, { segments: 14 });
  };
  const makeT = (x, y, z, rot) => {
    const c = Math.cos(rot), s = Math.sin(rot);
    // three rotation.y: x' = x c + z s, z' = -x s + z c
    return (p) => [x + p[0] * c + p[2] * s, y + p[1], z - p[0] * s + p[2] * c];
  };

  const items = Array.isArray(list) ? list : [];
  if (items.length > LIMITS.DECOR) {
    counts.skipped += items.length - LIMITS.DECOR;
    env.warn && env.warn(`decor ${items.length} > ${LIMITS.DECOR}: the rest are skipped`);
  }
  for (const d of items.slice(0, LIMITS.DECOR)) {
    if (!d || typeof d !== 'object') { counts.skipped++; continue; }
    try {
      switch (d.type) {
        case 'pipe': {
          if (!Array.isArray(d.from) || !Array.isArray(d.to)) throw new Error('pipe needs from/to');
          const r = +d.r > 0 ? +d.r : 0.2;
          addPipe(d.mat || 'pipe', d.from.map(Number), d.to.map(Number), r);
          counts.pipe++;
          break;
        }
        case 'sign': {
          const w = +d.w > 0 ? +d.w : 3, h = +d.h > 0 ? +d.h : 0.8;
          const tex = makeSignTexture(d.text, w, h, d.bg || '#0b2545', d.fg || '#ffffff');
          const mat = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false });
          const geo = new THREE.PlaneGeometry(w, h);
          const mesh = new THREE.Mesh(geo, mat);
          // 규약: sign.rotY는 three.js rotation.y에 그대로(라디안). rotY=0이면 앞면이 +z(남)를 향함
          const rot = Number(d.rotY) || 0;
          const cx = +d.x || 0, cy = Number.isFinite(+d.y) ? +d.y : 2, cz = +d.z || 0;
          mesh.position.set(cx, cy, cz);
          mesh.rotation.y = rot;
          // 앞면을 테두리 판보다 살짝 앞으로
          mesh.translateZ(0.031);
          mesh.name = 'sign';
          env.group.add(mesh);
          disposables.push(geo, mat, tex);
          // 뒤판(두께 6 cm, steel)
          const T = makeT(cx, cy, cz, rot);
          localBox('steel', T, rot, 0, 0, 0, w + 0.08, h + 0.08, 0.06);
          counts.sign++;
          break;
        }
        case 'light': {
          const color = new THREE.Color(d.color || '#ffe8b0');
          bulbs.push({ x: +d.x || 0, y: +d.y || 3, z: +d.z || 0, color, intensity: +d.intensity > 0 ? +d.intensity : 1, dist: +d.dist > 0 ? +d.dist : 12 });
          // 등기구 갓
          const sb = env.batch('steel');
          sb.addBox((+d.x || 0) - 0.2, (+d.y || 3) + 0.1, (+d.z || 0) - 0.2, (+d.x || 0) + 0.2, (+d.y || 3) + 0.22, (+d.z || 0) + 0.2, sb.scale || 2);
          counts.light++;
          break;
        }
        case 'loadingArm': {
          const rot = toRad(d.rotY || 0);
          const T = makeT(+d.x || 0, +d.y || 0, +d.z || 0, rot);
          // 받침 + 라이저(세로 기둥)
          localBox('steel', T, rot, 0, 0.15, 0, 1.5, 0.3, 1.5);
          localCylY('white', T, 0, 0.3, 0, 0.36, 5.4);
          // 상부 트러니언(가로 축)
          localPipe('steel', T, [-0.6, 5.85, 0], [0.6, 5.85, 0], 0.42);
          // 평형추 + 연결 빔
          localPipe('steel', T, [0, 5.85, 0], [0, 5.55, -1.3], 0.16);
          localBox('steel', T, rot, 0, 5.15, -1.5, 1.1, 0.9, 0.7);
          // 내측 팔(위·바깥으로) + 정점 스위블
          localPipe('yellow', T, [0, 5.85, 0], [0, 9.7, 2.3], 0.26);
          localPipe('steel', T, [-0.4, 9.7, 2.3], [0.4, 9.7, 2.3], 0.34);
          // 외측 팔(아래·바깥으로)
          localPipe('yellow', T, [0, 9.7, 2.3], [0, 3.3, 4.9], 0.23);
          // 유압 실린더
          localPipe('steel', T, [0.3, 4.6, 0.25], [0.3, 7.4, 1.15], 0.07);
          // 끝단 스위블·커플러
          localPipe('steel', T, [0, 3.3, 4.9], [0, 2.2, 4.9], 0.2);
          localPipe('steel', T, [0, 2.2, 4.9], [0, 2.2, 5.5], 0.2);
          localPipe('rust', T, [0, 2.2, 5.5], [0, 2.2, 5.62], 0.34);
          counts.loadingArm++;
          break;
        }
        case 'flare': {
          const H = +d.h > 4 ? +d.h : 14;
          const x = +d.x || 0, y = +d.y || 0, z = +d.z || 0;
          const T = makeT(x, y, z, 0);
          // 탑(흰색 + 상단 빨간 띠) · 받침 다리 3개 · 중간 받침판 · 팁
          localCylY('white', T, 0, 0, 0, 0.34, H - 2.2);
          localCylY('container_red', T, 0, H - 2.2, 0, 0.35, 0.9);
          localCylY('white', T, 0, H - 1.3, 0, 0.34, 0.8);
          localCylY('container_red', T, 0, H - 0.5, 0, 0.36, 0.5);
          localCylY('rust', T, 0, H, 0, 0.44, 0.45);
          for (let k = 0; k < 3; k++) {
            const a = (k / 3) * Math.PI * 2;
            localPipe('steel', T, [Math.cos(a) * 1.7, 0, Math.sin(a) * 1.7], [Math.cos(a) * 0.36, H * 0.55, Math.sin(a) * 0.36], 0.08);
          }
          localCylY('steel', T, 0, H * 0.7, 0, 0.95, 0.1);
          // 불꽃(애니메이션)
          const fmat = new THREE.SpriteMaterial({ map: getFlameTex(), color: 0xffffff, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: true });
          const s1 = new THREE.Sprite(fmat), s2 = new THREE.Sprite(fmat);
          s1.center.set(0.5, 0.02); s2.center.set(0.5, 0.02);
          s1.position.set(x, y + H + 0.4, z); s2.position.set(x + 0.15, y + H + 0.4, z - 0.1);
          const gmat = new THREE.SpriteMaterial({ map: getGlowTex(), color: 0xff8a30, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.55, fog: true });
          const glow = new THREE.Sprite(gmat);
          glow.position.set(x, y + H + 1.6, z);
          glow.scale.set(7, 7, 1);
          env.group.add(s1, s2, glow);
          disposables.push(fmat, gmat);
          flames.push({ s1, s2, glow, seed: Math.random() * 100 });
          bulbs.push({ x, y: y + H + 1.5, z, color: new THREE.Color('#ff9a40'), intensity: 2.2, dist: 30, flare: flames[flames.length - 1], hidden: true });
          counts.flare++;
          break;
        }
        case 'buoy': {
          const r = +d.r > 0 ? +d.r : 0.6;
          const x = +d.x || 0, z = +d.z || 0;
          buoys.push({ x, z, r, y: Number.isFinite(+d.y) ? +d.y : env.waterY(x, z), color: d.color || null, phase: Math.random() * Math.PI * 2 });
          counts.buoy++;
          break;
        }
        case 'tree': {
          const x = +d.x || 0, z = +d.z || 0, y = numOr(d.y, 0);
          const h = +d.h > 1 ? +d.h : 5.5;
          const spread = +d.r > 0.3 ? +d.r : h * 0.46;
          const rnd = seededRand(x, z);
          const crown = h * 0.6, rb = 0.1 + h * 0.024;
          const T = makeT(x, y, z, rnd() * TAU);
          const trunk = new THREE.CylinderGeometry(rb * 0.62, rb, crown, 8, 1, true);
          tmpM.compose(tmpP.set(x, y + crown / 2, z), tmpQ.identity(), tmpS.set(1, 1, 1));
          env.batch('wood_dark').addGeometry(trunk, tmpM);
          trunk.dispose();
          for (let k = 0; k < 4; k++) {
            const a = (k / 4) * TAU + rnd() * 0.7, out = spread * (0.45 + rnd() * 0.2);
            localPipe('wood_dark', T, [0, crown * (0.62 + rnd() * 0.2), 0], [Math.cos(a) * out, crown + h * 0.12, Math.sin(a) * out], rb * 0.34);
          }
          trees.push({ x, y: y + crown + h * 0.16, z, s: spread, yaw: rnd() * TAU, phase: rnd() * TAU, tone: 0.92 + rnd() * 0.16 });
          if (d.petals !== false) petals.push({ x, y, z, r: spread * 1.25, rot: rnd() * TAU });
          counts.tree++;
          break;
        }
        case 'bamboo': {
          const x = +d.x || 0, z = +d.z || 0, y = numOr(d.y, 0);
          const h = +d.h > 1 ? +d.h : 6;
          const n = Math.max(1, Math.min(16, Math.round(+d.n) || 7));
          const spread = +d.r > 0 ? +d.r : 0.9;
          const rnd = seededRand(x, z, 2);
          for (let i = 0; i < n; i++) {
            const a = rnd() * TAU, rr = spread * Math.sqrt(rnd());
            stalks.push({
              x: x + Math.cos(a) * rr, y, z: z + Math.sin(a) * rr,
              h: h * (0.72 + rnd() * 0.38), w: 0.85 + rnd() * 0.4, yaw: rnd() * TAU,
              leanX: (rnd() - 0.5) * 0.07, leanZ: (rnd() - 0.5) * 0.07, phase: rnd() * TAU, tone: 0.85 + rnd() * 0.3
            });
          }
          counts.bamboo++;
          break;
        }
        case 'lantern': {
          const x = +d.x || 0, z = +d.z || 0, y = numOr(d.y, 2.4);
          const r = +d.r > 0 ? +d.r : 0.28;
          const cord = numOr(d.cord, 0.5);
          lanterns.push({ x, y, z, r, color: new THREE.Color(d.color || '#ffb35c') });
          const T = makeT(x, y, z, 0);
          const edge = r * LANTERN_TALL;
          localCylY('metal_dark', T, 0, edge * 0.93, 0, r * 0.42, 0.05);
          localCylY('metal_dark', T, 0, -edge * 0.93 - 0.05, 0, r * 0.42, 0.05);
          if (cord > 0) addPipe('metal_dark', [x, y + edge, z], [x, y + edge + cord, z], 0.012);
          counts.lantern++;
          break;
        }
        case 'banner': {
          const w = +d.w > 0 ? +d.w : 1.2, h = +d.h > 0 ? +d.h : 3;
          const x = +d.x || 0, z = +d.z || 0, y = numOr(d.y, 3);
          const rot = toRad(d.rotY || 0), bg = d.bg || '#7a1f3d', fg = d.fg || '#ffe9f0', emblem = d.emblem || null;
          const key = JSON.stringify([d.text == null ? '' : String(d.text), w, h, bg, fg, emblem]);
          let b = banners.get(key);
          if (!b) {
            b = { tex: makeBannerTexture(d.text, w, h, bg, fg, emblem), pos: [], nor: [], uv: [], idx: [], sway: [] };
            banners.set(key, b);
          }
          const T = makeT(x, y, z, rot);
          const nx = Math.sin(rot), nz = Math.cos(rot), phase = seededRand(x, z, 3)() * TAU;
          addBannerSheet(b, T, nx, nz, w, h, false, phase);
          addBannerSheet(b, T, nx, nz, w, h, true, phase);
          localPipe('wood_dark', T, [-w / 2 - 0.08, h / 2 + 0.01, 0], [w / 2 + 0.08, h / 2 + 0.01, 0], 0.025);
          counts.banner++;
          break;
        }
        case 'rope': {
          if (!Array.isArray(d.from) || !Array.isArray(d.to)) throw new Error('rope needs from/to');
          const a = d.from.map(Number), b = d.to.map(Number);
          const span = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
          const sag = numOr(d.sag, span * 0.06), r = +d.r > 0 ? +d.r : 0.022;
          const segs = Math.max(4, Math.min(10, Math.ceil(span / 1.5)));
          const at = (f) => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f - 4 * sag * f * (1 - f), a[2] + (b[2] - a[2]) * f];
          for (let k = 0; k < segs; k++) addPipe(d.mat || 'wood', at(k / segs), at((k + 1) / segs), r);
          counts.rope++;
          break;
        }
        case 'vent': {
          const w = +d.w > 0 ? +d.w : 1.2, h = +d.h > 0 ? +d.h : 0.8, dp = +d.d > 0 ? +d.d : 0.16;
          const rot = toRad(d.rotY || 0), mat = d.mat || 'metal_dark', f = 0.05;
          const T = makeT(+d.x || 0, numOr(d.y, 2), +d.z || 0, rot);
          localBox(mat, T, rot, 0, 0, 0.01, w, h, 0.02);
          localBox(mat, T, rot, 0, h / 2 - f / 2, dp / 2, w, f, dp);
          localBox(mat, T, rot, 0, -h / 2 + f / 2, dp / 2, w, f, dp);
          localBox(mat, T, rot, -w / 2 + f / 2, 0, dp / 2, f, h - f * 2, dp);
          localBox(mat, T, rot, w / 2 - f / 2, 0, dp / 2, f, h - f * 2, dp);
          const slats = Math.max(3, Math.round((h - f * 2) / 0.11));
          for (let k = 0; k < slats; k++) {
            const sy = -h / 2 + f + ((k + 0.5) / slats) * (h - f * 2);
            localBox('steel', T, rot, 0, sy, dp * 0.55, w - f * 2, 0.04, dp * 0.6);
          }
          counts.vent++;
          break;
        }
        case 'crateStack': {
          const x = +d.x || 0, z = +d.z || 0, y = numOr(d.y, 0);
          const size = +d.size > 0 ? +d.size : 1.1;
          const levels = Math.max(1, Math.min(3, Math.round(+d.levels) || 2));
          const rot = toRad(d.rotY || 0), mat = d.mat || 'wood';
          const T = makeT(x, y, z, rot);
          const rnd = seededRand(x, z, 4);
          for (let lv = 0; lv < levels; lv++) {
            const n = levels - lv;
            for (let a = 0; a < n; a++) {
              for (let b = 0; b < n; b++) {
                if (lv > 0 && n > 1 && rnd() < 0.2) continue;
                const s = size * (0.92 + rnd() * 0.08);
                const cx = (a - (n - 1) / 2) * size * 1.02 + (rnd() - 0.5) * 0.04;
                const cz = (b - (n - 1) / 2) * size * 1.02 + (rnd() - 0.5) * 0.04;
                localBox(mat, T, rot + (rnd() - 0.5) * 0.16, cx, lv * size * 0.98 + s / 2, cz, s, s, s);
              }
            }
          }
          counts.crateStack++;
          break;
        }
        default:
          counts.skipped++;
          env.warn && env.warn('unknown decor type: ' + d.type);
      }
    } catch (err) {
      counts.skipped++;
      env.warn && env.warn('decor skipped (' + d.type + '): ' + err.message);
    }
  }

  // 파이프: 재질별 InstancedMesh
  for (const [mat, mats] of pipes) {
    const im = new THREE.InstancedMesh(unitCylG, env.material(mat), mats.length);
    mats.forEach((m, i) => im.setMatrixAt(i, m));
    im.instanceMatrix.needsUpdate = true;
    im.castShadow = true; im.receiveShadow = true;
    im.computeBoundingSphere();
    im.name = 'pipes:' + mat;
    env.group.add(im);
    disposables.push(im);
  }

  // 전구: InstancedMesh(발광) + 빛무리 스프라이트 + 실제 조명은 상위 N개만
  const visibleBulbs = bulbs.filter((b) => !b.hidden);
  if (visibleBulbs.length) {
    const bmat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
    const im = new THREE.InstancedMesh(getUnitSphere(), bmat, visibleBulbs.length);
    visibleBulbs.forEach((b, i) => {
      tmpM.compose(tmpP.set(b.x, b.y, b.z), tmpQ.identity(), tmpS.set(0.13, 0.1, 0.13));
      im.setMatrixAt(i, tmpM);
      im.setColorAt(i, b.color.clone().multiplyScalar(1.4));
    });
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    im.computeBoundingSphere();
    env.group.add(im);
    disposables.push(im, bmat);
    for (const b of visibleBulbs) {
      const gm = new THREE.SpriteMaterial({ map: getGlowTex(), color: b.color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.5, fog: true });
      const sp = new THREE.Sprite(gm);
      sp.position.set(b.x, b.y - 0.05, b.z);
      const s = 0.9 + Math.min(2, b.intensity) * 0.5;
      sp.scale.set(s, s, 1);
      env.group.add(sp);
      disposables.push(gm);
    }
  }
  // 규약: 실제 PointLight는 상한(LIMITS.REAL_LIGHTS) 안에서 decor 배열 앞쪽 light부터. 나머지는 발광 메시+빛무리(가짜 조명).
  //       light가 상한보다 적으면 남는 자리를 flare 불꽃이 (배열 순서대로) 쓴다.
  const realLights = [];
  const chosen = bulbs.filter((b) => !b.flare).slice(0, LIMITS.REAL_LIGHTS);
  chosen.push(...bulbs.filter((b) => b.flare).slice(0, Math.max(0, LIMITS.REAL_LIGHTS - chosen.length)));
  chosen.forEach((b) => {
    const L = new THREE.PointLight(b.color, b.intensity * 6, b.dist * 1.3, 1.6);
    L.position.set(b.x, b.y - 0.15, b.z);
    L.castShadow = false;
    env.group.add(L);
    realLights.push({ light: L, base: L.intensity, flare: b.flare || null });
  });

  // 부표: 한 지오메트리(정점색) × InstancedMesh(인스턴스 색)
  let buoyMesh = null;
  if (buoys.length) {
    const parts = [];
    const add = (g, color, y) => { g.translate(0, y, 0); const n = g.attributes.position.count; const c = new THREE.Color(color); const arr = new Float32Array(n * 3); for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; } g.setAttribute('color', new THREE.BufferAttribute(arr, 3)); parts.push(g); };
    add(new THREE.CylinderGeometry(1, 0.85, 0.9, 16), 0xffffff, 0.15);       // 몸통 (y -0.3 ~ 0.6)
    add(new THREE.CylinderGeometry(1.03, 1.03, 0.14, 16), 0xf2f2f2, 0.45);    // 흰 띠
    add(new THREE.CylinderGeometry(0.5, 0.95, 0.4, 16), 0xffffff, 0.8);       // 원뿔대
    add(new THREE.CylinderGeometry(0.06, 0.06, 1.3, 6), 0x333333, 1.65);      // 마스트
    add(new THREE.SphereGeometry(0.2, 10, 8), 0xffffff, 2.35);                // 두표
    const merged = mergeSimple(parts);
    parts.forEach((g) => g.dispose());
    const bm = new THREE.MeshLambertMaterial({ vertexColors: true });
    buoyMesh = new THREE.InstancedMesh(merged, bm, buoys.length);
    const palette = [0xc8302a, 0x2e8b45, 0xe8b417];
    buoys.forEach((b, i) => buoyMesh.setColorAt(i, new THREE.Color(b.color || palette[i % 3])));
    if (buoyMesh.instanceColor) buoyMesh.instanceColor.needsUpdate = true;
    buoyMesh.castShadow = true;
    env.group.add(buoyMesh);
    disposables.push(buoyMesh, merged, bm);
  }

  // 벚꽃 덩어리: 한 지오메트리 × 인스턴스
  let treeMesh = null;
  if (trees.length) {
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0x2a141e });
    treeMesh = new THREE.InstancedMesh(getBlossomGeo(), mat, trees.length);
    trees.forEach((t, i) => treeMesh.setColorAt(i, tmpC.setRGB(t.tone, t.tone * 0.97, t.tone)));
    treeMesh.instanceColor.needsUpdate = true;
    treeMesh.castShadow = true;
    treeMesh.name = 'tree-blossom';
    env.group.add(treeMesh);
    disposables.push(treeMesh, mat);
  }
  if (petals.length) {
    const gb = new GeoBatch();
    for (const p of petals) {
      const c = Math.cos(p.rot), s = Math.sin(p.rot), y = p.y + 0.025;
      const V = (lx, lz, u, v) => [p.x + lx * c + lz * s, y, p.z - lx * s + lz * c, u, v];
      gb.quad(V(-p.r, p.r, 0, 0), V(p.r, p.r, 1, 0), V(p.r, -p.r, 1, 1), V(-p.r, -p.r, 0, 1), [0, 1, 0], 1);
    }
    const geo = gb.build();
    const mat = new THREE.MeshLambertMaterial({ map: getPetalTex(), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.name = 'tree-petals';
    env.group.add(mesh);
    disposables.push(geo, mat);
  }

  // 대나무: 한 지오메트리 × 인스턴스
  let stalkMesh = null;
  if (stalks.length) {
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    stalkMesh = new THREE.InstancedMesh(getStalkGeo(), mat, stalks.length);
    stalks.forEach((s, i) => stalkMesh.setColorAt(i, tmpC.setRGB(s.tone, s.tone, s.tone)));
    stalkMesh.instanceColor.needsUpdate = true;
    stalkMesh.castShadow = true;
    stalkMesh.name = 'bamboo';
    env.group.add(stalkMesh);
    disposables.push(stalkMesh, mat);
  }

  // 종이 등: 몸통 인스턴스 + 빛무리 점 한 묶음(실제 조명 없음)
  let lanternHalo = null;
  if (lanterns.length) {
    const bodyMat = new THREE.MeshBasicMaterial({ map: getRibTex(), toneMapped: false });
    const im = new THREE.InstancedMesh(getUnitSphere(), bodyMat, lanterns.length);
    const pos = new Float32Array(lanterns.length * 3), col = new Float32Array(lanterns.length * 3);
    lanterns.forEach((l, i) => {
      tmpM.compose(tmpP.set(l.x, l.y, l.z), tmpQ.identity(), tmpS.set(l.r, l.r * LANTERN_TALL, l.r));
      im.setMatrixAt(i, tmpM);
      im.setColorAt(i, tmpC.copy(l.color).multiplyScalar(1.25));
      pos[i * 3] = l.x; pos[i * 3 + 1] = l.y; pos[i * 3 + 2] = l.z;
      col[i * 3] = l.color.r; col[i * 3 + 1] = l.color.g; col[i * 3 + 2] = l.color.b;
    });
    im.instanceMatrix.needsUpdate = true;
    im.instanceColor.needsUpdate = true;
    im.computeBoundingSphere();
    im.name = 'lanterns';
    env.group.add(im);
    disposables.push(im, bodyMat);
    const haloGeo = new THREE.BufferGeometry();
    haloGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    haloGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const haloMat = new THREE.PointsMaterial({
      map: getGlowTex(), size: 2.1, sizeAttenuation: true, vertexColors: true, transparent: true, opacity: 0.6,
      depthWrite: false, blending: THREE.AdditiveBlending, fog: false, toneMapped: false
    });
    lanternHalo = new THREE.Points(haloGeo, haloMat);
    lanternHalo.name = 'lantern-halo';
    env.group.add(lanternHalo);
    disposables.push(haloGeo, haloMat);
  }

  // 현수막: 같은 그림끼리 한 메시. 아랫단만 살짝 흔들린다
  const bannerMeshes = [];
  for (const b of banners.values()) {
    const pos = new Float32Array(b.pos);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(b.nor, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
    geo.setIndex(b.idx);
    geo.computeBoundingSphere();
    const mat = new THREE.MeshLambertMaterial({ map: b.tex, alphaTest: 0.5 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = 'banner';
    env.group.add(mesh);
    disposables.push(geo, mat, b.tex);
    bannerMeshes.push({ attr: geo.attributes.position, base: pos.slice(), sway: Float32Array.from(b.sway) });
  }

  const e = new THREE.Euler();
  function update(dt, t) {
    for (const f of flames) {
      const k = 1 + 0.18 * Math.sin(t * 13 + f.seed) + 0.1 * Math.sin(t * 29 + f.seed * 2);
      f.s1.scale.set(1.5 * k, 3.4 * k, 1);
      f.s2.scale.set(1.1 * (2 - k), 2.6 * (2 - k * 0.8), 1);
      f.s1.material.rotation = 0.06 * Math.sin(t * 2 + f.seed);
      f.glow.material.opacity = 0.42 + 0.12 * k;
    }
    for (const L of realLights) if (L.flare) L.light.intensity = L.base * (0.8 + 0.25 * Math.sin(t * 17 + L.flare.seed));
    if (buoyMesh) {
      buoys.forEach((b, i) => {
        const bob = Math.sin(t * 1.3 + b.phase) * 0.07 * b.r;
        e.set(Math.sin(t * 0.9 + b.phase) * 0.06, 0, Math.cos(t * 1.1 + b.phase) * 0.06);
        tmpQ.setFromEuler(e);
        tmpM.compose(tmpP.set(b.x, b.y + bob, b.z), tmpQ, tmpS.set(b.r, b.r, b.r));
        buoyMesh.setMatrixAt(i, tmpM);
      });
      buoyMesh.instanceMatrix.needsUpdate = true;
      if (!buoyMesh.boundingSphere) buoyMesh.computeBoundingSphere();
    }
    if (treeMesh) {
      for (let i = 0; i < trees.length; i++) {
        const b = trees[i];
        e.set(Math.sin(t * 0.8 + b.phase) * 0.016, b.yaw, Math.cos(t * 0.63 + b.phase) * 0.016);
        tmpM.compose(tmpP.set(b.x, b.y, b.z), tmpQ.setFromEuler(e), tmpS.set(b.s, b.s * 0.88, b.s));
        treeMesh.setMatrixAt(i, tmpM);
      }
      treeMesh.instanceMatrix.needsUpdate = true;
    }
    if (stalkMesh) {
      for (let i = 0; i < stalks.length; i++) {
        const b = stalks[i];
        e.set(b.leanX + Math.sin(t * 0.9 + b.phase) * 0.012, b.yaw, b.leanZ + Math.cos(t * 0.75 + b.phase) * 0.012);
        tmpM.compose(tmpP.set(b.x, b.y, b.z), tmpQ.setFromEuler(e), tmpS.set(b.w, b.h / 6, b.w));
        stalkMesh.setMatrixAt(i, tmpM);
      }
      stalkMesh.instanceMatrix.needsUpdate = true;
    }
    if (lanternHalo) lanternHalo.material.opacity = 0.56 + 0.06 * Math.sin(t * 2.1);
    for (const b of bannerMeshes) {
      const a = b.attr.array, n = a.length / 3;
      for (let v = 0; v < n; v++) {
        const off = Math.sin(t * 1.7 + b.sway[v * 4 + 3]) * b.sway[v * 4 + 2];
        a[v * 3] = b.base[v * 3] + b.sway[v * 4] * off;
        a[v * 3 + 2] = b.base[v * 3 + 2] + b.sway[v * 4 + 1] * off;
      }
      b.attr.needsUpdate = true;
    }
  }
  if (buoyMesh || treeMesh || stalkMesh) {
    update(0, 0);
    if (buoyMesh) buoyMesh.computeBoundingSphere();
    if (treeMesh) treeMesh.computeBoundingSphere();
    if (stalkMesh) stalkMesh.computeBoundingSphere();
  }

  function dispose() {
    for (const d of disposables) if (d && d.dispose) d.dispose();
    disposables.length = 0;
    for (const L of realLights) L.light.dispose && L.light.dispose();
  }

  const animated = flames.length + buoys.length + trees.length + stalks.length + lanterns.length + bannerMeshes.length > 0;
  return { update, dispose, counts, lightCount: realLights.length, animated };
}

/* ---------------- 발판·포털 표시 ---------------- */

function paintPadDisc(g, S) {
  const c = S / 2;
  const fill = g.createRadialGradient(c, c, 0, c, c, c);
  fill.addColorStop(0, 'rgba(255,255,255,0.55)');
  fill.addColorStop(0.55, 'rgba(255,255,255,0.22)');
  fill.addColorStop(0.92, 'rgba(255,255,255,0.12)');
  fill.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = fill;
  g.fillRect(0, 0, S, S);
  g.strokeStyle = '#ffffff';
  g.lineWidth = S * 0.035;
  g.beginPath(); g.arc(c, c, S * 0.455, 0, TAU); g.stroke();
  g.lineWidth = S * 0.012;
  g.beginPath(); g.arc(c, c, S * 0.3, 0, TAU); g.stroke();
  // 눈금: 원판이 도는 것이 보이게 한다
  g.lineWidth = S * 0.035;
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * TAU;
    g.beginPath(); g.arc(c, c, S * 0.38, a, a + TAU / 16); g.stroke();
  }
}

function paintChevron(g, S) {
  g.strokeStyle = '#ffffff';
  g.lineWidth = S * 0.13;
  g.lineJoin = 'miter';
  g.lineCap = 'butt';
  g.shadowColor = '#ffffff';
  g.shadowBlur = S * 0.08;
  g.beginPath();
  g.moveTo(S * 0.16, S * 0.74);
  g.lineTo(S * 0.5, S * 0.34);
  g.lineTo(S * 0.84, S * 0.74);
  g.stroke();
}

function paintSwirl(g, S, arms, twist) {
  const c = S / 2;
  g.fillStyle = 'rgba(255,255,255,0.2)';
  g.fillRect(0, 0, S, S);
  g.lineCap = 'round';
  for (let arm = 0; arm < arms; arm++) {
    const a0 = (arm / arms) * TAU;
    for (let i = 0; i < 64; i++) {
      const t0 = i / 64, t1 = (i + 1) / 64;
      const r0 = c * (0.04 + t0 * 0.96), r1 = c * (0.04 + t1 * 0.96);
      const b0 = a0 + t0 * twist, b1 = a0 + t1 * twist;
      // 가장자리로 갈수록 사라져서 회전해도 사각형 테두리에 무늬가 끊기지 않는다
      g.strokeStyle = `rgba(255,255,255,${0.75 * (1 - t0) * (1 - t0)})`;
      g.lineWidth = S * (0.012 + 0.05 * t0);
      g.beginPath();
      g.moveTo(c + Math.cos(b0) * r0, c + Math.sin(b0) * r0);
      g.lineTo(c + Math.cos(b1) * r1, c + Math.sin(b1) * r1);
      g.stroke();
    }
  }
  const core = g.createRadialGradient(c, c, 0, c, c, S * 0.2);
  core.addColorStop(0, 'rgba(255,255,255,0.7)');
  core.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = core;
  g.fillRect(0, 0, S, S);
}

/** 발판 위로 흐르는 화살표 기둥: 위로 갈수록 투명해지는 타원통 */
function addPadColumn(p, pos, uv, col, idx) {
  const N = 20, FADE = [[0, 0.9], [0.45, 0.5], [1, 0]];
  const rx = p.w * 0.46, rz = p.d * 0.46;
  const H = Math.min(2.6, 1.3 + Math.min(p.w, p.d) * 0.35);
  const around = Math.max(3, Math.round((Math.PI * (rx + rz)) / 1.1));
  const c = new THREE.Color(p.color);
  const base = pos.length / 3;
  for (const [f, alpha] of FADE) {
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * TAU;
      pos.push(p.x + Math.cos(a) * rx, p.y + 0.04 + f * H, p.z + Math.sin(a) * rz);
      uv.push((i / N) * around, (f * H) / 0.75);
      col.push(c.r, c.g, c.b, alpha);
    }
  }
  for (let r = 0; r < FADE.length - 1; r++) {
    for (let i = 0; i < N; i++) {
      const a = base + r * (N + 1) + i, b = a + N + 1;
      idx.push(a, b, b + 1, a, b + 1, a + 1);
    }
  }
}

/**
 * 발판·포털을 그린다. 실제 조명 없이 발광 재질만 쓰고 모두 합쳐 드로우콜 몇 개로 끝낸다.
 * @param {{pads:object[], portals:object[]}} triggers world.triggers
 * @param {{group:THREE.Object3D}} env
 * @returns {{update(dt:number,t:number):void, dispose():void, drawCalls:number}}
 */
export function buildTriggerVisuals(triggers, env) {
  const pads = (triggers && triggers.pads) || [], portals = (triggers && triggers.portals) || [];
  if (!pads.length && !portals.length) return { update() {}, dispose() {}, drawCalls: 0 };

  const disposables = [];
  let drawCalls = 0;
  const addMesh = (geo, mat, name, order) => {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = name;
    mesh.renderOrder = order;
    env.group.add(mesh);
    disposables.push(geo, mat);
    drawCalls++;
    return mesh;
  };

  // 바닥 원판(발판 + 포털 발밑): 한 메시, 정점색
  const discTex = canvasTexture(256, 256, paintPadDisc);
  discTex.center.set(0.5, 0.5);
  disposables.push(discTex);
  const discs = new GeoBatch({ colors: true });
  const addDisc = (x, y, z, w, d, color) => {
    const x0 = x - w / 2, x1 = x + w / 2, z0 = z - d / 2, z1 = z + d / 2, yy = y + 0.03;
    discs.setColor(color);
    discs.quad([x0, yy, z1, 0, 0], [x1, yy, z1, 1, 0], [x1, yy, z0, 1, 1], [x0, yy, z0, 0, 1], [0, 1, 0], 1);
  };
  for (const p of pads) addDisc(p.x, p.y, p.z, p.w, p.d, p.color);
  for (const p of portals) addDisc(p.x, p.y, p.z, p.w + 0.8, Math.max(p.d, 1) + 0.8, p.color);
  const discMat = new THREE.MeshBasicMaterial({
    map: discTex, vertexColors: true, transparent: true, depthWrite: false, toneMapped: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2
  });
  addMesh(discs.build(), discMat, 'pad-discs', 1);

  // 발판 화살표 기둥: 한 메시, 텍스처를 위로 흘린다
  let chevTex = null;
  if (pads.length) {
    chevTex = canvasTexture(128, 128, paintChevron, true);
    disposables.push(chevTex);
    const pos = [], uv = [], col = [], idx = [];
    for (const p of pads) addPadColumn(p, pos, uv, col, idx);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
    geo.setIndex(idx);
    geo.computeBoundingSphere();
    const mat = new THREE.MeshBasicMaterial({
      map: chevTex, vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false
    });
    addMesh(geo, mat, 'pad-chevrons', 3);
  }

  // 포털: 발광 테두리 + 소용돌이 면 두 겹(서로 반대로 돈다)
  let swirlA = null, swirlB = null, swirlMatA = null, swirlMatB = null;
  if (portals.length) {
    const frames = new GeoBatch({ colors: true });
    const sheets = new GeoBatch({ colors: true });
    const F = 0.12;
    for (const p of portals) {
      const y0 = p.y, y1 = p.y + p.h;
      frames.setColor(p.color);
      sheets.setColor(p.color);
      const near = Math.min(p.w, p.d) / Math.max(p.w, p.d) > 0.7;
      if (p.w >= p.d || near) {
        // x 방향으로 펼친 면
        const zc = p.z;
        frames.addBox(p.minX - F, y0, zc - F / 2, p.minX, y1 + F, zc + F / 2, 1);
        frames.addBox(p.maxX, y0, zc - F / 2, p.maxX + F, y1 + F, zc + F / 2, 1);
        frames.addBox(p.minX, y1, zc - F / 2, p.maxX, y1 + F, zc + F / 2, 1);
        sheets.quad([p.minX, y0, zc, 0, 0], [p.maxX, y0, zc, 1, 0], [p.maxX, y1, zc, 1, 1], [p.minX, y1, zc, 0, 1], [0, 0, 1], 1);
      }
      if (p.w < p.d || near) {
        // z 방향으로 펼친 면
        const xc = p.x;
        frames.addBox(xc - F / 2, y0, p.minZ - F, xc + F / 2, y1 + F, p.minZ, 1);
        frames.addBox(xc - F / 2, y0, p.maxZ, xc + F / 2, y1 + F, p.maxZ + F, 1);
        frames.addBox(xc - F / 2, y1, p.minZ, xc + F / 2, y1 + F, p.maxZ, 1);
        sheets.quad([xc, y0, p.maxZ, 0, 0], [xc, y0, p.minZ, 1, 0], [xc, y1, p.minZ, 1, 1], [xc, y1, p.maxZ, 0, 1], [1, 0, 0], 1);
      }
    }
    addMesh(frames.build(), new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }), 'portal-frames', 0);

    swirlA = canvasTexture(256, 256, (g, S) => paintSwirl(g, S, 3, 4.2));
    swirlB = canvasTexture(256, 256, (g, S) => paintSwirl(g, S, 2, -6));
    swirlA.center.set(0.5, 0.5);
    swirlB.center.set(0.5, 0.5);
    disposables.push(swirlA, swirlB);
    const sheetGeo = sheets.build();
    const sheetMat = (map, opacity) => new THREE.MeshBasicMaterial({
      map, vertexColors: true, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide, toneMapped: false
    });
    swirlMatA = sheetMat(swirlA, 0.85);
    swirlMatB = sheetMat(swirlB, 0.55);
    addMesh(sheetGeo, swirlMatA, 'portal-swirl-a', 3);
    addMesh(sheetGeo, swirlMatB, 'portal-swirl-b', 4);
  }

  return {
    drawCalls,
    update(dt, t) {
      discTex.rotation = (discTex.rotation + dt * 0.9) % TAU;
      discMat.opacity = 0.84 + 0.16 * Math.sin(t * 3.2);
      if (chevTex) chevTex.offset.y = (chevTex.offset.y - dt * 0.85) % 1;
      if (swirlA) {
        swirlA.rotation = (swirlA.rotation - dt * 1.5) % TAU;
        swirlB.rotation = (swirlB.rotation + dt * 2.1) % TAU;
        swirlMatA.opacity = 0.78 + 0.1 * Math.sin(t * 2.3);
      }
    },
    dispose() {
      for (const d of disposables) d.dispose();
      disposables.length = 0;
    }
  };
}

/** 같은 속성 구성(position/normal/uv/color, index)의 지오메트리 합치기 */
function mergeSimple(geos) {
  let vc = 0, ic = 0;
  for (const g of geos) { vc += g.attributes.position.count; ic += g.index ? g.index.count : g.attributes.position.count; }
  const pos = new Float32Array(vc * 3), nor = new Float32Array(vc * 3), uv = new Float32Array(vc * 2), col = new Float32Array(vc * 3);
  const idx = new Uint32Array(ic);
  let vo = 0, io = 0;
  for (const g of geos) {
    const n = g.attributes.position.count;
    pos.set(g.attributes.position.array, vo * 3);
    nor.set(g.attributes.normal.array, vo * 3);
    if (g.attributes.uv) uv.set(g.attributes.uv.array, vo * 2);
    if (g.attributes.color) col.set(g.attributes.color.array, vo * 3);
    if (g.index) { for (let i = 0; i < g.index.count; i++) idx[io++] = g.index.getX(i) + vo; }
    else { for (let i = 0; i < n; i++) idx[io++] = vo + i; }
    vo += n;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  return out;
}
