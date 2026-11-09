/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: HUD와 스코프의 DOM 없는 계산(속도계, 콜아웃 색조, 배너 입력, 슬롯 정규화, 배율 표시)을 확인한다.
 *          폭파 미션 표시 계산(bomb 값 정리, 카운트다운 글자, 진영, 라운드 칸, 미션 맵 고르기, 레드 팀 이름)도 여기서 본다.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { PLAYER, MOVE, TEAMS as CORE_TEAMS } from '../js/core/consts.js';
import { WEAPONS } from '../js/weapons/defs.js';
import { speedGauge, calloutTone, bannerSpec, normSlots, bombSpec, bombTimerText, markerDist } from '../js/ui/hud.js';
import { magLabel, zoomReadout } from '../js/ui/scope.js';
import { TEAMS, modeKey, modeLabel, MODE_NAME, MODE_ICON, bombSide } from '../js/ui/dom.js';
import { weaponInfo, normMap } from '../js/ui/icons.js';
import { ruleBadge, ruleForMode, missionMaps, mapsForMode, MODE_IDS } from '../js/ui/lobby.js';
import { normRounds, bombRoundInfo } from '../js/ui/results.js';

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

describe('팀 이름: 오렌지 → 레드', () => {
  test('UI와 core가 같은 이름을 쓰고 내부 id는 그대로다', () => {
    assert.deepEqual([TEAMS.charterer.key, TEAMS.charterer.name, TEAMS.charterer.en, TEAMS.charterer.emoji], ['charterer', '레드', 'Red', '🟥']);
    assert.deepEqual([CORE_TEAMS.charterer.id, CORE_TEAMS.charterer.name, CORE_TEAMS.charterer.nameEn], ['charterer', '레드', 'Red']);
    assert.equal(TEAMS.owner.name, CORE_TEAMS.owner.name);
  });
});

describe('모드: 폭파 미션', () => {
  test("modeKey는 'ffa'·'bomb'만 그대로, 나머지는 'team'", () => {
    assert.equal(modeKey('ffa'), 'ffa');
    assert.equal(modeKey('bomb'), 'bomb');
    for (const m of ['team', undefined, null, '', 'BOMB', 'x']) assert.equal(modeKey(m), 'team');
  });

  test('이름 · 아이콘 · 표시 문구', () => {
    assert.equal(MODE_NAME.bomb, '폭파 미션');
    assert.equal(MODE_ICON.bomb, '💣');
    assert.equal(modeLabel('bomb'), '폭파 미션 · 5판 3선승');
    assert.equal(modeLabel('team'), '팀전 · 5판 3선승');
    assert.equal(modeLabel('ffa', { killTarget: 15 }), '개인전 · 15킬');
    assert.deepEqual(MODE_IDS, ['team', 'ffa', 'bomb']);
  });

  test('진영: 공격 팀과 같으면 attack, 다르면 defense, 모르면 빈 값', () => {
    assert.equal(bombSide('owner', 'owner'), 'attack');
    assert.equal(bombSide('charterer', 'owner'), 'defense');
    assert.equal(bombSide('owner', 'charterer'), 'defense');
    assert.equal(bombSide('owner', null), '');
    assert.equal(bombSide(null, 'owner'), '');
    assert.equal(bombSide('owner', 'draw'), '');
  });
});

describe('bombTimerText', () => {
  test('10초 이상은 올림한 정수, 그 밑은 0.1초 단위로 올림', () => {
    assert.equal(bombTimerText(35), '35');
    assert.equal(bombTimerText(34.2), '35');
    assert.equal(bombTimerText(10), '10');
    assert.equal(bombTimerText(9.95), '10', '9.9초가 되기 전까지는 10');
    assert.equal(bombTimerText(9.9), '9.9');
    assert.equal(bombTimerText(9.81), '9.9');
    assert.equal(bombTimerText(0.04), '0.1');
    assert.equal(bombTimerText(0), '0.0');
    assert.equal(bombTimerText(-3), '0.0');
  });

  test('소수 오차로 한 칸 더 올라가지 않는다', () => {
    assert.equal(bombTimerText(0.1 + 0.2), '0.3');
  });

  test('값이 없거나 숫자가 아니면 빈 글자(카운트다운 숨김)', () => {
    for (const bad of [null, undefined, '', 'x', NaN, Infinity]) assert.equal(bombTimerText(bad), '');
  });
});

describe('markerDist', () => {
  test('반올림한 m, 없으면 빈 글자', () => {
    assert.equal(markerDist(6.4), '6 m');
    assert.equal(markerDist(51.5), '52 m');
    assert.equal(markerDist(0), '0 m');
    for (const bad of [null, undefined, '', 'x']) assert.equal(markerDist(bad), '');
  });
});

describe('bombSpec', () => {
  test('객체가 아니면 null(폭파 미션 표시를 지운다)', () => {
    for (const bad of [null, undefined, false, 0, 'bomb']) assert.equal(bombSpec(bad), null);
  });

  test('빈 객체는 빈 표시로 채운다', () => {
    assert.deepEqual(bombSpec({}), {
      side: null, goal: '', status: '', tone: '', timer: null, carrying: false, progress: null, prompt: '', markers: [],
    });
  });

  test('계약 그대로의 값을 옮긴다', () => {
    const b = bombSpec({
      side: 'attack', goal: 'A 또는 B 구역에 폭탄을 설치하세요', status: '💣 폭탄 소지', tone: 'attack', timer: 12.5, carrying: true,
      progress: { kind: 'plant', ratio: 0.6, label: '설치 중… 1.2초' }, prompt: 'E 길게 눌러 설치',
      markers: [{ id: 'A', label: 'A', kind: 'site', x: 100, y: 200, on: true, edge: false, planted: false, dist: 8.2 }],
    });
    assert.equal(b.side, 'attack');
    assert.equal(b.timer, 12.5);
    assert.equal(b.carrying, true);
    assert.deepEqual(b.progress, { kind: 'plant', ratio: 0.6, label: '설치 중… 1.2초' });
    assert.equal(b.prompt, 'E 길게 눌러 설치');
    assert.deepEqual(b.markers, [{ id: 'A', label: 'A', kind: 'site', x: 100, y: 200, on: true, edge: false, planted: false, dist: 8.2 }]);
  });

  test('모르는 값은 기본값으로, ratio는 0~1로 자른다', () => {
    const b = bombSpec({ side: 'spectator', tone: 'pink', timer: 'x', progress: { kind: 'drill', ratio: 4 } });
    assert.equal(b.side, null);
    assert.equal(b.tone, '');
    assert.equal(b.timer, null);
    assert.deepEqual(b.progress, { kind: 'plant', ratio: 1, label: '' });
    assert.equal(bombSpec({ progress: { kind: 'defuse', ratio: -1 } }).progress.ratio, 0);
    assert.equal(bombSpec({ progress: { kind: 'defuse', ratio: 0.5 } }).progress.kind, 'defuse');
    assert.equal(bombSpec({ timer: -2 }).timer, 0);
  });

  test('표식: id 없는 것은 빼고, 같은 id는 앞의 것만, 좌표가 숫자가 아니면 숨긴다', () => {
    const b = bombSpec({
      markers: [
        { id: 'B', label: 'B', x: 10, y: 20, on: true },
        { label: '이름표만', x: 1, y: 1, on: true },
        { id: 'B', label: '두 번째 B', x: 30, y: 40, on: true },
        { id: 'bomb', kind: 'bomb', x: '50', y: 60, planted: true, edge: 1 },
        { id: 'C', x: null, y: 5, on: true },
        null,
      ],
    });
    assert.deepEqual(b.markers.map((m) => m.id), ['B', 'bomb', 'C']);
    assert.equal(b.markers[0].label, 'B');
    assert.equal(b.markers[0].kind, 'site', 'kind를 안 주면 구역');
    assert.deepEqual([b.markers[1].kind, b.markers[1].x, b.markers[1].on, b.markers[1].edge, b.markers[1].planted, b.markers[1].dist], ['bomb', 50, true, true, true, null]);
    assert.equal(b.markers[2].on, false);
    assert.equal(bombSpec({ markers: [{ id: 'A', x: 1, y: 2, on: false }] }).markers[0].on, false);
    assert.deepEqual(bombSpec({ markers: 'A' }).markers, []);
  });
});

describe('킬피드 · 맵 정보', () => {
  test("weaponId 'bomb'은 💥 폭탄이다(무기 표에 없어도)", () => {
    const w = weaponInfo(new Map(), 'bomb');
    assert.deepEqual([w.id, w.icon, w.name, w.short], ['bomb', '💥', '폭탄', '폭탄']);
    assert.equal(weaponInfo(registry, 'gr_frag').name, WEAPONS.gr_frag.name, '다른 무기는 그대로');
    assert.equal(weaponInfo(new Map(), '__proto__').name, '__proto__');
  });

  test('normMap은 mission을 true일 때만 옮긴다', () => {
    assert.equal(normMap({ id: 'relay', mission: true }).mission, true);
    assert.equal(normMap({ id: 'alley' }).mission, false);
    assert.equal(normMap({ id: 'alley', mission: { sites: [] } }).mission, false);
    assert.equal(normMap('alley').mission, false);
  });
});

describe('로비 · 대기실: 폭파 미션 규칙과 맵', () => {
  const maps = [
    { id: 'alley', rulesets: ['classic', 'knife'] },
    { id: 'relay', rulesets: ['classic'], mission: true },
    { id: 'dojo', rulesets: ['knife'], mission: true },
    { id: 'jetty', mission: true },
  ];

  test('폭파 미션은 언제나 클래식이고 배지도 그렇다', () => {
    assert.equal(ruleForMode('bomb', 'knife'), 'classic');
    assert.equal(ruleForMode('team', 'knife'), 'knife');
    assert.equal(ruleForMode('ffa', 'nope'), 'classic');
    assert.equal(ruleBadge('knife', 'bomb'), '클래식 · 폭파 미션');
    assert.equal(ruleBadge(undefined, 'bomb'), '클래식 · 폭파 미션');
    assert.equal(ruleBadge('knife', 'ffa'), '칼전 · 개인전');
  });

  test('미션 맵은 mission이 true이고 클래식을 고를 수 있는 맵만, 없으면 빈 목록', () => {
    assert.deepEqual(missionMaps(maps).map((m) => m.id), ['relay', 'jetty'], 'rulesets를 안 적은 맵은 클래식을 고를 수 있다');
    assert.deepEqual(missionMaps([{ id: 'alley' }, { id: 'x', mission: 1 }]), []);
    assert.deepEqual(mapsForMode(maps, 'bomb', 'knife').map((m) => m.id), ['relay', 'jetty']);
    assert.deepEqual(mapsForMode(maps, 'team', 'knife').map((m) => m.id), ['alley', 'dojo']);
  });
});

describe('결과: 폭파 미션 라운드 칸', () => {
  test('normRounds는 reasonCode와 공격 팀을 옮긴다(옛 형식도 받는다)', () => {
    const rs = normRounds([
      { round: 1, winner: 'owner', reason: '폭탄 폭파', reasonCode: 'bomb', attack: 'owner' },
      'charterer',
      { winner: 'nobody' },
    ]);
    assert.deepEqual(rs[0], { n: 1, winner: 'owner', reason: '폭탄 폭파', reasonCode: 'bomb', attack: 'owner' });
    assert.deepEqual(rs[1], { n: 2, winner: 'charterer', reason: '', reasonCode: '', attack: '' });
    assert.equal(rs[2].winner, 'draw');
  });

  test('끝난 방식 아이콘과 이긴 진영', () => {
    const info = (r) => bombRoundInfo(normRounds([r])[0]);
    const a = info({ winner: 'owner', reason: '폭탄 폭파', reasonCode: 'bomb', attack: 'owner' });
    assert.deepEqual([a.icon, a.reason, a.won, a.side], ['💥', '폭탄 폭파', 'attack', '공격 승']);
    assert.equal(a.title, 'R1 · 💥 폭탄 폭파 · 공격 승 · 블루 공격');
    const d = info({ winner: 'charterer', reasonCode: 'defuse', attack: 'owner' });
    assert.deepEqual([d.icon, d.reason, d.won, d.side], ['✂️', '폭탄 해체', 'defense', '수비 승'], 'reason이 없으면 기본 문구');
    assert.deepEqual([info({ winner: 'owner', reasonCode: 'elimination', attack: 'charterer' }).icon, info({ winner: 'owner', reasonCode: 'time', attack: 'charterer' }).icon], ['☠️', '⏱']);
    const draw = info({ winner: 'draw', reason: '무승부', reasonCode: 'draw', attack: 'owner' });
    assert.deepEqual([draw.icon, draw.won, draw.side], ['', '', '']);
    assert.equal(info({ winner: 'owner', reasonCode: 'bomb' }).side, '', '공격 팀을 모르면 진영을 쓰지 않는다');
  });
});
