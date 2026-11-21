/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 연막탄·섬광탄 시험. 연기 구름이 퍼지는 동안·걷힌 뒤의 시선 차단, 섬광 세기의 시선 각도·거리·벽·연기 의존,
 *          하얀 화면 시간, 투척 정의(가격·종류)와 서버 가격표(schema.sql) 짝, 봇이 연기 너머·눈먼 동안 쏘지 않는 것을 확인한다.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  SMOKE, FLASH, createSmokeField, smokeRadius, chordLength, flashIntensity, flashBlindSec, flashWhiteout, throwableOf
} from '../js/weapons/tactical.js';
import { WEAPONS, GRENADE_IDS, DEFAULT_LOADOUT } from '../js/weapons/defs.js';
import { PROJECTILES, createGrenadeSystem } from '../js/weapons/grenade.js';
import { priceTable, ITEM_IDS } from '../js/account/economy.js';
import { createBot } from '../js/game/bots.js';
import { createArsenal } from '../js/weapons/logic.js';
import { createWorld, makeBox, lineOfSight } from '../js/engine/physics.js';

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const EYE = 1.6;

describe('연막탄 구름', () => {
  test('반경: 터질 때 0 → 2.2초에 6 m → 끝 2.5초 동안 걷혀 14초에 0', () => {
    assert.equal(smokeRadius(0), 0);
    assert.ok(smokeRadius(0.5) > 2 && smokeRadius(0.5) < SMOKE.radius);
    assert.ok(near(smokeRadius(SMOKE.grow), SMOKE.radius));
    assert.ok(near(smokeRadius(8), SMOKE.radius));
    assert.ok(smokeRadius(SMOKE.life - 1) < SMOKE.radius && smokeRadius(SMOKE.life - 1) > 0);
    assert.equal(smokeRadius(SMOKE.life), 0);
    assert.equal(smokeRadius(-1), 0);
    assert.equal(smokeRadius(Number.NaN), 0);
  });

  test('선분이 구 안을 지나는 길이', () => {
    assert.ok(near(chordLength([-10, 0, 0], [10, 0, 0], [0, 0, 0], 3), 6));
    assert.ok(near(chordLength([0, 0, 0], [10, 0, 0], [0, 0, 0], 3), 3), '구 안에서 출발');
    assert.equal(chordLength([-10, 5, 0], [10, 5, 0], [0, 0, 0], 3), 0, '빗나감');
    assert.equal(chordLength([-10, 0, 0], [-5, 0, 0], [0, 0, 0], 3), 0, '닿기 전에 끝남');
    assert.equal(chordLength([1, 1, 1], [1, 1, 1], [0, 0, 0], 3), 0, '길이 0');
  });

  test('구름을 지나는 시선은 퍼진 동안 막히고, 걷힌 뒤에는 다시 보인다', () => {
    const smoke = createSmokeField();
    assert.ok(smoke.add({ id: 'a#1', pos: [0, 0, 0], t: 10 }));
    assert.equal(smoke.add({ id: 'a#1', pos: [5, 0, 5], t: 11 }), false, '같은 id는 한 번만');
    const a = [-15, EYE, 0], b = [15, EYE, 0];
    assert.equal(smoke.blocks(a, b, 10), false, '막 터진 순간(반경 0)은 아직 보인다');
    assert.equal(smoke.blocks(a, b, 10.6), true, '0.6초 만에 막힌다');
    for (const t of [12, 16, 22]) assert.equal(smoke.blocks(a, b, t), true, `${t - 10}초 뒤`);
    assert.equal(smoke.blocks(a, b, 10 + SMOKE.life + 0.01), false, '14초 뒤에는 걷힌다');
    assert.equal(smoke.count, 0, '걷힌 구름은 지운다');
  });

  test('구름을 비껴가는 시선, 가장자리만 스치는 시선, 구름 앞에서 끝나는 시선은 막히지 않는다', () => {
    const smoke = createSmokeField();
    smoke.add({ id: 's', pos: [0, 0, 0], t: 0 });
    const t = 5, cy = SMOKE.lift;
    assert.equal(smoke.blocks([-15, cy, 9], [15, cy, 9], t), false, '9 m 옆');
    assert.equal(smoke.blocks([-15, cy, 5.98], [15, cy, 5.98], t), false, '가장자리를 스친다(1.2 m 미만)');
    assert.equal(smoke.blocks([-15, cy, 3], [15, cy, 3], t), true, '3 m 옆은 구름 속을 지난다');
    assert.equal(smoke.blocks([-20, EYE, 0], [-8, EYE, 0], t), false, '구름 앞에서 끝남');
    assert.equal(smoke.blocks([-20, 30, 0], [20, 30, 0], t), false, '구름 위');
  });

  test('구름 속이면 진하고 밖이면 0(화면 안개)', () => {
    const smoke = createSmokeField();
    smoke.add({ id: 's', pos: [0, 0, 0], t: 0 });
    assert.equal(smoke.density([0, SMOKE.lift, 0], 5), 1);
    assert.ok(smoke.density([4, SMOKE.lift, 0], 5) > 0 && smoke.density([4, SMOKE.lift, 0], 5) < 1);
    assert.equal(smoke.density([20, EYE, 0], 5), 0);
    const list = smoke.list(5);
    assert.equal(list.length, 1);
    assert.deepEqual(list[0].center, [0, SMOKE.lift, 0]);
    assert.ok(near(list[0].radius, SMOKE.radius));
    assert.equal(smoke.density([0, SMOKE.lift, 0], 30), 0, '걷힌 뒤');
    assert.equal(smoke.count, 0);
    smoke.add({ id: 't', pos: [0, 0, 0], t: 0 });
    smoke.clear();
    assert.equal(smoke.count, 0);
  });
});

describe('섬광탄 세기', () => {
  const eye = [0, EYE, 0];
  const fwd = [0, 0, -1];
  const at = (x, z) => [x, EYE, z];

  test('바라보고 가까이면 최대, 등을 돌리면 약하다', () => {
    assert.equal(flashIntensity({ eye, forward: fwd, pos: at(0, -4) }), 1);
    const side = flashIntensity({ eye, forward: fwd, pos: at(5, 0) });
    const back = flashIntensity({ eye, forward: fwd, pos: at(0, 5) });
    const front = flashIntensity({ eye, forward: fwd, pos: at(0, -5) });
    assert.ok(front > side && side > back, `${front} > ${side} > ${back}`);
    assert.ok(side > 0.45 && side < 0.75, `옆 ${side}`);
    assert.ok(back > 0 && back <= 0.2, `등 ${back}`);
    assert.ok(flashIntensity({ eye, forward: fwd, pos: at(0, 1) }) >= 0.55, '바로 뒤에서 터지면 등을 돌려도 세다');
  });

  test('멀수록 약해지고 28 m 밖은 0', () => {
    const k = (d) => flashIntensity({ eye, forward: fwd, pos: at(0, -d) });
    assert.equal(k(FLASH.full), 1);
    assert.ok(k(12) < 1 && k(12) > k(20) && k(20) > 0);
    assert.equal(k(FLASH.range), 0);
    assert.equal(k(40), 0);
    // 멀고 등 뒤면 아무 일도 없다(최소 세기 아래)
    assert.equal(flashIntensity({ eye, forward: fwd, pos: at(0, 20) }), 0);
  });

  test('벽에 가리면 0, 연기 너머는 절반', () => {
    assert.equal(flashIntensity({ eye, forward: fwd, pos: at(0, -4), clear: false }), 0);
    assert.ok(near(flashIntensity({ eye, forward: fwd, pos: at(0, -4), smoke: true }), 0.5));
    // 실제 충돌 월드: 벽 뒤 섬광은 lineOfSight가 막는다
    const w = createWorld([makeBox(-3, 0, -3.2, 3, 4, -2.8)]);
    const clear = lineOfSight(w, eye, at(0, -6));
    assert.equal(clear, false);
    assert.equal(flashIntensity({ eye, forward: fwd, pos: at(0, -6), clear }), 0);
  });

  test('세기만큼 눈이 멀고, 하얀 화면은 버티다 걷힌다', () => {
    assert.equal(flashBlindSec(1), FLASH.maxBlind);
    assert.ok(near(flashBlindSec(0.5), FLASH.maxBlind / 2));
    assert.equal(flashBlindSec(-1), 0);
    assert.equal(flashWhiteout(1, 0), 1);
    assert.equal(flashWhiteout(1, 1.2), 1, '처음 45%는 하얗게');
    assert.ok(flashWhiteout(1, 2) < 1 && flashWhiteout(1, 2) > flashWhiteout(1, 2.8));
    assert.equal(flashWhiteout(1, FLASH.maxBlind), 0);
    assert.ok(flashWhiteout(0.2, 0) < 1, '약한 섬광은 덜 하얗다');
    assert.equal(flashWhiteout(0, 0), 0);
  });
});

describe('투척 정의 · 가격표', () => {
  test('M-7 연막탄 · FL-9 섬광탄은 투척 칸 4의 상점 물건이고 기본 수류탄은 그대로다', () => {
    const s = WEAPONS.gr_smoke, f = WEAPONS.gr_flash;
    assert.deepEqual([s.slot, s.kind, s.category, s.fire, s.count, s.throwable], [4, 'grenade', 'grenade', 'throw', 1, 'smoke']);
    assert.deepEqual([f.slot, f.kind, f.category, f.fire, f.count, f.throwable], [4, 'grenade', 'grenade', 'throw', 1, 'flash']);
    assert.equal(s.nameEn, 'M-7 Smoke');
    assert.equal(f.nameEn, 'FL-9 Flashbang');
    assert.ok(s.price > 0 && f.price > 0 && !s.zombieOnly && !f.zombieOnly);
    assert.equal(s.explosion.max, 0, '피해 없음');
    assert.equal(f.explosion.max, 0, '피해 없음');
    assert.equal(GRENADE_IDS[0], 'gr_frag', '봇이 쓰는 첫 투척은 수류탄');
    assert.equal(DEFAULT_LOADOUT.grenade, 'gr_frag');
    assert.equal(throwableOf('gr_smoke'), 'smoke');
    assert.equal(throwableOf('gr_flash'), 'flash');
    for (const id of ['gr_frag', 'th_axe', 'ar_std', '__proto__', null, 5]) assert.equal(throwableOf(id), null, String(id));
    assert.deepEqual([PROJECTILES.smoke.code, PROJECTILES.flash.code], [8, 9]);
  });

  test('클라이언트 가격표와 서버 가격표(schema.sql)에 같은 값으로 있다', () => {
    const table = priceTable();
    assert.equal(table.gr_smoke, WEAPONS.gr_smoke.price);
    assert.equal(table.gr_flash, WEAPONS.gr_flash.price);
    assert.ok(ITEM_IDS.includes('gr_smoke') && ITEM_IDS.includes('gr_flash'));
    const sql = readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8');
    const m = sql.match(/function public\.fps_price_table\(\) returns jsonb[\s\S]*?select '(\{[\s\S]*?\})'::jsonb/);
    assert.ok(m, 'fps_price_table');
    const server = JSON.parse(m[1]);
    assert.equal(server.gr_smoke, WEAPONS.gr_smoke.price);
    assert.equal(server.gr_flash, WEAPONS.gr_flash.price);
  });

  test('신관이 다 되면 그 종류로 터진다(수류탄과 같은 궤적)', () => {
    const sys = createGrenadeSystem({ sphereSweep: () => ({ hit: false }), floorY: 0 });
    sys.spawn([0, 1, 0], [3, 2, 0], { id: 's', kind: 'smoke', fuse: WEAPONS.gr_smoke.fuse });
    sys.spawn([0, 1, 0], [3, 2, 0], { id: 'f', kind: 'flash', fuse: WEAPONS.gr_flash.fuse });
    sys.spawn([0, 1, 0], [3, 2, 0], { id: 'g', fuse: WEAPONS.gr_smoke.fuse });
    const evs = [];
    for (let i = 0; i < 240; i++) for (const e of sys.update(1 / 120)) if (e.type === 'explode') evs.push(e);
    const by = Object.fromEntries(evs.map((e) => [e.id, e]));
    assert.equal(by.s.kind, 'smoke');
    assert.equal(by.f.kind, 'flash');
    assert.deepEqual([...by.s.pos], [...by.g.pos], '연막탄은 같은 신관의 수류탄과 같은 자리');
  });
});

describe('봇 시야', () => {
  /** 탁 트인 곳에서 20 m 앞의 적을 보는 봇. sight·blind를 바꿔 가며 6초 동안 방아쇠를 센다 */
  function shots({ sight, blind }) {
    const brain = createBot({ id: 'b', mode: 'ffa', ruleset: 'classic', difficulty: 'hard', primary: 'ar_std', secondary: 'pt_std', melee: 'ml_knife', seed: 3 });
    const arsenal = createArsenal({ primary: 'ar_std', secondary: 'pt_std', melee: 'ml_knife', stageCycle: false, zoomMode: 'hold' });
    const pos = [0, 0, 0];
    let yaw = 0, pitch = 0, fires = 0;
    const enemy = { id: 't', pos: [0, 0, -20], alive: true };
    for (let i = 0; i < 60; i++) {
      const cmd = brain.think(0.1, {
        self: {
          pos, vel: [0, 0, 0], onGround: true, yaw, pitch, hp: 100, alive: true, crouch: false,
          slot: arsenal.getWeapon().slot, ammo: arsenal.getAmmo(), weapon: arsenal.getWeapon(), zoom: arsenal.getZoom().progress,
          recoil: arsenal.getRecoilKick(), grenades: 0, blind: typeof blind === 'function' ? blind(i) : !!blind
        },
        enemies: [enemy], allies: [], nav: null, los: () => true, sight
      });
      yaw += cmd.yawDelta || 0;
      pitch += cmd.pitchDelta || 0;
      if (cmd.fire) fires++;
      arsenal.update(0.1, { fireDown: !!cmd.fire, zoomDown: !!cmd.zoom }, { speed: 0, onGround: true });
    }
    return fires;
  }

  test('트인 곳에서는 쏜다(기준)', () => {
    assert.ok(shots({}) > 0);
  });

  test('연기 너머의 적은 보지 못해 쏘지 않고, 연기가 걷히면 다시 쏜다', () => {
    const smoke = createSmokeField();
    smoke.add({ id: 'c', pos: [0, 0, -10], t: 0 });
    assert.equal(shots({ sight: (a, b) => !smoke.blocks(a, b, 5) }), 0, '연기 속');
    assert.ok(shots({ sight: (a, b) => !smoke.blocks(a, b, 20) }) > 0, '걷힌 뒤');
  });

  test('섬광에 눈이 먼 동안은 쏘지 않는다', () => {
    assert.equal(shots({ blind: true }), 0);
    assert.ok(shots({ blind: (i) => i < 20 }) > 0, '눈이 돌아오면 다시 쏜다');
  });
});
