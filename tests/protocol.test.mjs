/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 멀티플레이 프로토콜 시험. 버전과 부위 코드, 모든 메시지의 왕복, 히트 주장의 count·shotId,
 *          쓰레기 입력에도 던지지 않는 디코더, 경기 스냅샷·이벤트가 match.js까지 그대로 가는지를 검사한다.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  PROTOCOL_VERSION, EV, PART_CODES, KIND_CODES, PHASE_CODES, TEAM_CODES, IMPACT_CODES, FLAG,
  encodeState, encodeStateBody, decodeState, quantizeState, bodyNearlyEqual,
  encodeFire, decodeFire, encodeHit, decodeHit, encodeGrenade, decodeGrenade,
  encodeMatch, decodeMatch, encodeMatchEvent, decodeMatchEvent,
  encodeLoadout, decodeLoadout, encodeChat, decodeChat, cleanText, encodePing, encodePong, decodePing,
  isGameEvent, decodeMessage, wrapAngle, vec3, byteSize
} from '../js/game/protocol.js';
import { createMatch, applySnapshot, standings } from '../js/game/match.js';
import { PARTS } from '../js/weapons/defs.js';

const wire = (v) => JSON.parse(JSON.stringify(v));   // 네트워크를 거친 것처럼

const GARBAGE = [
  undefined, null, true, false, 0, -1, 1.5, NaN, Infinity, '', 'x', '__proto__', {}, [], [[]], [null], [undefined, undefined],
  [NaN, NaN, NaN], { 0: 1, length: 8 }, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'],
  [1, 2, 3], [1, 'v', 0, 'w'], [1, 'v', 0, 'w', 'd', 0, 'n'], Array(40).fill(null), Array(40).fill('z'), Array(40).fill({}), Array(40).fill([]),
  [1, 0, 0, 0, 0, 0, [], [null, 1, 'x', {}, [null]]], [1, 0, 0, 0, 0, 0, [[null, null, null, null, null, null]], [[1]], 5],
  [1, 0, 0, 0, 0, 0, [['__proto__', 0, 0, 0, 0, 0, { polluted: 1 }]], []], Object.create(null), () => 1, Symbol.iterator,
  { toString: 1, valueOf: 1 }, [{ toString: 1 }, { toString: 1 }, { toString: 1 }, { toString: 1 }, { toString: 1 }, { toString: 1 }, { toString: 1 }]
];

describe('버전과 코드 표', () => {
  test('버전 2: 이벤트 이름이 바뀌어 옛 클라이언트와 섞이지 않는다', () => {
    assert.equal(PROTOCOL_VERSION, 2);
    for (const name of Object.values(EV)) {
      assert.match(name, /^g2[a-z]$/);
      assert.equal(isGameEvent(name), true);
    }
    assert.equal(new Set(Object.values(EV)).size, Object.keys(EV).length);
    for (const old of ['g1s', 'g1f', 'g1h', 'g1x', 'g1m', 'g1l', 'g1c', 'g1p']) {
      assert.equal(isGameEvent(old), false, old);
      assert.equal(decodeMessage(old, [1, 'v', 0, 'w', 0, 0, 0]), null);
    }
    assert.equal(isGameEvent('toString'), false);
    assert.equal(decodeMessage('constructor', []), null);
  });

  test('부위 코드는 다섯이고 앞 순서를 유지한다(DESIGN 2절)', () => {
    assert.deepEqual(PART_CODES, ['head', 'body', 'legs', 'hand', 'foot']);
    assert.deepEqual([...PART_CODES], [...PARTS]);
    assert.ok(Object.isFrozen(PART_CODES));
  });
});

describe('히트 주장', () => {
  const base = { victimId: 'u2', part: 'body', weaponId: 'ar_std', dist: 12.34, kind: 'shot', shotT: 123456 };

  test('모든 부위가 코드로 왕복한다', () => {
    for (const part of PART_CODES) {
      const a = encodeHit(7, { ...base, part });
      assert.equal(a[2], PART_CODES.indexOf(part), '숫자 코드로 실린다');
      const d = decodeHit(wire(a));
      assert.equal(d.part, part);
      assert.equal(d.id, 7);
      assert.equal(d.victimId, 'u2');
      assert.equal(d.weaponId, 'ar_std');
      assert.equal(d.dist, 12.34);
      assert.equal(d.kind, 'shot');
      assert.equal(d.shotT, 123456);
    }
  });

  test('count와 shotId가 왕복한다', () => {
    const d = decodeHit(wire(encodeHit(1, { ...base, weaponId: 'sg_bx12', count: 5, shotId: 42 })));
    assert.equal(d.count, 5);
    assert.equal(d.shotId, 42);
    assert.equal(decodeHit(wire(encodeHit(1, { ...base, shotId: 0x7fffffff }))).shotId, 0x7fffffff);
  });

  test('count 기본값은 1이고 shotId가 없으면 칸을 싣지 않는다', () => {
    const a = encodeHit(1, base);
    assert.equal(a.length, 8);
    assert.equal(a[7], 1);
    const d = decodeHit(wire(a));
    assert.equal(d.count, 1);
    assert.equal(d.shotId, null);
  });

  test('이상한 count·shotId는 보낼 때도 받을 때도 걸러진다', () => {
    for (const bad of [0, -3, 'x', null, undefined, NaN, {}, []]) {
      assert.equal(decodeHit(wire(encodeHit(1, { ...base, count: bad }))).count, 1, String(bad));
      assert.equal(decodeHit([1, 'v', 0, 'w', 100, 0, 5, bad]).count, 1, String(bad));
    }
    assert.equal(decodeHit(wire(encodeHit(1, { ...base, count: 2.9 }))).count, 2);
    assert.equal(decodeHit(wire(encodeHit(1, { ...base, count: 1e9 }))).count, 64);
    assert.equal(decodeHit([1, 'v', 0, 'w', 100, 0, 5, 1e9]).count, 64);
    for (const bad of [0, -3, 1.5, 'abc', null, undefined, NaN, {}, 2 ** 40]) {
      assert.equal(encodeHit(1, { ...base, shotId: bad }).length, 8, String(bad));
      assert.equal(decodeHit([1, 'v', 0, 'w', 100, 0, 5, 1, bad]).shotId, null, String(bad));
    }
  });

  test('끝 칸이 없는 짧은 주장도 받는다', () => {
    const d = decodeHit([3, 'v', 4, 'sr_bolt', 15000, 0, 99]);
    assert.deepEqual(d, { id: 3, victimId: 'v', part: 'foot', weaponId: 'sr_bolt', dist: 150, kind: 'shot', shotT: 99, count: 1, shotId: null });
  });

  test('모르는 부위·종류는 기본값이나 잘린 글자로 온다', () => {
    assert.equal(decodeHit([1, 'v', 99, 'w', 0, 0, 0]).part, 'body');
    assert.equal(decodeHit([1, 'v', -1, 'w', 0, 0, 0]).part, 'body');
    assert.equal(decodeHit([1, 'v', 1.5, 'w', 0, 0, 0]).part, 'body');
    assert.equal(decodeHit([1, 'v', null, 'w', 0, 0, 0]).part, 'body');
    assert.equal(decodeHit([1, 'v', 'toe'.repeat(20), 'w', 0, 0, 0]).part.length, 24);
    assert.equal(decodeHit([1, 'v', 0, 'w', 0, 99, 0]).kind, 'shot');
    assert.equal(decodeHit([1, 'v', 0, 7, 0, 0, 0]).weaponId, '');
  });

  test('받을 수 없는 주장은 null이다', () => {
    for (const bad of [
      null, [], [1, 'v', 0, 'w', 0, 0], ['1', 'v', 0, 'w', 0, 0, 0], [1, '', 0, 'w', 0, 0, 0], [1, null, 0, 'w', 0, 0, 0],
      [1, {}, 0, 'w', 0, 0, 0], [1, 'x'.repeat(65), 0, 'w', 0, 0, 0], [1, 'v', 0, 'w', 'far', 0, 0], [1, 'v', 0, 'w', 0, 0, null], [1, 'v', 0, 'w', NaN, 0, 0]
    ]) assert.equal(decodeHit(bad), null, JSON.stringify(bad));
  });

  test('거리는 cm로 싣고 음수·큰 값을 자른다', () => {
    assert.equal(encodeHit(1, { ...base, dist: 1.234 })[4], 123);
    assert.equal(decodeHit(wire(encodeHit(1, { ...base, dist: -5 }))).dist, 0);
    assert.equal(decodeHit([1, 'v', 0, 'w', -500, 0, 0]).dist, 0);
    assert.equal(decodeHit([1, 'v', 0, 'w', 1e12, 0, 0]).dist, 100000);
  });

  test('encodeHit은 빈 입력에도 던지지 않는다', () => {
    assert.equal(decodeHit(encodeHit(1, null)), null, '받는 쪽 검증에서 걸러진다');
    assert.equal(decodeHit(encodeHit(1, {})), null);
    assert.equal(decodeHit(encodeHit(1, { victimId: 12 })).victimId, '12');
  });

  test('decodeMessage를 거쳐 match.claimHit까지: 산탄 count와 같은 발', () => {
    const m = createMatch({ rules: { mode: 'ffa', loadoutMs: 0, spawnProtectMs: 0, hp: 1000 }, players: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] });
    m.start();
    m.tick(1);
    const send = (victimId, count, shotT, shotId) => {
      const msg = decodeMessage(EV.hit, wire(encodeHit(1, { victimId, part: 'hand', weaponId: 'sg_bx12', dist: 4, kind: 'shot', shotT, count, shotId })));
      assert.equal(msg.type, 'hit');
      const h = msg.data;
      return m.claimHit({ attackerId: 'a', victimId: h.victimId, weaponId: h.weaponId, part: h.part, dist: h.dist, kind: h.kind, t: h.shotT, count: h.count, shotId: h.shotId });
    };
    const first = send('b', 6, 5000000, 11);
    assert.equal(first[0].type, 'damage');
    assert.equal(first[0].part, 'hand');
    assert.equal(first[0].amount, 42);
    assert.equal(first[0].count, 6);
    const second = send('c', 2, 5000000, 11);
    assert.equal(second[0].type, 'damage', '같은 발의 둘째 사람');
    assert.equal(second[0].amount, 14);
    assert.equal(send('b', 1, 5000010, 12)[0].reason, 'too_fast');
  });
});

describe('다른 메시지 왕복', () => {
  test('상태', () => {
    const s = { pos: [1.5, 2.25, -3], vel: [0.5, -1, 2], yaw: 1.25, pitch: -0.5, slot: 3, hp: 72, onGround: false, walking: true, crouch: true, emote: 5, alive: true };
    const d = decodeState(wire(encodeState(9, 1234, s)));
    assert.equal(d.seq, 9);
    assert.equal(d.t, 1234);
    assert.deepEqual(d.pos, [1.5, 2.25, -3]);
    assert.deepEqual(d.vel, [0.5, -1, 2]);
    assert.equal(d.yaw, 1.25);
    assert.equal(d.pitch, -0.5);
    assert.equal(d.slot, 3);
    assert.equal(d.hp, 72);
    assert.equal(d.onGround, false);
    assert.equal(d.walking, true);
    assert.equal(d.crouch, true);
    assert.equal(d.alive, true);
    assert.equal(d.emote, 5);
    assert.equal(d.flags & FLAG.walking, FLAG.walking);
    assert.equal(decodeState(encodeState(1, 1, encodeStateBody(s))).hp, 72);
    assert.equal(quantizeState(s).seq, undefined);
    assert.equal(bodyNearlyEqual(encodeStateBody(s), encodeStateBody(s), 1, 1, 500), true);
    assert.equal(bodyNearlyEqual(encodeStateBody(s), encodeStateBody({ ...s, slot: 1 }), 1, 1, 500), false);
    assert.equal(encodeStateBody(null), null);
    assert.equal(encodeState(1, 1, null), null);
  });

  test('사격', () => {
    const f = { weaponId: 'sg_bx12', origin: [1, 2, 3], dir: [0, 0, -2], hit: [1, 2, -4], hitKind: 'player' };
    const d = decodeFire(wire(encodeFire(77, f)));
    assert.equal(d.weaponId, 'sg_bx12');
    assert.equal(d.t, 77);
    assert.deepEqual(d.origin, [1, 2, 3]);
    assert.deepEqual(d.dir, [0, 0, -1]);
    assert.deepEqual(d.hit, [1, 2, -4]);
    assert.equal(d.hitKind, 'player');
    const miss = decodeFire(wire(encodeFire(77, { weaponId: 'ml_katana', origin: [0, 0, 0], dir: [1, 0, 0] })));
    assert.equal(miss.hit, null);
    assert.equal(miss.hitKind, null);
    assert.equal(decodeFire(['x', 1, 2, 3]), null);
    assert.deepEqual(IMPACT_CODES, ['none', 'world', 'player']);
  });

  test('수류탄', () => {
    const d = decodeGrenade(wire(encodeGrenade(5, { pos: { x: 1, y: 2, z: 3 }, vel: [4, 5, 6], t: 9 })));
    assert.deepEqual(d, { id: 5, pos: [1, 2, 3], vel: [4, 5, 6], t: 9 });
    assert.equal(decodeGrenade([1, 2, 3]), null);
  });

  test('로드아웃: 세 슬롯이 무손실로 간다', () => {
    const lo = { primary: 'sr_twin', secondary: 'pt_magnum', melee: 'ml_katana', round: 2, m: 'abc' };
    assert.deepEqual(decodeLoadout(wire(encodeLoadout(3, lo))), { id: 3, loadout: lo });
    assert.equal(decodeLoadout([1, 2]), null);
    assert.deepEqual(decodeLoadout([1, JSON.parse('{"__proto__":{"x":1},"a":2}')]).loadout, { a: 2 });
  });

  test('채팅', () => {
    assert.deepEqual(decodeChat(wire(encodeChat(1, '  안녕\n하세요  '))), { id: 1, text: '안녕 하세요' });
    assert.equal(decodeChat([1, '   ']), null);
    assert.equal(cleanText('x'.repeat(500)).length, 120);
  });

  test('핑·퐁', () => {
    assert.deepEqual(decodePing(wire(encodePing(1, 100, 200))), { pid: 1, t0: 100, d0: 200 });
    assert.deepEqual(decodePing(wire(encodePing(1, 100))), { pid: 1, t0: 100, d0: null });
    assert.deepEqual(decodePing(wire(encodePong(1, 100, 110, 120, 130, 5))), { pid: 1, t0: 100, t1: 110, t2: 120, d2: 130, e0: 5 });
    assert.equal(decodePing([1]), null);
  });

  test('각도·벡터·바이트 도우미', () => {
    assert.ok(Math.abs(wrapAngle(Math.PI * 3) - Math.PI) < 1e-9);
    assert.equal(wrapAngle('x'), 0);
    assert.deepEqual(vec3({ x: 1, y: 'x', z: 3 }), [1, 0, 3]);
    assert.deepEqual(vec3(null), [0, 0, 0]);
    assert.equal(byteSize('가a'), 4);
    assert.equal(byteSize({ a: 1 }), 7);
    assert.equal(byteSize(undefined), 0);
  });
});

describe('경기 스냅샷·이벤트', () => {
  const liveTeam = (rules) => {
    const m = createMatch({ rules: { loadoutMs: 0, ...rules }, players: [{ id: 'a', name: '갑', team: 'owner' }, { id: 'b', name: '을', team: 'charterer' }], seed: 1 });
    m.start();
    m.tick(1);
    return m;
  };

  test('damage·kill 이벤트의 새 칸이 그대로 간다', () => {
    const m = liveTeam({ ruleset: 'sniper' });
    const half = m.claimHit({ attackerId: 'a', victimId: 'b', weaponId: 'sr_bolt', part: 'foot', dist: 90, t: 1000000, shotId: 1 });
    const d = decodeMatchEvent(wire(encodeMatchEvent(4, half[0])));
    assert.equal(d.eid, 4);
    assert.equal(d.type, 'damage');
    assert.equal(d.part, 'foot');
    assert.equal(d.amount, 50);
    assert.equal(d.hp, 50);
    assert.equal(d.head, false);
    assert.equal(d.halfShot, true);
    assert.equal(d.weaponId, 'sr_bolt');
    const end = m.claimHit({ attackerId: 'a', victimId: 'b', weaponId: 'sr_bolt', part: 'hand', dist: 90, t: 1001200, shotId: 2 });
    const k = decodeMatchEvent(wire(encodeMatchEvent(5, end.find((e) => e.type === 'kill'))));
    assert.equal(k.killer, 'a');
    assert.equal(k.victim, 'b');
    assert.equal(k.part, 'hand');
    assert.equal(k.head, false);
    assert.equal(k.halfShot, true);
    assert.equal(k.killerName, '갑');
  });

  test('산탄 count와 규칙도 이벤트에 실린다', () => {
    const m = createMatch({ rules: { loadoutMs: 0, ruleset: 'knife' }, players: [{ id: 'a', team: 'owner' }, { id: 'b', team: 'charterer' }] });
    const start = decodeMatchEvent(wire(encodeMatchEvent(1, m.start().find((e) => e.type === 'roundStart'))));
    assert.equal(start.ruleset, 'knife');
    assert.equal(start.round, 1);
    const n = liveTeam({ hp: 500 });
    const hit = n.claimHit({ attackerId: 'a', victimId: 'b', weaponId: 'sg_bx12', part: 'legs', dist: 2, count: 4 });
    assert.equal(decodeMatchEvent(wire(encodeMatchEvent(2, hit[0]))).count, 4);
  });

  test('팀전 스냅샷이 protocol을 지나 applySnapshot까지 무손실이다', () => {
    const m = liveTeam({ ruleset: 'sniper', hp: 1000 });
    m.claimHit({ attackerId: 'a', victimId: 'b', weaponId: 'sr_bolt', part: 'hand', dist: 90, t: 1000000 });
    m.setLoadout('a', 'sr_twin');
    const events = [{ type: 'phase', phase: 'live', round: 1, durationMs: 1000 }];
    const raw = encodeMatch(3, m.snapshot(), events.map((e, i) => encodeMatchEvent(i, e)));
    const out = decodeMatch(wire(raw));
    assert.equal(out.seq, 3);
    assert.equal(out.events[0].phase, 'live');
    const view = applySnapshot(out.snapshot);
    assert.deepEqual(view, m.state);
    assert.equal(view.ruleset, 'sniper');
    assert.equal(view.players.find((p) => p.id === 'a').halfShots, 1);
  });

  test('개인전 스냅샷도 무손실이고 순위표까지 간다', () => {
    const m = createMatch({ rules: { mode: 'ffa', ruleset: 'knife', loadoutMs: 0, spawnProtectMs: 0 }, players: [{ id: 'a' }, { id: 'b' }] });
    m.start();
    m.tick(1);
    m.claimHit({ attackerId: 'a', victimId: 'b', weaponId: 'ml_knife', dist: 1, kind: 'stab' });
    const out = decodeMatch(wire(encodeMatch(1, m.snapshot(), [])));
    const view = applySnapshot(out.snapshot);
    assert.deepEqual(view, m.state);
    assert.equal(view.rules.ruleset, 'knife');
    assert.equal(standings(view).ranking[0].id, 'a');
  });

  test('경기 스냅샷의 플레이어 표와 코드', () => {
    const out = decodeMatch(wire(encodeMatch(2, {
      phase: 'live', round: 3, score: { owner: 1, charterer: 2 }, endsAt: 500,
      players: { u1: { team: 'owner', hp: 80, alive: true, kills: 2, deaths: 1, extra: 'keep' }, __proto__x: {} }
    })));
    assert.equal(out.snapshot.phase, 'live');
    assert.equal(out.snapshot.round, 3);
    assert.deepEqual(out.snapshot.score, { owner: 1, charterer: 2 });
    assert.equal(out.snapshot.players.u1.extra, 'keep');
    assert.equal(out.snapshot.players.u1.hp, 80);
    assert.ok(PHASE_CODES.includes('roundEnd'));
    assert.deepEqual(TEAM_CODES, ['owner', 'charterer']);
    assert.ok(KIND_CODES.includes('stab'));
  });

  test('프로토타입 오염 키는 들어오지 않는다', () => {
    const evil = JSON.parse('[1, "damage", "a", "v", 5, "body", 90, {"__proto__":{"polluted":1},"constructor":1,"ok":2}]');
    const d = decodeMatchEvent(evil);
    assert.equal(d.ok, 2);
    assert.equal({}.polluted, undefined);
    assert.equal(Object.getPrototypeOf(d), Object.prototype);
    const raw = JSON.parse('[1,0,0,0,0,0,[["__proto__",0,1,1,0,0,{"polluted":2}],["u",0,1,1,0,0,{"__proto__":{"polluted":3}}]],[],{"__proto__":{"polluted":4},"k":1}]');
    const m = decodeMatch(raw);
    assert.equal({}.polluted, undefined);
    assert.deepEqual(Object.keys(m.snapshot.players), ['u']);
    assert.equal(m.snapshot.k, 1);
  });
});

describe('쓰레기 입력', () => {
  test('어떤 디코더도 던지지 않는다', () => {
    const decoders = [decodeState, decodeFire, decodeHit, decodeGrenade, decodeMatch, decodeMatchEvent, decodeLoadout, decodeChat, decodePing];
    for (const fn of decoders) {
      for (const g of GARBAGE) assert.doesNotThrow(() => fn(g), fn.name);
    }
    for (const name of Object.values(EV)) {
      for (const g of GARBAGE) {
        const res = decodeMessage(name, g);
        assert.ok(res === null || (typeof res.type === 'string' && res.data), name);
      }
    }
    for (const g of GARBAGE) assert.equal(decodeMessage(g, []), null);
  });

  test('무작위로 깨뜨린 진짜 메시지도 던지지 않는다', () => {
    let seed = 12345;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
    const m = createMatch({ rules: { loadoutMs: 0 }, players: [{ id: 'a', team: 'owner' }, { id: 'b', team: 'charterer' }] });
    m.start();
    const good = [
      [EV.state, encodeState(1, 2, { pos: [1, 2, 3], yaw: 1 })],
      [EV.fire, encodeFire(1, { weaponId: 'ar_std', origin: [0, 0, 0], dir: [0, 0, 1], hit: [0, 0, 5], hitKind: 'world' })],
      [EV.hit, encodeHit(1, { victimId: 'b', part: 'hand', weaponId: 'sr_bolt', dist: 5, shotT: 1, count: 2, shotId: 3 })],
      [EV.grenade, encodeGrenade(1, { pos: [0, 0, 0], vel: [1, 1, 1], t: 1 })],
      [EV.match, encodeMatch(1, m.snapshot(), [encodeMatchEvent(1, { type: 'kill', killer: 'a', victim: 'b' })])],
      [EV.loadout, encodeLoadout(1, { primary: 'sr_bolt' })],
      [EV.chat, encodeChat(1, 'hi')],
      [EV.ping, encodePong(1, 1, 2, 3, 4, 5)]
    ];
    for (let i = 0; i < 4000; i++) {
      const [name, payload] = pick(good);
      const a = wire(payload);
      const edits = 1 + Math.floor(rnd() * 3);
      for (let e = 0; e < edits; e++) a[Math.floor(rnd() * (a.length + 2))] = pick(GARBAGE.filter((g) => typeof g !== 'function' && typeof g !== 'symbol'));
      assert.doesNotThrow(() => decodeMessage(name, a));
      const res = decodeMessage(name, a);
      if (res && res.type === 'hit') {
        assert.ok(Number.isInteger(res.data.count) && res.data.count >= 1 && res.data.count <= 64);
        assert.ok(res.data.shotId === null || (Number.isInteger(res.data.shotId) && res.data.shotId > 0));
        assert.ok(res.data.dist >= 0);
      }
    }
  });

  test('applySnapshot과 claimHit도 깨진 입력에 던지지 않는다', () => {
    for (const g of GARBAGE) {
      assert.doesNotThrow(() => applySnapshot(g));
      assert.doesNotThrow(() => applySnapshot({ v: 1, p: [g], rs: g, ru: g, h: g, sc: g, res: g, ph: g }));
      assert.doesNotThrow(() => applySnapshot({ v: 1, mo: 'ffa', p: [g], rs: g, ru: g, res: g }));
    }
    const m = createMatch({ rules: { loadoutMs: 0 }, players: [{ id: 'a', team: 'owner' }, { id: 'b', team: 'charterer' }] });
    m.start();
    m.tick(1);
    for (const g of GARBAGE) {
      if (typeof g === 'symbol') continue;
      assert.doesNotThrow(() => m.claimHit(g));
      assert.doesNotThrow(() => m.claimHit({ attackerId: 'a', victimId: 'b', weaponId: 'ar_std', part: g, dist: 1, count: g, shotId: g, t: g, kind: g }));
      assert.doesNotThrow(() => m.claimExplosion({ attackerId: 'a', victims: g, center: g }));
      assert.doesNotThrow(() => m.setLoadout('a', g));
    }
  });
});
