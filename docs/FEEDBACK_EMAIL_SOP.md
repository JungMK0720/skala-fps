<!--
  Date: 06NOV2026
  Author: Minkyu Jung
  Purpose: 건의 이메일 알림(Edge Function notify-feedback + Resend)을 처음 켜는 절차(SOP). 용어와 값 지도, 준비, Resend, 비밀 저장, 로그인·배포, 함수 단독 시험, 웹훅, 끝 시험, 끄기, 문제 해결.
-->
# 건의 이메일 알림 켜기 (SOP)

새 건의가 `fps_feedback`에 들어오면 몇 초 안에 소유자 메일로 알려 주는 기능을 **처음 켜는** 절차다. 설계·한도·왜 이 방법인가는 [FEEDBACK.md](FEEDBACK.md) 7절에 있고, 이 문서는 "무엇을 어디서 누르고 어떤 명령을 치는가"만 순서대로 적는다.

| 항목 | 내용 |
|---|---|
| 지금 상태 | 코드(`supabase/functions/notify-feedback/`)는 있지만 아래를 하기 전에는 아무것도 보내지 않는다. 건의함은 지금처럼 동작한다 |
| 목표 | 새 건의 → 몇 초 안에 소유자 메일 한 통 |
| 소유자만 할 수 있는 일 | Resend 가입, Supabase 로그인·비밀 저장·배포·웹훅 만들기 |
| 걸리는 시간 | 처음 한 번 30~40분 |
| 비용 | 0원. Resend 무료는 하루 100통·한 달 3,000통이고, Supabase는 지금 쓰는 프로젝트 그대로다 |
| 되돌리기 | 웹훅 하나를 지우면 멈춘다(9절) |

- 명령은 Windows PowerShell 기준이다. `$ref`처럼 `$`로 시작하는 말은 PowerShell 변수라서 **한 창에서 이어서** 실행한다(창을 닫으면 사라진다).
- 화면 이름은 Supabase·Resend가 바꿀 수 있다. 이름이 조금 달라도 같은 뜻의 단추를 찾는다.
- **키와 비밀 값은 채팅·이슈·커밋·스크린샷에 붙이지 않는다.** 오류가 나면 값은 가리고 메시지만 옮긴다.

## 0. 먼저 알아 둘 말

| 말 | 뜻 |
|---|---|
| **프로젝트 ref** | Supabase 프로젝트를 가리키는 20글자 이름이다. 프로젝트 주소 `https://<ref>.supabase.co`의 앞부분이다. 명령어에 "어느 프로젝트에 올릴지" 알려 줄 때 쓴다. 이 프로젝트는 `tvsoacvbjvggqdgnzijc`이고(`js/config.js`의 `supabase.url`) 게임 화면에도 들어가는 공개 값이라 비밀이 아니다 |
| Edge Function | Supabase 서버에서 도는 작은 프로그램이다. 여기서는 "새 건의가 오면 메일을 보내는" 일을 한다(`notify-feedback`) |
| Secret | 함수만 읽을 수 있게 Supabase에 맡겨 두는 값(Resend 키 등)이다. 저장소·브라우저에는 두지 않는다 |
| Database Webhook | 표에 새 줄이 생기면 자동으로 함수를 부르는 장치다. 실제로는 `fps_feedback` 표에 붙는 트리거 하나다 |
| Resend | 메일을 대신 보내 주는 서비스다. 이 용도로는 무료다 |
| API 키 | 서비스가 "이 요청은 이 계정에서 왔다"를 알아보는 긴 암호다. `re_…`로 시작하는 것이 Resend 키다 |

프로젝트 ref는 이 중 어느 것으로도 확인할 수 있다.

- `js/config.js`의 `url: 'https://<ref>.supabase.co'`. 1절 3번에서 명령으로 찾는다.
- 대시보드 주소 `https://supabase.com/dashboard/project/<ref>`.
- 대시보드 Project Settings → General의 Reference ID.

### 값 지도

| 값 | 어디서 얻나 | 어디에 넣나 |
|---|---|---|
| Resend API 키(`re_…`) | Resend 대시보드(2절) | Secret `RESEND_API_KEY`(4절) |
| 알림 받을 메일 | **Resend에 가입한 그 메일** | Secret `OWNER_EMAIL`(4절) |
| 웹훅 비밀 | 내 PC에서 만든 무작위 값(3절). PowerShell 변수 `$secret`에 담는다 | Secret `WEBHOOK_SECRET`(5절, 명령으로) **그리고** 웹훅 헤더 `x-webhook-secret`(7절). 두 곳이 같아야 한다 |
| 프로젝트 ref | 이미 있다(위) | 명령어와 주소 |

## 체크리스트

- [ ] 1. 준비: 폴더, Node, `$ref`
- [ ] 2. Resend 가입, API 키
- [ ] 3. 웹훅 비밀 만들기
- [ ] 4. Supabase에 Resend 값 두 개 저장
- [ ] 5. 로그인, 웹훅 비밀 올리기, 함수 배포
- [ ] 6. 함수만 따로 시험(메일이 와야 한다)
- [ ] 7. 웹훅 만들기
- [ ] 8. 진짜 건의로 끝 시험
- [ ] 9. 끝낸 뒤(끄기·바꾸기)

## 1. 준비

1. PowerShell을 열고 **함수 파일이 있는 폴더**(저장소 루트)로 간다. `supabase\functions\notify-feedback\index.ts`가 보이면 맞는 폴더다.
   ```powershell
   cd <저장소 루트>
   Test-Path supabase\functions\notify-feedback\index.ts
   ```
   `True`가 나와야 한다. `False`이면 이 코드를 아직 합치지 않은 폴더에 있는 것이다. 코드가 있는 브랜치의 폴더로 간다.
2. Node가 있는지 본다(20 이상).
   ```powershell
   node -v
   ```
3. 프로젝트 ref를 변수에 넣고 `js/config.js`와 같은지 눈으로 확인한다.
   ```powershell
   $ref = 'tvsoacvbjvggqdgnzijc'
   Select-String -Path js\config.js -Pattern 'supabase\.co'
   ```
   두 번째 명령이 `https://tvsoacvbjvggqdgnzijc.supabase.co`가 든 줄을 보여 주면 같은 값이다.

## 2. Resend 가입과 API 키

1. <https://resend.com>에서 가입한다. **알림을 받을 메일 주소로** 가입한다. 보내는 주소로 쓰는 Resend 테스트 주소 `onboarding@resend.dev`는 가입한 메일로만 보낼 수 있기 때문이다. 확인 메일의 링크를 눌러 인증한다.
2. 왼쪽 메뉴 **API Keys → Create API Key**. Name은 `skala-feedback`, Permission은 **Sending access**, 나머지는 기본값으로 만든다.
3. 만들면 `re_…`로 시작하는 값이 화면에 나온다. **다시 볼 수 없으니** 복사해서 4절을 마칠 때까지 메모장에 둔다. 끝나면 메모장을 지운다.

확인: 값이 `re_`로 시작한다.

## 3. 웹훅 비밀 만들기

Database Webhook이 함수를 부를 때 내미는 암호다. 아무도 못 맞히게 무작위로 만들어 변수 `$secret`에 담는다. 값은 화면에 나오지 않는다. 5절·6절·7절이 이 변수를 그대로 쓴다. 손으로 옮겨 적다가 한 글자라도 틀리면 함수가 `forbidden`으로 막기 때문이다.

```powershell
$secret = node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

```powershell
$secret.Length
```

`43`이 나와야 한다. 이 PowerShell 창을 **7절까지 닫지 않는다**(변수는 창과 함께 사라진다). 창을 닫았거나 값을 잃어버렸으면 이 절을 **한 번만** 다시 해서 새 값을 5절 2번으로 올리고 7절 헤더도 바꾼다.

## 4. Supabase에 Resend 값 두 개 저장

Resend에서 받은 값은 대시보드로 넣는다. 웹훅 비밀(`WEBHOOK_SECRET`)은 손으로 옮기지 않도록 5절에서 명령으로 올린다.

1. <https://supabase.com/dashboard/project/tvsoacvbjvggqdgnzijc/functions/secrets>를 연다(왼쪽 메뉴 **Edge Functions → Secrets**).
2. Key와 Value를 넣고 Save한다. 두 번 반복한다(여러 개를 한꺼번에 붙여 넣는 칸이 있으면 써도 된다).

   | Key | Value |
   |---|---|
   | `RESEND_API_KEY` | 2절의 `re_…` 값 |
   | `OWNER_EMAIL` | 2절에서 Resend에 가입한 메일 주소 하나 |

   값에는 따옴표를 붙이지 않는다. 이름이 `SUPABASE_`로 시작하는 비밀은 만들 수 없다(우리는 쓰지 않는다).

확인: 목록에 두 이름이 보인다(값은 가려진다). 함수는 새 비밀을 바로 읽으니 다시 배포할 필요가 없다.

## 5. 로그인, 웹훅 비밀 올리기, 함수 배포

1. 로그인한다.
   ```powershell
   npx supabase login
   ```
   - 처음이면 `Need to install the following packages: supabase@… Ok to proceed? (y)`가 나온다. `y`와 Enter. 내려받는 데 1~2분이 걸린다.
   - 브라우저가 열리면 Supabase에 로그인된 상태로 허용한다. 터미널에 `Finished supabase login.` 비슷한 문구가 나오면 끝이다.
   - 브라우저가 안 열리면 `npx supabase login --no-browser`가 알려 주는 주소를 직접 열거나, <https://supabase.com/dashboard/account/tokens>에서 토큰을 만들어 `Enter your access token:`에 붙여 넣는다.
2. 웹훅 비밀을 올린다. 3절의 `$secret`을 그대로 쓰므로 값을 옮겨 적지 않는다(명령 기록에는 값이 아니라 `$secret`이라는 글자만 남는다). 같은 이름으로 다시 올리면 새 값으로 바뀐다.
   ```powershell
   npx supabase secrets set --project-ref $ref "WEBHOOK_SECRET=$secret"
   ```
   `Finished supabase secrets set.` 비슷한 문구가 나오면 끝이다.
3. 함수를 올린다.
   ```powershell
   npx supabase functions deploy notify-feedback --project-ref $ref --no-verify-jwt --use-api
   ```

   | 부분 | 뜻 |
   |---|---|
   | `--project-ref $ref` | 어느 프로젝트에 올릴지(0절) |
   | `--no-verify-jwt` | 웹훅은 사용자 로그인 증명(JWT)이 없어서 이 검사를 끈다. 대신 함수가 `x-webhook-secret`을 직접 확인한다 |
   | `--use-api` | Docker 없이 Supabase 서버에서 묶어 올린다 |

   `Deployed Functions on project …: notify-feedback`와 비슷한 줄이 나오면 올라간 것이다. 함수를 고치면 같은 명령으로 다시 올린다. 비밀은 그대로 남는다.
4. 올라간 것을 확인한다. 대시보드 **Edge Functions**에 `notify-feedback`이 보이고, 아래 명령에 비밀 이름 세 개(`RESEND_API_KEY`, `OWNER_EMAIL`, `WEBHOOK_SECRET`)가 모두 나와야 한다(값 대신 지문만 나온다).
   ```powershell
   npx supabase secrets list --project-ref $ref
   ```

## 6. 함수만 따로 시험

웹훅을 만들기 전에 함수·Resend·비밀이 맞는지 손으로 한 번 부른다. 가짜 건의 한 건을 보낸다.
**아래 명령을 한 줄씩 따로 붙여 넣고 Enter를 누른다.** 3절과 같은 PowerShell 창에서 한다(`$ref`·`$secret`은 그 창에만 있다).

1. `$ref`에 프로젝트 ref가 들어 있는지 본다. `tvsoacvbjvggqdgnzijc`가 나와야 한다. 비어 있으면 1절 3번을 다시 한다.
   ```powershell
   $ref
   ```
2. 웹훅 비밀 변수에 값이 들어 있는지 본다. `43`이 나와야 한다(값은 화면에 나오지 않는다). 비어 있거나 다르면 창을 새로 연 것이다. 3절과 5절 2번을 다시 한다.
   ```powershell
   $secret.Length
   ```
3. 보낼 내용 `$body`를 만든다(한 줄). 건의 번호는 시험마다 무작위로 정한다. 같은 번호로 24시간 안에 다시 부르면 Resend가 중복으로 보고 메일을 다시 보내지 않기 때문이다.
   ```powershell
   $body = '{"type":"INSERT","schema":"public","table":"fps_feedback","record":{"id":' + (Get-Random -Minimum 900000 -Maximum 999999) + ',"kind":"idea","name":"smoke","body":"notify smoke test"}}'
   ```
4. 함수를 부른다.
   ```powershell
   try { Invoke-RestMethod -Method Post -Uri "https://${ref}.supabase.co/functions/v1/notify-feedback" -Headers @{ 'x-webhook-secret' = $secret } -ContentType 'application/json' -Body $body } catch { $_.Exception.Message; $_.ErrorDetails.Message }
   ```

성공하면 `ok`가 `True`로 나오고, 몇 초 안에 소유자 메일에 `[SKALA 건의 #9xxxxx] 제안 · smoke · notify smoke test`가 온다.

실패하면 두 줄이 나온다. 첫 줄은 상태(`403 (Forbidden)` 같은 것), 둘째 줄은 함수의 답이다. **`"ok":false`가 보이면 `false`가 아니라 그 옆의 `"error"` 단어가 원인이다**(예: `{"ok":false,"error":"forbidden"}`). 보낸 내용이 틀리면 `bad_request`가 나오고, 비밀이 다르면 내용을 보기 전에 `forbidden`으로 막힌다. 나온 단어로 고른다.

| 나온 것 | 원인 | 할 일 |
|---|---|---|
| `401`, `Invalid JWT`·`Missing authorization header` 비슷한 문구 | 함수가 JWT 검사를 켠 채 올라갔다 | 5절 2번을 `--no-verify-jwt`까지 넣어 다시 실행 |
| `403`, `"error":"forbidden"` | `$secret`과 Supabase의 `WEBHOOK_SECRET`이 다르다. 가장 흔한 원인이다(3절을 두 번 해서 값이 둘이다, 예전 값이 Supabase에 남아 있다, 창을 새로 열어 `$secret`이 비었다) | 3절을 **한 번만** 다시 해 새 `$secret`을 만들고, 5절 2번으로 올린 뒤 이 시험의 2번부터 다시 한다 |
| `500`, `"error":"not_configured"` | 비밀이 빠졌거나 모양이 틀렸다(`OWNER_EMAIL`은 주소 하나, `RESEND_API_KEY`는 `re_…`, `WEBHOOK_SECRET`은 24글자 이상) | 4절과 5절 2번을 다시 하고, `npx supabase secrets list --project-ref $ref`로 세 이름이 다 있는지 본다 |
| `400`, `"error":"bad_request"`·`"bad_record"` | 보낸 내용 `$body`가 JSON이 아니거나 `id`·`body`가 없다 | 3번을 다시 실행하고 `$body`를 쳐서 `{"type":"INSERT",…}` 한 줄이 나오는지 본다 |
| `502`, `"error":"resend_rejected"`, `"status":403` | `OWNER_EMAIL`이 Resend 가입 메일이 아니다 | 가입한 메일로 고친다 |
| `502`, `"error":"resend_rejected"`, `"status":401` | Resend 키가 틀렸거나 지워졌다 | 2절에서 새 키를 만들어 `RESEND_API_KEY`를 다시 저장 |
| `502`, `"error":"resend_unreachable"`·`500`, `"error":"internal"` | 함수가 Resend에 닿지 못했거나 함수 안에서 예기치 못한 오류가 났다 | 잠시 뒤 다시 하고, 같으면 대시보드 Edge Functions → `notify-feedback` → Logs를 본다 |
| `ok`가 `True`인데 메일이 없다 | 스팸함에 갔거나 Resend가 늦다 | 스팸함을 본다. Resend 대시보드 **Emails**에서 보낸 기록과 상태를 본다 |

## 7. 웹훅 만들기

1. 대시보드 왼쪽 **Database → Webhooks**를 연다(없으면 **Integrations → Database Webhooks**). 처음이라 "켜기" 단추가 보이면 먼저 켠다. **Create a new hook**을 누른다.
2. PowerShell에서 웹훅 비밀을 클립보드에 복사한다. 화면에는 아무것도 나오지 않는다. 아래 표의 HTTP Headers 값 칸에는 이것을 Ctrl+V로 붙여 넣는다.
   ```powershell
   Set-Clipboard $secret
   ```
3. 아래처럼 채운다.

   | 칸 | 값 |
   |---|---|
   | Name | `fps_feedback_email` |
   | Table | `public.fps_feedback` |
   | Events | **Insert만** 체크(Update·Delete는 끈다) |
   | Type of hook | Supabase Edge Functions |
   | Edge Function | `notify-feedback` |
   | Method | POST |
   | Timeout | 5000 |
   | HTTP Headers | 이름 `x-webhook-secret`, 값은 2번에서 복사한 `$secret`. 미리 들어 있는 `Authorization` 줄은 지워도 된다 |

   `Add secret key` 같은 단추로 프로젝트 비밀 키를 헤더에 넣는 기능이 보여도 누르지 않는다. 우리 함수는 그 키를 쓰지 않고, 전체 권한 키가 웹훅 정의에 남는 것을 피하기 위해서다.
4. 만들기(Confirm) 단추를 누른다. 목록에 `fps_feedback_email`이 보인다.

SQL Editor에서도 확인한다.

```sql
select tgname, tgenabled from pg_trigger where tgname = 'fps_feedback_email';
```

한 줄이 나오고 `tgenabled`가 `O`이면 켜진 것이다.

대시보드 화면이 맞지 않으면 SQL로 만들 수도 있다. `<프로젝트 ref>`는 위의 ref로, `<웹훅 비밀>`은 `Set-Clipboard $secret`으로 복사한 값으로 바꿔 SQL Editor에 붙인다. 비밀이 들어가는 문장이라 저장소·채팅에 남기지 않는다. 웹훅을 대시보드에서 한 번도 켠 적이 없으면 `supabase_functions` 스키마가 없어 오류가 나는데, 그러면 위 1번의 켜기를 먼저 한다.

```sql
create trigger fps_feedback_email after insert on public.fps_feedback
  for each row execute function supabase_functions.http_request(
    'https://<프로젝트 ref>.supabase.co/functions/v1/notify-feedback', 'POST',
    '{"Content-Type":"application/json","x-webhook-secret":"<웹훅 비밀>"}', '{}', '5000');
```

## 8. 진짜 건의로 끝 시험

SQL Editor에서 시험 글을 넣는다. 게임이 건의를 저장하는 것과 같은 INSERT라서 웹훅이 함수를 부른다.

```sql
insert into public.fps_feedback (name, kind, body) values ('알림시험', 'other', '알림 메일 시험입니다');
```

몇 초 안에 `[SKALA 건의 #번호] 기타 · 알림시험 · 알림 메일 시험입니다` 메일이 오면 웹훅 → 함수 → Resend가 모두 이어진 것이다. 호출 기록도 본다.

```sql
select id, status_code, timed_out, error_msg, created from net._http_response order by created desc limit 3;
```

맨 위 줄의 `status_code`가 200이면 성공이다. 확인한 뒤 시험 글을 지운다(웹훅은 Insert만 부르므로 지워도 메일은 오지 않는다).

```sql
delete from public.fps_feedback where name = '알림시험' and body = '알림 메일 시험입니다';
```

첫 메일은 스팸함에 갈 수 있다. Gmail이면 보낸 사람 `onboarding@resend.dev`를 "스팸 아님"으로 하는 필터를 만든다.

6절은 되는데 8절이 안 되면 웹훅 쪽 문제다. 위 호출 기록의 `status_code`·`error_msg`와 대시보드 Edge Functions → `notify-feedback` → Logs를 본다. 헤더 이름 `x-webhook-secret`의 오타와, 값이 `$secret`과 다른 것이 가장 흔하다. 값은 `Set-Clipboard $secret`으로 다시 복사해 붙여 넣는다.

## 9. 끝낸 뒤

- **답하는 법:** 메일 답장으로는 플레이어에게 답할 수 없다. 메일 아래쪽의 SQL을 SQL Editor에서 실행하거나 Table Editor의 `reply` 칸에 적는다([FEEDBACK.md](FEEDBACK.md) 2절).
- **끄기:** 대시보드에서 웹훅 `fps_feedback_email`을 지운다. 또는 `drop trigger fps_feedback_email on public.fps_feedback;`를 실행한다. 함수는 그대로 둬도 된다.
- **받는 메일 바꾸기:** Secret `OWNER_EMAIL`만 고친다(Resend 가입 메일이어야 한다). 다시 배포할 필요가 없다.
- **비밀이 새어 나갔다면:** Resend 키는 Resend에서 지우고 새로 만들어 `RESEND_API_KEY`를 고친다. 웹훅 비밀은 3절을 다시 해 새 `$secret`을 만들고, 5절 2번으로 올린 뒤 웹훅 헤더도 같은 값으로 바꾼다(7절의 `Set-Clipboard $secret`).
- **한도:** Resend 무료는 하루 100통이다. 넘으면 알림만 멈추고 건의 저장은 영향이 없다. 놓친 건은 [FEEDBACK.md](FEEDBACK.md) 2절의 `status = 'new'` 조회로 본다.

## 10. 문제 해결

| 증상 | 원인 | 할 일 |
|---|---|---|
| `npx`가 "스크립트를 실행할 수 없다"(`npx.ps1`)고 한다 | PowerShell이 스크립트 실행을 막고 있다 | 명령의 `npx`를 `npx.cmd`로 바꿔 실행한다(`npx.cmd supabase login`). 또는 `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` |
| `node`·`npx`를 찾을 수 없다 | Node가 없거나 터미널이 설치 전에 열렸다 | <https://nodejs.org>의 LTS를 설치하고 PowerShell을 새로 연다 |
| `npx supabase`가 한참 멈춰 있다 | 처음에는 실행 파일을 내려받는다 | 1~2분 기다린다 |
| 배포가 로그인을 요구한다(`Access token not provided` 등) | 5절 1번을 안 했거나 만료됐다 | `npx supabase login`을 다시 한다 |
| 배포가 함수·`index.ts`를 못 찾는다 | 폴더가 틀렸다 | 1절 1번의 `Test-Path`가 `True`인 폴더에서 실행한다 |
| 배포가 `config.toml` 오류를 낸다 | CLI 버전이 설정 형식을 다르게 읽는다 | `supabase\config.toml`을 잠시 다른 곳으로 옮기고 같은 명령을 다시 실행한다. 함수 동작은 같다 |
| 배포가 Docker를 찾는다는 메시지를 낸다 | `--use-api`가 빠졌다 | 명령에 `--use-api`를 넣는다 |
| 변수 `$ref`가 비어 있다는 오류, 또는 `$secret.Length`가 `43`이 아니다 | PowerShell 창을 새로 열었다(변수는 창마다 따로 있다) | `$ref`는 1절 3번의 `$ref = '…'` 줄을, `$secret`은 3절과 5절 2번을 다시 실행한다 |
| 메일이 오다가 어느 날부터 안 온다 | Resend 하루 100통을 넘겼거나 키가 지워졌다 | Resend 대시보드 **Emails**·**API Keys**를 본다. 로그는 대시보드 Edge Functions → `notify-feedback` → Logs |

그 밖의 오류는 [FEEDBACK.md](FEEDBACK.md) 7.4의 표를 본다.

## 확인한 문서 (2026-11-17)

- Edge Function 배포(`login`, `functions deploy`, Docker가 없으면 API 방식으로 자동 전환, `--use-api`): <https://supabase.com/docs/guides/functions/quickstart>
- Edge Function 비밀(대시보드 Secrets, 바로 반영, `SUPABASE_` 접두사 예약): <https://supabase.com/docs/guides/functions/secrets>
- `supabase login` 옵션(`--no-browser`, `--token`): <https://supabase.com/docs/reference/cli/supabase-login>
- Database Webhooks(INSERT, Edge Function 형식): <https://supabase.com/docs/guides/database/webhooks>
- Resend 무료 한도와 테스트 주소 제한은 [FEEDBACK.md](FEEDBACK.md) 7절 끝의 목록과 같다.
- 화면 이름(Resend의 API Keys, Supabase의 Webhooks 위치)은 공식 문서에 자세히 없어 일반적인 이름으로 적었다. 다르면 같은 뜻의 메뉴를 찾는다.
