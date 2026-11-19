/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 좀비 물량 막기 화면 쪽 진행(horde/client.js) 시험. 작은 가짜 world·ui·input으로 멀티 살리기(F 누르고 있기 → 바로 on, 0.3초마다 다시,
 *          떼거나 멀어지거나 쓰러지면 off 한 번, 안내 줄·휴대폰 버튼), 방장이 잰 밀려남(같은 번호는 한 번, 오래된 것은 버림),
 *          탄창 줍기의 수류탄 채우기 안내, 쓰러짐·살리기 소식과 HUD 살리기 막대·동료 줄, 증강 값 넘기기, 검기 피해 숫자, F 키 입력 상태를 확인한다.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHordeClient } from '../js/game/horde/client.js';
import { HORDE } from '../js/game/horde/rules.js';
import { GRENADE_IDS, PRIMARY_IDS, WEAPONS } from '../js/weapons/defs.js';
import { createBus } from '../js/core/bus.js';

const NAMES = { me: '하늘', b: '구름', c: '바다' };
const NADE = GRENADE_IDS[0];

/** applyHordeSnapshot이 내는 사람 한 줄과 같은 모양 */
function player(id, over = {}) {
  return {
    id, name: NAMES[id] || id, hp: 100, maxHp: 100, alive: true, kills: 0, connected: true, cards: [], offer: [], rerolls: 0, picked: false, downs: 0,
    damage: 0, shield: 0, heads: 0, bossKills: 0, hurt: null, spawned: true, picks: 0, chest: false, offerLeftMs: 0, invuln: false, invulnMs: 0,
    knock: null, down: null, ...over
  };
}
const downed = (id, pos, over = {}) => player(id, { alive: false, hp: 0, down: { pos, progress: 0, by: null }, ...over });
/** applyHordeSnapshot 결과와 같은 모양의 뷰(웨이브 중) */
function view(players, over = {}) {
  return {
    mode: 'zombie', phase: 'wave', stage: 2, firstStage: 1, timeLeftMs: null, elapsedMs: 30000, seed: 1, stageLeftMs: 20000,
    xp: { level: 2, xp: 3, need: 20, total: 13 }, left: 10, total: 30, killedStage: 5, recentBosses: [],
    players, zombies: [], bosses: [], projectiles: [], hazards: [], fx: [], loot: [], fields: [], decoys: [], over: null, ...over
  };
}

/** performance.now를 시험 시계로(client.js가 frame에서 읽는다) */
function mockNow(t) {
  const clock = { t: 50000 };
  t.mock.method(performance, 'now', () => clock.t);
  return clock;
}

function fakeWorld() {
  const log = [];
  const handlers = new Map();
  const ammo = { ar_std: { mag: 30, reserve: 20, max: 90, size: 30 }, pt_std: { mag: 12, reserve: 24, max: 72, size: 12 } };
  const w = {
    pos: [0, 0, 0], localAlive: true, nades: 1, nadeMax: 4, ammo,
    log,
    calls: (name) => log.filter((c) => c[0] === name).map((c) => c[1]),
    last: (name) => { const l = w.calls(name); return l.length ? l[l.length - 1] : undefined; },
    on(evt, fn) { handlers.set(evt, fn); return () => handlers.delete(evt); },
    fire(evt, payload) { const fn = handlers.get(evt); if (fn) fn(payload); },
    getLocalState: () => ({ pos: w.pos.slice(), alive: w.localAlive }),
    spawnLocal(o) { log.push(['spawnLocal', o]); w.localAlive = true; },
    openSwap(o) { log.push(['openSwap', o]); },
    closeSwap() { log.push(['closeSwap', {}]); },
    killLocal() { log.push(['killLocal', {}]); w.localAlive = false; },
    pushLocal(v) { log.push(['pushLocal', v]); },
    setHordeInteract(o) { log.push(['setHordeInteract', o]); },
    setHordePerks(o) { log.push(['setHordePerks', o]); },
    setLocalHp(hp) { log.push(['setLocalHp', hp]); },
    hordeDamageNumber(at, n, kind) { log.push(['hordeDamageNumber', { at, n, kind }]); },
    refillGrenades() { log.push(['refillGrenades', w.nadeMax]); w.nades = w.nadeMax; return w.nades; },
    addReserve(n, id) { const a = ammo[id]; const add = a ? Math.max(0, Math.min(a.max - a.reserve, Math.floor(n))) : 0; if (a) a.reserve += add; log.push(['addReserve', { n, id, add }]); return add; },
    internals: {
      arsenal: {
        getLoadout: () => ({ primary: 'ar_std', secondary: 'pt_std', melee: 'ml_knife' }),
        getAmmo(id = 'ar_std') {
          if (id === NADE) return { weaponId: id, kind: 'count', mag: w.nades, magSize: w.nadeMax, reserve: 0 };
          const a = ammo[id];
          return a ? { weaponId: id, kind: 'mag', mag: a.mag, magSize: a.size, reserve: a.reserve, reserveMax: a.max } : { weaponId: id, kind: 'none', mag: null };
        }
      }
    }
  };
  return w;
}

function fakeUi() {
  const log = [];
  const visible = new Set();
  const hud = { centers: [], callouts: [], banners: [], center(text, ms, o) { hud.centers.push({ text, ms, ...(o || {}) }); }, callout(text) { hud.callouts.push(text); }, banner(b) { hud.banners.push(b); } };
  return {
    hud, log,
    show(name, props) { visible.add(name); log.push({ kind: 'show', name, props }); },
    update(name, props) { log.push({ kind: 'update', name, props }); },
    hide(name) { visible.delete(name); },
    isVisible: (name) => visible.has(name),
    on: () => () => {},
    /** 그 화면에 마지막으로 넘긴 값 */
    lastProps(name) { const l = log.filter((c) => c.name === name); return l.length ? l[l.length - 1].props : null; }
  };
}

/** 화면 쪽 진행 하나: 멀티(살리기 있음)가 기본. sent = 방장에게 보낸 살리기 [id, on] */
function rig(t, { solo = false, revive = true, touchMode = false } = {}) {
  const clock = mockNow(t);
  const world = fakeWorld();
  const ui = fakeUi();
  const input = { state: { interact: false, use: false }, touchMode, locked: true };
  const sent = [];
  const feed = [];
  const actions = { pick() {}, reroll() {}, loot() {} };
  if (revive) actions.revive = (id, on) => sent.push([id, on]);
  const client = createHordeClient({ world, ui, meId: 'me', myName: () => NAMES.me, input, solo, actions, onFeed: (line) => feed.push(line) });
  const env = {
    clock, world, ui, input, sent, feed, client,
    apply(players, events = [], over = {}) { client.apply(view(players, over), events, clock.t); },
    frame(ms = 16) { clock.t += ms; client.frame(ms / 1000); }
  };
  return env;
}

describe('무기 고르기 창(준비 시간)', () => {
  test('모든 주무기와 함께 좀비 전용 기관총이 목록 끝에 들고, 카드의 탄은 이 모드의 양(예비 3배)이다', (t) => {
    const env = rig(t, { solo: true });
    env.apply([player('me')], [{ type: 'spawn', id: 'me', spawn: { x: 1, y: 0, z: 2 } }], { phase: 'prep', stage: 0 });
    const swap = env.world.last('openSwap');
    assert.ok(swap, '처음 나올 때 무기 고르기 창을 연다');
    assert.equal(swap.free, true);
    assert.equal(swap.ruleset, 'classic');
    // 카드는 무기 id로 그린다(UI 무기 표에 좀비 전용 무기도 들어 있다: game/index.js ui.setWeapons)
    assert.deepEqual(swap.weapons, [...PRIMARY_IDS], '모든 주무기가 표 순서대로, 기관총이 맨 끝');
    assert.equal(swap.weapons.at(-1), 'mg_m249');
    assert.ok(WEAPONS.mg_m249.stats.some((s) => s.label === '이동' && s.value === '70%'), '카드 자료에 이동 70%가 있다');
    assert.equal(swap.ammo.mg_m249, '100/600');
    assert.equal(swap.ammo.ar_std, '30/180');
  });

  test('기관총을 든 채 쓰러졌다 일어나도 고른 무기를 그대로 쓰도록 loadout 값을 넘긴다', (t) => {
    const clock = mockNow(t);
    const world = fakeWorld();
    let picked = 'mg_m249';
    const client = createHordeClient({ world, ui: fakeUi(), meId: 'me', myName: () => NAMES.me, solo: true, loadout: () => picked, actions: { pick() {}, reroll() {}, loot() {} } });
    client.apply(view([player('me')], { phase: 'wave' }), [{ type: 'spawn', id: 'me', spawn: { x: 1, y: 0, z: 2 }, revive: false }], clock.t);
    assert.equal(world.last('spawnLocal').loadout, 'mg_m249');
    picked = 'ar_std';
    client.apply(view([player('me')], { phase: 'wave' }), [{ type: 'spawn', id: 'me', spawn: { x: 1, y: 0, z: 2 }, revive: false }], clock.t + 50);
    assert.equal(world.last('spawnLocal').loadout, 'ar_std');
  });
});

describe('멀티 살리기', () => {
  test('쓰러진 동료 옆에서 F를 누르면 바로 on, 누르는 동안 0.3초마다 다시, 떼면 off를 한 번 보낸다', (t) => {
    const env = rig(t);
    env.apply([player('me'), downed('b', [1, 0, 0])]);
    env.frame();
    assert.deepEqual(env.sent, [], '누르기 전에는 보내지 않는다');
    assert.deepEqual(env.world.last('setHordeInteract'), { hint: 'F 길게 눌러 🩹 구름 살리기 (3초)', touch: false }, '가까이 가면 안내 줄');
    env.input.state.interact = true;
    env.frame();
    assert.deepEqual(env.sent, [['b', true]], '누른 순간 바로 on');
    assert.deepEqual(env.world.last('setHordeInteract'), { hint: '🩹 구름 살리는 중…', touch: false });
    env.frame(100);
    env.frame(100);
    assert.equal(env.sent.length, 1, '0.3초 안에는 다시 보내지 않는다');
    env.frame(100);
    assert.deepEqual(env.sent, [['b', true], ['b', true]], '0.3초마다 다시 알린다');
    for (let i = 0; i < 6; i++) env.frame(100);
    assert.equal(env.sent.filter(([, on]) => on).length, 4, '0.9초 더 누르면 세 번 더');
    env.input.state.interact = false;
    env.frame();
    assert.deepEqual(env.sent.at(-1), ['b', false], '떼면 off');
    const n = env.sent.length;
    for (let i = 0; i < 10; i++) env.frame(100);
    assert.equal(env.sent.length, n, 'off는 한 번만');
    assert.deepEqual(env.world.last('setHordeInteract'), { hint: 'F 길게 눌러 🩹 구름 살리기 (3초)', touch: false }, '떼면 다시 안내');
  });

  test('E(휴대폰 살리기 버튼, state.use)로도 살리고, 멀어지면 off를 한 번 보내고 안내를 거둔다', (t) => {
    const env = rig(t);
    env.apply([player('me'), downed('b', [1.2, 0.2, 0.4])]);
    env.input.state.use = true;
    env.frame();
    assert.deepEqual(env.sent, [['b', true]]);
    // 살리던 동료는 reviveTouchM보다 조금 멀어져도 이어 간다(경계에서 껐다 켜지 않게)
    env.world.pos = [-(HORDE.reviveTouchM + 0.2) + 1.2, 0, 0.4];
    env.frame(300);
    assert.deepEqual(env.sent.at(-1), ['b', true], '조금 멀어져도 그대로');
    env.world.pos = [-6, 0, 0];
    env.frame();
    assert.deepEqual(env.sent.at(-1), ['b', false], '멀어지면 off');
    assert.equal(env.world.last('setHordeInteract'), null, '살릴 사람이 없으면 안내를 거둔다');
    const n = env.sent.length;
    env.frame(400);
    assert.equal(env.sent.length, n, '누르고 있어도 멀면 보내지 않는다');
  });

  test('처음 고를 때는 reviveTouchM 안의 가장 가까운 사람, 높이 차가 크거나 멀면 안내가 없다', (t) => {
    const env = rig(t);
    env.apply([player('me'), downed('b', [HORDE.reviveTouchM + 0.3, 0, 0]), downed('c', [0, 2, 0])]);
    env.frame();
    assert.equal(env.world.calls('setHordeInteract').length, 0, '멀거나 다른 층이면 안내가 없다');
    env.apply([player('me'), downed('b', [1.5, 0, 0]), downed('c', [0.8, 0.3, 0])]);
    env.input.state.interact = true;
    env.frame();
    assert.deepEqual(env.sent, [['c', true]], '가까운 사람부터');
    // 살리는 중에 다른 사람이 더 가까이 와도 바꾸지 않는다
    env.apply([player('me'), downed('b', [0.2, 0, 0]), downed('c', [0.8, 0.3, 0])]);
    env.frame(300);
    assert.deepEqual(env.sent.at(-1), ['c', true]);
  });

  test('내가 쓰러지거나 동료가 일어나면 off를 한 번 보내고, 증강을 고르는 동안이나 웨이브 밖에서는 살리지 않는다', (t) => {
    const env = rig(t);
    env.apply([player('me'), downed('b', [1, 0, 0])]);
    env.input.state.interact = true;
    env.frame();
    assert.deepEqual(env.sent, [['b', true]]);
    // 내가 쓰러짐(방장 스냅샷)
    env.apply([downed('me', [0, 0, 0]), downed('b', [1, 0, 0])], [{ type: 'down', id: 'me' }]);
    env.frame();
    assert.deepEqual(env.sent, [['b', true], ['b', false]]);
    assert.equal(env.world.last('setHordeInteract'), null);
    // 다시 일어나 살리다가, 동료가 일어남(다음 스테이지 부활 등)
    env.world.localAlive = true;
    env.apply([player('me'), downed('b', [1, 0, 0])], [{ type: 'spawn', id: 'me', spawn: { x: 0, y: 0, z: 0, rotY: 0 }, hp: 50, maxHp: 100 }]);
    env.frame();
    assert.deepEqual(env.sent.at(-1), ['b', true]);
    env.apply([player('me'), player('b')]);
    env.frame();
    assert.deepEqual(env.sent.at(-1), ['b', false], '일어나면 off');
    // 증강을 고르는 동안
    const n = env.sent.length;
    env.apply([player('me', { offer: ['hp1', 'power1', 'sprint1'] }), downed('b', [1, 0, 0])]);
    env.frame(300);
    assert.equal(env.sent.length, n, '증강을 고르는 동안에는 보내지 않는다');
    assert.equal(env.world.last('setHordeInteract'), null);
    // 웨이브가 아닐 때(전멸 뒤 등)
    env.apply([player('me'), downed('b', [1, 0, 0])], [], { phase: 'over' });
    env.frame(300);
    assert.equal(env.sent.length, n, '웨이브 밖에서는 보내지 않는다');
  });

  test('휴대폰이면 안내 글이 바뀌고 살리기 버튼(touch)을 켠다', (t) => {
    const env = rig(t, { touchMode: true });
    env.apply([player('me'), downed('b', [1, 0, 0])]);
    env.frame();
    assert.deepEqual(env.world.last('setHordeInteract'), { hint: '살리기 버튼을 3초 누르고 있으세요 · 🩹 구름', touch: true });
    env.input.state.use = true;
    env.frame();
    assert.deepEqual(env.world.last('setHordeInteract'), { hint: '🩹 구름 살리는 중…', touch: true });
    assert.deepEqual(env.sent, [['b', true]]);
    const before = env.world.calls('setHordeInteract').length;
    env.frame();
    env.frame();
    assert.equal(env.world.calls('setHordeInteract').length, before, '바뀔 때만 넘긴다');
  });

  test('혼자(solo)거나 살리기 동작이 없으면 안내도 요청도 없다. 끝낼 때 안내를 거두고 살리던 것은 off', (t) => {
    for (const opt of [{ solo: true }, { revive: false }]) {
      const env = rig(t, opt);
      env.apply([player('me'), downed('b', [1, 0, 0])]);
      env.input.state.interact = true;
      env.frame();
      env.frame(300);
      assert.deepEqual(env.sent, [], JSON.stringify(opt));
      assert.equal(env.world.calls('setHordeInteract').filter(Boolean).length, 0, JSON.stringify(opt));
      env.client.dispose();
    }
    const env = rig(t);
    env.apply([player('me'), downed('b', [1, 0, 0])]);
    env.input.state.interact = true;
    env.frame();
    env.client.dispose();
    assert.deepEqual(env.sent, [['b', true], ['b', false]], 'dispose → off');
    assert.equal(env.world.last('setHordeInteract'), null, 'dispose → 안내를 거둔다');
  });

  test('HUD: 내가 살리는 중이면 가운데 막대, 쓰러진 나를 동료가 살리면 그 막대, 동료 줄에 살리기 상태', (t) => {
    const env = rig(t);
    env.apply([player('me'), downed('b', [1, 0, 0], { down: { pos: [1, 0, 0], progress: 0.5, by: 'me' } }), downed('c', [9, 0, 0])]);
    const p = env.ui.lastProps('horde');
    assert.deepEqual(p.revive, { text: '🩹 구름 살리는 중', frac: 0.5, down: false });
    const rows = Object.fromEntries(p.team.map((r) => [r.id, r]));
    assert.deepEqual(rows.b.down, { by: 'me', progress: 0.5 });
    assert.deepEqual(rows.c.down, { by: null, progress: 0 });
    assert.equal(rows.me.down, null);
    assert.equal(rows.b.canRevive, true, '멀티에서 쓰러진 자리가 있으면 동료가 살릴 수 있다');
    assert.equal(rows.c.canRevive, true);
    assert.equal(rows.me.canRevive, false, '살아 있는 줄은 살릴 일이 없다');
    env.apply([downed('me', [0, 0, 0], { down: { pos: [0, 0, 0], progress: 0.25, by: 'b' } }), player('b')]);
    assert.deepEqual(env.ui.lastProps('horde').revive, { text: '🩹 구름님이 살리는 중', frac: 0.25, down: true });
    env.apply([downed('me', [0, 0, 0]), player('b')]);
    assert.equal(env.ui.lastProps('horde').revive, null, '아무도 살리지 않으면 막대가 없다');
    const solo = rig(t, { solo: true });
    solo.apply([player('me'), downed('b', [1, 0, 0], { down: { pos: [1, 0, 0], progress: 0.5, by: 'me' } })]);
    assert.equal(solo.ui.lastProps('horde').revive, null);
    assert.ok(solo.ui.lastProps('horde').team.every((r) => r.canRevive === false), '혼자는 살리기가 없다');
  });
});

describe('살리기·쓰러짐 소식', () => {
  test("'revive': 일어난 나는 가운데 안내, 살린 나는 콜아웃, 다른 사람은 누가 누구를 살렸는지. 채팅 줄도 남긴다", (t) => {
    const env = rig(t);
    env.apply([player('me'), downed('b', [1, 0, 0]), player('c')]);
    env.world.localAlive = false;
    env.apply([downed('me', [0, 0, 0]), downed('b', [1, 0, 0]), player('c')]);
    env.apply([player('me', { hp: HORDE.reviveHp, invuln: true, invulnMs: HORDE.reviveInvulnMs }), downed('b', [1, 0, 0]), player('c')], [
      { type: 'spawn', id: 'me', spawn: { x: 0, y: 0, z: 0, rotY: 1 }, hp: HORDE.reviveHp, maxHp: 100, revive: true, by: 'c' },
      { type: 'revive', id: 'me', by: 'c' }
    ]);
    assert.equal(env.world.last('spawnLocal').spawn.x, 0, '쓰러진 자리에서 일어난다');
    assert.equal(env.world.last('spawnLocal').keepArsenal, true, '살리기는 쓰러질 때의 무기·탄을 그대로 쓴다(새 탄 없음)');
    assert.equal(env.world.last('setLocalHp'), HORDE.reviveHp);
    const c = env.ui.hud.centers.at(-1);
    assert.equal(c.text, '다시 일어났어요!');
    assert.equal(c.sub, '바다님이 살렸어요 · 2초 무적');
    assert.equal(env.feed.at(-1), '🩹 바다님이 하늘님을 살렸어요');
    env.apply([player('me'), player('b'), player('c')], [{ type: 'revive', id: 'b', by: 'me' }]);
    assert.equal(env.ui.hud.callouts.at(-1), '🩹 구름님을 살렸어요');
    env.apply([player('me'), player('b'), player('c')], [{ type: 'revive', id: 'b', by: 'c' }]);
    assert.equal(env.ui.hud.callouts.at(-1), '🩹 바다님이 구름님을 살렸어요');
    assert.equal(env.feed.at(-1), '🩹 바다님이 구름님을 살렸어요');
  });

  test("'down': 멀티는 F로 살릴 수 있다고, 혼자는 예전 안내", (t) => {
    const multi = rig(t);
    multi.apply([player('me'), player('b')]);
    multi.apply([downed('me', [0, 0, 0]), player('b')], [{ type: 'down', id: 'me' }]);
    assert.equal(multi.ui.hud.centers.at(-1).sub, '동료가 F를 3초 누르면 일어나요 · 아니면 다음 스테이지에');
    assert.equal(multi.world.calls('killLocal').length, 1);
    const solo = rig(t, { solo: true });
    solo.apply([player('me')]);
    solo.apply([downed('me', [0, 0, 0])], [{ type: 'down', id: 'me' }]);
    assert.equal(solo.ui.hud.centers.at(-1).sub, '동료가 이번 스테이지를 깨면 다음 스테이지에 일어나요');
  });
});

describe('밀려남', () => {
  test('방장이 잰 밀려남은 같은 번호면 한 번만 걸고, knockKeepMs보다 오래된 것과 쓰러진 뒤의 것은 버린다', (t) => {
    const env = rig(t);
    env.apply([player('me', { knock: { seq: 1, v: [3, 2, -1], ago: 40 } })]);
    assert.deepEqual(env.world.calls('pushLocal'), [[3, 2, -1]]);
    env.apply([player('me', { knock: { seq: 1, v: [3, 2, -1], ago: 140 } })]);
    env.apply([player('me', { knock: { seq: 1, v: [3, 2, -1], ago: 240 } })]);
    assert.equal(env.world.calls('pushLocal').length, 1, '스냅샷마다 다시 와도 한 번');
    env.apply([player('me', { knock: { seq: 2, v: [1, 0, 1], ago: HORDE.knockKeepMs + 1 } })]);
    assert.equal(env.world.calls('pushLocal').length, 1, '오래된 것은 버린다');
    env.apply([player('me', { knock: { seq: 2, v: [1, 0, 1], ago: 10 } })]);
    assert.equal(env.world.calls('pushLocal').length, 1, '버린 번호가 다시 와도 걸지 않는다');
    env.apply([player('me', { knock: { seq: 3, v: [0, 1, 4], ago: HORDE.knockKeepMs } })]);
    assert.deepEqual(env.world.calls('pushLocal').at(-1), [0, 1, 4], '새 번호는 건다');
    env.world.localAlive = false;
    env.apply([downed('me', [0, 0, 0], { knock: { seq: 4, v: [9, 0, 9], ago: 0 } })]);
    assert.equal(env.world.calls('pushLocal').length, 2, '쓰러진 뒤에는 걸지 않는다');
  });
});

describe('탄창 줍기', () => {
  test('탄창을 주우면 예비 탄과 함께 수류탄도 가득 채우고, 늘었을 때만 알린다(같은 이벤트는 한 번)', (t) => {
    const env = rig(t);
    env.apply([player('me')]);
    const loot = (id) => ({ type: 'loot', id, kind: 'mag', by: 'me' });
    env.apply([player('me')], [loot(7)]);
    assert.equal(env.world.ammo.ar_std.reserve, 50, '든 총(주무기)의 예비 탄 +탄창 하나');
    assert.equal(env.world.nades, 4);
    assert.equal(env.ui.hud.callouts.at(-1), '🧷 탄창 +30발 · 💣 수류탄 가득');
    env.apply([player('me')], [loot(7)]);
    assert.equal(env.world.calls('refillGrenades').length, 1, '같은 이벤트는 한 번');
    env.apply([player('me')], [loot(8)]);
    assert.equal(env.ui.hud.callouts.at(-1), '🧷 탄창 +30발', '수류탄이 이미 가득이면 알리지 않는다');
    env.world.ammo.ar_std.reserve = 90; env.world.ammo.pt_std.reserve = 72; env.world.nades = 0;
    env.apply([player('me')], [loot(9)]);
    assert.equal(env.ui.hud.callouts.at(-1), '🧷 탄창 · 예비 탄이 가득해요 · 💣 수류탄 가득', '예비 탄이 가득해도 수류탄은 채운다');
    env.apply([player('me')], [{ type: 'loot', id: 10, kind: 'mag', by: 'b' }]);
    assert.equal(env.world.calls('refillGrenades').length, 3, '남이 주운 탄창은 내 수류탄을 채우지 않는다');
  });
});

describe('증강 값', () => {
  test('C4·검기 증강을 World에 넘기고, 남의 검기 거리도 그 사람 증강으로 잰다', (t) => {
    const env = rig(t);
    env.apply([player('me', { cards: ['c4', 'wave2'] }), player('b', { cards: ['wave1'] })]);
    const k = env.world.last('setHordePerks');
    assert.equal(k.sticky, true);
    assert.equal(k.waveRange, 8);
    assert.equal(k.waveRangeOf('me'), 8);
    assert.equal(k.waveRangeOf('b'), 6);
    assert.equal(k.waveRangeOf('nobody'), 0);
    env.apply([player('me', { cards: ['power1'] })]);
    const k2 = env.world.last('setHordePerks');
    assert.equal(k2.sticky, false);
    assert.equal(k2.waveRange, 0);
  });

  test('검기는 한 번에 여러 마리를 맞혀도 피해 숫자가 줄지 않는다(총알 관통은 그대로 준다)', (t) => {
    const env = rig(t);
    env.apply([player('me')]);
    const claim = (victimId, kind, weaponId, shotId) => env.world.fire('hitClaim', { victimId, part: 'body', weaponId, dist: 3, kind, t: 0, point: [0, 1, 0], count: 1, shotId });
    claim('z1', 'wave', 'ml_knife', 41);
    claim('z2', 'wave', 'ml_knife', 41);
    claim('z3', 'wave', 'ml_knife', 41);
    const waves = env.world.calls('hordeDamageNumber').map((d) => d.n);
    assert.equal(waves.length, 3);
    assert.ok(waves.every((n) => n === waves[0] && n > 0), `검기 피해: ${waves}`);
    claim('z1', 'shot', 'ar_std', 42);
    claim('z2', 'shot', 'ar_std', 42);
    const shots = env.world.calls('hordeDamageNumber').slice(3).map((d) => d.n);
    assert.ok(shots[1] < shots[0], `관통한 총알은 줄어든다: ${shots}`);
  });

  test('광란: 총으로 맞힐 때마다 연사가 한 겹씩(칼은 아니다), 7초 뒤 끝나고, 300겹까지', (t) => {
    const env = rig(t);
    env.apply([player('me', { cards: ['frenzy4'] })]);
    const fire = () => env.world.last('setHordePerks').mods.fire;
    const claim = (kind, weaponId, shotId) => env.world.fire('hitClaim', { victimId: 'z1', part: 'body', weaponId, dist: 3, kind, t: 0, point: [0, 1, 0], count: 1, shotId });
    assert.equal(fire(), 1);
    for (let i = 0; i < 3; i++) claim('shot', 'ar_std', 100 + i);
    assert.ok(Math.abs(fire() - 1.03) < 1e-9, `세 번 맞히면 +3%: ${fire()}`);
    claim('slash', 'ml_knife', 200);
    assert.ok(Math.abs(fire() - 1.03) < 1e-9, '칼은 쌓지 않는다');
    env.frame(7001);
    assert.equal(fire(), 1, '7초 뒤 끝난다');
    for (let i = 0; i < 320; i++) claim('shot', 'ar_std', 300 + i);
    assert.ok(Math.abs(fire() - 4) < 1e-9, `300겹에서 멈춘다: ${fire()}`);
  });
});

/* ---------- input.js: F를 누르고 있는 동안 state.interact(가짜 DOM, tests/movement.test.mjs와 같은 방식) ---------- */
function fakeTarget() {
  const handlers = new Map();
  return {
    addEventListener(type, fn) { if (!handlers.has(type)) handlers.set(type, new Set()); handlers.get(type).add(fn); },
    removeEventListener(type, fn) { const s = handlers.get(type); if (s) s.delete(fn); },
    fire(type, e = {}) { const s = handlers.get(type); if (s) for (const fn of [...s]) fn(e); }
  };
}
async function withFakeDom(fn) {
  const saved = {};
  for (const k of ['window', 'document', 'navigator']) saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
  const win = fakeTarget(), doc = fakeTarget();
  win.innerWidth = 800; win.innerHeight = 600;
  doc.body = fakeTarget();
  doc.pointerLockElement = null;
  doc.fullscreenElement = null;
  const define = (k, value) => Object.defineProperty(globalThis, k, { value, configurable: true, writable: true });
  define('window', win); define('document', doc); define('navigator', { keyboard: null });
  try {
    const { createInput } = await import('../js/engine/input.js');
    const el = fakeTarget();
    const bus = createBus();
    const events = [];
    bus.on('*', (name, data) => events.push({ name, data }));
    const input = createInput({ element: el, bus });
    const key = (type, code, extra = {}) => win.fire(type, { code, repeat: false, target: doc.body, preventDefault() {}, ...extra });
    await fn({ input, win, key, events });
    input.dispose();
  } finally {
    for (const k of ['window', 'document', 'navigator']) {
      if (saved[k]) Object.defineProperty(globalThis, k, saved[k]);
      else delete globalThis[k];
    }
  }
}

describe('input: F 누르고 있기(살리기)', () => {
  test('누르는 동안 state.interact, input:interact는 누를 때와 뗄 때 한 번씩. 살펴보기(input:inspect)도 그대로 낸다', async () => {
    await withFakeDom(({ input, key, events }) => {
      key('keydown', 'KeyF');
      assert.equal(input.state.interact, true);
      key('keydown', 'KeyF', { repeat: true });
      key('keyup', 'KeyF');
      assert.equal(input.state.interact, false);
      assert.deepEqual(events.filter((e) => e.name === 'input:interact').map((e) => e.data.down), [true, false]);
      assert.equal(events.filter((e) => e.name === 'input:inspect').length, 1);
      key('keyup', 'KeyF');
      assert.equal(events.filter((e) => e.name === 'input:interact').length, 2, '눌려 있지 않으면 뗌을 내지 않는다');
    });
  });

  test('입력이 꺼져 있으면 눌리지 않고, 창 포커스를 잃거나 끄면(releaseAll) 떼어진다', async () => {
    await withFakeDom(({ input, win, key, events }) => {
      input.setEnabled(false);
      key('keydown', 'KeyF');
      assert.equal(input.state.interact, false);
      input.setEnabled(true);
      key('keydown', 'KeyF');
      assert.equal(input.state.interact, true);
      win.fire('blur');
      assert.equal(input.state.interact, false, '포커스를 잃으면 뗀다');
      key('keydown', 'KeyF');
      input.setEnabled(false);
      assert.equal(input.state.interact, false, '입력을 끄면 뗀다');
      assert.deepEqual(events.filter((e) => e.name === 'input:interact').map((e) => e.data.down), [true, false, true, false]);
    });
  });
});

describe('검토 뒤 고친 것', () => {
  test('수류탄 증강을 고르면 늘어난 최대까지 가득 찬다(진짜 무기 모듈, 고른 순서와 상관없이)', async (t) => {
    const { createArsenal } = await import('../js/weapons/logic.js');
    mockNow(t);
    const a = createArsenal({ primary: 'ar_std', secondary: 'pt_std', melee: 'ml_knife' });
    const nade = () => a.getAmmo(NADE);
    const world = {
      localAlive: true, internals: { arsenal: a }, on: () => () => {},
      getLocalState: () => ({ pos: [0, 0, 0], alive: true }),
      setHordePerks: (o) => a.setMods(o ? o.mods : null),
      refillGrenades: () => a.refillGrenades(),
      refillReserve: () => a.refillReserve()
    };
    const client = createHordeClient({ world, ui: fakeUi(), meId: 'me', solo: true, actions: { pick() {}, reroll() {}, loot() {} } });
    client.apply(view([player('me')]), [], 0);
    assert.equal(nade().magSize, 1);
    client.apply(view([player('me', { cards: ['pouch1'] })]), [], 0);
    assert.deepEqual([nade().mag, nade().magSize], [6, 6], '주머니 I: 최대 +5, 가득');
    client.apply(view([player('me', { cards: ['pouch1', 'c4'] })]), [], 0);
    assert.deepEqual([nade().mag, nade().magSize], [8, 8], 'C4도 수류탄 증강: 최대 +2, 가득');
    client.dispose();
  });

  test('보급 투하: 고른 즉시는 그대로, 다음 스테이지부터 주·보조 총 탄창·예비 탄과 수류탄을 한 번씩 채운다', async (t) => {
    const { createArsenal } = await import('../js/weapons/logic.js');
    mockNow(t);
    const a = createArsenal({ primary: 'ar_std', secondary: 'pt_std' });
    const world = {
      localAlive: true, on: () => () => {},
      setHordePerks: (o) => a.setMods(o ? o.mods : null),
      refillAmmo: () => a.refillAmmo(),
      refillGrenades: () => a.refillGrenades()
    };
    const client = createHordeClient({ world, ui: fakeUi(), meId: 'me', solo: true, actions: { pick() {}, reroll() {} } });
    client.apply(view([player('me')], { stage: 2 }), [], 0);
    a.equipWith('ar_std', { mag: 4, reserve: 2 });
    a.equipWith('pt_std', { mag: 3, reserve: 1 });
    a.giveGrenade(-1);
    client.apply(view([player('me', { cards: ['drop'] })], { stage: 2 }), [], 0);
    assert.deepEqual([a.getAmmo('ar_std').mag, a.getAmmo('pt_std').mag, a.getAmmo(NADE).mag], [4, 3, 0], '선택 순간에는 채우지 않는다');

    client.apply(view([player('me', { cards: ['drop'] })], { stage: 3 }), [], 0);
    for (const id of ['ar_std', 'pt_std']) {
      const ammo = a.getAmmo(id);
      assert.deepEqual([ammo.mag, ammo.reserve], [ammo.magSize, ammo.reserveMax], id);
    }
    assert.equal(a.getAmmo(NADE).mag, a.getAmmo(NADE).magSize);
    a.equipWith('ar_std', { mag: 1, reserve: 2 });
    client.apply(view([player('me', { cards: ['drop'] })], { stage: 3 }), [], 0);
    assert.equal(a.getAmmo('ar_std').mag, 1, '같은 스테이지의 반복 스냅샷은 다시 채우지 않는다');
    client.apply(view([player('me', { cards: ['drop'] })], { stage: 4 }), [], 0);
    assert.equal(a.getAmmo('ar_std').mag, a.getAmmo('ar_std').magSize);
    client.dispose();
  });

  test('동료가 살리면 쓰러질 때의 장비 그대로(새 탄·교체 창·보조무기 다시 주기 없음), 다음 스테이지 부활은 예전처럼 새 장비', (t) => {
    const env = rig(t);
    env.apply([player('me', { cards: ['sideGl'] }), player('b')]);
    env.world.localAlive = false;
    env.apply([downed('me', [0, 0, 0], { cards: ['sideGl'] }), player('b')], [{ type: 'down', id: 'me' }]);
    const before = env.world.calls('equipSidearm').length;
    env.apply([player('me', { cards: ['sideGl'], hp: HORDE.reviveHp }), player('b')], [
      { type: 'spawn', id: 'me', spawn: { x: 1, y: 0, z: 2, rotY: 0 }, hp: HORDE.reviveHp, maxHp: 100, revive: true, by: 'b' },
      { type: 'revive', id: 'me', by: 'b' }
    ]);
    assert.equal(env.world.last('spawnLocal').keepArsenal, true);
    assert.equal(env.world.calls('equipSidearm').length, before, '보조무기를 새로 주지 않는다');
    env.world.localAlive = false;
    env.apply([downed('me', [0, 0, 0], { cards: ['sideGl'] }), player('b')], [{ type: 'down', id: 'me' }]);
    env.apply([player('me', { cards: ['sideGl'], hp: 50 }), player('b')], [{ type: 'spawn', id: 'me', spawn: { x: 5, y: 0, z: 5, rotY: 0 }, hp: 50, maxHp: 100 }]);
    assert.equal(env.world.last('spawnLocal').keepArsenal, undefined, '다음 스테이지 부활은 새 장비');
  });

  test('살릴 몸이 없는 사람(중간에 들어와 아직 안 나옴)은 동료 줄에 살리기를 말하지 않고, 쓰러진 나에게도 옛 안내', (t) => {
    const env = rig(t);
    env.apply([player('me'), player('c', { alive: false, hp: 0, spawned: false, down: null })]);
    const rows = Object.fromEntries(env.ui.lastProps('horde').team.map((r) => [r.id, r]));
    assert.equal(rows.c.canRevive, false);
    const old = rig(t);
    old.apply([player('me'), player('b')]);
    old.apply([player('me', { alive: false, hp: 0, down: null }), player('b')], [{ type: 'down', id: 'me' }]);
    assert.equal(old.ui.hud.centers.at(-1).sub, '동료가 이번 스테이지를 깨면 다음 스테이지에 일어나요', '옛 방장(쓰러진 자리를 안 보냄)이면 살리기를 약속하지 않는다');
  });

  test('다른 동료가 이미 살리는 중이면 안내 줄이 그 사람을 말한다', (t) => {
    const env = rig(t);
    env.apply([player('me'), downed('b', [1, 0, 0], { down: { pos: [1, 0, 0], progress: 0.4, by: 'c' } }), player('c')]);
    env.frame();
    assert.deepEqual(env.world.last('setHordeInteract'), { hint: '🩹 바다님이 구름 살리는 중', touch: false });
  });

  test('살리기 안내·막대가 떠 있는 동안 아래 경고 줄(무적·탄약)을 감춘다', (t) => {
    const env = rig(t);
    env.apply([player('me', { invuln: true, invulnMs: 2500 }), player('b')]);
    env.frame(250);
    assert.match(env.ui.lastProps('horde').warn, /무적/);
    env.apply([player('me', { invuln: true, invulnMs: 2500 }), downed('b', [1, 0, 0])]);
    env.frame(250);
    assert.equal(env.ui.lastProps('horde').warn, '', '쓰러진 동료 옆(안내 줄이 뜸)');
  });

  test('혼자 하기의 증강 고르기 줄: 보물 상자 몫이면 보물 상자', (t) => {
    const env = rig(t, { solo: true });
    env.apply([player('me', { offer: ['hp1', 'regen1', 'leech1'], picks: 1, chest: true })], [], { phase: 'cards' });
    assert.equal(env.ui.lastProps('horde').pickWhy, 'chest');
    env.apply([player('me', { offer: ['hp1', 'regen1', 'leech1'], picks: 1, chest: false })], [], { phase: 'cards' });
    assert.equal(env.ui.lastProps('horde').pickWhy, 'level');
  });
});
