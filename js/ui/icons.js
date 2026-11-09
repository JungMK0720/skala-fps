/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 도형으로 그린 아이콘(외부 이미지 없음)과 메뉴 배경, 무기·맵 정보 조회. 맵 아이콘은 맵을 위에서 본 단순한 평면도다.
 */
import { svg } from './dom.js';

// ---------- 맵 미니 아이콘 (viewBox 0 0 48 32) ----------
const fill = (d) => svg('path', { d, class: 'sk-ic-fill' });
const line = (d) => svg('path', { d, class: 'sk-ic-line' });
const accent = (d) => svg('path', { d, class: 'sk-ic-accent' });
const ring = (cx, cy, r, cls = 'sk-ic-line') => svg('circle', { cx, cy, r, class: cls });

const MAP_DRAW = {
  // 난간 안 옥상: 위아래 계단실, 가운데 옥탑방, 처진 빨랫줄 둘
  rooftop: () => [
    line('M12 3 H36 V29 H12 Z'),
    fill('M21 3 h6 v3 h-6 Z M21 26 h6 v3 h-6 Z M20 13 h8 v6 h-8 Z'),
    accent('M14 9 Q19 12 24 9 M24 23 Q29 26 34 23'),
  ],
  // 유리 온실: 양끝 분갈이실, 가운데 단상과 선인장
  glasshouse: () => [
    line('M4 5 H44 V27 H4 Z'),
    fill('M4 11 h5 v10 h-5 Z M39 11 h5 v10 h-5 Z'),
    ring(24, 16, 5),
    accent('M24 12 V20 M24 16 H21 V13 M24 17 H27 V14'),
  ],
  // 양쪽에서 평행한 골목 셋이 가운데 광장으로 모인다
  alley: () => [
    line('M3 6 H17 M3 16 H17 M3 26 H17 M45 6 H31 M45 16 H31 M45 26 H31'),
    accent('M18 9 H30 V23 H18 Z'),
  ],
  // 둥근 안뜰과 기둥, 칼자국
  dojo: () => [
    ring(24, 16, 13),
    fill('M14 8 h3 v3 h-3 Z M31 8 h3 v3 h-3 Z M14 21 h3 v3 h-3 Z M31 21 h3 v3 h-3 Z'),
    accent('M17 23 L31 9'),
  ],
  // 양끝 고지대 사이의 긴 시야선
  longshot: () => [
    fill('M1 28 V14 H8 L13 28 Z M47 28 V14 H40 L35 28 Z'),
    line('M1 28 H47'),
    accent('M9 11 H39'),
  ],
  // 가운데 허브와 세 구역
  nexus: () => [
    line('M24 16 L9 7 M24 16 L39 7 M24 16 V28'),
    fill('M5 4 h8 v6 h-8 Z M35 4 h8 v6 h-8 Z M20 25 h8 v5 h-8 Z'),
    ring(24, 16, 4.5, 'sk-ic-accent'),
  ],
  // 긴 잔교에 곁가지가 붙은 평면
  jetty: () => [
    line('M14 16 V6 M24 16 V26 M34 16 V6'),
    accent('M4 16 H44'),
  ],
  // 큰 원 셋이 흩어진 평면
  tankfarm: () => [
    ring(11, 12, 7),
    ring(30, 11, 8),
    ring(23, 25, 5),
    accent('M38 24 H46'),
  ],
  // 길쭉한 갑판과 가운데 통로
  vlcc: () => [
    svg('rect', { x: 3, y: 9, width: 42, height: 14, rx: 7, class: 'sk-ic-line' }),
    accent('M10 16 H34'),
    fill('M36 12 h5 v8 h-5 Z'),
  ],
  // 알 수 없는 맵: 조준선
  _: () => [
    ring(24, 16, 8.5),
    accent('M24 3 V11 M24 21 V29 M11 16 H19 M29 16 H37'),
  ],
};

export function mapIcon(id, cls = '') {
  // id는 다른 사람이 올린 방 메타일 수 있다. '__proto__' 같은 값이 표의 물려받은 항목을 찾으면 로비 전체를 그리다 던진다
  const draw = typeof id === 'string' && Object.prototype.hasOwnProperty.call(MAP_DRAW, id) ? MAP_DRAW[id] : MAP_DRAW._;
  return svg('svg', { viewBox: '0 0 48 32', class: 'sk-mapico' + (cls ? ' ' + cls : ''), 'aria-hidden': 'true', focusable: 'false' }, draw());
}

// ---------- 헤드샷 아이콘 (조준선 + 머리) ----------
export function headshotIcon() {
  return svg('svg', { viewBox: '0 0 16 16', class: 'sk-hs-ico', role: 'img', 'aria-label': '헤드샷' },
    svg('title', { text: '헤드샷' }),
    svg('circle', { cx: 8, cy: 8, r: 5.2 }),
    svg('path', { d: 'M8 0.8 V4.4 M8 11.6 V15.2 M0.8 8 H4.4 M11.6 8 H15.2' }),
    svg('circle', { cx: 8, cy: 8, r: 1.4, class: 'sk-hs-dot' }));
}

// ---------- 메뉴·화면 아이콘 (viewBox 0 0 24 24, 선으로만 그려 글자색을 따른다) ----------
const UI_ICONS = {
  bolt: () => [svg('path', { d: 'M13 2 L5 13.5 H11 L10 22 L19 9.5 H13 Z' })],
  target: () => [svg('circle', { cx: 12, cy: 12, r: 7.5 }), svg('circle', { cx: 12, cy: 12, r: 2.5 }), svg('path', { d: 'M12 1.5 V6 M12 18 V22.5 M1.5 12 H6 M18 12 H22.5' })],
  globe: () => [svg('circle', { cx: 12, cy: 12, r: 9.5 }), svg('path', { d: 'M2.5 12 H21.5 M12 2.5 C8 7 8 17 12 21.5 C16 17 16 7 12 2.5' })],
  bag: () => [svg('path', { d: 'M5 8 H19 L20.5 21.5 H3.5 Z' }), svg('path', { d: 'M8.5 11 V6.5 a3.5 3.5 0 0 1 7 0 V11' })],
  gear: () => [svg('circle', { cx: 12, cy: 12, r: 3.2 }), svg('circle', { cx: 12, cy: 12, r: 7.2 }), svg('path', { d: 'M12 1.5 V4.8 M12 19.2 V22.5 M1.5 12 H4.8 M19.2 12 H22.5 M4.6 4.6 L6.9 6.9 M17.1 17.1 L19.4 19.4 M4.6 19.4 L6.9 17.1 M17.1 6.9 L19.4 4.6' })],
  keys: () => [svg('rect', { x: 2, y: 6.5, width: 20, height: 11, rx: 2 }), svg('path', { d: 'M6 10.5 H6.5 M10 10.5 H10.5 M14 10.5 H14.5 M18 10.5 H18.5 M7.5 14 H16.5' })],
  user: () => [svg('circle', { cx: 12, cy: 8, r: 4.2 }), svg('path', { d: 'M3.8 21.5 C4.6 16.8 8 14.8 12 14.8 C16 14.8 19.4 16.8 20.2 21.5' })],
  coin: () => [svg('circle', { cx: 12, cy: 12, r: 9.5 }), svg('path', { d: 'M9.5 17 V7.5 H13.2 a3 3 0 0 1 0 6 H9.5' })],
  lock: () => [svg('rect', { x: 5, y: 11, width: 14, height: 10.5, rx: 2 }), svg('path', { d: 'M8 11 V7.5 a4 4 0 0 1 8 0 V11' })],
  check: () => [svg('path', { d: 'M4 12.5 L10 18.5 L20 6.5' })],
};

/** 이름 → 선 아이콘. 크기는 글자 크기(1em)를 따른다. */
export function uiIcon(name, cls = '') {
  const draw = UI_ICONS[name];
  return svg('svg', { viewBox: '0 0 24 24', class: 'sk-uico' + (cls ? ' ' + cls : ''), 'aria-hidden': 'true', focusable: 'false' }, draw ? draw() : []);
}

// ---------- 메뉴 배경: 사선 띠와 네온 선, 큰 조준 고리(추상 도형) ----------
export function menuBackdrop() {
  const path = (d, cls) => svg('path', { d, class: cls });
  const circle = (r) => svg('circle', { cx: 1215, cy: 455, r, class: 'sk-bd-ring' });
  return svg('svg', { viewBox: '0 0 1600 900', preserveAspectRatio: 'xMidYMid slice', class: 'sk-backdrop', 'aria-hidden': 'true', focusable: 'false' },
    path('M930 0 H1600 V900 H360 Z', 'sk-bd-band'),
    path('M1250 0 H1600 V900 H680 Z', 'sk-bd-band sk-bd-band--pink'),
    circle(330), circle(210),
    path('M1215 90 V200 M1215 710 V820 M850 455 H960 M1470 455 H1580', 'sk-bd-ring'),
    path('M930 0 L360 900', 'sk-bd-line sk-bd-line--cyan'),
    path('M1250 0 L680 900', 'sk-bd-line sk-bd-line--pink'));
}

// ---------- 무기 ----------
const SLOT_ICONS = ['', '🎯', '🔫', '🔪', '💣'];

export function guessWeaponIcon(id, slot) {
  const s = String(id == null ? '' : id).toLowerCase();
  if (/sr_|bolt|snip/.test(s)) return '🎯';
  if (/ar_|rifle|assault|\bar\b/.test(s)) return '🔫';
  if (/pt_|pistol/.test(s)) return '🔫';
  if (/cut|knife|ml_|melee/.test(s)) return '🔪';
  if (/gr_frag|grenade|nade|frag/.test(s)) return '💣';
  if (/fall|world|env/.test(s)) return '⚠️';
  return SLOT_ICONS[slot] || '✖';
}

function shortName(name) {
  const first = String(name).split(/\s+/)[0] || '';
  return /[A-Za-z].*\d|\d.*[A-Za-z]/.test(first) ? first : String(name);
}

/** 무기 표에 없는 피해 원인. 폭파 미션의 폭탄 폭발은 킬피드·점수판·결과에서 '💥 폭탄'이다 */
const SPECIAL_WEAPONS = Object.freeze({
  bomb: Object.freeze({ id: 'bomb', name: '폭탄', short: '폭탄', icon: '💥' }),
});
const specialWeapon = (id) => (id != null && Object.prototype.hasOwnProperty.call(SPECIAL_WEAPONS, String(id)) ? SPECIAL_WEAPONS[String(id)] : null);

/** 무기 id(또는 정의 객체) → { id, icon, name, short } */
export function weaponInfo(registry, ref, extra = {}) {
  const isObj = ref && typeof ref === 'object';
  const id = isObj ? ref.id : ref;
  const def = { ...((id != null && registry.get(String(id))) || specialWeapon(id) || {}), ...(isObj ? ref : {}) };
  const name = extra.weaponName || def.name || def.label || (id != null ? String(id) : '');
  return {
    id: id == null ? '' : String(id),
    icon: extra.weaponIcon || def.icon || def.emoji || guessWeaponIcon(id, def.slot),
    name,
    short: extra.weaponShort || def.short || def.code || shortName(name),
    def,
  };
}

// ---------- 맵 ----------
// 엔진이 ui.setMaps()/props.maps로 넘기지 않았을 때만 쓰는 최소 대체값(이름만).
const FALLBACK_MAPS = [
  { id: 'rooftop', name: '빨랫줄 옥상', nameEn: 'Clothesline Roof', desc: '' },
  { id: 'glasshouse', name: '선인장 온실', nameEn: 'Cactus Glasshouse', desc: '' },
  { id: 'alley', name: '항구 골목', nameEn: 'Harbor Alley', desc: '' },
  { id: 'dojo', name: '벚꽃 도장', nameEn: 'Blossom Dojo', desc: '' },
  { id: 'longshot', name: '협곡 저격장', nameEn: 'Long Shot', desc: '' },
  { id: 'nexus', name: '넥서스', nameEn: 'Nexus', desc: '' },
];

/** mission: 폭파 미션을 할 수 있는 맵(A·B 구역이 있음). MAP_LIST 항목에 없으면 false */
export function normMap(m) {
  if (typeof m === 'string') return { id: m, name: m, nameEn: '', desc: '', tag: '', rulesets: null, test: false, mission: false };
  return {
    id: String(m.id), name: m.name || String(m.id), nameEn: m.nameEn || '', desc: m.desc || '',
    tag: m.tag || '', rulesets: Array.isArray(m.rulesets) ? m.rulesets : null, test: !!m.test, mission: m.mission === true,
  };
}

function allMaps(registry, list) {
  if (Array.isArray(list) && list.length) return list.map(normMap);
  if (registry.size) return [...registry.values()];
  return FALLBACK_MAPS.map(normMap);
}

/** 방 만들기·맵 변경에서 고를 수 있는 맵. core 테스트 맵(test:true)은 뺀다(그것뿐이면 그대로). */
export function mapList(registry, list) {
  const all = allMaps(registry, list);
  const real = all.filter((m) => !m.test);
  return real.length ? real : all;
}

/** id → 맵 정보(테스트 맵 포함). 모르는 id면 id를 이름으로 쓴다. */
export function mapInfo(registry, list, id) {
  return allMaps(registry, list).find((m) => m.id === id) || (id ? normMap(String(id)) : null);
}
