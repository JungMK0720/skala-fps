# 건의함

플레이어가 게임 안에서 **운영자(소유자)에게 바로** 버그·제안·밸런스 의견을 보내고, 운영자가 단 답을 같은 곳에서 본다.
메인 메뉴의 **건의하기** 버튼과 경기 중 일시정지 메뉴(Esc)의 **건의하기**에서 연다.

코드는 `supabase/schema.sql`의 건의함 절(표 `fps_feedback`, RPC `fps_send_feedback`·`fps_my_feedback`), `js/account/feedback.js`(규칙),
`js/account/index.js`(`sendFeedback`·`myFeedback`·`feedbackBox`), `js/ui/feedback.js`(시트)다. 시험은 `tests/feedback.test.mjs`와 `npm run qa -- --only feedback`.
새 건의를 이메일로 알리는 Edge Function은 7절(`supabase/functions/notify-feedback/`, 시험 `tests/feedback-notify.test.mjs`)이다.

## 1. 처음 한 번: 서버 열기 (소유자)

1. Supabase 대시보드 → **SQL Editor**에서 `supabase/schema.sql`을 처음부터 끝까지 실행한다. 여러 번 실행해도 안전하다.
2. 같은 창에서 `select public.fps_features();`를 실행해 `"feedback": true`가 보이면 끝이다.
3. 게임은 다시 배포할 필요가 없다. 다음 접속부터 건의하기 시트의 보내기 버튼이 켜진다.

실행하기 전에는 시트가 "건의함이 아직 열리지 않았어요"를 보여 주고 보내기를 막는다(글을 다 쓰고 나서 실패하지 않게).
같은 실행으로 캐릭터 구매(`avatars`)도 함께 열린다(`docs/SUPABASE_SETUP.md` 9절).

## 2. 읽기와 답하기 (소유자)

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

새 글이 올 때마다 메일로 받는 방법은 7절이다.

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
3. **클라이언트에 비밀이 없다.** 브라우저에는 지금도 쓰는 Publishable key만 있고, 그 키로 할 수 있는 일은 "글 넣기"와 "내 글 보기" 두 RPC뿐이다.
   표는 RLS를 켜고 정책·권한을 하나도 주지 않아 API로는 아무도 읽지 못한다. 읽는 사람은 대시보드에 로그인한 소유자뿐이다.
4. **도배를 서버가 막는다.** 등록된 토큰만, 한 사람·IP·전체 한도, 같은 글 거절, 차단 칸. 클라이언트를 고쳐도 피할 수 없다.
5. **답이 돌아온다.** `reply` 칸 하나로 양방향이 되어, 보낸 사람이 "읽혔는지"를 안다. 메일 주소를 받지 않아도 된다.
6. **운영 부담이 작다.** 새 서비스·새 비밀·Worker 재배포가 없다. Free 플랜 안에서 돈이 들지 않는다.
7. **포트폴리오로 설명할 거리가 있다.** RLS + SECURITY DEFINER RPC로 권한을 좁히는 법, 서버 쪽 속도 제한, 트리거로 답 시각 찍기, JS·SQL 규칙을 시험으로 맞추는 법.

## 5. 저장하는 것과 하지 않는 것

- 저장: 닉네임 사본, `fps_players.id`, 종류·본문, 진단 정보(위 표), 상태·답, 시각.
- 저장하지 않음: 이메일·전화번호(입력칸이 없고, 시트가 "개인정보는 적지 마세요"라고 안내한다), IP 원문(한도는 `fps_rate`의 해시로만 센다), 기기 토큰 원문.
- 보낸 사람은 `fps_my_feedback`으로 **자기 글과 답만** 최근 10개 본다. 다른 사람의 글·진단 정보·이름은 내보내지 않는다.

## 6. 나중에 붙일 수 있는 것

- **운영자 답장 화면:** 지금은 Table Editor로 충분하다. 따로 만들면 소유자만 쓰는 로그인(Supabase Auth)과 정책이 필요하다.
  소유자 계정 하나만 대시보드에서 만들고 새 가입은 끈 뒤, `authenticated`에게 `fps_feedback`의 `select`와 `update(reply, status)`만 열 단위로 주고 RLS 정책으로 그 uid만 통과시키는 방법이 가장 단순하다.
  가입을 끄지 않으면 누구나 `authenticated`가 될 수 있으므로 정책은 반드시 소유자 uid로 거른다. 플레이어는 기기 토큰을 쓰는 `anon`이라 영향이 없다.
- **새 건의 알림**은 7절에 붙였다.

## 7. 새 건의를 이메일로 받기 (선택)

새 건의가 들어오면 보통 몇 초 안에 소유자 메일로 알려 준다. 게임과 `schema.sql`은 바뀌지 않고, 이 절을 하지 않아도 건의함은 그대로 동작한다.
코드는 `supabase/functions/notify-feedback/`(`core.js`: 규칙, `index.ts`: Deno 연결)와 `supabase/config.toml`, 시험은 `tests/feedback-notify.test.mjs`다.
처음 켜는 순서를 용어 풀이(프로젝트 ref 등)와 화면·명령 단위로 따라 하려면 [FEEDBACK_EMAIL_SOP.md](FEEDBACK_EMAIL_SOP.md)를 쓴다. 아래 7.1은 같은 내용의 요약이다.

```
플레이어가 보냄 → fps_send_feedback → fps_feedback에 INSERT
  → Database Webhook (INSERT만, pg_net이 비동기로 호출)
  → Edge Function notify-feedback (비밀 헤더 확인)
  → Resend API → 소유자 메일
```

### 7.1 처음 한 번 (소유자)

명령은 Windows PowerShell 기준이다. `<프로젝트 ref>`는 프로젝트 주소 `https://<ref>.supabase.co`의 앞부분이다(`js/config.js`의 `supabase.url`). 대시보드 메뉴 이름은 바뀔 수 있다.

1. **Resend 가입:** <https://resend.com>에 **알림을 받을 메일 주소로** 가입하고, API Keys에서 키를 하나 만든다(권한은 Sending access면 된다). `re_…`로 시작하는 값은 한 번만 보여 주므로 복사해 둔다.
   보내는 주소는 Resend의 테스트 주소 `onboarding@resend.dev`를 쓴다. 이 주소는 가입한 메일로만 보낼 수 있는데, 소유자 한 사람에게만 알리는 이 용도에는 그대로 맞고 도메인을 살 필요가 없다.
2. **웹훅 비밀 만들기:** Database Webhook이 함수를 부를 때 내미는 암호다. 24글자 이상 무작위 값을 만든다.
   ```powershell
   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
   ```
3. **비밀 저장:** 값 세 개를 Edge Function secret으로 올린다(`SUPABASE_URL`은 Supabase가 넣어 준다). 가장 쉬운 방법은 대시보드 Edge Functions → Secrets에서 Key·Value를 넣고 Save하는 것이다(명령 기록이 남지 않고, 함수는 새 비밀을 바로 읽는다). 명령으로 하려면 4단계의 로그인을 먼저 하고 아래를 실행한다. 명령은 터미널 기록에 남으니 쓴 뒤 기록을 정리하거나 `--env-file <파일>`로 올리고 파일을 지운다.
   ```powershell
   npx supabase secrets set --project-ref <프로젝트 ref> RESEND_API_KEY=re_… OWNER_EMAIL=me@example.com WEBHOOK_SECRET=<2에서 만든 값>
   ```
4. **로그인과 함수 배포:** 저장소 루트에서 실행한다.
   ```powershell
   npx supabase login
   npx supabase functions deploy notify-feedback --project-ref <프로젝트 ref> --no-verify-jwt --use-api
   ```
   웹훅은 사용자 로그인(JWT)이 없어서 `--no-verify-jwt`가 필요하다(`supabase/config.toml`에도 같은 설정이 있다). 대신 함수가 비밀 헤더를 직접 확인한다. `--use-api`는 Docker 없이 Supabase 서버에서 묶어 올리는 방식이다.
   함수를 고치면 같은 명령으로 다시 배포하고, 비밀은 그대로 남는다.
5. **웹훅 만들기:** 대시보드 Database → Webhooks → 새 웹훅을 만든다.
   - Name: `fps_feedback_email`
   - Table: `public.fps_feedback`, Events: **Insert만**(Update·Delete는 끈다)
   - Type: Supabase Edge Functions → `notify-feedback`, Method: POST, Timeout: 5000
   - HTTP Headers: `x-webhook-secret` = 2에서 만든 값

   SQL Editor로 만들 수도 있다(웹훅을 대시보드에서 한 번이라도 켜면 `supabase_functions` 스키마가 생긴다). 비밀이 든 문장은 저장소에 두지 않는다.
   ```sql
   create trigger fps_feedback_email after insert on public.fps_feedback
     for each row execute function supabase_functions.http_request(
       'https://<프로젝트 ref>.supabase.co/functions/v1/notify-feedback', 'POST',
       '{"Content-Type":"application/json","x-webhook-secret":"<웹훅 비밀>"}', '{}', '5000');
   ```
6. **시험:** SQL Editor에서 시험 글을 넣어 메일이 오는지 보고 지운다.
   ```sql
   insert into public.fps_feedback (name, kind, body) values ('알림시험', 'other', '알림 메일 시험입니다');
   -- 메일을 확인한 뒤
   delete from public.fps_feedback where name = '알림시험' and body = '알림 메일 시험입니다';
   ```
   첫 메일은 스팸함에 갈 수 있다. Gmail이면 보낸 사람 `onboarding@resend.dev`를 "스팸 아님"으로 하는 필터를 만든다.

### 7.2 메일 모양

```
제목  [SKALA 건의 #12] 버그 · 닉네임 · 본문 앞 40자
본문  번호, 종류, 보낸 사람, 받은 시각(한국 시간)
      본문(플레이어가 쓴 글 그대로, 최대 1,000자)
      진단 정보(연 곳, 버전, 터치 기기, 화면 크기, 브라우저, 모드, 맵)
      답하는 SQL 한 줄(번호가 채워져 있다)과 Table Editor·SQL Editor 링크
```

메일 답장으로는 플레이어에게 답할 수 없다. 이메일 주소를 받지 않는 설계라 보낼 곳이 없고, `onboarding@resend.dev`로 답장해도 아무에게도 가지 않는다.
메일의 SQL을 SQL Editor에서 실행하거나 Table Editor의 `reply` 칸에 적는다(2절).

### 7.3 지키는 것과 한도

| 항목 | 값 |
|---|---|
| 누가 함수를 부를 수 있나 | `x-webhook-secret`이 맞는 요청만. 틀리면 403, 비밀이 없거나 24글자보다 짧으면 500으로 닫힌 채 멈춘다(아무도 통과하지 못한다). 비교는 SHA-256으로 길이를 맞춘 뒤 끝까지 본다 |
| 비밀이 있는 곳 | Edge Function secret(`RESEND_API_KEY`, `OWNER_EMAIL`, `WEBHOOK_SECRET`). 저장소·브라우저에는 없다. 웹훅 비밀은 트리거 정의에도 저장되어 DB 덤프에 보일 수 있으니 이 용도에만 쓴다 |
| 메일 내용 | 텍스트만(HTML 없음). 글 속 태그는 실행되지 않고, 이름·제목은 한 줄로 줄이며 안 보이는 글자를 지운다. 받는 주소는 `OWNER_EMAIL` 하나이고 플레이어 입력은 주소·머리글에 쓰이지 않는다 |
| 같은 건의가 다시 오면 | `Idempotency-Key: skala-feedback-<번호>`로 24시간 안에는 메일이 한 번만 간다 |
| Resend 무료 한도 | 하루 100통, 한 달 3,000통(2026-11-17 공식 문서 확인). 서버의 건의 상한(하루 500건)보다 작아서, 폭주하면 알림만 멈추고(502 로그) 건의 저장은 영향이 없다 |
| 메일이 실패하면 | 웹훅은 INSERT 뒤에 `pg_net`이 비동기로 부르므로 건의 저장은 막히지 않는다. 다시 보내 주지는 않는다(공식 문서에 재시도 보장이 없다). 놓친 건은 2절의 `status = 'new'` 조회로 본다 |

### 7.4 문제 해결

| 증상 | 원인 | 할 일 |
|---|---|---|
| 메일이 안 온다 | 웹훅이 안 불렀거나 함수가 거절했다 | 먼저 SQL Editor에서 `select id, status_code, timed_out, error_msg, created from net._http_response order by created desc limit 5;`로 웹훅 호출 기록을 본다. 기록이 없으면 5단계 웹훅을, 있으면 대시보드 Edge Functions → `notify-feedback` → Logs를 본다 |
| 상태 403 `forbidden` | 웹훅 헤더 값과 `WEBHOOK_SECRET`이 다르다 | 둘을 같은 값으로 맞춘다(secret을 바꿨다면 웹훅 헤더도) |
| 상태 500 `not_configured` | 비밀이 없거나 모양이 틀렸다 | 대시보드 Edge Functions → Secrets(또는 `npx supabase secrets list --project-ref <프로젝트 ref>`)에서 세 이름이 있는지 보고 값을 다시 저장한다. `OWNER_EMAIL`은 주소 하나(`이름@도메인.com`)여야 한다 |
| 상태 502 `resend_rejected`, Resend 403 | 테스트 주소는 가입한 메일로만 보낼 수 있다 | `OWNER_EMAIL`을 Resend 가입 메일로 맞춘다. 다른 주소로 받으려면 Resend에서 도메인을 인증하고 `core.js`의 `MAIL_FROM`을 그 도메인 주소로 바꿔 다시 배포한다 |
| 상태 502, Resend 401 | API 키가 틀렸거나 지워졌다 | Resend에서 새 키를 만들어 `RESEND_API_KEY`를 다시 올린다 |
| 상태 502, Resend 429 | 하루 100통(또는 초당 요청 한도)을 넘었다 | 한도가 풀리길 기다린다. 자주 넘으면 Resend 유료 플랜을 생각한다 |
| `timed_out`이 `true` | 응답이 Timeout(5초)보다 늦었다 | 함수는 끝까지 돌아 메일은 갔을 수 있다. 메일이 왔다면 무시한다 |
| 스팸함에 들어간다 | 처음 보는 보내는 주소다 | 필터로 `onboarding@resend.dev`를 "스팸 아님"으로 한다 |
| 배포 명령이 `config.toml` 오류를 낸다 | 설치된 CLI 버전이 설정 형식을 다르게 읽는다(CLI 배포는 저장소 시험 밖이다) | `supabase/config.toml`을 잠시 옮겨 두고 `--no-verify-jwt`만으로 배포한다. 함수 동작은 같다 |

### 7.5 끄고 바꾸기

- **끄기:** 대시보드에서 웹훅 `fps_feedback_email`을 지우거나 `drop trigger fps_feedback_email on public.fps_feedback;`를 실행한다. 함수는 불리지 않으니 그대로 둬도 된다.
- **받는 주소 바꾸기:** `OWNER_EMAIL`만 다시 `secrets set`한다(Resend 가입 메일이어야 한다).
- **비밀 바꾸기:** 웹훅 비밀은 새 값을 만들어 `secrets set`과 웹훅 헤더를 둘 다 바꾼다. Resend 키가 새어 나갔으면 Resend에서 그 키를 지우고 새로 만든 값을 올린다.
- **코드를 고칠 때:** `node --test tests/feedback-notify.test.mjs` → 4단계 배포 명령을 다시 실행한다.

### 7.6 왜 이 방법인가

- **Database Webhook + Edge Function:** 서버 비밀(Resend 키)을 브라우저·저장소·DB 밖에 두고, 이미 쓰는 Supabase 안에서 끝난다. 새 서비스나 Worker 배포가 없다.
- **Resend `onboarding@resend.dev`:** 도메인이 필요 없고 무료로 소유자 한 명에게 보낼 수 있다.
- **규칙은 `core.js`에 따로:** Deno에서만 도는 코드는 시험하기 어렵다. 규칙을 Web 표준만 쓰는 모듈로 두고 Node 시험이 가짜 Resend로 돌린다. `index.ts`는 얇은 연결이다(Node가 `.ts`를 직접 읽으면 시험이 연결까지 이어 본다).
- **텍스트 메일, 비밀 헤더 직접 확인, 닫힌 채 실패:** 플레이어의 글이 메일 모양이나 받는 주소를 바꾸지 못하고, 설정이 빠져도 아무나 알림을 만들지 못한다.
- **한계:** 메일 답장 불가, 재시도 없음, 무료 한도 하루 100통.

### 확인한 문서 (2026-11-17)

- Database Webhooks(INSERT·pg_net 비동기·페이로드): <https://supabase.com/docs/guides/database/webhooks>
- Edge Function 보안(`verify_jwt`): <https://supabase.com/docs/guides/functions/auth>
- Edge Function 비밀(대시보드 Secrets, 바로 반영)과 배포(Docker가 없으면 API 방식, `--use-api`): <https://supabase.com/docs/guides/functions/secrets>, <https://supabase.com/docs/guides/functions/quickstart>
- Resend 무료 한도: <https://resend.com/docs/knowledge-base/account-quotas-and-limits>
- Resend 테스트 주소는 가입한 메일로만: <https://resend.com/docs/knowledge-base/403-error-resend-dev-domain>
- Resend 메일 보내기 API(`Idempotency-Key`): <https://resend.com/docs/api-reference/emails/send-email>
