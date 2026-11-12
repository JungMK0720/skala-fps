/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 건의함 검증. js/account/feedback.js의 정리·길이·진단 정보·오류 문구, 계정의 sendFeedback·myFeedback 흐름(가짜 서버),
 *          supabase/schema.sql의 fps_feedback·fps_send_feedback·fps_my_feedback이 JS 규칙과 같은지, 권한이 닫혀 있는지 대조한다.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { createAccount } from '../js/account/index.js';
import {
  FEEDBACK_ERROR_CODES, FEEDBACK_INFO_KEYS, FEEDBACK_KINDS, FEEDBACK_KIND_NAMES, FEEDBACK_LIST_MAX, FEEDBACK_MAX, FEEDBACK_MESSAGES,
  FEEDBACK_MIN, FEEDBACK_REPLY_MAX, FEEDBACK_STATUS_NAMES, cleanFeedback, feedbackInfo, feedbackLength, feedbackResult,
  latestReplyAt, normalizeFeedbackItems, validateFeedback
} from '../js/account/feedback.js';
import { FEEDBACK_LOCAL_KEY, readFeedbackLocal, shortBrowser, writeFeedbackLocal } from '../js/ui/feedback.js';

const CONFIG = Object.freeze({ url: 'https://proj.supabase.co', anonKey: 'sb_publishable_test' });
const settle = () => new Promise((resolve) => setImmediate(resolve));

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); }
  };
}

/** 건의함만 흉내 낸 서버. 닉네임은 등록된 것으로 친다(registered=false면 NOT_FOUND) */
function fakeServer({ feedback = true, features = 'feedback' } = {}) {
  const items = [];
  const server = {
    items,
    calls: [],
    down: false,
    registered: true,
    /** 다음 보내기에 돌려줄 서버 오류 코드 */
    nextError: null,
    count: (fn) => server.calls.filter((c) => c.fn === fn).length,
    last: (fn) => server.calls.filter((c) => c.fn === fn).at(-1),
    fetch: async (url, init) => {
      const fn = url.split('/rpc/')[1];
      const args = JSON.parse(init.body);
      server.calls.push({ fn, args });
      if (server.down) throw new TypeError('Failed to fetch');
      const json = (body) => ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)) });
      const missing = { ok: false, status: 404, json: async () => ({ code: 'PGRST202' }) };
      switch (fn) {
        case 'fps_features':
          if (features === 'missing') return missing;
          return json({ ok: true, avatars: true, ...(features === 'feedback' ? { feedback: true } : {}) });
        case 'fps_send_feedback': {
          if (!feedback) return missing;
          if (server.nextError) { const error = server.nextError; server.nextError = null; return json({ ok: false, error }); }
          if (!server.registered) return json({ ok: false, error: 'NOT_FOUND' });
          items.unshift({ id: items.length + 1, kind: args.p_kind, body: args.p_body, status: 'new', reply: null, at: 1000 + items.length, repliedAt: null });
          return json({ ok: true, id: items.length });
        }
        case 'fps_my_feedback':
          if (!feedback) return missing;
          if (!server.registered) return json({ ok: false, error: 'NOT_FOUND' });
          return json({ ok: true, items: items.slice(0, 10) });
        default:
          // 계정 동기화 RPC는 이 시험과 상관없다(없는 프로필로 답한다)
          return json({ ok: false, error: 'NOT_FOUND' });
      }
    }
  };
  return server;
}

function makeAccount(t, server, { config } = {}) {
  const account = createAccount({
    bus: null,
    storage: fakeStorage(),
    target: null,
    config: config !== undefined ? config : server ? CONFIG : { url: '', anonKey: '' },
    fetch: server ? server.fetch : undefined
  });
  t.after(() => account.dispose());
  return account;
}

// ─────────────────────────────── 규칙 ───────────────────────────────
describe('cleanFeedback', () => {
  const cases = [
    ['  안녕하세요  ', '안녕하세요'],
    ['첫 줄\r\n둘째 줄', '첫 줄\n둘째 줄'],
    ['줄 끝 공백   \n다음', '줄 끝 공백\n다음'],
    ['탭\t\t\n다음', '탭\n다음'],
    ['가\n\n\n\n\n나', '가\n\n나'],
    ['폭​없는‍공백', '폭없는공백'],
    ['방향‮바꾸기⁦끝⁩', '방향바꾸기끝'],
    ['제어\u0000\u0007\u001b문자\u007f', '제어문자'],
    ['﻿머리 BOM', '머리 BOM'],
    ['외로운\r캐리지', '외로운캐리지'],
    ['안의 탭\t은 둔다', '안의 탭\t은 둔다'],
    ['\n\n  앞뒤 줄바꿈  \n\n', '앞뒤 줄바꿈'],
    [null, ''],
    [undefined, ''],
    [12345, '12345']
  ];
  for (const [input, want] of cases) {
    test(JSON.stringify(input), () => assert.equal(cleanFeedback(input), want));
  }
});

describe('validateFeedback', () => {
  test('종류는 넷 중 하나', () => {
    for (const kind of FEEDBACK_KINDS) assert.equal(validateFeedback({ kind, body: '충분히 긴 글' }).ok, true, kind);
    for (const kind of [undefined, '', 'BUG', 'spam', 1]) {
      const r = validateFeedback({ kind, body: '충분히 긴 글' });
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'kind');
    }
    assert.deepEqual(Object.keys(FEEDBACK_KIND_NAMES), [...FEEDBACK_KINDS]);
  });

  test(`${FEEDBACK_MIN}자 미만은 짧다. 공백·안 보이는 글자는 세지 않는다`, () => {
    assert.equal(validateFeedback({ kind: 'bug', body: '1234' }).reason, 'short');
    assert.equal(validateFeedback({ kind: 'bug', body: '  12​34  ' }).reason, 'short');
    const ok = validateFeedback({ kind: 'bug', body: '  12345  ' });
    assert.deepEqual(ok, { ok: true, kind: 'bug', body: '12345' });
  });

  test(`${FEEDBACK_MAX}자까지. 이모지 하나는 한 글자(Postgres char_length와 같다)`, () => {
    assert.equal(validateFeedback({ kind: 'idea', body: '가'.repeat(FEEDBACK_MAX) }).ok, true);
    assert.equal(validateFeedback({ kind: 'idea', body: '가'.repeat(FEEDBACK_MAX + 1) }).reason, 'long');
    const emoji = '😀'.repeat(FEEDBACK_MAX);
    assert.equal(emoji.length, FEEDBACK_MAX * 2);
    assert.equal(feedbackLength(emoji), FEEDBACK_MAX);
    assert.equal(validateFeedback({ kind: 'idea', body: emoji }).ok, true);
  });
});

describe('feedbackInfo', () => {
  test('짧은 문자열·숫자·참거짓만, 키 순서로 최대 개수까지', () => {
    const raw = { where: 'menu', ver: '2.0.0', touch: false, w: 1920, bad: { x: 1 }, list: [1], nan: NaN, inf: Infinity, nul: null, long: 'x'.repeat(81) };
    assert.deepEqual(feedbackInfo(raw), { touch: false, ver: '2.0.0', w: 1920, where: 'menu' });
    const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${String(i).padStart(2, '0')}`, i]));
    const out = feedbackInfo(many);
    assert.equal(Object.keys(out).length, FEEDBACK_INFO_KEYS);
    assert.deepEqual(Object.keys(out), Object.keys(many).slice(0, FEEDBACK_INFO_KEYS));
    assert.deepEqual(feedbackInfo({ ['k'.repeat(25)]: 1, ok: 'a‮b' }), { ok: 'ab' });
    for (const bad of [null, undefined, 'x', 3, [1, 2]]) assert.deepEqual(feedbackInfo(bad), {});
  });
});

describe('feedbackResult', () => {
  test('성공, 404(함수 없음), 서버 오류 코드, 네트워크', () => {
    assert.deepEqual(feedbackResult({ ok: true, id: 7 }), { ok: true, id: 7, message: FEEDBACK_MESSAGES.sent });
    assert.equal(feedbackResult({ ok: false, reason: 'network', status: 404 }).reason, 'closed');
    const want = { FEEDBACK_INVALID: 'invalid', FEEDBACK_DUPLICATE: 'duplicate', FEEDBACK_BLOCKED: 'blocked', RATE_LIMITED: 'rate', NOT_FOUND: 'nickname', TOKEN_INVALID: 'nickname' };
    assert.deepEqual([...FEEDBACK_ERROR_CODES].sort(), Object.keys(want).sort());
    for (const [error, reason] of Object.entries(want)) {
      const r = feedbackResult({ ok: false, error });
      assert.equal(r.reason, reason, error);
      assert.equal(r.message, FEEDBACK_MESSAGES[reason], error);
      assert.ok(r.message, error);
    }
    for (const r of [null, undefined, { ok: false, reason: 'network' }, { ok: false, error: 'WHAT' }, { ok: 'yes' }]) {
      assert.equal(feedbackResult(r).reason, 'network');
    }
  });
});

describe('normalizeFeedbackItems', () => {
  test('모양을 고치고 모르는 값은 기본값으로, 최대 개수까지', () => {
    const items = normalizeFeedbackItems([
      { id: 3, kind: 'bug', body: '버그 제보', status: 'done', reply: '고쳤어요', at: 100, repliedAt: 200 },
      { id: '2', kind: 'nope', body: '종류 모름', status: 'weird', reply: '  ', at: 'x', repliedAt: 300 },
      { id: 1, kind: 'idea', body: 5 },
      null, 'x',
      { id: 9, kind: 'balance', body: 'b'.repeat(FEEDBACK_MAX + 50), reply: 'r'.repeat(FEEDBACK_REPLY_MAX + 9), at: 5, repliedAt: null }
    ]);
    assert.equal(items.length, 3);
    assert.deepEqual(items[0], { id: 3, kind: 'bug', body: '버그 제보', status: 'done', reply: '고쳤어요', at: 100, repliedAt: 200 });
    assert.deepEqual(items[1], { id: 2, kind: 'other', body: '종류 모름', status: 'new', reply: null, at: null, repliedAt: null });
    assert.equal(items[2].body.length, FEEDBACK_MAX);
    assert.equal(items[2].reply.length, FEEDBACK_REPLY_MAX);
    assert.equal(items[2].repliedAt, null);
    const many = Array.from({ length: 20 }, (_, i) => ({ id: i, kind: 'bug', body: `글 ${i}` }));
    assert.equal(normalizeFeedbackItems(many).length, FEEDBACK_LIST_MAX);
    for (const bad of [null, undefined, 'x', { items: [] }]) assert.deepEqual(normalizeFeedbackItems(bad), []);
  });

  test('latestReplyAt은 답이 있는 글만 본다', () => {
    assert.equal(latestReplyAt([{ reply: 'a', repliedAt: 5 }, { reply: null, repliedAt: 99 }, { reply: 'b', repliedAt: 7 }]), 7);
    assert.equal(latestReplyAt([]), 0);
    assert.equal(latestReplyAt(null), 0);
  });
});

describe('ui/feedback 도우미', () => {
  test('shortBrowser', () => {
    const edge = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36 Edg/157.0.4341.46';
    const chrome = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36';
    const safari = 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1';
    const firefox = 'Mozilla/5.0 (Windows NT 10.0; rv:150.0) Gecko/20100101 Firefox/150.0';
    const samsung = 'Mozilla/5.0 (Linux; Android 14; SM-S921N) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/29.0 Chrome/136.0.0.0 Mobile Safari/537.36';
    assert.equal(shortBrowser(edge), 'Edge 157');
    assert.equal(shortBrowser(chrome), 'Chrome 156');
    assert.equal(shortBrowser(safari), 'Safari 19');
    assert.equal(shortBrowser(firefox), 'Firefox 150');
    assert.equal(shortBrowser(samsung), 'Samsung 29');
    assert.equal(shortBrowser(''), 'other');
    assert.equal(shortBrowser(undefined), 'other');
  });

  test('이 기기의 기록은 저장소가 막혀도 빈 값', (t) => {
    const saved = globalThis.localStorage;
    t.after(() => { if (saved === undefined) delete globalThis.localStorage; else globalThis.localStorage = saved; });
    globalThis.localStorage = fakeStorage();
    assert.deepEqual(readFeedbackLocal(), { sent: false, seen: 0 });
    writeFeedbackLocal({ sent: true });
    writeFeedbackLocal({ seen: 1234 });
    assert.deepEqual(readFeedbackLocal(), { sent: true, seen: 1234 });
    assert.deepEqual(JSON.parse(globalThis.localStorage.getItem(FEEDBACK_LOCAL_KEY)), { sent: true, seen: 1234 });
    globalThis.localStorage.setItem(FEEDBACK_LOCAL_KEY, '{망가진');
    assert.deepEqual(readFeedbackLocal(), { sent: false, seen: 0 });
    const fail = () => { throw new Error('SecurityError'); };
    globalThis.localStorage = { getItem: fail, setItem: fail, removeItem: fail };
    assert.deepEqual(readFeedbackLocal(), { sent: false, seen: 0 });
    assert.doesNotThrow(() => writeFeedbackLocal({ sent: true }));
  });
});

// ─────────────────────────────── 계정 흐름 ───────────────────────────────
describe('account.sendFeedback · myFeedback', () => {
  test('서버가 없으면 닫혀 있고 보내지 않는다', async (t) => {
    const account = makeAccount(t, null);
    assert.equal(account.feedbackBox, 'closed');
    const r = await account.sendFeedback({ kind: 'bug', body: '버그가 있어요' });
    assert.deepEqual(r, { ok: false, reason: 'offline', message: FEEDBACK_MESSAGES.offline });
    const mine = await account.myFeedback();
    assert.equal(mine.ok, false);
    assert.deepEqual(mine.items, []);
    assert.equal(mine.reason, 'offline');
  });

  test('fps_features가 feedback:true면 열리고, 보낸 글은 정리·진단 정보와 함께 간다', async (t) => {
    const server = fakeServer();
    const account = makeAccount(t, server);
    assert.equal(account.feedbackBox, 'checking');
    await account.ready;
    assert.equal(account.feedbackBox, 'open');
    const r = await account.sendFeedback({ kind: 'balance', body: '  저격총이​ 너무 세요   \n\n\n\n이유는...  ', info: { where: 'menu', bad: { x: 1 }, ver: '2.0.0' } });
    assert.equal(r.ok, true);
    assert.equal(r.id, 1);
    const call = server.last('fps_send_feedback').args;
    assert.equal(call.p_kind, 'balance');
    assert.equal(call.p_body, '저격총이 너무 세요\n\n이유는...');
    assert.deepEqual(call.p_info, { ver: '2.0.0', where: 'menu' });
    assert.match(call.p_token, /^[0-9a-f]{64}$/);
    const mine = await account.myFeedback();
    assert.equal(mine.ok, true);
    assert.equal(mine.items.length, 1);
    assert.equal(mine.items[0].body, '저격총이 너무 세요\n\n이유는...');
    assert.equal(server.last('fps_my_feedback').args.p_token, call.p_token, '같은 기기 토큰');
  });

  test('잘못된 글은 서버에 보내지 않는다', async (t) => {
    const server = fakeServer();
    const account = makeAccount(t, server);
    await account.ready;
    assert.equal((await account.sendFeedback({ kind: 'bug', body: '짧음' })).reason, 'short');
    assert.equal((await account.sendFeedback({ kind: 'nope', body: '충분히 긴 글이에요' })).reason, 'kind');
    assert.equal((await account.sendFeedback({ kind: 'bug', body: 'x'.repeat(FEEDBACK_MAX + 1) })).reason, 'long');
    assert.equal((await account.sendFeedback()).reason, 'kind');
    assert.equal(server.count('fps_send_feedback'), 0);
  });

  test('서버 오류 코드는 화면 문구로 바뀐다', async (t) => {
    const server = fakeServer();
    const account = makeAccount(t, server);
    await account.ready;
    for (const [error, reason] of [['RATE_LIMITED', 'rate'], ['FEEDBACK_DUPLICATE', 'duplicate'], ['FEEDBACK_BLOCKED', 'blocked'], ['FEEDBACK_INVALID', 'invalid']]) {
      server.nextError = error;
      const r = await account.sendFeedback({ kind: 'idea', body: `${error} 시험 글` });
      assert.equal(r.ok, false, error);
      assert.equal(r.reason, reason, error);
      assert.equal(r.message, FEEDBACK_MESSAGES[reason]);
    }
    server.registered = false;
    assert.equal((await account.sendFeedback({ kind: 'idea', body: '등록 전 글이에요' })).reason, 'nickname');
    const mine = await account.myFeedback();
    assert.deepEqual(mine, { ok: true, items: [], offline: false }, '등록 전에는 보낸 글이 없다');
    server.down = true;
    const r = await account.sendFeedback({ kind: 'idea', body: '네트워크 끊김 글' });
    assert.equal(r.reason, 'network');
    assert.equal(account.feedbackBox, 'open', '네트워크 실패로 닫지 않는다');
  });

  test('schema.sql을 다시 실행하기 전의 서버(fps_features 404)는 닫혀 있고, 보내기 직전에 한 번 더 묻는다', async (t) => {
    const server = fakeServer({ feedback: false, features: 'missing' });
    const account = makeAccount(t, server);
    await account.ready;
    assert.equal(account.feedbackBox, 'closed');
    const before = server.count('fps_features');
    const r = await account.sendFeedback({ kind: 'bug', body: '아직 닫힌 건의함' });
    assert.equal(r.reason, 'closed');
    assert.equal(r.message, FEEDBACK_MESSAGES.closed);
    assert.equal(server.count('fps_features'), before + 1, '소유자가 그 사이 SQL을 실행했을 수 있어 다시 묻는다');
    assert.equal(server.count('fps_send_feedback'), 0);
    const mine = await account.myFeedback();
    assert.equal(mine.reason, 'closed');
    assert.equal(server.count('fps_my_feedback'), 0);
  });

  test('기능 확인에 feedback이 없으면 닫히고, 함수가 404면 그때 닫는다', async (t) => {
    const server = fakeServer({ feedback: true, features: 'avatars-only' });
    const account = makeAccount(t, server);
    await account.ready;
    assert.equal(account.feedbackBox, 'closed');
    assert.equal(account.avatarShop, 'open', '캐릭터 구매는 그대로 연다');

    const server2 = fakeServer({ feedback: false, features: 'feedback' });
    const account2 = makeAccount(t, server2);
    await account2.ready;
    assert.equal(account2.feedbackBox, 'open');
    const r = await account2.sendFeedback({ kind: 'bug', body: '함수가 사라진 서버' });
    assert.equal(r.reason, 'closed');
    assert.equal(account2.feedbackBox, 'closed');
  });

  test('기능 확인이 네트워크로 실패하면 확인 중으로 남는다(닫지 않는다)', async (t) => {
    const server = fakeServer();
    server.down = true;
    const account = makeAccount(t, server);
    await account.ready;
    await settle();
    assert.equal(account.feedbackBox, 'checking');
    server.down = false;
    const r = await account.sendFeedback({ kind: 'other', body: '다시 연결된 뒤 글' });
    assert.equal(r.ok, true);
    assert.equal(account.feedbackBox, 'open');
  });
});

// ─────────────────────────────── schema.sql 대조 ───────────────────────────────
describe('supabase/schema.sql 건의함', () => {
  const sql = readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8');
  const code = sql.split(/\r?\n/).filter((line) => !line.trimStart().startsWith('--')).join('\n');
  const table = code.match(/create table if not exists public\.fps_feedback \([\s\S]*?\n\);/);
  const fn = (name) => {
    const m = code.match(new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\$\\$;`));
    assert.ok(m, `${name} 정의가 없다`);
    return m[0];
  };
  const listOf = (src, re) => {
    const m = src.match(re);
    assert.ok(m, String(re));
    return m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
  };

  test('표: 종류·상태·길이가 JS와 같다', () => {
    assert.ok(table, 'fps_feedback 표');
    assert.deepEqual(listOf(table[0], /kind text not null check \(kind in \(([^)]*)\)\)/), [...FEEDBACK_KINDS]);
    assert.deepEqual(listOf(table[0], /status text not null default 'new' check \(status in \(([^)]*)\)\)/), Object.keys(FEEDBACK_STATUS_NAMES));
    assert.ok(table[0].includes(`check (char_length(body) between ${FEEDBACK_MIN} and ${FEEDBACK_MAX})`));
    assert.ok(table[0].includes(`char_length(reply) <= ${FEEDBACK_REPLY_MAX}`));
    const send = fn('fps_send_feedback');
    assert.deepEqual(listOf(send, /p_kind not in \(([^)]*)\)/), [...FEEDBACK_KINDS]);
    assert.ok(send.includes(`char_length(v_body) not between ${FEEDBACK_MIN} and ${FEEDBACK_MAX}`));
    assert.ok(send.includes(`limit ${FEEDBACK_INFO_KEYS}`));
    assert.ok(fn('fps_my_feedback').includes(`limit ${FEEDBACK_LIST_MAX}`));
  });

  test('본문 정리가 cleanFeedback과 같은 순서·글자 목록이다', () => {
    const clean = fn('fps_feedback_clean');
    const cls = clean.match(/'\[(\\u0001[^\]]*)\]'/);
    assert.ok(cls, '지우는 글자 목록');
    const src = readFileSync(new URL('../js/account/feedback.js', import.meta.url), 'utf8');
    const js = src.match(/const INVISIBLE = \/\[(\\u0000[^\]]*)\]\/g;/);
    assert.ok(js, 'feedback.js INVISIBLE');
    assert.equal(cls[1], js[1].replace('\\u0000', '\\u0001'), 'NUL만 빼고 같다(Postgres 글자에는 NUL이 없다)');
    // 함수를 겹쳐 적으면 안쪽 함수의 나머지 인자가 먼저 나오므로, 글 속 순서가 곧 하는 순서다: 줄바꿈 → 글자 → 줄 끝 → 빈 줄 → 앞뒤 자르기
    const order = ["E'\\r\\n', E'\\n'", cls[0], "'[ \\t]+\\n', E'\\n'", "'\\n{3,}', E'\\n\\n'", "E' \\t\\n')"].map((part) => clean.indexOf(part));
    assert.ok(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1])), order.join());
  });

  test('보내기: 등록된 토큰, 차단, 중복, 한도를 서버가 센다', () => {
    const send = fn('fps_send_feedback');
    assert.ok(send.includes('security definer set search_path = public, extensions'));
    for (const part of [
      "'TOKEN_INVALID'", "'NOT_FOUND'", "'FEEDBACK_INVALID'", "'FEEDBACK_DUPLICATE'", "'FEEDBACK_BLOCKED'", "'RATE_LIMITED'",
      'for update', 'v.feedback_blocked', "interval '10 minutes') >= 3", "interval '1 day') >= 15", "interval '1 day') >= 500",
      "fps_rate_ok('feedback', 40, interval '1 hour')", 'octet_length(p_body) > 8000', 'octet_length(p_info::text) <= 2048'
    ]) assert.ok(send.includes(part), part);
    // 서버의 오류 코드는 모두 JS가 안다
    const codes = new Set([...send.matchAll(/'error', '([A-Z_]+)'/g)].map((m) => m[1]));
    for (const c of codes) assert.ok(FEEDBACK_ERROR_CODES.includes(c), c);
    assert.match(code, /alter table public\.fps_players add column if not exists feedback_blocked boolean not null default false;/);
  });

  test('내 건의 보기는 자기 글만, 진단 정보·이름·player_id는 내보내지 않는다', () => {
    const mine = fn('fps_my_feedback');
    assert.ok(mine.includes('security definer set search_path = public, extensions'));
    assert.ok(mine.includes('where player_id = v_id'));
    const out = mine.match(/jsonb_build_object\(\s*'id'[\s\S]*?\) order by/);
    assert.ok(out);
    for (const hidden of ["'info'", "'name'", "'player_id'", 'token_hash']) assert.ok(!out[0].includes(hidden), hidden);
    for (const shown of ["'kind'", "'body'", "'status'", "'reply'", "'at'", "'repliedAt'"]) assert.ok(out[0].includes(shown), shown);
  });

  test('표는 RLS를 켜고 권한을 없앤다. 정책이 없다', () => {
    assert.match(code, /alter table public\.fps_feedback enable row level security;/);
    assert.match(code, /revoke all on public\.fps_feedback from public, anon, authenticated;/);
    assert.match(code, /revoke all on sequence public\.fps_feedback_id_seq from public, anon, authenticated;/);
    assert.ok(!/create policy/i.test(code));
    assert.ok(!/grant [^;]* on (table )?public\.fps_feedback/i.test(code));
  });

  test('RPC 두 개만 밖에서 부를 수 있고 정리·답 시각 함수는 닫혀 있다', () => {
    for (const [name, args] of [['fps_send_feedback', 'text, text, text, jsonb'], ['fps_my_feedback', 'text']]) {
      assert.ok(code.includes(`revoke all on function public.${name}(${args}) from public;`), name);
      assert.ok(code.includes(`grant execute on function public.${name}(${args}) to anon, authenticated;`), name);
    }
    for (const [name, args] of [['fps_feedback_clean', 'text'], ['fps_feedback_stamp', '']]) {
      assert.ok(!fn(name).includes('security definer'), name);
      assert.ok(fn(name).includes('set search_path = public, extensions'), name);
      assert.ok(code.includes(`revoke all on function public.${name}(${args}) from public, anon, authenticated;`), name);
      assert.ok(!code.includes(`grant execute on function public.${name}`), name);
    }
    assert.match(code, /create or replace trigger fps_feedback_stamp before update on public\.fps_feedback/);
    const stamp = fn('fps_feedback_stamp');
    assert.ok(stamp.includes('new.replied_at := case when new.reply is null then null else now() end;'));
  });

  test('fps_features가 건의함을 알리고, 클라이언트가 같은 함수 이름을 부른다', () => {
    assert.ok(fn('fps_features').includes("jsonb_build_object('ok', true, 'avatars', true, 'feedback', true)"));
    const remoteSrc = readFileSync(new URL('../js/account/remote.js', import.meta.url), 'utf8');
    assert.ok(remoteSrc.includes("call('fps_send_feedback'"));
    assert.ok(remoteSrc.includes("call('fps_my_feedback'"));
    for (const p of ['p_token', 'p_kind', 'p_body', 'p_info']) assert.ok(remoteSrc.includes(p), p);
  });
});
