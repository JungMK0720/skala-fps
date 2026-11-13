/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 경기 상태 동기화 모듈. 상태 전송, 원격 보간 입력, 방장 시계, 히트 주장 전달을 맡는 순수 모듈이다.
 */
/**
 * SKALA 작전 — 상태 동기화 접착제 (순수 모듈: 엔진·three.js·DOM 없음, node 테스트 가능)
 *
 *   import { createSync } from './game/sync.js';
 *   const sync = createSync({ room, getLocalState, onRemoteState, onEvent, rateHz: 10 });
 *   // 렌더 프레임마다:  const s = sync.getRemote(id, performance.now());
 *   // 사격: sync.sendFire({...}); sync.sendHitClaim({...});   수류탄: const g = sync.sendGrenade({...});
 *   // 방장: sync.sendMatch(snapshot, [{ type:'kill', ... }]);
 *   // 끝:   sync.dispose();
 *
 * 송신
 *   - '턴'마다 room.send/sendTo를 한꺼번에 부른다 → net이 같은 JS 턴의 메시지를 프레임 1개로 묶는다.
 *   - 상태는 min(rateHz=10, room.rate)Hz(15 상한). 거의 안 움직이면 2Hz, 죽었으면 1Hz. 상태는 merge(최신만).
 *     room.rate는 매 틱 읽는다 → 방장이 rate를 바꾸면 바로 따른다.
 *   - 사격·히트·수류탄·경기 변경은 따로 프레임을 열지 않고 다음 상태 프레임에 실린다(메시지 수 절약).
 *     이벤트가 있으면 유휴·사망 주기 대신 활성 주기를 써서 대기는 최대 한 간격(10Hz 100ms, 3.5Hz 286ms).
 *   - 턴은 토큰 버킷(rate = min(room.rate, 15)/s, 비축 2) + 1초 창 15회 + 최소 간격 25ms로 한 번 더 제한한다.
 *     막히면 항목을 쌓아 두었다가 다음 턴에 합쳐 보낸다(coalesce).
 *   - 히트 주장·수류탄·로드아웃·채팅은 두 번(다음 턴에 한 번 더) 보낸다 → 받는 쪽은 id로 중복 제거.
 *   - 히트 주장은 count(맞은 펠릿 수)와 shotId(같은 발 묶음)까지 그대로 방장에게 간다.
 *
 * 수신
 *   - 상태 → 원격별 interp 버퍼(createInterp), 새 최신이면 onRemoteState(id, state, info)
 *   - 사격·히트 주장(방장만)·수류탄·경기·로드아웃·채팅·방장 교체·퇴장 → onEvent({ type, from, ... })
 *
 * 시계: 방장 시계 기준 NTP식 핑(t0,t1,t2,t3) + RTT 하위 절반의 중앙값. 방장 교체 시 다시 맞춘다.
 *       sync.hostNow()는 방장의 performance.now() 기준이다(room.now()의 Date.now 기준과 다르다).
 */
import {
  EV, isGameEvent, decodeMessage, byteSize, FLAG, vec3,
  encodeState, encodeStateBody, bodyNearlyEqual, encodeFire, encodeHit, encodeGrenade, decodeGrenade,
  encodeMatch, encodeMatchEvent, encodeLoadout, encodeChat, encodePing, encodePong, encodeDrop, encodePick, encodeBomb, encodeRespawn
} from './protocol.js';
import { createInterp } from './interp.js';

const defaultNow = () => (globalThis.performance && performance.now ? performance.now() : Date.now());

/* ================================================================== 시계 동기화 */

/**
 * 방장 시계 오프셋 추정기 (hostTime = localTime + offset)
 * addSample(t0, t1, t2, t3): t0 요청 송신(로컬), t1 방장 수신, t2 방장 응답 송신(방장 시계), t3 응답 수신(로컬)
 *   rtt = (t3 − t0) − (t2 − t1),  offset = ((t1 − t0) + (t2 − t3)) / 2
 * 필터: 최근 window개 중 RTT 하위 절반의 offset 중앙값 (지연이 큰 표본은 비대칭 오차가 크다)
 */
export function createClock({ window = 15, minSamples = 3 } = {}) {
  let samples = [];
  let offset = 0, rtt = null, ref = false;

  function recompute() {
    const byRtt = samples.slice().sort((a, b) => a.rtt - b.rtt);
    const best = byRtt.slice(0, Math.max(1, Math.ceil(byRtt.length / 2))).map((s) => s.offset).sort((a, b) => a - b);
    const m = best.length;
    offset = m % 2 ? best[(m - 1) >> 1] : (best[m / 2 - 1] + best[m / 2]) / 2;
    rtt = byRtt[(byRtt.length - 1) >> 1].rtt;
  }

  return {
    get offset() { return ref ? 0 : offset; },
    get rtt() { return rtt; },
    get synced() { return ref || samples.length >= minSamples; },
    get samples() { return samples.length; },
    get isReference() { return ref; },
    /** 내가 방장이면 기준 시계(오프셋 0) */
    setReference(on) { ref = !!on; samples = []; if (ref) offset = 0; },
    /** 방장이 바뀌었을 때: 표본을 버리고 (있으면) 추정값으로 시작 */
    reset(seedOffset) {
      ref = false;
      samples = [];
      if (Number.isFinite(seedOffset)) offset = seedOffset;
    },
    addSample(t0, t1, t2, t3) {
      if (ref || ![t0, t1, t2, t3].every(Number.isFinite)) return null;
      let r = (t3 - t0) - (t2 - t1);
      if (r < -3 || r > 10000) return null; // ms 반올림 오차(±2)만 허용
      r = Math.max(0, r);
      const off = ((t1 - t0) + (t2 - t3)) / 2;
      samples.push({ offset: off, rtt: r });
      if (samples.length > window) samples.shift();
      recompute();
      return { offset: off, rtt: r };
    },
    toHost: (local) => local + (ref ? 0 : offset),
    toLocal: (host) => host - (ref ? 0 : offset)
  };
}

/* ================================================================== 동기화 */

export const SYNC_DEFAULTS = Object.freeze({
  rateHz: 10,             // 움직일 때 상태 Hz (room.rate·maxMsgPerSec이 더 낮으면 그쪽)
  idleHz: 2,              // 거의 안 움직일 때
  deadHz: 1,              // 죽었을 때
  maxMsgPerSec: 15,       // 클라이언트당 턴(=net 프레임) 상한
  burst: 2,               // 토큰 비축 (net 버킷 3보다 작게 → net에서 대기하는 일이 거의 없다)
  minGapMs: 25,
  tickMs: 25,             // autoTick 주기
  autoTick: true,         // false면 sync.tick(now)를 직접 부른다(테스트·엔진 루프)
  backgroundGapMs: 250,   // 상태 없이 핑·재전송만 있을 때 턴 간격
  reliableRepeat: 2,      // 히트·수류탄·로드아웃·채팅 송신 횟수
  repeatGapMs: 80,
  matchResendMs: 1000,    // 방장 경기 스냅샷 재전송 주기 (변경 시에는 즉시)
  matchEventTtlMs: 3000,  // 경기 이벤트를 스냅샷에 실어 보내는 기간(손실 복구)
  loadoutResendMs: 5000,  // 로드아웃을 상태 턴에 얹어 다시 보내는 주기(늦게 온 사람용)
  pingBurst: 5,           // 처음/방장 교체 후 빠른 핑 개수
  pingBurstGapMs: 250,
  pingIntervalMs: 3000,
  prevHostGraceMs: 1500,  // 방장 교체 직후 옛 방장의 늦은 경기 이벤트를 받아 주는 시간
  staleMs: 3000,          // 이만큼 소식이 없으면 getRemote(...).stale = true
  forgetMs: 10000,        // 명단에 없고 이만큼 소식이 없으면 원격 삭제
  maxFirePerTurn: 12,
  interp: null            // createInterp 옵션
});

const MSG_OVERHEAD = 9;     // net 프레임 안 메시지 하나: ["g2s",…],
const FRAME_OVERHEAD = 180; // Phoenix 봉투 + net 프레임 머리(추정)

/**
 * g2f 메시지. 칼 강타·찌르기는 끝에 'stab' 한 칸을 더 붙인다(명중점 없는 8칸 + 1칸. 원격이 강타 소리를 낸다).
 * decodeFire는 모르는 칸을 무시하므로 protocol 형식은 그대로이고, 베기와 총은 바이트가 늘지 않는다.
 */
function fireMessage(t, f) {
  const a = encodeFire(t, f);
  if (f && f.kind === 'stab' && a.length === 8) a.push('stab');
  return a;
}
const fireKind = (payload) => (Array.isArray(payload) && payload.length === 9 && payload[8] === 'stab' ? 'stab' : undefined);

function idOf(p) {
  if (p == null) return null;
  if (typeof p === 'object') return p.id == null ? null : String(p.id);
  return String(p);
}

/** 최근 id 기억 (중복 제거) */
function makeSeen(max = 256) {
  const set = new Set();
  const order = [];
  return (key) => {
    if (set.has(key)) return true;
    set.add(key);
    order.push(key);
    if (order.length > max) set.delete(order.shift());
    return false;
  };
}

/** 시각 목록으로 초당 비율 (최근 windowMs) */
function makeRate(windowMs = 5000) {
  const ts = [];
  const vs = [];
  let total = 0;
  return {
    add(t, v = 1) { ts.push(t); vs.push(v); total += v; if (ts.length > 64) this.prune(t); },
    prune(t) { while (ts.length && t - ts[0] > windowMs) { ts.shift(); vs.shift(); } },
    perSec(t) {
      this.prune(t);
      let s = 0;
      for (const v of vs) s += v;
      return (s * 1000) / windowMs;
    },
    countSince(t0) { let c = 0; for (let i = ts.length - 1; i >= 0 && ts[i] > t0; i--) c++; return c; },
    get total() { return total; }
  };
}

/**
 * @param {object} opts
 *  room           net Room (send, sendTo, on, me, isHost, hostId, players, rate?)
 *  getLocalState  () → { pos, vel, yaw, pitch, slot, hp, onGround, zoom, walking, alive, reloading } | null
 *  onRemoteState  (id, state, info) — 원격 상태가 새로 도착(최신만)
 *  onEvent        (evt) — { type: 'fire'|'hitClaim'|'grenade'|'match'|'loadout'|'chat'|'drop'|'pick'|'bomb'|'respawn'|'host'|'leave'|'closed', ... }
 *  rateHz         기본 10
 *  now            시계 함수(기본 performance.now)
 */
export function createSync(opts = {}) {
  const o = { ...SYNC_DEFAULTS, ...opts };
  const room = o.room;
  if (!room || typeof room.send !== 'function' || typeof room.on !== 'function') throw new TypeError('createSync: room이 필요합니다');
  const now = typeof o.now === 'function' ? o.now : defaultNow;
  const getLocalState = typeof o.getLocalState === 'function' ? o.getLocalState : () => null;
  const clock = createClock();

  let disposed = false, closed = false;
  let me = idOf(room.me);
  let hostId = readHostId();
  let amHost = me != null && hostId === me;
  if (amHost) clock.setReference(true);
  let hostSince = now();
  let prevHostId = null;

  // ---- 송신 상태
  // seq는 시각 기반으로 시작한다(50/s 눈금, 실제 전송 10Hz보다 촘촘). 같은 탭에서 방을 나갔다 다시 들어와
  // sync를 새로 만들어도 이전 세션보다 큰 번호로 이어져, 상대의 departed·maxSeq 검사에 걸려 무시되지 않는다.
  let seq = Math.max(0, Math.floor(now() / 20)), itemId = 0, pid = 0;
  let lastBody = null, lastStateAt = -Infinity, lastTurnAt = -Infinity;
  let tokens = o.burst, tokensAt = now();
  let urgent = false, kickQueued = false;
  let lastPos = null, lastPosAt = 0, velEst = [0, 0, 0];
  const fireQ = [];
  let reliable = []; // { ev, payload, to: null|'host', merge, left, nextAt, kind }
  let pendingPing = null, pingNextAt = -Infinity;
  const pingSent = new Map(); // pid → t0(정확한 로컬 시각)
  const pongQ = new Map();    // 요청자 → { pid, t0, t1, e0 }
  let myLoadout = null, loadoutAt = -Infinity;
  // 방장 경기
  let matchSeqOut = 0, matchEid = 0, matchBody = null, matchDirty = false, lastMatchAt = -Infinity;
  let matchEvents = []; // { at, enc }
  // 수신 경기(방장 거울)
  let matchFrom = null, matchSeqIn = -1, lastMatch = null;
  const seenMatchEv = makeSeen(512);
  const loopQ = [];

  // ---- 원격
  const remotes = new Map(); // id → { id, interp, maxSeq, state, lastHeard, listed, loadout, loadoutJson, seen*, firstAt }
  const departed = new Map(); // id → { at, maxSeq }
  let playerIds = new Set();

  // ---- 통계
  const S = {
    turns: makeRate(), sentMsgs: makeRate(), sentBytes: makeRate(), recvMsgs: makeRate(), recvBytes: makeRate(),
    sentByType: {}, recvByType: {}, coalesced: 0, waited: 0, eventMsgs: 0, maxTurnsIn1s: 0,
    dup: 0, bad: 0, ignored: 0, callbackErrors: 0
  };
  let turnBytes = 0;

  /** net의 방 시계(room.now) — 있으면 핑·퐁에 실어 net 큐 대기 시간을 보정한다 */
  function roomNow() {
    try { const v = typeof room.now === 'function' ? room.now() : NaN; return Number.isFinite(v) ? v : null; } catch (_) { return null; }
  }

  function readHostId() {
    try { const h = typeof room.hostId === 'function' ? room.hostId() : room.hostId; return h == null ? null : String(h); } catch (_) { return null; }
  }

  function safe(fn, ...args) {
    if (typeof fn !== 'function') return undefined;
    try { return fn(...args); } catch (e) {
      S.callbackErrors++;
      if (S.callbackErrors <= 5) console.error('[sync] callback error:', e);
      return undefined;
    }
  }
  const emit = (evt) => safe(o.onEvent, evt);

  /* ---------------------------------------------------------------- 송신 */

  function turnRate() {
    const rr = Number(room.rate);
    return Math.max(0.5, Math.min(o.maxMsgPerSec, rr > 0 ? rr : Infinity));
  }
  const stateHz = () => Math.min(o.rateHz, turnRate());

  function refill(t) {
    if (t > tokensAt) tokens = Math.min(o.burst, tokens + ((t - tokensAt) * turnRate()) / 1000);
    tokensAt = Math.max(tokensAt, t);
  }

  function canTurn(t) {
    refill(t);
    if (tokens < 1 || t - lastTurnAt < o.minGapMs) return false;
    return S.turns.countSince(t - 1000) < o.maxMsgPerSec;
  }

  function sendMsg(ev, payload, to, merge) {
    let ok = false;
    try {
      if (to) ok = room.sendTo(to, ev, payload, merge ? { merge: true } : undefined) !== false;
      else ok = room.send(ev, payload, merge ? { merge: true } : undefined) !== false;
    } catch (e) {
      if (S.callbackErrors++ < 5) console.error('[sync] send failed:', e);
      return false;
    }
    const b = byteSize(payload) + MSG_OVERHEAD + ev.length;
    turnBytes += b;
    S.sentMsgs.add(lastTurnAt);
    S.sentByType[ev] = (S.sentByType[ev] || 0) + 1;
    if (ev !== EV.state && ev !== EV.ping) S.eventMsgs++;
    return ok;
  }

  function sampleLocal(t) {
    const st = safe(getLocalState);
    if (!st || typeof st !== 'object') return null;
    let s = st;
    if (st.vel === undefined && st.vx === undefined) {
      const p = st.pos ? vec3(st.pos) : [+st.x || 0, +st.y || 0, +st.z || 0];
      if (lastPos && t - lastPosAt >= 20) {
        const dt = (t - lastPosAt) / 1000;
        velEst = [(p[0] - lastPos[0]) / dt, (p[1] - lastPos[1]) / dt, (p[2] - lastPos[2]) / dt];
        lastPos = p; lastPosAt = t;
      } else if (!lastPos) { lastPos = p; lastPosAt = t; }
      s = { ...st, vel: velEst };
    }
    return encodeStateBody(s);
  }

  function hostTarget() { return hostId && hostId !== me ? hostId : null; }

  function doTurn(t, body) {
    refill(t);
    tokens -= 1;
    lastTurnAt = t;
    turnBytes = FRAME_OVERHEAD;
    S.turns.add(t);
    const inWin = S.turns.countSince(t - 1000);
    if (inWin > S.maxTurnsIn1s) S.maxTurnsIn1s = inWin;

    if (body) {
      seq++;
      sendMsg(EV.state, encodeState(seq, t, body), null, true);
      lastBody = body;
      lastStateAt = t;
      if (myLoadout && t - loadoutAt >= o.loadoutResendMs) {
        sendMsg(EV.loadout, myLoadout, null, true);
        loadoutAt = t;
      }
    }
    // 사격 연출
    const n = Math.min(fireQ.length, o.maxFirePerTurn);
    for (let i = 0; i < n; i++) { const f = fireQ.shift(); sendMsg(EV.fire, fireMessage(f.t, f.f), null, false); }
    // 신뢰 항목(2회)
    if (reliable.length) {
      const keep = [];
      for (const r of reliable) {
        if (r.nextAt > t) { keep.push(r); continue; }
        let to = null;
        if (r.to === 'host') {
          to = hostTarget();
          if (!to) { keep.push(r); continue; } // 방장 미정 → 대기
        } else if (r.to) to = r.to;            // 받는 사람이 정해진 항목(팀 채팅)
        sendMsg(r.ev, r.payload, to, r.merge);
        if (r.ev === EV.loadout) loadoutAt = t;
        r.left--;
        r.nextAt = t + o.repeatGapMs;
        if (r.left > 0) keep.push(r);
      }
      reliable = keep;
    }
    // 핑·퐁
    if (pendingPing !== null) {
      const to = hostTarget();
      if (to) {
        pingSent.set(pendingPing, t);
        sendMsg(EV.ping, encodePing(pendingPing, t, roomNow()), to, true);
      }
      pendingPing = null;
    }
    if (pongQ.size) {
      const d2 = roomNow();
      for (const [to, p] of pongQ) sendMsg(EV.ping, encodePong(p.pid, p.t0, p.t1, t, d2, p.e0), to, true);
      pongQ.clear();
    }
    // 방장 경기 스냅샷 (변경 즉시 + 1초마다)
    if (amHost && matchBody && (matchDirty || t - lastMatchAt >= o.matchResendMs)) {
      matchEvents = matchEvents.filter((e) => t - e.at <= o.matchEventTtlMs);
      const payload = matchBody.slice();
      payload[7] = matchEvents.map((e) => e.enc);
      sendMsg(EV.match, payload, null, true);
      matchDirty = false;
      lastMatchAt = t;
    }
    urgent = false;
    S.sentBytes.add(t, turnBytes);
  }

  function schedulePing(t) {
    if (amHost || !hostTarget() || pendingPing !== null) return;
    if (t < pingNextAt) return;
    pendingPing = ++pid;
    pingNextAt = t + (clock.samples < o.pingBurst ? o.pingBurstGapMs : o.pingIntervalMs);
    for (const [k, t0] of pingSent) if (t - t0 > 5000) pingSent.delete(k);
  }

  /** 한 번의 주기 작업. autoTick이면 내부 타이머가 부른다 */
  function tick(t = now()) {
    if (disposed || closed) return;
    refreshHost();
    if (loopQ.length) for (const e of loopQ.splice(0)) emit(e);
    if (disposed || closed) return;
    schedulePing(t);
    forgetStale(t);

    const body = sampleLocal(t);
    // 사격·히트·수류탄·경기 변경·로드아웃·채팅: 따로 프레임을 열지 않고 다음 상태 프레임에 실린다.
    // 대신 이런 이벤트가 있으면 유휴(2Hz)·사망(1Hz) 주기 대신 활성 주기(1/stateHz)를 써서 최대 한 간격만 기다린다.
    const events = urgent || fireQ.length > 0 || reliable.some((r) => r.nextAt <= t);
    const background = pendingPing !== null || pongQ.size > 0 || (amHost && matchBody && t - lastMatchAt >= o.matchResendMs);
    const active = 1000 / stateHz();
    const tol = (iv) => Math.min(o.tickMs * 0.5, iv * 0.25);
    let due;
    if (body) {
      const changed = !lastBody || !bodyNearlyEqual(body, lastBody);
      const alive = !!(body[9] & FLAG.alive);
      const interval = changed || events ? active : 1000 / Math.min(stateHz(), alive ? o.idleHz : o.deadHz);
      due = t - lastTurnAt >= interval - tol(interval);
      // 핑·퐁·스냅샷 재전송은 상태 턴(1~10Hz)에 얹혀 간다. 1초 넘게 턴이 없을 때만 따로 연다
      if (!due && background && t - lastTurnAt >= 1000) due = true;
    } else {
      // 상태가 없을 때(로비·관전): 이벤트는 활성 주기, 핑 등은 backgroundGapMs 간격
      due = (events && t - lastTurnAt >= active - tol(active)) || (background && t - lastTurnAt >= o.backgroundGapMs);
    }
    if (!due) { if (events) S.waited++; return; }
    if (!canTurn(t)) { S.coalesced++; return; }
    doTurn(t, body);
  }

  /** 급한 항목이 생기면 같은 JS 턴이 끝날 때 바로 턴을 연다(autoTick일 때) */
  function kick() {
    urgent = true;
    if (!o.autoTick || kickQueued || disposed) return;
    kickQueued = true;
    queueMicrotask(() => { kickQueued = false; tick(); });
  }

  /* ---------------------------------------------------------------- 공개 송신 API */

  /** 사격 연출 { weaponId, origin:[x,y,z], dir:[x,y,z], hit?:[x,y,z], hitKind?:'world'|'player', kind?:'stab', t?: 로컬 ms } */
  function sendFire(f) {
    if (disposed || !f) return false;
    fireQ.push({ t: Number.isFinite(f.t) ? f.t : now(), f });
    if (fireQ.length > 64) fireQ.shift();
    kick();
    return true;
  }

  /**
   * 히트 주장 → 방장 { victimId, part, weaponId, dist(m), kind?:'shot'|'slash'|'stab', count?, shotId?, t?: 로컬 사격 시각 | shotT?: 방장 시계 }
   * count = 이 사람에게 맞은 펠릿 수(기본 1), shotId = 같은 발을 묶는 양의 정수
   * 내가 방장이면 보내지 않고 onEvent('hitClaim')로 바로 돌려준다(같은 처리 경로). → id
   */
  function sendHitClaim(h) {
    if (disposed || !h || h.victimId == null) return 0;
    const shotT = Number.isFinite(h.shotT) ? h.shotT : clock.toHost(Number.isFinite(h.t) ? h.t : now());
    const payload = encodeHit(itemId + 1, { ...h, shotT });
    const dec = decodeMessage(EV.hit, payload); // 받는 쪽과 같은 검증(빈 victimId 등은 거절)
    if (!dec) return 0;
    const id = ++itemId;
    if (amHost) {
      const d = dec.data;
      loopQ.push({ type: 'hitClaim', from: me, ...d, age: Math.max(0, clock.toHost(now()) - d.shotT), local: true });
      kick();
      return id;
    }
    reliable.push({ ev: EV.hit, payload, to: 'host', merge: false, left: o.reliableRepeat, nextAt: -Infinity, kind: 'hit' });
    kick();
    return id;
  }

  /**
   * 수류탄 투척 { pos, vel, t?: 로컬 투척 시각 } → 전송 해상도로 맞춘 '정본' { id, gid, pos, vel, t(방장 시계), localT }
   * 던진 사람도 반드시 이 정본으로 시뮬레이션해야 모든 화면이 같은 궤적을 그린다.
   */
  function sendGrenade(g) {
    if (disposed || !g) return null;
    const id = ++itemId;
    const hostT = clock.toHost(Number.isFinite(g.t) ? g.t : now());
    const payload = encodeGrenade(id, { pos: g.pos, vel: g.vel, t: hostT, kind: g.kind, fuse: g.fuse });
    reliable.push({ ev: EV.grenade, payload, to: null, merge: false, left: o.reliableRepeat, nextAt: -Infinity, kind: 'grenade' });
    kick();
    const c = decodeGrenade(payload);
    return { id, gid: me + ':' + id, pos: c.pos, vel: c.vel, t: c.t, localT: clock.toLocal(c.t) };
  }

  /**
   * (방장 전용) 경기 스냅샷 + 새 이벤트. 방장이 아니면 false.
   * snapshot: { phase, round, score:{owner,charterer}, endsAt(방장 시계), players:{id:{team,hp,alive,kills,deaths}}, ... }
   * events:   [{ type:'kill', killer, victim, weaponId, part }, { type:'damage', ... }, ...]
   * → mseq. 스냅샷은 바뀔 때마다 부르면 된다(턴당 최신 하나만 나감). 이벤트는 3초 동안 스냅샷에 실려 반복된다.
   */
  function sendMatch(snapshot, events = []) {
    if (disposed || !amHost) return false;
    const t = now();
    matchSeqOut = Math.max(matchSeqOut, matchSeqIn) + 1;
    for (const ev of Array.isArray(events) ? events : [events]) {
      if (!ev) continue;
      const enc = encodeMatchEvent(++matchEid, ev);
      matchEvents.push({ at: t, enc });
      seenMatchEv(me + ':' + enc[0]);
    }
    if (matchEvents.length > 32) matchEvents = matchEvents.slice(-32);
    matchBody = encodeMatch(matchSeqOut, snapshot, []);
    matchDirty = true;
    const dec = decodeMessage(EV.match, matchBody);
    lastMatch = { from: me, seq: matchSeqOut, snapshot: dec ? dec.data.snapshot : null, at: t };
    matchFrom = me;
    matchSeqIn = matchSeqOut;
    kick();
    return matchSeqOut;
  }

  /** 장비 알림 { pick, primary, secondary, melee, round?, m? } (JSON 256B 이하). 내용 해석은 세션이 한다(session.readGear) */
  function sendLoadout(loadout) {
    if (disposed || !loadout) return false;
    myLoadout = encodeLoadout(++itemId, loadout);
    reliable = reliable.filter((r) => r.kind !== 'loadout');
    reliable.push({ ev: EV.loadout, payload: myLoadout, to: null, merge: true, left: o.reliableRepeat, nextAt: -Infinity, kind: 'loadout' });
    kick();
    return true;
  }

  /**
   * 채팅 (선택). 받는 쪽 화면에는 textContent로만.
   * opt = { scope: 'team', to: [플레이어 id] }면 팀 채팅: 그 사람들에게만 보낸다(중계 서버는 받는 사람에게만 전달한다).
   * to에 아무도 없으면 보내지 않고 true를 돌려준다(혼자 남은 팀).
   */
  function sendChat(text, opt) {
    if (disposed) return false;
    const team = !!(opt && opt.scope === 'team');
    const payload = encodeChat(++itemId, text, team ? 'team' : 'all');
    if (!payload[1]) return false;
    if (team) {
      const ids = Array.isArray(opt.to) ? [...new Set(opt.to.map(idOf).filter((id) => id && id !== me))] : [];
      for (const to of ids) reliable.push({ ev: EV.chat, payload, to, merge: false, left: o.reliableRepeat, nextAt: -Infinity, kind: 'chat' });
      if (ids.length) kick();
      return true;
    }
    reliable.push({ ev: EV.chat, payload, to: null, merge: false, left: o.reliableRepeat, nextAt: -Infinity, kind: 'chat' });
    kick();
    return true;
  }

  /**
   * 죽은 뒤 버린 총 { dropId, weaponId, pos, mag, reserve } → 모두에게.
   * 방장을 거치지 않는다. 누가 먼저 주웠는지는 먼저 알린 쪽이고, 동시에 주우면 둘 다 갖는다(판정에 영향이 없다).
   */
  function sendDrop(d) {
    if (disposed || !d) return false;
    reliable.push({ ev: EV.drop, payload: encodeDrop(++itemId, d), to: null, merge: false, left: o.reliableRepeat, nextAt: -Infinity, kind: 'drop' });
    kick();
    return true;
  }

  /**
   * (폭파 미션) 설치·해체 시작이나 취소 의도 → 방장. act: 'plant' | 'defuse' | 'cancel', reason(취소): 'released' | 'moved' | 'fired'.
   * 판정은 방장의 match.bombIntent가 한다. 내가 방장이면 보내지 않고 onEvent('bomb')로 바로 돌려준다. → id(실패 0)
   */
  function sendBomb(act, reason) {
    if (disposed) return 0;
    const payload = encodeBomb(itemId + 1, act, reason);
    const dec = decodeMessage(EV.bomb, payload);
    if (!dec) return 0;
    const id = ++itemId;
    if (amHost) {
      loopQ.push({ type: 'bomb', from: me, act: dec.data.act, reason: dec.data.reason, local: true });
      kick();
      return id;
    }
    reliable.push({ ev: EV.bomb, payload, to: 'host', merge: false, left: o.reliableRepeat, nextAt: -Infinity, kind: 'bomb' });
    kick();
    return id;
  }

  /**
   * (개인전) 즉시 부활 요청 → 방장. 확정은 방장의 match.respawnNow가 하고, 되면 내 spawn 이벤트에 instant:true가 붙어 온다.
   * 내가 방장이면 보내지 않고 onEvent('respawn')로 바로 돌려준다. → id(실패 0)
   */
  function sendRespawn() {
    if (disposed) return 0;
    const id = ++itemId;
    if (amHost) {
      loopQ.push({ type: 'respawn', from: me, local: true });
      kick();
      return id;
    }
    reliable.push({ ev: EV.respawn, payload: encodeRespawn(id), to: 'host', merge: false, left: o.reliableRepeat, nextAt: -Infinity, kind: 'respawn' });
    kick();
    return id;
  }

  /** 총을 주웠다 → 다른 사람 화면에서 그 총을 지운다 */
  function sendPick(dropId) {
    if (disposed || dropId == null) return false;
    reliable.push({ ev: EV.pick, payload: encodePick(++itemId, dropId), to: null, merge: false, left: o.reliableRepeat, nextAt: -Infinity, kind: 'pick' });
    kick();
    return true;
  }

  /* ---------------------------------------------------------------- 수신 */

  function remoteOf(id, t) {
    let r = remotes.get(id);
    if (r) return r;
    r = {
      id, interp: createInterp({ intervalHint: () => 1000 / stateHz(), ...(o.interp || {}) }), maxSeq: -Infinity, state: null, lastHeard: t, firstAt: t, seqLog: [],
      listed: playerIds.has(id), loadout: null, loadoutJson: '',
      seenHit: makeSeen(), seenNade: makeSeen(), seenChat: makeSeen(), seenFire: makeSeen(64), seenLoadout: makeSeen(32),
      seenDrop: makeSeen(32), seenPick: makeSeen(32), seenBomb: makeSeen(32), seenRespawn: makeSeen(16)
    };
    remotes.set(id, r);
    return r;
  }

  function onMessage(msg) {
    if (disposed || !msg || typeof msg !== 'object') return;
    const event = msg.event;
    if (!isGameEvent(event)) return;
    const from = idOf(msg.from);
    if (!from || from === me) return;
    const t = now();
    const d = decodeMessage(event, msg.payload);
    S.recvMsgs.add(t);
    S.recvBytes.add(t, byteSize(msg.payload) + MSG_OVERHEAD + event.length);
    S.recvByType[event] = (S.recvByType[event] || 0) + 1;
    if (!d) { S.bad++; return; }
    const gone = departed.get(from);
    if (gone) {
      if (d.type !== 'state' || d.data.seq <= gone.maxSeq) { S.ignored++; return; }
      departed.delete(from);
    }
    const r = remoteOf(from, t);
    r.lastHeard = t;
    const x = d.data;
    switch (d.type) {
      case 'state': {
        const res = r.interp.push(x, t);
        if (res === 'dup') S.dup++;
        if (res === 'ok' && x.seq > r.maxSeq) {
          const first = r.state === null;
          r.maxSeq = x.seq;
          r.state = x;
          r.seqLog.push([t, x.seq]);
          if (r.seqLog.length > 128) r.seqLog.shift();
          safe(o.onRemoteState, from, x, { first, localT: r.interp.toLocal(x.t), arrival: t });
        }
        break;
      }
      case 'fire':
        if (r.seenFire(x.t + ':' + x.weaponId)) { S.dup++; break; }
        // at: 이 사격이 원격 아바타의 렌더 시간축에서 일어나는 로컬 시각(아바타와 맞추려면 그때 재생). 상태를 아직 못 받았으면 지금
        emit({ type: 'fire', from, ...x, kind: fireKind(msg.payload), senderT: x.t, at: r.interp.size ? r.interp.toLocal(x.t) : t });
        break;
      case 'hit':
        if (!amHost) { S.ignored++; break; }
        if (r.seenHit(x.id)) { S.dup++; break; }
        emit({ type: 'hitClaim', from, ...x, age: Math.max(0, clock.toHost(t) - x.shotT) });
        break;
      case 'grenade':
        if (r.seenNade(x.id)) { S.dup++; break; }
        emit({ type: 'grenade', from, ...x, gid: from + ':' + x.id, localT: clock.toLocal(x.t), age: clock.toHost(t) - x.t });
        break;
      case 'match':
        onMatch(from, x, t);
        break;
      case 'loadout': {
        if (r.seenLoadout(x.id)) break;
        const json = JSON.stringify(x.loadout);
        if (json === r.loadoutJson) break;
        r.loadoutJson = json;
        r.loadout = x.loadout;
        emit({ type: 'loadout', from, loadout: x.loadout });
        break;
      }
      case 'chat':
        if (r.seenChat(x.id)) { S.dup++; break; }
        emit({ type: 'chat', from, text: x.text, scope: x.scope });
        break;
      case 'drop':
        if (r.seenDrop(x.id)) { S.dup++; break; }
        emit({ type: 'drop', from, dropId: x.dropId, weaponId: x.weaponId, pos: x.pos, mag: x.mag, reserve: x.reserve });
        break;
      case 'pick':
        if (r.seenPick(x.id)) { S.dup++; break; }
        emit({ type: 'pick', from, dropId: x.dropId });
        break;
      case 'bomb':
        if (!amHost) { S.ignored++; break; }
        if (r.seenBomb(x.id)) { S.dup++; break; }
        emit({ type: 'bomb', from, act: x.act, reason: x.reason });
        break;
      case 'respawn':
        if (!amHost) { S.ignored++; break; }
        if (r.seenRespawn(x.id)) { S.dup++; break; }
        emit({ type: 'respawn', from });
        break;
      case 'ping':
        onPing(from, x, t, msg.t);
        break;
      default:
        break;
    }
  }

  function onMatch(from, m, t) {
    if (from !== hostId) {
      // 방장 교체 직후 옛 방장의 마지막 프레임이 늦게 온 경우: 이벤트(킬 등)만 받고 스냅샷은 새 방장 것을 쓴다
      if (from === prevHostId && now() - hostSince < o.prevHostGraceMs) {
        const late = [];
        for (const e of m.events) if (!seenMatchEv(from + ':' + e.eid)) late.push(e);
        if (late.length) emit({ type: 'match', from, seq: m.seq, snapshot: null, events: late, fresh: false, late: true });
        return;
      }
      S.ignored++;
      return; // 방장만 경기를 확정한다
    }
    if (matchFrom !== from) { matchFrom = from; matchSeqIn = -1; }
    const fresh = m.seq > matchSeqIn;
    const events = [];
    for (const e of m.events) if (!seenMatchEv(from + ':' + e.eid)) events.push(e);
    if (fresh) {
      matchSeqIn = m.seq;
      lastMatch = { from, seq: m.seq, snapshot: m.snapshot, at: t };
    }
    if (fresh || events.length) emit({ type: 'match', from, seq: m.seq, snapshot: fresh ? m.snapshot : null, events, fresh });
  }

  /** net 프레임 시각(msg.t)과 보낸 쪽이 실어 보낸 room.now()의 차 = net 큐에서 기다린 ms (모르면 0) */
  const queued = (frameT, d) => (Number.isFinite(frameT) && Number.isFinite(d) ? Math.max(0, Math.min(5000, frameT - d)) : 0);

  function onPing(from, p, t, frameT) {
    if (p.t1 === undefined) {
      if (!amHost) return;
      pongQ.set(from, { pid: p.pid, t0: p.t0, t1: t, e0: queued(frameT, p.d0) });
      return;
    }
    if (from !== hostId) return;
    const t0 = pingSent.get(p.pid);
    if (t0 === undefined) return; // 모르는 퐁·중복
    pingSent.delete(p.pid);
    // 핑이 내 net 큐에서 e0만큼, 퐁이 방장 net 큐에서 e2만큼 늦게 나갔다 → 실제 송신 시각으로 고친다
    clock.addSample(t0 + p.e0, p.t1, p.t2 + queued(frameT, p.d2), t);
  }

  /* ---------------------------------------------------------------- 방장·명단 */

  function refreshHost() {
    if (me == null) me = idOf(room.me);
    const h = readHostId();
    if (h === hostId) return;
    const prev = hostId;
    const was = amHost;
    hostId = h;
    amHost = h != null && h === me;
    hostSince = now();
    prevHostId = prev;
    if (amHost) {
      clock.setReference(true);
      // 아직 한 번도 안 보낸 내 히트 주장은 직접 처리, 이미 보낸 것은 옛 방장이 처리했을 수 있어 버린다
      for (const r of reliable) {
        if (r.kind !== 'hit' || r.left < o.reliableRepeat) continue;
        const d = decodeMessage(EV.hit, r.payload).data;
        loopQ.push({ type: 'hitClaim', from: me, ...d, age: 0, local: true });
      }
      // 폭탄 의도·즉시 부활 요청은 새 방장이 라운드(개인전은 출격)를 다시 시작하므로 버린다
      reliable = reliable.filter((r) => r.kind !== 'hit' && r.kind !== 'bomb' && r.kind !== 'respawn');
      // 새 스냅샷 번호는 마지막으로 받은 것 다음부터. 스냅샷 자체는 경기 모듈이 lastMatch()를 보고 다시 공지한다
      // (endsAt 등 방장 시계 값은 새 방장 기준으로 다시 계산해야 하므로 자동으로 재전송하지 않는다)
      matchSeqOut = Math.max(matchSeqOut, matchSeqIn);
      pendingPing = null;
      pingSent.clear();
    } else {
      const r = h ? remotes.get(h) : null;
      const seed = r && r.interp.size ? (clock.rtt == null ? 50 : clock.rtt / 2) - r.interp.base() : undefined;
      clock.reset(seed);
      reliable = reliable.filter((x) => x.kind !== 'hit' && x.kind !== 'bomb' && x.kind !== 'respawn');
      pendingPing = null;
      pingSent.clear();
      pingNextAt = -Infinity;
      if (was) { matchBody = null; matchDirty = false; matchEvents = []; }
    }
    pongQ.clear();
    matchFrom = amHost ? me : null;
    if (!amHost) matchSeqIn = -1;
    emit({ type: 'host', hostId: h, prevHostId: prev, isHost: amHost });
  }

  function onPlayers(list) {
    if (disposed) return;
    const ids = new Set();
    if (Array.isArray(list)) for (const p of list) { const id = idOf(p); if (id) ids.add(id); }
    playerIds = ids;
    // 명단에 다시 올라온 사람은 돌아온 것이다: 퇴장 기록을 지워 대기실 채팅·시계 핑까지 바로 받는다
    for (const id of ids) departed.delete(id);
    const t = now();
    for (const [id, r] of remotes) {
      if (ids.has(id)) { r.listed = true; continue; }
      // 명단에 있다가 빠짐 → 즉시 삭제. 명단에 아직 안 올라온 새 사람은 침묵할 때만(forgetStale)
      if (r.listed) removeRemote(id, t);
    }
  }

  function removeRemote(id, t) {
    const r = remotes.get(id);
    if (!r) return;
    remotes.delete(id);
    departed.set(id, { at: t, maxSeq: r.maxSeq });
    emit({ type: 'leave', id });
  }

  function forgetStale(t) {
    for (const [id, r] of remotes) if (!playerIds.has(id) && t - r.lastHeard > o.forgetMs) removeRemote(id, t);
    for (const [id, d] of departed) if (t - d.at > 60000) departed.delete(id);
  }

  /* ---------------------------------------------------------------- 조회 */

  /** 원격 플레이어 렌더 상태 (renderTime = 로컬 performance.now) → { id, pos, vel, yaw, pitch, slot, hp, alive, ..., mode, delay, stale } | null */
  function getRemote(id, renderTime) {
    const r = remotes.get(String(id));
    if (!r) return null;
    const t = Number.isFinite(renderTime) ? renderTime : now();
    const s = r.interp.sample(t);
    if (!s) return null;
    s.id = r.id;
    s.t = t;
    s.stale = t - r.lastHeard > o.staleMs;
    s.loadout = r.loadout;
    return s;
  }

  /** (방장 검증용) 방장 시계 hostT에 그 플레이어가 있던 상태 — 지연 없이 버퍼에서 바로 */
  function getRemoteAtHost(id, hostT) {
    const r = remotes.get(String(id));
    if (!r || !r.interp.size) return null;
    const s = r.interp.sampleAt(clock.toLocal(hostT) - r.interp.base());
    if (s) s.id = r.id;
    return s;
  }

  /** 원격의 상태 seq 증가율 ≈ 그 사람의 턴(프레임)/초 (merge·손실과 무관) */
  function seqRate(r, t) {
    const log = r.seqLog;
    while (log.length > 2 && t - log[0][0] > 5000) log.shift();
    if (log.length < 2 || t - log[log.length - 1][0] > 5000) return 0;
    const a = log[0], b = log[log.length - 1];
    return b[0] - a[0] >= 500 ? ((b[1] - a[1]) * 1000) / (b[0] - a[0]) : 0;
  }

  function stats() {
    const t = now();
    const remotesOut = {};
    let others = 0, hostRate = amHost ? S.turns.perSec(t) : 0;
    for (const [id, r] of remotes) {
      const rate = seqRate(r, t);
      others += rate;
      if (id === hostId) hostRate = rate;
      remotesOut[id] = { ...r.interp.stats(), heardAgo: Math.round(t - r.lastHeard), framesPerSec: rate };
    }
    const n = Math.max(1, playerIds.size || remotes.size + 1);
    const turnsPerSec = S.turns.perSec(t);
    const all = turnsPerSec + others;
    const topo = room.meta && room.meta.net === 'relay' ? 'relay' : 'mesh';
    // mesh: 프레임 1개 = 송신 1 + 전달 N-1 = N.  relay: 비방장 프레임 2(uplink 송신+방장 전달), 방장 프레임 N
    const est = topo === 'relay' ? 2 * Math.max(0, all - hostRate) + n * hostRate : n * all;
    return {
      me, hostId, isHost: amHost, players: n,
      stateHz: stateHz(), turnRate: turnRate(), roomRate: Number(room.rate) || null,
      sent: {
        turns: S.turns.total, msgs: S.sentMsgs.total, bytes: Math.round(S.sentBytes.total),
        turnsPerSec, msgsPerSec: S.sentMsgs.perSec(t), bytesPerSec: S.sentBytes.perSec(t), byType: { ...S.sentByType }
      },
      recv: {
        msgs: S.recvMsgs.total, bytes: Math.round(S.recvBytes.total),
        msgsPerSec: S.recvMsgs.perSec(t), bytesPerSec: S.recvBytes.perSec(t), byType: { ...S.recvByType }
      },
      /** 이 방이 만드는 Supabase 이벤트/초 추정(송신+팬아웃 전달). 다른 사람 프레임/초는 상태 seq 증가율로 잰다 */
      topology: topo,
      roomFramesPerSec: all,
      estEventsPerSec: est,
      /** coalesced: 토큰(상한)이 없어 미룬 턴 / waited: 이벤트가 다음 상태 프레임을 기다린 틱 / eventsPerTurn: 턴당 실린 이벤트 메시지 */
      coalesced: S.coalesced, waited: S.waited, eventsPerTurn: S.turns.total ? S.eventMsgs / S.turns.total : 0, maxTurnsIn1s: S.maxTurnsIn1s,
      dropped: { dup: S.dup, bad: S.bad, ignored: S.ignored },
      callbackErrors: S.callbackErrors,
      clock: { offset: clock.offset, rtt: clock.rtt, synced: clock.synced, samples: clock.samples },
      remotes: remotesOut
    };
  }

  /* ---------------------------------------------------------------- 연결·정리 */

  const offs = [];
  const sub = (ev, fn) => { try { const off = room.on(ev, fn); if (typeof off === 'function') offs.push(off); } catch (_) { /* noop */ } };
  sub('message', onMessage);
  sub('players', onPlayers);
  sub('host', () => { if (!disposed) refreshHost(); });
  sub('closed', (info) => {
    if (disposed || closed) return;
    closed = true;
    stopTimer();
    emit({ type: 'closed', reason: info && info.reason });
  });
  try { onPlayers(typeof room.players === 'function' ? room.players() : []); } catch (_) { /* noop */ }

  let timer = null;
  function stopTimer() { if (timer) { clearInterval(timer); timer = null; } }
  if (o.autoTick) timer = setInterval(() => tick(), o.tickMs);

  /**
   * 정리. flush=true(기본)면 아직 net에 넘기지 않은 사격·히트·수류탄·경기 이벤트를 마지막으로 한 번 보낸다
   * (room.leave() 전에 부르면 net이 퇴장 프레임에 같이 실어 보낸다).
   */
  function dispose({ flush = true } = {}) {
    if (disposed) return;
    if (flush && !closed && (fireQ.length || reliable.length || pongQ.size || (amHost && matchBody && matchDirty))) {
      try {
        const t = now();
        refill(t);
        tokens = Math.max(tokens, 1);
        doTurn(t, sampleLocal(t));
      } catch (_) { /* noop */ }
    }
    disposed = true;
    stopTimer();
    for (const off of offs.splice(0)) { try { off(); } catch (_) { /* noop */ } }
    remotes.clear();
    departed.clear();
    fireQ.length = 0;
    reliable = [];
    pongQ.clear();
    pingSent.clear();
    loopQ.length = 0;
  }

  return {
    tick,
    update: tick,
    sendFire,
    sendHitClaim,
    sendGrenade,
    sendDrop,
    sendPick,
    sendBomb,
    sendRespawn,
    sendMatch,
    sendLoadout,
    sendChat,
    getRemote,
    getRemoteAtHost,
    /** 상태를 한 번이라도 받은 원격 id 목록 */
    remoteIds: () => [...remotes.keys()].filter((id) => remotes.get(id).state),
    /** 원격의 마지막 원본 상태(보간 전)·로드아웃 */
    remote: (id) => { const r = remotes.get(String(id)); return r ? { state: r.state, loadout: r.loadout, lastHeard: r.lastHeard } : null; },
    /** 마지막으로 받은(방장이면 보낸) 경기 스냅샷 { from, seq, snapshot, at } — 방장 이전 시 이어받기용 */
    lastMatch: () => lastMatch,
    hostNow: () => clock.toHost(now()),
    toHostTime: (localT) => clock.toHost(localT),
    toLocalTime: (hostT) => clock.toLocal(hostT),
    isHost: () => amHost,
    hostId: () => hostId,
    get clock() { return { offset: clock.offset, rtt: clock.rtt, synced: clock.synced, samples: clock.samples, hostSince }; },
    stats,
    dispose,
    get disposed() { return disposed; }
  };
}
