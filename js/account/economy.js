/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 포인트 규칙(순수 함수). docs/DESIGN.md 7절의 표를 데이터로 두고 경기 보상과 비밀 스팟 보상을 계산한다.
 *          개인전 승리 보상은 목표 킬에 비례해 줄인다(20킬 판이 표의 값 전부). 배틀로얄은 최후의 1인 · 상위 3위 보상을 준다. 개인전 즉시 부활 값도 여기서 정한다.
 *          가격은 weapons/defs.js(무기), core/consts.js EMOTES(이모트), core/avatar-defs.js AVATARS(캐릭터)가 정본이다. 값이 바뀌면 서버 가격표(supabase/schema.sql)와 설계 문서를 함께 고친다.
 */
import { WEAPON_IDS, getDef } from '../weapons/defs.js';
import { t } from '../core/i18n.js';
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

/**
 * 개인전 즉시 부활(부활 대기 중 E) 한 번의 값 = 그 경기의 킬 보상 한 번(연습장 5 · 멀티 10). 난이도 배율은 붙지 않는다.
 * 경기 보상(matchReward)과 따로, 방장(연습장은 경기)이 출격을 확정한 그 순간 계정에서 낸다(account.spendPoints). 모자라면 쓸 수 없다.
 */
export const QUICK_RESPAWN_POINTS = Object.freeze({ bot: MATCH_POINTS.bot.kill, multi: MATCH_POINTS.multi.kill });

/** 즉시 부활 한 번의 값. online = 멀티플레이 경기인가 */
export function quickRespawnCost(online) {
  return online ? QUICK_RESPAWN_POINTS.multi : QUICK_RESPAWN_POINTS.bot;
}

/**
 * 결과 화면용 보상에 이번 경기의 즉시 부활 값을 한 줄로 더한다(포인트는 부활할 때 이미 냈다. 보유 포인트 points는 그대로).
 * reward = recordMatch 결과 { gained, breakdown, points? }, count = 즉시 부활 횟수, spent = 낸 포인트 합.
 * → 새 객체: gained = 이번 판의 순변화(보상 − 즉시 부활), breakdown 합은 여전히 gained와 같다. 낸 것이 없거나 보상이 없으면 reward 그대로
 */
export function withQuickRespawns(reward, quickCount, spent) {
  const n = count(quickCount), paid = count(spent);
  if (!reward || typeof reward !== 'object' || !n || !paid) return reward;
  const lines = Array.isArray(reward.breakdown) ? reward.breakdown : [];
  return { ...reward, gained: (Number(reward.gained) || 0) - paid, breakdown: [...lines, { label: t('account.rwQuickRespawn', { n }), points: -paid }] };
}

/** 봇전에만 적용한다 */
export const DIFFICULTY_BONUS = Object.freeze({
  easy: Object.freeze({ label: t('account.diffEasy'), mul: 0.7 }),
  normal: Object.freeze({ label: t('account.diffNormal'), mul: 1 }),
  hard: Object.freeze({ label: t('account.diffHard'), mul: 1.4 })
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
 * placement·players는 배틀로얄(mode 'br')에서만 읽는다: 최종 순위(1 = 최후의 1인)와 참가 인원
 */
export function readSummary(summary) {
  const s = summary && typeof summary === 'object' ? summary : {};
  const draw = !!s.draw;
  const ffa = s.mode === 'ffa';
  const br = s.mode === 'br';
  return {
    online: !!s.online,
    mode: ffa || br || s.mode === 'bomb' ? s.mode : 'team',
    killTarget: ffa ? count(s.killTarget) : 0,
    placement: br ? count(s.placement) : 0,
    players: br ? count(s.players) : 0,
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

/** 배틀로얄 상위권 보상(우승 제외): 이 순위 안이면 승리 보상의 3분의 1. 참가자가 이보다 적으면 주지 않는다 */
export const BR_TOP_PLACES = 3;

/** → { gained, breakdown: [{ label, points }] }. breakdown의 합은 항상 gained와 같다. */
export function matchReward(summary) {
  const s = readSummary(summary);
  const table = s.online ? MATCH_POINTS.multi : MATCH_POINTS.bot;
  const breakdown = [];
  const add = (label, points) => { if (points !== 0) breakdown.push({ label, points }); };

  add(t('account.rwKills', { n: s.kills }), s.kills * table.kill);
  add(t('account.rwHeadshots', { n: s.headshots }), s.headshots * table.headshot);
  if (s.win) {
    // 목표 킬이 짧은 개인전은 승리 보상을 비례해 줄인다. 5킬보다 작은 값은 5킬로 본다(믿을 수 없는 값이 보상을 0으로 만들지 않게)
    const k = s.killTarget ? Math.min(FFA_FULL_WIN_KILLS, Math.max(FFA_KILLS.min, s.killTarget)) : FFA_FULL_WIN_KILLS;
    add(s.mode === 'br' ? t('account.rwLastStanding') : k < FFA_FULL_WIN_KILLS ? t('account.rwWinShort', { k }) : t('account.rwWin'), Math.round((table.win * k) / FFA_FULL_WIN_KILLS));
  } else if (s.mode === 'br' && s.placement >= 2 && s.placement <= BR_TOP_PLACES && s.players > BR_TOP_PLACES) {
    add(t('account.rwTopPlace', { n: s.placement }), Math.round(table.win / 3));
  }
  add(t('account.rwFinish'), table.finish);

  const subtotal = breakdown.reduce((sum, row) => sum + row.points, 0);
  let gained = subtotal;
  if (!s.online) {
    const { label, mul } = DIFFICULTY_BONUS[s.difficulty];
    // 0.7 같은 소수를 바로 곱하면 24.5가 24.499…가 되어 반올림이 어긋난다. 정수 백분율로 계산한다.
    gained = Math.round((subtotal * Math.round(mul * 100)) / 100);
    add(t('account.rwDifficulty', { label, mul }), gained - subtotal);
  }
  return { gained, breakdown };
}

/**
 * 좀비 물량 막기 보상(판당). 깬 스테이지·보스 처치·좀비 10마리마다. 좀비 처치는 사람 킬(전적 kills·순위표)에 넣지 않는다.
 * 판당 상한을 두어 한 판이 서버 하루 한도(5만 점)를 혼자 다 쓰지 않게 한다. 연습장(혼자)은 멀티보다 적다.
 */
export const ZOMBIE_POINTS = Object.freeze({
  bot: Object.freeze({ stage: 8, boss: 20, per10: 3, cap: 1500 }),
  multi: Object.freeze({ stage: 12, boss: 30, per10: 5, cap: 2500 })
});

/** 좀비 판 요약을 안전한 값으로: { online, stage(도달), cleared(깬 수), bossKills, kills, seconds } */
export function readZombieSummary(summary) {
  const s = summary && typeof summary === 'object' ? summary : {};
  const stage = Math.max(1, count(s.stage));
  return {
    online: !!s.online, stage, cleared: Math.min(stage, count(s.cleared)), bossKills: count(s.bossKills),
    kills: count(s.kills), headshots: count(s.headshots), seconds: count(Math.round(Number(s.seconds)))
  };
}

/** → { gained, breakdown: [{ label, points }] }. breakdown의 합은 항상 gained와 같다 */
export function zombieReward(summary) {
  const s = readZombieSummary(summary);
  const pts = s.online ? ZOMBIE_POINTS.multi : ZOMBIE_POINTS.bot;
  const breakdown = [];
  const add = (label, points) => { if (points !== 0) breakdown.push({ label, points }); };
  add(t('account.rwStages', { n: s.cleared }), s.cleared * pts.stage);
  add(t('account.rwBosses', { n: s.bossKills }), s.bossKills * pts.boss);
  add(t('account.rwZombies', { n: s.kills }), Math.floor(s.kills / 10) * pts.per10);
  const sum = breakdown.reduce((a, r) => a + r.points, 0);
  if (sum > pts.cap) add(t('account.rwCap', { cap: pts.cap }), pts.cap - sum);
  return { gained: Math.min(sum, pts.cap), breakdown };
}

/** 비밀 스팟 첫 발견 보상. 맵에 적힌 값, 없으면 기본값. */
export function secretReward(secret) {
  const n = secret && secret.points;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : SECRET_POINTS_DEFAULT;
}

/** 상점 물건 id: 무기 → 이모트 → 캐릭터. 프로필의 owned는 이 순서로 정리한다 */
// 좀비 물량 막기 전용 무기(zombieOnly)는 사고팔거나 기본으로 받는 물건이 아니다. 단 shop이 붙은 것(공기총·말뚝건)은 상점에서 판다
export const ITEM_IDS = Object.freeze([...WEAPON_IDS.filter((id) => !getDef(id).zombieOnly || getDef(id).shop === true), ...EMOTE_IDS, ...AVATAR_IDS]);

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

/** 상점 물건 id → 가격. supabase/schema.sql의 fps_price_table(fps_features의 prices)과 같아야 한다 */
export function priceTable() {
  return Object.fromEntries(ITEM_IDS.map((id) => [id, priceOf(id)]));
}

/** 포인트 가격 몇 분의 1이 코인 가격인가(올림). supabase/schema.sql fps_coin_price와 같다 */
export const COIN_DIVISOR = 10;

/**
 * 코인 가격(테스트 결제로 충전한 코인, server/api). 꾸미기(이모트·캐릭터) 중 포인트 가격이 있는 것만 팔고 무기는 팔지 않는다(돈으로 강해지지 않게).
 * 코인으로 살 수 없으면 null. 서버(fps_coin_price)가 정본이고 이 값은 화면 표시용이다.
 */
export function coinPriceOf(id) {
  if (!isEmoteId(id) && !isAvatarId(id)) return null;
  const price = priceOf(id);
  return price > 0 ? Math.ceil(price / COIN_DIVISOR) : null;
}

/** 기본 지급 무기·이모트·캐릭터(price === 0) */
export function defaultOwned() {
  return ITEM_IDS.filter((id) => priceOf(id) === 0);
}

export function clampPoints(n) {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) ? Math.min(MAX_POINTS, Math.max(0, v)) : 0;
}
