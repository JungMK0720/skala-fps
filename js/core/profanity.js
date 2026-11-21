/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 채팅 욕설 거르기(포털 조건: PEGI-12, 채팅 검열). 영어·한국어 욕설을 같은 길이의 '*'로 가린다. 보낼 때와 받을 때 모두 쓴다.
 *          완벽한 검열이 아니라 흔한 표기와 띄어 쓰기·기호 끼워 넣기, 숫자 바꿔 쓰기(sh1t)를 잡는 정도다. three.js 의존 없음.
 */

/** 영어: 단어 경계로 잡는 것(짧아서 다른 단어 속에 흔히 들어 있는 것) */
const EN_WORD = ['ass', 'arse', 'cock', 'dick', 'fag', 'kys', 'nazi', 'porn', 'cunt', 'rape', 'slut', 'tits', 'twat', 'wank', 'whore', 'cum', 'hoe'];
/** 영어: 다른 단어 속에 있어도 잡는 것 */
const EN_ANY = ['fuck', 'shit', 'bitch', 'pussy', 'asshole', 'bastard', 'nigger', 'nigga', 'faggot', 'retard', 'motherf', 'dickhead', 'bollock', 'wanker', 'penis', 'vagina', 'hitler'];
/** 한국어(초성 줄임 포함). 사이에 띄어쓰기·기호가 있어도 잡는다 */
const KO_ANY = ['씨발', '시발', '씨바', '씨빨', '시바놈', 'ㅅㅂ', 'ㅆㅂ', '병신', 'ㅂㅅ', '븅신', '개새끼', '개새', '새끼', 'ㅅㄲ', '좆', '존나', 'ㅈㄴ', '지랄', 'ㅈㄹ', '미친놈', '미친년', '니애미', '느금마', '느금', '엠창', '섹스', '창녀', '걸레년'];
/** 욕이 아닌 낱말에 들어 있는 경우(시발점·시발역) */
const KO_NOT_AFTER = { '시발': '[점역]' };

const LEET = { a: '[a@4]', e: '[e3]', i: '[i1!|l]', o: '[o0]', s: '[s$5]', t: '[t7+]', u: '[uv]', g: '[g9]' };
const SEP = '[\\s._\\-*~^,·]*';
const esc = (c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const spell = (word) => [...word].map((c) => LEET[c] || esc(c)).join(SEP);

const PATTERN = new RegExp([
  ...EN_WORD.map((w) => `(?<![a-z0-9])${spell(w)}(?:e?s)?(?![a-z0-9])`),
  ...EN_ANY.map(spell),
  ...KO_ANY.map((w) => [...w].map(esc).join(SEP) + (KO_NOT_AFTER[w] ? `(?!${KO_NOT_AFTER[w]})` : ''))
].join('|'), 'giu');

/**
 * 욕설을 같은 길이의 '*'로 가린다(띄어쓰기는 남긴다).
 * @param {string} text
 * @returns {string}
 */
export function maskProfanity(text) {
  const s = String(text == null ? '' : text);
  return s.replace(PATTERN, (m) => m.replace(/\S/g, '*'));
}

/** 욕설이 들어 있는가 */
export function hasProfanity(text) {
  PATTERN.lastIndex = 0;
  const hit = PATTERN.test(String(text == null ? '' : text));
  PATTERN.lastIndex = 0;
  return hit;
}
