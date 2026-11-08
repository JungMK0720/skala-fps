# SKALA 작전 — 멀티플레이 FPS 설계 계약서

브라우저에서 설치 없이 바로 실행되는 **오리지널** 멀티플레이 FPS.
FPS 장르 관습(WASD, 우클릭 조준, 1~4 무기 슬롯, 라운드제)만 쓰고,
**특정 상용 게임의 맵·캐릭터·무기 모델·UI·사운드·명칭은 절대 베끼지 않는다.**

## 1. 기술 스택 (변경 금지)
- 단일 페이지 `index.html`, ES 모듈(`<script type="module">`), 빌드 없음.
- three.js **0.170.0** — importmap으로 CDN 로드:
  ```html
  <script type="importmap">{"imports":{
    "three":"https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js",
    "three/addons/":"https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/",
    "cannon-es":"https://cdn.jsdelivr.net/npm/cannon-es@0.20.0/dist/cannon-es.js"
  }}</script>
  ```
- 멀티플레이: Supabase Realtime(Broadcast + Presence). 접속 정보는 `js/config.js`의
  `window.SKALA_CONFIG.supabase.{url, anonKey}` (publishable key, 공개 가능).
- 플레이어 이름: 설정 저장소의 `name` → 없으면 `플레이어NNN`(메뉴에서 바꿀 수 있음).
- 모든 코드·에셋은 이 저장소 안에만. 외부 이미지·사운드 파일 금지(도형·캔버스 텍스처·WebAudio 합성).

## 2. 좌표·단위·상수 (`js/core/consts.js`)
- 1 단위 = 1 m, y 위쪽, 지면 y = 0, 맵 원점은 맵 중앙.
- 플레이어: 키 1.8, 눈높이 1.6, 반지름 0.35, 걷기 5.2 m/s(Shift 천천히 걷기 2.4, 앉아서 2.6), 점프 초속 6.3(최고 1.24 m), 중력 -16, 계단 오름 0.45. 앉으면 키 1.25·눈높이 1.1.
- 체력 100. 라운드 중 부활 없음.
- 히트박스: head(구, 반지름 0.14, 눈높이 근처) / body(1.0~1.5 m 박스) / legs(0~1.0 m).

## 3. 디렉터리와 담당 (담당 외 파일 수정 금지)
| 경로 | 담당 |
|---|---|
| `index.html`, `js/main.js`, `js/core/*`, `js/engine/*`, `js/maps/builder.js`, `js/maps/index.js` | **core** |
| `js/maps/jetty.js` | **map-jetty** |
| `js/maps/tankfarm.js` | **map-tankfarm** |
| `js/maps/vlcc.js` | **map-vlcc** |
| `js/weapons/*` | **weapons** |
| `js/net/*` | **net** |
| `js/ui/*`, `css/fps.css` | **ui** |
| `js/fx/*` | **fx** |
| `js/game/*` (match·sync·bots) | 2차 웨이브 |

## 4. 맵 데이터 형식 (`js/maps/<id>.js`, 순수 데이터 `export default {...}`)
```js
export default {
  id: 'jetty', name: '원유 부두', nameEn: 'Crude Jetty',
  desc: '한 줄 설명',
  size: { x: 120, z: 80 },                 // 플레이 영역(바깥은 자동 벽)
  theme: { sky: '#f4a261', skyTop: '#264653', fog: [40, 160], sunDir: [-0.5, 0.8, -0.3],
           sunColor: '#ffd6a5', ambient: 0.45, water: '#1d3557' },   // water 생략 가능
  spawns: { owner: [{ x, z, rotY }, ...], charterer: [{ x, z, rotY }, ...] },  // 팀당 4곳 이상, y는 바닥 자동
  solids: [                                   // 충돌 + 렌더 (축 정렬만, 회전 없음)
    { type: 'box', x, y, z, w, h, d, mat },   // x,y,z = 박스 '바닥 중심'(y는 바닥 높이)
    { type: 'cyl', x, y, z, r, h, mat },      // 원통(탱크 등): XZ 원으로 충돌
    { type: 'ramp', x, y, z, w, h, d, dir: '+x'|'-x'|'+z'|'-z', mat }  // dir 방향으로 올라가는 경사로
  ],
  decor: [                                    // 충돌 없음 (총알은 통과)
    { type: 'pipe', from: [x,y,z], to: [x,y,z], r, mat },
    { type: 'sign', x, y, z, rotY, w, h, text: 'ZONE 1', bg: '#0b2545', fg: '#ffffff' },
    { type: 'light', x, y, z, color, intensity, dist },
    { type: 'loadingArm', x, y, z, rotY }, { type: 'flare', x, y, z }, { type: 'buoy', x, z, r }
  ]
};
```
- `mat` 팔레트(이 이름만): `concrete, asphalt, steel, rust, deck, tank, pipe, wood, glass, container_red, grass, water, white, yellow`.
- 물(water) 위로는 못 나가게 solids로 막을 것(빠져 죽는 처리 없음).
- 성능: solids 300개 이하, decor 200개 이하. 시야선이 긴 저격 구역 + 근접 교전 구역을 섞을 것.

## 5. 무기 (`js/weapons/defs.js` 등) — 슬롯과 명칭
| 슬롯 | 무기(가칭, weapons 담당이 확정) | 핵심 규칙 |
|---|---|---|
| 1 주무기 A | 🎯 **SK-7 저격소총** | 어느 부위든 **1발 킬**. 미조준 사격은 큰 탄퍼짐. **반샷(퀵스코프)**: 우클릭 줌 진행도 ≥ 50%(약 80ms)에서 쏘면 조준 정확도. 사격 후 볼트 1.2s·자동 줌 해제. 5발/예비 20 |
| 1 주무기 B | 🔫 **RX-4 돌격소총** | 연사 600rpm, 머리 100·몸 30·다리 22, 반동 패턴, 우클릭 2배 줌(정조준). 30발/예비 60 |
| 2 보조 | **P-9 권총** | 반자동, 머리 70·몸 28·다리 20. 12발/예비 24 |
| 3 근접 | **호크빌 나이프** | 좌클릭 베기 50, 우클릭 찌르기 100(느림), 사거리 1.8m |
| 4 투척 | **수류탄** | 좌클릭 투척(포물선, 바운스), 2.5s 후 폭발, 반경 6m 최대 100(거리 감쇠, 엄폐물 레이 체크). 1개 |
- 라운드 시작 시 주무기 2종 중 선택(로드아웃).

## 6. 입력
WASD 이동 · 마우스 시점(Pointer Lock) · 좌클릭 사격 · 우클릭 줌(누르고 있는 동안, 설정으로 토글 가능) · Space 점프 ·
Shift 천천히 걷기 · **Ctrl(왼·오른) 또는 C 앉기(누르고 있는 동안)** · R 재장전 · 1~4 무기 · 휠 무기 전환 · Tab 점수판 · Esc 메뉴.
- 점프 초속 6.3 m/s(최고 1.24 m, 달려서 약 1.46 m 높이까지 올라탐) — MODES.md 1절.
- 앉기: 키 1.25 m · 눈 1.1 m · 2.6 m/s · 발소리 작게 · 탄퍼짐 ×0.8. 머리 위가 막히면 앉은 채 유지, 앉은 채 Space = 일어설 수 있을 때만 일어서며 점프 — MODES.md 2절, CORE_API.md 15절.
- Ctrl+W(탭 닫기)는 페이지가 막을 수 없다 → C 키 권장, 연습장·경기 화면에서는 `beforeunload` 확인, 전체 화면이면 Keyboard Lock으로 Ctrl 조합도 게임이 받는다.

## 7. 멀티플레이
- 로비: Presence 채널 `skalafps:lobby` — 방장이 방 메타 `{roomId, name, mapId, hostName, players, max, status}`를 track. 방 목록 = 로비 presence.
- 방: Broadcast+Presence 채널 `skalafps:room:<roomId>`. **방장(host) 권위**: 팀 배정·라운드·판정 확정·점수.
- 팀: **블루 팀**(내부 id `owner`, 남색) vs **오렌지 팀**(내부 id `charterer`, 주황). 최대 8명(4:4), 최소 2명.
- 모드: 팀 섬멸전, **5판 3선승**, 라운드 2:00, 라운드 중 부활 없음. 시간 종료 시 생존자 많은 팀 → 같으면 남은 체력 합 → 같으면 무승부(재경기).
- 동기화: 각자 자기 상태를 10Hz 브로드캐스트, 원격은 100ms 지연 보간. 사격 판정은 쏜 사람 화면 기준(클라이언트 판정) → 방장이 거리·연사속도 정도만 검증 후 피해 확정.
- Supabase 무료 플랜 메시지 한도를 넘지 않게 설계(전송 빈도·페이로드 최소화).

## 8. 공통 규칙
- ES2020 모듈, 전역 오염 금지, `innerHTML`에 사용자 문자열 금지(textContent), alert/confirm/prompt 금지.
- 모든 모듈은 `dispose()`로 리스너·rAF·채널을 정리.
- 커밋/푸시는 메인테이너만.
