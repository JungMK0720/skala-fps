/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 새 건의 이메일 알림(Supabase Edge Function notify-feedback)의 핵심 규칙. Database Webhook이 fps_feedback INSERT를 보내면
 *          비밀 헤더를 확인하고, 글을 텍스트 메일로 만들어 Resend로 소유자 한 사람에게 보낸다.
 *          Deno(Edge Function)와 Node(tests/feedback-notify.test.mjs)에서 같은 코드가 돈다: Web 표준(Request·Response·crypto)만 쓰고,
 *          바깥으로 나가는 요청은 deps.fetch로만 보낸다. 설정 순서와 이유는 docs/FEEDBACK.md 7절.
 */

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** 건의 종류 → 메일에 적을 이름. js/account/feedback.js의 FEEDBACK_KIND_NAMES·schema.sql의 kind 검사와 같아야 한다(시험이 대조한다) */
export const KIND_LABELS = Object.freeze({ bug: '버그', idea: '제안', balance: '밸런스', other: '기타' });
/** 진단 정보(js/ui/feedback.js diagInfo가 보내는 칸) → 메일에 적을 이름 */
export const INFO_LABELS = Object.freeze({ where: '연 곳', ver: '버전', touch: '터치 기기', scr: '화면 크기', br: '브라우저', mode: '모드', map: '맵' });
export const WHERE_LABELS = Object.freeze({ menu: '메인 메뉴', pause: '일시정지 메뉴' });

/** Edge Function secret 이름. 이 이름이 docs/FEEDBACK.md 7절과 같아야 한다(시험이 대조한다). SUPABASE_URL은 Supabase가 넣어 준다 */
export const ENV_NAMES = Object.freeze(['WEBHOOK_SECRET', 'RESEND_API_KEY', 'OWNER_EMAIL', 'SUPABASE_URL']);

export const WEBHOOK_TABLE = 'fps_feedback';
export const RESEND_URL = 'https://api.resend.com/emails';
/** resend.dev 보내는 주소는 Resend 가입 메일로만 보낼 수 있다(소유자 한 사람에게만 알리는 이 용도에 맞다) */
export const MAIL_FROM = 'SKALA Feedback <onboarding@resend.dev>';
export const SECRET_MIN = 24;
export const PAYLOAD_MAX = 32 * 1024;
export const BODY_MAX = 1000;
export const NAME_MAX = 40;
export const SNIPPET_MAX = 40;
export const SUBJECT_MAX = 100;
export const INFO_MAX = 12;

const OWNER_RE = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;
// 줄바꿈(\n)·탭을 뺀 제어 문자와 안 보이는 글자(폭 없는 공백, 글자 방향 바꾸기). js/account/feedback.js의 INVISIBLE과 같다
const INVISIBLE = /[\u0000-\u0008\u000b-\u001f\u007f​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

/** 코드 포인트 max개까지만 남기고 잘렸으면 …을 붙인다 */
function clip(text, max) {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : text;
}

/** 여러 줄 글: 줄바꿈·탭만 남기고 안 보이는 글자를 지운다 */
export function cleanText(value, max = BODY_MAX) {
  return clip(String(value ?? '').replace(/\r\n/g, '\n').replace(INVISIBLE, '').trim(), max);
}

/** 한 줄 글(제목·이름·진단 값): 모든 공백을 한 칸으로 줄이고 안 보이는 글자를 지운다 */
export function oneLine(value, max) {
  return clip(String(value ?? '').replace(/\s+/g, ' ').replace(INVISIBLE, '').trim(), max);
}

/** ISO 시각 → 한국 시간 'YYYY-MM-DD HH:MM:SS'. 읽지 못하면 ''. 한국은 서머타임이 없어 +9시간이다 */
export function formatKst(iso) {
  if (typeof iso !== 'string') return '';
  const t = new Date(iso);
  if (!Number.isFinite(t.getTime())) return '';
  return new Date(t.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

/** SUPABASE_URL(https://<ref>.supabase.co) → 대시보드 주소. 모양이 다르면 '' */
export function dashboardUrl(supabaseUrl) {
  try {
    const match = /^([a-z0-9]{10,40})\.supabase\.co$/.exec(new URL(String(supabaseUrl)).hostname);
    return match ? `https://supabase.com/dashboard/project/${match[1]}` : '';
  } catch {
    return '';
  }
}

/** 진단 정보 → 메일 줄. 아는 칸을 먼저, 나머지는 이름순으로 모두 합쳐 INFO_MAX개까지 */
function infoLines(info) {
  if (!info || typeof info !== 'object' || Array.isArray(info)) return [];
  const known = Object.keys(INFO_LABELS).filter((k) => hasOwn(info, k));
  const rest = Object.keys(info).filter((k) => !hasOwn(INFO_LABELS, k)).sort();
  const lines = [];
  for (const key of [...known, ...rest]) {
    if (lines.length >= INFO_MAX) break;
    const v = info[key];
    let text;
    if (typeof v === 'boolean') text = v ? '예' : '아니요';
    else if (typeof v === 'number' && Number.isFinite(v)) text = String(v);
    else if (typeof v === 'string') text = key === 'where' && hasOwn(WHERE_LABELS, v) ? WHERE_LABELS[v] : oneLine(v, 80);
    else continue;
    lines.push(`  ${hasOwn(INFO_LABELS, key) ? INFO_LABELS[key] : oneLine(key, 24)}: ${text}`);
  }
  return lines;
}

/**
 * 웹훅이 보낸 새 줄(record) → 메일. 글은 텍스트로만 담고 HTML은 보내지 않는다(글 속 태그가 실행되지 않는다).
 * @returns {{ subject: string, text: string }}
 */
export function buildEmail(record, { supabaseUrl = '' } = {}) {
  const id = Number(record.id);
  const kind = hasOwn(KIND_LABELS, record.kind) ? record.kind : 'other';
  const name = oneLine(record.name, NAME_MAX) || '(이름 없음)';
  const body = cleanText(record.body, BODY_MAX);
  const at = formatKst(record.created_at);
  const dash = dashboardUrl(supabaseUrl);
  const info = infoLines(record.info);
  const subject = oneLine(`[SKALA 건의 #${id}] ${KIND_LABELS[kind]} · ${name} · ${oneLine(body, SNIPPET_MAX)}`, SUBJECT_MAX);
  const lines = [
    '새 건의가 도착했어요.',
    '',
    `번호: ${id}`,
    `종류: ${KIND_LABELS[kind]}`,
    `보낸 사람: ${name}`,
    ...(at ? [`받은 시각: ${at} (한국 시간)`] : []),
    '',
    '---------------- 본문 ----------------',
    body,
    '--------------------------------------',
    ...(info.length ? ['', '진단 정보', ...info] : []),
    '',
    '답하려면 Supabase SQL Editor에서 실행하세요:',
    `  update public.fps_feedback set reply = '답을 여기에 적어요', status = 'done' where id = ${id};`,
    '(작은따옴표는 두 번 겹쳐 적어요. 답은 500자까지이고, 지우려면 reply를 비워요.)',
    ...(dash ? ['', `Table Editor: ${dash}/editor`, `SQL Editor: ${dash}/sql/new`] : []),
    '',
    '- 본문은 플레이어가 쓴 글이에요. 글 속 링크는 누르지 마세요.',
    '- 이 메일에 답장해도 플레이어에게 가지 않아요. 답은 게임 안 건의함으로만 돌아가요.'
  ];
  return { subject, text: lines.join('\n') };
}

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text))));
}

/** 비밀 값 비교. 둘 다 SHA-256으로 같은 길이로 만든 뒤 끝까지 비교해 길이·위치가 시간으로 새지 않게 한다 */
export async function safeEqual(a, b) {
  const [x, y] = await Promise.all([sha256(a), sha256(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

const reply = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
});

/**
 * Edge Function 한 번의 호출. env = { WEBHOOK_SECRET, RESEND_API_KEY, OWNER_EMAIL, SUPABASE_URL }, deps = { fetch, log? }.
 * 상태 코드: 200 보냄·건너뜀, 400 모양이 틀림, 403 비밀 헤더가 다름, 405 POST가 아님, 413 너무 큼,
 *           500 비밀·주소 설정이 없음(닫힌 채 멈춘다), 502 Resend가 거절했거나 닿지 못함.
 */
export async function handle(request, env = {}, deps = {}) {
  const fetchImpl = deps.fetch || globalThis.fetch;
  const log = deps.log || ((line) => console.log(JSON.stringify(line)));
  // 로그와 오류 문구에 비밀 값이 섞여 나가지 않게 가린다
  const scrub = (value) => {
    let out = String(value ?? '');
    for (const secret of [env.RESEND_API_KEY, env.WEBHOOK_SECRET]) if (typeof secret === 'string' && secret) out = out.split(secret).join('***');
    return out;
  };
  try {
    if (request.method !== 'POST') return reply(405, { ok: false, error: 'method_not_allowed' });

    // 비밀이 없거나 짧으면 아무도 통과시키지 않는다(닫힌 채 실패)
    const secret = typeof env.WEBHOOK_SECRET === 'string' ? env.WEBHOOK_SECRET : '';
    if (secret.length < SECRET_MIN) {
      log({ t: 'notify', step: 'not_configured', missing: 'WEBHOOK_SECRET' });
      return reply(500, { ok: false, error: 'not_configured' });
    }
    if (!(await safeEqual(request.headers.get('x-webhook-secret') || '', secret))) {
      log({ t: 'notify', step: 'forbidden' });
      return reply(403, { ok: false, error: 'forbidden' });
    }

    if (Number(request.headers.get('content-length')) > PAYLOAD_MAX) return reply(413, { ok: false, error: 'too_large' });
    const raw = await request.text();
    if (raw.length > PAYLOAD_MAX) return reply(413, { ok: false, error: 'too_large' });
    let payload;
    try { payload = JSON.parse(raw); } catch { return reply(400, { ok: false, error: 'bad_request' }); }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return reply(400, { ok: false, error: 'bad_request' });
    // 새 건의(INSERT)만 알린다. 다른 표·고침·지움이 오면 오류 없이 건너뛴다
    if (payload.type !== 'INSERT' || payload.schema !== 'public' || payload.table !== WEBHOOK_TABLE) {
      return reply(200, { ok: true, skipped: 'not_a_new_feedback' });
    }
    const record = payload.record;
    if (!record || typeof record !== 'object' || !Number.isSafeInteger(record.id) || record.id < 1 || typeof record.body !== 'string') {
      return reply(400, { ok: false, error: 'bad_record' });
    }

    const apiKey = typeof env.RESEND_API_KEY === 'string' ? env.RESEND_API_KEY : '';
    const owner = typeof env.OWNER_EMAIL === 'string' ? env.OWNER_EMAIL.trim() : '';
    if (apiKey.length < 10 || owner.length > 254 || !OWNER_RE.test(owner)) {
      log({ t: 'notify', step: 'not_configured', missing: 'RESEND_API_KEY/OWNER_EMAIL' });
      return reply(500, { ok: false, error: 'not_configured' });
    }

    const mail = buildEmail(record, { supabaseUrl: env.SUPABASE_URL });
    let res;
    try {
      res = await fetchImpl(RESEND_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          // 같은 건의로 웹훅이 다시 와도 24시간 안에는 메일이 한 번만 간다
          'Idempotency-Key': `skala-feedback-${record.id}`,
          'User-Agent': 'skala-feedback-notify/1'
        },
        body: JSON.stringify({ from: MAIL_FROM, to: [owner], subject: mail.subject, text: mail.text })
      });
    } catch (err) {
      log({ t: 'notify', step: 'resend_unreachable', id: record.id, message: scrub((err && err.message) || err).slice(0, 160) });
      return reply(502, { ok: false, error: 'resend_unreachable' });
    }
    if (!res.ok) {
      let detail = '';
      try {
        const body = await res.json();
        detail = scrub([body && body.name, body && body.message].filter((v) => typeof v === 'string').join(': ')).slice(0, 200);
      } catch { /* 본문이 JSON이 아니면 상태 코드만 남긴다 */ }
      log({ t: 'notify', step: 'resend_rejected', id: record.id, status: res.status, detail });
      return reply(502, { ok: false, error: 'resend_rejected', status: res.status });
    }
    log({ t: 'notify', step: 'sent', id: record.id });
    return reply(200, { ok: true, id: record.id });
  } catch (err) {
    log({ t: 'notify', step: 'error', message: scrub((err && err.message) || err).slice(0, 160) });
    return reply(500, { ok: false, error: 'internal' });
  }
}
