# SKALA 작전 — WORLD API (게임 화면 공용 무대)

> 파일: `js/game/world.js` · 싱글(연습장 `practice.js`)과 멀티(`session.js`)가 **같은 World**를 쓴다.
> World는 "그리고, 듣고, 쏘는" 쪽만 맡는다. **누가 맞았고 몇 점인지는 match(방장)가 정한다.**

## 0. 만들기 — 앱에 World는 하나다

```js
import { createWorld } from './game/world.js';
const world = await createWorld({ root, ui, settings, ctx });
```

| 옵션 | 설명 |
|---|---|
| `ctx` | core 플러그인 ctx(`install(ctx)`가 받는 것). core의 renderer·input·loop·player·avatars·loadMap을 그대로 쓴다. **생략하면 `game/index.js`가 등록해 둔 ctx를 쓴다** |
| `ui` | `createUI()` 결과. 앱에 하나뿐이다 — `game/index.js`가 만들어 넘긴다. 직접 `createUI`를 또 부르지 말 것 |
| `root`, `settings` | 생략 가능(`ctx.ui.root`, `ctx.settings`) |

- 렌더러·입력·루프는 core 것을 쓰고, World가 새로 만드는 것은 **오디오(fx/audio)·이펙트(fx/effects)·뷰모델·로컬 arsenal·수류탄 시스템·물리 소품(engine/props)**뿐이다.
- `createWorld`를 여러 번 불러도 **같은 World를 공유하는 핸들**을 돌려준다(뷰모델·오디오가 두 벌 생기지 않는다).
  핸들의 `dispose()`는 그 핸들로 건 `on()` 리스너만 떼고, 마지막 핸들이 닫힐 때 실제로 정리한다.
- `game/index.js`는 '🌐 멀티플레이'를 처음 누를 때 `createSession({ ctx, ui, world, settings, bus, playerName, setScreens: true })`로 **이미 만든 `ui`·`world`를 넘기고** `open()`한다.
  세션의 `exit`(로비 → 메뉴)에서 세션을 정리하고 core `menu`로 돌아간다. core 화면 `lobby`·`room`·`match`·`results`는 game/index.js가 얇게 등록해 두어
  세션이 `ctx.setScreen`을 부르면 상태가 따라간다(`match`에서만 캔버스 클릭 → 포인터 잠금 → 조작).

## 1. 메서드

| 메서드 | 설명 |
|---|---|
| `await loadMap(mapId, { mode?, ruleset? })` → `{ spawns, mapName, mapId, map, data, fallback, ruleset }` | core `ctx.loadMap` + 수류탄 시스템 + 물리 소품 + HUD 표시 + 3D 렌더 켜기. `spawns`는 빌더 결과(`{owner:[{x,y,z,rotY}], charterer:[…], ffa?:[…]}`, y 자동). `mode` 기본 `'team'`, `ruleset` 기본 `'classic'`. 불러오는 동안 `unloadMap`이나 새 `loadMap`이 불렸으면 아무것도 켜지 않고 `null`을 돌려준다 |
| `unloadMap()` | HUD·스코프 숨김, 액터·수류탄·소품·이펙트 정리, 포인터 잠금 해제, 렌더 끄기, core 맵 해제, 모드·규칙을 기본값으로. 화면 `exit`에서 부른다 |
| `setRuleset(id)` → id | `'classic'`·`'knife'`·`'sniper'`. 쓸 수 있는 슬롯(`arsenal.setAllowedSlots`)과 무기를 맞춘다. `loadMap(mapId, { ruleset })`도 같다. 지금 값은 `world.ruleset`. 모르는 값은 클래식 |
| `reset()` | 라운드 전환용: 수류탄·이펙트·탄흔·예약 소리·관전 정리, HUD 킬피드·중앙 메시지 비우기. **액터는 남는다** |
| `spawnLocal({ id?, name?, team, spawn:{x,z,rotY,y?}, loadout?, protectMs? })` | 로컬 플레이어 부활(체력 100, 탄약 채움, 허용된 첫 슬롯 꺼내기). `loadout`은 **규칙의 `pickSlot` 무기 id**다(클래식·스나전은 주무기, 칼전은 칼). 없거나 이 규칙에서 못 고르면 직전 선택 → 계정 장비 → 규칙 기본값 순서다. 나머지 슬롯은 `ctx.account.loadout`, 없으면 `DEFAULT_LOADOUT` |
| `addDrop({ id, weaponId, pos, mag, reserve })` | 다른 사람이 버린 주무기를 바닥에 놓는다. 이 규칙에서 못 쓰는 총이나 깨진 값이면 `null` |
| `removeDrop(id)` | 바닥의 총을 지운다(누가 주웠다). 라운드 전환과 맵 정리 때는 World가 알아서 비운다 |
| `setLocalLoadout(id)` → bool | 무기 하나를 슬롯에 넣는다(주무기·보조·칼 모두. live 시작 때 `phase.loadouts[myId]` 확정값 반영). 이 규칙에서 못 쓰는 무기는 `false`이고 아무 일도 없다. `pickSlot` 무기면 다음 스폰의 기본값으로도 기억한다 |
| `setLocalHp(hp)` | 체력 표시·상태 갱신(방장 확정값). 줄면 화면이 살짝 흔들린다. 0이어도 죽이지는 않는다 → `killLocal` |
| `killLocal(info?)` | 쓰러지는 카메라 → 1.6초 뒤 같은 팀 생존 액터 3인칭 관전(좌클릭으로 대상 바꾸기). `info = { killerId?, dir?:[x,z] }`. `localDeath` 발생 |
| `addActor({ id, name, team, kind:'remote'\|'bot', avatar? })` / `removeActor(id)` / `clearActors()` | 원격 플레이어·봇 아바타. `avatar` = 캐릭터 id(`core/avatar-defs.js`, 모르는 값은 기본 캐릭터). `setActorState(id, { avatar })`로 바꿔도 된다 |
| `setActorState(id, state)` | 매 프레임(또는 틱) **보간이 끝난 상태를 그대로** 그린다(World는 다시 보간하지 않는다 → avatars 지연 0). `state = { pos:[x,y,z], yaw, pitch, alive, moving?, walking?, onGround?, hp?, slot?, weaponId? }`. `slot`·`weaponId`는 아바타의 든 무기 표시로 간다(슬롯 3이면 칼 모형). 안 주면 마지막으로 안 값(`actorFire` 포함)을 쓴다. 죽어 있던 액터가 `alive:true`로 오면 그 자리로 순간이동하며 일어선다. 걷는 액터는 3D 발소리가 난다(Shift 걷기는 조용) |
| `actorFire({ id, weaponId, origin, dir, hitPoint?, hitKind?, victimId?, normal?, mat?, kind? })` | 원격 사격 연출: FX 섬광·예광탄·탄착·3D 총성(`def.sound`, `def.fxKind`). `hitKind:'player'`면 피격 퍼프(내가 맞은 경우는 생략). `normal/mat`이 없으면 탄착점에서 월드 레이로 찾는다. 산탄은 예광탄을 몇 줄 더 그린다(연출 전용). 칼은 어떤 칼이든 휘두르는 소리만(`kind:'stab'`이면 `heavySound`) |
| `actorGrenade({ id, pos, vel, fuse?, t?, grenadeId? })` | 결정론 수류탄(1/120 고정 스텝)을 같은 초기값으로 시뮬레이션하고 바운스 소리·폭발 연출. `t`(ms, `performance.now()` 기준)가 과거면 그만큼 앞당겨 진행 |
| `actorDeath(id, info?)` | 아바타 쓰러짐. `info.dir = [x,z]`(총알 방향) |
| `feedbackDamage({ attackerPos?, amount, head?, kill?, half?, incoming? })` | `attackerPos`가 있거나 `incoming:true`면 **내가 맞음** → 피격 방향 호. 아니면 **내가 맞힘** → `hud.hitmarker(head, kill, { half })`. `half`(match의 `halfShot`, 그 이름으로 줘도 된다)면 `hud.callout('반샷! −50', 'half')`와 소리 `half_shot`(`hit_marker` 대신, 2D). `head`면 `hud.callout('헤드샷!', 'head')`. 킬이면 `kill` 소리 |
| `noteKill({ killer, victim, killerTeam?, victimTeam? })` → 이어진 킬 수 | 경기의 `kill` 이벤트마다 부른다(연습장·멀티 모두). **내가 살아서 적을 처치했을 때만** 연속 킬을 센다(자폭·같은 편·죽은 뒤의 킬은 0). 앞 킬과 5초 안이면 이어지고(`game/multikill.js`, 시계는 World 시뮬레이션 시각), 2킬부터 `hud.multiKill({ id, title, sub })`(그림·글자), 효과음 `multi_kill`(단계마다 `rate` +0.06, 7킬부터 `legend_kill`), 안내 음성 `audio.voice(id)`를 낸다. 내가 죽거나(`killLocal`) 판이 바뀌면(`reset`·`loadMap`·`unloadMap`) 1부터 다시 센다. `multiKillCount`는 마지막 킬까지 이어진 수 |
| `setRound({ phase, round, score, timeLeftMs, alive, teamSize, roundsToWin?, maxRounds? })` | HUD 타이머·스코어·생존자. 타이머는 다음 호출까지 로컬로 줄인다(`setPaused(true)` 동안만 멈춤 — 멀티는 일시정지 화면이 떠도 흐른다). `phase`가 `loadout`·`matchEnd`면 이동·사격을 막는다 |
| `setControlsEnabled(bool)` | 이동·사격·무기 교체 허용(시점은 잠금 상태를 따름) |
| `setPaused(bool)` | 수류탄·예약 소리 시뮬레이션 정지(연습장 일시정지용. 멀티는 쓰지 않는다) |
| `setPauseOptions({ leaveLabel, note })` | 일시정지 화면 문구 |
| `setScoreboard(provider)` | Tab을 누르면 `provider()`의 결과로 `ui.show('scoreboard', …)`(열려 있는 동안 0.5초마다 갱신) |
| `setHint(text)` | HUD 하단 안내(잠금 안내가 우선) |
| `openSwap({ seconds, weapons, ruleset, selected, round, title? })` | 라운드 시작 전 대기 시간의 무기 교체를 켠다(MODES.md 7절). HUD에 "N 을 눌러 무기 교체!"가 뜨고, N(`input:loadout`, 휴대폰은 그 안내)으로 무기 목록(`ui 'loadout'`의 swap 모드)을 여닫는다. 무기를 누르면 `setLocalLoadout` + `loadoutPick` 이벤트. `seconds`(World 시각, 연습장 일시정지 중에는 멈춘다) 뒤에 저절로 꺼진다 |
| `closeSwap()` | 무기 교체를 끈다(라운드 시작·라운드 끝). 열려 있던 목록도 닫는다. `reset`·`unloadMap`도 끈다 |
| `setMoverClock(fn \| null)` | 움직이는 지형이 쓸 시계(초를 돌려주는 함수). 멀티 세션이 방장 시계(`sync.hostNow() / 1000`)를 넘긴다. null이거나 숫자가 아니면 World 시각을 쓴다(MAP_GUIDE.md 11절) 문(가까이 오면 열리는 지형)이 볼 사람 목록은 World가 맵을 불러올 때 스스로 넣는다(`map.setMoverBodies`): 스폰해서 살아 있는 나와 화면에 보이는 다른 사람·봇. |
| `sound(name, opts?)` | `audio.play` 그대로(`round_start` 등) |
| `getLocalState()` → `{ ...player.snapshot(), vel, name, slot, weaponId, weapon:{w,s,z}, kills, deaths }` | sync 전송용(새 객체) |
| `getActor(id)` / `getActors()` | `{ id, name, team, kind, alive, state }` |
| `getMap()` | core 맵(`buildMap` 결과) 또는 null |
| `on(evt, fn)` → `off` | 아래 이벤트 |
| `dispose()` | 핸들 닫기(0절) |

## 2. 이벤트 (`world.on`)

| evt | payload | 언제 |
|---|---|---|
| `fire` | `{ id, weaponId, origin:[x,y,z], dir:[x,y,z], hitPoint:[x,y,z]\|null, hitKind:'player'\|'world'\|'none', victimId?, part?, dist, normal?, mat?, t, quickscope, noscope, spread(°), shotId, pellets }` | 로컬 플레이어가 쏠 때 한 번(산탄도 한 번). 방향·명중은 사람을 맞힌 첫 펠릿, 없으면 첫 펠릿이다. 칼 휘두르기는 든 칼의 `weaponId`에 `kind`, `hitKind:'none'` — 원격에 `actorFire`로 재생 |
| `hitClaim` | `{ victimId, part, weaponId, dist, kind, t, point, origin, count, shotId }` | 로컬 판정에 액터가 맞았을 때 **맞은 사람마다 한 번**. `kind`: 총 `'shot'`, 칼 `'slash'`·`'stab'`. `part`: `head`·`body`·`legs`·`hand`·`foot`. 산탄은 그 사람에게 맞은 펠릿 중 가장 좋은 부위(머리 > 몸 > 다리 > 손 > 발). `count` = 맞은 펠릿 수. 같은 발의 주장은 `t`와 `shotId`가 같다. `t` = `performance.now()` ms. **데미지는 match가 확정** → `match.claimHit({ attackerId: myId, ...payload })` |
| `weaponDrop` | `{ dropId, weaponId, pos, mag, reserve }` | 살아 있을 때 G로 손에 든 총을 버렸거나, 총을 든 채 죽었다. `reserve`가 `Infinity`면 프리미엄 총이다 |
| `weaponPick` | `{ dropId, weaponId }` | 주무기 탄약이 다 떨어져 닿은 총을 주웠다. 총은 이미 슬롯 1에 들어갔다 |
| `grenade` | `{ id, grenadeId, pos:[x,y,z], vel:[x,y,z], fuse, t, kind }` | 로컬 투척 직후 — 원격은 `actorGrenade(payload)`로 같은 궤적 재생 |
| `explosion` | `{ ownerId, local, grenadeId, center:{x,y,z}, victims:[{ id, dmg, dist }] }` | **모든** 수류탄 폭발(엄폐·거리 감쇠 끝난 값, 로컬 플레이어 포함). 멀티는 `local:true`만 `match.claimExplosion({ attackerId: ownerId, center, victims })`, 연습장은 전부 |
| `localDeath` | `{ id, info }` | `killLocal` 직후 |
| `multiKill` | `{ count, id }` | `noteKill`이 연속 킬(2킬 이상)을 띄웠을 때. `id`는 `double`~`hexa`, 7킬부터 `legend` |
| `loadoutPick` | `{ id, auto }` | UI 로드아웃에서 골랐을 때(World가 arsenal에 먼저 반영하고, `auto:false`면 같은 클릭 안에서 포인터 잠금) |
| `pause` | `{ paused }` | Esc로 일시정지 화면이 열리고 닫힐 때 |
| `leave` | `{}` | 일시정지 화면의 [나가기] |

## 3. World가 알아서 하는 것

- **입력 → 무기**: core input(좌클릭·우클릭·R·1~4·휠) → `arsenal.update`(고정 틱) → 뷰모델·소리·판정. `ui.needsCursor()`가 true이거나 잠금이 풀리면 무시한다.
  - 줌 FOV(`arsenal.getZoom`) → `renderer.setFov`, 감도 `input.setLookScale(줌FOV/기본FOV × zoomSensitivity)`, 스코프·조준 배율 `ui.scope.set(scopeAmount, { mag, level, levels })`. 2단 줌도 같은 경로다.
  - 반동은 `arsenal.getRecoilKick()`을 카메라에만 더한다(view punch). 화면 흔들림은 `fx.setApplyShake(false)` + `fx.getShake()`를 같은 곳에서 더한다(core player 흔들림과 한쪽 경로).
  - 이동속도 `player.setSpeedScale(arsenal.getMoveMul())`.
  - 사격: `ev.pellets`를 모두 트레이스한다. 예광탄은 3줄까지, 탄착과 판정은 펠릿 전부. 소리·이펙트는 `def.sound`, `def.fxKind`.
  - 칼: 판정 순간(`melee` 이벤트) 눈 앞 사거리(`ev.range`)·원뿔(`ev.arc`) 안 + 시선이 통하는 가장 가까운 액터. 무기는 `ev.weaponId`, 휘두를 때 `def.sound`(강타·찌르기는 `def.heavySound`), 맞으면 `def.hitSound`와 `fx.slashSpark`.
  - F 키(`input:inspect`): 조작할 수 있을 때 `vm.play({ type: 'inspect' })`. 재장전·교체·줌 중이면 뷰모델이 무시한다.
  - 1인칭 섬광은 뷰모델 것만, 원격 섬광은 `fx.muzzleFlash`.
- **규칙**: `setRuleset` → `arsenal.setAllowedSlots(rulesetOf(id).slots)`. 칼전은 뷰모델이 처음부터 칼이고 1·2·4번 키는 아무 일도 하지 않는다. 스나전의 주무기는 항상 저격총이다. `loadout:pick`은 `setLocalLoadout`과 같은 규칙으로 거른다.
- **이동 연출**: core player가 발판·포털·비밀 스팟을 판정한다(스폰할 때 상태도 거기서 비운다). World는 연출과 보상을 맡는다.
  - `player:pad` → 소리 `pad_boost`, `fx.padBurst`. `player:portal` → 소리 `portal`, 양쪽 끝에 `fx.portalFlash`.
  - `player:secret` → `ctx.account.findSecret(mapId, secret)`. 처음이면 `hud.banner({ icon:'🏆', title:'비밀 스팟 발견', sub:'이름 · +100 P' })`, 소리 `secret_found`, `fx.secretSparkle`. 이미 찾은 곳은 짧은 `hud.callout`만.
  - `player:land`에 `hopped`가 있으면 작은 `bhop_land`, 아니면 재질별 발소리.
  - 매 프레임 `hud.set({ speed })`와 `fx.setSpeedAmount((speed − WALK) / (MAX_SPEED − WALK))`.
- **물리 소품**: `engine/props.js`. 표시 전용이다. 맵 로드 때 `load`, 매 프레임 `update`(일시정지 중 멈춤), 수류탄 폭발 때 `explode`, 내 사격의 펠릿마다 `bulletHit`, 맵 해제 때 `clear`. cannon-es를 못 불러오면 고정 소품으로 남는다.
- **3인칭 내 몸**: core가 매 프레임 넘기는 `player.getBodyState()`에 `slot`·`weaponId`를 덧붙인다(이모트 때 `avatars.setLocalBody`가 받는다).
- **HUD**: 체력·탄약·슬롯·크로스헤어(탄퍼짐)·무기 이름·타이머·스코어·생존자·관전 이름·잠금 안내(`클릭해서 시작`). Tab 점수판, 히트마커·피격 방향.
- **포인터 잠금**: `ui needCursor` → 잠금 해제, 로드아웃 클릭·`pause:resume` → 그 클릭 안에서 다시 잠금. Esc로 풀리면 일시정지 화면.
- **오디오**: 첫 클릭/키에서 unlock, `settings.volume` 반영, 리스너 = 카메라(눈) 위치·각도.

## 4. 연결 예 (멀티 세션)

```js
const off = [
  world.on('fire', (e) => sync.sendFire(e)),
  world.on('hitClaim', (c) => isHost ? apply(match.claimHit({ attackerId: myId, ...c })) : sync.sendHitClaim(c)),   // count·shotId까지 그대로 넘긴다
  world.on('grenade', (g) => sync.sendGrenade(g)),
  world.on('explosion', (x) => { if (x.local) claimOrSend({ attackerId: myId, center: x.center, victims: x.victims }); }),
];
await world.loadMap(mapId, { mode, ruleset });
// roundStart: world.reset(); world.spawnLocal({ id: myId, name, team, spawn: ev.spawns[myId], loadout });   // loadout = 규칙의 pickSlot 무기
// 매 프레임: for (const r of remotes) world.setActorState(r.id, interp.sample(now));
// 원격 이벤트: world.actorFire(msg) · world.actorGrenade(msg) · world.actorDeath(id, { dir })
// match damage: victim === myId → world.setLocalHp(ev.hp); world.feedbackDamage({ attackerPos, amount: ev.amount })
//               attacker === myId → world.feedbackDamage({ amount: ev.amount, head: ev.head, half: ev.halfShot, kill: ev.hp === 0 })
// match kill: world.noteKill(ev)(연속 킬, 내 킬만 센다); victim === myId → world.killLocal({ killerId: ev.killer }); 그 밖 → world.actorDeath(ev.victim)
// 화면 exit: world.unloadMap();
```

## 5. 계약에서 달라진 점 (브리프 대비)

- `createWorld`에 `ctx` 옵션 추가(생략 가능 — game/index.js가 `setWorldContext(ctx)`로 등록). 여러 번 불러도 같은 World의 핸들.
- 이벤트 `explosion`·`leave` 추가(수류탄 피해 주장, 일시정지 [나가기]).
- 메서드 추가: `setLocalLoadout`, `unloadMap`, `clearActors`, `setPaused`, `setPauseOptions`, `setScoreboard`, `setHint`, `sound`, `getActor(s)`, `getMap`.
- `setActorState`에 `teleport:true`(보간 없이 순간이동), `actorFire`에 `hitKind`·`victimId`·`normal`·`mat`(선택).
- `feedbackDamage`는 `incoming`으로 방향을 명시할 수 있다(없으면 `attackerPos` 유무로 판단).
- `hitClaim.t`는 `performance.now()` ms.

## 6. 개인전(FFA) · 앉기 (2차 확장, MODES.md 3.4)

| 메서드 / 필드 | 설명 |
|---|---|
| `setMode('team'\|'ffa')` / `loadMap(mapId, { mode })` | `unloadMap`과 `mode` 없는 `loadMap`은 `'team'`으로 되돌린다. FFA: 다른 모든 액터가 적(아바타 한 가지 적 색 = 레드 팀 빨강), 아군 이름표·아군 관전 없음(죽으면 쓰러진 시점 그대로 부활 대기). `world.mode`로 읽는다 |
| `spawnLocal({ id, name, team:null, spawn, loadout, protectMs })` | FFA 부활(처음 출격도 같다). 부활 대기 표시를 지우고 `protectMs` 동안 HUD `protect`(🛡 보호 중). **내가 `hitClaim`을 내거나 내 수류탄이 터지면(`explosion`, 피해 주장) 보호 표시가 바로 끝**(match 규칙과 같게) |
| `setRespawn({ inMs, killer?, weaponName? } \| null)` | 내 부활 대기 표시. World가 매 프레임 `hud.respawn = { seconds, killer, weaponName }`을 센다(살아 있으면 숨김). `spawnLocal`이 지운다 |
| `setQuickRespawn({ cost, ok } \| null)` | 개인전 즉시 부활(MODES.md 10절). 부활 대기 패널에 "[E] 즉시 부활 · cost P"(`hud.respawn.quick = { cost, ok, touch }`)를 띄우고 E(`input:use`)를 받는다. 휴대폰은 `touch:use { on, label: '부활' }`로 버튼을 보인다(죽은 동안 아래 가운데, 발사 버튼 자리는 피한다). `ok:false`(포인트 부족)면 안내만 바뀌고 E는 알림만. 부활까지 0.7초 넘게 남았을 때만 받는다. 이벤트 `quickRespawn { cost }`로 요청을 내보내고(1.5초 안에 다시 누른 것은 무시), 확정·결제는 부르는 쪽이 한다. `spawnLocal`·`loadMap`·`unloadMap`이 지운다 |
| `setProtect(ms \| true \| false)` | 내 보호 표시를 직접 켜고 끈다(스냅샷 `protect`를 따를 때) |
| `setActorProtect(id, ms \| true \| false)` | 다른 사람 보호 표시 — 이름표에 🛡(적은 이름 없이 🛡만, MODES.md 11절), 시간이 지나면 저절로 꺼짐. `setActorState(id, { protect: bool })`로 줘도 된다 |
| `setRound({ mode:'ffa', phase, timeLeftMs, kills, rank, total, leaderName, leaderKills, target })` | FFA HUD 점수(평평한 필드 또는 `score:{...}`, 일부만 줘도 이전 값 유지) → `hud.score = { mode:'ffa', ... }`, `roundTime` = 경기 남은 시간. FFA에선 `alive`·`teamSize`를 쓰지 않는다 |
| `setActorState(id, { crouch })` | 앉은 자세(core 아바타) + **앉은 히트박스**로 판정(`getTargets()`의 대상에 `crouch:true` — core가 안 실으면 World가 채움) + 원격 발소리 작게(1.6 m마다, Shift 걷기는 무음) |
| `getLocalState().crouch` | 내 앉기 상태(sync → `FLAG.crouch`) |

- **HUD는 World가 매 프레임 그린다**: `score`·`roundTime`·`respawn`·`protect`·`hint`·`spectate`를 `ui.hud.set`으로 직접 넣으면 다음 프레임에 덮인다 → 위 API로 넘길 것. (킬피드·`hud.center`·로드아웃·결과 화면은 호출하는 쪽이 띄운다.)
- **부활 대기 로드아웃**: `ui.show('loadout', { compact:true, ... })`는 호출하는 쪽. World의 `loadout:pick` 처리 = `setLocalLoadout`(죽어 있어도 안전) + `auto:false`면 같은 클릭 안에서 포인터 잠금 → 다음 `spawnLocal({ loadout })`이 확정.
- **앉기(내 것)**: World가 `player.state.crouch`를 arsenal `motion.crouch`로 넘겨 탄퍼짐 ×0.8(크로스헤어 포함), 내 발소리 작게. 키·키 높이·속도·일어서기는 core.
- 연습장 FFA는 `practice.js`가 같은 API로 연결한다(봇 1~7, match `spawn` 이벤트 → `spawnLocal`/`setActorState({ teleport })`+`setActorProtect`).

## 7. 이모트 (3차 확장, MODES.md 4절)

목록·B 휠 입력·시작/취소 판정·3인칭 카메라·아바타 리그는 **core**, 휠 화면·`hud.emote`는 **UI**, 소리는 **fx**가 만든다. World는 이들을 잇는다.

| 항목 | World가 하는 일 |
|---|---|
| 휠 | core `input:emoteWheel {open, cursor, selected}` → `ui.show/update/hide('emotes', { items, selected, cursor })`. 시작은 core가 `input:emotePick`으로 직접 한다 |
| 거절 | core `player:emote-denied {reason}` → 'moving'·'air'·'crouch'면 `hud.center('멈춘 상태에서만 할 수 있어요')` |
| 이모트 중(내 것) | `player.state.emote`(번호) / `player.thirdPerson`(0..1)을 보고 뷰모델·크로스헤어·스코프를 숨기고 기본 FOV, 사격·줌 입력 무시(휠이 열린 동안도), `hud.emote = { id, name, icon, loop }`. 끝나면 1인칭으로 돌아오고 0.15초 동안 클릭이 사격이 되지 않는다 |
| 취소 | 피해(`setLocalHp`가 줄어들 때) → `player.cancelEmote('damage')`. 죽음·스폰도 World가 한 번 더 취소를 부른다(이동·점프·앉기·클릭·R·무기 교체·B는 core가 취소) |
| 소리 | 내 이모트 = 2D, 원격 = 3D(작게). 시작할 때 재생, 끝나거나 취소되면 정지(fx `audio.emote(code, { pos? })` 핸들 — 원격은 매 프레임 `setPos`, 끝나면 `stop(150)`) |
| 전송 | `getLocalState().emote` = 번호(0 = 없음) → protocol 상태 플래그 6~9번 비트. 원격은 `setActorState(id, { emote })`(번호 또는 id) → core 아바타 리그 재생 + 3D 소리. 히트박스는 서 있는 그대로 |

추가 메서드(시험·도구용): `world.startEmote(id)`, `world.cancelEmote(reason)`, `world.emotes`(목록 사본), `world.localEmote`(지금 번호), `world.emoteWheelOpen`.

연습장 봇: 팀전에서 라운드를 이기거나 개인전에서 킬을 하면 30% 확률로 2~3초 무작위 이모트(`setActorState({ emote })`). 그동안 멈춰 있고, 적이 보이거나(두뇌의 표적) 피해를 받거나 죽으면 바로 취소한다.

## 8. 폭파 미션 (4차 확장, MODES.md 5절)
화면 연출은 `game/bombview.js`가 맡고 World가 잇는다. 판정은 방장의 match가 한다.

| 메서드 / 이벤트 | 설명 |
|---|---|
| `setMode('bomb')` / `loadMap(mapId, { mode: 'bomb' })` | 팀전 화면 + 폭탄 HUD·모형. `world.mode === 'bomb'` |
| `loadMap(...)` 결과 `mission` | 맵의 미션 칸을 정규화하고 진영 스폰 높이를 채운 값(`mission.placeMission`). 미션이 없는 맵은 `null`. `createMatch({ mission })`에 그대로 넘긴다 |
| `setBomb(info \| null)` | 방장 상태. `info = { ...view.bomb, attack, phase, plantMs?, defuseMs?, carrierName?, actorName? }`(시간은 화면 시간 ms). 받은 시각부터 로컬로 줄여 타이머·진행 막대를 그린다 |
| `bombEvent(ev)` | 폭탄 이벤트 하나(`match` `bomb` 이벤트 + `name`). 소리·안내·폭발 연출 |
| `setRound({ mode: 'bomb', attack })` | 상단 점수에 공격·수비 표시(`hud.score.attack`) |
| 이벤트 `bombAction` | `{ act: 'plant' \| 'defuse' \| 'cancel', reason? }` — 내 E 키(휴대폰 설치/해체 버튼) 의도. 멀티는 `sync.sendBomb(act, reason)`, 연습장은 `match.bombIntent(myId, act, { reason })` |
| `bomb` / `bombPending` (getter) | 마지막 상태 / 보내고 확인을 기다리는 내 의도(시험용) |
| `floorAt(x, fromY, z)` | 맵 충돌의 바닥 높이(`physics.getGroundY`, fromY 아래 가장 높은 윗면). 맵이 없으면 `null`. 방장 세션이 `createMatch({ floorAt })`로 넘겨 떨어진 폭탄을 바닥에 놓는다 |

- **E 키**: core `input:use { down }`. 구역 안에서 폭탄을 들었거나(공격) 설치된 폭탄 1.5 m 안이고(수비), 땅 위에서 멈춰 있으면(0.5 m/s 미만) 시작을 보낸다.
  누르고 있는 동안 0.6 m 넘게 움직이거나(1.2 m/s 넘게), 쏘거나(사격·칼·투척), 손을 떼면 취소를 보낸다. 방장이 1.5초 안에 확인하지 않으면(거절) 접는다. 다시 하려면 다시 누른다.
- **휴대폰**: 할 수 있을 때 `bus.emit('touch:use', { on, label: '설치' | '해체' })` → engine/touch.js가 버튼을 보이고 숨긴다.
- **HUD**: 매 프레임 `hud.set({ bomb })`(ui/README의 bomb 칸): 진영, 목표, 상태, 폭발 타이머, 진행 막대, 안내, 구역 표시(3D → 화면 투영, 화면 밖이면 가장자리), 💣 소지.
- **모형**: 설치·떨어진 폭탄을 바닥에 그린다. 설치되면 삐 소리(`beepInterval`)에 맞춰 빨간 불이 깜박인다. 떨어진 폭탄은 공격 팀에게만 주황 고리.
- **이름표**: 폭탄을 든 아군 이름 앞에 💣(내가 공격 팀일 때만). `avatars.add(id, { name, badge: '💣' })`로 상태 표시만 따로 넘긴다(적의 이름표는 이름 없이 상태 표시만, engine/nametag.js).
- **소리**: `bomb_beep`, `bomb_key`(설치 중), `bomb_armed`, `bomb_defuse`(해체 중), `bomb_defused`, `bomb_pickup`, `bomb_explode`(fx/audio.js, 합성). 폭발 연출은 `fx.explosion`을 크게 두 번.
