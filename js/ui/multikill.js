/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 연속 킬 그림. 외부 이미지 없이 도형으로 그린 SVG다. 더블~헥사 킬은 육각 방패 뒤에 킬 수만큼 탄환을 부채꼴로 꽂고,
 *          단계가 오를수록 색이 바뀌고 빛살과 날개가 붙는다. 전설(7킬 이상)은 월계관을 두른 메달에 별과 왕관이다.
 *          움직임은 css/fps.css의 .sk-mk가 맡는다(빛살 회전, 튀어나오기, 고리 번쩍임).
 */
import { svg } from './dom.js';

/**
 * id → 색과 장식. n = 탄환 수(방패 숫자), rays = 빛살 수, wings = 한쪽 깃 수.
 * base는 테두리·빛, hi는 밝은 면·글자, lo는 그림자. HUD는 base·hi를 글자 색(--mk, --mk-hi)으로도 쓴다.
 */
export const MULTI_KILL_ART = Object.freeze({
  double: Object.freeze({ n: 2, base: '#35e0ff', hi: '#c8f8ff', lo: '#0b7a94', rays: 0, wings: 0 }),
  triple: Object.freeze({ n: 3, base: '#3ddc97', hi: '#c8f9e2', lo: '#0f7a51', rays: 8, wings: 0 }),
  quadra: Object.freeze({ n: 4, base: '#a78bfa', hi: '#e7deff', lo: '#5a3cc7', rays: 12, wings: 2 }),
  penta: Object.freeze({ n: 5, base: '#ff4d8d', hi: '#ffc8dc', lo: '#a8204f', rays: 16, wings: 3 }),
  hexa: Object.freeze({ n: 6, base: '#ff6a3d', hi: '#ffd8c2', lo: '#a8320f', rays: 20, wings: 4 }),
  legend: Object.freeze({ n: 7, base: '#ffc845', hi: '#fff4c8', lo: '#a87410', rays: 24, wings: 0 })
});

/** 모르는 id는 더블 킬 모양 */
export function multiKillPalette(id) {
  return Object.prototype.hasOwnProperty.call(MULTI_KILL_ART, id) ? MULTI_KILL_ART[id] : MULTI_KILL_ART.double;
}

// 그림 좌표(viewBox 0 0 120 120). 방패 가운데
const CX = 60, CY = 62;
const r1 = (v) => Math.round(v * 10) / 10;
function polar(r, deg) {
  const a = (deg * Math.PI) / 180;
  return [r1(CX + r * Math.cos(a)), r1(CY + r * Math.sin(a))];
}
const pts = (list) => list.map((p) => p.join(',')).join(' ');
const stop = (offset, color, opacity = 1) => svg('stop', { offset, 'stop-color': color, 'stop-opacity': opacity });

function gradients(gid, p, legend) {
  return svg('defs', null,
    svg('radialGradient', { id: `${gid}-glow` }, stop(0, p.base, 0.6), stop(0.55, p.base, 0.2), stop(1, p.base, 0)),
    svg('linearGradient', { id: `${gid}-rim`, x1: 0, y1: 0, x2: 0, y2: 1 }, stop(0, p.hi), stop(0.45, p.base), stop(1, p.lo)),
    svg('linearGradient', { id: `${gid}-face`, x1: 0, y1: 0, x2: 0, y2: 1 },
      stop(0, legend ? '#3a1f63' : '#1b2742'), stop(1, legend ? '#12081f' : '#060a13')),
    svg('linearGradient', { id: `${gid}-brass`, x1: 0, y1: 0, x2: 1, y2: 0 }, stop(0, '#94661a'), stop(0.42, '#ffe6a0'), stop(1, '#a3741f')),
    svg('linearGradient', { id: `${gid}-tip`, x1: 0, y1: 0, x2: 1, y2: 0 }, stop(0, '#8f3f1c'), stop(0.45, '#f4a070'), stop(1, '#94431e')));
}

/** 뒤에서 퍼지는 빛살. 긴 것과 짧은 것이 번갈아 온다(개수는 짝수라 가운데가 바뀌지 않는다) */
function rays(k, color) {
  const g = svg('g', { class: 'sk-mk-rays', fill: color });
  const half = (360 / k) * 0.17;
  for (let i = 0; i < k; i++) {
    const a = -90 + (i * 360) / k;
    g.append(svg('polygon', { points: pts([polar(33, a - half), polar(i % 2 ? 49 : 57, a), polar(33, a + half)]) }));
  }
  return g;
}

/** 방패 왼쪽 깃 m개(위가 길다). 오른쪽은 x = 60 기준으로 뒤집어 그린다 */
function wings(gid, m) {
  const side = (mirror) => {
    const g = svg('g', { class: 'sk-mk-wing', transform: mirror ? 'matrix(-1 0 0 1 120 0)' : null, fill: `url(#${gid}-rim)`, stroke: '#05080f', 'stroke-width': 1, 'stroke-linejoin': 'round' });
    for (let k = m - 1; k >= 0; k--) {
      const ry = 54 + k * 8.5, tx = 3 + k * 5.5, ty = 40 + k * 14.5;
      g.append(svg('polygon', { points: pts([[37, ry - 4.2], [tx, ty], [tx + 8, ty + 4.6], [37, ry + 4.2]]) }));
    }
    return g;
  };
  return [side(false), side(true)];
}

/** 위(−y)를 향한 탄 하나를 방패 가운데 기준 deg 방향으로 꽂는다: 탄피(놋쇠) + 테 + 탄두(구리) */
function bullet(gid, deg) {
  return svg('g', { transform: `rotate(${r1(deg + 90)} ${CX} ${CY})` },
    svg('rect', { x: 56.5, y: 14, width: 7, height: 20, rx: 1.2, fill: `url(#${gid}-brass)`, stroke: '#5c3d0c', 'stroke-width': 0.8 }),
    svg('path', { d: 'M56.5 14.5 C56.5 9 58.3 5.6 60 4.2 C61.7 5.6 63.5 9 63.5 14.5 Z', fill: `url(#${gid}-tip)`, stroke: '#5c2a12', 'stroke-width': 0.8 }),
    svg('rect', { x: 55.8, y: 30.6, width: 8.4, height: 2.4, rx: 0.8, fill: '#6f4b14' }));
}

function fan(gid, n) {
  const step = n <= 3 ? 24 : n === 4 ? 21 : n === 5 ? 18 : 16;
  const g = svg('g', { class: 'sk-mk-ammo' });
  for (let i = 0; i < n; i++) g.append(bullet(gid, -90 + (i - (n - 1) / 2) * step));
  return g;
}

const HEX = [-90, -30, 30, 90, 150, 210];

function shieldArt(gid, p) {
  return [
    p.rays ? rays(p.rays, p.base) : null,
    p.wings ? wings(gid, p.wings) : null,
    fan(gid, p.n),
    svg('polygon', { class: 'sk-mk-shield', points: pts(HEX.map((d) => polar(31, d))), fill: `url(#${gid}-face)`, stroke: `url(#${gid}-rim)`, 'stroke-width': 4.5, 'stroke-linejoin': 'round' }),
    svg('polygon', { points: pts(HEX.map((d) => polar(25, d))), fill: 'none', stroke: p.base, 'stroke-opacity': 0.5, 'stroke-width': 1.2 }),
    svg('text', { class: 'sk-mk-num', x: CX, y: CY + 1.5, 'text-anchor': 'middle', 'dominant-baseline': 'central', fill: '#fff', stroke: p.lo, 'stroke-width': 3, 'paint-order': 'stroke', text: String(p.n) }),
  ];
}

/** 월계관 한쪽: 메달 둘레를 따라 잎이 바깥으로 비스듬히 난다 */
function laurel(gid, mirror) {
  const g = svg('g', { transform: mirror ? 'matrix(-1 0 0 1 120 0)' : null, fill: `url(#${gid}-rim)`, stroke: '#5c3d0c', 'stroke-width': 0.7 });
  g.append(svg('path', { d: `M${polar(40, 100).join(' ')} A40 40 0 0 1 ${polar(40, 222).join(' ')}`, fill: 'none', stroke: '#d9a531', 'stroke-width': 1.6 }));
  for (let i = 0; i < 8; i++) {
    const a = 104 + i * 16, [x, y] = polar(40, a);
    for (const tilt of [-28, 28]) {
      const o = polar(tilt < 0 ? 44.5 : 35.5, a + 4);
      g.append(svg('ellipse', { cx: r1((x + o[0]) / 2), cy: r1((y + o[1]) / 2), rx: 6, ry: 2.4, transform: `rotate(${r1(a + 90 + tilt)} ${r1((x + o[0]) / 2)} ${r1((y + o[1]) / 2)})` }));
    }
  }
  return g;
}

function starPoints(cx, cy, ro, ri) {
  const out = [];
  for (let i = 0; i < 10; i++) {
    const a = ((-90 + i * 36) * Math.PI) / 180, r = i % 2 ? ri : ro;
    out.push([r1(cx + r * Math.cos(a)), r1(cy + r * Math.sin(a))]);
  }
  return pts(out);
}

function legendArt(gid, p) {
  return [
    rays(p.rays, p.base),
    laurel(gid, false), laurel(gid, true),
    svg('circle', { class: 'sk-mk-shield', cx: CX, cy: CY, r: 30, fill: `url(#${gid}-face)`, stroke: `url(#${gid}-rim)`, 'stroke-width': 4.5 }),
    svg('circle', { cx: CX, cy: CY, r: 24, fill: 'none', stroke: p.base, 'stroke-opacity': 0.5, 'stroke-width': 1.2 }),
    svg('polygon', { class: 'sk-mk-star', points: starPoints(CX, CY + 1, 18, 7.4), fill: `url(#${gid}-rim)`, stroke: '#6b4a08', 'stroke-width': 1.1, 'stroke-linejoin': 'round' }),
    // 왕관: 메달 위에 앉는 세 봉우리와 띠, 보석
    svg('g', { class: 'sk-mk-crown' },
      svg('path', { d: 'M41 36 L38.5 17 L49.5 26 L60 10 L70.5 26 L81.5 17 L79 36 Z', fill: `url(#${gid}-rim)`, stroke: '#6b4a08', 'stroke-width': 1.2, 'stroke-linejoin': 'round' }),
      svg('rect', { x: 40.5, y: 31, width: 39, height: 6, rx: 1.5, fill: '#b98516', stroke: '#6b4a08', 'stroke-width': 1 }),
      svg('circle', { cx: 38.5, cy: 17, r: 2.6, fill: '#ff4d8d' }),
      svg('circle', { cx: 60, cy: 10, r: 3, fill: '#35e0ff' }),
      svg('circle', { cx: 81.5, cy: 17, r: 2.6, fill: '#ff4d8d' }),
      svg('circle', { cx: 60, cy: 34, r: 1.8, fill: '#fff4c8' })),
  ];
}

/** 연속 킬 그림 SVG 하나. 그라디언트 id는 단계마다 하나라서 같은 그림이 둘 있어도 모양이 같다 */
export function multiKillArt(id) {
  const key = Object.prototype.hasOwnProperty.call(MULTI_KILL_ART, id) ? id : 'double';
  const p = MULTI_KILL_ART[key], gid = `sk-mk-${key}`, legend = key === 'legend';
  return svg('svg', { viewBox: '0 0 120 120', class: 'sk-mk-art', 'aria-hidden': 'true', focusable: 'false' },
    gradients(gid, p, legend),
    svg('circle', { class: 'sk-mk-glow', cx: CX, cy: CY, r: 58, fill: `url(#${gid}-glow)` }),
    legend ? legendArt(gid, p) : shieldArt(gid, p));
}
