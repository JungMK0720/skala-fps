# SKALA 작전 — SESSION API (멀티플레이 세션)

> 파일: `js/game/session.js` · 로비 → 방(대기실) → 경기 → 결과까지 이어지는 멀티플레이 진행을 맡는다.
> 모드: **팀전**(블루 vs 레드, 5판 3선승) · **개인전 FFA**(모두가 적, 목표 킬 · 부활) — MODES.md 3.5. FFA는 4절. · **폭파 미션**(공격·수비, A/B 구역 폭탄) — MODES.md 5절, 이 문서 9절.
> 규칙: **클래식 · 칼전 · 스나전**(`modes.js`). 모드와 직교한다. 방 메타 `ruleset`, 없으면 클래식 — 3절 "규칙".
> 기반: net(`../net`, README) · sync/interp/protocol(SYNC_API.md) · match(MATCH_API.md) · World(WORLD_API.md) · 계정(`../account`) · UI(`../ui/README.md`).

```js
import { createSession } from './game/session.js';

const mp = createSession({ ctx, ui, world, settings: ctx.settings, bus: ctx.bus });  // net을 생략하면 open() 때 직접 연결
await mp.open({ name: ctx.session.name });   // 로비 화면 + 방 목록 실시간 구독
mp.on('exit', () => {});                      // 로비 [← 메뉴] (ctx가 있으면 세션이 core 'menu'로 바꾼다)
mp.dispose();                                 // 로비 구독·방·sync 해제(직접 연결했으면 소켓도)
```

## 1. 연결 (game/index.js — 이미 연결돼 있음)

`js/game/index.js`의 `install(ctx)`가 '🌐 멀티플레이'를 처음 누를 때 이 모듈을 불러 세션을 하나 만들고, 누를 때마다 `open({ name })`을 부른다. main.js는 고칠 필요가 없다.

```js
// js/game/index.js (발췌)
const s = await import('./session.js').then((m) => m.createSession({ ctx, ui, world, settings: ctx.settings, bus }));
ui.on('menu:multi', () => s.open({ name: ctx.session.name }));
// plugin dispose → s.dispose()
```

- **core 화면**: `ctx`가 있으면 세션이 `lobby`·`room`·`match`·`results` 화면을 빈 핸들러로 등록하고 흐름에 맞춰 `ctx.setScreen()`을 부른다.
  main.js는 화면이 `match`(또는 `sandbox`)일 때만 캔버스 클릭 포인터 잠금과 입력을 켜기 때문이다. 로비 [← 메뉴]와 `dispose()`는 `menu`로 돌린다.
  다른 곳에서 이 네 화면을 등록하지 말 것(`setScreens: false`로 끌 수 있다).
- **프레임**: `ctx.onFrame(fn, -60)`(core avatars.update(-50)보다 먼저)에서 원격 보간 상태를 `world.setActorState`로 넣는다. `ctx`가 없으면 rAF, node에서는 33ms 타이머를 쓴다.
- **연결**: `net`을 주지 않으면 `../net/index.js`의 `connect({ playerId: 'p' + 무작위 11자, name })`로 처음 `open()` 때 연결한다(`window.SKALA_CONFIG`). 탭마다 새 id라 같은 브라우저 두 탭도 서로 다른 플레이어다.
- **서버 설정이 없을 때**: `ctx.account.remoteEnabled`가 false면 연결을 시도하지 않고 로비에 "멀티플레이 서버 설정이 없어요."를 보여 준다. `open()`은 어떤 연결 실패에도 던지지 않는다. 방 만들기·참가를 눌러도 같은 사유를 다시 보여 준다.
- **닉네임**: 표시 이름은 계정 닉네임이다(`ctx.account.profile.nickname`). 게이트 전처럼 닉네임이 없을 때만 `open({ name })`, `playerName`을 쓴다. `open()`은 `ctx.account.retryNickname()`을 부르고 **기다리지 않는다**. 닉네임이 바뀌면 `bus 'account:change'`로 알고 `room.updateMe({ name })`를 부른다.
- `?debug=1`이면 `window.__skalafpsSession`으로 세션을 노출한다(`.state`, `.view`, `.sync.stats()`).

## 2. `createSession(options)`

| 옵션 | 기본 | 설명 |
|---|---|---|
| `world`, `ui` | (필수) | WORLD_API.md의 World 핸들, `createUI()` 결과 |
| `ctx` | | core ctx. `account`·`maps`·`onFrame`·`registerScreen`·`setScreen`·`session.name`·`flags.debug`를 쓴다 |
| `net` | 자동 연결 | 연결된 `Net`, `Promise<Net>`, `({ playerId, name }) => Promise<Net>`, 또는 `connect`가 있는 모듈 |
| `playerName` | 계정 닉네임 → 이 값 → `ui.getPlayerName()` → `ctx.session.name` | 24자. 닉네임이 없을 때만 `open({ name })`으로 바꿀 수 있다 |
| `bus` | `ctx.bus` | `account:change`를 듣는다(닉네임·장비 변경) |
| `settings` | | 받기만 한다(점수판 Tab은 World가 처리) |
| `maxPlayers` | **6** | 방 만들기 최대 인원(무료 플랜 한도 3:3). UI에서 온 `max`는 2..6으로 자른다 |
| `mapId` | `'jetty'` | 맵 id가 없을 때. 규칙에 안 맞으면 그 규칙의 첫 맵으로 바꾼다 |
| `rules` | | `match.js` rules 덮어쓰기(테스트: `{ loadoutMs: 2500, roundEndMs: 1500 }`). `maxPlayers`·`maxPerTeam`은 방 인원으로, `ruleset`은 방 메타로 정한다 |
| `ffaRules` | | FFA일 때만 더 얹는 rules(테스트: `{ killTarget: 5, respawnMs: 1200, spawnProtectMs: 400 }`). `mode:'ffa'`는 세션이 넣는다 |
| `bombRules` | | 폭파 미션일 때만 더 얹는 rules(테스트: `{ plantMs: 600, defuseMs: 800, fuseMs: 20000 }`). `mode:'bomb'`·`ruleset:'classic'`은 세션이 넣는다(9절) |
| `sendHz` | 10 | sync `rateHz`(실제 = min(10, room.rate)) |
| `hostTickMs` / `snapshotMs` | 100 / 1000 | 방장 경기 루프(setInterval — 백그라운드에서도 돈다) / 변화 없을 때 스냅샷 주기 |
| `prepTimeoutMs` | 8000 | 시작 전에 모두가 맵을 불러오기를 기다리는 최대 시간 |
| `leaveGraceMs` | 2000 | 경기 중 presence에서 사라진 사람을 퇴장 처리하기까지(순단 대비) |
| `loadoutLeadMs` | 700 | 로드아웃 화면 자동 선택을 방장 마감보다 먼저(선택이 제때 도착하게) |
| `stallMs` | 15000 | 경기 중 방장 소식이 이만큼 없으면 대기실로(자가 복구) |
| `setScreens` | true | core 화면 등록·전환 |
| `onFrame` | | `ctx.onFrame` 대신 쓸 프레임 훅 `(fn) → off` |
| `log` | | `(…args)` 디버그 추적(시작·이어받기·취소·워치독) |
| `syncOptions` | | `createSync` 옵션 덮어쓰기 |
| `now` | `performance.now` | 시계 함수(테스트) |

### 반환값
| 멤버 | 설명 |
|---|---|
| `open({ name }?) → Promise` | 로비를 띄우고 방 목록을 구독한다(처음이면 연결). 이미 방/경기 중이면 아무것도 안 한다 |
| `leave() → Promise` | 방에서 나가 로비로(경기 중이면 이번 경기에서 빠진다) |
| `dispose()` | 로비 구독·방(`room.leave`)·sync·타이머·화면 등록 해제. 직접 연결한 소켓은 닫는다 |
| `on(evt, fn) → off` / `off` | `'screen' { name, mapId? }`, `'exit'`, `'error' { where, error }`, `'closed'` |
| `phase` | `idle · connecting · lobby · joining · room · match · results · leaving · closed` |
| `state` | `{ phase, roomId, me, isHost, hostId, matchId, ruleset, pick, loaded, round, matchPhase, playing, alive, team, score, actors, chat, hosting }` (디버그·테스트) |
| `view` | 마지막으로 반영한 경기 상태(`applySnapshot` 모양) |
| `net`, `room`, `sync`, `me`, `isHost`, `match` | 내부 객체(`match`는 방장일 때 돌리는 match.js 또는 `restoreMatch` 객체) |
| `scoreboard()` | Tab 점수판 데이터(`world.setScoreboard`에 이미 연결) |
| `frame()` | 수동 프레임 구동 |

## 3. 흐름

### 로비
- `ui.show('lobby', { rooms, loading, error, joining, name })`, `net.lobby.subscribe`로 실시간 갱신한다. 방에 들어가면 구독을 끈다(presence 예산). 방 항목에 `mode`('team'|'ffa')와 `ruleset`이 실린다(net 로비 presence). 목록 배지는 "칼전 · 개인전"이고, 규칙이 없는 옛 항목은 클래식으로 읽는다.
- `lobby:create {name,mapId,max,mode,ruleset}` → `net.createRoom({ ..., mode, ruleset })`(max 2..6, mode·ruleset은 방 메타, 맵은 `maps.mapsForRuleset(ruleset)`에 있어야 하고 아니면 그 규칙의 첫 맵, 이름이 비면 "닉네임의 방"). `lobby:join {roomId}` → `net.joinRoom`. 실패하면 `error`에 한국어 사유(`ROOM_FULL` → "방이 가득 찼어요." 등).
- 연결 중에 누른 방 만들기·참가는 연결되면 실행한다.
- `lobby:refresh`는 다시 구독(연결 실패 상태면 다시 연결), `lobby:back`은 `'exit'` + core `menu`.

### 방(대기실)
- `ui.show('room', { roomId, name, mapId, mode, ruleset, max, teamMax, hostId, meId, players[{id,name,team,ready,ping,host,me}], chat })`. presence(`room.players()`)가 바뀔 때마다 다시 그린다.
- `room:mode {mode}` → 방장만 `updateMeta({ mode })`(대기실에서만). 모두에게 방 메타 → 대기실 다시 그림 + "개인전으로 바뀌었어요" 안내, 로비 목록도 바뀐다.
- `room:ruleset {ruleset}` → 방장만 `updateMeta({ ruleset, mapId })`(대기실에서만). 지금 맵을 그 규칙에서 못 쓰면 `maps.mapsForRuleset(ruleset)`의 첫 맵으로 같이 바꾼다. 모두에게 "규칙이 칼전으로 바뀌었어요" 안내.
- 들어오면 인원이 적은 팀으로 자동 배정한다. `room:team` → `room.updateMe({ team })`(팀 정원 = ceil(max/2)), `room:ready` → `updateMe({ ready })`, `room:map` → 방장만 `updateMeta({ mapId })`(규칙에 안 맞는 맵은 무시).
- **캐릭터**: 들어올 때 팀 배정과 같은 `updateMe`에 `av`(내 캐릭터 = `ctx.account.avatar`)를 싣는다. 장착을 바꾸면 `account:change`로 알고 값이 다를 때만 `updateMe({ av })`(presence 호출 한도). presence라 늦게 들어온 사람도 바로 안다.
  받는 쪽은 명단(`room.players()`의 `av`)을 `avatarIdOf`로 읽어(모르는 값·옛 클라이언트는 기본 캐릭터) `addActor`와 매 프레임 `setActorState`에 `avatar`로 넘긴다. 디버그 `state.avatars` = `{ id: 캐릭터 }`.
- 채팅: `sync.sendChat` → 받으면 목록에 넣는다. **내 메시지는 직접 넣는다**(broadcast는 되돌아오지 않음). 첫 줄은 늘 안내 문구 "무료 서버 한도 때문에 최대 6명(인원이 적을수록 더 부드러워요)"이고, 입장·퇴장·방장 교체·경기 결과도 시스템 줄로 남는다.
- 경기 채팅: 경기 맵을 불러오면 `ui.show('chat')`과 bus `chat:available { on:true }`(휴대폰 채팅 버튼), 경기를 정리하면 `ui.hide('chat')`과 `{ on:false }`.
  경기 중에는 대기실과 같은 줄을 `ui.chat.push(line)`으로도 넘긴다(내 줄은 `me:true`). Enter·채팅 버튼(bus `input:chat`)이면 `ui.chat.open()`, UI `chat:send`는 대기실 `room:chat`과 같은 `sendChat`이다.
  PC에서 입력칸이 열리면(`chat:open`) 엔진이 떼는 키를 못 보므로 `ctx.input.releaseAll()`로 눌려 있던 이동 키를 푼다.
- 채팅 도배(`CHAT_LIMIT`): 보내기는 5초에 4줄까지이고 넘으면 내 화면에만 안내 줄을 띄운다. 받기는 보낸 사람마다 5초에 6줄까지이고 넘는 줄은 조용히 버린다(고친 클라이언트 대비).
- [게임 시작](방장): UI와 같은 조건을 세션도 다시 확인한다. 팀전 = 양 팀 1명 이상·미배정 없음·방장 외 전원 준비, **FFA = 2명 이상·방장 외 전원 준비**(팀 무관, `room:team`은 무시).

### 시작(준비 단계)
1. 방장: 경기 id(`mid`) 생성 → `room.send('mx', { k:'prep', mid, map, mode, rs })` → 자기 맵 로드(`world.loadMap(map, { mode, ruleset })`).
2. 맵을 다 불러오면 `createMatch({ rules:{ ..., ruleset }, players(팀 있는 방 인원), spawns })` → 방 상태 `playing` → 준비 스냅샷(`prep:1`, warmup)을 1초마다 보낸다.
   상태를 맵 로드 **뒤에** 바꾸는 이유: net은 `playing`이면 방장 침묵 8초(대기 32초)로 방장을 교체한다. 맵 빌드·셰이더 컴파일로 메인 스레드가 오래 막히면(헤드리스·저사양) 멀쩡한 방장이 바뀐다.
3. 멤버: `prep` 알림 또는 준비 스냅샷을 받으면 경기에 들어가 맵을 불러오고 `room.sendTo(방장, 'mx', { k:'loaded', mid })`로 알린다(준비 스냅샷마다 다시 보냄).
4. 방장: 모두 불러왔거나 8초가 지나면 `match.start()` → `roundStart`(스폰) → `phase(loadout)`.
- 경기에 들어가면 각자 준비를 푼다(`ready:false`) → 결과 뒤 다시 준비해야 다음 경기를 시작할 수 있다.

### 경기
| 누가 | 하는 일 |
|---|---|
| 방장 | `match.tick(dt)`(100ms) → 이벤트가 있으면 즉시, 없으면 1초마다 `sync.sendMatch({ ...m.snapshot(), mid, map }, events)`. 같은 데이터를 자기에게도 같은 경로로 적용한다 |
| 방장 | sync `hitClaim` → `match.claimHit({ attackerId: from, victimId, weaponId, part, dist, kind, t: shotT, count, shotId })`. `count`가 빠지면 샷건이 펠릿 하나 피해만 준다 |
| 방장 | world `explosion`(로컬·원격 수류탄 **모두**, 방장 화면의 결정론 시뮬레이션·엄폐·감쇠 결과) → `match.claimExplosion({ attackerId: ownerId, center, victims })` |
| 방장 | sync `loadout`의 `pick`(loadout 페이즈) → `match.setLoadout`. 방 명단 변화 → `addPlayer`(늦게 온 사람 = 관전 후 다음 라운드) / 2초 유예 뒤 `removePlayer` |
| 모두 | world `fire` → `sync.sendFire`(칼 강타는 `kind:'stab'`), `hitClaim`(live·생존) → `sync.sendHitClaim`(`count`·`shotId` 포함, 방장이면 sync가 로컬로 돌려줌), `grenade` → `sync.sendGrenade` |
| 모두 | 라운드 시작·스폰·`account:change` → `sync.sendLoadout({ pick, primary, secondary, melee, round, m })`(같은 내용이면 보내지 않는다) |
| 모두 | sync `fire` → 아바타 렌더 시간축(`at`, 최대 0.3초)에 맞춰 `world.actorFire({ ..., weaponId, kind })`, `grenade` → `world.actorGrenade({ id, grenadeId: gid, pos, vel, t: localT })` |
| 모두 | 매 프레임 `sync.getRemote(id)` → `world.setActorState(id, { ...보간 상태, slot, weaponId, alive(방장 판정), hp, team, name, moving })`. `slot`은 상태 메시지, `weaponId`는 그 사람의 장비에서 찾는다(`weaponForSlot`, 아래 "규칙") |

경기 데이터(스냅샷+이벤트) 반영:
| 이벤트 | 화면·World |
|---|---|
| `roundStart` | `world.reset()` → 내가 참가자면 `world.spawnLocal({ id, name, team, spawn, loadout })`, 원격 아바타를 스폰 자리에 세움(새 상태가 닿을 때까지 최대 3초), 중앙 배너 "라운드 N"(무승부 재경기·매치 포인트 안내), `round_start` 소리 |
| `phase(loadout)` | `ui.show('loadout', { weapons: pickableWeapons(ruleset, 보유 무기), ruleset, seconds: 남은시간−0.7, selected: 지난 선택 또는 계정 장비, round })` |
| `phase(live)` | 로드아웃 닫기, `phase.loadouts[me]` → `world.setLocalLoadout`(칼전이면 칼), "작전 개시!" |
| `damage` | 내가 피해자 → `world.setLocalHp(hp)` + `world.feedbackDamage({ attackerPos, amount, head, half, kill, incoming:true })`(피격 방향). 내가 공격자 → `feedbackDamage({ amount, head, half: e.halfShot, kill, incoming:false })`(히트마커·반샷 표시) |
| `kill` | `ui.killfeed.push({ ..., head, half })`(자폭은 killer 없음), 내가 죽음 → `world.killLocal({ killerId, dir })`(World가 관전 카메라), 그 밖 → `world.actorDeath(id, { dir })`. 내 칼 킬은 `knifeKills`로 센다 |
| `roundEnd` | 배너 "블루 팀 승리 · 전멸 · 블루 1 : 0 레드", `round_win`/`round_lose` |
| `phase(matchEnd)` | 결과 화면(아래) |
| 스냅샷 | `world.setRound({ phase, round, score, timeLeftMs, alive, teamSize, roundsToWin, maxRounds, matchPoint })` — HUD 타이머·점수·생존자는 World가 그린다. 놓친 이벤트 보정: 새 라운드면 대체 스폰, 페이즈 전환, 내 사망·체력, 아바타 사망 |

- 스냅샷은 권위 상태다. 이벤트를 놓쳐도 다음 스냅샷(1초 안)으로 맞춘다. 맵을 불러오는 동안 온 데이터는 모았다가(이벤트 전부 + 최신 스냅샷) 다 불러온 뒤 적용한다.
- 늦게 들어온 사람: 방장 스냅샷을 받으면 경기에 들어와 관전(`setHint('관전 중 — 다음 라운드부터 참가해요')`)하다가 다음 `roundStart`에서 스폰된다.

### 규칙
| 규칙 | 고르는 칸 | 로드아웃 목록 | 기본값 | 쓸 수 있는 슬롯 |
|---|---|---|---|---|
| `classic` 클래식 | 주무기 | 보유한 주무기 전부 | 계정 장비 → `ar_std` | 1·2·3·4 |
| `knife` 칼전 | 칼 | 칼 4종 | 계정 장비 → `ml_knife` | 3 |
| `sniper` 스나전 | 주무기 | 보유한 저격총 | 계정 장비 → `sr_bolt` | 1·3 |

- 정본은 방장이다: `rules.ruleset`이 경기에 들어가고 스냅샷 `rs`로 모두에게 간다. 스냅샷의 규칙이 들어올 때 받은 값과 다르면 `world.setRuleset`으로 맞춘다.
- `modes.js`의 `pickableWeapons(ruleset, owned)`, `defaultPick(ruleset)`만 쓴다(`owned` = `ctx.account.profile.owned`). 미리 골라 둘 무기는 `preferredPick(ruleset, owned, equipped, last)`: 이 규칙에서 직전에 고른 것 → 계정 장비 → 규칙 기본값.
- 칼전에 총·수류탄 주장을 보내면 방장이 `reject 'ruleset'`으로 거절한다(`claimHit`·`claimExplosion`).
- **장비 메시지 `g2l`**: `gearMessage(ruleset, pick, equipped)` + `{ round, m }`. `pick`은 그 칸에 고른 무기, `primary`·`secondary`·`melee`는 다른 사람 화면에 그릴 장비다. 받는 쪽은 `readGear`로 `getDef`와 슬롯을 확인하고 틀린 값은 조용히 버린다. 최악 117B(예산 256B).
- **원격 무기 표시**: `weaponForSlot(gear, slot, ruleset, confirmed)` = 그 사람의 장비 → (고르는 칸이면) 방장이 확정한 선택 → 규칙 기본값 → 기본 장비. 사격 메시지의 무기가 오면 그 칸의 장비를 고친다. 칼은 어떤 칼이든 맞게 그려진다.

### 방장 이탈
- room `'host'`(isMe)를 받은 새 방장이 `sync.lastMatch()`의 스냅샷으로 **`restoreMatch()`** 를 만든다(5절). 점수·라운드 기록·개인 기록(반샷 포함)·규칙·고른 무기를 이어받고, 진행 중이던 라운드는 처음(loadout)부터 다시 한다. 다른 사람은 같은 `mid`의 새 `roundStart`(보낸 방장이 다름)로 재스폰한다.
- 이어받을 수 없을 때(준비 단계, 스냅샷 없음, 오류)는 취소 스냅샷(`abort:'host-left'`)을 보내 **"방장이 나가 경기가 종료됐어요."** 로 모두 대기실로 돌아간다.
- 이어받았는데 한 팀이 비면 `forfeit` 결과로 끝난다. 승부가 이미 난 라운드 종료 중이었다면 남은 시간 뒤 `matchEnd`.
- 경기 밖(대기실·결과)에서 방장이 되면 방 상태를 `waiting`으로 돌리고, 진행 중인 경기 스냅샷이 남아 있으면 취소를 알린다.
- **자가 복구(워치독, 1초)**: 멤버가 15초 동안 방장 경기 데이터를 못 받으면 "방장 응답이 없어 대기실로 돌아왔어요." / 방장인데 경기 객체가 없으면 이어받기, 맵 로드가 20초 넘게 걸리면 취소.

### 나가기 · 결과
- 내가 나감: `sync.dispose()`(남은 이벤트 송신) → `room.leave()` → 로비. 일시정지 [나가기](world `leave`), 대기실 [← 나가기], 결과 [로비로] 모두 같다.
- 결과: `standings(view)` → `ui.show('results', { winner, score, rounds[{round,winner,reason(한국어)}], players, mvp, myTeam, mapId, meId, ruleset, reward })`. 방장은 방 상태를 `waiting`으로 바꾼다.
  [방으로 돌아가기] → 대기실(warmup). 다음 경기는 다시 준비 → 시작(새 `mid`).
- **계정 기록**: 결과를 보여 줄 때 `ctx.account.recordMatch({ online:true, ruleset, mode, mapId, kills, deaths, headshots, halfShots, knifeKills, win, draw, seconds })`를 **경기(`mid`)당 한 번** 부르고 결과를 `reward`로 넘긴다. 킬·데스·헤드샷·반샷은 방장이 확정한 값이다. `knifeKills` = 내 킬 중 `getDef(weaponId).kind === 'melee'`인 수(킬 수를 넘지 못하게 자른다). `seconds`는 처음 출격부터 잰다.
  방장이 바뀌어도 `mid`가 그대로이고 값은 합산되어 있어 두 번 세지 않는다. 경기 중에 나간 사람, 취소된 경기, 한 번도 출격하지 않은 관전자는 기록하지 않는다.
- 경기 화면을 떠날 때 `world.unloadMap()`(액터·HUD·잠금 정리)을 부른다.

## 4. 개인전(FFA)

| 단계 | 세션이 하는 일 |
|---|---|
| 시작 | 방장: `createMatch({ rules:{ ...rules, ...ffaRules, mode:'ffa', ruleset }, players:[{id,name}], spawns, getPositions })`. `getPositions()` = `{ id: {x,z} }`(나는 `world.getLocalState()`, 원격은 sync 최신 상태, 살아 있는 사람만) → match가 다른 사람과 먼 곳에 스폰 |
| 맵 | `world.loadMap(mapId, { mode:'ffa', ruleset })` + 로드 뒤 `world.setMode('ffa')`(모든 액터가 적, 적 색 한 가지) |
| loadout | 처음 무기 선택(전체 화면, "개인전 · 무기 선택", 규칙의 무기 목록) |
| live · `spawn` | `{ id, spawn, loadout, protectMs }` — 나 → `world.spawnLocal({ id, name, team:null, spawn, loadout, protectMs })`(보호 🛡·부활 대기 지움), 남 → 액터를 그 자리로 순간이동 + `world.setActorProtect(id, ms)` |
| 죽음 | `world.killLocal` + `world.setRespawn({ inMs, killer, weaponName })`(World가 "💀 하늘에게 당했어요 · 3초 뒤 부활"을 셈) + `ui.show('loadout', { compact:true, ... })`(다음 출격 무기, 화면을 덮지 않음). 고르면 `setLoadout`(FFA는 live에도 허용, **다음 부활부터**). 스냅샷 `respawnIn`으로 남은 시간을 다시 맞춘다 |
| HUD | `world.setRound({ mode:'ffa', phase, timeLeftMs(경기 남은 시간), kills, rank, total, leaderName, leaderKills, target })` → "🎯 7킬 · 2위/5 · 1위 하늘 12 / 20". HUD는 World가 그린다(세션은 `ui.hud.set`으로 점수·부활·보호를 넣지 않는다) |
| 원격 보호 | 매 프레임 `setActorState(id, { ..., protect })`(스냅샷 `protect`) — 먼저 쏘면 바로 꺼짐 |
| 늦게 참가 | 방장이 명단에서 보고 바로 `addPlayer` → match가 죽은 상태로 넣고 `respawnMs` 뒤 `spawn`. 들어온 사람은 부활 대기 표시 + compact 로드아웃 |
| 킬피드 | `{ ..., killerTeam:null, victimTeam:null, mode:'ffa' }`(팀 색 없이 중립) |
| 끝 | `matchEnd { mode:'ffa', winner, reason:'kills'\|'time'\|'forfeit'\|'draw', ranking }` → `ui.show('results', { mode:'ffa', ranking:[{rank,id,name,kills,deaths,head,me,bot}], winnerId, winnerName, reason, target, mapId, ruleset, reward })`. 대기실 안내 "경기 종료 — 하늘 우승 (20킬) · 목표 킬 달성" |
| 점수판(Tab) | `{ mode:'ffa', players:[{id,name,rank,kills,deaths,headshots,ping,alive,me}], target }` |
| 놓친 이벤트 | 스냅샷과 1.5초 넘게 어긋나면 보정: 살아 있어야 하는데 안 나왔으면 아무 스폰 지점에 출격, 죽었어야 하면 `killLocal`. 원격도 사망·부활을 맞춘다 |

- **방장 이전**: `restoreFfaMatch()`(5절)로 킬·데스·헤드샷·반샷·피해와 남은 시간, 규칙, 고른 무기를 이어받고, 짧은 loadout(= respawnMs) 뒤 live 시작 `spawn`으로 **모두 다시 출격**한다. 다른 사람은 새 방장이 보낸 loadout(같은 경기 id)을 다시 시작으로 받는다.
  이어받을 때 나 혼자만 남았으면(match `start()`가 `need_players`로 거절) 나간 사람을 잠깐 넣었다가 바로 `removePlayer`해서 match가 `forfeit`(우승 = 나)으로 끝내게 한다.
- 경기 스냅샷에는 세션 키 `gm`('team'|'ffa')을 붙인다(늦게 들어온 사람·새 방장이 모드를 안다).

## 5. `restoreMatch({ snapshot, players, spawns, seed?, rng?, mission?, getPositions?, floorAt? })` · `restoreFfaMatch(...)`
`match.js`의 `createMatch`와 **같은 메서드·이벤트·스냅샷 형식**을 가진 객체를 돌려준다(`tick, start, addPlayer, removePlayer, setTeam, setLoadout, claimHit, claimExplosion, snapshot, dispose, state, rules, weaponRules`) + `restored: { rounds, score }`.
- 안쪽에서 새 `createMatch`(같은 규칙, 선승·라운드 상한 999)를 돌리고, 라운드 번호·점수·라운드 기록·개인 기록(킬·데스·헤드샷·피해·**반샷**)을 이전 스냅샷 값과 합친다. 고른 무기도 이어받는다. 승부(3선승·5판·9라운드 상한)는 합친 점수로 이 래퍼가 판정한다.
- 이어받기 전에 나간 사람의 기록은 스냅샷 예산(1800B) 안에서 접속 끊김 줄로 남는다(결과 화면에 나옴).
- 입력 스냅샷 페이즈: `loadout`/`live` → 그 라운드를 다시, `roundEnd`(승부 안 남) → 다음 라운드, `roundEnd`(승부 남) → 남은 시간 뒤 `matchEnd`, `matchEnd` → 끝난 상태 유지.

`restoreFfaMatch({ snapshot, players:[{id,name}], spawns, getPositions, seed?, rng? })` (FFA):
- `createMatch({ rules:{ ...이전 rules(규칙 포함), mode:'ffa', timeLimitMs: 남은 시간(최소 10초), loadoutMs: min(loadoutMs, respawnMs) }, players, spawns, getPositions, carry })`.
  `carry = { [id]: { name, kills, deaths, headshots, halfShots, damage, loadout } }`(이전 스냅샷의 모든 플레이어, 나간 사람 포함) — match.js가 기록을 그 값에서 시작한다.
- `ffaRanking(view)` → `[{ rank, id, name, kills, deaths, headshots, halfShots, bot, connected }]`: `standings(view).ranking`이 있으면 그것, 없으면 킬↓·데스↑·헤드샷↓(같으면 같은 순위).

## 6. 네트워크
- 게임 데이터는 모두 sync(g2s 상태·g2f 사격·g2h 히트·g2x 수류탄·g2m 경기·g2l 로드아웃·g2c 채팅·g2p 핑)로 간다. 세션이 더하는 것은 `'mx'` 제어 이벤트(시작 알림 `prep`, 맵 로드 완료 `loaded`)뿐이고, 둘 다 경기 시작 때 1회다.
- 경기 스냅샷에는 match.js 스냅샷(규칙 `rs` 포함)에 `mid`(경기 id)·`map`·`gm`(모드), 준비 중 `prep:1`, 취소 `abort`를 더한다(protocol 부가 영역 안).
- **경기 이벤트마다 `mid`를 붙이고 받는 쪽이 다른 경기의 이벤트를 버린다.** sync는 최근 3초 이벤트를 다음 스냅샷에도 다시 싣기 때문에, 경기가 끝나고 3초 안에 새 경기를 시작하면 지난 경기의 `matchEnd`가 새 경기 준비 스냅샷과 함께 가서 막 들어온 사람이 곧바로 결과 화면으로 튕겼다(재현 테스트 `rapid.mjs`로 확인 후 수정).
- 로드아웃은 `sync.sendLoadout({ pick, primary, secondary, melee, round, m: 경기 id })` — 라운드와 경기 id를 실어 다음 라운드·경기에서 같은 무기를 다시 골라도 전달된다(sync는 같은 내용을 거른다). 같은 라운드를 새 방장이 다시 시작하면 이 메시지가 걸러지므로 새 방장이 이미 받은 선택을 경기에 다시 넣는다.
- 송신 빈도는 sync가 정한다(상태 min(10, room.rate)Hz, 이벤트는 상태 프레임에 얹힘, 스냅샷 1초). 6인 relay 5Hz, 화면 지연 약 440ms(SYNC_API 6절).
- 대기실에서는 상태를 보내지 않는다. 멤버의 시계 핑(3초)과, 경기를 한 번 치른 방장의 마지막 스냅샷 재전송(1초, sync 내부)은 계속 나간다.

## 7. 테스트
**`tests/session-wiring.test.mjs`(`npm test`)**: 실제 session·sync·protocol·match를 작은 가짜 net·world·ui·account 위에서 돌린다. 메시지는 JSON으로 왕복한다.
- 팀전 클래식: 방 → 로드아웃(보유 무기·계정 장비) → g2l → 라이브 → 샷건 `count`·`shotId` 전달 → 킬 → 결과·`reward` → `recordMatch` 한 번.
- 개인전 칼전: 맵 다시 고르기, 총 주장 `reject 'ruleset'`, 원격 칼·강타 표시, `knifeKills`, `room:ruleset`·`room:map`.
- 방장 이전(라이브·승부가 난 라운드 끝): 반샷·선택·규칙 유지, `recordMatch`는 사람마다 한 번.
- 서버 설정 없음, g2l 왕복·256B, 로비 메타 왕복·presence 키 10개, 채널 이름, 로비·대기실 화면(작은 DOM 대역).

**실제 Supabase로 확인되지 않은 것**(새 프로젝트를 만든 뒤 확인): 실제 Realtime 전송과 presence(`ruleset`이 든 로비 목록), relay, 실제 브라우저 렌더링. 시험의 가짜 방은 전달만 하고 손실·지연·재접속을 흉내 내지 않는다.

### 이전 기록(규칙 도입 전 버전, 이전 테스트 프로젝트, 저장소 밖 스크립트)
아래는 규칙을 넣기 전에 실제 Supabase Realtime에서 돌린 기록이다. 지금 코드로 다시 돌린 결과가 아니고, 스크립트는 저장소에 없다.

| 스크립트 | 내용 | 결과 |
|---|---|---|
| `restore.test.mjs` (`node --test`) | 팀전: 2:1 live 이어받기 → 3:1 승리·기록 합산 / 승부 난 roundEnd 이어받기 / 한 팀 비면 forfeit / 퇴장 forfeit 합산 점수 / 무승부 재경기 표시 / 6인 스냅샷 크기·protocol 왕복. FFA: live 시작 spawn·킬 / 이어받기(킬·데스·나간 사람 기록 유지, 남은 시간, 모두 다시 출격) / 나만 남으면 forfeit | 9/9 |
| `integ.mjs` (3클라이언트, 가짜 world·ui) | 방 생성(max 8→6) → 목록 → 참가 → 팀·준비·채팅·맵 → 시작(prep/ack) → 로드아웃(sr_bolt 확정) → 아군 사격 거절 → 히트 주장 → 방장 확정 → 킬(피격 방향·히트마커·킬피드·actorDeath·actorFire) → 전멸 → 수류탄(방장 world 폭발 → claimExplosion) → 매치 포인트 → 3:1 결과(MVP·기록) → 방으로 → 재준비 → 경기 2 → 방장 정상 퇴장 → 복원(1:0, 같은 라운드 재스폰) → 3:0 결과(나간 사람 기록 유지) → 퇴장 → 목록에서 사라짐 | 81/81 × 4회, 콘솔 오류 0, 방장 이전 110~125ms |
| `integ4.mjs` (4~5클라이언트, relay) | 준비 중 방장 이탈 → 취소 / 경기 중 멤버 이탈(유예 2초) / 늦게 참가 → 관전 → 다음 라운드 스폰 / 한 팀만 남는 방장 이탈 → forfeit / 소켓 강제 단절 방장 이전(약 4~5초) → 복원 → 두 번째 방장 이탈 → forfeit | 46/46 × 8회 |
| `smoke-mixed.mjs` (헤드리스 Chrome 탭 = 실제 world·UI 방장 + node 클라이언트) | 메뉴 → 로비 → 방 만들기 → node 참가 → 채팅 → 준비 → 시작(core 화면 match) → 로드아웃 → 실제 world 스폰 → 원격 아바타 → 로드아웃 확정(sr_bolt) → node 히트 주장 → 방장 확정 → 실제 world `killLocal`·킬피드·배너 → 2라운드 재스폰 → 방장 탭 닫기 → node가 이어받아 forfeit 결과 | 29/29, 브라우저 콘솔 오류 0 |
| `smoke.mjs` (헤드리스 Chrome 2탭) | 경기 전 흐름(로비·방·채팅·준비·시작)은 통과. 경기 화면은 swiftshader 2탭 렌더가 다른 테스트와 겹친 CPU 99%에서 너무 느려 끝까지 못 돌림 → 위 혼합 스모크로 대신 | 경기 전 20/20 |
| `queue.mjs` | 연결 중에 누른 [방 만들기]가 연결 뒤 실행되는지(max 8 → 6) | 통과 |
| `integ_ffa.mjs` (3~4클라이언트, 가짜 world·ui) | 개인전 방(로비 목록 mode) → 방장만 모드 전환(안내) → 팀 없이 준비·시작 → 로드아웃 → live 전원 spawn(team null·보호·서로 떨어진 스폰) → 킬 → 부활 대기(setRespawn·compact 로드아웃) → 죽은 동안 무기 변경 → 그 무기로 부활 → 늦게 참가 → 바로 출격 → 5킬 결과(순위·우승·이유) → 방으로(모드 유지) → 경기 2 → 방장 이탈 → `restoreFfaMatch`(킬·남은 시간 유지, 모두 다시 출격) → 결과 | 62/62 × 3회, 콘솔 오류 0 |
| `rapid.mjs` | 경기가 끝나고 3초 안에 새 경기 시작 + 막 들어온 사람 → 지난 경기 결과로 튕기지 않음(이벤트 `mid` 필터) | 고치기 전 실패 재현 → 고친 뒤 11/11 |
| `smoke-mixed-ffa.mjs` (헤드리스 Chrome 탭 = 실제 world·UI 방장 + node) | 로비 모드 선택 → 개인전 방 → node 참가 → 시작 → `world.mode = 'ffa'` → 출격 → node가 처치 → 실제 world `killLocal` + compact 로드아웃 + HUD 부활 대기 → 부활 → node 퇴장 → 개인전 기권승 결과 | 26/26, 브라우저 콘솔 오류 0 |

테스트에서 찾아 고친 것:
- 방장이 상태를 `playing`으로 바꾼 직후 맵 빌드·셰이더 컴파일로 8초 넘게 멈추면 net이 방장을 바꿔 경기가 취소됐다 → 상태를 맵 로드 뒤에 바꾼다(3절).
- 연결 중에 누른 방 만들기·참가가 무시됐다 → 연결되면 실행한다.
- 경기가 끝나고 3초 안에 새 경기를 시작하면 막 들어온 사람이 지난 경기의 `matchEnd`를 받아 결과 화면으로 튕겼다(1차 때 한 번 보인 `integ4` 간헐 실패의 원인) → 이벤트마다 `mid`를 붙여 거른다(6절).
- 로드아웃 선택에 경기 id를 싣는다: 다음 경기에서 같은 무기를 다시 고르면 sync가 같은 내용이라 거르는 바람에 방장에게 안 갔다.

## 8. 알려진 한계
1. 방장 이탈 시 **진행 중이던 라운드는 처음부터 다시** 한다(체력·위치·남은 시간은 복원하지 않음). 점수·라운드 기록·개인 기록은 이어진다.
2. 방장 판정은 방장 화면 기준이다. 수류탄 피해는 방장 world가 본 원격 아바타 위치(보간 지연 0.2~0.45초)로 계산한다. 신뢰 없는 클라이언트(anon key) 전제.
3. 던진 사람의 World는 수류탄을 mm 단위로, 다른 사람은 protocol 정본(cm 단위)으로 시뮬레이션한다(world.js `r3`). 궤적 차이는 수 cm 이하이고 판정은 방장 것만 쓴다.
4. 경기를 한 번 치른 방장은 대기실에서도 sync가 마지막 스냅샷을 1초마다 다시 보낸다(sync에 끄는 API가 없음). 6인 relay면 초당 약 6 이벤트다.
5. 팀전에 늦게 들어온 관전자는 아직 스폰 전이라 World의 3인칭 관전 카메라가 없다(맵 기본 시점). FFA는 respawnMs 뒤 바로 출격한다.
6. 탭이 백그라운드면 브라우저 타이머 제한으로 상태가 끊긴다(SYNC_API 11절). 방장 탭이 오래 숨겨지면 net이 방장을 바꾸고, 세션이 이어받는다.
7. FFA 방장 이전은 진행 중이던 목숨을 이어 가지 않는다(모두 다시 출격). 킬·데스와 남은 시간은 이어진다.
8. `knifeKills`는 내가 받은 킬 이벤트로 센다. 방장 이전 순간에 잃은 이벤트는 세지 못한다(적게 셀 수는 있어도 많이 세지는 않는다).
9. 보유 무기는 방장이 확인할 수 없다(`setLoadout`은 규칙만 본다). 신뢰 없는 클라이언트 전제다.

## 9. 폭파 미션 (MODES.md 5절)
| 단계 | 세션이 하는 일 |
|---|---|
| 방 | 방 메타 `mode: 'bomb'`(net이 `'bomb'`을 그대로 싣는다). 방장 `room:mode { mode: 'bomb' }` → `updateMeta({ mode, ruleset: 'classic', mapId: 미션 맵 })`. 미션 맵이 없으면 바꾸지 않고 안내. `room:ruleset`은 무시, `room:map`은 미션 맵만. 다른 모드로 돌아가면 바꾸기 전 규칙으로, 지금 맵을 그 규칙에서 못 쓰면 바꾸기 전 맵(그것도 안 되면 그 규칙의 첫 맵)으로 되돌린다(방장 세션이 기억, 방이 바뀌면 지운다) |
| 방 만들기 | `lobby:create { mode: 'bomb' }` → 규칙 클래식, 맵은 `maps.mapsForMode('bomb')`의 맵으로 |
| 시작 | 팀전과 같은 조건(양 팀 1명 이상, 모두 준비). 미션 맵이 아니면 시작하지 않고 안내 |
| 경기 | `createMatch({ rules: { ...o.rules, ...o.bombRules, mode: 'bomb' }, mission: world.loadMap 결과의 mission, getPositions, floorAt })`. `positions()`는 발 x·y·z, `floorAt`은 `world.floorAt`(떨어진 폭탄을 바닥에) |
| 의도 | world `bombAction { act, reason }` → `sync.sendBomb(act, reason)` → 방장 sync `bomb` 이벤트 → `m.bombIntent(from, act, { reason })`. 방장은 원격 사격(`fire`)과 수류탄 투척(`grenade`, 던지는 순간) 메시지에도 그 사람의 설치·해체를 `fired`로 취소한다. 터지는 `claimExplosion`은 취소하지 않는다 |
| 반영 | 경기 이벤트 `bomb` → `world.bombEvent({ ...e, name })`. 스냅샷마다 `world.setBomb(bombInfo(view))`, `world.setRound`에 `mode: 'bomb', attack` |
| 문구 | 라운드 시작 "라운드 3 · 공수 교대" + 진영·목표, live "작전 개시!" + 진영 목표, 라운드 끝 "레드 팀 승리 · 폭탄 해체 · 수비 승 · 블루 1 : 1 레드" |
| 점수판 | `{ mode: 'bomb', attack, players[].bomb }` — 폭탄을 든 사람은 내가 공격 팀일 때만 싣는다 |
| 결과 | `{ mode: 'bomb', rounds: [{ round, winner, reason(문구), reasonCode, attack }] }`, 계정 summary `mode: 'bomb'` |
| 방장 이전 | `restoreMatch({ ..., mission, getPositions, floorAt })`, `hm.mode = 'bomb'`. 그 라운드를 처음부터(폭탄도 새로 준다) |

옵션: `bombRules` — 폭파 미션일 때만 더 얹는 rules(시험: `{ plantMs: 600, defuseMs: 800, fuseMs: 20000 }`).
시험: `tests/session-wiring.test.mjs` '폭파 미션' — 미션 맵·클래식 고정, 구역 밖 의도 거절, E 의도 → 설치, 멤버 해체 의도가 g2b로 방장에게, 수비 승 결과(`reasonCode`·`attack`), 계정 summary `mode: 'bomb'`.
또 '폭파 미션 방장 이전': 공격 방장이 나가면 수비가 이어받아 미션 칸으로 그 라운드를 다시 하고(폭탄은 남은 공격수에게), 설치 → 폭발 → 공격 승 결과, 나간 사람은 기록하지 않음.
