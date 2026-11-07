/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 전투 규칙 시험. 다섯 부위 히트박스(physics.raycastPlayers)와 createMatch를 거치는 판정을 검사한다:
 *          라이플 헤드 1발, 저격 반샷, 산탄 count, 점사 연사 검사, 규칙(칼전·스나전), 경기 끝까지 진행.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { HITBOX, HITBOX_CROUCH } from '../js/core/consts.js';
import { createWorld, makeBox, raycastPlayers, traceShot } from '../js/engine/physics.js';
import {
  WEAPONS, WEAPON_IDS, PRIMARY_IDS, MELEE_IDS, SECONDARY_IDS, computeDamage, isHalfShot, minShotInterval
} from '../js/weapons/defs.js';
import { createArsenal } from '../js/weapons/logic.js';
import { RULESET_IDS, pickableWeapons, defaultPick, isWeaponAllowed } from '../js/game/modes.js';
import {
  createMatch, applySnapshot, standings, normalizeWeaponId, damageFor, rulesFromDefs, WEAPON_RULES,
  DEFAULT_LOADOUT, DEFAULT_RULES, TEAM_IDS, PRIMARY_IDS as MATCH_PRIMARY_IDS, PARTS
} from '../js/game/match.js';
import { restoreMatch, restoreFfaMatch } from '../js/game/session.js';

/* ============================================================ 도우미 */

/** 대상 로컬 좌표 → 월드 좌표(rotation.y = yaw) */
function toWorld(target, [x, y, z]) {
  const yaw = target.yaw || 0, c = Math.cos(yaw), s = Math.sin(yaw);
  return [target.pos[0] + x * c + z * s, target.pos[1] + y, target.pos[2] - x * s + z * c];
}
function dirToWorld(target, [x, y, z]) {
  const yaw = target.yaw || 0, c = Math.cos(yaw), s = Math.sin(yaw);
  return [x * c + z * s, y, -x * s + z * c];
}
/** 대상 로컬의 point를 향해 로컬 방향 from(단위 벡터) 쪽 5 m 밖에서 쏜다 */
function shootLocal(target, point, from, targets = [target]) {
  const start = toWorld(target, [point[0] + from[0] * 5, point[1] + from[1] * 5, point[2] + from[2] * 5]);
  return raycastPlayers(start, dirToWorld(target, [-from[0], -from[1], -from[2]]), 100, targets);
}
const FROM_FRONT = [0, 0, -1];   // 로컬 -Z가 정면
const FROM_BACK = [0, 0, 1];
const FROM_RIGHT = [1, 0, 0];
const FROM_LEFT = [-1, 0, 0];

const lerp = (a, b, k) => a + (b - a) * k;
const crouchK = (v) => (v === true ? 1 : +v || 0);
/** 앉음 비율에 맞춘 부위 치수(physics와 같은 섞기). 수치를 고쳐도 시험이 따라가게 상수에서 계산한다 */
function volumes(crouch) {
  const k = crouchK(crouch);
  const S = HITBOX, C = HITBOX_CROUCH;
  return {
    head: { y: lerp(S.HEAD.y, C.HEAD.y, k), r: lerp(S.HEAD.r, C.HEAD.r, k) },
    body: { y0: lerp(S.BODY.y0, C.BODY.y0, k), y1: lerp(S.BODY.y1, C.BODY.y1, k), hw: S.BODY.hw, hd: S.BODY.hd },
    legs: { y0: lerp(S.LEGS.y0, C.LEGS.y0, k), y1: lerp(S.LEGS.y1, C.LEGS.y1, k), hw: S.LEGS.hw, hd: S.LEGS.hd },
    foot: { y0: lerp(S.FOOT.y0, C.FOOT.y0, k), y1: lerp(S.FOOT.y1, C.FOOT.y1, k), hw: S.FOOT.hw, hd: S.FOOT.hd, cz: S.FOOT.cz },
    hands: S.HANDS.map((h, i) => ({
      x: lerp(h.x, C.HANDS[i].x, k), y: lerp(h.y, C.HANDS[i].y, k), z: lerp(h.z, C.HANDS[i].z, k), r: lerp(h.r, C.HANDS[i].r, k)
    }))
  };
}

const T0 = 1000000;  // 주장 시각 기준(ms). 1e4보다 크면 match가 ms로 읽는다

/** 양 팀 1명(a: owner, b: charterer)을 live까지 진행한 팀전 */
function liveDuel(rules = {}) {
  const m = createMatch({
    rules: { loadoutMs: 0, ...rules },
    players: [{ id: 'a', name: '갑', team: 'owner' }, { id: 'b', name: '을', team: 'charterer' }],
    seed: 1
  });
  m.start();
  m.tick(1);
  assert.equal(m.state.phase, 'live');
  return m;
}
/** 부활 보호를 끈 FFA를 live까지. 스폰 이벤트까지 돌려준다 */
function liveFfa(ids, rules = {}) {
  const m = createMatch({
    rules: { mode: 'ffa', loadoutMs: 0, spawnProtectMs: 0, respawnMs: 100, ...rules },
    players: ids.map((id) => ({ id, name: id })),
    seed: 2
  });
  m.start();
  const spawned = m.tick(1);
  assert.equal(m.state.phase, 'live');
  return { m, spawned };
}
const claim = (o) => ({ attackerId: 'a', victimId: 'b', dist: 10, t: T0, ...o });
const only = (evs, type) => evs.filter((e) => e.type === type);
const firstOf = (evs, type) => evs.find((e) => e.type === type);
const rejectReason = (evs) => (firstOf(evs, 'reject') || {}).reason;
const playerOf = (m, id) => m.state.players.find((p) => p.id === id);

/* ============================================================ A. 다섯 부위 히트박스 */

describe('raycastPlayers: 다섯 부위', () => {
  const YAWS = [0, Math.PI / 2, -Math.PI / 3, 2.5, Math.PI, -0.4];
  const POSES = [
    { name: '서 있음', crouch: false },
    { name: '앉음', crouch: true },
    { name: '앉는 중', crouch: 0.5 }
  ];
  // 시작점이 대상의 어느 위치여도 같아야 한다
  const place = (yaw, crouch) => ({ id: 'v', pos: [12.5, 3, -7.25], yaw, crouch });

  for (const { name, crouch } of POSES) {
    const V = volumes(crouch);
    const bodyMid = (V.body.y0 + V.body.y1) / 2;
    const legsMid = (V.legs.y0 + V.legs.y1) / 2;
    const footMid = (V.foot.y0 + V.foot.y1) / 2;

    test(`${name}: 앞·옆·뒤에서 각 부위를 맞힌다`, () => {
      for (const yaw of YAWS) {
        const t = place(yaw, crouch);
        const expect = (part, point, from) => {
          const res = shootLocal(t, point, from);
          assert.ok(res, `${part} yaw ${yaw}: 안 맞음`);
          assert.equal(res.part, part, `yaw ${yaw} from ${from}`);
          assert.equal(res.id, 'v');
        };
        for (const from of [FROM_FRONT, FROM_BACK, FROM_LEFT, FROM_RIGHT]) {
          expect('head', [0, V.head.y, 0], from);
          expect('legs', [0, legsMid, 0], from);
          expect('foot', [0, footMid, V.foot.cz], from);
        }
        // 가슴 앞에 총을 쥔 손이 있어도 정면의 가슴 사격은 몸통이다
        for (const from of [FROM_FRONT, FROM_BACK, FROM_LEFT, FROM_RIGHT]) expect('body', [0, bodyMid, 0], from);
      }
    });

    test(`${name}: 손은 옆에서만 손이다. 앞뒤에서는 뒤에 있는 몸통으로 친다`, () => {
      for (const yaw of YAWS) {
        const t = place(yaw, crouch);
        for (const h of V.hands) {
          for (const from of [FROM_LEFT, FROM_RIGHT]) {
            const res = shootLocal(t, [h.x, h.y, h.z], from);
            assert.ok(res, `hand yaw ${yaw}: 안 맞음`);
            assert.equal(res.part, 'hand', `yaw ${yaw} from ${from}`);
          }
          for (const from of [FROM_FRONT, FROM_BACK]) {
            const res = shootLocal(t, [h.x, h.y, h.z], from);
            assert.equal(res.part, 'body', `yaw ${yaw} from ${from}`);
          }
        }
      }
    });

    test(`${name}: 손과 몸통 사이의 빈 공간은 빗나간다`, () => {
      for (const yaw of YAWS) {
        const t = place(yaw, crouch);
        const hand = V.hands.reduce((best, h) => (h.z + h.r > best.z + best.r ? h : best));
        const gapZ = (-V.body.hd + (hand.z + hand.r)) / 2;   // 몸통 앞면과 가까운 손 뒷면의 가운데
        assert.ok(gapZ > hand.z + hand.r && gapZ < -V.body.hd, '시험 전제: 손과 몸통 사이에 틈이 있다');
        for (const from of [FROM_LEFT, FROM_RIGHT]) {
          assert.equal(shootLocal(t, [0, hand.y, gapZ], from), null, `yaw ${yaw}`);
        }
      }
    });
  }

  test('머리가 가장 가까우면 머리가 이긴다: 위에서 내려 쏘면 머리 → 몸 순서', () => {
    for (const yaw of YAWS) {
      const t = place(yaw, false);
      const V = volumes(false);
      const down = [0, 0.8, -0.6];                      // 앞 위에서 비스듬히
      const len = Math.hypot(...down);
      const res = shootLocal(t, [0, V.head.y, 0], [down[0] / len, down[1] / len, down[2] / len]);
      assert.equal(res.part, 'head');
      assert.ok(Math.abs(res.dist - (5 - V.head.r)) < 1e-6, `거리 ${res.dist}`);
    }
  });

  test('손을 지나 몸통까지 가는 레이는 몸통이고, 거리도 몸통 앞면까지다', () => {
    const t = place(0.7, false);
    const V = volumes(false);
    const h = V.hands[1];
    const through = shootLocal(t, [h.x, h.y, 0], FROM_FRONT);
    assert.equal(through.part, 'body');
    assert.ok(Math.abs(through.dist - (5 - V.body.hd)) < 1e-6, `몸통 앞면까지의 거리 ${through.dist}`);
  });

  test('몸통 밖으로 나온 손끝만 맞으면 손이고, 벽이 몸을 가려도 손이다', () => {
    const target = { id: 'v', pos: [0, 0, -10], yaw: Math.PI };   // 쏘는 사람을 바라본다
    const V = volumes(false);
    const h = V.hands[0];
    const hw = toWorld(target, [h.x, h.y, h.z]);
    // 표적 바로 앞, 손과 몸통 사이에 있는 얇은 벽
    const between = createWorld([makeBox(-2, 0, -9.7, 2, 3, -9.6, 'steel')]);
    const hit = traceShot(between, [hw[0], hw[1], 0], [0, 0, -1], 100, [target]);
    assert.equal(hit.kind, 'player');
    assert.equal(hit.part, 'hand');
  });

  test('손 뒤의 몸통보다 다른 사람이 가까우면 그 사람이 맞는다', () => {
    const shield = { id: 'near', pos: [0, 0, -5], yaw: Math.PI };
    const back = { id: 'far', pos: [0, 0, -9], yaw: Math.PI };
    const V = volumes(false);
    const h = V.hands[0];
    const hw = toWorld(back, [h.x, h.y, h.z]);
    const res = raycastPlayers([hw[0], hw[1], 0], [0, 0, -1], 100, [back, shield]);
    assert.equal(res.id, 'near');
    assert.equal(res.part, 'body');
  });

  test('발은 cz만큼 앞으로 나와 있어 다리보다 먼저 닿는다', () => {
    const t = place(-1.2, false);
    const V = volumes(false);
    const foot = shootLocal(t, [0, (V.foot.y0 + V.foot.y1) / 2, 0], FROM_FRONT);
    assert.equal(foot.part, 'foot');
    assert.ok(Math.abs(foot.dist - (5 + V.foot.cz - V.foot.hd)) < 1e-6);
    const toe = V.foot.cz - V.foot.hd + 0.005;
    assert.equal(shootLocal(t, [0.1, 0.05, toe - 0.01], FROM_RIGHT), null, '발끝 앞은 빗나간다');
    assert.equal(shootLocal(t, [0.1, 0.05, toe + 0.01], FROM_RIGHT).part, 'foot');
  });

  test('자세 전환 중(crouch 0..1)에는 손과 머리도 비율대로 내려온다', () => {
    const half = volumes(0.5), up = volumes(false), down = volumes(true);
    assert.ok(half.head.y < up.head.y && half.head.y > down.head.y);
    assert.ok(half.hands[0].y < up.hands[0].y && half.hands[0].y > down.hands[0].y);
    const t = place(0.3, 0.5);
    assert.equal(shootLocal(t, [half.hands[0].x, half.hands[0].y, half.hands[0].z], FROM_RIGHT).part, 'hand');
    // 같은 높이여도 서 있는 사람의 손 자리는 앉는 중인 사람에게 비어 있다
    assert.equal(shootLocal(t, [up.hands[0].x, up.hands[0].y, up.hands[0].z], FROM_RIGHT), null);
  });

  test('여러 명이면 더 가까운 사람, 죽은 사람과 ignoreId는 건너뛴다', () => {
    const near = { id: 'near', pos: [0, 0, -5], yaw: 0 };
    const far = { id: 'far', pos: [0, 0, -9], yaw: 0 };
    const eye = [0, 1.25, 0];
    const dir = [-0.02, 0, -1];
    assert.equal(raycastPlayers(eye, dir, 100, [far, near]).id, 'near');
    assert.equal(raycastPlayers(eye, dir, 100, [far, { ...near, alive: false }]).id, 'far');
    assert.equal(raycastPlayers(eye, dir, 100, [far, near], { ignoreId: 'near' }).id, 'far');
    assert.equal(raycastPlayers(eye, dir, 3, [far, near]), null, 'maxDist 밖');
  });

  test('traceShot: 벽이 먼저면 벽, 사람이 먼저면 부위까지 돌려준다', () => {
    const target = { id: 'v', pos: [0, 0, -10], yaw: Math.PI };   // 쏘는 사람을 바라본다
    const V = volumes(false);
    const h = toWorld(target, [V.hands[0].x, V.hands[0].y, V.hands[0].z]);
    const wall = createWorld([makeBox(-2, 0, -6, 2, 3, -5.5, 'steel')]);
    const behind = createWorld([makeBox(-2, 0, -15, 2, 3, -14.5, 'steel')]);
    const eye = [h[0], h[1], 0];
    assert.equal(traceShot(wall, eye, [0, 0, -1], 100, [target]).kind, 'world');
    const hit = traceShot(behind, eye, [0, 0, -1], 100, [target]);
    assert.equal(hit.kind, 'player');
    assert.equal(hit.part, 'body');
    assert.equal(traceShot(null, [50, 1, 0], [0, 0, -1], 30, [target]).kind, 'none');
  });
});

/* ============================================================ C. 무기 표 */

describe('WEAPON_RULES: defs에서 만든다', () => {
  test('모든 무기가 있고, 연사 간격은 minShotInterval이다', () => {
    assert.deepEqual(Object.keys(WEAPON_RULES).sort(), WEAPON_IDS.slice().sort());
    assert.deepEqual(rulesFromDefs(WEAPONS), WEAPON_RULES);
    for (const id of WEAPON_IDS) {
      const r = WEAPON_RULES[id], d = WEAPONS[id];
      assert.equal(r.slot, d.slot);
      assert.equal(r.damage, undefined, '피해 수치는 표에 복제하지 않는다');
      assert.equal(r.oneShotKill, undefined);
      if (d.melee) {
        assert.equal(r.kinds.slash.intervalMs, Math.round(d.melee.slash.cooldown * 1000));
        assert.equal(r.kinds.stab.intervalMs, Math.round(d.melee.stab.cooldown * 1000));
      } else if (d.explosion) {
        assert.equal(r.explosive, true);
        assert.equal(r.maxDamage, d.explosion.max);
      } else {
        assert.ok(Math.abs(r.intervalMs - minShotInterval(id) * 1000) < 1, id);
        assert.equal(r.rangeM, Math.round(d.maxRange * 105) / 100);
        assert.equal(r.pellets, d.pellets);
      }
    }
    assert.equal(WEAPON_RULES.ar_burst.intervalMs, 65, '점사는 점사 안 간격');
    assert.ok(Object.isFrozen(WEAPON_RULES.ar_std));
  });

  test('normalizeWeaponId: 카탈로그 id와 표시 이름을 받고, 뜻이 여럿인 말은 받지 않는다', () => {
    for (const id of WEAPON_IDS) {
      assert.equal(normalizeWeaponId(id), id);
      assert.equal(normalizeWeaponId(id.toUpperCase()), id);
      assert.equal(normalizeWeaponId(WEAPONS[id].short), id);
    }
    assert.equal(normalizeWeaponId('SK-7'), 'sr_bolt');
    assert.equal(normalizeWeaponId('br3'), 'ar_burst');
    assert.equal(normalizeWeaponId('katana'), 'ml_katana');
    for (const bad of ['rifle', 'sniper', 'pistol', 'cutter', '', null, undefined, 'toString', '__proto__', 7, {}]) {
      assert.equal(normalizeWeaponId(bad), null, String(bad));
    }
  });

  test('세션이 쓰는 내보내기가 남아 있다', () => {
    assert.equal(DEFAULT_LOADOUT, 'ar_std');
    assert.equal(DEFAULT_RULES.roundsToWin, 3);
    assert.deepEqual(TEAM_IDS, ['owner', 'charterer']);
    assert.deepEqual(MATCH_PRIMARY_IDS, PRIMARY_IDS);
    assert.deepEqual(PARTS, ['head', 'body', 'legs', 'hand', 'foot']);
  });

  test('damageFor는 computeDamage와 같고 체력에서 자른다', () => {
    assert.equal(damageFor('sr_bolt', 'hand', 300), 50);
    assert.equal(damageFor('sr_bolt', 'head', 300), 100, '체력 100에서 잘린다');
    assert.equal(damageFor('sr_bolt', 'head', 300, undefined, 500), 200);
    assert.equal(damageFor('sg_bx12', 'body', 0, undefined, 100, 3), 42);
    assert.equal(damageFor('ml_katana', null, 0, 'stab', 500), 120);
    assert.equal(damageFor('gr_frag', 'body', 0), 0);
    assert.equal(damageFor('zzz', 'body', 0), 0);
  });
});

/* ============================================================ 소유자 규칙 */

describe('라이플 헤드 1발', () => {
  const RIFLES = PRIMARY_IDS.filter((id) => WEAPONS[id].kind === 'rifle');

  test('머리는 거리 감쇠를 받지 않아 어느 거리든 100 이상이다', () => {
    assert.ok(RIFLES.length >= 4);
    for (const id of RIFLES) {
      for (const dist of [0, 80, 300, 1000]) assert.ok(computeDamage(id, 'head', dist) >= 100, `${id} ${dist} m`);
    }
  });

  test('LN-3로 300 m 머리를 맞히면 죽는다', () => {
    const m = liveDuel();
    const evs = m.claimHit(claim({ weaponId: 'ar_line', part: 'head', dist: 300 }));
    const dmg = firstOf(evs, 'damage'), kill = firstOf(evs, 'kill');
    assert.equal(dmg.amount, 100);
    assert.equal(dmg.head, true);
    assert.equal(dmg.halfShot, false);
    assert.ok(kill);
    assert.equal(kill.head, true);
    assert.equal(kill.part, 'head');
    assert.equal(playerOf(m, 'a').headshots, 1);
  });

  for (const id of RIFLES) {
    test(`${id}: 사거리 끝(${WEAPONS[id].maxRange} m)에서도 머리 1발, 몸은 아니다`, () => {
      const dist = WEAPONS[id].maxRange;
      assert.ok(firstOf(liveDuel().claimHit(claim({ weaponId: id, part: 'head', dist })), 'kill'));
      const m = liveDuel();
      const evs = m.claimHit(claim({ weaponId: id, part: 'body', dist }));
      assert.equal(firstOf(evs, 'kill'), undefined);
      assert.ok(firstOf(evs, 'damage').amount < 100);
    });
  }

  test('사거리를 넘긴 주장은 거절한다', () => {
    const m = liveDuel();
    const evs = m.claimHit(claim({ weaponId: 'ar_std', part: 'head', dist: WEAPONS.ar_std.maxRange * 1.05 + 1 }));
    assert.equal(rejectReason(evs), 'out_of_range');
    assert.equal(playerOf(m, 'b').hp, 100);
  });

  test('다리·손·발은 거리 감쇠를 받는다', () => {
    assert.equal(firstOf(liveDuel().claimHit(claim({ weaponId: 'ar_std', part: 'legs', dist: 10 })), 'damage').amount, 22);
    assert.equal(firstOf(liveDuel().claimHit(claim({ weaponId: 'ar_std', part: 'hand', dist: 10 })), 'damage').amount, 15);
    assert.equal(firstOf(liveDuel().claimHit(claim({ weaponId: 'ar_std', part: 'foot', dist: 200 })), 'damage').amount, 11);
  });
});

describe('저격 반샷', () => {
  const SNIPERS = PRIMARY_IDS.filter((id) => WEAPONS[id].kind === 'sniper');

  for (const id of ['sr_bolt', 'sr_twin', 'sr_heavy']) {
    for (const part of ['hand', 'foot']) {
      test(`${id}: ${part}는 반샷이고 둘째 발에 죽는다`, () => {
        const m = liveDuel();
        const half = WEAPONS[id].damage[part];
        const first = m.claimHit(claim({ weaponId: id, part, dist: 120 }));
        const dmg = firstOf(first, 'damage');
        assert.equal(dmg.amount, half);
        assert.equal(dmg.part, part);
        assert.equal(dmg.halfShot, true);
        assert.equal(dmg.head, false);
        assert.equal(dmg.hp, 100 - half);
        assert.equal(firstOf(first, 'kill'), undefined, '한 발로는 죽지 않는다');
        const later = T0 + minShotInterval(id) * 1000;
        const second = m.claimHit(claim({ weaponId: id, part, dist: 120, t: later, shotId: 2 }));
        const kill = firstOf(second, 'kill');
        assert.ok(kill, '둘째 발에 죽는다');
        assert.equal(kill.halfShot, true);
        assert.equal(kill.head, false);
        assert.equal(playerOf(m, 'a').halfShots, 2);
        assert.equal(playerOf(m, 'a').kills, 1);
      });
    }
    for (const part of ['head', 'body', 'legs']) {
      test(`${id}: ${part}는 1발에 죽고 반샷이 아니다`, () => {
        const m = liveDuel();
        const evs = m.claimHit(claim({ weaponId: id, part, dist: 300 }));
        assert.ok(firstOf(evs, 'kill'));
        assert.equal(firstOf(evs, 'damage').halfShot, false);
        assert.equal(playerOf(m, 'a').halfShots, 0);
      });
    }
  }

  test('S-3 스위프트는 몸·다리로 죽지 않고 머리로 죽는다', () => {
    const body = liveDuel().claimHit(claim({ weaponId: 'sr_swift', part: 'body', dist: 50 }));
    assert.equal(firstOf(body, 'damage').amount, 85);
    assert.equal(firstOf(body, 'kill'), undefined);
    assert.equal(firstOf(body, 'damage').halfShot, false);
    const legs = liveDuel().claimHit(claim({ weaponId: 'sr_swift', part: 'legs', dist: 50 }));
    assert.equal(firstOf(legs, 'damage').amount, 60);
    assert.ok(firstOf(liveDuel().claimHit(claim({ weaponId: 'sr_swift', part: 'head', dist: 50 })), 'kill'));
    const hand = liveDuel().claimHit(claim({ weaponId: 'sr_swift', part: 'hand', dist: 50 }));
    assert.equal(firstOf(hand, 'damage').amount, 40);
    assert.equal(firstOf(hand, 'damage').halfShot, true);
  });

  test('반샷은 저격총만이다: 다른 총의 손·발은 반샷이 아니다', () => {
    for (const id of [...PRIMARY_IDS, ...SECONDARY_IDS]) {
      for (const part of ['hand', 'foot']) assert.equal(isHalfShot(id, part), SNIPERS.includes(id), `${id} ${part}`);
    }
    const evs = liveDuel().claimHit(claim({ weaponId: 'ar_std', part: 'hand' }));
    assert.equal(firstOf(evs, 'damage').halfShot, false);
  });

  test('칼과 수류탄은 부위를 무시한다', () => {
    const slash = firstOf(liveDuel().claimHit(claim({ weaponId: 'ml_katana', part: 'hand', dist: 1, kind: 'slash' })), 'damage');
    assert.equal(slash.amount, 65);
    assert.equal(slash.part, null);
    assert.equal(slash.halfShot, false);
    assert.equal(slash.head, false);
    const m = liveDuel();
    const boom = firstOf(m.claimExplosion({ attackerId: 'a', victims: [{ id: 'b', dmg: 40 }] }), 'damage');
    assert.equal(boom.part, null);
    assert.equal(boom.halfShot, false);
  });
});

describe('산탄 count', () => {
  test('count만큼 곱하고, 부위는 주장 하나에 하나다', () => {
    assert.equal(firstOf(liveDuel().claimHit(claim({ weaponId: 'sg_bx12', part: 'body', dist: 2, count: 3 })), 'damage').amount, 42);
    assert.equal(firstOf(liveDuel().claimHit(claim({ weaponId: 'sg_bx12', part: 'legs', dist: 2, count: 2 })), 'damage').amount, 20);
    const all = liveDuel().claimHit(claim({ weaponId: 'sg_bx12', part: 'body', dist: 2, count: 8 }));
    assert.equal(firstOf(all, 'damage').amount, 100, '112가 체력 100에서 잘린다');
    assert.equal(firstOf(all, 'damage').count, 8);
    assert.ok(firstOf(all, 'kill'));
  });

  test('count는 1..펠릿 수로 자른다', () => {
    const big = liveDuel({ hp: 1000 }).claimHit(claim({ weaponId: 'sg_bx12', part: 'head', dist: 2, count: 99 }));
    assert.equal(firstOf(big, 'damage').amount, 160);
    for (const bad of [0, -3, 'x', null, undefined, NaN]) {
      const one = liveDuel({ hp: 1000 }).claimHit(claim({ weaponId: 'sg_bx12', part: 'head', dist: 2, count: bad }));
      assert.equal(firstOf(one, 'damage').amount, 20, String(bad));
      assert.equal(firstOf(one, 'damage').count, undefined);
    }
    const rifle = liveDuel({ hp: 1000 }).claimHit(claim({ weaponId: 'ar_std', part: 'body', dist: 2, count: 8 }));
    assert.equal(firstOf(rifle, 'damage').amount, 30, '단발 무기는 count가 1이다');
  });

  test('멀면 감쇠한다', () => {
    const near = firstOf(liveDuel({ hp: 1000 }).claimHit(claim({ weaponId: 'sg_bx12', part: 'body', dist: 5, count: 8 })), 'damage').amount;
    const far = firstOf(liveDuel({ hp: 1000 }).claimHit(claim({ weaponId: 'sg_bx12', part: 'body', dist: 30, count: 8 })), 'damage').amount;
    assert.equal(near, 112);
    assert.equal(far, computeDamage('sg_bx12', 'body', 30, undefined, 8));
    assert.ok(far < near / 2);
  });
});

/* ============================================================ 연사 검사 */

describe('연사 검사', () => {
  const hit = (m, o) => m.claimHit(claim({ part: 'body', ...o }));

  test('BR-3 점사 세 발과 다음 점사는 통과한다', () => {
    const m = liveDuel({ hp: 100000 });
    const burst = WEAPONS.ar_burst.burst.gap * 1000, rest = WEAPONS.ar_burst.fireInterval * 1000;
    let t = T0, id = 0;
    for (let b = 0; b < 8; b++) {
      for (let i = 0; i < 3; i++) {
        const evs = hit(m, { weaponId: 'ar_burst', t, shotId: ++id });
        assert.equal(rejectReason(evs), undefined, `점사 ${b} 발 ${i}`);
        t += burst;
      }
      t += rest - burst;
    }
  });

  test('같은 시각의 넷째 BR-3 주장과 너무 빠른 조작은 거절한다', () => {
    const m = liveDuel({ hp: 100000 });
    for (let i = 1; i <= 3; i++) assert.equal(rejectReason(hit(m, { weaponId: 'ar_burst', t: T0, shotId: i })), undefined, `발 ${i}`);
    const fake = hit(m, { weaponId: 'ar_burst', t: T0, shotId: 4 });
    assert.equal(rejectReason(fake), 'too_fast');
    assert.equal(firstOf(fake, 'reject').weaponId, 'ar_burst');
    // 10 ms 간격으로 계속 보내면 곧 막힌다
    const n = liveDuel({ hp: 100000 });
    const verdicts = [];
    for (let i = 0; i < 40; i++) verdicts.push(rejectReason(hit(n, { weaponId: 'ar_burst', t: T0 + i * 10, shotId: i + 1 })));
    assert.ok(verdicts.filter((v) => v === 'too_fast').length > 20, verdicts.join());
  });

  test('거절된 주장은 피해를 주지 않고 기록을 바꾸지 않는다', () => {
    const m = liveDuel();
    hit(m, { weaponId: 'sr_bolt', part: 'hand', t: T0 });
    const hpAfter = playerOf(m, 'b').hp;
    assert.equal(rejectReason(hit(m, { weaponId: 'sr_bolt', part: 'hand', t: T0 + 100, shotId: 9 })), 'too_fast');
    assert.equal(playerOf(m, 'b').hp, hpAfter);
    assert.equal(playerOf(m, 'a').halfShots, 1);
    assert.equal(rejectReason(hit(m, { weaponId: 'sr_bolt', part: 'hand', t: T0 + 1200, shotId: 10 })), undefined);
  });

  test('샷건 한 발이 두 사람을 맞혀도 연사 검사에 걸리지 않는다: shotId', () => {
    const { m } = liveFfa(['a', 'b', 'c'], { hp: 1000 });
    const shot = (victimId, count, t, shotId) => m.claimHit({ attackerId: 'a', victimId, weaponId: 'sg_bx12', part: 'body', dist: 3, count, t, shotId });
    assert.equal(rejectReason(shot('b', 5, T0, 1)), undefined);
    assert.equal(rejectReason(shot('c', 3, T0, 1)), undefined, '같은 발의 다른 사람');
    assert.equal(playerOf(m, 'b').hp, 1000 - 70);
    assert.equal(playerOf(m, 'c').hp, 1000 - 42);
    assert.equal(rejectReason(shot('b', 1, T0 + 1, 2)), 'too_fast', '바로 다음 발');
    assert.equal(rejectReason(shot('b', 1, T0 + 850, 3)), undefined, '간격이 지난 다음 발');
  });

  test('shotId가 없으면 같은 사격 시각을 같은 발로 본다', () => {
    const { m } = liveFfa(['a', 'b', 'c'], { hp: 1000 });
    const shot = (victimId, t) => m.claimHit({ attackerId: 'a', victimId, weaponId: 'sg_bx12', part: 'body', dist: 3, count: 1, t });
    assert.equal(rejectReason(shot('b', T0)), undefined);
    assert.equal(rejectReason(shot('c', T0)), undefined);
    assert.equal(rejectReason(shot('b', T0 + 100)), 'too_fast');
  });

  test('방장 시계(t 생략)도 같은 틱의 산탄 주장을 같은 발로 본다', () => {
    const { m } = liveFfa(['a', 'b', 'c'], { hp: 1000 });
    const shot = (victimId) => m.claimHit({ attackerId: 'a', victimId, weaponId: 'sg_bx12', part: 'body', dist: 3, count: 2 });
    assert.equal(rejectReason(shot('b')), undefined);
    assert.equal(rejectReason(shot('c')), undefined);
    m.tick(100);
    assert.equal(rejectReason(shot('b')), 'too_fast');
    m.tick(1000);
    assert.equal(rejectReason(shot('b')), undefined);
  });

  test('한 발의 펠릿 합은 def.pellets까지다', () => {
    const { m } = liveFfa(['a', 'b', 'c', 'd'], { hp: 1000 });
    const shot = (victimId, count) => m.claimHit({ attackerId: 'a', victimId, weaponId: 'sg_bx12', part: 'body', dist: 3, count, t: T0, shotId: 7 });
    assert.equal(rejectReason(shot('b', 6)), undefined);
    assert.equal(rejectReason(shot('c', 2)), undefined);
    assert.equal(rejectReason(shot('d', 1)), 'too_fast', '펠릿 8발을 다 쓴 발');
    assert.equal(playerOf(m, 'd').hp, 1000);
  });

  test('단발 무기는 같은 shotId를 두 번 받지 않는다', () => {
    const m = liveDuel({ hp: 1000 });
    assert.equal(rejectReason(hit(m, { weaponId: 'ar_std', t: T0, shotId: 5 })), undefined);
    assert.equal(rejectReason(hit(m, { weaponId: 'ar_std', t: T0 + 500, shotId: 5 })), 'too_fast');
    assert.equal(rejectReason(hit(m, { weaponId: 'ar_std', t: T0 + 500, shotId: 6 })), undefined);
  });

  test('shotId 없는 단발 무기는 예전처럼 같은 시각 2발까지 받는다', () => {
    const m = liveDuel({ hp: 1000 });
    assert.equal(rejectReason(hit(m, { weaponId: 'ar_std', t: T0 })), undefined);
    assert.equal(rejectReason(hit(m, { weaponId: 'ar_std', t: T0 })), undefined);
    assert.equal(rejectReason(hit(m, { weaponId: 'ar_std', t: T0 })), 'too_fast');
  });

  test('칼은 직전 공격의 쿨다운을 쓴다: 찌르기 연타는 막고 찌르기→베기 최단 간격은 통과한다', () => {
    for (const id of MELEE_IDS) {
      const { slash, stab } = WEAPONS[id].melee;
      const short = (stab.cooldown + slash.windup - stab.windup) * 1000;   // 강타 판정 → 다음 베기 판정의 최단 간격
      const m = liveDuel({ hp: 1000 });
      const swing = (kind, t) => m.claimHit(claim({ weaponId: id, kind, dist: 1, t }));
      assert.equal(rejectReason(swing('stab', T0)), undefined);
      assert.equal(rejectReason(swing('stab', T0 + slash.cooldown * 1000)), 'too_fast', `${id}: 찌르기 뒤 베기 간격의 찌르기`);
      assert.equal(rejectReason(swing('slash', T0 + short)), undefined, `${id}: 찌르기→베기 ${short} ms`);
    }
  });

  test('실제 arsenal의 최고 속도 사격은 모든 무기에서 통과한다', () => {
    const TICK = 1 / 60;
    for (const id of [...PRIMARY_IDS, ...SECONDARY_IDS]) {
      const slot = WEAPONS[id].slot;
      const arsenal = createArsenal({
        primary: slot === 1 ? id : undefined, secondary: slot === 2 ? id : undefined, allowedSlots: [slot], rng: () => 0.5
      });
      const m = liveDuel({ hp: 1000000, roundTimeMs: 3600000 });
      let shots = 0, shotId = 0;
      for (let i = 0; i < 60 * 25; i++) {
        for (const ev of arsenal.update(TICK, { fireDown: true, firePressed: true }, { onGround: true })) {
          if (ev.type !== 'fire') continue;
          shots++;
          const evs = m.claimHit({
            attackerId: 'a', victimId: 'b', weaponId: ev.weaponId, part: 'body', dist: 5, t: T0 + ev.t * 1000,
            count: ev.pellets.length, shotId: ++shotId
          });
          assert.equal(rejectReason(evs), undefined, `${id} ${shots}번째 발 (t=${ev.t})`);
        }
      }
      assert.ok(shots >= 5, `${id}: ${shots}발`);
    }
  });

  test('실제 arsenal의 칼 공격은 판정 시각 기준으로 통과한다', () => {
    const TICK = 1 / 60;
    for (const id of MELEE_IDS) {
      const arsenal = createArsenal({ melee: id, allowedSlots: [3] });
      const m = liveDuel({ hp: 1000000, roundTimeMs: 3600000 });
      let hits = 0;
      for (let i = 0; i < 60 * 20; i++) {
        // 1초씩 번갈아 베기·찌르기 버튼을 누른다
        const stabbing = Math.floor(i / 60) % 2 === 1;
        for (const ev of arsenal.update(TICK, { fireDown: !stabbing, zoomDown: stabbing }, { onGround: true })) {
          if (ev.type !== 'melee') continue;
          hits++;
          const evs = m.claimHit({ attackerId: 'a', victimId: 'b', weaponId: ev.weaponId, dist: 1, kind: ev.kind, t: T0 + ev.t * 1000 });
          assert.equal(rejectReason(evs), undefined, `${id} ${ev.kind} t=${ev.t}`);
        }
      }
      assert.ok(hits >= 10, `${id}: ${hits}번`);
    }
  });

  test('라운드가 바뀌면 연사 기록이 새로 시작한다', () => {
    const m = createMatch({
      rules: { loadoutMs: 0, roundEndMs: 0 },
      players: [{ id: 'a', team: 'owner' }, { id: 'b', team: 'charterer' }], seed: 3
    });
    m.start();
    m.tick(1);
    assert.ok(firstOf(m.claimHit(claim({ weaponId: 'sr_bolt', part: 'head', t: T0, shotId: 1 })), 'kill'));
    m.tick(1);
    m.tick(1);
    assert.equal(m.state.phase, 'live');
    assert.ok(firstOf(m.claimHit(claim({ weaponId: 'sr_bolt', part: 'head', t: T0 + 1, shotId: 1 })), 'kill'), '새 라운드의 같은 번호');
  });
});

/* ============================================================ 규칙(룰셋) */

describe('규칙', () => {
  const FIRE_BY_RULESET = {
    classic: { ok: [...PRIMARY_IDS, ...SECONDARY_IDS, ...MELEE_IDS], no: [] },
    knife: { ok: [...MELEE_IDS], no: [...PRIMARY_IDS, ...SECONDARY_IDS] },
    sniper: {
      ok: [...PRIMARY_IDS.filter((id) => WEAPONS[id].kind === 'sniper'), ...MELEE_IDS],
      no: [...PRIMARY_IDS.filter((id) => WEAPONS[id].kind !== 'sniper'), ...SECONDARY_IDS]
    }
  };

  for (const ruleset of RULESET_IDS) {
    test(`${ruleset}: claimHit이 무기를 거른다`, () => {
      const { ok, no } = FIRE_BY_RULESET[ruleset];
      assert.equal(ok.length + no.length, PRIMARY_IDS.length + SECONDARY_IDS.length + MELEE_IDS.length);
      for (const weaponId of no) {
        const m = liveDuel({ ruleset });
        const evs = m.claimHit(claim({ weaponId, part: 'head', dist: 1, kind: 'slash' }));
        assert.equal(rejectReason(evs), 'ruleset', weaponId);
        assert.equal(firstOf(evs, 'reject').weaponId, weaponId);
        assert.equal(playerOf(m, 'b').hp, 100);
      }
      for (const weaponId of ok) {
        const m = liveDuel({ ruleset });
        assert.equal(rejectReason(m.claimHit(claim({ weaponId, part: 'head', dist: 1, kind: 'slash' }))), undefined, weaponId);
      }
    });

    test(`${ruleset}: claimExplosion`, () => {
      const m = liveDuel({ ruleset });
      const evs = m.claimExplosion({ attackerId: 'a', victims: [{ id: 'b', dmg: 60 }] });
      if (isWeaponAllowed(ruleset, 'gr_frag')) assert.equal(firstOf(evs, 'damage').amount, 60);
      else {
        assert.equal(rejectReason(evs), 'ruleset');
        assert.equal(playerOf(m, 'b').hp, 100);
      }
    });

    test(`${ruleset}: 기본 무기와 고를 수 있는 무기`, () => {
      const m = createMatch({
        rules: { ruleset, loadoutMs: 1000 },
        players: [{ id: 'a', team: 'owner' }, { id: 'b', team: 'charterer' }], seed: 4
      });
      m.start();
      assert.equal(playerOf(m, 'a').loadout, defaultPick(ruleset));
      const pickable = pickableWeapons(ruleset);
      for (const id of pickable) assert.deepEqual(only(m.setLoadout('a', id), 'reject'), [], id);
      assert.equal(playerOf(m, 'a').loadout, pickable[pickable.length - 1]);
      const others = WEAPON_IDS.filter((id) => !pickable.includes(id));
      for (const id of others) assert.equal(rejectReason(m.setLoadout('a', id)), 'bad_weapon', id);
      assert.equal(rejectReason(m.setLoadout('a', 'zzz')), 'bad_weapon');
      assert.equal(playerOf(m, 'a').loadout, pickable[pickable.length - 1], '거절되면 그대로');
      const live = firstOf(m.tick(1000), 'phase');
      assert.equal(live.phase, 'live');
      assert.equal(live.loadouts.a, pickable[pickable.length - 1]);
      assert.equal(live.loadouts.b, defaultPick(ruleset));
    });
  }

  test('rules.ruleset은 정규화하고, 모르는 값은 클래식이다', () => {
    assert.equal(createMatch({ rules: { ruleset: 'knife' } }).rules.ruleset, 'knife');
    assert.equal(createMatch({ rules: { ruleset: 'knife' } }).ruleset, 'knife');
    assert.equal(createMatch({ rules: { ruleset: 'sniper', mode: 'ffa' } }).rules.ruleset, 'sniper');
    assert.equal(createMatch({}).rules.ruleset, 'classic');
    assert.equal(createMatch({ rules: { ruleset: 'nope' } }).rules.ruleset, 'classic');
    assert.equal(createMatch({ rules: { ruleset: '__proto__' } }).rules.ruleset, 'classic');
  });

  test('스폰 이벤트와 스냅샷이 규칙을 싣는다', () => {
    const team = createMatch({ rules: { ruleset: 'knife' }, players: [{ id: 'a', team: 'owner' }, { id: 'b', team: 'charterer' }] });
    assert.equal(firstOf(team.start(), 'roundStart').ruleset, 'knife');
    assert.equal(team.snapshot().rs, 'knife');
    assert.equal(applySnapshot(team.snapshot()).ruleset, 'knife');
    assert.equal(team.state.rules.ruleset, 'knife');
    const { m, spawned } = liveFfa(['a', 'b'], { ruleset: 'sniper' });
    assert.equal(firstOf(spawned, 'spawn').ruleset, 'sniper');
    assert.equal(firstOf(spawned, 'spawn').loadout, 'sr_bolt');
    assert.equal(m.snapshot().rs, 'sniper');
    assert.equal(m.state.rules.ruleset, 'sniper');
    assert.equal(m.state.ruleset, 'sniper');
    assert.equal(applySnapshot({ ...team.snapshot(), rs: undefined }).ruleset, 'classic', '옛 스냅샷');
  });

  test('carry의 무기는 이 규칙에서 고를 수 있을 때만 받는다', () => {
    const carry = { a: { kills: 2, halfShots: 3, loadout: 'ar_std' }, b: { loadout: 'ml_gurkha' } };
    const m = createMatch({ rules: { ruleset: 'knife' }, players: [{ id: 'a', team: 'owner' }, { id: 'b', team: 'charterer' }], carry });
    assert.equal(playerOf(m, 'a').loadout, 'ml_knife');
    assert.equal(playerOf(m, 'b').loadout, 'ml_gurkha');
    assert.equal(playerOf(m, 'a').halfShots, 3);
  });
});

/* ============================================================ 이벤트 · 통계 */

describe('이벤트와 통계', () => {
  test('damage와 kill이 part·head·halfShot을 싣는다', () => {
    const m = liveDuel();
    const first = m.claimHit(claim({ weaponId: 'sr_bolt', part: 'foot', t: T0, shotId: 1 }));
    assert.deepEqual(
      (({ part, head, halfShot, amount, hp, weaponId }) => ({ part, head, halfShot, amount, hp, weaponId }))(firstOf(first, 'damage')),
      { part: 'foot', head: false, halfShot: true, amount: 50, hp: 50, weaponId: 'sr_bolt' }
    );
    const second = m.claimHit(claim({ weaponId: 'sr_bolt', part: 'head', t: T0 + 1200, shotId: 2 }));
    assert.equal(firstOf(second, 'damage').head, true);
    assert.equal(firstOf(second, 'damage').halfShot, false);
    const kill = firstOf(second, 'kill');
    assert.equal(kill.part, 'head');
    assert.equal(kill.head, true);
    assert.equal(kill.halfShot, false);
  });

  test('standings와 스냅샷에 halfShots가 있다(팀전)', () => {
    const m = liveDuel({ hp: 1000 });
    m.claimHit(claim({ weaponId: 'sr_bolt', part: 'hand', t: T0, shotId: 1 }));
    m.claimHit(claim({ weaponId: 'sr_bolt', part: 'foot', t: T0 + 1200, shotId: 2 }));
    m.claimHit(claim({ weaponId: 'sr_bolt', part: 'body', t: T0 + 2400, shotId: 3 }));
    const view = applySnapshot(JSON.parse(JSON.stringify(m.snapshot())));
    assert.equal(view.players.find((p) => p.id === 'a').halfShots, 2);
    assert.equal(view.players.find((p) => p.id === 'b').halfShots, 0);
    const { stats } = standings(view);
    assert.equal(stats.find((s) => s.id === 'a').halfShots, 2);
  });

  test('standings와 스냅샷에 halfShots가 있다(개인전), 행 칸 자리가 섞이지 않는다', () => {
    const { m } = liveFfa(['a', 'b'], { hp: 1000 });
    m.claimHit({ attackerId: 'a', victimId: 'b', weaponId: 'sr_heavy', part: 'hand', dist: 10, t: T0, shotId: 1 });
    const view = applySnapshot(JSON.parse(JSON.stringify(m.snapshot())));
    const a = view.players.find((p) => p.id === 'a');
    assert.equal(a.halfShots, 1);
    assert.equal(a.respawnIn, 0);
    assert.equal(a.protectMs, 0);
    const st = standings(view);
    assert.equal(st.stats.find((s) => s.id === 'a').halfShots, 1);
    assert.equal(st.ranking.find((s) => s.id === 'a').halfShots, 1);
  });

  test('자폭과 수류탄은 반샷을 세지 않는다', () => {
    const m = liveDuel();
    m.claimExplosion({ attackerId: 'a', victims: [{ id: 'a', dmg: 20 }, { id: 'b', dmg: 20 }] });
    assert.equal(playerOf(m, 'a').halfShots, 0);
  });

  test('최악의 스냅샷도 예산 안이다', () => {
    const name = '가'.repeat(24);
    const players = Array.from({ length: 8 }, (_, i) => ({ id: `00000000-0000-4000-8000-00000000000${i}`, name, team: i % 2 ? 'owner' : 'charterer' }));
    const m = createMatch({ rules: { ruleset: 'knife' }, players, seed: 5 });
    m.start();
    const size = new TextEncoder().encode(JSON.stringify(m.snapshot())).length;
    assert.ok(size <= 1800, `${size} B`);
  });
});

/* ============================================================ 경기 끝까지 */

describe('경기 전체', () => {
  /** owner가 라운드마다 상대 전원을 죽인다. 이 규칙에서 쓸 수 있는 무기와 부위로 */
  function playTeam(ruleset, weaponId, part, kind) {
    const m = createMatch({
      rules: { ruleset, loadoutMs: 100, roundEndMs: 100, roundTimeMs: 5000 },
      players: [
        { id: 'o1', name: '하나', team: 'owner' }, { id: 'o2', name: '둘', team: 'owner' },
        { id: 'c1', name: '셋', team: 'charterer' }, { id: 'c2', name: '넷', team: 'charterer' }
      ],
      seed: 6
    });
    const log = [...m.start()];
    let t = T0, shotId = 0;
    for (let round = 0; round < 3; round++) {
      log.push(...m.tick(100));
      assert.equal(m.state.phase, 'live', `라운드 ${round + 1}`);
      for (const victimId of ['c1', 'c2']) {
        t += 3000;
        const evs = m.claimHit({ attackerId: 'o1', victimId, weaponId, part, dist: 1, kind, t, shotId: ++shotId });
        assert.equal(rejectReason(evs), undefined);
        assert.ok(firstOf(evs, 'kill'), `${weaponId} 킬`);
        log.push(...evs);
      }
      log.push(...m.tick(100));
    }
    const end = firstOf(log, 'matchEnd');
    assert.ok(end, '경기가 끝난다');
    assert.equal(end.winner, 'owner');
    assert.equal(end.reason, 'wins');
    assert.deepEqual(end.score, { owner: 3, charterer: 0 });
    assert.equal(end.mvpId, 'o1');
    assert.equal(end.stats[0][0], 'o1');
    assert.equal(end.stats[0][1], 6);
    assert.equal(end.stats[0][5], 0);
    assert.equal(only(log, 'roundEnd').length, 3);
    const view = applySnapshot(m.snapshot());
    assert.equal(view.phase, 'matchEnd');
    assert.equal(view.result.winner, 'owner');
    assert.equal(view.ruleset, ruleset);
    assert.deepEqual(standings(view).mvp.id, 'o1');
    return view;
  }

  test('팀전 클래식: 라이플 머리로 3:0', () => {
    const view = playTeam('classic', 'ar_std', 'head');
    assert.equal(view.players.find((p) => p.id === 'o1').headshots, 6);
  });
  test('팀전 스나전: 저격 몸으로 3:0', () => { playTeam('sniper', 'sr_bolt', 'body'); });
  test('팀전 칼전: 강타로 3:0', () => { playTeam('knife', 'ml_katana', null, 'stab'); });

  test('팀전: 반샷 두 번으로 라운드를 끝내도 정상이다', () => {
    const m = liveDuel({ roundsToWin: 1, maxRounds: 1, roundEndMs: 10 });
    m.claimHit(claim({ weaponId: 'sr_bolt', part: 'hand', t: T0, shotId: 1 }));
    const evs = m.claimHit(claim({ weaponId: 'sr_bolt', part: 'foot', t: T0 + 1200, shotId: 2 }));
    assert.deepEqual(evs.map((e) => e.type), ['damage', 'kill', 'roundEnd', 'phase']);
    const end = firstOf(m.tick(10), 'matchEnd');
    assert.equal(end.winner, 'owner');
    assert.equal(end.stats.find((r) => r[0] === 'a')[5], 2);
  });

  test('개인전: killTarget에 닿으면 끝난다', () => {
    const { m } = liveFfa(['a', 'b', 'c'], { killTarget: 5, respawnMs: 100 });
    let t = T0, shotId = 0, end = null;
    for (let i = 0; i < 5 && !end; i++) {
      const victimId = i % 2 ? 'c' : 'b';
      t += 2000;
      const evs = m.claimHit({ attackerId: 'a', victimId, weaponId: 'sr_bolt', part: 'body', dist: 40, t, shotId: ++shotId });
      assert.equal(rejectReason(evs), undefined);
      assert.ok(firstOf(evs, 'kill'));
      end = firstOf(evs, 'matchEnd');
      if (!end) assert.ok(only(m.tick(100), 'spawn').length >= 1, '100 ms 뒤 부활');
    }
    assert.ok(end, '5킬에 끝난다');
    assert.equal(end.mode, 'ffa');
    assert.equal(end.winner, 'a');
    assert.equal(end.reason, 'kills');
    assert.equal(end.ranking[0].id, 'a');
    assert.equal(end.ranking[0].kills, 5);
    assert.equal(end.ranking[0].halfShots, 0);
    assert.equal(m.state.phase, 'matchEnd');
    assert.equal(rejectReason(m.claimHit({ attackerId: 'a', victimId: 'b', weaponId: 'sr_bolt', dist: 1 })), 'not_live');
    assert.deepEqual(m.tick(100000), [], '끝난 뒤에는 아무 일도 없다');
  });

  test('개인전 칼전: 칼로 목표까지, 총은 거절된다', () => {
    const { m } = liveFfa(['a', 'b'], { killTarget: 5, ruleset: 'knife', respawnMs: 50 });
    assert.equal(rejectReason(m.claimHit({ attackerId: 'a', victimId: 'b', weaponId: 'sr_bolt', part: 'head', dist: 1 })), 'ruleset');
    let t = T0, end = null;
    for (let i = 0; i < 5; i++) {
      t += 2000;
      const evs = m.claimHit({ attackerId: 'a', victimId: 'b', weaponId: 'ml_knife', dist: 1, kind: 'stab', t });
      assert.ok(firstOf(evs, 'kill'));
      end = firstOf(evs, 'matchEnd');
      m.tick(60);
    }
    assert.equal(end.winner, 'a');
  });

  test('개인전: 시간이 끝나면 순위로 끝난다', () => {
    const { m } = liveFfa(['a', 'b'], { timeLimitMs: 1000 });
    m.claimHit({ attackerId: 'a', victimId: 'b', weaponId: 'ar_std', part: 'head', dist: 10, t: T0 });
    const end = firstOf(m.tick(1000), 'matchEnd');
    assert.equal(end.reason, 'time');
    assert.equal(end.winner, 'a');
  });
});

/* ============================================================ 방장 이전(session.js) */

describe('방장 이전', () => {
  test('restoreMatch가 규칙을 이어받고 새 무기로 판정한다', () => {
    const src = createMatch({
      rules: { ruleset: 'sniper', loadoutMs: 0, roundEndMs: 0 },
      players: [{ id: 'a', team: 'owner' }, { id: 'b', team: 'charterer' }], seed: 7
    });
    src.start();
    src.tick(1);
    src.claimHit(claim({ weaponId: 'sr_twin', part: 'head', t: T0, shotId: 1 }));   // 1:0
    const r = restoreMatch({ snapshot: src.snapshot(), players: [{ id: 'a', team: 'owner' }, { id: 'b', team: 'charterer' }], seed: 8 });
    assert.equal(r.rules.ruleset, 'sniper');
    r.start();
    r.tick(1);
    assert.equal(r.state.phase, 'live');
    assert.equal(r.state.ruleset, 'sniper');
    assert.equal(r.state.score.owner, 1);
    assert.equal(rejectReason(r.claimHit(claim({ weaponId: 'ar_std', part: 'head', t: T0 + 5000, shotId: 2 }))), 'ruleset');
    const half = r.claimHit(claim({ weaponId: 'sr_twin', part: 'hand', t: T0 + 6000, shotId: 3 }));
    assert.equal(firstOf(half, 'damage').halfShot, true);
    assert.equal(r.state.players.find((p) => p.id === 'a').halfShots, 1);
    assert.ok(firstOf(r.claimHit(claim({ weaponId: 'sr_twin', part: 'hand', t: T0 + 8000, shotId: 4 })), 'kill'));
    assert.equal(r.state.score.owner, 2);
  });

  test('restoreFfaMatch가 규칙과 기록을 이어받는다', () => {
    const { m } = liveFfa(['a', 'b'], { ruleset: 'knife' });
    m.claimHit({ attackerId: 'a', victimId: 'b', weaponId: 'ml_knife', dist: 1, kind: 'stab', t: T0 });
    const r = restoreFfaMatch({ snapshot: m.snapshot(), players: [{ id: 'a' }, { id: 'b' }], seed: 9 });
    assert.equal(r.rules.ruleset, 'knife');
    assert.equal(r.state.players.find((p) => p.id === 'a').kills, 1);
    assert.equal(r.state.players.find((p) => p.id === 'a').loadout, 'ml_knife');
  });
});
