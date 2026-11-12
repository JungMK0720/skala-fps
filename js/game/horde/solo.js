/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 혼자 하는 좀비 물량 막기(연습장). 이 탭에서 방장 시뮬레이션(director.js)을 돌리고 그 스냅샷을 화면 쪽(client.js)에 넘긴다.
 *          멀티 방장과 같은 길(스냅샷 → 뷰 → World·HUD)을 써서 혼자 해 본 것이 여럿이 할 때와 같게 보인다. 일시정지하면 좀비도 멈춘다.
 */
import { createHorde, applyHordeSnapshot, hordeSummary } from './director.js';
import { createHordeClient, hordeScoreboard } from './client.js';
import { cardById, TIERS } from './cards.js';
import { getDef, DEFAULT_LOADOUT } from '../../weapons/defs.js';
import { isWeaponAllowed } from '../modes.js';

const PUSH_MS = 50;                       // 혼자일 때 화면에 스냅샷을 넘기는 간격(20 Hz)
const SOLO_RULES = Object.freeze({ cardMs: 10 * 60 * 1000 });   // 혼자일 때는 카드 고르기에 시간 제한을 두지 않는다(10분)

/** 고른 카드 목록 → 결과 화면 칸 [{ id, name, icon, color, n, desc }] (같은 카드는 묶는다) */
export function cardRows(ids) {
  const m = new Map();
  for (const id of ids || []) {
    const c = cardById(id);
    if (!c) continue;
    const r = m.get(c.id) || { id: c.id, name: c.name, icon: c.icon, color: TIERS[c.tier].color, desc: c.desc, n: 0 };
    r.n++;
    m.set(c.id, r);
  }
  return [...m.values()];
}

/**
 * @param {{ ctx, world, ui, opts, info, nav, onRestart: () => void }} o
 *   opts = practiceOptions 결과(+ startStage, seed), info = world.loadMap 결과, nav = 맵 내비 그리드
 */
export function startHordeSolo(o) {
  const { ctx, world, ui, opts, info, nav } = o;
  const map = info.map;
  const me = { id: world.localId, name: (ctx.session && ctx.session.name) || '나' };
  const offs = [];
  let disposed = false, paused = false, pushAt = 0, pending = [], over = null, recorded = null;
  const timeScale = Math.max(1, opts.timeScale | 0 || 1);
  const pick = () => {
    const lo = ctx.account && ctx.account.loadout;
    const id = lo && lo.primary;
    return id && getDef(id) && isWeaponAllowed('classic', id) ? id : DEFAULT_LOADOUT.primary;
  };
  const director = createHorde({
    players: [{ id: me.id, name: me.name }], world: map.world, nav, spawns: map.spawns, seed: opts.seed || undefined,
    startStage: opts.startStage || 1, rules: { ...SOLO_RULES, ...(opts.hordeRules || {}) },
    getPositions: () => (world.localAlive ? { [me.id]: ctx.player.state.pos } : {})
  });
  const client = createHordeClient({
    world, ui, meId: me.id, myName: () => me.name, loadout: pick, solo: true, input: ctx.input,
    actions: {
      pick: (id) => queue(director.cardAction(me.id, 'pick', id), true),
      reroll: () => queue(director.cardAction(me.id, 'reroll'), true)
    },
    onOver: (v) => showResults(v)
  });

  /** 이벤트를 모았다가 다음 스냅샷과 함께 넘긴다. now면 바로 넘긴다 */
  function queue(evs, now) {
    if (!evs || !evs.length) return;
    for (const e of evs) if (e && e.type !== 'reject') pending.push(e);
    if (now) flush();
  }
  function flush() {
    if (disposed) return;
    const view = applyHordeSnapshot(director.snapshot());
    const evs = pending;
    pending = [];
    client.apply(view, evs, performance.now());
    pushAt = performance.now();
    if (view && view.over) over = view;
  }

  function showResults(v) {
    if (disposed || !ui) return;
    const view = v || client.view;
    const sum = hordeSummary(view, me.id);
    if (!recorded && ctx.account && typeof ctx.account.recordZombie === 'function') {
      recorded = ctx.account.recordZombie({
        online: false, stage: sum.stage, cleared: sum.cleared, bossKills: sum.bossKills, kills: sum.kills, headshots: sum.heads,
        seconds: Math.round(sum.ms / 1000 / timeScale)
      });
    }
    const mine = view.players.find((p) => p.id === me.id);
    ui.show('results', {
      mode: 'zombie', stage: sum.stage, cleared: sum.cleared, ms: sum.ms / timeScale, mapId: opts.mapId, meId: me.id,
      best: recorded ? recorded.best : 0, newBest: !!(recorded && recorded.newBest),
      reward: recorded ? { gained: recorded.gained, breakdown: recorded.breakdown, points: recorded.points } : null,
      cards: cardRows(mine ? mine.cards : []),
      players: view.players.map((p) => ({ id: p.id, name: p.name, kills: p.kills, head: p.heads, boss: p.bossKills, damage: p.damage, downs: p.downs, cards: p.cards.length, me: p.id === me.id })),
      backLabel: '다시 하기', lobbyLabel: '메뉴로'
    });
  }

  /* ---------- 내 판정 → 시뮬레이션 ---------- */
  offs.push(world.on('hitClaim', (c) => {
    if (!c || String(c.victimId)[0] !== 'z') return;
    queue(director.claimHit({ attackerId: me.id, victimId: c.victimId, weaponId: c.weaponId, part: c.part, dist: c.dist, kind: c.kind, count: c.count, shotId: c.shotId }));
  }));
  offs.push(world.on('explosion', (x) => {
    if (!x) return;
    queue(director.claimExplosion({ attackerId: x.ownerId, center: x.center, victims: (x.victims || []).map((v) => ({ id: v.id, dmg: v.dmg })) }));
  }));
  offs.push(world.on('pause', (p) => { paused = !!(p && p.paused); world.setPaused(paused); }));
  offs.push(world.on('leave', () => ctx.setScreen('menu')));
  if (ui) {
    offs.push(ui.on('results:back', () => { if (!disposed && o.onRestart) o.onRestart(); }));
    offs.push(ui.on('results:lobby', () => { if (!disposed) ctx.setScreen('menu'); }));
  }
  world.setPauseOptions({ leaveLabel: '연습장 나가기', note: '혼자 하는 좀비 물량 막기는 일시정지하면 좀비도 멈춰요.' });
  world.setControlsEnabled(true);
  world.setHint('');
  world.setScoreboard(() => hordeScoreboard(client.view, me.id, { meta: { mapId: opts.mapId } }));

  /* ---------- 루프 ---------- */
  const stats = { ticks: 0, ms: 0, maxMs: 0 };
  offs.push(ctx.onTick((dt) => {
    if (disposed || paused) return;
    const t0 = performance.now();
    queue(director.tick(dt * 1000 * timeScale));
    if (pending.length || performance.now() - pushAt >= PUSH_MS) flush();
    const ms = performance.now() - t0;
    stats.ticks++; stats.ms += ms; if (ms > stats.maxMs) stats.maxMs = ms;
  }, -80));
  offs.push(ctx.onFrame((dt) => { if (!disposed && !paused) client.frame(dt); }, -45));

  queue(director.start(), true);

  return {
    opts, info, director, client,
    /** 연습장 공용 이름(시험 도구가 경기 메서드를 감싼다). 좀비 시뮬레이션은 match.js와 같은 메서드를 가진다 */
    match: director,
    bots: [],
    get mode() { return 'zombie'; },
    get phase() { return director.phase; },
    get stage() { return director.stage; },
    get paused() { return paused; },
    get over() { return !!over; },
    get stats() { return { ticks: stats.ticks, avgMs: stats.ticks ? +(stats.ms / stats.ticks).toFixed(3) : 0, maxMs: +stats.maxMs.toFixed(2) }; },
    /** 시험용: 지금 스냅샷을 바로 화면에 넘긴다 */
    flush,
    dispose() {
      if (disposed) return;
      disposed = true;
      offs.forEach((f) => { try { f(); } catch (e) { /* ignore */ } });
      offs.length = 0;
      client.dispose();
      director.dispose();
      world.setScoreboard(null);
      world.setPaused(false);
      world.setPauseOptions({});
      world.setRound({ phase: null, timeLeftMs: null });
    }
  };
}
