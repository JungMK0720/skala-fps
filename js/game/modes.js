/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 무기 규칙(룰셋) 정의. 클래식·칼전·스나전이 어떤 슬롯과 무기를 허용하는지 한곳에서 정한다.
 *          팀전/개인전(rules.mode)과는 별개 축이다. 멀티 개인전 방의 목표 킬 범위도 여기서 정한다.
 *          순수 모듈이라 node 테스트에서 그대로 import할 수 있다.
 */
import { getDef, PRIMARY_IDS, MELEE_IDS } from '../weapons/defs.js';

export const RULESET_IDS = Object.freeze(['classic', 'knife', 'sniper']);
export const DEFAULT_RULESET = 'classic';

/**
 * 멀티 개인전 방의 목표 킬. 방장이 방을 만들 때와 대기실에서 min~max 안에서 고르고, 고른 적이 없으면 def다.
 * match.js는 연습장 주소 값(killtarget)도 받아야 해서 5~50으로 따로 자른다.
 */
export const FFA_KILLS = Object.freeze({ min: 5, max: 20, def: 20 });
/** 대기실의 빠른 선택 버튼 */
export const FFA_KILL_PRESETS = Object.freeze([5, 10, 15, 20]);

/** 숫자나 숫자 글자면 min~max 안의 정수(벗어나면 가까운 끝), 비었거나 숫자가 아니면 null */
export function parseKillTarget(v) {
  const ok = (typeof v === 'number') || (typeof v === 'string' && v.trim() !== '');
  const n = ok ? Math.round(Number(v)) : NaN;
  return Number.isFinite(n) ? Math.min(FFA_KILLS.max, Math.max(FFA_KILLS.min, n)) : null;
}

/** parseKillTarget과 같고, 읽을 수 없으면 def(고른 적이 없는 방) */
export function normalizeKillTarget(v) {
  const k = parseKillTarget(v);
  return k === null ? FFA_KILLS.def : k;
}

/**
 * slots        : 쓸 수 있는 무기 슬롯(1 주무기 · 2 보조 · 3 근접 · 4 투척)
 * pickSlot     : 라운드 전 고르는 슬롯(match.setLoadout에 들어가는 값의 슬롯)
 * primaryKinds : pickSlot이 1일 때 허용하는 def.kind (null이면 전부)
 * defaultPick  : 고르지 않았을 때 무기 id
 */
export const RULESETS = Object.freeze({
  classic: Object.freeze({
    id: 'classic', name: '클래식', icon: '🔫', desc: '모든 무기를 쓰는 기본 규칙',
    slots: Object.freeze([1, 2, 3, 4]), pickSlot: 1, primaryKinds: null, defaultPick: 'ar_std'
  }),
  knife: Object.freeze({
    id: 'knife', name: '칼전', icon: '🗡️', desc: '칼만 쓰는 근접전. 총과 수류탄은 없다',
    slots: Object.freeze([3]), pickSlot: 3, primaryKinds: null, defaultPick: 'ml_knife'
  }),
  sniper: Object.freeze({
    id: 'sniper', name: '스나전', icon: '🎯', desc: '저격총과 칼만 쓰는 규칙',
    slots: Object.freeze([1, 3]), pickSlot: 1, primaryKinds: Object.freeze(['sniper']), defaultPick: 'sr_bolt'
  })
});

/** 모르는 값은 클래식으로 */
/**
 * 총알이 맞을 수 있는 사람. 팀전에서는 아군 몸을 통과해 뒤의 적에게 맞는다(아군 사격은 원래 꺼져 있다).
 * 개인전이거나 내 팀을 모르면 그대로 돌려준다. 목록의 각 항목은 { team } 을 가진다.
 */
export function shotTargets(list, mode, team) {
  if (mode === 'ffa' || !team || !Array.isArray(list)) return list;
  return list.filter((t) => !t || t.team !== team);
}

export function normalizeRuleset(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(RULESETS, id) ? id : DEFAULT_RULESET;
}

export function rulesetOf(id) {
  return RULESETS[normalizeRuleset(id)];
}

/** 이 규칙에서 이 무기를 쓸 수 있는가(방장의 히트 검증과 클라이언트 무기 제한이 같이 쓴다) */
export function isWeaponAllowed(rulesetId, weaponId) {
  const rs = rulesetOf(rulesetId);
  const def = getDef(weaponId);
  if (!def || !rs.slots.includes(def.slot)) return false;
  if (def.slot === 1 && rs.primaryKinds && !rs.primaryKinds.includes(def.kind)) return false;
  return true;
}

/** 라운드 전 화면에서 고를 수 있는 무기 id. owned를 주면 가진 것만 남긴다(비면 기본 무기 하나는 남는다) */
export function pickableWeapons(rulesetId, owned = null) {
  const rs = rulesetOf(rulesetId);
  const base = rs.pickSlot === 3 ? MELEE_IDS : PRIMARY_IDS;
  const all = base.filter((id) => isWeaponAllowed(rs.id, id));
  if (!owned) return all.slice();
  const has = owned instanceof Set ? owned : new Set(owned);
  const mine = all.filter((id) => has.has(id));
  return mine.length ? mine : [rs.defaultPick];
}

export function defaultPick(rulesetId) {
  return rulesetOf(rulesetId).defaultPick;
}
