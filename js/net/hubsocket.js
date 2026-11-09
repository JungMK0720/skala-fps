/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: Cloudflare 중계 서버(server/relay)에 붙는 소켓. RealtimeSocket과 겉모양이 같아서 room.js·lobby.js·index.js의 Net이 그대로 쓴다.
 *          서버는 허브(로비 하나, 방마다 하나)가 Durable Object 하나라서, 채널 이름으로 허브를 골라 허브마다 WebSocket을 하나씩 연다.
 */
/*
 *   const socket = new HubSocket({ url: 'https://skala-relay.<계정>.workers.dev' });   // 로컬: 'http://127.0.0.1:8788'
 *   await socket.open();                        // 로비 허브에 먼저 붙어 서버가 살아 있는지 본다
 *   socket.channel('skalafps:lobby', opts)      // → 로비 허브 WebSocket 위의 Channel(realtime.js)
 *   socket.channel('skalafps:room:abc', opts)   // → 방 허브 WebSocket 위의 Channel
 *
 *  - 허브마다 RealtimeSocket 하나(링크). 채널 규약·재연결·presence 합치기는 realtime.js를 그대로 쓴다.
 *  - 링크에 남은 채널이 없으면 linkIdleMs 뒤 닫는다(방에서 나오면 방 허브 연결도 닫힌다).
 *  - 하트비트는 정해진 글자(ref 'hb')만 보낸다. 서버는 잠든 채로 런타임이 답하므로 객체를 깨우지 않는다.
 *  - presence track은 Supabase보다 빠르게 허용한다(10.5초 10회). 서버 한도는 10초 12회(server/relay/src/rules.js).
 *  - room.js의 relay 토폴로지(uplink 채널)는 쓰지 않는다. 서버가 프레임을 직접 나눠 주므로 mesh로 충분하다(index.js가 mesh로 고정).
 */
import { NET } from '../core/consts.js';
import { Emitter, RealtimeSocket, netError } from './realtime.js';

export const HUB_HEARTBEAT_REF = 'hb';
export const HUB_PRESENCE_LIMIT = Object.freeze({ max: 10, windowMs: 10500, minGapMs: 100 });
const STAT_KEYS = ['framesOut', 'framesIn', 'bytesOut', 'bytesIn', 'broadcastsOut', 'broadcastsIn', 'presenceCalls'];

/** 채널 이름 → 그 채널을 맡는 허브 이름. room.js uplink('...:u:<id>')는 같은 방 허브로 간다(서버가 받지 않는다). 모르는 이름은 null */
export function hubOf(topic) {
  const t = String(topic || '');
  if (t === NET.LOBBY_CHANNEL) return t;
  if (!t.startsWith(NET.ROOM_CHANNEL_PREFIX) || t.length === NET.ROOM_CHANNEL_PREFIX.length) return null;
  const up = t.indexOf(':u:', NET.ROOM_CHANNEL_PREFIX.length);
  return up < 0 ? t : t.slice(0, up);
}

/** 서버 주소 + 허브 이름 → WebSocket 주소 */
export function hubEndpoint(base, hub) {
  return String(base).trim().replace(/\/+$/, '').replace(/^http/i, 'ws') + '/ws?hub=' + encodeURIComponent(hub);
}

/**
 * new HubSocket({ url, linkIdleMs?=3000, warmIdleMs?=20000, heartbeatMs?, heartbeatTimeoutMs?, timeoutMs?, backoff?, logger?, WebSocket?, presenceLimit? })
 * 이벤트: 'state'(state, info) — 'connecting' | 'open' | 'reconnecting' | 'closed', 'closed', 'rtt'(ms)
 */
export class HubSocket extends Emitter {
  constructor(opts = {}) {
    super();
    const url = String(opts.url || '').trim().replace(/\/+$/, '');
    if (!/^(https?|wss?):\/\/[^/\s]+/i.test(url)) throw netError('NO_CONFIG', '중계 서버 주소(http(s)://…)가 필요합니다');
    this.url = url;
    this.WS = opts.WebSocket || globalThis.WebSocket;
    if (!this.WS) throw netError('NO_WEBSOCKET', '이 환경에는 WebSocket이 없습니다');
    this.linkOpts = {
      WebSocket: this.WS,
      logger: opts.logger,
      backoff: opts.backoff,
      heartbeatMs: opts.heartbeatMs,
      heartbeatTimeoutMs: opts.heartbeatTimeoutMs,
      timeoutMs: opts.timeoutMs,
      heartbeatRef: HUB_HEARTBEAT_REF,
      presenceLimit: { ...HUB_PRESENCE_LIMIT, ...(opts.presenceLimit || {}) }
    };
    this.linkIdleMs = opts.linkIdleMs != null ? opts.linkIdleMs : 3000;
    this.warmIdleMs = opts.warmIdleMs != null ? opts.warmIdleMs : 20000;
    this.links = new Map();   // 허브 이름 -> { hub, sock, live: Set<Channel>, timer, rtt, offs }
    this.state = 'idle';
    this._closedByUser = false;
    this._done = { reconnects: 0 };   // 닫은 링크의 누적 수치
    for (const k of STAT_KEYS) this._done[k] = 0;
  }

  /** 방 허브의 하트비트 왕복(ms). 방에 없으면 로비 허브 값 */
  get rtt() {
    let lobby = null;
    for (const L of this.links.values()) {
      if (L.rtt == null) continue;
      if (L.hub !== NET.LOBBY_CHANNEL) return L.rtt;
      lobby = L.rtt;
    }
    return lobby;
  }

  get reconnects() {
    let n = this._done.reconnects;
    for (const L of this.links.values()) n += L.sock.reconnects;
    return n;
  }

  get stats() {
    const out = {};
    for (const k of STAT_KEYS) {
      let v = this._done[k];
      for (const L of this.links.values()) v += L.sock.stats[k] || 0;
      out[k] = v;
    }
    out.links = this.links.size;
    return out;
  }

  isOpen() { return this.state === 'open'; }

  /** 처음 연결. 로비 허브가 timeoutMs 안에 열리지 않으면 reject하고 닫는다 */
  open(timeoutMs = 15000) {
    if (this.state === 'open') return Promise.resolve();
    if (this._closedByUser) return Promise.reject(netError('CLOSED', '이미 닫힌 연결입니다'));
    this._setState('connecting');
    const L = this._link(NET.LOBBY_CHANNEL, false);
    return L.sock.open(timeoutMs).then(() => {
      if (this._closedByUser) throw netError('CLOSED', '연결이 닫혔습니다');
      this._setState('open');
      this._idle(L, this.warmIdleMs);   // 곧 로비를 구독하지 않으면 닫는다
    }, (err) => {
      this.close();
      throw err && err.code === 'CONNECT_TIMEOUT' ? netError('CONNECT_TIMEOUT', '중계 서버에 연결하지 못했습니다') : err;
    });
  }

  /** 채널을 만든다(아직 참가 전). topic은 'realtime:' 접두사 없이 */
  channel(topic, opts) {
    if (this._closedByUser) {
      // 닫힌 뒤에 만든 채널은 참가하지 못하고 시간 제한으로 끝난다(RealtimeSocket과 같다)
      const dead = new RealtimeSocket({ endpoint: 'ws://closed.invalid', WebSocket: this.WS });
      dead.close();
      return dead.channel(topic, opts);
    }
    const L = this._link(hubOf(topic) || String(topic));
    const ch = L.sock.channel(topic, opts);
    L.live.add(ch);
    this._keep(L);
    ch.on('left', () => {
      L.live.delete(ch);
      this._idle(L, this.linkIdleMs);
      this._recompute();
    });
    return ch;
  }

  /** 시험용: 모든 링크의 네트워크 단절을 흉내 낸다(서버에는 끊긴 연결로 보임) → 백오프 재연결 */
  simulateDrop(reason = 'simulated-drop') {
    for (const L of this.links.values()) L.sock.simulateDrop(reason);
  }

  reconnectNow() {
    for (const L of this.links.values()) L.sock.reconnectNow();
  }

  close() {
    if (this._closedByUser) return;
    this._closedByUser = true;
    for (const L of [...this.links.values()]) this._drop(L);
    this._setState('closed');
    this.emit('closed');
  }

  /* ---------------- 링크(허브마다 WebSocket 하나) ---------------- */

  _link(hub, start = true) {
    const known = this.links.get(hub);
    if (known) { this._keep(known); return known; }
    const sock = new RealtimeSocket({ endpoint: hubEndpoint(this.url, hub), ...this.linkOpts });
    const L = { hub, sock, live: new Set(), timer: null, rtt: null, offs: [] };
    L.offs.push(sock.on('state', () => this._recompute()));
    L.offs.push(sock.on('rtt', (ms) => { L.rtt = ms; this.emit('rtt', ms); }));
    this.links.set(hub, L);
    if (start) sock.start();
    return L;
  }

  _keep(L) {
    clearTimeout(L.timer);
    L.timer = null;
  }

  _idle(L, ms) {
    if (L.live.size || L.timer || this._closedByUser) return;
    L.timer = setTimeout(() => {
      L.timer = null;
      if (!L.live.size && this.links.get(L.hub) === L) this._drop(L);
    }, ms);
  }

  _drop(L) {
    this._keep(L);
    if (this.links.get(L.hub) === L) this.links.delete(L.hub);
    for (const off of L.offs) off();
    L.offs = [];
    this._done.reconnects += L.sock.reconnects;
    for (const k of STAT_KEYS) this._done[k] += L.sock.stats[k] || 0;
    L.sock.close();
    this._recompute();
  }

  /** 채널이 있는 링크 중 하나라도 다시 붙는 중이면 'reconnecting' */
  _recompute() {
    if (this._closedByUser || this.state === 'idle' || this.state === 'connecting') return;
    let next = 'open';
    for (const L of this.links.values()) {
      if (L.live.size && L.sock.openedOnce && L.sock.state === 'reconnecting') { next = 'reconnecting'; break; }
    }
    this._setState(next);
  }

  _setState(s, info) {
    if (this.state === s) return;
    this.state = s;
    this.emit('state', s, info || {});
  }
}
