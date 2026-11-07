/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 사용자 설정(감도, 줌 방식, 시야각, 볼륨 등)을 localStorage에 저장하고 변경을 bus로 알린다.
 */
/**
 * SKALA FPS — 사용자 설정 저장소 (localStorage 'skalafps.settings.v1'). three.js 의존 없음.
 *
 *   const settings = createSettings(bus);
 *   settings.get('sensitivity'); settings.set('zoomMode', 'toggle');
 *   // 변경 시 bus에 'settings:change' { key, value, settings } 발행
 */

export const DEFAULT_SETTINGS = Object.freeze({
  sensitivity: 1.0,     // 마우스 감도 배율 (0.1 ~ 5)
  zoomSensitivity: 1.0, // 줌 중 추가 감도 배율 (무기 모듈이 lookScale에 곱해서 사용)
  zoomMode: 'hold',     // 'hold' | 'toggle'
  invertY: false,
  fov: 75,              // 기본 FOV (60 ~ 100)
  quality: 'auto',      // 'auto' | 'high' | 'low'  (low = 그림자 끔·pixelRatio 1)
  showFps: false,
  volume: 0.8,          // 0 ~ 1 (FX 담당이 사용)
  name: ''              // 마지막으로 쓴 닉네임
});

const KEY = 'skalafps.settings.v1';

function clampSetting(key, value) {
  switch (key) {
    case 'sensitivity': case 'zoomSensitivity': {
      const n = Number(value); return Number.isFinite(n) ? Math.min(5, Math.max(0.1, n)) : DEFAULT_SETTINGS[key];
    }
    case 'fov': { const n = Number(value); return Number.isFinite(n) ? Math.min(100, Math.max(60, n)) : 75; }
    case 'volume': { const n = Number(value); return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.8; }
    case 'zoomMode': return value === 'toggle' ? 'toggle' : 'hold';
    case 'quality': return value === 'high' || value === 'low' ? value : 'auto';
    case 'invertY': case 'showFps': return !!value;
    case 'name': return String(value == null ? '' : value).slice(0, 16);
    default: return value;
  }
}

export function createSettings(bus) {
  const data = Object.assign({}, DEFAULT_SETTINGS);
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (raw && typeof raw === 'object') {
      for (const k of Object.keys(raw)) data[k] = clampSetting(k, raw[k]);
    }
  } catch (e) { /* 저장소 없음 / 손상 → 기본값 */ }

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) { /* ignore */ }
  }

  return {
    get(key) { return data[key]; },
    all() { return Object.assign({}, data); },
    set(key, value) {
      const v = clampSetting(key, value);
      if (data[key] === v) return v;
      data[key] = v;
      save();
      if (bus) bus.emit('settings:change', { key, value: v, settings: Object.assign({}, data) });
      return v;
    },
    reset() {
      for (const k of Object.keys(DEFAULT_SETTINGS)) data[k] = DEFAULT_SETTINGS[k];
      save();
      if (bus) bus.emit('settings:change', { key: '*', value: null, settings: Object.assign({}, data) });
    }
  };
}
