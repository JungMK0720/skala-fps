# SKALA 작전 — 무기 모듈 (`js/weapons/`)

담당: **weapons**. 계약은 `docs/DESIGN.md` 3절, 수치의 이유와 고칠 곳은 `docs/BALANCE.md`에 있다.

| 파일 | 내용 | 의존 |
|---|---|---|
| `defs.js` | 무기 17종과 수류탄의 수치·표시 정보, `computeDamage()` | 없음(순수) |
| `logic.js` | 무기 상태 머신 `createArsenal()` | defs |
| `grenade.js` | 수류탄 투척 물리·폭발 피해 `createGrenadeSystem()` | defs (충돌 함수는 주입) |
| `viewmodel.js` | 1인칭 무기 모형 `createViewmodel()` | three, defs |

`defs`·`logic`·`grenade`는 three.js·엔진·DOM을 쓰지 않는다. 그래서 node에서 바로 테스트할 수 있다.

---

## 1. 무기 표

수치의 정본은 `defs.js`다. 아래 표는 참고용이다.

| 슬롯 | id | 이름 | 머리/몸/다리/손·발 | 감쇠 | 방식 | 탄창/예비 | 재장전 | 꺼내기 | 이동 | 줌 | 사거리 | 가격 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `ar_std` | 🔫 RX-4 돌격소총 | 110/30/22/15 | 30~80 m→75%, 머리 제외 | 연사 600rpm | 30/60 | 2.3/2.7s | 0.65s | 0.95 | 2배 | 250 m | 0 |
| 1 | `ar_rapid` | 🌪️ RX-9 스톰 | 100/22/16/11 | 25~70 m→70%, 머리 제외 | 연사 860rpm | 35/70 | 2.4/2.9s | 0.6s | 0.97 | 1.7배 | 220 m | 800 |
| 1 | `ar_line` | 📏 LN-3 헤드라인 | 120/17/12/8 | 40~100 m→80%, 머리 제외 | 연사 480rpm | 25/∞ | 2.2/2.6s | 0.7s | 0.95 | 2.4배 | 300 m | 1200 |
| 1 | `ar_burst` | 🔱 BR-3 트리플 | 110/34/24/16 | 30~80 m→75%, 머리 제외 | 3점사 간격 0.065s, 재사격 0.36s | 30/60 | 2.3/2.7s | 0.65s | 0.95 | 2.2배 | 250 m | 1000 |
| 1 | `dm_mark` | 🏹 DM-4 마크스맨 | 130/52/38/26 | 없음 | 반자동 0.3s | 15/∞ | 2.6/3s | 0.75s | 0.9 | 3배 | 350 m | 1500 |
| 1 | `sm_vx3` | 🐍 VX-3 바이퍼 | 60/18/14/9 | 12~40 m→55% | 연사 950rpm | 32/64 | 1.9/2.2s | 0.45s | 1.05 | 1.4배 | 120 m | 600 |
| 1 | `sg_bx12` | 💥 BX-12 브리처 | 20/14/10/7 (펠릿당, 8발) | 8~22 m→35% | 반자동 0.85s | 6/12 | 2.6/3s | 0.7s | 0.98 | — | 40 m | 700 |
| 1 | `sr_bolt` | 🎯 SK-7 볼트 | 200/120/100/50 | 없음 | 볼트 1.2s | 5/10 | 3/3.4s | 0.8s | 0.85 | 4배 | 400 m | 0 |
| 1 | `sr_twin` | 🔭 T-2 트윈옵틱 | 200/120/100/50 | 없음 | 볼트 1.35s | 5/∞ | 3.2/3.6s | 0.9s | 0.82 | 4→9배 | 500 m | 1500 |
| 1 | `sr_swift` | 🕊️ S-3 스위프트 | 150/85/60/40 | 없음 | 볼트 0.85s | 7/14 | 2.4/2.8s | 0.6s | 0.95 | 3배 | 300 m | 1000 |
| 1 | `sr_heavy` | 🗿 H-50 타이탄 | 300/200/150/70 | 없음 | 볼트 1.9s | 4/∞ | 3.8/4.4s | 1.1s | 0.75 | 5배 | 500 m | 2500 |
| 2 | `pt_std` | 🔰 P-9 권총 | 70/28/20/14 | 15~45 m→60% | 반자동 0.16s | 12/24 | 1.6/1.9s | 0.45s | 1 | — | 150 m | 0 |
| 2 | `pt_magnum` | 🧨 M-44 매그넘 | 110/55/38/25 | 25~60 m→70% | 반자동 0.46s | 6/12 | 2.2/2.5s | 0.55s | 0.97 | — | 170 m | 500 |

| 슬롯 | id | 이름 | 베기 (피해/쿨다운/사거리/판정각/선딜) | 찌르기·강타 | 꺼내기 | 이동 |
|---|---|---|---|---|---|---|
| 3 | `ml_knife` | 🔪 호크빌 나이프 (기본) | 베기 50 / 0.45s / 1.8 m / 35° / 0.06s | 찌르기 100 / 1s / 1.8 m / 12° / 0.22s | 0.4s | 1.1 |
| 3 | `ml_tanto` | 🔪 탄토 (500 P) | 베기 40 / 0.42s / 1.8 m / 30° / 0.06s | 찌르기 100 / 0.85s / 2.1 m / 12° / 0.17s | 0.35s | 1.12 |
| 3 | `ml_gurkha` | 🔪 구르카 나이프 (800 P) | 베기 55 / 0.52s / 2.1 m / 42° / 0.09s | 내려찍기 110 / 1.05s / 2.1 m / 16° / 0.27s | 0.45s | 1.07 |
| 3 | `ml_katana` | 🗡️ 카게 카타나 (1,200 P) | 베기 65 / 0.62s / 2.7 m / 48° / 0.12s | 강타 120 / 1.25s / 2.9 m / 14° / 0.34s | 0.55s | 1.05 |

**프리미엄 총:** 상점 가격이 `PREMIUM_PRICE`(1,200 P) 이상인 총이다. 예비 탄약이 무제한(`reserve: Infinity`)이고 탄창과 재장전은 그대로다. 나머지 총은 탄창 + 예비 2탄창이 전부이고, 다음 스폰에 다시 찬다.

슬롯 4 `gr_frag`(💣 수류탄)는 폭심 0.8 m 안에서 100이고 6 m까지 선형으로 줄어 0이 된다. 가리면 0이다. 신관 2.5s, 1개, 꺼내기 0.5s, 이동 1.0.

탄퍼짐은 원뿔 반각(°)이다. 쏠 때마다 이 원뿔 안에서 가운데로 몰리게 뽑는다.

| 무기 | 미조준 | 조준 | 이동(최대, 조준 시) | 공중(조준 시) | 연사 블룸 |
|---|---|---|---|---|---|
| RX-4 | 1.2 | 0.2 | +2.5 (+1) | +5 (+4) | 발당 +0.15, 최대 1.5 (조준 시 ×0.6) |
| RX-9 | 1.7 | 0.45 | +3 (+1.4) | +5.5 (+4.5) | 발당 +0.2, 최대 2.6 (조준 시 ×0.75) |
| LN-3 | 0.8 | 0.06 | +2 (+0.7) | +5 (+4) | 발당 +0.06, 최대 0.6 (조준 시 ×0.5) |
| BR-3 | 1 | 0.15 | +2.5 (+1) | +5 (+4) | 발당 +0.18, 최대 1.2 (조준 시 ×0.6) |
| DM-4 | 3.2 | 0.05 | +3 (+1.2) | +6 (+5) | 발당 +0.3, 최대 1.4 (조준 시 ×0.25) |
| VX-3 | 1.5 | 0.6 | +0.9 (+0.5) | +3.5 (+3) | 발당 +0.12, 최대 2.2 (조준 시 ×0.7) |
| BX-12 | 3.2 | — | +0.8 | +2.5 | — |
| SK-7 | 8 | 0 | +2 (+1.5) | +6 (+6) | — |
| T-2 | 9 | 0 | +2.2 (+1.7) | +6.5 (+6.5) | — |
| S-3 | 5 | 0 | +1.6 (+1) | +5 (+5) | — |
| H-50 | 11 | 0 | +3 (+2.2) | +8 (+8) | — |
| P-9 | 0.8 | — | +1.6 | +4.5 | 발당 +0.45, 최대 2 |
| M-44 | 1.1 | — | +2 | +5 | 발당 +0.9, 최대 2.6 |

- 이동 페널티는 `수평 속력 / 5.2`에 비례한다. Shift 천천히 걷기(`walking`)는 그 절반이고, 앉으면(`crouch`) 전체가 ×0.8이다.
- 반동은 카메라를 튀게 하는 각도(°)이고, 표기는 위 +, 오른쪽 +다. 패턴은 총마다 다르다.
  - RX-4는 30발 패턴이다. 1~7발은 거의 수직으로 0.55~0.7°씩 오르고, 8~12발은 왼쪽, 13~18발은 오른쪽으로 흐른 뒤, 이후 좌우로 작게 흔들린다.
  - RX-9는 발당 반동이 RX-4보다 크고 좌우로 넓게 끌린다. 조준해도 ×0.92라 거의 줄지 않는다.
  - LN-3의 발당 반동 총량은 RX-4의 약 40%다.
  - BR-3은 세 발씩 계단처럼 솟는다. 몰아 쏘면 패턴이 다 돌아오지 않아 뒤쪽 묶음으로 밀린다.

| 무기 | 패턴 길이 | 첫 발 위로 | 조준 시 | 누적 한계(위/좌우) | 회복 시작·속도 | 패턴 복귀 |
|---|---|---|---|---|---|---|
| RX-4 | 30발 | 0.55° | ×0.8 | 10° / 4° | 0.12s · 7/s | 20발/s |
| RX-9 | 35발 | 0.7° | ×0.92 | 13° / 6° | 0.1s · 6/s | 24발/s |
| LN-3 | 25발 | 0.24° | ×0.8 | 4° / 1.6° | 0.14s · 9/s | 18발/s |
| BR-3 | 12발 | 0.62° | ×0.8 | 8° / 3° | 0.1s · 8/s | 7발/s |
| DM-4 | 5발 | 1.7° | ×0.75 | 7° / 2° | 0.1s · 6/s | 8발/s |
| VX-3 | 16발 | 0.3° | ×0.85 | 7° / 3.5° | 0.09s · 10/s | 26발/s |
| BX-12 | 3발 | 4.2° | ×1 | 9° / 2.5° | 0.12s · 6/s | 5발/s |
| SK-7 | 1발 | 3.2° | ×1 | 6° / 2° | 0.06s · 5/s | 10발/s |
| T-2 | 1발 | 3.4° | ×1 | 6° / 2° | 0.06s · 5/s | 10발/s |
| S-3 | 2발 | 2.2° | ×1 | 5° / 2° | 0.05s · 7/s | 8발/s |
| H-50 | 2발 | 5.5° | ×1 | 9° / 3° | 0.1s · 3.5/s | 6발/s |
| P-9 | 4발 | 1.3° | ×1 | 7° / 3° | 0.08s · 9/s | 12발/s |
| M-44 | 3발 | 3° | ×1 | 8° / 3° | 0.12s · 6/s | 8발/s |

줌

| 무기 | 줌 인/아웃 | 정조준 경계 | 오버레이 | 이동 | 사격 후 해제 |
|---|---|---|---|---|---|
| RX-4 | 0.18/0.12s | 진행도에 비례 | 없음 | ×0.8 | 아니오 |
| RX-9 | 0.16/0.11s | 진행도에 비례 | 없음 | ×0.82 | 아니오 |
| LN-3 | 0.2/0.13s | 진행도에 비례 | 없음 | ×0.75 | 아니오 |
| BR-3 | 0.18/0.12s | 진행도에 비례 | 없음 | ×0.8 | 아니오 |
| DM-4 | 0.2/0.13s | 진행도에 비례 | 없음 | ×0.72 | 아니오 |
| VX-3 | 0.12/0.09s | 진행도에 비례 | 없음 | ×0.9 | 아니오 |
| SK-7 | 0.16/0.1s | 진행도 0.5 | scope | ×0.8 | 예 |
| T-2 | 0.2/0.12s (단계 이동 0.16s) | 진행도 0.5 | scope | ×0.75 | 예 |
| S-3 | 0.12/0.08s | 진행도 0.5 | scope | ×0.88 | 예 |
| H-50 | 0.25/0.14s | 진행도 0.6 | scope | ×0.7 | 예 |

- 스코프 오버레이는 진행도 0.55부터 나타나고 0.9를 넘으면 모형을 숨긴다. 오버레이가 없는 총은 모형이 보인 채로 조준경을 화면 가운데로 가져온다.
- 칼 판정은 휘두른 뒤 선딜 지점에서 한 번 한다.
- 수류탄
  - 좌클릭: 누르면 핀을 뽑고(최소 0.25s), 떼면 던진다. 초속 16m/s로 시선보다 6° 위를 향한다.
  - 우클릭: 낮게 굴리기. 8m/s, 4° 위.
  - 물리: 중력 −12, 반발 0.35, 부딪힐 때 접선 속도 70% 유지, 구르기 감쇠 2.5/s, 반지름 0.07m.

### 이름

모든 무기는 오리지널 모델명이나 일반 명칭을 쓴다. 상용 게임의 이름·모델·수치는 쓰지 않았다. 카드의 한 줄 소개는 `tagline`, 긴 설명은 `desc`에 있다. 모형 도장은 `viewmodel.js`에 있다.

---

## 2. 공통 규약

- 단위: 거리 m, 시간 s. **API의 각도는 모두 라디안**이다(`defs.js`의 표만 도(°)).
- 각도 방향은 three.js 카메라 Euler `'YXZ'`, CORE_API 1절과 같다.
  - **yaw +** = 왼쪽(`rotation.y`), **pitch +** = 위(`rotation.x`).
- 벡터 출력은 `vec3`다. `[x, y, z]` 배열이면서 `.x/.y/.z` 속성도 있다. core(배열 규약)에도, `{x,y,z}`를 읽는 코드에도 그대로 넘길 수 있고, JSON으로 바꾸면 `[x,y,z]`가 된다.
- 벡터 입력은 배열과 `{x,y,z}`를 모두 받는다.
- `pos`는 발바닥 위치다(CORE_API와 같음).

---

## 3. `defs.js`

```js
import {
  WEAPONS, WEAPON_IDS, PRIMARY_IDS, SECONDARY_IDS, MELEE_IDS, GRENADE_IDS, DEFAULT_LOADOUT,
  getDef, computeDamage, isHalfShot, normalizePart, minShotInterval,
} from './weapons/defs.js';
```

### 무기 정의(`WEAPONS[id]`)

읽기 전용(deep freeze)이다.

| 묶음 | 필드 |
|---|---|
| 표시 | `id, slot, kind, category, fire, name, nameEn, short, role, icon, color, tagline, desc, price` |
| 소리·이펙트 | `sound`(`fx/audio` 이름), `fxKind`(`'rifle'\|'sniper'\|'pistol'`, 칼·수류탄은 `null`). 칼은 `heavySound`(찌르기·강타), `hitSound`도 있다 |
| 로드아웃 카드 | `stats [{label, value}]`(숫자에서 자동 생성), `bars {power, rate, accuracy, mobility}` (0~100), `recoilNote` |
| 피해 | `damage {head, body, legs, hand, foot}`, `headIgnoresFalloff`, `falloff {start, end, min}\|null`, `pellets`, `maxRange` |
| 사격 | `rpm`, `fireInterval`, `burst {count, gap}`(점사 무기만) |
| 탄약 | `mag`, `reserve`, `reload`, `reloadEmpty` |
| 기본 | `drawTime`, `moveMul` |
| 퍼짐·반동·줌 | `spread {...}`, `recoil {pattern, ...}`, `zoom {mag 또는 levels, inTime, outTime, levelTime?, accurateAt, overlay, hideViewmodelAt, moveMul, unzoomOnFire}\|null` |
| 저격 전용 | `bolt`, `emptyShotRecover` |
| 칼 전용 | `melee {slash, stab}` → `{label, damage, cooldown, windup, range, arc(°)}`. 모든 칼이 같은 구조이고 카타나의 `stab`은 강타, 구르카의 `stab`은 내려찍기다 |
| 수류탄 전용 | `count, fuse, throw, lob, primeTime, throwRecover, explosion {radius, inner, max}, physics {...}` |

- `category`는 상점 탭이다: `'rifle'|'sniper'|'smg'|'pistol'|'melee'|'grenade'`. 지정사수(`dm_mark`)는 `rifle`, 샷건(`sg_bx12`)은 `smg`.
- 점사 무기의 `fireInterval`은 점사가 끝난 뒤 쉬는 시간이고, `rpm`은 쉬는 시간까지 넣은 실효 연사다.
- `PRIMARY_IDS`는 슬롯 1 무기 전부다(표 순서). `SECONDARY_IDS`는 슬롯 2, `MELEE_IDS`는 슬롯 3, `GRENADE_IDS`는 슬롯 4.
- `DEFAULT_LOADOUT = { primary: 'ar_std', secondary: 'pt_std', melee: 'ml_knife' }`
- `PREMIUM_PRICE`, `isPremium(id)`: 프리미엄 기준과 판정. 표의 `premium`은 `gun()`이 가격으로 정한다

### 함수

- `computeDamage(id, part, dist, kind, count = 1)` → **정수 데미지**. 데미지 계산의 유일한 구현이다(`damage`는 별칭).
  - 총은 부위표 × 거리 감쇠 × `count`를 반올림하고 최소 1이다. `part`가 머리이고 `headIgnoresFalloff`면 감쇠를 걸지 않는다.
  - `count`는 같은 대상에 맞은 펠릿 수다. 1 미만이거나 숫자가 아니면 1로 본다.
  - 칼은 부위와 거리를 무시하고 `kind`만 본다. `'stab'`이면 찌르기·강타, 그 외는 베기다.
  - 수류탄은 `dist`를 폭심 거리로 보고 감쇠만 적용한다(차폐는 `grenade.js`가 판정).
  - 모르는 무기는 0이다.
- `normalizePart(part)` → `PARTS` 중 하나. `neck`·`helmet`은 `head`, `arm`·`chest`·`torso`는 `body`, `leg`는 `legs`, `finger(s)`·`hands`는 `hand`, `feet`·`boot(s)`는 `foot`. 모르는 값은 `body`다.
- `isHalfShot(id, part)` → 저격총이 손끝이나 발에 맞은 타격(반샷)인가.
- `minShotInterval(id)` → 같은 사수가 이 무기로 낼 수 있는 가장 짧은 사격 간격(초). 점사는 `burst.gap`, 칼은 빠른 쪽 쿨다운, 나머지는 `fireInterval`. **방장 연사 검증은 `fireInterval`이 아니라 이 값을 쓴다.**
- `getDef(id)`, `falloffMul(falloff, dist)`, `explosionFalloff(dist, ex?)`, `zoomFov(baseFovDeg, mag)`, `vec3(x,y,z)`, `toVec3(v)`
- 상수: `DEG, PLAYER_HP, WALK_SPEED(5.2), BASE_FOV(75), PARTS`

---

## 4. `logic.js` — `createArsenal(opts)`

```js
const arsenal = createArsenal({
  primary, secondary, melee,   // 없거나 잘못되면 DEFAULT_LOADOUT
  allowedSlots: [1, 2, 3, 4],  // 칼전은 [3], 스나전은 [1, 3] (modes.js rulesetOf(id).slots)
  zoomMode: 'hold' | 'toggle',
  stageCycle: true,            // false면 다단 줌 무기를 1단만 쓰는 단일 배율처럼 다룬다(봇용)
  rng, walkSpeed, draw,
});
```

- 처음에는 허용된 첫 슬롯의 무기를 든 준비 상태다. `draw: true`면 꺼내는 동작부터 시작한다.

### `update(dt, input, motion)` → 이벤트 배열(매번 새 배열)

`input` 필드는 모두 생략할 수 있다.

| 필드 | 뜻 |
|---|---|
| `fireDown` | 좌클릭을 누르고 있음 |
| `firePressed` | 이번 프레임에 눌림. 생략하면 `fireDown`의 상승 에지로 계산. 프레임 사이에 짧게 클릭한 경우도 이것으로 받는다 |
| `zoomDown` | 우클릭을 누르고 있음. hold 줌, 칼 찌르기, 수류탄 굴리기에 쓴다 |
| `zoomToggle` | 이번 프레임에 우클릭이 눌림(에지). 토글 줌과 다단 줌에 쓴다. 계속 true로 와도 한 번만 센다 |
| `reloadPressed` | R |
| `slot` | 1~4, 이번 프레임에 누른 숫자키(없으면 null). 금지된 슬롯은 무시한다 |
| `wheel` | 휠. 부호만 본다. + = 다음 슬롯(1→2→3→4), 빈 슬롯과 금지된 슬롯은 건너뜀 |

`motion`은 `{ speed: 수평 속력(m/s), onGround, walking: Shift, crouch }`다.

줌 방식(누르는 동안 / 토글)은 **설정이 바뀔 때 `setZoomMode('hold'|'toggle')`로 알려 준다**. 입력 계층은 두 신호(`zoomDown`, `zoomToggle`)를 모두 보내도 된다. 다단 줌은 같은 클릭이 두 신호로 와도 한 단계만 넘어간다.

### 이벤트

공통 필드는 `{ type, weaponId, t }`다(`t`는 arsenal 내부 시각). `weaponId`는 실제로 든 무기다. 칼 이벤트도 `ml_knife`로 고정되지 않는다.

| type | 언제 | 추가 필드 |
|---|---|---|
| `fire` | 발사 | `pellets[{yaw,pitch,dir}]`(산탄 수만큼), `yaw/pitch/dir`(첫 탄), `spread`(rad), `spreadDeg`, `aim`(0~1), `zoom`, `level`, `scoped`, `quickscope`, `noscope`, `recoil{yaw,pitch}`(발사 순간 카메라 반동), `kick{yaw,pitch}`(이번 발), `shotIndex`, `mag`, `reserve`, `maxRange`, `slot` |
| `dryFire` | 탄이 하나도 없을 때 클릭(누를 때 1번) | — |
| `boltCycle` | 저격 사격 직후(마지막 탄 제외) | `duration` |
| `reloadStart` | 재장전 시작(R 또는 자동) | `duration`, `empty`, `mag`, `reserve` |
| `reloadEnd` | 재장전 완료 | `mag`, `reserve` |
| `reloadCancel` | 재장전 중 교체 | — |
| `switch` | 교체 시작. `weaponId` = 새 무기 | `from`, `to`, `slot`, `drawTime`, (`reset: true` = `resetRound`) |
| `zoomChange` | 줌 목표나 단계가 바뀜 | `zoomed`, `level` |
| `swing` | 칼 휘두르기 시작(애니·소리) | `kind`('slash'\|'stab'), `duration`, `windup`, `index`, `damage`, `range` |
| `melee` | **칼 판정 시점**(엔진이 이때 히트 검사) | `kind`, `damage`, `range`, `arc`(rad, 판정 원뿔 반각 힌트), `index` |
| `swingCancel` | 판정 전에 교체 | `kind` |
| `prime` | 수류탄 핀 뽑기 시작 | `kind`('overhand'\|'underhand'), `primeTime` |
| `primeCancel` | 준비 중 교체(수류탄 유지) | `kind` |
| `throw` | 투척 | `kind`, `speed`, `pitchUp`(rad), `fuse`, `count`(남은 개수) |

탄 방향은 카메라 기준이다.

- `pellets[i].yaw/pitch`는 반동이 적용된 화면 방향을 기준으로 한 탄퍼짐 오프셋이다.
- `dir`은 같은 내용을 카메라 로컬 단위 벡터로 준 것이다(−z가 정면).
- 월드 방향은 `shotDirection(myYaw, myPitch, ev, i)`로 구한다. 반동은 `ev.recoil`을 써서 반영된다. 또는 `dir`을 '그 발을 쏠 때의' 카메라 쿼터니언으로 돌려도 된다.

### 메서드

| 메서드 | 반환 |
|---|---|
| `getZoom(baseFov=75)` | `{ progress, target, zoomed, mag, curMag, fov, targetFov, overlay('scope'\|null), scopeAmount(0~1 오버레이 불투명도), hideViewmodel, accurate, level, levels }`. `level` 0 = 줌 아님, `levels` = 단계 수(줌 없는 무기 0, 단일 배율 1, `sr_twin` 2). `mag`는 지금 단계의 배율이고, 줌 아웃 중에는 마지막 단계 배율이다 |
| `getSpread()` | `{ rad, deg, accurate }` (크로스헤어용, 현재 사격 시 쓰일 값과 같음) |
| `getRecoilKick()` | `{ yaw, pitch }`. **누적 오프셋**이다. 카메라 = 내 각도 + kick. 내 각도에 더해 넣지 말 것 |
| `getAmmo(id?)` | `{ weaponId, kind:'mag'\|'count'\|'none', mag, magSize, reserve, infinite, reloading }`. 슬롯 4가 금지된 규칙에서 수류탄은 `mag: 0`이다 |
| `isPrimaryEmpty()` | 주무기 탄창과 예비가 모두 비었는가. 주무기 슬롯이 막힌 규칙이면 `false` |
| `takePrimary(id, { mag, reserve })` | 바닥에서 주운 총을 슬롯 1에 넣고 바로 꺼낸다. 탄약은 정의의 최대까지만 받는다. 다음 목숨은 `resetRound`가 자기 장비로 되돌린다 |
| `getWeapon()` | `{ id, slot, name, nameEn, short, def, state, progress(0~1), elapsed, duration, previous }`. `previous`는 없으면 `null`이다 |
| `getSlots()` | `[{ slot, id, name, short, icon, empty, active, allowed }] × 4`. 금지된 슬롯은 `id`·`name`·`short`·`icon`이 `null`이고 `allowed: false`다 |
| `getMoveMul()` | 이동속도 배율(무기 × 줌) |
| `getViewState(baseFov)` | `viewmodel.update()`에 넘길 표시 상태. `weaponId`, `level`, `levels`, `curMag`, `zoom`, `phase`, ... |
| `getHud(baseFov)` | UI `hud.set()`에 그대로 넘길 값: `{ ammo, reserve, mag, reloading, reload, slots, slot, spread, fov, crosshair }`. `slots`는 금지되거나 빈 칸이 `null`이다 |
| `serialize()` | 네트워크 표시용 `{ w: 무기 id, s: 상태, z: 0\|1 }`. 상태는 `STATES` 중 하나: idle, draw, reload, bolt, swing, prime, throw |

그 밖의 조작:

- `setLoadout({ primary?, secondary?, melee? })` → `getLoadout()` 값. 없는 키와 잘못된 id는 유지한다. 새로 들어온 무기는 탄약을 채워 받고, 바뀐 무기를 들고 있었다면 동작을 끊고 새 무기를 꺼낸다(`switch` 이벤트).
- `getLoadout()` → `{ primary, secondary, melee }`
- `setAllowedSlots(list)` → 성공 여부. 들고 있는 무기가 금지되면 허용된 첫 슬롯을 꺼낸다. 쓸 슬롯이 없는 목록은 거부한다(`false`).
- `getAllowedSlots()`
- `carries(id)`: 이 무기가 로드아웃에 있고 슬롯이 허용되는가.
- `select(slotOrId)`: 금지되거나 로드아웃에 없는 무기는 `false`. 이벤트는 다음 `update()`에서 나온다.
- `setPrimary(id)`, `getPrimary()`: `PRIMARY_IDS` 전부를 받는다.
- `setZoomMode(m)`, `getZoomMode()`
- `resetRound({ primary?, secondary?, melee?, draw? })`: 탄약과 수류탄을 채우고 허용된 첫 슬롯의 무기를 든다.
- `giveGrenade(n)`, `getTime()`, `dispose()`

### 규칙 요약

- **허용 슬롯**: 금지된 슬롯의 무기는 숫자키·휠·`select`·투척 후 복귀 어느 경로로도 들 수 없다. 칼전에서 1·2·4번 키는 아무 일도 하지 않는다.
- **단일 배율 줌**(`zoom.mag`): hold면 누르는 동안, toggle이면 누를 때마다.
- **다단 줌**(`zoom.levels`)
  - 설정과 관계없이 우클릭을 누를 때마다 0 → 1단 → 2단 → 0으로 돈다. 버튼을 떼도 풀리지 않는다.
  - 배율은 부드럽게 옮겨 간다. 단계를 옮기는 동안 조준 진행도는 1로 머물러 스코프가 깜빡이지 않고 정조준도 유지된다.
  - 사격(`unzoomOnFire`), 재장전, 교체는 0으로 되돌린다. 다음 누름은 1단부터다.
  - 볼트나 재장전 중에 누르면 끝난 뒤 그 단계가 걸린다.
- **저격**
  - 반샷: 손끝이나 발에 맞으면 표의 값만 들어간다(`isHalfShot`). 나머지 부위는 표대로다.
  - 퀵스코프: 줌 진행도가 `accurateAt` 이상이면 조준 정확도(0°)를 준다. 그 전에는 미조준 탄퍼짐이다. `fire` 이벤트의 `quickscope`, `noscope`로 알 수 있다.
  - 사격하면 자동으로 줌이 풀리고 볼트 동안 사격·줌을 할 수 없다.
  - hold 모드의 단일 배율은 **우클릭을 뗐다가 다시 눌러야** 다시 줌된다. 볼트 중에 다시 누르면 볼트가 끝나는 즉시 줌된다.
  - 마지막 탄은 볼트 없이 `emptyShotRecover` 뒤 자동 재장전한다.
- **연사**: 누르는 동안 정확히 `fireInterval` 간격으로 쏜다(프레임 속도와 무관). 새로 누르면 즉시 쏜다.
- **점사**(`fire: 'burst'`)
  - 클릭 한 번에 `burst.count`발이 `burst.gap` 간격으로 나가고, 그 뒤 `fireInterval`을 쉰다.
  - 버튼을 떼도 끝까지 나간다. 누르고 있어도 다시 쏘지 않는다.
  - 탄이 떨어지면 거기서 끝난다. 교체하면 남은 발은 버린다. R은 점사가 끝나고 쉰 뒤에 시작한다.
- **반자동**(권총·샷건·지정사수): 클릭 1번에 1발이다. 쿨다운이 끝나기 0.1s 전까지의 클릭은 기억했다가 쏜다. 점사도 같다.
- **산탄**: 탄 1개에 `fire` 이벤트 1번이고 `pellets[]`가 8개다. 엔진이 펠릿을 모두 트레이스한다.
- **칼**
  - 누르고 있으면 계속 휘두른다.
  - 찌르기·강타 뒤 쿨다운 동안은 베기도 할 수 없다.
  - 판정 전에 교체하면 그 공격은 취소된다. 들고 있는 칼을 `setLoadout`으로 바꿔도 같다.
- **수류탄**
  - 1개다. 던지면 0.35s 뒤 이전 무기로 돌아가고 4번 칸이 빈다(선택·휠에서 제외).
  - 던지는 동작 중에는 교체할 수 없다.
- **공통**
  - 교체하면 꺼내기 시간이 걸린다.
  - 재장전 중에 교체하면 취소되고, 탄약은 그대로 남는다.
  - 탄창이 비면 자동으로 재장전한다. 꺼내는 중에 누른 R은 꺼낸 뒤 실행한다.

### 방장 검증

`validateHit(weaponId, { dist, interval, kind?, tolerance=0.6 })` → `{ ok, reason? }`

- 모든 무기에 쓸 수 있다. 거리와 연사 간격만 본다.
- `reason`은 `'weapon' | 'range' | 'rate'` 중 하나다.
- 연사 기준은 `minShotInterval(weaponId) × tolerance`다. 점사는 `burst.gap` 기준이라 점사 안의 탄이 거부되지 않는다.
- `interval`은 '발' 사이의 시간이다. 산탄 한 발이 여러 명을 맞히면 같은 시각에 주장이 여러 건 오므로, 같은 발의 주장끼리는 간격을 재지 않는다.
- 칼은 사거리 + 1.2m까지 허용하고, 수류탄은 폭발 반경 + 0.5m까지 허용한다.

`arsenal.validateHit(id, info)`는 여기에 로드아웃 검사를 더한다. 들고 있지 않은 무기면 `reason: 'weapon'`이다.

---

## 5. `grenade.js` — `createGrenadeSystem(cfg)`

충돌 함수는 두 방식을 모두 받는다.

| 방식 | 넘기는 것 | 동작 |
|---|---|---|
| **core 월드(권장)** | `createGrenadeSystem({ world })` (`engine/physics.js`의 `createWorld` 결과) | core의 `world.sphereSweep(body, dt, opt)`(적분기)를 쓴다. 반발 0.35·마찰·중력은 이 모듈 값으로 넘긴다. `world.lineOfSight`도 함께 쓴다 |
| 선분 스윕(브리프 계약) | `{ sphereSweep(from, to, r) → {hit, point, normal, t?, center?}, lineOfSight(a, b) }` | 이 모듈이 포물선·바운스를 직접 적분한다. `point`는 '닿는 순간 구의 중심'을 권장한다. 표면 접점이어도 판별해서 보정한다 |

- 함수만 넘겨도 방식을 자동으로 알아챈다(`detectSweepStyle`). `sweepStyle`로 강제할 수도 있다.
- 선분 방식에는 암묵적 바닥 `floorY`(기본 0, 끄려면 `null`)가 있다.
- 시간 간격은 1/120s로 고정이다. 그래서 같은 투척이면 클라이언트마다 같은 궤적을 그린다.

```js
const nades = createGrenadeSystem({ world, onEvent? });
nades.throwFrom({ eye, forward, speed: ev.speed, pitchUp: ev.pitchUp, fuse: ev.fuse, owner: myId, inherit?: myVel });
for (const e of nades.update(dt)) {
  // e = { type:'bounce', id, owner, pos, normal, speed, mat } | { type:'explode', id, owner, pos }
}
nades.explosionDamage(center, targets) // → [{ id, damage(정수), dist, visible }] 입력 순서 그대로
```

- `targets`는 `[{ id, pos(발바닥), height?=1.8 }]` 또는 `[{ id, points:[...] }]`다.
- 피해 판정
  - 다리·몸·머리 세 점 중 **폭심에서 보이는 가장 가까운 점**까지의 거리로 감쇠한다.
  - 세 점이 모두 가려지면 0이다.
  - 폭심은 바닥에 가려지지 않도록 0.12m 올려서 본다.
- 그 밖의 함수
  - 시스템: `spawn(pos, vel, o)`, `list()`(렌더링용 사본), `count`, `sweepStyle`, `remove(id)`, `clear()`, `dispose()`
  - 단독: `throwVelocity`, `createGrenade`, `stepGrenade(g, dt, sweep, {style, floorY, physics})`, `explosionDamage(center, targets, lineOfSight, opts)`

---

## 6. `viewmodel.js` — `createViewmodel(camera, opts)`

```js
const vm = createViewmodel(R.viewCamera, { lookCamera: R.camera, team: 'owner' });  // core 렌더러
vm.preload();                                  // 첫 교체 때 끊김 방지(선택)
for (const ev of events) vm.play(ev);          // arsenal 이벤트를 그대로
vm.update(dt, arsenal.getViewState(R.baseFov));
```

### 붙는 위치

- `camera.parent`가 Scene이면 그 씬에 붙고 매 프레임 카메라를 따라간다. core의 `viewScene`이 이 경우이고, 자식 수가 늘어나므로 core가 깊이를 지운 뒤 그려 준다.
- 카메라가 씬 밖이면 카메라의 자식으로 붙는다.

### 레이어와 그리는 순서

- 메시는 전용 레이어 `VIEWMODEL_LAYER(30)`에만 있고, 그 레이어는 넘겨받은 카메라에서만 켠다. 그래서 월드 레이캐스트나 다른 카메라에는 잡히지 않는다.
- 월드 카메라에 직접 붙인 경우 대비
  - 그리기 직전에 깊이를 한 번 지운다(`clearDepth`). 그래서 벽에 파묻히지 않는다.
  - 줌으로 FOV가 줄어도 모형이 커지지 않게 보정한다.

### 애니메이션

- 반동 킥
- 재장전: 기울여 내리고, 탄창을 빼고 넣고, 왼손이 따라간다.
- 교체 올리기
- 저격 볼트 조작
- 권총 슬라이드: 쏠 때 뒤로 밀리고, 빈 탄창이면 젖혀진 채로 있다.
- 칼: 베기 2종 번갈아, 찌르기
- 수류탄: 왼손으로 핀 뽑기 → 던지기
- 걷기 흔들림, 숨쉬기, 착지 출렁임
- 시점 회전 sway: `lookCamera` 회전을 쓴다.

### 줌

- 저격은 줌 진행도가 **0.9를 넘으면 모형을 숨긴다**. 스코프 오버레이는 UI가 그린다(`getZoom().scopeAmount`).
- 소총 정조준은 조준경 점을 화면 가운데로 가져온다.

### 메서드

| 메서드 | 내용 |
|---|---|
| `setWeapon(id)` | 즉시 바꾸기. `switch` 이벤트나 `update`의 `weaponId`로도 자동으로 바뀐다 |
| `play(ev)` | arsenal 이벤트를 넘긴다 |
| `update(dt, state)` | `getViewState()` 결과를 넘긴다 |
| `getMuzzleWorld(out?, worldCamera?)` | 총구의 월드 좌표. 뷰모델 카메라 화면에서 같은 자리에 보이도록 월드 카메라 시선 위로 옮겨 준다. FX 섬광·예광탄 시작점에 쓴다. 칼·수류탄이면 `null` |
| `setTeam('owner'\|'charterer')` | 소매 색을 팀 색으로 |
| `setVisible(bool)` | 사망·관전 시 숨기기 |
| `setClearDepth(bool)` | 깊이 지우기 켜고 끄기 |
| `preload(ids?)` | 모형 미리 만들기 |
| `getWeaponId()` | 지금 보이는 무기 id |
| `dispose()` | 정리 |

옵션:

| 옵션 | 기본값 | 뜻 |
|---|---|---|
| `lookCamera` | — | sway와 총구 좌표 계산에 쓸 월드 카메라 |
| `scene` | — | 붙일 씬을 직접 지정 |
| `clearDepth` | true | 그리기 직전 깊이 지우기 |
| `muzzleFlash` | true | 내장 1인칭 섬광. FX가 1인칭 섬광을 그리면 false |
| `scale` | 1 | 전체 크기 배율 |
| `team` | — | 소매 색 |

---

## 7. 붙이는 예 (main/game 담당 참고)

```js
import { createArsenal, shotDirection } from './weapons/logic.js';
import { createGrenadeSystem } from './weapons/grenade.js';
import { createViewmodel } from './weapons/viewmodel.js';
import { WEAPONS, getDef } from './weapons/defs.js';
import { rulesetOf } from './game/modes.js';

ui.setWeapons(Object.values(WEAPONS));                       // 로드아웃 카드·HUD 슬롯 이름
const arsenal = createArsenal({
  ...account.loadout,                                        // { primary, secondary, melee }
  allowedSlots: rulesetOf(ruleset).slots,
  zoomMode: settings.get('zoomMode') === 'toggle' ? 'toggle' : 'hold',
});
const vm = createViewmodel(R.viewCamera, { lookCamera: R.camera, team: myTeam, muzzleFlash: false });
const nades = createGrenadeSystem({ world });

// 고정 틱
const evs = arsenal.update(dt, weaponInput, { speed: Math.hypot(vel[0], vel[2]), onGround, walking: shift, crouch });
for (const ev of evs) {
  vm.play(ev);
  const def = getDef(ev.weaponId);
  if (ev.type === 'fire') {
    const byVictim = new Map();                              // 산탄: 한 발의 펠릿을 피해자별로 모아 주장 1건
    for (let i = 0; i < ev.pellets.length; i++) {
      const dir = shotDirection(player.yaw, player.pitch, ev, i);
      const hit = world.traceShot(eye, dir, ev.maxRange, targets, { ignoreId: myId });
      if (hit.kind === 'player') byVictim.set(hit.id, { ...hit, count: (byVictim.get(hit.id)?.count || 0) + 1 });
    }
    // byVictim의 항목마다 방장에게 { w: ev.weaponId, id, part, dist, count } 보고
    audio.play(def.sound);
    fx.muzzleFlash(vm.getMuzzleWorld(tmp, R.camera), forward, def.fxKind);
  }
  if (ev.type === 'swing') audio.play(ev.kind === 'stab' ? def.heavySound : def.sound);
  if (ev.type === 'melee') { /* ev.range·ev.arc 안의 첫 대상에게 ev.damage. 주장의 무기는 ev.weaponId, 맞으면 def.hitSound */ }
  if (ev.type === 'throw') nades.throwFrom({ eye, forward, speed: ev.speed, pitchUp: ev.pitchUp, fuse: ev.fuse, owner: myId });
}
for (const ge of nades.update(dt)) if (ge.type === 'explode') {
  const res = nades.explosionDamage(ge.pos, players.map((p) => ({ id: p.id, pos: p.pos })));
}

// 렌더 프레임
const k = arsenal.getRecoilKick();
R.camera.rotation.set(player.pitch + k.pitch, player.yaw + k.yaw, 0);    // 'YXZ'
const z = arsenal.getZoom(R.baseFov);
R.setFov(z.fov);
ui.scope.set(z.scopeAmount, { mag: z.mag, level: z.level, levels: z.levels });
ui.hud.set(arsenal.getHud(R.baseFov));
vm.update(frameDt, arsenal.getViewState(R.baseFov));
player.speedMul = arsenal.getMoveMul();
net.state.weapon = arsenal.serialize();
```

봇처럼 `zoomDown`을 '줌을 원하는 동안 true'로 보내는 쪽은 `createArsenal({ ..., stageCycle: false })`를 쓴다. 그래야 `sr_twin`도 `sr_bolt`처럼 움직인다.

---

## 8. 알려진 한계

- **반동**
  - 반동은 '되돌아오는 시점 오프셋'이다. 연사 중에 마우스로 눌러 보정했다면, 멈춘 뒤 회복하면서 조준이 그만큼 아래로 내려간다(일반적인 view punch 방식).
  - 패턴은 고정이고 무작위 요소는 탄퍼짐에만 있다.
- **이동 페널티**는 엔진이 넘기는 수평 속력과 `crouch`만 본다.
- **칼**
  - 실제 판정(사거리·원뿔 안 대상 찾기)은 엔진이 한다. 이 모듈은 `range`와 `arc`만 준다.
  - 뒤찌르기 보너스는 없다.
- **수류탄**
  - 쿠킹이 없다. 신관은 손을 뗀 순간부터 2.5s다.
  - 던지는 사람의 속도는 `inherit`로 넘길 때만 더한다.
  - 수류탄은 플레이어 몸에 부딪히지 않는다(월드 충돌만).
  - 자기 피해·팀킬을 적용할지는 경기 규칙(match)이 정한다.
  - core 적분기 방식에서는 core의 정지·구르기 기준(1.2m/s, 0.2m/s)이 적용된다.
- **권총과 샷건**은 우클릭 기능이 없다.
- **뷰모델**
  - 내장 섬광과 FX 섬광을 함께 쓰면 두 번 그려진다. 한쪽을 끈다.
  - 조명은 core `viewScene`의 조명을 따른다.
  - 3인칭(남이 보는) 무기 모형은 이 모듈에 없다. core 아바타 담당 영역이다.
  - 카메라 near가 0.05보다 크면 정조준 때 일부가 잘릴 수 있다.
- **판정과 시간**
  - 사격 판정은 클라이언트 기준이다. 방장 검증(`validateHit`)은 거리와 간격만 본다.
  - `t`는 arsenal 내부 시각(초)이고, 네트워크 시각과 같지 않다.

## 9. 테스트

`node --test tests/weapons.test.mjs` (`npm test`에 포함)

- 무기 표: 기대값은 `docs/DESIGN.md` 3.2절을 옮겨 적었다. 피해·감쇠·탄·이동·가격, 카드 문구와 숫자의 일치, 분류·사운드 이름, '반샷'과 '퀵스코프' 문구
- 반동·탄퍼짐: 총마다 다른 패턴, LN-3 약 40%, RX-9가 더 제어하기 어려운지
- `computeDamage`: 부위·거리, 라이플 500 m 머리 1발, 저격 반샷과 1발 킬, 산탄 `count`, 칼·수류탄, 부위 별칭, `isHalfShot`
- 점사: 정확히 3발, 간격, 버튼을 떼도 이어짐, 재사격 대기, 탄 소진
- 다단 줌: 순환, 사격 후 재시작, FOV 값, 부드러운 전환, hold·toggle 공통
- 단일 줌 회귀: hold·toggle, 퀵스코프 경계
- 허용 슬롯: 칼전 1·2·4번 키 무시, HUD·슬롯 목록, 무작위 입력에서 불변식 유지
- 로드아웃: `setLoadout`, 칼 교체, `resetRound`, 수류탄
- 사격: 샷건 펠릿 8개, 총마다 탄창을 비우고 자동 재장전까지
- `game/modes.js`: 세 규칙의 `isWeaponAllowed`, `pickableWeapons`와 `owned` 대체
- `validateHit`: 모든 무기, 실제 사격 간격이 검증을 통과하는지

수류탄 물리와 뷰모델은 이 파일에서 다루지 않는다.
