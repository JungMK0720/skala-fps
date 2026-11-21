/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 배틀로얄(혼자, 연습장) 규칙 값과 결정적 계산. 8×8 격자 구역 이름·좌표, 시드로 정하는 구역 봉쇄 일정,
 *          페이즈별 봉쇄 구역 피해, 보급품 등급 굴림, 탈락 순서 → 순위, 점프 이어 가속을 끈 이동 값을 둔다.
 *          three.js·DOM에 의존하지 않아 node 테스트에서 그대로 쓴다. 계약: docs/MODES.md 15절
 */
import { MOVE, PLAYER } from '../../core/consts.js';
import { getDef } from '../../weapons/defs.js';

/** 규칙 값(시간은 ms). 페이즈 k(1~5)가 끝나면 안전 구역은 한 변 SIZES[k-1]칸 정사각형이 된다 */
export const BR = Object.freeze({
  freeMs: 60000,                         // 처음 자유 수색 시간(첫 봉쇄 예고까지)
  warnMs: 45000,                         // 봉쇄 예고 → 봉쇄
  holdMs: Object.freeze([40000, 35000, 30000, 25000]),   // 봉쇄 뒤 다음 예고까지(페이즈 1~4)
  finalHoldMs: 60000,                    // 마지막 봉쇄 뒤 전면 봉쇄(연장)까지
  sizes: Object.freeze([6, 4, 3, 2, 1]), // 페이즈마다 남는 안전 구역 한 변(칸)
  dps: Object.freeze([2, 4, 8, 14, 25]), // 페이즈 k 봉쇄 뒤 봉쇄 구역 안 초당 피해
  overtimeDps: 25,                       // 전면 봉쇄(모든 구역) 초당 피해
  tickMs: 1000,                          // 봉쇄 구역 피해를 주는 간격
  minBots: 3, maxBots: 15, defaultBots: 11,   // 나 + 봇 = 최대 16명
  medkitHeal: 40, medkitMs: 3000, medkitMax: 3,
  ammoMags: 2,                           // 탄약 상자 하나 = 든 총마다 탄창 2개 분량의 예비 탄
  finiteMags: 3,                         // 예비 탄이 무제한인 총도 탄창 × 3발까지만(줍는 총에 끝없는 탄을 주지 않는다)
  startSecondary: 'pt_std', startMelee: 'ml_knife'
});

/**
 * 배틀로얄이 쓰는 match.js 개인전 규칙. 탈락하면 연습장이 match.removePlayer로 경기에서 빼므로 부활은 없고,
 * 한 명만 남으면 match가 matchEnd(forfeit, winner = 마지막 남은 사람)를 낸다. 목표 킬·시간은 사실상 끝나지 않게 둔다
 */
export const BR_MATCH = Object.freeze({ killTarget: 50, timeLimitMs: 3600000, respawnMs: 60000, spawnProtectMs: 0, loadoutMs: 3000, maxPlayers: 16 });
/** 페이즈 수 */
export const BR_PHASES = BR.sizes.length;

const COL_NAMES = 'ABCDEFGHIJKLMNOP';

/** 결정적 난수(0 이상 1 미만). 같은 시드 → 같은 수열 */
export function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ============================================================ 격자 */

/** 맵의 br.grid → { x0, z0, cell, cols, rows } | null(틀린 값) */
export function normalizeGrid(g) {
  if (!g || typeof g !== 'object' || !Array.isArray(g.origin)) return null;
  const x0 = +g.origin[0], z0 = +g.origin[1], cell = +g.cell;
  const cols = Math.round(+g.cols || 8), rows = Math.round(+g.rows || 8);
  if (![x0, z0, cell].every(Number.isFinite) || !(cell > 0) || cols < 2 || rows < 2 || cols > COL_NAMES.length || rows > 16) return null;
  return { x0, z0, cell, cols, rows };
}

/** 칸 번호(행 우선) → 'B-4'(열 글자 A~, 행 1~) */
export function sectorName(grid, idx) {
  if (!grid || !(idx >= 0)) return '';
  const c = idx % grid.cols, r = Math.floor(idx / grid.cols);
  return `${COL_NAMES[c]}-${r + 1}`;
}

/** 월드 좌표 → 칸 번호. 격자 밖이면 -1 */
export function sectorAt(grid, x, z) {
  if (!grid) return -1;
  const c = Math.floor((x - grid.x0) / grid.cell), r = Math.floor((z - grid.z0) / grid.cell);
  if (c < 0 || r < 0 || c >= grid.cols || r >= grid.rows) return -1;
  return r * grid.cols + c;
}

/** 칸 번호 → 가운데 [x, z] */
export function sectorCenter(grid, idx) {
  const c = idx % grid.cols, r = Math.floor(idx / grid.cols);
  return [grid.x0 + (c + 0.5) * grid.cell, grid.z0 + (r + 0.5) * grid.cell];
}

/**
 * 맵 데이터의 br 칸 → { grid, loot, spawns } | null. 배틀로얄 엔진은 맵에서 이 칸만 읽는다(docs/MAP_GUIDE.md, MODES.md 15절).
 * 격자 밖이거나 좌표가 틀린 보급 지점·출발 지점은 뺀다. 남은 보급 지점이나 출발 지점이 없으면 null
 */
export function brMapData(data) {
  const b = data && !data.fallback && data.br && typeof data.br === 'object' ? data.br : null;
  const grid = b ? normalizeGrid(b.grid) : null;
  if (!grid) return null;
  const ok3 = (p) => Array.isArray(p) && p.length >= 3 && p.slice(0, 3).every(Number.isFinite) && sectorAt(grid, p[0], p[2]) >= 0;
  const loot = (Array.isArray(b.loot) ? b.loot : [])
    .filter((l) => l && ok3(l.pos))
    .map((l) => ({ pos: [l.pos[0], l.pos[1], l.pos[2]], tier: l.tier === 'rare' ? 'rare' : 'common' }));
  const spawns = (Array.isArray(b.spawns) ? b.spawns : []).filter(ok3).map((p) => [p[0], p[1], p[2]]);
  if (!loot.length || !spawns.length) return null;
  return { grid, loot, spawns };
}

/* ============================================================ 봉쇄 일정 */

/** 사각형 { c, r, s }(왼쪽 위 열·행, 한 변 칸 수) 안의 칸 번호 */
function rectCells(grid, rc) {
  const out = [];
  for (let r = rc.r; r < rc.r + rc.s; r++) for (let c = rc.c; c < rc.c + rc.s; c++) out.push(r * grid.cols + c);
  return out;
}

/**
 * 시드 → 봉쇄 일정. 마지막 안전 칸(final)을 먼저 고르고, 거기서 거꾸로 한 변이 커지는 정사각형을 겹겹이 고른다.
 * 그래서 페이즈마다 안전 구역은 앞 안전 구역 안에 있고(이어진 정사각형), 마지막 칸은 처음부터 끝까지 안전하다.
 * @param {{ seed:number, grid:object, candidates?: number[] }} o candidates = 마지막 칸이 될 수 있는 칸(보급품·출발 지점이 있는 칸). 없으면 모든 칸
 * @returns {{ seed, grid, final, phases: Array<{ n, announceAt, closeAt, closes:number[], safe:number[], dps }>, overtimeAt }}
 */
export function buildSchedule({ seed = 0, grid, candidates } = {}) {
  const g = grid && grid.cols ? grid : normalizeGrid(grid);
  if (!g) throw new Error('buildSchedule: grid가 필요합니다');
  const rng = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  const total = g.cols * g.rows;
  const pool = (Array.isArray(candidates) ? candidates : []).filter((i) => Number.isInteger(i) && i >= 0 && i < total);
  const list = pool.length ? [...new Set(pool)].sort((a, b) => a - b) : Array.from({ length: total }, (_, i) => i);
  const final = list[Math.floor(rng() * list.length)];
  const side = Math.min(g.cols, g.rows);
  // 거꾸로: 1칸(final) → … → 6칸. 큰 사각형은 작은 사각형을 품고 격자 안에 있어야 한다
  const sizes = BR.sizes.map((s) => Math.min(s, side));
  const rects = new Array(sizes.length);
  let prev = { c: final % g.cols, r: Math.floor(final / g.cols), s: 1 };
  for (let k = sizes.length - 1; k >= 0; k--) {
    const s = Math.max(prev.s, sizes[k]);
    const pick = (p, max) => {
      const lo = Math.max(0, p.at + p.s - s), hi = Math.min(p.at, max - s);
      return lo + Math.floor(rng() * (hi - lo + 1));
    };
    const rc = { c: pick({ at: prev.c, s: prev.s }, g.cols), r: pick({ at: prev.r, s: prev.s }, g.rows), s };
    rects[k] = rc;
    prev = rc;
  }
  const phases = [];
  let safePrev = Array.from({ length: total }, (_, i) => i);
  let t = BR.freeMs;
  for (let k = 0; k < sizes.length; k++) {
    const safe = rectCells(g, rects[k]);
    const keep = new Set(safe);
    const closes = safePrev.filter((i) => !keep.has(i));
    const announceAt = t, closeAt = t + BR.warnMs;
    phases.push({ n: k + 1, announceAt, closeAt, closes, safe, dps: BR.dps[k] });
    safePrev = safe;
    t = closeAt + (k < BR.holdMs.length ? BR.holdMs[k] : 0);
  }
  const overtimeAt = phases[phases.length - 1].closeAt + BR.finalHoldMs;
  return { seed: seed >>> 0, grid: g, final, phases, overtimeAt };
}

/** 봉쇄된 페이즈 수(0~5, 연장이면 6) → 봉쇄 구역 안 초당 피해 */
export function zoneDps(closedPhases) {
  if (!(closedPhases >= 1)) return 0;
  if (closedPhases > BR.dps.length) return BR.overtimeDps;
  return BR.dps[Math.floor(closedPhases) - 1];
}

/**
 * 봉쇄 진행(결정적). advance(t)로 시간을 옮기면 그 사이에 일어난 일을 시각 순서대로 돌려준다.
 *   { type:'announce', n, sectors, closeAt } · { type:'close', n, sectors } · { type:'overtime' }
 * closed[i] = 1이면 봉쇄 구역, closing[i] = 1이면 다음에 봉쇄될 구역(예고 중)
 */
export function createZone(schedule) {
  const S = schedule;
  const n = S.grid.cols * S.grid.rows;
  const closed = new Uint8Array(n);
  const closing = new Uint8Array(n);
  const steps = [];
  for (const p of S.phases) {
    steps.push({ at: p.announceAt, type: 'announce', p });
    steps.push({ at: p.closeAt, type: 'close', p });
  }
  steps.push({ at: S.overtimeAt, type: 'overtime' });
  let idx = 0, now = 0, closedPhases = 0, warn = null;
  return {
    closed, closing,
    get now() { return now; },
    /** 봉쇄된 페이즈 수(연장이면 페이즈 수 + 1) */
    get phase() { return closedPhases; },
    /** 예고 중인 페이즈 { n, closes, closeAt } | null */
    get warning() { return warn; },
    get dps() { return zoneDps(closedPhases); },
    get overtime() { return closedPhases > S.phases.length; },
    /** 다음 일 { at, type } | null */
    get next() { return idx < steps.length ? { at: steps[idx].at, type: steps[idx].type } : null; },
    /** 지금 안전 구역(연장이면 빈 배열) */
    get safe() { return closedPhases > S.phases.length ? [] : closedPhases ? S.phases[closedPhases - 1].safe : null; },
    /** 다음 봉쇄 뒤에도 안전한 구역(예고 중이면 그 페이즈의 safe, 아니면 지금 안전 구역). 처음엔 null = 전부 */
    get target() {
      if (warn) return warn.safe;
      return this.safe;
    },
    isClosed(i) { return i < 0 ? closedPhases > 0 : closed[i] === 1; },
    advance(t) {
      const out = [];
      if (!(t > now)) return out;
      now = t;
      while (idx < steps.length && steps[idx].at <= now) {
        const s = steps[idx++];
        if (s.type === 'announce') {
          warn = { n: s.p.n, closes: s.p.closes, safe: s.p.safe, closeAt: s.p.closeAt };
          for (const i of s.p.closes) closing[i] = 1;
          out.push({ type: 'announce', n: s.p.n, sectors: s.p.closes.slice(), closeAt: s.p.closeAt, at: s.at });
        } else if (s.type === 'close') {
          for (const i of s.p.closes) { closing[i] = 0; closed[i] = 1; }
          closedPhases = s.p.n;
          warn = null;
          out.push({ type: 'close', n: s.p.n, sectors: s.p.closes.slice(), at: s.at });
        } else {
          closed.fill(1); closing.fill(0);
          closedPhases = S.phases.length + 1;
          out.push({ type: 'overtime', at: s.at });
        }
      }
      return out;
    }
  };
}

/* ============================================================ 보급품 */

/** 무기 id 목록에서 실제로 있고 좀비 전용·카드 전용이 아닌 총만 */
const realGuns = (ids) => Object.freeze(ids.filter((id) => { const d = getDef(id); return !!d && !d.zombieOnly && !d.cardOnly && (d.slot === 1 || d.slot === 2); }));
/** 일반 등급 총: 권총·기관단총·산탄총 */
export const LOOT_COMMON_GUNS = realGuns(['pt_magnum', 'sg_shorty', 'sm_vx3', 'sm_uzi_dual', 'sg_bx12', 'sg_pump', 'sg_double']);
/** 희귀 등급 총: 소총·지정사수·저격 */
export const LOOT_RARE_GUNS = realGuns(['ar_std', 'ar_rapid', 'ar_burst', 'ar_line', 'dm_mark', 'sr_bolt', 'sr_swift', 'sr_twin', 'sr_heavy']);
/** 등급별 굴림 표(가중치): 총 · 탄약 · 구급상자 */
export const LOOT_TABLE = Object.freeze({
  common: Object.freeze({ gun: 50, ammo: 30, medkit: 20 }),
  rare: Object.freeze({ gun: 80, ammo: 5, medkit: 15 })
});

/**
 * 시드 + 맵 보급 지점 → 놓을 보급품. 지점마다 하나씩, 등급 표대로 굴린다.
 * @param {number} seed
 * @param {Array<{ pos:number[], tier:'common'|'rare' }>} points
 * @returns {Array<{ i, pos:number[], tier, kind:'gun'|'ammo'|'medkit', weaponId:string|null }>}
 */
export function rollLoot(seed, points) {
  const rng = mulberry32((seed ^ 0x5bd1e995) >>> 0);
  const out = [];
  (Array.isArray(points) ? points : []).forEach((p, i) => {
    if (!p || !Array.isArray(p.pos) || p.pos.length < 3 || !p.pos.slice(0, 3).every(Number.isFinite)) return;
    const tier = p.tier === 'rare' ? 'rare' : 'common';
    const t = LOOT_TABLE[tier];
    let r = rng() * (t.gun + t.ammo + t.medkit);
    const kind = (r -= t.gun) < 0 ? 'gun' : (r -= t.ammo) < 0 ? 'ammo' : 'medkit';
    const guns = tier === 'rare' ? LOOT_RARE_GUNS : LOOT_COMMON_GUNS;
    const weaponId = kind === 'gun' ? guns[Math.floor(rng() * guns.length)] : null;
    out.push({ i, pos: [p.pos[0], p.pos[1], p.pos[2]], tier, kind, weaponId });
  });
  return out;
}

/* ============================================================ 순위 */

/**
 * 탈락 기록 → 순위. 늦게 탈락할수록 높고, 같은 시각에 탈락한 사람은 같은(더 좋은) 순위다. 살아 있는 사람은 1위.
 * @param {string[]} ids 참가자 전원
 * @param {Array<{ id:string, at:number }>} deaths 탈락 기록
 * @returns {Map<string, number>} id → 순위(1 = 최후의 1인)
 */
export function placements(ids, deaths) {
  const at = new Map();
  for (const d of Array.isArray(deaths) ? deaths : []) if (d && !at.has(d.id) && Number.isFinite(d.at)) at.set(d.id, d.at);
  const out = new Map();
  for (const id of ids) {
    if (!at.has(id)) { out.set(id, 1); continue; }
    const t = at.get(id);
    let better = 0;   // 나보다 오래 버틴 사람(살아 있거나 더 늦게 탈락)
    for (const o of ids) if (o !== id && (!at.has(o) || at.get(o) > t)) better++;
    out.set(id, better + 1);
  }
  return out;
}

/* ============================================================ 이동 */

/**
 * 배틀로얄 이동 값: 버니합으로 속도를 쌓지 못한다. 수평 상한은 걷기보다 조금 빠르고, 착지 직후 점프에도 마찰을 먹으며(HOP_FRICTION),
 * 공중 가속과 A/D 교체 보너스를 줄이거나 끈다. player.setMoveTuning({ move: BR_MOVE })로 쓰고, 부정행위 검사도 이 값을 쓴다.
 */
export const BR_MOVE = Object.freeze({
  ...MOVE,
  MAX_SPEED: Math.round((PLAYER.WALK + 0.4) * 10) / 10,
  AIR_ACCEL: 8,
  HOP_GRACE: 0,
  HOP_FRICTION: true,
  SWAP_BONUS: 0
});
