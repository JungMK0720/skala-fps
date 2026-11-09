#!/usr/bin/env node
/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 중계 허브(hub.js)를 Node에서 돌리는 어댑터(의존성 없음). Worker와 같은 주소(/health, /ws?hub=)와 같은 규칙을 쓴다.
 *          시험(tests/relay.test.mjs)과 QA(--relay node)가 wrangler 없이 쓰고, VM에서 직접 띄울 수도 있다. 사용: node server/relay/src/node.js [--port 8788] [--host 127.0.0.1]
 */
/*
 * Durable Object와 다른 점: 허브가 메모리에만 있고(잠들지 않는다), 하트비트도 허브가 직접 답한다.
 * WebSocket은 RFC 6455의 필요한 부분만 구현했다(텍스트·닫기·핑 프레임, 조각 프레임 이어 붙이기, 압축 없음).
 */
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Hub } from './hub.js';
import { DEFAULT_ORIGINS, HEARTBEAT_REQUEST, HEARTBEAT_RESPONSE, LIMITS, originAllowed, parseHub } from './rules.js';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME_BYTES = 1 << 20;

function encodeFrame(body, opcode) {
  const n = body.length;
  let head;
  if (n < 126) head = Buffer.from([0x80 | opcode, n]);
  else if (n < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(n, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(n), 2); }
  return Buffer.concat([head, body]);
}

/** 버퍼 앞의 프레임 하나. 아직 다 오지 않았으면 null, 너무 크면 { tooLarge } */
function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const fin = (buf[0] & 0x80) !== 0;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f, at = 2;
  if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); at = 4; }
  else if (len === 127) { if (buf.length < 10) return null; len = Number(buf.readBigUInt64BE(2)); at = 10; }
  if (len > MAX_FRAME_BYTES) return { tooLarge: true };
  const maskAt = at;
  if (masked) at += 4;
  if (buf.length < at + len) return null;
  const body = Buffer.from(buf.subarray(at, at + len));
  if (masked) for (let i = 0; i < len; i++) body[i] ^= buf[maskAt + (i % 4)];
  return { fin, opcode, body, size: at + len };
}

/**
 * @param {{ port?: number, host?: string, origins?: string, limits?: object, now?: () => number, sweepMs?: number, log?: (line: object) => void }} [opts]
 * @returns {Promise<{ url, port, hubs: Map, stats, dropAll(): void, close(): Promise<void> }>}
 *   dropAll: 모든 WebSocket을 서버 쪽에서 끊는다(네트워크가 잠깐 끊긴 상황, QA용)
 */
export async function startRelay({ port = 0, host = '127.0.0.1', origins = DEFAULT_ORIGINS, limits = LIMITS, now = () => Date.now(), sweepMs = 15000, log = () => {} } = {}) {
  const hubs = new Map();   // 허브 이름 -> Hub
  const sockets = new Set();
  const stats = { connections: 0, rejected: 0 };

  const hubFor = (name) => {
    let hub = hubs.get(name);
    if (!hub) { hub = new Hub(name, { now, limits, log }); hubs.set(name, hub); }
    return hub;
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://relay');
    const ok = url.pathname === '/' || url.pathname === '/health';
    res.writeHead(ok ? 200 : 404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify(ok ? { ok: true, service: 'skala-relay-node' } : { ok: false, error: 'not_found' }));
  });

  server.on('upgrade', (req, socket) => {
    const deny = (status, text) => { stats.rejected++; try { socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch (_) { socket.destroy(); } };
    const url = new URL(req.url || '/', 'http://relay');
    const key = req.headers['sec-websocket-key'];
    if (url.pathname !== '/ws' || !key) { deny(400, 'Bad Request'); return; }
    if (!originAllowed(req.headers.origin, origins)) { deny(403, 'Forbidden'); return; }
    const info = parseHub(url.searchParams.get('hub'));
    if (!info) { deny(400, 'Bad Request'); return; }
    const hub = hubFor(info.name);
    if (!hub.canAccept()) { deny(503, 'Service Unavailable'); return; }
    const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.setNoDelay(true);
    stats.connections++;
    sockets.add(socket);

    let closed = false;
    const conn = {
      send(text) { if (!closed) socket.write(encodeFrame(Buffer.from(text, 'utf8'), 1)); },
      close(code = 1000, reason = '') {
        if (closed) return;
        closed = true;
        const body = Buffer.alloc(2 + Buffer.byteLength(reason));
        body.writeUInt16BE(code, 0);
        body.write(reason, 2);
        try { socket.end(encodeFrame(body, 8)); } catch (_) { socket.destroy(); }
      },
      save() { /* Node 어댑터는 잠들지 않으므로 남길 필요가 없다 */ }
    };
    hub.attach(conn);
    const gone = () => {
      sockets.delete(socket);
      closed = true;
      hub.detach(conn);
    };

    let buf = Buffer.alloc(0);
    let parts = null;   // 조각 프레임
    socket.on('data', (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      for (;;) {
        const f = decodeFrame(buf);
        if (!f) break;
        if (f.tooLarge) { conn.close(1009, 'too large'); gone(); socket.destroy(); return; }
        buf = buf.subarray(f.size);
        if (f.opcode === 8) { conn.close(1000, ''); gone(); return; }
        if (f.opcode === 9) { socket.write(encodeFrame(f.body, 10)); continue; }
        if (f.opcode === 10) continue;
        if (f.opcode === 1 || f.opcode === 2) parts = { opcode: f.opcode, chunks: [f.body] };
        else if (f.opcode === 0 && parts) parts.chunks.push(f.body);
        else continue;
        if (!f.fin) continue;
        const whole = Buffer.concat(parts.chunks);
        const op = parts.opcode;
        parts = null;
        if (op !== 1) { hub.receive(conn, null); continue; }
        const text = whole.toString('utf8');
        // Durable Object의 setWebSocketAutoResponse와 같다: 정해진 하트비트에는 허브를 거치지 않고 답한다
        if (text === HEARTBEAT_REQUEST) { conn.send(HEARTBEAT_RESPONSE); hub.touch(conn); continue; }
        hub.receive(conn, text);
      }
    });
    socket.on('close', gone);
    socket.on('error', gone);
  });

  const sweepTimer = setInterval(() => {
    for (const [name, hub] of hubs) {
      hub.sweep();
      if (!hub.size) hubs.delete(name);   // 빈 허브는 버린다(Durable Object가 잠드는 것과 같다)
    }
  }, sweepMs);
  if (sweepTimer.unref) sweepTimer.unref();

  await new Promise((res, rej) => { server.once('error', rej); server.listen(port, host, res); });
  const actual = server.address().port;
  return {
    url: `http://${host}:${actual}`,
    port: actual,
    hubs,
    stats,
    dropAll() { for (const s of [...sockets]) s.destroy(); },
    close() {
      clearInterval(sweepTimer);
      return new Promise((res) => {
        for (const s of sockets) s.destroy();
        sockets.clear();
        server.close(() => res());
        server.closeAllConnections();
      });
    }
  };
}

function parseArgs(argv) {
  const o = { port: 8788, host: '127.0.0.1' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') o.port = Number(argv[++i]);
    else if (argv[i] === '--host') o.host = String(argv[++i]);
    else throw new Error('모르는 옵션: ' + argv[i]);
  }
  return o;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const o = parseArgs(process.argv.slice(2));
  startRelay({ ...o, log: (line) => console.log(JSON.stringify(line)) }).then((r) => {
    console.log(`skala-relay(node): ${r.url}  (WebSocket ${r.url.replace(/^http/, 'ws')}/ws?hub=<허브>)`);
    const every = setInterval(() => {
      for (const hub of r.hubs.values()) if (hub.size) console.log(JSON.stringify({ t: 'hub', ...hub.summary() }));
    }, 60000);
    const stop = () => { clearInterval(every); r.close().then(() => process.exit(0)); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  }, (err) => { console.error(err && err.stack ? err.stack : err); process.exit(1); });
}
