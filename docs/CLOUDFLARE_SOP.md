<!--
  Date: 06NOV2026
  Author: Minkyu Jung
  Purpose: Cloudflare 중계 서버(server/relay) 운영 절차(SOP). 준비, 로컬 확인, 로그인, 배포, 배포 확인, 게임 전환, 감시, 되돌리기, 문제 해결, 유료 전환, 변경 관리.
-->
# Cloudflare 중계 서버 운영 절차 (SOP)

멀티플레이 메시지 중계를 Supabase Realtime에서 Cloudflare Worker + Durable Objects(`server/relay`)로 옮기는 절차다. 서버 구조와 규약은 [server/relay/README.md](../server/relay/README.md)에 있다.

| 항목 | 내용 |
|---|---|
| 지금 상태 | 2026-11-10에 Worker를 `https://skala-relay.skala-fps.workers.dev`로 배포했다(무료 플랜, 하위 도메인 `skala-fps`). 게임은 `js/config.js`의 `transport: 'relay'`로 이 서버를 쓴다. 아래 절차는 다시 배포하거나 다른 계정으로 옮길 때도 그대로 쓴다 |
| 목표 | Worker 배포 → 배포 주소 확인 → 게임을 `transport: 'relay'`로 전환 → 실제 사용량 측정 |
| 소유자만 할 수 있는 일 | Cloudflare 가입·로그인, 플랜(무료·유료) 결정, 대시보드 확인 |
| 걸리는 시간 | 처음 한 번 30~60분 |
| 비용 | 무료 플랜은 0원이다. 한도를 넘으면 요금 대신 오류가 난다(7절). 유료 플랜은 월 $5부터다 |
| 되돌리기 | `transport: 'supabase'` 한 줄로 바로 돌아간다(8절) |

- 명령은 Windows PowerShell 기준이다. 따로 적지 않으면 저장소 루트에서 실행한다.
- `<sub>`는 4절에서 정하는 계정의 workers.dev 하위 도메인이다. 배포 주소는 `https://skala-relay.<sub>.workers.dev`가 된다.

## 0. 체크리스트

- [ ] 1. 준비: Cloudflare 가입, `server/relay`에서 `npm ci`, 플랜 결정
- [ ] 2. 로컬 확인: `npm run dev`, smoke 통과
- [ ] 3. 로그인: `npx wrangler login`, `npx wrangler whoami`
- [ ] 4. 배포: `npx wrangler deploy`, 주소 기록
- [ ] 5. 배포 확인: `/health`, 배포 주소로 smoke 통과
- [ ] 6. 게임 전환: `js/config.js`와 CSP 수정, `npm run check`, `main` 반영
- [ ] 7. 운영 확인: 두 기기로 한 판, `npx wrangler tail`, 대시보드 사용량
- [ ] 8. 문제가 생기면 되돌리기

## 1. 준비

1. Cloudflare 계정을 만든다(<https://dash.cloudflare.com/sign-up>, 무료). 가입 확인 메일 인증까지 끝낸다. 무료 플랜은 결제 수단이 필요 없다.
2. Node 버전을 확인한다. 20 이상이어야 한다.
   ```powershell
   node -v
   ```
3. 최신 `main`에서 시작한다.
   ```powershell
   git switch main
   git pull --ff-only
   ```
4. wrangler를 설치한다. 버전은 `server/relay/package.json`에 4.158.0으로 고정돼 있다.
   ```powershell
   cd server/relay
   npm ci
   npx wrangler --version
   ```
   `4.158.0`이 나오면 된다.
5. 플랜을 정한다. **무료로 시작하는 것을 권장한다.**

   | | Workers Free | Workers Paid (월 $5) |
   |---|---|---|
   | Durable Objects 요청 | 하루 100,000 | 월 100만 포함, 이후 100만당 $0.15 |
   | 실행 시간 | 하루 13,000 GB-s | 월 40만 GB-s 포함, 이후 100만 GB-s당 $12.50 |
   | 한도를 넘으면 | 다음 초기화(한국 오전 9시)까지 그 종류의 요청이 오류로 실패 | 넘은 만큼만 과금 |
   | 경기 시간으로 바꾸면(README 계산) | 8명 방 하루 약 4.6시간, 2명 방 하루 약 18.5시간 | 포함량만으로 8명 방 월 약 46시간, 그 뒤 시간당 약 $0.009 |

   - 요청은 연결 한 번, **들어오는** WebSocket 메시지 20개, 알람 한 번이 각각 1이다. 나가는 메시지는 세지 않는다.
   - 20:1 비율은 문서의 유료 열에만 적혀 있다. 무료 플랜에도 같은지는 7절에서 실제 사용량으로 확인한다.
   - 무료로 시작하고, 7절 실측이 하루 한도의 절반을 넘는 날이 이어지면 유료로 바꾼다(10절). 코드는 바꾸지 않아도 된다.

## 2. 로컬에서 먼저 확인 (권장, 로그인 없이 된다)

창 두 개를 쓴다. 창 1은 `server/relay`에서, 창 2는 저장소 루트에서 실행한다.

```powershell
# 창 1 (server/relay)
$env:WRANGLER_SEND_METRICS = 'false'   # wrangler 사용 통계를 보내지 않는다(선택)
npm run dev                             # http://127.0.0.1:8788
```

```powershell
# 창 2 (저장소 루트)
node server/relay/tools/smoke.mjs http://127.0.0.1:8788
```

- **성공 기준:** 마지막 줄이 `통과: 검사 22개, …초`다. 실패하면 멈춘 단계가 찍힌다. 그때는 배포하지 않고 원인부터 고친다.
- 다 보면 창 1에서 `Ctrl+C`로 끈다.

## 3. 로그인

```powershell
cd server/relay
npx wrangler login
```

1. 브라우저가 열리면 Cloudflare에 로그인하고 **Allow**를 누른다. 터미널에 로그인 성공 문구가 나오면 된다.
2. 브라우저가 열리지 않으면 터미널에 찍힌 주소를 복사해 브라우저에 붙여 넣는다.
3. 콜백 주소(`localhost:8976`)가 막히면 `npx wrangler login --device`를 쓴다. 터미널에 나온 주소를 열고 코드를 입력하는 방식이다.
4. 로그인됐는지 확인한다.
   ```powershell
   npx wrangler whoami
   ```
   계정 이메일과 Account ID가 보이면 된다.

- 로그인 정보는 이 PC의 사용자 폴더에 평문 파일로 저장된다. 저장소에는 아무것도 생기지 않는다. OS 자격 증명 저장소에 두려면 `npx wrangler login --use-keyring`으로 로그인한다.
- 다 쓴 뒤 지우려면 `npx wrangler logout`을 실행한다.
- API 토큰은 저장소 파일이나 커밋 메시지에 적지 않는다.

## 4. 배포

```powershell
cd server/relay
npx wrangler deploy
```

`npm run deploy`도 같은 명령이다.

1. **처음 한 번만:** 계정에 workers.dev 하위 도메인이 없으면 wrangler가 등록할지 묻는다. 영문 소문자로 이름을 정한다. 이 이름은 공개 주소에 들어가므로 이메일이나 실명은 쓰지 않는다. 대시보드 **Workers & Pages**에서 미리 정해 둬도 된다.
2. 첫 배포에서 마이그레이션 `v1`이 SQLite 클래스 `RelayHub`를 만든다. 무료 플랜은 SQLite 클래스만 쓸 수 있고, `wrangler.toml`이 이미 그렇게 돼 있다. 따로 할 일은 없다.
3. 출력 끝의 주소 `https://skala-relay.<sub>.workers.dev`를 적어 둔다.
4. 새 하위 도메인은 열리기까지 몇 분 걸릴 수 있다. 5절이 바로 실패하면 2~3분 뒤 다시 해 본다.

## 5. 배포 확인

```powershell
curl.exe https://skala-relay.<sub>.workers.dev/health
```

`{"ok":true,"service":"skala-relay"}`가 나와야 한다.

```powershell
# 창 1 (server/relay): 실시간 로그
npx wrangler tail
```

```powershell
# 창 2 (저장소 루트)
node server/relay/tools/smoke.mjs https://skala-relay.<sub>.workers.dev
```

- **성공 기준:** smoke 마지막 줄이 `통과: 검사 22개, …초`다.
- 창 1에는 허브마다 1분에 한 줄씩 요약이 찍힌다. 연결 수, `msgsIn`, `dropped`, `rejected` 같은 값이 들어 있다.
- smoke는 Origin 머리글 없이 붙으므로 Origin 검사와 상관없이 통과한다. 브라우저의 Origin은 7절에서 확인한다.
- 여기까지는 게임에 영향이 없다. 게임은 아직 Supabase를 쓴다.

## 6. 게임 전환

브랜치를 하나 따서 파일 두 개를 고친다.

```powershell
git switch -c feature/relay-on main
```

1. `js/config.js`
   ```js
   transport: 'relay',
   relay: { url: 'https://skala-relay.<sub>.workers.dev', hz: 20 }
   ```
   - 주소는 `https://`로 시작하고 뒤에 경로를 붙이지 않는다. 시험이 이 형식을 확인한다. 클라이언트가 이 주소를 `wss://…/ws`로 바꿔 붙는다.
2. `index.html` CSP의 `connect-src`에 주소 두 개(`https://`, `wss://`)를 더한다.
   ```
   connect-src 'self' https://tvsoacvbjvggqdgnzijc.supabase.co wss://tvsoacvbjvggqdgnzijc.supabase.co https://skala-relay.<sub>.workers.dev wss://skala-relay.<sub>.workers.dev;
   ```
   Supabase 주소는 지우지 않는다. 닉네임·포인트·구매는 계속 Supabase를 쓴다.
3. 검사를 돌린다.
   ```powershell
   npm run check
   ```
   `tests/web-security.test.mjs`의 "중계 서버를 쓰면 그 주소(https·wss)가 connect-src에 있다"가 통과해야 한다.
4. 커밋하고 PR을 열어 `main`에 반영한다. GitHub Pages가 1~2분 안에 다시 배포한다.
5. Pages는 파일을 최대 10분 동안 캐시한다(`Cache-Control: max-age=600`). 확인할 때는 `Ctrl+F5`로 새로 받는다.

## 7. 운영 확인과 감시

### 7.1 실제로 한 판 해 보기

1. 기기 두 대(예: 휴대폰과 노트북)에서 배포 사이트를 연다.
2. PC 브라우저 개발자 도구(F12) → **Network** → **WS**(또는 **Socket**) 필터를 연다. `skala-relay.<sub>.workers.dev/ws?hub=…lobby` 연결이 `101`이면 중계 서버를 쓰고 있는 것이다.
3. 방 만들기 → 참가 → 준비 → 짧은 경기 → 채팅 → 결과 화면까지 한 번 돈다. 비밀번호 방도 한 번 만들어 본다.
4. 그동안 `npx wrangler tail`에 그 방 허브의 요약 줄이 1분마다 나오는지 본다. `rejected`와 `dropped`는 0에 가까워야 한다.

### 7.2 매일 볼 것

| 무엇 | 어디서 | 기준 |
|---|---|---|
| Durable Objects 요청 수 | 대시보드 **Durable Objects** → `RelayHub` 네임스페이스 → **Metrics** | 무료는 하루 100,000(청구 기준). 아래 첫 줄처럼 환산해서 절반을 넘는 날이 이어지면 10절 |
| 실행 시간 | 같은 곳 | 무료는 하루 13,000 GB-s |

- **대시보드 지표는 20:1을 적용하기 전의 실제 메시지 수다**(Cloudflare 문서: 20:1은 청구에만 쓰고 지표에는 쓰지 않는다). 청구되는 요청은 대략 `들어온 WebSocket 메시지 ÷ 20 + 연결 수 + 알람 수`다. 대시보드 숫자를 그대로 100,000과 비교하면 20배 크게 잡힌다.
| Worker 요청·오류 | 대시보드 **Workers & Pages** → `skala-relay` → Metrics, Observability → Logs | 오류가 0이 아니면 9절 |
| 허브 요약 로그 | Observability → Logs, 또는 `npx wrangler tail` | 허브마다 1분에 한 줄 |

- 무료 한도는 매일 00:00 UTC(한국 오전 9시)에 초기화된다.
- Workers Logs 무료는 하루 200,000건, 3일 보관이다. 2026-12-01부터 Cloudflare Observability 요금으로 바뀐다고 공지돼 있다. 그 뒤에 한도를 다시 확인한다.
- 대시보드 메뉴 이름은 바뀔 수 있다.

### 7.3 실측 기록

일주일쯤 쓴 뒤 하루 요청 수, 실행 시간, 그날 경기 시간을 [server/relay/README.md](../server/relay/README.md)의 "요금·한도" 절에 실측값으로 적는다. 로그로 계산한 값(허브의 1분 `msgsIn` 합 × 60 ÷ 20)과 대시보드 값이 맞는지도 비교한다. 20:1 비율이 무료 플랜에도 맞는지 여기서 확인된다.

## 8. 되돌리기

**게임만 Supabase로 되돌리기:** 가장 빠른 방법이다. 문제가 생기면 이것부터 한다.

1. `js/config.js`의 `transport`를 `'supabase'`로 바꾼다. `relay.url`과 CSP의 중계 주소는 그대로 둬도 된다.
2. `npm run check`를 돌리고 커밋해 `main`에 반영한다. Pages 반영에 1~2분, 캐시가 풀리는 데 최대 10분이 걸린다.
3. Worker는 그대로 둬도 된다. 연결이 없으면 요청도 실행 시간도 0이다.

**Worker만 이전 버전으로:** 서버 코드를 고쳐 다시 배포했는데 문제가 날 때 쓴다.

```powershell
cd server/relay
npx wrangler deployments list
npx wrangler rollback
```

- 인자 없이 실행하면 최근 버전 목록에서 고른다.
- Durable Object 마이그레이션이 바뀐 버전 사이에서는 되돌릴 수 없다. 지금은 `v1` 하나뿐이다.

## 9. 문제 해결

| 증상 | 원인 | 할 일 |
|---|---|---|
| `wrangler login`에서 브라우저가 안 열리거나 콜백이 실패한다 | 브라우저 연결, VPN, 방화벽 | 찍힌 주소를 직접 연다. 그래도 안 되면 `npx wrangler login --device` |
| deploy가 workers.dev 하위 도메인을 요구한다 | 계정에 하위 도메인이 없다 | 묻는 대로 등록하거나, 대시보드 **Workers & Pages**에서 정한 뒤 다시 deploy |
| `/health`가 열리지 않는다 | 새 하위 도메인이 아직 퍼지는 중이다 | 2~3분 뒤 다시 |
| 게임 콘솔에 `Content Security Policy` `connect-src` 위반이 찍힌다 | CSP에 중계 주소가 없거나 하나만 있다 | `https://`와 `wss://`를 둘 다 더했는지 본다 |
| WebSocket이 `403`(`origin_not_allowed`)으로 거절된다 | 사이트 주소가 `ALLOWED_ORIGINS`에 없다 | `server/relay/wrangler.toml`의 `ALLOWED_ORIGINS`를 고치고 다시 deploy |
| 연결이 코드 `4008`로 끊긴다 | 연결당 속도 제한(초당 40건)을 넘겨 10초에 200번 넘게 버려졌다 | 고친 클라이언트일 수 있다. 정상 플레이에서 반복되면 `relay.hz`를 낮춘다 |
| 연결이 코드 `4001`로 끊긴다 | 75초 동안 메시지도 하트비트도 없었다 | 탭이 백그라운드에서 멈춘 경우가 많다. 다시 들어오면 된다 |
| 한동안 접속이 안 되다 한국 오전 9시에 풀린다 | 무료 한도를 넘었다 | 8절로 Supabase로 되돌린다. 7.2 실측을 보고 10절 유료 전환이나 `relay.hz` 낮추기(10이면 요청 약 2/3)를 정한다 |
| smoke가 특정 단계에서 멈춘다 | 서버 코드나 설정 문제 | 2절 로컬에서 같은 단계가 되는지 본다. 로컬은 되고 배포만 안 되면 `npx wrangler tail`의 오류 줄을 본다 |

## 10. 유료 플랜으로 바꾸기 (필요할 때만)

1. 대시보드 **Workers & Pages** → **Plans**에서 **Workers Paid**(월 $5)를 고른다. 결제 수단 등록이 필요하다.
2. 코드와 설정은 바꾸지 않는다. 한도만 월 단위(요청 100만, 실행 시간 40만 GB-s 포함)로 바뀐다.
3. 바꾼 날짜와 이유를 7.3 실측 기록 옆에 남긴다.

## 11. 변경 관리

- 서버 코드를 고칠 때는 순서를 지킨다: 저장소 루트 `npm test` → 2절 로컬 smoke → `npx wrangler deploy` → 5절 smoke. 문제가 나면 8절의 `wrangler rollback`을 쓴다.
- 사이트 주소가 바뀌면 `wrangler.toml`의 `ALLOWED_ORIGINS`를 고쳐 다시 배포한다.
- Durable Object 클래스 이름(`RelayHub`)을 바꿀 때는 `renamed_classes` 마이그레이션을 더한다. 그냥 바꾸면 기존 객체를 잃는다.
- wrangler 버전은 `package.json`에 고정돼 있다. 올릴 때는 로컬 smoke와 QA(`npm run qa:hidden -- --only multi-play --relay http://127.0.0.1:8788`)를 먼저 통과시킨다.
- 나중에 자동 배포를 붙일 수 있다.
  - Cloudflare API 토큰("Edit Cloudflare Workers" 템플릿)과 Account ID를 GitHub 저장소 Secrets에 넣는다.
  - `server/relay/**`가 바뀐 `main` 푸시에만 `wrangler deploy`를 돌린다.
  - 토큰은 저장소 파일에 적지 않는다.

## 확인한 문서 (2026-11-10)

- Durable Objects 요금·무료 한도: <https://developers.cloudflare.com/durable-objects/platform/pricing/>
- Durable Objects 대시보드 지표: <https://developers.cloudflare.com/durable-objects/observability/metrics-and-analytics/>
- Workers Logs 한도·보관 기간: <https://developers.cloudflare.com/workers/observability/logs/workers-logs/>
- wrangler `login`·`whoami`·`logout`: <https://developers.cloudflare.com/workers/wrangler/commands/general/>
- Worker 되돌리기: <https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/>
- workers.dev 주소: <https://developers.cloudflare.com/workers/configuration/routing/workers-dev/>
