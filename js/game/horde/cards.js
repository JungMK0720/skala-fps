/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 좀비 물량 막기의 증강(강화 카드, 180장 넘게). 팀 레벨이 오르거나 보스의 보물 상자를 주우면 3장(증강으로 4장까지)을 제안하고
 *          제안마다 다시 뽑기 1번을 준다. 카드 목록 → 능력치 계산(상한 없음, 한 장 카드는 고를 수 있는 횟수만), 제안 만들기, 짧은 글자로 싣기를 맡는다.
 *          순수 모듈이라 방장·화면·node 시험이 같이 쓴다. 수류탄을 키우는 증강은 모두 최대 수류탄을 2개 늘리고 가득 채운다.
 */
import { makeRng, hashSeed, pickWeighted } from './rules.js';
import { t } from '../../core/i18n.js';

/** 등급. weight = 제안에 나올 비율 */
export const TIERS = Object.freeze({
  common: Object.freeze({ id: 'common', name: t('horde.tier.common'), color: '#c9d4e0', weight: 55 }),
  rare: Object.freeze({ id: 'rare', name: t('horde.tier.rare'), color: '#4fb3ff', weight: 28 }),
  epic: Object.freeze({ id: 'epic', name: t('horde.tier.epic'), color: '#c46bff', weight: 13 }),
  legend: Object.freeze({ id: 'legend', name: t('horde.tier.legend'), color: '#ffb02e', weight: 4 })
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
  hitHeal: 0,      // H  좀비를 맞힐 때마다 회복(피의 갈증, 광역 공격은 20%)
  armor: 0,        // H  받는 피해 감소
  killHeal: 0,     // H  처치마다 회복
  dmg: 0,          // H  모든 피해 +%
  head: 0,         // H  머리 피해 +%
  bodyPenalty: 0,  // H  머리 이외 총 피해 감소율(완벽주의자)
  normalPenalty: 0, // H 일반 좀비에게 주는 피해 감소율(거인 학살자)
  boss: 0,         // H  보스 피해 +%
  melee: 0,        // H  칼 피해 +%
  nade: 0,         // H  수류탄 피해 +%
  crit: 0,         // H  치명타 확률(피해 ×(1.5 + critDmg))
  critDmg: 0,      // H  치명타 피해 +
  slow: 0,         // H  맞은 좀비가 느려지는 비율(1초, 25%를 넘으면 그만큼 오래: rules.js frostSlowMs)
  reactive: 0,     // H  폭발 반응 장갑: 좀비·보스에게 맞으면 내 자리에서 손 수류탄이 터지는 횟수(초당, 1 / 값 초에 한 번)
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
  pierce: 0,       // C  탄이 좀비를 뚫고 뒤의 좀비까지 맞는 수(뚫을 때마다 피해 70%, 최소 30%). 99 = 무제한
  killAmmo: 0,     // C  처치마다 탄창으로 돌아오는 탄
  ammoRegen: 0,    // C  초당 예비 탄 회복(탄창 크기의 비율)
  frenzy: 0,       // C  총으로 좀비를 맞힐 때마다 7초 동안 연사 +%(겹마다, 최대 300번 겹침. client.js)
  thrift: 0,       // C  쏴도 탄이 줄지 않을 확률
  medDrop: 0,      // H  내가 잡은 좀비가 구급 상자를 떨어뜨릴 확률 +(기본 5%)
  medHeal: 0,      // H  내가 주운 구급 상자 회복량 +(기본 10)
  ammoDrop: 0,     // H  내가 잡은 좀비가 탄창을 떨어뜨릴 확률 +(기본 10%)
  ammoMags: 0,     // C  주운 탄창 하나가 장전 몇 회분 더(기본 1회분)
  nadeFire: 0,     // H  화염 수류탄: 터진 자리에 불길(겹칠수록 세다)
  nadeFreeze: 0,   // H  빙결 수류탄: 맞은 좀비가 얼어붙는다(겹칠수록 오래)
  nadeDecoy: 0,    // H  어그로 수류탄: 터진 자리에 분신(겹칠수록 단단하다)
  nadeRadius: 0,   // HC 수류탄 폭발 반경 +%
  nadeMulti: 0,    // C  한 번에 더 던지는 수류탄 수
  iframe: 0,       // H  맞은 뒤 무적 시간 +초
  noKnock: 0,      // H  1이면 맞아도 밀려나지 않는다(보스의 밀치기도)
  stickyNade: 0,   // C  1이면 내 수류탄이 좀비에 닿으면 붙는 C4가 된다
  wave: 0,         // HC 칼 우클릭 찌르기에만 검기가 이 거리(m)까지 날아간다
  reloadCut: 0,    // C  재장전 시간 −비율(0.5 = 절반, 1 = 거의 즉시. 탄은 그대로 줄어든다)
  guard: 0,        // H  칼을 들면 방패를 든다: 정면에서 오는 공격의 피해 −비율
  airDmg: 0,       // H  점프로 떠 있는 동안 주는 피해 +배율(5 = +500%)
  autoAim: 0,      // C  총을 쏠 때 앞쪽 조준 원뿔 안의 좀비 몸통을 자동 조준
  sideMaster: 0,   // HC 1이면 주무기를 못 쓰고 보조무기 연사 2배 · 피해 +500% · 탄창 2배
  throwCut: 0      // C  투척무기를 던진 뒤 딜레이 −비율(근력팔, 0.9까지)
});

/* ------------------------------------------------------------------ 카드 표 (바꾸면 docs/AUGMENTS.md도 고친다) */

/** 글자 도우미 */
const pc = (v) => `${Math.round(v * 100)}%`;
const fx = (v) => (Math.abs(v - Math.round(v)) < 1e-9 ? String(Math.round(v)) : String(+v.toFixed(2)));

/**
 * 같은 능력치를 네 단계로 올리는 카드 묶음. vals[i] = I~IV의 값, text(v) = 설명, extra(v) = 고른 순간 한 번만 일어나는 일.
 * also = 같은 값만큼 함께 올리는 능력치(없으면 stat 하나). family 하나에 카드 네 장이 생긴다(I 일반 · II 희귀 · III 영웅 · IV 전설).
 */
const FAMILIES = [
  { key: 'hp', name: t('horde.card.hp'), icon: '❤️', stat: 'maxHp', vals: [15, 25, 40, 60], text: (v) => t('horde.cardDesc.hp', { v: v }), instant: (v) => ({ heal: v }) },
  { key: 'regen', name: t('horde.card.regen'), icon: '💚', stat: 'regen', vals: [0.8, 1.5, 2.5, 4], text: (v) => t('horde.cardDesc.regen', { v: fx(v) }) },
  { key: 'leech', name: t('horde.card.leech'), icon: '🩸', stat: 'lifesteal', vals: [0.001, 0.002, 0.003, 0.004], text: (v) => t('horde.cardDesc.leech', { v: fx(v * 100) }) },
  { key: 'armor', name: t('horde.card.armor'), icon: '🦺', stat: 'armor', vals: [0.05, 0.1, 0.15, 0.2], text: (v) => t('horde.cardDesc.armor', { pct: pc(v) }) },
  { key: 'ration', name: t('horde.card.ration'), icon: '🍖', stat: 'killHeal', vals: [3, 6, 9, 12], text: (v) => t('horde.cardDesc.ration', { v: v }) },
  { key: 'power', name: t('horde.card.power'), icon: '💥', stat: 'dmg', vals: [0.1, 0.2, 0.3, 0.4], text: (v) => t('horde.cardDesc.power', { pct: pc(v) }) },
  { key: 'head', name: t('horde.card.head'), icon: '🎯', stat: 'head', vals: [0.24, 0.4, 0.64, 1], text: (v) => t('horde.cardDesc.head', { pct: pc(v) }) },
  { key: 'boss', name: t('horde.card.boss'), icon: '👑', stat: 'boss', vals: [0.1, 0.18, 0.28, 0.42], text: (v) => t('horde.cardDesc.boss', { pct: pc(v) }) },
  { key: 'blade', name: t('horde.card.blade'), icon: '🔪', stat: 'melee', vals: [0.2, 0.35, 0.55, 0.9], text: (v) => t('horde.cardDesc.blade', { pct: pc(v) }) },
  { key: 'demo', name: t('horde.card.demo'), icon: '🧨', stat: 'nade', vals: [0.18, 0.3, 0.48, 0.75], text: (v) => t('horde.cardDesc.demo', { pct: pc(v), nadeUp: NADE_UP }), nade: true },
  { key: 'trigger', name: t('horde.card.trigger'), icon: '⚡', stat: 'fireRate', vals: [0.06, 0.1, 0.15, 0.22], text: (v) => t('horde.cardDesc.trigger', { pct: pc(v) }) },
  // 재장전 시간 −50%, 최대 2번(번호가 밀리지 않게 II~IV 자리는 남기고 제안에서만 뺀다). 두 번이면 재장전이 거의 즉시다(탄은 그대로 줄어든다)
  { key: 'hands', name: t('horde.card.hands'), icon: '🔄', stat: 'reloadCut', vals: [0.5, 0.5, 0.5, 0.5], text: () => t('horde.cardDesc.hands'), minTier: 2, only: 1, max: 2, retire: [1, 2, 3] },
  { key: 'mag', name: t('horde.card.mag'), icon: '📦', stat: 'mag', vals: [0.12, 0.2, 0.32, 0.5], text: (v) => t('horde.cardDesc.mag', { pct: pc(v) }) },
  {
    key: 'ammo', name: t('horde.card.ammo'), icon: '🧰', stat: 'reserve', vals: [0.5, 1, 1.5, 2],
    text: (v) => (v === 1 ? t('horde.cardDesc.ammo1') : t('horde.cardDesc.ammo', { v: fx(v) })),
    instant: () => ({ refill: true })
  },
  { key: 'steady', name: t('horde.card.steady'), icon: '🧘', stat: 'spread', vals: [0.08, 0.14, 0.22, 0.32], text: (v) => t('horde.cardDesc.steady', { pct: pc(v) }) },
  { key: 'grip', name: t('horde.card.grip'), icon: '✊', stat: 'recoil', vals: [0.1, 0.16, 0.25, 0.36], text: (v) => t('horde.cardDesc.grip', { pct: pc(v) }) },
  { key: 'swap', name: t('horde.card.swap'), icon: '🔀', stat: 'draw', vals: [0.15, 0.25, 0.4, 0.6], text: (v) => t('horde.cardDesc.swap', { pct: pc(v) }) },
  { key: 'sprint', name: t('horde.card.sprint'), icon: '👟', stat: 'move', vals: [0.05, 0.08, 0.12, 0.18], text: (v) => t('horde.cardDesc.sprint', { pct: pc(v) }) },
  // 걷는 속도(move)와 버니합 상한(maxSpeed)이 같은 비율로 함께 오른다
  { key: 'limit', name: t('horde.card.limit'), icon: '🚀', stat: 'maxSpeed', also: 'move', vals: [0.08, 0.14, 0.22, 0.35], text: (v) => t('horde.cardDesc.limit', { pct: pc(v) }) },
  { key: 'leap', name: t('horde.card.leap'), icon: '🦘', stat: 'jump', vals: [0.09, 0.14, 0.21, 0.3], text: (v) => t('horde.cardDesc.leap', { pct: pc(v) }) },
  { key: 'pouch', name: t('horde.card.pouch'), icon: '💣', stat: 'nades', vals: [5, 6, 8, 10], text: (v) => t('horde.cardDesc.pouch', { v: v }), instant: () => ({ nades: true }) },
  { key: 'medic', name: t('horde.card.medic'), icon: '🩹', stat: 'medDrop', vals: [0.04, 0.06, 0.09, 0.15], text: (v) => t('horde.cardDesc.medic', { pct: pc(v) }) },
  { key: 'kit', name: t('horde.card.kit'), icon: '🧪', stat: 'medHeal', vals: [5, 8, 12, 18], text: (v) => t('horde.cardDesc.kit', { v: v }) },
  { key: 'supply', name: t('horde.card.supply'), icon: '🎒', stat: 'ammoDrop', vals: [0.04, 0.06, 0.09, 0.15], text: (v) => t('horde.cardDesc.supply', { pct: pc(v) }) },
  // 탄창을 주우면 모든 총이 가득 차므로 더 받을 것이 없어 네 단계 모두 제안에서 뺀다(전송 번호는 그대로)
  { key: 'belt', name: t('horde.card.belt'), icon: '🎗️', stat: 'ammoMags', vals: [1, 1.5, 2, 3], text: (v) => t('horde.cardDesc.belt', { v: fx(v) }), retire: [1, 2, 3, 4] },
  { key: 'blast', name: t('horde.card.blast'), icon: '🌋', stat: 'nadeRadius', vals: [0.3, 0.45, 0.63, 0.88], text: (v) => t('horde.cardDesc.blast', { pct: pc(v), nadeUp: NADE_UP }), nade: true },
  // 무제한 관통(한 장). 예전 I~IV 중 I 자리를 이 카드로 바꾸고 II~IV는 제안에서만 뺀다
  { key: 'pierce', name: t('horde.card.pierce'), icon: '🗡️', stat: 'pierce', vals: [99, 99, 99, 99], text: () => t('horde.cardDesc.pierce'), minTier: 2, only: 1, max: 1, retire: [1, 2, 3] },
  { key: 'scav', name: t('horde.card.scav'), icon: '♻️', stat: 'killAmmo', vals: [1, 1, 2, 3], text: (v) => t('horde.cardDesc.scav', { v: v }) },
  { key: 'weak', name: t('horde.card.weak'), icon: '🔍', stat: 'crit', vals: [0.04, 0.07, 0.11, 0.16], text: (v) => t('horde.cardDesc.weak', { pct: pc(v) }) },
  { key: 'wound', name: t('horde.card.wound'), icon: '🩹', stat: 'critDmg', vals: [0.2, 0.35, 0.55, 0.8], text: (v) => t('horde.cardDesc.wound', { pct: pc(v) }) },
  { key: 'frost', name: t('horde.card.frost'), icon: '❄️', stat: 'slow', vals: [0.08, 0.12, 0.18, 0.25], text: (v) => t('horde.cardDesc.frost', { pct: pc(v) }) },
  // 폭발 반응 장갑(예전 가시 갑옷 자리, id thorn1~4 그대로). 값 = 초당 터지는 횟수: 4 · 3 · 2 · 1초에 한 번, 겹치면 더해져 더 자주
  { key: 'thorn', name: t('horde.card.thorn'), icon: '☄️', stat: 'reactive', vals: [0.25, 1 / 3, 0.5, 1], text: (v) => t('horde.cardDesc.thorn', { sec: fx(1 / v) }) },
  { key: 'dodge', name: t('horde.card.dodge'), icon: '💨', stat: 'dodge', vals: [0.03, 0.05, 0.08, 0.12], text: (v) => t('horde.cardDesc.dodge', { pct: pc(v) }) },
  { key: 'exec', name: t('horde.card.exec'), icon: '⚔️', stat: 'executioner', vals: [0.38, 0.63, 1, 1.5], text: (v) => t('horde.cardDesc.exec', { pct: pc(v) }) },
  { key: 'last', name: t('horde.card.last'), icon: '🔥', stat: 'lastStand', vals: [0.25, 0.42, 0.67, 1], text: (v) => t('horde.cardDesc.last', { pct: pc(v) }) },
  { key: 'rest', name: t('horde.card.rest'), icon: '🛌', stat: 'stageHeal', vals: [0.25, 0.38, 0.63, 1], text: (v) => t('horde.cardDesc.rest', { pct: pc(v) }) },
  { key: 'shield', name: t('horde.card.shield'), icon: '🛡️', stat: 'shield', vals: [30, 50, 80, 120], text: (v) => t('horde.cardDesc.shield', { v: v }) },
  { key: 'forge', name: t('horde.card.forge'), icon: '🏭', stat: 'ammoRegen', vals: [0.02, 0.04, 0.06, 0.09], text: (v) => t('horde.cardDesc.forge', { pct: pc(v) }) },
  { key: 'frenzy', name: t('horde.card.frenzy'), icon: '🌀', stat: 'frenzy', vals: [0.004, 0.005, 0.0075, 0.01], text: (v) => t('horde.cardDesc.frenzy', { pct: +(v * 100).toFixed(2) }) }
];

/** 수류탄을 키우는 증강에 붙는 말(최대 수류탄 +2, 가득 채움) */
const NADE_UP = t('horde.cardNadeUp');
/** 수류탄 증강 하나가 늘리는 최대 수류탄 수 */
const NADE_UP_N = 2;

/**
 * 한 장뿐인 특수 카드. fx = 능력치 변화(여러 개 가능), instant = 고른 순간 한 번만 일어나는 일, max = 고를 수 있는 횟수(없으면 무제한).
 * nade: true면 수류탄 증강이라 최대 수류탄 +2와 가득 채움이 붙는다.
 */
const SPECIALS = [
  { key: 'second', name: t('horde.card.second'), icon: '🪽', tier: 'legend', max: 1, fx: { secondChance: 1 }, desc: t('horde.cardDesc.second'), minStage: 3 },
  { key: 'glass', name: t('horde.card.glass'), icon: '🔮', tier: 'epic', max: 1, fx: { dmg: 0.5, maxHpPct: -0.2 }, desc: t('horde.cardDesc.glass') },
  { key: 'wall', name: t('horde.card.wall'), icon: '🧱', tier: 'epic', max: 1, fx: { maxHpPct: 1, fireRate: -0.2 }, desc: t('horde.cardDesc.wall') },
  { key: 'chain', name: t('horde.card.chain'), icon: '🎆', tier: 'legend', max: 2, fx: { explosive: 0.25 }, desc: t('horde.cardDesc.chain'), minStage: 4 },
  { key: 'luck', name: t('horde.card.luck'), icon: '🍀', tier: 'rare', max: 3, fx: { rerolls: 1 }, desc: t('horde.cardDesc.luck') },
  { key: 'wide', name: t('horde.card.wide'), icon: '🃏', tier: 'epic', max: 1, fx: { offers: 1 }, desc: t('horde.cardDesc.wide') },
  { key: 'medkit', name: t('horde.card.medkit'), icon: '🚑', tier: 'common', instant: { healPct: 1 }, desc: t('horde.cardDesc.medkit') },
  { key: 'syringe', name: t('horde.card.syringe'), icon: '💉', tier: 'common', instant: { healPct: 0.5 }, fx: { regen: 0.5 }, desc: t('horde.cardDesc.syringe') },
  { key: 'drop', name: t('horde.card.drop'), icon: '🪂', tier: 'rare', max: 1, desc: t('horde.cardDesc.drop') },
  { key: 'hunter', name: t('horde.card.hunter'), icon: '🐺', tier: 'rare', fx: { dmg: 0.24, move: 0.12 }, desc: t('horde.cardDesc.hunter') },
  { key: 'thrift', name: t('horde.card.thrift'), icon: '🪙', tier: 'epic', max: 2, fx: { thrift: 0.45 }, desc: t('horde.cardDesc.thrift') },
  { key: 'perfect', name: t('horde.card.perfect'), icon: '💎', tier: 'epic', max: 1, fx: { head: 3, bodyPenalty: 0.9 }, desc: t('horde.cardDesc.perfect') },
  { key: 'giant', name: t('horde.card.giant'), icon: '🗿', tier: 'epic', max: 1, fx: { boss: 3, normalPenalty: 0.5 }, desc: t('horde.cardDesc.giant') },
  { key: 'thirst', name: t('horde.card.thirst'), icon: '🧛', tier: 'epic', fx: { hitHeal: 0.3, killHeal: 2 }, desc: t('horde.cardDesc.thirst') },
  { key: 'runngun', name: t('horde.card.runngun'), icon: '🏃', tier: 'rare', fx: { spread: 0.3, move: 0.18 }, desc: t('horde.cardDesc.runngun') },
  { key: 'drum', name: t('horde.card.drum'), icon: '🥁', tier: 'epic', fx: { mag: 0.6, reload: -0.1 }, desc: t('horde.cardDesc.drum') },
  { key: 'samurai', name: t('horde.card.samurai'), icon: '🏯', tier: 'epic', fx: { melee: 0.8, move: 0.05 }, desc: t('horde.cardDesc.samurai') },
  { key: 'iron', name: t('horde.card.iron'), icon: '⛓️', tier: 'epic', fx: { armor: 0.12, regen: 0.5 }, desc: t('horde.cardDesc.iron') },
  { key: 'tactical', name: t('horde.card.tactical'), icon: '🧷', tier: 'rare', fx: { reload: 0.25, mag: 1 }, desc: t('horde.cardDesc.tactical') },
  { key: 'react', name: t('horde.card.react'), icon: '☢️', tier: 'epic', fx: { explosive: 0.12, nade: 0.25 }, desc: t('horde.cardDesc.react'), minStage: 4, nade: true },
  { key: 'dread', name: t('horde.card.dread'), icon: '👹', tier: 'rare', fx: { slow: 0.12, reactive: 0.25 }, desc: t('horde.cardDesc.dread') },
  { key: 'coin', name: t('horde.card.coin'), icon: '🪙', tier: 'rare', fx: { crit: 0.08, dodge: 0.04 }, desc: t('horde.cardDesc.coin') },
  { key: 'adrenaline', name: t('horde.card.adrenaline'), icon: '💓', tier: 'legend', fx: { fireRate: 0.5, move: 0.3, lastStand: 1 }, desc: t('horde.cardDesc.adrenaline'), minStage: 4 },
  { key: 'bunker', name: t('horde.card.bunker'), icon: '🏚️', tier: 'legend', fx: { armor: 0.45, shield: 100 }, desc: t('horde.cardDesc.bunker'), minStage: 4 },
  // 수류탄 증강: 효과는 내 수류탄 모두에 겹쳐 붙는다(화염 + 빙결 + 분신을 함께 가질 수 있다)
  { key: 'fireNade', name: t('horde.card.fireNade'), icon: '🔥', tier: 'epic', max: 3, fx: { nadeFire: 1 }, desc: t('horde.cardDesc.fireNade'), nade: true },
  { key: 'iceNade', name: t('horde.card.iceNade'), icon: '🧊', tier: 'epic', max: 3, fx: { nadeFreeze: 1 }, desc: t('horde.cardDesc.iceNade'), nade: true },
  { key: 'decoyNade', name: t('horde.card.decoyNade'), icon: '🎭', tier: 'epic', max: 3, fx: { nadeDecoy: 1 }, desc: t('horde.cardDesc.decoyNade'), nade: true },
  { key: 'multiNade', name: t('horde.card.multiNade'), icon: '🎇', tier: 'rare', max: 4, fx: { nadeMulti: 1 }, desc: t('horde.cardDesc.multiNade'), nade: true },
  // 무기는 1스테이지 전에만 고르므로, 판 중간에 총을 바꾸는 길은 이 증강뿐이다. 아주 가끔 나온다(w = 같은 등급 안에서 나올 비율)
  { key: 'rearm', name: t('horde.card.rearm'), icon: '🔁', tier: 'rare', w: 1.2, retired: true, instant: { swap: true }, desc: t('horde.cardDesc.rearm') },
  // 보조무기를 폭발 무기로 바꾸는 증강(낮은 확률). 쓰러졌다 일어나도 그대로다. 나중에 고른 쪽으로 바뀐다
  { key: 'sideGl', name: t('horde.card.sideGl'), icon: '🧨', tier: 'epic', w: 2, max: 1, instant: { side: 'gl_m32' }, desc: t('horde.cardDesc.sideGl') },
  { key: 'sideRl', name: t('horde.card.sideRl'), icon: '🚀', tier: 'legend', w: 5, max: 1, minStage: 3, instant: { side: 'rl_b9' }, desc: t('horde.cardDesc.sideRl') }
];

/**
 * 나중에 더한 카드. 전송 번호(idx)는 카드 순서라서, 이미 있는 카드의 번호가 바뀌지 않게 모든 묶음·특수 카드 뒤에 붙인다.
 * vals가 있으면 묶음(FAMILIES와 같은 모양), 없으면 특수 카드(SPECIALS와 같은 모양)다. 새 카드는 이 목록 끝에만 더한다.
 */
const ADDED = [
  { key: 'reflex', name: t('horde.card.reflex'), icon: '✨', stat: 'iframe', vals: [0.2, 0.3, 0.4, 0.5], text: (v) => t('horde.cardDesc.reflex', { v: fx(v) }) },
  // 검기: 전설 한 장(IV)만 제안에 나온다. I~III은 번호만 남긴다(예전 기록·전송을 읽게). 우클릭 찌르기만 · 10 m · 좀비 한 마리
  { key: 'wave', name: t('horde.card.wave'), icon: '🌙', stat: 'wave', vals: [10, 10, 10, 10], only: true, max: 1, retire: [0, 1, 2], text: (v) => t('horde.cardDesc.wave', { v: v }) },
  { key: 'anchor', name: t('horde.card.anchor'), icon: '⚓', tier: 'epic', max: 1, fx: { noKnock: 1 }, desc: t('horde.cardDesc.anchor') },
  { key: 'c4', name: t('horde.card.c4'), icon: '🧲', tier: 'epic', max: 1, fx: { stickyNade: 1 }, nade: true, desc: t('horde.cardDesc.c4') },
  { key: 'shieldKnife', name: t('horde.card.shieldKnife'), icon: '🛡️', tier: 'epic', max: 1, fx: { guard: 0.45 }, desc: t('horde.cardDesc.shieldKnife') },
  { key: 'airStrike', name: t('horde.card.airStrike'), icon: '🦅', tier: 'epic', max: 1, fx: { airDmg: 5 }, desc: t('horde.cardDesc.airStrike') },
  // 보조무기를 특이점포로 바꾸는 증강(낮은 확률). 쏘면 앞쪽에서 중력이 생겨 좀비를 한 점으로 끌어 뭉친다
  { key: 'sideGravity', name: t('horde.card.sideGravity'), icon: '🌀', tier: 'epic', w: 2, max: 1, minStage: 2, instant: { side: 'gv_gun' }, desc: t('horde.cardDesc.sideGravity') },
  { key: 'flameGun', name: t('horde.card.flameGun'), icon: '🔥', tier: 'legend', max: 1, minStage: 3,
    instant: { primary: 'fl_horde' }, desc: t('horde.cardDesc.flameGun') },
  { key: 'railGun', name: t('horde.card.railGun'), icon: '⚡', tier: 'legend', max: 1, minStage: 3,
    instant: { primary: 'rg_horde' }, desc: t('horde.cardDesc.railGun') },
  { key: 'aiGlasses', name: t('horde.card.aiGlasses'), icon: '🥽', tier: 'legend', max: 1, minStage: 3,
    fx: { autoAim: 1 }, desc: t('horde.cardDesc.aiGlasses') },
  { key: 'sideMaster', name: t('horde.card.sideMaster'), icon: '🔫', tier: 'legend', max: 1, minStage: 3,
    fx: { sideMaster: 1 }, desc: t('horde.cardDesc.sideMaster') },
  // 제우스의 번개(요청 2026-11-20): 주무기가 번개를 던지는 무기로 바뀐다. 맞으면 근처 좀비로 다섯 번 튀고 피해가 줄지 않는다
  { key: 'zeus', name: t('horde.card.zeus'), icon: '🌩️', tier: 'legend', max: 1, minStage: 3,
    instant: { primary: 'zs_bolt' }, desc: t('horde.cardDesc.zeus') },
  // 질풍검(요청 2026-11-20): 좌·우클릭이 같은 칼 판정 찌르기. 두 번 맞히면 다음 공격이 바닥을 타고 앞으로 가는 충격파
  { key: 'yasuoSword', name: t('horde.card.yasuoSword'), icon: '💨', tier: 'legend', max: 1, minStage: 3,
    instant: { melee: 'ml_yasuo' }, desc: t('horde.cardDesc.yasuoSword') },
  // 근력팔(요청 2026-11-20): 투척무기(수류탄·도끼)를 던진 뒤 딜레이 −45%. 두 장까지(−90%)
  { key: 'strongArm', name: t('horde.card.strongArm'), icon: '💪', tier: 'rare', max: 2, fx: { throwCut: 0.45 }, desc: t('horde.cardDesc.strongArm') }
];

/** 묶음 하나 → 카드 네 장(I 일반 · II 희귀 · III 영웅 · IV 전설, minTier가 있으면 그 등급부터) */
function familyCards(f) {
  const out = [];
  for (let lv = 0; lv < 4; lv++) {
    const v = f.vals[lv];
    const tier = TIER_OF_LEVEL[Math.max(lv, f.minTier || 0)];
    const card = {
      id: `${f.key}${lv + 1}`, family: f.key, name: f.only ? f.name : `${f.name} ${ROMAN[lv]}`, icon: f.icon, tier,
      fx: f.also ? { [f.stat]: v, [f.also]: v } : { [f.stat]: v }, desc: f.text(v), max: f.max || null, minStage: f.only ? 1 : lv === 3 ? 4 : lv === 2 ? 2 : 1
    };
    // 더는 제안에 나오지 않는 자리(번호는 그대로라 예전 기록·전송은 읽힌다)
    if (Array.isArray(f.retire) && f.retire.includes(lv)) card.retired = true;
    if (f.instant) card.instant = f.instant(v);
    if (f.nade) nadeUp(card);
    out.push(card);
  }
  return out;
}

/** 특수 카드 한 장 */
function specialCard(s) {
  const card = {
    id: s.key, family: s.key, name: s.name, icon: s.icon, tier: s.tier, fx: { ...(s.fx || {}) }, desc: s.desc,
    max: s.max || null, minStage: s.minStage || 1, instant: s.instant || null, special: true, w: s.w || 1
  };
  if (s.retired) card.retired = true;
  if (s.nade) { nadeUp(card); card.desc = t('horde.cardDescNade', { desc: s.desc, nadeUp: NADE_UP }); }
  return card;
}

function build() {
  const out = [];
  for (const f of FAMILIES) out.push(...familyCards(f));
  for (const s of SPECIALS) out.push(specialCard(s));
  // 나중에 더한 카드는 맨 뒤(이미 있는 카드의 번호를 그대로 둔다)
  for (const a of ADDED) { if (a.vals) out.push(...familyCards(a)); else out.push(specialCard(a)); }
  return out.map((c, idx) => deepFreeze({ ...c, idx, instant: c.instant || null }));
}

/** 수류탄 증강: 최대 수류탄 +2와 고른 순간 가득 채우기를 붙인다 */
function nadeUp(card) {
  card.fx = { ...card.fx, nades: (card.fx.nades || 0) + NADE_UP_N };
  card.instant = { ...(card.instant || {}), nades: true };
  card.nade = true;
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

/** 카드 id 목록 → 능력치(상한 없이 더한다). 모르는 id는 건너뛴다 */
export function computePerks(ids) {
  const s = { ...PERK_BASE };
  for (const id of Array.isArray(ids) ? ids : []) {
    const c = cardById(id);
    if (!c) continue;
    for (const [k, v] of Object.entries(c.fx)) if (k in s) s[k] += v;
  }
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

/** 이 카드를 더 고를 수 있는가: 고를 수 있는 횟수(max)만 본다. 능력치에는 상한이 없다 */
export function cardAvailable(card, taken = []) {
  if (!card) return false;
  if (!card.max) return true;
  let n = 0;
  for (const id of taken) if (id === card.id) n++;
  return n < card.max;
}

/**
 * 카드 제안. 같은 입력이면 늘 같은 결과다(방장이 바뀌어도 스냅샷의 제안을 그대로 쓰지만, 시험에서 재현하기 위해).
 * { seed, playerId, stage, roll(다시 뽑은 횟수), round(이번 판의 몇 번째 제안), taken: 고른 카드 id들, count, exclude: 이번 제안에서 빼고 싶은 id들,
 *   high: 보물 상자 제안이면 true → 첫 장은 영웅 이상 }
 * → 카드 id 배열(겹치지 않는다).
 */
export function makeOffer({ seed = 1, playerId = '', stage = 1, roll = 0, round = 0, taken = [], count = 3, exclude = [], high = false } = {}) {
  const rng = makeRng(hashSeed(seed, playerId, stage, roll, round));
  const ex = new Set(exclude);
  const s = Math.max(1, stage | 0);
  const pool = CARDS.filter((c) => !c.retired && s >= c.minStage && !ex.has(c.id) && cardAvailable(c, taken));
  const chosen = [];
  const need = Math.max(1, Math.min(6, count | 0));
  const tierWeights = Object.values(TIERS).map((t) => ({ id: t.id, weight: t.weight * (t.id === 'legend' && s < 4 ? 0 : 1) }));
  let guard = 0;
  while (chosen.length < need && guard++ < 200) {
    const left = pool.filter((c) => !chosen.includes(c.id));
    if (!left.length) break;
    // 보물 상자 제안의 첫 장은 영웅 이상
    const forceHigh = !!high && chosen.length === 0;
    const tw = forceHigh ? tierWeights.filter((t) => t.id === 'epic' || t.id === 'legend') : tierWeights;
    const tier = pickWeighted(tw, rng);
    let cands = left.filter((c) => c.tier === (tier && tier.id));
    if (!cands.length) cands = left;
    // 같은 묶음(family) 카드가 한 제안에 두 장 나오지 않게
    const fams = new Set(chosen.map((id) => cardById(id).family));
    const fresh = cands.filter((c) => !fams.has(c.family));
    const list = fresh.length ? fresh : cands;
    // 같은 등급 안에서는 카드의 w(기본 1)만큼 나온다(무기 교체권은 아주 가끔)
    chosen.push(pickWeighted(list.map((c) => ({ id: c.id, weight: c.w || 1 })), rng).id);
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
  add(t('horde.perk.maxHp'), perkMaxHp(s) - 100, (v) => `${v > 0 ? '+' : '−'}${Math.abs(v)}`);
  add(t('horde.perk.dmg'), s.dmg, plus); add(t('horde.perk.head'), s.head, plus); add(t('horde.perk.bodyPenalty'), s.bodyPenalty, (v) => `−${Math.round(v * 100)}%`); add(t('horde.perk.boss'), s.boss, plus); add(t('horde.perk.normalPenalty'), s.normalPenalty, (v) => `−${Math.round(v * 100)}%`);
  add(t('horde.perk.fireRate'), s.fireRate, plus); add(t('horde.perk.reload'), s.reload, plus); add(t('horde.perk.mag'), s.mag, plus);
  add(t('horde.perk.reserve'), s.reserve, (v) => t('horde.perkVal.times', { v: fx(v) }));
  add(t('horde.perk.move'), s.move, plus); add(t('horde.perk.maxSpeed'), s.maxSpeed, plus);
  add(t('horde.perk.armor'), s.armor, (v) => `−${Math.round(v * 100)}%`); add(t('horde.perk.regen'), s.regen, (v) => t('horde.perkVal.perSec', { v: fx(v) }));
  add(t('horde.perk.lifesteal'), s.lifesteal, (v) => `${fx(v * 100)}%`); add(t('horde.perk.hitHeal'), s.hitHeal, (v) => `+${fx(v)}`); add(t('horde.perk.pierce'), s.pierce, (v) => `${v}`);
  add(t('horde.perk.nades'), s.nades, (v) => `+${v}`); add(t('horde.perk.nadeRadius'), s.nadeRadius, plus); add(t('horde.perk.nadeMulti'), s.nadeMulti, (v) => `+${v}`);
  add(t('horde.perk.throwCut'), s.throwCut, (v) => `-${Math.round(Math.min(0.9, v) * 100)}%`);
  add(t('horde.perk.nadeFire'), s.nadeFire, (v) => t('horde.perkVal.level', { v })); add(t('horde.perk.nadeFreeze'), s.nadeFreeze, (v) => t('horde.perkVal.level', { v })); add(t('horde.perk.nadeDecoy'), s.nadeDecoy, (v) => t('horde.perkVal.level', { v }));
  add(t('horde.perk.medDrop'), s.medDrop, plus); add(t('horde.perk.medHeal'), s.medHeal, (v) => `+${v}`);
  add(t('horde.perk.ammoDrop'), s.ammoDrop, plus); add(t('horde.perk.ammoMags'), s.ammoMags, (v) => t('horde.perkVal.loads', { v: fx(v) }));
  add(t('horde.perk.iframe'), s.iframe, (v) => t('horde.perkVal.sec', { v: fx(v) })); add(t('horde.perk.noKnock'), s.noKnock, () => t('horde.perkVal.none'));
  add('C4', s.stickyNade, () => t('horde.perkVal.sticky')); add(t('horde.perk.wave'), s.wave, (v) => `${fx(v)} m`); add(t('horde.perk.autoAim'), s.autoAim, () => t('horde.perkVal.autoAim'));
  add(t('horde.perk.reloadCut'), s.reloadCut, (v) => (v >= 1 ? t('horde.perkVal.instant') : `−${Math.round(v * 100)}%`)); add(t('horde.perk.guard'), s.guard, (v) => `−${Math.round(v * 100)}%`);
  add(t('horde.perk.airDmg'), s.airDmg, (v) => `+${Math.round(v * 100)}%`);
  add(t('horde.perk.sideMaster'), s.sideMaster, () => t('horde.perkVal.sideMaster'));
  add(t('horde.perk.reactive'), s.reactive, (v) => t('horde.perkVal.every', { v: fx(1 / v) }));
  return rows;
}
