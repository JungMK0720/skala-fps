/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 폭파 미션 공용 도우미. 맵의 미션 칸(A·B 구역, 공격·수비 진영 스폰)을 읽고, 구역 안 판정·진영 교대·폭발 피해·화면 문구를 한곳에서 정한다.
 *          경기 엔진(match.js)·봇·연습장·세션·World·맵 검사기가 함께 쓴다. three.js·DOM에 의존하지 않아 node에서 그대로 테스트한다.
 */
/**
 * 맵 데이터의 미션 칸 (docs/MAP_GUIDE.md 10절)
 *
 *   mission: {
 *     sites:   [{ id: 'A', name: 'A 구역 · 서버실', x, y, z, w, h, d }, { id: 'B', ... }],   // x·z = 바닥 중심, y = 바닥 높이, w = x 길이, d = z 길이, h = 높이(기본 3)
 *     attack:  [{ x, z, rotY, y? }, ...],   // 공격 진영 스폰(4곳 이상)
 *     defense: [{ x, z, rotY, y? }, ...]    // 수비 진영 스폰(4곳 이상)
 *   }
 *
 * 공수가 바뀌므로 스폰은 팀이 아니라 진영 기준이다. 팀전·개인전은 맵의 spawns(owner·charterer·ffa)를 그대로 쓴다.
 */
import { toRad } from '../core/consts.js';

export const SITE_IDS = Object.freeze(['A', 'B']);
export const BOMB_TEAMS = Object.freeze(['owner', 'charterer']);

/** 폭파 미션 규칙 기본값(match.js DEFAULT_BOMB_RULES가 이 값을 쓴다). 문서: docs/MODES.md 5절 */
export const BOMB = Object.freeze({
  roundTimeMs: 100000,   // 라운드 1:40(설치되면 이 시계는 멈추고 폭탄 시계가 돈다)
  loadoutMs: 5000,       // 무기 선택
  roundEndMs: 5000,      // 라운드 결과 표시
  plantMs: 3000,         // 설치: 구역 안에서 멈춘 채 E 3초
  defuseMs: 5000,        // 해체: 폭탄 1.5 m 안에서 E 5초
  fuseMs: 35000,         // 설치 뒤 폭발까지
  swapAfter: 2,          // 이 라운드 수가 끝나면 공수 교대(그 뒤 라운드는 후반 진영 그대로)
  defuseRange: 1.5,      // 해체할 수 있는 폭탄과의 수평 거리(m)
  pickupRange: 1.2,      // 떨어진 폭탄을 줍는 수평 거리(m)
  reachY: 1.6,           // 해체·줍기에서 허용하는 높이 차(m)
  moveCancel: 0.6,       // 설치·해체 중 이만큼(수평 m) 움직이면 취소
  blastRadius: 16,       // 폭발 피해가 닿는 거리(m)
  blastLethal: 7,        // 이 안은 즉사(500 피해)
  blastMax: 160          // 그 밖은 blastLethal에서 160 → blastRadius에서 0으로 줄어든다
});

/** 폭탄 상태 */
export const BOMB_STATES = Object.freeze(['none', 'carried', 'dropped', 'planted', 'defused', 'exploded']);
/** 라운드가 끝난 사유(폭파 미션) → 화면 문구 */
export const BOMB_REASON_LABELS = Object.freeze({
  bomb: '폭탄 폭파',
  defuse: '폭탄 해체',
  elimination: '전멸',
  time: '시간 종료',
  draw: '무승부'
});
/** 설치·해체 취소 사유 → 화면 문구 */
export const BOMB_CANCEL_LABELS = Object.freeze({
  moved: '움직여서 취소됐어요',
  fired: '공격해서 취소됐어요',
  died: '쓰러져서 취소됐어요',
  released: '',
  left: '',
  round: ''
});
export const SIDE_NAME = Object.freeze({ attack: '공격', defense: '수비' });

const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(+v) ? +v : d);
const r2 = (v) => Math.round(v * 100) / 100;

export function otherTeam(t) { return t === 'owner' ? 'charterer' : t === 'charterer' ? 'owner' : null; }

/**
 * 이 라운드의 공격 팀. round는 1부터(이어받은 경기는 전체 라운드 번호). swapAfter 라운드가 끝나면 교대한다.
 * 기본: 1·2라운드는 firstAttack, 3라운드부터는 상대 팀(5라운드도 후반 진영 그대로).
 */
export function sideFor(round, firstAttack = 'owner', swapAfter = BOMB.swapAfter) {
  const first = firstAttack === 'charterer' ? 'charterer' : 'owner';
  const r = Math.max(1, Math.floor(num(round, 1)));
  const n = Math.max(1, Math.floor(num(swapAfter, BOMB.swapAfter)));
  return r <= n ? first : otherTeam(first);
}
/** 그 팀이 이 라운드에 'attack'인지 'defense'인지(팀이 없으면 null) */
export function sideOfTeam(team, attackTeam) {
  if (team !== 'owner' && team !== 'charterer') return null;
  return team === attackTeam ? 'attack' : 'defense';
}

function normSite(s, i) {
  if (!s || typeof s !== 'object') return null;
  const x = num(s.x, NaN), z = num(s.z, NaN), w = num(s.w, NaN), d = num(s.d, NaN);
  if (!Number.isFinite(x) || !Number.isFinite(z) || !(w > 0) || !(d > 0)) return null;
  const y = num(s.y, 0);
  const h = num(s.h, 3) > 0 ? num(s.h, 3) : 3;
  const id = typeof s.id === 'string' && s.id.trim() ? s.id.trim().slice(0, 4).toUpperCase() : SITE_IDS[i] || String(i + 1);
  const name = typeof s.name === 'string' && s.name.trim() ? s.name.trim().slice(0, 32) : `${id} 구역`;
  return Object.freeze({
    id, name, x: r2(x), y: r2(y), z: r2(z), w: r2(w), h: r2(h), d: r2(d),
    minX: r2(x - w / 2), maxX: r2(x + w / 2), minZ: r2(z - d / 2), maxZ: r2(z + d / 2), minY: r2(y - 0.6), maxY: r2(y + h)
  });
}
function normSpawn(p) {
  if (!p || typeof p !== 'object') return null;
  const x = num(p.x, NaN), z = num(p.z, NaN);
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  const o = { x: r2(x), z: r2(z), rotY: Math.round(toRad(num(p.rotY, 0)) * 1000) / 1000 };
  if (Number.isFinite(num(p.y, NaN))) o.y = r2(num(p.y, 0));
  return o;
}

/**
 * 맵 데이터(또는 미션 칸 자체) → { sites, attack, defense } | null. 구역이 하나도 없으면 null(폭파 미션을 할 수 없는 맵).
 * 같은 id의 구역은 앞의 것만 쓴다. 스폰은 x·z가 있는 것만 남긴다(rotY는 라디안, 도 단위면 바꾼다).
 */
export function normalizeMission(src) {
  const m = src && typeof src === 'object' ? (src.mission && typeof src.mission === 'object' ? src.mission : src) : null;
  if (!m || !Array.isArray(m.sites)) return null;
  const sites = [];
  m.sites.forEach((s, i) => {
    const site = normSite(s, i);
    if (site && !sites.some((q) => q.id === site.id)) sites.push(site);
  });
  if (!sites.length) return null;
  const list = (v) => (Array.isArray(v) ? v.map(normSpawn).filter(Boolean) : []);
  return Object.freeze({ sites: Object.freeze(sites), attack: Object.freeze(list(m.attack)), defense: Object.freeze(list(m.defense)) });
}

/** 이 맵 데이터로 폭파 미션을 할 수 있는가(구역 1곳 이상 + 양 진영 스폰) */
export function hasMission(data) {
  const m = normalizeMission(data);
  return !!(m && m.attack.length && m.defense.length);
}

/**
 * 진영 스폰의 높이를 채운다(맵 빌더의 spawns처럼). findFloor = physics.findFloor, world = 충돌 월드.
 * y를 적은 스폰은 그 높이 근처의 바닥을 쓴다.
 */
export function placeMission(mission, world, findFloor, getGroundY) {
  if (!mission || !world || typeof findFloor !== 'function') return mission || null;
  const place = (p) => {
    const opt = Number.isFinite(p.y) && typeof getGroundY === 'function' ? { fromY: getGroundY(world, p.x, p.z, p.y + 0.5, 0.3) } : undefined;
    const y = findFloor(world, p.x, p.z, opt);
    return Object.freeze({ ...p, y: Number.isFinite(y) ? r2(y) : (p.y ?? 0) });
  };
  return Object.freeze({ sites: mission.sites, attack: Object.freeze(mission.attack.map(place)), defense: Object.freeze(mission.defense.map(place)) });
}

/** [x,y,z] | {x,y,z} → { x, y, z } | null (y가 없으면 null로 둔다) */
export function vecOf(p) {
  if (!p || typeof p !== 'object') return null;
  const a = Array.isArray(p) ? p : [p.x, p.y, p.z];
  const x = num(a[0], NaN), y = num(a[1], NaN), z = num(a[2], NaN);
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  return { x, y: Number.isFinite(y) ? y : null, z };
}

/** 발 위치가 구역 상자 안인가. pad만큼 상자를 넓혀(+) 또는 좁혀(−) 본다. 높이를 모르면 수평만 본다 */
export function siteContains(site, pos, pad = 0) {
  const p = vecOf(pos);
  if (!site || !p) return false;
  if (p.x < site.minX - pad || p.x > site.maxX + pad || p.z < site.minZ - pad || p.z > site.maxZ + pad) return false;
  return p.y == null || (p.y >= site.minY && p.y <= site.maxY);
}
/** 발 위치가 들어 있는 구역(없으면 null) */
export function siteAt(sites, pos, pad = 0) {
  if (!Array.isArray(sites)) return null;
  for (const s of sites) if (siteContains(s, pos, pad)) return s;
  return null;
}
/** 구역 중심(바닥) { x, y, z } */
export function siteCenter(site) { return site ? { x: site.x, y: site.y, z: site.z } : null; }

/** 두 점의 수평 거리와 높이 차 */
export function reach(a, b) {
  const p = vecOf(a), q = vecOf(b);
  if (!p || !q) return { d: Infinity, dy: Infinity };
  return { d: Math.hypot(p.x - q.x, p.z - q.z), dy: p.y == null || q.y == null ? 0 : Math.abs(p.y - q.y) };
}
/** b가 a에서 range m 안(수평)이고 높이 차가 reachY 안인가 */
export function within(a, b, range, reachY = BOMB.reachY) {
  const r = reach(a, b);
  return r.d <= range && r.dy <= reachY;
}

/** 폭발 중심에서 dist m 떨어진 사람이 받는 피해(정수). blastLethal 안은 500(즉사), blastRadius 밖은 0 */
export function blastDamage(dist, rules = BOMB) {
  const d = Math.max(0, num(dist, Infinity));
  const lethal = num(rules.blastLethal, BOMB.blastLethal), radius = num(rules.blastRadius, BOMB.blastRadius), max = num(rules.blastMax, BOMB.blastMax);
  if (d <= lethal) return 500;
  if (d >= radius) return 0;
  return Math.round(max * (1 - (d - lethal) / Math.max(0.01, radius - lethal)));
}

/** 폭발까지 남은 시간(ms) → 삐 소리 간격(ms). 처음 1초 간격에서 마지막 10초 0.25초, 마지막 3초 0.12초까지 빨라진다 */
export function beepInterval(leftMs, fuseMs = BOMB.fuseMs) {
  const left = Math.max(0, num(leftMs, 0));
  if (left <= 3000) return 120;
  if (left <= 10000) return 250;
  const k = Math.min(1, (left - 10000) / Math.max(1, fuseMs - 10000));
  return Math.round(250 + 750 * k);
}

/**
 * 화면 문구(HUD 목표 줄). side = 'attack'|'defense'|null, bomb = view.bomb(applySnapshot 모양), siteName(id) → 이름
 * → { goal, status, tone }
 */
export function bombTexts(side, bomb, opts = {}) {
  const b = bomb || {};
  const nameOf = typeof opts.nameOf === 'function' ? opts.nameOf : (id) => String(id || '');
  const siteName = b.site ? `${b.site} 구역` : '';
  const me = opts.me != null ? String(opts.me) : null;
  let goal = '', status = '', tone = '';
  if (b.state === 'planted') {
    goal = side === 'attack' ? `${siteName} 폭탄을 지키세요` : side === 'defense' ? `${siteName} 폭탄을 해체하세요` : `${siteName}에 폭탄이 설치됐어요`;
    status = `💣 ${siteName}에 설치됨`;
    tone = 'warn';
  } else if (b.state === 'defused') {
    goal = '폭탄이 해체됐어요'; status = '✂️ 폭탄 해체'; tone = 'defense';
  } else if (b.state === 'exploded') {
    goal = '폭탄이 터졌어요'; status = '💥 폭탄 폭파'; tone = 'attack';
  } else {
    goal = side === 'attack' ? 'A 또는 B 구역에 폭탄을 설치하세요' : side === 'defense' ? 'A·B 구역을 지키세요' : '폭파 미션';
    if (side === 'attack') {
      if (b.state === 'carried' && b.carrier) status = b.carrier === me ? '💣 내가 폭탄을 들고 있어요' : `💣 ${nameOf(b.carrier)}이(가) 폭탄을 들고 있어요`;
      else if (b.state === 'dropped') status = '💣 폭탄이 떨어졌어요 · 주우러 가세요';
      tone = 'attack';
    } else if (side === 'defense') {
      status = '';   // 수비는 폭탄을 누가 들었는지·떨어졌는지 모른다(설치되면 모두 안다)
      tone = 'defense';
    }
  }
  return { goal, status, tone };
}
