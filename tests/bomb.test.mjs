/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 폭파 미션 규칙 시험. 설치·해체·폭발·전멸·시간 종료·공수 교대·폭탄 떨굼/줍기·잘못된 의도 거절·취소, 스냅샷과 프로토콜 왕복, 방장 이전 복원을 검사한다.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createMatch, applySnapshot, DEFAULT_BOMB_RULES, REASON_LABELS } from '../js/game/match.js';
import { restoreMatch, matchSummary } from '../js/game/session.js';
import {
  BOMB, normalizeMission, siteAt, siteContains, sideFor, sideOfTeam, blastDamage, beepInterval, bombTexts, hasMission, placeMission
} from '../js/game/mission.js';
import {
  encodeMatch, decodeMatch, encodeMatchEvent, encodeBomb, decodeBomb, decodeMessage, EV, MATCH_EVENT_FIELDS
} from '../js/game/protocol.js';
import { packRoomKind, unpackRoomKind } from '../js/net/lobby.js';

/* ============================================================ 도우미 */

const MISSION = {
  sites: [{ id: 'A', name: 'A 구역', x: 20, y: 0, z: 0, w: 8, d: 8 }, { id: 'B', name: 'B 구역', x: -20, y: 0, z: 0, w: 8, d: 8 }],
  attack: [{ x: 0, z: 30, rotY: 0 }, { x: 2, z: 30, rotY: 0 }, { x: 4, z: 30, rotY: 0 }],
  defense: [{ x: 0, z: -30, rotY: Math.PI }, { x: 2, z: -30, rotY: Math.PI }, { x: 4, z: -30, rotY: Math.PI }]
};
const A = [20, 0, 0];

/**
 * owner a1·a2 vs charterer d1·d2. 위치는 pos 표로 준다(getPositions). 첫 라운드 공격 = owner.
 * carrier로 폭탄을 받을 사람을 고정한다(시험 재현).
 */
function bombMatch({ carrier = 'a1', rules = {}, players, ...rest } = {}) {
  const pos = { a1: [0, 0, 30], a2: [2, 0, 30], d1: [0, 0, -30], d2: [2, 0, -30] };
  const m = createMatch({
    rules: { mode: 'bomb', ...rules }, mission: MISSION, seed: 3,
    players: players || [{ id: 'a1', team: 'owner' }, { id: 'a2', team: 'owner' }, { id: 'd1', team: 'charterer' }, { id: 'd2', team: 'charterer' }],
    getPositions: () => pos,
    chooseCarrier: (ids) => (carrier && ids.includes(carrier) ? carrier : null),
    ...rest
  });
  return { m, pos };
}
/** start → loadout 끝까지 진행(live 시작) */
function toLive(m) {
  const ev = m.start();
  assert.ok(!ev.length || ev[0].type !== 'reject', JSON.stringify(ev[0]));
  return ev.concat(m.tick(DEFAULT_BOMB_RULES.loadoutMs));
}
const of = (evs, type, act) => evs.filter((e) => e.type === type && (act == null || e.act === act));
const roundEnd = (evs) => evs.find((e) => e.type === 'roundEnd') || null;
/** 한 사람을 총으로 쓰러뜨린다(머리 2발이면 충분) */
function kill(m, attackerId, victimId) {
  let evs = [];
  for (let i = 0; i < 4 && !evs.some((e) => e.type === 'kill'); i++) {
    m.tick(300);
    evs = evs.concat(m.claimHit({ attackerId, victimId, weaponId: 'ar_std', part: 'head', dist: 10 }));
  }
  assert.ok(evs.some((e) => e.type === 'kill' && e.victim === victimId), `${victimId} 킬이 나와야 한다: ${JSON.stringify(evs.filter((e) => e.type === 'reject'))}`);
  return evs;
}
/** a1이 A 구역에 설치(3초) */
function plantA(m, pos, id = 'a1') {
  pos[id] = A.slice();
  const s = m.bombIntent(id, 'plant');
  assert.equal(s[0] && s[0].act, 'plantStart', JSON.stringify(s));
  const ev = m.tick(BOMB.plantMs + 50);
  assert.ok(of(ev, 'bomb', 'plant').length === 1, JSON.stringify(ev));
  return ev;
}

/* ============================================================ mission.js */

describe('미션 도우미', () => {
  test('normalizeMission: 구역·진영 스폰을 읽고 이상한 값을 버린다', () => {
    const m = normalizeMission({ mission: { ...MISSION, sites: [...MISSION.sites, { id: 'A', x: 1, z: 1, w: 2, d: 2 }, { x: 'x' }] } });
    assert.equal(m.sites.length, 2);
    assert.deepEqual(m.sites.map((s) => s.id), ['A', 'B']);
    assert.equal(m.attack.length, 3);
    assert.equal(m.sites[0].minX, 16);
    assert.equal(m.sites[0].maxY, 3);
    assert.equal(normalizeMission({ mission: { sites: [] } }), null);
    assert.equal(normalizeMission(null), null);
    assert.equal(hasMission({ mission: MISSION }), true);
    assert.equal(hasMission({ mission: { sites: MISSION.sites, attack: [], defense: [] } }), false);
    // 도 단위 rotY는 라디안으로 바꾼다
    assert.ok(Math.abs(normalizeMission({ sites: MISSION.sites, attack: [{ x: 0, z: 0, rotY: 180 }] }).attack[0].rotY - Math.PI) < 1e-3);
  });

  test('siteAt / siteContains: 상자 안, 높이, 여유', () => {
    const m = normalizeMission(MISSION);
    assert.equal(siteAt(m.sites, [20, 0, 0]).id, 'A');
    assert.equal(siteAt(m.sites, { x: -23.9, y: 0.5, z: 3.9 }).id, 'B');
    assert.equal(siteAt(m.sites, [25, 0, 0]), null);
    assert.equal(siteAt(m.sites, [24.3, 0, 0], 0.5).id, 'A');
    assert.equal(siteAt(m.sites, [20, 5, 0]), null, '구역 위 지붕은 구역이 아니다');
    assert.equal(siteContains(m.sites[0], { x: 20, z: 0 }), true, '높이를 모르면 수평만 본다');
  });

  test('sideFor: 2라운드 뒤 공수 교대, 5라운드는 후반 진영 그대로', () => {
    assert.deepEqual([1, 2, 3, 4, 5].map((r) => sideFor(r, 'owner', 2)), ['owner', 'owner', 'charterer', 'charterer', 'charterer']);
    assert.deepEqual([1, 2, 3].map((r) => sideFor(r, 'charterer', 1)), ['charterer', 'owner', 'owner']);
    assert.equal(sideOfTeam('owner', 'owner'), 'attack');
    assert.equal(sideOfTeam('charterer', 'owner'), 'defense');
    assert.equal(sideOfTeam(null, 'owner'), null);
  });

  test('폭발 피해와 삐 간격', () => {
    assert.equal(blastDamage(0), 500);
    assert.equal(blastDamage(BOMB.blastLethal), 500);
    assert.equal(blastDamage(BOMB.blastRadius), 0);
    assert.ok(blastDamage(10) > blastDamage(13) && blastDamage(13) > 0);
    assert.equal(beepInterval(BOMB.fuseMs), 1000);
    assert.equal(beepInterval(8000), 250);
    assert.equal(beepInterval(2000), 120);
  });

  test('bombTexts: 진영별 목표와 폭탄 상태', () => {
    const atk = bombTexts('attack', { state: 'carried', carrier: 'a1' }, { me: 'a1' });
    assert.match(atk.goal, /A 또는 B/);
    assert.match(atk.status, /내가 폭탄/);
    const def = bombTexts('defense', { state: 'carried', carrier: 'a1' }, { me: 'd1' });
    assert.equal(def.status, '', '수비는 누가 들었는지 모른다');
    assert.match(bombTexts('defense', { state: 'planted', site: 'B' }).goal, /B 구역 폭탄을 해체/);
  });

  test('placeMission: 스폰 높이를 바닥으로 채운다', () => {
    const m = placeMission(normalizeMission(MISSION), {}, () => 1.5, () => 1.5);
    assert.equal(m.attack[0].y, 1.5);
    assert.equal(m.sites.length, 2);
  });
});

/* ============================================================ match.js */

describe('폭파 미션 경기', () => {
  test('규칙 기본값: 1:40, 5판 3선승, 클래식 고정, 설치 3초·해체 5초·폭발 35초', () => {
    const { m } = bombMatch({ rules: { ruleset: 'knife' } });
    assert.equal(m.rules.mode, 'bomb');
    assert.equal(m.rules.ruleset, 'classic');
    assert.equal(m.rules.roundTimeMs, 100000);
    assert.equal(m.rules.roundsToWin, 3);
    assert.equal(m.rules.maxRounds, 5);
    assert.equal(m.rules.plantMs, 3000);
    assert.equal(m.rules.defuseMs, 5000);
    assert.equal(m.rules.fuseMs, 35000);
    assert.equal(m.rules.swapAfter, 2);
    assert.equal(REASON_LABELS.bomb, '폭탄 폭파');
  });

  test('미션 칸이 없으면 시작하지 않는다', () => {
    const m = createMatch({ rules: { mode: 'bomb' }, players: [{ id: 'a', team: 'owner' }, { id: 'b', team: 'charterer' }] });
    assert.equal(m.start()[0].reason, 'no_mission');
  });

  test('라운드 시작: 공격 팀 한 명이 폭탄을 들고 진영 스폰에 선다', () => {
    const { m } = bombMatch({ carrier: null });
    const ev = m.start();
    const rs = ev.find((e) => e.type === 'roundStart');
    assert.equal(rs.attack, 'owner');
    assert.ok(MISSION.attack.some((s) => s.x === rs.spawns.a1.x && s.z === rs.spawns.a1.z), JSON.stringify(rs.spawns));
    assert.ok(MISSION.defense.some((s) => s.x === rs.spawns.d1.x && s.z === rs.spawns.d1.z));
    const give = of(ev, 'bomb', 'give');
    assert.equal(give.length, 1);
    assert.ok(['a1', 'a2'].includes(give[0].id));
    const v = m.state;
    assert.equal(v.mode, 'bomb');
    assert.equal(v.attack, 'owner');
    assert.equal(v.defense, 'charterer');
    assert.equal(v.bomb.state, 'carried');
    assert.equal(v.bomb.carrier, give[0].id);
  });

  test('설치 → 35초 뒤 폭발 → 공격 승, 가까이 있던 사람은 큰 피해', () => {
    const { m, pos } = bombMatch();
    toLive(m);
    const ev = plantA(m, pos);
    const p = of(ev, 'bomb', 'plant')[0];
    assert.equal(p.site, 'A');
    assert.deepEqual(p.pos, A);
    let v = m.state;
    assert.equal(v.bomb.state, 'planted');
    assert.equal(v.bomb.site, 'A');
    assert.ok(v.timeLeftMs > 34000 && v.timeLeftMs <= 35000, '설치 뒤 시계 = 폭발까지 남은 시간');
    // 설치 뒤 라운드 시간(1:40)은 더 이상 끝을 정하지 않는다
    pos.d1 = [21, 0, 0];            // 폭탄 옆(즉사)
    pos.d2 = [20, 0, 12];           // 12 m(큰 피해)
    pos.a1 = [0, 0, 30];
    const boom = m.tick(BOMB.fuseMs);
    assert.equal(of(boom, 'bomb', 'explode').length, 1);
    const end = roundEnd(boom);
    assert.equal(end.winner, 'owner');
    assert.equal(end.reason, 'bomb');
    assert.equal(end.attack, 'owner');
    const dmg = boom.filter((e) => e.type === 'damage');
    assert.ok(dmg.some((e) => e.victim === 'd1' && e.hp === 0 && e.weaponId === 'bomb' && e.self), JSON.stringify(dmg));
    assert.ok(dmg.some((e) => e.victim === 'd2' && e.amount > 0 && e.amount < 100));
    assert.ok(!dmg.some((e) => e.victim === 'a1'), '멀리 있던 사람은 피해가 없다');
    const k = boom.find((e) => e.type === 'kill' && e.victim === 'd1');
    assert.equal(k.killer, 'd1', '폭발 킬은 아무에게도 주지 않는다');
    v = m.state;
    assert.equal(v.bomb.state, 'exploded');
    assert.equal(v.players.find((x) => x.id === 'a1').kills, 0);
    assert.equal(v.players.find((x) => x.id === 'd1').deaths, 1);
    assert.equal(v.history[0].reason, 'bomb');
    assert.equal(v.history[0].attack, 'owner');
  });

  test('해체 → 수비 승. 같은 순간이면 폭발이 먼저다', () => {
    const { m, pos } = bombMatch();
    toLive(m);
    plantA(m, pos);
    pos.d1 = [21, 0, 0.5];
    const s = m.bombIntent('d1', 'defuse');
    assert.equal(s[0].act, 'defuseStart');
    assert.equal(m.state.bomb.action.kind, 'defuse');
    assert.equal(m.state.bomb.action.id, 'd1');
    const ev = m.tick(BOMB.defuseMs + 10);
    assert.equal(of(ev, 'bomb', 'defuse').length, 1);
    const end = roundEnd(ev);
    assert.equal(end.winner, 'charterer');
    assert.equal(end.reason, 'defuse');
    // 폭발 직전에 시작한 해체는 끝나기 전에 터진다
    const b = bombMatch();
    toLive(b.m);
    plantA(b.m, b.pos);
    b.m.tick(BOMB.fuseMs - BOMB.defuseMs);      // 남은 시간 = 정확히 해체 시간
    b.pos.d1 = [20.5, 0, 0];
    assert.equal(b.m.bombIntent('d1', 'defuse')[0].act, 'defuseStart');
    const ev2 = b.m.tick(BOMB.defuseMs + 10);
    assert.equal(roundEnd(ev2).reason, 'bomb');
    assert.equal(of(ev2, 'bomb', 'defuse').length, 0);
  });

  test('설치 전 공격 전멸 → 수비 승 / 수비 전멸 → 공격 승', () => {
    const a = bombMatch();
    toLive(a.m);
    kill(a.m, 'd1', 'a1');
    const ev = kill(a.m, 'd1', 'a2');
    assert.deepEqual([roundEnd(ev).winner, roundEnd(ev).reason], ['charterer', 'elimination']);
    const d = bombMatch();
    toLive(d.m);
    kill(d.m, 'a1', 'd1');
    const ev2 = kill(d.m, 'a1', 'd2');
    assert.deepEqual([roundEnd(ev2).winner, roundEnd(ev2).reason], ['owner', 'elimination']);
  });

  test('설치 뒤 공격이 전멸해도 폭발·해체까지 이어진다. 설치 뒤 수비 전멸은 공격 승', () => {
    const { m, pos } = bombMatch();
    toLive(m);
    plantA(m, pos);
    kill(m, 'd1', 'a1');
    const ev = kill(m, 'd1', 'a2');
    assert.equal(roundEnd(ev), null, '공격 전멸로 끝나지 않는다');
    assert.equal(m.state.phase, 'live');
    const boom = m.tick(BOMB.fuseMs);
    assert.equal(roundEnd(boom).reason, 'bomb');
    const b = bombMatch();
    toLive(b.m);
    plantA(b.m, b.pos);
    kill(b.m, 'a2', 'd1');
    const ev2 = kill(b.m, 'a2', 'd2');
    assert.deepEqual([roundEnd(ev2).winner, roundEnd(ev2).reason], ['owner', 'elimination']);
  });

  test('설치 없이 시간 종료 → 수비 승. 설치 중이어도 끝나기 전 시간이 다 되면 수비 승', () => {
    const { m } = bombMatch();
    toLive(m);
    const ev = m.tick(DEFAULT_BOMB_RULES.roundTimeMs + 10);
    assert.deepEqual([roundEnd(ev).winner, roundEnd(ev).reason], ['charterer', 'time']);
    const b = bombMatch();
    toLive(b.m);
    b.m.tick(DEFAULT_BOMB_RULES.roundTimeMs - 1000);
    b.pos.a1 = A.slice();
    assert.equal(b.m.bombIntent('a1', 'plant')[0].act, 'plantStart');
    const ev2 = b.m.tick(4000);
    assert.equal(roundEnd(ev2).reason, 'time');
    assert.equal(of(ev2, 'bomb', 'plant').length, 0);
  });

  test('폭탄을 든 사람이 죽으면 그 자리에 떨어지고, 공격 팀원만 줍는다', () => {
    const { m, pos } = bombMatch();
    toLive(m);
    pos.a1 = [5, 0, 10];
    m.tick(100);
    const ev = kill(m, 'd1', 'a1');
    const drop = of(ev, 'bomb', 'drop')[0];
    assert.ok(drop, JSON.stringify(ev));
    assert.deepEqual(drop.pos, [5, 0, 10]);
    assert.equal(m.state.bomb.state, 'dropped');
    // 수비는 위에 서도 줍지 못한다
    pos.d1 = [5, 0, 10];
    assert.equal(of(m.tick(200), 'bomb', 'pick').length, 0);
    assert.equal(m.state.bomb.state, 'dropped');
    // 공격 팀원이 닿으면 줍는다
    pos.a2 = [5.5, 0, 10.3];
    const pick = of(m.tick(200), 'bomb', 'pick');
    assert.equal(pick.length, 1);
    assert.equal(pick[0].id, 'a2');
    assert.equal(m.state.bomb.carrier, 'a2');
    // 주운 사람이 설치할 수 있다
    plantA(m, pos, 'a2');
  });

  test('잘못된 의도는 거절한다', () => {
    const { m, pos } = bombMatch();
    m.start();
    assert.equal(m.bombIntent('a1', 'plant')[0].reason, 'not_live', 'loadout 중');
    m.tick(DEFAULT_BOMB_RULES.loadoutMs);
    const reason = (ev) => ev[0] && ev[0].reason;
    assert.equal(reason(m.bombIntent('a1', 'dance')), 'bad_action');
    assert.equal(reason(m.bombIntent('a1', 'plant')), 'not_in_site', '구역 밖');
    pos.a2 = A.slice();
    assert.equal(reason(m.bombIntent('a2', 'plant')), 'no_bomb', '폭탄 없는 공격 팀원');
    pos.d1 = A.slice();
    assert.equal(reason(m.bombIntent('d1', 'plant')), 'not_attacker');
    assert.equal(reason(m.bombIntent('d1', 'defuse')), 'not_planted');
    assert.equal(reason(m.bombIntent('a2', 'defuse')), 'not_defender');
    assert.equal(reason(m.bombIntent('nobody', 'plant')), 'unknown_player');
    plantA(m, pos);
    pos.d2 = [26, 0, 0];
    assert.equal(reason(m.bombIntent('d2', 'defuse')), 'too_far', '1.5 m 밖');
    pos.d1 = [20.4, 0, 0];
    assert.equal(m.bombIntent('d1', 'defuse')[0].act, 'defuseStart');
    pos.d2 = [20, 0, 0.6];
    assert.equal(reason(m.bombIntent('d2', 'defuse')), 'busy', '한 번에 한 명');
    assert.deepEqual(m.bombIntent('d1', 'defuse'), [], '같은 의도를 다시 보내도 그대로');
    const t = createMatch({ rules: { mode: 'team' }, players: [{ id: 'a', team: 'owner' }, { id: 'b', team: 'charterer' }] });
    assert.equal(t.bombIntent('a', 'plant')[0].reason, 'not_bomb');
  });

  test('움직이거나 쏘거나 손을 떼거나 죽으면 취소', () => {
    const { m, pos } = bombMatch();
    toLive(m);
    pos.a1 = A.slice();
    m.bombIntent('a1', 'plant');
    m.tick(500);
    pos.a1 = [21.5, 0, 0];   // 1.5 m 이동
    const moved = m.tick(100);
    assert.equal(of(moved, 'bomb', 'plantCancel')[0].reason, 'moved');
    assert.equal(m.state.bomb.action, null);
    pos.a1 = A.slice();
    m.bombIntent('a1', 'plant');
    const fired = m.claimHit({ attackerId: 'a1', victimId: 'd1', weaponId: 'ar_std', part: 'body', dist: 30 });
    assert.equal(of(fired, 'bomb', 'plantCancel')[0].reason, 'fired');
    m.tick(300);
    m.bombIntent('a1', 'plant');
    const rel = m.bombIntent('a1', 'cancel');
    assert.equal(rel[0].act, 'plantCancel');
    assert.equal(rel[0].reason, 'released');
    assert.deepEqual(m.bombIntent('a2', 'cancel'), [], '다른 사람의 취소는 무시');
    m.bombIntent('a1', 'plant');
    const died = kill(m, 'd1', 'a1');
    assert.equal(of(died, 'bomb', 'plantCancel')[0].reason, 'died');
    assert.equal(of(died, 'bomb', 'drop').length, 1, '죽은 자리에 폭탄이 떨어진다');
    // 3초가 지나도 설치되지 않는다
    assert.equal(of(m.tick(3500), 'bomb', 'plant').length, 0);
  });

  test('공수 교대: 2라운드가 끝나면 바뀌고 5라운드는 후반 진영 그대로', () => {
    const { m } = bombMatch({ carrier: null });
    let ev = toLive(m);
    const attacks = [];
    for (let r = 0; r < 6 && m.state.phase !== 'matchEnd'; r++) {
      const v = m.state;
      attacks.push(v.attack);
      // 이번 라운드 공격 팀이 시간 종료로 진다 → 수비 승
      ev = m.tick(DEFAULT_BOMB_RULES.roundTimeMs + 10);
      assert.equal(roundEnd(ev).reason, 'time');
      ev = m.tick(DEFAULT_BOMB_RULES.roundEndMs + DEFAULT_BOMB_RULES.loadoutMs + 10);
    }
    assert.deepEqual(attacks.slice(0, 4), ['owner', 'owner', 'charterer', 'charterer']);
    const v = m.state;
    assert.equal(v.phase, 'matchEnd');
    assert.deepEqual(v.history.map((h) => h.attack), attacks.slice(0, v.history.length));
    // 1·2라운드는 charterer(수비) 승, 3·4라운드는 owner(수비) 승 → 5라운드(charterer 공격)는 owner 수비 승으로 3:2
    assert.deepEqual(v.score, { owner: 3, charterer: 2 });
    assert.equal(v.history.length, 5);
    assert.equal(v.history[4].attack, 'charterer');
  });

  test('폭탄을 든 사람이 나가면 떨어진다(로드아웃 중이면 다른 팀원에게 간다)', () => {
    const { m, pos } = bombMatch();
    m.start();
    const ev = m.removePlayer('a1');
    const give = of(ev, 'bomb', 'give');
    assert.equal(give.length, 1);
    assert.equal(give[0].id, 'a2');
    m.tick(DEFAULT_BOMB_RULES.loadoutMs);
    pos.a2 = [3, 0, 3];
    m.tick(100);
    const ev2 = m.removePlayer('a2');
    assert.ok(ev2.some((e) => e.type === 'matchEnd' && e.reason === 'forfeit'), '공격 팀이 모두 나가면 상대 승');
  });

  test('스냅샷이 protocol을 거쳐도 폭탄 상태가 그대로다', () => {
    const { m, pos } = bombMatch();
    toLive(m);
    pos.a1 = A.slice();
    const evs = m.bombIntent('a1', 'plant');
    const enc = encodeMatch(5, m.snapshot(), evs.map((e, i) => encodeMatchEvent(i + 1, e)));
    const dec = decodeMatch(JSON.parse(JSON.stringify(enc)));
    const v = applySnapshot(dec.snapshot);
    assert.equal(v.mode, 'bomb');
    assert.equal(v.attack, 'owner');
    assert.equal(v.bomb.state, 'carried');
    assert.equal(v.bomb.action.kind, 'plant');
    assert.equal(v.bomb.action.id, 'a1');
    assert.equal(v.bomb.action.totalMs, 3000);
    assert.equal(v.rules.fuseMs, 35000);
    assert.equal(v.rules.firstAttack, 'owner');
    assert.equal(dec.events[0].act, 'plantStart');
    assert.equal(dec.events[0].id, 'a1');
    m.tick(3100);
    const v2 = applySnapshot(decodeMatch(JSON.parse(JSON.stringify(encodeMatch(6, m.snapshot(), [])))).snapshot);
    assert.equal(v2.bomb.state, 'planted');
    assert.deepEqual(v2.bomb.pos, A);
    assert.equal(v2.bomb.site, 'A');
    assert.ok(v2.bomb.explodeInMs > 34000);
    assert.ok(MATCH_EVENT_FIELDS.bomb.includes('act'));
    assert.ok(JSON.stringify(m.snapshot()).length < 1800);
  });

  test('restoreMatch: 점수·진영을 이어 그 라운드를 처음부터 다시 한다', () => {
    const { m, pos } = bombMatch({ carrier: null });
    toLive(m);
    // 1·2라운드: 시간 종료(수비 charterer 승)
    m.tick(DEFAULT_BOMB_RULES.roundTimeMs + 10);
    m.tick(DEFAULT_BOMB_RULES.roundEndMs + DEFAULT_BOMB_RULES.loadoutMs + 10);
    m.tick(DEFAULT_BOMB_RULES.roundTimeMs + 10);
    m.tick(DEFAULT_BOMB_RULES.roundEndMs + 10);
    const snap = m.snapshot();
    assert.equal(applySnapshot(snap).round, 3);
    const r = restoreMatch({
      snapshot: snap, mission: MISSION, getPositions: () => pos,
      players: [{ id: 'a1', team: 'owner' }, { id: 'a2', team: 'owner' }, { id: 'd1', team: 'charterer' }, { id: 'd2', team: 'charterer' }]
    });
    const ev = r.start();
    const rs = ev.find((e) => e.type === 'roundStart');
    assert.equal(rs.round, 3);
    assert.equal(rs.attack, 'charterer', '3라운드는 후반 진영');
    const v = r.state;
    assert.equal(v.mode, 'bomb');
    assert.deepEqual(v.score, { owner: 0, charterer: 2 });
    assert.deepEqual(v.history.map((h) => h.attack), ['owner', 'owner']);
    assert.ok(of(ev, 'bomb', 'give').length === 1);
    r.tick(DEFAULT_BOMB_RULES.loadoutMs);
    const carrier = r.state.bomb.carrier;
    assert.ok(['d1', 'd2'].includes(carrier));
    pos[carrier] = A.slice();
    assert.equal(r.bombIntent(carrier, 'plant')[0].act, 'plantStart');
    assert.equal(r.mission.sites.length, 2);
  });

  test('결과 기록 요약은 mode bomb를 그대로 싣는다', () => {
    const view = { phase: 'matchEnd', players: [{ id: 'a1', kills: 2, deaths: 1, headshots: 1 }], result: { winner: 'owner' } };
    const s = matchSummary({ view, me: 'a1', mode: 'bomb', ruleset: 'classic', mapId: 'relay', team: 'owner', seconds: 300 });
    assert.equal(s.mode, 'bomb');
    assert.equal(s.win, true);
  });
});

/* ============================================================ protocol · net */

describe('폭탄 의도 메시지(g2b)', () => {
  test('왕복과 깨진 입력', () => {
    assert.deepEqual(decodeBomb(encodeBomb(7, 'plant')), { id: 7, act: 'plant', reason: null });
    assert.deepEqual(decodeBomb(encodeBomb(8, 'defuse')), { id: 8, act: 'defuse', reason: null });
    assert.deepEqual(decodeBomb(encodeBomb(9, 'cancel', 'moved')), { id: 9, act: 'cancel', reason: 'moved' });
    assert.deepEqual(decodeBomb(encodeBomb(9, 'cancel')), { id: 9, act: 'cancel', reason: 'released' });
    assert.equal(decodeBomb([1, 9]), null);
    assert.equal(decodeBomb([1, 1.5]), null);
    assert.equal(decodeBomb('x'), null);
    assert.equal(decodeMessage(EV.bomb, encodeBomb(3, 'plant')).type, 'bomb');
    assert.equal(EV.bomb, 'g2b');
  });

  test('로비 항목은 폭파 미션을 그대로 싣는다', () => {
    assert.equal(packRoomKind('bomb', 'classic'), 'bomb');
    assert.deepEqual(unpackRoomKind('bomb'), { mode: 'bomb', ruleset: 'classic', locked: false });
    assert.equal(unpackRoomKind(packRoomKind('bomb', 'classic', true)).locked, true);
  });
});
