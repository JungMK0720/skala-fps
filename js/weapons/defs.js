/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 무기 15종과 수류탄의 수치·표시 정보, 데미지 계산의 유일한 구현(computeDamage)을 둔다.
 *          three.js·엔진·DOM에 의존하지 않아 node 테스트와 방장 판정에서 그대로 import한다.
 */

/*
 * 단위: 거리 m, 시간 s, 표 안의 각도는 '도(°)'. logic.js가 라디안으로 바꿔 쓴다.
 * 반동 패턴 [x, y]: 한 발마다 카메라가 튀는 각도(°). x는 오른쪽이 +, y는 위가 +.
 * 탄퍼짐(spread): 원뿔 반각(°). hip = 미조준, ads = 조준(줌) 상태.
 * 수치를 고친 이유와 고칠 곳은 docs/BALANCE.md에 적어 둔다.
 */

export const DEG = Math.PI / 180;
export const PLAYER_HP = 100;
/** 걷기 속도(m/s). 이동 탄퍼짐 계산의 기준이다. */
export const WALK_SPEED = 5.2;
/** 기본 세로 FOV 가정값. 엔진 FOV가 다르면 getZoom(baseFov)에 넘긴다. */
export const BASE_FOV = 75;

export const PARTS = Object.freeze(['head', 'body', 'legs', 'hand', 'foot']);

/**
 * 무기 모듈이 돌려주는 벡터: [x, y, z] 배열이면서 .x/.y/.z 속성도 있다.
 * core(배열 규약)와 three.js식 객체 규약 어느 쪽에 넘겨도 그대로 읽힌다. JSON으로는 [x,y,z].
 */
export function vec3(x = 0, y = 0, z = 0) {
  const v = [x, y, z];
  v.x = x; v.y = y; v.z = z;
  return v;
}

/** [x,y,z] 배열이나 {x,y,z} 객체를 읽어 vec3로. 숫자가 아니면 0. */
export function toVec3(v) {
  if (!v) return vec3();
  const a = Array.isArray(v) ? v : [v.x, v.y, v.z];
  const f = (n) => (Number.isFinite(+n) ? +n : 0);
  return vec3(f(a[0]), f(a[1]), f(a[2]));
}

/* ───────────────────────────── 반동 패턴 ───────────────────────────── */

/** RX-4(30발). 처음 7발은 거의 수직으로 솟고, 8~12발은 왼쪽, 13~18발은 오른쪽, 그 뒤로는 좌우로 작게 흔들린다. */
const AR_STD_PATTERN = [
  [0.00, 0.55], [0.05, 0.60], [-0.05, 0.65], [0.08, 0.70], [0.10, 0.70],
  [0.05, 0.65], [0.12, 0.55], [-0.20, 0.45], [-0.35, 0.35], [-0.40, 0.30],
  [-0.40, 0.25], [-0.30, 0.20], [0.10, 0.20], [0.40, 0.20], [0.50, 0.15],
  [0.50, 0.15], [0.40, 0.15], [0.20, 0.10], [-0.30, 0.10], [-0.45, 0.10],
  [-0.45, 0.10], [-0.30, 0.10], [0.20, 0.10], [0.40, 0.10], [0.45, 0.08],
  [0.35, 0.08], [-0.10, 0.08], [-0.35, 0.08], [-0.35, 0.08], [-0.20, 0.08],
];

/**
 * RX-9(35발). 몸 TTK가 RX-4와 비슷해서 다른 대가를 치르게 했다.
 * 발당 반동이 더 크고 초당 발수도 1.4배라 수직으로 빠르게 솟은 뒤, RX-4보다 넓고 짧은 주기로 좌우로 끌린다.
 */
const AR_RAPID_PATTERN = [
  [0.05, 0.70], [-0.08, 0.78], [0.12, 0.85], [-0.10, 0.90], [0.18, 0.92],
  [0.10, 0.88], [-0.22, 0.80], [-0.45, 0.62], [-0.62, 0.50], [-0.70, 0.40],
  [-0.58, 0.34], [-0.20, 0.30], [0.30, 0.30], [0.62, 0.28], [0.75, 0.26],
  [0.70, 0.24], [0.40, 0.22], [-0.15, 0.20], [-0.60, 0.20], [-0.78, 0.18],
  [-0.70, 0.18], [-0.30, 0.16], [0.25, 0.16], [0.68, 0.16], [0.80, 0.15],
  [0.62, 0.15], [0.10, 0.14], [-0.50, 0.14], [-0.75, 0.14], [-0.72, 0.14],
  [-0.25, 0.12], [0.35, 0.12], [0.70, 0.12], [0.72, 0.12], [0.30, 0.12],
];

/**
 * LN-3(25발). 발당 반동 총량이 RX-4 같은 구간의 약 40%다(tests가 비율을 검사한다).
 * 머리 라인에 조준을 붙여 두는 무기라 오른쪽으로 한 번, 왼쪽으로 한 번만 천천히 흐른다.
 */
const AR_LINE_PATTERN = [
  [0.02, 0.24], [0.03, 0.26], [0.04, 0.28], [0.05, 0.28], [0.06, 0.26],
  [0.08, 0.22], [0.10, 0.18], [0.12, 0.16], [0.14, 0.14], [0.16, 0.12],
  [0.16, 0.10], [0.12, 0.10], [0.06, 0.08], [-0.06, 0.08], [-0.14, 0.08],
  [-0.18, 0.06], [-0.18, 0.06], [-0.14, 0.06], [-0.08, 0.05], [0.04, 0.05],
  [0.12, 0.04], [0.16, 0.04], [0.16, 0.04], [0.12, 0.04], [0.04, 0.04],
];

/**
 * BR-3. 세 발씩 계단처럼 솟는다. 점사를 몰아 쏘면 patternRecover가 다 못 돌아와 뒤쪽(더 흔들리는) 묶음으로 밀린다.
 * 그래서 차분히 끊어 쏘는 사람만 처음 세 칸을 계속 쓴다.
 */
const AR_BURST_PATTERN = [
  [0.00, 0.62], [0.10, 0.74], [-0.12, 0.86],
  [0.14, 0.66], [0.24, 0.78], [0.08, 0.90],
  [-0.16, 0.70], [-0.28, 0.82], [-0.10, 0.94],
  [0.20, 0.74], [0.32, 0.86], [0.12, 0.98],
];

/** DM-4. 첫 발이 수직으로 크고, 다음 발부터 좌우로 번갈아 튄다. 연타하면 조준이 흐트러지게 하는 것이 2발 킬의 대가다. */
const DM_MARK_PATTERN = [[0.00, 1.70], [0.35, 1.60], [-0.35, 1.60], [0.20, 1.50], [-0.20, 1.50]];

/** VX-3. 수직 상승은 작고 좌우로 빠르게 떤다. 근거리 몸통 조준을 깨지 않으면서 멀리서는 흩어지게 한다. */
const SM_VX3_PATTERN = [
  [0.06, 0.30], [-0.10, 0.32], [0.14, 0.34], [-0.16, 0.36], [0.18, 0.36], [-0.20, 0.34], [0.24, 0.30], [-0.26, 0.28],
  [0.22, 0.24], [-0.22, 0.22], [0.26, 0.20], [-0.26, 0.20], [0.20, 0.18], [-0.18, 0.18], [0.24, 0.18], [-0.24, 0.18],
];

const SG_BX12_PATTERN = [[0.00, 4.20], [0.60, 3.60], [-0.60, 3.60]];
const SR_BOLT_PATTERN = [[0.00, 3.20]];
const SR_TWIN_PATTERN = [[0.15, 3.40]];
const SR_SWIFT_PATTERN = [[-0.20, 2.20], [0.25, 2.00]];
const SR_HEAVY_PATTERN = [[0.35, 5.50], [-0.35, 5.50]];
const PT_STD_PATTERN = [[0.00, 1.30], [0.25, 1.15], [-0.25, 1.15], [0.15, 1.05]];
const PT_MAGNUM_PATTERN = [[0.00, 3.00], [0.50, 2.70], [-0.50, 2.70]];

/* ───────────────────────────── 카드 문구 ───────────────────────────── */

const sec = (v) => `${+v.toFixed(3)}초`;
const pct = (v) => `${Math.round(v * 100)}%`;
const limbsText = ({ hand, foot }) => (hand === foot ? `손·발 ${hand}` : `손 ${hand} · 발 ${foot}`);

function rateRow(w) {
  switch (w.fire) {
    case 'auto': return { label: '연사', value: `${w.rpm} rpm` };
    case 'burst': return { label: '점사', value: `${w.burst.count}발 · ${sec(w.burst.gap)} 간격 · 재사격 ${sec(w.fireInterval)}` };
    case 'bolt': return { label: '볼트', value: `${sec(w.bolt)} · 사격 후 줌 해제` };
    default: return { label: '연사', value: `반자동 · ${sec(w.fireInterval)}` };
  }
}

function zoomText(z) {
  return z.levels ? `${z.levels.length}단 ${z.levels.map((m) => `${m}배`).join(' → ')}` : `${z.mag}배`;
}

/**
 * 총기 카드의 stats 행. 표의 숫자에서 만들어 문구와 수치가 어긋나지 않게 한다.
 * '반샷'은 저격총이 손·발에 맞은 반피 타격만 뜻하고, 빠르게 줌하고 쏘는 기술은 '퀵스코프'라고 부른다.
 */
function gunStats(w) {
  const { damage: d, falloff: f, zoom: z } = w;
  const base = `머리 ${d.head} · 몸 ${d.body} · 다리 ${d.legs}`;
  const rows = [rateRow(w)];
  if (w.kind === 'sniper') {
    const allParts = d.body >= PLAYER_HP && d.legs >= PLAYER_HP;
    rows.push({ label: '피해', value: base });
    rows.push({ label: '반샷', value: `${limbsText(d)} · ${allParts ? '나머지 부위 1발 킬' : '머리만 1발 킬'}` });
    rows.push({ label: '퀵스코프', value: `줌 ${pct(z.accurateAt)}(${sec(z.accurateAt * z.inTime)})부터 정조준` });
  } else if (w.pellets > 1) {
    rows.push({ label: '피해', value: `펠릿 ${w.pellets}발 · 발당 ${base} · ${limbsText(d)}` });
  } else {
    rows.push({ label: '피해', value: `${base} · ${limbsText(d)}` });
  }
  rows.push({ label: '감쇠', value: f ? `${f.start}~${f.end} m → ${pct(f.min)}${w.headIgnoresFalloff ? ' · 머리 제외' : ''}` : '없음' });
  if (z) rows.push({ label: '줌', value: `${zoomText(z)} · 이동 ${pct(z.moveMul)}` });
  if (w.recoilNote) rows.push({ label: '반동', value: w.recoilNote });
  rows.push({ label: '탄약', value: `${w.mag} / ${w.reserve}` });
  rows.push({ label: '이동', value: pct(w.moveMul) });
  return rows;
}

function meleeStats(w) {
  const row = (m) => ({ label: m.label, value: `${m.damage} · ${sec(m.cooldown)} · ${m.range} m` });
  return [row(w.melee.slash), row(w.melee.stab), { label: '이동', value: pct(w.moveMul) }];
}

const gun = (o) => ({ pellets: 1, headIgnoresFalloff: false, ...o, stats: gunStats({ pellets: 1, ...o }) });
const blade = (o) => ({ ...o, stats: meleeStats(o) });

/* ───────────────────────────── 무기 표 (DESIGN 3.2) ───────────────────────────── */

const WEAPON_TABLE = {
  // ───────────────────────────── 슬롯 1 · 라이플 ─────────────────────────────
  ar_std: gun({
    id: 'ar_std', slot: 1, kind: 'rifle', category: 'rifle', fire: 'auto', price: 0,
    name: 'RX-4 돌격소총', nameEn: 'RX-4 Assault Rifle', short: 'RX-4', role: '돌격',
    icon: '🔫', color: '#c0392b', sound: 'rifle', fxKind: 'rifle',
    tagline: '어디서든 믿고 쓰는 표준 소총.',
    desc: '거리·연사·반동이 고르게 맞춰진 기본 라이플이다. 다른 라이플은 이 총을 기준으로 잰다.',
    recoilNote: '위로 솟다가 좌우로',
    bars: { power: 55, rate: 62, accuracy: 68, mobility: 72 },

    damage: { head: 110, body: 30, legs: 22, hand: 15, foot: 15 },
    headIgnoresFalloff: true,                      // 라이플 공통: 거리와 상관없이 머리 1발 킬
    falloff: { start: 30, end: 80, min: 0.75 },
    maxRange: 250,

    rpm: 600, fireInterval: 60 / 600,

    mag: 30, reserve: 90, reload: 2.3, reloadEmpty: 2.7,
    drawTime: 0.65, moveMul: 0.95,

    spread: { hip: 1.2, ads: 0.2, move: 2.5, adsMove: 1.0, air: 5, adsAir: 4,
      bloomPerShot: 0.15, bloomMax: 1.5, bloomDecay: 4, adsBloomMul: 0.6, max: 10 },
    recoil: { pattern: AR_STD_PATTERN, loopFrom: 18, adsMul: 0.8, maxPitch: 10, maxYaw: 4,
      recoverDelay: 0.12, recoverRate: 7, patternRecover: 20 },
    zoom: { mag: 2, inTime: 0.18, outTime: 0.12, accurateAt: null, overlay: null,
      hideViewmodelAt: null, moveMul: 0.8, unzoomOnFire: false },
  }),

  // 몸 22로 약하지만 860rpm이라 근거리 TTK가 표준보다 살짝 빠르다. 반동과 탄퍼짐이 그 값을 치른다.
  ar_rapid: gun({
    id: 'ar_rapid', slot: 1, kind: 'rifle', category: 'rifle', fire: 'auto', price: 800,
    name: 'RX-9 스톰', nameEn: 'RX-9 Storm', short: 'RX-9', role: '연사',
    icon: '🌪️', color: '#e8731c', sound: 'rifle', fxKind: 'rifle',
    tagline: '퍼붓는 만큼 제어가 어렵다.',
    desc: '가장 빠른 라이플이다. 반동이 넓고 탄도 많이 퍼져서 짧게 끊어 쏘지 않으면 금방 조준을 잃는다.',
    recoilNote: '크고 넓게 흔들린다',
    bars: { power: 42, rate: 90, accuracy: 45, mobility: 78 },

    damage: { head: 100, body: 22, legs: 16, hand: 11, foot: 11 },
    headIgnoresFalloff: true,
    falloff: { start: 25, end: 70, min: 0.7 },
    maxRange: 220,

    rpm: 860, fireInterval: 60 / 860,

    mag: 35, reserve: 105, reload: 2.4, reloadEmpty: 2.9,
    drawTime: 0.6, moveMul: 0.97,

    spread: { hip: 1.7, ads: 0.45, move: 3.0, adsMove: 1.4, air: 5.5, adsAir: 4.5,
      bloomPerShot: 0.2, bloomMax: 2.6, bloomDecay: 3.5, adsBloomMul: 0.75, max: 12 },
    // adsMul 0.92: 조준해도 반동이 거의 줄지 않게 해서 '조준하고 긁기'로 단점을 지우지 못하게 한다
    recoil: { pattern: AR_RAPID_PATTERN, loopFrom: 20, adsMul: 0.92, maxPitch: 13, maxYaw: 6,
      recoverDelay: 0.1, recoverRate: 6, patternRecover: 24 },
    zoom: { mag: 1.7, inTime: 0.16, outTime: 0.11, accurateAt: null, overlay: null,
      hideViewmodelAt: null, moveMul: 0.82, unzoomOnFire: false },
  }),

  // 몸 6발이라 교전이 느리다. 그 대신 반동 40%와 좁은 탄퍼짐, 돌격소총 중 가장 높은 머리 120으로 '머리만 노리는' 사람의 무기가 된다.
  ar_line: gun({
    id: 'ar_line', slot: 1, kind: 'rifle', category: 'rifle', fire: 'auto', price: 1200,
    name: 'LN-3 헤드라인', nameEn: 'LN-3 Headline', short: 'LN-3', role: '정밀',
    icon: '📏', color: '#35e0ff', sound: 'rifle', fxKind: 'rifle',
    tagline: '몸에는 약하고, 머리에는 정확하다.',
    desc: '반동이 표준 소총의 40%이고 탄이 거의 퍼지지 않는다. 몸통 피해가 낮아 머리를 맞혀야 값을 한다.',
    recoilNote: 'RX-4의 40% · 머리 전용',
    bars: { power: 38, rate: 48, accuracy: 92, mobility: 72 },

    damage: { head: 120, body: 17, legs: 12, hand: 8, foot: 8 },
    headIgnoresFalloff: true,
    falloff: { start: 40, end: 100, min: 0.8 },
    maxRange: 300,

    rpm: 480, fireInterval: 60 / 480,

    mag: 25, reserve: 75, reload: 2.2, reloadEmpty: 2.6,
    drawTime: 0.7, moveMul: 0.95,

    spread: { hip: 0.8, ads: 0.06, move: 2.0, adsMove: 0.7, air: 5, adsAir: 4,
      bloomPerShot: 0.06, bloomMax: 0.6, bloomDecay: 6, adsBloomMul: 0.5, max: 8 },
    recoil: { pattern: AR_LINE_PATTERN, loopFrom: 15, adsMul: 0.8, maxPitch: 4, maxYaw: 1.6,
      recoverDelay: 0.14, recoverRate: 9, patternRecover: 18 },
    zoom: { mag: 2.4, inTime: 0.2, outTime: 0.13, accurateAt: null, overlay: null,
      hideViewmodelAt: null, moveMul: 0.75, unzoomOnFire: false },
  }),

  // 34×3 = 102라서 약 33 m까지는 한 번의 점사가 곧 킬이다. 그보다 멀면 발당 33 이하로 떨어져 두 번째 점사가 필요하다.
  ar_burst: gun({
    id: 'ar_burst', slot: 1, kind: 'rifle', category: 'rifle', fire: 'burst', price: 1000,
    name: 'BR-3 트리플', nameEn: 'BR-3 Triple', short: 'BR-3', role: '점사',
    icon: '🔱', color: '#8e5bd6', sound: 'rifle', fxKind: 'rifle',
    tagline: '한 번 당기면 세 발.',
    desc: '한 번 누르면 세 발이 나가고 잠시 쉰다. 세 발을 모두 맞히면 가장 빠르게 끝나지만 빗나가면 공백이 길다.',
    recoilNote: '세 발 동안 계단식으로',
    bars: { power: 62, rate: 58, accuracy: 72, mobility: 72 },

    damage: { head: 110, body: 34, legs: 24, hand: 16, foot: 16 },
    headIgnoresFalloff: true,
    falloff: { start: 30, end: 80, min: 0.75 },
    maxRange: 250,

    // fireInterval은 점사가 끝난 뒤 쉬는 시간. rpm은 쉬는 시간까지 넣은 실효 연사다(3발 / 0.49초).
    rpm: 367, fireInterval: 0.36,
    burst: { count: 3, gap: 0.065 },

    mag: 30, reserve: 90, reload: 2.3, reloadEmpty: 2.7,
    drawTime: 0.65, moveMul: 0.95,

    spread: { hip: 1.0, ads: 0.15, move: 2.5, adsMove: 1.0, air: 5, adsAir: 4,
      bloomPerShot: 0.18, bloomMax: 1.2, bloomDecay: 5, adsBloomMul: 0.6, max: 9 },
    // patternRecover 7: 재사격 간격(0.36초)으로는 패턴이 다 돌아오지 않아 몰아 쏘면 뒤 묶음으로 밀린다
    recoil: { pattern: AR_BURST_PATTERN, loopFrom: 3, adsMul: 0.8, maxPitch: 8, maxYaw: 3,
      recoverDelay: 0.1, recoverRate: 8, patternRecover: 7 },
    zoom: { mag: 2.2, inTime: 0.18, outTime: 0.12, accurateAt: null, overlay: null,
      hideViewmodelAt: null, moveMul: 0.8, unzoomOnFire: false },
  }),

  // 감쇠가 없어 어느 거리든 몸 2발. 저격총의 1발과 라이플의 연사 사이를 메운다. 상점 탭은 라이플에 묶는다.
  dm_mark: gun({
    id: 'dm_mark', slot: 1, kind: 'dmr', category: 'rifle', fire: 'semi', price: 1500,
    name: 'DM-4 마크스맨', nameEn: 'DM-4 Marksman', short: 'DM-4', role: '지정사수',
    icon: '🏹', color: '#6fbf4a', sound: 'dmr', fxKind: 'rifle',
    tagline: '한 발씩 또박또박, 3배로 멀리.',
    desc: '거리에 따른 감쇠가 없는 반자동 소총이다. 3배 조준에 스코프 오버레이가 없어 주변이 그대로 보인다.',
    recoilNote: '발마다 크게 튄다',
    bars: { power: 72, rate: 30, accuracy: 88, mobility: 58 },

    damage: { head: 130, body: 52, legs: 38, hand: 26, foot: 26 },
    headIgnoresFalloff: true,
    falloff: null,
    maxRange: 350,

    rpm: 200, fireInterval: 60 / 200,

    mag: 15, reserve: 45, reload: 2.6, reloadEmpty: 3.0,
    drawTime: 0.75, moveMul: 0.9,

    spread: { hip: 3.2, ads: 0.05, move: 3.0, adsMove: 1.2, air: 6, adsAir: 5,
      bloomPerShot: 0.3, bloomMax: 1.4, bloomDecay: 3.5, adsBloomMul: 0.25, max: 11 },
    recoil: { pattern: DM_MARK_PATTERN, loopFrom: 1, adsMul: 0.75, maxPitch: 7, maxYaw: 2,
      recoverDelay: 0.1, recoverRate: 6, patternRecover: 8 },
    zoom: { mag: 3, inTime: 0.2, outTime: 0.13, accurateAt: null, overlay: null,
      hideViewmodelAt: null, moveMul: 0.72, unzoomOnFire: false },
  }),

  // ───────────────────────────── 슬롯 1 · SMG / 샷건 ─────────────────────────────
  // 12 m 안에서는 라이플과 TTK가 비슷하고 이동이 105%다. 40 m에서 55%까지 떨어져 먼 거리는 라이플에 내준다.
  sm_vx3: gun({
    id: 'sm_vx3', slot: 1, kind: 'smg', category: 'smg', fire: 'auto', price: 600,
    name: 'VX-3 바이퍼', nameEn: 'VX-3 Viper', short: 'VX-3', role: '기동',
    icon: '🐍', color: '#18c98a', sound: 'smg', fxKind: 'pistol',
    tagline: '뛰면서 쏘는 근거리 기동형.',
    desc: '달리면서 쏴도 탄이 덜 퍼지고 가장 빠르게 움직인다. 멀어지면 피해가 절반 가까이 줄어든다.',
    recoilNote: '작고 빠르게 떤다',
    bars: { power: 36, rate: 98, accuracy: 55, mobility: 95 },

    damage: { head: 60, body: 18, legs: 14, hand: 9, foot: 9 },
    falloff: { start: 12, end: 40, min: 0.55 },
    maxRange: 120,

    rpm: 950, fireInterval: 60 / 950,

    mag: 32, reserve: 128, reload: 1.9, reloadEmpty: 2.2,
    drawTime: 0.45, moveMul: 1.05,

    // move가 라이플의 절반 아래: 이동 사격이 이 총의 존재 이유다
    spread: { hip: 1.5, ads: 0.6, move: 0.9, adsMove: 0.5, air: 3.5, adsAir: 3,
      bloomPerShot: 0.12, bloomMax: 2.2, bloomDecay: 6, adsBloomMul: 0.7, max: 9 },
    recoil: { pattern: SM_VX3_PATTERN, loopFrom: 8, adsMul: 0.85, maxPitch: 7, maxYaw: 3.5,
      recoverDelay: 0.09, recoverRate: 10, patternRecover: 26 },
    zoom: { mag: 1.4, inTime: 0.12, outTime: 0.09, accurateAt: null, overlay: null,
      hideViewmodelAt: null, moveMul: 0.9, unzoomOnFire: false },
  }),

  // 펠릿 8발이 모두 몸에 맞으면 112. 탄퍼짐 때문에 몸 중앙을 겨눠도 6 m쯤에서 한 방 확률이 절반으로 떨어지고, 22 m 밖에서는 35%라 견제만 된다.
  sg_bx12: gun({
    id: 'sg_bx12', slot: 1, kind: 'shotgun', category: 'smg', fire: 'semi', price: 700,
    name: 'BX-12 브리처', nameEn: 'BX-12 Breacher', short: 'BX-12', role: '근거리',
    icon: '💥', color: '#d9a441', sound: 'shotgun', fxKind: 'rifle',
    tagline: '문을 열고 들어가는 한 방.',
    desc: '펠릿 8발을 한 번에 쏘는 근거리 무기다. 코앞에서는 한 방이지만 조금만 멀어져도 맞는 펠릿이 줄어든다.',
    recoilNote: '한 발에 크게 튄다',
    bars: { power: 85, rate: 12, accuracy: 20, mobility: 78 },

    damage: { head: 20, body: 14, legs: 10, hand: 7, foot: 7 },   // 펠릿 1발 기준
    pellets: 8,
    falloff: { start: 8, end: 22, min: 0.35 },
    maxRange: 40,

    rpm: 71, fireInterval: 0.85,

    mag: 6, reserve: 24, reload: 2.6, reloadEmpty: 3.0,
    drawTime: 0.7, moveMul: 0.98,

    spread: { hip: 3.2, move: 0.8, air: 2.5, bloomPerShot: 0, bloomMax: 0, bloomDecay: 0, max: 7 },
    recoil: { pattern: SG_BX12_PATTERN, loopFrom: 1, adsMul: 1, maxPitch: 9, maxYaw: 2.5,
      recoverDelay: 0.12, recoverRate: 6, patternRecover: 5 },
    zoom: null,
  }),

  // ───────────────────────────── 슬롯 1 · 저격 ─────────────────────────────
  // 손·발만 맞으면 50(반샷)이라 1발 킬에 조준 실력의 여지를 남긴다. 나머지 부위는 표대로 1발 킬이다.
  sr_bolt: gun({
    id: 'sr_bolt', slot: 1, kind: 'sniper', category: 'sniper', fire: 'bolt', price: 0,
    name: 'SK-7 볼트', nameEn: 'SK-7 Bolt', short: 'SK-7', role: '저격',
    icon: '🎯', color: '#f2c230', sound: 'sniper', fxKind: 'sniper',
    tagline: '숨을 고르고, 한 방.',
    desc: '기본 저격총이다. 머리·몸·다리는 1발 킬이고 손끝이나 발에 맞으면 반샷이 된다.',
    bars: { power: 95, rate: 12, accuracy: 95, mobility: 52 },

    damage: { head: 200, body: 120, legs: 100, hand: 50, foot: 50 },
    falloff: null,
    maxRange: 400,

    rpm: 50, fireInterval: 1.2,
    bolt: 1.2,               // 사격 후 볼트 조작 시간(이 동안 사격·줌 불가)
    emptyShotRecover: 0.35,  // 마지막 탄을 쏜 뒤 자동 재장전까지의 틈

    mag: 5, reserve: 20, reload: 3.0, reloadEmpty: 3.4,
    drawTime: 0.8, moveMul: 0.85,

    spread: { hip: 8, ads: 0, move: 2, adsMove: 1.5, air: 6, adsAir: 6,
      bloomPerShot: 0, bloomMax: 0, bloomDecay: 0, max: 16 },
    recoil: { pattern: SR_BOLT_PATTERN, loopFrom: 0, adsMul: 1, maxPitch: 6, maxYaw: 2,
      recoverDelay: 0.06, recoverRate: 5, patternRecover: 10 },
    zoom: { mag: 4, inTime: 0.16, outTime: 0.1, accurateAt: 0.5, overlay: 'scope',
      hideViewmodelAt: 0.9, moveMul: 0.8, unzoomOnFire: true },
  }),

  // SK-7과 위력이 같다. 9배를 얻는 대신 볼트·줌·이동이 조금씩 느려서 장거리가 아니면 손해다.
  sr_twin: gun({
    id: 'sr_twin', slot: 1, kind: 'sniper', category: 'sniper', fire: 'bolt', price: 1500,
    name: 'T-2 트윈옵틱', nameEn: 'T-2 Twin Optic', short: 'T-2', role: '2단 저격',
    icon: '🔭', color: '#5b82d6', sound: 'sniper', fxKind: 'sniper',
    tagline: '4배로 찾고 9배로 끝낸다.',
    desc: '우클릭할 때마다 4배, 9배, 해제 순서로 바뀌는 2단 조준경을 달았다. 사격하면 줌이 풀린다.',
    bars: { power: 95, rate: 10, accuracy: 98, mobility: 45 },

    damage: { head: 200, body: 120, legs: 100, hand: 50, foot: 50 },
    falloff: null,
    maxRange: 500,

    rpm: 44, fireInterval: 1.35,
    bolt: 1.35,
    emptyShotRecover: 0.4,

    mag: 5, reserve: 20, reload: 3.2, reloadEmpty: 3.6,
    drawTime: 0.9, moveMul: 0.82,

    spread: { hip: 9, ads: 0, move: 2.2, adsMove: 1.7, air: 6.5, adsAir: 6.5,
      bloomPerShot: 0, bloomMax: 0, bloomDecay: 0, max: 17 },
    recoil: { pattern: SR_TWIN_PATTERN, loopFrom: 0, adsMul: 1, maxPitch: 6, maxYaw: 2,
      recoverDelay: 0.06, recoverRate: 5, patternRecover: 10 },
    // levelTime: 줌이 이미 걸린 상태에서 단계를 옮기는 시간(FOV가 튀지 않게 배율을 이만큼 동안 옮긴다)
    zoom: { levels: [4, 9], inTime: 0.2, outTime: 0.12, levelTime: 0.16, accurateAt: 0.5, overlay: 'scope',
      hideViewmodelAt: 0.9, moveMul: 0.75, unzoomOnFire: true },
  }),

  // 몸 85라 1발 킬이 아니다. 그 대신 볼트 0.85초, 이동 95%, 빠른 줌으로 저격총 중 유일하게 돌아다니며 쓴다.
  sr_swift: gun({
    id: 'sr_swift', slot: 1, kind: 'sniper', category: 'sniper', fire: 'bolt', price: 1000,
    name: 'S-3 스위프트', nameEn: 'S-3 Swift', short: 'S-3', role: '경량 저격',
    icon: '🕊️', color: '#7fd1e8', sound: 'sniper', fxKind: 'sniper',
    tagline: '가볍게 들고 빠르게 당긴다.',
    desc: '가볍고 볼트가 빠른 3배 저격총이다. 머리가 아니면 한 발에 쓰러지지 않으니 두 번째 탄까지 생각해야 한다.',
    bars: { power: 72, rate: 20, accuracy: 90, mobility: 72 },

    damage: { head: 150, body: 85, legs: 60, hand: 40, foot: 40 },
    falloff: null,
    maxRange: 300,

    rpm: 71, fireInterval: 0.85,
    bolt: 0.85,
    emptyShotRecover: 0.25,

    mag: 7, reserve: 28, reload: 2.4, reloadEmpty: 2.8,
    drawTime: 0.6, moveMul: 0.95,

    spread: { hip: 5, ads: 0, move: 1.6, adsMove: 1.0, air: 5, adsAir: 5,
      bloomPerShot: 0, bloomMax: 0, bloomDecay: 0, max: 13 },
    recoil: { pattern: SR_SWIFT_PATTERN, loopFrom: 0, adsMul: 1, maxPitch: 5, maxYaw: 2,
      recoverDelay: 0.05, recoverRate: 7, patternRecover: 8 },
    zoom: { mag: 3, inTime: 0.12, outTime: 0.08, accurateAt: 0.5, overlay: 'scope',
      hideViewmodelAt: 0.9, moveMul: 0.88, unzoomOnFire: true },
  }),

  // 머리·몸·다리가 1발이고 반샷도 70으로 가장 크다. 볼트 1.9초와 탄 4/12, 이동 75%가 빗나갔을 때의 대가다.
  sr_heavy: gun({
    id: 'sr_heavy', slot: 1, kind: 'sniper', category: 'sniper', fire: 'bolt', price: 2500,
    name: 'H-50 타이탄', nameEn: 'H-50 Titan', short: 'H-50', role: '대물 저격',
    icon: '🗿', color: '#7a8799', sound: 'sniper', fxKind: 'sniper',
    tagline: '한 발이면 충분하지만, 다음 발은 멀다.',
    desc: '가장 무거운 5배 대물 저격총이다. 손·발에 맞아도 크게 깎이지만 빗나가면 다음 탄까지 오래 걸린다.',
    bars: { power: 100, rate: 6, accuracy: 94, mobility: 30 },

    damage: { head: 300, body: 200, legs: 150, hand: 70, foot: 70 },
    falloff: null,
    maxRange: 500,

    rpm: 32, fireInterval: 1.9,
    bolt: 1.9,
    emptyShotRecover: 0.5,

    mag: 4, reserve: 12, reload: 3.8, reloadEmpty: 4.4,
    drawTime: 1.1, moveMul: 0.75,

    spread: { hip: 11, ads: 0, move: 3, adsMove: 2.2, air: 8, adsAir: 8,
      bloomPerShot: 0, bloomMax: 0, bloomDecay: 0, max: 20 },
    recoil: { pattern: SR_HEAVY_PATTERN, loopFrom: 0, adsMul: 1, maxPitch: 9, maxYaw: 3,
      recoverDelay: 0.1, recoverRate: 3.5, patternRecover: 6 },
    zoom: { mag: 5, inTime: 0.25, outTime: 0.14, accurateAt: 0.6, overlay: 'scope',
      hideViewmodelAt: 0.9, moveMul: 0.7, unzoomOnFire: true },
  }),

  // ───────────────────────────── 슬롯 2 · 보조 ─────────────────────────────
  pt_std: gun({
    id: 'pt_std', slot: 2, kind: 'pistol', category: 'pistol', fire: 'semi', price: 0,
    name: 'P-9 권총', nameEn: 'P-9 Pistol', short: 'P-9', role: '보조',
    icon: '🔰', color: '#9aa5b1', sound: 'pistol', fxKind: 'pistol',
    tagline: '언제나 허리춤에 있는 마지막 수단.',
    desc: '꺼내는 속도가 빠른 기본 보조 무기다. 주무기 탄이 떨어졌을 때 교전을 이어 간다.',
    bars: { power: 40, rate: 55, accuracy: 72, mobility: 90 },

    damage: { head: 70, body: 28, legs: 20, hand: 14, foot: 14 },
    falloff: { start: 15, end: 45, min: 0.6 },
    maxRange: 150,

    rpm: 375, fireInterval: 0.16,   // 반자동: 누를 때마다 1발, 최소 간격 0.16초

    mag: 12, reserve: 36, reload: 1.6, reloadEmpty: 1.9,
    drawTime: 0.45, moveMul: 1.0,

    spread: { hip: 0.8, move: 1.6, air: 4.5, bloomPerShot: 0.45, bloomMax: 2.0, bloomDecay: 6, max: 8 },
    recoil: { pattern: PT_STD_PATTERN, loopFrom: 1, adsMul: 1,
      maxPitch: 7, maxYaw: 3, recoverDelay: 0.08, recoverRate: 9, patternRecover: 12 },
    zoom: null,
  }),

  // 약 36 m까지 몸 2발에 머리 1발이라 주무기처럼 쓸 수 있다. 0.46초 간격과 6발 탄창, 큰 반동으로 P-9보다 빗나감의 대가가 크다.
  pt_magnum: gun({
    id: 'pt_magnum', slot: 2, kind: 'pistol', category: 'pistol', fire: 'semi', price: 500,
    name: 'M-44 매그넘', nameEn: 'M-44 Magnum', short: 'M-44', role: '보조',
    icon: '🧨', color: '#b5651d', sound: 'magnum', fxKind: 'pistol',
    tagline: '여섯 발, 한 발 한 발이 무겁다.',
    desc: '보조 무기 중 유일하게 가까운 거리에서 머리 1발 킬이 된다. 탄창이 작고 반동이 커서 연타하기 어렵다.',
    recoilNote: '한 발에 크게 튄다',
    bars: { power: 68, rate: 25, accuracy: 66, mobility: 82 },

    damage: { head: 110, body: 55, legs: 38, hand: 25, foot: 25 },
    falloff: { start: 25, end: 60, min: 0.7 },
    maxRange: 170,

    rpm: 130, fireInterval: 0.46,

    mag: 6, reserve: 24, reload: 2.2, reloadEmpty: 2.5,
    drawTime: 0.55, moveMul: 0.97,

    spread: { hip: 1.1, move: 2.0, air: 5, bloomPerShot: 0.9, bloomMax: 2.6, bloomDecay: 3.6, max: 9 },
    recoil: { pattern: PT_MAGNUM_PATTERN, loopFrom: 1, adsMul: 1, maxPitch: 8, maxYaw: 3,
      recoverDelay: 0.12, recoverRate: 6, patternRecover: 8 },
    zoom: null,
  }),

  // ───────────────────────────── 슬롯 3 · 근접 ─────────────────────────────
  ml_knife: blade({
    id: 'ml_knife', slot: 3, kind: 'melee', category: 'melee', fire: 'melee', price: 0,
    name: '컴뱃 나이프', nameEn: 'Combat Knife', short: 'KNIFE', role: '근접',
    icon: '🔪', color: '#b8935a', sound: 'knife_slash', fxKind: null,
    heavySound: 'knife_slash', hitSound: 'knife_hit',
    tagline: '빠르고 짧게, 바로 앞의 적에게.',
    desc: '사거리는 짧지만 베기가 빠르고 이동이 가장 빠르다. 찌르기는 한 번에 쓰러뜨린다.',
    bars: { power: 70, rate: 40, accuracy: 30, mobility: 100 },

    damage: null,
    falloff: null,
    melee: {
      slash: { label: '베기', damage: 50, cooldown: 0.45, windup: 0.06, range: 1.8, arc: 35 },
      stab: { label: '찌르기', damage: 100, cooldown: 1.0, windup: 0.22, range: 1.8, arc: 12 },
    },
    maxRange: 1.8,
    rpm: 133, fireInterval: 0.45,
    mag: null, reserve: null, reload: null,
    drawTime: 0.4, moveMul: 1.1,
    spread: null, recoil: null, zoom: null,
  }),

  // 베기가 2발 킬(65×2)로 나이프와 같은데 사거리가 1.5배다. 선딜과 쿨다운이 길어 먼저 맞으면 진다.
  ml_katana: blade({
    id: 'ml_katana', slot: 3, kind: 'melee', category: 'melee', fire: 'melee', price: 0,
    name: '카게 카타나', nameEn: 'Kage Katana', short: 'KATANA', role: '근접',
    icon: '🗡️', color: '#ff4d8d', sound: 'katana_swing', fxKind: null,
    heavySound: 'katana_heavy', hitSound: 'katana_hit',
    tagline: '길게 베고 느리게 거둔다.',
    desc: '멀리서 넓게 베는 긴 칼이다. 강타는 한 번에 쓰러뜨리지만 휘두른 뒤 빈틈이 크다.',
    bars: { power: 90, rate: 28, accuracy: 55, mobility: 92 },

    damage: null,
    falloff: null,
    melee: {
      slash: { label: '베기', damage: 65, cooldown: 0.62, windup: 0.12, range: 2.7, arc: 48 },
      stab: { label: '강타', damage: 120, cooldown: 1.25, windup: 0.34, range: 2.9, arc: 14 },
    },
    maxRange: 2.9,
    rpm: 97, fireInterval: 0.62,
    mag: null, reserve: null, reload: null,
    drawTime: 0.55, moveMul: 1.05,
    spread: null, recoil: null, zoom: null,
  }),

  // ───────────────────────────── 슬롯 4 · 투척 ─────────────────────────────
  gr_frag: {
    id: 'gr_frag', slot: 4, kind: 'grenade', category: 'grenade', fire: 'throw', price: 0,
    name: '수류탄', nameEn: 'Frag Grenade', short: 'FRAG', role: '투척',
    icon: '💣', color: '#e0b324', sound: 'grenade_pin', fxKind: null,
    tagline: '핀을 뽑고, 던지고, 엄폐.',
    desc: '좌클릭으로 멀리 던지고 우클릭으로 낮게 굴린다. 벽 뒤에 있으면 피해를 받지 않는다.',
    stats: [
      { label: '투척', value: '누르고 떼기 · 16 m/s' }, { label: '굴리기', value: '우클릭' },
      { label: '폭발', value: '2.5초 · 반경 6 m · 최대 100' }, { label: '엄폐', value: '가리면 피해 없음' }, { label: '수량', value: '1개' },
    ],
    bars: { power: 90, rate: 5, accuracy: 40, mobility: 85 },

    damage: null,
    falloff: null,
    count: 1,
    fuse: 2.5,
    throw: { speed: 16, pitchUp: 6 },      // 좌클릭: 시선보다 6° 위로
    lob: { speed: 8, pitchUp: 4 },         // 우클릭: 낮게 굴리기
    primeTime: 0.25,                       // 핀 뽑기 최소 시간(짧게 눌러도 이만큼 뒤에 던짐)
    throwRecover: 0.35,                    // 던진 뒤 손이 돌아오는 시간
    explosion: { radius: 6, inner: 0.8, max: 100 },   // inner 안쪽은 최대, 6m에서 0까지 선형 감쇠
    physics: {
      radius: 0.07, restitution: 0.35, friction: 0.3, rollDamp: 2.5, gravity: -12,
      restSpeed: 1.0,        // 법선 속도가 이보다 작으면 튀지 않고 미끄러진다
      sleepSpeed: 0.08,      // 바닥에서 이보다 느리면 멈춘다
      bounceEventSpeed: 1.2, // 이보다 세게 부딪히면 bounce 이벤트(소리용)
      step: 1 / 120,         // 고정 시간 간격(모든 클라이언트가 같은 궤적을 계산하도록)
    },
    maxRange: 6,
    rpm: 100, fireInterval: 0.6,
    mag: null, reserve: null, reload: null,
    drawTime: 0.5, moveMul: 1.0,
    spread: null, recoil: null, zoom: null,
  },
};

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const k of Object.keys(o)) deepFreeze(o[k]);
  }
  return o;
}

/** 무기 정의 표(읽기 전용). */
export const WEAPONS = deepFreeze(WEAPON_TABLE);

export const WEAPON_IDS = Object.freeze(Object.keys(WEAPONS));
const idsInSlot = (slot) => Object.freeze(WEAPON_IDS.filter((id) => WEAPONS[id].slot === slot));
/** 슬롯 1(주무기)에 고를 수 있는 무기. 표 순서 그대로 상점·로드아웃에 나온다. */
export const PRIMARY_IDS = idsInSlot(1);
export const SECONDARY_IDS = idsInSlot(2);
export const MELEE_IDS = idsInSlot(3);
export const GRENADE_IDS = idsInSlot(4);

export const DEFAULT_LOADOUT = Object.freeze({ primary: 'ar_std', secondary: 'pt_std', melee: 'ml_katana' });

/** id로 정의를 찾는다. 없으면 null. 네트워크로 온 값도 받는다(문자열이 아니면 null, 던지지 않는다). */
export function getDef(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(WEAPONS, id) ? WEAPONS[id] : null;
}

const PART_ALIAS = new Map(Object.entries({
  head: 'head', neck: 'head', helmet: 'head',
  body: 'body', chest: 'body', torso: 'body', arm: 'body', arms: 'body',
  legs: 'legs', leg: 'legs',
  hand: 'hand', hands: 'hand', finger: 'hand', fingers: 'hand',
  foot: 'foot', feet: 'foot', boot: 'foot', boots: 'foot',
}));

/** 부위 이름을 PARTS 중 하나로 정규화한다(모르는 값은 body). */
export function normalizePart(part) {
  return PART_ALIAS.get(String(part || '').toLowerCase()) || 'body';
}

/** 거리 감쇠 배율(0~1). falloff가 없으면 1. */
export function falloffMul(falloff, dist) {
  if (!falloff || !(dist > falloff.start)) return 1;
  if (dist >= falloff.end) return falloff.min;
  const t = (dist - falloff.start) / (falloff.end - falloff.start);
  return 1 + (falloff.min - 1) * t;
}

/** 폭발 데미지(거리만 반영, 차폐는 grenade.js에서 판정). 정수. */
export function explosionFalloff(dist, ex = WEAPONS.gr_frag.explosion) {
  const d = Number.isFinite(dist) ? Math.max(0, dist) : 0;
  if (d >= ex.radius) return 0;
  if (d <= ex.inner) return ex.max;
  return Math.round(ex.max * (1 - (d - ex.inner) / (ex.radius - ex.inner)));
}

/**
 * 데미지 계산의 유일한 구현 → 정수 데미지. match.js도 이것을 쓴다.
 * @param {string} id     무기 id
 * @param {string} part   부위 이름(normalizePart 참고). 칼·수류탄은 무시
 * @param {number} dist   거리(m). 총은 거리 감쇠, 수류탄은 폭심 거리
 * @param {string} [kind] 칼: 'slash'(기본) | 'stab'
 * @param {number} [count=1] 같은 대상에 맞은 펠릿 수(총만 곱한다)
 */
export function computeDamage(id, part = 'body', dist = 0, kind, count = 1) {
  const def = getDef(id);
  if (!def) return 0;
  if (def.melee) return def.melee[kind === 'stab' ? 'stab' : 'slash'].damage;
  if (def.explosion) return explosionFalloff(dist, def.explosion);
  if (!def.damage) return 0;
  const p = normalizePart(part);
  const d = Number.isFinite(dist) ? Math.max(0, dist) : 0;
  const mul = p === 'head' && def.headIgnoresFalloff ? 1 : falloffMul(def.falloff, d);
  const n = Number.isFinite(count) && count >= 1 ? Math.floor(count) : 1;
  return Math.max(1, Math.round(def.damage[p] * mul * n));
}

/** computeDamage의 옛 이름. */
export const damage = computeDamage;

/** 저격총이 손끝이나 발에 맞은 타격(반샷)인가. */
export function isHalfShot(id, part) {
  const def = getDef(id);
  if (!def || def.kind !== 'sniper') return false;
  const p = normalizePart(part);
  return p === 'hand' || p === 'foot';
}

/**
 * 같은 사수가 이 무기로 낼 수 있는 가장 짧은 사격 간격(초). 방장의 연사 검증 기준이다.
 * 점사 무기의 fireInterval은 점사 뒤 쉬는 시간이라 그대로 쓰면 둘째 발부터 전부 거부된다. 그래서 burst.gap을 쓴다.
 */
export function minShotInterval(id) {
  const def = getDef(id);
  if (!def) return 0;
  if (def.melee) return Math.min(def.melee.slash.cooldown, def.melee.stab.cooldown);
  if (def.burst) return def.burst.gap;
  return def.fireInterval;
}

/** 배율 mag의 줌 FOV(°). tan(fov/2)를 배율로 나눈다. */
export function zoomFov(baseFovDeg, mag) {
  const base = Number.isFinite(baseFovDeg) && baseFovDeg > 0 ? baseFovDeg : BASE_FOV;
  const m = Number.isFinite(mag) && mag > 0 ? mag : 1;
  return 2 * Math.atan(Math.tan((base * DEG) / 2) / m) / DEG;
}
