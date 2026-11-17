/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 건의 받은편지함(dev/inbox.html) 검증. js/admin/inbox.js의 요청 만들기·응답 정리·오류 문구·세션(가짜 서버로 로그인·목록·답·상태·토큰 만료·2단계 인증),
 *          inbox-view.js의 그리기(가짜 DOM으로 글이 HTML로 해석되지 않는지), supabase/schema.sql의 권한·정책이 JS 규칙과 같은지·anon에 새 권한이 없는지,
 *          페이지의 요소와 문서의 값(프로젝트 주소, 쪽 크기, 정책 이름, SOP 순서)이 설정과 맞는지 대조한다.
 */
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { FEEDBACK_KINDS, FEEDBACK_KIND_NAMES, FEEDBACK_REPLY_MAX, FEEDBACK_STATUS_NAMES, feedbackLength } from '../js/account/feedback.js';
import {
  INBOX, INBOX_MESSAGES, authFailure, buildListPath, buildPatchPath, createInboxClient, decodeJwtPayload, formatKst, infoRows, inboxConfig,
  needsMfa, normalizeInboxItem, normalizeInboxItems, pageArgs, parseContentRange, restFailure, sessionFromAuthBody, snippet, statusChips,
  validFilter, validateReply
} from '../js/admin/inbox.js';
import { qrDataUrl, renderChips, renderInfo, renderList, renderRow } from '../js/admin/inbox-view.js';
import { FAKE_TOTP_CODE, FAKE_TOTP_SECRET, createFakeInbox, startFakeInbox } from '../tools/qa/fake-inbox.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(resolve(ROOT, path), 'utf8');
const CONFIG = Object.freeze({ url: 'https://proj.supabase.co', anonKey: 'sb_publishable_test' });
const EMAIL = 'owner@example.com';
const PASSWORD = 'correct-horse-battery-1';

function memoryStorage() {
  const map = new Map();
  return { map, getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => { map.set(k, String(v)); }, removeItem: (k) => { map.delete(k); } };
}

/** 가짜 서버와 클라이언트, 둘이 같이 보는 시계. rows: 번호가 클수록 새 글인 건의를 이만큼 넣는다 */
function setup({ admin = true, requireMfa = false, totp = false, rows = 0, tokenSeconds = 3600, wrap = (f) => f, timeoutMs = 500 } = {}) {
  let t = Date.parse('2026-11-17T01:00:00Z');
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const fake = createFakeInbox({ key: CONFIG.anonKey, now: clock.now, tokenSeconds });
  const user = fake.addUser({ email: EMAIL, password: PASSWORD, admin, requireMfa, totp });
  const kinds = [...FEEDBACK_KINDS];
  for (let i = 0; i < rows; i++) {
    fake.addFeedback({ name: `대원${i + 1}`, kind: kinds[i % 4], body: `${i + 1}번째 건의 글입니다`, createdAt: t - (rows - i) * 60_000, status: i % 5 === 0 ? 'done' : 'new' });
  }
  const storage = memoryStorage();
  const make = (extra = {}) => createInboxClient({ fetch: wrap(fake.fetch), config: CONFIG, storage, now: clock.now, timeoutMs, ...extra });
  return { fake, user, storage, clock, make, client: make() };
}
const loginOk = async (s) => { const r = await s.client.signIn(EMAIL, PASSWORD); assert.equal(r.ok, true, JSON.stringify(r)); return r; };
const idsOf = (items) => items.map((i) => i.id);

// ─────────────────────────────── 요청 만들기 · 검증 ───────────────────────────────
describe('설정과 요청 주소', () => {
  test('inboxConfig: 앞뒤 공백·끝의 /를 정리하고 둘 다 있어야 켜진다', () => {
    assert.deepEqual(inboxConfig({ url: ' https://a.supabase.co/// ', anonKey: ' k ' }), { url: 'https://a.supabase.co', key: 'k', enabled: true });
    assert.equal(inboxConfig({ url: '', anonKey: 'k' }).enabled, false);
    assert.equal(inboxConfig({ url: 'https://a.supabase.co', anonKey: '' }).enabled, false);
    assert.equal(inboxConfig({}).enabled, false);
  });

  test('inboxConfig: 인자가 없으면 SKALA_CONFIG.supabase를 읽는다', (t) => {
    const saved = globalThis.SKALA_CONFIG;
    t.after(() => { if (saved === undefined) delete globalThis.SKALA_CONFIG; else globalThis.SKALA_CONFIG = saved; });
    globalThis.SKALA_CONFIG = { supabase: { url: 'https://b.supabase.co/', anonKey: 'sb_publishable_b' } };
    assert.deepEqual(inboxConfig(), { url: 'https://b.supabase.co', key: 'sb_publishable_b', enabled: true });
    delete globalThis.SKALA_CONFIG;
    assert.equal(inboxConfig().enabled, false);
  });

  test('buildListPath: 새 글이 위, 100건씩, 열은 읽기 권한이 있는 열만', () => {
    assert.equal(
      buildListPath(),
      '/rest/v1/fps_feedback?select=id,player_id,name,kind,body,info,status,reply,replied_at,created_at&order=created_at.desc,id.desc&limit=100&offset=0'
    );
    assert.equal(buildListPath({ kind: 'bug', status: 'new', offset: 200 }), `${buildListPath({ offset: 200 })}&kind=eq.bug&status=eq.new`);
    assert.equal(INBOX.PAGE_SIZE, 100);
  });

  test('buildListPath: 모르는 거르기 값은 주소를 만들지 않는다(질의 끼워 넣기 방지)', () => {
    for (const bad of [{ kind: 'x' }, { kind: 'bug&select=*' }, { kind: 'BUG' }, { status: 'new;drop' }, { status: 'weird' }, { status: 'eq.new' }, { kind: 'bug', status: 'x' }]) {
      assert.equal(buildListPath(bad), null, JSON.stringify(bad));
      assert.equal(validFilter(bad), false, JSON.stringify(bad));
    }
    for (const k of ['', ...FEEDBACK_KINDS]) for (const s of ['', ...INBOX.STATUSES]) assert.equal(validFilter({ kind: k, status: s }), true);
  });

  test('pageArgs: offset은 0 이상, limit은 1~100의 정수', () => {
    assert.deepEqual(pageArgs(), { offset: 0, limit: 100 });
    assert.deepEqual(pageArgs({ offset: -5, limit: 9999 }), { offset: 0, limit: 100 });
    assert.deepEqual(pageArgs({ offset: '30', limit: '20' }), { offset: 30, limit: 20 });
    assert.deepEqual(pageArgs({ offset: NaN, limit: 0 }), { offset: 0, limit: 100 });
    assert.deepEqual(pageArgs({ offset: 7.9, limit: 3.2 }), { offset: 7, limit: 3 });
    assert.match(buildListPath({ offset: 1e9, limit: 1000 }), /limit=100&offset=1000000000/);
  });

  test('buildPatchPath: 글 번호는 양의 정수만', () => {
    assert.equal(buildPatchPath(12), '/rest/v1/fps_feedback?id=eq.12&select=id,player_id,name,kind,body,info,status,reply,replied_at,created_at');
    for (const bad of [0, -1, 1.5, NaN, Infinity, '12', '1;x', null, undefined, 2 ** 60]) assert.equal(buildPatchPath(bad), null, String(bad));
  });

  test('parseContentRange: 전체 개수만 꺼낸다', () => {
    assert.equal(parseContentRange('0-99/1234'), 1234);
    assert.equal(parseContentRange('*/0'), 0);
    assert.equal(parseContentRange(' 100-129/130 '), 130);
    for (const bad of ['5-9/*', '', null, undefined, 'garbage', '0-99', '/5']) assert.equal(parseContentRange(bad), null, String(bad));
  });
});

describe('validateReply', () => {
  test('본문과 같은 규칙으로 정리한다(줄바꿈·줄 끝 공백·안 보이는 글자·앞뒤 공백)', () => {
    const v = validateReply('  고쳤어요.  \r\n\r\n\r\n다음 배포에 들어가요​  ');
    assert.deepEqual(v, { ok: true, reply: '고쳤어요.\n\n다음 배포에 들어가요', length: feedbackLength('고쳤어요.\n\n다음 배포에 들어가요') });
  });

  test('빈 글은 답 지우기(reply: null)', () => {
    for (const empty of ['', '   ', '\n\n', null, undefined, '​']) assert.deepEqual(validateReply(empty), { ok: true, reply: null, length: 0 }, JSON.stringify(empty));
  });

  test(`${FEEDBACK_REPLY_MAX}자까지. 이모지 하나는 한 글자(서버 char_length와 같다)`, () => {
    assert.equal(INBOX.REPLY_MAX, FEEDBACK_REPLY_MAX);
    assert.equal(validateReply('가'.repeat(FEEDBACK_REPLY_MAX)).ok, true);
    const over = validateReply('가'.repeat(FEEDBACK_REPLY_MAX + 1));
    assert.deepEqual([over.ok, over.reason, over.message, over.length], [false, 'replyLong', INBOX_MESSAGES.replyLong, FEEDBACK_REPLY_MAX + 1]);
    assert.equal(validateReply('😀'.repeat(FEEDBACK_REPLY_MAX)).ok, true);
    assert.equal(validateReply('😀'.repeat(FEEDBACK_REPLY_MAX + 1)).ok, false);
  });
});

describe('normalizeInboxItem', () => {
  const row = { id: 12, player_id: 7, name: '대원', kind: 'bug', body: '버그예요', info: { where: 'menu', ver: '2.0.0', touch: false, w: 1920 }, status: 'new', reply: null, replied_at: null, created_at: '2026-11-17T01:23:45.123456+00:00' };

  test('Postgres의 시각 글자(마이크로초·+00:00)를 밀리초로 바꾼다', () => {
    const item = normalizeInboxItem(row);
    assert.deepEqual(item, {
      id: 12, playerId: 7, name: '대원', kind: 'bug', body: '버그예요', info: { touch: false, ver: '2.0.0', w: 1920, where: 'menu' },
      status: 'new', reply: null, repliedAt: null, createdAt: Date.parse('2026-11-17T01:23:45.123Z')
    });
  });

  test('답이 있어야 답한 시각이 있다. 공백뿐인 답은 없는 것', () => {
    const a = normalizeInboxItem({ ...row, reply: '고쳤어요', replied_at: '2026-11-17T02:00:00.5+00:00', status: 'read' });
    assert.equal(a.reply, '고쳤어요');
    assert.equal(a.repliedAt, Date.parse('2026-11-17T02:00:00.5Z'));
    const b = normalizeInboxItem({ ...row, reply: '   ', replied_at: '2026-11-17T02:00:00+00:00' });
    assert.deepEqual([b.reply, b.repliedAt], [null, null]);
  });

  test('모르는 종류·상태는 기본값으로, 지워진 플레이어는 playerId null', () => {
    const item = normalizeInboxItem({ ...row, kind: 'spam', status: 'weird', player_id: null });
    assert.deepEqual([item.kind, item.status, item.playerId], ['other', 'new', null]);
  });

  test('쓸 수 없는 행은 버린다', () => {
    for (const bad of [null, undefined, 'x', 5, [], {}, { ...row, id: 0 }, { ...row, id: 'abc' }, { ...row, id: -3 }, { ...row, body: 5 }, { ...row, body: null }]) {
      assert.equal(normalizeInboxItem(bad), null, JSON.stringify(bad));
    }
    assert.deepEqual(idsOf(normalizeInboxItems([row, null, { ...row, id: 0 }, { ...row, id: 13 }])), [12, 13]);
    assert.deepEqual(normalizeInboxItems('x'), []);
    assert.deepEqual(normalizeInboxItems(null), []);
  });

  test('진단 정보는 짧은 문자열·숫자·참거짓만, 12칸까지', () => {
    const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${String(i).padStart(2, '0')}`, i]));
    const item = normalizeInboxItem({ ...row, info: { ...many, nested: { a: 1 }, list: [1], nul: null, nan: NaN, long: 'x'.repeat(201) } });
    assert.equal(Object.keys(item.info).length, INBOX.INFO_KEYS);
    for (const bad of [null, 'x', 5, [1, 2]]) assert.deepEqual(normalizeInboxItem({ ...row, info: bad }).info, {});
  });

  test('본문은 서버 상한(1,000자)까지만 가진다', () => {
    assert.equal(Array.from(normalizeInboxItem({ ...row, body: '가'.repeat(1500) }).body).length, 1000);
  });
});

describe('보여 주기 도우미', () => {
  test('formatKst: 한국 시간으로, 날짜·해가 넘어가는 경계도 맞다', () => {
    assert.equal(formatKst(Date.UTC(2026, 10, 17, 1, 23)), '11-17 10:23');
    assert.equal(formatKst(Date.UTC(2026, 10, 17, 1, 23), { long: true }), '2026-11-17 10:23');
    assert.equal(formatKst(Date.UTC(2026, 10, 17, 15, 30)), '11-18 00:30');
    assert.equal(formatKst(Date.UTC(2026, 11, 31, 15, 0), { long: true }), '2027-01-01 00:00');
    for (const bad of [null, undefined, NaN, 'x', Infinity]) assert.equal(formatKst(bad), '–', String(bad));
  });

  test('snippet: 줄바꿈·연속 공백을 한 칸으로, 코드 포인트 단위로 자르고 …을 붙인다', () => {
    assert.equal(snippet('  첫 줄\n\n  둘째   줄\t셋째  '), '첫 줄 둘째 줄 셋째');
    assert.equal(snippet('가'.repeat(100), 10), `${'가'.repeat(10)}…`);
    assert.equal(snippet('😀'.repeat(20), 5), `${'😀'.repeat(5)}…`);
    assert.equal(snippet('짧아요', 10), '짧아요');
    assert.equal(snippet(null), '');
  });

  test('infoRows: 아는 칸을 먼저 한국어 이름으로, 모르는 칸은 키 그대로 뒤에', () => {
    assert.deepEqual(
      infoRows({ zzz: 'x', where: 'pause', ver: '2.0.0', touch: true, scr: '1920x1080', br: 'Edge 157', mode: 'team', map: 'alley', aaa: 5 }),
      [['연 곳', '일시정지 메뉴'], ['모드', 'team'], ['맵', 'alley'], ['버전', '2.0.0'], ['브라우저', 'Edge 157'], ['화면 크기', '1920x1080'], ['터치 기기', '예'], ['aaa', '5'], ['zzz', 'x']]
    );
    assert.deepEqual(infoRows({ where: 'menu', touch: false }), [['연 곳', '메인 메뉴'], ['터치 기기', '아니요']]);
    assert.deepEqual(infoRows({ where: 'other' }), [['연 곳', 'other']]);
    for (const none of [null, undefined, {}, 'x']) assert.deepEqual(infoRows(none), []);
  });

  test('statusChips: 전체 합계와 상태별 개수, 서버 상태 순서', () => {
    assert.deepEqual(statusChips({ new: 3, read: 5, done: 20, hold: 1 }), [
      { status: '', label: '전체', count: 29 }, { status: 'new', label: '접수', count: 3 }, { status: 'read', label: '확인함', count: 5 },
      { status: 'done', label: '반영', count: 20 }, { status: 'hold', label: '보류', count: 1 }
    ]);
    assert.deepEqual(statusChips(null).map((c) => c.count), [0, 0, 0, 0, 0]);
    assert.deepEqual(statusChips({}).map((c) => c.label), ['전체', ...INBOX.STATUSES.map((s) => FEEDBACK_STATUS_NAMES[s])]);
  });
});

describe('토큰 · 세션 모양', () => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const jwt = (payload) => `${b64({ alg: 'ES256' })}.${b64(payload)}.sig`;

  test('decodeJwtPayload: 가운데 덩어리만 읽는다. 모양이 틀리면 null', () => {
    assert.deepEqual(decodeJwtPayload(jwt({ sub: 'u1', aal: 'aal2', email: '한글@example.com' })), { sub: 'u1', aal: 'aal2', email: '한글@example.com' });
    for (const bad of [null, undefined, '', 'abc', 'a.b', 'a.b.c.d', 'a..c', `a.${Buffer.from('[1]').toString('base64url')}.c`, `a.${Buffer.from('not json').toString('base64url')}.c`]) {
      assert.equal(decodeJwtPayload(bad), null, String(bad));
    }
  });

  test('sessionFromAuthBody: 만료는 expires_in을 내 시계에 더하고, aal과 확인된 TOTP를 읽는다', () => {
    const body = {
      access_token: jwt({ sub: 'u1', email: 'a@b.c', aal: 'aal1', exp: 9_999_999_999 }), refresh_token: 'r1', expires_in: 3600,
      user: { id: 'u1', email: 'a@b.c', factors: [{ id: 'f1', factor_type: 'totp', status: 'verified', friendly_name: 'phone' }, { id: 'f2', factor_type: 'phone', status: 'verified' }, { id: 'f3', factor_type: 'totp', status: 'unverified' }] }
    };
    const s = sessionFromAuthBody(body, 1_000_000);
    assert.equal(s.expiresAt, 1_000_000 + 3_600_000);
    assert.deepEqual(s.user, { id: 'u1', email: 'a@b.c' });
    assert.equal(s.aal, 'aal1');
    assert.deepEqual(s.factors, [{ id: 'f1', status: 'verified', friendlyName: 'phone' }, { id: 'f3', status: 'unverified', friendlyName: '' }]);
    assert.equal(needsMfa(s), true);
    const up = sessionFromAuthBody({ ...body, access_token: jwt({ sub: 'u1', aal: 'aal2' }) }, 0);
    assert.equal(up.aal, 'aal2');
    assert.equal(needsMfa(up), false);
    assert.equal(needsMfa(null), false);
  });

  test('sessionFromAuthBody: expires_in이 없으면 JWT의 exp, 그것도 없으면 5분. 쓸 수 없는 모양은 null', () => {
    const base = { refresh_token: 'r', user: { id: 'u1' } };
    assert.equal(sessionFromAuthBody({ ...base, access_token: jwt({ sub: 'u1', exp: 2000 }) }, 1_000_000).expiresAt, 2_000_000);
    assert.equal(sessionFromAuthBody({ ...base, access_token: jwt({ sub: 'u1' }) }, 1_000_000).expiresAt, 1_000_000 + 300_000);
    assert.equal(sessionFromAuthBody({ ...base, access_token: jwt({ sub: 'u1', exp: 5 }) }, 1_000_000).expiresAt, 1_000_000 + 300_000, '이미 지난 exp는 믿지 않는다');
    for (const bad of [null, {}, { access_token: 'x' }, { refresh_token: 'r' }, { access_token: jwt({}), refresh_token: 'r' }, 'str']) assert.equal(sessionFromAuthBody(bad, 0), null, JSON.stringify(bad));
  });

  test('새로고침 응답에 factors가 없으면 앞 세션의 것을 이어받는다', () => {
    const prev = { user: { id: 'u1', email: 'a@b.c' }, factors: [{ id: 'f1', status: 'verified', friendlyName: '' }] };
    const s = sessionFromAuthBody({ access_token: jwt({ sub: 'u1', aal: 'aal2' }), refresh_token: 'r2', expires_in: 60, user: { id: 'u1' } }, 0, prev);
    assert.deepEqual(s.factors, prev.factors);
    assert.equal(s.user.email, 'a@b.c');
  });
});

describe('오류 → 화면 문구', () => {
  test('authFailure: 새 형식과 옛 형식을 모두 읽는다', () => {
    const cases = [
      [{ status: 400, json: { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' } }, 'credentials'],
      [{ status: 400, json: { error: 'invalid_grant', error_description: 'Invalid login credentials' } }, 'credentials'],
      [{ status: 400, json: { error_code: 'email_not_confirmed', msg: 'Email not confirmed' } }, 'unconfirmed'],
      [{ status: 400, json: { msg: 'Email not confirmed' } }, 'unconfirmed'],
      [{ status: 429, json: { error_code: 'over_request_rate_limit' } }, 'rate'],
      [{ status: 400, json: { error_code: 'over_email_send_rate_limit' } }, 'rate'],
      [{ status: 400, json: { error_code: 'mfa_verification_failed', msg: 'Invalid TOTP code entered' } }, 'mfaCode'],
      [{ status: 422, json: { error_code: 'mfa_challenge_expired' } }, 'mfaCode'],
      [{ status: 422, json: { error_code: 'mfa_factor_name_conflict' } }, 'unknown'],
      [{ status: 401, json: { error_code: 'insufficient_aal' } }, 'aal'],
      [{ status: 400, json: { error_code: 'refresh_token_not_found' } }, 'expired'],
      [{ status: 401, json: { error_code: 'bad_jwt' } }, 'expired'],
      [{ status: 500, json: null }, 'server'],
      [{ status: 502, json: {} }, 'server'],
      [{ status: 418, json: { msg: 'teapot' } }, 'unknown'],
      [null, 'unknown']
    ];
    for (const [res, reason] of cases) assert.equal(authFailure(res).reason, reason, JSON.stringify(res));
    assert.equal(authFailure({ status: 418, json: { msg: 'teapot' } }).detail, 'teapot');
  });

  test('restFailure: PostgREST 코드를 구분한다', () => {
    const cases = [
      [{ status: 401, json: { code: 'PGRST301', message: 'JWT expired' } }, 'expired'],
      [{ status: 401, json: { code: '42501', message: 'permission denied for table fps_feedback' } }, 'expired'],
      [{ status: 403, json: { code: '42501', message: 'permission denied for table fps_feedback' } }, 'denied'],
      [{ status: 404, json: { code: 'PGRST202', message: 'Could not find the function' } }, 'missing'],
      [{ status: 404, json: { code: 'PGRST205' } }, 'missing'],
      [{ status: 400, json: { code: '23514', message: 'violates check constraint' } }, 'invalid'],
      [{ status: 400, json: { code: '22P02' } }, 'invalid'],
      [{ status: 429, json: {} }, 'rate'],
      [{ status: 503, json: {} }, 'server'],
      [{ status: 400, json: { code: 'PGRST102' } }, 'unknown'],
      [undefined, 'unknown']
    ];
    for (const [res, reason] of cases) assert.equal(restFailure(res).reason, reason, JSON.stringify(res));
  });

  test('모든 reason에 한국어 문구가 있다', () => {
    for (const reason of ['config', 'fields', 'credentials', 'unconfirmed', 'rate', 'mfaFormat', 'mfaCode', 'mfaFactor', 'aal', 'expired', 'network', 'server', 'denied', 'missing', 'noRow', 'invalid', 'replyLong', 'nochange', 'badItem', 'badFilter', 'unknown']) {
      assert.match(INBOX_MESSAGES[reason] || '', /[가-힣]/, reason);
    }
  });
});

// ─────────────────────────────── 클라이언트 흐름 (가짜 서버) ───────────────────────────────
describe('로그인', () => {
  test('성공하면 세션이 생기고 sessionStorage에 남는다. 로그인 요청에는 공개 키만 간다', async () => {
    const s = setup();
    const r = await loginOk(s);
    assert.deepEqual(r, { ok: true, email: EMAIL, needsMfa: false });
    const st = s.client.state();
    assert.deepEqual([st.signedIn, st.email, st.aal, st.needsMfa], [true, EMAIL, 'aal1', false]);
    assert.ok(!('accessToken' in st) && !JSON.stringify(st).includes('Bearer'), '화면 쪽에 토큰을 내보내지 않는다');
    const login = s.fake.log[0];
    assert.deepEqual([login.method, login.path, login.query, login.hasAuth, login.apikey], ['POST', '/auth/v1/token', '?grant_type=password', false, CONFIG.anonKey]);
    assert.deepEqual(login.bodyKeys, ['email', 'password']);
    const saved = JSON.parse(s.storage.getItem(INBOX.STORAGE_KEY));
    assert.deepEqual([saved.v, saved.user.email, saved.aal], [1, EMAIL, 'aal1']);
  });

  test('이메일은 앞뒤 공백을 자르고 소문자로, 비밀번호는 그대로 보낸다', async () => {
    const bodies = [];
    const s = setup({ wrap: (f) => async (url, init) => { if (String(url).includes('grant_type=password')) bodies.push(JSON.parse(init.body)); return f(url, init); } });
    assert.equal((await s.client.signIn(`  ${EMAIL.toUpperCase()}  `, PASSWORD)).ok, true);
    assert.deepEqual(bodies, [{ email: EMAIL, password: PASSWORD }]);
    const spaced = setup({ wrap: (f) => async (url, init) => { if (String(url).includes('grant_type=password')) bodies.push(JSON.parse(init.body)); return f(url, init); } });
    assert.equal((await spaced.client.signIn(EMAIL, ` ${PASSWORD} `)).reason, 'credentials', '비밀번호는 다듬지 않는다(앞뒤 공백도 비밀번호의 일부)');
    assert.equal(bodies.at(-1).password, ` ${PASSWORD} `);
  });

  test('틀린 비밀번호, 빈 칸, 이메일 미확인, 시도 제한, 서버 오류를 구분한다', async () => {
    const s = setup();
    const wrong = await s.client.signIn(EMAIL, 'wrong');
    assert.deepEqual([wrong.ok, wrong.reason, wrong.message], [false, 'credentials', INBOX_MESSAGES.credentials]);
    assert.equal(s.client.state().signedIn, false);
    assert.equal(s.storage.getItem(INBOX.STORAGE_KEY), null);
    const before = s.fake.log.length;
    for (const [e, p] of [['', PASSWORD], [EMAIL, ''], ['  ', '  '], [null, undefined]]) assert.equal((await s.client.signIn(e, p)).reason, 'fields');
    assert.equal(s.fake.log.length, before, '빈 칸은 서버에 묻지 않는다');
    s.fake.addUser({ email: 'new@example.com', password: PASSWORD, unconfirmed: true });
    assert.equal((await s.client.signIn('new@example.com', PASSWORD)).reason, 'unconfirmed');
    s.fake.flags.rateLimit = true;
    assert.equal((await s.client.signIn(EMAIL, PASSWORD)).reason, 'rate');
    s.fake.flags.rateLimit = false;
    const down = setup({ wrap: () => async () => new Response('{}', { status: 502 }) });
    assert.equal((await down.client.signIn(EMAIL, PASSWORD)).reason, 'server');
  });

  test('네트워크가 끊기거나 응답이 없으면 network, 설정이 비면 config. 예외를 던지지 않는다', async () => {
    const dead = setup({ wrap: () => async () => { throw new TypeError('Failed to fetch'); } });
    assert.equal((await dead.client.signIn(EMAIL, PASSWORD)).reason, 'network');
    assert.equal((await dead.client.isAdmin()).reason, 'expired', '로그인 전에는 서버에 묻지 않고 expired');
    const hang = setup({ wrap: () => () => new Promise(() => {}), timeoutMs: 30 });
    const t0 = Date.now();
    assert.equal((await hang.client.signIn(EMAIL, PASSWORD)).reason, 'network');
    assert.ok(Date.now() - t0 < 2000);
    const off = createInboxClient({ config: { url: '', anonKey: '' }, fetch: () => assert.fail('호출하면 안 된다') });
    assert.equal(off.enabled, false);
    assert.equal((await off.signIn(EMAIL, PASSWORD)).reason, 'config');
    assert.equal((await off.restore()).reason, 'config');
    assert.equal((await off.list()).reason, 'config');
  });

  test('저장소가 막혀 있어도(sessionStorage 예외) 메모리로 계속한다', async () => {
    const boom = () => { throw new Error('SecurityError'); };
    const s = setup();
    const client = s.make({ storage: { getItem: boom, setItem: boom, removeItem: boom } });
    assert.equal((await client.signIn(EMAIL, PASSWORD)).ok, true);
    assert.equal((await client.isAdmin()).admin, true);
    assert.deepEqual(await client.restore(), { ok: true, restored: false }, '저장된 것이 없으니 되살릴 것도 없다');
    assert.equal((await client.signOut()).ok, true);
  });
});

describe('관리자 확인과 목록', () => {
  test('isAdmin: 관리자면 true, 아니면 false(목록은 늘 빈다), 서버에 함수가 없으면 missing', async () => {
    const a = setup();
    await loginOk(a);
    assert.deepEqual(await a.client.isAdmin(), { ok: true, admin: true });
    const n = setup({ admin: false, rows: 3 });
    await loginOk(n);
    assert.deepEqual(await n.client.isAdmin(), { ok: true, admin: false });
    const l = await n.client.list();
    assert.deepEqual([l.ok, l.items.length, l.total], [true, 0, 0], '관리자가 아니면 RLS가 0행을 준다');
    a.fake.flags.schema = false;
    const m = await a.client.isAdmin();
    assert.deepEqual([m.ok, m.reason, m.message], [false, 'missing', INBOX_MESSAGES.missing]);
    assert.equal((await a.client.list()).reason, 'denied', '새 권한을 안 만든 서버: 표 읽기가 거절된다');
  });

  test('list: 새 글이 위, 100건씩, 전체 개수와 더 있음을 알려 준다', async () => {
    const s = setup({ rows: 130 });
    await loginOk(s);
    const p1 = await s.client.list();
    assert.deepEqual([p1.ok, p1.items.length, p1.total, p1.hasMore], [true, 100, 130, true]);
    assert.equal(p1.items[0].id, 130);
    assert.ok(p1.items.every((it, i, all) => i === 0 || all[i - 1].createdAt >= it.createdAt), '새 글 먼저');
    const p2 = await s.client.list({ offset: 100 });
    assert.deepEqual([p2.items.length, p2.total, p2.hasMore, p2.items[0].id, p2.items.at(-1).id], [30, 130, false, 30, 1]);
    assert.equal(new Set([...idsOf(p1.items), ...idsOf(p2.items)]).size, 130, '겹치거나 빠진 글이 없다');
    const empty = await s.client.list({ offset: 500 });
    assert.deepEqual([empty.ok, empty.items.length, empty.hasMore], [true, 0, false]);
  });

  test('list: 종류·상태로 거르고, 틀린 값은 서버에 묻지 않는다', async () => {
    const s = setup({ rows: 40 });
    await loginOk(s);
    const bugs = await s.client.list({ kind: 'bug' });
    assert.ok(bugs.items.length > 0 && bugs.items.every((i) => i.kind === 'bug'));
    assert.equal(bugs.total, 10);
    const done = await s.client.list({ status: 'done' });
    assert.ok(done.items.every((i) => i.status === 'done'));
    const both = await s.client.list({ kind: 'bug', status: 'new' });
    assert.ok(both.items.every((i) => i.kind === 'bug' && i.status === 'new'));
    const before = s.fake.log.length;
    assert.equal((await s.client.list({ kind: 'bug&select=*' })).reason, 'badFilter');
    assert.equal(s.fake.log.length, before);
  });

  test('counts: 상태별 개수', async () => {
    const s = setup({ rows: 40 });
    await loginOk(s);
    s.fake.feedback[1].status = 'hold';
    s.fake.feedback[2].status = 'read';
    const c = await s.client.counts();
    assert.deepEqual(c, { ok: true, counts: { new: 30, read: 1, done: 8, hold: 1 } });
    assert.equal(Object.values(c.counts).reduce((a, b) => a + b, 0), 40, '네 상태를 더하면 전체');
  });

  test('요청 머리글: 사용자 요청에는 Bearer 토큰과 apikey, 토큰은 주소나 본문에 없다', async () => {
    const s = setup({ rows: 3 });
    await loginOk(s);
    await s.client.isAdmin();
    await s.client.list();
    await s.client.counts();
    await s.client.saveReply(3, '답이에요');
    await s.client.saveStatus(3, 'done');
    await s.client.signOut();
    const token = s.fake.log.find((l) => l.bearer).bearer;
    assert.ok(token.length > 40);
    for (const l of s.fake.log) {
      assert.ok(!(l.path + l.query).includes(token), `${l.method} ${l.path}: 토큰이 주소에 있다`);
      assert.equal(l.apikey, CONFIG.anonKey, `${l.path}: apikey`);
      if (l.path !== '/auth/v1/token') assert.ok(l.hasAuth, `${l.path}: 사용자 토큰`);
    }
    const patches = s.fake.log.filter((l) => l.method === 'PATCH');
    assert.equal(patches.length, 2);
    for (const p of patches) assert.ok(p.bodyKeys.every((k) => INBOX_SQL_UPDATE.includes(k)), `고치는 열은 reply·status뿐: ${p.bodyKeys}`);
  });
});

const INBOX_SQL_UPDATE = ['reply', 'status'];

describe('답과 상태 저장', () => {
  test('답을 저장하면 정리해서 보내고, 서버 트리거가 답한 시각과 확인함 상태를 정한다', async () => {
    const s = setup({ rows: 3 });
    await loginOk(s);
    const r = await s.client.saveReply(3, '  고쳤어요!  \r\n\r\n\r\n다음 배포에 들어가요  ');
    assert.equal(r.ok, true);
    assert.equal(r.item.reply, '고쳤어요!\n\n다음 배포에 들어가요');
    assert.equal(r.item.status, 'read', '새 글(new)에 답하면 read');
    assert.equal(r.item.repliedAt, s.clock.now());
    assert.equal(s.fake.feedback.find((f) => f.id === 3).reply, '고쳤어요!\n\n다음 배포에 들어가요');
  });

  test('이미 반영(done)인 글에 답해도 상태는 그대로', async () => {
    const s = setup({ rows: 3 });
    await loginOk(s);
    const done = (await s.client.saveStatus(2, 'done')).item;
    assert.equal(done.status, 'done');
    assert.equal((await s.client.saveReply(2, '반영했어요')).item.status, 'done');
  });

  test('빈 글은 답을 지운다(reply·repliedAt 모두 사라진다)', async () => {
    const s = setup({ rows: 2 });
    await loginOk(s);
    await s.client.saveReply(2, '임시 답');
    const r = await s.client.saveReply(2, '   \n  ');
    assert.deepEqual([r.ok, r.item.reply, r.item.repliedAt], [true, null, null]);
    assert.equal(s.fake.log.at(-1).bodyKeys.join(), 'reply');
  });

  test('500자 넘는 답은 서버에 보내지 않는다. 정확히 500자는 된다', async () => {
    const s = setup({ rows: 2 });
    await loginOk(s);
    const before = s.fake.log.length;
    const over = await s.client.saveReply(2, '가'.repeat(FEEDBACK_REPLY_MAX + 1));
    assert.deepEqual([over.ok, over.reason], [false, 'replyLong']);
    assert.equal(s.fake.log.length, before);
    assert.equal((await s.client.saveReply(2, '가'.repeat(FEEDBACK_REPLY_MAX))).ok, true);
  });

  test('상태 단추(read·done·hold)는 상태만 보내고 답은 건드리지 않는다. new나 모르는 상태는 보내지 않는다', async () => {
    const s = setup({ rows: 2 });
    await loginOk(s);
    await s.client.saveReply(2, '답');
    for (const st of INBOX.STATUS_ACTIONS) {
      const r = await s.client.saveStatus(2, st);
      assert.deepEqual([r.ok, r.item.status, r.item.reply], [true, st, '답']);
      assert.deepEqual(s.fake.log.at(-1).bodyKeys, ['status']);
    }
    const before = s.fake.log.length;
    for (const bad of ['new', 'weird', '', null, undefined, 'done ']) assert.equal((await s.client.saveStatus(2, bad)).reason, 'invalid', String(bad));
    assert.equal(s.fake.log.length, before);
  });

  test('없는 글·권한 없는 계정은 noRow(0행 수정). 글 번호가 틀리면 서버에 묻지 않는다', async () => {
    const s = setup({ rows: 2 });
    await loginOk(s);
    const missing = await s.client.saveReply(999, '답');
    assert.deepEqual([missing.ok, missing.reason, missing.message], [false, 'noRow', INBOX_MESSAGES.noRow]);
    const before = s.fake.log.length;
    for (const bad of [0, -1, 1.5, 'x', NaN, null]) assert.equal((await s.client.saveReply(bad, '답')).reason, 'badItem', String(bad));
    assert.equal(s.fake.log.length, before);
    const n = setup({ admin: false, rows: 2 });
    await loginOk(n);
    assert.equal((await n.client.saveStatus(2, 'hold')).reason, 'noRow');
    assert.equal((await n.client.saveReply(2, '답')).reason, 'noRow');
    assert.deepEqual(n.fake.feedback.map((f) => [f.status, f.reply]), [['done', null], ['new', null]], '권한 없는 계정은 아무것도 바꾸지 못했다');
  });

  test('서버가 check 제약으로 거절하면 invalid, 권한이 없으면 denied', async () => {
    const s = setup({ rows: 2, wrap: (f) => async (url, init) => (String(url).includes('/rest/v1/fps_feedback?id=') ? new Response(JSON.stringify({ code: '23514', message: 'violates check constraint' }), { status: 400 }) : f(url, init)) });
    await loginOk(s);
    assert.equal((await s.client.saveReply(1, '답')).reason, 'invalid');
    const d = setup({ rows: 2, wrap: (f) => async (url, init) => (String(url).includes('/rest/v1/fps_feedback?id=') ? new Response(JSON.stringify({ code: '42501', message: 'permission denied for table fps_feedback' }), { status: 403 }) : f(url, init)) });
    await loginOk(d);
    assert.equal((await d.client.saveReply(1, '답')).reason, 'denied');
  });
});

describe('토큰 만료와 새로고침', () => {
  const refreshCount = (s) => s.fake.log.filter((l) => l.query === '?grant_type=refresh_token').length;

  test('만료 1분 안쪽이면 요청 전에 새 토큰을 받는다. 새로고침 토큰은 한 번 쓰고 바뀐다', async () => {
    const s = setup({ rows: 2 });
    await loginOk(s);
    const oldRefresh = JSON.parse(s.storage.getItem(INBOX.STORAGE_KEY)).refreshToken;
    s.clock.advance(3600_000 - 30_000);
    const l = await s.client.list();
    assert.equal(l.ok, true);
    assert.equal(refreshCount(s), 1);
    const saved = JSON.parse(s.storage.getItem(INBOX.STORAGE_KEY));
    assert.notEqual(saved.refreshToken, oldRefresh);
    assert.ok(!s.fake.refreshes.has(oldRefresh), '쓴 새로고침 토큰은 서버에서 지워진다');
    assert.ok(saved.expiresAt > s.clock.now() + 3000_000, '새 만료');
  });

  test('요청 여러 개가 동시에 만료를 만나도 새로고침은 한 번만 한다', async () => {
    const s = setup({ rows: 10 });
    await loginOk(s);
    s.clock.advance(3600_000 - 10_000);
    const [list, counts, admin] = await Promise.all([s.client.list(), s.client.counts(), s.client.isAdmin()]);
    assert.deepEqual([list.ok, counts.ok, admin.ok], [true, true, true]);
    assert.equal(refreshCount(s), 1);
  });

  test('서버가 먼저 만료시켜 401을 주면 한 번 새로 받아 다시 시도한다', async () => {
    const s = setup({ rows: 2 });
    await loginOk(s);
    s.fake.expireAll();
    const l = await s.client.list();
    assert.equal(l.ok, true);
    const seq = s.fake.log.slice(-3).map((x) => `${x.method} ${x.path}`);
    assert.deepEqual(seq, ['GET /rest/v1/fps_feedback', 'POST /auth/v1/token', 'GET /rest/v1/fps_feedback']);
    assert.equal(refreshCount(s), 1);
  });

  test('새로고침 토큰도 못 쓰면 expired이고 저장된 세션을 지운다. 네트워크 실패는 세션을 지키지 않고 알린다', async () => {
    const s = setup({ rows: 2 });
    await loginOk(s);
    s.fake.expireAll();
    s.fake.revokeRefresh();
    const r = await s.client.list();
    assert.deepEqual([r.ok, r.reason], [false, 'expired']);
    assert.equal(s.client.state().signedIn, false);
    assert.equal(s.storage.getItem(INBOX.STORAGE_KEY), null);
    assert.equal((await s.client.list()).reason, 'expired', '그 뒤에는 서버에 묻지 않는다');

    let down = false;
    const n = setup({ rows: 2, wrap: (f) => async (url, init) => { if (down) throw new TypeError('offline'); return f(url, init); } });
    await loginOk(n);
    down = true;
    n.clock.advance(3600_000 - 10_000);
    assert.equal((await n.client.list()).reason, 'network');
    assert.equal(n.client.state().signedIn, true, '끊긴 것뿐이면 로그인은 그대로');
    down = false;
    assert.equal((await n.client.list()).ok, true);
  });
});

describe('로그아웃과 되살리기', () => {
  test('signOut: 이 기기 세션만 끝내고(scope=local) 토큰을 지운다. 그 뒤에는 서버에 묻지 않는다', async () => {
    const s = setup({ rows: 2 });
    await loginOk(s);
    assert.deepEqual(await s.client.signOut(), { ok: true });
    const out = s.fake.log.find((l) => l.path === '/auth/v1/logout');
    assert.deepEqual([out.method, out.query, out.hasAuth], ['POST', '?scope=local', true]);
    assert.deepEqual(s.client.state(), { signedIn: false, email: '', userId: '', aal: null, needsMfa: false, factors: [], expiresAt: 0 });
    assert.equal(s.storage.getItem(INBOX.STORAGE_KEY), null);
    assert.equal(s.fake.sessions.size, 0, '서버 쪽 토큰도 무효');
    const before = s.fake.log.length;
    assert.equal((await s.client.list()).reason, 'expired');
    assert.equal(s.fake.log.length, before);
    assert.deepEqual(await s.client.signOut(), { ok: true }, '두 번 불러도 된다');
  });

  test('서버가 실패해도 이 탭의 토큰은 지운다', async () => {
    const s = setup({ rows: 1, wrap: (f) => async (url, init) => { if (String(url).includes('/logout')) throw new TypeError('offline'); return f(url, init); } });
    await loginOk(s);
    assert.deepEqual(await s.client.signOut(), { ok: true });
    assert.equal(s.client.state().signedIn, false);
    assert.equal(s.storage.getItem(INBOX.STORAGE_KEY), null);
  });

  test('restore: 같은 탭을 다시 열면 세션이 되살아난다(만료됐으면 새 토큰으로)', async () => {
    const s = setup({ rows: 2 });
    await loginOk(s);
    const again = s.make();
    assert.deepEqual(await again.restore(), { ok: true, restored: true });
    assert.equal(again.state().email, EMAIL);
    assert.equal((await again.list()).ok, true);
    s.clock.advance(2 * 3600_000);
    const late = s.make();
    assert.deepEqual(await late.restore(), { ok: true, restored: true });
    assert.equal((await late.list()).ok, true);
    assert.ok(s.fake.log.some((l) => l.query === '?grant_type=refresh_token'));
  });

  test('restore: 저장된 것이 없거나 망가졌거나 새로고침 토큰이 죽었으면 로그인 화면으로', async () => {
    const s = setup();
    assert.deepEqual(await s.make().restore(), { ok: true, restored: false });
    s.storage.setItem(INBOX.STORAGE_KEY, '{망가진');
    assert.deepEqual(await s.make().restore(), { ok: true, restored: false });
    assert.equal(s.storage.getItem(INBOX.STORAGE_KEY), null, '망가진 것은 지운다');
    s.storage.setItem(INBOX.STORAGE_KEY, JSON.stringify({ v: 2, accessToken: 'a', refreshToken: 'b', expiresAt: 1, user: { id: 'u' } }));
    assert.equal((await s.make().restore()).restored, false);
    await s.client.signIn(EMAIL, PASSWORD);
    s.clock.advance(2 * 3600_000);
    s.fake.revokeRefresh();
    assert.deepEqual(await s.make().restore(), { ok: true, restored: false });
    assert.equal(s.storage.getItem(INBOX.STORAGE_KEY), null);
  });
});

describe('2단계 인증(TOTP)', () => {
  test('등록된 인증 앱이 있으면 로그인 뒤 코드가 더 필요하다. 코드를 넣으면 aal2가 되어 열린다', async () => {
    const s = setup({ totp: true, requireMfa: true, rows: 2 });
    const r = await s.client.signIn(EMAIL, PASSWORD);
    assert.deepEqual([r.ok, r.needsMfa], [true, true]);
    assert.equal(s.client.state().needsMfa, true);
    assert.deepEqual(await s.client.isAdmin(), { ok: true, admin: false }, 'require_mfa를 켠 관리자는 aal1 토큰으로는 열리지 않는다');
    assert.equal((await s.client.list()).items.length, 0);
    const v = await s.client.verifyTotp(FAKE_TOTP_CODE);
    assert.deepEqual(v, { ok: true, aal: 'aal2' });
    assert.deepEqual([s.client.state().aal, s.client.state().needsMfa], ['aal2', false]);
    assert.deepEqual(await s.client.isAdmin(), { ok: true, admin: true });
    assert.equal((await s.client.list()).items.length, 2);
    assert.equal(JSON.parse(s.storage.getItem(INBOX.STORAGE_KEY)).aal, 'aal2');
    const again = s.make();
    await again.restore();
    assert.equal(again.state().needsMfa, false, '되살린 세션은 코드를 다시 묻지 않는다');
  });

  test('같은 탭에서 aal1 세션을 되살리면 코드를 다시 묻는다', async () => {
    const s = setup({ totp: true });
    await s.client.signIn(EMAIL, PASSWORD);
    const again = s.make();
    assert.equal((await again.restore()).restored, true);
    assert.equal(again.state().needsMfa, true);
  });

  test('틀린 코드·모양이 틀린 코드·인증 앱이 없을 때', async () => {
    const s = setup({ totp: true });
    await s.client.signIn(EMAIL, PASSWORD);
    const wrong = await s.client.verifyTotp('000000');
    assert.deepEqual([wrong.ok, wrong.reason, wrong.message], [false, 'mfaCode', INBOX_MESSAGES.mfaCode]);
    assert.equal(s.client.state().aal, 'aal1');
    const before = s.fake.log.length;
    for (const bad of ['', '12345', '1234567', 'abcdef', null, '12 34']) assert.equal((await s.client.verifyTotp(bad)).reason, 'mfaFormat', String(bad));
    assert.equal(s.fake.log.length, before, '모양이 틀린 코드는 서버에 보내지 않는다');
    assert.equal((await s.client.verifyTotp(' 123 456 ')).ok, true, '띄어 쓴 6자리는 받는다');
    const none = setup();
    await none.client.signIn(EMAIL, PASSWORD);
    assert.equal((await none.client.verifyTotp(FAKE_TOTP_CODE)).reason, 'mfaFactor');
  });

  test('등록: 비밀·QR·주소를 받고, 코드로 확인하면 aal2가 된다. 틀리면 그대로', async () => {
    const s = setup({ rows: 1 });
    await loginOk(s);
    const e = await s.client.mfaEnroll();
    assert.equal(e.ok, true);
    assert.deepEqual([e.secret, e.uri.startsWith('otpauth://totp/'), e.qrSvg.startsWith('<svg')], [FAKE_TOTP_SECRET, true, true]);
    assert.ok(e.uri.includes(encodeURIComponent(INBOX.ISSUER)));
    assert.deepEqual(s.fake.log.at(-1).bodyKeys.sort(), ['factor_type', 'friendly_name', 'issuer']);
    const bad = await s.client.mfaConfirm(e.factorId, '000000');
    assert.equal(bad.reason, 'mfaCode');
    assert.equal(s.fake.users.get(EMAIL).factors[0].status, 'unverified');
    const ok = await s.client.mfaConfirm(e.factorId, FAKE_TOTP_CODE);
    assert.deepEqual(ok, { ok: true, aal: 'aal2' });
    const st = s.client.state();
    assert.deepEqual([st.aal, st.needsMfa, st.factors.map((f) => f.status)], ['aal2', false, ['verified']]);
    assert.equal(s.fake.users.get(EMAIL).factors[0].status, 'verified');
  });

  test('끝내지 않은 등록은 버릴 수 있고, 확인된 인증 앱은 코드 없이는 못 지운다', async () => {
    const s = setup({ rows: 1 });
    await loginOk(s);
    const e = await s.client.mfaEnroll();
    assert.deepEqual(await s.client.mfaDiscard(e.factorId), { ok: true });
    assert.equal(s.fake.users.get(EMAIL).factors.length, 0);
    assert.equal(s.client.state().factors.length, 0);
    const e2 = await s.client.mfaEnroll();
    await s.client.mfaConfirm(e2.factorId, FAKE_TOTP_CODE);
    const t = setup({ totp: true });
    await t.client.signIn(EMAIL, PASSWORD);
    const verifiedId = t.client.state().factors[0].id;
    const r = await t.client.mfaDiscard(verifiedId);
    assert.deepEqual([r.ok, r.reason], [false, 'aal']);
    assert.equal(t.fake.users.get(EMAIL).factors.length, 1);
    for (const bad of ['', null, 'x'.repeat(65)]) assert.equal((await s.client.mfaDiscard(bad)).reason, 'mfaFactor');
  });

  test('서버가 이상한 QR 글자를 주면 그림 없이 비밀 키만 준다(<svg로 시작하는 것만 그림으로)', async () => {
    const s = setup({ wrap: (f) => async (url, init) => (String(url).endsWith('/auth/v1/factors') ? new Response(JSON.stringify({ id: 'f-1', type: 'totp', totp: { qr_code: '<script>alert(1)</script>', secret: 'ABC', uri: 'javascript:alert(1)' } })) : f(url, init)) });
    await loginOk(s);
    const e = await s.client.mfaEnroll();
    assert.deepEqual([e.ok, e.qrSvg, e.uri, e.secret], [true, '', '', 'ABC']);
  });
});

describe('가짜 서버(HTTP)', () => {
  test('브라우저처럼 CORS 사전 요청에 Authorization을 허용하고 Content-Range를 보이게 한다', async (t) => {
    const srv = await startFakeInbox({ key: CONFIG.anonKey });
    t.after(() => srv.close());
    srv.fake.addUser({ email: EMAIL, password: PASSWORD, admin: true });
    srv.fake.addFeedback({ body: 'HTTP 시험 글입니다' });
    const pre = await fetch(`${srv.url}/rest/v1/fps_feedback`, { method: 'OPTIONS', headers: { 'Access-Control-Request-Headers': 'authorization,apikey,prefer', 'Access-Control-Request-Method': 'GET' } });
    assert.equal(pre.status, 204);
    assert.match(pre.headers.get('access-control-allow-headers'), /authorization/i);
    assert.match(pre.headers.get('access-control-allow-methods'), /PATCH/);
    const client = createInboxClient({ config: { url: srv.url, anonKey: CONFIG.anonKey }, storage: memoryStorage() });
    assert.equal((await client.signIn(EMAIL, PASSWORD)).ok, true);
    const list = await client.list();
    assert.deepEqual([list.ok, list.items.length, list.total], [true, 1, 1]);
    const raw = await fetch(`${srv.url}/rest/v1/fps_feedback?select=id&limit=1`, { headers: { apikey: CONFIG.anonKey, Authorization: `Bearer ${srv.fake.log.at(-1).bearer}`, Prefer: 'count=exact' } });
    assert.match(raw.headers.get('access-control-expose-headers'), /Content-Range/);
    assert.equal(raw.headers.get('content-range'), '0-0/1');
    assert.match(srv.config, /window\.SKALA_CONFIG = \{ supabase: \{ url: "http:\/\/127\.0\.0\.1:\d+", anonKey: "sb_publishable_test" \} \};/);
  });
});

// ─────────────────────────────── 그리기 (가짜 DOM) ───────────────────────────────
class FakeNode {
  constructor(tag) { this.tag = tag; this.children = []; this._text = ''; this.attrs = {}; this.dataset = {}; this.className = ''; this.listeners = {}; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this._text = String(v); this.children = []; }
  append(...kids) { for (const k of kids) { assert.ok(k instanceof FakeNode, '글자가 아닌 노드만 붙인다'); this.children.push(k); } }
  replaceChildren(...kids) { this._text = ''; this.children = []; this.append(...kids); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  click() { for (const fn of this.listeners.click || []) fn(); }
  walk(fn) { fn(this); for (const c of this.children) c.walk(fn); }
  find(pred) { const out = []; this.walk((n) => { if (pred(n)) out.push(n); }); return out; }
  set innerHTML(_) { throw new Error('innerHTML을 쓰면 안 된다'); }
  get innerHTML() { throw new Error('innerHTML을 쓰면 안 된다'); }
  set outerHTML(_) { throw new Error('outerHTML을 쓰면 안 된다'); }
  insertAdjacentHTML() { throw new Error('insertAdjacentHTML을 쓰면 안 된다'); }
}
const doc = { createElement: (tag) => new FakeNode(tag) };
const item = (over = {}) => ({ id: 5, playerId: 7, name: '대원', kind: 'bug', body: '버그가 있어요', info: {}, status: 'new', reply: null, repliedAt: null, createdAt: Date.UTC(2026, 10, 17, 1, 23), ...over });
const tags = (node) => { const set = new Set(); node.walk((n) => set.add(n.tag)); return [...set].sort(); };

describe('inbox-view 그리기', () => {
  const ATTACK = '<img src=x onerror=alert(1)><script>alert(2)</script>"><b>굵게</b>';

  test('플레이어가 쓴 이름·본문은 글자로만 들어간다(태그가 만들어지지 않는다)', () => {
    const li = renderRow(doc, item({ name: ATTACK, body: `${ATTACK}\n둘째 줄`, reply: ATTACK }));
    assert.deepEqual(tags(li), ['button', 'li', 'span']);
    assert.ok(li.textContent.includes(ATTACK), '이름이 그대로 글자로 보인다');
    assert.ok(li.find((n) => n.className === 'ib-row-name')[0].textContent === ATTACK);
    assert.ok(li.find((n) => n.className === 'ib-row-snip')[0].textContent.startsWith('<img src=x onerror=alert(1)>'));
    // 받은 글에 닫는 태그가 있어도 구조(자식 수)는 그대로
    assert.equal(li.children.length, 1);
    assert.equal(li.children[0].children.length, 2);
  });

  test('한 줄: 번호·종류·상태·이름·시각, 새 글 표시, 답함·쓰는 중 표시, 누르면 onSelect', () => {
    const picked = [];
    const li = renderRow(doc, item({ id: 12, status: 'new', reply: '답' }), { selected: true, draft: true, onSelect: (id) => picked.push(id) });
    const btn = li.children[0];
    assert.deepEqual([btn.dataset.id, btn.dataset.status, btn.attrs['aria-current'], btn.attrs.type], ['12', 'new', 'true', 'button']);
    const text = li.textContent;
    for (const part of ['#12', '버그', '접수', '답함', '쓰는 중', '대원', '11-17 10:23', '버그가 있어요']) assert.ok(text.includes(part), part);
    btn.click();
    assert.deepEqual(picked, [12]);
    const plain = renderRow(doc, item({ status: 'done' }));
    assert.ok(!plain.textContent.includes('답함') && !plain.textContent.includes('쓰는 중'));
    assert.equal(plain.children[0].attrs['aria-current'], 'false');
    assert.ok(renderRow(doc, item({ name: '' })).textContent.includes('이름 없음'));
  });

  test('renderList: 줄 수를 돌려주고 선택·쓰는 중 표시를 맞춘다', () => {
    const ul = new FakeNode('ul');
    ul.append(new FakeNode('li'));
    const items = [item({ id: 3 }), item({ id: 2 }), item({ id: 1 })];
    const n = renderList(doc, ul, items, { selectedId: 2, drafts: new Set([3]) });
    assert.equal(n, 3);
    assert.equal(ul.children.length, 3);
    assert.deepEqual(ul.children.map((li) => li.children[0].attrs['aria-current']), ['false', 'true', 'false']);
    assert.ok(ul.children[0].textContent.includes('쓰는 중') && !ul.children[1].textContent.includes('쓰는 중'));
    assert.equal(renderList(doc, ul, [], {}), 0);
    assert.equal(ul.children.length, 0);
  });

  test('renderChips: 전체·접수·확인함·반영·보류와 개수, 누른 칩 표시, 누르면 onPick', () => {
    const box = new FakeNode('div');
    const picked = [];
    const n = renderChips(doc, box, { new: 3, read: 5, done: 20, hold: 1 }, { active: 'done', onPick: (s) => picked.push(s) });
    assert.equal(n, 5);
    assert.deepEqual(box.children.map((b) => b.textContent), ['전체29', '접수3', '확인함5', '반영20', '보류1']);
    assert.deepEqual(box.children.map((b) => b.attrs['aria-pressed']), ['false', 'false', 'false', 'true', 'false']);
    box.children[4].click();
    box.children[0].click();
    assert.deepEqual(picked, ['hold', '']);
    renderChips(doc, box, null, {});
    assert.deepEqual(box.children.map((b) => b.children[1].textContent), ['0', '0', '0', '0', '0']);
  });

  test('renderInfo: 이름·값 쌍을 글자로만, 없으면 0줄', () => {
    const dl = new FakeNode('dl');
    assert.equal(renderInfo(doc, dl, { where: 'menu', br: ATTACK }), 2);
    assert.deepEqual(dl.children.map((c) => c.tag), ['dt', 'dd', 'dt', 'dd']);
    assert.deepEqual(dl.children.map((c) => c.textContent), ['연 곳', '메인 메뉴', '브라우저', ATTACK]);
    assert.equal(renderInfo(doc, dl, {}), 0);
    assert.equal(dl.children.length, 0);
  });

  test('FakeNode는 innerHTML을 막는다(시험 자체 확인)', () => {
    const n = new FakeNode('div');
    assert.throws(() => { n.innerHTML = '<b>x</b>'; });
    assert.throws(() => n.insertAdjacentHTML('beforeend', 'x'));
  });

  test('qrDataUrl: 글자를 퍼센트 부호로 감싼 이미지 주소. 되돌리면 같은 글자', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M1 1h7"/></svg>#"\'';
    const url = qrDataUrl(svg);
    assert.ok(url.startsWith('data:image/svg+xml;charset=utf-8,'));
    assert.ok(!/[<>"#]/.test(url.slice('data:image/svg+xml;charset=utf-8,'.length)));
    assert.equal(decodeURIComponent(url.slice('data:image/svg+xml;charset=utf-8,'.length)), svg);
  });
});

describe('받은편지함 코드에 HTML을 넣는 길이 없다', () => {
  for (const file of ['js/admin/inbox.js', 'js/admin/inbox-view.js', 'js/admin/inbox-panel.js']) {
    test(`${file}: innerHTML·outerHTML·insertAdjacentHTML·document.write·eval·new Function·alert류가 없다`, () => {
      const code = read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      for (const re of [/\.innerHTML\b/, /\.outerHTML\b/, /insertAdjacentHTML/, /document\.write/, /\beval\s*\(/, /new\s+Function\b/, /\b(alert|confirm|prompt)\s*\(/, /\blocalStorage\b/, /\bsetTimeout\s*\(\s*['"`]/]) {
        assert.ok(!re.test(code), `${file}: ${re}`);
      }
    });
  }

  test('토큰·비밀번호를 콘솔에 남기지 않는다', () => {
    for (const file of ['js/admin/inbox.js', 'js/admin/inbox-view.js', 'js/admin/inbox-panel.js']) {
      const code = read(file);
      for (const line of code.split('\n').filter((l) => /console\.(log|info|debug|warn|error)/.test(l))) {
        assert.ok(!/token|password|session|Bearer/i.test(line), `${file}: ${line.trim()}`);
      }
    }
  });
});

// ─────────────────────────────── schema.sql 대조 ───────────────────────────────
describe('supabase/schema.sql 받은편지함', () => {
  const sql = read('supabase/schema.sql');
  const code = sql.split(/\r?\n/).filter((line) => !line.trimStart().startsWith('--')).join('\n');
  const listOf = (text) => text.split(',').map((s) => s.trim()).filter(Boolean);
  const feedbackGrants = [...code.matchAll(/grant\s+([^;]*?)\s+on\s+(?:table\s+)?public\.fps_feedback\s+to\s+([^;]+);/gi)].map((m) => ({ what: m[1], to: m[2].trim() }));
  const fnBody = (name) => {
    const m = code.match(new RegExp(`create or replace function public\\.${name}\\(\\)[\\s\\S]*?\\$\\$;`));
    assert.ok(m, `${name} 정의가 없다`);
    return m[0];
  };

  test('관리자 표: uid는 소유자가 넣고(파일에 uid가 없다), RLS를 켜고 권한을 모두 없앤다', () => {
    const table = code.match(/create table if not exists public\.fps_admins \([\s\S]*?\n\);/);
    assert.ok(table, 'fps_admins 표');
    assert.match(table[0], /user_id uuid primary key references auth\.users \(id\) on delete cascade/);
    assert.match(table[0], /require_mfa boolean not null default false/);
    assert.match(code, /alter table public\.fps_admins enable row level security;/);
    assert.match(code, /revoke all on public\.fps_admins from public, anon, authenticated;/);
    assert.ok(!/(grant|policy)[^;]*fps_admins/i.test(code), '관리자 표에는 권한도 정책도 없다');
    assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(sql), '파일에 사용자 uid를 적지 않는다');
    assert.ok(!/insert into public\.fps_admins/i.test(code), '관리자 등록은 소유자가 SQL Editor에서 한다(SOP)');
  });

  test('fps_is_admin(): SECURITY DEFINER, 내 uid와 require_mfa·aal2만 본다. authenticated만 실행한다', () => {
    const fn = fnBody('fps_is_admin');
    assert.ok(fn.includes('returns boolean'));
    assert.ok(fn.includes('stable security definer set search_path = public, extensions'));
    for (const part of ['from public.fps_admins a', 'a.user_id = auth.uid()', 'not a.require_mfa', "auth.jwt() ->> 'aal'", "'aal2'"]) assert.ok(fn.includes(part), part);
    assert.ok(code.includes('revoke all on function public.fps_is_admin() from public, anon, authenticated;'));
    assert.ok(code.includes('grant execute on function public.fps_is_admin() to authenticated;'));
    assert.ok(!/grant execute on function public\.fps_is_admin\(\)[^;]*\b(anon|public)\b/i.test(code));
    assert.ok(code.indexOf('revoke all on function public.fps_is_admin()') < code.indexOf('grant execute on function public.fps_is_admin()'));
  });

  test('authenticated의 열 단위 권한: 읽기는 JS가 요청하는 열, 수정은 reply·status뿐. 그 밖의 권한은 없다', () => {
    assert.equal(feedbackGrants.length, 2, JSON.stringify(feedbackGrants));
    const sel = feedbackGrants.find((g) => /^select\s*\(/i.test(g.what));
    const upd = feedbackGrants.find((g) => /^update\s*\(/i.test(g.what));
    assert.ok(sel && upd);
    assert.equal(sel.to, 'authenticated');
    assert.equal(upd.to, 'authenticated');
    assert.deepEqual(listOf(sel.what.match(/\(([^)]*)\)/)[1]).sort(), [...INBOX.COLUMNS].sort(), '읽기 열 = INBOX.COLUMNS');
    assert.deepEqual(listOf(upd.what.match(/\(([^)]*)\)/)[1]).sort(), ['reply', 'status']);
    for (const g of feedbackGrants) assert.ok(!/\b(insert|delete|truncate|references|trigger|all)\b/i.test(g.what), g.what);
    // 읽기 열은 표의 모든 열이다(새 열을 더하면 여기서 걸러 내 의도적으로 정하게 한다)
    const table = code.match(/create table if not exists public\.fps_feedback \(([\s\S]*?)\n\);/)[1];
    const cols = table.split('\n').map((l) => l.match(/^\s{2}([a-z_]+)\s/)).filter(Boolean).map((m) => m[1]);
    assert.deepEqual(cols.sort(), [...INBOX.COLUMNS].sort(), '표의 열과 읽기 열이 같다');
  });

  test('anon·PUBLIC에는 건의함 표·관리자 표·새 함수에 대한 권한을 새로 주지 않는다', () => {
    for (const g of feedbackGrants) assert.ok(!/\b(anon|public)\b/i.test(g.to), g.to);
    assert.ok(!/grant[^;]*\bfps_admins\b/i.test(code));
    assert.ok(!/grant[^;]*\bfps_feedback\b[^;]*\bto\b[^;]*\banon\b/i.test(code));
    assert.match(code, /revoke all on public\.fps_feedback from public, anon, authenticated;/);
    assert.match(code, /revoke all on sequence public\.fps_feedback_id_seq from public, anon, authenticated;/);
    // 회수 문장이 열 권한을 주는 문장보다 앞에 있어야, 다시 실행해도 결과가 같다
    assert.ok(code.indexOf('revoke all on public.fps_feedback from public, anon, authenticated;') < code.indexOf('grant select (id, player_id'));
    // 건의 보내기·내 건의 보기는 지금처럼 anon도 부르는 RPC 둘뿐이다
    const anonFns = [...code.matchAll(/grant execute on function public\.(\w+)\([^)]*\) to [^;]*\banon\b[^;]*;/g)].map((m) => m[1]);
    assert.ok(anonFns.includes('fps_send_feedback') && anonFns.includes('fps_my_feedback'));
    assert.ok(!anonFns.includes('fps_is_admin'));
  });

  test('정책은 둘뿐이고(건의함의 읽기·수정), 이름을 정해 지웠다 다시 만든다. 모두 fps_is_admin()이 참인 사람만', () => {
    const policies = [...code.matchAll(/create policy (\w+) on ([\w.]+)\s+for (\w+) to (\w+) (using [\s\S]*?);/g)];
    assert.deepEqual(policies.map((p) => [p[1], p[2], p[3], p[4]]), [
      ['fps_feedback_owner_select', 'public.fps_feedback', 'select', 'authenticated'],
      ['fps_feedback_owner_update', 'public.fps_feedback', 'update', 'authenticated']
    ]);
    assert.equal((code.match(/create policy/gi) || []).length, 2, '다른 표에는 정책을 만들지 않는다');
    for (const p of policies) {
      assert.ok(code.includes(`drop policy if exists ${p[1]} on public.fps_feedback;`), `${p[1]}을 지우고 다시 만든다`);
      assert.ok(code.indexOf(`drop policy if exists ${p[1]}`) < code.indexOf(`create policy ${p[1]}`));
      assert.ok(p[5].includes('(select public.fps_is_admin())'), p[1]);
    }
    assert.ok(policies[1][5].includes('with check ((select public.fps_is_admin()))'), '수정 뒤에도 관리자 조건을 확인한다');
    // drop은 이 정책 둘뿐(데이터를 지우는 문장은 없다)
    const drops = [...code.matchAll(/\bdrop\s+([a-z]+)/gi)].map((m) => m[1].toLowerCase());
    assert.deepEqual(drops, ['policy', 'policy']);
  });

  test('답 시각·상태 트리거는 그대로이고 authenticated가 고칠 때도 같은 규칙이다', () => {
    assert.match(code, /create or replace trigger fps_feedback_stamp before update on public\.fps_feedback\s+for each row execute function public\.fps_feedback_stamp\(\);/);
    const stamp = fnBody('fps_feedback_stamp');
    assert.ok(!stamp.includes('security definer'), '호출한 사람 권한으로 돌지만 NEW 값만 만지므로 별도 권한이 필요 없다(실제 Postgres에서 확인)');
    assert.ok(stamp.includes('new.replied_at := case when new.reply is null then null else now() end;'));
    assert.ok(stamp.includes("new.status = 'new' then new.status := 'read'"));
    // replied_at은 열 권한 밖이다: 화면이 직접 고칠 수 없고 트리거만 찍는다
    assert.ok(!feedbackGrants.some((g) => /replied_at/.test(g.what) && /^update/i.test(g.what)));
  });
});

// ─────────────────────────────── 페이지 · 문서 · 설정 대조 ───────────────────────────────
describe('dev/inbox.html과 패널 코드', () => {
  const page = read('dev/inbox.html');
  const panel = read('js/admin/inbox-panel.js');
  const config = read('js/config.js');
  const csp = (page.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/) || [])[1] || '';
  const part = (name) => (csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${name} `)) || '');
  const supabaseHost = new URL(config.match(/url:\s*'(https:\/\/[a-z0-9-]+\.supabase\.co)'/)[1]).host;

  test('CSP: 이 사이트의 스크립트만, 접속은 설정의 Supabase 프로젝트만', () => {
    assert.ok(csp);
    assert.equal(part('default-src'), "default-src 'self'");
    assert.equal(part('script-src'), "script-src 'self'", 'CDN도 인라인 스크립트도 허용하지 않는다');
    assert.equal(part('connect-src'), `connect-src 'self' https://${supabaseHost}`, 'wss(Realtime)도 필요 없다');
    assert.equal(part('object-src'), "object-src 'none'");
    assert.equal(part('base-uri'), "base-uri 'self'");
    assert.equal(part('form-action'), "form-action 'self'");
    assert.equal(part('img-src'), "img-src 'self' data:", 'QR은 data: 이미지');
    assert.ok(!/'unsafe-eval'/.test(csp));
    assert.ok(!/\*/.test(part('connect-src')) && !/relay|workers\.dev|tosspayments/.test(csp), '다른 서버로는 보내지 않는다');
  });

  test('스크립트는 파일 둘뿐이고 인라인 이벤트가 없다. 검색에 걸리지 않고 주소를 남기지 않는다', () => {
    const scripts = [...page.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1].trim());
    assert.deepEqual(scripts, ['src="../js/config.js"', 'type="module" src="../js/admin/inbox-panel.js"']);
    assert.ok(!/\son[a-z]+\s*=/i.test(page), '인라인 이벤트 속성');
    assert.ok(!/javascript:/i.test(page));
    assert.ok(/<meta name="robots" content="noindex">/.test(page));
    assert.ok(/<meta name="referrer" content="no-referrer">/.test(page));
    assert.ok(!/innerHTML|<form[^>]*action=/i.test(page), '서버로 가는 폼이 없다');
  });

  test('QA 서버가 가짜 서버 주소(127.0.0.1)를 더할 수 있는 모양이다', async () => {
    const { relaxCsp } = await import('../tools/qa/server.mjs');
    const relaxed = relaxCsp(page);
    assert.ok(relaxed.includes(`connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:* http://localhost:* ws://localhost:* https://${supabaseHost}`));
  });

  test('패널 코드가 찾는 요소 번호가 모두 HTML에 있고 한 번씩만 쓰였다', () => {
    const ids = [...panel.match(/const IDS = \[([\s\S]*?)\];/)[1].matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
    assert.ok(ids.length > 40);
    assert.equal(new Set(ids).size, ids.length, 'IDS에 겹친 이름');
    const htmlIds = [...page.matchAll(/\bid="(ib-[a-z-]+)"/g)].map((m) => m[1]);
    assert.equal(new Set(htmlIds).size, htmlIds.length, 'HTML에 겹친 id');
    for (const id of ids) assert.ok(htmlIds.includes(`ib-${id}`), `ib-${id}`);
    for (const id of htmlIds) assert.ok(ids.includes(id.slice(3)) || id === 'ib-login-h' || id === 'ib-denied-h' || id === 'ib-root', `HTML에만 있는 id: ${id}`);
  });

  test('종류·상태 문구는 서버 규칙(js/account/feedback.js)에서 온다', () => {
    assert.ok(panel.includes('FEEDBACK_KINDS') && panel.includes('INBOX.STATUS_ACTIONS'));
    assert.deepEqual(INBOX.STATUS_ACTIONS.filter((s) => !(s in FEEDBACK_STATUS_NAMES)), []);
    assert.deepEqual(Object.keys(FEEDBACK_KIND_NAMES), [...FEEDBACK_KINDS]);
    assert.deepEqual(INBOX.STATUSES, Object.keys(FEEDBACK_STATUS_NAMES));
    assert.ok(!INBOX.STATUS_ACTIONS.includes('new'), 'new는 처음 상태라 단추가 없다');
  });

  test('로그인 칸은 비밀번호 관리자가 알아보게 autocomplete가 있고, 인증 코드 칸은 숫자 키패드', () => {
    assert.match(page, /type="email" id="ib-email"[^>]*autocomplete="username"/);
    assert.match(page, /type="password" id="ib-password"[^>]*autocomplete="current-password"/);
    assert.match(page, /id="ib-totp-code" inputmode="numeric" autocomplete="one-time-code"/);
  });

  test('칸에 name이 없어 스크립트가 못 떠 폼이 그대로 제출돼도 이메일·비밀번호가 주소에 실리지 않는다', () => {
    assert.ok(!/<input\b[^>]*\bname\s*=/i.test(page));
    assert.ok(!/<form\b[^>]*\b(action|method)\s*=/i.test(page), '폼은 스크립트가 가로챈다');
  });

  test('다른 페이지의 iframe 안에서는 열리지 않는다(클릭재킹 방지)', () => {
    assert.ok(panel.includes('window.top !== window.self'));
    assert.ok(panel.indexOf('window.top !== window.self') < panel.indexOf('client.restore()'), '세션을 되살리기 전에 막는다');
  });
});

describe('문서와 설정의 값이 같다', () => {
  const config = read('js/config.js');
  const ref = new URL(config.match(/url:\s*'(https:\/\/[a-z0-9-]+\.supabase\.co)'/)[1]).hostname.split('.')[0];
  const sop = read('docs/FEEDBACK_INBOX_SOP.md');
  const feedback = read('docs/FEEDBACK.md');
  const notice = read('docs/NOTICE.md');
  const section6 = feedback.split(/^## 6\. /m)[1].split(/^## \d+\. /m)[0];

  test('SOP: 프로젝트 주소와 화면 주소가 설정·공지 문서와 같다', () => {
    const dash = [...sop.matchAll(/supabase\.com\/dashboard\/project\/([a-z0-9]+)/g)].map((m) => m[1]);
    assert.ok(dash.length >= 4, '대시보드 링크');
    for (const r of dash) assert.equal(r, ref, '대시보드 링크의 프로젝트 ref가 js/config.js와 같다');
    assert.ok(sop.includes(`https://${ref}.supabase.co`) || sop.includes(ref));
    const site = notice.match(/https:\/\/[a-z0-9-]+\.github\.io\/[a-z0-9-]+\/dev\/notice\.html/)[0].replace('notice.html', 'inbox.html');
    assert.ok(sop.includes(site), `SOP에 ${site}`);
    assert.ok(section6.includes('dev/inbox.html'));
  });

  test('SOP와 6절이 코드의 이름을 그대로 쓴다(표·함수·정책·열·화면 문구)', () => {
    for (const name of ['fps_admins', 'fps_is_admin', 'require_mfa', 'schema.sql', 'fps_feedback_owner_select', 'fps_feedback_owner_update']) {
      assert.ok(sop.includes(name) || name.startsWith('fps_feedback_owner'), `SOP: ${name}`);
      assert.ok(section6.includes(name), `6절: ${name}`);
    }
    assert.ok(section6.includes(`${INBOX.PAGE_SIZE}건씩`));
    assert.ok(section6.includes(`${FEEDBACK_REPLY_MAX}자`));
    for (const label of ['Auto Confirm User', 'Allow new users to sign up', 'Authentication']) assert.ok(sop.includes(label), label);
    for (const status of INBOX.STATUS_ACTIONS) assert.ok(sop.includes(FEEDBACK_STATUS_NAMES[status]), FEEDBACK_STATUS_NAMES[status]);
  });

  test('SOP: 체크리스트 번호와 절 제목이 맞고, 터미널 명령 없이 끝난다', () => {
    const checks = [...sop.matchAll(/^- \[ \] (\d+)\./gm)].map((m) => Number(m[1]));
    const heads = [...sop.matchAll(/^## (\d+)\./gm)].map((m) => Number(m[1]));
    assert.ok(checks.length >= 6);
    assert.deepEqual(checks, heads.filter((n) => n >= 1).slice(0, checks.length), '체크리스트 N번 = 절 N');
    assert.deepEqual(checks, checks.map((_, i) => i + 1), '번호가 1부터 이어진다');
    assert.ok(!/```(powershell|bash|sh|cmd)/i.test(sop), '이 절차는 대시보드와 SQL Editor만 쓴다');
  });

  test('SOP의 SQL이 가리키는 표·열이 실제 schema.sql에 있다', () => {
    const sql = read('supabase/schema.sql');
    const blocks = [...sop.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]);
    assert.ok(blocks.length >= 4, 'SQL 블록');
    const all = blocks.join('\n');
    assert.match(all, /insert into public\.fps_admins \(user_id, note\)\s+select id, '[^']*' from auth\.users where email = '[^']+'/);
    assert.match(all, /update public\.fps_admins set require_mfa = true where user_id = /);
    assert.match(all, /update public\.fps_admins set require_mfa = false/);
    for (const col of [...all.matchAll(/fps_admins \(([^)]*)\)/g)].flatMap((m) => m[1].split(',').map((s) => s.trim()))) assert.ok(new RegExp(`\\b${col}\\b`).test(sql.match(/create table if not exists public\.fps_admins \([\s\S]*?\n\);/)[0]), col);
    assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(all), 'SOP 예시에 실제 uid처럼 보이는 값을 넣지 않는다(자리표시자를 쓴다)');
    assert.ok(!/service_role|eyJ[A-Za-z0-9_-]{20,}|sb_secret_/.test(sop), '비밀 키를 적지 않는다');
  });

  test('문서끼리 연결: README·SECURITY·DESIGN·FEEDBACK이 받은편지함을 가리키고, 상대 링크가 모두 있는 파일이다', () => {
    assert.ok(read('README.md').includes('docs/FEEDBACK_INBOX_SOP.md'));
    assert.ok(read('docs/SECURITY.md').includes('dev/inbox.html') && read('docs/SECURITY.md').includes('fps_is_admin'));
    assert.ok(read('docs/DESIGN.md').includes('fps_admins'));
    assert.ok(feedback.includes('FEEDBACK_INBOX_SOP.md'));
    for (const [file, text] of [['docs/FEEDBACK_INBOX_SOP.md', sop], ['docs/FEEDBACK.md', feedback]]) {
      for (const m of text.matchAll(/\]\((?!https?:|#|mailto:)([^)\s]+?)(?:#[^)]*)?\)/g)) {
        assert.ok(existsSync(resolve(ROOT, dirname(file), m[1])), `${file}의 링크가 없는 파일을 가리킨다: ${m[1]}`);
      }
    }
  });

  test('FEEDBACK.md 6절: 읽기·답·상태를 이 화면에서 하고, 새 가입을 끄지 않아도 정책이 거른다는 이유가 적혀 있다', () => {
    assert.ok(/새 가입/.test(section6) && /관리자 표/.test(section6));
    assert.ok(/aal2/.test(section6), '2단계 인증');
    assert.ok(/anon/.test(section6), '플레이어(anon)에게 권한을 늘리지 않는다');
  });
});
