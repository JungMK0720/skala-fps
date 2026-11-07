/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 맵 재질 팔레트. 텍스처는 전부 캔버스로 그린다(외부 이미지 없음). 이름 목록은 consts.MATS와 같다.
 */
/**
 * SKALA FPS — 재질 팔레트 (캔버스로 그린 절차적 텍스처, 외부 이미지 없음)
 *
 *   getMaterial('concrete')  → 공유 THREE.Material (텍스처는 월드 좌표 UV 기준으로 MAT_INFO[name].scale m마다 반복)
 *   matColor('rust')         → 대표 색(hex number) — FX 파편 색 등에 사용
 *   setWaterColor('#1d3557') → 맵 theme.water 반영
 *
 * mat 이름: concrete, asphalt, steel, rust, deck, tank, pipe, wood, glass, container_red, grass, water, white, yellow,
 *           stone, brick, plaster, tile, sand, moss, wood_dark, bamboo, paper, metal_dark, neon_cyan, neon_pink
 * neon_*는 조명과 그림자의 영향을 받지 않는다. paper는 뒤에서 빛이 비치는 듯 살짝 발광한다.
 */
import * as THREE from 'three';

/** scale = 텍스처 1장이 덮는 월드 길이(m) */
export const MAT_INFO = Object.freeze({
  concrete:      { scale: 4,   size: 512, color: 0x9a9993, kind: 'lambert' },
  asphalt:       { scale: 4,   size: 512, color: 0x3e4043, kind: 'lambert' },
  steel:         { scale: 2,   size: 256, color: 0x7f8a93, kind: 'phong', shininess: 38, specular: 0x4a4f55 },
  rust:          { scale: 2,   size: 256, color: 0x8a4b26, kind: 'lambert' },
  deck:          { scale: 3,   size: 512, color: 0x4f6857, kind: 'phong', shininess: 10, specular: 0x1e2420 },
  tank:          { scale: 4,   size: 512, color: 0xd6d9d4, kind: 'phong', shininess: 18, specular: 0x2c2e2c },
  pipe:          { scale: 1,   size: 128, color: 0xa9aeb1, kind: 'phong', shininess: 46, specular: 0x5a5e62 },
  wood:          { scale: 2,   size: 256, color: 0x8a6a45, kind: 'lambert' },
  glass:         { scale: 2,   size: 0,   color: 0xa8d0e0, kind: 'glass' },
  container_red: { scale: 2.4, size: 256, color: 0xa5342b, kind: 'phong', shininess: 14, specular: 0x241414 },
  grass:         { scale: 4,   size: 256, color: 0x557d3b, kind: 'lambert' },
  water:         { scale: 8,   size: 256, color: 0x1d3557, kind: 'water' },
  white:         { scale: 4,   size: 256, color: 0xe6e6e1, kind: 'lambert' },
  yellow:        { scale: 2,   size: 256, color: 0xe2b21a, kind: 'phong', shininess: 14, specular: 0x262010 },
  stone:         { scale: 3,   size: 512, color: 0x85837a, kind: 'lambert' },
  brick:         { scale: 1.6, size: 512, color: 0x8a4a36, kind: 'lambert' },
  plaster:       { scale: 4,   size: 512, color: 0xe0d8c6, kind: 'lambert' },
  tile:          { scale: 2,   size: 512, color: 0x4a5666, kind: 'phong', shininess: 46, specular: 0x3a4048 },
  sand:          { scale: 4,   size: 512, color: 0xcdb88a, kind: 'lambert' },
  moss:          { scale: 3,   size: 256, color: 0x4a6232, kind: 'lambert' },
  wood_dark:     { scale: 2,   size: 256, color: 0x3e2a1c, kind: 'lambert' },
  bamboo:        { scale: 1.2, size: 256, color: 0x9ca054, kind: 'lambert' },
  paper:         { scale: 1.8, size: 256, color: 0xeee8d6, kind: 'paper', emissive: 0x4a4234 },
  metal_dark:    { scale: 2,   size: 256, color: 0x343940, kind: 'phong', shininess: 34, specular: 0x3c4249 },
  neon_cyan:     { scale: 1,   size: 128, color: 0x35e0ff, kind: 'neon' },
  neon_pink:     { scale: 1,   size: 128, color: 0xff4d8d, kind: 'neon' }
});
export const MAT_NAMES = Object.freeze(Object.keys(MAT_INFO));

const cache = new Map();     // name → material
const texCache = new Map();  // name → texture
let anisotropy = 4;

/* ---------------- 난수·노이즈 ---------------- */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** 이음매 없는(tileable) value-noise fbm → Float32Array(S*S), 0..1 */
function fbm(S, rand, octaves, stretchX = 1, stretchY = 1) {
  const out = new Float32Array(S * S);
  let total = 0;
  for (const [cells0, amp] of octaves) {
    const cx = Math.max(1, Math.round(cells0 / stretchX)), cy = Math.max(1, Math.round(cells0 / stretchY));
    const g = new Float32Array(cx * cy);
    for (let i = 0; i < g.length; i++) g[i] = rand();
    total += amp;
    for (let y = 0; y < S; y++) {
      const fy = (y / S) * cy, y0 = Math.floor(fy), ty = fy - y0, sy = ty * ty * (3 - 2 * ty);
      const r0 = (y0 % cy) * cx, r1 = ((y0 + 1) % cy) * cx;
      for (let x = 0; x < S; x++) {
        const fx = (x / S) * cx, x0 = Math.floor(fx), tx = fx - x0, sx = tx * tx * (3 - 2 * tx);
        const c0 = x0 % cx, c1 = (x0 + 1) % cx;
        const a = g[r0 + c0] + (g[r0 + c1] - g[r0 + c0]) * sx;
        const b = g[r1 + c0] + (g[r1 + c1] - g[r1 + c0]) * sx;
        out[y * S + x] += (a + (b - a) * sy) * amp;
      }
    }
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

/* ---------------- 캔버스 도우미 ---------------- */

function makeCanvas(S) {
  const c = document.createElement('canvas');
  c.width = c.height = S;
  return c;
}

/** 기본색 × (1 + amp·(noise−0.5)) + 픽셀 그레인 */
function paintBase(ctx, S, rand, rgb, amp, octaves, grain, opt = {}) {
  const img = ctx.createImageData(S, S);
  const d = img.data;
  const n = fbm(S, rand, octaves, opt.stretchX, opt.stretchY);
  const n2 = opt.tint ? fbm(S, rand, opt.tint.octaves) : null;
  for (let i = 0; i < S * S; i++) {
    const k = 1 + amp * (n[i] - 0.5) * 2;
    const gr = (rand() - 0.5) * grain;
    let r = rgb[0] * k + gr, g = rgb[1] * k + gr, b = rgb[2] * k + gr;
    if (n2) {
      const t = Math.max(0, Math.min(1, (n2[i] - opt.tint.lo) / (opt.tint.hi - opt.tint.lo)));
      const c2 = opt.tint.rgb;
      r += (c2[0] * k - r) * t * opt.tint.mix; g += (c2[1] * k - g) * t * opt.tint.mix; b += (c2[2] * k - b) * t * opt.tint.mix;
    }
    d[i * 4] = r; d[i * 4 + 1] = g; d[i * 4 + 2] = b; d[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

/** 가장자리를 넘는 도형을 반대편에도 그려 이음매를 없앤다 */
function tiled(S, x, y, r, draw) {
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
    const px = x + dx * S, py = y + dy * S;
    if (px + r < 0 || px - r > S || py + r < 0 || py - r > S) continue;
    draw(px, py);
  }
}

function blotches(ctx, S, rand, count, rMin, rMax, rgb, aMin, aMax) {
  for (let i = 0; i < count; i++) {
    const x = rand() * S, y = rand() * S, r = rMin + rand() * (rMax - rMin), a = aMin + rand() * (aMax - aMin);
    tiled(S, x, y, r, (px, py) => {
      const g = ctx.createRadialGradient(px, py, 0, px, py, r);
      g.addColorStop(0, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`);
      g.addColorStop(1, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(px - r, py - r, r * 2, r * 2);
    });
  }
}

function dots(ctx, S, rand, count, size, rgb, aMin, aMax) {
  for (let i = 0; i < count; i++) {
    ctx.fillStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${aMin + rand() * (aMax - aMin)})`;
    ctx.fillRect(Math.floor(rand() * S), Math.floor(rand() * S), size, size);
  }
}

function cracks(ctx, S, rand, count, rgb, alpha, len) {
  ctx.lineWidth = 1;
  for (let i = 0; i < count; i++) {
    let x = rand() * S, y = rand() * S, ang = rand() * Math.PI * 2;
    ctx.strokeStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`;
    const pts = [[x, y]];
    for (let k = 0; k < len; k++) {
      ang += (rand() - 0.5) * 1.1;
      x += Math.cos(ang) * 4; y += Math.sin(ang) * 4;
      pts.push([x, y]);
    }
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      ctx.beginPath();
      pts.forEach((p, k) => (k ? ctx.lineTo(p[0] + dx * S, p[1] + dy * S) : ctx.moveTo(p[0] + dx * S, p[1] + dy * S)));
      ctx.stroke();
    }
  }
}

function hline(ctx, S, y, h, style) { ctx.fillStyle = style; ctx.fillRect(0, y, S, h); }
function vline(ctx, S, x, w, style) { ctx.fillStyle = style; ctx.fillRect(x, 0, w, S); }

function rivet(ctx, x, y, r) {
  const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.35, 0, x, y, r);
  g.addColorStop(0, 'rgba(225,232,238,0.95)');
  g.addColorStop(0.55, 'rgba(140,150,158,0.9)');
  g.addColorStop(1, 'rgba(40,44,48,0.9)');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
}

/** 가로로 넘치면 왼쪽에도 그려 이음매를 없앤다 */
function wrapRect(ctx, S, x, y, w, h) {
  ctx.fillRect(x, y, w, h);
  if (x + w > S) ctx.fillRect(x - S, y, w, h);
}

/** 합이 total인 무작위 폭 n개 (spread 0이면 모두 같다) */
function randomWidths(R, n, total, spread) {
  const raw = Array.from({ length: n }, () => 1 + (R() - 0.5) * spread);
  const sum = raw.reduce((a, b) => a + b, 0);
  return raw.map((v) => (v / sum) * total);
}

const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const mixRgb = (a, b, t) => [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t));

/** 가로 판자: 판마다 밝기가 다르고 결·이음·옹이가 있다 */
function paintPlanks(ctx, S, R, count, grainRgb, gapRgb) {
  const ph = S / count;
  for (let p = 0; p < count; p++) {
    const y0 = p * ph, tone = 0.8 + R() * 0.4;
    ctx.fillStyle = tone > 1 ? `rgba(190,150,110,${(tone - 1) * 0.35})` : `rgba(8,4,2,${(1 - tone) * 0.7})`;
    ctx.fillRect(0, y0, S, ph);
    ctx.lineWidth = 1;
    for (let l = 0; l < 10; l++) {
      const base = y0 + 3 + R() * (ph - 6), amp = 0.8 + R() * 2.4, freq = ((1 + Math.floor(R() * 3)) * Math.PI * 2) / S, phase = R() * 6;
      ctx.strokeStyle = rgba(grainRgb, 0.16 + R() * 0.22);
      ctx.beginPath();
      for (let x = 0; x <= S; x += 4) {
        const yy = base + Math.sin(x * freq + phase) * amp;
        if (x) ctx.lineTo(x, yy); else ctx.moveTo(x, yy);
      }
      ctx.stroke();
    }
    ctx.fillStyle = rgba(gapRgb, 0.75);
    ctx.fillRect(Math.floor(R() * S), y0, 2, ph);
    hline(ctx, S, y0, 2, rgba(gapRgb, 0.9));
    hline(ctx, S, y0 + 2, 1, 'rgba(200,170,130,0.1)');
  }
}

/** 조명을 안 받는 네온 면: 고른 색에 옅은 LED 격자 */
function paintNeon(ctx, S, rgb) {
  ctx.fillStyle = rgba(rgb, 1);
  ctx.fillRect(0, 0, S, S);
  const core = mixRgb(rgb, [255, 255, 255], 0.5);
  const g = ctx.createLinearGradient(0, 0, 0, S);
  g.addColorStop(0, rgba(core, 0)); g.addColorStop(0.5, rgba(core, 0.55)); g.addColorStop(1, rgba(core, 0));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  const dark = mixRgb(rgb, [0, 0, 0], 0.35);
  for (let i = 0; i < 4; i++) {
    const p = (i * S) / 4;
    hline(ctx, S, p, 1, rgba(dark, 0.3));
    vline(ctx, S, p, 1, rgba(dark, 0.3));
  }
}

/* ---------------- 재질별 그림 ---------------- */

const PAINT = {
  concrete(ctx, S, R) {
    paintBase(ctx, S, R, [154, 153, 147], 0.16, [[3, 0.45], [7, 0.3], [18, 0.15], [48, 0.1]], 12);
    blotches(ctx, S, R, 22, 18, 95, [70, 66, 58], 0.05, 0.16);
    blotches(ctx, S, R, 10, 20, 80, [210, 208, 200], 0.04, 0.1);
    cracks(ctx, S, R, 3, [60, 58, 54], 0.32, 26);
    // 거푸집 이음(4 m) + 타이 구멍
    hline(ctx, S, 0, 2, 'rgba(70,68,62,0.55)'); vline(ctx, S, 0, 2, 'rgba(70,68,62,0.55)');
    hline(ctx, S, 2, 1, 'rgba(200,198,190,0.25)'); vline(ctx, S, 2, 1, 'rgba(200,198,190,0.25)');
    for (const fx of [0.25, 0.75]) for (const fy of [0.25, 0.75]) {
      ctx.fillStyle = 'rgba(55,52,48,0.55)';
      ctx.beginPath(); ctx.arc(fx * S, fy * S, 3.5, 0, Math.PI * 2); ctx.fill();
    }
  },
  asphalt(ctx, S, R) {
    paintBase(ctx, S, R, [62, 64, 67], 0.12, [[4, 0.4], [12, 0.35], [40, 0.25]], 26);
    dots(ctx, S, R, 2600, 1, [175, 175, 170], 0.25, 0.6);
    dots(ctx, S, R, 900, 2, [28, 28, 30], 0.3, 0.6);
    blotches(ctx, S, R, 9, 30, 110, [22, 22, 24], 0.08, 0.2);
    cracks(ctx, S, R, 5, [20, 20, 20], 0.5, 34);
  },
  steel(ctx, S, R) {
    paintBase(ctx, S, R, [128, 138, 147], 0.08, [[3, 0.5], [9, 0.3], [24, 0.2]], 7);
    for (let i = 0; i < 160; i++) {
      const y = R() * S;
      hline(ctx, S, y, 1, R() < 0.5 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)');
    }
    blotches(ctx, S, R, 6, 6, 22, [150, 85, 40], 0.08, 0.2);
    // 판 테두리
    hline(ctx, S, 0, 2, 'rgba(30,34,38,0.7)'); vline(ctx, S, 0, 2, 'rgba(30,34,38,0.7)');
    hline(ctx, S, 2, 1, 'rgba(220,226,232,0.3)'); vline(ctx, S, 2, 1, 'rgba(220,226,232,0.3)');
    // 리벳
    const inset = 10, stepPx = S / 12;
    for (let i = 0; i < 12; i++) {
      const t = i * stepPx + stepPx / 2;
      rivet(ctx, t, inset, 2.6); rivet(ctx, t, S - inset + 2, 2.6);
      rivet(ctx, inset, t, 2.6); rivet(ctx, S - inset + 2, t, 2.6);
    }
  },
  rust(ctx, S, R) {
    paintBase(ctx, S, R, [138, 75, 38], 0.3, [[4, 0.4], [10, 0.3], [26, 0.2], [64, 0.1]], 18,
      { tint: { octaves: [[5, 0.6], [14, 0.4]], lo: 0.35, hi: 0.7, rgb: [74, 38, 20], mix: 0.8 } });
    dots(ctx, S, R, 500, 2, [45, 22, 12], 0.4, 0.8);
    blotches(ctx, S, R, 40, 4, 16, [196, 118, 58], 0.2, 0.45);
    for (let i = 0; i < 30; i++) {
      const x = R() * S, y = R() * S, h = 20 + R() * 80;
      const g = ctx.createLinearGradient(0, y, 0, y + h);
      g.addColorStop(0, 'rgba(60,30,15,0.28)'); g.addColorStop(1, 'rgba(60,30,15,0)');
      ctx.fillStyle = g;
      tiled(S, x, y + h / 2, h, (px, py) => ctx.fillRect(px, py - h / 2, 2 + R() * 3, h));
    }
  },
  deck(ctx, S, R) {
    paintBase(ctx, S, R, [79, 104, 87], 0.12, [[3, 0.4], [8, 0.3], [30, 0.3]], 16);
    blotches(ctx, S, R, 14, 25, 90, [140, 150, 138], 0.06, 0.16); // 닳은 자국
    // 용접 이음(1.5 m 판)
    for (const p of [0, S / 2]) {
      hline(ctx, S, p, 3, 'rgba(36,46,40,0.75)'); vline(ctx, S, p, 3, 'rgba(36,46,40,0.75)');
      hline(ctx, S, p + 3, 1, 'rgba(160,175,160,0.25)'); vline(ctx, S, p + 3, 1, 'rgba(160,175,160,0.25)');
    }
    blotches(ctx, S, R, 18, 4, 14, [130, 70, 35], 0.2, 0.45); // 녹 점
    blotches(ctx, S, R, 5, 30, 70, [40, 34, 28], 0.08, 0.18); // 기름 얼룩
  },
  tank(ctx, S, R) {
    paintBase(ctx, S, R, [214, 217, 212], 0.06, [[3, 0.5], [10, 0.3], [30, 0.2]], 6);
    const courses = 2;
    for (let c = 0; c < courses; c++) {
      const y = (c * S) / courses;
      // 아래로 흐른 얼룩
      for (let i = 0; i < 9; i++) {
        const x = R() * S, h = 30 + R() * 90;
        const g = ctx.createLinearGradient(0, y, 0, y + h);
        g.addColorStop(0, 'rgba(150,95,50,0.22)'); g.addColorStop(1, 'rgba(150,95,50,0)');
        ctx.fillStyle = g; ctx.fillRect(x, y, 2 + R() * 4, h);
      }
      hline(ctx, S, y, 2, 'rgba(120,124,120,0.7)');
      hline(ctx, S, y + 2, 1, 'rgba(255,255,255,0.5)');
      const off = c % 2 ? S / 2 : 0;
      for (const vx of [off % S, (off + S / 2) % S]) {
        ctx.fillStyle = 'rgba(130,134,130,0.55)';
        ctx.fillRect(vx, y, 2, S / courses);
      }
    }
    blotches(ctx, S, R, 8, 40, 120, [150, 150, 140], 0.04, 0.09);
  },
  pipe(ctx, S, R) {
    paintBase(ctx, S, R, [170, 175, 178], 0.07, [[2, 0.5], [6, 0.5]], 6, { stretchX: 1, stretchY: 4 });
    for (let i = 0; i < 40; i++) vline(ctx, S, R() * S, 1, R() < 0.5 ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.07)');
    blotches(ctx, S, R, 3, 4, 10, [140, 90, 50], 0.12, 0.25);
  },
  wood(ctx, S, R) {
    paintBase(ctx, S, R, [138, 106, 69], 0.1, [[2, 0.5], [8, 0.5]], 8);
    const planks = 4, ph = S / planks;
    for (let p = 0; p < planks; p++) {
      const y0 = p * ph, tone = 0.85 + R() * 0.3;
      ctx.fillStyle = tone > 1 ? `rgba(255,230,190,${(tone - 1) * 0.5})` : `rgba(40,25,10,${(1 - tone) * 0.6})`;
      ctx.fillRect(0, y0, S, ph);
      // 결
      ctx.lineWidth = 1;
      for (let l = 0; l < 9; l++) {
        const base = y0 + 4 + R() * (ph - 8), amp = 1 + R() * 3, freq = (1 + Math.floor(R() * 3)) * Math.PI * 2 / S;
        ctx.strokeStyle = `rgba(70,45,22,${0.18 + R() * 0.2})`;
        ctx.beginPath();
        for (let x = 0; x <= S; x += 4) {
          const yy = base + Math.sin(x * freq + l) * amp;
          x ? ctx.lineTo(x, yy) : ctx.moveTo(x, yy);
        }
        ctx.stroke();
      }
      // 판 끝 이음 / 옹이
      ctx.fillStyle = 'rgba(40,26,12,0.7)';
      ctx.fillRect(Math.floor(R() * S), y0, 2, ph);
      const kx = R() * S, ky = y0 + ph * (0.3 + R() * 0.4);
      ctx.fillStyle = 'rgba(60,36,16,0.55)';
      ctx.beginPath(); ctx.ellipse(kx, ky, 5 + R() * 4, 2.5 + R() * 2, 0, 0, Math.PI * 2); ctx.fill();
      hline(ctx, S, y0, 2, 'rgba(30,18,8,0.85)');
    }
  },
  container_red(ctx, S, R) {
    paintBase(ctx, S, R, [165, 52, 43], 0.08, [[3, 0.5], [10, 0.3], [30, 0.2]], 8);
    const ridges = 10;
    const img = ctx.getImageData(0, 0, S, S), d = img.data;
    for (let x = 0; x < S; x++) {
      const k = 1 + 0.16 * Math.sin((x / S) * Math.PI * 2 * ridges) + 0.05 * Math.sin((x / S) * Math.PI * 4 * ridges);
      for (let y = 0; y < S; y++) { const i = (y * S + x) * 4; d[i] *= k; d[i + 1] *= k; d[i + 2] *= k; }
    }
    ctx.putImageData(img, 0, 0);
    blotches(ctx, S, R, 14, 4, 14, [90, 40, 20], 0.25, 0.5);
    blotches(ctx, S, R, 6, 30, 80, [60, 30, 25], 0.06, 0.14);
    dots(ctx, S, R, 120, 1, [230, 200, 190], 0.15, 0.3);
  },
  grass(ctx, S, R) {
    paintBase(ctx, S, R, [85, 125, 59], 0.22, [[3, 0.4], [9, 0.35], [28, 0.25]], 20,
      { tint: { octaves: [[4, 0.6], [12, 0.4]], lo: 0.45, hi: 0.75, rgb: [128, 128, 60], mix: 0.5 } });
    for (let i = 0; i < 3000; i++) {
      const x = R() * S, y = R() * S, l = 2 + R() * 3;
      ctx.fillStyle = R() < 0.5 ? 'rgba(150,190,90,0.35)' : 'rgba(30,60,20,0.35)';
      ctx.fillRect(x, y, 1, l);
    }
  },
  water(ctx, S, R) {
    // 밝은 회청색 무늬(재질 color로 물빛을 입힌다)
    paintBase(ctx, S, R, [205, 215, 225], 0.18, [[4, 0.4], [10, 0.35], [24, 0.25]], 6, { stretchX: 1, stretchY: 2.5 });
    for (let i = 0; i < 140; i++) {
      const x = R() * S, y = R() * S, w = 8 + R() * 26;
      ctx.fillStyle = `rgba(255,255,255,${0.08 + R() * 0.12})`;
      tiled(S, x, y, w, (px, py) => ctx.fillRect(px - w / 2, py, w, 1));
    }
  },
  white(ctx, S, R) {
    paintBase(ctx, S, R, [232, 232, 227], 0.05, [[3, 0.5], [12, 0.5]], 6);
    blotches(ctx, S, R, 10, 20, 70, [120, 115, 100], 0.04, 0.09);
    hline(ctx, S, 0, 1, 'rgba(150,150,145,0.4)'); vline(ctx, S, 0, 1, 'rgba(150,150,145,0.4)');
  },
  yellow(ctx, S, R) {
    paintBase(ctx, S, R, [226, 178, 26], 0.08, [[3, 0.5], [10, 0.5]], 10);
    dots(ctx, S, R, 90, 2, [70, 66, 60], 0.4, 0.8);
    blotches(ctx, S, R, 10, 3, 9, [80, 70, 55], 0.3, 0.6);
    cracks(ctx, S, R, 4, [110, 90, 40], 0.3, 10);
  },
  stone(ctx, S, R) {
    // 다듬은 돌 쌓기: 줄마다 돌 폭이 다르고 돌마다 밝기가 다르다
    paintBase(ctx, S, R, [134, 132, 124], 0.16, [[3, 0.4], [8, 0.3], [22, 0.2], [60, 0.1]], 12,
      { tint: { octaves: [[5, 0.6], [13, 0.4]], lo: 0.45, hi: 0.75, rgb: [104, 110, 92], mix: 0.45 } });
    const rows = 6, rh = S / rows;
    for (let r = 0; r < rows; r++) {
      const y = r * rh;
      const widths = randomWidths(R, 3 + Math.floor(R() * 2), S, 0.8);
      let x = R() * S * 0.4;
      for (const w of widths) {
        const tone = R();
        ctx.fillStyle = tone > 0.5 ? `rgba(232,228,216,${(tone - 0.5) * 0.2})` : `rgba(28,26,22,${(0.5 - tone) * 0.3})`;
        wrapRect(ctx, S, x, y, w, rh);
        ctx.fillStyle = 'rgba(34,32,28,0.75)';
        wrapRect(ctx, S, x, y, 3, rh);
        ctx.fillStyle = 'rgba(214,210,198,0.22)';
        wrapRect(ctx, S, x + 3, y + 3, 1, rh - 3);
        x = (x + w) % S;
      }
      hline(ctx, S, y, 3, 'rgba(34,32,28,0.8)');
      hline(ctx, S, y + 3, 1, 'rgba(214,210,198,0.25)');
    }
    dots(ctx, S, R, 700, 1, [40, 38, 34], 0.2, 0.5);
    blotches(ctx, S, R, 12, 12, 46, [60, 66, 50], 0.05, 0.14);
    cracks(ctx, S, R, 4, [36, 34, 30], 0.35, 12);
  },
  brick(ctx, S, R) {
    // 벽돌 쌓기: 한 줄 건너 반 칸 어긋남. 줄 수와 칸 수가 짝수라 이음매가 없다
    paintBase(ctx, S, R, [150, 141, 126], 0.1, [[6, 0.5], [24, 0.5]], 14);
    const rows = 16, cols = 8, rh = S / rows, cw = S / cols, gap = 3;
    const palette = [[146, 66, 46], [124, 54, 42], [158, 78, 52], [108, 50, 42], [134, 72, 58]];
    for (let r = 0; r < rows; r++) {
      const off = r % 2 ? cw / 2 : 0;
      for (let c = 0; c < cols; c++) {
        const col = mixRgb(palette[Math.floor(R() * palette.length)], [44, 26, 22], R() * 0.3);
        const x = off + c * cw + gap / 2, y = r * rh + gap / 2, w = cw - gap, h = rh - gap;
        ctx.fillStyle = rgba(col, 0.97);
        wrapRect(ctx, S, x, y, w, h);
        ctx.fillStyle = 'rgba(255,220,190,0.14)';
        wrapRect(ctx, S, x, y, w, 2);
        ctx.fillStyle = 'rgba(20,10,8,0.28)';
        wrapRect(ctx, S, x, y + h - 2, w, 2);
      }
    }
    dots(ctx, S, R, 1800, 1, [30, 16, 12], 0.2, 0.55);
    dots(ctx, S, R, 700, 1, [226, 190, 160], 0.12, 0.3);
    blotches(ctx, S, R, 14, 18, 70, [38, 30, 26], 0.05, 0.15);
    blotches(ctx, S, R, 6, 20, 60, [200, 196, 180], 0.04, 0.1);
  },
  plaster(ctx, S, R) {
    // 흙손 자국이 있는 회벽
    paintBase(ctx, S, R, [226, 218, 200], 0.05, [[3, 0.4], [9, 0.3], [28, 0.2], [70, 0.1]], 7);
    for (let i = 0; i < 90; i++) {
      const x = R() * S, y = R() * S, len = 30 + R() * 90, bow = (R() - 0.5) * 18;
      ctx.strokeStyle = R() < 0.5 ? `rgba(255,252,240,${0.04 + R() * 0.06})` : `rgba(120,110,92,${0.03 + R() * 0.05})`;
      ctx.lineWidth = 2 + R() * 5;
      for (const dx of [0, -S, S]) {
        ctx.beginPath();
        ctx.moveTo(x + dx, y);
        ctx.quadraticCurveTo(x + dx + len / 2, y + bow, x + dx + len, y);
        ctx.stroke();
      }
    }
    blotches(ctx, S, R, 12, 30, 120, [150, 134, 108], 0.04, 0.11);
    cracks(ctx, S, R, 4, [112, 104, 90], 0.28, 18);
  },
  tile(ctx, S, R) {
    // 유약 바른 슬레이트색 타일: 지붕과 바닥에 함께 쓴다
    paintBase(ctx, S, R, [52, 54, 58], 0.08, [[6, 0.5], [20, 0.5]], 8);
    const n = 8, c = S / n, gap = 4;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const x = i * c + gap / 2, y = j * c + gap / 2, w = c - gap;
      const col = mixRgb([76, 90, 106], [52, 64, 78], R());
      ctx.fillStyle = rgba(col, 1);
      ctx.fillRect(x, y, w, w);
      const g = ctx.createLinearGradient(x, y, x + w, y + w);
      g.addColorStop(0, 'rgba(255,255,255,0.14)'); g.addColorStop(0.5, 'rgba(255,255,255,0)'); g.addColorStop(1, 'rgba(0,0,0,0.16)');
      ctx.fillStyle = g;
      ctx.fillRect(x, y, w, w);
      ctx.fillStyle = 'rgba(255,255,255,0.1)';
      ctx.fillRect(x, y, w, 1);
    }
    dots(ctx, S, R, 500, 1, [190, 200, 212], 0.05, 0.16);
    blotches(ctx, S, R, 10, 16, 60, [24, 26, 30], 0.05, 0.13);
    cracks(ctx, S, R, 2, [20, 22, 26], 0.3, 8);
  },
  sand(ctx, S, R) {
    // 고운 모래 + 갈퀴로 고른 물결(세로 주기가 정수배라 이음매가 없다)
    paintBase(ctx, S, R, [206, 184, 138], 0.08, [[3, 0.5], [9, 0.3], [30, 0.2]], 14);
    const warp = fbm(S, R, [[3, 0.6], [7, 0.4]]);
    const img = ctx.getImageData(0, 0, S, S), d = img.data;
    const waves = 16;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const k = 1 + 0.055 * Math.sin((y / S) * Math.PI * 2 * waves + warp[y * S + x] * 7);
      const i = (y * S + x) * 4;
      d[i] *= k; d[i + 1] *= k; d[i + 2] *= k;
    }
    ctx.putImageData(img, 0, 0);
    dots(ctx, S, R, 2400, 1, [132, 110, 74], 0.18, 0.45);
    dots(ctx, S, R, 1600, 1, [246, 232, 198], 0.2, 0.5);
    blotches(ctx, S, R, 8, 40, 130, [160, 136, 94], 0.04, 0.1);
  },
  moss(ctx, S, R) {
    // 얼룩덜룩한 이끼 덩어리 사이로 돌이 비친다
    paintBase(ctx, S, R, [72, 98, 50], 0.3, [[3, 0.4], [8, 0.3], [20, 0.2], [52, 0.1]], 16,
      { tint: { octaves: [[4, 0.6], [11, 0.4]], lo: 0.5, hi: 0.72, rgb: [96, 92, 76], mix: 0.5 } });
    blotches(ctx, S, R, 80, 4, 14, [128, 158, 70], 0.14, 0.34);
    blotches(ctx, S, R, 60, 4, 16, [28, 44, 24], 0.18, 0.4);
    dots(ctx, S, R, 1100, 1, [176, 196, 92], 0.2, 0.5);
    dots(ctx, S, R, 700, 1, [20, 30, 16], 0.25, 0.55);
  },
  wood_dark(ctx, S, R) {
    paintBase(ctx, S, R, [64, 44, 30], 0.12, [[2, 0.5], [8, 0.5]], 7);
    paintPlanks(ctx, S, R, 4, [24, 14, 8], [10, 6, 4]);
    blotches(ctx, S, R, 6, 12, 40, [14, 8, 4], 0.1, 0.22);
  },
  bamboo(ctx, S, R) {
    // 세로로 나란한 대나무 살: 가운데가 밝은 둥근 음영 + 마디
    ctx.fillStyle = 'rgb(44,38,20)';
    ctx.fillRect(0, 0, S, S);
    const canes = 8, cw = S / canes;
    for (let c = 0; c < canes; c++) {
      const x = c * cw + 1, w = cw - 2;
      const col = mixRgb([168, 170, 88], [128, 146, 66], R());
      const shade = mixRgb(col, [46, 44, 18], 0.72);
      const light = mixRgb(col, [240, 238, 170], 0.35);
      const g = ctx.createLinearGradient(x, 0, x + w, 0);
      g.addColorStop(0, rgba(shade, 1)); g.addColorStop(0.38, rgba(light, 1)); g.addColorStop(0.62, rgba(col, 1)); g.addColorStop(1, rgba(shade, 1));
      ctx.fillStyle = g;
      ctx.fillRect(x, 0, w, S);
      for (let i = 0; i < 26; i++) {
        ctx.fillStyle = `rgba(60,56,24,${0.05 + R() * 0.1})`;
        ctx.fillRect(x + R() * w, R() * S, 1, 8 + R() * 30);
      }
      const nodes = 2, start = R() * S;
      for (let k = 0; k < nodes; k++) {
        const y = (start + (k * S) / nodes + (R() - 0.5) * 18 + S) % S;
        for (const yy of [y, y - S]) {
          ctx.fillStyle = 'rgba(46,40,16,0.8)';
          ctx.fillRect(x, yy, w, 3);
          ctx.fillStyle = 'rgba(232,230,170,0.42)';
          ctx.fillRect(x, yy + 3, w, 2);
        }
      }
    }
  },
  paper(ctx, S, R) {
    // 창호지 + 나무 살. 격자가 타일 경계에 걸려 이어진다
    paintBase(ctx, S, R, [240, 233, 214], 0.04, [[3, 0.5], [12, 0.5]], 5);
    ctx.lineWidth = 1;
    for (let i = 0; i < 240; i++) {
      const x = R() * S, y = R() * S, a = R() * Math.PI * 2, l = 5 + R() * 16;
      ctx.strokeStyle = R() < 0.6 ? `rgba(190,176,146,${0.1 + R() * 0.16})` : `rgba(255,255,250,${0.2 + R() * 0.2})`;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); ctx.stroke();
    }
    blotches(ctx, S, R, 5, 24, 70, [200, 184, 150], 0.04, 0.09);
    const cells = 4, t = 5;
    for (let i = 0; i < cells; i++) {
      const p = (i * S) / cells;
      for (const q of i === 0 ? [p, S] : [p]) {
        hline(ctx, S, q - t / 2, t, 'rgb(62,44,30)');
        vline(ctx, S, q - t / 2, t, 'rgb(62,44,30)');
        hline(ctx, S, q - t / 2, 1, 'rgba(150,118,86,0.7)');
        vline(ctx, S, q - t / 2, 1, 'rgba(150,118,86,0.7)');
      }
    }
  },
  metal_dark(ctx, S, R) {
    // 어두운 금속판: 솔질 자국 + 판 이음 + 볼트 + 모서리 닳음
    paintBase(ctx, S, R, [54, 59, 66], 0.09, [[3, 0.5], [9, 0.3], [26, 0.2]], 7);
    for (let i = 0; i < 200; i++) hline(ctx, S, R() * S, 1, R() < 0.5 ? 'rgba(255,255,255,0.035)' : 'rgba(0,0,0,0.07)');
    blotches(ctx, S, R, 8, 14, 44, [18, 20, 24], 0.08, 0.2);
    ctx.lineWidth = 1;
    for (let i = 0; i < 24; i++) {
      const x = R() * S, y = R() * S, a = R() * Math.PI * 2, l = 6 + R() * 26;
      ctx.strokeStyle = `rgba(190,198,208,${0.06 + R() * 0.14})`;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); ctx.stroke();
    }
    for (const p of [0, S / 2]) {
      hline(ctx, S, p, 2, 'rgba(10,12,14,0.85)'); vline(ctx, S, p, 2, 'rgba(10,12,14,0.85)');
      hline(ctx, S, p + 2, 1, 'rgba(150,158,168,0.22)'); vline(ctx, S, p + 2, 1, 'rgba(150,158,168,0.22)');
    }
    for (const fx of [0.08, 0.42, 0.58, 0.92]) for (const fy of [0.08, 0.42, 0.58, 0.92]) {
      const x = fx * S, y = fy * S;
      ctx.fillStyle = 'rgba(14,16,18,0.9)';
      ctx.beginPath(); ctx.arc(x, y + 0.6, 2.4, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(120,128,138,0.85)';
      ctx.beginPath(); ctx.arc(x - 0.3, y - 0.3, 1.5, 0, Math.PI * 2); ctx.fill();
    }
  },
  neon_cyan(ctx, S) { paintNeon(ctx, S, [53, 224, 255]); },
  neon_pink(ctx, S) { paintNeon(ctx, S, [255, 77, 141]); }
};

function makeTexture(name) {
  if (texCache.has(name)) return texCache.get(name);
  const info = MAT_INFO[name];
  if (!info || !info.size || !PAINT[name]) return null;
  const S = info.size;
  const canvas = makeCanvas(S);
  const ctx = canvas.getContext('2d');
  PAINT[name](ctx, S, mulberry32(hashStr(name)));
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = anisotropy;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.name = 'mat:' + name;
  texCache.set(name, tex);
  return tex;
}

function createMaterial(name) {
  const info = MAT_INFO[name];
  let m;
  if (info.kind === 'glass') {
    m = new THREE.MeshPhongMaterial({
      color: info.color, transparent: true, opacity: 0.32, shininess: 90, specular: 0xffffff,
      depthWrite: false
    });
  } else if (info.kind === 'water') {
    m = new THREE.MeshPhongMaterial({ map: makeTexture(name), color: info.color, shininess: 70, specular: 0x6688aa });
  } else if (info.kind === 'phong') {
    m = new THREE.MeshPhongMaterial({ map: makeTexture(name), shininess: info.shininess, specular: info.specular });
  } else if (info.kind === 'neon') {
    m = new THREE.MeshBasicMaterial({ map: makeTexture(name), toneMapped: false });
  } else if (info.kind === 'paper') {
    const map = makeTexture(name);
    m = new THREE.MeshLambertMaterial({ map, emissive: info.emissive, emissiveMap: map });
  } else {
    m = new THREE.MeshLambertMaterial({ map: makeTexture(name) });
  }
  m.name = name;
  m.userData.mat = name;
  return m;
}

/** 공유 재질(같은 인스턴스를 돌려줌). 모르는 이름이면 concrete */
export function getMaterial(name) {
  if (!MAT_INFO[name]) name = 'concrete';
  let m = cache.get(name);
  if (!m) { m = createMaterial(name); cache.set(name, m); }
  return m;
}

export function getTexture(name) { return makeTexture(name); }
export function hasMat(name) { return !!MAT_INFO[name]; }
export function matScale(name) { return (MAT_INFO[name] || MAT_INFO.concrete).scale; }
export function matColor(name) { return (MAT_INFO[name] || MAT_INFO.concrete).color; }

/** theme.water 반영 */
export function setWaterColor(color) {
  getMaterial('water').color.set(color || MAT_INFO.water.color);
}

/** 바닥용 사본(polygonOffset으로 얇은 바닥 장식과의 z-fighting 방지) */
const groundCache = new Map();
export function getGroundMaterial(name) {
  if (!MAT_INFO[name]) name = 'asphalt';
  let m = groundCache.get(name);
  if (!m) {
    m = getMaterial(name).clone();
    m.polygonOffset = true; m.polygonOffsetFactor = 1; m.polygonOffsetUnits = 1;
    m.name = name + ':ground';
    groundCache.set(name, m);
  }
  return m;
}

/** 물 텍스처 흐름(프레임마다 호출) */
export function animateMaterials(dt) {
  const t = texCache.get('water');
  if (t) { t.offset.x = (t.offset.x + dt * 0.006) % 1; t.offset.y = (t.offset.y + dt * 0.004) % 1; }
}

export function setAnisotropy(n) {
  anisotropy = Math.max(1, Math.min(8, n | 0));
  for (const t of texCache.values()) { t.anisotropy = anisotropy; t.needsUpdate = true; }
}

export function disposeMaterials() {
  for (const m of cache.values()) m.dispose();
  for (const m of groundCache.values()) m.dispose();
  for (const t of texCache.values()) t.dispose();
  cache.clear(); groundCache.clear(); texCache.clear();
}
