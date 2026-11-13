/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 좀비 물량 막기의 보스 10종. 3스테이지마다 무작위로 나오고(50스테이지가 넘으면 2마리, 100스테이지가 넘으면 3마리) 저마다 스킬 2~3개를 쓴다.
 *          스킬은 몇 가지 기본 동작(돌진·내려찍기·충격파·도약·순간이동·소환·투사체·장판·비명·방어·치유·연쇄 번개)을 값으로 조합한다.
 *          동작 구현은 director.js, 그림은 view.js. 이름·생김새는 이 게임에서 직접 지었다.
 */

/**
 * 스킬 기본 동작 번호(스냅샷에 싣는 값)와 화면 이름. windup = 예고(바닥 표시·몸짓) 시간, cd = 다시 쓰기까지(ms).
 */
export const SKILL_KINDS = Object.freeze({
  charge: 1,   // 예고 뒤 직선으로 돌진. 부딪히면 피해 + 밀려남
  slam: 2,     // 제자리에서 내려찍기. 반경 안 피해
  nova: 3,     // 퍼져 나가는 고리. 고리가 지나갈 때 땅에 있으면 맞는다(점프로 피한다)
  leap: 4,     // 사람 자리로 뛰어올라 떨어진다. 떨어지는 자리를 미리 보여 준다
  blink: 5,    // 사람 뒤로 순간이동
  summon: 6,   // 좀비를 불러낸다
  volley: 7,   // 투사체 여러 발(산·통·가시). 떨어진 자리에 장판을 남길 수 있다
  pool: 8,     // 사람 발밑에 장판(피해·느려짐)
  scream: 9,   // 비명: 사람은 느려지고 좀비는 빨라진다
  armor: 10,   // 잠시 받는 피해를 줄인다
  heal: 11,    // 둘레 좀비와 자신을 치유
  chain: 12    // 사람 사이를 튀는 연쇄 번개
});
export const SKILL_NAMES = Object.freeze({
  charge: '돌진', slam: '내려찍기', nova: '충격파', leap: '도약', blink: '순간이동', summon: '소환',
  volley: '투척', pool: '장판', scream: '비명', armor: '강철 피부', heal: '치유', chain: '연쇄 번개'
});
const KIND_BY_CODE = new Map(Object.entries(SKILL_KINDS).map(([k, v]) => [v, k]));
export const skillKindOf = (code) => KIND_BY_CODE.get(code | 0) || null;

/** 장판 종류(스냅샷 번호) */
export const HAZARD_KINDS = Object.freeze({ acid: 1, fire: 2, web: 3, frost: 4, shock: 5 });
/** 투사체 종류(스냅샷 번호) */
export const PROJECTILE_KINDS = Object.freeze({ spit: 1, acid: 2, barrel: 3, web: 4, shard: 5 });

/**
 * hp = 5스테이지 기준 체력(bossHpMul을 곱한다. 첫 보스인 3스테이지는 약 0.85배), damage = 근접 피해(dmgMul을 곱한다), scale = 화면·히트박스 배율, radius = 충돌 반지름.
 * enrage = 체력이 at 아래로 내려가면 빨라지고 세지며 스킬을 더 자주 쓴다.
 */
const BOSS_TABLE = [
  {
    id: 'butcher', code: 1, name: '정육점 도살자', title: '쇠갈고리를 끄는 거구', icon: '🪓',
    color: 0x7a2e2a, accent: 0xff5a3c, hp: 3000, speed: 3.0, scale: 2.0, radius: 0.55, damage: 30, attackMs: 1300, windupMs: 450, range: 2.4,
    skills: [
      { kind: 'charge', cd: 7000, windup: 950, speed: 15, maxMs: 1200, dmg: 34, width: 1.6, knock: 10 },
      { kind: 'slam', cd: 9000, windup: 1000, radius: 5.5, dmg: 28, knock: 7 }
    ],
    enrage: { at: 0.4, speed: 1.25, dmg: 1.2, cd: 0.75 }
  },
  {
    id: 'plague', code: 2, name: '역병 여왕', title: '산성 주머니를 단 어미', icon: '🦠',
    color: 0x4f7a2a, accent: 0xa6ff3c, hp: 2600, speed: 2.4, scale: 1.9, radius: 0.5, damage: 22, attackMs: 1200, windupMs: 420, range: 2.1,
    skills: [
      { kind: 'volley', cd: 5000, windup: 700, count: 3, fan: 0.22, speed: 15, dmg: 14, proj: 'acid', arc: true, pool: { kind: 'acid', r: 2.4, ms: 4500, dps: 11 } },
      { kind: 'summon', cd: 12000, windup: 1200, type: 'runner', n: 4, radius: 3 }
    ],
    enrage: { at: 0.4, speed: 1.2, dmg: 1.15, cd: 0.7 }
  },
  {
    id: 'titan', code: 3, name: '철갑 거인', title: '철판을 두른 걸어 다니는 벽', icon: '🛡️',
    color: 0x5c6670, accent: 0x9fd8ff, hp: 4200, speed: 1.8, scale: 2.5, radius: 0.6, damage: 36, attackMs: 1600, windupMs: 600, range: 2.8,
    skills: [
      { kind: 'nova', cd: 8000, windup: 900, radius: 14, speed: 9, dmg: 24, width: 1.3 },
      { kind: 'armor', cd: 14000, windup: 400, ms: 4500, reduce: 0.7 },
      { kind: 'slam', cd: 10000, windup: 1100, radius: 6, dmg: 32, knock: 8 }
    ],
    enrage: { at: 0.35, speed: 1.3, dmg: 1.2, cd: 0.75 }
  },
  {
    id: 'stalker', code: 4, name: '그림자 추적자', title: '뒤에서 나타나는 사냥꾼', icon: '🌑',
    color: 0x2a2433, accent: 0xb36bff, hp: 2400, speed: 4.6, scale: 1.7, radius: 0.45, damage: 26, attackMs: 900, windupMs: 320, range: 2.0,
    skills: [
      { kind: 'blink', cd: 6000, windup: 500, behind: 2.6 },
      { kind: 'charge', cd: 8000, windup: 600, speed: 19, maxMs: 650, dmg: 28, width: 1.3, knock: 7 }
    ],
    enrage: { at: 0.4, speed: 1.2, dmg: 1.2, cd: 0.65 }
  },
  {
    id: 'bombard', code: 5, name: '폭발 군주', title: '화약통을 던지는 광부', icon: '🧨',
    color: 0x8a4b1c, accent: 0xffa53c, hp: 2800, speed: 2.2, scale: 2.1, radius: 0.55, damage: 26, attackMs: 1400, windupMs: 500, range: 2.3,
    skills: [
      { kind: 'volley', cd: 4500, windup: 800, count: 2, fan: 0.35, speed: 13, dmg: 0, proj: 'barrel', arc: true, blast: { r: 3.6, dmg: 30 }, pool: { kind: 'fire', r: 2.2, ms: 3000, dps: 10 } },
      { kind: 'summon', cd: 13000, windup: 1200, type: 'bomber', n: 3, radius: 3 }
    ],
    enrage: { at: 0.4, speed: 1.2, dmg: 1.2, cd: 0.7 }
  },
  {
    id: 'necro', code: 6, name: '시체 소환사', title: '쓰러진 것들을 다시 일으키는 자', icon: '💀',
    color: 0x3b4f4a, accent: 0x5cffd8, hp: 2500, speed: 2.0, scale: 1.9, radius: 0.5, damage: 22, attackMs: 1300, windupMs: 450, range: 2.1,
    skills: [
      { kind: 'summon', cd: 9000, windup: 1300, type: 'walker', n: 6, radius: 4 },
      { kind: 'heal', cd: 11000, windup: 1100, radius: 10, frac: 0.25, self: 0.08 }
    ],
    enrage: { at: 0.4, speed: 1.25, dmg: 1.15, cd: 0.7 }
  },
  {
    id: 'banshee', code: 7, name: '울음 귀신', title: '비명으로 무리를 몰아오는 망령', icon: '👻',
    color: 0x9fb4c8, accent: 0xdff4ff, hp: 2300, speed: 3.4, scale: 1.8, radius: 0.45, damage: 22, attackMs: 1000, windupMs: 380, range: 2.0,
    skills: [
      { kind: 'scream', cd: 9000, windup: 900, radius: 18, slow: 0.45, ms: 3000, haste: 0.35, hasteMs: 4000 },
      { kind: 'blink', cd: 7000, windup: 450, behind: 3 }
    ],
    enrage: { at: 0.4, speed: 1.2, dmg: 1.2, cd: 0.7 }
  },
  {
    id: 'brood', code: 8, name: '가시 거미 어미', title: '거미줄을 치고 뛰어드는 괴물', icon: '🕷️',
    color: 0x4a3a2a, accent: 0xff8a4c, hp: 2700, speed: 3.6, scale: 2.0, radius: 0.55, damage: 26, attackMs: 1100, windupMs: 400, range: 2.3,
    skills: [
      { kind: 'leap', cd: 7000, windup: 700, flightMs: 950, radius: 4.5, dmg: 32 },
      { kind: 'volley', cd: 8000, windup: 600, count: 3, fan: 0.4, speed: 14, dmg: 6, proj: 'web', arc: true, pool: { kind: 'web', r: 3, ms: 5000, dps: 0, slow: 0.5 } },
      { kind: 'summon', cd: 12000, windup: 1000, type: 'crawler', n: 5, radius: 3 }
    ],
    enrage: { at: 0.4, speed: 1.2, dmg: 1.2, cd: 0.7 }
  },
  {
    id: 'volt', code: 9, name: '번개 좀비', title: '전선을 삼킨 감전된 시체', icon: '⚡',
    color: 0x3a4a6a, accent: 0x6ff0ff, hp: 2600, speed: 2.8, scale: 1.9, radius: 0.5, damage: 24, attackMs: 1200, windupMs: 420, range: 2.1,
    skills: [
      { kind: 'chain', cd: 5000, windup: 700, range: 20, jumps: 3, dmg: 20 },
      { kind: 'nova', cd: 9000, windup: 800, radius: 13, speed: 11, dmg: 20, width: 1.2, shock: true }
    ],
    enrage: { at: 0.4, speed: 1.2, dmg: 1.2, cd: 0.7 }
  },
  {
    id: 'frost', code: 10, name: '서리 망령', title: '얼음 가시를 흩뿌리는 그림자', icon: '❄️',
    color: 0x4a6a8a, accent: 0xbfe8ff, hp: 2600, speed: 2.6, scale: 1.95, radius: 0.5, damage: 22, attackMs: 1200, windupMs: 420, range: 2.1,
    skills: [
      { kind: 'volley', cd: 4500, windup: 650, count: 5, fan: 0.18, speed: 22, dmg: 12, proj: 'shard', slow: { mul: 0.3, ms: 1500 } },
      { kind: 'pool', cd: 10000, windup: 900, hazard: { kind: 'frost', r: 4, ms: 5500, dps: 6, slow: 0.4 } }
    ],
    enrage: { at: 0.4, speed: 1.2, dmg: 1.2, cd: 0.7 }
  }
];

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const k of Object.keys(o)) deepFreeze(o[k]);
  }
  return o;
}

export const BOSSES = deepFreeze(BOSS_TABLE.map((b) => ({ ...b, skills: b.skills.map((s) => ({ ...s, code: SKILL_KINDS[s.kind] })) })));
export const BOSS_IDS = Object.freeze(BOSSES.map((b) => b.id));
const BY_CODE = new Map(BOSSES.map((b) => [b.code, b]));
const BY_ID = new Map(BOSSES.map((b) => [b.id, b]));
export const bossByCode = (code) => BY_CODE.get(code | 0) || null;
export const bossById = (id) => BY_ID.get(String(id)) || null;

/**
 * 이번 보스 스테이지의 보스 n마리. 같은 판에서 바로 앞 보스 스테이지와 겹치지 않게 고르고(10종을 고루 돌게),
 * 한 스테이지 안에서도 서로 다른 보스로 고른다(10종보다 많이 필요하면 겹친다).
 * rng = 0..1 난수, recent = 최근에 나온 보스 id들(앞쪽이 최근)
 */
export function pickBosses(n, rng, recent = []) {
  const out = [];
  const avoid = new Set(recent.slice(0, Math.min(recent.length, 10 - n)));
  for (let i = 0; i < n; i++) {
    let pool = BOSSES.filter((b) => !out.includes(b.id) && !avoid.has(b.id));
    if (!pool.length) pool = BOSSES.filter((b) => !out.includes(b.id));
    if (!pool.length) pool = BOSSES;
    out.push(pool[Math.floor(rng() * pool.length) % pool.length].id);
  }
  return out;
}
