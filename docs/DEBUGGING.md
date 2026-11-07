# SKALA FPS 디버깅 가이드

## URL 플래그

여러 개를 함께 쓸 수 있다. 예: `/?sandbox=alley&debug=1&log=debug&logns=physics`

| 플래그 | 하는 일 |
|---|---|
| `debug=1` | F3·F4·F6 사용, `window.__skalafps` = `ctx`, `__skalafps.logs` = 최근 로그, 멀티 세션은 `window.__skalafpsSession` |
| `log=debug\|info\|warn\|error` | 로그 레벨. 기본 `info` |
| `logns=physics,net` | 이 이름표만 남긴다. `net`은 `net:room`도 포함한다. `error`는 항상 남는다 |
| `sandbox=<맵 id>` | 메뉴 없이 그 맵의 연습장으로 들어간다 |
| `autoplay=1` | 포인터 잠금 없이 키 입력을 받고 닉네임 게이트와 나가기 확인을 건너뛴다(자동 테스트용). 마우스 시점과 버튼은 포인터 잠금이 있어야 한다 |
| `plugins=0` | UI·무기·연습장 플러그인을 끄고 core만 띄운다 |

## F키 (`debug=1`일 때)

| 키 | 켜고 끄는 것 |
|---|---|
| **F3** | 상태 패널(초당 5번 갱신) |
| **F4** | `ctx.getTargets()`의 모든 대상에 판정 부위 선. 벽 너머로도 보인다 |
| **F6** | 맵의 충돌체와 발판·포털·비밀 스팟 선. 벽에 가려진 선은 보이지 않는다 |

글자 입력칸에 포커스가 있으면 키를 가져가지 않는다. 셋 다 꺼져 있으면 프레임 비용이 없다.

### 선 색

| F4 부위 | 색 | | F6 종류 | 색 |
|---|---|---|---|---|
| `head` 구 | 빨강 | | `box` / `cyl` / `ramp` | 흰색 / 주황 / 연두 |
| `body` 상자 | 노랑 | | `ground` 바닥 슬래브 | 어두운 회색 |
| `legs` 상자 | 초록 | | `clip` 보이지 않는 막이 | 빨강 |
| `hand` 구 2개 | 하늘 | | `bounds` 맵 외곽 벽 | 어두운 빨강 |
| `foot` 상자 | 보라 | | `pad` 발동 범위와 궤적 | 시안 |
| | | | `portal` 입구와 도착점 | 자홍 |
| | | | `secret` 판정 상자 | 노랑 |

## 패널 읽는 법

| 줄 | 내용 | 살펴볼 점 |
|---|---|---|
| 첫 줄 | F4 대상 수, F6 선 수 | F4 대상이 0이면 `getTargets()`가 비어 있다 |
| `fps` | 0.2초 구간의 평균 FPS, 평균·최대 프레임 시간 | 최대가 평균보다 훨씬 크면 끊김이 있다 |
| `draw` | 직전 프레임의 드로우콜·삼각형, 살아 있는 지오메트리·텍스처 수 | 맵을 오갈수록 `geo`·`tex`가 늘면 누수다 |
| `pos` | 발 위치 x y z, 시선 yaw·pitch(도) | |
| `vel` | 속도 x y z, `speed` = 수평 속력(m/s) | 상한은 `consts.MOVE.MAX_SPEED` |
| `state` | `onGround`, `crouch`, `hp`, `alive` | |
| `weapon` | 무기 id, 슬롯, 상태, `zoom 단계/전체 x배율`, 현재 FOV | |
| `map` | 맵 id와 `map.stats`, 다음 줄에 발판·포털·비밀 수 | |
| `rules` | 규칙, 모드, 현재 화면 | |
| `aim` | 조준선이 지금 맞히는 것. `player id part dist` 또는 `world 종류 solids[번호] mat dist` | 실제 판정 함수의 결과다 |
| `trigger` | 마지막 발판·포털·비밀, 경과 시간, 위치 | 패널이 닫혀 있어도 기억한다 |
| `net`, `sync` | 멀티 세션이 있을 때만: 연결 상태, rtt, 프레임·바이트, 초당 이벤트 | |
| `wire` | F6을 켰을 때만: 색 종류별 충돌체·트리거 개수 | |

값이 없으면 `-`, 읽다가 오류가 나면 그 줄만 `읽기 실패: …`로 나온다.

## 부위 판정이 이상할 때

1. `/?sandbox=<맵>&debug=1`로 들어가 봇을 세우고 **F3**, **F4**를 켠다.
2. 문제의 부위를 조준하고 `aim` 줄의 `part`와 그 자리의 선 색을 비교한다. F4는 `consts`의 값을 그리고 `aim`은 실제 판정 함수를 부른다.

| 관찰 | 볼 곳 |
|---|---|
| 선이 몸 모델과 어긋난다 | `core/consts.js`의 `HITBOX`·`HITBOX_CROUCH`, `engine/avatars.js`의 모델 치수 |
| 선 색과 `aim`의 부위가 다르다 | `engine/physics.js`의 `raycastPlayers` (`tests/log.test.mjs`가 둘의 일치를 확인한다) |
| `aim`은 맞는데 피해가 이상하다 | `weapons/defs.js`의 `normalizePart`·`computeDamage` |
| 연습장은 맞는데 멀티에서만 다르다 | `game/protocol.js`의 `PART_CODES`, `game/match.js`의 `claimHit` |
| 앉거나 돌 때만 어긋난다 | 콘솔에서 `__skalafps.getTargets()`의 `yaw`·`crouch`(0..1) |

콘솔에서 직접 쏴 볼 수도 있다.

```js
const c = __skalafps;
c.traceShot(c.player.getEye(), c.player.getAimDir(), 1000, { ignoreId: c.player.state.id });
```

## 이동이 이상할 때

**F3**의 `vel`·`speed`·`onGround`를 보면서 재현한다.

| 증상 | 볼 곳 |
|---|---|
| 가속, 버니합, 공중 스트레이프 | `engine/movement.js`의 `moveQuake`, 값은 `consts.MOVE`, 테스트는 `tests/movement.test.mjs` |
| 점프 높이, 중력, 앉기 크기 | `consts.PLAYER` |
| 벽에 걸리거나 끼인다 | **F6**으로 선을 보고, 벽을 조준해 `aim`의 `solids[번호]`로 맵 데이터를 찾는다. 충돌 계산은 `physics.moveCharacter` |
| 보이지 않는 벽에 막힌다 | **F6**의 빨강(`clip`)·어두운 빨강(`bounds`). 총알은 이 벽을 통과한다 |
| 발판·포털이 발동하지 않는다 | **F6**의 시안·자홍 상자 안에 발이 있는지, `trigger` 줄이 바뀌는지. 판정은 `engine/triggers.js`(발판 재발동 대기 0.35초), 맵 검증은 `npm run check:maps` |
| 입력이 안 먹는다 | 콘솔에서 `__skalafps.input.state`, 잠금은 `__skalafps.input.locked` |

## 로그 남기기

```js
import { createLogger } from './core/log.js';
const log = createLogger('physics');
log.debug('벽 밀어내기', { pos, vel });
```

- 레벨 아래이거나 이름표가 걸러진 줄은 콘솔에도 버퍼에도 남지 않는다.
- `log.debug`는 `console.log`로 나오므로 크롬의 Verbose를 켜지 않아도 보인다.
- 최근 500줄: `__skalafps.logs.filter((l) => l.ns === 'net')`. 각 줄은 `{ t(ms), level, ns, text }`이고 값은 기록 순간의 글자다.

## 명령

| 명령 | 하는 일 |
|---|---|
| `node tools/serve.mjs 8104` | 로컬 서버. `http://localhost:8104/?sandbox=testyard&debug=1` |
| `npm test` | `tests/*.test.mjs` 전체 |
| `npm run qa` | 실제 페이지를 헤드리스 브라우저로 끝까지 플레이한다(아래 절) |
| `npm run check` | 머리말·금지 단어 + 맵 검증 + 테스트. 커밋 전에 돌린다 |
| `npm run check:headers` | 머리말과 금지 단어만. 파일별로 결과를 적고 실패하면 종료 코드 1 |
| `npm run check:maps` | 맵 검증만 |

머리말을 한꺼번에 넣으려면 `{ "경로": "설명" }` JSON을 만들어 넘긴다. `--dry-run`을 붙이면 쓰지 않고 결과만 보여 준다.

```bash
node tools/check-headers.mjs --fix-from stamp.json --dry-run
```

## 자동 플레이 테스트 (`npm run qa`)

실제 게임 페이지를 헤드리스 브라우저로 돌려 끝까지 플레이해 본다. 설치할 패키지는 없고 Node 22 이상과 Edge나 Chrome만 있으면 된다. CDN(jsDelivr)에서 three.js와 cannon-es를 받으므로 네트워크가 필요하다.

```bash
npm run qa                           # 전체 시나리오. 약 40분
npm run qa -- --list                 # 시나리오 이름 목록
npm run qa -- --only menus,damage    # 고른 시나리오만
npm run qa -- --only practice --filter knife/dojo   # 조합·무기·맵 이름으로 좁히기
QA_NET_DELAY_MS=120 npm run qa -- --only multi-play  # 가짜 서버에 지연을 넣어 멀티를 돌린다
```

끝나면 통과·실패 표와 실패 내용을 찍고, 스크린샷을 모아 둔 임시 폴더 경로를 알려 준다. 스크린샷은 저장소 밖에 둔다.

| 시나리오 | 보는 것 |
|---|---|
| `first-run` | 닉네임 게이트: 닫을 수 없음, 잘못된 이름 문구, 오프라인 안내, 새로고침 유지, `?sandbox=`·`?autoplay=`의 건너뛰기 |
| `menus` | 메뉴, 마이페이지(이름·전적·장비), 상점(구매·부족·장착·유지), 빠른 시작, 연습장 시트의 규칙별 맵 |
| `practice` | 규칙 × 맵 × 모드 전체를 봇 2명으로 결과 화면까지: 싸움, 킬, 규칙 위반 무기, 판정 거절, 보상 1회, 다시 하기, 메뉴 복귀. 시간 배율 1로 한 판, 맵마다 8명 경기(`--filter realtime`, `--filter crowd`) |
| `weapons` | 무기 전부를 로드아웃 화면으로 쥐고 진짜 입력으로 사격·재장전·줌·교체·칼·수류탄·F. 칼전·스나전의 슬롯 제한 |
| `damage` | 표적을 세워 머리·몸·다리·손·발을 쏜다: 라이플 헤드 1발, 반샷 표시, 샷건, 칼, 폭발, 피격과 부활 |
| `drops` | 칼 상점과 프리미엄 표시, 죽은 뒤 G로 총 버리기, 탄약이 떨어지면 줍기, 4초 제한, 3인칭 칼 휘두르기 |
| `movement` | 버니합, A/D·마우스 스윙, 속도계, 앉기, 새 맵 넷의 발판·포털·비밀 스팟(보상 1회, 새로고침 유지) |
| `props` | cannon-es 로드, 폭발·총알·밀기, cannon-es 차단 때 고정 소품 |
| `debug` | F3·F4·F6, `?debug` 없을 때 꺼짐, `dev/` 데모 페이지 넷 |
| `multi` | 빈 설정의 비활성 안내, 닿지 않는 서버 |
| `controls` | 클릭 안내, 포인터 잠금, 일시정지, 설정 적용, 점수판, 이모트 휠 |
| `multi-play` | 가짜 서버(`tools/qa/fake-supabase.mjs`)에 클라이언트 둘을 붙여 닉네임, 로비, 방, 경기, 도중 재접속, 결과, 규칙 변경, 퇴장, 다시 입장까지. 이 시나리오만 페이지가 둘이다 |
| `robust` | 깨진 저장값, 이상한 URL, 없는 맵, `?plugins=0`, 메모리 누수, 무승부, 연타, 경기 전환, 창 크기, 낙하, 관전 |
| `monkey` | 무작위 입력을 쏟아부어도 예외 없이 돌고, 그 뒤에도 조작이 먹는지(시드 고정) |
| `gallery` | 주요 화면 사진. 눈으로 확인할 때 이 폴더를 본다 |
| `maps` | 맵마다 스폰, 발판, 포털, 비밀 스팟, 주요 구역을 플레이어 시점으로 찍는다. 맵을 고친 뒤 확인할 때 쓴다 |

어느 시나리오든 잡히지 않은 예외, `console.error`, 실패한 요청(이유를 적어 허용한 것 제외)이 있으면 실패다. 실서버(Supabase)의 인증, 전송 한도, 실제 지연과 소리를 귀로 듣는 확인은 자동화하지 못했다.

| 파일 | 내용 |
|---|---|
| `tools/qa/browser.mjs` | 브라우저 찾기(`QA_BROWSER` → Windows → macOS → Linux), CDP 연결, 페이지 API, 오류 수집 |
| `tools/qa/server.mjs` | 저장소를 `/skala-fps/` 아래에서만 내려주는 서버. 절대 경로는 404로 드러난다. 시험이 운영 Supabase를 건드리지 않도록 `js/config.js`는 기본으로 빈 설정을 내려주고, `config`나 `setConfig`로 바꿀 수 있다 |
| `tools/qa/kit.mjs` | 페이지 안 도우미 `window.__qa`, 검사 기록기, 게임 열기·포인터 잠금 |
| `tools/qa/fake-supabase.mjs` | 닉네임·프로필 RPC와 Realtime WebSocket을 흉내 내는 시험용 서버 |
| `tools/qa/scenarios/` | 시나리오. 새 시나리오는 `{ name, title, timeoutMs, run(t) }`를 내보내고 `index.mjs`에 넣는다 |

브라우저는 `--headless=new --disable-gpu --use-angle=swiftshader --enable-unsafe-swiftshader --mute-audio`, 화면 960x540 이하로만 띄운다. GPU를 쓰지 않고, 한 번에 하나만 띄우며, 어떻게 끝나든(시간 초과, 강제 종료 포함) 감시 프로세스가 브라우저를 함께 없앤다. 포트는 운영체제가 고른다. 헤드리스 Edge가 끝날 때 비정상 종료 코드를 남기는 것은 해롭지 않아 무시한다.

페이지를 직접 볼 때는 개발자 도구 콘솔처럼 `window.__qa`를 쓴다(`__qa.snapshot()`, `__qa.freezeBots()`, `__qa.bus`, `__qa.match`). `npm run qa`로 띄운 페이지에만 있다.

## 어디에 무엇이 있나

| 영역 | 위치 |
|---|---|
| 부트스트랩, 화면 상태, `ctx` | `js/main.js` |
| 상수(키, 이동, 히트박스, 재질), 이벤트 버스, 설정, 로거 | `js/core/` |
| 충돌·레이캐스트, 이동, 플레이어, 입력 | `js/engine/physics.js`, `movement.js`, `player.js`, `input.js` |
| 발판·포털·비밀 판정 | `js/engine/triggers.js` |
| 렌더러, 재질, 아바타, 디버그 도구 | `js/engine/renderer.js`, `materials.js`, `avatars.js`, `debug.js` |
| 무기 정의·데미지, 탄약·연사, 뷰모델, 수류탄 | `js/weapons/defs.js`, `logic.js`, `viewmodel.js`, `grenade.js` |
| 게임 무대(입력 → 무기 → 판정 연출) | `js/game/world.js` |
| 경기 규칙·점수(방장 판정), 룰셋 | `js/game/match.js`, `modes.js` |
| 연습장, 봇 | `js/game/practice.js`, `bots.js`, `navgrid.js` |
| 멀티 세션, 동기화, 전송 형식 | `js/game/session.js`, `sync.js`, `protocol.js` |
| 실시간 연결, 로비, 방 | `js/net/` |
| 맵 데이터, 빌더, 맵 검증 | `js/maps/`, `tools/check-maps.mjs` |
| 메뉴·HUD·상점 화면과 스타일 | `js/ui/`, `css/fps.css` |
| 이펙트, 합성음 | `js/fx/` |
| 계정, 포인트, 서버 스키마 | `js/account/`, `supabase/schema.sql` |
| 설계 계약 | `docs/DESIGN.md` |
