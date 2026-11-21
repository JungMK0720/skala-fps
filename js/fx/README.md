# fx — 효과음·이펙트 (SKALA 작전)

외부 사운드·이미지 파일 없이 **WebAudio 합성**과 **three.js 도형·캔버스 텍스처**로 만든다. 모든 소리와 그림은 오리지널이다(이모트 음악 포함).
예외는 하나다. 연속 킬 안내 음성(`audio/voice`, 아래 "안내 음성")이다. 자산 출처는 `docs/ASSETS.md`에 적는다.
안내 음성은 녹음이 아니라 Windows 한국어 음성(TTS)으로 합성해 다듬은 파일이다.
잔혹한 표현은 쓰지 않는다. 플레이어 피격은 피 대신 갑옷 불꽃·히트마커로 표현한다.

| 파일 | 내용 |
|---|---|
| `audio.js` | `createAudio()`, `SOUND_NAMES`, `EMOTE_SOUNDS`, `EMOTE_BPM`, `EMOTE_LOOP_BEATS`, `VOICE_IDS` |
| `effects.js` | `createEffects(scene, camera, opts)` |
| `../../dev/fx-demo.html` | 버튼 데모. `?smoke=1`을 붙이면 자가 테스트를 돌린다 |

## 연결 예시 (core·weapons)

```js
import { createAudio } from './fx/audio.js';
import { createEffects } from './fx/effects.js';

const audio = createAudio({ volume: 0.8 });
const fx = createEffects(scene, camera, { renderer });          // renderer: 파티클 크기 계산용(권장)
addEventListener('pointerdown', () => audio.unlock(), { once: true });  // 첫 입력에서 언락

// 매 프레임: 엔진이 카메라를 갱신한 "뒤", 렌더 "전"
audio.setListener(camera.position, yaw, pitch);  // 눈 위치(core의 pos는 발바닥 → y + 1.6), 라디안, 'YXZ'
fx.update(dt);
// 1인칭 총구 섬광은 weapons/viewmodel.js의 내장 섬광(opts.muzzleFlash)과 fx.muzzleFlash 중 하나만 쓴다
// (원격 플레이어의 총구 섬광은 fx.muzzleFlash).

// 사격 1발. def = getDef(weaponId). 이름은 weapons/defs.js의 sound·fxKind를 그대로 쓴다
fx.muzzleFlash(muzzlePos, dir, def.fxKind);
fx.tracer(muzzlePos, hit ? hit.point : farPoint, def.fxKind);
if (hit) fx.impact(hit.point, hit.normal, hit.mat);   // mat = 맵 재질 이름 또는 'player'
fx.shellEject(muzzlePos, dir, { groundY: feetY, kind: def.fxKind });
audio.play(def.sound);                                // 내 총소리: pos 없음 → 2D
audio.play(def.sound, { pos: remoteMuzzle });         // 남의 총소리: 3D(HRTF)

// 칼: 휘두를 때 소리, 맞았을 때 소리와 불꽃
audio.play(heavy ? 'katana_heavy' : 'katana_swing');
audio.play('katana_hit', { pos: hit.point });
fx.slashSpark(hit.point, hit.normal);                 // normal: 맞은 면 또는 칼 반대 방향

// 발판·포털·비밀 스팟 (player:pad, player:portal, player:secret). pos는 발 위치
fx.padBurst(pos, pad.color);          audio.play('pad_boost');
fx.portalFlash(pos, portal.color);    audio.play('portal');
fx.secretSparkle(pos);                audio.play('secret_found');

// 반샷(damage 이벤트의 halfShot): 저격이 손·발에 맞아 죽지 않았다는 신호. hit_marker 대신 재생한다
audio.play('half_shot');

// 속도 줄기: 매 프레임 세기만 넘긴다. 걷기(PLAYER.WALK)까지 0, 상한(MOVE.MAX_SPEED)에서 1
fx.setSpeedAmount((player.state.speed - PLAYER.WALK) / (MOVE.MAX_SPEED - PLAYER.WALK));   // 0..1로 잘린다

// 착지: 버니합 착지만 아주 작게
audio.play('bhop_land');
// 메뉴
audio.play('ui_click');   audio.play('purchase');
```

## audio.js

`createAudio({ volume = 0.8, quality = 'high', maxVoices3d = 20, maxVoices2d = 8 })`가 돌려주는 메서드는 아래와 같다.

| 메서드 | 설명 |
|---|---|
| `unlock()` → `Promise<boolean>` | 첫 사용자 입력 핸들러 안에서 호출한다. 여기서 AudioContext를 만들고, 유휴 시간에 모든 소리를 미리 합성한다(프레임마다 변형 1개). 여러 번 불러도 안전하다 |
| `setVolume(v)` | 0~1. 리미터 뒤에 있으므로 올려도 클리핑이 나지 않는다 |
| `setListener(pos, yaw, pitch)` | `pos`는 `{x,y,z}`, `Vector3`, `[x,y,z]` 중 하나. three.js 카메라 관례(−Z가 정면)를 따른다 |
| `play(name, { pos, gain = 1, rate = 1 })` → `{ id, stop(fade) }` 또는 `null` | `pos`가 있으면 3D, 없으면 2D다. 언락 전, 알 수 없는 이름, 들리지 않는 거리, 우선순위에 밀린 경우에는 `null`을 돌려준다. 알 수 없는 이름(`constructor`처럼 내장 속성과 같은 이름 포함)과 `null` 옵션으로는 예외가 나지 않는다 |
| `voice(id, { delay = 0, gain = 1 })` → `boolean` | 연속 킬 안내 음성 한 문장(2D, `VOICE_IDS` 중 하나). 전용 보이스 하나로 내므로 앞 문장은 40 ms 페이드로 끊고 바로 잇는다. 언락 전·모르는 id·아직 디코드하지 않은 파일이면 `false`(그때 받기·디코드를 시작한다). `voicesReady()`는 디코드가 끝난 id 목록으로 resolve |
| `deafen(amount, sec)` → `boolean` · `undeafen()` | 섬광탄: 세기(0~1)만큼 모든 소리를 저역 통과로 막고(1이면 380 Hz) `sec`초에 걸쳐 돌아온다. 그동안 높은 귀울림(3.5 kHz 사인파 둘의 맥놀이)이 마스터 볼륨 앞에 따로 들어간다. `undeafen`은 바로 푼다(맵 나가기·라운드 정리) |
| `stopAll(fade)` · `setQuality('low'\|'high')` · `getStats()` · `dispose()` | low는 equalpower 패닝, 3D 보이스 12개, 잔향 절반이다 |

### 소리 목록

| name | 성격 | 우선순위 | 3D 기준거리/최대 |
|---|---|---|---|
| `rifle` | 짧은 크랙과 저음 펀치, 짧은 꼬리 | 6 | 8 m / 260 m |
| `sniper` | 날카로운 크랙, 묵직한 붐, 긴 메아리(지연 탭 5개) | 7 | 10 m / 420 m |
| `pistol` | 가볍고 스냅 있는 발사음 | 6 | 6 m / 190 m |
| `smg` | 높고 짧은 크랙과 얇은 몸통, 노리쇠 달각. 950 rpm에서 뭉개지지 않는 짧은 꼬리 | 6 | 6 m / 180 m |
| `shotgun` | 깊고 넓은 붐 뒤에 펌프 소리 2회(0.56초, 0.70초) | 7 | 9 m / 300 m |
| `magnum` | 묵직한 크랙, 낮은 쿵, 짧은 되울림 | 7 | 8 m / 300 m |
| `dmr` | 날카로운 중역 크랙, 저격보다 짧은 메아리 | 6 | 9 m / 320 m |
| `lmg` | 묵직한 저음 몸통, 짧은 크랙, 급탄 달각. 750 rpm에서 뭉개지지 않는 짧은 꼬리(좀비 전용 기관총 MG-100) | 6 | 9 m / 280 m |
| `knife_slash` / `knife_hit` | 공기 가르는 휙(대역 스윕) / 둔탁한 타격음 | 5 | 2.5~3 m / 30~40 m |
| `katana_swing` / `katana_heavy` | 공기 가르는 휙과 약한 금속 울림 / 더 길고 낮은 몸통이 있는 강타 | 5 | 2.5~3 m / 34~42 m |
| `katana_hit` | 밝은 강철 울림과 짧은 타격 | 6 | 3.5 m / 60 m |
| `grenade_pin` / `grenade_bounce` | 금속 핀 링 / 금속 굴러가는 소리 | 5 | 2~3 m / 25~55 m |
| `explosion` | 저음 붐, 파편 후드득, 잔향 | 8 | 12 m / 420 m |
| `smoke_burst` | 뚜껑 퐁 + 3초 동안 뿜어 나오는 쉬익(연막탄) | 6 | 4 m / 70 m |
| `flash_bang` | 날카로운 쾅 + 짧은 금속 울림(섬광탄, 폭발보다 높고 짧다) | 8 | 10 m / 320 m |
| `reload_mag_out` / `reload_mag_in` / `bolt` / `dry_fire` / `switch` | 기계음 | 4 | 1.5~2 m / 15~25 m |
| `footstep_concrete` / `footstep_steel` | 사각거리는 발소리 / 강판의 쿵 | 3 | 2~2.5 m / 32~45 m |
| `bhop_land` | 아주 작고 낮은 쿵(버니합 착지) | 3 | 1.5 m / 14 m |
| `pad_boost` | 튕기는 쿵과 위로 올라가는 휙 | 5 | 4 m / 60 m |
| `portal` | 떨리며 올라가는 음 4겹, 대역 스윕, 흩어지는 반짝임 | 5 | 5 m / 70 m |
| `hit_marker` / `headshot` / `kill` | 피드백 (항상 2D) | 8 / 9 / 9 | — |
| `half_shot` | 짧게 두 번 내려가는 음. 올라가는 `kill`과 반대라 킬이 아니라는 것을 바로 알 수 있다 (항상 2D) | 9 | — |
| `secret_found` | 완전5도로 쌓아 올리는 오리지널 아르페지오(G5 D6 A6 E7)와 열린 화음 (항상 2D) | 9 | — |
| `purchase` | 금속 조각이 두 번 부딪히는 소리와 짧은 확인음 (항상 2D) | 8 | — |
| `ui_click` | 작고 부드러운 틱 (항상 2D) | 4 | — |
| `round_start` | 낮은 혼(맥놀이) | 10 | — |
| `round_win` / `round_lose` / `low_hp_heartbeat` | 상승 아르페지오 / 하강 모티프 / 심장 박동 1회 | 10 / 10 / 7 | — |
| `multi_kill` | 연속 킬: 낮은 쿵, 쓸리는 바람, 한 옥타브 위로 쓸어 올리는 음, 반짝임. 단계마다 World가 `rate`를 0.06씩 올린다 (항상 2D) | 10 | — |
| `legend_kill` | 7킬부터: 깊은 쿵 위에 C장조 화음을 차례로 쌓고 긴 반짝임 (항상 2D) | 10 | — |

- `low_hp_heartbeat`는 한 번만 뛴다. 체력이 낮을 때 호출하는 쪽이 0.9초쯤마다 다시 재생한다. 발소리 간격과 재질 선택도 호출하는 쪽이 정한다.
- 같은 소리는 변형 2~4개 중 무작위로 고르고, 재생 속도에 ±2~8% 지터를 준다. 연사해도 기계적으로 들리지 않게 하기 위해서다.
- 소리를 추가하면 `SOUND_NAMES`와 미리 합성 목록에 자동으로 들어간다. `getStats()`의 `variants`/`variantsTotal`로 진행 상황을 볼 수 있다.

### 오디오 그래프와 정책

```
[보이스: Gain → LowPass → Panner(HRTF, inverse 거리 감쇠)] ─┬→ mix → Compressor → makeup → Limiter(-3 dB) → SoftClip(<0.99) → Volume → out
                                                         └→ send → Convolver(합성 잔향 IR) → mix
```

- **보이스 풀**: 3D 20개와 2D 8개의 노드 체인(Gain·Filter·Panner·Send)을 처음에 만들어 재사용한다. 합성한 AudioBuffer는 캐시한다. `AudioBufferSourceNode`는 스펙상 일회용이라 매번 새로 만든다(가벼운 객체다).
- **상한과 우선순위**: 소리마다 동시 재생 상한(`max`)을 둔다. 넘치면 같은 소리 중 가장 오래된 것을 교체한다. 풀이 차면 `우선순위 − 거리/40` 점수가 가장 낮은 보이스를 10 ms 페이드로 빼앗는다. 새 소리의 점수가 더 낮으면 재생하지 않는다.
- **거리**: PannerNode inverse 모델로 감쇠한다. 총성과 폭발은 거리가 24 m 늘 때마다 차단 주파수를 절반으로 낮춰 먹먹하게 한다(최저 500 Hz). 잔향 비율은 멀수록 커진다.

### 이모트 소리 (MODES.md 4절)

이모트 음악은 모두 직접 쓴 음표 표로 만드는 **오리지널** 합성 루프다(기존 곡의 멜로디·리듬을 가져오지 않았고, 외부 음원 파일은 없다).
춤에서 크게 움직이는 박(주먹 찌르기, 발 구르기, 깃발 꽂기 등)에 소리를 맞춰 썼다.

```js
// 내 이모트(2D): 이모트를 시작할 때
myEmote = audio.emote('tango');            // 또는 번호 audio.emote(5) — 제자리 행진
// 취소·종료할 때
myEmote.stop();                            // 기본 150 ms 페이드

// 원격 플레이어(3D, 작게): 이모트 번호가 바뀔 때마다
actor.emoteSnd?.stop();
actor.emoteSnd = code ? audio.emote(code, { pos: actorPos }) : null;
// 매 프레임(보간된 위치)
actor.emoteSnd?.setPos(actorPos);
```

`audio.emote(idOrCode, { pos, loop, gain = 1 })` → `{ id, name, playing, stop(fadeMs = 150), setPos(pos) }`

- `idOrCode`에는 `EMOTE_SOUNDS`의 id나 전송 번호(1~11)를 넣는다. 0, 모르는 id, 언락 전, `dispose()` 후에는 아무것도 하지 않는 핸들을 돌려준다(`playing === false`). 그래서 null 체크가 필요 없다.
- `pos`가 있으면 3D(원격 플레이어, 0.75배)이고 없으면 2D(나)다. 2D 핸들은 `setPos`를 무시한다.
- `loop`: 반복형은 기본값이 `true`다. `false`를 주면 루프를 한 번만 재생한다. 한 번형(`salute`, `wave`)은 끝나면 `playing`이 false가 되고 저절로 정리된다.
- 음량은 효과음보다 작다(루프 0.26~0.4배). 마스터 볼륨(`setVolume`, 설정의 효과음 볼륨)을 그대로 따른다. `stopAll()`은 이모트도 끈다.

템포는 `core/consts.js`의 `EMOTES[].bpm`을 그대로 가져온다. `engine/emoteanim.js`가 같은 템포로 춤을 추므로 박자가 맞는다. 루프 길이(`EMOTE_LOOP_BEATS`)는 춤 한 주기의 정수 배라서 루프가 돌 때마다 춤과 다시 맞는다. 데모 스모크 테스트와 `tests/emotes.test.mjs`가 이 일치를 검사한다.

| # | id | 이름 | 소리 | 루프 · 템포 · 조 |
|---|---|---|---|---|
| 1 | `takeL` | 작전 성공 | 행진풍 금관 팡파르: 주먹 찌르기에 짧은 금관, 가슴 치기에 북, 힘주기에 긴 화음 | 4마디 · 120 BPM · B♭장조 |
| 2 | `veggie` | 무전 확인 | 무전 잡음 '치익'과 신호음 '삐', 낮은 베이스 그루브, 가리키기·엄지에 마림바 | 4마디 · 100 BPM · D단조 |
| 3 | `sideToSide` | 경계 이동 | 낮게 깔린 펑키 베이스: 싱코페이션 베이스, 7화음 스탭, 16비트 하이햇 | 4마디 · 116 BPM · E 도리안 |
| 4 | `crissCross` | 몸풀기 | 늘이기 마디는 부푸는 화음·마림바, 털기 마디는 통통 튀는 베이스·흔들개 | 4마디 · 96 BPM · G장조 |
| 5 | `tango` | 제자리 행진 | 군악대 행진: 매 박 큰북, 무릎 드는 박에 작은북, 3박에 발 모으는 '쿵'과 심벌, 금관 선율·튜바 | 4마디 · 112 BPM · B♭장조 |
| 6 | `salute` | 경례 | 짧은 혼(1.6초, 한 번) | — |
| 7 | `wave` | 손 흔들기 | 작은 '뿅'(0.3초, 한 번) | — |
| 8 | `cheer` | 환호 박수 | 여럿이 치는 박수(타이밍·음색을 흩뿌림), "와아" 함성, 휘파람 | 4마디 · 128 BPM |
| 9 | `creamCheese` | 수신호 | 긴장감 있는 저음 반복: 정지에 화음 찌르기, 집결에 올라가는 바람, 전진에 가르는 소리, 엎드려에 낮은 쿵 | 4마디 · 104 BPM · E단조 |
| 10 | `fromYou` | 쌍안경 정찰 | 잔잔한 패드와 소나 '핑', 멈칫에 불협 긴장음, 엄지에 밝은 분산화음 | 2마디 · 84 BPM · A단조 |
| 11 | `selfie` | 깃발 흔들기 | 웅장한 금관 화음, 흔들 때마다 바람 소리와 큰 북, 꽂는 순간 낮은 '쿵'과 긴 화음 | 2마디 · 92 BPM · D장조 |

- **루프:** 반복형은 루프 하나(5~10초)를 32 kHz 모노로 한 번 렌더해 캐시한다. 루프 끝을 넘친 잔향 꼬리는 앞으로 접어 붙였으므로 이음매 없이 반복된다. 루프 하나를 렌더하는 데 약 30~50 ms 걸리며(CPU 부하가 크면 100~200 ms), `unlock()` 뒤 효과음 다음 순서로 유휴 시간에 미리 합성한다.
- **동시 재생:** 효과음과 분리한 전용 보이스 풀을 쓴다. 3D는 6개(low 품질 3개)로 가벼운 equalpower 패닝을 쓰고, 2D는 2개다. 이모트 한 명당 루프 BufferSource 1개만 쓰므로 많은 사람이 동시에 해도 가볍다.
- **배정:** `setListener()` 안에서 0.2초마다 다시 배정한다. 45 m 안에서 가장 가까운 이모트에만 소리를 내고, 멀어지거나 밀려난 핸들은 살려 둔 채 보이스만 반납한다.
- **박자 유지:** 다시 보이스를 받으면 원래 박자 위치에서 페이드 인으로 이어 재생한다. 2D는 최신 2개를 우선한다. 예를 들어 루프 중에 `wave`를 하면 끝난 뒤 루프가 이어진다.

### 안내 음성 (연속 킬)

`audio/voice/<id>.mp3` 여섯 개(`double` `triple` `quadra` `penta` `hexa` `legend`, 합계 약 45 KB)다. 녹음이 아니라 **합성 음성**이다.
`tools/make-voice.mjs`가 Windows에 들어 있는 한국어 음성(Microsoft Heami)으로 문장을 읽게 하고, ffmpeg로 다듬는다.

- **문장:** 더블 킬! · 트리플 킬! · 쿼드 킬! · 5연속 처치! · 6연속 처치! · 당신은 전설입니다. 화면 글자(`game/multikill.js`)와 같은 말이다(`tests/multikill.test.mjs`).
- **다듬기:** 단계가 오를수록 조금 빠르고(SSML rate) 높게(rubberband, 포먼트 유지, +0~2반음), 전설은 느리고 낮게(−2반음) 말한다. 저역을 덜고 또렷한 대역을 올린 뒤 압축하고, 체감 크기를 −16 LUFS에 맞춘다(단계마다 조금씩 크게). 피크는 리미터로 −1 dBFS 아래다. 64 kbps 모노 mp3.
- **다시 만들기(Windows):** `node tools/make-voice.mjs`(ffmpeg가 PATH에 없으면 `FFMPEG=<경로>`). 같은 음성·같은 ffmpeg면 같은 파일이 나온다. 이 음성은 SSML pitch를 무시해서 음 높이는 ffmpeg에서 바꾼다.
- **재생:** 페이지를 연 뒤 잠시 뒤나 언락 때 받아 두고 컨텍스트가 생기면 디코드한다(`createAudio({ voicePrefetch: false })`면 언락 때 받는다). `voice(id)`는 전용 2D 보이스 하나로 내고 공용 잔향을 조금 섞는다. 못 받은 문장은 소리 없이 건너뛰고 효과음(`multi_kill`·`legend_kill`)은 그대로 난다. `getStats()`의 `voiceFiles`·`voiceLast`·`voicePlays`로 확인한다.
- **권리:** Windows 내장 음성으로 만든 소리를 상업적으로 재배포해도 되는지는 확인하지 않았다(`docs/ASSETS.md`). 판매 전에 직접 녹음하거나 상업 이용이 명시된 음성으로 같은 도구를 돌려 바꾼다.

## effects.js

`createEffects(scene, camera, { renderer, applyShake = true })`

| 메서드 | 설명 |
|---|---|
| `muzzleFlash(pos, dir, kind)` | 십자 화염 꽃잎, 코어 스프라이트, 옅은 연기, 짧은 라이트. `kind`는 `'rifle'`, `'sniper'`(머즐 브레이크 측면 화염), `'pistol'`이다. `'sr_bolt'`, `'pt_std'` 같은 무기 id도 인식하고, 모르는 값(`null`, 오타 등)은 소총으로 처리한다 |
| `tracer(from, to, kind)` | 빛줄기가 날아간다(소총 480 m/s, 저격 900 m/s, 권총 360 m/s). 저격은 옅은 공기 궤적이 0.45초 남는다. `kind`는 `muzzleFlash`와 같다 |
| `impact(point, normal, mat)` | 재질별 이펙트(아래 표). 물을 뺀 재질에는 탄흔을 남긴다(링 버퍼) |
| `explosion(pos, { radius = 6 })` | 섬광 스프라이트, 화염, 연기, 지면 먼지, 불씨 줄기, 충격파 링, 포인트 라이트 0.4초, 카메라 흔들림(거리 비례) |
| `shellEject(pos, dir, { groundY, kind })` | 탄피가 오른쪽으로 튀어 바닥에서 튕긴다. `groundY`를 주지 않으면 `pos.y − 1.45`를 쓴다. `kind`에 따라 크기가 달라진다(소총 1, 저격 1.45, 권총 0.72배) |
| `padBurst(pos, color)` | 점프 발판: 위로 뿜는 불꽃 줄기, 입자, 퍼지는 링. `pos`는 발 위치, `color`는 `'#35e0ff'`, `0x35e0ff`, `THREE.Color` 중 하나(없거나 잘못되면 시안) |
| `portalFlash(pos, color)` | 포털: 큰 섬광, 카메라를 보는 링, 몸 둘레를 도는 소용돌이. `pos`는 발 위치, `color` 기본값은 보라. 출발·도착 양쪽에서 한 번씩 불러도 된다 |
| `secretSparkle(pos)` | 비밀 스팟: 금빛 입자가 나선으로 피어오르고 큰 반짝임이 늦게 핀다. `pos`는 발 위치 |
| `slashSpark(pos, normal)` | 칼날이 맞았을 때 강철 불꽃. `normal`은 맞은 면 또는 칼 반대 방향(없으면 위). 탄흔은 남기지 않는다 |
| `setSpeedAmount(0..1)` | 속도 줄기 세기. 매 프레임 불러도 된다. 0이면 그리지 않는다. 범위를 벗어난 값은 잘리고 `NaN`은 0이다. 켜질 때 약 0.8초, 꺼질 때 약 0.6초에 걸쳐 변한다. 별도 갱신 함수 없이 `update(dt)`가 처리한다 |
| `update(dt)` | 매 프레임 호출한다(dt는 0.1초로 제한) |
| `clear(keepDecals)` | 라운드를 리셋할 때 진행 중인 이펙트를 즉시 끈다. 속도 줄기 세기도 0이 된다 |
| `setQuality('low'\|'high')` · `setReducedMotion(true\|false\|null)` | `null`이면 OS 설정을 따른다 |
| `addShake(0..1)` · `getShake()` · `setApplyShake(bool)` | 흔들림 제어(아래 참고) |
| `getStats()` · `dispose()` | 통계 조회 / 씬에서 제거하고 지오메트리·머티리얼·텍스처를 모두 해제 |

| `mat` | 이펙트 |
|---|---|
| `steel` `rust` `deck` `tank` `pipe` `container_red` `yellow` `white` `metal_dark` | 불꽃 줄기, 섬광 점, 옅은 연기, 어두운 탄흔 |
| `concrete` `asphalt` `grass` `wood` `stone` `brick` `plaster` `tile` `sand` `moss` `wood_dark` `bamboo` `paper` (모르는 재질은 concrete로 처리) | 재질 색 먼지, 파편 조각, 탄흔 |
| `water` | 물방울, 물안개, 물결 링 |
| `glass` `neon_cyan` `neon_pink` | 반짝임, 유리 조각, 탄흔(유리는 밝게, 네온은 어둡게) |
| `player` | 흰빛 퍼프와 짧은 불꽃(피 없음), 탄흔 없음 |

### 성능 (풀 상한)

| 항목 | high | low |
|---|---|---|
| 포인트 파티클(연기류·가산류 각각) | 1600 | 500 |
| 불꽃 줄기(LineSegments) | 320 | 96 |
| 탄흔(InstancedMesh, 링 버퍼) | 96 | 32 |
| 탄피(InstancedMesh) | 24 | 8 |
| 총구 섬광 · 예광탄 · 링 · 폭발 섬광 | 8 · 28 · 8 · 3 | 같음 |
| 속도 줄기(LineSegments) | 44 | 16 |
| 발판·포털·비밀·칼날 입자 수 | 기준값 | 0.45배, 발판·포털의 두 번째 링 없음 |
| 포인트 라이트 | 2 (low는 총구 라이트 없음) | 2 |

- 파티클은 packed typed array에 담고 swap-remove로 지운다. 활성 개수만큼만 GPU에 올린다(`updateRanges`). 파티클 시스템 하나가 draw call 1개다. 상한에 닿으면 새 파티클은 생략하고 `getStats().dropped`에 센다.
- `padBurst`, `portalFlash`, `secretSparkle`, `slashSpark`, 속도 줄기는 실제 라이트를 쓰지 않는다. 입자와 줄기, 링은 기존 풀을 함께 쓴다.
- 속도 줄기는 카메라 공간의 작은 고정 버퍼다. 세기가 0이면 draw call도 없다. 불꽃 줄기와 셰이더를 함께 쓰므로 처음 켜질 때 컴파일 끊김이 없다. 화면 가운데는 비우고 바깥으로 갈수록 밝아진다.
- 그림자를 쓰지 않는다. 라이트 2개는 항상 씬에 두고 세기만 0으로 내린다. 라이트 개수가 바뀌면 셰이더를 재컴파일하기 때문이다. 폭발 라이트(우선순위 2)는 총구 라이트(1)에 빼앗기지 않는다.
- 생성 이후 프레임마다 객체·배열을 만들지 않는다. 임시 벡터와 프리셋, 업로드 범위 객체를 재사용한다. `update()`를 힙 사용량으로 재면 프레임당 약 10~25바이트로, 엔진의 숫자 값 정도만 늘어난다.

### 흔들림과 감소된 동작

- `prefers-reduced-motion: reduce`이면 섬광 불투명도를 0.4배로, 라이트 세기를 0.4배로 줄이고 총구 라이트는 끈다. 폭발 섬광 크기는 0.7배, 흔들림은 0.2배다. 발판·포털·칼날의 섬광과 포털 링도 0.4배이고, 속도 줄기는 나오지 않는다. OS 설정 변경을 실시간으로 반영한다.
- 기본값(`applyShake: true`)에서는 `update()`가 `camera.rotation`에 작은 오프셋을 더한다. 다음 프레임에는 엔진이 덮어쓰지 않은 축만 그 오프셋을 되돌리므로 조준이 누적해서 틀어지지 않는다. 엔진이 회전을 직접 합성하고 싶으면 `setApplyShake(false)`로 끄고 `getShake()`가 돌려주는 `{pitch, yaw, roll}`을 더하면 된다.

## tactical-fx.js

`createTacticalFx({ scene, container })` — 연막탄·섬광탄 연출(판정은 `weapons/tactical.js`).

- `frame(dt, clouds, fog)`: `clouds = smoke.list(t)`마다 부드러운 연기 스프라이트 30장(구름마다 재질 30개, 텍스처 한 장 공유)을 반구처럼 놓고 반경에 맞춰 키운다. 끝 2.5초에 옅어진다. `fog`(카메라가 연기 속에 있는 정도)만큼 `.sk-smokefog` 회색 덮개를 캔버스 위·HUD 아래에 깐다.
- `flashBurst(pos)`: 섬광 자리의 더하기 혼합 번쩍임(0.32초). 빛(PointLight)은 더하지 않는다(셰이더 다시 만들기 방지).
- `blind(k)`: `.sk-flashout` 하얀 덮개를 `flashWhiteout(k, 경과)`대로(처음 45% 버팀, 세기 × 3초). `blindAmount()` · `fogAmount()`는 지금 불투명도(QA).
- `clear()` · `dispose()`.

## 검증

- `node --check js/fx/audio.js`와 `node --check js/fx/effects.js`가 통과한다.
- `dev/fx-demo.html?smoke=1`은 Chromium에서 65개 항목을 검사하고 모두 통과한다. 결과는 탭 제목(`SMOKE PASS`)과 `window.__fxSmoke`에 나온다.
  - 안내 음성: 6개 파일을 모두 디코드하는지, 아는 id만 내는지 본다. 데모의 "연속 킬 안내 음성" 버튼으로 효과음과 함께 들어 볼 수 있다.
  - 재질: `core/consts.js`의 `MATS` 전부가 오류 없이 처리되는지, `metal_dark`만 불꽃이 튀고 나머지 새 재질은 입자와 탄흔만 남는지 본다.
  - 새 이펙트: 라이트를 쓰지 않는지, 풀로 돌아오는지, low에서 입자·줄기·링이 줄어드는지, 잘못된 입력을 견디는지 본다.
  - `fxKind`: 세 종류와 모르는 값(`'plasma'`, `null`, 숫자, 객체)으로 섬광·예광탄·탄피가 모두 나오는지 본다.
  - 속도 줄기: 세기와 품질에 따른 개수, 동작 줄이기와 `clear()`, 값 자르기, `NaN`, 셰이더 공유, GPU 자원 증가 없음을 본다.
  - 이모트: 2D·3D·번호 지정, 아무것도 안 하는 핸들, 가까운 6개 상한, 거리 컬링 후 재배정, 2D 최신 우선, 한 번형 자동 정리, 정지·`stopAll` 후 소스 0, 모든 이모트 합성 완료, core `EMOTES`와 번호·템포 일치, 콘솔이 조용한지를 본다.
  - 이펙트: 3회 스폰한 뒤 활성 이펙트가 0으로 돌아오는지(과부하 포함), GPU 리소스가 늘지 않는지, 씬 자식 수가 유지되는지, 상한을 지키는지, low 품질과 감소된 동작에서도 같은지, 흔들림 후 카메라 회전이 원래대로 돌아오는지, `gl.getError()`가 0인지 본다.
  - 오디오: 보이스 상한, 범위 밖 소리 생략, 모르는 이름에서 예외 없음, 모든 소리에 버튼이 있는지, 4.2초 뒤 보이스 전부 반환, 소리 38종·변형 67개 미리 합성 완료, 그 뒤 첫 재생에 합성 지연이 없는지를 본다.
  - 해제: `dispose()`를 확인한다.

## 알려진 한계

- 포인트 파티클은 `gl_PointSize`를 쓰므로 화면 크기가 480 px로 제한된다. 카메라에 아주 가까운 연기는 실제보다 작게 보인다.
- 불꽃 줄기는 WebGL 선이라 1 px 두께다. 고해상도 화면에서는 가늘게 보인다.
- 파티클은 충돌을 모른다. 불꽃과 물방울은 벽과 바닥을 통과해 떨어지다 수명이 끝나면 사라진다. 탄피만 `groundY` 평면에서 튕긴다.
- 차폐(벽 뒤 소리)는 처리하지 않는다. 거리 감쇠와 저역 통과만 한다. 도플러 효과도 없다.
- 이모트 루프는 32 kHz로 렌더했다. 고음역(약 14 kHz 이상)은 없지만 배경 비트라 티가 나지 않는다. 여러 사람이 같은 이모트를 해도 박자를 맞추지는 않는다. 사람마다 시작 시각을 기준으로 재생한다.
- 이모트 한 종을 처음 쓰기 전에 미리 합성이 끝나지 않았다면 그 자리에서 렌더한다(한 번, 약 30~50 ms. 부하가 크면 더 걸린다).
- 탄흔은 표면 법선 방향으로 붙인 사각형이라 모서리에 맞으면 허공으로 삐져나올 수 있다. 움직이는 물체에는 붙이지 않는다(`player`).
- 첫 `unlock()` 직후 약 1.5초 동안 미리 합성이 진행된다(변형 65개를 16 ms 간격으로 하나씩, 전체 합성 시간은 약 300 ms). 그 사이 처음 재생하는 소리는 그 자리에서 합성된다(폭발 1회 약 30~60 ms, 새 총성은 10 ms 이내). 메뉴 화면에서 언락하면 게임 중에는 끊김이 없다.
- 속도 줄기는 항상 시선 정면에서 흘러온다. 실제 이동 방향(옆으로 스트레이프할 때 등)은 반영하지 않는다.
- 합성 소리는 스펙트로그램과 음량·어택·소리 사이 거리 수치로 확인했다. 최종 음색과 음량은 데모 페이지에서 직접 들으며 다듬어야 한다.
