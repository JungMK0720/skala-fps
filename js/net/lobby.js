/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 로비. Presence 채널로 공개 방 목록을 주고받는다.
 */
/*
 * js/net/lobby.js — 로비 (Presence 채널 'skalafps:lobby')
 *
 *  - 방 목록 = 로비 presence. 방장만 자기 방 메타를 track한다:
 *      { roomId, name, mapId, hostId, hostName, players, max, status, term, mode }   (presence 키 10개가 한도, 꽉 찼다)
 *  - 일반 구경꾼은 track하지 않고 presence만 읽는다(구독자가 없으면 채널에서 나간다).
 *  - 방장이 바뀌면 새 방장이 term+1로 이어서 track한다. 같은 roomId가 겹치면 term이 큰 쪽을 쓴다.
 *  - 메타 갱신은 Channel의 presence 리미터(31초 4회)가 병합하므로 마구 불러도 안전하다.
 */
import { NET } from '../core/consts.js';
import { Emitter, sanitizeName } from './realtime.js';

export const LOBBY_TOPIC = NET.LOBBY_CHANNEL;

const STATUS_ORDER = { waiting: 0, playing: 1 };
const HOLD_MS = 1500; // 채널을 새로 연 직후 presence가 덜 찬 동안 이전 목록 유지
const DEFAULT_RULESET = 'classic';
const RULESET_RE = /^[a-z][a-z0-9_-]{0,15}$/;
const ROOM_MAX_PLAYERS = 16;   // room.js의 방 인원 상한과 같다
const nowMs = () => (globalThis.performance && performance.now ? performance.now() : Date.now());
const textOf = (v, max) => (typeof v === 'string' ? sanitizeName(v, max) : '');
const intOf = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : 0);

/** 개인전 목표 킬 칸: 1~99의 정수만 싣는다. 어느 범위를 고를 수 있는지는 게임이 정한다(game/modes.js FFA_KILLS) */
function killsOf(v) {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,2}$/.test(v) ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 99 ? n : 0;
}

/**
 * presence 객체는 키가 10개까지라(limits.FREE_PLAN) 모드와 규칙을 mode 키 하나에 싣는다: 'team', 'ffa', 'bomb', 'zombie', 'team:knife', 'ffa:sniper'.
 * 'zombie'(좀비 물량 막기)를 모르는 옛 클라이언트는 팀전으로 읽는다(새로고침하면 바로 보인다).
 * 클래식은 규칙을 적지 않으므로 규칙이 없는 옛 항목은 그대로 클래식으로 읽힌다. 비밀번호 방은 끝에 ':p'를 붙인다('team:classic:p').
 * 개인전 목표 킬은 넷째 칸에 싣는다('ffa:classic::10', 'ffa:knife:p:5'). 셋째 칸까지만 읽던 클라이언트도 비밀번호 여부를 그대로 읽는다.
 * 목표 킬이 없는 개인전 항목은 게임 기본값(20킬)으로 읽힌다.
 */
export function packRoomKind(mode, ruleset, locked = false, killTarget) {
  const m = mode === 'ffa' || mode === 'bomb' || mode === 'zombie' ? mode : 'team';
  const rs = typeof ruleset === 'string' && RULESET_RE.test(ruleset) ? ruleset : DEFAULT_RULESET;
  const kills = m === 'ffa' ? killsOf(killTarget) : 0;
  if (kills) return `${m}:${rs}:${locked ? 'p' : ''}:${kills}`;
  if (locked) return `${m}:${rs}:p`;
  return rs === DEFAULT_RULESET ? m : `${m}:${rs}`;
}

/** → { mode:'team'|'ffa'|'bomb'|'zombie', ruleset, locked, killTarget? }. 어떤 규칙 이름이 있는지는 게임이 안다(모르는 이름은 화면에서 클래식으로 읽는다) */
export function unpackRoomKind(v) {
  const [m, rs, flag, k] = (typeof v === 'string' ? v : '').split(':');
  const out = { mode: m === 'ffa' || m === 'bomb' || m === 'zombie' ? m : 'team', ruleset: rs && RULESET_RE.test(rs) ? rs : DEFAULT_RULESET, locked: flag === 'p' };
  const kills = out.mode === 'ffa' ? killsOf(k) : 0;
  if (kills) out.killTarget = kills;
  return out;
}

/** (방장) 로비에 track할 한 줄. 키를 더하면 presence 한도를 넘는다 */
export function lobbyEntry(meta, { roomId, hostId, hostName, players, term }) {
  return {
    roomId, name: meta.name, mapId: meta.mapId, hostId, hostName, players, max: meta.max, status: meta.status, term,
    mode: packRoomKind(meta.mode, meta.ruleset, meta.locked, meta.killTarget)
  };
}

/** presence 한 줄(믿을 수 없는 값) → 방 목록 항목. 아무나 올릴 수 있으므로 한 줄이 목록 전체를 망가뜨리면 안 된다 */
export function readLobbyEntry(m) {
  const max = intOf(m.max);
  return {
    roomId: typeof m.roomId === 'string' ? m.roomId : '',
    name: textOf(m.name, 32),
    mapId: textOf(m.mapId, 32),
    hostId: textOf(m.hostId, 64),
    hostName: textOf(m.hostName, 24),
    players: Math.max(0, intOf(m.players)),
    max: max > 0 ? Math.min(ROOM_MAX_PLAYERS, max) : 8,
    status: m.status === 'playing' ? 'playing' : 'waiting',
    ...unpackRoomKind(m.mode)
  };
}

export class Lobby extends Emitter {
  constructor(net) {
    super();
    this.net = net;
    this.ch = null;
    this._offs = [];
    this._subs = new Set();
    this._hosted = null; // { room, entry }
    this._rooms = [];
    this._json = '[]';
    this._joinP = null;
    this._emittedSynced = false;
    this._holdUntil = 0;
    this._holdTimer = null;
  }

  /**
   * 방 목록 구독 → off(). fn(rooms, { synced })
   * 즉시 현재 목록으로 한 번, 로비 presence를 처음 받았을 때 한 번(synced: true, 비어 있어도), 이후 바뀔 때마다 호출.
   */
  subscribe(fn) {
    if (typeof fn !== 'function') throw new TypeError('lobby.subscribe(fn)');
    this._subs.add(fn);
    this._ensure();
    try { fn(this.rooms(), { synced: this.synced }); } catch (e) { console.error('[net] lobby subscriber error', e); }
    return () => {
      if (!this._subs.delete(fn)) return;
      this._release();
    };
  }

  /** 현재 방 목록 사본: [{ roomId, name, mapId, hostId, hostName, players, max, status, mode, ruleset }] */
  rooms() { return this._rooms.map((r) => ({ ...r })); }

  /** 로비 presence를 한 번이라도 받았는지 */
  get synced() { return !!(this.ch && this.ch.presenceSynced); }

  /** 로비 채널 참가 완료까지 대기 (목록 화면 진입 시 선택적으로 사용) */
  ready() { this._ensure(); return this._joinP; }

  createRoom(opts) { return this.net.createRoom(opts); }
  joinRoom(roomId, opts) { return this.net.joinRoom(roomId, opts); }

  _ensure() {
    if (this.ch) return this._joinP;
    if (!this.net.socket || this.net.closed) return Promise.resolve();
    const ch = this.net.socket.channel(LOBBY_TOPIC, { presence: true, presenceKey: this.net.me.id });
    this.ch = ch;
    this._offs = [
      ch.on('presence', () => this._recompute()),
      ch.on('interrupted', (why) => this.emit('interrupted', why))
    ];
    this._joinP = ch.join().catch((e) => { this.emit('error', e); });
    return this._joinP;
  }

  _detach() {
    const ch = this.ch;
    this.ch = null;
    this._joinP = null;
    for (const off of this._offs) off();
    this._offs = [];
    if (ch) ch.leave(); // 채널을 나가면 presence도 서버가 바로 지운다(untrack 한도 소모 없음)
  }

  _release() {
    if (this._subs.size || this._hosted || !this.ch) return;
    this._detach();
    this._emittedSynced = false;
    this._setRooms([]);
  }

  /** (Room 전용) 방장이 자기 방 메타를 로비에 올린다 */
  _setHosted(room, entry) {
    this._hosted = { room, entry };
    this._ensure();
    this.ch.track(entry);
  }

  /** (Room 전용) 방장 역할을 내려놓을 때 */
  _clearHosted(room) {
    if (!this._hosted || (room && this._hosted.room !== room)) return;
    const roomId = this._hosted.entry && this._hosted.entry.roomId;
    this._hosted = null;
    if (!this.ch) return;
    if (!this._subs.size) { this._release(); return; }
    // 구독 중이면 untrack 대신 채널을 새로 연다: untrack은 30초 5회 한도에 걸려 최대 30초 늦어질 수 있지만
    // 채널 퇴장은 즉시 presence를 지운다. 새 채널의 presence가 찰 때까지는 이전 목록(내 방 제외)을 유지
    this._detach();
    this._holdUntil = nowMs() + HOLD_MS;
    this._setRooms(this._rooms.filter((r) => r.roomId !== roomId));
    this._ensure();
  }

  _recompute() {
    if (!this.ch) return;
    const wait = this._holdUntil - nowMs();
    if (wait > 0) {
      if (!this._holdTimer) this._holdTimer = setTimeout(() => { this._holdTimer = null; this._recompute(); }, wait + 10);
      return;
    }
    const byRoom = new Map();
    for (const { metas } of this.ch.presence.list()) {
      for (const m of metas) {
        if (!m || typeof m.roomId !== 'string' || !m.roomId) continue;
        const prev = byRoom.get(m.roomId);
        const t = m.term | 0, pt = prev ? prev.term | 0 : -1;
        if (!prev || t > pt || (t === pt && String(m.hostId) < String(prev.hostId))) byRoom.set(m.roomId, m);
      }
    }
    const rooms = [];
    for (const m of byRoom.values()) {
      const entry = readLobbyEntry(m);
      if (entry.players) rooms.push(entry);
    }
    rooms.sort((a, b) => (STATUS_ORDER[a.status] - STATUS_ORDER[b.status]) ||
      a.name.localeCompare(b.name) || (a.roomId < b.roomId ? -1 : 1));
    const firstSync = !this._emittedSynced && this.ch.presenceSynced;
    if (firstSync) this._emittedSynced = true;
    this._setRooms(rooms, firstSync);
  }

  _setRooms(rooms, force = false) {
    const json = JSON.stringify(rooms);
    if (json === this._json && !force) return;
    this._json = json;
    this._rooms = rooms;
    const info = { synced: this.synced };
    this.emit('rooms', this.rooms(), info);
    for (const fn of [...this._subs]) {
      try { fn(this.rooms(), info); } catch (e) { console.error('[net] lobby subscriber error', e); }
    }
  }

  dispose() {
    this._subs.clear();
    this._hosted = null;
    clearTimeout(this._holdTimer);
    this._holdTimer = null;
    if (this.ch) this._detach();
    this._rooms = [];
    this._json = '[]';
    this.removeAll();
  }
}
