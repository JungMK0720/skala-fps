/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 머리 위 이름표 규칙 시험. 아군은 이름이 벽 너머로도 보이고, 적(개인전은 모두)은 이름 없이 상태 표시(🛡)만 35 m 안에서 보이는지 확인한다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENEMY_TAG_RANGE, tagShown, tagText } from '../js/engine/nametag.js';

test('적의 이름표에는 닉네임이 없다. 상태 표시가 없으면 이름표도 없다', () => {
  assert.equal(tagText('구름', '', false), '');
  assert.equal(tagText('구름', '🛡', false), '🛡', '개인전 부활 보호는 이름 없이');
  assert.equal(tagText('구름', '', true), '구름');
  assert.equal(tagText('구름', '💣', true), '💣 구름', '폭탄을 든 아군');
  assert.equal(tagText('  ', ' ', true), '');
  assert.equal(tagText(null, undefined, false), '');
});

test('아군은 거리와 상관없이, 적의 상태 표시는 35 m 안에서만 보인다', () => {
  const base = { alive: true, visible: true, local: false };
  assert.equal(tagShown({ ...base, text: '구름', ally: true, dist: 120 }), true);
  assert.equal(tagShown({ ...base, text: '🛡', ally: false, dist: ENEMY_TAG_RANGE - 1 }), true);
  assert.equal(tagShown({ ...base, text: '🛡', ally: false, dist: ENEMY_TAG_RANGE }), false);
  assert.equal(tagShown({ ...base, text: '', ally: false, dist: 3 }), false, '이름 없는 적은 바로 앞에서도 안 보인다');
  assert.equal(tagShown({ ...base, text: '구름', ally: true, alive: false }), false, '쓰러지면 숨긴다');
  assert.equal(tagShown({ ...base, text: '구름', ally: true, local: true }), false, '3인칭 때의 내 몸');
  assert.equal(tagShown({ ...base, text: '구름', ally: true, visible: false }), false);
  assert.equal(tagShown(null), false);
});
