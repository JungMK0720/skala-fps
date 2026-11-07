/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 스코프 오버레이(원형 시야 + 십자선 + 거리 눈금)와 배율 표시(×N, 다단 줌 단계 점)를 그린다.
 *          amount 0~1로 페이드하고, 오버레이 없는 조준에서는 크로스헤어 옆에 같은 표시를 띄운다.
 */
import { h, svg, setText, clamp, num } from './dom.js';

// .sk-ads 불투명도(1 - amount × 2.5)가 0이 되는 지점. 여기부터는 렌즈의 표시가 넘겨받는다
const ADS_FADE_END = 0.4;

/** 배율 → "×9", "×1.7". 1배 이하(줌 없는 무기)면 빈 문자열 */
export function magLabel(m) {
  const v = Math.round(num(m, 0) * 10) / 10;
  return v > 1 ? `×${v}` : '';
}

/**
 * scope.set의 opts → { label, level, levels, aiming }
 * opts: 배율 숫자(4 → "×4") | { zoom, label } | { mag, level, levels }
 * levels는 단계가 둘 이상일 때만 남는다. aiming은 mag을 넘긴 호출에서만 켜진다(level 0 = 줌 아님, 생략 = 조준 중).
 */
export function zoomReadout(opts) {
  const o = opts && typeof opts === 'object' ? opts : { zoom: opts };
  const label = o.label != null ? String(o.label) : magLabel(o.mag != null ? o.mag : o.zoom);
  const count = Math.floor(num(o.levels, 0));
  const levels = count > 1 ? count : 0;
  const level = levels ? clamp(Math.floor(num(o.level, 0)), 0, levels) : 0;
  const aiming = o.mag != null && !!label && (o.level == null || num(o.level, 0) > 0);
  return { label, level, levels, aiming };
}

function reticle() {
  const line = (d, w, cls = '') => svg('path', { d, 'stroke-width': w, class: 'sk-ret-line' + (cls ? ' ' + cls : '') });
  const parts = [
    // 굵은 바깥 기둥(듀플렉스)
    line('M-100 0 H-34 M34 0 H100 M0 34 V100 M0 -100 V-34', 2.6),
    // 가는 중앙 십자선
    line('M-34 0 H34 M0 -34 V34', 0.5),
  ];
  // 수평·상단 밀 눈금
  let ticks = '';
  for (let i = 6; i <= 30; i += 6) {
    const len = i % 12 === 0 ? 2.6 : 1.6;
    ticks += `M${i} ${-len} V${len} M${-i} ${-len} V${len} M${-len} ${-i} H${len} `;
  }
  parts.push(line(ticks.trim(), 0.45));
  // 하단 거리 눈금(m)
  const ladder = [[8, 6, '100'], [16, 4.8, '200'], [25, 3.8, '300']];
  for (const [y, w, label] of ladder) {
    parts.push(line(`M${-w} ${y} H${w}`, 0.5));
    parts.push(svg('text', { x: w + 1.6, y: y + 1.2, class: 'sk-ret-text', text: label }));
  }
  parts.push(svg('text', { x: 1.6, y: 32.5, class: 'sk-ret-text sk-ret-unit', text: 'm' }));
  parts.push(svg('circle', { cx: 0, cy: 0, r: 0.8, class: 'sk-ret-dot' }));
  return svg('svg', { viewBox: '-100 -100 200 200', class: 'sk-scope-svg', 'aria-hidden': 'true', focusable: 'false' }, parts);
}

/** "×9 ●●" 표시 하나. 렌즈 위와 크로스헤어 옆에 하나씩 둔다 */
function zoomTag(cls) {
  const text = h('b', { class: 'sk-zoom-num' });
  const pips = h('span', { class: 'sk-zoom-pips', hidden: true });
  return { el: h('span', { class: cls, hidden: true }, text, pips), text, pips, levels: 0, level: 0 };
}

function setHidden(el, hidden) {
  if (el.hidden !== hidden) el.hidden = hidden;
}

// 매 프레임 불려도 값이 바뀐 곳만 DOM에 쓴다
function drawTag(tag, label, level, levels) {
  setText(tag.text, label);
  if (levels !== tag.levels) {
    tag.levels = levels;
    tag.level = 0;
    tag.pips.hidden = levels === 0;
    tag.pips.replaceChildren(...Array.from({ length: levels }, () => h('i')));
  }
  // level 0은 줌 아웃 중이다. 사라지는 스코프의 점이 바뀌지 않게 그대로 둔다
  if (level > 0 && level !== tag.level) {
    tag.level = level;
    const dots = tag.pips.children;
    for (let i = 0; i < dots.length; i++) dots[i].classList.toggle('is-on', i < level);
  }
}

export function createScope(ctx) {
  let amount = 0;
  let aiming = false;
  const lensTag = zoomTag('sk-scope-zoom');
  const adsTag = zoomTag('sk-ads');
  const lens = h('div', { class: 'sk-scope-lens' }, reticle(), lensTag.el);
  const overlay = h('div', { class: 'sk-scope', hidden: true }, lens);
  // 조준 표시는 오버레이가 꺼져 있어도 보여야 하므로 .sk-scope 바깥에 둔다
  const el = h('div', { class: 'sk-scope-root', 'aria-hidden': 'true' }, overlay, adsTag.el);

  /**
   * set(amount 0~1, opts?) — opts는 zoomReadout 참고.
   * opts를 생략하면 표시를 그대로 두고, amount가 0이면 조준 표시만 끈다.
   */
  function set(a, opts) {
    const v = clamp(num(a, 0), 0, 1);
    if (opts !== undefined) {
      const r = zoomReadout(opts);
      aiming = r.aiming;
      drawTag(lensTag, r.label, r.level, r.levels);
      drawTag(adsTag, r.label, r.level, r.levels);
      setHidden(lensTag.el, !r.label);
    } else if (v <= 0.001) aiming = false;
    setHidden(adsTag.el, !aiming || v >= ADS_FADE_END);
    if (Math.abs(v - amount) < 0.001 && (v > 0.001) === !overlay.hidden) return;
    amount = v;
    overlay.hidden = v <= 0.001;
    const s = v.toFixed(3);
    overlay.style.setProperty('--a', s);
    ctx.root.style.setProperty('--sk-scope', s);
  }

  return {
    el,
    set,
    get amount() { return amount; },
    dispose() { el.remove(); },
  };
}
