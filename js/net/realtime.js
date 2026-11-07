/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: Supabase Realtime 전용 얇은 클라이언트(Phoenix 채널 프로토콜, JSON).
 */
/*
 * js/net/realtime.js — Supabase Realtime 얇은 클라이언트 (Phoenix 채널 vsn 1.0.0, JSON)
 *
 *  - 브라우저와 Node 22+ 공용(전역 WebSocket). 외부 의존성 없음.
 *  - 접속: wss://<ref>.supabase.co/realtime/v1/websocket?apikey=<key>&vsn=1.0.0
 *  - 메시지: { topic, event, payload, ref, join_ref }   (topic = 'realtime:' + 채널 이름)
 *  - 하트비트: topic 'phoenix', event 'heartbeat', 25초. 10초 안에 응답이 없으면 끊고 재연결
 *  - 재연결: 지수 백오프 + 지터. 재접속하면 채널에 자동 재참가하고 마지막 presence를 다시 track
 *  - presence: presence_state / presence_diff를 Phoenix 규칙대로 합친다
 *  - presence track은 서버 한도(채널당 30초 5회, 초과하면 채널 강제 종료)를 넘지 않도록
 *    클라이언트에서 31초 4회로 제한하고, 그 사이 요청은 마지막 값으로 합친다
 *  - 서버의 강제 종료(system error + phx_close)도 백오프 후 재참가
 */
import { SlidingWindowLimiter } from './limits.js';

export const VSN = '1.0.0';
const PHX_JOIN = 'phx_join';
const PHX_LEAVE = 'phx_leave';
const PHX_REPLY = 'phx_reply';
const PHX_CLOSE = 'phx_close';
const PHX_ERROR = 'phx_error';

const nowMs = () => (globalThis.performance && performance.now ? performance.now() : Date.now());

/* ---------------- 공통 유틸 ---------------- */

export function netError(code, message, extra) {
  const e = new Error(message || code);
  e.code = code;
  if (extra) Object.assign(e, extra);
  return e;
}

const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
export function randomId(len = 10) {
  const buf = new Uint8Array(len);
  if (globalThis.crypto && globalThis.crypto.getRandomValues) globalThis.crypto.getRandomValues(buf);
  else for (let i = 0; i < len; i++) buf[i] = Math.floor(Math.random() * 256);
  let s = '';
  for (let i = 0; i < len; i++) s += ID_CHARS[buf[i] % 36];
  return s;
}

/** 제어문자 제거 + 길이 제한. 화면 표시는 반드시 textContent로 */
export function sanitizeName(v, max = 24) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}

const MAX_FIELD_CHARS = 128;

/**
 * 남이 보낸 객체(presence·방 메타·_me 패치)에서 숫자·글자·참거짓만 남긴다. 긴 글자는 자른다.
 * 쓰는 쪽은 여기 값을 String()·숫자로 바꾸는데, JSON으로 온 {"toString":1} 같은 객체는 그때 던지고
 * 이 값은 계속 저장돼 있으므로 방이나 로비가 끝까지 망가진다. 프로토콜에 객체 칸은 없다.
 */
export function plainFields(src) {
  const out = {};
  if (!src || typeof src !== 'object') return out;
  for (const k of Object.keys(src)) {
    if (k === '__proto__') continue;
    const v = src[k];
    if (typeof v === 'string') out[k] = v.length > MAX_FIELD_CHARS ? v.slice(0, MAX_FIELD_CHARS) : v;
    else if (v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) out[k] = v;
  }
  return out;
}

export function backoffDelay(attempt, opt = {}) {
  const { base = 500, max = 15000, factor = 2, jitter = 0.25 } = opt;
  const raw = Math.min(max, base * Math.pow(factor, Math.max(0, attempt)));
  return Math.max(0, Math.round(raw * (1 - jitter + Math.random() * 2 * jitter)));
}

export class Emitter {
  constructor() { this._ls = new Map(); }
  on(ev, fn) {
    let set = this._ls.get(ev);
    if (!set) this._ls.set(ev, (set = new Set()));
    set.add(fn);
    return () => set.delete(fn);
  }
  once(ev, fn) {
    const off = this.on(ev, (...a) => { off(); fn(...a); });
    return off;
  }
  emit(ev, ...args) {
    const set = this._ls.get(ev);
    if (!set || !set.size) return;
    for (const fn of [...set]) {
      try { fn(...args); } catch (e) { console.error('[net] listener error:', ev, e); }
    }
  }
  removeAll() { this._ls.clear(); }
}

/* ---------------- Presence 상태 (Phoenix presence 합치기 규칙) ---------------- */

export class PresenceState {
  constructor() { this.state = new Map(); } // key -> [meta...]
  static metasOf(entry) {
    const arr = Array.isArray(entry) ? entry : (entry && Array.isArray(entry.metas) ? entry.metas : []);
    return arr.map((m) => {
      const c = plainFields(m);
      c.presence_ref = c.phx_ref != null ? c.phx_ref : c.presence_ref;
      delete c.phx_ref;
      delete c.phx_ref_prev;
      return c;
    });
  }
  clear() { this.state.clear(); }
  syncState(raw) {
    const next = new Map();
    for (const key of Object.keys(raw || {})) next.set(key, PresenceState.metasOf(raw[key]));
    const joins = {}, leaves = {};
    for (const [key, metas] of this.state) if (!next.has(key)) leaves[key] = metas;
    for (const [key, metas] of next) {
      const cur = this.state.get(key);
      if (!cur) { joins[key] = metas; continue; }
      const curRefs = new Set(cur.map((m) => m.presence_ref));
      const nextRefs = new Set(metas.map((m) => m.presence_ref));
      const j = metas.filter((m) => !curRefs.has(m.presence_ref));
      const l = cur.filter((m) => !nextRefs.has(m.presence_ref));
      if (j.length) joins[key] = j;
      if (l.length) leaves[key] = l;
    }
    this.state = next;
    return { joins, leaves };
  }
  syncDiff(diff) {
    const joins = {}, leaves = {};
    const dj = (diff && diff.joins) || {};
    const dl = (diff && diff.leaves) || {};
    for (const key of Object.keys(dj)) {
      const add = PresenceState.metasOf(dj[key]);
      const addRefs = new Set(add.map((m) => m.presence_ref));
      const cur = (this.state.get(key) || []).filter((m) => !addRefs.has(m.presence_ref));
      this.state.set(key, cur.concat(add));
      joins[key] = add;
    }
    for (const key of Object.keys(dl)) {
      const rm = new Set(PresenceState.metasOf(dl[key]).map((m) => m.presence_ref));
      const cur = this.state.get(key);
      if (!cur) continue;
      const left = cur.filter((m) => rm.has(m.presence_ref));
      const rest = cur.filter((m) => !rm.has(m.presence_ref));
      if (rest.length) this.state.set(key, rest); else this.state.delete(key);
      if (left.length) leaves[key] = left;
    }
    return { joins, leaves };
  }
  has(key) { return this.state.has(key); }
  get(key) { return this.state.get(key) || []; }
  keys() { return [...this.state.keys()]; }
  list() { return [...this.state].map(([key, metas]) => ({ key, metas })); }
  get size() { return this.state.size; }
}

/* ---------------- 소켓 ---------------- */

/**
 * new RealtimeSocket({ url, key, heartbeatMs?, heartbeatTimeoutMs?, timeoutMs?, backoff?, logger?, WebSocket? })
 * 이벤트: 'state'(state, info) — 'connecting' | 'open' | 'reconnecting' | 'closed'
 *         'open', 'closed', 'rtt'(ms)
 */
export class RealtimeSocket extends Emitter {
  constructor(opts = {}) {
    super();
    const { url, key } = opts;
    if (!url || !key) throw netError('NO_CONFIG', 'Supabase url/key가 필요합니다');
    this.url = String(url).replace(/\/+$/, '');
    this.key = String(key);
    this.endpoint = this.url.replace(/^http/i, 'ws') + '/realtime/v1/websocket?apikey=' +
      encodeURIComponent(this.key) + '&vsn=' + VSN;
    this.WS = opts.WebSocket || globalThis.WebSocket;
    if (!this.WS) throw netError('NO_WEBSOCKET', '이 환경에는 WebSocket이 없습니다');
    this.heartbeatMs = opts.heartbeatMs || 25000;
    this.heartbeatTimeoutMs = opts.heartbeatTimeoutMs || 10000;
    this.timeoutMs = opts.timeoutMs || 10000;
    this.backoff = { base: 500, max: 15000, factor: 2, jitter: 0.25, ...(opts.backoff || {}) };
    this.log = typeof opts.logger === 'function' ? opts.logger : () => {};
    this.ws = null;
    this.state = 'idle';
    this.attempt = 0;
    this.ref = 0;
    this.channels = new Map(); // fullTopic -> Channel
    this.pending = new Map();  // ref -> resolve
    this.rtt = null;
    this.reconnects = 0;
    this.openedOnce = false;
    this.stats = { framesOut: 0, framesIn: 0, bytesOut: 0, bytesIn: 0, broadcastsOut: 0, broadcastsIn: 0, presenceCalls: 0 };
    this._hbTimer = null;
    this._hbPending = null;
    this._reconnectTimer = null;
    this._closedByUser = false;
    this._envOff = null;
    this._installEnvHooks();
  }

  isOpen() { return !!this.ws && this.state === 'open' && this.ws.readyState === 1; }

  makeRef() {
    this.ref = this.ref >= 2147483647 ? 1 : this.ref + 1;
    return String(this.ref);
  }

  /** 처음 연결. timeoutMs 안에 못 열면 reject하고 소켓을 닫는다 */
  open(timeoutMs = 15000) {
    if (this.isOpen()) return Promise.resolve();
    if (this._closedByUser) return Promise.reject(netError('CLOSED', '이미 닫힌 연결입니다'));
    return new Promise((resolve, reject) => {
      const done = (fn, v) => { clearTimeout(timer); offOpen(); offClosed(); fn(v); };
      const timer = setTimeout(() => {
        done(reject, netError('CONNECT_TIMEOUT', 'Realtime 서버에 연결하지 못했습니다'));
        this.close();
      }, timeoutMs);
      const offOpen = this.on('open', () => done(resolve));
      const offClosed = this.on('closed', () => done(reject, netError('CLOSED', '연결이 닫혔습니다')));
      this._connect();
    });
  }

  _setState(s, info) {
    if (this.state === s) return;
    this.state = s;
    this.emit('state', s, info || {});
  }

  _connect() {
    if (this._closedByUser || this.ws) return;
    this._setState(this.openedOnce ? 'reconnecting' : 'connecting');
    let ws;
    try { ws = new this.WS(this.endpoint); } catch (e) {
      this.log('ws create failed', e && e.message);
      this._scheduleReconnect();
      return;
    }
    this.ws = ws;
    try { ws.binaryType = 'arraybuffer'; } catch (_) { /* noop */ }
    ws.onopen = () => this._onOpen(ws);
    ws.onmessage = (e) => this._onMessage(ws, e);
    ws.onclose = (e) => this._onClose(ws, e);
    ws.onerror = (e) => this.log('ws error', e && (e.message || e.type));
  }

  _onOpen(ws) {
    if (ws !== this.ws) return;
    this.attempt = 0;
    this.openedOnce = true;
    this._setState('open');
    this._startHeartbeat();
    this.heartbeat(); // 바로 한 번: 서버 RTT를 처음부터 알 수 있게
    this.emit('open');
    for (const ch of [...this.channels.values()]) ch._onSocketOpen();
  }

  _onClose(ws, e) {
    if (ws !== this.ws) return;
    this.ws = null;
    this._stopHeartbeat();
    const pend = [...this.pending.values()];
    this.pending.clear();
    for (const p of pend) p({ status: 'disconnected', response: {} });
    for (const ch of [...this.channels.values()]) ch._onSocketClose();
    if (this._closedByUser) return;
    this.log('socket closed', e && e.code, e && e.reason);
    this._setState('reconnecting', { code: e && e.code, reason: e && e.reason });
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this._closedByUser) return;
    clearTimeout(this._reconnectTimer);
    const d = backoffDelay(this.attempt++, this.backoff);
    this.reconnects++;
    this.log('reconnect in', d);
    this._reconnectTimer = setTimeout(() => { this._reconnectTimer = null; this._connect(); }, d);
  }

  /** 대기 중인 재연결을 즉시 시도 (브라우저 'online' 이벤트 등) */
  reconnectNow() {
    if (this._closedByUser || this.ws) return;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
    this.attempt = 0;
    this._connect();
  }

  /** 테스트용: 네트워크 단절을 흉내 낸다(서버에는 정상 종료로 보임) → 백오프 재연결 */
  simulateDrop(reason = 'simulated-drop') { this._forceReconnect(reason); }

  _forceReconnect(reason) {
    const ws = this.ws;
    if (!ws) return;
    try {
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      ws.close(4000, String(reason).slice(0, 60));
    } catch (_) { /* noop */ }
    this._onClose(ws, { code: 4000, reason });
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this._hbTimer = setInterval(() => this.heartbeat(), this.heartbeatMs);
  }

  _stopHeartbeat() {
    clearInterval(this._hbTimer);
    this._hbTimer = null;
    if (this._hbPending) clearTimeout(this._hbPending.timer);
    this._hbPending = null;
  }

  /** 하트비트 1회 (응답으로 서버 RTT도 잰다) */
  heartbeat() {
    if (!this.isOpen() || this._hbPending) return;
    const ref = this.makeRef();
    const sentAt = nowMs();
    const timer = setTimeout(() => {
      this._hbPending = null;
      this.log('heartbeat timeout -> reconnect');
      this._forceReconnect('heartbeat-timeout');
    }, this.heartbeatTimeoutMs);
    this._hbPending = { ref, sentAt, timer };
    this._sendObj({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref });
  }

  _sendObj(msg) { return this.sendRaw(JSON.stringify(msg)); }

  sendRaw(str) {
    if (!this.isOpen()) return false;
    try { this.ws.send(str); } catch (e) { this.log('send failed', e && e.message); return false; }
    this.stats.framesOut++;
    this.stats.bytesOut += str.length;
    return true;
  }

  /** 응답(phx_reply)을 기다리는 push. 결과: { status: 'ok'|'error'|'timeout'|'disconnected', response } */
  request(msg, timeoutMs = this.timeoutMs) {
    if (!this.isOpen()) return Promise.resolve({ status: 'disconnected', response: {} });
    const ref = msg.ref || this.makeRef();
    msg.ref = ref;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(ref);
        resolve({ status: 'timeout', response: {} });
      }, timeoutMs);
      this.pending.set(ref, (r) => { clearTimeout(timer); resolve(r); });
      if (!this._sendObj(msg)) {
        this.pending.delete(ref);
        clearTimeout(timer);
        resolve({ status: 'disconnected', response: {} });
      }
    });
  }

  _onMessage(ws, e) {
    if (ws !== this.ws) return;
    const data = e.data;
    let msg = null;
    if (typeof data === 'string') {
      this.stats.bytesIn += data.length;
      try { msg = JSON.parse(data); } catch (_) { return; }
    } else if (data instanceof ArrayBuffer) {
      this.stats.bytesIn += data.byteLength;
      msg = decodeBinaryBroadcast(data);
    }
    if (!msg || typeof msg !== 'object') return;
    this.stats.framesIn++;
    const { topic, event, payload, ref } = msg;
    if (event === PHX_REPLY && ref != null) {
      const p = this.pending.get(ref);
      if (p) {
        this.pending.delete(ref);
        p({ status: (payload && payload.status) || 'error', response: (payload && payload.response) || {} });
      }
    }
    if (topic === 'phoenix') {
      if (this._hbPending && ref === this._hbPending.ref) {
        clearTimeout(this._hbPending.timer);
        this.rtt = Math.round(nowMs() - this._hbPending.sentAt);
        this._hbPending = null;
        this.emit('rtt', this.rtt);
      }
      return;
    }
    const ch = this.channels.get(topic);
    if (ch) ch._onMessage(event, payload, ref);
  }

  /** 채널 객체를 만든다(아직 참가 전). topic은 'realtime:' 접두사 없이 */
  channel(topic, opts) { return new Channel(this, topic, opts); }

  _register(ch) { this.channels.set(ch.fullTopic, ch); }
  _unregister(ch) { if (this.channels.get(ch.fullTopic) === ch) this.channels.delete(ch.fullTopic); }

  close() {
    if (this._closedByUser) return;
    this._closedByUser = true;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
    this._stopHeartbeat();
    if (this._envOff) { this._envOff(); this._envOff = null; }
    const ws = this.ws;
    this.ws = null;
    const pend = [...this.pending.values()];
    this.pending.clear();
    for (const p of pend) p({ status: 'disconnected', response: {} });
    for (const ch of [...this.channels.values()]) ch._onSocketClose(true);
    this.channels.clear();
    if (ws) {
      try { ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null; ws.close(1000, 'bye'); } catch (_) { /* noop */ }
    }
    this._setState('closed');
    this.emit('closed');
  }

  _installEnvHooks() {
    const w = globalThis.window;
    const d = globalThis.document;
    if (!w || typeof w.addEventListener !== 'function') return;
    const onOnline = () => this.reconnectNow();
    const onVis = () => {
      if (!d || d.visibilityState !== 'visible') return;
      if (this.isOpen()) this.heartbeat(); else this.reconnectNow();
    };
    w.addEventListener('online', onOnline);
    if (d && d.addEventListener) d.addEventListener('visibilitychange', onVis);
    this._envOff = () => {
      w.removeEventListener('online', onOnline);
      if (d && d.removeEventListener) d.removeEventListener('visibilitychange', onVis);
    };
  }
}

/** vsn 2.0.0 바이너리 broadcast 대비(현재 vsn 1.0.0에서는 서버가 JSON 문자열만 보냄) */
function decodeBinaryBroadcast(buf) {
  try {
    const view = new DataView(buf);
    const dec = new TextDecoder();
    const topicSize = view.getUint8(1);
    const eventSize = view.getUint8(2);
    let o = 3;
    const topic = dec.decode(buf.slice(o, o + topicSize)); o += topicSize;
    const event = dec.decode(buf.slice(o, o + eventSize)); o += eventSize;
    const payload = JSON.parse(dec.decode(buf.slice(o)));
    return { ref: null, topic, event, payload };
  } catch (_) { return null; }
}

/* ---------------- 채널 ---------------- */

/**
 * socket.channel(topic, { presence?, presenceKey?, self?, ack?, presenceMax?, presenceWindowMs? })
 * 이벤트: 'joined'({rejoin}), 'join_error'(reason), 'interrupted'(why), 'left'
 *         'broadcast'(event, payload), 'presence'(PresenceState, {joins, leaves, sync}), 'system'(payload)
 */
export class Channel extends Emitter {
  constructor(socket, topic, opts = {}) {
    super();
    this.socket = socket;
    this.topic = topic;
    this.fullTopic = 'realtime:' + topic;
    this.opts = { presence: false, presenceKey: '', self: false, ack: false, ...opts };
    this.state = 'closed';  // closed | joining | joined | errored | leaving
    this.want = false;
    this.joinRef = null;
    this.joinedOnce = false;
    this.lastError = null;
    this.presence = new PresenceState();
    this.presenceSynced = false;
    this._pendingDiffs = [];
    this._rejoinAttempt = 0;
    this._rejoinTimer = null;
    // presence track: 서버 한도(30초 5회) 아래로 — 31초 4회, 최소 간격 250ms
    this._limiter = new SlidingWindowLimiter(opts.presenceMax || 4, opts.presenceWindowMs || 31000, 250);
    this._trackPayload = undefined; // undefined: 관여 안 함, null: untrack 원함, object: track 원함
    this._sentJson = null;           // 서버에 반영된 마지막 상태(JSON) — 'null'이면 untracked
    this._trackTimer = null;
    this._trackBusy = false;
    this._trackWaiters = [];
    this._joinWaiters = new Set();
  }

  /** 참가. 첫 성공 시 resolve. 실패해도 leave() 전까지 백오프로 계속 재시도한다 */
  join({ timeoutMs = 15000 } = {}) {
    this.want = true;
    this.socket._register(this);
    if (this.state === 'joined') return Promise.resolve();
    const p = new Promise((resolve, reject) => {
      const w = { resolve, reject, timer: null };
      w.timer = setTimeout(() => this._settleJoin(w, netError('JOIN_TIMEOUT', '채널 참가 시간 초과: ' + this.topic)), timeoutMs);
      this._joinWaiters.add(w);
    });
    if (this.socket.isOpen() && this.state !== 'joining') this._sendJoin();
    return p;
  }

  /** 참가 대기 Promise 정리. err 없으면 resolve. w 없으면 전부 */
  _settleJoin(w, err) {
    const list = w ? [w] : [...this._joinWaiters];
    for (const x of list) {
      if (!this._joinWaiters.delete(x)) continue;
      clearTimeout(x.timer);
      if (err) x.reject(err); else x.resolve();
    }
  }

  async _sendJoin() {
    clearTimeout(this._rejoinTimer);
    this._rejoinTimer = null;
    if (!this.want || !this.socket.isOpen()) return;
    this.state = 'joining';
    const ref = this.socket.makeRef();
    this.joinRef = ref;
    this.presenceSynced = false;
    this._pendingDiffs = [];
    const config = {
      broadcast: { self: !!this.opts.self, ack: !!this.opts.ack },
      presence: { key: String(this.opts.presenceKey || ''), enabled: !!this.opts.presence },
      postgres_changes: [],
      private: false
    };
    const res = await this.socket.request({ topic: this.fullTopic, event: PHX_JOIN, payload: { config }, ref, join_ref: ref });
    if (ref !== this.joinRef || !this.want) return; // 그 사이 다른 참가 시도/퇴장
    if (res.status === 'ok') {
      this.state = 'joined';
      this._rejoinAttempt = 0;
      this.lastError = null;
      // 새 채널 프로세스 → 서버의 presence 호출 카운터도 새로 시작
      this._limiter.reset();
      this._sentJson = 'null';
      const rejoin = this.joinedOnce;
      this.joinedOnce = true;
      this._settleJoin(null);
      this.emit('joined', { rejoin });
      if (this._trackPayload) this._scheduleTrack();
    } else if (res.status === 'disconnected') {
      // 소켓이 다시 열리면 _onSocketOpen에서 재시도
      this.state = 'errored';
    } else {
      this.state = 'errored';
      const reason = (res.response && (res.response.reason || res.response.message)) || res.status;
      this.lastError = reason;
      this._settleJoin(null, netError('JOIN_ERROR', '채널 참가 실패: ' + reason, { reason }));
      this.emit('join_error', reason);
      this._scheduleRejoin();
    }
  }

  _scheduleRejoin() {
    if (!this.want) return;
    clearTimeout(this._rejoinTimer);
    const d = backoffDelay(this._rejoinAttempt++, { base: 1000, max: 30000, factor: 2, jitter: 0.25 });
    this._rejoinTimer = setTimeout(() => {
      this._rejoinTimer = null;
      if (this.want && this.socket.isOpen() && this.state !== 'joined' && this.state !== 'joining') this._sendJoin();
    }, d);
  }

  _onSocketOpen() { if (this.want && this.state !== 'joined' && this.state !== 'joining') this._sendJoin(); }

  _onSocketClose(final = false) {
    clearTimeout(this._rejoinTimer);
    this._rejoinTimer = null;
    clearTimeout(this._trackTimer);
    this._trackTimer = null;
    const was = this.state;
    this.joinRef = null;
    this.presenceSynced = false;
    if (final) {
      this.want = false;
      this.state = 'closed';
      this._flushWaiters('disconnected');
      this._settleJoin(null, netError('CLOSED', '연결이 닫혔습니다'));
      return;
    }
    if (this.want) {
      this.state = 'errored';
      if (was === 'joined' || was === 'joining') this.emit('interrupted', 'socket');
    } else {
      this.state = 'closed';
    }
  }

  _onMessage(event, payload, ref) {
    switch (event) {
      case PHX_REPLY:
        return;
      case PHX_CLOSE:
      case PHX_ERROR:
        if (ref != null && this.joinRef != null && ref !== this.joinRef) return; // 이전 참가의 잔여 메시지
        this._serverClosed(event);
        return;
      case 'presence_state':
        this._onPresenceState(payload);
        return;
      case 'presence_diff':
        this._onPresenceDiff(payload);
        return;
      case 'broadcast':
        this.socket.stats.broadcastsIn++;
        if (payload && typeof payload.event === 'string') this.emit('broadcast', payload.event, payload.payload);
        return;
      case 'system':
        if (payload && payload.status === 'error') {
          this.lastError = payload.message || 'system error';
          this.socket.log('system error on', this.topic, this.lastError);
        }
        this.emit('system', payload);
        return;
      default:
        this.emit('message', event, payload);
    }
  }

  _serverClosed(why) {
    clearTimeout(this._trackTimer);
    this._trackTimer = null;
    this.joinRef = null;
    this.presenceSynced = false;
    if (!this.want) { this.state = 'closed'; return; }
    this.state = 'errored';
    this.emit('interrupted', this.lastError || why);
    this._scheduleRejoin();
  }

  _onPresenceState(raw) {
    const r = this.presence.syncState(raw);
    const pending = this._pendingDiffs;
    this._pendingDiffs = [];
    for (const d of pending) {
      const x = this.presence.syncDiff(d);
      Object.assign(r.joins, x.joins);
      Object.assign(r.leaves, x.leaves);
    }
    this.presenceSynced = true;
    this.emit('presence', this.presence, { ...r, sync: true });
  }

  _onPresenceDiff(diff) {
    if (!this.presenceSynced) { this._pendingDiffs.push(diff); return; }
    const r = this.presence.syncDiff(diff);
    this.emit('presence', this.presence, { ...r, sync: false });
  }

  /** broadcast 송신(응답 없음). 참가 상태가 아니면 false */
  send(event, payload) {
    if (this.state !== 'joined') return false;
    return this.sendJson(event, JSON.stringify(payload === undefined ? null : payload));
  }

  /** 이미 직렬화한 payload JSON으로 broadcast (재직렬화 없이 크기 검사용) */
  sendJson(event, payloadJson) {
    if (this.state !== 'joined' || !this.socket.isOpen()) return false;
    const ref = this.socket.makeRef();
    const str = '{"topic":' + JSON.stringify(this.fullTopic) + ',"event":"broadcast","payload":{"type":"broadcast","event":' +
      JSON.stringify(event) + ',"payload":' + payloadJson + '},"ref":"' + ref + '","join_ref":"' + this.joinRef + '"}';
    const ok = this.socket.sendRaw(str);
    if (ok) this.socket.stats.broadcastsOut++;
    return ok;
  }

  /**
   * presence track. 서버 한도를 넘지 않도록 지연·병합한다(마지막 값만 전송).
   * 참가 전/재연결 중이면 참가 직후 자동 전송. → Promise<'ok'|'error'|'timeout'|'disconnected'>
   */
  track(payload) {
    this._trackPayload = payload && typeof payload === 'object' ? { ...payload } : {};
    return this._wantPresence();
  }

  untrack() {
    this._trackPayload = null;
    return this._wantPresence();
  }

  _wantPresence() {
    const p = new Promise((resolve) => this._trackWaiters.push(resolve));
    this._scheduleTrack();
    return p;
  }

  _desiredJson() {
    if (this._trackPayload === undefined) return this._sentJson;
    return this._trackPayload === null ? 'null' : JSON.stringify(this._trackPayload);
  }

  _scheduleTrack(minDelay = 0) {
    if (this._trackTimer || this._trackBusy) return;
    if (this.state !== 'joined') return; // 참가하면 다시 호출됨
    if (this._desiredJson() === this._sentJson) { this._flushWaiters('ok'); return; }
    const wait = Math.max(minDelay, this._limiter.waitMs());
    this._trackTimer = setTimeout(() => { this._trackTimer = null; this._doTrack(); }, wait);
  }

  async _doTrack() {
    if (this.state !== 'joined') return;
    const json = this._desiredJson();
    if (json === this._sentJson) { this._flushWaiters('ok'); return; }
    if (this._limiter.waitMs() > 0) { this._scheduleTrack(); return; }
    this._limiter.record();
    this._trackBusy = true;
    const joinRef = this.joinRef;
    const isUntrack = json === 'null';
    const payload = isUntrack ? { type: 'presence', event: 'untrack' } : { type: 'presence', event: 'track', payload: JSON.parse(json) };
    this.socket.stats.presenceCalls++;
    const res = await this.socket.request({ topic: this.fullTopic, event: 'presence', payload, join_ref: joinRef });
    this._trackBusy = false;
    if (joinRef !== this.joinRef) return; // 그 사이 재참가 → 참가 시 다시 track
    if (res.status === 'ok') this._sentJson = json;
    this._flushWaiters(res.status);
    if (this._desiredJson() !== this._sentJson) {
      // 실패했거나 비행 중 값이 바뀜 → 한도 안에서 다시
      this._scheduleTrack(res.status === 'ok' ? 0 : 2000);
    }
  }

  _flushWaiters(status) {
    const ws = this._trackWaiters;
    this._trackWaiters = [];
    for (const w of ws) w(status);
  }

  /** 퇴장. 서버 응답을 기다리되 timeoutMs 후에는 그냥 닫는다 */
  async leave(timeoutMs = 3000) {
    const wasActive = this.state === 'joined' || this.state === 'joining';
    this.want = false;
    clearTimeout(this._rejoinTimer);
    this._rejoinTimer = null;
    clearTimeout(this._trackTimer);
    this._trackTimer = null;
    if (wasActive && this.socket.isOpen() && this.joinRef) {
      this.state = 'leaving';
      await this.socket.request({ topic: this.fullTopic, event: PHX_LEAVE, payload: {}, join_ref: this.joinRef }, timeoutMs);
    }
    this.state = 'closed';
    this.joinRef = null;
    this.presence.clear();
    this.presenceSynced = false;
    this._flushWaiters('disconnected');
    this._settleJoin(null, netError('CLOSED', '채널에서 나갔습니다'));
    this.socket._unregister(this);
    this.emit('left');
    this.removeAll();
  }
}
