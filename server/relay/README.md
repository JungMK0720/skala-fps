<!--
  Date: 06NOV2026
  Author: Minkyu Jung
  Purpose: 중계 서버(server/relay) 안내. 왜 만들었는지, 구조, 주고받는 규약, 서버가 검사하는 것, 로컬 실행과 QA, 배포 방법, 요금·한도, 권위 서버로 가는 다음 단계.
-->
# SKALA 작전 중계 서버 (Cloudflare Workers + Durable Objects, 시제품)

멀티플레이 메시지를 Supabase Realtime 대신 Cloudflare에서 중계한다. 판정은 지금처럼 방장 브라우저가 한다(`js/game/match.js`, 방장 권위 P2P). 이 서버는 메시지를 검사해서 받을 사람에게 나눠 줄 뿐이다. 닉네임·포인트·구매는 어느 쪽이든 Supabase DB 함수(`supabase/schema.sql`)를 쓴다.

## 왜 만들었나

Supabase 무료 Realtime은 프로젝트 전체가 초당 100건(받는 사람 수만큼 센다)이다. 그래서 8명 방 하나도 위치 전송이 초당 약 3.5회로 떨어지고, 4명 방 둘이면 각자 초당 2~3회다(`js/net/limits.js`). Durable Objects는 **들어오는** 메시지만 요금에 들어가고(20개 = 요청 1), 나가는 메시지(팬아웃)는 무료다. 그래서 방마다 클라이언트 상한인 초당 20프레임을 그대로 쓴다. 게임은 상태를 초당 10회(조준 변화 포함 최대 15회) 보낸다(`js/game/sync.js`).

## 구조

```
브라우저 ──WebSocket──▶ Worker  /ws?hub=<허브>  (Origin·허브 이름 검사)
                          │ idFromName(허브)
                          ▼
              Durable Object(허브 하나) ── hub.js: 참가·presence·broadcast·제한
```

- **허브 = Durable Object 하나.** 로비 허브 하나(`skalafps:lobby`)와 방마다 허브 하나(`skalafps:room:<id>`, 비밀번호 방은 `skalafps:room:<id>:<비밀 값>`)다. 허브 이름이 곧 객체 이름이라, 비밀번호를 모르면 같은 객체를 찾지 못한다(Supabase에서 채널 이름을 숨기던 방식 그대로).
- 클라이언트(`js/net/hubsocket.js`)는 허브마다 WebSocket을 하나 연다. 로비 화면은 로비 허브 하나, 방에 들어가면 방 허브가 더해진다. 방장은 로비에 방 항목을 올리므로 로비 허브도 유지한다. 채널이 없는 연결은 3초 뒤 닫는다.
- **WebSocket Hibernation API**를 쓴다. 메시지가 없으면 객체가 잠들고 그동안은 실행 시간 요금이 없다. 연결마다 상태(참가·presence)를 `serializeAttachment`에 남겨 두고, 깨어나면 다시 세운다. 하트비트(25초마다)는 정해진 글자라 런타임이 객체를 깨우지 않고 대신 답한다(`setWebSocketAutoResponse`).
- 1분마다 알람으로 75초 넘게 조용한 연결을 닫고, 허브 요약(연결·참가·메시지·글자·버린 수)을 로그에 한 줄 남긴다. 요약 수치는 객체가 깨어난 뒤부터 센다(`upSec`). 비밀번호 방의 비밀 값은 로그에서 지운다.
- 마지막 활동 시각도 연결 상태에 30초 단위로 남긴다. 깨어난 시각을 활동으로 치면 하트비트가 끊긴 연결이 알람 때마다 되살아나기 때문이다(로컬 workerd에서 찾아 고쳤다).

| 파일 | 내용 |
|---|---|
| `src/rules.js` | 허브 이름, 한도 표, 들어온 메시지 형식 검사, 방 프레임을 받는 사람별로 나누기, 보낼 글자 만들기. 플랫폼 API 없음 |
| `src/hub.js` | 허브 하나의 상태와 처리. 네트워크·타이머를 모르는 모듈이라 DO·Node·시험이 같이 쓴다 |
| `src/worker.js` | Worker 입구와 Durable Object `RelayHub`(Hibernation API, 자동 응답, 알람) |
| `src/node.js` | 같은 허브를 Node에서 돌리는 어댑터(의존성 없음). 시험·QA·VM용 |
| `tools/smoke.mjs` | 실제 클라이언트 코드(`js/net`) 셋을 붙여 22가지를 차례로 확인한다 |
| `wrangler.toml` | Worker 이름 `skala-relay`, DO 바인딩 `HUB`, SQLite 클래스 마이그레이션 `v1`, Origin 목록 |

권위 서버 시제품(브랜치 `feature/authoritative-server`)이 `server/package.json`·`server/README.md`·`server/core/`를 쓰므로, 겹치지 않게 이 폴더(`server/relay/`)에 따로 둔다.

## 주고받는 규약

Supabase Realtime(Phoenix 채널 vsn 1.0.0, JSON)의 부분집합이다. 그래서 브라우저는 `js/net/realtime.js`의 `RealtimeSocket`·`Channel`을 그대로 쓰고, `room.js`·`lobby.js`·게임 코드는 어느 서버에 붙었는지 모른다.

| 클라이언트 → 서버 | 서버 → 클라이언트 |
|---|---|
| `phx_join` `{ config: { presence: { key, enabled }, broadcast: { self } } }` (key = 플레이어 id, 꼭 필요) | `phx_reply` ok, presence를 쓰면 이어서 `presence_state` |
| `presence` track(한 줄) / untrack | `phx_reply`, 참가자 모두(자기 포함)에게 `presence_diff` |
| `broadcast` `f`(방 허브만, room.js 프레임 `{ f, t, m: [[event, payload, to?]] }`) | 보낸 사람을 뺀 참가자에게 `broadcast` |
| `phx_leave` | `phx_reply` ok, 남은 사람에게 `presence_diff` |
| 하트비트 `{"topic":"phoenix","event":"heartbeat","payload":{},"ref":"hb"}` | 런타임이 바로 답한다 |

## 서버가 검사하는 것

| 무엇 | 값 |
|---|---|
| 브라우저 Origin | `ALLOWED_ORIGINS`(기본: GitHub Pages, `http://localhost:*`, `http://127.0.0.1:*`). Origin이 없는 node 도구는 통과 |
| 허브 이름 | 로비 또는 방 id 1~40자(+ 비밀 값 hex 24자). room.js의 uplink 채널(`…:u:<id>`)은 받지 않는다 |
| 메시지 하나 | 100,000자. 텍스트 JSON만 |
| 연결당 속도 | 초당 40건(순간 80), 초당 256 K자(순간 512 K). 넘치면 버리고, 10초에 200번 버리거나 거절하면 연결을 끊는다(코드 4008) |
| presence | 참가 하나당 10초에 12번. 한 줄 16칸·JSON 1,024자, 글자 칸 128자에서 자름, 숫자·글자·참거짓·null만. 방에서는 `id` 칸 = presence 키 |
| 방 프레임 | 형식(메시지 400개, 이벤트 이름 64자, 대상은 플레이어 id), **`f` = 보낸 연결의 presence 키**(남의 이름으로 보내지 못한다), `r`(방장 relay 묶음) 거절 |
| 특정 대상 | `sendTo`·강퇴(`_kick`)처럼 대상이 있는 메시지는 대상에게만 간다. 나머지는 그 메시지를 뺀 프레임(비면 빈 `m`)을 받는다 |
| 인원 | 방 허브 연결 40·참가 32(방 상한 16 + 재접속 여유), 로비 2,000 |
| 죽은 연결 | 75초 동안 메시지도 하트비트도 없으면 닫는다(코드 4001). 알람이 1분마다 보므로 실제로는 75~135초 걸린다. 그동안 로비에 옛 방 줄이 남을 수 있다 |

## Supabase 전송과 달라지는 점

의미는 같고 숫자만 다르다(`js/net/index.js`의 `RELAY_ROOM_DEFAULTS`).

| | Supabase Realtime | 중계 서버 |
|---|---|---|
| 클라이언트 프레임 상한(`room.rate`) | 예산 80 ÷ 진행 중인 모든 방의 비용(8명 방 3.5Hz) | 20Hz(`SKALA_CONFIG.relay.hz`) |
| 토폴로지 | 4명부터 방장이 uplink로 모아 다시 보냄(relay) | 항상 mesh. 서버가 직접 나눠 준다 |
| `sendTo` | 모두가 받고 클라이언트가 거른다 | 대상만 받는다 |
| presence 변경 | 31초에 4번(넘으면 최대 31초 늦음) | 10.5초에 10번 |
| 보낸이 | 누구나 `f`를 바꿔 다른 사람 행세 가능 | `f`가 연결의 presence 키와 다르면 버린다 |

## 로컬 실행

```bash
cd server/relay
npm ci                  # 처음 한 번(wrangler 4.158.0, 로컬 workerd 포함)
npm run dev             # http://127.0.0.1:8788 (wrangler dev, 로그인 없이 로컬 Durable Object)
```

다른 창에서(저장소 루트):

```bash
node server/relay/tools/smoke.mjs http://127.0.0.1:8788
npm run qa:hidden -- --only multi-play --relay http://127.0.0.1:8788
```

- `smoke.mjs`: 클라이언트 셋으로 로비, 방 만들기, 참가, 전원·특정 대상 메시지, 준비·팀, 메타, 재접속, 강퇴, 방장 이전, 비밀번호 방, 퇴장을 본다.
- `multi-play`: 헤드리스 브라우저 두 개로 닉네임부터 경기 끝, 결과, 규칙 바꾸기, 중간 참가, 방장 퇴장, 비밀번호 방까지 돈다. 닉네임·프로필은 가짜 Supabase가 받고 실시간 메시지만 중계 서버로 간다. `--relay node`는 wrangler 없이 Node 어댑터를 시나리오가 직접 띄운다.
- wrangler 없이 서버만 띄우려면 `node server/relay/src/node.js --port 8788`.
- 브라우저로 직접 보려면 `js/config.js`의 `transport`를 `'relay'`, `relay.url`을 `'http://127.0.0.1:8788'`로 바꾸고 `index.html` CSP의 `connect-src`에 `http://127.0.0.1:8788 ws://127.0.0.1:8788`을 잠깐 더한다(커밋하지 않는다). 이때 닉네임·포인트는 운영 Supabase로 간다.

## 배포 (소유자가 정한다. 아직 배포하지 않았다)

단계별 절차, 성공 기준, 감시, 되돌리기, 문제 해결은 운영 절차서 [docs/CLOUDFLARE_SOP.md](../../docs/CLOUDFLARE_SOP.md)에 있다. 아래는 요약이다.

1. `cd server/relay && npx wrangler login` (브라우저로 Cloudflare 로그인)
2. `npx wrangler deploy` → `https://skala-relay.<계정 하위 도메인>.workers.dev`. 첫 배포 때 마이그레이션 `v1`이 SQLite 클래스 `RelayHub`를 만든다(무료 플랜은 SQLite 클래스만 된다).
3. 확인: `curl https://…/health`, `node server/relay/tools/smoke.mjs https://…`
4. 게임을 붙인다: `js/config.js`에 `transport: 'relay'`, `relay: { url: 'https://…' }`. `index.html` CSP의 `connect-src`에 `https://…`와 `wss://…`를 더한다(`tests/web-security.test.mjs`가 확인한다). `main`에 올리면 Pages가 반영한다.
5. 되돌리기: `transport: 'supabase'`로 바꿔 올리면 바로 Supabase Realtime으로 돌아간다. Worker는 그대로 둬도 요금이 없다(연결이 없으면 요청도 실행 시간도 0).

- 사이트 주소가 바뀌면 `wrangler.toml`의 `ALLOWED_ORIGINS`를 고친다.
- 로그는 `npx wrangler tail` 또는 대시보드 Workers Logs(`[observability] enabled`)에서 본다. 허브마다 1분에 한 줄이다.
- DO 클래스 이름을 바꾸면 `renamed_classes` 마이그레이션을 더해야 한다(그냥 바꾸면 기존 객체를 잃는다).

## 요금·한도 (2026-11 Cloudflare 문서 기준)

| | Workers Free | Workers Paid (월 $5) |
|---|---|---|
| Durable Objects 요청 | 하루 100,000 | 월 100만 포함, 이후 100만당 $0.15 |
| 실행 시간 | 하루 13,000 GB-s | 월 40만 GB-s 포함, 이후 100만 GB-s당 $12.50 |
| 저장소 | SQLite 객체만, 계정 5 GB | |

- 요청으로 세는 것: WebSocket 연결 한 번, **들어오는** WebSocket 메시지 20개(20:1), 알람 한 번. 나가는 메시지와 프로토콜 ping은 세지 않는다. 20:1 각주는 문서 표의 유료 열에만 붙어 있어 무료에도 같은지는 문서로 확인하지 못했다. 아래 계산은 20:1을 가정한다.
- 실행 시간: 객체가 깨어 있는 동안 128 MB × 초. Hibernation API를 쓰므로 메시지가 없는 대기실·로비는 거의 0이고, 하트비트 자동 응답은 실행 시간이 붙지 않는다.
- 무료 한도를 넘으면 Workers는 Error 1027을 내고 UTC 자정(한국 오전 9시)에 초기화된다.

| 경기 중인 방 하나(한 사람 초당 약 15프레임 가정) | 요청 | 실행 시간 |
|---|---|---|
| 8명 | 120 msg/s → 6 요청/s → 시간당 21,600 → **무료로 하루 약 4.6 방-시간** | 시간당 450 GB-s → 하루 약 28.9 방-시간 |
| 4명 | 60 msg/s → 3 요청/s → 시간당 10,800 → 하루 약 9.3 방-시간 | 같음 |
| 2명 | 30 msg/s → 1.5 요청/s → 시간당 5,400 → 하루 약 18.5 방-시간 | 같음 |

- 유료라면 8명 방 1시간 ≈ 요청 21,600(약 $0.0032) + 450 GB-s(약 $0.0056) ≈ **$0.009**다. 포함량(요청 100만·40만 GB-s)만으로 8명 방 약 46시간이다.
- 무료로 오래 버티려면 `SKALA_CONFIG.relay.hz`를 낮춘다(10이면 요청이 약 2/3). 실제 프레임 수는 알람 로그의 `msgsIn`으로 잰다.
- 로컬 실측(2026-11-09, `wrangler dev`, 헤드리스 QA 2인 경기): 방 허브가 60초에 받은 메시지 253~267건, 곧 한 사람 초당 약 2건, 메시지 평균 약 400자. QA 플레이어는 대부분 서 있어서 `sync.js`가 상태를 2Hz로 줄인 값이다. 계속 움직이면 한 사람 초당 10~15건이 되므로 위 표가 실제보다 크게 잡은 쪽이다.
- 아직 실제 Cloudflare에 배포해 재지 않았다. 위 표는 문서의 단가와 게임의 전송 빈도로 계산한 값이다.

## 남은 한계와 다음 단계(권위 서버로)

지금 서버는 형식·속도·보낸이만 지킨다. 판정과 신원은 아직 클라이언트에 있다.

1. **신원**: presence 키(플레이어 id)를 클라이언트가 정한다. 다른 사람 id로 참가하면 그 사람 이름으로 보낼 수 있다(Supabase 때와 같다). → Worker가 토큰(예: Supabase 세션 JWT나 계정 RPC가 발급한 HMAC 토큰)을 확인해 id를 서버가 정한다.
2. **로비 항목**: 방장이 올리는 presence라 가짜 방을 올릴 수 있다. → 방 허브가 인원·상태를 직접 세어 로비 허브에 알린다(DO끼리 RPC).
3. **강퇴·정원**: 서버는 `_kick`을 대상에게 전달만 한다. 고친 클라이언트는 무시할 수 있다(게임이 그 사람의 메시지를 버린다). → 서버가 방장을 정하고(서버 기준 참가 순서) 강퇴한 연결을 끊는다.
4. **판정**: `feature/authoritative-server`의 `server/core/room.js`(`createRoom({ send })`)를 이 방 허브 자리에 얹는다. 이동·사격·라운드 규칙은 `js/engine/physics.js`·`movement.js`, `js/game/match.js`를 그대로 쓴다. 무료 플랜 CPU가 호출당 10 ms일 수 있으니 틱 시간을 실제 객체에서 먼저 잰다(그 브랜치의 Node 측정은 6명 방 최대 8.2 ms).
5. **기록**: 경기 결과를 서버가 Supabase에 기록(경기 id로 멱등)해 클라이언트 보고를 대신한다.
6. **측정**: 배포 뒤 알람 로그로 방별 실제 메시지 수를 재서 위 요금 표를 실측 값으로 바꾼다.
