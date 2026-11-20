<!--
  Date: 06NOV2026
  Author: Minkyu Jung
  Purpose: 자산 장부. 게임에 들어가는 모든 소리·그림·음성·모델·글꼴·외부 라이브러리의 출처와 라이선스, 권리 상태를 적는다. 새 자산을 넣는 규칙, 지운 자산, 이름을 바꾼 항목과 남겨 둔 낮은 위험 항목, 내부 id를 그대로 둔 이유도 여기에 둔다.
-->
# 자산 장부

판매하려면 화면·소리·모델·이름에 남의 저작물과 상표가 없어야 하고, 모든 자산의 출처가 이 문서에 있어야 한다(docs/PRODUCT_PLAN.md 1절). 마지막 점검: 2026-11-21.

## 1. 규칙

- **새 자산은 장부에 먼저 적는다.** 파일 자산(음원, 음성, 이미지, 3D 모델, 글꼴 등)을 저장소에 넣는 커밋에는 이 문서의 3절 표에 한 줄을 함께 넣는다. 한 줄에는 다음을 모두 적는다.
  - 파일 경로(또는 묶음 경로)
  - 출처 주소(내려받은 페이지 URL. 직접 만든 것이면 만든 도구와 명령)
  - 라이선스 이름과 라이선스 원문 주소(예: CC0 1.0, MIT, 구매 계약서 위치)
  - 내려받은 날짜(또는 만든 날짜, YYYY-MM-DD)
  - 상업 이용 상태: `확인함`(라이선스가 판매를 허락함) / `미확인` / `불가`
  - 저작자 표시가 필요하면 표시 문구와 표시하는 곳
- **채울 수 없는 칸이 있으면 넣지 않는다.** 출처를 모르는 파일, 라이선스가 "개인용"이거나 적혀 있지 않은 파일은 넣지 않는다. "나중에 채움" 같은 빈 줄도 두지 않는다.
- **코드로 만든 자산**(WebAudio 합성음, three.js 도형, 캔버스 텍스처, SVG 도형)은 2절에 종류별로 한 줄씩 있다. 새 종류를 만들면 한 줄을 더한다. 직접 짓되 기존 작품(곡, 캐릭터, 로고)을 흉내 내지 않는다.
- **이름도 자산이다.** 무기·카드·좀비·맵·이모트·화면 문구에 다른 게임·영화·브랜드의 고유 이름, 실제 상표, 실제 기업을 떠올리게 하는 이름을 쓰지 않는다. 장르 일반어(산탄총, 저격, 미니건 등)는 된다. 바꾼 기록은 4절.
- **외부 라이브러리**도 3절에 적는다(버전, 주소, 라이선스). importmap에 새 CDN 모듈을 넣으면 `integrity`도 넣는다(index.html).
- 상업 이용이 `미확인`인 자산이 남아 있으면 판매를 시작하지 않는다.

## 2. 코드로 만든 자산 (파일 없음)

모두 이 저장소의 코드가 실행 중에 만든다. 외부 소스 파일을 읽지 않는다.

| 종류 | 위치 | 만드는 방법 | 권리 |
|---|---|---|---|
| 효과음(총성, 발소리, 폭발, UI 소리 등) | `js/fx/audio.js` `DEFS` | WebAudio로 잡음·음정·금속 울림을 쌓아 합성 | 직접 만듦 |
| 이모트 음악 11종 | `js/fx/audio.js` `EMOTE_DEFS` | 직접 쓴 음표·리듬 표를 합성 루프로 렌더(docs/EMOTE_BGM.md) | 직접 만듦. 기존 곡의 선율·리듬을 옮기지 않음 |
| 이모트 동작 11종 | `js/engine/emoteanim.js` `DEFS` | 직접 설계한 관절 키프레임과 작은 IK | 직접 만듦(2026-11-21에 8종을 새로 설계, 4절) |
| 시각 효과(총구 섬광, 입자, 탄흔, 속도 줄기 등) | `js/fx/effects.js` | three.js 도형·셰이더·캔버스 텍스처 | 직접 만듦 |
| 캐릭터·무기·소품 모델 | `js/engine/avatars.js`, `js/weapons/viewmodel.js`, `js/engine/decor.js` 등 | three.js 기본 도형을 코드로 조립 | 직접 만듦 |
| 맵 | `js/maps/*.js` | 데이터 표(상자·원통·경사로)와 캔버스 글자 표지판 | 직접 설계. 실제 시설·상용 게임 맵을 옮기지 않음 |
| 연속 킬 그림 | `js/ui/multikill.js` | SVG 도형 | 직접 만듦 |
| 화면 아이콘(무기·이모트·버프의 그림 글자) | `js/weapons/defs.js`, `js/core/consts.js` 등의 `icon` | 유니코드 이모지 글자. 그림은 플레이어 기기의 글꼴이 그린다 | 글자 코드만 씀. 그림 파일을 배포하지 않음 |
| 글꼴 | `index.html` `--f-ui` 등 | 글꼴 파일을 넣지 않고 기기에 있는 글꼴 이름만 지정 | 배포하지 않음 |

## 3. 파일 자산과 외부 라이브러리

| 파일 | 출처 | 라이선스 | 날짜 | 상업 이용 | 비고 |
|---|---|---|---|---|---|
| `audio/voice/double.mp3`, `triple.mp3`, `legend.mp3` | `node tools/make-voice.mjs` — Windows 내장 한국어 음성 `Microsoft Heami Desktop`(System.Speech)으로 합성, ffmpeg로 음 높이·음색·크기 다듬음 | Windows 운영체제 사용권에 딸린 음성. 생성한 소리를 상품에 넣어 재배포하는 조건은 확인하지 않음 | 2026-11-10 | **미확인** | 녹음·다른 게임 소리 아님 |
| `audio/voice/quadra.mp3`, `penta.mp3`, `hexa.mp3` | 위와 같은 도구·음성. 문장을 "쿼드 킬!", "5연속 처치!", "6연속 처치!"로 바꿔 다시 만듦 | 위와 같음 | 2026-11-21 | **미확인** | 파일 이름(id)은 그대로 |
| three.js 0.170.0(`three`, `three/addons/`) | https://cdn.jsdelivr.net/npm/three@0.170.0/ (원본 https://github.com/mrdoob/three.js) | MIT (https://github.com/mrdoob/three.js/blob/dev/LICENSE) | 2026-11-07 | 확인함 | index.html importmap, `integrity` 있음. 날짜는 처음 넣은 커밋(37f4109) |
| cannon-es 0.20.0 | https://cdn.jsdelivr.net/npm/cannon-es@0.20.0/ (원본 https://github.com/pmndrs/cannon-es) | MIT (https://github.com/pmndrs/cannon-es/blob/master/LICENSE) | 2026-11-07 | 확인함 | index.html importmap, `integrity` 있음. 날짜는 처음 넣은 커밋(37f4109) |

안내 음성 6개는 판매 전에 바꿔야 한다. 고를 길(소유자 결정, PRODUCT_PLAN 11절 2번): 직접 녹음(성우와 저작권 양도 계약), 상업 이용이 명시된 음성 합성 서비스로 같은 도구를 다시 돌림, 또는 음성 없이 효과음만.

## 4. 바꾸거나 지운 자산 (2026-11-21, PRODUCT_PLAN 2.1절)

### 지운 파일

| 파일 | 문제 | 처리 |
|---|---|---|
| `audio/emotes/*.bin` 6개(takeL·veggie·crissCross·creamCheese·fromYou·selfie), `audio/emotes/manifest.json` | 출처·권리 기록이 없는 외부 곡을 잘라 암호화한 묶음 | 지움. 이모트 음악은 모두 합성음(2절). 묶는 도구 `tools/pack-emote-audio.mjs`와 풀이 키 `js/fx/emote-key.js`, 음원 읽기 코드도 지움 |

지운 파일은 저장소의 과거 기록에 남아 있다. 기록에서 지우는 일은 PRODUCT_PLAN 2.2절(소유자 작업)이다.

### 새로 만든 이모트 (이름·설명·동작·음악 모두 새로)

| id(그대로) | 예전 이름 | 새 이름 | 새 동작 |
|---|---|---|---|
| `takeL` | L을 가져가 | 작전 성공 | 주먹 찌르기 두 번, 가슴 치기, 두 팔 힘주기 |
| `veggie` | 야채 | 무전 확인 | 귀에 손 대고 끄덕임, 앞을 가리킴, 엄지 |
| `sideToSide` | 사이드 스텝 | 경계 이동 | 낮은 자세로 총을 겨눈 게걸음 |
| `crissCross` | 크리스 크로스 | 몸풀기 | 옆구리 늘이기, 팔다리 털기 |
| `tango` | 탱고 | 제자리 행진 | 무릎 높이 세 걸음, 발 모아 차렷 |
| `creamCheese` | 크림치즈 허니 | 수신호 | 정지·집결·전진·엎드려 수신호 |
| `fromYou` | 당신에게서 | 쌍안경 정찰 | 쌍안경으로 훑고 가리킨 뒤 엄지 |
| `selfie` | 셀카 | 깃발 흔들기 | 큰 깃발을 흔들고 꽂은 뒤 허리에 손 |

### 바꾼 이름 (화면 이름만, id는 그대로)

| 대상 | 예전 | 지금 | 이유 |
|---|---|---|---|
| 무기 `sm_uzi_dual` | UZ-2 듀얼 우지 | TW-2 쌍발 기관단총 | 상표(Uzi) |
| 근접 `ml_case` | 007 가방 | BC-7 서류 가방 | 영화 상표(007) |
| 근접·카드 `ml_yasuo` | 야스오의 검 | GL-1 질풍검 | 다른 게임 캐릭터 이름. 기술 구성(순간이동 공중 연계)도 지면 충격파로 바꿈(docs/AUGMENTS.md) |
| 무기 `sg_auto` | AS-12 스톰브레이커 | AS-12 템페스트 | 영화 소품 이름 |
| 무기 `gv_gun` | GV-1 중력건 | GV-1 특이점포 | 다른 게임 무기 이름 |
| 무기 `sr_bolt` | SK-7 볼트 | SR-7 볼트 | 실제 기업 연상 |
| 무기 `sg_shorty` | SH-2 쇼티 | SH-2 단축 산탄총 | 다른 게임의 같은 역할 무기 이름 |
| 맵 `jetty` | 울산 … SK-7 선석, 표지판 BERTH SK-7 | 가상 항만 K-7 선석, BERTH K-7 | 실제 지역·기업 시설 연상 |
| 좀비 | 블리츠(갈고리) | 사슬꾼 | 다른 게임 캐릭터 연상 |
| 좀비 | 스피터 | 산성 좀비 | 다른 게임의 같은 역할 좀비 이름 |
| 연속 킬 | 쿼드라 킬 · 펜타 킬 · 헥사 킬 | 쿼드 킬 · 5연속 처치 · 6연속 처치 | 다른 게임의 안내 용어 |
| 설계 문서 | "다른 게임처럼" 식 비교 | 동작 자체로 설명 | 문서에 남의 게임 이름을 쓰지 않음 |

## 5. 내부 id

저장된 휠·구매 기록·서버 가격표(`supabase/schema.sql`)·통신 코드가 id에 묶여 있어 화면 이름만 바꾸고 id는 그대로 둔다. 화면에는 보이지 않는다.

- 이모트: `takeL`, `veggie`, `sideToSide`, `crissCross`, `tango`, `creamCheese`, `fromYou`, `selfie`
- 무기: `sm_uzi_dual`, `ml_yasuo`, `ml_case`, `sg_shorty`, `mg_m249`, `gl_m32`
- 통신·상태: `yasuoSwing`, `yasuoSword`, 안내 음성 파일 id `quadra`·`penta`·`hexa`
- id에서 따온 코드 안 이름(화면에 안 나옴): `SM_UZI_DUAL_PATTERN`, `uziGun`·`UZI_DX`(`js/weapons/viewmodel.js`), `yasuoHits` 같은 질풍검 상태 이름

id를 바꾸려면 가격표, 저장 데이터 이전, 테스트를 한 번에 바꿔야 한다(POINTS_SOP 사고 참고). 지금은 하지 않는다.

## 6. 남겨 둔 낮은 위험 항목

장르 일반어이거나 화면에 나오지 않아서 그대로 둔 것. 다시 점검할 때 이 목록부터 본다.

| 항목 | 위치 | 판단 |
|---|---|---|
| 게임 이름 "SKALA 작전" | 화면 곳곳, `js/core/brand.js` | 교육 과정 이름과 같음. 이름은 소유자가 정함(PRODUCT_PLAN 3절). 이 장부의 범위 밖 |
| MN-6 미니건, BZ-9 바주카포, M-44 매그넘 | `js/weapons/defs.js` | 무기 종류를 뜻하는 일반어 |
| 호크빌 나이프, 탄토, 구르카 나이프, 카게 카타나 | `js/weapons/defs.js` | 칼 모양을 뜻하는 일반어 |
| 제우스의 번개 | 무기·카드 | 신화. 특정 작품 이름이 아님 |
| 좀비 "마녀" | `js/game/horde/rules.js` | 일반어 |
| 모드 "폭파 미션", 맵 "넥서스" | `js/ui/dom.js`, `js/maps/index.js` | 일반어 |
| 경례, 손 흔들기, 환호 박수 이모트 | `js/core/consts.js` | 일반 동작 |
| 이동 코드의 "Quake" 언급(`moveQuake`, 주석의 `PM_Friction`·`PM_Accelerate`) | `js/engine/movement.js`, `js/core/consts.js` 주석 | 화면에 안 보임. 가속 공식(알고리즘)을 설명하는 이름이다. 원본 소스(GPL)를 옮긴 코드인지는 확인하지 않았다(소유자 확인 필요) |
