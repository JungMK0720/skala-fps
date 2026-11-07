/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: Supabase Realtime 무료 플랜 한도, 전송 예산 계산, 레이트 리미터.
 */
/*
 * js/net/limits.js — Supabase Realtime 무료 플랜 한도, 전송 예산 계산, 레이트 리미터
 *
 * 한도 출처: https://supabase.com/docs/guides/realtime/limits (2026-11 확인)
 * 계수 방식 출처: supabase/realtime 서버 소스
 *   - broadcast_handler.ex   : 클라이언트가 보낸 broadcast 1건 = 이벤트 1
 *   - message_dispatcher.ex  : 구독자에게 전달될 때마다 이벤트 1 (팬아웃만큼 계수)
 *   - rate_counter / tenants : 5초 버킷 × 12 = 60초 평균, 프로젝트(테넌트) 전체 합산
 *   - presence_handler.ex    : track/untrack은 채널(프로세스)당 30초 고정 창 5회. 초과 시 채널 강제 종료
 *   - 메시지/초 초과 시 "Too many messages per second"로 채널 강제 종료
 */

export const FREE_PLAN = Object.freeze({
  concurrentConnections: 200,      // 프로젝트 동시 WebSocket 연결
  messagesPerSecond: 100,          // 프로젝트 전체, 송신+수신(팬아웃) 합산, 60초 평균
  channelJoinsPerSecond: 100,
  channelsPerConnection: 100,
  presenceKeysPerObject: 10,
  presenceMessagesPerSecond: 20,   // 프로젝트 전체 presence 이벤트(track + diff 전달), 60초 평균
  presenceCallsPer30s: 5,          // 클라이언트 채널당 track/untrack 30초 5회 (초과 시 채널 종료)
  broadcastPayloadKB: 256
});

/** 기본 예산: 무료 한도 100 msg/s의 80% (나머지 20%는 여유분) */
export const DEFAULT_BUDGET = 80;

/**
 * 모든 클라이언트가 프레임 1개씩 보낼 때(1틱) 프로젝트에 계수되는 이벤트 수.
 *  mesh : 각자 방 채널에 broadcast → 1(송신) + (N-1)(전달) = N, N명이면 N²
 *  relay: 비방장은 자기 uplink 채널로 방장에게만(송신 1 + 전달 1),
 *         방장은 묶음 프레임 1개를 방 채널로(1 + (N-1)) → 2(N-1) + N = 3N-2
 */
export function frameCost(players, topology = 'mesh') {
  const n = Math.max(1, players | 0);
  return topology === 'relay' ? 3 * n - 2 : n * n;
}

/** 인원 수에 따른 자동 토폴로지(기본: 4명 이상이면 relay) */
export function autoTopology(players, relayMinPlayers = 4) {
  return (players | 0) >= relayMinPlayers ? 'relay' : 'mesh';
}

/** players명이 hz로 상태를 보낼 때 초당 이벤트 */
export function eventsPerSecond(players, hz, topology = 'mesh') {
  return frameCost(players, topology) * hz;
}

/** 0.5Hz 단위로 내림 + [min, max] 범위로 자른다 */
export function clampHz(hz, min = 1, max = 20) {
  if (!Number.isFinite(hz)) return max;
  return Math.max(min, Math.min(max, Math.floor(hz * 2) / 2));
}

/** 예산 안에서 허용되는 클라이언트당 최대 전송 Hz. rooms = 동시에 진행 중인 다른 방들의 인원 배열 */
export function maxHz(players, { budget = DEFAULT_BUDGET, topology = 'mesh', otherRooms = [], min = 1, max = 20 } = {}) {
  let total = frameCost(players, topology);
  for (const n of otherRooms) total += frameCost(n, autoTopology(n));
  return clampHz(budget / total, min, max);
}

/** README용 표: 인원별 10Hz 비용과 허용 Hz */
export function planTable(maxPlayers = 8, hz = 10, budget = DEFAULT_BUDGET) {
  const rows = [];
  for (let n = 2; n <= maxPlayers; n++) {
    rows.push({
      players: n,
      meshAt: eventsPerSecond(n, hz, 'mesh'),
      relayAt: eventsPerSecond(n, hz, 'relay'),
      meshMaxHz: clampHz(budget / frameCost(n, 'mesh'), 0.5, 60),
      relayMaxHz: clampHz(budget / frameCost(n, 'relay'), 0.5, 60)
    });
  }
  return rows;
}

const now = () => (globalThis.performance && performance.now ? performance.now() : Date.now());

/** 토큰 버킷: rate개/초, 최대 burst개 비축 */
export class TokenBucket {
  constructor(ratePerSec = 10, burst = 2) {
    this.rate = Math.max(0.01, ratePerSec);
    this.burst = Math.max(1, burst);
    this.tokens = this.burst;
    this.last = now();
  }
  _refill(t) {
    const dt = Math.max(0, t - this.last) / 1000;
    this.tokens = Math.min(this.burst, this.tokens + dt * this.rate);
    this.last = t;
  }
  setRate(ratePerSec) {
    this._refill(now());
    this.rate = Math.max(0.01, ratePerSec);
  }
  /** 다음 토큰까지 남은 ms (0이면 즉시 가능) */
  waitMs(t = now()) {
    this._refill(t);
    return this.tokens >= 1 ? 0 : Math.ceil(((1 - this.tokens) / this.rate) * 1000);
  }
  take(t = now()) {
    this._refill(t);
    if (this.tokens >= 1) { this.tokens -= 1; return true; }
    return false;
  }
}

/** 슬라이딩 창 리미터: windowMs 안에 max회, 호출 간 최소 간격 minGapMs */
export class SlidingWindowLimiter {
  constructor(max = 4, windowMs = 31000, minGapMs = 0) {
    this.max = max;
    this.windowMs = windowMs;
    this.minGapMs = minGapMs;
    this.ts = [];
  }
  _prune(t) {
    while (this.ts.length && t - this.ts[0] >= this.windowMs) this.ts.shift();
  }
  waitMs(t = Date.now()) {
    this._prune(t);
    let w = 0;
    if (this.ts.length >= this.max) w = this.ts[0] + this.windowMs - t;
    if (this.minGapMs && this.ts.length) w = Math.max(w, this.ts[this.ts.length - 1] + this.minGapMs - t);
    return Math.max(0, Math.ceil(w));
  }
  record(t = Date.now()) { this.ts.push(t); }
  reset() { this.ts = []; }
}
