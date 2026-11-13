/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 좀비 물량 막기 모드의 규칙 값(인원·시간·탄약 배율·경험치·보급품·수류탄 효과)과 일반 좀비 6종, 스테이지마다 늘어나는 수·체력·피해·속도 공식을 둔다.
 *          스테이지는 40초씩 시간으로 넘어가고(다 잡으면 남은 2초당 경험치 1을 받고 바로 넘어간다), 팀 경험치가 차면 레벨이 올라 증강을 고른다.
 *          three.js·DOM에 의존하지 않는 순수 모듈이라 방장 시뮬레이션(director.js)과 node 시험이 그대로 쓴다.
 */

/** 모드 id. 방 메타·연습장 설정·경기 스냅샷 gm에 같은 값을 쓴다 */
export const HORDE_MODE = 'zombie';

export const HORDE = Object.freeze({
  maxPlayers: 4,          // 최대 4인
  baseHp: 100,            // 시작 최대 체력(카드로 늘어난다)
  reserveMul: 3,          // 재장전 탄창(예비 탄약)은 기존 맵의 3배. 탄창은 스테이지 사이에 채워지지 않고 이어진다
  premiumReserveMags: 2,  // 예비가 무제한인 프리미엄 총도 이 모드에서는 탄창 2개 × 배율만큼만 든다
  prepMs: 12000,          // 첫 스테이지 시작 전 준비 시간(무기는 이때만 고른다)
  stageMs: 40000,         // 스테이지 하나의 시간. 지나면 다음 스테이지가 시작된다(남은 좀비는 그대로 남는다)
  timeXpMs: 2000,         // 시간 안에 다 잡으면 남은 시간 이만큼마다 경험치 1
  xpBase: 10,             // 1레벨 → 2레벨에 필요한 경험치
  xpStep: 10,             // 레벨마다 필요한 경험치가 이만큼 는다(10, 20, 30, …)
  bossXp: 20,             // 보스 처치 경험치(보물 상자는 따로 떨어진다)
  cardMs: 20000,          // 증강 고르기 제한 시간(지나면 제안 중 하나를 무작위로 받는다)
  pauseOnCards: false,    // true(혼자)면 고르는 동안 좀비·스테이지 시간이 멈춘다. 멀티는 멈추지 않고 고르는 사람만 무적이다
  pickInvulnMs: 3000,     // 증강을 고른 직후 무적 시간
  clearHealFrac: 0.25,    // 시간 안에 스테이지를 깨면 최대 체력의 25%를 회복한다
  reviveHpFrac: 0.5,      // 쓰러진 사람은 다음 스테이지에 최대 체력의 50%로 일어난다
  maxAlive: 34,           // 한 번에 맵에 있는 일반 좀비 상한(보스·소환 제외). 넘으면 죽는 만큼 이어서 나온다
  maxAliveBoss: 18,       // 보스 스테이지의 일반 좀비 상한
  bossEvery: 3,           // 3스테이지마다 보스(3, 6, 9, …)
  twoBossFrom: 50,        // 50스테이지가 넘으면 보스 2마리(처음은 51스테이지)
  threeBossFrom: 100,     // 100스테이지가 넘으면 3마리(처음은 102스테이지)
  simHz: 30,              // 좀비 이동·판단 고정 간격
  flowMs: 400,            // 흐름장(길찾기)을 다시 만드는 간격
  spawnSafeM: 16,         // 좀비가 나오는 자리는 살아 있는 사람에게서 이만큼 떨어져야 한다
  grabSlow: 0.72,         // 좀비 몸에 붙잡히면 이동 속도 배율(화면마다 자기 몸으로 잰다)
  grabRadius: 0.75,
  maxSummons: 16,         // 보스가 불러낸 좀비 상한
  maxProjectiles: 40,
  maxHazards: 16,
  gameOverMs: 6000,       // 전멸 뒤 결과 화면까지
  lootMs: 30000,          // 바닥의 보급품(탄창 등)이 사라지기까지(보물 상자는 chestMs)
  chestMs: 90000,         // 보스의 보물 상자가 사라지기까지
  maxLoot: 24,            // 한 번에 바닥에 있는 보급품 상한(넘으면 가장 오래된 것부터 치운다. 보물 상자는 치우지 않는다)
  lootPickM: 2.6,         // 방장이 받아 주는 줍기 거리(지연 여유 포함). 화면은 LOOT_TOUCH_M 안에 들어가면 줍는다
  lootTouchM: 1.15,       // 화면에서 줍는 거리(몸 중심과 보급품의 수평 거리)
  medChance: 0.05,        // 좀비가 구급 상자를 떨어뜨릴 확률(증강으로 오른다)
  medHeal: 10,            // 구급 상자 회복량(증강으로 오른다)
  magChance: 0.1,         // 좀비가 탄창(장전 1회분)을 떨어뜨릴 확률(증강으로 오른다)
  fireMs: 5000,           // 화염 수류탄 불길이 타는 시간
  fireR: 3,               // 불길 반지름(m, 폭발 반경 증강을 따라 넓어진다)
  fireDps: 22,            // 불길 초당 피해(스테이지 체력 배율의 제곱근만큼 세진다)
  freezeMs: 2200,         // 빙결 수류탄에 맞은 좀비가 얼어붙는 시간(보스는 절반)
  decoyMs: 9000,          // 어그로 수류탄 분신이 버티는 시간
  decoyPullM: 30,         // 분신이 이 거리 안의 좀비를 끌어모은다
  maxDecoys: 6,           // 한 번에 서 있는 분신 상한(한 사람은 2개)
  maxFields: 10           // 한 번에 타는 불길 상한
});

/**
 * 좀비가 쓰러지며 떨어뜨리는 보급품. 걸어서 닿으면 줍는다(방장이 확인한다).
 * mag = 탄창(든 총의 장전 1회분 예비 탄), med = 구급 상자(체력 HORDE.medHeal), chest = 보스의 보물 상자(주운 사람이 증강 하나를 고른다)
 * 코드 2·3은 예전 탄약 상자·수류탄 자리라 비워 둔다.
 */
export const LOOT_TYPES = Object.freeze({
  mag: Object.freeze({ id: 'mag', code: 1, name: '탄창', icon: '🧷', color: 0xd8b24a }),
  med: Object.freeze({ id: 'med', code: 4, name: '구급 상자', icon: '➕', color: 0xeeeeea }),
  chest: Object.freeze({ id: 'chest', code: 5, name: '보물 상자', icon: '🎁', color: 0xe0a428 })
});
const LOOT_BY_CODE = new Map(Object.values(LOOT_TYPES).map((l) => [l.code, l]));
export const lootByCode = (code) => LOOT_BY_CODE.get(code | 0) || null;

/**
 * 일반 좀비 한 마리가 떨어뜨릴 보급품(없으면 null). 한 번 굴려 구급 상자(medP) → 탄창(magP) 순서로 본다.
 * medP·magP를 생략하면 기본 확률(구급 상자 5%·탄창 10%). 증강으로 오른 확률을 넘긴다
 */
export function rollDrop(rng, medP = HORDE.medChance, magP = HORDE.magChance) {
  const r = rng();
  if (r < medP) return 'med';
  if (r < medP + magP) return 'mag';
  return null;
}

/** 좀비 종류별 경험치(강한 특수 좀비일수록 많다). 보스는 HORDE.bossXp, 보스가 불러낸 좀비는 1 */
export const ZOMBIE_XP = Object.freeze({ walker: 1, crawler: 1, runner: 2, spitter: 2, bomber: 2, brute: 4 });
export const zombieXp = (typeId) => ZOMBIE_XP[typeId] || 1;

/** 이 레벨에서 다음 레벨까지 필요한 경험치: 1레벨 10, 2레벨 20, 3레벨 30, … */
export function xpNeed(level, rules = HORDE) {
  return rules.xpBase + rules.xpStep * (Math.max(1, Math.floor(Number(level) || 1)) - 1);
}

/** 시간 안에 다 잡았을 때의 남은 시간 경험치(남은 2초당 1) */
export function timeBonusXp(leftMs, rules = HORDE) {
  return Math.max(0, Math.floor((Number(leftMs) || 0) / rules.timeXpMs));
}

/**
 * 일반 좀비. hp·damage는 1스테이지 값이고 hpMul·dmgMul을 곱한다.
 * speed(m/s), attackMs = 공격 간격, windupMs = 휘두르기 시작부터 맞는 순간까지, range = 공격이 닿는 거리(몸 중심끼리, m).
 * from = 처음 나오는 스테이지, weight = 그 뒤 섞이는 비율. scale은 화면 크기와 히트박스 크기의 배율이다.
 */
export const ZOMBIE_TYPES = Object.freeze({
  walker: Object.freeze({
    id: 'walker', code: 1, name: '워커', hp: 100, speed: 2.3, damage: 12, attackMs: 1100, windupMs: 380, range: 1.3,
    radius: 0.35, scale: 1, from: 1, weight: 10, color: 0x6f8f4e, cloth: 0x4d4a3e
  }),
  runner: Object.freeze({
    id: 'runner', code: 2, name: '러너', hp: 65, speed: 5.0, damage: 9, attackMs: 800, windupMs: 260, range: 1.2,
    radius: 0.33, scale: 0.92, from: 3, weight: 6, color: 0xa3b85c, cloth: 0x6b3a3a
  }),
  brute: Object.freeze({
    id: 'brute', code: 3, name: '브루트', hp: 420, speed: 1.9, damage: 26, attackMs: 1500, windupMs: 520, range: 1.7,
    radius: 0.45, scale: 1.35, from: 6, weight: 2, color: 0x5b6b3a, cloth: 0x3b4252
  }),
  spitter: Object.freeze({
    id: 'spitter', code: 4, name: '스피터', hp: 85, speed: 2.4, damage: 8, attackMs: 1200, windupMs: 400, range: 1.3,
    radius: 0.35, scale: 1, from: 8, weight: 2, color: 0x8fc23a, cloth: 0x2f5d50,
    ranged: Object.freeze({ every: 3200, speed: 15, dmg: 13, keep: 8, range: 24, windupMs: 500 })
  }),
  bomber: Object.freeze({
    id: 'bomber', code: 5, name: '폭발 좀비', hp: 70, speed: 4.1, damage: 0, attackMs: 1000, windupMs: 450, range: 1.5,
    radius: 0.38, scale: 1.08, from: 10, weight: 2, color: 0xc9a227, cloth: 0x7a3f12,
    explode: Object.freeze({ radius: 3.8, dmg: 34 })
  }),
  crawler: Object.freeze({
    id: 'crawler', code: 6, name: '크롤러', hp: 55, speed: 4.0, damage: 8, attackMs: 900, windupMs: 300, range: 1.15,
    radius: 0.33, scale: 0.9, from: 12, weight: 3, color: 0x7d6f5a, cloth: 0x3d3328, low: true
  })
});

export const ZOMBIE_IDS = Object.freeze(Object.keys(ZOMBIE_TYPES));
const BY_CODE = new Map(ZOMBIE_IDS.map((id) => [ZOMBIE_TYPES[id].code, ZOMBIE_TYPES[id]]));
export const zombieByCode = (code) => BY_CODE.get(code | 0) || null;
export const zombieType = (id) => (Object.prototype.hasOwnProperty.call(ZOMBIE_TYPES, id) ? ZOMBIE_TYPES[id] : null);

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const stageOf = (s) => Math.max(1, Math.floor(Number(s) || 1));

/** 이 스테이지의 일반 좀비 수(보스 스테이지는 이 값의 절반이 호위로 나온다) */
export function zombieCount(stage) {
  const s = stageOf(stage);
  return Math.min(150, Math.round(10 + 3.2 * s + 0.06 * s * s));
}

/** 체력 배율: 10스테이지 약 2.2배, 20스테이지 약 4.2배, 50스테이지 약 14배, 100스테이지 약 45배 */
export function hpMul(stage) {
  const k = stageOf(stage) - 1;
  return 1 + 0.1 * k + 0.0035 * k * k;
}

/** 피해 배율: 10스테이지 약 1.4배, 50스테이지 약 3.9배, 100스테이지 약 7.4배 */
export function dmgMul(stage) {
  const k = stageOf(stage) - 1;
  return 1 + 0.045 * k + 0.0003 * k * k;
}

/** 이동 속도 배율(최대 1.35) */
export function speedMul(stage) {
  return Math.min(1.35, 1 + 0.006 * (stageOf(stage) - 1));
}

/** 좀비가 하나씩 나오는 간격(ms) */
export function spawnGapMs(stage) {
  return Math.max(200, 1050 - 24 * stageOf(stage));
}

/** 한 번에 같이 나오는 좀비 수 */
export function spawnBurst(stage) {
  return clamp(1 + Math.floor(stageOf(stage) / 8), 1, 4);
}

/** 이 스테이지의 보스 수: 3스테이지마다, 50스테이지가 넘으면 2마리, 100스테이지가 넘으면 3마리 */
export function bossCount(stage, rules = HORDE) {
  const s = stageOf(stage);
  if (s % rules.bossEvery !== 0) return 0;
  return s >= rules.threeBossFrom ? 3 : s >= rules.twoBossFrom ? 2 : 1;
}

/** 보스 체력 배율: 3스테이지 약 0.85배, 5스테이지 1배, 25스테이지 약 3.1배, 50스테이지 약 7배, 100스테이지 약 19배 */
export function bossHpMul(stage) {
  const s = stageOf(stage);
  return 0.6 + 0.08 * s + 0.0012 * s * s;
}

/**
 * 이 스테이지에 나올 수 있는 좀비 종류와 비율. 새로 열린 종류는 처음 몇 스테이지 동안 비율을 조금 낮게 둔다.
 * → [{ type, weight }]
 */
export function zombieMix(stage) {
  const s = stageOf(stage);
  const out = [];
  for (const id of ZOMBIE_IDS) {
    const t = ZOMBIE_TYPES[id];
    if (s < t.from) continue;
    const ramp = Math.min(1, 0.4 + (s - t.from) * 0.15);
    // 워커는 뒤로 갈수록 덜 나온다(빠르고 단단한 종류가 늘어난다)
    const w = id === 'walker' ? Math.max(3, t.weight - (s - 1) * 0.12) : t.weight * ramp;
    out.push({ type: t, weight: w });
  }
  return out;
}

/** mulberry32: 같은 씨앗이면 모든 화면에서 같은 수열(카드 제안·스폰 순서 재현용) */
export function makeRng(seed) {
  let s = (Number(seed) >>> 0) || 1;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 문자열·숫자 여러 개 → 32비트 씨앗(FNV-1a) */
export function hashSeed(...parts) {
  let h = 0x811c9dc5;
  for (const p of parts) {
    const s = String(p);
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    h ^= 0x2c; h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** 가중치 목록에서 하나 고르기. items = [{ weight, ... }] */
export function pickWeighted(items, rng) {
  let sum = 0;
  for (const it of items) sum += Math.max(0, it.weight || 0);
  if (!(sum > 0)) return items[0] || null;
  let r = rng() * sum;
  for (const it of items) {
    r -= Math.max(0, it.weight || 0);
    if (r <= 0) return it;
  }
  return items[items.length - 1];
}

/**
 * 이 모드의 무기 탄약. 일반 총은 예비 × 3, 예비가 무제한인 프리미엄 총은 탄창 2개 × 3.
 * → { mag, reserve } (칼·수류탄은 null)
 */
export function hordeAmmo(def, rules = HORDE) {
  if (!def || def.mag == null) return null;
  const base = Number.isFinite(def.reserve) ? def.reserve : def.mag * rules.premiumReserveMags;
  return { mag: def.mag, reserve: Math.round(base * rules.reserveMul) };
}

/** 스테이지 시간 표시 mm:ss */
export function fmtClock(ms) {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}
