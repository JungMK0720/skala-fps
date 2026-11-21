/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 연막탄·섬광탄 연출. 연기 구름(부드러운 스프라이트 여러 장), 섬광 번쩍임, 연기 속 화면 안개와 섬광 실명 화면(하얀 덮개)을 그린다.
 *          판정은 weapons/tactical.js가 하고 여기서는 보이기만 한다.
 */
/*
 *   const tfx = createTacticalFx({ scene, container });   // container = 게임 캔버스의 부모(HUD 아래에 덮개를 둔다)
 *   tfx.frame(dt, clouds, fog)     // 매 프레임: clouds = smoke.list(t), fog = 눈이 연기 속에 있는 정도(0..1)
 *   tfx.flashBurst(pos)            // 섬광이 터진 자리의 번쩍임(세계 안)
 *   tfx.blind(intensity)           // 내 눈이 멀었다(0..1) → 하얀 덮개가 버티다 걷힌다
 *   tfx.blindAmount()              // 지금 하얀 덮개 불투명도(시험·QA용)
 *   tfx.clear() / tfx.dispose()
 */
import * as THREE from 'three';
import { SMOKE, flashWhiteout } from '../weapons/tactical.js';

const PUFFS = 30;                  // 구름 하나의 스프라이트 수
const MAX_CLOUDS = 8;              // 동시에 그리는 구름 상한(넘으면 오래된 것부터 안 그린다)
const BURST_LIFE = 0.32;           // 섬광 번쩍임 시간(초)
const RO = 8;                      // 연기 그리기 순서(수류탄 연출보다 뒤)

/** 가장자리가 부드러운 연기 덩어리 텍스처(한 장을 모든 구름이 나눠 쓴다) */
function puffTexture() {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  if (!g) return null;
  // 큰 원 하나 + 덩어리 몇 개로 뭉게구름처럼
  const blob = (x, y, r, a) => {
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, `rgba(255,255,255,${a})`);
    gr.addColorStop(0.55, `rgba(255,255,255,${a * 0.55})`);
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr;
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  };
  blob(64, 64, 62, 0.85);
  let s = 7;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  for (let i = 0; i < 9; i++) {
    const a = rnd() * Math.PI * 2, d = 12 + rnd() * 22;
    blob(64 + Math.cos(a) * d, 64 + Math.sin(a) * d, 20 + rnd() * 16, 0.35 + rnd() * 0.3);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** 번쩍임 텍스처: 가운데가 하얗고 바깥으로 사라지는 원 */
function glowTexture() {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  if (!g) return null;
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.25, 'rgba(255,252,235,0.85)');
  gr.addColorStop(1, 'rgba(255,250,230,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** 덮개 div 하나(HUD 아래 z-index는 css/fps.css가 정한다) */
function overlay(container, cls) {
  if (!container || typeof document === 'undefined') return null;
  const el = document.createElement('div');
  el.className = cls;
  el.setAttribute('aria-hidden', 'true');
  el.style.opacity = '0';
  container.appendChild(el);
  return el;
}

export function createTacticalFx({ scene, container } = {}) {
  const puffTex = puffTexture();
  const glowTex = glowTexture();
  const root = new THREE.Group();
  root.name = 'tactical-fx';
  if (scene) scene.add(root);
  const clouds = new Map();          // id → { group, puffs: [{ s, m, u:[x,y,z], rf, sz, spin, ph }] }
  const bursts = [];                 // { s, m, t }
  const blinds = [];                 // { k, t0 } (초, performance.now 기준)
  const fogEl = overlay(container, 'sk-smokefog');
  const whiteEl = overlay(container, 'sk-flashout');
  let fogShown = 0, whiteShown = 0, time = 0;

  function makeCloud(id) {
    const group = new THREE.Group();
    group.name = 'smoke:' + id;
    const puffs = [];
    let s = 0;
    for (let i = 0; i < String(id).length; i++) s = (s * 31 + String(id).charCodeAt(i)) >>> 0;
    s = (s % 2147483646) + 1;
    const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    for (let i = 0; i < PUFFS; i++) {
      // 위로 볼록한 반구 안(바닥 아래로는 조금만)에 고르게
      const a = rnd() * Math.PI * 2, y = rnd() * 1.15 - 0.3, h = Math.sqrt(Math.max(0, 1 - Math.min(1, y * y)));
      const u = [Math.cos(a) * h, y * 0.75, Math.sin(a) * h];
      const shade = 0.62 + 0.22 * (y + 0.3) + rnd() * 0.08;  // 아래쪽은 조금 어둡다
      const m = new THREE.SpriteMaterial({ map: puffTex, color: new THREE.Color(shade * 0.96, shade, shade * 0.95), transparent: true, depthWrite: false, opacity: 0 });
      m.rotation = rnd() * Math.PI * 2;
      const sp = new THREE.Sprite(m);
      sp.renderOrder = RO;
      group.add(sp);
      puffs.push({ s: sp, m, u, rf: 0.2 + 0.7 * Math.sqrt(rnd()), sz: 0.75 + rnd() * 0.55, spin: (rnd() - 0.5) * 0.25, ph: rnd() * 6.28 });
    }
    root.add(group);
    const c = { group, puffs };
    clouds.set(id, c);
    return c;
  }

  function dropCloud(id) {
    const c = clouds.get(id);
    if (!c) return;
    root.remove(c.group);
    for (const p of c.puffs) p.m.dispose();
    clouds.delete(id);
  }

  function drawCloud(c, info, step) {
    const r = Math.max(0.01, info.radius);
    // 막 터질 때는 빠르게 진해지고, 끝 fade초 동안 옅어진다
    const alpha = Math.min(1, info.age / 0.5) * Math.min(1, Math.max(0, (info.life - info.age) / SMOKE.fade));
    const [cx, cy, cz] = info.center;
    for (const p of c.puffs) {
      const wob = Math.sin(time * 0.35 + p.ph) * 0.06;
      const d = r * (p.rf + wob);
      p.s.position.set(cx + p.u[0] * d, cy + p.u[1] * d + info.age * 0.03, cz + p.u[2] * d);
      const size = r * p.sz * 0.95;
      p.s.scale.set(size, size, 1);
      p.m.rotation += p.spin * step;
      p.m.opacity = 0.9 * alpha;
    }
  }

  return {
    /**
     * 매 프레임. clouds = [{ id, center, radius, age, life }], fog = 0..1
     */
    frame(dt, list, fog) {
      const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
      time += step;
      const seen = new Set();
      const shown = (Array.isArray(list) ? list : []).slice(-MAX_CLOUDS);
      for (const info of shown) {
        seen.add(info.id);
        drawCloud(clouds.get(info.id) || makeCloud(info.id), info, step);
      }
      for (const id of [...clouds.keys()]) if (!seen.has(id)) dropCloud(id);
      for (let i = bursts.length - 1; i >= 0; i--) {
        const b = bursts[i];
        b.t += step;
        const u = b.t / BURST_LIFE;
        if (u >= 1) { root.remove(b.s); b.m.dispose(); bursts.splice(i, 1); continue; }
        const sz = 2 + 10 * Math.sqrt(u);
        b.s.scale.set(sz, sz, 1);
        b.m.opacity = 1 - u * u;
      }
      // 화면 덮개: 연기 속이면 회색 안개, 섬광이면 하얀 화면
      const f = Math.max(0, Math.min(1, Number(fog) || 0));
      const fogA = Math.round(f * 0.94 * 100) / 100;
      if (fogEl && fogA !== fogShown) { fogShown = fogA; fogEl.style.opacity = String(fogA); }
      const now = performance.now() / 1000;
      let w = 0;
      for (let i = blinds.length - 1; i >= 0; i--) {
        const a = flashWhiteout(blinds[i].k, now - blinds[i].t0);
        if (a <= 0 && now - blinds[i].t0 > 0.1) { blinds.splice(i, 1); continue; }
        w = Math.max(w, a);
      }
      const wA = Math.round(w * 100) / 100;
      if (whiteEl && wA !== whiteShown) { whiteShown = wA; whiteEl.style.opacity = String(wA); }
    },
    /** 섬광이 터진 자리의 번쩍임 */
    flashBurst(pos) {
      if (!pos) return;
      const m = new THREE.SpriteMaterial({ map: glowTex, color: 0xffffff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
      const s = new THREE.Sprite(m);
      s.position.set(+pos[0] || 0, (+pos[1] || 0) + 0.3, +pos[2] || 0);
      s.renderOrder = RO + 1;
      root.add(s);
      bursts.push({ s, m, t: 0 });
    },
    /** 내 눈이 멀었다(세기 0..1) */
    blind(k) {
      const v = Math.max(0, Math.min(1, Number(k) || 0));
      if (v > 0) blinds.push({ k: v, t0: performance.now() / 1000 });
    },
    /** 지금 하얀 덮개 불투명도(0..1) */
    blindAmount: () => whiteShown,
    /** 지금 회색 안개 불투명도(0..1) */
    fogAmount: () => fogShown,
    get cloudCount() { return clouds.size; },
    clear() {
      for (const id of [...clouds.keys()]) dropCloud(id);
      for (const b of bursts) { root.remove(b.s); b.m.dispose(); }
      bursts.length = 0;
      blinds.length = 0;
      fogShown = whiteShown = 0;
      if (fogEl) fogEl.style.opacity = '0';
      if (whiteEl) whiteEl.style.opacity = '0';
    },
    dispose() {
      this.clear();
      if (scene) scene.remove(root);
      if (puffTex) puffTex.dispose();
      if (glowTex) glowTex.dispose();
      if (fogEl) fogEl.remove();
      if (whiteEl) whiteEl.remove();
    }
  };
}
