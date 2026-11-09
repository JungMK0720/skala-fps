/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: Cloudflare Worker 입구와 Durable Object(허브 하나 = 객체 하나). Worker는 주소·Origin을 보고 허브 객체로 WebSocket을 넘기고,
 *          객체는 WebSocket Hibernation API로 연결을 받아 hub.js에 처리를 맡긴다. 하트비트는 객체를 깨우지 않고 런타임이 답한다.
 */
/*
 * 주소
 *   GET /health                         { ok: true }
 *   GET /ws?hub=<허브 이름> (WebSocket)  로비 'skalafps:lobby', 방 'skalafps:room:<id>[:<비밀 값>]'
 * 허브 이름이 곧 Durable Object 이름이다(idFromName). 비밀번호 방은 비밀 값까지 이름에 들어가므로 비밀번호를 모르면 같은 객체를 찾지 못한다.
 */
import { DurableObject } from 'cloudflare:workers';
import { Hub } from './hub.js';
import { HEARTBEAT_REQUEST, HEARTBEAT_RESPONSE, originAllowed, parseHub } from './rules.js';

const SWEEP_MS = 60000;   // 죽은 연결 정리와 통계 기록 간격. 연결이 있을 때만 알람을 건다

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' }
});

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/' || url.pathname === '/health') return json({ ok: true, service: 'skala-relay' });
    if (url.pathname !== '/ws') return json({ ok: false, error: 'not_found' }, 404);
    if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') return json({ ok: false, error: 'websocket_only' }, 426);
    if (!originAllowed(request.headers.get('Origin'), env.ALLOWED_ORIGINS)) return json({ ok: false, error: 'origin_not_allowed' }, 403);
    const hub = parseHub(url.searchParams.get('hub'));
    if (!hub) return json({ ok: false, error: 'bad_hub' }, 400);
    return env.HUB.get(env.HUB.idFromName(hub.name)).fetch(request);
  }
};

export class RelayHub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.hub = null;
    this.conns = new WeakMap();   // WebSocket -> hub.js 연결
    this.armed = false;
    // 잠든 동안에도 런타임이 하트비트에 바로 답한다(객체를 깨우지 않고, 실행 시간 요금도 붙지 않는다)
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(HEARTBEAT_REQUEST, HEARTBEAT_RESPONSE));
    // 잠들었다 깨어났다면 연결마다 남긴 상태로 허브를 다시 세운다
    for (const ws of ctx.getWebSockets()) this._conn(ws);
  }

  _ensureHub(name) {
    if (!this.hub) this.hub = new Hub(name, { log: (line) => console.log(JSON.stringify(line)) });
    return this.hub.name === name ? this.hub : null;
  }

  _wrap(ws) {
    const c = {
      ws,
      send: (text) => ws.send(text),
      close: (code, reason) => ws.close(code, reason),
      save: (st) => ws.serializeAttachment(st)
    };
    this.conns.set(ws, c);
    return c;
  }

  /** WebSocket → 연결. 메모리에 없으면(깨어난 직후) 남긴 상태로 다시 붙인다. 붙일 수 없으면 null */
  _conn(ws) {
    const known = this.conns.get(ws);
    if (known) return known;
    let saved = null;
    try { saved = ws.deserializeAttachment(); } catch (_) { saved = null; }
    const hub = saved && typeof saved.hub === 'string' && parseHub(saved.hub) ? this._ensureHub(saved.hub) : null;
    const c = this._wrap(ws);
    if (!hub || !hub.attach(c, saved)) {
      try { ws.close(1011, 'state lost'); } catch (_) { /* 이미 닫힘 */ }
      return null;
    }
    return c;
  }

  async fetch(request) {
    const name = new URL(request.url).searchParams.get('hub');
    const hub = parseHub(name) ? this._ensureHub(name) : null;
    if (!hub) return json({ ok: false, error: 'bad_hub' }, 400);
    if (!hub.canAccept()) return json({ ok: false, error: 'hub_full' }, 503);
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    hub.attach(this._wrap(server));
    await this._arm();
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, message) {
    const c = this._conn(ws);
    if (c) this.hub.receive(c, typeof message === 'string' ? message : null);
  }

  webSocketClose(ws, code, reason) {
    const c = this.conns.get(ws) || this._conn(ws);
    if (c && this.hub) this.hub.detach(c);
    try { ws.close(code, reason); } catch (_) { /* 1005·1006 같은 코드는 되돌려 보낼 수 없다 */ }
  }

  webSocketError(ws) {
    const c = this.conns.get(ws) || this._conn(ws);
    if (c && this.hub) this.hub.detach(c);
  }

  async alarm() {
    this.armed = false;
    const hub = this.hub;
    if (!hub) return;
    hub.sweep((c) => {
      const at = c.ws ? this.ctx.getWebSocketAutoResponseTimestamp(c.ws) : null;
      return at ? at.getTime() : 0;
    });
    if (hub.stats.msgsIn || hub.size) console.log(JSON.stringify({ t: 'hub', ...hub.summary() }));
    if (hub.size) await this._arm();
  }

  /** 정리 알람을 건다. 저장소 쓰기라서 메시지마다 하지 않고 연결을 받을 때와 알람 안에서만 한다 */
  async _arm() {
    if (this.armed) return;
    this.armed = true;
    if ((await this.ctx.storage.getAlarm()) == null) await this.ctx.storage.setAlarm(Date.now() + SWEEP_MS);
  }
}
