/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 포인트 규칙(순수 함수). docs/DESIGN.md 7절의 표를 데이터로 두고 경기 보상과 비밀 스팟 보상을 계산한다.
 *          개인전 승리 보상은 목표 킬에 비례해 줄인다(20킬 판이 표의 값 전부).
 *          가격은 weapons/defs.js(무기), core/consts.js EMOTES(이모트), core/avatar-defs.js AVATARS(캐릭터)가 정본이다. 값이 바뀌면 서버 가격표(supabase/schema.sql)와 설계 문서를 함께 고친다.
 */
import { WEAPON_IDS, getDef } from '../weapons/defs.js';
import { EMOTE_IDS, emoteById } from '../core/consts.js';
import { AVATAR_IDS, avatarById, isAvatarId } from '../core/avatar-defs.js';
import { FFA_KILLS } from '../game/modes.js';

export const START_POINTS = 500;
/** supabase/schema.sql의 fps_save_profile과 같은 상한 */
export const MAX_POINTS = 10000000;
export const SECRET_POINTS_DEFAULT = 100;

export const MATCH_POINTS = Object.freeze({
  bot: Object.freeze({ kill: 5, headshot: 3, win: 30, finish: 10 }),
  multi: Object.freeze({ kill: 10, headshot: 5, win: 60, finish: 20 })
});

/** 봇전에만 적용한다 */
export const DIFFICULTY_BONUS = Object.freeze({
  easy: Object.freeze({ label: '쉬움', mul: 0.7 }),
  normal: Object.freeze({ label: '보통', mul: 1 }),
  hard: Object.freeze({ label: '어려움', mul: 1.4 })
});

function count(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * 개인전 승리 보상이 표의 값 전부가 되는 목표 킬. 이보다 짧은 판은 목표 킬에 비례해 줄인다(10킬 판은 절반, 5킬 판은 1/4).
 * 이보다 긴 판(연습장 주소 값 killtarget, 최대 50킬)은 늘리지 않는다.
 */
export const FFA_FULL_WIN_KILLS = FFA_KILLS.max;

/**
 * 경기 summary를 안전한 값으로 읽는다. 숫자가 아니거나 음수면 0, 모르는 난이도는 normal, 무승부는 승리가 아니다.
 * knifeKills는 DESIGN의 summary에 없는 선택 필드로, 넘겨 주면 전적에 쌓인다.
 * killTarget은 개인전(mode 'ffa')에서만 읽는다. 없으면 0이고 승리 보상을 줄이지 않는다(목표 킬을 싣지 않던 예전 기록).
 */
export function readSummary(summary) {
  const s = summary && typeof summary === 'object' ? summary : {};
  const draw = !!s.draw;
  const ffa = s.mode === 'ffa';
  return {
    online: !!s.online,
    mode: ffa || s.mode === 'bomb' ? s.mode : 'team',
    killTarget: ffa ? count(s.killTarget) : 0,
    difficulty: Object.prototype.hasOwnProperty.call(DIFFICULTY_BONUS, s.difficulty) ? s.difficulty : 'normal',
    kills: count(s.kills),
    deaths: count(s.deaths),
    headshots: count(s.headshots),
    halfShots: count(s.halfShots),
    knifeKills: count(s.knifeKills),
    win: !!s.win && !draw,
    draw,
    seconds: count(Math.round(Number(s.seconds)))
  };
}

/** → { gained, breakdown: [{ label, points }] }. breakdown의 합은 항상 gained와 같다. */
export function matchReward(summary) {
  const s = readSummary(summary);
  const table = s.online ? MATCH_POINTS.multi : MATCH_POINTS.bot;
  const breakdown = [];
  const add = (label, points) => { if (points !== 0) breakdown.push({ label, points }); };

  add(`킬 ×${s.kills}`, s.kills * table.kill);
  add(`헤드샷 ×${s.headshots}`, s.headshots * table.headshot);
  if (s.win) {
    // 목표 킬이 짧은 개인전은 승리 보상을 비례해 줄인다. 5킬보다 작은 값은 5킬로 본다(믿을 수 없는 값이 보상을 0으로 만들지 않게)
    const k = s.killTarget ? Math.min(FFA_FULL_WIN_KILLS, Math.max(FFA_KILLS.min, s.killTarget)) : FFA_FULL_WIN_KILLS;
    add(k < FFA_FULL_WIN_KILLS ? `승리(${k}킬 판)` : '승리', Math.round((table.win * k) / FFA_FULL_WIN_KILLS));
  }
  add('완주', table.finish);

  const subtotal = breakdown.reduce((sum, row) => sum + row.points, 0);
  let gained = subtotal;
  if (!s.online) {
    const { label, mul } = DIFFICULTY_BONUS[s.difficulty];
    // 0.7 같은 소수를 바로 곱하면 24.5가 24.499…가 되어 반올림이 어긋난다. 정수 백분율로 계산한다.
    gained = Math.round((subtotal * Math.round(mul * 100)) / 100);
    add(`난이도 ${label} ×${mul}`, gained - subtotal);
  }
  return { gained, breakdown };
}

/** 비밀 스팟 첫 발견 보상. 맵에 적힌 값, 없으면 기본값. */
export function secretReward(secret) {
  const n = secret && secret.points;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : SECRET_POINTS_DEFAULT;
}

/** 상점 물건 id: 무기 → 이모트 → 캐릭터. 프로필의 owned는 이 순서로 정리한다 */
export const ITEM_IDS = Object.freeze([...WEAPON_IDS, ...EMOTE_IDS, ...AVATAR_IDS]);

export { isAvatarId };

/** 이모트 id인가(번호는 아니다) */
export function isEmoteId(id) {
  return typeof id === 'string' && EMOTE_IDS.includes(id);
}

/** 무기·이모트·캐릭터 가격. 모르는 물건은 null. */
export function priceOf(id) {
  const def = getDef(id);
  if (def) return Math.max(0, Number(def.price) || 0);
  const e = isEmoteId(id) ? emoteById(id) : isAvatarId(id) ? avatarById(id) : null;
  return e ? Math.max(0, Number(e.price) || 0) : null;
}

/** 기본 지급 무기·이모트·캐릭터(price === 0) */
export function defaultOwned() {
  return ITEM_IDS.filter((id) => priceOf(id) === 0);
}

export function clampPoints(n) {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) ? Math.min(MAX_POINTS, Math.max(0, v)) : 0;
}
