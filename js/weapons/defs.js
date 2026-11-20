/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 무기 17종과 수류탄(+ 좀비 모드 전용 3종)의 수치·표시 정보, 데미지 계산의 유일한 구현(computeDamage)을 둔다.
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
/** 상점 가격이 이 값 이상인 총은 프리미엄이다. 예비 탄약이 무제한이고, 탄창과 재장전은 그대로다. 나머지 총은 탄창 + 예비 2탄창이 전부다. */
export const PREMIUM_PRICE = 1200;

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
/** PM-9 펌프. 한 발마다 크게 튀지만 BX-12보다 작다(펠릿이 많고 탄퍼짐이 좁은 대신 느리게 쏜다). */
const SG_PUMP_PATTERN = [[0.00, 3.40], [0.35, 3.00], [-0.35, 3.00]];
/** DB-2 쌍발. 두 발이 거의 같이 나가서 첫 발이 가장 크게 튄다. */
const SG_DOUBLE_PATTERN = [[0.00, 5.00], [0.55, 4.60]];
/** AS-12 오토. 연사하는 산탄총이라 한 발은 작게, 쏟아부을수록 좌우로 흔들린다. */
const SG_AUTO_PATTERN = [[0.00, 1.90], [0.25, 1.70], [-0.25, 1.70], [0.15, 1.50], [-0.15, 1.50], [0.30, 1.40], [-0.30, 1.40], [0.00, 1.40]];
/**
 * UZ-2 듀얼 우지. 왼손·오른손 총이 번갈아 나가서 한 발마다 좌우가 번갈아 튄다(처음 8발은 점점 벌어지고 그 뒤로는 작게 흔들린다).
 * 위로는 발당 0.2~0.3°라 VX-3와 비슷하지만 좌우가 두 배 넓다.
 */
const SM_UZI_DUAL_PATTERN = [
  [0.20, 0.22], [-0.22, 0.24], [0.26, 0.26], [-0.28, 0.26], [0.30, 0.26], [-0.32, 0.24], [0.32, 0.22], [-0.32, 0.22],
  [0.28, 0.20], [-0.28, 0.20], [0.26, 0.18], [-0.26, 0.18], [0.24, 0.18], [-0.24, 0.18], [0.22, 0.16], [-0.22, 0.16],
];
/** MN-6 미니건. 위로 발당 0.14~0.16°씩 올라가다가 좌우로 천천히 흔들린다. 12발 주기로 되돌아온다. */
const MG_MINIGUN_PATTERN = [
  [0.02, 0.16], [0.04, 0.16], [-0.03, 0.16], [0.05, 0.15], [-0.05, 0.15], [0.06, 0.15],
  [-0.06, 0.14], [0.05, 0.14], [-0.05, 0.14], [0.04, 0.14], [-0.04, 0.14], [0.02, 0.14],
];
const SR_BOLT_PATTERN = [[0.00, 3.20]];
const SR_TWIN_PATTERN = [[0.15, 3.40]];
const SR_SWIFT_PATTERN = [[-0.20, 2.20], [0.25, 2.00]];
const SR_HEAVY_PATTERN = [[0.35, 5.50], [-0.35, 5.50]];
const PT_STD_PATTERN = [[0.00, 1.30], [0.25, 1.15], [-0.25, 1.15], [0.15, 1.05]];
const PT_MAGNUM_PATTERN = [[0.00, 3.00], [0.50, 2.70], [-0.50, 2.70]];
/** SH-2 쇼티. 두 발을 빠르게 쏘므로 둘째 발이 조금 옆으로 튄다 */
const SG_SHORTY_PATTERN = [[0.00, 3.80], [0.45, 3.40]];
/** AG-8 공기총. 압축 공기가 터지며 위로 한 번 튄다 */
const PN_AIR_PATTERN = [[0.00, 2.20]];

/**
 * MG-100(100발, 좀비 전용). 처음 8발은 거의 수직으로 솟고(발당 0.5~0.8°), 9~16발은 왼쪽으로, 17~20발은 오른쪽으로 끌린다.
 * 21발째부터는 20발 주기로 좌우로 크게 흔들린다(loopFrom 20, 한 주기의 좌우 합은 0이라 한쪽으로만 흐르지 않는다). 위로는 발당 0.12°씩 계속 오른다.
 */
const MG_LMG_PATTERN = [
  [0.04, 0.62], [0.08, 0.72], [-0.04, 0.78], [0.10, 0.80], [0.12, 0.76],
  [0.06, 0.70], [0.14, 0.62], [0.04, 0.54], [-0.22, 0.44], [-0.40, 0.38],
  [-0.52, 0.32], [-0.58, 0.28], [-0.56, 0.24], [-0.46, 0.22], [-0.30, 0.20],
  [-0.10, 0.18], [0.14, 0.16], [0.34, 0.15], [0.46, 0.14], [0.52, 0.13],
  [0.52, 0.12], [0.49, 0.12], [0.42, 0.12], [0.31, 0.12], [0.16, 0.12],
  [0.00, 0.12], [-0.16, 0.12], [-0.31, 0.12], [-0.42, 0.12], [-0.49, 0.12],
  [-0.52, 0.12], [-0.49, 0.12], [-0.42, 0.12], [-0.31, 0.12], [-0.16, 0.12],
  [0.00, 0.12], [0.16, 0.12], [0.31, 0.12], [0.42, 0.12], [0.49, 0.12],
];

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
    const one = [['head', '머리'], ['body', '몸'], ['legs', '다리']].filter(([p]) => d[p] >= PLAYER_HP).map(([, n]) => n);
    rows.push({ label: '피해', value: base });
    rows.push({ label: '반샷', value: `${limbsText(d)} · ${one.length === 3 ? '나머지 부위 1발 킬' : one.length === 1 ? '머리만 1발 킬' : `${one.join('·')} 1발 킬`}` });
    rows.push({ label: '퀵스코프', value: `줌 ${pct(z.accurateAt)}(${sec(z.accurateAt * z.inTime)})부터 정조준` });
  } else if (w.pellets > 1) {
    rows.push({ label: '피해', value: `펠릿 ${w.pellets}발 · 발당 ${base} · ${limbsText(d)}` });
  } else {
    rows.push({ label: '피해', value: `${base} · ${limbsText(d)}` });
  }
  rows.push({ label: '감쇠', value: f ? `${f.start}~${f.end} m → ${pct(f.min)}${w.headIgnoresFalloff ? ' · 머리 제외' : ''}` : '없음' });
  if (z) rows.push({ label: '줌', value: `${zoomText(z)} · 이동 ${pct(z.moveMul)}` });
  if (w.recoilNote) rows.push({ label: '반동', value: w.recoilNote });
  rows.push({ label: '탄약', value: `${w.mag} / ${w.premium || !Number.isFinite(w.reserve) ? '무제한' : w.reserve}` });
  rows.push({ label: '이동', value: pct(w.moveMul) });
  return rows;
}

function meleeStats(w) {
  const row = (m) => ({ label: m.label, value: `${m.damage} · ${sec(m.cooldown)} · ${m.range} m` });
  return [row(w.melee.slash), row(w.melee.stab), { label: '이동', value: pct(w.moveMul) }];
}

/** 밀어내기(knock) 행: 좀비 물량 막기에서 맞은 좀비가 날아가는 속도와 각도. 사람은 밀지 않는다 */
function knockRow(w) {
  const parts = [['shot', '맞히면'], ['slash', w.melee && w.melee.slash.label], ['stab', w.melee && w.melee.stab.label]]
    .filter(([k]) => w.knock[k]).map(([k, n]) => `${n} ${w.knock[k].speed} m/s · 위 ${w.knock[k].up}°`);
  return { label: '밀어내기', value: `${parts.join(' / ')} (좀비 모드)` };
}

/** 표의 값에 프리미엄 여부와 카드 문구를 더한다. 프리미엄 총의 reserve는 Infinity라 재장전 계산이 그대로 돈다. premium: false를 적으면 비싸도 예비가 정해진 총이다 */
function gun(o) {
  const premium = o.premium ?? o.price >= PREMIUM_PRICE;
  const w = { pellets: 1, headIgnoresFalloff: false, ...o, premium, reserve: premium ? Infinity : o.reserve };
  const stats = gunStats(w);
  return { ...w, stats: w.knock ? [...stats, knockRow(w)] : stats };
}
const blade = (o) => ({ ...o, stats: o.knock ? [...meleeStats(o), knockRow(o)] : meleeStats(o) });

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
    bars: { power: 48, rate: 62, accuracy: 68, mobility: 72 },

    // 밸런스 패치(2026-11-12): 몸 30 → 24. 몸 4발(0.30초)에서 5발(0.40초)로 교전이 조금 길어진다. 머리 1발은 그대로
    damage: { head: 110, body: 24, legs: 18, hand: 12, foot: 12 },
    headIgnoresFalloff: true,                      // 라이플 공통: 거리와 상관없이 머리 1발 킬
    falloff: { start: 30, end: 80, min: 0.75 },
    maxRange: 250,

    rpm: 600, fireInterval: 60 / 600,

    mag: 30, reserve: 60, reload: 2.3, reloadEmpty: 2.7,
    drawTime: 0.65, moveMul: 0.95,

    spread: { hip: 1.2, ads: 0.2, move: 2.5, adsMove: 1.0, air: 5, adsAir: 4,
      bloomPerShot: 0.15, bloomMax: 1.5, bloomDecay: 4, adsBloomMul: 0.6, max: 10 },
    recoil: { pattern: AR_STD_PATTERN, loopFrom: 18, adsMul: 0.8, maxPitch: 10, maxYaw: 4,
      recoverDelay: 0.12, recoverRate: 7, patternRecover: 20 },
    zoom: { mag: 2, inTime: 0.18, outTime: 0.12, accurateAt: null, overlay: null,
      hideViewmodelAt: null, moveMul: 0.8, unzoomOnFire: false },
  }),

  // 몸 19로 약하지만 860rpm이라 근거리 TTK(6발 0.35초)가 표준(5발 0.40초)보다 살짝 빠르다. 반동과 탄퍼짐이 그 값을 치른다.
  ar_rapid: gun({
    id: 'ar_rapid', slot: 1, kind: 'rifle', category: 'rifle', fire: 'auto', price: 800,
    name: 'RX-9 스톰', nameEn: 'RX-9 Storm', short: 'RX-9', role: '연사',
    icon: '🌪️', color: '#e8731c', sound: 'rifle', fxKind: 'rifle',
    tagline: '퍼붓는 만큼 제어가 어렵다.',
    desc: '가장 빠른 라이플이다. 반동이 넓고 탄도 많이 퍼져서 짧게 끊어 쏘지 않으면 금방 조준을 잃는다.',
    recoilNote: '크고 넓게 흔들린다',
    bars: { power: 38, rate: 90, accuracy: 45, mobility: 78 },

    damage: { head: 100, body: 19, legs: 14, hand: 10, foot: 10 },
    headIgnoresFalloff: true,
    falloff: { start: 25, end: 70, min: 0.7 },
    maxRange: 220,

    rpm: 860, fireInterval: 60 / 860,

    mag: 35, reserve: 70, reload: 2.4, reloadEmpty: 2.9,
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
  // 요청(2026-11-20)으로 탄약은 25/100: 가격은 프리미엄대지만 예비가 무제한이 아니다(premium: false).
  ar_line: gun({
    id: 'ar_line', slot: 1, kind: 'rifle', category: 'rifle', fire: 'auto', price: 1200, premium: false,
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

    mag: 25, reserve: 100, reload: 2.2, reloadEmpty: 2.6,
    drawTime: 0.7, moveMul: 0.95,

    spread: { hip: 0.8, ads: 0.06, move: 2.0, adsMove: 0.7, air: 5, adsAir: 4,
      bloomPerShot: 0.06, bloomMax: 0.6, bloomDecay: 6, adsBloomMul: 0.5, max: 8 },
    recoil: { pattern: AR_LINE_PATTERN, loopFrom: 15, adsMul: 0.8, maxPitch: 4, maxYaw: 1.6,
      recoverDelay: 0.14, recoverRate: 9, patternRecover: 18 },
    zoom: { mag: 2.4, inTime: 0.2, outTime: 0.13, accurateAt: null, overlay: null,
      hideViewmodelAt: null, moveMul: 0.75, unzoomOnFire: false },
  }),

  // 밸런스 패치(2026-11-12): 예전에는 34×3 = 102라 약 33 m까지 점사 한 번(0.13초)이 곧 킬이라 다른 총보다 두 배 넘게 빨랐다.
  // 지금은 몸 28이라 두 번째 점사의 첫 발에 쓰러진다(0.45초). 그 대신 재사격이 0.32초로 짧고 반동·탄퍼짐이 가장 작은 축이라 중거리에 강하다.
  ar_burst: gun({
    id: 'ar_burst', slot: 1, kind: 'rifle', category: 'rifle', fire: 'burst', price: 1000,
    name: 'BR-3 트리플', nameEn: 'BR-3 Triple', short: 'BR-3', role: '점사',
    icon: '🔱', color: '#8e5bd6', sound: 'rifle', fxKind: 'rifle',
    tagline: '한 번 당기면 세 발.',
    desc: '한 번 누르면 세 발이 나가고 잠시 쉰다. 두 번의 점사로 쓰러뜨리고, 머리에 한 발이라도 맞으면 바로 끝난다.',
    recoilNote: '세 발 동안 계단식으로',
    bars: { power: 55, rate: 60, accuracy: 74, mobility: 72 },

    damage: { head: 110, body: 28, legs: 20, hand: 13, foot: 13 },
    headIgnoresFalloff: true,
    falloff: { start: 30, end: 80, min: 0.75 },
    maxRange: 250,

    // fireInterval은 점사가 끝난 뒤 쉬는 시간. rpm은 쉬는 시간까지 넣은 실효 연사다(3발 / 0.45초).
    rpm: 400, fireInterval: 0.32,
    burst: { count: 3, gap: 0.065 },

    mag: 30, reserve: 60, reload: 2.3, reloadEmpty: 2.7,
    drawTime: 0.65, moveMul: 0.95,

    spread: { hip: 1.0, ads: 0.15, move: 2.5, adsMove: 1.0, air: 5, adsAir: 4,
      bloomPerShot: 0.18, bloomMax: 1.2, bloomDecay: 5, adsBloomMul: 0.6, max: 9 },
    // patternRecover 7: 재사격 간격(0.32초)으로는 패턴이 다 돌아오지 않아 몰아 쏘면 뒤 묶음으로 밀린다
    recoil: { pattern: AR_BURST_PATTERN, loopFrom: 3, adsMul: 0.8, maxPitch: 8, maxYaw: 3,
      recoverDelay: 0.1, recoverRate: 8, patternRecover: 7 },
    zoom: { mag: 2.2, inTime: 0.18, outTime: 0.12, accurateAt: null, overlay: null,
      hideViewmodelAt: null, moveMul: 0.8, unzoomOnFire: false },
  }),

  // 밸런스 패치(2026-11-12): 예전에는 감쇠가 없어 80 m에서도 몸 2발(0.30초)이라 먼 거리에서 라이플·저격총의 몫을 다 가져갔다.
  // 지금은 50 m까지 몸 2발(0.36초), 그 뒤로는 3발이다. 저격총의 1발과 라이플의 연사 사이를 메운다. 상점 탭은 라이플에 묶는다.
  dm_mark: gun({
    id: 'dm_mark', slot: 1, kind: 'dmr', category: 'rifle', fire: 'semi', price: 1500,
    name: 'DM-4 마크스맨', nameEn: 'DM-4 Marksman', short: 'DM-4', role: '지정사수',
    icon: '🏹', color: '#6fbf4a', sound: 'dmr', fxKind: 'rifle',
    tagline: '한 발씩 또박또박, 3배로 멀리.',
    desc: '50 m까지 몸 2발로 쓰러뜨리는 반자동 소총이다. 3배 조준에 스코프 오버레이가 없어 주변이 그대로 보인다.',
    recoilNote: '발마다 크게 튄다',
    bars: { power: 70, rate: 26, accuracy: 88, mobility: 58 },

    damage: { head: 130, body: 50, legs: 36, hand: 25, foot: 25 },
    headIgnoresFalloff: true,
    falloff: { start: 50, end: 120, min: 0.85 },
    maxRange: 350,

    rpm: 167, fireInterval: 60 / 167,

    mag: 15, reload: 2.6, reloadEmpty: 3.0,
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

    mag: 32, reserve: 64, reload: 1.9, reloadEmpty: 2.2,
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
    id: 'sg_bx12', slot: 1, kind: 'shotgun', category: 'shotgun', fire: 'semi', price: 700,
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

    mag: 6, reserve: 12, reload: 2.6, reloadEmpty: 3.0,
    drawTime: 0.7, moveMul: 0.98,

    spread: { hip: 3.2, move: 0.8, air: 2.5, bloomPerShot: 0, bloomMax: 0, bloomDecay: 0, max: 7 },
    recoil: { pattern: SG_BX12_PATTERN, loopFrom: 1, adsMul: 1, maxPitch: 9, maxYaw: 2.5,
      recoverDelay: 0.12, recoverRate: 6, patternRecover: 5 },
    zoom: null,
  }),

  // 펌프액션 산탄총. 펠릿 9발이 모두 몸에 맞으면 117이고 BX-12보다 탄퍼짐이 좁아 10 m 안에서는 한 방이 잘 나온다. 28 m까지 40%가 남는다.
  // 그 대신 한 발에 1초가 걸리고 7발을 다 쓰면 재장전이 길다. 한 방을 노리는 무기다.
  sg_pump: gun({
    id: 'sg_pump', slot: 1, kind: 'shotgun', category: 'shotgun', fire: 'semi', price: 900,
    name: 'PM-9 펌프', nameEn: 'PM-9 Pump', short: 'PM-9', role: '펌프액션',
    icon: '🪵', color: '#c07f3a', sound: 'shotgun', fxKind: 'rifle',
    tagline: '당기고, 밀고, 한 방.',
    desc: '펠릿 9발을 모아 쏘는 펌프액션 산탄총이다. BX-12보다 탄이 덜 퍼지고 멀리 닿지만, 한 발마다 펌프를 당겨야 해서 느리다.',
    recoilNote: '한 발에 크게 튄다',
    bars: { power: 88, rate: 10, accuracy: 38, mobility: 76 },

    damage: { head: 18, body: 13, legs: 9, hand: 6, foot: 6 },   // 펠릿 1발 기준
    pellets: 9,
    falloff: { start: 10, end: 28, min: 0.4 },
    maxRange: 55,

    rpm: 60, fireInterval: 1.0,

    mag: 7, reserve: 14, reload: 3.4, reloadEmpty: 3.8,
    drawTime: 0.7, moveMul: 0.97,

    spread: { hip: 2.4, move: 0.8, air: 2.5, bloomPerShot: 0, bloomMax: 0, bloomDecay: 0, max: 6 },
    recoil: { pattern: SG_PUMP_PATTERN, loopFrom: 1, adsMul: 1, maxPitch: 8, maxYaw: 2.2,
      recoverDelay: 0.12, recoverRate: 6, patternRecover: 5 },
    zoom: null,
  }),

  // 쌍발 산탄총. 펠릿 10발이 모두 맞으면 160이라 코앞에서는 어디에 맞아도 한 방이고, 두 발을 0.35초에 쏟아낸다. 탄퍼짐이 가장 넓고 18 m 밖에서는 30%만 남으며
  // 탄창이 두 발뿐이라 둘 다 빗나가면 재장전이 곧 죽음이다.
  sg_double: gun({
    id: 'sg_double', slot: 1, kind: 'shotgun', category: 'shotgun', fire: 'semi', price: 1000,
    name: 'DB-2 쌍발', nameEn: 'DB-2 Double Barrel', short: 'DB-2', role: '쌍발',
    icon: '♊', color: '#8a5a2b', sound: 'shotgun', fxKind: 'rifle',
    tagline: '두 발, 그걸로 끝내라.',
    desc: '총열이 두 개인 쌍발 산탄총이다. 펠릿 10발의 위력이 가장 크고 연달아 두 번 쏘지만, 두 발을 쓰면 바로 장전해야 하고 탄이 넓게 퍼진다.',
    recoilNote: '두 발 모두 크게 튄다',
    bars: { power: 98, rate: 20, accuracy: 15, mobility: 82 },

    damage: { head: 22, body: 16, legs: 11, hand: 8, foot: 8 },   // 펠릿 1발 기준
    pellets: 10,
    falloff: { start: 6, end: 18, min: 0.3 },
    maxRange: 35,

    rpm: 171, fireInterval: 0.35,

    mag: 2, reserve: 4, reload: 2.4, reloadEmpty: 2.8,   // 예비는 탄창 2개(규칙). 좀비 모드는 3배라 12발
    drawTime: 0.6, moveMul: 1.0,

    spread: { hip: 4.2, move: 1.2, air: 3, bloomPerShot: 0, bloomMax: 0, bloomDecay: 0, max: 8 },
    recoil: { pattern: SG_DOUBLE_PATTERN, loopFrom: 1, adsMul: 1, maxPitch: 10, maxYaw: 3,
      recoverDelay: 0.12, recoverRate: 6, patternRecover: 6 },
    zoom: null,
  }),

  // 자동 산탄총. 탄약은 요청(2026-11-20)으로 12/60(premium: false). 펠릿 8발 × 9로 한 발은 가까이서 72이고 두 발이면 쓰러진다. 0.3초마다 쏘는 대신 한 발마다 BX-12의 3분의 2 위력이라
  // 근거리 TTK는 비슷하고 연속 교전에 강하다. 이동이 느리고 탄이 넓게 퍼지며 20 m 밖에서는 35%뿐이다.
  sg_auto: gun({
    id: 'sg_auto', slot: 1, kind: 'shotgun', category: 'shotgun', fire: 'auto', price: 1500, premium: false,
    name: 'AS-12 스톰브레이커', nameEn: 'AS-12 Stormbreaker', short: 'AS-12', role: '자동',
    icon: '🌩️', color: '#e0572b', sound: 'shotgun', fxKind: 'rifle',
    tagline: '방아쇠를 당기고 있는 한 계속 터진다.',
    desc: '방아쇠를 누르고 있으면 계속 나가는 자동 산탄총이다. 한 발은 약하지만 연사가 빨라 가까운 적을 몰아붙이기 좋고, 예비 탄약이 60발로 넉넉하다.',
    recoilNote: '연사하면 좌우로 흔들린다',
    bars: { power: 62, rate: 40, accuracy: 24, mobility: 70 },

    damage: { head: 14, body: 9, legs: 6, hand: 4, foot: 4 },   // 펠릿 1발 기준
    pellets: 8,
    falloff: { start: 7, end: 20, min: 0.35 },
    maxRange: 45,

    rpm: 200, fireInterval: 0.3,

    mag: 12, reserve: 60, reload: 3.2, reloadEmpty: 3.6,
    drawTime: 0.8, moveMul: 0.93,

    spread: { hip: 3.6, move: 1.0, air: 3, bloomPerShot: 0.3, bloomMax: 1.5, bloomDecay: 5, max: 8 },
    recoil: { pattern: SG_AUTO_PATTERN, loopFrom: 1, adsMul: 1, maxPitch: 9, maxYaw: 4,
      recoverDelay: 0.14, recoverRate: 6, patternRecover: 8 },
    zoom: null,
  }),

  // 양손에 우지를 하나씩 든다. 두 총이 번갈아 쏘아 초당 17발(1000rpm)이고 몸 15라 7발(0.36초)에 쓰러진다. 조준경이 없어 우클릭 조준이 없고
  // 탄퍼짐이 VX-3의 두 배쯤이며 10 m 밖부터 피해가 빨리 줄어(32 m에서 45%) 근접전 전용이다. 이동은 가장 빠르다.
  sm_uzi_dual: gun({
    id: 'sm_uzi_dual', slot: 1, kind: 'smg', category: 'smg', fire: 'auto', price: 1100,
    name: 'UZ-2 듀얼 우지', nameEn: 'UZ-2 Dual Uzi', short: 'UZ-2', role: '쌍권총',
    icon: '🎰', color: '#f0c419', sound: 'smg', fxKind: 'pistol',
    tagline: '양손에 하나씩, 양쪽으로 쏟아붓는다.',
    desc: '양손에 우지를 하나씩 들고 번갈아 쏜다. 연사가 아주 빠르지만 조준경이 없고 탄이 많이 퍼져서, 코앞에서 움직이며 쏘는 무기다.',
    recoilNote: '좌우로 번갈아 튄다',
    bars: { power: 38, rate: 96, accuracy: 28, mobility: 98 },

    damage: { head: 56, body: 15, legs: 11, hand: 7, foot: 7 },
    falloff: { start: 10, end: 32, min: 0.45 },
    maxRange: 90,

    rpm: 1000, fireInterval: 60 / 1000,

    mag: 50, reserve: 100, reload: 2.8, reloadEmpty: 3.2,
    drawTime: 0.6, moveMul: 1.05,

    // 조준(ads)이 없다. 이동 탄퍼짐은 VX-3의 절반 아래는 아니지만 총이 두 자루라 발사 때 벌어지는 정도(bloom)가 크다
    spread: { hip: 2.6, move: 1.0, air: 3.5, bloomPerShot: 0.14, bloomMax: 2.6, bloomDecay: 5, max: 10 },
    recoil: { pattern: SM_UZI_DUAL_PATTERN, loopFrom: 8, adsMul: 1, maxPitch: 6, maxYaw: 5,
      recoverDelay: 0.09, recoverRate: 10, patternRecover: 24 },
    zoom: null,
  }),

  // ───────────────────────────── 슬롯 1 · 기관총(상점) ─────────────────────────────
  // 회전 총열 미니건. 1200rpm(초당 20발)에 탄창 200발이라 한 탄창 피해가 2,400이지만 몸 12로 9발(0.4초)이 필요하다.
  // 대가: 이동 58%, 꺼내기 1.4초, 재장전 6초, 조준 없음. 요청(2026-11-20)으로 탄약은 200/200: 가격은 프리미엄대지만 예비가 무제한이 아니다(premium: false). 좀비 전용 MG-100(100발)과 다른 총이다.
  mg_minigun: gun({
    id: 'mg_minigun', slot: 1, kind: 'lmg', category: 'lmg', fire: 'auto', price: 2800, premium: false,
    name: 'MN-6 미니건', nameEn: 'MN-6 Minigun', short: 'MN-6', role: '제압',
    icon: '🌀', color: '#7a8f9e', sound: 'lmg', fxKind: 'rifle',
    tagline: '총열이 돌면, 탄이 멈추지 않는다.',
    desc: '회전하는 여섯 총열로 초당 20발을 쏟아붓는 중화기다. 탄창 200발에 예비도 200발이라 아껴 써야 하고, 들고 있으면 걸음이 아주 느리고 꺼내기·재장전이 길다.',
    recoilNote: '천천히 오르며 흔들린다',
    bars: { power: 62, rate: 94, accuracy: 36, mobility: 8 },

    damage: { head: 44, body: 12, legs: 9, hand: 5, foot: 5 },
    falloff: { start: 20, end: 60, min: 0.6 },
    maxRange: 200,

    rpm: 1200, fireInterval: 60 / 1200,

    mag: 200, reserve: 200, reload: 6.0, reloadEmpty: 6.6,
    drawTime: 1.4, moveMul: 0.58,

    spread: { hip: 2.8, move: 3.5, air: 6, bloomPerShot: 0.06, bloomMax: 2.4, bloomDecay: 3, max: 9 },
    recoil: { pattern: MG_MINIGUN_PATTERN, loopFrom: 6, adsMul: 1, maxPitch: 9, maxYaw: 4,
      recoverDelay: 0.14, recoverRate: 5, patternRecover: 14 },
    zoom: null,
  }),

  // ───────────────────────────── 슬롯 1 · 저격 ─────────────────────────────
  // 손·발만 맞으면 50(반샷)이라 1발 킬에 조준 실력의 여지를 남긴다. 머리·몸은 1발 킬이다.
  // 밸런스 패치(2026-11-12): 기본 지급 저격총이 다리까지 1발이라 아무 데나 맞혀도 끝났다. 다리는 85로 한 발이 더 필요하다.
  sr_bolt: gun({
    id: 'sr_bolt', slot: 1, kind: 'sniper', category: 'sniper', fire: 'bolt', price: 0,
    name: 'SK-7 볼트', nameEn: 'SK-7 Bolt', short: 'SK-7', role: '저격',
    icon: '🎯', color: '#f2c230', sound: 'sniper', fxKind: 'sniper',
    tagline: '숨을 고르고, 한 방.',
    desc: '기본 저격총이다. 머리·몸은 1발 킬이고 다리는 85, 손끝이나 발에 맞으면 반샷이 된다.',
    bars: { power: 92, rate: 12, accuracy: 95, mobility: 52 },

    damage: { head: 200, body: 120, legs: 85, hand: 50, foot: 50 },
    falloff: null,
    maxRange: 400,

    rpm: 50, fireInterval: 1.2,
    bolt: 1.2,               // 사격 후 볼트 조작 시간(이 동안 사격·줌 불가)
    emptyShotRecover: 0.35,  // 마지막 탄을 쏜 뒤 자동 재장전까지의 틈

    mag: 5, reserve: 10, reload: 3.0, reloadEmpty: 3.4,
    drawTime: 0.8, moveMul: 0.85,

    spread: { hip: 8, ads: 0, move: 2, adsMove: 1.5, air: 6, adsAir: 6,
      bloomPerShot: 0, bloomMax: 0, bloomDecay: 0, max: 16 },
    recoil: { pattern: SR_BOLT_PATTERN, loopFrom: 0, adsMul: 1, maxPitch: 6, maxYaw: 2,
      recoverDelay: 0.06, recoverRate: 5, patternRecover: 10 },
    zoom: { mag: 4, inTime: 0.16, outTime: 0.1, accurateAt: 0.5, overlay: 'scope',
      hideViewmodelAt: 0.9, moveMul: 0.8, unzoomOnFire: true },
  }),

  // SK-7과 위력이 같다. 9배를 얻는 대신 볼트·줌·이동이 조금씩 느려서 장거리가 아니면 손해다. 탄약은 요청(2026-11-20)으로 5/20(premium: false).
  sr_twin: gun({
    id: 'sr_twin', slot: 1, kind: 'sniper', category: 'sniper', fire: 'bolt', price: 1500, premium: false,
    name: 'T-2 트윈옵틱', nameEn: 'T-2 Twin Optic', short: 'T-2', role: '2단 저격',
    icon: '🔭', color: '#5b82d6', sound: 'sniper', fxKind: 'sniper',
    tagline: '4배로 찾고 9배로 끝낸다.',
    desc: '우클릭할 때마다 4배, 9배, 해제 순서로 바뀌는 2단 조준경을 달았다. 사격하면 줌이 풀린다.',
    bars: { power: 92, rate: 10, accuracy: 98, mobility: 45 },

    damage: { head: 200, body: 120, legs: 85, hand: 50, foot: 50 },
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

    mag: 7, reserve: 14, reload: 2.4, reloadEmpty: 2.8,
    drawTime: 0.6, moveMul: 0.95,

    spread: { hip: 5, ads: 0, move: 1.6, adsMove: 1.0, air: 5, adsAir: 5,
      bloomPerShot: 0, bloomMax: 0, bloomDecay: 0, max: 13 },
    recoil: { pattern: SR_SWIFT_PATTERN, loopFrom: 0, adsMul: 1, maxPitch: 5, maxYaw: 2,
      recoverDelay: 0.05, recoverRate: 7, patternRecover: 8 },
    zoom: { mag: 3, inTime: 0.12, outTime: 0.08, accurateAt: 0.5, overlay: 'scope',
      hideViewmodelAt: 0.9, moveMul: 0.88, unzoomOnFire: true },
  }),

  // 머리·몸·다리가 1발이고 반샷도 70으로 가장 크다. 볼트 1.9초와 탄 4/20(요청 2026-11-20, premium: false), 이동 75%가 빗나갔을 때의 대가다.
  sr_heavy: gun({
    id: 'sr_heavy', slot: 1, kind: 'sniper', category: 'sniper', fire: 'bolt', price: 2500, premium: false,
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

    mag: 4, reserve: 20, reload: 3.8, reloadEmpty: 4.4,
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

    mag: 12, reserve: 24, reload: 1.6, reloadEmpty: 1.9,
    drawTime: 0.45, moveMul: 1.0,

    spread: { hip: 0.8, move: 1.6, air: 4.5, bloomPerShot: 0.45, bloomMax: 2.0, bloomDecay: 6, max: 8 },
    recoil: { pattern: PT_STD_PATTERN, loopFrom: 1, adsMul: 1,
      maxPitch: 7, maxYaw: 3, recoverDelay: 0.08, recoverRate: 9, patternRecover: 12 },
    zoom: null,
  }),

  // 약 36 m까지 몸 2발에 머리 1발이다. 밸런스 패치(2026-11-12): 예전 0.46초 간격이면 보조무기가 주무기(RX-4)만큼 빨라서
  // 0.55초로 늦췄다. 6발 탄창과 큰 반동으로 P-9보다 빗나감의 대가가 크다.
  pt_magnum: gun({
    id: 'pt_magnum', slot: 2, kind: 'pistol', category: 'pistol', fire: 'semi', price: 500,
    name: 'M-44 매그넘', nameEn: 'M-44 Magnum', short: 'M-44', role: '보조',
    icon: '🧨', color: '#b5651d', sound: 'magnum', fxKind: 'pistol',
    tagline: '여섯 발, 한 발 한 발이 무겁다.',
    desc: '보조 무기 중 유일하게 가까운 거리에서 머리 1발 킬이 된다. 탄창이 작고 반동이 커서 연타하기 어렵다.',
    recoilNote: '한 발에 크게 튄다',
    bars: { power: 68, rate: 21, accuracy: 66, mobility: 82 },

    damage: { head: 110, body: 55, legs: 38, hand: 25, foot: 25 },
    falloff: { start: 25, end: 60, min: 0.7 },
    maxRange: 170,

    rpm: 109, fireInterval: 0.55,

    mag: 6, reserve: 12, reload: 2.2, reloadEmpty: 2.5,
    drawTime: 0.55, moveMul: 0.97,

    spread: { hip: 1.1, move: 2.0, air: 5, bloomPerShot: 0.9, bloomMax: 2.6, bloomDecay: 3.6, max: 9 },
    recoil: { pattern: PT_MAGNUM_PATTERN, loopFrom: 1, adsMul: 1, maxPitch: 8, maxYaw: 3,
      recoverDelay: 0.12, recoverRate: 6, patternRecover: 8 },
    zoom: null,
  }),

  // 짧게 자른 두 발짜리 산탄 보조무기(요청 2026-11-20, 발로란트 쇼티 같은 무기). 두 발을 0.25초 간격으로 쏟아내고 바로 장전한다.
  // 펠릿 12발 × 몸 7이라 코앞에서 84, 두 발이면 쓰러진다. 5 m부터 줄어 15 m에서는 30%라 멀면 쓸모가 없다.
  sg_shorty: gun({
    id: 'sg_shorty', slot: 2, kind: 'shotgun', category: 'shotgun', fire: 'semi', price: 400,
    name: 'SH-2 쇼티', nameEn: 'SH-2 Shorty', short: 'SH-2', role: '근거리 보조',
    icon: '✂️', color: '#a0522d', sound: 'shotgun', fxKind: 'rifle',
    tagline: '두 발을 빠르게, 코앞에서.',
    desc: '총열을 짧게 자른 두 발짜리 산탄 보조무기다. 두 발을 빠르게 연달아 쏘고 곧바로 장전한다. 5 m 안에서는 강하지만 15 m 밖에서는 힘이 거의 없다.',
    recoilNote: '두 발 모두 크게 튄다',
    bars: { power: 70, rate: 60, accuracy: 12, mobility: 92 },

    damage: { head: 10, body: 7, legs: 5, hand: 3, foot: 3 },   // 펠릿 1발 기준
    pellets: 12,
    falloff: { start: 5, end: 15, min: 0.3 },
    maxRange: 25,

    rpm: 240, fireInterval: 0.25,

    mag: 2, reserve: 4, reload: 1.75, reloadEmpty: 1.9,
    drawTime: 0.4, moveMul: 1.0,

    spread: { hip: 4.6, move: 0.8, air: 2.5, bloomPerShot: 0, bloomMax: 0, bloomDecay: 0, max: 8 },
    recoil: { pattern: SG_SHORTY_PATTERN, loopFrom: 1, adsMul: 1, maxPitch: 9, maxYaw: 2.5,
      recoverDelay: 0.1, recoverRate: 7, patternRecover: 6 },
    zoom: null,
  }),

  // ───────────────────────────── 슬롯 3 · 근접 ─────────────────────────────
  // 기본 지급. 갈고리 날에 밧줄을 감은 손잡이. 짧고 빠르게 베고, 찌르기는 한 번에 쓰러뜨린다.
  ml_knife: blade({
    id: 'ml_knife', slot: 3, kind: 'melee', category: 'melee', fire: 'melee', price: 0,
    name: '호크빌 나이프', nameEn: 'Hawkbill Knife', short: 'HAWKBILL', role: '근접',
    icon: '🔪', color: '#b8935a', sound: 'knife_slash', fxKind: null,
    heavySound: 'knife_slash', hitSound: 'knife_hit',
    tagline: '갈고리 날로 짧고 빠르게.',
    desc: '기본으로 주는 칼이다. 사거리는 짧지만 베기가 빠르고 몸이 가볍다. 찌르기는 한 번에 쓰러뜨린다.',
    bars: { power: 70, rate: 40, accuracy: 30, mobility: 95 },

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

  // 베기는 세 번에 쓰러뜨려 호크빌보다 약하다. 대신 찌르기가 더 빠르고 멀리 닿고, 들고 뛰는 속도가 가장 빠르다.
  ml_tanto: blade({
    id: 'ml_tanto', slot: 3, kind: 'melee', category: 'melee', fire: 'melee', price: 500,
    name: '탄토', nameEn: 'Tanto', short: 'TANTO', role: '근접',
    icon: '🔪', color: '#ff7a1a', sound: 'knife_slash', fxKind: null,
    heavySound: 'knife_slash', hitSound: 'knife_hit',
    tagline: '찌르는 데 쓰는 각진 칼.',
    desc: '무광 흑색 도신에 날만 밝게 갈았다. 베기는 약하지만 찌르기가 빠르고 멀리 닿으며 가장 빠르게 달린다.',
    bars: { power: 62, rate: 46, accuracy: 35, mobility: 100 },

    damage: null,
    falloff: null,
    melee: {
      slash: { label: '베기', damage: 40, cooldown: 0.42, windup: 0.06, range: 1.8, arc: 30 },
      stab: { label: '찌르기', damage: 100, cooldown: 0.85, windup: 0.17, range: 2.1, arc: 12 },
    },
    maxRange: 2.1,
    rpm: 143, fireInterval: 0.42,
    mag: null, reserve: null, reload: null,
    drawTime: 0.35, moveMul: 1.12,
    spread: null, recoil: null, zoom: null,
  }),

  // 앞으로 꺾인 묵직한 날. 호크빌과 같은 두 번 베기지만 조금 더 멀리 넓게 닿고, 그만큼 느리다.
  ml_gurkha: blade({
    id: 'ml_gurkha', slot: 3, kind: 'melee', category: 'melee', fire: 'melee', price: 800,
    name: '구르카 나이프', nameEn: 'Gurkha Knife', short: 'GURKHA', role: '근접',
    icon: '🔪', color: '#c8a45a', sound: 'katana_swing', fxKind: null,
    heavySound: 'katana_heavy', hitSound: 'knife_hit',
    tagline: '앞으로 꺾인 날이 무게를 싣는다.',
    desc: '앞이 무거운 굽은 칼이다. 베기가 조금 더 멀리 넓게 닿고, 내려찍기는 한 번에 쓰러뜨린다. 호크빌보다 느리다.',
    bars: { power: 80, rate: 34, accuracy: 42, mobility: 94 },

    damage: null,
    falloff: null,
    melee: {
      slash: { label: '베기', damage: 55, cooldown: 0.52, windup: 0.09, range: 2.1, arc: 42 },
      stab: { label: '내려찍기', damage: 110, cooldown: 1.05, windup: 0.27, range: 2.1, arc: 16 },
    },
    maxRange: 2.1,
    rpm: 115, fireInterval: 0.52,
    mag: null, reserve: null, reload: null,
    drawTime: 0.45, moveMul: 1.07,
    spread: null, recoil: null, zoom: null,
  }),

  // 베기가 2발 킬(65×2)로 나이프와 같은데 사거리가 1.5배다. 선딜과 쿨다운이 길어 먼저 맞으면 진다.
  ml_katana: blade({
    id: 'ml_katana', slot: 3, kind: 'melee', category: 'melee', fire: 'melee', price: 1200,
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

  // 야스오의 검: 좀비 증강 카드 전용. 좌우 클릭 모두 같은 칼 판정 찌르기이고, 두 번 맞힌 뒤 다음 공격으로 회오리를 날린다.
  ml_yasuo: blade({
    id: 'ml_yasuo', slot: 3, kind: 'melee', category: 'melee', fire: 'melee', price: 0, zombieOnly: true, cardOnly: true,
    name: '야스오의 검', nameEn: 'Yasuo Sword', short: 'YASUO', role: '바람 검술',
    icon: '🗡️', color: '#70e8e3', sound: 'katana_swing', fxKind: null,
    heavySound: 'katana_swing', hitSound: 'katana_hit',
    tagline: '두 번 맞히면 다음 찌르기가 회오리가 된다.',
    desc: '좌우 클릭 모두 0.7초마다 같은 칼 판정으로 찌른다. 10초 안에 두 번 맞히면 다음 공격은 빗나가도 전방에 회오리를 날려 좀비를 띄우고 기절시킨다. 회오리가 보스를 맞히면 보스 뒤로 순간이동해 2초 동안 무적으로 공중 연타(총 10배 피해)를 하고 떨어진다.',
    bars: { power: 82, rate: 58, accuracy: 70, mobility: 94 },

    damage: null,
    falloff: null,
    melee: {
      slash: { label: '찌르기', damage: 100, cooldown: 0.7, windup: 0.16, range: 2.9, arc: 12 },
      stab: { label: '찌르기', damage: 100, cooldown: 0.7, windup: 0.16, range: 2.9, arc: 12 },
    },
    maxRange: 2.9,
    rpm: 86, fireInterval: 0.7,
    mag: null, reserve: null, reload: null,
    drawTime: 0.5, moveMul: 1.07,
    spread: null, recoil: null, zoom: null,
  }),

  // 007 가방(요청 2026-11-20): 금속 모서리를 댄 서류 가방으로 친다. 휘두르기는 약하게, 우클릭 내려치기는 중간 피해로 더 세게 밀어낸다.
  // 밀어내기(knock)는 좀비 물량 막기 방장(director.js knockZombie)만 쓰고, 다른 모드에서는 피해만 준다.
  ml_case: blade({
    id: 'ml_case', slot: 3, kind: 'melee', category: 'melee', fire: 'melee', price: 700,
    name: '007 가방', nameEn: '007 Briefcase', short: '007', role: '근접',
    icon: '💼', color: '#3b3b44', sound: 'knife_slash', fxKind: null,
    heavySound: 'katana_heavy', hitSound: 'knife_hit',
    tagline: '서류 가방으로 후려쳐 밀어낸다.',
    desc: '금속 모서리를 댄 서류 가방이다. 휘두르면 맞은 좀비가 약하게 밀려나고, 우클릭으로 크게 내려치면 중간 피해와 함께 더 멀리 밀려난다. 밀어내기는 좀비 물량 막기에서만 된다.',
    bars: { power: 55, rate: 40, accuracy: 45, mobility: 96 },

    damage: null,
    falloff: null,
    melee: {
      slash: { label: '휘두르기', damage: 35, cooldown: 0.5, windup: 0.08, range: 2.0, arc: 40 },
      stab: { label: '내려치기', damage: 70, cooldown: 1.0, windup: 0.24, range: 2.1, arc: 22 },
    },
    knock: { slash: { speed: 5, up: 20 }, stab: { speed: 10, up: 30 } },
    maxRange: 2.1,
    rpm: 120, fireInterval: 0.5,
    mag: null, reserve: null, reload: null,
    drawTime: 0.45, moveMul: 1.08,
    spread: null, recoil: null, zoom: null,
  }),

  // 전기톱: 좌클릭을 누르고 있으면 0.04초마다 10씩 계속 갈아 낸다(초당 250). 우클릭은 크게 휘두르고,
  // 좀비 물량 막기의 검기 증강은 우클릭 휘두르기(stab)에서만 나간다(world.js launchWave, director.js claimHit 'waveStab').
  ml_saw: blade({
    id: 'ml_saw', slot: 3, kind: 'melee', category: 'melee', fire: 'melee', price: 1300,
    name: '전기톱', nameEn: 'Chainsaw', short: 'SAW', role: '근접',
    icon: '🪚', color: '#e8a317', sound: 'flame', fxKind: null,
    heavySound: 'katana_heavy', hitSound: 'knife_hit',
    tagline: '누르고 있는 동안 계속 갈아 낸다.',
    desc: '좌클릭을 누르고 있으면 톱날에 닿은 적을 0.04초마다 계속 벤다. 우클릭은 톱을 크게 휘둘러 한 번에 큰 피해를 준다. 무거워서 조금 느리게 걷는다.',
    bars: { power: 85, rate: 100, accuracy: 40, mobility: 88 },

    damage: null,
    falloff: null,
    melee: {
      slash: { label: '갈기', damage: 10, cooldown: 0.04, windup: 0.008, range: 1.9, arc: 30 },
      stab: { label: '휘두르기', damage: 90, cooldown: 0.44, windup: 0.104, range: 2.4, arc: 40 },
    },
    maxRange: 2.4,
    rpm: 1500, fireInterval: 0.04,
    mag: null, reserve: null, reload: null,
    drawTime: 0.6, moveMul: 0.98,
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

  // ───────────── 좀비 물량 막기 전용 보조무기(드문 증강으로만 얻는다. 상점·메뉴·봇·다른 모드에는 나오지 않는다) ─────────────
  // 쏘면 총알 대신 발사체가 날아가 터진다(weapons/grenade.js PROJECTILES). 피해는 폭발(explosion)로만 준다.
  gl_m32: gun({
    id: 'gl_m32', slot: 2, kind: 'launcher', category: 'launcher', fire: 'semi', price: 0, zombieOnly: true,
    name: 'GL-6 유탄 발사기', nameEn: 'GL-6 Grenade Launcher', short: 'GL-6', role: '폭발 보조',
    icon: '🧨', color: '#6b8f3a', sound: 'shotgun', fxKind: 'shotgun',
    tagline: '낮게 휘어 날아가 맞은 자리에서 터진다.',
    desc: '좀비 물량 막기의 드문 증강으로만 얻는 보조무기다. 유탄이 처음 부딪히는 곳에서 터져 반경 4.2 m를 쓸어 낸다.',
    bars: { power: 80, rate: 30, accuracy: 60, mobility: 80 },
    damage: { head: 0, body: 0, legs: 0, hand: 0, foot: 0 },
    falloff: null,
    maxRange: 80,
    rpm: 100, fireInterval: 0.6,
    mag: 6, reserve: 6, reload: 3.0, reloadEmpty: 3.4,
    drawTime: 0.6, moveMul: 0.95,
    spread: { hip: 0.4, move: 1, air: 2, bloomPerShot: 0, bloomMax: 0, bloomDecay: 6, max: 3 },
    recoil: { pattern: PT_MAGNUM_PATTERN, loopFrom: 1, adsMul: 1, maxPitch: 8, maxYaw: 3, recoverDelay: 0.12, recoverRate: 6, patternRecover: 8 },
    zoom: null,
    projectile: { kind: 'gl', speed: 24, pitchUp: 0.06, fuse: 2.2 },
    explosion: { radius: 4.2, inner: 0.6, max: 100 },
  }),
  rl_b9: gun({
    id: 'rl_b9', slot: 2, kind: 'rocket', category: 'launcher', fire: 'semi', price: 0, zombieOnly: true,
    name: 'BZ-9 바주카포', nameEn: 'BZ-9 Bazooka', short: 'BZ-9', role: '폭발 보조',
    icon: '🚀', color: '#8a6d3b', sound: 'sniper', fxKind: 'sniper',
    tagline: '곧게 날아가 크게 터진다. 한 발씩.',
    desc: '좀비 물량 막기의 드문 증강으로만 얻는 보조무기다. 로켓이 곧게 날아가 처음 닿는 곳에서 반경 5.2 m로 크게 터진다. 한 발마다 다시 넣는다.',
    bars: { power: 100, rate: 10, accuracy: 80, mobility: 70 },
    damage: { head: 0, body: 0, legs: 0, hand: 0, foot: 0 },
    falloff: null,
    maxRange: 120,
    rpm: 50, fireInterval: 1.2,
    mag: 1, reserve: 4, reload: 2.6, reloadEmpty: 2.6,
    drawTime: 0.8, moveMul: 0.9,
    spread: { hip: 0.2, move: 0.6, air: 1.5, bloomPerShot: 0, bloomMax: 0, bloomDecay: 6, max: 2 },
    recoil: { pattern: PT_MAGNUM_PATTERN, loopFrom: 1, adsMul: 1, maxPitch: 10, maxYaw: 3, recoverDelay: 0.15, recoverRate: 5, patternRecover: 6 },
    zoom: null,
    projectile: { kind: 'rocket', speed: 36, pitchUp: 0, fuse: 3.0 },
    explosion: { radius: 5.2, inner: 1.0, max: 100 },
  }),
  // 중력건: 피해는 없다. 발사체가 곧게 날아가 처음 닿는 곳에서 중력 구멍이 생겨, 반경 안의 좀비를 그 한 점으로 끌어 뭉친다(explosion은 '끌어당길 범위'다)
  gv_gun: gun({
    id: 'gv_gun', slot: 2, kind: 'launcher', category: 'launcher', fire: 'semi', price: 0, zombieOnly: true,
    name: 'GV-1 중력건', nameEn: 'GV-1 Gravity Gun', short: 'GV-1', role: '군중 제어',
    icon: '🌀', color: '#8a5cff', sound: 'magnum', fxKind: 'pistol',
    tagline: '쏜 자리로 좀비를 끌어모은다.',
    desc: '좀비 물량 막기의 드문 증강으로만 얻는 보조무기다. 중력 탄이 처음 닿는 곳에서 반경 7 m의 좀비를 한 점으로 끌어당겨 뭉친다. 피해는 주지 않으니 뭉친 곳에 수류탄을 던져라.',
    bars: { power: 5, rate: 40, accuracy: 70, mobility: 85 },
    damage: { head: 0, body: 0, legs: 0, hand: 0, foot: 0 },
    falloff: null,
    maxRange: 90,
    rpm: 60, fireInterval: 1.0,
    mag: 4, reserve: 12, reload: 2.4, reloadEmpty: 2.8,
    drawTime: 0.55, moveMul: 0.97,
    spread: { hip: 0.3, move: 0.8, air: 1.5, bloomPerShot: 0, bloomMax: 0, bloomDecay: 6, max: 2 },
    recoil: { pattern: PT_STD_PATTERN, loopFrom: 1, adsMul: 1, maxPitch: 4, maxYaw: 1.5, recoverDelay: 0.1, recoverRate: 8, patternRecover: 10 },
    zoom: null,
    projectile: { kind: 'gravity', speed: 30, pitchUp: 0.02, fuse: 2.0 },
    explosion: { radius: 7, inner: 7, max: 100 },
  }),

  // 공기총(요청 2026-11-20): 좀비 물량 막기 전용(zombieOnly)이지만 상점에서 판다(shop). 8 m 안 앞쪽으로 압축 공기를 넓게 뿜어
  // 맞은 좀비를 위로 45° 강하게 날린다(director.js knockZombie, 보스는 30%). 펠릿 5발 × 몸 2 = 10이라 피해는 약하다.
  pn_air: gun({
    id: 'pn_air', slot: 2, kind: 'shotgun', category: 'launcher', fire: 'semi', price: 900, zombieOnly: true, shop: true,
    name: 'AG-8 공기총', nameEn: 'AG-8 Air Cannon', short: 'AG-8', role: '밀어내기',
    icon: '💨', color: '#7fd3ff', sound: 'shotgun', fxKind: 'pistol',
    tagline: '가까운 좀비를 하늘로 날려 보낸다.',
    desc: '좀비 물량 막기에서만 쓰는 보조무기다. 8 m 안 앞쪽으로 압축 공기를 넓게 뿜어 맞은 좀비를 위로 45° 강하게 날려 보낸다. 피해는 약하고 보스는 조금만 밀린다.',
    bars: { power: 15, rate: 35, accuracy: 30, mobility: 90 },
    damage: { head: 3, body: 2, legs: 2, hand: 1, foot: 1 },   // 펠릿 1발 기준
    pellets: 5,
    falloff: null,
    maxRange: 8,
    rpm: 86, fireInterval: 0.7,
    mag: 4, reserve: 8, reload: 2.2, reloadEmpty: 2.5,
    drawTime: 0.5, moveMul: 0.98,
    spread: { hip: 9, move: 0, air: 0, bloomPerShot: 0, bloomMax: 0, bloomDecay: 0, max: 9 },
    recoil: { pattern: PN_AIR_PATTERN, loopFrom: 0, adsMul: 1, maxPitch: 5, maxYaw: 1.5, recoverDelay: 0.1, recoverRate: 8, patternRecover: 8 },
    zoom: null,
    knock: { shot: { speed: 14, up: 45 } },
  }),
  // 말뚝건(요청 2026-11-20): 좀비 물량 막기 전용이지만 상점에서 판다. 무거운 말뚝이 포물선을 그리며 날아가(grenade.js PROJECTILES.stake)
  // 처음 닿는 곳에서 반경 1.2 m 안의 좀비에게 100 × BLAST_MUL.stake(4.5) = 450을 준다. 폭발이 아니라 박히는 것이라 불빛·소리가 작다.
  sk_stake: gun({
    id: 'sk_stake', slot: 2, kind: 'launcher', category: 'launcher', fire: 'semi', price: 1000, zombieOnly: true, shop: true,
    name: 'ST-1 말뚝건', nameEn: 'ST-1 Stake Gun', short: 'ST-1', role: '강타',
    icon: '📌', color: '#9b6b3d', sound: 'magnum', fxKind: 'pistol',
    tagline: '포물선을 그리며 날아가 박힌다.',
    desc: '좀비 물량 막기에서만 쓰는 보조무기다. 무거운 말뚝이 포물선을 그리며 날아가 처음 닿는 곳의 좀비에게 강력한 피해(최대 450)를 준다. 멀리 맞히려면 위를 겨눠야 한다.',
    bars: { power: 95, rate: 20, accuracy: 55, mobility: 85 },
    damage: { head: 0, body: 0, legs: 0, hand: 0, foot: 0 },
    falloff: null,
    maxRange: 80,
    rpm: 67, fireInterval: 0.9,
    mag: 3, reserve: 6, reload: 2.4, reloadEmpty: 2.8,
    drawTime: 0.55, moveMul: 0.96,
    spread: { hip: 0.3, move: 0.8, air: 1.5, bloomPerShot: 0, bloomMax: 0, bloomDecay: 6, max: 2 },
    recoil: { pattern: PT_MAGNUM_PATTERN, loopFrom: 1, adsMul: 1, maxPitch: 8, maxYaw: 3, recoverDelay: 0.12, recoverRate: 6, patternRecover: 8 },
    zoom: null,
    projectile: { kind: 'stake', speed: 28, pitchUp: 0.04, fuse: 3.0 },
    explosion: { radius: 1.2, inner: 1.2, max: 100 },
  }),
  // 투척 도끼: 좀비 물량 막기 전용 투척 장비. 비행 중 좀비를 관통하고, 벽·바닥에 닿으면 주울 수 있게 남는다.
  th_axe: {
    id: 'th_axe', slot: 4, kind: 'grenade', category: 'launcher', fire: 'throw', price: 800, zombieOnly: true, shop: true,
    name: 'TX-3 투척 도끼', nameEn: 'TX-3 Throwing Axe', short: 'TX-3', role: '관통 투척',
    icon: '🪓', color: '#b0b8c0', sound: 'knife_slash', fxKind: null,
    tagline: '휘어 날아가며 줄지어 선 좀비를 꿰뚫는다.',
    desc: '좀비 물량 막기의 투척 장비다. 비행 중 닿는 좀비마다 피해 700을 주고 관통한다. 지형에 박히면 10초 동안 그 자리에서 다시 주울 수 있다.',
    stats: [
      { label: '투척', value: '누르고 떼기 · 24 m/s' }, { label: '낮게 던지기', value: '우클릭' },
      { label: '관통', value: '비행 중 좀비마다 피해 700' }, { label: '회수', value: '지형 충돌 뒤 10초' }, { label: '수량', value: '5개' },
    ],
    bars: { power: 70, rate: 40, accuracy: 50, mobility: 95 },
    damage: null, falloff: null,
    explosion: { radius: 0.6, inner: 0.6, max: 100 }, // 비행 중 관통 피해의 기본값. 착지 폭발은 없다.
    count: 5,
    fuse: 3.0,
    throw: { speed: 24, pitchUp: 0.06 / DEG },
    lob: { speed: 12, pitchUp: 0.06 / DEG },
    physics: { gravity: -12 },
    primeTime: 0.25,
    throwRecover: 0.35,
    drawTime: 0.45, moveMul: 1.0,
    spread: null, recoil: null, zoom: null,
  },

  // ───────────── 좀비 물량 막기 전용 주무기(상점·메뉴·봇·다른 모드에는 나오지 않는다. 좀비 모드의 무기 고르기 창과 무기 교체권으로만 든다) ─────────────
  // 100발 박스 탄창을 끊지 않고 쏟아붓는 기관총. 750rpm에 몸 22라 한 탄창의 피해가 2,200(RX-4의 720)이고 한 탄창 8초를 쉬지 않고 쏜다.
  // 그 대가가 크다: 들고 있으면 이동이 70%(좀비 러너 5 m/s보다 느리다), 조준하면 더 느리고, 꺼내기 1.15초·재장전 4.8초, 탄이 넓게 퍼지고 반동이 크다.
  // 머리 90은 워커(100)·브루트(420)를 한 발에 못 쓰러뜨려 라이플 같은 머리 한 발 킬이 없다(약한 특수 좀비만 초반에 한 발). 그 자리를 한 탄창의 양과 연사가 메운다.
  mg_m249: gun({
    id: 'mg_m249', slot: 1, kind: 'lmg', category: 'lmg', fire: 'auto', price: 0, zombieOnly: true,
    name: 'MG-100 기관총', nameEn: 'MG-100 Machine Gun', short: 'MG-100', role: '제압',
    icon: '⛓️', color: '#a39a4f', sound: 'lmg', fxKind: 'rifle',
    tagline: '100발을 쏟아붓는 대신 발이 무겁다.',
    desc: '좀비 물량 막기에서만 쓰는 박스 탄창 기관총이다. 한 탄창 100발을 끊지 않고 쏟아붓지만, 들고 있으면 걸음이 느리고 꺼내기·재장전이 길며 반동이 크다. 다른 모드에서는 쓸 수 없다.',
    recoilNote: '솟은 뒤 좌우로 크게 흔들린다',
    bars: { power: 60, rate: 82, accuracy: 34, mobility: 12 },

    damage: { head: 90, body: 22, legs: 16, hand: 11, foot: 11 },
    falloff: { start: 25, end: 70, min: 0.7 },
    maxRange: 220,

    rpm: 750, fireInterval: 60 / 750,

    mag: 100, reserve: 200, reload: 4.8, reloadEmpty: 5.4,
    drawTime: 1.15, moveMul: 0.7,

    spread: { hip: 2.2, ads: 0.8, move: 4.5, adsMove: 2.2, air: 7, adsAir: 5.5,
      bloomPerShot: 0.1, bloomMax: 2.4, bloomDecay: 3, adsBloomMul: 0.6, max: 11 },
    recoil: { pattern: MG_LMG_PATTERN, loopFrom: 20, adsMul: 0.8, maxPitch: 11, maxYaw: 5,
      recoverDelay: 0.14, recoverRate: 5, patternRecover: 14 },
    // 조준하면 이동이 더 느려진다(0.7 × 0.6 = 42%). 줌 배율은 낮게 둔 철제 조준기라 오버레이가 없다
    zoom: { mag: 1.4, inTime: 0.26, outTime: 0.16, accurateAt: null, overlay: null,
      hideViewmodelAt: null, moveMul: 0.6, unzoomOnFire: false },
  }),
  // 좀비 증강 카드로만 얻는 주무기. 펠릿별 판정을 그대로 써서 근거리 총 피해는 몸 8×5=40.
  fl_horde: gun({
    id: 'fl_horde', slot: 1, kind: 'shotgun', category: 'shotgun', fire: 'auto', price: 0, zombieOnly: true, cardOnly: true,
    name: 'FL-12 화염 방사기', nameEn: 'FL-12 Flamethrower', short: 'FL-12', role: '근거리 화염',
    icon: '🔥', color: '#ff7427', sound: 'flame', fxKind: 'flame',
    tagline: '가까운 좀비 떼를 불길로 밀어낸다.',
    desc: '화염을 초당 8번 연속 분사한다. 한 번에 불꽃 5갈래가 12 m까지 퍼지며 가까울수록 강하다. 연료 100을 다 쓰면 3초 동안 다시 채운다.',
    bars: { power: 68, rate: 80, accuracy: 20, mobility: 75 },
    damage: { head: 16, body: 8, legs: 6, hand: 4, foot: 4 },
    pellets: 5, falloff: { start: 5, end: 12, min: 0.45 }, maxRange: 12,
    rpm: 480, fireInterval: 0.125,
    mag: 100, reserve: 200, reload: 3, reloadEmpty: 3,
    drawTime: 0.65, moveMul: 0.9,
    spread: { hip: 4.5, move: 1.1, air: 2.5, bloomPerShot: 0.05, bloomMax: 0.7, bloomDecay: 5, max: 7 },
    recoil: { pattern: [[0, 0.16]], loopFrom: 0, adsMul: 1, maxPitch: 2, maxYaw: 1,
      recoverDelay: 0.04, recoverRate: 12, patternRecover: 24 },
    zoom: null,
  }),
  rg_horde: gun({
    id: 'rg_horde', slot: 1, kind: 'dmr', category: 'dmr', fire: 'semi', price: 0, zombieOnly: true, cardOnly: true,
    name: 'RG-5 레일건', nameEn: 'RG-5 Railgun', short: 'RG-5', role: '정밀 관통',
    icon: '⚡', color: '#50baff', sound: 'rail', fxKind: 'rail',
    tagline: '푸른 광선 한 줄로 거인을 쓰러뜨린다.',
    desc: '1.5초마다 푸른 광선을 쏜다. 몸 400, 머리 800의 강력한 한 발이지만 탄창은 5발뿐이다.',
    bars: { power: 100, rate: 12, accuracy: 94, mobility: 55 },
    damage: { head: 800, body: 400, legs: 300, hand: 200, foot: 200 },
    falloff: null, maxRange: 400,
    rpm: 40, fireInterval: 1.5,
    mag: 5, reserve: 15, reload: 3.4, reloadEmpty: 3.8,
    drawTime: 0.9, moveMul: 0.82,
    spread: { hip: 1.3, move: 1.5, air: 3, bloomPerShot: 0, bloomMax: 0, bloomDecay: 6, max: 5 },
    recoil: { pattern: [[0.2, 3.6]], loopFrom: 0, adsMul: 0.75, maxPitch: 7, maxYaw: 2,
      recoverDelay: 0.1, recoverRate: 7, patternRecover: 12 },
    zoom: { mag: 2, inTime: 0.2, outTime: 0.12, accurateAt: null, overlay: null,
      hideViewmodelAt: null, moveMul: 0.8, unzoomOnFire: false },
  }),
  // 제우스의 번개(증강 카드 'zeus' 전용 주무기, 요청 2026-11-20): 번개를 던지면 조금 휘어 날아가(grenade.js PROJECTILES.bolt) 닿은 자리 옆 좀비를 맞히고
  // 8 m 안의 다른 좀비로 다섯 번 튄다(world.js zeusChain). 튈 때마다 피해가 줄지 않아 여섯 마리 모두 100 × BLAST_MUL.bolt(1.5) = 150.
  // 예비 탄약은 무제한이다(infiniteAmmo: 좀비 모드의 프리미엄 탄창 제한 finiteMags도 받지 않는다, logic.js reserveOf).
  zs_bolt: gun({
    id: 'zs_bolt', slot: 1, kind: 'launcher', category: 'launcher', fire: 'semi', price: 0, zombieOnly: true, cardOnly: true, infiniteAmmo: true,
    name: '제우스의 번개', nameEn: 'Bolt of Zeus', short: 'ZEUS', role: '연쇄 번개',
    icon: '🌩️', color: '#fff27a', sound: 'rail', fxKind: 'rail',
    tagline: '던진 번개가 좀비 사이를 다섯 번 튄다.',
    desc: '번개를 던진다. 닿은 자리 옆 좀비를 맞히고 근처 좀비로 다섯 번 튀는데, 튈 때마다 피해가 줄지 않는다. 예비 탄약이 무제한이다.',
    bars: { power: 80, rate: 35, accuracy: 70, mobility: 90 },
    damage: { head: 0, body: 0, legs: 0, hand: 0, foot: 0 },
    falloff: null, maxRange: 120,
    rpm: 86, fireInterval: 0.7,
    mag: 10, reserve: Infinity, reload: 1.2, reloadEmpty: 1.2,
    drawTime: 0.5, moveMul: 1.0,
    spread: { hip: 0.2, move: 0.6, air: 1.2, bloomPerShot: 0, bloomMax: 0, bloomDecay: 6, max: 2 },
    recoil: { pattern: [[0, 1.2]], loopFrom: 0, adsMul: 1, maxPitch: 4, maxYaw: 1, recoverDelay: 0.08, recoverRate: 9, patternRecover: 10 },
    zoom: null,
    projectile: { kind: 'bolt', speed: 40, pitchUp: 0.03, fuse: 3.0 },
    explosion: { radius: 8, inner: 8, max: 100 },   // radius는 튀는 거리 표기용. 피해는 맞은 좀비마다 max(폭발 반경 피해는 없다)
  }),
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

export const DEFAULT_LOADOUT = Object.freeze({ primary: 'ar_std', secondary: 'pt_std', melee: 'ml_knife', grenade: 'gr_frag' });

/** 프리미엄 총인가(PREMIUM_PRICE). 모르는 무기와 칼은 false */
export function isPremium(id) {
  const d = getDef(id);
  return !!(d && d.premium);
}

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
