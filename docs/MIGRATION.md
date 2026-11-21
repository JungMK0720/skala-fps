<!--
  Date: 06NOV2026
  Author: Minkyu Jung
  Purpose: 도메인 구매 뒤 정적 사이트·Worker·인증·결제·AWS를 순서대로 이전하고 되돌리는 절차를 기록한다.
-->
# 도메인 이전 절차

현재 운영 주소는 아직 바꾸지 않았다. `docs/PRODUCT_PLAN.md` §3.2·§6·§7.2에 따른 준비 도구다. 아래 `example.io`는 예시이며 실제 구매한 이름으로 바꾼다. 기본 배치는 게임 `example.io`, API `api.example.io`, 로비 중계 `relay.example.io`, AWS 게임 서버 `game.example.io`다.

**목표: 사전 계정·키·프로젝트 준비 후 약 1시간의 작업으로 이전.** 도메인 등록·DNS/인증서 전파·OAuth 게시 심사·지원금 승인은 별도 대기 시간이 든다. 이 작업은 서버 판정 구현이나 실결제 전환을 포함하지 않는다.

## 0. 먼저 준비할 것 (이전 전날)

- GitHub, Cloudflare(Registrar/Pages/Workers), Google Cloud, Kakao Developers, Toss, AWS 콘솔 접근 권한과 다중 인증. 비밀 값은 기존 Worker secrets에 남기고 복사해 문서에 쓰지 않는다.
- 현재 배포 커밋과 Pages/Worker 배포 버전, 원래 `js/config.js` URL·Origin 허용 목록·DNS 값을 개인 운영 기록에 보관한다. 이전 전 커밋에 태그를 달아 롤백 위치를 정한다.
- **기존 사용자는 이전 전에 구글/카카오 계정을 연결하도록 공지한다.** 브라우저 localStorage의 기기 토큰은 다른 origin으로 자동 이동하지 않는다. 연결 계정이 없는 사용자는 새 주소에서 같은 진행 상황을 자동 복구할 수 없다. 토큰을 URL/채팅으로 옮기거나 모으지 않는다. 기존 사이트를 남기고 계정 연결 경로를 유지한다.
- 출시 이름은 소유자가 결정한다. 상표 확인 후 `js/core/brand.js`의 `BRAND.name`/`BRAND.nameEn`만 고친다. 도메인을 바꾸는 도구는 브랜드를 고르지 않는다.
- 저장소 변수 `CLOUDFLARE_PAGES_PROJECT`에 만들 프로젝트 이름(소문자·숫자·하이픈)을 넣을 준비를 한다.

## 1. 도메인 구매 (약 10분, 구매 승인 제외)

1. Cloudflare 대시보드 → Domain Registration에서 원하는 이름의 등록 가능 여부·첫해/갱신 가격을 확인한다. 기획서의 가격은 과거 참고값이다. AWS 지원금으로 도메인을 살 수 있다고 가정하지 않는다.
2. 등록자 정보·결제·자동 갱신·이메일 인증을 마친다. 기존 도메인을 옮기는 경우에는 Cloudflare 네임서버 활성화를 먼저 끝낸다.
3. 현재 DNS를 내보내 보관하고 메일(MX/TXT) 등 기존 레코드는 지우지 않는다. TLS 모드는 Full (strict)을 유지한다.

## 2. Pages 프로젝트와 배포 자격 준비 (약 10분)

1. Workers & Pages → Create → Pages → Direct Upload 방식으로 프로젝트를 만든다. 저장소 이름과 같을 필요는 없다. 프로젝트 production branch는 `main`이다. Git 연동 자동 빌드와 이 워크플로를 동시에 켜서 이중 배포하지 않는다.
2. GitHub 저장소 Settings → Secrets and variables → Actions:
   - secret `CLOUDFLARE_API_TOKEN`: 해당 계정의 **Cloudflare Pages: Edit**와 필요한 계정 읽기 권한만 가진 토큰.
   - secret `CLOUDFLARE_ACCOUNT_ID`: Pages 프로젝트가 속한 계정 ID.
   - variable `CLOUDFLARE_PAGES_PROJECT`: 위 프로젝트 이름. secrets와 달리 Repository variable이다.
3. `.github/workflows/deploy-pages.yml`은 `main` push 또는 수동 실행 때 Node 24에서 `npm run check` → `node tools/build-site.mjs` → `wrangler pages deploy dist --project-name <변수> --branch main` 순서다. 토큰이나 계정 ID가 없으면 검사는 돌되 배포는 **notice를 남기고 건너뛴다**. 값이 있는데 프로젝트 변수가 없으면 실패한다.
4. 첫 업로드 후 Pages → Custom domains에서 `example.io`를 추가하고 제공되는 DNS 레코드를 적용한다. 대시보드가 관리하는 레코드를 임의로 따로 덮어쓰지 않는다. 인증서가 Active가 될 때까지 기다린다.

## 3. Worker 맞춤 도메인·외부 콘솔 준비 (약 10분)

1. `skala-api` → Settings → Domains & Routes → Custom Domain → `api.example.io`.
2. `skala-relay`도 같은 방법으로 `relay.example.io`. DNS/인증서가 Active인지 본다. 기존 workers.dev 주소·서비스·Durable Object 바인딩은 지우지 않는다.
3. **Google Cloud Console** → 웹 OAuth 클라이언트:
   - 승인된 JavaScript 원본: `https://example.io`.
   - 승인된 Redirect URI: **`https://example.io/`** (끝의 슬래시 포함, API 주소가 아님).
   - 동의 화면의 앱 이름·홈페이지·개인정보처리방침 URL을 새 브랜드·`https://example.io/privacy.html`로 맞춘다. 기존 GitHub Pages URI는 병행 기간 동안 남긴다.
4. **Kakao Developers** → 앱 → 플랫폼 웹 사이트 도메인 `https://example.io`, 카카오 로그인 Redirect URI `https://example.io/`. OpenID Connect 활성화·기존 REST API 키/secret은 유지한다. 기존 URI도 남긴다.
5. **Toss 개발자센터** → 웹훅 URL `https://api.example.io/pay/webhook`, 이벤트 `PAYMENT_STATUS_CHANGED`. 테스트 상점에서 먼저 확인한다. success/fail URL은 Worker가 자기 요청 주소를 기준으로 만들므로 직접 하드코딩하지 않는다. 웹훅만 옮기고 라이브 키·`PAY_ALLOW_LIVE`는 바꾸지 않는다.

## 4. 주소와 정적 브랜드 갱신 (약 10분)

저장소 루트, 깨끗한 이전용 변경 위에서 실행한다. **아래 명령은 실제 파일을 바꾸므로 도메인 구매 전에 실행하지 않는다.** 첫 명령은 읽기 전용이다.

```sh
node tools/set-domain.mjs --domain example.io --keep-old --dry-run
node tools/set-domain.mjs --domain example.io --keep-old
node tools/set-brand.mjs --dry-run
node tools/set-brand.mjs
npm run check
node tools/build-site.mjs
```

다른 배치를 고르면 모든 호스트를 명시한다(프로토콜·포트·경로 없음).

```sh
node tools/set-domain.mjs --domain example.io --game-host play.example.io --api-host api.example.io --relay-host relay.example.io --game-server-host game.example.io --keep-old --dry-run
```

- `set-domain`은 `index.html`/`_headers` 접속 CSP(HTTPS·WSS 쌍), `js/config.js` API·중계 주소, 두 Worker의 `ALLOWED_ORIGINS`, relay `DEFAULT_ORIGINS`, 개인정보 페이지 호스팅 행, README 플레이 URL과 개발 공지 패널 CSP를 함께 바꾼다. Supabase 주소·비밀 키·배포된 Worker·DNS는 건드리지 않는다. 같은 명령의 재실행은 변경 0개다.
- `--keep-old`는 기존 접속 CSP와 github.io Origin을 남긴다. 기본값은 기존 API/relay 접속 주소를 교체하고 github.io Origin을 뺀다. 다른 사용자 지정 Origin과 로컬 시험 Origin은 보존하며 새 게임 Origin을 중복 없이 추가한다. 기존 사이트를 계속 서비스할 때는 **반드시 `--keep-old`**로 시작한다. 개발 공지 패널은 현재 relay 하나만 접속한다.
- 도구는 관리 호스트 주석을 index에 기록해 다음 이전 때 옛 게임 서버 주소도 함께 정리한다. 주석을 수동으로 지우지 않는다. 수동 콘솔 점검표가 끝에 출력된다.
- `set-brand`는 `BRAND`를 읽어 index의 title·앱 이름·description·noscript, privacy의 이름, API 결제 페이지 제목·본문 이름, README 제목을 맞춘다. 런타임 화면은 이미 `BRAND`를 가져다 쓴다. 가격표·상품 id·저장 키를 바꾸지 않는다.
- `_headers`는 실제 HTTP 응답 CSP다. importmap을 바꿀 때 **index meta와 `_headers`의 script-src 해시를 같이 갱신**한다. 동등성 테스트가 누락을 잡는다. `frame-ancestors`는 헤더에만 두고 CrazyGames 웹/앱 iframe을 허용한다. X-Frame-Options로 다시 막지 않는다.
- HTML은 재검증(no-cache), 폰트·모델·음원은 1년 immutable이다. 캐시되는 자산의 내용이 바뀌면 **파일명/경로도 바꾼다**. 캐시 정책이 같아도 구버전 콘텐츠를 덮어쓰면 최대 1년 남을 수 있다.
- `build-site`는 허용 목록(index/privacy/_headers/css/js/audio/assets/fonts/.nojekyll)만 `dist/`에 복사한다. tests/docs/server/supabase/tools/dev/infra와 비밀 파일은 배포하지 않는다. dist는 커밋하지 않는다.

검토·저장 후 **Worker를 먼저 배포**한다(새 Origin을 먼저 허용).

```sh
npm --prefix server/api run deploy
npm --prefix server/relay run deploy
```

기존 배포 환경의 의존성 설치와 Cloudflare 로그인이 필요하다(각 폴더 README 참고). 그다음 변경을 `main`에 통합해 Pages 워크플로를 실행한다. 이전 동안 중복 결제를 막으려고 DB/가격표/주문 id는 그대로 쓴다.

## 5. 기존 GitHub Pages 유지·안내 (약 5분)

1. GitHub Pages 설정과 기존 URL `https://jungmk0720.github.io/skala-fps/`를 지우지 않는다. 병행 기간은 소유자가 정하되 계정 연결 안내를 충분히 제공한다.
2. **기존 Pages 배포에만** 첫 화면의 읽기 쉬운 안내를 추가한다: “게임 주소가 변경되었습니다. 새 주소로 이동하기 전에 이곳에서 계정을 연결하세요.” 새 HTTPS 주소 링크와 개인정보 페이지를 함께 둔다. 강제 리디렉션은 계정 연결·OAuth 복귀를 끊으므로 하지 않는다.
3. Pages와 GitHub Pages가 같은 브랜치를 읽는다면 별도 이전용 배포 브랜치/보관한 이전 릴리스를 사용해 안내를 분리한다. 이 변경은 도구가 자동으로 하지 않는다. 이전용 배포도 CSP와 기존 로그인 URI가 유지되는지 확인한다.
4. 병행 종료 후 먼저 공지하고 기존 기기 계정 복구 경로를 확보한 뒤 github.io Origin·콘솔 URI를 제거한다. 옛 페이지를 단순 링크 안내로 남기는 것은 가능하다. 보존된 다른 사용자 지정 Origin은 검토해 필요 없는 것만 명시적으로 지운다.

## 6. AWS Activate와 서울 서버 (병행 준비)

정적 도메인 이전 완료를 기다리지 않고 계정 준비는 할 수 있다. 서버 생성은 `infra/aws/README.md`의 절차를 따른다.

- Founders 신청 준비: 실제 작동하는 회사/제품 웹사이트(플레이·연락처·개인정보 페이지), 설립 10년 이내·자가 자금·기존 크레딧 수혜 이력 등 해당 자격. 지원 규모와 승인 여부를 보장하지 않는다.
- Builder ID(개인 이메일), Activate 프로필(도메인과 맞는 사업용 이메일), 연결할 AWS 계정·정확한 사업/제품 정보를 준비한다. **활성화된 Paid Tier Plan 계정과 결제 수단**을 확인하고, 무료 플랜이라면 콘솔에서 유료 플랜 전환 조건을 확인한다. 유료 플랜은 유료 기술지원 계약을 뜻하지 않는다.
- [AWS 신청 공식 안내](https://aws.amazon.com/aws-startups/learn/applying-for-aws-activate-credits-a-step-by-step-guide/)와 [공식 FAQ](https://startups.aws.com/faq)의 Paid Tier Plan 항목을 신청 당일 다시 확인한다. 심사는 수일 이상 걸릴 수 있다. 승인/잔액/만료일은 Billing → Credits에서 확인한다.
- `terraform init` → `plan` → `apply`, SNS 구독 이메일 확인, EIP를 `game.` DNS only A 레코드로 연결한다. 보안 그룹은 80/443만, 운영 접속은 SSM이다.
- 기본 서비스는 **기존 Node relay 어댑터**이며 서버 판정 구현 대신 인프라 동작을 확인하는 임시 서비스다. 브라우저는 자동으로 AWS로 연결하지 않는다. 권위 서버가 병합된 뒤 배포 커밋/명령·클라이언트 연결·방 배정·부하 시험을 별도 검토한다.
- 월 기본 $40의 50/80/100% 경보와 CPU·상태 검사 경보를 첫날 켠다. 비용 반영 지연이 있고 자동 차단이 아니다. 송신 과금·공인 IPv4·지원금 만료를 감시한다.

## 7. 공개 전 확인표 (약 15분)

- [ ] DNS/HTTPS: 게임·API·relay 인증서 정상, 의도하지 않은 외부 호스트 없음. 실제 응답의 Content-Security-Policy/Referrer-Policy/Permissions-Policy/nosniff 확인(`curl -I https://example.io/`). HTML no-cache, 모델/폰트/음원 immutable 확인.
- [ ] 데스크톱/모바일 새 주소에서 첫 화면·개인정보 링크 정상. 콘솔에 CSP 오류 없음. CrazyGames 테스트 iframe(웹과 iOS 앱 포함)은 `frame-ancestors`에 막히지 않음.
- [ ] 기존 사이트에서 계정 연결 → 새 주소의 비어 있는 시크릿 창에서 Google/Kakao 로그인 → 같은 닉네임·전적·구매 내역 복구. 기존 사이트의 연결/로그인도 병행 기간 동안 정상.
- [ ] 테스트 결제 완료·코인 1회 지급·반환 주소·주문 조회·미사용 주문 환불 확인. 웹훅 도달과 cron 대사 확인. 라이브 결제가 생기지 않았는지 확인.
- [ ] 두 브라우저로 relay 방 생성·참가·채팅·준비·출격·재접속. 네트워크 WS가 새 relay로 가고 Origin 거부가 없음.
- [ ] GitHub Pages 안내 링크와 기존 계정 연결 동작 확인. 새 주소와 옛 주소의 브라우저 저장소를 혼동하지 않음.
- [ ] AWS를 만든 경우 `/health`·SSM 접속·서비스 로그·SNS 구독·예산 경보 수신 설정 확인. 브라우저가 아직 Cloudflare relay를 쓰는 것을 확인.
- [ ] 워크플로 성공, dist에 서버/도구/문서/비밀 없음. 기존 운영 커밋·DNS·Worker 버전의 롤백 기록 보관.

## 8. 실패 시 롤백

1. 새 결제 시도를 안내로 중단하고 진행 중 주문을 조회한다. DB·코인 원장·구매 id를 되돌리거나 초기화하지 않는다. 결제 웹훅/cron 대사는 계속 유지한다.
2. Pages 대시보드에서 이전 정상 배포를 Rollback한다. 첫 도메인 이전이라 이전 Pages 배포가 없으면 기존 GitHub Pages 주소를 안내한다. 로컬에서도 기록해 둔 **이전 버전 파일**로 config/CSP/Origin/README/privacy를 복원한다. `set-domain --domain <github.io>`로는 `/skala-fps/` 경로를 표현할 수 없으므로 되돌리는 도구로 쓰지 않는다.
3. Workers의 이전 정상 버전을 복구하거나 이전 config를 배포한다. 새 Origin을 바로 지우지 말고 복구 중인 결제/OAuth 복귀가 마칠 때까지 병행 허용한다. workers.dev 주소와 기존 Durable Object 데이터를 삭제하지 않는다.
4. Google/Kakao 기존 Redirect URI·기존 GitHub Origin이 남아 있는지 확인한다. Toss 웹훅은 정상 Worker 주소로 돌리고 결제 승인·환불·중복 지급 여부를 다시 확인한다.
5. DNS는 기록한 값으로 복원한다. 인증서·DNS 전파 대기 중에는 양쪽 접속 경로를 유지한다. Registrar 등록 자체를 취소하거나 기존 DNS를 전부 삭제하지 않는다.
6. AWS는 브라우저 연결을 원래 relay로 돌린 뒤 `terraform destroy`(README 절차). EIP와 DNS를 함께 정리해 방치 비용을 막는다. 공유 DB는 삭제하지 않는다.
7. 원인·사용한 버전·주문/접속 영향·복구 시각을 운영 기록에 남기고 확인표를 다시 통과한 뒤 재시도한다.
