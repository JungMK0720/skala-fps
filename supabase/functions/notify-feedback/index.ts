/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: Supabase Edge Function notify-feedback의 진입점. Deno.serve에 core.js의 handle을 잇고 비밀은 Edge Function secret에서 읽는다.
 *          규칙은 모두 core.js에 있다(Node 시험이 같은 코드를 돌린다). 설정과 배포는 docs/FEEDBACK.md 7절.
 */
import { ENV_NAMES, handle } from './core.js';

Deno.serve((request: Request) => {
  const env: Record<string, string> = {};
  for (const name of ENV_NAMES) env[name] = Deno.env.get(name) ?? '';
  return handle(request, env, { fetch });
});
