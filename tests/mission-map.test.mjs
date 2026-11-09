/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 폭파 미션 맵(중계 기지)의 미션 칸, 맵 목록의 모드별 거르기, 맵 검사기의 미션 검사(구역·진영 스폰·길 길이)를 검증한다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import relay from '../js/maps/relay.js';
import { normalizeMission, siteAt } from '../js/game/mission.js';
import { buildNavGrid } from '../js/game/navgrid.js';
import { wall } from '../js/maps/kit.js';
import { checkMap, checkMission } from '../tools/check-maps.mjs';

/** 검사기 미션 검사를 돌리고 { report, errors, warnings }를 돌려준다 */
function mission(data) {
  const out = { errors: [], warnings: [] };
  const report = checkMission(data, buildNavGrid(data), out);
  return { report, ...out };
}
const has = (list, re) => assert.match(list.join('\n'), re);

/* ---------------- 중계 기지 ---------------- */

test('relay has sites A and B and four or more spawns per side, all outside the sites', () => {
  const m = normalizeMission(relay);
  assert.ok(m, 'mission parses');
  assert.deepEqual(m.sites.map((s) => s.id), ['A', 'B']);
  for (const s of m.sites) {
    assert.ok(s.w >= 7 && s.w <= 10 && s.d >= 7 && s.d <= 10, `${s.id} is ${s.w} x ${s.d} m`);
    assert.ok(s.minX >= -relay.size.x / 2 && s.maxX <= relay.size.x / 2 && s.minZ >= -relay.size.z / 2 && s.maxZ <= relay.size.z / 2, `${s.id} inside size`);
  }
  assert.ok(m.attack.length >= 4, `attack ${m.attack.length}`);
  assert.ok(m.defense.length >= 4, `defense ${m.defense.length}`);
  for (const p of [...m.attack, ...m.defense]) assert.equal(siteAt(m.sites, p, 0.5), null, `spawn (${p.x}, ${p.z}) is outside every site`);
  // 팀전·개인전도 같은 맵에서 한다: 팀 스폰은 진영 스폰 복사본, 개인전 스폰은 6곳 이상
  assert.deepEqual(relay.spawns.owner, relay.mission.attack);
  assert.deepEqual(relay.spawns.charterer, relay.mission.defense);
  assert.ok(relay.spawns.ffa.length >= 6);
  assert.deepEqual(relay.rulesets, ['classic']);
  assert.equal(relay.tag, '폭파 미션');
});

test('relay: both sides reach both sites and the defense gets there clearly first', () => {
  const { report, errors, warnings } = mission(relay);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  assert.equal(report.attack, 5);
  assert.equal(report.defense, 5);
  assert.equal(report.los, 0);
  assert.deepEqual(report.sites.map((s) => s.id), ['A', 'B']);
  for (const s of report.sites) {
    assert.ok(s.area >= 25, `${s.id} plantable floor ${s.area} m²`);
    assert.equal(s.attack.n, 5);
    assert.equal(s.defense.n, 5);
    assert.ok(s.defense.min >= 20 && s.defense.min <= 40, `${s.id} defense ${s.defense.min} m`);
    assert.ok(s.attack.min >= 50 && s.attack.min <= 80, `${s.id} attack ${s.attack.min} m`);
    assert.ok(s.attack.min - s.defense.min >= 15, `${s.id} attack ${s.attack.min} m vs defense ${s.defense.min} m`);
  }
});

test('relay passes the whole map checker under new-map rules with no warnings', () => {
  const r = checkMap('relay', relay);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.strict, true);
  assert.equal(r.los, 0);
  assert.equal(r.mission.sites.length, 2);
});

test('map index lists relay as a mission map and bomb mode offers only mission maps with classic rules', async () => {
  const realWarn = console.warn;
  console.warn = () => {}; // 아직 없는 맵 파일은 조용히 테스트 맵으로 대신한다
  const { MAP_IDS, MAP_LIST, mapsForMode, mapsForRuleset } = await import('../js/maps/index.js').finally(() => { console.warn = realWarn; });
  assert.ok(MAP_IDS.includes('relay'));
  const entry = MAP_LIST.find((m) => m.id === 'relay');
  assert.equal(entry.ok, true);
  assert.equal(entry.mission, true);
  assert.equal(entry.name, '중계 기지');
  assert.equal(entry.tag, '폭파 미션');
  for (const m of MAP_LIST) assert.equal(typeof m.mission, 'boolean', m.id);
  assert.equal(MAP_LIST.find((m) => m.test).mission, false);
  for (const m of MAP_LIST.filter((e) => e.fallback)) assert.equal(m.mission, false, `${m.id} is a fallback`);
  for (const ruleset of ['classic', 'knife', 'sniper', 'bogus']) {
    const bomb = mapsForMode('bomb', ruleset);
    assert.ok(bomb.some((m) => m.id === 'relay'), ruleset);
    assert.ok(bomb.every((m) => m.mission && m.rulesets.includes('classic') && !m.test), ruleset);
  }
  assert.deepEqual(mapsForMode('team', 'knife'), mapsForRuleset('knife'));
  assert.deepEqual(mapsForMode('ffa', 'sniper'), mapsForRuleset('sniper'));
  assert.deepEqual(mapsForMode(undefined, 'classic'), mapsForRuleset('classic'));
});

/* ---------------- 검사기: 작은 미션 맵 ---------------- */

// 60 x 40 빈 마당. 공격은 서쪽 아래, 수비는 동쪽 끝, 구역은 수비 앞에 둘
function sampleMission(over = {}) {
  const attack = [-25, -22, -19, -16].map((x) => ({ x, z: -14, rotY: -Math.PI / 2 }));
  const defense = [-3, -1, 1, 3].map((z) => ({ x: 26, z, rotY: Math.PI / 2 }));
  return {
    id: 'sample',
    size: { x: 60, z: 40 },
    rulesets: ['classic'],
    spawns: { owner: attack, charterer: defense, ffa: [[-24, 14], [-12, 14], [0, 14], [10, -16], [0, -14], [0, 0]].map(([x, z]) => ({ x, z, rotY: 0 })) },
    solids: [wall(-10, -8, -10, 8, 4, 0.4, 'brick'), wall(5, -8, 5, 8, 4, 0.4, 'brick'), wall(23, -5, 23, 5, 3, 0.4, 'brick')],
    mission: {
      sites: [{ id: 'A', x: 16, y: 0, z: 8, w: 6, h: 3, d: 6 }, { id: 'B', x: 16, y: 0, z: -8, w: 6, h: 3, d: 6 }],
      attack,
      defense
    },
    ...over
  };
}
const withMission = (patch) => { const m = sampleMission(); return { ...m, mission: { ...m.mission, ...patch } }; };

test('checker mission check passes a sound mission and reports both sides for both sites', () => {
  const { report, errors, warnings } = mission(sampleMission());
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  assert.deepEqual(report.sites.map((s) => s.id), ['A', 'B']);
  for (const s of report.sites) {
    assert.ok(s.nodes >= 16, `${s.id} cells ${s.nodes}`);
    assert.ok(s.defense.min + 10 <= s.attack.min, `${s.id} ${s.defense.min} / ${s.attack.min}`);
  }
  assert.equal(checkMission({ id: 'plain', solids: [] }, null), null, 'maps without mission are skipped');
});

test('checker mission check catches missing sites, bad boxes, too few spawns and spawns in a site', () => {
  const base = sampleMission().mission;
  has(mission(withMission({ sites: [base.sites[0]] })).errors, /site B is missing/);
  has(mission(withMission({ sites: [] })).errors, /no valid site/);
  has(mission(withMission({ sites: [base.sites[0], { ...base.sites[1], x: 29 }] })).errors, /site B: box .* is outside size/);
  has(mission(withMission({ sites: [base.sites[0], { ...base.sites[1], z: 6 }] })).errors, /sites A and B overlap/);
  has(mission(withMission({ attack: base.attack.slice(0, 3) })).errors, /mission\.attack: 3 < 4/);
  has(mission(withMission({ defense: [...base.defense.slice(0, 3), { x: 16, z: 8, rotY: 0 }] })).errors, /mission\.defense\[3\].*inside site A/);
  has(mission(withMission({ attack: [...base.attack.slice(0, 3), { x: -10, z: 0, rotY: 0 }] })).errors, /mission\.attack\[3\].*(narrow top|inside a wall)/);
});

test('checker mission check flags a walled-off site and a defense that is not closer', () => {
  // A 구역을 벽으로 둘러 막으면 안쪽 칸이 아무 스폰에서도 닿지 않는다
  const cage = [wall(12, 4, 20, 4, 4, 0.4, 'stone'), wall(12, 12, 20, 12, 4, 0.4, 'stone'), wall(12, 4, 12, 12, 4, 0.4, 'stone'), wall(20, 4, 20, 12, 4, 0.4, 'stone')];
  const caged = mission(sampleMission({ solids: [...sampleMission().solids, ...cage] }));
  has(caged.errors, /site A: 0 walkable navgrid cells/);
  has(caged.errors, /cannot reach site A/);
  // 진영을 맞바꾸면 수비가 더 멀다
  const base = sampleMission().mission;
  const swapped = mission(withMission({ attack: base.defense, defense: base.attack }));
  assert.deepEqual(swapped.errors, []);
  has(swapped.warnings, /site A: defense needs .* defense should be at least 10 m closer/);
});
