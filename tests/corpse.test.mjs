/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 쓰러진 몸 시간표 시험. 쓰러진 뒤 누운 채 잠깐 있고, 땅으로 가라앉아 3초 안에 숨는지, 가라앉는 깊이가 줄지 않고 늘기만 하는지 확인한다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CORPSE, corpseState } from '../js/engine/corpse.js';

test('쓰러진 몸은 누운 채 있다가 가라앉고 3초 안에 숨는다', () => {
  assert.deepEqual(corpseState(0), { sink: 0, shown: true });
  assert.deepEqual(corpseState(1.04), { sink: 0, shown: true }, '쓰러짐 동작이 끝난 뒤에도 바닥에 누워 보인다');
  assert.deepEqual(corpseState(CORPSE.HOLD), { sink: 0, shown: true });
  const mid = corpseState(CORPSE.HOLD + CORPSE.SINK / 2);
  assert.ok(mid.shown && mid.sink > 0 && mid.sink < CORPSE.DEPTH, '가라앉는 중');
  assert.deepEqual(corpseState(CORPSE.HOLD + CORPSE.SINK), { sink: CORPSE.DEPTH, shown: false });
  assert.ok(CORPSE.HOLD + CORPSE.SINK <= 3, '3초 안에 사라진다');
  assert.equal(corpseState(60).shown, false, '부활할 때까지 숨겨 둔다');
});

test('가라앉는 깊이는 줄지 않고, 이상한 시간은 막 쓰러진 것으로 본다', () => {
  let last = -1;
  for (let t = 0; t <= CORPSE.HOLD + CORPSE.SINK + 0.5; t += 0.05) {
    const s = corpseState(t).sink;
    assert.ok(s >= last, `t=${t.toFixed(2)}`);
    last = s;
  }
  for (const t of [NaN, undefined, null, -3, Infinity]) assert.deepEqual(corpseState(t), { sink: 0, shown: true }, String(t));
});

test('out을 주면 그 객체를 채워 돌려준다(매 프레임 새로 만들지 않는다)', () => {
  const out = { sink: 9, shown: false };
  assert.equal(corpseState(0.5, out), out);
  assert.deepEqual(out, { sink: 0, shown: true });
  assert.equal(corpseState(10, out), out);
  assert.deepEqual(out, { sink: CORPSE.DEPTH, shown: false });
});
