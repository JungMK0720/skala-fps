/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 멀티 세션 연결 시험. 작은 가짜 net·world·ui·account로 방장과 멤버를 방 → 로드아웃 → 라이브 → 히트 주장 → 킬 → 결과까지 돌리고,
 *          규칙·산탄 count·방장 이전·계정 기록·로비 메타·대기실 화면을 확인한다. Realtime 전송 자체는 시험하지 않는다.
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
import { createLobby, mapsForRule, ruleBadge } from '../js/ui/lobby.js';
import { createRoom } from '../js/ui/room.js';
import { createResults } from '../js/ui/results.js';

const MAP_LIST = Object.freeze([
  { id: 'alley', name: '항구 골목', rulesets: ['classic', 'knife'], tag: '' },
  { id: 'dojo', name: '벚꽃 도장', rulesets: ['knife'], tag: '칼전 전용' },
  { id: 'longshot', name: '협곡 저격장', rulesets: ['sniper'], tag: '스나 전용' },
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
  players() { return [...this.hub.members.values()].map((p) => ({ ...p, isHost: p.id === this.hub.hostId, ping: 30 })); }
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
  'setMode', 'setRespawn', 'setProtect', 'setActorProtect', 'sound', 'addDrop', 'removeDrop'];
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
    client(id, name, account, extra = {}) {
      const c = { id, world: fakeWorld(), ui: fakeUi(), account: fakeAccount(name, account), logs: [] };
      c.session = createSession({
        world: c.world, ui: c.ui,
        ctx: { account: c.account, maps: fakeMaps, session: { name: '임시이름' }, flags: {}, onFrame: () => () => {} },
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

    // 로드아웃: 가진 무기만, 계정 장비가 기본 선택
    const screen = b.ui.lastShown('loadout');
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

    // 방장 화면의 아바타: 슬롯은 상태 메시지, 무기는 그 사람의 장비
    await env.run(1300);
    assert.equal(a.session.state.matchPhase, 'live');
    assert.equal(b.world.last('setLocalLoadout')[0], 'sg_bx12');
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

    assert.equal(env.hub.lastCreate.mapId, 'alley', '이 규칙에서 못 쓰는 맵은 다시 고른다');
    assert.deepEqual(env.hub.list()[0].ruleset, 'knife');
    assert.deepEqual(env.hub.list()[0].mode, 'ffa');
    assert.deepEqual(b.world.calls('loadMap')[0], ['alley', { mode: 'ffa', ruleset: 'knife' }]);
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
    assert.equal(s.mapId, 'alley');
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
    a.ui.fire('room:map', { mapId: 'dojo' });
    assert.equal(a.session.room.meta.mapId, 'longshot', '규칙에 안 맞는 맵은 거른다');
    a.ui.fire('room:map', { mapId: 'nexus' });
    assert.equal(a.session.room.meta.mapId, 'nexus');
    assert.equal(env.hub.list()[0].ruleset, 'sniper', '로비 목록에도 반영');
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

      room.updateMe({ name: '새이름' });
      assert.equal(net.lobby.rooms()[0].hostName, '새이름', '닉네임이 바뀌면 로비 목록의 방장 이름도 바뀐다');
    } finally {
      await room.leave();
      net.lobby.dispose();
    }
  });

  test('맵 고르기는 규칙에 맞는 맵만', () => {
    assert.deepEqual(mapsForRule(MAP_LIST, 'knife').map((m) => m.id), ['alley', 'dojo', 'nexus']);
    assert.deepEqual(mapsForRule(MAP_LIST, 'sniper').map((m) => m.id), ['longshot', 'nexus', 'jetty']);
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
        { roomId: 'r1', name: '칼방', mapId: 'dojo', hostName: '구름', players: 1, max: 2, status: 'waiting', mode: 'ffa', ruleset: 'knife' },
        { roomId: 'r2', name: '옛방', mapId: 'jetty', hostName: '바다', players: 1, max: 2, status: 'waiting', mode: 'team' }
      ]
    });
    const badges = lobby.el.all((k) => k.classList.contains('sk-mode-badge')).map((k) => k.textContent);
    assert.deepEqual(badges, ['칼전 · 개인전', '클래식 · 팀전']);
    const maps = lobby.el.all((k) => k.classList.contains('sk-room-map')).map((k) => k.textContent);
    assert.equal(maps[0], '벚꽃 도장 · 칼전 전용');

    byText(lobby.el, '방 만들기')[0].fire('click');
    const form = lobby.el.all((k) => k.tagName === 'FORM')[0];
    assert.ok(form, '시트가 열린다');
    const cards = () => form.all((k) => k.classList.contains('sk-mapcard')).map((k) => k.textContent);
    assert.ok(cards().some((t) => t.includes('항구 골목')));
    assert.ok(!cards().some((t) => t.includes('벚꽃 도장')), '클래식에서 칼전 전용 맵은 안 보인다');

    byText(form, '칼전')[0].fire('click');
    assert.ok(cards().some((t) => t.includes('벚꽃 도장')));
    assert.ok(cards().some((t) => t.includes('칼전 전용')), '카드에 태그가 보인다');
    assert.ok(!cards().some((t) => t.includes('협곡 저격장')));

    form.fire('submit');
    const created = lastEmit(ctx, 'lobby:create').payload;
    assert.equal(created.ruleset, 'knife');
    assert.equal(created.name, '하늘의 방');
    assert.equal(created.mapId, 'alley');
    assert.equal(created.mode, 'team');
    lobby.dispose();
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
    assert.ok(!pickers().some((t) => t.includes('벚꽃 도장')));
    assert.ok(room.el.textContent.includes('클래식'));

    byText(room.el, '칼전')[0].fire('click');
    assert.deepEqual(lastEmit(ctx, 'room:ruleset').payload, { ruleset: 'knife' });
    assert.ok(pickers().some((t) => t.includes('벚꽃 도장') && t.includes('칼전 전용')), '작은 카드에도 태그');
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
    assert.ok(box.textContent.includes('오렌지'), box.textContent);
    assert.ok(box.textContent.includes('9'));
    results.dispose();
  });
});
