/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 배틀로얄 봉쇄 구역 연출(three.js). 봉쇄 예고 구역은 호박색, 봉쇄된 구역은 붉은 호박색 반투명 격자 벽과 바닥 색으로 칠하고
 *          구역 이름표(B-4)를 띄운다. 벽은 상태가 다른 이웃 칸과의 경계에만 세워 겹치지 않는다. 판정은 하지 않는다(br/solo.js)
 */
import { sectorName } from './rules.js';

const WALL_LOW = -3;         // 바닥 높이 기준 벽 아래(m)
const WALL_HIGH = 34;        // 바닥 높이 기준 벽 위(m)
const LABEL_Y = 9;           // 이름표 높이(바닥 기준, m)
const TEX_M = 4;             // 격자 무늬 한 칸(m)
const TONE = Object.freeze({
  closing: Object.freeze({ wall: 0xffb43a, wallOp: 0.2, floor: 0xffb43a, floorOp: 0.14, label: '#ffd27a' }),
  closed: Object.freeze({ wall: 0xff5a2e, wallOp: 0.34, floor: 0xff4a24, floorOp: 0.24, label: '#ff9a7a' })
});

/** 벽 무늬: 세로·가로 격자 선(밝은 선 + 옅은 바탕). 색은 재질 color가 입힌다 */
function gridTexture(THREE) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(255,255,255,0.35)';
  g.fillRect(0, 0, 64, 64);
  g.fillStyle = 'rgba(255,255,255,1)';
  g.fillRect(0, 0, 64, 3);
  g.fillRect(0, 0, 3, 64);
  g.fillStyle = 'rgba(255,255,255,0.6)';
  for (let y = 12; y < 64; y += 16) g.fillRect(0, y, 64, 1);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function labelSprite(THREE, text, color) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 96;
  const g = c.getContext('2d');
  g.fillStyle = 'rgba(12,8,6,0.62)';
  g.fillRect(16, 12, 224, 72);
  g.strokeStyle = color;
  g.lineWidth = 4;
  g.strokeRect(16, 12, 224, 72);
  g.font = '800 52px "Noto Sans KR", "Malgun Gothic", sans-serif';
  g.fillStyle = color;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 128, 50, 210);
  const map = new THREE.CanvasTexture(c);
  map.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map, transparent: true, depthWrite: false, fog: false }));
  s.scale.set(5.2, 1.95, 1);
  s.renderOrder = 3;
  return s;
}

/**
 * @param {{ THREE, scene }} o
 * set({ grid, closed, closing, floorY }) — closed·closing = 칸마다 0/1(Uint8Array). null이면 모두 지운다
 */
export function createRoyaleView({ THREE, scene }) {
  const root = new THREE.Group();
  root.name = 'br:zone';
  scene.add(root);
  const tex = gridTexture(THREE);
  const mats = {};
  for (const k of ['closing', 'closed']) {
    const t = TONE[k];
    mats[k] = {
      wall: new THREE.MeshBasicMaterial({ map: tex, color: t.wall, transparent: true, opacity: t.wallOp, side: THREE.DoubleSide, depthWrite: false }),
      floor: new THREE.MeshBasicMaterial({ color: t.floor, transparent: true, opacity: t.floorOp, side: THREE.DoubleSide, depthWrite: false })
    };
  }
  const meshes = [];
  const labels = new Map();   // `${idx}:${kind}` → sprite
  let sig = '';

  function clearMeshes() {
    for (const m of meshes) { root.remove(m); m.geometry.dispose(); }
    meshes.length = 0;
  }
  function clearLabels() {
    for (const s of labels.values()) { root.remove(s); s.material.map.dispose(); s.material.dispose(); }
    labels.clear();
  }

  /** 사각형 면 하나(4꼭짓점)를 배열에 더한다 */
  function quad(pos, uv, idx, a, b, c, d, ua, va) {
    const base = pos.length / 3;
    pos.push(...a, ...b, ...c, ...d);
    uv.push(0, 0, ua, 0, ua, va, 0, va);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  function build(arr, material) {
    if (!arr.pos.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(arr.pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(arr.uv, 2));
    geo.setIndex(arr.idx);
    const m = new THREE.Mesh(geo, material);
    m.frustumCulled = false;
    m.renderOrder = 2;
    root.add(m);
    meshes.push(m);
  }

  function set(z) {
    if (!z || !z.grid) { clearMeshes(); clearLabels(); sig = ''; return; }
    const { grid, closed, closing } = z;
    const n = grid.cols * grid.rows;
    const state = new Uint8Array(n);   // 0 안전 · 1 예고 · 2 봉쇄
    for (let i = 0; i < n; i++) state[i] = closed && closed[i] ? 2 : closing && closing[i] ? 1 : 0;
    const s = state.join('');
    if (s === sig) return;
    sig = s;
    clearMeshes();
    const y0 = Number.isFinite(z.floorY) ? z.floorY : 0;
    const lo = y0 + WALL_LOW, hi = y0 + WALL_HIGH, fy = y0 + 0.06;
    const vH = (hi - lo) / TEX_M;
    const acc = { closing: { wall: { pos: [], uv: [], idx: [] }, floor: { pos: [], uv: [], idx: [] } }, closed: { wall: { pos: [], uv: [], idx: [] }, floor: { pos: [], uv: [], idx: [] } } };
    const at = (c, r) => (c < 0 || r < 0 || c >= grid.cols || r >= grid.rows ? -1 : state[r * grid.cols + c]);
    const L = grid.cell, uL = L / TEX_M;
    for (let r = 0; r < grid.rows; r++) {
      for (let c = 0; c < grid.cols; c++) {
        const st = state[r * grid.cols + c];
        if (!st) continue;
        const k = st === 2 ? 'closed' : 'closing';
        const x0 = grid.x0 + c * L, x1 = x0 + L, z0 = grid.z0 + r * L, z1 = z0 + L;
        const f = acc[k].floor, w = acc[k].wall;
        quad(f.pos, f.uv, f.idx, [x0, fy, z0], [x1, fy, z0], [x1, fy, z1], [x0, fy, z1], 1, 1);
        // 상태가 더 낮은(더 안전한) 이웃과의 경계에만 벽. 격자 밖은 벽을 세우지 않는다(맵 가장자리 벽이 있다)
        const nb = [[c, r - 1, [x0, z0], [x1, z0]], [c, r + 1, [x0, z1], [x1, z1]], [c - 1, r, [x0, z0], [x0, z1]], [c + 1, r, [x1, z0], [x1, z1]]];
        for (const [nc, nr, a, b] of nb) {
          const ns = at(nc, nr);
          if (ns < 0 || ns >= st) continue;
          quad(w.pos, w.uv, w.idx, [a[0], lo, a[1]], [b[0], lo, b[1]], [b[0], hi, b[1]], [a[0], hi, a[1]], uL, vH);
        }
      }
    }
    for (const k of ['closing', 'closed']) { build(acc[k].floor, mats[k].floor); build(acc[k].wall, mats[k].wall); }
    // 이름표: 예고·봉쇄 칸만
    const want = new Set();
    for (let i = 0; i < n; i++) if (state[i]) want.add(`${i}:${state[i] === 2 ? 'closed' : 'closing'}`);
    for (const [key, sp] of labels) if (!want.has(key)) { root.remove(sp); sp.material.map.dispose(); sp.material.dispose(); labels.delete(key); }
    for (const key of want) {
      if (labels.has(key)) continue;
      const [i, k] = key.split(':');
      const idx = +i;
      const sp = labelSprite(THREE, `${k === 'closed' ? '봉쇄' : '예고'} ${sectorName(grid, idx)}`, TONE[k].label);
      const c = idx % grid.cols, r = Math.floor(idx / grid.cols);
      sp.position.set(grid.x0 + (c + 0.5) * L, y0 + LABEL_Y, grid.z0 + (r + 0.5) * L);
      root.add(sp);
      labels.set(key, sp);
    }
  }

  return {
    set,
    clear() { set(null); },
    dispose() {
      set(null);
      scene.remove(root);
      tex.dispose();
      for (const k of Object.keys(mats)) { mats[k].wall.dispose(); mats[k].floor.dispose(); }
    }
  };
}
