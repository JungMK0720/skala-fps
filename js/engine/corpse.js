/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 쓰러진 대원 몸의 시간표(순수 함수). 쓰러지는 동작을 끝까지 보여 준 뒤 바닥에 누운 채 잠깐 있다가 땅으로 가라앉아 사라진다.
 *          three.js·DOM에 의존하지 않아 node 테스트에서 그대로 쓴다. 그리기는 engine/avatars.js가 맡는다.
 */
/**
 * HOLD  = 쓰러진 뒤 누운 채 그대로 있는 시간(초). 쓰러짐 동작(약 1.04초)이 끝나고도 잠깐 누워 있다
 * SINK  = 그다음 땅으로 가라앉는 시간(초). 끝나면 부활할 때까지 몸을 숨긴다(HOLD + SINK ≈ 3초)
 * DEPTH = 가라앉는 깊이(m). 누운 몸 두께보다 깊어 바닥 위에 아무것도 남지 않는다
 */
export const CORPSE = Object.freeze({ HOLD: 1.9, SINK: 1.0, DEPTH: 0.6 });

/**
 * 쓰러진 지 t초 된 몸을 어떻게 그릴까. t가 숫자가 아니면 막 쓰러진 것으로 본다. out을 주면 거기에 채운다(매 프레임 새 객체를 만들지 않게).
 * @returns {{ sink: number, shown: boolean }} sink = 발바닥 원점을 내릴 깊이(m), shown = 아직 보이는가
 */
export function corpseState(t, out = { sink: 0, shown: true }) {
  const s = Number.isFinite(t) ? Math.max(0, t) : 0;
  const k = (s - CORPSE.HOLD) / CORPSE.SINK;
  if (k <= 0) { out.sink = 0; out.shown = true; }
  else if (k >= 1) { out.sink = CORPSE.DEPTH; out.shown = false; }
  else { out.sink = CORPSE.DEPTH * k * k * (3 - 2 * k); out.shown = true; }
  return out;
}
