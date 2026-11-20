/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 좀비 모드 버프·디버프 줄. 목록 만들기(horde/client.js hordeStatusList)와 칩 정리·남은 시간 표시 규칙(ui/status.js).
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { hordeStatusList, noAutoRevive } from '../js/game/horde/client.js';
import { HORDE } from '../js/game/horde/rules.js';
import { statusSpec, statusTotal, statusFrac, statusTimeText, statusMeta } from '../js/ui/status.js';

const ME = Object.freeze({ id: 'me', alive: true, hp: 80, maxHp: 100, invuln: false, invulnMs: 0, offer: [], shield: 0, burnMs: 0, noHealMs: 0 });
const ids = (list) => list.map((s) => s.id);
const byId = (list, id) => list.find((s) => s.id === id);

describe('hordeStatusList', () => {
  test('아무 상태도 없으면 빈 목록, 내 행이 없으면 빈 목록', () => {
    assert.deepEqual(hordeStatusList({ me: ME, stage: 1 }), []);
    assert.deepEqual(hordeStatusList({ me: null }), []);
  });

  test('스냅샷 값(무적·보호막·화상·저주)은 받은 뒤 흐른 시간만큼 줄고, 다 지나면 빠진다', () => {
    const me = { ...ME, invuln: true, invulnMs: 2000, shield: 30, burnMs: 5000, noHealMs: 900 };
    const list = hordeStatusList({ me, stage: 5, since: 1000 });
    assert.deepEqual(ids(list), ['invuln', 'shield', 'burn'], '버프 먼저, 그다음 디버프');
    assert.equal(byId(list, 'invuln').leftMs, 1000);
    assert.equal(byId(list, 'invuln').kind, 'buff');
    assert.equal(byId(list, 'shield').value, 30, '보호막은 남은 양을 숫자로');
    assert.equal(byId(list, 'shield').leftMs, undefined, '보호막은 시간이 없다');
    assert.equal(byId(list, 'burn').leftMs, 4000);
    assert.equal(byId(list, 'burn').kind, 'debuff');
    assert.ok(!byId(list, 'noHeal'), '저주는 0.9초라 1초 뒤에는 끝났다');
    for (const s of list) assert.ok(s.name && s.desc && s.icon, `${s.id}: 이름·설명·아이콘`);
  });

  test('증강을 고르는 동안의 무적은 시간 없이', () => {
    const s = byId(hordeStatusList({ me: { ...ME, invuln: true, invulnMs: 1, offer: ['dmg'] }, stage: 3 }), 'invuln');
    assert.ok(s);
    assert.equal(s.leftMs, undefined);
  });

  test('광란: 겹 수와 마지막 겹이 끝날 때까지의 시간, 7초 기준', () => {
    const now = 10000;
    const list = hordeStatusList({ me: ME, stage: 2, now, perks: { frenzy: 0.01 }, frenzy: [9000, now + 3000, now + 6500] });
    const f = byId(list, 'frenzy');
    assert.equal(f.stacks, 2, '이미 끝난 겹은 세지 않는다');
    assert.equal(f.leftMs, 6500);
    assert.equal(f.totalMs, 7000);
    assert.match(f.desc, /연사 \+2%/);
    assert.ok(!byId(hordeStatusList({ me: ME, now, frenzy: [now - 1] }), 'frenzy'));
  });

  test('두 번째 기회·배수의 진은 카드와 조건이 있을 때만', () => {
    assert.ok(byId(hordeStatusList({ me: ME, perks: { secondChance: 1 }, secondReady: true }), 'second'));
    assert.ok(!byId(hordeStatusList({ me: ME, perks: { secondChance: 1 }, secondReady: false }), 'second'), '이번 스테이지에 썼다');
    assert.ok(!byId(hordeStatusList({ me: ME, perks: {}, secondReady: true }), 'second'));
    assert.ok(!byId(hordeStatusList({ me: ME, perks: { lastStand: 1 } }), 'lastStand'), '체력 80%');
    const ls = byId(hordeStatusList({ me: { ...ME, hp: 35 }, perks: { lastStand: 1 } }), 'lastStand');
    assert.equal(ls.kind, 'buff');
    assert.match(ls.desc, /\+100%/);
  });

  test('내 몸 타이머(기절·느려짐·붙잡힘)와 발밑 장판', () => {
    const local = { slowMs: 1200, slowMul: 0.6, stunMs: 800, grabbed: true };
    const list = hordeStatusList({ me: ME, local, field: { kind: 'acid', leftMs: 2500 } });
    assert.deepEqual(ids(list), ['stun', 'slow', 'grab', 'field']);
    assert.ok(list.every((s) => s.kind === 'debuff'));
    assert.equal(byId(list, 'stun').icon, '💫');
    assert.match(byId(list, 'slow').desc, /−40%/);
    assert.equal(byId(list, 'grab').leftMs, undefined);
    assert.equal(byId(list, 'field').leftMs, 2500);
    assert.match(byId(list, 'field').desc, /회복이 절반/);
    assert.equal(byId(hordeStatusList({ me: ME, local, grabStun: true }), 'stun').icon, '🪝', '그랩과 같이 온 기절');
    assert.doesNotMatch(byId(hordeStatusList({ me: ME, field: { kind: 'web', leftMs: 1 } }), 'field').desc, /피해/, '거미줄은 피해가 없다');
  });

  test('자동 부활 없음: 다음 스테이지가 HORDE.noAutoReviveStage 이상이면(멀티만), 쓰러져 있어도 남는다', () => {
    const at = HORDE.noAutoReviveStage - 1;
    assert.equal(noAutoRevive(at - 1), false);
    assert.equal(noAutoRevive(at), true);
    assert.ok(!byId(hordeStatusList({ me: ME, stage: at - 1 }), 'noRevive'));
    const s = byId(hordeStatusList({ me: ME, stage: at }), 'noRevive');
    assert.equal(s.kind, 'debuff');
    assert.equal(s.leftMs, undefined, '시간 없는 상태');
    assert.ok(s.desc.includes(String(HORDE.noAutoReviveStage)));
    assert.ok(!byId(hordeStatusList({ me: ME, stage: at, solo: true }), 'noRevive'), '혼자는 쓰러지면 끝이라 보이지 않는다');
    assert.deepEqual(ids(hordeStatusList({ me: { ...ME, alive: false, burnMs: 3000 }, stage: at + 5 })), ['noRevive'], '쓰러져 있으면 이것만');
    assert.deepEqual(hordeStatusList({ me: { ...ME, alive: false }, stage: 1 }), []);
  });
});

describe('ui/status.js', () => {
  test('statusSpec: 배열이 아니면 빈 목록, id 없거나 겹치면 버림, 숫자 칸은 값 → 겹 수(2 이상)', () => {
    assert.deepEqual(statusSpec(null), []);
    const list = statusSpec([
      { id: 'a', kind: 'debuff', icon: '🔥', name: '화상', desc: 'd', leftMs: 1500 },
      { id: 'a', kind: 'buff' },
      { kind: 'buff' },
      { id: 'b', kind: 'weird', stacks: 1 },
      { id: 'c', stacks: 3 },
      { id: 'd', value: 30, stacks: 9, leftMs: -5 }
    ]);
    assert.deepEqual(list.map((s) => [s.id, s.kind, s.badge, s.leftMs]), [['a', 'debuff', '', 1500], ['b', 'buff', '', null], ['c', 'buff', '3', null], ['d', 'buff', '30', 0]]);
    assert.equal(statusSpec(Array.from({ length: 20 }, (_, i) => ({ id: `x${i}` }))).length, 12, '최대 12개');
  });

  test('statusTotal: 주어진 전체 시간, 아니면 처음 본 값 → 다시 걸려 늘면 새로 시작', () => {
    assert.equal(statusTotal(7000, 0, null, 6500), 7000);
    assert.equal(statusTotal(null, 0, null, 3000), 3000, '처음 본 값');
    assert.equal(statusTotal(null, 3000, 2950, 3100), 3100, '스냅샷 흔들림(0.4초 이하)은 새로 시작하지 않고 가장 큰 값');
    assert.equal(statusTotal(null, 3000, 2000, 1900), 3000, '줄어드는 동안은 그대로');
    assert.equal(statusTotal(null, 3000, 1000, 5000), 5000, '다시 걸림');
    assert.equal(statusFrac(1500, 3000), 0.5);
    assert.equal(statusFrac(5000, 3000), 1);
    assert.equal(statusFrac(0, 3000), 0);
  });

  test('statusTimeText·statusMeta', () => {
    assert.equal(statusTimeText(12000), '12');
    assert.equal(statusTimeText(10001), '11');
    assert.equal(statusTimeText(9950), '10');
    assert.equal(statusTimeText(4210), '4.3');
    assert.equal(statusTimeText(0), '0.0');
    assert.equal(statusMeta({ leftMs: 4210, stacks: 5 }), '남은 시간 4.3초 · 5겹');
    assert.equal(statusMeta({ leftMs: null, stacks: 0 }), '');
  });
});
