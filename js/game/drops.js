/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 바닥에 떨어진 주무기 목록. 죽은 뒤 G로 버린 총을 모아 두고 형식 검사, 개수 상한, 수명, 줍는 거리 판정을 맡는다.
 *          three.js·엔진·DOM에 의존하지 않아 node 테스트에서 그대로 쓴다. 그리기와 입력은 world.js, 전달은 session.js가 한다.
 */
import { getDef } from '../weapons/defs.js';

/** 아무도 줍지 않으면 사라지는 시간(ms). 팀전은 라운드가 바뀔 때도 사라진다 */
export const DROP_TTL_MS = 4000;
/** 바닥에 동시에 있는 총 상한. 넘으면 오래된 것부터 사라진다(남이 보낸 메시지로 화면이 차지 않게) */
export const DROP_MAX = 16;
/** 줍는 거리(수평, m) */
export const DROP_RADIUS = 1.25;
/** 줍는 높이 차(m) */
export const DROP_HEIGHT = 2;

const MAX_ID = 64;

/**
 * 믿을 수 없는 입력을 온전한 항목으로 바꾼다. 총(주무기·보조무기)이 아니거나, 위치가 틀렸거나, 탄이 하나도 없으면 null.
 * 탄약은 그 무기의 최대를 넘지 못한다. 프리미엄 총의 예비는 보낸 값과 관계없이 무제한이다.
 * @returns {{ id:string, weaponId:string, pos:number[], mag:number, reserve:number } | null}
 */
export function normalizeDrop(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' ? raw.id : '';
  if (!id || id.length > MAX_ID) return null;
  const def = getDef(raw.weaponId);
  if (!def || (def.slot !== 1 && def.slot !== 2)) return null;
  const p = raw.pos;
  if (!Array.isArray(p) || p.length < 3 || !p.slice(0, 3).every(Number.isFinite)) return null;
  const left = (v, max) => (Number.isFinite(v) ? Math.min(max, Math.max(0, Math.floor(v))) : 0);
  const mag = left(raw.mag, def.mag);
  const reserve = def.reserve === Infinity ? Infinity : left(raw.reserve, def.reserve);
  if (mag <= 0 && reserve <= 0) return null;
  return { id, weaponId: def.id, pos: [p[0], p[1], p[2]], mag, reserve };
}

/** @param {{ now?: () => number }} [opts] now = 시계(ms) */
export function createDrops({ now = () => performance.now() } = {}) {
  const items = new Map();   // id → { ...항목, at }. 넣은 순서를 지킨다

  return {
    get size() { return items.size; },
    /**
     * 넣는다. 같은 id가 있거나 형식이 틀리면 drop이 null이다.
     * @returns {{ drop: object|null, evicted: object[] }} evicted = 상한 때문에 밀려난 항목
     */
    add(raw) {
      const d = normalizeDrop(raw);
      if (!d || items.has(d.id)) return { drop: null, evicted: [] };
      const evicted = [];
      while (items.size >= DROP_MAX) {
        const oldest = items.keys().next().value;
        evicted.push(items.get(oldest));
        items.delete(oldest);
      }
      const item = { ...d, at: now() };
      items.set(d.id, item);
      return { drop: item, evicted };
    },
    /** 빼낸 항목을 돌려준다. 없으면 null */
    remove(id) {
      const d = items.get(id);
      if (!d) return null;
      items.delete(id);
      return d;
    },
    list: () => [...items.values()],
    /** 전부 비우고 비운 항목을 돌려준다 */
    clear() {
      const all = [...items.values()];
      items.clear();
      return all;
    },
    /** 수명이 다한 항목을 빼서 돌려준다 */
    expire(t = now()) {
      const gone = [];
      for (const d of items.values()) if (t - d.at >= DROP_TTL_MS) gone.push(d);
      for (const d of gone) items.delete(d.id);
      return gone;
    },
    /** pos([x,y,z])에서 주울 수 있는 가장 가까운 항목. accept(d)가 false인 항목은 건너뛴다. 없으면 null */
    nearest(pos, accept = null) {
      let best = null, bestD = Infinity;
      for (const d of items.values()) {
        if (Math.abs(d.pos[1] - pos[1]) > DROP_HEIGHT) continue;
        if (accept && !accept(d)) continue;
        const dist = Math.hypot(d.pos[0] - pos[0], d.pos[2] - pos[2]);
        if (dist <= DROP_RADIUS && dist < bestD) { best = d; bestD = dist; }
      }
      return best;
    },
  };
}
