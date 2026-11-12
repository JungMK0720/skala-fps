/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: UI 공용 DOM 헬퍼와 표시 형식(팀·모드·핑·시간·포인트). 동적 문자열은 항상 textContent나 텍스트 노드로만 넣는다.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';
const PROP_KEYS = new Set(['value', 'checked', 'disabled', 'hidden', 'selected', 'tabIndex']);

/** h('div', { class, text, style, dataset, onclick, ...attrs }, ...children) */
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) setProps(el, props);
  append(el, kids);
  return el;
}

/** SVG 요소. attrs는 setAttribute로만 넣는다. */
export function svg(tag, attrs, ...kids) {
  const el = document.createElementNS(SVG_NS, tag);
  if (attrs) {
    for (const k of Object.keys(attrs)) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'text') el.textContent = String(v);
      else el.setAttribute(k, String(v));
    }
  }
  append(el, kids);
  return el;
}

function setProps(el, props) {
  for (const k of Object.keys(props)) {
    const v = props[k];
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = String(v);
    else if (k === 'style') {
      if (typeof v === 'string') el.style.cssText = v;
      else for (const sk of Object.keys(v)) {
        if (sk.startsWith('--')) el.style.setProperty(sk, v[sk]);
        else el.style[sk] = v[sk];
      }
    } else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on')) {
      if (typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (PROP_KEYS.has(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
}

function append(el, kids) {
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false || c === true) continue;
    el.append(c instanceof Node ? c : String(c)); // 문자열은 텍스트 노드가 된다
  }
}

/** type=button 버튼 */
export function btn(label, onClick, cls = '', extra = {}) {
  return h('button', { type: 'button', class: 'sk-btn' + (cls ? ' ' + cls : ''), onclick: onClick, ...extra }, label);
}

/** 값이 바뀔 때만 textContent를 쓴다(매 프레임 호출용). */
export function setText(el, v) {
  const t = v == null ? '' : String(v);
  if (el.__skText !== t) { el.__skText = t; el.textContent = t; }
}

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export function fmtTime(sec) {
  if (sec == null || !Number.isFinite(Number(sec))) return '-:--';
  const t = Math.max(0, Math.ceil(Number(sec)));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

export const TEAMS = Object.freeze({
  owner: Object.freeze({ key: 'owner', name: '블루', en: 'Blue', emoji: '🟦' }),
  charterer: Object.freeze({ key: 'charterer', name: '레드', en: 'Red', emoji: '🟥' }),
});
export const TEAM_KEYS = Object.freeze(['owner', 'charterer']);
export const teamKey = (t) => (t === 'owner' || t === 'charterer' ? t : '');

export function pingText(ms) {
  const n = Number(ms);
  return ms == null || !Number.isFinite(n) ? '—' : `${Math.round(n)}ms`;
}
export function pingClass(ms) {
  const n = Number(ms);
  if (ms == null || !Number.isFinite(n)) return 'is-na';
  return n < 80 ? 'is-good' : n < 150 ? 'is-mid' : 'is-bad';
}

export const num = (v, d = 0) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : d);

/** 1250 → "1,250 P" */
export const fmtPoints = (n) => `${Math.max(0, Math.floor(num(n, 0))).toLocaleString('ko-KR')} P`;

/** 포인트 증감: 1250 → "+1,250", -4 → "-4", 0 → "+0". 음수 앞에 +를 겹쳐 붙이지 않는다(봇전 쉬움 난이도 줄은 음수다) */
export function fmtDelta(n) {
  const v = Math.round(num(n, 0)) || 0;   // -0.4 → -0 → 0
  return `${v < 0 ? '-' : '+'}${Math.abs(v).toLocaleString('ko-KR')}`;
}

/** 초 → "2시간 05분" / "12분 30초" / "45초" */
export function fmtPlayTime(sec) {
  const t = Math.max(0, Math.floor(num(sec, 0)));
  const hours = Math.floor(t / 3600);
  const minutes = Math.floor((t % 3600) / 60);
  if (hours) return `${hours}시간 ${String(minutes).padStart(2, '0')}분`;
  return minutes ? `${minutes}분 ${String(t % 60).padStart(2, '0')}초` : `${t}초`;
}

// ---------- 모드 (MODES.md 3.3 · 5절) — mode를 생략하면 'team'. 폭파 미션('bomb')도 팀으로 나뉜다 ----------
export const modeKey = (m) => (m === 'ffa' ? 'ffa' : m === 'bomb' ? 'bomb' : m === 'zombie' ? 'zombie' : 'team');
export const FFA_TARGET = 20;
export const MODE_ICON = Object.freeze({ team: '⚔️', ffa: '🎯', bomb: '💣', zombie: '🧟' });
export const MODE_NAME = Object.freeze({ team: '팀전', ffa: '개인전', bomb: '폭파 미션', zombie: '좀비 물량 막기' });
/** "팀전 · 5판 3선승" / "개인전 · 20킬" / "폭파 미션 · 5판 3선승" / "좀비 물량 막기 · 최대 4명" */
export function modeLabel(mode, opts = {}) {
  const key = modeKey(mode);
  if (key === 'ffa') return `개인전 · ${Math.max(1, Math.floor(num(opts.killTarget, FFA_TARGET)))}킬`;
  if (key === 'zombie') return '좀비 물량 막기 · 최대 4명';
  const target = Math.max(1, Math.floor(num(opts.target, 3)));
  const bestOf = Math.max(1, Math.floor(num(opts.bestOf, target * 2 - 1)));
  return `${MODE_NAME[key]} · ${bestOf}판 ${target}선승`;
}

/** 폭파 미션 진영 이름 */
export const SIDE_NAME = Object.freeze({ attack: '공격', defense: '수비' });
/** 이번 라운드 공격 팀(attack)으로 본 team의 진영: 'attack' | 'defense' | ''(둘 중 하나라도 모르면) */
export function bombSide(team, attack) {
  const a = teamKey(attack);
  const t = teamKey(team);
  return a && t ? (t === a ? 'attack' : 'defense') : '';
}

/** fps.css가 페이지에 없으면 모듈 위치 기준으로 붙인다. 붙였으면 그 link를 돌려준다. */
export function ensureStyles() {
  if (document.querySelector('link[data-sk-ui], link[href$="fps.css"]')) return null;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('../../css/fps.css', import.meta.url).href;
  link.setAttribute('data-sk-ui', '');
  document.head.append(link);
  return link;
}

/**
 * hud.damageFrom()용 상대각(rad). 0 = 정면, +π/2 = 오른쪽, -π/2 = 왼쪽, ±π = 뒤.
 * yaw = three.js rotation.y (yaw 0일 때 전방 -Z). self/from = { x, z }.
 */
export function relativeAngle(self, yaw, from) {
  const dx = from.x - self.x;
  const dz = from.z - self.z;
  const fwd = -dx * Math.sin(yaw) - dz * Math.cos(yaw);
  const right = dx * Math.cos(yaw) - dz * Math.sin(yaw);
  return Math.atan2(right, fwd);
}

/** 입력 중인 요소인가(엔진 키 처리 무시용) */
export function isTextField(el) {
  if (!el || !el.tagName) return false;
  if (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  if (el.tagName !== 'INPUT') return false;
  return !['range', 'button', 'checkbox', 'radio', 'submit', 'reset', 'color'].includes(el.type);
}
