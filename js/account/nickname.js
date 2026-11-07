/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 닉네임 정규화와 형식 검사(순수 함수). supabase/schema.sql의 fps_clean_name, fps_name_error와 규칙이 정확히 같아야 한다.
 *          규칙을 바꾸면 두 파일을 함께 고친다. tests/account.test.mjs가 글자 단위로 대조한다.
 */

export const NICKNAME_MIN = 2;
export const NICKNAME_MAX = 12;
/** 정규식 대괄호 안에 들어갈 허용 글자. 눈에 보이지 않는 한글 채움 문자(U+3164)는 이 범위 밖이다. */
export const NICKNAME_CHARSET = '0-9A-Za-zㄱ-ㅎㅏ-ㅣ가-힣 _-';
/**
 * 공백으로 치는 글자. JS의 \s와 같은 목록을 그대로 적어 Postgres의 로캘에 좌우되지 않게 한다.
 * 안 보이는 글자는 \u로 적는다. schema.sql을 SQL Editor에 붙여 넣을 때 줄바꿈 U+2028 같은 글자는 편집기가 지우거나 바꿀 수 있다.
 */
export const NICKNAME_SPACES = String.raw`\f\n\r\t\v \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff`;
export const RESERVED_NICKNAMES = Object.freeze(['admin', '관리자', '운영자', 'system', 'gm', 'null', 'undefined']);
/** 봇 표시와 헷갈리지 않게 막는 꼬리표 */
export const BOT_SUFFIX = ' 봇';

const SPACES_RE = new RegExp('[' + NICKNAME_SPACES + ']+', 'g');
const EDGE_SPACE_RE = /^ | $/g;
const NAME_RE = new RegExp('^[' + NICKNAME_CHARSET + ']+$');

/** 공백을 한 칸으로 줄이고 앞뒤 공백을 없앤다. null·undefined는 빈 문자열. */
export function cleanNickname(name) {
  return String(name == null ? '' : name).replace(SPACES_RE, ' ').replace(EDGE_SPACE_RE, '');
}

/** 중복 비교용 키. 서버의 name_key와 같다. */
export function nicknameKey(name) {
  return cleanNickname(name).toLowerCase();
}

function refuse(name, reason, message) {
  return { ok: false, name, reason, message };
}

/** → { ok, name, reason?: 'format'|'reserved', message }. name은 정규화된 값이다. */
export function validateNickname(raw) {
  const name = cleanNickname(raw);
  const length = Array.from(name).length;
  if (length < NICKNAME_MIN || length > NICKNAME_MAX) {
    return refuse(name, 'format', `닉네임은 ${NICKNAME_MIN}~${NICKNAME_MAX}자로 입력해 주세요.`);
  }
  if (!NAME_RE.test(name)) return refuse(name, 'format', '닉네임에는 한글, 영문, 숫자, _, -, 공백만 쓸 수 있어요.');
  if (RESERVED_NICKNAMES.includes(name.toLowerCase())) return refuse(name, 'reserved', '이 닉네임은 쓸 수 없어요.');
  if (name.endsWith(BOT_SUFFIX)) return refuse(name, 'reserved', `'${BOT_SUFFIX}'으로 끝나는 닉네임은 쓸 수 없어요.`);
  return { ok: true, name, message: '사용할 수 있는 형식이에요.' };
}
