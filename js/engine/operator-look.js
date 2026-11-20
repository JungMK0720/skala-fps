/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 대원 모델의 색과 부품 표(순수 데이터). 팀 색 층(전투복·강조), 대원별 장비 색, 대원마다 쓸 GLB 부품을 정한다.
 *          three.js에 의존하지 않아 node 테스트에서 아트 바이블(PRODUCT_PLAN.md 4.3·4.4) 값과 맞는지 바로 확인한다.
 */
/*
 * 부품 = [GLB 메시 이름, 재질 이름, 색 칸]. 메시 이름은 tools/models/build-operators.mjs가 만든 operators.glb의 이름이다.
 * 색 칸은 colorOf(look, team, slot)가 실제 색으로 바꾼다. 팀 색 칸은 uniform(어두운 팀 색)과 accent(밝은 팀 색) 두 개뿐이다.
 */
import { DEFAULT_AVATAR, avatarIdOf } from '../core/avatar-defs.js';

/** 팀 색 층(PRODUCT_PLAN.md 4.3). owner = 블루, charterer = 레드 */
export const TEAM_LOOK = Object.freeze({
  owner: Object.freeze({ uniform: '#2B3A55', accent: '#3F8CFF' }),
  charterer: Object.freeze({ uniform: '#5A2A2E', accent: '#FF4F5E' })
});

/** 장비 색(대원마다 하나). 검정·코요테·올리브·모래·짙은 회색 */
export const GEAR_COLORS = Object.freeze({
  black: '#1F2125',
  coyote: '#7B6449',
  olive: '#4C5338',
  sand: '#A48D62',
  darkGray: '#3B4045'
});

/** 팀·대원과 상관없는 색 */
export const FIXED_COLORS = Object.freeze({
  skin: '#C99272', brow: '#3A2A20', eye: '#16130F', visor: '#1B2A36', boot: '#24221F', glove: '#2A2B2D'
});

/** 몸(모든 대원 같음): SWAT 다리·발·몸통·손 */
export const BODY_PARTS = Object.freeze([
  ['Swat_Legs', 'Swat', 'uniform'],
  ['Swat_Legs', 'Swat_Black', 'gear'],
  ['Swat_Feet', 'Swat_Black', 'boot'],
  ['Swat_Body', 'Swat', 'uniform'],
  ['Swat_Body', 'Swat_Black', 'gear'],
  ['Swat_Body', 'Skin', 'glove']
]);

/** 머리 부품 묶음 */
export const HEAD_PARTS = Object.freeze({
  swat: Object.freeze([['Swat_Head', 'Swat', 'mask'], ['Swat_Head', 'Swat_Black', 'helmet'], ['Swat_Head', 'Visor', 'visor']]),
  bare: Object.freeze([['Bare_Head', 'Bare_Head_Skin', 'skin'], ['Bare_Head', 'Bare_Head_Eyebrows', 'brow'], ['Bare_Head', 'Bare_Head_Eye', 'eye']]),
  // 복면: 맨머리를 검게 칠하고 눈 둘레만 살색으로 둔다(눈썹은 복면 안이라 뺀다)
  balaclava: Object.freeze([['Bare_Head', 'Bare_Head_Skin', 'balaclava'], ['Bare_Head', 'Bare_Head_Eye', 'eye']])
});

/** 모자 부품 묶음(같은 팩의 다른 인물에서 가져온 것) */
export const HAT_PARTS = Object.freeze({
  hardhat: Object.freeze([['Hardhat', 'Hardhat_Worker_Yellow', 'hat']]),
  brim: Object.freeze([['Brim_Hat', 'Brim_Hat_Beige', 'hat'], ['Brim_Hat', 'Brim_Hat_Red', 'accent']])
});

/**
 * 대원 7명(PRODUCT_PLAN.md 4.4). head·hat = GLB 부품, gear = 장비 색, kit = engine/operator-gear.js의 직접 만든 장비 묶음 이름.
 * hat·mask·helmet 색은 장비 색과 다를 때만 적는다.
 */
export const OPERATOR_LOOK = Object.freeze({
  av_trooper: Object.freeze({ head: 'swat', hat: null, gear: 'black', kit: 'trooper', mask: '#26292E', helmet: '#2C3036' }),
  av_scout: Object.freeze({ head: 'bare', hat: null, gear: 'olive', kit: 'scout' }),
  av_sapper: Object.freeze({ head: 'bare', hat: 'hardhat', gear: 'coyote', kit: 'sapper', hatColor: '#B9A27C' }),
  av_signal: Object.freeze({ head: 'bare', hat: null, gear: 'olive', kit: 'signal' }),
  av_ranger: Object.freeze({ head: 'bare', hat: 'brim', gear: 'sand', kit: 'ranger', hatColor: '#B49C6E' }),
  av_night: Object.freeze({ head: 'balaclava', hat: null, gear: 'black', kit: 'night' }),
  av_heavy: Object.freeze({ head: 'bare', hat: null, gear: 'darkGray', kit: 'heavy' })
});

export const OPERATOR_IDS = Object.freeze(Object.keys(OPERATOR_LOOK));

/** 대원 id → 모양(모르는 id는 기본 대원) */
export function lookOf(id) { return OPERATOR_LOOK[avatarIdOf(id)] || OPERATOR_LOOK[DEFAULT_AVATAR]; }

/** 팀 id → 팀 색 층(모르는 팀은 블루) */
export function teamLookOf(team) { return TEAM_LOOK[team] || TEAM_LOOK.owner; }

/** 대원 모양이 쓰는 GLB 부품 목록 */
export function partsOf(look) {
  return [...BODY_PARTS, ...HEAD_PARTS[look.head], ...(look.hat ? HAT_PARTS[look.hat] : [])];
}

/** 색 칸 → '#RRGGBB'. balaclava는 장비 색(검정)이고 눈 둘레는 그리는 쪽이 skin으로 칠한다 */
export function colorOf(look, team, slot) {
  const T = teamLookOf(team);
  switch (slot) {
    case 'uniform': return T.uniform;
    case 'accent': return T.accent;
    case 'gear': case 'balaclava': return GEAR_COLORS[look.gear];
    case 'hat': return look.hatColor || GEAR_COLORS[look.gear];
    case 'mask': return look.mask || GEAR_COLORS[look.gear];
    case 'helmet': return look.helmet || GEAR_COLORS[look.gear];
    default: return FIXED_COLORS[slot] || GEAR_COLORS[look.gear];
  }
}
