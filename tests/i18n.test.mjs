/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 한국어·영어 표가 짝을 이루는지, 코드가 부르는 키가 표에 있는지, 데이터 짝 칸(nameEn 등)이 있는지,
 *          플레이어가 보는 모듈에 표 밖 한글이 남지 않았는지 확인한다(tools/check-i18n.mjs).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { TABLES, hasKey, t, loc, setLang, detectLang, getLang } from '../js/core/i18n.js';
import { checkTables, missingKeys, checkPairedData, scanHangul, findHangul, stripCommentsKeepLines, checkPaired } from '../tools/check-i18n.mjs';

describe('언어 고르기', () => {
  test('저장한 언어가 먼저, 없으면 브라우저 첫 언어가 한국어일 때만 한국어', () => {
    assert.equal(detectLang({ saved: 'en', languages: ['ko-KR'] }), 'en');
    assert.equal(detectLang({ saved: 'ko', languages: ['en-US'] }), 'ko');
    assert.equal(detectLang({ saved: '', languages: ['ko-KR', 'en'] }), 'ko');
    assert.equal(detectLang({ saved: '', languages: ['ko'] }), 'ko');
    assert.equal(detectLang({ saved: '', languages: ['en-GB', 'ko'] }), 'en');
    assert.equal(detectLang({ saved: '', languages: ['ja-JP'] }), 'en');
    assert.equal(detectLang({}), 'en');
  });

  test('t는 자리를 채우고 loc는 짝 칸을 고른다', () => {
    const before = getLang();
    try {
      setLang('en');
      assert.equal(t('portal.rewardDone', { points: 30 }), TABLES.portal['portal.rewardDone'][1].replace('{points}', '30'));
      assert.equal(loc({ name: '가', nameEn: 'A' }, 'name'), 'A');
      assert.equal(loc({ name: '가' }, 'name'), '가');
      setLang('ko');
      assert.equal(loc({ name: '가', nameEn: 'A' }, 'name'), '가');
      assert.equal(t('no.such.key'), 'no.such.key');
    } finally { setLang(before); }
  });
});

describe('표', () => {
  test('모든 키가 한국어·영어 짝이고 {자리} 이름이 같으며 영역 사이에 중복이 없다', () => {
    assert.deepEqual(checkTables(TABLES), []);
    assert.equal(checkTables({ a: { 'a.x': ['가 {n}', 'X'] }, b: { 'a.x': ['가', 'X'], 'b.y': ['나', ''] } }).length, 3);
  });

  test('코드가 부르는 t(키)가 모두 표에 있다', () => {
    assert.deepEqual(missingKeys(hasKey), []);
  });
});

describe('데이터 짝 칸', () => {
  test('짝 칸 데이터 파일의 한글 칸마다 영어 칸이 있다', async () => {
    assert.deepEqual(await checkPairedData(), []);
  });

  test('짝 검사는 빠진 칸과 길이가 다른 배열을 잡는다', () => {
    assert.equal(checkPaired({ a: { name: '가', nameEn: 'A' } }, 'x').length, 0);
    assert.equal(checkPaired({ a: { name: '가' } }, 'x').length, 1);
    assert.equal(checkPaired({ a: { tips: ['가', '나'], tipsEn: ['A'] } }, 'x').length, 1);
  });
});

describe('표 밖 한글', () => {
  test('주석·console·i18n-ok 줄은 세지 않고, 문자열과 정규식은 센다', () => {
    const src = [
      '// 주석', '/* 여러', '줄 주석 */ const a = 1;', "console.warn('경고');",
      "const b = '보임';", "const c = /[가-힣]/; // i18n-ok: 판별", 'const d = x / 2; // 나눗셈 뒤 주석', "const e = `템플릿 ${'안'}`;"
    ].join('\n');
    assert.deepEqual(findHangul(src).map((h) => h.line), [5, 8]);
    assert.equal(stripCommentsKeepLines(src).split('\n').length, 8);
  });

  test('플레이어가 보는 모듈에 표 밖 한글 문자열이 없다', () => {
    const left = scanHangul();
    const lines = Object.entries(left).flatMap(([f, hits]) => hits.map((h) => `${f}:${h.line} ${h.text}`));
    assert.deepEqual(lines, [], `번역하지 않은 줄 ${lines.length}개`);
  });
});
