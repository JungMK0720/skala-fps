# SKALA 작전 UI (`js/ui/`)

캔버스 위에 얹는 **순수 DOM 오버레이**입니다. 메뉴 · 닉네임 게이트 · 마이페이지 · 상점 · 로비 · 방 · 로드아웃 · HUD · 스코프 · 점수판 · 결과 · 일시정지를 담당합니다.
외부 폰트, 이미지, 라이브러리는 쓰지 않습니다(그림은 SVG 도형으로 그립니다). 동적 문자열은 모두 `textContent`로 넣고, 스타일은 `css/fps.css`(`sk-` 접두사)에 있습니다.

| 파일 | 내용 |
|---|---|
| `index.js` | `createUI()`: 화면 관리, 이벤트, 커서 상태, 설정, 계정·무기·맵 연결 |
| `menu.js` `nickname.js` `mypage.js` `shop.js` `lobby.js` `room.js` `loadout.js` `hud.js` `chat.js` `scope.js` `emotes.js` `scoreboard.js` `results.js` `pause.js` | 화면별 모듈 |
| `settings.js` `controls.js` | 설정 저장과 설정 시트, 조작법 시트(메뉴와 일시정지가 같이 씀) |
| `dom.js` `parts.js` `icons.js` | DOM 헬퍼, 공통 부품(무기 카드 조각, 포인트 표시, 선택 버튼 묶음 포함), 도형 아이콘(맵 평면도, 메뉴 아이콘, 헤드샷, 메뉴 배경) |
| `multikill.js` | 연속 킬 그림(SVG 도형). 더블~헥사 킬은 육각 방패 + 킬 수만큼 탄환 + 단계마다 색·빛살·날개, 전설은 월계관 메달·별·왕관 |
| `demo.js` + `dev/ui-demo.html` | QA용 데모(목 데이터). 게임 본편에서는 로드하지 않습니다 |

## 시작하기

```js
import { createUI, relativeAngle } from './ui/index.js';
import { WEAPONS } from './weapons/defs.js';  // { sr_bolt: { name, short, icon, tagline, stats, bars, category, price }, ... }

const ui = createUI(document.getElementById('app'), {
  settings: ctx.settings,   // core의 createSettings(bus) 저장소
  account: ctx.account,     // js/account의 createAccount 결과
  maps: ctx.maps,           // js/maps/index.js 모듈(MAP_LIST·MAPS) 또는 맵 목록 배열
});
ui.setWeapons(WEAPONS);     // 한 번만 등록하면 이후에는 id만 넘겨도 된다
bus.on('account:change', () => ui.refreshAccount());
ui.show('menu');
```

- **계정은 `account`로 넘기고, 계정이 바뀌면 `ui.refreshAccount()`를 부르세요**. 떠 있는 메뉴·게이트·마이페이지·상점·로드아웃만 다시 그립니다. `account`를 주지 않으면(UI 데모) 메뉴는 `name` prop을 보여 주고 마이페이지·상점 버튼을 숨깁니다.
- **설정 저장소는 core 것을 넘기세요**(`options.settings` = `get/set/all`이 있는 객체). 그러면 UI는 그 저장소 하나로만 읽고 씁니다. 넘기지 않으면 같은 키(`skalafps.settings.v1`)를 쓰는 대체 저장소를 씁니다. 대체 저장소는 쓸 때마다 저장된 JSON을 다시 읽어서 합치므로 core 전용 키(quality, invertY 등)를 지우지 않습니다. 다만 메모리 사본이 둘이 되므로 같은 세션에서 core와 UI가 같은 키를 동시에 바꾸면 나중에 쓴 쪽이 이깁니다.
- `MAP_LIST`의 `test: true` 맵(core 테스트 맵)은 방 만들기와 맵 변경 목록에 나오지 않습니다. id로 표시할 때는 이름을 찾아 줍니다.
- `fps.css`가 페이지에 없으면 `createUI`가 `<link>`를 직접 붙입니다. 끄려면 `createUI(el, { injectCss: false })`를 쓰세요.
- `.sk-ui` 루트는 `position:absolute; inset:0; z-index:20; pointer-events:none`입니다. 입력이 필요한 화면만 `pointer-events:auto`입니다.

## API

```js
const ui = createUI(rootEl, { settings?, account?, maps?, injectCss? })
ui.show(screen, props)    // 보이기. props를 통째로 교체(생략하면 직전 props 유지)
ui.hide(screen)
ui.update(screen, props)  // 부분 갱신(기존 props에 합침)
ui.isVisible(screen) → bool

ui.hud.set({ hp, ammo, reserve, slot, slots, spread, roundTime, score, alive, ... })  // 매 프레임 호출해도 됨
ui.hud.hitmarker(head, kill?, opts?)
ui.hud.callout(text, tone)        // 크로스헤어 아래 짧은 글자. tone: 'head'|'half'|'kill'
ui.hud.banner({ icon, title, sub }) // 상단 배너. 비밀 스팟 발견 등
ui.hud.multiKill({ id, title, sub }) // 연속 킬 그림+글자. id: 'double'~'hexa'|'legend'. 줄 세우지 않고 바로 바꾼다(2.2초, 전설 2.9초). 휴대폰은 hud.center와 같이 뜨면 크로스헤어 아래로(.is-below)
ui.hud.damageFrom(angle)          // rad. 0 = 정면, +π/2 = 오른쪽, ±π = 뒤
ui.hud.center(text, ms?, opts?)   // opts: { sub, tone: 'owner'|'charterer'|'warn' }
ui.hud.reset()                    // 킬피드·피격표시·중앙메시지·배너·연속 킬 비우기(라운드/매치 전환 시)
ui.killfeed.push({ killer, victim, weaponId, head, killerTeam, victimTeam })
ui.killfeed.clear()
ui.scope.set(amount, opts?)       // amount 0~1, opts: 4 → "×4" 표시 또는 { mag, level, levels }(2단 줌)
ui.scope.get() → amount
ui.notice.show({ id?, text, ms? }) → boolean   // 전체 공지 띠(화면 맨 위 가운데). ms 동안 떠 있다(3초~1시간, 기본 30초). 이미 떠 있으면 바꾼다
ui.notice.hide(id?) → boolean                  // 띠를 내린다. id를 주면 그 공지가 떠 있을 때만
ui.notice.current() → { id, text, until } | null

ui.on(action, fn) → off           // fn(payload, action). '*'는 모든 이벤트
ui.off(action, fn)
ui.getSettings() → { sensitivity, zoomMode, fov, volume, ...저장소의 다른 키 }
ui.setSettings(patch)             // 코드에서 바꾸기(저장소에 쓰고 'settings:change' 발생)
ui.getPlayerName() / ui.setPlayerName(name)
ui.account                        // createUI에 넘긴 계정(없으면 null)
ui.refreshAccount()               // 계정이 바뀌었을 때 부른다(bus 'account:change')
ui.nicknameNeeded() → bool        // 닉네임이 없거나 서버가 닉네임을 거절했는가(게이트를 열어야 하는가)
ui.setWeapons(defs)               // 배열 또는 { id: def }
ui.setMaps(source)                // js/maps/index.js 모듈 또는 맵 목록 배열
ui.setAvatarArt(fn)               // 캐릭터 초상: fn(id, team) → 그림 주소 | null. game/index.js가 createAvatarPortraits로 연결한다
ui.needsCursor() → bool           // 커서가 필요한 화면이 떠 있는가
ui.isTyping() → bool              // UI 입력칸에 포커스가 있는가
ui.el                             // .sk-ui 루트 요소
ui.dispose()                      // 리스너·타이머·DOM·주입한 CSS 제거

relativeAngle(self{x,z}, yaw, from{x,z}) → rad   // damageFrom용. yaw = three.js rotation.y(전방 -Z)
emoteIndexAt(x, y, count = 8, deadZone = 40) → index | null   // 이모트 휠 칸 계산(12시부터 시계 방향). EMOTE_WHEEL.deadZone = 40
```

### 화면 배타 규칙

| 화면 | 종류 | `show` 할 때 자동으로 숨기는 화면 | 커서 |
|---|---|---|---|
| `menu` `mypage` `shop` `lobby` `room` `results` | 페이지(서로 배타) | 다른 페이지, `hud` `loadout` `pause` `scoreboard`, 스코프 0 | 필요 |
| `nickname` | 오버레이(모든 화면 위) | 없음. 닉네임이 있고 충돌도 없으면 스스로 닫힘. 떠 있는 동안 나머지 화면은 `inert` | 필요 |
| `hud` | 게임 | 모든 페이지 | 불필요 |
| `loadout` | 게임 오버레이 | 없음. 카드를 고르거나 시간이 끝나면 스스로 닫힘. `swap`이면 N·Esc로도 닫힘 | 필요(`compact`면 불필요) |
| `pause` | 게임 오버레이 | `scoreboard`. 계속하기/나가기 누르면 스스로 닫힘 | 필요 |
| `scoreboard` | 게임 오버레이 | 없음. 입력을 받지 않음 | 불필요 |
| `emotes` | 게임 오버레이(표시 전용) | 없음. 페이지·`pause`·`hide('hud')`가 이 화면을 닫음 | **불필요**(포인터 잠금 유지) |
| 공지 띠(`ui.notice`) | 모든 화면 위의 띠(화면 목록에 없음, `show('…')`로 다루지 않음) | 없음. 화면을 바꿔도 남고 정한 시간이 지나면 스스로 내려감. 떠 있는 동안 경기 HUD의 윗줄이 띠 높이만큼 내려감 | **불필요**(클릭을 가로채지 않음) |
| `chat` | 게임 오버레이(멀티플레이 경기) | 없음. 페이지·`hide('hud')`가 닫고, `pause`는 입력칸만 접음 | **불필요**(입력칸에 포커스만, 포인터 잠금 유지) |

`mypage`와 `shop`은 core 화면이 아니라 메뉴 안의 UI 페이지입니다(core 화면은 `menu` 그대로). `hide('hud')`는 스코프도 0으로 만듭니다. 그래서 게임 시작은 `ui.show('hud', …)` + `ui.show('loadout', …)`, 매치 끝은 `ui.show('results', …)`만 부르면 됩니다.

### 포인터 잠금 연동

UI는 직접 `exitPointerLock()`을 부르지 않고 엔진에 알리기만 합니다.

```js
ui.on('needCursor', (need) => { if (need && document.pointerLockElement) document.exitPointerLock(); });
// 이벤트 핸들러는 사용자 클릭 안에서 동기로 불린다 → 그 안에서 바로 다시 잠글 수 있다
ui.on('pause:resume', () => canvas.requestPointerLock());
ui.on('loadout:pick', ({ id, auto }) => { equipPrimary(id); if (!auto) canvas.requestPointerLock(); });
document.addEventListener('pointerlockchange', () => {
  if (!document.pointerLockElement && inMatch && !ui.needsCursor()) ui.show('pause');  // Esc로 잠금이 풀림
});
```

- 시간이 다 돼 자동으로 고른 경우(`auto: true`)에는 사용자 조작이 없어서 다시 잠글 수 없습니다. `ui.hud.set({ hint: '화면을 클릭하면 조작을 시작해요' })`를 띄우고, 캔버스를 클릭하면 잠그세요.
- Chrome은 Esc로 잠금을 푼 직후 약 1초 동안 다시 잠그지 못합니다(`requestPointerLock` 실패). 이 경우에도 위 힌트로 클릭을 안내하세요.
- 일시정지 화면에서 누른 Esc는 열린 설정/조작법 시트만 닫습니다. Esc 키로는 브라우저가 다시 잠그지 못하게 하기 때문입니다.

### 키 입력 주의(엔진)

- `ui.needsCursor()`가 true이면 게임 입력(WASD, 사격 등)을 무시하세요. 로드아웃이 떠 있는 동안 `1`~`9` 키는 UI가 무기 선택에 씁니다.
- UI 입력칸(닉네임, 방 이름, 채팅)에서 친 키는 `.sk-ui`에서 전파를 막습니다(window/document의 버블 단계 리스너에는 오지 않음). 캡처 단계 리스너를 쓴다면 `ui.isTyping()`으로 거르세요.
- **Tab 점수판**은 엔진이 처리합니다: `keydown` Tab → `e.preventDefault(); ui.show('scoreboard', data)`, `keyup` → `ui.hide('scoreboard')`. 키 반복으로 `show`가 여러 번 불려도 데이터가 같으면 다시 그리지 않습니다. 페이지 화면에서는 Tab을 막지 마세요(키보드 탐색에 씀).

## 화면별 props

### `menu`
```js
{ name?, multiDisabled? }
```
- 닉네임은 계정의 것을 보여 줍니다. `name`은 계정에 닉네임이 없을 때(게이트를 건너뛴 시험 등) 대신 보여 주는 값입니다. 닉네임 입력칸은 없습니다. 처음 정하는 곳은 닉네임 게이트, 바꾸는 곳은 마이페이지입니다.
- 플레이어 카드: 닉네임, 포인트, 마이페이지 버튼. 계정이 바뀌면 `ui.refreshAccount()`로 갱신됩니다.
- 멀티플레이는 `account.remoteEnabled`가 false이면 꺼지고 사유를 보여 줍니다. `multiDisabled`가 문자열이면 그 사유로 끕니다.
- 설정, 조작법은 메뉴 안의 시트로 열립니다(이벤트 없음. 설정 변경은 `settings:change`로 옵니다).

### `nickname` — 첫 실행 게이트
```js
{ conflict? /* bus 'account:nickname-conflict'의 값 { name, reason, message } */ }
```
- `ui.nicknameNeeded()`가 true일 때 엽니다. 닫기 버튼, Esc, 배경 클릭으로 닫히지 않고, 닉네임이 생기고 충돌이 없어지면 스스로 닫힙니다. 언제 열지는 `js/game/index.js`가 정합니다(`?autoplay=1`은 건너뜀, `?sandbox=`는 메뉴로 돌아올 때까지 미룸, 게임 중에는 메뉴로 돌아올 때까지 미룸).
- 입력하면 0.4초 뒤 `account.checkNickname`을 부르고 사용 가능 · 이미 있음 · 형식 오류 · 예약어 · 오프라인(중복 확인 못 함)을 바로 보여 줍니다. 늦게 온 응답은 버립니다. 버튼은 형식이 틀렸거나 검사 중이면 꺼져 있습니다. Enter는 검사 중이면 검사를 앞당긴 뒤 괜찮을 때 저장합니다.
- 입력칸과 상태줄은 `createNicknameField`로 마이페이지와 같이 씁니다.

### `mypage`
props 없음. 계정에서 읽습니다. 닉네임 변경(같은 검사 + 저장 버튼), 포인트, 전적 9칸(킬·데스·K/D·헤드샷·반샷·칼 킬·경기·승·플레이 시간), 장비 3칸(가진 무기 중 고르기), 캐릭터(지금 캐릭터 초상·이름·설명, 가진 캐릭터 중 고르기 → `account.equipAvatar`, [캐릭터 상점] → `mypage:shop { tab:'avatar' }`), 찾은 비밀 스팟(맵별, `createUI`의 `maps`에 `MAPS`가 있으면 "1 / 2"), 이 기기의 데이터 초기화(버튼 → 확인 → `account.resetLocal()`). Esc는 확인 상자를 먼저 닫고, 그다음 메뉴로 돌아갑니다.

### `shop`
```js
{ tab? /* 처음 열 탭 id: 무기 category · 'emote' · 'avatar'. 없으면 보던 탭 */ }
```
`ui.setWeapons`로 등록한 무기 중 슬롯 1~3을 `def.category` 탭으로 나눕니다(라이플·저격·SMG·샷건·권총·근접). 그 뒤에 이모트·캐릭터 탭이 옵니다. 카드: 아이콘, 이름, 한 줄 소개, 가격, 막대, 스탯, 구매 또는 장착. 포인트가 모자라면 구매 버튼이 꺼지고 "N P 더 필요해요"를 보여 줍니다. 사면 `ui:sound { name:'purchase' }`를 보냅니다.
- **캐릭터 탭**: 위에 지금 캐릭터와 [블루 팀 | 레드 팀] 초상 색 고르기, 아래에 캐릭터 카드(초상 · 이름 · 설명 · 가격 · 구매/장착). 사면 장착 버튼으로 바뀌고 한 번 더 누르면 입습니다(`account.equipAvatar`).
  `account.avatarShop`이 `'open'`이 아니면(서버가 아직 캐릭터를 모름, `docs/SUPABASE_SETUP.md`) 사지 않은 캐릭터의 버튼은 "구매 준비 중"으로 꺼지고 "캐릭터 구매는 서버 업데이트 뒤에 열려요"를 보여 줍니다. 기본 캐릭터와 가진 캐릭터 장착은 그대로 됩니다. 소유자가 `schema.sql`을 다시 실행하면 다음 접속부터 열립니다.
- `tab` props는 `show`로 열 때만 따릅니다. 계정이 바뀌어 `update`될 때는 보던 탭·스크롤·누른 버튼을 그대로 둡니다.
  초상은 `ui.setAvatarArt`로 받은 그림입니다. 탭을 처음 열 때 그리고(캐릭터 × 팀마다 한 번) 그 뒤로는 저장한 그림을 씁니다. 그림이 없으면(데모, WebGL 없음) 캐릭터 아이콘을 보여 줍니다.

> **모드(MODES.md 3.3 · 5절):** `mode`는 `'team'`(팀전) · `'ffa'`(개인전) · `'bomb'`(폭파 미션)이고, **생략하면 `'team'`**입니다. 팀전 화면과 동작은 이전과 같습니다.
> 폭파 미션은 팀으로 나뉘는 모드라서 팀 칼럼 · 팀 색 · 팀 시작 조건을 팀전과 똑같이 씁니다. 규칙은 언제나 클래식이고, 맵은 `MAP_LIST` 항목의 `mission: true`(클래식을 고를 수 있는 맵)만 고릅니다. 팀 이름은 블루 🟦 / 레드 🟥입니다(내부 id `owner`·`charterer`는 그대로).

### `lobby`
```js
{ rooms: [{ roomId, name, mapId, hostName, players /*수 또는 배열*/, max, status: 'waiting'|'playing',
            mode? /*'team'|'ffa'|'bomb'*/, killTarget? /*개인전 목표 킬, 기본 20*/ }],
  loading?, error?, notice? /*알림(자리 비움으로 방이 닫힘 등)*/, joining? /*roomId*/, name?, maps?, maxPlayers? /*방 만들기 상한: 세션이 준다(중계 16 · Supabase 6), 없으면 6. 시트는 처음 8명(상한이 작으면 상한), 빠른 선택 4·8·12·16명*/ }
```
대기 중인 방이 먼저 나옵니다. 꽉 찬 방과 게임 중인 방은 참가 버튼이 꺼집니다. 방이 없으면 빈 상태를, `loading`이면 스피너를, `error`면 경고와 [다시 시도]를, `notice`면 [다시 시도] 없는 알림 줄을 보여 줍니다.
- 방 항목에 규칙 · 모드 배지가 붙습니다: "클래식 · 팀전" / "칼전 · 개인전 · 10킬" / "클래식 · 폭파 미션"(`sk-mode-badge--bomb`, 폭파 미션은 규칙 값과 상관없이 클래식). 개인전 배지에는 목표 킬이 붙고, `killTarget`이 없으면 20킬로 읽습니다. 게임 중인 팀전 · 폭파 미션 방은 잠기고, 개인전은 중간 참가할 수 있습니다.
- [방 만들기] 시트: 방 이름(24자), 규칙, **모드(팀전/개인전/폭파 미션, 기본 팀전)**, 개인전일 때만 **목표 킬 5~20 스테퍼(− 값 ＋, 빠른 선택 5·10·15·20킬, 기본 20킬)**, 맵 카드(이름·영문·설명·미니 아이콘), 최대 인원 2~6 스테퍼. → `lobby:create { name, mapId, max, mode, ruleset, killTarget? /*개인전만*/, password? }`
  - 폭파 미션(💣 "공격·수비 · A/B 구역에 폭탄"): 규칙 버튼이 꺼지고 클래식으로 고정됩니다("폭파 미션은 클래식 규칙만 써요"). 맵 카드는 미션 맵만 보입니다. 미션 맵이 하나도 없으면 폭파 미션 버튼이 꺼집니다. 보내는 값은 `mode: 'bomb', ruleset: 'classic'`입니다. 다른 모드로 돌아가면 전에 고른 규칙을 다시 씁니다.

### `room`
```js
{ roomId, name, mapId, max = 8, teamMax? /*기본 ceil(max/2)*/, hostId?, meId?,
  mode? /*'team'|'ffa'|'bomb'*/, killTarget? /*기본 20*/, ruleset?, firstAttack? /*폭파 미션 전반 공격 팀, 기본 'owner'*/,
  players: [{ id, name, team: 'owner'|'charterer'|null, ready, ping, host?, me?, bot? }],
  chat: [{ name, text, team? } | { system: true, text }], starting?, maps?,
  idleLeft? /*자리 비움으로 닫히기까지 남은 초, 0이면 안내 없음*/, idleSpan? /*'1분'*/ }
```
- `idleLeft > 0`이면 머리글 아래에 "⏳ 1분 동안 아무 활동이 없어 N초 뒤 방이 닫혀요"와 [계속 기다리기](`room:stay`) 띠가 뜹니다. 대기실을 누르거나 키를 치면 `room:active`(1초에 한 번까지)를 보냅니다.
- 방장은 `p.host` 또는 `id === hostId`, 나는 `p.me` 또는 `id === meId`로 판단합니다.
- 머리글에 모드 칩이 붙습니다: "⚔️ 팀전 · 5판 3선승" / "🎯 개인전 · 20킬"(개인전은 `killTarget`) / "💣 폭파 미션 · 5판 3선승". **방장만** 머리글 오른쪽의 [⚔️ 팀전 | 🎯 개인전 | 💣 폭파 미션] 버튼으로 모드를 바꿀 수 있습니다. 바꾸면 화면에 바로 반영하고 `room:mode { mode }`를 보냅니다. 다음 `update`가 오면 그 값이 우선합니다. 다른 사람에게는 모드 칩만 보입니다. 미션 맵이 없으면 폭파 미션 버튼은 꺼집니다.
- **팀전**: 팀 칼럼 🟦 블루 / 🟥 레드에 👑, '나' 태그, 핑(색 구분), 준비 상태, 빈 자리를 보여 줍니다. 팀이 없는 플레이어는 '배정 대기' 줄에 나옵니다.
- **폭파 미션**: 팀 칼럼은 팀전과 같고, 팀 머리에 전반 진영 '먼저 공격'(기본 블루) / '먼저 수비'와 "💣 2라운드 뒤 공수 교대" 줄이 붙습니다. 규칙 칩은 🔫 클래식이고 규칙 버튼은 숨깁니다(`room:ruleset`을 보내지 않음). 맵 고르기는 미션 맵만 보여 줍니다. 세션이 규칙 클래식과 미션 맵을 맞춥니다.
- **개인전**: 팀 칼럼 대신 한 줄 명단 "🎯 개인전 · 모두가 적"을 보여 줍니다. 팀 버튼이 없고, 빈 자리는 "빈 자리 ×N" 한 줄로 묶습니다. `team` 값은 무시합니다.
- **목표 킬(개인전만)**: 규칙 칸 아래에 "🎯 목표 킬"이 보입니다. **방장만** − 값 ＋ 스테퍼와 빠른 선택(5·10·15·20킬)으로 5~20킬 중에서 고릅니다. 누르면 화면에 바로 반영하고 `room:killTarget { killTarget }`을 보냅니다(범위 밖이나 같은 값, 시작하는 중에는 보내지 않습니다). 다른 사람에게는 "먼저 N킬을 채우면 우승해요 · 목표 킬은 방장만 바꿀 수 있어요."만 보입니다.
- **[게임 시작]**(방장만): 방장은 자동으로 준비로 칩니다. 켜지지 않으면 사유를 보여 줍니다. `room:start { roomId, mapId, mode }`
  - 팀전 · 폭파 미션: 양 팀이 각각 1명 이상이고, 팀 미배정이 없고, 방장을 뺀 전원이 준비일 때만 켜집니다.
  - 개인전: 2명 이상이고 방장을 뺀 전원이 준비일 때만 켜집니다.
- [준비하기]는 누르는 즉시 화면에 반영(낙관적 갱신)되고 `room:ready`를 보냅니다. 다음 `update`가 오면 그 값이 우선합니다.
- 채팅: 최근 30줄을 보여 줍니다. **보낸 메시지는 UI가 직접 넣지 않습니다.** 엔진이 자기 메시지도 `chat` 배열에 넣어 `update`하세요(Supabase broadcast는 기본적으로 자기에게 되돌아오지 않습니다).

### `loadout`
```js
{ weapons?: [id | def, ...] /*최대 11개. 생략하면 pickableWeapons(ruleset, 보유 무기)*/, ruleset? /*'classic'|'knife'|'sniper'*/,
  seconds = 5 /*0·null이면 타이머 없음*/, selected? /*지난 선택, 시간 초과 시 기본값. 없으면 계정 장비 → 첫 무기*/, round?, title?,
  compact? /*true = 하단 작은 패널(개인전 부활 대기)*/ }
```
무기 def에서 읽는 필드는 이름이 조금 달라도 받습니다.
- `name`, `icon`(또는 `emoji`), `tagline`(또는 `subtitle`, `summary`)
- `stats`: `[{ label, value, unit? }]` 또는 `[[label, value]]` 또는 `{ label: value }`
- `bars`: `{ power, rate, accuracy, mobility, … }`(0~100) 또는 `[{ label, value }]` → 위력, 연사, 정확도, 기동성 막대

작은 카드 격자에 핵심 수치와 막대를 보여 줍니다. 칼전이면 칼 목록을 그대로 넘기면 됩니다. 계정이 있으면 아래에 보조·근접 빠른 교체 줄이 나옵니다. 지금 고르는 칸과 `ruleset`이 막는 칸은 빠집니다. 누르면 `loadout:equip { slot:'secondary'|'melee', id }`를 보내고, `js/game/index.js`가 `account.equip`을 부릅니다.

**무기 교체 창**(`swap: true`, 라운드 시작 전 대기 시간에 N으로 여닫는 창 — MODES.md 7절): 제목이 "라운드 N · 무기 교체"가 되고, 무기를 누르면 `loadout:pick { id, auto:false }`를 보내고 닫힙니다.
N이나 Esc를 누르면 고르지 않고 닫히며 `loadout:close { reason:'key', relock }`를 보냅니다(`relock` = N으로 닫았다 → 그 키 입력으로 포인터를 다시 잠글 수 있다).
시간이 끝나면 자동으로 고르지 않고 닫히며 `loadout:close { reason:'time', relock:false }`를 보냅니다. 여닫는 일은 `world.openSwap`이 맡습니다.

카드를 누르거나 숫자키 1~9를 누르면 `loadout:pick { id, auto:false }`를 보내고 닫힙니다(10번째 무기부터는 클릭). 시간이 끝나면 `{ id: selected ?? 첫 무기, auto:true }`를 보내고 닫힙니다. `update`에 `seconds`가 있으면 카운트다운을 다시 시작합니다. 숫자키는 캡처 단계에서 소비하므로 엔진의 슬롯 전환으로 넘어가지 않습니다.

**`compact: true`** (개인전에서 죽어 있는 동안 다음 무기 고르기)
- 화면을 덮지 않는 하단 작은 패널입니다. 입력은 패널에서만 받고, 나머지 화면 클릭은 캔버스로 갑니다.
- **커서를 요구하지 않습니다**(`needCursor`가 발생하지 않음). 그래서 포인터 잠금이 유지되고, 숫자키로 고르면 됩니다. 잠금이 풀려 있으면 클릭도 됩니다. 무기가 5개 이상이면 이름만 짧게 보여 줍니다.
- 고르면 `loadout:pick { id, auto:false }`를 보내지만 **닫히지 않습니다**. 선택 표시 "✔ 다음 부활에 …"가 붙고, 부활 전까지 다시 고를 수 있습니다. 엔진은 다음 부활부터 적용하세요.
- `seconds`를 생략하면 타이머가 없습니다. `seconds`를 주면 0초에 닫히며, 아직 안 골랐으면 `{ id: selected ?? 첫 무기, auto:true }`를 보냅니다.
- 닫히는 때: `ui.hide('loadout')`, 또는 **`hud.set({ respawn: null })`로 부활 패널이 사라질 때 자동으로** 닫힙니다.

### `hud` — `ui.hud.set(patch)` (= `show('hud', props)` / `update('hud', props)`, 항상 합침)
| 키 | 의미 |
|---|---|
| `hp`, `maxHp = 100` | 숫자와 바. 30% 이하는 노랑, 15% 이하는 빨강. 40% 미만이면 비네트, 20% 이하면 맥박 효과 |
| `ammo`, `reserve`, `mag?` | `7 / 90`. `reserve: Infinity`(프리미엄 총)면 `7 / ∞`. `ammo: null`이면 근접 무기(—). 탄창의 25% 이하면 노랑+"R 재장전", 0이면 빨강. `mag`가 없으면 그 슬롯에서 본 최대치로 추정 |
| `reload` (0~1) / `reloading` | 재장전 진행 바, "재장전 중…" |
| `slot` (1~4), `slots` | `slots`: 길이 4 배열(또는 `{1:…, 4:…}`). 원소는 무기 id, def, 또는 `null`(빈 슬롯은 흐리게) |
| `weaponName` | 탄약 위 무기 이름(생략하면 슬롯에서 찾음) |
| `spread` (rad, 반각) / `spreadPx` / `fov` | 동적 크로스헤어 간격. 픽셀 = tan(spread)/tan(fov/2)·화면높이/2. `fov`를 생략하면 설정값을 씀(줌 중이면 현재 카메라 fov를 넘기세요) |
| `roundTime` (초) | `1:23`. 10초 이하면 빨간 깜빡임. `null`이면 `-:--`. 개인전에서는 경기 남은 시간 |
| `score` (팀전) | `{ owner, charterer, target = 3, bestOf = 5, round? }` → "블루 2 : 1 레드 · 5판 3선승". 매치 포인트를 자동 표시 |
| `score` (폭파 미션) | 팀전 값 + `{ mode:'bomb', attack:'owner'\|'charterer' }` → 팀 이름 옆에 이번 라운드 '공격'/'수비' 꼬리표, 가운데 "폭파 미션 · 5판 3선승 · 라운드 3" |
| `score` (개인전) | `{ mode:'ffa', kills, rank, total, leaderName, leaderKills, target = 20 }` → "🎯 7킬 · 2위/5 · 1위 하늘 12 / 20". 팀 칸 대신 내 킬 / 순위 칸을 보여 주고, 1위면 금색으로 표시. 킬피드도 중립 색으로 바뀜 |
| `alive`, `teamSize` | `{ owner, charterer }` 생존자 수 / 팀 인원(점으로 표시). 팀전 전용 |
| `team` | 내 팀. '내 팀' 표시(개인전은 `null`) |
| `respawn` | `{ seconds, killer?, weaponName?, weaponId?, quick? }` → "💀 하늘에게 당했어요 · 3초 뒤 부활"(무기 칩 포함). `killer`가 없거나 나 자신이면 "💀 전사했어요". `null`이면 숨김(이때 compact 로드아웃도 닫힘). `quick: { cost, ok, touch }`(개인전 즉시 부활)이면 아래에 "[E] 즉시 부활 · 10 P"(휴대폰 "'부활' 버튼 · 10 P", 포인트가 모자라면 흐린 "즉시 부활 10 P · 포인트 부족") 줄(`quickRespawnSpec`) |
| `protect` | `true` → 조준점 아래 "🛡 보호 중" + 체력 칸 청록 테두리 |
| `hint` / `spectate` | 하단 안내 문구 / "👁️ 관전 중 · 이름". 빈 값이면 숨김 |
| `swap` | `{ seconds, weaponName?, open? } \| null` — 라운드 시작 전 무기 교체 안내 "N 을 눌러 무기 교체!" + "지금 RX-4 · 4초 뒤 시작". 휴대폰은 "눌러서 무기 교체!"이고 누르면 engine/touch.js가 `input:loadout`을 낸다 |
| `crosshair: false` | 크로스헤어 숨김 |
| `emote` | `{ name, icon } \| null` → 하단에 "💃 탱고 · 움직이면 취소"(아이콘이 없으면 🕺). 켜져 있는 동안(3인칭) 크로스헤어·히트마커를 숨김 |
| `bomb` | 폭파 미션 표시(아래 표). `null`이면 모두 지움 |

`bomb` (매 프레임 넣어도 됨. 바뀐 값만 DOM에 쓰고 표식은 `transform`으로만 옮김. `hud.reset()`도 지움. 정리 규칙은 `bombSpec()`)

| 키 | 의미 |
|---|---|
| `side` | `'attack'`\|`'defense'`\|`null`(관전). 점수 아래 진영 패널의 '공격'(주황) / '수비'(강철 파랑) 칩. 팀 색과 다르다 |
| `goal` / `status` / `tone` | 목표 문장 / 폭탄 상태 줄(`''`이면 숨김) / 상태 줄 색 `'attack'`\|`'defense'`\|`'warn'`\|`''` |
| `timer` | 폭발까지 남은 초. 패널 오른쪽 큰 빨간 카운트다운, 10초 밑은 0.1초 단위(`bombTimerText`)이고 고동친다. `null`이면 숨김 |
| `carrying` | 내가 폭탄을 들었다 → 체력 칸 오른쪽 "💣 폭탄 소지" |
| `progress` | `{ kind:'plant'\|'defuse', ratio 0~1, label }` → 크로스헤어 아래 막대(설치 주황 · 해체 파랑)와 "설치 중… 1.8초". `null`이면 숨김 |
| `prompt` | 아래 가운데 안내 "E 길게 눌러 설치"(`''`이면 숨김). 이모트 안내와 같이 뜨면 이모트 안내가 위로 비킨다. 휴대폰은 막대가 뜨면 안내를 가린다 |
| `markers` | `[{ id, label, kind:'site'\|'bomb', x, y, on, edge, planted, dist }]` 화면 좌표(CSS px, HUD 왼쪽 위 기준). `on:false`면 숨김, `edge`는 화면 끝에 붙인 표식(흐리게), `planted`는 빨갛게 고동, `dist`는 아래 "23 m". 구역은 `label`('A'), `kind:'bomb'`은 `label`과 상관없이 💣 |

- 진영 패널은 `side`·`goal`·`status`·`timer` 중 하나라도 있으면 보입니다. 패널이 있는 동안 상단 배너는 그 아래로 내려갑니다.
- 휴대폰(`html.pc-touch`)은 패널을 줄인 점수 바로 아래에 좁게 두고, 속도계와 배너를 그 아래로 내립니다. 위쪽 버튼 줄과 아래 조작 버튼을 가리지 않습니다.

- `hitmarker(head, kill)`: 헤드샷은 핑크, 킬은 빨강으로 표시합니다.
- `damageFrom(angle)`: 화면 중앙을 도는 붉은 호가 1.3초 동안 보이고 가장자리가 번쩍입니다. 동시에 최대 6개까지 표시합니다.
- `center(text, ms = 2000, { sub, tone })`: `ms`가 0, 음수, Infinity이면 다음 호출 때까지 유지합니다. `''`이면 지웁니다. `tone`을 생략하면 문구에 '블루'/'레드'/'매치 포인트'가 있는지 보고 색을 정합니다.
- `killfeed.push({ killer, victim, weaponId, head, killerTeam, victimTeam, mode?, mine? })`: `[죽인 사람] [아이콘 무기] [헤드샷] [죽은 사람]` 형식이고, 최근 5개를 5초 동안 보여 줍니다.
  - `killer`가 없거나 `victim`과 같으면 자폭으로 표시합니다.
  - 내 이름이 들어간 줄은 강조합니다. `mine: true/false`로 직접 정할 수도 있습니다.
  - 개인전이면 팀 색 없이 중립 색입니다. `mode:'ffa'`로 직접 정할 수 있고, 생략하면 HUD `score.mode`를 따릅니다.
  - `weaponName`/`weaponIcon`으로 이름과 아이콘을 덮어쓸 수 있습니다.
  - `weaponId: 'bomb'`(폭파 미션 폭발)은 무기 표에 없어도 "💥 폭탄"입니다(`icons.js` `weaponInfo`, 점수판 · 결과도 같다).

### `emotes` — 이모트 휠 (MODES.md 4.2)
```js
{ items: [{ id, n /*또는 code*/, name, icon }] /*보통 8개, consts.EMOTES를 그대로 넘겨도 됨*/,
  selected: index | null /*생략하면 cursor 방향으로 계산*/,
  cursor?: { x, y } /*화면 중앙 기준 px, y는 아래로 +*/,
  tap?: boolean /*휴대폰에서 짧게 눌러 열어 둔 휠: 커서 점을 숨기고 "칸을 누르면 시작 · 가운데는 닫기"*/ }
```
- **표시 전용 화면입니다.** B 키, 마우스, 클릭은 엔진(World)이 받아서 `show`/`update`/`hide`로 넘깁니다. UI는 이벤트를 보내지 않고, 입력도 가로채지 않습니다(`pointer-events: none`). 그래서 **`needCursor`가 발생하지 않고 포인터 잠금도 유지됩니다.**
  - B 누름 → `ui.show('emotes', { items, selected: null, cursor: {x:0, y:0} })`
  - 커서·칸이 바뀔 때 → `ui.update('emotes', { cursor, selected })`. 마우스가 움직일 때마다 불러도 됩니다(300회에 약 1ms). 칸 모양은 `items`가 바뀔 때만 다시 만듭니다.
  - B 뗌·Esc·우클릭 → `ui.hide('emotes')`
- 12시부터 시계 방향으로 8칸 쐐기를 그리고, 칸마다 번호·아이콘·이름을 넣습니다. 선택된 칸은 시안으로 강조합니다.
- 가운데에는 선택된 아이콘·이름과 "B를 떼면 시작"을 보여 줍니다. 선택이 없으면 "마우스로 고르고 B를 떼세요 · 그냥 떼면 취소"를 보여 줍니다.
- `cursor`로 가상 커서 점을 그립니다. 휠 테두리 밖은 테두리에 붙이고, 가운데 40px 안에서는 작은 빈 고리로 그립니다.
- 칸 계산 규칙은 `emoteIndexAt`과 같습니다(가운데에서 40px 이상, 12시부터 시계 방향).
- 반투명 배경이라 게임 화면이 비쳐 보입니다. 열 때 0.17초 커지며 나타나고, 닫을 때 0.14초 사라집니다.
- 휠이 열린 동안에는 크로스헤어를 숨깁니다.
- "멈춘 상태에서만 할 수 있어요" 같은 거절 안내는 `ui.hud.center(text, ms, { tone: 'warn' })`나 `hud.set({ hint })`를 쓰세요.
- 휴대폰 탭 모드에서 칸을 누른 자리는 engine/touch.js가 `.sk-emo-wheel` 상자로 계산합니다. 이 화면은 여전히 입력을 받지 않습니다.

### `chat` — 경기 채팅 (멀티플레이)
```js
ui.show('chat', { teamChat })   // session이 경기 맵을 불러온 뒤 띄운다. 연습장에는 없다. teamChat = 팀이 있는 경기(전체·팀 탭을 켠다)
ui.chat.push({ name, text, team? /*'owner'|'charterer'|null*/, system?, me?, scope? /*'team'이면 [팀] 표시*/ })
ui.chat.open() / close() / isOpen() / clear() / scope() / setScope('all' | 'team')
```
- 닫혀 있으면 새 줄만 9초 동안 보였다가 사라집니다(PC는 체력 위, 휴대폰은 왼쪽 위). 열면 지난 줄(최대 40)과 입력칸이 보입니다.
- PC: 경기 중 Enter(`input:chat`) → `open()`이 입력칸에 포커스를 줍니다. 포인터 잠금은 그대로라 마우스 시점·사격은 됩니다. Enter = 보내기(빈 칸이면 닫기), Esc = 닫기.
- 휴대폰: 채팅 버튼 → 열 때 키보드를 띄우지 않습니다. 빠른 문장(`QUICK_CHAT`)을 누르면 바로 보내고, 입력칸을 눌러 직접 씁니다. 12초 동안 아무것도 안 하면 닫습니다.
- 팀 채팅(`teamChat: true`): 입력칸 위에 전체·팀 탭이 생기고, 입력칸에서 Tab을 누르거나 탭을 누르면 보낼 범위가 바뀝니다. 새 경기는 전체부터이고 고른 범위는 그 경기 동안 남습니다.
  `teamChat`이 false면 탭이 없고 범위는 늘 전체입니다. Tab의 기본 동작(포커스 이동)은 언제나 막습니다.
- 이벤트: `chat:send { text, scope }`(보내기, session이 `sync.sendChat`. `scope`는 `'all'`·`'team'`) · `chat:scope { scope }`(범위를 바꿈) · `chat:open`(session이 PC에서 눌려 있던 이동 키를 풂) · `chat:close`.
- 글자는 모두 `textContent`로 넣습니다. 도배 제한은 session의 `CHAT_LIMIT`(보내기 5초에 4줄, 받기 한 사람당 5초에 6줄)입니다.

### `scoreboard`
```js
{ mode? /*'ffa'면 개인전, 'bomb'이면 폭파 미션*/, target? /*개인전 목표 킬, 기본 20*/, attack? /*폭파 미션 이번 라운드 공격 팀*/,
  players: [{ id?, name, team, kills, deaths, head /*또는 headshots*/, ping, alive, me?, bot?,
              rank?, respawnIn? /*ms, 개인전 부활 대기*/, protect?, bomb? /*폭파 미션: 폭탄을 든 사람*/ }] /*또는 teams: { owner:[…], charterer:[…] }*/,
  score, round?, mapId? | mapName?, meId? }
```
- 팀전: 팀별로 킬 많은 순 → 데스 적은 순 → 헤드샷 많은 순으로 정렬합니다. 전사한 플레이어는 흐리게 표시합니다.
- 폭파 미션: 팀전 표와 같고, 제목이 "폭파 미션 · 5판 3선승", 팀 머리에 `attack`(없으면 `score.attack`) 기준 '공격'/'수비' 꼬리표, `bomb: true`인 줄에 💣가 붙습니다. 누구에게 💣를 보여 줄지는 세션이 정합니다.
- 개인전: 제목 "개인전 · 목표 20킬" 아래 순위 번호가 붙은 한 목록입니다. 킬↓ → 데스↑ → 헤드샷↓ 순이고, 같은 기록은 같은 순위입니다(모두 `rank`를 주면 그대로 씀).
  - 상태 칸: 생존 / 🛡 보호 / ☠ N초(`respawnIn`) / ☠ 부활 대기
  - 머리글에 내 순위를 보여 줍니다.

### `results`
```js
// 팀전
{ winner: 'owner'|'charterer'|'draw', score: { owner, charterer }, rounds: ['owner', { winner, reason }, …],
  players: [...scoreboard와 같음], mvp? /*이름 또는 객체*/, myTeam?, mapId?, backLabel?, lobbyLabel? /*false면 숨김*/, reward? }
// 폭파 미션: 팀전 값 + mode와 라운드마다 끝난 방식 · 공격 팀
{ mode: 'bomb', ...팀전과 같음, rounds: [{ round, winner: 'owner'|'charterer'|'draw', reason /*문구*/, reasonCode: 'bomb'|'defuse'|'elimination'|'time', attack: 'owner'|'charterer' }] }
// 개인전
{ mode: 'ffa', ranking: [{ rank, id, name, kills, deaths, head /*또는 headshots*/, me?, bot? }],
  winnerId?, winnerName?, reason: 'kills'|'time'|'forfeit'|'draw', target, mapId?, meId?, backLabel?, lobbyLabel?, reward? }
// reward: account.recordMatch의 결과 { gained, breakdown: [{ label, points }], points? }
```
- `reward`가 있으면 "+N P"가 0부터 올라가고 항목별 점수와 보유 포인트를 함께 보여 줍니다. 없으면 숨깁니다. 같은 값으로 `update`해도 다시 세지 않습니다.
- 팀전: MVP를 생략하면 최다 킬(동률이면 데스 적은 순 → 헤드샷 많은 순)로 정합니다.
- 폭파 미션: 머리말 "BOMB MISSION", 점수 줄 "폭파 미션 · 블루 3 : 2 레드". 라운드 칸에 끝난 방식(💥 폭탄 폭파 · ✂️ 폭탄 해체 · ☠️ 전멸 · ⏱ 시간 종료, `reason`이 없으면 이 문구)과 이긴 진영 "공격 승"/"수비 승"이 붙고, 툴팁은 "R1 · 💥 폭탄 폭파 · 공격 승 · 블루 공격"입니다. 나머지(MVP · 표 · 보상)는 팀전과 같습니다. `data-mode="bomb"`.
- 개인전: 제목은 "🏆 하늘 우승!" 또는 "무승부"(`reason:'draw'`이거나 우승자 없음)입니다.
  - 부제는 사유 문구입니다: 먼저 20킬 달성 / 시간 종료 · 최다 킬 우승 / 다른 플레이어가 모두 나가 기권승 / 무승부.
  - 그 아래 내 순위, **🥇🥈🥉 시상대**(2위·1위·3위 배치), 순위표가 이어집니다. 라운드 기록과 MVP 칸은 숨깁니다.
- 하단 고정 버튼은 [방으로 돌아가기](`results:back`)와 [로비로](`results:lobby`)입니다.

### `pause`
```js
{ leaveLabel = '방 나가기', leaveConfirm?, note? }
```
버튼은 계속하기, 설정, 조작법, 나가기(한 번 더 확인)입니다. 연습장에서는 `leaveLabel: '연습장 나가기'`를 쓰세요.

## 이벤트(`ui.on`)

| action | payload | 비고 |
|---|---|---|
| `needCursor` | `true` / `false` | 커서가 필요한 화면이 생기거나 없어질 때만 발생 |
| `menu:sandbox` | `{ name, account }` | 연습장(설정 시트) |
| `menu:multi` | `{ name, account }` | 멀티플레이 |
| `menu:mypage` / `menu:shop` | `{ name, account }` | 마이페이지 / 상점 |
| `mypage:back` / `mypage:shop` / `shop:back` | `{}` / `{ tab? }` / `{}` | 메뉴로 돌아가기 / 마이페이지에서 상점으로(캐릭터 칸의 버튼은 `tab:'avatar'`) / 상점에서 돌아가기 |
| `ui:sound` | `{ name }` | 효과음 요청. 버튼을 누를 때 `ui_click`, 살 때 `purchase` |
| `settings:change` | `{ settings, key, value, changed[] }` | 슬라이더를 움직이는 동안 계속 발생 |
| `lobby:refresh` / `lobby:back` | `{}` | |
| `lobby:join` | `{ roomId }` | |
| `lobby:create` | `{ name, mapId, max, mode, ruleset, killTarget?, password? }` | `mode`: `'team'`(기본) / `'ffa'` / `'bomb'`. `ruleset`: `'classic'`(기본) / `'knife'` / `'sniper'`. 시트에서 규칙을 바꾸면 맵이 그 규칙의 첫 맵(칼전은 빨랫줄 옥상)으로 바뀐다. 폭파 미션은 언제나 `'classic'`과 미션 맵. `killTarget`: 개인전일 때만 5~20 |
| `room:team` | `{ team }` | 팀전만 |
| `room:ready` | `{ ready }` | |
| `room:mode` | `{ mode }` | 방장만. `'team'` / `'ffa'` / `'bomb'`(세션이 규칙 클래식 · 미션 맵으로 맞춘다) |
| `room:ruleset` | `{ ruleset }` | 방장만. 규칙을 바꾸면 그 규칙에 맞는 맵으로 다시 고른다. 폭파 미션에서는 보내지 않는다 |
| `room:killTarget` | `{ killTarget }` | 방장만, 개인전만. 5~20 정수 |
| `room:start` | `{ roomId, mapId, mode }` | 방장만, 조건을 만족할 때만 |
| `room:map` | `{ mapId }` | 방장만 |
| `room:chat` | `{ text }` | 공백을 정리한 1~120자 |
| `room:leave` | `{ roomId }` | |
| `room:stay` | `{}` | 자리 비움 안내의 [계속 기다리기] |
| `room:active` | `{}` | 대기실을 누르거나 키를 쳤다(1초에 한 번까지). 세션은 방장의 것만 활동으로 센다 |
| `loadout:pick` | `{ id, auto }` | |
| `loadout:equip` | `{ slot, id }` | `slot`: `'secondary'` / `'melee'`. 빠른 교체 줄 |
| `loadout:close` | `{ reason, relock }` | 무기 교체 창(`swap`)을 고르지 않고 닫음. `reason`: `'key'`(N·Esc) / `'time'` |
| `chat:send` | `{ text, scope }` | 경기 채팅. `scope`: `'all'` / `'team'` |
| `results:back` / `results:lobby` | `{}` | |
| `pause:resume` / `pause:leave` | `{}` | 둘 다 일시정지 화면을 스스로 닫음 |

### 폭파 미션 입력(엔진 bus, UI 이벤트 아님)

| 이벤트 | payload | 비고 |
|---|---|---|
| `input:use` | `{ down }` | engine/input.js. PC는 E 키(누를 때 `true`, 눌려 있었으면 뗄 때 `false`, 키 반복 무시, 입력이 꺼져 있으면 누르지 않음), 휴대폰은 설치/해체 버튼(`input.touch.use(down)`). 폴링은 `input.state.use`. 잠금 · 창 포커스를 잃거나 `setEnabled(false)`면 뗀다 |
| `touch:use` | `{ on, label }` | World가 보낸다(설치 · 해체할 수 있을 때 `on: true`). engine/touch.js가 설치/해체 버튼(`.pc-tb--use`, 기본 글자 '설치')을 보이거나 숨기고 글자를 바꾼다. 누르는 중에 숨으면 그 자리에서 뗀다(`input:use { down:false }`) |

## 설정

설정의 주인은 core(`js/core/settings.js`, `localStorage['skalafps.settings.v1']`)입니다. UI 설정 시트가 다루는 항목은 아래 4개이고, 기본값과 범위는 core와 같습니다.

| 키 | 기본값 | 범위 |
|---|---|---|
| `sensitivity` | 1 | 0.1 ~ 5 (배율) |
| `zoomMode` | `'hold'` | `'hold'` 누르고 있기 / `'toggle'` 토글 |
| `fov` | 75 | 60 ~ 100, 수직 시야각(°) — `camera.fov`에 그대로 |
| `volume` | 0.8 | 0 ~ 1 |

닉네임은 설정이 아니라 계정(`js/account`)이 맡습니다. 범위를 벗어난 값은 쓸 때 보정합니다. [기본값으로]는 위 4개만 되돌립니다.

## 데모 / QA

`dev/ui-demo.html`은 HTTP로 열어야 합니다(`file://`에서는 ES 모듈이 막힘). 예: 저장소 루트에서 `npm run serve`.
- 왼쪽 QA 패널에서 모든 화면과 HUD 동작(히트, 헤드샷, 피격, 킬피드, 중앙 메시지)을 띄울 수 있고, 전체 투어를 자동으로 돌릴 수 있습니다. 발생한 이벤트는 로그로 보여 줍니다.
- 메뉴부터 실제 흐름을 따라갈 수 있습니다: 멀티플레이 → 방 만들기 → 시작 → 로드아웃 → HUD → Esc 일시정지.
- HUD 조작: 좌클릭 사격, 우클릭 줌(SK-7), 1~4 슬롯, R 재장전, H 피격, K 킬피드, Tab 점수판.
  - 개인전 장면에서는 H로 죽으면 부활 패널과 compact 로드아웃이 뜨고, 3초 뒤 부활하면서 🛡 보호가 1.5초 동안 붙습니다.
- URL로 바로 열기: `&bare=1`이면 QA 패널을 숨깁니다(스크린샷용).
  - 팀전: `?screen=menu|settings|controls|lobby|lobby-empty|lobby-loading|lobby-error|create|room|room-guest|loadout|hud|hud-low|scope|scoreboard|results|pause`
  - 개인전: `create-ffa|room-ffa|room-ffa-guest|loadout-ffa|hud-ffa|respawn|scoreboard-ffa|results-ffa`
  - 이모트: `emotes-idle|emotes|emote-active`
  - 폭파 미션: `create-bomb|room-bomb|hud-bomb|hud-bomb-plant|scoreboard-bomb|results-bomb`. `hud-bomb`은 수비가 설치된 폭탄을 해체하는 장면(진영 패널 · 10초 밑 카운트다운 · 설치된 표식 · 가장자리 표식 · 해체 막대 · 안내), `hud-bomb-plant`는 공격이 폭탄을 들고 설치하는 장면(폭탄 소지 · 설치 막대)이다. 미션 맵은 맵 목록의 `mission: true`(목 데이터는 탱크 팜)
- 이모트 휠: HUD에서 **B를 누르고 있으면** 휠이 열리고, 마우스를 움직이면(상대 이동) 가상 커서가 움직입니다.
  - B를 떼면 강조된 칸이 시작되고, 안 움직이고 떼면 아무 일도 없습니다. WASD를 누른 채 떼면 "멈춘 상태에서만 할 수 있어요"가 뜹니다.
  - 휠이 열린 동안 좌클릭은 바로 시작하고, 우클릭·Esc는 닫기만 합니다.
  - 이모트 중에는 WASD·Space·클릭·R·1~4·B·피격으로 취소됩니다.
  - `../core/consts.js`의 `EMOTES`가 있으면 그것을 씁니다.
  - 대기실에서 방장이 모드를 바꾸면 그 모드로 경기가 시작됩니다.
- 데모는 `../weapons/defs.js`와 `../maps/index.js`가 있으면 실제 데이터를 쓰고, 없거나 불러오지 못하면 **목 데이터**를 씁니다(이벤트 로그 첫 줄 `demo:data`). `?mock=1`이면 항상 목 데이터를 씁니다.

## 알려진 한계

- 게임패드 조작은 없습니다. 휴대폰 터치 조작은 engine/touch.js가 맡습니다.
- 채팅에는 욕설 필터가 없습니다. 길이(120자)와 도배(session의 `CHAT_LIMIT`)만 제한합니다.
- 점수판 핑과 생존 여부는 엔진이 주는 값을 그대로 보여 줍니다.
- 16인방: 한 팀 6명·개인전 10명을 넘으면 점수판이 `is-crowded`가 되어 줄 높이를 줄이고, 개인전 순위는 두 칸으로 나눠 나란히 둡니다(가로 휴대폰은 두 팀도 나란히, 세로 휴대폰은 한 줄로 쌓고 팀전은 위쪽 큰 점수를 뺀다). Tab을 누르는 동안은 스크롤할 수 없어서입니다.
- 아이콘 일부는 이모지라 OS에 따라 모양이 다릅니다.
