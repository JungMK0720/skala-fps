/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 모듈 사이를 잇는 이벤트 버스. three.js 의존이 없다.
 */
/**
 * SKALA FPS — 이벤트 버스. three.js 의존 없음.
 *
 *   import { on, once, emit } from './core/bus.js';
 *   const off = on('hit:player', (e) => { ... });   // → off() 로 해제
 *   emit('hit:player', { targetId, part, damage });
 *
 * - 리스너 예외는 잡아서 console.error로만 남긴다(다른 모듈이 멈추지 않게).
 * - '*' 리스너는 모든 이벤트를 (evt, data)로 받는다(디버그용).
 * - 이벤트 목록과 payload는 CORE_API.md 참고.
 */

export function createBus() {
  /** @type {Map<string, Set<Function>>} */
  const map = new Map();

  function on(evt, fn) {
    if (typeof fn !== 'function') throw new TypeError('bus.on: fn must be a function');
    let set = map.get(evt);
    if (!set) { set = new Set(); map.set(evt, set); }
    set.add(fn);
    return () => off(evt, fn);
  }

  function once(evt, fn) {
    const offFn = on(evt, (data) => { offFn(); fn(data); });
    return offFn;
  }

  function off(evt, fn) {
    const set = map.get(evt);
    if (!set) return;
    set.delete(fn);
    if (!set.size) map.delete(evt);
  }

  function call(fn, evt, a, b) {
    try { fn(a, b); } catch (err) { console.error('[bus] listener error on "' + evt + '":', err); }
  }

  function emit(evt, data) {
    const set = map.get(evt);
    if (set) for (const fn of Array.from(set)) call(fn, evt, data);
    const all = map.get('*');
    if (all) for (const fn of Array.from(all)) call(fn, evt, evt, data);
  }

  function has(evt) { return map.has(evt); }
  function clear(evt) { if (evt) map.delete(evt); else map.clear(); }

  return { on, once, off, emit, has, clear };
}

/** 앱 전역 공유 버스 (모든 모듈이 같은 인스턴스를 쓴다) */
export const bus = createBus();
export const on = bus.on;
export const once = bus.once;
export const off = bus.off;
export const emit = bus.emit;
export default bus;
