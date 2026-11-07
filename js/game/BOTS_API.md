# 봇 AI API — `js/game/bots.js`, `js/game/navgrid.js`

연습장(혼자 플레이)과 인원이 부족한 방을 채우는 봇. 두 모듈 모두 **three.js·DOM에 의존하지 않는 순수 ES 모듈**이다(node에서 바로 import해 테스트할 수 있다, `tests/bots.test.mjs`).
엔진의 레이캐스트(시야선)는 `view.los`로 **주입받는다**. 봇은 사람과 같은 입력(이동·시점·무기)만 내보낸다.
무기 수치는 `weapons/defs.js`에서, 쓸 수 있는 슬롯과 무기는 `game/modes.js`의 규칙에서 읽는다. 봇 쪽에 수치를 따로 적지 않는다.

## 1. 엔진 연결 예시

```js
import { buildNavGrid } from './game/navgrid.js';
import { createBot, pickBotWeapon, botLoadout } from './game/bots.js';
import { createArsenal } from './weapons/logic.js';
import { rulesetOf } from './game/modes.js';

// 맵 로드 때 1회 (140×100 맵 ≈ 20~100ms). 모든 봇이 같은 nav를 같이 쓴다.
const nav = buildNavGrid(mapData);          // mapData = maps/<id>.js 의 default export

const ruleset = 'classic';                  // 'classic' | 'knife' | 'sniper'
const pick = pickBotWeapon(ruleset, rng);   // 규칙별 확률표에서 뽑는다(아래 3.1절)
const gear = botLoadout(ruleset, pick, rng); // { primary, secondary, melee }
const brain = createBot({ id: 'bot-3', team: 'charterer', difficulty: 'normal', ruleset, primary: pick, secondary: gear.secondary, melee: gear.melee });
// stageCycle:false: 봇은 zoom을 '줌을 원하는 동안 true'로 보내므로 다단 줌 총도 1단만 쓴다
const arsenal = createArsenal({ ...gear, allowedSlots: rulesetOf(ruleset).slots, stageCycle: false, zoomMode: 'hold' });

// 매 틱(60Hz) 또는 더 드물게(10Hz — practice.js처럼 명령은 다음 판단까지 유지, yaw/pitchDelta는 틱마다 나눠
// 적용, reload/slot/jump는 한 번만) 불러도 된다. 둘 다 검증했다. 죽은 봇도 불러도 된다(빈 입력을 돌려줌).
const inp = brain.think(dt, {
  self: {
    pos: body.pos, yaw, pitch, hp, alive,                 // 필수 (pos = 발 위치, [x,y,z] 또는 {x,y,z})
    slot: arsenal.getWeapon().slot,                       // 필수에 가까움 (없으면 봇이 추정)
    ammo: arsenal.getAmmo(),                              // { mag, reserve, reloading } 또는 숫자(탄창)
    // 선택 — 있으면 더 정확:
    weapon: arsenal.getWeapon(),                          // { id, state: 'idle'|'draw'|'reload'|'bolt'|... } id가 예약과 다르면 실제 무기를 따른다
    onGround: body.onGround,                              // 발판 비행이 끝났는지 안다(착지하면 경로를 새로 잡는다)
    zoom: arsenal.getZoom().progress,                     // 0..1
    recoil: arsenal.getRecoilKick(),                      // { yaw, pitch } 카메라에 더해지는 반동 (반동 보정용)
    grenades: arsenal.getAmmo('gr_frag').mag,              // 남은 수류탄
    vel: body.vel,
    crouch: player.state.crouch                           // 봇이 지금 앉아 있나(bool|0..1) → 눈높이 1.1. 주면 '앉아서 숨는 낮은 엄폐'도 쓴다
  },
  enemies: [{ id, pos, alive, crouch?, protect? }],       // 적 '전원'을 넘긴다 — 봇이 시야각·시야선으로 직접 거른다
                                                          // crouch: 앉은 상대(true|0..1) → 머리 1.12·몸통 0.6~1.05로 낮춰 겨눔
                                                          // protect: 부활 보호 중 → 겨누기만 하고 쏘지 않음
  allies:  [{ id, pos, alive }],                          // 자기 자신은 빼도 되고 넣어도 된다
  nav,
  los: (a, b) => world.lineOfSight(a, b),                 // a,b = 배열이면서 .x/.y/.z도 있는 점 → physics 함수에 그대로 넘김
  time                                                    // (참고용, 봇은 dt를 누적해 자체 시계를 쓴다)
});

// 사람 입력과 똑같이 처리
yaw += inp.yawDelta;
pitch = clamp(pitch + inp.pitchDelta, -1.5, 1.5);
const fwd = [-Math.sin(yaw), -Math.cos(yaw)], right = [Math.cos(yaw), -Math.sin(yaw)];
let wx = fwd[0] * inp.forward + right[0] * inp.strafe, wz = fwd[1] * inp.forward + right[1] * inp.strafe;
const len = Math.hypot(wx, wz); if (len > 1) { wx /= len; wz /= len; }
const speed = (crouched ? 2.6 : inp.walk ? 2.4 : 5.2) * arsenal.getMoveMul();
world.moveCharacter(body, { x: wx * speed, z: wz * speed, jump: inp.jump }, dt, { height: crouched ? 1.25 : 1.8 });
// (선택) inp.crouch = 봇이 앉고 싶음. 쓰려면: 원하면 앉고, 일어설 땐 canStand일 때만 (MODES 2절)
const events = arsenal.update(dt,
  { fireDown: inp.fire, zoomDown: inp.zoom, reloadPressed: inp.reload, slot: inp.slot },
  { speed: Math.hypot(body.vel[0], body.vel[2]), onGround: body.onGround, walking: inp.walk });

// 총소리: 누가 쏘든(사람·봇) 사격 이벤트 위치를 모든 봇에게 알린다 (수류탄 폭발도 가능)
for (const b of bots) b.hearShot(shooterPos, { team: shooterTeam, id: shooterId });
// (선택) 피격 방향 — 사람 화면의 피격 방향 표시와 같은 정보
victimBrain.onDamage({ amount, from: attackerPos });
// 발판: 이동 뒤 stepTriggers(world, body, height, b.trig, dt). pad가 발동하면 비행 중에는 wish를 0으로 두고 brain.onLaunch()를 부른다
```

봇 사격의 판정·피해는 사람과 똑같이 엔진이 한다(`arsenal` 이벤트 → `traceShot`). 봇 모듈은 판정을 하지 않는다. 산탄은 펠릿을 모두 트레이스해 맞은 사람마다 주장 하나(`count`, `shotId`)로 보낸다(`practice.js` `botFire`).

## 2. 좌표·각도 규약 (core/consts.js와 같음)
- 1 = 1 m, y 위, 맵 원점 = 맵 중앙. `pos`는 **발 위치**(눈 = pos.y + 1.6).
- yaw 0 → -Z를 바라봄, yaw + = 왼쪽(위에서 볼 때 반시계). 전방 `(-sin yaw, 0, -cos yaw)`, 오른쪽 `(cos yaw, 0, -sin yaw)`. pitch + = 위.
- 점은 `[x,y,z]`와 `{x,y,z}` 둘 다 받는다. 봇이 `los`에 넘기는 점은 **배열이면서 `.x/.y/.z`도 가진** 객체라 `physics.lineOfSight(world, a, b)` 같은 배열 함수에도, `{x,y,z}`를 읽는 함수에도 그대로 쓸 수 있다. `los`는 boolean 또는 `{clear}`/`{visible}`/`{hit}`를 돌려줘도 된다.

## 3. `createBot(opts)` → brain
| 옵션 | 기본 | 설명 |
|---|---|---|
| `id` | `'bot'` | 고유 id (경로 분기·난수 씨앗에 쓰임) |
| `mode` | `'team'` | `'team'` \| `'ffa'`(개인전: 자기 말고 모두 적, 아래 6절) |
| `team` | `'owner'` | `'owner'` \| `'charterer'` (개인전은 생략/null) |
| `difficulty` | `'normal'` | `'easy'` \| `'normal'` \| `'hard'` |
| `ruleset` | `'classic'` | `'classic'` \| `'knife'` \| `'sniper'` — 쓸 수 있는 슬롯(modes.js). 금지된 슬롯은 입력으로도 내보내지 않는다 |
| `primary` | 규칙 기본값 | 고른 무기 id. 규칙에서 쓸 수 있으면 무엇이든(칼전이면 칼). 쓸 수 없는 값은 무시한다. 평소 드는 슬롯이 이 무기의 슬롯이 된다 |
| `secondary` | `DEFAULT_LOADOUT` | 슬롯 2 무기 |
| `melee` | `DEFAULT_LOADOUT`(칼전은 규칙 기본값) | 슬롯 3 무기 |
| `lane` | 자동 | `'left'`\|`'center'`\|`'right'` — 생략하면 아군 id 정렬 순서로 자동 배정(1명 중앙, 2명 좌·우, 3명 좌·중·우) |
| `seed` | id 해시 | 같은 씨앗이면 같은 행동(테스트 재현) |
| `tuning` | – | `BOT_DIFFICULTY` 항목 덮어쓰기 예: `{ reaction: 0.5 }` |
| `weaponInfo` | – | `BOT_WEAPON_INFO` 항목 덮어쓰기 예: `{ sr_bolt: { bolt: 1.0 } }` (`BOT_WEAPON_INFO` 자체는 defs에서 만든다) |

brain 메서드:
- `think(dt, view)` → 입력 (아래 4절). dt는 초(0.1 초과는 0.1로 자름).
- `hearShot(pos, info?)` — 총소리. `info = { team?, id?, range? }`. 같은 팀·자기 소리, 아군 위치 2.5m 안 소리, 들을 거리(난이도별 45/60/75m) 밖은 무시.
- `onDamage({ amount?, from? })` — 선택. `from`이 있으면 그쪽을 돌아보고 소리처럼 조사한다. 없어도 hp 감소를 스스로 감지해 뒤를 돌아본다.
- `reset()` — 라운드 시작 때 기억·계획 초기화(안 불러도 부활·순간이동을 감지해 스스로 초기화).
- `respawn({ spawn:{x,y,z,rotY}, loadout, protectMs })` — 개인전 부활(아래 6절). `{x,y,z,rotY,loadout}`처럼 평평하게 줘도 된다. `loadout`은 규칙에서 쓸 수 있는 무기 id면 무엇이든, 아니면 그대로 둔다.
- `setLoadout(id)` — 다음 `respawn`부터 쓸 무기만 예약(지금 목숨은 그대로). 규칙에서 쓸 수 없으면 예약을 지우고 `false`.
- `onLaunch()` — 발판에 실려 날기 시작했다. 들고 있던 경로를 버리고, 착지하면 새로 계획한다.
- `mode`(`'team'|'ffa'`), `ruleset`, `primary`(고른 무기 id), `role`(그 무기의 `def.kind`) — 읽기용 (respawn으로 무기가 바뀌면 같이 바뀜)
- `debug()` — `{ mode, ruleset, primary, weapon, homeSlot, target, lane, slot, goal, path, memory, stuckLevel, holding, ... }` (HUD·오버레이용)
- `stats` — `{ stuck, recovered, abandoned, shots, swings, heavies, pathFails, grenades, covers, thinkMs, thinks }`
- `dispose()`

### 3.1 무기 고르기 (순수 함수)
- `BOT_WEAPON_INFO[id]` — 무기 정의에서 만든 값(`slot, kind, fire, draw, mag, reserve, interval, cycle, reload, bolt, zoomIn, accurateAt, kick, effRange, pellets, burstCount, headRatio`, 칼은 `range, arc, interval, heavyRange, heavyArc, heavyInterval`, 수류탄은 `speed, pitchUp, gravity, fuse, prime, radius`).
- `botPickWeights(ruleset)` → `[{ id, weight }]`(합 1). `pickableWeapons(ruleset)`에서 만든다. 클래식: 기본 소총 40 %, 저격 25 %(기본 저격에 2배), 나머지 35 %를 고르게. 칼전·스나전: 기본 무기에 2배, 나머지는 고르게.
- `pickBotWeapon(ruleset, rng?, override?)` — 표에서 하나를 뽑는다. `override`가 그 규칙에서 쓸 수 있는 무기 id면 그대로 돌려준다(시험용 `&botweapon=`).
- `botLoadout(ruleset, pick, rng?)` → `{ primary, secondary, melee }`. pick을 제자리에 넣는다. 고르지 않는 칸은 보조 25 %로 다른 권총, 칼은 무작위.
- `loadoutKey(id)` → `'primary'|'secondary'|'melee'|null`.

## 4. 출력 `think()` → input
| 필드 | 값 | 의미 |
|---|---|---|
| `forward`, `strafe` | -1..1 (아날로그, 길이 ≤ 1) | 앞(+)/뒤, 오른쪽(+)/왼쪽 — 시선과 무관하게 아무 방향으로 이동 가능(조준하며 옆걸음) |
| `jump` | bool | 점프 경유점·끼임 복구 |
| `walk` | bool | Shift 천천히 걷기(뛰어내리기 직전, hard 봇의 추적 마무리) |
| `yawDelta`, `pitchDelta` | rad | 이번 틱 시점 변화량 (엔진이 더한다) |
| `fire` | bool | 좌클릭 '누름 상태'. 반자동·점사·볼트·칼은 한 번 눌렀다 떼고(엣지), 연사 총은 점사 동안 누르고 있다. 수류탄은 0.33초 눌렀다 뗀다(뗄 때 투척) |
| `zoom` | bool | 우클릭 누름(hold). 저격 후엔 한 번 뗐다 다시 누른다(무기 규칙). 칼을 들고 있으면 강타(찌르기) |
| `reload` | bool | R 한 번 |
| `slot` | `null` \| 1..4 | 바꿀 슬롯. `null` = 그대로. 규칙이 금지한 슬롯은 내보내지 않는다 |
| `crouch` | bool (선택) | 앉고 싶음 — 저격수가 멈춰 줌으로 겨눌 때, (normal 이상) 멀리서 멈춰 점사할 때, 낮은 엄폐에서 기다릴 때. **앉아도 표적이 보일 때만**(낮은 벽 뒤에서 앉았다 섰다 하지 않게). 이동·점프 중엔 false. 엔진이 무시해도 된다 |

## 5. 행동 (상태 머신)
`patrol`(순찰) → `engage`(교전) → `chase`(추적) / `investigate`(소리 조사) / `cover`(엄폐) → 다시 순찰.
- **순찰**: 라운드 시작 때 자기 진격로(좌·중·우) 경유점 2개 → 적 스폰 부근 → 이후 요충지(`nav.points`) 순회(최근 간 곳 제외). 30초 안에 **자기가 본·들은** 적 정보가 있으면 그 근처를, 라운드 45초가 지나면 맵 가운데 쪽을 우선한다(숨바꼭질 방지). 저격 봇은 우리 쪽 절반에서 **적 방향 시야선이 긴 지점**(고지대 가산)을 골라 14~26초(50초 이후엔 6~10초) 버티며 그 방향을 훑고(가끔 줌), 다음 지점으로 전진.
- **발견**: 수평 시야각 100°(±50°)·수직 여유 안 + `los(눈, 몸통)` 또는 `los(눈, 머리)` 통과 시에만 기억. 시야 거리 easy 60 / normal 80 / hard 100 m(저격 ×1.5, `theme.fog` 끝 × 0.8을 넘지 않음). 지각은 6/10/12 Hz, 교전 중 표적은 20 Hz로 다시 확인.
- **교전**: 반응 시간(easy 600 / normal 380 / hard 220 ms, 25 m 넘으면 조금 더) 전에는 쏘지 않는다. 시점은 목표로 **지수 수렴**(난이도별 수렴 속도·최대 회전), 조준점은 OU 과정으로 흔들리는 오차(처음 발견 직후 더 큼, 이동 중 더 큼). 머리만 보이면 머리를 겨눈다(easy는 쏘지 않고 기다림, normal은 40 m 안이거나 1.5초 지나면).
  - 무기별 운용은 `def.kind`와 `def.fire`로 정한다(아래 5.1절).
  - 저격 봇: 줌 → 정조준(진행도 ≥ `accurateAt` + 0.05) + 안정 시간 → **멈춘 상태에서** 한 발 → 볼트(`def.bolt`) 동안 줌을 떼고 기다림(볼트 중 옆걸음). 9 m 안이면 권총(normal 이상, 14 m 넘으면 다시 저격).
  - 소총 봇: 12 m(easy 22 m) 넘으면 정조준. **점사**(2~7발, 가까우면 길게), 점사 사이 반동 회복. 교전 중 좌우 **스트레이프**(옆 공간은 nav로 확인), 쏘기 직전·중에는 멈춤(카운터 스트레이프, 난이도별 확률). 멀면(> 40 m) 경로로 다가간다. 탄창이 비고 적이 15 m 안이면 권총(18 m 넘게 멀어지면 돌아가 재장전). 권총도 비면 주무기로 돌아가 재장전하고, 모두 바닥나면 칼.
  - 반동: `self.recoil`을 주면 그만큼(난이도별 45/75/90 %) 시선을 내려 보정, 없으면 무기 표의 반동값으로 추정.
  - 아군이 사선에 있으면 쏘지 않는다.
  - 교착 해소: 적이 보이는데 3.5초(저격 4.5초) 동안 한 발도 못 쐈으면(엄폐물 너머 머리만 보임 등) 소총은 다가가고, 저격은 옆으로 1.2초 비켜 각을 바꾼 뒤 그래도 안 되면 다가간다.
- **추적**: 적을 놓치면 마지막 위치(+속도 예측 normal 0.6 s / hard 1.2 s)로 경로 이동하며 그쪽을 겨눔 → 도착 후 1.6~2.8초 둘러보기. 저격 봇은 먼저 2.5~4.5초 그 각을 계속 겨눈다.
- **수류탄**(normal 30 % / hard 50 %, 슬롯 4를 쓰는 규칙에서만): 적이 엄폐물 뒤로 사라졌을 때(7~26 m, 아군이 근처에 없을 때) 한 번 굴려 보고 던진다. 낮은 포물선(16 m/s, +6°, 중력 12)으로 목표 85 % 지점을 겨눠 굴러 들어가게. 적이 다시 보이면 핀을 뽑기 전이면 취소.
- **엄폐**: 체력 ≤ 30/35/40 이거나(normal 이상) 탄창이 빈 채 교전 중이면, 14 m 안 벽에 붙은 칸 중 **적 눈과의 시야선이 끊기는** 가장 가까운 곳으로 이동(가며 응사) → 재장전·대기 1.5~3초 → 추적/조사.
- **재장전**: 탄창이 비면 즉시, 조용할 때(1.5초 이상 적 안 보임) 소총 50 %·저격 60 % 미만이면.
- **팀**: 같은 팀 봇은 좌·중·우 진격로로 갈라진다(`nav.lanes`). 정보 공유는 하지 않는다(각자 본 것·들은 것만).
- **갇힘**: 경로 찾기가 연달아 3번 실패하면(걷기 칸이 이어지지 않는 곳) 서 있지 않고 트인 쪽으로 움직여 본다.
- **끼임 감지·복구**: 1초 넘게 이동하려는데 0.35 m도 못 갔거나 경유점에 3.2초 동안 가까워지지 않으면 끼임. 단계: ① 트인 쪽으로 옆걸음+점프 ② 막힌 곳을 20초간 피하는 구역으로 넣고 재계획 ③ 막혔던 방향들을 피해(엔진 시야선으로 벽 확인) 탈출 이동, 실패하면 다른 방향 최대 4번 ④ 목표 포기. 3 m 벗어나면 복구로 본다.
- **공정성**: 위치를 기억에 넣는 길은 '보임'(시야각+시야선)뿐이다. 소리(`hearShot`)·피격은 방향/지점만 주고, 그곳으로 가서 직접 봐야 교전한다. 죽은 적은 킬로그처럼 바로 기억에서 지운다. 칼전 순찰만 예외다(5.2절).

### 5.1 무기별 운용 (`def.kind`, `def.fire`)
| 무기 | 운용 |
|---|---|
| 라이플 연사 (`ar_std`, `ar_rapid`, `ar_line`) | 위 소총 봇 그대로. 점사 시간은 같게 두어 빠른 총은 탄을 더 쓴다. 머리 ÷ 몸 피해가 5 이상인 총(`ar_line`)은 머리 조준 확률 +30 % |
| 라이플 점사 (`ar_burst`) | 한 번 눌렀다 뗀다. 나머지 탄은 저절로 나가고 쉬는 시간(`cycle`)을 기다린다. 쏘기 직전 멈춤은 난이도별 확률 |
| 지정사수 (`dm_mark`) | 5 m 넘으면 줌이 95 % 찰 때까지 기다렸다가 멈춰서 한 발씩. 다음 발까지 옆걸음. 70 m 넘을 때만 다가간다. 시야 거리 ×1.2 |
| SMG (`sm_vx3`) | 14 m 넘으면 곧바로 경로로 달려가고 멈추지 않고 쏜다. 20 m 넘으면 조준. 사거리는 감쇠 끝(40 m)까지 |
| 샷건 (`sg_bx12`) | 7 m까지 달려가며 한 번씩 쏜다. 머리를 노리지 않고 조준 허용치가 넓다. 사거리는 감쇠 끝(22 m)까지 |
| 저격 (`sr_*`) | 위 저격 봇 그대로. 시야 거리 ×1.5. 다단 줌은 `stageCycle:false`라 1단만 쓴다 |
| 권총 (`pt_*`) | 한 발씩. 22 m 넘으면 다가간다 |
| 칼 | 곧장 달려가 벤다(5.2절) |

### 5.2 규칙 (`ruleset`)
- **칼전**: 슬롯 3만 쓴다. 총·수류탄으로 바꾸려 하지 않고 엄폐하지 않는다.
  - 순찰: 총소리가 없어 서로 찾기 어려우므로 가장 가까운 적의 **대략적인 위치**(오차 easy 7 / normal 4 / hard 2 m, 거리의 30 %까지)를 몇 초마다(`huntEvery`) 받아 경로로 달린다. 공격은 여전히 '보임'이 조건이고 벽 너머를 겨누지 못한다. 경로가 없는 적(발판으로만 가는 층 등)은 4~8초 동안 빼고 다음으로 가까운 적을 찾고, 아무도 없으면 평소 순찰로 돌아다닌다.
  - 교전: 곧장 갈 수 있으면 직선으로, 아니면 경로로 달린다. 6 m 안에서는 좌우로 흔들고, 사거리 55 % 안쪽으로는 파고들지 않는다. 달리다 막히면 뛰고(`hopOver`), 3~12 m에서는 가끔 그냥 뛴다. 보이지만 칼이 닿지 않는 위층에 있고 갈 길도 없는 적은 4~8초 동안 잊는다.
  - 공격: `def.melee.slash.range` + 0.15 m 안이고 판정각 안이면 벤다. 강타 차례(`meleeHeavy` easy 10 / normal 20 / hard 35 %)면 `stab` 사거리·판정각을 확인해 `zoom`으로 강타한다. 판정각이 안 맞으면 베고 강타는 다음으로 미룬다.
- **스나전**: 슬롯 1·3만 쓴다. 권총과 수류탄이 없다. 코앞(눈~발 3.6 m)에서 볼트·재장전 중이면 칼을 들고, 7 m 넘게 멀어지면 저격총으로 돌아간다.
- **클래식**: 슬롯 1~4 전부.
- 시험용으로 `primary`에 보조나 칼을 주면(`&botweapon=pt_magnum`, `ml_knife`) 그 슬롯을 평소 슬롯으로 쓴다.

### 5.3 발판
`stepTriggers`로 봇도 발판을 탄다(비밀 스팟·포털은 무시). 경로에 발판을 넣지는 않는다. 길에서 밟으면 날아가고, 착지하면 경로를 새로 잡는다. 목표가 있거나 옆으로 보내는 발판은 날아가는 동안 엔진이 wish를 0으로 둔다(공중 조작이 궤적을 깎아 착지점을 놓친다). 제자리 발판(수평 속도 1 m/s 이하)은 wish를 그대로 두고, 두뇌가 멈추려 하면 앞으로 밀어 같은 자리로 떨어져 계속 튀지 않게 한다. 재발동 대기 상태 `b.trig`는 부활 때 새로 만든다.

## 6. 개인전(FFA) · 부활 · 앉기 · 높아진 점프 (MODES.md 1·2·3.2절)
```js
const brain = createBot({ id, mode: 'ffa', difficulty, ruleset, primary });   // team은 생략(null)

// 매 판단: 자기 말고 모두(사람·봇)를 enemies에 넣는다. allies는 [] (allies에 넣어도 FFA에서는 적으로 친다)
brain.think(dt, { self, enemies: others.map((o) => ({ id: o.id, pos: o.pos, alive: o.alive, crouch: o.crouch, protect: o.protect })), allies: [], nav, los });

// match.js 'spawn' 이벤트 { id, spawn:{x,y,z,rotY}, loadout, protectMs } → 몸·무기는 엔진이 옮기고/리셋하고
brain.respawn({ spawn: ev.spawn, loadout: ev.loadout, protectMs: ev.protectMs });
b.cmd = IDLE; b.thinkAcc = THINK_DT;   // ★ 10Hz 판단이면: 죽기 전에 들고 있던 명령(fire 등)을 버리고 바로 새로 판단
// 다음 think부터 self.alive = true, self.pos = 스폰 위치

brain.hearShot(pos, { id: shooterId });   // 개인전은 team을 보지 않고 자기 소리만 거른다
```
- **개인전에서 달라지는 것**: 아군 오사 회피·아군 소리 거르기·좌중우 진격로가 없다. 순찰은 '내가 30초 안에 본·들은 곳 근처'(75 %) → 맵 가운데 쪽(50 %) → 요충지 순회. 저격 봇은 50 m 안에서 전체적으로 트인 지점을 골라 7~12초 버틴다. 부활해도 죽기 전에 본·들은 정보(마지막 교전 지점)는 기억한다(사람도 기억하는 정보). 부활 보호 중인 적(`protect`)은 쏘지 않는다.
- **부활 감지**: `respawn`을 안 불러도 `self.alive`가 false→true가 되면 스스로 초기화한다. 무기는 `respawn`의 `loadout`(또는 `setLoadout` 뒤 `respawn`)으로 바뀌고, `self.weapon.id`를 주면 실제로 든 무기도 따라간다.
- **앉은 상대**: `enemies[i].crouch`(true | 0..1, physics.js와 같은 해석)면 시야 확인점·조준점을 `consts.HITBOX_CROUCH`(없으면 머리 1.12, 몸통 0.6~1.05)로 낮춘다. 자기 `self.crouch`면 눈높이 `PLAYER.CROUCH_EYE`(1.1).
- **점프**: navgrid `jumpHeight` 기본값은 `consts.PLAYER.JUMP_V`로 정한다(6.3 → **1.2 m**, 물리 한계 1.46 m에서 0.25 m 여유). 바로 옆 칸 대신 **2~3칸 앞 착지 칸까지 넘어가는 점프 간선**(얇은 벽·난간·파이프 넘기)도 만든다. 점프 경유점에는 `jumpAt`(도약 지점)·`jumpTop`(넘을 턱 높이)이 붙고, 봇은 **속도가 착지 쪽을 향한 채 도약 지점 0.9 m 안이거나 벽에 막혀 섰을 때**만 뛴다(모서리를 돌자마자 뛰면 벽을 따라 미끄러져 놓친다). 점프 중 머리 위 천장도 확인한다. 봇 몸 이동도 consts의 새 `JUMP_V`를 써야 점프 간선이 맞는다.
- **clip 막이**(`mat:'clip'`, builder.js와 같음): 걷기·점프에서는 벽, `nav.raycast`(요충지 시야 분석)에서는 통과. 게임 중 시야는 엔진 `los`(noRay 무시)를 그대로 쓴다.

## 7. 난이도 표 (`BOT_DIFFICULTY`, 주요 값)
| | easy | normal | hard |
|---|---|---|---|
| 반응 시간 | 600 ms | 380 ms | 220 ms |
| 헤드샷 비율(목표, 명중 중 머리) | 5 % | 15 % | 30 % |
| 조준 수렴 속도 / 최대 회전 | 4.5 /s, 4 rad/s | 7 /s, 6.5 rad/s | 11 /s, 9.5 rad/s |
| 조준 오차 σ | 0.40 m + 1.1 cm/m | 0.26 m + 0.7 cm/m | 0.15 m + 0.45 cm/m |
| 점사 | 2~4발 | 3~5발 | 4~7발 |
| 스트레이프 / 카운터 스트레이프 | 35 % / 15 % | 65 % / 60 % | 90 % / 90 % |
| 수류탄 | 안 씀 | 30 % | 50 % |
| 엄폐 체력 | 30 | 35 | 40 |
| 칼 강타 확률 (`meleeHeavy`) | 10 % | 20 % | 35 % |
| 칼전 사냥 갱신 / 위치 오차 (`huntEvery`, `huntErr`) | 3~4.5 s / 7 m | 1.8~3 s / 4 m | 1~1.8 s / 2 m |

헤드샷 비율은 '머리를 노리는 확률'(`headAim`, 저격은 `headAimSniper`)과 몸통 조준 높이(`bodyY`)로 맞췄다. 실측(아래 9절)은 weapons/logic.js의 반동·탄퍼짐 기준이라, 무기 수치가 크게 바뀌면 `tuning`으로 다시 맞춘다.

## 8. `buildNavGrid(mapData, opts)` → nav
옵션(기본): `{ cell: 1.0, agentRadius: 0.35, stepHeight: 0.45, agentHeight: 1.8 (← consts PLAYER), maxDrop: 3.2, jumpHeight: jumpHeightFor(JUMP_V)=1.2, groundY: 0, allowBrinks: false, strategicSpacing: 6, sightMax: 90 }`. `jumpHeightFor(jumpV, gravity, step)`도 내보낸다.

- **맵 해석**: 충돌체·크기·테마·스폰은 `maps/collision.js`의 `buildCollision`에서 읽는다(물리와 같은 기준). 기존 맵 4개로 비교한 결과 노드·간선·GOOD 영역·요충지가 이전 구현과 같다. `size`가 없는 맵만 영역이 물리 쪽 계산(`외곽 × 2 + 4`)으로 바뀐다.
- **발판**: `pads`에는 충돌체가 없으므로 그 아래 바닥이 그대로 걷기 칸이다. 발판을 타는 경로는 계획하지 않는다.
- **2.5D 걷기 칸**: 맵을 `cell` 칸으로 나누고 칸마다 서 있을 수 있는 바닥 높이를 여러 층 저장한다(지면, 컨테이너·데크·탱크 위, 다리 아래와 위). 판정은 **engine/physics.js와 같은 규칙**(세로 원기둥 캐릭터, 발밑 = 원 아래 STEP 이하 최고 윗면, 벽 = 원과 겹치고 윗면이 발+STEP 초과, ramp 높이 = 사각형 안으로 클램프한 점). 머리 위 1.8 m 여유 필수. 지면은 maps/builder.js처럼 '플레이 영역 − 구멍(y<0이고 윗면 ≤ 0.05인 박스)'(`theme.ground:'none'`이면 y=0 평면), `mat:'water'` 위는 걷기 불가.
- **간선**: 이웃 8칸으로 짧은 이동 시뮬레이션을 돌려 걷기(WALK) / 뛰어내리기(DROP ≤ 3.2 m, 한 방향) / 점프로 오르기(JUMP ≤ 1.2 m, 한 방향, 넘어가기 점프는 2~3칸)를 만든다 → 경사로·계단으로 층이 이어지고 난간·얇은 벽은 막힌다. 원 끝만 걸친 '가장자리' 칸(중심 아래가 STEP보다 깊음)은 조금만 어긋나도 떨어지므로 뺀다.
- **GOOD 영역**: 스폰에서 갔다가 돌아올 수 있는 칸만 경로·무작위 지점에 쓴다(물·탱크 지붕·함정 제외).
- **GOOD 밖에서 돌아오기**: 발판으로만 올라가는 지붕처럼 GOOD 밖의 칸에는 `maxDrop`보다 높은 뛰어내리기 간선도 만든다(낙하 피해가 없다). 바로 옆 칸이 아직 낮은 난간 위면 2~3칸 앞까지 본다. GOOD 칸에서 시작한 경로에는 영향이 없다. 개수는 `info.escapeEdges`.
- `findPath(from, to, { smooth=true, avoid:[{x,z,r,cost}], maxExpand })` → `[{x,y,z,node, jump?, drop?}]` (시작점 제외, 마지막 = 목표) 또는 `null`. A*(옥틸 휴리스틱, 벽 붙은 칸 가산) + 칸 DDA 시야선 줄당기기 + **실제 기하 재검증**(실패 구간은 다시 쪼갬). `jump`/`drop`은 그 경유점에 가려면 점프/뛰어내리기가 필요하다는 뜻. `avoid`는 경로와 평탄화 모두 피한다.
- `randomPoint(region?, rng?)` — region: 없음 \| `{x,z,r,minR?}` \| `{minX,maxX,minZ,maxZ}` (+`minY`/`maxY`).
- `nearestWalkable(p, maxDist=8)` → `{x,y,z,node,dist}` \| null
- `walkStraight(a, b)` — 실제 기하로 a(발)→b 직선 걷기 가능? (봇의 모서리 자르기 확인) · `losWalk(a,b)` — 칸 단위(빠름)
- `raycast(a, b)` — 맵 solids만으로 본 정적 시야선(테스트·분석용. 게임에선 엔진 `los` 사용) · `rayDistance(o, dir, max)`
- `coverCandidates(p, maxDist, maxCount)` — 걸어서 닿는 벽 붙은 칸(가까운 순)
- `lanes(fromSpawn, toSpawn)` → `{ left:[p,p], center:[p,p], right:[p,p] }`
- `points` — 요충지 `[{x,y,z,open,far,cover,elev,dist[12]}]`(6 m 간격 후보의 12방향 시야 거리), `sightToward(point, dx, dz)`
- `spawns`, `bounds`, `fog`, `info`(생성 시간·노드 수·단계별 시간), `debug()`(오버레이용 원시 배열)

## 9. 테스트
`node --test tests/bots.test.mjs`(`npm test`에 포함): 실제 `weapons/logic.js`와 `engine/physics.js`로 칼전 추격·베기·강타, 스나전 슬롯 제한, 모든 주무기, 점사·샷건·탄 소진, 무기 뽑기 확률, 발판 비행과 지붕에서 내려오기, 내비 해석을 시뮬레이션한다.

아래 측정치는 초기 개발 때 쓴 별도 시뮬레이션의 결과다(저장소에 없다, 무기 2종·맵 3종 기준). `nav_test.mjs`(생성·경로 시간, 층간 경로, 스폰↔스폰, 엔진 물리로 경로 추종) · `fair_test.mjs`(벽 너머·시야각·반응 시간·소리) · `sim_test.mjs`(2:2·4:4 교전, physics.js + weapons/logic.js + grenade.js 그대로 사용) · `stuck_test.mjs`(navgrid가 모르는 숨은 장애물·U자 함정) · `behav_test.mjs`(점사·저격 볼트·권총 전환·재장전·수류탄·엄폐·경로 분기) · `calib.mjs`(명중률·헤드샷 비율), `fair_sim.mjs`(교전 중 벽 너머 사격 0 확인), `jump_test.mjs`(점프 높이·넘어가기·천장·clip), `ffa_test.mjs`(개인전·부활·보호·앉은 적 조준). 실제 maps/*.js가 있으면 그 맵으로, 없으면 합성 맵(`synthmap.js`)으로 돈다.

## 10. 측정치 (개발 머신, node 24 — 다른 작업과 CPU를 같이 써서 2~3배까지 흔들림)
- 그리드 생성(cell 1.0, 중앙값): synth 140×100 ≈ 35 ms, tankfarm 130×100 ≈ 53 ms, vlcc 150×50 ≈ 21 ms (첫 실행 42~67 ms). cell 0.5도 57~165 ms.
- 경로 탐색 1000회 평균 0.11~0.22 ms(최대 1.5~2.3 ms), GOOD 노드 쌍 실패 0, 스폰↔적 스폰 66/66.
- 엔진 물리(physics.moveCharacter)로 경로를 끝까지 따라가기 600/600 (맵당 무작위 200쌍).
- think 1회 평균 3~10 µs(엔진 los 비용 포함). los 호출은 봇 전체 초당 30~230회.
- 교전 시뮬레이션(2:2·4:4, physics.js + weapons/logic.js + grenade.js) 60Hz 판단 96판 + 10Hz 판단(practice.js 방식) 72판: 전부 섬멸 종료, 8초 이상 정지 0, 입력 오류 0. hard vs easy 전승.
- 반응 시간 실측(처음 본 순간 → 첫 사격): easy 622 / normal 408 / hard 238 ms.
- 헤드샷 비율 실측(같은 난이도끼리, 명중 중 머리): 소총 easy 5.1 % / normal 13.5 % / hard 30.2 %, 저격 easy 5.5 % / normal 15.6 % / hard 30.5 %.
- 공정성: 3:3 15판 사격 810발 중 '직전 0.3초 동안 어떤 적과도 시야선이 없던' 사격 0발.
- 끼임: 경로 위에 navgrid가 모르는 상자 14~26개를 놓아도 장시간 정지 0. 숨은 U자 벽 함정 탈출 5~16초.
- (2차) 점프 `JUMP_V 6.3`·`jumpHeight 1.2`: 0.7 / 0.95 / 1.15 m 단을 8방향에서 엔진 물리로 올라타기 각 8/8, 1.35 m 단과 낮은 천장(2.55 m) 아래 1.0 m 단은 간선 없음. 넘어가기 간선으로 1.1 m 벽 넘기(실제 봇) 4/4. clip 얹힌 벽은 넘지 않고 돌아감, clip은 정적 시야선 통과. 넘어가기 간선을 넣은 뒤에도 4개 맵(jetty 포함) 물리 추종 800/800, 생성 중앙값 27~65 ms.
- (2차) 개인전: 4개 맵 × 3경기(10Hz 판단 포함), 봇 6명 10킬 선승 — 52~159초에 끝남, 매 경기 5~6명이 킬·6명 모두 사망, 부활 20~40회, 장시간 정지 0, 벽 너머 사격 0. K/D hard 174/115 > normal 137/141 > easy 85/140. 15 m 앞 사격 순간 시선 높이: 서 있는 적 1.21 m → 앉은 적 0.78 m(앉은 몸통). 보호 중인 적에게 0발.

## 11. 알려진 한계
- cell 1.0에서는 폭 ≈ 1.0~1.7 m 미만 통로·1 m 미만 고가 통로가 칸 정렬에 따라 빠질 수 있다(필요하면 `cell: 0.5`). 칸 모서리에 선 아주 가는 기둥(r < 0.15)은 그리드에 안 잡힐 수 있다(물리가 미끄러뜨림).
- 낙하 피해가 없다고 가정해 3.2 m까지 뛰어내린다(엔진이 낙하 피해를 넣으면 `maxDrop`을 낮출 것). 사다리·웅크리기는 없다.
- 봇끼리·사람과의 국소 회피(서로 비켜 가기)는 없다. 좁은 통로에서 몸이 막히면 끼임 복구로 푼다.
- 수류탄은 바운스를 예측하지 않는다(목표 85 % 지점 겨냥). 투척 수치는 weapons/defs.js에서 읽는다.
- 줌 중에도 시야각을 좁히지 않고, 소리는 거리만 보고 벽 감쇠는 없다.
- 팀원끼리 적 위치를 공유하지 않는다(공정성 우선). 목표(점령 등) 개념이 없는 섬멸전·개인전 순찰이다.
- 칼전 순찰은 가장 가까운 적의 대략적인 위치를 쓴다(5.2절). 다른 규칙의 '보임' 원칙과 다른 유일한 예외다.
- 발판을 일부러 타지는 않는다. 포털은 쓰지 않는다.
- 앉기: 봇은 `crouch`를 '원함'으로만 내보낸다. 앉아야만 지나가는 통로(머리 위 1.25~1.8 m)는 길찾기에 넣지 않았다. 넘어가기 점프 간선은 축 방향 2~3칸만(대각선 없음).
- 10Hz 판단으로 명령을 들고 있는 엔진은 부활 때 들고 있던 명령을 버려야 한다(6절 ★). 안 그러면 부활 직후 0.1초 동안 죽기 전 입력이 실행된다.
