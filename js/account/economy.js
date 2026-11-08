/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 포인트 규칙(순수 함수). docs/DESIGN.md 7절의 표를 데이터로 두고 경기 보상과 비밀 스팟 보상을 계산한다.
 *          가격은 weapons/defs.js(무기)와 core/consts.js EMOTES(이모트)가 정본이다. 값이 바뀌면 서버 가격표(supabase/schema.sql)와 설계 문서를 함께 고친다.
 */
import { WEAPON_IDS, getDef } from '../weapons/defs.js';
import { EMOTE_IDS, emoteById } from '../core/consts.js';

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
 * 경기 summary를 안전한 값으로 읽는다. 숫자가 아니거나 음수면 0, 모르는 난이도는 normal, 무승부는 승리가 아니다.
 * knifeKills는 DESIGN의 summary에 없는 선택 필드로, 넘겨 주면 전적에 쌓인다.
 */
export function readSummary(summary) {
  const s = summary && typeof summary === 'object' ? summary : {};
  const draw = !!s.draw;
  return {
    online: !!s.online,
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
  if (s.win) add('승리', table.win);
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

/** 상점 물건 id: 무기 다음에 이모트. 프로필의 owned는 이 순서로 정리한다 */
export const ITEM_IDS = Object.freeze([...WEAPON_IDS, ...EMOTE_IDS]);

/** 이모트 id인가(번호는 아니다) */
export function isEmoteId(id) {
  return typeof id === 'string' && EMOTE_IDS.includes(id);
}

/** 무기·이모트 가격. 모르는 물건은 null. */
export function priceOf(id) {
  const def = getDef(id);
  if (def) return Math.max(0, Number(def.price) || 0);
  const e = isEmoteId(id) ? emoteById(id) : null;
  return e ? Math.max(0, Number(e.price) || 0) : null;
}

/** 기본 지급 무기·이모트(price === 0) */
export function defaultOwned() {
  return ITEM_IDS.filter((id) => priceOf(id) === 0);
}

export function clampPoints(n) {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) ? Math.min(MAX_POINTS, Math.max(0, v)) : 0;
}
