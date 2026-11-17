<!--
  Date: 06NOV2026
  Author: Minkyu Jung
  Purpose: 건의 받은편지함(dev/inbox.html)을 처음 켜는 절차(SOP). 용어와 값 지도, 소유자 계정 만들기, 새 가입 끄기, schema.sql 실행, 관리자 등록, 첫 로그인 시험, 선택 2단계 인증, 일상 사용과 끄기, 문제 해결.
-->
# 건의 받은편지함 켜기 (SOP)

소유자가 SQL이나 Table Editor 없이 **웹 화면에서 플레이어 건의를 읽고 답과 상태를 저장**하게 하는 기능을 처음 켜는 절차다. 설계와 "왜 안전한가"는 [FEEDBACK.md](FEEDBACK.md) 6절에 있고, 이 문서는 "무엇을 어디서 누르고 어떤 SQL을 붙이는가"만 순서대로 적는다.

| 항목 | 내용 |
|---|---|
| 지금 상태 | 코드는 있다(화면 `dev/inbox.html`, 서버 쪽은 `supabase/schema.sql`의 "건의함 받은편지함" 절). 아래 4~5절을 하기 전에는 아무도 로그인해서 글을 볼 수 없고, 건의함은 지금처럼 대시보드로 읽고 답한다([FEEDBACK.md](FEEDBACK.md) 2절) |
| 목표 | `https://jungmk0720.github.io/skala-fps/dev/inbox.html`에서 로그인 → 건의 목록 → 답 저장·상태 바꾸기 |
| 소유자만 할 수 있는 일 | Supabase 대시보드 로그인, 계정 만들기, SQL 실행, 비밀번호 정하기 |
| 걸리는 시간 | 처음 한 번 20~30분(선택인 2단계 인증까지 하면 10분 더) |
| 비용 | 0원. 지금 쓰는 Supabase 프로젝트 그대로고 Auth 사용자는 소유자 한 명이다 |
| 되돌리기 | 관리자 표에서 계정 줄을 지우면 바로 닫힌다(8절). 게임과 플레이어 쪽은 바뀌지 않는다 |

- 이 절차에는 **터미널 명령이 없다.** 브라우저의 Supabase 대시보드와 SQL Editor만 쓴다.
- 화면 이름은 Supabase가 바꿀 수 있다. 이름이 조금 달라도 같은 뜻의 메뉴·단추를 찾는다.
- **비밀번호와 키는 채팅·이슈·커밋·스크린샷에 붙이지 않는다.** 오류가 나면 비밀번호는 가리고 메시지만 옮긴다.
- 아래 SQL의 `me@example.com`은 자리표시자다. 2절에서 만든 **내 이메일(소문자)** 로 바꿔서 실행한다.

## 0. 먼저 알아 둘 말

| 말 | 뜻 |
|---|---|
| Supabase Auth | Supabase가 주는 로그인 기능이다. 이메일·비밀번호로 사용자를 만들고, 로그인하면 "토큰"을 준다. 게임의 플레이어는 이것을 쓰지 않고(기기 토큰을 쓴다) 소유자만 쓴다 |
| 사용자(user)와 uid | Auth에 만든 계정 하나가 사용자다. uid는 계정마다 붙는 긴 번호(UUID)다. 이 절차에서는 uid를 손으로 옮기지 않고 **이메일로 찾아서** 넣는다 |
| 토큰(JWT) | 로그인하면 받는 "이 사람이 로그인했다"는 증명서다. 한 시간쯤 쓸 수 있고 화면이 알아서 갈아 끼운다. 이 화면은 토큰을 **그 브라우저 탭에만** 두어서 탭을 닫으면 사라진다 |
| RLS(행 수준 보안) | 표에서 "어느 행을 누가 볼 수 있는지"를 DB가 직접 정하는 규칙이다. 규칙이 막으면 요청이 맞아도 0행이 나온다 |
| 정책(policy) | RLS의 규칙 하나다. 여기서는 "관리자 표에 있는 사람만 건의 표를 읽고 고친다" |
| `anon` / `authenticated` | Supabase가 요청을 두 신분으로 나눈다. `anon`은 로그인하지 않은 쪽(게임의 플레이어), `authenticated`는 Auth로 로그인한 쪽이다. 이번에 `anon`에게 새로 주는 권한은 없다 |
| 열 단위 권한 | 표 전체가 아니라 열마다 읽기·수정을 허락하는 것이다. 여기서는 읽기는 건의의 열 10개, 수정은 `reply`(답)와 `status`(상태) 두 칸뿐이다 |
| 관리자 표(`fps_admins`) | 받은편지함을 열 수 있는 계정의 uid를 적어 두는 표다. 소유자가 SQL Editor에서 한 줄 넣는다. 브라우저(API)로는 읽을 수도 쓸 수도 없다 |
| SQL Editor | 대시보드에서 SQL을 붙여 실행하는 창이다. 대시보드에 로그인한 소유자는 모든 권한으로 실행된다 |
| 2단계 인증(MFA, TOTP) | 비밀번호 말고 인증 앱(구글 OTP, Microsoft Authenticator 등)이 보여 주는 6자리 코드를 한 번 더 넣는 것이다. 코드까지 넣어 로그인한 토큰을 `aal2`라고 부른다 |
| Publishable key | 게임과 이 화면이 서버에 "이 프로젝트에 요청한다"고 알리는 공개 키다. `js/config.js`에 이미 있고 비밀이 아니다 |
| Auto Confirm User | 계정을 만들 때 "이메일 확인 메일을 거치지 않고 바로 쓰게" 하는 체크 칸이다 |

### 값 지도

| 값 | 어디서 얻나 | 어디에 넣나 |
|---|---|---|
| 소유자 이메일 | 내가 정한다. 비밀번호를 잊었을 때 받을 수 있는 주소가 좋다 | 2절 계정 만들기, 5절·7절 SQL의 `email = '…'`, 6절 로그인 |
| 소유자 비밀번호 | 내가 정한다. 비밀번호 관리자로 만든 20글자 이상 | 2절 계정 만들기, 6절 로그인(화면에서만 입력) |
| 프로젝트 ref | 이미 있다: `tvsoacvbjvggqdgnzijc`(`js/config.js`의 `supabase.url` 앞부분이고 공개 값) | 이 문서의 대시보드 주소 |
| 화면 주소 | `https://jungmk0720.github.io/skala-fps/dev/inbox.html` | 브라우저 즐겨찾기 |

## 체크리스트

- [ ] 1. 준비: 대시보드, 화면이 열리는지, 같은 프로젝트의 다른 앱 확인
- [ ] 2. 소유자 계정 만들기
- [ ] 3. 새 가입 끄기
- [ ] 4. `schema.sql` 실행
- [ ] 5. 관리자 등록
- [ ] 6. 첫 로그인 시험
- [ ] 7. (선택) 2단계 인증
- [ ] 8. 끝낸 뒤: 일상 사용, 바꾸기, 끄기

## 1. 준비

1. 대시보드를 연다: <https://supabase.com/dashboard/project/tvsoacvbjvggqdgnzijc>. 게임 프로젝트(`skala-fps`)인지 이름을 본다.
2. 화면이 배포돼 있는지 본다: <https://jungmk0720.github.io/skala-fps/dev/inbox.html>을 열어 **로그인** 칸이 보이면 된다(아직 로그인은 안 된다). 안 열리면 이 코드가 `main`에 아직 합쳐지지 않은 것이다. 합친 뒤에 한다. Pages 반영은 1~2분이고 캐시는 최대 10분이라 `Ctrl+F5`로 새로 받는다.
3. **같은 프로젝트를 쓰는 다른 앱(퀴즈)이 Auth 가입을 받는지 본다.** 대시보드 [Authentication → Users](https://supabase.com/dashboard/project/tvsoacvbjvggqdgnzijc/auth/users)를 연다.
   - 사용자가 하나도 없거나 아는 계정뿐이면 그대로 진행한다.
   - 모르는 이메일이 있으면 다른 앱이 Auth로 가입을 받고 있을 수 있다. **3절(새 가입 끄기)은 건너뛴다.** 이 기능은 가입을 끄지 않아도 안전하다(3절 설명).

확인: 대시보드가 열리고, 로그인 화면이 보이고, Users 목록을 봤다.

## 2. 소유자 계정 만들기

1. 대시보드 왼쪽 **Authentication → [Users](https://supabase.com/dashboard/project/tvsoacvbjvggqdgnzijc/auth/users)**를 연다. 오른쪽 위 **Add user**를 누르고 **Create new user**를 고른다(**Send invitation**이 아니다. 초대는 비밀번호를 정하지 않고 메일을 보낸다).
2. 채운다.

   | 칸 | 값 |
   |---|---|
   | Email | 소유자 이메일(소문자) |
   | Password | 20글자 이상. 비밀번호 관리자가 만든 값 |
   | **Auto Confirm User** | **체크한다.** 끄면 확인 메일의 링크를 누르기 전까지 로그인되지 않고, 이 화면은 "이메일 확인이 끝나지 않은 계정"이라고 거절한다 |

3. **Create user**를 누른다.

확인: Users 목록에 내 이메일이 한 줄 생겼다. (`Database error creating new user`가 나오면 9절.)

## 3. 새 가입 끄기

**왜:** 가입이 열려 있으면 아무나 계정을 만들어 `authenticated`가 될 수 있다. 이 화면은 그래도 **관리자 표에 없는 계정에게는 0행만** 준다(정책이 거른다). 그래서 이 절은 낯선 계정이 늘어나는 것 자체를 막는 **두 번째 자물쇠**다. 빠뜨려도 건의는 새지 않지만 꼭 한다.

1. 대시보드 **Authentication → [Sign In / Providers](https://supabase.com/dashboard/project/tvsoacvbjvggqdgnzijc/auth/providers)**(옛 이름 Providers)를 연다.
2. **User Signups**의 **Allow new users to sign up**을 **끄고** 저장한다(Save). 칸 이름이 다르면 이메일 공급자 안의 "가입 허용"에 해당하는 스위치를 찾는다.
3. 같은 화면의 **Allow anonymous sign-ins**가 **꺼져 있는지** 본다. 켜져 있으면 끈다(익명 사용자도 `authenticated`가 된다).

확인: SQL Editor([새 쿼리](https://supabase.com/dashboard/project/tvsoacvbjvggqdgnzijc/sql/new))에서 실행한다.

```sql
select email, created_at from auth.users order by created_at;
```

내 이메일(과 1절에서 본 아는 계정)만 나오면 된다. 소유자가 대시보드에서 만든 계정은 가입을 꺼도 로그인된다.

## 4. `schema.sql` 실행

1. SQL Editor에서 새 쿼리를 연다.
2. 저장소의 [supabase/schema.sql](../supabase/schema.sql) **파일 전체**를 복사해 붙이고 **Run**을 누른다. 처음부터 끝까지 실행하고, **여러 번 실행해도 안전하다**. 이미 있는 기능은 그대로 두고 새 부분만 더한다.
   - "파괴적인 쿼리(destructive)" 확인 창이 뜰 수 있다. 이 파일의 `drop policy`는 이름이 정해진 정책 둘을 지웠다가 바로 다시 만드는 줄이다. 데이터는 지우지 않으니 **Run this query**로 진행한다.
3. 새로 생기는 것: 표 `fps_admins`, 함수 `fps_is_admin()`, 건의 표 `fps_feedback`의 열 단위 권한(읽기 10열·수정 `reply`/`status`), 정책 둘(`fps_feedback_owner_select`, `fps_feedback_owner_update`).

확인 1: 정책이 둘이다.

```sql
select policyname, cmd, roles from pg_policies where tablename = 'fps_feedback' order by policyname;
```

`fps_feedback_owner_select`(SELECT)와 `fps_feedback_owner_update`(UPDATE), 둘 다 `{authenticated}`가 나온다.

확인 2: **`anon`에게는 이 표의 권한이 하나도 없다.**

```sql
select grantee, privilege_type, column_name from information_schema.column_privileges
where table_schema = 'public' and table_name = 'fps_feedback' and grantee in ('anon', 'authenticated', 'PUBLIC')
order by grantee, privilege_type, column_name;
```

`anon`이나 `PUBLIC` 줄이 **없어야** 한다. `authenticated`는 SELECT 10줄(`body`, `created_at`, `id`, `info`, `kind`, `name`, `player_id`, `replied_at`, `reply`, `status`)과 UPDATE 2줄(`reply`, `status`)이다.

## 5. 관리자 등록

아직 아무도 관리자가 아니라서 로그인해도 목록이 비어 있다. 내 계정을 관리자 표에 넣는다. `me@example.com`을 2절의 이메일(소문자)로 바꾼다.

```sql
insert into public.fps_admins (user_id, note)
select id, '소유자' from auth.users where email = 'me@example.com'
on conflict (user_id) do nothing;
```

`Success. No rows returned`가 나오면 실행된 것이다. 이메일로 uid를 찾아 넣으므로 uid를 옮겨 적지 않는다.

확인: 한 줄이 나와야 한다.

```sql
select a.user_id, u.email, a.require_mfa, a.created_at
from public.fps_admins a join auth.users u on u.id = a.user_id;
```

내 이메일과 `require_mfa = false`가 보이면 된다. 줄이 없으면 이메일이 틀렸다(철자, 대문자, 앞뒤 공백).

## 6. 첫 로그인 시험

1. <https://jungmk0720.github.io/skala-fps/dev/inbox.html>을 연다(`Ctrl+F5`). 2절의 이메일·비밀번호로 로그인한다.
   - **받은 건의가 아직 없어요**나 목록이 보이면 성공이다.
   - **받은편지함을 열 수 없어요**가 나오면 9절의 표를 본다(보통 5절이 빠졌거나 4절을 안 했다).
2. 시험 글을 하나 넣는다(SQL Editor. 게임이 건의를 저장하는 것과 같은 INSERT다).

   ```sql
   insert into public.fps_feedback (name, kind, body) values ('받은편지함시험', 'other', '받은편지함 시험입니다');
   ```

   화면에서 **새로고침**을 누르면 맨 위에 `기타 · 접수 · 받은편지함시험` 줄이 보인다.
3. 줄을 눌러 내용을 본다. **운영자 답** 칸에 `확인했어요`를 적고 **답 저장**을 누른다. "답을 저장했어요"가 나오고 상태가 **확인함**으로 바뀐다(새 글에 답하면 서버가 확인함으로 바꾼다).
4. 서버에서도 그렇게 됐는지 본다. **로그인한 계정(`authenticated`)으로 고쳐도 트리거가 도는지** 확인하는 줄이다.

   ```sql
   select id, status, reply, replied_at from public.fps_feedback where name = '받은편지함시험';
   ```

   `status = read`, `reply = 확인했어요`, `replied_at`에 시각이 있어야 한다.
5. **반영** 단추를 눌러 상태가 바뀌는지, 답을 지우고(칸을 비우면 단추가 **답 지우기**가 된다) 저장하면 지워지는지 본다.
6. 시험 글을 지운다(화면에는 지우기가 없다).

   ```sql
   delete from public.fps_feedback where name = '받은편지함시험' and body = '받은편지함 시험입니다';
   ```

7. **진짜 흐름 확인(권장):** 게임 메인 메뉴 → **건의하기**에서 글을 하나 보내고, 이 화면에서 새로고침해 답을 저장한다. 그 기기에서 건의하기 시트를 열면 **운영자 답**이 보이고 메인 메뉴 버튼에 **새 답** 표시가 뜬다. 이 화면이 하는 저장이 플레이어의 건의함에 보이는 기존 동작과 같은 칸(`reply`, `status`)을 고치기 때문이다.
8. **로그아웃**을 누르면 로그인 칸으로 돌아온다. 새로 고쳐도 로그인 칸이면 토큰이 지워진 것이다.

## 7. (선택) 2단계 인증

**왜:** 비밀번호가 새도 인증 앱 없이는 열지 못하게 한다. 필수는 아니다(관리자 표, 긴 비밀번호, 가입 끄기만으로도 낯선 사람은 못 연다). 비밀번호 추측은 Supabase의 로그인 속도 제한이 늦춰 줄 뿐이라서 더 단단히 하고 싶을 때 켠다.

**순서를 지킨다: 먼저 A(인증 앱 등록), 그다음 B(서버가 코드를 요구).**

**A. 인증 앱 등록 (이 화면에서)**

1. 로그인하고 아래쪽 **2단계 인증 (선택)** 을 연다.
2. **인증 앱 등록 시작**을 누른다. QR을 인증 앱으로 읽거나, QR을 못 읽으면 아래 키를 인증 앱에 직접 입력한다.
3. 인증 앱에 보이는 6자리 코드를 넣고 **등록 확인**을 누른다. "등록했어요"가 나온다.

이제 로그인하면 비밀번호 다음에 **코드 칸**이 나온다. 이 화면은 인증 앱이 등록돼 있으면 항상 코드를 묻는다.

**B. 서버에서도 코드를 요구 (SQL Editor)**

```sql
update public.fps_admins set require_mfa = true where user_id = (select id from auth.users where email = 'me@example.com');
```

이후로는 코드 없이 로그인한 토큰(`aal1`)은 목록과 답 저장이 **0행**이다(정책이 `aal2`를 요구한다).

확인: 로그아웃 → 비밀번호로 로그인 → 코드 칸 → 코드 입력 → 목록이 열리고 위쪽에 **2단계 인증됨**이 보인다.

**되돌리기·잠겼을 때**

- 서버의 요구만 끈다(코드 없이도 열린다).

  ```sql
  update public.fps_admins set require_mfa = false where user_id = (select id from auth.users where email = 'me@example.com');
  ```

- B를 A보다 먼저 해서 못 열게 됐다면: 로그인하면 **받은편지함을 열 수 없어요** 화면이 뜨고 그 아래 **2단계 인증** 칸이 열려 있다. 거기서 A를 하고 **다시 확인**을 누른다. 급하면 위의 `require_mfa = false`로 먼저 연다.
- 인증 앱을 잃어버렸다면: 위의 `require_mfa = false`를 실행하고, 등록된 인증 앱을 지운다(이 화면은 인증 앱이 남아 있으면 코드를 계속 묻는다). **마지막 수단**이다. `auth` 안의 표를 직접 지운다. 대시보드 Authentication → Users의 사용자 상세에 MFA 요소를 지우는 메뉴가 있으면 그것을 먼저 쓴다.

  ```sql
  delete from auth.mfa_factors where user_id = (select id from auth.users where email = 'me@example.com');
  ```

  그 뒤 다시 로그인해 A부터 새로 한다.
- 인증 앱 코드는 30초마다 바뀌고 기기 시계가 맞아야 한다. 휴대폰의 시간을 자동으로 맞춘다.

## 8. 끝낸 뒤

**일상 사용**

- 주소를 즐겨찾기에 둔다. 로그인은 **그 탭을 닫으면 풀린다**(새로 고치는 것은 괜찮다). 오래 열어 두면 화면이 토큰을 알아서 갈아 끼우고, 풀리면 로그인 칸으로 돌아온다.
- 쓰던 답은 다른 건의로 옮겨도 남지만(목록에 **쓰는 중** 표시) 탭을 닫으면 사라진다. 저장하지 않은 답이 있으면 브라우저가 닫기 전에 한 번 묻는다.
- 화면에서 하는 일: 읽기, 답 저장(지우기 포함), 상태(확인함·반영·보류). **하지 않는 일**(일부러 뺐다): 글 지우기, 본문 고치기, 플레이어 차단. 이것은 대시보드에서 한다([FEEDBACK.md](FEEDBACK.md) 2절).
- 새 건의가 와도 화면이 알려 주지 않는다. **새로고침**을 눌러 본다. 위쪽 **접수** 칩의 숫자가 아직 열어 보지 않은 새 글 수다(답을 달거나 **확인함**을 누르면 접수에서 빠진다).

**바꾸기**

- **관리자 더하기:** Auth에 그 사람 계정을 만들고(2절, Auto Confirm User 체크) 5절의 SQL에서 이메일만 바꿔 실행한다.
- **관리자 빼기(바로 닫기):** 아래를 실행한다. 그 사람이 열어 둔 화면도 다음 요청부터 0행이다. **비밀번호가 새어 나갔다면 가장 먼저 이것을 한다.**

  ```sql
  delete from public.fps_admins where user_id = (select id from auth.users where email = 'me@example.com');
  ```

  다시 열려면 5절의 INSERT를 한다.
- **비밀번호 바꾸기:** 대시보드 Authentication → Users에서 그 사용자의 메뉴(⋯)에 있는 비밀번호 변경·재설정 항목을 쓴다(이름은 다를 수 있다). 없으면 계정을 지우고 2절부터 다시 한다. uid가 바뀌므로 관리자 줄이 함께 지워지니 5절도 다시 한다.

**끄기**

- 위의 "관리자 빼기" 하나로 충분하다. 관리자가 없으면 정책이 모든 요청에 0행을 준다. 정책과 열 권한은 그대로 두어도 `anon`에게 열려 있는 것은 없다.

## 9. 문제 해결

| 증상 | 원인 | 할 일 |
|---|---|---|
| 로그인 칸에 "서버 주소가 설정돼 있지 않아요" | `js/config.js`의 `supabase` 값이 비었다 | 저장소의 `js/config.js`를 본다([SUPABASE_SETUP.md](SUPABASE_SETUP.md) 4절) |
| "이메일이나 비밀번호가 맞지 않아요" | 철자, 대문자, 2절과 다른 비밀번호 | 이메일은 소문자로. 비밀번호는 8절의 바꾸기 |
| "이메일 확인이 끝나지 않은 계정이에요" | 2절에서 **Auto Confirm User**를 켜지 않았다 | 그 계정을 지우고 체크한 채 2절부터 다시. 5절도 다시 |
| "시도가 너무 잦아요" | Supabase의 로그인 시도 제한 | 몇 분 기다린 뒤 한 번만 시도한다 |
| 로그인은 됐는데 **받은편지함을 열 수 없어요**(관리자 등록 안내) | 5절을 안 했거나 이메일이 달랐다. 또는 `require_mfa`를 켰는데 코드 없이 로그인했다 | 5절 확인 SQL. 2단계 인증이면 7절. 고친 뒤 **다시 확인** |
| "서버에 받은편지함 기능이 없어요" | 4절의 `schema.sql`을 아직 실행하지 않았다 | 4절. 실행한 뒤 **다시 확인** |
| 4절을 실행했는데도 "기능이 없어요"가 나온다 | 서버가 새 함수를 아직 못 봤다(스키마 캐시) | SQL Editor에서 `notify pgrst, 'reload schema';`를 실행하고 1분 뒤 **다시 확인** |
| "권한이 없어요(schema.sql을 실행했는지…)" | 4절을 일부만 실행했거나 권한 줄이 적용되지 않았다 | 4절을 처음부터 끝까지 다시 실행하고 확인 1·2를 본다 |
| 목록이 비었는데 건의는 분명히 있다 | 계정이 관리자가 아니다(정책이 0행을 준다), 또는 거르기가 걸려 있다 | 위쪽 **전체** 칩과 종류 **전체**로 돌린다. 5절 확인 SQL을 다시 본다 |
| "저장되지 않았어요" | 그 글이 지워졌거나 관리자 줄이 지워졌다 | **새로고침**으로 다시 불러온다 |
| "로그인이 풀렸어요" | 오래 열어 두었거나 서버 세션이 끝났다(비밀번호를 바꾼 경우 등) | 다시 로그인한다 |
| "인증 코드가 맞지 않거나 시간이 지났어요" | 코드가 바뀌었거나 기기 시계가 틀렸다 | 앱에 지금 보이는 6자리를 넣는다. 휴대폰 시간을 자동으로 맞춘다 |
| SQL Editor가 "파괴적인 쿼리"라고 확인을 묻는다 | `schema.sql`의 `drop policy` 줄 | 4절 안내대로 진행한다(정책만 다시 만든다) |
| Users에서 `Database error creating new user` | 사용자를 만들 때 돌도록 걸린 다른 트리거가 실패한다(같은 프로젝트의 다른 앱 것일 수 있다). 이 코드는 `auth.users`에 트리거를 걸지 않는다 | 다른 앱의 트리거는 건드리지 않고, 대시보드 Database → Triggers에서 `auth.users`에 걸린 것을 확인한다 |
| 화면이 옛 모양이거나 단추가 안 눌린다 | 브라우저가 옛 파일을 쥐고 있다 | `Ctrl+F5`(Pages 캐시는 최대 10분) |
| 휴대폰에서 목록과 내용이 한꺼번에 안 보인다 | 좁은 화면은 목록 → 내용 순서로 바뀐다 | 정상이다. 내용 위의 **← 목록으로**로 돌아간다 |

그 밖의 오류는 화면에 나온 문구 그대로 [FEEDBACK.md](FEEDBACK.md) 6절과 이 표를 찾아본다. 서버 응답에서 온 짧은 영어 설명이 괄호로 붙어 나오는 경우가 있다.

## 확인한 문서 (2026-11-17)

- 로그인 설정 이름("Allow new users to sign up", "Allow anonymous sign-ins", "Confirm Email"): <https://supabase.com/docs/guides/auth/general-configuration>
- 2단계 인증(TOTP) 등록·도전·확인과 `aal` 수준: <https://supabase.com/docs/guides/auth/auth-mfa/totp>
- 2단계 인증을 RLS로 강제하는 방법(`auth.jwt()->>'aal'`, 등록한 사람에게만 요구하는 방식): <https://supabase.com/docs/guides/auth/auth-mfa>
- 화면이 부르는 Auth 주소와 본문(`/token?grant_type=password`, `grant_type=refresh_token`, `/factors`, `/factors/{id}/challenge`, `/factors/{id}/verify`)은 공식 JavaScript 클라이언트의 소스에서 확인했다: <https://github.com/supabase/supabase-js/blob/master/packages/core/auth-js/src/GoTrueClient.ts>
- 대시보드의 Users 화면: <https://supabase.com/docs/guides/auth/managing-user-data>
- **대시보드 화면 이름**(Add user → Create new user, Auto Confirm User, Sign In / Providers의 스위치 위치)은 공식 문서에 클릭 순서가 자세히 없어 일반적인 이름으로 적었다. 다르면 같은 뜻의 메뉴를 찾는다.
- DB 쪽(열 단위 권한, 정책, 트리거, `aal2` 요구)은 이 저장소의 `supabase/schema.sql`을 실제 Postgres에서 역할(`anon`, `authenticated`)을 바꿔 가며 확인했고, 화면 쪽은 가짜 Supabase로 시험했다. **진짜 Supabase Auth와 이어서 도는 것은 6절의 첫 로그인 시험이 처음이다.**
