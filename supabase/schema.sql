-- Date: 06NOV2026
-- Author: Minkyu Jung
-- Purpose: SKALA FPS 전용 Supabase 프로젝트의 계정 스키마. SQL Editor에서 처음부터 끝까지 실행하며, 여러 번 실행해도 안전하다.
--          테이블은 직접 접근을 막고 fps_* RPC(SECURITY DEFINER)로만 쓴다. 기기 토큰은 원문 대신 sha256만 저장한다.
--          닉네임 규칙은 js/account/nickname.js와 글자 단위로 같아야 한다(tests/account.test.mjs가 대조한다).
--          포인트와 전적은 클라이언트가 계산해 보낸 값을 범위만 확인해 저장한다. 치트를 막는 장치가 아니다.
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

-- ───────────── 사용자 함수 (RPC) ─────────────
-- 결과 모양: { ok: true, ... } 또는 { ok: false, error: 코드 }
-- 코드: NAME_INVALID, NAME_RESERVED, NAME_TAKEN, TOKEN_INVALID, NOT_FOUND, PROFILE_INVALID, PROFILE_TOO_LARGE

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
-- stats는 숫자 항목만 남기고 0~10억으로 자른다. fps_top_players가 숫자로 읽으므로 잘못된 값이 순위표를 깨뜨리지 못한다.
create or replace function public.fps_save_profile(
  p_token text, p_points int, p_owned jsonb, p_loadout jsonb, p_stats jsonb, p_secrets jsonb)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  v_hash text := public.fps_token_hash(p_token);
  v_stats jsonb;
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
  select coalesce(jsonb_object_agg(s.key, least(greatest(trunc((s.value #>> '{}')::numeric), 0), 1000000000)), '{}'::jsonb)
    into v_stats
    from jsonb_each(p_stats) as s
   where jsonb_typeof(s.value) = 'number';
  update public.fps_players
     set points = least(greatest(coalesce(p_points, points), 0), 10000000),
         owned = p_owned,
         loadout = p_loadout,
         stats = v_stats,
         secrets = p_secrets,
         updated_at = now()
   where token_hash = v_hash;
  if not found then return jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); end if;
  return jsonb_build_object('ok', true);
end $$;

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

revoke all on function public.fps_check_nickname(text) from public;
revoke all on function public.fps_claim_nickname(text, text) from public;
revoke all on function public.fps_get_profile(text) from public;
revoke all on function public.fps_save_profile(text, int, jsonb, jsonb, jsonb, jsonb) from public;
revoke all on function public.fps_top_players(int) from public;

grant execute on function public.fps_check_nickname(text) to anon, authenticated;
grant execute on function public.fps_claim_nickname(text, text) to anon, authenticated;
grant execute on function public.fps_get_profile(text) to anon, authenticated;
grant execute on function public.fps_save_profile(text, int, jsonb, jsonb, jsonb, jsonb) to anon, authenticated;
grant execute on function public.fps_top_players(int) to anon, authenticated;

-- API가 새 함수를 바로 보도록 스키마 캐시를 다시 읽게 한다.
notify pgrst, 'reload schema';
