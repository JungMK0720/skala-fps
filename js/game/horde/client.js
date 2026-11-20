/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 좀비 물량 막기의 화면 쪽 진행. 방장 스냅샷(혼자면 이 탭의 시뮬레이션)을 World·HUD 띠·카드 화면에 옮기고,
 *          내 카드 효과(무기 배율·이동·관통·탄 채우기·처치 탄약·광란·탄약 제조)를 내 무기에 건다. 연습장(혼자)과 멀티(방장·손님)가 같이 쓴다.
 *          무기는 1스테이지가 시작되기 전 준비 시간에만 N으로 모든 무기 중에서 고른다(World 교체 창의 free 모드). 바닥 보급품에 닿으면 방장에게
 *          줍기를 청하고, 방장이 확정한 'loot' 이벤트를 받으면 탄창을 내 무기에 넣는다(구급 상자 체력·보물 상자 증강은 방장이 준다).
 *          팀 레벨이 오르거나 보물 상자를 주우면 증강 제안이 오고(멀티는 고르는 동안 무적·20초 뒤 무작위), 좀비를 맞히면 피해 숫자를 띄운다.
 *          방장이 잰 밀려남(좀비에게 맞음)을 내 몸에 한 번 걸고, 멀티에서는 쓰러진 동료 옆에서 F(E·휴대폰 살리기 버튼)를 누르는 동안 방장에게 살리기를 청한다.
 */
import { computePerks, perkSummary, cardById, TIERS } from './cards.js';
import { HORDE, fmtClock, hordeAmmo } from './rules.js';
import { zombieHitDamage, nadeDamage } from './director.js';
import { WEAPONS, GRENADE_IDS } from '../../weapons/defs.js';
import { SKILL_NAMES, skillKindOf, HAZARD_KINDS } from './bosses.js';
import { pickableWeapons } from '../modes.js';

const FRENZY_MS = 7000;          // 광란: 총으로 좀비를 맞힐 때마다 쌓이는 연사가 이만큼 이어진다(맞힐 때마다 한 겹씩, 겹마다 따로 끝난다)
const FRENZY_MAX = 300;          // 광란 최대 겹 수
const REVIVE_SEND_MS = 300;      // 살리기를 누르고 있는 동안 방장에게 다시 알리는 간격(방장은 reviveKeepMs 동안 소식이 없으면 끊는다)
const REVIVE_KEEP_M = 0.5;       // 살리던 동료는 reviveTouchM보다 이만큼 멀어져도 이어 간다(경계에서 켜졌다 꺼졌다 하지 않게)
const HAZARD_LABEL = Object.freeze({
  [HAZARD_KINDS.acid]: 'acid', [HAZARD_KINDS.fire]: 'fire', [HAZARD_KINDS.web]: 'web',
  [HAZARD_KINDS.frost]: 'frost', [HAZARD_KINDS.shock]: 'shock'
});

/** 카드 능력치 → 무기 배율(arsenal.setMods) */
export function modsFromPerks(k, frenzyStacks = 0) {
  // 재장전 시간 −reloadCut(0.5 = 절반, 1 = 거의 즉시). 탄은 그대로 줄고 가진 탄만큼만 쏜다
  const cut = Math.min(1, Math.max(0, k.reloadCut || 0));
  return {
    mag: 1 + k.mag, fire: (1 + k.fireRate) * (1 + (k.frenzy || 0) * Math.min(FRENZY_MAX, frenzyStacks)),
    reload: Math.max(0.3, 1 + k.reload) / Math.max(0.02, 1 - cut),
    draw: 1 + k.draw, spread: Math.max(0.2, 1 - k.spread), recoil: Math.max(0.2, 1 - k.recoil),
    reserve: HORDE.reserveMul * (1 + k.reserve), finiteMags: HORDE.premiumReserveMags, nades: Math.round(k.nades), thrift: k.thrift,
    // 보조무기 마스터: 보조무기만 연사 2배 · 탄창 2배
    sideFire: k.sideMaster > 0 ? 2 : 1, sideMag: k.sideMaster > 0 ? 2 : 1
  };
}

/**
 * @param {object} o
 * @param {object} o.world, o.ui
 * @param {string} o.meId
 * @param {() => string} [o.myName]
 * @param {() => string} [o.loadout]    내 주무기(스폰할 때)
 * @param {{ pick(id), reroll(), loot?(id), revive?(id, on) }} o.actions   카드 고르기·보급품 줍기·동료 살리기(멀티만)를 방장에게(혼자면 시뮬레이션에) 보낸다
 * @param {object} [o.input]           engine/input.js(살리기: state.interact·state.use, touchMode)
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
  let phase = null, stage = 0, ammoStage = 0, overAt = 0, overShown = false;
  let cardsSig = '', appliedCards = 0, perks = computePerks([]), maxHp = HORDE.baseHp;
  let myKills = 0, myHp = null, myAlive = false, spawnedOnce = false;
  let frenzy = [];                 // 끝나는 시각들
  let ammoAcc = 0, hudAt = 0, timeBase = null, timeAt = 0;
  const killSeen = new Set();
  let pickSent = null;             // 보낸 카드(방장 확인을 기다리는 동안 다시 보내지 않는다)
  let pickSentAt = 0;
  let cardsUiSig = '';
  let disposed = false;
  let myShot = { id: 0, n: 0 };    // 관통: 같은 발로 몇 번째 좀비를 맞혔나(피해 숫자 계산)
  let swapTicket = false;          // 무기 교체권으로 연 교체 창(한 번 바꾸면 닫는다)
  const perkCache = new Map();     // 사람 id → { sig, perks } (남의 수류탄 폭발 반경)
  const lootPending = new Map();   // 줍기를 청한 보급품 번호 → 보낸 시각(확정 전에는 화면에서 감춘다)
  const lootDone = new Set();      // 효과를 넣은 'loot' 이벤트(같은 이벤트가 스냅샷마다 다시 와도 한 번만)
  const LOOT_RESEND_MS = 900, LOOT_HIDE_MS = 1500;
  let lastKnockSeq = null;         // 마지막으로 받은 밀려남 번호(같은 밀려남이 스냅샷마다 다시 와도 한 번만)
  // 살리기(멀티만): 방장에게 'on'을 보내고 있는 동료 id와 보낸 시각, World 안내 줄에 마지막으로 넘긴 값
  const canRevive = !o.solo && !!(o.actions && typeof o.actions.revive === 'function');
  let reviveId = null, reviveSentAt = 0, interactSig = '';

  /** 좀비 물량 막기의 무기 고르기 창(World openSwap free): 모든 무기. 1스테이지가 시작되기 전 준비 시간에만 연다 */
  function swapProps() {
    // 좀비 전용 주무기(기관총)도 이 목록에만 든다(다른 모드의 pickableWeapons에는 나오지 않는다)
    const weapons = pickableWeapons('classic', null, true);
    // 카드의 '탄' 칸은 이 모드의 탄(예비 3배, 프리미엄 총도 탄창 2개 × 3)으로 보여 준다
    const ammo = Object.fromEntries(weapons.map((id) => { const a = hordeAmmo(WEAPONS[id]); return [id, a ? `${a.mag}/${a.reserve}` : '']; }));
    return {
      free: true, weapons, ammo, ruleset: 'classic', title: '무기 고르기 · 좀비 물량 막기',
      foot: '1스테이지가 시작되면 더는 바꿀 수 없어요. 이번 판 내내 쓸 무기를 고르세요.',
      note: '시작 전에만', prompt: true
    };
  }

  /** 다른 사람의 능력치(카드가 바뀔 때만 다시 계산) */
  function perksOf(id) {
    if (String(id) === meId) return perks;
    const p = last && last.players.find((x) => x.id === String(id));
    if (!p) return null;
    const sig = p.cards.join(',');
    const c = perkCache.get(p.id);
    if (c && c.sig === sig) return c.perks;
    const k = computePerks(p.cards);
    perkCache.set(p.id, { sig, perks: k });
    return k;
  }

  function applyPerks() {
    W('setHordePerks', {
      mods: modsFromPerks(perks, frenzy.length), speed: 1 + perks.move, maxSpeed: 1 + perks.maxSpeed, jump: 1 + perks.jump,
      pierce: perks.pierce, maxHp, nadeMulti: Math.round(perks.nadeMulti || 0), guard: perks.guard || 0,
      // 수류탄 폭발 반경은 던진 사람의 증강을 따른다(방장 화면이 남의 수류탄 피해도 잰다)
      nadeRadiusOf: (owner) => { const k = perksOf(owner); return 1 + ((k && k.nadeRadius) || 0); },
      // C4 수류탄(좀비에 붙는다)과 검기 거리. 남의 칼질에도 검기를 그리려고 다른 사람의 검기 거리도 넘긴다
      sticky: perks.stickyNade > 0, waveRange: perks.wave || 0, autoAim: perks.autoAim > 0, sideOnly: perks.sideMaster > 0,
      waveRangeOf: (owner) => ((perksOf(owner) || {}).wave || 0)
    });
  }

  /**
   * 내가 나온다. revive(동료가 F로 살림)면 쓰러질 때 들고 있던 무기·탄·수류탄을 그대로 쓴다
   * (이 모드는 탄이 스테이지 사이에 채워지지 않는다. 살리기가 탄약 보급이 되지 않게). 다음 스테이지에 일어날 때는 예전처럼 새 탄
   */
  function spawnMe(sp, revive = false) {
    const spawn = sp && Number.isFinite(sp.x) ? sp : null;
    if (!spawn) return;
    // 배율(예비 탄 3배·카드)을 먼저 걸어야 스폰할 때 채우는 탄이 이 모드의 양이 된다
    applyPerks();
    W('spawnLocal', { id: meId, name: o.myName ? o.myName() : undefined, team: 'owner', spawn, loadout: o.loadout ? o.loadout() : undefined, ...(revive ? { keepArsenal: true } : {}) });
    myAlive = true;
    spawnedOnce = true;
    applyPerks();
    if (revive) return;
    // 무기는 1스테이지가 시작되기 전에만 고른다(쓰러졌다 일어날 때는 고른 무기 그대로)
    if (phase == null || phase === 'prep') W('openSwap', swapProps());
    // 카드로 바뀐 주·보조무기는 다음 스테이지에 일어나도 유지한다(나중에 고른 카드가 우선).
    const cards = last ? ((last.players.find((p) => p.id === meId) || {}).cards || []) : [];
    const primary = primaryOf(cards), side = sidearmOf(cards);
    if (primary) W('equipHordePrimary', primary);
    if (side) W('equipSidearm', side);
  }

  function centerFor(ev) {
    const H = ui && ui.hud;
    if (!H) return;
    if (ev.phase === 'prep') {
      H.center('좀비 물량 막기', 2600, { sub: `${Math.round((ev.ms || 0) / 1000)}초 뒤 1스테이지 · 최대한 오래 버티세요`, tone: 'warn' });
    } else if (ev.phase === 'wave' && !ev.resumed) {
      const bosses = Array.isArray(ev.bosses) ? ev.bosses : [];
      const secs = Math.round((ev.stageMs || HORDE.stageMs) / 1000);
      H.center(`스테이지 ${ev.stage}`, 2000, { sub: bosses.length ? `보스 등장 · ${bosses.map((b) => `${b.icon || ''} ${b.name}`).join(' · ')}` : `${secs}초 · 좀비 ${ev.count || 0}마리 · 다 잡으면 남은 시간만큼 경험치`, tone: bosses.length ? 'charterer' : undefined });
      W('sound', 'horde_wave');
    }
  }

  function onEvent(ev) {
    if (!ev || typeof ev !== 'object') return;
    const H = ui && ui.hud;
    switch (ev.type) {
      case 'phase':
        phase = ev.phase; stage = ev.stage | 0; centerFor(ev);
        if (ev.phase === 'over' && ui && ui.isVisible('cards')) ui.hide('cards');
        // 무기는 준비 시간에만 바꾼다. 1스테이지가 시작되면 교체 창을 닫는다(무기 교체권으로 연 창은 한 번 바꿀 때까지 둔다)
        if (ev.phase === 'over' || (ev.phase !== 'prep' && !swapTicket)) { swapTicket = false; W('closeSwap'); }
        break;
      case 'levelUp':
        if (H) H.banner({ icon: '⭐', title: `레벨 업! Lv ${ev.level}`, sub: (ev.ups | 0) > 1 ? `증강 ${ev.ups}개를 고르세요` : '증강 하나를 고르세요' });
        W('sound', 'horde_clear');
        break;
      case 'offer':
        if (String(ev.id) === meId) { pickSent = null; W('sound', 'card_shuffle'); }
        break;
      case 'clear':
        if (H) H.callout(`스테이지 클리어! · 남은 시간 경험치 +${ev.bonus | 0} · 체력 25% 회복`);
        break;
      case 'timeup':
        if (H) H.callout(`⏱ 시간 끝 · 남은 좀비 ${ev.left | 0}마리와 다음 스테이지`);
        break;
      case 'decoyDown':
        if (H && String(ev.owner) === meId) H.callout('🎭 분신이 쓰러졌어요');
        break;
      case 'spawn':
        if (String(ev.id) === meId) { if (!ev.keep) spawnMe(ev.spawn, !!ev.revive); }
        else if (o.onActorSpawn) o.onActorSpawn(String(ev.id), ev.spawn);
        break;
      case 'down':
        if (String(ev.id) === meId) {
          if (myAlive) { myAlive = false; W('killLocal', {}); }
          // 30스테이지에 도달한 뒤에는 라운드가 넘어가도 자동 부활하지 않는다.
          const mine = last && last.players.find((p) => p.id === meId);
          const mustRevive = (ev.stage | 0) >= 29;
          const sub = canRevive && mine && mine.down
            ? mustRevive ? `동료가 F를 ${Math.round(HORDE.reviveHoldMs / 1000)}초 눌러 살려야 해요 · 라운드 자동 부활 없음`
              : `동료가 F를 ${Math.round(HORDE.reviveHoldMs / 1000)}초 누르면 일어나요 · 아니면 다음 스테이지에`
            : mustRevive ? '동료가 곁에서 살려야 해요 · 라운드 자동 부활 없음' : '동료가 이번 스테이지를 깨면 다음 스테이지에 일어나요';
          if (H) H.center('쓰러졌어요', 2200, { sub, tone: 'warn' });
        } else { if (o.onActorDown) o.onActorDown(String(ev.id)); if (H) H.callout(`💀 ${nameOf(String(ev.id)) || '동료'} 쓰러짐`); }
        break;
      case 'revive': {
        // 동료가 F를 눌러 쓰러진 사람을 그 자리에서 일으켰다(멀티). 일어난 사람의 스폰은 같은 메시지의 'spawn'이 한다
        const id = String(ev.id), by = String(ev.by);
        const name = nameOf(id) || '동료', byName = nameOf(by) || '동료';
        if (id === meId) { if (H) H.center('다시 일어났어요!', 1800, { sub: `${byName}님이 살렸어요 · ${Math.round(HORDE.reviveInvulnMs / 1000)}초 무적`, tone: 'warn' }); }
        else if (by === meId) { if (H) H.callout(`🩹 ${name}님을 살렸어요`); }
        else if (H) H.callout(`🩹 ${byName}님이 ${name}님을 살렸어요`);
        if (o.onFeed) o.onFeed(`🩹 ${byName}님이 ${name}님을 살렸어요`);
        break;
      }
      case 'knock': if (String(ev.id) === meId) W('pushLocal', ev.v); break;
      case 'slow': if (String(ev.id) === meId) { W('slowLocal', 1 - (Number(ev.mul) || 0), ev.ms); if (H) H.callout('❄️ 느려졌어요'); } break;
      case 'stun': if (String(ev.id) === meId) { W('stunLocal', ev.ms); if (H) H.callout('💫 기절!'); } break;
      case 'grabbed': if (String(ev.id) === meId && H) H.callout('🪝 그랩에 끌려가요!'); break;
      case 'noHeal': if (String(ev.id) === meId && H) H.callout(`🧪 저주! ${Math.round((Number(ev.ms) || 0) / 1000)}초 동안 회복 불가`); break;
      case 'burn': if (String(ev.id) === meId && H) H.callout(`🔥 화상! ${Math.round((Number(ev.ms) || 0) / 1000)}초 동안 지속 피해`); break;
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
      case 'loot': onLoot(ev); break;
      case 'crit': onCrit(ev); break;
      case 'skill': case 'enrage': case 'bossSpawn': W('hordeEvent', ev); break;
      case 'over': overAt = performance.now(); break;
      case 'join': if (H && String(ev.id) !== meId) H.callout(`${ev.name || '동료'}님 합류 · 다음 스테이지부터`); break;
      case 'leave': if (H && String(ev.id) !== meId) H.callout(`${nameOf(String(ev.id)) || '동료'}님이 나갔어요`); break;
      default: break;
    }
  }

  /** 방장이 굴린 치명타. 쏜 사람 화면에만 그 좀비 머리 위에 큰 빨간 숫자를 띄운다(먼저 뜬 보통 숫자보다 위) */
  function onCrit(ev) {
    if (String(ev.by) !== meId) return;
    const z = zombieOf('z' + ev.z);
    if (!z) return;
    const scale = z.boss ? z.boss.scale || 1 : 1;
    W('hordeDamageNumber', [z.pos[0], z.pos[1] + 2.1 * scale, z.pos[2]], ev.dmg, 'crit');
  }

  /** 방장이 확정한 보급품 줍기. 내가 주운 것만 내 무기에 넣는다(구급 상자 체력·보물 상자 증강은 방장이 준다) */
  function onLoot(ev) {
    lootPending.delete(ev.id);
    if (String(ev.by) !== meId || lootDone.has(ev.id)) return;
    lootDone.add(ev.id);
    if (lootDone.size > 400) { const keep = [...lootDone].slice(-200); lootDone.clear(); for (const k of keep) lootDone.add(k); }
    const a = world.internals && world.internals.arsenal;
    let text = '';
    if (ev.kind === 'mag' && a) {
      // 주무기·보조무기의 탄창과 예비 탄을 모두 최대까지 채운다
      W('refillAmmo');
      text = '🧷 탄약 · 모든 총 탄 가득';
      // 탄창은 수류탄도 최대까지 채운다(늘었을 때만 알린다)
      const nade = a.getAmmo(GRENADE_IDS[0]);
      const before = nade && nade.kind === 'count' ? nade.mag : null;
      const after = W('refillGrenades');
      if (before != null && Number(after) > before) text += ' · 💣 수류탄 가득';
    } else if (ev.kind === 'med') {
      text = ev.heal > 0 ? `➕ 구급 상자 · 체력 +${ev.heal}` : '➕ 구급 상자 · 체력이 가득해요';
    } else if (ev.kind === 'chest') {
      text = '🎁 보물 상자! · 증강 하나를 고르세요';
    }
    W('sound', 'loot_pick');
    if (ui && ui.hud && text) ui.hud.callout(text);
  }

  /** 닿은 보급품을 방장에게 청한다(확정 전 0.9초마다 다시). 화면은 lootTouchM, 방장은 그보다 넉넉한 lootPickM으로 잰다 */
  function tryPickLoot(now) {
    if (!myAlive || !last || !Array.isArray(last.loot) || !last.loot.length || phase === 'over') return;
    if (!o.actions || typeof o.actions.loot !== 'function') return;
    const st = W('getLocalState');
    const pos = st && st.pos;
    if (!pos) return;
    for (const L of last.loot) {
      const sent = lootPending.get(L.id);
      if (sent && now - sent < LOOT_RESEND_MS) continue;
      if (Math.hypot(L.pos[0] - pos[0], L.pos[2] - pos[2]) > HORDE.lootTouchM || Math.abs(L.pos[1] - pos[1]) > 1.6) continue;
      lootPending.set(L.id, now);
      o.actions.loot(L.id);
    }
  }

  /**
   * 살릴 수 있는 동료: 쓰러진 자리가 내 발에서 수평 reviveTouchM 안(높이 차 1.6 m 미만)인 가장 가까운 사람.
   * 살리던 동료는 조금 더 멀어져도(REVIVE_KEEP_M) 그대로 두고, 더 가까운 사람이 와도 바꾸지 않는다
   */
  function reviveTarget(pos) {
    let best = null, bestD = Infinity;
    for (const p of last.players) {
      if (p.id === meId || !p.connected || p.alive || !p.down || !Array.isArray(p.down.pos)) continue;
      const d = Math.hypot(p.down.pos[0] - pos[0], p.down.pos[2] - pos[2]);
      if (d > HORDE.reviveTouchM + (p.id === reviveId ? REVIVE_KEEP_M : 0) || Math.abs(p.down.pos[1] - pos[1]) >= 1.6) continue;
      if (p.id === reviveId) return p;
      if (d < bestD) { best = p; bestD = d; }
    }
    return best;
  }

  /** World 안내 줄(살리기)과 휴대폰 살리기 버튼. 바뀔 때만 넘긴다 */
  function showInteract(target, holding) {
    const touch = !!(o.input && o.input.touchMode);
    const name = target ? target.name || '동료' : '';
    const secs = Math.round(HORDE.reviveHoldMs / 1000);
    // 다른 동료가 이미 살리는 중이면 그 사람 이름을 보여 준다(방장은 그 사람만 센다. 그 사람이 떼면 내가 이어서 살린다)
    const other = target && target.down && target.down.by && target.down.by !== meId ? nameOf(target.down.by) || '동료' : '';
    const hint = !target ? ''
      : other ? `🩹 ${other}님이 ${name} 살리는 중`
        : holding ? `🩹 ${name} 살리는 중…`
          : touch ? `살리기 버튼을 ${secs}초 누르고 있으세요 · 🩹 ${name}` : `F 길게 눌러 🩹 ${name} 살리기 (${secs}초)`;
    const sig = hint ? `${hint}|${touch ? 1 : 0}` : '';
    if (sig === interactSig) return;
    interactSig = sig;
    W('setHordeInteract', hint ? { hint, touch } : null);
  }

  /** 살리기를 멈춘다: 'on'을 보내던 중이면 방장에게 'off'를 한 번 */
  function stopRevive() {
    if (reviveId == null) return;
    const id = reviveId;
    reviveId = null;
    try { o.actions.revive(id, false); } catch (e) { console.error('[horde] revive', e); }
  }

  /**
   * 멀티 살리기: 살아 있고 웨이브 중이고 증강을 고르지 않을 때, 쓰러진 동료 옆에서 F(E·휴대폰 살리기 버튼)를 누르고 있으면
   * 방장에게 바로 'on'을 보내고 REVIVE_SEND_MS마다 다시 알린다. 떼거나 멀어지거나 내가 쓰러지면 'off'를 한 번 보낸다(3초는 방장이 센다)
   */
  function tryRevive(now) {
    if (!canRevive) return;
    const me = last.players.find((p) => p.id === meId);
    // 쓰러진 동료가 있을 때만 내 위치를 읽는다(getLocalState는 매번 새 객체를 만든다)
    const able = myAlive && !!world.localAlive && phase === 'wave' && !!me && me.alive && !me.offer.length
      && last.players.some((p) => p.id !== meId && p.connected && !p.alive && p.down);
    const st = able ? W('getLocalState') : null;
    const target = st && Array.isArray(st.pos) ? reviveTarget(st.pos) : null;
    const s = o.input && o.input.state;
    const holding = !!(target && s && (s.interact || s.use));
    if (reviveId != null && (!holding || target.id !== reviveId)) stopRevive();
    if (holding) {
      if (reviveId !== target.id) { reviveId = target.id; reviveSentAt = -Infinity; }
      if (now - reviveSentAt >= REVIVE_SEND_MS) {
        reviveSentAt = now;
        try { o.actions.revive(reviveId, true); } catch (e) { console.error('[horde] revive', e); }
      }
    }
    showInteract(target, holding);
  }

  /** 고른 카드 중 보조무기를 바꾸는 증강(나중 것이 이긴다) → 무기 id | null */
  function primaryOf(cards) {
    let id = null;
    for (const cid of cards) { const c = cardById(cid); if (c && c.instant && c.instant.primary) id = c.instant.primary; }
    return id;
  }

  function sidearmOf(cards) {
    let id = null;
    for (const cid of cards) { const c = cardById(cid); if (c && c.instant && c.instant.side) id = c.instant.side; }
    return id;
  }

  /** 새로 생긴 내 카드의 한 번짜리 효과(재장전 탄창·수류탄 채우기·무기 교체권·보조무기 바꾸기) */
  function applyNewCards(cards) {
    let swapNow = false;
    for (let i = appliedCards; i < cards.length; i++) {
      const c = cardById(cards[i]);
      const inst = c && c.instant;
      if (!inst) continue;
      if (inst.refill) W('refillReserve');
      if (inst.nades) W('refillGrenades');
      if (inst.swap) swapNow = true;
      if (inst.side && W('equipSidearm', inst.side) && ui && ui.hud) ui.hud.callout(`${c.icon} 보조무기: ${(WEAPONS[inst.side] || {}).name || inst.side}`);
      if (inst.primary && W('equipHordePrimary', inst.primary) && ui && ui.hud) ui.hud.callout(`${c.icon} 주무기: ${(WEAPONS[inst.primary] || {}).name || inst.primary}`);
    }
    appliedCards = cards.length;
    // 무기 교체권: 무기 목록을 한 번 연다(고르면 닫힌다. 못 골랐으면 N으로 다시 연다)
    if (swapNow && myAlive) {
      swapTicket = true;
      W('openSwap', { ...swapProps(), title: '무기 교체권 · 한 번', foot: '고른 무기로 바로 바뀌어요. 새로 든 총은 탄을 가득 받아요.', note: '교체권 1회' });
      W('openSwapList');
    }
  }

  function pauseDetails() {
    const me = last && last.players.find((p) => p.id === meId);
    const counts = new Map();
    for (const id of me ? me.cards : []) counts.set(id, (counts.get(id) || 0) + 1);
    const cards = [];
    for (const [id, count] of counts) {
      const c = cardById(id);
      if (c) cards.push({ name: c.name, desc: c.desc, icon: c.icon, count });
    }
    const stats = [
      { label: '공격 피해', value: `${perks.dmg >= 0 ? '+' : ''}${Math.round(perks.dmg * 100)}%` },
      { label: '회피 확률', value: `${Math.round(Math.min(0.9, perks.dodge) * 100)}% · 광역 공격 제외` },
      { label: '피격 후 무적', value: `${(HORDE.hitInvulnMs / 1000 + Math.max(0, perks.iframe)).toFixed(1)}초` },
      { label: '최대 체력', value: `${maxHp}` },
      { label: '현재 보호막', value: `${me ? me.shield : 0}` },
      ...perkSummary(perks).filter((row) => !['피해', '맞은 뒤 무적', '최대 체력', '방패'].includes(row.label))
    ];
    if (perks.guard > 0) stats.push({ label: '방패', value: `정면·칼을 든 동안 피해 −${Math.round(perks.guard * 100)}%` });
    if (perks.lifesteal > 0) stats.push({ label: '광역 공격 흡혈', value: `${+(perks.lifesteal * 20).toFixed(2)}%` });
    return { cards, stats };
  }

  function cardProps(me) {
    const taken = me.cards;
    const lv = last && last.xp ? last.xp.level : 1;
    return {
      stage, picked: false, rerolls: me.rerolls,
      title: me.chest ? '🎁 보물 상자!' : `⭐ 레벨 업! Lv ${lv}`,
      // 멀티는 고르는 동안 무적이고 20초 뒤 무작위로 정해진다. 혼자는 게임이 멈춰 있어 시간을 보여 주지 않는다
      sub: o.solo ? '고르는 동안 게임이 멈춰 있어요' : '고르는 동안 무적이에요 · 시간이 지나면 무작위로 정해져요',
      seconds: !o.solo ? (me.offerLeftMs || 0) / 1000 : 0,
      more: Math.max(0, (me.picks | 0) - 1),
      cards: me.offer.map((id) => {
        const c = cardById(id);
        const t = TIERS[c.tier];
        return { id: c.id, name: c.name, desc: c.desc, icon: c.icon, tier: c.tier, tierName: t.name, color: t.color, owned: taken.filter((x) => x === c.id).length };
      }),
      perks: perkSummary(perks).slice(0, 12)
    };
  }

  function teamRows(v) {
    return v.players.filter((p) => p.connected).map((p) => ({
      id: p.id, name: p.name, hp: p.hp, maxHp: p.maxHp, alive: p.alive, me: p.id === meId, picking: p.offer.length > 0, invuln: p.invuln, shield: p.shield,
      // 쓰러진 사람: 누가 살리는 중인지와 진행(0..1). 멀티에서 방장이 쓰러진 자리를 알려 준 사람만 동료가 살릴 수 있다
      // 처음 합류해 아직 나오지 않은 사람만 다음 스테이지에 스폰된다. 30스테이지부터는 쓰러진 사람이 자동 부활하지 않는다.
      down: !p.alive && p.down ? { by: p.down.by || null, progress: p.down.progress || 0 } : null, canRevive: canRevive && !p.alive && !!p.down,
      noAutoRevive: v.stage >= 29 && !!p.spawned
    }));
  }
  /** 가운데 살리기 막대: 내가 동료를 살리는 중이거나, 쓰러진 나를 동료가 살리는 중이면 { text, frac } */
  function reviveBar(v, me) {
    if (!canRevive || !me || v.phase !== 'wave') return null;
    // 쓰러진 나(down: true)는 관전 이름표와 겹치지 않는 자리에 그린다(ui/horde.js)
    if (!me.alive) return me.down && me.down.by ? { text: `🩹 ${nameOf(me.down.by) || '동료'}님이 살리는 중`, frac: me.down.progress || 0, down: true } : null;
    const t = v.players.find((p) => p.id !== meId && !p.alive && p.down && p.down.by === meId);
    return t ? { text: `🩹 ${t.name || '동료'} 살리는 중`, frac: t.down.progress || 0, down: false } : null;
  }
  /** 방장 장판의 유효 시간·반경·바닥 높이와 같은 조건으로 내 발이 닿은 종류를 찾는다. */
  function fieldUnderfoot(v, now) {
    if (!myAlive || !world.localAlive || v.phase !== 'wave' || !v.hazards || !v.hazards.length) return null;
    const st = W('getLocalState');
    const pos = st && st.pos;
    if (!pos) return null;
    let kind = null, nearest = Infinity;
    const elapsed = Math.max(0, now - timeAt);
    for (const h of v.hazards) {
      if (h.leftMs <= elapsed || !HAZARD_LABEL[h.kind] || Math.abs(pos[1] - h.pos[1]) >= 1.2) continue;
      const d = Math.hypot(pos[0] - h.pos[0], pos[2] - h.pos[2]);
      if (d <= h.r && d < nearest) { kind = HAZARD_LABEL[h.kind]; nearest = d; }
    }
    return kind;
  }

  function hud(now) {
    const v = last;
    if (!v || !ui) return;
    const since = Math.max(0, now - timeAt);
    const leftMs = timeBase == null ? null : Math.max(0, timeBase - since);
    // 스테이지 남은 시간: 웨이브 중에만 흐른다(증강 고르기로 멈춘 혼자 판은 그대로)
    const stageLeft = v.stageLeftMs == null ? null : Math.max(0, v.stageLeftMs - (v.phase === 'wave' ? since : 0));
    const picking = v.players.filter((p) => p.connected && p.offer.length);
    const me = v.players.find((p) => p.id === meId);
    let warn = '';
    if (me && me.alive && v.phase === 'wave' && world.internals) {
      const a = world.internals.arsenal;
      const slots = [a.getAmmo(a.getLoadout().primary), a.getAmmo(a.getLoadout().secondary)];
      if (slots.every((s) => s && s.kind === 'mag' && s.mag <= 0 && s.reserve <= 0)) warn = '탄약이 떨어졌어요 · 좀비가 떨어뜨린 탄창을 줍거나 3번 칼로 싸우세요';
    }
    if (me && me.alive && me.invuln && !me.offer.length && v.phase === 'wave') warn = `🛡 무적 ${Math.max(1, Math.ceil((me.invulnMs - since) / 1000))}초`;
    const revive = reviveBar(v, me);
    // 살리기 안내·막대가 떠 있는 동안은 아래 경고 줄을 감춘다(좁은 화면에서 안내 줄과 겹친다)
    if (revive || interactSig) warn = '';
    ui.update('horde', {
      stage: v.stage, phase: v.phase, timeLeft: leftMs == null ? 0 : leftMs / 1000, left: v.left,
      stageLeft: stageLeft == null ? null : stageLeft / 1000, xp: v.xp,
      bosses: v.bosses.map((b) => ({ name: b.def.name, icon: b.def.icon, hpFrac: b.hp / b.maxHp, enraged: b.enraged, skill: b.skill && b.skillPhase === 1 ? SKILL_NAMES[skillKindOf(b.skill)] || '' : '' })),
      team: teamRows(v), elapsed: v.elapsedMs ? fmtClock(v.elapsedMs + (v.phase === 'wave' ? Math.min(1000, since) : 0)) : '',
      pickedText: picking.length ? picking.map((p) => p.name).join(', ') : '',
      // 혼자 하기의 증강 고르기 줄: 보물 상자 몫이면 '보물 상자'라고 말한다
      pickWhy: picking.some((p) => p.chest) ? 'chest' : 'level',
      warn, revive, field: fieldUnderfoot(v, now)
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
    // 줍기를 청한 보급품은 방장 확정을 기다리는 동안 감춘다(1.5초 안에 확정되지 않으면 다시 보인다)
    if (lootPending.size) {
      const present = new Set((v.loot || []).map((L) => L.id));
      for (const [id] of lootPending) if (!present.has(id)) lootPending.delete(id);
    }
    W('hordePush', lootPending.size ? { ...v, loot: (v.loot || []).filter((L) => { const s = lootPending.get(L.id); return !(s && t - s < LOOT_HIDE_MS); }) } : v, t);
    const me = v.players.find((p) => p.id === meId);
    if (me) {
      // 카드 → 능력치(바뀔 때만)
      const sig = me.cards.join(',');
      if (sig !== cardsSig || me.maxHp !== maxHp) {
        cardsSig = sig;
        perks = computePerks(me.cards);
        maxHp = me.maxHp;
        if (me.cards.length < appliedCards) appliedCards = 0;   // 새 판
        // 새 최대(수류탄 +2·재장전 탄창)를 먼저 무기에 걸어야 '가득 채움'이 새 최대까지 채운다
        applyPerks();
        applyNewCards(me.cards);
        applyPerks();
      }
      // 보급 투하: 새 스테이지마다 한 번(증강 고르기로 잠시 멈춰도 스테이지 번호를 기록한다).
      if (v.stage !== ammoStage && me.alive && world.localAlive) {
        ammoStage = v.stage;
        if (me.cards.includes('drop')) { W('refillAmmo'); W('refillGrenades'); }
      }
      // 살아남/쓰러짐 보정(이벤트를 놓쳤을 때)
      const localAlive = !!world.localAlive;
      if (!me.alive && localAlive && spawnedOnce) { myAlive = false; W('killLocal', {}); }
      myAlive = !!me.alive;
      // 밀려남(좀비에게 맞음): 방장이 정한 속도를 내 몸에 한 번만 건다. 늦게 온 것(knockKeepMs보다 오래된 것)은 버린다
      if (me.knock && me.knock.seq !== lastKnockSeq) {
        lastKnockSeq = me.knock.seq;
        if (me.alive && localAlive && me.knock.ago <= HORDE.knockKeepMs) W('pushLocal', me.knock.v);
      }
      if (me.alive && localAlive && me.hp !== myHp) {
        if (myHp != null && me.hp < myHp && me.hurt && me.hurt.ago < 700) {
          const lp = (W('getLocalState') || {}).pos;
          W('feedbackDamage', { attackerPos: [me.hurt.x, lp ? lp[1] + 1.2 : 1.2, me.hurt.z], amount: myHp - me.hp, incoming: true });
        }
        W('setLocalHp', me.hp);
      }
      myHp = me.hp;
      // 처치: 탄약 회수, 내가 마무리한 좀비는 킬 표시
      if (me.kills > myKills && perks.killAmmo > 0) W('addMagAmmo', perks.killAmmo * (me.kills - myKills));
      myKills = me.kills;
      // 증강 화면: 제안이 있으면(레벨업·보물 상자) 띄운다. 멀티는 게임이 멈추지 않으므로 단계와 상관없다
      const offered = v.phase !== 'over' && me.offer.length && !me.picked && me.connected;
      if (offered && pickSent && me.offer.includes(pickSent) && performance.now() - pickSentAt < 1500) { /* 방장 확인 대기 */ }
      else if (offered) {
        const props = cardProps(me);
        const sigC = JSON.stringify([props.cards.map((c) => c.id), props.rerolls, props.title]);
        if (!ui.isVisible('cards') || sigC !== cardsUiSig) { cardsUiSig = sigC; ui.show('cards', props); }
        else if (!o.solo) ui.update('cards', { seconds: props.seconds, rerolls: props.rerolls, more: props.more });
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
    tryPickLoot(now);
    tryRevive(now);
    if (now - hudAt > 200) { hudAt = now; hud(now); }
    if (overAt && !overShown && now - overAt > 3200) {
      overShown = true;
      if (o.onOver) o.onOver(last);
    }
  }

  /** 증강 화면에서 고름(UI 이벤트) */
  function pick(id) {
    if (!last || last.phase === 'over') return;
    pickSent = String(id);
    pickSentAt = performance.now();
    if (ui && ui.isVisible('cards')) ui.hide('cards');
    if (o.actions && o.actions.pick) o.actions.pick(String(id));
  }
  function reroll() {
    if (!last || last.phase === 'over') return;
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
  /** 지금 내가 점프로 떠 있는가(공중 강타의 피해 숫자) */
  const airNow = () => { const s = W('getLocalState'); return !!s && s.onGround === false; };
  /** 좀비 한 마리(스냅샷의 좀비 행) */
  const zombieOf = (vid) => { const n = Number(String(vid).slice(1)) | 0; return last ? last.zombies.find((z) => z.id === n) : null; };
  const offHit = typeof world.on === 'function' ? world.on('hitClaim', (c) => {
    if (!c || String(c.victimId)[0] !== 'z') return;
    // 좀비를 맞힌 순간의 히트마커(방장 확인 전에 보여 준다. 처치 표시는 스냅샷이 확인한다)
    W('feedbackDamage', { amount: 0, head: c.part === 'head', kill: false, incoming: false });
    // 피해 숫자: 방장과 같은 공식. 치명타는 방장이 굴려 'crit' 이벤트로 오면 따로 크게 띄운다(onCrit). 머리는 크고 노랗게, 몸은 작게
    const z = zombieOf(c.victimId);
    // 검기는 한 번에 여러 마리를 맞혀도 칼과 같은 피해다(관통처럼 줄지 않는다): 관통 순서를 세지 않는다
    const wave = c.kind === 'wave' || c.kind === 'waveStab';
    const shot = Number(c.shotId) | 0;
    if (!wave) myShot = shot && shot === myShot.id ? { id: shot, n: myShot.n + 1 } : { id: shot, n: 0 };
    const me = last && last.players.find((p) => p.id === meId);
    const hit = zombieHitDamage(c, perks, { boss: !!(z && z.boss), hpFrac: z ? z.hpFrac : 1 }, { myHpFrac: me ? me.hp / Math.max(1, me.maxHp) : 1, nth: wave ? 0 : myShot.n, air: airNow() });
    if (!hit) return;
    // 광란: 총으로 맞힐 때마다 한 겹(칼·검기·수류탄은 쌓지 않는다). 가장 오래된 겹부터 7초 뒤에 끝난다
    if (perks.frenzy > 0 && !wave && !hit.melee) {
      frenzy.push(performance.now() + FRENZY_MS);
      if (frenzy.length > FRENZY_MAX) frenzy.shift();
      applyPerks();
    }
    const at = Array.isArray(c.point) ? c.point : z ? [z.pos[0], z.pos[1] + 1.7, z.pos[2]] : null;
    if (at) W('hordeDamageNumber', at, Math.max(1, Math.round(hit.dmg)), hit.melee ? 'melee' : hit.part);
  }) : null;
  // 무기 교체권: 한 번 바꾸면 교체 창을 닫는다
  const offPick = typeof world.on === 'function' ? world.on('loadoutPick', () => {
    if (!swapTicket || phase === 'prep') return;
    swapTicket = false;
    W('closeSwap');
  }) : null;
  // 내 수류탄 피해 숫자(내 화면이 잰 폭발)
  const offBlast = typeof world.on === 'function' ? world.on('explosion', (x) => {
    if (!x || !x.local || x.kind === 'gravity') return;   // 중력건은 피해가 없다(끌어당기기만)
    for (const v of Array.isArray(x.victims) ? x.victims : []) {
      if (String(v.id)[0] !== 'z') continue;
      const z = zombieOf(v.id);
      if (!z) continue;
      W('hordeDamageNumber', [z.pos[0], z.pos[1] + 1.4 * (z.boss ? z.boss.scale || 1 : 1), z.pos[2]], Math.max(1, Math.round(nadeDamage(v.dmg, perks, !!z.boss, x.kind))), 'nade');
    }
  }) : null;

  W('setPauseDetails', pauseDetails);
  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const f of offs) { try { f(); } catch (e) { /* ignore */ } }
    if (offHit) offHit();
    if (offBlast) offBlast();
    if (offPick) offPick();
    if (canRevive) stopRevive();
    interactSig = '';
    W('setHordeInteract', null);
    if (ui) { ui.hide('cards'); ui.hide('horde'); }
    W('closeSwap');
    W('setHordePerks', null);
    W('setPauseDetails', null);
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
