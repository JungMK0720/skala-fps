/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 멀티플레이 시험용 가짜 Supabase(의존성 없음). 닉네임·프로필 RPC와 Realtime의 WebSocket(Phoenix 채널: 참가, broadcast, presence)을 흉내 내어 실제 클라이언트 코드를 그대로 돌린다.
 *          실서버의 인증, 데이터베이스, 전송 한도는 검증하지 않는다. 포트는 운영체제가 고른다.
 */
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** 서버 → 브라우저 텍스트 프레임(마스크 없음) */
function encodeFrame(text, opcode = 1) {
  const body = Buffer.from(text, 'utf8');
  const n = body.length;
  let head;
  if (n < 126) head = Buffer.from([0x80 | opcode, n]);
  else if (n < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(n, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(n), 2); }
  return Buffer.concat([head, body]);
}

/** 브라우저 → 서버 프레임을 버퍼에서 꺼낸다. 다 오지 않았으면 null */
function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f, at = 2;
  if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); at = 4; }
  else if (len === 127) { if (buf.length < 10) return null; len = Number(buf.readBigUInt64BE(2)); at = 10; }
  const maskAt = at;
  if (masked) at += 4;
  if (buf.length < at + len) return null;
  const body = Buffer.from(buf.subarray(at, at + len));
  if (masked) for (let i = 0; i < len; i++) body[i] ^= buf[maskAt + (i % 4)];
  return { opcode, fin: (buf[0] & 0x80) !== 0, body, size: at + len };
}

/**
 * @param {{ takenNames?: string[], delayMs?: number, features?: boolean }} [options] takenNames: 이미 등록된 것으로 칠 닉네임, delayMs: 메시지 지연,
 *   features: false면 schema.sql을 다시 실행하기 전의 서버처럼 fps_features를 모른다(캐릭터 구매가 닫힌다)
 * @returns {Promise<{ url, config, stats, close() }>} config는 js/config.js에 넣을 글자
 */
export async function startFakeSupabase({ takenNames = [], delayMs = 0, features = true } = {}) {
  const players = new Map();          // 토큰 → 프로필
  const topics = new Map();           // 전체 topic → Set(연결)
  const conns = new Set();
  const stats = { rpc: {}, broadcasts: 0, presence: 0, joins: 0, connections: 0 };
  const taken = new Set(takenNames.map((n) => String(n).toLowerCase()));
  let refSeq = 1;

  const nameOwner = (name) => {
    for (const [token, p] of players) if (p.name && p.name.toLowerCase() === String(name).toLowerCase()) return token;
    return null;
  };

  function rpc(fn, a) {
    switch (fn) {
      case 'fps_check_nickname':
        return taken.has(String(a.p_name).toLowerCase()) || nameOwner(a.p_name) ? { ok: false, error: 'NAME_TAKEN' } : { ok: true };
      case 'fps_claim_nickname': {
        const owner = nameOwner(a.p_name);
        if (taken.has(String(a.p_name).toLowerCase()) || (owner && owner !== a.p_token)) return { ok: false, error: 'NAME_TAKEN' };
        players.set(a.p_token, { ...(players.get(a.p_token) || {}), name: a.p_name });
        return { ok: true, name: a.p_name };
      }
      case 'fps_get_profile': {
        const p = players.get(a.p_token);
        return p ? { ok: true, profile: { name: p.name, points: p.points, owned: p.owned, loadout: p.loadout, stats: p.stats, secrets: p.secrets } } : { ok: false, error: 'NOT_FOUND' };
      }
      case 'fps_save_profile':
        if (!players.has(a.p_token)) return { ok: false, error: 'NOT_FOUND' };
        players.set(a.p_token, { ...players.get(a.p_token), points: a.p_points, owned: a.p_owned, loadout: a.p_loadout, stats: a.p_stats, secrets: a.p_secrets });
        return { ok: true };
      case 'fps_top_players':
        return { ok: true, players: [] };
      case 'fps_features':
        return features ? { ok: true, avatars: true } : { ok: false, error: 'UNKNOWN' };
      default:
        return { ok: false, error: 'UNKNOWN' };
    }
  }

  const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
  const server = createServer((req, res) => {
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
    const m = /^\/rest\/v1\/rpc\/(\w+)/.exec(req.url || '');
    if (!m) { res.writeHead(404, CORS); res.end('{}'); return; }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      stats.rpc[m[1]] = (stats.rpc[m[1]] || 0) + 1;
      let args = {};
      try { args = JSON.parse(body || '{}'); } catch (err) { args = {}; }
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(rpc(m[1], args)));
    });
  });

  /* ───────────── Realtime(Phoenix) ───────────── */
  function send(conn, msg) {
    if (conn.closed) return;
    const out = () => { if (!conn.closed) conn.socket.write(encodeFrame(JSON.stringify(msg))); };
    if (delayMs > 0) setTimeout(out, delayMs); else out();
  }
  const reply = (conn, topic, ref, response = {}) => send(conn, { topic, event: 'phx_reply', payload: { status: 'ok', response }, ref });

  function metaOf(entry) {
    return { metas: [{ phx_ref: entry.presenceRef, ...entry.tracked }] };
  }

  function presenceState(topic) {
    const state = {};
    for (const c of topics.get(topic) || []) {
      const e = c.joined.get(topic);
      if (e && e.tracked) state[e.key] = metaOf(e);
    }
    return state;
  }

  function presenceDiff(topic, joins, leaves) {
    for (const c of topics.get(topic) || []) {
      const e = c.joined.get(topic);
      if (e && e.presence) send(c, { topic, event: 'presence_diff', payload: { joins, leaves }, ref: null });
    }
  }

  function leaveTopic(conn, topic) {
    const e = conn.joined.get(topic);
    if (!e) return;
    conn.joined.delete(topic);
    const set = topics.get(topic);
    if (set) { set.delete(conn); if (!set.size) topics.delete(topic); }
    if (e.tracked) presenceDiff(topic, {}, { [e.key]: metaOf(e) });
  }

  function onMessage(conn, msg) {
    const { topic, event, payload, ref } = msg;
    if (topic === 'phoenix') { if (event === 'heartbeat') reply(conn, 'phoenix', ref); return; }
    if (event === 'phx_join') {
      leaveTopic(conn, topic);
      const cfg = (payload && payload.config) || {};
      const entry = {
        key: (cfg.presence && cfg.presence.key) || `anon-${refSeq++}`,
        presence: !!(cfg.presence && cfg.presence.enabled),
        self: !!(cfg.broadcast && cfg.broadcast.self),
        tracked: null, presenceRef: null
      };
      conn.joined.set(topic, entry);
      if (!topics.has(topic)) topics.set(topic, new Set());
      topics.get(topic).add(conn);
      stats.joins++;
      reply(conn, topic, ref, { postgres_changes: [] });
      if (entry.presence) send(conn, { topic, event: 'presence_state', payload: presenceState(topic), ref: null });
      return;
    }
    const entry = conn.joined.get(topic);
    if (event === 'phx_leave') {
      reply(conn, topic, ref);
      send(conn, { topic, event: 'phx_close', payload: {}, ref });
      leaveTopic(conn, topic);
      return;
    }
    if (!entry) { send(conn, { topic, event: 'phx_reply', payload: { status: 'error', response: { reason: 'unmatched topic' } }, ref }); return; }
    if (event === 'broadcast') {
      stats.broadcasts++;
      for (const c of topics.get(topic) || []) {
        if (c === conn && !entry.self) continue;
        send(c, { topic, event: 'broadcast', payload: { type: 'broadcast', event: payload.event, payload: payload.payload }, ref: null });
      }
      return;
    }
    if (event === 'presence') {
      stats.presence++;
      const old = entry.tracked ? metaOf(entry) : null;
      if (payload.event === 'track') {
        entry.tracked = payload.payload || {};
        entry.presenceRef = `r${refSeq++}`;
        reply(conn, topic, ref);
        presenceDiff(topic, { [entry.key]: metaOf(entry) }, old ? { [entry.key]: old } : {});
      } else {
        entry.tracked = null;
        reply(conn, topic, ref);
        if (old) presenceDiff(topic, {}, { [entry.key]: old });
      }
      return;
    }
    reply(conn, topic, ref);
  }

  function dropConn(conn) {
    if (conn.closed) return;
    conn.closed = true;
    conns.delete(conn);
    for (const topic of [...conn.joined.keys()]) leaveTopic(conn, topic);
  }

  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!/^\/realtime\/v1\/websocket/.test(req.url || '') || !key) { socket.destroy(); return; }
    const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const conn = { socket, joined: new Map(), closed: false, buf: Buffer.alloc(0) };
    conns.add(conn);
    stats.connections++;
    socket.on('data', (chunk) => {
      conn.buf = Buffer.concat([conn.buf, chunk]);
      for (;;) {
        const f = decodeFrame(conn.buf);
        if (!f) break;
        conn.buf = conn.buf.subarray(f.size);
        if (f.opcode === 8) { try { socket.write(encodeFrame('', 8)); socket.end(); } catch (err) { /* 이미 닫힘 */ } dropConn(conn); return; }
        if (f.opcode === 9) { socket.write(encodeFrame(f.body.toString('utf8'), 10)); continue; }
        if (f.opcode !== 1) continue;
        try { onMessage(conn, JSON.parse(f.body.toString('utf8'))); } catch (err) { console.error('[fake-supabase] 메시지 처리 실패', err); }
      }
    });
    socket.on('close', () => dropConn(conn));
    socket.on('error', () => dropConn(conn));
  });

  await new Promise((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', res); });
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    port,
    stats,
    players,
    topics,
    /** 모든 WebSocket을 서버 쪽에서 끊는다. 네트워크가 잠깐 끊긴 상황을 흉내 낸다 */
    dropAll() {
      for (const c of [...conns]) { dropConn(c); c.socket.destroy(); }
    },
    /** js/config.js 내용 */
    config: `window.SKALA_CONFIG = { supabase: { url: ${JSON.stringify(url)}, anonKey: 'sb_qa_fake' } };`,
    close() {
      return new Promise((res) => {
        for (const c of conns) { c.closed = true; c.socket.destroy(); }
        conns.clear();
        server.close(() => res());
        server.closeAllConnections();
      });
    }
  };
}
