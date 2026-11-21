/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 도형으로 그린 아이콘(외부 이미지 없음)과 메뉴 배경, 무기·맵 정보 조회. 맵 아이콘은 맵을 위에서 본 단순한 평면도다.
 */
import { svg } from './dom.js';
import { t, loc } from '../core/i18n.js';

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
  // 훈련장 울타리, 문이 뚫린 가운데 건물, 두 길을 오가는 표적판
  cqb: () => [
    line('M5 5 H43 V27 H5 Z'),
    fill('M14 14 h8 v4 h-8 Z M26 14 h8 v4 h-8 Z'),
    accent('M12 9 H21 M27 23 H36'),
  ],
  // 창고 안의 선반 네 줄과 가운데를 가로지르는 2층 다리
  sorthub: () => [
    line('M3 4 H45 V28 H3 Z'),
    fill('M9 10 h10 v3 h-10 Z M29 10 h10 v3 h-10 Z M9 19 h10 v3 h-10 Z M29 19 h10 v3 h-10 Z'),
    accent('M22 4 V28 M26 4 V28'),
  ],
  // 울타리 안 공터: 가운데 흙더미와 양옆 비탈, 흩어진 흄관과 덤프트럭
  lot: () => [
    line('M3 4 H45 V28 H3 Z'),
    fill('M21 13 h6 v6 h-6 Z M9 22 h8 v3 h-8 Z M31 7 h8 v3 h-8 Z'),
    ring(12, 10, 2.5),
    ring(36, 22, 2.5),
    accent('M15 16 H21 M27 16 H33'),
  ],
  // 운동장: 가운데 선과 가운데 원, 양쪽 골대, 위쪽 구령대
  schoolyard: () => [
    line('M4 6 H44 V28 H4 Z M24 6 V28'),
    ring(24, 17, 4),
    fill('M19 2 h10 v4 h-10 Z'),
    accent('M4 13 H8 V21 H4 M44 13 H40 V21 H44'),
  ],
  // 복도가 두른 방 여섯과 복도 쪽으로 난 문들
  karaoke: () => [
    line('M3 3 H45 V29 H3 Z M10 9 H38 V23 H10 Z M10 16 H38 M19 9 V23 M29 9 V23'),
    accent('M13 9 H16 M23 9 H26 M32 9 H35 M13 23 H16 M22 23 H25 M32 23 H35'),
  ],
  // 마당을 두른 ㅁ자 집채와 마당 쪽 문 넷, 가운데 평상
  hanok: () => [
    line('M5 3 H43 V29 H5 Z M17 11 H31 V21 H17 Z'),
    fill('M22 14.5 h4 v3 h-4 Z'),
    accent('M21 11 H24 M24 21 H27 M17 16 V19 M31 13 V16'),
  ],
  // 서쪽 하역장에서 세 길이 동쪽의 두 구역으로 간다
  relay: () => [
    fill('M3 10 h7 v12 h-7 Z'),
    line('M11 8 H30 M11 16 H30 M11 24 H30'),
    accent('M32 4 h11 v9 h-11 Z M32 19 h11 v9 h-11 Z'),
  ],
  // 가운데에 선 화물 열차와 건널 수 있는 틈 셋, 그 너머의 두 구역
  railyard: () => [
    fill('M21 1 h5 v6 h-5 Z M21 10 h5 v5 h-5 Z M21 18 h5 v5 h-5 Z M21 26 h5 v5 h-5 Z'),
    line('M4 16 H16 M12 12 L16 16 L12 20'),
    accent('M32 4 h11 v9 h-11 Z M32 19 h11 v9 h-11 Z'),
  ],
  // 가운데 안뜰과 돔(A), 축전실(B), 남북의 바깥 길
  observatory: () => [
    line('M17 9 H29 V23 H17 Z M3 5 H30 M3 27 H30'),
    fill('M3 13 h6 v6 h-6 Z'),
    ring(38, 9, 5.5, 'sk-ic-accent'),
    accent('M33 20 h10 v8 h-10 Z'),
  ],
  // 알 수 없는 맵: 조준선
  // 고속도로 휴게소: 위쪽 방음벽, 가운데 편의점, 왼쪽 아래 주유소 캐노피, 오른쪽 아래 주차장, 가장자리의 좀비 문
  restarea: () => [
    line('M3 6 H45 M3 26 H45'),
    fill('M17 9 h14 v7 h-14 Z'),
    line('M6 18 h11 v6 h-11 Z M30 19 h4 v5 h-4 Z M36 19 h4 v5 h-4 Z'),
    accent('M5 3 v2 M43 3 v2 M5 27 v2 M43 27 v2'),
  ],
  // 지하철 환승역: 가운데 섬식 승강장과 기둥, 위아래 선로, 양 끝 터널
  subway: () => [
    line('M3 9 H45 M3 23 H45'),
    fill('M10 14 h2 v4 h-2 Z M18 14 h2 v4 h-2 Z M28 14 h2 v4 h-2 Z M36 14 h2 v4 h-2 Z'),
    accent('M3 6 h3 v6 h-3 M45 6 h-3 v6 h3 M3 20 h3 v6 h-3 M45 20 h-3 v6 h3'),
  ],
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
  return svg('svg', { viewBox: '0 0 16 16', class: 'sk-hs-ico', role: 'img', 'aria-label': t('shop.headshot') },
    svg('title', { text: t('shop.headshot') }),
    svg('circle', { cx: 8, cy: 8, r: 5.2 }),
    svg('path', { d: 'M8 0.8 V4.4 M8 11.6 V15.2 M0.8 8 H4.4 M11.6 8 H15.2' }),
    svg('circle', { cx: 8, cy: 8, r: 1.4, class: 'sk-hs-dot' }));
}

// ---------- 메뉴·화면 아이콘 (viewBox 0 0 24 24, 직접 그린 선 아이콘. 선으로만 그려 글자색을 따른다) ----------
const P = (d) => svg('path', { d });
const C = (cx, cy, r) => svg('circle', { cx, cy, r });
const R = (x, y, width, height) => svg('rect', { x, y, width, height });
const UI_ICONS = {
  bolt: () => [P('M13 2 L5 13.5 H11 L10 22 L19 9.5 H13 Z')],
  target: () => [C(12, 12, 7.5), C(12, 12, 2.5), P('M12 1.5 V6 M12 18 V22.5 M1.5 12 H6 M18 12 H22.5')],
  globe: () => [C(12, 12, 9.5), P('M2.5 12 H21.5 M12 2.5 C8 7 8 17 12 21.5 C16 17 16 7 12 2.5')],
  bag: () => [P('M5 8 H19 L20.5 21.5 H3.5 Z'), P('M8.5 11 V6.5 a3.5 3.5 0 0 1 7 0 V11')],
  gear: () => [C(12, 12, 3.2), C(12, 12, 7.2), P('M12 1.5 V4.8 M12 19.2 V22.5 M1.5 12 H4.8 M19.2 12 H22.5 M4.6 4.6 L6.9 6.9 M17.1 17.1 L19.4 19.4 M4.6 19.4 L6.9 17.1 M17.1 6.9 L19.4 4.6')],
  keys: () => [R(2, 6.5, 20, 11), P('M6 10.5 H6.5 M10 10.5 H10.5 M14 10.5 H14.5 M18 10.5 H18.5 M7.5 14 H16.5')],
  user: () => [C(12, 8, 4.2), P('M3.8 21.5 C4.6 16.8 8 14.8 12 14.8 C16 14.8 19.4 16.8 20.2 21.5')],
  coin: () => [C(12, 12, 9.5), P('M9.5 17 V7.5 H13.2 a3 3 0 0 1 0 6 H9.5')],
  lock: () => [R(5, 11, 14, 10.5), P('M8 11 V7.5 a4 4 0 0 1 8 0 V11')],
  check: () => [P('M4 12.5 L10 18.5 L20 6.5')],
  // 좀비 물량 막기: 해골. 건의하기: 편지 봉투
  skull: () => [P('M12 2.8 C7.1 2.8 4 6.1 4 10.4 C4 13 5.2 14.9 6.8 16 V19.6 a1.4 1.4 0 0 0 1.4 1.4 H15.8 a1.4 1.4 0 0 0 1.4 -1.4 V16 C18.8 14.9 20 13 20 10.4 C20 6.1 16.9 2.8 12 2.8 Z'),
    C(9, 11, 1.9), C(15, 11, 1.9), P('M12 13.8 L11 15.6 H13 Z M10 21 V18.6 M14 21 V18.6')],
  mail: () => [R(2.5, 5, 19, 14), P('M3.5 6.5 L12 13 L20.5 6.5')],
  // 화면 공용: 닫기 · 출격(겹 화살) · 뒤로 · 더하기 · 새로고침 · 정렬
  close: () => [P('M6 6 L18 18 M18 6 L6 18')],
  deploy: () => [P('M4 6 L10 12 L4 18 M11 6 L17 12 L11 18'), P('M20 5 V19')],
  back: () => [P('M10 5 L3 12 L10 19 M3 12 H21')],
  plus: () => [P('M12 4.5 V19.5 M4.5 12 H19.5')],
  refresh: () => [P('M20 12 a8 8 0 1 1 -2.4 -5.7'), P('M20.5 3.5 V8 H16')],
  play: () => [P('M7 4.5 L19 12 L7 19.5 Z')],
  clock: () => [C(12, 12, 9), P('M12 7 V12 L15.5 14')],
  alert: () => [P('M12 3 L22.5 20.5 H1.5 Z'), P('M12 9.5 V14.5 M12 17 V17.6')],
  sort: () => [P('M8 4.5 V19.5 M4.5 16 L8 19.5 L11.5 16 M16 19.5 V4.5 M12.5 8 L16 4.5 L19.5 8')],
  // 무기고(장비 상자) · 요원 기록부(서류철)
  armory: () => [R(3, 8, 18, 12), P('M3 12.5 H21 M10 12.5 V15 H14 V12.5 M7.5 8 L9 4.5 H15 L16.5 8')],
  file: () => [P('M3 5.5 H9.5 L11.5 7.5 H21 V20 H3 Z'), P('M7 12 H17 M7 15.5 H13.5')],
  // 같이 하기 · 혼자 하기 · 방장 · 봇
  squad: () => [C(9, 8, 3.2), C(16.5, 9, 2.6), P('M3 20.5 C3.6 15.8 6.2 14.2 9 14.2 C11.8 14.2 14.4 15.8 15 20.5 M15.4 14.3 C18.2 14.2 20.4 15.8 21 19.5')],
  solo: () => [C(12, 7.5, 3.6), P('M5.5 21 C6.2 15.6 8.8 13.6 12 13.6 C15.2 13.6 17.8 15.6 18.5 21')],
  crown: () => [P('M3 8 L7.5 12.5 L12 5 L16.5 12.5 L21 8 L19 18.5 H5 Z')],
  bot: () => [R(5, 8, 14, 11), C(9.5, 13, 1.3), C(14.5, 13, 1.3), P('M12 4 V8 M2.5 12 V15.5 M21.5 12 V15.5 M9.5 16.5 H14.5')],
  // 채팅 · 지도 · 규칙 · 트로피
  chat: () => [P('M3.5 4.5 H20.5 V16 H11 L6 20 V16 H3.5 Z')],
  map: () => [P('M3 6 L9 4 L15 6 L21 4 V18 L15 20 L9 18 L3 20 Z M9 4 V18 M15 6 V20')],
  rules: () => [R(5, 4, 14, 17), P('M9 4 V2.5 H15 V4 M8.5 10 H15.5 M8.5 13.5 H15.5 M8.5 17 H12.5')],
  trophy: () => [P('M7 3.5 H17 V9 a5 5 0 0 1 -10 0 Z M12 14 V18 M8 21 H16 M7 5.5 H3.5 V7.5 a3.5 3.5 0 0 0 3.5 3.5 M17 5.5 H20.5 V7.5 a3.5 3.5 0 0 1 -3.5 3.5')],
  // 모드: 팀전(맞선 두 칼날) · 폭파 미션(폭탄)
  team: () => [P('M4 4 L14 14 M20 4 L10 14 M4 4 H7.5 M4 4 V7.5 M20 4 H16.5 M20 4 V7.5 M7 17 L4 20 M17 17 L20 20 M5.5 15.5 L8.5 18.5 M18.5 15.5 L15.5 18.5')],
  bomb: () => [C(10.5, 14.5, 6.5), P('M13.6 9.6 L15.6 7.6 L17.6 9.6 L15.6 11.6'), P('M16.6 8.6 C17.4 6.2 18.8 5 20.8 5 M21 2 V3 M23 5 H22')],
  // 무기 종류: 소총 · 저격총 · 권총 · 칼 · 수류탄
  rifle: () => [P('M2 10.5 H15 L16.5 9 H22 V12 H17.5 L16 13.5 H11 L9.5 17.5 H6.5 L8 13.5 H2 Z'), P('M5 10.5 V9')],
  sniper: () => [P('M2 12 H14 L15.5 10.5 H22 V13 H17 L15.5 14.5 H11 L9.5 18 H7 L8.5 14.5 H2 Z'), R(6, 7, 6, 2.5), P('M8 9.5 V12 M10 9.5 V12')],
  pistol: () => [P('M3 7 H20 V11 H11.5 L10.5 13.5 H9 L7.8 19 H4.2 L5.8 11 H3 Z'), P('M11.5 11 V13.5')],
  knife: () => [P('M4 20 L8 16 M6.3 14.3 L9.7 17.7 M8 16 L19.5 4.5 C21 8 18.5 12 12 18.3')],
  grenade: () => [C(11, 14.5, 6), P('M8.5 8.5 V5.5 H13.5 V8.5 M13.5 5.5 L18 3.5 M17 7.5 a2 2 0 1 0 0.01 0')],
  // 이모트(팔 벌린 사람) · 캐릭터(전술 헬멧)
  emote: () => [C(12, 5, 2.4), P('M4.5 8 L12 11 L19.5 8 M12 11 V15 M12 15 L8 21 M12 15 L16 21')],
  helmet: () => [P('M3.5 15.5 C3.5 9.2 7.2 5 12 5 C16.8 5 20.5 9.2 20.5 15.5 Z M2.5 15.5 H21.5 M12 5 V9.5 M7 15.5 V18.5 H11')],
};

/** 이름 → 선 아이콘. 크기는 글자 크기(1em)를 따른다. */
export function uiIcon(name, cls = '') {
  const draw = Object.prototype.hasOwnProperty.call(UI_ICONS, name) ? UI_ICONS[name] : null;
  return svg('svg', { viewBox: '0 0 24 24', class: 'sk-uico' + (cls ? ' ' + cls : ''), 'aria-hidden': 'true', focusable: 'false' }, draw ? draw() : []);
}

/** 모드 → 선 아이콘 이름(dom.js MODE_ICON의 이모지 대신 화면에 그린다) */
export const MODE_GLYPH = Object.freeze({ team: 'team', ffa: 'target', bomb: 'bomb', zombie: 'skull' });
/** 규칙(game/modes.js RULESETS id) → 선 아이콘 이름 */
export const RULE_GLYPH = Object.freeze({ classic: 'rifle', knife: 'knife', sniper: 'sniper' });

/** 무기 id·칸 → 선 아이콘 이름. 저격총은 id로, 나머지는 칸(1 주무기 · 2 보조 · 3 근접 · 4 투척)으로 고른다 */
export function weaponGlyph(id, slot) {
  const s = String(id == null ? '' : id).toLowerCase();
  if (/sr_|bolt|snip/.test(s)) return 'sniper';
  if (/gr_|grenade|nade|frag|flash|smoke/.test(s)) return 'grenade';
  return ({ 1: 'rifle', 2: 'pistol', 3: 'knife', 4: 'grenade' })[slot] || (/pt_|pistol/.test(s) ? 'pistol' : /ml_|knife|melee/.test(s) ? 'knife' : 'rifle');
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
  bomb: Object.freeze({ id: 'bomb', name: '폭탄', nameEn: 'Bomb', short: '폭탄', shortEn: 'Bomb', icon: '💥' }), // i18n-ok: 짝 칸(nameEn·shortEn)을 loc으로 읽는다
});
const specialWeapon = (id) => (id != null && Object.prototype.hasOwnProperty.call(SPECIAL_WEAPONS, String(id)) ? SPECIAL_WEAPONS[String(id)] : null);

/** 무기 id(또는 정의 객체) → { id, icon, name, short } */
export function weaponInfo(registry, ref, extra = {}) {
  const isObj = ref && typeof ref === 'object';
  const id = isObj ? ref.id : ref;
  const def = { ...((id != null && registry.get(String(id))) || specialWeapon(id) || {}), ...(isObj ? ref : {}) };
  const name = extra.weaponName || loc(def, 'name') || def.label || (id != null ? String(id) : '');
  return {
    id: id == null ? '' : String(id),
    icon: extra.weaponIcon || def.icon || def.emoji || guessWeaponIcon(id, def.slot),
    name,
    short: extra.weaponShort || loc(def, 'short') || def.code || shortName(name),
    def,
  };
}

// ---------- 맵 ----------
// 엔진이 ui.setMaps()/props.maps로 넘기지 않았을 때만 쓰는 최소 대체값(이름만).
const FALLBACK_MAPS = [
  { id: 'rooftop', name: '빨랫줄 옥상', nameEn: 'Clothesline Roof', desc: '' }, // i18n-ok: 짝 칸(nameEn)을 loc으로 읽는다
  { id: 'glasshouse', name: '선인장 온실', nameEn: 'Cactus Glasshouse', desc: '' }, // i18n-ok: 짝 칸(nameEn)을 loc으로 읽는다
  { id: 'alley', name: '항구 골목', nameEn: 'Harbor Alley', desc: '' }, // i18n-ok: 짝 칸(nameEn)을 loc으로 읽는다
  { id: 'dojo', name: '벚꽃 도장', nameEn: 'Blossom Dojo', desc: '' }, // i18n-ok: 짝 칸(nameEn)을 loc으로 읽는다
  { id: 'longshot', name: '협곡 저격장', nameEn: 'Long Shot', desc: '' }, // i18n-ok: 짝 칸(nameEn)을 loc으로 읽는다
  { id: 'nexus', name: '넥서스', nameEn: 'Nexus', desc: '' }, // i18n-ok: 짝 칸(nameEn)을 loc으로 읽는다
];

/** mission: 폭파 미션을 할 수 있는 맵(A·B 구역이 있음), zombie: 좀비 물량 막기 전용 맵. MAP_LIST 항목에 없으면 false */
export function normMap(m) {
  if (typeof m === 'string') return { id: m, name: m, nameEn: '', desc: '', tag: '', rulesets: null, test: false, mission: false, zombie: false };
  return {
    // 이름·설명·태그는 지금 언어로 고른 값이다(mapInfo를 쓰는 결과·방 화면도 같은 글자를 보인다). nameEn은 한국어 화면의 영어 부제
    id: String(m.id), name: loc(m, 'name') || String(m.id), nameEn: m.nameEn || '', desc: loc(m, 'desc') || '',
    tag: loc(m, 'tag') || '', rulesets: Array.isArray(m.rulesets) ? m.rulesets : null, test: !!m.test, mission: m.mission === true, zombie: m.zombie === true,
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
