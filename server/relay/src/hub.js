/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 중계 허브 하나(로비 또는 방 하나)의 상태와 메시지 처리. 참가·퇴장, broadcast(전원·특정 대상), presence(입장·퇴장·메타),
 *          연결별 크기·속도 제한과 죽은 연결 정리. 네트워크와 타이머를 모르는 모듈이라 Durable Object와 node 시험이 같이 쓴다.
 */
/*
 * 연결(conn)은 { send(text), close(code, reason), save(state) }를 가진 물건이다.
 *   Durable Object: WebSocket을 감싸고 save = ws.serializeAttachment(state)   (worker.js)
 *   Node 어댑터·시험: node 소켓이나 가짜 연결을 감싼 물건                      (src/node.js, tests/relay.test.mjs)
 * 연결마다 남기는 상태(save) = { v, id, hub, at, seen, m, closed? }, m = { jr, key, pres, self, meta, ref } | null
 *   at = 연결 시각, seen = 마지막으로 메시지를 받은 시각(SEEN_SAVE_MS마다 갱신),
 *   jr = 참가 join_ref, key = presence 키(플레이어 id), pres = presence 사용, self = 내 broadcast도 받기,
 *   meta = track한 presence 한 줄, ref = 그 줄의 phx_ref
 * Durable Object가 잠들었다 깨어나면 메모리는 비고 이 상태만 남는다. attach(conn, 남긴 상태)로 허브를 다시 세운다.
 * 죽은 연결 판단은 seen과, 잠든 동안 런타임이 하트비트에 대신 답한 시각(sweep의 seenAt)으로 한다.
 */
import {
  Bucket, LIMITS, checkFrame, cleanMeta, frameFor, joinConfig, maskHub, parseEnvelope, parseHub, randomTag,
  broadcastText, presenceDiffText, presenceStateText, replyText, systemText
} from './rules.js';

const SAVED_VERSION = 1;
/** 마지막 활동 시각을 연결 상태에 남기는 간격. 깨어난 뒤 죽은 연결을 가릴 수 있을 만큼만 자주 남긴다 */
const SEEN_SAVE_MS = 30000;

export class Hub {
  /**
   * @param {string} name 허브 이름(rules.parseHub)
   * @param {{ now?: () => number, limits?: object, log?: (line: object) => void }} [opts]
   */
  constructor(name, { now = () => Date.now(), limits = LIMITS, log = () => {} } = {}) {
    const info = parseHub(name);
    if (!info) throw new Error('허브 이름이 아닙니다: ' + name);
    this.name = name;
    this.kind = info.kind;
    this.topic = info.topic;
    this.limits = limits;
    this.cap = limits[info.kind];
    this.now = now;
    this.log = log;
    this.conns = new Map();          // conn -> 실행 중 정보 { st, last, msg, chars, pres, drops, dropAt, warnAt }
    this.refPrefix = randomTag(6);   // 깨어날 때마다 새로 정하므로 잠들기 전의 ref와 겹치지 않는다
    this.refSeq = 0;
    this.since = now();              // 통계는 이 객체가 생기거나 깨어난 뒤부터 센다
    this.stats = { opened: 0, closedIdle: 0, closedAbuse: 0, msgsIn: 0, msgsOut: 0, charsIn: 0, charsOut: 0, dropped: 0, rejected: 0 };
  }

  get size() { return this.conns.size; }

  /** 새 연결을 더 받을 수 있는가 */
  canAccept() { return this.conns.size < this.cap.maxConns; }

  /** 새 연결(saved 없음) 또는 깨어난 뒤 다시 세우는 연결(saved = 남긴 상태). 받지 않는 상태면 false */
  attach(conn, saved) {
    const t = this.now();
    let st;
    if (saved) {
      if (typeof saved !== 'object' || saved.hub !== this.name || saved.closed) return false;
      const at = Number.isFinite(+saved.at) ? +saved.at : t;
      st = { v: SAVED_VERSION, id: String(saved.id || randomTag()), hub: this.name, at, seen: Number.isFinite(+saved.seen) ? +saved.seen : at, m: saved.m && typeof saved.m === 'object' ? { ...saved.m } : null };
    } else {
      st = { v: SAVED_VERSION, id: randomTag(), hub: this.name, at: t, seen: t, m: null };
      this.stats.opened++;
    }
    const L = this.limits;
    this.conns.set(conn, {
      st,
      // 깨어난 연결의 마지막 활동은 남긴 seen이다. "지금"으로 두면 하트비트가 끊긴 연결이 깨어날 때마다 되살아난다
      last: st.seen,
      msg: new Bucket(L.msgPerSec, L.msgBurst, t),
      chars: new Bucket(L.charsPerSec, L.charsBurst, t),
      pres: [], drops: 0, dropAt: t, warnAt: -Infinity
    });
    if (!saved) this._save(conn, st);
    return true;
  }

  /** 들어온 글자 하나. text가 문자열이 아니면(바이너리) 거절한다 */
  receive(conn, text) {
    const rt = this.conns.get(conn);
    if (!rt) return;
    const t = this.now();
    this._seen(conn, rt, t);
    const len = typeof text === 'string' ? text.length : 0;
    if (!rt.msg.take(1, t) || !rt.chars.take(len, t)) { this._abuse(conn, rt, t, 'rate_limited', true); return; }
    this.stats.msgsIn++;
    this.stats.charsIn += len;
    const { msg, error } = parseEnvelope(text, this.limits);
    if (error) { this._abuse(conn, rt, t, error); return; }
    if (msg.topic === 'phoenix') {
      if (msg.event === 'heartbeat') this._send(conn, replyText('phoenix', msg.ref, 'ok'));
      return;
    }
    if (msg.topic !== this.topic) { this._reply(conn, msg, 'error', { reason: 'topic_not_allowed' }); return; }
    switch (msg.event) {
      case 'phx_join': this._join(conn, rt, msg); return;
      case 'phx_leave': this._leave(conn, rt, msg); return;
      case 'broadcast': this._broadcast(conn, rt, msg, t); return;
      case 'presence': this._presence(conn, rt, msg, t); return;
      case 'access_token': return;   // Supabase 클라이언트가 보내는 토큰 갱신. 이 서버는 쓰지 않는다
      default: this._reply(conn, msg, 'error', { reason: 'unknown_event' });
    }
  }

  /** 허브를 거치지 않은 활동(어댑터가 직접 답한 하트비트)을 마지막 활동으로 적는다 */
  touch(conn) {
    const rt = this.conns.get(conn);
    if (rt) this._seen(conn, rt, this.now());
  }

  _seen(conn, rt, t) {
    rt.last = t;
    if (t - rt.st.seen >= SEEN_SAVE_MS) {
      rt.st.seen = t;
      this._save(conn, rt.st);
    }
  }

  /** 연결이 닫혔다(클라이언트가 닫음·오류). 두 번 불려도 된다 */
  detach(conn) {
    const rt = this.conns.get(conn);
    if (!rt) return;
    this.conns.delete(conn);
    const m = rt.st.m;
    rt.st.m = null;
    rt.st.closed = true;
    this._save(conn, rt.st);   // 깨어날 때 이 연결을 다시 세우지 않게 한다
    if (m && m.meta) this._diff({}, { [m.key]: { metas: [metaOut(m)] } });
  }

  /** 서버가 연결을 끊는다 */
  kill(conn, code, reason) {
    try { conn.close(code, reason); } catch (_) { /* 이미 닫힘 */ }
    this.detach(conn);
  }

  /**
   * 오래 아무 소리가 없는 연결을 닫는다(주기 작업). seenAt(conn) = 허브가 모르는 마지막 활동 시각
   * (Durable Object가 잠든 채 런타임이 하트비트에 대신 답한 시각). → 닫은 수
   */
  sweep(seenAt = () => 0) {
    const t = this.now();
    let n = 0;
    for (const [conn, rt] of [...this.conns]) {
      const last = Math.max(rt.last, +seenAt(conn) || 0);
      if (t - last <= this.limits.idleMs) continue;
      this.stats.closedIdle++;
      this.kill(conn, 4001, 'idle');
      n++;
    }
    return n;
  }

  /** 참가 중인 사람 수, presence를 올린 사람 수 */
  counts() {
    let members = 0, tracked = 0;
    for (const rt of this.conns.values()) {
      if (!rt.st.m) continue;
      members++;
      if (rt.st.m.meta) tracked++;
    }
    return { conns: this.conns.size, members, tracked };
  }

  /** 기록용 요약. 비밀번호 방의 비밀 값은 지운다 */
  summary() {
    return { hub: maskHub(this.name), kind: this.kind, ...this.counts(), upSec: Math.round((this.now() - this.since) / 1000), ...this.stats };
  }

  /* ---------------- 처리 ---------------- */

  _join(conn, rt, msg) {
    const cfg = joinConfig(msg.payload);
    if (cfg.error) { this._reply(conn, msg, 'error', { reason: cfg.error }); return; }
    // 같은 채널에 다시 참가하면 앞의 참가를 먼저 정리한다(Phoenix와 같다)
    if (rt.st.m) this._removeMember(conn, rt);
    if (this.counts().members >= this.cap.maxMembers) { this._reply(conn, msg, 'error', { reason: 'hub_full' }); return; }
    rt.st.m = { jr: msg.joinRef || msg.ref || '', key: cfg.key, pres: cfg.presence, self: cfg.self, meta: null, ref: null };
    rt.pres = [];
    this._save(conn, rt.st);
    this._reply(conn, msg, 'ok', {});
    if (cfg.presence) this._send(conn, presenceStateText(this.topic, this._presenceState()));
  }

  _leave(conn, rt, msg) {
    const m = rt.st.m;
    // 다시 참가한 뒤에 늦게 온 이전 참가의 퇴장은 지금 참가를 지우지 않는다
    if (m && (msg.joinRef == null || msg.joinRef === m.jr)) {
      this._removeMember(conn, rt);
      this._save(conn, rt.st);
    }
    this._reply(conn, msg, 'ok', {});
  }

  _removeMember(conn, rt) {
    const m = rt.st.m;
    rt.st.m = null;
    rt.pres = [];
    if (m && m.meta) this._diff({}, { [m.key]: { metas: [metaOut(m)] } });
  }

  _broadcast(conn, rt, msg, t) {
    const m = rt.st.m;
    if (!m) { this._abuse(conn, rt, t, 'not_joined'); return; }
    if (msg.joinRef != null && msg.joinRef !== m.jr) return;   // 지난 참가에서 보낸 것
    if (this.kind !== 'room') { this._abuse(conn, rt, t, 'broadcast_not_allowed'); return; }
    const p = msg.payload;
    if (p.type !== 'broadcast' || p.event !== 'f') { this._abuse(conn, rt, t, 'bad_event'); return; }
    const chk = checkFrame(p.payload, m.key, this.limits);
    if (chk.error) { this._abuse(conn, rt, t, chk.error); return; }
    const common = broadcastText(this.topic, 'f', frameFor(chk.frame, chk.targets, null));
    const own = new Map();
    for (const [c, r] of this.conns) {
      const mm = r.st.m;
      if (!mm || (c === conn && !mm.self)) continue;
      let text = common;
      if (chk.targets && chk.targets.has(mm.key)) {
        text = own.get(mm.key);
        if (!text) { text = broadcastText(this.topic, 'f', frameFor(chk.frame, chk.targets, mm.key)); own.set(mm.key, text); }
      }
      this._send(c, text);
    }
  }

  _presence(conn, rt, msg, t) {
    const m = rt.st.m;
    if (!m) { this._reply(conn, msg, 'error', { reason: 'not_joined' }); return; }
    if (msg.joinRef != null && msg.joinRef !== m.jr) { this._reply(conn, msg, 'error', { reason: 'stale_join' }); return; }
    if (!m.pres) { this._reply(conn, msg, 'error', { reason: 'presence_disabled' }); return; }
    const p = msg.payload;
    if (p.type !== 'presence' || (p.event !== 'track' && p.event !== 'untrack')) { this._reply(conn, msg, 'error', { reason: 'bad_presence' }); return; }
    rt.pres = rt.pres.filter((x) => t - x < this.limits.presenceWindowMs);
    if (rt.pres.length >= this.limits.presencePerWindow) { this._reply(conn, msg, 'error', { reason: 'rate_limited' }); return; }
    rt.pres.push(t);
    if (p.event === 'track') {
      const c = cleanMeta(p.payload, { key: m.key, kind: this.kind }, this.limits);
      if (c.error) { this._reply(conn, msg, 'error', { reason: c.error }); return; }
      const leaves = m.meta ? { [m.key]: { metas: [metaOut(m)] } } : {};
      m.meta = c.meta;
      m.ref = this.refPrefix + (++this.refSeq).toString(36);
      this._save(conn, rt.st);
      this._reply(conn, msg, 'ok', {});
      this._diff({ [m.key]: { metas: [metaOut(m)] } }, leaves);
      return;
    }
    const had = m.meta ? metaOut(m) : null;
    m.meta = null;
    m.ref = null;
    this._save(conn, rt.st);
    this._reply(conn, msg, 'ok', {});
    if (had) this._diff({}, { [m.key]: { metas: [had] } });
  }

  _presenceState() {
    const state = Object.create(null);
    for (const rt of this.conns.values()) {
      const m = rt.st.m;
      if (!m || !m.meta) continue;
      (state[m.key] || (state[m.key] = { metas: [] })).metas.push(metaOut(m));
    }
    return state;
  }

  /** presence 변화를 presence를 쓰는 모든 참가자에게(자기 자신 포함, Supabase와 같다) */
  _diff(joins, leaves) {
    const text = presenceDiffText(this.topic, joins, leaves);
    for (const [c, r] of this.conns) if (r.st.m && r.st.m.pres) this._send(c, text);
  }

  /** 버리거나 거절한 메시지. 너무 많으면 연결을 끊는다. 경고는 연결마다 warnGapMs에 한 번 */
  _abuse(conn, rt, t, reason, dropped = false) {
    if (dropped) this.stats.dropped++; else this.stats.rejected++;
    if (t - rt.dropAt > this.limits.dropWindowMs) { rt.dropAt = t; rt.drops = 0; }
    if (++rt.drops >= this.limits.dropLimit) {
      this.stats.closedAbuse++;
      this.log({ t: 'abuse', hub: maskHub(this.name), conn: rt.st.id, reason });
      this.kill(conn, 4008, 'policy: ' + reason);
      return;
    }
    if (t - rt.warnAt >= this.limits.warnGapMs) {
      rt.warnAt = t;
      this._send(conn, systemText(this.topic, reason));
    }
  }

  _reply(conn, msg, status, response) {
    if (msg.ref == null) return;
    this._send(conn, replyText(msg.topic, msg.ref, status, response));
  }

  _send(conn, text) {
    try { conn.send(text); } catch (_) { return; }   // 닫히는 중인 연결
    this.stats.msgsOut++;
    this.stats.charsOut += text.length;
  }

  _save(conn, st) {
    try { conn.save(st); } catch (_) { /* 닫힌 소켓 */ }
  }
}

/** presence 한 줄을 보낼 모양으로: 남이 보낸 칸 + 서버가 붙인 phx_ref */
function metaOut(m) {
  return { ...m.meta, phx_ref: m.ref };
}
