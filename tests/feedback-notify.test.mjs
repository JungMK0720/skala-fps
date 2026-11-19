/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 새 건의 이메일 알림(supabase/functions/notify-feedback) 검증. 비밀 헤더·설정이 없을 때 닫힌 채 멈추는지, 새 건의만 메일로 만드는지,
 *          메일이 텍스트뿐이고 받는 사람이 소유자 한 명인지, Resend 실패가 어떻게 보이는지, 로그에 비밀이 새지 않는지를 가짜 Resend로 확인한다.
 *          건의 종류·진단 칸 이름이 게임·schema.sql과, 비밀 이름·배포 명령이 docs/FEEDBACK.md·docs/FEEDBACK_EMAIL_SOP.md·config.toml과,
 *          SOP의 프로젝트 ref가 js/config.js와 같은지도 대조한다.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { FEEDBACK_KIND_NAMES, FEEDBACK_KINDS } from '../js/account/feedback.js';
import {
  ENV_NAMES, INFO_LABELS, KIND_LABELS, MAIL_FROM, PAYLOAD_MAX, RESEND_URL, SECRET_MIN, SUBJECT_MAX,
  buildEmail, cleanText, dashboardUrl, formatKst, handle, oneLine, safeEqual
} from '../supabase/functions/notify-feedback/core.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const SECRET = 'test-webhook-secret-0123456789abcdef';
const API_KEY = 're_test_key_0123456789abcdef';
const OWNER = 'owner@example.com';
const REF = 'abcdefghijklmnopqrst';
const ENV = Object.freeze({ WEBHOOK_SECRET: SECRET, RESEND_API_KEY: API_KEY, OWNER_EMAIL: OWNER, SUPABASE_URL: `https://${REF}.supabase.co` });

const RECORD = Object.freeze({
  id: 12, player_id: 7, name: '민규', kind: 'bug', body: '총을 쏘면 소리가 안 나요.\n두 번째 줄', status: 'new', reply: null, replied_at: null,
  info: { where: 'pause', ver: '2.0.0', touch: false, scr: '1280x720', br: 'Chrome 130', mode: 'zombie', map: 'subway' },
  created_at: '2026-11-17T05:03:11.123456+00:00'
});
const payload = (over = {}) => ({ type: 'INSERT', table: 'fps_feedback', schema: 'public', record: { ...RECORD }, old_record: null, ...over });

function webhook(body, { secret = SECRET, method = 'POST', raw = null, headers = {} } = {}) {
  const init = { method, headers: { 'content-type': 'application/json', ...(secret === null ? {} : { 'x-webhook-secret': secret }), ...headers } };
  if (method !== 'GET' && method !== 'HEAD') init.body = raw ?? JSON.stringify(body);
  return new Request('https://proj.supabase.co/functions/v1/notify-feedback', init);
}

/** 가짜 Resend. respond(call)가 Response를 돌려주거나 예외를 던진다 */
function fakeResend(respond = () => new Response(JSON.stringify({ id: 'mail-1' }), { status: 200 })) {
  const calls = [];
  return {
    calls,
    fetch: async (url, init) => {
      const call = { url, init, body: JSON.parse(init.body) };
      calls.push(call);
      return respond(call);
    }
  };
}

function run(request, { env = ENV, resend = fakeResend() } = {}) {
  const logs = [];
  return handle(request, env, { fetch: resend.fetch, log: (line) => logs.push(line) })
    .then(async (res) => ({ res, json: await res.json(), logs, calls: resend.calls }));
}

describe('메일 만들기', () => {
  test('제목·본문에 번호, 종류, 보낸 사람, 한국 시간, 본문, 진단 정보가 들어 있다', () => {
    const { subject, text } = buildEmail(RECORD, { supabaseUrl: ENV.SUPABASE_URL });
    assert.equal(subject, '[SKALA 건의 #12] 버그 · 민규 · 총을 쏘면 소리가 안 나요. 두 번째 줄');
    assert.match(text, /^새 건의가 도착했어요\./);
    assert.match(text, /번호: 12\n종류: 버그\n보낸 사람: 민규\n받은 시각: 2026-11-17 14:03:11 \(한국 시간\)/);
    assert.ok(text.includes('총을 쏘면 소리가 안 나요.\n두 번째 줄'), '줄바꿈이 그대로');
    assert.match(text, /진단 정보\n {2}연 곳: 일시정지 메뉴\n {2}버전: 2\.0\.0\n {2}터치 기기: 아니요\n {2}화면 크기: 1280x720\n {2}브라우저: Chrome 130\n {2}모드: zombie\n {2}맵: subway/);
    assert.ok(text.includes("update public.fps_feedback set reply = '답을 여기에 적어요', status = 'done' where id = 12;"));
    assert.ok(text.includes(`https://supabase.com/dashboard/project/${REF}/editor`));
    assert.ok(text.includes(`https://supabase.com/dashboard/project/${REF}/sql/new`));
  });

  test('프로젝트 주소가 없으면 대시보드 링크를 빼고, 시각을 못 읽으면 그 줄을 뺀다', () => {
    const { text } = buildEmail({ ...RECORD, created_at: 'not a date', info: {} });
    assert.ok(!text.includes('supabase.com/dashboard'));
    assert.ok(!text.includes('받은 시각'));
    assert.ok(!text.includes('진단 정보'));
  });

  test('이름·제목의 줄바꿈과 안 보이는 글자를 지워 한 줄로 만들고 제목은 길이를 넘지 않는다', () => {
    const { subject } = buildEmail({ ...RECORD, name: '가\n나​다‮', body: `${'긴'.repeat(300)}` });
    assert.ok(!/[\n\r​‮]/.test(subject));
    assert.ok(subject.includes('가 나다'));
    assert.ok(Array.from(subject).length <= SUBJECT_MAX + 1, '자른 표시(…) 한 글자까지');
  });

  test('모르는 종류는 기타, 이름이 비면 (이름 없음)', () => {
    const { subject, text } = buildEmail({ ...RECORD, kind: 'weird', name: '  ' });
    assert.match(subject, /기타 · \(이름 없음\)/);
    assert.match(text, /종류: 기타\n보낸 사람: \(이름 없음\)/);
  });

  const infoLinesOf = (text) => text.split('\n').filter((l) => /^ {2}\S/.test(l) && !l.includes('update public'));

  test('모르는 진단 칸은 이름순으로 뒤에 붙고, 객체·배열 값과 이름이 겹치는 칸(constructor)도 안전하다', () => {
    const { text } = buildEmail({ ...RECORD, info: { where: 'menu', zeta: 1, alpha: true, nested: { a: 1 }, list: [1], constructor: 'x', note: '한 줄\n두 줄' } });
    assert.deepEqual(infoLinesOf(text), ['  연 곳: 메인 메뉴', '  alpha: 예', '  constructor: x', '  note: 한 줄 두 줄', '  zeta: 1']);
  });

  test('진단 정보는 12줄까지만 싣는다', () => {
    const info = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${String(i).padStart(2, '0')}`, i]));
    const lines = infoLinesOf(buildEmail({ ...RECORD, info: { ...info, where: 'menu' } }).text);
    assert.equal(lines.length, 12);
    assert.equal(lines[0], '  연 곳: 메인 메뉴');
    assert.equal(lines.at(-1), '  k10: 10');
  });

  test('HTML 모양의 글도 텍스트 그대로이고, 1000자를 넘는 본문은 잘린다', () => {
    const { text } = buildEmail({ ...RECORD, body: `<script>alert(1)</script>${'가'.repeat(1200)}` });
    assert.ok(text.includes('<script>alert(1)</script>'));
    assert.ok(text.includes(`${'가'.repeat(900)}…`));
    assert.ok(!text.includes('가'.repeat(1000) + '가'));
  });

  test('cleanText·oneLine·formatKst·dashboardUrl', () => {
    assert.equal(cleanText('  a\r\nb\u0007c​d  '), 'a\nbcd');
    assert.equal(oneLine('a \n\t b\u0000', 10), 'a b');
    assert.equal(oneLine('가나다라마', 3), '가나다…');
    assert.equal(formatKst('2026-11-17T05:03:11.123456+00:00'), '2026-11-17 14:03:11');
    assert.equal(formatKst('2026-12-31T16:00:00Z'), '2027-01-01 01:00:00');
    assert.equal(formatKst(null), '');
    assert.equal(formatKst('x'), '');
    assert.equal(dashboardUrl(`https://${REF}.supabase.co`), `https://supabase.com/dashboard/project/${REF}`);
    for (const bad of ['', 'nope', 'https://evil.example/', `https://${REF}.supabase.co.evil.example`, 'https://a.supabase.co']) assert.equal(dashboardUrl(bad), '', bad);
  });

  test('safeEqual: 같으면 true, 한 글자·길이·빈 값이 다르면 false', async () => {
    assert.equal(await safeEqual(SECRET, SECRET), true);
    assert.equal(await safeEqual(SECRET, `${SECRET}x`), false);
    assert.equal(await safeEqual(SECRET, SECRET.replace('t', 'T')), false);
    assert.equal(await safeEqual('', SECRET), false);
    assert.equal(await safeEqual('', ''), true);
  });
});

describe('웹훅 받기: 닫힌 채 멈추는 경우', () => {
  test('POST가 아니면 405이고 Resend를 부르지 않는다', async () => {
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const { res, calls } = await run(webhook(null, { method }));
      assert.equal(res.status, 405, method);
      assert.equal(calls.length, 0);
    }
  });

  test('WEBHOOK_SECRET이 없거나 짧으면 500 not_configured(아무도 통과시키지 않는다)', async () => {
    for (const WEBHOOK_SECRET of [undefined, '', 'short', 'x'.repeat(SECRET_MIN - 1)]) {
      const { res, json, calls } = await run(webhook(payload(), { secret: WEBHOOK_SECRET ?? '' }), { env: { ...ENV, WEBHOOK_SECRET } });
      assert.equal(res.status, 500, String(WEBHOOK_SECRET));
      assert.equal(json.error, 'not_configured');
      assert.equal(calls.length, 0);
    }
  });

  test('비밀 헤더가 없거나 다르면 403이고 Resend를 부르지 않는다', async () => {
    // 머리글 값의 앞뒤 공백은 HTTP가 지우므로 공백만 다른 경우는 시험하지 않는다
    for (const secret of [null, '', 'wrong', `${SECRET}x`, SECRET.slice(0, -1), SECRET.toUpperCase()]) {
      const { res, json, calls, logs } = await run(webhook(payload(), { secret }));
      assert.equal(res.status, 403, String(secret));
      assert.deepEqual(json, { ok: false, error: 'forbidden' });
      assert.equal(calls.length, 0);
      assert.ok(!JSON.stringify(logs).includes(SECRET));
    }
  });

  test('받는 주소·Resend 키가 없거나 모양이 틀리면 500 not_configured', async () => {
    const bad = [
      { OWNER_EMAIL: '' }, { OWNER_EMAIL: 'not-an-email' }, { OWNER_EMAIL: 'a@b' }, { OWNER_EMAIL: 'Name <a@b.co>' },
      { OWNER_EMAIL: 'a@b.co, c@d.co' }, { RESEND_API_KEY: '' }, { RESEND_API_KEY: 're_' }
    ];
    for (const over of bad) {
      const { res, json, calls } = await run(webhook(payload()), { env: { ...ENV, ...over } });
      assert.equal(res.status, 500, JSON.stringify(over));
      assert.equal(json.error, 'not_configured');
      assert.equal(calls.length, 0);
    }
  });

  test('JSON이 아니거나 모양이 틀리면 400, 너무 크면 413', async () => {
    assert.equal((await run(webhook(null, { raw: '{not json' }))).res.status, 400);
    assert.equal((await run(webhook(null, { raw: '[1,2]' }))).res.status, 400);
    assert.equal((await run(webhook(null, { raw: 'null' }))).res.status, 400);
    for (const record of [null, 'x', {}, { id: 0, body: 'abcde' }, { id: '12', body: 'abcde' }, { id: 1.5, body: 'abcde' }, { id: 12 }, { id: 12, body: 7 }]) {
      const { res, json, calls } = await run(webhook(payload({ record })));
      assert.equal(res.status, 400, JSON.stringify(record));
      assert.equal(json.error, 'bad_record');
      assert.equal(calls.length, 0);
    }
    const big = await run(webhook(payload({ record: { ...RECORD, body: 'x'.repeat(PAYLOAD_MAX) } })));
    assert.equal(big.res.status, 413);
    assert.equal(big.calls.length, 0);
  });

  test('새 건의(INSERT)가 아니면 오류 없이 건너뛴다', async () => {
    for (const over of [{ type: 'UPDATE' }, { type: 'DELETE' }, { table: 'fps_players' }, { schema: 'private' }]) {
      const { res, json, calls } = await run(webhook(payload(over)));
      assert.equal(res.status, 200, JSON.stringify(over));
      assert.deepEqual(json, { ok: true, skipped: 'not_a_new_feedback' });
      assert.equal(calls.length, 0);
    }
  });
});

describe('웹훅 받기: 메일 보내기', () => {
  test('새 건의 하나에 Resend를 한 번 부르고 받는 사람은 소유자 한 명이다', async () => {
    const { res, json, calls, logs } = await run(webhook(payload()));
    assert.equal(res.status, 200);
    assert.deepEqual(json, { ok: true, id: 12 });
    assert.equal(calls.length, 1);
    const [{ url, init, body }] = calls;
    assert.equal(url, RESEND_URL);
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.Authorization, `Bearer ${API_KEY}`);
    assert.equal(init.headers['Content-Type'], 'application/json');
    assert.equal(init.headers['Idempotency-Key'], 'skala-feedback-12');
    assert.deepEqual(Object.keys(body).sort(), ['from', 'subject', 'text', 'to'], 'html 칸이 없다: 텍스트 메일뿐');
    assert.equal(body.from, MAIL_FROM);
    assert.deepEqual(body.to, [OWNER]);
    assert.deepEqual(body, { from: MAIL_FROM, to: [OWNER], ...buildEmail(RECORD, { supabaseUrl: ENV.SUPABASE_URL }) });
    assert.deepEqual(logs, [{ t: 'notify', step: 'sent', id: 12 }]);
  });

  test('플레이어가 쓴 글은 받는 주소·보낸 주소·머리글에 들어가지 않는다', async () => {
    const evil = 'x@evil.example\r\nBcc: y@evil.example';
    const { calls } = await run(webhook(payload({ record: { ...RECORD, name: evil, body: `${evil} 입니다 확인`, kind: evil } })));
    const [{ init, body }] = calls;
    assert.deepEqual(body.to, [OWNER]);
    assert.equal(body.from, MAIL_FROM);
    assert.ok(!/[\r\n]/.test(body.subject));
    assert.deepEqual(Object.keys(init.headers).sort(), ['Authorization', 'Content-Type', 'Idempotency-Key', 'User-Agent']);
  });

  test('받는 주소 앞뒤 공백은 지운다', async () => {
    const { calls } = await run(webhook(payload()), { env: { ...ENV, OWNER_EMAIL: `  ${OWNER}\n` } });
    assert.deepEqual(calls[0].body.to, [OWNER]);
  });

  test('Resend가 거절하면 502와 상태 코드를 알리고 로그에 비밀이 없다', async () => {
    const resend = fakeResend(() => new Response(JSON.stringify({ name: 'validation_error', message: `bad key ${API_KEY} for ${OWNER}`, statusCode: 403 }), { status: 403 }));
    const { res, json, logs } = await run(webhook(payload()), { resend });
    assert.equal(res.status, 502);
    assert.deepEqual(json, { ok: false, error: 'resend_rejected', status: 403 });
    assert.equal(logs.length, 1);
    assert.equal(logs[0].step, 'resend_rejected');
    assert.equal(logs[0].status, 403);
    assert.ok(logs[0].detail.includes('validation_error'));
    const all = JSON.stringify(logs) + JSON.stringify(json);
    assert.ok(!all.includes(API_KEY), 'Resend 키가 로그나 응답에 없다');
    assert.ok(!all.includes(SECRET), '웹훅 비밀이 로그나 응답에 없다');
  });

  test('Resend가 JSON이 아닌 오류(429·500)를 돌려줘도 502로 끝난다', async () => {
    for (const status of [429, 500, 503]) {
      const { res, json, logs } = await run(webhook(payload()), { resend: fakeResend(() => new Response('upstream error', { status })) });
      assert.equal(res.status, 502, String(status));
      assert.equal(json.status, status);
      assert.equal(logs[0].detail, '');
    }
  });

  test('Resend에 닿지 못하면 502 resend_unreachable이고 오류 문구의 비밀은 가려진다', async () => {
    const resend = fakeResend(() => { throw new TypeError(`connect failed with ${API_KEY}`); });
    const { res, json, logs } = await run(webhook(payload()), { resend });
    assert.equal(res.status, 502);
    assert.deepEqual(json, { ok: false, error: 'resend_unreachable' });
    assert.equal(logs[0].step, 'resend_unreachable');
    assert.ok(!JSON.stringify(logs).includes(API_KEY));
    assert.ok(logs[0].message.includes('***'));
  });

  test('예상 못 한 예외도 500 internal로 끝나고 비밀을 싣지 않는다', async () => {
    const request = webhook(payload());
    request.text = async () => { throw new Error(`boom ${SECRET}`); };
    const { res, json, logs } = await run(request);
    assert.equal(res.status, 500);
    assert.deepEqual(json, { ok: false, error: 'internal' });
    assert.ok(!JSON.stringify(logs).includes(SECRET));
  });
});

describe('게임·서버·문서와 같은 약속', () => {
  test('건의 종류와 이름이 게임(js/account/feedback.js)과 같다', () => {
    assert.deepEqual(Object.keys(KIND_LABELS), [...FEEDBACK_KINDS]);
    assert.deepEqual({ ...KIND_LABELS }, { ...FEEDBACK_KIND_NAMES });
  });

  test('건의 종류가 schema.sql의 fps_feedback.kind 검사와 같다', () => {
    const match = /kind text not null check \(kind in \(([^)]*)\)\)/.exec(read('supabase/schema.sql'));
    assert.ok(match, 'schema.sql에서 kind 검사를 찾는다');
    assert.deepEqual([...match[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]), Object.keys(KIND_LABELS));
  });

  test('진단 칸 이름이 건의함 화면(js/ui/feedback.js diagInfo)이 보내는 칸과 같다', () => {
    const src = read('js/ui/feedback.js');
    const block = /function diagInfo\(\) \{([\s\S]*?)\n {2}\}/.exec(src);
    assert.ok(block, 'diagInfo를 찾는다');
    const sent = new Set([...block[1].matchAll(/\b(where|ver|touch|scr|br)\b(?=\s*[,:])|out\.(\w+)\s*=/g)].map((m) => m[1] || m[2]));
    assert.deepEqual([...sent].sort(), Object.keys(INFO_LABELS).sort());
  });

  test('index.ts는 Deno.serve에 handle을 잇고 ENV_NAMES의 비밀을 Deno.env에서 읽는다', () => {
    const src = read('supabase/functions/notify-feedback/index.ts');
    assert.match(src, /import \{ ENV_NAMES, handle \} from '\.\/core\.js';/);
    assert.match(src, /Deno\.serve\(/);
    assert.match(src, /Deno\.env\.get\(name\)/);
    assert.match(src, /handle\(request, env, \{ fetch \}\)/);
    assert.deepEqual([...ENV_NAMES], ['WEBHOOK_SECRET', 'RESEND_API_KEY', 'OWNER_EMAIL', 'SUPABASE_URL']);
  });

  test('config.toml이 notify-feedback의 JWT 확인을 끈다(웹훅은 JWT가 없다)', () => {
    const toml = read('supabase/config.toml');
    assert.match(toml, /^project_id = "[a-z0-9_-]+"$/m);
    assert.match(toml, /^\[functions\.notify-feedback\]\r?\nverify_jwt = false$/m);
  });

  test('docs/FEEDBACK.md가 비밀 이름·헤더·배포 명령·함수 이름을 설명한다', () => {
    const doc = read('docs/FEEDBACK.md');
    for (const name of ENV_NAMES.filter((n) => n !== 'SUPABASE_URL')) assert.ok(doc.includes(name), `${name} 설명`);
    for (const word of ['notify-feedback', 'x-webhook-secret', '--no-verify-jwt', 'supabase secrets set', 'supabase functions deploy', 'fps_feedback_email', 'resend.dev']) {
      assert.ok(doc.includes(word), `${word} 설명`);
    }
  });

  test('docs/FEEDBACK_EMAIL_SOP.md의 프로젝트 ref가 js/config.js의 Supabase 주소와 같고 이름·명령이 FEEDBACK.md와 같다', () => {
    const config = /https:\/\/([a-z0-9]{20})\.supabase\.co/.exec(read('js/config.js'));
    assert.ok(config, 'js/config.js에서 프로젝트 주소를 찾는다');
    const sop = read('docs/FEEDBACK_EMAIL_SOP.md');
    assert.ok(sop.includes(`$ref = '${config[1]}'`), 'SOP의 $ref 줄이 js/config.js의 ref와 같다');
    const refs = [...sop.matchAll(/(?:dashboard\/project\/|`)([a-z0-9]{20})(?:\/|`)/g)].map((m) => m[1]);
    assert.ok(refs.length >= 2, 'SOP가 ref를 풀어 쓰고 대시보드 주소에도 쓴다');
    for (const found of refs) assert.equal(found, config[1], 'SOP에 적힌 ref가 모두 같다');
    for (const name of ENV_NAMES.filter((n) => n !== 'SUPABASE_URL')) assert.ok(sop.includes(name), `${name} 설명`);
    for (const word of ['notify-feedback', 'x-webhook-secret', '--no-verify-jwt', '--use-api', 'fps_feedback_email', 'resend.dev', 'net._http_response']) {
      assert.ok(sop.includes(word), `${word} 설명`);
    }
    // 두 문서의 배포 명령이 같다(--use-api 포함)
    const deploy = /npx supabase functions deploy notify-feedback --project-ref (?:\$ref|<[^>]+>) --no-verify-jwt --use-api/;
    assert.match(sop, deploy);
    assert.match(read('docs/FEEDBACK.md'), deploy);
    // FEEDBACK.md와 README가 SOP를 가리킨다
    assert.ok(read('docs/FEEDBACK.md').includes('FEEDBACK_EMAIL_SOP.md'));
    assert.ok(read('README.md').includes('docs/FEEDBACK_EMAIL_SOP.md'));
  });

  test('함수·설정 파일에 비밀 값이 들어 있지 않다', () => {
    for (const path of ['supabase/functions/notify-feedback/core.js', 'supabase/functions/notify-feedback/index.ts', 'supabase/config.toml', 'docs/FEEDBACK.md', 'docs/FEEDBACK_EMAIL_SOP.md']) {
      const src = read(path);
      assert.ok(!/\bre_[A-Za-z0-9_]{16,}/.test(src), `${path}: Resend 키 모양`);
      assert.ok(!/sb_secret_[A-Za-z0-9_-]{8,}/.test(src), `${path}: Supabase secret key 모양`);
      assert.ok(!/eyJ[A-Za-z0-9_-]{20,}\./.test(src), `${path}: JWT 모양`);
    }
  });

  test('schema.sql은 웹훅 트리거·비밀 헤더를 담지 않는다(주소·비밀은 환경마다 다르다)', () => {
    const sql = read('supabase/schema.sql');
    assert.ok(!/supabase_functions\.http_request|x-webhook-secret|net\.http_post/i.test(sql));
  });
});

describe('index.ts를 Node가 직접 읽을 수 있으면 실제로 이어 본다', { skip: !(process.features && process.features.typescript) && 'Node가 .ts를 직접 읽지 못한다' }, () => {
  test('Deno.serve에 건 핸들러가 비밀 헤더를 확인한다', async () => {
    const store = { WEBHOOK_SECRET: SECRET, RESEND_API_KEY: API_KEY, OWNER_EMAIL: OWNER, SUPABASE_URL: ENV.SUPABASE_URL };
    let handler = null;
    globalThis.Deno = { env: { get: (name) => store[name] }, serve: (fn) => { handler = fn; return {}; } };
    try {
      await import(new URL('../supabase/functions/notify-feedback/index.ts', import.meta.url).href);
      assert.equal(typeof handler, 'function');
      const wrong = await handler(webhook(payload(), { secret: 'wrong' }));
      assert.equal(wrong.status, 403);
      store.WEBHOOK_SECRET = '';
      const closed = await handler(webhook(payload()));
      assert.equal(closed.status, 500, '비밀을 못 읽으면 닫힌 채 멈춘다');
    } finally {
      delete globalThis.Deno;
    }
  });
});
