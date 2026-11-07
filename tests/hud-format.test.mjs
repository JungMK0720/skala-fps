/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: HUD와 스코프의 DOM 없는 계산(속도계, 콜아웃 색조, 배너 입력, 슬롯 정규화, 배율 표시)을 확인한다.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { PLAYER, MOVE } from '../js/core/consts.js';
import { WEAPONS } from '../js/weapons/defs.js';
import { speedGauge, calloutTone, bannerSpec, normSlots } from '../js/ui/hud.js';
import { magLabel, zoomReadout } from '../js/ui/scope.js';

const registry = new Map(Object.entries(WEAPONS));

describe('speedGauge', () => {
  test('5.5 m/s를 넘어야 보인다', () => {
    assert.equal(speedGauge(5.5).on, false);
    assert.equal(speedGauge(5.51).on, true);
    assert.equal(speedGauge(PLAYER.WALK).on, false);
    assert.equal(speedGauge(MOVE.MAX_SPEED).on, true);
  });

  test('막대는 걷기 속도에서 0, 이동 상한에서 1이고 밖으로 나가지 않는다', () => {
    assert.equal(speedGauge(PLAYER.WALK).ratio, 0);
    assert.equal(speedGauge(MOVE.MAX_SPEED).ratio, 1);
    assert.equal(speedGauge(0).ratio, 0);
    assert.equal(speedGauge(MOVE.MAX_SPEED + 6).ratio, 1);
    const mid = (PLAYER.WALK + MOVE.MAX_SPEED) / 2;
    assert.ok(Math.abs(speedGauge(mid).ratio - 0.5) < 1e-9);
  });

  test('색은 시안에서 시작해 상한에서 핑크가 된다', () => {
    assert.equal(speedGauge(PLAYER.WALK).color, 'rgb(53, 224, 255)');
    assert.equal(speedGauge(MOVE.MAX_SPEED).color, 'rgb(255, 77, 141)');
  });

  test('숫자는 소수 첫째 자리, 잘못된 값은 0', () => {
    assert.equal(speedGauge(7.26).text, '7.3');
    assert.equal(speedGauge(14).text, '14.0');
    for (const bad of [null, undefined, '', 'x', NaN, -3]) {
      const g = speedGauge(bad);
      assert.equal(g.on, false);
      assert.equal(g.text, '0.0');
    }
  });
});

describe('calloutTone', () => {
  test('네 가지 tone은 그대로, 나머지는 info', () => {
    for (const t of ['head', 'half', 'kill', 'info']) assert.equal(calloutTone(t), t);
    for (const t of [undefined, null, '', 'warn', 3]) assert.equal(calloutTone(t), 'info');
  });
});

describe('bannerSpec', () => {
  test('비밀 스팟 배너를 그대로 옮기고 기본 시간을 채운다', () => {
    const b = bannerSpec({ icon: '🏆', title: '비밀 스팟 발견', sub: '+100 P' });
    assert.equal(b.icon, '🏆');
    assert.equal(b.title, '비밀 스팟 발견');
    assert.equal(b.sub, '+100 P');
    assert.ok(b.ms > 0);
    assert.equal(bannerSpec({ title: 'a', ms: 1500 }).ms, 1500);
  });

  test('시간이 잘못되면 기본값, 글자가 없으면 null', () => {
    const fallback = bannerSpec({ title: 'a' }).ms;
    for (const ms of [0, -1, 'x', null, Infinity]) assert.equal(bannerSpec({ title: 'a', ms }).ms, fallback);
    for (const bad of [null, undefined, 'text', {}, { icon: '🏆' }, { title: '', sub: '' }]) assert.equal(bannerSpec(bad), null);
    assert.equal(bannerSpec({ sub: '+100 P' }).title, '');
  });
});

describe('normSlots', () => {
  test('카탈로그의 모든 무기가 이름과 아이콘을 찾는다', () => {
    for (const [id, def] of Object.entries(WEAPONS)) {
      const list = [null, null, null, null];
      list[def.slot - 1] = id;
      const s = normSlots(registry, list)[def.slot - 1];
      assert.deepEqual(s, { id, icon: def.icon, name: def.short, full: def.name });
    }
  });

  test('칼전처럼 금지된 칸이 null이면 그 칸만 null', () => {
    const slots = normSlots(registry, [null, null, 'ml_knife', null]);
    assert.deepEqual(slots.map((s) => s && s.id), [null, null, 'ml_knife', null]);
  });

  test('객체 형식, 금지 칸 객체, 비거나 잘못된 입력을 견딘다', () => {
    assert.deepEqual(normSlots(registry, { 1: 'sr_twin', 4: 'gr_frag' }).map((s) => s && s.id), ['sr_twin', null, null, 'gr_frag']);
    assert.deepEqual(normSlots(registry, [{ slot: 1, id: null, name: null }, false, '', undefined]), [null, null, null, null]);
    for (const bad of [null, undefined, 7, 'ar_std']) assert.deepEqual(normSlots(registry, bad), [null, null, null, null]);
  });
});

describe('magLabel', () => {
  test('정수와 소수 배율, 1배 이하는 빈 문자열', () => {
    assert.equal(magLabel(9), '×9');
    assert.equal(magLabel(3), '×3');
    assert.equal(magLabel(1.7), '×1.7');
    for (const m of [1, 0, null, undefined, 'x']) assert.equal(magLabel(m), '');
  });
});

describe('zoomReadout', () => {
  test('예전 호출(숫자, zoom, label)은 라벨만 쓰고 조준 표시를 켜지 않는다', () => {
    assert.deepEqual(zoomReadout(4), { label: '×4', level: 0, levels: 0, aiming: false });
    assert.deepEqual(zoomReadout({ zoom: 4 }), { label: '×4', level: 0, levels: 0, aiming: false });
    assert.deepEqual(zoomReadout({ label: '조준경' }), { label: '조준경', level: 0, levels: 0, aiming: false });
    assert.deepEqual(zoomReadout(null), { label: '', level: 0, levels: 0, aiming: false });
  });

  test('2단 줌은 단계 점과 현재 배율을 보여 준다', () => {
    assert.deepEqual(zoomReadout({ mag: 4, level: 1, levels: 2 }), { label: '×4', level: 1, levels: 2, aiming: true });
    assert.deepEqual(zoomReadout({ mag: 9, level: 2, levels: 2 }), { label: '×9', level: 2, levels: 2, aiming: true });
  });

  test('오버레이 없는 단일 배율도 조준 중이면 표시하고, 단계 점은 없다', () => {
    assert.deepEqual(zoomReadout({ mag: 3, level: 1, levels: 1 }), { label: '×3', level: 0, levels: 0, aiming: true });
    assert.equal(zoomReadout({ mag: 3 }).aiming, true);
  });

  test('줌을 풀었거나 줌 없는 무기면 조준 표시가 꺼진다', () => {
    assert.equal(zoomReadout({ mag: 3, level: 0, levels: 1 }).aiming, false);
    assert.deepEqual(zoomReadout({ mag: 1, level: 0, levels: 0 }), { label: '', level: 0, levels: 0, aiming: false });
  });

  test('단계 값이 범위를 넘으면 자른다', () => {
    assert.equal(zoomReadout({ mag: 9, level: 5, levels: 2 }).level, 2);
    assert.equal(zoomReadout({ mag: 9, level: -1, levels: 2 }).level, 0);
  });
});
