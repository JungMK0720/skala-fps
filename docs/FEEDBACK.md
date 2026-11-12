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

- **새 건의 알림:** Supabase Database Webhook → Edge Function → 디스코드/메일. 웹훅 주소는 Edge Function의 비밀로 두어 브라우저에 나가지 않게 한다.
- **운영자 답장 화면:** 지금은 Table Editor로 충분하다. 따로 만들면 소유자만 쓰는 로그인(Supabase Auth)과 정책이 필요하다.
