/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 받은편지함 시험용 가짜 Supabase(의존성 없음). Auth(/auth/v1: 비밀번호 로그인, 새로고침, 로그아웃, TOTP 등록·도전·확인·삭제)와
 *          PostgREST(/rest/v1: fps_feedback 목록·고치기, rpc/fps_is_admin)를 흉내 내고, supabase/schema.sql의 받은편지함 규칙을 같은 모양으로 둔다:
 *          관리자 표와 require_mfa(aal2), 열 단위 권한(읽기 열·reply·status만 수정), 행 거르기(관리자가 아니면 0행), 답 시각·상태(new→read)·빈 답 지우기 트리거,
 *          답 500자·상태 4종 제약. 인증 앱 코드는 늘 FAKE_TOTP_CODE다. 단위 시험은 fetch로, QA는 HTTP 서버(startFakeInbox)로 쓴다.
 *          실제 Postgres·Supabase와 같다는 보장은 없다. SQL 규칙은 schema.sql을 실제 Postgres에서 돌려 따로 확인한다.
 */
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

export const FAKE_TOTP_CODE = '123456';
export const FAKE_TOTP_SECRET = 'JBSWY3DPEHPK3PXP';
const STATUSES = ['new', 'read', 'done', 'hold'];
const READ_COLUMNS = ['id', 'player_id', 'name', 'kind', 'body', 'info', 'status', 'reply', 'replied_at', 'created_at'];
const UPDATE_COLUMNS = ['reply', 'status'];

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
/** Postgres의 timestamptz 글자 모양: 2026-11-17T01:23:45.123456+00:00 */
const pgTime = (ms) => new Date(ms).toISOString().replace(/\.(\d{3})Z$/, '.$1000+00:00');

/**
 * @param {{ key?: string, now?: () => number, tokenSeconds?: number }} [opts]
 * @returns {{ key, handle, fetch, users, feedback, log, flags, addUser, addFeedback, setTokenSeconds, expireAll, revokeRefresh }}
 */
export function createFakeInbox({ key = 'sb_publishable_test', now = Date.now, tokenSeconds = 3600 } = {}) {
  const users = new Map();       // 이메일(소문자) → 사용자
  const sessions = new Map();    // 액세스 토큰 → { userId, aal, exp(ms) }
  const refreshes = new Map();   // 새로고침 토큰 → { userId, aal }
  const challenges = new Map();  // 도전 번호 → factorId
  const feedback = [];
  const log = [];
  let nextId = 1;
  let lifetime = tokenSeconds;
  /** schema: false면 schema.sql의 받은편지함 부분을 아직 실행하지 않은 서버(함수 없음, 열 권한 없음). rateLimit: true면 로그인 시도 제한(429) */
  const flags = { schema: true, rateLimit: false };

  function addUser({ email, password, admin = false, requireMfa = false, totp = false, unconfirmed = false }) {
    const user = { id: randomUUID(), email: String(email).toLowerCase(), password, admin, requireMfa, unconfirmed, factors: [] };
    if (totp) user.factors.push({ id: randomUUID(), factor_type: 'totp', friendly_name: 'phone', status: 'verified' });
    users.set(user.email, user);
    return user;
  }

  function addFeedback({ name = '대원', kind = 'idea', body = '시험 건의 글입니다', info = { where: 'menu', ver: '2.0.0' }, status = 'new', reply = null, createdAt = now(), repliedAt = null, playerId = 7 } = {}) {
    const row = { id: nextId++, player_id: playerId, name, kind, body, info, status, reply, replied_at: repliedAt, created_at: createdAt };
    feedback.push(row);
    return row;
  }

  function issue(user, aal) {
    const t = now();
    const exp = t + lifetime * 1000;
    const access = `${b64url({ alg: 'ES256', typ: 'JWT' })}.${b64url({ sub: user.id, email: user.email, role: 'authenticated', aal, amr: [{ method: aal === 'aal2' ? 'totp' : 'password', timestamp: Math.floor(t / 1000) }], iat: Math.floor(t / 1000), exp: Math.floor(exp / 1000) })}.${randomUUID().replace(/-/g, '')}`;
    const refresh = randomUUID().replace(/-/g, '').slice(0, 12);
    sessions.set(access, { userId: user.id, aal, exp });
    refreshes.set(refresh, { userId: user.id, aal });
    return {
      access_token: access, token_type: 'bearer', expires_in: lifetime, expires_at: Math.floor(exp / 1000), refresh_token: refresh,
      user: { id: user.id, aud: 'authenticated', role: 'authenticated', email: user.email, factors: user.factors.map((f) => ({ ...f })) }
    };
  }

  const userById = (id) => [...users.values()].find((u) => u.id === id) || null;

  /** Authorization 머리글 → { anon } | { session, user } | { bad: 'expired'|'invalid' } */
  function who(headers) {
    const auth = headers.authorization || '';
    const m = /^Bearer (.+)$/i.exec(auth);
    if (!m || m[1] === key) return { anon: true };
    const s = sessions.get(m[1]);
    if (!s) return { bad: 'invalid' };
    if (s.exp <= now()) return { bad: 'expired' };
    return { session: s, user: userById(s.userId) };
  }

  const isAdmin = (w) => !!(w.user && w.user.admin && (!w.user.requireMfa || w.session.aal === 'aal2'));
  const json = (status, body, headers = {}) => ({ status, body, headers });
  const authError = (status, error_code, msg) => json(status, { code: status, error_code, msg });
  const denied = (w, what) => (w.anon
    ? json(401, { code: '42501', details: null, hint: null, message: `permission denied for ${what}` })
    : json(403, { code: '42501', details: null, hint: null, message: `permission denied for ${what}` }));

  function authRoute(method, path, query, headers, body) {
    const w = who(headers);
    if (method === 'POST' && path === '/auth/v1/token') {
      const grant = query.get('grant_type');
      if (flags.rateLimit) return authError(429, 'over_request_rate_limit', 'Request rate limit reached');
      if (grant === 'password') {
        const user = users.get(String(body.email || '').toLowerCase());
        if (!user || user.password !== body.password) return authError(400, 'invalid_credentials', 'Invalid login credentials');
        if (user.unconfirmed) return authError(400, 'email_not_confirmed', 'Email not confirmed');
        return json(200, issue(user, 'aal1'));
      }
      if (grant === 'refresh_token') {
        const r = refreshes.get(body.refresh_token);
        if (!r) return authError(400, 'refresh_token_not_found', 'Invalid Refresh Token: Refresh Token Not Found');
        refreshes.delete(body.refresh_token);   // 한 번 쓰면 끝(돌려 쓰는 토큰)
        return json(200, issue(userById(r.userId), r.aal));
      }
      return authError(400, 'validation_failed', 'unsupported grant_type');
    }
    if (method === 'POST' && path === '/auth/v1/logout') {
      if (!w.session) return authError(401, 'bad_jwt', 'invalid JWT');
      sessions.delete(headers.authorization.slice(7));
      for (const [t, r] of refreshes) if (r.userId === w.session.userId) refreshes.delete(t);   // 세션 하나만 흉내 낸다
      return { status: 204, body: null, headers: {} };
    }
    if (!w.session) return authError(401, w.bad === 'expired' ? 'bad_jwt' : 'no_authorization', 'missing or invalid authorization');
    const user = w.user;
    if (method === 'POST' && path === '/auth/v1/factors') {
      if (body.factor_type !== 'totp') return authError(422, 'validation_failed', 'unsupported factor');
      if (user.factors.some((f) => f.friendly_name === body.friendly_name)) return authError(422, 'mfa_factor_name_conflict', `A factor with the friendly name "${body.friendly_name}" for this user already exists`);
      const f = { id: randomUUID(), factor_type: 'totp', friendly_name: body.friendly_name, status: 'unverified' };
      user.factors.push(f);
      return json(200, {
        id: f.id, type: 'totp', friendly_name: f.friendly_name,
        totp: {
          qr_code: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 29 29"><rect width="29" height="29" fill="#fff"/><path d="M1 1h7v7H1zM21 1h7v7h-7zM1 21h7v7H1z" fill="#000"/></svg>',
          secret: FAKE_TOTP_SECRET,
          uri: `otpauth://totp/${encodeURIComponent(body.issuer || 'x')}:${encodeURIComponent(user.email)}?secret=${FAKE_TOTP_SECRET}&issuer=${encodeURIComponent(body.issuer || 'x')}`
        }
      });
    }
    const fm = /^\/auth\/v1\/factors\/([0-9a-f-]{36})(\/challenge|\/verify)?$/.exec(path);
    if (fm) {
      const factor = user.factors.find((f) => f.id === fm[1]);
      if (!factor) return authError(404, 'mfa_factor_not_found', 'MFA factor not found');
      if (method === 'POST' && fm[2] === '/challenge') {
        const id = randomUUID();
        challenges.set(id, factor.id);
        return json(200, { id, type: 'totp', expires_at: Math.floor(now() / 1000) + 300 });
      }
      if (method === 'POST' && fm[2] === '/verify') {
        if (challenges.get(body.challenge_id) !== factor.id) return authError(422, 'mfa_challenge_expired', 'MFA challenge has expired, verify against another challenge or create a new challenge.');
        challenges.delete(body.challenge_id);
        if (body.code !== FAKE_TOTP_CODE) return authError(400, 'mfa_verification_failed', 'Invalid TOTP code entered');
        factor.status = 'verified';
        return json(200, issue(user, 'aal2'));
      }
      if (method === 'DELETE' && !fm[2]) {
        if (factor.status === 'verified' && w.session.aal !== 'aal2') return authError(401, 'insufficient_aal', 'AAL2 required to unenroll verified factor');
        user.factors = user.factors.filter((f) => f !== factor);
        return json(200, { id: factor.id });
      }
    }
    return authError(404, 'not_found', 'not found');
  }

  function rest(method, path, query, headers, body) {
    const w = who(headers);
    if (w.bad) return json(401, { code: 'PGRST301', details: null, hint: null, message: w.bad === 'expired' ? 'JWT expired' : 'JWSError JWSInvalidSignature' });
    if (method === 'POST' && path === '/rest/v1/rpc/fps_is_admin') {
      if (!flags.schema) return json(404, { code: 'PGRST202', details: null, hint: null, message: 'Could not find the function public.fps_is_admin without parameters in the schema cache' });
      if (w.anon) return denied(w, 'function fps_is_admin');
      return json(200, isAdmin(w));
    }
    if (path !== '/rest/v1/fps_feedback') return json(404, { code: 'PGRST205', details: null, hint: null, message: 'Could not find the table in the schema cache' });
    if (w.anon || !flags.schema) return denied(w, 'table fps_feedback');
    const wantCount = /count=exact/.test(headers.prefer || '');
    const select = (query.get('select') || READ_COLUMNS.join(',')).split(',');
    if (select.some((c) => !READ_COLUMNS.includes(c))) return denied(w, 'table fps_feedback');
    const project = (row) => Object.fromEntries(select.map((c) => [c, c === 'created_at' || c === 'replied_at' ? (row[c] == null ? null : pgTime(row[c])) : row[c]]));
    const matches = (row) => {
      for (const col of ['kind', 'status', 'id']) { const v = query.get(col); if (v && String(row[col]) !== v.replace(/^eq\./, '')) return false; }
      return true;
    };

    if (method === 'GET') {
      if (!isAdmin(w)) return json(200, [], wantCount ? { 'content-range': '*/0' } : {});
      const rows = feedback.filter(matches).sort((a, b) => (b.created_at - a.created_at) || (b.id - a.id));
      const limit = Math.max(0, Number(query.get('limit') ?? rows.length));
      const offset = Math.max(0, Number(query.get('offset') ?? 0));
      const page = rows.slice(offset, offset + limit);
      const range = page.length ? `${offset}-${offset + page.length - 1}/${rows.length}` : `*/${rows.length}`;
      return json(200, page.map(project), wantCount ? { 'content-range': range } : {});
    }
    if (method === 'PATCH') {
      const keys = Object.keys(body || {});
      if (!keys.length || keys.some((k) => !UPDATE_COLUMNS.includes(k))) return denied(w, 'table fps_feedback');
      if (!isAdmin(w)) return json(200, []);
      const rows = feedback.filter(matches);
      for (const row of rows) {
        const next = { ...row };
        if ('status' in body) {
          if (!STATUSES.includes(body.status)) return json(400, { code: '23514', details: null, hint: null, message: 'new row for relation "fps_feedback" violates check constraint "fps_feedback_status_check"' });
          next.status = body.status;
        }
        if ('reply' in body && body.reply !== row.reply) {
          // fps_feedback_stamp 트리거: 앞뒤 공백(스페이스)을 자르고 빈 글이면 null, 답한 시각을 찍고, 새 글이면 확인함으로
          const reply = body.reply == null ? null : String(body.reply).replace(/^ +| +$/g, '') || null;
          next.reply = reply;
          next.replied_at = reply === null ? null : now();
          if (reply !== null && next.status === 'new') next.status = 'read';
          if (reply !== null && Array.from(reply).length > 500) return json(400, { code: '23514', details: null, hint: null, message: 'new row for relation "fps_feedback" violates check constraint "fps_feedback_reply_check"' });
        }
        Object.assign(row, next);
      }
      return /return=representation/.test(headers.prefer || '') ? json(200, rows.map(project)) : { status: 204, body: null, headers: {} };
    }
    return denied(w, 'table fps_feedback');
  }

  /** 요청 하나를 처리한다. → { status, body, headers }. headers 이름은 소문자 */
  function handle({ method, url, headers = {}, body = null }) {
    const u = new URL(url, 'http://fake.local');
    const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    let parsed = body;
    if (typeof body === 'string') { try { parsed = body ? JSON.parse(body) : null; } catch (_) { parsed = undefined; } }
    // 받은 요청 기록: 시험이 "토큰이 주소에 없다", "고치는 열은 reply·status뿐이다"를 확인한다. 본문 값(비밀번호 등)은 남기지 않고 열 이름만 남긴다
    log.push({
      method, path: u.pathname, query: u.search, hasAuth: !!h.authorization, bearer: /^Bearer /i.test(h.authorization || '') ? h.authorization.slice(7) : '',
      apikey: h.apikey || '', bodyKeys: parsed && typeof parsed === 'object' ? Object.keys(parsed) : []
    });
    if (h.apikey !== key) return json(401, { message: 'No API key found in request', hint: 'No `apikey` request header or url param was found.' });
    if (parsed === undefined) return json(400, { code: 'PGRST102', message: 'Invalid JSON' });
    if (u.pathname.startsWith('/auth/v1/')) return authRoute(method, u.pathname, u.searchParams, h, parsed || {});
    if (u.pathname.startsWith('/rest/v1/')) return rest(method, u.pathname, u.searchParams, h, parsed || {});
    return json(404, { message: 'not found' });
  }

  /** fetch 모양. 단위 시험이 쓴다 */
  async function fakeFetch(url, init = {}) {
    const headers = init.headers instanceof Headers ? Object.fromEntries(init.headers) : { ...(init.headers || {}) };
    const r = handle({ method: init.method || 'GET', url: String(url), headers, body: init.body ?? null });
    return new Response(r.body === null ? null : JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json', ...r.headers } });
  }

  return {
    key, handle, fetch: fakeFetch, users, feedback, log, sessions, refreshes, flags, addUser, addFeedback,
    /** 앞으로 발급하는 토큰의 수명(초) */
    setTokenSeconds(s) { lifetime = s; },
    /** 지금 있는 액세스 토큰을 모두 만료시킨다(새로고침 토큰은 남는다) */
    expireAll() { for (const s of sessions.values()) s.exp = 0; },
    /** 새로고침 토큰을 모두 지운다(서버에서 로그아웃당한 것처럼) */
    revokeRefresh() { refreshes.clear(); }
  };
}

/**
 * QA용 HTTP 서버. 브라우저가 부르므로 CORS를 열고(Authorization을 이름으로 허용), Content-Range를 보이게 한다.
 * @returns {Promise<{ url, port, fake, config, close() }>} config는 js/config.js에 넣을 글자
 */
export async function startFakeInbox(options = {}) {
  const fake = createFakeInbox(options);
  const handler = (req, res) => {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] || 'apikey, authorization, content-type, prefer, accept',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Expose-Headers': 'Content-Range'
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    let text = '';
    req.on('data', (c) => { text += c; });
    req.on('end', () => {
      const r = fake.handle({ method: req.method, url: req.url, headers: req.headers, body: text });
      const head = { ...cors, ...r.headers };
      if (r.body !== null) head['Content-Type'] = 'application/json';
      res.writeHead(r.status, head);
      res.end(r.body === null ? undefined : JSON.stringify(r.body));
    });
  };
  // 이 PC의 Windows에서는 listen이 가끔 EFAULT(bad address)로 실패한다. 코드와 상관없는 환경 문제라(순수 Node 스크립트에서도 난다) 서버를 새로 만들어 다시 시도한다
  let server = null;
  for (let attempt = 1; !server; attempt++) {
    const candidate = createServer(handler);
    try {
      await new Promise((resolve, reject) => { candidate.once('error', reject); candidate.listen(0, '127.0.0.1', resolve); });
      server = candidate;
    } catch (err) {
      candidate.close();
      if (!err || err.code !== 'EFAULT' || attempt >= 10) throw err;
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
  }
  const sockets = new Set();
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}`;
  return {
    url, port, fake,
    config: `window.SKALA_CONFIG = { supabase: { url: ${JSON.stringify(url)}, anonKey: ${JSON.stringify(fake.key)} } };\n`,
    close() { return new Promise((resolve) => { for (const s of sockets) s.destroy(); server.close(() => resolve()); }); }
  };
}
