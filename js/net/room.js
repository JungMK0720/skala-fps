/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 방. Broadcast와 Presence 채널로 메시지, 접속자, 방장 이전을 관리한다.
 */
/*
 * js/net/room.js — 방 (Broadcast + Presence 채널 'skalafps:room:<roomId>')
 *
 * 전송
 *  - send/sendTo는 바로 보내지 않고 큐에 넣는다. 클라이언트당 초당 프레임 수(rate)를 토큰 버킷으로 제한하고,
 *    한 프레임에 큐 전체를 묶어 보낸다(같은 JS 턴의 send는 자동으로 한 프레임).
 *    { merge: true }인 이벤트는 다음 프레임 전까지 마지막 값만 남긴다(상태 동기화용).
 *  - 프레임: broadcast event 'f', payload { f: 보낸이, t: 방 시계(ms), m: [[event, payload, to?], ...], r?: 중계 }
 *  - mesh : 모두가 방 채널로 프레임을 보낸다. 1프레임 = 1 + (N-1) 이벤트
 *    relay: 비방장은 자기 uplink 채널('skalafps:room:<id>:u:<playerId>')로 방장에게만 보내고,
 *           방장이 모아서 방 채널로 한 번에 다시 보낸다. 1틱 = 3N-2 이벤트 (N≥4에서 mesh보다 싸다)
 *  - rate는 방장이 정한다: 예산(기본 80 msg/s) ÷ (진행 중인 모든 방의 1틱 비용 합) → meta.hz
 *
 * 방장
 *  - 선출: presence에서 joinedAt이 가장 이른 사람(같으면 id 사전순). 방장은 유지되고(sticky),
 *    방장이 나가면(_bye 즉시 / presence 이탈 후 4초 유예 / 침묵) 남은 사람 중 가장 이른 사람이 term+1로 이어받는다.
 *  - 방장은 '_meta'(메타·term·명단)를 알리고 로비 presence에 방 메타를 track한다.
 *  - 충돌 시 term이 큰 쪽, 같으면 확정된 쪽 → joinedAt 이른 쪽이 이긴다.
 *
 * 내부 이벤트(앞에 '_', 사용자 이벤트로는 금지)
 *  _hello 새로 온 사람 → 방장이 _meta로 응답 / _meta 방장 공지 / _pi 방장 핑(+전원 RTT표) / _po 퐁
 *  _me presence 즉시 패치 / _bye 퇴장 / _kick 강퇴(정원 초과) / _ka 방장 keepalive / _upok uplink 구독 확인
 *
 * 시계: NTP 방식. 퐁에 보낸 시각 t0(내 시계)을 싣고, 방장은 받은 시각 t1과 함께 다음 핑(t2)에 돌려준다.
 *   내가 핑을 받은 시각 t3 → offset = ((t1-t0) + (t2-t3)) / 2, delay = (t3-t0) - (t2-t1)
 *   최근 8개 중 delay가 가장 작은 표본을 쓴다(오차 ≤ delay/2).
 */
import { Emitter, netError, randomId, sanitizeName } from './realtime.js';
import { TokenBucket, frameCost, autoTopology, clampHz, DEFAULT_BUDGET } from './limits.js';

export const ROOM_TOPIC_PREFIX = 'skalafps:room:';

export const ROOM_DEFAULTS = Object.freeze({
  budget: DEFAULT_BUDGET,   // 프로젝트 전체 broadcast 예산(msg/s). 무료 한도 100의 80%
  maxHz: 20,                // 클라이언트당 프레임 상한
  minHz: 1,
  burst: 3,                 // 토큰 버킷 비축량(순간 연속 전송 허용 수)
  topology: 'auto',         // 'auto' | 'mesh' | 'relay'
  relayMinPlayers: 4,       // auto일 때 이 인원 이상이면 relay
  hostGraceMs: 3000,        // 방장이 presence에서 사라진 뒤 재접속을 기다리는 시간
  silenceMs: 8000,          // 경기 중 방장 침묵 → 방장 교체
  silenceWaitingMs: 32000,  // 대기 중 방장 침묵 → 방장 교체 (방장 핑 10초 간격의 3배)
  confirmMs: 5000,          // 선출된 사람이 이 시간 안에 응답이 없으면 제외하고 재선출
  keepaliveMs: 2500,        // 경기 중 방장이 아무것도 안 보냈으면 _ka
  pingWaitingMs: 10000,     // 대기 중 방장 핑 간격(프레임 비용 있음)
  pingPlayingMs: 4000,      // 경기 중 핑 간격(상태 프레임에 얹혀 가므로 사실상 공짜)
  helloTimeoutMs: 3000,     // 참가 시 방장 응답 대기
  queueTtlMs: 10000,        // 연결이 끊긴 동안 쌓인 메시지 보존 시간
  queueMax: 300,
  pingPresenceMinMs: 60000, // presence의 ping 값 갱신 최소 간격(실시간 값은 players()가 방장 RTT표로 제공)
  pingPresenceDelta: 30     // ping이 이만큼(ms) 바뀌어야 presence 갱신
});

const RESERVED_ME = new Set(['id', 'joinedAt', 'v', 'presence_ref']);
const META_LOCKED = new Set(['roomId', 'hostId', 'term', 'net', 'hz']);
const MAX_FRAME_CHARS = 80000; // 256KB 한도 대비 여유 (UTF-8 3바이트 문자 가정)
const ROOM_ID_RE = /^[a-z0-9_-]{1,40}$/i;
const EVENT_RE = /^[^_][\s\S]{0,63}$/;

const nowMs = () => (globalThis.performance && performance.now ? performance.now() : Date.now());

let warnedKeys = false;

export class Room extends Emitter {
  /* ---------- 생성 / 참가 ---------- */

  static async create(net, opts = {}) {
    const { name, mapId = 'jetty', max = 8, topology, ...extra } = opts || {};
    const room = new Room(net, randomId(8), topology ? { topology } : {});
    const meta = room._meta;
    meta.name = sanitizeName(name, 32) || (net.me.name + '의 방');
    meta.mapId = sanitizeName(mapId, 32) || 'jetty';
    meta.max = Math.max(2, Math.min(16, max | 0 || 8));
    meta.topo = room.opt.topology;
    for (const [k, v] of Object.entries(extra)) if (!META_LOCKED.has(k) && v !== undefined) meta[k] = v;
    room._hostId = net.me.id;
    room._term = 1;
    room._hostConfirmed = true;
    try {
      await room.ch.join();
      room._my.joinedAt = Date.now();
      room._tracked = true;
      await room._trackMeWait(8000);
      room._markReady();
      room._recomputeGovernor(false);
      room._updateLobby();
      return room;
    } catch (e) {
      await room._abort();
      throw e;
    }
  }

  static async join(net, roomId, opts = {}) {
    if (!ROOM_ID_RE.test(String(roomId || ''))) throw netError('BAD_ROOM_ID', '잘못된 방 ID입니다');
    const room = new Room(net, String(roomId), opts);
    const hint = net.lobby.rooms().find((r) => r.roomId === roomId);
    if (hint) {
      Object.assign(room._meta, { name: hint.name, mapId: hint.mapId, max: hint.max, status: hint.status });
      room._hostId = hint.hostId || null;
    }
    try {
      await room.ch.join();
      // 방장에게 메타 요청. presence는 참가 직후 비어 있다가 diff로 늦게 채워질 수 있다(노드 간 동기화)
      const got = room._waitMeta(room.opt.helloTimeoutMs);
      room._helloAt = Date.now();
      room._push('_hello', 1, null, true);
      room._schedule();
      const ok = await got;
      if (!ok) {
        await room._waitPresence(1500);
        const ids = room._presenceIds();
        if (!ids.length) throw netError('ROOM_NOT_FOUND', '방을 찾을 수 없습니다');
        if (!room._hostId || !ids.includes(room._hostId)) room._hostId = room._earliest(ids);
        room._term = Math.max(room._term, 1);
      }
      const others = new Set(room._presenceIds());
      for (const [id] of room._roster) others.add(id);
      others.delete(net.me.id);
      if (others.size >= room._meta.max) throw netError('ROOM_FULL', '방이 가득 찼습니다');
      // 기존 인원보다 늦은 joinedAt을 보장(시계가 늦은 PC가 방장을 빼앗지 않도록)
      let maxJ = 0;
      for (const id of others) maxJ = Math.max(maxJ, room._joinedAtOf(id, 0));
      room._my.joinedAt = Math.max(Date.now(), maxJ + 1);
      room._tracked = true;
      await room._trackMeWait(8000);
      room._markReady();
      room._applyRate();
      room._syncUplinks();
      return room;
    } catch (e) {
      await room._abort();
      throw e;
    }
  }

  constructor(net, roomId, opt = {}) {
    super();
    this.net = net;
    this.id = roomId;
    this.opt = { ...ROOM_DEFAULTS, ...((net.opts && net.opts.room) || {}), ...opt };
    this.topic = ROOM_TOPIC_PREFIX + roomId;
    this._meId = net.me.id;
    this._my = { id: net.me.id, name: net.me.name, team: null, ready: false, joinedAt: 0, ping: 0, v: 1 };
    this._meta = { roomId, name: '', mapId: '', max: 8, status: 'waiting', topo: this.opt.topology, net: 'mesh', hz: 0 };
    this._hostId = null;
    this._term = 0;
    this._hostConfirmed = false;
    this._electedAt = 0;
    this._ready = false;
    this._readyAt = 0;
    this._closed = false;
    this._tracked = false;
    this._patches = new Map();   // id -> { v, f }
    this._pingTable = {};        // id -> rtt(ms), 방장이 잰 값
    this._myPing = null;
    this._heard = new Map();     // id -> 마지막 수신 시각(perf ms)
    this._firstSeen = new Map(); // id -> presence 첫 등장
    this._missingSince = new Map(); // id -> presence에서 사라진 시각
    this._bye = new Map();       // id -> _bye 받은 시각
    this._excluded = new Map();  // id -> 선출 제외 만료 시각
    this._kickedAt = new Map();
    this._roster = [];           // 방장이 알려준 [[id, joinedAt], ...]
    this._q = []; this._qIdx = new Map();
    this._rq = []; this._rqIdx = new Map();
    this._bucket = new TokenBucket(this.opt.maxHz, this.opt.burst);
    this._flushTimer = null;
    this._flushQueued = false;
    this._lastSentAt = 0;
    this._lastPingAt = 0;
    this._lastAssertAt = -1e9;
    this._lastPingTrackAt = -1e12; // 첫 측정값은 바로 presence에 반영
    this._helloAt = 0;
    this._offset = 0;
    this._offsetSamples = [];
    this._clk = {};              // (방장) id -> [t0(멤버 송신), t1(방장 수신)]
    this._lastClkT0 = 0;
    this._graceTimer = null;
    this._playersJson = '';
    this._metaWaiters = [];
    this._ups = new Map();
    this._upOwn = null;
    this._upAck = null;          // 내 uplink 구독을 확인해 준 방장 id (_upok)
    this._hostChangedAt = 0;
    this._lastUpSync = 0;
    this.stats = { framesOut: 0, framesIn: 0, msgsOut: 0, msgsIn: 0, merged: 0, dropped: 0 };

    this.ch = net.socket.channel(this.topic, { presence: true, presenceKey: this._meId });
    this._offs = [
      this.ch.on('broadcast', (ev, p) => { if (ev === 'f') this._onFrame(p); }),
      this.ch.on('presence', (_s, diff) => this._onPresence(diff)),
      this.ch.on('joined', (info) => this._onJoined(info)),
      this.ch.on('interrupted', (why) => { if (this._ready && !this._closed) this.emit('connection', { state: 'reconnecting', reason: why }); }),
      net.lobby.on('rooms', () => { if (this._ready && this.isHost()) this._recomputeGovernor(true); })
    ];
    this._tickTimer = setInterval(() => this._onTick(), 1000);
  }

  /* ---------- 공개 API ---------- */

  /** 내 플레이어 정보 { id, name, team, ready, joinedAt, ping, isHost, ... } */
  get me() { return this._view({ ...this._my }); }

  /** 방 메타 사본 { roomId, name, mapId, max, status, hostId, term, net, hz, ... } */
  get meta() { return { ...this._meta, hostId: this._hostId, term: this._term }; }

  /** 현재 클라이언트 프레임 상한(초당) */
  get rate() { return this._bucket.rate; }

  get closed() { return this._closed; }

  isHost() { return this._hostId === this._meId; }
  hostId() { return this._hostId; }

  /** 방 시계(ms) — 방장 Date.now() 기준으로 맞춘 값. 라운드 타이머 등에 사용 */
  now() { return Date.now() + (this.isHost() ? 0 : this._offset); }

  /** presence 목록 [{ id, name, team, ready, joinedAt, ping, isHost, ... }] (joinedAt 순) */
  players() { return this._computePlayers(); }

  /** 방 전체에 보내기. opts.merge=true면 다음 프레임 전까지 마지막 값만 남김 → true(큐 적재) */
  send(event, payload, opts) {
    this._checkEvent(event);
    if (this._closed) return false;
    this._push(event, payload, null, !!(opts && opts.merge));
    this._schedule();
    return true;
  }

  /** 특정 플레이어에게(간이 귓속말: 모두에게 가지만 받는 쪽에서 거른다. relay에서는 방장만 거침) */
  sendTo(playerId, event, payload, opts) {
    this._checkEvent(event);
    if (this._closed) return false;
    const to = String(playerId || '');
    if (!to) throw new TypeError('sendTo: playerId 필요');
    if (to === this._meId) {
      // 자기 자신: 다음 틱에 로컬 전달
      queueMicrotask(() => { if (!this._closed) this.emit('message', { from: this._meId, event, payload, to, t: Math.round(this.now()), fromHost: this.isHost() }); });
      return true;
    }
    this._push(event, payload, to, !!(opts && opts.merge));
    this._schedule();
    return true;
  }

  /** 이벤트 하나만 구독: fn(payload, message) → off */
  handle(event, fn) {
    return this.on('message', (m) => { if (m.event === event) fn(m.payload, m); });
  }

  /** 내 presence 갱신(team, ready 등). 다른 사람에게는 즉시 패치 + presence(한도 내 병합) */
  updateMe(fields) {
    if (this._closed || !fields || typeof fields !== 'object') return false;
    const patch = {};
    for (const [k, v] of Object.entries(fields)) {
      if (RESERVED_ME.has(k) || v === undefined) continue;
      patch[k] = k === 'name' ? sanitizeName(v) : v;
    }
    if (!Object.keys(patch).length) return true;
    Object.assign(this._my, patch);
    if (!warnedKeys && Object.keys(this._my).length > 10) {
      warnedKeys = true;
      console.warn('[net] presence 필드가 10개를 넘습니다(Supabase presence keys per object 10).');
    }
    this._my.v++;
    if (this._tracked) {
      this._trackMe();
      const k = '_me\u0000';
      const idx = this._qIdx.get(k);
      if (idx != null) {
        const e = this._q[idx];
        Object.assign(e.payload, patch, { v: this._my.v });
        e.at = nowMs();
      } else {
        this._push('_me', { ...patch, v: this._my.v }, null, true);
      }
      this._schedule();
    }
    this._refreshPlayers();
    return true;
  }

  /** 방 메타 갱신(방장만) → 방 전체 + 로비 목록에 반영. 방장이 아니면 false */
  updateMeta(fields) {
    if (this._closed || !this.isHost() || !fields || typeof fields !== 'object') return false;
    let changed = false;
    for (const [k, v] of Object.entries(fields)) {
      if (META_LOCKED.has(k) || v === undefined) continue;
      let val = v;
      if (k === 'name' || k === 'mapId') val = sanitizeName(v, 32);
      if (k === 'max') val = Math.max(2, Math.min(16, v | 0 || 8));
      if (k === 'status') val = v === 'playing' ? 'playing' : 'waiting';
      if (k === 'topo') val = ['mesh', 'relay', 'auto'].includes(v) ? v : 'auto';
      if (JSON.stringify(this._meta[k]) !== JSON.stringify(val)) { this._meta[k] = val; changed = true; }
    }
    if (!changed) return true;
    this._recomputeGovernor(false);
    this._sendMeta();
    this._updateLobby();
    this.emit('meta', this.meta);
    return true;
  }

  /** ARCHITECTURE 8절 규칙용 별칭 = leave() */
  dispose() { return this.leave('disposed'); }

  /** 방 나가기 */
  async leave(reason = 'left') {
    if (this._closed) return;
    const wasHost = this.isHost();
    // 남은 큐 + _bye를 한 프레임으로 즉시 송신(동기) — 페이지 종료 직전에도 나가도록
    try {
      if (this.ch.state === 'joined') {
        const m = [];
        for (const e of this._q) if (!e.fin) m.push(e.to ? [e.event, e.payload, e.to] : [e.event, e.payload]);
        m.push(['_bye', 0]);
        this.ch.sendJson('f', JSON.stringify({ f: this._meId, t: Math.round(this.now()), m }));
      }
    } catch (_) { /* noop */ }
    this._dispose();
    if (wasHost) this.net.lobby._clearHosted(this);
    const chans = [this.ch, this._upOwn, ...this._ups.values()].filter(Boolean);
    this._upOwn = null;
    this._ups.clear();
    await Promise.allSettled(chans.map((c) => c.leave(2000)));
    this.emit('closed', { reason });
    this.removeAll();
  }

  /* ---------- 큐 / 프레임 ---------- */

  _checkEvent(event) {
    if (typeof event !== 'string' || !EVENT_RE.test(event)) {
      throw new TypeError('event는 1~64자 문자열이며 "_"로 시작할 수 없습니다: ' + event);
    }
  }

  _push(event, payload, to, merge, fin) {
    const at = nowMs();
    if (merge) {
      const key = event + '\u0000' + (to || '');
      const idx = this._qIdx.get(key);
      if (idx != null) {
        const e = this._q[idx];
        e.payload = payload;
        e.at = at;
        e.fin = fin;
        this.stats.merged++;
        return;
      }
      this._qIdx.set(key, this._q.length);
    }
    this._q.push({ event, payload, to, merge, fin, at });
    if (this._q.length > this.opt.queueMax) {
      const i = this._q.findIndex((e) => !e.merge);
      this._q.splice(i >= 0 ? i : 0, 1);
      this.stats.dropped++;
      this._reindex();
    }
  }

  _reindex() {
    this._qIdx.clear();
    this._q.forEach((e, i) => { if (e.merge) this._qIdx.set(e.event + '\u0000' + (e.to || ''), i); });
  }

  _schedule() {
    if (this._closed || this._flushTimer || this._flushQueued) return;
    if (!this._q.length && !this._rq.length) return;
    const wait = this._bucket.waitMs();
    if (wait <= 0) {
      this._flushQueued = true;
      queueMicrotask(() => { this._flushQueued = false; this._flush(); });
    } else {
      this._flushTimer = setTimeout(() => { this._flushTimer = null; this._flush(); }, wait);
    }
  }

  _useUplink() {
    // 현재 방장이 내 uplink를 구독했다고 확인(_upok)해 준 뒤에만 uplink로 보낸다. 그 전에는 방 채널(mesh)
    return this._meta.net === 'relay' && !this.isHost() && !!this._upOwn && this._upOwn.state === 'joined' &&
      this._upAck === this._hostId;
  }

  _flush() {
    if (this._closed || (!this._q.length && !this._rq.length)) return;
    const viaUp = this._useUplink();
    const ch = viaUp ? this._upOwn : this.ch;
    if (!ch || ch.state !== 'joined') return; // 참가되면 _onJoined → _schedule
    if (!this._bucket.take()) { this._schedule(); return; }
    const t0 = nowMs();
    const cutoff = t0 - this.opt.queueTtlMs;
    const m = [];
    for (const e of this._q) {
      if (e.at < cutoff) { this.stats.dropped++; continue; }
      const payload = e.fin ? e.fin(e.payload, t0) : e.payload;
      const tuple = [e.event, payload === undefined ? null : payload];
      if (e.to || (viaUp && e.merge)) tuple.push(e.to || 0);
      if (viaUp && e.merge) tuple.push(1);
      m.push(tuple);
    }
    this._q = [];
    this._qIdx.clear();
    const frame = { f: this._meId, t: Math.round(this.now()), m };
    if (!viaUp && this._rq.length) frame.r = this._packRelay();
    if (!m.length && !frame.r) return;
    this._sendFrame(ch, viaUp ? 'u' : 'f', frame);
  }

  _sendFrame(ch, ev, frame) {
    const json = JSON.stringify(frame);
    if (json.length <= MAX_FRAME_CHARS || frame.m.length + (frame.r ? frame.r.length : 0) <= 1) {
      if (json.length > MAX_FRAME_CHARS) console.warn('[net] 프레임이 너무 큽니다(' + json.length + '자) — 서버가 거부할 수 있음');
      if (ch.sendJson(ev, json)) {
        this._lastSentAt = nowMs();
        this.stats.framesOut++;
        this.stats.msgsOut += frame.m.length;
      }
      return;
    }
    // 드문 경우: 큰 묶음은 반으로 나눠 보낸다
    if (frame.r && frame.r.length) {
      const { r, ...rest } = frame;
      this._sendFrame(ch, ev, { ...rest });
      const half = Math.ceil(r.length / 2);
      this._sendFrame(ch, ev, { f: frame.f, t: frame.t, m: [], r: r.slice(0, half) });
      if (r.length > half) this._sendFrame(ch, ev, { f: frame.f, t: frame.t, m: [], r: r.slice(half) });
      return;
    }
    const half = Math.ceil(frame.m.length / 2);
    this._sendFrame(ch, ev, { f: frame.f, t: frame.t, m: frame.m.slice(0, half) });
    this._sendFrame(ch, ev, { f: frame.f, t: frame.t, m: frame.m.slice(half) });
  }

  _relayPush(from, t, ev, payload, to, merge) {
    if (merge) {
      const key = from + '\u0000' + ev + '\u0000' + (to || '');
      const idx = this._rqIdx.get(key);
      if (idx != null) { const e = this._rq[idx]; e.payload = payload; e.t = t; return; }
      this._rqIdx.set(key, this._rq.length);
    }
    this._rq.push({ from, t, ev, payload, to });
    if (this._rq.length > this.opt.queueMax * 2) {
      this._rq.shift();
      this.stats.dropped++;
      this._rqIdx.clear();
      this._rq.forEach((e, i) => this._rqIdx.set(e.from + '\u0000' + e.ev + '\u0000' + (e.to || ''), i));
    }
  }

  _packRelay() {
    const groups = new Map();
    for (const e of this._rq) {
      let g = groups.get(e.from);
      if (!g) groups.set(e.from, (g = [e.from, e.t, []]));
      if (e.t > g[1]) g[1] = e.t;
      const tuple = [e.ev, e.payload === undefined ? null : e.payload];
      if (e.to) tuple.push(e.to);
      g[2].push(tuple);
    }
    this._rq = [];
    this._rqIdx.clear();
    return [...groups.values()];
  }

  _onFrame(p) {
    if (this._closed || !p || typeof p !== 'object') return;
    const from = typeof p.f === 'string' ? p.f : null;
    if (!from || from === this._meId) return;
    const now = nowMs();
    const isNew = !this._heard.has(from);
    this._heard.set(from, now);
    this.stats.framesIn++;
    if (this._ready && this.isHost() && this._meta.net === 'relay' && !this._ups.has(from) && (isNew || !this._bye.has(from))) {
      this._syncUplinks(); // presence보다 먼저 들은 멤버의 uplink에 바로 참가
    }
    const t = +p.t || 0;
    if (Array.isArray(p.m)) for (const m of p.m) this._deliver(from, m, t);
    if (Array.isArray(p.r)) {
      for (const g of p.r) {
        if (!Array.isArray(g)) continue;
        const rf = g[0], rt = +g[1] || t, msgs = g[2];
        if (typeof rf !== 'string' || rf === this._meId || !Array.isArray(msgs)) continue;
        this._heard.set(rf, now);
        for (const m of msgs) this._deliver(rf, m, rt);
      }
    }
  }

  /** (방장, relay) uplink 프레임 수신 → 내게 온 것은 처리, 나머지는 중계 큐로 */
  _onUplink(memberId, p) {
    if (this._closed || !this.isHost() || !p || p.f !== memberId || !Array.isArray(p.m)) return;
    this._heard.set(memberId, nowMs());
    this.stats.framesIn++;
    const t = +p.t || 0;
    for (const m of p.m) {
      if (!Array.isArray(m) || typeof m[0] !== 'string') continue;
      const to = m[2] || null;
      if (!to || to === this._meId) this._deliver(memberId, m, t);
      if (to !== this._meId) this._relayPush(memberId, t, m[0], m[1], to, m[3] === 1);
    }
    this._schedule();
  }

  _deliver(from, m, t) {
    if (!Array.isArray(m)) return;
    const ev = m[0];
    if (typeof ev !== 'string' || !ev) return;
    const to = m[2] || null;
    if (to && to !== this._meId) return;
    this.stats.msgsIn++;
    if (ev.charCodeAt(0) === 95 /* _ */) { this._internal(from, ev, m[1], t); return; }
    this.emit('message', { from, event: ev, payload: m[1], to, t, fromHost: from === this._hostId });
  }

  /* ---------- 내부 이벤트 ---------- */

  _internal(from, ev, p, t) {
    switch (ev) {
      case '_hello':
        this._bye.delete(from);
        if (this._ready && this.isHost()) this._sendMeta();
        break;
      case '_meta':
        this._onClaim(from, p, true);
        break;
      case '_pi':
        this._onClaim(from, p, false);
        if (from === this._hostId) this._onPing(from, p);
        break;
      case '_po':
        if (this.isHost()) this._onPong(from, p);
        break;
      case '_me':
        this._onPatch(from, p);
        break;
      case '_bye':
        this._onBye(from);
        break;
      case '_upok':
        if (from === this._hostId) { this._upAck = from; this._schedule(); }
        break;
      case '_kick':
        if (from === this._hostId && this._ready) this.leave('kicked:' + String((p && p.reason) || 'host'));
        break;
      default:
        break;
    }
  }

  _onClaim(from, p, full) {
    if (!p || typeof p !== 'object') return;
    const T = Math.max(0, p.term | 0);
    const cur = this._hostId;
    if (full && Array.isArray(p.roster)) this._roster = p.roster.filter((x) => Array.isArray(x) && typeof x[0] === 'string');
    if (from === cur) {
      if (T > this._term) this._term = T;
      this._hostConfirmed = true;
      if (full) this._applyClaimData(p);
      if (full) this._resolveMetaWaiters(true); // 참가 대기는 meta·명단이 있는 _meta로만 끝낸다(_pi 제외)
      return;
    }
    let adopt;
    if (T > this._term) adopt = true;
    else if (T === this._term) adopt = !cur || (!this._hostConfirmed && cur !== this._meId) || this._precedes(from, cur);
    else adopt = false;
    if (!adopt) {
      if (cur === this._meId) this._assert();
      return;
    }
    const wasHost = cur === this._meId;
    this._hostId = from;
    this._term = T;
    this._hostConfirmed = true;
    this._excluded.delete(from);
    if (full) this._applyClaimData(p);
    if (wasHost) this._onLostHost();
    this._emitHost(cur, 'claim');
    if (full) this._resolveMetaWaiters(true);
  }

  _applyClaimData(p) {
    if (p.meta && typeof p.meta === 'object') this._applyMeta(p.meta);
    if (this._helloAt && Number.isFinite(+p.ht)) {
      const rtt = Date.now() - this._helloAt;
      this._helloAt = 0;
      if (rtt >= 0 && rtt < 10000) this._clockSample(+p.ht, rtt);
    }
  }

  _applyMeta(m) {
    const before = JSON.stringify(this._meta);
    for (const [k, v] of Object.entries(m)) {
      if (k === 'roomId' || k === 'hostId' || k === 'term') continue;
      this._meta[k] = v;
    }
    this._meta.roomId = this.id;
    if (JSON.stringify(this._meta) !== before) {
      this._applyRate();
      if (this._ready) this._syncUplinks();
      this.emit('meta', this.meta);
    }
  }

  _onPing(from, p) {
    const table = p.p && typeof p.p === 'object' ? p.p : {};
    const next = {};
    for (const [id, v] of Object.entries(table)) if (Number.isFinite(+v)) next[id] = Math.round(+v);
    this._pingTable = next;
    const mine = next[this._meId];
    if (mine != null) this._myPing = mine;
    const x = p.x && Array.isArray(p.x[this._meId]) ? p.x[this._meId] : null;
    if (x && +x[0] && +x[0] !== this._lastClkT0) {
      this._lastClkT0 = +x[0];
      this._clockNtp(+x[0], +x[1], +p.t, Date.now());
    }
    const recvAt = nowMs();
    const tSent = +p.t;
    // 퐁: 보내는 순간 대기 시간 d를 계산해 방장이 RTT에서 뺀다. s = 내 송신 시각(시계 동기용 t0)
    this._push('_po', { t: tSent }, from, true, () => ({ t: tSent, d: Math.round(nowMs() - recvAt), s: Date.now() }));
    this._schedule();
    this._refreshPlayers();
  }

  _onPong(from, p) {
    if (!p || !Number.isFinite(+p.t)) return;
    const now = Date.now();
    if (Number.isFinite(+p.s)) this._clk[from] = [+p.s, now];
    const rtt = now - +p.t - Math.max(0, +p.d || 0);
    if (rtt >= 0 && rtt < 30000) {
      this._pingTable[from] = Math.round(rtt);
      this._refreshPlayers();
    }
  }

  /** _hello→_meta 한 번의 왕복: 방장 시각 hostT가 왕복 중간이라고 가정 (오차 ≤ rtt/2) */
  _clockSample(hostT, rtt) {
    if (!Number.isFinite(hostT) || !Number.isFinite(rtt)) return;
    this._addClock(hostT + rtt / 2 - Date.now(), rtt);
  }

  _clockNtp(t0, t1, t2, t3) {
    if (![t0, t1, t2, t3].every(Number.isFinite)) return;
    const delay = (t3 - t0) - (t2 - t1);
    if (delay < 0 || delay > 30000) return;
    this._addClock(((t1 - t0) + (t2 - t3)) / 2, delay);
  }

  _addClock(off, delay) {
    this._offsetSamples.push({ off, rtt: delay });
    if (this._offsetSamples.length > 8) this._offsetSamples.shift();
    let best = this._offsetSamples[0];
    for (const s of this._offsetSamples) if (s.rtt < best.rtt) best = s;
    this._offset = Math.round(best.off);
  }

  /** 시계 추정 품질 { offset, delay, samples } — delay/2가 오차 상한 */
  clockInfo() {
    let best = null;
    for (const s of this._offsetSamples) if (!best || s.rtt < best.rtt) best = s;
    return { offset: this.isHost() ? 0 : this._offset, delay: best ? Math.round(best.rtt) : null, samples: this._offsetSamples.length };
  }

  _onPatch(from, p) {
    if (!p || typeof p !== 'object') return;
    const v = p.v | 0;
    const cur = this._patches.get(from);
    if (cur && v <= cur.v) return;
    const f = {};
    for (const [k, val] of Object.entries(p)) if (!RESERVED_ME.has(k)) f[k] = val;
    this._patches.set(from, { v, f: cur ? { ...cur.f, ...f } : f });
    this._refreshPlayers();
  }

  _onBye(from) {
    this._bye.set(from, nowMs());
    this._patches.delete(from);
    delete this._pingTable[from];
    if (this._ready) {
      if (from === this._hostId) this._elect('host-left', from);
      else if (this.isHost()) this._afterMembersChanged();
    }
    this._refreshPlayers();
  }

  /* ---------- presence / 플레이어 ---------- */

  _onPresence(diff) {
    const now = nowMs();
    for (const key of Object.keys((diff && diff.joins) || {})) {
      this._firstSeen.set(key, now);
      this._missingSince.delete(key);
      this._bye.delete(key);
    }
    for (const [id, patch] of this._patches) if (this._presenceV(id) >= patch.v) this._patches.delete(id);
    for (const key of Object.keys((diff && diff.leaves) || {})) {
      if (!this.ch.presence.has(key)) {
        this._missingSince.set(key, now);
        this._patches.delete(key);
        if (!this.isHost()) delete this._pingTable[key];
      }
    }
    if (this._ready && !this._closed) {
      this._checkHostPresence();
      if (this.isHost()) this._afterMembersChanged();
    }
    this._refreshPlayers();
  }

  _presenceIds() {
    return this.ch.presence.keys().filter((k) => !this._bye.has(k) && k !== this._meId);
  }

  _presenceCount() {
    const ids = new Set(this.ch.presence.keys().filter((k) => !this._bye.has(k)));
    if (this._tracked) ids.add(this._meId);
    return ids.size;
  }

  _bestMeta(id) {
    let best = null;
    for (const m of this.ch.presence.get(id)) if (!best || (m.v | 0) >= (best.v | 0)) best = m;
    return best;
  }

  _presenceV(id) { const m = this._bestMeta(id); return m ? m.v | 0 : -1; }

  _joinedAtOf(id, dflt = Infinity) {
    if (id === this._meId) return this._my.joinedAt || dflt;
    const m = this._bestMeta(id);
    if (m && Number.isFinite(+m.joinedAt)) return +m.joinedAt;
    const r = this._roster.find((x) => x[0] === id);
    if (r && Number.isFinite(+r[1])) return +r[1];
    return dflt;
  }

  _precedes(a, b) {
    const ja = this._joinedAtOf(a), jb = this._joinedAtOf(b);
    return ja < jb || (ja === jb && a < b);
  }

  _earliest(ids) {
    let best = null;
    for (const id of ids) if (best === null || this._precedes(id, best)) best = id;
    return best;
  }

  _computePlayers() {
    const out = new Map();
    for (const key of this.ch.presence.keys()) {
      if (this._bye.has(key)) continue;
      const m = this._bestMeta(key);
      if (m) out.set(key, { ...m, id: m.id != null ? String(m.id) : key });
    }
    if (this._tracked && !this._closed) out.set(this._meId, { ...this._my });
    for (const [id, patch] of this._patches) {
      const p = out.get(id);
      if (p && id !== this._meId && patch.v > (p.v | 0)) Object.assign(p, patch.f);
    }
    const list = [...out.values()].map((p) => this._view(p));
    list.sort((a, b) => (a.joinedAt - b.joinedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return list;
  }

  _view(p) {
    const { presence_ref, v, ...rest } = p;
    const id = String(rest.id);
    let ping = this._pingTable[id];
    if (ping == null && id === this._meId && this._myPing != null) ping = this._myPing;
    if (ping == null) ping = rest.ping;
    return {
      ...rest,
      id,
      name: rest.name != null ? String(rest.name) : '',
      team: rest.team != null ? rest.team : null,
      ready: !!rest.ready,
      joinedAt: +rest.joinedAt || 0,
      ping: Math.round(+ping || 0),
      isHost: id === this._hostId
    };
  }

  _refreshPlayers() {
    if (this._closed) return;
    const list = this._computePlayers();
    const json = JSON.stringify(list);
    if (json === this._playersJson) return;
    this._playersJson = json;
    if (this._ready) this.emit('players', list);
  }

  _trackMe() { return this.ch.track({ ...this._my }); }

  _trackMeWait(ms) {
    let timer = null;
    return Promise.race([
      this._trackMe(),
      new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), ms); })
    ]).then((st) => {
      clearTimeout(timer);
      if (st !== 'ok') throw netError('TRACK_FAILED', 'presence 등록 실패: ' + st);
    });
  }

  _waitPresence(minMs) {
    return new Promise((resolve) => {
      const start = nowMs();
      const iv = setInterval(() => {
        const t = nowMs() - start;
        if (this._closed || (this.ch.presenceSynced && (this._presenceIds().length || t >= minMs)) || t >= minMs + 2000) {
          clearInterval(iv);
          resolve();
        }
      }, 100);
    });
  }

  _waitMeta(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._metaWaiters = this._metaWaiters.filter((w) => w !== done);
        resolve(false);
      }, ms);
      const done = (v) => { clearTimeout(timer); resolve(v); };
      this._metaWaiters.push(done);
    });
  }

  _resolveMetaWaiters(v) {
    const ws = this._metaWaiters;
    this._metaWaiters = [];
    for (const w of ws) w(v);
  }

  /* ---------- 방장 ---------- */

  _markReady() {
    this._ready = true;
    this._readyAt = nowMs();
    this._playersJson = '';
    this._refreshPlayers();
    this._checkHostPresence();
  }

  _emitHost(prev, reason) {
    this._refreshPlayers();
    if (prev === this._hostId) return;
    this._hostChangedAt = nowMs();
    // 시계 기준(방장)이 바뀜 → 새 방장 표본으로 다시 맞춘다(그 전까지 이전 offset 유지)
    if (!this.isHost()) { this._offsetSamples = []; this._lastClkT0 = 0; }
    if (this._ready) this._syncUplinks();
    this.emit('host', { hostId: this._hostId, prevHostId: prev, term: this._term, isMe: this.isHost(), reason });
  }

  _checkHostPresence() {
    const h = this._hostId;
    const clear = () => { clearTimeout(this._graceTimer); this._graceTimer = null; };
    if (!h) { clear(); this._elect('no-host'); return; }
    if (h === this._meId) { clear(); return; }
    if (this._bye.has(h)) { clear(); this._elect('host-left', h); return; }
    if (this.ch.presence.has(h)) { clear(); return; }
    if (this._graceTimer) return;
    this._graceTimer = setTimeout(() => {
      this._graceTimer = null;
      if (this._closed || this._hostId !== h || this.ch.presence.has(h)) return;
      const heard = this._heard.get(h) || 0;
      // 방장이 최근에도 말하고 있었다면 presence 반영만 늦은 것 → 다시 기다린다
      if (nowMs() - heard < this.opt.hostGraceMs) { this._checkHostPresence(); return; }
      this._elect('host-left', h);
    }, this.opt.hostGraceMs);
  }

  _isAlive(id, now) {
    if (this._meta.status !== 'playing') return true;
    const last = Math.max(this._heard.get(id) || 0, this._firstSeen.get(id) || 0, this._readyAt);
    return now - last <= this.opt.silenceMs;
  }

  _candidate(now) {
    const ids = new Set(this.ch.presence.keys());
    ids.add(this._meId);
    let best = null;
    for (const id of ids) {
      if (id !== this._meId) {
        if (this._bye.has(id)) continue;
        const ex = this._excluded.get(id);
        if (ex && ex > now) continue;
        if (!this._isAlive(id, now)) continue;
      }
      if (best === null || this._precedes(id, best)) best = id;
    }
    return best;
  }

  _elect(reason, excludeId) {
    if (!this._ready || this._closed) return;
    const now = nowMs();
    if (excludeId && excludeId !== this._meId) this._excluded.set(excludeId, now + 20000);
    const cand = this._candidate(now);
    if (!cand) return;
    const prev = this._hostId;
    const term = this._term + 1;
    if (cand === this._meId) { this._becomeHost(term, reason); return; }
    this._hostId = cand;
    this._term = term;
    this._hostConfirmed = false;
    this._electedAt = now;
    this._emitHost(prev, reason);
  }

  _becomeHost(term, reason) {
    const prev = this._hostId;
    this._hostId = this._meId;
    this._term = term;
    this._hostConfirmed = true;
    this._lastPingAt = 0;
    this._offset = 0;
    this._offsetSamples = [];
    this._clk = {};
    this._recomputeGovernor(false);
    this._sendMeta();
    this._updateLobby();
    this._emitHost(prev, reason);
  }

  _onLostHost() {
    this.net.lobby._clearHosted(this);
    this._rq = [];
    this._rqIdx.clear();
  }

  _assert() {
    const now = nowMs();
    if (now - this._lastAssertAt < 1500) return;
    this._lastAssertAt = now;
    this._sendMeta();
  }

  _sendMeta() {
    if (!this.isHost() || this._closed) return;
    const roster = [];
    for (const id of this.ch.presence.keys()) if (!this._bye.has(id)) roster.push([id, this._joinedAtOf(id, 0)]);
    if (!roster.some((r) => r[0] === this._meId)) roster.push([this._meId, this._my.joinedAt]);
    const base = { hostId: this._meId, term: this._term, meta: { ...this._meta }, roster };
    this._push('_meta', base, null, true, () => ({ ...base, ht: Date.now() }));
    this._schedule();
  }

  _sendPing() {
    const p = {};
    const present = new Set(this.ch.presence.keys());
    for (const [id, v] of Object.entries(this._pingTable)) if (present.has(id)) p[id] = v;
    const own = this.net.socket.rtt;
    if (own != null) { p[this._meId] = Math.round(own); this._myPing = Math.round(own); }
    const x = {};
    for (const [id, v] of Object.entries(this._clk)) if (present.has(id)) x[id] = v;
    this._clk = {};
    const term = this._term;
    this._push('_pi', null, null, true, () => ({ t: Date.now(), term, p, x }));
    this._schedule();
  }

  _updateLobby() {
    if (!this._ready || this._closed || !this.isHost()) return;
    this.net.lobby._setHosted(this, {
      roomId: this.id,
      name: this._meta.name,
      mapId: this._meta.mapId,
      hostId: this._meId,
      hostName: this._my.name,
      players: Math.max(1, this._presenceCount()),
      max: this._meta.max,
      status: this._meta.status,
      term: this._term,
      mode: this._meta.mode === 'ffa' ? 'ffa' : 'team'   // 10번째 키(Supabase presence 한 객체 최대 10키)
    });
  }

  _afterMembersChanged() {
    this._recomputeGovernor(true);
    this._updateLobby();
    this._enforceCapacity();
    this._syncUplinks();
  }

  _enforceCapacity() {
    const list = this._computePlayers();
    const max = this._meta.max;
    if (list.length <= max) return;
    const now = nowMs();
    const extras = list.filter((p) => p.id !== this._meId).slice(-(list.length - max));
    for (const p of extras) {
      if (now - (this._kickedAt.get(p.id) || -1e9) < 5000) continue;
      this._kickedAt.set(p.id, now);
      this._push('_kick', { reason: 'full' }, p.id, true);
    }
    this._schedule();
  }

  _decideTopology(n) {
    const topo = this._meta.topo || this.opt.topology;
    if (topo === 'mesh' || topo === 'relay') return topo;
    return autoTopology(n, this.opt.relayMinPlayers);
  }

  /** (방장) 예산 → hz, 인원 → 토폴로지. 바뀌면 _meta 공지 */
  _recomputeGovernor(announce) {
    if (!this.isHost() || this._closed) return;
    const n = Math.max(1, this._presenceCount());
    const net = this._decideTopology(n);
    let total = frameCost(n, net);
    for (const r of this.net.lobby.rooms()) {
      if (r.roomId !== this.id && r.status === 'playing') total += frameCost(r.players, autoTopology(r.players, this.opt.relayMinPlayers));
    }
    const hz = clampHz(this.opt.budget / total, this.opt.minHz, this.opt.maxHz);
    if (net === this._meta.net && hz === this._meta.hz) return;
    this._meta.net = net;
    this._meta.hz = hz;
    this._applyRate();
    if (this._ready) this._syncUplinks();
    if (announce) { this._sendMeta(); this.emit('meta', this.meta); }
  }

  _applyRate() {
    const n = Math.max(1, this._presenceCount());
    const fallback = clampHz(this.opt.budget / frameCost(n, this._meta.net), this.opt.minHz, this.opt.maxHz);
    const metaHz = +this._meta.hz;
    const hz = Math.min(this.opt.maxHz, metaHz > 0 ? metaHz : fallback);
    if (hz !== this._bucket.rate) this._bucket.setRate(hz);
  }

  /** relay용 uplink 채널 참가/퇴장 */
  _syncUplinks() {
    if (this._closed) return;
    const relay = this._meta.net === 'relay' && this._ready;
    const host = this.isHost();
    if (relay && !host) {
      if (!this._upOwn) {
        const c = this.net.socket.channel(this.topic + ':u:' + this._meId, { presence: false });
        c.on('joined', () => this._schedule());
        this._upOwn = c;
        c.join().catch(() => { /* 백그라운드 재시도 */ });
      }
    } else if (this._upOwn) {
      const c = this._upOwn;
      this._upOwn = null;
      c.leave();
    }
    const want = new Set();
    if (relay && host) {
      const now = nowMs();
      for (const id of this.ch.presence.keys()) if (id !== this._meId && !this._bye.has(id)) want.add(id);
      for (const [id, at] of this._heard) if (id !== this._meId && !this._bye.has(id) && now - at < 15000) want.add(id);
    }
    // 이미 구독 중인 uplink는 늦게 정리한다: 퇴장(_bye)했거나 presence에서 20초 넘게 사라졌을 때만.
    // (재접속 직후 presence가 덜 찬 순간에 나가면 멤버는 이전 _upok를 믿고 보내다가 유실된다)
    const now2 = nowMs();
    for (const [id, c] of this._ups) {
      if (want.has(id)) continue;
      const gone = !relay || !host || this._bye.has(id) ||
        (!this.ch.presence.has(id) && now2 - (this._missingSince.get(id) || 0) > 20000 && now2 - (this._heard.get(id) || 0) > 15000);
      if (gone) { this._ups.delete(id); c.leave(); }
    }
    for (const id of want) {
      if (this._ups.has(id)) continue;
      const c = this.net.socket.channel(this.topic + ':u:' + id, { presence: false });
      c.on('broadcast', (ev, p) => { if (ev === 'u') this._onUplink(id, p); });
      c.on('joined', () => {
        if (this._closed || !this.isHost() || this._ups.get(id) !== c) return;
        this._push('_upok', this._term, id, true); // 멤버에게 "이제 uplink로 보내도 된다"
        this._schedule();
      });
      this._ups.set(id, c);
      c.join().catch(() => { /* 백그라운드 재시도 */ });
    }
  }

  /* ---------- 재연결 / 주기 작업 ---------- */

  _onJoined({ rejoin }) {
    if (this._closed) return;
    if (rejoin && this._ready) {
      this.emit('connection', { state: 'connected' });
      if (this.isHost()) { this._sendMeta(); this._updateLobby(); }
      else { this._helloAt = Date.now(); this._push('_hello', 1, null, true); }
    }
    this._schedule();
  }

  _onTick() {
    if (!this._ready || this._closed) return;
    const now = nowMs();
    const playing = this._meta.status === 'playing';
    for (const [id, at] of this._bye) if (now - at > 15000) this._bye.delete(id);
    for (const [id, until] of this._excluded) if (until <= now) this._excluded.delete(id);
    if (this.isHost()) {
      const every = playing ? this.opt.pingPlayingMs : this.opt.pingWaitingMs;
      if (now - this._lastPingAt >= every && this._presenceIds().length) {
        this._lastPingAt = now;
        this._sendPing();
      }
      if (playing && now - this._lastSentAt >= this.opt.keepaliveMs && this._presenceIds().length) {
        this._push('_ka', 0, null, true);
        this._schedule();
      }
      // relay: 떠난 멤버 uplink 정리(늦은 정리 규칙) — 10초마다
      if (this._meta.net === 'relay' && now - this._lastUpSync > 10000) { this._lastUpSync = now; this._syncUplinks(); }
      // 방장 ping은 소켓 하트비트 RTT
      const own = this.net.socket.rtt;
      if (own != null) this._maybeTrackPing(own, now);
    } else {
      const h = this._hostId;
      if (!h) {
        this._elect('no-host');
      } else {
        const limit = playing ? this.opt.silenceMs : this.opt.silenceWaitingMs;
        const last = Math.max(this._heard.get(h) || 0, this._firstSeen.get(h) || 0, this._electedAt, this._readyAt);
        if (this.ch.state === 'joined' && now - last > limit) {
          this._elect('host-silent', h);
        } else if (!this._hostConfirmed && now - this._electedAt > this.opt.confirmMs && (this._heard.get(h) || 0) < this._electedAt) {
          this._elect('host-unconfirmed', h);
        }
      }
      if (this._myPing != null) this._maybeTrackPing(this._myPing, now);
    }
  }

  _maybeTrackPing(ping, now) {
    if (!this._tracked) return;
    if (Math.abs(ping - (this._my.ping || 0)) < this.opt.pingPresenceDelta) return;
    if (now - this._lastPingTrackAt < this.opt.pingPresenceMinMs) return;
    this._lastPingTrackAt = now;
    this._my.ping = Math.round(ping);
    this._my.v++;
    this._trackMe();
  }

  _dispose() {
    if (this._closed) return;
    this._closed = true;
    clearInterval(this._tickTimer);
    clearTimeout(this._flushTimer);
    clearTimeout(this._graceTimer);
    this._flushTimer = null;
    this._graceTimer = null;
    for (const off of this._offs) off();
    this._offs = [];
    this._resolveMetaWaiters(false);
    this._q = [];
    this._rq = [];
  }

  async _abort() {
    this._dispose();
    this.net.lobby._clearHosted(this);
    const chans = [this.ch, this._upOwn, ...this._ups.values()].filter(Boolean);
    this._upOwn = null;
    this._ups.clear();
    await Promise.allSettled(chans.map((c) => c.leave(2000)));
    this.removeAll();
  }
}
