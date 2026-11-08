/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 코어 아바타용 스냅샷 보간 버퍼. 지연 렌더 시각의 위치와 자세를 계산하는 순수 모듈이다.
 */
/**
 * SKALA 작전 — 스냅샷 보간 버퍼 (순수, three.js 의존 없음)
 *
 *   const buf = new SnapshotBuffer();
 *   buf.push(t, { pos:[x,y,z], yaw, pitch, alive, moving, ... });   // t: ms (sample과 같은 시계)
 *   const s = buf.sample(now - 100);   // 100 ms 지연 렌더 시각
 *
 * - pos는 선형, yaw는 최단 각도, pitch는 선형 보간. 나머지 필드는 직전 스냅샷 값을 그대로 쓴다.
 * - 최신 스냅샷보다 늦은 시각이면 마지막 속도로 maxExtrapolate(ms)까지만 외삽 후 정지.
 * - 순서가 뒤바뀐 패킷도 시각 순으로 끼워 넣는다. 같은 t는 덮어쓴다.
 */

const TAU = Math.PI * 2;

export function wrapAngle(a) {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

export function lerpAngle(a, b, t) {
  return a + wrapAngle(b - a) * t;
}

export class SnapshotBuffer {
  /** @param {{maxSize?:number, maxExtrapolate?:number, keepMs?:number}} [opt] */
  constructor(opt = {}) {
    this.maxSize = opt.maxSize || 40;
    this.maxExtrapolate = opt.maxExtrapolate ?? 150;
    this.keepMs = opt.keepMs || 3000;
    /** @type {{t:number, s:object}[]} */
    this.items = [];
  }

  get size() { return this.items.length; }
  get latest() { const n = this.items.length; return n ? this.items[n - 1].s : null; }
  get latestTime() { const n = this.items.length; return n ? this.items[n - 1].t : -Infinity; }

  clear() { this.items.length = 0; }

  push(t, state) {
    if (!state || !Number.isFinite(t)) return;
    const it = this.items;
    let i = it.length;
    while (i > 0 && it[i - 1].t > t) i--;
    if (i > 0 && it[i - 1].t === t) it[i - 1] = { t, s: state };
    else it.splice(i, 0, { t, s: state });
    const newest = it[it.length - 1].t;
    while (it.length > 2 && (it.length > this.maxSize || it[0].t < newest - this.keepMs)) it.shift();
  }

  /**
   * @param {number} renderTime ms
   * @param {object} [out] 재사용할 결과 객체
   * @returns {object|null} { pos:[x,y,z], yaw, pitch, ...기타 필드, extrapolated:boolean, t }
   */
  sample(renderTime, out = {}) {
    const it = this.items;
    const n = it.length;
    if (!n) return null;
    let a, b, f;
    if (n === 1 || renderTime <= it[0].t) {
      a = b = it[renderTime <= it[0].t ? 0 : n - 1]; f = 0;
    } else if (renderTime >= it[n - 1].t) {
      // 외삽 (마지막 두 개의 속도)
      a = it[n - 2]; b = it[n - 1];
      const span = b.t - a.t;
      const over = Math.min(renderTime - b.t, this.maxExtrapolate);
      f = span > 0 ? 1 + over / span : 1;
      // 생사·순간이동 등 불연속이면 외삽하지 않음
      if (a.s.alive !== b.s.alive || b.s.teleport) f = 1;
    } else {
      let i = n - 2;
      while (i > 0 && it[i].t > renderTime) i--;
      a = it[i]; b = it[i + 1];
      f = (renderTime - a.t) / (b.t - a.t || 1);
      if (b.s.teleport) f = renderTime >= b.t ? 1 : 0;
    }
    const sa = a.s, sb = b.s;
    // 이산 필드: 보간 구간의 앞쪽(f<1) 또는 뒤쪽(f>=1)
    const src = f >= 1 ? sb : sa;
    for (const k in src) {
      if (k !== 'pos' && k !== 'yaw' && k !== 'pitch') out[k] = src[k];
    }
    const pa = sa.pos || [0, 0, 0], pb = sb.pos || pa;
    const p = out.pos && out.pos.length === 3 ? out.pos : (out.pos = [0, 0, 0]);
    p[0] = pa[0] + (pb[0] - pa[0]) * f;
    p[1] = pa[1] + (pb[1] - pa[1]) * f;
    p[2] = pa[2] + (pb[2] - pa[2]) * f;
    out.yaw = lerpAngle(sa.yaw || 0, sb.yaw || 0, f);
    out.pitch = (sa.pitch || 0) + ((sb.pitch || 0) - (sa.pitch || 0)) * Math.min(f, 1);
    out.extrapolated = f > 1;
    out.t = renderTime;
    return out;
  }
}
