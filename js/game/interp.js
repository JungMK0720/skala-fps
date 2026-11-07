/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 원격 플레이어 보간 버퍼. 멀티에서 네트워크 지터를 흡수해 부드러운 위치를 내는 순수 모듈이다.
 */
/**
 * SKALA FPS — 원격 플레이어 보간 버퍼 (순수 모듈: 엔진·three.js·DOM 없음, node 테스트 가능)
 *
 *   const ip = createInterp({ intervalHint: () => 1000 / Math.min(10, room.rate) });
 *   ip.push({ seq, t, pos:[x,y,z], vel:[...], yaw, pitch, alive, onGround, ... }, arrivalLocalMs);
 *   const s = ip.sample(performance.now());   // { pos, vel, yaw, pitch, ..., mode, delay, senderT }
 *
 * 시간축
 *   - t는 보낸 쪽 시계(ms)다. 도착 오프셋 d = 도착(로컬) − t 를 최근 64개 모아 base = min(d)(가장 빨리 온 패킷)로 잡는다.
 *   - 재생 오프셋 P = base + delay. 렌더 시각(보낸 쪽 시계) R = now − P.
 *   - 수신 간격 I = 움직이는 패킷끼리의 '실제 도착 간격' 중앙값(최근 16개). 표본이 4개 미만이거나
 *     intervalHint(예: 1000 / min(10, room.rate))가 30% 넘게 바뀌면(방 rate 변경) 힌트를 쓰고 다시 잰다.
 *   - delay 목표 = clamp(2.2 × I, 100, 450) ms   → 10Hz 220ms, 8Hz 275ms, 5Hz 440ms, 3.5Hz 450ms
 *   - 외삽 상한  = 1.5 × I                       → 10Hz 150ms, 3.5Hz 429ms (최대 1000ms)
 *   - P는 목표로 서서히 움직인다(늘릴 때 실시간의 10%, 줄일 때 2%) → 화면 시간이 거꾸로 가지 않는다.
 *     차이가 250ms를 넘으면 한 번에 맞춘다.
 *
 * 보간/외삽
 *   - 위치·속도·pitch 선형, yaw 최단 각도. 이산 필드(slot, hp, flags, alive …)는 앞쪽 스냅샷 값.
 *   - 두 스냅샷 사이 거리가 max(3m, 30m/s×간격)를 넘으면 순간이동으로 보고 보간하지 않는다(부활·라운드 시작).
 *   - 최신 스냅샷 이후는 마지막 속도로 외삽(공중이면 중력 포함)하고 상한을 넘으면 정지. 죽은 상태는 외삽하지 않는다.
 *
 * 순서·중복
 *   - seq로 정렬 삽입. 같은 seq → 'dup', 이미 버린 구간보다 오래된 seq → 'late'.
 *   - seq가 작은데 t가 더 크거나, t가 10초 이상 과거이거나, seq가 1000 이상 뒤면 보낸 쪽 재시작으로 보고 초기화.
 */
import { wrapAngle } from './protocol.js';

export const INTERP_DEFAULTS = Object.freeze({
  delayFactor: 2.2,    // delay = clamp(2.2 × 수신 간격, minDelay, maxDelay)
  minDelay: 100,
  maxDelay: 450,
  extrapFactor: 1.5,   // 외삽 상한 = 1.5 × 수신 간격
  minExtrap: 50,
  maxExtrapCap: 1000,
  intervalHint: null,  // number | () => number (ms). 표본 부족·rate 변경 시 쓰는 예상 수신 간격
  hintChange: 0.3,     // 힌트가 이 비율 넘게 바뀌면 간격 표본을 버리고 다시 잰다
  defaultInterval: 100,
  intervalWindow: 16,  // 수신 간격 표본 수(중앙값)
  minIntervalSamples: 4,
  maxIntervalMs: 2500, // 이보다 긴 간격은 끊김으로 보고 표본에서 뺀다
  jitterPct: 0.95,     // 통계용 jitter = p95(d) − min(d)
  window: 64,          // 도착 오프셋 표본 수
  slewUp: 0.10,
  slewDown: 0.02,
  fastPackets: 20,     // 처음 이만큼은 줄이는 쪽도 빠르게(10%)
  snapMs: 250,
  keepMs: 2000,
  maxSize: 64,
  teleportDist: 3,
  teleportSpeed: 30,
  gravity: -16,
  floorY: 0,           // 외삽 시 이 아래로 내려가지 않음 (null이면 끔)
  movingSpeed: 0.1     // 이 속도(m/s) 이상인 패킷만 수신 간격에 쓴다(유휴 2Hz·사망 1Hz 제외)
});

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const SKIP = new Set(['pos', 'vel', 'yaw', 'pitch', 'seq', 't']);

function sortedCopy(src, n, tmp) {
  for (let i = 0; i < n; i++) tmp[i] = src[i];
  const view = tmp.subarray(0, n);
  view.sort();
  return view;
}

export function createInterp(options = {}) {
  const o = { ...INTERP_DEFAULTS, ...options };
  /** @type {object[]} seq 오름차순 */
  const buf = [];
  let maxSeq = -Infinity;
  let floorSeq = -Infinity;
  const offs = new Float64Array(o.window);
  const ints = new Float64Array(o.intervalWindow);
  const tmp = new Float64Array(Math.max(o.window, o.intervalWindow));
  let offN = 0, offI = 0, intN = 0, intI = 0;
  let base = 0, jitter = 0, interval = o.defaultInterval, target = 0, maxExtrap = 0, measured = false;
  let P = null, Ptarget = null, lastNow = null, accepted = 0;
  let lastArrival = null, lastMoving = false, lastHint = null;
  const st = { pushed: 0, dup: 0, late: 0, reordered: 0, lost: 0, resets: 0, interp: 0, extrap: 0, hold: 0 };

  function readHint() {
    const h = typeof o.intervalHint === 'function' ? o.intervalHint() : o.intervalHint;
    return Number.isFinite(h) && h > 0 ? h : null;
  }

  function applyTargets() {
    target = clamp(o.delayFactor * interval, o.minDelay, o.maxDelay);
    maxExtrap = clamp(o.extrapFactor * interval, o.minExtrap, o.maxExtrapCap);
  }

  function reset() {
    buf.length = 0;
    maxSeq = -Infinity; floorSeq = -Infinity;
    offN = offI = intN = intI = 0;
    base = 0; jitter = 0; measured = false;
    interval = readHint() || o.defaultInterval;
    applyTargets();
    P = null; Ptarget = null; lastNow = null; accepted = 0;
    lastArrival = null; lastMoving = false; lastHint = null;
  }
  reset();

  const speed = (s) => (s.vel ? Math.hypot(s.vel[0], s.vel[1], s.vel[2]) : 0);

  function addInterval(dt) {
    if (!(dt > 0 && dt <= o.maxIntervalMs)) return;
    ints[intI] = dt;
    intI = (intI + 1) % ints.length;
    if (intN < ints.length) intN++;
  }

  function recompute() {
    if (offN > 0) {
      const v = sortedCopy(offs, offN, tmp);
      base = v[0];
      jitter = v[Math.min(offN - 1, Math.round(o.jitterPct * (offN - 1)))] - base;
    }
    const hint = readHint();
    if (hint !== null) {
      if (lastHint !== null && Math.abs(hint - lastHint) > o.hintChange * lastHint) { intN = 0; intI = 0; } // rate 변경 → 다시 잰다
      lastHint = hint;
    }
    measured = intN >= o.minIntervalSamples;
    if (measured) {
      const v = sortedCopy(ints, intN, tmp);
      interval = intN % 2 ? v[(intN - 1) >> 1] : (v[intN / 2 - 1] + v[intN / 2]) / 2;
    } else {
      interval = hint || o.defaultInterval;
    }
    applyTargets();
    Ptarget = base + target;
    if (P === null || Math.abs(Ptarget - P) > o.snapMs) P = Ptarget;
  }

  /**
   * @param {object} snap { seq, t, pos, vel, yaw, pitch, ... }
   * @param {number} arrival 도착 로컬 시각 ms
   * @returns {'ok'|'dup'|'late'|'bad'}
   */
  function push(snap, arrival) {
    if (!snap || !Number.isFinite(snap.seq) || !Number.isFinite(snap.t) || !Number.isFinite(arrival) || !snap.pos) return 'bad';
    const seq = snap.seq;
    if (buf.length && seq < maxSeq) {
      const newestT = buf[buf.length - 1].t;
      if (snap.t > newestT || snap.t < newestT - 10000 || seq < maxSeq - 1000) { reset(); st.resets++; }
    }
    if (seq <= floorSeq) { st.late++; if (st.lost > 0) st.lost--; return 'late'; }
    let lo = 0, hi = buf.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (buf[mid].seq < seq) lo = mid + 1; else hi = mid; }
    if (lo < buf.length && buf[lo].seq === seq) { st.dup++; return 'dup'; }
    buf.splice(lo, 0, snap);
    st.pushed++;
    accepted++;
    if (seq > maxSeq) {
      if (maxSeq !== -Infinity && seq > maxSeq + 1) st.lost += seq - maxSeq - 1;
      maxSeq = seq;
      // 실제 수신 간격: 새 최신 패킷과 직전 최신 패킷이 둘 다 움직이는 중일 때의 도착 시각 차
      const moving = speed(snap) >= o.movingSpeed;
      if (lastArrival !== null && moving && lastMoving) addInterval(arrival - lastArrival);
      lastArrival = arrival;
      lastMoving = moving;
    } else {
      st.reordered++;
      if (st.lost > 0) st.lost--;
    }
    offs[offI] = arrival - snap.t;
    offI = (offI + 1) % offs.length;
    if (offN < offs.length) offN++;
    const newest = buf[buf.length - 1].t;
    while (buf.length > 3 && (buf.length > o.maxSize || buf[0].t < newest - o.keepMs)) floorSeq = buf.shift().seq;
    recompute();
    return 'ok';
  }

  function copyDiscrete(src, out) {
    for (const k in src) if (!SKIP.has(k)) out[k] = src[k];
  }

  /** 보낸 쪽 시각 R의 상태 (지연 관리 없음 — 방장 검증·되감기용). count=true면 모드 통계 집계 */
  function sampleAt(R, out = {}, count = false) {
    const n = buf.length;
    if (!n) return null;
    let i = n - 1;
    while (i >= 0 && buf[i].t > R) i--;
    const pos = out.pos && out.pos.length === 3 ? out.pos : (out.pos = [0, 0, 0]);
    const vel = out.vel && out.vel.length === 3 ? out.vel : (out.vel = [0, 0, 0]);
    let a, mode;
    if (i < 0) {
      a = buf[0];
      mode = 'hold';
      pos[0] = a.pos[0]; pos[1] = a.pos[1]; pos[2] = a.pos[2];
      vel[0] = vel[1] = vel[2] = 0;
      out.yaw = a.yaw || 0; out.pitch = a.pitch || 0;
    } else if (i < n - 1) {
      a = buf[i];
      const b = buf[i + 1];
      const span = b.t - a.t;
      const dx = b.pos[0] - a.pos[0], dy = b.pos[1] - a.pos[1], dz = b.pos[2] - a.pos[2];
      const jump = Math.hypot(dx, dy, dz) > Math.max(o.teleportDist, o.teleportSpeed * span / 1000);
      const f = jump || span <= 0 ? 0 : clamp((R - a.t) / span, 0, 1);
      mode = 'interp';
      pos[0] = a.pos[0] + dx * f; pos[1] = a.pos[1] + dy * f; pos[2] = a.pos[2] + dz * f;
      const av = a.vel || [0, 0, 0], bv = b.vel || av;
      vel[0] = av[0] + (bv[0] - av[0]) * f; vel[1] = av[1] + (bv[1] - av[1]) * f; vel[2] = av[2] + (bv[2] - av[2]) * f;
      const ya = a.yaw || 0;
      out.yaw = wrapAngle(ya + wrapAngle((b.yaw || 0) - ya) * f);
      out.pitch = (a.pitch || 0) + ((b.pitch || 0) - (a.pitch || 0)) * f;
    } else {
      a = buf[n - 1];
      const e = R - a.t;
      const av = a.vel || [0, 0, 0];
      const ext = a.alive === false ? 0 : clamp(e, 0, maxExtrap) / 1000;
      const air = a.onGround === false;
      mode = e <= 0 ? 'interp' : e <= maxExtrap ? 'extrap' : 'hold';
      pos[0] = a.pos[0] + av[0] * ext;
      pos[2] = a.pos[2] + av[2] * ext;
      pos[1] = a.pos[1] + av[1] * ext + (air ? 0.5 * o.gravity * ext * ext : 0);
      if (o.floorY !== null && pos[1] < o.floorY && a.pos[1] >= o.floorY) pos[1] = o.floorY;
      vel[0] = av[0]; vel[2] = av[2]; vel[1] = av[1] + (air ? o.gravity * ext : 0);
      if (mode === 'hold') vel[0] = vel[1] = vel[2] = 0;
      out.yaw = a.yaw || 0; out.pitch = a.pitch || 0;
    }
    copyDiscrete(a, out);
    out.mode = mode;
    out.extrapolated = mode !== 'interp';
    out.senderT = R;
    out.age = R - buf[n - 1].t; // 최신 스냅샷 대비 렌더 시각 (음수 = 버퍼 안)
    if (count) st[mode]++;
    return out;
  }

  /** 로컬 시각 now의 렌더 상태 (적응형 지연 적용). 렌더 프레임마다 부르면 된다 */
  function sample(now, out = {}) {
    if (!buf.length || P === null) return null;
    if (lastNow !== null && now > lastNow && Ptarget !== P) {
      const diff = Ptarget - P;
      const rate = diff > 0 || accepted < o.fastPackets ? o.slewUp : o.slewDown;
      const step = rate * (now - lastNow);
      P += diff > 0 ? Math.min(diff, step) : Math.max(diff, -step);
    }
    if (lastNow === null || now > lastNow) lastNow = now;
    const res = sampleAt(now - P, out, true);
    res.delay = P - base;
    return res;
  }

  return {
    push,
    sample,
    sampleAt,
    clear: reset,
    /** 보낸 쪽 시각 → 이 아바타가 그 시각을 그리는 로컬 시각 (원격 이벤트를 아바타와 맞출 때) */
    toLocal: (senderT) => (P === null ? senderT : senderT + P),
    /** 로컬 시각 → 렌더 중인 보낸 쪽 시각 */
    toSender: (localT) => (P === null ? localT : localT - P),
    /** 가장 빨리 온 패킷 기준 도착 오프셋(로컬 − 보낸 쪽 시계). 방장 검증용 시각 변환에 쓴다 */
    base: () => base,
    latest: () => (buf.length ? buf[buf.length - 1] : null),
    get size() { return buf.length; },
    stats: () => ({
      ...st,
      size: buf.length,
      delay: P === null ? null : P - base,
      target,
      maxExtrap,
      interval,
      measured,
      jitter,
      base
    })
  };
}
