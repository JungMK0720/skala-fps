/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 플레이 테스트 시나리오의 공용 도구. 페이지에 넣는 시험용 도우미(window.__qa), 검사 기록기, 게임 열기·포인터 잠금·조준 같은 동작을 둔다.
 */
import { join } from 'node:path';
import { WEAPON_IDS } from '../../js/weapons/defs.js';

export const NICK = '테스터';
export const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/** 페이지 안에서 도는 코드. 글자로 옮겨지므로 바깥 변수를 쓰지 않는다 */
function pageSetup(opts) {
  // 탄퍼짐을 고정할 수 있게 Math.random을 감싼다. 무기 모듈이 함수를 붙잡아 두므로 게임 코드보다 먼저 감싸야 한다
  const realRandom = Math.random;
  window.__qaRng = null;
  Math.random = () => (window.__qaRng ? window.__qaRng() : realRandom());
  try {
    if (!localStorage.getItem('skalafps.qa.seed')) {
      localStorage.setItem('skalafps.qa.seed', '1');
      if (opts.profile) localStorage.setItem('skalafps.profile.v1', JSON.stringify({ v: 2, profile: opts.profile, sync: { dirty: false, pendingClaim: null } }));
      if (opts.settings) localStorage.setItem('skalafps.settings.v1', JSON.stringify(opts.settings));
    }
  } catch (err) { /* 저장소 없는 페이지 */ }

  const IDLE = Object.freeze({ forward: 0, strafe: 0, jump: false, walk: false, yawDelta: 0, pitchDelta: 0, fire: false, zoom: false, reload: false, slot: null });
  const BUS_EVENTS = new Set(['player:jump', 'player:land', 'player:pad', 'player:portal', 'player:secret', 'player:fell', 'player:spawn', 'player:death', 'input:inspect', 'screen:change', 'app:error', 'map:error', 'screen:unavailable', 'account:change']);
  const WORLD_EVENTS = ['fire', 'hitClaim', 'explosion', 'grenade', 'localDeath', 'loadoutPick', 'pause', 'leave', 'multiKill'];
  const MATCH_EVENTS = new Set(['damage', 'kill', 'reject', 'roundStart', 'roundEnd', 'matchEnd', 'spawn', 'phase', 'bomb']);
  const plain = (o) => {
    const out = {};
    for (const k of Object.keys(o || {})) {
      const v = o[k];
      if (v === null || typeof v !== 'object') out[k] = v;
      else if (Array.isArray(v) && v.length <= 8 && v.every((x) => typeof x !== 'object')) out[k] = v.slice();
    }
    return out;
  };

  const qa = {
    bus: [], worldEvents: [], match: [], weaponEvents: [],
    get ctx() { return window.__skalafps || null; },
    get game() { const c = qa.ctx; const p = c && c.plugins.find((x) => x.name === 'game'); return p ? p.api : null; },
    get ui() { const g = qa.game; return g ? g.ui : null; },
    get world() { const g = qa.game; return g ? g.world : null; },
    get practice() { const g = qa.game; return g ? g.practice : null; },
    get run() { const p = qa.practice; return p ? p.run : null; },
    get arsenal() { return qa.world.internals.arsenal; },
    get props() { return qa.world.internals.props; },
    watched: false, hooked: null, timer: 0,

    /** 버스·월드·경기 이벤트를 기록하기 시작한다 */
    watch() {
      if (qa.watched || !qa.ctx || !qa.world) return !!qa.watched;
      qa.watched = true;
      qa.ctx.bus.on('*', (evt, data) => {
        if (!BUS_EVENTS.has(evt)) return;
        const entry = { evt, at: performance.now() };
        if (data && data.pos) entry.pos = Array.from(data.pos);
        if (data && data.hopped !== undefined) entry.hopped = data.hopped;
        if (data && data.pad) entry.pad = data.pad.index;
        if (data && data.portal) entry.portal = data.portal.index;
        if (data && data.secret) entry.secret = data.secret.id;
        if (data && data.message) entry.message = data.message;
        if (data && data.to) entry.to = data.to;
        qa.bus.push(entry);
      });
      for (const evt of WORLD_EVENTS) qa.world.on(evt, (data) => { qa.worldEvents.push({ evt, at: performance.now(), ...plain(data) }); });
      // 무기 이벤트는 틱 안에서 나고 사라지므로 arsenal.update 결과를 그대로 적어 둔다
      const arsenal = qa.arsenal, update = arsenal.update;
      arsenal.update = (...args) => {
        const evs = update.apply(arsenal, args);
        for (const ev of evs) qa.weaponEvents.push({ ...plain(ev), at: performance.now() });
        return evs;
      };
      qa.timer = setInterval(qa.hookRun, 100);
      qa.hookRun();
      return true;
    },
    /** 새 경기가 시작되면 경기 메서드의 결과 이벤트를 기록한다 */
    hookRun() {
      const run = qa.run;
      if (!run || qa.hooked === run) return;
      qa.hooked = run;
      const m = run.match;
      for (const name of ['tick', 'claimHit', 'claimExplosion', 'setLoadout', 'bombIntent']) {
        const fn = m[name];
        m[name] = (...args) => {
          const evs = fn.apply(m, args);
          for (const ev of evs || []) if (ev && MATCH_EVENTS.has(ev.type)) qa.match.push({ at: performance.now(), ...plain(ev) });
          return evs;
        };
      }
    },
    busCount(evt) { return qa.bus.filter((e) => e.evt === evt).length; },
    worldCount(evt) { return qa.worldEvents.filter((e) => e.evt === evt).length; },
    clearLogs() { qa.bus.length = 0; qa.worldEvents.length = 0; qa.match.length = 0; qa.weaponEvents.length = 0; },

    /** 봇의 움직임을 기록한다: 다닌 거리, 가장 낮은 높이, 벽에 박힌 시간, 가장 오래 제자리에 있던 시간, 발판 비행 */
    trackBots() {
      if (qa.trackOff) qa.trackOff();
      const stats = qa.botStats = {};
      let n = 0;
      qa.trackOff = qa.ctx.onTick(() => {
        const run = qa.run;
        if (!run || run.phase !== 'live') return;
        n++;
        if (n % 10 === 0 && qa.world.localAlive) {
          const p = qa.ctx.player.state.pos;
          const me = stats.me || (stats.me = { dist: 0, minY: Infinity, solid: 0, samples: 0, still: 0, stillMax: 0, flights: 0, weapon: 'player', human: true });
          if (p[1] < me.minY) me.minY = p[1];
          me.samples++;
          if (qa.ctx.physics.overlapsCapsule(qa.ctx.world, p[0], p[1] + 0.05, p[2], 0.25, 1.6)) me.solid++;
        }
        for (const b of run.bots) {
          const s = stats[b.id] || (stats[b.id] = { dist: 0, minY: Infinity, solid: 0, samples: 0, still: 0, stillMax: 0, flights: 0, wasFlight: false, last: null, weapon: b.pick });
          if (!b.alive) { s.last = null; s.still = 0; continue; }
          const p = b.body.pos;
          if (p[1] < s.minY) s.minY = p[1];
          if (b.padFlight && !s.wasFlight) s.flights++;
          s.wasFlight = !!b.padFlight;
          if (s.last) {
            const d = Math.hypot(p[0] - s.last[0], p[2] - s.last[2]);
            if (d < 2) s.dist += d;
            if (d < 0.002) { s.still += 1 / 60 * run.opts.timeScale; if (s.still > s.stillMax) s.stillMax = s.still; } else s.still = 0;
          }
          s.last = [p[0], p[1], p[2]];
          if (n % 10 === 0) {
            s.samples++;
            if (qa.ctx.physics.overlapsCapsule(qa.ctx.world, p[0], p[1] + 0.05, p[2], 0.25, 1.6)) s.solid++;
          }
        }
      }, 900);
      return true;
    },

    /** 봇을 움직이지도 쏘지도 않는 표적으로 만든다. team을 주면 그 팀 봇만 */
    freezeBots(team) {
      let n = 0;
      for (const b of qa.run.bots) {
        if (team && b.team !== team) continue;
        if (!b.brain.__think) b.brain.__think = b.brain.think;
        b.brain.think = () => IDLE; b.cmd = IDLE; b.yawRate = 0; b.pitchRate = 0; b.rateTicks = 0;
        n++;
      }
      return n;
    },
    /** freezeBots를 되돌린다. team을 주면 그 팀 봇만 */
    unfreezeBots(team) {
      let n = 0;
      for (const b of qa.run.bots) {
        if ((team && b.team !== team) || !b.brain.__think) continue;
        b.brain.think = b.brain.__think;
        delete b.brain.__think;
        n++;
      }
      return n;
    },
    /** 이 자리가 발판·포털에서 떨어져 있는가. 발판 위에 세우면 플레이어나 표적이 날아가 버린다 */
    clearOfTriggers(x, z, margin = 1.5) {
      const trig = qa.ctx.world.triggers;
      return ![...trig.pads, ...trig.portals].some((p) => x > p.minX - margin && x < p.maxX + margin && z > p.minZ - margin && z < p.maxZ + margin);
    },
    /** 플레이어를 옮긴다. yaw(라디안)를 주면 그쪽을 본다 */
    teleport(x, y, z, yaw) {
      const s = qa.ctx.player.state;
      s.pos[0] = x; s.pos[1] = y; s.pos[2] = z;
      s.vel[0] = 0; s.vel[1] = 0; s.vel[2] = 0;
      s.onGround = false;
      if (yaw != null) s.yaw = yaw;
      s.pitch = 0;
    },
    /** 봇을 옮기고 서 있게 한다 */
    placeBot(index, x, y, z, yaw = 0) {
      const b = qa.run.bots[index];
      b.body.pos[0] = x; b.body.pos[1] = y; b.body.pos[2] = z;
      b.body.vel[0] = 0; b.body.vel[1] = 0; b.body.vel[2] = 0;
      b.yaw = yaw;
      qa.world.setActorState(b.id, { pos: b.body.pos, yaw, pitch: 0, alive: true, teleport: true });
    },
    /** 부위의 월드 좌표. 봇의 위치와 방향은 화면 위치(avatars)를 쓴다 */
    partPoint(botId, part, handIndex = 0) {
      const t = qa.ctx.avatars.getTargets().find((x) => x.id === botId);
      if (!t) return null;
      const H = qa.ctx.consts.HITBOX;
      const local = (lx, ly, lz) => {
        // 판정은 월드 → 로컬을 (x·cos − z·sin, x·sin + z·cos)로 한다. 그 역회전이다
        const cs = Math.cos(t.yaw || 0), sn = Math.sin(t.yaw || 0);
        return [t.pos[0] + lx * cs + lz * sn, t.pos[1] + ly, t.pos[2] - lx * sn + lz * cs];
      };
      switch (part) {
        case 'head': return [t.pos[0], t.pos[1] + H.HEAD.y, t.pos[2]];
        // 가슴 한가운데. 앞에 총을 쥔 손이 있어도 몸통으로 판정되어야 한다
        case 'body': return [t.pos[0], t.pos[1] + (H.BODY.y0 + H.BODY.y1) / 2, t.pos[2]];
        case 'legs': return [t.pos[0], t.pos[1] + (H.LEGS.y0 + H.LEGS.y1) / 2, t.pos[2]];
        case 'foot': return local(0, (H.FOOT.y0 + H.FOOT.y1) / 2, H.FOOT.cz || 0);
        case 'hand': { const h = H.HANDS[handIndex]; return local(h.x, h.y, h.z); }
        default: return null;
      }
    },
    /** 플레이어 시선을 이 점으로 돌리고, 실제 판정 함수가 무엇을 맞힌다고 하는지 돌려준다 */
    aimAt(point) {
      const p = qa.ctx.player;
      const eye = p.getEye();
      const dx = point[0] - eye[0], dy = point[1] - eye[1], dz = point[2] - eye[2];
      const len = Math.hypot(dx, dy, dz) || 1;
      p.state.yaw = Math.atan2(-dx, -dz);
      p.state.pitch = Math.asin(dy / len);
      const dir = [dx / len, dy / len, dz / len];
      const hit = qa.ctx.traceShot(eye, dir, 1000, { ignoreId: p.state.id });
      return { kind: hit.kind, part: hit.part, id: hit.id, dist: hit.dist, len };
    },
    /** 게임 HUD와 무기 상태 요약 */
    snapshot() {
      const s = qa.ctx.player.state;
      const a = qa.arsenal;
      const w = a.getWeapon();
      const ammo = a.getAmmo();
      const zoom = a.getZoom(qa.ctx.renderer.baseFov);
      return {
        pos: s.pos.slice(), vel: s.vel.slice(), speed: s.speed, yaw: s.yaw, pitch: s.pitch, onGround: s.onGround, hp: s.hp, alive: s.alive,
        weapon: w.id, slot: w.slot, state: w.state, mag: ammo.mag, reserve: ammo.reserve === Infinity ? 'unlimited' : ammo.reserve,
        zoom: { progress: zoom.progress, level: zoom.level, levels: zoom.levels, mag: zoom.mag, fov: zoom.fov, scopeAmount: zoom.scopeAmount },
        fov: qa.ctx.renderer.camera.fov, baseFov: qa.ctx.renderer.baseFov, locked: qa.ctx.input.locked, enabled: qa.ctx.input.enabled,
        phase: qa.run ? qa.run.phase : null
      };
    },
    /** 이 요소가 화면에 보이는가 */
    visible(selector) {
      const el = document.querySelector(selector);
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return !el.hidden && r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
    },
    text(selector) {
      const el = document.querySelector(selector);
      return el ? el.textContent : null;
    },
    profile() { return JSON.parse(JSON.stringify(qa.ctx.account.profile)); }
  };
  window.__qa = qa;
}

/** page.open의 initScript. profile과 settings는 저장소가 비어 있을 때 한 번만 넣는다 */
export function qaInit({ profile = null, settings = null } = {}) {
  return `(${pageSetup.toString()})(${JSON.stringify({ profile, settings })});`;
}

/** 닉네임이 있고 무기를 모두 가진 시험용 프로필. over로 덮어쓴다 */
export function richProfile(over = {}) {
  return { nickname: NICK, points: 500, owned: [...WEAPON_IDS], createdAt: 1, ...over };
}

/** 저사양 설정. 시뮬레이션을 오래 돌리는 시나리오의 CPU 부담을 줄인다 */
export const LOW_QUALITY = Object.freeze({ quality: 'low' });

/** 시나리오 하나의 검사 기록기 */
export class Tester {
  constructor({ name, browser, server, outDir, filter = null, relay = null, logLine = () => {} }) {
    this.name = name;
    this.browser = browser;
    this.server = server;
    this.outDir = outDir;
    this.filter = filter;
    this.relay = relay;   // --relay: 멀티 시나리오의 중계 서버 주소 또는 'node'(run.mjs)
    this.logLine = logLine;
    this.page = null;
    this.checks = 0;
    this.failures = [];
    this.notes = [];
    this.section = '';
  }

  get base() { return this.server.base; }
  log(text) { this.logLine(text); }
  setSection(text) { this.section = text; this.log(`-- ${text}`); }

  /** 검사 하나. 실패해도 시나리오는 이어 간다 */
  check(ok, label, detail) {
    this.checks++;
    if (ok) return true;
    const where = this.section ? `[${this.section}] ` : '';
    const more = detail === undefined ? '' : `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
    this.failures.push(`${where}${label}${more}`);
    this.log(`   실패: ${where}${label}${more}`);
    return false;
  }

  note(text) { this.notes.push(text); this.log(`   참고: ${text}`); }

  /** 새 탭을 연다. 렌더링 탭이 둘이 되지 않게 이전 탭을 먼저 닫는다 */
  async newPage() {
    await this.closePage();
    this.page = await this.browser.newPage();
    return this.page;
  }

  /** 페이지를 닫는다. 아직 검사하지 않은 오류가 남아 있으면 그냥 지나가지 않는다 */
  async closePage() {
    if (!this.page) return;
    if (!this.page.closed && this.page.errors.length) this.errorsOk('페이지를 닫기 전까지');
    await this.page.close();
    this.page = null;
  }

  async shot(name) {
    if (!this.page || this.page.closed) return null;
    const file = join(this.outDir, `${this.name}-${name}.png`);
    try { await this.page.screenshot(file); return file; }
    catch (err) { this.note(`스크린샷 실패 ${name}: ${err.message}`); return null; }
  }

  /** 지금까지의 페이지 오류를 검사하고 비운다. allow에 맞는 오류는 이유가 있어 넘어간다 */
  errorsOk(label, { allow = [] } = {}) {
    const page = this.page;
    const bad = page.errors.filter((e) => !allow.some((re) => re.test(e.text || '')));
    const ok = this.check(bad.length === 0, `${label}: 오류가 없어야 한다`, bad.slice(0, 6).map((e) => `${e.type}: ${String(e.text).slice(0, 300)}`).join(' | '));
    page.clearErrors();
    return ok;
  }
}

/* ───────────────────────────── 게임 열기 ───────────────────────────── */

/**
 * 게임을 연다. query는 '?' 없는 URL 플래그이고 debug=1은 언제나 붙인다.
 * @returns {Promise<import('./browser.mjs').Page>}
 */
export async function openGame(t, query = '', { profile = richProfile(), settings = null, width = 960, height = 540, clean = true, reusePage = false, screen = null, timeoutMs = 60000 } = {}) {
  const page = reusePage && t.page ? t.page : await t.newPage();
  const q = [query, 'debug=1'].filter(Boolean).join('&');
  await page.open(`${t.base}?${q}`, { width, height, initScript: qaInit({ profile, settings }), clean, timeoutMs });
  await readyGame(page, { screen, timeoutMs });
  return page;
}

/** 부팅이 끝나 버스 기록을 시작할 수 있을 때까지 기다린다 */
export async function readyGame(page, { screen = null, timeoutMs = 60000 } = {}) {
  await page.waitFor('window.__qa && __qa.ctx && __qa.world && __qa.ctx.screen', timeoutMs, { label: '게임 부팅' });
  await page.eval('__qa.watch()');
  if (screen) await page.waitFor(`__qa.ctx.screen === ${JSON.stringify(screen)}`, timeoutMs, { label: `화면 ${screen}` });
}

/** 메뉴에서 연습장 설정 시트를 열고 지난 설정 그대로 출격한다(빠른 시작이 없어진 자리) */
export async function startPractice(page) {
  await page.clickText('.sk-menu-btn', '연습장');
  await page.waitFor('!!document.querySelector(".sk-sheet .sk-sheet-foot")', 5000, { label: '연습장 설정 시트' });
  await page.clickText('.sk-sheet-foot .sk-btn', '출격');
}

/** 연습장 경기가 시작될 때까지 */
export async function waitRun(page, timeoutMs = 60000) {
  await page.waitFor('__qa.ctx.screen === "sandbox" && !!__qa.run', timeoutMs, { label: '연습장 경기 시작' });
  await page.eval('__qa.hookRun()');
}

export async function waitLive(page, timeoutMs = 30000) {
  await page.waitFor('__qa.run && __qa.run.phase === "live"', timeoutMs, { label: '경기 live 단계' });
}

/** 캔버스를 눌러 포인터 잠금을 건다. 입력이 켜질 때까지 기다린다 */
export async function lockPointer(page, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (await page.eval('__qa.ctx.input.locked && __qa.ctx.input.enabled')) return;
    if (Date.now() > end) throw new Error('포인터 잠금을 걸지 못했어요');
    const c = await page.eval(`(() => { const r = __qa.ctx.renderer.domElement.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await page.mouseClick(c.x, c.y);
    await sleep(250);
  }
}

/** 게임 틱이 n번 더 돌 때까지 기다린다 */
export async function waitTicks(page, n, timeoutMs = 30000) {
  const start = await page.eval('__qa.ctx.loop.tick');
  await page.waitFor(`__qa.ctx.loop.tick >= ${start + n}`, timeoutMs, { intervalMs: 30, label: `틱 ${n}번` });
}

/** 지금 무기가 다음 동작을 받을 수 있을 때까지(idle) */
export async function waitIdle(page, timeoutMs = 15000) {
  await page.waitFor('__qa.arsenal.getWeapon().state === "idle"', timeoutMs, { intervalMs: 30, label: '무기 idle' });
}

/** 왼쪽 버튼을 누르고 틱이 돌 만큼 기다렸다가 뗀다 */
export async function clickFire(page, holdTicks = 3, button = 0) {
  await page.mouseDown(button);
  await waitTicks(page, holdTicks);
  await page.mouseUp(button);
}
