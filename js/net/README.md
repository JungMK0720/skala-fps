# js/net — 로비·방 네트워크 (Supabase Realtime Broadcast + Presence)

외부 라이브러리 없이 **Supabase Realtime 프로토콜(Phoenix 채널 vsn 1.0.0, JSON)을 직접 구현한 얇은 클라이언트**다.
브라우저와 Node 22+(전역 `WebSocket`)에서 같은 코드로 돈다. DB 테이블, RLS, 프로젝트 설정은 쓰지 않는다.

| 파일 | 내용 |
|---|---|
| `index.js` | 진입점: `connect()`, `Net`. 아래 모듈을 모두 re-export |
| `realtime.js` | 소켓·채널·presence 동기화, 하트비트, 지수 백오프 재연결, presence 호출 제한 |
| `lobby.js` | 로비 `skalafps:lobby`(`consts.NET.LOBBY_CHANNEL`): 방 목록 = 방장들의 presence |
| `room.js` | 방 `skalafps:room:<roomId>`(`consts.NET.ROOM_CHANNEL_PREFIX`): 방장 선출·이전, 프레임 병합/스로틀, 핑·시계, mesh/relay |
| `codec.js` | 상태 직렬화 도우미(반올림, 각도 양자화, 짧은 키, delta, 보간) |
| `limits.js` | 무료 플랜 한도, 예산 계산(`frameCost`, `maxHz`), `TokenBucket`, `SlidingWindowLimiter` |
| `hubsocket.js` | Cloudflare 중계 서버(`server/relay`)용 소켓 `HubSocket`. 겉모양이 `RealtimeSocket`과 같고 허브(로비·방)마다 WebSocket을 하나씩 연다(8절) |

---

## 1. 빠른 시작

```js
import { connect } from './net/index.js';

// url/key를 생략하면 window.SKALA_CONFIG.supabase.{url, anonKey}를 쓴다
const net = await connect({ playerId: crypto.randomUUID().replace(/-/g, '').slice(0, 16), name: '플레이어' });

// 로비
const offLobby = net.lobby.subscribe((rooms, { synced }) => {
  // rooms: [{ roomId, name, mapId, hostId, hostName, players, max, status: 'waiting'|'playing', mode: 'team'|'ffa'|'bomb', ruleset }]
  // synced=false 동안은 '불러오는 중', true인데 []이면 '방 없음'
});

// 방 만들기(내가 방장) 또는 참가
const room = await net.lobby.createRoom({ name: '방 1', mapId: 'alley', max: 6, mode: 'ffa', ruleset: 'knife' });
// const room = await net.joinRoom(roomId);   // 실패 시 e.code: ROOM_NOT_FOUND | ROOM_FULL | ...
offLobby(); // 방 안에서는 로비 구독을 끄면 presence 예산이 절약된다(방장은 자동으로 로비에 남음)

room.players();                    // [{ id, name, team, ready, joinedAt, ping, isHost }]  (joinedAt 순)
room.on('players', (list) => {});  // presence·패치·핑이 바뀔 때
room.on('host', ({ hostId, prevHostId, term, isMe, reason }) => {});
room.on('message', ({ from, event, payload, to, t, fromHost }) => {});
room.on('closed', ({ reason }) => {});

room.updateMe({ team: 'owner', ready: true });
room.send('st', codec.encode(myState), { merge: true }); // 상태: 마지막 값만, room.rate 이하로
room.send('shot', { ... });                              // 이벤트: 모아서 다음 프레임에
room.sendTo(room.hostId(), 'hit', { ... });              // 방장에게만(받는 쪽 필터)
if (room.isHost()) room.updateMeta({ status: 'playing', mapId: 'tankfarm' });

await room.leave();
await net.close();
```

`players()`의 초기값은 `createRoom/joinRoom`이 끝난 직후 직접 읽는다. `'players'` 이벤트는 그 이후 변화만 알린다.

---

## 2. API

### `connect(opts) → Promise<Net>`
| 옵션 | 기본 | 설명 |
|---|---|---|
| `transport` | `SKALA_CONFIG.transport` 또는 `'supabase'` | `'supabase'`(Supabase Realtime) 또는 `'relay'`(중계 서버, 8절) |
| `relayUrl`, `relayHz` | `SKALA_CONFIG.relay.url`, `.hz`(20) | `'relay'`일 때 서버 주소와 클라이언트 프레임 상한 |
| `url`, `key` | `window.SKALA_CONFIG.supabase` | Supabase URL, publishable(anon) key(`'supabase'`일 때) |
| `playerId` | 랜덤 12자 | 영문·숫자·`_-` 1~40자. **탭마다 고유**해야 한다(같은 id 두 탭 = presence 한 사람) |
| `name` | `플레이어-xxxx` | 24자로 자르고 제어문자 제거. 화면에는 `textContent`로만 |
| `timeoutMs` | 15000 | 첫 연결 제한. 넘으면 `CONNECT_TIMEOUT` |
| `socket` | | `{ heartbeatMs: 25000, heartbeatTimeoutMs: 10000, backoff: {base:500,max:15000,factor:2,jitter:0.25}, logger }` |
| `room` | | `ROOM_DEFAULTS`(room.js) 덮어쓰기. 예: `{ budget: 80, maxHz: 20, topology: 'auto' }` |

### `Net`
| 멤버 | 설명 |
|---|---|
| `net.me` | `{ id, name }` |
| `net.lobby` | `Lobby` |
| `net.room` | 현재 방 또는 `null` (방은 한 번에 하나. 새로 만들거나 들어가면 이전 방에서 자동 퇴장) |
| `net.createRoom(opts)` / `net.joinRoom(roomId, opts?)` | 아래 Lobby와 같음. 호출이 겹쳐도 순서대로 처리(직렬화) |
| `net.stats()` | `{ state, rtt, reconnects, framesOut, framesIn, bytesOut, bytesIn, broadcastsOut, broadcastsIn, presenceCalls, room }` |
| `net.close()` = `net.dispose()` | 방 퇴장(`_bye` 동기 송신) → 로비 해제 → 소켓 종료. 브라우저 `pagehide`에서도 자동 호출 |
| 이벤트 `'connection'` | `{ state: 'open' \| 'reconnecting' \| 'closed', code?, reason? }` |

### `Lobby` (`net.lobby`)
| 멤버 | 설명 |
|---|---|
| `subscribe(fn) → off` | `fn(rooms, { synced })`. 즉시 1회 호출, 첫 동기화 때 1회(비어 있어도), 이후 바뀔 때마다 호출. 구독자가 0명이고 방장이 아니면 로비 채널에서 나간다 |
| `rooms()` | 현재 목록 사본. 정렬: waiting 먼저, 이름순 |
| `synced` / `ready()` | 로비 presence를 받았는지 / 참가 완료 Promise |
| `createRoom({ name, mapId='jetty', max=8, topology?, ...extra })` | 방 생성 → `Room`(내가 방장, term 1). `max`는 2~16. `extra`는 meta에 들어간다(게임은 `mode`, `ruleset`, 개인전이면 `killTarget`을 넣는다) |
| `joinRoom(roomId, opts?)` | 참가 → `Room` |

방 항목: `{ roomId, name, mapId, hostId, hostName, players, max, status, mode, ruleset, locked, killTarget? }`. 방장이 로비 presence에 track한다.
방장이 바뀌면 새 방장이 `term+1`로 다시 track하고, 같은 `roomId`가 겹치면 term이 큰 쪽을 쓴다. 인원이 0이 되면 목록에서 빠진다.

presence 객체는 키가 10개까지인데 로비 항목은 `roomId, name, mapId, hostId, hostName, players, max, status, term, mode`로 이미 10개다. 그래서 규칙은 키를 늘리지 않고 `mode` 값에 함께 싣는다: `'team'`, `'ffa'`, `'bomb'`(폭파 미션, 규칙은 언제나 클래식), `'team:knife'`, `'ffa:sniper'`(`packRoomKind`, `unpackRoomKind`). 클래식은 규칙을 적지 않으므로 규칙이 없는 옛 항목은 클래식으로 읽힌다. 비밀번호 방은 셋째 칸에 `p`, 개인전 목표 킬(1~99 정수, 게임은 5~20만 쓴다)은 넷째 칸에 싣는다: `'ffa:classic::10'`, `'ffa:knife:p:5'`. 셋째 칸까지만 읽던 클라이언트도 비밀번호 여부를 그대로 읽고, 목표 킬이 없는 개인전 항목은 게임이 20킬로 읽는다. 팀전·폭파 미션 항목에는 목표 킬을 싣지 않는다. 항목을 만들고 읽는 곳은 `lobbyEntry`, `readLobbyEntry` 하나씩이다. 키를 더하고 싶으면 `tests/session-wiring.test.mjs`의 키 수 검사가 막는다.

### `Room`
| 멤버 | 설명 |
|---|---|
| `room.id` | roomId (8자) |
| `room.me` | 내 플레이어 객체 (players()와 같은 모양) |
| `room.isHost()` / `room.hostId()` | 방장 여부 / 방장 id |
| `room.players()` | `[{ id, name, team, ready, joinedAt, ping, isHost, ...updateMe 필드 }]` joinedAt 순 |
| `room.meta` | `{ roomId, name, mapId, max, status, topo, net, hz, hostId, term, mode?, ruleset?, killTarget?, ...extra }`. 방장이 바뀌어도 이어진다. `ruleset`이 없으면 클래식으로 읽는다. `killTarget`은 게임이 5~20으로 다시 자른다 |
| `room.rate` | 지금 내가 보낼 수 있는 초당 프레임 수(방장이 정한 `meta.hz`). 보간 지연 계산에 쓴다 |
| `room.now()` | 방 시계(방장 `Date.now()` 기준). NTP 방식으로 맞춘다. `room.clockInfo()` → `{ offset, delay, samples }`(오차 ≤ delay/2) |
| `room.send(event, payload, { merge })` | 방 전체. `event`는 1~64자, `_`로 시작 금지. payload는 JSON 가능 값 |
| `room.sendTo(playerId, event, payload, { merge })` | 간이 귓속말. mesh에서는 모두에게 가고 **받는 쪽이 거른다**(비밀 금지). relay에서는 방장만 거친다 |
| `room.handle(event, fn) → off` | `fn(payload, message)` 이벤트 하나만 구독 |
| `room.updateMe(fields) → bool` | 내 presence 필드 갱신(`id, joinedAt, v`는 예약). 다른 사람에게는 **즉시 패치(broadcast)** + presence(한도 안에서 병합) |
| `room.updateMeta(fields) → bool` | **방장만**(아니면 `false`). `roomId, hostId, term, net, hz`는 변경 불가. 방 전체 `_meta` + 로비 목록 반영 |
| `room.leave()` = `room.dispose()` | 남은 큐와 `_bye`를 즉시 보내고 퇴장 |
| `room.stats` | `{ framesOut, framesIn, msgsOut, msgsIn, merged, dropped }` |

| 이벤트 | 인자 |
|---|---|
| `'players'` | `players()` 목록 |
| `'host'` | `{ hostId, prevHostId, term, isMe, reason: 'host-left'\|'host-silent'\|'host-unconfirmed'\|'claim'\|'no-host' }` |
| `'message'` | `{ from, event, payload, to, t(보낸 쪽 방 시계 ms), fromHost }` (내부 `_` 이벤트는 안 옴) |
| `'meta'` | `room.meta` |
| `'connection'` | `{ state: 'reconnecting' \| 'connected', reason? }` — 재접속 후 자동 재참가·presence 재등록 |
| `'closed'` | `{ reason: 'left' \| 'disposed' \| 'switch' \| 'net-closed' \| 'kicked:full' \| 'kicked:<사유>' }` |

에러 코드(`e.code`): `NO_CONFIG, NO_WEBSOCKET, BAD_PLAYER_ID, CONNECT_TIMEOUT, CLOSED, BAD_ROOM_ID, ROOM_NOT_FOUND, ROOM_FULL, JOIN_TIMEOUT, JOIN_ERROR, TRACK_FAILED`.

---

## 3. 동작 규칙

### 방장 선출·이전
- 방장 = presence에서 `joinedAt`이 가장 이른 사람(같으면 id 사전순). **방장은 유지된다(sticky)**: 더 이른 사람이 재접속해 돌아와도 빼앗지 않는다.
- 참가자는 `joinedAt = max(지금, 기존 인원 최댓값+1)`로 등록한다. 시계가 늦은 PC가 방장을 빼앗지 않게 하기 위해서다.
- 방장이 나가면 남은 사람 중 가장 이른 사람이 `term+1`로 이어받고 `'host'`를 낸다. 감지 경로는 세 가지다.
  - `_bye`(정상 퇴장·탭 닫기): 즉시. 측정 약 0.1초
  - presence 이탈 후 **3초 유예**(순단이면 그사이 돌아옴): 비정상 종료 측정 약 3.8~6.0초. presence 이탈이 다른 노드에 전파되는 데만 1~3초 걸린다
  - 침묵: 경기 중 8초, 대기 중 32초 동안 방장에게서 아무것도 못 받으면
- 새 방장은 `_meta`(meta, term, 명단)를 알리고 로비 항목을 이어서 track한다. relay면 모든 uplink에 참가한다.
- 충돌 해소: term이 큰 쪽이 이긴다. 같으면 아직 확정되지 않은 후보보다 확정된 공지가, 그다음 joinedAt이 이른 쪽이 이긴다. 진 방장은 스스로 내려온다.
- 참가자는 방장의 `_meta` 명단으로 정원을 미리 확인한다(`ROOM_FULL`). 동시에 참가해 둘 다 통과하면(presence 지연 때문) 방장이 joinedAt이 가장 늦은 사람에게 `_kick`을 보낸다 → `'closed' {reason:'kicked:full'}`. 정원 2인 방 동시 참가 실측에서 1.4~1.8초 안에 1명이 퇴장해 정원이 지켜졌다(2회).

### 전송: 프레임 병합 + 토큰 버킷
- `send/sendTo`는 큐에 넣는다. 같은 JS 턴의 호출은 한 프레임으로 묶이고, 프레임은 **클라이언트당 초당 `room.rate`개**(버스트 3)로 제한된다.
- 넘치는 메시지는 다음 프레임에 **합쳐진다**. `{merge:true}` 이벤트는 프레임 전까지 마지막 값만 남는다(상태용). 나머지는 순서대로 모두 간다.
- 실측: 100Hz로 merge 상태 200개를 보냈더니 3.2초에 31프레임(rate 8.5), 마지막 값 손실 없음.
- 연결이 끊긴 동안 큐는 최대 10초·300개까지 보존한 뒤 재참가하면 보낸다. 오래된 것은 버린다.
- 프레임 형식: broadcast event `'f'`, payload `{ f: 보낸이, t: 방 시계, m: [[event, payload, to?], ...], r?: [[from, t, msgs], ...] }`

### 토폴로지와 예산 조절(방장)
- **mesh**: 모두가 방 채널로 보낸다. 1프레임 = 1(송신) + N−1(전달) 이벤트. 1틱(전원 1프레임) = **N²**
- **relay**: 비방장은 `skalafps:room:<id>:u:<내id>`(방장만 구독)로 보낸다. 방장이 모아 방 채널로 한 번에 다시 보낸다. 1틱 = 2(N−1) + N = **3N−2**. 대신 멤버끼리는 지연이 약 2배다.
  - 멤버는 **현재 방장이 자기 uplink 구독을 `_upok`로 확인해 준 뒤에만** uplink로 보낸다. 참가 직후나 방장 교체 직후처럼 그 전에는 방 채널(mesh)로 보내므로 전환 중에도 유실이 없다(실측 15/15, 20/20). 방장은 presence(1~3초 지연)를 기다리지 않고, 프레임으로 처음 들은 멤버의 uplink에 바로 참가한다.
  - 방장은 떠난 멤버의 uplink를 늦게 정리한다. `_bye`를 받았거나 presence에서 20초 넘게 사라졌을 때만 나간다. 재접속 직후 presence가 덜 찬 순간에 나가 버리면 유실이 생기기 때문이다.
- `topology: 'auto'`(기본)는 4명 이상이면 relay다. 방장이 `hz = 예산(80) ÷ Σ(진행 중인 모든 방의 1틱 비용)`을 0.5Hz 단위로 정해 `meta.hz`로 알리고(최소 1, 최대 20), 모두 그 rate를 따른다. 다른 방이 경기 중이면 로비 목록을 보고 같이 나눈다.

### 핑·시계
- 방장이 `_pi`를 보낸다(대기 10초, 경기 4초 간격. 경기 중에는 상태 프레임에 얹혀 가므로 추가 비용이 없다). 멤버는 `_po`로 답한다. 방장은 대기 시간을 뺀 RTT를 재서 다음 `_pi`에 전원 표를 싣는다.
- `players()[i].ping`
  - 멤버: 멤버↔방장 왕복(Supabase 2홉)
  - 방장: 하트비트로 잰 방장↔Supabase 왕복
  - presence의 `ping` 필드는 60초 간격, 30ms 이상 변할 때만 갱신한다(presence 예산 절약). 화면에는 `players()` 값을 쓰면 된다.
- 시계: `_po`에 보낸 시각을 싣고 방장이 받은 시각과 함께 돌려주는 NTP 4타임스탬프 방식이다. 최근 8개 중 지연이 가장 작은 표본을 쓴다. 같은 PC 테스트에서 오프셋 0/−1ms(지연 145~150ms).

### 재연결
- 하트비트는 연결 직후 1회, 이후 25초마다 보낸다(서버 RTT 측정 겸용). 10초 안에 응답이 없으면 끊고 재연결한다. 재연결 대기는 지수 백오프(0.5→1→2→4→8→15초, ±25% 지터)이고, 브라우저 `online`과 탭 복귀 때는 즉시 시도한다.
- 소켓이 다시 열리면 원하던 채널에 모두 재참가하고, 마지막 presence를 다시 track한다. 방장이면 `_meta`를, 멤버면 `_hello`를 보내 다시 맞춘다.
- 서버가 채널을 강제 종료하면(한도 초과 등, `system` 에러 + `phx_close`) 채널 백오프(1→2→4…30초) 후 재참가한다.
- 실측: 멤버 순단 → 재접속·재참가 약 0.9~1.2초. 방장 순단(0.85~1.2초) → 방장 유지.

### presence 호출 제한
- 서버 규칙: **채널당 30초 고정 창에 track/untrack 5회. 넘으면 채널 강제 종료**. 같은 payload를 다시 보내도 1회로 센다.
- 이 클라이언트는 채널마다 **31초 슬라이딩 창 4회, 최소 간격 250ms**로 막는다. 같은 값은 보내지 않고, 대기 중인 요청은 마지막 값으로 합친다.
- 실측: `updateMe` 20연타 → track 2회, 다른 사람에게는 패치로 0.13초 안에 최종값, 강제 종료 0회.
- presence diff는 노드 간 복제 때문에 **1~3초** 늦게 도착한다. 그래서 `updateMe`는 broadcast 패치(`_me`)를 같이 보낸다(측정 약 80~95ms).
- 방장이 방을 나갈 때 로비를 구독 중이면 `untrack` 대신 로비 채널을 새로 연다(한도와 무관하게 즉시 제거, 측정 1.7초). 이렇게 하지 않으면 목록에 유령 방이 남는다.

### 내부 이벤트 (`_` 접두사, 사용자 이벤트로 금지)
`_hello`(새 참가자→방장) · `_meta`(방장 공지: meta, term, roster, ht) · `_pi`/`_po`(핑/퐁, RTT표, 시계) · `_me`(presence 즉시 패치) · `_bye`(퇴장) · `_kick`(강퇴) · `_ka`(경기 중 방장 keepalive 2.5초) · `_upok`(relay: 방장이 멤버 uplink 구독 확인)

---

## 4. Supabase 무료 플랜 한도와 계산

출처: <https://supabase.com/docs/guides/realtime/limits> (2026-11 확인), 계수 방식은 `supabase/realtime` 서버 소스(`broadcast_handler.ex`, `message_dispatcher.ex`, `presence_handler.ex`, `tenants.ex`).

| 항목 | Free | 비고 |
|---|---|---|
| 동시 연결 | **200** | 프로젝트 전체. 탭 1개 = WebSocket 1개 |
| 메시지/초 | **100** | 프로젝트 전체. **보낸 broadcast 1 + 받은 사람 수만큼** 센다. 5초×12 버킷 = **60초 평균**. 넘으면 `"Too many messages per second"`로 채널 강제 종료 |
| 채널 참가/초 | 100 | |
| 연결당 채널 | 100 | 방장(relay) = 로비 + 방 + uplink 7 = 9 |
| presence 메시지/초 | **20** | 프로젝트 전체. track 1 + diff 전달 수. 60초 평균 |
| presence 호출 | **채널당 30초 5회** | 넘으면 채널 강제 종료 |
| presence 객체 키 | 10 | 기본 필드 7개(`id,name,team,ready,joinedAt,ping,v`) → `updateMe` 사용자 필드는 3개까지 권장. 지금 쓰는 사용자 필드는 캐릭터 `av` 하나(game/session.js) |
| broadcast payload | 256 KB | 프레임 8만 자를 넘으면 나눠 보낸다 |

하트비트, 참가/응답(`phx_reply`)은 메시지 수에 들어가지 않는다. presence diff는 별도 presence 한도로 센다.

### 8인 방 10Hz 상태 동기화 — **무료 플랜에서는 불가능**
| 인원 N | mesh @10Hz (N²×10) | relay @10Hz ((3N−2)×10) | 예산 80에서 최대 Hz (mesh / relay) |
|---|---|---|---|
| 2 | 40 | 40 | 20 / 20 |
| 3 | 90 | 70 | 8.5 / 11 |
| 4 | 160 | 100 | 5 / 8 |
| 5 | 250 | 130 | 3 / 6 |
| 6 | 360 | 160 | 2 / 5 |
| 7 | 490 | 190 | 1.5 / 4 |
| **8** | **640 (한도의 6.4배)** | **220 (2.2배)** | **1 / 3.5** |

- ARCHITECTURE 7절의 "각자 10Hz broadcast"를 8명이 하면 초당 640 메시지로, 5초 안에 프로젝트의 모든 채널이 강제 종료된다. 이 라이브러리는 방장이 rate를 정하므로 **그대로 써도 한도를 넘지 않는다**. 대신 8명이면 relay 3.5Hz가 된다.
- 동시에 여러 방이 경기 중이면 예산을 나눈다. 예: 8인 방 2개 → 80/44 → 1.5Hz.
- 권장(2차 웨이브 `game/sync`)
  1. 상태는 `send('st', …, {merge:true})`로 매 프레임 보내도 된다(라이브러리가 rate로 자른다).
  2. 보간 지연 = `max(100ms, 1.5 / room.rate 초)`. 위치에 속도를 같이 실어 외삽(dead reckoning)한다.
  3. 사격·피격은 이벤트로 보낸다(`send` 비merge 또는 `sendTo(host)`). 프레임에 묶여 가므로 연사해도 메시지 수가 늘지 않는다.
  4. 정말 10Hz 이상이 필요하면: 방 인원을 4~6명으로 줄이거나(relay 8/5Hz), Pro 플랜(500 msg/s → 8인 relay 약 18Hz), 또는 WebRTC DataChannel P2P로 바꾸고 Supabase는 시그널링에만 쓴다(이 레이어 밖).

### presence 예산 대략
- 8인 방 1개 + 로비 구경꾼 10명. 평상시: ping 갱신 ≤ 8회/분 × 9명 전달 ≈ 1.2/s. 대기실에서 전원 ready 연타: 8×9=72회 → 60초 평균 1.2/s. 방장 로비 메타 1회 = 구경꾼 수만큼.
- 방 안에서는 `lobby.subscribe`를 끄는 것이 좋다.

### 테스트 실측 이벤트 사용량
E2E 전체(3클라이언트, 약 70초): broadcast 송신 231 + 수신 400 = 631 이벤트(평균 9.4/s), presence 호출 38회. 시스템 에러·강제 종료 0회.

---

## 5. 압축 도우미 (`codec`)
```js
import { codec } from './net/index.js';
const C = codec.createCodec({
  pos: ['p', 2],        // [x,y,z] 또는 {x,y,z} → [x,y,z] 소수 2자리(1cm)
  vel: ['v', 1],
  yaw: ['y', 'angle'],  // 라디안 → 0..4095 정수(0.088°)
  pitch: ['a', 'angle'],
  hp: ['h', 0],
  crouch: ['c', 'bool'],// true/false → 1/0
  weapon: ['w']         // 그대로
});
room.send('st', C.encode(state), { merge: true });     // 예: 107B → 64B
room.handle('st', (p, m) => applyRemote(m.from, C.decode(p), m.t));
```
그 외 `round(v,d)`, `roundAll(obj,d)`, `quantizeAngle/dequantizeAngle`, `packVec3/unpackVec3`, `delta(prev,next,eps)`, `applyDelta`, `jsonBytes`, `lerp`, `lerpAngle`.
Supabase는 메시지 **개수**로 한도를 세므로 크기보다 개수가 중요하다. 그래도 작은 payload는 지연과 대역폭을 줄인다.

---

## 6. 측정 결과

### 운영 프로젝트 (2026-11-07, 서울 `ap-northeast-2`, 국내 PC의 node 클라이언트 3개, 같은 프로세스 시계, 1회 측정)

| 항목 | 결과 |
|---|---|
| 연결 | 0.25~0.30초 |
| 방 생성 / 참가 | 0.2초 / 0.35~0.37초 |
| 로비 목록 노출 | 2.9초 (presence 복제) |
| broadcast 단방향 방장→멤버 (mesh) | 평균 **80ms**, p95 95ms, 최대 95ms |
| broadcast 단방향 멤버→멤버 (mesh) | 평균 **121ms**, p95 189ms, 최대 204ms |
| broadcast 왕복 A→B→A | 평균 **165ms**, p95 208ms, 최대 237ms |
| 서버 RTT(하트비트) | 88ms |
| updateMe 반영(패치) | 92ms |
| 방장 이전: 정상 퇴장 | 0.08초 |

### 이전 기록 (규칙 도입 전: 이전 테스트 프로젝트, node 클라이언트 3개, 같은 프로세스 시계)

| 항목 | 결과 |
|---|---|
| 연결 | 0.4~1.0초 |
| 방 생성 / 참가 | 0.2초 / 0.3~0.6초 |
| 로비 목록 노출 | 0.3~1.4초 (presence 복제) |
| broadcast 단방향 (mesh) | 평상시(9회 중 6회) 평균 **83~99ms**, p95 118~163ms, 최대 128~310ms / 혼잡 시(3회) 평균 210~283ms, 최대 814ms |
| broadcast 왕복 A→B→A | 평상시 평균 **169~265ms**, 최대 223~573ms / 혼잡 시 평균 331~548ms, 최대 1.2초 |
| relay 멤버→방장 / 멤버→멤버 | 평균 81~114ms / **157~227ms**, 최대 410ms (혼잡 시 1회 평균 471 / 842ms) |
| 서버 RTT(하트비트) | 72~107ms |
| updateMe 반영(패치) / presence 자체 | 77~94ms / 0.03~2.8초 |
| 방장 이전: 정상 퇴장 / 비정상 종료 | 0.0~0.12초 / 3.8~6.7초 |
| 재연결(멤버 순단) | 0.9~1.2초 |

검증 항목 52개 모두 통과: 생성 → 목록 → 참가 → presence → 패치 → 연타 제한 → 지연 → sendTo → 스로틀·병합 → meta·로비 반영 → 핑·시계 → 멤버·방장 재연결 → 방장 이전(정상/비정상) → 목록 갱신 → 전원 퇴장 후 소멸 → relay 전환 무손실·중계·sendTo·방장 교체 → 유령 방 방지 → ROOM_NOT_FOUND/ROOM_FULL → 시스템 에러 0 → 종료 후 타이머·소켓 0(프로세스 자연 종료).
테스트 스크립트는 저장소에 없다. 다시 돌리려면 `connect({url, key})`에 `js/config.js` 값을 넣은 node 스크립트로 같은 순서를 밟으면 된다.
저장소 안의 `tests/session-wiring.test.mjs`는 로비 항목의 키 수·왕복과 채널 이름만 확인한다. 소켓·presence·relay는 실제 서버가 있어야 확인된다.

---

## 7. 알려진 한계
1. **8인 10Hz 불가**(무료 플랜). 8인 relay 3.5Hz, mesh 1Hz. 방이 여러 개면 더 낮아진다. → 4절 권장 참고.
2. **신뢰 없는 방장**: anon key뿐이라 누구나 `_meta`로 높은 term을 주장하거나 다른 사람 행세를 할 수 있다(서버 검증 없음). 친구끼리 하는 캐주얼 게임을 전제로 한다.
3. `sendTo`는 비밀이 아니다. mesh에서는 모두가 받고 클라이언트가 거른다.
4. presence 전파가 1~3초 걸린다. 새 참가자가 목록에 늦게 보일 수 있다(방장 `_meta` 명단으로 보완). 30초에 5번을 넘는 presence 변경은 최대 31초 늦게 서버에 반영된다(그동안은 패치로 보임. 그사이 새로 온 사람에게는 이전 값이 보임).
5. 비정상 종료 감지에 약 4~7초 걸린다(presence 전파 + 3초 유예). 정상 퇴장과 탭 닫기(`pagehide`)는 즉시다. 동시 참가로 정원을 잠깐(1~2초) 넘을 수 있다(늦게 온 사람 강퇴로 복구).
6. relay에서는 멤버끼리 지연이 약 2배(+90ms)다. 방장 탭이 백그라운드면 타이머 제한으로 중계가 느려진다. 방장 교체 후 새 방장의 `_upok`가 올 때까지(보통 0.2~0.5초) mesh로 보낸다(그사이 메시지 비용 증가). 방장 교체 순간에 relay로 가던 프레임은 유실될 수 있다.
7. broadcast는 최선 노력 전달이다(ack 없음). 재연결 중 10초가 넘은 큐는 버린다. 게임 로직은 유실을 견뎌야 한다(상태는 merge로 최신만, 중요 이벤트는 방장이 확정 결과를 다시 알리는 식).
8. `room.now()`는 방장 시계다. 방장이 바뀌면 새 방장 기준으로 다시 맞춘다(PC 시계 차이만큼 뛸 수 있음). 라운드 종료 시각은 새 방장이 다시 공지해야 한다.
9. 같은 `playerId`로 두 탭에서 들어오면 한 사람으로 합쳐진다. 탭마다 고유 id를 써라.
10. bfcache(`pagehide` persisted)에서 돌아오면 소켓이 죽어 있을 수 있다. 하트비트 실패 또는 탭 복귀 이벤트로 재연결된다.

---

## 8. 중계 서버로 보내기 (`transport: 'relay'`)

`SKALA_CONFIG.transport = 'relay'`이면 `connect()`가 `RealtimeSocket` 대신 `HubSocket`(`hubsocket.js`)을 쓴다. 서버는 `server/relay`(Cloudflare Worker + Durable Objects)이고, Supabase Realtime과 같은 채널 규약을 쓰므로 `Lobby`·`Room`과 게임 코드는 그대로다. 서버 구조·검사·배포·요금은 [server/relay/README.md](../../server/relay/README.md).

- **허브마다 WebSocket 하나**: 로비 허브(`skalafps:lobby`)와 방마다 방 허브(`skalafps:room:<id>[:<비밀 값>]`)가 각각 Durable Object 하나다. `HubSocket`은 채널 이름으로 허브를 골라(`hubOf`) 허브마다 `RealtimeSocket`(링크)을 하나 열고, 채널이 없는 링크는 3초 뒤 닫는다. `open()`은 로비 허브부터 연다.
- **방 기본값**(`RELAY_ROOM_DEFAULTS`): `topology: 'mesh'`, 예산 무제한, `maxHz: 20`(`relay.hz`). 서버가 프레임을 받는 사람에게 직접 나눠 주므로 방장 uplink(relay)가 필요 없고, Supabase의 프로젝트 예산이 없으므로 `room.rate`가 바로 20이다(게임 상태는 `sync.js`가 10Hz로 보낸다).
- **sendTo는 대상만 받는다**(7절 3번이 이 전송에서는 풀린다). 다른 사람은 그 메시지를 뺀 프레임을 받는다.
- **보낸이 확인**: 프레임의 `f`가 연결의 presence 키와 다르면 서버가 버린다. 다른 키로 참가하는 것은 아직 막지 못한다(신원 확인 없음).
- **presence**는 10.5초에 10번까지 바로 보낸다(Supabase는 31초 4번). 서버 한도는 10초 12번.
- **하트비트**는 ref를 `'hb'`로 고정한 같은 글자다. 서버 객체가 잠든 채 런타임이 답한다. `net.socket.rtt`는 방 허브의 왕복 시간이다.
- `net.transport`, `net.stats().transport`로 어느 전송인지 안다. `net.socket.simulateDrop()`은 모든 링크를 끊었다 다시 붙인다(QA).
