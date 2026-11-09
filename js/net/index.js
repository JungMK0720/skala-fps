/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 네트워크 진입점. 설정을 읽어 Supabase Realtime 또는 Cloudflare 중계 서버(server/relay)에 연결하고 로비와 방을 만든다.
 */
/*
 * js/net/index.js — 네트워크 진입점
 *
 *   import { connect } from './net/index.js';
 *   const net = await connect({ playerId, name });     // url/key 생략 시 window.SKALA_CONFIG에서 읽음
 *   const off = net.lobby.subscribe((rooms) => render(rooms));
 *   const room = await net.lobby.createRoom({ name: '방 1', mapId: 'alley', max: 6, mode: 'ffa', ruleset: 'knife' });
 *   // 또는 const room = await net.joinRoom(roomId);
 *   room.on('message', ({ from, event, payload }) => ...);
 *   room.send('st', state, { merge: true });
 *   await room.leave(); net.close();
 *
 * 전송 방식(SKALA_CONFIG.transport): 'supabase'(기본, Supabase Realtime) 또는 'relay'(SKALA_CONFIG.relay.url의 중계 서버).
 * 어느 쪽이든 Lobby·Room의 API와 의미는 같다. 자세한 API·한도·설계는 README.md
 */
import { RealtimeSocket, Emitter, netError, randomId, sanitizeName } from './realtime.js';
import { HubSocket } from './hubsocket.js';
import { clampHz } from './limits.js';
import { Lobby } from './lobby.js';
import { Room } from './room.js';

export { RealtimeSocket, Channel, PresenceState, Emitter, backoffDelay, netError, randomId, sanitizeName } from './realtime.js';
export { HubSocket, hubOf, hubEndpoint } from './hubsocket.js';
export { Lobby, LOBBY_TOPIC, packRoomKind, unpackRoomKind, lobbyEntry, readLobbyEntry } from './lobby.js';
export { Room, ROOM_DEFAULTS, ROOM_TOPIC_PREFIX } from './room.js';
export * as codec from './codec.js';
export * as limits from './limits.js';

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
export const TRANSPORTS = Object.freeze(['supabase', 'relay']);

/**
 * 중계 서버에서 쓰는 방 기본값. 서버가 프레임을 받는 사람에게 직접 나눠 주므로 mesh로 충분하고(방장 uplink 중계가 필요 없다),
 * Supabase 프로젝트 전체 예산(limits.js)이 없으므로 예산을 크게 두어 frame 상한(maxHz)이 그대로 rate가 된다.
 */
export const RELAY_ROOM_DEFAULTS = Object.freeze({ topology: 'mesh', budget: 1e6, maxHz: 20 });

function readConfig() {
  const all = globalThis.SKALA_CONFIG || {};
  return {
    supabase: (all.supabase && typeof all.supabase === 'object') ? all.supabase : {},
    transport: typeof all.transport === 'string' ? all.transport : '',
    relay: (all.relay && typeof all.relay === 'object') ? all.relay : {}
  };
}

/**
 * 연결. → Net
 * opts: { url?, key?, transport?, relayUrl?, relayHz?, playerId?, name?, timeoutMs?=15000,
 *         socket?: {heartbeatMs, backoff, logger, WebSocket}, room?: ROOM_DEFAULTS 덮어쓰기 }
 * playerId는 탭마다 고유해야 한다(같은 id로 두 탭이 들어오면 presence가 한 사람으로 합쳐짐).
 */
export async function connect(opts = {}) {
  const cfg = readConfig();
  const transport = String(opts.transport || cfg.transport || 'supabase').trim().toLowerCase();
  if (!TRANSPORTS.includes(transport)) throw netError('NO_CONFIG', '모르는 전송 방식입니다: ' + transport);
  let makeSocket;
  let room = opts.room;
  if (transport === 'relay') {
    const relayUrl = String(opts.relayUrl || cfg.relay.url || '').trim();
    if (!relayUrl) throw netError('NO_CONFIG', '중계 서버 주소(relay.url)가 없습니다');
    const hz = clampHz(Number(opts.relayHz || cfg.relay.hz) || RELAY_ROOM_DEFAULTS.maxHz, 1, 30);
    room = { ...RELAY_ROOM_DEFAULTS, maxHz: hz, ...(opts.room || {}) };
    makeSocket = () => new HubSocket({ url: relayUrl, ...(opts.socket || {}) });
  } else {
    // account/remote.js와 똑같이 앞뒤 공백을 지운다. 값을 붙여 넣다 공백이 끼면 RPC만 되고 Realtime은 안 되는 상태가 된다
    const url = String(opts.url || cfg.supabase.url || '').trim();
    const key = String(opts.key || cfg.supabase.anonKey || '').trim();
    if (!url || !key) throw netError('NO_CONFIG', 'Supabase 접속 정보(url, key)가 없습니다');
    makeSocket = () => new RealtimeSocket({ url, key, ...(opts.socket || {}) });
  }
  let playerId = opts.playerId != null ? String(opts.playerId) : '';
  if (playerId && !ID_RE.test(playerId)) throw netError('BAD_PLAYER_ID', 'playerId는 영문·숫자·_- 1~40자');
  if (!playerId) playerId = randomId(12);
  const name = sanitizeName(opts.name) || ('플레이어-' + playerId.slice(0, 4));
  const socket = makeSocket();
  await socket.open(opts.timeoutMs || 15000);
  return new Net(socket, { id: playerId, name }, { ...opts, room, transport });
}

/**
 * net.me = { id, name }, net.lobby, net.room(현재 방 또는 null), net.transport('supabase'|'relay')
 * 이벤트: 'connection'({ state: 'open'|'reconnecting'|'closed' }), 'closed'
 */
export class Net extends Emitter {
  constructor(socket, me, opts = {}) {
    super();
    this.socket = socket;
    this.me = Object.freeze({ ...me });
    this.opts = opts;
    this.transport = opts.transport || 'supabase';
    this.lobby = new Lobby(this);
    this._room = null;
    this._closed = false;
    this._op = Promise.resolve(); // 방 생성/참가/퇴장 직렬화
    this._offState = socket.on('state', (state, info) => this.emit('connection', { state, ...info }));
    this._unload = null;
    const w = globalThis.window;
    if (w && typeof w.addEventListener === 'function') {
      // 탭을 닫을 때 _bye를 동기 송신 → 다른 사람이 즉시 방장 이전
      const onHide = (e) => { if (!e || !e.persisted) this.close(); };
      w.addEventListener('pagehide', onHide);
      this._unload = () => w.removeEventListener('pagehide', onHide);
    }
  }

  get room() { return this._room; }
  get closed() { return this._closed; }

  /** 방 만들기(내가 방장). 이미 방에 있으면 먼저 나간다 */
  createRoom(opts) {
    return this._serial(async () => {
      await this._leaveCurrent();
      this._assertOpen();
      return this._attach(await Room.create(this, opts));
    });
  }

  /** 방 참가. 실패 코드: ROOM_NOT_FOUND, ROOM_FULL, BAD_ROOM_ID, JOIN_TIMEOUT, JOIN_ERROR, TRACK_FAILED */
  joinRoom(roomId, opts) {
    return this._serial(async () => {
      await this._leaveCurrent();
      this._assertOpen();
      return this._attach(await Room.join(this, roomId, opts));
    });
  }

  _serial(fn) {
    if (this._closed) return Promise.reject(netError('CLOSED', '이미 닫힌 연결입니다'));
    const run = this._op.then(fn, fn);
    this._op = run.catch(() => {});
    return run;
  }

  /** ARCHITECTURE 8절 규칙용 별칭 = close() */
  dispose() { return this.close(); }

  stats() {
    const s = this.socket;
    return {
      transport: this.transport,
      state: s.state,
      rtt: s.rtt,
      reconnects: s.reconnects,
      ...s.stats,
      room: this._room ? { ...this._room.stats, rate: this._room.rate } : null
    };
  }

  /** 모두 정리(방 퇴장, 로비 해제, 소켓 종료) */
  async close() {
    if (this._closed) return;
    this._closed = true;
    if (this._unload) { this._unload(); this._unload = null; }
    const room = this._room;
    this._room = null;
    if (room) { try { await room.leave('net-closed'); } catch (_) { /* noop */ } }
    this.lobby.dispose();
    this._offState();
    this.socket.close();
    this.emit('closed');
    this.removeAll();
  }

  _assertOpen() { if (this._closed) throw netError('CLOSED', '이미 닫힌 연결입니다'); }

  async _leaveCurrent() {
    const r = this._room;
    this._room = null;
    if (r) await r.leave('switch');
  }

  _attach(room) {
    if (this._closed) { room.leave('net-closed'); throw netError('CLOSED', '이미 닫힌 연결입니다'); }
    this._room = room;
    room.on('closed', () => { if (this._room === room) this._room = null; });
    return room;
  }
}
