/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 봇 두뇌(연습장·빈자리 채우기). 무기 수치는 weapons/defs.js에서, 쓸 수 있는 슬롯은 game/modes.js의 규칙에서 읽어
 *          모든 주무기와 칼전·스나전을 같은 상태 머신으로 운용한다. three.js·DOM에 의존하지 않는 순수 모듈이다.
 */
/**
 * SKALA 작전 — 봇 AI (연습장·빈자리 채우기)
 *
 * 순수 ES 모듈: three.js·DOM 의존 없음. 엔진이 매 프레임 brain.think(dt, view)를 부르고,
 * 돌려받은 입력을 사람 입력과 똑같이 처리한다(이동·시점·무기). 자세한 계약은 BOTS_API.md.
 *
 * 각도 규약(core/consts.js와 같음): yaw 0 → -Z, yaw + = 왼쪽(반시계), 전방 = (-sin yaw, 0, -cos yaw),
 * 오른쪽 = (cos yaw, 0, -sin yaw), pitch + = 위.
 *
 * 공정성: 봇은 view.enemies 전체를 받지만, '시야각 100° 안 + view.los(눈, 몸/머리) 통과'일 때만
 * 위치를 기억에 넣는다. 그 밖에는 hearShot(pos)로 들은 소리, 피격 사실만 쓴다(벽 너머를 모른다).
 * 칼전 순찰만 예외다. 총소리가 없는 규칙이라 가장 가까운 적의 대략적인 위치(난이도별 오차)를 향해 달린다. 교전은 여전히 '보임'이 조건이다.
 */

import * as CONSTS from '../core/consts.js';
import { WEAPONS, WEAPON_IDS, SECONDARY_IDS, MELEE_IDS, GRENADE_IDS, DEFAULT_LOADOUT, getDef } from '../weapons/defs.js';
import { rulesetOf, isWeaponAllowed, pickableWeapons, defaultPick } from './modes.js';

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const cnum = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const C_PLAYER = (CONSTS && CONSTS.PLAYER) || {};
const C_HB = (CONSTS && CONSTS.HITBOX) || {};
const C_HBC = (CONSTS && CONSTS.HITBOX_CROUCH) || {};   // core가 추가 중일 수 있어 없으면 기본값
const EYE = cnum(C_PLAYER.EYE, 1.6);                      // 눈높이
const CROUCH_EYE = cnum(C_PLAYER.CROUCH_EYE, 1.1);        // 앉은 눈높이
const HEAD_Y = cnum(C_HB.HEAD && C_HB.HEAD.y, 1.62);      // 머리 구 중심
const HEAD_Y_CROUCH = cnum(C_HBC.HEAD && C_HBC.HEAD.y, 1.12);
const BODY_LO = cnum(C_HB.BODY && C_HB.BODY.y0, 1.0), BODY_HI = cnum(C_HB.BODY && C_HB.BODY.y1, 1.5);
const BODYC_LO = cnum(C_HBC.BODY && C_HBC.BODY.y0, 0.6), BODYC_HI = cnum(C_HBC.BODY && C_HBC.BODY.y1, 1.05);
const BODY_Y = 1.2;           // 몸통 조준점 (몸통 박스 1.0~1.5의 가운데보다 조금 아래)
/** crouch 값(true | 0..1, physics.js와 같은 해석) → 0..1 */
const crouchK = (v) => (v === true ? 1 : typeof v === 'number' && Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 0);
/** 서 있을 때의 높이 y(발 기준)를 앉은 자세로 옮긴다 (k = 0..1). 몸통 구간은 몸통 구간끼리 비례로 */
function crouchY(y, k) {
  if (!(k > 0)) return y;
  let yc;
  if (y >= HEAD_Y - 0.2) yc = HEAD_Y_CROUCH + (y - HEAD_Y);
  else if (y >= BODY_LO) yc = BODYC_LO + (y - BODY_LO) * (BODYC_HI - BODYC_LO) / (BODY_HI - BODY_LO);
  else yc = y * (BODYC_LO / BODY_LO);
  return y + (yc - y) * k;
}
const WALK_SPEED = 5.2;
const FOV_H = 100 * DEG;      // 수평 시야각
const FOV_V = 70 * DEG;       // 수직 시야각(여유 포함)

/** 난이도 표 — 반응 시간·헤드샷 비율은 과제 명세값 */
export const BOT_DIFFICULTY = Object.freeze({
  easy: Object.freeze({
    reaction: 0.60, headshot: 0.05, headAim: 0.0, headAimSniper: 0.11, bodyY: 0.92,   // headshot = 목표 '명중 중 헤드' 비율, headAim·bodyY = 이를 맞추는 내부 보정값
    aimRate: 4.5, maxTurn: 4.0, idleTurn: 2.2,       // 조준 수렴 속도(1/s), 최대 회전(rad/s)
    aimErr: 0.40, aimErrPerM: 0.011, settle: 0.9,     // 조준 오차 표준편차(m) = aimErr + 거리×aimErrPerM, 첫 조준 흔들림 감쇠(s)
    fireTol: 1.8, burst: [2, 4], burstGap: [0.35, 0.7], strafe: 0.35, counterStrafe: 0.15,
    grenade: 0, lowHp: 30, sightRange: 60, farReact: 0.008, maxEngage: 45, hearRange: 45, sniperSettle: 0.5, pistolGap: 0.45,
    lead: 0, recoilComp: 0.45, perceiveHz: 6, chasePredict: 0, advance: 0.4,
    meleeHeavy: 0.1, huntEvery: [3.0, 4.5], huntErr: 7       // 칼: 강타 확률, 사냥 목표 갱신 간격(s), 위치 오차(m)
  }),
  normal: Object.freeze({
    reaction: 0.38, headshot: 0.15, headAim: 0.06, headAimSniper: 0.18, bodyY: 1.08,
    aimRate: 7, maxTurn: 6.5, idleTurn: 3.0,
    aimErr: 0.26, aimErrPerM: 0.007, settle: 0.6,
    fireTol: 1.3, burst: [3, 5], burstGap: [0.22, 0.45], strafe: 0.65, counterStrafe: 0.6,
    grenade: 0.3, lowHp: 35, sightRange: 80, farReact: 0.005, maxEngage: 60, hearRange: 60, sniperSettle: 0.32, pistolGap: 0.3,
    lead: 0.5, recoilComp: 0.75, perceiveHz: 10, chasePredict: 0.6, advance: 0.6,
    meleeHeavy: 0.2, huntEvery: [1.8, 3.0], huntErr: 4
  }),
  hard: Object.freeze({
    reaction: 0.22, headshot: 0.30, headAim: 0.32, headAimSniper: 0.45, bodyY: 1.18,
    aimRate: 11, maxTurn: 9.5, idleTurn: 4.0,
    aimErr: 0.15, aimErrPerM: 0.0045, settle: 0.4,
    fireTol: 1.0, burst: [4, 7], burstGap: [0.15, 0.3], strafe: 0.9, counterStrafe: 0.9,
    grenade: 0.5, lowHp: 40, sightRange: 100, farReact: 0.003, maxEngage: 75, hearRange: 75, sniperSettle: 0.2, pistolGap: 0.22,
    lead: 0.9, recoilComp: 0.9, perceiveHz: 12, chasePredict: 1.2, advance: 0.8,
    meleeHeavy: 0.35, huntEvery: [1.0, 1.8], huntErr: 2
  })
});

const GRENADE_ID = GRENADE_IDS[0];
const HEAD_HUNTER_RATIO = 5;     // 머리 ÷ 몸 피해가 이 이상이면 머리 전용 총으로 보고 머리를 더 자주 노린다
const HEAD_HUNTER_BONUS = 0.3;
const FULL_AUTO_REF = 0.1;       // 점사 길이의 기준 간격(s). 이보다 빠른 총은 같은 시간 동안 더 많은 탄을 쓴다
const MELEE_BODY_R = 0.3;        // 칼 판정은 몸 표면까지 잰다(world.meleeTrace의 BODY_R)
const MELEE_VERTICAL = 1.7;      // 이 높이 차를 넘으면 칼이 닿지 않는다(m)
const MELEE_WEAVE_RANGE = 6;     // 이 안에서 좌우로 흔들며 다가간다(m)
const HOP_RATE = 0.3;            // 달려가며 막히지 않아도 뛰는 빈도(/s, 난이도 strafe를 곱한다)
const SNIPER_KNIFE_ENTER = 3.6;  // 보조 없는 규칙의 저격수: 볼트·재장전 중 이 안이면 칼을 든다(눈~발 거리, m)
const SNIPER_KNIFE_LEAVE = 7;    // 칼을 든 저격수는 이보다 멀어지면 저격총으로 돌아간다
const PATH_FAIL_WANDER = 3;      // 경로 찾기가 연달아 이만큼 실패하면 갇힌 것으로 보고 트인 쪽으로 움직여 본다

/** 무기 정의 → 봇이 쓰는 값. 수치를 따로 적지 않고 전부 defs에서 읽는다 */
function infoFromDef(d) {
  const info = { id: d.id, slot: d.slot, kind: d.kind, fire: d.fire, draw: d.drawTime ?? 0.5 };
  if (d.melee) {
    const { slash, stab } = d.melee;
    return Object.assign(info, {
      range: slash.range, interval: slash.cooldown, arc: slash.arc * DEG,
      heavyRange: stab.range, heavyInterval: stab.cooldown, heavyArc: stab.arc * DEG
    });
  }
  if (d.kind === 'grenade') {
    return Object.assign(info, {
      speed: d.throw.speed, pitchUp: d.throw.pitchUp * DEG, gravity: Math.abs(d.physics.gravity),
      fuse: d.fuse, prime: d.primeTime, radius: d.explosion.radius
    });
  }
  const pat = (d.recoil && d.recoil.pattern) || [];
  const first = pat.slice(0, 10);
  const burst = d.burst || null;
  return Object.assign(info, {
    mag: d.mag, reserve: d.reserve, interval: d.fireInterval, reload: d.reload, maxRange: d.maxRange,
    // 엔진이 self.recoil을 주지 않을 때 쓰는 반동 추정값(처음 몇 발의 평균)
    kick: first.length ? (first.reduce((sum, row) => sum + Math.abs(row[1]), 0) / first.length) * DEG : 0,
    recover: d.recoil ? d.recoil.recoverRate : 6, recoverDelay: d.recoil ? d.recoil.recoverDelay : 0.1,
    effRange: d.falloff ? d.falloff.end : Infinity,
    pellets: d.pellets || 1,
    burstCount: burst ? burst.count : 1,
    // 방아쇠를 당긴 뒤 다음 방아쇠까지의 시간(점사는 나머지 탄 + 쉬는 시간)
    cycle: burst ? (burst.count - 1) * burst.gap + d.fireInterval : d.bolt ?? d.fireInterval,
    bolt: d.bolt ?? 0,
    zoomIn: d.zoom ? d.zoom.inTime : 0,
    accurateAt: d.zoom ? d.zoom.accurateAt ?? null : null,
    headRatio: d.damage && d.damage.body > 0 ? d.damage.head / d.damage.body : 1
  });
}

/** 봇이 아는 무기 정보 (defs에서 만든다. createBot({ weaponInfo })로 항목별 덮어쓰기 가능) */
export const BOT_WEAPON_INFO = Object.freeze(Object.fromEntries(WEAPON_IDS.map((id) => [id, Object.freeze(infoFromDef(WEAPONS[id]))])));

/**
 * def.kind별 교전 방식.
 * approach : 이보다 멀면 다가간다(m). 0이면 난이도 기본값(min(40, maxEngage×0.8))
 * closer   : 근거리 무기. 멀면 곧바로 달려가고 쏠 때 멈추지 않는다
 * zoomFrom : 이보다 멀면 조준한다(m). 0이면 난이도 기본값(easy 22, 그 밖 12), Infinity면 조준하지 않는다
 * aimTol   : 사격 허용 오차 배율
 * stopToFire: 조준 사격 때 멈춘다
 */
const KIND_STYLE = Object.freeze({
  rifle: Object.freeze({ approach: 0, closer: false, zoomFrom: 0, aimTol: 1, stopToFire: false }),
  dmr: Object.freeze({ approach: 70, closer: false, zoomFrom: 5, aimTol: 1.1, stopToFire: true }),
  smg: Object.freeze({ approach: 14, closer: true, zoomFrom: 20, aimTol: 1.3, stopToFire: false }),
  shotgun: Object.freeze({ approach: 7, closer: true, zoomFrom: Infinity, aimTol: 1.6, stopToFire: false }),
  pistol: Object.freeze({ approach: 22, closer: false, zoomFrom: Infinity, aimTol: 1.1, stopToFire: false })
});
const styleOf = (info) => KIND_STYLE[info.kind] || KIND_STYLE.rifle;

/** 무기 id → 로드아웃 키('primary'|'secondary'|'melee'). 고를 수 없는 무기면 null */
export function loadoutKey(weaponId) {
  const d = getDef(weaponId);
  return d ? (d.slot === 1 ? 'primary' : d.slot === 2 ? 'secondary' : d.slot === 3 ? 'melee' : null) : null;
}

/**
 * 규칙별 봇 주무기 확률표 [{ id, weight }] (weight 합 = 1). pickableWeapons를 기준으로 만들어 무기가 늘어도 그대로 돈다.
 * 클래식: 기본 소총 40 %, 저격 25 %(기본 저격에 2배), 나머지 35 %를 고르게. 칼전·스나전: 기본 무기에 2배, 나머지는 고르게.
 */
export function botPickWeights(rulesetId) {
  const rs = rulesetOf(rulesetId);
  const ids = pickableWeapons(rs.id);
  const base = defaultPick(rs.id);
  const raw = new Map();
  const share = (list, total, main) => {
    const sum = list.reduce((acc, id) => acc + (id === main ? 2 : 1), 0);
    for (const id of list) raw.set(id, (total * (id === main ? 2 : 1)) / sum);
  };
  if (rs.id === 'classic') {
    share(ids.filter((id) => id === base), 0.4, base);
    share(ids.filter((id) => getDef(id).kind === 'sniper'), 0.25, defaultPick('sniper'));
    share(ids.filter((id) => id !== base && getDef(id).kind !== 'sniper'), 0.35, null);
  } else share(ids, 1, base);
  let total = 0;
  for (const w of raw.values()) total += w;
  return ids.map((id) => ({ id, weight: raw.get(id) / total }));
}

/**
 * 봇 주무기 하나를 뽑는다.
 * @param {string} rulesetId
 * @param {() => number} [rng]
 * @param {string} [override] 이 규칙에서 쓸 수 있는 무기 id면 그대로 돌려준다(시험용 botWeapon). 'mix'·null이면 확률표대로
 */
export function pickBotWeapon(rulesetId, rng = Math.random, override = null) {
  const rs = rulesetOf(rulesetId);
  if (override && override !== 'mix' && loadoutKey(override) && isWeaponAllowed(rs.id, override)) return override;
  const table = botPickWeights(rs.id);
  let r = rng();
  for (const row of table) {
    r -= row.weight;
    if (r < 0) return row.id;
  }
  return table[table.length - 1].id;
}

/** 고른 무기(pick)를 제자리에 넣은 봇 로드아웃 { primary, secondary, melee }. 고르지 않는 칸에는 약간의 변화를 준다 */
export function botLoadout(rulesetId, pick, rng = Math.random) {
  const rs = rulesetOf(rulesetId);
  const out = {
    primary: rs.pickSlot === 1 ? defaultPick(rs.id) : DEFAULT_LOADOUT.primary,
    secondary: DEFAULT_LOADOUT.secondary,
    melee: rs.pickSlot === 3 ? defaultPick(rs.id) : MELEE_IDS[Math.min(MELEE_IDS.length - 1, Math.floor(rng() * MELEE_IDS.length))]
  };
  const others = SECONDARY_IDS.filter((id) => id !== DEFAULT_LOADOUT.secondary);
  if (others.length && rng() < 0.25) out.secondary = others[Math.min(others.length - 1, Math.floor(rng() * others.length))];
  const key = loadoutKey(pick);
  if (key && isWeaponAllowed(rs.id, pick)) out[key] = pick;
  return out;
}

/* ---------------- 작은 도구들 ---------------- */
const wrap = (a) => { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI; };
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const num = (v, d) => (isNum(v) ? v : d);
/** {x,y,z} 또는 [x,y,z] → {x,y,z} (복사) */
function rv(p, out) {
  const o = out || { x: 0, y: 0, z: 0 };
  if (!p) { o.x = 0; o.y = 0; o.z = 0; return o; }
  o.x = num(p.x !== undefined ? +p.x : +p[0], 0);
  o.y = num(p.y !== undefined ? +p.y : +p[1], 0);
  o.z = num(p.z !== undefined ? +p.z : +p[2], 0);
  return o;
}
const yawOf = (dx, dz) => Math.atan2(-dx, -dz);
const hyp2 = (dx, dz) => Math.sqrt(dx * dx + dz * dz);
const dist3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const dist2 = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}
function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** los 반환값 정규화: boolean | {clear} | {visible} | {hit} */
function losClear(r) {
  if (typeof r === 'boolean') return r;
  if (r && typeof r === 'object') {
    if ('clear' in r) return !!r.clear;
    if ('visible' in r) return !!r.visible;
    if ('hit' in r) return !r.hit;
  }
  return !!r;
}
/** 배열과 {x,y,z}를 겸하는 점 (physics.lineOfSight(a,b)처럼 배열을 받는 함수에도 바로 넘길 수 있게) */
function dualPoint() { const p = [0, 0, 0]; p.x = 0; p.y = 0; p.z = 0; return p; }
function setDual(p, x, y, z) { p[0] = p.x = x; p[1] = p.y = y; p[2] = p.z = z; return p; }

/** 수류탄 발사각(낮은 포물선): 수평거리 d, 높이차 h, 속력 v, 중력 g → 상승각(rad) 또는 NaN */
export function lobAngle(d, h, v, g) {
  if (!(d > 0.1)) return 45 * DEG;
  const v2 = v * v, disc = v2 * v2 - g * (g * d * d + 2 * h * v2);
  if (disc < 0) return NaN;
  return Math.atan((v2 - Math.sqrt(disc)) / (g * d));
}

const LANE_TABLE = { 1: ['center'], 2: ['left', 'right'], 3: ['left', 'center', 'right'], 4: ['left', 'center', 'right', 'center'] };

/**
 * 봇 두뇌 하나를 만든다.
 * @param {object} opts
 * @param {string|number} opts.id
 * @param {'owner'|'charterer'|null} opts.team   개인전이면 생략/null
 * @param {'team'|'ffa'} [opts.mode='team']       'ffa' = 개인전: 자기 말고 모두 적(사람·봇), 아군 개념 없음
 * @param {'easy'|'normal'|'hard'} [opts.difficulty='normal']
 * @param {'classic'|'knife'|'sniper'} [opts.ruleset='classic']  쓸 수 있는 슬롯과 무기(game/modes.js)
 * @param {string} [opts.primary]                고른 무기 id. 규칙에서 쓸 수 있는 무기면 무엇이든(칼전이면 칼). 없으면 규칙 기본값
 * @param {string} [opts.secondary]              슬롯 2 무기(기본 DEFAULT_LOADOUT)
 * @param {string} [opts.melee]                  슬롯 3 무기(기본 DEFAULT_LOADOUT, 칼전은 규칙 기본값)
 * @param {'left'|'center'|'right'} [opts.lane]  지정하지 않으면 아군 id 순서로 자동 배정
 * @param {number} [opts.seed]                   난수 씨앗(같은 값이면 같은 행동)
 * @param {object} [opts.tuning]                 BOT_DIFFICULTY 항목 덮어쓰기
 * @param {object} [opts.weaponInfo]             BOT_WEAPON_INFO 항목 덮어쓰기 ({ sr_bolt: {bolt: 1.0}, ... })
 */
export function createBot(opts = {}) {
  const o = opts || {};
  const id = o.id ?? 'bot';
  const ffa = o.mode === 'ffa';
  const team = ffa ? (o.team ?? null) : (o.team || 'owner');
  const difficulty = Object.prototype.hasOwnProperty.call(BOT_DIFFICULTY, o.difficulty) ? o.difficulty : 'normal';
  const D = Object.assign({}, BOT_DIFFICULTY[difficulty], o.tuning || {});
  const rules = rulesetOf(o.ruleset);
  const allowed = new Set(rules.slots);
  const canUse = (s) => allowed.has(s);
  const W = {};
  for (const k of WEAPON_IDS) W[k] = o.weaponInfo && o.weaponInfo[k] ? Object.assign({}, BOT_WEAPON_INFO[k], o.weaponInfo[k]) : BOT_WEAPON_INFO[k];
  const slotDefault = (slot, key) => (rules.pickSlot === slot ? defaultPick(rules.id) : DEFAULT_LOADOUT[key]);
  const pickIn = (weaponId, slot) => { const d = getDef(weaponId); return d && d.slot === slot ? weaponId : null; };
  // 슬롯별 무기. 규칙이 금지한 슬롯의 값은 쓰이지 않는다
  const gear = {
    1: slotDefault(1, 'primary'),
    2: pickIn(o.secondary, 2) || slotDefault(2, 'secondary'),
    3: pickIn(o.melee, 3) || slotDefault(3, 'melee'),
    4: GRENADE_ID
  };
  let homeSlot = rules.pickSlot;   // 평소에 드는 슬롯
  /** 규칙에서 쓸 수 있는 무기를 제자리에 넣고 그 슬롯을 평소 슬롯으로 삼는다 */
  function setGear(weaponId) {
    if (!loadoutKey(weaponId) || !isWeaponAllowed(rules.id, weaponId)) return false;
    const slot = getDef(weaponId).slot;
    gear[slot] = weaponId;
    homeSlot = slot;
    return true;
  }
  setGear(o.primary);
  const slotWeapon = (s) => gear[s] || gear[homeSlot];
  let isSniper = false, meleeOnly = false, sightMul = 1;
  function refreshRole() {
    const kind = W[gear[homeSlot]].kind;
    isSniper = kind === 'sniper';
    meleeOnly = kind === 'melee';
    sightMul = isSniper ? 1.5 : kind === 'dmr' ? 1.2 : 1;
  }
  refreshRole();
  const rng = mulberry32(o.seed != null ? (+o.seed >>> 0) : hashStr(String(id) + ':' + (team ?? 'ffa') + ':' + difficulty));
  const rand = (a, b) => a + (b - a) * rng();
  const idPhase = hashStr(String(id)) % 7;
  let spare = null;
  const gauss = () => {
    if (spare !== null) { const v = spare; spare = null; return v; }
    let u = 0, v = 0;
    while (u < 1e-12) u = rng();
    v = rng();
    const m = Math.sqrt(-2 * Math.log(u));
    spare = m * Math.sin(TAU * v);
    return m * Math.cos(TAU * v);
  };

  /* ---------------- 상태 ---------------- */
  const stats = { stuck: 0, recovered: 0, abandoned: 0, shots: 0, swings: 0, heavies: 0, pathFails: 0, grenades: 0, covers: 0, thinkMs: 0, thinks: 0 };
  let clock = 0, alive = false, roundId = 0;
  const pos = { x: 0, y: 0, z: 0 }, lastPos = { x: 0, y: 0, z: 0 }, vel = { x: 0, y: 0, z: 0 }, eye = { x: 0, y: 0, z: 0 };
  let yaw = 0, pitch = 0, hp = 100, lastHp = 100, curSlot = homeSlot, haveLast = false;
  let nav = null, view = null;
  const LA = dualPoint(), LB = dualPoint();
  let losCalls = 0;
  const foes = [];                // 이번 프레임 '적' 목록 (팀전: view.enemies, 개인전: 자기 뺀 모두)
  let selfCrouchK = 0, crouchSupported = false, wantCrouch = false;
  let protectUntil = -99;         // 내 부활 보호 끝나는 시각(참고)

  let mode = 'patrol', modeSince = 0;
  const mem = new Map();          // enemyId → {id, pos, vpos, vel, seenAt, visible, part, acquiredAt, react, lostAt, grenadeRolled, chased}
  let targetId = null;
  let nextPerceive = rng() * 0.1;
  let nextTrack = 0;
  const sounds = [];              // {x,y,z,t}
  const alliesKnown = [];         // [{x,y,z}] 이번 프레임 아군 위치(아군 사격 소리 거르기)
  let alert = null;               // {x,y,z,until} — 피격 등으로 돌아볼 곳
  let intel = null;               // {x,y,z,t} — 내가 마지막으로 본/들은 적 정보 (순찰 목표에 씀)
  let roundStart = 0;
  let damagedAt = -99;

  // 경로
  const P = { pts: null, idx: 0, goal: null, purpose: '', plannedAt: -99, failAt: -99, failStreak: 0, wpBest: Infinity, wpT: 0, shortcutT: 0 };
  // 순찰 계획
  const plan = { lane: o.lane || null, route: [], routeIdx: 0, ownC: null, enemyC: null, holdUntil: 0, holdSpot: null, holdYaw: 0, scanT: 0, visited: [] , ready: false };
  // 끼임
  const stk = { ring: [], sampleT: 0, moveT: 0, level: 0, at: null, lastEvent: -99, recoverUntil: 0, side: 1, escape: null, escapeUntil: 0, avoid: [], blocked: [], lastDir: { x: 0, z: 0 }, rec: null, escTries: 0 };
  // 조준
  const aim = { ex: 0, ey: 0, head: false, rollT: 0, reactUntil: 0, lastTarget: null };
  // 무기
  const freshMags = () => ({ 1: W[gear[1]].mag ?? 0, 2: W[gear[2]].mag ?? 0 });
  const freshReserves = () => ({ 1: W[gear[1]].reserve ?? 0, 2: W[gear[2]].reserve ?? 0 });
  const wpn = {
    wantSlot: homeSlot, drawUntil: 0, prevSlot: homeSlot,
    boltUntil: 0, zoomStart: -1, lastFire: -99, lastShotAt: -99, pulse: false, prevFire: false,
    burstEnd: -1, nextBurst: 0, burstStop: false, preStop: -1,
    reloadUntil: 0, nextTap: 0, pulseStop: false, heavyNext: false,
    estMag: freshMags(), estRes: freshReserves(), grenades: 1,
    gr: null                       // 수류탄 시퀀스 {phase, t, target}
  };
  // 반동 (엔진이 self.recoil을 주면 그것을, 아니면 내부 추정)
  const rk = { yaw: 0, pitch: 0, ext: false, lastShot: -99, kickCfg: null };
  // 교전 이동
  const eng = { strafeDir: 0, strafeUntil: 0, spaceT: 0, advance: false, engageSince: 0, peekUntil: 0, peekDir: 1, blockSince: -1, nextHop: 0 };
  // 칼전 순찰: 가장 가까운 적의 대략적인 위치
  const hunt = { goal: null, targetId: null, targetY: 0, nextAt: 0, skip: new Map() };   // skip: 닿을 수 없던 적 id → 다시 찾을 시각
  // 발판 비행: 착지하면 경로를 새로 잡는다
  let flight = false, flightAt = -99;
  let lastDt = 1 / 60;
  // 엄폐
  let cover = null;                 // {pt, threat, phase, until}
  let lastCoverTry = -99;
  // 추적·조사
  let chase = null;                 // {goal, lookAt, arrivedAt, until}
  let investigate = null;           // {goal, until, t}
  let search = null;                // {until, nextLook, lookYaw}
  // 폭파 미션 목표(view.objective, BOTS_API 12절): 교전이 없으면 그곳으로 가고, 닿으면 멈춰 둘레를 본다
  let objective = null;             // {x,y,z, radius, hold, urgent, look}
  let objHold = false, objScanT = 0, objScanYaw = 0;

  function setMode(m) { if (m !== mode) { mode = m; modeSince = clock; if (m === 'engage') eng.engageSince = clock; } }

  /* ---------------- 시야 ---------------- */
  function los(ax, ay, az, bx, by, bz) {
    losCalls++;
    setDual(LA, ax, ay, az); setDual(LB, bx, by, bz);
    if (view && typeof view.los === 'function') {
      try { return losClear(view.los(LA, LB)); } catch (e) { return false; }
    }
    if (nav && typeof nav.raycast === 'function') return nav.raycast(LA, LB);
    return true;
  }
  /** 적 하나가 지금 보이는가 (시야각 + 시선) */
  function sightRange() {
    let r = D.sightRange * sightMul;
    const fog = nav && nav.fog;
    if (fog && isNum(fog[1]) && fog[1] > 10) r = Math.min(r, fog[1] * 0.8);
    return r;
  }
  /** 적이 보이는가: 0 = 안 보임, 1 = 몸통 보임, 2 = 머리만 보임. ck = 상대 앉은 정도(0..1) */
  function canSee(ep, ck) {
    const dx = ep.x - eye.x, dz = ep.z - eye.z, dXZ = hyp2(dx, dz);
    if (dXZ > sightRange()) return 0;
    if (dXZ > 0.8) {
      const ang = Math.abs(wrap(yawOf(dx, dz) - yaw));
      if (ang > FOV_H / 2) return 0;
      const elev = Math.atan2(ep.y + crouchY(BODY_Y, ck) - eye.y, dXZ);
      if (Math.abs(elev - pitch) > FOV_V / 2 + 0.25) return 0;
    }
    if (los(eye.x, eye.y, eye.z, ep.x, ep.y + crouchY(BODY_Y, ck), ep.z)) return 1;
    return los(eye.x, eye.y, eye.z, ep.x, ep.y + crouchY(HEAD_Y, ck), ep.z) ? 2 : 0;
  }
  const _ep = { x: 0, y: 0, z: 0 };
  function perceive(enemies, full) {
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (!e) continue;
      const eid = e.id ?? '#' + i;
      let m = mem.get(eid);
      if (e.alive === false) { if (m) mem.delete(eid); if (targetId === eid) targetId = null; continue; } // 사망은 킬로그로 공개
      if (!full && eid !== targetId) continue;
      rv(e.pos, _ep);
      const ck = crouchK(e.crouch);
      const vis = canSee(_ep, ck);
      if (!vis) {
        if (m && m.visible) { m.visible = false; m.lostAt = clock; }
        continue;
      }
      if (!m) { m = { id: eid, pos: { x: 0, y: 0, z: 0 }, vpos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, seenAt: -99, visible: false, part: 1, acquiredAt: clock, react: D.reaction, lostAt: -99, grenadeRolled: false, chased: false }; mem.set(eid, m); }
      if (vis === 2 && m.part !== 2) m.headOnlySince = clock;
      m.part = vis; m.crouch = ck; m.protect = !!e.protect;
      if (!m.visible) {
        const gap = clock - m.seenAt;
        // 처음 보거나 오래 놓쳤으면 반응 시간 전부(멀수록 조금 더), 잠깐 가려졌다 나오면 일부만
        if (gap > 1.2) {
          const far = Math.max(0, dist3(eye, _ep) - 25) * D.farReact;
          m.acquiredAt = clock; m.react = (D.reaction + far) * rand(0.9, 1.15);
        }
        else if (gap > 0.35) m.acquiredAt = Math.max(m.acquiredAt, clock - m.react * 0.5);
        m.grenadeRolled = false;
      }
      // 속도 추정: 직전 '지각' 위치(vpos) 기준 (livePos가 매 프레임 갱신하는 pos와 분리)
      const dt = clock - m.seenAt;
      if (m.seenAt > -98 && dt > 0.02 && dt < 1) {
        const k = 0.5;
        m.vel.x = m.vel.x * (1 - k) + ((_ep.x - m.vpos.x) / dt) * k;
        m.vel.y = 0;
        m.vel.z = m.vel.z * (1 - k) + ((_ep.z - m.vpos.z) / dt) * k;
      } else if (dt >= 1) { m.vel.x = 0; m.vel.z = 0; }
      m.pos.x = m.vpos.x = _ep.x; m.pos.y = m.vpos.y = _ep.y; m.pos.z = m.vpos.z = _ep.z;
      m.seenAt = clock; m.visible = true;
      intel = { x: _ep.x, y: _ep.y, z: _ep.z, t: clock };
    }
    // 오래된 기억 정리
    for (const [k, m] of mem) if (!m.visible && clock - m.seenAt > 25) mem.delete(k);
  }
  /** 보이는 적의 '지금' 위치 (보일 때만) */
  function livePos(m) {
    if (!m || !m.visible) return m ? m.pos : null;
    for (let i = 0; i < foes.length; i++) {
      const e = foes[i];
      if (e && (e.id ?? '#' + i) === m.id) { rv(e.pos, m.pos); m.crouch = crouchK(e.crouch); m.protect = !!e.protect; return m.pos; }
    }
    return m.pos;
  }
  /** 이번 프레임 적 목록: 팀전은 view.enemies, 개인전은 enemies + allies (자기 제외) */
  function buildFoes() {
    foes.length = 0;
    const sid = String(id);
    const en = view && Array.isArray(view.enemies) ? view.enemies : [];
    for (let i = 0; i < en.length; i++) { const e = en[i]; if (e && String(e.id) !== sid) foes.push(e); }
    if (ffa && view && Array.isArray(view.allies)) for (let i = 0; i < view.allies.length; i++) { const e = view.allies[i]; if (e && String(e.id) !== sid) foes.push(e); }
  }
  function pickTarget() {
    let best = null, bestS = Infinity;
    for (const m of mem.values()) {
      if (!m.visible || m.ignoreUntil > clock) continue;
      const d = dist3(eye, m.pos);
      const ang = Math.abs(wrap(yawOf(m.pos.x - eye.x, m.pos.z - eye.z) - yaw));
      let s = d * (1 + ang * 0.7);
      if (m.id === targetId) s *= 0.55;
      if (s < bestS) { bestS = s; best = m; }
    }
    return best;
  }
  function recentLost() {
    let best = null;
    for (const m of mem.values()) if (!m.visible && clock - m.seenAt < 10 && (!best || m.seenAt > best.seenAt)) best = m;
    return best;
  }

  /* ---------------- 경로 ---------------- */
  /**
   * goal까지 경로를 준비한다. 같은 목적·비슷한 목표의 경로가 있으면 그대로 쓴다.
   * @returns 경로가 있으면 true, 없으면(실패·방금 실패한 목표) false
   */
  function planTo(goal, purpose, force) {
    if (!goal) return false;
    const gy = num(goal.y, pos.y);
    if (!nav || typeof nav.findPath !== 'function') {
      P.pts = [{ x: goal.x, y: gy, z: goal.z }]; P.idx = 0; P.goal = { x: goal.x, y: gy, z: goal.z }; P.purpose = purpose;
      return true;
    }
    const same = P.pts && P.goal && P.purpose === purpose && dist2(P.goal, goal) < 1.5 && Math.abs(P.goal.y - gy) < 1.2;
    if (same && !force) return true;
    // 방금 실패한 목표는 1초 동안 다시 찾지 않는다(매 프레임 A* 방지)
    if (!force && P.failGoal && P.failPurpose === purpose && dist2(P.failGoal, goal) < 1.5 && clock - P.failAt < 1.0) return false;
    // 움직이는 목표: 기존 경로를 잠깐 유지 (0.25초에 한 번만 다시 계획)
    if (!force && P.pts && P.purpose === purpose && clock - P.plannedAt < 0.25) return true;
    P.plannedAt = clock;
    let pts = null;
    // 끼였던 곳은 잠시 피해서 계획 (navgrid가 모르는 장애물·막힌 통로 우회)
    let avoid = null;
    if (stk.avoid.length) { stk.avoid = stk.avoid.filter((a) => clock < a.until); if (stk.avoid.length) avoid = stk.avoid; }
    try { pts = nav.findPath(pos, goal, avoid ? { avoid } : undefined); } catch (e) { pts = null; }
    P.goal = { x: goal.x, y: gy, z: goal.z }; P.purpose = purpose;
    if (!pts || !pts.length) {
      P.pts = null; P.failAt = clock; P.failGoal = { x: goal.x, y: gy, z: goal.z }; P.failPurpose = purpose; P.failStreak++; stats.pathFails++;
      return false;
    }
    P.pts = pts; P.idx = 0; P.wpBest = Infinity; P.wpT = clock; P.shortcutT = clock; P.failStreak = 0;
    return true;
  }
  function clearPath() { P.pts = null; P.goal = null; P.idx = 0; }
  /** 현재 위치에서 q까지 곧장 걸어갈 수 있는가 (navgrid.walkStraight 정밀 검사, 없으면 칸 단위 losWalk) */
  let cutCache = { t: -1, q: null, ok: false };
  function canCut(q, fresh) {
    if (!q || q.jump || q.drop) return false;
    if (!nav) return true;
    if (!fresh && cutCache.q === q && clock - cutCache.t < 0.1) return cutCache.ok;
    let ok = avoidClear(pos, q);
    if (ok) {
      if (typeof nav.walkStraight === 'function') ok = nav.walkStraight(pos, q);
      else ok = typeof nav.losWalk === 'function' ? nav.losWalk(pos, q) : true;
    }
    cutCache = { t: clock, q, ok };
    return ok;
  }
  /** a→b 직선이 (a가 안에 있지 않은) 끼임 회피 구역을 지나지 않는가 */
  function avoidClear(a, b) {
    const zs = stk.avoid;
    if (!zs.length) return true;
    const dx = b.x - a.x, dz = b.z - a.z, L2 = dx * dx + dz * dz;
    for (const z0 of zs) {
      if (clock >= z0.until) continue;
      let t = L2 > 1e-9 ? ((z0.x - a.x) * dx + (z0.z - a.z) * dz) / L2 : 0;
      t = clamp(t, 0, 1);
      if (t <= 1e-6) continue;
      const qx = a.x + dx * t - z0.x, qz = a.z + dz * t - z0.z;
      if (qx * qx + qz * qz < z0.r * z0.r) return false;
    }
    return true;
  }
  const pathDone = () => !P.pts || P.idx >= P.pts.length;
  /** 현재 경로를 따라갈 방향을 mv에 넣는다. 경로가 끝났으면 false */
  function followPath(mv) {
    const pts = P.pts;
    if (!pts || P.idx >= pts.length) return false;
    let wp = pts[P.idx];
    for (let guard = 0; guard < pts.length + 1; guard++) {
      const dx = wp.x - pos.x, dz = wp.z - pos.z, d = hyp2(dx, dz);
      const last = P.idx === pts.length - 1;
      const rad = last ? 0.55 : (wp.jump || wp.drop ? 0.45 : 0.65);
      let passed = d < rad && Math.abs(wp.y - pos.y) < 0.9;
      if (!passed && !last && !wp.jump && !wp.drop && Math.abs(wp.y - pos.y) < 0.6) {
        const prev = P.idx > 0 ? pts[P.idx - 1] : null;
        if (prev) {
          const sx = wp.x - prev.x, sz = wp.z - prev.z, sl = hyp2(sx, sz);
          if (sl > 0.1 && ((pos.x - wp.x) * sx + (pos.z - wp.z) * sz) / sl > 0.05 && d < 2.0) passed = true;
        }
      }
      // 모서리 자르기 확인: 지금 자리에서 다음 경유점까지 실제로 걸어갈 수 있을 때만 일찍 넘긴다
      if (passed && !last && d > 0.18 && !canCut(pts[P.idx + 1])) passed = false;
      if (!passed) break;
      P.idx++; P.wpBest = Infinity; P.wpT = clock;
      if (P.idx >= pts.length) return false;
      wp = pts[P.idx];
    }
    // 가끔 다음 경유점이 바로 걸어갈 수 있으면 건너뛰기 (교전 중 밀려났을 때 등)
    if (nav && clock - P.shortcutT > 0.5 && P.idx + 1 < pts.length) {
      P.shortcutT = clock;
      const nx = pts[P.idx + 1];
      if (!wp.jump && !wp.drop && !nx.jump && !nx.drop && Math.abs(nx.y - pos.y) < 0.5 && canCut(nx, true)) { P.idx++; wp = nx; P.wpBest = Infinity; P.wpT = clock; }
    }
    const dx = wp.x - pos.x, dz = wp.z - pos.z, d = hyp2(dx, dz) || 1;
    mv.x = dx / d; mv.z = dz / d; mv.on = true;
    if (wp.jump && pos.y < num(wp.jumpTop, wp.y) - 0.3) {
      // 도약(아직 턱 아래일 때만): 속도가 착지 쪽을 향한 채 도약 지점(jumpAt, 벽에 닿기 직전) 0.9 m 안,
      // 또는 벽에 막혀 거의 섰을 때. 모서리를 돌자마자(속도 방향이 다를 때) 뛰면 벽을 따라 미끄러져 놓친다.
      const ja = wp.jumpAt;
      const dj = ja ? hyp2(ja.x - pos.x, ja.z - pos.z) : Math.max(0, d - 0.9);
      const sp = hyp2(vel.x, vel.z);
      const aligned = sp > 1.5 && (vel.x * mv.x + vel.z * mv.z) / sp > 0.85;
      if ((aligned && dj < 0.9) || (sp < 0.8 && dj < 0.8)) mv.jump = true;
    }
    if (wp.drop && d < 1.6) mv.walk = true;
    if (d < P.wpBest - 0.3) { P.wpBest = d; P.wpT = clock; }
    return true;
  }
  /** 경로 앞쪽(바라볼 곳) */
  function lookAhead() {
    const pts = P.pts;
    if (!pts || P.idx >= pts.length) return null;
    let i = P.idx, acc = 0, px = pos.x, pz = pos.z;
    for (; i < pts.length; i++) {
      acc += hyp2(pts[i].x - px, pts[i].z - pz);
      px = pts[i].x; pz = pts[i].z;
      if (acc > 5) break;
    }
    const q = pts[Math.min(i, pts.length - 1)];
    return { x: q.x, y: q.y + EYE, z: q.z };
  }
  function snap(p, maxD) {
    if (!nav || !nav.nearestWalkable) return p;
    const q = nav.nearestWalkable(p, maxD || 6);
    return q ? { x: q.x, y: q.y, z: q.z } : p;
  }

  /* ---------------- 순찰 계획 ---------------- */
  function centroid(list) {
    if (!list || !list.length) return null;
    let x = 0, y = 0, z = 0;
    for (const s of list) { x += num(s.x, 0); y += num(s.y, 0); z += num(s.z, 0); }
    return { x: x / list.length, y: y / list.length, z: z / list.length };
  }
  function laneName() {
    if (o.lane) return o.lane;
    if (ffa) return 'center';
    const ids = [String(id)];
    if (view && Array.isArray(view.allies)) for (const a of view.allies) if (a && a.id != null && String(a.id) !== String(id)) ids.push(String(a.id));
    ids.sort();
    const n = ids.length, i = ids.indexOf(String(id));
    const t = LANE_TABLE[n] || ['left', 'center', 'right'];
    return t[i % t.length];
  }
  function setupPlan() {
    plan.ready = true;
    plan.route = []; plan.routeIdx = 0; plan.holdUntil = 0; plan.holdSpot = null; plan.visited = [];
    const sp = nav && nav.spawns ? nav.spawns : null;
    const other = team === 'owner' ? 'charterer' : 'owner';
    if (ffa) {
      // 개인전: 진격로 없음. 기준점 = 내 자리 → 맵 가운데. 순찰은 요충지·정보 위주(nextRoamGoal)
      plan.ownC = { x: pos.x, y: pos.y, z: pos.z };
      plan.enemyC = mapCenter();
      plan.lane = 'center';
      if (nav && isSniper) { const spot = pickSniperSpot(-Infinity, Infinity); if (spot) plan.route.push(spot); }
      return;
    }
    plan.ownC = centroid(sp && sp[team]) || { x: pos.x, y: pos.y, z: pos.z };
    plan.enemyC = centroid(sp && sp[other]) || { x: -pos.x, y: pos.y, z: -pos.z };
    plan.lane = laneName();
    if (!nav) { plan.route = [plan.enemyC]; return; }
    if (isSniper) {
      const spot = pickSniperSpot(0.08, 0.55);
      if (spot) plan.route.push(spot);
      return;
    }
    const lanes = nav.lanes ? nav.lanes(plan.ownC, plan.enemyC) : null;
    const via = lanes && lanes[plan.lane] ? lanes[plan.lane] : [];
    for (const p of via) plan.route.push({ x: p.x, y: p.y, z: p.z });
    const end = nav.randomPoint ? nav.randomPoint({ x: plan.enemyC.x, z: plan.enemyC.z, r: 10 }, rng) : null;
    plan.route.push(end || plan.enemyC);
  }
  /** 맵 가운데(걸을 수 있는 곳으로) */
  function mapCenter() {
    const b = nav && nav.bounds;
    const c = b ? { x: (b.minX + b.maxX) / 2, y: 0, z: (b.minZ + b.maxZ) / 2 } : { x: 0, y: 0, z: 0 };
    return snap(c, 20);
  }
  /** 맵 축(우리 스폰 → 적 스폰) 위 진행도 0..1, 옆 방향 부호 */
  function axisInfo(p) {
    const a = plan.ownC, b = plan.enemyC;
    const ax = b.x - a.x, az = b.z - a.z, L2 = ax * ax + az * az || 1;
    const t = ((p.x - a.x) * ax + (p.z - a.z) * az) / L2;
    const side = ((p.x - a.x) * (-az) + (p.z - a.z) * ax) / Math.sqrt(L2); // + = 오른쪽
    return { t, side };
  }
  function pickSniperSpot(t0, t1) {
    if (!nav || !Array.isArray(nav.points) || !nav.points.length) return null;
    const dirx = plan.enemyC.x - plan.ownC.x, dirz = plan.enemyC.z - plan.ownC.z, L = hyp2(dirx, dirz) || 1;
    const scored = [];
    for (const p of nav.points) {
      if (plan.visited.some((v) => dist2(v, p) < 6)) continue;
      if (ffa) {
        // 개인전: 어디서 올지 모르니 전체적으로 트인 곳, 가까운 곳(50 m 안) 우선
        const dd = dist2(p, pos);
        if (dd > 50) continue;
        scored.push({ p, s: p.far * 0.4 + p.open * 0.5 + (p.elev ? 12 : 0) - p.cover * 5 - dd * 0.15 + rng() * 6 });
        continue;
      }
      const ai = axisInfo(p);
      if (ai.t < t0 || ai.t > t1) continue;
      if (plan.lane === 'left' && ai.side > 4) continue;
      if (plan.lane === 'right' && ai.side < -4) continue;
      const look = nav.sightToward ? nav.sightToward(p, dirx / L, dirz / L) : p.open;
      const s = look * 1.0 + p.far * 0.25 + p.open * 0.3 + (p.elev ? 12 : 0) - p.cover * 5 + rng() * 6;
      scored.push({ p, s });
    }
    if (!scored.length) return null;
    scored.sort((a, b) => b.s - a.s);
    const pick = scored[Math.min(scored.length - 1, Math.floor(rng() * Math.min(3, scored.length)))].p;
    return { x: pick.x, y: pick.y, z: pick.z, spot: pick };
  }
  function bestSightYaw(spot) {
    const toE = yawOf(plan.enemyC.x - spot.x, plan.enemyC.z - spot.z);
    if (!spot.spot || !spot.spot.dist || !nav.sightToward) return toE;
    let best = toE, bestS = -1;
    for (let k = -4; k <= 4; k++) {
      const y = toE + k * 12 * DEG;
      const fx = -Math.sin(y), fz = -Math.cos(y);
      const s = nav.sightToward(spot.spot, fx, fz) * (1 - Math.abs(k) * 0.06);
      if (s > bestS) { bestS = s; best = y; }
    }
    return best;
  }
  function nextRoamGoal() {
    if (!nav) return plan.enemyC;
    const tRound = clock - roundStart;
    // 내가 마지막으로 본·들은 곳 근처 (30초 이내 정보)
    if (intel && clock - intel.t < 30 && rng() < 0.75 && nav.randomPoint) {
      const q = nav.randomPoint({ x: intel.x, z: intel.z, r: 10 }, rng);
      if (q && dist2(q, pos) > 6) return q;
    }
    // 라운드 후반(개인전은 늘): 맵 가운데 쪽으로 (숨바꼭질 방지)
    if ((ffa || tRound > 45) && rng() < (ffa ? 0.5 : 0.6) && nav.randomPoint) {
      const c = { x: (plan.ownC.x + plan.enemyC.x) / 2, z: (plan.ownC.z + plan.enemyC.z) / 2 };
      const q = nav.randomPoint({ x: c.x, z: c.z, r: 20 }, rng);
      if (q && dist2(q, pos) > 6) return q;
    }
    if (isSniper && rng() < 0.7) {
      const s = pickSniperSpot(0.25, 0.85);
      if (s) return s;
    }
    const pts = Array.isArray(nav.points) ? nav.points : [];
    for (let t = 0; t < 12 && pts.length; t++) {
      const p = pts[Math.floor(rng() * pts.length)];
      const d = dist2(p, pos);
      if (d < 12 || d > 70) continue;
      if (plan.visited.some((v) => dist2(v, p) < 8)) continue;
      return { x: p.x, y: p.y, z: p.z };
    }
    return nav.randomPoint ? nav.randomPoint(null, rng) : plan.enemyC;
  }

  /* ---------------- 끼임 감지·복구 ---------------- */
  /** 막혔던 방향들을 피해서 탈출 방향을 고른다 (navgrid가 아는 정적 지형도 확인) */
  function chooseEscape(dist) {
    const near = stk.blocked.filter((b) => clock - b.t < 15 && hyp2(b.x - pos.x, b.z - pos.z) < 4);
    let best = null, bestS = -Infinity;
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * TAU + rng() * 0.25, dx = Math.cos(a), dz = Math.sin(a);
      let sc = rng() * 0.3;
      for (const b of near) sc -= Math.max(0, dx * b.dx + dz * b.dz) * 2.2;
      const q = { x: pos.x + dx * dist, y: pos.y, z: pos.z + dz * dist };
      if (nav && nav.walkStraight && !nav.walkStraight(pos, q)) sc -= 3;
      if (sc > bestS - 3 && !probeOpen(dx, dz, 2.5)) sc -= 3;   // 눈에 보이는 벽(엔진 시야선) 확인
      if (sc > bestS) { bestS = sc; best = q; }
    }
    return best;
  }
  /** 무릎·허리 높이로 짧게 시야선을 찔러 그 방향이 트였는지 본다 (지형은 보이는 정보) */
  function probeOpen(dx, dz, d) {
    return los(pos.x, pos.y + 0.7, pos.z, pos.x + dx * d, pos.y + 0.7, pos.z + dz * d) &&
      los(pos.x, pos.y + 1.4, pos.z, pos.x + dx * d, pos.y + 1.4, pos.z + dz * d);
  }
  /** 옆걸음(+점프) 복구: 막힌 방향의 수직 방향, 조금 뒤로 */
  function startSidestep(dur, side) {
    const bl = hyp2(stk.lastDir.x, stk.lastDir.z);
    const bx = bl > 0.1 ? stk.lastDir.x / bl : -Math.sin(yaw), bz = bl > 0.1 ? stk.lastDir.z / bl : -Math.cos(yaw);
    // 트인 쪽으로 (양쪽 다 막혔으면 주어진 쪽)
    if (!probeOpen(-bz * side, bx * side, 1.5) && probeOpen(bz * side, -bx * side, 1.5)) side = -side;
    stk.side = side;
    let x = -bz * side - bx * 0.3, z = bx * side - bz * 0.3;
    const l = hyp2(x, z) || 1;
    stk.rec = { dx: x / l, dz: z / l, fromX: pos.x, fromZ: pos.z, need: 0.4 };
    stk.recoverUntil = clock + dur;
  }
  function startEscape() {
    const e = chooseEscape(3.5);
    if (!e) { startSidestep(0.8, -stk.side); return; }
    const dx = e.x - pos.x, dz = e.z - pos.z, l = hyp2(dx, dz) || 1;
    stk.escape = e; stk.escapeUntil = clock + 1.4;
    stk.rec = { dx: dx / l, dz: dz / l, fromX: pos.x, fromZ: pos.z, need: 1.0, escape: true };
  }
  /** 복구 동작이 끝났을 때 실제로 움직였는지 보고, 못 움직였으면 그 방향도 '막힘'으로 기억 */
  function evalRecovery() {
    const r = stk.rec;
    if (!r) return;
    const active = r.escape ? (stk.escape && clock < stk.escapeUntil) : clock < stk.recoverUntil;
    if (active) return;
    stk.rec = null;
    const moved = hyp2(pos.x - r.fromX, pos.z - r.fromZ);
    if (moved < r.need) {
      stk.blocked.push({ x: pos.x, z: pos.z, dx: r.dx, dz: r.dz, t: clock });
      if (stk.blocked.length > 8) stk.blocked.shift();
      if (r.escape && ++stk.escTries < 4) startEscape(); // 다른 방향으로 다시 탈출
    }
  }
  function stuckEvent() {
    stats.stuck++;
    stk.level++;
    stk.credited = false;
    stk.at = { x: pos.x, z: pos.z };
    stk.lastEvent = clock;
    stk.moveT = 0;
    stk.ring.length = 0;
    P.wpT = clock; P.wpBest = Infinity;
    // 가려던 방향을 '막힌 방향'으로 기억 + 그 앞을 20초 동안 피하는 구역으로 (navgrid가 모르는 장애물·사람 막힘)
    const bl = hyp2(stk.lastDir.x, stk.lastDir.z);
    if (bl > 0.1) {
      const dx = stk.lastDir.x / bl, dz = stk.lastDir.z / bl;
      stk.blocked.push({ x: pos.x, z: pos.z, dx, dz, t: clock });
      if (stk.blocked.length > 8) stk.blocked.shift();
      stk.avoid.push({ x: pos.x + dx * 0.6, z: pos.z + dz * 0.6, r: 1.8, cost: 40, until: clock + 20 });
      if (stk.avoid.length > 6) stk.avoid.shift();
    }
    if (stk.level === 1) {
      startSidestep(0.6, rng() < 0.5 ? -1 : 1);
    } else if (stk.level === 2) {
      if (P.goal) planTo(P.goal, P.purpose, true);   // 피할 구역을 넣고 다시 계획
      startSidestep(0.4, -stk.side);
    } else if (stk.level === 3) {
      stk.escTries = 0;
      startEscape();
    } else {
      stats.abandoned++;
      stk.level = 0; stk.escape = null;
      clearPath();
      if (mode === 'patrol') { plan.routeIdx++; plan.holdUntil = 0; hunt.goal = null; hunt.nextAt = 0; }
      else if (mode === 'chase') chase = null;
      else if (mode === 'investigate') investigate = null;
      else if (mode === 'cover') cover = null;
    }
  }
  function stuckUpdate(dt, wantsMove) {
    if (clock - stk.sampleT >= 0.25) {
      stk.ring.push({ x: pos.x, z: pos.z, t: clock });
      if (stk.ring.length > 10) stk.ring.shift();
      stk.sampleT = clock;
    }
    stk.moveT = wantsMove ? stk.moveT + dt : 0;
    if (stk.level > 0 && stk.at) {
      // 3 m 벗어나면 '복구'로 센다(통계). 단계는 6초 동안 새 끼임이 없을 때만 낮춘다 —
      // 옆걸음+점프로 잠깐 밀려난 것만으로 단계를 지우면 같은 벽에서 1단계만 되풀이한다(높아진 점프)
      if (!stk.credited && hyp2(pos.x - stk.at.x, pos.z - stk.at.z) > 3) { stats.recovered++; stk.credited = true; }
      if (clock - stk.lastEvent > 6) { stk.level = 0; stk.escape = null; }
    }
    if (!wantsMove || clock < stk.recoverUntil) return;
    let old = null;
    for (let i = stk.ring.length - 1; i >= 0; i--) if (clock - stk.ring[i].t >= 1.0) { old = stk.ring[i]; break; }
    if (stk.moveT > 1.2 && old && hyp2(pos.x - old.x, pos.z - old.z) < 0.35) { stuckEvent(); return; }
    if (P.pts && P.idx < P.pts.length && clock - P.wpT > 3.2 && stk.moveT > 3) stuckEvent();
  }

  /* ---------------- 무기 상태 읽기 ---------------- */
  function readWeapon(self) {
    const a = self.ammo;
    let mag = null, reserve = null, reloading = null;
    if (isNum(a)) mag = a;
    else if (a && typeof a === 'object') {
      mag = num(a.mag ?? a.clip ?? a.current ?? a.inMag, null);
      reserve = num(a.reserve ?? a.spare ?? a.total, null);
      if (typeof a.reloading === 'boolean') reloading = a.reloading;
    }
    if (mag === null) mag = wpn.estMag[curSlot] ?? null;
    else if (curSlot === 1 || curSlot === 2) wpn.estMag[curSlot] = mag;
    if (reserve !== null && (curSlot === 1 || curSlot === 2)) wpn.estRes[curSlot] = reserve;
    let state = null;
    const w = self.weapon;
    if (w && typeof w === 'object' && typeof w.state === 'string') state = w.state;
    if (reloading === null && state) reloading = state === 'reload';
    if (reloading === null) reloading = clock < wpn.reloadUntil;
    let zoomP = null;
    if (isNum(self.zoom)) zoomP = self.zoom;
    else if (self.zoom && typeof self.zoom === 'object' && isNum(self.zoom.progress)) zoomP = self.zoom.progress;
    let gren = isNum(self.grenades) ? self.grenades : wpn.grenades;
    return { mag, reserve, reloading, state, zoomP, gren };
  }

  /* ---------------- 조준 ---------------- */
  /** 목표 방향으로 지수 수렴 (rate 1/s, maxTurn rad/s) */
  function turnToward(out, tYaw, tPitch, rate, maxTurn, dt) {
    const k = 1 - Math.exp(-rate * dt);
    let dy = wrap(tYaw - yaw) * k, dp = (clamp(tPitch, -1.45, 1.45) - pitch) * k;
    const lim = maxTurn * dt;
    const m = Math.max(Math.abs(dy), Math.abs(dp));
    if (m > lim) { dy *= lim / m; dp *= lim / m; }
    out.yawDelta = dy; out.pitchDelta = dp;
  }
  function lookAtPoint(out, p, rate, maxTurn, dt) {
    const dx = p.x - eye.x, dz = p.z - eye.z;
    if (hyp2(dx, dz) < 0.05) return;
    turnToward(out, yawOf(dx, dz), Math.atan2(p.y - eye.y, hyp2(dx, dz)), rate, maxTurn, dt);
  }
  /** 사람처럼 흔들리는 조준점(오차는 Ornstein-Uhlenbeck 과정) */
  function aimPoint(m, tp, dt, selfSpeed) {
    const d = dist3(eye, tp);
    if (aim.lastTarget !== m.id) { aim.lastTarget = m.id; aim.ex = gauss() * 0.6; aim.ey = gauss() * 0.3; }
    const since = clock - m.acquiredAt;
    const settle = 1 + 1.0 * Math.exp(-since / Math.max(0.05, D.settle));
    const tSpeed = hyp2(m.vel.x, m.vel.z);
    const moveMul = 1 + 0.45 * Math.min(1.2, selfSpeed / WALK_SPEED) + 0.35 * Math.min(1.2, tSpeed / WALK_SPEED);
    const head = aim.head || m.part === 2;          // 머리만 보이면 머리를 겨눈다
    const scoped = isSniper && curSlot === homeSlot && wpn.zoomStart >= 0;
    const sigma = (D.aimErr + D.aimErrPerM * d) * settle * moveMul * (head ? 0.7 : 1) * (scoped ? 0.65 : 1);
    const th = 2.5;
    const sq = Math.sqrt(2 * th * dt);
    aim.ex += -aim.ex * th * dt + sigma * sq * gauss();
    aim.ey += -aim.ey * th * dt + sigma * 0.55 * sq * gauss();
    const ck = m.crouch || 0;                          // 앉은 적: 머리 1.12(HITBOX_CROUCH), 몸통도 비례로 낮춘다
    const baseY = crouchY(head ? HEAD_Y : num(D.bodyY, BODY_Y), ck);
    const ey = head ? aim.ey : clamp(aim.ey, -0.2 + 0.02 * ck, 0.18 - 0.02 * ck);
    // 이동 예측(난이도별 일부만)
    const lead = D.lead * Math.min(0.25, d / 400);
    const dx = tp.x - eye.x, dz = tp.z - eye.z, l = hyp2(dx, dz) || 1;
    const px = -dz / l, pz = dx / l; // 시선에 수직인 수평 방향
    return {
      x: tp.x + px * aim.ex + m.vel.x * lead,
      y: tp.y + baseY + ey,
      z: tp.z + pz * aim.ex + m.vel.z * lead,
      d
    };
  }
  /** 실제 총구 방향(시선 + 반동)과 조준점 사이 각도 */
  function aimError(p) {
    const dx = p.x - eye.x, dz = p.z - eye.z, dy = p.y - eye.y;
    const ty = yawOf(dx, dz), tp = Math.atan2(dy, hyp2(dx, dz));
    const ey = wrap(ty - (yaw + rk.yaw)) * Math.cos(pitch), ep = tp - (pitch + rk.pitch);
    return Math.sqrt(ey * ey + ep * ep);
  }
  function recoilUpdate(self, dt) {
    const r = self.recoil;
    if (r && (isNum(r.pitch) || isNum(r[1]))) {
      rk.ext = true;
      rk.yaw = num(r.yaw ?? r[0], 0); rk.pitch = num(r.pitch ?? r[1], 0);
      return;
    }
    rk.ext = false;
    const c = rk.kickCfg;
    if (c && clock - rk.lastShot > c.recoverDelay) {
      const k = Math.exp(-c.recover * dt);
      rk.yaw *= k; rk.pitch *= k;
    }
  }
  function recoilShot(info, n) {
    if (rk.ext || !info || !info.kick) return;
    rk.kickCfg = info; rk.lastShot = clock;
    rk.pitch = Math.min(10 * DEG, rk.pitch + info.kick * n);
  }
  function allyInLine(tp) {
    if (ffa || !view || !Array.isArray(view.allies)) return false;
    const dx = tp.x - eye.x, dy = tp.y - eye.y, dz = tp.z - eye.z, L = Math.hypot(dx, dy, dz) || 1;
    for (const a of view.allies) {
      if (!a || a.alive === false || String(a.id) === String(id)) continue;
      const q = rv(a.pos);
      const qx = q.x - eye.x, qy = q.y + 1.1 - eye.y, qz = q.z - eye.z;
      const t = (qx * dx + qy * dy + qz * dz) / L;
      if (t <= 0 || t >= L - 0.5) continue;
      const cx = qx - dx / L * t, cy = qy - dy / L * t, cz = qz - dz / L * t;
      if (cx * cx + cz * cz < 0.45 * 0.45 && Math.abs(cy) < 1.0) return true;
    }
    return false;
  }

  /* ---------------- 엄폐 ---------------- */
  function findCover(threat) {
    if (!nav || typeof nav.coverCandidates !== 'function') return null;
    let cands;
    try { cands = nav.coverCandidates(pos, 14, 16); } catch (e) { return null; }
    const dNow = dist2(pos, threat);
    let checks = 0, low = null;
    for (const c of cands) {
      if (dist2(c, threat) < Math.min(dNow - 1.5, 6)) continue; // 적 쪽으로 다가가는 엄폐는 피한다
      if (checks++ >= 10) break;
      if (!los(c.x, c.y + EYE, c.z, threat.x, threat.y + EYE, threat.z) && !los(c.x, c.y + 1.0, c.z, threat.x, threat.y + EYE, threat.z)) return c;
      // 낮은 엄폐(앉으면 숨음): 엔진이 앉기를 지원할 때만 후보로
      if (!low && crouchSupported && !los(c.x, c.y + CROUCH_EYE, c.z, threat.x, threat.y + EYE, threat.z) && !los(c.x, c.y + 0.75, c.z, threat.x, threat.y + EYE, threat.z)) low = Object.assign({ crouch: true }, c);
    }
    return low;
  }

  /* ---------------- 리셋 ---------------- */
  let keepIntel = false;           // 개인전 부활: 죽기 전에 본·들은 정보는 기억
  let pendingPrimary = null;       // setLoadout으로 예약한 다음 목숨 무기
  function resetRound() {
    roundId++;
    mem.clear(); targetId = null; sounds.length = 0; alert = null; roundStart = clock;
    if (!keepIntel) intel = null;
    keepIntel = false; wantCrouch = false;
    clearPath(); chase = null; investigate = null; search = null; cover = null;
    plan.ready = false; plan.lane = o.lane || null;
    stk.ring.length = 0; stk.level = 0; stk.escape = null; stk.moveT = 0; stk.avoid.length = 0; stk.blocked.length = 0; stk.rec = null;
    wpn.wantSlot = homeSlot; wpn.boltUntil = 0; wpn.zoomStart = -1; wpn.burstEnd = -1; wpn.gr = null; wpn.grenades = canUse(4) ? 1 : 0;
    wpn.estMag = freshMags(); wpn.estRes = freshReserves(); wpn.reloadUntil = 0;
    wpn.preStop = -1; wpn.nextBurst = 0; wpn.nextTap = 0; wpn.pendingReload = null; wpn.pulseStop = false; wpn.heavyNext = false;
    rk.yaw = 0; rk.pitch = 0; rk.kickCfg = null;
    eng.strafeDir = 0; eng.advance = false; eng.blockSince = -1; eng.nextHop = 0; lastCoverTry = -99; damagedAt = -99;
    hunt.goal = null; hunt.targetId = null; hunt.nextAt = 0; hunt.skip.clear(); flight = false; P.failStreak = 0;
    objHold = false;
    plan.laneChecked = false;
    setMode('patrol');
  }

  /* ---------------- 메인 ---------------- */
  const IDLE = () => ({ forward: 0, strafe: 0, jump: false, walk: false, yawDelta: 0, pitchDelta: 0, fire: false, zoom: false, reload: false, slot: null });

  function think(dtIn, v) {
    const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
    const out = thinkInner(dtIn, v);
    if (t0) { stats.thinkMs += performance.now() - t0; stats.thinks++; }
    return out;
  }

  function thinkInner(dtIn, v) {
    const dt = clamp(num(dtIn, 1 / 60), 0, 0.1);
    clock += dt;
    lastDt = dt;
    view = v || {};
    nav = view.nav || null;
    const self = view.self || {};
    const out = IDLE();
    if (self.alive === false) { if (alive) { alive = false; } return out; }
    rv(self.pos, pos);
    if (!alive || (haveLast && dist2(pos, lastPos) > 12)) { if (alive || haveLast) resetRound(); alive = true; haveLast = false; }
    yaw = num(self.yaw, 0); pitch = num(self.pitch, 0);
    hp = num(self.hp, 100);
    crouchSupported = typeof self.crouch === 'boolean' || isNum(self.crouch);
    selfCrouchK = crouchK(self.crouch);
    if (isNum(self.slot)) { if (self.slot !== curSlot) { wpn.drawUntil = clock + (W[slotWeapon(self.slot)].draw || 0.5); } curSlot = self.slot; }
    // 엔진이 실제로 든 무기를 알려 주면 그 값을 믿는다(라운드 로드아웃으로 바뀌었을 수 있다)
    const heldId = self.weapon && typeof self.weapon === 'object' ? self.weapon.id : null;
    if (heldId && heldId !== gear[curSlot] && pickIn(heldId, curSlot)) { gear[curSlot] = heldId; if (curSlot === homeSlot) refreshRole(); }
    // 발판으로 날아가는 중: 착지하면 경로를 새로 잡는다(날기 전 경로는 이어지지 않는다)
    if (flight && clock - flightAt > 0.2 && (self.onGround === true || clock - flightAt > 5)) {
      flight = false;
      clearPath();
      P.failStreak = 0;
      stk.ring.length = 0; stk.moveT = 0;
    }
    eye.x = pos.x; eye.y = pos.y + EYE + (CROUCH_EYE - EYE) * selfCrouchK; eye.z = pos.z;
    if (haveLast && dt > 0) {
      const k = Math.min(1, dt * 12);
      vel.x += ((pos.x - lastPos.x) / dt - vel.x) * k;
      vel.z += ((pos.z - lastPos.z) / dt - vel.z) * k;
    }
    if (self.vel) { const q = rv(self.vel); vel.x = q.x; vel.z = q.z; }
    lastPos.x = pos.x; lastPos.y = pos.y; lastPos.z = pos.z; haveLast = true;
    const speed = hyp2(vel.x, vel.z);
    if (!plan.ready) { setupPlan(); plan.setupAt = clock; }
    else if (!o.lane && !plan.laneChecked && clock - plan.setupAt > 1.0) {
      // 아군 목록이 늦게 채워지는 경우: 1초 뒤 한 번 더 확인해 첫 진격로를 다시 배정
      plan.laneChecked = true;
      if (laneName() !== plan.lane && mode === 'patrol' && plan.routeIdx === 0 && !plan.holdSpot) { setupPlan(); plan.laneChecked = true; clearPath(); }
    }
    alliesKnown.length = 0;
    if (!ffa && Array.isArray(view.allies)) for (const a of view.allies) if (a && a.alive !== false) alliesKnown.push(rv(a.pos));
    buildFoes();
    readObjective(view.objective);

    // 피격 감지
    if (hp < lastHp - 0.5) {
      damagedAt = clock;
      if (!pickTarget()) {
        const s = sounds.length ? sounds[sounds.length - 1] : null;
        if (s && clock - s.t < 3) alert = { x: s.x, y: s.y + 1.2, z: s.z, until: clock + 1.5 };
        else { const by = yaw + Math.PI + rand(-0.6, 0.6); alert = { x: eye.x - Math.sin(by) * 10, y: eye.y, z: eye.z - Math.cos(by) * 10, until: clock + 1.5 }; }
      }
    }
    lastHp = hp;

    // 지각
    const enemies = foes;
    if (clock >= nextPerceive) { perceive(enemies, true); nextPerceive = clock + (1 / D.perceiveHz) * rand(0.85, 1.15); nextTrack = clock + 0.05; }
    else if (targetId != null && clock >= nextTrack) { perceive(enemies, false); nextTrack = clock + 0.05; }
    while (sounds.length && clock - sounds[0].t > 12) sounds.shift();

    const W0 = readWeapon(self);
    recoilUpdate(self, dt);
    const tgt = pickTarget();
    if (tgt) { if (targetId !== tgt.id) { targetId = tgt.id; aim.rollT = 0; } }
    else if (targetId != null && !(mem.get(targetId) && mem.get(targetId).visible)) targetId = null;

    /* ---- 상태 전이 ---- */
    if (tgt) {
      const tp = livePos(tgt);
      const lowHp = hp <= D.lowHp;
      const needReload = W0.mag === 0 && curSlot === homeSlot;
      if (!meleeOnly && mode !== 'cover' && clock - lastCoverTry > 6 && (lowHp || (needReload && difficulty !== 'easy' && dist3(eye, tp) > 10))) {
        lastCoverTry = clock;
        const c = findCover(tp);
        if (c) { cover = { pt: c, threat: { x: tp.x, y: tp.y, z: tp.z }, phase: 'move', until: clock + 6 }; stats.covers++; setMode('cover'); planTo(c, 'cover', true); }
        else setMode('engage');
      } else if (mode !== 'cover') setMode('engage');
      chase = null; search = null;
      if (mode === 'cover' && cover) { cover.threat.x = tp.x; cover.threat.y = tp.y; cover.threat.z = tp.z; }
    } else {
      const lost = recentLost();
      if (mode === 'engage') {
        if (lost) startChase(lost);
        else setMode('patrol');
      }
      if (mode === 'cover' && !cover) setMode('patrol');
      if (mode === 'chase' && (!chase || clock > chase.until)) { chase = null; setMode('patrol'); }
      if (mode === 'investigate' && (!investigate || clock > investigate.until)) { investigate = null; setMode('patrol'); }
      if (mode === 'patrol' || mode === 'investigate') {
        const s = sounds.length ? sounds[sounds.length - 1] : null;
        if (s && clock - s.t < 6 && (!investigate || investigate.t < s.t)) startInvestigate(s);
        else if (mode === 'patrol' && lost && clock - lost.seenAt < 6 && !lost.chased) startChase(lost);
      }
      // 급한 목표(폭탄 설치하러 가기·해체하러 가기)가 있으면 소리 조사·추적보다 목표가 먼저다
      if (objective && objective.urgent && (mode === 'investigate' || mode === 'chase')) {
        investigate = null; chase = null; search = null;
        clearPath();
        setMode('patrol');
      }
    }

    /* ---- 이동·시점 결정 ---- */
    const mv = { x: 0, z: 0, on: false, jump: false, walk: false, stop: false };
    let look = null;                 // {x,y,z} 바라볼 곳
    let lookRate = D.aimRate * 0.6, lookMax = D.idleTurn;
    let combat = null;               // {m, tp, ap}

    if (mode === 'engage' && tgt) {
      const tp = livePos(tgt);
      const ap = aimPoint(tgt, tp, dt, speed);
      combat = { m: tgt, tp, ap };
      look = ap; lookRate = D.aimRate; lookMax = D.maxTurn;
      engageMove(mv, tgt, tp, ap.d, W0);
    } else if (mode === 'cover' && cover) {
      if (tgt) {
        const tp = livePos(tgt);
        const ap = aimPoint(tgt, tp, dt, speed);
        combat = { m: tgt, tp, ap };
        look = ap; lookRate = D.aimRate; lookMax = D.maxTurn;
      } else look = { x: cover.threat.x, y: cover.threat.y + EYE, z: cover.threat.z };
      if (cover.phase === 'move') {
        const ok = planTo(cover.pt, 'cover', false);
        if (!ok || !followPath(mv) || dist2(pos, cover.pt) < 0.8 || clock - modeSince > 7) {
          cover.phase = 'wait'; cover.until = clock + (ok ? rand(1.5, 3.0) : 1.0); clearPath();
        }
      } else {
        mv.stop = true;
        if (clock > cover.until && !W0.reloading) {
          const th = cover.threat;
          cover = null;
          const lost = recentLost();
          if (tgt) setMode('engage');
          else if (lost) startChase(lost);
          else setMode('patrol');
          if (!lost && !tgt) { investigate = { goal: snap(th, 6), src: { x: th.x, y: th.y, z: th.z }, until: clock + 10, t: clock }; clearPath(); setMode('investigate'); }
        }
      }
    } else if (mode === 'chase' && chase) {
      look = chase.lookAt;
      if (!search) {
        if (isSniper && clock - modeSince < chase.holdFor) mv.stop = true; // 저격수: 잠시 그 각을 계속 겨눈다
        else {
          const ok = planTo(chase.goal, 'chase', false);
          const moving = ok && followPath(mv);
          if (!moving || dist2(pos, chase.goal) < 1.2) { search = { until: clock + (meleeOnly ? rand(0.4, 0.8) : rand(1.6, 2.8)), nextLook: 0, lookYaw: yaw }; clearPath(); }
          else if (difficulty === 'hard' && !meleeOnly && dist2(pos, chase.goal) < 8) mv.walk = true; // 마지막 위치 근처는 천천히(탄퍼짐↓)
        }
      } else {
        mv.stop = true;
        if (clock >= search.nextLook) { search.nextLook = clock + rand(0.5, 0.9); search.lookYaw = yaw + rand(-2.2, 2.2); }
        look = { x: eye.x - Math.sin(search.lookYaw) * 10, y: eye.y, z: eye.z - Math.cos(search.lookYaw) * 10 };
        if (clock > search.until) { search = null; chase = null; setMode('patrol'); }
      }
    } else if (mode === 'investigate' && investigate) {
      const s = investigate.goal;
      look = { x: investigate.src.x, y: investigate.src.y + 1.2, z: investigate.src.z };
      const holdSniper = isSniper && plan.holdSpot && dist2(pos, s) > 22;
      if (holdSniper) { mv.stop = true; if (clock - investigate.t > 5) { investigate = null; setMode('patrol'); } }
      else {
        const src = investigate.src, heardAt = investigate.t;
        const ok = planTo(s, 'investigate', false);
        if (!ok || !followPath(mv) || dist2(pos, s) < 1.5) { investigate = null; setMode('patrol'); search = null; clearPath(); }
        else if (dist2(pos, src) > 6 && clock - heardAt >= 1.2) look = lookAhead() || look; // 처음엔 소리 쪽을 보고, 이동 중엔 앞을 본다
      }
    } else {
      // 순찰
      setMode('patrol');
      patrolMove(mv);
      look = objHold ? objectiveLook() : plan.holdSpot && clock < plan.holdUntil ? holdLook() : (lookAhead() || null);
    }
    if (alert && clock < alert.until && !combat) { look = alert; lookRate = D.aimRate; lookMax = D.maxTurn; }
    else if (alert && clock >= alert.until) alert = null;

    evalRecovery();
    if (mv.on && !mv.stop && !(clock < stk.recoverUntil) && !(stk.escape && clock < stk.escapeUntil)) { stk.lastDir.x = mv.x; stk.lastDir.z = mv.z; }
    // 경로를 계속 못 찾으면(걷기 칸이 이어지지 않는 곳에 갇혔을 때) 서 있지 않고 트인 쪽으로 움직여 본다
    if (P.failStreak >= PATH_FAIL_WANDER && !flight && !stk.escape && mode !== 'engage') {
      P.failStreak = 0;
      stk.escTries = 0;
      startEscape();
    }
    /* ---- 끼임 복구 덮어쓰기 ---- */
    if (stk.escape && clock < stk.escapeUntil && mode !== 'engage') {
      const dx = stk.escape.x - pos.x, dz = stk.escape.z - pos.z, l = hyp2(dx, dz);
      if (l > 0.5) { mv.x = dx / l; mv.z = dz / l; mv.on = true; mv.stop = false; mv.jump = false; hopOver(mv, Infinity); }
      else stk.escapeUntil = clock;
    }
    if (stk.escape && clock >= stk.escapeUntil) {
      stk.escape = null;
      if (P.goal) planTo(P.goal, P.purpose, true); // 탈출 뒤 현재 위치에서 다시 계획
    }
    if (clock < stk.recoverUntil && stk.rec && !stk.rec.escape) {
      mv.x = stk.rec.dx; mv.z = stk.rec.dz; mv.on = true; mv.stop = false;
      mv.jump = stk.level === 1 && clock < stk.recoverUntil - 0.35;
    }
    // 발판으로 떠 있는 동안 멈추려 하면 앞으로 민다. 제자리 발판에서 같은 자리로 떨어져 계속 튀지 않게 한다
    if (flight && !(mv.on && !mv.stop)) { mv.x = -Math.sin(yaw); mv.z = -Math.cos(yaw); mv.on = true; mv.stop = false; mv.jump = false; }

    /* ---- 시점 ---- */
    if (look) {
      if (combat) {
        // 반동 보정: 총구(시선+반동)가 조준점을 향하도록 시선을 반동만큼(난이도 비율) 내린다
        const dx = look.x - eye.x, dz = look.z - eye.z, h = hyp2(dx, dz);
        if (h > 0.05) turnToward(out, yawOf(dx, dz) - rk.yaw * D.recoilComp, Math.atan2(look.y - eye.y, h) - rk.pitch * D.recoilComp, lookRate, lookMax, dt);
      } else lookAtPoint(out, look, lookRate, lookMax, dt);
    }

    /* ---- 무기 ---- */
    weapons(out, mv, combat, W0, dt, speed);

    /* ---- 이동 출력 ---- */
    const wantsMove = mv.on && !mv.stop;
    if (wantsMove) {
      const fx = -Math.sin(yaw), fz = -Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw);
      let f = mv.x * fx + mv.z * fz, s = mv.x * rx + mv.z * rz;
      const m = Math.max(Math.abs(f), Math.abs(s));
      const len = hyp2(f, s);
      if (len > 1e-6) { f /= len; s /= len; }
      out.forward = clamp(f, -1, 1); out.strafe = clamp(s, -1, 1);
      if (m < 1e-6) { out.forward = 0; out.strafe = 0; }
    }
    out.jump = !!mv.jump;
    out.walk = !!mv.walk;
    out.crouch = wantCrouch = crouchWanted(mv, combat);
    if (!isNum(self.slot) && out.slot) { curSlot = out.slot; wpn.drawUntil = clock + (W[slotWeapon(out.slot)].draw || 0.5); }
    stuckUpdate(dt, wantsMove && !mv.small && !flight);
    return out;
  }

  /**
   * 앉고 싶은가 (선택 출력 — 엔진이 무시해도 동작에 문제 없음).
   * 낮은 엄폐에서 기다릴 때, 저격수가 멈춰서 줌으로 겨눌 때, (normal 이상) 멀리서 멈춰 점사할 때. 이동·점프 중에는 서 있는다.
   */
  function crouchWanted(mv, combat) {
    if (difficulty === 'easy' || meleeOnly || mv.jump || (mv.on && !mv.stop)) return false;
    if (mode === 'cover' && cover && cover.phase === 'wait' && !combat) return !!(cover.pt && cover.pt.crouch) || difficulty === 'hard';
    if (!combat) return false;
    // 앉아도 표적이 보일 때만 (낮은 벽 뒤에서 앉으면 안 보여 앉았다 섰다를 되풀이하지 않게)
    if (W[slotWeapon(curSlot)].kind === 'melee') return false;
    const shooting = (isSniper && curSlot === homeSlot && wpn.zoomStart >= 0) ||
      (combat.ap.d > 22 && wpn.burstStop && clock < wpn.burstEnd && (difficulty === 'hard' || (Math.floor(wpn.nextBurst * 7) % 3 === 0)));
    return shooting && crouchSees(combat.m, combat.tp);
  }
  let crouchSeeCache = { t: -9, id: null, ok: false };
  function crouchSees(m, tp) {
    if (crouchSeeCache.id === m.id && clock - crouchSeeCache.t < 0.3) return crouchSeeCache.ok;
    const ey = pos.y + CROUCH_EYE, ck = m.crouch || 0;
    const ok = los(pos.x, ey, pos.z, tp.x, tp.y + crouchY(BODY_Y, ck), tp.z) || los(pos.x, ey, pos.z, tp.x, tp.y + crouchY(HEAD_Y, ck), tp.z);
    crouchSeeCache = { t: clock, id: m.id, ok };
    return ok;
  }
  function startChase(m) {
    m.chased = true;
    const pr = D.chasePredict;
    let g = { x: m.pos.x + m.vel.x * pr, y: m.pos.y, z: m.pos.z + m.vel.z * pr };
    g = snap(g, 5);
    chase = { goal: g, lookAt: { x: m.pos.x, y: m.pos.y + EYE * 0.9, z: m.pos.z }, until: clock + 14, holdFor: isSniper ? rand(2.5, 4.5) : 0 };
    search = null;
    clearPath();
    setMode('chase');
    maybeGrenade(m);
  }
  function startInvestigate(s) {
    const g = snap({ x: s.x, y: s.y, z: s.z }, 6);
    investigate = { goal: g, src: { x: s.x, y: s.y, z: s.z }, until: clock + 12, t: s.t };
    clearPath();
    setMode('investigate');
  }

  function holdLook() {
    if (clock >= plan.scanT) { plan.scanT = clock + rand(1.2, 2.6); plan.scanOff = rand(-0.35, 0.35); }
    const y = plan.holdYaw + (plan.scanOff || 0);
    return { x: eye.x - Math.sin(y) * 30, y: eye.y + rand(-0.02, 0.02), z: eye.z - Math.cos(y) * 30 };
  }
  /**
   * 칼전 순찰: 총소리가 없어 서로 찾기 어려우므로 가장 가까운 적의 대략적인 위치를 향해 경로로 달린다.
   * 위치에 난이도별 오차가 있고 몇 초마다만 갱신한다. 공격은 교전(보임)에서만 한다. 적이 없으면 false.
   */
  function huntMove(mv) {
    if (!hunt.goal || clock >= hunt.nextAt) {
      hunt.nextAt = clock + rand(D.huntEvery[0], D.huntEvery[1]);
      let best = null, bd = Infinity;
      for (let i = 0; i < foes.length; i++) {
        const e = foes[i];
        if (!e || e.alive === false || clock < (hunt.skip.get(e.id) ?? -1)) continue;
        rv(e.pos, _ep);
        const dd = dist3(pos, _ep);
        if (dd < bd) { bd = dd; best = { x: _ep.x, y: _ep.y, z: _ep.z, id: e.id }; }
      }
      if (!best) { hunt.goal = null; hunt.targetId = null; return false; }
      const err = Math.min(D.huntErr, bd * 0.3) * rng(), a = rng() * TAU;
      hunt.goal = snap({ x: best.x + Math.cos(a) * err, y: best.y, z: best.z + Math.sin(a) * err }, 8);
      hunt.targetId = best.id; hunt.targetY = best.y;
    }
    const planned = planTo(hunt.goal, 'hunt', false);
    if (planned && followPath(mv)) {
      if (dist2(pos, hunt.goal) < 1.2) hunt.nextAt = 0;   // 거의 왔는데 안 보이면 바로 다시 찾는다
      hopOver(mv, Infinity);
      return true;
    }
    hunt.goal = null; hunt.nextAt = 0;
    clearPath();
    // 도착했는데 같은 높이면 그 근처를 다시 찾는다
    if (planned && Math.abs(hunt.targetY - pos.y) < MELEE_VERTICAL) { mv.stop = true; return true; }
    // 경로가 없는 적(발판으로만 가는 층 등)은 잠시 빼고 다음으로 가까운 적을 찾는다. 아무도 없으면 평소 순찰로 돌아다닌다
    if (hunt.targetId != null) hunt.skip.set(hunt.targetId, clock + rand(4, 8));
    hunt.targetId = null;
    return false;
  }
  /** 달리는데 막혔으면 뛰어넘어 본다. hd(표적 거리)가 3~12 m면 막히지 않아도 가끔 뛴다 */
  function hopOver(mv, hd) {
    if (!mv.on || mv.jump) return;
    if (hyp2(vel.x, vel.z) < 1) { if (eng.blockSince < 0) eng.blockSince = clock; } else eng.blockSince = -1;
    if (clock < eng.nextHop) return;
    const blocked = eng.blockSince >= 0 && clock - eng.blockSince > 0.25;
    if (blocked || (hd > 3 && hd < 12 && rng() < HOP_RATE * D.strafe * lastDt)) {
      mv.jump = true;
      eng.nextHop = clock + rand(1.2, 2.8);
      eng.blockSince = -1;
    }
  }
  /** view.objective → 목표 { x,y,z, radius, hold, urgent, look } | null. 잘못된 값은 목표 없음 */
  function readObjective(ob) {
    if (!ob || typeof ob !== 'object' || !ob.pos) { objective = null; objHold = false; return; }
    const p = rv(ob.pos);
    if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) { objective = null; objHold = false; return; }
    const prev = objective;
    objective = {
      x: p.x, y: p.y, z: p.z,
      radius: Math.max(0.3, num(ob.radius, 1.2)), hold: ob.hold !== false, urgent: !!ob.urgent,
      look: ob.look ? rv(ob.look) : null
    };
    if (prev && dist2(prev, objective) > 1.5) objHold = false;   // 목표가 바뀌었다
  }
  /** 목표로 간다. 닿았으면(hold) 멈춘다. 경로가 없으면 false(평소 순찰로) */
  function objectiveMove(mv) {
    const ob = objective;
    if (!ob) return false;
    const arrived = dist2(pos, ob) <= ob.radius && Math.abs(ob.y - pos.y) < 1.6;
    if (arrived) {
      if (!ob.hold) { objHold = false; return false; }
      if (!objHold) { objHold = true; objScanT = 0; objScanYaw = yaw; clearPath(); }
      mv.stop = true;
      return true;
    }
    // 머무는 목표에서 조금 밀려났으면(교전 뒤) 다시 간다
    if (objHold && dist2(pos, ob) <= ob.radius + 1.2) { mv.stop = true; return true; }
    objHold = false;
    if (planTo(ob, 'objective', false) && followPath(mv)) { hopOver(mv, Infinity); return true; }
    return false;
  }
  /** 목표에서 버틸 때 바라볼 곳: look이 있으면 그쪽(좌우로 조금씩), 없으면 천천히 둘러본다 */
  function objectiveLook() {
    if (clock >= objScanT) {
      objScanT = clock + rand(1.4, 2.8);
      const base = objective && objective.look ? yawOf(objective.look.x - pos.x, objective.look.z - pos.z) : objScanYaw + rand(1.2, 2.4);
      objScanYaw = objective && objective.look ? base + rand(-0.5, 0.5) : base;
    }
    const ly = objective && objective.look ? objective.look.y + EYE : eye.y;
    return { x: eye.x - Math.sin(objScanYaw) * 20, y: ly, z: eye.z - Math.cos(objScanYaw) * 20 };
  }
  function patrolMove(mv) {
    if (objective && objectiveMove(mv)) return;
    if (meleeOnly && huntMove(mv)) return;
    // 저격수: 자리 잡고 버티기
    if (plan.holdSpot && clock < plan.holdUntil) {
      if (dist2(pos, plan.holdSpot) > 2.0) { // 교전·추적 뒤 자리로 돌아간다
        if (planTo(plan.holdSpot, 'hold', false) && followPath(mv)) return;
      }
      mv.stop = true; return;
    }
    if (plan.holdSpot && clock >= plan.holdUntil) { plan.visited.push(plan.holdSpot); plan.holdSpot = null; clearPath(); }
    let goal = plan.route[plan.routeIdx];
    if (!goal) {
      const g = nextRoamGoal();
      if (g) { plan.route.push(g); goal = g; }
    }
    if (!goal) { mv.stop = true; return; }
    if (!planTo(goal, 'patrol', false)) { plan.routeIdx++; clearPath(); mv.stop = true; return; } // 못 가는 목표는 건너뛴다
    const moving = followPath(mv);
    if (!moving || dist2(pos, goal) < 1.4) {
      plan.visited.push({ x: goal.x, z: goal.z });
      if (plan.visited.length > 12) plan.visited.shift();
      plan.routeIdx++;
      clearPath();
      if (isSniper && goal.spot) {
        const late = ffa || clock - roundStart > 50;
        plan.holdSpot = goal; plan.holdUntil = clock + (late ? rand(7, 12) : rand(14, 26)); plan.holdYaw = bestSightYaw(goal); plan.scanT = 0;
      }
    }
  }

  function engageMove(mv, m, tp, d, W0) {
    const info = W[slotWeapon(curSlot)];
    if (info.kind === 'melee') { meleeMove(mv, m, tp); return; }
    const style = styleOf(info);
    const scoping = info.kind === 'sniper';
    // 교착 해소: 적이 보이는데 몇 초째 한 발도 못 쐈으면 각을 바꾼다(저격: 옆으로 1.2초, 소총: 전진)
    if (clock - Math.max(eng.engageSince, wpn.lastShotAt) > (scoping ? 4.5 : 3.5) && !W0.reloading) {
      eng.engageSince = clock;
      eng.stale = (eng.stale || 0) + 1;
      // 저격: 처음엔 옆으로 1.2초 비켜 각을 바꾸고, 그래도 안 되면 다가간다
      if (scoping && eng.stale % 2 === 1) { eng.peekUntil = clock + 1.2; eng.strafeDir = rng() < 0.5 ? -1 : 1; eng.strafeUntil = eng.peekUntil; eng.spaceT = 0; }
      else { eng.advance = true; eng.advanceUntil = clock + 3; }
    }
    if (scoping && clock < eng.peekUntil) {
      strafeStep(mv, 1);                 // 옆 공간이 막혔으면 strafeStep이 반대쪽으로 바꾼다
      if (!eng.strafeDir) eng.peekUntil = 0;
      return;
    }
    if (scoping && eng.advance && clock < (eng.advanceUntil || 0)) {
      if (planTo(snap(tp, 4), 'advance', false) && followPath(mv)) return;
      eng.advance = false;
    } else if (scoping) eng.advance = false;
    // 저격: 조준 중에는 멈춘다(이동 탄퍼짐). 볼트 동안만 조금 옆걸음
    if (scoping) {
      if (clock < wpn.boltUntil - 0.25 && difficulty !== 'easy') strafeStep(mv, 0.5);
      else mv.stop = true;
      return;
    }
    // 너무 멀면 다가간다(경로). 근거리 무기는 곧바로 붙는다
    const far = d > (style.approach || Math.min(40, D.maxEngage * 0.8));
    if (style.closer) {
      if (far) eng.advance = true;
      else if (clock >= (eng.advanceUntil || 0)) eng.advance = false;
    } else {
      if (far && rng() < D.advance * 0.02) eng.advance = true;
      if (!far && clock - wpn.lastShotAt < 1.0) eng.advance = false;   // 다시 쏘기 시작하면 전진 멈춤
    }
    let moved = false;
    if (eng.advance) {
      moved = planTo(snap(tp, 4), 'advance', false) && followPath(mv);
      if (!moved) eng.advance = false;
    }
    if (!moved) {
      // 조준 사격 무기: 다음 발을 쏠 수 있으면 멈춰 서고, 쏜 직후에만 옆걸음
      if (style.stopToFire && clock >= wpn.nextTap - 0.12) mv.stop = true;
      else strafeStep(mv, D.strafe);
    }
    // 사격 중·직전 멈추기(카운터 스트레이프) — 전진 중이어도 쏠 때는 선다
    if (wpn.burstStop && (clock < wpn.burstEnd || wpn.preStop >= 0)) { mv.on = false; mv.stop = true; }
    if (wpn.pulseStop && info.fire === 'burst' && clock >= wpn.nextTap - 0.12) { mv.on = false; mv.stop = true; }
  }
  /** 칼 교전 이동: 곧장 달려가고(막히면 경로), 가까우면 좌우로 흔들며, 사거리 안쪽으로는 더 파고들지 않는다 */
  function meleeMove(mv, m, tp) {
    const info = W[slotWeapon(curSlot)];
    const dx = tp.x - pos.x, dz = tp.z - pos.z, hd = hyp2(dx, dz);
    const rush = () => { if (hd > 0.05) { mv.x = dx / hd; mv.z = dz / hd; mv.on = true; } };
    if (canRush(tp)) rush();
    else if (!(planTo(snap(tp, 4), 'charge', false) && followPath(mv))) {
      // 위층처럼 칼이 닿지 않는 곳에 있고 갈 길도 없으면 잠시 잊는다(칼만 든 봇이 벽 밑에서 맴돌지 않게)
      if (meleeOnly && Math.abs(tp.y - pos.y) >= MELEE_VERTICAL) {
        const until = clock + rand(4, 8);
        m.ignoreUntil = until;
        hunt.skip.set(m.id, until);
        mv.stop = true;
        return;
      }
      rush();
    }
    if (!mv.on) { mv.stop = true; return; }
    if (hd < MELEE_WEAVE_RANGE && Math.abs(tp.y - pos.y) < MELEE_VERTICAL) {
      if (clock >= eng.strafeUntil) {
        eng.strafeDir = rng() < D.strafe ? (rng() < 0.5 ? -1 : 1) : 0;
        eng.strafeUntil = clock + rand(0.3, 0.8);
      }
      const inside = hd < info.range * 0.55;
      if (inside && !eng.strafeDir) { mv.on = false; mv.stop = true; return; }
      const ahead = inside ? -0.25 : 1, side = eng.strafeDir * (inside ? 1 : 0.55);
      const vx = mv.x * ahead - mv.z * side, vz = mv.z * ahead + mv.x * side, l = hyp2(vx, vz) || 1;
      mv.x = vx / l; mv.z = vz / l;
      mv.small = true;   // 표적 곁에서 맴도는 움직임은 끼임으로 치지 않는다
    }
    hopOver(mv, hd);
  }
  /** 표적까지 곧장 달려갈 수 있는가(0.12초 캐시). 높이가 다르거나 벽이 있으면 false → 경로로 간다 */
  let rushCache = { t: -9, ok: false };
  function canRush(tp) {
    if (!nav) return true;
    if (clock - rushCache.t < 0.12) return rushCache.ok;
    let ok = hyp2(tp.x - pos.x, tp.z - pos.z) < 1.5 && Math.abs(tp.y - pos.y) < 0.6;
    if (!ok && avoidClear(pos, tp)) ok = typeof nav.walkStraight === 'function' ? nav.walkStraight(pos, tp) : true;
    rushCache = { t: clock, ok };
    return ok;
  }
  function strafeStep(mv, p) {
    if (clock >= eng.strafeUntil) {
      eng.strafeDir = rng() < p ? (rng() < 0.5 ? -1 : 1) : 0;
      eng.strafeUntil = clock + rand(0.35, 1.0);
      eng.spaceT = 0;
    }
    if (!eng.strafeDir) { mv.stop = true; return; }
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    if (nav && nav.losWalk && clock - eng.spaceT > 0.2) {
      eng.spaceT = clock;
      const tx = pos.x + rx * eng.strafeDir * 1.6, tz = pos.z + rz * eng.strafeDir * 1.6;
      if (!nav.losWalk(pos, { x: tx, y: pos.y, z: tz })) {
        eng.strafeDir = -eng.strafeDir;
        const ux = pos.x + rx * eng.strafeDir * 1.6, uz = pos.z + rz * eng.strafeDir * 1.6;
        if (!nav.losWalk(pos, { x: ux, y: pos.y, z: uz })) eng.strafeDir = 0;
      }
    }
    if (!eng.strafeDir) { mv.stop = true; return; }
    mv.x = rx * eng.strafeDir; mv.z = rz * eng.strafeDir; mv.on = true; mv.small = true;
  }

  /* ---------------- 수류탄 ---------------- */
  function maybeGrenade(m) {
    if (!canUse(4) || meleeOnly || !(D.grenade > 0) || wpn.gr || m.grenadeRolled) return;
    m.grenadeRolled = true;
    const gren = view && view.self && isNum(view.self.grenades) ? view.self.grenades : wpn.grenades;
    if (!(gren > 0)) return;
    const d = dist2(pos, m.pos), dy = m.pos.y - pos.y;
    if (d < 7 || d > 26 || Math.abs(dy) > 4) return;
    for (const a of alliesKnown) if (dist2(a, m.pos) < 6.5) return;
    if (rng() >= D.grenade) return;
    wpn.gr = { phase: 'switch', t: clock, target: { x: m.pos.x + m.vel.x * 0.5, y: m.pos.y, z: m.pos.z + m.vel.z * 0.5 } };
  }
  /** 수류탄 시퀀스 진행. 처리 중이면 true */
  function grenadeStep(out, dt) {
    const g = wpn.gr;
    if (!g) return false;
    const B = W[GRENADE_ID];
    const age = clock - g.t;
    if (age > 4) { wpn.gr = null; wpn.wantSlot = homeSlot; return false; }
    // 조준: 낮은 포물선(목표의 85% 지점에 떨어지게 해서 굴러 들어가게)
    const dx = g.target.x - eye.x, dz = g.target.z - eye.z, dXZ = hyp2(dx, dz);
    const elev = lobAngle(dXZ * 0.85, g.target.y + 0.2 - eye.y, B.speed, B.gravity);
    const tYaw = yawOf(dx, dz);
    const tPitch = clamp((Number.isFinite(elev) ? elev : 40 * DEG) - B.pitchUp, -0.6, 1.2);
    turnToward(out, tYaw, tPitch, D.aimRate, D.maxTurn, dt);
    if (g.phase === 'switch') {
      wpn.wantSlot = 4;
      if (curSlot === 4 && clock >= wpn.drawUntil) { g.phase = 'aim'; g.t2 = clock; }
      return true;
    }
    if (g.phase === 'aim') {
      wpn.wantSlot = 4;
      const err = Math.abs(wrap(tYaw - yaw)) + Math.abs(tPitch - pitch);
      if (err < 0.06 || clock - g.t2 > 0.8) { g.phase = 'prime'; g.t3 = clock; }
      return true;
    }
    if (g.phase === 'prime') {
      wpn.wantSlot = 4;
      out.fire = true;
      if (clock - g.t3 >= B.prime + 0.08) { g.phase = 'release'; g.t4 = clock; }
      return true;
    }
    if (g.phase === 'release') {
      out.fire = false;
      if (clock - g.t4 > 0.45) {
        wpn.gr = null; wpn.grenades = Math.max(0, wpn.grenades - 1); stats.grenades++;
        wpn.wantSlot = homeSlot;
        return false;
      }
      return true;
    }
    return false;
  }

  /* ---------------- 무기 운용 ---------------- */
  /** 탄창과 예비탄이 모두 비었거나 쓸 수 없는 슬롯인가 */
  const dryOf = (slot) => !canUse(slot) || ((wpn.estMag[slot] ?? 0) <= 0 && (wpn.estRes[slot] ?? 0) <= 0);
  /** 교전 중 들 슬롯. 규칙이 허용한 슬롯만 돌려준다 */
  function chooseSlot(d, W0) {
    if (meleeOnly) return homeSlot;
    if (dryOf(1) && dryOf(2)) return canUse(3) ? 3 : homeSlot;   // 총알이 다 떨어지면 칼
    let want = homeSlot;
    if (homeSlot !== 1) return want;
    if (canUse(2)) {
      const primEmpty = (wpn.estMag[1] ?? 0) <= 0, secEmpty = (wpn.estMag[2] ?? 0) <= 0;
      if (isSniper && difficulty !== 'easy' && (d < 9 || (curSlot === 2 && d < 14))) want = 2;
      // 주무기가 비었는데 적이 가까우면 권총. 든 뒤에는 조금 더 멀어질 때까지 유지한다(무기만 바꾸다 끝나지 않게)
      if (primEmpty && d < (curSlot === 2 ? 18 : 15)) want = 2;
      if (want === 2 && secEmpty && !dryOf(1)) want = 1;   // 권총도 비었으면 주무기로 돌아가 재장전한다
      if (want === 1 && dryOf(1)) want = 2;
      if (primEmpty && secEmpty && d < 4 && canUse(3)) want = 3;
    } else if (canUse(3)) {
      // 보조가 없는 규칙(스나전): 코앞에서 볼트·재장전 중이면 칼을 들고, 멀어지면 저격총으로 돌아간다
      const busy = clock < wpn.boltUntil || W0.reloading || W0.mag === 0;
      if (curSlot === 3 ? d < SNIPER_KNIFE_LEAVE : d < SNIPER_KNIFE_ENTER && busy) want = 3;
    }
    return want;
  }
  /** 머리를 노릴 확률 */
  function headChance(info) {
    if (info.kind === 'sniper') return D.headAimSniper;
    if ((info.pellets || 1) > 1) return 0;   // 산탄은 몸 가운데를 겨눈다
    return info.headRatio >= HEAD_HUNTER_RATIO ? Math.min(0.9, D.headAim + HEAD_HUNTER_BONUS) : D.headAim;
  }
  const zoomDistance = (style) => style.zoomFrom || (difficulty === 'easy' ? 22 : 12);

  function weapons(out, mv, combat, W0, dt, speed) {
    const active = slotWeapon(curSlot);
    const info = W[active];
    const drawn = clock >= wpn.drawUntil && W0.state !== 'draw';
    let fire = false, zoom = false;

    // 적이 다시 보이면 아직 핀을 뽑기 전인 수류탄은 취소하고 총으로 싸운다
    if (wpn.gr && combat && (wpn.gr.phase === 'switch' || wpn.gr.phase === 'aim')) { wpn.gr = null; wpn.wantSlot = homeSlot; }
    if (grenadeStep(out, dt)) {
      mv.stop = true;
      out.zoom = false;
      out.slot = wpn.wantSlot !== curSlot ? wpn.wantSlot : null;
      wpn.prevFire = out.fire;
      return;
    }

    if (combat) {
      const { tp, ap } = combat;
      const d = ap.d;
      const reactOk = clock >= combat.m.acquiredAt + combat.m.react;
      // 무기 선택
      const want = chooseSlot(d, W0);
      wpn.wantSlot = want;
      // 오차·허용치
      const err = aimError(ap);
      const half = aim.head ? 0.12 : 0.24;
      const tol = Math.atan2(half, Math.max(1, d)) * D.fireTol + 0.004;
      // 머리만 보이는 적: easy는 기다리고, normal은 40m 안에서만 쏜다
      const hoT = clock - (combat.m.headOnlySince ?? clock);   // 머리만 보인 지 얼마나 됐나
      // easy는 머리만 보이는 적을 쏘지 않는다(교착 해소 로직이 각을 바꾼다)
      const headOnlyOk = info.kind === 'melee' || combat.m.part !== 2 || difficulty === 'hard' || (difficulty === 'normal' && (d < 40 || hoT > 1.5));
      const clear = !allyInLine(ap) && headOnlyOk && !combat.m.protect;   // 부활 보호 중인 적은 겨누기만
      const ready = drawn && curSlot === want && reactOk && clear && !W0.reloading;
      const style = styleOf(info);

      if (info.kind === 'sniper') {
        // 저격: 줌 → 정조준 이상 → 멈춘 뒤 한 방 → 볼트 대기(줌 해제). 다단 줌도 stageCycle:false라 1단만 쓴다
        if (clock < wpn.boltUntil || W0.reloading || W0.mag === 0 || clock < eng.peekUntil || (eng.advance && clock < (eng.advanceUntil || 0))) { zoom = false; wpn.zoomStart = -1; }
        else if (drawn) {
          zoom = true;
          if (wpn.zoomStart < 0) { wpn.zoomStart = clock; aim.head = rng() < headChance(info); }
          const zoomed = W0.zoomP !== null ? W0.zoomP >= (info.accurateAt ?? 0.5) + 0.05 : clock - wpn.zoomStart >= info.zoomIn * 0.6;
          if (zoomed && ready && clock - wpn.zoomStart >= D.sniperSettle && speed < 0.5 && err < tol && !wpn.prevFire) {
            fire = true; wpn.boltUntil = clock + info.bolt + 0.05; wpn.zoomStart = -1; stats.shots++; recoilShot(info, 1);
            wpn.estMag[curSlot] = Math.max(0, (wpn.estMag[curSlot] ?? info.mag) - 1);
          }
        }
      } else if (info.kind === 'melee') {
        // 칼: 베기 사거리에 들면 벤다. 가끔 강타(찌르기)로 큰 한 방을 노린다. 부위는 보지 않으니 몸을 겨눈다
        aim.head = false;
        const hd = dist2(pos, tp);
        const level = Math.abs(tp.y - pos.y) < MELEE_VERTICAL;
        if (ready && level && clock >= wpn.nextTap && !wpn.prevFire) {
          const heavy = wpn.heavyNext && hd <= info.heavyRange + MELEE_BODY_R * 0.5 && err < info.heavyArc + 0.1;
          if (heavy || (hd <= info.range + MELEE_BODY_R * 0.5 && err < info.arc)) {
            if (heavy) { zoom = true; stats.heavies++; } else fire = true;
            wpn.nextTap = clock + (heavy ? info.heavyInterval : info.interval) + 0.02;
            if (heavy || !wpn.heavyNext) wpn.heavyNext = rng() < D.meleeHeavy;   // 조준이 안 맞아 베기로 넘어갔으면 강타는 다음으로 미룬다
            wpn.lastShotAt = clock;
            stats.swings++; stats.shots++;
          }
        }
      } else if (info.fire === 'auto') {
        zoom = drawn && info.zoomIn > 0 && d > zoomDistance(style);
        const reach = Math.min(D.maxEngage, info.effRange);
        const aimOk = tol * style.aimTol;
        if (wpn.burstEnd > 0) {
          if (clock < wpn.burstEnd && ready && err < aimOk * 2.2 && W0.mag !== 0) fire = true;
          else { // 점사 끝(또는 중단) → 반동 회복 간격
            wpn.burstEnd = -1;
            wpn.nextBurst = clock + rand(D.burstGap[0], D.burstGap[1]) * (d > 30 ? 1.4 : d < 10 ? 0.6 : 1);
          }
        } else if (ready && clock >= wpn.nextBurst && err < aimOk && W0.mag !== 0 && d <= reach) {
          // 카운터 스트레이프: 쏘기 전에 멈춘다(이동 탄퍼짐 제거). 근거리 무기는 달리면서 쏜다
          if (wpn.preStop < 0) { wpn.preStop = clock; wpn.burstStop = !style.closer && (d > 12 ? rng() < D.counterStrafe : rng() < D.counterStrafe * 0.4); }
          if (wpn.burstStop && speed > 1.0 && clock - wpn.preStop < 0.3) { /* 멈추는 중 */ }
          else {
          wpn.preStop = -1;
          let n = Math.round(rand(D.burst[0], D.burst[1]));
          if (d < 10) n += 3; else if (d > 40) n = Math.max(2, n - 2);
          wpn.burstEnd = clock + n * Math.max(info.interval, FULL_AUTO_REF) - 0.02;
          aim.head = rng() < headChance(info);
          fire = true;
          }
        } else if (wpn.preStop >= 0 && !(ready && err < aimOk * 1.5)) wpn.preStop = -1;
        if (fire) { const n = dt / info.interval; stats.shots += n; wpn.estMag[curSlot] = Math.max(0, (wpn.estMag[curSlot] ?? info.mag) - n); recoilShot(info, n); }
      } else if (info.fire === 'semi' || info.fire === 'burst') {
        // 반자동·점사: 한 틱 눌렀다 뗀다. 점사는 한 번 누르면 나머지 탄이 저절로 나간다
        const wantZoom = info.zoomIn > 0 && d > zoomDistance(style);
        zoom = drawn && wantZoom;
        const zoomOk = !wantZoom || W0.zoomP === null || W0.zoomP >= (style.stopToFire ? 0.95 : 0.5);
        const reach = info.effRange === Infinity ? D.maxEngage * 1.5 : Math.min(D.maxEngage, info.effRange);
        if (ready && zoomOk && clock >= wpn.nextTap && err < tol * style.aimTol && W0.mag !== 0 && !wpn.prevFire && d <= reach) {
          const shots = isNum(W0.mag) ? Math.min(info.burstCount, W0.mag) : info.burstCount;
          fire = true;
          wpn.nextTap = clock + Math.max(info.cycle + 0.01, D.pistolGap * rand(0.85, 1.3));
          wpn.pulseStop = info.fire === 'burst' && rng() < D.counterStrafe;
          aim.head = rng() < headChance(info);
          stats.shots += shots; recoilShot(info, shots);
          wpn.estMag[curSlot] = Math.max(0, (wpn.estMag[curSlot] ?? info.mag) - shots);
        }
      }
      // 빈 탄창
      if (W0.mag === 0 && (curSlot === 1 || curSlot === 2) && !W0.reloading && wpn.wantSlot === curSlot && (W0.reserve === null || W0.reserve > 0)) pressReload(out);
    } else {
      // 비교전: 줌 해제, 평소 무기로, 틈나면 재장전
      wpn.burstEnd = -1; wpn.zoomStart = -1;
      if (curSlot !== homeSlot && clock - (mem.size ? latestSeen() : -99) > 1.5) wpn.wantSlot = homeSlot;
      else if (curSlot === homeSlot) wpn.wantSlot = homeSlot;
      if (info.mag && W0.mag !== null && !W0.reloading && curSlot === wpn.wantSlot && drawn) {
        const quiet = clock - latestSeen() > 1.5;
        const frac = W0.mag / info.mag;
        if ((W0.mag === 0 || (quiet && frac < (isSniper ? 0.61 : 0.5))) && (W0.reserve === null || W0.reserve > 0) && clock >= wpn.boltUntil) pressReload(out);
      }
      // 저격수 대기 중: 가끔 줌으로 살펴보기
      if (isSniper && curSlot === homeSlot && plan.holdSpot && clock < plan.holdUntil && clock >= wpn.boltUntil && !W0.reloading && mode === 'patrol') {
        zoom = ((clock * 0.37 + idPhase) % 3) > 1.7;
      }
    }
    if (fire) wpn.lastShotAt = clock;
    out.fire = fire;
    out.zoom = zoom;
    out.slot = wpn.wantSlot !== curSlot && canUse(wpn.wantSlot) ? wpn.wantSlot : null;
    if (out.slot) { wpn.burstEnd = -1; wpn.zoomStart = -1; out.fire = false; out.zoom = false; }
    wpn.prevFire = out.fire;
  }
  function pressReload(out) {
    if (clock < wpn.reloadUntil) return;
    out.reload = true;
    const info = W[slotWeapon(curSlot)];
    wpn.reloadUntil = clock + (info && info.reload ? info.reload + 0.1 : 2);
    if (curSlot === 1 || curSlot === 2) setTimeoutMag(curSlot, info);
  }
  function setTimeoutMag(slot, info) { wpn.pendingReload = { slot, at: wpn.reloadUntil, size: info ? info.mag : 0 }; }
  function latestSeen() { let t = -99; for (const m of mem.values()) if (m.seenAt > t) t = m.seenAt; return t; }

  /* ---------------- 공개 API ---------------- */
  /** 고른 무기 바꾸기 (개인전 로드아웃은 다음 부활부터). 규칙에서 쓸 수 없는 무기면 그대로 둔다 */
  function setPrimary(p) {
    if (!setGear(p)) return false;
    refreshRole();
    brain.primary = gear[homeSlot]; brain.role = W[gear[homeSlot]].kind;
    return true;
  }
  const brain = {
    id, team, difficulty,
    ruleset: rules.id,
    /** 고른 무기 id(칼전이면 칼) */
    primary: gear[homeSlot],
    mode: ffa ? 'ffa' : 'team',
    /** 고른 무기의 def.kind: 'rifle'|'dmr'|'smg'|'shotgun'|'sniper'|'pistol'|'melee' */
    role: W[gear[homeSlot]].kind,
    stats,
    /** 지금 노리는(보이는) 적 id | null — debug()보다 가볍다(연습장 폭파 미션이 설치·해체를 미룰 때 본다) */
    get targetId() { return targetId; },
    /** 폭파 미션 목표에 닿아 멈춰 있는가 */
    get atObjective() { return objHold; },
    /**
     * 부활 (개인전 match.js 'spawn' 이벤트를 받았을 때). 몸 위치·무기는 엔진이 옮기고, 이 함수는 두뇌를 새 목숨으로 맞춘다.
     * @param {object} [s] { x, y, z, rotY, loadout|primary: 규칙에서 쓸 수 있는 무기 id, protectMs } 또는 spawn 이벤트 그대로 { spawn:{x,y,z,rotY}, loadout, protectMs }
     */
    respawn(s) {
      const ev = s || {};
      const sp = ev.spawn && typeof ev.spawn === 'object' ? ev.spawn : ev;
      const lo = ev.loadout ?? ev.primary ?? sp.loadout ?? sp.primary;
      const loId = typeof lo === 'string' ? lo : lo && typeof lo === 'object' ? (lo.primary ?? lo.id ?? lo.melee) : null;
      if (loId) setPrimary(loId); else if (pendingPrimary) setPrimary(pendingPrimary);
      pendingPrimary = null;
      keepIntel = true;
      resetRound();
      alive = false; haveLast = false;
      const pm = num(ev.protectMs ?? sp.protectMs, 0);
      protectUntil = pm > 0 ? clock + pm / 1000 : -99;
      if (isNum(sp.x) && isNum(sp.z)) { pos.x = sp.x; pos.z = sp.z; if (isNum(sp.y)) pos.y = sp.y; }
    },
    /** 다음 부활 무기만 바꿔 둔다 (지금 목숨은 그대로). 규칙에서 쓸 수 없는 무기면 예약을 지우고 false */
    setLoadout(p) {
      pendingPrimary = loadoutKey(p) && isWeaponAllowed(rules.id, p) ? p : null;
      return !!pendingPrimary;
    },
    /** 발판에 실려 날아가기 시작했다(엔진이 알려 준다). 착지하면 경로를 새로 잡는다 */
    onLaunch() {
      flight = true; flightAt = clock;
      clearPath();
      // 가던 목표는 버린다. 버티던 자리가 발판 위면 돌아와서 다시 튀게 된다
      if (plan.holdSpot) { plan.visited.push(plan.holdSpot); if (plan.visited.length > 12) plan.visited.shift(); plan.holdSpot = null; plan.holdUntil = 0; }
      if (mode === 'patrol' && plan.routeIdx < plan.route.length) plan.routeIdx++;
      hunt.goal = null; hunt.nextAt = 0;
    },
    /** 매 프레임 호출 → 입력 */
    think(dt, v) {
      const out = think(dt, v);
      // 내부 탄 추정(엔진이 ammo를 안 줄 때만 쓰임): 재장전 완료 처리
      const pr = wpn.pendingReload;
      if (pr && clock >= pr.at) { wpn.estMag[pr.slot] = pr.size; wpn.pendingReload = null; }
      return out;
    },
    /** 총소리(사격 이벤트 위치). info: { team?, id? } — 아군·자기 소리는 무시 */
    hearShot(p, info) {
      if (!alive || !p) return;
      const q = rv(p);
      if (info && info.id != null && String(info.id) === String(id)) return;
      if (!ffa && info && info.team != null && info.team === team) return;   // 개인전에는 아군이 없다
      if (hyp2(q.x - pos.x, q.z - pos.z) < 1.5) return;
      for (const a of alliesKnown) if (hyp2(a.x - q.x, a.z - q.z) < 2.5 && Math.abs(a.y - q.y) < 2.5) return;
      const range = info && isNum(info.range) ? info.range : D.hearRange;
      if (Math.hypot(q.x - pos.x, q.y - pos.y, q.z - pos.z) > range) return;
      sounds.push({ x: q.x, y: q.y, z: q.z, t: clock });
      if (sounds.length > 6) sounds.shift();
      intel = { x: q.x, y: q.y, z: q.z, t: clock };
    },
    /** 피격 알림(선택). from이 있으면 그쪽을 돌아본다(화면 피격 방향 표시와 같은 정보) */
    onDamage(info) {
      if (!alive) return;
      damagedAt = clock;
      const f = info && (info.from || info.pos);
      if (f) {
        const q = rv(f);
        if (!pickTarget()) alert = { x: q.x, y: q.y + 1.2, z: q.z, until: clock + 1.6 };
        sounds.push({ x: q.x, y: q.y, z: q.z, t: clock });
      }
    },
    /** 라운드 시작 등에서 기억·계획 초기화 */
    reset() { resetRound(); alive = false; haveLast = false; },
    /** 디버그·HUD용 상태 */
    debug() {
      return {
        mode, gameMode: ffa ? 'ffa' : 'team', ruleset: rules.id, primary: gear[homeSlot], weapon: slotWeapon(curSlot), homeSlot, target: targetId, hp, lane: plan.lane, slot: curSlot, wantSlot: wpn.wantSlot, crouch: wantCrouch,
        goal: P.goal, path: P.pts ? P.pts.slice(P.idx).map((p) => ({ x: p.x, y: p.y, z: p.z })) : null,
        memory: [...mem.values()].map((m) => ({ id: m.id, visible: m.visible, age: +(clock - m.seenAt).toFixed(2), pos: { ...m.pos } })),
        sounds: sounds.length, stuckLevel: stk.level, holding: !!(plan.holdSpot && clock < plan.holdUntil), losCalls,
        objective: objective ? { x: objective.x, y: objective.y, z: objective.z, urgent: objective.urgent, hold: objective.hold } : null, atObjective: objHold
      };
    },
    dispose() { mem.clear(); sounds.length = 0; clearPath(); view = null; nav = null; }
  };
  return brain;
}

export default createBot;
