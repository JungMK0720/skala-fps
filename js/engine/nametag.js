/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 원격 아바타 머리 위 이름표의 규칙(순수 함수). 아군은 이름을 벽 너머로도 보이고, 적은 이름을 숨기고 상태 표시(🛡 부활 보호)만 가까이에서 보인다.
 *          three.js·DOM에 의존하지 않아 node 테스트에서 그대로 쓴다. 그리기는 engine/avatars.js가 맡는다.
 */
/**
 * 아군 = 같은 팀(avatars.setLocalTeam). 개인전은 내 팀이 없어서 다른 사람이 모두 적이다.
 *   아군: "💣 하늘"처럼 상태 표시 + 이름. 깊이 검사를 꺼서 벽 너머로도 보인다.
 *   적:   이름은 없다. 상태 표시가 있을 때만(개인전 부활 보호 🛡) 그 글자만 ENEMY_TAG_RANGE 안에서, 벽에 가려지게 보인다.
 * 상태 표시(badge)는 World가 정한다: 🛡 = 부활 보호 중(개인전), 💣 = 폭탄을 든 아군(폭파 미션, 내가 공격 팀일 때만).
 */
export const ENEMY_TAG_RANGE = 35;

const clean = (v) => (v == null ? '' : String(v).trim());

/** 이름표 글자. ''면 이름표를 그리지 않는다 */
export function tagText(name, badge, ally) {
  const n = clean(name), b = clean(badge);
  if (!ally) return b;
  return b && n ? `${b} ${n}` : b || n;
}

/**
 * 이번 프레임에 이름표를 보일까.
 * o = { text, ally, alive, visible, local, dist }: text = tagText 결과, local = 3인칭 때의 내 몸, dist = 카메라와의 수평 거리(m, 모르면 0)
 */
export function tagShown(o) {
  const s = o && typeof o === 'object' ? o : {};
  if (!s.text || s.local || !s.alive || s.visible === false) return false;
  return !!s.ally || !(Number(s.dist) >= ENEMY_TAG_RANGE);
}
