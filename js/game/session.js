/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 멀티플레이 세션. 로비, 대기실, 경기, 결과 흐름을 묶고 방장이 경기 규칙을 돌린다.
 */
/**
 * SKALA 작전 — 멀티플레이 세션: 로비 → 방(대기실) → 경기(팀전·개인전 × 클래식·칼전·스나전, 폭파 미션) → 결과
 *
 *   import { createSession } from './game/session.js';
 *   const mp = createSession({ ctx, world, ui, settings, bus, playerName });  // net을 생략하면 open() 때 직접 연결
 *   mp.on('exit', () => ui.show('menu'));       // 로비 [← 메뉴]
 *   await mp.open();                             // 로비 표시 + 방 목록 실시간 구독
 *   mp.dispose();                                // 로비 구독·방·sync 해제(직접 연결했으면 소켓도)
 *
 * 흐름
 *   로비   net.lobby.subscribe → ui 'lobby'. 방 만들기(최대 6명, 모드·규칙·맵) / 참가. 표시 이름은 계정 닉네임
 *   방     presence → ui 'room'(팀·준비·방장·핑·채팅). 팀·준비 = room.updateMe, 맵·모드·규칙·개인전 목표 킬(5~20) = room.updateMeta(방장)
 *   시작   방장 [게임 시작] → 'mx' prep 알림 + 맵 로드 → createMatch({ rules: { ruleset, killTarget } }) → 준비 스냅샷 → 모두 맵 로드(ack) → start()
 *   경기   방장이 match.js를 돌리고(tick·claimHit·claimExplosion·setLoadout·addPlayer/removePlayer) sync.sendMatch로 뿌린다.
 *          모두(방장 포함) 같은 경로로 스냅샷·이벤트를 world·ui에 반영한다.
 *          로컬 상태는 sync가 min(10, room.rate)Hz로 보내고, 원격은 sync.getRemote(보간)를 매 프레임 world.setActorState로.
 *   이탈   방장이 나가면 새 방장이 sync.lastMatch() 스냅샷으로 restoreMatch() → 점수·기록을 이어 그 라운드를 다시 시작.
 *          준비 중이었거나 복원이 안 되면 "방장이 나가 경기가 종료됐어요"로 모두 방으로.
 *   결과   standings → account.recordMatch(경기당 한 번) → ui 'results'(획득 포인트). [방으로 돌아가기] → 대기실(warmup)
 *   폭파 미션  미션 맵·클래식 고정. world 'bombAction'(E 키) → sync.sendBomb → 방장 match.bombIntent. 스냅샷마다 world.setBomb (MODES.md 5절)
 *
 * 계약서: js/game/SESSION_API.md
 */
import { createSync } from './sync.js';
import { cleanPassword } from '../net/secret.js';
import { checkHitClaim, createMoveGuard, createStrikes, GUARD } from './anticheat.js';
import { lineOfSight } from '../engine/physics.js';
import { createMatch, applySnapshot, standings, REASON_LABELS, DEFAULT_RULES, TEAM_IDS, normalizeWeaponId } from './match.js';
import { getDef, GRENADE_IDS, DEFAULT_LOADOUT as DEFAULT_GEAR } from '../weapons/defs.js';
import {
  RULESETS, DEFAULT_RULESET, normalizeRuleset, rulesetOf, isWeaponAllowed, pickableWeapons, defaultPick, FFA_KILLS, normalizeKillTarget, parseKillTarget
} from './modes.js';
import { avatarIdOf } from '../core/avatar-defs.js';
import { BOMB_REASON_LABELS } from './mission.js';

export const SESSION_DEFAULTS = Object.freeze({
  maxPlayers: 6,          // 무료 플랜 한도(3:3). 방 만들기 max는 2..maxPlayers로 자른다
  mapId: 'jetty',
  sendHz: 10,             // sync rateHz(실제 = min(10, room.rate))
  hostTickMs: 100,        // 방장 경기 루프(setInterval: 백그라운드 탭에서도 돈다)
  snapshotMs: 1000,       // 변화가 없을 때 방장 스냅샷 주기
  prepTimeoutMs: 8000,    // 모두 맵을 불러올 때까지 기다리는 최대 시간
  leaveGraceMs: 2000,     // 경기 중 presence에서 사라진 사람을 퇴장 처리하기까지(순단 대비)
  loadoutLeadMs: 700,     // 로드아웃 자동 선택을 방장 마감보다 이만큼 먼저(선택이 제때 도착하게)
  rules: null,            // match.js rules 덮어쓰기(테스트: 짧은 라운드)
  chatKeep: 60,
  frameOrder: -60,        // ctx.onFrame 순서(core avatars.update(-50)보다 먼저)
  setScreens: true,       // ctx가 있으면 core 화면(lobby·room·match·results)을 등록하고 전환한다(입력·포인터 잠금은 'match'에서만 켜짐)
  stallMs: 15000          // 경기 중 방장 소식이 이만큼 없으면 대기실로(자가 복구)
});

export const ROOM_NOTE = '무료 서버 한도 때문에 최대 6명(인원이 적을수록 더 부드러워요)';
/** 채팅 도배 막기: 내가 보내는 것은 5초에 4줄까지(넘으면 안내만), 받는 것은 한 사람당 5초에 6줄까지(고친 클라이언트 대비) */
export const CHAT_LIMIT = Object.freeze({ windowMs: 5000, send: 4, receive: 6 });
const CHAT_SLOW = '채팅을 너무 빨리 보내고 있어요. 잠시 뒤에 다시 보내 주세요.';
/** 세션 제어 이벤트(room.send): { k:'prep', mid, map, mode, rs } 방장→모두 / { k:'loaded', mid } 멤버→방장 */
export const CONTROL_EVENT = 'mx';

const TEAM_NAME = Object.freeze({ owner: '블루', charterer: '레드' });
const PHASE_ORDER = Object.freeze({ warmup: 0, loadout: 1, live: 2, roundEnd: 3, matchEnd: 4 });
const ACTIVE = new Set(['loadout', 'live', 'roundEnd']);
/** 무기 슬롯 → 장비 키. 4번(수류탄)은 고르는 칸이 없다 */
const SLOT_KEY = Object.freeze({ 1: 'primary', 2: 'secondary', 3: 'melee' });
const REASON_CODE = Object.freeze({ elimination: 'e', time: 't', hp: 'h', draw: 'd', bomb: 'b', defuse: 'f' });
const RULE_KEYS = Object.freeze(Object.keys(DEFAULT_RULES));
const SNAPSHOT_BUDGET = 1800;   // match.js와 같은 예산(protocol 부가 영역 2048B 안)

const ERROR_TEXT = Object.freeze({
  ROOM_FULL: '방이 가득 찼어요.',
  ROOM_NOT_FOUND: '방을 찾을 수 없어요. 이미 닫혔을 수 있어요.',
  JOIN_TIMEOUT: '방 응답이 없어요. 다시 시도해 주세요.',
  JOIN_ERROR: '방에 들어가지 못했어요. 다시 시도해 주세요.',
  TRACK_FAILED: '방 등록에 실패했어요. 잠시 후 다시 시도해 주세요.',
  BAD_ROOM_ID: '잘못된 방 번호예요.',
  BAD_PASSWORD: '비밀번호가 맞지 않아요.',
  NEED_PASSWORD: '비밀번호가 필요한 방이에요.',
  NO_CRYPTO: '이 브라우저는 비밀번호 방을 지원하지 않아요.',
  CONNECT_TIMEOUT: '서버 연결이 늦어지고 있어요. 다시 시도해 주세요.',
  NO_CONFIG: '멀티플레이 서버 설정이 없어요.',
  NO_WEBSOCKET: '이 브라우저는 실시간 연결을 지원하지 않아요.',
  CLOSED: '서버 연결이 끊겼어요. 다시 시도해 주세요.',
  NO_NET: '멀티플레이 서버에 연결할 수 없어요.'
});
/** 내보낸 사람에게서 오면 버리는 이벤트 */
const BANNED_DROP = new Set(['fire', 'hitClaim', 'grenade', 'loadout', 'chat', 'drop', 'pick', 'bomb']);
const CLOSE_TEXT = Object.freeze({
  'kicked:full': '방이 가득 차서 들어가지 못했어요.',
  'kicked:cheat': '비정상 플레이가 반복돼 방장이 방에서 내보냈어요.',
  'net-closed': '서버 연결이 끊겼어요.'
});
const ABORT_TEXT = Object.freeze({
  'host-left': '방장이 나가 경기가 종료됐어요.',
  'map-failed': '방장이 맵을 불러오지 못해 경기가 취소됐어요.',
  'start-failed': '경기를 시작하지 못했어요. 팀 구성을 확인해 주세요.',
  alone: '다른 사람이 모두 나가 경기가 끝났어요.'
});

const defaultNow = () => (globalThis.performance && performance.now ? performance.now() : Date.now());
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function clampInt(v, lo, hi, d) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
}
function cleanText(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
function randomId(n = 8) {
  const abc = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  const c = globalThis.crypto;
  if (c && typeof c.getRandomValues === 'function') {
    const b = new Uint8Array(n);
    c.getRandomValues(b);
    for (let i = 0; i < n; i++) s += abc[b[i] % abc.length];
    return s;
  }
  for (let i = 0; i < n; i++) s += abc[Math.floor(Math.random() * abc.length)];
  return s;
}
function utf8Len(str) {
  let n = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; }
    else n += 3;
  }
  return n;
}
const jsonLen = (v) => utf8Len(JSON.stringify(v));
/** [x,y,z] | {x,y,z} → [x,y,z] | null */
function vec(p) {
  if (!p || typeof p !== 'object') return null;
  const a = Array.isArray(p) ? p : [p.x, p.y, p.z];
  const x = +a[0], y = +a[1], z = +a[2];
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  return [x, Number.isFinite(y) ? y : 0, z];
}
function leaderOf(sc) {
  return sc.owner > sc.charterer ? 'owner' : sc.charterer > sc.owner ? 'charterer' : null;
}
/** match.js endRound와 같은 순서: 선승 → 승부 난 라운드 상한 → 총 라운드 상한 */
function decideSeries(sc, played, R) {
  if (sc.owner >= R.roundsToWin) return { winner: 'owner', reason: 'wins' };
  if (sc.charterer >= R.roundsToWin) return { winner: 'charterer', reason: 'wins' };
  if (sc.owner + sc.charterer >= R.maxRounds) return { winner: leaderOf(sc), reason: 'maxRounds' };
  if (played >= R.maxTotalRounds) return { winner: leaderOf(sc), reason: 'roundCap' };
  return null;
}
function matchPointTeams(sc, rules) {
  const need = (rules && rules.roundsToWin) || DEFAULT_RULES.roundsToWin;
  return TEAM_IDS.filter((t) => (sc && sc[t]) === need - 1);
}
function errorText(e) {
  const code = e && e.code;
  return (code && ERROR_TEXT[code]) || '연결에 문제가 생겼어요. 잠시 후 다시 시도해 주세요.';
}
const isJoinable = (snap) => !!snap && !snap.abort && (!!snap.prep || ACTIVE.has(snap.ph));
/** 'ffa'(개인전) | 'bomb'(폭파 미션) | 'team'(팀전, 기본) */
const modeOf = (v) => (v === 'ffa' || v === 'bomb' ? v : 'team');
const MODE_LABEL = Object.freeze({ team: '팀전 · 5판 3선승', ffa: '개인전 · 모두가 적', bomb: '폭파 미션 · 5판 3선승' });
/** 팀으로 나뉘는 모드(팀전·폭파 미션) */
const isTeamMode = (m) => m !== 'ffa';
/** 목표 킬 안내를 이 시간 안에 다시 바꾸면 채팅에 새 줄을 더하지 않고 마지막 안내 줄을 고친다(방장이 ＋를 연달아 누를 때) */
const KILL_NOTE_MERGE_MS = 5000;
/**
 * 먼저 있던 사람의 팀을 다 모른 채(presence가 아직 오는 중) 자동으로 고른 팀은, 들어온 뒤 이 시간 안에 그 팀들이 보이면 한 번 다시 고른다.
 * 그보다 늦게 온 presence로는 대기실에 앉아 있던 사람의 팀을 바꾸지 않는다
 */
const AUTO_TEAM_RECHECK_MS = 10000;
const killNoteText = (k) => `목표 킬이 ${k}킬로 바뀌었어요 · 먼저 ${k}킬을 채우면 우승`;

/* ======================================================================
 * 규칙 · 장비 · 결과 도우미 (순수 함수, tests/session-wiring.test.mjs)
 * ==================================================================== */
/** 라운드 전에 고를 수 있는 무기인가(match.setLoadout과 같은 기준). 보유 여부는 방장이 알 수 없어 보지 않는다 */
function isPickable(ruleset, id) {
  const def = getDef(id);
  return !!def && def.slot === rulesetOf(ruleset).pickSlot && isWeaponAllowed(ruleset, id);
}

/** 규칙이 허용하는 슬롯. 막힌 슬롯이면 허용된 첫 슬롯(칼전은 언제나 칼) */
function allowedSlot(ruleset, slot) {
  const { slots } = rulesetOf(ruleset);
  return slots.includes(slot) ? slot : slots[0];
}

/** 미리 골라 둘 무기: 이 규칙에서 직전에 고른 것 → 계정 장비 → 규칙 기본값. 화면에 나오는 목록(보유 무기) 안에서만 고른다 */
export function preferredPick(ruleset, owned, equipped, last) {
  const list = pickableWeapons(ruleset, owned);
  const mine = equipped && typeof equipped === 'object' ? equipped[SLOT_KEY[rulesetOf(ruleset).pickSlot]] : null;
  return [last, mine, defaultPick(ruleset)].find((id) => id && list.includes(id)) || list[0];
}

/** g2l 로드아웃 내용: pick = 규칙의 pickSlot 무기, primary·secondary·melee = 다른 사람 화면에 그릴 장비 */
export function gearMessage(ruleset, pick, equipped) {
  const eq = equipped && typeof equipped === 'object' ? equipped : DEFAULT_GEAR;
  const gear = { primary: eq.primary, secondary: eq.secondary, melee: eq.melee };
  gear[SLOT_KEY[rulesetOf(ruleset).pickSlot]] = pick;
  return { pick, ...gear };
}

/** 받은 g2l 내용(믿을 수 없는 값) → { pick?, primary?, secondary?, melee? }. 모르는 무기와 슬롯이 안 맞는 무기는 조용히 버린다 */
export function readGear(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const slot of [1, 2, 3]) {
    const key = SLOT_KEY[slot];
    const id = normalizeWeaponId(src[key]);
    if (id && getDef(id).slot === slot) out[key] = id;
  }
  const pick = normalizeWeaponId(src.pick != null ? src.pick : src.primary);
  if (pick) out.pick = pick;
  return out;
}

/**
 * 원격 아바타가 든 무기: 그 사람의 장비 → (pickSlot이면) 방장이 확정한 선택 → 규칙 기본값 → 기본 장비.
 * 이 규칙에서 못 쓰는 무기는 그리지 않는다. 수류탄은 한 종류뿐이라 표에서 찾는다.
 */
export function weaponForSlot(gear, slot, ruleset, confirmed) {
  const rs = rulesetOf(ruleset);
  const n = allowedSlot(rs.id, slot);
  const key = SLOT_KEY[n];
  if (!key) return GRENADE_IDS[0];
  const mine = gear && typeof gear === 'object' ? gear[key] : null;
  if (mine && isWeaponAllowed(rs.id, mine)) return mine;
  if (n !== rs.pickSlot) return DEFAULT_GEAR[key];
  return isPickable(rs.id, confirmed) ? confirmed : rs.defaultPick;
}

/** 결과표의 내 줄. matchEnd 뷰가 있으면 그것, 아니면 matchEnd 이벤트의 표(늦게 온 이벤트라 스냅샷이 없을 때) */
function myStats(view, event, me) {
  const vp = view && Array.isArray(view.players) ? view.players.find((p) => p.id === me) : null;
  if (vp && view.phase === 'matchEnd') return vp;
  const ev = event && typeof event === 'object' ? event : {};
  const ranked = Array.isArray(ev.ranking) ? ev.ranking.find((r) => r && String(r.id) === me) : null;
  if (ranked) return ranked;
  const row = Array.isArray(ev.stats) ? ev.stats.find((r) => Array.isArray(r) && String(r[0]) === me) : null;
  if (row) return { kills: row[1], deaths: row[2], headshots: row[3], halfShots: row[5] };
  return vp;
}

/**
 * 경기 결과 → account.recordMatch의 summary. 결과표에 내가 없으면 null.
 * 킬·데스·헤드샷·반샷은 방장이 확정한 값이다(방장이 바뀌었으면 합산된 값). knifeKills만 내가 본 킬 이벤트로 세므로 킬 수를 넘지 못하게 자른다.
 * 개인전이면 그 경기의 목표 킬(killTarget)도 싣는다. 짧은 판의 승리 보상을 줄이는 데 쓴다(account/economy.js).
 * o: { view, event, me, mode, ruleset, mapId, team, knifeKills, seconds }
 */
export function matchSummary(o) {
  const me = String(o.me);
  const row = myStats(o.view, o.event, me);
  if (!row) return null;
  const ffa = o.mode === 'ffa';
  const res = (o.view && o.view.result) || o.event || {};
  const winner = res.winner == null || res.winner === 'draw' ? null : String(res.winner);
  const kills = row.kills | 0;
  return {
    online: true, ruleset: normalizeRuleset(o.ruleset), mode: ffa ? 'ffa' : o.mode === 'bomb' ? 'bomb' : 'team', mapId: o.mapId,
    kills, deaths: row.deaths | 0, headshots: row.headshots | 0, halfShots: row.halfShots | 0,
    knifeKills: Math.min(kills, o.knifeKills | 0),
    win: !!winner && winner === (ffa ? me : o.team), draw: !winner,
    seconds: Math.max(0, Math.round(Number(o.seconds) || 0)),
    ...(ffa ? { killTarget: ffaTarget(o.view) } : {})
  };
}

/* ======================================================================
 * 방장 이전 복원: 이전 방장의 match 스냅샷(점수·라운드 기록·개인 기록·규칙)을 이어받아
 * 새 match.js 경기를 감싼다. 진행 중이던 라운드는 처음(loadout)부터 다시 한다.
 * match.js와 같은 메서드·이벤트·스냅샷 형식을 쓴다(라운드 번호·점수·통계는 합친 값).
 * ==================================================================== */
export function restoreMatch({ snapshot: source, players = [], spawns, seed, rng, mission, getPositions, floorAt } = {}) {
  const view = applySnapshot(source);
  if (!view) throw new Error('restoreMatch: 스냅샷을 읽을 수 없어요');
  const R = Object.freeze({ ...DEFAULT_RULES, ...view.rules });
  const ru = RULE_KEYS.map((k) => R[k]);
  const off = view.history.length;                         // 끝난 라운드 수(무승부 포함)
  const bombMode = view.mode === 'bomb';                   // 폭파 미션: 진영 교대는 전체 라운드 번호로 센다(roundOffset)
  const carryScore = { owner: view.score.owner | 0, charterer: view.score.charterer | 0 };
  const carryH = view.history.map((h) => {
    const row = [TEAM_IDS.indexOf(h.winner), REASON_CODE[h.reason] || String(h.reason || 'd')];
    if (bombMode) row.push(TEAM_IDS.indexOf(h.attack));
    return row;
  });
  const lastDraw = off > 0 && view.history[off - 1].winner == null;
  const carry = new Map();
  for (const p of view.players) {
    carry.set(p.id, {
      id: p.id, name: p.name, team: p.team, loadout: p.loadout,
      kills: p.kills | 0, deaths: p.deaths | 0, headshots: p.headshots | 0, halfShots: p.halfShots | 0, damage: p.damage | 0
    });
  }
  // 기록은 이 래퍼가 합치므로 안쪽 경기에는 고른 무기만 넘긴다(같은 라운드를 다시 해도 선택이 그대로다)
  const picks = {};
  for (const p of players) {
    const c = p ? carry.get(String(p.id)) : null;
    if (c) picks[c.id] = { loadout: c.loadout };
  }
  // 승부 판정은 이 래퍼가 합친 점수로 한다 → 안쪽 경기는 스스로 끝나지 않게(퇴장 forfeit만 남김)
  const inner = createMatch({
    rules: { ...R, roundsToWin: 999, maxRounds: 999, maxTotalRounds: 999 },
    players, spawns, seed, rng, carry: picks,
    ...(bombMode ? { mission, getPositions, floorAt, roundOffset: off } : {})
  });
  let decided = null;     // { winner, reason, finalRound }
  let endLeft = 0;        // 승부가 난 마지막 roundEnd 남은 ms
  let result = null;      // { winner, reason, mvpId }
  let started = false, disposed = false;
  let innerScore = { owner: 0, charterer: 0 }, innerPlayed = 0, curRound = off;

  if (view.phase === 'matchEnd') {
    const r = view.result || {};
    const winner = r.winner === undefined ? leaderOf(carryScore) : r.winner;
    result = { winner, reason: r.reason || 'wins', mvpId: r.mvpId == null ? null : r.mvpId };
    decided = { winner, reason: result.reason, finalRound: view.lastRound && view.lastRound.final ? view.lastRound.round : 0 };
    started = true;
  } else if (view.phase === 'roundEnd' && view.lastRound && view.lastRound.final) {
    decided = { ...(decideSeries(carryScore, off, R) || { winner: leaderOf(carryScore), reason: 'wins' }), finalRound: view.lastRound.round };
    endLeft = view.timeLeftMs == null ? R.roundEndMs : view.timeLeftMs;
    started = true;
  }

  const total = () => ({ owner: carryScore.owner + innerScore.owner, charterer: carryScore.charterer + innerScore.charterer });

  function finish(winner, reason) {
    if (result) return [];
    if (!decided) decided = { winner, reason, finalRound: 0 };
    result = { winner, reason, mvpId: null };
    const { stats } = standings(applySnapshot(snapshot()));
    const top = stats[0];
    result.mvpId = top && (top.kills > 0 || top.headshots > 0 || top.damage > 0) ? top.id : null;
    return [
      {
        type: 'matchEnd', winner, reason, score: total(), mvpId: result.mvpId,
        stats: stats.slice(0, 12).map((s) => [s.id, s.kills, s.deaths, s.headshots, s.damage, s.halfShots])
      },
      { type: 'phase', phase: 'matchEnd', round: curRound, durationMs: null }
    ];
  }

  function wrap(evs) {
    const out = [];
    for (const e of Array.isArray(evs) ? evs : []) {
      if (!e || typeof e !== 'object') continue;
      const t = e.type;
      if (result) { if (t === 'join' || t === 'leave' || t === 'reject') out.push(e); continue; }
      if (t === 'roundStart') {
        if (decided) continue;
        curRound = off + (e.round | 0);
        out.push({ ...e, round: curRound, replay: e.round === 1 ? lastDraw : !!e.replay, score: total() });
      } else if (t === 'phase') {
        if (e.phase === 'matchEnd' || (decided && e.phase !== 'roundEnd')) continue;
        out.push({ ...e, round: off + (e.round | 0) });
      } else if (t === 'roundEnd') {
        if (decided) continue;
        innerPlayed += 1;
        if (e.score) innerScore = { owner: e.score.owner | 0, charterer: e.score.charterer | 0 };
        const sc = total();
        const d = decideSeries(sc, off + innerPlayed, R);
        if (d) { decided = { ...d, finalRound: off + (e.round | 0) }; endLeft = R.roundEndMs; }
        out.push({ ...e, round: off + (e.round | 0), score: sc, final: !!d });
      } else if (t === 'matchEnd') {
        if (decided) continue;   // 승부가 정해진 뒤의 퇴장은 결과를 바꾸지 않는다
        out.push(...finish(e.winner === undefined ? null : e.winner, e.reason || 'forfeit'));
      } else out.push(e);
    }
    return out;
  }

  function tick(dtMs) {
    if (disposed || result) return [];
    const dt = Number(dtMs);
    if (!(dt > 0) || !Number.isFinite(dt)) return [];
    if (decided) {
      endLeft -= dt;
      return endLeft <= 0 ? finish(decided.winner, decided.reason) : [];
    }
    return wrap(inner.tick(dt));
  }

  function start() {
    if (disposed) return [];
    if (started) return result || decided ? [] : [{ type: 'reject', action: 'start', reason: 'already_started', by: null }];
    started = true;
    const ev = inner.start();
    if (ev.length && ev[0].type === 'reject') {
      if (ev[0].reason === 'need_both_teams') {
        const t = inner.state.teams;
        const winner = t.owner.players > 0 ? 'owner' : t.charterer.players > 0 ? 'charterer' : null;
        return finish(winner, winner ? 'forfeit' : 'abandoned');
      }
      started = false;
      return ev;
    }
    return wrap(ev);
  }

  function snapshot() {
    const s = inner.snapshot();
    const sc = Array.isArray(s.sc) ? s.sc : [0, 0];
    const rows = [];
    const seen = new Set();
    for (const row of Array.isArray(s.p) ? s.p : []) {
      const r = row.slice();
      const id = String(r[0]);
      seen.add(id);
      const c = carry.get(id);
      if (c) {
        r[6] = (r[6] | 0) + c.kills; r[7] = (r[7] | 0) + c.deaths; r[8] = (r[8] | 0) + c.headshots;
        r[9] = (r[9] | 0) + c.damage; r[10] = (r[10] | 0) + c.halfShots;
      }
      rows.push(r);
    }
    const out = {
      ...s,
      rn: off + (s.rn | 0),
      sc: [carryScore.owner + (sc[0] | 0), carryScore.charterer + (sc[1] | 0)],
      ru: ru.slice(),
      h: carryH.concat(Array.isArray(s.h) ? s.h : []),
      fin: decided && decided.finalRound ? decided.finalRound : 0,
      res: null,
      p: rows
    };
    if (result) { out.ph = 'matchEnd'; out.tl = null; out.res = [TEAM_IDS.indexOf(result.winner), result.reason, result.mvpId]; }
    else if (decided) { out.ph = 'roundEnd'; out.tl = Math.max(0, Math.ceil(endLeft)); }
    // 이어받기 전에 나간 사람(기록만): 예산 안에서 기록 좋은 순
    let size = jsonLen(out);
    const gone = [...carry.values()].filter((c) => !seen.has(c.id))
      .sort((a, b) => (b.kills - a.kills) || (b.headshots - a.headshots) || (b.damage - a.damage));
    for (const c of gone) {
      const row = [c.id, c.name, TEAM_IDS.indexOf(c.team), 0, 0, c.loadout || defaultPick(R.ruleset), c.kills, c.deaths, c.headshots, c.damage, c.halfShots];
      const add = jsonLen(row) + 1;
      if (size + add > SNAPSHOT_BUDGET) continue;
      rows.push(row);
      size += add;
    }
    return out;
  }

  const pass = (fn) => (...args) => (disposed ? [] : wrap(fn(...args)));
  return {
    tick,
    start,
    snapshot,
    addPlayer: pass(inner.addPlayer),
    removePlayer: pass(inner.removePlayer),
    setTeam: pass(inner.setTeam),
    setLoadout: pass(inner.setLoadout),
    claimHit: pass(inner.claimHit),
    claimExplosion: pass(inner.claimExplosion),
    bombIntent: pass(inner.bombIntent),
    dispose() { disposed = true; inner.dispose(); },
    get state() { return applySnapshot(snapshot()); },
    get rules() { return R; },
    get weaponRules() { return inner.weaponRules; },
    get mission() { return inner.mission; },
    get attack() { return inner.attack; },
    /** 이어받은 시점 { rounds: 끝난 라운드 수, score } */
    get restored() { return { rounds: off, score: { ...carryScore } }; }
  };
}

/* ======================================================================
 * 개인전(FFA) 도우미
 * ==================================================================== */
const FFA_REASON_TEXT = Object.freeze({ kills: '목표 킬 달성', time: '시간 종료', forfeit: '상대가 모두 나감', draw: '무승부' });

/** 무기 id → 화면 이름(SK-7 저격소총). 모르면 '' */
function weaponLabel(id) {
  const d = id ? getDef(normalizeWeaponId(id) || String(id)) : null;
  return d ? String(d.name || d.short || '') : '';
}

/** FFA 목표 킬 수(view.rules.killTarget → view.killTarget → 20) */
function ffaTarget(v) {
  const t = Number((v && v.rules && v.rules.killTarget) || (v && v.killTarget));
  return Number.isFinite(t) && t > 0 ? t : 20;
}

/**
 * FFA 순위 [{ rank, id, name, kills, deaths, headshots, halfShots, bot, connected }].
 * match.standings(view).ranking이 있으면 그것, 없으면 킬↓·데스↑·헤드샷↓(같으면 같은 순위)로 직접 만든다.
 */
export function ffaRanking(v) {
  if (!v) return [];
  let src = null;
  try { const st = standings(v); if (st && Array.isArray(st.ranking)) src = st.ranking; } catch (_) { src = null; }
  if (src) {
    const conn = new Map(v.players.map((p) => [p.id, p.connected]));
    return src.map((r) => ({
      rank: r.rank | 0 || 1, id: String(r.id), name: r.name || '', kills: r.kills | 0, deaths: r.deaths | 0,
      headshots: (r.headshots != null ? r.headshots : r.head) | 0, halfShots: r.halfShots | 0, bot: !!r.bot,
      connected: conn.has(String(r.id)) ? !!conn.get(String(r.id)) : true
    }));
  }
  const list = v.players.filter((p) => p.connected || p.kills || p.deaths).map((p) => ({
    id: p.id, name: p.name, kills: p.kills | 0, deaths: p.deaths | 0, headshots: p.headshots | 0, halfShots: p.halfShots | 0, bot: !!p.bot, connected: !!p.connected
  }));
  list.sort((a, b) => (b.kills - a.kills) || (a.deaths - b.deaths) || (b.headshots - a.headshots));
  let rank = 0, prev = null;
  list.forEach((r, i) => {
    if (!prev || r.kills !== prev.kills || r.deaths !== prev.deaths || r.headshots !== prev.headshots) rank = i + 1;
    r.rank = rank;
    prev = r;
  });
  return list;
}

/**
 * FFA 방장 이전 복원: 이전 방장 스냅샷의 킬·데스·헤드샷·반샷·피해, 고른 무기, 규칙, 남은 시간을 이어받은 새 FFA 경기.
 * 모두 부활 대기에서 다시 시작한다(짧은 loadout → live 시작 spawn). match.js createMatch의 carry 옵션을 쓴다.
 */
export function restoreFfaMatch({ snapshot: source, players = [], spawns, getPositions, seed, rng } = {}) {
  const view = applySnapshot(source);
  if (!view) throw new Error('restoreFfaMatch: 스냅샷을 읽을 수 없어요');
  const R = { ...(view.rules || {}) };
  const carry = {};
  for (const p of view.players) {
    carry[p.id] = {
      name: p.name, kills: p.kills | 0, deaths: p.deaths | 0, headshots: p.headshots | 0, halfShots: p.halfShots | 0, damage: p.damage | 0,
      loadout: p.loadout
    };
  }
  const full = Number(R.timeLimitMs) > 0 ? Number(R.timeLimitMs) : 300000;
  const left = view.phase === 'live' && isNum(view.timeLeftMs) ? view.timeLeftMs : full;
  const respawn = Number(R.respawnMs) > 0 ? Number(R.respawnMs) : 3000;
  const rules = {
    ...R, mode: 'ffa', timeLimitMs: Math.max(10000, Math.round(left)),
    loadoutMs: Math.min(Number(R.loadoutMs) > 0 ? Number(R.loadoutMs) : 5000, respawn)
  };
  return createMatch({ rules, players, spawns, getPositions, seed, rng, carry });
}

/* ======================================================================
 * 세션
 * ==================================================================== */
export function createSession(options = {}) {
  const o = { ...SESSION_DEFAULTS, ...(options || {}) };
  const world = o.world;
  const ui = o.ui;
  const ctx = o.ctx || null;
  if (!world || typeof world !== 'object') throw new TypeError('createSession: world가 필요합니다');
  if (!ui || typeof ui.show !== 'function' || typeof ui.on !== 'function') throw new TypeError('createSession: ui가 필요합니다');
  const now = typeof o.now === 'function' ? o.now : defaultNow;
  const maxPlayers = clampInt(o.maxPlayers, 2, 16, 6);

  /* ---------------------------------------------------------------- 이벤트 · 안전 호출 */
  const listeners = new Map();
  function on(evt, fn) {
    if (typeof fn !== 'function') return () => {};
    if (!listeners.has(evt)) listeners.set(evt, new Set());
    listeners.get(evt).add(fn);
    return () => off(evt, fn);
  }
  function off(evt, fn) { const s = listeners.get(evt); if (s) s.delete(fn); }
  function emit(evt, data) {
    const set = listeners.get(evt);
    if (!set || !set.size) return false;
    for (const fn of [...set]) { try { fn(data); } catch (e) { console.error('[session] listener', evt, e); } }
    return true;
  }
  let errCount = 0;
  function report(err, where) {
    errCount++;
    if (errCount <= 10) console.error('[session]', where, err);
    emit('error', { where, error: err });
  }
  function call(target, name, ...args) {
    const fn = target && target[name];
    if (typeof fn !== 'function') return undefined;
    try { return fn.apply(target, args); } catch (e) { report(e, name); return undefined; }
  }
  const W = (name, ...a) => call(world, name, ...a);
  const U = (name, ...a) => call(ui, name, ...a);
  const H = (name, ...a) => call(ui.hud, name, ...a);
  const trace = (...a) => { if (typeof o.log === 'function') { try { o.log(...a); } catch (_) { /* noop */ } } };
  const safeOff = (f) => { try { if (typeof f === 'function') f(); } catch (_) { /* noop */ } };

  /* ---------------------------------------------------------------- 상태 */
  let disposed = false;
  let phase = 'idle';       // idle | connecting | lobby | joining | room | match | results | leaving | closed
  let net = null, ownNet = false, netOff = null;
  let lobbyOff = null, lobbyRooms = [], lobbyError = null, busy = false;
  let pendingAction = null; // 연결 중이거나 방에서 나오는 중에 누른 방 만들기·참가(연결되면, 다 나오면 실행)
  let room = null, sync = null, me = null, leaving = false;
  let autoTeam = null;      // { at }: 먼저 있던 사람의 팀을 다 모른 채 자동으로 고른 팀(그 팀들이 보이면 한 번 다시 고른다, recheckTeam)
  let roomOffs = [];
  let chat = [];
  const chatSent = [];          // 내가 보낸 채팅 시각(CHAT_LIMIT.send)
  const chatSeen = new Map();   // 보낸 사람 id → 받은 채팅 시각(CHAT_LIMIT.receive)
  let known = new Map();    // 방 명단 id → 이름 (입장/퇴장 안내)
  let current = null;       // 진행 중인 경기(이 클라이언트 관점)
  let hm = null;            // 방장 경기
  // (방장) 치트 대비: 받은 히트 주장과 위치를 방장이 아는 위치로 다시 확인한다(game/anticheat.js). 방장 자신의 조작은 막지 못한다
  const moveGuard = createMoveGuard({ getMap: () => call(world, 'getMap') });
  const strikes = createStrikes({ now: () => now() });
  const banned = new Set();       // 이 방에서 내보낸 사람(방장만 채운다). 방에 새로 들어가면 비운다
  const selfTrail = [];           // (방장) 내 위치 기록 [{ t, pos, crouch }]: 원격이 나를 맞혔다는 주장을 확인할 때 쓴다
  let finishedMid = null;   // 결과까지 본(또는 취소된) 경기 id
  const recordedMids = new Set(); // 계정에 기록한 경기 id. 방장이 바뀌어도 경기 id는 그대로라 두 번 기록하지 않는다
  const lastPicks = new Map();    // 규칙 id → 이번 세션에서 마지막으로 고른 무기
  const actors = new Map(); // 원격 아바타 id → { id, name, team, dead, spawn }
  const remoteGear = new Map();   // 원격 id → { pick, primary, secondary, melee } (g2l, 방장 확정값, 사격 메시지)
  let avatarsById = new Map();    // 방 명단 id → 캐릭터 id(presence av). 늦게 들어와도 presence로 바로 안다
  const fireQ = [];
  let frameOff = null, rafId = null, frameTimer = null;
  let playerName = initialName();

  /* ---------------------------------------------------------------- 계정 */
  function account() { return (ctx && ctx.account) || null; }
  function accountName() {
    const a = account();
    return cleanText(a && a.profile && a.profile.nickname, 24);
  }
  function ownedIds() {
    const a = account();
    const owned = a && a.profile && a.profile.owned;
    return Array.isArray(owned) ? owned : null;
  }
  function equippedGear() {
    const a = account();
    return (a && a.loadout) || null;
  }
  /** 내 캐릭터(계정 장비). presence av로 다른 사람에게 알린다 */
  function myAvatar() {
    const a = account();
    return avatarIdOf(a && a.avatar);
  }
  /** 방 명단의 캐릭터. 모르는 값이나 옛 클라이언트(av 없음)는 기본 캐릭터 */
  function noteAvatars(list) {
    avatarsById = new Map((Array.isArray(list) ? list : []).map((x) => [x.id, avatarIdOf(x.av)]));
  }
  function avatarOf(id) { return avatarsById.get(id) || avatarIdOf(null); }
  /** 이 규칙에서 미리 골라 둘 무기 */
  function pickFor(ruleset) {
    return preferredPick(ruleset, ownedIds(), equippedGear(), lastPicks.get(ruleset));
  }
  /** 표시 이름은 계정 닉네임이다. 닉네임이 아직 없을 때(게이트 전)만 다른 이름을 쓴다 */
  function initialName() {
    const cand = [accountName(), o.playerName, call(ui, 'getPlayerName'), ctx && ctx.session && ctx.session.name];
    for (const c of cand) { const n = cleanText(c, 24); if (n) return n; }
    return '플레이어' + Math.floor(1000 + Math.random() * 9000);
  }
  /** 오프라인 때 정한 닉네임을 다시 등록한다. 결과를 기다리지 않는다(바뀌면 'account:change'로 온다) */
  function retryNickname() {
    const a = account();
    if (!a || typeof a.retryNickname !== 'function') return;
    try {
      const p = a.retryNickname();
      if (p && typeof p.catch === 'function') p.catch((e) => report(e, 'retryNickname'));
    } catch (e) { report(e, 'retryNickname'); }
  }
  /** 닉네임이 바뀌면(재등록·마이페이지) 표시 이름을 따라가고, 장비·캐릭터가 바뀌면 다른 사람에게 알린다 */
  function onAccountChange() {
    const n = accountName();
    if (n && n !== playerName) {
      playerName = n;
      if (room) { try { room.updateMe({ name: n }); } catch (e) { report(e, 'updateMe'); } }
      else if (phase === 'lobby' || phase === 'connecting') U('update', 'lobby', { name: n });
    }
    const av = myAvatar();
    if (room && room.me && avatarIdOf(room.me.av) !== av) { try { room.updateMe({ av }); } catch (e) { report(e, 'updateMe'); } }
    if (current) announceGear(current);
  }
  // core 화면 상태 머신: main.js는 화면이 'match'(또는 'sandbox')일 때만 캔버스 클릭 잠금·입력을 켠다
  const coreScreens = !!(o.setScreens && ctx && typeof ctx.registerScreen === 'function' && typeof ctx.setScreen === 'function');
  const screenOffs = [];
  if (coreScreens) {
    for (const name of ['lobby', 'room', 'match', 'results']) {
      try { const f = ctx.registerScreen(name, { enter() {}, exit() {} }); if (typeof f === 'function') screenOffs.push(f); }
      catch (e) { report(e, 'registerScreen ' + name); }
    }
  }
  function coreScreen(name, extra) {
    if (!coreScreens || disposed) return;
    try { const p = ctx.setScreen(name, extra || {}); if (p && p.catch) p.catch(() => {}); } catch (e) { report(e, 'ctx.setScreen'); }
  }
  function screen(name, extra) {
    emit('screen', { name, ...(extra || {}) });
    coreScreen(name, extra);
  }

  /* ---------------------------------------------------------------- 연결 */
  async function ensureNet() {
    if (net) return net;
    let src = o.net;
    if (src && typeof src.then === 'function') src = await src;
    if (src && src.lobby && src.me) {
      net = src;
    } else {
      const pid = o.playerId || ('p' + randomId(11));
      let made = null;
      if (typeof src === 'function') made = await src({ playerId: pid, name: playerName });
      else if (src && typeof src.connect === 'function') made = await src.connect({ playerId: pid, name: playerName });
      else { const mod = await import('../net/index.js'); made = await mod.connect({ playerId: pid, name: playerName }); }
      if (!made || !made.lobby || !made.me) { const e = new Error('net 연결 실패'); e.code = 'NO_NET'; throw e; }
      if (disposed) { try { await made.close(); } catch (_) { /* noop */ } const e = new Error('disposed'); e.code = 'CLOSED'; throw e; }
      net = made;
      ownNet = true;
    }
    if (typeof net.on === 'function') {
      const mine = net;
      netOff = net.on('connection', (e) => {
        if (!e || e.state !== 'closed' || disposed || net !== mine) return;
        if (room) { const r = room; leaving = true; teardownMatch(); detachRoom(); try { r.leave('net-closed'); } catch (_) { /* noop */ } leaving = false; }
        unsubscribeLobby();
        safeOff(netOff);
        netOff = null;
        net = null;
        if (phase === 'idle' || phase === 'closed') return;   // 메뉴에 있으면 화면은 그대로
        pendingAction = null;   // 방에서 나오는 중에 누른 방 만들기·참가는 끊긴 연결로 하지 않는다
        phase = 'lobby';
        lobbyError = ERROR_TEXT.CLOSED;
        U('show', 'lobby', { rooms: [], loading: false, error: lobbyError, joining: null, name: playerName });
      });
    }
    return net;
  }

  /* ---------------------------------------------------------------- 로비 */
  async function open(opts) {
    if (disposed) return api;
    const nm = accountName() || cleanText(opts && opts.name, 24);
    if (nm) playerName = nm;
    retryNickname();
    if (phase === 'lobby') { showLobby(); return api; }
    if (phase !== 'idle' && phase !== 'closed') return api;
    phase = 'connecting';
    lobbyError = null;
    U('show', 'lobby', { rooms: lobbyRooms, loading: true, error: null, joining: null, name: playerName });
    screen('lobby');
    try {
      const a = account();
      if (a && a.remoteEnabled === false) { const e = new Error('Supabase 설정 없음'); e.code = 'NO_CONFIG'; throw e; }
      await ensureNet();
    } catch (e) {
      if (disposed) return api;
      pendingAction = null;
      phase = 'lobby';
      lobbyError = errorText(e);
      U('update', 'lobby', { loading: false, error: lobbyError, joining: null });
      return api;
    }
    if (disposed) return api;
    if (phase === 'connecting') {
      enterLobby(null);
      const act = pendingAction;
      pendingAction = null;
      if (act) act();
    }
    return api;
  }

  function enterLobby(error) {
    phase = 'lobby';
    lobbyError = error || null;
    showLobby();
    screen('lobby');
    subscribeLobby();
  }
  function showLobby() {
    U('show', 'lobby', { rooms: lobbyRooms, loading: !lobbyError && !(net && net.lobby && net.lobby.synced), error: lobbyError, joining: null, name: playerName });
  }
  function subscribeLobby() {
    if (lobbyOff || !net) return;
    try {
      lobbyOff = net.lobby.subscribe((rooms, info) => {
        lobbyRooms = Array.isArray(rooms) ? rooms : [];
        if (phase === 'lobby' || phase === 'joining') U('update', 'lobby', { rooms: lobbyRooms, loading: !(info && info.synced) });
      });
    } catch (e) { report(e, 'lobby.subscribe'); }
  }
  function unsubscribeLobby() { const f = lobbyOff; lobbyOff = null; safeOff(f); }

  function refreshLobby() {
    if (phase !== 'lobby' && phase !== 'connecting') return;
    if (!net) { phase = 'idle'; open(); return; }
    lobbyError = null;
    unsubscribeLobby();
    U('update', 'lobby', { error: null, loading: true });
    subscribeLobby();
  }

  function exitToMenu() {
    // 'leaving': 방을 나가며 서버 답을 기다리는 동안에도 로비 화면이 보인다. 이때 누른 ← 메뉴를 버리지 않는다
    if (phase !== 'lobby' && phase !== 'connecting' && phase !== 'idle' && phase !== 'leaving') return;
    unsubscribeLobby();
    pendingAction = null;
    phase = 'idle';
    const heard = emit('exit', {});
    if (coreScreens) coreScreen('menu');   // core 'menu' 화면 → game/index.js가 메뉴를 띄운다
    else if (!heard) U('show', 'menu');
  }

  /** 연결 없이 누른 방 만들기·참가: 조용히 무시하지 않고 사유를 다시 보여 준다 */
  function noNet() {
    lobbyError = lobbyError || ERROR_TEXT.NO_NET;
    U('update', 'lobby', { loading: false, error: lobbyError, joining: null });
  }

  /**
   * 이 규칙(과 모드)에서 고를 수 있는 맵 목록. 폭파 미션은 미션 칸이 있는 클래식 맵(maps.mapsForMode)만.
   * 맵 모듈이 없으면 null(검사하지 않는다). 폭파 미션인데 미션 맵이 하나도 없으면 [](시작할 수 없다)
   */
  function mapsFor(ruleset, mode) {
    const maps = ctx && ctx.maps;
    if (mode === 'bomb' && maps) {
      let list = typeof maps.mapsForMode === 'function' ? call(maps, 'mapsForMode', 'bomb', 'classic') : null;
      if (!Array.isArray(list)) list = (Array.isArray(maps.MAP_LIST) ? maps.MAP_LIST : []).filter((m) => !m.test && m.mission);
      return list;
    }
    if (!maps || typeof maps.mapsForRuleset !== 'function') return null;
    const list = call(maps, 'mapsForRuleset', ruleset);
    return Array.isArray(list) && list.length ? list : null;
  }
  /** wanted를 이 규칙(모드)에서 쓸 수 있으면 그대로, 아니면 그 규칙의 첫 맵(폭파 미션인데 미션 맵이 없으면 wanted 그대로) */
  function validMapFor(ruleset, wanted, mode) {
    const list = mapsFor(ruleset, mode);
    if (!list || !list.length || (wanted && list.some((m) => m.id === wanted))) return wanted;
    return list[0].id;
  }
  /** 폭파 미션을 할 수 있는 맵인가(맵 모듈이 없으면 막지 않는다) */
  function bombMapOk(mapId) {
    const list = mapsFor('classic', 'bomb');
    return !list || list.some((m) => m.id === mapId);
  }

  /** 연결 중이거나 방에서 나오는 중(로비 화면이 먼저 뜬다)이면 누른 방 만들기·참가를 버리지 않고 그 뒤에 한다 */
  function waitsForLobby() { return phase === 'connecting' || phase === 'leaving'; }

  async function createRoom(p) {
    if (waitsForLobby()) { pendingAction = () => createRoom(p); U('update', 'lobby', { loading: true }); return; }
    if (phase !== 'lobby' || busy) return;
    if (!net) { noNet(); return; }
    busy = true;
    phase = 'joining';
    const max = clampInt(p && p.max, 2, maxPlayers, maxPlayers);
    const mode = modeOf(p && p.mode);
    const ruleset = mode === 'bomb' ? 'classic' : normalizeRuleset(p && p.ruleset);   // 폭파 미션은 클래식 고정
    U('update', 'lobby', { error: null, loading: true });
    try {
      const r = await net.createRoom({
        name: cleanText(p && p.name, 24) || `${playerName}의 방`, mapId: validMapFor(ruleset, (p && p.mapId) || o.mapId, mode), max,
        mode, ruleset, killTarget: mode === 'ffa' ? normalizeKillTarget(p && p.killTarget) : undefined,
        password: cleanPassword(p && p.password) || undefined
      });
      await attachRoom(r);
    } catch (e) {
      if (disposed) return;
      phase = 'lobby';
      lobbyError = errorText(e);
      U('update', 'lobby', { loading: false, error: lobbyError, joining: null });
    } finally { busy = false; }
  }

  async function joinRoom(roomId, password) {
    if (waitsForLobby() && roomId) { pendingAction = () => joinRoom(roomId, password); U('update', 'lobby', { joining: String(roomId) }); return; }
    if (phase !== 'lobby' || busy || !roomId) return;
    if (!net) { noNet(); return; }
    busy = true;
    phase = 'joining';
    U('update', 'lobby', { error: null, joining: String(roomId) });
    try {
      const pw = cleanPassword(password);
      const r = await net.joinRoom(String(roomId), pw ? { password: pw } : undefined);
      await attachRoom(r);
    } catch (e) {
      if (disposed) return;
      phase = 'lobby';
      lobbyError = errorText(e);
      U('update', 'lobby', { error: lobbyError, joining: null, loading: false });
    } finally { busy = false; }
  }

  /* ---------------------------------------------------------------- 방 */
  async function attachRoom(r) {
    if (disposed) { try { await r.leave(); } catch (_) { /* noop */ } return; }
    unsubscribeLobby();   // 방 안에서는 로비 구독을 끈다(presence 예산 절약)
    room = r;
    me = String(r.me.id);
    leaving = false;
    finishedMid = null;
    remoteGear.clear();
    banned.clear(); strikes.reset(); moveGuard.resetAll(); selfTrail.length = 0;
    chat = [{ system: true, text: ROOM_NOTE }];
    chatSeen.clear();
    known = new Map(r.players().map((x) => [x.id, x.name]));
    noteAvatars(r.players());
    sync = createSync({
      room: r, rateHz: o.sendHz, getLocalState: localState, onRemoteState, onEvent: onSyncEvent, ...(o.syncOptions || {})
    });
    // sync가 먼저 'host'를 처리하도록 sync 생성 뒤에 구독한다
    roomOffs = [
      r.on('players', onPlayers),
      r.on('host', onHost),
      r.on('meta', onMeta),
      r.on('closed', onClosed),
      r.on('connection', onRoomConnection),
      r.handle(CONTROL_EVENT, onControl)
    ];
    phase = 'room';
    lastMode = roomMode();
    lastRuleset = roomRuleset();
    beforeBomb = null;
    lastKills = roomKillTarget();
    killNote = null;
    autoTeam = null;
    const list = r.players();
    const mine = list.find((x) => x.id === me);
    const fix = {};
    if (!mine || !TEAM_IDS.includes(mine.team)) {
      fix.team = pickTeam(list);
      // 방이 막 열렸으면 방장의 팀이 아직 presence로 안 왔을 수 있다 → 일단 고르고, 그 팀이 보이면 다시 고른다(recheckTeam)
      if (!teamsKnown(list)) autoTeam = { at: now() };
    }
    if (playerName && r.me && r.me.name !== playerName) fix.name = playerName;   // 연결 뒤 바뀐 닉네임
    if (!r.me || r.me.av !== myAvatar()) fix.av = myAvatar();                     // 내 캐릭터(팀 배정과 같은 presence 갱신에 싣는다)
    if (Object.keys(fix).length) r.updateMe(fix);
    pushChat({
      system: true,
      text: r.isHost()
        ? (lastMode === 'ffa' ? '개인전 방을 열었어요. 2명 이상 모이고 모두 준비하면 시작할 수 있어요.'
          : lastMode === 'bomb' ? '폭파 미션 방을 열었어요. 블루 팀이 먼저 공격하고 2라운드 뒤 공수를 바꿔요.'
            : '방을 열었어요. 동료가 들어오면 팀을 나누고 준비하세요.')
        : `${r.meta.name || '방'}에 들어왔어요 · ${RULESETS[lastRuleset].name} · ${lastMode === 'ffa' ? `개인전 · 먼저 ${lastKills}킬` : MODE_LABEL[lastMode]}`
    }, false);
    renderRoom(true);
    screen('room');
    // 이미 경기 중인 방이면 방장의 다음 스냅샷(1초 안)으로 관전 합류한다(onMatchData)
  }

  function detachRoom() {
    for (const f of roomOffs.splice(0)) safeOff(f);
    if (sync) { try { sync.dispose(); } catch (e) { report(e, 'sync.dispose'); } sync = null; }
    room = null;
  }

  function teamCap() { return Math.max(1, Math.ceil(((room && room.meta.max) || maxPlayers) / 2)); }
  function pickTeam(list) {
    const n = { owner: 0, charterer: 0 };
    for (const x of list) if (x.id !== me && TEAM_IDS.includes(x.team)) n[x.team]++;
    const order = n.charterer < n.owner ? ['charterer', 'owner'] : ['owner', 'charterer'];
    for (const t of order) if (n[t] < teamCap()) return t;
    return order[0];
  }
  /** 나보다 먼저 들어온 사람(명단은 들어온 순서)과 방장의 팀이 모두 보이는가. 아니면 그 사람들의 presence가 아직 오는 중이다 */
  function teamsKnown(list) {
    const i = list.findIndex((x) => x.id === me);
    const earlier = list.slice(0, i < 0 ? list.length : i);
    const hostId = room && room.hostId();
    if (hostId && hostId !== me) {
      const host = list.find((x) => x.id === hostId);
      if (!host) return false;   // 방장이 아직 명단에 없다
      if (!earlier.includes(host)) earlier.push(host);
    }
    return earlier.every((x) => TEAM_IDS.includes(x.team));
  }
  /**
   * 방이 막 열렸을 때 들어온 손님은 방장의 팀이 presence로 오기 전에 팀을 골라 방장과 같은 팀이 될 수 있다.
   * 그렇게 고른 팀은 먼저 있던 사람들의 팀이 다 보이면 한 번 다시 고른다. 직접 팀을 골랐거나, 대기실을 벗어났거나, 오래 지났으면 그대로 둔다
   */
  function recheckTeam(list) {
    if (!autoTeam || !room) return;
    if (phase !== 'room' || now() - autoTeam.at > AUTO_TEAM_RECHECK_MS) { autoTeam = null; return; }
    if (!teamsKnown(list)) return;
    autoTeam = null;
    const want = pickTeam(list);
    const mine = list.find((x) => x.id === me);
    if (!mine || mine.team !== want) room.updateMe({ team: want });
  }

  function roomProps() {
    const meta = room.meta;
    const hostId = room.hostId();
    return {
      roomId: room.id,
      name: meta.name,
      mapId: meta.mapId,
      mode: roomMode(),
      ruleset: roomRuleset(),
      killTarget: roomKillTarget(),
      max: meta.max,
      teamMax: teamCap(),
      hostId,
      meId: me,
      players: room.players().map((x) => ({
        id: x.id, name: x.name, team: TEAM_IDS.includes(x.team) ? x.team : null, ready: !!x.ready, ping: x.ping,
        host: x.id === hostId, me: x.id === me
      })),
      chat: chat.slice(-30),
      starting: !!(hm && hm.preparing)
    };
  }
  function renderRoom(full) {
    if (!room || phase !== 'room') return;
    if (full) U('show', 'room', roomProps());
    else U('update', 'room', roomProps());
  }

  function pushChat(line, render = true) {
    chat.push(line);
    if (chat.length > o.chatKeep) chat = [chat[0], ...chat.slice(-(o.chatKeep - 1))];   // 첫 줄(안내)은 남긴다
    if (phase === 'match' && current) call(ui.chat, 'push', line);   // 경기 중이면 HUD 채팅에도 띄운다
    if (render) renderRoom();
  }
  /** 시각 목록(times)으로 창 안에서 한 줄 더 받아도 되는지 본다. 되면 지금 시각을 넣는다 */
  function chatAllowed(times, max) {
    const t = now();
    while (times.length && t - times[0] > CHAT_LIMIT.windowMs) times.shift();
    if (times.length >= max) return false;
    times.push(t);
    return true;
  }

  function onPlayers(list) {
    if (!room) return;
    noteAvatars(list);
    const cur = new Map((Array.isArray(list) ? list : []).map((x) => [x.id, x.name]));
    for (const [id, name] of cur) if (!known.has(id) && id !== me) pushChat({ system: true, text: `${name || '플레이어'}님이 들어왔어요.` }, false);
    for (const [id, name] of known) if (!cur.has(id) && id !== me) pushChat({ system: true, text: `${name || '플레이어'}님이 나갔어요.` }, false);
    known = cur;
    if (hm) hostRoster();
    renderRoom();
    recheckTeam(Array.isArray(list) ? list : []);
  }

  function onHost(info) {
    if (!room || !info) return;
    const isMe = !!info.isMe;
    pushChat({ system: true, text: isMe ? '내가 새 방장이 됐어요 👑' : `${nameOf(info.hostId)}님이 방장이 됐어요 👑` }, false);
    if (isMe) {
      if (phase === 'match' && current) {
        if (current.loaded) takeOver(); else current.pendingTakeover = true;
      } else {
        abortStale();
        safeMeta({ status: 'waiting' });
      }
    } else if (hm && info.prevHostId === me) {
      stopHost();   // 방장 자리를 잃었다(충돌 해소) → 새 방장의 스냅샷을 따른다
    }
    if (phase === 'match' && current && !isMe) {
      H('center', '방장이 바뀌었어요', 2500, { sub: '새 방장이 경기를 이어 가요', tone: 'warn' });
    }
    renderRoom();
  }

  function onClosed(info) {
    if (leaving || !room) return;
    const reason = String((info && info.reason) || '');
    teardownMatch();
    detachRoom();
    enterLobby(CLOSE_TEXT[reason] || (reason.startsWith('kicked') ? '방에서 나오게 됐어요.' : '방 연결이 끊겼어요.'));
  }

  function onRoomConnection(e) {
    if (!e) return;
    if (e.state === 'reconnecting') {
      if (phase === 'match') W('setHint', '연결이 불안정해요 — 다시 연결하는 중…');
      else pushChat({ system: true, text: '연결이 불안정해요 — 다시 연결하는 중…' });
    } else if (e.state === 'connected') {
      if (phase === 'match') W('setHint', '');
      else pushChat({ system: true, text: '다시 연결됐어요.' });
    }
  }

  function roomMode() { return room ? modeOf(room.meta.mode) : 'team'; }
  /** 방 규칙. 규칙이 없는 메타는 클래식으로 읽는다 */
  function roomRuleset() { return room ? normalizeRuleset(room.meta.ruleset) : DEFAULT_RULESET; }
  /** 개인전 목표 킬. 고른 적이 없거나 틀린 값이면 기본 20킬, 범위 밖이면 5~20 안으로 */
  function roomKillTarget() { return room ? normalizeKillTarget(room.meta.killTarget) : FFA_KILLS.def; }
  let lastMode = 'team';
  let lastRuleset = DEFAULT_RULESET;
  /** (방장) 폭파 미션으로 바꾸기 전 { ruleset, mapId }. 다른 모드로 돌아가면 그 규칙(과 쓸 수 있으면 그 맵)으로 되돌린다 */
  let beforeBomb = null;
  let lastKills = FFA_KILLS.def;
  /** 마지막 목표 킬 안내 줄 { line, at } */
  let killNote = null;
  function onMeta() {
    if (!room) return;
    const m = roomMode();
    const k = roomKillTarget();
    if (m !== lastMode) {
      lastMode = m;
      pushChat({
        system: true,
        text: m === 'ffa' ? `개인전으로 바뀌었어요 · 모두가 적 · 먼저 ${k}킬`
          : m === 'bomb' ? '폭파 미션으로 바뀌었어요 · 공격 팀이 A·B 구역에 폭탄을 설치해요' : '팀전으로 바뀌었어요 · 5판 3선승'
      }, false);
    } else if (k !== lastKills && m === 'ffa') {
      noteKills(k);
    }
    lastKills = k;
    const rs = roomRuleset();
    if (rs !== lastRuleset) {
      lastRuleset = rs;
      pushChat({ system: true, text: `규칙이 ${RULESETS[rs].name}으로 바뀌었어요 · ${RULESETS[rs].desc}` }, false);
    }
    if (phase === 'room') renderRoom();
  }
  /** 목표 킬 안내. 방장이 연달아 바꾸면 채팅이 그 안내로 가득 차지 않게 마지막 안내 줄을 고친다 */
  function noteKills(k) {
    const line = { system: true, text: killNoteText(k) };
    const t = now();
    if (killNote && chat[chat.length - 1] === killNote.line && t - killNote.at < KILL_NOTE_MERGE_MS) chat[chat.length - 1] = line;
    else pushChat(line, false);
    killNote = { line, at: t };
  }
  /** (방장) 규칙 바꾸기 → 방 메타 · 로비 목록. 지금 맵을 이 규칙에서 못 쓰면 쓸 수 있는 맵으로 같이 바꾼다 */
  function setRoomRuleset(id) {
    if (!room || phase !== 'room' || !room.isHost() || hm) return;
    if (roomMode() === 'bomb') return;   // 폭파 미션은 클래식 고정
    const rs = normalizeRuleset(id);
    if (rs === roomRuleset()) return;
    safeMeta({ ruleset: rs, mapId: validMapFor(rs, room.meta.mapId) });
    onMeta();
  }
  /**
   * (방장) 모드 바꾸기 → 방 메타 · 로비 목록. 폭파 미션이면 규칙을 클래식으로, 맵을 미션 맵으로 같이 바꾼다.
   * 폭파 미션에서 나오면 전에 고른 규칙으로 돌아가고, 지금 맵을 그 규칙에서 못 쓰면 전 맵(그것도 안 되면 그 규칙의 첫 맵)으로 바꾼다
   */
  function setMode(mode) {
    if (!room || phase !== 'room' || !room.isHost() || hm) return;
    const m = modeOf(mode);
    const from = roomMode();
    if (m === from) return;
    if (m === 'bomb') {
      const mapId = validMapFor('classic', room.meta.mapId, 'bomb');
      if (!bombMapOk(mapId)) { pushChat({ system: true, text: '폭파 미션을 할 수 있는 맵이 없어요.' }); return; }
      beforeBomb = { ruleset: roomRuleset(), mapId: room.meta.mapId || null };
      safeMeta({ mode: m, ruleset: 'classic', mapId });
    } else if (from === 'bomb' && beforeBomb) {
      const rs = normalizeRuleset(beforeBomb.ruleset);
      const cur = room.meta.mapId;
      const mapId = cur && validMapFor(rs, cur, m) === cur ? cur : validMapFor(rs, beforeBomb.mapId || cur, m);
      beforeBomb = null;
      safeMeta({ mode: m, ruleset: rs, mapId });
    } else {
      beforeBomb = null;
      safeMeta({ mode: m });
    }
    onMeta();
  }
  /** (방장, 개인전) 목표 킬 바꾸기 → 방 메타 · 로비 목록. 5~20 밖의 값은 가까운 끝으로 자르고, 숫자가 아니면 무시한다 */
  function setKillTarget(v) {
    if (!room || phase !== 'room' || !room.isHost() || hm || roomMode() !== 'ffa') return;
    const k = parseKillTarget(v);
    if (k === null || k === roomKillTarget()) return;
    safeMeta({ killTarget: k });
    onMeta();
  }

  function safeMeta(fields) {
    if (!room || !room.isHost()) return;
    try { room.updateMeta(fields); } catch (e) { report(e, 'updateMeta'); }
  }

  function setTeam(team) {
    if (!room || phase !== 'room' || !TEAM_IDS.includes(team) || roomMode() === 'ffa') return;
    const n = room.players().filter((x) => x.team === team && x.id !== me).length;
    if (n >= teamCap()) { pushChat({ system: true, text: `${TEAM_NAME[team]} 팀이 가득 찼어요.` }); return; }
    autoTeam = null;   // 직접 고른 팀은 늦게 온 presence로 바꾸지 않는다
    room.updateMe({ team });
    renderRoom();
  }
  function setReady(ready) {
    if (!room || phase !== 'room') return;
    room.updateMe({ ready: !!ready });
    renderRoom();
  }
  function setMap(mapId) {
    if (!room || phase !== 'room' || !room.isHost() || !mapId || hm) return;
    const id = String(mapId);
    if (validMapFor(roomRuleset(), id, roomMode()) !== id) return;   // 이 규칙(모드)에서 못 고르는 맵
    safeMeta({ mapId: id });
    renderRoom();
  }
  function sendChat(text) {
    if (!room || !sync) return;
    const t = cleanText(text, 120);
    if (!t) return;
    if (!chatAllowed(chatSent, CHAT_LIMIT.send)) { pushChat({ system: true, text: CHAT_SLOW }); return; }
    sync.sendChat(t);
    // broadcast는 보낸 사람에게 되돌아오지 않는다 → 내 메시지는 직접 넣는다
    pushChat({ name: myName(), text: t, team: roomMode() === 'ffa' ? null : myRoomTeam(), me: true });
  }
  /** 경기 중 Enter·채팅 버튼(input:chat) → HUD 채팅 입력칸 */
  function onChatKey() {
    const c = current;
    if (disposed || phase !== 'match' || !c || !c.loaded || !room) return;
    call(ui.chat, 'open');
  }
  function onChatOpen() {
    // PC: 입력칸이 키를 가져가 엔진은 떼는 키를 못 본다 → 눌려 있던 이동 키를 미리 푼다. 휴대폰 조이스틱은 손가락이라 그대로 둔다
    const input = ctx && ctx.input;
    if (input && !input.touchMode && typeof input.releaseAll === 'function') input.releaseAll();
  }
  /** 다른 모듈에 알린다(o.bus나 ctx.bus). 휴대폰 채팅 버튼은 chat:available을 보고 나타난다 */
  function busEmit(evt, data) {
    const b = o.bus || (ctx && ctx.bus);
    if (b && typeof b.emit === 'function') { try { b.emit(evt, data); } catch (e) { report(e, evt); } }
  }

  async function leaveRoom() {
    if (!room) { if (phase !== 'lobby' && net) enterLobby(null); return; }
    const r = room;
    leaving = true;
    teardownMatch();
    detachRoom();     // sync.dispose(flush) → 남은 이벤트가 퇴장 프레임에 같이 나간다
    pendingAction = null;
    phase = 'leaving';
    U('show', 'lobby', { rooms: lobbyRooms, loading: true, error: null, joining: null, name: playerName });
    screen('lobby');
    try { await r.leave(); } catch (e) { report(e, 'room.leave'); }
    leaving = false;
    if (disposed || phase !== 'leaving') return;   // 그 사이 ← 메뉴(idle)·연결 끊김(lobby)·dispose
    enterLobby(null);
    // 나오는 동안(로비 화면이 먼저 뜬다) 누른 방 만들기·참가는 앞 방에서 다 나온 지금 한다
    const act = pendingAction;
    pendingAction = null;
    if (act) act();
  }

  function backToRoom() {
    if (phase !== 'results' || !room) return;
    phase = 'room';
    renderRoom(true);
    screen('room');
  }

  /* ---------------------------------------------------------------- 이름 · 팀 조회 */
  function viewPlayer(id) {
    const v = current && current.view;
    return v ? v.players.find((p) => p.id === id) || null : null;
  }
  function nameOf(id) {
    const vp = viewPlayer(id);
    if (vp && vp.name) return vp.name;
    if (room) { const p = room.players().find((x) => x.id === id); if (p && p.name) return p.name; }
    return known.get(id) || '플레이어';
  }
  function myName() { return (room && room.me && room.me.name) || playerName; }
  function myRoomTeam() {
    const p = room ? room.players().find((x) => x.id === me) : null;
    return p && TEAM_IDS.includes(p.team) ? p.team : null;
  }
  function roomTeamOf(id) {
    const p = room ? room.players().find((x) => x.id === id) : null;
    return p && TEAM_IDS.includes(p.team) ? p.team : null;
  }
  function pingOf(id) {
    const p = room ? room.players().find((x) => x.id === id) : null;
    return p ? p.ping : undefined;
  }

  /* ---------------------------------------------------------------- 방장: 시작 */
  function startProblem(list, mode) {
    const n = { owner: 0, charterer: 0 };
    let unassigned = 0, notReady = 0;
    for (const x of list) {
      if (TEAM_IDS.includes(x.team)) n[x.team]++; else unassigned++;
      if (x.id !== me && !x.ready) notReady++;
    }
    if (mode === 'ffa') {
      if (list.length < 2) return '2명 이상 있어야 시작할 수 있어요.';
      return notReady ? '아직 준비하지 않은 플레이어가 있어요.' : '';
    }
    if (!n.owner || !n.charterer) return '양 팀에 1명 이상 있어야 시작할 수 있어요.';
    if (unassigned) return '팀 배정을 기다리는 플레이어가 있어요.';
    if (notReady) return '아직 준비하지 않은 플레이어가 있어요.';
    return '';
  }

  /** 방장이 만드는 경기 규칙. 개인전 목표 킬은 방 메타(방장이 고른 값)에서 온다. 시험용 o.ffaRules가 있으면 그 값이 이긴다 */
  function matchRules(mode, ruleset) {
    const max = clampInt(room && room.meta.max, 2, 16, maxPlayers);
    const r = { ...(o.rules || {}), maxPlayers: max, maxPerTeam: Math.max(1, Math.ceil(max / 2)), ruleset };
    if (mode === 'ffa') Object.assign(r, { killTarget: roomKillTarget() }, o.ffaRules || {}, { mode: 'ffa' });
    else if (mode === 'bomb') Object.assign(r, o.bombRules || {}, { mode: 'bomb', ruleset: 'classic' });
    return r;
  }

  /**
   * (방장) 살아 있는 사람 발 위치 { id: { x, y, z } } — 나는 world, 원격은 sync 최신 상태.
   * FFA 스폰 고르기와 폭파 미션 판정(구역 안·해체 거리·폭탄 줍기·폭발 피해)이 쓴다
   */
  function positions() {
    const out = {};
    if (current && current.localAlive) {
      const lp = vec((call(world, 'getLocalState') || {}).pos);
      if (lp) out[me] = { x: lp[0], y: lp[1], z: lp[2] };
    }
    if (sync) {
      for (const id of sync.remoteIds()) {
        const r = sync.remote(id);
        const p = r && r.state && r.state.alive !== false ? vec(r.state.pos) : null;
        if (p) out[id] = { x: p[0], y: p[1], z: p[2] };
      }
    }
    return out;
  }
  /** (방장, 폭파 미션) fromY 아래 바닥 높이 — 떨어진 폭탄을 바닥에 놓는다. world에 맵이 없으면 undefined(match가 높이를 그대로 둔다) */
  const floorAt = (x, fromY, z) => W('floorAt', x, fromY, z);

  function hostStart() {
    if (!room || phase !== 'room' || !room.isHost() || hm) return;
    const mode = roomMode();
    const why = startProblem(room.players(), mode);
    if (why) { pushChat({ system: true, text: why }); return; }
    const ruleset = mode === 'bomb' ? 'classic' : roomRuleset();
    const mapId = validMapFor(ruleset, room.meta.mapId || o.mapId, mode);
    if (mode === 'bomb' && !bombMapOk(mapId)) { pushChat({ system: true, text: '이 맵에서는 폭파 미션을 할 수 없어요. 미션 맵을 골라 주세요.' }); return; }
    const mid = randomId(8);
    hm = {
      mid, mapId, mode, ruleset, m: null, preparing: true, prepDeadline: Infinity, acks: new Set([me]),
      members: new Set(), missing: new Map(), timer: null, lastTick: now(), lastSnapAt: -Infinity
    };
    // status 'playing'은 내 맵을 다 불러온 뒤(hostCreate)에 건다: net은 'playing'이면 방장 침묵 8초(대기 중 32초)로
    // 방장을 바꾸는데, 맵 빌드·셰이더 컴파일로 메인 스레드가 오래 막히면 멀쩡한 방장이 교체될 수 있다
    try { room.send(CONTROL_EVENT, { k: 'prep', mid, map: mapId, mode, rs: ruleset }); } catch (e) { report(e, 'prep'); }
    trace('host start', mid, mapId, mode, ruleset, mode === 'ffa' ? `${roomKillTarget()}킬` : '');
    enterMatch(mid, mapId, mode, ruleset);   // 방장도 같은 길로 맵을 불러온다 → 다 되면 hostCreate()
  }

  /** 맵(스폰)을 불러온 뒤 경기를 만들고 '준비' 스냅샷을 알린다 */
  function hostCreate() {
    const h = hm;
    if (!h || h.m || !current || current.mid !== h.mid || !room) return;
    const ffa = h.mode === 'ffa';
    const bomb = h.mode === 'bomb';
    const list = room.players().filter((x) => ffa || TEAM_IDS.includes(x.team));
    h.m = createMatch({
      rules: matchRules(h.mode, h.ruleset),
      players: list.map((x) => (ffa ? { id: x.id, name: x.name } : { id: x.id, name: x.name, team: x.team })),
      spawns: current.spawns || undefined,
      getPositions: ffa || bomb ? positions : undefined,
      mission: bomb ? current.mission || undefined : undefined,
      floorAt: bomb ? floorAt : undefined
    });
    h.members = new Set(list.map((x) => x.id));
    h.prepDeadline = now() + o.prepTimeoutMs;
    h.lastTick = now();
    h.timer = setInterval(hostLoop, o.hostTickMs);
    safeMeta({ status: 'playing' });
    publish([]);
  }

  function stopHost() {
    const h = hm;
    hm = null;
    if (!h) return;
    if (h.timer) clearInterval(h.timer);
    if (h.m) { try { h.m.dispose(); } catch (_) { /* noop */ } }
  }

  function hostLoop() {
    const h = hm;
    if (!h || !h.m || disposed || !room) return;
    if (!room.isHost()) { stopHost(); return; }
    const t = now();
    const dt = Math.min(10000, Math.max(0, t - h.lastTick));
    h.lastTick = t;
    hostRoster();
    if (hm !== h) return;
    if (h.preparing) {
      const waiting = [...h.members].filter((id) => !h.acks.has(id) && known.has(id));
      if (!waiting.length || t >= h.prepDeadline) {
        h.preparing = false;
        const ev = h.m.start();
        if (ev.length && ev[0].type === 'reject') { trace('start rejected', ev[0]); abortMatch('start-failed'); return; }
        h.lastTick = now();
        publish(ev);
      } else if (t - h.lastSnapAt >= o.snapshotMs) publish([]);
      return;
    }
    const ev = h.m.tick(dt);
    if (hm !== h) return;
    if (ev.length) publish(ev);
    else if (t - h.lastSnapAt >= o.snapshotMs) publish([]);
  }

  /** 방장: 방 명단 ↔ 경기 참가자(늦게 온 사람은 관전 → 다음 라운드, 나간 사람은 유예 뒤 퇴장) */
  function hostRoster() {
    const h = hm;
    if (!h || !h.m || !room) return;
    const t = now();
    const list = room.players();
    const ids = new Set(list.map((x) => x.id));
    const evs = [];
    const ffa = h.mode === 'ffa';
    for (const x of list) {
      if (h.members.has(x.id) || banned.has(x.id) || (!ffa && !TEAM_IDS.includes(x.team))) continue;
      // FFA: 늦게 온 사람도 바로 참가(match가 죽은 상태로 넣고 respawnMs 뒤 spawn)
      const ev = h.m.addPlayer(ffa ? { id: x.id, name: x.name } : { id: x.id, name: x.name, team: x.team });
      if (ev.length && ev[0].type === 'join') h.members.add(x.id);
      evs.push(...ev);
    }
    for (const id of [...h.members]) {
      if (id === me) continue;
      if (ids.has(id)) { h.missing.delete(id); continue; }
      const since = h.missing.get(id);
      if (since == null) { h.missing.set(id, t); if (!h.preparing) continue; }
      else if (t - since < o.leaveGraceMs) continue;
      h.missing.delete(id);
      h.members.delete(id);
      evs.push(...h.m.removePlayer(id));
    }
    const real = evs.filter((e) => e.type !== 'reject');
    if (real.length) publish(real);
  }

  /** 방장: 이벤트 + 최신 스냅샷을 보내고, 나도 같은 경로로 반영한다 */
  function publish(events) {
    const h = hm;
    if (!h || !h.m || !sync) return;
    const evs = [];
    for (const e of Array.isArray(events) ? events : []) {
      if (!e) continue;
      // 이벤트마다 경기 id: sync는 최근 3초 이벤트를 다음 스냅샷에도 다시 싣는다 → 바로 이어진 새 경기에
      // 지난 경기의 matchEnd가 섞여 갈 수 있으므로 받는 쪽이 mid로 거른다
      if (e.type === 'reject') trace('reject', e); else evs.push({ ...e, mid: h.mid });
      if (e.type === 'spawn' && e.id != null) moveGuard.reset(e.id);      // 부활 자리로 옮겨지는 것은 정상
      else if (e.type === 'roundStart') moveGuard.resetAll();
    }
    const snap = { ...h.m.snapshot(), mid: h.mid, map: h.mapId, gm: h.mode || 'team' };
    if (h.preparing) snap.prep = 1;
    try { sync.sendMatch(snap, evs); } catch (e) { report(e, 'sendMatch'); }
    h.lastSnapAt = now();
    onMatchData({ from: me, snapshot: snap, events: evs, local: true });
  }
  function publishReal(ev) {
    if (!Array.isArray(ev) || !ev.length) return;
    const real = ev.filter((e) => e && e.type !== 'reject');
    for (const e of ev) if (e && e.type === 'reject') trace('reject', e);
    if (real.length) publish(real);
  }

  function hostReady() { return !!(hm && hm.m && !hm.preparing); }

  /**
   * (방장) 히트 주장 → 위치로 다시 확인(거리·벽) → match.claimHit.
   * 쏜 사람이 적어 보낸 거리는 믿지 않고 방장이 잰 거리를 쓴다. 벽에 막혀 볼 수 없었으면 버린다. 내 주장은 확인하지 않는다.
   */
  function hostClaim(e) {
    if (!hostReady()) return;
    const from = String(e.from);
    if (banned.has(from)) return;
    let dist = e.dist;
    if (from !== me) {
      const v = verifyHit(e);
      if (!v.ok) { trace('claim', v.reason, from, e.victimId); strike(from, v.reason); return; }
      dist = v.dist;
    }
    const ev = hm.m.claimHit({
      attackerId: e.from, victimId: e.victimId, weaponId: e.weaponId, part: e.part, dist, kind: e.kind, t: e.shotT,
      count: e.count, shotId: e.shotId
    });
    const rej = ev.find((x) => x && x.type === 'reject');
    if (rej && from !== me && (rej.reason === 'too_fast' || rej.reason === 'out_of_range')) strike(from, rej.reason);
    publishReal(ev);
  }

  /** (방장) 히트 주장의 위치 확인: 쏜 사람·맞은 사람이 그 시각 있었을 자리 후보를 모아 anticheat.checkHitClaim에 넘긴다 */
  function verifyHit(e) {
    const shotT = isNum(e.shotT) ? e.shotT : now();
    const def = getDef(e.weaponId);
    const vid = String(e.victimId);
    const shooter = GUARD.SHOOTER_LAG_MS.map((lag) => remoteAt(e.from, shotT - lag)).filter(Boolean);
    const victim = GUARD.VICTIM_LAG_MS.map((lag) => (vid === me ? selfAt(shotT - lag) : remoteAt(vid, shotT - lag))).filter(Boolean);
    const m = call(world, 'getMap');
    const los = m && m.world ? (a, b) => lineOfSight(m.world, a, b) : null;
    return checkHitClaim({ dist: e.dist, melee: !!(def && def.slot === 3), shooter, victim, los });
  }
  /** 방장 시계 t에 그 사람이 있던 자리(그 사람이 보낸 위치 기록에서) */
  function remoteAt(id, t) {
    const s = sync && typeof sync.getRemoteAtHost === 'function' ? sync.getRemoteAtHost(String(id), t) : null;
    return s && Array.isArray(s.pos) ? { pos: s.pos, crouch: !!s.crouch } : null;
  }
  /** 방장 시계 t에 내가 있던 자리 */
  function selfAt(t) {
    let best = null;
    for (const s of selfTrail) if (!best || Math.abs(s.t - t) < Math.abs(best.t - t)) best = s;
    return best && Math.abs(best.t - t) < 400 ? best : null;
  }
  /** (방장) 위반 점수를 더하고, 한도를 넘으면 내보낸다 */
  function strike(id, reason) {
    const pid = String(id);
    if (!hm || pid === me || banned.has(pid)) return;
    if (strikes.add(pid, reason)) banPlayer(pid, reason);
  }
  /** (방장) 경기에서 빼고 방에서 내보낸다. 고친 클라이언트는 강퇴를 무시할 수 있으므로 그 사람의 주장·장비·채팅도 계속 버린다 */
  function banPlayer(pid, reason) {
    banned.add(pid);
    strikes.clear(pid);
    moveGuard.reset(pid);
    trace('ban', pid, reason);
    const text = `${nameOf(pid)}님을 내보냈어요 · 비정상 플레이가 반복됐어요`;
    if (hm && hm.m) {
      hm.members.delete(pid);
      hm.missing.delete(pid);
      try { publishReal(hm.m.removePlayer(pid)); } catch (err) { report(err, 'ban removePlayer'); }
    }
    try { if (room && typeof room.kick === 'function') room.kick(pid, 'cheat'); } catch (err) { report(err, 'kick'); }
    pushChat({ system: true, text });
    try { if (sync) sync.sendChat(`[방장 알림] ${text}`); } catch (err) { report(err, 'ban chat'); }
  }

  /** (방장) world가 계산한 폭발 피해(로컬·원격 수류탄 모두, 방장 화면 기준) → match.claimExplosion */
  function hostExplosion(x) {
    if (!hostReady() || !x) return;
    const owner = x.ownerId != null ? String(x.ownerId) : null;
    if (!owner) return;
    const victims = [];
    for (const v of Array.isArray(x.victims) ? x.victims : []) {
      if (v && v.id != null && Number(v.dmg) > 0) victims.push({ id: String(v.id), dmg: Number(v.dmg) });
    }
    const c = vec(x.center || x.pos);
    publishReal(hm.m.claimExplosion({ attackerId: owner, center: c ? { x: c[0], y: c[1], z: c[2] } : undefined, victims }));
  }

  /**
   * 새 방장: 내가 아는 선택을 경기에 다시 넣는다. 멤버가 같은 라운드를 다시 하며 같은 무기를 보내도
   * sync는 같은 내용으로 보고 거르므로, 옛 방장의 스냅샷보다 늦은 선택이 여기서만 이어진다.
   */
  function seedPicks(m, c) {
    const out = m.setLoadout(me, c.pick);
    for (const [id, g] of remoteGear) if (isPickable(c.ruleset, g.pick)) out.push(...m.setLoadout(id, g.pick));
    return out;
  }

  /** 방장이 나가 내가 이어받음 → 최신 스냅샷으로 복원, 실패하면 경기 종료 */
  function takeOver() {
    const c = current;
    if (!c || !room || !room.isHost() || hm) return;
    const last = sync ? sync.lastMatch() : null;
    const snap = last && last.snapshot && last.snapshot.mid === c.mid ? last.snapshot : null;
    const view = snap ? applySnapshot(snap) : null;
    if (!view || snap.prep || snap.abort || view.phase === 'warmup') { abortMatch('host-left', snap); return; }
    if (view.phase === 'matchEnd') { showResults(view); return; }
    if (c.mode === 'ffa') { takeOverFfa(c, snap, view); return; }
    try {
      const teamOf = new Map(view.players.map((p) => [p.id, p.team]));
      const players = [];
      for (const x of room.players()) {
        const team = teamOf.get(x.id) || (TEAM_IDS.includes(x.team) ? x.team : null);
        if (team) players.push({ id: x.id, name: x.name, team });
      }
      const bomb = c.mode === 'bomb';
      const m = restoreMatch({
        snapshot: snap, players, spawns: c.spawns || undefined,
        ...(bomb ? { mission: c.mission || undefined, getPositions: positions, floorAt } : {})
      });
      hm = {
        mid: c.mid, mapId: c.mapId, mode: bomb ? 'bomb' : 'team', ruleset: c.ruleset, m, preparing: false, prepDeadline: 0, acks: new Set(),
        members: new Set(players.map((p) => p.id)), missing: new Map(), timer: null, lastTick: now(), lastSnapAt: -Infinity
      };
      hm.timer = setInterval(hostLoop, o.hostTickMs);
      safeMeta({ status: 'playing' });
      trace('takeover', c.mid, 'round', view.round, view.phase, view.score);
      const ev = m.start();
      publish(ev.concat(seedPicks(m, c)));
      H('center', '방장을 이어받았어요 👑', 2500, { sub: '점수를 이어 라운드를 다시 시작해요', tone: 'warn' });
    } catch (err) {
      report(err, 'takeOver');
      stopHost();
      abortMatch('host-left', snap);
    }
  }

  /** FFA 이어받기: 킬·데스·남은 시간을 이어 모두 부활 대기에서 다시 시작 */
  function takeOverFfa(c, snap, view) {
    try {
      const players = room.players().map((x) => ({ id: x.id, name: x.name }));
      // 나만 남았으면 match.js는 시작을 거절한다(need_players) → 나간 사람을 잠깐 넣었다가 빼서 match가 forfeit으로 끝내게 한다
      let ghost = null;
      if (players.length < 2) {
        const g = view.players.find((p) => p.id !== me && !players.some((x) => x.id === p.id));
        if (g) { ghost = g.id; players.push({ id: g.id, name: g.name }); }
      }
      const m = restoreFfaMatch({ snapshot: snap, players, spawns: c.spawns || undefined, getPositions: positions });
      hm = {
        mid: c.mid, mapId: c.mapId, mode: 'ffa', ruleset: c.ruleset, m, preparing: false, prepDeadline: 0, acks: new Set(),
        members: new Set(players.map((p) => p.id)), missing: new Map(), timer: null, lastTick: now(), lastSnapAt: -Infinity, restored: true
      };
      hm.timer = setInterval(hostLoop, o.hostTickMs);
      safeMeta({ status: 'playing' });
      trace('takeover ffa', c.mid, view.phase, view.timeLeftMs, ghost ? 'alone' : '');
      let ev = m.start();
      if (ev.length && ev[0].type === 'reject') { trace('ffa restart rejected', ev[0]); stopHost(); abortMatch('alone', snap); return; }
      ev = ev.concat(seedPicks(m, c));
      if (ghost) ev = ev.concat(m.removePlayer(ghost));
      publish(ev);
      if (hm && !ghost) H('center', '방장을 이어받았어요 👑', 2500, { sub: '킬 기록을 이어 모두 다시 출격해요', tone: 'warn' });
    } catch (err) {
      report(err, 'takeOverFfa');
      stopHost();
      abortMatch('host-left', snap);
    }
  }

  /** 내가 새 방장인데 경기 밖에 있다 → 남은 경기 스냅샷이 진행 중이면 모두 방으로 */
  function abortStale() {
    const last = sync ? sync.lastMatch() : null;
    const snap = last && last.snapshot;
    if (snap && typeof snap.mid === 'string' && isJoinable(snap)) {
      try { sync.sendMatch({ ...snap, abort: 'host-left' }, []); } catch (e) { report(e, 'abortStale'); }
    }
  }

  /** (방장) 경기 취소 → 모두 방으로 */
  function abortMatch(reason, baseSnap) {
    const h = hm;
    trace('abort', reason, h && h.mid);
    const mid = (h && h.mid) || (current && current.mid) || (baseSnap && baseSnap.mid);
    if (sync && mid && room && room.isHost()) {
      let snap = null;
      try { snap = h && h.m ? h.m.snapshot() : baseSnap ? { ...baseSnap } : null; } catch (_) { snap = null; }
      if (!snap) snap = { v: 1, ph: 'warmup', rn: 0, tl: null, sc: [0, 0], ru: RULE_KEYS.map((k) => DEFAULT_RULES[k]), h: [], fin: 0, res: null, p: [] };
      try { sync.sendMatch({ ...snap, mid, map: (h && h.mapId) || (current && current.mapId) || '', abort: reason }, []); } catch (e) { report(e, 'abort'); }
    }
    stopHost();
    safeMeta({ status: 'waiting' });
    matchToRoom(ABORT_TEXT[reason] || ABORT_TEXT['host-left']);
  }

  function onControl(p, msg) {
    if (!p || typeof p !== 'object' || !msg || !room) return;
    if (p.k === 'loaded') { if (hm && p.mid === hm.mid) hm.acks.add(String(msg.from)); return; }
    if (p.k === 'prep' && msg.from === room.hostId() && typeof p.mid === 'string' && p.mid.length <= 16) {
      if (phase === 'room' && p.mid !== finishedMid) enterMatch(p.mid, cleanText(p.map, 32) || room.meta.mapId || o.mapId, p.mode, p.rs);
    }
  }

  /* ---------------------------------------------------------------- 경기: 들어가기 · 나오기 */
  function enterMatch(mid, mapId, mode, ruleset) {
    if (current && current.mid === mid) return current;
    if (current) teardownMatch();
    phase = 'match';
    const rs = normalizeRuleset(ruleset != null ? ruleset : roomRuleset());
    const c = current = {
      mid, mapId, mode: modeOf(mode || roomMode()), ruleset: rs, loaded: false, spawns: null, mission: null, mapName: '',
      pending: null, pendingTakeover: false, ackAt: -Infinity,
      round: 0, roundFrom: null, phase: null, view: null,
      playing: false, localAlive: false, localHp: 0, team: myRoomTeam(), spawnFallback: false,
      pick: pickFor(rs), pickSent: '', gearJson: '', gearQueued: false, liveLoadout: null, resultsShown: false, lastDataAt: now(), enteredAt: now(),
      killerName: null, compact: false, protect: null, aliveMismatchAt: 0,
      startedAt: null, knifeKills: 0   // 처음 출격한 시각(null이면 아직 출격 전), 내 칼 킬 수
    };
    trace('enter match', mid, mapId, c.mode, c.ruleset, room && room.isHost() ? 'host' : 'member');
    actors.clear();
    call(ui.chat, 'clear');   // 지난 경기의 줄을 지운다. 맵을 불러오는 동안 온 줄은 남는다
    fireQ.length = 0;
    if (room) { const mine = room.players().find((x) => x.id === me); if (mine && mine.ready) room.updateMe({ ready: false }); }
    U('hide', 'loadout');
    W('setPauseOptions', { leaveLabel: '방 나가기', note: '멀티플레이 중에는 게임이 멈추지 않아요. 나가면 이번 경기에서 빠져요.' });
    W('setScoreboard', scoreboardData);
    screen('match', { mapId, mode: c.mode });
    startFrames();
    Promise.resolve()
      .then(() => world.loadMap(mapId, { mode: c.mode, ruleset: c.ruleset }))
      .then((res) => onMapLoaded(c, res), (err) => onMapFailed(c, err));
    return c;
  }

  function onMapLoaded(c, res) {
    if (disposed || current !== c) return;
    c.loaded = true;
    c.spawns = res && res.spawns ? res.spawns : null;
    c.mission = res && res.mission ? res.mission : null;   // 폭파 미션 구역·진영 스폰(world.loadMap이 바닥 높이를 채운다)
    c.mapName = (res && res.mapName) || '';
    W('setMode', c.mode);   // FFA면 모든 액터가 적, 폭파 미션이면 폭탄 화면(loadMap이 'team'으로 되돌리므로 로드 뒤에)
    W('setControlsEnabled', true);
    // 경기 채팅: HUD와 함께 보이고(loadMap이 HUD를 띄운 뒤), 휴대폰 채팅 버튼을 켠다. 줄은 enterMatch에서 비웠다
    U('show', 'chat', {});
    busEmit('chat:available', { on: true });
    if (!c.round) W('setHint', '다른 플레이어를 기다리는 중…');
    if (hm && hm.mid === c.mid && !hm.m) hostCreate();
    else if (room && !room.isHost()) sendAck(c);
    const q = c.pending;
    c.pending = null;
    if (q) processMatchData(q);
    if (current === c && c.pendingTakeover) { c.pendingTakeover = false; if (room && room.isHost()) takeOver(); }
  }

  function onMapFailed(c, err) {
    if (disposed || current !== c) return;
    report(err, 'world.loadMap');
    if (hm && hm.mid === c.mid) { abortMatch('map-failed'); return; }
    finishedMid = c.mid;
    matchToRoom('맵을 불러오지 못해 이번 경기에서 빠졌어요.');
  }

  function sendAck(c) {
    if (!room || room.isHost()) return;
    try { room.sendTo(room.hostId(), CONTROL_EVENT, { k: 'loaded', mid: c.mid }); } catch (e) { report(e, 'ack'); }
    c.ackAt = now();
  }

  /** 경기 화면 정리(world 맵 해제·액터 제거). current = null */
  function teardownMatch() {
    stopFrames();
    stopHost();
    const c = current;
    current = null;
    fireQ.length = 0;
    if (c) {
      for (const id of actors.keys()) W('removeActor', id);
      actors.clear();
      W('setHint', '');
      W('setScoreboard', null);
      if (c.mode === 'ffa') { W('setRespawn', null); W('setProtect', false); }
      if (c.mode === 'bomb') W('setBomb', null);
      W('setControlsEnabled', false);
      if (typeof world.unloadMap === 'function') W('unloadMap'); else W('reset');
      U('hide', 'loadout');
      U('hide', 'pause');
      U('hide', 'scoreboard');
      U('hide', 'chat');
      busEmit('chat:available', { on: false });
      call(ui.killfeed, 'clear');
    }
  }

  /** 경기 → 방(취소·실패). 결과 화면 없이 */
  function matchToRoom(text) {
    const c = current;
    trace('match → room', c && c.mid, text);
    if (c) finishedMid = c.mid;
    teardownMatch();
    if (!room) return;
    phase = 'room';
    if (text) pushChat({ system: true, text }, false);
    renderRoom(true);
    screen('room');
  }

  /* ---------------------------------------------------------------- 경기: 데이터 수신 */
  function onMatchData(d) {
    if (disposed || !room || !d) return;
    const snap = d.snapshot && typeof d.snapshot === 'object' ? d.snapshot : null;
    const mid = snap && typeof snap.mid === 'string' ? snap.mid : null;
    if (snap && !mid) return;                       // 세션 형식이 아닌 스냅샷
    if (phase === 'room') {
      if (!snap || mid === finishedMid || !isJoinable(snap)) return;
      enterMatch(mid, cleanText(snap.map, 32) || room.meta.mapId || o.mapId, snap.gm, snap.rs);   // 새 경기 시작 또는 늦게 들어옴
    }
    if (phase !== 'match' || !current) return;
    if (mid && mid !== current.mid) {
      if (!isJoinable(snap) || mid === finishedMid) return;
      teardownMatch();
      enterMatch(mid, cleanText(snap.map, 32) || room.meta.mapId || o.mapId, snap.gm, snap.rs);
    }
    const c = current;
    c.lastDataAt = now();
    if (!c.loaded) {
      // 맵을 불러오는 동안: 이벤트는 모두, 스냅샷은 최신 하나만 모은다
      const q = c.pending || (c.pending = { from: d.from, snapshot: null, events: [] });
      if (snap) { q.snapshot = snap; q.from = d.from; }
      for (const e of Array.isArray(d.events) ? d.events : []) if (ownEvent(e, c) && q.events.length < 256) q.events.push(e);
      return;
    }
    processMatchData(d);
  }

  /** 이 경기의 이벤트인가(mid가 없으면 옛 형식 → 받는다) */
  const ownEvent = (e, c) => !!e && typeof e === 'object' && (e.mid == null || e.mid === c.mid);

  function processMatchData(d) {
    const c = current;
    if (!c) return;
    const snap = d.snapshot || null;
    if (snap && snap.abort) {
      if (!hm) matchToRoom(ABORT_TEXT[snap.abort] || ABORT_TEXT['host-left']);
      return;
    }
    const view = snap ? applySnapshot(snap) : null;
    if (view && view.ruleset !== c.ruleset) {
      // 규칙은 방장 스냅샷이 정본이다(방 메타가 늦게 온 채로 들어온 경우)
      c.ruleset = view.ruleset;
      c.pick = pickFor(c.ruleset);
      W('setRuleset', c.ruleset);
    }
    const from = d.from || (room && room.hostId()) || null;
    for (const e of Array.isArray(d.events) ? d.events : []) {
      if (current !== c) return;
      if (!ownEvent(e, c)) { trace('drop other-match event', e && e.type, e && e.mid); continue; }
      try { onMatchEvent(e, view || c.view, from); } catch (err) { report(err, 'match event ' + (e && e.type)); }
    }
    if (current !== c || !view) return;
    try { applyView(view, from); } catch (err) { report(err, 'applyView'); }
    if (current === c && snap.prep && room && !room.isHost() && now() - c.ackAt > 1000) sendAck(c);
  }

  function onMatchEvent(e, view, from) {
    if (!e || typeof e !== 'object') return;
    switch (e.type) {
      case 'roundStart': startRound(e.round | 0, e.spawns && typeof e.spawns === 'object' ? e.spawns : null, view, from, e); break;
      case 'phase': enterPhase(e.phase, e.round | 0, e, view, from); break;
      case 'spawn': onSpawn(e, view); break;
      case 'damage': onDamage(e); break;
      case 'kill': onKill(e); break;
      case 'roundEnd': onRoundEnd(e); break;
      case 'matchEnd': if (current) current.matchEnd = e; break;
      case 'loadout': if (e.id !== me) noteGear(String(e.id), e.weaponId); break;
      case 'bomb':   // 폭파 미션: 소리·안내·폭발 연출. 상태(HUD·모형)는 같은 메시지의 스냅샷이 applyView에서 맞춘다
        if (current && current.mode === 'bomb') W('bombEvent', { ...e, name: e.id != null ? nameOf(String(e.id)) : '' });
        break;
      case 'join':
        if (e.id === me) break;
        if (current && current.mode === 'ffa') H('center', `${e.name || '플레이어'}님 합류`, 1500, { sub: '곧 출격해요' });
        else if (e.playing === false) H('center', `${e.name || '플레이어'}님 합류`, 1500, { sub: '다음 라운드부터 참가해요' });
        break;
      default: break;
    }
  }

  /** 라운드 시작(스폰). 같은 번호라도 새 방장이 다시 시작한 라운드면 받는다 */
  function startRound(round, spawns, view, from, ev) {
    const c = current;
    if (!c || !(round > 0)) return;
    if (round < c.round) return;
    if (round === c.round) {
      const restart = !!spawns && !!from && from !== c.roundFrom;
      if (!restart) {
        if (c.spawnFallback && spawns) {
          // 스냅샷으로 먼저 대체 스폰했는데 진짜 스폰이 늦게 왔다 → 로드아웃 중이면 제자리로
          c.spawnFallback = false;
          if (c.playing && spawns[me] && (!c.phase || c.phase === 'loadout')) spawnMe(spawns[me]);
          placeActors(view || c.view, spawns);
        }
        return;
      }
    }
    c.round = round;
    c.roundFrom = from || c.roundFrom;
    c.phase = null;
    c.liveLoadout = null;
    c.spawnFallback = !spawns;
    const v = view || c.view;
    const vp = v ? v.players.find((p) => p.id === me) : null;
    if (vp && vp.team) c.team = vp.team;
    c.playing = spawns ? !!spawns[me] : !!(vp && vp.connected && vp.playing);
    W('reset');
    call(ui.killfeed, 'clear');
    if (c.playing) spawnMe((spawns && spawns[me]) || fallbackSpawn(c, v));
    else { c.localAlive = false; W('setHint', '관전 중 — 다음 라운드부터 참가해요'); }
    placeActors(v, spawns);
    const score = (ev && ev.score) || (v && v.score) || { owner: 0, charterer: 0 };
    const mp = matchPointTeams(score, v && v.rules);
    if (c.mode === 'bomb') {
      // 폭파 미션: 내 진영과 목표. swapAfter 라운드가 끝난 다음 라운드에 공수 교대를 알린다
      const atk = (ev && ev.attack) || (v && v.attack) || null;
      const swap = round === ((v && v.rules && v.rules.swapAfter) || 2) + 1;
      const side = c.team ? (c.team === atk ? '공격 · A 또는 B 구역에 폭탄을 설치하세요' : '수비 · A·B 구역을 지키세요') : '관전 중';
      const sub = `${side}${mp.length ? ` · 매치 포인트 ${mp.map((t) => TEAM_NAME[t]).join(' · ')}` : ''}`;
      H('center', swap ? `라운드 ${round} · 공수 교대` : `라운드 ${round}`, 2800, { sub, tone: swap ? 'warn' : mp.length === 1 ? mp[0] : undefined });
      if (v) W('setBomb', bombInfo(v));
      W('sound', 'round_start');
      return;
    }
    const sub = ev && ev.replay ? '무승부 — 같은 라운드를 다시 해요'
      : mp.length ? `매치 포인트 · ${mp.map((t) => TEAM_NAME[t]).join(' · ')}` : '무기를 고르세요';
    H('center', `라운드 ${round}`, 2600, { sub, tone: mp.length === 1 ? mp[0] : undefined });
    W('sound', 'round_start');
  }

  function spawnMe(sp) {
    const c = current;
    W('spawnLocal', { id: me, name: myName(), team: c.team, spawn: { ...sp }, loadout: c.pick });
    c.localAlive = true;
    c.localHp = (c.view && c.view.rules && c.view.rules.hp) || DEFAULT_RULES.hp;
    W('setHint', '');
    noteSpawned(c);
  }

  /** 처음 출격: 경기 시간을 재기 시작한다. 내 장비를 다른 사람에게 알린다(스폰마다, 같은 내용이면 보내지 않는다) */
  function noteSpawned(c) {
    if (c.startedAt == null) c.startedAt = now();
    announceGear(c);
  }

  /** 내 장비를 모두에게 알린다. 경기 이벤트를 처리하는 중에도 부를 수 있게 지금 호출이 끝난 뒤에 보낸다 */
  function announceGear(c) {
    if (c.gearQueued) return;
    c.gearQueued = true;
    queueMicrotask(() => {
      c.gearQueued = false;
      if (!disposed && current === c) sendGear(c);
    });
  }

  /**
   * g2l { pick, primary, secondary, melee, round, m }.
   * round·m은 다음 라운드·다음 경기에 같은 선택도 다시 전달되게 한다(sync가 같은 내용이면 거르므로).
   * 방장은 자기 선택을 경기에 바로 넣는다. 고를 수 없는 페이즈면 match가 거절하고 끝이다.
   */
  function sendGear(c) {
    if (!c.playing) return;
    const msg = { ...gearMessage(c.ruleset, c.pick, equippedGear()), round: c.round, m: c.mid };
    const json = JSON.stringify(msg);
    if (sync && json !== c.gearJson) { c.gearJson = json; sync.sendLoadout(msg); }
    if (hostReady()) publishReal(hm.m.setLoadout(me, c.pick));
  }

  /** 다른 사람이 쓰는 무기를 슬롯별로 기억한다(방장 확정 선택, 사격 메시지) */
  function noteGear(id, weaponId) {
    const def = getDef(weaponId);
    const key = def ? SLOT_KEY[def.slot] : null;
    if (!key) return;
    const gear = remoteGear.get(id);
    if (!gear || gear[key] !== def.id) remoteGear.set(id, { ...gear, [key]: def.id });
  }

  function fallbackSpawn(c, v) {
    const pool = c.spawns && Array.isArray(c.spawns[c.team]) ? c.spawns[c.team] : [];
    if (!pool.length) return { x: 0, z: 0, rotY: 0 };
    const mates = v ? v.players.filter((p) => p.team === c.team && p.playing) : [];
    const i = Math.max(0, mates.findIndex((p) => p.id === me));
    return { ...pool[i % pool.length] };
  }

  /** 원격 아바타 명단 맞추기(이번 라운드 참가자 + 방에 있는 사람). spawns가 있으면 그 자리에 세운다 */
  function placeActors(view, spawns) {
    if (!view) return;
    const present = new Set(room ? room.players().map((x) => x.id) : []);
    const want = new Map();
    for (const p of view.players) {
      if (p.id === me || !p.connected || !p.playing || !p.team || !present.has(p.id)) continue;
      want.set(p.id, p);
    }
    for (const id of [...actors.keys()]) if (!want.has(id)) { W('removeActor', id); actors.delete(id); }
    const t = now();
    for (const [id, p] of want) {
      let a = actors.get(id);
      if (a && a.team !== p.team) { W('removeActor', id); actors.delete(id); a = null; }
      if (!a) {
        a = { id, name: p.name, team: p.team, dead: false, spawn: null };
        actors.set(id, a);
        W('addActor', { id, name: p.name, team: p.team, kind: 'remote', avatar: avatarOf(id) });
      }
      if (spawns) {
        a.dead = false;
        const sp = spawns[id];
        a.spawn = sp ? { pos: [+sp.x || 0, +sp.y || 0, +sp.z || 0], yaw: +sp.rotY || 0, at: t, first: true } : null;
      } else if (!p.alive && !a.dead && ACTIVE.has(view.phase)) {
        a.dead = true;   // 킬 이벤트를 놓쳤다
        W('actorDeath', id, {});
      }
    }
  }

  function enterPhase(ph, round, ev, view, from) {
    const c = current;
    if (!c || !Object.prototype.hasOwnProperty.call(PHASE_ORDER, ph)) return;
    if (c.mode === 'ffa') { ffaPhase(ph, ev, view, from); return; }
    if (ph === 'matchEnd') { showResults(view || c.view, ev); return; }
    if (ph === 'warmup' || round < c.round) return;
    if (round > c.round) startRound(round, null, view || c.view, from, null);   // roundStart를 놓침
    if (c.phase && PHASE_ORDER[ph] <= PHASE_ORDER[c.phase]) return;
    c.phase = ph;
    const v = view || c.view;
    if (ph === 'loadout') onLoadoutPhase(round, ev, v);
    else if (ph === 'live') onLivePhase(ev, v);
    else if (ph === 'roundEnd') U('hide', 'loadout');
    if (v) W('setRound', roundInfo(v));
  }

  function onLoadoutPhase(round, ev, v) {
    const c = current;
    if (!c.playing) return;
    announceGear(c);   // 화면에서 고르기 전에도 계정 장비가 방장에게 간다(자동 선택이 늦어도 기본 무기로 굳지 않게)
    // 남은 시간: 같은 메시지의 스냅샷이 loadout이면 그 값(늦게 합류해도 맞게)
    let ms = ev && isNum(ev.durationMs) ? ev.durationMs : DEFAULT_RULES.loadoutMs;
    if (v && v.phase === 'loadout' && v.round === round && isNum(v.timeLeftMs)) ms = v.timeLeftMs;
    else if (v && v.round === round && PHASE_ORDER[v.phase] > PHASE_ORDER.loadout) return;   // 이미 지나감
    const secs = (ms - o.loadoutLeadMs) / 1000;
    if (secs < 0.8) return;
    c.pickSent = '';
    c.compact = false;
    U('show', 'loadout', {
      weapons: pickableWeapons(c.ruleset, ownedIds()), ruleset: c.ruleset, seconds: Math.round(secs * 10) / 10, selected: c.pick, round,
      ...(c.mode === 'ffa' ? { title: '개인전 · 무기 선택' } : {})
    });
  }

  function onLivePhase(ev, v) {
    const c = current;
    U('hide', 'loadout');
    const lo = ev && ev.loadouts && typeof ev.loadouts === 'object' ? ev.loadouts : null;
    if (lo) {
      for (const [id, w] of Object.entries(lo)) if (id !== me && isPickable(c.ruleset, w)) noteGear(id, w);
      const mine = lo[me];
      if (c.playing && isPickable(c.ruleset, mine)) {
        c.liveLoadout = mine;
        if (mine !== c.pick) { c.pick = mine; lastPicks.set(c.ruleset, mine); }
        W('setLocalLoadout', mine);   // 방장이 확정한 무기(칼전이면 칼)
      }
    }
    if (c.playing && c.localAlive) {
      const atk = v && v.attack;
      const sub = c.mode !== 'bomb' ? '상대 팀을 모두 제압하세요'
        : c.team === atk ? '공격 · 폭탄을 A 또는 B 구역에 설치하세요' : '수비 · 구역을 지키고 설치되면 해체하세요';
      H('center', '작전 개시!', 1400, { sub });
    }
  }

  function onRoundEnd(e) {
    const c = current;
    if (!c) return;
    const sc = e.score || { owner: 0, charterer: 0 };
    const line = `블루 ${sc.owner | 0} : ${sc.charterer | 0} 레드`;
    if (e.winner === 'owner' || e.winner === 'charterer') {
      const mine = c.team && c.team === e.winner;
      // 폭파 미션: 사유(폭탄 폭파·해체·전멸·시간 종료)와 이긴 진영
      const why = c.mode === 'bomb'
        ? `${BOMB_REASON_LABELS[e.reason] || e.reason || ''} · ${e.winner === e.attack ? '공격' : '수비'} 승`
        : (REASON_LABELS[e.reason] || '');
      H('center', `${TEAM_NAME[e.winner]} 팀 승리${c.team ? (mine ? ' 🏆' : '') : ''}`, 3600, {
        sub: `${why} · ${line}${e.final ? ' · 매치 종료' : ''}`, tone: e.winner
      });
      if (c.team) W('sound', mine ? 'round_win' : 'round_lose');
    } else {
      H('center', '무승부', 3600, { sub: `같은 라운드를 다시 해요 · ${line}`, tone: 'warn' });
    }
  }

  function attackerPos(id) {
    if (id == null || id === me) return null;
    const s = sync ? sync.getRemote(String(id), now()) : null;
    if (s && s.pos) return s.pos.slice();
    const r = sync ? sync.remote(String(id)) : null;
    return r && r.state && r.state.pos ? r.state.pos.slice() : null;
  }

  function onDamage(e) {
    const c = current;
    if (!c) return;
    const victim = String(e.victim), attacker = String(e.attacker);
    const hp = Number(e.hp) | 0;
    if (victim === me) {
      c.localHp = hp;
      W('setLocalHp', hp);
      const center = vec(e.center);
      const from = center || attackerPos(attacker);
      if (!e.self || center) W('feedbackDamage', { attackerPos: from, amount: e.amount, head: !!e.head, half: !!e.halfShot, kill: hp <= 0, incoming: true });
    } else if (attacker === me) {
      W('feedbackDamage', { amount: e.amount, head: !!e.head, half: !!e.halfShot, kill: hp <= 0, incoming: false });
    }
  }

  function onKill(e) {
    const c = current;
    if (!c) return;
    const victim = String(e.victim), killer = String(e.killer);
    const self = killer === victim;
    const ffa = c.mode === 'ffa';
    if (killer === me && !self) {
      const def = getDef(e.weaponId);
      if (def && def.kind === 'melee') c.knifeKills += 1;
    }
    call(ui.killfeed, 'push', {
      killer: self ? null : (e.killerName || nameOf(killer)), victim: e.victimName || nameOf(victim),
      weaponId: e.weaponId, head: !!e.head, half: !!e.halfShot,
      killerTeam: ffa ? null : e.killerTeam, victimTeam: ffa ? null : e.victimTeam, ...(ffa ? { mode: 'ffa' } : {})
    });
    // 연속 킬(더블 킬~): 내가 살아서 낸 킬만 World가 센다. 내가 죽는 킬은 아래 killLocal이 처음부터 세게 한다
    W('noteKill', { killer, victim, killerTeam: e.killerTeam, victimTeam: e.victimTeam });
    const kp = attackerPos(killer);
    if (victim === me) {
      if (c.localAlive) {
        c.localAlive = false;
        const lp = vec((call(world, 'getLocalState') || {}).pos);
        const dir = kp && lp ? [lp[0] - kp[0], lp[2] - kp[2]] : undefined;
        W('killLocal', { killerId: self ? null : killer, killerName: e.killerName, weaponId: e.weaponId, head: !!e.head, dir });
      }
      if (ffa) ffaDied(self ? null : (e.killerName || nameOf(killer)), e.weaponId);
    } else {
      const a = actors.get(victim);
      if (a && !a.dead) {
        a.dead = true;
        const vp = attackerPos(victim);
        const dir = kp && vp ? [vp[0] - kp[0], vp[2] - kp[2]] : undefined;
        W('actorDeath', victim, { killerId: killer, weaponId: e.weaponId, head: !!e.head, dir });
      }
    }
  }

  /** 스냅샷 = 권위 상태. 놓친 전환을 보정하고 HUD 라운드 정보를 갱신한다 */
  function applyView(view, from) {
    const c = current;
    if (c.mode === 'ffa') { applyFfaView(view, from); return; }
    c.view = view;
    if (view.phase === 'matchEnd') { showResults(view, c.matchEnd); return; }
    if (ACTIVE.has(view.phase) && view.round > 0) {
      if (view.round > c.round) startRound(view.round, null, view, from, null);
      else if (view.round === c.round && from && c.roundFrom && from !== c.roundFrom && c.phase &&
        PHASE_ORDER[view.phase] < PHASE_ORDER[c.phase]) {
        c.roundFrom = null;   // 새 방장이 같은 라운드를 다시 시작했는데 roundStart를 놓쳤다
        startRound(view.round, null, view, from, null);
      }
      if (current !== c) return;
      enterPhase(view.phase, view.round, null, view, from);
      if (current !== c) return;
    }
    const vp = view.players.find((p) => p.id === me);
    if (vp) {
      if (vp.team) c.team = vp.team;
      if (c.playing && vp.playing && ACTIVE.has(view.phase)) {
        if (!vp.alive && c.localAlive) { c.localAlive = false; W('killLocal', {}); }
        else if (vp.alive && c.localAlive && vp.hp !== c.localHp) { c.localHp = vp.hp; W('setLocalHp', vp.hp); }
      }
    }
    placeActors(view, null);
    W('setRound', roundInfo(view));
    if (c.mode === 'bomb') W('setBomb', bombInfo(view));
  }

  /** world.setBomb에 넘길 폭파 미션 상태(match 뷰의 bomb + 공격 팀·페이즈·설치/해체 시간·이름) */
  function bombInfo(v) {
    const b = (v && v.bomb) || {};
    return {
      ...b, attack: v.attack || null, phase: v.phase,
      plantMs: v.rules && v.rules.plantMs, defuseMs: v.rules && v.rules.defuseMs,
      carrierName: b.carrier ? nameOf(b.carrier) : '', actorName: b.action ? nameOf(b.action.id) : ''
    };
  }

  /* ---------------------------------------------------------------- 개인전(FFA) 진행 */
  /** FFA 페이즈: loadout(처음 무기) → live(전원 spawn) → matchEnd. 새 방장이 다시 시작하면 loadout부터 */
  function ffaPhase(ph, ev, view, from) {
    const c = current;
    const v = view || c.view;
    if (ph === 'matchEnd') { showResults(v, ev); return; }
    if (ph !== 'loadout' && ph !== 'live') return;
    const restart = ph === 'loadout' && !!from && !!c.roundFrom && from !== c.roundFrom && !!c.phase && c.phase !== 'loadout';
    if (!restart && c.phase && PHASE_ORDER[ph] <= PHASE_ORDER[c.phase]) return;
    const joinedLate = !c.phase && ph === 'live' && !ev;   // 진행 중에 들어옴(스냅샷으로 처음 봄)
    if (!c.phase || restart) {
      c.roundFrom = from || c.roundFrom;
      c.round = 1;
      c.pickSent = '';
      W('reset');
      W('setRespawn', null);
      call(ui.killfeed, 'clear');
    }
    c.phase = ph;
    const vp = v ? v.players.find((p) => p.id === me) : null;
    if (vp && vp.connected) c.playing = true;
    const target = ffaTarget(v);
    if (ph === 'loadout') {
      onLoadoutPhase(1, ev, v);
      H('center', restart ? '방장이 바뀌었어요' : '개인전', 2600, { sub: restart ? '킬 기록을 이어 모두 다시 출격해요' : `모두가 적 · 먼저 ${target}킬` });
      W('sound', 'round_start');
    } else {
      if (!c.compact) U('hide', 'loadout');
      if (joinedLate) {
        H('center', '개인전에 합류했어요', 2200, { sub: `곧 출격해요 · 먼저 ${target}킬 하면 우승` });
        if (c.playing) announceGear(c);   // 로드아웃을 건너뛰었다: 첫 부활 전에 계정 장비를 방장에게 알린다
      } else H('center', '작전 개시!', 1400, { sub: `먼저 ${target}킬 하면 우승` });
    }
    if (v) W('setRound', ffaInfo(v));
  }

  /** spawn { id, spawn:{x,y,z,rotY}, loadout, protectMs } — 처음 출격·부활 */
  function onSpawn(e, view) {
    const c = current;
    if (!c || !e) return;
    const id = String(e.id);
    const sp = e.spawn && typeof e.spawn === 'object' ? e.spawn : null;
    if (!sp || !Number.isFinite(+sp.x) || !Number.isFinite(+sp.z)) return;
    const lo = isPickable(c.ruleset, e.loadout) ? e.loadout : null;
    const protectMs = Math.max(0, Number(e.protectMs) || 0);
    if (!c.round) c.round = 1;
    if (id === me) {
      c.playing = true;
      c.localAlive = true;
      c.localHp = (c.view && c.view.rules && c.view.rules.hp) || DEFAULT_RULES.hp;
      c.killerName = null;
      c.killWeapon = null;
      c.aliveMismatchAt = 0;
      c.protect = protectMs > 0;
      if (c.compact) { c.compact = false; U('hide', 'loadout'); }
      W('setRespawn', null);
      W('spawnLocal', { id: me, name: myName(), team: null, spawn: { ...sp }, loadout: lo || c.pick, protectMs });
      W('setHint', '');
      noteSpawned(c);
      return;
    }
    let a = actors.get(id);
    if (!a) {
      const vp = (view || c.view) ? (view || c.view).players.find((p) => p.id === id) : null;
      a = { id, name: (vp && vp.name) || nameOf(id), team: null, dead: false, spawn: null };
      actors.set(id, a);
      W('addActor', { id, name: a.name, team: null, kind: 'remote', avatar: avatarOf(id) });
    }
    a.dead = false;
    a.spawn = { pos: [+sp.x || 0, spawnY(c, sp), +sp.z || 0], yaw: +sp.rotY || 0, at: now(), first: true };
    if (lo) noteGear(id, lo);
    W('setActorProtect', id, protectMs);
  }

  /** (FFA) 내가 죽음 → 부활 대기 표시 + 다음 무기 고르기(작은 패널) */
  function ffaDied(killerName, weaponId) {
    const c = current;
    if (!c) return;
    c.killerName = killerName || null;
    c.killWeapon = weaponLabel(weaponId) || null;
    const respawnMs = Number(c.view && c.view.rules && c.view.rules.respawnMs) > 0 ? Number(c.view.rules.respawnMs) : 3000;
    W('setRespawn', { inMs: respawnMs, killer: c.killerName || undefined, weaponName: c.killWeapon || undefined });
    showCompactLoadout();
  }

  function showCompactLoadout() {
    const c = current;
    if (!c || c.phase !== 'live') return;
    // UI가 스스로 닫았으면(hud.respawn이 비면 compact도 닫힘) 아직 죽어 있는 동안 다시 띄운다
    if (c.compact && call(ui, 'isVisible', 'loadout') !== false) return;
    c.compact = true;
    U('show', 'loadout', { compact: true, weapons: pickableWeapons(c.ruleset, ownedIds()), ruleset: c.ruleset, seconds: 0, selected: c.pick, title: '다음 출격 무기' });
  }

  /** (FFA) 스냅샷 반영: 놓친 출격·사망 보정, 부활 대기 시간, 보호, HUD */
  function applyFfaView(view, from) {
    const c = current;
    c.view = view;
    if (view.phase === 'matchEnd') { showResults(view, c.matchEnd); return; }
    if (view.phase === 'loadout' || view.phase === 'live') {
      ffaPhase(view.phase, null, view, from);
      if (current !== c) return;
    }
    const vp = view.players.find((p) => p.id === me);
    if (vp && vp.connected) { c.playing = true; if (!c.round) c.round = 1; }
    if (vp && c.playing && view.phase === 'live') {
      const t = now();
      if (vp.alive !== c.localAlive) {
        // 이벤트(spawn·kill)를 놓쳤을 때만 보정: 1.5초 넘게 어긋나면
        if (!c.aliveMismatchAt) c.aliveMismatchAt = t;
        else if (t - c.aliveMismatchAt > 1500) {
          c.aliveMismatchAt = 0;
          if (vp.alive) onSpawn({ id: me, spawn: ffaFallbackSpawn(c), loadout: vp.loadout, protectMs: 0 }, view);
          else if (c.localAlive) { c.localAlive = false; W('killLocal', {}); ffaDied(null); }
        }
      } else c.aliveMismatchAt = 0;
      if (vp.alive && c.localAlive && vp.hp !== c.localHp) { c.localHp = vp.hp; W('setLocalHp', vp.hp); }
      if (!vp.alive) {
        if (isNum(vp.respawnIn)) W('setRespawn', { inMs: Math.max(0, vp.respawnIn), killer: c.killerName || undefined, weaponName: c.killWeapon || undefined });
        showCompactLoadout();
      } else if (c.protect && vp.protect === false) {
        c.protect = false;
        W('setProtect', false);   // 먼저 쏴서 보호가 끝남
      }
    }
    placeFfaActors(view);
    W('setRound', ffaInfo(view));
  }

  /** spawn.y가 없으면 맵 스폰 표(같은 x·z)에서 찾는다(빌더가 바닥 높이를 넣어 둔다) */
  function spawnY(c, sp) {
    if (Number.isFinite(+sp.y) && sp.y !== null && sp.y !== undefined) return +sp.y;
    const all = c.spawns || {};
    for (const k of Object.keys(all)) {
      for (const q of Array.isArray(all[k]) ? all[k] : []) {
        if (q && Math.abs(+q.x - +sp.x) < 0.05 && Math.abs(+q.z - +sp.z) < 0.05 && Number.isFinite(+q.y)) return +q.y;
      }
    }
    return 0;
  }

  function ffaFallbackSpawn(c) {
    const pool = [];
    const sp = c.spawns || {};
    for (const k of ['ffa', 'owner', 'charterer']) if (Array.isArray(sp[k])) pool.push(...sp[k]);
    return pool.length ? { ...pool[Math.floor(Math.random() * pool.length)] } : { x: 0, z: 0, rotY: 0 };
  }

  /** (FFA) 원격 아바타: 경기에 있는 접속자 모두(팀 없음). 사망·부활을 놓쳤으면 맞춘다 */
  function placeFfaActors(view) {
    const present = new Set(room ? room.players().map((x) => x.id) : []);
    const want = new Map();
    for (const p of view.players) if (p.id !== me && p.connected && present.has(p.id)) want.set(p.id, p);
    for (const id of [...actors.keys()]) if (!want.has(id)) { W('removeActor', id); actors.delete(id); }
    for (const [id, p] of want) {
      let a = actors.get(id);
      if (!a) {
        // 아직 출격 전(늦게 들어옴·부활 대기)인 사람은 spawn 이벤트 때 세운다(그 전 위치는 의미 없음)
        if (!p.alive) continue;
        a = { id, name: p.name, team: null, dead: false, spawn: null };
        actors.set(id, a);
        W('addActor', { id, name: p.name, team: null, kind: 'remote', avatar: avatarOf(id) });
        continue;
      }
      if (view.phase !== 'live') continue;
      if (!p.alive && !a.dead) { a.dead = true; W('actorDeath', id, {}); }   // 킬 이벤트를 놓쳤다
      else if (p.alive && a.dead && !a.spawn) a.dead = false;                 // spawn 이벤트를 놓쳤다(자기 상태로 위치를 받는다)
    }
  }

  /** world.setRound(FFA): HUD "🎯 7킬 · 2위/5 · 1위 하늘 12 / 20" */
  function ffaInfo(v) {
    const ranking = ffaRanking(v);
    const mine = ranking.find((r) => r.id === me);
    const leader = ranking[0];
    const target = ffaTarget(v);
    const info = {
      mode: 'ffa', kills: mine ? mine.kills : 0, rank: mine ? mine.rank : ranking.length + 1, total: ranking.length,
      leaderName: leader ? leader.name : '', leaderKills: leader ? leader.kills : 0, target
    };
    return { ...info, phase: v.phase, round: 1, timeLeftMs: v.timeLeftMs, score: info };
  }

  function roundInfo(v) {
    const mp = matchPointTeams(v.score, v.rules);
    return {
      phase: v.phase, round: v.round, score: { ...v.score }, timeLeftMs: v.timeLeftMs,
      alive: { owner: v.teams.owner.alive, charterer: v.teams.charterer.alive },
      teamSize: { owner: v.teams.owner.players, charterer: v.teams.charterer.players },
      roundsToWin: v.rules.roundsToWin, maxRounds: v.rules.maxRounds,
      matchPoint: mp.length > 0, matchPointTeams: mp,
      ...(v.mode === 'bomb' ? { mode: 'bomb', attack: v.attack || null } : {})
    };
  }

  /* ---------------------------------------------------------------- 결과 */
  function resultsProps(v, c, ev) {
    if (c.mode === 'ffa') return ffaResultsProps(v, c, ev);
    const res = v.result || (ev ? { winner: ev.winner, reason: ev.reason, mvpId: ev.mvpId } : {});
    const { stats, mvp } = standings(v);
    const players = stats.map((s) => ({ ...s, head: s.headshots, alive: true, me: s.id === me, ping: pingOf(s.id) }));
    const bomb = c.mode === 'bomb';
    return {
      ...(bomb ? { mode: 'bomb' } : {}),
      winner: res.winner === 'owner' || res.winner === 'charterer' ? res.winner : 'draw',
      score: { ...v.score },
      rounds: v.history.map((r) => (bomb
        ? { round: r.round, winner: r.winner || 'draw', reason: BOMB_REASON_LABELS[r.reason] || r.reason || '', reasonCode: r.reason, attack: r.attack || null }
        : { round: r.round, winner: r.winner || 'draw', reason: REASON_LABELS[r.reason] || r.reason || '' })),
      players,
      mvp: mvp ? { ...mvp, head: mvp.headshots, me: mvp.id === me } : undefined,
      myTeam: c.team || undefined,
      mapId: c.mapId,
      meId: me,
      backLabel: '방으로 돌아가기'
    };
  }

  function ffaResultsProps(v, c, ev) {
    const src = ev && Array.isArray(ev.ranking) && ev.ranking.length ? ev.ranking : ffaRanking(v);
    const ranking = src.map((r) => ({
      rank: r.rank | 0 || 1, id: String(r.id), name: r.name || nameOf(String(r.id)), kills: r.kills | 0, deaths: r.deaths | 0,
      head: (r.headshots != null ? r.headshots : r.head) | 0, me: String(r.id) === me, bot: !!r.bot
    }));
    const res = v.result || {};
    const winnerId = ev && ev.winner !== undefined ? ev.winner : res.winner;
    const win = winnerId ? ranking.find((r) => r.id === String(winnerId)) : null;
    return {
      mode: 'ffa', ranking, winnerId: winnerId ? String(winnerId) : null,
      winnerName: winnerId ? (win ? win.name : nameOf(String(winnerId))) : null,
      reason: (ev && ev.reason) || res.reason || '', target: ffaTarget(v), mapId: c.mapId, meId: me, backLabel: '방으로 돌아가기'
    };
  }

  /**
   * 경기 결과를 계정에 기록하고 결과 화면에 줄 보상을 돌려준다. 경기(mid)당 한 번이고 한 번도 출격하지 않았으면 기록하지 않는다.
   * 방장 이전은 경기 id를 그대로 이어 가므로 합산된 값으로 여기서 한 번만 기록된다.
   */
  function recordResult(c, v, ev) {
    const a = account();
    if (!a || typeof a.recordMatch !== 'function' || c.startedAt == null || recordedMids.has(c.mid)) return null;
    const summary = matchSummary({
      view: v, event: ev, me, mode: c.mode, ruleset: c.ruleset, mapId: c.mapId, team: c.team,
      knifeKills: c.knifeKills, seconds: (now() - c.startedAt) / 1000
    });
    if (!summary) return null;
    recordedMids.add(c.mid);
    const res = call(a, 'recordMatch', summary);
    return res ? { gained: res.gained, breakdown: res.breakdown, points: res.points } : null;
  }

  function showResults(view, ev) {
    const c = current;
    if (!c || c.resultsShown) return;
    const v = view || c.view;
    if (!v) return;
    c.resultsShown = true;
    const last = ev || c.matchEnd;
    const props = { ...resultsProps(v, c, last), ruleset: c.ruleset };
    const reward = recordResult(c, v, last);
    if (reward) props.reward = reward;
    const res = v.result || (ev && { winner: ev.winner, reason: ev.reason }) || {};
    finishedMid = c.mid;
    const wasHost = !!hm;
    teardownMatch();
    phase = 'results';
    if (wasHost || (room && room.isHost())) safeMeta({ status: 'waiting' });
    if (props.mode === 'ffa') {
      const w = props.ranking.find((r) => r.id === props.winnerId);
      pushChat({ system: true, text: `경기 종료 — ${props.winnerName ? `${props.winnerName} 우승${w ? ` (${w.kills}킬)` : ''}` : '무승부'}${FFA_REASON_TEXT[props.reason] ? ' · ' + FFA_REASON_TEXT[props.reason] : ''}` }, false);
    } else {
      const label = res.winner === 'owner' || res.winner === 'charterer' ? `${TEAM_NAME[res.winner]} 팀 승리` : '무승부';
      pushChat({ system: true, text: `경기 종료 — ${label} (블루 ${v.score.owner} : ${v.score.charterer} 레드${res.reason === 'forfeit' ? ' · 상대 팀 전원 퇴장' : ''})` }, false);
    }
    U('show', 'results', props);
    screen('results');
  }

  function scoreboardData() {
    const c = current;
    const v = c && c.view;
    if (!v) return null;
    if (c.mode === 'ffa') {
      const alive = new Map(v.players.map((p) => [p.id, p.connected && p.alive]));
      return {
        mode: 'ffa',
        players: ffaRanking(v).map((r) => ({
          id: r.id, name: r.name, rank: r.rank, kills: r.kills, deaths: r.deaths, headshots: r.headshots, team: null,
          ping: pingOf(r.id), alive: !!alive.get(r.id), me: r.id === me, bot: r.bot
        })),
        target: ffaTarget(v), mapId: c.mapId, mapName: c.mapName || undefined, meId: me
      };
    }
    // 폭파 미션: 폭탄을 든 사람은 내가 공격 팀일 때만 보인다
    const bomb = c.mode === 'bomb';
    const carrier = bomb && c.team && c.team === v.attack && v.bomb && v.bomb.state === 'carried' ? v.bomb.carrier : null;
    return {
      ...(bomb ? { mode: 'bomb', attack: v.attack || null } : {}),
      players: v.players.filter((p) => p.connected || p.kills || p.deaths).map((p) => ({
        id: p.id, name: p.name, team: p.team, kills: p.kills, deaths: p.deaths, headshots: p.headshots,
        ping: pingOf(p.id), alive: p.connected && p.playing && p.alive, me: p.id === me,
        ...(carrier && p.id === carrier ? { bomb: true } : {})
      })),
      score: { owner: v.score.owner, charterer: v.score.charterer, target: v.rules.roundsToWin, bestOf: v.rules.maxRounds, round: v.round },
      round: v.round,
      mapId: c.mapId,
      mapName: c.mapName || undefined,
      meId: me
    };
  }

  /* ---------------------------------------------------------------- 로드아웃 */
  function pickLoadout(id) {
    const w = normalizeWeaponId(id);
    const c = current;
    const ruleset = c ? c.ruleset : roomRuleset();
    if (!isPickable(ruleset, w)) return;
    lastPicks.set(ruleset, w);
    if (phase !== 'match' || !c || !c.playing) return;
    c.pick = w;
    const ffa = c.mode === 'ffa';
    // 팀전: loadout 페이즈에만(늦으면 다음 라운드 기본값) / FFA: loadout·live 모두(다음 부활부터 적용)
    if (ffa ? (c.phase !== 'loadout' && c.phase !== 'live') : c.phase !== 'loadout') return;
    const key = ffa ? w : c.round + ':' + w;
    if (c.pickSent === key) return;               // world 'loadoutPick'과 ui 'loadout:pick' 중복
    c.pickSent = key;
    sendGear(c);
  }

  /* ---------------------------------------------------------------- sync 이벤트 */
  function onSyncEvent(e) {
    if (disposed || !e) return;
    // (방장) 내보낸 사람이 강퇴를 무시하고 남아 있어도 그 사람의 사격·수류탄·장비·채팅은 받지 않는다
    if (hm && e.from != null && banned.has(String(e.from)) && BANNED_DROP.has(e.type)) return;
    switch (e.type) {
      case 'match':
        onMatchData({ from: e.from, snapshot: e.snapshot, events: e.events });
        break;
      case 'fire':
        if (phase === 'match' && current && current.loaded && actors.has(e.from)) queueFire(e);
        // (방장) 폭파 미션: 설치·해체 중인 사람이 쏘면 취소(그 사람이 아니면 match가 아무것도 하지 않는다)
        if (hm && hm.mode === 'bomb' && hostReady()) publishReal(hm.m.bombIntent(e.from, 'cancel', { reason: 'fired' }));
        break;
      case 'hitClaim':
        if (hm) hostClaim(e);
        break;
      case 'bomb':
        // (방장) 폭파 미션 설치·해체 시작·취소 의도. 위치·생존·시간은 match가 직접 재서 확정한다. 내 의도도 sync가 여기로 돌려준다
        if (hm && hm.mode === 'bomb' && hostReady()) publishReal(hm.m.bombIntent(String(e.from), e.act, { reason: e.reason }));
        break;
      case 'grenade':
        if (phase === 'match' && current && current.loaded && e.from !== me) {
          W('actorGrenade', { id: e.from, grenadeId: e.gid, pos: e.pos, vel: e.vel, t: e.localT });
        }
        // (방장) 폭파 미션: 던지는 순간 그 사람의 설치·해체를 취소한다. 터질 때(claimExplosion)는 취소하지 않는다
        if (hm && hm.mode === 'bomb' && hostReady()) publishReal(hm.m.bombIntent(String(e.from), 'cancel', { reason: 'fired' }));
        break;
      case 'loadout': {
        const from = String(e.from);
        const gear = readGear(e.loadout);
        if (Object.keys(gear).length) remoteGear.set(from, { ...remoteGear.get(from), ...gear });
        const c = current;
        if (c && hostReady() && isPickable(c.ruleset, gear.pick) && (c.phase === 'loadout' || (hm.mode === 'ffa' && c.phase === 'live'))) {
          publishReal(hm.m.setLoadout(from, gear.pick));
        }
        break;
      }
      case 'chat': {
        const from = String(e.from);
        let seen = chatSeen.get(from);
        if (!seen) chatSeen.set(from, (seen = []));
        if (!chatAllowed(seen, CHAT_LIMIT.receive)) break;   // 도배는 조용히 버린다
        pushChat({ name: nameOf(e.from), text: cleanText(e.text, 120), team: roomMode() === 'ffa' ? null : roomTeamOf(e.from) });
        break;
      }
      case 'drop':
        if (phase === 'match' && current && current.loaded && current.phase === 'live') {
          W('addDrop', { id: e.dropId, weaponId: e.weaponId, pos: e.pos, mag: e.mag, reserve: e.reserve });
        }
        break;
      case 'pick':
        if (phase === 'match' && current && current.loaded) W('removeDrop', e.dropId);
        break;
      case 'leave':
        remoteGear.delete(e.id);
        if (actors.has(e.id)) { W('removeActor', e.id); actors.delete(e.id); }
        break;
      default:
        break;
    }
  }

  /** 최신 원본은 sync가 들고 있다(getRemote/remote). (방장) 교전 중이면 그 이동이 물리적으로 가능한지 본다 */
  function onRemoteState(id, state) {
    if (!state || !hostReady()) return;
    const pid = String(id);
    if (pid === me || banned.has(pid) || !hm.members.has(pid)) return;
    const c = current;
    if (!c || c.phase !== 'live') { moveGuard.reset(pid); return; }
    const bad = moveGuard.feed(pid, { t: state.t, pos: state.pos, alive: state.alive !== false });
    if (bad) { trace('move', pid, bad.reason, Math.round(bad.moved * 10) / 10, bad.dt); strike(pid, bad.reason); }
  }

  /** sync 전송용 로컬 상태(경기 중 참가자만). 생존은 방장 판정을 따른다 */
  function localState() {
    const c = current;
    if (phase !== 'match' || !c || !c.loaded || !c.playing || !c.round) return null;
    const st = call(world, 'getLocalState');
    if (!st || typeof st !== 'object' || !st.pos) return null;
    if (hm) {
      const t = now();
      selfTrail.push({ t, pos: [st.pos[0], st.pos[1], st.pos[2]], crouch: !!st.crouch });
      while (selfTrail.length > 48 || (selfTrail.length && t - selfTrail[0].t > 2500)) selfTrail.shift();
    }
    return { ...st, zoom: st.zoom !== undefined ? !!st.zoom : !!st.aiming, alive: !!c.localAlive && st.alive !== false };
  }

  /* ---------------------------------------------------------------- 로컬 플레이어 이벤트(world) */
  const worldOffs = [];
  function wOn(evt, fn) {
    if (typeof world.on !== 'function') return;
    try { const f = world.on(evt, (p) => { try { fn(p || {}); } catch (err) { report(err, 'world ' + evt); } }); if (typeof f === 'function') worldOffs.push(f); }
    catch (err) { report(err, 'world.on'); }
  }
  const inRound = () => phase === 'match' && current && current.loaded && current.playing && current.localAlive && sync;
  const localT = (t) => (isNum(t) && Math.abs(t - now()) < 5000 ? t : now());

  wOn('fire', (f) => {
    if (!inRound() || (current.phase !== 'live' && current.phase !== 'roundEnd')) return;
    sync.sendFire({ weaponId: f.weaponId, origin: f.origin, dir: f.dir, hit: f.hitPoint || f.hit || null, hitKind: f.hitKind, kind: f.kind, t: localT(f.t) });
  });
  wOn('hitClaim', (h) => {
    if (!inRound() || current.phase !== 'live' || h.victimId == null) return;
    sync.sendHitClaim({
      victimId: String(h.victimId), part: h.part, weaponId: h.weaponId, dist: Number(h.dist) || 0, kind: h.kind, t: localT(h.t),
      count: h.count, shotId: h.shotId
    });
  });
  wOn('grenade', (g) => {
    if (!inRound() || current.phase !== 'live') return;
    sync.sendGrenade({ pos: g.pos, vel: g.vel, t: localT(g.t) });
  });
  // 총은 죽은 뒤에 버리므로 살아 있는지(inRound)는 보지 않는다
  wOn('weaponDrop', (d) => {
    if (phase !== 'match' || !current || !current.loaded || !current.playing || !sync || current.phase !== 'live') return;
    sync.sendDrop({ dropId: d.dropId, weaponId: d.weaponId, pos: d.pos, mag: d.mag, reserve: d.reserve });
  });
  wOn('weaponPick', (p) => { if (inRound()) sync.sendPick(p.dropId); });
  wOn('explosion', (x) => { if (hm) hostExplosion(x); });
  // 폭파 미션: 내 E 키(휴대폰 설치/해체 버튼) → 방장에게 의도. 취소는 죽은 뒤에도 보낼 수 있다(방장이 이미 끝냈으면 무시)
  wOn('bombAction', (a) => {
    const c = current;
    if (phase !== 'match' || !c || c.mode !== 'bomb' || !c.loaded || !sync || !a || !a.act) return;
    if (a.act !== 'cancel' && !inRound()) return;
    sync.sendBomb(a.act, a.reason);
  });
  wOn('loadoutPick', (p) => pickLoadout(p.id != null ? p.id : p.weaponId != null ? p.weaponId : p.primary));
  wOn('leave', () => { if (phase === 'match') leaveRoom(); });

  /* ---------------------------------------------------------------- 프레임: 원격 보간 → world */
  let watchTimer = null;
  /** 자가 복구: 방장인데 경기 객체가 없으면 이어받고, 멤버인데 방장 소식이 끊기면 대기실로 */
  function watchdog() {
    const c = current;
    if (disposed || phase !== 'match' || !c || !room) return;
    const t = now();
    if (room.isHost()) {
      if (hm && !hm.m && t - c.enteredAt > o.stallMs + 5000) { trace('watchdog: host map stall', c.mid); abortMatch('map-failed'); return; }
      if (hm || c.resultsShown) return;
      if (c.loaded && c.round > 0) { trace('watchdog: takeover'); takeOver(); }
      else if (t - c.lastDataAt > o.stallMs) { trace('watchdog: host stall', c.mid); abortMatch('host-left'); }
      return;
    }
    if (t - c.lastDataAt > o.stallMs) {
      trace('watchdog: stall', c.mid);
      finishedMid = c.mid;
      matchToRoom('방장 응답이 없어 대기실로 돌아왔어요.');
    }
  }
  function startFrames() {
    if (!watchTimer) watchTimer = setInterval(watchdog, 1000);
    if (frameOff || rafId != null || frameTimer) return;
    if (typeof o.onFrame === 'function') { frameOff = o.onFrame(() => frame()); return; }
    if (ctx && typeof ctx.onFrame === 'function') { frameOff = ctx.onFrame(() => frame(), o.frameOrder); return; }
    if (typeof globalThis.requestAnimationFrame === 'function') {
      const loop = () => { rafId = requestAnimationFrame(loop); frame(); };
      rafId = requestAnimationFrame(loop);
      return;
    }
    frameTimer = setInterval(() => frame(), 33);
  }
  function stopFrames() {
    if (watchTimer) { clearInterval(watchTimer); watchTimer = null; }
    if (frameOff) { safeOff(frameOff); frameOff = null; }
    if (rafId != null) { try { cancelAnimationFrame(rafId); } catch (_) { /* noop */ } rafId = null; }
    if (frameTimer) { clearInterval(frameTimer); frameTimer = null; }
  }

  /** 원격 아바타가 든 무기: 슬롯은 상태 메시지, 무기는 그 사람의 장비에서 찾는다 */
  function weaponFor(id, slot) {
    const vp = viewPlayer(id);
    return weaponForSlot(remoteGear.get(id), slot, current.ruleset, vp && vp.loadout);
  }

  function frame() {
    const c = current;
    if (disposed || phase !== 'match' || !c || !c.loaded || !sync) return;
    const t = now();
    for (const a of actors.values()) {
      const vp = viewPlayer(a.id);
      const ffa = c.mode === 'ffa';
      const alive = !!(vp && vp.connected && (ffa || vp.playing) && vp.alive) && !a.dead;
      const s = sync.getRemote(a.id, t);
      let st = null;
      if (a.spawn) {
        // 라운드 시작: 그 사람의 새 상태가 스폰 근처에 닿을 때까지(최대 3초) 스폰 자리에 세운다
        const near = s && s.pos && Math.hypot(s.pos[0] - a.spawn.pos[0], s.pos[2] - a.spawn.pos[2]) < 4;
        if (near || t - a.spawn.at > 3000) a.spawn = null;
        else {
          st = { pos: a.spawn.pos.slice(), vel: [0, 0, 0], yaw: a.spawn.yaw, pitch: 0, slot: rulesetOf(c.ruleset).slots[0], onGround: true, moving: false, teleport: a.spawn.first };
          a.spawn.first = false;
        }
      }
      if (!st && s) {
        st = s;
        st.moving = !!(s.vel && Math.hypot(s.vel[0], s.vel[2]) > 0.3);
      }
      if (!st) continue;
      st.alive = alive;
      st.name = a.name;
      st.team = a.team;
      st.avatar = avatarOf(a.id);
      if (vp) st.hp = vp.hp;
      st.slot = allowedSlot(c.ruleset, st.slot | 0);
      st.weaponId = weaponFor(a.id, st.slot);
      if (ffa) st.protect = !!(vp && vp.protect);
      W('setActorState', a.id, st);
    }
    if (fireQ.length) {
      let w = 0;
      for (let i = 0; i < fireQ.length; i++) {
        const f = fireQ[i];
        if (f.at <= t) { if (actors.has(f.data.id)) W('actorFire', f.data); }
        else fireQ[w++] = f;
      }
      fireQ.length = w;
    }
  }

  function queueFire(e) {
    const t = now();
    // 아바타의 렌더 시간축에 맞춰 재생(최대 0.3초 늦춤)
    const at = isNum(e.at) ? Math.min(t + 300, Math.max(t, e.at)) : t;
    fireQ.push({ at, data: { id: e.from, weaponId: e.weaponId, origin: e.origin, dir: e.dir, hitPoint: e.hit || null, hitKind: e.hitKind || (e.hit ? 'world' : 'none'), kind: e.kind } });
    if (fireQ.length > 128) fireQ.shift();
    noteGear(String(e.from), e.weaponId);   // 사격 메시지의 무기가 정답이다(원격이 든 칼·총이 다음 상태부터 맞게 그려진다)
  }

  /* ---------------------------------------------------------------- UI 이벤트 */
  const uiOffs = [
    ui.on('lobby:refresh', () => refreshLobby()),
    ui.on('lobby:back', () => exitToMenu()),
    ui.on('lobby:create', (p) => { createRoom(p || {}); }),
    ui.on('lobby:join', (p) => { joinRoom(p && p.roomId, p && p.password); }),
    ui.on('room:team', (p) => setTeam(p && p.team)),
    ui.on('room:ready', (p) => setReady(!!(p && p.ready))),
    ui.on('room:start', () => hostStart()),
    ui.on('room:map', (p) => setMap(p && p.mapId)),
    ui.on('room:mode', (p) => setMode(p && p.mode)),
    ui.on('room:ruleset', (p) => setRoomRuleset(p && p.ruleset)),
    ui.on('room:killTarget', (p) => setKillTarget(p && p.killTarget)),
    ui.on('room:chat', (p) => sendChat(p && p.text)),
    ui.on('chat:send', (p) => sendChat(p && p.text)),
    ui.on('chat:open', () => onChatOpen()),
    ui.on('room:leave', () => { leaveRoom(); }),
    ui.on('loadout:pick', (p) => pickLoadout(p && p.id)),
    ui.on('results:back', () => backToRoom()),
    ui.on('results:lobby', () => { leaveRoom(); })
  ];
  const bus = o.bus || (ctx && ctx.bus) || null;
  const busOffs = bus && typeof bus.on === 'function' ? [bus.on('account:change', onAccountChange), bus.on('input:chat', onChatKey)] : [];

  /* ---------------------------------------------------------------- 정리 */
  function dispose() {
    if (disposed) return;
    if (coreScreens && ['lobby', 'room', 'match', 'results'].includes(ctx.screen)) {
      try { const p = ctx.setScreen('menu'); if (p && p.catch) p.catch(() => {}); } catch (_) { /* noop */ }
    }
    disposed = true;
    teardownMatch();
    unsubscribeLobby();
    for (const f of uiOffs.splice(0)) safeOff(f);
    for (const f of worldOffs.splice(0)) safeOff(f);
    for (const f of screenOffs.splice(0)) safeOff(f);
    for (const f of busOffs.splice(0)) safeOff(f);
    const r = room, n = net, mine = ownNet;
    leaving = true;
    detachRoom();
    safeOff(netOff);
    netOff = null;
    const closeNet = () => { if (mine && n) { try { const p = n.close(); if (p && p.catch) p.catch(() => {}); } catch (_) { /* noop */ } } };
    if (r) { Promise.resolve().then(() => r.leave()).catch(() => {}).then(closeNet); }
    else closeNet();
    net = null;
    phase = 'closed';
    emit('closed', {});
    listeners.clear();
  }

  const api = {
    open,
    dispose,
    /** 방에서 나가 로비로 */
    leave: leaveRoom,
    on,
    off,
    /** 직접 프레임을 돌릴 때(onFrame/ctx가 없을 때 자동 rAF) */
    frame,
    /** Tab 점수판 데이터(world.setScoreboard에 이미 연결됨) */
    scoreboard: scoreboardData,
    get phase() { return phase; },
    get net() { return net; },
    get room() { return room; },
    get sync() { return sync; },
    get me() { return me; },
    get isHost() { return !!(room && room.isHost()); },
    /** 방장일 때 돌리는 경기 객체(match.js 또는 restoreMatch) */
    get match() { return hm ? hm.m : null; },
    /** 마지막으로 반영한 경기 상태(applySnapshot 모양) */
    get view() { return current ? current.view : null; },
    get state() {
      const c = current;
      return {
        phase, roomId: room ? room.id : null, me, isHost: !!(room && room.isHost()), hostId: room ? room.hostId() : null,
        matchId: c ? c.mid : null, ruleset: c ? c.ruleset : roomRuleset(), pick: c ? c.pick : null,
        loaded: !!(c && c.loaded), round: c ? c.round : 0, matchPhase: c ? c.phase : null,
        playing: !!(c && c.playing), alive: !!(c && c.localAlive), team: c ? c.team : myRoomTeam(),
        score: c && c.view ? { ...c.view.score } : null, actors: [...actors.keys()], chat: chat.slice(), avatars: Object.fromEntries(avatarsById),
        hosting: hm ? { mid: hm.mid, preparing: hm.preparing, restored: !!(hm.m && hm.m.restored) } : null
      };
    }
  };
  // ?debug=1 이면 core의 window.__skalafps처럼 세션도 노출(콘솔 디버그용)
  if (ctx && ctx.flags && ctx.flags.debug && typeof globalThis === 'object') {
    try { globalThis.__skalafpsSession = api; } catch (_) { /* noop */ }
  }
  return api;
}

export default createSession;
