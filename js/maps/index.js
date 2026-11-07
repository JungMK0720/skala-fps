/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 맵 목록과 동적 불러오기. MAP_IDS에 적힌 파일을 불러오고, 없거나 깨진 맵은 테스트 맵으로 대신한다.
 */
/**
 * SKALA FPS — 맵 목록
 *
 *   const { MAPS, MAP_LIST, getMap, mapsForRuleset } = await import('./maps/index.js');
 *   MAPS[id]                → 맵 데이터 (불러오기 실패 시 TEST_MAP 복제본, fallback:true)
 *   MAP_LIST                → [{ id, name, nameEn, desc, ok, fallback, rulesets, tag, test? }] 메뉴용. 마지막이 테스트 맵
 *   mapsForRuleset('knife') → 그 규칙을 고를 수 있는 MAP_LIST 항목(테스트 맵 제외)
 *
 * 각 맵 파일은 동적 import로 불러온다. 파일이 없거나 문법·데이터 오류가 있으면 콘솔에 경고하고
 * 빌트인 테스트 맵(작은 창고 마당)으로 대신한다 — 한 맵이 깨져도 게임 전체가 멈추지 않는다.
 * (이 모듈은 top-level await를 쓰므로 import 하는 쪽은 맵 로딩을 기다린다.)
 */
import { DEFAULT_RULESETS, RULESET_NAMES } from './collision.js';

export const MAP_IDS = Object.freeze(['alley', 'dojo', 'longshot', 'nexus', 'jetty', 'tankfarm', 'vlcc']);

const R90 = Math.PI / 2;

/** 빌트인 테스트 맵: 작은 창고 마당 (모든 solid/decor 종류를 한 번씩 쓴다) */
export const TEST_MAP = Object.freeze({
  id: 'testyard',
  name: '연습 창고 마당',
  nameEn: 'Practice Yard',
  desc: '코어 점검용 작은 창고 마당 — 수로·컨테이너·탱크·창고 2층(메자닌)',
  rulesets: RULESET_NAMES,
  tag: '테스트',
  size: { x: 64, z: 52 },
  theme: {
    sky: '#f3c99a', skyTop: '#3b6ea8', fog: [55, 210], sunDir: [-0.5, 0.75, -0.4],
    sunColor: '#ffe4bd', ambient: 0.5, water: '#1f4e6e', ground: 'concrete'
  },
  spawns: {
    owner: [
      { x: -26, z: -10, rotY: -R90 }, { x: -26, z: -6, rotY: -R90 },
      { x: -28, z: 4, rotY: -R90 }, { x: -28, z: 8, rotY: -R90 }
    ],
    charterer: [
      { x: 28, z: 10, rotY: R90 }, { x: 28, z: 14, rotY: R90 },
      { x: 28, z: 19, rotY: R90 }, { x: 23, z: 23, rotY: R90 }
    ]
  },
  solids: [
    // 수로(가라앉은 물) + 난간 벽
    { type: 'box', x: 0, y: -1.6, z: -22.5, w: 64, h: 0.8, d: 7, mat: 'water' },
    { type: 'box', x: 0, y: 0, z: -18.75, w: 64, h: 1.2, d: 0.5, mat: 'concrete' },
    { type: 'box', x: -6, y: 0, z: -17.6, w: 2.2, h: 0.35, d: 1.8, mat: 'steel' },
    // 창고 A (x 8~26, z -14~4): 벽 · 문 · 창문 · 지붕
    { type: 'box', x: 17, y: 0, z: -13.8, w: 18, h: 6, d: 0.4, mat: 'steel' },
    { type: 'box', x: 25.8, y: 0, z: -5, w: 0.4, h: 6, d: 18, mat: 'steel' },
    { type: 'box', x: 11, y: 0, z: 3.8, w: 6, h: 6, d: 0.4, mat: 'steel' },
    { type: 'box', x: 16, y: 4, z: 3.8, w: 4, h: 2, d: 0.4, mat: 'steel' },
    { type: 'box', x: 19, y: 0, z: 3.8, w: 2, h: 6, d: 0.4, mat: 'steel' },
    { type: 'box', x: 25, y: 0, z: 3.8, w: 2, h: 6, d: 0.4, mat: 'steel' },
    { type: 'box', x: 22, y: 0, z: 3.8, w: 4, h: 2, d: 0.4, mat: 'steel' },
    { type: 'box', x: 22, y: 3.6, z: 3.8, w: 4, h: 2.4, d: 0.4, mat: 'steel' },
    { type: 'box', x: 22, y: 2, z: 3.8, w: 4, h: 1.6, d: 0.1, mat: 'glass' },
    { type: 'box', x: 8.2, y: 0, z: -10, w: 0.4, h: 6, d: 8, mat: 'steel' },
    { type: 'box', x: 8.2, y: 0, z: 1, w: 0.4, h: 6, d: 6, mat: 'steel' },
    { type: 'box', x: 8.2, y: 3.5, z: -4, w: 0.4, h: 2.5, d: 4, mat: 'steel' },
    { type: 'box', x: 17, y: 6, z: -5, w: 18.4, h: 0.3, d: 18.4, mat: 'rust' },
    // 창고 안: 메자닌(2층) + 계단 11단 + 선반 + 나무 상자
    { type: 'box', x: 23.1, y: 3, z: -5, w: 5, h: 0.3, d: 17.2, mat: 'steel' },
    ...Array.from({ length: 11 }, (_, i) => ({ type: 'box', x: 16.4 + 0.4 * i, y: 0, z: -12.8, w: 0.4, h: 0.3 * (i + 1), d: 1.6, mat: 'concrete' })),
    { type: 'box', x: 15, y: 0, z: -7.5, w: 6, h: 2.4, d: 1, mat: 'steel' },
    { type: 'box', x: 12, y: 0, z: -10, w: 1.2, h: 1.2, d: 1.2, mat: 'wood' },
    { type: 'box', x: 12, y: 1.2, z: -10, w: 1.2, h: 1.2, d: 1.2, mat: 'wood' },
    { type: 'box', x: 14, y: 0, z: -1, w: 2.4, h: 1.2, d: 1.2, mat: 'wood' },
    { type: 'box', x: 11, y: 0, z: -4, w: 1.2, h: 1, d: 1.2, mat: 'wood' },
    // 컨테이너 블록 + 경사로(2단 위로)
    { type: 'box', x: -4, y: 0, z: -8, w: 6.1, h: 2.6, d: 2.44, mat: 'container_red' },
    { type: 'box', x: -4, y: 0, z: -5.56, w: 6.1, h: 2.6, d: 2.44, mat: 'container_red' },
    { type: 'box', x: -4, y: 2.6, z: -8, w: 6.1, h: 2.6, d: 2.44, mat: 'container_red' },
    { type: 'box', x: 4, y: 0, z: 6, w: 2.44, h: 2.6, d: 6.1, mat: 'container_red' },
    { type: 'box', x: -12, y: 0, z: 2, w: 6.1, h: 2.6, d: 2.44, mat: 'steel' },
    { type: 'ramp', x: -11.05, y: 0, z: -5.56, w: 8, h: 2.6, d: 2.44, dir: '+x', mat: 'steel' },
    // 탱크 2기 + 방류벽
    { type: 'cyl', x: -22, y: 0, z: 17, r: 3.2, h: 7, mat: 'tank' },
    { type: 'cyl', x: -13, y: 0, z: 19, r: 2.6, h: 6, mat: 'tank' },
    { type: 'box', x: -17.5, y: 0, z: 12.2, w: 15, h: 0.8, d: 0.3, mat: 'concrete' },
    // 적재대(높이 1.2) + 계단 3단 + 경사로
    { type: 'box', x: -24, y: 0, z: -8, w: 8, h: 1.2, d: 8, mat: 'concrete' },
    { type: 'box', x: -19.7, y: 0, z: -5, w: 0.6, h: 0.9, d: 2, mat: 'concrete' },
    { type: 'box', x: -19.1, y: 0, z: -5, w: 0.6, h: 0.6, d: 2, mat: 'concrete' },
    { type: 'box', x: -18.5, y: 0, z: -5, w: 0.6, h: 0.3, d: 2, mat: 'concrete' },
    { type: 'ramp', x: -24, y: 0, z: -1, w: 3, h: 1.2, d: 6, dir: '-z', mat: 'concrete' },
    // 낮은 엄폐물(저지 방벽)
    { type: 'box', x: -8, y: 0, z: 12, w: 3, h: 0.9, d: 0.6, mat: 'concrete' },
    { type: 'box', x: 2, y: 0, z: 15, w: 3, h: 0.9, d: 0.6, mat: 'concrete' },
    { type: 'box', x: -2, y: 0, z: -14, w: 0.6, h: 0.9, d: 3, mat: 'concrete' },
    // 가로등 기둥
    { type: 'box', x: -10, y: 0, z: -16, w: 0.25, h: 6, d: 0.25, mat: 'steel' },
    { type: 'box', x: 4, y: 0, z: -16, w: 0.25, h: 6, d: 0.25, mat: 'steel' },
    { type: 'box', x: -20, y: 0, z: 6, w: 0.25, h: 6, d: 0.25, mat: 'steel' },
    // 파이프랙 기둥·보
    ...[-6, 0, 6].flatMap((x) => [
      { type: 'box', x, y: 0, z: 20.5, w: 0.3, h: 4, d: 0.3, mat: 'steel' },
      { type: 'box', x, y: 0, z: 23.5, w: 0.3, h: 4, d: 0.3, mat: 'steel' },
      { type: 'box', x, y: 4, z: 22, w: 0.3, h: 0.3, d: 3.3, mat: 'steel' }
    ]),
    // 잔디밭(바닥과 같은 높이) · 노란 차선
    { type: 'box', x: 12, y: -0.2, z: 18, w: 16, h: 0.2, d: 10, mat: 'grass' },
    { type: 'box', x: -2, y: 0, z: 1, w: 18, h: 0.01, d: 0.15, mat: 'yellow' },
    { type: 'box', x: -2, y: 0, z: 9, w: 18, h: 0.01, d: 0.15, mat: 'yellow' },
    // 경비 초소
    { type: 'box', x: -2, y: 0, z: 21.5, w: 2.6, h: 2.7, d: 2.6, mat: 'white' }
  ],
  decor: [
    { type: 'sign', x: 16, y: 5, z: 4.05, rotY: 0, w: 5.2, h: 1, text: '창고 A · WAREHOUSE A', bg: '#0b2545', fg: '#ffffff' },
    { type: 'sign', x: -6, y: 0.62, z: -18.47, rotY: 0, w: 3.4, h: 0.9, text: '구역 1\nZONE 1', bg: '#14325c', fg: '#ffd166' },
    { type: 'sign', x: -17.5, y: 0.4, z: 12.02, rotY: Math.PI, w: 4.6, h: 0.72, text: '위험물 저장소 DANGEROUS GOODS', bg: '#b3261e', fg: '#ffffff' },
    { type: 'sign', x: -2, y: 2.25, z: 20.15, rotY: Math.PI, w: 2.6, h: 0.6, text: '경비실 GATE', bg: '#1b4332', fg: '#ffffff' },
    { type: 'light', x: -10, y: 6.1, z: -16, color: '#ffe6b0', intensity: 1.2, dist: 14 },
    { type: 'light', x: 4, y: 6.1, z: -16, color: '#ffe6b0', intensity: 1.2, dist: 14 },
    { type: 'light', x: -20, y: 6.1, z: 6, color: '#ffe6b0', intensity: 1.2, dist: 14 },
    { type: 'light', x: 14, y: 5.6, z: -6, color: '#e8f0ff', intensity: 1, dist: 12 },
    { type: 'loadingArm', x: -6, y: 0.35, z: -17.6, rotY: Math.PI },
    { type: 'flare', x: -28, y: 0, z: 23 },
    { type: 'buoy', x: -18, z: -23, r: 0.6 },
    { type: 'buoy', x: 8, z: -23.5, r: 0.5 },
    { type: 'buoy', x: 24, z: -22.5, r: 0.6 },
    // 파이프랙 배관 · 탱크 연결관
    { type: 'pipe', from: [-9, 4.5, 21.2], to: [9, 4.5, 21.2], r: 0.25, mat: 'pipe' },
    { type: 'pipe', from: [-9, 4.5, 22.8], to: [9, 4.5, 22.8], r: 0.2, mat: 'yellow' },
    { type: 'pipe', from: [-18.8, 0.7, 17], to: [-9, 0.7, 17], r: 0.18, mat: 'pipe' },
    { type: 'pipe', from: [-9, 0.7, 17], to: [-9, 4.5, 21.2], r: 0.18, mat: 'pipe' },
    // 수로 난간(노란 파이프)
    { type: 'pipe', from: [-32, 1.55, -18.75], to: [32, 1.55, -18.75], r: 0.05, mat: 'yellow' },
    ...Array.from({ length: 17 }, (_, i) => ({ type: 'pipe', from: [-32 + i * 4, 1.2, -18.75], to: [-32 + i * 4, 1.55, -18.75], r: 0.04, mat: 'yellow' })),
    // 메자닌 난간
    { type: 'pipe', from: [20.65, 4.3, -11.9], to: [20.65, 4.3, 3.5], r: 0.05, mat: 'yellow' },
    ...Array.from({ length: 5 }, (_, i) => ({ type: 'pipe', from: [20.65, 3.3, -11.9 + i * 3.85], to: [20.65, 4.3, -11.9 + i * 3.85], r: 0.04, mat: 'yellow' }))
  ]
});

function isValid(data) {
  return !!(data && typeof data === 'object' && Array.isArray(data.solids) && data.solids.length);
}

/** 맵 파일이 없을 때 메뉴에 보일 이름·규칙·배지 (DESIGN 5절 기준) */
const KNOWN = {
  alley: { name: '항구 골목', nameEn: 'Harbor Alley', rulesets: ['classic', 'knife'] },
  dojo: { name: '벚꽃 도장', nameEn: 'Blossom Dojo', rulesets: ['knife'], tag: '칼전 전용' },
  longshot: { name: '협곡 저격장', nameEn: 'Canyon Range', rulesets: ['sniper'], tag: '스나 전용' },
  nexus: { name: '넥서스', nameEn: 'Nexus', rulesets: ['classic', 'knife', 'sniper'], tag: '통합' },
  jetty: { name: '원유 부두', nameEn: 'Crude Jetty' },
  // 탱크 사이가 막혀 저격 시야가 짧다. 스나전 봇끼리 만나지 못해 무승부만 나와서 클래식 전용으로 둔다
  tankfarm: { name: '탱크 팜', nameEn: 'Tank Farm', rulesets: ['classic'] },
  vlcc: { name: 'VLCC 갑판', nameEn: 'Tanker Deck' }
};

function fallbackFor(id, reason) {
  const known = KNOWN[id] || {};
  const name = known.name || id;
  return Object.assign({}, TEST_MAP, {
    id,
    name,
    nameEn: known.nameEn || id,
    desc: `'${name}' 맵 파일을 아직 불러올 수 없어 연습 창고 마당으로 대신해요.`,
    rulesets: known.rulesets || DEFAULT_RULESETS,
    tag: known.tag || '',
    fallback: true,
    fallbackReason: reason || ''
  });
}

const IMPORT_TIMEOUT_MS = 8000;

async function tryLoad(id) {
  try {
    let timer = 0;
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`불러오기 시간 초과(${IMPORT_TIMEOUT_MS / 1000}s)`)), IMPORT_TIMEOUT_MS); });
    const mod = await Promise.race([import(`./${id}.js`), timeout]).finally(() => clearTimeout(timer));
    const data = mod && (mod.default || mod.MAP || mod[id]);
    if (!isValid(data)) throw new Error('맵 데이터 형식이 올바르지 않아요 (export default { solids:[...] } 필요)');
    return { data: data.id === id ? data : Object.assign({}, data, { id }), ok: true, error: null };
  } catch (err) {
    console.warn(`[maps] ${id}.js 불러오기 실패 → 테스트 맵으로 대체:`, err);
    const reason = String((err && err.message) || err);
    return { data: fallbackFor(id, reason), ok: false, error: reason };
  }
}

const loaded = await Promise.all(MAP_IDS.map(tryLoad));

/** 맵 데이터 (실패한 맵은 TEST_MAP 복제본) */
export const MAPS = Object.freeze(Object.fromEntries(MAP_IDS.map((id, i) => [id, loaded[i].data])));

/** 불러오기 상태 { id: { ok, error } } */
export const MAP_STATUS = Object.freeze(Object.fromEntries(MAP_IDS.map((id, i) => [id, { ok: loaded[i].ok, error: loaded[i].error }])));

function listEntry(id, data, ok) {
  const known = KNOWN[id] || {};
  return {
    id,
    name: data.name || id,
    nameEn: data.nameEn || '',
    desc: data.desc || '',
    ok,
    fallback: !ok,
    rulesets: Array.isArray(data.rulesets) && data.rulesets.length ? data.rulesets.slice() : (known.rulesets || DEFAULT_RULESETS).slice(),
    tag: typeof data.tag === 'string' ? data.tag : (known.tag || '')
  };
}

/** 메뉴용 목록 (+ 테스트 맵) */
export const MAP_LIST = Object.freeze([
  ...MAP_IDS.map((id, i) => listEntry(id, loaded[i].data, loaded[i].ok)),
  Object.assign(listEntry(TEST_MAP.id, TEST_MAP, true), { test: true })
]);

/** 이 규칙을 고를 수 있는 맵(MAP_LIST 항목, 테스트 맵 제외). 모르는 규칙이면 클래식 기준 */
export function mapsForRuleset(id) {
  const ruleset = RULESET_NAMES.includes(id) ? id : 'classic';
  return MAP_LIST.filter((m) => !m.test && m.rulesets.includes(ruleset));
}

/** id → 맵 데이터 (없으면 null). 'testyard'는 TEST_MAP */
export function getMap(id) {
  if (id === TEST_MAP.id) return TEST_MAP;
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(MAPS, id) ? MAPS[id] : null;   // id는 방장이 보낸 값일 수 있다
}
