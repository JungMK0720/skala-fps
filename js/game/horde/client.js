/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 좀비 물량 막기의 화면 쪽 진행. 방장 스냅샷(혼자면 이 탭의 시뮬레이션)을 World·HUD 띠·카드 화면에 옮기고,
 *          내 카드 효과(무기 배율·이동·관통·탄 채우기·처치 탄약·광란·탄약 제조)를 내 무기에 건다. 연습장(혼자)과 멀티(방장·손님)가 같이 쓴다.
 */
import { computePerks, perkSummary, cardById, TIERS } from './cards.js';
import { HORDE, fmtClock } from './rules.js';
import { SKILL_NAMES, skillKindOf } from './bosses.js';

const FRENZY_MS = 4000;
const FRENZY_MAX = 5;

/** 카드 능력치 → 무기 배율(arsenal.setMods) */
export function modsFromPerks(k, frenzyStacks = 0) {
  return {
    mag: 1 + k.mag, fire: (1 + k.fireRate) * (1 + (k.frenzy || 0) * Math.min(FRENZY_MAX, frenzyStacks)), reload: Math.max(0.3, 1 + k.reload),
    draw: 1 + k.draw, spread: Math.max(0.2, 1 - k.spread), recoil: Math.max(0.2, 1 - k.recoil),
    reserve: HORDE.reserveMul * (1 + k.reserve), finiteMags: HORDE.premiumReserveMags, nades: Math.round(k.nades), thrift: k.thrift
  };
}

/**
 * @param {object} o
 * @param {object} o.world, o.ui
 * @param {string} o.meId
 * @param {() => string} [o.myName]
 * @param {() => string} [o.loadout]    내 주무기(스폰할 때)
 * @param {{ pick(id), reroll() }} o.actions   카드 고르기를 방장에게(혼자면 시뮬레이션에) 보낸다
 * @param {(view) => void} [o.onOver]     전멸 뒤 결과 화면을 띄울 때
 * @param {(id, spawn) => void} [o.onActorSpawn]   다른 사람이 일어났을 때(세션이 아바타를 세운다)
 * @param {(id) => void} [o.onActorDown]
 * @param {(line) => void} [o.onFeed]     카드·보스 소식(채팅 줄)
 * @param {boolean} [o.solo]
 */
export function createHordeClient(o) {
  const { world, ui } = o;
  const meId = String(o.meId);
  const W = (name, ...a) => { const f = world && world[name]; if (typeof f === 'function') { try { return f.apply(world, a); } catch (e) { console.error('[horde]', name, e); } } return undefined; };
  const nameOf = (id) => { const p = last && last.players.find((x) => x.id === id); return p ? p.name : ''; };
  let last = null;
  let phase = null, stage = 0, overAt = 0, overShown = false;
  let cardsSig = '', appliedCards = 0, perks = computePerks([]), maxHp = HORDE.baseHp;
  let myKills = 0, myHp = null, myAlive = false, spawnedOnce = false;
  let frenzy = [];                 // 끝나는 시각들
  let ammoAcc = 0, hudAt = 0, timeBase = null, timeAt = 0;
  const killSeen = new Set();
  let pickSent = null;             // 보낸 카드(방장 확인을 기다리는 동안 다시 보내지 않는다)
  let pickSentAt = 0;
  let cardsUiSig = '';
  let disposed = false;

  function applyPerks() {
    W('setHordePerks', {
      mods: modsFromPerks(perks, frenzy.length), speed: 1 + perks.move, maxSpeed: 1 + perks.maxSpeed, jump: 1 + perks.jump,
      pierce: perks.pierce, maxHp
    });
  }

  function spawnMe(sp) {
    const spawn = sp && Number.isFinite(sp.x) ? sp : null;
    if (!spawn) return;
    // 배율(예비 탄 3배·카드)을 먼저 걸어야 스폰할 때 채우는 탄이 이 모드의 양이 된다
    applyPerks();
    W('spawnLocal', { id: meId, name: o.myName ? o.myName() : undefined, team: 'owner', spawn, loadout: o.loadout ? o.loadout() : undefined });
    myAlive = true;
    spawnedOnce = true;
    applyPerks();
  }

  function centerFor(ev) {
    const H = ui && ui.hud;
    if (!H) return;
    if (ev.phase === 'prep') {
      H.center('좀비 물량 막기', 2600, { sub: `${Math.round((ev.ms || 0) / 1000)}초 뒤 1스테이지 · 최대한 오래 버티세요`, tone: 'warn' });
    } else if (ev.phase === 'wave' && !ev.resumed) {
      const bosses = Array.isArray(ev.bosses) ? ev.bosses : [];
      H.center(`스테이지 ${ev.stage}`, 2400, { sub: bosses.length ? `보스 등장 · ${bosses.map((b) => `${b.icon || ''} ${b.name}`).join(' · ')}` : `좀비 ${ev.count || 0}마리가 몰려와요`, tone: bosses.length ? 'charterer' : undefined });
      W('sound', 'horde_wave');
    } else if (ev.phase === 'cards') {
      // 가운데 글자는 카드 화면 뒤로 비쳐 겹친다 → 짧은 알림만(HUD 띠가 '스테이지 클리어'를 보여 준다)
      H.callout('스테이지 클리어! · 체력 25% 회복');
      W('sound', 'horde_clear');
    } else if (ev.phase === 'break') {
      H.center(`곧 스테이지 ${(ev.stage | 0) + 1}`, 1500, { sub: '쓰러진 동료는 다음 스테이지에 일어나요' });
    }
  }

  function onEvent(ev) {
    if (!ev || typeof ev !== 'object') return;
    const H = ui && ui.hud;
    switch (ev.type) {
      case 'phase': phase = ev.phase; stage = ev.stage | 0; centerFor(ev); if (ev.phase !== 'cards') { pickSent = null; if (ui && ui.isVisible('cards')) ui.hide('cards'); } break;
      case 'spawn':
        if (String(ev.id) === meId) { if (!ev.keep) spawnMe(ev.spawn); }
        else if (o.onActorSpawn) o.onActorSpawn(String(ev.id), ev.spawn);
        break;
      case 'down':
        if (String(ev.id) === meId) { if (myAlive) { myAlive = false; W('killLocal', {}); } if (H) H.center('쓰러졌어요', 2200, { sub: '동료가 이번 스테이지를 깨면 다음 스테이지에 일어나요', tone: 'warn' }); }
        else { if (o.onActorDown) o.onActorDown(String(ev.id)); if (H) H.callout(`💀 ${nameOf(String(ev.id)) || '동료'} 쓰러짐`); }
        break;
      case 'knock': if (String(ev.id) === meId) W('pushLocal', ev.v); break;
      case 'slow': if (String(ev.id) === meId) { W('slowLocal', 1 - (Number(ev.mul) || 0), ev.ms); if (H) H.callout('❄️ 느려졌어요'); } break;
      case 'second': if (String(ev.id) === meId && H) H.banner({ icon: '🪽', title: '두 번째 기회!', sub: '쓰러질 피해를 버텼어요' }); break;
      case 'boss':
        if (H) H.banner({ icon: '👑', title: '보스 등장', sub: (ev.bosses || []).map((b) => `${b.icon || ''} ${b.name}`).join(' · ') });
        break;
      case 'bossDown':
        if (H) H.banner({ icon: '🏆', title: `${ev.name || '보스'} 처치!`, sub: ev.by ? `${String(ev.by) === meId ? '내가' : `${nameOf(String(ev.by))}님이`} 마무리했어요` : '' });
        W('sound', 'boss_down');
        if (o.onFeed) o.onFeed(`👑 ${ev.name || '보스'} 처치${ev.by ? ` · ${nameOf(String(ev.by))}` : ''}`);
        break;
      case 'card': {
        const c = cardById(ev.card);
        if (String(ev.id) === meId) { W('sound', 'card_pick'); if (H && c) H.callout(`${c.icon} ${c.name}${ev.auto ? ' (시간 초과)' : ''}`); }
        if (o.onFeed && c) o.onFeed(`${nameOf(String(ev.id))} · ${c.icon} ${c.name}`);
        break;
      }
      case 'reroll': if (String(ev.id) === meId) W('sound', 'card_shuffle'); break;
      case 'skill': case 'chain': case 'enrage': case 'bossSpawn': W('hordeEvent', ev); break;
      case 'over': overAt = performance.now(); break;
      case 'join': if (H && String(ev.id) !== meId) H.callout(`${ev.name || '동료'}님 합류 · 다음 스테이지부터`); break;
      case 'leave': if (H && String(ev.id) !== meId) H.callout(`${nameOf(String(ev.id)) || '동료'}님이 나갔어요`); break;
      default: break;
    }
  }

  /** 새로 생긴 내 카드의 한 번짜리 효과(재장전 탄창·수류탄 채우기) */
  function applyNewCards(cards) {
    for (let i = appliedCards; i < cards.length; i++) {
      const c = cardById(cards[i]);
      const inst = c && c.instant;
      if (!inst) continue;
      if (inst.refill) W('refillReserve');
      if (inst.nades) W('refillGrenades');
    }
    appliedCards = cards.length;
  }

  function cardProps(me) {
    const taken = me.cards;
    return {
      stage, picked: false, rerolls: me.rerolls,
      // 혼자 할 때는 카드 고르기에 사실상 시간 제한이 없으므로 남은 시간을 보여 주지 않는다
      seconds: !o.solo && last && last.timeLeftMs != null ? last.timeLeftMs / 1000 : 0,
      cards: me.offer.map((id) => {
        const c = cardById(id);
        const t = TIERS[c.tier];
        return { id: c.id, name: c.name, desc: c.desc, icon: c.icon, tier: c.tier, tierName: t.name, color: t.color, owned: taken.filter((x) => x === c.id).length };
      }),
      perks: perkSummary(perks).slice(0, 12)
    };
  }

  function teamRows(v) {
    return v.players.filter((p) => p.connected).map((p) => ({ id: p.id, name: p.name, hp: p.hp, maxHp: p.maxHp, alive: p.alive, me: p.id === meId, picked: v.phase === 'cards' && p.picked, shield: p.shield }));
  }
  function hud(now) {
    const v = last;
    if (!v || !ui) return;
    const leftMs = timeBase == null ? null : Math.max(0, timeBase - (now - timeAt));
    const waiting = v.phase === 'cards' ? v.players.filter((p) => p.connected && p.offer.length && !p.picked) : [];
    const me = v.players.find((p) => p.id === meId);
    let warn = '';
    if (me && me.alive && v.phase === 'wave' && world.internals) {
      const a = world.internals.arsenal;
      const slots = [a.getAmmo(a.getLoadout().primary), a.getAmmo(a.getLoadout().secondary)];
      if (slots.every((s) => s && s.kind === 'mag' && s.mag <= 0 && s.reserve <= 0)) warn = '탄약이 떨어졌어요 · 3번 칼로 싸우거나 카드로 탄을 채우세요';
    }
    if (v.phase === 'cards' && me && me.picked && waiting.length) warn = `카드 선택 완료 · ${waiting.map((p) => p.name).join(', ')} 기다리는 중`;
    ui.update('horde', {
      stage: v.stage, phase: v.phase, timeLeft: leftMs == null ? 0 : leftMs / 1000, left: v.left,
      bosses: v.bosses.map((b) => ({ name: b.def.name, icon: b.def.icon, hpFrac: b.hp / b.maxHp, enraged: b.enraged, skill: b.skill && b.skillPhase === 1 ? SKILL_NAMES[skillKindOf(b.skill)] || '' : '' })),
      team: teamRows(v), elapsed: v.elapsedMs ? fmtClock(v.elapsedMs + (v.phase === 'wave' ? Math.min(1000, now - timeAt) : 0)) : '',
      pickedText: v.phase === 'cards' ? `${v.players.filter((p) => p.connected && p.picked).length}/${v.players.filter((p) => p.connected).length}명` : '',
      warn
    });
  }

  /**
   * 방장 스냅샷 하나(applyHordeSnapshot 결과)와 같은 메시지의 이벤트를 반영한다.
   * @param {object} v 뷰
   * @param {object[]} [events]
   * @param {number} [t] 받은 시각(performance.now)
   */
  function apply(v, events = [], t = performance.now()) {
    if (disposed || !v) return;
    last = v;
    if (ui && !ui.isVisible('horde')) ui.show('horde', {});
    W('setRound', { mode: 'zombie', phase: v.phase === 'over' ? 'matchEnd' : 'live', timeLeftMs: null });
    for (const ev of Array.isArray(events) ? events : []) onEvent(ev);
    phase = v.phase; stage = v.stage;
    timeBase = v.timeLeftMs; timeAt = t;
    W('hordePush', v, t);
    const me = v.players.find((p) => p.id === meId);
    if (me) {
      // 카드 → 능력치(바뀔 때만)
      const sig = me.cards.join(',');
      if (sig !== cardsSig || me.maxHp !== maxHp) {
        cardsSig = sig;
        perks = computePerks(me.cards);
        maxHp = me.maxHp;
        if (me.cards.length < appliedCards) appliedCards = 0;   // 새 판
        applyNewCards(me.cards);
        applyPerks();
      }
      // 살아남/쓰러짐 보정(이벤트를 놓쳤을 때)
      const localAlive = !!world.localAlive;
      if (!me.alive && localAlive && spawnedOnce) { myAlive = false; W('killLocal', {}); }
      myAlive = !!me.alive;
      if (me.alive && localAlive && me.hp !== myHp) {
        if (myHp != null && me.hp < myHp && me.hurt && me.hurt.ago < 700) {
          const lp = (W('getLocalState') || {}).pos;
          W('feedbackDamage', { attackerPos: [me.hurt.x, lp ? lp[1] + 1.2 : 1.2, me.hurt.z], amount: myHp - me.hp, incoming: true });
        }
        W('setLocalHp', me.hp);
      }
      myHp = me.hp;
      // 처치: 탄약 회수·광란, 내가 마무리한 좀비는 킬 표시
      if (me.kills > myKills) {
        const n = me.kills - myKills;
        if (perks.killAmmo > 0) W('addMagAmmo', perks.killAmmo * n);
        if (perks.frenzy > 0) {
          const until = t + FRENZY_MS;
          for (let i = 0; i < n; i++) frenzy.push(until);
          frenzy = frenzy.slice(-FRENZY_MAX);
          applyPerks();
        }
      }
      myKills = me.kills;
      // 카드 화면
      const offered = v.phase === 'cards' && me.offer.length && !me.picked && me.connected;
      if (offered && pickSent && me.offer.includes(pickSent) && performance.now() - pickSentAt < 1500) { /* 방장 확인 대기 */ }
      else if (offered) {
        const props = cardProps(me);
        const sigC = JSON.stringify([props.cards.map((c) => c.id), props.rerolls]);
        if (!ui.isVisible('cards') || sigC !== cardsUiSig) { cardsUiSig = sigC; ui.show('cards', props); }
        else if (!o.solo) ui.update('cards', { seconds: props.seconds, rerolls: props.rerolls });
      } else if (ui && ui.isVisible('cards')) { ui.hide('cards'); cardsUiSig = ''; }
    }
    for (const z of v.zombies) {
      if (!z.dead || killSeen.has(z.id)) continue;
      killSeen.add(z.id);
      if (z.killer === meId) W('feedbackDamage', { amount: 0, kill: true, incoming: false });
    }
    if (killSeen.size > 2000) { const keep = [...killSeen].slice(-500); killSeen.clear(); for (const k of keep) killSeen.add(k); }
    hud(t);
    if (v.phase === 'over' && !overShown) {
      if (!overAt) overAt = t;
      if (ui && ui.hud) ui.hud.center('전멸', 0, { sub: `스테이지 ${v.over ? v.over.stage : v.stage} · 생존 ${fmtClock(v.over ? v.over.ms : v.elapsedMs)}`, tone: 'charterer' });
    }
  }

  function frame(dt) {
    if (disposed || !last) return;
    const now = performance.now();
    // 광란이 끝나면 연사를 되돌린다
    if (frenzy.length && frenzy[0] <= now) { frenzy = frenzy.filter((x) => x > now); applyPerks(); }
    // 탄약 제조: 1초마다 탄창 크기의 일정 비율을 예비 탄에
    if (perks.ammoRegen > 0 && myAlive && phase === 'wave' && world.internals) {
      ammoAcc += dt;
      if (ammoAcc >= 1) {
        ammoAcc -= 1;
        const a = world.internals.arsenal;
        const am = a.getAmmo();
        if (am && am.kind === 'mag' && am.magSize) W('addReserve', Math.max(1, Math.round(am.magSize * perks.ammoRegen)));
      }
    }
    if (now - hudAt > 200) { hudAt = now; hud(now); }
    if (overAt && !overShown && now - overAt > 3200) {
      overShown = true;
      if (o.onOver) o.onOver(last);
    }
  }

  /** 카드 화면에서 고름(UI 이벤트) */
  function pick(id) {
    if (!last || last.phase !== 'cards') return;
    pickSent = String(id);
    pickSentAt = performance.now();
    if (ui && ui.isVisible('cards')) ui.hide('cards');
    if (o.actions && o.actions.pick) o.actions.pick(String(id));
  }
  function reroll() {
    if (!last || last.phase !== 'cards') return;
    if (o.actions && o.actions.reroll) o.actions.reroll();
  }
  const offs = ui ? [
    ui.on('cards:pick', (e) => {
      pick(e && e.id);
      // 고른 클릭 안에서 다시 포인터를 잠근다(다시 누르지 않아도 바로 움직인다)
      const input = o.input;
      if (input && !input.locked && !input.touchMode) input.requestLock();
    }),
    ui.on('cards:reroll', () => reroll())
  ] : [];
  const offHit = typeof world.on === 'function' ? world.on('hitClaim', (c) => {
    // 좀비를 맞힌 순간의 히트마커(방장 확인 전에 보여 준다. 처치 표시는 스냅샷이 확인한다)
    if (c && String(c.victimId)[0] === 'z') W('feedbackDamage', { amount: 0, head: c.part === 'head', kill: false, incoming: false });
  }) : null;

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const f of offs) { try { f(); } catch (e) { /* ignore */ } }
    if (offHit) offHit();
    if (ui) { ui.hide('cards'); ui.hide('horde'); }
    W('setHordePerks', null);
  }

  return {
    apply, frame, dispose, pick, reroll,
    get view() { return last; },
    get perks() { return { ...perks }; },
    get phase() { return phase; },
    get stage() { return stage; },
    get alive() { return myAlive; }
  };
}

/** 점수판(Tab) 데이터: 한 팀 표에 처치·헤드샷·보스·피해·쓰러짐 */
export function hordeScoreboard(v, meId, extra = {}) {
  if (!v) return null;
  return {
    mode: 'zombie', stage: v.stage, elapsed: fmtClock(v.elapsedMs), left: v.left, meId,
    players: v.players.filter((p) => p.connected || p.kills).map((p) => ({
      id: p.id, name: p.name, team: 'owner', kills: p.kills, deaths: p.downs, head: p.heads, boss: p.bossKills, damage: p.damage,
      cards: p.cards.length, alive: p.alive, me: p.id === meId, ping: extra.ping ? extra.ping(p.id) : null
    })),
    ...extra.meta
  };
}
