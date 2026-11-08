/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 비밀번호 방의 비밀 값(js/net/secret.js)을 시험한다. 같은 입력이면 같고, 방이나 비밀번호가 다르면 다르고, 비밀번호는 담기지 않는다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PASSWORD_MAX, cleanPassword, roomSecret } from '../js/net/secret.js';

test('같은 방·비밀번호면 같은 hex 24자이고, 하나라도 다르면 다르다', async () => {
  const a = await roomSecret('room01', '1234');
  assert.match(a, /^[0-9a-f]{24}$/);
  assert.equal(await roomSecret('room01', '  1234  '), a, '앞뒤 공백은 뺀다');
  assert.notEqual(await roomSecret('room02', '1234'), a, '방이 다르면 다르다');
  assert.notEqual(await roomSecret('room01', '1235'), a, '비밀번호가 다르면 다르다');
  assert.ok(!a.includes('1234'));
});

test('비밀번호가 비면 공개 방이다', async () => {
  assert.equal(await roomSecret('room01', ''), '');
  assert.equal(await roomSecret('room01', '   '), '');
  assert.equal(await roomSecret('room01', null), '');
  assert.equal(cleanPassword('x'.repeat(PASSWORD_MAX + 5)).length, PASSWORD_MAX);
  assert.equal(cleanPassword(7), '');
});
