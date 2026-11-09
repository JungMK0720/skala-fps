/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 중계 서버(server/relay)와 클라이언트 전송(js/net/hubsocket.js)을 시험한다. 규칙 함수, 허브 처리(가짜 연결·가짜 시계),
 *          잠들었다 깨어난 허브 복원, 클라이언트와 서버의 약속(채널 이름·하트비트 글자·설정), Node 어댑터에 실제 클라이언트 셋을 붙인 전체 흐름.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { NET } from '../js/core/consts.js';
import { RealtimeSocket } from '../js/net/realtime.js';
import { HUB_HEARTBEAT_REF, HUB_PRESENCE_LIMIT, HubSocket, hubEndpoint, hubOf } from '../js/net/hubsocket.js';
import { RELAY_ROOM_DEFAULTS, connect } from '../js/net/index.js';
import { roomSecret } from '../js/net/secret.js';
import { Hub } from '../server/relay/src/hub.js';
import * as R from '../server/relay/src/rules.js';
import { startRelay } from '../server/relay/src/node.js';
import { runSmoke } from '../server/relay/tools/smoke.mjs';

const ROOM = 'skalafps:room:abc123';
const TOPIC = 'realtime:' + ROOM;
const LOBBY_TOPIC = 'realtime:' + NET.LOBBY_CHANNEL;
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/* ---------------- 도우미 ---------------- */

function fakeConn() {
  return {
    sent: [], closed: null, saved: null,
    send(text) { if (this.closed) throw new Error('closed'); this.sent.push(JSON.parse(text)); },
    close(code, reason) { this.closed = { code, reason }; },
    save(st) { this.saved = structuredClone(st); },
    take() { const s = this.sent; this.sent = []; return s; },
    of(event) { return this.sent.filter((m) => m.event === event); }
  };
}

function clock(start = 1000) {
  let t = start;
  const now = () => t;
  now.add = (ms) => { t += ms; };
  return now;
}

const msg = (topic, event, payload, ref = null, joinRef = null) => JSON.stringify({ topic, event, payload, ref, join_ref: joinRef });
const joinText = (key, { ref = '1', presence = true, self = false, topic = TOPIC } = {}) =>
  msg(topic, 'phx_join', { config: { broadcast: { self, ack: false }, presence: { key, enabled: presence }, postgres_changes: [], private: false } }, ref, ref);
const trackText = (meta, { jr = '1', ref = '2', topic = TOPIC } = {}) => msg(topic, 'presence', { type: 'presence', event: 'track', payload: meta }, ref, jr);
const untrackText = ({ jr = '1', ref = '4' } = {}) => msg(TOPIC, 'presence', { type: 'presence', event: 'untrack' }, ref, jr);
const frameText = (f, m, { jr = '1', extra = {} } = {}) => msg(TOPIC, 'broadcast', { type: 'broadcast', event: 'f', payload: { f, t: 5, m, ...extra } }, '9', jr);
const leaveText = ({ jr = '1', ref = '3' } = {}) => msg(TOPIC, 'phx_leave', {}, ref, jr);
const framesOf = (conn) => conn.of('broadcast').map((b) => b.payload.payload);

/** 방 허브에 키마다 연결 하나씩 참가시킨다 */
function roomWith(keys, opts = {}) {
  const hub = new Hub(ROOM, opts);
  const conns = {};
  for (const key of keys) {
    const c = fakeConn();
    hub.attach(c);
    hub.receive(c, joinText(key));
    conns[key] = c;
  }
  for (const c of Object.values(conns)) c.take();
  return { hub, conns };
}

/* ---------------- 규칙 ---------------- */

describe('중계 규칙', () => {
  test('허브 이름은 로비와 방(비밀 값 포함)만 받는다', () => {
    assert.deepEqual(R.parseHub('skalafps:lobby'), { kind: 'lobby', name: 'skalafps:lobby', topic: LOBBY_TOPIC });
    assert.equal(R.parseHub(ROOM).kind, 'room');
    assert.equal(R.parseHub(ROOM + ':0123456789abcdef01234567').kind, 'room');
    for (const bad of [ROOM + ':u:p1', ROOM + ':0123', ROOM + ':0123456789ABCDEF01234567', 'skalafps:room:', 'skalafps:room:a b', 'realtime:' + ROOM, 'x', '', null, 7, '__proto__']) {
      assert.equal(R.parseHub(bad), null, String(bad));
    }
    assert.equal(R.maskHub(ROOM + ':0123456789abcdef01234567'), ROOM + ':***', '기록에는 비밀 값을 남기지 않는다');
    assert.equal(R.maskHub(ROOM), ROOM);
  });

  test('Origin은 목록과 포트 와일드카드로만 허용하고, Origin이 없는 도구는 통과한다', () => {
    assert.ok(R.originAllowed('https://jungmk0720.github.io'));
    assert.ok(R.originAllowed('http://localhost:8080'));
    assert.ok(R.originAllowed('http://127.0.0.1:54321'));
    assert.ok(R.originAllowed(undefined) && R.originAllowed(''));
    assert.ok(!R.originAllowed('https://evil.example'));
    assert.ok(!R.originAllowed('http://localhost:8080.evil.example'), '포트 자리에 숫자만');
    assert.ok(!R.originAllowed('https://jungmk0720.github.io.evil.example'));
    assert.ok(R.originAllowed('https://a.example', 'https://a.example, https://b.example'));
    assert.ok(!R.originAllowed('https://c.example', 'https://a.example,https://b.example'));
  });

  test('들어온 글자: 크기, JSON, 모양, ref를 검사한다', () => {
    assert.equal(R.parseEnvelope('x'.repeat(R.LIMITS.maxMessageChars + 1)).error, 'too_large');
    assert.equal(R.parseEnvelope('{').error, 'bad_json');
    assert.equal(R.parseEnvelope('[1]').error, 'bad_message');
    assert.equal(R.parseEnvelope(null).error, 'not_text');
    assert.equal(R.parseEnvelope('{"topic":1,"event":"x"}').error, 'bad_message');
    assert.equal(R.parseEnvelope('{"topic":"t","event":"x","ref":{"a":1}}').error, 'bad_ref');
    assert.equal(R.parseEnvelope('{"topic":"t","event":"x","payload":[1]}').error, 'bad_payload');
    assert.deepEqual(R.parseEnvelope('{"topic":"t","event":"x","ref":5}').msg, { topic: 't', event: 'x', payload: {}, ref: '5', joinRef: null });
  });

  test('참가 설정에는 올바른 presence 키가 있어야 한다', () => {
    assert.deepEqual(R.joinConfig({ config: { presence: { key: 'p1', enabled: true }, broadcast: { self: true } } }), { key: 'p1', presence: true, self: true });
    for (const key of ['', '__proto__', 'a b', 'x'.repeat(41), 3, null]) assert.equal(R.joinConfig({ config: { presence: { key } } }).error, 'bad_key', String(key));
    assert.equal(R.joinConfig(null).error, 'bad_key');
  });

  test('presence 한 줄: 평범한 값만 남기고, 긴 글자는 자르고, 방에서는 id가 키와 같아야 한다', () => {
    const { meta } = R.cleanMeta({ id: 'p1', name: 'x'.repeat(300), ready: true, ping: 12, team: null, obj: { a: 1 }, arr: [1], nan: NaN, phx_ref: 'fake', presence_ref: 'r', ['__proto__']: 1 }, { key: 'p1', kind: 'room' });
    assert.deepEqual(Object.keys(meta).sort(), ['id', 'name', 'ping', 'ready', 'team']);
    assert.equal(meta.name.length, 128);
    assert.equal(R.cleanMeta({ id: 'p2' }, { key: 'p1', kind: 'room' }).error, 'id_mismatch');
    assert.ok(R.cleanMeta({ hostId: 'p2', roomId: 'r' }, { key: 'p1', kind: 'lobby' }).meta, '로비 항목에는 id 칸이 없다');
    const many = {};
    for (let i = 0; i < 17; i++) many['k' + i] = i;
    assert.equal(R.cleanMeta(many, { key: 'p1', kind: 'room' }).error, 'too_many_fields');
    const wide = {};
    for (let i = 0; i < 12; i++) wide['k' + i] = 'y'.repeat(100);
    assert.equal(R.cleanMeta(wide, { key: 'p1', kind: 'room' }).error, 'meta_too_large');
    assert.equal(R.cleanMeta([1], { key: 'p1', kind: 'room' }).error, 'bad_meta');
  });

  test('방 프레임: 보낸이는 자기 키, relay 묶음 금지, 대상 키를 모은다', () => {
    assert.equal(R.checkFrame({ f: 'p2', t: 1, m: [] }, 'p1').error, 'sender_mismatch');
    assert.equal(R.checkFrame({ f: 'p1', t: 1, m: [], r: [] }, 'p1').error, 'relay_not_allowed');
    assert.equal(R.checkFrame({ f: 'p1', t: 'x', m: [] }, 'p1').error, 'bad_frame');
    assert.equal(R.checkFrame({ f: 'p1', t: 1, m: [['a']] }, 'p1').error, 'bad_message');
    assert.equal(R.checkFrame({ f: 'p1', t: 1, m: [['', 1]] }, 'p1').error, 'bad_message');
    assert.equal(R.checkFrame({ f: 'p1', t: 1, m: [['a', 1, '__proto__']] }, 'p1').error, 'bad_target');
    assert.equal(R.checkFrame({ f: 'p1', t: 1, m: new Array(401).fill(['a', 1]) }, 'p1').error, 'bad_frame');
    const ok = R.checkFrame({ f: 'p1', t: 1, m: [['a', 1], ['b', 2, 'p2'], ['c', 3, 'p3']], junk: 1 }, 'p1');
    assert.deepEqual(ok.frame, { f: 'p1', t: 1, m: [['a', 1], ['b', 2, 'p2'], ['c', 3, 'p3']] }, '모르는 칸은 버린다');
    assert.deepEqual([...ok.targets].sort(), ['p2', 'p3']);
    assert.deepEqual(R.frameFor(ok.frame, ok.targets, 'p2').m, [['a', 1], ['b', 2, 'p2']]);
    assert.deepEqual(R.frameFor(ok.frame, ok.targets, null).m, [['a', 1]]);
    assert.equal(R.frameFor(ok.frame, null, 'p2'), ok.frame);
  });

  test('토큰 버킷은 시각에 따라 찬다', () => {
    const b = new R.Bucket(10, 2, 0);
    assert.ok(b.take(1, 0) && b.take(1, 0));
    assert.ok(!b.take(1, 0));
    assert.ok(!b.take(1, 50));
    assert.ok(b.take(1, 100));
    assert.ok(!b.take(5, 10000), 'burst보다 큰 요청은 받지 않는다');
  });
});

/* ---------------- 허브 ---------------- */

describe('중계 허브', () => {
  test('참가하면 응답과 presence 목록을 받고, track은 모두에게 diff로 간다', () => {
    const hub = new Hub(ROOM);
    const a = fakeConn(), b = fakeConn();
    hub.attach(a);
    hub.receive(a, joinText('pa'));
    const [reply, state] = a.take();
    assert.deepEqual(reply, { topic: TOPIC, event: 'phx_reply', payload: { status: 'ok', response: {} }, ref: '1' });
    assert.deepEqual(state, { topic: TOPIC, event: 'presence_state', payload: {}, ref: null });
    hub.receive(a, trackText({ id: 'pa', name: '방장', joinedAt: 5 }));
    const [ok, diff] = a.take();
    assert.equal(ok.payload.status, 'ok');
    const meta = diff.payload.joins.pa.metas[0];
    assert.equal(meta.name, '방장');
    assert.ok(meta.phx_ref, '서버가 phx_ref를 붙인다');
    hub.attach(b);
    hub.receive(b, joinText('pb'));
    const st = b.of('presence_state')[0].payload;
    assert.deepEqual(st.pa.metas, [meta], '새로 온 사람은 이미 있는 presence를 받는다');
    hub.receive(b, trackText({ id: 'pb', name: '손님' }));
    assert.ok(a.of('presence_diff').some((d) => d.payload.joins.pb), '다른 사람의 track도 받는다');
    // 다시 track하면 같은 키의 새 줄(join)과 옛 줄(leave)이 한 diff로 간다
    a.take();
    hub.receive(b, trackText({ id: 'pb', name: '손님', ready: true }, { ref: '5' }));
    const upd = a.of('presence_diff')[0].payload;
    assert.equal(upd.joins.pb.metas[0].ready, true);
    assert.equal(upd.leaves.pb.metas[0].ready, undefined);
    assert.notEqual(upd.joins.pb.metas[0].phx_ref, upd.leaves.pb.metas[0].phx_ref);
    // untrack
    a.take();
    hub.receive(b, untrackText());
    assert.ok(a.of('presence_diff')[0].payload.leaves.pb);
    assert.deepEqual(hub.counts(), { conns: 2, members: 2, tracked: 1 });
  });

  test('broadcast: 보낸 사람 빼고 모두에게, self면 자기도 받는다', () => {
    const { hub, conns } = roomWith(['pa', 'pb']);
    hub.receive(conns.pb, frameText('pb', [['st', { x: 1 }]]));
    assert.deepEqual(framesOf(conns.pa), [{ f: 'pb', t: 5, m: [['st', { x: 1 }]] }]);
    assert.equal(conns.pb.sent.length, 0);
    const me = fakeConn();
    hub.attach(me);
    hub.receive(me, joinText('pc', { self: true }));
    me.take();
    hub.receive(me, frameText('pc', [['hi', 1]]));
    assert.equal(framesOf(me).length, 1, 'broadcast.self = true');
  });

  test('특정 대상 메시지는 대상에게만 가고, 남는 것이 없는 사람도 빈 프레임은 받는다', () => {
    const { hub, conns } = roomWith(['pa', 'pb', 'pc']);
    hub.receive(conns.pa, frameText('pa', [['all', 1], ['to', 2, 'pb'], ['all2', 3]]));
    assert.deepEqual(framesOf(conns.pb)[0].m, [['all', 1], ['to', 2, 'pb'], ['all2', 3]], '순서를 지킨다');
    assert.deepEqual(framesOf(conns.pc)[0].m, [['all', 1], ['all2', 3]]);
    hub.receive(conns.pa, frameText('pa', [['_kick', { reason: 'host' }, 'pc']]));
    assert.deepEqual(framesOf(conns.pc)[1].m, [['_kick', { reason: 'host' }, 'pc']]);
    assert.deepEqual(framesOf(conns.pb)[1].m, [], '대상이 아니면 빈 프레임');
  });

  test('남의 이름, relay 묶음, 모르는 이벤트는 버리고 경고한다', () => {
    const { hub, conns } = roomWith(['pa', 'pb']);
    hub.receive(conns.pb, frameText('pa', [['st', 1]]));
    hub.receive(conns.pb, frameText('pb', [], { extra: { r: [['pa', 1, [['st', 1]]]] } }));
    hub.receive(conns.pb, msg(TOPIC, 'broadcast', { type: 'broadcast', event: 'u', payload: {} }, null, '1'));
    assert.equal(conns.pa.sent.length, 0, '아무것도 전달되지 않는다');
    const warn = conns.pb.of('system');
    assert.equal(warn.length, 1, '경고는 warnGapMs에 한 번');
    assert.equal(warn[0].payload.message, 'sender_mismatch');
    assert.equal(hub.stats.rejected, 3);
  });

  test('로비 허브는 broadcast를 받지 않고, 다른 채널 참가도 받지 않는다', () => {
    const hub = new Hub(NET.LOBBY_CHANNEL);
    const c = fakeConn();
    hub.attach(c);
    hub.receive(c, joinText('pa', { topic: LOBBY_TOPIC }));
    hub.receive(c, trackText({ roomId: 'r1', name: '방', players: 1 }, { topic: LOBBY_TOPIC }));
    assert.ok(c.of('presence_diff')[0].payload.joins.pa);
    hub.receive(c, msg(LOBBY_TOPIC, 'broadcast', { type: 'broadcast', event: 'f', payload: { f: 'pa', t: 1, m: [] } }, null, '1'));
    assert.equal(c.of('system')[0].payload.message, 'broadcast_not_allowed');
    hub.receive(c, joinText('pa', { topic: TOPIC, ref: '7' }));
    assert.deepEqual(c.sent.at(-1).payload, { status: 'error', response: { reason: 'topic_not_allowed' } });
  });

  test('다시 참가하면 앞의 참가를 정리하고, 늦게 온 옛 퇴장은 무시한다', () => {
    const { hub, conns } = roomWith(['pa', 'pb']);
    hub.receive(conns.pb, trackText({ id: 'pb' }));
    conns.pa.take();
    hub.receive(conns.pb, joinText('pb', { ref: '10' }));
    assert.ok(conns.pa.of('presence_diff')[0].payload.leaves.pb, '앞의 presence가 빠진다');
    hub.receive(conns.pb, leaveText({ jr: '1', ref: '11' }));
    assert.equal(conns.pb.sent.at(-1).payload.status, 'ok');
    assert.equal(hub.counts().members, 2, '옛 join_ref의 퇴장은 지금 참가를 지우지 않는다');
    hub.receive(conns.pb, frameText('pb', [['old', 1]], { jr: '1' }));
    assert.equal(framesOf(conns.pa).length, 0, '옛 참가의 broadcast도 버린다');
    hub.receive(conns.pb, leaveText({ jr: '10', ref: '12' }));
    assert.equal(hub.counts().members, 1);
  });

  test('연결이 닫히면 presence가 빠지고, 두 번 닫아도 된다', () => {
    const { hub, conns } = roomWith(['pa', 'pb']);
    hub.receive(conns.pb, trackText({ id: 'pb' }));
    conns.pa.take();
    hub.detach(conns.pb);
    hub.detach(conns.pb);
    assert.equal(conns.pa.of('presence_diff').length, 1);
    assert.ok(conns.pa.of('presence_diff')[0].payload.leaves.pb);
    assert.equal(conns.pb.saved.closed, true, '깨어날 때 다시 세우지 않게 표시한다');
    hub.receive(conns.pb, frameText('pb', [['x', 1]]));
    assert.equal(framesOf(conns.pa).length, 0);
  });

  test('presence는 10초에 12번까지', () => {
    const now = clock();
    const { hub, conns } = roomWith(['pa'], { now });
    for (let i = 0; i < 12; i++) hub.receive(conns.pa, trackText({ id: 'pa', n: i }, { ref: 'r' + i }));
    hub.receive(conns.pa, trackText({ id: 'pa', n: 99 }, { ref: 'over' }));
    assert.deepEqual(conns.pa.sent.find((m) => m.ref === 'over').payload, { status: 'error', response: { reason: 'rate_limited' } });
    now.add(10001);
    hub.receive(conns.pa, trackText({ id: 'pa', n: 100 }, { ref: 'later' }));
    assert.equal(conns.pa.sent.find((m) => m.ref === 'later').payload.status, 'ok');
  });

  test('너무 빨리 보내면 버리고, 계속되면 연결을 끊는다', () => {
    const now = clock();
    const limits = { ...R.LIMITS, msgPerSec: 1, msgBurst: 3, dropLimit: 5 };
    const { hub, conns } = roomWith(['pa', 'pb'], { now, limits });
    now.add(5000);
    for (let i = 0; i < 3; i++) hub.receive(conns.pa, frameText('pa', [['st', i]]));
    assert.equal(framesOf(conns.pb).length, 3);
    for (let i = 0; i < 4; i++) hub.receive(conns.pa, frameText('pa', [['st', i]]));
    assert.equal(framesOf(conns.pb).length, 3, '넘친 메시지는 버린다');
    assert.equal(conns.pa.of('system')[0].payload.message, 'rate_limited');
    assert.equal(conns.pa.closed, null);
    hub.receive(conns.pa, frameText('pa', [['st', 9]]));
    assert.equal(conns.pa.closed.code, 4008, '버린 수가 한도에 닿으면 끊는다');
    assert.equal(hub.counts().members, 1);
    assert.equal(hub.stats.closedAbuse, 1);
  });

  test('인원 한도와 연결 한도', () => {
    const limits = { ...R.LIMITS, room: { maxConns: 3, maxMembers: 2 } };
    const { hub } = roomWith(['pa', 'pb'], { limits });
    const c = fakeConn();
    assert.ok(hub.canAccept());
    hub.attach(c);
    assert.ok(!hub.canAccept());
    hub.receive(c, joinText('pc'));
    assert.deepEqual(c.sent[0].payload, { status: 'error', response: { reason: 'hub_full' } });
  });

  test('오래 조용한 연결은 닫고, 런타임이 대신 답한 하트비트는 활동으로 친다', () => {
    const now = clock();
    const { hub, conns } = roomWith(['pa', 'pb'], { now });
    now.add(R.LIMITS.idleMs - 1);
    hub.receive(conns.pa, msg('phoenix', 'heartbeat', {}, '7'));
    assert.deepEqual(conns.pa.sent.at(-1).payload, { status: 'ok', response: {} }, '허브를 거친 하트비트에도 답한다');
    now.add(10);
    const t = now();
    assert.equal(hub.sweep((c) => (c === conns.pb ? t : 0)), 0, 'pb는 런타임 하트비트로 살아 있다');
    now.add(R.LIMITS.idleMs + 1);
    assert.equal(hub.sweep(), 2);
    assert.equal(conns.pa.closed.code, 4001);
    assert.equal(hub.size, 0);
  });

  test('잠들었다 깨어나면 연결마다 남긴 상태로 참가·presence를 되살린다', () => {
    const first = roomWith(['pa', 'pb']);
    first.hub.receive(first.conns.pa, trackText({ id: 'pa', name: '방장' }));
    const savedA = first.conns.pa.saved, savedB = first.conns.pb.saved;
    const metaA = first.conns.pb.of('presence_diff')[0].payload.joins.pa.metas[0];
    // 새 객체(메모리 비어 있음) + 같은 WebSocket들
    const hub = new Hub(ROOM);
    const a = fakeConn(), b = fakeConn(), c = fakeConn();
    assert.ok(hub.attach(a, savedA) && hub.attach(b, savedB));
    assert.ok(!hub.attach(fakeConn(), { ...savedA, closed: true }), '닫힌 연결은 되살리지 않는다');
    assert.ok(!hub.attach(fakeConn(), { ...savedA, hub: 'skalafps:room:other' }), '다른 허브의 상태는 받지 않는다');
    assert.deepEqual(hub.counts(), { conns: 2, members: 2, tracked: 1 });
    hub.attach(c);
    hub.receive(c, joinText('pc'));
    assert.deepEqual(c.of('presence_state')[0].payload.pa.metas, [metaA], '같은 phx_ref로 되살아난다');
    hub.receive(a, frameText('pa', [['st', 1]]));
    assert.equal(framesOf(b).length, 1, '참가도 되살아난다');
    hub.receive(c, trackText({ id: 'pc' }));
    const refC = b.of('presence_diff')[0].payload.joins.pc.metas[0].phx_ref;
    assert.notEqual(refC, metaA.phx_ref, '깨어난 뒤 새 ref는 옛 ref와 겹치지 않는다');
    assert.equal(hub.stats.opened, 1, '되살린 연결은 새 연결로 세지 않는다');
  });

  test('깨어난 뒤에도 하트비트가 끊긴 연결은 정리된다(마지막 활동을 연결 상태에 남긴다)', () => {
    const now = clock();
    const first = roomWith(['pa', 'pb'], { now });
    now.add(30001);
    first.hub.receive(first.conns.pa, frameText('pa', [['st', 1]]));
    assert.equal(first.conns.pa.saved.seen, now(), '30초가 지나면 받은 시각을 남긴다');
    assert.equal(first.conns.pb.saved.seen, 1000, 'pb는 그 뒤로 조용하다');
    // 잠든 동안 pa의 하트비트는 런타임이 답했다(seenAt), pb는 아무 소리가 없다
    now.add(R.LIMITS.idleMs + 5000);
    const hub = new Hub(ROOM, { now });
    const a = fakeConn(), b = fakeConn();
    hub.attach(a, first.conns.pa.saved);
    hub.attach(b, first.conns.pb.saved);
    const t = now();
    assert.equal(hub.sweep((c) => (c === a ? t - 1000 : 0)), 1);
    assert.equal(b.closed && b.closed.code, 4001, '깨어난 시각을 활동으로 치지 않는다');
    assert.equal(a.closed, null);
    assert.ok(a.of('presence_diff').length === 0 && hub.counts().members === 1);
  });

  test('남기는 연결 상태는 작다(serializeAttachment 16 KiB 한도)', () => {
    const { hub, conns } = roomWith(['pa']);
    const wide = { id: 'pa' };
    for (let i = 0; i < 15; i++) wide['k' + i] = '가'.repeat(i < 6 ? 128 : 1);
    hub.receive(conns.pa, trackText(wide));
    assert.equal(conns.pa.sent.find((m) => m.ref === '2').payload.status, 'ok');
    assert.ok(Buffer.byteLength(JSON.stringify(conns.pa.saved)) < 4096, Buffer.byteLength(JSON.stringify(conns.pa.saved)));
  });
});

/* ---------------- 클라이언트와 서버의 약속 ---------------- */

describe('클라이언트와 중계 서버의 약속', () => {
  test('채널 이름 앞부분이 게임 상수와 같다', () => {
    assert.equal(R.LOBBY_HUB, NET.LOBBY_CHANNEL);
    assert.equal(R.ROOM_PREFIX, NET.ROOM_CHANNEL_PREFIX);
  });

  test('클라이언트가 고르는 허브 이름을 서버가 받는다', async () => {
    const secret = await roomSecret('abc123', '1234');
    assert.match(secret, /^[0-9a-f]{24}$/);
    const cases = [
      [NET.LOBBY_CHANNEL, NET.LOBBY_CHANNEL],
      [ROOM, ROOM],
      [`${ROOM}:${secret}`, `${ROOM}:${secret}`],
      [`${ROOM}:u:p1`, ROOM],
      [`${ROOM}:${secret}:u:p1`, `${ROOM}:${secret}`]
    ];
    for (const [topic, hub] of cases) {
      assert.equal(hubOf(topic), hub, topic);
      assert.ok(R.parseHub(hub), hub);
    }
    assert.equal(hubOf('other'), null);
    assert.equal(hubOf(NET.ROOM_CHANNEL_PREFIX), null);
    assert.equal(R.parseHub(`${ROOM}:u:p1`), null, 'uplink 채널은 서버가 받지 않는다(mesh로 충분)');
    assert.equal(hubEndpoint('http://127.0.0.1:8788/', NET.LOBBY_CHANNEL), 'ws://127.0.0.1:8788/ws?hub=skalafps%3Alobby');
    assert.equal(hubEndpoint('https://r.example.workers.dev', ROOM), 'wss://r.example.workers.dev/ws?hub=skalafps%3Aroom%3Aabc123');
  });

  test('하트비트 글자가 서버의 자동 응답 요청과 글자 그대로 같다', () => {
    const sent = [];
    class FakeWS {
      constructor() { this.readyState = 1; queueMicrotask(() => this.onopen && this.onopen()); }
      send(s) { sent.push(s); }
      close() {}
    }
    const s = new RealtimeSocket({ endpoint: 'ws://x/ws?hub=skalafps%3Alobby', heartbeatRef: HUB_HEARTBEAT_REF, WebSocket: FakeWS });
    assert.equal(HUB_HEARTBEAT_REF, R.HEARTBEAT_REF);
    return s.open(1000).then(() => {
      assert.equal(sent[0], R.HEARTBEAT_REQUEST, '열자마자 보내는 하트비트');
      s.ws.onmessage({ data: R.HEARTBEAT_RESPONSE });
      assert.ok(s.rtt >= 0, '자동 응답으로 왕복 시간을 잰다');
      s.close();
    });
  });

  test('중계 소켓의 채널은 서버 한도 안에서 presence를 더 자주 보낸다', () => {
    class FakeWS { constructor() { this.readyState = 0; } send() {} close() {} }
    const s = new HubSocket({ url: 'http://127.0.0.1:1', WebSocket: FakeWS });
    const ch = s.channel(NET.LOBBY_CHANNEL, { presence: true, presenceKey: 'p1' });
    assert.equal(ch._limiter.max, HUB_PRESENCE_LIMIT.max);
    assert.ok(HUB_PRESENCE_LIMIT.max / HUB_PRESENCE_LIMIT.windowMs < R.LIMITS.presencePerWindow / R.LIMITS.presenceWindowMs);
    assert.equal(new RealtimeSocket({ url: 'https://p.supabase.co', key: 'k', WebSocket: FakeWS }).channel('t')._limiter.max, 4, 'Supabase 기본은 그대로');
    s.close();
  });

  test('설정으로 전송을 고른다: relay면 허브 주소로 붙고 mesh·rate를 쓴다', async () => {
    const urls = [];
    class FakeWS {
      constructor(url) { urls.push(url); this.readyState = 1; queueMicrotask(() => this.onopen && this.onopen()); }
      send() {}
      close() {}
    }
    const prev = globalThis.SKALA_CONFIG;
    try {
      globalThis.SKALA_CONFIG = { supabase: { url: 'https://p.supabase.co', anonKey: 'k' }, transport: 'relay', relay: { url: ' http://127.0.0.1:8788/ ', hz: 12 } };
      const net = await connect({ playerId: 'p1', name: 'a', socket: { WebSocket: FakeWS } });
      try {
        assert.deepEqual(urls, ['ws://127.0.0.1:8788/ws?hub=skalafps%3Alobby']);
        assert.equal(net.transport, 'relay');
        assert.deepEqual(net.opts.room, { ...RELAY_ROOM_DEFAULTS, maxHz: 12 });
        assert.equal(net.stats().transport, 'relay');
      } finally { await net.close(); }
      globalThis.SKALA_CONFIG = { ...globalThis.SKALA_CONFIG, relay: { url: '' } };
      await assert.rejects(connect({ socket: { WebSocket: FakeWS } }), (e) => e.code === 'NO_CONFIG');
      globalThis.SKALA_CONFIG = { ...globalThis.SKALA_CONFIG, transport: 'carrier-pigeon' };
      await assert.rejects(connect({ socket: { WebSocket: FakeWS } }), (e) => e.code === 'NO_CONFIG');
      urls.length = 0;
      globalThis.SKALA_CONFIG = { supabase: { url: 'https://p.supabase.co', anonKey: 'k' } };
      const sb = await connect({ socket: { WebSocket: FakeWS } });
      assert.equal(sb.transport, 'supabase', 'transport가 없으면 Supabase');
      assert.match(urls[0], /^wss:\/\/p\.supabase\.co\/realtime\/v1\/websocket/);
      await sb.close();
    } finally {
      if (prev === undefined) delete globalThis.SKALA_CONFIG; else globalThis.SKALA_CONFIG = prev;
    }
  });
});

/* ---------------- Node 어댑터에 실제 클라이언트 ---------------- */

describe('Node 어댑터에 실제 클라이언트를 붙인다', () => {
  test('로비, 방, 메시지, presence, 재접속, 강퇴, 방장 이전, 비밀번호 방, 퇴장', { timeout: 90000 }, async () => {
    const relay = await startRelay({ port: 0 });
    try {
      const r = await runSmoke(relay.url, { timeoutMs: 8000 });
      assert.ok(r.checks >= 20, r.checks);
      for (const hub of relay.hubs.values()) {
        assert.equal(hub.stats.rejected, 0, `거절된 메시지가 없어야 한다: ${JSON.stringify(hub.summary())}`);
        assert.equal(hub.stats.dropped, 0, `버린 메시지가 없어야 한다: ${JSON.stringify(hub.summary())}`);
      }
    } finally { await relay.close(); }
  });

  test('방에서 나오면 방 허브 연결을 닫고, 끊기면 reconnecting을 거쳐 open으로 돌아온다', { timeout: 30000 }, async () => {
    const relay = await startRelay({ port: 0 });
    const net = await connect({ transport: 'relay', relayUrl: relay.url, playerId: 'solo1', name: '혼자', socket: { linkIdleMs: 50 } });
    try {
      const states = [];
      net.on('connection', (e) => states.push(e.state));
      const room = await net.createRoom({ name: '혼자 방', mapId: 'alley', max: 2 });
      assert.equal(net.socket.links.size, 2, '로비 허브와 방 허브');
      net.socket.simulateDrop();
      const end = Date.now() + 10000;
      while (!(states.includes('reconnecting') && net.socket.state === 'open') && Date.now() < end) await sleep(20);
      assert.deepEqual([states.includes('reconnecting'), net.socket.state], [true, 'open']);
      await room.leave();
      net.lobby.dispose();
      const end2 = Date.now() + 5000;
      while (net.socket.links.size && Date.now() < end2) await sleep(20);
      assert.equal(net.socket.links.size, 0, '채널이 없는 링크는 닫는다');
      assert.ok(!states.includes('closed'), '링크를 닫아도 소켓 전체는 닫히지 않는다');
    } finally {
      await net.close();
      await relay.close();
    }
    assert.equal(net.socket.state, 'closed');
  });

  test('서버가 없으면 시간 제한 안에 CONNECT_TIMEOUT', async () => {
    const relay = await startRelay({ port: 0 });
    const url = relay.url;
    await relay.close();
    await assert.rejects(connect({ transport: 'relay', relayUrl: url, timeoutMs: 1500, socket: { backoff: { base: 100, max: 200 } } }), (e) => e.code === 'CONNECT_TIMEOUT');
  });
});
