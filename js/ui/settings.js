/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 설정 저장소 어댑터와 설정 시트. 설정의 주인은 core(js/core/settings.js)이고, createUI(root, { settings })로 받은 저장소를 그대로 읽고 쓴다.
 *          저장소를 못 받았을 때만 같은 키·같은 모양의 대체 저장소를 쓴다. 닉네임은 설정이 아니라 계정(js/account)이 맡는다.
 */
import { h, btn, setText, clamp } from './dom.js';
import { sheet } from './parts.js';

export const SETTINGS_KEY = 'skalafps.settings.v1'; // core/settings.js와 같은 키

/** 설정 시트가 다루는 항목과 기본값(core 기본값과 같게 맞춤) */
export const DEFAULT_SETTINGS = Object.freeze({
  sensitivity: 1, // 마우스 감도 배율 0.1 ~ 5
  zoomMode: 'hold', // 'hold' 누르고 있기 | 'toggle' 토글
  fov: 75, // 수직 시야각(°) 60 ~ 100 — three.js PerspectiveCamera.fov 그대로
  volume: 0.8, // 전체 볼륨 0 ~ 1
  fullscreen: 'off', // 'on' | 'off' 전체 화면 유지 · 브라우저 단축키 잠금(Ctrl+W·Tab·Esc를 게임이 받는다)
});
export const UI_KEYS = Object.freeze(Object.keys(DEFAULT_SETTINGS));
const RANGES = { sensitivity: [0.1, 5], fov: [60, 100], volume: [0, 1] };

/** 알려진 키는 범위·형식을 보정하고, 모르는 키는 그대로 둔다. */
export function clampSetting(key, value) {
  if (RANGES[key]) {
    const n = Number(value);
    if (value === null || value === '' || typeof value === 'boolean' || !Number.isFinite(n)) return DEFAULT_SETTINGS[key];
    const v = clamp(n, RANGES[key][0], RANGES[key][1]);
    return key === 'fov' ? Math.round(v) : Math.round(v * 100) / 100;
  }
  if (key === 'zoomMode') return value === 'toggle' ? 'toggle' : 'hold';
  if (key === 'fullscreen') return value === 'on' ? 'on' : 'off';
  return value;
}

/** core 저장소처럼 get/set이 있는 객체인가 */
export const isSettingsStore = (s) => !!s && typeof s.get === 'function' && typeof s.set === 'function';

function lsGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
function lsSet(key, v) { try { localStorage.setItem(key, v); } catch { /* 저장 불가(사파리 개인 모드 등) */ } }

/**
 * 대체 저장소(core 저장소를 못 받았을 때). core와 같은 키를 쓰며, 쓸 때마다 저장된 JSON을 다시 읽어
 * 합치므로 UI가 모르는 키(quality, invertY, zoomSensitivity …)를 지우지 않는다.
 */
export function createLocalSettings() {
  const read = () => {
    try {
      const o = JSON.parse(lsGet(SETTINGS_KEY) || 'null');
      return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
    } catch { return {}; }
  };
  const data = { ...DEFAULT_SETTINGS };
  const stored = read();
  for (const k of Object.keys(stored)) data[k] = clampSetting(k, stored[k]);
  return {
    get: (k) => data[k],
    all: () => ({ ...data }),
    set(k, v) {
      const val = clampSetting(k, v);
      data[k] = val;
      const cur = read();
      cur[k] = val;
      lsSet(SETTINGS_KEY, JSON.stringify(cur));
      return val;
    },
  };
}

// ---------- 설정 시트 ----------
function rangeRow(ctx, { key, label, hint, min, max, step, fmt, toUi = (v) => v, fromUi = (v) => v }) {
  const out = h('output', { class: 'sk-set-val' });
  const input = h('input', { type: 'range', class: 'sk-range', min, max, step, 'aria-label': label });
  const paint = (s) => {
    const ui = toUi(s[key]);
    input.style.setProperty('--fill', `${((ui - min) / (max - min)) * 100}%`);
    setText(out, fmt(s[key]));
  };
  input.addEventListener('input', () => {
    ctx.setSetting(key, fromUi(Number(input.value)));
    paint(ctx.getSettings());
  });
  const row = h('div', { class: 'sk-set-row' },
    h('div', { class: 'sk-set-top' }, h('span', { class: 'sk-set-label', text: label }), out),
    input,
    hint ? h('p', { class: 'sk-set-hint', text: hint }) : null);
  return { row, sync(s) { input.value = String(toUi(s[key])); paint(s); } };
}

function segRow(ctx, { key, label, hint, options }) {
  const buttons = options.map(([value, text]) => {
    // 값이 바깥에서 되돌려질 수 있는 항목(전체 화면: 브라우저가 거절하면 '끔')은 잠시 뒤에 한 번 더 읽는다
    const b = btn(text, () => { ctx.setSetting(key, value); sync(ctx.getSettings()); if (ctx.later) ctx.later(() => sync(ctx.getSettings()), 600); }, 'sk-seg-btn', { role: 'radio', 'data-value': value });
    return b;
  });
  const hintEl = h('p', { class: 'sk-set-hint' });
  function sync(s) {
    for (const b of buttons) {
      const on = b.getAttribute('data-value') === s[key];
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    }
    setText(hintEl, typeof hint === 'function' ? hint(s[key]) : hint || '');
  }
  const row = h('div', { class: 'sk-set-row' },
    h('div', { class: 'sk-set-top' }, h('span', { class: 'sk-set-label', text: label })),
    h('div', { class: 'sk-seg', role: 'radiogroup', 'aria-label': label }, buttons),
    hintEl);
  return { row, sync };
}

/** 이 브라우저가 전체 화면에서 키를 잠글 수 있는가(Keyboard Lock, 크로뮴 계열) */
export const canLockKeys = () => typeof navigator !== 'undefined' && !!navigator.keyboard && typeof navigator.keyboard.lock === 'function';

/** 전체 화면 설정 아래 안내 글 */
export function fullscreenHint(value, lockable = canLockKeys()) {
  if (!lockable) return '이 브라우저는 단축키 잠금을 지원하지 않아 화면만 넓어져요. 앉은 채 앞으로 갈 때는 C 키를 쓰세요(Ctrl+W는 탭 닫기).';
  return value === 'on'
    ? 'Ctrl+W(탭 닫기)·Ctrl+T·Tab·Esc를 브라우저 대신 게임이 받아요. 나가려면 F11을 누르거나 Esc를 길게 누르세요.'
    : '켜면 앉은 채 앞으로 가도(Ctrl+W) 탭이 닫히지 않고, Tab·Esc도 게임이 받아요. F11로도 켜고 끌 수 있어요.';
}

/** 메뉴·일시정지가 각자 하나씩 만든다. 열 때 refresh()로 현재 값을 다시 읽는다. */
export function createSettingsPanel(ctx, { onClose }) {
  const isTouch = document.documentElement.classList.contains('pc-touch');
  const rows = [
    rangeRow(ctx, { key: 'sensitivity', label: isTouch ? '시점 감도' : '마우스 감도', min: 0.1, max: 5, step: 0.05, fmt: (v) => `${Number(v).toFixed(2)}×` }),
    // 휴대폰의 조준 버튼은 언제나 누를 때마다 켜고 끈다
    ...(isTouch ? [] : [segRow(ctx, {
      key: 'zoomMode', label: '줌 방식',
      options: [['hold', '누르고 있기'], ['toggle', '토글']],
      hint: (v) => (v === 'toggle' ? '우클릭 한 번에 줌, 다시 누르면 해제' : '우클릭을 누르고 있는 동안만 줌'),
    })]),
    // 휴대폰은 조작을 시작할 때 저절로 전체 화면이 된다(engine/touch.js)
    ...(isTouch ? [] : [segRow(ctx, {
      key: 'fullscreen', label: '전체 화면 · 브라우저 단축키 잠금',
      options: [['off', '끔'], ['on', '켬']],
      hint: (v) => fullscreenHint(v),
    })]),
    rangeRow(ctx, { key: 'fov', label: '시야각', hint: '수직 시야각. 넓을수록 많이 보이고 멀리 있는 적은 작아져요.', min: 60, max: 100, step: 1, fmt: (v) => `${Math.round(v)}°` }),
    rangeRow(ctx, {
      key: 'volume', label: '볼륨', min: 0, max: 100, step: 1,
      toUi: (v) => Math.round(v * 100), fromUi: (v) => v / 100, fmt: (v) => `${Math.round(v * 100)}%`,
    }),
  ];
  function refresh() {
    const s = ctx.getSettings();
    for (const r of rows) r.sync(s);
  }
  const done = btn('완료', onClose, 'sk-btn--primary', { 'data-autofocus': '' });
  const el = sheet({
    title: '설정',
    onClose,
    cls: 'sk-settings',
    body: [rows.map((r) => r.row), h('p', { class: 'sk-note', text: '설정은 이 브라우저에 저장되고 바로 적용돼요.' })],
    foot: [btn('기본값으로', () => { ctx.resetSettings(); refresh(); }, 'sk-btn--ghost'), done],
  });
  return { el, refresh };
}
