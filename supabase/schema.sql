-- Date: 06NOV2026
-- Author: Minkyu Jung
-- Purpose: SKALA 작전 전용 Supabase 프로젝트의 계정 스키마. SQL Editor에서 처음부터 끝까지 실행하며, 여러 번 실행해도 안전하다.
--          테이블은 직접 접근을 막고 fps_* RPC(SECURITY DEFINER)로만 쓴다. 기기 토큰은 원문 대신 sha256만 저장한다.
--          닉네임 규칙은 js/account/nickname.js와 글자 단위로 같아야 한다(tests/account.test.mjs가 대조한다).
--          포인트와 전적은 클라이언트가 계산해 보내지만, 서버가 늘어나는 속도(통으로 채우는 한도)와 새로 산 무기의 가격을 확인해
--          한도를 넘는 만큼은 버린다. 닉네임 등록은 같은 IP에서 한 시간에 60번까지다. 경기 판정은 방장 브라우저가 한다(js/game/anticheat.js).
--          멀티 채널(skalafps:lobby, skalafps:room:<id>)은 Realtime Broadcast·Presence만 쓰므로 테이블이 필요 없다.

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
create or replace function public.fps_claim_nickname(p_token text, p_name text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_hash text := public.fps_token_hash(p_token);
  v_name text := public.fps_clean_name(p_name);
  v_err text := public.fps_name_error(p_name);
begin
  if v_hash is null then return jsonb_build_object('ok', false, 'error', 'TOKEN_INVALID'); end if;
  if v_err is not null then return jsonb_build_object('ok', false, 'error', v_err); end if;
  -- 같은 IP에서 한 시간에 60번까지(교실처럼 여러 명이 한 IP를 써도 넉넉하게). 넘으면 잠시 뒤 다시 시도하게 한다
  if not public.fps_rate_ok('claim', 60, interval '1 hour') then
    return jsonb_build_object('ok', false, 'error', 'RATE_LIMITED');
  end if;
  begin
    insert into public.fps_players (token_hash, name, name_key)
    values (v_hash, v_name, lower(v_name))
    on conflict (token_hash) do update
      set name = excluded.name, name_key = excluded.name_key, updated_at = now();
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
  select * into v from public.fps_players where token_hash = v_hash;
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
  select * into v from public.fps_players where token_hash = v_hash for update;
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
create or replace function public.fps_features() returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select jsonb_build_object('ok', true, 'avatars', true)
$$;

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

-- ───────────── 실행 권한 ─────────────
grant usage on schema public to anon, authenticated;

revoke all on function public.fps_clean_name(text) from public, anon, authenticated;
revoke all on function public.fps_name_error(text) from public, anon, authenticated;
revoke all on function public.fps_token_hash(text) from public, anon, authenticated;
revoke all on function public.fps_owned_ok(jsonb) from public, anon, authenticated;
revoke all on function public.fps_item_price(text) from public, anon, authenticated;
revoke all on function public.fps_client_key() from public, anon, authenticated;
revoke all on function public.fps_rate_ok(text, int, interval) from public, anon, authenticated;

revoke all on function public.fps_check_nickname(text) from public;
revoke all on function public.fps_claim_nickname(text, text) from public;
revoke all on function public.fps_get_profile(text) from public;
revoke all on function public.fps_save_profile(text, int, jsonb, jsonb, jsonb, jsonb) from public;
revoke all on function public.fps_top_players(int) from public;
revoke all on function public.fps_features() from public;

grant execute on function public.fps_check_nickname(text) to anon, authenticated;
grant execute on function public.fps_claim_nickname(text, text) to anon, authenticated;
grant execute on function public.fps_get_profile(text) to anon, authenticated;
grant execute on function public.fps_save_profile(text, int, jsonb, jsonb, jsonb, jsonb) to anon, authenticated;
grant execute on function public.fps_top_players(int) to anon, authenticated;
grant execute on function public.fps_features() to anon, authenticated;

-- API가 새 함수를 바로 보도록 스키마 캐시를 다시 읽게 한다.
notify pgrst, 'reload schema';
