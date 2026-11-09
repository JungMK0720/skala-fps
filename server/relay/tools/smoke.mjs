#!/usr/bin/env node
/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 중계 서버에 실제 클라이언트 코드(js/net) 셋을 붙여 로비, 방 만들기, 참가, 메시지(전원·특정 대상), presence, 메타, 재접속, 방장 강퇴,
 *          방장 이전, 비밀번호 방, 퇴장까지 차례로 확인한다. 사용: node server/relay/tools/smoke.mjs [서버 주소=http://127.0.0.1:8788]
 *          tests/relay.test.mjs도 Node 어댑터(src/node.js)에 이 흐름을 그대로 돌린다.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, randomId } from '../../../js/net/index.js';

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

async function waitFor(fn, ms, label) {
  const end = Date.now() + ms;
  for (;;) {
    let v;
    try { v = fn(); } catch (_) { v = false; }
    if (v) return v;
    if (Date.now() > end) throw new Error(`기다리다 시간이 지났어요: ${label}`);
    await sleep(20);
  }
}

/**
 * @param {string} url 중계 서버 주소
 * @param {{ log?: (line: string) => void, timeoutMs?: number }} [opts]
 * @returns {Promise<{ checks: number, ms: number }>} 실패하면 무엇이 안 됐는지 담아 던진다
 */
export async function runSmoke(url, { log = () => {}, timeoutMs = 10000 } = {}) {
  const started = Date.now();
  let checks = 0;
  const ok = (cond, label, detail) => {
    checks++;
    if (!cond) throw new Error(`실패: ${label}${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`);
    log(`PASS ${label}`);
  };
  const tag = randomId(5);
  const nets = [];
  const open = async (name) => {
    const net = await connect({ transport: 'relay', relayUrl: url, playerId: `${name}${tag}`, name, timeoutMs });
    nets.push(net);
    return net;
  };
  const inbox = (room) => {
    const list = [];
    room.on('message', (m) => list.push(m));
    return list;
  };

  try {
    const A = await open('host');
    const B = await open('guest');
    const C = await open('third');
    ok(A.transport === 'relay' && B.stats().transport === 'relay', '중계 전송으로 연결된다');

    // 로비
    let lobbyB = [];
    let syncedB = false;
    B.lobby.subscribe((rooms, info) => { lobbyB = rooms; if (info && info.synced) syncedB = true; });
    await waitFor(() => syncedB, timeoutMs, '로비 presence');
    ok(true, '로비를 받는다');

    const roomName = `smoke-${tag}`;
    const ra = await A.createRoom({ name: roomName, mapId: 'alley', max: 3, mode: 'team' });
    ok(ra.isHost() && ra.meta.net === 'mesh' && ra.rate === 20, '방장이 방을 만들고 mesh·20Hz로 시작한다', { net: ra.meta.net, rate: ra.rate });
    const row = await waitFor(() => lobbyB.find((r) => r.roomId === ra.id), timeoutMs, '로비에 방');
    ok(row.name === roomName && row.hostId === A.me.id && row.players === 1 && row.status === 'waiting', '로비 목록 줄', row);

    // 참가
    const rb = await B.joinRoom(ra.id);
    ok(rb.hostId() === A.me.id && rb.meta.name === roomName, '손님이 들어가 방장과 메타를 안다');
    await waitFor(() => ra.players().length === 2 && rb.players().length === 2, timeoutMs, '두 사람 명단');
    ok(true, '양쪽 명단에 두 사람');
    await waitFor(() => (lobbyB.find((r) => r.roomId === ra.id) || {}).players === 2, timeoutMs, '로비 인원 2');
    ok(true, '로비 인원이 바뀐다');

    // 메시지: 전원, 특정 대상
    const inA = inbox(ra), inB = inbox(rb);
    ra.send('chat', { text: '안녕' });
    rb.send('chat', { text: '반가워' });
    await waitFor(() => inB.some((m) => m.event === 'chat' && m.payload.text === '안녕' && m.fromHost) && inA.some((m) => m.event === 'chat' && m.from === B.me.id), timeoutMs, '채팅');
    ok(true, '전원에게 보낸 메시지가 서로 간다');

    const rc = await C.joinRoom(ra.id);
    const inC = inbox(rc);
    await waitFor(() => ra.players().length === 3 && rc.players().length === 3, timeoutMs, '세 사람 명단');
    ra.sendTo(B.me.id, 'whisper', { n: 1 });
    rc.sendTo(A.me.id, 'whisper', { n: 2 });
    ra.send('after', 1);
    await waitFor(() => inB.some((m) => m.event === 'whisper') && inA.some((m) => m.event === 'whisper') && inC.some((m) => m.event === 'after'), timeoutMs, '귓속말');
    ok(!inC.some((m) => m.event === 'whisper') && inB.filter((m) => m.event === 'whisper').length === 1, '특정 대상 메시지는 그 사람에게만 간다');
    ok(inB.find((m) => m.event === 'whisper').to === B.me.id, '받은 쪽은 자기에게 온 것임을 안다');

    // presence와 메타
    rb.updateMe({ ready: true, team: 'b' });
    await waitFor(() => { const p = ra.players().find((x) => x.id === B.me.id); return p && p.ready && p.team === 'b'; }, timeoutMs, '준비');
    ok(true, '준비·팀이 방장에게 보인다');
    ra.updateMeta({ mapId: 'dojo', status: 'playing' });
    await waitFor(() => rb.meta.mapId === 'dojo' && rb.meta.status === 'playing', timeoutMs, '메타');
    await waitFor(() => (lobbyB.find((r) => r.roomId === ra.id) || {}).status === 'playing', timeoutMs, '로비 상태');
    ok(true, '방 메타가 손님과 로비에 반영된다');

    // 손님 연결이 끊겼다 돌아온다
    const back = new Promise((res) => { const off = rb.on('connection', (e) => { if (e.state === 'connected') { off(); res(); } }); });
    const reconnects = B.socket.reconnects;
    B.socket.simulateDrop();
    await Promise.race([back, sleep(timeoutMs).then(() => { throw new Error('재접속하지 못했어요'); })]);
    ok(B.socket.reconnects > reconnects, '끊긴 손님이 다시 붙는다');
    rb.send('again', 1);
    await waitFor(() => inA.some((m) => m.event === 'again'), timeoutMs, '재접속 뒤 메시지');
    ok(rb.hostId() === A.me.id, '재접속 뒤에도 같은 방장');

    // 방장 강퇴
    const kicked = new Promise((res) => rc.once('closed', (e) => res(e.reason)));
    ra.kick(C.me.id, 'host');
    ok((await Promise.race([kicked, sleep(timeoutMs).then(() => 'timeout')])) === 'kicked:host', '강퇴된 사람은 방에서 나간다');
    await waitFor(() => ra.players().length === 2, timeoutMs, '강퇴 뒤 명단');
    ok(true, '방장 명단에서 사라진다');

    // 방장이 나가면 손님이 이어받는다
    const took = new Promise((res) => rb.on('host', (e) => { if (e.isMe) res(e); }));
    await ra.leave();
    const h = await Promise.race([took, sleep(timeoutMs).then(() => null)]);
    ok(h && rb.isHost() && h.prevHostId === A.me.id, '방장이 나가면 남은 사람이 방장이 된다', h);
    await waitFor(() => { const r = lobbyB.find((x) => x.roomId === ra.id); return r && r.hostId === B.me.id && r.players === 1; }, timeoutMs, '로비의 새 방장');
    ok(true, '로비에 새 방장이 보인다');
    await rb.leave();
    await waitFor(() => !lobbyB.some((r) => r.roomId === ra.id), timeoutMs, '빈 방이 로비에서 사라짐');
    ok(true, '모두 나가면 로비에서 사라진다');

    // 비밀번호 방: 비밀 값이 허브 이름에 들어가므로 틀리면 빈 허브에 들어간다
    const rp = await A.createRoom({ name: `pw-${tag}`, mapId: 'alley', max: 4, mode: 'ffa', password: '1234' });
    await waitFor(() => lobbyB.some((r) => r.roomId === rp.id && r.locked), timeoutMs, '잠긴 방');
    const wrong = await B.joinRoom(rp.id, { password: '9999' }).then(() => 'joined', (e) => e.code);
    ok(wrong === 'BAD_PASSWORD', '틀린 비밀번호는 들어가지 못한다', wrong);
    const rp2 = await B.joinRoom(rp.id, { password: '1234' });
    await waitFor(() => rp.players().length === 2, timeoutMs, '비밀번호 방 참가');
    ok(rp2.hostId() === A.me.id, '맞는 비밀번호로 들어간다');
    await rp2.leave();
    await rp.leave();

    ok(A.socket.rtt != null && A.socket.rtt >= 0, '하트비트로 왕복 시간을 잰다', A.socket.rtt);
    return { checks, ms: Date.now() - started };
  } finally {
    for (const n of nets) { try { await n.close(); } catch (_) { /* 이미 닫힘 */ } }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const url = process.argv[2] || 'http://127.0.0.1:8788';
  console.log(`중계 서버 ${url}에 클라이언트 셋을 붙입니다`);
  runSmoke(url, { log: (l) => console.log(l) }).then((r) => {
    console.log(`통과: 검사 ${r.checks}개, ${(r.ms / 1000).toFixed(1)}초`);
    process.exit(0);
  }, (err) => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
}
