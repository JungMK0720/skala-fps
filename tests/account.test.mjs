/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: js/account 검증. 가짜 저장소·가짜 서버·가짜 버스로 닉네임, 상점, 포인트, 손상 복구, 동기화, 저장 디바운스를 확인하고
 *          supabase/schema.sql의 규칙이 nickname.js·economy.js와 글자 단위로 같은지 대조한다.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { createBus } from '../js/core/bus.js';
import { createAccount, SAVE_DEBOUNCE_MS, RETRY_MIN_MS } from '../js/account/index.js';
import {
  BOT_SUFFIX, NICKNAME_CHARSET, NICKNAME_MAX, NICKNAME_MIN, NICKNAME_SPACES, RESERVED_NICKNAMES,
  cleanNickname, nicknameKey, validateNickname
} from '../js/account/nickname.js';
import {
  MATCH_POINTS, MAX_POINTS, START_POINTS, defaultOwned, matchReward, priceOf, secretReward
} from '../js/account/economy.js';
import { authHeaders, createRemote, RPC_TIMEOUT_MS } from '../js/account/remote.js';
import {
  PROFILE_KEY, STAT_KEYS, STAT_MAX, TOKEN_KEY, createStore, defaultProfile, generateToken, mergeProfiles, normalizeProfile
} from '../js/account/store.js';
import { DEFAULT_LOADOUT, WEAPON_IDS, getDef } from '../js/weapons/defs.js';

const CONFIG = Object.freeze({ url: 'https://proj.supabase.co', anonKey: 'sb_publishable_test' });
const VALID_TOKEN = 'a'.repeat(64);

const settle = () => new Promise((resolve) => setImmediate(resolve));

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); }
  };
}

function brokenStorage() {
  const fail = () => { throw new Error('SecurityError'); };
  return { getItem: fail, setItem: fail, removeItem: fail };
}

function fakeBus() {
  const events = [];
  return {
    events,
    emit: (event, data) => { events.push({ event, data }); },
    of: (event) => events.filter((e) => e.event === event).map((e) => e.data)
  };
}

/** schema.sql의 RPC를 흉내 낸 서버. 토큰 하나에 한 행, name_key는 전역 유일. */
function fakeServer() {
  const rows = new Map();
  const nameOwners = () => new Map([...rows].map(([token, row]) => [nicknameKey(row.name), token]));
  const handlers = {
    fps_check_nickname({ p_name }) {
      const v = validateNickname(p_name);
      if (!v.ok) return { ok: false, error: v.reason === 'reserved' ? 'NAME_RESERVED' : 'NAME_INVALID' };
      if (nameOwners().has(nicknameKey(v.name))) return { ok: false, error: 'NAME_TAKEN' };
      return { ok: true, name: v.name };
    },
    fps_claim_nickname({ p_token, p_name }) {
      const v = validateNickname(p_name);
      if (!v.ok) return { ok: false, error: v.reason === 'reserved' ? 'NAME_RESERVED' : 'NAME_INVALID' };
      const owner = nameOwners().get(nicknameKey(v.name));
      if (owner && owner !== p_token) return { ok: false, error: 'NAME_TAKEN' };
      const row = rows.get(p_token) || { points: START_POINTS, owned: [], loadout: {}, stats: {}, secrets: {}, createdAt: Date.now() };
      rows.set(p_token, { ...row, name: v.name });
      return { ok: true, name: v.name };
    },
    fps_get_profile({ p_token }) {
      const row = rows.get(p_token);
      return row ? { ok: true, profile: row } : { ok: false, error: 'NOT_FOUND' };
    },
    fps_save_profile({ p_token, p_points, p_owned, p_loadout, p_stats, p_secrets }) {
      const row = rows.get(p_token);
      if (!row) return { ok: false, error: 'NOT_FOUND' };
      rows.set(p_token, { ...row, points: p_points, owned: p_owned, loadout: p_loadout, stats: p_stats, secrets: p_secrets });
      return { ok: true };
    },
    fps_top_players() {
      return { ok: true, players: [...rows.values()].map((r) => ({ name: r.name, kills: r.stats.kills || 0, wins: r.stats.wins || 0, points: r.points })) };
    }
  };
  const server = {
    rows,
    down: false,
    /** Promise를 넣으면 풀릴 때까지 응답을 미룬다 */
    gate: null,
    calls: [],
    count: (fn) => server.calls.filter((c) => c.fn === fn).length,
    last: (fn) => server.calls.filter((c) => c.fn === fn).at(-1),
    /** 다른 기기가 이미 쓰고 있는 이름 */
    takeName: (name) => handlers.fps_claim_nickname({ p_token: 'other'.repeat(13).slice(0, 64), p_name: name }),
    fetch: async (url, init) => {
      const fn = url.split('/rpc/')[1];
      const args = JSON.parse(init.body);
      server.calls.push({ fn, args, url, init });
      if (server.gate) await server.gate;
      if (server.down) throw new TypeError('Failed to fetch');
      return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(handlers[fn](args))) };
    }
  };
  return server;
}

/** 시험이 끝나면 타이머와 리스너를 정리한다 */
function makeAccount(t, opts = {}) {
  const storage = opts.storage === undefined ? fakeStorage() : opts.storage;
  const bus = opts.bus || fakeBus();
  const server = opts.server || null;
  const account = createAccount({
    bus,
    storage,
    target: opts.target || null,
    config: opts.config !== undefined ? opts.config : server ? CONFIG : { url: '', anonKey: '' },
    fetch: server ? server.fetch : undefined
  });
  t.after(() => account.dispose());
  return { account, bus, storage, server };
}

function storedEnvelope(storage) {
  return JSON.parse(storage.getItem(PROFILE_KEY));
}

// ─────────────────────────────── 닉네임 규칙 ───────────────────────────────
describe('validateNickname', () => {
  const cases = [
    // [입력, ok, reason, 정규화된 이름]
    ['철수', true, undefined, '철수'],
    ['Minkyu', true, undefined, 'Minkyu'],
    ['a1', true, undefined, 'a1'],
    ['ㅋㅋ', true, undefined, 'ㅋㅋ'],
    ['under_sc-1', true, undefined, 'under_sc-1'],
    ['가'.repeat(12), true, undefined, '가'.repeat(12)],
    ['abcdefghijkl', true, undefined, 'abcdefghijkl'],
    ['  철  수  ', true, undefined, '철 수'],
    ['철\t\n수', true, undefined, '철 수'],
    ['　철수 ', true, undefined, '철수'],
    ['a b', true, undefined, 'a b'],
    ['철수봇', true, undefined, '철수봇'],
    ['봇철수', true, undefined, '봇철수'],
    ['adminx', true, undefined, 'adminx'],
    ['gm2', true, undefined, 'gm2'],
    ['운영자님', true, undefined, '운영자님'],

    ['', false, 'format', ''],
    ['   ', false, 'format', ''],
    [null, false, 'format', ''],
    [undefined, false, 'format', ''],
    ['a', false, 'format', 'a'],
    ['가', false, 'format', '가'],
    [' 봇', false, 'format', '봇'],
    ['가'.repeat(13), false, 'format', '가'.repeat(13)],
    ['abcdefghijklm', false, 'format', 'abcdefghijklm'],
    ['abc!', false, 'format', 'abc!'],
    ['<b>x</b>', false, 'format', '<b>x</b>'],
    ['철수😀', false, 'format', '철수😀'],
    ['a.b', false, 'format', 'a.b'],
    ['ab​cd', false, 'format', 'ab​cd'],
    ['ㅤㅤ', false, 'format', 'ㅤㅤ'],
    ['日本語', false, 'format', '日本語'],

    ['admin', false, 'reserved', 'admin'],
    ['ADMIN', false, 'reserved', 'ADMIN'],
    [' AdMiN ', false, 'reserved', 'AdMiN'],
    ['관리자', false, 'reserved', '관리자'],
    ['운영자', false, 'reserved', '운영자'],
    ['System', false, 'reserved', 'System'],
    ['GM', false, 'reserved', 'GM'],
    ['gm', false, 'reserved', 'gm'],
    ['null', false, 'reserved', 'null'],
    ['Undefined', false, 'reserved', 'Undefined'],
    ['철수 봇', false, 'reserved', '철수 봇'],
    ['철수   봇', false, 'reserved', '철수 봇'],
    ['bot 봇', false, 'reserved', 'bot 봇'],
    ['철수 봇  ', false, 'reserved', '철수 봇']
  ];

  for (const [input, ok, reason, name] of cases) {
    test(`${JSON.stringify(input)} → ${ok ? 'ok' : reason}`, () => {
      const r = validateNickname(input);
      assert.equal(r.ok, ok);
      assert.equal(r.reason, reason);
      assert.equal(r.name, name);
      assert.match(r.message, /[가-힣]/, '문구는 한국어다');
    });
  }

  test('cleanNickname과 nicknameKey', () => {
    assert.equal(cleanNickname('  Ab  c '), 'Ab c');
    assert.equal(nicknameKey('  AbC  dE '), 'abc de');
    assert.equal(nicknameKey('철수'), '철수');
    assert.equal(cleanNickname(null), '');
    assert.equal(cleanNickname(123), '123');
  });
});

// ─────────────────────────────── 포인트 ───────────────────────────────
describe('economy', () => {
  const sum = (rows) => rows.reduce((total, row) => total + row.points, 0);

  test('시작 포인트와 기본 지급', () => {
    assert.equal(START_POINTS, 500);
    assert.deepEqual(defaultOwned(), WEAPON_IDS.filter((id) => getDef(id).price === 0));
    assert.ok(defaultOwned().includes(DEFAULT_LOADOUT.primary));
    assert.equal(priceOf('sr_heavy'), getDef('sr_heavy').price);
    assert.equal(priceOf('nope'), null);
  });

  test('DESIGN 7절의 표', () => {
    assert.deepEqual({ ...MATCH_POINTS.bot }, { kill: 5, headshot: 3, win: 30, finish: 10 });
    assert.deepEqual({ ...MATCH_POINTS.multi }, { kill: 10, headshot: 5, win: 60, finish: 20 });
  });

  test('봇전 보통: 킬 5, 헤드샷 3, 승리 30, 완주 10', () => {
    const r = matchReward({ online: false, difficulty: 'normal', kills: 4, headshots: 2, win: true });
    assert.equal(r.gained, 4 * 5 + 2 * 3 + 30 + 10);
    assert.equal(sum(r.breakdown), r.gained);
    assert.equal(r.breakdown.length, 4, '배율 1이면 난이도 줄이 없다');
  });

  test('난이도 배율은 봇전에만 적용하고 합계와 맞는다', () => {
    const easy = matchReward({ difficulty: 'easy', kills: 5 });
    assert.equal(easy.gained, 25, '(25 + 10) × 0.7 = 24.5는 반올림해 25');
    assert.equal(sum(easy.breakdown), easy.gained);
    assert.ok(easy.breakdown.at(-1).label.includes('쉬움'));

    const hard = matchReward({ difficulty: 'hard', kills: 10, headshots: 5, win: true });
    assert.equal(hard.gained, Math.round((50 + 15 + 30 + 10) * 1.4));
    assert.equal(sum(hard.breakdown), hard.gained);

    const online = matchReward({ online: true, difficulty: 'hard', kills: 3, headshots: 1, win: true });
    assert.equal(online.gained, 3 * 10 + 5 + 60 + 20);
    assert.ok(online.breakdown.every((row) => !row.label.includes('난이도')));
  });

  test('이상한 입력에도 완주 점수만 준다', () => {
    assert.equal(matchReward(null).gained, 10);
    assert.equal(matchReward({ kills: -3, headshots: 'x', difficulty: 'nightmare' }).gained, 10);
    assert.equal(matchReward({ kills: 2.9 }).gained, 2 * 5 + 10);
  });

  test('무승부는 승리 점수를 받지 않는다', () => {
    assert.equal(matchReward({ win: true, draw: true }).gained, 10);
  });

  test('비밀 스팟 보상', () => {
    assert.equal(secretReward({ id: 's' }), 100);
    assert.equal(secretReward({ id: 's', points: 250 }), 250);
    assert.equal(secretReward({ id: 's', points: 0 }), 0);
    assert.equal(secretReward({ id: 's', points: -5 }), 100);
    assert.equal(secretReward(null), 100);
  });
});

// ─────────────────────────────── 저장소 ───────────────────────────────
describe('store', () => {
  test('토큰은 256비트 hex이고 다시 읽어도 같다', () => {
    const storage = fakeStorage();
    const store = createStore({ storage });
    const token = store.token();
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.equal(store.token(), token);
    assert.equal(createStore({ storage }).token(), token);
    assert.equal(storage.getItem(TOKEN_KEY), token);
    assert.notEqual(generateToken(), generateToken());
  });

  test('깨진 토큰은 새로 만든다', () => {
    const storage = fakeStorage({ [TOKEN_KEY]: 'not-a-token' });
    const token = createStore({ storage }).token();
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.equal(storage.getItem(TOKEN_KEY), token);
  });

  test('저장소를 쓸 수 없어도 세션 동안 같은 토큰을 쓴다', () => {
    for (const storage of [brokenStorage(), null]) {
      const store = createStore({ storage });
      assert.equal(store.load(), null);
      store.save({ profile: defaultProfile(), dirty: false, pendingClaim: null });
      store.clear();
      assert.equal(store.token(), store.token());
    }
  });

  test('프로필 왕복과 버전', () => {
    const storage = fakeStorage();
    const store = createStore({ storage });
    const profile = { ...defaultProfile(1000), nickname: '철수', points: 777 };
    store.save({ profile, dirty: true, pendingClaim: '철수' });
    assert.deepEqual(store.load(), { profile, dirty: true, pendingClaim: '철수' });
    assert.equal(storedEnvelope(storage).v, 1);

    const future = storedEnvelope(storage);
    future.v = 2;
    storage.setItem(PROFILE_KEY, JSON.stringify(future));
    assert.equal(store.load(), null, '모르는 버전은 읽지 않는다');
  });

  test('normalizeProfile은 깨진 항목만 기본값으로 되돌린다', () => {
    const p = normalizeProfile({
      nickname: 'admin',
      points: 'lots',
      owned: ['ar_rapid', 'no_such_weapon', 7, null],
      loadout: { primary: 'sr_heavy', secondary: 'ar_std', melee: 'ml_knife', extra: 'x' },
      stats: { kills: 3, deaths: -1, wins: 'x', hacked: 99, matches: 1e12 },
      secrets: { alley: { roof: { name: '옥상', at: 5 }, ['__proto__']: {} }, ['__proto__']: { a: {} }, bad: 3 },
      createdAt: 'yesterday'
    }, 1234);
    assert.equal(p.nickname, '');
    assert.equal(p.points, START_POINTS);
    assert.ok(p.owned.includes('ar_rapid'));
    assert.ok(!p.owned.includes('no_such_weapon'));
    for (const id of defaultOwned()) assert.ok(p.owned.includes(id));
    assert.equal(p.loadout.primary, DEFAULT_LOADOUT.primary, '가지지 않은 무기');
    assert.equal(p.loadout.secondary, DEFAULT_LOADOUT.secondary, '칸이 맞지 않는 무기');
    assert.equal(p.loadout.melee, 'ml_knife');
    assert.deepEqual(Object.keys(p.loadout).sort(), ['melee', 'primary', 'secondary']);
    assert.equal(p.stats.kills, 3);
    assert.equal(p.stats.deaths, 0);
    assert.equal(p.stats.wins, 0);
    assert.equal(p.stats.matches, STAT_MAX);
    assert.ok(!('hacked' in p.stats));
    assert.deepEqual(Object.keys(p.stats).sort(), [...STAT_KEYS].sort());
    assert.deepEqual(p.secrets, { alley: { roof: { name: '옥상', at: 5 } } });
    assert.equal({}.a, undefined, '프로토타입을 건드리지 않는다');
    assert.equal(p.createdAt, 1234);
    assert.equal(normalizeProfile({ points: 1e12 }).points, MAX_POINTS);
    assert.equal(normalizeProfile({ points: -5 }).points, 0);
  });
});

// ─────────────────────────────── 계정: 첫 실행 · 복구 ───────────────────────────────
describe('createAccount 첫 실행과 복구', () => {
  test('첫 실행에는 닉네임이 없고 기본값으로 시작한다', async (t) => {
    const { account, storage } = makeAccount(t);
    await account.ready;
    assert.equal(account.hasNickname(), false);
    assert.equal(account.remoteEnabled, false);
    assert.equal(account.profile.nickname, '');
    assert.equal(account.profile.points, START_POINTS);
    assert.deepEqual([...account.profile.owned], defaultOwned());
    assert.deepEqual({ ...account.loadout }, { ...DEFAULT_LOADOUT });
    for (const key of STAT_KEYS) assert.equal(account.profile.stats[key], 0);
    assert.deepEqual({ ...account.profile.secrets }, {});
    assert.ok(account.profile.createdAt > 0);
    assert.equal(storage.getItem(PROFILE_KEY), null, '아직 바뀐 것이 없으면 쓰지 않는다');
  });

  test('profile은 얼린 깊은 복사본이다', (t) => {
    const { account } = makeAccount(t);
    const p = account.profile;
    assert.throws(() => { p.points = 1; }, TypeError);
    assert.throws(() => { p.stats.kills = 1; }, TypeError);
    assert.throws(() => { p.owned.push('x'); }, TypeError);
    assert.throws(() => { p.loadout.primary = 'x'; }, TypeError);
    assert.throws(() => { account.loadout.primary = 'x'; }, TypeError);
    assert.equal(account.profile.points, START_POINTS);
    assert.equal(account.profile, p, '바뀌기 전에는 같은 스냅샷을 돌려준다');
    account.recordMatch({ kills: 1 });
    assert.notEqual(account.profile, p);
    assert.equal(p.points, START_POINTS, '옛 스냅샷은 그대로다');
  });

  for (const [label, raw] of [
    ['JSON이 아님', '{{{not json'],
    ['빈 문자열', ''],
    ['null', 'null'],
    ['배열', '[1,2,3]'],
    ['옛 형식', JSON.stringify({ nickname: '철수', points: 99 })],
    ['모르는 버전', JSON.stringify({ v: 99, profile: { nickname: '철수' } })],
    ['profile이 문자열', JSON.stringify({ v: 1, profile: 'x' })]
  ]) {
    test(`손상된 저장소 복구: ${label}`, async (t) => {
      const { account, storage } = makeAccount(t, { storage: fakeStorage({ [PROFILE_KEY]: raw }) });
      await account.ready;
      assert.equal(account.hasNickname(), false);
      assert.equal(account.profile.points, START_POINTS);
      assert.ok(account.buy('pt_magnum').ok, '복구 뒤 정상 동작한다');
      assert.equal(storedEnvelope(storage).v, 1, '손상된 값을 새 값으로 덮어쓴다');
    });
  }

  test('일부만 손상되면 살아 있는 값은 유지한다', (t) => {
    const storage = fakeStorage({
      [PROFILE_KEY]: JSON.stringify({
        v: 1,
        profile: { nickname: '철수', points: 1234, owned: 'broken', loadout: 5, stats: null, secrets: [] },
        sync: 'broken'
      })
    });
    const { account } = makeAccount(t, { storage });
    assert.equal(account.profile.nickname, '철수');
    assert.equal(account.profile.points, 1234);
    assert.deepEqual([...account.profile.owned], defaultOwned());
    assert.deepEqual({ ...account.loadout }, { ...DEFAULT_LOADOUT });
    assert.equal(account.nicknamePending, false);
  });

  test('저장소가 막혀 있어도 게임은 돌아간다', async (t) => {
    const server = fakeServer();
    const { account } = makeAccount(t, { storage: brokenStorage(), server });
    await account.ready;
    assert.equal((await account.setNickname('철수')).ok, true);
    assert.equal(account.profile.nickname, '철수');
    assert.equal(account.buy('pt_magnum').ok, true);
    assert.equal(server.rows.size, 1);
    assert.equal(server.last('fps_claim_nickname').args.p_token, server.last('fps_get_profile').args.p_token, '세션 안에서는 같은 토큰');
  });

  test('다시 켜면 저장한 값이 돌아온다', (t) => {
    const storage = fakeStorage();
    const first = makeAccount(t, { storage }).account;
    first.buy('pt_magnum');
    first.equip('secondary', 'pt_magnum');
    const second = makeAccount(t, { storage }).account;
    assert.equal(second.profile.points, 0);
    assert.equal(second.isOwned('pt_magnum'), true);
    assert.equal(second.loadout.secondary, 'pt_magnum');
  });

  test('resetLocal은 프로필을 지우고 토큰은 남긴다', async (t) => {
    const server = fakeServer();
    const { account, storage, bus } = makeAccount(t, { server });
    await account.ready;
    await account.setNickname('철수');
    const token = storage.getItem(TOKEN_KEY);
    account.resetLocal();
    assert.equal(account.hasNickname(), false);
    assert.equal(account.profile.points, START_POINTS);
    assert.equal(storage.getItem(PROFILE_KEY), null);
    assert.equal(storage.getItem(TOKEN_KEY), token);
    assert.equal(bus.of('account:change').at(-1).profile.nickname, '');
  });

  test('resetLocal 뒤 다시 시작하면 서버 프로필이 돌아온다', async (t) => {
    const server = fakeServer();
    const storage = fakeStorage();
    const first = makeAccount(t, { server, storage }).account;
    await first.ready;
    await first.setNickname('철수');
    first.resetLocal();
    const second = makeAccount(t, { server, storage }).account;
    await second.ready;
    assert.equal(second.profile.nickname, '철수');
  });
});

// ─────────────────────────────── 계정: 닉네임 ───────────────────────────────
describe('createAccount 닉네임', () => {
  test('온라인 등록과 이름 변경: 이전 이름은 풀린다', async (t) => {
    const server = fakeServer();
    const { account, bus, storage } = makeAccount(t, { server });
    await account.ready;

    const first = await account.setNickname('  철수  ');
    assert.equal(first.ok, true);
    assert.equal(first.name, '철수');
    assert.equal(first.offline, false);
    assert.equal(first.reason, undefined);
    assert.equal(account.hasNickname(), true);
    assert.equal(account.nicknamePending, false);
    assert.equal(server.last('fps_claim_nickname').args.p_name, '철수');
    assert.match(server.last('fps_claim_nickname').args.p_token, /^[0-9a-f]{64}$/);
    assert.equal(bus.of('account:change').at(-1).profile.nickname, '철수');
    assert.equal(storedEnvelope(storage).profile.nickname, '철수');

    const renamed = await account.setNickname('영희');
    assert.equal(renamed.ok, true);
    assert.equal(account.profile.nickname, '영희');
    assert.equal(server.rows.size, 1, '토큰 하나에 행 하나');

    const other = makeAccount(t, { server }).account;
    await other.ready;
    assert.equal((await other.checkNickname('철수')).ok, true);
    assert.equal((await other.setNickname('철수')).ok, true, '이전 이름을 다른 사람이 쓸 수 있다');
  });

  test('이미 있는 이름이면 이전 이름을 유지한다', async (t) => {
    const server = fakeServer();
    server.takeName('영희');
    const { account } = makeAccount(t, { server });
    await account.ready;
    await account.setNickname('철수');

    const r = await account.setNickname(' 영희 ');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'taken');
    assert.equal(r.offline, false);
    assert.equal(r.name, '영희');
    assert.match(r.message, /이미/);
    assert.equal(account.profile.nickname, '철수');
    assert.equal(account.nicknamePending, false);
  });

  test('대소문자만 다른 이름도 같은 이름이다', async (t) => {
    const server = fakeServer();
    server.takeName('Player');
    const { account } = makeAccount(t, { server });
    await account.ready;
    assert.equal((await account.checkNickname('PLAYER')).reason, 'taken');
    assert.equal((await account.setNickname('player')).reason, 'taken');
  });

  test('내 이름의 대소문자를 바꾸는 것은 허용한다', async (t) => {
    const server = fakeServer();
    const { account } = makeAccount(t, { server });
    await account.ready;
    await account.setNickname('player');
    assert.equal((await account.checkNickname('PLAYER')).ok, true);
    assert.equal((await account.setNickname('PLAYER')).ok, true);
    assert.equal(account.profile.nickname, 'PLAYER');
  });

  test('연달아 바꾸면 마지막 이름이 로컬과 서버에 남는다', async (t) => {
    const server = fakeServer();
    const { account } = makeAccount(t, { server });
    await account.ready;
    let release;
    server.gate = new Promise((resolve) => { release = resolve; });
    const first = account.setNickname('철수');
    const second = account.setNickname('영희');
    await settle();
    assert.equal(server.count('fps_claim_nickname'), 1, '앞 요청이 끝날 때까지 기다린다');
    server.gate = null;
    release();
    assert.equal((await first).ok, true);
    assert.equal((await second).ok, true);
    assert.equal(account.profile.nickname, '영희');
    assert.equal([...server.rows.values()][0].name, '영희');
  });

  test('동기화 응답이 뒤늦게 와도 방금 정한 이름을 덮지 않는다', async (t) => {
    const server = fakeServer();
    server.rows.set(VALID_TOKEN, { name: '옛이름', points: 500, owned: [], loadout: {}, stats: {}, secrets: {}, createdAt: 1 });
    let release;
    server.gate = new Promise((resolve) => { release = resolve; });
    const { account } = makeAccount(t, { server, storage: fakeStorage({ [TOKEN_KEY]: VALID_TOKEN }) });
    await settle();
    const renamed = account.setNickname('새이름');
    server.gate = null;
    release();
    await renamed;
    await account.ready;
    assert.equal(account.profile.nickname, '새이름');
    assert.equal(server.rows.get(VALID_TOKEN).name, '새이름');
  });

  test('형식 오류는 서버에 묻지 않는다', async (t) => {
    const server = fakeServer();
    const { account } = makeAccount(t, { server });
    await account.ready;
    server.calls.length = 0;
    for (const [name, reason] of [['a', 'format'], ['abc!', 'format'], ['admin', 'reserved'], ['철수 봇', 'reserved']]) {
      assert.deepEqual(
        { ...(await account.checkNickname(name)), message: '' },
        { ok: false, name: cleanNickname(name), reason, offline: false, message: '' }
      );
      assert.equal((await account.setNickname(name)).reason, reason);
    }
    assert.equal(server.calls.length, 0);
    assert.equal(account.hasNickname(), false);
  });

  test('checkNickname: 사용 가능, 이미 있음, 내 이름', async (t) => {
    const server = fakeServer();
    server.takeName('영희');
    const { account } = makeAccount(t, { server });
    await account.ready;

    const free = await account.checkNickname('철수');
    assert.equal(free.ok, true);
    assert.equal(free.offline, false);
    assert.equal(free.name, '철수');

    const taken = await account.checkNickname('영희');
    assert.equal(taken.ok, false);
    assert.equal(taken.reason, 'taken');
    assert.equal(taken.offline, false);

    await account.setNickname('철수');
    const before = server.count('fps_check_nickname');
    assert.equal((await account.checkNickname(' 철수 ')).ok, true);
    assert.equal(server.count('fps_check_nickname'), before, '내 이름은 묻지 않는다');
  });

  test('checkNickname: 네트워크 실패면 형식만 보고 offline을 돌려준다', async (t) => {
    const server = fakeServer();
    const { account } = makeAccount(t, { server });
    await account.ready;
    server.down = true;
    const r = await account.checkNickname('철수');
    assert.deepEqual(
      { ok: r.ok, offline: r.offline, reason: r.reason, name: r.name },
      { ok: true, offline: true, reason: 'network', name: '철수' }
    );
    assert.match(r.message, /오프라인/);
    assert.equal((await account.checkNickname('a')).reason, 'format');
    assert.equal((await account.checkNickname('a')).offline, false);
  });

  test('Supabase 설정이 없으면 오프라인으로 저장하고 fetch를 부르지 않는다', async (t) => {
    let fetched = 0;
    const storage = fakeStorage();
    const account = createAccount({
      storage,
      target: null,
      config: { url: '', anonKey: '' },
      fetch: async () => { fetched += 1; throw new Error('호출되면 안 된다'); }
    });
    t.after(() => account.dispose());
    await account.ready;
    assert.equal(account.remoteEnabled, false);
    assert.equal((await account.checkNickname('철수')).offline, true);
    const r = await account.setNickname('철수');
    assert.equal(r.ok, true);
    assert.equal(r.offline, true);
    assert.equal(account.nicknamePending, true);
    assert.equal((await account.retryNickname()).offline, true);
    assert.equal(fetched, 0);
    assert.equal(storedEnvelope(storage).sync.pendingClaim, '철수', '나중에 서버를 설정하면 등록한다');
  });

  test('서버를 나중에 설정하면 저장해 둔 이름을 등록한다', async (t) => {
    const storage = fakeStorage();
    const before = makeAccount(t, { storage }).account;
    await before.setNickname('철수');
    before.recordMatch({ kills: 2 });

    const server = fakeServer();
    const after = makeAccount(t, { server, storage }).account;
    await after.ready;
    assert.equal(after.nicknamePending, false);
    assert.equal(after.profile.nickname, '철수');
    assert.equal([...server.rows.values()][0].name, '철수');
    assert.equal(after.profile.points, START_POINTS + 2 * 5 + 10, '서버의 기본값이 진행 상황을 덮지 않는다');
  });
});

describe('createAccount 네트워크 실패와 충돌', () => {
  test('네트워크 실패: 로컬에 저장하고 offline으로 돌려준다, 재시도가 성공하면 끝난다', async (t) => {
    const server = fakeServer();
    server.down = true;
    const { account, bus, storage } = makeAccount(t, { server });
    await account.ready;

    const r = await account.setNickname('철수');
    assert.equal(r.ok, true);
    assert.equal(r.offline, true);
    assert.equal(r.name, '철수');
    assert.match(r.message, /오프라인/);
    assert.equal(account.hasNickname(), true);
    assert.equal(account.nicknamePending, true);
    assert.equal(storedEnvelope(storage).sync.pendingClaim, '철수');

    assert.equal((await account.retryNickname()).offline, true, '아직 오프라인');
    assert.equal(account.nicknamePending, true);

    server.down = false;
    const again = await account.retryNickname();
    assert.equal(again.ok, true);
    assert.equal(again.offline, false);
    assert.equal(account.nicknamePending, false);
    assert.equal(account.nicknameConflict, null);
    assert.equal(storedEnvelope(storage).sync.pendingClaim, null);
    assert.equal(bus.of('account:nickname-conflict').length, 0);
    assert.equal([...server.rows.values()][0].name, '철수');
  });

  test('나중에 보니 이미 있는 이름이면 충돌을 알리고 새 이름으로 풀린다', async (t) => {
    const server = fakeServer();
    server.down = true;
    const { account, bus } = makeAccount(t, { server });
    await account.ready;
    await account.setNickname('철수');

    server.down = false;
    server.takeName('철수');
    const r = await account.retryNickname();
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'taken');
    assert.equal(r.offline, false);

    const conflicts = bus.of('account:nickname-conflict');
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].name, '철수');
    assert.equal(conflicts[0].reason, 'taken');
    assert.match(conflicts[0].message, /새 닉네임/);
    assert.equal(account.nicknameConflict, '철수');
    assert.equal(account.profile.nickname, '철수', '게임을 막지 않도록 이름은 그대로 둔다');

    const fixed = await account.setNickname('영희');
    assert.equal(fixed.ok, true);
    assert.equal(fixed.offline, false);
    assert.equal(account.nicknameConflict, null);
    assert.equal(account.nicknamePending, false);
    assert.equal(account.profile.nickname, '영희');
  });

  test('다시 시작할 때도 등록을 재시도하고 충돌을 알린다', async (t) => {
    const server = fakeServer();
    const storage = fakeStorage();
    server.down = true;
    const first = makeAccount(t, { server, storage }).account;
    await first.ready;
    await first.setNickname('철수');
    first.dispose();

    server.down = false;
    server.takeName('철수');
    const { account, bus } = makeAccount(t, { server, storage });
    await account.ready;
    assert.equal(account.nicknameConflict, '철수');
    assert.equal(bus.of('account:nickname-conflict').length, 1);
    assert.equal(account.profile.nickname, '철수');
  });

  test('다시 시작할 때 이름이 비어 있으면 등록이 끝난다', async (t) => {
    const server = fakeServer();
    const storage = fakeStorage();
    server.down = true;
    const first = makeAccount(t, { server, storage }).account;
    await first.ready;
    await first.setNickname('철수');
    first.dispose();

    server.down = false;
    const { account, bus } = makeAccount(t, { server, storage });
    await account.ready;
    assert.equal(account.nicknamePending, false);
    assert.equal(bus.of('account:nickname-conflict').length, 0);
    assert.equal([...server.rows.values()][0].name, '철수');
  });

  test('타이머 재시도: 실패 뒤 다시 시도하고 간격이 늘어난다', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const server = fakeServer();
    server.down = true;
    const { account } = makeAccount(t, { server });
    await account.ready;
    await account.setNickname('철수');
    const claims = () => server.count('fps_claim_nickname');
    const start = claims();

    t.mock.timers.tick(RETRY_MIN_MS);
    await settle();
    // 시작 동기화가 아직 성공하지 못했으므로 재시도는 동기화 경로로 간다: 등록과 읽기를 모두 시도한다
    assert.equal(claims(), start + 1);

    t.mock.timers.tick(RETRY_MIN_MS * 2 - 1);
    await settle();
    assert.equal(claims(), start + 1, '두 번째 간격은 두 배다');

    server.down = false;
    t.mock.timers.tick(1);
    await settle();
    assert.equal(claims(), start + 2);
    assert.equal(account.nicknamePending, false);
  });

  test('online 이벤트가 오면 바로 이어서 한다', async (t) => {
    const server = fakeServer();
    server.down = true;
    const target = new EventTarget();
    const { account } = makeAccount(t, { server, target });
    await account.ready;
    await account.setNickname('철수');
    server.down = false;
    target.dispatchEvent(new Event('online'));
    await settle();
    assert.equal(account.nicknamePending, false);
    assert.equal([...server.rows.values()][0].name, '철수');
  });

  test('fetch가 동기로 던지거나 HTTP 오류여도 예외가 나가지 않는다', async (t) => {
    t.mock.method(console, 'warn', () => {});
    for (const fetchImpl of [
      () => { throw new Error('boom'); },
      async () => ({ ok: false, status: 500, json: async () => ({}) }),
      async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('html'); } }),
      async () => ({ ok: true, status: 200, json: async () => null }),
      async () => ({ ok: true, status: 200, json: async () => ({ message: 'no ok field' }) })
    ]) {
      const account = createAccount({ storage: fakeStorage(), target: null, config: CONFIG, fetch: fetchImpl });
      t.after(() => account.dispose());
      assert.deepEqual(await account.ready, { ok: false, offline: true });
      assert.equal((await account.checkNickname('철수')).offline, true);
      assert.equal((await account.setNickname('철수')).offline, true);
      assert.equal(account.recordMatch({ kills: 1 }).gained, 15);
      assert.equal(account.hasNickname(), true);
      assert.deepEqual(await account.topPlayers(), { ok: false, players: [], offline: true });
    }
  });
});

// ─────────────────────────────── 계정: 상점 · 장비 · 전적 ───────────────────────────────
describe('createAccount 상점과 장비', () => {
  test('buy 규칙', (t) => {
    const { account, bus } = makeAccount(t);
    assert.deepEqual(account.buy('no_such'), { ok: false, reason: 'unknown', points: 500 });
    assert.deepEqual(account.buy('ar_std'), { ok: false, reason: 'owned', points: 500 }, '기본 지급 무기');
    assert.deepEqual(account.buy('sm_vx3'), { ok: false, reason: 'points', points: 500 }, '600포인트 무기');
    assert.equal(account.isOwned('pt_magnum'), false);
    assert.equal(bus.of('account:change').length, 0, '실패는 알리지 않는다');

    assert.deepEqual(account.buy('pt_magnum'), { ok: true, points: 0 }, '가진 포인트와 가격이 같으면 살 수 있다');
    assert.equal(account.isOwned('pt_magnum'), true);
    assert.ok(account.profile.owned.includes('pt_magnum'));
    assert.equal(bus.of('account:change').length, 1);
    assert.equal(bus.of('account:change')[0].profile.points, 0);
    assert.deepEqual(account.buy('pt_magnum'), { ok: false, reason: 'owned', points: 0 });
  });

  test('isOwned: 기본 지급 무기만 처음부터 가진다', (t) => {
    const { account } = makeAccount(t);
    for (const id of WEAPON_IDS) assert.equal(account.isOwned(id), getDef(id).price === 0, id);
    assert.equal(account.isOwned('no_such'), false);
  });

  test('equip 규칙', (t) => {
    const { account, bus } = makeAccount(t);
    assert.deepEqual(account.equip('grenade', 'gr_frag'), { ok: false, reason: 'slot' }, '없는 칸');
    assert.deepEqual(account.equip('toString', 'ar_std'), { ok: false, reason: 'slot' }, '프로토타입 키');
    assert.deepEqual(account.equip('primary', 'no_such'), { ok: false, reason: 'unknown' });
    assert.deepEqual(account.equip('primary', 'pt_std'), { ok: false, reason: 'slot' }, '칸이 다른 무기');
    assert.deepEqual(account.equip('melee', 'ar_std'), { ok: false, reason: 'slot' });
    assert.deepEqual(account.equip('primary', 'sr_heavy'), { ok: false, reason: 'unowned' });
    assert.deepEqual({ ...account.loadout }, { ...DEFAULT_LOADOUT });
    assert.equal(bus.of('account:change').length, 0);

    assert.deepEqual(account.equip('primary', 'sr_bolt'), { ok: true });
    assert.equal(account.loadout.primary, 'sr_bolt');
    assert.deepEqual(account.equip('melee', 'ml_knife'), { ok: true });
    assert.equal(account.loadout.melee, 'ml_knife');
    assert.equal(bus.of('account:change').length, 2);

    assert.deepEqual(account.equip('primary', 'sr_bolt'), { ok: true });
    assert.equal(bus.of('account:change').length, 2, '같은 무기면 바뀐 것이 없다');
  });

  test('recordMatch는 포인트와 전적을 쌓는다', (t) => {
    const { account, bus } = makeAccount(t);
    const r = account.recordMatch({
      online: true, ruleset: 'knife', mode: 'ffa', mapId: 'dojo',
      kills: 7, deaths: 3, headshots: 2, halfShots: 1, knifeKills: 7, win: true, draw: false, seconds: 121.6
    });
    assert.equal(r.gained, 7 * 10 + 2 * 5 + 60 + 20);
    assert.equal(r.points, START_POINTS + r.gained);
    assert.equal(r.breakdown.reduce((s, row) => s + row.points, 0), r.gained);
    assert.deepEqual({ ...account.profile.stats }, {
      kills: 7, deaths: 3, headshots: 2, halfShots: 1, matches: 1, wins: 1, draws: 0, knifeKills: 7, secondsPlayed: 122
    });
    assert.equal(bus.of('account:change').length, 1);

    account.recordMatch({ online: false, difficulty: 'easy', kills: 1, deaths: 1, draw: true, seconds: 10 });
    const s = account.profile.stats;
    assert.equal(s.matches, 2);
    assert.equal(s.wins, 1);
    assert.equal(s.draws, 1);
    assert.equal(s.kills, 8);
    assert.equal(s.secondsPlayed, 132);
  });

  test('포인트에는 상한이 있다', (t) => {
    const storage = fakeStorage({
      [PROFILE_KEY]: JSON.stringify({ v: 1, profile: { nickname: '철수', points: MAX_POINTS - 1 } })
    });
    const { account } = makeAccount(t, { storage });
    assert.equal(account.recordMatch({ kills: 100 }).points, MAX_POINTS);
  });

  test('findSecret은 스팟마다 한 번만 보상한다', (t) => {
    const { account, bus } = makeAccount(t);
    const roof = { id: 'roof', name: '비밀 옥상', points: 150, x: 0 };
    assert.deepEqual(account.findSecret('alley', roof), { first: true, gained: 150, points: 650 });
    assert.deepEqual(account.findSecret('alley', roof), { first: false, gained: 0, points: 650 });
    assert.deepEqual(account.findSecret('dojo', { id: 'roof', name: '지붕' }), { first: true, gained: 100, points: 750 }, '맵이 다르면 다른 스팟, 기본 100');
    assert.equal(bus.of('account:change').length, 2);
    assert.equal(account.profile.secrets.alley.roof.name, '비밀 옥상');
    assert.ok(account.profile.secrets.alley.roof.at > 0);

    for (const [mapId, secret] of [[null, roof], ['alley', null], ['alley', {}], ['', roof], ['__proto__', roof], ['alley', { id: '__proto__' }]]) {
      assert.equal(account.findSecret(mapId, secret).first, false);
    }
    assert.equal({}.roof, undefined);
    assert.deepEqual(account.findSecret('alley', { id: 'constructor', name: 'x', points: 1 }), { first: true, gained: 1, points: 751 }, '일반 객체 키와 겹쳐도 처음 찾은 것이다');
  });

  test('실제 버스와 함께 동작한다', (t) => {
    const bus = createBus();
    const seen = [];
    bus.on('account:change', ({ profile }) => seen.push(profile.points));
    const { account } = makeAccount(t, { bus });
    account.buy('pt_magnum');
    assert.deepEqual(seen, [0]);
  });

  test('버스 리스너가 던져도 호출은 끝난다', (t) => {
    t.mock.method(console, 'error', () => {});
    const bus = { emit() { throw new Error('listener'); } };
    const { account, storage } = makeAccount(t, { bus });
    assert.equal(account.buy('pt_magnum').ok, true);
    assert.equal(storedEnvelope(storage).profile.points, 0);
  });

  test('bus 없이 만들어도 된다', (t) => {
    const account = createAccount({ storage: fakeStorage(), target: null, config: { url: '', anonKey: '' } });
    t.after(() => account.dispose());
    assert.equal(account.buy('pt_magnum').ok, true);
  });

  test('topPlayers', async (t) => {
    const server = fakeServer();
    const { account } = makeAccount(t, { server });
    await account.ready;
    await account.setNickname('철수');
    const r = await account.topPlayers(5);
    assert.equal(r.ok, true);
    assert.equal(r.players[0].name, '철수');
    assert.equal(server.last('fps_top_players').args.p_limit, 5);
  });
});

// ─────────────────────────────── 계정: 서버 저장 ───────────────────────────────
describe('createAccount 저장 디바운스', () => {
  async function onlineAccount(t, opts = {}) {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const server = fakeServer();
    const made = makeAccount(t, { server, ...opts });
    await made.account.ready;
    await made.account.setNickname('철수');
    t.mock.timers.tick(SAVE_DEBOUNCE_MS);
    await settle();
    server.calls.length = 0;
    return { ...made, server };
  }

  test('2초 안의 변경은 한 번에 저장한다', async (t) => {
    const { account, server } = await onlineAccount(t);
    assert.equal(SAVE_DEBOUNCE_MS, 2000);
    account.recordMatch({ kills: 1 });
    t.mock.timers.tick(1000);
    account.equip('primary', 'sr_bolt');
    t.mock.timers.tick(1000);
    account.findSecret('alley', { id: 'roof' });
    t.mock.timers.tick(1999);
    await settle();
    assert.equal(server.count('fps_save_profile'), 0, '마지막 변경 뒤 2초가 지나기 전');

    t.mock.timers.tick(1);
    await settle();
    assert.equal(server.count('fps_save_profile'), 1);
    const { args } = server.last('fps_save_profile');
    assert.equal(args.p_points, account.profile.points);
    assert.deepEqual(args.p_owned, [...account.profile.owned]);
    assert.equal(args.p_loadout.primary, 'sr_bolt');
    assert.equal(args.p_stats.kills, 1);
    assert.equal(args.p_secrets.alley.roof.at > 0, true);
    assert.match(args.p_token, /^[0-9a-f]{64}$/);

    t.mock.timers.tick(10000);
    await settle();
    assert.equal(server.count('fps_save_profile'), 1, '바뀐 것이 없으면 다시 보내지 않는다');
  });

  test('성공하면 dirty가 풀리고, 저장 중에 또 바뀌면 유지한다', async (t) => {
    const { account, server, storage } = await onlineAccount(t);
    account.recordMatch({ kills: 1 });
    assert.equal(storedEnvelope(storage).sync.dirty, true);
    t.mock.timers.tick(SAVE_DEBOUNCE_MS);
    await settle();
    assert.equal(storedEnvelope(storage).sync.dirty, false);

    // 저장 응답을 기다리는 사이의 변경
    let release;
    server.gate = new Promise((resolve) => { release = resolve; });
    account.recordMatch({ kills: 1 });
    const flushing = account.flush();
    await settle();
    assert.equal(server.last('fps_save_profile').args.p_stats.kills, 2, '요청이 나갔다');
    account.recordMatch({ kills: 1 });
    server.gate = null;
    release();
    await flushing;
    assert.equal(storedEnvelope(storage).sync.dirty, true, '세 번째 킬은 아직 서버에 없다');
    t.mock.timers.tick(SAVE_DEBOUNCE_MS);
    await settle();
    assert.equal(storedEnvelope(storage).sync.dirty, false);
    assert.equal(server.last('fps_save_profile').args.p_stats.kills, 3);
  });

  test('저장 요청은 겹치지 않아 서버에 옛 값이 남지 않는다', async (t) => {
    const { account, server } = await onlineAccount(t);
    let release;
    server.gate = new Promise((resolve) => { release = resolve; });
    account.recordMatch({ kills: 1 });
    const first = account.flush();
    await settle();
    account.recordMatch({ kills: 1 });
    const second = account.flush();
    await settle();
    assert.equal(server.count('fps_save_profile'), 1, '앞 요청이 끝날 때까지 기다린다');
    server.gate = null;
    release();
    await Promise.all([first, second]);
    assert.equal(server.count('fps_save_profile'), 2);
    assert.equal(server.last('fps_save_profile').args.p_stats.kills, 2);
  });

  test('pagehide면 곧바로 keepalive로 보내고 예약을 지운다', async (t) => {
    const target = new EventTarget();
    const { account, server } = await onlineAccount(t, { target });
    account.recordMatch({ kills: 1 });
    target.dispatchEvent(new Event('pagehide'));
    assert.equal(server.count('fps_save_profile'), 1, '줄을 서지 않고 바로 보낸다');
    assert.equal(server.last('fps_save_profile').init.keepalive, true);
    await settle();

    t.mock.timers.tick(SAVE_DEBOUNCE_MS * 2);
    await settle();
    assert.equal(server.count('fps_save_profile'), 1);
  });

  test('바뀐 것이 없으면 pagehide에도 보내지 않는다', async (t) => {
    const target = new EventTarget();
    const { server } = await onlineAccount(t, { target });
    target.dispatchEvent(new Event('pagehide'));
    await settle();
    assert.equal(server.count('fps_save_profile'), 0);
  });

  test('닉네임이 없거나 등록 전이면 저장하지 않는다', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const server = fakeServer();
    const { account } = makeAccount(t, { server });
    await account.ready;
    account.recordMatch({ kills: 1 });
    t.mock.timers.tick(SAVE_DEBOUNCE_MS);
    await settle();
    assert.equal(server.count('fps_save_profile'), 0, '닉네임 없음');

    server.down = true;
    await account.setNickname('철수');
    t.mock.timers.tick(SAVE_DEBOUNCE_MS);
    await settle();
    assert.equal(server.count('fps_save_profile'), 0, '등록 전');

    server.down = false;
    await account.retryNickname();
    t.mock.timers.tick(SAVE_DEBOUNCE_MS);
    await settle();
    assert.equal(server.count('fps_save_profile'), 1, '등록하면 그동안의 진행 상황을 올린다');
    assert.equal(server.last('fps_save_profile').args.p_stats.kills, 1);
  });

  test('저장 실패는 게임을 막지 않고 dirty를 남긴 채 재시도한다', async (t) => {
    const { account, server, storage } = await onlineAccount(t);
    server.down = true;
    account.buy('pt_magnum');
    t.mock.timers.tick(SAVE_DEBOUNCE_MS);
    await settle();
    assert.equal(server.count('fps_save_profile'), 1);
    assert.equal(storedEnvelope(storage).sync.dirty, true);
    assert.equal(account.profile.points, 0);

    server.down = false;
    t.mock.timers.tick(RETRY_MIN_MS);
    await settle();
    assert.equal(server.count('fps_save_profile'), 2);
    assert.equal(storedEnvelope(storage).sync.dirty, false);
  });

  test('서버 행이 사라졌으면 닉네임을 다시 등록하고 저장한다', async (t) => {
    const { account, server } = await onlineAccount(t);
    server.rows.clear();
    account.recordMatch({ kills: 1 });
    t.mock.timers.tick(SAVE_DEBOUNCE_MS);
    await settle();
    assert.equal(server.count('fps_claim_nickname'), 1);
    t.mock.timers.tick(SAVE_DEBOUNCE_MS);
    await settle();
    assert.equal(server.count('fps_save_profile'), 2);
    assert.equal([...server.rows.values()][0].stats.kills, 1);
    assert.equal(account.nicknamePending, false);
  });

  test('dispose는 리스너를 떼고 남은 변경을 보낸다', async (t) => {
    const target = new EventTarget();
    const { account, server } = await onlineAccount(t, { target });
    account.recordMatch({ kills: 1 });
    account.dispose();
    await settle();
    assert.equal(server.count('fps_save_profile'), 1);
    account.recordMatch({ kills: 1 });
    target.dispatchEvent(new Event('pagehide'));
    t.mock.timers.tick(SAVE_DEBOUNCE_MS);
    await settle();
    assert.equal(server.count('fps_save_profile'), 1, '정리한 뒤에는 저절로 보내지 않는다');
  });
});

// ─────────────────────────────── 계정: 서버 병합 ───────────────────────────────
describe('syncFromRemote 병합 규칙', () => {
  const remoteRow = (over = {}) => ({
    name: '서버이름',
    points: 900,
    owned: ['ar_rapid'],
    loadout: { primary: 'ar_rapid', secondary: 'pt_std', melee: 'ml_knife' },
    stats: { kills: 50, deaths: 1, wins: 2 },
    secrets: { alley: { roof: { name: '옥상', at: 2000 } } },
    createdAt: 1000,
    ...over
  });

  function withRemote(row, local) {
    const server = fakeServer();
    server.rows.set(VALID_TOKEN, row);
    const storage = fakeStorage({ [TOKEN_KEY]: VALID_TOKEN });
    if (local) storage.setItem(PROFILE_KEY, JSON.stringify({ v: 1, ...local }));
    return { server, storage };
  }

  test('처음 보는 기기: 서버 프로필을 받아 온다', async (t) => {
    const { server, storage } = withRemote(remoteRow());
    const { account, bus } = makeAccount(t, { server, storage });
    assert.equal(account.hasNickname(), false, '동기화 전에는 비어 있어도 게임을 막지 않는다');
    await account.ready;
    assert.equal(account.hasNickname(), true);
    assert.equal(account.profile.nickname, '서버이름');
    assert.equal(account.profile.points, 900);
    assert.equal(account.isOwned('ar_rapid'), true);
    assert.equal(account.loadout.primary, 'ar_rapid');
    assert.equal(account.profile.stats.kills, 50);
    assert.equal(account.profile.secrets.alley.roof.name, '옥상');
    assert.equal(account.profile.createdAt, 1000);
    assert.equal(bus.of('account:change').at(-1).profile.nickname, '서버이름');
    assert.equal(storedEnvelope(storage).profile.nickname, '서버이름');
    assert.equal(storedEnvelope(storage).sync.dirty, false, '서버와 같으면 다시 올리지 않는다');
  });

  test('닉네임은 서버, 무기는 합집합, 전적은 큰 값, 포인트는 큰 값', async (t) => {
    const local = {
      profile: {
        nickname: '로컬이름', points: 1200, owned: ['sm_vx3'],
        loadout: { primary: 'sm_vx3', secondary: 'pt_std', melee: 'ml_katana' },
        stats: { kills: 10, deaths: 9, wins: 5 },
        secrets: { alley: { roof: { name: '옥상', at: 3000 } }, dojo: { top: { name: '지붕', at: 4000 } } },
        createdAt: 5000
      },
      sync: { dirty: false, pendingClaim: null }
    };
    const { server, storage } = withRemote(remoteRow(), local);
    const { account } = makeAccount(t, { server, storage });
    await account.ready;
    const p = account.profile;
    assert.equal(p.nickname, '서버이름');
    assert.equal(p.points, 1200);
    assert.ok(p.owned.includes('sm_vx3') && p.owned.includes('ar_rapid'));
    assert.equal(p.stats.kills, 50);
    assert.equal(p.stats.deaths, 9);
    assert.equal(p.stats.wins, 5);
    assert.equal(p.secrets.alley.roof.at, 2000, '먼저 찾은 시각');
    assert.equal(p.secrets.dojo.top.name, '지붕');
    assert.equal(p.createdAt, 1000);
    assert.equal(storedEnvelope(storage).sync.dirty, true, '서버보다 앞서 있으면 올린다');
  });

  test('서버 포인트가 더 크면 서버 값을 쓴다', async (t) => {
    const local = { profile: { nickname: '서버이름', points: 300 }, sync: { dirty: false } };
    const { server, storage } = withRemote(remoteRow(), local);
    const { account } = makeAccount(t, { server, storage });
    await account.ready;
    assert.equal(account.profile.points, 900);
  });

  test('서버에 못 올린 구매가 있으면 환불되지 않는다', async (t) => {
    const local = {
      profile: {
        nickname: '서버이름', points: 100, owned: ['ar_rapid', 'sm_vx3'],
        loadout: { primary: 'sm_vx3', secondary: 'pt_std', melee: 'ml_katana' }
      },
      sync: { dirty: true, pendingClaim: null }
    };
    const { server, storage } = withRemote(remoteRow(), local);
    const { account } = makeAccount(t, { server, storage });
    await account.ready;
    assert.equal(account.profile.points, 100);
    assert.equal(account.isOwned('sm_vx3'), true);
    assert.equal(account.loadout.primary, 'sm_vx3', '장비도 로컬 값');
    assert.equal(storedEnvelope(storage).sync.dirty, true);
  });

  test('등록 못 한 이름이 있으면 이름을 덮지 않고 등록부터 한다', async (t) => {
    const local = { profile: { nickname: '새이름' }, sync: { dirty: true, pendingClaim: '새이름' } };
    const { server, storage } = withRemote(remoteRow(), local);
    const { account } = makeAccount(t, { server, storage });
    await account.ready;
    assert.equal(account.profile.nickname, '새이름');
    assert.equal(account.nicknamePending, false);
    assert.equal(server.rows.get(VALID_TOKEN).name, '새이름');
    assert.ok(server.calls.findIndex((c) => c.fn === 'fps_claim_nickname') < server.calls.findIndex((c) => c.fn === 'fps_get_profile'));
  });

  test('서버 값이 깨져 있어도 로컬을 해치지 않는다', async (t) => {
    const bad = { name: 12345678901234, points: 'x', owned: 'nope', loadout: [], stats: 7, secrets: 'y', createdAt: 'z' };
    const local = { profile: { nickname: '철수', points: 700, owned: ['sm_vx3'] }, sync: { dirty: false } };
    const { server, storage } = withRemote(bad, local);
    const { account } = makeAccount(t, { server, storage });
    await account.ready;
    assert.equal(account.profile.nickname, '철수');
    assert.equal(account.profile.points, 700);
    assert.equal(account.isOwned('sm_vx3'), true);
  });

  test('서버에 행이 없고 닉네임이 있으면 등록한다', async (t) => {
    const server = fakeServer();
    const storage = fakeStorage({
      [PROFILE_KEY]: JSON.stringify({ v: 1, profile: { nickname: '철수', points: 800 }, sync: { dirty: true } })
    });
    const { account } = makeAccount(t, { server, storage });
    await account.ready;
    assert.equal(account.nicknamePending, false);
    assert.equal([...server.rows.values()][0].name, '철수');
    assert.equal(account.profile.points, 800);
  });

  test('서버에 행이 없고 닉네임도 없으면 아무것도 만들지 않는다', async (t) => {
    const server = fakeServer();
    const { account } = makeAccount(t, { server });
    assert.deepEqual(await account.ready, { ok: true, offline: false });
    assert.equal(server.rows.size, 0);
    assert.equal(server.count('fps_claim_nickname'), 0);
  });

  test('동시 호출은 한 번으로 합친다', async (t) => {
    const server = fakeServer();
    const { account } = makeAccount(t, { server });
    const again = account.syncFromRemote();
    await Promise.all([account.ready, again]);
    assert.equal(server.count('fps_get_profile'), 1);
  });

  test('mergeProfiles는 입력을 바꾸지 않는다', () => {
    const local = normalizeProfile({ nickname: '철수', points: 100, owned: ['sm_vx3'], createdAt: 5 });
    const server = normalizeProfile({ nickname: '영희', points: 200, owned: ['ar_rapid'], createdAt: 9 });
    const frozen = JSON.stringify([local, server]);
    const merged = mergeProfiles(local, server);
    assert.equal(JSON.stringify([local, server]), frozen);
    assert.equal(merged.nickname, '영희');
    assert.equal(merged.points, 200);
    assert.equal(merged.createdAt, 5);
    assert.equal(mergeProfiles(local, normalizeProfile({ createdAt: 9 }), {}).nickname, '철수', '서버에 이름이 없으면 로컬 값');
    assert.equal(mergeProfiles(local, server, { keepNickname: true }).nickname, '철수');
    assert.equal(mergeProfiles(local, server, { dirty: true }).points, 100);
  });
});

describe('다른 탭', () => {
  test('다른 탭의 변경을 따라가 오래된 값으로 덮어쓰지 않는다', (t) => {
    const storage = fakeStorage();
    const target = new EventTarget();
    const { account, bus } = makeAccount(t, { storage, target });
    const other = createStore({ storage });
    const profile = { ...defaultProfile(), nickname: '철수', points: 1000 };
    other.save({ profile, dirty: true, pendingClaim: null });

    const event = Object.assign(new Event('storage'), { key: PROFILE_KEY, newValue: storage.getItem(PROFILE_KEY) });
    target.dispatchEvent(event);
    assert.equal(account.profile.points, 1000);
    assert.equal(bus.of('account:change').at(-1).profile.nickname, '철수');
    assert.equal(account.recordMatch({ kills: 1 }).points, 1015);
  });

  test('다른 키의 변경은 무시하고, 깨진 값이면 메모리를 유지하고, 지워지면 비운다', (t) => {
    const storage = fakeStorage();
    const target = new EventTarget();
    const { account, bus } = makeAccount(t, { storage, target });
    account.buy('pt_magnum');
    const before = bus.events.length;

    target.dispatchEvent(Object.assign(new Event('storage'), { key: 'other', newValue: 'x' }));
    assert.equal(bus.events.length, before);

    storage.setItem(PROFILE_KEY, '{{{');
    target.dispatchEvent(Object.assign(new Event('storage'), { key: PROFILE_KEY, newValue: '{{{' }));
    assert.equal(account.profile.points, 0);
    assert.equal(bus.events.length, before);

    storage.removeItem(PROFILE_KEY);
    target.dispatchEvent(Object.assign(new Event('storage'), { key: null, newValue: null }));
    assert.equal(account.profile.points, START_POINTS);
  });
});

// ─────────────────────────────── RPC 클라이언트 ───────────────────────────────
describe('createRemote', () => {
  const okFetch = (calls, body = { ok: true }) => async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => body };
  };

  test('URL과 헤더: Publishable key는 apikey에만 넣는다', async () => {
    const calls = [];
    const remote = createRemote({ fetch: okFetch(calls), config: { url: 'https://p.supabase.co/', anonKey: ' sb_publishable_abc ' } });
    assert.equal(remote.enabled, true);
    assert.deepEqual(await remote.checkNickname('철수'), { ok: true });
    const { url, init } = calls[0];
    assert.equal(url, 'https://p.supabase.co/rest/v1/rpc/fps_check_nickname');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.apikey, 'sb_publishable_abc');
    assert.equal(init.headers.Authorization, undefined);
    assert.equal(init.headers['Content-Type'], 'application/json');
    assert.equal(init.body, JSON.stringify({ p_name: '철수' }));
    assert.ok(init.signal instanceof AbortSignal);
  });

  test('예전 anon JWT는 Authorization에도 넣는다', async () => {
    const calls = [];
    const jwt = 'aaa.bbb.ccc';
    const remote = createRemote({ fetch: okFetch(calls), config: { url: 'https://p.supabase.co', anonKey: jwt } });
    await remote.topPlayers(3);
    assert.equal(calls[0].init.headers.apikey, jwt);
    assert.equal(calls[0].init.headers.Authorization, `Bearer ${jwt}`);
    assert.deepEqual(authHeaders('sb_publishable_x'), { apikey: 'sb_publishable_x' });
  });

  test('RPC 이름과 인자', async () => {
    const calls = [];
    const remote = createRemote({ fetch: okFetch(calls), config: CONFIG });
    const profile = defaultProfile();
    await remote.claimNickname('t', '철수');
    await remote.getProfile('t');
    await remote.saveProfile('t', profile, { keepalive: true });
    await remote.topPlayers(7);
    const seen = calls.map((c) => [c.url.split('/rpc/')[1], Object.keys(JSON.parse(c.init.body)).sort().join()]);
    assert.deepEqual(seen, [
      ['fps_claim_nickname', 'p_name,p_token'],
      ['fps_get_profile', 'p_token'],
      ['fps_save_profile', 'p_loadout,p_owned,p_points,p_secrets,p_stats,p_token'],
      ['fps_top_players', 'p_limit']
    ]);
    assert.equal(calls[2].init.keepalive, true);
    assert.equal(calls[1].init.keepalive, false);
  });

  test('url이나 key가 비면 꺼진다', async () => {
    let fetched = 0;
    const fetchImpl = async () => { fetched += 1; };
    for (const config of [{ url: '', anonKey: '' }, { url: 'https://p.supabase.co', anonKey: '' }, { url: '', anonKey: 'k' }, { url: '   ', anonKey: '  ' }, {}]) {
      const remote = createRemote({ fetch: fetchImpl, config });
      assert.equal(remote.enabled, false);
      assert.deepEqual(await remote.checkNickname('철수'), { ok: false, reason: 'network' });
    }
    assert.equal(fetched, 0);
  });

  test('설정을 주지 않으면 globalThis.SKALA_CONFIG.supabase를 읽는다', (t) => {
    t.after(() => { delete globalThis.SKALA_CONFIG; });
    delete globalThis.SKALA_CONFIG;
    assert.equal(createRemote({ fetch: okFetch([]) }).enabled, false, '설정 객체가 없어도 된다');
    globalThis.SKALA_CONFIG = { supabase: { url: '', anonKey: '' } };
    assert.equal(createRemote({ fetch: okFetch([]) }).enabled, false);
    globalThis.SKALA_CONFIG = { supabase: { url: 'https://p.supabase.co', anonKey: 'sb_publishable_x' } };
    assert.equal(createRemote({ fetch: okFetch([]) }).enabled, true);
  });

  test('실패는 모두 network로 돌려준다', async (t) => {
    const warn = t.mock.method(console, 'warn', () => {});
    const failures = [
      async () => { throw new TypeError('Failed to fetch'); },
      () => { throw new Error('sync'); },
      async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('html'); } }),
      async () => ({ ok: true, status: 200, json: async () => null }),
      async () => ({ ok: true, status: 200, json: async () => [] }),
      async () => ({ ok: true, status: 200, json: async () => ({ ok: 'yes' }) })
    ];
    for (const fetchImpl of failures) {
      assert.deepEqual(await createRemote({ fetch: fetchImpl, config: CONFIG }).getProfile('t'), { ok: false, reason: 'network' });
    }
    const http = createRemote({ fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }), config: CONFIG });
    assert.deepEqual(await http.getProfile('t'), { ok: false, reason: 'network', status: 404 });
    await http.getProfile('t');
    assert.equal(warn.mock.callCount(), 1, '설정 문제는 콘솔에 한 번만 남긴다');
  });

  test('서버의 업무 오류는 그대로 전달한다', async () => {
    const remote = createRemote({ fetch: okFetch([], { ok: false, error: 'NAME_TAKEN' }), config: CONFIG });
    assert.deepEqual(await remote.checkNickname('철수'), { ok: false, error: 'NAME_TAKEN' });
  });

  test('6초가 지나면 요청을 끊는다', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    assert.equal(RPC_TIMEOUT_MS, 6000);
    let signal = null;
    const remote = createRemote({
      config: CONFIG,
      fetch: (url, init) => new Promise((resolve, reject) => {
        signal = init.signal;
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      })
    });
    const pending = remote.checkNickname('철수');
    t.mock.timers.tick(5999);
    assert.equal(signal.aborted, false);
    t.mock.timers.tick(1);
    assert.equal(signal.aborted, true);
    assert.deepEqual(await pending, { ok: false, reason: 'network' });
  });

  test('응답이 오면 시간 제한 타이머를 지운다', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let signal = null;
    const remote = createRemote({
      config: CONFIG,
      fetch: async (url, init) => {
        signal = init.signal;
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
    });
    await remote.checkNickname('철수');
    t.mock.timers.tick(RPC_TIMEOUT_MS * 2);
    assert.equal(signal.aborted, false);
  });

  test('기본 fetch는 전역 fetch를 호출 시점에 찾는다', async (t) => {
    const calls = [];
    t.mock.method(globalThis, 'fetch', okFetch(calls));
    await createRemote({ config: CONFIG }).checkNickname('철수');
    assert.equal(calls.length, 1);
  });
});

// ─────────────────────────────── schema.sql 대조 ───────────────────────────────
describe('supabase/schema.sql', () => {
  const sql = readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8');
  /** 주석을 뺀 본문. 규칙 대조가 주석 속 글자에 속지 않게 한다 */
  const code = sql.split(/\r?\n/).filter((line) => !line.trimStart().startsWith('--')).join('\n');
  const RPCS = {
    fps_check_nickname: 'text',
    fps_claim_nickname: 'text, text',
    fps_get_profile: 'text',
    fps_save_profile: 'text, int, jsonb, jsonb, jsonb, jsonb',
    fps_top_players: 'int'
  };
  const INTERNAL = { fps_clean_name: 'text', fps_name_error: 'text', fps_token_hash: 'text', fps_owned_ok: 'jsonb' };

  function functionHead(name) {
    const m = code.match(new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\$\\$`));
    assert.ok(m, `${name} 정의가 없다`);
    return m[0];
  }

  test('머리말이 있다', () => {
    assert.match(sql, /^-- Date: 06NOV2026\r?\n-- Author: Minkyu Jung\r?\n-- Purpose: /);
  });

  test('허용 글자가 nickname.js와 같다', () => {
    const m = code.match(/!~ '\^\[(.+?)\]\+\$'/);
    assert.ok(m);
    assert.equal(m[1], NICKNAME_CHARSET);
  });

  test('공백 목록이 nickname.js와 같다', () => {
    assert.ok(code.includes(`'[${NICKNAME_SPACES}]+'`));
    // 이 목록이 JS의 \s와 정말 같은지도 확인한다
    const listed = new RegExp(`^[${NICKNAME_SPACES}]$`);
    for (let c = 0; c <= 0xffff; c += 1) {
      const ch = String.fromCharCode(c);
      assert.equal(listed.test(ch), /^\s$/.test(ch), `U+${c.toString(16)}`);
    }
  });

  test('예약어가 nickname.js와 같다', () => {
    const m = code.match(/lower\(s\.clean\) in \(([^)]*)\)/);
    assert.ok(m);
    const listed = m[1].split(',').map((item) => item.trim().replace(/^'|'$/g, ''));
    assert.deepEqual(listed, [...RESERVED_NICKNAMES]);
  });

  test('길이와 봇 꼬리표가 nickname.js와 같다', () => {
    assert.ok(code.includes(`not between ${NICKNAME_MIN} and ${NICKNAME_MAX} then 'NAME_INVALID'`));
    assert.ok(code.includes(`char_length(name) between ${NICKNAME_MIN} and ${NICKNAME_MAX}`));
    assert.ok(code.includes(`right(s.clean, ${Array.from(BOT_SUFFIX).length}) = '${BOT_SUFFIX}' then 'NAME_RESERVED'`));
  });

  test('검사 순서가 nickname.js와 같다', () => {
    const order = ['not between', '!~', 'lower(s.clean) in', 'right(s.clean'].map((part) => code.indexOf(part));
    assert.ok(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1])), order.join());
  });

  test('상한과 시작 포인트가 JS와 같다', () => {
    assert.ok(code.includes(`points int not null default ${START_POINTS}`));
    assert.ok(code.includes(`check (points between 0 and ${MAX_POINTS})`));
    assert.ok(code.includes(`least(greatest(coalesce(p_points, points), 0), ${MAX_POINTS})`));
    assert.ok(code.includes(`, 0), ${STAT_MAX})`));
  });

  test('처음부터 끝까지 다시 실행해도 안전한 형태다', () => {
    assert.ok(!/create\s+table\s+(?!if not exists)/i.test(code));
    assert.ok(!/create\s+function/i.test(code), '함수는 create or replace만 쓴다');
    assert.ok(!/create\s+(unique\s+)?index\s+(?!if not exists)/i.test(code));
    assert.ok(!/\bdrop\s/i.test(code), '데이터를 지우는 문장이 없다');
    assert.ok(!/\b(truncate|delete from)\b/i.test(code));
    assert.match(code, /create extension if not exists pgcrypto with schema extensions;/);
    assert.equal((code.match(/\$\$/g) || []).length % 2, 0, '$$ 짝이 맞는다');
  });

  test('테이블은 RLS를 켜고 직접 권한을 없앤다', () => {
    assert.match(code, /alter table public\.fps_players enable row level security;/);
    assert.match(code, /revoke all on public\.fps_players from public, anon, authenticated;/);
    assert.ok(!/create policy/i.test(code));
    assert.ok(!/grant [^;]* on (table )?public\.fps_players/i.test(code));
    for (const col of ['id', 'token_hash', 'name', 'name_key', 'points', 'owned', 'loadout', 'stats', 'secrets', 'created_at', 'updated_at']) {
      assert.match(code, new RegExp(`^\\s+${col} `, 'm'), col);
    }
    assert.match(code, /token_hash text not null unique/);
    assert.match(code, /name_key text not null unique/);
  });

  test('RPC는 SECURITY DEFINER이고 anon·authenticated만 실행할 수 있다', () => {
    for (const [name, args] of Object.entries(RPCS)) {
      assert.ok(functionHead(name).includes('security definer set search_path = public, extensions'), name);
      assert.ok(code.includes(`revoke all on function public.${name}(${args}) from public;`), name);
      assert.ok(code.includes(`grant execute on function public.${name}(${args}) to anon, authenticated;`), name);
    }
  });

  test('내부 함수는 외부에서 부를 수 없다', () => {
    for (const [name, args] of Object.entries(INTERNAL)) {
      assert.ok(functionHead(name).includes('set search_path = public, extensions'), name);
      assert.ok(!functionHead(name).includes('security definer'), name);
      assert.ok(code.includes(`revoke all on function public.${name}(${args}) from public, anon, authenticated;`), name);
      assert.ok(!code.includes(`grant execute on function public.${name}`), name);
    }
  });

  test('닉네임 경쟁은 unique_violation으로 처리한다', () => {
    const m = code.match(/function public\.fps_claim_nickname[\s\S]*?end \$\$;/);
    assert.ok(m);
    assert.match(m[0], /on conflict \(token_hash\) do update/);
    assert.match(m[0], /exception when unique_violation then\s+return jsonb_build_object\('ok', false, 'error', 'NAME_TAKEN'\)/);
  });

  test('토큰은 해시만 저장하고 순위표는 이름·킬·승리·포인트만 내보낸다', () => {
    assert.ok(!/p_token\s+(?:text\s+)?(?:not null\s+)?unique/i.test(code));
    assert.match(code, /encode\(digest\(p_token, 'sha256'\), 'hex'\)/);
    const m = code.match(/function public\.fps_top_players[\s\S]*?\$\$;/);
    assert.ok(m);
    assert.match(m[0], /jsonb_build_object\('name', t\.name, 'kills', t\.kills, 'wins', t\.wins, 'points', t\.points\)/);
    assert.ok(!/token_hash/.test(m[0]));
  });

  test('서버 오류 코드를 클라이언트가 모두 안다', () => {
    const index = readFileSync(new URL('../js/account/index.js', import.meta.url), 'utf8');
    for (const error of ['NAME_TAKEN', 'NAME_INVALID', 'NAME_RESERVED', 'NOT_FOUND']) {
      assert.ok(code.includes(`'${error}'`), error);
      assert.ok(index.includes(`'${error}'`), error);
    }
  });
});
