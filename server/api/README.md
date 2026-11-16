<!--
  Date: 06NOV2026
  Author: Minkyu Jung
  Purpose: 로그인 연결·테스트 결제 API(server/api) 안내. 구조와 흐름, 무엇을 서버가 확인하는지, 설정·배포 순서(Supabase·구글·카카오·토스·Worker·게임 설정),
           도메인 붙이기, 문제 해결, 요금·한도.
-->
# SKALA 작전 로그인 연결·테스트 결제 API (Cloudflare Worker)

게임에 두 가지를 더한다.

1. **구글·카카오 로그인 연결(OAuth 2.0 + OpenID Connect).** 지금 계정은 기기마다 만든 토큰이라 브라우저를 바꾸면 닉네임을 찾을 수 없다. 외부 계정을 이어 두면 다른 기기에서 로그인해 같은 닉네임·포인트를 쓴다. 이메일·이름 같은 개인정보는 받지 않는다(`scope=openid`, 고유 id만).
2. **토스페이먼츠 테스트 결제로 코인 충전.** 코인은 서버만 바꾸는 잔액이고 꾸미기(이모트·캐릭터)만 산다(무기는 팔지 않는다). 테스트 키라 실제로 돈이 나가지 않는다. **사업자등록 없이** 개발자센터 테스트 키로 끝까지 돈다.

무료 플랜 Worker 하나(`skala-api`)와 기존 Supabase 프로젝트를 쓴다. 중계 서버(`server/relay`)와는 따로 배포해, 결제 쪽 실수가 게임 중계를 멈추지 않게 했다.

## 구조

```
게임(GitHub Pages) ──JSON(기기 토큰은 본문)──▶ skala-api Worker ──비밀 키──▶ Supabase fps_api_* 함수(schema.sql)
     │  ▲                                        │   ▲
     │  └── 구글·카카오 인가 화면에서 code 들고 돌아옴  │   └── 토스: 결제창 결과(success/fail), 웹훅
     └────────────▶ 결제 페이지(/pay/checkout, Worker가 내보냄) ──▶ 토스 결제창
```

- 신원은 기존 **기기 토큰**(64자 hex)이다. 쿠키를 쓰지 않으므로 게임 주소(github.io)와 Worker 주소(workers.dev)가 달라도 된다.
- Supabase 쪽 새 함수 `fps_api_*`는 `service_role`만 부를 수 있다. 브라우저의 공개 키로는 부를 수 없다(`tests/api-sql.test.mjs`가 확인).
- 토스 결제 SDK는 게임 페이지가 아니라 **Worker의 결제 페이지에서만** 돈다. 외부 스크립트가 게임의 기기 토큰(localStorage)에 닿지 않고, 게임 CSP에 토스 주소를 열 필요가 없다.

## 로그인 흐름

1. 게임이 `state`·`nonce`·PKCE `code_verifier`를 만들어 sessionStorage에 두고 구글(또는 카카오) 인가 화면으로 보낸다(`code_challenge` = SHA-256, `prompt=select_account`).
2. 제공자가 게임 주소로 `?code=…&state=…`를 붙여 돌려보낸다. 게임은 `state`를 대조하고 주소에서 code를 지운다.
3. 게임이 `POST /auth/exchange { code, codeVerifier, redirectUri, nonce }`. Worker가 client secret과 verifier로 code를 토큰으로 바꾸고, **ID 토큰을 검증**한다: RS256 서명(제공자 JWKS, 열쇠는 1시간 캐시·모르는 kid면 1분에 한 번 다시 받음), `iss`, `aud`(우리 client id), `exp`·`iat`(2분 여유), `nonce`. 액세스 토큰은 버린다.
4. Worker가 **로그인 표**(10분, HMAC 서명, `jti`)와 "이 계정에 이어진 닉네임"을 돌려준다.
5. 게임이 고른다.
   - 이어진 닉네임이 없고 이 기기에 닉네임이 있다 → `POST /auth/link` (이 기기의 닉네임에 잇는다).
   - 이어진 닉네임이 있고 이 기기가 새 기기다 → 기기가 **새 토큰을 만들어** `POST /auth/login`. 서버가 그 토큰을 그 사람의 토큰으로 더하고(`fps_tokens`, 사람마다 최근 10개), 게임은 이 기기 토큰을 바꾼 뒤 서버 프로필을 받는다.
   - 이 기기에 다른 닉네임이 있다 → 마이페이지에서 바꿀지 먼저 묻는다.
   - 게이트(닉네임이 없는 첫 화면)에서 로그인했는데 이어진 닉네임이 없다 → 닉네임을 정하는 즉시 그 계정에 잇는다.
6. 표는 DB(`fps_auth_used`)가 한 번만 쓰게 한다. 같은 표로 두 번 로그인하거나 잇지 못한다.

로그아웃은 이은 계정이 있을 때만 된다(없으면 그 닉네임을 다시 찾을 길이 없다). 로그인으로 더한 토큰은 `revoked_at`을 찍고, 처음 기기 토큰은 쓸 수 없는 값으로 바꾼다.

## 결제 흐름

1. 게임: `POST /pay/orders { token, productId, returnUrl }`. 금액·코인은 Worker 상품표(`src/pay.js PRODUCTS`)가 정한다. DB가 사람·하루 한도(24시간에 결제를 마친 주문 3개)·10분에 주문 10개를 확인하고 `READY` 주문을 만든다.
2. 게임이 결제 페이지(`/pay/checkout?order=…`)로 간다. 버튼을 누르면 토스 결제창(구버전 결제창, API 개별 연동 키)이 열린다.
3. 토스가 `/pay/success?paymentKey&orderId&amount`로 보낸다. Worker는 **돌아온 금액을 주문 금액과 대조**하고(다르면 승인을 부르지 않는다), 주문을 `CONFIRMING`(paymentKey 기록)으로 바꾼 뒤 **승인 API**를 부른다(시크릿 키 Basic 인증, 멱등키 `confirm-<orderId>`).
4. 승인이 `DONE`이면 한 트랜잭션에 주문 `DONE` + 원장(`fps_coin_ledger`) 한 줄 + 코인. 같은 주문으로 코인이 두 번 들어가지 않는다(원장의 부분 유일 색인).
5. 게임 주소로 `#skala-pay=done|fail|pending&order=…`를 붙여 돌려보낸다. 해시라서 GitHub Pages로 가지 않고, 게임은 읽은 뒤 지운다.

결과를 모르는 경우(승인 응답이 끊김)는 주문이 `CONFIRMING`으로 남고 두 곳에서 정리한다.
- **웹훅** `POST /pay/webhook`(`PAYMENT_STATUS_CHANGED`): 본문은 믿지 않고 paymentKey로 토스에 다시 물어 그 기록으로 맞춘다. DB 문제로 처리하지 못하면 500으로 답해 토스가 다시 보낸다(최대 7번).
- **대사(cron, 10분마다)**: `CONFIRMING`·`CANCELING`이 2분 넘게 그대로면 토스에 묻는다. 한 시간 넘게 결제하지 않은 `READY`는 `EXPIRED`로 바꾼다(승인을 부르지 않았으니 돈이 움직이지 않았다).

환불(`POST /pay/cancel`)은 내 주문·`DONE`·결제 7일 이내·그 코인을 아직 쓰지 않았을 때만 된다. 코인을 먼저 빼고(`CANCELING`, 그 사이에 쓰지 못하게) 토스 취소 API(멱등키 `cancel-<orderId>`)를 부른다. 취소가 거절되면 코인을 돌려놓는다. 상점관리자에서 직접 취소한 결제는 웹훅·대사가 코인을 뺀다(모자라면 있는 만큼).

라이브 키(`live_…`)는 `PAY_ALLOW_LIVE=true`가 아니면 받지 않는다. 사업자 계약 전에는 실수로라도 실제 결제가 일어나지 않는다.

## 설정과 배포

### 1. Supabase

1. SQL Editor에서 `supabase/schema.sql`을 처음부터 끝까지 다시 실행한다(여러 번 실행해도 안전하다). 새 표 `fps_tokens`·`fps_identities`·`fps_auth_used`·`fps_orders`·`fps_coin_ledger`와 `fps_players.coins`, 함수 `fps_api_*`가 생긴다.
2. Project Settings → API Keys에서 **Secret key**(`sb_secret_…`)를 복사해 둔다. 이 키는 RLS를 건너뛰는 관리자 키라 Worker secret에만 넣는다. 게임 파일·저장소에 넣지 않는다.

### 2. 구글 OAuth 클라이언트

1. Google Cloud Console → API 및 서비스 → OAuth 동의 화면: 외부, 앱 이름·지원 이메일. 범위는 `openid`만 쓴다.
2. 사용자 인증 정보 → OAuth 클라이언트 ID 만들기 → **웹 애플리케이션**.
3. 승인된 리디렉션 URI에 게임 주소를 **글자 그대로** 넣는다: `https://jungmk0720.github.io/skala-fps/` (로컬 시험은 `http://localhost:8080/`도). 게임은 이 페이지의 폴더 주소(쿼리 없음)를 redirect_uri로 보낸다.
4. 클라이언트 ID와 클라이언트 보안 비밀번호를 받는다. 테스트 중에는 동의 화면의 테스트 사용자만 로그인된다. 모두 쓰게 하려면 앱을 게시한다(콘솔 안내를 따른다).

### 3. 카카오 로그인 (선택)

developers.kakao.com → 내 애플리케이션 → 앱 키의 **REST API 키**가 client id다. 카카오 로그인 활성화, **OpenID Connect 활성화**, Redirect URI에 위와 같은 게임 주소를 넣는다. 보안 → Client Secret을 켰다면 그 값도 넣는다. 개인 개발자도 쓸 수 있고 이메일은 받지 않으므로 비즈 앱 전환이 필요 없다. 카카오의 PKCE는 공식 문서에 표가 없고 개발자 포럼 답변 기준으로 지원된다.

### 4. 토스페이먼츠 테스트 키

개발자센터 → API 키에서 **API 개별 연동 키**의 테스트 클라이언트 키(`test_ck_…`)와 시크릿 키(`test_sk_…`)를 쓴다. 전자결제 신청 전에도 보이는 키다. 두 키는 한 쌍이어야 한다(섞으면 `INVALID_API_KEY`).

### 5. Worker 배포

```bash
cd server/api
npm install
npx wrangler secret put SUPABASE_SECRET_KEY      # sb_secret_…
npx wrangler secret put AUTH_SECRET              # 32글자 이상 무작위 값. 아래 명령으로 만든다
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put TOSS_CLIENT_KEY          # test_ck_…
npx wrangler secret put TOSS_SECRET_KEY          # test_sk_…
npm run deploy
```

`AUTH_SECRET`은 `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`로 만든다. 카카오를 쓰면 `KAKAO_CLIENT_ID`(와 켰다면 `KAKAO_CLIENT_SECRET`)도 넣는다. 배포 전 묶음 검사는 `npm run check`(wrangler dry-run)다.

배포 주소(`https://skala-api.<계정 하위 도메인>.workers.dev`)의 `/features`를 열어 `db:true`, `login.providers`에 구글, `pay.enabled:true`가 보이면 된다.

### 6. 게임 설정

1. `js/config.js`의 `api.url`에 Worker 주소를 넣는다.
2. `index.html` CSP의 `connect-src`에 같은 `https://…` 주소를 더한다(`tests/web-security.test.mjs`가 확인).
3. 게임 주소를 바꾸면(도메인) `server/api/wrangler.toml`의 `ALLOWED_ORIGINS`와 구글·카카오 Redirect URI도 함께 바꾼다.

### 7. 토스 웹훅 (권장)

개발자센터 → 웹훅 → `https://<Worker 주소>/pay/webhook`, 이벤트 `PAYMENT_STATUS_CHANGED`. 없어도 대사(cron)가 정리하지만 웹훅이 더 빠르다.

### 8. 확인

마이페이지 → 계정 연결 → 구글 계정 연결 → 다른 브라우저(시크릿 창)의 닉네임 게이트에서 "구글로 불러오기" → 같은 닉네임이 들어온다. 상점 → 코인 탭 → 충전하기 → 테스트 결제 → 코인이 들어오고 구매 내역에 "완료" → 캐릭터 탭에서 "코인 N개로 사기" → 코인 탭에서 환불(쓰지 않은 주문만).
QA는 가짜 API로 같은 흐름을 돈다: `npm run qa:hidden -- --only online`.

## 도메인 붙이기 (선택)

Cloudflare에서 산 도메인이 있으면 Workers & Pages → `skala-api` → Settings → Domains & Routes → Add → Custom Domain에 `api.<도메인>`을 넣는다(무료, 인증서 자동). 그 뒤 `js/config.js`의 `api.url`, `index.html` CSP, 토스 웹훅 주소를 새 주소로 바꾼다. 게임 주소는 그대로 GitHub Pages여도 된다(쿠키를 쓰지 않으므로). 게임까지 `play.<도메인>`으로 옮기면 `ALLOWED_ORIGINS`와 구글·카카오 Redirect URI에 그 주소를 더한다.

## 문제 해결

| 증상 | 원인 |
|---|---|
| `/features`가 `db:false` | `schema.sql`을 다시 실행하지 않았거나(`fps_api_ping`이 404) `SUPABASE_SECRET_KEY`가 틀렸다 |
| `login.providers`가 비었다 | `AUTH_SECRET`이 없거나 32글자보다 짧다, 구글은 client secret도 있어야 한다 |
| 구글 화면에 `redirect_uri_mismatch` | 콘솔의 리디렉션 URI가 게임 주소와 글자 하나라도 다르다(끝의 `/` 포함) |
| 로그인 뒤 "로그인 정보를 확인하지 못했어요" | Worker 로그(`npm run tail`)의 `id_token_rejected` 이유: `aud`면 client id가 다르다 |
| `pay.reason`이 `keys`·`key_mismatch`·`live_key` | 토스 키가 없다·한 쌍이 아니다·라이브 키다 |
| 브라우저 콘솔에 CSP·CORS 오류 | `index.html` connect-src에 Worker 주소가 없거나, 게임 주소가 `ALLOWED_ORIGINS`에 없다 |

## 요금과 한도

무료 플랜으로 돈다. Workers 무료는 하루 요청 10만 건, 호출당 CPU 10 ms(구글·토스·Supabase 응답을 기다리는 시간은 넣지 않는다), 요청당 하위 요청 50개다. 로그인 한 번은 Worker 요청 2~3건, 결제 한 번은 4~5건이다. 결제 기록은 로그가 아니라 DB 원장에 남는다.

## 파일

| 파일 | 하는 일 |
|---|---|
| `src/worker.js` | 입구, 주소 나누기, CORS, `/features`, cron |
| `src/auth.js` | 교환·잇기·로그인·로그아웃·내 정보 |
| `src/oauth.js` | 제공자 표, 인가 코드 교환, ID 토큰 검증(JWKS) |
| `src/ticket.js` | 로그인 표 서명·검증 |
| `src/pay.js` | 상품표, 주문·결제 페이지·성공·실패·웹훅·환불·코인으로 사기·대사 |
| `src/pages.js` | 결제 페이지 HTML·CSP·`/pay/checkout.js` |
| `src/toss.js`, `src/db.js` | 토스 API, Supabase RPC |
| `src/http.js`, `src/crypto.js` | HTTP·Origin·주소 검사, base64url·HMAC |

시험: `tests/api-worker.test.mjs`(Worker, 가짜 Supabase·토스·구글), `tests/api-sql.test.mjs`(SQL과 Worker의 약속), `tests/account-online.test.mjs`(브라우저 쪽 흐름), QA `tools/qa/scenarios/online.mjs`.
