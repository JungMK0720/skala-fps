/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 상태 메시지를 작게 직렬화하는 도우미.
 */
/*
 * js/net/codec.js — 상태 직렬화(메시지 압축) 도우미
 *
 *   숫자 반올림, 각도 양자화, 짧은 키 매핑, 변경분(delta) 추출, 보간 유틸.
 *   Supabase는 메시지 "개수"로 한도를 세므로 크기보다 개수가 중요하지만,
 *   작은 payload는 지연과 대역폭을 줄인다.
 *
 *   const codec = createCodec({
 *     pos:    ['p', 2],          // [x, y, z] → 소수 2자리 (1cm)
 *     yaw:    ['y', 'angle'],    // 라디안 → 0..4095 정수
 *     pitch:  ['a', 'angle'],
 *     hp:     ['h', 0],          // 정수
 *     weapon: ['w'],             // 그대로
 *     crouch: ['c', 'bool']      // true/false → 1/0
 *   });
 *   room.send('st', codec.encode(state), { merge: true });
 *   room.on('message', (m) => { if (m.event === 'st') apply(m.from, codec.decode(m.payload)); });
 */

const TAU = Math.PI * 2;
const POW10 = [1, 10, 100, 1000, 10000, 100000, 1000000];

/** 소수 d자리 반올림 (-0 → 0) */
export function round(v, d = 2) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return v;
  const p = POW10[d] || Math.pow(10, d);
  const r = Math.round(v * p) / p;
  return r === 0 ? 0 : r;
}

/** 객체/배열 안의 모든 숫자를 d자리로 반올림 (새 값 반환) */
export function roundAll(value, d = 2) {
  if (typeof value === 'number') return round(value, d);
  if (Array.isArray(value)) return value.map((x) => roundAll(x, d));
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = roundAll(value[k], d);
    return out;
  }
  return value;
}

/** 라디안 → [0, steps) 정수 (기본 4096단계 ≈ 0.088°) */
export function quantizeAngle(rad, steps = 4096) {
  if (!Number.isFinite(rad)) return 0;
  let a = rad % TAU;
  if (a < 0) a += TAU;
  return Math.round((a / TAU) * steps) % steps;
}

/** quantizeAngle의 역변환 → [-π, π) */
export function dequantizeAngle(q, steps = 4096) {
  let a = ((+q || 0) / steps) * TAU;
  if (a >= Math.PI) a -= TAU;
  return a;
}

/** {x,y,z} 또는 [x,y,z] → [x,y,z] 반올림 */
export function packVec3(v, d = 2) {
  if (!v) return [0, 0, 0];
  if (Array.isArray(v)) return [round(+v[0] || 0, d), round(+v[1] || 0, d), round(+v[2] || 0, d)];
  return [round(+v.x || 0, d), round(+v.y || 0, d), round(+v.z || 0, d)];
}

export function unpackVec3(a, out = { x: 0, y: 0, z: 0 }) {
  out.x = +(a && a[0]) || 0;
  out.y = +(a && a[1]) || 0;
  out.z = +(a && a[2]) || 0;
  return out;
}

function encodeValue(v, mode) {
  if (mode === 'angle') return quantizeAngle(+v || 0);
  if (mode === 'bool') return v ? 1 : 0;
  if (typeof mode === 'number') {
    if (typeof v === 'number') return round(v, mode);
    if (Array.isArray(v)) return v.map((x) => (typeof x === 'number' ? round(x, mode) : x));
    if (v && typeof v === 'object' && 'x' in v) return packVec3(v, mode);
  }
  return v;
}

function decodeValue(v, mode) {
  if (mode === 'angle') return dequantizeAngle(v);
  if (mode === 'bool') return !!v;
  return v;
}

/**
 * 스키마: { 긴키: ['짧은키', 모드?] } — 모드: 숫자(소수 자리) | 'angle' | 'bool' | 생략(그대로)
 * 스키마에 없는 키는 그대로 통과한다. 짧은 키가 겹치면 에러.
 */
export function createCodec(schema) {
  const enc = new Map();
  const dec = new Map();
  for (const [long, spec] of Object.entries(schema || {})) {
    const [short, mode] = Array.isArray(spec) ? spec : [spec];
    if (dec.has(short)) throw new Error('codec: 짧은 키 중복 ' + short);
    enc.set(long, [short, mode]);
    dec.set(short, [long, mode]);
  }
  return {
    encode(obj) {
      const out = {};
      if (!obj) return out;
      for (const k of Object.keys(obj)) {
        const v = obj[k];
        if (v === undefined) continue;
        const e = enc.get(k);
        if (e) out[e[0]] = encodeValue(v, e[1]);
        else out[k] = v;
      }
      return out;
    },
    decode(obj) {
      const out = {};
      if (!obj) return out;
      for (const k of Object.keys(obj)) {
        const d = dec.get(k);
        if (d) out[d[0]] = decodeValue(obj[k], d[1]);
        else out[k] = obj[k];
      }
      return out;
    }
  };
}

function sameValue(a, b, eps) {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= eps;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!sameValue(a[i], b[i], eps)) return false;
    return true;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b);
  return false;
}

/** next에서 prev와 달라진 키만 (얕은 비교, 숫자는 eps 허용). 변화 없으면 null */
export function delta(prev, next, eps = 0) {
  if (!prev) return next ? { ...next } : null;
  let out = null;
  for (const k of Object.keys(next || {})) {
    if (!sameValue(prev[k], next[k], eps)) (out || (out = {}))[k] = next[k];
  }
  return out;
}

export function applyDelta(base, d) { return d ? Object.assign(base || {}, d) : base; }

/** JSON 직렬화 시 UTF-8 바이트 수 */
export function jsonBytes(obj) {
  const s = JSON.stringify(obj);
  if (s === undefined) return 0;
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s).length;
  return s.length;
}

export const lerp = (a, b, t) => a + (b - a) * t;

/** 각도 보간 (최단 방향) */
export function lerpAngle(a, b, t) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return a + d * t;
}
