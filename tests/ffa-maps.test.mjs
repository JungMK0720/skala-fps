/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 좁은 개인전용 맵 넷을 검증한다. 개활지 맵(재개발 공터·초등학교 운동장)은 움직이는 것이 없고 실제로 트여 있는지,
 *          문 맵(코인 노래방·한옥 민박)은 문 여덟이 닫혀 있을 때 시야를 끊고 다가가면 열리는지, 맵 목록에서의 순서와 검사기 통과를 본다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import lot from '../js/maps/lot.js';
import schoolyard from '../js/maps/schoolyard.js';
import karaoke from '../js/maps/karaoke.js';
import hanok from '../js/maps/hanok.js';
import { PLAYER, TICK_DT } from '../js/core/consts.js';
import { lineOfSight, moveCharacter } from '../js/engine/physics.js';
import { normalizeMovers, stepMovers, doorPassable } from '../js/engine/movers.js';
import { buildCollision } from '../js/maps/collision.js';
import { buildNavGrid } from '../js/game/navgrid.js';
import { rotate180, mirrorX } from '../js/maps/kit.js';
import { checkMap } from '../tools/check-maps.mjs';

const OPEN = { lot, schoolyard };
const DOORS = { karaoke, hanok };
const ALL = { ...OPEN, ...DOORS };
const NAMES = {
  lot: ['재개발 공터', 'Vacant Lot', '좁은 맵'], schoolyard: ['초등학교 운동장', 'Schoolyard', '좁은 맵'],
  karaoke: ['코인 노래방', 'Coin Karaoke', '좁은 맵'], hanok: ['한옥 민박', 'Hanok Stay', '좁은 맵']
};
const MAX_SIZE = { lot: [36, 26], schoolyard: [40, 26], karaoke: [32, 17], hanok: [32, 26] };
/** 팀 스폰의 대칭: 공터·노래방·한옥은 180° 돌린 자리, 운동장은 좌우로 뒤집은 자리 */
const TWIN = { lot: rotate180, schoolyard: mirrorX, karaoke: rotate180, hanok: rotate180 };

const reports = new Map();
const report = (id, map) => { if (!reports.has(id)) reports.set(id, checkMap(id, map)); return reports.get(id); };

/**
 * 맵이 얼마나 트여 있는가: 걷기 칸 두 곳을 무작위로(씨앗 고정) 골라 눈높이에서 서로 보이는 비율.
 * 문은 닫힌 자리로 본다. far = 10 m 넘게 떨어진 쌍만 센 비율
 */
function openness(data, pairs = 600) {
  const col = buildCollision(data);
  stepMovers(col.world, 0, null);
  const d = buildNavGrid(data).debug();
  const nodes = [];
  for (let n = 0; n < d.x.length; n++) if (d.good[n]) nodes.push([d.x[n], d.y[n] + PLAYER.EYE, d.z[n]]);
  let seed = 12345, seen = 0, far = 0, farSeen = 0;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < pairs; i++) {
    const a = nodes[Math.floor(rnd() * nodes.length)], b = nodes[Math.floor(rnd() * nodes.length)];
    const vis = lineOfSight(col.world, a, b);
    if (vis) seen++;
    if (Math.hypot(a[0] - b[0], a[2] - b[2]) > 10) { far++; if (vis) farSeen++; }
  }
  return { all: seen / pairs, far: farSeen / Math.max(1, far) };
}

for (const [id, map] of Object.entries(ALL)) {
  test(`${id}: 이름·배지가 맞고, 좁고, 새 맵 규칙으로 검사기를 경고 없이 통과한다`, () => {
    assert.equal(map.id, id);
    assert.deepEqual([map.name, map.nameEn, map.tag], NAMES[id]);
    assert.ok(typeof map.desc === 'string' && map.desc.length > 10);
    assert.ok(map.size.x <= MAX_SIZE[id][0] && map.size.z <= MAX_SIZE[id][1], `size ${JSON.stringify(map.size)}`);
    assert.deepEqual(map.rulesets, ['classic', 'knife']);
    assert.equal(map.mission, undefined);
    const r = report(id, map);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.warnings, []);
    assert.equal(r.strict, true);
    assert.equal(r.los, 0, '적 스폰이 서로 보이지 않는다');
  });

  test(`${id}: 개인전 스폰 여덟 곳은 서로 5 m 넘게 떨어져 있거나 서로 보이지 않고, 팀 스폰은 대칭이다`, () => {
    const col = buildCollision(map);
    stepMovers(col.world, 0, null);                    // 문은 닫힌 자리
    const ffa = col.spawns.ffa;
    assert.equal(ffa.length, 8);
    const eye = (p) => [p.x, p.y + PLAYER.EYE, p.z];
    for (let i = 0; i < ffa.length; i++) {
      for (let j = 0; j < i; j++) {
        const gap = Math.hypot(ffa[i].x - ffa[j].x, ffa[i].z - ffa[j].z);
        assert.ok(gap > 2.5, `ffa[${i}] and ffa[${j}] are ${gap.toFixed(1)} m apart`);
        assert.ok(gap > 5 || !lineOfSight(col.world, eye(ffa[i]), eye(ffa[j])), `ffa[${i}] and ffa[${j}] are ${gap.toFixed(1)} m apart and see each other`);
      }
    }
    assert.equal(map.spawns.owner.length, 8, '16명 방의 한 팀이 모두 제 스폰에 선다');
    const team = col.spawns.owner;
    for (let i = 1; i < team.length; i++) assert.ok(Math.hypot(team[i].x - team[i - 1].x, team[i].z - team[i - 1].z) >= 1.2, `owner[${i}]`);
    // 개인전은 팀 스폰까지 후보로 쓸 수 있다(16명 방). 개인전 스폰이 팀 스폰과 붙어 있으면 안 된다
    for (const f of ffa) for (const s of [...col.spawns.owner, ...col.spawns.charterer]) assert.ok(Math.hypot(f.x - s.x, f.z - s.z) > 1.5, `ffa (${f.x}, ${f.z}) is next to a team spawn`);
    const flat = (p) => ({ x: p.x, z: p.z });
    assert.deepEqual(map.spawns.charterer.map(flat), TWIN[id](map.spawns.owner).map(flat));
  });
}

/* ---------------- 개활지 맵 ---------------- */

for (const [id, map] of Object.entries(OPEN)) {
  test(`${id}: 움직이는 것이 없고(발판·포털·움직이는 지형 없음) 실제로 트여 있다`, () => {
    assert.equal((map.movers || []).length, 0);
    assert.equal((map.pads || []).length, 0);
    assert.equal((map.portals || []).length, 0);
    const o = openness(map);
    // 기존 좁은 맵(근접전 훈련장·택배 분류 센터)은 전체 0.13~0.15, 먼 쌍 0.04~0.07이다
    assert.ok(o.all >= 0.35, `걷기 칸 쌍이 서로 보이는 비율 ${o.all.toFixed(3)}`);
    assert.ok(o.far >= 0.25, `10 m 넘게 떨어진 쌍이 서로 보이는 비율 ${o.far.toFixed(3)}`);
  });
}

test('재개발 공터: 가운데 흙더미는 비탈로 오르고, 덤프트럭 짐칸이 비밀 스팟이다', () => {
  const col = buildCollision(lot);
  // 서쪽 비탈 아래에서 동쪽으로 걸으면 흙더미 꼭대기(1 m)에 선다
  const body = { pos: [-6.2, 0, 0], vel: [0, 0, 0], onGround: true };
  for (let i = 0; i < 70; i++) moveCharacter(col.world, body, { x: PLAYER.WALK, z: 0 }, TICK_DT);
  assert.ok(Math.abs(body.pos[1] - 1) < 0.02 && body.pos[0] > -2.2, `흙더미 위: ${body.pos}`);
  assert.deepEqual(lot.secrets.map((s) => s.id), ['lot_truck_bed']);
  assert.deepEqual(report('lot', lot).secrets, [{ id: 'lot_truck_bed', via: 'jump x1' }]);
});

test('초등학교 운동장: 구령대는 계단으로, 스탠드는 걸어서 오른다', () => {
  const col = buildCollision(schoolyard);
  const stage = { pos: [-7, 0, -11.4], vel: [0, 0, 0], onGround: true };
  for (let i = 0; i < 60; i++) moveCharacter(col.world, stage, { x: PLAYER.WALK, z: 0 }, TICK_DT);
  assert.ok(Math.abs(stage.pos[1] - 1) < 0.02 && stage.pos[0] > -4, `구령대 위: ${stage.pos}`);
  const stand = { pos: [0, 0, 8.5], vel: [0, 0, 0], onGround: true };
  for (let i = 0; i < 60; i++) moveCharacter(col.world, stand, { x: 0, z: PLAYER.WALK }, TICK_DT);
  assert.ok(Math.abs(stand.pos[1] - 1.2) < 0.02, `스탠드 맨 윗단: ${stand.pos}`);
});

/* ---------------- 문 맵 ---------------- */

// 문마다: 닫혔을 때 서로 보이지 않아야 하는 두 자리(눈높이)와, 그 문을 여는 사람이 설 자리
const DOOR_CASES = {
  karaoke: [
    { id: 'door_1', a: [-6, 1.6, -6.6], b: [-6, 1.6, -3], opener: [-6, 0, -6] },
    { id: 'door_1w', a: [-10.5, 1.6, -2.5], b: [-6.5, 1.6, -2.5], opener: [-10, 0, -2.5] },
    { id: 'door_5', a: [1.5, 1.6, 6.6], b: [1.5, 1.6, 3], opener: [1.5, 0, 4] }
  ],
  hanok: [
    { id: 'door_hall_n', a: [-2, 1.6, -1.5], b: [-2, 1.9, -6.5], opener: [-2, 0, -3.2] },
    { id: 'door_room_w', a: [-3, 1.6, 1.5], b: [-8.5, 1.9, 1.5], opener: [-6.6, 0.3, 1.5] },
    { id: 'door_back_nw', a: [-9.25, 1.6, -11.5], b: [-9.25, 1.9, -7.5], opener: [-9.25, 0, -10.9] },
    { id: 'door_back_ne', a: [14.3, 1.6, -7], b: [10, 1.9, -7], opener: [13.9, 0, -7] }
  ]
};

for (const [id, map] of Object.entries(DOORS)) {
  test(`${id}: 문 여덟이 모두 옆으로 열리는 문이고 180° 돌린 짝이 있다. 닫혀 있을 때는 맵이 막혀 있다`, () => {
    const movers = normalizeMovers(map.movers);
    assert.equal(movers.length, 8);
    assert.equal((map.movers || []).length, 8, '버려지는 항목이 없다');
    assert.equal(new Set(movers.map((m) => m.id)).size, 8, '문 이름이 겹치지 않는다');
    for (const m of movers) {
      assert.ok(m.door, `${m.id}는 문이다`);
      assert.ok(m.axis === 'x' || m.axis === 'z', `${m.id}는 옆으로 연다`);
      assert.ok(doorPassable(m), `${m.id}가 다 열리면 지나갈 수 있다`);
      assert.ok(m.door.range <= 2 && m.door.open <= 0.3, `${m.id}: 가까이 와야 열리고 빨리 열린다`);
      const twin = movers.find((o) => o !== m && o.axis === m.axis && Math.abs(o.x + m.x) < 1e-6 && Math.abs(o.z + m.z) < 1e-6 && Math.abs(o.dist + m.dist) < 1e-6);
      assert.ok(twin, `${m.id}의 짝`);
    }
    assert.deepEqual(report(id, map).movers.map((m) => m.id).sort(), movers.map((m) => m.id).sort());
    const o = openness(map);
    assert.ok(o.all <= 0.2 && o.far <= 0.1, `문이 닫힌 맵의 트인 정도 ${o.all.toFixed(3)} / ${o.far.toFixed(3)}`);
  });

  test(`${id}: 닫힌 문은 시야를 끊고, 사람이 다가가면 그 문만 열린다`, () => {
    const col = buildCollision(map);
    const byId = new Map(col.movers.list.map((m) => [m.spec.id, m]));
    stepMovers(col.world, 0, null);
    for (const c of DOOR_CASES[id]) {
      assert.ok(byId.has(c.id), c.id);
      assert.equal(lineOfSight(col.world, c.a, c.b), false, `${c.id}: 닫혀 있으면 보이지 않는다`);
    }
    let t = 0;
    for (const c of DOOR_CASES[id]) {
      for (let i = 0; i < 30; i++) { t += TICK_DT; stepMovers(col.world, t, [c.opener]); }
      assert.equal(byId.get(c.id).open, 1, `${c.id}: 다가가면 0.5초 안에 다 열린다`);
      assert.equal(lineOfSight(col.world, c.a, c.b), true, `${c.id}: 열리면 보인다`);
      const others = col.movers.list.filter((m) => m.spec.id !== c.id && m.open > 0).map((m) => m.spec.id);
      assert.deepEqual(others, [], `${c.id}를 열 때 다른 문은 닫혀 있다`);
      for (let i = 0; i < 120; i++) { t += TICK_DT; stepMovers(col.world, t, []); }
      assert.equal(byId.get(c.id).open, 0, `${c.id}: 아무도 없으면 닫힌다`);
    }
  });

  test(`${id}: 스폰한 자리에서는 어느 문도 열리지 않는다`, () => {
    const col = buildCollision(map);
    const all = [...col.spawns.owner, ...col.spawns.charterer, ...col.spawns.ffa];
    stepMovers(col.world, 0, null);
    let t = 0;
    for (const p of all) {
      for (let i = 0; i < 20; i++) { t += TICK_DT; stepMovers(col.world, t, [[p.x, p.y, p.z]]); }
      const open = col.movers.list.filter((m) => m.open > 0).map((m) => m.spec.id);
      assert.deepEqual(open, [], `스폰 (${p.x}, ${p.z})에서 열리는 문`);
    }
  });
}

test('코인 노래방: 복도 바깥 벽 쪽으로 걸으면 방문 앞을 지나도 문이 열리지 않는다', () => {
  const col = buildCollision(karaoke);
  stepMovers(col.world, 0, null);
  let t = 0;
  // 북쪽 복도(z -8.1 ~ -5.15)를 바깥 벽에서 0.7 m 떨어져 서쪽 끝에서 동쪽 끝까지 걷는다
  for (let x = -11; x <= 11; x += PLAYER.WALK * TICK_DT) {
    t += TICK_DT;
    stepMovers(col.world, t, [[x, 0, -7.4]]);
    assert.deepEqual(col.movers.list.filter((m) => m.open > 0).map((m) => m.spec.id), [], `x ${x.toFixed(1)}`);
  }
});

test('한옥 민박: 마당과 뒤안길은 방을 거쳐야만 이어진다', () => {
  // 문이 닫힌 채로는(문을 벽으로 치면) 마당에서 뒤안길로 가는 길이 없고, 문을 빼면(길 찾기가 보는 맵) 길이 있다
  const nav = buildNavGrid(hanok);
  const yard = { x: 0, y: 0, z: 2.3 }, alley = { x: -14.3, y: 0, z: 0 };
  assert.ok(nav.findPath(yard, alley), '문을 지나면 마당에서 서쪽 뒤안길까지 간다');
  const sealed = { ...hanok, movers: [], solids: [...hanok.solids, ...hanok.movers.map((m) => ({ type: 'box', x: m.x, y: m.y, z: m.z, w: m.w, h: m.h, d: m.d, mat: 'wood' }))] };
  assert.equal(buildNavGrid(sealed).findPath(yard, alley), null, '문 말고는 마당에서 나가는 길이 없다');
});

/* ---------------- 맵 목록 ---------------- */

test('맵 목록: 새 좁은 맵 넷은 택배 분류 센터 뒤에 오고, 규칙별 기본 맵은 그대로다', async () => {
  const realWarn = console.warn;
  console.warn = () => {};
  const { MAP_IDS, MAP_LIST, MAP_STATUS, mapsForMode, mapsForRuleset } = await import('../js/maps/index.js').finally(() => { console.warn = realWarn; });
  for (const id of Object.keys(ALL)) {
    assert.ok(MAP_IDS.includes(id), id);
    assert.equal(MAP_STATUS[id].ok, true, `${id}: ${MAP_STATUS[id].error}`);
    const entry = MAP_LIST.find((m) => m.id === id);
    assert.deepEqual([entry.name, entry.nameEn, entry.tag], NAMES[id]);
    assert.equal(entry.fallback, false);
    assert.equal(entry.mission, false);
  }
  const ids = (r) => mapsForRuleset(r).map((m) => m.id);
  assert.deepEqual(ids('classic').slice(0, 7), ['alley', 'cqb', 'sorthub', 'lot', 'schoolyard', 'karaoke', 'hanok']);
  assert.deepEqual(ids('knife').slice(0, 9), ['rooftop', 'glasshouse', 'alley', 'cqb', 'sorthub', 'lot', 'schoolyard', 'karaoke', 'hanok']);
  for (const id of Object.keys(ALL)) {
    assert.ok(!ids('sniper').includes(id), `${id}는 스나전에 나오지 않는다`);
    assert.ok(!mapsForMode('bomb', 'classic').some((m) => m.id === id), `${id}는 폭파 미션에 나오지 않는다`);
    assert.ok(mapsForMode('ffa', 'classic').some((m) => m.id === id) && mapsForMode('team', 'knife').some((m) => m.id === id));
  }
});
