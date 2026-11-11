# SKALA 작전 — CORE API (엔진 코어 계약서)

다른 담당(무기·네트워크·UI·FX·맵·2차 웨이브)이 core에 붙는 방법을 정리한다. 경로는 모두 저장소 루트 기준이다.
ARCHITECTURE.md가 우선하며, 이 문서는 그 위의 구현 계약이다.

---

## 0. 실행·테스트

- 저장소 루트에서 `npm run serve`(`node tools/serve.mjs`, 기본 포트 8080)로 정적 서버를 띄우고 `http://localhost:8080/`을 연다.
- 메뉴 → 맵 카드 선택 → **🎯 연습장 시작** → 화면을 클릭하면 Pointer Lock이 걸리고 조작이 시작된다(Esc → 일시정지).
- URL 파라미터
  | 파라미터 | 효과 |
  |---|---|
  | `?sandbox=<mapId>` | 메뉴를 건너뛰고 바로 연습장에 들어간다(`jetty`·`tankfarm`·`vlcc`·`testyard`) — 맵 담당의 확인용 |
  | `&debug=1` | `window.__skalafps = ctx`를 노출하고 FPS·드로우콜·좌표를 표시한다 |
  | `&plugins=0` | 플러그인을 불러오지 않는다(순수 core) |
  | `&autoplay=1` | 자동 테스트용. Pointer Lock 없이도 게임 입력을 받는다 |
- 순수 모듈(`core/*`, `engine/physics.js`, `engine/interp.js`)은 three.js에 의존하지 않아 node에서 바로 import할 수 있다.

## 1. 좌표·단위·각도 규약

- 1 = 1 m, y는 위쪽, 지면은 y = 0, 맵 원점은 맵 중앙이다. 벡터는 `[x, y, z]` 배열로 쓴다(physics는 `{x,y,z}` 대상 pos도 받는다).
- `pos`는 **발바닥** 위치다. 눈 높이는 `pos[1] + PLAYER.EYE(1.6)`이다.
- **yaw**는 Y축 회전(라디안)이고 three.js `rotation.y`와 같다. yaw = 0이면 **-Z**를 본다. yaw가 커질수록 왼쪽으로 돈다.
  - 전방 = `(-sin yaw, 0, -cos yaw)`, 오른쪽 = `(cos yaw, 0, -sin yaw)`.
  - 대상을 바라보는 yaw = `atan2(-(tx-x), -(tz-z))`.
- **pitch**가 양수면 위를 본다(±89° 제한). 카메라 Euler 순서는 `'YXZ'`이다.
- 맵 `rotY`:
  - `spawns`·`loadingArm`: yaw와 같은 의미의 라디안이다. 절댓값이 2π보다 크면 도(°)로 보고 변환한다.
  - `sign`: **three.js `rotation.y`에 그대로** 넣는다. rotY = 0이면 표지판 앞면이 **+Z(남)**를 향한다(확정 규약).
- 시간: 틱 dt는 초 단위다(고정 1/60). 스냅샷 시각 `t`는 ms이며, `sample()`과 같은 시계(`performance.now()` 권장)를 쓴다.

## 2. 파일과 export

| 파일 | 주요 export |
|---|---|
| `js/core/consts.js` | `PLAYER, HITBOX, HITBOX_CROUCH, CROUCH_SPREAD_MUL, EMOTES, EMOTE_IDS, EMOTE_WHEEL, EMOTE_BLEND, emoteByCode(), emoteById(), emoteSlotAt(), PARTS, TEAMS, TEAM_IDS, TICK_RATE, TICK_DT, NET, MATCH, VIEW, MATS, LIMITS, SLOTS, SCREENS, MOUSE, VERSION, toRad()` |
| `js/core/bus.js` | `bus`, `on(evt, fn) → off`, `once`, `off`, `emit(evt, data)`, `createBus()` |
| `js/core/settings.js` | `createSettings(bus)` → `{ get, set, all, reset }`, `DEFAULT_SETTINGS` |
| `js/engine/physics.js` | `createWorld, solidToCollider, makeBox, rectSubtract, rampHeight, moveCharacter, raycastWorld, raycastPlayers, traceShot, lineOfSight, sphereSweep, getGroundY, findFloor, overlapsCapsule, canStand` |
| `js/engine/interp.js` | `SnapshotBuffer`, `lerpAngle`, `wrapAngle` |
| `js/engine/emoteanim.js` | 이모트 키프레임·FK·IK(순수): `sampleEmote, emoteLength, fk, plantY, solveArm, makePose, lerpPose, TRACKS, NEUTRAL, RIG` (16절) |
| `js/engine/renderer.js` | `createRenderer({ container, settings, bus })` |
| `js/engine/materials.js` | `getMaterial(name), getGroundMaterial, getTexture, matScale, matColor, hasMat, setWaterColor, MAT_INFO, MAT_NAMES` |
| `js/engine/input.js` | `createInput({ element, bus, settings })` |
| `js/engine/player.js` | `createLocalPlayer({ bus, input, camera, getWorld })`, `createPlayerState(init)` |
| `js/engine/avatars.js` | `createAvatars({ scene, camera, delay })` |
| `js/engine/loop.js` | `createLoop({ tickRate, bus })` |
| `js/engine/geom.js` · `decor.js` | 배치 지오메트리, 장식 모형 (내부용) |
| `js/engine/sandbox.js` · `devgun.js` · `fallback-ui.js` | 연습장 과녁, 임시 히트스캔 총, 기본 메뉴·HUD (내부용) |
| `js/maps/builder.js` | `buildMap(data, scene, { onWarn })`, `validateMap(data)`, `normalizeTheme(theme)` |
| `js/maps/index.js` | `MAPS`, `MAP_IDS`, `MAP_LIST`, `MAP_STATUS`, `TEST_MAP`, `getMap(id)` (top-level await) |
| `js/main.js` | 부트스트랩: 화면 상태 머신, 플러그인 로더, 연습장 |

## 3. 플러그인 계약 (`install(ctx)`)

부팅할 때 `js/{ui,net,game}/index.js`를 동적 import한다(`main.js`의 `PLUGIN_NAMES`). 무기(`weapons/`)·효과(`fx/`)는 따로 플러그인으로 올리지 않고 `game/world.js`가 엮는다(`game/WORLD_API.md`). **`export function install(ctx)`가 있을 때만** 호출하고, 파일이 없거나 오류가 나면 건너뛰고 core 기본 동작을 쓴다.
`createUI`·`connect`처럼 다른 이름의 진입점은 자동으로 부르지 않는다. 그런 진입점을 연결하는 접착 코드는 각자의 `install` 안에 둔다.

```js
// 예: js/fx/index.js
import { createEffects } from './effects.js';
export function install(ctx) {
  const fx = createEffects(ctx.renderer.scene, ctx.renderer.camera);
  const offs = [
    ctx.bus.on('hit:world', (e) => fx.impact(e.point, e.normal, e.mat)),
    ctx.onFrame((dt) => fx.update(dt), 500)          // 렌더(1000)보다 먼저
  ];
  return { provides: ['fx'], dispose() { offs.forEach((o) => o()); fx.dispose(); } };
}
```

- 반환값은 `{ provides?: string[], dispose?() }`이다(Promise도 된다).
- `provides`에 넣은 이름에 따라 core 기본 기능이 꺼진다.
  - `'weapons'`: 연습장의 임시 히트스캔 총을 만들지 않는다.
  - `'menu'`: core 기본 메뉴·로딩·일시정지 오버레이를 만들지 않는다.
  - `'hud'`: core 기본 HUD를 만들지 않는다.

### ctx (모든 플러그인이 받는 엔진 컨텍스트)

| 필드 | 설명 |
|---|---|
| `THREE` | three.js 네임스페이스(importmap과 같은 인스턴스) |
| `bus`, `consts`, `settings`, `physics`, `materials` | 위 모듈들 |
| `renderer`, `input`, `loop`, `player`, `avatars` | 엔진 인스턴스(아래 절 참고) |
| `maps` | `maps/index.js` 모듈(`MAPS`, `MAP_LIST`, `getMap`, `TEST_MAP`) |
| `session` | `{ id, name }` — 탭마다 고유한 id(sessionStorage, `[A-Za-z0-9_-]`)와 닉네임 |
| `ui.root` | DOM 오버레이 루트 `#pc-ui`(pointer-events: none — 클릭이 필요한 요소는 직접 auto로) |
| `map` / `world` | 현재 빌드된 맵(`buildMap` 결과)·physics world (없으면 null) |
| `screen`, `loading`, `rendering`, `flags` | 현재 화면, 맵 로딩 중 여부, 3D 렌더 여부, URL 플래그 |
| `setScreen(name, params) → Promise` | 화면 전환. 여러 번 호출해도 순서대로 하나씩 처리한다 |
| `registerScreen(name, { enter(params, from), exit(to) }) → unregister` | `lobby/room/match/results` 화면을 구현해 등록한다 |
| `loadMap(id) → Promise<map>` / `unloadMap()` | 맵 빌드·해제(테마·조명 적용, 셰이더 미리 컴파일) |
| `getTargets()` | 사격 대상 목록 = `avatars.getTargets()` + `addTargets` 제공자들 |
| `addTargets(fn) → remove` | 추가 사격 대상 제공 함수(봇 등). `fn() → [{ id, pos, yaw, alive }]` |
| `traceShot(origin, dir, maxDist, opts)` | 현재 맵 + `getTargets()`로 판정(벽이 먼저 막으면 사람을 안 맞힘) |
| `raycastWorld(origin, dir, maxDist, opts)` | 현재 맵 월드 레이캐스트 |
| `onTick(fn, order)` / `onFrame(fn, order)` | 루프 훅. `→ off` |
| `setPlayerName(name)` | 닉네임 변경(설정 저장, `player:name` 발행) |
| `enterFullscreen()` / `exitFullscreen()` / `toggleFullscreen()` / `isFullscreen()` | 전체 화면(클릭·키 핸들러 안에서). 전체 화면이면 input이 Keyboard Lock으로 Ctrl+W·Tab·Esc 같은 키도 받는다(크로뮴). F11과 설정 `fullscreen`이 이것을 부른다(MODES.md 9절) |
| `setRendering(bool)` | 커스텀 화면(관전 등)에서 3D 렌더를 켜고 끈다 |

### 화면 상태 머신

`menu | sandbox | lobby | room | match | results` 중 core는 `menu`와 `sandbox`만 구현한다.
등록되지 않은 화면으로 가려 하면 `screen:unavailable` 이벤트를 발행하고 현재 화면에 머문다.
`enter`가 예외를 던지면 `app:error` 이벤트를 발행하고 `menu`로 돌아간다.
`match`를 구현할 때 다음 구성을 참고한다.

```js
ctx.registerScreen('match', {
  async enter({ mapId, team }) {
    await ctx.loadMap(mapId);
    ctx.player.state.team = team; ctx.avatars.setLocalTeam(team);
    ctx.player.spawn(ctx.map.spawns[team][0]);
    ctx.setRendering(true); ctx.input.setEnabled(ctx.input.locked);
  },
  exit() { ctx.avatars.clear(); ctx.setRendering(false); ctx.input.exitLock(); ctx.unloadMap(); }
});
```

게임 화면(`sandbox`, `match`)에서는 Pointer Lock 상태가 곧 조작 가능 여부다(잠금이 풀리면 `input.setEnabled(false)`).

## 4. bus 이벤트

### core가 발행
| 이벤트 | payload |
|---|---|
| `app:ready` | `{ ctx }` |
| `app:error` | `{ message }` |
| `screen:change` | `{ from, to, params }` |
| `screen:unavailable` | `{ name, params }` |
| `plugin:loaded` / `plugin:failed` | `{ name, provides }` / `{ name, message }` |
| `map:loading` / `map:loaded` / `map:error` / `map:unload` | `{ id }` / `{ id, data, map }` / `{ id, message, error }` / `{ id }` |
| `loop:tick` / `loop:frame` | `{ dt, tick, t }` / `{ dt, alpha, now }` (리스너가 있을 때만) |
| `settings:change` | `{ key, value, settings }` |
| `renderer:quality` | `{ level: 'high'\|'medium'\|'low' }` |
| `input:lock` | `{ locked }` |
| `input:lock-error` | `{}` |
| `input:fire` | `{ down }` — 좌클릭(잠금 중) |
| `input:aim` | `{ active, source: 'user'\|'reset'\|'release' }` — 우클릭(hold/toggle 설정 반영) |
| `input:reload` / `input:jump` | `{}` |
| `input:inspect` | `{}` — F(무기 살펴보기) |
| `input:use` | `{ down }` — E(폭파 미션 설치·해체, 누르고 있는 동안). 휴대폰은 설치/해체 버튼(`input.touch.use`) |
| `input:slot` | `{ slot: 1..4 }` |
| `input:cycle` | `{ dir: 1\|-1 }` — 휠(1 = 다음) |
| `input:walk` | `{ down }` — Shift |
| `input:crouch` | `{ down }` — 왼·오른 Ctrl 또는 C(누르고 있는 동안, 하나라도 눌려 있으면 down) |
| `input:scoreboard` | `{ open }` — Tab 누름/뗌 |
| `input:menu` | `{ reason: 'esc'\|'unlock' }` |
| `input:key` | `{ code, down }` — 모든 키(`e.code`, 반복 제외) |
| `input:chat` | `{}` — 잠금 중 Enter(휴대폰은 채팅 버튼). 이모트 휠이 열려 있거나 키 반복이면 내지 않는다. 멀티플레이 경기면 session이 채팅 입력칸을 연다 |
| `input:loadout` | `{}` — N(키 반복 제외, 입력이 켜져 있을 때). 휴대폰은 HUD의 무기 교체 안내를 누른다. World가 라운드 시작 전 대기 시간이면 무기 교체 창을 여닫는다(MODES.md 7절) |
| `input:lockRequest` | `{}` — `requestLock()`을 부른 순간(사용자 입력 안). 설정 `fullscreen`이 켜져 있으면 main.js가 전체 화면도 같이 켠다 |
| `input:fullscreenToggle` | `{}` — F11. main.js가 앱의 전체 화면을 켜고 끈다 |
| `input:keyboardLock` | `{ locked }` — 전체 화면 키 잠금(Keyboard Lock)이 걸리고 풀릴 때 |
| `fullscreen:change` | `{ active }` — 전체 화면에 들어가고 나올 때(main.js) |
| `player:spawn` | `{ state, point }` |
| `player:jump` / `player:land` | `{ pos }` / `{ pos, speed, mat }` |
| `player:step` | `{ pos, speed, quiet, crouch, mat }` — 발소리(걷기 1.95 m, Shift·앉아서 1.5 m마다, Shift·앉음이면 `quiet:true`) |
| `player:crouch` | `{ crouch }` — 로컬 플레이어가 앉거나 일어섰을 때 |
| `player:damage` | `{ amount, hp, from?, part?, weapon?, dir? }` |
| `player:death` | `{ id, from?, part?, weapon? }` |
| `player:fell` / `player:name` | `{ pos }` / `{ id, name }` |
| `sandbox:start` / `sandbox:end` | `{ mapId, map }` / `{}` |
| `sandbox:target-hit` | `{ id, name, part, damage, hp, dist, killed, weapon }` |
| `sandbox:target-down` | `{ id, name, part, dist, weapon }` |
| `sandbox:stats` | `{ shots, hits, head, body, legs, kills, damage, accuracy, longest }` |
| `sandbox:targets` | `{ list: [{ id, name, hp, alive, mode, dist }] }` |

### core가 받는 이벤트 (다른 모듈이 발행)
| 이벤트 | 효과 |
|---|---|
| `camera:shake` `{ amount: 0..1 }` | 화면 흔들림(트라우마). 폭발 등에 쓴다 |
| `camera:kick` `{ pitch, yaw }` | 화면만 튀었다 돌아오는 반동(라디안) |
| `weapon:fire` `{ shooterId, weapon, slot, origin, dir, aimed, shotId }` | 연습장 사격 수 집계 |
| `hit:player` `{ shooterId, weapon, targetId, part, damage, point, dist, dir, shotId }` | 연습장 과녁 피해 적용 |

### 무기 이벤트 형식 (임시 총이 발행하고, weapons 모듈도 같은 형식을 권장)
`weapon:fire`, `hit:world { shooterId, weapon, point, normal, mat, dist, dir, shotId }`, `hit:player`(위 표),
`weapon:ammo { weapon, slot, ammo, mag, reserve, reloading }`, `weapon:reload { weapon, slot, time }`, `weapon:zoom { weapon, active, fov }`.

## 5. physics (순수, `js/engine/physics.js`)

캐릭터는 반지름 0.35, 키 1.8의 **세로 원기둥(발은 평평)**으로 근사한다. 벽에서는 미끄러지고, STEP(0.45 m) 이하의 턱은 오르며(공중에서는 0.225 m), 계단·경사로를 내려갈 때는 바닥에 붙는다. 서브스텝은 한 번에 0.15 m 이하로 움직여 터널링을 막는다.

```js
const world = createWorld(colliders, { bounds, floorY: null|number, groundMat, cell: 4 });
// world 바인딩 메서드: raycastWorld · raycast · traceShot · moveCharacter · sphereSweep · getGroundY · findFloor · lineOfSight · overlapsCapsule
```

| 함수 | 시그니처 / 반환 |
|---|---|
| `solidToCollider(solid, i)` | 맵 solid → `{ kind:'box'\|'cyl'\|'ramp', minX..maxZ, mat, (x,z,r), (dir, planes) }`, 잘못되면 null |
| `moveCharacter(world, body, wish, dt, opt?)` | `body = { pos, vel, onGround }`를 직접 수정한다. `wish = { x, z (m/s 월드), jump }` → `{ jumped, landed, impact, ceiling, stepUp, walls }` |
| `raycastWorld(world, origin, dir, maxDist, { includeHidden?, filter? })` | `{ dist, point, normal, mat, collider } \| null`. 보이지 않는 외곽 벽(noRay)은 통과한다 |
| `raycastPlayers(origin, dir, maxDist, targets, { ignoreId? })` | `{ id, part:'head'\|'body'\|'legs', dist, point, target } \| null`. 가장 가까운 부위를 고른다 |
| `traceShot(world, origin, dir, maxDist, targets, opts)` | `{ kind:'player', id, part, dist, point, target }` · `{ kind:'world', dist, point, normal, mat }` · `{ kind:'none', dist, point }` |
| `sphereSweep(world, body, dt, { radius=0.07, gravity=-16, restitution=0.38, friction=0.7 })` | 수류탄용. body를 직접 수정한다. friction은 '충돌 시 접선 속도 유지율' → `{ hits:[{ point, normal, speed, mat }], resting }`. **`tag:'clip'` 막이는 통과**하고 외곽 벽(`tag:'bounds'`)에는 튕긴다(결정론 — 모든 클라이언트 같은 결과) |
| `lineOfSight(world, a, b)` | 막는 것이 없으면 true(폭발 엄폐 체크용) |
| `getGroundY(world, x, z, fromY=∞, r=0)` | fromY 이하의 가장 높은 윗면 |
| `findFloor(world, x, z, { radius, height })` | 아래부터 키 높이만큼 빈 공간이 있는 첫 바닥(스폰용) |
| `overlapsCapsule(world, x, y, z, r, h)` | 그 자리에 설 수 있는지 |
| `canStand(world, x, y, z, { radius, height })` | 앉은 자리에서 일어설(키 1.8) 공간이 있는지. `world.canStand(x,y,z)`도 있다 |

`raycastPlayers`·`traceShot`의 대상은 `crouch`(true 또는 0..1)를 받는다. true면 `HITBOX_CROUCH`, 0..1이면 두 히트박스를 그 비율로 섞는다(자세 전환 중). 생략하면 서 있는 히트박스다.

히트박스는 `HITBOX`를 따른다. 발바닥 기준이고 로컬 -Z가 정면이다.
- head: 구, 중심 높이 1.62, 반지름 0.14.
- body: yaw로 회전하는 박스, 높이 1.0–1.5, 반폭 0.26, 반깊이 0.17.
- legs: 같은 회전 박스, 높이 0–1.0, 반폭 0.22, 반깊이 0.15.

성능: 충돌체 300개 기준으로 캐릭터 1스텝은 약 1 µs, 레이 1회는 약 10 µs이다(node).

## 6. renderer (`createRenderer`)

| 멤버 | 설명 |
|---|---|
| `scene`, `camera` | 월드 씬, 원근 카메라(FOV = 설정값, 기본 75, rotation.order `'YXZ'`, 씬에 추가돼 있음) |
| `viewScene`, `viewCamera` | **뷰모델 전용** 씬과 카메라(FOV 60, 원점 고정, -Z가 정면). 월드를 그린 뒤 깊이를 지우고 위에 그리므로 총이 벽에 파묻히지 않는다. 조명은 월드 태양 방향을 따라간다 |
| `setFov(deg)` / `zoomTo(deg, ms=120)` | 즉시 / 부드럽게(ease-out) FOV 변경 |
| `getFov()`, `getZoomProgress()`, `baseFov`, `setBaseFov(deg)` | 줌 진행도 0..1(트윈 중이 아니면 1). 반샷 판정은 무기 쪽 로직으로 처리한다 |
| `setTheme(theme)` | 하늘 그라데이션(셰이더)·안개·태양(방향광)·반구광. `loadMap`이 자동 호출한다 |
| `setShadowFocus(x,y,z)` | 그림자 1장(1024, ±36 m)을 플레이어 주변으로 옮긴다(core가 매 프레임 호출) |
| `setQuality('high'\|'medium'\|'low')`, `quality` | low = 그림자 끔 + pixelRatio 1. 설정이 `auto`면 느린 프레임이 3초 넘게 이어질 때 단계적으로 낮춘다 |
| `info()` | `renderer.info`(두 패스 합산) |
| `three` | THREE.WebGLRenderer |

pixelRatio는 최대 1.5다. 톤매핑은 Neutral이고, 표지판·이름표는 `toneMapped:false`로 그린다.

## 7. input (`createInput`)

- `state.{forward, back, left, right, jump, walk, crouch, fire, aim, scoreboard}`: 폴링용 boolean. `crouch` = Ctrl(왼·오른) 또는 C를 누르고 있는 동안.
- `consumeLook() → { dx, dy }`: 라디안이며 감도·lookScale·invertY가 반영돼 있다. 플레이어가 매 프레임 소비한다.
- `requestLock()`은 반드시 클릭 핸들러 안에서 부른다. `exitLock()`, `locked`, `setEnabled(bool)`, `releaseAll()`도 있다.
- `setLookScale(s)`: 줌 중 감도 배율. 무기 쪽에서 `(줌FOV/기본FOV) × settings.zoomSensitivity`를 넣는다.
- `resetAim()`: toggle 모드의 줌을 강제로 해제한다(예: 저격 후 자동 줌 해제). `input:aim {active:false, source:'reset'}`를 발행한다.
- 키는 `e.code` 기준이라 한/영 상태와 무관하다. 입력창에 타이핑하는 중에는 무시한다. 우클릭 메뉴를 막고, 휠은 110 ms로 스로틀한다.
- Pointer Lock 중에는 Ctrl 조합(Ctrl+S·D·R·A·Space, Ctrl+휠 확대 등)의 브라우저 기본 동작을 막는다. Ctrl+W·T·N·Tab은 브라우저가 먼저 가져가 막을 수 없다(15절).
- 전체 화면(Fullscreen API)이 되면 `navigator.keyboard.lock()`으로 `LOCK_KEYS`(게임 키, Tab·Enter·Esc·F11, 숫자 1~9, T·N·Q)를 잠가 Ctrl+W·Ctrl+T·Ctrl+Tab도 게임이 받는다(크로뮴 계열).
  Esc도 잠그므로 잠금 중의 Esc는 전체 화면을 풀지 않고, input이 포인터 잠금만 직접 풀어 `input:menu`가 나간다. `keyboardLocked`, `canKeyboardLock`으로 상태를 읽는다.
- F11은 가로채서 `input:fullscreenToggle`을 낸다(브라우저의 F11 전체 화면은 키를 잠그지 못한다). 입력칸에 포커스가 있어도 받는다.
- N은 `input:loadout`을 낸다(라운드 시작 전 무기 교체 창).

## 8. player (`createLocalPlayer`)

`PlayerState`는 다음 필드를 가진다.
```
{ id, name, team, pos:[x,y,z], vel:[x,y,z], yaw, pitch, onGround, hp, alive, slot, weapon,
  moving, walking, crouch, aiming, speedScale, frozen, kills, deaths }
```
- `spawn({x,y,z,rotY})`, `tick(dt)`(고정 틱), `frame(dt, alpha)`(시점·카메라 보간·걷기 흔들림·착지 출렁임·계단 부드럽게)
- `addRecoil(pitch, yaw)`: 조준점이 실제로 이동한다. `kick(pitch, yaw)`: 화면만 튀었다 돌아온다. `addShake(0..1)`: 화면 흔들림.
- `damage(amount, info) → { hp, killed }`, `kill(info)`: 사망하면 카메라가 쓰러지는 연출을 한다.
- `getEye()`: 사격 원점(카메라 위치). `getAimDir()`: yaw·pitch 방향(흔들림 제외). `forward()`.
- `snapshot()`: 네트워크 전송용 `{ id, pos, yaw, pitch, moving, walking, crouch, aiming, onGround, alive, hp, slot, team }`.
- 앉기: `state.crouch`, `crouchAmount`(카메라용 0..1), `canStand()`. 자세한 규칙은 15절.
- `setFrozen(bool)`(라운드 대기 등), `setSpeedScale(s)`(무기 무게·정조준 감속).
- `slot`·`weapon`은 무기 모듈이 직접 써 넣는다.

## 9. avatars (`createAvatars`) — 원격 플레이어

- 오리지널 저폴리 인물 모델이다: 전투복(팀색)에 캐릭터마다 머리 장비·조끼·부착물이 다르다(DESIGN 7절 캐릭터 표, `core/avatar-defs.js`). 메시는 4개(상체+머리, 양다리, 팔+총)이고 모두 정점색 재질 하나를 쓴다.
- `add(id, { name, team, avatar })`, `remove(id)`, `get(id)`, `list()`, `clear()`. `avatar`는 캐릭터 id이고 모르는 값·생략은 기본 캐릭터(`av_trooper`)다.
- 캐릭터: `get(id).setAvatar(id)`(다시 그림), `get(id).avatarId`. 몸 치수·히트박스는 모든 캐릭터가 같다. 캐릭터 × 팀마다 부품을 한 번 구워 나눠 쓴다.
- 상점 초상: `createAvatarPortraits(webglRenderer).get(id, team)` → PNG data URL(240×320, 투명 배경) 또는 `null`. 게임 렌더러로 렌더 타깃에 그려 같은 톤 매핑을 직접 입힌다. 캐릭터 × 팀마다 한 번만 그린다.
- `push(id, t, state)`: 스냅샷을 넣는다. 아바타가 없으면 자동으로 만든다. 지원하는 state 필드는 다음과 같다.
  - `pos, yaw, pitch, alive`
  - `crouch`(bool): 0.12초에 걸쳐 쪼그려 앉은 자세(엉덩이 뒤로 낮추고 무릎 굽힘, 상체 숙임, 이름표도 낮춤)
  - `name, team, avatar`: 바뀌면 다시 그린다.
  - `deathDir:[x,z]`, `respawned:true`(부활), `teleport:true`(보간하지 않음)
- `update(now, dt)`: `now − 100 ms`(NET.INTERP_DELAY_MS) 시점으로 보간한다(위치는 선형, yaw는 최단 각). 최신 스냅샷을 넘어서면 150 ms까지만 외삽한다.
- `getTargets()`: **화면에 보이는(보간된) 위치·yaw·자세**로 만든 히트 대상 `[{ id, pos, yaw, alive:true, crouch(0..1), team, name }]`이다. 쓰러진 아바타는 빠진다. `crouch`는 자세 전환 비율이라 히트박스가 보이는 자세와 맞는다.
- `get(id).kill({ dir })`: 피 없이 총알 방향으로 쓰러진다(0.65 s). `.revive()`.
- `.setHeld(object3d)`: 손 소켓에 3인칭 무기 모델을 끼운다(총구 = -Z).
- `teleport(id, state)`, `setLocalTeam(team)`(아군 이름표는 이름이 벽 너머로도 보인다. 적 이름표에는 닉네임이 없고, 상태 표시 `badge`(🛡 부활 보호)가 있을 때만 그 글자가 35 m 안에서 보인다. 규칙은 `engine/nametag.js`), `setDelay(ms)`.
- `add(id, { name, team, avatar, badge })`: `badge`는 이름표 앞 상태 표시(World가 정한다: 🛡 보호 · 💣 폭탄을 든 아군).
- 순수 버퍼만 필요하면 `SnapshotBuffer`(`engine/interp.js`)를 쓴다: `push(t, state)`, `sample(renderTime, out?)`.

## 10. loop (`createLoop`)

- 60 Hz 고정 틱과 가변 렌더(rAF)로 돈다. 한 프레임에 따라잡는 틱은 최대 6번이다.
- `onTick(fn(dt, tick, time), order)`, `onFrame(fn(dt, alpha, now), order)` → off.
- order가 작을수록 먼저 실행된다. core가 쓰는 order는 다음과 같다.
  - 움직이는 지형: 틱 -150(몸보다 먼저 옮긴다)
  - 플레이어: 틱 -100, 프레임 -100
  - 아바타·맵 애니메이션: -50
  - **렌더: 1000**(항상 마지막)
  - 플러그인은 기본값 0을 쓰면 된다.
- `fps`, `tick`, `time`도 읽을 수 있다.

## 11. 맵 빌더 (`buildMap`)

`buildMap(data, scene, { onWarn })`가 돌려주는 값은 다음과 같다.
```
{ id, data, name, theme(정규화), group, world, colliders, spawns:{owner:[{x,y,z,rotY}],charterer:[…]}, bounds:{minX,maxX,minZ,maxZ},
  seaLevel, warnings, stats:{solids, colliders, drawCalls, triangles, decor, lights, movers},
  getGroundY(x,z,fromY?), findFloor(x,z), raycastWorld(o,d,max), traceShot(o,d,max,targets), sphereSweep(body,dt,opt), lineOfSight(a,b),
  movers, tickMovers(dt), setMoverClock(fn), setMoverBodies(fn), update(dt,t,alpha), dispose() }
```
- **움직이는 지형**(`data.movers`, MAP_GUIDE.md 11절): 하나마다 메시 하나로 그리고 위아래에 노란 띠를 두른다. `tickMovers(dt)`는 틱마다 몸보다 먼저 불러 충돌체를 옮기고
  (core 루프가 부른다), `update(dt, t, alpha)`가 메시를 직전 틱과 이번 틱 자리 사이에 놓는다. `setMoverClock(fn)`은 초를 돌려주는 시계(멀티: 방장 시계)이고, 없으면 맵을 불러온 뒤 흐른 틱 시간이다.
  문(`door`가 있는 항목)은 사람이 가까이 오면 열린다. `setMoverBodies(fn)`이 살아 있는 사람의 발 위치 목록을 돌려주는 함수를 받는다(core는 내 몸과 사격 대상을, World는 스폰한 나와 보이는 사람·봇을 넘긴다). 문은 문틀 같은 어두운 띠를 두른다.
- **렌더**: solids는 재질별로 한 메시로 합친다(UV는 월드 좌표 ÷ `MAT_INFO[mat].scale`). 맵 하나의 정적 드로우콜은 재질 수와 같아서 약 12–15개다. 파이프와 부표는 InstancedMesh로 그린다.
- **바닥**: 플레이 영역 전체에 윗면 y = 0인 바닥 슬래브를 깔고 충돌체도 만든다.
  - 윗면이 y ≤ 0.05이고 아랫면이 0보다 낮은 box(물 웅덩이·바닥 높이 패치·구덩이)는 그 자리를 슬래브에서 도려낸다. z-fighting이 없어진다.
  - 0.01–0.03 m 두께의 바닥 패치를 y = 0 위에 깔아도 된다. 바닥 재질에 polygonOffset이 걸려 있다.
- **바깥 경치**: `theme.water`가 있으면 바다 평면(seaLevel)을 깐다. 이때 바닥 슬래브의 옆면이 물가의 벽이 된다. `theme.water`가 없으면 바닥 재질의 지면을 지평선까지 이어 깐다.
- **외곽 벽**: 보이지 않는 벽이다. 사람과 수류탄은 막지만 총알 레이는 통과한다.
- **theme 확장**(선택)
  - `ground`: 바닥 mat. 기본은 `'asphalt'`이고, `'none'`이면 바닥을 그리지 않으며 무한 평면 y = 0을 충돌용으로 둔다.
  - `waterLevel`: 바다 높이. 기본 -0.8, 물 box가 있으면 그 윗면.
  - `sunIntensity`: 태양 세기 배율.
- **decor 규약**
  - `sign`: y는 표지판 **중심** 높이다. rotY 규약은 1절을 따른다. 캔버스 텍스처에 한글·영문을 그리고 `\n`으로 줄을 바꾼다. 뒤판은 steel이다.
  - `light`: 상한(LIMITS.REAL_LIGHTS = 4) 안에서 **배열 앞쪽 light부터** 실제 PointLight가 된다. 나머지는 발광 구 + 빛무리 스프라이트로 그린다. light가 4개보다 적으면 남는 자리를 flare 불꽃이 쓴다.
  - `loadingArm`: 받침 + 라이저 + 트러니언 + 평형추 + 내측·외측 팔 + 유압 실린더 + 커플러로 이루어진다. rotY = 0이면 팔이 **+Z** 쪽으로 뻗는다. 높이는 약 10 m다.
  - `flare`: y는 탑 **바닥** 높이다. `h`(기본 14)를 받는다. 흰색·빨간 띠 탑, 받침 다리, 깜빡이는 불꽃 스프라이트로 이루어진다.
  - `buoy`: y를 생략하면 물 높이(물 box 윗면이나 바다)에 자동으로 놓고 출렁이게 한다. 색은 빨강·초록·노랑을 번갈아 쓰고, `color`로 지정할 수도 있다.
  - `pipe`: 재질별 InstancedMesh로 그린다.
- 스폰 y는 자동이다(`findFloor`: 아래부터 첫 빈 바닥). 플레이 영역 밖의 스폰은 안으로 당긴다. 한 팀 스폰이 비어 있으면 다른 팀 스폰을 원점 대칭으로 만들어 쓴다.
- `maps/index.js`는 세 맵을 동적 import한다(8초 타임아웃). 실패한 맵은 `TEST_MAP`(연습 창고 마당) 복제본으로 바꾸고 `fallback:true`를 붙인다.

## 12. 설정 (`ctx.settings`, localStorage `skalafps.settings.v1`)

| 키 | 기본값 | 범위·의미 |
|---|---|---|
| `sensitivity` | 1 | 0.1–5 |
| `zoomSensitivity` | 1 | 줌 중 추가 감도 배율 |
| `zoomMode` | `'hold'` | `'hold'`·`'toggle'` |
| `invertY` | false | 마우스 상하 반전 |
| `fov` | 75 | 60–100 |
| `quality` | `'auto'` | `'auto'`·`'high'`·`'low'` |
| `showFps` | false | FPS 표시 |
| `volume` | 0.8 | 0–1, FX용 |
| `fullscreen` | `'off'` | `'on'`·`'off'`. 전체 화면 유지(브라우저 단축키 잠금). 실제 전체 화면 상태를 따라 바뀐다(main.js `wireFullscreen`) |
| `name` | `''` | 닉네임 |

엔진은 이 저장소만 읽는다. UI 담당이 따로 둔 설정 패널은 `ctx.settings.set(key, value)`로 값을 써 넣어야 엔진에 반영된다.
닉네임 우선순위: `settings.name` → `플레이어NNN`.

## 13. 담당별 연결 가이드

- **weapons**
  - `install`에서 `provides:['weapons']`를 반환한다.
  - 입력: `input:fire/aim/reload/slot/cycle`. 판정: `ctx.traceShot(player.getEye(), dir, max, { ignoreId: player.state.id })`.
  - 결과: `hit:*`, `weapon:*` 이벤트를 발행한다.
  - 줌: `ctx.renderer.zoomTo()`와 `ctx.input.setLookScale()`.
  - 반동: `player.addRecoil()`과 `player.kick()`.
  - 뷰모델: `ctx.renderer.viewScene`. 3인칭 모델: `avatar.setHeld()`.
  - 수류탄: `ctx.world.sphereSweep`와 `ctx.world.lineOfSight`(grenade.js가 이미 자동 판별한다).
- **fx**: `hit:world`(mat별 파편), `hit:player`, `weapon:fire`, `player:step/land/jump`, `camera:shake` 발행. `ctx.renderer.scene`과 `ctx.renderer.camera`를 쓴다.
- **ui**
  - `provides:['menu','hud']`를 반환한다.
  - 메뉴에서 `ctx.setScreen('sandbox', { mapId })`를 부른다. 맵 목록은 `ctx.maps.MAP_LIST`다.
  - `requestLock()`은 클릭 핸들러 안에서만 부른다.
  - 일시정지: `input:menu`/`input:lock`. 점수판: `input:scoreboard`.
  - `ctx.ui.root`에 붙인다.
- **net / game**
  - 로컬 상태 송신: `player.snapshot()`을 10 Hz로 보낸다.
  - 원격 상태 수신: `avatars.push(id, performance.now(), state)`.
  - 피해: 방장 확정 후 `player.damage()`, 원격은 `avatars.get(id).kill()`.
  - 화면: `registerScreen('lobby'|'room'|'match'|'results')`.
  - 봇은 `addTargets()`로 대상에 넣거나 아바타로 넣는다.

## 14. 알려진 한계

- 캐릭터는 원기둥 근사다. 앉으면 키만 1.25 m로 줄고 발 위치는 그대로다(공중에서 다리를 접는 '앉아 점프' 높이 보너스는 없음). ramp는 경사와 관계없이 걸어 오를 수 있다(45° 이상 ramp는 만들지 말 것).
- Ctrl+W·Ctrl+T·Ctrl+N·Ctrl+Tab은 전체 화면 Keyboard Lock이 아니면 막을 수 없다. 창 화면의 경기 중 탭 닫기는 `beforeunload` 확인으로만 막는다. Keyboard Lock은 크로뮴 계열에만 있다.
- 그림자는 플레이어 주변 ±36 m만 생긴다. 실조명은 최대 4개다.
- 원격 아바타는 아바타당 드로우콜 4–5개(+그림자)를 쓴다. 8인 기준 프레임당 총 100–150콜이다.
- 연습장의 임시 총은 시연용이다(무기 모듈이 붙으면 빠진다). 사운드·이펙트는 FX 모듈 몫이다.
- 헤드리스(SwiftShader) 환경에서는 FPS를 잴 수 없었다. 실기 성능은 브라우저에서 `&debug=1`로 확인한다.

## 15. 점프 · 앉기 (2차 확장, MODES.md 1·2절)

### 점프
- `PLAYER.JUMP_V` = **6.3** m/s, 중력 -16 그대로. 최고 높이 **1.24 m**다. 수직 이동을 틱 시작·끝 속도의 평균으로 적분해서 틱 빈도와 관계없이 정확한 포물선을 그린다.
- 공중 턱 오르기(0.225 m)를 더하면 달리며 점프해서 **약 1.46 m** 높이까지 올라탄다(node 측정 1.461 m, 예전 5.2는 1.065 m).
- `moveCharacter(..., { jumpV })`로 점프 초속을 바꿔 시험할 수 있다(맵 담당 테스트용, 그대로 유지).

### 앉기
| 항목 | 값 / API |
|---|---|
| 입력 | Ctrl(왼·오른) 또는 C를 누르고 있는 동안 → `input.state.crouch`, `input:crouch { down }` |
| 상수 | `PLAYER.CROUCH_HEIGHT` 1.25 · `CROUCH_EYE` 1.1 · `CROUCH_SPEED` 2.6 · `CROUCH_TIME` 0.12 |
| 로컬 상태 | `player.state.crouch`(bool), `player.snapshot().crouch`, `player.crouchAmount`(카메라 0..1), `player.canStand()` |
| 물리 | 앉으면 충돌 키만 1.25로 줄고 **발 위치는 그대로**다(머리 쪽에서 줄어듦). 공중에서 앉아도 발이 올라가지 않아 '앉아 점프'로 더 높이 오르지 못한다(clip 막이 검증의 전제). 일어서기 전에 `canStand`로 머리 위(1.8 m까지)를 검사하고, 막혀 있으면 키를 떼도 앉은 채 유지한다 |
| 점프 | 앉은 채 Space → 일어설 수 있으면 일어서며 점프한다. 착지 뒤 키가 눌려 있으면 다시 앉는다. 막혀 있으면 점프 입력을 버린다 |
| 이동·발소리 | 2.6 m/s(× `speedScale`, Shift와 같이 누르면 2.4). `player:step`이 `quiet:true, crouch:true`, 보폭 1.5 m |
| 카메라 | 눈높이 1.6 ↔ 1.1을 0.12초 동안 부드럽게(smoothstep) 바꾼다. 흔들림도 줄어든다 |
| 이벤트 | `player:crouch { crouch }` |
| 히트박스 | `consts.HITBOX_CROUCH` = HEAD `{y:1.12, r:0.14}`, BODY `{y0:0.6, y1:1.05}`, LEGS `{y0:0, y1:0.6}`(hw·hd 같음). `raycastPlayers`·`traceShot`의 대상 `crouch` |
| 원격 아바타 | `avatars.push(id, t, { …, crouch })` → 자세가 바뀌고, `getTargets()`의 `crouch`(0..1)로 히트박스가 따라간다 |
| 탄퍼짐 | 앉아 있으면 ×0.8(`CROUCH_SPREAD_MUL`). 무기 로직은 `arsenal.update(dt, input, { speed, onGround, walking, crouch })`의 `crouch`로 적용하고, core 임시 총은 직접 적용한다 |
| 탭 닫기 | `sandbox`·`match` 화면에 있는 동안 `beforeunload` 확인을 건다(`?autoplay=1` 테스트 모드 제외). 조작법 안내: "앉은 채 앞으로 갈 때는 C 추천(Ctrl+W는 브라우저 탭 닫기)" |

### World(연습장·멀티) 연결 체크리스트 — `game/world.js` 담당
1. 무기 모션: `arsenal.update(dt, wi, { speed, onGround, walking, crouch: player.state.crouch })` → 탄퍼짐 ×0.8.
2. 로컬 상태 송신: `player.snapshot()`에 `crouch`가 이미 들어 있다. 프로토콜 플래그 `FLAG.crouch(32)`로 실어 보낸다.
3. 원격 액터: `setActorState(id, { …, crouch })`에서 `avatars.push`/`teleport`의 스냅샷에 `crouch: !!s.crouch`를 넣는다. 그러면 자세와 히트박스(`getTargets`)가 같이 따라간다.
4. 로컬 플레이어를 대상으로 하는 판정(봇 사격, 수류탄 등)은 대상 객체에 `crouch: player.state.crouch`를 넣는다(`raycastPlayers`가 `HITBOX_CROUCH`로 판정).
5. 원격 발소리: 지금처럼 `walking`이면 조용히 하고, `crouch`여도 조용히(또는 작게) 처리한다. 로컬 발소리는 `player:step.quiet`가 이미 true다.
6. 봇 조준: 상대가 `crouch`면 머리 높이를 `HITBOX_CROUCH.HEAD.y`(1.12)로 잡는다.


## 16. 이모트 (3차 확장, MODES.md 4절)

### 목록 — `core/consts.js`
- `EMOTES`: `[{ code, id, name, icon, loop, duration, bpm, price, desc }]`. 휠 칸 순서는 계정 장비(`loadout.emotes`), 처음은 `DEFAULT_EMOTE_WHEEL`(12시부터 시계 방향).
  `normalizeEmoteWheel(list, owns)`가 가진 이모트만 겹치지 않게 8칸으로 정리한다. `input.setEmoteWheel(ids)`로 휠 칸 → 이모트를 바꾼다.

  | code | id | 이름 | 길이 | bpm | 가격 |
  |---|---|---|---|---|---|
  | 1 | `takeL` | L을 가져가 🫵 | 반복 | 123.1 | 기본 |
  | 2 | `veggie` | 야채 🥬 | 반복 | 82.8 | 기본 |
  | 3 | `sideToSide` | 사이드 스텝 ↔️ | 반복 | 129.7 | 기본 |
  | 4 | `crissCross` | 크리스 크로스 ❌ | 반복 | 109.1 | 기본 |
  | 5 | `tango` | 탱고 💃 | 반복 | 96 | 기본 |
  | 6 | `salute` | 경례 🫡 | 2.5초 | — | 기본 |
  | 7 | `wave` | 손 흔들기 👋 | 2.5초 | — | 기본 |
  | 8 | `cheer` | 환호 박수 👏 | 반복 | 128 | 기본 |
  | 9 | `creamCheese` | 크림치즈 허니 🍯 | 반복 | 166.7 | 기본 |
  | 10 | `fromYou` | 당신에게서 💌 | 반복 | 72.7 | 600 P |
  | 11 | `selfie` | 셀카 🤳 | 반복 | 92.3 | 400 P |

- 그 밖의 export:
  - `EMOTE_IDS`
  - `EMOTE_WHEEL = { DEADZONE: 40, RADIUS: 160, SLOTS: 8 }`
  - `EMOTE_BLEND = 0.15`(초)
  - `emoteByCode(code)`, `emoteById(id|code)`
  - `emoteSlotAt(x, y)`: 칸 번호 0..7 또는 null. UI의 `emoteIndexAt`와 같은 규칙이다.
- 전송값은 code(1~15, 0 = 없음)이다. protocol 상태 플래그 6~9번 비트에 실린다.

### 입력 — 휠 (`engine/input.js`)
- **B를 누르고 있는 동안** 휠이 열린다(`input.state.emoteWheel`).
  - 시점은 멈추고, 마우스 이동은 가상 커서로 간다.
  - 커서 좌표는 px 단위이고 화면 중앙이 원점, y는 아래로 +이다. 160 px 테두리에서 멈춘다.
  - 포인터 잠금이 없으면 실제 커서 위치를 화면 중앙 기준으로 쓴다.
- 이벤트 `input:emoteWheel` `{ open, cursor:{x,y}, selected: 0..7|null, id, code, tap, cancelled? }`
  - 열 때, 커서·칸이 바뀔 때마다, 탭 모드가 켜질 때, 닫을 때 온다.
  - `tap`은 휴대폰에서 이모트 버튼을 짧게 눌러 열어 둔 휠이다(`input.setEmoteWheelTap(true)`, engine/touch.js가 켬). 손을 떼도 열려 있고, 칸을 누르면 `moveEmoteWheel` + `closeEmoteWheel(true)`로 고른다. 휠이 닫히면 꺼진다.
  - `selected`는 UI 휠 props의 `selected`에 그대로 넣으면 된다.
- 이벤트 `input:emotePick` `{ id|null, code, selected }`
  - B를 뗄 때, 또는 휠이 열린 동안 좌클릭으로 강조된 칸을 고를 때 온다.
  - 칸이 없으면(마우스를 안 움직임) `id`가 null이고 아무것도 하지 않는다.
- 휠이 열린 동안의 클릭과 Esc:
  - 우클릭·Esc는 고르지 않고 닫는다(`cancelled:true`).
  - 사격·줌은 하지 않는다(`input:fire`/`input:aim`을 내지 않음).
- `input.setEmoteLock(bool)`
  - player가 이모트 중에 켠다.
  - 켜져 있으면 좌·우클릭이 사격·줌 대신 `input:emoteCancel { reason:'fire'|'aim' }`이 된다. 첫 클릭이 사격되지 않는다.
- 그 밖: `input.emoteWheel`(폴링), `openEmoteWheel()` / `moveEmoteWheel(x,y)` / `closeEmoteWheel(pick)` / `setEmoteWheelTap(on)`(테스트·봇·터치용).

### 플레이어 (`engine/player.js`)
- `player.startEmote(id|code)`
  - 성공하면 `{ ok:true, id, code }`를 돌려준다.
  - 실패하면 `{ ok:false, reason }`을 돌려준다. reason: `'dead'` · `'air'` · `'crouch'` · `'moving'`(이동키 또는 수평 속도 > 0.5 m/s) · `'unknown'`.
  - core player가 `input:emotePick`을 받아 스스로 부른다. `player.autoEmote = false`로 끌 수 있다.
  - 실패하면 bus `player:emote-denied { id, code, reason }`를 낸다(`moving` → "멈춘 상태에서만 할 수 있어요").
- `player.cancelEmote(reason)`: World는 피해를 확정할 때 `'damage'`로 부른다.
- 자동 취소:
  - 이동키(`move`), 점프(`jump`), 앉기(`crouch`), 좌·우클릭(`fire`·`aim`), R(`reload`)
  - 1~4·휠 무기 교체(`weapon`), B 다시 누름(`wheel`), 공중(`air`)
  - core `player.damage()`(`damage`), 죽음(`death`), 스폰(`spawn`)
- 한 번만 하는 이모트는 길이가 끝나면 `done`으로 끝난다.
- 상태:
  - `state.emote`: 번호, 0이면 없음.
  - `state.emoteId`, `state.emoteEndedAt`(ms), `player.emote`(정의), `player.emoteTime`(초).
  - `snapshot().emote`: 번호.
- 이벤트: bus `player:emote { id, code, active:true, loop, duration }` / `{ id, code, active:false, reason }`.
- **3인칭 카메라**:
  - 이모트 중에는 캐릭터 앞쪽 비스듬히 3 m에서(궤도각 0.6 rad, 높이각 0.18 rad) 가슴 높이를 본다.
  - 마우스로 궤도를 돈다. 몸 방향은 그대로다.
  - 벽에 묻히지 않게 레이로 당긴다(최소 0.6 m).
  - 들어가고 나올 때 0.15초 동안 전환한다.
  - `player.thirdPerson`(0..1), `player.viewMode`, bus `player:view { mode:'third'|'first' }`로 알 수 있다. 3인칭이면 뷰모델·크로스헤어를 숨긴다(core 임시 총·기본 HUD는 이미 숨김).
  - 3인칭 중에도 `player.getEye()`는 1인칭 눈 위치를 돌려준다.

### 아바타 (`engine/avatars.js` + `engine/emoteanim.js`)
- 평소 몸은 메시 4개 그대로다.
- **이모트 중일 때만** 관절 리그로 바꾼다.
  - 구성: 몸통(등에 멘 총 포함)·머리·위팔·아래팔·손(주먹/편 손/'L')·허벅지·정강이, 메시 12개.
  - 캐릭터 부품도 리그에 붙는다: 머리 장비는 머리, 조끼·등짐은 몸통, 어깨 보호대·완장은 위팔, 팔 보호대는 아래팔, 무릎·정강이 판은 정강이.
  - 평소 draw call은 늘지 않는다.
- 원격 액터:
  - `avatars.push(id, t, { …, emote: 번호 })` → 처음부터 재생한다(반복형은 계속).
  - 0이 되면 0.15초에 걸쳐 평소(총 든) 자세로 돌아온 뒤 평소 메시로 돌아간다.
  - 번호 대신 id 문자열도 받는다. 죽으면 리그를 바로 끈다.
- 히트박스(`getTargets`)는 이모트 중에도 서 있는 그대로다.
- 내 몸:
  - `avatars.setLocalBody(player.getBodyState())`로 그린다. core main.js가 매 프레임 부르므로 World가 할 일은 없다.
  - `{ visible, pos, yaw, team, name, emote, crouch, avatar }`를 받는다. 히트 대상·목록에는 들어가지 않는다. `avatar`(내 캐릭터)는 game World가 계정 장비로 채운다.
- 동작은 `emoteanim.js`에서 직접 설계한 절차적 키프레임이다.
  - 박자는 `bpm`을 따른다.
  - 손이 머리에 닿는 자세는 손목 목표 + 작은 IK로 구한다(오차 1.5 cm 이하).
  - 발은 자동으로 접지한다.
  - `sampleEmote(id|code, t)` → 포즈, `fk(pose)`, `TRACKS`, `emoteLength(id)`, `NEUTRAL`을 export한다. three를 쓰지 않아 node 테스트가 된다.

### 미리 준비 (첫 이모트·첫 등장 끊김 방지)
- `ctx.loadMap(id)`은 맵을 만든 뒤 다음 순서로 준비한다. 모두 로딩 화면 뒤에서 일어나서 화면에는 보이지 않는다.
  1. `avatars.prewarm(fn)`이 모든 캐릭터 × 두 팀의 평소 몸(앉은 다리 포함)과 이모트 리그 부품(손 모양 3종)을 장면에 잠깐 넣는다. 늦게 들어온 사람이 처음 보는 캐릭터여도 끊기지 않는다(재질은 하나라 셰이더는 그대로 한 벌).
  2. `compileAsync`로 셰이더를 컴파일한다.
  3. 프러스텀 컬링을 끈 채 1픽셀 가위(scissor)로 한 번 그린다. GPU 버퍼와 그리기 상태(그림자 패스 포함)가 이때 준비된다.
- 품질(그림자 켬·끔)이 바뀌면 bus `renderer:quality`를 받아 `avatars.compileWarm(three, camera)`로 셰이더만 다시 준비한다. 이 일은 `applyPendingQuality`가 부르는 안전한 때에 함께 치러진다.
- 측정(헤드리스 SwiftShader, 프레임 간격 기준):
  - 첫 이모트 프레임의 JS 시간: 원격 6.5–9.2 → 1.9–4.6 ms, 내 이모트 ~10 → 5–7 ms.
  - 첫 이모트 직후 프레임 간격은 평소와 같았다. 새 셰이더 프로그램은 생기지 않았다.
  - 맵 준비 약 1초 뒤에 오던 0.9–1.3초 멈춤은 대부분 사라졌다(3번 중 2번 없음, 1번 0.5초).

### World·UI·FX 연결 메모
- World:
  - 피해 확정 시 `player.cancelEmote('damage')`.
  - 원격 스냅샷의 `emote`를 `avatars.push`에 그대로 넣는다.
  - `getLocalState().emote` = `player.snapshot().emote`.
  - 3인칭(`player:view`)이면 뷰모델을 숨긴다.
  - World 자체의 `rmbDown` 경로는 이모트 중에 막는다.
- UI: 휠 props에 `input:emoteWheel`의 `selected`·`cursor`를 그대로 넣는다. 거절 토스트는 `player:emote-denied`를 쓴다.
- FX: 이모트 소리는 `EMOTES[i].bpm`(반복형)에 맞추면 동작과 박자가 맞는다.
