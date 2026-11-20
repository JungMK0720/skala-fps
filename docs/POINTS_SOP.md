<!--
  Date: 06NOV2026
  Author: Minkyu Jung
  Purpose: 플레이어 포인트를 고치거나 되돌려 주는 절차(SOP). 2026-11-20 사고(새 무기를 사다 포인트만 사라짐, DB에서 바꾼 포인트가 화면에 안 보임)의 원인, 고친 방식(서버 값 우선·변화량 저장), 용어와 값 지도, schema.sql 다시 실행, 포인트 조정, 확인, 문제 해결.
-->
# 플레이어 포인트 고치기·되돌려 주기 (SOP)

## 1. 무엇이 있었나 (2026-11-20)

| 증상 | 원인 |
|---|---|
| 팀원이 새 무기를 샀는데 무기는 없어지고 4,000P만 사라졌다 | 팀원이 `js/weapons/defs.js`와 `supabase/schema.sql`에 새 무기를 넣어 main에 올렸고, GitHub Pages가 바로 배포했다. 하지만 **실서버 Supabase에서는 schema.sql을 다시 실행하지 않았다**. 실서버의 가격표는 새 무기 id를 몰라서, 저장 함수(`fps_save_profile`)가 그 무기는 버리면서 클라이언트가 보낸 "줄어든 포인트"는 받아들였다 |
| DB에서 포인트를 넣어 줬는데 그 팀원 화면에 안 보인다 | 게임은 서버 값을 **접속할 때 한 번만** 읽었고, 저장할 때는 포인트 **합계**를 보냈다. 서버는 "보낸 합계 − DB 값"을 변화량으로 보았으므로, 열린 탭의 다음 저장이 운영자가 넣어 준 4,000P를 "4,000 줄었다"로 읽어 지웠다 |
| 어떤 유저를 0P로 바꿨는데 화면엔 그대로다 | 같은 이유로 다음 저장 때 다시 올라갔다. 또 다시 켤 때 게임이 "로컬과 서버 중 큰 값"을 골라 브라우저에 남은 옛 값이 이겼다 |

### 고친 방식 (브랜치 `fix/shop-server-price-gate`)

- **서버 값이 늘 기준**: 게임은 이제 합계가 아니라 **변화량**(이번에 번 것 +, 산 것·쓴 것 −)만 보낸다(`p_delta`). 서버는 `DB 값 + 변화량`으로 계산하므로 운영자가 바꾼 값은 그대로 남고 그 위에 더해질 뿐이다. 다시 켤 때도 "큰 값"이 아니라 `서버 값 + 아직 못 올린 변화량`을 쓴다.
- **열린 탭도 따라온다**: 탭으로 돌아올 때(focus·화면 전환)와 탭이 보이는 동안 1분마다 서버 값을 다시 읽는다. 새로고침하지 않아도 운영자 수정이 화면에 온다.
- **옛 탭 대비**: 배포 전에 열려 있던 탭(옛 코드)은 여전히 합계를 보낸다. 그래서 저장 함수 밖에서 `points`가 바뀌면 바뀐 양을 `points_adjust`에 쌓아 두고, 옛 탭의 합계 저장이 그 양을 빼고 계산하게 했다. 옛 탭도 운영자 수정을 되돌리지 못한다.
- **조정 기록**: 저장 함수 밖에서 바뀐 포인트는 `fps_points_log`에 한 줄씩 남는다(누가·언제·얼마에서 얼마로).
- **상점 잠금**: 게임은 서버 가격표(`fps_features`의 `prices`)에 같은 값으로 있는 물건만 판다. 누가 새 무기를 넣고 SQL을 안 돌려도 버튼이 "구매 준비 중"으로 잠기고 포인트는 그대로다.

## 2. 용어와 값 지도

| 말 | 뜻 |
|---|---|
| 실서버 | 게임이 실제로 쓰는 Supabase 프로젝트. 주소는 `js/config.js`의 `supabase.url` |
| SQL Editor | Supabase 대시보드 왼쪽의 SQL Editor. 여기서 친 SQL은 소유자 권한으로 바로 실서버에 들어간다 |
| `fps_players` | 게임 회원 표. **같은 프로젝트의 퀴즈 표 `players`와 헷갈리지 말 것** — 거기를 고치면 게임에 아무 변화가 없다 |
| `points` | 회원의 포인트. 이제 이 값이 정답이다 |
| `points_adjust` | 옛 탭용 칸. 운영자가 바꾼 양 중 아직 저장이 한 번도 지나가지 않은 양. 다음 저장이 지나가면 0이 된다 |
| `fps_points_log` | 운영자 조정 기록 표. `before_points` → `after_points`, `actor`(바꾼 DB 계정), `created_at` |
| `p_delta` | 게임이 저장할 때 보내는 변화량. `fps_features`가 `delta: true`라고 답하는 서버에만 보낸다 |

## 3. 순서

> 순서가 중요하다. **SQL을 먼저 실행하고(3-2), 그 다음에 새 클라이언트를 배포하고(3-3), 그 다음에 포인트를 고친다(3-4).**
> 새 클라이언트만 먼저 나가도 망가지지는 않는다: 서버가 `delta`를 모르면 옛 방식으로 저장하고, 상점은 가격표가 올 때까지 잠근다.

### 3-1. (선택) 실서버가 어떤 무기를 몰랐는지 보기

SQL Editor에서:

```sql
select id, public.fps_item_price(id) as server_price
from unnest(array['sg_pump','sg_double','sg_auto','sm_uzi_dual','mg_minigun',
                  'sg_shorty','pn_air','sk_stake','th_axe','ml_case','ml_saw']) as id;
```

`server_price`가 비어 있는(null) 무기를 산 사람은 그 값만큼 포인트를 잃었다. 피해 규모를 가늠하는 데 쓴다.

### 3-2. schema.sql 다시 실행 (필수)

1. 저장소의 `supabase/schema.sql` 전체를 복사한다(이 브랜치가 main에 들어간 뒤의 것).
2. SQL Editor에 붙여 넣고 **Run**. 처음부터 끝까지 다시 실행해도 데이터는 지우지 않는다(인자가 바뀐 `fps_save_profile` 함수만 지우고 다시 만든다).
3. 확인:

```sql
select public.fps_features() ->> 'delta' as delta,
       public.fps_features() -> 'prices' ->> 'sg_shorty' as shorty,
       (select count(*) from information_schema.tables where table_name = 'fps_points_log') as has_log;
```

`delta`가 `true`, `shorty`가 `400`, `has_log`가 `1`이면 된 것이다.

### 3-3. 새 클라이언트 배포

이 브랜치를 PR로 main에 합치면 GitHub Pages가 1~2분 뒤 배포한다. 회원 쪽은 새로고침하면 새 코드를 받는다.

### 3-4. 포인트 고치기

먼저 그 회원의 지금 값을 본다(닉네임은 대소문자 무시):

```sql
select id, name, points, points_adjust, updated_at
from public.fps_players where name_key = lower('팀원닉네임');
```

넣어 주기(예: 4,000P):

```sql
update public.fps_players set points = points + 4000
where name_key = lower('팀원닉네임')
returning name, points, points_adjust;
```

0으로 만들기:

```sql
update public.fps_players set points = 0
where name_key = lower('유저닉네임')
returning name, points, points_adjust;
```

Table Editor에서 `points` 칸을 직접 고쳐도 똑같이 처리되고 기록된다. 기록 보기:

```sql
select p.name, l.before_points, l.after_points, l.actor, l.created_at
from public.fps_points_log l join public.fps_players p on p.id = l.player_id
order by l.created_at desc limit 20;
```

> 이미 앞에서 넣어 줬는데 되돌아간 경우: 위 첫 SQL로 지금 값을 다시 보고, 원래 주려던 값이 되게 다시 넣는다.

### 3-5. 회원 쪽에서 할 일

- 없다. 탭으로 돌아오거나 1분 안에 화면에 온다. 급하면 새로고침.

### 3-6. 확인

회원이 한 판 한 뒤:

```sql
select name, points, points_adjust from public.fps_players where name_key = lower('팀원닉네임');
```

`points`가 고친 값(+그 판에서 번 만큼)이고 `points_adjust`가 `0`이면 끝.

## 4. 문제 해결

| 보이는 것 | 왜 | 할 일 |
|---|---|---|
| `update`했는데 `points_adjust` 칸이 없다는 오류 | 3-2를 안 했다 | 3-2부터 |
| `update ... returning`이 0행 | 닉네임이 다르거나 `players`(퀴즈 표)를 보고 있다 | `select name from public.fps_players where name ilike '%일부%'`로 찾기 |
| 고친 값이 또 되돌아갔다 | 3-2 전에 고쳤다 | 3-2 확인(`delta`가 `true`인지) 뒤 3-4 다시 |
| 1분이 지나도 화면이 안 바뀐다 | 옛 코드 탭이다(배포 전에 연 탭) | 새로고침 |
| 상점 무기가 전부 "구매 준비 중" | 새 클라이언트가 배포됐는데 3-2를 아직 안 했다(실서버에 가격표가 없다). 포인트는 안전하다 | 3-2 |
| 특정 새 무기만 "구매 준비 중" | 누가 defs.js에 무기를 넣고 schema.sql 가격표에는 안 넣었거나, 넣었는데 실서버에서 안 돌렸다 | 가격표에 넣고 3-2 |

## 5. 앞으로 새 무기를 넣을 때 (팀원 안내)

1. `js/weapons/defs.js`에 무기와 `price`를 넣는다.
2. `supabase/schema.sql`의 `fps_price_table`에 같은 id와 값을 넣는다(`npm test`가 둘이 다르면 떨어진다).
3. **main에 올리기 전에** 소유자에게 알려 실서버에서 schema.sql을 다시 실행하게 한다. 안 해도 이제 포인트는 안 사라지지만, 그 무기는 실행 전까지 팔리지 않는다.
4. main에 바로 푸시하지 말고 PR로 올린다(main은 올리는 즉시 실서비스에 배포된다).
