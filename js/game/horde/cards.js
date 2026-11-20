/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 좀비 물량 막기의 증강(강화 카드, 180장 넘게). 팀 레벨이 오르거나 보스의 보물 상자를 주우면 3장(증강으로 4장까지)을 제안하고
 *          제안마다 다시 뽑기 1번을 준다. 카드 목록 → 능력치 계산(상한 없음, 한 장 카드는 고를 수 있는 횟수만), 제안 만들기, 짧은 글자로 싣기를 맡는다.
 *          순수 모듈이라 방장·화면·node 시험이 같이 쓴다. 수류탄을 키우는 증강은 모두 최대 수류탄을 2개 늘리고 가득 채운다.
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
  sideMaster: 0    // HC 1이면 주무기를 못 쓰고 보조무기 연사 2배 · 피해 +500% · 탄창 2배
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
  { key: 'hp', name: '튼튼한 몸', icon: '❤️', stat: 'maxHp', vals: [15, 25, 40, 60], text: (v) => `최대 체력 +${v} (그만큼 바로 회복)`, instant: (v) => ({ heal: v }) },
  { key: 'regen', name: '재생', icon: '💚', stat: 'regen', vals: [0.8, 1.5, 2.5, 4], text: (v) => `초당 체력 ${fx(v)} 회복` },
  { key: 'leech', name: '흡혈', icon: '🩸', stat: 'lifesteal', vals: [0.001, 0.002, 0.003, 0.004], text: (v) => `준 피해의 ${fx(v * 100)}%만큼 체력 회복` },
  { key: 'armor', name: '방탄복', icon: '🦺', stat: 'armor', vals: [0.05, 0.1, 0.15, 0.2], text: (v) => `받는 피해 −${pc(v)}` },
  { key: 'ration', name: '전투 식량', icon: '🍖', stat: 'killHeal', vals: [3, 6, 9, 12], text: (v) => `좀비를 처치할 때마다 체력 +${v}` },
  { key: 'power', name: '화력', icon: '💥', stat: 'dmg', vals: [0.1, 0.2, 0.3, 0.4], text: (v) => `모든 피해 +${pc(v)}` },
  { key: 'head', name: '정밀 사격', icon: '🎯', stat: 'head', vals: [0.24, 0.4, 0.64, 1], text: (v) => `머리 피해 +${pc(v)}` },
  { key: 'boss', name: '보스 사냥꾼', icon: '👑', stat: 'boss', vals: [0.1, 0.18, 0.28, 0.42], text: (v) => `보스에게 주는 피해 +${pc(v)}` },
  { key: 'blade', name: '칼잡이', icon: '🔪', stat: 'melee', vals: [0.2, 0.35, 0.55, 0.9], text: (v) => `칼 피해 +${pc(v)}` },
  { key: 'demo', name: '폭파병', icon: '🧨', stat: 'nade', vals: [0.18, 0.3, 0.48, 0.75], text: (v) => `수류탄 피해 +${pc(v)} · ${NADE_UP}`, nade: true },
  { key: 'trigger', name: '방아쇠', icon: '⚡', stat: 'fireRate', vals: [0.06, 0.1, 0.15, 0.22], text: (v) => `연사 속도 +${pc(v)}` },
  // 재장전 시간 −50%, 최대 2번(번호가 밀리지 않게 II~IV 자리는 남기고 제안에서만 뺀다). 두 번이면 재장전이 거의 즉시다(탄은 그대로 줄어든다)
  { key: 'hands', name: '빠른 손', icon: '🔄', stat: 'reloadCut', vals: [0.5, 0.5, 0.5, 0.5], text: () => '재장전 시간 −50% (최대 2번 · 두 번 고르면 재장전이 거의 즉시, 탄은 그대로 줄어든다)', minTier: 2, only: 1, max: 2, retire: [1, 2, 3] },
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
  // 걷는 속도(move)와 버니합 상한(maxSpeed)이 같은 비율로 함께 오른다
  { key: 'limit', name: '가속 한계', icon: '🚀', stat: 'maxSpeed', also: 'move', vals: [0.08, 0.14, 0.22, 0.35], text: (v) => `걷는 속도 +${pc(v)} · 최대 속도(버니합 상한)도 +${pc(v)}` },
  { key: 'leap', name: '도약', icon: '🦘', stat: 'jump', vals: [0.09, 0.14, 0.21, 0.3], text: (v) => `점프 높이 +${pc(v)}` },
  { key: 'pouch', name: '수류탄 주머니', icon: '💣', stat: 'nades', vals: [5, 6, 8, 10], text: (v) => `최대 수류탄 +${v} (가득 채움)`, instant: () => ({ nades: true }) },
  { key: 'medic', name: '구급 보급', icon: '🩹', stat: 'medDrop', vals: [0.04, 0.06, 0.09, 0.15], text: (v) => `내가 잡은 좀비가 구급 상자를 떨어뜨릴 확률 +${pc(v)} (기본 5%)` },
  { key: 'kit', name: '구급 키트', icon: '🧪', stat: 'medHeal', vals: [5, 8, 12, 18], text: (v) => `구급 상자 회복량 +${v} (기본 10)` },
  { key: 'supply', name: '탄약 보급', icon: '🎒', stat: 'ammoDrop', vals: [0.04, 0.06, 0.09, 0.15], text: (v) => `내가 잡은 좀비가 탄창을 떨어뜨릴 확률 +${pc(v)} (기본 10%)` },
  // 탄창을 주우면 모든 총이 가득 차므로 더 받을 것이 없어 네 단계 모두 제안에서 뺀다(전송 번호는 그대로)
  { key: 'belt', name: '탄띠', icon: '🎗️', stat: 'ammoMags', vals: [1, 1.5, 2, 3], text: (v) => `주운 탄창이 장전 ${fx(v)}회분 더 (기본 1회분)`, retire: [1, 2, 3, 4] },
  { key: 'blast', name: '폭발 반경', icon: '🌋', stat: 'nadeRadius', vals: [0.3, 0.45, 0.63, 0.88], text: (v) => `수류탄 폭발 반경 +${pc(v)} · ${NADE_UP}`, nade: true },
  // 무제한 관통(한 장). 예전 I~IV 중 I 자리를 이 카드로 바꾸고 II~IV는 제안에서만 뺀다
  { key: 'pierce', name: '관통탄', icon: '🗡️', stat: 'pierce', vals: [99, 99, 99, 99], text: () => '탄이 좀비를 모두 뚫는다(뚫을 때마다 피해 70%, 최소 30%)', minTier: 2, only: 1, max: 1, retire: [1, 2, 3] },
  { key: 'scav', name: '탄약 회수', icon: '♻️', stat: 'killAmmo', vals: [1, 1, 2, 3], text: (v) => `처치할 때마다 탄창에 탄 ${v}발 돌려받기` },
  { key: 'weak', name: '약점 포착', icon: '🔍', stat: 'crit', vals: [0.04, 0.07, 0.11, 0.16], text: (v) => `${pc(v)} 확률로 치명타(피해 ×1.5)` },
  { key: 'wound', name: '치명상', icon: '🩹', stat: 'critDmg', vals: [0.2, 0.35, 0.55, 0.8], text: (v) => `치명타 피해 +${pc(v)}` },
  { key: 'frost', name: '냉각탄', icon: '❄️', stat: 'slow', vals: [0.08, 0.12, 0.18, 0.25], text: (v) => `맞은 좀비가 1초 동안 ${pc(v)} 느려짐 (냉각이 25%를 넘게 겹치면 시간도 그만큼 늘어남)` },
  // 폭발 반응 장갑(예전 가시 갑옷 자리, id thorn1~4 그대로). 값 = 초당 터지는 횟수: 4 · 3 · 2 · 1초에 한 번, 겹치면 더해져 더 자주
  { key: 'thorn', name: '폭발 반응 장갑', icon: '☄️', stat: 'reactive', vals: [0.25, 1 / 3, 0.5, 1], text: (v) => `좀비·보스에게 맞으면 내 자리에서 수류탄이 터진다(수류탄 피해·폭발 반경·수류탄 효과 적용, ${fx(1 / v)}초에 한 번, 겹치면 더 자주)` },
  { key: 'dodge', name: '회피', icon: '💨', stat: 'dodge', vals: [0.03, 0.05, 0.08, 0.12], text: (v) => `${pc(v)} 확률로 피해를 피함` },
  { key: 'exec', name: '처형자', icon: '⚔️', stat: 'executioner', vals: [0.38, 0.63, 1, 1.5], text: (v) => `체력 25% 이하 좀비에게 피해 +${pc(v)}` },
  { key: 'last', name: '배수의 진', icon: '🔥', stat: 'lastStand', vals: [0.25, 0.42, 0.67, 1], text: (v) => `내 체력이 35% 이하일 때 피해 +${pc(v)}` },
  { key: 'rest', name: '휴식', icon: '🛌', stat: 'stageHeal', vals: [0.25, 0.38, 0.63, 1], text: (v) => `스테이지가 시작할 때 최대 체력의 ${pc(v)} 회복` },
  { key: 'shield', name: '보호막', icon: '🛡️', stat: 'shield', vals: [30, 50, 80, 120], text: (v) => `스테이지가 시작할 때 보호막 +${v} (남은 보호막에 더해진다)` },
  { key: 'forge', name: '탄약 제조', icon: '🏭', stat: 'ammoRegen', vals: [0.02, 0.04, 0.06, 0.09], text: (v) => `1초마다 탄창 크기의 ${pc(v)}만큼 재장전 탄창 회복` },
  { key: 'frenzy', name: '광란', icon: '🌀', stat: 'frenzy', vals: [0.004, 0.005, 0.0075, 0.01], text: (v) => `총으로 좀비를 맞힐 때마다 7초 동안 연사 +${+(v * 100).toFixed(2)}% (최대 300번 겹침)` }
];

/** 수류탄을 키우는 증강에 붙는 말(최대 수류탄 +2, 가득 채움) */
const NADE_UP = '최대 수류탄 +2 (가득 채움)';
/** 수류탄 증강 하나가 늘리는 최대 수류탄 수 */
const NADE_UP_N = 2;

/**
 * 한 장뿐인 특수 카드. fx = 능력치 변화(여러 개 가능), instant = 고른 순간 한 번만 일어나는 일, max = 고를 수 있는 횟수(없으면 무제한).
 * nade: true면 수류탄 증강이라 최대 수류탄 +2와 가득 채움이 붙는다.
 */
const SPECIALS = [
  { key: 'second', name: '두 번째 기회', icon: '🪽', tier: 'legend', max: 1, fx: { secondChance: 1 }, desc: '스테이지마다 한 번, 쓰러질 피해를 받아도 체력 30%로 버틴다', minStage: 3 },
  { key: 'glass', name: '유리 대포', icon: '🔮', tier: 'epic', max: 1, fx: { dmg: 0.5, maxHpPct: -0.2 }, desc: '모든 피해 +50% · 최대 체력 −20%' },
  { key: 'wall', name: '철벽', icon: '🧱', tier: 'epic', max: 1, fx: { maxHpPct: 1, fireRate: -0.2 }, desc: '최대 체력 +100% · 연사 속도 −20%' },
  { key: 'chain', name: '연쇄 폭발', icon: '🎆', tier: 'legend', max: 2, fx: { explosive: 0.25 }, desc: '처치한 좀비가 터져 3 m 안의 좀비에게 그 좀비 최대 체력의 25% 피해', minStage: 4 },
  { key: 'luck', name: '행운', icon: '🍀', tier: 'rare', max: 3, fx: { rerolls: 1 }, desc: '카드 제안마다 다시 뽑기 +1' },
  { key: 'wide', name: '넓은 선택', icon: '🃏', tier: 'epic', max: 1, fx: { offers: 1 }, desc: '카드 제안이 4장으로 늘어난다' },
  { key: 'medkit', name: '응급 처치', icon: '🚑', tier: 'common', instant: { healPct: 1 }, desc: '체력을 가득 회복' },
  { key: 'syringe', name: '회복 주사', icon: '💉', tier: 'common', instant: { healPct: 0.5 }, fx: { regen: 0.5 }, desc: '체력 50% 회복 · 초당 체력 0.5 회복' },
  { key: 'drop', name: '보급 투하', icon: '🪂', tier: 'rare', max: 1, desc: '스테이지마다 든 총들의 탄창·예비 탄과 수류탄을 모두 가득 채운다' },
  { key: 'hunter', name: '사냥 본능', icon: '🐺', tier: 'rare', fx: { dmg: 0.24, move: 0.12 }, desc: '모든 피해 +24% · 이동 속도 +12%' },
  { key: 'thrift', name: '탄약 절약', icon: '🪙', tier: 'epic', max: 2, fx: { thrift: 0.45 }, desc: '45% 확률로 쏴도 탄이 줄지 않는다 (두 번 고르면 90%)' },
  { key: 'perfect', name: '완벽주의자', icon: '💎', tier: 'epic', max: 1, fx: { head: 3, bodyPenalty: 0.9 }, desc: '머리 피해 +300% · 몸·팔다리 총 피해 −90%' },
  { key: 'giant', name: '거인 학살자', icon: '🗿', tier: 'epic', max: 1, fx: { boss: 3, normalPenalty: 0.5 }, desc: '보스 피해 +300% · 일반 좀비 피해 −50%' },
  { key: 'thirst', name: '피의 갈증', icon: '🧛', tier: 'epic', fx: { hitHeal: 0.3, killHeal: 2 }, desc: '맞힐 때마다 체력 +0.3 · 처치마다 체력 +2' },
  { key: 'runngun', name: '기동 사격', icon: '🏃', tier: 'rare', fx: { spread: 0.3, move: 0.18 }, desc: '탄퍼짐 −30% · 이동 속도 +18%' },
  { key: 'drum', name: '드럼 탄창', icon: '🥁', tier: 'epic', fx: { mag: 0.6, reload: -0.1 }, desc: '최대 탄창 +60% · 재장전 속도 −10%' },
  { key: 'samurai', name: '무사도', icon: '🏯', tier: 'epic', fx: { melee: 0.8, move: 0.05 }, desc: '칼 피해 +80% · 이동 속도 +5%' },
  { key: 'iron', name: '불굴', icon: '⛓️', tier: 'epic', fx: { armor: 0.12, regen: 0.5 }, desc: '받는 피해 −12% · 초당 체력 0.5 회복' },
  { key: 'tactical', name: '전술 재장전', icon: '🧷', tier: 'rare', fx: { reload: 0.25, mag: 1 }, desc: '재장전 속도 +25% · 최대 탄창 +100%' },
  { key: 'react', name: '연쇄 반응', icon: '☢️', tier: 'epic', fx: { explosive: 0.12, nade: 0.25 }, desc: '처치 폭발 +12% · 수류탄 피해 +25%', minStage: 4, nade: true },
  { key: 'dread', name: '공포 그 자체', icon: '👹', tier: 'rare', fx: { slow: 0.12, reactive: 0.25 }, desc: '냉각 +12% · 좀비·보스에게 맞으면 4초에 한 번 내 자리에서 수류탄이 터진다' },
  { key: 'coin', name: '행운의 동전', icon: '🪙', tier: 'rare', fx: { crit: 0.08, dodge: 0.04 }, desc: '치명타 +8% · 회피 +4%' },
  { key: 'adrenaline', name: '아드레날린', icon: '💓', tier: 'legend', fx: { fireRate: 0.5, move: 0.3, lastStand: 1 }, desc: '연사 +50% · 이동 +30% · 체력 35% 이하일 때 피해 +100%', minStage: 4 },
  { key: 'bunker', name: '벙커', icon: '🏚️', tier: 'legend', fx: { armor: 0.45, shield: 100 }, desc: '받는 피해 −45% · 스테이지마다 보호막 +100', minStage: 4 },
  // 수류탄 증강: 효과는 내 수류탄 모두에 겹쳐 붙는다(화염 + 빙결 + 분신을 함께 가질 수 있다)
  { key: 'fireNade', name: '화염 수류탄', icon: '🔥', tier: 'epic', max: 3, fx: { nadeFire: 1 }, desc: '내 수류탄이 터진 자리에 5초 동안 불길이 남아 안의 좀비에게 계속 피해(겹칠수록 세다)', nade: true },
  { key: 'iceNade', name: '빙결 수류탄', icon: '🧊', tier: 'epic', max: 3, fx: { nadeFreeze: 1 }, desc: '내 수류탄에 맞은 좀비가 2.2초 동안 얼어붙는다(보스는 절반 · 겹칠수록 오래)', nade: true },
  { key: 'decoyNade', name: '어그로 수류탄', icon: '🎭', tier: 'epic', max: 3, fx: { nadeDecoy: 1 }, desc: '터진 자리에 내 최대 체력만큼 버티는 분신이 9초 동안 서서 30 m 안의 좀비를 끌어모은다', nade: true },
  { key: 'multiNade', name: '다연발 투척', icon: '🎇', tier: 'rare', max: 4, fx: { nadeMulti: 1 }, desc: '한 번 던질 때 수류탄이 부채꼴로 1개 더 날아간다(여러 번 고르면 더 많이 · 하나만 줄어든다)', nade: true },
  // 무기는 1스테이지 전에만 고르므로, 판 중간에 총을 바꾸는 길은 이 증강뿐이다. 아주 가끔 나온다(w = 같은 등급 안에서 나올 비율)
  { key: 'rearm', name: '무기 교체권', icon: '🔁', tier: 'rare', w: 1.2, retired: true, instant: { swap: true }, desc: '무기 목록이 열려 아무 무기로 한 번 바꿀 수 있다(새로 든 총은 탄을 가득 받는다)' },
  // 보조무기를 폭발 무기로 바꾸는 증강(낮은 확률). 쓰러졌다 일어나도 그대로다. 나중에 고른 쪽으로 바뀐다
  { key: 'sideGl', name: '유탄 발사기', icon: '🧨', tier: 'epic', w: 2, max: 1, instant: { side: 'gl_m32' }, desc: '보조무기가 GL-6 유탄 발사기로 바뀐다(맞은 자리에서 터지는 유탄 6발 · 예비 18발)' },
  { key: 'sideRl', name: '바주카포', icon: '🚀', tier: 'legend', w: 5, max: 1, minStage: 3, instant: { side: 'rl_b9' }, desc: '보조무기가 BZ-9 바주카포로 바뀐다(곧게 날아가 크게 터지는 로켓 · 한 발씩 · 예비 12발)' }
];

/**
 * 나중에 더한 카드. 전송 번호(idx)는 카드 순서라서, 이미 있는 카드의 번호가 바뀌지 않게 모든 묶음·특수 카드 뒤에 붙인다.
 * vals가 있으면 묶음(FAMILIES와 같은 모양), 없으면 특수 카드(SPECIALS와 같은 모양)다. 새 카드는 이 목록 끝에만 더한다.
 */
const ADDED = [
  { key: 'reflex', name: '반사 신경', icon: '✨', stat: 'iframe', vals: [0.2, 0.3, 0.4, 0.5], text: (v) => `맞은 뒤 무적 시간 +${fx(v)}초 (기본 0.1초)` },
  // 검기: 전설 한 장(IV)만 제안에 나온다. I~III은 번호만 남긴다(예전 기록·전송을 읽게). 우클릭 찌르기만 · 10 m · 좀비 한 마리
  { key: 'wave', name: '검기', icon: '🌙', stat: 'wave', vals: [10, 10, 10, 10], only: true, max: 1, retire: [0, 1, 2], text: (v) => `칼로 우클릭 찌르기를 할 때 검기가 ${v} m 날아가 처음 닿는 좀비 한 마리에게 칼과 같은 피해 (좌클릭 베기에는 검기 없음)` },
  { key: 'anchor', name: '부동자세', icon: '⚓', tier: 'epic', max: 1, fx: { noKnock: 1 }, desc: '맞아도 밀려나지 않는다(보스의 밀치기·내려찍기도)' },
  { key: 'c4', name: 'C4 수류탄', icon: '🧲', tier: 'epic', max: 1, fx: { stickyNade: 1 }, nade: true, desc: '내 수류탄이 C4로 바뀐다. 좀비에 닿으면 그 몸에 붙어 따라가다 터진다' },
  { key: 'shieldKnife', name: '방패 칼', icon: '🛡️', tier: 'epic', max: 1, fx: { guard: 0.45 }, desc: '칼을 들면 방패를 함께 든다. 앞에서 때리는 공격의 피해 −45% (총·수류탄을 들면 방패를 내린다)' },
  { key: 'airStrike', name: '공중 강타', icon: '🦅', tier: 'epic', max: 1, fx: { airDmg: 5 }, desc: '점프로 공중에 떠 있는 동안 총·칼 피해 +500%' },
  // 보조무기를 중력건으로 바꾸는 증강(낮은 확률). 쏘면 앞쪽에서 중력이 생겨 좀비를 한 점으로 끌어 뭉친다
  { key: 'sideGravity', name: '중력건', icon: '🌀', tier: 'epic', w: 2, max: 1, minStage: 2, instant: { side: 'gv_gun' }, desc: '보조무기가 GV-1 중력건으로 바뀐다(쏘면 앞쪽에 중력이 생겨 좀비가 한곳으로 뭉친다 · 맞히지는 못한다)' },
  { key: 'flameGun', name: '화염 방사기', icon: '🔥', tier: 'legend', max: 1, minStage: 3,
    instant: { primary: 'fl_horde' }, desc: '주무기가 FL-12 화염 방사기로 바뀐다(12 m 화염 5갈래 · 연료 100 · 연속 분사)' },
  { key: 'railGun', name: '레일건', icon: '⚡', tier: 'legend', max: 1, minStage: 3,
    instant: { primary: 'rg_horde' }, desc: '주무기가 RG-5 레일건으로 바뀐다(몸 400 · 머리 800 · 5발 탄창 · 1.5초마다 사격)' },
  { key: 'aiGlasses', name: 'AI 안경', icon: '🥽', tier: 'legend', max: 1, minStage: 3,
    fx: { autoAim: 1 }, desc: '안경을 쓰고 총을 쏘면 앞쪽 조준 원뿔 안에 있는 좀비의 몸통을 자동 조준한다' },
  { key: 'sideMaster', name: '보조무기 마스터', icon: '🔫', tier: 'legend', max: 1, minStage: 3,
    fx: { sideMaster: 1 }, desc: '주무기를 더 쓸 수 없다. 대신 보조무기 발사 속도 2배 · 피해 +500% · 최대 탄창 2배' },
  // 제우스의 번개(요청 2026-11-20): 주무기가 번개를 던지는 무기로 바뀐다. 맞으면 근처 좀비로 다섯 번 튀고 피해가 줄지 않는다
  { key: 'zeus', name: '제우스의 번개', icon: '🌩️', tier: 'legend', max: 1, minStage: 3,
    instant: { primary: 'zs_bolt' }, desc: '주무기가 제우스의 번개로 바뀐다(던진 번개가 맞으면 근처 좀비로 5번 튄다 · 튈 때마다 피해 그대로 150 · 탄약 무제한)' },
  // 야스오의 검(요청 2026-11-20): 좌·우클릭이 같은 칼 판정 찌르기. 두 번 맞히면 다음 공격이 회오리, 회오리가 보스에 닿으면 공중 연타
  { key: 'yasuoSword', name: '야스오의 검', icon: '🌪️', tier: 'legend', max: 1, minStage: 3,
    instant: { melee: 'ml_yasuo' }, desc: '칼이 야스오의 검으로 바뀐다. 좌·우클릭 같은 찌르기(0.7초 간격). 2번 맞히면(10초 유지) 다음 공격은 빗나가도 앞으로 회오리를 날려 맞은 적을 띄우고 기절시킨다. 회오리가 보스를 맞히면 보스 뒤로 순간이동해 2초 동안 무적으로 공중 연타(칼 피해 총 10배) 후 떨어진다' }
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
  if (s.nade) { nadeUp(card); card.desc = `${s.desc} · ${NADE_UP}`; }
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
  add('최대 체력', perkMaxHp(s) - 100, (v) => `${v > 0 ? '+' : '−'}${Math.abs(v)}`);
  add('피해', s.dmg, plus); add('머리', s.head, plus); add('몸 총 피해', s.bodyPenalty, (v) => `−${Math.round(v * 100)}%`); add('보스', s.boss, plus); add('일반 좀비 피해', s.normalPenalty, (v) => `−${Math.round(v * 100)}%`);
  add('연사', s.fireRate, plus); add('재장전', s.reload, plus); add('탄창', s.mag, plus);
  add('재장전 탄창', s.reserve, (v) => `+${fx(v)}배`);
  add('이동', s.move, plus); add('최대 속도', s.maxSpeed, plus);
  add('방어', s.armor, (v) => `−${Math.round(v * 100)}%`); add('회복', s.regen, (v) => `${fx(v)}/초`);
  add('흡혈', s.lifesteal, (v) => `${fx(v * 100)}%`); add('타격 회복', s.hitHeal, (v) => `+${fx(v)}`); add('관통', s.pierce, (v) => `${v}`);
  add('수류탄', s.nades, (v) => `+${v}`); add('폭발 반경', s.nadeRadius, plus); add('한 번에 던지기', s.nadeMulti, (v) => `+${v}`);
  add('화염', s.nadeFire, (v) => `${v}단계`); add('빙결', s.nadeFreeze, (v) => `${v}단계`); add('분신', s.nadeDecoy, (v) => `${v}단계`);
  add('구급 상자 확률', s.medDrop, plus); add('구급 상자 회복', s.medHeal, (v) => `+${v}`);
  add('탄창 확률', s.ammoDrop, plus); add('탄창 양', s.ammoMags, (v) => `+${fx(v)}회분`);
  add('맞은 뒤 무적', s.iframe, (v) => `+${fx(v)}초`); add('밀려남', s.noKnock, () => '없음');
  add('C4', s.stickyNade, () => '붙음'); add('검기', s.wave, (v) => `${fx(v)} m`); add('AI 안경', s.autoAim, () => '몸통 자동 조준');
  add('재장전 시간', s.reloadCut, (v) => (v >= 1 ? '거의 즉시' : `−${Math.round(v * 100)}%`)); add('방패', s.guard, (v) => `−${Math.round(v * 100)}%`);
  add('공중 피해', s.airDmg, (v) => `+${Math.round(v * 100)}%`);
  add('보조무기 마스터', s.sideMaster, () => '주무기 봉인 · 보조 연사 2배 · 피해 +500% · 탄창 2배');
  add('반응 장갑', s.reactive, (v) => `${fx(1 / v)}초에 한 번`);
  return rows;
}
