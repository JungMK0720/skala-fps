/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 배틀로얄 맵 칸을 검증한다. '서해 항만 신도시'가 검사기를 경고 없이 통과하고 격자·전리품·시작 자리 약속을 지키는지,
 *          맵 목록에서 배틀로얄에만 나오는지, 형식 검사(validateMap)와 바닥·길 검사(checkBrMap)가 잘못된 칸을 잡는지 본다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import harbortown from '../js/maps/harbortown.js';
import { BR_RULES, hasBrData, isBrMap, validateMap } from '../js/maps/collision.js';
import { checkMap } from '../tools/check-maps.mjs';

const report = checkMap('harbortown', harbortown);

test('서해 항만 신도시: 이름·배지가 맞고 새 맵 규칙으로 검사기를 경고 없이 통과한다', () => {
  assert.deepEqual([harbortown.id, harbortown.name, harbortown.nameEn, harbortown.tag], ['harbortown', '서해 항만 신도시', 'West Sea Harbor Town', '배틀로얄 전용']);
  assert.deepEqual(harbortown.modes, ['br']);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.warnings, []);
  assert.equal(report.strict, true);
  assert.ok(isBrMap(harbortown) && hasBrData(harbortown));
});

test('서해 항만 신도시: 8×8 격자(칸 31 m)가 250 m 맵을 덮고, 전리품 100곳 이상(희귀 약 4분의 1)·시작 24곳 이상이다', () => {
  const { grid, loot, spawns } = harbortown.br;
  assert.deepEqual([grid.cols, grid.rows, grid.cell], [BR_RULES.GRID, BR_RULES.GRID, 31]);
  assert.deepEqual(harbortown.size, { x: 250, z: 250 });
  assert.deepEqual(grid.origin, [-124, -124]);
  assert.ok(loot.length >= BR_RULES.MIN_LOOT, `전리품 ${loot.length}`);
  const rare = loot.filter((l) => l.tier === 'rare').length / loot.length;
  assert.ok(rare >= 0.2 && rare <= 0.3, `희귀 비율 ${rare}`);
  assert.ok(spawns.length >= BR_RULES.MIN_SPAWNS, `시작 자리 ${spawns.length}`);
  assert.equal(report.br.loot, loot.length);
  assert.ok(report.br.minGap >= 10, `가장 가까운 시작 자리 ${report.br.minGap} m`);
  // 희귀는 가운데 네 칸(D~E 4~5)과 높은 곳에 몰려 있다: 절반 넘게가 가운데 62 m 안이거나 바닥보다 2 m 넘게 높다
  const central = loot.filter((l) => l.tier === 'rare' && ((Math.abs(l.pos[0]) <= 62 && Math.abs(l.pos[2]) <= 62) || l.pos[1] > 2));
  assert.ok(central.length / loot.filter((l) => l.tier === 'rare').length > 0.5);
  // 시작 자리는 네 사분면에 고르게 흩어진다
  const quads = [0, 0, 0, 0];
  for (const [x, , z] of spawns) quads[(x >= 0 ? 1 : 0) + (z >= 0 ? 2 : 0)]++;
  for (const n of quads) assert.ok(n >= 5, `사분면 ${quads}`);
});

test('맵 목록: 배틀로얄 전용 맵은 배틀로얄 목록에만 나온다', async () => {
  const realWarn = console.warn;
  console.warn = () => {};
  const { MAP_IDS, MAP_LIST, MAP_STATUS, mapsForMode, mapsForRuleset } = await import('../js/maps/index.js').finally(() => { console.warn = realWarn; });
  assert.ok(MAP_IDS.includes('harbortown'));
  assert.equal(MAP_STATUS.harbortown.ok, true, MAP_STATUS.harbortown.error);
  const entry = MAP_LIST.find((m) => m.id === 'harbortown');
  assert.equal(entry.br, true);
  assert.equal(entry.brOnly, true);
  assert.ok(mapsForMode('br').some((m) => m.id === 'harbortown'));
  assert.ok(mapsForMode('br').every((m) => m.br && !m.test));
  for (const rs of ['classic', 'knife', 'sniper']) assert.ok(!mapsForRuleset(rs).some((m) => m.id === 'harbortown'), rs);
  for (const mode of ['team', 'ffa', 'bomb', 'zombie']) assert.ok(!mapsForMode(mode, 'classic').some((m) => m.id === 'harbortown'), mode);
});

/* ---------------- 검사기가 잡는 실수 ---------------- */

/** 60 m 마당과 상자 하나. 격자 칸 7.5 m, 전리품·시작 자리는 BR_RULES 최소 수만큼 바닥에 깐다 */
function yard(over = {}) {
  const loot = [];
  for (let i = 0; i < BR_RULES.MIN_LOOT; i++) loot.push({ pos: [-25 + (i % 10) * 5, 0, -25 + Math.floor(i / 10) * 5], tier: i % 4 ? 'common' : 'rare' });
  const spawns = [];
  for (let i = 0; i < BR_RULES.MIN_SPAWNS; i++) spawns.push([-27.5 + (i % 6) * 11, 0, -27.5 + Math.floor(i / 6) * 18]);
  const data = {
    id: 'br_yard', name: 'br', size: { x: 60, z: 60 }, rulesets: ['classic'], modes: ['br'],
    solids: [{ type: 'box', x: 2.5, y: 0, z: 2.5, w: 2, h: 3, d: 2, mat: 'concrete' }],
    spawns: { owner: [], charterer: [], ffa: [] },
    br: { grid: { origin: [-30, -30], cell: 7.5, cols: 8, rows: 8 }, loot, spawns }
  };
  const p = spawns.map(([x, y, z]) => ({ x, y, z, rotY: 0 }));
  data.spawns = { owner: p.filter((_, i) => i % 2 === 0), charterer: p.filter((_, i) => i % 2), ffa: [] };
  return over.mutate ? (over.mutate(data), data) : data;
}

test('형식 검사: 격자 모양·덮는 범위, 전리품 수·등급·자리, 시작 자리 수를 본다', () => {
  assert.deepEqual(validateMap(yard()).warnings, []);
  const warn = (mutate) => validateMap(yard({ mutate })).warnings.join('\n');
  assert.match(warn((d) => { d.br.grid.cols = 6; }), /br\.grid must be 8x8/);
  assert.match(warn((d) => { d.br.grid.cell = 5; }), /uncovered/);
  assert.match(warn((d) => { d.br.grid.origin = [-60, -60]; d.br.grid.cell = 15; }), /past the map edge/);
  assert.match(warn((d) => { d.br.loot.length = 50; }), /br\.loot: 50 < 100/);
  assert.match(warn((d) => { d.br.loot[3].tier = 'epic'; }), /br\.loot\[3\] tier "epic"/);
  assert.match(warn((d) => { d.br.loot[4].pos = [40, 0, 0]; }), /br\.loot\[4\] is outside/);
  assert.match(warn((d) => { d.br.spawns.length = 10; }), /br\.spawns: 10 < 24/);
  assert.match(warn((d) => { d.modes = ['ffa']; }), /needs 'br' in modes/);
  assert.match(warn((d) => { d.modes = ['royale']; }), /modes: unknown "royale"/);
});

test('바닥·길 검사: 벽 속·공중·갇힌 곳의 전리품을 잡는다', () => {
  assert.deepEqual(checkMap('br_yard', yard()).errors, []);
  const errors = (mutate) => checkMap('br_yard', yard({ mutate })).errors.join('\n');
  // (2.5, 2.5)는 상자 속, 높이 2는 공중, 상자 둘레를 막은 우리 안은 길이 없다
  assert.match(errors((d) => { d.br.loot[0].pos = [2.5, 0, 2.5]; }), /br\.loot\[0\].*(no floor|does not fit)/);
  assert.match(errors((d) => { d.br.loot[1].pos = [-20, 2, -20]; }), /br\.loot\[1\].*no floor at that height/);
  const caged = errors((d) => {
    d.solids.push(
      { type: 'box', x: 20, y: 0, z: 14, w: 8, h: 4, d: 0.4, mat: 'concrete' }, { type: 'box', x: 20, y: 0, z: 22, w: 8, h: 4, d: 0.4, mat: 'concrete' },
      { type: 'box', x: 16, y: 0, z: 18, w: 0.4, h: 4, d: 8, mat: 'concrete' }, { type: 'box', x: 24, y: 0, z: 18, w: 0.4, h: 4, d: 8, mat: 'concrete' });
    d.br.loot[2].pos = [20, 0, 18];
  });
  assert.match(caged, /br\.loot\[2\].*cannot be reached/);
});
