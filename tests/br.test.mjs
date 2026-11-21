/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 배틀로얄 결정적 규칙을 시험한다. 시드 → 봉쇄 일정(페이즈·마지막 칸·이어진 안전 구역), 페이즈별 피해, 보급품 등급 굴림,
 *          탈락 순서 → 순위, 환경 피해·회복(match), 보급품 항목(drops), 버니합 없는 이동 값, 배틀로얄 보상
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { BR, BR_PHASES, BR_MOVE, buildSchedule, createZone, zoneDps, rollLoot, placements, sectorName, sectorAt, normalizeGrid, brMapData, LOOT_COMMON_GUNS, LOOT_RARE_GUNS } from '../js/game/br/rules.js';
import { getDef } from '../js/weapons/defs.js';
import { createMatch } from '../js/game/match.js';
import { createDrops } from '../js/game/drops.js';
import { MOVE, PLAYER } from '../js/core/consts.js';
import { createWorld, makeBox } from '../js/engine/physics.js';
import { moveQuake } from '../js/engine/movement.js';
import { matchReward } from '../js/account/economy.js';
import tankfarm from '../js/maps/tankfarm.js';

const grid = normalizeGrid({ origin: [-66, -66], cell: 16.5, cols: 8, rows: 8 });
const rc = (i) => [i % 8, Math.floor(i / 8)];

describe('격자', () => {
  test('구역 이름과 좌표', () => {
    assert.equal(sectorName(grid, 0), 'A-1');
    assert.equal(sectorName(grid, 8 * 3 + 1), 'B-4');
    assert.equal(sectorAt(grid, -65, -65), 0);
    assert.equal(sectorAt(grid, 65.9, 65.9), 63);
    assert.equal(sectorAt(grid, 70, 0), -1);
  });
});

describe('봉쇄 일정', () => {
  test('같은 시드는 같은 일정, 다른 시드는 대개 다른 일정', () => {
    assert.deepEqual(buildSchedule({ seed: 7, grid }), buildSchedule({ seed: 7, grid }));
    const finals = new Set([1, 2, 3, 4, 5, 6, 7, 8].map((seed) => buildSchedule({ seed, grid }).final));
    assert.ok(finals.size > 1);
  });

  for (const seed of [1, 42, 999, 123456]) {
    test(`시드 ${seed}: 5페이즈, 안전 구역은 이어진 정사각형이고 줄어들며 마지막 칸으로 모인다`, () => {
      const cand = [9, 10, 27, 36, 50];
      const s = buildSchedule({ seed, grid, candidates: cand });
      assert.equal(s.phases.length, BR_PHASES);
      assert.ok(cand.includes(s.final));
      let prev = new Set(Array.from({ length: 64 }, (_, i) => i));
      let t = 0;
      s.phases.forEach((p, k) => {
        assert.equal(p.safe.length, BR.sizes[k] ** 2);
        assert.ok(p.safe.includes(s.final), '마지막 칸은 늘 안전');
        for (const i of p.safe) assert.ok(prev.has(i), '안전 구역은 앞 안전 구역 안');
        const cs = p.safe.map((i) => rc(i)[0]), rs = p.safe.map((i) => rc(i)[1]);
        assert.equal(Math.max(...cs) - Math.min(...cs) + 1, BR.sizes[k]);
        assert.equal(Math.max(...rs) - Math.min(...rs) + 1, BR.sizes[k]);
        assert.equal(p.closes.length + p.safe.length, prev.size);
        assert.ok(p.announceAt >= t && p.closeAt - p.announceAt === BR.warnMs);
        t = p.closeAt;
        prev = new Set(p.safe);
      });
      assert.deepEqual(s.phases[BR_PHASES - 1].safe, [s.final]);
      assert.equal(s.phases[0].announceAt, BR.freeMs);
      assert.ok(s.overtimeAt > s.phases[BR_PHASES - 1].closeAt);
    });
  }

  test('createZone: 예고 → 봉쇄 → 전면 봉쇄를 시각 순서대로', () => {
    const s = buildSchedule({ seed: 3, grid });
    const z = createZone(s);
    assert.deepEqual(z.advance(BR.freeMs - 1), []);
    const a = z.advance(BR.freeMs);
    assert.equal(a[0].type, 'announce');
    assert.equal(z.closing.reduce((x, y) => x + y, 0), s.phases[0].closes.length);
    assert.equal(z.dps, 0);
    z.advance(s.phases[0].closeAt);
    assert.equal(z.phase, 1);
    assert.equal(z.dps, BR.dps[0]);
    for (const i of s.phases[0].closes) assert.ok(z.isClosed(i));
    assert.ok(!z.isClosed(s.final));
    const rest = z.advance(s.overtimeAt);
    assert.equal(rest[rest.length - 1].type, 'overtime');
    assert.ok(z.overtime && z.isClosed(s.final));
  });

  test('페이즈별 피해는 커진다', () => {
    assert.equal(zoneDps(0), 0);
    const list = [1, 2, 3, 4, 5].map(zoneDps);
    assert.deepEqual(list, [2, 4, 8, 14, 25]);
    for (let i = 1; i < list.length; i++) assert.ok(list[i] > list[i - 1]);
    assert.equal(zoneDps(6), BR.overtimeDps);
  });
});

describe('보급품', () => {
  const pts = Array.from({ length: 400 }, (_, i) => ({ pos: [i, 0, 0], tier: i % 2 ? 'rare' : 'common' }));
  test('같은 시드는 같은 굴림이고 등급 표의 총만 나온다', () => {
    assert.deepEqual(rollLoot(5, pts), rollLoot(5, pts));
    const items = rollLoot(5, pts);
    assert.equal(items.length, 400);
    for (const it of items) {
      if (it.kind !== 'gun') { assert.equal(it.weaponId, null); continue; }
      const list = it.tier === 'rare' ? LOOT_RARE_GUNS : LOOT_COMMON_GUNS;
      assert.ok(list.includes(it.weaponId), it.weaponId);
      const d = getDef(it.weaponId);
      assert.ok(!d.zombieOnly && !d.cardOnly);
    }
    const rare = items.filter((x) => x.tier === 'rare'), common = items.filter((x) => x.tier === 'common');
    const share = (l, k) => l.filter((x) => x.kind === k).length / l.length;
    assert.ok(share(rare, 'gun') > share(common, 'gun'), '희귀 지점은 총이 더 자주');
    assert.ok(share(common, 'ammo') > 0.15 && share(common, 'medkit') > 0.08);
  });
  test('drops: 보급품은 supply 옵션에서만, ttl Infinity면 사라지지 않는다', () => {
    let t = 0;
    const d = createDrops({ now: () => t, max: 300 });
    assert.equal(d.add({ id: 'm1', kind: 'medkit', pos: [0, 0, 0] }).drop, null);
    assert.equal(d.add({ id: 'm1', kind: 'medkit', pos: [0, 0, 0] }, { supply: true, ttl: Infinity }).drop.kind, 'medkit');
    d.add({ id: 'g1', weaponId: 'ar_std', pos: [5, 0, 0], mag: 1, reserve: 0 }, { supply: true, ttl: Infinity });
    t = 1e9;
    assert.deepEqual(d.expire(), []);
    assert.equal(d.size, 2);
  });
});

describe('순위', () => {
  test('늦게 탈락할수록 높고, 같은 시각은 같은 순위, 살아 있으면 1위', () => {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const p = placements(ids, [{ id: 'c', at: 10 }, { id: 'a', at: 20 }, { id: 'd', at: 20 }, { id: 'b', at: 30 }]);
    assert.equal(p.get('e'), 1);
    assert.equal(p.get('b'), 2);
    assert.equal(p.get('a'), 3);
    assert.equal(p.get('d'), 3);
    assert.equal(p.get('c'), 5);
  });
});

describe('경기(match) 환경 피해·회복', () => {
  test('claimHazard는 킬을 주지 않고, heal은 최대 체력까지', () => {
    const m = createMatch({ rules: { mode: 'ffa', killTarget: 50, loadoutMs: 0, spawnProtectMs: 0 }, players: [{ id: 'a' }, { id: 'b', bot: true }] });
    m.start();
    m.tick(10);
    let ev = m.claimHazard('a', 30, 'zone');
    assert.equal(ev[0].type, 'damage');
    assert.equal(ev[0].cause, 'zone');
    assert.equal(ev[0].hp, 70);
    ev = m.heal('a', 50);
    assert.deepEqual(ev, [{ type: 'heal', id: 'a', amount: 30, hp: 100 }]);
    assert.deepEqual(m.heal('a', 5), []);
    ev = m.claimHazard('a', 200, 'zone');
    const kill = ev.find((e) => e.type === 'kill');
    assert.ok(kill && kill.killer === 'a' && kill.cause === 'zone');
    assert.equal(m.state.players.find((p) => p.id === 'a').kills, 0);
    // 탈락자를 빼면 한 명 남은 사람이 우승
    const out = m.removePlayer('a');
    const end = out.find((e) => e.type === 'matchEnd');
    assert.equal(end.winner, 'b');
  });
});

describe('이동: 배틀로얄은 버니합이 이어지지 않는다', () => {
  const floor = createWorld([makeBox(-3000, -1, -3000, 3000, 0, 3000)]);
  /** Space를 누른 채 앞으로 가며 마우스로 좌우 스트레이프(공중 가속 최대) 8초 → 최고 수평 속력 */
  function hop(move) {
    const body = { pos: [0, 0, 0], vel: [0, 0, 0], onGround: true };
    let yaw = 0, best = 0;
    const dt = 1 / 60;
    for (let i = 0; i < 8 * 60; i++) {
      const s = Math.floor(i / 30) % 2 ? 1 : -1;
      yaw += s * 0.05;
      const sy = Math.sin(yaw), cy = Math.cos(yaw);
      const wish = { dirX: cy * s, dirZ: -sy * s, speed: PLAYER.WALK, jump: true, strafeSign: s };
      moveQuake(floor, body, wish, dt, { move });
      best = Math.max(best, Math.hypot(body.vel[0], body.vel[2]));
    }
    return best;
  }
  test('개인전 값으로는 걷기보다 빨라지고, 배틀로얄 값은 걷기 근처에서 막힌다', () => {
    const ffa = hop(MOVE), br = hop(BR_MOVE);
    assert.ok(ffa > PLAYER.WALK + 1, `ffa ${ffa}`);
    assert.ok(br <= BR_MOVE.MAX_SPEED + 1e-6, `br ${br}`);
    assert.ok(BR_MOVE.MAX_SPEED < PLAYER.WALK + 1);
  });
});

describe('맵·보상', () => {
  test('탱크 팜 br 칸: 격자 안 보급 100곳 이상, 출발 24곳 이상', () => {
    const b = brMapData(tankfarm);
    assert.ok(b);
    assert.ok(b.loot.length >= 100);
    assert.ok(b.spawns.length >= 24);
  });
  test('배틀로얄 보상: 우승·상위 3위', () => {
    const win = matchReward({ mode: 'br', win: true, placement: 1, players: 12, kills: 2 });
    assert.ok(win.breakdown.some((r) => r.label === '최후의 1인'));
    const third = matchReward({ mode: 'br', placement: 3, players: 12 });
    assert.ok(third.breakdown.some((r) => r.label === '상위 3위'));
    const ninth = matchReward({ mode: 'br', placement: 9, players: 12 });
    assert.ok(!ninth.breakdown.some((r) => /상위/.test(r.label)));
  });
});
