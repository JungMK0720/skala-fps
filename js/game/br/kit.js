/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 배틀로얄 내 장비(가방 인벤토리). 무기 모듈(weapons/logic.js)에 가방을 걸어 예비 탄·투척 수량·부착물 스탯을 맡고,
 *          칸 1·2 = 주무기 두 자루(아무 종류), 3 = 권총, 4 = 근접, 5 = 투척(누를 때마다 종류 바꾸기)으로 키를 옮긴다.
 *          바닥 보급품 줍기(가방 상한, 부착물 자동 장착·교체), G 버리기, 탈락 때 모두 떨어뜨리기, 구급상자 사용(채널링), HUD 값도 여기서 만든다.
 *          three.js·DOM 없이 node 테스트에서 그대로 쓴다. 그리기·입력 연결은 game/world.js. 계약: docs/MODES.md 15절
 */
import { getDef } from '../../weapons/defs.js';
import { t, loc } from '../../core/i18n.js';
import { BR } from './rules.js';
import { createPack, ammoFamily, AMMO_FAMILIES, AMMO_FAMILY_IDS, ATTACHMENTS, ATTACH_SLOTS, PACK_TIERS, canAttach, isUpgrade, attachStats, throwableIds } from './pack.js';
import { MEDKIT, createChannel, channelInput } from './medkit.js';

/** 출격할 때 가방에 넣어 주는 경량탄(기본 권총 탄창 2개) */
export const START_LIGHT_AMMO = 24;

/** 바닥 보급품 하나의 이름표 글자(탄약 상자 · 계열 탄약 · 구급상자 · 가방 · 부착물 · 투척) */
export function supplyLabel(d) {
  if (!d) return '';
  const n = Math.max(0, Math.floor(Number(d.n) || 0));
  switch (d.kind) {
    case 'ammo': return AMMO_FAMILIES[d.ref] ? `${t(AMMO_FAMILIES[d.ref].key)} ${n}` : t('game.world.supplyAmmo');
    case 'medkit': return n > 1 ? `${t('game.world.supplyMedkit')} ×${n}` : t('game.world.supplyMedkit');
    case 'backpack': { const p = PACK_TIERS[Number(d.ref)]; return p ? t(p.key) : ''; }
    case 'attach': return ATTACHMENTS[d.ref] ? t(ATTACHMENTS[d.ref].key) : '';
    case 'throw': { const def = getDef(d.ref); return def ? (n > 1 ? `${loc(def, 'name')} ×${n}` : loc(def, 'name')) : ''; }
    default: return '';
  }
}

const gunName = (id) => { const d = getDef(id); return d ? loc(d, 'short') : ''; };
const attName = (id) => (ATTACHMENTS[id] ? t(ATTACHMENTS[id].key) : '');
const freshAtt = () => ({ optic: null, grip: null, mag: null, muzzle: null });

/**
 * @param {{ arsenal: object }} o arsenal = 내 무기 모듈(createArsenal). 배틀로얄이 켜져 있는 동안만 만든다
 */
export function createRoyaleKit({ arsenal }) {
  const pack = createPack();
  /** 주무기 두 자루 { id, mag, att, stats }. 무기 모듈 칸 1에는 guns[act]만 들어 있고, 다른 하나는 등에 멘다(탄창 수만 기억) */
  const guns = [null, null];
  let act = -1;
  const channel = createChannel(MEDKIT.ms);

  const bag = {
    reserve(id) { const f = ammoFamily(id); return f ? pack.ammoOf(f) : null; },
    reserveMax(id) { const f = ammoFamily(id); return f ? pack.ammoCap(f) : 0; },
    useReserve(id, n) { const f = ammoFamily(id); if (f) pack.useAmmo(f, n); },
    count(id) { const d = getDef(id); return d && d.count != null ? pack.throwOf(id) : null; },
    useCount(id, n) { pack.useThrow(id, n); },
    stats(id) { const g = act >= 0 ? guns[act] : null; return g && g.id === id ? g.stats : null; }
  };
  arsenal.setBag(bag);

  const held = () => arsenal.getWeapon();
  const heldSlot = () => held().def.slot;
  const loadout = () => arsenal.getLoadout();
  const busyThrowing = () => { const s = held().state; return s === 'throw'; };
  const setStats = (g) => { g.stats = attachStats(g.id, g.att); };
  const magSizeOf = (g) => { const d = getDef(g.id); return d && d.mag != null ? Math.max(1, Math.round(d.mag * (g.stats ? g.stats.mag : 1))) : 0; };

  /** 들고 있는 칸(배틀로얄 키 1~5) */
  function heldKey() {
    const s = heldSlot();
    return s === 1 ? (act >= 0 ? act + 1 : 1) : s + 1;
  }
  /** 칸 1에 든 총의 지금 탄창 수를 기억해 둔다(등으로 옮기기 전) */
  function stashActive() {
    if (act >= 0 && guns[act]) guns[act].mag = arsenal.getAmmo(guns[act].id).mag;
  }
  /** 등에 멘 총 i를 칸 1로 옮긴다. 칸 1을 들고 있었으면 바로 꺼낸다 */
  function swapTo(i) {
    stashActive();
    act = i;
    arsenal.equipWith(guns[i].id, { mag: guns[i].mag, redraw: true });
  }
  function throwChoices() { return throwableIds().filter((id) => pack.throwOf(id) > 0); }
  /** 투척 칸(무기 모듈 칸 4)에 남은 종류가 들어 있게 맞춘다(던지는 중·들고 있는 중이면 그대로) */
  function syncThrowable() {
    const ids = throwChoices();
    const cur = loadout().grenade;
    if (!ids.length || ids.includes(cur) || heldSlot() === 4) return;
    arsenal.equipWith(ids[0], {});
  }

  /** 이 키로 고를 수 있는 칸 목록 */
  function availableKeys() {
    const out = [];
    if (guns[0]) out.push(1);
    if (guns[1]) out.push(2);
    if (!arsenal.isSlotEmpty(2)) out.push(3);
    out.push(4);
    if (throwChoices().length) out.push(5);
    return out;
  }
  /** 배틀로얄 키 k → 무기 모듈 입력(wi.slot). 주무기 교체·투척 종류 바꾸기는 여기서 한다 */
  function selectKey(k, wi) {
    wi.slot = null;
    if (busyThrowing()) return;
    if (k === 1 || k === 2) {
      const i = k - 1;
      if (!guns[i]) return;
      if (i !== act) swapTo(i);
      wi.slot = 1;
    } else if (k === 5) {
      const ids = throwChoices();
      if (!ids.length) return;
      const cur = loadout().grenade;
      if (heldSlot() === 4) {
        // 이미 투척을 들고 있으면 다음 종류로(들고 있는 칸이라 바로 꺼낸다)
        if (ids.length > 1 || !ids.includes(cur)) arsenal.equipWith(ids[(ids.indexOf(cur) + 1) % ids.length], {});
        return;
      }
      if (!ids.includes(cur)) arsenal.equipWith(ids[0], {});
      wi.slot = 4;
    } else if (k === 3 || k === 4) wi.slot = k - 1;
  }

  /* ---------- 구급상자 ---------- */
  /** E: 쓰는 중이면 취소, 아니면 시작 → 'start' | 'cancel' | 'none'(없음) | 'full'(체력 가득) | 'busy'(던지는 중) */
  function useMedkit(hp) {
    if (channel.active) { channel.cancel(); return 'cancel'; }
    if (pack.medkits <= 0) return 'none';
    if (hp >= 100) return 'full';
    if (!arsenal.interrupt()) return 'busy';
    channel.start();
    return 'start';
  }

  /* ---------- 줍기 ---------- */
  const fail = (hint) => ({ ok: false, hint });
  /** 탄약 n발을 계열 fam에 넣고 남은 수 */
  function addAmmo(fam, n) { return n - pack.addAmmo(fam, n); }
  /** 가진 총들의 탄약 계열(중복 없이) → [{ fam, mag }] */
  function carriedFamilies() {
    const out = new Map();
    const ids = [...guns.filter(Boolean).map((g) => g.id), ...(arsenal.isSlotEmpty(2) ? [] : [loadout().secondary])];
    for (const id of ids) {
      const f = ammoFamily(id);
      const d = getDef(id);
      if (f && d && !out.has(f)) out.set(f, d.mag);
    }
    return out;
  }
  /** 부착물 attId를 끼울 총 번호(들고 있는 주무기 먼저). 없으면 -1 */
  function attachTarget(attId) {
    const order = heldSlot() === 1 && act >= 0 ? [act, 1 - act] : act >= 0 ? [act, 1 - act] : [0, 1];
    return order.find((i) => guns[i] && isUpgrade(attId, guns[i].att, guns[i].id)) ?? -1;
  }
  /** 총 i에 부착물을 끼운다 → 빠진 부착물 id | null. 탄창이 작아지면 넘친 탄은 가방으로 */
  function fitAttach(i, attId) {
    const g = guns[i];
    const slot = ATTACHMENTS[attId].slot;
    const old = g.att[slot];
    g.att = { ...g.att, [slot]: attId };
    setStats(g);
    if (i === act) {
      const over = arsenal.fitMag(g.id);
      if (over) pack.addAmmo(ammoFamily(g.id), over);
    } else {
      const mx = magSizeOf(g);
      if (g.mag > mx) { pack.addAmmo(ammoFamily(g.id), g.mag - mx); g.mag = mx; }
    }
    return old;
  }

  /**
   * 바닥 항목 d를 줍는다(dry면 줍지 않고 주울 수 있는지만 본다).
   * → 실패 { ok:false, hint } · 성공 { ok:true, callout, left(남겨 둘 수량 | null = 다 가져감), spawn:[떨어뜨릴 항목] }
   */
  function offer(d, dry = false) {
    if (!d) return fail('');
    if (!d.kind) return offerGun(d, dry);
    const n = Math.max(1, Math.floor(Number(d.n) || 0));
    const label = supplyLabel(d);
    switch (d.kind) {
      case 'medkit': {
        const room = pack.medkitCap - pack.medkits;
        if (room <= 0) return fail(t('game.world.medkitFull', { n: pack.medkitCap }));
        if (dry) return { ok: true };
        const took = pack.addMedkit(n);
        return { ok: true, callout: t('game.world.picked', { weapon: supplyLabel({ kind: 'medkit', n: took }) }), left: n - took || null, spawn: [] };
      }
      case 'ammo': {
        if (AMMO_FAMILIES[d.ref]) {
          const fam = d.ref;
          if (pack.ammoOf(fam) >= pack.ammoCap(fam)) return fail(t('game.br.ammoFamFull', { ammo: t(AMMO_FAMILIES[fam].key), n: pack.ammoCap(fam) }));
          if (dry) return { ok: true };
          const took = pack.addAmmo(fam, n);
          return { ok: true, callout: t('game.br.ammoTook', { ammo: t(AMMO_FAMILIES[fam].key), n: took }), left: n - took || null, spawn: [] };
        }
        // 탄약 상자: 가진 총의 계열마다 탄창 BR.ammoMags개 분량
        const fams = carriedFamilies();
        const room = [...fams.keys()].some((f) => pack.ammoOf(f) < pack.ammoCap(f));
        if (!room) return fail(t('game.world.ammoFull'));
        if (dry) return { ok: true };
        for (const [f, mag] of fams) pack.addAmmo(f, mag * BR.ammoMags);
        return { ok: true, callout: t('game.world.picked', { weapon: label }), left: null, spawn: [] };
      }
      case 'backpack': {
        const tier = Number(d.ref);
        if (!(tier > pack.tier)) return fail(t('game.br.packWorse', { pack: t(PACK_TIERS[pack.tier].key) }));
        if (dry) return { ok: true };
        const r = pack.offerBackpack(tier);
        const spawn = r.dropTier > 0 ? [{ kind: 'backpack', ref: String(r.dropTier), n: 1 }] : [];
        return { ok: true, callout: t('game.br.packOn', { pack: label }), left: null, spawn };
      }
      case 'attach': {
        if (!ATTACHMENTS[d.ref]) return fail('');
        const i = attachTarget(d.ref);
        if (i < 0) {
          const fits = guns.some((g) => g && canAttach(d.ref, g.id));
          return fail(fits ? t('game.br.attHave', { att: label }) : t('game.br.attNoGun', { att: label }));
        }
        if (dry) return { ok: true };
        const old = fitAttach(i, d.ref);
        const callout = old ? t('game.br.attSwap', { att: label, old: attName(old), weapon: gunName(guns[i].id) }) : t('game.br.attOn', { att: label, weapon: gunName(guns[i].id) });
        return { ok: true, callout, left: null, spawn: old ? [{ kind: 'attach', ref: old, n: 1 }] : [] };
      }
      case 'throw': {
        if (!throwableIds().includes(d.ref)) return fail('');
        if (pack.throwTotal() >= pack.throwCap) return fail(t('game.br.throwFull', { n: pack.throwCap }));
        if (dry) return { ok: true };
        const took = pack.addThrow(d.ref, n);
        syncThrowable();
        return { ok: true, callout: t('game.world.picked', { weapon: supplyLabel({ kind: 'throw', ref: d.ref, n: took }) }), left: n - took || null, spawn: [] };
      }
      default: return fail('');
    }
  }
  /** 총 줍기: 주무기는 빈 주무기 칸(둘 중 하나), 권총은 빈 권총 칸. 총에 딸린 예비 탄은 가방에(넘치면 탄약으로 남긴다) */
  function offerGun(d, dry) {
    const def = getDef(d.weaponId);
    if (!def || (def.slot !== 1 && def.slot !== 2)) return fail('');
    if (def.slot === 1) {
      const i = !guns[0] ? 0 : !guns[1] ? 1 : -1;
      if (i < 0) return fail(null);   // 두 칸 다 찼다: 부르는 쪽이 'G로 버리고 줍기' 안내를 낸다
      if (dry) return { ok: true };
      const g = { id: def.id, mag: Math.max(0, Math.floor(d.mag) || 0), att: freshAtt(), stats: null };
      setStats(g);
      guns[i] = g;
      if (act < 0) { act = i; arsenal.takeWeapon(def.id, { mag: g.mag }); }
    } else {
      if (!arsenal.isSlotEmpty(2)) return fail(null);
      if (dry) return { ok: true };
      arsenal.takeWeapon(def.id, { mag: d.mag });
    }
    const spawn = [];
    const fam = ammoFamily(def.id);
    const res = d.reserve === Infinity ? def.mag * 2 : Math.max(0, Math.floor(d.reserve) || 0);
    const left = fam && res ? addAmmo(fam, res) : 0;
    if (left > 0) spawn.push({ kind: 'ammo', ref: fam, n: left });
    return { ok: true, callout: t('game.world.picked', { weapon: gunName(def.id) }), left: null, spawn };
  }

  /** G: 든 총을 버린다 → { gun:{ id, mag, reserve }, items:[같이 떨어뜨릴 부착물] } | null. 주무기를 버리면 다른 주무기가 칸 1로 온다 */
  function dropHeld() {
    const slot = heldSlot();
    const gun = arsenal.dropHeld();
    if (!gun) return null;
    const items = [];
    if (slot === 1 && act >= 0) {
      const g = guns[act];
      const j = 1 - act;
      guns[act] = null;
      act = -1;
      if (g) {
        for (const s of ATTACH_SLOTS) {
          const a = g.att[s];
          if (!a) continue;
          // 다른 주무기에 더 좋으면 옮겨 끼우고, 아니면 바닥에
          if (guns[j] && isUpgrade(a, guns[j].att, guns[j].id)) { const old = fitAttach(j, a); if (old) items.push({ kind: 'attach', ref: old, n: 1 }); }
          else items.push({ kind: 'attach', ref: a, n: 1 });
        }
      }
      if (guns[j]) { act = j; arsenal.equipWith(guns[j].id, { mag: guns[j].mag }); }
    }
    return { gun, items };
  }

  /** 탈락: 가진 것을 모두 바닥 항목으로 꺼낸다(총 · 부착물 · 계열 탄약 · 투척 · 구급상자 · 가방). 내 장비는 비운다 */
  function deathItems() {
    stashActive();
    channel.cancel();
    const items = [];
    for (const g of guns) {
      if (!g) continue;
      items.push({ weaponId: g.id, mag: g.mag, reserve: 0 });
      for (const s of ATTACH_SLOTS) if (g.att[s]) items.push({ kind: 'attach', ref: g.att[s], n: 1 });
    }
    if (!arsenal.isSlotEmpty(2)) {
      const id = loadout().secondary;
      items.push({ weaponId: id, mag: arsenal.getAmmo(id).mag, reserve: 0 });
    }
    const p = pack.empty();
    for (const f of AMMO_FAMILY_IDS) if (p.ammo[f] > 0) items.push({ kind: 'ammo', ref: f, n: p.ammo[f] });
    for (const [id, n] of Object.entries(p.throws)) if (n > 0) items.push({ kind: 'throw', ref: id, n });
    if (p.medkits > 0) items.push({ kind: 'medkit', n: p.medkits });
    if (p.tier > 0) items.push({ kind: 'backpack', ref: String(p.tier), n: 1 });
    guns[0] = guns[1] = null;
    act = -1;
    return items;
  }

  return {
    pack,
    /** 주무기 두 자루 사본(시험·HUD용) [{ id, mag, att } | null, …] */
    get guns() { stashActive(); return guns.map((g) => (g ? { id: g.id, mag: g.mag, att: { ...g.att } } : null)); },
    /** 칸 1에 든 주무기 번호(-1 = 없음) */
    get active() { return act; },
    get medkits() { return pack.medkits; },
    get medkitCap() { return pack.medkitCap; },
    get channelling() { return channel.active; },
    /** 구급상자 진행 0~1 | null */
    get healProgress() { return channel.progress; },
    heldKey,
    /** 출격(무기 모듈이 권총·칼로 돌아온 뒤): 가방을 비우고 경량탄을 조금 넣는다 */
    reset() {
      pack.reset();
      guns[0] = guns[1] = null;
      act = -1;
      channel.cancel();
      pack.addAmmo('light', START_LIGHT_AMMO);
      arsenal.setBag(bag);
    },
    /**
     * 무기 모듈에 넣기 전 입력 거르기(world tick). 구급상자를 쓰는 중이면 사격·조준·재장전을 막고, 사격·교체는 취소로 받는다.
     * 키 1~5와 휠은 배틀로얄 칸으로 옮긴다 → { cancelled }(구급상자가 이번에 취소됐는가)
     */
    filterInput(wi) {
      let cancelled = false;
      if (channel.active) {
        const r = channelInput(wi);
        if (r.cancel) cancelled = channel.cancel();
      }
      if (wi.slot) selectKey(Number(wi.slot), wi);
      else if (wi.wheel) {
        const keys = availableKeys();
        const k = heldKey();
        const i = keys.indexOf(k);
        const next = keys.length > 1 ? keys[((i < 0 ? 0 : i) + (wi.wheel > 0 ? 1 : -1) + keys.length) % keys.length] : null;
        wi.wheel = 0;
        if (next && next !== k) selectKey(next, wi);
      }
      return { cancelled };
    },
    /** 무기 모듈 update 뒤: 다 던진 투척 종류를 남은 것으로 바꿔 둔다 */
    afterUpdate() { syncThrowable(); },
    useMedkit,
    /** 점프·사망 등으로 구급상자 사용 취소 → 쓰던 중이었으면 true */
    cancelHeal: () => channel.cancel(),
    /** 시뮬레이션 dtMs 진행 → 이번에 다 써서 회복할 양(0 = 아직) */
    stepHeal(dtMs) {
      if (!channel.step(dtMs)) return 0;
      return pack.useMedkit() ? MEDKIT.heal : 0;
    },
    offer,
    dropHeld,
    deathItems,
    /** 지금 든 무기의 부착물 스탯(총구 불꽃·소염) | null */
    heldStats() { return heldSlot() === 1 && act >= 0 && guns[act] ? guns[act].stats : null; },
    /** 지금 든 무기의 부착물 { optic, grip, mag, muzzle } | null(뷰모델에 모형을 붙인다) */
    heldAttach() { return heldSlot() === 1 && act >= 0 && guns[act] ? guns[act].att : null; },
    /** HUD: 무기 칸 다섯(1·2 주무기, 3 권총, 4 근접, 5 투척) · 든 칸 · 인벤토리 패널 값 */
    hud() {
      const lo = loadout();
      const thr = throwChoices();
      const grenade = thr.includes(lo.grenade) ? lo.grenade : thr[0] || null;
      const slots = [guns[0] ? guns[0].id : null, guns[1] ? guns[1].id : null, arsenal.isSlotEmpty(2) ? null : lo.secondary, lo.melee, grenade];
      const fams = carriedFamilies();
      const inv = {
        pack: t(PACK_TIERS[pack.tier].key), tier: pack.tier,
        guns: guns.map((g, i) => (g ? { key: i + 1, name: gunName(g.id), active: i === act, att: ATTACH_SLOTS.filter((s) => g.att[s]).map((s) => attName(g.att[s])) } : null)),
        ammo: AMMO_FAMILY_IDS.filter((f) => fams.has(f) || pack.ammoOf(f) > 0).map((f) => ({ name: t(AMMO_FAMILIES[f].key), n: pack.ammoOf(f), cap: pack.ammoCap(f) })),
        throws: thr.map((id) => ({ name: gunName(id), n: pack.throwOf(id) })), throwN: pack.throwTotal(), throwCap: pack.throwCap,
        medkits: pack.medkits, medkitCap: pack.medkitCap
      };
      return { slots, slot: heldKey(), inv };
    },
    dispose() { channel.cancel(); arsenal.setBag(null); }
  };
}
