# SKALA FPS 설계 계약 (v2)

이 문서는 모듈 사이의 약속이다. 코드가 이 문서와 달라지면 코드를 고치거나 이 문서를 함께 고친다.
기존 엔진 문서는 `docs/ARCHITECTURE.md`, `docs/CORE_API.md`, `docs/MODES.md`, `js/*/README.md`, `js/game/*_API.md`에 있다.

## 1. 공통 규칙

- 빌드 없음. 브라우저 ES 모듈 + importmap(CDN). GitHub Pages(`/skala-fps/` 하위 경로)에서 돌아야 하므로 **모든 경로는 상대 경로**다. `/js/...` 같은 절대 경로 금지.
- 런타임 npm 의존성 없음. 외부 라이브러리는 importmap의 three, cannon-es만. Supabase는 `fetch`(REST RPC)와 `js/net`의 자체 Realtime 클라이언트로 접속한다.
- 외부 이미지·음원 파일 금지. 도형, 캔버스 텍스처, WebAudio 합성만 쓴다.
- **상용 게임의 맵 구조·이름·캐릭터·모델·UI·사운드를 복제하지 않는다.** 장르 관습(좁은 교전 구역, 칼전, 공중 스트레이프 가속 같은 메커니즘)은 써도 되지만 레이아웃과 이름은 직접 설계한다.
- 사용자 문자열은 `textContent`로만 넣는다. `innerHTML`에 넣지 않는다. `alert/confirm/prompt` 금지.
- 모든 모듈은 `dispose()`로 리스너·rAF·채널을 정리한다.
- 순수 로직(무기, 판정, 이동, 맵 데이터, 규칙)은 three.js·DOM에 의존하지 않아야 하고 `tests/*.test.mjs`(`npm test`)로 검증한다.
- UI 문구는 한국어, 코드 식별자는 영어.

### 파일 머리말 (필수)
새로 만들거나 크게 고친 코드 파일 맨 위에 넣는다. `tools/check-headers.mjs`가 검사한다.
```
/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 이 파일이 하는 일을 한두 문장으로
 */
```
HTML은 `<!DOCTYPE html>` 다음 줄에 `<!-- ... -->`, SQL은 `--`, YAML은 `#`. JSON에는 넣지 않는다.

## 2. 부위 판정과 히트박스

`consts.PARTS = ['head','body','legs','hand','foot']`. `HITBOX` / `HITBOX_CROUCH`에 `FOOT`(발), `HANDS`(손 구 2개)가 추가됐다.

- `physics.raycastPlayers`는 다섯 부위 중 하나를 돌려준다. 손은 로컬 좌표 구이고 yaw로 회전한다.
- 손은 탄이 손만 스칠 때만 손이다. 같은 사람의 다른 부위가 그 뒤에 있으면 그 부위로 친다. 총을 쥔 손이 가슴 앞에 있어서, 이렇게 하지 않으면 정면 가슴 사격이 저격 반샷이 된다.
- `weapons/defs.js`의 `normalizePart`와 `match.js`의 부위 정규화에서 `foot`, `hand`를 더 이상 `legs`, `body`로 뭉개지 않는다.
- `protocol.PART_CODES = ['head','body','legs','hand','foot']` (뒤에 추가, 앞 순서 유지).
- 칼·수류탄은 부위 무시.

## 3. 무기

### 3.1 정의 스키마 (`js/weapons/defs.js`, 순수 데이터)
기존 필드에 다음을 더한다.
```js
{
  id, slot, kind: 'rifle'|'dmr'|'smg'|'shotgun'|'sniper'|'pistol'|'melee'|'grenade',
  fire: 'auto'|'semi'|'bolt'|'burst'|'melee'|'throw',
  price: 0,                     // 0 = 기본 지급
  sound: 'rifle',               // fx/audio 총성 이름 (3.5)
  fxKind: 'rifle',              // fx/effects 종류: 'rifle'|'sniper'|'pistol'
  damage: { head, body, legs, hand, foot },
  headIgnoresFalloff: true,     // 라이플 헤드 1발 보장: 거리 감쇠를 머리에 적용하지 않는다
  burst: { count: 3, gap: 0.065 },        // fire:'burst'
  pellets: 8,                             // 산탄. fire 이벤트의 pellets[]
  zoom: { levels: [4, 9], inTime, outTime, accurateAt, overlay, hideViewmodelAt, moveMul, unzoomOnFire },
  melee: { slash: {...}, stab: {...} },   // 칼 2종 모두 같은 구조
}
```
`zoom.mag`(단일 배율)도 계속 읽는다. `levels`가 있으면 그 무기는 설정과 관계없이 **우클릭을 누를 때마다 0 → 1단 → 2단 → 0으로 순환**한다.

내보내기: `WEAPONS, WEAPON_IDS, PRIMARY_IDS, SECONDARY_IDS, MELEE_IDS, GRENADE_IDS, DEFAULT_LOADOUT, getDef, normalizePart, computeDamage(id, part, dist, kind, count=1), isHalfShot(id, part), falloffMul, explosionFalloff, zoomFov, vec3, toVec3`. `SLOT_DEFAULTS`는 없앤다. `damage`는 `computeDamage`의 별칭으로 남긴다.

`DEFAULT_LOADOUT = { primary: 'ar_std', secondary: 'pt_std', melee: 'ml_katana' }`.

`computeDamage`가 데미지 계산의 **유일한 구현**이다. `match.js`도 이것을 쓴다(복제 금지). 산탄은 `count`를 곱한다.

### 3.2 무기 표 (초기 밸런스, HP 100)
| id | 이름(short) | kind/fire | 연사 | 머리 | 몸 | 다리 | 손·발 | 감쇠(시작~끝→배율) | 탄 | 이동 | 가격 | 특징 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `ar_std` | RX-4 돌격소총 | rifle/auto | 600rpm | 110 | 30 | 22 | 15 | 30~80→0.75 | 30/90 | .95 | 0 | 표준 |
| `ar_rapid` | RX-9 스톰 | rifle/auto | 860rpm | 100 | 22 | 16 | 11 | 25~70→0.7 | 35/105 | .97 | 800 | 연사형. 반동·탄퍼짐 큼 |
| `ar_line` | LN-3 헤드라인 | rifle/auto | 480rpm | 120 | 17 | 12 | 8 | 40~100→0.8 | 25/75 | .95 | 1200 | 저데미지 저반동. 반동 40%, 탄퍼짐 좁음. 머리 전용 |
| `ar_burst` | BR-3 트리플 | rifle/burst | 3발 간격 .065, 재사격 .36s | 110 | 34 | 24 | 16 | 30~80→0.75 | 30/90 | .95 | 1000 | 3점사 |
| `dm_mark` | DM-4 마크스맨 | dmr/semi | 200rpm | 130 | 52 | 38 | 26 | 없음 | 15/45 | .9 | 1500 | 3배 스코프, 스코프 오버레이 없음 |
| `sm_vx3` | VX-3 바이퍼 | smg/auto | 950rpm | 60 | 18 | 14 | 9 | 12~40→0.55 | 32/128 | 1.05 | 600 | 기동형 |
| `sg_bx12` | BX-12 브리처 | shotgun/semi | .85s | 20 | 14 | 10 | 7 (펠릿당, 8발) | 8~22→0.35 | 6/24 | .98 | 700 | 근거리 |
| `sr_bolt` | SK-7 볼트 | sniper/bolt | 1.2s | 200 | 120 | 100 | **50** | 없음 | 5/20 | .85 | 0 | 4배 줌 |
| `sr_twin` | T-2 트윈옵틱 | sniper/bolt | 1.35s | 200 | 120 | 100 | **50** | 없음 | 5/20 | .82 | 1500 | **2단 줌 4배→9배** |
| `sr_swift` | S-3 스위프트 | sniper/bolt | .85s | 150 | 85 | 60 | 40 | 없음 | 7/28 | .95 | 1000 | 3배 줌, 경량. 몸 1발 아님 |
| `sr_heavy` | H-50 타이탄 | sniper/bolt | 1.9s | 300 | 200 | 150 | 70 | 없음 | 4/12 | .75 | 2500 | 5배 줌, 대물 |
| `pt_std` | P-9 권총 | pistol/semi | .16s | 70 | 28 | 20 | 14 | 15~45→0.6 | 12/36 | 1.0 | 0 | 보조 |
| `pt_magnum` | M-44 매그넘 | pistol/semi | .46s | 110 | 55 | 38 | 25 | 25~60→0.7 | 6/24 | .97 | 500 | 보조 |
| `ml_knife` | 컴뱃 나이프 | melee | 베기 50/.45s/1.8m/35° · 찌르기 100/1.0s/1.8m/12° | | | | | | | 1.1 | 0 | 빠르고 짧다 |
| `ml_katana` | 카게 카타나 | melee | 베기 65/.62s/2.7m/48° · 강타 120/1.25s/2.9m/14° | | | | | | | 1.05 | 0 | 길고 느리다 |
| `gr_frag` | 수류탄 | grenade | 기존 그대로 | | | | | | 1개 | 1.0 | 0 | |

요구사항 요약
- **라이플 헤드 1발**: `kind==='rifle'`은 거리와 상관없이 머리 ≥ 100.
- **저격 반샷**: 저격총은 손끝·발에 맞으면 표의 값(반샷), 나머지 부위는 1발 킬(표대로). `minDamage`와 `oneShotKill` 개념은 없앤다. 예전 코드의 "반샷"은 퀵스코프라는 뜻이었으니 문구를 "퀵스코프"로 바꾼다.
- `isHalfShot(id, part)` = `def.kind==='sniper' && part가 hand|foot`.

### 3.3 Arsenal (`js/weapons/logic.js`)
```js
createArsenal({ primary, secondary, melee, allowedSlots=[1,2,3,4], zoomMode, rng, walkSpeed, draw })
arsenal.setLoadout({ primary?, secondary?, melee? })   // 없는 키는 유지
arsenal.setAllowedSlots([3])                           // 칼전. 현재 무기가 금지면 허용된 첫 슬롯으로 바꾼다
arsenal.resetRound({ primary?, secondary?, melee?, draw })
arsenal.getZoom() → { ..., level, levels }             // level 0 = 줌 아님, levels = 단계 수
```
- `melee`, `swing` 이벤트의 `weaponId`는 실제 든 칼이다. `'ml_knife'`를 하드코딩하지 않는다.
- `fire` 이벤트의 `pellets[]`는 산탄 수만큼.
- `validateHit`, `recover`, `cycleTarget`은 전부 현재 로드아웃 기준으로 돈다.

### 3.4 판정 흐름 (`match.js`, `world.js`, `protocol.js`)
- `match.js`의 `WEAPON_RULES`는 손으로 쓰지 말고 `defs`에서 만든다(`rulesFromDefs(WEAPONS)`). 데미지는 `computeDamage`. `oneShotKill` 삭제.
- `createMatch({ rules: { ruleset: 'knife' } })` → `rules.ruleset`. 스냅샷에도 실린다. `claimHit`, `claimExplosion`은 `isWeaponAllowed`가 false면 `reject('ruleset')`. `setLoadout(id, weaponId)`는 `pickableWeapons(ruleset)`에 있는 id만 받는다. `DEFAULT_LOADOUT`은 규칙별 `defaultPick`.
- `claimHit`에 `count`(기본 1, `1..def.pellets`로 자른다). `encodeHit` 끝에 `count`를 덧붙인다. 산탄은 한 발에 맞은 펠릿을 피해자별로 모아 주장 1건으로 보낸다.
- `damage`, `kill` 이벤트에 `part`, `head`, `halfShot`을 싣는다. `standings`와 stats에 `halfShots`를 더한다.
- `world.localFire`: 펠릿을 모두 트레이스한다. 무기 사운드·이펙트는 `def.sound`, `def.fxKind`로 찾는다. `FIRE_SOUND`, `FX_KIND` 표를 없앤다.
- 멀티에서 원격 무기는 `getDef(weaponId)`로 찾는다.

### 3.5 사운드 이름 (`js/fx/audio.js`)
기존: `sniper, rifle, pistol, knife_slash, knife_hit, headshot, kill, hit_marker, ...`. 추가:
`smg, shotgun, magnum, dmr, katana_swing, katana_heavy, katana_hit, half_shot, pad_boost, portal, secret_found, purchase, ui_click, bhop_land`.
없는 이름을 재생해도 오류 없이 무시한다.

## 4. 이동 물리 (`js/engine/movement.js`, `js/engine/player.js`, `js/engine/input.js`)

플레이어만 Quake 계열 가속을 쓴다. 봇은 기존 `physics.moveCharacter` 경로 그대로.

```js
// movement.js (순수)
export function moveQuake(world, body, wish, dt, opt) → ev   // moveCharacter와 같은 ev + { hopped, swapBonus, speed }
// wish = { dirX, dirZ, speed, jump, strafeSign }  dirX/dirZ = 단위 방향(또는 0), speed = 목표 지면 속도
```
수평 속도를 계산한 뒤 `physics.moveCharacter(world, body, {…}, dt, { ...opt, rawVelocity: true })`로 충돌·수직 이동을 맡긴다. `rawVelocity`면 기존 가속 블록을 건너뛴다.

값과 이유는 `consts.MOVE`의 주석에 있고, 동작은 `tests/movement.test.mjs`가 고정한다.

- **지면**: 마찰(`FRICTION`, 입력이 없을 때만 `STOP_SPEED`) → 가속(`GROUND_ACCEL × speed`). 기존 조작감(5.2 m/s까지 약 0.1초)을 유지한다. 지면에서 `speed`보다 빠르면 마찰로 자연히 줄어든다.
- **스페이스 홀드 = 자동 점프**: `input.state.jump`가 눌려 있으면 착지 즉시 다시 뛴다. 눌림 직후 0.12초 버퍼도 유지. 스페이스를 누르고 있는 동안에는 이모트를 시작할 수 없다.
- **버니합**: 뛰려고 한 틱, 또는 착지 후 `HOP_GRACE` 안의 점프는 마찰을 먹지 않아 속도가 유지된다. 뛰는 틱에 걷기 속도보다 느리면 지면 가속을 한 번 받는다.
- **공중 스트레이프**: Quake `PM_AirAccelerate` 공식. `wishspeed = min(speed, AIR_WISH_CAP)`, `add = wishspeed − vel·wishdir`, `accel = AIR_ACCEL × wishspeed × dt`. 마우스를 스트레이프 방향으로 돌리면 가속된다.
- **느릴 때 공중 조작**: 수평 속도가 `AIR_LOW_SPEED`보다 느리면 상한을 그 값까지 올려, 제자리 점프 뒤 W로 약 2.3 m를 갈 수 있게 한다.
- **A/D 교체 보너스**: 공중에서 `strafeSign`이 바뀔 때마다 `SWAP_BONUS`를 현재 진행 방향으로 더한다(`SWAP_BONUS_MAX`까지, 최소 간격 `SWAP_GAP`). 마우스 없이 좌우로 흔들어도 가속감을 준다.
- **상한**: 입력으로 늘릴 수 있는 수평 속도는 `MAX_SPEED`까지. 발판으로 이미 넘은 속도는 깎지 않는다(착지 지점이 어긋나므로).
- **계단**: `moveCharacter`의 `nearFloor`가 뛰어오르기 직전의 낮은 턱을 처리해, 스페이스를 누른 채 0.3 m 계단에서 멈추지 않는다.
- 앉기·이모트·`frozen`·`speedScale`은 기존 동작 유지. `player:land`의 카메라 출렁임은 버니합 착지 때 줄인다. `state.speed`(수평 속력)를 쓸 수 있게 둔다. `player:jump`, `player:land`에 `hopped`가 실린다.
- `input.js`: `KeyF` → `input:inspect` (`LOCK_KEYS`에도 추가). `input.state.jump`는 이미 있다.

탄퍼짐의 공중 페널티는 유지한다. 뛰면서 쏘면 부정확하다.

## 5. 맵 데이터 확장 (`js/maps/<id>.js`)

기존 형식(`docs/ARCHITECTURE.md` 4절)에 선택 필드를 더한다.
```js
export default {
  id, name, nameEn, desc, size, theme, spawns, solids, decor,
  rulesets: ['classic','knife','sniper'],   // 고를 수 있는 규칙. 없으면 ['classic','sniper']
  tag: '칼전 전용',                           // 메뉴 배지(선택)
  pads: [                                     // 점프 발판(바닥 또는 박스 윗면 위에 그린다, 충돌 없음)
    { x, y, z, w, d, target: [x,y,z], apex: 3, color: '#35e0ff' },   // target에 떨어지도록 속도를 계산. apex = target·출발 중 높은 쪽 위 여유(m)
    { x, y, z, w, d, vel: [vx,vy,vz] }                               // 속도를 직접 지정해도 된다
  ],
  portals: [ { x, y, z, w, h, d, to: { x, y, z, rotY }, color } ],   // 특수 장소 이동(순간이동, 속도 0)
  secrets: [ { id, name, x, y, z, w, h, d, points: 100 } ],          // 비밀 스팟 판정 상자. 들어가면 1회 보상
  props: [ { type: 'crate'|'barrel', x, y, z, size?, mass? } ]       // 물리 소품(cannon-es, 표시 전용). y = 밑면 높이, size = 상자 모서리 또는 드럼통 높이
};
```
- `js/engine/triggers.js`(순수): `buildTriggers(data)` → `world.triggers`, `stepTriggers(world, body, height, state, dt = TICK_DT)` → `{ pad, portal, secrets: [] }`. 발판은 발이 사각형 안이고 높이 차 0.35 이내일 때, 재발동 대기 0.35초. `padVelocity(from, target, apex, g)`도 여기.
- `player.tick`이 호출하고 bus로 알린다: `player:pad {pad, pos}`, `player:portal {portal, pos}`, `player:secret {secret, pos}`. 연습장 봇도 `stepTriggers`로 발판을 탄다.
- `js/maps/builder.js`: 발판·포털을 자동으로 그린다(빛나는 원판, 위로 흐르는 화살표, 포인트 라이트 없이 emissive). `map.update`에서 움직인다.
- `validateMap`이 새 필드를 검사하고, `tools/check-maps.mjs`가 **스폰이 벽에 박히지 않는지, 발판 궤적이 target 근처에 실제로 착지하는지, 비밀 스팟이 발판·점프로 갈 수 있는지(시뮬레이션)**를 확인한다.
- 새 재질 12종(`consts.MATS`)과 장식 타입: `tree`(분홍 벚나무, 충돌 없음), `bamboo`, `lantern`, `banner`, `rope`, `vent`, `crateStack`.
- `js/maps/index.js`: `MAP_IDS = ['alley','dojo','longshot','nexus','jetty','tankfarm','vlcc']`. 파일이 없거나 깨지면 기존처럼 테스트 맵으로 대체한다. `MAP_LIST` 항목에 `rulesets`, `tag`. `mapsForRuleset(id)` 추가.

### 새 맵 네 개
| id | 이름 | 규칙 | 크기 기준 | 컨셉 |
|---|---|---|---|---|
| `alley` | 항구 골목 | classic, knife | 약 56×36 m | 좁은 맵. 양쪽 스폰에서 평행한 좁은 골목 3개가 가운데 작은 광장으로 모인다. 교전 거리 10~25 m. 지붕 발판 1쌍과 비밀 옥상 1곳 |
| `dojo` | 벚꽃 도장 | knife | 약 44×44 m | 칼전 전용. 시야가 짧고 기둥·낮은 벽·단차가 많은 원형에 가까운 안뜰. 발판으로 올라가는 회랑, 비밀 지붕 |
| `longshot` | 협곡 저격장 | sniper | 약 130×60 m | 스나 전용. 양끝 고지대 진지와 긴 시야선, 가운데 은폐 협곡. 발판으로 가는 저격 둥지, 포털로 가는 비밀 관측소 |
| `nexus` | 넥서스 | classic, knife, sniper | 약 90×70 m | 통합 맵. 칼전 구덩이, 라이플 골목, 저격 탑을 한 맵에 합친 다층 구조. 발판 다수, 비밀 2곳, 물리 소품 |

공통: 팀당 스폰 4곳 이상(+ 개인전 후보 `spawns.ffa` 6곳 이상), 물이나 맵 밖으로 떨어지지 않게 `clip` 막이. 시작 시야에 적이 바로 보이지 않게 스폰을 가린다. solids 400개, decor 280개 이하.

## 6. 규칙(룰셋) · 모드

`js/game/modes.js`가 정의한다(이미 작성됨). 모드(`team`/`ffa`)와 규칙(`classic`/`knife`/`sniper`)은 직교한다.
- `world.loadMap(mapId, { mode, ruleset })` → `arsenal.setAllowedSlots`. 칼전은 뷰모델이 처음부터 칼.
- `world.spawnLocal({ loadout })`: `loadout`은 `pickSlot`의 무기 id. 나머지 슬롯은 `ctx.account.loadout`에서 가져온다.
- 연습장 설정 시트: 규칙 → 모드 → 맵(`mapsForRuleset`) → 인원 → 난이도 순. 메뉴의 **빠른 시작**은 지난 설정(없으면 `alley`, 개인전, 봇 5)으로 바로 출격.
- 봇(`bots.js`): 무기 정보는 `defs`에서 만든다(`BOT_WEAPON_INFO` 복제 제거). `ruleset`을 받아 칼전이면 칼만 들고 거리를 좁혀 베고, 스나전이면 저격 위주. 봇 주무기는 `pickableWeapons(ruleset)`에서 고른다.
- 멀티: 방 메타에 `ruleset`. 로비 배지 "칼전 · 개인전", 방 만들기 시트에서 고르고 방장이 대기실에서 바꿀 수 있다.

## 7. 계정 · 닉네임 · 포인트 (`js/account/`)

`main.js`가 플러그인보다 먼저 `ctx.account = createAccount({ bus })`를 만든다.
```js
account.profile                // 읽기 전용 스냅샷 { nickname, points, owned:[id], loadout:{primary,secondary,melee}, stats, secrets:{}, createdAt }
account.loadout                // 현재 장비
account.hasNickname()
await account.checkNickname(name) → { ok, reason?:'format'|'reserved'|'taken'|'network', offline:boolean }
await account.setNickname(name)   → { ok, name, reason?, offline }
account.buy(id)                → { ok, reason?:'owned'|'points'|'unknown', points }
account.equip(slotKey, id)     → { ok, reason? }   // slotKey: 'primary'|'secondary'|'melee'
account.isOwned(id)
account.recordMatch(summary)   → { gained, breakdown:[{label,points}], points }
account.findSecret(mapId, secret) → { first:boolean, gained }
account.resetLocal()
account.remoteEnabled
// bus: 'account:change' { profile }
```
- 저장: localStorage `skalafps.profile.v1`(정본). Supabase가 설정돼 있으면 비동기로 동기화한다. 네트워크가 실패해도 게임을 막지 않는다.
- 기기 식별: `skalafps.token`(무작위 256비트 hex). 서버에는 sha256만 저장.
- 닉네임 규칙: 앞뒤 공백 제거, 연속 공백 1칸, **2~12자**, 한글·영문·숫자·`_`·`-`·공백, 비교는 소문자. 예약어(`admin, 관리자, 운영자, system, gm, null, undefined`)와 ` 봇`으로 끝나는 이름 금지.
- 온라인이면 중복 검사는 서버 기준(전역 유일). 오프라인이면 형식만 검사하고 `offline:true`를 돌려 화면에 "오프라인이라 중복 확인을 못 했어요"를 표시한다. 멀티 입장 때 다시 등록을 시도한다.
- 시작 포인트 500. 기본 지급: `price===0`인 무기.

### 포인트 (`js/account/economy.js`)
| 항목 | 봇전 | 멀티 |
|---|---|---|
| 킬 | 5 | 10 |
| 헤드샷 보너스 | 3 | 5 |
| 승리 | 30 | 60 |
| 완주 | 10 | 20 |
| 난이도 배율(봇전) | 쉬움 0.7 · 보통 1 · 어려움 1.4 | - |
| 비밀 스팟 첫 발견 | 맵에 적힌 값(기본 100) | 같음 |

`summary = { online, ruleset, mode, mapId, difficulty, kills, deaths, headshots, halfShots, win, draw, seconds }`. 연습장과 세션이 경기 끝에 한 번 부르고, 결과 화면에 "+120 P"를 보여 준다.

### Supabase (`supabase/schema.sql`, 새 프로젝트 전용)
테이블 `public.fps_players(id, token_hash unique, name, name_key unique, points, owned jsonb, loadout jsonb, stats jsonb, secrets jsonb, created_at, updated_at)`. RLS 켜고 anon 직접 접근 없음. RPC(SECURITY DEFINER): `fps_check_nickname(p_name)`, `fps_claim_nickname(p_token, p_name)`, `fps_get_profile(p_token)`, `fps_save_profile(p_token, p_points, p_owned, p_loadout, p_stats, p_secrets)`, `fps_top_players(p_limit)`. 설정 절차는 `docs/SUPABASE_SETUP.md`. 멀티 채널은 `skalafps:lobby`, `skalafps:room:<id>`이며 테이블이 필요 없다.

## 8. UI

`createUI` 화면 추가: `nickname`(첫 실행 게이트, 닫을 수 없음), `mypage`, `shop`. `PAGES`에 포함. 메뉴 이벤트: `menu:quick`, `menu:sandbox`, `menu:multi`, `menu:mypage`, `menu:shop`.
- **메인 메뉴**: 플레이어 카드(닉네임·포인트·마이페이지 버튼), 빠른 시작, 연습장, 멀티, 상점, 설정, 조작법.
- **닉네임 게이트**: 입력하면 0.4초 디바운스로 `checkNickname`, 사용 가능/이미 있음/형식 오류를 바로 보여 준다.
- **마이페이지**: 닉네임 변경(언제든, 같은 검사), 전적(킬·데스·K/D·헤드샷·반샷·경기·승), 포인트, 장비 3슬롯, 찾은 비밀 스팟.
- **상점**: 탭(라이플·저격·SMG/샷건·권총·근접), 카드(이름·가격·막대 그래프·특징), 구매/장착.
- **로드아웃**: `pickableWeapons(ruleset, owned)` 카드. 무기가 많으므로 작은 카드 그리드(숫자키 1~9). 카드에 스탯 요약.
- **로비·대기실·결과**: 규칙 배지, 결과 화면 획득 포인트.

HUD 추가 API
```js
ui.hud.set({ speed })               // 수평 속력 m/s. 5.5 넘으면 속도계 표시
ui.hud.callout(text, tone)          // 크로스헤어 아래 짧은 글자. tone: 'head'|'half'|'kill'. 예: '반샷! −50'
ui.hud.banner({ icon, title, sub }) // 상단 배너. 비밀 스팟 발견 등
ui.scope.set(amount, { mag, level, levels })   // 2단 줌 표시
```
시각 스타일은 어둡고 선명한 네온 포인트(시안 `#35e0ff`, 핑크 `#ff4d8d`)를 쓴 게임 UI. 기존 철판·리벳 질감은 걷어 낸다.

## 9. 뷰모델 · 아바타

- `weapons/viewmodel.js`: 모든 무기에 모형을 둔다. 라이플류는 공용 빌더에 파라미터(총신 길이, 탄창, 스코프, 색).
- **카타나**: 긴 곡선 도신(날 쪽 하몬 무늬, 살짝 빛나는 날), 코등이, 실이 감긴 손잡이. 베기는 좌우 번갈아 크게, 강타는 위에서 아래로. 궤적 잔상. `F`(input:inspect)로 칼을 돌려 보는 동작. 다른 무기도 간단한 inspect.
- `engine/avatars.js`: 슬롯 3이면 총 대신 칼 모형(카타나/나이프). `setActorState(id, { slot, weaponId })`. 안전모·보안경 같은 작업자 복장은 전술 헬멧으로 바꾼다.

## 10. 물리 소품 (`js/engine/props.js`)

맵의 `props`를 cannon-es로 시뮬레이션한다. **표시 전용**이라 판정에 영향이 없고 멀티에서 동기화하지 않는다. `import('cannon-es')`가 실패하면 조용히 고정 소품으로 대체한다. 플레이어가 밀면 움직이고, 폭발과 총알에 튕긴다. 동시 활성 40개 이하, 잠들기(sleep) 사용.

## 11. 디버그

- `?debug=1`: `window.__skalafps = ctx`, 디버그 패널. **F3** 패널(FPS, 위치, 속도, 지면, 무기, 줌 단계, 맵 통계, 네트워크), **F4** 히트박스 표시, **F6** 충돌체 와이어프레임.
- `?log=debug|info|warn`: `js/core/log.js`의 `createLogger('ns')`. 최근 500줄을 `window.__skalafps.logs`에 보관.
- `?autoplay=1`: 포인터 잠금 없이 입력 허용(자동 테스트).
- 코드 중복(무기 표, 부위 표, 데미지 계산)을 한 모듈로 모아서 고칠 곳을 하나로 만든다.
