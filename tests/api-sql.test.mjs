/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: supabase/schema.sql의 로그인 연결·테스트 결제 절과 server/api Worker의 약속을 글자로 대조한다(실제 Postgres 없이).
 *          fps_api_* 함수는 SECURITY DEFINER이고 service_role만 부를 수 있다, 새 표는 RLS를 켜고 권한을 없앤다, 토큰을 읽는 RPC는 fps_player_id를 쓴다,
 *          Worker가 부르는 함수 이름·인자가 SQL과 같다, 코인 가격·주문 번호·상품 범위가 SQL 제약과 같다.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { COIN_DIVISOR } from '../js/account/economy.js';
import { EMOTE_IDS } from '../js/core/consts.js';
import { ORDER_RE, PRODUCT_LIST } from '../server/api/src/pay.js';

const sql = readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8');
const code = sql.split(/\r?\n/).filter((line) => !line.trimStart().startsWith('--')).join('\n');

/** 함수 이름 → { args: [이름], types: '...', head, body } */
function functions() {
  const out = new Map();
  const re = /create or replace function public\.(\w+)\(([\s\S]*?)\)\s*returns[\s\S]*?\$\$([\s\S]*?)\$\$;/g;
  for (const m of code.matchAll(re)) {
    const params = m[2].split(',').map((p) => p.trim()).filter(Boolean);
    out.set(m[1], {
      args: params.map((p) => p.split(/\s+/)[0]),
      types: params.map((p) => p.split(/\s+/).slice(1).join(' ').replace(/\s+default.*$/, '')).join(', '),
      head: m[0].slice(0, m[0].indexOf('$$')),
      body: m[3]
    });
  }
  return out;
}

const FNS = functions();
const API_FNS = [...FNS.keys()].filter((n) => n.startsWith('fps_api_'));

describe('schema.sql 로그인 연결·테스트 결제 절', () => {
  test('fps_api_* 함수는 SECURITY DEFINER이고 service_role만 부른다', () => {
    assert.ok(API_FNS.length >= 16, API_FNS.join());
    for (const name of API_FNS) {
      const f = FNS.get(name);
      assert.ok(f.head.includes('security definer set search_path = public, extensions'), name);
      assert.ok(code.includes(`revoke all on function public.${name}(${f.types}) from public, anon, authenticated;`), `${name} revoke`);
      assert.ok(code.includes(`grant execute on function public.${name}(${f.types}) to service_role;`), `${name} grant`);
      assert.ok(!new RegExp(`grant execute on function public\\.${name}\\([^)]*\\) to [^;]*\\b(anon|authenticated)\\b`).test(code), `${name}는 브라우저가 못 부른다`);
    }
  });

  test('새 내부 함수는 외부에서 부를 수 없다', () => {
    for (const [name, types] of [['fps_player_id', 'text'], ['fps_coin_price', 'text'], ['fps_ticket_once', 'text']]) {
      const f = FNS.get(name);
      assert.ok(f, name);
      assert.ok(!f.head.includes('security definer'), name);
      assert.ok(code.includes(`revoke all on function public.${name}(${types}) from public, anon, authenticated;`), name);
      assert.ok(!code.includes(`grant execute on function public.${name}`), name);
    }
  });

  test('새 표는 RLS를 켜고 직접 권한을 없앤다. 원장 번호도 막는다', () => {
    for (const t of ['fps_tokens', 'fps_identities', 'fps_auth_used', 'fps_orders', 'fps_coin_ledger']) {
      assert.match(code, new RegExp(`create table if not exists public\\.${t} \\(`), t);
      assert.match(code, new RegExp(`alter table public\\.${t} enable row level security;`), t);
      assert.match(code, new RegExp(`revoke all on public\\.${t} from public, anon, authenticated;`), t);
    }
    assert.match(code, /revoke all on sequence public\.fps_coin_ledger_id_seq from public, anon, authenticated;/);
    assert.match(code, /create unique index if not exists fps_coin_ledger_purchase_once on public\.fps_coin_ledger \(order_id\) where reason = 'purchase';/,
      '같은 주문으로 코인을 두 번 넣지 않는다');
  });

  test('토큰으로 사람을 찾는 RPC는 로그인으로 더한 기기 토큰도 본다(fps_player_id)', () => {
    for (const name of ['fps_get_profile', 'fps_save_profile', 'fps_send_feedback', 'fps_my_feedback', 'fps_claim_nickname']) {
      const f = FNS.get(name);
      assert.ok(f.body.includes('public.fps_player_id(v_hash)'), name);
      assert.ok(!/token_hash = v_hash/.test(f.body), `${name}에 예전 찾기가 남아 있다`);
    }
    assert.ok(FNS.get('fps_player_id').body.includes('t.revoked_at is null'), '로그아웃한 토큰은 쓰지 못한다');
  });

  test('코인 가격 규칙이 economy.js와 같다: 캐릭터(av_)와 모든 이모트, 포인트 가격의 10분의 1 올림', () => {
    const body = FNS.get('fps_coin_price').body;
    const listed = (body.match(/p_id in \(([^)]*)\)/) || [])[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
    assert.deepEqual(listed, [...EMOTE_IDS]);
    assert.ok(body.includes("left(p_id, 3) = 'av_'"));
    assert.ok(body.includes(`/ ${COIN_DIVISOR}.0)`));
    assert.ok(body.includes('ceil('));
  });

  test('주문 번호·상품이 SQL 제약 안이다', () => {
    const check = code.match(/order_id text primary key check \(order_id ~ '([^']+)'\)/)[1];
    assert.equal(check, ORDER_RE.source, 'Worker와 SQL의 주문 번호 모양이 같다');
    assert.ok(ORDER_RE.test(`skala_${'ab'.repeat(16)}`));
    for (const p of PRODUCT_LIST) {
      assert.ok(p.coins >= 1 && p.coins <= 100000, p.id);
      assert.ok(p.amount >= 100 && p.amount <= 1000000, p.id);
      assert.ok(p.id.length <= 32, p.id);
    }
  });

  test('로그아웃·만료는 지우지 않고 표시한다(다시 실행해도 안전한 파일 규칙)', () => {
    assert.ok(!/\b(delete from|truncate)\b/i.test(code));
    assert.ok(FNS.get('fps_api_logout').body.includes('set revoked_at = now()'));
    assert.ok(FNS.get('fps_api_login').body.includes('limit 10'), '한 사람의 로그인 기기 토큰은 10개까지');
  });

  test('stable 함수는 쓰지 않는다(PostgREST는 읽기 전용 트랜잭션으로 부른다)', () => {
    for (const [name, f] of FNS) {
      if (!/\bstable\b|\bimmutable\b/.test(f.head)) continue;
      assert.ok(!/\b(insert into|update public\.)/.test(f.body), name);
    }
  });
});

describe('Worker ↔ schema.sql', () => {
  const dir = new URL('../server/api/src/', import.meta.url);
  const sources = readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => readFileSync(new URL(f, dir), 'utf8')).join('\n');
  const calls = [...sources.matchAll(/db\.call\('(\w+)',\s*\{([^}]*)\}/g)].map((m) => ({
    fn: m[1],
    args: [...m[2].matchAll(/\b(p_\w+)\s*:/g)].map((a) => a[1])
  }));

  test('Worker가 부르는 함수가 모두 있고 인자 이름이 같다', () => {
    assert.ok(calls.length >= 15, `찾은 호출 ${calls.length}개`);
    for (const c of calls) {
      const f = FNS.get(c.fn);
      assert.ok(f, `${c.fn} 정의가 없다`);
      assert.ok(c.fn.startsWith('fps_api_'), `${c.fn}: Worker는 fps_api_* 만 부른다`);
      assert.deepEqual([...c.args].sort(), [...f.args].sort(), c.fn);
    }
  });

  test('SQL의 fps_api_* 함수는 모두 Worker가 쓴다', () => {
    const used = new Set(calls.map((c) => c.fn));
    for (const name of API_FNS) assert.ok(used.has(name), `${name}을(를) 부르는 곳이 없다`);
  });
});
