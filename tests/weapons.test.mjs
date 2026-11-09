/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 무기 표와 데미지 계산, Arsenal(점사·다단 줌·단일 줌·슬롯 제한·로드아웃), 규칙별 무기 허용, 방장 검증을 확인한다.
 *          기대값은 docs/DESIGN.md 3.2 표를 그대로 옮겨 적었다. defs.js에서 읽어 오지 않아야 어긋남을 잡을 수 있다.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import * as defs from '../js/weapons/defs.js';
import { createArsenal, validateHit, shotDirection, STATES } from '../js/weapons/logic.js';
import { GRENADE_PHYSICS, explosionDamage } from '../js/weapons/grenade.js';
import {
  RULESET_IDS, isWeaponAllowed, pickableWeapons, defaultPick, rulesetOf, normalizeRuleset,
  FFA_KILLS, FFA_KILL_PRESETS, parseKillTarget, normalizeKillTarget,
} from '../js/game/modes.js';

const {
  WEAPONS, WEAPON_IDS, PRIMARY_IDS, SECONDARY_IDS, MELEE_IDS, GRENADE_IDS, DEFAULT_LOADOUT, PARTS,
  getDef, normalizePart, computeDamage, isHalfShot, falloffMul, explosionFalloff, zoomFov, minShotInterval,
  vec3, toVec3, DEG, PLAYER_HP, WALK_SPEED, BASE_FOV,
} = defs;

/* ---------- DESIGN 3.2 표 ---------- */
const TABLE = {
  ar_std: { name: 'RX-4 돌격소총', kind: 'rifle', fire: 'auto', rpm: 600, head: 110, body: 30, legs: 22, limb: 15, falloff: [30, 80, 0.75], mag: 30, reserve: 60, move: 0.95, price: 0 },
  ar_rapid: { name: 'RX-9 스톰', kind: 'rifle', fire: 'auto', rpm: 860, head: 100, body: 22, legs: 16, limb: 11, falloff: [25, 70, 0.7], mag: 35, reserve: 70, move: 0.97, price: 800 },
  ar_line: { name: 'LN-3 헤드라인', kind: 'rifle', fire: 'auto', rpm: 480, head: 120, body: 17, legs: 12, limb: 8, falloff: [40, 100, 0.8], mag: 25, reserve: Infinity, move: 0.95, price: 1200 },
  ar_burst: { name: 'BR-3 트리플', kind: 'rifle', fire: 'burst', interval: 0.36, head: 110, body: 34, legs: 24, limb: 16, falloff: [30, 80, 0.75], mag: 30, reserve: 60, move: 0.95, price: 1000 },
  dm_mark: { name: 'DM-4 마크스맨', kind: 'dmr', fire: 'semi', rpm: 200, head: 130, body: 52, legs: 38, limb: 26, falloff: null, mag: 15, reserve: Infinity, move: 0.9, price: 1500 },
  sm_vx3: { name: 'VX-3 바이퍼', kind: 'smg', fire: 'auto', rpm: 950, head: 60, body: 18, legs: 14, limb: 9, falloff: [12, 40, 0.55], mag: 32, reserve: 64, move: 1.05, price: 600 },
  sg_bx12: { name: 'BX-12 브리처', kind: 'shotgun', fire: 'semi', interval: 0.85, head: 20, body: 14, legs: 10, limb: 7, falloff: [8, 22, 0.35], mag: 6, reserve: 12, move: 0.98, price: 700 },
  sr_bolt: { name: 'SK-7 볼트', kind: 'sniper', fire: 'bolt', interval: 1.2, head: 200, body: 120, legs: 100, limb: 50, falloff: null, mag: 5, reserve: 10, move: 0.85, price: 0 },
  sr_twin: { name: 'T-2 트윈옵틱', kind: 'sniper', fire: 'bolt', interval: 1.35, head: 200, body: 120, legs: 100, limb: 50, falloff: null, mag: 5, reserve: Infinity, move: 0.82, price: 1500 },
  sr_swift: { name: 'S-3 스위프트', kind: 'sniper', fire: 'bolt', interval: 0.85, head: 150, body: 85, legs: 60, limb: 40, falloff: null, mag: 7, reserve: 14, move: 0.95, price: 1000 },
  sr_heavy: { name: 'H-50 타이탄', kind: 'sniper', fire: 'bolt', interval: 1.9, head: 300, body: 200, legs: 150, limb: 70, falloff: null, mag: 4, reserve: Infinity, move: 0.75, price: 2500 },
  pt_std: { name: 'P-9 권총', kind: 'pistol', fire: 'semi', interval: 0.16, head: 70, body: 28, legs: 20, limb: 14, falloff: [15, 45, 0.6], mag: 12, reserve: 24, move: 1.0, price: 0 },
  pt_magnum: { name: 'M-44 매그넘', kind: 'pistol', fire: 'semi', interval: 0.46, head: 110, body: 55, legs: 38, limb: 25, falloff: [25, 60, 0.7], mag: 6, reserve: 12, move: 0.97, price: 500 },
};
const MELEE_TABLE = {
  ml_knife: { name: '호크빌 나이프', slash: [50, 0.45, 1.8, 35], stab: [100, 1.0, 1.8, 12], move: 1.1, price: 0 },
  ml_tanto: { name: '탄토', slash: [40, 0.42, 1.8, 30], stab: [100, 0.85, 2.1, 12], move: 1.12, price: 500 },
  ml_gurkha: { name: '구르카 나이프', slash: [55, 0.52, 2.1, 42], stab: [110, 1.05, 2.1, 16], move: 1.07, price: 800 },
  ml_katana: { name: '카게 카타나', slash: [65, 0.62, 2.7, 48], stab: [120, 1.25, 2.9, 14], move: 1.05, price: 1200 },
};
const GUN_IDS = Object.keys(TABLE);
const SNIPER_IDS = ['sr_bolt', 'sr_twin', 'sr_swift', 'sr_heavy'];
const RIFLE_IDS = ['ar_std', 'ar_rapid', 'ar_line', 'ar_burst'];
const ALL_IDS = [...GUN_IDS, ...Object.keys(MELEE_TABLE), 'gr_frag'];

/* ---------- 도우미 ---------- */
const DT = 1 / 60;
/** seconds 동안 같은 입력을 준다 */
function run(a, seconds, input = {}, motion) {
  const evs = [];
  const ticks = Math.round(seconds / DT);
  for (let i = 0; i < ticks; i++) evs.push(...a.update(DT, input, motion));
  return evs;
}
/** 버튼을 한 틱 누르고 뗀다 */
function click(a, field = 'fireDown') {
  const evs = a.update(DT, { [field]: true });
  evs.push(...a.update(DT, {}));
  return evs;
}
const tapZoom = (a) => click(a, 'zoomDown');
const only = (evs, type) => evs.filter((e) => e.type === type);
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);
const easeOutQuad = (t) => 1 - (1 - t) * (1 - t);
const lerp = (a, b, t) => a + (b - a) * t;

/* ---------- 표 ---------- */
describe('무기 표(DESIGN 3.2)', () => {
  test('17종 + 수류탄이 빠짐없이 있고 슬롯별 목록이 맞다', () => {
    assert.deepEqual([...WEAPON_IDS].sort(), [...ALL_IDS].sort());
    assert.equal(WEAPON_IDS.length, 18);
    assert.deepEqual([...PRIMARY_IDS].sort(), [...RIFLE_IDS, 'dm_mark', 'sm_vx3', 'sg_bx12', ...SNIPER_IDS].sort());
    assert.deepEqual([...SECONDARY_IDS].sort(), ['pt_magnum', 'pt_std']);
    assert.deepEqual([...MELEE_IDS].sort(), ['ml_gurkha', 'ml_katana', 'ml_knife', 'ml_tanto']);
    assert.deepEqual([...GRENADE_IDS], ['gr_frag']);
    for (const id of PRIMARY_IDS) assert.equal(WEAPONS[id].slot, 1, id);
    for (const id of SECONDARY_IDS) assert.equal(WEAPONS[id].slot, 2, id);
    for (const id of MELEE_IDS) assert.equal(WEAPONS[id].slot, 3, id);
    assert.equal(WEAPONS.gr_frag.slot, 4);
    assert.deepEqual({ ...DEFAULT_LOADOUT }, { primary: 'ar_std', secondary: 'pt_std', melee: 'ml_knife' });
  });

  for (const [id, t] of Object.entries(TABLE)) {
    test(`${id}: 이름·방식·피해·감쇠·탄·이동·가격`, () => {
      const d = WEAPONS[id];
      assert.equal(d.id, id);
      assert.equal(d.name, t.name);
      assert.equal(d.kind, t.kind);
      assert.equal(d.fire, t.fire);
      assert.deepEqual({ ...d.damage }, { head: t.head, body: t.body, legs: t.legs, hand: t.limb, foot: t.limb });
      assert.equal(d.mag, t.mag);
      assert.equal(d.reserve, t.reserve);
      assert.equal(d.moveMul, t.move);
      assert.equal(d.price, t.price);
      if (t.falloff) assert.deepEqual({ ...d.falloff }, { start: t.falloff[0], end: t.falloff[1], min: t.falloff[2] });
      else assert.equal(d.falloff, null);
      if (t.rpm) {
        assert.equal(d.rpm, t.rpm);
        near(d.fireInterval, 60 / t.rpm);
      } else {
        near(d.fireInterval, t.interval);
      }
    });
  }

  test('연사 수치가 서로 맞다: 볼트 = 재사격 간격, 점사 rpm = 실효 연사', () => {
    for (const id of SNIPER_IDS) assert.equal(WEAPONS[id].bolt, WEAPONS[id].fireInterval, id);
    for (const id of GUN_IDS.filter((i) => WEAPONS[i].fire !== 'burst')) {
      assert.equal(WEAPONS[id].rpm, Math.round(60 / WEAPONS[id].fireInterval), id);
    }
    const b = WEAPONS.ar_burst;
    assert.deepEqual({ ...b.burst }, { count: 3, gap: 0.065 });
    assert.equal(b.rpm, Math.round((b.burst.count * 60) / ((b.burst.count - 1) * b.burst.gap + b.fireInterval)));
  });

  for (const [id, t] of Object.entries(MELEE_TABLE)) {
    test(`${id}: 베기·찌르기 표`, () => {
      const d = WEAPONS[id];
      assert.equal(d.name, t.name);
      assert.equal(d.kind, 'melee');
      assert.equal(d.fire, 'melee');
      assert.equal(d.moveMul, t.move);
      assert.equal(d.price, t.price);
      for (const k of ['slash', 'stab']) {
        const m = d.melee[k];
        assert.deepEqual([m.damage, m.cooldown, m.range, m.arc], t[k], k);
        assert.ok(m.windup > 0 && m.windup < m.cooldown, k);
      }
    });
  }

  test('수류탄은 기존 수치 그대로다', () => {
    const g = WEAPONS.gr_frag;
    assert.equal(g.kind, 'grenade');
    assert.equal(g.fire, 'throw');
    assert.equal(g.count, 1);
    assert.equal(g.fuse, 2.5);
    assert.equal(g.moveMul, 1);
    assert.equal(g.price, 0);
    assert.deepEqual({ ...g.explosion }, { radius: 6, inner: 0.8, max: 100 });
    assert.deepEqual({ ...g.throw }, { speed: 16, pitchUp: 6 });
    assert.deepEqual({ ...g.lob }, { speed: 8, pitchUp: 4 });
    assert.equal(GRENADE_PHYSICS, g.physics);
  });

  test('모든 무기에 스키마 필드가 있다', () => {
    const fields = ['id', 'slot', 'kind', 'fire', 'category', 'name', 'short', 'nameEn', 'role', 'icon', 'color', 'tagline',
      'stats', 'bars', 'sound', 'fxKind', 'price', 'spread', 'recoil', 'reload', 'mag', 'reserve', 'drawTime', 'moveMul',
      'maxRange', 'fireInterval', 'rpm'];
    for (const id of ALL_IDS) {
      const d = WEAPONS[id];
      for (const f of fields) assert.ok(f in d, `${id}.${f}`);
      for (const f of ['name', 'short', 'nameEn', 'role', 'icon', 'tagline', 'sound']) {
        assert.ok(typeof d[f] === 'string' && d[f].length > 0, `${id}.${f}`);
      }
      assert.match(d.color, /^#[0-9a-f]{6}$/i, id);
      assert.ok(d.drawTime > 0 && d.moveMul > 0 && d.maxRange > 0 && d.fireInterval > 0 && d.rpm > 0, id);
      for (const k of ['power', 'rate', 'accuracy', 'mobility']) {
        assert.ok(d.bars[k] >= 0 && d.bars[k] <= 100, `${id}.bars.${k}`);
      }
      assert.ok(Array.isArray(d.stats) && d.stats.length >= 3, id);
      for (const row of d.stats) assert.ok(row.label && row.value, id);
    }
    for (const id of GUN_IDS) {
      const d = WEAPONS[id];
      assert.ok(d.reload > 0 && d.reloadEmpty >= d.reload, id);
      assert.ok(d.spread.hip >= 0 && d.spread.max >= d.spread.hip, id);
      assert.ok(d.recoil.pattern.length >= 1, id);
    }
  });

  test('막대 그래프 순위가 무기 성격과 맞다', () => {
    const b = (id) => WEAPONS[id].bars;
    assert.ok(b('ar_rapid').rate > b('ar_std').rate && b('ar_rapid').accuracy < b('ar_std').accuracy);
    assert.ok(b('ar_line').accuracy > b('ar_std').accuracy && b('ar_line').power < b('ar_std').power);
    assert.ok(b('sm_vx3').mobility > b('ar_std').mobility && b('sm_vx3').rate > b('ar_rapid').rate);
    assert.equal(Math.max(...GUN_IDS.map((id) => b(id).power)), b('sr_heavy').power);
    assert.equal(Math.min(...SNIPER_IDS.map((id) => b(id).mobility)), b('sr_heavy').mobility);
    assert.ok(b('ml_knife').mobility > b('ml_katana').mobility && b('ml_katana').power > b('ml_knife').power);
  });

  test('분류(category)는 상점 탭과 맞다: 지정사수는 라이플, 샷건은 SMG 탭', () => {
    const expected = {
      ar_std: 'rifle', ar_rapid: 'rifle', ar_line: 'rifle', ar_burst: 'rifle', dm_mark: 'rifle',
      sm_vx3: 'smg', sg_bx12: 'smg',
      sr_bolt: 'sniper', sr_twin: 'sniper', sr_swift: 'sniper', sr_heavy: 'sniper',
      pt_std: 'pistol', pt_magnum: 'pistol', ml_knife: 'melee', ml_tanto: 'melee', ml_gurkha: 'melee', ml_katana: 'melee', gr_frag: 'grenade',
    };
    for (const id of ALL_IDS) assert.equal(WEAPONS[id].category, expected[id], id);
  });

  test('사운드·이펙트 이름(DESIGN 3.5)', () => {
    const sound = {
      ar_std: 'rifle', ar_rapid: 'rifle', ar_line: 'rifle', ar_burst: 'rifle', dm_mark: 'dmr', sm_vx3: 'smg', sg_bx12: 'shotgun',
      sr_bolt: 'sniper', sr_twin: 'sniper', sr_swift: 'sniper', sr_heavy: 'sniper', pt_std: 'pistol', pt_magnum: 'magnum',
    };
    for (const id of GUN_IDS) {
      assert.equal(WEAPONS[id].sound, sound[id], id);
      assert.ok(['rifle', 'sniper', 'pistol'].includes(WEAPONS[id].fxKind), id);
    }
    for (const id of SNIPER_IDS) assert.equal(WEAPONS[id].fxKind, 'sniper', id);
    assert.equal(WEAPONS.ml_katana.sound, 'katana_swing');
    assert.equal(WEAPONS.ml_katana.heavySound, 'katana_heavy');
    assert.equal(WEAPONS.ml_katana.hitSound, 'katana_hit');
    assert.equal(WEAPONS.ml_knife.sound, 'knife_slash');
    assert.equal(WEAPONS.ml_knife.hitSound, 'knife_hit');
  });

  test('카드 문구가 표의 숫자와 같다', () => {
    for (const id of GUN_IDS) {
      const d = WEAPONS[id];
      const text = d.stats.map((s) => `${s.label} ${s.value}`).join('\n');
      assert.ok(text.includes(`${d.mag} / ${d.premium ? '무제한' : d.reserve}`), `${id} 탄약`);
      assert.ok(text.includes(`머리 ${d.damage.head}`) && text.includes(`몸 ${d.damage.body}`) && text.includes(`다리 ${d.damage.legs}`), `${id} 피해`);
      assert.ok(text.includes(`손·발 ${d.damage.hand}`), `${id} 손·발`);
      assert.ok(text.includes(`이동 ${Math.round(d.moveMul * 100)}%`), `${id} 이동`);
      if (d.falloff) assert.ok(text.includes(`${d.falloff.start}~${d.falloff.end} m → ${Math.round(d.falloff.min * 100)}%`), `${id} 감쇠`);
      else assert.ok(text.includes('감쇠 없음'), `${id} 감쇠 없음`);
      if (d.fire === 'auto') assert.ok(text.includes(`${d.rpm} rpm`), `${id} 연사`);
      if (d.fire === 'bolt') assert.ok(text.includes(`볼트 ${d.bolt}초`), `${id} 볼트`);
      if (d.zoom) {
        const mags = d.zoom.levels || [d.zoom.mag];
        for (const m of mags) assert.ok(text.includes(`${m}배`), `${id} 줌 ${m}`);
      }
    }
    const burst = WEAPONS.ar_burst.stats.map((s) => s.value).join(' ');
    assert.ok(burst.includes('3발') && burst.includes('0.065초') && burst.includes('0.36초'));
    assert.ok(WEAPONS.sg_bx12.stats.some((s) => s.value.includes('펠릿 8발')));
    for (const id of MELEE_IDS) {
      const text = WEAPONS[id].stats.map((s) => s.value).join(' ');
      for (const k of ['slash', 'stab']) {
        const m = WEAPONS[id].melee[k];
        assert.ok(text.includes(`${m.damage} · ${m.cooldown}초 · ${m.range} m`), `${id} ${k}`);
      }
    }
    assert.ok(WEAPONS.ml_katana.stats.some((s) => s.label === '강타'));
  });

  test('"반샷"은 손·발 반피 타격만 뜻하고, 빠른 줌 사격은 "퀵스코프"다', () => {
    const rows = ALL_IDS.flatMap((id) => WEAPONS[id].stats.map((s) => ({ id, ...s })));
    const half = rows.filter((r) => `${r.label}${r.value}`.includes('반샷'));
    assert.deepEqual(half.map((r) => r.id).sort(), [...SNIPER_IDS].sort());
    for (const r of half) {
      assert.equal(r.label, '반샷');
      assert.ok(r.value.includes(`손·발 ${WEAPONS[r.id].damage.hand}`), r.id);
      assert.ok(!r.value.includes('줌'), r.id);
    }
    for (const id of SNIPER_IDS) {
      const q = WEAPONS[id].stats.find((s) => s.label === '퀵스코프');
      assert.ok(q && q.value.includes('정조준') && q.value.includes('줌'), id);
    }
    assert.ok(!JSON.stringify(ALL_IDS.map((id) => WEAPONS[id].tagline + WEAPONS[id].desc)).includes('반샷 줌'));
  });

  test('없앤 개념이 남아 있지 않다: 도메인 해설, 최소 피해, 1발 킬 플래그, 슬롯 기본값', () => {
    for (const id of ALL_IDS) {
      for (const f of ['term', 'minDamage', 'oneShotKill', 'glossary', 'domain']) assert.ok(!(f in WEAPONS[id]), `${id}.${f}`);
    }
    assert.ok(!('SLOT_DEFAULTS' in defs));
    assert.equal(defs.damage, computeDamage);
    const domain = /NOR|DWT|SOF|Hawser|Bunker|호서|계류|벙커|용선|체선|탱커|유조선|선박|정박|재화중량|사실기록서|하역/;
    for (const id of ALL_IDS) {
      const d = WEAPONS[id];
      const shown = JSON.stringify([d.name, d.nameEn, d.short, d.role, d.tagline, d.desc, d.stats]);
      assert.ok(!domain.test(shown), `${id}: ${shown}`);
    }
  });

  test('표는 읽기 전용이다', () => {
    assert.ok(Object.isFrozen(WEAPONS));
    assert.ok(Object.isFrozen(WEAPONS.ar_std.damage));
    assert.ok(Object.isFrozen(WEAPONS.ar_std.recoil.pattern[0]));
    assert.ok(Object.isFrozen(WEAPONS.sr_twin.zoom.levels));
    assert.ok(Object.isFrozen(PRIMARY_IDS));
  });

  test('공용 도우미와 상수가 남아 있다', () => {
    assert.equal(PLAYER_HP, 100);
    assert.equal(WALK_SPEED, 5.2);
    assert.equal(BASE_FOV, 75);
    near(DEG, Math.PI / 180);
    assert.deepEqual([...PARTS], ['head', 'body', 'legs', 'hand', 'foot']);
    const v = vec3(1, 2, 3);
    assert.deepEqual([v[0], v[1], v[2], v.x, v.y, v.z], [1, 2, 3, 1, 2, 3]);
    const w = toVec3({ x: 4, y: 'no', z: 6 });
    assert.deepEqual([w.x, w.y, w.z], [4, 0, 6]);
    assert.equal(getDef('없는 무기'), null);
    assert.equal(getDef('constructor'), null);
    near(zoomFov(75, 1), 75);
    near(Math.tan((zoomFov(75, 4) * DEG) / 2), Math.tan((75 * DEG) / 2) / 4);
    assert.equal(falloffMul(null, 999), 1);
  });
});

/* ---------- 반동·탄퍼짐 ---------- */
describe('반동·탄퍼짐', () => {
  const sumAbs = (pat, axis) => pat.reduce((s, p) => s + Math.abs(p[axis]), 0);
  const climbAfter = (id, seconds) => {
    const a = createArsenal({ primary: id, rng: () => 0 });
    run(a, seconds, { fireDown: true });
    return a.getRecoilKick().pitch;
  };

  test('총마다 반동 패턴이 다르다', () => {
    const seen = new Map();
    for (const id of GUN_IDS) {
      const key = JSON.stringify(WEAPONS[id].recoil.pattern);
      assert.ok(!seen.has(key), `${id}와 ${seen.get(key)}의 패턴이 같다`);
      seen.set(key, id);
    }
  });

  test('ar_line의 반동은 ar_std의 약 40%다', () => {
    const line = WEAPONS.ar_line.recoil, std = WEAPONS.ar_std.recoil;
    const same = std.pattern.slice(0, line.pattern.length);
    for (const axis of [0, 1]) {
      const ratio = sumAbs(line.pattern, axis) / sumAbs(same, axis);
      assert.ok(ratio >= 0.35 && ratio <= 0.45, `축 ${axis}: ${ratio}`);
    }
    near(line.maxPitch / std.maxPitch, 0.4);
    near(line.maxYaw / std.maxYaw, 0.4);
    assert.ok(climbAfter('ar_line', 0.6) < climbAfter('ar_std', 0.6) * 0.5);
  });

  test('ar_line의 탄퍼짐은 ar_std보다 좁다', () => {
    const line = WEAPONS.ar_line.spread, std = WEAPONS.ar_std.spread;
    for (const k of ['hip', 'ads', 'move', 'adsMove', 'bloomPerShot', 'bloomMax']) assert.ok(line[k] < std[k], k);
  });

  test('ar_rapid는 ar_std보다 확실히 제어하기 어렵다', () => {
    const rapid = WEAPONS.ar_rapid, std = WEAPONS.ar_std;
    const same = rapid.recoil.pattern.slice(0, std.recoil.pattern.length);
    assert.ok(sumAbs(same, 1) > sumAbs(std.recoil.pattern, 1) * 1.2);
    assert.ok(sumAbs(same, 0) > sumAbs(std.recoil.pattern, 0) * 1.2);
    for (const k of ['maxPitch', 'maxYaw', 'adsMul']) assert.ok(rapid.recoil[k] > std.recoil[k], k);
    for (const k of ['hip', 'ads', 'move', 'bloomPerShot', 'bloomMax']) assert.ok(rapid.spread[k] > std.spread[k], k);
    assert.ok(climbAfter('ar_rapid', 0.6) > climbAfter('ar_std', 0.6) * 1.4);
  });
});

/* ---------- computeDamage ---------- */
describe('computeDamage', () => {
  for (const [id, t] of Object.entries(TABLE)) {
    test(`${id}: 부위별 값과 거리 감쇠`, () => {
      assert.equal(computeDamage(id, 'head', 0), t.head);
      assert.equal(computeDamage(id, 'body', 0), t.body);
      assert.equal(computeDamage(id, 'legs', 0), t.legs);
      assert.equal(computeDamage(id, 'hand', 0), t.limb);
      assert.equal(computeDamage(id, 'foot', 0), t.limb);
      const headIgnores = !!WEAPONS[id].headIgnoresFalloff;
      for (const dist of [10, 25, 40, 55, 80, 120, 500]) {
        let mul = 1;
        if (t.falloff && dist > t.falloff[0]) {
          mul = dist >= t.falloff[1] ? t.falloff[2] : 1 + (t.falloff[2] - 1) * ((dist - t.falloff[0]) / (t.falloff[1] - t.falloff[0]));
        }
        assert.equal(computeDamage(id, 'body', dist), Math.max(1, Math.round(t.body * mul)), `몸 ${dist} m`);
        assert.equal(computeDamage(id, 'foot', dist), Math.max(1, Math.round(t.limb * mul)), `발 ${dist} m`);
        assert.equal(computeDamage(id, 'head', dist), headIgnores ? t.head : Math.max(1, Math.round(t.head * mul)), `머리 ${dist} m`);
      }
    });
  }

  test('감쇠 값을 직접 확인한다', () => {
    assert.equal(computeDamage('ar_std', 'body', 30), 30);
    assert.equal(computeDamage('ar_std', 'body', 55), 26);     // 30 × 0.875
    assert.equal(computeDamage('ar_std', 'body', 80), 23);     // 30 × 0.75 = 22.5
    assert.equal(computeDamage('sm_vx3', 'head', 40), 33);     // 60 × 0.55
    assert.equal(computeDamage('pt_std', 'head', 45), 42);     // 70 × 0.6
    assert.equal(computeDamage('pt_magnum', 'head', 60), 77);  // 110 × 0.7
  });

  test('라이플은 500 m에서도 머리 1발 킬이다', () => {
    const rifles = WEAPON_IDS.filter((id) => WEAPONS[id].kind === 'rifle');
    assert.deepEqual([...rifles].sort(), [...RIFLE_IDS].sort());
    for (const id of [...rifles, 'dm_mark']) {
      assert.equal(WEAPONS[id].headIgnoresFalloff, true, id);
      for (const dist of [0, 30, 80, 100, 250, 500, 5000]) {
        assert.ok(computeDamage(id, 'head', dist) >= 100, `${id} ${dist} m`);
      }
      assert.ok(WEAPONS[id].maxRange >= 180, `${id}: 가장 큰 맵의 대각선까지 닿아야 한다`);
    }
  });

  test('감쇠 무시는 머리에만 적용된다', () => {
    assert.ok(computeDamage('ar_std', 'body', 500) < 30);
    assert.ok(computeDamage('ar_std', 'hand', 500) < 15);
    assert.equal(computeDamage('sm_vx3', 'head', 500), 33);
  });

  test('저격 반샷: sr_bolt·sr_twin은 손·발 50, 나머지 부위는 1발 킬', () => {
    for (const id of ['sr_bolt', 'sr_twin']) {
      for (const dist of [0, 100, 400, 2000]) {
        assert.equal(computeDamage(id, 'hand', dist), 50, `${id} 손 ${dist}`);
        assert.equal(computeDamage(id, 'foot', dist), 50, `${id} 발 ${dist}`);
        for (const part of ['head', 'body', 'legs']) {
          assert.ok(computeDamage(id, part, dist) >= PLAYER_HP, `${id} ${part} ${dist}`);
        }
      }
    }
  });

  test('sr_swift는 몸 1발 킬이 아니고 머리만 1발이다', () => {
    assert.equal(computeDamage('sr_swift', 'body', 50), 85);
    assert.ok(computeDamage('sr_swift', 'body', 0) < PLAYER_HP);
    assert.ok(computeDamage('sr_swift', 'legs', 0) < PLAYER_HP);
    assert.ok(computeDamage('sr_swift', 'head', 0) >= PLAYER_HP);
    assert.equal(computeDamage('sr_swift', 'hand', 0), 40);
  });

  test('sr_heavy는 머리·몸·다리 1발, 반샷 70', () => {
    for (const part of ['head', 'body', 'legs']) assert.ok(computeDamage('sr_heavy', part, 500) >= PLAYER_HP, part);
    assert.equal(computeDamage('sr_heavy', 'hand', 500), 70);
    assert.equal(computeDamage('sr_heavy', 'foot', 500), 70);
  });

  test('산탄은 맞은 펠릿 수를 곱한 뒤 반올림한다', () => {
    assert.equal(WEAPONS.sg_bx12.pellets, 8);
    assert.equal(computeDamage('sg_bx12', 'body', 0, undefined, 8), 112);
    assert.equal(computeDamage('sg_bx12', 'body', 0, undefined, 3), 42);
    assert.equal(computeDamage('sg_bx12', 'head', 8, undefined, 2), 40);
    assert.equal(computeDamage('sg_bx12', 'body', 22, undefined, 8), 39);   // 14 × 0.35 × 8 = 39.2
    assert.equal(computeDamage('sg_bx12', 'body', 15, undefined, 8), 76);   // 14 × 0.675 × 8 = 75.6
    assert.equal(computeDamage('sg_bx12', 'body', 0), 14);
  });

  test('잘못된 count는 1로 본다', () => {
    for (const count of [0, -3, NaN, undefined, null, 'x']) assert.equal(computeDamage('sg_bx12', 'body', 0, undefined, count), 14, String(count));
    assert.equal(computeDamage('sg_bx12', 'body', 0, undefined, 2.9), 28);
  });

  test('총은 최소 1이다. 잘못된 거리는 0으로 본다', () => {
    for (const id of GUN_IDS) for (const part of PARTS) assert.ok(computeDamage(id, part, 1e6) >= 1, `${id} ${part}`);
    for (const dist of [NaN, undefined, -5]) assert.equal(computeDamage('ar_std', 'body', dist), 30, String(dist));
  });

  test('칼은 부위와 거리를 무시하고 kind만 본다', () => {
    for (const part of [...PARTS, 'nothing']) {
      assert.equal(computeDamage('ml_knife', part, 99), 50);
      assert.equal(computeDamage('ml_knife', part, 99, 'slash'), 50);
      assert.equal(computeDamage('ml_knife', part, 99, 'stab'), 100);
      assert.equal(computeDamage('ml_katana', part, 99), 65);
      assert.equal(computeDamage('ml_katana', part, 99, 'stab'), 120);
    }
    assert.equal(computeDamage('ml_katana', 'head', 0, 'stab', 8), 120);
  });

  test('수류탄은 거리만 본다', () => {
    assert.equal(computeDamage('gr_frag', 'head', 0), 100);
    assert.equal(computeDamage('gr_frag', 'foot', 0.8), 100);
    assert.equal(computeDamage('gr_frag', 'body', 3.4), 50);
    assert.equal(computeDamage('gr_frag', 'body', 6), 0);
    assert.equal(computeDamage('gr_frag', 'body', 3.4), explosionFalloff(3.4));
    assert.equal(explosionFalloff(9), 0);
    const [hit] = explosionDamage([0, 0, 0], [{ id: 'a', points: [[0, 0, 3.4]] }], () => true, { lift: 0 });
    assert.equal(hit.damage, 50);
  });

  test('모르는 무기는 0이다', () => {
    assert.equal(computeDamage('nope', 'head', 0), 0);
    assert.equal(computeDamage('constructor', 'head', 0), 0);
  });

  test('normalizePart는 손·발을 뭉개지 않고 별칭을 묶는다', () => {
    const cases = {
      head: 'head', neck: 'head', helmet: 'head', HEAD: 'head',
      body: 'body', chest: 'body', torso: 'body', arm: 'body', arms: 'body',
      legs: 'legs', leg: 'legs',
      hand: 'hand', hands: 'hand', finger: 'hand', fingers: 'hand',
      foot: 'foot', feet: 'foot', boot: 'foot', boots: 'foot',
    };
    for (const [from, to] of Object.entries(cases)) assert.equal(normalizePart(from), to, from);
    for (const bad of [undefined, null, '', 'tail', 'constructor', '__proto__', 7]) assert.equal(normalizePart(bad), 'body', String(bad));
  });

  test('부위 별칭은 데미지에도 그대로 적용된다', () => {
    assert.equal(computeDamage('sr_bolt', 'fingers', 0), 50);
    assert.equal(computeDamage('sr_bolt', 'boot', 0), 50);
    assert.equal(computeDamage('sr_bolt', 'neck', 0), 200);
    assert.equal(computeDamage('sr_bolt', 'arm', 0), 120);
    assert.equal(computeDamage('sr_bolt', 'constructor', 0), 120);
  });

  test('isHalfShot', () => {
    for (const id of SNIPER_IDS) {
      for (const part of ['hand', 'foot', 'fingers', 'finger', 'feet', 'boot']) assert.equal(isHalfShot(id, part), true, `${id} ${part}`);
      for (const part of ['head', 'body', 'legs', 'neck', 'arm', undefined]) assert.equal(isHalfShot(id, part), false, `${id} ${part}`);
    }
    for (const id of ALL_IDS.filter((i) => !SNIPER_IDS.includes(i))) {
      assert.equal(isHalfShot(id, 'hand'), false, id);
      assert.equal(isHalfShot(id, 'foot'), false, id);
    }
    assert.equal(isHalfShot('nope', 'hand'), false);
  });

  test('minShotInterval: 점사는 점사 안 간격, 칼은 빠른 쪽 쿨다운', () => {
    assert.equal(minShotInterval('ar_burst'), 0.065);
    assert.equal(minShotInterval('ar_std'), 0.1);
    assert.equal(minShotInterval('sr_twin'), 1.35);
    assert.equal(minShotInterval('ml_knife'), 0.45);
    assert.equal(minShotInterval('ml_katana'), 0.62);
    assert.equal(minShotInterval('nope'), 0);
  });
});

/* ---------- 점사 ---------- */
describe('점사(fire: burst)', () => {
  const burstGun = () => createArsenal({ primary: 'ar_burst', rng: () => 0 });
  const { gap, count } = WEAPONS.ar_burst.burst;
  const rest = WEAPONS.ar_burst.fireInterval;

  test('클릭 한 번에 정확히 3발이 간격을 두고 나간다', () => {
    const a = burstGun();
    const evs = click(a);
    evs.push(...run(a, 1));
    const shots = only(evs, 'fire');
    assert.equal(shots.length, count);
    assert.ok(shots[1].t - shots[0].t >= gap - 1e-9 && shots[1].t - shots[0].t < gap + DT);
    near(shots[2].t - shots[0].t, 2 * gap, DT);
    assert.equal(a.getAmmo().mag, 27);
    assert.deepEqual(shots.map((s) => s.shotIndex), [0, 1, 2]);
    assert.deepEqual(shots.map((s) => s.weaponId), ['ar_burst', 'ar_burst', 'ar_burst']);
  });

  test('버튼을 바로 떼도 점사는 끝까지 나간다', () => {
    const a = burstGun();
    const first = a.update(DT, { fireDown: true });
    assert.equal(only(first, 'fire').length, 1);
    const rest2 = run(a, 0.3, { fireDown: false });
    assert.equal(only(rest2, 'fire').length, 2);
  });

  test('누르고 있어도 다시 쏘지 않는다', () => {
    const a = burstGun();
    const evs = run(a, 3, { fireDown: true });
    assert.equal(only(evs, 'fire').length, 3);
  });

  test('재사격은 점사가 끝나고 fireInterval을 기다린다', () => {
    const a = burstGun();
    const evs = [];
    for (let i = 0; i < 300; i++) evs.push(...a.update(DT, { fireDown: i % 2 === 0 }));   // 5초 동안 연타
    const shots = only(evs, 'fire');
    assert.equal(shots.length % count, 0);
    assert.ok(shots.length >= 24, `${shots.length}발`);
    for (let i = 0; i + 1 < shots.length; i++) {
      const dt = shots[i + 1].t - shots[i].t;
      if ((i + 1) % count === 0) assert.ok(dt >= rest - DT, `점사 사이 ${dt}`);
      else assert.ok(dt < rest / 2, `점사 안 ${dt}`);
    }
  });

  test('재사격 대기 0.1초 전의 클릭은 기억했다가 쏘고, 그 전의 클릭은 버린다', () => {
    const a = burstGun();
    click(a);
    run(a, 2 * gap + rest - 0.05);          // 쉬는 시간이 끝나기 조금 전
    const buffered = click(a);
    buffered.push(...run(a, 0.1));
    assert.ok(only(buffered, 'fire').length >= 1, '버퍼된 클릭');

    const b = burstGun();
    click(b);
    run(b, 0.2);                            // 쉬는 시간이 한참 남았을 때
    const early = click(b);
    early.push(...run(b, 1));
    assert.equal(only(early, 'fire').length, 0);
  });

  test('탄이 떨어지면 점사가 거기서 끝나고 자동 재장전한다', () => {
    const a = burstGun();
    a.update(DT, { fireDown: true });        // 첫 발만 쏘고 교체해서 탄창을 3의 배수에서 벗어나게 한다
    const away = a.update(DT, { slot: 2 });
    assert.equal(only(away, 'switch').length, 1);
    assert.equal(a.getAmmo('ar_burst').mag, 29);
    run(a, 0.6);
    a.update(DT, { slot: 1 });
    assert.equal(only(run(a, 1), 'fire').length, 0, '교체로 끊긴 점사는 이어지지 않는다');
    for (let i = 0; i < 9; i++) {
      assert.equal(only([...click(a), ...run(a, 0.7)], 'fire').length, 3, `${i}번째 점사`);
    }
    assert.equal(a.getAmmo().mag, 2);
    const last = [...click(a), ...run(a, 0.2)];
    assert.equal(only(last, 'fire').length, 2);
    assert.equal(a.getAmmo().mag, 0);
    assert.equal(only(last, 'reloadStart').length, 0, '쉬는 시간이 끝나야 재장전한다');
    const after = run(a, 0.5);
    const start = only(after, 'reloadStart')[0];
    assert.ok(start && start.empty === true);
    assert.equal(only(run(a, WEAPONS.ar_burst.reloadEmpty + 0.1), 'reloadEnd').length, 1);
    assert.equal(a.getAmmo().mag, 30);
    assert.equal(a.getAmmo().reserve, 30);
  });

  test('R을 눌러도 시작한 점사를 끊지 않는다', () => {
    const a = burstGun();
    a.update(DT, { fireDown: true });
    const evs = run(a, 0.15, { reloadPressed: true });
    assert.equal(only(evs, 'fire').length, 2);
    assert.equal(only(evs, 'reloadStart').length, 0);
    assert.equal(only(run(a, 0.5), 'reloadStart').length, 1);
  });

  test('긴 프레임에서도 정확히 3발이다', () => {
    const a = burstGun();
    const evs = a.update(0.25, { fireDown: true });
    evs.push(...a.update(0.25, {}));
    evs.push(...a.update(0.2, {}));
    assert.equal(only(evs, 'fire').length, 3);
  });

  test('resetRound는 진행 중인 점사를 지운다', () => {
    const a = burstGun();
    a.update(DT, { fireDown: true });
    a.resetRound({ draw: false });
    assert.equal(only(run(a, 0.5), 'fire').length, 0);
    assert.equal(a.getAmmo().mag, 30);
  });
});

/* ---------- 다단 줌 ---------- */
describe('다단 줌(sr_twin)', () => {
  const twin = (zoomMode = 'hold') => createArsenal({ primary: 'sr_twin', zoomMode, rng: () => 0 });
  const SETTLE = 0.4;
  const z = WEAPONS.sr_twin.zoom;

  for (const mode of ['hold', 'toggle']) {
    test(`우클릭마다 0 → 1단 → 2단 → 0 (${mode})`, () => {
      const a = twin(mode);
      let g = a.getZoom(75);
      assert.deepEqual([g.level, g.levels, g.curMag, g.fov, g.zoomed], [0, 2, 1, 75, false]);

      let evs = tapZoom(a);
      assert.deepEqual(only(evs, 'zoomChange').map((e) => [e.zoomed, e.level]), [[true, 1]]);
      run(a, SETTLE);
      g = a.getZoom(75);
      assert.deepEqual([g.level, g.levels, g.mag, g.curMag, g.progress, g.zoomed], [1, 2, 4, 4, 1, true]);
      near(g.fov, zoomFov(75, 4));
      near(g.targetFov, zoomFov(75, 4));
      assert.equal(g.overlay, 'scope');
      assert.equal(g.scopeAmount, 1);
      assert.equal(g.hideViewmodel, true);
      assert.equal(g.accurate, true);

      evs = tapZoom(a);
      assert.deepEqual(only(evs, 'zoomChange').map((e) => [e.zoomed, e.level]), [[true, 2]]);
      run(a, SETTLE);
      g = a.getZoom(75);
      assert.deepEqual([g.level, g.mag, g.curMag, g.progress], [2, 9, 9, 1]);
      near(g.fov, zoomFov(75, 9));
      near(g.targetFov, zoomFov(75, 9));
      assert.equal(a.getSpread().deg, 0);

      evs = tapZoom(a);
      assert.deepEqual(only(evs, 'zoomChange').map((e) => [e.zoomed, e.level]), [[false, 0]]);
      run(a, SETTLE);
      g = a.getZoom(75);
      assert.deepEqual([g.level, g.curMag, g.fov, g.progress, g.zoomed, g.scopeAmount], [0, 1, 75, 0, false, 0]);

      tapZoom(a);
      run(a, SETTLE);
      g = a.getZoom(75);
      assert.deepEqual([g.level, g.mag, g.curMag], [1, 4, 4]);
    });

    test(`버튼을 떼도 줌이 풀리지 않고, 누르고 있어도 다음 단계로 넘어가지 않는다 (${mode})`, () => {
      const a = twin(mode);
      run(a, 1, { zoomDown: true });
      assert.equal(a.getZoom().level, 1);
      run(a, 1, {});
      assert.equal(a.getZoom().level, 1);
    });

    test(`사격하면 0으로 돌아가고 다음 누름은 1단부터다 (${mode})`, () => {
      const a = twin(mode);
      tapZoom(a);
      tapZoom(a);
      run(a, SETTLE);
      assert.equal(a.getZoom().level, 2);

      const evs = click(a);
      const shot = only(evs, 'fire')[0];
      assert.equal(shot.level, 2);
      assert.equal(shot.scoped, true);
      assert.equal(shot.quickscope, false);
      assert.equal(shot.noscope, false);
      assert.equal(shot.spreadDeg, 0);
      assert.deepEqual(only(evs, 'zoomChange').map((e) => [e.zoomed, e.level]), [[false, 0]]);
      assert.equal(only(evs, 'boltCycle')[0].duration, 1.35);
      assert.equal(a.getZoom().level, 0);
      assert.equal(a.getWeapon().state, 'bolt');

      run(a, 1.4);
      let g = a.getZoom(75);
      assert.deepEqual([g.level, g.curMag, g.fov, g.progress], [0, 1, 75, 0]);
      assert.equal(a.getWeapon().state, 'idle');

      tapZoom(a);
      run(a, SETTLE);
      g = a.getZoom(75);
      assert.deepEqual([g.level, g.mag, g.curMag], [1, 4, 4]);
      near(g.fov, zoomFov(75, 4));
    });
  }

  test('입력 계층이 같은 클릭을 두 신호로 보내도 한 단계만 넘어간다', () => {
    const a = twin('toggle');
    a.update(DT, { zoomDown: true, zoomToggle: true });
    a.update(DT, { zoomDown: false, zoomToggle: false });
    assert.equal(a.getZoom().level, 1);
    a.update(DT, { zoomDown: true, zoomToggle: true });
    a.update(DT, { zoomDown: false, zoomToggle: false });
    assert.equal(a.getZoom().level, 2);
  });

  test('틱 사이에 끝난 짧은 클릭(zoomToggle만)도 센다. 계속 true면 한 번만 센다', () => {
    const a = twin('hold');
    a.update(DT, { zoomDown: false, zoomToggle: true });
    assert.equal(a.getZoom().level, 1);
    run(a, 0.5, { zoomDown: false, zoomToggle: true });
    assert.equal(a.getZoom().level, 1);
    a.update(DT, { zoomDown: false, zoomToggle: false });
    a.update(DT, { zoomDown: false, zoomToggle: true });
    assert.equal(a.getZoom().level, 2);
  });

  test('줌 방식 설정을 바꿔도 단계는 그대로다', () => {
    const a = twin('hold');
    tapZoom(a);
    a.setZoomMode('toggle');
    a.update(DT, {});
    assert.equal(a.getZoom().level, 1);
    a.setZoomMode('hold');
    a.update(DT, {});
    assert.equal(a.getZoom().level, 1);
  });

  test('1단 줌 인은 단일 배율과 같은 곡선이다', () => {
    const a = twin();
    a.update(DT, { zoomDown: true });
    for (let n = 1; n < 12; n++) {
      const p = (n * DT) / z.inTime;
      const g = a.getZoom(75);
      near(g.progress, p);
      near(g.curMag, lerp(1, 4, easeOutQuad(p)));
      a.update(DT, { zoomDown: true });
    }
  });

  test('단계 사이는 부드럽게 옮겨 간다', () => {
    const a = twin();
    tapZoom(a);
    run(a, SETTLE);

    a.update(DT, { zoomDown: true });
    a.update(DT, {});
    let last = a.getZoom().curMag;
    assert.ok(last > 4 && last < 9, `${last}`);
    assert.equal(a.getZoom().progress, 1, '단계를 옮기는 동안 조준은 풀리지 않는다');
    assert.equal(a.getZoom().scopeAmount, 1);
    let steps = 0;
    while (a.getZoom().curMag < 9 && steps < 60) {
      a.update(DT, {});
      const m = a.getZoom().curMag;
      assert.ok(m >= last, '4배 → 9배는 줄어들지 않는다');
      assert.ok(m - last <= 1.2, `한 틱에 ${m - last}`);
      assert.equal(a.getZoom().accurate, true);
      last = m;
      steps++;
    }
    assert.equal(last, 9);
    assert.ok((steps + 2) * DT >= z.levelTime - DT, '순간 이동이 아니다');
    assert.ok((steps + 2) * DT <= z.levelTime + 2 * DT, '정해진 시간에 끝난다');

    a.update(DT, { zoomDown: true });
    a.update(DT, {});
    last = a.getZoom().curMag;
    assert.ok(last <= 9);
    steps = 0;
    while (a.getZoom().curMag > 1 && steps < 60) {
      a.update(DT, {});
      const m = a.getZoom().curMag;
      assert.ok(m <= last, '줌 아웃은 늘어나지 않는다');
      assert.ok(last - m <= 3, `한 틱에 ${last - m}`);
      last = m;
      steps++;
    }
    assert.equal(last, 1);
  });

  test('줌 아웃 중에는 마지막 단계 배율을 알린다(스코프 표시가 바뀌지 않게)', () => {
    const a = twin();
    tapZoom(a);
    tapZoom(a);
    run(a, SETTLE);
    tapZoom(a);
    const g = a.getZoom();
    assert.equal(g.level, 0);
    assert.ok(g.progress > 0);
    assert.equal(g.mag, 9);
    run(a, SETTLE);
    assert.equal(a.getZoom().mag, 4, '다 풀리면 다음 줌의 배율을 알린다');
  });

  test('전환 도중에 다시 눌러도 배율이 튀지 않는다', () => {
    const a = twin();
    const watch = (input) => {
      const before = a.getZoom().curMag;
      a.update(DT, input);
      const after = a.getZoom().curMag;
      assert.ok(Math.abs(after - before) <= 3, `${before} → ${after}`);
    };
    watch({ zoomDown: true });
    watch({});
    for (let i = 0; i < 30; i++) watch({});
    for (const hold of [2, 3, 2, 4, 1, 3, 2, 2, 5, 2, 3]) {     // 전환이 끝나기 전에 계속 누른다
      watch({ zoomDown: true });
      for (let i = 0; i < hold; i++) watch({});
    }
    for (let i = 0; i < 40; i++) watch({});
    const g = a.getZoom();
    assert.equal(g.curMag, g.level === 0 ? 1 : g.mag);
  });

  test('볼트 중에 누르면 볼트가 끝난 뒤 1단이 걸린다', () => {
    const a = twin();
    tapZoom(a);
    run(a, SETTLE);
    click(a);
    run(a, 0.2);
    tapZoom(a);
    assert.equal(a.getZoom().level, 0);
    assert.equal(a.getZoom().zoomed, false);
    assert.equal(a.getZoom().progress, 0);
    const evs = run(a, 1.5);
    assert.deepEqual(only(evs, 'zoomChange').map((e) => [e.zoomed, e.level]), [[true, 1]]);
    assert.equal(a.getZoom().level, 1);
    assert.equal(a.getZoom().curMag, 4);
  });

  test('재장전과 교체는 줌을 해제하고 다음 누름은 1단부터다', () => {
    const a = twin();
    click(a);
    run(a, 1.4);
    tapZoom(a);
    tapZoom(a);
    run(a, SETTLE);
    assert.equal(a.getZoom().level, 2);

    const evs = a.update(DT, { reloadPressed: true });
    assert.equal(only(evs, 'reloadStart').length, 1);
    assert.deepEqual(only(evs, 'zoomChange').map((e) => [e.zoomed, e.level]), [[false, 0]]);
    run(a, WEAPONS.sr_twin.reload + 0.1);
    assert.equal(a.getZoom().level, 0);
    tapZoom(a);
    tapZoom(a);
    run(a, SETTLE);
    assert.equal(a.getZoom().level, 2);

    a.update(DT, { slot: 2 });
    assert.equal(a.getZoom(75).fov, 75);
    assert.equal(a.getZoom().levels, 0);
    run(a, 1);
    a.update(DT, { slot: 1 });
    run(a, 2);
    assert.equal(a.getZoom().level, 0);
    assert.equal(a.getZoom(75).fov, 75);
    tapZoom(a);
    run(a, SETTLE);
    assert.equal(a.getZoom().level, 1);
    assert.equal(a.getZoom().curMag, 4);
  });

  test('getViewState가 무기·단계를 알려 준다', () => {
    const a = twin();
    assert.deepEqual((({ weaponId, level, levels }) => [weaponId, level, levels])(a.getViewState(75)), ['sr_twin', 0, 2]);
    tapZoom(a);
    tapZoom(a);
    run(a, SETTLE);
    const v = a.getViewState(75);
    assert.deepEqual([v.level, v.levels, v.curMag, v.zoom, v.overlay, v.hideViewmodel], [2, 2, 9, 1, 'scope', true]);
  });

  test('이동 배율은 조준 진행도를 따른다', () => {
    const a = twin();
    near(a.getMoveMul(), 0.82);
    tapZoom(a);
    tapZoom(a);
    run(a, SETTLE);
    near(a.getMoveMul(), 0.82 * z.moveMul);
  });

  test('stageCycle:false면 1단만 쓰는 hold 줌이다(봇용)', () => {
    const a = createArsenal({ primary: 'sr_twin', stageCycle: false, rng: () => 0 });
    run(a, 0.5, { zoomDown: true });
    let g = a.getZoom(75);
    assert.deepEqual([g.level, g.levels, g.mag, g.curMag], [1, 2, 4, 4]);
    run(a, 0.5, {});
    assert.equal(a.getZoom().level, 0);
    assert.equal(a.getZoom(75).fov, 75);
    run(a, 0.5, { zoomDown: true });
    assert.equal(a.getZoom().level, 1, '2단으로 넘어가지 않는다');
    const evs = a.update(DT, { zoomDown: true, fireDown: true });
    assert.equal(only(evs, 'fire').length, 1);
    run(a, 1.5, { zoomDown: true });
    assert.equal(a.getZoom().level, 0, '사격 후에는 뗐다가 다시 눌러야 한다');
  });
});

/* ---------- 단일 줌 회귀 ---------- */
describe('단일 배율 줌 회귀', () => {
  test('hold: 누르는 동안만 줌, 곡선과 FOV는 그대로다', () => {
    const a = createArsenal({ primary: 'sr_bolt', zoomMode: 'hold', rng: () => 0 });
    const z = WEAPONS.sr_bolt.zoom;
    assert.equal(z.mag, 4);
    assert.equal(z.levels, undefined);
    const first = a.update(DT, { zoomDown: true });
    assert.deepEqual(only(first, 'zoomChange').map((e) => [e.zoomed, e.level]), [[true, 1]]);
    for (let n = 1; n < 9; n++) {
      const p = Math.min(1, (n * DT) / z.inTime);
      const g = a.getZoom(75);
      near(g.progress, p);
      near(g.curMag, lerp(1, 4, easeOutQuad(p)));
      near(g.fov, zoomFov(75, lerp(1, 4, easeOutQuad(p))));
      assert.equal(g.mag, 4);
      assert.equal(g.level, 1);
      assert.equal(g.levels, 1);
      a.update(DT, { zoomDown: true });
    }
    run(a, 0.2, { zoomDown: true });
    let g = a.getZoom(75);
    assert.equal(g.curMag, 4);
    near(g.fov, zoomFov(75, 4));
    near(g.targetFov, zoomFov(75, 4));
    const off = a.update(DT, {});
    assert.deepEqual(only(off, 'zoomChange').map((e) => [e.zoomed, e.level]), [[false, 0]]);
    near(a.getZoom().progress, 1 - DT / z.outTime);
    run(a, 0.2, {});
    g = a.getZoom(75);
    assert.deepEqual([g.level, g.curMag, g.fov, g.progress], [0, 1, 75, 0]);
    assert.equal(g.mag, 4);
    near(g.targetFov, zoomFov(75, 4));
  });

  test('hold: 줌을 빠르게 다시 눌러도 다음 단계가 없다', () => {
    const a = createArsenal({ primary: 'sr_bolt', zoomMode: 'hold' });
    for (let i = 0; i < 5; i++) {
      run(a, 0.3, { zoomDown: true });
      assert.equal(a.getZoom().level, 1);
      assert.equal(a.getZoom().curMag, 4);
      run(a, 0.3, {});
      assert.equal(a.getZoom().level, 0);
    }
  });

  test('hold: 사격 후에는 뗐다가 다시 눌러야 하고, 볼트 중에 누르면 끝나자마자 걸린다', () => {
    const a = createArsenal({ primary: 'sr_bolt', zoomMode: 'hold', rng: () => 0 });
    run(a, 0.3, { zoomDown: true });
    const evs = a.update(DT, { zoomDown: true, fireDown: true });
    assert.equal(only(evs, 'fire').length, 1);
    assert.equal(only(evs, 'boltCycle').length, 1);
    assert.deepEqual(only(evs, 'zoomChange').map((e) => e.zoomed), [false]);
    run(a, 1.5, { zoomDown: true });
    assert.equal(a.getZoom().zoomed, false, '계속 누르고 있으면 다시 걸리지 않는다');
    a.update(DT, {});
    run(a, 0.3, { zoomDown: true });
    assert.equal(a.getZoom().zoomed, true);

    a.update(DT, { zoomDown: true, fireDown: true });
    a.update(DT, {});
    run(a, 0.3, { zoomDown: true });
    assert.equal(a.getZoom().zoomed, false, '볼트 중');
    run(a, 1.0, { zoomDown: true });
    assert.equal(a.getZoom().zoomed, true, '볼트가 끝나면 바로');
  });

  test('toggle: 눌러서 켜고 눌러서 끄며, 사격하면 꺼진다', () => {
    const a = createArsenal({ primary: 'sr_bolt', zoomMode: 'toggle', rng: () => 0 });
    const tap = () => {
      a.update(DT, { zoomDown: true, zoomToggle: true });
      a.update(DT, { zoomDown: false, zoomToggle: false });
    };
    tap();
    assert.equal(a.getZoom().zoomed, true);
    run(a, 0.3, {});
    assert.equal(a.getZoom().curMag, 4);
    assert.equal(a.getZoom().level, 1);
    tap();
    assert.equal(a.getZoom().zoomed, false);
    assert.equal(a.getZoom().level, 0);
    run(a, 0.3, {});
    assert.equal(a.getZoom().curMag, 1);
    tap();
    run(a, 0.3, {});
    click(a);
    assert.equal(a.getZoom().zoomed, false);
    run(a, 1.5, {});
    assert.equal(a.getZoom().zoomed, false, '다시 눌러야 한다');
    tap();
    run(a, 0.3, {});
    assert.equal(a.getZoom().zoomed, true);
    assert.equal(a.getZoom().mag, 4);
  });

  test('퀵스코프 경계: 줌 진행도 50%부터 정조준이다', () => {
    const a = createArsenal({ primary: 'sr_bolt', rng: () => 0 });
    assert.equal(a.getSpread().deg, 8);
    for (let i = 0; i < 4; i++) a.update(DT, { zoomDown: true });     // 0.4167
    assert.equal(a.getSpread().deg, 8);
    assert.equal(a.getZoom().accurate, false);
    a.update(DT, { zoomDown: true });                                 // 0.5208
    assert.equal(a.getSpread().deg, 0);
    assert.equal(a.getZoom().accurate, true);
    const evs = a.update(DT, { zoomDown: true, fireDown: true });
    const shot = only(evs, 'fire')[0];
    assert.equal(shot.quickscope, true);
    assert.equal(shot.scoped, true);
    assert.equal(shot.noscope, false);

    const b = createArsenal({ primary: 'sr_bolt', rng: () => 0 });
    const hip = only(click(b), 'fire')[0];
    assert.equal(hip.noscope, true);
    assert.equal(hip.quickscope, false);
  });

  test('라이플 정조준은 사격해도 풀리지 않고 스코프 오버레이가 없다', () => {
    const a = createArsenal({ primary: 'ar_std', rng: () => 0 });
    run(a, 0.3, { zoomDown: true });
    const evs = run(a, 0.3, { zoomDown: true, fireDown: true });
    assert.ok(only(evs, 'fire').length >= 3);
    assert.equal(only(evs, 'zoomChange').length, 0);
    const g = a.getZoom(75);
    assert.deepEqual([g.level, g.levels, g.mag, g.curMag, g.overlay, g.scopeAmount, g.hideViewmodel], [1, 1, 2, 2, null, 0, false]);
  });

  test('dm_mark: 3배, 오버레이 없음, 모형은 보인 채다', () => {
    const a = createArsenal({ primary: 'dm_mark', rng: () => 0 });
    run(a, 0.4, { zoomDown: true });
    const g = a.getZoom(75);
    assert.deepEqual([g.mag, g.curMag, g.overlay, g.scopeAmount, g.hideViewmodel, g.progress], [3, 3, null, 0, false, 1]);
    near(g.fov, zoomFov(75, 3));
    const shot = only(a.update(DT, { zoomDown: true, fireDown: true }), 'fire')[0];
    assert.equal(shot.quickscope, false);
    assert.equal(shot.noscope, false);
  });

  test('저격총 배율이 표와 같다', () => {
    const expected = { sr_bolt: [4], sr_twin: [4, 9], sr_swift: [3], sr_heavy: [5], dm_mark: [3] };
    for (const [id, mags] of Object.entries(expected)) {
      const zoom = WEAPONS[id].zoom;
      assert.deepEqual(zoom.levels ? [...zoom.levels] : [zoom.mag], mags, id);
    }
  });

  test('줌이 없는 무기는 level·levels가 0이다', () => {
    for (const primary of ['sg_bx12']) {
      const a = createArsenal({ primary });
      run(a, 0.5, { zoomDown: true });
      const g = a.getZoom(75);
      assert.deepEqual([g.level, g.levels, g.curMag, g.fov, g.zoomed], [0, 0, 1, 75, false], primary);
    }
    const a = createArsenal({});
    a.select(2);
    run(a, 1, { zoomDown: true });
    assert.deepEqual([a.getZoom().level, a.getZoom().levels], [0, 0]);
  });
});

/* ---------- 슬롯 제한 ---------- */
describe('허용 슬롯', () => {
  test('칼전: 칼로 시작하고 1·2·4번 키와 휠, select가 아무 일도 하지 않는다', () => {
    const a = createArsenal({ primary: 'sr_bolt', melee: 'ml_knife', allowedSlots: [3] });
    assert.equal(a.getWeapon().id, 'ml_knife');
    assert.equal(a.getWeapon().slot, 3);
    assert.deepEqual(a.getAllowedSlots(), [3]);
    for (const slot of [1, 2, 4]) {
      const evs = a.update(DT, { slot });
      assert.equal(only(evs, 'switch').length, 0, `키 ${slot}`);
      assert.equal(a.getWeapon().id, 'ml_knife');
      assert.equal(a.getWeapon().state, 'idle');
    }
    for (const wheel of [1, -1]) {
      assert.equal(only(a.update(DT, { wheel }), 'switch').length, 0);
      assert.equal(a.getWeapon().id, 'ml_knife');
    }
    for (const target of [1, 2, 4, 'sr_bolt', 'pt_std', 'gr_frag', 'ar_std']) assert.equal(a.select(target), false, String(target));
    assert.equal(only(a.update(DT, {}), 'switch').length, 0);
    assert.equal(a.getWeapon().id, 'ml_knife');
  });

  test('칼전: HUD와 슬롯 목록은 금지된 칸을 비워 둔다', () => {
    const a = createArsenal({ melee: 'ml_katana', allowedSlots: [3] });
    const hud = a.getHud(75);
    assert.deepEqual(hud.slots, [null, null, 'ml_katana', null]);
    assert.equal(hud.slot, 3);
    assert.equal(hud.ammo, null);
    assert.equal(hud.reserve, null);
    const slots = a.getSlots();
    assert.deepEqual(slots.map((s) => s.slot), [1, 2, 3, 4]);
    assert.deepEqual(slots.map((s) => s.id), [null, null, 'ml_katana', null]);
    assert.deepEqual(slots.map((s) => s.allowed), [false, false, true, false]);
    assert.deepEqual(slots.map((s) => s.active), [false, false, true, false]);
    assert.deepEqual(slots.map((s) => s.empty), [true, true, false, true]);
    assert.equal(slots[0].name, null);
    assert.equal(a.getAmmo('gr_frag').mag, 0, '금지된 수류탄은 0개로 알린다');
    assert.equal(a.getWeapon().previous, null);
  });

  test('칼전: 칼을 쓸 수 있고 이벤트에 실제 칼 id가 실린다', () => {
    const a = createArsenal({ melee: 'ml_katana', allowedSlots: [3] });
    const evs = run(a, 0.2, { fireDown: true });
    assert.equal(only(evs, 'swing')[0].weaponId, 'ml_katana');
    assert.equal(only(evs, 'melee')[0].weaponId, 'ml_katana');
  });

  test('금지된 슬롯을 빼고 시작 무기를 고른다', () => {
    assert.equal(createArsenal({ primary: 'sr_bolt', allowedSlots: [2, 3] }).getWeapon().id, 'pt_std');
    assert.equal(createArsenal({ primary: 'sr_bolt', allowedSlots: [3, 1] }).getWeapon().id, 'sr_bolt');
    assert.equal(createArsenal({ primary: 'sr_bolt', allowedSlots: [] }).getWeapon().id, 'sr_bolt', '빈 목록은 무시');
    assert.equal(createArsenal({ primary: 'sr_bolt', allowedSlots: 'x' }).getWeapon().id, 'sr_bolt');
    const drawn = createArsenal({ melee: 'ml_knife', allowedSlots: [3], draw: true });
    const [sw] = only(drawn.update(0, {}), 'switch');
    assert.deepEqual([sw.from, sw.to, sw.slot, sw.drawTime], [null, 'ml_knife', 3, WEAPONS.ml_knife.drawTime]);
    assert.equal(drawn.getWeapon().state, 'draw');
  });

  test('스나전: 슬롯 1과 3만 오간다', () => {
    const a = createArsenal({ primary: 'sr_twin', melee: 'ml_knife', allowedSlots: [1, 3] });
    assert.equal(a.getWeapon().id, 'sr_twin');
    assert.equal(only(a.update(DT, { slot: 2 }), 'switch').length, 0);
    assert.equal(only(a.update(DT, { slot: 4 }), 'switch').length, 0);
    assert.equal(only(a.update(DT, { wheel: 1 }), 'switch')[0].to, 'ml_knife');
    run(a, 1);
    assert.equal(only(a.update(DT, { wheel: 1 }), 'switch')[0].to, 'sr_twin');
    run(a, 1);
    assert.equal(only(a.update(DT, { wheel: -1 }), 'switch')[0].to, 'ml_knife');
    assert.deepEqual(a.getHud(75).slots, ['sr_twin', null, 'ml_knife', null]);
  });

  test('setAllowedSlots: 들고 있는 무기가 금지되면 허용된 첫 슬롯을 꺼낸다', () => {
    const a = createArsenal({ primary: 'ar_std', melee: 'ml_katana' });
    assert.equal(a.setAllowedSlots([3]), true);
    const [sw] = only(a.update(0, {}), 'switch');
    assert.deepEqual([sw.from, sw.to, sw.slot], ['ar_std', 'ml_katana', 3]);
    assert.equal(a.getWeapon().id, 'ml_katana');
    assert.equal(a.getWeapon().state, 'draw');
    assert.equal(a.getPrimary(), 'ar_std', '로드아웃은 그대로다');

    assert.equal(a.setAllowedSlots([1, 2, 3, 4]), true);
    assert.equal(a.getWeapon().id, 'ml_katana', '허용된 무기를 들고 있으면 그대로다');
    assert.equal(only(a.update(DT, {}), 'switch').length, 0);
    run(a, 1);
    assert.equal(only(a.update(DT, { slot: 1 }), 'switch')[0].to, 'ar_std');
  });

  test('setAllowedSlots: 잘못된 값은 거부하고 그대로 둔다', () => {
    const a = createArsenal({ allowedSlots: [1, 3] });
    for (const bad of [[], [9], null, undefined, 'x', [0, 5]]) assert.equal(a.setAllowedSlots(bad), false, String(bad));
    assert.deepEqual(a.getAllowedSlots(), [1, 3]);
    assert.equal(a.setAllowedSlots([3, 3, 1, 7]), true);
    assert.deepEqual(a.getAllowedSlots(), [1, 3]);
  });

  test('setAllowedSlots: 진행 중인 동작을 끊는다', () => {
    const reload = createArsenal({ primary: 'ar_std' });
    click(reload);
    run(reload, 0.2);
    reload.update(DT, { reloadPressed: true });
    assert.equal(reload.getWeapon().state, 'reload');
    reload.setAllowedSlots([3]);
    assert.deepEqual(only(reload.update(0, {}), 'reloadCancel').length, 1);

    const nade = createArsenal({});
    nade.select(4);
    run(nade, 1);
    nade.update(DT, { fireDown: true });
    assert.equal(nade.getWeapon().state, 'prime');
    nade.setAllowedSlots([1, 3]);
    assert.equal(only(nade.update(0, {}), 'primeCancel').length, 1);
    assert.equal(nade.getWeapon().id, 'ar_std');
  });

  test('resetRound는 허용된 첫 슬롯의 무기를 든다', () => {
    const a = createArsenal({ primary: 'ar_std', allowedSlots: [3] });
    a.resetRound({ primary: 'sr_bolt', melee: 'ml_knife', draw: true });
    const [sw] = only(a.update(0, {}), 'switch');
    assert.deepEqual([sw.to, sw.slot, sw.reset, sw.drawTime], ['ml_knife', 3, true, WEAPONS.ml_knife.drawTime]);
    assert.equal(a.getWeapon().state, 'draw');
    assert.equal(a.getPrimary(), 'sr_bolt');
    a.setAllowedSlots([1, 2, 3, 4]);
    a.resetRound({ draw: false });
    const [sw2] = only(a.update(0, {}), 'switch');
    assert.deepEqual([sw2.to, sw2.slot, sw2.drawTime], ['sr_bolt', 1, 0]);
    assert.equal(a.getWeapon().state, 'idle');
  });

  test('수류탄을 던진 뒤 금지된 무기로 돌아가지 않는다', () => {
    const a = createArsenal({ primary: 'ar_std', melee: 'ml_knife', allowedSlots: [1, 3, 4] });
    a.select(3);
    run(a, 1);
    a.select(4);
    run(a, 1);
    a.update(DT, { fireDown: true });
    run(a, 0.3, { fireDown: true });
    assert.equal(only(run(a, 0.1, {}), 'throw').length, 1);
    const evs = run(a, 0.5, {});
    assert.equal(only(evs, 'switch')[0].to, 'ml_knife', '이전 무기로 돌아간다');
    assert.equal(a.getAmmo('gr_frag').mag, 0);
    assert.deepEqual(a.getHud(75).slots, ['ar_std', null, 'ml_knife', null]);
  });

  test('무작위 입력에도 금지된 무기를 들지 않고 상태 값이 깨지지 않는다', () => {
    const rulesets = [[1, 2, 3, 4], [3], [1, 3], [2, 3], [1, 4]];
    let seed = 12345;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    for (const allowedSlots of rulesets) {
      for (const primary of PRIMARY_IDS) {
        const a = createArsenal({ primary, secondary: 'pt_magnum', melee: 'ml_knife', allowedSlots, zoomMode: rnd() < 0.5 ? 'hold' : 'toggle', rng: rnd });
        const ids = new Set([primary, 'pt_magnum', 'ml_knife', 'gr_frag']);
        for (let i = 0; i < 1500; i++) {
          const input = {
            fireDown: rnd() < 0.4, zoomDown: rnd() < 0.3, zoomToggle: rnd() < 0.1, reloadPressed: rnd() < 0.02,
            slot: rnd() < 0.03 ? 1 + Math.floor(rnd() * 4) : null, wheel: rnd() < 0.02 ? (rnd() < 0.5 ? 1 : -1) : 0,
          };
          const evs = a.update(rnd() < 0.02 ? 0.25 : DT, input, { speed: rnd() * 6, onGround: rnd() > 0.1, crouch: rnd() < 0.1 });
          const w = a.getWeapon();
          assert.ok(allowedSlots.includes(w.slot), `${w.id} ${allowedSlots}`);
          for (const ev of evs) {
            assert.ok(ids.has(ev.weaponId), `${ev.type} ${ev.weaponId}`);
            if (ev.type === 'switch') assert.ok(allowedSlots.includes(WEAPONS[ev.to].slot), `switch ${ev.to}`);
            if (ev.type === 'fire') {
              assert.ok(ev.mag >= 0 && ev.mag < WEAPONS[ev.weaponId].mag);
              for (const p of ev.pellets) assert.ok(Number.isFinite(p.yaw) && Number.isFinite(p.pitch));
            }
          }
          const z = a.getZoom(75), v = a.getViewState(75), h = a.getHud(75), m = a.getMoveMul();
          assert.ok(z.level >= 0 && z.level <= z.levels);
          assert.ok(STATES.includes(a.serialize().s));
          for (const n of [z.progress, z.curMag, z.fov, z.targetFov, z.scopeAmount, v.zoom, v.curMag, h.spread, h.fov, m]) assert.ok(Number.isFinite(n));
          assert.ok(z.curMag >= 1 && z.curMag <= 9 + 1e-9);
        }
      }
    }
  });
});

/* ---------- 로드아웃 ---------- */
describe('로드아웃', () => {
  test('기본값과 잘못된 id', () => {
    const a = createArsenal();
    assert.deepEqual(a.getLoadout(), { primary: 'ar_std', secondary: 'pt_std', melee: 'ml_knife' });
    assert.equal(a.getWeapon().id, 'ar_std');
    assert.equal(a.getWeapon().previous, 'pt_std');
    const b = createArsenal({ primary: 'pt_std', secondary: 'ar_std', melee: 'gr_frag' });
    assert.deepEqual(b.getLoadout(), { primary: 'ar_std', secondary: 'pt_std', melee: 'ml_knife' });
    assert.ok(!('SLOT_DEFAULTS' in defs));
  });

  test('주무기는 PRIMARY_IDS 전부를 받는다', () => {
    for (const id of PRIMARY_IDS) {
      assert.equal(createArsenal({ primary: id }).getPrimary(), id);
      const a = createArsenal();
      assert.equal(a.setPrimary(id), true);
      assert.equal(a.getPrimary(), id);
      assert.equal(a.getWeapon().id, id);
      const b = createArsenal();
      b.resetRound({ primary: id, draw: false });
      assert.equal(b.getWeapon().id, id);
    }
    assert.equal(createArsenal().setPrimary('pt_std'), false);
    assert.equal(createArsenal().setPrimary('nope'), false);
  });

  test('슬롯 번호가 로드아웃의 무기를 고른다', () => {
    const a = createArsenal({ primary: 'dm_mark', secondary: 'pt_magnum', melee: 'ml_knife' });
    const expect = [[2, 'pt_magnum'], [3, 'ml_knife'], [4, 'gr_frag'], [1, 'dm_mark']];
    for (const [slot, id] of expect) {
      const [sw] = only(a.update(DT, { slot }), 'switch');
      assert.deepEqual([sw.to, sw.slot, sw.drawTime], [id, slot, WEAPONS[id].drawTime]);
      assert.equal(a.getWeapon().id, id);
      run(a, 1.2);
    }
    assert.deepEqual(a.getHud(75).slots, ['dm_mark', 'pt_magnum', 'ml_knife', 'gr_frag']);
    assert.deepEqual(a.getSlots().map((s) => s.id), ['dm_mark', 'pt_magnum', 'ml_knife', 'gr_frag']);
    assert.equal(a.select('pt_std'), false, '로드아웃에 없는 무기');
    assert.equal(a.select('ml_katana'), false);
    assert.equal(a.select('pt_magnum'), true);
  });

  test('휠은 로드아웃 순서로 돈다', () => {
    const a = createArsenal({ primary: 'sm_vx3', secondary: 'pt_magnum', melee: 'ml_knife' });
    const seen = [];
    for (let i = 0; i < 4; i++) {
      seen.push(only(a.update(DT, { wheel: 1 }), 'switch')[0].to);
      run(a, 1);
    }
    assert.deepEqual(seen, ['pt_magnum', 'ml_knife', 'gr_frag', 'sm_vx3']);
  });

  test('setLoadout: 없는 키는 유지하고 잘못된 값은 무시한다', () => {
    const a = createArsenal({ primary: 'ar_std', secondary: 'pt_std', melee: 'ml_knife' });
    assert.deepEqual(a.setLoadout({ secondary: 'pt_magnum' }), { primary: 'ar_std', secondary: 'pt_magnum', melee: 'ml_knife' });
    assert.deepEqual(a.setLoadout({ melee: 'ml_katana', primary: 'nope' }), { primary: 'ar_std', secondary: 'pt_magnum', melee: 'ml_katana' });
    assert.deepEqual(a.setLoadout({}), { primary: 'ar_std', secondary: 'pt_magnum', melee: 'ml_katana' });
    assert.deepEqual(a.setLoadout(null), { primary: 'ar_std', secondary: 'pt_magnum', melee: 'ml_katana' });
    assert.deepEqual(a.setLoadout({ primary: 'pt_std', secondary: 'ml_knife', melee: 'ar_std' }), { primary: 'ar_std', secondary: 'pt_magnum', melee: 'ml_katana' });
  });

  test('setLoadout: 들고 있지 않은 슬롯을 바꾸면 이벤트 없이 탄약을 채워 둔다', () => {
    const a = createArsenal({ primary: 'ar_std', secondary: 'pt_std' });
    a.setLoadout({ secondary: 'pt_magnum' });
    assert.equal(only(a.update(DT, {}), 'switch').length, 0);
    assert.equal(a.getWeapon().id, 'ar_std');
    assert.equal(a.getWeapon().previous, 'pt_magnum');
    assert.equal(a.getAmmo('pt_magnum').mag, 6);
    assert.equal(only(a.update(DT, { slot: 2 }), 'switch')[0].to, 'pt_magnum');
  });

  test('setLoadout: 들고 있는 주무기를 바꾸면 새 무기를 꺼낸다', () => {
    const a = createArsenal({ primary: 'ar_std', rng: () => 0 });
    run(a, 0.3, { zoomDown: true, fireDown: true });
    assert.ok(a.getAmmo('ar_std').mag < 30);
    a.setLoadout({ primary: 'sr_heavy' });
    const evs = a.update(0, {});
    const sw = only(evs, 'switch')[0];
    assert.deepEqual([sw.from, sw.to, sw.slot, sw.drawTime], ['ar_std', 'sr_heavy', 1, WEAPONS.sr_heavy.drawTime]);
    assert.deepEqual(only(evs, 'zoomChange').map((e) => e.zoomed), [false]);
    assert.equal(a.getZoom(75).fov, 75);
    assert.equal(a.getAmmo().mag, 4);
    assert.equal(a.getWeapon().state, 'draw');
  });

  test('뺐다가 다시 넣은 무기는 탄약을 채워 받고, 같은 무기를 다시 넣으면 그대로다', () => {
    const a = createArsenal({ primary: 'ar_std', rng: () => 0 });
    run(a, 0.3, { fireDown: true });
    const used = a.getAmmo('ar_std').mag;
    assert.ok(used < 30);
    assert.equal(a.setPrimary('ar_std'), true);
    a.setLoadout({ primary: 'ar_std' });
    assert.equal(only(a.update(DT, {}), 'switch').length, 0, '같은 무기면 다시 꺼내지 않는다');
    assert.equal(a.getAmmo('ar_std').mag, used, '같은 무기면 탄약도 그대로다');
    a.setLoadout({ primary: 'sr_bolt' });
    a.setLoadout({ primary: 'ar_std' });
    assert.equal(a.getAmmo('ar_std').mag, 30);
    assert.equal(a.getAmmo('ar_std').reserve, 60);
  });

  test('들고 있는 칼을 바꾸면 깨끗하게 다시 꺼낸다', () => {
    const a = createArsenal({ melee: 'ml_knife' });
    a.select(3);
    run(a, 1);
    assert.equal(a.getWeapon().id, 'ml_knife');
    a.update(DT, { fireDown: true });
    assert.equal(a.getWeapon().state, 'swing');

    a.setLoadout({ melee: 'ml_katana' });
    const evs = a.update(0, {});
    assert.deepEqual(only(evs, 'swingCancel').map((e) => [e.weaponId, e.kind]), [['ml_knife', 'slash']]);
    const sw = only(evs, 'switch')[0];
    assert.deepEqual([sw.from, sw.to, sw.slot, sw.drawTime], ['ml_knife', 'ml_katana', 3, 0.55]);
    assert.equal(a.getWeapon().id, 'ml_katana');
    assert.equal(a.getWeapon().state, 'draw');
    assert.equal(a.getWeapon().duration, 0.55);
    assert.equal(a.getViewState().weaponId, 'ml_katana');
    assert.equal(a.getViewState().swingKind, null);

    const during = run(a, 0.5, {});
    assert.equal(only(during, 'melee').length, 0, '취소한 칼질의 판정이 나오지 않는다');
    assert.equal(a.getWeapon().state, 'draw');
    run(a, 0.1, {});
    assert.equal(a.getWeapon().state, 'idle');

    const slash = run(a, 0.2, { fireDown: true });
    const [s] = only(slash, 'swing');
    const [m] = only(slash, 'melee');
    assert.deepEqual([s.weaponId, s.kind, s.damage, s.range, s.duration], ['ml_katana', 'slash', 65, 2.7, 0.62]);
    assert.deepEqual([m.weaponId, m.kind, m.damage, m.range], ['ml_katana', 'slash', 65, 2.7]);
    near(m.arc, 48 * DEG);
  });

  test('칼 판정이 이미 나온 뒤에 바꾸면 취소 이벤트가 없다', () => {
    const a = createArsenal({ melee: 'ml_knife' });
    a.select(3);
    run(a, 1);
    const evs = run(a, 0.1, { fireDown: true });
    assert.equal(only(evs, 'melee').length, 1);
    a.setLoadout({ melee: 'ml_katana' });
    assert.equal(only(a.update(0, {}), 'swingCancel').length, 0);
  });

  for (const [id, heavy] of [['ml_knife', [100, 1.8, 12]], ['ml_katana', [120, 2.9, 14]]]) {
    test(`${id}: swing·melee 이벤트가 표의 값과 실제 id를 싣는다`, () => {
      const a = createArsenal({ melee: id, allowedSlots: [3] });
      const evs = run(a, 0.5, { zoomDown: true });
      const [s] = only(evs, 'swing');
      const [m] = only(evs, 'melee');
      assert.deepEqual([s.weaponId, s.kind], [id, 'stab']);
      assert.deepEqual([m.weaponId, m.kind, m.damage, m.range], [id, 'stab', heavy[0], heavy[1]]);
      near(m.arc, heavy[2] * DEG);
      near(m.t - s.t, WEAPONS[id].melee.stab.windup, DT);
    });
  }

  test('resetRound: 세 슬롯을 함께 바꾸고 탄약을 채운다', () => {
    const a = createArsenal({ primary: 'ar_std' });
    run(a, 0.3, { fireDown: true });
    a.resetRound({ primary: 'sg_bx12', secondary: 'pt_magnum', melee: 'ml_knife', draw: true });
    assert.deepEqual(a.getLoadout(), { primary: 'sg_bx12', secondary: 'pt_magnum', melee: 'ml_knife' });
    const sw = only(a.update(0, {}), 'switch');
    assert.equal(sw.length, 1, '이벤트는 한 번만');
    assert.deepEqual([sw[0].to, sw[0].slot, sw[0].reset], ['sg_bx12', 1, true]);
    assert.equal(a.getAmmo().mag, 6);
    assert.equal(a.getAmmo('pt_magnum').mag, 6);
    assert.equal(a.getAmmo('gr_frag').mag, 1);
    assert.deepEqual(a.getRecoilKick(), { yaw: 0, pitch: 0 });
    a.resetRound({ primary: 'nope', draw: false });
    assert.equal(a.getPrimary(), 'sg_bx12');
  });

  test('수류탄: 던지고 돌아오고 giveGrenade로 다시 채운다', () => {
    const a = createArsenal({ primary: 'ar_std' });
    assert.equal(a.getAmmo('gr_frag').mag, 1);
    a.select(4);
    run(a, 1);
    a.update(DT, { fireDown: true });
    run(a, 0.3, { fireDown: true });
    const thrown = only(run(a, 0.1, {}), 'throw');
    assert.equal(thrown.length, 1);
    assert.equal(thrown[0].weaponId, 'gr_frag');
    assert.equal(a.getAmmo('gr_frag').mag, 0);
    const back = only(run(a, 0.5, {}), 'switch');
    assert.equal(back[0].to, 'ar_std');
    assert.equal(a.getHud(75).slots[3], null);
    assert.equal(a.getSlots()[3].empty, true);
    assert.equal(a.select(4), false);
    assert.equal(a.giveGrenade(1), 1);
    assert.equal(a.giveGrenade(5), 1, '최대치를 넘지 않는다');
    assert.equal(a.getHud(75).slots[3], 'gr_frag');
    assert.equal(a.giveGrenade(-5), 0);
  });

  test('기존 메서드가 모두 남아 있다', () => {
    const a = createArsenal();
    for (const m of ['update', 'getZoom', 'getSpread', 'getRecoilKick', 'getAmmo', 'getWeapon', 'getSlots', 'getMoveMul', 'getViewState',
      'getHud', 'serialize', 'select', 'setPrimary', 'getPrimary', 'setZoomMode', 'getZoomMode', 'resetRound', 'giveGrenade', 'getTime', 'dispose',
      'setLoadout', 'setAllowedSlots', 'getLoadout', 'getAllowedSlots', 'carries', 'validateHit']) {
      assert.equal(typeof a[m], 'function', m);
    }
    assert.deepEqual(a.serialize(), { w: 'ar_std', s: 'idle', z: 0 });
  });
});

/* ---------- 사격 ---------- */
describe('사격', () => {
  test('샷건 fire 이벤트에 펠릿 8개가 실린다', () => {
    let n = 0;
    const seq = [0.9, 0.1, 0.5, 0.7, 0.2, 0.35, 0.8, 0.95];
    const a = createArsenal({ primary: 'sg_bx12', rng: () => seq[n++ % seq.length] });
    const [ev] = only(click(a), 'fire');
    assert.equal(ev.weaponId, 'sg_bx12');
    assert.equal(ev.pellets.length, 8);
    assert.equal(a.getAmmo().mag, 5, '펠릿 수와 상관없이 한 발이다');
    const limit = WEAPONS.sg_bx12.spread.hip * DEG + 1e-9;
    for (let i = 0; i < 8; i++) {
      const p = ev.pellets[i];
      assert.ok(Math.hypot(p.yaw, p.pitch) <= limit, `펠릿 ${i}`);
      near(Math.hypot(p.dir.x, p.dir.y, p.dir.z), 1);
      const d = shotDirection(0, 0, ev, i);
      near(Math.hypot(d.x, d.y, d.z), 1);
    }
    const dirs = new Set(ev.pellets.map((p) => `${p.yaw.toFixed(6)},${p.pitch.toFixed(6)}`));
    assert.ok(dirs.size > 1, '펠릿이 서로 다른 방향으로 간다');
    assert.deepEqual([ev.yaw, ev.pitch], [ev.pellets[0].yaw, ev.pellets[0].pitch]);
  });

  test('샷건은 반자동이고 0.85초를 기다린다', () => {
    const a = createArsenal({ primary: 'sg_bx12', rng: () => 0 });
    const evs = run(a, 1, { fireDown: true });
    assert.equal(only(evs, 'fire').length, 1, '누르고 있어도 한 발');
    click(a);
    const b = createArsenal({ primary: 'sg_bx12', rng: () => 0 });
    click(b);
    run(b, 0.3);
    assert.equal(only(click(b), 'fire').length, 0);
    run(b, 0.6);
    assert.equal(only(click(b), 'fire').length, 1);
  });

  for (const id of GUN_IDS) {
    test(`${id}: 탄창을 다 쏘고 자동 재장전하며 실제 사격 간격이 검증을 통과한다`, () => {
      const d = WEAPONS[id];
      const opts = d.slot === 1 ? { primary: id } : { secondary: id };
      const a = createArsenal({ ...opts, rng: () => 0 });
      if (d.slot !== 1) { a.select(d.slot); run(a, 1); }
      assert.equal(a.getWeapon().id, id);
      const shots = [];
      let reloaded = false;
      // 연사는 누른 채로(가장 촘촘한 간격), 나머지는 틱마다 연타. 탄이 떨어지면 손을 떼고 자동 재장전을 기다린다.
      for (let i = 0; i < 60 * 60 && !reloaded; i++) {
        const fireDown = a.getAmmo().mag > 0 && (d.fire === 'auto' || i % 2 === 0);
        for (const ev of a.update(DT, { fireDown })) {
          if (ev.type === 'fire') {
            shots.push(ev);
            assert.equal(ev.weaponId, id);
            assert.equal(ev.pellets.length, d.pellets);
            assert.equal(ev.maxRange, d.maxRange);
            assert.equal(ev.slot, d.slot);
            assert.equal(ev.mag, d.mag - shots.length);
          }
          if (ev.type === 'reloadEnd') reloaded = true;
        }
      }
      assert.equal(shots.length, d.mag);
      assert.ok(reloaded);
      assert.equal(a.getAmmo().mag, d.mag);
      assert.equal(a.getAmmo().reserve, d.reserve - d.mag);
      for (let i = 0; i + 1 < shots.length; i++) {
        const interval = shots[i + 1].t - shots[i].t;
        assert.ok(validateHit(id, { dist: 0, interval }).ok, `${i}번째 간격 ${interval}`);
        assert.ok(interval >= minShotInterval(id) - DT, `${i}번째 간격 ${interval}`);
      }
    });
  }

  test('연사 속도가 표와 같다(프레임 속도와 무관)', () => {
    for (const id of ['ar_std', 'ar_rapid', 'ar_line', 'sm_vx3']) {
      for (const dt of [1 / 60, 1 / 144, 1 / 30]) {
        const a = createArsenal({ primary: id, rng: () => 0 });
        const def = WEAPONS[id];
        const seconds = (def.mag - 2) * def.fireInterval;
        let shots = 0;
        const ticks = Math.round(seconds / dt);
        for (let i = 0; i < ticks; i++) shots += only(a.update(dt, { fireDown: true }), 'fire').length;
        const expected = seconds / def.fireInterval;
        assert.ok(Math.abs(shots - expected) <= 2, `${id} dt=${dt}: ${shots} vs ${expected}`);
      }
    }
  });

  test('탄퍼짐과 반동은 새 로드아웃 무기에서도 회복된다', () => {
    const a = createArsenal({ secondary: 'pt_magnum', rng: () => 0 });
    a.select(2);
    run(a, 1);
    const base = a.getSpread().deg;
    click(a);
    assert.ok(a.getSpread().deg > base);
    assert.ok(a.getRecoilKick().pitch > 0);
    run(a, 3);
    near(a.getSpread().deg, base);
    near(a.getRecoilKick().pitch, 0, 1e-4);
  });

  test('이동 배율은 표와 같다', () => {
    for (const [id, t] of Object.entries(TABLE)) {
      const a = createArsenal(WEAPONS[id].slot === 1 ? { primary: id } : { secondary: id, allowedSlots: [2] });
      near(a.getMoveMul(), t.move);
    }
    for (const [id, t] of Object.entries(MELEE_TABLE)) near(createArsenal({ melee: id, allowedSlots: [3] }).getMoveMul(), t.move);
  });
});

/* ---------- modes.js ---------- */
describe('규칙(modes.js)', () => {
  test('클래식은 모든 무기를 허용한다', () => {
    for (const id of ALL_IDS) assert.equal(isWeaponAllowed('classic', id), true, id);
    assert.deepEqual(pickableWeapons('classic'), [...PRIMARY_IDS]);
    assert.equal(defaultPick('classic'), 'ar_std');
  });

  test('칼전은 칼만 허용한다', () => {
    for (const id of ALL_IDS) assert.equal(isWeaponAllowed('knife', id), MELEE_IDS.includes(id), id);
    assert.deepEqual(pickableWeapons('knife'), [...MELEE_IDS]);
    assert.equal(defaultPick('knife'), 'ml_knife');
  });

  test('스나전은 저격총과 칼만 허용한다', () => {
    for (const id of ALL_IDS) {
      assert.equal(isWeaponAllowed('sniper', id), SNIPER_IDS.includes(id) || MELEE_IDS.includes(id), id);
    }
    assert.deepEqual([...pickableWeapons('sniper')].sort(), [...SNIPER_IDS].sort());
    assert.equal(defaultPick('sniper'), 'sr_bolt');
  });

  test('모르는 무기는 거부하고 모르는 규칙은 클래식으로 본다', () => {
    for (const r of RULESET_IDS) assert.equal(isWeaponAllowed(r, 'nope'), false, r);
    assert.equal(normalizeRuleset('없는 규칙'), 'classic');
    assert.equal(rulesetOf('없는 규칙').id, 'classic');
    assert.equal(isWeaponAllowed('없는 규칙', 'ar_std'), true);
    assert.deepEqual(pickableWeapons('없는 규칙'), [...PRIMARY_IDS]);
  });

  test('owned를 주면 가진 것만 남긴다', () => {
    assert.deepEqual(pickableWeapons('classic', ['ar_std', 'sr_bolt', 'ml_knife', 'pt_std']), ['ar_std', 'sr_bolt']);
    assert.deepEqual(pickableWeapons('classic', new Set(['sg_bx12'])), ['sg_bx12']);
    assert.deepEqual(pickableWeapons('knife', ['ml_knife', 'ar_std']), ['ml_knife']);
    assert.deepEqual(pickableWeapons('knife', new Set(['ml_katana'])), ['ml_katana']);
    assert.deepEqual(pickableWeapons('sniper', ['sr_twin', 'ar_std', 'sr_heavy']), ['sr_twin', 'sr_heavy']);
  });

  test('가진 무기가 하나도 없으면 규칙의 기본 무기 하나가 남는다', () => {
    assert.deepEqual(pickableWeapons('classic', []), ['ar_std']);
    assert.deepEqual(pickableWeapons('knife', []), ['ml_knife']);
    assert.deepEqual(pickableWeapons('sniper', []), ['sr_bolt']);
    assert.deepEqual(pickableWeapons('knife', ['ar_std']), ['ml_knife']);
    assert.deepEqual(pickableWeapons('sniper', new Set(['ar_std', 'dm_mark'])), ['sr_bolt']);
  });

  test('기본 무기는 공짜이고 규칙의 슬롯과 맞물린다', () => {
    for (const r of RULESET_IDS) {
      const pick = defaultPick(r);
      const rs = rulesetOf(r);
      assert.equal(WEAPONS[pick].price, 0, pick);
      assert.equal(WEAPONS[pick].slot, rs.pickSlot, pick);
      assert.ok(isWeaponAllowed(r, pick), pick);
      assert.ok(pickableWeapons(r).includes(pick), pick);
    }
  });

  test('규칙의 슬롯을 그대로 넘기면 Arsenal이 그 규칙의 무기만 든다', () => {
    for (const r of RULESET_IDS) {
      const rs = rulesetOf(r);
      for (const pick of pickableWeapons(r)) {
        const loadout = rs.pickSlot === 3 ? { melee: pick } : { primary: pick };
        const a = createArsenal({ ...loadout, allowedSlots: rs.slots });
        assert.equal(a.getWeapon().id, pick, `${r} ${pick}`);
        for (const slot of a.getHud(75).slots) if (slot) assert.ok(isWeaponAllowed(r, slot), `${r} ${slot}`);
        assert.ok(isWeaponAllowed(r, a.getWeapon().id));
      }
    }
  });

  test('개인전 목표 킬: 5~20 정수로 읽고, 범위 밖은 가까운 끝, 숫자가 아니면 null(normalize는 기본 20)', () => {
    assert.deepEqual({ ...FFA_KILLS }, { min: 5, max: 20, def: 20 });
    for (const v of FFA_KILL_PRESETS) assert.equal(parseKillTarget(v), v, `빠른 선택 ${v}은 범위 안`);
    const cases = [[5, 5], [12, 12], ['7', 7], [' 9 ', 9], [12.4, 12], [12.6, 13], [4, 5], [-3, 5], [0, 5], [21, 20], [99, 20], ['100', 20]];
    for (const [v, want] of cases) assert.equal(parseKillTarget(v), want, JSON.stringify(v));
    for (const v of [undefined, null, '', '  ', 'abc', '5킬', NaN, Infinity, true, false, {}, [], [7]]) {
      assert.equal(parseKillTarget(v), null, String(v));
      assert.equal(normalizeKillTarget(v), FFA_KILLS.def, String(v));
    }
    assert.equal(normalizeKillTarget(3), 5);
    assert.equal(normalizeKillTarget('15'), 15);
  });
});

/* ---------- 방장 검증 ---------- */
describe('validateHit', () => {
  for (const id of GUN_IDS) {
    test(`${id}: 사거리와 연사`, () => {
      const d = WEAPONS[id];
      const min = minShotInterval(id);
      assert.deepEqual(validateHit(id, { dist: d.maxRange, interval: min }), { ok: true });
      assert.deepEqual(validateHit(id, { dist: 1 }), { ok: true }, '간격을 모르면 통과');
      assert.deepEqual(validateHit(id, {}), { ok: true });
      assert.deepEqual(validateHit(id), { ok: true });
      assert.deepEqual(validateHit(id, { dist: d.maxRange + 0.01 }), { ok: false, reason: 'range' });
      assert.deepEqual(validateHit(id, { interval: min * 0.61 }), { ok: true }, '기본 허용 비율 0.6');
      assert.deepEqual(validateHit(id, { interval: min * 0.59 }), { ok: false, reason: 'rate' });
      assert.deepEqual(validateHit(id, { interval: 0 }), { ok: false, reason: 'rate' });
    });
  }

  test('점사는 재사격 대기가 아니라 점사 안 간격을 기준으로 한다', () => {
    const gap = WEAPONS.ar_burst.burst.gap;
    assert.ok(gap < WEAPONS.ar_burst.fireInterval);
    assert.deepEqual(validateHit('ar_burst', { interval: gap }), { ok: true });
    assert.deepEqual(validateHit('ar_burst', { interval: gap * 0.7 }), { ok: true });
    assert.deepEqual(validateHit('ar_burst', { interval: gap * 0.5 }), { ok: false, reason: 'rate' });
    assert.deepEqual(validateHit('ar_burst', { interval: gap, tolerance: 1 }), { ok: true });
  });

  test('tolerance를 바꿀 수 있다', () => {
    assert.deepEqual(validateHit('ar_std', { interval: 0.09, tolerance: 1 }), { ok: false, reason: 'rate' });
    assert.deepEqual(validateHit('ar_std', { interval: 0.1, tolerance: 1 }), { ok: true });
  });

  for (const id of MELEE_IDS) {
    test(`${id}: 칼 사거리 + 여유 1.2 m, 빠른 쪽 쿨다운`, () => {
      const m = WEAPONS[id].melee;
      for (const kind of ['slash', 'stab']) {
        assert.deepEqual(validateHit(id, { kind, dist: m[kind].range + 1.2 }), { ok: true }, kind);
        assert.deepEqual(validateHit(id, { kind, dist: m[kind].range + 1.3 }), { ok: false, reason: 'range' }, kind);
      }
      const min = Math.min(m.slash.cooldown, m.stab.cooldown);
      assert.deepEqual(validateHit(id, { kind: 'slash', interval: min }), { ok: true });
      assert.deepEqual(validateHit(id, { kind: 'stab', interval: min }), { ok: true });
      assert.deepEqual(validateHit(id, { kind: 'slash', interval: min * 0.5 }), { ok: false, reason: 'rate' });
    });
  }

  test('칼의 실제 공격 간격이 검증을 통과한다', () => {
    for (const id of MELEE_IDS) {
      const a = createArsenal({ melee: id, allowedSlots: [3] });
      const hits = only(run(a, 5, { fireDown: true }), 'melee');
      assert.ok(hits.length >= 5, id);
      for (let i = 0; i + 1 < hits.length; i++) {
        assert.ok(validateHit(id, { kind: hits[i + 1].kind, dist: hits[i + 1].range, interval: hits[i + 1].t - hits[i].t }).ok, id);
      }
    }
  });

  test('수류탄은 폭발 반경 + 0.5 m까지이고 간격을 보지 않는다', () => {
    assert.deepEqual(validateHit('gr_frag', { dist: 6.5, interval: 0 }), { ok: true });
    assert.deepEqual(validateHit('gr_frag', { dist: 6.6 }), { ok: false, reason: 'range' });
  });

  test('모르는 무기', () => {
    assert.deepEqual(validateHit('nope', {}), { ok: false, reason: 'weapon' });
    assert.deepEqual(validateHit(undefined), { ok: false, reason: 'weapon' });
  });

  test('arsenal.validateHit은 현재 로드아웃과 허용 슬롯 기준이다', () => {
    const a = createArsenal({ primary: 'ar_burst', secondary: 'pt_magnum', melee: 'ml_knife', allowedSlots: [1, 3] });
    assert.deepEqual(a.validateHit('ar_burst', { interval: 0.065 }), { ok: true });
    assert.deepEqual(a.validateHit('ml_knife', { kind: 'stab', dist: 1 }), { ok: true });
    assert.deepEqual(a.validateHit('ar_std', {}), { ok: false, reason: 'weapon' }, '로드아웃에 없음');
    assert.deepEqual(a.validateHit('ml_katana', {}), { ok: false, reason: 'weapon' });
    assert.deepEqual(a.validateHit('pt_magnum', {}), { ok: false, reason: 'weapon' }, '금지된 슬롯');
    assert.deepEqual(a.validateHit('gr_frag', {}), { ok: false, reason: 'weapon' });
    assert.deepEqual(a.validateHit('ar_burst', { dist: 9999 }), { ok: false, reason: 'range' });
    assert.equal(a.carries('ar_burst'), true);
    assert.equal(a.carries('pt_magnum'), false);
    a.setLoadout({ primary: 'ar_std' });
    assert.deepEqual(a.validateHit('ar_std', {}), { ok: true });
    assert.deepEqual(a.validateHit('ar_burst', {}), { ok: false, reason: 'weapon' });
  });
});
