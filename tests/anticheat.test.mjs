/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 방장 검증(js/game/anticheat.js)을 시험한다. 사격 거리 재계산과 벽 가림, 이동 속도·상승·순간이동, 위반 점수.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { GUARD, checkHitClaim, createMoveGuard, createStrikes, moveLimits } from '../js/game/anticheat.js';
import { createWorld, lineOfSight, makeBox } from '../js/engine/physics.js';
import { MOVE, PLAYER } from '../js/core/consts.js';

const at = (x, z, y = 0, crouch = false) => ({ pos: [x, y, z], crouch });

describe('히트 주장 확인', () => {
  const open = createWorld([]);
  const walled = createWorld([makeBox(-3, 0, -6, 3, 4, -5.5, 'concrete')]);
  const losOf = (w) => (a, b) => lineOfSight(w, a, b);

  test('보이는 상대를 맞으면 인정하고 방장이 잰 거리를 쓴다', () => {
    const r = checkHitClaim({ dist: 10, shooter: [at(0, 0)], victim: [at(0, -10)], los: losOf(open) });
    assert.equal(r.ok, true);
    assert.equal(r.checked, true);
    assert.equal(r.dist, 10);
  });

  test('가까이서 쐈다고 우겨도 (잰 거리 - 여유) 아래로 내려가지 않는다', () => {
    const r = checkHitClaim({ dist: 1, shooter: [at(0, 0)], victim: [at(0, -40)], los: losOf(open) });
    assert.equal(r.ok, true);
    assert.ok(r.dist >= 40 - GUARD.DIST_TOL - 0.5, `거리 ${r.dist}`);
  });

  test('벽 너머의 상대는 어느 시각에서도 보이지 않으면 거절한다', () => {
    const r = checkHitClaim({ dist: 10, shooter: [at(0, 0)], victim: [at(0, -10), at(0.5, -10)], los: losOf(walled) });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no_los');
  });

  test('지연 때문에 한 시각이라도 보였으면 인정한다(모퉁이)', () => {
    const r = checkHitClaim({ dist: 10, shooter: [at(0, 0)], victim: [at(0, -10), at(8, -10)], los: losOf(walled) });
    assert.equal(r.ok, true);
  });

  test('위치를 모르면 검사하지 않고 주장한 거리를 쓴다', () => {
    const r = checkHitClaim({ dist: 12, shooter: [], victim: [at(0, -10)], los: losOf(open) });
    assert.deepEqual(r, { ok: true, dist: 12, checked: false });
  });

  test('칼은 여유가 작다: 10 m 밖에서 벤 주장은 사거리를 넘는 거리로 바뀐다', () => {
    const r = checkHitClaim({ dist: 1, melee: true, shooter: [at(0, 0)], victim: [at(0, -10)], los: losOf(open) });
    assert.ok(r.dist > 8, `거리 ${r.dist}`);
  });

  test('앉은 사람은 눈높이와 겨눌 점이 낮다', () => {
    const low = createWorld([makeBox(-3, 0, -6, 3, 1.3, -5.5, 'concrete')]);   // 앉은 키보다 낮은 벽
    assert.equal(checkHitClaim({ dist: 10, shooter: [at(0, 0, 0, true)], victim: [at(0, -10, 0, true)], los: losOf(low) }).ok, false);
    assert.equal(checkHitClaim({ dist: 10, shooter: [at(0, 0)], victim: [at(0, -10)], los: losOf(low) }).ok, true);
  });
});

describe('이동 확인', () => {
  const map = {
    pads: [{ x: 0, y: 0, z: 0, target: [0, 6, -20], apex: 3 }],
    portals: [{ x: 10, y: 0, z: 0, to: { x: 50, y: 0, z: 50 } }],
    spawns: { owner: [{ x: -40, y: 0, z: -40 }] }
  };

  test('발판이 있으면 그만큼 빠른 속도까지 허용하고, 포털 출구와 스폰은 순간이동 지점이다', () => {
    const plain = moveLimits(null);
    const L = moveLimits(map);
    assert.ok(Math.abs(plain.h - (MOVE.MAX_SPEED * GUARD.SPEED_MUL + GUARD.SPEED_ADD)) < 1e-9);
    assert.ok(L.v > plain.v, '발판 상승 속도');
    assert.equal(L.exits.length, 2);
  });

  test('걷기와 최고 속도는 통과한다', () => {
    const g = createMoveGuard({ getMap: () => null });
    let t = 0, x = 0;
    assert.equal(g.feed('a', { t, pos: [x, 0, 0] }), null);
    for (let i = 0; i < 20; i++) {
      t += 100; x += MOVE.MAX_SPEED * 0.1;
      assert.equal(g.feed('a', { t, pos: [x, 0, 0] }), null);
    }
  });

  test('한 번에 멀리 옮겨지면 순간이동, 조금 빠르면 과속이다', () => {
    const g = createMoveGuard({ getMap: () => null });
    g.feed('a', { t: 0, pos: [0, 0, 0] });
    assert.equal(g.feed('a', { t: 100, pos: [30, 0, 0] }).reason, 'teleport');
    g.feed('b', { t: 0, pos: [0, 0, 0] });
    assert.equal(g.feed('b', { t: 100, pos: [5, 0, 0] }).reason, 'speed');
  });

  test('포털 출구와 스폰 지점으로의 순간이동은 정상이다', () => {
    const g = createMoveGuard({ getMap: () => map });
    g.feed('a', { t: 0, pos: [10, 0, 0] });
    assert.equal(g.feed('a', { t: 100, pos: [50.5, 0, 49.5] }), null);
    g.feed('b', { t: 0, pos: [10, 0, 0] });
    assert.equal(g.feed('b', { t: 100, pos: [-40, 0, -39] }), null);
  });

  test('점프보다 빨리 솟으면 상승 위반이다. 점프·계단은 통과한다', () => {
    const g = createMoveGuard({ getMap: () => null });
    g.feed('a', { t: 0, pos: [0, 0, 0] });
    assert.equal(g.feed('a', { t: 100, pos: [0, PLAYER.JUMP_V * 0.1, 0] }), null, '점프');
    assert.equal(g.feed('a', { t: 200, pos: [0, PLAYER.JUMP_V * 0.1 + PLAYER.STEP, 0] }), null, '계단');
    assert.equal(g.feed('a', { t: 300, pos: [0, 6, 0] }).reason, 'rise');
  });

  test('죽었거나 소식이 오래 끊겼다가 오면 비교하지 않는다. reset 뒤에도 새로 시작한다', () => {
    const g = createMoveGuard({ getMap: () => null });
    g.feed('a', { t: 0, pos: [0, 0, 0], alive: false });
    assert.equal(g.feed('a', { t: 100, pos: [40, 0, 0] }), null, '죽었다가 부활');
    assert.equal(g.feed('a', { t: 100 + GUARD.GAP_MS + 1, pos: [90, 0, 0] }), null, '오래 끊김');
    g.reset('a');
    assert.equal(g.feed('a', { t: 99999, pos: [0, 0, 0] }), null);
  });
});

describe('위반 점수', () => {
  test('지연으로도 생기는 위반은 1점, 정상 클라이언트에서 나오지 않는 위반은 2점이고 시간이 지나면 사라진다', () => {
    let t = 0;
    const s = createStrikes({ now: () => t });
    for (let i = 0; i < GUARD.STRIKE_LIMIT - 1; i++) assert.equal(s.add('a', 'no_los'), false);
    assert.equal(s.add('a', 'no_los'), true);
    t += GUARD.STRIKE_WINDOW_MS + 1;
    assert.equal(s.score('a'), 0);
    assert.equal(s.add('b', 'teleport'), false);
    assert.equal(s.add('b', 'too_fast'), false);
    assert.equal(s.add('b', 'teleport'), true);
  });
});
