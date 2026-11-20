/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 버프·디버프 칩 줄. 좀비 모드 HUD의 체력 칸 위 줄(hud.set({ status }))과 ESC 일시정지의 '버프·디버프' 목록이 같이 쓴다.
 *          버프는 빨간 테두리, 디버프는 초록 테두리. 겹 수·값은 오른쪽 위 숫자, 남은 시간은 아래 글자와 줄어드는 부채꼴·막대(--f)로 보인다.
 *          칩은 id마다 하나를 만들어 두고 바뀐 값만 DOM에 쓴다(매 프레임 불러도 된다). 설명(desc)은 항목을 만드는 쪽(game/horde/client.js
 *          hordeStatusList) 한 곳에서 온다.
 */
import { h, setText, clamp, num } from './dom.js';

const STATUS_MAX = 12;           // 한 줄의 최대 칩 수
const STATUS_REFILL_MS = 400;    // 남은 시간이 지난번보다 이만큼 넘게 늘면 새로 걸린 것으로 보고 전체 시간을 다시 잰다
const STATUS_STEPS = 200;        // 줄어드는 표시의 눈금(1/200)

/**
 * 입력 목록 → 정리된 칩 목록. 배열이 아니면 [](줄을 숨긴다). id가 없거나 겹치면 뒤의 것은 버리고 STATUS_MAX개까지.
 * kind는 'buff'|'debuff'(모르면 'buff'), badge는 value가 있으면 그 값, 아니면 stacks가 2 이상일 때 겹 수, leftMs는 남은 시간(없으면 null)
 */
export function statusSpec(list) {
  const out = [];
  if (!Array.isArray(list)) return out;
  const ids = new Set();
  for (const s of list) {
    if (out.length >= STATUS_MAX) break;
    if (!s || typeof s !== 'object' || s.id == null || s.id === '' || ids.has(String(s.id))) continue;
    const id = String(s.id);
    ids.add(id);
    const stacks = Math.max(0, Math.floor(num(s.stacks, 0)));
    const badge = s.value != null && s.value !== '' ? String(s.value) : stacks > 1 ? String(stacks) : '';
    const left = s.leftMs == null || s.leftMs === '' || !Number.isFinite(Number(s.leftMs)) ? null : Math.max(0, Number(s.leftMs));
    const total = num(s.totalMs, 0) > 0 ? Number(s.totalMs) : null;
    const text = (v) => (v == null ? '' : String(v));
    out.push({ id, kind: s.kind === 'debuff' ? 'debuff' : 'buff', icon: text(s.icon), name: text(s.name), desc: text(s.desc), badge, stacks, leftMs: left, totalMs: total });
  }
  return out;
}

/**
 * 줄어드는 표시의 전체 시간. totalMs를 주면 그 값, 아니면 처음 본 남은 시간에서 잰다:
 * 남은 시간이 지난번보다 STATUS_REFILL_MS 넘게 늘면(다시 걸림) 그 값으로 새로 시작하고, 아니면 지금까지 본 가장 큰 값
 */
export function statusTotal(totalMs, prevTotal, prevLeft, leftMs) {
  if (totalMs > 0) return Math.max(totalMs, leftMs);
  if (!(prevTotal > 0) || prevLeft == null || leftMs > prevLeft + STATUS_REFILL_MS) return Math.max(1, leftMs);
  return Math.max(prevTotal, leftMs);
}

/** 남은 비율(0~1)을 STATUS_STEPS 눈금으로(매 프레임 같은 값이면 DOM에 쓰지 않는다) */
export function statusFrac(leftMs, totalMs) {
  return Math.round(clamp(leftMs / Math.max(1, totalMs), 0, 1) * STATUS_STEPS) / STATUS_STEPS;
}

/** 남은 ms → 칩 아래 글자. 10초 밑은 0.1초 단위('4.3'), 그 위는 정수('12'). 둘 다 올림 */
export function statusTimeText(ms) {
  const tenths = Math.max(0, Math.ceil(Math.max(0, num(ms, 0)) / 100 - 1e-6));
  return tenths >= 100 ? String(Math.ceil(tenths / 10)) : (tenths / 10).toFixed(1);
}

/** 칩 설명의 아래 줄: '남은 시간 4.3초 · 12겹' / '보호막 30' 같은 지금 값. 없으면 '' */
export function statusMeta(it) {
  const parts = [];
  if (it.leftMs != null) parts.push(`남은 시간 ${statusTimeText(it.leftMs)}초`);
  if (it.stacks > 1) parts.push(`${it.stacks}겹`);
  return parts.join(' · ');
}

/**
 * 칩 줄 하나. apply(list)는 매 프레임 불러도 된다.
 * @param {object} [o]
 * @param {string} [o.cls]     줄 요소의 class(기본 'sk-status')
 * @param {boolean} [o.tips]   true면 칩에 초점을 줄 수 있고, 마우스를 올리거나 초점을 주면 설명 상자(이름·설명·남은 시간/겹)가 뜬다(일시정지).
 *                             false면 title·aria-label로만 설명한다(HUD: 포인터가 잠겨 있다)
 * @returns {{ el: HTMLElement, apply(list): void }}
 */
export function createStatusRow(o = {}) {
  const tips = !!o.tips;
  const el = h('div', { class: o.cls || 'sk-status', hidden: true, role: 'list', 'aria-label': '버프와 디버프' });
  const chips = new Map();   // id → { el, ico, n, t, tip*, 마지막으로 쓴 값 }
  const seen = new Set();

  function chip(id) {
    const ico = h('span', { class: 'sk-st-ico', 'aria-hidden': 'true' });
    const n = h('b', { class: 'sk-st-n', hidden: true, 'aria-hidden': 'true' });
    const t = h('span', { class: 'sk-st-t', hidden: true, 'aria-hidden': 'true' });
    const tipName = tips ? h('b', { class: 'sk-st-tip-name' }) : null;
    const tipDesc = tips ? h('span', { class: 'sk-st-tip-desc' }) : null;
    const tipMeta = tips ? h('small', { class: 'sk-st-tip-meta', hidden: true }) : null;
    const tip = tips ? h('span', { class: 'sk-st-tip', role: 'tooltip', 'aria-hidden': 'true' }, tipName, tipDesc, tipMeta) : null;
    const node = h('div', { class: 'sk-st', role: 'listitem', dataset: { id }, ...(tips ? { tabindex: '0' } : {}) },
      ico, h('i', { class: 'sk-st-bar', 'aria-hidden': 'true' }), n, t, tip);
    return { el: node, ico, n, t, tipName, tipDesc, tipMeta, kind: '', icon: null, label: null, badge: null, timed: false, total: 0, left: null, frac: -1, text: null, meta: null };
  }

  function apply(list) {
    const items = statusSpec(list);
    if (!items.length && !chips.size) { if (!el.hidden) el.hidden = true; return; }
    seen.clear();
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      let c = chips.get(it.id);
      if (!c) { c = chip(it.id); chips.set(it.id, c); }
      seen.add(it.id);
      if (c.kind !== it.kind) {
        c.kind = it.kind;
        c.el.classList.toggle('is-buff', it.kind === 'buff');
        c.el.classList.toggle('is-debuff', it.kind === 'debuff');
      }
      if (c.icon !== it.icon) { c.icon = it.icon; setText(c.ico, it.icon); }
      if (c.badge !== it.badge) { c.badge = it.badge; setText(c.n, it.badge); c.n.hidden = !it.badge; }
      // 이름·설명(남은 시간은 넣지 않는다: 매 프레임 속성을 바꾸지 않게)
      const kindText = it.kind === 'debuff' ? '디버프' : '버프';
      const label = `${kindText} · ${it.name}${it.desc ? ` — ${it.desc}` : ''}`;
      if (c.label !== label) {
        c.label = label;
        c.el.setAttribute('aria-label', label);
        if (tips) { setText(c.tipName, `${kindText} · ${it.name}`); setText(c.tipDesc, it.desc); c.tipDesc.hidden = !it.desc; }
        else c.el.title = label;
      }
      const timed = it.leftMs != null;
      if (timed !== c.timed) {
        c.timed = timed;
        c.el.classList.toggle('is-timed', timed);
        c.t.hidden = !timed;
      }
      if (timed) {
        c.total = statusTotal(it.totalMs, c.total, c.left, it.leftMs);
        c.left = it.leftMs;
        const f = statusFrac(it.leftMs, c.total);
        if (f !== c.frac) { c.frac = f; c.el.style.setProperty('--f', String(f)); }
        const text = statusTimeText(it.leftMs);
        if (text !== c.text) { c.text = text; setText(c.t, text); }
      } else { c.total = 0; c.left = null; }
      if (tips) {
        const meta = statusMeta(it);
        if (meta !== c.meta) { c.meta = meta; setText(c.tipMeta, meta); c.tipMeta.hidden = !meta; }
      }
      // 순서: i번째 자리가 이 칩이 아니면 옮긴다(사라질 칩은 뒤로 밀렸다가 아래에서 지운다)
      const at = el.children[i];
      if (at !== c.el) el.insertBefore(c.el, at || null);
    }
    for (const [id, c] of chips) if (!seen.has(id)) { c.el.remove(); chips.delete(id); }
    const hide = !items.length;
    if (el.hidden !== hide) el.hidden = hide;
  }

  return { el, apply };
}
