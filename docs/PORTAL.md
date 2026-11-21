# CrazyGames 출시 안내 (포털 연동 · 영어 · 제출 절차)

첫 수익까지 가장 짧은 길은 CrazyGames다. 광고는 CrazyGames SDK로만 나오고, 우리 서버(Cloudflare 중계·API, Supabase)는 그대로 쓴다.
이 문서는 2026-11-21에 읽은 공식 문서(docs.crazygames.com)를 근거로 한다. 규칙이 바뀌었을 수 있으니 제출 전에 링크를 다시 연다.

## 1. 우리에게 걸리는 CrazyGames 규칙

| 항목 | 규칙 | 근거 |
|---|---|---|
| 출시 단계 | **기본 출시(Basic Launch)**: 7~21일, 소수 이용자, SDK 선택, 광고 꺼짐. 500회 플레이·7일이 지나면 지표(평균 플레이 시간, 재방문, 게임 진입률, CTR)로 판정. **정식 출시(Full Launch)**: SDK 전체 연동, 광고 켜짐, 수익 배분 | [Launching](https://docs.crazygames.com/) |
| 기본 요건 | 영어 지원, PEGI 12, 다른 포털 상표 없음, 외부 광고 없음, 외부 로그인 없음, 교차 홍보 없음, 게임 안 전체 화면 단추 금지(사이트가 제공) | [Gameplay](https://docs.crazygames.com/requirements/gameplay/), [FAQ](https://docs.crazygames.com/faq/) |
| 파일 | 파일 1500개 이하, 전체 250MB 이하, 처음 받는 크기 50MB 이하(모바일 홈 20MB). **상대 경로만** | [Technical](https://docs.crazygames.com/requirements/technical/) |
| 올린 파일이 열리는 곳 | CrazyGames CDN: `https://<게임>.game-files.crazygames.com/<게임>/<버전>/index.html`. 즉 게임 페이지의 Origin은 `https://*.game-files.crazygames.com` | [Sitelock](https://docs.crazygames.com/resources/html5/sitelock/) |
| iframe으로 넣을 때 | 우리 도메인을 CrazyGames(웹 `*.crazygames.com`, iOS 앱 `capacitor://app.crazygames.com`, 그 하위 `games.crazygames.com`)가 감싼다. `frame-ancestors`에 `capacitor://*.crazygames.com`이 없으면 iOS 앱에서 흰 화면 | [Sitelock](https://docs.crazygames.com/resources/html5/sitelock/#protecting-iframe-games) |
| 사이트 잠금(sitelock) | 선택. 우리는 걸지 않는다(우리 도메인에서도 같은 게임이 돈다) | 같은 곳 |
| SDK | `<script src="https://sdk.crazygames.com/crazygames-sdk-v3.js">` 뒤 `await SDK.init()`. 환경 `local`(localhost, `?useLocalSdk=true`) · `crazygames` · `disabled`(다른 도메인: 모든 호출 오류) | [SDK intro](https://docs.crazygames.com/sdk/intro/) |
| 필수 신호 | 기본 출시에 SDK를 넣으면 **gameplayStart**(첫 신호까지가 처음 받는 크기). 정식 출시는 gameplayStart/Stop 모두, loadingStart/Stop 선택 | [Technical](https://docs.crazygames.com/requirements/technical/#sdk-integration), [Game](https://docs.crazygames.com/sdk/game/) |
| gameplay 신호 | 플레이를 시작·재개할 때 Start, 메뉴·일시정지·판 끝에서 Stop. 탭 전환에는 보내지 않는다 | [Game](https://docs.crazygames.com/sdk/game/#gameplay-startstop) |
| 중간 광고 | 판 사이(판 끝, 맵 바뀜)에서만. 게임 중·메뉴 단추·설정·상점 단추에서는 금지. 요청부터 끝까지 화면을 막고, **실제로 시작될 때만** 음소거. 3분 간격은 SDK가 지킨다(이른 요청은 무시) | [Ads](https://docs.crazygames.com/requirements/ads/) |
| 보상 광고 | 선택임이 바로 보이고(광고 표시 아이콘), 너무 자주 내밀지 않고, 광고를 이어 붙이지 않는다. `adError`면 보상 금지. 광고 없이 얻는 길도 있어야 한다. **기본 출시에는 효과 없는 보상 단추를 두면 탈락** | 같은 곳 |
| 광고 차단기 | 차단기가 있어도 정상 플레이. 막는 기능은 안내를 보이고 누를 수 없게(팝업 금지) | 같은 곳 |
| 채팅 | 욕설 거르기 필수. SDK `game.settings.disableChat`이 true면 채팅을 끈다(`?disableChat=true`로 시험) | [Multiplayer](https://docs.crazygames.com/requirements/multiplayer/#chat-and-user-generated-content-ugc) |
| 음소거 | `game.settings.muteAudio`가 게임 볼륨 설정보다 앞선다(정식 출시 필수) | [Game](https://docs.crazygames.com/sdk/game/#game-settings) |
| 초대 링크 | `game.inviteLink({ roomId })`, 들어온 쪽은 `game.getInviteParam('roomId')`·`addJoinRoomListener`. 정식 출시 멀티는 방 정보(`updateRoom`), 즉시 멀티, 판 사이 같은 방 유지까지 요구 | [Game](https://docs.crazygames.com/sdk/game/#invite-link), [Multiplayer](https://docs.crazygames.com/requirements/multiplayer/) |
| 계정 | 기본 출시: 손님으로 시작, **외부 로그인(구글·카카오 등) 끄기**. 정식 출시: CrazyGames 계정 자동 로그인·이름 사용(`user` 모듈, 토큰 서버 검증) | [Account](https://docs.crazygames.com/requirements/account-integration/) |
| 결제 | 외부 결제 금지(인게임 구매는 초대받은 게임만, Xsolla) | [Intro](https://docs.crazygames.com/requirements/intro/) |
| 언어 | 영어 필수. 다른 언어는 SDK `systemInfo.locale`, 없으면 영어 | [Gameplay](https://docs.crazygames.com/requirements/gameplay/) |
| 정산 | 월 1회, 잔액 **€100** 이상이면 송금(계좌·PayPal), 못 미치면 다음 달로 이월 | [FAQ](https://docs.crazygames.com/faq/#how-will-i-be-paid) |

## 2. 게임에 들어간 것

### 플랫폼 창구 `js/platform/`

- `index.js` 게임이 쓰는 하나뿐인 창구 `platform`. 포털 판별, 신호 중복 거르기, 광고 규칙(게임 중 금지, 3분 간격, 보상 광고 직후 중간 광고 없음), 광고 요청 중 화면 막기.
- `crazygames.js` SDK v3 구현. 스크립트를 붙이고 `init()` 후 `environment`가 `disabled`면 쓰지 않는다. 8초 안에 안 되면 SDK 없이 간다.
- `web.js` 우리 도메인용. 모든 호출이 아무것도 하지 않는다. SDK가 막혀도 게임은 이것과 똑같이 돈다.
- `wire.js` 게임에 잇기. 맵이 떠 있고 결과·일시정지·불러오기 화면이 아닐 때만 `gameplayStart`, 나머지는 `gameplayStop`(0.25초마다 상태를 보고 바뀔 때만 보낸다). 광고가 실제로 시작되면 포인터 잠금을 풀고 입력·소리를 끄며, SDK 음소거 설정을 볼륨보다 앞세운다.

포털 판별(하나라도 맞으면 CrazyGames):
1. `js/config.js`의 `portal: { id: 'crazygames' }` — 제출 빌드가 넣는다.
2. 주소의 `?portal=crazygames` — 우리 도메인을 iframe으로 제출할 때 주소에 붙인다.
3. 주소가 `crazygames.com`이나 그 하위 도메인.

광고 켜기: `portal.ads: 'on'`(빌드 `--ads`) 또는 `&ads=1`. 기본 출시 제출본은 끈다(중간 광고 요청도, 보상 단추도 없다). `localhost`에서는 SDK가 `local` 환경이라 광고 대신 SDK 안내 글자가 뜬다.

### 신호와 광고 위치

| 시점 | 호출 |
|---|---|
| 페이지 부팅 시작 → 메뉴가 뜸 | `loadingStart` → `loadingStop` (`js/main.js`) |
| 연습장·좀비·멀티 경기에서 실제로 조작 중 | `gameplayStart`. 일시정지·결과·맵 불러오기·메뉴는 `gameplayStop` |
| 결과 화면에서 계속 플레이하는 단추(**다시 하기** · **방으로 돌아가기**)를 누름 | `midgameAd()` 후 이동(판 사이, 3분에 한 번까지. 광고가 없으면 바로 이동) |
| 결과 화면의 **메뉴로** · **로비로**, 그 밖의 모든 이동 단추 | 광고 없음. 메뉴·이동 단추에 광고를 붙이지 않는다(`midgameOnLeave`, js/ui/results.js) |
| 결과 화면의 **▶ 광고 보고 포인트 2배** | `rewardedAd()`. 끝까지 보면 `account.grantAdBonus(token)`이 그 판의 보상만큼 한 번 더 준다 |

보상 광고 규칙:
- 판마다 한 번. 금액은 계정이 기록한 그 판의 보상(`recordMatch`/`recordZombie`의 `gained`)이고 화면이 정하지 않는다(`bonusToken`).
- 포인트는 기존 적립 경로(`commit` → `fps_save_profile`의 증가분 `p_delta`)로 서버에 간다. 서버는 다른 적립과 같은 규칙(초당 5점 버킷 최대 5,000, 하루 50,000)으로 받고 넘치면 깎는다. 클라이언트만 아는 보너스는 없다.
- `adError`(없음·차단·쿨다운)면 주지 않고 "잠시 뒤 다시"를 보인다. 차단기가 감지되면 단추 대신 안내 글만 보인다.

### CrazyGames 안에서 숨기는 것

- 상점의 코인 충전 탭·주문 내역과 물건별 코인 구매 단추(토스 결제는 외부 결제이고 iframe에서 깨진다). 포인트 구매는 그대로.
- 닉네임 화면의 "다른 기기에서 불러오기", 마이페이지의 구글·카카오 계정 연결(외부 로그인). 기기 토큰 계정은 그대로 동작한다.
- 일시정지·설정의 전체 화면 단추와 전체 화면 자동 켜기.
- 채팅: SDK가 `disableChat`이면 경기 채팅 층과 방 채팅 입력을 숨기고 받은 말도 버린다(안내 한 줄). 욕설 거르기(`js/core/profanity.js`)는 어디서든 보낼 때와 받을 때 모두 쓴다.
- 방 화면: 포털이면 방 id 옆에 **초대 링크 복사**(SDK `inviteLink`).

## 3. 번역(i18n)

- `js/core/i18n.js`: `t('영역.이름', { 자리 })`, `loc(obj, 'name')`(데이터의 짝 칸 `name`/`nameEn`), `fmtNum`.
- 표: `js/core/lang/<영역>.js`, 한 줄에 `'영역.이름': ['한국어', 'English'],`. **새 글자를 더할 때는 해당 영역 표에 한 줄**을 넣고 코드에서 `t()`로 부른다. 새 영역 파일은 `i18n.js`의 `TABLES`에 한 줄 더한다.
- 데이터 파일(무기·맵·이모트·캐릭터·규칙)은 한국어 칸 옆에 `칸En`을 둔다. `tools/check-i18n.mjs`의 `PAIRED_DATA`가 이 파일들을 훑어 빠진 짝을 잡는다.
- 언어: 설정 **언어 / Language**(한국어/English). 고르지 않았으면 브라우저 첫 언어가 한국어일 때만 한국어, 나머지는 영어(CrazyGames 안에서도 같다). 바꾸면 페이지를 다시 연다. 경기 중 일시정지의 설정에는 언어 항목이 없다.
- 검사(`tests/i18n.test.mjs` → `tools/check-i18n.mjs`): 모든 키가 짝을 이루고 `{자리}`가 같은지, 코드가 부르는 `t('키')`가 표에 있는지, 짝 데이터에 `En`이 있는지, 플레이어가 보는 모듈에 표 밖 한글 문자열이 남지 않았는지. 주석, `console.*` 줄, 줄 끝 `// i18n-ok: 이유`는 세지 않는다. 운영자 패널·디버그·QA 목 화면·욕설 목록은 건너뛴다.
- 남은 한국어: 연속 킬 안내 음성(파일, 한국어 TTS), 맵 안의 일부 고유명(로마자로 옮김).

## 4. 서버 허용 목록(소유자가 배포)

CrazyGames에 파일을 올리면 게임의 Origin이 `https://<게임>.game-files.crazygames.com`이 된다. 중계 서버와 API는 Origin을 검사하므로 허용 목록에 하위 도메인 규칙을 더했다.

- `server/relay/src/rules.js` `DEFAULT_ORIGINS`, `server/relay/wrangler.toml`, `server/api/wrangler.toml`의 `ALLOWED_ORIGINS`에 `https://*.game-files.crazygames.com`.
- 규칙(`originAllowed`, 두 서버 같음): `://*.`이 있으면 그 도메인의 하위 도메인만, 같은 scheme, 기본 포트만. `https://www.crazygames.com`처럼 게임 파일 주소가 아닌 곳은 허용하지 않는다.
- Supabase는 CORS를 막지 않으므로 바꿀 것이 없다.
- `_headers`의 `frame-ancestors`는 이미 `*.crazygames.com`·`crazygames.com`·`capacitor://app.crazygames.com`을 허용한다(우리 도메인을 iframe으로 제출할 때만 필요). 문서는 앱 하위 도메인까지 덮는 `capacitor://*.crazygames.com`을 권하므로 iframe 방식으로 가면 그 값으로 바꾼다.
- 게임 CSP(`index.html` meta와 `_headers`): `script-src`에 `https://sdk.crazygames.com`, `connect-src`에 `https://cza.crazygames.com`(SDK 통계), `img-src`에 `https://images.crazygames.com`(SDK 배너 그림).

**소유자 단계(배포는 아직 안 했다):**
1. `cd server/relay && npx wrangler deploy` — 새 `ALLOWED_ORIGINS`와 하위 도메인 규칙이 들어간다.
2. `cd server/api && npx wrangler deploy` — 같은 규칙. 결제는 포털에서 숨기지만 로그인 교환·저장 API의 Origin 검사가 같은 함수를 쓴다.
3. 대시보드에서 `ALLOWED_ORIGINS`를 따로 덮어쓴 적이 있으면 그 값에도 `https://*.game-files.crazygames.com`을 더한다.
4. Pages 배포(우리 도메인): 새 CSP가 담긴 `index.html`·`_headers`를 평소처럼 배포한다.
5. 확인: CrazyGames 미리보기에서 로비 접속·방 만들기·채팅, 브라우저 콘솔에 `origin_not_allowed`·CSP 오류가 없는지.

## 5. 제출 체크리스트

### 준비
- [ ] [Developer Portal](https://developer.crazygames.com/) 계정(개발자 약관 동의, 정산 정보는 수익이 생긴 뒤 넣어도 된다).
- [ ] 게임 이름 확정(`js/core/brand.js`의 `name`/`nameEn`, `node tools/set-brand.mjs`).
- [ ] `npm run check` 통과.

### 빌드
- 기본 출시: `npm run build:crazygames` → `dist-crazygames/`와 `dist-crazygames.zip`(약 8MB, 파일 약 270개). zip을 그대로 올린다.
- 정식 출시: `node tools/build-site.mjs --portal crazygames --ads`(광고 켬).
- 제출본은 `_headers`·`.nojekyll`·문서·시험·도구·서버·dev를 넣지 않는다. `index.html`에 SDK 태그, `js/config.js`에 `portal` 설정이 더해진다. 경로는 모두 상대 경로다.
- 다른 방법: 우리 도메인을 iframe으로 제출(`https://<도메인>/?portal=crazygames`, 정식 출시는 `&ads=1`). 이 경우 `_headers`의 `frame-ancestors`를 위 4절처럼 넓힌다. 파일을 올리는 쪽이 CDN·처음 받는 크기 측정에 유리하다고 문서가 권한다.

### 그림·영상
- [ ] 표지 3장: 가로 1920×1080, 세로 800×1200, 정사각 800×800. 테두리·"NEW"·"PLAY" 같은 글자·아이콘·스토어 로고 금지, 게임 이름만. 스크린샷 그대로보다 그린 표지를 권한다.
- [ ] 미리보기 영상 2개: 가로 1080p(16:9), 세로 1080p(2:3). 15~20초, 50MB 이하, 소리 없음, 검은 화면·로고 전환·마우스 커서·홍보 문구 금지, 첫 장면은 표지와 같게.

### 영어 설명(예시, 다듬어서 쓴다)
> SKALA OPS is a fast browser FPS with no download. Jump into 16-player team deathmatch, free-for-all, bomb defusal or co-op zombie holdout across 20 original maps. Unlock weapons, operators and emotes with points earned in every match.
>
> Controls: WASD move · Mouse look · Left click shoot · Right click zoom · Space jump · Ctrl/C crouch · Shift walk · R reload · 1–4 / wheel switch weapons (4 = grenade) · E plant/defuse · G drop weapon · B emotes · Tab scoreboard · Enter chat · Esc pause. Mobile: drag left to move, drag right to look, on-screen buttons.

- [ ] 방 인원(로비 크기): 최대 16명.
- [ ] 방향: 가로(모바일 지원 시 가로 고정은 사이트가 처리).

### QA가 보는 것(우리가 미리 확인할 것)
- [ ] 영어로 처음부터 끝까지(`?portal=crazygames`로 열면 브라우저가 한국어가 아닌 한 영어).
- [ ] 1920×1080·1366×768·1280×720·907×510·800×450에서 글자가 읽히고 잘리지 않는다(devicePixelRatio 1).
- [ ] Chrome·Edge 데스크톱, 안드로이드 Chrome. 144Hz에서도 물리가 같다(고정 틱).
- [ ] 광고 차단기를 켜고도 끝까지 플레이된다. 기본 출시 제출본에는 보상 단추가 없다.
- [ ] `?disableChat=true`로 채팅이 사라지고, `?muteAudio=true`로 소리가 꺼진다(localhost에서 SDK local 모드).
- [ ] 외부 링크·외부 로그인·결제 화면이 없다. 다른 포털 이름이 없다.
- [ ] 첫 `gameplayStart`까지 받는 크기와 시간(QA 도구의 지표).

## 6. 기본 출시 → 정식 출시

기본 출시 기간(7~21일)에 지표를 본다. 통과하면 CrazyGames가 정식 출시 요건을 맞춰 다시 내라고 알린다. 그때 할 일:
1. `--ads` 빌드로 광고를 켠다(중간 광고·보상 광고는 이미 들어 있다).
2. 계정 연동: SDK `user.getUserToken()`을 서버(API Worker)에서 검증하고 CrazyGames `userId`로 계정을 만들거나 찾는다. CrazyGames 이름을 게임 이름으로 쓴다. 손님은 지금처럼 기기 계정.
3. 멀티: `updateRoom({ roomId, isJoinable, inviteParams })`·`leftRoom()`을 방 들어가기·나오기에 잇고, 시작할 때 `inviteRoomId()`·`onJoinRoom`으로 그 방에 바로 들어가게 한다(지금은 링크 복사까지만 있다). `isInstantMultiplayer`면 바로 방을 만든다.
4. 처음 들어온 사람을 1번 클릭 안에 게임으로(지금은 닉네임 → 메뉴 → 연습장/멀티). 포털에서는 닉네임 대신 CrazyGames 이름을 쓰면 해결된다.
5. 게임 언어: SDK `systemInfo.locale`이 있으면 그것으로 고른다(지금은 브라우저 언어).

## 7. 소유자가 아직 해야 할 것

- [ ] Developer Portal 가입, 게임 등록, 미리보기 도구로 zip 시험.
- [ ] 4절 서버 배포(wrangler deploy 두 번)와 Pages 배포.
- [ ] 표지 3장·영상 2개 만들기, 영어 설명·조작법 다듬기.
- [ ] 게임 이름 확정(지금 `SKALA OPS`), 다른 상표와 겹치지 않는지 확인.
- [ ] PEGI 12 점검: 피 표현·좀비 표현 수위, 닉네임 금지어(지금은 채팅만 거른다).
- [ ] 연속 킬 안내 음성이 한국어뿐이다. 영어 음성을 만들지, 영어에서는 끌지 정한다.
- [ ] 정산 정보(€100 이상부터 월 정산).
