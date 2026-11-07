/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 이모트 휠 화면. B를 누르는 동안 8칸 원형 휠을 표시하고, 입력은 World에서 넘겨받는다.
 */
// SKALA FPS UI — 이모트 휠(MODES.md 4.2). B를 누르고 있는 동안 화면 가운데 8칸 원형 휠.
//   - 표시 전용: 입력(B·마우스·클릭)은 엔진(World)이 받아 props로 넘긴다. 커서를 요구하지 않는다(포인터 잠금 유지).
//   - props: { items:[{ id, n, name, icon }], selected: index|null, cursor?: { x, y } (화면 중앙 기준 px) }
//   - update는 마우스가 움직일 때마다 와도 된다: 칸 모양은 items가 바뀔 때만 다시 만든다.
import { h, svg, setText, num } from './dom.js';

/** 중앙에서 이만큼(px) 벗어나야 칸이 강조된다 */
export const EMOTE_WHEEL = Object.freeze({ deadZone: 40 });

/**
 * 중앙 기준 커서(x, y; 화면 px, y는 아래로 +) → 칸 번호(0부터, 12시에서 시계 방향) 또는 null(가운데 deadZone 안).
 * 엔진이 selected를 계산할 때 그대로 써도 된다.
 */
export function emoteIndexAt(x, y, count = 8, deadZone = EMOTE_WHEEL.deadZone) {
  const dx = num(x, 0);
  const dy = num(y, 0);
  if (!(count >= 1) || Math.hypot(dx, dy) < deadZone) return null;
  let a = Math.atan2(dx, -dy); // 0 = 12시, 시계 방향으로 커짐
  if (a < 0) a += Math.PI * 2;
  const step = (Math.PI * 2) / count;
  return Math.floor((a + step / 2) / step) % count;
}

// 휠 좌표계(viewBox -200..200): 바깥 반지름 R, 가운데 허브 반지름 R0
const R = 192;
const R0 = 74;
const GAP = 1.4; // 칸 사이 틈(도)
const HINT = '마우스로 고르고 B를 떼세요 · 그냥 떼면 취소';

function sectorPath(r0, r1, a0, a1) {
  const pt = (r, deg) => {
    const t = (deg * Math.PI) / 180;
    return `${(r * Math.sin(t)).toFixed(2)} ${(-r * Math.cos(t)).toFixed(2)}`;
  };
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M ${pt(r1, a0)} A ${r1} ${r1} 0 ${large} 1 ${pt(r1, a1)} L ${pt(r0, a1)} A ${r0} ${r0} 0 ${large} 0 ${pt(r0, a0)} Z`;
}

const normItem = (it, i) => {
  const o = it && typeof it === 'object' ? it : { id: String(it) };
  const n = o.n != null ? o.n : o.code != null ? o.code : i + 1;
  return { id: o.id != null ? String(o.id) : String(i), n: String(n), name: String(o.name || o.id || ''), icon: String(o.icon || '') };
};

export function createEmotes(ctx) {
  let props = {};
  let items = [];
  let itemsRef = null;
  let itemsSig = '';
  let sel; // 지금 강조한 칸(undefined = 아직 적용 전)
  let wheelPx = 0; // 실제 그려진 휠 반지름(px)
  let closeTimer = null;

  const wedges = svg('g', { class: 'sk-emo-wedges' });
  const svgEl = svg('svg', { viewBox: '-200 -200 400 400', class: 'sk-emo-svg', 'aria-hidden': 'true', focusable: 'false' },
    svg('circle', { r: R + 4, class: 'sk-emo-bg' }),
    wedges,
    svg('circle', { r: R0 - 4, class: 'sk-emo-hub' }));
  const labels = h('div', { class: 'sk-emo-labels' });
  const hubIco = h('div', { class: 'sk-emo-hub-ico', 'aria-hidden': 'true' });
  const hubName = h('div', { class: 'sk-emo-hub-name' });
  const hubHint = h('div', { class: 'sk-emo-hub-hint' });
  const hub = h('div', { class: 'sk-emo-center', 'aria-live': 'polite' }, hubIco, hubName, hubHint);
  const dot = h('div', { class: 'sk-emo-dot', hidden: true, 'aria-hidden': 'true' });
  const wheel = h('div', { class: 'sk-emo-wheel' }, svgEl, labels, hub, dot);
  const el = h('section', { class: 'sk-screen sk-overlay sk-emotes', hidden: true, role: 'group', 'aria-label': '이모트 휠' }, wheel);

  ctx.listen(window, 'resize', () => { wheelPx = 0; });

  function build() {
    wedges.replaceChildren();
    labels.replaceChildren();
    const n = items.length;
    if (!n) return;
    const step = 360 / n;
    const rl = (R0 + R) / 2 + 4; // 아이콘·이름 자리
    items.forEach((it, i) => {
      const c = i * step;
      wedges.append(svg('path', { d: sectorPath(R0, R, c - step / 2 + GAP, c + step / 2 - GAP), class: 'sk-emo-wedge', 'data-i': i }));
      const t = (c * Math.PI) / 180;
      labels.append(h('div', {
        class: 'sk-emo-label', 'data-i': String(i),
        style: { left: `${50 + (rl * Math.sin(t)) / 4}%`, top: `${50 - (rl * Math.cos(t)) / 4}%` },
      },
      h('span', { class: 'sk-emo-n', text: it.n }),
      h('span', { class: 'sk-emo-ico', text: it.icon || '🙂', 'aria-hidden': 'true' }),
      h('span', { class: 'sk-emo-name', text: it.name })));
    });
    sel = undefined;
  }

  function applySelected(i) {
    if (i === sel) return;
    sel = i;
    for (const node of wedges.children) node.classList.toggle('is-sel', Number(node.getAttribute('data-i')) === i);
    for (const node of labels.children) node.classList.toggle('is-sel', Number(node.getAttribute('data-i')) === i);
    const it = i != null ? items[i] : null;
    wheel.classList.toggle('has-sel', !!it);
    setText(hubIco, it ? it.icon || '🙂' : '🕺');
    setText(hubName, it ? it.name : '');
    hubName.hidden = !it;
    setText(hubHint, it ? (document.documentElement.classList.contains('pc-touch') ? '손을 떼면 시작' : 'B를 떼면 시작') : HINT);
  }

  function applyCursor(c) {
    if (!c || typeof c !== 'object') { dot.hidden = true; return; }
    dot.hidden = false;
    if (!wheelPx) wheelPx = (wheel.clientWidth || 400) / 2;
    let x = num(c.x, 0);
    let y = num(c.y, 0);
    const d = Math.hypot(x, y);
    const lim = wheelPx * (R / 200); // 반지름 밖은 테두리에 붙인다
    if (d > lim) { x = (x / d) * lim; y = (y / d) * lim; }
    dot.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    dot.classList.toggle('is-out', d >= EMOTE_WHEEL.deadZone);
  }

  function render(p) {
    if (p.items !== itemsRef) {
      itemsRef = p.items;
      const list = (Array.isArray(p.items) ? p.items : []).slice(0, 12).map(normItem);
      const s = JSON.stringify(list);
      if (s !== itemsSig) { itemsSig = s; items = list; build(); }
    }
    // selected를 생략(undefined)하면 cursor 방향으로 계산한다
    let i = p.selected;
    if (i === undefined) i = p.cursor ? emoteIndexAt(p.cursor.x, p.cursor.y, items.length) : null;
    i = Number.isInteger(i) && i >= 0 && i < items.length ? i : null;
    applySelected(i);
    applyCursor(p.cursor);
  }

  // 열고 닫을 때 짧은 애니메이션: 닫힘은 is-closing 애니메이션 뒤에 hidden
  const api = {
    el,
    visible: false,
    get props() { return props; },
    show(p) {
      if (p !== undefined) props = { ...(p || {}) };
      if (closeTimer != null) { ctx.cancel(closeTimer); closeTimer = null; }
      el.classList.remove('is-closing');
      if (!api.visible) {
        api.visible = true;
        el.hidden = false;
        wheelPx = 0;
        ctx.root.classList.add('sk-emo-open'); // 휠이 열린 동안 크로스헤어 숨김
      }
      render(props);
    },
    update(p) {
      if (p) props = { ...props, ...p };
      render(props);
    },
    hide() {
      if (!api.visible) return;
      api.visible = false;
      ctx.root.classList.remove('sk-emo-open');
      el.classList.add('is-closing');
      closeTimer = ctx.later(() => {
        closeTimer = null;
        if (!api.visible) { el.hidden = true; el.classList.remove('is-closing'); }
      }, 140);
    },
    dispose() { el.remove(); },
  };
  return api;
}
