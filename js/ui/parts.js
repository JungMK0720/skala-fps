/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 화면 공통 부품. 화면 골격, 모달 시트, 맵 카드, 키캡, 포인트 표시, 캐릭터 초상 칸, 무기 카드 조각(막대·스탯·요약), 하나만 고르는 버튼 묶음을 둔다.
 */
import { h, btn, clamp, fmtPoints, num, setText } from './dom.js';
import { mapIcon, uiIcon, weaponInfo } from './icons.js';
import { TEAMS } from '../core/consts.js';

/**
 * 화면 골격. show(props)는 props를 통째로 바꾸고(생략 시 유지), update(props)는 합친다.
 * render(props, { fresh, first, patch })
 */
export function makeScreen(el, { render, onShow, onHide, onDispose } = {}) {
  let props = {};
  const api = {
    el,
    visible: false,
    get props() { return props; },
    show(p) {
      if (p !== undefined) props = { ...(p || {}) };
      const first = !api.visible;
      if (first) { api.visible = true; el.hidden = false; }
      if (render) render(props, { fresh: true, first, patch: props });
      if (first && api.visible && onShow) onShow(props);
    },
    update(p) {
      if (p) props = { ...props, ...p };
      if (render) render(props, { fresh: false, first: false, patch: p || {} });
    },
    hide() {
      if (!api.visible) return;
      api.visible = false;
      el.hidden = true;
      if (onHide) onHide();
    },
    dispose() {
      if (onDispose) onDispose();
      el.remove();
    },
  };
  return api;
}

/** 모달 내용물 시트 */
export function sheet({ title, body, foot, onClose, cls = '' }) {
  return h('div', { class: 'sk-sheet sk-steel' + (cls ? ' ' + cls : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title, tabindex: '-1' },
    h('div', { class: 'sk-hazard', 'aria-hidden': 'true' }),
    h('header', { class: 'sk-sheet-head' },
      h('h2', { class: 'sk-sheet-title sk-stencil', text: title }),
      btn('✕', onClose, 'sk-btn--icon', { 'aria-label': '닫기' })),
    h('div', { class: 'sk-sheet-body' }, body),
    foot ? h('footer', { class: 'sk-sheet-foot' }, foot) : null);
}

/** 화면 안의 모달 레이어. 배경 클릭·Esc로 닫힌다. */
export function createModal() {
  let opener = null;
  let onClosed = null;
  const el = h('div', { class: 'sk-modal', hidden: true });
  el.addEventListener('pointerdown', (e) => { if (e.target === el) close(); });
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  });
  function open(content, cb) {
    opener = document.activeElement;
    onClosed = cb || null;
    el.replaceChildren(content);
    el.hidden = false;
    const target = content.querySelector('[data-autofocus]') || content;
    if (target.focus) target.focus({ preventScroll: true });
  }
  function close() {
    if (el.hidden) return;
    el.hidden = true;
    el.replaceChildren();
    const cb = onClosed;
    onClosed = null;
    if (cb) cb();
    if (opener && opener.isConnected && opener.focus) opener.focus({ preventScroll: true });
    opener = null;
  }
  return { el, open, close, get isOpen() { return !el.hidden; } };
}

/** 맵 선택 카드(라디오처럼 동작). onPick이 없으면 보기 전용. */
export function mapCard(m, { selected = false, onPick, small = false } = {}) {
  const kids = [
    mapIcon(m.id),
    h('span', { class: 'sk-mapcard-text' },
      h('span', { class: 'sk-mapcard-name', text: m.name }),
      m.nameEn ? h('span', { class: 'sk-mapcard-en', text: m.nameEn }) : null,
      m.desc && !small ? h('span', { class: 'sk-mapcard-desc', text: m.desc }) : null,
      m.tag && !small ? h('span', { class: 'sk-mapcard-tag', text: m.tag }) : null),
  ];
  const cls = 'sk-mapcard' + (selected ? ' is-on' : '') + (small ? ' sk-mapcard--sm' : '');
  if (!onPick) return h('div', { class: cls + ' is-static' }, kids);
  return h('button', {
    type: 'button', class: cls, role: 'radio', 'aria-checked': selected ? 'true' : 'false',
    title: m.desc || m.name, onclick: () => onPick(m.id),
  }, kids);
}

export function keycap(label) {
  return h('kbd', { class: 'sk-key', text: label });
}

/** 포인트 표시. set(n)은 값이 바뀔 때만 DOM을 쓴다. */
export function pointsBadge(cls = '') {
  const value = h('b', { class: 'sk-points-val' });
  const el = h('span', { class: 'sk-points' + (cls ? ' ' + cls : ''), title: '포인트' }, uiIcon('coin', 'sk-points-ico'), value);
  return { el, set(n) { setText(value, fmtPoints(n)); } };
}

/**
 * 캐릭터 초상 칸(core/avatar-defs.js의 항목 a). paint(artFn, team, next?): artFn(id, team) → 그림 주소 | null.
 * 그림이 없으면(그릴 렌더러가 없는 데모 등) 아이콘을 보여 준다. 같은 캐릭터·팀이면 다시 부르지 않는다. next를 주면 그 캐릭터로 바꾼다.
 */
export function avatarArtEl(a, cls = '') {
  let cur = a;
  let key = '';
  const img = h('img', { class: 'sk-av-img', alt: '', draggable: 'false', hidden: true });
  const ico = h('span', { class: 'sk-av-ico', text: (a && a.icon) || '' });
  const el = h('div', { class: 'sk-av-art' + (cls ? ' ' + cls : ''), 'aria-hidden': 'true' }, img, ico);
  return {
    el,
    paint(artFn, team, next) {
      if (next && next !== cur) { cur = next; key = ''; setText(ico, cur.icon || ''); }
      const k = cur.id + ':' + team;
      if (k === key) return;
      let url = null;
      try { url = typeof artFn === 'function' ? artFn(cur.id, team) : null; } catch (err) { url = null; }
      key = url ? k : '';
      if (url) img.src = url;
      img.hidden = !url;
      ico.hidden = !!url;
      el.classList.toggle('has-art', !!url);
      el.dataset.team = String(team || '');
      // 초상 뒤 빛: 그 팀의 밝은 색(팀 색을 바꿔도 따라간다)
      const T = TEAMS[team];
      const m = T && /^#?([0-9a-f]{6})$/i.exec(T.light);
      if (m) {
        const n = parseInt(m[1], 16);
        el.style.setProperty('--sk-av-glow', `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, .24)`);
      }
    }
  };
}

// ---------- 무기 카드 조각 ----------
const BAR_LABELS = { power: '위력', rate: '연사', accuracy: '정확도', mobility: '기동성', range: '사거리', control: '반동 제어' };

/** bars: { power: 0~100, ... } 또는 [{ label, value }] → [{ label, value }] */
export function normBars(b) {
  if (!b || typeof b !== 'object') return [];
  const pairs = Array.isArray(b)
    ? b.filter(Boolean).map((x) => [x.label != null ? x.label : x.key, x.value])
    : Object.keys(b).map((k) => [BAR_LABELS[k] || k, b[k]]);
  return pairs.filter(([label]) => label != null && label !== '')
    .map(([label, v]) => ({ label: String(label), value: clamp(num(v, 0), 0, 100) }));
}

/** stats: [{ label, value, unit? }] · [[label, value]] · { label: value } → [{ label, value }] */
export function normStats(st) {
  if (!st) return [];
  const one = (label, value, unit) => ({ label: String(label), value: `${value}${unit ? unit : ''}` });
  if (Array.isArray(st)) {
    return st.filter(Boolean).map((x) => (Array.isArray(x) ? one(x[0], x[1]) : one(x.label != null ? x.label : x.name, x.value, x.unit)));
  }
  if (typeof st === 'object') return Object.keys(st).map((k) => one(k, st[k]));
  return [];
}

function rateSummary(d) {
  if (d.burst) return { label: '점사', value: `${d.burst.count}발` };
  if (d.fire === 'bolt') return { label: '볼트', value: `${d.bolt}초` };
  return { label: '연사', value: d.fire === 'semi' ? `${d.fireInterval}초` : `${d.rpm}rpm` };
}

/** 작은 카드에 넣을 핵심 수치 3~4개. 수치표가 없는 정의(데모 목 데이터)는 stats 앞쪽을 쓴다. */
export function weaponSummary(d) {
  if (d.melee) {
    const { slash, stab } = d.melee;
    return [{ label: slash.label, value: slash.damage }, { label: stab.label, value: stab.damage }, { label: '이동', value: `${Math.round(d.moveMul * 100)}%` }];
  }
  if (!d.damage) return normStats(d.stats).slice(0, 3);
  const rows = [{ label: '머리', value: d.damage.head }, { label: '몸', value: d.damage.body }];
  if (d.kind === 'sniper') rows.push({ label: '손·발', value: d.damage.hand });
  if (d.pellets > 1) rows.push({ label: '펠릿', value: `${d.pellets}발` });
  rows.push(rateSummary(d));
  if (rows.length < 4) rows.push({ label: '탄', value: `${d.mag}/${d.premium ? '∞' : d.reserve}` });
  return rows;
}

/** 무기 id·정의 → 카드에 필요한 값 */
export function normWeapon(reg, ref) {
  const info = weaponInfo(reg, ref);
  const d = info.def;
  return {
    id: info.id,
    slot: d.slot,
    name: info.name,
    short: info.short || info.name,
    icon: info.icon,
    role: d.role || '',
    tagline: d.tagline || d.subtitle || d.summary || '',
    stats: normStats(d.stats),
    bars: normBars(d.bars),
    summary: weaponSummary(d),
    price: num(d.price, 0),
    premium: !!d.premium,
  };
}

/** 위력·연사 같은 막대 그래프. button 안에도 넣을 수 있게 span만 쓴다. */
export function barMeters(bars, cls = '') {
  return h('span', { class: 'sk-lo-bars' + (cls ? ' ' + cls : '') },
    bars.map((b) => h('span', { class: 'sk-lo-barrow' },
      h('span', { class: 'sk-lo-barlabel', text: b.label }),
      h('span', { class: 'sk-meter sk-lo-meter', role: 'meter', 'aria-label': b.label, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': b.value },
        h('i', { style: { transform: `scaleX(${b.value / 100})` } })))));
}

/** 핵심 수치 칩. button 안에도 넣을 수 있게 span만 쓴다. */
export function summaryChips(rows) {
  return h('span', { class: 'sk-lo-sum' },
    rows.map((s) => h('span', { class: 'sk-lo-sumitem' }, h('small', { text: s.label }), h('b', { text: s.value }))));
}

// ---------- 하나만 고르는 버튼 묶음 ----------
/**
 * 장비 칸처럼 몇 개 중 하나를 고르는 작은 버튼 묶음. set(items, selectedId)는 같은 id의 버튼을 그대로 두어 키보드 포커스를 잃지 않는다.
 * items: [{ id, label, icon?, title? }]. 화살표 키로 옆 버튼으로 옮겨 간다.
 */
export function createChoiceRow({ label, onPick, cls = '' }) {
  const buttons = new Map();
  const box = h('div', { class: 'sk-choices' + (cls ? ' ' + cls : ''), role: 'radiogroup', 'aria-label': label });
  box.addEventListener('keydown', (e) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    const list = [...box.children];
    const next = list[list.indexOf(document.activeElement) + step];
    if (next) { e.preventDefault(); e.stopPropagation(); next.focus(); }
  });

  function make(id) {
    const icon = h('span', { class: 'sk-choice-ico', 'aria-hidden': 'true' });
    const text = h('span', { class: 'sk-choice-txt' });
    const el = h('button', { type: 'button', class: 'sk-choice', role: 'radio', onclick: () => onPick(id) }, icon, text);
    return { el, icon, text };
  }

  function set(items, selected) {
    for (const [id, b] of buttons) {
      if (!items.some((it) => it.id === id)) { b.el.remove(); buttons.delete(id); }
    }
    const order = items.map((it) => {
      if (!buttons.has(it.id)) buttons.set(it.id, make(it.id));
      const b = buttons.get(it.id);
      setText(b.icon, it.icon || '');
      setText(b.text, it.label);
      b.el.title = it.title || it.label;
      b.el.classList.toggle('is-on', it.id === selected);
      b.el.setAttribute('aria-checked', it.id === selected ? 'true' : 'false');
      return b.el;
    });
    const same = order.length === box.children.length && order.every((n, i) => box.children[i] === n);
    if (!same) box.replaceChildren(...order);
  }

  return { el: box, set };
}
