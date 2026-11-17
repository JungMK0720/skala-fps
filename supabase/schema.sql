-- Date: 06NOV2026
-- Author: Minkyu Jung
-- Purpose: SKALA 작전 전용 Supabase 프로젝트의 계정 스키마. SQL Editor에서 처음부터 끝까지 실행하며, 여러 번 실행해도 안전하다.
--          테이블은 직접 접근을 막고 fps_* RPC(SECURITY DEFINER)로만 쓴다. 기기 토큰은 원문 대신 sha256만 저장한다.
--          닉네임 규칙은 js/account/nickname.js와 글자 단위로 같아야 한다(tests/account.test.mjs가 대조한다).
--          포인트와 전적은 클라이언트가 계산해 보내지만, 서버가 늘어나는 속도(통으로 채우는 한도)와 새로 산 무기의 가격을 확인해
--          한도를 넘는 만큼은 버린다. 닉네임 등록은 같은 IP에서 한 시간에 60번까지다. 경기 판정은 방장 브라우저가 한다(js/game/anticheat.js).
--          멀티 채널(skalafps:lobby, skalafps:room:<id>)은 Realtime Broadcast·Presence만 쓰므로 테이블이 필요 없다.
--          건의함(fps_feedback)은 등록된 닉네임만 fps_send_feedback으로 보내고, 읽는 사람은 소유자뿐이다: 대시보드, 또는 관리자 표(fps_admins)에
--          등록한 소유자 계정으로 로그인한 받은편지함 화면(dev/inbox.html). 플레이어(anon)에게는 이 표의 권한을 주지 않는다(docs/FEEDBACK.md).
--          로그인 연결·테스트 결제(fps_tokens·fps_identities·fps_orders·fps_coin_ledger)는 fps_api_* 함수로만 바뀐다. 이 함수는
--          server/api Worker가 Supabase 비밀 키로만 부르고 브라우저(공개 키)는 부를 수 없다(server/api/README.md).

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- ───────────── 테이블 ─────────────
-- 토큰 하나에 한 행. 이름을 바꾸면 같은 행의 name_key가 바뀌므로 이전 이름은 저절로 풀린다.
create table if not exists public.fps_players (
  id bigint generated always as identity primary key,
  token_hash text not null unique,
  name text not null check (char_length(name) between 2 and 12),
  name_key text not null unique,
  points int not null default 500 check (points between 0 and 10000000),
  owned jsonb not null default '[]'::jsonb check (jsonb_typeof(owned) = 'array'),
  loadout jsonb not null default '{}'::jsonb check (jsonb_typeof(loadout) = 'object'),
  stats jsonb not null default '{}'::jsonb check (jsonb_typeof(stats) = 'object'),
  secrets jsonb not null default '{}'::jsonb check (jsonb_typeof(secrets) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (name_key = lower(name))
);

-- 정책을 만들지 않는다. RLS를 켠 채 권한까지 없애 API로는 행을 직접 읽거나 쓸 수 없다.
alter table public.fps_players enable row level security;
revoke all on public.fps_players from public, anon, authenticated;
revoke all on sequence public.fps_players_id_seq from public, anon, authenticated;

-- 치트 대비(2026-11-08): 늘어나는 양을 제한하는 통. 처음 실행하면 기존 행에도 기본값이 채워진다.
alter table public.fps_players add column if not exists earn_bucket double precision not null default 5000;   -- 지금 더 벌 수 있는 포인트
alter table public.fps_players add column if not exists kill_bucket double precision not null default 300;    -- 지금 더 올릴 수 있는 킬
alter table public.fps_players add column if not exists win_bucket double precision not null default 10;      -- 지금 더 올릴 수 있는 승리
alter table public.fps_players add column if not exists bucket_at timestamptz not null default now();         -- 통을 마지막으로 채운 시각
alter table public.fps_players add column if not exists day_key date not null default current_date;           -- 하루 한도의 날짜
alter table public.fps_players add column if not exists day_gain int not null default 0;                      -- 그날 번 포인트

-- 같은 IP에서 온 요청 수. IP 원문은 저장하지 않고 해시만 쓴다. 줄은 지우지 않고 창이 지나면 다시 센다.
create table if not exists public.fps_rate (
  bucket text primary key,
  window_start timestamptz not null default now(),
  hits int not null default 0
);
alter table public.fps_rate enable row level security;
revoke all on public.fps_rate from public, anon, authenticated;

-- 로그인으로 더한 기기 토큰(2026-11-16). 구글·카카오로 로그인한 기기는 새 토큰을 여기 받아 같은 행을 쓴다.
-- 처음 닉네임을 등록한 기기의 토큰은 그대로 fps_players.token_hash에 있다. 로그아웃한 토큰은 지우지 않고 revoked_at을 찍는다.
create table if not exists public.fps_tokens (
  token_hash text primary key,
  player_id bigint not null references public.fps_players(id) on delete cascade,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index if not exists fps_tokens_player_idx on public.fps_tokens (player_id, created_at desc);
alter table public.fps_tokens enable row level security;
revoke all on public.fps_tokens from public, anon, authenticated;

-- ───────────── 내부 함수 (외부 호출 불가) ─────────────
-- 공백 목록을 직접 적어 Postgres 로캘과 상관없이 JS의 \s와 같게 동작시킨다. 안 보이는 글자는 정규식의 \u로 적어 붙여 넣기에 망가지지 않게 한다.
create or replace function public.fps_clean_name(p_name text) returns text
language sql immutable set search_path = public, extensions as $$
  select btrim(regexp_replace(coalesce(p_name, ''), '[\f\n\r\t\v \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+', ' ', 'g'), ' ')
$$;

-- 통과하면 null, 아니면 오류 코드. 검사 순서도 nickname.js와 같다.
create or replace function public.fps_name_error(p_name text) returns text
language sql immutable set search_path = public, extensions as $$
  select case
    when char_length(s.clean) not between 2 and 12 then 'NAME_INVALID'
    when s.clean !~ '^[0-9A-Za-zㄱ-ㅎㅏ-ㅣ가-힣 _-]+$' then 'NAME_INVALID'
    when lower(s.clean) in ('admin', '관리자', '운영자', 'system', 'gm', 'null', 'undefined') then 'NAME_RESERVED'
    when right(s.clean, 2) = ' 봇' then 'NAME_RESERVED'
    else null
  end
  from (select public.fps_clean_name(p_name) as clean) s
$$;

-- 형식이 맞는 토큰(256비트 hex)이면 sha256, 아니면 null.
create or replace function public.fps_token_hash(p_token text) returns text
language sql immutable set search_path = public, extensions as $$
  select case when p_token ~ '^[0-9a-f]{64}$' then encode(digest(p_token, 'sha256'), 'hex') end
$$;

-- 토큰 해시 → 행 id. 처음 기기 토큰(fps_players)과 로그인으로 더한 기기 토큰(fps_tokens, 로그아웃하지 않은 것)을 함께 본다. 없으면 null.
create or replace function public.fps_player_id(p_hash text) returns bigint
language sql stable set search_path = public, extensions as $$
  select coalesce(
    (select p.id from public.fps_players p where p.token_hash = p_hash),
    (select t.player_id from public.fps_tokens t where t.token_hash = p_hash and t.revoked_at is null))
$$;

-- 짧은 문자열로만 이루어진 JSON 배열인가. 배열이 아니면 길이 함수가 오류를 내므로 단계를 나눈다.
create or replace function public.fps_owned_ok(p_owned jsonb) returns boolean
language plpgsql immutable set search_path = public, extensions as $$
begin
  if jsonb_typeof(p_owned) is distinct from 'array' then return false; end if;
  if jsonb_array_length(p_owned) > 64 then return false; end if;
  return not exists (
    select 1 from jsonb_array_elements(p_owned) as e(item)
    where jsonb_typeof(e.item) <> 'string' or char_length(e.item #>> '{}') > 32
  );
end $$;

-- 서버 가격표. js/weapons/defs.js(무기), js/core/consts.js EMOTES(이모트), js/core/avatar-defs.js AVATARS(캐릭터)의 price와 같아야 한다
-- (tests/account.test.mjs가 대조한다). 모르는 id는 null이라 살 수 없다.
create or replace function public.fps_item_price(p_id text) returns int
language sql immutable set search_path = public, extensions as $$
  select case p_id
    when 'ar_std' then 0 when 'ar_rapid' then 800 when 'ar_line' then 1200 when 'ar_burst' then 1000 when 'dm_mark' then 1500
    when 'sm_vx3' then 600 when 'sg_bx12' then 700
    when 'sg_pump' then 900 when 'sg_double' then 1000 when 'sg_auto' then 1500
    when 'sm_uzi_dual' then 1100 when 'mg_minigun' then 2800
    when 'sr_bolt' then 0 when 'sr_twin' then 1500 when 'sr_swift' then 1000 when 'sr_heavy' then 2500
    when 'pt_std' then 0 when 'pt_magnum' then 500
    when 'ml_knife' then 0 when 'ml_tanto' then 500 when 'ml_gurkha' then 800 when 'ml_katana' then 1200
    when 'gr_frag' then 0
    when 'takeL' then 0 when 'veggie' then 0 when 'sideToSide' then 0 when 'crissCross' then 0 when 'tango' then 0
    when 'salute' then 0 when 'wave' then 0 when 'cheer' then 0 when 'creamCheese' then 0
    when 'fromYou' then 600 when 'selfie' then 400
    when 'av_trooper' then 0 when 'av_scout' then 300 when 'av_sapper' then 600 when 'av_signal' then 800
    when 'av_ranger' then 1000 when 'av_night' then 1400 when 'av_heavy' then 2000
  end
$$;

-- 요청을 보낸 IP의 해시. Supabase API 게이트웨이가 넣는 헤더를 읽고 원문은 남기지 않는다. SQL Editor처럼 헤더가 없으면 'unknown'.
create or replace function public.fps_client_key() returns text
language sql stable set search_path = public, extensions as $$
  select encode(digest(coalesce(
    nullif(btrim(split_part(coalesce(nullif(current_setting('request.headers', true), '')::json ->> 'x-forwarded-for', ''), ',', 1)), ''),
    nullif(nullif(current_setting('request.headers', true), '')::json ->> 'cf-connecting-ip', ''),
    'unknown') || ':skala-fps', 'sha256'), 'hex')
$$;

-- 한도 안이면 한 번 세고 true. 창(p_window)이 지나면 1부터 다시 센다.
create or replace function public.fps_rate_ok(p_action text, p_limit int, p_window interval) returns boolean
language plpgsql volatile set search_path = public, extensions as $$
declare
  v_hits int;
begin
  insert into public.fps_rate as r (bucket, window_start, hits)
  values (p_action || ':' || public.fps_client_key(), now(), 1)
  on conflict (bucket) do update
    set hits = case when r.window_start < now() - p_window then 1 else r.hits + 1 end,
        window_start = case when r.window_start < now() - p_window then now() else r.window_start end
  returning hits into v_hits;
  return v_hits <= p_limit;
end $$;

-- ───────────── 사용자 함수 (RPC) ─────────────
-- 결과 모양: { ok: true, ... } 또는 { ok: false, error: 코드 }
-- 코드: NAME_INVALID, NAME_RESERVED, NAME_TAKEN, TOKEN_INVALID, NOT_FOUND, PROFILE_INVALID, PROFILE_TOO_LARGE, RATE_LIMITED

create or replace function public.fps_check_nickname(p_name text) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare
  v_name text := public.fps_clean_name(p_name);
  v_err text := public.fps_name_error(p_name);
begin
  if v_err is not null then return jsonb_build_object('ok', false, 'error', v_err); end if;
  if exists (select 1 from public.fps_players where name_key = lower(v_name)) then
    return jsonb_build_object('ok', false, 'error', 'NAME_TAKEN');
  end if;
  return jsonb_build_object('ok', true, 'name', v_name);
end $$;

-- 동시에 같은 이름을 잡으면 name_key 유일 제약이 한쪽을 막고, 그 쪽은 NAME_TAKEN을 받는다.
-- 이미 행이 있는 토큰(로그인으로 더한 기기 토큰 포함)이면 그 행의 이름만 바꾼다.
create or replace function public.fps_claim_nickname(p_token text, p_name text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_hash text := public.fps_token_hash(p_token);
  v_name text := public.fps_clean_name(p_name);
  v_err text := public.fps_name_error(p_name);
  v_id bigint;
begin
  if v_hash is null then return jsonb_build_object('ok', false, 'error', 'TOKEN_INVALID'); end if;
  if v_err is not null then return jsonb_build_object('ok', false, 'error', v_err); end if;
  -- 같은 IP에서 한 시간에 60번까지(교실처럼 여러 명이 한 IP를 써도 넉넉하게). 넘으면 잠시 뒤 다시 시도하게 한다
  if not public.fps_rate_ok('claim', 60, interval '1 hour') then
    return jsonb_build_object('ok', false, 'error', 'RATE_LIMITED');
  end if;
  v_id := public.fps_player_id(v_hash);
  begin
    if v_id is not null then
      update public.fps_players set name = v_name, name_key = lower(v_name), updated_at = now() where id = v_id;
    else
      insert into public.fps_players (token_hash, name, name_key)
      values (v_hash, v_name, lower(v_name))
      on conflict (token_hash) do update
        set name = excluded.name, name_key = excluded.name_key, updated_at = now();
    end if;
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'error', 'NAME_TAKEN');
  end;
  return jsonb_build_object('ok', true, 'name', v_name);
end $$;

create or replace function public.fps_get_profile(p_token text) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare
  v_hash text := public.fps_token_hash(p_token);
  v public.fps_players%rowtype;
begin
  if v_hash is null then return jsonb_build_object('ok', false, 'error', 'TOKEN_INVALID'); end if;
  select * into v from public.fps_players where id = public.fps_player_id(v_hash);
  if not found then return jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); end if;
  return jsonb_build_object('ok', true, 'profile', jsonb_build_object(
    'name', v.name,
    'points', v.points,
    'owned', v.owned,
    'loadout', v.loadout,
    'stats', v.stats,
    'secrets', v.secrets,
    'createdAt', (extract(epoch from v.created_at) * 1000)::bigint
  ));
end $$;

-- 행은 fps_claim_nickname이 만든다. 행이 없으면 NOT_FOUND. 이름은 여기서 바꾸지 않는다.
-- 클라이언트가 보낸 포인트·무기·전적을 그대로 믿지 않는다.
--   새 무기는 서버 가격표(fps_item_price)로 값을 매기고 모르는 id는 버린다. 가진 무기는 저장으로 줄지 않는다.
--   포인트가 늘어나는 양은 통(1초에 5점, 최대 5,000점)과 하루 50,000점으로 제한하고 넘는 만큼은 버린다.
--   살 돈이 모자라면 새 무기를 받지 않고 그 값도 쓰지 않은 것으로 본다.
--   킬은 1초에 1번(최대 300), 승리는 30초에 1번(최대 10)씩 차는 통으로, 다른 전적은 한 번에 1,000까지만 늘린다.
--   stats는 숫자 항목만 남기고 0~10억으로 자른다. fps_top_players가 숫자로 읽으므로 잘못된 값이 순위표를 깨뜨리지 못한다.
--   장착한 캐릭터(loadout.avatar)는 가격표에 있는 'av_' 캐릭터이고 기본(가격 0)이거나 가진 것이어야 한다. 아니면 기본 캐릭터 av_trooper로 저장한다.
--   결과에 서버가 저장한 포인트·무기·전적을 돌려준다(clamped면 깎였다). 클라이언트는 이 값을 따른다.
create or replace function public.fps_save_profile(
  p_token text, p_points int, p_owned jsonb, p_loadout jsonb, p_stats jsonb, p_secrets jsonb)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  v_hash text := public.fps_token_hash(p_token);
  v public.fps_players%rowtype;
  v_secs double precision;
  v_earn_bucket double precision;
  v_kill_bucket double precision;
  v_win_bucket double precision;
  v_day int;
  v_item text;
  v_price int;
  v_new jsonb := '[]'::jsonb;
  v_spent int := 0;
  v_allow int;
  v_want bigint;
  v_earn int;
  v_points bigint;
  v_stats jsonb := '{}'::jsonb;
  v_key text;
  v_val numeric;
  v_old numeric;
  v_room numeric;
  v_clamped boolean := false;
  v_loadout jsonb := p_loadout;
  v_avatar text;
begin
  if v_hash is null then return jsonb_build_object('ok', false, 'error', 'TOKEN_INVALID'); end if;
  if not public.fps_owned_ok(p_owned)
     or jsonb_typeof(p_loadout) is distinct from 'object'
     or jsonb_typeof(p_stats) is distinct from 'object'
     or jsonb_typeof(p_secrets) is distinct from 'object' then
    return jsonb_build_object('ok', false, 'error', 'PROFILE_INVALID');
  end if;
  if octet_length(p_loadout::text) > 512
     or octet_length(p_stats::text) > 2048
     or octet_length(p_secrets::text) > 32768 then
    return jsonb_build_object('ok', false, 'error', 'PROFILE_TOO_LARGE');
  end if;
  select * into v from public.fps_players where id = public.fps_player_id(v_hash) for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); end if;

  -- 통 채우기: 마지막으로 채운 뒤 지난 시간만큼
  v_secs := greatest(0, extract(epoch from (now() - v.bucket_at)));
  v_earn_bucket := least(5000, v.earn_bucket + v_secs * 5);
  v_kill_bucket := least(300, v.kill_bucket + v_secs);
  v_win_bucket := least(10, v.win_bucket + v_secs / 30);
  v_day := case when v.day_key = current_date then v.day_gain else 0 end;

  -- 새로 산 무기
  for v_item in select distinct e.item #>> '{}' from jsonb_array_elements(p_owned) as e(item) loop
    if v.owned ? v_item then continue; end if;
    v_price := public.fps_item_price(v_item);
    if v_price is null then v_clamped := true; continue; end if;
    v_new := v_new || to_jsonb(v_item);
    v_spent := v_spent + v_price;
  end loop;

  -- 포인트: 클라이언트가 주장하는 순수익 = 보낸 포인트 - 저장된 포인트 + 산 값
  v_allow := greatest(0, least(floor(v_earn_bucket), 50000 - v_day))::int;
  v_want := coalesce(p_points, v.points)::bigint - v.points + v_spent;
  v_earn := least(v_want, v_allow)::int;
  if v_want > v_allow then v_clamped := true; end if;
  v_points := v.points::bigint + v_earn - v_spent;
  if v_points < 0 then
    v_new := '[]'::jsonb;
    v_spent := 0;
    v_clamped := true;
    v_points := v.points::bigint + v_earn;
  end if;
  v_points := least(greatest(v_points, 0), 10000000);

  -- 장착한 캐릭터. 칸이 없는 옛 클라이언트의 장비는 그대로 둔다
  if v_loadout ? 'avatar' then
    v_avatar := case when jsonb_typeof(v_loadout -> 'avatar') = 'string' then v_loadout ->> 'avatar' end;
    if v_avatar is null or left(v_avatar, 3) <> 'av_' or public.fps_item_price(v_avatar) is null
       or (public.fps_item_price(v_avatar) > 0 and not ((v.owned || v_new) ? v_avatar)) then
      v_loadout := v_loadout || jsonb_build_object('avatar', 'av_trooper');
      v_clamped := true;
    end if;
  end if;

  -- 전적
  for v_key, v_val in
    select s.key, trunc((s.value #>> '{}')::numeric) from jsonb_each(p_stats) as s where jsonb_typeof(s.value) = 'number'
  loop
    v_val := least(greatest(v_val, 0), 1000000000);
    v_old := case when jsonb_typeof(v.stats -> v_key) = 'number' then (v.stats ->> v_key)::numeric else 0 end;
    v_room := case v_key when 'kills' then floor(v_kill_bucket) when 'wins' then floor(v_win_bucket) else 1000 end;
    if v_val - v_old > v_room then
      v_val := v_old + v_room;
      v_clamped := true;
    end if;
    if v_key = 'kills' and v_val > v_old then v_kill_bucket := v_kill_bucket - (v_val - v_old); end if;
    if v_key = 'wins' and v_val > v_old then v_win_bucket := v_win_bucket - (v_val - v_old); end if;
    v_stats := v_stats || jsonb_build_object(v_key, v_val);
  end loop;

  update public.fps_players
     set points = v_points,
         owned = v.owned || v_new,
         loadout = v_loadout,
         stats = v_stats,
         secrets = p_secrets,
         earn_bucket = v_earn_bucket - greatest(v_earn, 0),
         kill_bucket = v_kill_bucket,
         win_bucket = v_win_bucket,
         bucket_at = now(),
         day_key = current_date,
         day_gain = v_day + greatest(v_earn, 0),
         updated_at = now()
   where id = v.id;
  return jsonb_build_object('ok', true, 'clamped', v_clamped,
    'profile', jsonb_build_object('points', v_points, 'owned', v.owned || v_new, 'stats', v_stats));
end $$;

-- 이 서버가 아는 기능. 클라이언트는 시작할 때 한 번 묻고, 캐릭터 구매는 avatars가 true일 때만 연다.
-- 이 파일을 다시 실행하기 전의 서버에는 이 함수가 없어(404) 구매가 닫힌 채로 남으므로, 서버가 모르는 캐릭터를 사서 포인트를 잃지 않는다.
-- feedback: 건의함(fps_send_feedback·fps_my_feedback)이 있다. 없으면 화면이 글을 쓰기 전에 '아직 열리지 않았어요'라고 알린다.
create or replace function public.fps_features() returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select jsonb_build_object('ok', true, 'avatars', true, 'feedback', true)
$$;

-- ───────────── 건의함 (2026-11-12) ─────────────
-- 플레이어가 게임 안에서 소유자에게 바로 보내는 글. 플레이어(anon)에게는 이 표의 권한이 하나도 없어, 쓰기는 fps_send_feedback으로만 하고 읽기는 fps_my_feedback(자기 글)으로만 한다.
-- 소유자는 Supabase 대시보드(Table Editor·SQL Editor)나 아래 '받은편지함' 로그인으로 읽고, reply 칸에 답을 적으면 보낸 사람의 건의함에 보인다.
-- 보낸 사람은 닉네임을 등록한 기기 토큰이어야 한다. 이메일·IP 원문은 받지 않는다(IP는 fps_rate의 해시로만 센다).
create table if not exists public.fps_feedback (
  id bigint generated always as identity primary key,
  player_id bigint references public.fps_players(id) on delete set null,
  name text not null,
  kind text not null check (kind in ('bug', 'idea', 'balance', 'other')),
  body text not null check (char_length(body) between 5 and 1000),
  info jsonb not null default '{}'::jsonb check (jsonb_typeof(info) = 'object'),
  status text not null default 'new' check (status in ('new', 'read', 'done', 'hold')),
  reply text check (reply is null or char_length(reply) <= 500),
  replied_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.fps_feedback enable row level security;
revoke all on public.fps_feedback from public, anon, authenticated;
revoke all on sequence public.fps_feedback_id_seq from public, anon, authenticated;
create index if not exists fps_feedback_player_idx on public.fps_feedback (player_id, created_at desc);
create index if not exists fps_feedback_created_idx on public.fps_feedback (created_at desc);
-- 소유자가 켜면 그 사람은 더는 건의를 보내지 못한다(도배 대비). Table Editor의 fps_players에서 바꾼다
alter table public.fps_players add column if not exists feedback_blocked boolean not null default false;

-- 건의 본문 정리. js/account/feedback.js의 cleanFeedback과 같은 순서다(tests/feedback.test.mjs가 대조한다).
-- 줄바꿈(\n)·탭을 뺀 제어 문자와 안 보이는 글자(폭 없는 공백, 글자 방향 바꾸기)를 지우고, 줄 끝 공백과 세 줄 넘는 빈 줄을 줄인 뒤 앞뒤를 자른다.
create or replace function public.fps_feedback_clean(p_body text) returns text
language sql immutable set search_path = public, extensions as $$
  select btrim(
    regexp_replace(
      regexp_replace(
        regexp_replace(replace(coalesce(p_body, ''), E'\r\n', E'\n'),
          '[\u0001-\u0008\u000b-\u001f\u007f​-‏‪-‮⁠-⁤⁦-⁩﻿]', '', 'g'),
        '[ \t]+\n', E'\n', 'g'),
      '\n{3,}', E'\n\n', 'g'),
    E' \t\n')
$$;

-- 소유자가 reply를 적거나 고치면 답한 시각을 찍는다. 새 글(new)에 답하면 확인함(read)으로 바꾼다. 빈 답은 지운 것으로 본다
create or replace function public.fps_feedback_stamp() returns trigger
language plpgsql set search_path = public, extensions as $$
begin
  if new.reply is distinct from old.reply then
    new.reply := nullif(btrim(new.reply), '');
    new.replied_at := case when new.reply is null then null else now() end;
    if new.reply is not null and new.status = 'new' then new.status := 'read'; end if;
  end if;
  return new;
end $$;

create or replace trigger fps_feedback_stamp before update on public.fps_feedback
  for each row execute function public.fps_feedback_stamp();

-- 결과: { ok:true, id } 또는 { ok:false, error }. 코드: TOKEN_INVALID, NOT_FOUND, FEEDBACK_INVALID, FEEDBACK_DUPLICATE, FEEDBACK_BLOCKED, RATE_LIMITED
-- 한도: 한 사람이 10분에 3개·하루 15개, 같은 IP에서 한 시간 40개, 모두 합쳐 하루 500개. 같은 사람이 같은 글을 하루 안에 다시 보내면 FEEDBACK_DUPLICATE.
-- p_info(화면 크기·모드·맵·버전 같은 진단 정보)는 짧은 문자열·숫자·참거짓 칸만 12개까지 남기고, 너무 크면 버린다(글은 받는다).
create or replace function public.fps_send_feedback(p_token text, p_kind text, p_body text, p_info jsonb)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  v_hash text := public.fps_token_hash(p_token);
  v public.fps_players%rowtype;
  v_body text;
  v_info jsonb := '{}'::jsonb;
  v_id bigint;
begin
  if v_hash is null then return jsonb_build_object('ok', false, 'error', 'TOKEN_INVALID'); end if;
  if p_kind is null or p_kind not in ('bug', 'idea', 'balance', 'other') or p_body is null or octet_length(p_body) > 8000 then
    return jsonb_build_object('ok', false, 'error', 'FEEDBACK_INVALID');
  end if;
  v_body := public.fps_feedback_clean(p_body);
  if char_length(v_body) not between 5 and 1000 then
    return jsonb_build_object('ok', false, 'error', 'FEEDBACK_INVALID');
  end if;
  -- 같은 사람의 요청을 줄 세워 한도를 정확히 센다
  select * into v from public.fps_players where id = public.fps_player_id(v_hash) for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); end if;
  if v.feedback_blocked then return jsonb_build_object('ok', false, 'error', 'FEEDBACK_BLOCKED'); end if;
  if exists (select 1 from public.fps_feedback f
             where f.player_id = v.id and f.body = v_body and f.created_at > now() - interval '1 day') then
    return jsonb_build_object('ok', false, 'error', 'FEEDBACK_DUPLICATE');
  end if;
  if (select count(*) from public.fps_feedback f where f.player_id = v.id and f.created_at > now() - interval '10 minutes') >= 3
     or (select count(*) from public.fps_feedback f where f.player_id = v.id and f.created_at > now() - interval '1 day') >= 15
     or (select count(*) from public.fps_feedback f where f.created_at > now() - interval '1 day') >= 500 then
    return jsonb_build_object('ok', false, 'error', 'RATE_LIMITED');
  end if;
  -- IP 한도는 위를 모두 통과한 요청만 센다
  if not public.fps_rate_ok('feedback', 40, interval '1 hour') then
    return jsonb_build_object('ok', false, 'error', 'RATE_LIMITED');
  end if;
  if jsonb_typeof(p_info) = 'object' and octet_length(p_info::text) <= 2048 then
    select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) into v_info
    from (
      select i.key, i.value from jsonb_each(p_info) as i
      where char_length(i.key) <= 24
        and (jsonb_typeof(i.value) in ('number', 'boolean')
             or (jsonb_typeof(i.value) = 'string' and char_length(i.value #>> '{}') <= 80))
      order by i.key
      limit 12
    ) e;
  end if;
  insert into public.fps_feedback (player_id, name, kind, body, info)
  values (v.id, v.name, p_kind, v_body, v_info)
  returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

-- 보낸 사람은 자기 건의와 답만 본다(최근 10개). 다른 사람의 글·진단 정보는 내보내지 않는다.
create or replace function public.fps_my_feedback(p_token text) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare
  v_hash text := public.fps_token_hash(p_token);
  v_id bigint;
begin
  if v_hash is null then return jsonb_build_object('ok', false, 'error', 'TOKEN_INVALID'); end if;
  v_id := public.fps_player_id(v_hash);
  if v_id is null then return jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); end if;
  return jsonb_build_object('ok', true, 'items', coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', f.id, 'kind', f.kind, 'body', f.body, 'status', f.status, 'reply', f.reply,
             'at', (extract(epoch from f.created_at) * 1000)::bigint,
             'repliedAt', (extract(epoch from f.replied_at) * 1000)::bigint
           ) order by f.created_at desc, f.id desc)
    from (
      select * from public.fps_feedback
      where player_id = v_id
      order by created_at desc, id desc
      limit 10
    ) f
  ), '[]'::jsonb));
end $$;

-- ───────────── 건의함 받은편지함: 소유자 전용 로그인 (2026-11-17) ─────────────
-- 소유자가 SQL·Table Editor 없이 웹 화면(dev/inbox.html)에서 건의를 읽고 답한다. 설계는 docs/FEEDBACK.md 6절, 처음 켜는 절차는 docs/FEEDBACK_INBOX_SOP.md.
-- 플레이어(anon)의 권한은 늘리지 않는다. 열리는 곳은 Supabase Auth로 로그인한(authenticated) 사용자 가운데 관리자 표에 있는 사람뿐이다.
--   1) 관리자 표 fps_admins: 소유자 계정의 uid를 소유자가 SQL Editor에서 직접 넣는다. uid를 이 파일에 적지 않는다. API로는 읽지도 쓰지도 못한다.
--   2) fps_is_admin(): 지금 로그인한 사용자가 관리자인가. require_mfa를 켠 관리자는 2단계 인증(aal2)으로 로그인한 토큰만 통과한다.
--   3) 열 단위 권한: authenticated는 아래 열만 읽고 reply·status 두 칸만 고친다. 글을 넣거나 지우거나 본문·보낸 사람을 바꾸지 못한다.
--   4) 정책: 읽기·수정 모두 fps_is_admin()이 참인 사람만. 새 가입을 끄지 않아 누가 authenticated가 되어도 관리자 표에 없으면 0행이다.
-- 답을 고치면 트리거 fps_feedback_stamp가 답한 시각과 상태(new → read)를 처리한다. 대시보드에서 고칠 때와 같다.
create table if not exists public.fps_admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  note text check (note is null or char_length(note) <= 80),
  require_mfa boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.fps_admins enable row level security;
revoke all on public.fps_admins from public, anon, authenticated;

-- 이 함수만 관리자 표를 읽는다(SECURITY DEFINER). 결과는 '내가 관리자인가' 하나뿐이다.
create or replace function public.fps_is_admin() returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select exists (
    select 1 from public.fps_admins a
    where a.user_id = auth.uid()
      and (not a.require_mfa or coalesce(auth.jwt() ->> 'aal', '') = 'aal2')
  )
$$;
revoke all on function public.fps_is_admin() from public, anon, authenticated;
grant execute on function public.fps_is_admin() to authenticated;

-- 표 전체 권한은 위(건의함 절)에서 모두 회수했다. 여기서 필요한 열만 authenticated에게 다시 준다. anon에게는 주지 않는다
grant select (id, player_id, name, kind, body, info, status, reply, replied_at, created_at) on public.fps_feedback to authenticated;
grant update (reply, status) on public.fps_feedback to authenticated;

-- 정책은 이름을 정해 두고 다시 만든다(데이터는 건드리지 않는다). 정책이 없으면 기본이 거절이라 만드는 사이에도 열리지 않는다
drop policy if exists fps_feedback_owner_select on public.fps_feedback;
create policy fps_feedback_owner_select on public.fps_feedback
  for select to authenticated using ((select public.fps_is_admin()));
drop policy if exists fps_feedback_owner_update on public.fps_feedback;
create policy fps_feedback_owner_update on public.fps_feedback
  for update to authenticated using ((select public.fps_is_admin())) with check ((select public.fps_is_admin()));

-- 순위표에는 이름, 킬, 승리, 포인트만 내보낸다.
create or replace function public.fps_top_players(p_limit int default 20) returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select jsonb_build_object('ok', true, 'players', coalesce(jsonb_agg(
           jsonb_build_object('name', t.name, 'kills', t.kills, 'wins', t.wins, 'points', t.points)
           order by t.kills desc, t.wins desc, t.points desc, t.name_key
         ), '[]'::jsonb))
  from (
    select p.name, p.name_key, p.points,
           coalesce((p.stats ->> 'kills')::numeric::bigint, 0) as kills,
           coalesce((p.stats ->> 'wins')::numeric::bigint, 0) as wins
    from public.fps_players p
    order by kills desc, wins desc, p.points desc, p.name_key
    limit least(greatest(coalesce(p_limit, 20), 1), 100)
  ) t
$$;

-- ───────────── 로그인 연결 · 테스트 결제 (2026-11-16) ─────────────
-- 아래 fps_api_* 함수는 브라우저가 부르지 못한다. server/api(Cloudflare Worker)가 Supabase 비밀 키(service_role)로만 부른다.
-- Worker가 구글·카카오의 ID 토큰을 검증한 뒤 (제공자, 고유 id)를 넘기므로, 여기서는 그 값으로 계정을 잇거나 기기 토큰을 더한다.
-- 코인은 서버만 바꾸는 잔액이다. fps_save_profile은 코인을 건드리지 않으므로 충전한 코인이 클라이언트 저장에 덮이지 않는다.
-- 충전·환불·사용은 fps_coin_ledger에 한 줄씩 남는다. 주문(fps_orders) 상태는 아래 길로만 바뀐다.
--   READY(주문 만듦) → CONFIRMING(토스 인증을 받아 승인 요청 중) → DONE(코인 넣음) → CANCELING(환불 요청 중) → CANCELED
--   READY·CONFIRMING → FAILED(결제 실패·취소) 또는 EXPIRED(한 시간 지남). 토스 기록이 DONE이면 FAILED·EXPIRED도 DONE으로 바로잡는다.
-- 돈은 Worker가 승인 API를 부를 때만 움직인다. 그래서 승인 결과를 모르는 주문은 CONFIRMING·CANCELING뿐이고, Worker의 대사가 토스에 물어 정리한다.

-- 외부 계정 연결. 한 외부 계정은 한 사람에게만, 한 사람은 제공자마다 계정 하나만 잇는다
create table if not exists public.fps_identities (
  provider text not null check (provider in ('google', 'kakao')),
  subject text not null check (char_length(subject) between 1 and 255),
  player_id bigint not null references public.fps_players(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (provider, subject),
  unique (player_id, provider)
);
alter table public.fps_identities enable row level security;
revoke all on public.fps_identities from public, anon, authenticated;

-- 한 번 쓴 로그인 표(Worker가 서명한 ticket의 jti). 같은 표로 두 번 로그인하거나 잇지 못한다
create table if not exists public.fps_auth_used (
  jti text primary key check (jti ~ '^[0-9a-f]{32}$'),
  used_at timestamptz not null default now()
);
alter table public.fps_auth_used enable row level security;
revoke all on public.fps_auth_used from public, anon, authenticated;

-- 코인 잔액. 테스트 결제로 충전하고 꾸미기(이모트·캐릭터)를 산다
alter table public.fps_players add column if not exists coins int not null default 0 check (coins between 0 and 10000000);

-- 주문 하나 = 결제 한 번. order_id는 Worker가 만든 무작위 값이고 토스 orderId로 그대로 쓴다(6~64자, 영문·숫자·_)
create table if not exists public.fps_orders (
  order_id text primary key check (order_id ~ '^skala_[0-9a-f]{32}$'),
  player_id bigint not null references public.fps_players(id) on delete restrict,
  product text not null check (char_length(product) between 1 and 32),
  coins int not null check (coins between 1 and 100000),
  amount int not null check (amount between 100 and 1000000),
  status text not null default 'READY' check (status in ('READY', 'CONFIRMING', 'DONE', 'FAILED', 'EXPIRED', 'CANCELING', 'CANCELED')),
  payment_key text unique check (payment_key is null or char_length(payment_key) between 1 and 200),
  method text check (method is null or char_length(method) <= 40),
  fail_code text check (fail_code is null or char_length(fail_code) <= 80),
  return_url text not null check (char_length(return_url) between 1 and 512),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  done_at timestamptz,
  canceled_at timestamptz
);
create index if not exists fps_orders_player_idx on public.fps_orders (player_id, created_at desc);
create index if not exists fps_orders_open_idx on public.fps_orders (status, updated_at) where status in ('READY', 'CONFIRMING', 'CANCELING');
alter table public.fps_orders enable row level security;
revoke all on public.fps_orders from public, anon, authenticated;

-- 코인 원장. 잔액이 바뀔 때마다 한 줄(바뀐 양, 바뀐 뒤 잔액, 까닭)을 넣고 고치거나 지우지 않는다
create table if not exists public.fps_coin_ledger (
  id bigint generated always as identity primary key,
  player_id bigint not null references public.fps_players(id) on delete restrict,
  delta int not null check (delta <> 0),
  balance int not null check (balance >= 0),
  reason text not null check (reason in ('purchase', 'refund', 'refund_undo', 'spend')),
  order_id text references public.fps_orders(order_id) on delete restrict,
  item text check (item is null or char_length(item) <= 32),
  created_at timestamptz not null default now()
);
create index if not exists fps_coin_ledger_player_idx on public.fps_coin_ledger (player_id, id desc);
-- 같은 주문으로 코인을 두 번 넣지 않는다(승인 응답이 두 번 오거나 웹훅·대사가 겹쳐도)
create unique index if not exists fps_coin_ledger_purchase_once on public.fps_coin_ledger (order_id) where reason = 'purchase';
alter table public.fps_coin_ledger enable row level security;
revoke all on public.fps_coin_ledger from public, anon, authenticated;
revoke all on sequence public.fps_coin_ledger_id_seq from public, anon, authenticated;

-- 코인으로 살 수 있는 물건의 값: 꾸미기(캐릭터 av_*·이모트) 중 포인트 가격이 있는 것만, 포인트 가격의 10분의 1(올림).
-- 무기는 코인으로 팔지 않는다(돈으로 강해지지 않게). js/account/economy.js의 coinPriceOf와 같아야 한다(tests/api-sql.test.mjs).
create or replace function public.fps_coin_price(p_id text) returns int
language sql immutable set search_path = public, extensions as $$
  select case
    when left(p_id, 3) = 'av_'
      or p_id in ('takeL', 'veggie', 'sideToSide', 'crissCross', 'tango', 'salute', 'wave', 'cheer', 'creamCheese', 'fromYou', 'selfie')
      then nullif(ceil(coalesce(public.fps_item_price(p_id), 0) / 10.0)::int, 0)
  end
$$;

-- 로그인 표를 한 번만 쓰게 한다. 처음이면 true, 이미 쓴 표면 false
create or replace function public.fps_ticket_once(p_jti text) returns boolean
language plpgsql volatile set search_path = public, extensions as $$
begin
  if p_jti is null or p_jti !~ '^[0-9a-f]{32}$' then return false; end if;
  insert into public.fps_auth_used (jti) values (p_jti);
  return true;
exception when unique_violation then
  return false;
end $$;

-- Worker가 이 절을 실행한 서버인지 확인한다(없으면 404라 Worker가 로그인·결제를 닫는다)
create or replace function public.fps_api_ping() returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select jsonb_build_object('ok', true, 'v', 1)
$$;

-- 이 기기의 사람: 이름, 코인, 이은 제공자, 최근 주문 10개(결제하지 않은 주문은 뺀다). refundable = 지금 환불할 수 있다
create or replace function public.fps_api_me(p_token text, p_refund_days int) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare
  v_hash text := public.fps_token_hash(p_token);
  v public.fps_players%rowtype;
begin
  if v_hash is null then return jsonb_build_object('ok', false, 'error', 'TOKEN_INVALID'); end if;
  select * into v from public.fps_players where id = public.fps_player_id(v_hash);
  if not found then return jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); end if;
  return jsonb_build_object('ok', true, 'name', v.name, 'coins', v.coins,
    'providers', coalesce((select jsonb_agg(i.provider order by i.provider) from public.fps_identities i where i.player_id = v.id), '[]'::jsonb),
    'orders', coalesce((
      select jsonb_agg(jsonb_build_object(
               'orderId', o.order_id, 'product', o.product, 'coins', o.coins, 'amount', o.amount, 'status', o.status,
               'at', (extract(epoch from o.created_at) * 1000)::bigint,
               'refundable', coalesce(o.status = 'DONE' and v.coins >= o.coins
                 and o.done_at > now() - make_interval(days => greatest(coalesce(p_refund_days, 7), 0)), false)
             ) order by o.created_at desc)
      from (
        select * from public.fps_orders
        where player_id = v.id and status in ('DONE', 'CANCELING', 'CANCELED', 'FAILED')
        order by created_at desc
        limit 10
      ) o
    ), '[]'::jsonb));
end $$;

-- 이 외부 계정에 이은 사람의 이름. 없으면 name이 null
create or replace function public.fps_api_identity_owner(p_provider text, p_subject text) returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select jsonb_build_object('ok', true, 'name', (
    select p.name from public.fps_identities i join public.fps_players p on p.id = i.player_id
    where i.provider = p_provider and i.subject = p_subject))
$$;

-- 이 기기의 사람에게 외부 계정을 잇는다. 결과 { ok, name, already? }
-- 코드: TOKEN_INVALID, IDENTITY_INVALID, NOT_FOUND(이 기기는 닉네임을 아직 서버에 등록하지 않았다), IDENTITY_TAKEN(다른 사람에게 이어져 있다, name),
--       PROVIDER_LINKED(이 사람은 같은 제공자의 다른 계정을 이미 이었다), TICKET_USED
create or replace function public.fps_api_link(p_token text, p_provider text, p_subject text, p_jti text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_hash text := public.fps_token_hash(p_token);
  v public.fps_players%rowtype;
  v_owner bigint;
begin
  if v_hash is null then return jsonb_build_object('ok', false, 'error', 'TOKEN_INVALID'); end if;
  if p_provider is null or p_provider not in ('google', 'kakao') or p_subject is null or char_length(p_subject) not between 1 and 255 then
    return jsonb_build_object('ok', false, 'error', 'IDENTITY_INVALID');
  end if;
  select * into v from public.fps_players where id = public.fps_player_id(v_hash) for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); end if;
  select i.player_id into v_owner from public.fps_identities i where i.provider = p_provider and i.subject = p_subject;
  if found then
    if v_owner = v.id then return jsonb_build_object('ok', true, 'name', v.name, 'already', true); end if;
    return jsonb_build_object('ok', false, 'error', 'IDENTITY_TAKEN', 'name', (select p.name from public.fps_players p where p.id = v_owner));
  end if;
  if exists (select 1 from public.fps_identities i where i.player_id = v.id and i.provider = p_provider) then
    return jsonb_build_object('ok', false, 'error', 'PROVIDER_LINKED');
  end if;
  if not public.fps_ticket_once(p_jti) then return jsonb_build_object('ok', false, 'error', 'TICKET_USED'); end if;
  insert into public.fps_identities (provider, subject, player_id) values (p_provider, p_subject, v.id);
  return jsonb_build_object('ok', true, 'name', v.name);
exception when unique_violation then
  return jsonb_build_object('ok', false, 'error', 'IDENTITY_TAKEN');
end $$;

-- 외부 계정에 이은 사람으로 이 기기에 로그인한다: 기기가 새로 만든 토큰(p_new_token)을 그 사람의 토큰으로 더한다.
-- 한 사람의 로그인 기기 토큰은 최근 10개까지 쓰고, 넘으면 오래된 것부터 로그아웃시킨다. 코드: TOKEN_INVALID, NOT_LINKED, TOKEN_TAKEN, TICKET_USED
create or replace function public.fps_api_login(p_provider text, p_subject text, p_new_token text, p_jti text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_hash text := public.fps_token_hash(p_new_token);
  v public.fps_players%rowtype;
begin
  if v_hash is null then return jsonb_build_object('ok', false, 'error', 'TOKEN_INVALID'); end if;
  select p.* into v from public.fps_identities i join public.fps_players p on p.id = i.player_id
   where i.provider = p_provider and i.subject = p_subject
   for update of p;
  if not found then return jsonb_build_object('ok', false, 'error', 'NOT_LINKED'); end if;
  if public.fps_player_id(v_hash) is not null or exists (select 1 from public.fps_tokens t where t.token_hash = v_hash) then
    return jsonb_build_object('ok', false, 'error', 'TOKEN_TAKEN');
  end if;
  if not public.fps_ticket_once(p_jti) then return jsonb_build_object('ok', false, 'error', 'TICKET_USED'); end if;
  insert into public.fps_tokens (token_hash, player_id) values (v_hash, v.id);
  update public.fps_tokens set revoked_at = now()
   where player_id = v.id and revoked_at is null
     and token_hash not in (select t.token_hash from public.fps_tokens t where t.player_id = v.id and t.revoked_at is null
                            order by t.created_at desc limit 10);
  return jsonb_build_object('ok', true, 'name', v.name);
end $$;

-- 이 기기에서 로그아웃한다. 로그인으로 더한 토큰은 revoked_at을 찍고, 처음 기기 토큰은 쓸 수 없는 값으로 바꾼다.
-- 처음 기기 토큰인데 이은 외부 계정이 없으면 이 행을 다시 찾을 길이 없어 거절한다(NOT_LINKED). 이미 없는 토큰은 할 일이 없어 ok다
create or replace function public.fps_api_logout(p_token text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_hash text := public.fps_token_hash(p_token);
  v_id bigint;
begin
  if v_hash is null then return jsonb_build_object('ok', false, 'error', 'TOKEN_INVALID'); end if;
  update public.fps_tokens set revoked_at = now() where token_hash = v_hash and revoked_at is null returning player_id into v_id;
  if found then return jsonb_build_object('ok', true); end if;
  select p.id into v_id from public.fps_players p where p.token_hash = v_hash for update;
  if not found then return jsonb_build_object('ok', true, 'already', true); end if;
  if not exists (select 1 from public.fps_identities i where i.player_id = v_id) then
    return jsonb_build_object('ok', false, 'error', 'NOT_LINKED');
  end if;
  update public.fps_players set token_hash = 'revoked:' || v_id || ':' || encode(gen_random_bytes(16), 'hex'), updated_at = now() where id = v_id;
  return jsonb_build_object('ok', true);
end $$;

-- 테스트 결제 주문을 만든다. 상품·코인·금액은 Worker의 상품표가 정하고, 여기서는 사람과 한도를 확인한다.
-- 한도: 24시간에 결제를 마친 주문 p_daily_limit개, 10분에 주문 10개. 한 시간 넘게 결제하지 않은 주문은 EXPIRED로 바꾼다.
-- 코드: TOKEN_INVALID, ORDER_INVALID, NOT_FOUND, DAILY_LIMIT, RATE_LIMITED, ORDER_DUPLICATE
create or replace function public.fps_api_create_order(p_token text, p_order_id text, p_product text, p_coins int, p_amount int,
  p_return_url text, p_daily_limit int) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_hash text := public.fps_token_hash(p_token);
  v public.fps_players%rowtype;
  v_limit int := greatest(coalesce(p_daily_limit, 3), 0);
  v_count int;
begin
  if v_hash is null then return jsonb_build_object('ok', false, 'error', 'TOKEN_INVALID'); end if;
  if p_order_id is null or p_order_id !~ '^skala_[0-9a-f]{32}$' or p_product is null or p_coins is null or p_amount is null or p_return_url is null then
    return jsonb_build_object('ok', false, 'error', 'ORDER_INVALID');
  end if;
  select * into v from public.fps_players where id = public.fps_player_id(v_hash) for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); end if;
  update public.fps_orders set status = 'EXPIRED', fail_code = 'EXPIRED', updated_at = now()
   where player_id = v.id and status = 'READY' and created_at < now() - interval '1 hour';
  select count(*) into v_count from public.fps_orders
   where player_id = v.id and status in ('CONFIRMING', 'DONE', 'CANCELING') and created_at > now() - interval '1 day';
  if v_count >= v_limit then return jsonb_build_object('ok', false, 'error', 'DAILY_LIMIT', 'limit', v_limit); end if;
  select count(*) into v_count from public.fps_orders where player_id = v.id and created_at > now() - interval '10 minutes';
  if v_count >= 10 then return jsonb_build_object('ok', false, 'error', 'RATE_LIMITED'); end if;
  insert into public.fps_orders (order_id, player_id, product, coins, amount, return_url)
  values (p_order_id, v.id, p_product, p_coins, p_amount, p_return_url);
  return jsonb_build_object('ok', true, 'orderId', p_order_id, 'name', v.name);
exception
  when check_violation then return jsonb_build_object('ok', false, 'error', 'ORDER_INVALID');
  when unique_violation then return jsonb_build_object('ok', false, 'error', 'ORDER_DUPLICATE');
end $$;

-- 주문 하나(결제 페이지·승인용). ageSec = 만든 뒤 지난 초
create or replace function public.fps_api_order(p_order_id text) returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select coalesce((
    select jsonb_build_object('ok', true, 'order', jsonb_build_object(
      'orderId', o.order_id, 'product', o.product, 'coins', o.coins, 'amount', o.amount, 'status', o.status,
      'paymentKey', o.payment_key, 'returnUrl', o.return_url, 'name', p.name,
      'ageSec', floor(extract(epoch from now() - o.created_at))::int))
    from public.fps_orders o join public.fps_players p on p.id = o.player_id
    where o.order_id = p_order_id), jsonb_build_object('ok', false, 'error', 'NOT_FOUND'))
$$;

-- 토스가 인증을 마치고 돌려보낸 값(successUrl)을 주문과 맞춰 본다. 금액이 다르면 승인하지 않는다(AMOUNT_MISMATCH).
-- READY → CONFIRMING(paymentKey 기록). 같은 paymentKey로 다시 오면(새로 고침) 그대로 ok.
-- 코드: NOT_FOUND, AMOUNT_MISMATCH, ORDER_EXPIRED, ORDER_STATE, PAYMENT_KEY_TAKEN
create or replace function public.fps_api_mark_confirming(p_order_id text, p_payment_key text, p_amount int) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v public.fps_orders%rowtype;
begin
  select * into v from public.fps_orders where order_id = p_order_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); end if;
  if p_amount is null or v.amount <> p_amount then return jsonb_build_object('ok', false, 'error', 'AMOUNT_MISMATCH'); end if;
  if p_payment_key is null or char_length(p_payment_key) not between 1 and 200 then
    return jsonb_build_object('ok', false, 'error', 'ORDER_STATE', 'status', v.status);
  end if;
  if v.status = 'READY' then
    if v.created_at < now() - interval '1 hour' then
      update public.fps_orders set status = 'EXPIRED', fail_code = 'EXPIRED', updated_at = now() where order_id = v.order_id;
      return jsonb_build_object('ok', false, 'error', 'ORDER_EXPIRED');
    end if;
    update public.fps_orders set status = 'CONFIRMING', payment_key = p_payment_key, updated_at = now() where order_id = v.order_id;
    return jsonb_build_object('ok', true, 'status', 'CONFIRMING');
  end if;
  if v.payment_key = p_payment_key and v.status in ('CONFIRMING', 'DONE') then
    return jsonb_build_object('ok', true, 'status', v.status);
  end if;
  return jsonb_build_object('ok', false, 'error', 'ORDER_STATE', 'status', v.status);
exception when unique_violation then
  return jsonb_build_object('ok', false, 'error', 'PAYMENT_KEY_TAKEN');
end $$;

-- 토스 승인(DONE)을 확인한 뒤 코인을 넣는다. 한 주문에 한 번만 넣는다(이미 넣었으면 ok, already).
-- 토스가 DONE이라고 하면 FAILED·EXPIRED로 적은 주문도 DONE으로 바로잡는다(돈이 움직였으므로). 코드: NOT_FOUND, AMOUNT_MISMATCH, ORDER_STATE
create or replace function public.fps_api_complete_order(p_order_id text, p_payment_key text, p_amount int, p_method text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v public.fps_orders%rowtype;
  v_coins int;
begin
  select * into v from public.fps_orders where order_id = p_order_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); end if;
  if p_amount is null or v.amount <> p_amount then return jsonb_build_object('ok', false, 'error', 'AMOUNT_MISMATCH'); end if;
  if p_payment_key is null or (v.payment_key is not null and v.payment_key <> p_payment_key) then
    return jsonb_build_object('ok', false, 'error', 'ORDER_STATE', 'status', v.status);
  end if;
  if v.status in ('DONE', 'CANCELING', 'CANCELED') then
    return jsonb_build_object('ok', true, 'already', true, 'status', v.status,
      'coins', (select p.coins from public.fps_players p where p.id = v.player_id));
  end if;
  update public.fps_players set coins = coins + v.coins, updated_at = now() where id = v.player_id returning coins into v_coins;
  insert into public.fps_coin_ledger (player_id, delta, balance, reason, order_id) values (v.player_id, v.coins, v_coins, 'purchase', v.order_id);
  update public.fps_orders set status = 'DONE', payment_key = p_payment_key, method = left(p_method, 40), fail_code = null,
         done_at = now(), updated_at = now()
   where order_id = v.order_id;
  return jsonb_build_object('ok', true, 'status', 'DONE', 'coins', v_coins, 'added', v.coins);
exception when unique_violation then
  return jsonb_build_object('ok', false, 'error', 'ORDER_STATE');
end $$;

-- 결제 실패·취소·만료를 적는다. READY·CONFIRMING만 바꾸고 DONE 이후는 그대로 둔다(changed:false)
create or replace function public.fps_api_fail_order(p_order_id text, p_code text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
begin
  update public.fps_orders
     set status = case when p_code = 'EXPIRED' then 'EXPIRED' else 'FAILED' end,
         fail_code = left(coalesce(p_code, 'UNKNOWN'), 80), updated_at = now()
   where order_id = p_order_id and status in ('READY', 'CONFIRMING');
  return jsonb_build_object('ok', true, 'changed', found);
end $$;

-- 사람이 요청한 환불의 첫 단계: 코인을 먼저 빼고 CANCELING으로 바꾼다(그 사이에 그 코인을 쓰지 못하게). 토스 취소 결과는 fps_api_end_cancel이 적는다.
-- 조건: 내 주문, DONE, 결제한 지 p_refund_days일 이내, 그 코인을 아직 쓰지 않았다(잔액 ≥ 주문 코인).
-- 코드: TOKEN_INVALID, NOT_FOUND, ORDER_STATE, REFUND_EXPIRED, COINS_SPENT
create or replace function public.fps_api_begin_cancel(p_token text, p_order_id text, p_refund_days int) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_hash text := public.fps_token_hash(p_token);
  v_id bigint;
  v public.fps_orders%rowtype;
  v_coins int;
begin
  if v_hash is null then return jsonb_build_object('ok', false, 'error', 'TOKEN_INVALID'); end if;
  v_id := public.fps_player_id(v_hash);
  select * into v from public.fps_orders where order_id = p_order_id for update;
  if not found or v_id is null or v.player_id <> v_id then return jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); end if;
  if v.status <> 'DONE' then return jsonb_build_object('ok', false, 'error', 'ORDER_STATE', 'status', v.status); end if;
  if v.done_at is null or v.done_at < now() - make_interval(days => greatest(coalesce(p_refund_days, 7), 0)) then
    return jsonb_build_object('ok', false, 'error', 'REFUND_EXPIRED');
  end if;
  select p.coins into v_coins from public.fps_players p where p.id = v_id for update;
  if v_coins < v.coins then return jsonb_build_object('ok', false, 'error', 'COINS_SPENT', 'coins', v_coins); end if;
  update public.fps_players set coins = coins - v.coins, updated_at = now() where id = v_id returning coins into v_coins;
  insert into public.fps_coin_ledger (player_id, delta, balance, reason, order_id) values (v_id, -v.coins, v_coins, 'refund', v.order_id);
  update public.fps_orders set status = 'CANCELING', updated_at = now() where order_id = v.order_id;
  return jsonb_build_object('ok', true, 'paymentKey', v.payment_key, 'amount', v.amount, 'coins', v_coins);
end $$;

-- 환불의 둘째 단계. p_ok = 토스가 취소를 마쳤다 → CANCELED. 아니면 뺀 코인을 돌려놓고 DONE으로 되돌린다
create or replace function public.fps_api_end_cancel(p_order_id text, p_ok boolean) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v public.fps_orders%rowtype;
  v_coins int;
begin
  select * into v from public.fps_orders where order_id = p_order_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); end if;
  if v.status <> 'CANCELING' then
    if p_ok and v.status = 'CANCELED' then return jsonb_build_object('ok', true, 'already', true); end if;
    return jsonb_build_object('ok', false, 'error', 'ORDER_STATE', 'status', v.status);
  end if;
  if p_ok then
    update public.fps_orders set status = 'CANCELED', canceled_at = now(), updated_at = now() where order_id = v.order_id;
    return jsonb_build_object('ok', true, 'status', 'CANCELED', 'coins', (select p.coins from public.fps_players p where p.id = v.player_id));
  end if;
  update public.fps_players set coins = coins + v.coins, updated_at = now() where id = v.player_id returning coins into v_coins;
  insert into public.fps_coin_ledger (player_id, delta, balance, reason, order_id) values (v.player_id, v.coins, v_coins, 'refund_undo', v.order_id);
  update public.fps_orders set status = 'DONE', updated_at = now() where order_id = v.order_id;
  return jsonb_build_object('ok', true, 'status', 'DONE', 'coins', v_coins);
end $$;

-- 토스 쪽에서 취소된 결제(상점관리자에서 취소한 것, 웹훅·대사로 알게 됨)를 주문에 맞춘다. DONE이면 남은 코인에서 그만큼 빼고
-- (모자라면 있는 만큼, fail_code = COINS_SHORT) CANCELED로 바꾼다. 이미 CANCELED면 그대로 ok
create or replace function public.fps_api_external_cancel(p_order_id text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v public.fps_orders%rowtype;
  v_have int;
  v_take int;
  v_coins int;
begin
  select * into v from public.fps_orders where order_id = p_order_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); end if;
  if v.status = 'CANCELED' then return jsonb_build_object('ok', true, 'already', true, 'status', v.status); end if;
  if v.status = 'CANCELING' then
    update public.fps_orders set status = 'CANCELED', canceled_at = now(), updated_at = now() where order_id = v.order_id;
    return jsonb_build_object('ok', true, 'status', 'CANCELED');
  end if;
  if v.status in ('READY', 'CONFIRMING') then
    update public.fps_orders set status = 'FAILED', fail_code = 'CANCELED', updated_at = now() where order_id = v.order_id;
    return jsonb_build_object('ok', true, 'status', 'FAILED');
  end if;
  if v.status <> 'DONE' then return jsonb_build_object('ok', true, 'status', v.status); end if;
  select p.coins into v_have from public.fps_players p where p.id = v.player_id for update;
  v_take := least(v_have, v.coins);
  if v_take > 0 then
    update public.fps_players set coins = coins - v_take, updated_at = now() where id = v.player_id returning coins into v_coins;
    insert into public.fps_coin_ledger (player_id, delta, balance, reason, order_id) values (v.player_id, -v_take, v_coins, 'refund', v.order_id);
  end if;
  update public.fps_orders set status = 'CANCELED', canceled_at = now(), updated_at = now(),
         fail_code = case when v_take < v.coins then 'COINS_SHORT' end
   where order_id = v.order_id;
  return jsonb_build_object('ok', true, 'status', 'CANCELED', 'taken', v_take);
end $$;

-- 코인으로 꾸미기를 산다(fps_coin_price). 물건을 owned에 바로 넣으므로 클라이언트가 다음에 저장할 때 이미 가진 물건이라 포인트를 내지 않는다.
-- 코드: TOKEN_INVALID, ITEM_INVALID, NOT_FOUND, OWNED, COINS_SHORT
create or replace function public.fps_api_buy_with_coins(p_token text, p_item text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_hash text := public.fps_token_hash(p_token);
  v public.fps_players%rowtype;
  v_price int := public.fps_coin_price(p_item);
  v_coins int;
begin
  if v_hash is null then return jsonb_build_object('ok', false, 'error', 'TOKEN_INVALID'); end if;
  if v_price is null then return jsonb_build_object('ok', false, 'error', 'ITEM_INVALID'); end if;
  select * into v from public.fps_players where id = public.fps_player_id(v_hash) for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); end if;
  if v.owned ? p_item then return jsonb_build_object('ok', false, 'error', 'OWNED', 'owned', v.owned, 'coins', v.coins); end if;
  if v.coins < v_price then return jsonb_build_object('ok', false, 'error', 'COINS_SHORT', 'coins', v.coins, 'price', v_price); end if;
  update public.fps_players set coins = coins - v_price, owned = owned || to_jsonb(p_item), updated_at = now()
   where id = v.id returning coins into v_coins;
  insert into public.fps_coin_ledger (player_id, delta, balance, reason, item) values (v.id, -v_price, v_coins, 'spend', p_item);
  return jsonb_build_object('ok', true, 'coins', v_coins, 'spent', v_price, 'owned', v.owned || to_jsonb(p_item));
end $$;

-- 대사(Worker cron)할 주문. 한 시간 넘게 결제하지 않은 READY는 여기서 EXPIRED로 바꾼다(승인을 부르지 않았으니 돈이 움직이지 않았다).
-- 결과를 모르는 CONFIRMING·CANCELING 중 2분 넘게 그대로인 것을 돌려준다. 만든 날이 아니라 마지막으로 바뀐 때(updated_at)로 7일까지 본다:
-- 환불은 결제하고 며칠 뒤에도 시작할 수 있으므로(REFUND_DAYS), 만든 날로 자르면 늦게 시작한 환불이 CANCELING에 갇혀 코인이 묶인다
create or replace function public.fps_api_open_orders(p_limit int) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions as $$
begin
  update public.fps_orders set status = 'EXPIRED', fail_code = 'EXPIRED', updated_at = now()
   where status = 'READY' and created_at < now() - interval '1 hour';
  return jsonb_build_object('ok', true, 'orders', coalesce((
    select jsonb_agg(jsonb_build_object(
             'orderId', o.order_id, 'status', o.status, 'paymentKey', o.payment_key, 'amount', o.amount,
             'idleSec', floor(extract(epoch from now() - o.updated_at))::int) order by o.created_at)
    from (
      select * from public.fps_orders
      where status in ('CONFIRMING', 'CANCELING') and updated_at < now() - interval '2 minutes' and updated_at > now() - interval '7 days'
      order by created_at
      limit least(greatest(coalesce(p_limit, 20), 1), 50)
    ) o
  ), '[]'::jsonb));
end $$;

-- ───────────── 실행 권한 ─────────────
grant usage on schema public to anon, authenticated;

revoke all on function public.fps_clean_name(text) from public, anon, authenticated;
revoke all on function public.fps_name_error(text) from public, anon, authenticated;
revoke all on function public.fps_token_hash(text) from public, anon, authenticated;
revoke all on function public.fps_owned_ok(jsonb) from public, anon, authenticated;
revoke all on function public.fps_item_price(text) from public, anon, authenticated;
revoke all on function public.fps_client_key() from public, anon, authenticated;
revoke all on function public.fps_rate_ok(text, int, interval) from public, anon, authenticated;
revoke all on function public.fps_feedback_clean(text) from public, anon, authenticated;
revoke all on function public.fps_feedback_stamp() from public, anon, authenticated;
revoke all on function public.fps_player_id(text) from public, anon, authenticated;
revoke all on function public.fps_coin_price(text) from public, anon, authenticated;
revoke all on function public.fps_ticket_once(text) from public, anon, authenticated;

revoke all on function public.fps_check_nickname(text) from public;
revoke all on function public.fps_claim_nickname(text, text) from public;
revoke all on function public.fps_get_profile(text) from public;
revoke all on function public.fps_save_profile(text, int, jsonb, jsonb, jsonb, jsonb) from public;
revoke all on function public.fps_top_players(int) from public;
revoke all on function public.fps_features() from public;
revoke all on function public.fps_send_feedback(text, text, text, jsonb) from public;
revoke all on function public.fps_my_feedback(text) from public;

grant execute on function public.fps_check_nickname(text) to anon, authenticated;
grant execute on function public.fps_claim_nickname(text, text) to anon, authenticated;
grant execute on function public.fps_get_profile(text) to anon, authenticated;
grant execute on function public.fps_save_profile(text, int, jsonb, jsonb, jsonb, jsonb) to anon, authenticated;
grant execute on function public.fps_top_players(int) to anon, authenticated;
grant execute on function public.fps_features() to anon, authenticated;
grant execute on function public.fps_send_feedback(text, text, text, jsonb) to anon, authenticated;
grant execute on function public.fps_my_feedback(text) to anon, authenticated;

-- 로그인 연결·테스트 결제: server/api Worker(Supabase 비밀 키 = service_role)만 부른다
revoke all on function public.fps_api_ping() from public, anon, authenticated;
revoke all on function public.fps_api_me(text, int) from public, anon, authenticated;
revoke all on function public.fps_api_identity_owner(text, text) from public, anon, authenticated;
revoke all on function public.fps_api_link(text, text, text, text) from public, anon, authenticated;
revoke all on function public.fps_api_login(text, text, text, text) from public, anon, authenticated;
revoke all on function public.fps_api_logout(text) from public, anon, authenticated;
revoke all on function public.fps_api_create_order(text, text, text, int, int, text, int) from public, anon, authenticated;
revoke all on function public.fps_api_order(text) from public, anon, authenticated;
revoke all on function public.fps_api_mark_confirming(text, text, int) from public, anon, authenticated;
revoke all on function public.fps_api_complete_order(text, text, int, text) from public, anon, authenticated;
revoke all on function public.fps_api_fail_order(text, text) from public, anon, authenticated;
revoke all on function public.fps_api_begin_cancel(text, text, int) from public, anon, authenticated;
revoke all on function public.fps_api_end_cancel(text, boolean) from public, anon, authenticated;
revoke all on function public.fps_api_external_cancel(text) from public, anon, authenticated;
revoke all on function public.fps_api_buy_with_coins(text, text) from public, anon, authenticated;
revoke all on function public.fps_api_open_orders(int) from public, anon, authenticated;

grant execute on function public.fps_api_ping() to service_role;
grant execute on function public.fps_api_me(text, int) to service_role;
grant execute on function public.fps_api_identity_owner(text, text) to service_role;
grant execute on function public.fps_api_link(text, text, text, text) to service_role;
grant execute on function public.fps_api_login(text, text, text, text) to service_role;
grant execute on function public.fps_api_logout(text) to service_role;
grant execute on function public.fps_api_create_order(text, text, text, int, int, text, int) to service_role;
grant execute on function public.fps_api_order(text) to service_role;
grant execute on function public.fps_api_mark_confirming(text, text, int) to service_role;
grant execute on function public.fps_api_complete_order(text, text, int, text) to service_role;
grant execute on function public.fps_api_fail_order(text, text) to service_role;
grant execute on function public.fps_api_begin_cancel(text, text, int) to service_role;
grant execute on function public.fps_api_end_cancel(text, boolean) to service_role;
grant execute on function public.fps_api_external_cancel(text) to service_role;
grant execute on function public.fps_api_buy_with_coins(text, text) to service_role;
grant execute on function public.fps_api_open_orders(int) to service_role;

-- API가 새 함수를 바로 보도록 스키마 캐시를 다시 읽게 한다.
notify pgrst, 'reload schema';
