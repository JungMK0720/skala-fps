/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 좀비 물량 막기의 강화 카드(150장 넘게). 스테이지를 깨면 3장(카드로 4장까지)을 제안하고 제안마다 다시 뽑기 1번을 준다.
 *          카드 목록 → 능력치 계산(상한 포함), 제안 만들기, 짧은 글자로 싣기를 맡는다. 순수 모듈이라 방장·화면·node 시험이 같이 쓴다.
 */
import { makeRng, hashSeed, pickWeighted } from './rules.js';

/** 등급. weight = 제안에 나올 비율 */
export const TIERS = Object.freeze({
  common: Object.freeze({ id: 'common', name: '일반', color: '#c9d4e0', weight: 55 }),
  rare: Object.freeze({ id: 'rare', name: '희귀', color: '#4fb3ff', weight: 28 }),
  epic: Object.freeze({ id: 'epic', name: '영웅', color: '#c46bff', weight: 13 }),
  legend: Object.freeze({ id: 'legend', name: '전설', color: '#ffb02e', weight: 4 })
});
const TIER_OF_LEVEL = ['common', 'rare', 'epic', 'legend'];
const ROMAN = ['I', 'II', 'III', 'IV'];

/**
 * 능력치 기본값. 값은 모두 '더하는 양'이다(배율은 1 + 값). 방장(체력·피해 계산)과 내 화면(무기·이동)이 같은 표를 쓴다.
 * 어느 쪽이 쓰는지: H = 방장 판정, C = 내 화면(무기·이동), 둘 다면 HC.
 */
export const PERK_BASE = Object.freeze({
  maxHp: 0,        // H  최대 체력 +
  maxHpPct: 0,     // H  최대 체력 +%(음수 가능)
  regen: 0,        // H  초당 회복
  lifesteal: 0,    // H  준 피해의 비율만큼 회복
  armor: 0,        // H  받는 피해 감소
  killHeal: 0,     // H  처치마다 회복
  dmg: 0,          // H  모든 피해 +%
  head: 0,         // H  머리 피해 +%
  boss: 0,         // H  보스 피해 +%
  melee: 0,        // H  칼 피해 +%
  nade: 0,         // H  수류탄 피해 +%
  crit: 0,         // H  치명타 확률(피해 ×(1.5 + critDmg))
  critDmg: 0,      // H  치명타 피해 +
  slow: 0,         // H  맞은 좀비가 1.2초 동안 느려지는 비율
  thorns: 0,       // H  나를 때린 좀비가 받는 피해
  dodge: 0,        // H  피해를 통째로 피할 확률
  executioner: 0,  // H  체력 25% 아래 좀비에게 피해 +%
  lastStand: 0,    // H  내 체력이 35% 아래일 때 피해 +%
  stageHeal: 0,    // H  스테이지가 시작할 때 최대 체력의 이 비율만큼 회복
  shield: 0,       // H  스테이지가 시작할 때 받는 보호막(피해를 먼저 막는다)
  explosive: 0,    // H  처치한 좀비가 터져 3 m 안의 좀비에게 그 좀비 최대 체력의 이 비율만큼 피해
  secondChance: 0, // H  스테이지마다 한 번, 쓰러질 피해를 체력 30%로 버틴다
  rerolls: 0,      // H  제안마다 다시 뽑기 +
  offers: 0,       // H  제안 카드 수 +
  fireRate: 0,     // C  연사 속도 +%(볼트 시간도 같이 준다)
  reload: 0,       // C  재장전 속도 +%
  mag: 0,          // C  최대 탄창 +%
  reserve: 0,      // C  최대 재장전 탄창 + (기본 재장전 탄창의 배수)
  spread: 0,       // C  탄퍼짐 −%
  recoil: 0,       // C  반동 −%
  draw: 0,         // C  무기 꺼내기 속도 +%
  move: 0,         // C  이동 속도 +%
  maxSpeed: 0,     // C  최대 속도(가속 한계) +%
  jump: 0,         // C  점프 높이 +%
  nades: 0,        // C  최대 수류탄 +
  pierce: 0,       // C  탄이 좀비를 뚫고 뒤의 좀비까지 맞는 수(뚫을 때마다 피해 70%)
  killAmmo: 0,     // C  처치마다 탄창으로 돌아오는 탄
  ammoRegen: 0,    // C  초당 예비 탄 회복(탄창 크기의 비율)
  frenzy: 0,       // C  처치마다 4초 동안 연사 +%(최대 5번 겹침)
  thrift: 0        // C  쏴도 탄이 줄지 않을 확률
});

/** 능력치 상한(카드를 아무리 많이 골라도 이 이상은 오르지 않고, 다 찬 카드는 제안에서 빠진다) */
export const PERK_CAPS = Object.freeze({
  armor: 0.7, dodge: 0.4, crit: 0.6, slow: 0.5, lifesteal: 0.3, thrift: 0.45,
  fireRate: 2.5, reload: 3, mag: 4, reserve: 12, draw: 3,
  spread: 0.8, recoil: 0.8, move: 0.8, maxSpeed: 1.5, jump: 0.6,
  nades: 6, pierce: 6, killAmmo: 8, ammoRegen: 0.25, frenzy: 0.2,
  regen: 30, rerolls: 3, offers: 1, maxHpPct: 3, secondChance: 1
});

/* ------------------------------------------------------------------ 카드 표 */

/** 글자 도우미 */
const pc = (v) => `${Math.round(v * 100)}%`;
const fx = (v) => (Math.abs(v - Math.round(v)) < 1e-9 ? String(Math.round(v)) : String(+v.toFixed(2)));

/**
 * 같은 능력치를 네 단계로 올리는 카드 묶음. vals[i] = I~IV의 값, text(v) = 설명, extra(v) = 고른 순간 한 번만 일어나는 일.
 * family 하나에 카드 네 장이 생긴다(I 일반 · II 희귀 · III 영웅 · IV 전설).
 */
const FAMILIES = [
  { key: 'hp', name: '튼튼한 몸', icon: '❤️', stat: 'maxHp', vals: [15, 25, 40, 60], text: (v) => `최대 체력 +${v} (그만큼 바로 회복)`, instant: (v) => ({ heal: v }) },
  { key: 'regen', name: '재생', icon: '💚', stat: 'regen', vals: [0.8, 1.5, 2.5, 4], text: (v) => `초당 체력 ${fx(v)} 회복` },
  { key: 'leech', name: '흡혈', icon: '🩸', stat: 'lifesteal', vals: [0.015, 0.03, 0.05, 0.08], text: (v) => `준 피해의 ${pc(v)}만큼 체력 회복` },
  { key: 'armor', name: '방탄복', icon: '🦺', stat: 'armor', vals: [0.04, 0.07, 0.11, 0.16], text: (v) => `받는 피해 −${pc(v)}` },
  { key: 'ration', name: '전투 식량', icon: '🍖', stat: 'killHeal', vals: [1, 2, 3, 5], text: (v) => `좀비를 처치할 때마다 체력 +${v}` },
  { key: 'power', name: '화력', icon: '💥', stat: 'dmg', vals: [0.06, 0.1, 0.15, 0.22], text: (v) => `모든 피해 +${pc(v)}` },
  { key: 'head', name: '정밀 사격', icon: '🎯', stat: 'head', vals: [0.12, 0.2, 0.32, 0.5], text: (v) => `머리 피해 +${pc(v)}` },
  { key: 'boss', name: '보스 사냥꾼', icon: '👑', stat: 'boss', vals: [0.1, 0.18, 0.28, 0.42], text: (v) => `보스에게 주는 피해 +${pc(v)}` },
  { key: 'blade', name: '칼잡이', icon: '🔪', stat: 'melee', vals: [0.2, 0.35, 0.55, 0.9], text: (v) => `칼 피해 +${pc(v)}` },
  { key: 'demo', name: '폭파병', icon: '🧨', stat: 'nade', vals: [0.18, 0.3, 0.48, 0.75], text: (v) => `수류탄 피해 +${pc(v)}` },
  { key: 'trigger', name: '방아쇠', icon: '⚡', stat: 'fireRate', vals: [0.06, 0.1, 0.15, 0.22], text: (v) => `연사 속도 +${pc(v)}` },
  { key: 'hands', name: '빠른 손', icon: '🔄', stat: 'reload', vals: [0.08, 0.14, 0.22, 0.32], text: (v) => `재장전 속도 +${pc(v)}` },
  { key: 'mag', name: '탄창 확장', icon: '📦', stat: 'mag', vals: [0.12, 0.2, 0.32, 0.5], text: (v) => `최대 탄창 +${pc(v)}` },
  {
    key: 'ammo', name: '탄약 상자', icon: '🧰', stat: 'reserve', vals: [0.5, 1, 1.5, 2],
    text: (v) => (v === 1 ? '최대 재장전 탄창을 기본 재장전 탄창만큼 늘리고 가득 채움' : `최대 재장전 탄창을 기본의 ${fx(v)}배만큼 늘리고 가득 채움`),
    instant: () => ({ refill: true })
  },
  { key: 'steady', name: '안정 조준', icon: '🧘', stat: 'spread', vals: [0.08, 0.14, 0.22, 0.32], text: (v) => `탄퍼짐 −${pc(v)}` },
  { key: 'grip', name: '반동 제어', icon: '✊', stat: 'recoil', vals: [0.1, 0.16, 0.25, 0.36], text: (v) => `반동 −${pc(v)}` },
  { key: 'swap', name: '빠른 교체', icon: '🔀', stat: 'draw', vals: [0.15, 0.25, 0.4, 0.6], text: (v) => `무기 꺼내기 속도 +${pc(v)}` },
  { key: 'sprint', name: '질주', icon: '👟', stat: 'move', vals: [0.05, 0.08, 0.12, 0.18], text: (v) => `이동 속도 +${pc(v)}` },
  { key: 'limit', name: '가속 한계', icon: '🚀', stat: 'maxSpeed', vals: [0.08, 0.14, 0.22, 0.35], text: (v) => `최대 속도 +${pc(v)} (버니합 상한)` },
  { key: 'leap', name: '도약', icon: '🦘', stat: 'jump', vals: [0.08, 0.12, 0.18, 0.26], text: (v) => `점프 높이 +${pc(v)}` },
  { key: 'pouch', name: '수류탄 주머니', icon: '💣', stat: 'nades', vals: [1, 1, 2, 3], text: (v) => `최대 수류탄 +${v} (가득 채움)`, instant: () => ({ nades: true }) },
  { key: 'pierce', name: '관통탄', icon: '🗡️', stat: 'pierce', vals: [1, 1, 2, 3], text: (v) => `탄이 좀비 ${v}마리를 더 뚫는다(뚫을 때마다 피해 70%)`, minTier: 1 },
  { key: 'scav', name: '탄약 회수', icon: '♻️', stat: 'killAmmo', vals: [1, 1, 2, 3], text: (v) => `처치할 때마다 탄창에 탄 ${v}발 돌려받기` },
  { key: 'weak', name: '약점 포착', icon: '🔍', stat: 'crit', vals: [0.04, 0.07, 0.11, 0.16], text: (v) => `${pc(v)} 확률로 치명타(피해 ×1.5)` },
  { key: 'wound', name: '치명상', icon: '🩹', stat: 'critDmg', vals: [0.2, 0.35, 0.55, 0.8], text: (v) => `치명타 피해 +${pc(v)}` },
  { key: 'frost', name: '냉각탄', icon: '❄️', stat: 'slow', vals: [0.08, 0.12, 0.18, 0.25], text: (v) => `맞은 좀비가 1.2초 동안 ${pc(v)} 느려짐` },
  { key: 'thorn', name: '가시 갑옷', icon: '🌵', stat: 'thorns', vals: [15, 25, 40, 60], text: (v) => `나를 때린 좀비에게 피해 ${v}` },
  { key: 'dodge', name: '회피', icon: '💨', stat: 'dodge', vals: [0.03, 0.05, 0.08, 0.12], text: (v) => `${pc(v)} 확률로 피해를 피함` },
  { key: 'exec', name: '처형자', icon: '⚔️', stat: 'executioner', vals: [0.15, 0.25, 0.4, 0.6], text: (v) => `체력 25% 아래 좀비에게 피해 +${pc(v)}` },
  { key: 'last', name: '배수의 진', icon: '🔥', stat: 'lastStand', vals: [0.12, 0.2, 0.32, 0.48], text: (v) => `내 체력이 35% 아래일 때 피해 +${pc(v)}` },
  { key: 'rest', name: '휴식', icon: '🛌', stat: 'stageHeal', vals: [0.1, 0.15, 0.25, 0.4], text: (v) => `스테이지가 시작할 때 최대 체력의 ${pc(v)} 회복` },
  { key: 'shield', name: '보호막', icon: '🛡️', stat: 'shield', vals: [15, 25, 40, 60], text: (v) => `스테이지가 시작할 때 보호막 ${v}` },
  { key: 'forge', name: '탄약 제조', icon: '🏭', stat: 'ammoRegen', vals: [0.02, 0.04, 0.06, 0.09], text: (v) => `1초마다 탄창 크기의 ${pc(v)}만큼 재장전 탄창 회복` },
  { key: 'frenzy', name: '광란', icon: '🌀', stat: 'frenzy', vals: [0.03, 0.04, 0.06, 0.08], text: (v) => `처치할 때마다 4초 동안 연사 +${pc(v)} (최대 5번 겹침)` }
];

/**
 * 한 장뿐인 특수 카드. fx = 능력치 변화(여러 개 가능), instant = 고른 순간 한 번만 일어나는 일, max = 고를 수 있는 횟수(없으면 무제한).
 */
const SPECIALS = [
  { key: 'second', name: '두 번째 기회', icon: '🪽', tier: 'legend', max: 1, fx: { secondChance: 1 }, desc: '스테이지마다 한 번, 쓰러질 피해를 받아도 체력 30%로 버틴다', minStage: 3 },
  { key: 'glass', name: '유리 대포', icon: '🔮', tier: 'epic', max: 1, fx: { dmg: 0.35, maxHpPct: -0.25 }, desc: '모든 피해 +35% · 최대 체력 −25%' },
  { key: 'wall', name: '철벽', icon: '🧱', tier: 'epic', max: 1, fx: { maxHpPct: 0.6, move: -0.08 }, desc: '최대 체력 +60% · 이동 속도 −8%' },
  { key: 'chain', name: '연쇄 폭발', icon: '🎆', tier: 'legend', max: 2, fx: { explosive: 0.25 }, desc: '처치한 좀비가 터져 3 m 안의 좀비에게 그 좀비 최대 체력의 25% 피해', minStage: 4 },
  { key: 'luck', name: '행운', icon: '🍀', tier: 'rare', max: 3, fx: { rerolls: 1 }, desc: '카드 제안마다 다시 뽑기 +1' },
  { key: 'wide', name: '넓은 선택', icon: '🃏', tier: 'epic', max: 1, fx: { offers: 1 }, desc: '카드 제안이 4장으로 늘어난다' },
  { key: 'medkit', name: '응급 처치', icon: '🚑', tier: 'common', instant: { healPct: 1 }, desc: '체력을 가득 회복' },
  { key: 'syringe', name: '회복 주사', icon: '💉', tier: 'common', instant: { healPct: 0.5 }, fx: { regen: 0.3 }, desc: '체력 50% 회복 · 초당 회복 +0.3' },
  { key: 'drop', name: '보급 투하', icon: '🪂', tier: 'rare', instant: { refill: true, nades: true }, desc: '재장전 탄창과 수류탄을 가득 채움' },
  { key: 'hunter', name: '사냥 본능', icon: '🐺', tier: 'rare', fx: { dmg: 0.08, move: 0.04 }, desc: '모든 피해 +8% · 이동 속도 +4%' },
  { key: 'thrift', name: '탄약 절약', icon: '🪙', tier: 'epic', max: 3, fx: { thrift: 0.15 }, desc: '15% 확률로 쏴도 탄이 줄지 않는다' },
  { key: 'perfect', name: '완벽주의자', icon: '💎', tier: 'epic', fx: { head: 0.3, spread: 0.15 }, desc: '머리 피해 +30% · 탄퍼짐 −15%' },
  { key: 'giant', name: '거인 학살자', icon: '🗿', tier: 'epic', fx: { boss: 0.25, executioner: 0.1 }, desc: '보스 피해 +25% · 약해진 좀비 피해 +10%' },
  { key: 'thirst', name: '피의 갈증', icon: '🧛', tier: 'epic', fx: { lifesteal: 0.04, killHeal: 2 }, desc: '흡혈 +4% · 처치마다 체력 +2' },
  { key: 'runngun', name: '기동 사격', icon: '🏃', tier: 'rare', fx: { spread: 0.1, move: 0.06 }, desc: '탄퍼짐 −10% · 이동 속도 +6%' },
  { key: 'drum', name: '드럼 탄창', icon: '🥁', tier: 'epic', fx: { mag: 0.6, reload: -0.1 }, desc: '최대 탄창 +60% · 재장전 속도 −10%' },
  { key: 'samurai', name: '무사도', icon: '🏯', tier: 'epic', fx: { melee: 0.8, move: 0.05 }, desc: '칼 피해 +80% · 이동 속도 +5%' },
  { key: 'iron', name: '불굴', icon: '⛓️', tier: 'epic', fx: { armor: 0.12, regen: 1 }, desc: '받는 피해 −12% · 초당 회복 +1' },
  { key: 'tactical', name: '전술 재장전', icon: '🧷', tier: 'rare', fx: { reload: 0.25, mag: 0.1 }, desc: '재장전 속도 +25% · 최대 탄창 +10%' },
  { key: 'react', name: '연쇄 반응', icon: '☢️', tier: 'epic', fx: { explosive: 0.12, nade: 0.25 }, desc: '처치 폭발 +12% · 수류탄 피해 +25%', minStage: 4 },
  { key: 'dread', name: '공포 그 자체', icon: '👹', tier: 'rare', fx: { slow: 0.12, thorns: 20 }, desc: '냉각 +12% · 가시 20' },
  { key: 'coin', name: '행운의 동전', icon: '🪙', tier: 'rare', fx: { crit: 0.08, dodge: 0.04 }, desc: '치명타 +8% · 회피 +4%' },
  { key: 'adrenaline', name: '아드레날린', icon: '💓', tier: 'legend', fx: { fireRate: 0.15, move: 0.1, lastStand: 0.2 }, desc: '연사 +15% · 이동 +10% · 체력이 낮을 때 피해 +20%', minStage: 4 },
  { key: 'bunker', name: '벙커', icon: '🏚️', tier: 'legend', fx: { armor: 0.15, shield: 50 }, desc: '받는 피해 −15% · 스테이지마다 보호막 50', minStage: 4 }
];

function build() {
  const out = [];
  for (const f of FAMILIES) {
    for (let lv = 0; lv < 4; lv++) {
      const v = f.vals[lv];
      const tier = TIER_OF_LEVEL[Math.max(lv, f.minTier || 0)];
      const card = {
        id: `${f.key}${lv + 1}`, family: f.key, name: `${f.name} ${ROMAN[lv]}`, icon: f.icon, tier,
        fx: { [f.stat]: v }, desc: f.text(v), max: null, minStage: lv === 3 ? 4 : lv === 2 ? 2 : 1
      };
      if (f.instant) card.instant = f.instant(v);
      out.push(card);
    }
  }
  for (const s of SPECIALS) {
    out.push({
      id: s.key, family: s.key, name: s.name, icon: s.icon, tier: s.tier, fx: s.fx || {}, desc: s.desc,
      max: s.max || null, minStage: s.minStage || 1, instant: s.instant || null, special: true
    });
  }
  return out.map((c, idx) => deepFreeze({ ...c, idx, instant: c.instant || null }));
}

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const k of Object.keys(o)) deepFreeze(o[k]);
  }
  return o;
}

/** 모든 카드(순서 = 전송 번호 idx) */
export const CARDS = Object.freeze(build());
export const CARD_COUNT = CARDS.length;
const BY_ID = new Map(CARDS.map((c) => [c.id, c]));
export const cardById = (id) => BY_ID.get(String(id)) || null;

/* ------------------------------------------------------------------ 능력치 */

/** 카드 id 목록 → 능력치(상한을 넘지 않는다). 모르는 id는 건너뛴다 */
export function computePerks(ids) {
  const s = { ...PERK_BASE };
  for (const id of Array.isArray(ids) ? ids : []) {
    const c = cardById(id);
    if (!c) continue;
    for (const [k, v] of Object.entries(c.fx)) if (k in s) s[k] += v;
  }
  for (const [k, cap] of Object.entries(PERK_CAPS)) if (s[k] > cap) s[k] = cap;
  // 음수가 될 수 있는 값의 하한
  s.maxHpPct = Math.max(-0.6, s.maxHpPct);
  s.move = Math.max(-0.3, s.move);
  s.reload = Math.max(-0.5, s.reload);
  return s;
}

/** 능력치의 최대 체력(기본 100에 카드) */
export function perkMaxHp(stats, base = 100) {
  const s = stats || PERK_BASE;
  return Math.max(20, Math.round((base + (s.maxHp || 0)) * (1 + (s.maxHpPct || 0))));
}

/** 이 카드를 더 고를 수 있는가: 고를 수 있는 횟수와 능력치 상한 */
export function cardAvailable(card, taken = [], stats = null) {
  if (!card) return false;
  if (card.max) {
    let n = 0;
    for (const id of taken) if (id === card.id) n++;
    if (n >= card.max) return false;
  }
  const s = stats || computePerks(taken);
  const keys = Object.keys(card.fx);
  if (!keys.length) return true;                    // 회복·보급처럼 능력치가 없는 카드
  // 모든 능력치가 이미 상한이면 빼고, 하나라도 오를 수 있으면 남긴다(음수 효과는 상한과 상관없다)
  return keys.some((k) => card.fx[k] < 0 || !(k in PERK_CAPS) || s[k] < PERK_CAPS[k] - 1e-9);
}

/**
 * 카드 제안. 같은 입력이면 늘 같은 결과다(방장이 바뀌어도 스냅샷의 제안을 그대로 쓰지만, 시험에서 재현하기 위해).
 * { seed, playerId, stage, roll(다시 뽑은 횟수), taken: 고른 카드 id들, count, exclude: 이번 제안에서 빼고 싶은 id들 }
 * → 카드 id 배열(겹치지 않는다). 보스 스테이지를 깬 제안에는 영웅 이상이 적어도 한 장 들어간다.
 */
export function makeOffer({ seed = 1, playerId = '', stage = 1, roll = 0, taken = [], count = 3, exclude = [] } = {}) {
  const rng = makeRng(hashSeed(seed, playerId, stage, roll));
  const stats = computePerks(taken);
  const ex = new Set(exclude);
  const s = Math.max(1, stage | 0);
  const pool = CARDS.filter((c) => s >= c.minStage && !ex.has(c.id) && cardAvailable(c, taken, stats));
  const chosen = [];
  const need = Math.max(1, Math.min(6, count | 0));
  const tierWeights = Object.values(TIERS).map((t) => ({ id: t.id, weight: t.weight * (t.id === 'legend' && s < 4 ? 0 : 1) }));
  let guard = 0;
  while (chosen.length < need && guard++ < 200) {
    const left = pool.filter((c) => !chosen.includes(c.id));
    if (!left.length) break;
    // 보스를 깬 제안(5의 배수 스테이지)의 첫 장은 영웅 이상
    const forceHigh = s % 5 === 0 && chosen.length === 0;
    const tw = forceHigh ? tierWeights.filter((t) => t.id === 'epic' || t.id === 'legend') : tierWeights;
    const tier = pickWeighted(tw, rng);
    let cands = left.filter((c) => c.tier === (tier && tier.id));
    if (!cands.length) cands = left;
    // 같은 묶음(family) 카드가 한 제안에 두 장 나오지 않게
    const fams = new Set(chosen.map((id) => cardById(id).family));
    const fresh = cands.filter((c) => !fams.has(c.family));
    const list = fresh.length ? fresh : cands;
    chosen.push(list[Math.floor(rng() * list.length)].id);
  }
  return chosen;
}

/** 카드 id 목록 → 짧은 글자(카드마다 36진수 두 자리) */
export function encodeCards(ids) {
  let out = '';
  for (const id of Array.isArray(ids) ? ids : []) {
    const c = cardById(id);
    if (c) out += c.idx.toString(36).padStart(2, '0');
  }
  return out;
}

/** encodeCards의 반대. 틀린 칸은 건너뛴다 */
export function decodeCards(str) {
  const out = [];
  const s = typeof str === 'string' ? str : '';
  for (let i = 0; i + 1 < s.length; i += 2) {
    const n = parseInt(s.slice(i, i + 2), 36);
    if (Number.isInteger(n) && n >= 0 && n < CARDS.length) out.push(CARDS[n].id);
  }
  return out;
}

/** 능력치 중 0이 아닌 것만 짧게(결과 화면·점수판 요약) */
export function perkSummary(stats) {
  const s = stats || PERK_BASE;
  const rows = [];
  const add = (label, v, f) => { if (v) rows.push({ label, value: f(v) }); };
  const plus = (v) => `${v > 0 ? '+' : '−'}${Math.round(Math.abs(v) * 100)}%`;
  add('최대 체력', perkMaxHp(s) - 100, (v) => `${v > 0 ? '+' : '−'}${Math.abs(v)}`);
  add('피해', s.dmg, plus); add('머리', s.head, plus); add('보스', s.boss, plus);
  add('연사', s.fireRate, plus); add('재장전', s.reload, plus); add('탄창', s.mag, plus);
  add('재장전 탄창', s.reserve, (v) => `+${fx(v)}배`);
  add('이동', s.move, plus); add('최대 속도', s.maxSpeed, plus);
  add('방어', s.armor, (v) => `−${Math.round(v * 100)}%`); add('회복', s.regen, (v) => `${fx(v)}/초`);
  add('흡혈', s.lifesteal, (v) => `${Math.round(v * 100)}%`); add('관통', s.pierce, (v) => `${v}`);
  return rows;
}
