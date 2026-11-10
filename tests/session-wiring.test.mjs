/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 멀티 세션 연결 시험. 작은 가짜 net·world·ui·account로 방장과 멤버를 방 → 로드아웃 → 라이브 → 히트 주장 → 킬 → 결과까지 돌리고,
 *          규칙·산탄 count·방장 이전·계정 기록·로비 메타·대기실 화면, 나오는 중에 누른 방 만들기·참가, 막 열린 방의 팀 자동 배정(presence 지연),
 *          결과 화면의 포인트 줄 부호를 확인한다. Realtime 전송 자체는 시험하지 않는다.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSession, restoreMatch, restoreFfaMatch, preferredPick, gearMessage, readGear, weaponForSlot, matchSummary, CHAT_LIMIT
} from '../js/game/session.js';
import { createMatch } from '../js/game/match.js';
import { pickableWeapons } from '../js/game/modes.js';
import { EV, byteSize, decodeMessage, encodeChat, encodeLoadout } from '../js/game/protocol.js';
import { NET } from '../js/core/consts.js';
import { LOBBY_TOPIC, Lobby, lobbyEntry, packRoomKind, readLobbyEntry, unpackRoomKind } from '../js/net/lobby.js';
import { ROOM_TOPIC_PREFIX, Room } from '../js/net/room.js';
import { PresenceState, plainFields } from '../js/net/realtime.js';
import { connect } from '../js/net/index.js';
import { FREE_PLAN } from '../js/net/limits.js';
import { normalizeRuleset } from '../js/game/modes.js';
import { getDef } from '../js/weapons/defs.js';
import { avatarIdOf } from '../js/core/avatar-defs.js';
import { createLobby, mapsForRule, ruleBadge } from '../js/ui/lobby.js';
import { createRoom } from '../js/ui/room.js';
import { createChat, chatPlaceholder } from '../js/ui/chat.js';
import { createResults } from '../js/ui/results.js';
import { matchReward } from '../js/account/economy.js';

const MAP_LIST = Object.freeze([
  { id: 'rooftop', name: '빨랫줄 옥상', rulesets: ['knife'], tag: '칼전 전용' },
  { id: 'alley', name: '항구 골목', rulesets: ['classic', 'knife'], tag: '' },
  { id: 'longshot', name: '협곡 저격장', rulesets: ['sniper'], tag: '스나 전용' },
  { id: 'dojo', name: '벚꽃 도장', rulesets: ['classic', 'knife', 'sniper'], tag: '통합' },
  { id: 'nexus', name: '넥서스', rulesets: ['classic', 'knife', 'sniper'], tag: '통합' },
  { id: 'jetty', name: '부두', rulesets: ['classic', 'sniper'], tag: '' }
]);
const fakeMaps = { MAP_LIST, mapsForRuleset: (id) => MAP_LIST.filter((m) => m.rulesets.includes(id)) };
const OWNED = ['ar_std', 'ar_rapid', 'sg_bx12', 'sr_bolt', 'sr_twin', 'pt_std', 'pt_magnum', 'ml_knife', 'ml_katana', 'gr_frag'];
const SPAWNS = {
  owner: [{ x: -20, y: 0, z: 0, rotY: 0 }, { x: -22, y: 0, z: 0, rotY: 0 }],
  charterer: [{ x: 20, y: 0, z: 0, rotY: 0 }, { x: 22, y: 0, z: 0, rotY: 0 }],
  ffa: [{ x: 0, y: 0, z: 10, rotY: 0 }, { x: 0, y: 0, z: -10, rotY: 0 }, { x: 10, y: 0, z: 0, rotY: 0 }, { x: -10, y: 0, z: 0, rotY: 0 }]
};
const copy = (v) => JSON.parse(JSON.stringify(v));

/* ------------------------------------------------------------------ 가짜 방: 메시지를 그대로 다른 사람에게 건넨다 */
class FakeRoom {
  constructor(hub, id) { this.hub = hub; this.myId = id; this.subs = new Map(); this.rate = 10; }
  get id() { return this.hub.roomId; }
  get me() { return { ...this.hub.members.get(this.myId) }; }
  get meta() { return { ...this.hub.meta, hostId: this.hub.hostId, term: this.hub.term }; }
  isHost() { return this.hub.hostId === this.myId; }
  hostId() { return this.hub.hostId; }
  now() { return this.hub.clock.now(); }
  players() {
    const out = [];
    for (const p of this.hub.members.values()) {
      const seen = p.id === this.myId ? p : this.hub.seenBy(this.myId, p);
      if (seen) out.push({ ...seen, isHost: p.id === this.hub.hostId, ping: 30 });
    }
    return out;
  }
  on(evt, fn) {
    if (!this.subs.has(evt)) this.subs.set(evt, new Set());
    this.subs.get(evt).add(fn);
    return () => this.subs.get(evt).delete(fn);
  }
  emit(evt, data) { for (const fn of [...(this.subs.get(evt) || [])]) fn(data); }
  handle(event, fn) { return this.on('message', (m) => { if (m.event === event) fn(m.payload, m); }); }
  send(event, payload, opts) { this.hub.post(this.myId, event, payload, null, opts); return true; }
  sendTo(to, event, payload, opts) { this.hub.post(this.myId, event, payload, String(to), opts); return true; }
  updateMe(fields) {
    Object.assign(this.hub.members.get(this.myId), fields);
    this.hub.announce('players');
    return true;
  }
  updateMeta(fields) {
    if (!this.isHost()) return false;
    let changed = false;
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined && this.hub.meta[k] !== v) { this.hub.meta[k] = v; changed = true; }
    }
    if (changed) this.hub.announce('meta');
    return true;
  }
  async leave() { this.hub.remove(this.myId); }
}

function createHub(clock) {
  const hub = {
    clock, roomId: 'room1', meta: null, hostId: null, term: 0, members: new Map(), rooms: new Map(), queue: [], sent: [], lastCreate: null,
    post(from, event, payload, to, opts) {
      const msg = { from, event, payload: copy(payload), to };
      hub.sent.push(msg);
      const same = opts && opts.merge ? hub.queue.findIndex((q) => q.from === from && q.event === event && q.to === to) : -1;
      if (same >= 0) hub.queue[same] = msg; else hub.queue.push(msg);
    },
    flush() {
      for (const m of hub.queue.splice(0)) {
        for (const room of [...hub.rooms.values()]) {
          if (room.myId !== m.from && (!m.to || m.to === room.myId)) {
            room.emit('message', { from: m.from, event: m.event, payload: copy(m.payload), to: m.to, t: clock.now(), fromHost: m.from === hub.hostId });
          }
        }
      }
    },
    announce(evt) {
      for (const room of [...hub.rooms.values()]) room.emit(evt, evt === 'players' ? room.players() : room.meta);
    },
    /**
     * presence가 늦게 퍼지는 것을 흉내 낸다. lag.get(보는 사람).get(그 사람 id) =
     * null(아직 명단에 없다) | { team: null } 같은 옛 칸(그 칸이 실린 presence가 아직 안 왔다)
     */
    lag: new Map(),
    seenBy(viewer, p) {
      const m = hub.lag.get(viewer);
      if (!m || !m.has(p.id)) return p;
      const old = m.get(p.id);
      return old === null ? null : { ...p, ...old };
    },
    /** 늦던 presence가 그 사람에게 도착한다 */
    deliver(viewer, id) {
      const m = hub.lag.get(viewer);
      if (m) m.delete(id);
      const room = hub.rooms.get(viewer);
      if (room) room.emit('players', room.players());
    },
    create(me, opts) {
      const { name, mapId, max, ...extra } = copy(opts);
      hub.lastCreate = copy(opts);
      hub.meta = { roomId: hub.roomId, name, mapId, max, status: 'waiting', ...extra };
      hub.hostId = me.id;
      hub.term = 1;
      return hub.join(me);
    },
    join(me) {
      hub.members.set(me.id, { id: me.id, name: me.name, team: null, ready: false });
      const room = new FakeRoom(hub, me.id);
      hub.rooms.set(me.id, room);
      hub.announce('players');
      return room;
    },
    remove(id) {
      hub.members.delete(id);
      hub.rooms.delete(id);
      if (hub.hostId === id && hub.members.size) {
        const prev = id;
        hub.hostId = [...hub.members.keys()][0];
        hub.term += 1;
        for (const room of [...hub.rooms.values()]) {
          room.emit('host', { hostId: hub.hostId, prevHostId: prev, term: hub.term, isMe: room.myId === hub.hostId, reason: 'host-left' });
        }
      }
      hub.announce('players');
    },
    /** 로비 presence를 거친 것과 같은 방 목록 */
    list() {
      if (!hub.meta || !hub.members.size) return [];
      const host = hub.members.get(hub.hostId);
      return [readLobbyEntry(copy(lobbyEntry(hub.meta, {
        roomId: hub.roomId, hostId: hub.hostId, hostName: host ? host.name : '', players: hub.members.size, term: hub.term
      })))];
    },
    /** 보낸 메시지 중 이 이벤트를 풀어서 */
    decoded(event, from) {
      return hub.sent.filter((m) => m.event === event && (!from || m.from === from)).map((m) => decodeMessage(event, m.payload).data);
    }
  };
  return hub;
}

function fakeNet(hub, id, name) {
  return {
    me: Object.freeze({ id, name }),
    on: () => () => {},
    lobby: {
      synced: true,
      subscribe(fn) { fn(hub.list(), { synced: true }); return () => {}; }
    },
    async createRoom(opts) { return hub.create({ id, name }, opts); },
    async joinRoom() { return hub.join({ id, name }); }
  };
}

/* ------------------------------------------------------------------ 가짜 world · ui · account */
const WORLD_CALLS = [
  'unloadMap', 'setRuleset', 'reset', 'spawnLocal', 'setLocalLoadout', 'setLocalHp', 'killLocal', 'addActor', 'removeActor', 'setActorState',
  'actorFire', 'actorGrenade', 'actorDeath', 'feedbackDamage', 'setRound', 'setControlsEnabled', 'setScoreboard', 'setHint', 'setPauseOptions',
  'setMode', 'setRespawn', 'setProtect', 'setActorProtect', 'sound', 'addDrop', 'removeDrop', 'setBomb', 'bombEvent',
  'openSwap', 'closeSwap', 'setMoverClock'];
/** 폭파 미션 시험용 미션 칸과 맵 목록(미션 맵 하나) */
const BOMB_MISSION = {
  sites: [{ id: 'A', x: 10, y: 0, z: 10, w: 6, d: 6 }, { id: 'B', x: 10, y: 0, z: -10, w: 6, d: 6 }],
  attack: [{ x: -20, z: 0, rotY: 0 }, { x: -22, z: 0, rotY: 0 }],
  defense: [{ x: 20, z: 0, rotY: 0 }, { x: 22, z: 0, rotY: 0 }]
};
const BOMB_MAPS = [...MAP_LIST, { id: 'relay', name: '중계 기지', rulesets: ['classic'], tag: '폭파 미션', mission: true }];
const bombMaps = {
  MAP_LIST: BOMB_MAPS,
  mapsForRuleset: (id) => BOMB_MAPS.filter((m) => m.rulesets.includes(id)),
  mapsForMode: (mode, id) => (mode === 'bomb' ? BOMB_MAPS.filter((m) => m.mission) : BOMB_MAPS.filter((m) => m.rulesets.includes(id)))
};
/** 방장은 위치로 사격 거리를 다시 잰다: 쏘는 사람을 상대 옆(d m)에 세우고 위치가 방장에게 퍼질 때까지 기다린다 */
async function standNear(env, shooter, victim, d = 1.2) {
  shooter.world.pos = [victim.world.pos[0] + d, victim.world.pos[1], victim.world.pos[2]];
  await env.run(400);
}

function fakeWorld() {
  const log = [];
  const handlers = new Map();
  const w = {
    pos: [0, 0, 0],
    slot: 1,
    calls: (name) => log.filter((c) => c.name === name).map((c) => c.args),
    last: (name) => { const list = w.calls(name); return list.length ? list[list.length - 1] : null; },
    on(evt, fn) { handlers.set(evt, fn); return () => handlers.delete(evt); },
    fire(evt, payload) { const fn = handlers.get(evt); if (fn) fn(payload); },
    async loadMap(...args) { log.push({ name: 'loadMap', args }); return { spawns: SPAWNS, mapName: args[0] }; },
    getLocalState: () => ({ pos: w.pos.slice(), vel: [0, 0, 0], yaw: 0, pitch: 0, slot: w.slot, hp: 100, onGround: true, alive: true })
  };
  for (const name of WORLD_CALLS) {
    w[name] = (...args) => {
      log.push({ name, args });
      if (name === 'spawnLocal') w.pos = [args[0].spawn.x, 0, args[0].spawn.z];
      return true;
    };
  }
  return w;
}

function fakeUi() {
  const log = [];
  const handlers = new Map();
  const feed = [];
  const chat = { lines: [], opened: 0, push(l) { chat.lines.push(l); }, open() { chat.opened += 1; }, clear() { chat.lines.length = 0; } };
  return {
    feed,
    chat,
    hud: { center() {} },
    killfeed: { push: (k) => feed.push(k), clear() {} },
    show(name, props) { log.push({ name, kind: 'show', props }); },
    update(name, props) { log.push({ name, kind: 'update', props }); },
    hide() {},
    isVisible: () => true,
    getPlayerName: () => '',
    on(action, fn) { handlers.set(action, fn); return () => handlers.delete(action); },
    fire(action, payload) { const fn = handlers.get(action); if (fn) fn(payload); },
    shown: (name) => log.filter((c) => c.name === name && c.kind === 'show').map((c) => c.props),
    lastShown(name) { const list = this.shown(name); return list.length ? list[list.length - 1] : null; },
    /** 그 화면에 마지막으로 넘긴 값들을 합친 것 */
    props: (name) => log.filter((c) => c.name === name).reduce((acc, c) => (c.kind === 'show' ? { ...c.props } : { ...acc, ...c.props }), {})
  };
}

const REWARD = Object.freeze({ gained: 120, breakdown: [{ label: '완주', points: 20 }], points: 620 });
function fakeAccount(nickname, over = {}) {
  const a = {
    profile: { nickname, owned: OWNED.slice() },
    loadout: { primary: 'ar_std', secondary: 'pt_std', melee: 'ml_katana' },
    remoteEnabled: true,
    retries: 0,
    recorded: [],
    retryNickname() { a.retries += 1; return new Promise(() => {}); },   // 끝나지 않아도 입장을 막지 않아야 한다
    recordMatch(summary) { a.recorded.push(summary); return { ...REWARD }; },
    ...over
  };
  return a;
}

/* ------------------------------------------------------------------ 시험 무대 */
function stage(t, { rules, ffaRules } = {}) {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const clock = { t: 100000, now: () => clock.t };
  const hub = createHub(clock);
  const clients = [];
  const env = {
    clock, hub, clients,
    client(id, name, account, extraIn = {}) {
      const { maps = fakeMaps, ...extra } = extraIn;
      const c = { id, world: fakeWorld(), ui: fakeUi(), account: fakeAccount(name, account), logs: [] };
      c.session = createSession({
        world: c.world, ui: c.ui,
        ctx: { account: c.account, maps, session: { name: '임시이름' }, flags: {}, onFrame: () => () => {} },
        net: fakeNet(hub, id, name), now: clock.now, log: (...a) => c.logs.push(a), setScreens: false,
        hostTickMs: 50, loadoutLeadMs: 200,
        rules: { loadoutMs: 1500, roundEndMs: 300, roundTimeMs: 60000, roundsToWin: 1, maxRounds: 1, ...rules },
        ffaRules: { spawnProtectMs: 0, respawnMs: 300, timeLimitMs: 6000, ...ffaRules },
        syncOptions: { autoTick: false, now: clock.now },
        ...extra
      });
      clients.push(c);
      return c;
    },
    async settle() { for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r)); },
    async run(ms, step = 50) {
      for (let left = ms; left > 0; left -= step) {
        clock.t += step;
        t.mock.timers.tick(step);
        for (const c of clients) if (c.session.sync) c.session.sync.tick(clock.t);
        hub.flush();
        await new Promise((r) => setImmediate(r));
      }
    },
    /** 아무도 안 움직이는 동안 원격 상태를 world로 넘긴다 */
    frames() { for (const c of clients) c.session.frame(); },
    dispose() { for (const c of clients) c.session.dispose(); }
  };
  return env;
}

/** 방을 만들고 모두 들어와 준비한 뒤 시작해 로드아웃까지 간다 */
async function startMatch(env, players, create) {
  const [host, ...rest] = players;
  await host.session.open();
  host.ui.fire('lobby:create', { name: '', max: 4, mapId: 'jetty', mode: 'team', ...create });
  await env.settle();
  for (const c of rest) {
    await c.session.open();
    c.ui.fire('lobby:join', { roomId: env.hub.roomId });
    await env.settle();
    c.ui.fire('room:ready', { ready: true });
  }
  host.ui.fire('room:start', {});
  await env.settle();
  await env.run(250);
}

/* ================================================================== 경기 흐름 */

describe('세션 연결', () => {
  test('죽은 뒤 버린 총은 모두에게 가고, 주웠다는 알림이 오면 사라진다', async (t) => {
    const env = stage(t);
    const a = env.client('a', '하늘');
    const b = env.client('b', '구름');
    await startMatch(env, [a, b], { mapId: 'jetty' });
    await env.run(1500);
    assert.equal(a.session.state.matchPhase, 'live');

    const drop = { dropId: 'b#1', weaponId: 'sr_twin', pos: [1.5, 0, -2.25], mag: 3, reserve: Infinity };
    b.world.fire('weaponDrop', drop);
    await env.run(300);
    const sent = env.hub.decoded(EV.drop, 'b');
    assert.ok(sent.length >= 1, '방장을 거치지 않고 보낸다');
    assert.deepEqual(a.world.calls('addDrop'), [[{ id: 'b#1', weaponId: 'sr_twin', pos: [1.5, 0, -2.25], mag: 3, reserve: Infinity }]], '두 번 보내도 한 번만 놓는다');
    assert.equal(b.world.calls('addDrop').length, 0, '자기가 보낸 것은 다시 받지 않는다');

    a.world.fire('weaponPick', { dropId: 'b#1', weaponId: 'sr_twin' });
    await env.run(300);
    assert.deepEqual(b.world.calls('removeDrop'), [['b#1']]);
    assert.equal(a.world.calls('removeDrop').length, 0);
  });

  test('경기 채팅: HUD 채팅으로 주고받고, Enter(input:chat)로 열고, 도배는 보내는 쪽과 받는 쪽에서 막는다', async (t) => {
    const env = stage(t);
    const bus = { subs: new Map(), events: [] };
    bus.on = (evt, fn) => { if (!bus.subs.has(evt)) bus.subs.set(evt, new Set()); bus.subs.get(evt).add(fn); return () => bus.subs.get(evt).delete(fn); };
    bus.emit = (evt, data) => { bus.events.push([evt, data]); for (const fn of [...(bus.subs.get(evt) || [])]) fn(data); };
    const a = env.client('a', '하늘', undefined, { bus });
    const b = env.client('b', '구름');
    const sentIds = () => new Set(env.hub.decoded(EV.chat, 'a').map((d) => d.id)).size;

    await a.session.open();
    a.ui.fire('lobby:create', { name: '', max: 4, mapId: 'jetty', mode: 'team' });
    await env.settle();
    bus.emit('input:chat', {});
    assert.equal(a.ui.chat.opened, 0, '대기실에서는 Enter로 경기 채팅을 열지 않는다');
    await b.session.open();
    b.ui.fire('lobby:join', { roomId: env.hub.roomId });
    await env.settle();
    b.ui.fire('room:ready', { ready: true });
    a.ui.fire('room:start', {});
    await env.settle();
    await env.run(1800);
    assert.equal(a.session.state.matchPhase, 'live');
    assert.ok(a.ui.shown('chat').length >= 1 && b.ui.shown('chat').length >= 1, '경기에 들어가면 채팅 화면을 띄운다');
    assert.deepEqual(bus.events.filter((e) => e[0] === 'chat:available').at(-1), ['chat:available', { on: true }], '휴대폰 채팅 버튼을 켠다');

    bus.emit('input:chat', {});
    assert.equal(a.ui.chat.opened, 1, '경기 중 Enter는 채팅 입력칸을 연다');

    a.ui.fire('chat:send', { text: '  왼쪽으로   가요 ' });
    await env.run(200);
    const mine = a.ui.chat.lines.at(-1);
    assert.equal(mine.text, '왼쪽으로 가요');
    assert.equal(mine.me, true, '내 줄은 표시가 다르다');
    const got = b.ui.chat.lines.filter((l) => !l.system);
    assert.equal(got.length, 1, '여러 번 다시 보내도 한 줄만 받는다');
    assert.equal(got[0].name, '하늘');
    assert.equal(got[0].text, '왼쪽으로 가요');
    assert.ok(['owner', 'charterer'].includes(got[0].team), '팀전은 팀 색을 붙인다');
    assert.ok(b.session.state.chat.some((l) => l.text === '왼쪽으로 가요'), '대기실 채팅 기록에도 남는다');

    // 5초에 4줄까지: 처음 한 줄 + 세 줄은 가고 다섯째는 안내만 남는다
    for (let i = 0; i < CHAT_LIMIT.send; i++) a.ui.fire('chat:send', { text: `빨리 ${i}` });
    await env.run(200);
    assert.equal(sentIds(), CHAT_LIMIT.send, '보내는 쪽에서 막는다');
    assert.match(a.ui.chat.lines.at(-1).text, /너무 빨리/);
    assert.equal(a.ui.chat.lines.at(-1).system, true);

    // 고친 클라이언트가 한도를 무시하고 보내도 받는 쪽이 한 사람당 5초에 CHAT_LIMIT.receive줄만 받는다
    await env.run(CHAT_LIMIT.windowMs + 200);
    const before = b.ui.chat.lines.length;
    for (let i = 0; i < CHAT_LIMIT.receive + 4; i++) env.hub.post('a', EV.chat, encodeChat(900 + i, `도배 ${i}`));
    await env.run(100);
    assert.equal(b.ui.chat.lines.length - before, CHAT_LIMIT.receive, '받는 쪽에서 버린다');

    a.session.dispose();
    assert.deepEqual(bus.events.filter((e) => e[0] === 'chat:available').at(-1), ['chat:available', { on: false }], '경기를 떠나면 채팅 버튼을 끈다');
    bus.emit('input:chat', {});
    assert.equal(a.ui.chat.opened, 1, '떠난 뒤의 Enter는 무시한다');
    env.dispose();
  });

  test('팀 채팅: 같은 팀에게만 보내고, 다른 팀이 흉내 낸 팀 채팅은 받지 않는다', async (t) => {
    const env = stage(t);
    const a = env.client('a', '하늘');
    const b = env.client('b', '구름');
    const c = env.client('c', '바다');
    await startMatch(env, [a, b, c], { mapId: 'jetty' });
    await env.run(1600);
    assert.deepEqual([a.session.state.team, b.session.state.team, c.session.state.team], ['owner', 'charterer', 'owner']);
    assert.deepEqual(a.ui.lastShown('chat'), { teamChat: true }, '팀 경기는 전체·팀 탭을 켠다');

    a.ui.fire('chat:send', { text: 'A로 같이 가요', scope: 'team' });
    await env.run(200);
    const mine = a.ui.chat.lines.at(-1);
    assert.deepEqual([mine.text, mine.scope, mine.me, mine.team], ['A로 같이 가요', 'team', true, 'owner']);
    const got = (cl, text) => cl.ui.chat.lines.filter((l) => !l.system && l.text === text);
    assert.equal(got(c, 'A로 같이 가요').length, 1, '같은 팀은 한 줄 받는다(다시 보내도 한 줄)');
    assert.deepEqual([got(c, 'A로 같이 가요')[0].scope, got(c, 'A로 같이 가요')[0].name], ['team', '하늘']);
    assert.equal(got(b, 'A로 같이 가요').length, 0, '상대 팀 화면에는 없다');
    const wire = env.hub.sent.filter((m) => m.event === EV.chat && m.from === 'a');
    assert.ok(wire.length >= 1 && wire.every((m) => m.to === 'c'), '받는 사람을 팀원으로 정해 보낸다(상대에게는 전달되지 않는다)');
    assert.ok(wire.every((m) => m.payload[2] === 1), '팀 범위 표시가 붙는다');
    assert.ok(a.session.state.chat.some((l) => l.text === 'A로 같이 가요' && l.scope === 'team'), '채팅 기록에도 팀 표시가 남는다');
    assert.ok(!b.session.state.chat.some((l) => l.text === 'A로 같이 가요'));

    // 전체 채팅은 모두에게, 범위 표시 없이
    a.ui.fire('chat:send', { text: '잘 부탁해요', scope: 'all' });
    await env.run(200);
    assert.equal(got(b, '잘 부탁해요').length, 1);
    assert.equal(got(c, '잘 부탁해요').length, 1);
    assert.equal(got(b, '잘 부탁해요')[0].scope, undefined);

    // 상대 팀(고친 클라이언트)이 팀 범위를 붙여 나에게 직접 보내도 보여 주지 않는다. 같은 팀이 보낸 것은 보인다
    env.hub.post('b', EV.chat, encodeChat(700, '엿보기 시험', 'team'), 'a');
    env.hub.post('c', EV.chat, encodeChat(701, '우리 팀', 'team'), 'a');
    await env.run(100);
    assert.equal(got(a, '엿보기 시험').length, 0);
    assert.equal(got(a, '우리 팀').length, 1);
    assert.equal(got(a, '우리 팀')[0].scope, 'team');

    // 혼자 남은 팀: 받을 사람이 없어도 내 화면에는 남는다
    b.ui.fire('chat:send', { text: '혼잣말', scope: 'team' });
    await env.run(200);
    assert.equal(got(b, '혼잣말').length, 1);
    assert.equal(env.hub.sent.filter((m) => m.event === EV.chat && m.from === 'b' && m.payload[1] === '혼잣말').length, 0, '아무에게도 보내지 않는다');
    assert.equal(got(a, '혼잣말').length + got(c, '혼잣말').length, 0);
    env.dispose();
  });

  test('팀 채팅: 개인전에는 탭이 없고, 팀 범위로 보내도 전체로 간다', async (t) => {
    const env = stage(t);
    const a = env.client('a', '하늘');
    const b = env.client('b', '구름');
    await startMatch(env, [a, b], { mapId: 'jetty', mode: 'ffa' });
    await env.run(400);
    assert.deepEqual(a.ui.lastShown('chat'), { teamChat: false });
    a.ui.fire('chat:send', { text: '모두에게', scope: 'team' });
    await env.run(200);
    assert.equal(b.ui.chat.lines.filter((l) => l.text === '모두에게').length, 1);
    assert.equal(a.ui.chat.lines.at(-1).scope, undefined);
    assert.ok(env.hub.sent.filter((m) => m.event === EV.chat && m.from === 'a').every((m) => !m.to && m.payload.length === 2));
    // 개인전에서 온 팀 범위 줄은 버린다
    env.hub.post('b', EV.chat, encodeChat(800, '가짜 팀 채팅', 'team'), 'a');
    await env.run(100);
    assert.equal(a.ui.chat.lines.filter((l) => l.text === '가짜 팀 채팅').length, 0);
    env.dispose();
  });

  test('팀전: 장비 → 로드아웃 → 산탄 count → 킬 → 결과, 계정 기록은 한 번', async (t) => {
    const env = stage(t);
    const a = env.client('a', '하늘');
    const b = env.client('b', '구름', { loadout: { primary: 'ar_rapid', secondary: 'pt_magnum', melee: 'ml_knife' } });
    await startMatch(env, [a, b], { mapId: 'jetty' });

    assert.equal(env.hub.lastCreate.name, '하늘의 방', '기본 방 이름은 닉네임');
    assert.equal(env.hub.lastCreate.ruleset, 'classic');
    assert.deepEqual(a.world.calls('loadMap')[0], ['jetty', { mode: 'team', ruleset: 'classic' }]);
    assert.deepEqual(b.world.calls('loadMap')[0], ['jetty', { mode: 'team', ruleset: 'classic' }]);
    assert.equal(a.session.match.rules.ruleset, 'classic');
    assert.equal(b.account.retries, 1, '멀티 입장 때 닉네임을 다시 등록한다');

    // 대기 시간: 무기 선택 화면을 띄우지 않고 "N 을 눌러 무기 교체!" 안내(world.openSwap)만 켠다. 목록은 가진 무기만, 계정 장비가 기본 선택
    assert.equal(b.ui.shown('loadout').length, 0, '라운드가 시작될 때 무기 선택 화면이 저절로 뜨지 않는다');
    assert.equal(b.world.calls('openSwap').length, 1);
    const screen = b.world.last('openSwap')[0];
    assert.equal(screen.round, 1);
    assert.ok(screen.seconds > 0.8 && screen.seconds <= 1.5, `남은 대기 시간: ${screen.seconds}`);
    assert.deepEqual(screen.weapons, pickableWeapons('classic', OWNED));
    assert.ok(!screen.weapons.includes('sr_heavy'));
    assert.equal(screen.ruleset, 'classic');
    assert.equal(screen.selected, 'ar_rapid');
    assert.equal(b.world.last('spawnLocal')[0].loadout, 'ar_rapid');
    assert.equal(b.world.last('spawnLocal')[0].name, '구름', '표시 이름은 계정 닉네임');

    await env.run(100);
    const announced = env.hub.decoded(EV.loadout, 'b').at(-1).loadout;
    assert.equal(announced.pick, 'ar_rapid');
    assert.equal(announced.secondary, 'pt_magnum');
    assert.equal(announced.melee, 'ml_knife');
    assert.equal(a.session.match.state.players.find((p) => p.id === 'b').loadout, 'ar_rapid', '고르기 전에도 계정 장비가 방장에게 간다');

    // 멤버가 샷건을 고른다
    b.ui.fire('loadout:pick', { id: 'sg_bx12' });
    await env.run(150);
    assert.equal(env.hub.decoded(EV.loadout, 'b').at(-1).loadout.pick, 'sg_bx12');
    assert.equal(a.session.match.state.players.find((p) => p.id === 'b').loadout, 'sg_bx12');

    // 라운드가 시작되기 전까지 몇 번이든 바꾼다: 저격총으로 갔다가 다시 샷건
    b.ui.fire('loadout:pick', { id: 'sr_twin' });
    await env.run(150);
    assert.equal(a.session.match.state.players.find((p) => p.id === 'b').loadout, 'sr_twin');
    b.ui.fire('loadout:pick', { id: 'sg_bx12' });
    await env.run(150);
    assert.equal(a.session.match.state.players.find((p) => p.id === 'b').loadout, 'sg_bx12', '같은 라운드에 되돌린 선택도 방장에게 간다');
    assert.equal(b.world.calls('closeSwap').length, 0, '대기 시간 동안은 교체를 끄지 않는다');

    // 방장 화면의 아바타: 슬롯은 상태 메시지, 무기는 그 사람의 장비
    await env.run(1300);
    assert.equal(a.session.state.matchPhase, 'live');
    assert.ok(b.world.calls('closeSwap').length >= 1, '라운드가 시작되면 교체를 끈다');
    assert.equal(b.world.last('setLocalLoadout')[0], 'sg_bx12');
    // 시작한 뒤의 선택은 이번 라운드에 반영되지 않는다(다음 라운드 기본값으로만 남는다)
    b.ui.fire('loadout:pick', { id: 'sr_twin' });
    await env.run(150);
    assert.equal(a.session.match.state.players.find((p) => p.id === 'b').loadout, 'sg_bx12');
    // 움직이는 지형은 방장 시계로 돈다
    const moverClock = b.world.last('setMoverClock')[0];
    assert.equal(typeof moverClock, 'function');
    assert.ok(Number.isFinite(moverClock()) && Math.abs(moverClock() - env.clock.t / 1000) < 1, '초 단위 방장 시계');
    env.frames();
    assert.equal(a.world.last('setActorState')[1].weaponId, 'sg_bx12');
    b.world.slot = 3;
    await env.run(600);
    env.frames();
    assert.equal(a.world.last('setActorState')[1].slot, 3);
    assert.equal(a.world.last('setActorState')[1].weaponId, 'ml_knife', '칼은 하드코딩이 아니라 그 사람이 쓰는 칼');
    b.world.slot = 2;
    await env.run(600);
    env.frames();
    assert.equal(a.world.last('setActorState')[1].weaponId, 'pt_magnum');
    b.world.slot = 1;

    // 샷건 한 발: 펠릿 5개가 몸에 맞았다(방장이 잰 거리도 5 m 안이어야 한다)
    await standNear(env, b, a, 3);
    b.world.fire('hitClaim', { victimId: 'a', part: 'body', weaponId: 'sg_bx12', dist: 5, kind: 'shot', t: env.clock.t, count: 5, shotId: 7, point: [0, 0, 0], origin: [0, 0, 0] });
    await env.run(200);
    const claim = env.hub.decoded(EV.hit, 'b').at(-1);
    assert.equal(claim.count, 5);
    assert.equal(claim.shotId, 7);
    assert.deepEqual(a.world.last('setLocalHp'), [30], '14 × 5 = 70');
    assert.equal(b.world.last('feedbackDamage')[0].amount, 70);
    assert.equal(b.world.last('feedbackDamage')[0].half, false);
    assert.equal(b.world.last('feedbackDamage')[0].incoming, false);

    // 두 번째 발로 끝낸다
    await env.run(1000);
    b.world.fire('hitClaim', { victimId: 'a', part: 'body', weaponId: 'sg_bx12', dist: 5, kind: 'shot', t: env.clock.t, count: 8, shotId: 8, point: [0, 0, 0], origin: [0, 0, 0] });
    await env.run(200);
    assert.equal(a.world.calls('killLocal').length, 1);
    assert.equal(b.ui.feed.at(-1).killer, '구름');
    assert.equal(b.ui.feed.at(-1).half, false);
    await env.run(400);

    assert.equal(a.session.phase, 'results');
    assert.equal(b.session.phase, 'results');
    assert.equal(b.account.recorded.length, 1);
    assert.equal(a.account.recorded.length, 1);
    const seconds = b.account.recorded[0].seconds;
    assert.ok(seconds >= 3 && seconds <= 8, `경기 시간 ${seconds}초`);
    assert.deepEqual(b.account.recorded[0], {
      online: true, ruleset: 'classic', mode: 'team', mapId: 'jetty',
      kills: 1, deaths: 0, headshots: 0, halfShots: 0, knifeKills: 0, win: true, draw: false, seconds
    });
    assert.equal(a.account.recorded[0].deaths, 1);
    assert.equal(a.account.recorded[0].win, false);
    assert.deepEqual(b.ui.lastShown('results').reward, { ...REWARD });
    assert.equal(b.ui.lastShown('results').winner, 'charterer');

    // 방장이 스냅샷을 계속 다시 보내도, 방으로 돌아가도 다시 기록하지 않는다
    await env.run(2200);
    b.ui.fire('results:back', {});
    a.ui.fire('results:back', {});
    await env.run(2200);
    assert.equal(b.session.phase, 'room');
    assert.equal(b.account.recorded.length, 1);
    assert.equal(a.account.recorded.length, 1);
    env.dispose();
  });

  test('개인전 칼전: 맵 다시 고르기, 총 주장 거절, 칼 무기 표시, knifeKills', async (t) => {
    const env = stage(t);
    const a = env.client('a', '하늘');
    const b = env.client('b', '구름', { loadout: { primary: 'ar_std', secondary: 'pt_std', melee: 'ml_knife' } });
    await startMatch(env, [a, b], { mapId: 'jetty', mode: 'ffa', ruleset: 'knife', max: 2 });

    assert.equal(env.hub.lastCreate.mapId, 'rooftop', '이 규칙에서 못 쓰는 맵은 그 규칙의 첫 맵으로 다시 고른다');
    assert.deepEqual(env.hub.list()[0].ruleset, 'knife');
    assert.deepEqual(env.hub.list()[0].mode, 'ffa');
    assert.deepEqual(b.world.calls('loadMap')[0], ['rooftop', { mode: 'ffa', ruleset: 'knife' }]);
    assert.equal(a.session.match.rules.ruleset, 'knife');

    const screen = b.ui.lastShown('loadout');
    assert.deepEqual([...screen.weapons].sort(), ['ml_katana', 'ml_knife']);
    assert.equal(screen.selected, 'ml_knife');
    assert.equal(screen.ruleset, 'knife');
    await env.run(100);
    assert.equal(env.hub.decoded(EV.loadout, 'b').at(-1).loadout.pick, 'ml_knife');

    await env.run(1500);
    assert.equal(a.session.state.matchPhase, 'live');
    assert.equal(b.world.last('spawnLocal')[0].loadout, 'ml_knife', '칼전의 부활 무기는 고른 칼');

    // 칼전에 총은 안 된다
    b.world.fire('hitClaim', { victimId: 'a', part: 'head', weaponId: 'ar_std', dist: 5, kind: 'shot', t: env.clock.t, count: 1, shotId: 1 });
    await env.run(150);
    assert.ok(a.logs.some((l) => l[0] === 'reject' && l[1].reason === 'ruleset'), '방장이 규칙으로 거절');
    assert.equal(a.world.calls('setLocalHp').length, 0);

    // 사격 메시지의 칼이 아바타에 그대로 간다
    b.world.fire('fire', { weaponId: 'ml_katana', origin: [0, 1, 0], dir: [0, 0, -1], hitPoint: null, hitKind: 'none', dist: 0, t: env.clock.t, kind: 'slash' });
    await env.run(500);
    env.frames();
    assert.equal(a.world.last('actorFire')[0].weaponId, 'ml_katana');
    assert.equal(a.world.last('actorFire')[0].kind, undefined, '베기는 기본값이라 싣지 않는다');
    assert.equal(a.world.last('setActorState')[1].weaponId, 'ml_katana');

    // 강타 연출: 원격의 칼과 강타 소리
    b.world.fire('fire', { weaponId: 'ml_knife', origin: [0, 1, 0], dir: [0, 0, -1], hitPoint: null, hitKind: 'none', dist: 0, t: env.clock.t, kind: 'stab' });
    await env.run(500);
    env.frames();
    const fired = a.world.last('actorFire')[0];
    assert.equal(fired.weaponId, 'ml_knife');
    assert.equal(fired.kind, 'stab');
    const drawn = a.world.last('setActorState')[1];
    assert.equal(drawn.slot, 3, '칼전 아바타는 칼 슬롯');
    assert.equal(drawn.weaponId, 'ml_knife');

    // 찌르기 킬(칼은 실제로 붙어 있어야 한다)
    await standNear(env, b, a);
    b.world.fire('hitClaim', { victimId: 'a', part: 'body', weaponId: 'ml_knife', dist: 1, kind: 'stab', t: env.clock.t, count: 1, shotId: 2 });
    await env.run(200);
    assert.equal(a.world.calls('killLocal').length, 1);
    const compact = a.ui.lastShown('loadout');
    assert.equal(compact.compact, true);
    assert.equal(compact.ruleset, 'knife');
    assert.deepEqual([...compact.weapons].sort(), ['ml_katana', 'ml_knife']);

    // 시간이 다 되면 끝난다
    await env.run(6000);
    assert.equal(b.session.phase, 'results');
    assert.equal(b.account.recorded.length, 1);
    const s = b.account.recorded[0];
    assert.equal(s.ruleset, 'knife');
    assert.equal(s.mode, 'ffa');
    assert.equal(s.mapId, 'rooftop');
    assert.equal(s.kills, 1);
    assert.equal(s.knifeKills, 1);
    assert.equal(s.win, true);
    assert.equal(a.account.recorded[0].win, false);
    assert.equal(a.account.recorded[0].deaths, 1);
    assert.deepEqual(b.ui.lastShown('results').reward, { ...REWARD });

    // 대기실에서 규칙 바꾸기: 방장만, 맵은 그 규칙에 맞게
    a.ui.fire('results:back', {});
    b.ui.fire('results:back', {});
    b.ui.fire('room:ruleset', { ruleset: 'sniper' });
    assert.equal(a.session.room.meta.ruleset, 'knife', '방장이 아니면 못 바꾼다');
    a.ui.fire('room:ruleset', { ruleset: 'sniper' });
    assert.equal(a.session.room.meta.ruleset, 'sniper');
    assert.equal(a.session.room.meta.mapId, 'longshot', '칼전 맵은 스나전에서 못 쓴다');
    assert.equal(b.ui.props('room').ruleset, 'sniper');
    assert.equal(b.ui.props('room').mapId, 'longshot');
    a.ui.fire('room:map', { mapId: 'rooftop' });
    assert.equal(a.session.room.meta.mapId, 'longshot', '규칙에 안 맞는 맵은 거른다');
    a.ui.fire('room:map', { mapId: 'nexus' });
    assert.equal(a.session.room.meta.mapId, 'nexus');
    assert.equal(env.hub.list()[0].ruleset, 'sniper', '로비 목록에도 반영');
    env.dispose();
  });

  test('폭파 미션: 미션 맵·클래식 고정 → E 의도가 방장에게 → 설치 → 해체 → 수비 승 결과', async (t) => {
    const env = stage(t);
    const mk = (id, name) => {
      const c = env.client(id, name, {}, { maps: bombMaps, bombRules: { plantMs: 600, defuseMs: 800, fuseMs: 20000 } });
      c.world.loadMap = async (...args) => { c.world.loaded = args; return { spawns: SPAWNS, mission: BOMB_MISSION, mapName: args[0] }; };
      return c;
    };
    const a = mk('a', '하늘');
    const b = mk('b', '구름');
    await startMatch(env, [a, b], { mapId: 'jetty', mode: 'bomb', ruleset: 'knife' });
    assert.equal(env.hub.lastCreate.mode, 'bomb');
    assert.equal(env.hub.lastCreate.ruleset, 'classic', '폭파 미션은 클래식 고정');
    assert.equal(env.hub.lastCreate.mapId, 'relay', '미션 맵으로 바뀐다');
    assert.deepEqual(a.world.loaded, ['relay', { mode: 'bomb', ruleset: 'classic' }]);
    assert.equal(a.session.match.rules.mode, 'bomb');
    assert.equal(a.session.match.rules.plantMs, 600);
    await env.run(1600);
    assert.equal(a.session.state.matchPhase, 'live');
    assert.equal(a.session.match.attack, 'owner');
    // 공격 진영 스폰에 서고, 폭탄은 공격 팀 한 명(a)에게
    const sp = a.world.last('spawnLocal')[0].spawn;
    assert.ok(BOMB_MISSION.attack.some((s) => s.x === sp.x && s.z === sp.z), `공격 진영 스폰: ${JSON.stringify(sp)}`);
    const st = b.world.last('setBomb')[0];
    assert.equal(st.attack, 'owner');
    assert.equal(st.state, 'carried');
    assert.equal(st.carrier, 'a');
    assert.equal(a.world.last('setRound')[0].mode, 'bomb');
    assert.equal(a.world.last('setRound')[0].attack, 'owner');
    assert.ok(a.world.calls('bombEvent').some(([e]) => e.act === 'give' && e.id === 'a'));
    // 구역 밖에서 누르면 방장이 거절한다(상태는 그대로)
    a.world.fire('bombAction', { act: 'plant' });
    await env.run(200);
    assert.equal(a.session.match.state.bomb.action, null);
    // A 구역에서 설치
    a.world.pos = [10, 0, 10];
    await env.run(200);
    a.world.fire('bombAction', { act: 'plant' });
    await env.run(200);
    assert.equal(a.session.match.state.bomb.action.kind, 'plant');
    await env.run(600);
    const planted = b.world.last('setBomb')[0];
    assert.equal(planted.state, 'planted');
    assert.equal(planted.site, 'A');
    assert.ok(b.world.calls('bombEvent').some(([e]) => e.act === 'plant' && e.site === 'A'), '멤버도 설치 이벤트를 받는다');
    // 수비(b)가 폭탄 옆에서 해체: 의도는 g2b로 방장에게 간다
    b.world.pos = [10.6, 0, 10.4];
    await env.run(400);
    b.world.fire('bombAction', { act: 'defuse' });
    await env.run(200);
    assert.equal(env.hub.decoded(EV.bomb, 'b').at(-1).act, 'defuse');
    assert.equal(a.session.match.state.bomb.action.kind, 'defuse');
    await env.run(1200);
    assert.equal(b.session.phase, 'results');
    const res = b.ui.lastShown('results');
    assert.equal(res.mode, 'bomb');
    assert.equal(res.winner, 'charterer');
    assert.equal(res.rounds[0].reasonCode, 'defuse');
    assert.equal(res.rounds[0].attack, 'owner');
    assert.equal(res.rounds[0].reason, '폭탄 해체');
    assert.equal(b.account.recorded[0].mode, 'bomb');
    assert.equal(b.account.recorded[0].win, true);
    env.dispose();
  });

  test('폭파 미션 방장 이전: 새 방장이 미션 칸으로 그 라운드를 다시 하고, 남은 공격수가 설치해 폭발로 끝난다', async (t) => {
    const env = stage(t);
    const mk = (id, name) => {
      const c = env.client(id, name, {}, { maps: bombMaps, bombRules: { plantMs: 600, defuseMs: 800, fuseMs: 3000 } });
      c.world.loadMap = async (...args) => ({ spawns: SPAWNS, mission: BOMB_MISSION, mapName: args[0] });
      return c;
    };
    const a = mk('a', '하늘');
    const b = mk('b', '구름');
    const c = mk('c', '바다');
    await startMatch(env, [a, b, c], { mapId: 'relay', mode: 'bomb' });
    await env.run(1600);
    assert.equal(a.session.state.matchPhase, 'live');
    assert.deepEqual([a.session.state.team, b.session.state.team, c.session.state.team], ['owner', 'charterer', 'owner']);

    // 방장(공격)이 나간다 → 구름(수비)이 이어받아 같은 라운드를 처음부터: 폭탄은 남은 공격수(바다)에게
    await a.session.leave();
    await env.run(100);
    assert.equal(b.session.isHost, true);
    const m = b.session.match;
    assert.ok(m, '새 방장이 경기를 돌린다');
    assert.equal(m.rules.mode, 'bomb');
    assert.equal(m.mission.sites.length, 2, '미션 칸을 이어받는다');
    assert.equal(m.attack, 'owner');
    assert.equal(m.state.bomb.carrier, 'c');
    assert.equal(m.state.round, 1);
    await env.run(1600);
    assert.equal(b.session.state.matchPhase, 'live');
    assert.equal(c.world.last('setBomb')[0].carrier, 'c');

    // 바다가 A 구역에서 설치 → 폭발 → 공격(블루) 승
    c.world.pos = [10, 0, 10];
    await env.run(300);
    c.world.fire('bombAction', { act: 'plant' });
    await env.run(900);
    assert.equal(b.world.last('setBomb')[0].state, 'planted');
    await env.run(3300);
    assert.ok(c.world.calls('bombEvent').some(([e]) => e.act === 'explode'), '폭발 이벤트');
    await env.run(600);
    assert.equal(c.session.phase, 'results');
    const res = c.ui.lastShown('results');
    assert.equal(res.mode, 'bomb');
    assert.equal(res.winner, 'owner');
    assert.equal(res.rounds.at(-1).reasonCode, 'bomb');
    assert.equal(c.account.recorded.length, 1);
    assert.equal(c.account.recorded[0].win, true);
    assert.equal(b.account.recorded[0].win, false);
    assert.equal(a.account.recorded.length, 0, '나간 사람은 기록하지 않는다');
    env.dispose();
  });

  test('폭파 미션: 수류탄은 던지는 순간 해체를 끊고, 던진 뒤 시작한 해체는 그 수류탄이 터져도 이어진다', async (t) => {
    const env = stage(t);
    const mk = (id, name) => {
      const c = env.client(id, name, {}, { maps: bombMaps, bombRules: { plantMs: 600, defuseMs: 1500, fuseMs: 20000 } });
      c.world.loadMap = async (...args) => ({ spawns: SPAWNS, mission: BOMB_MISSION, mapName: args[0] });
      return c;
    };
    const a = mk('a', '하늘');
    const b = mk('b', '구름');
    await startMatch(env, [a, b], { mapId: 'relay', mode: 'bomb' });
    await env.run(1600);
    a.world.pos = [10, 0, 10];
    await env.run(200);
    a.world.fire('bombAction', { act: 'plant' });
    await env.run(900);
    const bombOf = () => a.session.match.state.bomb;
    assert.equal(bombOf().state, 'planted');
    // 수비(구름)가 해체하다 수류탄을 던진다 → 방장이 던짐(g2x)을 받자마자 끊는다
    b.world.pos = [10.6, 0, 10.4];
    await env.run(400);
    b.world.fire('bombAction', { act: 'defuse' });
    await env.run(200);
    assert.equal(bombOf().action.kind, 'defuse');
    b.world.fire('grenade', { pos: [10.6, 1.5, 10.4], vel: [0, 2, 3], t: env.clock.t });
    await env.run(200);
    assert.equal(bombOf().action, null, '던지면 해체가 끊긴다');
    assert.ok(b.world.calls('bombEvent').some(([e]) => e.act === 'defuseCancel' && e.reason === 'fired'), '취소 이유: 공격');
    // 던진 뒤 다시 해체 → 그 수류탄이 방장 화면에서 터져도(claimExplosion) 이어진다
    b.world.fire('bombAction', { act: 'defuse' });
    await env.run(200);
    assert.equal(bombOf().action.kind, 'defuse');
    a.world.fire('explosion', { ownerId: 'b', center: [10.6, 0.2, 13.4], victims: [] });
    await env.run(100);
    assert.equal(bombOf().action && bombOf().action.kind, 'defuse', '터질 때는 끊지 않는다');
    await env.run(1600);
    assert.equal(b.session.phase, 'results');
    assert.equal(b.ui.lastShown('results').rounds[0].reasonCode, 'defuse');
    env.dispose();
  });

  test('대기실: 칼전 방을 폭파 미션으로 바꿨다가 되돌리면 칼전과 전 맵이 돌아온다', async (t) => {
    const env = stage(t);
    const a = env.client('a', '하늘', {}, { maps: bombMaps });
    await a.session.open();
    a.ui.fire('lobby:create', { name: '', max: 4, mapId: 'dojo', mode: 'team', ruleset: 'knife' });
    await env.settle();
    const meta = () => { const x = a.session.room.meta; return [x.mode, x.ruleset, x.mapId]; };
    assert.deepEqual(meta(), ['team', 'knife', 'dojo']);
    a.ui.fire('room:mode', { mode: 'bomb' });
    assert.deepEqual(meta(), ['bomb', 'classic', 'relay'], '폭파 미션은 클래식 · 미션 맵');
    a.ui.fire('room:mode', { mode: 'team' });
    assert.deepEqual(meta(), ['team', 'knife', 'dojo'], '폭파 미션 전 규칙과 맵이 돌아온다');
    assert.equal(env.hub.list()[0].ruleset, 'knife', '로비 목록에도 반영');
    // 개인전으로 돌아가도 같다. 폭파 미션 안에서 고른 미션 맵이 전 규칙에서도 되면 그 맵을 둔다
    a.ui.fire('room:mode', { mode: 'bomb' });
    a.ui.fire('room:mode', { mode: 'ffa' });
    assert.deepEqual(meta(), ['ffa', 'knife', 'dojo']);
    a.ui.fire('room:ruleset', { ruleset: 'classic' });
    a.ui.fire('room:mode', { mode: 'bomb' });
    a.ui.fire('room:mode', { mode: 'team' });
    assert.deepEqual(meta(), ['team', 'classic', 'relay'], '클래식이면 미션 맵도 팀전에서 쓸 수 있다');
    env.dispose();
  });

  test('개인전 목표 킬: 방장만 5~20킬로 바꾸고, 경기는 그 킬 수에 닿으면 끝난다', async (t) => {
    const env = stage(t, { ffaRules: { timeLimitMs: 60000 } });
    const a = env.client('a', '하늘');
    const b = env.client('b', '구름', { loadout: { primary: 'ar_std', secondary: 'pt_std', melee: 'ml_knife' } });
    await a.session.open();
    a.ui.fire('lobby:create', { name: '', max: 2, mapId: 'alley', mode: 'ffa', ruleset: 'knife', killTarget: 3 });
    await env.settle();
    assert.equal(env.hub.lastCreate.killTarget, 5, '5킬보다 낮은 값은 5킬로');
    assert.equal(a.ui.props('room').killTarget, 5);
    assert.equal(env.hub.list()[0].killTarget, 5, '로비 목록에도 간다');

    await b.session.open();
    b.ui.fire('lobby:join', { roomId: env.hub.roomId });
    await env.settle();
    assert.equal(b.ui.props('room').killTarget, 5);
    assert.ok(b.ui.props('room').chat.some((l) => l.system && l.text.includes('먼저 5킬')), '들어온 사람에게 목표 킬을 알린다');

    b.ui.fire('room:killTarget', { killTarget: 10 });
    assert.equal(a.session.room.meta.killTarget, 5, '방장이 아니면 못 바꾼다');

    // 방장이 연달아 바꾸면 안내는 한 줄을 고쳐 쓴다
    const notes = () => b.ui.props('room').chat.filter((l) => l.system && l.text.startsWith('목표 킬이'));
    a.ui.fire('room:killTarget', { killTarget: 99 });
    assert.equal(a.session.room.meta.killTarget, 20, '20킬보다 높은 값은 20킬로');
    a.ui.fire('room:killTarget', { killTarget: 12 });
    a.ui.fire('room:killTarget', { killTarget: '7' });
    assert.equal(b.ui.props('room').killTarget, 7);
    assert.equal(notes().length, 1, JSON.stringify(notes()));
    assert.ok(notes()[0].text.includes('7킬로'), notes()[0].text);
    assert.equal(env.hub.list()[0].killTarget, 7);
    a.ui.fire('room:killTarget', { killTarget: 'abc' });
    a.ui.fire('room:killTarget', {});
    assert.equal(a.session.room.meta.killTarget, 7, '숫자가 아니면 무시한다');

    // 팀전에서는 바꾸지 않고 로비 항목에도 싣지 않는다. 개인전으로 돌아오면 고른 값이 남아 있다
    a.ui.fire('room:mode', { mode: 'team' });
    a.ui.fire('room:killTarget', { killTarget: 15 });
    assert.equal(a.session.room.meta.killTarget, 7);
    assert.equal(env.hub.list()[0].killTarget, undefined);
    a.ui.fire('room:mode', { mode: 'ffa' });
    assert.equal(b.ui.props('room').killTarget, 7);
    assert.ok(b.ui.props('room').chat.at(-1).text.includes('먼저 7킬'), b.ui.props('room').chat.at(-1).text);
    a.ui.fire('room:killTarget', { killTarget: 5 });
    assert.equal(b.ui.props('room').killTarget, 5);

    b.ui.fire('room:ready', { ready: true });
    a.ui.fire('room:start', {});
    await env.settle();
    await env.run(250);
    assert.equal(a.session.match.rules.killTarget, 5, '방장이 고른 값으로 경기를 만든다');
    await env.run(1700);
    assert.equal(a.session.state.matchPhase, 'live');
    assert.equal(b.world.last('setRound')[0].target, 5, '멤버 HUD의 목표 킬');

    // 방장(맞는 쪽)이 다가간다. 방장 자신의 위치는 이동 검사를 받지 않아서 여러 번 옮겨도 된다
    const stab = async (i) => {
      await env.run(400);   // 부활(300ms)을 기다린다
      a.world.pos = [b.world.pos[0] + 1.2, b.world.pos[1], b.world.pos[2]];
      await env.run(400);
      b.world.fire('hitClaim', { victimId: 'a', part: 'body', weaponId: 'ml_knife', dist: 1, kind: 'stab', t: env.clock.t, count: 1, shotId: 20 + i });
      await env.run(200);
    };
    for (let i = 1; i <= 4; i++) {
      await stab(i);
      assert.equal(a.world.calls('killLocal').length, i, `${i}번째 킬`);
    }
    assert.equal(a.session.state.matchPhase, 'live', '4킬로는 끝나지 않는다');
    await stab(5);
    await env.run(400);
    assert.equal(b.session.phase, 'results');
    const res = b.ui.lastShown('results');
    assert.equal(res.target, 5);
    assert.equal(res.reason, 'kills');
    assert.equal(res.winnerId, 'b');
    assert.equal(b.account.recorded[0].win, true);
    assert.equal(b.account.recorded[0].kills, 5);
    assert.equal(b.account.recorded[0].killTarget, 5, '짧은 판의 승리 보상을 줄이도록 목표 킬을 싣는다');
    assert.equal(a.account.recorded[0].killTarget, 5);
    env.dispose();
  });

  test('방장 이전(라이브): 반샷·선택·규칙을 이어받고 기록은 한 번', async (t) => {
    const env = stage(t);
    const a = env.client('a', '하늘');
    const b = env.client('b', '구름');
    const c = env.client('c', '바다');
    await startMatch(env, [a, b, c], { mapId: 'longshot', ruleset: 'sniper' });
    b.ui.fire('loadout:pick', { id: 'sr_twin' });
    await env.run(1500);
    assert.equal(a.session.state.matchPhase, 'live');
    assert.equal(b.session.state.team, 'charterer');
    assert.equal(c.session.state.team, 'owner');

    // 구름이 바다의 손을 맞힌다: 저격 반샷 50
    b.world.fire('hitClaim', { victimId: 'c', part: 'hand', weaponId: 'sr_twin', dist: 40, kind: 'shot', t: env.clock.t, count: 1, shotId: 1 });
    await env.run(200);
    assert.equal(b.world.last('feedbackDamage')[0].half, true);
    assert.equal(b.world.last('feedbackDamage')[0].amount, 50);
    assert.equal(a.session.match.state.players.find((p) => p.id === 'b').halfShots, 1);

    // 방장이 나간다 → 구름이 이어받아 같은 라운드를 다시 한다
    await a.session.leave();
    await env.run(100);
    assert.equal(b.session.isHost, true);
    assert.ok(b.session.match, '새 방장이 경기를 돌린다');
    assert.equal(b.session.match.rules.ruleset, 'sniper');
    assert.equal(b.session.match.state.players.find((p) => p.id === 'b').halfShots, 1);
    assert.equal(b.session.match.state.players.find((p) => p.id === 'b').loadout, 'sr_twin');
    assert.equal(a.account.recorded.length, 0, '나간 사람은 기록하지 않는다');

    await env.run(1600);
    assert.equal(b.session.state.matchPhase, 'live');
    assert.equal(b.world.last('setLocalLoadout')[0], 'sr_twin', '이어받은 뒤에도 고른 무기');

    // 다시 시작한 라운드에서 반샷 두 번으로 끝낸다
    b.world.fire('hitClaim', { victimId: 'c', part: 'foot', weaponId: 'sr_twin', dist: 40, kind: 'shot', t: env.clock.t, count: 1, shotId: 2 });
    await env.run(1500);
    b.world.fire('hitClaim', { victimId: 'c', part: 'hand', weaponId: 'sr_twin', dist: 40, kind: 'shot', t: env.clock.t, count: 1, shotId: 3 });
    await env.run(200);
    assert.equal(b.ui.feed.at(-1).half, true, '반샷 킬은 킬피드에 표시');
    await env.run(600);

    assert.equal(b.session.phase, 'results');
    assert.equal(c.session.phase, 'results');
    assert.equal(b.account.recorded.length, 1);
    assert.equal(c.account.recorded.length, 1);
    assert.equal(b.account.recorded[0].halfShots, 3, '이전 전 1 + 이전 뒤 2');
    assert.equal(b.account.recorded[0].kills, 1);
    assert.equal(b.account.recorded[0].win, true);
    assert.equal(b.account.recorded[0].ruleset, 'sniper');
    assert.equal(c.account.recorded[0].deaths, 1);
    await env.run(2200);
    assert.equal(b.account.recorded.length, 1);
    assert.equal(c.account.recorded.length, 1);
    env.dispose();
  });

  test('방장 검증: 멀리서 칼로 찔렀다는 주장은 방장이 잰 거리로 거절하고, 반복하면 경기에서 빼고 내보낸다', async (t) => {
    const env = stage(t);
    const a = env.client('a', '하늘');
    const b = env.client('b', '구름');
    await startMatch(env, [a, b], { mapId: 'alley', ruleset: 'knife' });
    await env.run(1500);
    assert.equal(a.session.state.matchPhase, 'live');
    // 30 m 떨어져 있으면서 1 m에서 찔렀다고 우긴다
    b.world.pos = [a.world.pos[0] + 30, 0, a.world.pos[2]];
    await env.run(400);
    for (let i = 0; i < 8; i++) {
      b.world.fire('hitClaim', { victimId: 'a', part: 'body', weaponId: 'ml_knife', dist: 1, kind: 'stab', t: env.clock.t, count: 1, shotId: 20 + i });
      await env.run(1100);
    }
    assert.equal(a.world.calls('killLocal').length, 0, '한 번도 맞지 않는다');
    assert.ok(a.logs.some((l) => l[0] === 'ban' && l[1] === 'b'), '반복하면 내보낸다');
    const m = a.session.match;   // 상대가 하나뿐이면 빠지는 순간 기권승으로 경기가 끝난다
    const gone = m && m.state.players.find((p) => p.id === 'b');
    assert.ok(!gone || gone.connected === false, '경기에서 빠진다');
    env.dispose();
  });

  test('방장 이전(승부가 난 라운드 끝): 새 방장이 끝내고 기록은 사람마다 한 번', async (t) => {
    const env = stage(t, { rules: { roundEndMs: 1000 } });
    const a = env.client('a', '하늘');
    const b = env.client('b', '구름');
    const c = env.client('c', '바다');
    await startMatch(env, [a, b, c], { mapId: 'alley', ruleset: 'knife' });
    await env.run(1500);
    assert.equal(a.session.state.matchPhase, 'live');
    const stab = { weaponId: 'ml_katana', part: 'body', dist: 1, kind: 'stab', count: 1 };
    await standNear(env, c, b);
    c.world.fire('hitClaim', { ...stab, victimId: 'b', t: env.clock.t, shotId: 1 });
    await env.run(150);
    assert.equal(a.session.state.matchPhase, 'roundEnd');

    await a.session.leave();
    await env.run(100);
    assert.equal(b.session.isHost, true);
    assert.equal(b.account.recorded.length, 0);
    await env.run(1200);
    assert.equal(b.session.phase, 'results');
    assert.equal(c.session.phase, 'results');
    assert.equal(c.account.recorded.length, 1);
    assert.equal(b.account.recorded.length, 1);
    assert.equal(c.account.recorded[0].knifeKills, 1);
    assert.equal(c.account.recorded[0].win, true);
    assert.equal(b.account.recorded[0].win, false);
    await env.run(2200);
    assert.equal(c.account.recorded.length, 1);
    assert.equal(b.account.recorded.length, 1);
    env.dispose();
  });

  test('한 번도 출격하지 않은 사람은 기록하지 않는다', () => {
    const view = { phase: 'matchEnd', players: [{ id: 'a', kills: 2, deaths: 0, headshots: 0, halfShots: 0 }], result: { winner: 'owner' } };
    assert.equal(matchSummary({ view, me: 'z', mode: 'team', ruleset: 'classic', mapId: 'alley', team: 'owner' }), null);
  });
});

describe('대기실 자리 비움', () => {
  /** 방장 a가 방을 만들고 손님 b가 들어와 0.5초 지난 뒤 */
  async function roomOfTwo(t) {
    const env = stage(t);
    const a = env.client('a', '하늘');
    const b = env.client('b', '바다');
    await a.session.open();
    a.ui.fire('lobby:create', { name: '', max: 4, mapId: 'jetty', mode: 'team' });
    await env.settle();
    await b.session.open();
    b.ui.fire('lobby:join', { roomId: env.hub.roomId });
    await env.settle();
    await env.run(500, 500);
    assert.equal(a.session.phase, 'room');
    assert.equal(b.session.phase, 'room');
    return { env, a, b };
  }
  const idleLeft = (c) => c.ui.props('room').idleLeft;

  test('1분 동안 아무 일이 없으면 10초 전에 모두에게 안내가 뜨고, 1분이 되면 방장이 방을 닫아 모두 로비로 간다', async (t) => {
    const { env, a, b } = await roomOfTwo(t);
    await env.run(48500, 500);   // 49초
    assert.equal(idleLeft(a), 0, '아직 안내 없음');
    await env.run(2000, 500);    // 51초
    assert.ok(idleLeft(a) > 0 && idleLeft(a) <= 10, `방장 화면 안내 ${idleLeft(a)}초`);
    assert.ok(idleLeft(b) > 0 && idleLeft(b) <= 10, `손님 화면 안내 ${idleLeft(b)}초`);
    assert.ok(b.session.state.chat.some((l) => l.system && /곧 방을 닫아요/.test(l.text)), '손님 채팅에도 안내 줄');
    await env.run(10000, 500);   // 61초
    await env.settle();
    assert.equal(a.session.phase, 'lobby', '방장은 방을 닫고 로비로');
    assert.equal(b.session.phase, 'lobby', '손님도 로비로');
    assert.match(a.ui.lastShown('lobby').notice, /1분 동안 아무 활동이 없어 방을 닫았어요/);
    assert.match(b.ui.lastShown('lobby').notice, /1분 동안 아무 활동이 없어 방을 닫았어요/);
    assert.equal(env.hub.members.size, 0, '방에 아무도 남지 않는다');
    env.dispose();
  });

  test('안내가 뜬 뒤 손님이 [계속 기다리기]를 누르면 안내가 모두에게서 거둬지고 다시 1분을 센다', async (t) => {
    const { env, a, b } = await roomOfTwo(t);
    await env.run(51000, 500);
    assert.ok(idleLeft(b) > 0, '안내가 떴다');
    b.ui.fire('room:stay', {});
    await env.run(1000, 500);
    assert.equal(idleLeft(b), 0, '누른 손님의 안내가 사라진다');
    assert.equal(idleLeft(a), 0, '방장 안내도 사라진다');
    await env.run(30000, 500);
    assert.equal(a.session.phase, 'room', '30초 뒤에도 방이 남아 있다');
    assert.equal(b.session.phase, 'room');
    await env.run(31000, 500);
    await env.settle();
    assert.equal(a.session.phase, 'lobby', '그 뒤 다시 1분이 지나면 닫힌다');
    env.dispose();
  });

  test('채팅·준비·설정·방장의 대기실 조작은 처음부터 다시 세게 하고, 핑만 바뀐 presence는 활동이 아니다', async (t) => {
    const { env, a, b } = await roomOfTwo(t);
    await env.run(40000, 500);
    b.ui.fire('room:chat', { text: '잠깐만요' });
    await env.run(40000, 500);
    assert.equal(a.session.phase, 'room', '채팅 뒤 40초: 아직 1분이 안 됐다');
    b.ui.fire('room:ready', { ready: true });
    await env.run(40000, 500);
    assert.equal(a.session.phase, 'room', '준비 뒤 40초');
    a.ui.fire('room:map', { mapId: 'alley' });
    await env.run(40000, 500);
    assert.equal(a.session.phase, 'room', '맵을 바꾼 뒤 40초');
    a.ui.fire('room:active', {});
    await env.run(40000, 500);
    assert.equal(a.session.phase, 'room', '방장이 대기실을 누른 뒤 40초');
    // 같은 사람·같은 칸에서 핑만 바뀐 presence(players)는 세지 않는다
    for (let i = 0; i < 6; i++) { env.hub.announce('players'); await env.run(10000, 500); }
    await env.settle();
    assert.equal(a.session.phase, 'lobby', '핑 갱신만 있으면 1분 뒤 닫힌다');
    assert.equal(b.session.phase, 'lobby');
    env.dispose();
  });

  test('경기 중에는 세지 않고, 경기가 끝나 결과 화면에 온 때부터 센다', async (t) => {
    const env = stage(t, { ffaRules: { timeLimitMs: 75000 } });
    const a = env.client('a', '하늘');
    const b = env.client('b', '바다');
    await startMatch(env, [a, b], { mode: 'ffa' });
    assert.equal(a.session.phase, 'match');
    await env.run(70000, 500);
    assert.equal(a.session.phase, 'match', '경기 중 70초가 지나도 방은 닫히지 않는다');
    for (let i = 0; i < 120 && a.session.phase === 'match'; i++) await env.run(500, 500);   // 시간 종료로 경기가 끝난다
    assert.equal(a.session.phase, 'results', '결과 화면');
    await env.run(48000, 500);
    assert.equal(a.session.phase, 'results', '결과 화면 48초: 아직 닫지 않는다');
    await env.run(13000, 500);
    await env.settle();
    assert.equal(a.session.phase, 'lobby', '결과 화면에서 1분 동안 아무 일이 없으면 닫힌다');
    assert.equal(b.session.phase, 'lobby');
    env.dispose();
  });
});

describe('방에서 나가기', () => {
  /** 방을 만들고, 서버가 나가기에 답할 때까지 room.leave가 끝나지 않게 한다 */
  async function hostInSlowRoom(t) {
    const env = stage(t);
    const a = env.client('a', '하늘');
    await a.session.open();
    a.ui.fire('lobby:create', { name: '', max: 4, mapId: 'jetty', mode: 'team' });
    await env.settle();
    assert.equal(a.session.phase, 'room');
    const room = a.session.room;
    const realLeave = room.leave.bind(room);
    const gate = {};
    room.leave = async () => { await new Promise((r) => { gate.answer = r; }); await realLeave(); };
    return { env, a, gate };
  }

  test('나가는 중에 ← 메뉴를 누르면 메뉴로 가고, 나가기가 끝나도 로비로 되돌리지 않는다', async (t) => {
    const { env, a, gate } = await hostInSlowRoom(t);
    let exits = 0;
    a.session.on('exit', () => { exits += 1; });
    a.ui.fire('room:leave', {});
    assert.equal(a.session.phase, 'leaving');
    assert.ok(a.ui.lastShown('lobby'), '나가는 동안 로비 화면이 보인다');
    a.ui.fire('lobby:back', {});
    assert.equal(exits, 1, '누른 ← 메뉴가 버려지지 않는다');
    assert.equal(a.session.phase, 'idle');
    gate.answer();
    await env.settle();
    assert.equal(a.session.phase, 'idle');
    assert.equal(exits, 1);
    env.dispose();
  });

  test('아무것도 누르지 않으면 나가기가 끝난 뒤 로비로 돌아온다', async (t) => {
    const { env, a, gate } = await hostInSlowRoom(t);
    a.ui.fire('room:leave', {});
    assert.equal(a.session.phase, 'leaving');
    gate.answer();
    await env.settle();
    assert.equal(a.session.phase, 'lobby');
    env.dispose();
  });

  test('나가는 중에 누른 방 만들기는 버리지 않고, 나가기가 끝나면 그 방을 만든다', async (t) => {
    const { env, a, gate } = await hostInSlowRoom(t);
    a.ui.fire('room:leave', {});
    assert.equal(a.session.phase, 'leaving');
    a.ui.fire('lobby:create', { name: '둘째 방', max: 2, mapId: 'alley', mode: 'team' });
    assert.equal(a.session.phase, 'leaving', '앞 방에서 다 나갈 때까지 기다린다');
    assert.equal(a.ui.props('lobby').loading, true, '기다리는 동안 로비는 불러오는 중으로 보인다');
    gate.answer();
    await env.settle();
    assert.equal(a.session.phase, 'room', '나가기가 끝나면 새 방으로 들어간다');
    assert.equal(env.hub.lastCreate.name, '둘째 방');
    assert.equal(env.hub.lastCreate.mapId, 'alley');
    assert.equal(a.session.room.meta.max, 2);
    env.dispose();
  });

  test('나가는 중에 누른 참가도 나가기가 끝나면 그 방으로 들어간다', async (t) => {
    const env = stage(t);
    const a = env.client('a', '하늘');
    const b = env.client('b', '구름');
    await a.session.open();
    a.ui.fire('lobby:create', { name: '', max: 4, mapId: 'jetty', mode: 'team' });
    await env.settle();
    await b.session.open();
    b.ui.fire('lobby:join', { roomId: env.hub.roomId });
    await env.settle();
    assert.equal(b.session.phase, 'room');
    const room = b.session.room;
    const realLeave = room.leave.bind(room);
    const gate = {};
    room.leave = async () => { await new Promise((r) => { gate.answer = r; }); await realLeave(); };
    b.ui.fire('room:leave', {});
    assert.equal(b.session.phase, 'leaving');
    b.ui.fire('lobby:join', { roomId: env.hub.roomId });
    assert.equal(b.ui.props('lobby').joining, env.hub.roomId, '누른 방에 참가 중으로 보인다');
    gate.answer();
    await env.settle();
    assert.equal(b.session.phase, 'room', '나가기가 끝나면 누른 방으로 들어간다');
    assert.ok(env.hub.members.has('b'));
    env.dispose();
  });

  test('나가는 중에 방 만들기를 누른 뒤 ← 메뉴를 누르면 방을 만들지 않는다', async (t) => {
    const { env, a, gate } = await hostInSlowRoom(t);
    const first = env.hub.lastCreate;
    a.ui.fire('room:leave', {});
    a.ui.fire('lobby:create', { name: '둘째 방', max: 4, mapId: 'jetty', mode: 'team' });
    a.ui.fire('lobby:back', {});
    gate.answer();
    await env.settle();
    assert.equal(a.session.phase, 'idle');
    assert.deepEqual(env.hub.lastCreate, first, '마지막으로 누른 ← 메뉴를 따른다');
    // 다시 멀티로 들어와도 버린 방 만들기가 뒤늦게 실행되지 않는다
    await a.session.open();
    await env.settle();
    assert.equal(a.session.phase, 'lobby');
    assert.deepEqual(env.hub.lastCreate, first);
    env.dispose();
  });
});

describe('팀 자동 배정', () => {
  /** a가 방을 연 직후 b가 들어온다. seen: b가 들어올 때 본 a의 presence(null = 아직 명단에 없음) */
  async function joinEarly(t, seen) {
    const env = stage(t);
    const a = env.client('a', '하늘');
    const b = env.client('b', '구름');
    await a.session.open();
    a.ui.fire('lobby:create', { name: '', max: 4, mapId: 'jetty', mode: 'team' });
    await env.settle();
    assert.equal(env.hub.members.get('a').team, 'owner');
    env.hub.lag.set('b', new Map([['a', seen]]));
    await b.session.open();
    b.ui.fire('lobby:join', { roomId: env.hub.roomId });
    await env.settle();
    assert.equal(b.session.phase, 'room');
    return { env, a, b };
  }
  const teams = (env) => [env.hub.members.get('a').team, env.hub.members.get('b').team];

  test('방장의 팀이 실린 presence보다 먼저 들어온 손님은, 방장의 팀을 알게 되면 다른 팀으로 옮긴다', async (t) => {
    const { env } = await joinEarly(t, { team: null });
    env.hub.deliver('b', 'a');
    assert.deepEqual(teams(env), ['owner', 'charterer'], '방장과 같은 팀에 남지 않는다');
    env.dispose();
  });

  test('명단에 방장이 아직 없을 때 들어와도, 방장이 보이면 다른 팀으로 옮긴다', async (t) => {
    const { env } = await joinEarly(t, null);
    env.hub.deliver('b', 'a');
    assert.deepEqual(teams(env), ['owner', 'charterer']);
    env.dispose();
  });

  test('방장의 팀을 이미 알고 들어오면 처음부터 다른 팀이고, 그 뒤에는 혼자 팀을 바꾸지 않는다', async (t) => {
    const env = stage(t);
    const a = env.client('a', '하늘');
    const b = env.client('b', '구름');
    await a.session.open();
    a.ui.fire('lobby:create', { name: '', max: 4, mapId: 'jetty', mode: 'team' });
    await env.settle();
    await b.session.open();
    b.ui.fire('lobby:join', { roomId: env.hub.roomId });
    await env.settle();
    assert.deepEqual(teams(env), ['owner', 'charterer']);
    const room = b.session.room;
    const updates = [];
    const real = room.updateMe.bind(room);
    room.updateMe = (fields) => { if ('team' in fields) updates.push(fields.team); return real(fields); };
    // 방장이 레드로 옮겨도 손님은 따라 움직이지 않는다(팀을 직접 고르는 것은 각자)
    a.ui.fire('room:team', { team: 'charterer' });
    env.hub.announce('players');
    assert.deepEqual(teams(env), ['charterer', 'charterer']);
    assert.deepEqual(updates, [], '들어올 때 정한 팀을 혼자 다시 고르지 않는다');
    env.dispose();
  });

  test('presence를 기다리는 동안 직접 고른 팀은 그대로 둔다', async (t) => {
    const { env, b } = await joinEarly(t, { team: null });
    b.ui.fire('room:team', { team: 'charterer' });
    b.ui.fire('room:team', { team: 'owner' });
    env.hub.deliver('b', 'a');
    assert.deepEqual(teams(env), ['owner', 'owner'], '레드로 갔다가 직접 블루로 돌아왔으면 블루에 둔다');
    env.dispose();
  });

  test('들어온 지 오래 지나서 온 presence로는 팀을 바꾸지 않는다', async (t) => {
    const { env } = await joinEarly(t, { team: null });
    env.clock.t += 60000;
    env.hub.deliver('b', 'a');
    assert.deepEqual(teams(env), ['owner', 'owner'], '대기실에 한참 있던 사람의 팀이 갑자기 바뀌지 않는다');
    env.dispose();
  });
});

describe('서버 설정이 없을 때', () => {
  test('계정이 오프라인이면 안내 문구만 보여 주고 던지지 않는다', async () => {
    const world = fakeWorld();
    const ui = fakeUi();
    const account = fakeAccount('하늘', { remoteEnabled: false });
    const s = createSession({ world, ui, ctx: { account, maps: fakeMaps }, setScreens: false });
    await s.open({ name: '다른이름' });
    assert.equal(s.phase, 'lobby');
    assert.equal(ui.props('lobby').error, '멀티플레이 서버 설정이 없어요.');
    assert.equal(ui.props('lobby').loading, false);
    assert.equal(ui.props('lobby').name, '하늘', '표시 이름은 계정 닉네임');
    assert.equal(account.retries, 1, '끝나지 않는 재등록을 기다리지 않는다');
    ui.fire('lobby:create', { name: 'x', mapId: 'alley' });
    ui.fire('lobby:join', { roomId: 'r' });
    assert.equal(s.phase, 'lobby');
    assert.equal(ui.props('lobby').error, '멀티플레이 서버 설정이 없어요.');
    ui.fire('lobby:refresh', {});
    await new Promise((r) => setImmediate(r));
    assert.equal(ui.props('lobby').error, '멀티플레이 서버 설정이 없어요.');
    s.dispose();
  });

  test('계정이 오프라인이면 연결을 시도하지 않는다', async () => {
    const ui = fakeUi();
    let connects = 0;
    const net = async () => { connects += 1; return null; };
    const s = createSession({ world: fakeWorld(), ui, ctx: { account: fakeAccount('하늘', { remoteEnabled: false }), maps: fakeMaps }, net, setScreens: false });
    await s.open();
    assert.equal(connects, 0);
    assert.equal(s.net, null);
    assert.equal(ui.props('lobby').error, '멀티플레이 서버 설정이 없어요.');
    s.dispose();
  });

  test('설정이 비면 실제 net 모듈도 같은 안내로 끝난다', async () => {
    const ui = fakeUi();
    const s = createSession({ world: fakeWorld(), ui, ctx: { account: fakeAccount('하늘'), maps: fakeMaps }, setScreens: false });
    await s.open();
    assert.equal(s.phase, 'lobby');
    assert.equal(ui.props('lobby').error, '멀티플레이 서버 설정이 없어요.');
    s.dispose();
  });
});

/* ================================================================== 순수 도우미 */

describe('장비 메시지', () => {
  test('preferredPick: 직전 선택 → 계정 장비 → 규칙 기본값', () => {
    const eq = { primary: 'ar_rapid', secondary: 'pt_std', melee: 'ml_knife' };
    assert.equal(preferredPick('classic', OWNED, eq), 'ar_rapid');
    assert.equal(preferredPick('classic', OWNED, eq, 'sg_bx12'), 'sg_bx12');
    assert.equal(preferredPick('knife', OWNED, eq), 'ml_knife');
    assert.equal(preferredPick('sniper', OWNED, eq), 'sr_bolt', '스나전에 돌격소총 장비는 쓸 수 없다');
    assert.equal(preferredPick('sniper', OWNED, { primary: 'sr_twin' }), 'sr_twin');
    assert.equal(preferredPick('classic', ['ar_std'], { primary: 'ar_line' }), 'ar_std', '없는 무기는 고르지 않는다');
    assert.equal(preferredPick('classic', null, null), 'ar_std');
    assert.equal(preferredPick('knife', null, null), 'ml_knife');
  });

  test('g2l 왕복과 256B 예산', () => {
    const msg = { ...gearMessage('sniper', 'sr_heavy', { primary: 'ar_rapid', secondary: 'pt_magnum', melee: 'ml_katana' }), round: 9, m: 'abcd1234' };
    assert.equal(msg.primary, 'sr_heavy', '고른 칸은 고른 무기');
    assert.equal(msg.melee, 'ml_katana');
    const payload = encodeLoadout(12345, msg);
    assert.deepEqual(payload[1], msg, '256B를 넘으면 protocol이 비워 버린다');
    assert.ok(byteSize(msg) <= 256, `${byteSize(msg)}B`);
    const back = decodeMessage(EV.loadout, copy(payload)).data;
    assert.deepEqual(readGear(back.loadout), { primary: 'sr_heavy', secondary: 'pt_magnum', melee: 'ml_katana', pick: 'sr_heavy' });
    const knife = gearMessage('knife', 'ml_knife', { primary: 'ar_std', secondary: 'pt_std', melee: 'ml_katana' });
    assert.equal(knife.melee, 'ml_knife');
    assert.equal(knife.pick, 'ml_knife');
  });

  test('readGear는 틀린 값을 조용히 버린다', () => {
    assert.deepEqual(readGear(null), {});
    assert.deepEqual(readGear({ primary: 'ml_knife', secondary: 'ar_std', melee: 'gr_frag' }), { pick: 'ml_knife' });
    assert.deepEqual(readGear({ primary: '<img>', pick: 42, melee: { x: 1 } }), {});
    assert.deepEqual(readGear({ primary: 'ar_std' }), { primary: 'ar_std', pick: 'ar_std' }, 'pick이 없으면 primary');
  });

  test('weaponForSlot: 장비 → 확정 선택 → 규칙 기본값 → 기본 장비', () => {
    const gear = { primary: 'sg_bx12', secondary: 'pt_magnum', melee: 'ml_knife' };
    assert.equal(weaponForSlot(gear, 1, 'classic'), 'sg_bx12');
    assert.equal(weaponForSlot(gear, 2, 'classic'), 'pt_magnum');
    assert.equal(weaponForSlot(gear, 3, 'classic'), 'ml_knife');
    assert.equal(weaponForSlot(gear, 4, 'classic'), 'gr_frag');
    assert.equal(weaponForSlot(null, 1, 'classic'), 'ar_std');
    assert.equal(weaponForSlot(null, 3, 'classic'), 'ml_knife');
    assert.equal(weaponForSlot(null, 1, 'classic', 'dm_mark'), 'dm_mark');
    assert.equal(weaponForSlot(gear, 1, 'sniper'), 'sr_bolt', '스나전에 샷건은 그리지 않는다');
    assert.equal(weaponForSlot(gear, 1, 'sniper', 'sr_twin'), 'sr_twin');
    assert.equal(weaponForSlot(gear, 1, 'knife'), 'ml_knife', '칼전이면 어떤 슬롯이든 칼');
    assert.equal(weaponForSlot(null, 4, 'knife'), 'ml_knife');
  });
});

describe('캐릭터(presence av)', () => {
  function fakeBus() {
    const subs = new Map();
    return {
      on(evt, fn) { if (!subs.has(evt)) subs.set(evt, new Set()); subs.get(evt).add(fn); return () => subs.get(evt).delete(fn); },
      emit(evt, data) { for (const fn of [...(subs.get(evt) || [])]) fn(data); }
    };
  }
  const lastState = (c, id) => { const list = c.world.calls('setActorState').filter(([who]) => who === id); return list.length ? list[list.length - 1][1] : null; };

  test('내 캐릭터가 presence로 가서 상대 화면의 액터에 실리고, 장착을 바꾸면 따라가며, 모르는 id는 기본 캐릭터다', async (t) => {
    const env = stage(t);
    const bus = fakeBus();
    const a = env.client('a', '하늘', { avatar: 'av_heavy' });
    const b = env.client('b', '구름', { avatar: 'av_scout' }, { bus });
    await startMatch(env, [a, b], { mapId: 'jetty' });
    await env.run(1500);
    assert.equal(a.session.state.matchPhase, 'live');
    assert.equal(env.hub.members.get('a').av, 'av_heavy', '방장도 자기 캐릭터를 presence에 싣는다');
    assert.equal(env.hub.members.get('b').av, 'av_scout');
    assert.deepEqual(a.session.state.avatars, { a: 'av_heavy', b: 'av_scout' });

    const added = a.world.calls('addActor').map(([o]) => o).filter((o) => o.id === 'b');
    assert.ok(added.length >= 1 && added.every((o) => o.avatar === 'av_scout'), '액터를 만들 때부터 캐릭터를 안다');
    env.frames();
    assert.equal(lastState(a, 'b').avatar, 'av_scout', '방장 화면의 손님');
    assert.equal(lastState(b, 'a').avatar, 'av_heavy', '손님 화면의 방장');

    // 장착을 바꾸면(마이페이지 등) 계정 변경으로 presence를 고친다
    b.account.avatar = 'av_night';
    bus.emit('account:change', {});
    assert.equal(env.hub.members.get('b').av, 'av_night');
    env.frames();
    assert.equal(lastState(a, 'b').avatar, 'av_night', '상대 화면도 바로 바뀐다');
    const room = b.session.room;
    const updates = [];
    const real = room.updateMe.bind(room);
    room.updateMe = (fields) => { updates.push(fields); return real(fields); };
    bus.emit('account:change', {});
    assert.deepEqual(updates, [], '캐릭터가 같으면 presence를 다시 고치지 않는다(presence 호출 한도)');

    // 고친 클라이언트가 이상한 값을 실어도 기본 캐릭터로 그린다
    for (const bad of ['av_hack', '<img>', 42, null]) {
      env.hub.members.get('b').av = bad;
      env.hub.announce('players');
      env.frames();
      assert.equal(lastState(a, 'b').avatar, 'av_trooper', String(bad));
    }
  });

  test('늦게 들어온 사람도 이미 있던 사람의 캐릭터를 presence로 바로 안다. 캐릭터가 없는 옛 클라이언트는 기본 캐릭터', async (t) => {
    const env = stage(t);
    const a = env.client('a', '하늘', { avatar: 'av_ranger' });
    const b = env.client('b', '구름');   // 계정에 캐릭터가 없다(옛 클라이언트·데모)
    await startMatch(env, [a, b], { mapId: 'jetty', mode: 'ffa' });
    await env.run(1500);
    assert.equal(env.hub.members.get('b').av, 'av_trooper', '캐릭터를 모르면 기본 캐릭터를 싣는다');
    delete env.hub.members.get('b').av;   // av 칸이 없는 옛 클라이언트
    env.hub.announce('players');
    env.frames();
    assert.equal(lastState(a, 'b').avatar, 'av_trooper');

    const c = env.client('c', '바람', { avatar: 'av_sapper' });
    await c.session.open();
    c.ui.fire('lobby:join', { roomId: env.hub.roomId });
    await env.settle();
    assert.equal(c.session.state.avatars.a, 'av_ranger', '들어오자마자 명단에서 읽는다');
    assert.equal(c.session.state.avatars.b, 'av_trooper');
    await env.run(2500);
    env.frames();
    const st = lastState(c, 'a');
    assert.ok(st, '중간 참가자 화면에 방장 액터가 있다');
    assert.equal(st.avatar, 'av_ranger');
    assert.equal(a.session.state.avatars.c, 'av_sapper', '먼저 있던 사람도 새 사람의 캐릭터를 안다');
  });
});

describe('방장 이전 복원', () => {
  const claim = (over) => ({ attackerId: 'a', victimId: 'b', dist: 10, ...over });
  const T0 = 100000;

  test('restoreMatch: 반샷이 스냅샷·결과표·나간 사람 줄에 남는다', () => {
    const src = createMatch({
      rules: { ruleset: 'sniper', loadoutMs: 0, roundEndMs: 0 },
      players: [{ id: 'a', team: 'owner' }, { id: 'b', team: 'charterer' }, { id: 'c', team: 'charterer' }], seed: 7
    });
    src.start();
    src.setLoadout('a', 'sr_twin');
    src.tick(1);
    src.claimHit(claim({ victimId: 'c', weaponId: 'sr_twin', part: 'hand', t: T0, shotId: 1 }));
    src.claimHit(claim({ attackerId: 'c', victimId: 'a', weaponId: 'sr_bolt', part: 'foot', t: T0, shotId: 2 }));
    const r = restoreMatch({ snapshot: src.snapshot(), players: [{ id: 'a', team: 'owner' }, { id: 'b', team: 'charterer' }], seed: 8 });
    r.start();
    r.tick(1);
    const state = r.state;
    assert.equal(state.players.find((p) => p.id === 'a').halfShots, 1);
    assert.equal(state.players.find((p) => p.id === 'a').loadout, 'sr_twin', '고른 무기도 이어받는다');
    assert.equal(state.players.find((p) => p.id === 'c').halfShots, 1, '이어받기 전에 나간 사람');
    r.claimHit(claim({ weaponId: 'sr_twin', part: 'hand', t: T0 + 5000, shotId: 3 }));
    assert.equal(r.state.players.find((p) => p.id === 'a').halfShots, 2);
    const ev = r.removePlayer('b');
    const end = ev.find((e) => e.type === 'matchEnd');
    assert.ok(end, '상대가 모두 나가면 끝난다');
    assert.equal(end.stats.find((row) => row[0] === 'a')[5], 2, 'matchEnd.stats의 여섯째 칸이 반샷');
  });

  test('restoreFfaMatch: 반샷과 고른 무기를 이어받는다', () => {
    const src = createMatch({
      rules: { mode: 'ffa', ruleset: 'sniper', loadoutMs: 0, spawnProtectMs: 0 },
      players: [{ id: 'a' }, { id: 'b' }], seed: 3
    });
    src.start();
    src.tick(1);
    src.setLoadout('a', 'sr_twin');
    src.claimHit(claim({ weaponId: 'sr_twin', part: 'foot', t: T0, shotId: 1 }));
    const r = restoreFfaMatch({ snapshot: src.snapshot(), players: [{ id: 'a' }, { id: 'b' }], seed: 9 });
    const me = r.state.players.find((p) => p.id === 'a');
    assert.equal(me.halfShots, 1);
    assert.equal(me.loadout, 'sr_twin');
    assert.equal(r.rules.ruleset, 'sniper');
  });
});

describe('로비 메타', () => {
  test('presence 키 한도 안에서 규칙과 모드가 왕복한다', () => {
    const entry = lobbyEntry({ name: '방', mapId: 'dojo', max: 6, status: 'waiting', mode: 'ffa', ruleset: 'knife' }, {
      roomId: 'r1', hostId: 'h', hostName: '하늘', players: 3, term: 2
    });
    assert.ok(Object.keys(entry).length <= FREE_PLAN.presenceKeysPerObject, `키 ${Object.keys(entry).length}개`);
    const room = readLobbyEntry(copy(entry));
    assert.equal(room.mode, 'ffa');
    assert.equal(room.ruleset, 'knife');
    assert.equal(room.mapId, 'dojo');
    assert.equal(room.players, 3);
    assert.equal(ruleBadge(room.ruleset, room.mode), '칼전 · 개인전');
  });

  test('규칙이 없는 옛 항목은 클래식으로 읽는다', () => {
    assert.deepEqual(unpackRoomKind('ffa'), { mode: 'ffa', ruleset: 'classic', locked: false });
    assert.deepEqual(unpackRoomKind(undefined), { mode: 'team', ruleset: 'classic', locked: false });
    assert.deepEqual(unpackRoomKind('team:<b>'), { mode: 'team', ruleset: 'classic', locked: false });
    assert.equal(packRoomKind('team', 'classic', true), 'team:classic:p', '비밀번호 방은 규칙까지 적고 :p를 붙인다');
    assert.deepEqual(unpackRoomKind('ffa:knife:p'), { mode: 'ffa', ruleset: 'knife', locked: true });
    assert.equal(packRoomKind('team', 'classic'), 'team');
    assert.equal(packRoomKind('ffa', 'sniper'), 'ffa:sniper');
    assert.equal(packRoomKind('team', undefined), 'team');
    const old = readLobbyEntry({ roomId: 'r', name: 'n', mapId: 'jetty', hostId: 'h', hostName: 'x', players: 1, max: 4, status: 'waiting', term: 1, mode: 'team' });
    assert.equal(old.ruleset, 'classic');
    assert.equal(ruleBadge(undefined, undefined), '클래식 · 팀전');
    assert.equal(ruleBadge('없는규칙', 'ffa'), '클래식 · 개인전');
  });

  test('개인전 목표 킬은 mode 값 넷째 칸으로 오가고, 셋째 칸까지만 읽던 클라이언트도 비밀번호 여부를 그대로 읽는다', () => {
    assert.equal(packRoomKind('ffa', 'classic', false, 10), 'ffa:classic::10');
    assert.equal(packRoomKind('ffa', 'knife', true, 5), 'ffa:knife:p:5');
    assert.equal(packRoomKind('team', 'classic', false, 10), 'team', '팀전에는 싣지 않는다');
    assert.equal(packRoomKind('ffa', 'sniper', false, undefined), 'ffa:sniper', '고른 적이 없으면 예전 모양 그대로');
    for (const bad of ['5:p', 'x', 0, 100, 7.5, -3, null, {}]) {
      assert.equal(packRoomKind('ffa', 'classic', false, bad), 'ffa', `잘못된 값 ${JSON.stringify(bad)}은 싣지 않는다`);
    }
    assert.deepEqual(unpackRoomKind('ffa:classic::10'), { mode: 'ffa', ruleset: 'classic', locked: false, killTarget: 10 });
    assert.deepEqual(unpackRoomKind('ffa:knife:p:5'), { mode: 'ffa', ruleset: 'knife', locked: true, killTarget: 5 });
    assert.deepEqual(unpackRoomKind('team:classic::10'), { mode: 'team', ruleset: 'classic', locked: false });
    assert.deepEqual(unpackRoomKind('ffa:classic::abc'), { mode: 'ffa', ruleset: 'classic', locked: false });
    assert.deepEqual(unpackRoomKind('ffa:classic::999'), { mode: 'ffa', ruleset: 'classic', locked: false });
    // 예전 unpackRoomKind는 [모드, 규칙, 표시]만 읽고 표시가 'p'면 비밀번호 방으로 본다
    const oldLocked = (v) => v.split(':')[2] === 'p';
    assert.equal(oldLocked(packRoomKind('ffa', 'knife', true, 5)), true);
    assert.equal(oldLocked(packRoomKind('ffa', 'classic', false, 10)), false);

    const entry = lobbyEntry({ name: '방', mapId: 'alley', max: 6, status: 'waiting', mode: 'ffa', ruleset: 'classic', locked: true, killTarget: 12 }, {
      roomId: 'r1', hostId: 'h', hostName: '하늘', players: 2, term: 1
    });
    assert.ok(Object.keys(entry).length <= FREE_PLAN.presenceKeysPerObject, `키 ${Object.keys(entry).length}개`);
    const room = readLobbyEntry(copy(entry));
    assert.equal(room.killTarget, 12);
    assert.equal(room.locked, true);
    assert.equal(ruleBadge(room.ruleset, room.mode, room.killTarget), '클래식 · 개인전 · 12킬');
    assert.equal(ruleBadge('knife', 'team', 12), '칼전 · 팀전', '팀전 배지에는 붙이지 않는다');
  });

  test('채널 이름은 consts.NET에서 온다', () => {
    assert.equal(LOBBY_TOPIC, NET.LOBBY_CHANNEL);
    assert.equal(ROOM_TOPIC_PREFIX, NET.ROOM_CHANNEL_PREFIX);
    assert.equal(LOBBY_TOPIC, 'skalafps:lobby');
    assert.equal(ROOM_TOPIC_PREFIX, 'skalafps:room:');
  });

  test('실제 Room·Lobby: 규칙이 방 메타와 로비 presence까지 간다(채널만 대역, 전송 없음)', async () => {
    const channels = new Map();
    const socket = {
      rtt: 40,
      channel(topic, opts) {
        const metas = new Map();
        const subs = new Map();
        const ch = {
          state: 'joined', presenceSynced: true,
          presence: {
            has: (k) => metas.has(k), keys: () => [...metas.keys()], get: (k) => metas.get(k) || [],
            list: () => [...metas].map(([key, list]) => ({ key, metas: list }))
          },
          on(evt, fn) {
            if (!subs.has(evt)) subs.set(evt, new Set());
            subs.get(evt).add(fn);
            return () => subs.get(evt).delete(fn);
          },
          join: async () => ({}),
          leave: async () => {},
          sendJson() {},
          track(meta) {
            metas.set(opts.presenceKey, [meta]);
            for (const fn of [...(subs.get('presence') || [])]) fn(null, {});
            return Promise.resolve('ok');
          }
        };
        channels.set(topic, ch);
        return ch;
      }
    };
    const net = { me: { id: 'h1', name: '하늘' }, opts: {}, socket, closed: false };
    net.lobby = new Lobby(net);
    const room = await Room.create(net, { name: '칼방', mapId: 'dojo', max: 6, mode: 'ffa', ruleset: 'knife' });
    try {
      assert.ok(channels.has(`${NET.ROOM_CHANNEL_PREFIX}${room.id}`), '방 채널 이름');
      const lobbyCh = channels.get(NET.LOBBY_CHANNEL);
      assert.ok(lobbyCh, '로비 채널 이름');
      const tracked = () => lobbyCh.presence.get('h1')[0];
      assert.ok(Object.keys(tracked()).length <= FREE_PLAN.presenceKeysPerObject);
      assert.equal(room.meta.ruleset, 'knife');
      assert.equal(room.meta.mode, 'ffa');
      assert.equal(tracked().mode, 'ffa:knife');
      assert.equal(net.lobby.rooms()[0].ruleset, 'knife');
      assert.equal(net.lobby.rooms()[0].mode, 'ffa');
      assert.equal(net.lobby.rooms()[0].mapId, 'dojo');

      assert.equal(room.updateMeta({ ruleset: 'sniper', mapId: 'longshot' }), true);
      assert.equal(room.meta.ruleset, 'sniper');
      assert.equal(net.lobby.rooms()[0].ruleset, 'sniper');
      assert.equal(net.lobby.rooms()[0].mapId, 'longshot');

      assert.equal(room.updateMeta({ killTarget: 10 }), true);
      assert.equal(room.meta.killTarget, 10);
      assert.equal(tracked().mode, 'ffa:sniper::10', '목표 킬은 mode 값에 실려 키가 늘지 않는다');
      assert.ok(Object.keys(tracked()).length <= FREE_PLAN.presenceKeysPerObject);
      assert.equal(net.lobby.rooms()[0].killTarget, 10);

      room.updateMe({ name: '새이름' });
      assert.equal(net.lobby.rooms()[0].hostName, '새이름', '닉네임이 바뀌면 로비 목록의 방장 이름도 바뀐다');
    } finally {
      await room.leave();
      net.lobby.dispose();
    }
  });

  test('맵 고르기는 규칙에 맞는 맵만', () => {
    assert.deepEqual(mapsForRule(MAP_LIST, 'knife').map((m) => m.id), ['rooftop', 'alley', 'dojo', 'nexus']);
    assert.deepEqual(mapsForRule(MAP_LIST, 'sniper').map((m) => m.id), ['longshot', 'dojo', 'nexus', 'jetty']);
    assert.deepEqual(mapsForRule([{ id: 'old' }], 'classic').map((m) => m.id), ['old'], 'rulesets가 없으면 클래식·스나전');
    assert.deepEqual(mapsForRule([{ id: 'old' }], 'knife').map((m) => m.id), ['old'], '고를 맵이 없으면 그대로');
  });
});

/* ================================================================== 남이 보낸 값 */

describe('믿을 수 없는 값', () => {
  // JSON으로 올 수 있는 값 중 String(v)·+v·v|0이 던지는 모양
  const BAD = JSON.parse('{"toString":1,"valueOf":1}');

  /** 실제 Room에 채널만 대역을 꽂는다. frame()은 방 채널로 프레임이 온 것과 같다 */
  async function realRoom() {
    let roomCh = null;
    const socket = {
      rtt: 40,
      channel(topic, opts) {
        const metas = new Map();
        const subs = new Map();
        const ch = {
          state: 'joined', presenceSynced: true, metas,
          presence: {
            has: (k) => metas.has(k), keys: () => [...metas.keys()], get: (k) => metas.get(k) || [],
            list: () => [...metas].map(([key, list]) => ({ key, metas: list }))
          },
          on(evt, fn) {
            if (!subs.has(evt)) subs.set(evt, new Set());
            subs.get(evt).add(fn);
            return () => subs.get(evt).delete(fn);
          },
          fire(evt, ...args) { for (const fn of [...(subs.get(evt) || [])]) fn(...args); },
          join: async () => ({}),
          leave: async () => {},
          sendJson() {},
          track(meta) {
            metas.set(opts.presenceKey, [meta]);
            ch.fire('presence', null, {});
            return Promise.resolve('ok');
          }
        };
        if (topic.startsWith(NET.ROOM_CHANNEL_PREFIX)) roomCh = ch;
        return ch;
      }
    };
    const net = { me: { id: 'h1', name: '하늘' }, opts: {}, socket, closed: false };
    net.lobby = new Lobby(net);
    const room = await Room.create(net, { name: '방', mapId: 'alley', max: 6, mode: 'team', ruleset: 'classic' });
    return {
      room,
      roomCh,
      frame: (from, ...msgs) => roomCh.fire('broadcast', 'f', { f: from, t: 0, m: msgs }),
      async close() { await room.leave(); net.lobby.dispose(); }
    };
  }

  test('방장을 사칭한 _meta: max가 커도 빈 자리를 수억 개 만들지 않고, 객체 값은 버린다', async () => {
    const s = await realRoom();
    try {
      s.frame('evil', ['_meta', { term: 9, meta: { max: 1e9, name: BAD, mapId: '__proto__', ruleset: BAD, mode: BAD, status: 'x', roster: BAD }, roster: [['a', BAD], ['b', 5], [BAD], 'c'] }]);
      const meta = s.room.meta;
      assert.equal(meta.hostId, 'evil', '이 층에서는 막을 수 없다(인증이 없다). 값만 안전하면 된다');
      assert.ok(meta.max >= 2 && meta.max <= 16, `max ${meta.max}`);
      assert.equal(meta.name, '방');
      assert.equal(meta.ruleset, 'classic');
      assert.equal(meta.mode, 'team');
      assert.equal(meta.status, 'waiting');
      assert.deepEqual(s.room._roster, [['a', 0], ['b', 5]]);
      assert.equal(normalizeRuleset(meta.ruleset), 'classic');
      assert.ok(Array.isArray(s.room.players()));
    } finally { await s.close(); }
  });

  test('_me 패치: 객체 이름을 보내도 명단이 망가지지 않고, 긴 이름은 잘린다', async () => {
    const s = await realRoom();
    try {
      s.roomCh.metas.set('m1', [{ id: 'm1', name: '구름', team: 'owner', ready: false, joinedAt: 5, ping: 0, v: 1 }]);
      s.frame('m1', ['_me', { v: BAD, name: BAD, team: BAD, ready: true }]);
      s.frame('m1', ['_me', { v: 2, name: `가\u0000${'나'.repeat(500)}`, ping: BAD }]);
      const me = s.room.players().find((p) => p.id === 'm1');
      assert.ok(me, '명단을 읽을 수 있다');
      assert.equal(me.name, `가${'나'.repeat(23)}`);
      assert.equal(me.team, 'owner');
    } finally { await s.close(); }
  });

  test('캐릭터 presence(av): 실제 Room에서 키 한도 안으로 왕복하고, 이상한 값은 남지 않거나 기본 캐릭터로 읽힌다', async () => {
    const s = await realRoom();
    try {
      s.room.updateMe({ team: 'owner', av: 'av_heavy' });
      const mine = s.roomCh.metas.get('h1')[0];
      assert.equal(mine.av, 'av_heavy', 'presence에 실린다');
      assert.ok(Object.keys(mine).length <= FREE_PLAN.presenceKeysPerObject, `키 ${Object.keys(mine).length}개`);
      assert.equal(s.room.players().find((p) => p.id === 'h1').av, 'av_heavy');
      s.roomCh.metas.set('m1', [{ id: 'm1', name: '구름', team: 'charterer', ready: false, joinedAt: 5, ping: 0, v: 1, av: 'av_scout' }]);
      s.roomCh.fire('presence', null, {});
      assert.equal(s.room.players().find((p) => p.id === 'm1').av, 'av_scout', '다른 사람 presence의 av');
      s.frame('m1', ['_me', { v: 2, av: BAD }]);
      assert.equal(s.room.players().find((p) => p.id === 'm1').av, 'av_scout', '객체 값 패치는 버린다');
      s.frame('m1', ['_me', { v: 3, av: 'av_night' }]);
      assert.equal(s.room.players().find((p) => p.id === 'm1').av, 'av_night', '패치로 바로 바뀐다');
      s.frame('m1', ['_me', { v: 4, av: `av_${'x'.repeat(400)}` }]);
      const odd = s.room.players().find((p) => p.id === 'm1').av;
      assert.ok(typeof odd === 'string');
      assert.equal(avatarIdOf(odd), 'av_trooper', '모르는 긴 값은 기본 캐릭터로 읽는다');
    } finally { await s.close(); }
  });

  test('presence: 객체 값은 저장하지 않고 긴 글자는 자른다', () => {
    const ps = new PresenceState();
    ps.syncState({
      evil: { metas: [{ phx_ref: 'r1', id: 'evil', name: BAD, roomId: 'x'.repeat(5000), joinedAt: BAD, v: BAD, nest: { a: 1 }, ok: 1, flag: true, none: null }] }
    });
    const [m] = ps.get('evil');
    assert.equal(m.presence_ref, 'r1');
    assert.equal('phx_ref' in m, false);
    for (const k of ['name', 'joinedAt', 'v', 'nest']) assert.equal(k in m, false, k);
    assert.equal(m.roomId.length, 128);
    assert.deepEqual([m.ok, m.flag, m.none], [1, true, null]);
    ps.syncDiff({ joins: { b: { metas: [{ phx_ref: 'r2', name: BAD, ok: 2 }] } }, leaves: {} });
    assert.deepEqual(ps.get('b'), [{ ok: 2, presence_ref: 'r2' }]);
    assert.deepEqual(plainFields(JSON.parse('{"__proto__":null,"a":1}')), { a: 1 });
    assert.deepEqual(plainFields(null), {});
    assert.deepEqual(plainFields({ n: Infinity, f() {} }), {});
  });

  test('로비 한 줄이 목록을 망가뜨리지 않는다', () => {
    const e = readLobbyEntry({ roomId: 'r1', name: BAD, mapId: BAD, hostId: BAD, hostName: BAD, players: BAD, max: BAD, status: BAD, mode: BAD });
    assert.deepEqual(e, { roomId: 'r1', name: '', mapId: '', hostId: '', hostName: '', players: 0, max: 8, status: 'waiting', mode: 'team', ruleset: 'classic', locked: false });
    assert.equal(readLobbyEntry({ roomId: 'r', max: 1e9, players: 1 }).max, 16, '방 인원 상한');
    assert.equal(readLobbyEntry({ roomId: 'r', name: 'x'.repeat(500), hostName: 'y'.repeat(500), players: 1 }).name.length, 32);
    assert.equal(readLobbyEntry({ roomId: BAD, players: 1 }).roomId, '');
    assert.deepEqual(unpackRoomKind(BAD), { mode: 'team', ruleset: 'classic', locked: false });
  });

  test('규칙·무기 조회는 문자열이 아니면 던지지 않고 기본값이다', () => {
    assert.equal(normalizeRuleset(BAD), 'classic');
    assert.equal(normalizeRuleset(['knife']), 'classic');
    assert.equal(normalizeRuleset('__proto__'), 'classic');
    assert.equal(getDef(BAD), null);
    assert.equal(getDef(['ar_std']), null);
    assert.equal(getDef('__proto__'), null);
    assert.equal(getDef('ar_std').id, 'ar_std');
  });

  test('접속 정보: Publishable key는 URL의 apikey로만 가고, 붙여 넣다 낀 공백은 지운다', async () => {
    const urls = [];
    class FakeWS {
      constructor(url) { urls.push(url); this.readyState = 1; queueMicrotask(() => { if (this.onopen) this.onopen(); }); }
      send() {}
      close() {}
    }
    const net = await connect({ url: ' https://p.supabase.co/ ', key: ' sb_publishable_abc ', socket: { WebSocket: FakeWS } });
    try {
      assert.deepEqual(urls, ['wss://p.supabase.co/realtime/v1/websocket?apikey=sb_publishable_abc&vsn=1.0.0']);
    } finally { await net.close(); }
    await assert.rejects(connect({ url: '   ', key: '  ', socket: { WebSocket: FakeWS } }), (e) => e.code === 'NO_CONFIG');
  });
});

/* ================================================================== 화면(아주 작은 DOM 대역) */

class FakeNode {}
class FakeEl extends FakeNode {
  constructor(tag) {
    super();
    this.tagName = String(tag).toUpperCase();
    this.kids = [];
    this.attrs = {};
    this.own = '';
    this.handlers = {};
    this.className = '';
    this.dataset = {};
    this.hidden = false;
    this.value = '';
    this.style = { setProperty() {} };
    const extra = new Set();
    this.classList = {
      toggle: (c, on) => { if (on === undefined ? !extra.has(c) : on) extra.add(c); else extra.delete(c); },
      add: (c) => extra.add(c),
      remove: (c) => extra.delete(c),
      contains: (c) => extra.has(c) || this.className.split(/\s+/).includes(c)
    };
  }
  get textContent() { return this.own + this.kids.map((k) => (typeof k === 'string' ? k : k.textContent)).join(''); }
  set textContent(v) { this.own = String(v); this.kids = []; }
  get children() { return this.kids.filter((k) => typeof k !== 'string'); }
  append(...list) { this.kids.push(...list); }
  replaceChildren(...list) { this.kids = list; this.own = ''; }
  remove() {}
  focus() {}
  select() {}
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  addEventListener(type, fn) { (this.handlers[type] = this.handlers[type] || []).push(fn); }
  removeEventListener() {}
  fire(type, e = {}) { for (const fn of this.handlers[type] || []) fn({ target: this, preventDefault() {}, stopPropagation() {}, ...e }); }
  all(pred, out = []) {
    for (const k of this.children) {
      if (pred(k)) out.push(k);
      k.all(pred, out);
    }
    return out;
  }
  querySelector(sel) {
    const pred = sel.startsWith('.') ? (k) => k.classList.contains(sel.slice(1)) : (k) => sel.slice(1, -1) in k.attrs;
    return this.all(pred)[0] || null;
  }
}

describe('로비·대기실 화면', () => {
  const saved = {};
  const NAMES = ['document', 'Node'];
  before(() => {
    for (const n of NAMES) saved[n] = globalThis[n];
    globalThis.Node = FakeNode;
    globalThis.document = {
      activeElement: null,
      createElement: (tag) => new FakeEl(tag),
      createElementNS: (_ns, tag) => new FakeEl(tag)
    };
  });
  after(() => {
    for (const n of NAMES) { if (saved[n] === undefined) delete globalThis[n]; else globalThis[n] = saved[n]; }
  });

  function uiCtx() {
    const emitted = [];
    return {
      emitted,
      emit: (name, payload) => emitted.push({ name, payload }),
      playerName: '다른이름',
      maps: new Map(MAP_LIST.map((m) => [m.id, { nameEn: '', desc: '', test: false, ...m }]))
    };
  }
  const byText = (root, text) => root.all((k) => k.tagName === 'BUTTON' && k.textContent.includes(text));
  const lastEmit = (ctx, name) => ctx.emitted.filter((e) => e.name === name).at(-1);

  test('로비: 배지, 태그, 방 만들기 시트의 규칙과 맵', () => {
    const ctx = uiCtx();
    const lobby = createLobby(ctx);
    lobby.show({
      name: '하늘',
      rooms: [
        { roomId: 'r1', name: '칼방', mapId: 'rooftop', hostName: '구름', players: 1, max: 2, status: 'waiting', mode: 'ffa', ruleset: 'knife' },
        { roomId: 'r2', name: '옛방', mapId: 'jetty', hostName: '바다', players: 1, max: 2, status: 'waiting', mode: 'team' },
        { roomId: 'r3', name: '짧은 판', mapId: 'jetty', hostName: '별', players: 1, max: 4, status: 'waiting', mode: 'ffa', killTarget: 10 }
      ]
    });
    const badges = lobby.el.all((k) => k.classList.contains('sk-mode-badge')).map((k) => k.textContent);
    assert.deepEqual(badges, ['칼전 · 개인전 · 20킬', '클래식 · 팀전', '클래식 · 개인전 · 10킬'], '목표 킬을 고른 적이 없는 개인전 방은 20킬');
    const maps = lobby.el.all((k) => k.classList.contains('sk-room-map')).map((k) => k.textContent);
    assert.equal(maps[0], '빨랫줄 옥상 · 칼전 전용');

    byText(lobby.el, '방 만들기')[0].fire('click');
    const form = lobby.el.all((k) => k.tagName === 'FORM')[0];
    assert.ok(form, '시트가 열린다');
    const cards = () => form.all((k) => k.classList.contains('sk-mapcard')).map((k) => k.textContent);
    assert.ok(cards().some((t) => t.includes('항구 골목')));
    assert.ok(cards().some((t) => t.includes('벚꽃 도장')), '통합 맵은 클래식에서도 보인다');
    assert.ok(!cards().some((t) => t.includes('빨랫줄 옥상')), '클래식에서 칼전 전용 맵은 안 보인다');
    const picked = () => form.all((k) => k.classList.contains('sk-mapcard') && k.classList.contains('is-on')).map((k) => k.textContent);
    assert.ok(picked()[0].includes('항구 골목'), '클래식의 첫 맵');

    byText(form, '칼전')[0].fire('click');
    assert.ok(cards().some((t) => t.includes('빨랫줄 옥상')));
    assert.ok(cards().some((t) => t.includes('칼전 전용')), '카드에 태그가 보인다');
    assert.ok(!cards().some((t) => t.includes('협곡 저격장')));
    assert.ok(picked()[0].includes('빨랫줄 옥상'), '칼전을 고르면 항구 골목을 쓸 수 있어도 칼전 기본 맵으로 옮긴다');

    form.fire('submit');
    const created = lastEmit(ctx, 'lobby:create').payload;
    assert.equal(created.ruleset, 'knife');
    assert.equal(created.name, '하늘의 방');
    assert.equal(created.mapId, 'rooftop');
    assert.equal(created.mode, 'team');
    assert.ok(!('killTarget' in created), '팀전 방에는 목표 킬을 보내지 않는다');

    // 개인전을 고르면 목표 킬 칸이 나온다
    byText(lobby.el, '방 만들기')[0].fire('click');
    const aria = (label) => form.all((k) => k.getAttribute('aria-label') === label)[0];
    const killField = () => form.all((k) => k.classList.contains('sk-kill-pick'))[0];
    const field = form.all((k) => k.classList.contains('sk-field') && k.children.includes(killField()))[0];
    assert.equal(field.hidden, true, '팀전에서는 숨긴다');
    form.all((k) => k.getAttribute('data-mode') === 'ffa')[0].fire('click');
    assert.equal(field.hidden, false);
    assert.ok(form.textContent.includes('모두가 적 · 20킬'));
    assert.equal(aria('목표 킬 늘리기').disabled, true, '20킬이 끝');
    aria('목표 킬 줄이기').fire('click');
    assert.ok(killField().textContent.includes('19킬'));
    form.all((k) => k.tagName === 'BUTTON' && k.textContent === '10킬')[0].fire('click');
    assert.ok(form.textContent.includes('먼저 10킬을 채우면 우승'), '안내 글도 바뀐다');
    form.fire('submit');
    const ffa = lastEmit(ctx, 'lobby:create').payload;
    assert.equal(ffa.mode, 'ffa');
    assert.equal(ffa.killTarget, 10);
    lobby.dispose();
  });

  test('경기 채팅 화면: 팀 경기에서 Tab과 탭 버튼으로 전체·팀을 바꾸고, 고른 범위로 보낸다', () => {
    globalThis.document.documentElement = new FakeEl('html');
    const ctx = { ...uiCtx(), later: () => 0, cancel() {} };
    const chat = createChat(ctx);
    chat.show({ teamChat: true });
    chat.open();
    const field = chat.el.all((k) => k.tagName === 'INPUT')[0];
    const tabBar = chat.el.all((k) => k.classList.contains('sk-cb-tabs'))[0];
    const tab = (id) => chat.el.all((k) => k.getAttribute('data-scope') === id)[0];
    const form = chat.el.all((k) => k.tagName === 'FORM')[0];
    assert.equal(tabBar.hidden, false, '팀 경기에서는 탭이 보인다');
    assert.equal(chat.scope(), 'all', '처음은 전체');
    assert.ok(tab('all').classList.contains('is-on'));
    assert.match(field.placeholder, /^전체 채팅 .*Tab 전체\/팀/);

    let prevented = 0;
    const press = (key, extra) => field.fire('keydown', { key, preventDefault() { prevented += 1; }, ...extra });
    press('Tab');
    assert.equal(chat.scope(), 'team');
    assert.equal(prevented, 1, 'Tab의 기본 동작(포커스 이동)은 막는다');
    assert.ok(tab('team').classList.contains('is-on') && !tab('all').classList.contains('is-on'));
    assert.equal(tab('team').getAttribute('aria-selected'), 'true');
    assert.ok(chat.el.classList.contains('is-team'));
    assert.match(field.placeholder, /^팀 채팅/);
    assert.deepEqual(lastEmit(ctx, 'chat:scope').payload, { scope: 'team' });
    press('Tab', { repeat: true });
    assert.equal(chat.scope(), 'team', '키를 누르고 있어도 다시 바뀌지 않는다');
    assert.equal(prevented, 2);

    field.value = '  B로   돌아요 ';
    form.fire('submit');
    assert.deepEqual(lastEmit(ctx, 'chat:send').payload, { text: 'B로 돌아요', scope: 'team' });
    assert.equal(chat.isOpen(), false, '보내면 닫는다');
    chat.open();
    assert.equal(chat.scope(), 'team', '고른 범위는 그 경기 동안 남는다');
    tab('all').fire('click');
    assert.equal(chat.scope(), 'all', '탭 버튼으로도 바꾼다(휴대폰)');
    press('Tab');
    press('Tab');
    assert.equal(chat.scope(), 'all', '두 번 누르면 제자리');

    // 줄: 팀 채팅만 [팀] 표시가 붙는다
    chat.push({ name: '하늘', text: '여기요', team: 'owner', scope: 'team' });
    chat.push({ name: '구름', text: '전체 줄', team: 'charterer' });
    const lines = chat.el.all((k) => k.tagName === 'LI');
    assert.equal(lines.length, 2);
    assert.ok(lines[0].classList.contains('is-team') && lines[0].textContent.startsWith('팀하늘'));
    assert.ok(!lines[1].classList.contains('is-team') && lines[1].textContent.startsWith('구름'));

    // 개인전: 탭이 없고 Tab은 아무것도 바꾸지 않는다. 범위는 전체로 돌아간다
    press('Tab');
    assert.equal(chat.scope(), 'team');
    chat.update({ teamChat: false });
    assert.equal(tabBar.hidden, true);
    assert.equal(chat.scope(), 'all');
    press('Tab');
    assert.equal(chat.scope(), 'all');
    chat.setScope('team');
    assert.equal(chat.scope(), 'all', '팀 채팅을 고를 수 없는 경기에서는 늘 전체');
    assert.equal(field.placeholder, 'Enter 보내기 · Esc 닫기');

    // 새 경기는 전체부터
    chat.update({ teamChat: true });
    chat.setScope('team');
    chat.hide();
    chat.show({ teamChat: true });
    assert.equal(chat.scope(), 'all');
    chat.dispose();
    delete globalThis.document.documentElement;

    assert.equal(chatPlaceholder('team', true, true), '팀 채팅 메시지');
    assert.equal(chatPlaceholder('all', false, true), '메시지 입력');
  });

  test('대기실: 개인전이면 방장만 목표 킬을 5~20킬로 바꾼다', () => {
    const ctx = uiCtx();
    const room = createRoom(ctx);
    const props = {
      roomId: 'r1', name: '방', mapId: 'alley', mode: 'ffa', ruleset: 'classic', killTarget: 20, max: 4, hostId: 'a', meId: 'a',
      players: [{ id: 'a', name: '하늘' }, { id: 'b', name: '구름', ready: true }], chat: []
    };
    room.show(props);
    const box = () => room.el.all((k) => k.classList.contains('sk-room-kills'))[0];
    const picker = () => room.el.all((k) => k.classList.contains('sk-kill-pick'))[0];
    const exact = (text) => room.el.all((k) => k.tagName === 'BUTTON' && k.textContent === text)[0];
    const aria = (label) => room.el.all((k) => k.getAttribute('aria-label') === label)[0];
    const kills = () => ctx.emitted.filter((e) => e.name === 'room:killTarget').map((e) => e.payload.killTarget);
    assert.equal(box().hidden, false);
    assert.equal(picker().hidden, false);
    assert.ok(room.el.textContent.includes('개인전 · 20킬'), '모드 칩');
    assert.equal(aria('목표 킬 늘리기').disabled, true, '20킬이 끝');

    exact('10킬').fire('click');
    assert.ok(room.el.textContent.includes('개인전 · 10킬'), '누르면 바로 보인다');
    aria('목표 킬 줄이기').fire('click');
    exact('5킬').fire('click');
    assert.equal(aria('목표 킬 줄이기').disabled, true, '5킬이 끝');
    aria('목표 킬 줄이기').fire('click');
    exact('5킬').fire('click');
    assert.deepEqual(kills(), [10, 9, 5], '범위 밖이나 같은 값은 보내지 않는다');

    room.update({ starting: true });
    exact('15킬').fire('click');
    assert.deepEqual(kills(), [10, 9, 5], '시작하는 중에는 바꾸지 않는다');

    // 다른 사람: 고르는 칸 없이 글로만 본다
    room.show({ ...props, killTarget: 12, meId: 'b' });
    assert.equal(box().hidden, false);
    assert.equal(picker().hidden, true);
    assert.ok(room.el.textContent.includes('먼저 12킬을 채우면 우승'));
    assert.ok(room.el.textContent.includes('목표 킬은 방장만'));
    exact('15킬').fire('click');
    assert.deepEqual(kills(), [10, 9, 5], '방장이 아니면 보내지 않는다');

    // 팀전에서는 목표 킬 칸이 없다
    room.show({ ...props, mode: 'team', killTarget: undefined, players: [{ id: 'a', name: '하늘', team: 'owner' }] });
    assert.equal(box().hidden, true);
    room.dispose();
  });

  test('대기실: 방장은 규칙을 바꾸고 맵은 규칙에 맞는 것만 보인다', () => {
    const ctx = uiCtx();
    const room = createRoom(ctx);
    const props = {
      roomId: 'r1', name: '방', mapId: 'alley', mode: 'team', ruleset: 'classic', max: 2, hostId: 'a', meId: 'a',
      players: [{ id: 'a', name: '하늘', team: 'owner' }], chat: []
    };
    room.show(props);
    const pickers = () => room.el.all((k) => k.classList.contains('sk-mapcard--sm')).map((k) => k.textContent);
    assert.ok(pickers().some((t) => t.includes('항구 골목')));
    assert.ok(!pickers().some((t) => t.includes('빨랫줄 옥상')));
    assert.ok(room.el.textContent.includes('클래식'));

    byText(room.el, '칼전')[0].fire('click');
    assert.deepEqual(lastEmit(ctx, 'room:ruleset').payload, { ruleset: 'knife' });
    assert.ok(pickers().some((t) => t.includes('빨랫줄 옥상') && t.includes('칼전 전용')), '작은 카드에도 태그');
    assert.ok(!pickers().some((t) => t.includes('협곡 저격장')));

    // 다른 사람은 고르는 버튼이 없다
    room.show({ ...props, ruleset: 'sniper', mapId: 'longshot', meId: 'b', players: [{ id: 'a', name: '하늘', team: 'owner' }, { id: 'b', name: '구름', team: 'charterer' }] });
    const before = ctx.emitted.length;
    assert.equal(pickers().length, 0);
    assert.ok(room.el.textContent.includes('스나전'));
    assert.ok(room.el.textContent.includes('규칙은 방장만'));
    const choice = room.el.all((k) => k.classList.contains('sk-choices'))[0];
    assert.equal(choice.hidden, true);
    choice.all((k) => k.tagName === 'BUTTON').forEach((k) => k.fire('click'));
    assert.equal(ctx.emitted.length, before, '방장이 아니면 보내지 않는다');
    room.dispose();
  });

  test('로비: 경기 중인 방은 팀전만 잠기고 개인전은 언제든 들어간다', () => {
    const ctx = uiCtx();
    const lobby = createLobby(ctx);
    const base = { name: '방', mapId: 'alley', hostName: '방장', players: 3, max: 6, status: 'playing' };
    lobby.show({ name: '하늘', rooms: [readLobbyEntry({ ...base, roomId: 't1', mode: 'team' }), readLobbyEntry({ ...base, roomId: 'f1', mode: 'ffa' })] });
    const [team, ffa] = lobby.el.all((k) => k.classList.contains('sk-room-join'));
    assert.equal(team.disabled, true, '팀전은 잠긴다');
    assert.ok(team.textContent.includes('진행 중'));
    assert.ok(!ffa.disabled, '개인전은 들어갈 수 있다');
    assert.ok(ffa.textContent.includes('중간 참가'));
    ffa.fire('click');
    assert.deepEqual(lastEmit(ctx, 'lobby:join').payload, { roomId: 'f1' });
    lobby.show({ name: '하늘', rooms: [readLobbyEntry({ ...base, roomId: 'f2', mode: 'ffa', players: 6 })] });
    assert.equal(lobby.el.all((k) => k.classList.contains('sk-room-join'))[0].disabled, true, '개인전도 가득 차면 못 들어간다');
    lobby.dispose();
  });

  test('로비: 비밀번호 방은 자물쇠가 보이고, 참가를 누르면 비밀번호를 물은 뒤 함께 보낸다', () => {
    const ctx = uiCtx();
    const lobby = createLobby(ctx);
    lobby.show({ name: '하늘', rooms: [readLobbyEntry({ roomId: 'k1', name: '친구 방', mapId: 'alley', hostName: '방장', players: 1, max: 4, status: 'waiting', mode: packRoomKind('team', 'classic', true) })] });
    assert.ok(lobby.el.all((k) => k.classList.contains('sk-room-name'))[0].textContent.startsWith('🔒'));
    lobby.el.all((k) => k.classList.contains('sk-room-join'))[0].fire('click');
    assert.equal(lastEmit(ctx, 'lobby:join'), undefined, '바로 들어가지 않는다');
    const form = lobby.el.all((k) => k.classList.contains('sk-pw-form'))[0];
    assert.ok(form, '비밀번호를 묻는다');
    form.fire('submit');
    assert.equal(lastEmit(ctx, 'lobby:join'), undefined, '비어 있으면 보내지 않는다');
    form.all((k) => k.tagName === 'INPUT')[0].value = ' 1234 ';
    form.fire('submit');
    assert.deepEqual(lastEmit(ctx, 'lobby:join').payload, { roomId: 'k1', password: '1234' });
    lobby.dispose();
  });

  test('로비: 맵 id가 __proto__인 방이 있어도 목록을 그린다', () => {
    const lobby = createLobby(uiCtx());
    const evil = readLobbyEntry({ roomId: 'r9', name: '이상한 방', mapId: '__proto__', hostName: '누구', players: 1, max: 2, status: 'waiting', mode: 'team' });
    assert.equal(evil.mapId, '__proto__');
    lobby.show({ name: '하늘', rooms: [evil, { ...evil, roomId: 'r8', mapId: 'constructor' }] });
    assert.equal(lobby.el.all((k) => k.classList.contains('sk-room-row')).length, 2);
    lobby.dispose();
  });

  test('결과: 닉네임이 같은 사람이 있어도 MVP의 기록은 그 사람 것이다', () => {
    const ctx = { ...uiCtx(), every: () => 0, cancel() {} };
    const results = createResults(ctx);
    results.show({
      winner: 'owner', score: { owner: 3, charterer: 0 }, rounds: [], myTeam: 'owner', mapId: 'alley', meId: 'a',
      players: [
        { id: 'a', name: '하늘', team: 'owner', kills: 1, deaths: 5, head: 0 },
        { id: 'b', name: '하늘', team: 'charterer', kills: 9, deaths: 0, head: 4 }
      ],
      mvp: { id: 'b', name: '하늘', team: 'charterer', kills: 9, deaths: 0, head: 4 }
    });
    const box = results.el.all((k) => k.classList.contains('sk-mvp'))[0];
    assert.ok(box.textContent.includes('레드'), box.textContent);
    assert.ok(box.textContent.includes('9'));
    results.dispose();
  });

  test('결과: 쉬움 난이도처럼 깎이는 포인트 줄은 -로 보이고, +-처럼 부호가 겹치지 않는다', () => {
    const ctx = { ...uiCtx(), every: () => 0, cancel() {} };
    const results = createResults(ctx);
    // 봇전 쉬움: 킬 5 + 완주 10 = 15 → ×0.7 = 11, 난이도 줄은 -4
    const reward = matchReward({ online: false, difficulty: 'easy', kills: 1 });
    assert.deepEqual(reward.breakdown.map((x) => x.points), [5, 10, -4]);
    results.show({
      winner: 'charterer', score: { owner: 0, charterer: 3 }, rounds: [], myTeam: 'owner', mapId: 'alley', meId: 'a',
      players: [{ id: 'a', name: '하늘', team: 'owner', kills: 1, deaths: 3, head: 0 }],
      reward: { ...reward, points: 511 }
    });
    const lines = results.el.all((k) => k.classList.contains('sk-res-line')).map((li) => li.children.map((c) => c.textContent));
    assert.deepEqual(lines, [['킬 ×1', '+5'], ['완주', '+10'], ['난이도 쉬움 ×0.7', '-4']]);
    assert.ok(!results.el.textContent.includes('+-'), results.el.textContent);
    results.dispose();
  });
});
