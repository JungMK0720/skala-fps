/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 새 맵 넷을 검증한다. 폭파 미션 맵(화물 조차장·사막 관측소)의 미션 칸과 길 길이, 좁은 맵(근접전 훈련장·택배 분류 센터)의 크기·대칭·움직이는 지형,
 *          맵 목록에서의 순서와 모드별 거르기, 맵 검사기 통과를 본다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import railyard from '../js/maps/railyard.js';
import observatory from '../js/maps/observatory.js';
import cqb from '../js/maps/cqb.js';
import sorthub from '../js/maps/sorthub.js';
import { normalizeMission, siteAt } from '../js/game/mission.js';
import { normalizeMovers, moverOffset, moverPeakSpeed, MOVER_MAX_SPEED } from '../js/engine/movers.js';
import { rotate180 } from '../js/maps/kit.js';
import { checkMap } from '../tools/check-maps.mjs';

const BOMB = { railyard, observatory };
const NARROW = { cqb, sorthub };
const NAMES = {
  railyard: ['화물 조차장', 'Freight Yard', '폭파 미션'], observatory: ['사막 관측소', 'Desert Observatory', '폭파 미션'],
  cqb: ['근접전 훈련장', 'CQB Yard', '좁은 맵'], sorthub: ['택배 분류 센터', 'Parcel Hub', '좁은 맵']
};
const reports = new Map();
const report = (id, map) => { if (!reports.has(id)) reports.set(id, checkMap(id, map)); return reports.get(id); };

for (const [id, map] of Object.entries({ ...BOMB, ...NARROW })) {
  test(`${id}: 이름·배지가 맞고 새 맵 규칙으로 검사기를 경고 없이 통과한다`, () => {
    assert.equal(map.id, id);
    assert.deepEqual([map.name, map.nameEn, map.tag], NAMES[id]);
    assert.ok(typeof map.desc === 'string' && map.desc.length > 10);
    const r = report(id, map);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.warnings, []);
    assert.equal(r.strict, true);
    assert.equal(r.los, 0, '적 스폰이 서로 보이지 않는다');
    assert.ok(map.spawns.ffa.length >= 8, `개인전 스폰 ${map.spawns.ffa.length}`);
  });
}

/* ---------------- 폭파 미션 맵 ---------------- */

for (const [id, map] of Object.entries(BOMB)) {
  test(`${id}: A·B 구역, 진영 스폰 다섯, 팀전·개인전 스폰`, () => {
    const m = normalizeMission(map);
    assert.ok(m, 'mission parses');
    assert.deepEqual(m.sites.map((s) => s.id), ['A', 'B']);
    for (const s of m.sites) {
      assert.ok(s.w >= 7 && s.w <= 10 && s.d >= 7 && s.d <= 10, `${s.id} is ${s.w} x ${s.d} m`);
      assert.match(s.name, new RegExp(`^${s.id} 구역 · `));
    }
    assert.equal(m.attack.length, 5);
    assert.equal(m.defense.length, 5);
    for (const p of [...m.attack, ...m.defense]) assert.equal(siteAt(m.sites, p, 0.5), null, `spawn (${p.x}, ${p.z}) is outside every site`);
    assert.deepEqual(map.spawns.owner, map.mission.attack);
    assert.deepEqual(map.spawns.charterer, map.mission.defense);
    assert.deepEqual(map.rulesets, ['classic']);
    // 움직이는 지형은 폭파 맵에 두지 않았다(설치한 폭탄 위를 지나가지 않게)
    assert.equal((map.movers || []).length, 0);
  });

  test(`${id}: 두 진영이 두 구역에 닿고 수비가 뚜렷하게 먼저 닿는다`, () => {
    const mission = report(id, map).mission;
    assert.equal(mission.attack, 5);
    assert.equal(mission.defense, 5);
    assert.equal(mission.los, 0);
    assert.deepEqual(mission.sites.map((s) => s.id), ['A', 'B']);
    for (const s of mission.sites) {
      assert.ok(s.area >= 25, `${s.id} plantable floor ${s.area} m²`);
      assert.equal(s.attack.n, 5);
      assert.equal(s.defense.n, 5);
      assert.ok(s.defense.min >= 20 && s.defense.min <= 40, `${s.id} defense ${s.defense.min} m`);
      assert.ok(s.attack.min >= 50 && s.attack.min <= 80, `${s.id} attack ${s.attack.min} m`);
      assert.ok(s.attack.min - s.defense.min >= 15, `${s.id} attack ${s.attack.min} m vs defense ${s.defense.min} m`);
    }
  });
}

/* ---------------- 좁은 맵 ---------------- */

const MAX_SIZE = { cqb: [34, 24], sorthub: [48, 34] };
const MOVER_COUNT = { cqb: 2, sorthub: 6 };

for (const [id, map] of Object.entries(NARROW)) {
  test(`${id}: 좁고, 클래식·칼전이고, 양 팀이 180° 대칭이다`, () => {
    assert.ok(map.size.x <= MAX_SIZE[id][0] && map.size.z <= MAX_SIZE[id][1], `size ${JSON.stringify(map.size)}`);
    assert.deepEqual(map.rulesets, ['classic', 'knife']);
    assert.equal(map.mission, undefined);
    assert.ok(map.spawns.owner.length >= 4);
    const flip = (p) => ({ x: p.x, z: p.z });
    assert.deepEqual(map.spawns.charterer.map(flip), rotate180(map.spawns.owner).map(flip), '레드 스폰은 블루 스폰을 180° 돌린 자리다');
  });

  test(`${id}: 움직이는 지형이 짝을 이루고 속도 한도 안이다`, () => {
    const movers = normalizeMovers(map.movers);
    assert.equal(movers.length, MOVER_COUNT[id]);
    assert.equal(movers.length, (map.movers || []).length, '버려지는 항목이 없다');
    for (const m of movers) assert.ok(moverPeakSpeed(m) <= MOVER_MAX_SPEED, `${m.id} peak ${moverPeakSpeed(m)}`);
    // 모든 상자에 180° 돌린 짝이 있고, 같은 시각에 서로 대칭인 자리에 있다(양 팀이 같은 박자를 본다)
    const at = (m, t) => {
      const off = moverOffset(m, t);
      return [m.x + (m.axis === 'x' ? off : 0), m.y + (m.axis === 'y' ? off : 0), m.z + (m.axis === 'z' ? off : 0)];
    };
    for (const m of movers) {
      const twin = movers.find((o) => o !== m && o.axis === m.axis && Math.abs(o.x + m.x) < 1e-6 && Math.abs(o.z + m.z) < 1e-6 && o.w === m.w && o.h === m.h && o.d === m.d);
      assert.ok(twin, `${m.id}의 짝`);
      for (const t of [0, 1.7, 3.3, 5, 7.9, 11]) {
        const a = at(m, t), b = at(twin, t);
        assert.ok(Math.abs(a[0] + b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6 && Math.abs(a[2] + b[2]) < 1e-6, `${m.id} t=${t}`);
      }
    }
    assert.deepEqual(report(id, map).movers.map((m) => m.id).sort(), movers.map((m) => m.id).sort());
  });
}

test('근접전 훈련장: 길을 오가는 표적판 둘과 지붕길 발판', () => {
  const movers = normalizeMovers(cqb.movers);
  assert.ok(movers.every((m) => m.axis === 'x' && Math.abs(m.dist) >= 6), '수평으로 6 m 넘게 오간다');
  assert.ok(movers.every((m) => m.h >= 1.8), '서서 가릴 수 있는 높이');
  assert.ok((cqb.pads || []).length >= 2, '팀마다 지붕길로 가는 발판');
});

test('택배 분류 센터: 리프트 둘, 셔터 둘, 수레 둘', () => {
  const movers = normalizeMovers(sorthub.movers);
  const lifts = movers.filter((m) => m.axis === 'y' && Math.min(m.w, m.d) >= 1);
  const shutters = movers.filter((m) => m.axis === 'y' && Math.min(m.w, m.d) < 1);
  const carts = movers.filter((m) => m.axis !== 'y');
  assert.deepEqual([lifts.length, shutters.length, carts.length], [2, 2, 2]);
  // 리프트는 바닥에 묻힌 기둥이다: 쉬는 자리의 윗면이 바닥에서 한 턱 높이 안이고, 아래로는 바닥보다 깊다
  for (const m of lifts) {
    assert.ok(m.y < 0 && m.y + m.h > 0 && m.y + m.h <= 0.45, `${m.id} rest top ${m.y + m.h}`);
    assert.ok(m.y + m.dist <= 0, `${m.id} 다 올라가도 밑이 뜨지 않는다`);
    assert.ok(m.dist >= 2.4, `${m.id} 2층까지 오른다`);
  }
  for (const m of shutters) assert.ok(m.dist >= 2.2 && m.y === 0, `${m.id} 문 높이만큼 올라간다`);
});

/* ---------------- 맵 목록 ---------------- */

test('맵 목록: 좁은 맵은 항구 골목 뒤, 폭파 맵은 중계 기지 뒤. 규칙별 기본 맵은 그대로다', async () => {
  const realWarn = console.warn;
  console.warn = () => {};
  const { MAP_IDS, MAP_LIST, MAP_STATUS, mapsForMode, mapsForRuleset } = await import('../js/maps/index.js').finally(() => { console.warn = realWarn; });
  for (const id of ['railyard', 'observatory', 'cqb', 'sorthub']) {
    assert.ok(MAP_IDS.includes(id), id);
    assert.equal(MAP_STATUS[id].ok, true, `${id}: ${MAP_STATUS[id].error}`);
    const entry = MAP_LIST.find((m) => m.id === id);
    assert.deepEqual([entry.name, entry.nameEn, entry.tag], NAMES[id]);
    assert.equal(entry.fallback, false);
    assert.equal(entry.mission, id === 'railyard' || id === 'observatory');
  }
  assert.deepEqual(mapsForMode('bomb', 'classic').map((m) => m.id), ['relay', 'railyard', 'observatory'], '폭파 미션의 기본 맵은 중계 기지');
  const ids = (r) => mapsForRuleset(r).map((m) => m.id);
  assert.deepEqual(ids('classic').slice(0, 3), ['alley', 'cqb', 'sorthub']);
  assert.deepEqual(ids('knife').slice(0, 5), ['rooftop', 'glasshouse', 'alley', 'cqb', 'sorthub']);
  assert.ok(!ids('sniper').includes('cqb') && !ids('sniper').includes('sorthub') && !ids('sniper').includes('railyard'));
  assert.ok(!ids('knife').includes('railyard') && !ids('knife').includes('observatory'));
});
