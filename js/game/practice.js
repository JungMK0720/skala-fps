/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 연습장 봇전(팀전·개인전 × 클래식·칼전·스나전). 이 탭에서 match.js를 돌리며 봇 두뇌·무기·발판을 시뮬레이션하고,
 *          경기가 끝나면 계정에 전적을 한 번 기록한다. 시작 설정 시트와 저장된 설정도 여기 있다.
 */
/**
 * SKALA 작전 — 연습장 봇전 (싱글플레이): 팀전(5판 3선승) · 개인전(FFA) · 규칙(클래식 · 칼전 · 스나전)
 *
 *   const practice = createPractice({ ctx, world, ui });
 *   ctx.registerScreen('sandbox', { enter: (p) => practice.enter(p), exit: () => practice.exit() });
 *   const setup = createPracticeSetup({ ui, maps: ctx.maps, onStart: (o) => ctx.setScreen('sandbox', o) });
 *
 * - 로컬 match.js를 이 탭에서 직접 돌린다(방장 = 나).
 *   팀전: loadout → live → roundEnd → … → matchEnd(결과). 개인전: loadout → live(죽으면 respawnMs 뒤 'spawn'으로 부활) → matchEnd.
 * - 봇: bots.js 두뇌를 10 Hz로 생각시키고(봇마다 위상을 엇갈림), 이동은 engine physics.moveCharacter로 매 틱.
 *   사격은 봇마다 weapons/logic arsenal → physics.traceShot → match.claimHit. 연출은 world.actorFire.
 * - 내 사격·칼·수류탄 판정은 World가 하고('hitClaim'·'explosion'), 여기서 match에 넣는다.
 *
 * params(enter): { mapId, mode('team'|'ffa'), ruleset('classic'|'knife'|'sniper'), size(팀전 팀당 1~4), bots(개인전 봇 1~7),
 *                  difficulty('easy'|'normal'|'hard'), killTarget(개인전 5~50), timeScale(1~8, 시험용), botWeapon('mix' 또는 무기 id) }
 * URL(시험용, params가 우선): ?sandbox=<mapId>&mode=ffa&ruleset=knife&bots=3&killtarget=5&difficulty=hard&timescale=4&botweapon=ar_std&botemote=1
 *   (팀전에서 bots = 팀당 인원, 개인전에서 bots = 봇 수)
 */
import { PLAYER } from '../core/consts.js';
import { moveCharacter, traceShot, lineOfSight, findFloor, overlapsCapsule, getGroundY } from '../engine/physics.js';
import { stepTriggers } from '../engine/triggers.js';
import { createArsenal, shotDirection, dirFromYawPitch } from '../weapons/logic.js';
import { getDef } from '../weapons/defs.js';
import { throwVelocity } from '../weapons/grenade.js';
import { createMatch, standings, REASON_LABELS } from './match.js';
import { RULESETS, RULESET_IDS, normalizeRuleset, rulesetOf, pickableWeapons, defaultPick, shotTargets } from './modes.js';
import { createBot, pickBotWeapon, botLoadout, loadoutKey } from './bots.js';
import { buildNavGrid } from './navgrid.js';
import { meleeTrace } from './world.js';
import { h, btn } from '../ui/dom.js';
import { sheet, createModal, mapCard } from '../ui/parts.js';

export const PRACTICE_DEFAULTS = Object.freeze({ mapId: 'alley', mode: 'ffa', ruleset: 'classic', size: 2, ffaBots: 5, difficulty: 'normal', timeScale: 1 });
/** 규칙을 고르면 먼저 선택되는 맵 */
const RULESET_MAP = Object.freeze({ classic: 'alley', knife: 'dojo', sniper: 'longshot' });
/** 맵 파일을 열지 못할 때 대신 여는 맵 */
const FALLBACK_MAP = 'testyard';
/** 맵 목록에 rulesets가 없을 때의 값(DESIGN 5절) */
const DEFAULT_MAP_RULESETS = Object.freeze(['classic', 'sniper']);
const MODE_NAME = Object.freeze({ team: '팀전', ffa: '개인전' });
/** 샷건이 여러 부위를 맞혔을 때 주장에 쓰는 부위 순서(앞이 우선, World의 내 사격과 같다) */
const PART_ORDER = Object.freeze(['head', 'body', 'legs', 'hand', 'foot']);
const DIFFS = ['easy', 'normal', 'hard'];
const PREF_KEY = 'skalafps.practice.v1';
const THINK_DT = 0.1;                    // 봇 판단 주기 10 Hz
const TEAM_NAME = { owner: '블루', charterer: '오렌지' };
const BOT_NAMES = {
  owner: ['알파', '브라보', '찰리'],
  charterer: ['델타', '에코', '폭스', '골프'],
  ffa: ['알파', '브라보', '찰리', '델타', '에코', '폭스', '골프']
};
const FFA_REASON = { kills: '목표 킬 달성', time: '시간 종료', forfeit: '상대 퇴장', draw: '무승부' };
const PITCH_LIMIT = (89 * Math.PI) / 180;
const BOT_EMOTE_CHANCE = 0.3;            // 라운드 승리·킬 뒤 봇 이모트 확률
// 앉기(core consts, MODES.md 2절) — 값이 없던 옛 consts에서도 돌게 기본값
const CROUCH_H = PLAYER.CROUCH_HEIGHT || 1.25, CROUCH_EYE = PLAYER.CROUCH_EYE || 1.1, CROUCH_SPEED = PLAYER.CROUCH_SPEED || 2.6;
const IDLE = Object.freeze({ forward: 0, strafe: 0, jump: false, walk: false, yawDelta: 0, pitchDelta: 0, fire: false, zoom: false, reload: false, slot: null });

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const num = (v, d) => (Number.isFinite(+v) && v !== null && v !== '' ? +v : d);
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

/** 저장된 연습장 설정(없거나 깨진 값은 PRACTICE_DEFAULTS). 빠른 시작에도 쓴다 */
export function loadPrefs() {
  let p = null;
  try { p = JSON.parse(localStorage.getItem(PREF_KEY) || 'null'); } catch (e) { p = null; }
  const o = { ...PRACTICE_DEFAULTS, ...(p && typeof p === 'object' ? p : {}) };
  o.ruleset = normalizeRuleset(o.ruleset);
  if (o.mode !== 'team' && o.mode !== 'ffa') o.mode = PRACTICE_DEFAULTS.mode;
  o.mapId = String(o.mapId || PRACTICE_DEFAULTS.mapId);
  o.size = clamp(Math.round(num(o.size, PRACTICE_DEFAULTS.size)), 1, 4);
  o.ffaBots = clamp(Math.round(num(o.ffaBots, PRACTICE_DEFAULTS.ffaBots)), 1, 7);
  if (!DIFFS.includes(o.difficulty)) o.difficulty = PRACTICE_DEFAULTS.difficulty;
  return o;
}
function savePrefs(p) {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify({ mapId: p.mapId, mode: p.mode, ruleset: p.ruleset, size: p.size, ffaBots: p.ffaBots, difficulty: p.difficulty }));
  } catch (e) { /* ignore */ }
}

/** 이 규칙을 고를 수 있는 맵 목록. maps.mapsForRuleset이 없으면 MAP_LIST에서 거른다 */
function mapsFor(maps, ruleset) {
  if (maps && typeof maps.mapsForRuleset === 'function') return maps.mapsForRuleset(ruleset);
  const list = (maps && maps.MAP_LIST) || [];
  return list.filter((m) => !m.test && (Array.isArray(m.rulesets) ? m.rulesets : DEFAULT_MAP_RULESETS).includes(ruleset));
}
/** wanted가 이 규칙에서 고를 수 있으면 그대로, 아니면 규칙의 대표 맵, 그것도 없으면 목록의 첫 맵 */
function validMapFor(maps, ruleset, wanted) {
  const list = mapsFor(maps, ruleset);
  const has = (id) => list.some((m) => m.id === id);
  if (wanted && has(wanted)) return wanted;
  const preferred = RULESET_MAP[ruleset];
  if (has(preferred)) return preferred;
  return list.length ? list[0].id : wanted || preferred;
}

/**
 * params + URL(시험용) → 정규화된 옵션.
 * @param {object} [params]
 * @param {object} [maps] maps/index.js. 주면 저장된 맵이 규칙에 맞는지 확인한다(직접 고른 맵은 그대로 쓴다)
 */
export function practiceOptions(params = {}, maps = null) {
  const q = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
  const prefs = loadPrefs();
  // 우선순위: 직접 준 params → URL(시험용) → 지난 선택 → 기본값
  const ruleset = normalizeRuleset(params.ruleset || q.get('ruleset') || prefs.ruleset);
  const chosenMap = params.mapId || q.get('sandbox');
  const mapId = chosenMap ? String(chosenMap) : maps ? validMapFor(maps, ruleset, prefs.mapId) : prefs.mapId;
  const mq = params.mode || q.get('mode') || prefs.mode;
  const mode = mq === 'ffa' ? 'ffa' : 'team';
  const size = clamp(Math.round(num(params.size, num(mode === 'team' ? q.get('bots') : null, num(prefs.size, PRACTICE_DEFAULTS.size)))), 1, 4);
  const ffaBots = clamp(Math.round(num(params.bots, num(params.ffaBots, num(mode === 'ffa' ? q.get('bots') : null, num(prefs.ffaBots, PRACTICE_DEFAULTS.ffaBots))))), 1, 7);
  const dq = q.get('difficulty');
  const difficulty = DIFFS.includes(params.difficulty) ? params.difficulty : DIFFS.includes(dq) ? dq : DIFFS.includes(prefs.difficulty) ? prefs.difficulty : 'normal';
  const timeScale = clamp(Math.round(num(params.timeScale, num(q.get('timescale'), 1))), 1, 8);
  const killTarget = clamp(Math.round(num(params.killTarget, num(q.get('killtarget'), 20))), 5, 50);
  // 봇 주무기: mix(기본, 규칙별 확률표) 또는 무기 id. 규칙에 맞지 않는 id면 확률표대로 뽑는다
  const bw = params.botWeapon || q.get('botweapon');
  const botWeapon = bw && getDef(bw) ? bw : 'mix';
  // 봇 이모트 확률(라운드 승리·킬 뒤, 기본 0.3) — 시험용으로 &botemote=1
  const botEmote = clamp(num(params.botEmote, num(q.get('botemote'), BOT_EMOTE_CHANCE)), 0, 1);
  return { mapId, mode, ruleset, size, ffaBots, difficulty, timeScale, killTarget, botWeapon, botEmote };
}

export function createPractice({ ctx, world, ui }) {
  const navCache = new WeakMap();
  let run = null;

  function navFor(data) {
    let nav = navCache.get(data);
    if (!nav) {
      const t0 = performance.now();
      nav = buildNavGrid(data);
      navCache.set(data, nav);
      console.info(`[practice] navgrid ${data.id || '?'} ${Math.round(performance.now() - t0)} ms`, nav.info && nav.info.nodes);
    }
    return nav;
  }

  async function enter(params = {}) {
    const opts = practiceOptions(params, ctx.maps);
    const load = { mode: opts.mode, ruleset: opts.ruleset };
    let info;
    try {
      info = await world.loadMap(opts.mapId, load);
    } catch (err) {
      // 맵 파일이 깨져 있어도 연습장은 열린다
      console.warn(`[practice] 맵 '${opts.mapId}'을 열지 못해 '${FALLBACK_MAP}'으로 대신합니다`, err);
      info = await world.loadMap(FALLBACK_MAP, load);
    }
    if (info.mapId) opts.mapId = info.mapId;     // 없는 맵이면 코어가 대신 연 테스트 맵. 결과·전적에는 실제로 연 맵을 적는다
    run = startRun(opts, info);
  }

  function exit() {
    if (run) { run.dispose(); run = null; }
    world.unloadMap();
  }

  function restart() {
    if (!run) return;
    const { opts, info } = run;
    run.dispose();
    world.reset();
    world.setMode(opts.mode);
    if (ui) ui.show('hud', {});
    run = startRun(opts, info);
  }

  /* ============================================================ 한 판 */
  function startRun(optsIn, info) {
    const map = info.map;
    const nav = navFor(info.data);
    const rng = mulberry32((Date.now() ^ 0x5f3759df) >>> 0);
    const opts = { ...optsIn };
    const ffa = opts.mode === 'ffa';
    const rs = rulesetOf(opts.ruleset);
    const pickIds = pickableWeapons(rs.id);       // 경기(match.setLoadout)가 받는 무기
    const ruleLabel = rs.id === 'classic' ? MODE_NAME[opts.mode] : `${rs.name} · ${MODE_NAME[opts.mode]}`;
    const me = { id: world.localId, name: ctx.session.name || '나', team: ffa ? null : 'owner' };
    const offs = [];
    let disposed = false, paused = false;
    let phase = 'warmup', round = 0, phaseEndsAt = 0, simMs = 0, stepCount = 0;
    let score = { owner: 0, charterer: 0 };
    /** 내가 고를 수 있는 무기: 규칙 + 계정이 가진 무기 */
    function pickList() {
      const profile = ctx.account && ctx.account.profile;
      return pickableWeapons(rs.id, profile && Array.isArray(profile.owned) ? profile.owned : null);
    }
    /** 처음 고른 무기: 직전 판(다시 하기) → 계정 장비 → 규칙 기본값 */
    function startingPick() {
      const list = pickList();
      const lo = ctx.account && ctx.account.loadout;
      const equipped = lo ? lo[rs.pickSlot === 3 ? 'melee' : 'primary'] : null;
      const found = [run && run.lastPick, equipped, defaultPick(rs.id)].find((id) => id && list.includes(id));
      return found || list[0];
    }
    let lastPick = startingPick();
    let resultsAt = 0, resultsEv = null;
    let recorded = false, reward = null;          // 경기당 한 번만 계정에 기록한다
    let myHalfShots = 0, myKnifeKills = 0;
    const alive = new Map();                 // id → bool (팀전: 이번 라운드 / 개인전: 지금)
    const spawnOf = new Map();               // id → 최근 스폰
    const kills = new Map(), deaths = new Map(), heads = new Map();   // 경기 이벤트로 센다(개인전 HUD, 계정 기록)
    let myProtectUntil = 0;                  // 개인전 내 보호(시뮬레이션 ms)
    const los = (a, b) => lineOfSight(map.world, a, b);

    /* ---------- 봇 ---------- */
    const bots = [];
    const total = ffa ? opts.ffaBots : opts.size * 2 - 1;
    function makeBot(team, k) {
      const id = ffa ? `bot-f${k + 1}` : `bot-${team === 'owner' ? 'o' : 'c'}${k + 1}`;
      const name = `${BOT_NAMES[ffa ? 'ffa' : team][k] || '호텔'} 봇`;
      const pick = pickBotWeapon(rs.id, rng, opts.botWeapon);
      const gear = botLoadout(rs.id, pick, rng);
      const i = bots.length;
      const seed = (rng() * 4294967296) >>> 0;
      return {
        id, name, team: ffa ? null : team, pick,
        brain: createBot({ id, mode: opts.mode, team: ffa ? null : team, ruleset: rs.id, difficulty: opts.difficulty, primary: pick, secondary: gear.secondary, melee: gear.melee, seed }),
        // stageCycle:false: 봇은 zoom을 '줌을 원하는 동안 true'로 보내므로 다단 줌도 1단만 쓴다
        arsenal: createArsenal({ ...gear, allowedSlots: rs.slots, stageCycle: false, zoomMode: 'hold', rng }),
        body: { pos: [0, 0, 0], vel: [0, 0, 0], onGround: true },
        trig: {}, padFlight: false, shotSeq: 0,
        yaw: 0, pitch: 0, hp: PLAYER.HP, alive: !ffa, protectUntil: 0, crouch: false, emote: 0, emoteUntil: 0,
        cmd: IDLE, thinkAcc: (i / Math.max(1, total)) * THINK_DT,
        yawRate: 0, pitchRate: 0, rateTicks: 0,
        edge: { reload: false, slot: null, jump: false }
      };
    }
    if (ffa) for (let k = 0; k < opts.ffaBots; k++) bots.push(makeBot(null, k));
    else {
      for (let k = 0; k < opts.size - 1; k++) bots.push(makeBot('owner', k));
      for (let k = 0; k < opts.size; k++) bots.push(makeBot('charterer', k));
    }
    const botById = new Map(bots.map((b) => [b.id, b]));
    const nameOf = (id) => (id === me.id ? me.name : botById.has(id) ? botById.get(id).name : String(id || ''));

    const meAlive = () => !!alive.get(me.id) && world.localAlive;
    const players = [{ id: me.id, name: me.name, team: me.team }, ...bots.map((b) => ({ id: b.id, name: b.name, team: b.team, bot: true }))];
    const match = createMatch({
      rules: { mode: opts.mode, ruleset: rs.id, killTarget: opts.killTarget },
      players, spawns: map.spawns,
      getPositions: () => {
        const o = {};
        if (meAlive()) o[me.id] = { x: ctx.player.state.pos[0], z: ctx.player.state.pos[2] };
        for (const b of bots) if (b.alive) o[b.id] = { x: b.body.pos[0], z: b.body.pos[2] };
        return o;
      }
    });
    for (const b of bots) world.addActor({ id: b.id, name: b.name, team: b.team, kind: 'bot' });

    /* ---------- 위치·대상 ---------- */
    const eyeOf = (b) => [b.body.pos[0], b.body.pos[1] + (b.crouch ? CROUCH_EYE : PLAYER.EYE), b.body.pos[2]];
    function posOf(id) {
      if (id === me.id) return ctx.player.state.pos;
      const b = botById.get(id);
      return b ? b.body.pos : null;
    }
    /** 봇이 총을 든 채 죽으면 그 총이 바닥에 떨어진다(남은 탄 그대로). 봇은 줍지 않는다 */
    let botDropSeq = 0;
    function botDropGun(b) {
      if (!b.alive || typeof world.addDrop !== 'function') return;
      const held = b.arsenal.getWeapon();
      const def = getDef(held.id);
      if (!def || (def.slot !== 1 && def.slot !== 2)) return;
      const a = b.arsenal.getAmmo(held.id);
      if (!(a.mag > 0 || a.reserve > 0)) return;
      const [x, y, z] = b.body.pos;
      const fy = getGroundY(map.world, x, z, y + 0.5);
      world.addDrop({ id: `${b.id}#${++botDropSeq}`, weaponId: held.id, pos: [x, Number.isFinite(fy) ? fy : y, z], mag: a.mag, reserve: a.reserve });
    }
    /** 봇 b가 쏠 수 있는 대상(자기 제외, 살아 있는 모두. 팀전이면 아군 몸은 통과한다 — 보호는 match가 거른다). crouch = 앉은 히트박스 */
    function targetsFor(b) {
      const out = [];
      if (meAlive()) out.push({ id: me.id, team: me.team, pos: ctx.player.state.pos, yaw: ctx.player.state.yaw, alive: true, crouch: !!ctx.player.state.crouch });
      for (const o of bots) if (o !== b && o.alive) out.push({ id: o.id, team: o.team, pos: o.body.pos, yaw: o.yaw, alive: true, crouch: o.crouch });
      return shotTargets(out, ffa ? 'ffa' : 'team', b.team);
    }
    function botView(b) {
      const enemies = [], allies = [];
      const mine = { id: me.id, pos: ctx.player.state.pos, alive: meAlive(), team: me.team, crouch: !!ctx.player.state.crouch, protect: ffa && myProtectUntil > simMs };
      (!ffa && me.team === b.team ? allies : enemies).push(mine);
      for (const o of bots) {
        if (o === b) continue;
        const e = { id: o.id, pos: o.body.pos, alive: o.alive, team: o.team, crouch: o.crouch, protect: ffa && o.protectUntil > simMs };
        (!ffa && o.team === b.team ? allies : enemies).push(e);
      }
      const a = b.arsenal;
      return {
        self: {
          pos: b.body.pos, vel: b.body.vel, onGround: b.body.onGround, yaw: b.yaw, pitch: b.pitch, hp: b.hp, alive: b.alive, crouch: b.crouch,
          slot: a.getWeapon().slot, ammo: a.getAmmo(), weapon: a.getWeapon(), zoom: a.getZoom().progress,
          recoil: a.getRecoilKick(), grenades: a.getAmmo('gr_frag').mag
        },
        enemies, allies, nav, los
      };
    }
    function hear(origin, shooterId, team) {
      const info = ffa ? { id: shooterId } : { id: shooterId, team };
      for (const b of bots) if (b.alive && b.id !== shooterId) b.brain.hearShot(origin, info);
    }

    /* ---------- 이벤트 → 화면 ---------- */
    function aliveCounts() {
      const c = { owner: 0, charterer: 0 };
      if (alive.get(me.id)) c[me.team]++;
      for (const b of bots) if (alive.get(b.id)) c[b.team]++;
      return c;
    }
    /** 개인전 순위: 킬↓ · 데스↑ · 헤드샷↓ */
    function ffaRanking() {
      const rows = players.map((p) => ({ id: p.id, name: p.name, bot: !!p.bot, kills: kills.get(p.id) || 0, deaths: deaths.get(p.id) || 0, headshots: heads.get(p.id) || 0 }));
      rows.sort((a, b) => b.kills - a.kills || a.deaths - b.deaths || b.headshots - a.headshots);
      let rank = 0, prev = null;
      rows.forEach((r, i) => {
        if (!prev || r.kills !== prev.kills || r.deaths !== prev.deaths || r.headshots !== prev.headshots) rank = i + 1;
        r.rank = rank; prev = r;
      });
      return rows;
    }
    function pushRound() {
      const timeLeftMs = phase === 'warmup' || phase === 'matchEnd' ? null : Math.max(0, phaseEndsAt - simMs) / opts.timeScale;
      if (ffa) {
        const rows = ffaRanking();
        const mine = rows.find((r) => r.id === me.id) || { kills: 0, rank: rows.length };
        const lead = rows[0] || null;
        world.setRound({
          mode: 'ffa', phase, timeLeftMs, kills: mine.kills, rank: mine.rank, total: rows.length,
          leaderName: lead ? lead.name : '', leaderKills: lead ? lead.kills : 0, target: opts.killTarget
        });
        return;
      }
      world.setRound({
        phase, round, score, timeLeftMs,
        alive: aliveCounts(), teamSize: { owner: opts.size, charterer: opts.size },
        roundsToWin: match.rules.roundsToWin, maxRounds: match.rules.maxRounds
      });
    }
    function apply(evs) {
      if (!evs || !evs.length || disposed) return;
      for (const ev of evs) {
        try {
          switch (ev.type) {
            case 'roundStart': onRoundStart(ev); break;
            case 'phase': onPhase(ev); break;
            case 'spawn': onSpawn(ev); break;
            case 'damage': onDamage(ev); break;
            case 'kill': onKill(ev); break;
            case 'roundEnd': onRoundEnd(ev); break;
            case 'matchEnd': onMatchEnd(ev); break;
            case 'reject': if (ctx.flags && ctx.flags.debug) console.debug('[practice] reject', ev); break;
            default: break;
          }
        } catch (err) { console.error('[practice] 이벤트 처리 오류', ev && ev.type, err); }
      }
    }

    /** 경기가 정한 무기(id)를 봇이 실제로 쓸 무기로. 경기가 고르지 않는 시험용 무기(botWeapon=pt_magnum 등)는 봇 것을 그대로 쓴다 */
    function pickFor(b, id) {
      return pickIds.includes(b.pick) && pickIds.includes(id) ? id : b.pick;
    }
    function resetBot(b, s, pick) {
      placeBot(b, s);
      b.alive = true;
      b.hp = PLAYER.HP;
      alive.set(b.id, true);
      const key = loadoutKey(pick);
      b.arsenal.resetRound(key ? { [key]: pick, draw: false } : { draw: false });
      b.arsenal.update(0, {}, { speed: 0, onGround: true });
      b.cmd = IDLE; b.rateTicks = 0; b.crouch = false; b.emote = 0; b.emoteUntil = 0;
      b.edge.reload = false; b.edge.slot = null; b.edge.jump = false;
      b.trig = {}; b.padFlight = false;
      const held = b.arsenal.getWeapon();
      world.setActorState(b.id, { pos: b.body.pos, yaw: b.yaw, pitch: 0, alive: true, crouch: false, teleport: true, slot: held.slot, weaponId: held.id });
    }

    function onRoundStart(ev) {
      round = ev.round;
      if (ev.score) score = { ...ev.score };
      world.reset();
      alive.clear();
      spawnOf.clear();
      const sp = (ev.spawns && ev.spawns[me.id]) || map.spawns[me.team][0];
      spawnOf.set(me.id, sp);
      world.spawnLocal({ id: me.id, name: me.name, team: me.team, spawn: sp, loadout: lastPick });
      alive.set(me.id, true);
      for (const b of bots) {
        const s = (ev.spawns && ev.spawns[b.id]) || map.spawns[b.team][0];
        spawnOf.set(b.id, s);
        resetBot(b, s, b.pick);
        b.brain.reset();
      }
      if (ui) ui.hud.center(ev.replay ? `라운드 ${round} · 재경기` : `라운드 ${round}`, 2200, { sub: rs.pickSlot === 3 ? '칼을 고르세요' : '주무기를 고르세요' });
    }
    function placeBot(b, s) {
      const x = num(s.x, 0), z = num(s.z, 0);
      const y = Number.isFinite(s.y) ? s.y : findFloor(map.world, x, z);
      b.body.pos[0] = x; b.body.pos[1] = y; b.body.pos[2] = z;
      b.body.vel[0] = b.body.vel[1] = b.body.vel[2] = 0;
      b.body.onGround = true;
      b.yaw = num(s.rotY, 0); b.pitch = 0;
    }

    /** 개인전: 처음 출격·부활 = match 'spawn' { id, spawn, loadout, protectMs } */
    function onSpawn(ev) {
      const s = ev.spawn || {};
      const protectMs = Math.max(0, num(ev.protectMs, 0));
      spawnOf.set(ev.id, s);
      if (ev.id === me.id) {
        if (ui && ui.isVisible('loadout')) ui.hide('loadout');
        const lo = ev.loadout || lastPick;
        lastPick = lo;
        world.spawnLocal({ id: me.id, name: me.name, team: null, spawn: s, loadout: lo, protectMs: protectMs / opts.timeScale });
        myProtectUntil = simMs + protectMs;
        alive.set(me.id, true);
        return;
      }
      const b = botById.get(ev.id);
      if (!b) return;
      const lo = pickFor(b, ev.loadout);
      resetBot(b, s, lo);                       // 죽기 직전 명령(cmd)은 비운다 — 부활 직후 허공 사격 방지
      b.thinkAcc = THINK_DT;                    // 다음 틱에 바로 새로 판단
      b.protectUntil = simMs + protectMs;
      if (typeof b.brain.respawn === 'function') b.brain.respawn({ x: b.body.pos[0], y: b.body.pos[1], z: b.body.pos[2], rotY: b.yaw, loadout: lo, protectMs });
      else b.brain.reset();
      world.setActorProtect(b.id, protectMs / opts.timeScale);
    }

    function onPhase(ev) {
      phase = ev.phase;
      phaseEndsAt = simMs + num(ev.durationMs, 0);
      if (phase === 'loadout') {
        for (const b of bots) if (pickIds.includes(b.pick)) match.setLoadout(b.id, b.pick);
        if (pickIds.includes(lastPick)) match.setLoadout(me.id, lastPick);   // 고르지 않아도 지난 선택·계정 장비로 나간다
        if (ui) {
          const secs = Math.max(1, Math.floor(num(ev.durationMs, 5000) / 1000 / opts.timeScale) - 1);
          ui.show('loadout', { weapons: pickList(), ruleset: rs.id, seconds: secs, selected: lastPick, round: ffa ? undefined : round, title: ffa ? `${ruleLabel} · 무기 선택` : undefined });
        }
        if (ffa && ui) ui.hud.center(ruleLabel, 2200, { sub: `모두가 적 · 먼저 ${opts.killTarget}킬`, tone: 'warn' });
      } else if (phase === 'live') {
        if (ui && ui.isVisible('loadout')) ui.hide('loadout');
        const lo = ev.loadouts || {};
        if (lo[me.id]) { world.setLocalLoadout(lo[me.id]); lastPick = lo[me.id]; }
        if (!ffa) {
          for (const b of bots) {
            const pick = pickFor(b, lo[b.id]), key = loadoutKey(pick);
            if (key && b.arsenal.getLoadout()[key] !== pick) b.arsenal.setLoadout({ [key]: pick });
          }
        }
        world.sound('round_start');
        if (ui) ui.hud.center('작전 개시!', 1400, { sub: ffa ? `${ruleLabel} · 먼저 ${opts.killTarget}킬` : `${ruleLabel} · 라운드 ${round} · ${TEAM_NAME[me.team]} 팀` });
      } else if (phase === 'matchEnd') {
        if (ui && ui.isVisible('loadout')) ui.hide('loadout');
        world.setRespawn(null);
      }
      pushRound();
    }

    function onDamage(ev) {
      const ap = ev.center ? [ev.center.x, ev.center.y, ev.center.z] : posOf(ev.attacker);
      if (ev.victim === me.id) {
        world.setLocalHp(ev.hp);
        world.feedbackDamage({ attackerPos: ap ? ap.slice() : null, amount: ev.amount, head: !!ev.head, half: !!ev.halfShot, incoming: true });
      } else {
        const b = botById.get(ev.victim);
        if (b) { b.hp = ev.hp; endBotEmote(b); if (ap) b.brain.onDamage({ from: ap.slice(), amount: ev.amount }); }
      }
      if (ev.attacker === me.id && ev.victim !== me.id) {
        if (ev.halfShot) myHalfShots++;
        world.feedbackDamage({ amount: ev.amount, head: !!ev.head, kill: ev.hp <= 0, half: !!ev.halfShot, incoming: false });
      }
    }

    function onKill(ev) {
      if (ui) ui.killfeed.push({ killer: ev.killerName, victim: ev.victimName, weaponId: ev.weaponId, head: ev.head, killerTeam: ffa ? null : ev.killerTeam, victimTeam: ffa ? null : ev.victimTeam });
      alive.set(ev.victim, false);
      deaths.set(ev.victim, (deaths.get(ev.victim) || 0) + 1);
      const weapon = getDef(ev.weaponId);
      if (ev.killer !== ev.victim) {
        kills.set(ev.killer, (kills.get(ev.killer) || 0) + 1);
        if (ev.head) heads.set(ev.killer, (heads.get(ev.killer) || 0) + 1);
        if (ev.killer === me.id && weapon && weapon.kind === 'melee') myKnifeKills++;
      }
      const kp = posOf(ev.killer), vp = posOf(ev.victim);
      const dir = kp && vp && ev.killer !== ev.victim ? [vp[0] - kp[0], vp[2] - kp[2]] : null;
      if (ev.victim === me.id) {
        world.killLocal({ killerId: ev.killer, dir });
        if (ffa) {
          const respawnMs = num(match.rules && match.rules.respawnMs, 3000);
          world.setRespawn({ inMs: respawnMs / opts.timeScale, killer: ev.killer !== ev.victim ? ev.killerName : '', weaponName: weapon ? weapon.short || weapon.name : '' });
          if (ui) ui.show('loadout', { compact: true, weapons: pickList(), ruleset: rs.id, seconds: 0, selected: lastPick, title: '다음 부활 무기' });
        }
      } else {
        const b = botById.get(ev.victim);
        if (b) { botDropGun(b); b.alive = false; b.hp = 0; endBotEmote(b); world.actorDeath(b.id, { dir }); }
      }
      if (ffa && ev.killer !== ev.victim) { const kb = botById.get(ev.killer); if (kb && kb.alive && rng() < opts.botEmote) startBotEmote(kb); }
      pushRound();
    }

    function onRoundEnd(ev) {
      if (ev.score) score = { ...ev.score };
      const won = ev.winner === me.team;
      const text = ev.winner ? `${TEAM_NAME[ev.winner]} 팀 승리` : '무승부 — 재경기';
      const sub = `${REASON_LABELS[ev.reason] || ev.reason}${ev.final ? ' · 매치 결정' : ''} · ${score.owner} : ${score.charterer}`;
      if (ui) ui.hud.center(text, 3600, { sub, tone: ev.winner || 'warn' });
      world.sound(won ? 'round_win' : 'round_lose');
      if (ev.winner) for (const b of bots) if (b.alive && b.team === ev.winner && rng() < opts.botEmote) startBotEmote(b);
    }

    /** 경기 결과를 계정에 기록한다. 경기당 한 번뿐이다(다시 하기는 새 경기라 새로 기록한다) */
    function recordResult(ev) {
      if (recorded) return;
      recorded = true;
      const account = ctx.account;
      if (!account || typeof account.recordMatch !== 'function') return;
      const res = account.recordMatch({
        online: false, ruleset: rs.id, mode: opts.mode, mapId: opts.mapId, difficulty: opts.difficulty,
        kills: kills.get(me.id) || 0, deaths: deaths.get(me.id) || 0, headshots: heads.get(me.id) || 0,
        halfShots: myHalfShots, knifeKills: myKnifeKills,
        win: !!ev.winner && ev.winner === (ffa ? me.id : me.team), draw: !ev.winner,
        seconds: Math.round(simMs / opts.timeScale / 1000)
      });
      if (res) reward = { gained: res.gained, breakdown: res.breakdown, points: res.points };
    }

    function onMatchEnd(ev) {
      resultsEv = ev;
      resultsAt = performance.now() + 2200;
      recordResult(ev);
      if (ffa) {
        const name = ev.winner ? nameOf(ev.winner) : '';
        const text = ev.winner ? (ev.winner === me.id ? '우승!' : `${name} 우승`) : '무승부';
        if (ui) ui.hud.center(text, 0, { sub: FFA_REASON[ev.reason] || ev.reason || '', tone: 'warn' });
        world.sound(ev.winner === me.id ? 'round_win' : 'round_lose');
        return;
      }
      const text = ev.winner ? (ev.winner === me.team ? '매치 승리!' : '매치 패배') : '매치 무승부';
      if (ui) ui.hud.center(text, 0, { sub: `${TEAM_NAME.owner} ${ev.score.owner} : ${ev.score.charterer} ${TEAM_NAME.charterer}`, tone: ev.winner || 'warn' });
    }

    function showResults() {
      resultsAt = 0;
      if (!ui) return;
      if (ui.isVisible('loadout')) ui.hide('loadout');
      if (ffa) {
        const view = match.state;
        const st = standings(view) || {};
        let ranking = Array.isArray(resultsEv && resultsEv.ranking) && resultsEv.ranking.length ? resultsEv.ranking
          : Array.isArray(st.ranking) && st.ranking.length ? st.ranking : ffaRanking();
        ranking = ranking.map((r, i) => ({ rank: r.rank || i + 1, id: r.id, name: r.name || nameOf(r.id), kills: r.kills | 0, deaths: r.deaths | 0, head: (r.head ?? r.headshots) | 0, me: r.id === me.id, bot: r.bot ?? (r.id !== me.id) }));
        const winnerId = resultsEv ? resultsEv.winner || null : st.winnerId || null;
        ui.show('results', {
          mode: 'ffa', ruleset: rs.id, ranking, winnerId, winnerName: winnerId ? nameOf(winnerId) : '', reason: resultsEv ? resultsEv.reason : '',
          target: opts.killTarget, mapId: opts.mapId, meId: me.id, reward,
          backLabel: '다시 하기', lobbyLabel: '메뉴로'
        });
        return;
      }
      const view = match.state;
      const { stats, mvp } = standings(view);
      const res = view.result || {};
      ui.show('results', {
        ruleset: rs.id, reward,
        winner: res.winner || (resultsEv && resultsEv.winner) || 'draw',
        score: view.score,
        rounds: view.history.map((r) => ({ winner: r.winner || 'draw', reason: REASON_LABELS[r.reason] || r.reason })),
        players: stats.map((s) => ({ ...s, head: s.headshots, me: s.id === me.id })),
        mvp: mvp ? { id: mvp.id, name: mvp.name, team: mvp.team, kills: mvp.kills, deaths: mvp.deaths, head: mvp.headshots } : undefined,
        myTeam: me.team, mapId: opts.mapId, meId: me.id,
        backLabel: '다시 하기', lobbyLabel: '메뉴로'
      });
    }

    /* ---------- 내 판정 → match ---------- */
    offs.push(world.on('hitClaim', (c) => {
      myProtectUntil = 0;                       // 먼저 공격하면 보호 끝(match와 같은 규칙)
      apply(match.claimHit({ attackerId: me.id, victimId: c.victimId, weaponId: c.weaponId, part: c.part, dist: c.dist, kind: c.kind, count: c.count, shotId: c.shotId, t: c.t }));
    }));
    offs.push(world.on('explosion', (x) => {
      if (ffa) {                                // 수류탄도 '먼저 공격' → 던진 사람의 보호 끝(match와 같은 규칙)
        if (x.ownerId === me.id) myProtectUntil = 0;
        const ob = botById.get(x.ownerId);
        if (ob && ob.protectUntil > simMs) { ob.protectUntil = 0; world.setActorProtect(ob.id, 0); }
      }
      apply(match.claimExplosion({ attackerId: x.ownerId, center: x.center, victims: x.victims.map((v) => ({ id: v.id, dmg: v.dmg })) }));
    }));
    offs.push(world.on('fire', (f) => {
      const d = getDef(f.weaponId);
      if (!d || d.kind !== 'melee') hear(f.origin, me.id, me.team);   // 칼은 소리가 멀리 가지 않는다
    }));
    offs.push(world.on('loadoutPick', (p) => {
      if (p && p.id) { lastPick = p.id; apply(match.setLoadout(me.id, p.id)); }
    }));
    offs.push(world.on('pause', (p) => { paused = !!(p && p.paused); world.setPaused(paused); }));
    offs.push(world.on('leave', () => { ctx.setScreen('menu'); }));
    if (ui) {
      offs.push(ui.on('results:back', () => { if (!disposed) restart(); }));
      offs.push(ui.on('results:lobby', () => { if (!disposed) ctx.setScreen('menu'); }));
    }
    world.setPauseOptions({ leaveLabel: '연습장 나가기', note: '연습장은 일시정지하면 봇도 멈춰요.' });
    world.setControlsEnabled(true);
    world.setHint('');
    world.setScoreboard(() => {
      const view = match.state;
      if (ffa) {
        const rows = ffaRanking();
        const live = new Map(view.players.map((p) => [p.id, p]));
        return {
          mode: 'ffa', target: opts.killTarget, mapId: opts.mapId, meId: me.id,
          players: rows.map((r) => ({ id: r.id, name: r.name, team: null, rank: r.rank, kills: r.kills, deaths: r.deaths, head: r.headshots, ping: r.bot ? null : 0, alive: live.has(r.id) ? live.get(r.id).alive !== false : !!alive.get(r.id), me: r.id === me.id, bot: r.bot }))
        };
      }
      return {
        players: view.players.map((p) => ({ id: p.id, name: p.name, team: p.team, kills: p.kills, deaths: p.deaths, head: p.headshots, ping: p.bot ? null : 0, alive: p.alive, me: p.id === me.id, bot: p.bot })),
        score: view.score, round: view.round, mapId: opts.mapId, meId: me.id
      };
    });

    /* ---------- 봇 이모트 (MODES.md 4.4): 팀전 라운드 승리·개인전 킬 때 30%, 2~3초, 그동안 멈춤 ---------- */
    function startBotEmote(b) {
      const list = world.emotes || [];
      if (!list.length) return false;
      const e = list[Math.floor(rng() * list.length)];
      b.emote = e.code;
      b.emoteUntil = simMs + 2000 + rng() * 1000;
      b.cmd = IDLE; b.rateTicks = 0;
      b.body.vel[0] = 0; b.body.vel[2] = 0;
      return true;
    }
    function endBotEmote(b) { b.emote = 0; b.emoteUntil = 0; }

    /* ---------- 봇 시뮬레이션 ---------- */
    const wish = { x: 0, z: 0, jump: false };
    function stepBot(b, dt) {
      if (!b.alive) return;
      const live = phase === 'live';
      if (b.emote && simMs >= b.emoteUntil) endBotEmote(b);
      if (live) {
        b.thinkAcc += dt;
        if (b.thinkAcc >= THINK_DT - 1e-6) {
          const tdt = Math.min(0.1, b.thinkAcc);
          b.thinkAcc = 0;
          let out = IDLE;
          try { out = b.brain.think(tdt, botView(b)) || IDLE; } catch (err) { console.error('[practice] bot think', err); }
          if (b.emote) {
            // 이모트 중: 멈춰 있는다. 적이 보이면(두뇌의 표적) 바로 취소하고 이번 판단부터 따른다
            let seen = false;
            try { const d = b.brain.debug(); seen = !!(d && d.target != null); } catch (err) { seen = false; }
            if (seen) endBotEmote(b); else out = IDLE;
          }
          b.cmd = out;
          const n = Math.max(1, Math.round(tdt / dt));
          b.yawRate = num(out.yawDelta, 0) / n;
          b.pitchRate = num(out.pitchDelta, 0) / n;
          b.rateTicks = n;
          if (out.reload) b.edge.reload = true;
          if (out.slot) b.edge.slot = out.slot;
          if (out.jump) b.edge.jump = true;
        }
      } else if (b.cmd !== IDLE) { b.cmd = IDLE; b.rateTicks = 0; }
      // 시점: 판단 사이 틱에 나눠서 돈다(부드럽게)
      if (b.rateTicks > 0) {
        b.yaw += b.yawRate;
        b.pitch = clamp(b.pitch + b.pitchRate, -PITCH_LIMIT, PITCH_LIMIT);
        b.rateTicks--;
      }
      if (b.yaw > Math.PI * 4 || b.yaw < -Math.PI * 4) b.yaw %= Math.PI * 2;
      // 이동 (점프 초속은 core PLAYER.JUMP_V — moveCharacter 기본값)
      const c = b.cmd;
      const a = b.arsenal;
      // 앉기(봇 출력 crouch, 선택): 키 1.25 m·2.6 m/s. 머리 위가 막혀 있으면 앉은 채, 앉은 채 점프는 일어설 수 있을 때만
      const room = () => !overlapsCapsule(map.world, b.body.pos[0], b.body.pos[1], b.body.pos[2], PLAYER.RADIUS, PLAYER.HEIGHT);
      const wantCrouch = live && !!c.crouch && !b.edge.jump;
      if (wantCrouch && !b.crouch) b.crouch = true;
      else if (!wantCrouch && b.crouch && room()) b.crouch = false;
      if (b.edge.jump && b.crouch) b.edge.jump = false;
      const speed = (b.crouch ? CROUCH_SPEED : c.walk ? PLAYER.SLOW_WALK : PLAYER.WALK) * a.getMoveMul();
      let f = clamp(num(c.forward, 0), -1, 1), s = clamp(num(c.strafe, 0), -1, 1);
      const len = Math.hypot(f, s);
      if (len > 1) { f /= len; s /= len; }
      const sy = Math.sin(b.yaw), cy = Math.cos(b.yaw);
      wish.x = (-sy * f + cy * s) * speed;
      wish.z = (-cy * f - sy * s) * speed;
      wish.jump = live && b.edge.jump && b.body.onGround;
      b.edge.jump = false;
      // 발판으로 날아가는 동안에는 입력을 넣지 않는다(공중 조작이 궤적을 깎아 착지점을 놓친다)
      if (b.padFlight) { if (b.body.onGround) b.padFlight = false; else { wish.x = 0; wish.z = 0; } }
      moveCharacter(map.world, b.body, wish, dt, b.crouch ? { height: CROUCH_H } : undefined);
      // 봇도 발판을 탄다. 비밀 스팟과 포털은 사람 몫이라 결과를 쓰지 않는다
      if (map.world.triggers) {
        const fired = stepTriggers(map.world, b.body, b.crouch ? CROUCH_H : PLAYER.HEIGHT, b.trig, dt);
        if (fired.pad) {
          // 목표가 있거나 옆으로 보내는 발판은 궤적을 그대로 탄다. 제자리 발판(수직 발사)은 공중에서 움직여 벗어난다
          b.padFlight = !!fired.pad.target || Math.hypot(b.body.vel[0], b.body.vel[2]) > 1;
          b.brain.onLaunch();
          world.sound('pad_boost', { pos: [b.body.pos[0], b.body.pos[1], b.body.pos[2]] });
        }
      }
      if (b.body.pos[1] < -30) placeBot(b, spawnOf.get(b.id) || map.spawns[b.team || 'owner'][0]);
      // 무기
      const hs = Math.hypot(b.body.vel[0], b.body.vel[2]);
      const wi = {
        fireDown: live && !!c.fire, zoomDown: live && !!c.zoom,
        reloadPressed: b.edge.reload, slot: b.edge.slot, wheel: 0
      };
      b.edge.reload = false; b.edge.slot = null;
      const evs = a.update(dt, wi, { speed: hs, onGround: b.body.onGround, walking: !!c.walk, crouch: b.crouch });
      for (const ev of evs) botWeaponEvent(b, ev);
      if (b.alive) {
        const held = a.getWeapon();
        world.setActorState(b.id, { pos: b.body.pos, yaw: b.yaw, pitch: b.pitch, alive: true, moving: hs > 0.3, walking: !!c.walk, crouch: b.crouch, emote: b.emote, onGround: b.body.onGround, hp: b.hp, slot: held.slot, weaponId: held.id });
      }
    }

    function botClaim(b, claim) {
      if (ffa && b.protectUntil > simMs) { b.protectUntil = 0; world.setActorProtect(b.id, 0); }   // 먼저 공격하면 보호 끝
      apply(match.claimHit(claim));
    }
    /** 봇의 한 발: 펠릿을 모두 트레이스하고 맞은 사람마다 주장을 하나 낸다(World의 내 사격과 같은 규칙) */
    function botFire(b, ev) {
      const e = eyeOf(b);
      const def = getDef(ev.weaponId);
      const range = num(ev.maxRange, def ? def.maxRange : 250);
      const pellets = ev.pellets && ev.pellets.length ? ev.pellets.length : 1;
      const list = targetsFor(b);
      const byVictim = new Map();
      let shown = null;   // 연출에 쓸 펠릿: 사람을 맞힌 첫 펠릿, 없으면 첫 펠릿
      for (let i = 0; i < pellets; i++) {
        const dv = shotDirection(b.yaw, b.pitch, ev, i);
        const d = [dv[0], dv[1], dv[2]];
        const hit = traceShot(map.world, e, d, range, list);
        if (!shown || (hit.kind === 'player' && shown.hit.kind !== 'player')) shown = { hit, d };
        if (hit.kind !== 'player') continue;
        const v = byVictim.get(hit.id);
        if (!v) byVictim.set(hit.id, { hit, count: 1 });
        else {
          v.count++;
          if (PART_ORDER.indexOf(hit.part) < PART_ORDER.indexOf(v.hit.part)) v.hit = hit;
        }
      }
      const { hit, d } = shown;
      world.actorFire({
        id: b.id, weaponId: ev.weaponId, origin: e, dir: d,
        hitPoint: hit.kind === 'none' ? null : hit.point, hitKind: hit.kind,
        victimId: hit.kind === 'player' ? hit.id : undefined, normal: hit.normal, mat: hit.mat
      });
      hear(e, b.id, b.team);
      const shotId = ++b.shotSeq;
      for (const [victimId, v] of byVictim) {
        botClaim(b, { attackerId: b.id, victimId, weaponId: ev.weaponId, part: v.hit.part, dist: v.hit.dist, count: v.count, shotId });
      }
    }
    function botWeaponEvent(b, ev) {
      switch (ev.type) {
        case 'fire': botFire(b, ev); break;
        case 'swing': world.actorFire({ id: b.id, weaponId: ev.weaponId, origin: eyeOf(b), dir: dirFromYawPitch(b.yaw, b.pitch), kind: ev.kind }); break;
        case 'melee': {
          const e = eyeOf(b);
          const hit = meleeTrace(map.world, e, dirFromYawPitch(b.yaw, b.pitch), num(ev.range, 1.8), num(ev.arc, 0.6), targetsFor(b), b.id);
          if (hit) {
            const def = getDef(ev.weaponId);
            if (def && def.hitSound) world.sound(def.hitSound, { pos: hit.point });
            botClaim(b, { attackerId: b.id, victimId: hit.id, weaponId: ev.weaponId, dist: hit.dist, kind: ev.kind, count: 1, shotId: ++b.shotSeq });
          }
          break;
        }
        case 'throw': {
          const e = eyeOf(b);
          const f = dirFromYawPitch(b.yaw, b.pitch);
          let start = [e[0] + f[0] * 0.3, e[1] + f[1] * 0.3 - 0.06, e[2] + f[2] * 0.3];
          if (!lineOfSight(map.world, e, start)) start = e;
          const v = throwVelocity(f, ev.speed, ev.pitchUp, b.body.vel, 0.5);
          world.actorGrenade({ id: b.id, pos: start, vel: [v[0], v[1], v[2]], fuse: ev.fuse });
          break;
        }
        case 'prime': world.sound('grenade_pin', { pos: eyeOf(b) }); break;
        case 'reloadStart': world.sound('reload_mag_out', { pos: eyeOf(b) }); break;
        case 'boltCycle': world.sound('bolt', { pos: eyeOf(b) }); break;
        default: break;
      }
    }

    function step(dt) {
      simMs += dt * 1000;
      apply(match.tick(dt * 1000));
      if (disposed) return;
      for (const b of bots) stepBot(b, dt);
      if (++stepCount % 6 === 0) pushRound();
    }
    const stats = { ticks: 0, ms: 0, maxMs: 0 };   // 봇·경기 시뮬레이션 비용(성능 확인용)
    offs.push(ctx.onTick((dt) => {
      if (disposed) return;
      if (resultsAt && performance.now() >= resultsAt) showResults();
      if (paused) return;
      const t0 = performance.now();
      for (let i = 0; i < opts.timeScale && !disposed; i++) step(dt);
      const ms = performance.now() - t0;
      stats.ticks++; stats.ms += ms; if (ms > stats.maxMs) stats.maxMs = ms;
    }, -80));

    /* ---------- 시작 ---------- */
    if (ffa) {
      // 출격 전에는 아무도 맵에 없다(처음 'spawn'으로 나온다). 나는 로드아웃 동안 임시 위치에서 카메라만 둔다
      for (const b of bots) { alive.set(b.id, false); world.setActorState(b.id, { pos: [0, -50, 0], yaw: 0, alive: false }); }
      world.reset();
      const s0 = (map.spawns.owner && map.spawns.owner[0]) || { x: 0, z: 0, rotY: 0 };
      world.spawnLocal({ id: me.id, name: me.name, team: null, spawn: s0, loadout: lastPick });
    }
    apply(match.start());

    const r = {
      opts, info, match, bots,
      get mode() { return ffa ? 'ffa' : 'team'; },
      get lastPick() { return lastPick; },
      get phase() { return phase; },
      get round() { return round; },
      get score() { return { ...score }; },
      get ranking() { return ffa ? ffaRanking() : null; },
      get paused() { return paused; },
      get stats() { return { ticks: stats.ticks, avgMs: stats.ticks ? +(stats.ms / stats.ticks).toFixed(3) : 0, maxMs: +stats.maxMs.toFixed(2) }; },
      dispose() {
        if (disposed) return;
        disposed = true;
        offs.forEach((o) => { try { o(); } catch (e) { /* ignore */ } });
        offs.length = 0;
        world.setScoreboard(null);
        world.setPaused(false);
        world.setPauseOptions({});
        world.setRespawn(null);
        world.setRound({ phase: null, timeLeftMs: null });
        for (const b of bots) { world.removeActor(b.id); b.brain.dispose(); b.arsenal.dispose(); }
        match.dispose();
      }
    };
    return r;
  }

  return {
    enter, exit, restart,
    get run() { return run; },
    get active() { return !!run; }
  };
}

/* ============================================================ 시작 설정 시트 (규칙 · 모드 · 맵 · 인원 · 난이도) */

/**
 * 메뉴의 연습장을 누르면 여는 설정 시트(규칙 → 모드 → 맵 → 인원 → 난이도). UI 모듈의 부품(sheet·mapCard·sk-seg)을 그대로 쓴다.
 * @param {{ ui, maps, onStart:(opts)=>void }} o
 */
export function createPracticeSetup({ ui, maps, onStart }) {
  const modal = createModal();
  ui.el.append(modal.el);
  let sel = loadPrefs();

  function field(label, control) {
    const lab = h('span', { class: 'sk-field-label', text: label });
    return { el: h('div', { class: 'sk-field' }, lab, control), lab };
  }
  function seg(items, key, label, onChange) {
    const box = h('div', { class: 'sk-seg', role: 'radiogroup', 'aria-label': label });
    const draw = () => box.replaceChildren(...items().map(([v, text]) => btn(text, () => { sel[key] = v; draw(); if (onChange) onChange(); },
      'sk-seg-btn' + (sel[key] === v ? ' is-on' : ''), { role: 'radio', 'aria-checked': sel[key] === v ? 'true' : 'false' })));
    draw();
    box.redraw = draw;
    return box;
  }

  function build() {
    const mapBox = h('div', { class: 'sk-mapcards', role: 'radiogroup', 'aria-label': '맵 선택' });
    const drawMaps = () => mapBox.replaceChildren(...mapsFor(maps, sel.ruleset).map((m) => mapCard(m, { selected: m.id === sel.mapId, onPick: (id) => { sel.mapId = id; drawMaps(); } })));
    sel.mapId = validMapFor(maps, sel.ruleset, sel.mapId);
    drawMaps();
    // 규칙을 바꾸면 그 규칙의 대표 맵으로 옮긴다
    const ruleHint = h('p', { class: 'sk-field-hint' });
    const drawRuleHint = () => { ruleHint.textContent = rulesetOf(sel.ruleset).desc; };
    drawRuleHint();
    const onRuleChange = () => {
      sel.mapId = validMapFor(maps, sel.ruleset, RULESET_MAP[sel.ruleset]);
      drawMaps();
      drawRuleHint();
    };
    const ruleBox = seg(() => RULESET_IDS.map((id) => [id, RULESETS[id].name]), 'ruleset', '규칙', onRuleChange);
    // 인원: 팀전 = 팀당 1~4명, 개인전 = 봇 1~7명(나까지 최대 8명)
    const countKey = () => (sel.mode === 'ffa' ? 'ffaBots' : 'size');
    const countItems = () => (sel.mode === 'ffa'
      ? [1, 2, 3, 4, 5, 6, 7].map((n) => [n, `봇 ${n}`])
      : [[1, '1 vs 1'], [2, '2 vs 2'], [3, '3 vs 3'], [4, '4 vs 4']]);
    const countBox = h('div', { class: 'sk-seg', role: 'radiogroup', 'aria-label': '인원' });
    const drawCount = () => {
      const key = countKey();
      countBox.replaceChildren(...countItems().map(([v, text]) => btn(text, () => { sel[key] = v; drawCount(); },
        'sk-seg-btn' + (sel[key] === v ? ' is-on' : ''), { role: 'radio', 'aria-checked': sel[key] === v ? 'true' : 'false' })));
    };
    drawCount();
    const count = field('', countBox);
    const hint = h('p', { class: 'sk-field-hint' });
    const drawMode = () => {
      count.lab.textContent = sel.mode === 'ffa' ? '봇 수 (나 + 봇, 최대 8명)' : '인원 (나 + 봇)';
      hint.textContent = sel.mode === 'ffa'
        ? '개인전 · 모두가 적 · 먼저 20킬(5분) · 죽으면 3초 뒤 부활(1.5초 보호). Esc로 일시정지.'
        : '5판 3선승 · 라운드 2분 · 나와 아군 봇은 블루 팀, 적 봇은 오렌지 팀이에요. Esc로 일시정지.';
      drawCount();
    };
    const modeBox = seg(() => [['team', MODE_NAME.team], ['ffa', MODE_NAME.ffa]], 'mode', '모드', drawMode);
    drawMode();
    const start = btn('출격', () => {
      savePrefs(sel);
      modal.close();
      onStart({ mapId: sel.mapId, mode: sel.mode, ruleset: sel.ruleset, size: sel.size, bots: sel.ffaBots, difficulty: sel.difficulty });
    }, 'sk-btn--primary', { 'data-autofocus': '' });
    return sheet({
      title: '연습장 · 봇전',
      body: [
        field('규칙', ruleBox).el,
        ruleHint,
        field('모드', modeBox).el,
        field('맵', mapBox).el,
        count.el,
        field('봇 난이도', seg(() => [['easy', '쉬움'], ['normal', '보통'], ['hard', '어려움']], 'difficulty', '난이도')).el,
        hint
      ],
      foot: [btn('취소', () => modal.close(), 'sk-btn--ghost'), start],
      onClose: () => modal.close()
    });
  }

  return {
    open() {
      sel = loadPrefs();
      modal.open(build());
    },
    close() { modal.close(); },
    get isOpen() { return modal.isOpen; },
    dispose() { modal.close(); modal.el.remove(); }
  };
}

export default createPractice;
