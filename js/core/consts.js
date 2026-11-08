/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 플레이어·히트박스·이모트·네트워크처럼 여러 모듈이 함께 쓰는 상수와 작은 도우미 함수를 모은다. three.js에 의존하지 않아 node에서도 불러올 수 있다.
 */
/**
 * SKALA 작전 — 공용 상수 (ARCHITECTURE.md 2절). three.js 의존 없음(node에서도 import 가능).
 *
 * 좌표계: 1 단위 = 1 m, y 위쪽, 지면 y = 0, 맵 원점 = 맵 중앙.
 * 방향: yaw = Y축 회전(라디안, three.js rotation.y와 동일). yaw 0 → -Z를 바라봄,
 *       yaw 증가 = 위에서 볼 때 반시계(왼쪽으로 회전). 전방 벡터 = (-sin yaw, 0, -cos yaw).
 *       pitch 양수 = 위를 봄.
 */

export const VERSION = '2.0.0';

/** 플레이어 신체·이동 */
export const PLAYER = Object.freeze({
  HEIGHT: 1.8,       // 키 (m)
  EYE: 1.6,          // 눈높이 (m, 발바닥 기준)
  RADIUS: 0.35,      // 충돌 반지름 (m)
  WALK: 5.2,         // 걷기 (m/s)
  SLOW_WALK: 2.4,    // Shift 천천히 걷기 (m/s)
  JUMP_V: 6.3,       // 점프 초속 (m/s) — 최고 높이 ≈ 1.24 m (+공중 턱 오르기 0.225 → 약 1.46 m 위에 올라탐)
  GRAVITY: -16,      // 중력 (m/s²)
  STEP: 0.45,        // 계단 오름 높이 (m)
  HP: 100,           // 체력
  MAX_FALL: 40,      // 최대 낙하 속도 (m/s)
  // 앉기 (Ctrl·C 누르고 있는 동안)
  CROUCH_HEIGHT: 1.25, // 앉은 키 (m)
  CROUCH_EYE: 1.1,     // 앉은 눈높이 (m)
  CROUCH_SPEED: 2.6,   // 앉아서 이동 (m/s)
  CROUCH_TIME: 0.12    // 앉기/일어서기 전환 시간 (s, 카메라·아바타 자세)
});

/**
 * 플레이어 이동 물리(Quake 계열 가속) — engine/movement.js, docs/DESIGN.md 4절.
 * 봇은 기존 단순 가속(physics.moveCharacter 기본 경로)을 그대로 쓴다.
 */
export const MOVE = Object.freeze({
  GROUND_ACCEL: 16,      // 지면 가속 계수(× 목표 속도, /s). 마찰과 합쳐 어떤 목표 속도든 0.1초(6틱)에 닿아 예전 60 m/s²와 같다
  FRICTION: 9,           // 지면 마찰 계수(/s). GROUND_ACCEL보다 작아야 목표 속도를 유지한다. 버니합을 멈추면 14 m/s가 약 0.15초 만에 걷기로 준다
  STOP_SPEED: 5,         // 입력 없이 이보다 느리면 이 값 기준으로 마찰. 5 × 9 = 45 m/s²로 예전 멈춤 감속과 같다(5.2 m/s에서 약 0.12초)
  AIR_ACCEL: 20,         // 공중 가속 계수(× AIR_WISH_CAP, /s). 틱당 0.5 m/s: 한 번 뛰는 동안 90° 스윙까지는 13.5 m/s로 따라오고, 135°는 9.5 m/s에서 막힌다
  AIR_WISH_CAP: 1.5,     // 공중 '목표 방향 성분' 상한(m/s). 45° 스윙이면 한 번 뛸 때 약 +1 m/s. 1.44보다 낮으면 82.5°로 도는 스트레이프가 11 m/s에 못 닿는다
  AIR_LOW_SPEED: 3,      // 이보다 느릴 때의 공중 조작 상한(m/s). 제자리 점프 뒤 W로 약 2.3 m를 간다(AIR_WISH_CAP만 쓰면 1.2 m)
  MAX_SPEED: 14,         // 수평 속도 상한(m/s). 걷기의 약 2.7배. 45° 스윙으로 약 7초 걸리므로 좁은 맵에서는 끝까지 못 올린다
  HOP_GRACE: 0.05,       // 착지 후 이 시간(초, 3틱) 안에는 마찰이 없다. 손으로 늦게 누른 점프를 봐주는 값이고, 이른 입력은 player의 0.12초 버퍼가 맡는다
  SWAP_BONUS: 0.3,       // 공중에서 A↔D를 바꿀 때마다 더하는 속도(m/s). 초당 3번 흔들면 약 4초에 SWAP_BONUS_MAX라서 마우스 없이도 가속이 느껴진다
  SWAP_BONUS_MAX: 9,     // 이 속도까지만 SWAP_BONUS가 붙는다(m/s). 걷기의 약 1.7배까지는 A/D만으로, 그 위는 마우스 스트레이프의 몫이다
  SWAP_GAP: 0.25         // 보너스 사이의 최소 간격(초). 큰 스윙(초당 3~4번)은 그대로 받고, A/D 연타가 마우스 스트레이프보다 유리해지는 것을 막는다
});

/**
 * 히트박스 (발바닥 기준 로컬 좌표, 로컬 -Z = 정면).
 * head: 구(중심 높이 y, 반지름 r) / body·legs: yaw로 회전하는 박스(반폭 hw = 로컬 x, 반깊이 hd = 로컬 z).
 */
export const HITBOX = Object.freeze({
  HEAD: Object.freeze({ y: 1.62, r: 0.14 }),
  BODY: Object.freeze({ y0: 1.0, y1: 1.5, hw: 0.26, hd: 0.17 }),
  LEGS: Object.freeze({ y0: 0.13, y1: 1.0, hw: 0.22, hd: 0.15 }),
  FOOT: Object.freeze({ y0: 0.0, y1: 0.13, hw: 0.22, hd: 0.19, cz: -0.035 }),
  // 손끝: 총을 든 두 손(구). 저격총은 손·발에 맞으면 반샷(50)이다. 위치는 engine/avatars.js 모델과 맞춘다
  HANDS: Object.freeze([Object.freeze({ x: 0.244, y: 1.278, z: -0.518, r: 0.075 }), Object.freeze({ x: -0.023, y: 1.258, z: -0.428, r: 0.075 })])
});

/** 앉은 히트박스 (hw·hd는 서 있을 때와 같음). 레이 대상의 crouch(true 또는 0..1)로 HITBOX와 섞는다 */
export const HITBOX_CROUCH = Object.freeze({
  HEAD: Object.freeze({ y: 1.12, r: 0.14 }),
  BODY: Object.freeze({ y0: 0.6, y1: 1.05, hw: 0.26, hd: 0.17 }),
  LEGS: Object.freeze({ y0: 0.13, y1: 0.6, hw: 0.22, hd: 0.15 }),
  FOOT: Object.freeze({ y0: 0.0, y1: 0.13, hw: 0.22, hd: 0.19, cz: -0.035 }),
  HANDS: Object.freeze([Object.freeze({ x: 0.244, y: 0.798, z: -0.513, r: 0.075 }), Object.freeze({ x: -0.023, y: 0.779, z: -0.423, r: 0.075 })])
});

/** 앉은 상태에서의 탄퍼짐 배율 (weapons/logic.js · 임시 총) */
export const CROUCH_SPREAD_MUL = 0.8;

/** 히트 부위 이름 */
export const PARTS = Object.freeze(['head', 'body', 'legs', 'hand', 'foot']);
/** 저격총 반샷 부위(손끝·발) */
export const HALF_SHOT_PARTS = Object.freeze(['hand', 'foot']);

/** 팀. 내부 id(owner·charterer)는 맵 데이터·전송 형식과 맞물려 있어 그대로 두고, 화면에는 name만 쓴다 */
export const TEAMS = Object.freeze({
  owner: Object.freeze({ id: 'owner', name: '블루', nameEn: 'Blue', color: '#22407a', light: '#5b82d6' }),
  charterer: Object.freeze({ id: 'charterer', name: '오렌지', nameEn: 'Orange', color: '#e8731c', light: '#ffab5e' })
});
export const TEAM_IDS = Object.freeze(['owner', 'charterer']);

/** 고정 틱 */
export const TICK_RATE = 60;
export const TICK_DT = 1 / TICK_RATE;

/** 네트워크 동기화 */
export const NET = Object.freeze({
  SEND_HZ: 10,             // 각자 자기 상태 브로드캐스트 빈도
  INTERP_DELAY_MS: 100,    // 원격 아바타 보간 지연
  LOBBY_CHANNEL: 'skalafps:lobby',
  ROOM_CHANNEL_PREFIX: 'skalafps:room:'
});

/** 경기 규칙 */
export const MATCH = Object.freeze({
  ROUNDS_TO_WIN: 3,        // 5판 3선승
  MAX_ROUNDS: 5,
  ROUND_TIME: 120,         // 초
  MAX_PLAYERS: 8,          // 4:4
  MIN_PLAYERS: 2,
  RESPAWN_IN_ROUND: false
});

/** 카메라 */
export const VIEW = Object.freeze({
  FOV: 75,                 // 기본 수직 FOV (도)
  NEAR: 0.05,
  FAR: 1500,
  VIEWMODEL_FOV: 60
});

/** 재질 팔레트 (맵 mat는 이 이름만) */
export const MATS = Object.freeze([
  'concrete', 'asphalt', 'steel', 'rust', 'deck', 'tank', 'pipe', 'wood',
  'glass', 'container_red', 'grass', 'water', 'white', 'yellow',
  // 새 맵용 (engine/materials.js)
  'stone', 'brick', 'plaster', 'tile', 'sand', 'moss', 'wood_dark', 'bamboo', 'paper', 'metal_dark', 'neon_cyan', 'neon_pink'
]);

/** 맵 데이터 한도 */
export const LIMITS = Object.freeze({ SOLIDS: 400, DECOR: 280, REAL_LIGHTS: 4, PADS: 16, SECRETS: 8, PROPS: 40 });

/** 무기 슬롯 */
export const SLOTS = Object.freeze({ PRIMARY: 1, SECONDARY: 2, MELEE: 3, THROWABLE: 4 });

/** 화면 상태 */
export const SCREENS = Object.freeze(['menu', 'sandbox', 'lobby', 'room', 'match', 'results']);

/** 마우스 감도 기준(라디안/픽셀). 실제 = BASE × settings.sensitivity × lookScale */
export const MOUSE = Object.freeze({ BASE_SENS: 0.0022 });

/** 각도 단위 보정: |v| > 2π+0.01 이면 도(deg)로 보고 라디안으로 변환 */
export function toRad(v) {
  const n = Number(v) || 0;
  return Math.abs(n) > Math.PI * 2 + 0.01 ? n * Math.PI / 180 : n;
}

/**
 * 이모트(감정 표현) 목록 — MODES.md 4.1. code = 전송 번호(1~15, 0 = 없음), 휠 칸 = 배열 순서(12시부터 시계 방향).
 * loop: 반복형이면 true(duration 0), 한 번만 하면 false(duration 초). bpm: 동작·소리 박자(fx가 맞춰 쓸 수 있음).
 * 동작은 engine/emoteanim.js의 절차적 키프레임(직접 설계)으로 그린다.
 */
export const EMOTES = Object.freeze([
  Object.freeze({ code: 1, id: 'takeL', name: 'L을 가져가', icon: '🫵', loop: true, duration: 0, bpm: 150 }),
  Object.freeze({ code: 2, id: 'veggie', name: '새싹 댄스', icon: '🥬', loop: true, duration: 0, bpm: 73.7 }),
  Object.freeze({ code: 3, id: 'sideToSide', name: '사이드 스텝', icon: '↔️', loop: true, duration: 0, bpm: 129.7 }),
  Object.freeze({ code: 4, id: 'crissCross', name: 'X 점프', icon: '❌', loop: true, duration: 0, bpm: 104.9 }),
  Object.freeze({ code: 5, id: 'tango', name: '탱고', icon: '💃', loop: true, duration: 0, bpm: 96 }),
  Object.freeze({ code: 6, id: 'salute', name: '경례', icon: '🫡', loop: false, duration: 2.5, bpm: 0 }),
  Object.freeze({ code: 7, id: 'wave', name: '손 흔들기', icon: '👋', loop: false, duration: 2.5, bpm: 0 }),
  Object.freeze({ code: 8, id: 'cheer', name: '환호 박수', icon: '👏', loop: true, duration: 0, bpm: 128 })
]);
export const EMOTE_IDS = Object.freeze(EMOTES.map((e) => e.id));

/** 이모트 휠: 가운데에서 DEADZONE(px) 벗어나야 칸 선택, 가상 커서는 RADIUS(px) 테두리에서 멈춤 */
export const EMOTE_WHEEL = Object.freeze({ DEADZONE: 40, RADIUS: 160, SLOTS: 8 });

/** 이모트 전환(시작·끝, 3인칭 카메라·아바타 자세) 시간(초) */
export const EMOTE_BLEND = 0.15;

/** 번호 → 이모트 (없으면 null) */
export function emoteByCode(code) {
  const n = Number(code) | 0;
  return n > 0 ? EMOTES.find((e) => e.code === n) || null : null;
}

/** id 또는 번호 → 이모트 (없으면 null) */
export function emoteById(id) {
  if (typeof id === 'number') return emoteByCode(id);
  return EMOTES.find((e) => e.id === id) || null;
}

/** 휠 커서(px, 화면 중앙 기준, y 아래로 +) → 칸 번호 0..SLOTS-1 (12시부터 시계 방향) 또는 null(DEADZONE 안) */
export function emoteSlotAt(x, y, slots = EMOTE_WHEEL.SLOTS, deadZone = EMOTE_WHEEL.DEADZONE) {
  const dx = Number(x) || 0, dy = Number(y) || 0;
  if (Math.hypot(dx, dy) < deadZone) return null;
  let a = Math.atan2(dx, -dy);
  if (a < 0) a += Math.PI * 2;
  const step = (Math.PI * 2) / slots;
  return Math.floor((a + step / 2) / step) % slots;
}
