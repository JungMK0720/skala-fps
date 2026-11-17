# 건의함

플레이어가 게임 안에서 **운영자(소유자)에게 바로** 버그·제안·밸런스 의견을 보내고, 운영자가 단 답을 같은 곳에서 본다.
메인 메뉴의 **건의하기** 버튼과 경기 중 일시정지 메뉴(Esc)의 **건의하기**에서 연다.

코드는 `supabase/schema.sql`의 건의함 절(표 `fps_feedback`, RPC `fps_send_feedback`·`fps_my_feedback`), `js/account/feedback.js`(규칙),
`js/account/index.js`(`sendFeedback`·`myFeedback`·`feedbackBox`), `js/ui/feedback.js`(시트)다. 시험은 `tests/feedback.test.mjs`와 `npm run qa -- --only feedback`.

## 1. 처음 한 번: 서버 열기 (소유자)

1. Supabase 대시보드 → **SQL Editor**에서 `supabase/schema.sql`을 처음부터 끝까지 실행한다. 여러 번 실행해도 안전하다.
2. 같은 창에서 `select public.fps_features();`를 실행해 `"feedback": true`가 보이면 끝이다.
3. 게임은 다시 배포할 필요가 없다. 다음 접속부터 건의하기 시트의 보내기 버튼이 켜진다.

실행하기 전에는 시트가 "건의함이 아직 열리지 않았어요"를 보여 주고 보내기를 막는다(글을 다 쓰고 나서 실패하지 않게).
같은 실행으로 캐릭터 구매(`avatars`)도 함께 열린다(`docs/SUPABASE_SETUP.md` 9절).

## 2. 읽기와 답하기 (소유자)

받은편지함(6절)을 켰다면 **SQL이나 Table Editor 없이 웹 화면에서** 읽고 답한다. 아래는 대시보드에서 직접 하는 방법이다(받은편지함을 켜기 전, 또는 글 지우기·차단처럼 화면에 없는 일).

**Table Editor → `fps_feedback`** 에서 `created_at` 내림차순으로 본다. 칸의 뜻:

| 칸 | 뜻 |
|---|---|
| `name` | 보낼 때의 닉네임(나중에 이름을 바꿔도 남는다) |
| `kind` | `bug` 버그 · `idea` 제안 · `balance` 밸런스 · `other` 기타 |
| `body` | 본문(5~1,000자, 서버가 안 보이는 글자를 지우고 정리한 값) |
| `info` | 진단 정보: 연 곳(`where`: menu/pause), 버전, 화면 크기, 터치 여부, 브라우저 이름과 주 버전, 경기 중이면 모드·맵 |
| `status` | `new` 접수 → `read` 확인함 → `done` 반영 / `hold` 보류. 보낸 사람에게 이 말로 보인다 |
| `reply` | 여기에 답을 적으면(500자까지) 보낸 사람의 건의하기 시트에 "운영자 답"으로 보인다. `replied_at`은 자동으로 찍힌다 |

- 새 글(`new`)에 답을 적으면 상태가 저절로 `read`가 된다. 고쳐서 배포했다면 `done`으로 바꾼다.
- 답을 지우려면 `reply`를 비운다(`replied_at`도 지워진다).
- 보낸 사람은 메인 메뉴의 건의하기 버튼에 **새 답** 표시를 보고 시트를 열어 읽는다.

SQL Editor로 볼 때:

```sql
-- 아직 안 읽은 건의
select id, created_at at time zone 'Asia/Seoul' as at, name, kind, body, info
from public.fps_feedback where status = 'new' order by id desc;

-- 답하고 상태 바꾸기
update public.fps_feedback set reply = '고쳤어요. 다음 배포에 들어가요!', status = 'done' where id = 12;
```

**도배하는 사람 막기:** Table Editor → `fps_players`에서 그 사람의 `feedback_blocked`를 `true`로 바꾼다. 그 사람은 "지금은 건의를 보낼 수 없어요"를 받는다.
글 자체를 지우는 것은 Table Editor에서 행을 지우면 된다(스키마 파일에는 데이터를 지우는 문장을 넣지 않는다).

## 3. 서버가 지키는 규칙

| 규칙 | 값 | 넘으면 |
|---|---|---|
| 보낼 수 있는 사람 | 닉네임을 서버에 등록한 기기 토큰 | `NOT_FOUND` → "닉네임이 서버에 등록된 뒤에 보낼 수 있어요" |
| 길이 | 정리한 뒤 5~1,000자(이모지 하나는 1자) | `FEEDBACK_INVALID` |
| 한 사람 | 10분에 3개, 하루 15개 | `RATE_LIMITED` |
| 같은 IP | 한 시간 40개(교실처럼 여럿이 한 IP를 써도 넉넉하게) | `RATE_LIMITED` |
| 전체 | 하루 500개(무료 DB를 지킨다) | `RATE_LIMITED` |
| 같은 글 | 같은 사람이 하루 안에 같은 본문 | `FEEDBACK_DUPLICATE` |
| 차단 | `fps_players.feedback_blocked` | `FEEDBACK_BLOCKED` |
| 진단 정보 | 짧은 문자열(80자)·숫자·참거짓 칸만 12개까지, 2KB 넘으면 통째로 버림 | 글은 받는다 |

클라이언트(`js/account/feedback.js`)도 같은 정리·길이 규칙으로 먼저 걸러 서버에 헛걸음하지 않는다. 두 쪽이 같은지는 `tests/feedback.test.mjs`가 글자 단위로 대조한다.

## 4. 왜 이 방법인가

후보와 비교했다.

| 방법 | 장점 | 이 게임에서 문제 |
|---|---|---|
| **Supabase 표 + RPC (고른 것)** | 이미 쓰는 프로젝트·기기 토큰·IP 한도 표를 그대로 쓴다. 비용 0 | 소유자가 SQL을 한 번 실행해야 한다 |
| 이메일 주소 공개(mailto) | 만들 것이 없다 | 주소가 공개돼 스팸이 온다(이미 겪었다). 게임 밖으로 나가야 하고 닉네임·상황이 빠진다 |
| 구글 폼 같은 외부 폼 | 만들기 쉽다 | 게임 밖으로 나간다. 누가 보냈는지(닉네임) 묶을 수 없고, 도배를 서버에서 막을 수 없고, 답을 게임에서 돌려줄 수 없다 |
| 디스코드·슬랙 웹훅 | 알림이 바로 온다 | 웹훅 주소가 브라우저 코드에 들어가 누구나 꺼내 도배할 수 있다(비밀을 클라이언트에 둘 수 없다) |
| Cloudflare Worker에 새 경로 | 서버 코드로 검사할 수 있다 | 저장소(KV·D1)를 새로 붙여야 하고, Worker를 다시 배포하면 열려 있는 방(Durable Object) 연결이 끊긴다 |
| GitHub Issues | 개발 흐름과 붙는다 | 플레이어에게 GitHub 계정이 필요하고 글이 공개된다 |

고른 이유:

1. **게임 안에서 끝난다.** 플레이어는 메뉴나 일시정지에서 바로 쓰고, 닉네임과 상황(모드·맵·화면·브라우저)이 함께 와서 재현하기 쉽다.
2. **소유자 연락처가 드러나지 않는다.** 이메일을 공개하지 않으니 예전 같은 스팸 통로가 생기지 않는다.
3. **클라이언트에 비밀이 없다.** 브라우저에는 지금도 쓰는 Publishable key만 있고, 그 키(`anon`)로 할 수 있는 일은 "글 넣기"와 "내 글 보기" 두 RPC뿐이다.
   표는 RLS를 켜고 `anon`에게 권한을 하나도 주지 않아 플레이어는 API로 아무것도 읽지 못한다. 읽는 사람은 대시보드에 로그인한 소유자와, 관리자 표에 등록한 소유자 계정으로 받은편지함 화면(6절)에 로그인한 사람뿐이다.
4. **도배를 서버가 막는다.** 등록된 토큰만, 한 사람·IP·전체 한도, 같은 글 거절, 차단 칸. 클라이언트를 고쳐도 피할 수 없다.
5. **답이 돌아온다.** `reply` 칸 하나로 양방향이 되어, 보낸 사람이 "읽혔는지"를 안다. 메일 주소를 받지 않아도 된다.
6. **운영 부담이 작다.** 새 서비스·새 비밀·Worker 재배포가 없다. Free 플랜 안에서 돈이 들지 않는다.
7. **포트폴리오로 설명할 거리가 있다.** RLS + SECURITY DEFINER RPC로 권한을 좁히는 법, 서버 쪽 속도 제한, 트리거로 답 시각 찍기, JS·SQL 규칙을 시험으로 맞추는 법.

## 5. 저장하는 것과 하지 않는 것

- 저장: 닉네임 사본, `fps_players.id`, 종류·본문, 진단 정보(위 표), 상태·답, 시각.
- 저장하지 않음: 이메일·전화번호(입력칸이 없고, 시트가 "개인정보는 적지 마세요"라고 안내한다), IP 원문(한도는 `fps_rate`의 해시로만 센다), 기기 토큰 원문.
- 보낸 사람은 `fps_my_feedback`으로 **자기 글과 답만** 최근 10개 본다. 다른 사람의 글·진단 정보·이름은 내보내지 않는다.

## 6. 받은편지함: 소유자 전용 웹 화면

SQL이나 Table Editor 없이 **웹 페이지에서 건의를 읽고 답과 상태를 저장**한다. 문의에 답할 때마다 SQL을 쓰지 않는 현업 방식에 맞춘 화면이다.
화면은 `dev/inbox.html`(<https://jungmk0720.github.io/skala-fps/dev/inbox.html>, 게임을 불러오지 않는 가벼운 페이지라 휴대폰으로도 된다)이고,
코드는 `js/admin/inbox.js`(서버 호출·규칙), `js/admin/inbox-view.js`(그리기), `js/admin/inbox-panel.js`(화면 연결), 서버 쪽은 `supabase/schema.sql`의 "건의함 받은편지함" 절이다.
시험은 `tests/inbox.test.mjs`와 `npm run qa -- --only inbox`다.
처음 켜는 순서(소유자 계정 만들기, 새 가입 끄기, `schema.sql` 실행, 관리자 등록, 첫 로그인 시험, 선택 2단계 인증)는 용어 풀이부터 [FEEDBACK_INBOX_SOP.md](FEEDBACK_INBOX_SOP.md)에 있다. 켜기 전에는 건의함이 2절 그대로 동작한다.

### 6.1 화면이 하는 일

| 화면 | 동작 |
|---|---|
| 로그인 | 이메일·비밀번호(Supabase Auth). 인증 앱을 등록했다면 6자리 코드가 더 필요하다 |
| 목록 | 새 글이 위, 100건씩(**더 보기**), 상태 칩(전체·접수·확인함·반영·보류와 개수)과 종류 거르기 |
| 내용 | 본문, 보낸 사람(닉네임·플레이어 번호), 받은 시각과 답한 시각(한국 시간), 진단 정보 |
| 답 | 500자까지. 저장하면 보낸 사람의 건의하기 시트에 "운영자 답"으로 보인다(`fps_my_feedback`, 지금과 같은 칸). 칸을 비우고 저장하면 답을 지운다. 저장하지 않은 답은 다른 글로 옮겨도 남는다 |
| 상태 단추 | 확인함(`read`) · 반영(`done`) · 보류(`hold`). 답만 달아도 새 글(`new`)은 트리거가 확인함으로 바꾼다 |
| 로그아웃 | 이 기기의 로그인을 끝내고 토큰을 지운다 |

일부러 뺀 것: 글 지우기, 본문·보낸 사람 고치기, 플레이어 차단(`feedback_blocked`). 위험한 일은 2절의 대시보드로 한다.

### 6.2 누가 무엇을 하나 (권한 설계)

```
브라우저 dev/inbox.html ── 이메일·비밀번호(+코드) ──▶ Supabase Auth ── 토큰(JWT: uid, aal1·aal2)
   │  Authorization: Bearer 토큰, apikey: Publishable key
   ▼
PostgREST ──▶ 신분 authenticated ──▶ ① 열 단위 권한 ──▶ ② RLS 정책 fps_is_admin() ──▶ fps_feedback
```

| 층 | 내용 | 막는 것 |
|---|---|---|
| `anon`(플레이어) | 이 표의 권한이 없다(`revoke all` 그대로). 쓰기는 `fps_send_feedback`, 읽기는 `fps_my_feedback`뿐이다. 이번에 `anon`의 권한은 늘리지 않았다 | 플레이어가 남의 건의를 읽는 것 |
| 새 가입 끄기 | Auth 설정에서 "Allow new users to sign up"을 끈다 | 아무나 `authenticated`가 되는 것(첫 자물쇠). 끄지 않아도 아래가 거른다 |
| 관리자 표 `fps_admins` + `fps_is_admin()` | 소유자 계정의 uid를 소유자가 SQL Editor에서 넣는다(`schema.sql`에 uid를 적지 않는다). 표는 API로 읽지도 쓰지도 못하고, 이 함수(SECURITY DEFINER)만 본다 | 로그인한 낯선 계정(관리자 표에 없으면 정책이 0행을 준다) |
| 열 단위 권한 | `authenticated`는 건의 표의 열 10개를 읽고 `reply`·`status` 두 칸만 고친다 | 정책을 통과한 계정도 본문·이름·종류·진단 정보·`replied_at` 수정, 넣기, 지우기를 못 한다(권한 오류) |
| 정책 `fps_feedback_owner_select`·`fps_feedback_owner_update` | 읽기·수정 모두 `fps_is_admin()`이 참일 때만(수정은 `with check`도) | 위 두 층 사이로 빠져나가는 요청 |
| `require_mfa`(선택) | 관리자 표의 칸. 켜면 인증 앱 코드로 로그인한 토큰(`aal2`)만 통과한다 | 비밀번호만 새었을 때 |
| 토큰 보관 | 메모리와 sessionStorage에만(탭을 닫으면 사라진다). 주소·localStorage·콘솔에 쓰지 않는다 | 토큰이 남는 것 |
| 화면 | 글은 `textContent`로만 그린다. CSP는 이 사이트의 스크립트와 Supabase 프로젝트(`connect-src`)만 허용한다. 로그인 칸에는 `name`이 없고(스크립트가 못 떠도 비밀번호가 주소에 실리지 않는다), 다른 페이지의 iframe 안에서는 열리지 않는다. `noindex` | 플레이어가 쓴 글로 화면이 오염되는 것(XSS), 비밀번호가 주소에 남는 것, 클릭재킹 |

- 답을 저장하면 트리거 `fps_feedback_stamp`가 답한 시각을 찍고 새 글을 확인함으로 바꾼다. 트리거는 호출한 계정(`authenticated`)의 권한으로 돌지만 새 값만 만지므로 별도 권한이 필요 없고, 열 권한 밖인 `replied_at`도 트리거가 찍는다.
- `fps_is_admin()`은 `authenticated`만 부를 수 있다. 화면은 로그인 직후 이 함수로 "관리자인가"를 물어, 아니면 목록 대신 안내를 보여 준다.
- 2단계 인증을 켜는 순서는 정해져 있다: 먼저 화면에서 인증 앱을 등록하고(Supabase Auth의 TOTP), 그다음 SQL로 `require_mfa`를 켠다. 순서를 바꿔 못 열게 돼도 화면의 안내 칸에서 등록하고 **다시 확인**을 누르면 된다.

### 6.3 왜 이 방법인가

| 방법 | 장점 | 이 게임에서 문제 |
|---|---|---|
| **Supabase Auth + RLS + 정적 화면 (고른 것)** | 비밀이 브라우저에 없고(Publishable key와 로그인 토큰뿐) 권한을 DB가 직접 정한다. 새 서버·새 비밀·Worker 재배포가 없다 | 소유자가 계정 만들기와 SQL 실행을 한 번 해야 한다(SOP) |
| 서비스 키(`service_role`)를 화면에 두기 | 정책을 안 짜도 된다 | 키가 브라우저에 있으면 누구나 꺼내 전체 권한을 가진다 |
| Cloudflare Worker에 소유자 API | 서버 코드로 검사한다 | 저장소·비밀이 더 늘고, Worker를 다시 배포하면 열려 있는 방(Durable Object) 연결이 끊긴다 |
| 대시보드(SQL·Table Editor)만 쓰기 | 만들 것이 없다 | 답할 때마다 SQL을 쓰는 것은 현업 방식이 아니고 실수하기 쉽다 |

- **uid를 파일에 박지 않고 관리자 표에 둔다:** 계정을 바꾸거나 관리자를 늘려도 `schema.sql`과 배포를 건드리지 않는다. 소유자가 SQL Editor에서 한 줄이면 된다.
- **정책이 거르므로 새 가입을 끄지 않아도 안전하다.** 가입을 끄는 것은 낯선 계정이 늘어나는 것을 막는 두 번째 자물쇠다. 같은 프로젝트를 쓰는 다른 앱이 Auth 가입을 받고 있으면 끄지 않아도 된다.
- **2단계 인증을 정책이 아니라 관리자 줄의 스위치로 둔다:** Supabase 문서의 "인증 앱을 등록한 사람에게만 `aal2`를 요구" 방식은 정책이 `auth.mfa_factors`를 읽어야 한다. 여기서는 소유자가 직접 켜는 `require_mfa`로 두어 `auth` 안쪽 표를 정책이 건드리지 않게 하고, 인증 앱을 등록만 해 두고 아직 서버에서 강제하지 않는 단계도 둔다.
- **포트폴리오로 설명할 거리:** `anon`/`authenticated` 분리, RLS와 열 단위 권한을 함께 쓰는 법, SECURITY DEFINER 함수로 관리자 표를 숨기는 법, JWT의 `aal`로 2단계 인증을 DB가 확인하는 법, `supabase-js` 없이 Auth REST를 부르는 법, 같은 규칙을 JS·SQL·문서에서 시험으로 맞추는 법.

### 6.4 한계와 확인한 범위

- 화면 파일은 공개돼 있어 누구나 열어 볼 수 있다. 로그인하지 않으면 아무것도 읽지 못한다.
- 비밀번호 추측은 Supabase의 로그인 속도 제한과 긴 비밀번호가 늦춰 준다. 더 막으려면 2단계 인증을 켠다.
- 새 건의가 와도 이 화면은 알려 주지 않는다(**새로고침**으로 본다). 알림은 따로 붙인다(Database Webhook → Edge Function, 비밀은 Edge Function에만).
- **확인한 범위:** DB 규칙(열 단위 권한, 정책, 트리거, `aal2`, 다시 실행해도 같은 결과)은 `schema.sql`을 실제 Postgres에서 `anon`·`authenticated` 역할로 바꿔 가며 확인했다. 화면은 `tests/inbox.test.mjs`(가짜 서버·가짜 DOM)와 `npm run qa -- --only inbox`(가짜 Supabase, 헤드리스 브라우저)로 시험했다. **진짜 Supabase Auth·PostgREST와 이어서 도는 것은 SOP 6절의 첫 로그인 시험이 처음이다.**
