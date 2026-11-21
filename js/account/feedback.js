/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 건의함 규칙. 종류, 본문 정리와 길이, 진단 정보 거르기, 서버 오류 → 화면 문구, 서버가 돌려준 내 건의 목록 정리.
 *          supabase/schema.sql의 fps_feedback_clean·fps_send_feedback과 같은 규칙이어야 한다(tests/feedback.test.mjs가 대조한다).
 *          어떤 함수도 예외를 던지지 않는다. 설계와 이유는 docs/FEEDBACK.md.
 */

import { t } from '../core/i18n.js';

export const FEEDBACK_KINDS = Object.freeze(['bug', 'idea', 'balance', 'other']);
export const FEEDBACK_KIND_NAMES = Object.freeze({ bug: t('menu.fbKindBug'), idea: t('menu.fbKindIdea'), balance: t('menu.fbKindBalance'), other: t('menu.fbKindOther') });
/** 소유자가 Table Editor에서 바꾸는 status 값 → 보낸 사람에게 보이는 말 */
export const FEEDBACK_STATUS_NAMES = Object.freeze({ new: t('menu.fbStNew'), read: t('menu.fbStRead'), done: t('menu.fbStDone'), hold: t('menu.fbStHold') });
export const FEEDBACK_MIN = 5;
export const FEEDBACK_MAX = 1000;
export const FEEDBACK_REPLY_MAX = 500;
export const FEEDBACK_LIST_MAX = 10;
export const FEEDBACK_INFO_KEYS = 12;
export const FEEDBACK_INFO_KEY_MAX = 24;
export const FEEDBACK_INFO_VALUE_MAX = 80;

// 줄바꿈(\n)·탭을 뺀 제어 문자와 안 보이는 글자(폭 없는 공백, 글자 방향 바꾸기). schema.sql은 \u0001부터 적는다(Postgres 글자에는 NUL이 없다)
const INVISIBLE = /[\u0000-\u0008\u000b-\u001f\u007f​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

export const FEEDBACK_MESSAGES = Object.freeze({
  sent: t('menu.fbMsgSent'),
  short: t('menu.fbMsgShort', { n: FEEDBACK_MIN }),
  long: t('menu.fbMsgLong', { n: FEEDBACK_MAX }),
  kind: t('menu.fbMsgKind'),
  invalid: t('menu.fbMsgInvalid'),
  offline: t('menu.fbMsgOffline'),
  closed: t('menu.fbMsgClosed'),
  nickname: t('menu.fbMsgNickname'),
  duplicate: t('menu.fbMsgDuplicate'),
  rate: t('menu.fbMsgRate'),
  blocked: t('menu.fbMsgBlocked'),
  network: t('menu.fbMsgNetwork')
});

/** 서버 오류 코드 → { reason, message } */
const SERVER_ERRORS = new Map([
  ['FEEDBACK_INVALID', 'invalid'],
  ['FEEDBACK_DUPLICATE', 'duplicate'],
  ['FEEDBACK_BLOCKED', 'blocked'],
  ['RATE_LIMITED', 'rate'],
  ['NOT_FOUND', 'nickname'],
  ['TOKEN_INVALID', 'nickname']
]);
export const FEEDBACK_ERROR_CODES = Object.freeze([...SERVER_ERRORS.keys()]);

/** 글자 수(코드 포인트). Postgres char_length와 같게 이모지 하나를 1로 센다 */
export const feedbackLength = (s) => Array.from(String(s ?? '')).length;

/** schema.sql fps_feedback_clean과 같은 순서로 본문을 정리한다 */
export function cleanFeedback(text) {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(INVISIBLE, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^[ \t\n]+|[ \t\n]+$/g, '');
}

/** → { ok:true, kind, body } | { ok:false, reason:'kind'|'short'|'long', message } */
export function validateFeedback({ kind, body } = {}) {
  if (!FEEDBACK_KINDS.includes(kind)) return { ok: false, reason: 'kind', message: FEEDBACK_MESSAGES.kind };
  const clean = cleanFeedback(body);
  const n = feedbackLength(clean);
  if (n < FEEDBACK_MIN) return { ok: false, reason: 'short', message: FEEDBACK_MESSAGES.short };
  if (n > FEEDBACK_MAX) return { ok: false, reason: 'long', message: FEEDBACK_MESSAGES.long };
  return { ok: true, kind, body: clean };
}

/** 진단 정보. 서버와 같이 짧은 문자열·숫자·참거짓 칸만 키 순서로 12개까지 남긴다 */
export function feedbackInfo(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const keys = Object.keys(raw).filter((k) => feedbackLength(k) <= FEEDBACK_INFO_KEY_MAX).sort();
  for (const k of keys) {
    if (Object.keys(out).length >= FEEDBACK_INFO_KEYS) break;
    const v = raw[k];
    if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) out[k] = v;
    else if (typeof v === 'string' && feedbackLength(v) <= FEEDBACK_INFO_VALUE_MAX) out[k] = v.replace(INVISIBLE, '');
  }
  return out;
}

/** 서버 답 → 보내기 결과. remote.call의 { ok:false, reason:'network', status } 모양도 받는다 */
export function feedbackResult(r) {
  if (r && r.ok === true) return { ok: true, id: Number(r.id) || null, message: FEEDBACK_MESSAGES.sent };
  if (r && r.status === 404) return { ok: false, reason: 'closed', message: FEEDBACK_MESSAGES.closed };
  const reason = (r && SERVER_ERRORS.get(r.error)) || 'network';
  return { ok: false, reason, message: FEEDBACK_MESSAGES[reason] };
}

const toTime = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);

/** fps_my_feedback의 items를 화면이 믿고 쓸 모양으로 고친다. 모르는 값은 버리거나 기본값으로 */
export function normalizeFeedbackItems(items) {
  if (!Array.isArray(items)) return [];
  const out = [];
  for (const it of items) {
    if (!it || typeof it !== 'object' || typeof it.body !== 'string') continue;
    const reply = typeof it.reply === 'string' && it.reply.trim() ? Array.from(it.reply).slice(0, FEEDBACK_REPLY_MAX).join('') : null;
    out.push({
      id: Number(it.id) || 0,
      kind: FEEDBACK_KINDS.includes(it.kind) ? it.kind : 'other',
      body: Array.from(it.body).slice(0, FEEDBACK_MAX).join(''),
      status: Object.prototype.hasOwnProperty.call(FEEDBACK_STATUS_NAMES, it.status) ? it.status : 'new',
      reply,
      at: toTime(it.at),
      repliedAt: reply ? toTime(it.repliedAt) : null
    });
    if (out.length >= FEEDBACK_LIST_MAX) break;
  }
  return out;
}

/** 가장 최근 답한 시각(없으면 0). 화면이 '새 답'을 알릴 때 쓴다 */
export function latestReplyAt(items) {
  let t = 0;
  for (const it of items || []) if (it && it.reply && Number(it.repliedAt) > t) t = Number(it.repliedAt);
  return t;
}
