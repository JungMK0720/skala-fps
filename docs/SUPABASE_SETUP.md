# Supabase 설정 안내

Supabase 프로젝트를 게임에 연결하는 절차입니다.

> **현재 운영 상태:** 프로젝트 `skala-fps`(서울 `ap-northeast-2`)에 연결되어 있습니다. 이 프로젝트는 무료 한도 때문에 퀴즈 사이트 `domain-study-port`와 같이 씁니다. FPS의 테이블과 함수는 모두 `fps_`로 시작하고, 멀티 채널도 `skalafps:`로 분리되어 있어 서로 섞이지 않습니다. 옛 프로젝트 `skala-domain-study`(프랑크푸르트)는 일시정지한 백업입니다. Supabase는 만든 뒤 리전을 바꿀 수 없어서 리전을 옮기려면 새 프로젝트로 이전해야 합니다.
대시보드 메뉴 이름과 한도는 2026-11-06에 Supabase 공식 문서로 확인했습니다(맨 아래 [확인한 문서](#확인한-문서)). 화면은 바뀔 수 있으니 이름이 조금 달라도 당황하지 마세요.

연결하면 멀티플레이, 전역 닉네임 중복 검사, 프로필 서버 저장이 켜집니다. 연결하지 않아도 연습장은 오프라인으로 정상 동작합니다.

## 1. 프로젝트 만들기

1. <https://supabase.com/dashboard>에서 **새 프로젝트**를 만듭니다. 다른 서비스의 프로젝트를 다시 쓰지 말고 이 게임 전용으로 만드세요.
2. 항목을 채웁니다.
   - **Name**: 자유롭게 정합니다. 예: `skala-fps`
   - **Database Password**: 긴 무작위 값으로 정하고 비밀번호 관리자에 보관합니다. 게임은 이 비밀번호를 쓰지 않으므로 저장소에 넣을 일이 없습니다.
   - **Region**: `Northeast Asia (Seoul)` (`ap-northeast-2`)를 권장합니다. 플레이어가 대부분 국내라면 지연 시간이 가장 짧습니다.
   - **Automatically expose new tables** 체크박스: 어느 쪽이든 괜찮습니다. `schema.sql`이 필요한 함수 실행 권한을 직접 부여하고, 테이블은 일부러 노출하지 않습니다.

## 2. 스키마 실행

1. 왼쪽 메뉴에서 **SQL Editor**를 열고 새 쿼리를 만듭니다.
2. 저장소의 `supabase/schema.sql` 내용을 **전부** 붙여 넣고 실행합니다.
3. 오류 없이 끝나면 **Table Editor**에 `fps_players` 테이블이 보입니다.

여러 번 실행해도 안전합니다. 테이블과 데이터는 그대로 두고 함수만 다시 만듭니다.

만들어지는 것은 다음과 같습니다.

| 종류 | 이름 | 하는 일 |
|---|---|---|
| 테이블 | `fps_players` | 프로필 저장. API로 직접 읽고 쓸 수 없음 |
| RPC | `fps_check_nickname` | 닉네임 형식과 중복 검사 |
| RPC | `fps_claim_nickname` | 닉네임 등록과 변경 |
| RPC | `fps_get_profile` | 내 프로필 읽기 |
| RPC | `fps_save_profile` | 내 프로필 저장 |
| RPC | `fps_top_players` | 순위표(이름, 킬, 승리, 포인트만) |

멀티 채널(`skalafps:lobby`, `skalafps:room:<id>`)은 테이블이 필요 없습니다.

## 3. Project URL과 Publishable key 찾기

프로젝트 화면의 **Connect** 대화상자에 둘 다 나옵니다.

- **Project URL**: `https://<project-ref>.supabase.co`
- **Publishable key**: `sb_publishable_...`

키 전체 목록은 **Settings > API Keys**에 있습니다. 그 화면에 **Create new API keys** 버튼이 보이면 아직 예전 키만 있는 프로젝트입니다. 눌러서 만들어도 안전합니다.

> 예전 `anon` key도 동작하지만 Supabase가 2026년 말까지 단계적으로 없앤다고 안내하고 있으니 Publishable key를 쓰세요.

## 4. `js/config.js`에 넣기

```js
window.SKALA_CONFIG = {
  supabase: {
    url: 'https://<project-ref>.supabase.co',
    anonKey: 'sb_publishable_...'
  }
};
```

칸 이름은 `anonKey`지만 Publishable key를 넣으면 됩니다. 이 파일은 커밋해도 됩니다. Publishable key는 브라우저에 공개하도록 만들어진 키입니다.

## 5. Realtime 공개 채널 확인

멀티플레이는 Realtime의 공개 채널을 씁니다. `https://supabase.com/dashboard/project/<project-ref>/realtime/settings`(Realtime의 Settings)에서 다음 두 항목이 켜져 있는지 봅니다. 둘 다 기본값이 켜짐입니다.

- **Enable Realtime service**
- **Allow public access to channels** (문서에 따라 **Allow public access**로도 적혀 있습니다)

켜져 있으면 저장할 필요가 없습니다. 이 화면에서 설정을 저장하면 접속 중인 클라이언트가 모두 끊깁니다.

## 6. GitHub Pages

CORS 설정이나 도메인 등록은 필요 없습니다. Supabase의 자체 호스팅용 게이트웨이 문서는 모든 Origin을 허용하는 정책이 현재 플랫폼 동작과 같다고 명시하고, 인증 경계는 요청 Origin이 아니라 `apikey` 헤더라고 밝힙니다. Supabase Collaborator도 호스팅 프로젝트에는 Data API용 CORS 설정이 없고 모든 도메인이 허용된다고 답했습니다.

다시 말해 Publishable key는 어느 사이트에서나 쓸 수 있습니다. 그래서 테이블 권한을 막고 RPC만 열어 두었습니다. 실제로 되는지는 아래 7단계를 배포한 페이지에서 실행해 확인합니다.

## 7. 동작 확인

배포한 페이지나 로컬 서버(`npm run serve` 후 <http://localhost:8080/>)에서 진행합니다.

**RPC 호출.** F12 콘솔에 붙여 넣습니다.

```js
const c = SKALA_CONFIG.supabase; await (await fetch(`${c.url}/rest/v1/rpc/fps_check_nickname`, { method: 'POST', headers: { apikey: c.anonKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_name: '테스트' }) })).json()
```

`{ ok: true, name: '테스트' }`가 나오면 성공입니다. 누가 이미 쓰는 이름이면 `{ ok: false, error: 'NAME_TAKEN' }`이 나오는데, 이것도 연결은 정상이라는 뜻입니다. `p_name`을 `'admin'`으로 바꾸면 `NAME_RESERVED`가 나와야 합니다.

**테이블 차단.** 이어서 실행합니다. `200`이 **아니어야** 정상입니다. `200`이 나오면 2단계를 다시 실행하세요.

```js
(await fetch(`${c.url}/rest/v1/fps_players?select=*`, { headers: { apikey: c.anonKey } })).status
```

**로비.** 같은 브라우저에서 탭을 두 개 열고 양쪽 모두 멀티로 들어갑니다. 한쪽에서 방을 만들면 다른 쪽 로비에 나타나야 합니다. 프로필을 함께 쓰므로 두 탭의 닉네임이 같은 것은 정상이며, 게임은 탭마다 다른 플레이어로 처리합니다.

**닉네임 중복.** 시크릿 창에서 이미 쓰고 있는 닉네임을 입력하면 "이미 사용 중"이라고 나와야 합니다.

### 문제 해결

| 증상 | 원인과 조치 |
|---|---|
| HTTP 404, 코드 `PGRST202` | 함수를 찾지 못했습니다. 2단계를 다시 실행하세요. `schema.sql`의 마지막 줄이 API의 스키마 캐시를 다시 읽게 합니다. |
| HTTP 401 | 키가 틀렸거나 비어 있습니다. secret key를 넣어도 브라우저에서는 401이 납니다. 3단계의 Publishable key를 넣으세요. |
| `Failed to fetch` 또는 응답 없음 | URL 오타이거나 프로젝트가 일시 중지되었습니다(8단계). Data API를 껐다면 대시보드의 Data API 화면에서 **Enable Data API**를 켜세요. |
| 게임 안에서 "오프라인이라 중복 확인을 못 했어요" | 위 원인 중 하나로 서버에 닿지 못한 상태입니다. 콘솔의 `[account] Supabase RPC ... 실패` 경고에 HTTP 상태가 나옵니다. 게임은 계속되고 나중에 다시 등록합니다. |
| 로비가 비어 있거나 연결이 안 됨 | 5단계의 두 항목과 `js/config.js`의 값을 확인하세요. |

## 8. Free 플랜 한도

| 항목 | 한도 |
|---|---|
| 활성 프로젝트 | 2개 |
| 데이터베이스 | 프로젝트당 500 MB |
| Egress | 5 GB, 캐시된 Egress 5 GB 별도 |
| Realtime 동시 접속 | 200 |
| Realtime 메시지 | 월 200만 건, 초당 100건 |
| Realtime 채널 참가 | 초당 100회 |
| 연결당 채널 | 100개 |
| Presence 메시지 | 초당 20건 |
| Presence 객체당 키 | 10개 |
| Broadcast 메시지 크기 | 256 KB |

- **일시 중지**: Free 프로젝트는 1주일 동안 활동이 없으면 일시 중지됩니다. 그동안 게임은 오프라인으로 동작합니다. 시연이나 대회 전에 대시보드에서 프로젝트가 켜져 있는지 확인하세요.
- **Realtime 연결 시간**: 사용자 로그인 없이 키로 연결한 공개 Realtime 연결은 최대 24시간입니다. 끊기면 게임이 자동으로 다시 연결합니다.

## 9. 보안

- **`service_role` key, secret key(`sb_secret_...`), 데이터베이스 비밀번호는 절대 저장소나 `js/config.js`에 넣지 마세요.** `service_role` key와 secret key는 행 수준 보안을 건너뜁니다. 게임에는 필요 없는 키이며, 실수로 올렸다면 **Settings > API Keys**에서 바로 교체하세요.
- **Security Advisor 경고**: **Advisors > Security Advisor**에 아래 항목이 보이는 것은 의도한 결과입니다.
  - `0008_rls_enabled_no_policy`(INFO): 정책을 일부러 만들지 않았습니다. 테이블은 API로 직접 접근할 수 없습니다.
  - `0028_anon_security_definer_function_executable`, `0029_authenticated_security_definer_function_executable`(WARN): `fps_*` RPC 다섯 개가 대상입니다. 게임이 로그인 없이 부르는 유일한 통로이고, 각 함수가 입력을 검사합니다.
- **포인트와 전적은 치트를 막지 못합니다.** 브라우저가 계산해 보낸 값을 범위만 확인해 저장합니다. 순위표는 재미용으로 보세요.
- **RPC에는 속도 제한이 없습니다.** 마음먹으면 닉네임을 대량으로 선점할 수 있습니다. 문제가 생기면 10단계의 SQL로 정리하세요.
- **계정은 기기 토큰입니다.** 브라우저 저장소의 `skalafps.token`이 곧 소유 증명이고, 서버에는 sha256만 저장합니다. 사이트 데이터를 지우면 토큰이 사라져 이전 닉네임을 되찾을 수 없습니다. 이때는 아래처럼 운영자가 풀어 줄 수 있습니다.

## 10. 운영에 쓰는 SQL

SQL Editor에서 실행합니다.

```sql
-- 순위표 보기
select public.fps_top_players(20);

-- 닉네임 풀어 주기. 행을 지우므로 그 플레이어의 서버 포인트와 전적도 함께 사라진다
delete from public.fps_players where name_key = lower('닉네임');

-- 오래 쉰 플레이어 정리
delete from public.fps_players where updated_at < now() - interval '180 days';
```

토큰이 남아 있는 플레이어의 행을 지우면 다음 접속 때 게임이 브라우저의 프로필로 다시 등록합니다. 그 사이 다른 사람이 같은 이름을 가져갔다면 새 닉네임을 묻습니다.

## 확인한 문서

- [API 키 문서](https://supabase.com/docs/guides/api/api-keys): Publishable key와 secret key, Connect 대화상자, Settings > API Keys, `apikey` 헤더 규칙, 공개 Realtime 연결 24시간, 예전 키의 단계적 폐지
- [Realtime 설정 문서](https://supabase.com/docs/guides/realtime/settings), [Realtime 권한 문서](https://supabase.com/docs/guides/realtime/authorization): 설정 이름과 기본값, 경로
- [Realtime 프로토콜 문서](https://supabase.com/docs/guides/realtime/protocol): WebSocket 주소의 `apikey`, 생략 가능한 `access_token`
- [자체 호스팅 게이트웨이 문서](https://supabase.com/docs/guides/self-hosting/self-hosted-envoy): 모든 Origin 허용이 플랫폼 동작과 같다는 설명, `apikey`가 인증 경계라는 설명
- [GitHub Discussions #36375](https://github.com/orgs/supabase/discussions/36375): Data API용 CORS 설정이 없다는 Supabase Collaborator의 답변(2025-06)
- [리전 문서](https://supabase.com/docs/guides/platform/regions): 서울 리전 이름
- [새 테이블 자동 노출 변경 공지](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically), [API 보안 문서](https://supabase.com/docs/guides/api/securing-your-api), [Data API 강화 문서](https://supabase.com/docs/guides/api/hardening-data-api): 새 프로젝트의 노출 기본값, 함수 실행 권한, Enable Data API
- [Realtime 한도 문서](https://supabase.com/docs/guides/realtime/limits), [요금 안내](https://supabase.com/pricing): Free 플랜 한도와 일시 중지
- [데이터베이스 린트 문서](https://supabase.com/docs/guides/database/database-linter): Security Advisor 항목
- [PostgREST 오류 문서](https://docs.postgrest.org/en/stable/references/errors.html): `PGRST202`
