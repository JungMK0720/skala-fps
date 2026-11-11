/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 16인방 시험. 스폰 보조 자리(maps/collision.js crowdSpots)가 벽 너머·벽 속·남의 자리를 고르지 않는지, 경기가 맵 스폰을 다 쓴 뒤에만
 *          보조 자리를 쓰는지, 실제 맵 모두가 팀전 8:8·개인전 16명·폭파 미션 8:8을 겹치지 않게 세우는지, 16명 경기 스냅샷이 메시지 한도 안인지 본다.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CROWD, buildCollision, crowdSpots, missionCrowd } from '../js/maps/collision.js';
import { MAP_IDS, MAPS } from '../js/maps/index.js';
import { createMatch } from '../js/game/match.js';
import { normalizeMission, placeMission, hasMission } from '../js/game/mission.js';
import { findFloor, getGroundY, overlapsCapsule } from '../js/engine/physics.js';
import { PLAYER } from '../js/core/consts.js';
import { byteSize, decodeMatch, encodeMatch } from '../js/game/protocol.js';

const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
/** 같은 층(높이 차가 키보다 작음)에서 가장 가까운 두 자리의 거리 */
function minGap(list) {
  let best = Infinity;
  for (let i = 0; i < list.length; i++) {
    for (let j = 0; j < i; j++) if (Math.abs((list[i].y || 0) - (list[j].y || 0)) < PLAYER.HEIGHT) best = Math.min(best, dist(list[i], list[j]));
  }
  return best;
}
const ids = (n, p = 'p') => Array.from({ length: n }, (_, i) => `${p}${i + 1}`);

describe('보조 자리: crowdSpots', () => {
  // 넓은 마당. 블루 스폰 넷이 z로 2 m 간격, +x를 보고 서 있고, 바로 뒤(−x)에 벽이 있다
  const data = {
    name: 'crowd', size: { x: 40, z: 30 },
    solids: [
      { type: 'box', x: -16.6, y: 0, z: 0, w: 0.4, h: 3, d: 24, mat: 'concrete' },
      { type: 'box', x: -14.2, y: 0, z: 0, w: 0.6, h: 2.5, d: 0.6, mat: 'concrete' }   // 가운데 앞 기둥
    ],
    spawns: {
      owner: [-3, -1, 1, 3].map((z) => ({ x: -15.5, z, rotY: -90 })),
      charterer: [-3, -1, 1, 3].map((z) => ({ x: 15.5, z, rotY: 90 }))
    }
  };
  const col = buildCollision(data);

  test('모자란 만큼 찾고, 벽 뒤·벽 속·기둥·남의 자리는 고르지 않는다', () => {
    const base = col.spawns.owner;
    const extra = col.spawns.extra.owner;
    assert.equal(base.length, 4);
    assert.equal(extra.length, CROWD.TEAM - 4, JSON.stringify(extra));
    for (const p of extra) {
      assert.equal(p.extra, true);
      assert.ok(p.x > -16.4 + PLAYER.RADIUS - 0.05, `벽 뒤가 아니다 ${JSON.stringify(p)}`);
      assert.ok(Math.abs(p.y) < 0.05, '같은 바닥');
      assert.equal(overlapsCapsule(col.world, p.x, p.y, p.z, PLAYER.RADIUS - 0.02, PLAYER.HEIGHT), false, '몸이 걸리지 않는다');
      assert.equal(p.rotY, base[0].rotY, '방향은 원래 스폰 것');
    }
    assert.ok(minGap([...base, ...extra]) >= CROWD.GAP - 1e-9, `서로 ${CROWD.GAP} m 넘게 떨어진다`);
  });

  test('충분하면 만들지 않고, 피할 상자(움직이는 지형의 길) 안은 고르지 않는다', () => {
    assert.deepEqual(crowdSpots(col.world, col.bounds, col.spawns.owner, 4), []);
    const box = { minX: -15, maxX: -10, minY: 0, maxY: 3, minZ: -10, maxZ: 10 };   // 스폰 앞쪽 전체
    const out = crowdSpots(col.world, col.bounds, col.spawns.owner, 8, [box]);
    for (const p of out) assert.ok(p.x + PLAYER.RADIUS <= box.minX + 1e-9, JSON.stringify(p));
  });
});

describe('경기: 보조 자리는 스폰을 다 쓴 뒤에만', () => {
  const S = (x, z) => ({ x, z, rotY: 0, y: 0 });
  const spawns = {
    owner: [S(-20, -4), S(-20, -2), S(-20, 0), S(-20, 2), S(-20, 4)],
    charterer: [S(20, -4), S(20, -2), S(20, 0), S(20, 2), S(20, 4)],
    ffa: [],
    extra: { owner: [S(-22, -1), S(-22, 1), S(-22, 3)], charterer: [S(22, -1), S(22, 1), S(22, 3)], ffa: [] }
  };
  const roundSpawns = (n) => {
    const players = ids(n).map((id, i) => ({ id, team: i % 2 ? 'charterer' : 'owner' }));
    const m = createMatch({ rules: { maxPlayers: 16, maxPerTeam: 8 }, players, spawns, seed: 5 });
    const ev = m.start().find((e) => e.type === 'roundStart');
    return Object.values(ev.spawns);
  };

  test('6명이면 맵 스폰만 쓴다', () => {
    for (const s of roundSpawns(6)) assert.ok(Math.abs(Math.abs(s.x) - 20) < 1e-9, JSON.stringify(s));
  });
  test('16명(8:8)이면 스폰 다섯 곳 + 보조 자리 세 곳에 겹치지 않게 선다', () => {
    const list = roundSpawns(16);
    assert.equal(list.length, 16);
    assert.equal(list.filter((s) => Math.abs(Math.abs(s.x) - 22) < 1e-9).length, 6, '팀마다 보조 자리 셋');
    assert.ok(minGap(list) >= 1.5, `가장 가까운 두 사람 ${minGap(list)} m`);
    assert.ok(list.every((s) => !('extra' in s)), '이벤트에는 보조 표시를 싣지 않는다');
  });
  test('보조 자리도 모자라면 예전처럼 1.2 m씩 옆으로 비켜 세운다', () => {
    const m = createMatch({
      rules: { maxPlayers: 16, maxPerTeam: 8 }, seed: 1,
      players: ids(8).map((id) => ({ id, team: 'owner' })).concat([{ id: 'r', team: 'charterer' }]),
      spawns: { owner: [S(-20, 0)], charterer: [S(20, 0)], extra: { owner: [S(-20, 3)] } }
    });
    const ev = m.start().find((e) => e.type === 'roundStart');
    const blue = ids(8).map((id) => ev.spawns[id]);
    assert.equal(new Set(blue.map((s) => `${s.x},${s.z}`)).size, 8, '같은 자리에 두 사람을 세우지 않는다');
  });
});

describe('실제 맵: 16명이 겹치지 않게 선다', () => {
  for (const id of MAP_IDS) {
    const data = MAPS[id];
    if (!data || data.test) continue;
    test(`${id}: 팀전 8:8 · 개인전 16명${hasMission(data) ? ' · 폭파 미션 8:8' : ''}`, () => {
      const col = buildCollision(data);
      const { spawns } = col;
      for (const team of ['owner', 'charterer']) {
        assert.ok(spawns[team].length + spawns.extra[team].length >= CROWD.TEAM, `${team} ${spawns[team].length}+${spawns.extra[team].length}`);
      }
      const all = [...spawns.owner, ...spawns.charterer, ...spawns.ffa, ...spawns.extra.ffa];
      assert.ok(all.length >= CROWD.FFA, `개인전 후보 ${all.length}`);

      // 팀전 16명: 라운드 시작 자리가 모두 다르고 1 m 넘게 떨어져 있다
      const players = ids(16).map((pid, i) => ({ id: pid, team: i < 8 ? 'owner' : 'charterer' }));
      const team = createMatch({ rules: { maxPlayers: 16, maxPerTeam: 8 }, players, spawns, seed: 7 });
      const rs = team.start().find((e) => e.type === 'roundStart');
      for (const t of ['owner', 'charterer']) {
        const mine = players.filter((p) => p.team === t).map((p) => rs.spawns[p.id]);
        assert.equal(mine.length, 8);
        assert.ok(minGap(mine) >= 1, `${t} 가장 가까운 두 사람 ${minGap(mine)} m`);
      }

      // 개인전 16명: live가 시작될 때 한꺼번에 나와도 서로 1 m 넘게 떨어진다
      const ffa = createMatch({ rules: { mode: 'ffa', loadoutMs: 0, spawnProtectMs: 0, maxPlayers: 16 }, players: ids(16).map((pid) => ({ id: pid })), spawns, seed: 7 });
      ffa.start();
      const out = ffa.tick(1).filter((e) => e.type === 'spawn').map((e) => e.spawn);
      assert.equal(out.length, 16);
      assert.ok(minGap(out) >= 1, `개인전 가장 가까운 두 사람 ${minGap(out)} m`);

      if (!hasMission(data)) return;
      const mission = missionCrowd(placeMission(normalizeMission(data), col.world, findFloor, getGroundY), col.world, col.bounds);
      for (const side of ['attack', 'defense']) assert.ok(mission[side].length + mission.extra[side].length >= CROWD.TEAM, side);
      const bomb = createMatch({ rules: { mode: 'bomb', maxPlayers: 16, maxPerTeam: 8 }, players, spawns, mission, seed: 7, chooseCarrier: (list) => list[0] });
      const brs = bomb.start().find((e) => e.type === 'roundStart');
      for (const t of ['owner', 'charterer']) {
        const mine = players.filter((p) => p.team === t).map((p) => brs.spawns[p.id]);
        assert.equal(mine.filter(Boolean).length, 8);
        assert.ok(minGap(mine) >= 1, `폭파 미션 ${t} 가장 가까운 두 사람 ${minGap(mine)} m`);
      }
    });
  }
});

test('16명·이름 24자(한글) 경기 스냅샷이 메시지 한도 안에서 무손실로 왕복한다', () => {
  const name = (i) => `가나다라마바사아자차카타파하가나다라마바사아자${String.fromCharCode(0xac00 + i)}`.slice(0, 24);
  const players = ids(16).map((id, i) => ({ id, name: name(i), team: i < 8 ? 'owner' : 'charterer' }));
  const m = createMatch({ rules: { maxPlayers: 16, maxPerTeam: 8 }, players, seed: 2 });
  m.start();
  const snap = m.snapshot();
  assert.equal(snap.p.length, 16);
  const msg = encodeMatch(1, { phase: 'loadout', round: 1, score: [0, 0], endsAt: 0, players: [], ...snap });
  const size = byteSize(JSON.stringify(msg));
  assert.ok(size < 8192, `${size} B`);
  const back = decodeMatch(JSON.parse(JSON.stringify(msg)));
  assert.deepEqual(back.snapshot.p, snap.p, '줄이 그대로 돌아온다');

  const ffa = createMatch({ rules: { mode: 'ffa', maxPlayers: 16 }, players: players.map(({ id, name: n }) => ({ id, name: n })), seed: 2 });
  const fs = ffa.snapshot();
  assert.equal(fs.p.length, 16);
  assert.ok(byteSize(JSON.stringify(encodeMatch(2, { phase: 'warmup', players: [], ...fs }))) < 8192);
});
