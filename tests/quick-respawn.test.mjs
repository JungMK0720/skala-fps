/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 개인전 즉시 부활(부활 대기 중 E) 시험. 경기의 respawnNow 판정과 instant 표시, 값(킬 보상 한 번), 계정 spendPoints,
 *          결과 화면 줄(withQuickRespawns), 방장에게 가는 g2r 메시지, 부활 패널의 안내 줄을 확인한다.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createMatch, QUICK_RESPAWN_MIN_LEFT_MS } from '../js/game/match.js';
import { MATCH_POINTS, QUICK_RESPAWN_POINTS, quickRespawnCost, withQuickRespawns } from '../js/account/economy.js';
import { createAccount } from '../js/account/index.js';
import { EV, decodeMessage, decodeRespawn, encodeRespawn, isGameEvent } from '../js/game/protocol.js';
import { createSync } from '../js/game/sync.js';
import { quickRespawnSpec } from '../js/ui/hud.js';

const T0 = 1000000;
const only = (evs, type) => evs.filter((e) => e.type === type);
const firstOf = (evs, type) => evs.find((e) => e.type === type);
const playerOf = (m, id) => m.state.players.find((p) => p.id === id);

/** 부활 보호를 끈 개인전을 live까지(부활 3초) */
function liveFfa(rules = {}) {
  const m = createMatch({
    rules: { mode: 'ffa', loadoutMs: 0, spawnProtectMs: 0, respawnMs: 3000, ...rules },
    players: [{ id: 'a', name: '갑' }, { id: 'b', name: '을' }],
    seed: 3
  });
  m.start();
  m.tick(1);
  assert.equal(m.state.phase, 'live');
  return m;
}
/** a가 b를 머리 한 발로 잡는다(라이플 헤드 1발) */
function killB(m, t = T0) {
  const evs = m.claimHit({ attackerId: 'a', victimId: 'b', weaponId: 'ar_std', part: 'head', dist: 10, kind: 'shot', t });
  assert.ok(firstOf(evs, 'kill'), 'b가 죽는다');
  return evs;
}

describe('경기: respawnNow', () => {
  test('부활을 기다리는 사람은 바로 나오고, 그 spawn에만 instant가 붙는다', () => {
    const m = liveFfa();
    killB(m);
    assert.equal(playerOf(m, 'b').alive, false);
    m.tick(200);
    const evs = m.respawnNow('b');
    const sp = firstOf(evs, 'spawn');
    assert.ok(sp, JSON.stringify(evs));
    assert.equal(sp.id, 'b');
    assert.equal(sp.instant, true);
    assert.ok(Number.isFinite(sp.spawn.x) && Number.isFinite(sp.spawn.z));
    assert.equal(playerOf(m, 'b').alive, true);
    // 저절로 나오는 시각이 지나도 다시 나오지 않는다
    assert.equal(only(m.tick(3000), 'spawn').length, 0);
    // 평소 부활 spawn에는 instant가 없다
    killB(m, T0 + 5000);
    const auto = only(m.tick(3100), 'spawn');
    assert.equal(auto.length, 1);
    assert.equal(auto[0].instant, undefined);
  });

  test('살아 있거나, 이미 곧 나올 때이거나, live가 아니거나, 팀전이면 거절한다', () => {
    const m = liveFfa();
    assert.equal(firstOf(m.respawnNow('a'), 'reject').reason, 'not_waiting', '살아 있음');
    assert.equal(firstOf(m.respawnNow('zz'), 'reject').reason, 'unknown_player');
    killB(m);
    m.tick(3000 - QUICK_RESPAWN_MIN_LEFT_MS + 10);
    const late = m.respawnNow('b');
    assert.equal(firstOf(late, 'reject').reason, 'too_late', '곧 저절로 나오면 값을 내지 않게 거절');
    assert.equal(firstOf(late, 'spawn'), undefined);

    const team = createMatch({ rules: { loadoutMs: 0 }, players: [{ id: 'a', team: 'owner' }, { id: 'b', team: 'charterer' }], seed: 1 });
    team.start();
    team.tick(1);
    assert.equal(firstOf(team.respawnNow('a'), 'reject').reason, 'not_ffa');

    const pre = createMatch({ rules: { mode: 'ffa', loadoutMs: 5000 }, players: [{ id: 'a' }, { id: 'b' }], seed: 1 });
    pre.start();
    assert.equal(firstOf(pre.respawnNow('a'), 'reject').reason, 'not_live', '처음 출격 전 무기 고르기');
  });

  test('늦게 들어와 첫 출격을 기다리는 사람도 즉시 나올 수 있다', () => {
    const m = liveFfa();
    m.addPlayer({ id: 'c', name: '병' });
    assert.equal(playerOf(m, 'c').alive, false);
    const sp = firstOf(m.respawnNow('c'), 'spawn');
    assert.ok(sp && sp.instant);
  });
});

describe('값: 즉시 부활 = 킬 보상 한 번', () => {
  test('멀티 10 · 연습장 5, 킬 보상 표와 같다', () => {
    assert.equal(quickRespawnCost(true), 10);
    assert.equal(quickRespawnCost(false), 5);
    assert.equal(QUICK_RESPAWN_POINTS.multi, MATCH_POINTS.multi.kill);
    assert.equal(QUICK_RESPAWN_POINTS.bot, MATCH_POINTS.bot.kill);
  });

  test('결과 화면 줄: 낸 만큼 한 줄을 더하고 이번 판 합계에서 뺀다. 보유 포인트는 그대로다', () => {
    const reward = { gained: 45, breakdown: [{ label: '킬 ×2', points: 20 }, { label: '헤드샷 ×1', points: 5 }, { label: '완주', points: 20 }], points: 600 };
    const out = withQuickRespawns(reward, 3, 30);
    assert.equal(out.gained, 15);
    assert.deepEqual(out.breakdown.at(-1), { label: '즉시 부활 ×3', points: -30 });
    assert.equal(out.breakdown.reduce((s, r) => s + r.points, 0), out.gained, '줄의 합 = 합계');
    assert.equal(out.points, 600);
    assert.equal(reward.breakdown.length, 3, '원래 보상은 건드리지 않는다');
    assert.equal(withQuickRespawns(reward, 0, 0), reward, '쓰지 않았으면 그대로');
    assert.equal(withQuickRespawns(null, 2, 20), null);
    const loss = withQuickRespawns({ gained: 20, breakdown: [{ label: '완주', points: 20 }], points: 50 }, 4, 40);
    assert.equal(loss.gained, -20, '부활 값이 더 크면 이번 판은 음수');
  });
});

describe('계정: spendPoints', () => {
  test('있는 만큼만 쓰고, 모자라거나 이상한 값이면 쓰지 않는다', (t) => {
    const account = createAccount({ storage: null, target: null, config: { url: '', anonKey: '' } });
    t.after(() => account.dispose());
    const start = account.profile.points;
    assert.ok(start >= 10);
    const r = account.spendPoints(10);
    assert.deepEqual(r, { ok: true, spent: 10, points: start - 10 });
    assert.equal(account.profile.points, start - 10);
    assert.equal(account.spendPoints(0).reason, 'amount');
    assert.equal(account.spendPoints(2.5).reason, 'amount');
    assert.equal(account.spendPoints('10').reason, 'amount');
    const big = account.spendPoints(start * 10);
    assert.equal(big.ok, false);
    assert.equal(big.reason, 'points');
    assert.equal(account.profile.points, start - 10, '모자라면 그대로');
  });
});

describe('메시지: g2r 즉시 부활 요청', () => {
  test('요청 번호만 싣고 왕복한다. 이상한 값은 null', () => {
    assert.equal(EV.respawn, 'g2r');
    assert.ok(isGameEvent(EV.respawn));
    assert.deepEqual(encodeRespawn(7), [7]);
    assert.deepEqual(decodeMessage(EV.respawn, encodeRespawn(7)), { type: 'respawn', data: { id: 7 } });
    assert.equal(decodeRespawn(null), null);
    assert.equal(decodeRespawn([]), null);
    assert.equal(decodeRespawn(['x']), null);
  });

  /** 메시지를 바로 건네는 가짜 방 둘(a = 방장) */
  function pair() {
    const rooms = new Map();
    const make = (id) => {
      const subs = new Set();
      const room = {
        me: { id }, rate: 10,
        isHost: () => id === 'a', hostId: () => 'a', players: () => [{ id: 'a' }, { id: 'b' }],
        on(evt, fn) { if (evt !== 'message') return () => {}; subs.add(fn); return () => subs.delete(fn); },
        send(event, payload) { for (const [k, r] of rooms) if (k !== id) r.deliver({ from: id, event, payload }); return true; },
        sendTo(to, event, payload) { const r = rooms.get(String(to)); if (r) r.deliver({ from: id, event, payload, to }); return true; },
        deliver(m) { for (const fn of subs) fn(m); }
      };
      rooms.set(id, room);
      return room;
    };
    return { a: make('a'), b: make('b') };
  }

  test('손님은 방장에게만 보내고 방장은 한 번만 받는다. 방장 자신의 요청은 보내지 않고 바로 돌려준다', () => {
    const { a, b } = pair();
    let clock = 1000;
    const got = { a: [], b: [] };
    const sa = createSync({ room: a, onEvent: (e) => got.a.push(e), autoTick: false, now: () => clock });
    const sb = createSync({ room: b, onEvent: (e) => got.b.push(e), autoTick: false, now: () => clock });
    assert.ok(sb.sendRespawn() > 0);
    for (let i = 0; i < 6; i++) { clock += 100; sb.tick(clock); sa.tick(clock); }
    const asks = got.a.filter((e) => e.type === 'respawn');
    assert.equal(asks.length, 1, '두 번 보내도(reliableRepeat) 한 번만');
    assert.equal(asks[0].from, 'b');
    assert.equal(got.b.filter((e) => e.type === 'respawn').length, 0, '손님은 받지 않는다');

    assert.ok(sa.sendRespawn() > 0);
    clock += 100; sa.tick(clock);
    const mine = got.a.filter((e) => e.type === 'respawn' && e.from === 'a');
    assert.equal(mine.length, 1);
    assert.equal(mine[0].local, true);
    sa.dispose(); sb.dispose();
  });
});

describe('부활 패널 안내 줄', () => {
  test('PC는 E, 휴대폰은 부활 버튼, 포인트가 모자라면 그 사실을 적는다', () => {
    assert.deepEqual(quickRespawnSpec({ cost: 10, ok: true }), { key: 'E', text: '즉시 부활 · 10 P', ok: true });
    assert.deepEqual(quickRespawnSpec({ cost: 5, ok: true, touch: true }), { key: '', text: "'부활' 버튼 · 5 P", ok: true });
    assert.deepEqual(quickRespawnSpec({ cost: 10, ok: false }), { key: '', text: '즉시 부활 10 P · 포인트 부족', ok: false });
    assert.equal(quickRespawnSpec(null), null);
    assert.equal(quickRespawnSpec({ cost: 0 }), null);
  });
});
