# js/game — 상태 동기화 (sync · interp · protocol)

net 담당의 `Room`(js/net, README 참고) 위에서 도는 **게임 네트코드**다. 엔진·three.js·DOM에 의존하지 않는 순수 모듈이라 node에서 그대로 테스트된다.

| 파일 | 내용 |
|---|---|
| `sync.js` | `createSync()`: 송신 주기·이벤트 묶음·수신 라우팅·방장 전환·시계 동기화(`createClock`)·통계 |
| `interp.js` | `createInterp()`: 원격 플레이어 보간 버퍼(적응형 지연, 외삽, 순서·중복 처리) |
| `protocol.js` | 메시지 스키마와 압축 직렬화(짧은 배열, cm·0.01rad 정수, 코드 표), 신뢰할 수 없는 입력 검증 |

---

## 1. 빠른 시작

```js
import { createSync } from './game/sync.js';

const sync = createSync({
  room,                                   // net Room (createRoom/joinRoom 결과)
  getLocalState: () => inMatch ? {
    pos: player.pos, vel: player.vel,     // [x,y,z] m, m/s (vel을 안 주면 위치 차분으로 추정)
    yaw: player.yaw, pitch: player.pitch, // rad (CORE_API 규약)
    slot: player.slot, hp: player.hp,
    onGround: player.onGround, zoom: player.zoom, walking: player.walking,
    alive: player.alive, reloading: player.reloading
  } : null,                               // null이면 상태를 보내지 않는다(로비·관전)
  onRemoteState: (id, state, info) => {}, // 원격 상태가 새로 도착(읽기 전용, 최신 것만)
  onEvent: (e) => {                       // 아래 4절
    if (e.type === 'fire') fx.tracer(e);
    if (e.type === 'hitClaim') match.onHitClaim(e);   // 방장에게만 온다
  },
  rateHz: 10
});

// 렌더 프레임마다(원격 아바타)
for (const id of sync.remoteIds()) {
  const s = sync.getRemote(id, performance.now());  // { pos, vel, yaw, pitch, slot, hp, alive, ..., mode, delay, stale }
  if (s) avatars.set(id, s);
}

sync.sendFire({ weaponId: 'ar_std', origin: eye, dir, hit: point, hitKind: 'player' });
sync.sendHitClaim({ victimId, part: 'head', weaponId: 'ar_std', dist: 23.4 });   // → 방장
const g = sync.sendGrenade({ pos, vel });     // g = 정본 → 던진 사람도 g로 시뮬레이션
if (sync.isHost()) sync.sendMatch(snapshot, [{ type: 'kill', killer, victim, weaponId, part }]);

sync.dispose();        // room.leave() 전에 부르면 남은 이벤트가 퇴장 프레임에 같이 나간다
await room.leave();
```

---

## 2. 송신 규칙 (net 프레임 위)

net은 같은 JS 턴의 `send/sendTo`를 **프레임 1개**로 묶고, 프레임 수를 `room.rate`(방장이 예산으로 정한 Hz)로 제한한다. Supabase는 프레임 수를 센다. sync는 '턴'마다 메시지를 한꺼번에 넘긴다.

- **상태 Hz = min(rateHz=10, room.rate)**(15 상한). `room.rate`는 매 틱(25ms) 읽으므로 방장이 rate를 바꾸면 바로 따른다. 상태는 `{ merge: true }`로 보낸다.
- 거의 안 움직이면(위치 ±1cm, 각도 ±0.01rad, 속도 ≤5cm/s, 이산 필드 동일) **2Hz**, 죽었으면 **1Hz**.
- **사격·히트 주장·수류탄·경기 변경·로드아웃·채팅은 따로 프레임을 열지 않는다.** 다음 상태 프레임에 같이 실린다.
  이벤트가 쌓이면 유휴·사망 주기 대신 활성 주기(1/상태Hz)로 돌아가므로 대기는 최대 한 간격이다(10Hz 100ms, 3.5Hz 286ms).
  연사해도 프레임 수는 상태 Hz 그대로다(실측: 600rpm 연사 중 9.8프레임/s, 프레임당 이벤트 0.86개).
- 안전장치: 토큰 버킷(min(room.rate, 15)/s, 비축 2) + **1초 창 15턴** + 최소 간격 25ms. 막히면 다음 턴에 합친다(coalesce).
- **손실 대비**: 히트 주장·수류탄·로드아웃·채팅은 두 번 보낸다(두 번째는 다음 턴). 받는 쪽은 id로 중복을 지운다.
  경기 이벤트(킬 등)는 3초 동안 스냅샷마다 다시 실린다(eid로 중복 제거). 스냅샷은 바뀔 때와 1초마다 보낸다.
  로드아웃은 5초마다 상태 턴에 다시 실려 늦게 온 사람도 받는다.
- 핑·퐁·스냅샷 재전송도 상태 턴에 얹혀 간다. 상태가 없을 때(로비)만 250ms 간격으로 따로 턴을 연다.
- 방장이 아니면 히트 주장은 `sendTo(방장)`, 내가 방장이면 보내지 않고 `onEvent('hitClaim', local:true)`로 돌려준다(처리 경로 하나).

---

## 3. API

### `createSync(opts) → sync`
| 옵션 | 기본 | 설명 |
|---|---|---|
| `room` | (필수) | net Room. 쓰는 것: `me, isHost(), hostId(), players(), on(), send(), sendTo()`, 있으면 `rate, meta.net, now()` |
| `getLocalState` | `() => null` | 위 1절 모양. `pos`/`vel`은 `[x,y,z]` 또는 `{x,y,z}`, `flags` 숫자(32 이상 비트는 그대로 전달)도 가능 |
| `onRemoteState(id, state, info)` | | 새 최신 상태. `info = { first, localT(렌더 시간축 로컬 시각), arrival }`. **state는 버퍼와 공유 → 읽기 전용** |
| `onEvent(e)` | | 4절 |
| `rateHz` | 10 | 움직일 때 상태 Hz 상한 (실제 = min(rateHz, room.rate, 15)) |
| `idleHz` / `deadHz` | 2 / 1 | |
| `maxMsgPerSec` | 15 | 클라이언트당 턴(=net 프레임) 상한 |
| `autoTick` / `tickMs` | true / 25 | false면 `sync.tick(now)`를 직접 부른다(테스트·엔진 루프) |
| `now` | `performance.now` | 시계 함수 |
| `interp` | | `createInterp` 옵션 덮어쓰기(예: `{ maxDelay: 300 }`) |
| `reliableRepeat`, `matchResendMs`, `matchEventTtlMs`, `loadoutResendMs`, `pingBurst`, `pingIntervalMs`, `staleMs`, `forgetMs`, `prevHostGraceMs` | 2, 1000, 3000, 5000, 5, 3000, 3000, 10000, 1500 | `SYNC_DEFAULTS` 참고 |

### 메서드
| 메서드 | 설명 |
|---|---|
| `sendFire({ weaponId, origin, dir, hit?, hitKind?:'world'\|'player', kind?:'stab', t? })` | 사격 연출(궤적·소리). `t` = 사격 로컬 시각(기본 지금). 칼 강타·찌르기는 `kind:'stab'`(원격이 강타 소리를 낸다) |
| `sendHitClaim({ victimId, part, weaponId, dist, kind?:'shot'\|'slash'\|'stab', count?, shotId?, t? \| shotT? })` → id | 방장에게 히트 주장. `t`(로컬)를 주면 방장 시계로 바꿔 `shotT`로 보낸다. `count` = 이 사람에게 맞은 펠릿 수(기본 1), `shotId` = 같은 발을 묶는 양의 정수. 잘못된 값이면 0 |
| `sendGrenade({ pos, vel, t? })` → `{ id, gid, pos, vel, t, localT }` | 전송 해상도로 맞춘 **정본**. `t`는 방장 시계. 던진 사람도 이 값으로 시뮬레이션 |
| `sendMatch(snapshot, events?)` → mseq \| false | **방장 전용**. 5절 |
| `sendLoadout(obj)` / `sendChat(text)` | 장비 알림(≤256B JSON. 세션은 `{ pick, primary, secondary, melee, round, m }`을 보낸다), 채팅(120자, 제어문자 제거 — 화면에는 `textContent`로만) |
| `getRemote(id, renderTime?)` → state \| null | 렌더용 보간 상태(6절). 매 프레임 호출 |
| `getRemoteAtHost(id, hostT)` | (방장 검증용) 방장 시각 `hostT`에 그 플레이어가 있던 상태. 지연 없이 버퍼에서 바로 |
| `remoteIds()` / `remote(id)` | 상태를 받은 원격 id 목록 / `{ state, loadout, lastHeard }` |
| `lastMatch()` | 마지막으로 받은(방장이면 보낸) `{ from, seq, snapshot, at }` — 방장 이전 때 이어받기용 |
| `hostNow()` / `toHostTime(local)` / `toLocalTime(host)` | 방장 시계(7절) |
| `isHost()` / `hostId()` / `clock` | `clock = { offset, rtt, synced, samples, hostSince }` |
| `stats()` | 9절 |
| `tick(now?)` = `update` | 수동 구동 |
| `dispose({ flush = true })` | 리스너·타이머 정리. flush면 남은 이벤트를 한 번 보낸다. 여러 번 불러도 안전 |

---

## 4. `onEvent` 이벤트

| type | 필드 | 설명 |
|---|---|---|
| `fire` | `from, weaponId, origin, dir, hit, hitKind, kind?, t(=senderT), at` | `at` = 원격 아바타의 렌더 시간축에서 그 사격이 일어나는 로컬 시각. 아바타와 맞추려면 `at`에 재생, 소리를 빨리 내려면 즉시. `kind`는 칼 강타일 때만 `'stab'` |
| `hitClaim` | `from, id, victimId, part, weaponId, dist(m), kind, shotT(방장 시계), count, shotId, age(ms), local?` | **방장에게만**. 중복 제거됨. 방장이 거리·연사속도·생존 등을 검증해 `sendMatch`로 확정. `count`·`shotId`를 `match.claimHit`까지 그대로 넘겨야 샷건 피해가 맞는다 |
| `grenade` | `from, id, gid, pos, vel, t(방장 시계), localT, age` | 모두 같은 결정론 시뮬레이션(아래 참고). 폭발 데미지는 방장이 계산해 `sendMatch`로 확정 |
| `match` | `from, seq, snapshot\|null, events[], fresh, late?` | `snapshot`은 seq가 새로울 때만(아니면 null). `events`는 처음 보는 것만(eid 중복 제거) |
| `loadout` | `from, loadout` | 바뀌었을 때만 |
| `chat` | `from, text` | |
| `host` | `hostId, prevHostId, isHost` | 방장 교체. 내가 새 방장이면 `lastMatch()`로 경기를 이어받아 `sendMatch`로 **다시 공지**한다(endsAt 등 방장 시계 값은 새 방장 기준으로 다시 계산) |
| `leave` | `id` | 원격 퇴장 → 아바타 제거 |
| `closed` | `reason` | room이 닫힘 |

수류탄 결정론: `pos`(cm), `vel`(cm/s), `t`(ms)가 정수로 양자화된 정본에서 시작해, 고정 스텝(예: 1/120s)과 같은 맵 충돌로 적분하면 모든 화면이 같은 궤적을 그린다(+, −, ×, ÷, sqrt만 쓰면 브라우저 간 동일). 폭발 시각은 `t + 퓨즈`(방장 시계)이며, 로컬에서는 `toLocalTime(t + 2500)`이다.

---

## 5. 경기 스냅샷 (`sendMatch`, 방장)

```js
sync.sendMatch({
  phase: 'live',                         // 'lobby'|'warmup'|'loadout'|'live'|'roundEnd'|'matchEnd' (그 밖의 문자열도 됨)
  round: 2,
  score: { owner: 1, charterer: 0 },     // 또는 [1, 0]
  endsAt: sync.hostNow() + 120000,       // 방장 시계(sync.hostNow) — room.now()와 섞지 말 것
  players: { [id]: { team: 'owner', hp: 70, alive: true, kills: 1, deaths: 0 } },
  mapId: 'jetty'                         // 그 밖의 키도 그대로 전달(무손실, ≤8KB)
}, [
  { type: 'damage', attacker, victim, amount: 30, part: 'body', hp: 70 },
  { type: 'kill', killer, victim, weaponId: 'sr_bolt', part: 'head', headshot: true }
]);
```
- **match.js**: `sync.sendMatch(m.snapshot(), ev)`처럼 `m.snapshot()`을 그대로 넘기면 된다. 자체 키(`v, ph, tl, p, …`)가 부가 영역으로 무손실 전달되고(최악 1.7KB), 받은 `snapshot`을 `applySnapshot()`에 넣는다. 남은 시간이 상대값(`timeLeftMs`)이라 방장 시계 기준과 무관하다.
- 스냅샷이 바뀔 때마다 불러도 된다(턴당 최신 하나만 나감, merge). 같은 스냅샷은 1초마다 다시 간다.
- 이벤트 스키마(위치 압축): `kill [killer, victim, weaponId, part]`, `damage [attacker, victim, amount, part, hp]`, `roundStart [round]`, `roundEnd [round, winner, reason]`, `matchEnd [winner]`, `explode [gid, pos]`, `team [player, team]`. 나머지 키·다른 type도 무손실로 간다(이벤트 하나 ≤8KB, 넘으면 몸통이 비고 콘솔 경고). 받는 쪽 이벤트에는 `eid`가 붙는다.
- 받는 쪽은 **현재 방장**의 스냅샷만 받는다. 교체 직후 1.5초 동안은 옛 방장의 늦은 이벤트만 받는다(스냅샷은 새 방장 것).

---

## 6. 보간 (`interp.js`)

- 시간축: 원격 상태의 `t`는 보낸 쪽 로컬 시계다. 도착 오프셋 `d = 도착 − t`의 최근 64개 최솟값을 `base`로 잡고, 렌더 시각 `R = now − (base + delay)`.
- **수신 간격 I** = 움직이는 패킷끼리의 실제 도착 간격 중앙값(최근 16개). 표본이 4개 미만이거나, 방 rate가 30% 넘게 바뀌면 힌트 `1000 / min(10, room.rate)`를 쓰고 다시 잰다.
- **delay = clamp(2.2 × I, 100, 450) ms**, **외삽 상한 = 1.5 × I**(최대 1000ms). 목표가 바뀌면 재생 오프셋을 실시간의 10%(늘림)·2%(줄임) 속도로 옮긴다 → 화면 시간이 거꾸로 가지 않는다. 250ms 넘게 차이 나면 한 번에 맞춘다.
- 위치·속도·pitch 선형, yaw 최단 각도 보간. 이산 필드(slot, hp, alive, flags…)는 앞 스냅샷 값.
- 두 스냅샷 사이가 max(3m, 30m/s × 간격)보다 멀면 순간이동(부활·라운드 시작)으로 보고 보간하지 않는다.
- 최신 이후는 마지막 속도로 외삽(공중이면 중력 −16)하다가 상한에서 정지. 죽은 상태는 외삽하지 않는다. y는 0 아래로 내려가지 않는다.
- seq로 정렬 삽입: 순서가 바뀐 패킷은 제자리에, 같은 seq는 `dup`, 버린 구간보다 오래된 것은 `late`. 보낸 쪽이 재시작한 것(seq↓·t↑ 등)은 감지해 초기화.

`getRemote()` 반환: `{ id, pos:[x,y,z], vel, yaw, pitch, slot, hp, flags, onGround, zoom, walking, alive, reloading, loadout, mode:'interp'|'extrap'|'hold', extrapolated, delay(ms), senderT, age, stale, t }`. core `SnapshotBuffer.sample()`과 같은 `pos`/`yaw`/`pitch`/`extrapolated`/`t` 모양이다. `stale` = 3초 넘게 소식 없음.

### 인원별 실효 Hz와 보간 지연 (net 기본: 예산 80 msg/s, 4명 이상 relay)
| 인원 | 토폴로지 | room.rate | 상태 Hz | 수신 간격 I | 보간 지연 | 외삽 상한 | 방 이벤트/초 | 월 200만 메시지로 |
|---|---|---|---|---|---|---|---|---|
| 2 | mesh | 20 | **10** | 100ms | 220ms | 150ms | 40 | 13.9시간 |
| 3 | mesh | 8.5 | **8.5** | 118ms | 259ms | 176ms | 76.5 | 7.3시간 |
| 4 | relay | 8 | **8** | 125ms | 275ms | 188ms | 80 | 6.9시간 |
| 5 | relay | 6 | **6** | 167ms | 367ms | 250ms | 78 | 7.1시간 |
| 6 | relay | 5 | **5** | 200ms | 440ms | 300ms | 80 | 6.9시간 |
| 7 | relay | 4 | **4** | 250ms | 450ms | 375ms | 76 | 7.3시간 |
| 8 | relay | 3.5 | **3.5** | 286ms | 450ms | 429ms | 77 | 7.2시간 |

- 화면에 보이는 지연 ≈ 한쪽 지연(mesh 약 90ms, relay 멤버↔멤버 약 160~230ms — net 실측) + 보간 지연.
- relay에서는 방장이 다음 프레임에 묶어 중계하므로 실제 수신 간격이 송신 간격보다 길어질 수 있다. delay는 실측 간격을 따른다.
- 다른 방이 동시에 경기 중이면 net이 예산을 나눠 rate가 더 낮아진다(예: 8인 방 2개 → 1.5Hz → 지연 450ms, 외삽 상한 1000ms).

---

## 7. 시계 동기화

- 방장 시계 기준 NTP 4타임스탬프: 비방장이 `g2p [pid, t0, d0]`를 방장에게 보내고 방장이 `[pid, t0, t1, t2, d2, e0]`로 답한다.
  `rtt = (t3 − t0) − (t2 − t1)`, `offset = ((t1 − t0) + (t2 − t3)) / 2`. 최근 15개 중 **RTT 하위 절반의 offset 중앙값**.
- net 큐 대기 보정: 핑·퐁에 `room.now()`(d)를 싣고, 받는 쪽이 net 프레임 시각 `message.t`와 비교해 net 큐에서 기다린 시간만큼 t0·t2를 고친다. relay 8인에서 방장 버킷이 꽉 차도 오차가 80ms에서 7ms로 줄었다.
- 처음과 방장 교체 후 250ms 간격 5번, 이후 3초마다. 모두 상태 턴에 얹혀 가서 프레임이 늘지 않는다.
- 방장 교체 시 새 방장 프레임의 도착 오프셋으로 즉시 대략 맞추고(시드), 핑으로 다시 맞춘다(실측 1.3~2초에 오차 10ms 이내).
- **`sync.hostNow()`는 방장의 `performance.now()` 기준**이다. net의 `room.now()`(방장 `Date.now()` 기준)와 값의 기준이 다르다. `shotT`, 수류탄 `t`, `endsAt`처럼 sync로 주고받는 시각은 모두 `sync.hostNow()`/`toHostTime()`으로 만들고 같은 함수로 읽는다.

---

## 8. 메시지 스키마와 크기

이벤트 이름 = `'g' + 버전 + 타입`(옛 클라이언트와 섞이지 않게). 지금 버전은 2다. 모두 배열이고, 위치는 cm 정수, 속도는 cm/s, 각도는 0.01rad, 방향은 단위벡터×1000, 시각은 ms 정수다.

| 이벤트 | payload | 크기(B) | 프레임 안(B) |
|---|---|---|---|
| `g2s` 상태(merge) | `[seq, t, x,y,z, yaw,pitch, vx,vy,vz, slot, flags, hp]` flags = onGround 1, zoom 2, walking 4, alive 8, reloading 16, crouch 32, 이모트 64~512 | 57 (정지 41) | 66 |
| `g2f` 사격 | `[weaponId, t, ox,oy,oz, dx,dy,dz, (hx,hy,hz, hitKind)]`. 칼 강타는 명중점 없이 끝에 `'stab'` 한 칸 | 65 (명중점 없음 45, 강타 58) | 74 |
| `g2h` 히트 주장 → 방장 | `[id, victimId, part, weaponId, distCm, kind, shotT, count, shotId?]` | 57 | 66 |
| `g2x` 수류탄 | `[id, px,py,pz, vx,vy,vz, t]` | 40 | 49 |
| `g2m` 경기(merge) | `[mseq, phase, round, sO, sC, endsAt, [[id,team,hp,alive,k,d],…], [[eid,type,…],…], rest?]` | 8인 + 이벤트 2개 362 | 371 |
| `g2l` 로드아웃(merge) | `[id, { pick, primary, secondary, melee, round, m }]` (JSON 256B 넘으면 비운다) | 최악 117 | 126 |
| `g2c` 채팅 | `[id, text]` | 한글 20자 57 | 66 |
| `g2p` 핑 / 퐁(merge) | `[pid, t0, d0]` / `[pid, t0, t1, t2, d2, e0]` | 25 / 43 | 34 / 52 |

`g2f`의 `'stab'` 칸은 sync가 붙이고 읽는다. `decodeFire`는 모르는 칸을 무시한다. 경기 규칙은 `g2m` 부가 영역의 `rs`로 간다. `g2l`을 어떻게 읽는지는 SESSION_API.md 3절 "규칙"에 있다.

- net 프레임 + Phoenix 봉투는 약 190B다. 따라서 상태만 담은 프레임은 254B, 상태+사격은 328B다(추정, net/realtime.js와 같은 모양으로 계산).
- 실측 송신량(클라이언트당): 10Hz 약 2.8KB/s, 3.5Hz 약 1.3KB/s. 수신량은 그 × (N−1)이다.
- 양자화 오차: 위치 ≤ 0.5cm, 각도 ≤ 0.005rad(1만 건 무작위 왕복 확인). 디코더는 형식이 틀리면 null을 돌려주고 절대 throw하지 않는다(2만 건 퍼징). `__proto__` 키는 무시한다.

---

## 9. Supabase 무료 플랜 계산 (`stats()`)

- 한도(net README 4절, 공식 문서와 서버 소스 확인): **프로젝트 전체 초당 100 메시지**. broadcast 1건은 송신 1 + 받은 사람 수만큼 센다(`message_dispatcher.ex`가 구독자 전달마다 +1). 5초×12 버킷의 **60초 평균**으로 판정하고, 넘으면 채널을 강제 종료한다. **월 200만 메시지**(Free).
- **8인 방 10Hz**: mesh는 8×8×10 = **640/s**(한도의 6.4배), relay는 (3×8−2)×10 = **220/s**(2.2배)라 불가능하다. 예산 80이면 relay 3.5Hz(77/s)가 된다.
  시뮬레이션에서 예산을 무시하고 8인 mesh 10Hz로 돌리면 실측 571 이벤트/s, net 기본 8인은 74.9/s(1초 최대 91)였다.
- 월 할당량: 예산 80으로 꽉 찬 방 하나가 1시간에 약 29만 메시지를 쓴다 → **프로젝트 전체로 월 약 7시간**(6절 표 마지막 열).
- `sync.stats()`: `{ stateHz, turnRate, roomRate, sent:{turns, msgs, bytes, turnsPerSec, msgsPerSec, bytesPerSec, byType}, recv:{…}, topology, roomFramesPerSec, estEventsPerSec, coalesced, waited, eventsPerTurn, maxTurnsIn1s, dropped:{dup,bad,ignored}, clock, remotes:{id:{delay,target,maxExtrap,interval,jitter,lost,dup,late,reordered,interp,extrap,hold,framesPerSec,heardAgo}} }`.
  `estEventsPerSec`는 다른 사람 프레임/초(상태 seq 증가율)로 이 방의 Supabase 이벤트/초를 추정한다(디버그 HUD용).

---

## 10. 측정 (규칙 도입 전 버전의 기록, 스크립트는 저장소에 없다)

지금 저장소에서 도는 연결 시험은 `tests/session-wiring.test.mjs`다(SESSION_API.md 7절). 아래 수치는 그 전에 잰 값이고 새 Supabase 프로젝트에서 다시 재지 않았다.

**가짜 room**: net Room을 흉내 냈다(같은 턴 묶음, merge, `room.rate` 토큰 버킷, mesh/relay 중계, 방장 선출). 조건은 지연 80±40ms(균등), 손실 3%, 프레임 중복 1%, +150ms 스파이크 2%(순서 뒤바뀜)다. 진짜 궤적은 1ms 해상도이고 걷기·정지·점프와 가속 40m/s²를 넣었다. 보간 오차는 렌더 시각의 진짜 위치와 비교했다.

| 시나리오 | 상태 Hz | 보간 RMS (움직일 때) | 이론 하한* | 움직일 때 외삽/정지 | 보간 지연 / 화면 지연 | 이벤트/초 |
|---|---|---|---|---|---|---|
| 4인 mesh(rate 20) | 10 | 1.9cm (1.8) | 1.2cm | 1.0% / 0% | 229 / 270ms | 141 |
| 8인 mesh(예산 무시) | 10 | 1.8cm (1.9) | 1.2cm | 1.0% / 0% | 229 / 270ms | **571** |
| net 기본 4인(relay) | 8 | 4.0cm (4.3) | 1.7cm | 2.7% / 0.1% | 308 / 407ms | 74.7 |
| net 기본 8인(relay)+방장 퇴장 | 3.5→4 | 11.3cm (12.4) | 6.4cm | 10.8% / 0.2% | 453 / 578ms | 74.9 |
| 2인, 600rpm 연사 계속 | 10 | 2.0cm | 1.3cm | 1.3% / 0% | 234 / 275ms | 39.9 |

\* 이론 하한: 손실·지터 없이 진짜 궤적을 송신 간격으로 샘플해 선형보간했을 때의 오차(같은 렌더 시각). yaw RMS는 4.2°(하한 3.9°, 10Hz)다.

- 순서·중복: 프레임 중복 1%와 스파이크가 있어도 사격 연출·히트 주장·경기 이벤트·수류탄 **중복 0**이었다. 히트 주장 100%, 경기 이벤트는 '정확히 한 번' 100%였다. 사격 연출은 94~97%로, 묶음 손실 때문이다(재전송하지 않음).
- 방장 이전(정상 퇴장): 모두가 새 방장을 아는 데 0.12~0.24초 걸렸다. 퇴장자 아바타 제거도 같은 시점이다. 시계는 1.3~2.0초에 다시 맞았다(이후 오차 7~10ms). 이전 후 히트 주장은 새 방장에게 101/101, 15/15 갔다.
- 전송 상한: 모든 시나리오에서 1초 창 최대 턴이 11 이하(≤15)였다. 클라이언트당 프레임/초는 상태 Hz 수준을 유지했다(10Hz 8.8, 8Hz 7.4, 3.5~4Hz 3.6).
- 시계: 가짜 room에서 평균 6~8ms(p95 11~22ms) 오차였다. 단위 테스트에서 비대칭 지연과 15% 스파이크를 넣으면 평균 8ms였다.

**실제 Supabase**(이전 테스트 프로젝트, net Room 3개, 같은 PC, 예산 50 → mesh 5.5Hz, 원운동 5m/s, 25초, 정상 퇴장으로 방장 이전 포함):
보간 RMS 1.2cm(p95 2.0, 최대 2.4cm), 외삽 0%, 보간 지연 약 415ms(2.2 × 189ms), 화면 지연 450ms였다. 시계 오차는 평균 2.8ms(p95 8.5ms, 진짜 오프셋 0)였다. 히트 주장은 68/68, 이전 후 15/15였고 중복은 0이었다. 방장 이전은 0.13초, 턴은 5.6/s(= room.rate), 추정 이벤트/초는 49(예산 50)였고 콜백 오류는 0이었다.

---

## 11. 알려진 한계

1. **무료 플랜에서 8인은 3.5Hz다.** 6절 표대로 지연이 450ms까지 늘고, 직선이 아닌 움직임은 보간 오차가 커진다(8인 RMS 11cm, 최대 2m). 쏜 사람 화면 기준 판정이므로 지연이 길수록 '엄폐 뒤에서 맞는' 일이 늘어난다. 줄이는 방법은 방 인원 줄이기, Pro 플랜, 또는 `interp: { maxDelay }`로 지연과 외삽을 맞바꾸기(relay 4인 기준 180ms면 외삽 27%, 275ms면 3%)다.
2. 이벤트를 상태 프레임에 얹으므로 사격·히트 주장이 최대 한 간격(3.5Hz면 286ms) 늦게 나간다.
3. 사격 연출은 재전송하지 않는다(손실률만큼 궤적이 빠진다). 히트 주장은 2회 전송이라 둘 다 잃으면 무효다(손실 3%에서 약 0.1%).
4. 방장 이전 순간: 옛 방장에게 이미 보낸 히트 주장은 새 방장에게 다시 보내지 않는다(이중 피해 방지). 옛 방장 시계로 찍힌 수류탄 `t`, `endsAt`은 새 방장 기준으로 다시 공지해야 한다. 새 방장의 경기 모듈이 `lastMatch()`로 이어받는다.
5. 신뢰 없는 클라이언트다(anon key). 아무나 히트 주장·경기 메시지를 위조할 수 있고, 받는 쪽은 형식과 '현재 방장이 보낸 것인지'만 검사한다. 친구끼리 하는 캐주얼 게임을 전제로 한다.
6. `onRemoteState`의 state와 `getRemoteAtHost()` 결과는 버퍼 객체와 공유하거나 근사치다. 원격 시각을 방장 시각으로 바꿀 때 한쪽 최소 지연만큼 오차가 있다. 방장 검증에는 여유를 둬야 한다.
7. 탭이 백그라운드면 타이머가 1초로 느려져 상태가 끊긴다. 받는 쪽은 외삽 상한 뒤 정지하고, 3초 뒤 `stale`로 표시한다.
