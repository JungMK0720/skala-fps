/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 배틀로얄 가방(인벤토리) 규칙. 가방 등급별 상한(탄약 계열별 예비 탄 · 투척 합계 · 구급상자), 탄약 계열, 부착물 종류와
 *          장착 가능 여부·더 좋은지·스탯 효과(탄창·반동·조준 속도·배율·소염)를 정한다. three.js·DOM 없이 node 테스트에서 그대로 쓴다.
 *          손에 든 무기와의 연결은 br/kit.js, 봇 쪽 사용은 br/solo.js. 계약: docs/MODES.md 15절
 */
import { getDef } from '../../weapons/defs.js';

/** 가방 등급(0 = 가방 없음 ~ 3 = 대형). ammo = 탄약 계열 하나의 기본 상한(계열 배율을 곱한다), throws = 투척 합계, medkits = 구급상자 */
export const PACK_TIERS = Object.freeze([
  Object.freeze({ tier: 0, key: 'game.br.pack.t0', ammo: 60, throws: 2, medkits: 2 }),
  Object.freeze({ tier: 1, key: 'game.br.pack.t1', ammo: 120, throws: 3, medkits: 3 }),
  Object.freeze({ tier: 2, key: 'game.br.pack.t2', ammo: 180, throws: 5, medkits: 4 }),
  Object.freeze({ tier: 3, key: 'game.br.pack.t3', ammo: 240, throws: 7, medkits: 5 })
]);
export const PACK_MAX_TIER = PACK_TIERS.length - 1;

/** 탄약 계열. scale = 가방 상한에 곱하는 배율(산탄·저격탄은 한 발이 세서 적게 든다) */
export const AMMO_FAMILIES = Object.freeze({
  light: Object.freeze({ key: 'game.br.ammo.light', scale: 1 }),
  rifle: Object.freeze({ key: 'game.br.ammo.rifle', scale: 1 }),
  shell: Object.freeze({ key: 'game.br.ammo.shell', scale: 0.5 }),
  sniper: Object.freeze({ key: 'game.br.ammo.sniper', scale: 0.25 })
});
export const AMMO_FAMILY_IDS = Object.freeze(Object.keys(AMMO_FAMILIES));

/** 무기 종류(def.kind) → 탄약 계열 */
const KIND_FAMILY = Object.freeze({ pistol: 'light', smg: 'light', rifle: 'rifle', dmr: 'rifle', lmg: 'rifle', shotgun: 'shell', sniper: 'sniper' });

/** 이 무기가 쓰는 탄약 계열. 탄창이 없는 무기(칼·투척)나 모르는 종류는 null */
export function ammoFamily(weaponId) {
  const d = getDef(weaponId);
  if (!d || d.mag == null) return null;
  return KIND_FAMILY[d.kind] || null;
}

/** 가방 등급 → 계열 fam의 예비 탄 상한 */
export function ammoCap(tier, fam) {
  const t = PACK_TIERS[clampTier(tier)];
  const f = AMMO_FAMILIES[fam];
  return f ? Math.round(t.ammo * f.scale) : 0;
}

/** 배틀로얄에서 줍는 투척 무기 id. 정의가 있는 것만(연막·섬광은 다른 모듈이 무기 표에 더한다) */
const THROW_CANDIDATES = Object.freeze(['gr_frag', 'gr_smoke', 'gr_flash']);
export function throwableIds() {
  return THROW_CANDIDATES.filter((id) => { const d = getDef(id); return !!d && d.slot === 4 && !d.zombieOnly; });
}

/* ============================================================ 부착물 */

const RIFLES = Object.freeze(['rifle', 'dmr']);
/** 부착물. slot = 끼우는 자리(총 하나에 자리마다 하나), rank = 같은 자리에서 더 좋은 정도(높을수록 좋다, 같으면 바꾸지 않는다), kinds = 끼울 수 있는 def.kind */
export const ATTACHMENTS = Object.freeze({
  op_red: Object.freeze({ id: 'op_red', slot: 'optic', rank: 1, key: 'game.br.att.op_red', zoomMag: 1.25, inMul: 0.75, kinds: Object.freeze([...RIFLES, 'smg', 'shotgun', 'lmg']) }),
  op_2x: Object.freeze({ id: 'op_2x', slot: 'optic', rank: 2, key: 'game.br.att.op_2x', zoomMag: 2, inMul: 0.9, kinds: Object.freeze([...RIFLES, 'smg', 'shotgun', 'lmg']) }),
  op_4x: Object.freeze({ id: 'op_4x', slot: 'optic', rank: 3, key: 'game.br.att.op_4x', zoomMag: 4, inMul: 1.25, scope: true, kinds: RIFLES }),
  op_6x: Object.freeze({ id: 'op_6x', slot: 'optic', rank: 4, key: 'game.br.att.op_6x', zoomMag: 6, inMul: 1.4, scope: true, kinds: Object.freeze([...RIFLES, 'sniper']) }),
  gp_vert: Object.freeze({ id: 'gp_vert', slot: 'grip', rank: 1, key: 'game.br.att.gp_vert', recoilV: 0.8, kinds: Object.freeze([...RIFLES, 'smg', 'lmg']) }),
  gp_angle: Object.freeze({ id: 'gp_angle', slot: 'grip', rank: 1, key: 'game.br.att.gp_angle', recoilH: 0.85, adsMul: 0.8, kinds: Object.freeze([...RIFLES, 'smg', 'lmg']) }),
  mg_ext: Object.freeze({ id: 'mg_ext', slot: 'mag', rank: 1, key: 'game.br.att.mg_ext', magMul: 1.5, kinds: Object.freeze(['rifle', 'dmr', 'smg']) }),
  mz_hider: Object.freeze({ id: 'mz_hider', slot: 'muzzle', rank: 1, key: 'game.br.att.mz_hider', flash: 0.3, kinds: Object.freeze([...RIFLES, 'smg', 'sniper', 'lmg']) })
});
export const ATTACH_IDS = Object.freeze(Object.keys(ATTACHMENTS));
export const ATTACH_SLOTS = Object.freeze(['optic', 'grip', 'mag', 'muzzle']);
/** 쌍권총처럼 부착물을 끼울 자리가 없는 총 */
const NO_ATTACH = new Set(['sm_uzi_dual']);

/** 부착물 attId를 무기 weaponId에 끼울 수 있는가(주무기만) */
export function canAttach(attId, weaponId) {
  const a = ATTACHMENTS[attId];
  const d = getDef(weaponId);
  if (!a || !d || d.slot !== 1 || NO_ATTACH.has(d.id)) return false;
  return a.kinds.includes(d.kind);
}

/**
 * att({ optic, grip, mag, muzzle } 자리 → 부착물 id)를 단 총에 attId를 끼우면 좋아지는가.
 * 자리가 비었으면 좋아지고, 차 있으면 rank가 더 높을 때만(같은 rank끼리는 바꾸지 않는다)
 */
export function isUpgrade(attId, att, weaponId) {
  const a = ATTACHMENTS[attId];
  if (!a || !canAttach(attId, weaponId)) return false;
  const cur = att && att[a.slot] ? ATTACHMENTS[att[a.slot]] : null;
  return !cur || a.rank > cur.rank;
}

/**
 * 부착물이 단 총의 스탯 배율. 무기 모듈(weapons/logic.js setBag)이 그대로 읽는다.
 * → { mag(탄창 배율), recoilV(세로 반동), recoilH(가로 반동), flash(총구 불꽃 크기), quiet(소염), zoom(조준 정의 | undefined = 원래대로) }
 */
export function attachStats(weaponId, att) {
  const d = getDef(weaponId);
  const out = { mag: 1, recoilV: 1, recoilH: 1, flash: 1, quiet: false, zoom: undefined };
  if (!d || !att) return out;
  let ads = 1;
  for (const slot of ATTACH_SLOTS) {
    const a = ATTACHMENTS[att[slot]];
    if (!a || !canAttach(a.id, d.id)) continue;
    if (a.magMul) out.mag *= a.magMul;
    if (a.recoilV) out.recoilV *= a.recoilV;
    if (a.recoilH) out.recoilH *= a.recoilH;
    if (a.adsMul) ads *= a.adsMul;
    if (a.flash) { out.flash *= a.flash; out.quiet = true; }
  }
  const optic = ATTACHMENTS[att.optic];
  const base = d.zoom;
  if (optic && canAttach(optic.id, d.id)) out.zoom = opticZoom(base, optic, ads);
  else if (ads !== 1 && base) out.zoom = Object.freeze({ ...base, inTime: base.inTime * ads, outTime: base.outTime * ads });
  return out;
}

/** 기본 조준(없으면 가벼운 기본값)에 조준경을 얹은 조준 정의 */
function opticZoom(base, optic, ads) {
  const z = base || { mag: 1, inTime: 0.16, outTime: 0.11, accurateAt: null, overlay: null, hideViewmodelAt: null, moveMul: 0.85, unzoomOnFire: false };
  const inMul = optic.inMul * ads;
  const out = { ...z, inTime: z.inTime * inMul, outTime: z.outTime * Math.min(1, inMul), optic: optic.id };
  if (z.levels) {
    // 다단 줌 저격총: 첫 단계만 조준경 배율로 올린다(더 높은 단계는 그대로)
    const lv = z.levels.map((m, i) => (i === 0 ? Math.max(m, optic.zoomMag) : m));
    out.levels = Object.freeze(lv.map((m, i) => (i > 0 ? Math.max(m, lv[i - 1]) : m)));
  } else out.mag = Math.max(optic.zoomMag, z.mag || 1);
  if (optic.scope) {
    out.overlay = 'scope';
    out.reticle = z.overlay === 'scope' ? z.reticle || null : 'optic';
    if (out.hideViewmodelAt == null) out.hideViewmodelAt = 0.9;
  }
  return Object.freeze(out);
}

/* ============================================================ 가방 */

const clampTier = (t) => Math.max(0, Math.min(PACK_MAX_TIER, Math.floor(Number(t)) || 0));
const whole = (n) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

/**
 * 가방 하나(사람 하나). 상한을 넘게 주우면 들어가는 만큼만 받고, 받은 수를 돌려준다.
 * @param {{ tier?: number }} [o]
 */
export function createPack(o = {}) {
  let tier = clampTier(o.tier);
  let medkits = 0;
  const ammo = Object.fromEntries(AMMO_FAMILY_IDS.map((f) => [f, 0]));
  const throws = Object.create(null);
  const caps = () => PACK_TIERS[tier];
  const throwTotal = () => Object.values(throws).reduce((s, n) => s + n, 0);

  return {
    get tier() { return tier; },
    get medkits() { return medkits; },
    get medkitCap() { return caps().medkits; },
    get throwCap() { return caps().throws; },
    throwTotal,
    ammoOf: (fam) => (fam in ammo ? ammo[fam] : 0),
    ammoCap: (fam) => ammoCap(tier, fam),
    /** 계열 fam에 n발을 넣는다 → 넣은 수(상한까지만) */
    addAmmo(fam, n) {
      if (!(fam in ammo)) return 0;
      const take = Math.min(whole(n), Math.max(0, ammoCap(tier, fam) - ammo[fam]));
      ammo[fam] += take;
      return take;
    },
    /** 계열 fam에서 n발을 꺼낸다 → 꺼낸 수 */
    useAmmo(fam, n) {
      if (!(fam in ammo)) return 0;
      const used = Math.min(whole(n), ammo[fam]);
      ammo[fam] -= used;
      return used;
    },
    throwOf: (id) => throws[id] || 0,
    /** 투척 무기 id를 n개 넣는다(모든 투척의 합계가 상한까지) → 넣은 수 */
    addThrow(id, n) {
      if (!throwableIds().includes(id)) return 0;
      const take = Math.min(whole(n), Math.max(0, caps().throws - throwTotal()));
      if (take) throws[id] = (throws[id] || 0) + take;
      return take;
    },
    /** 투척 무기 id를 n개 쓴다 → 쓴 수 */
    useThrow(id, n = 1) {
      const used = Math.min(whole(n), throws[id] || 0);
      if (used) throws[id] -= used;
      return used;
    },
    /** 구급상자 n개를 넣는다 → 넣은 수 */
    addMedkit(n = 1) {
      const take = Math.min(whole(n), Math.max(0, caps().medkits - medkits));
      medkits += take;
      return take;
    },
    /** 구급상자 하나를 쓴다 → 썼으면 true */
    useMedkit() {
      if (medkits <= 0) return false;
      medkits--;
      return true;
    },
    /**
     * 가방을 줍는다. 지금보다 좋은 등급일 때만 바꾸고, 메고 있던 가방(등급 1 이상)은 dropTier로 돌려준다(바닥에 놓는 것은 부르는 쪽).
     * → { ok, dropTier }
     */
    offerBackpack(t) {
      const next = clampTier(t);
      if (next <= tier) return { ok: false, dropTier: 0 };
      const old = tier;
      tier = next;
      return { ok: true, dropTier: old };
    },
    /** 출격: 가방 없음, 모두 비움 */
    reset() {
      tier = 0; medkits = 0;
      for (const f of AMMO_FAMILY_IDS) ammo[f] = 0;
      for (const k of Object.keys(throws)) delete throws[k];
    },
    /** 탈락: 가진 것을 모두 꺼내 비운다 → { tier, medkits, ammo:{fam:n}, throws:{id:n} } */
    empty() {
      const out = { tier, medkits, ammo: { ...ammo }, throws: { ...throws } };
      this.reset();
      return out;
    },
    snapshot: () => ({ tier, medkits, ammo: { ...ammo }, throws: { ...throws } })
  };
}
