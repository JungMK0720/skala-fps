/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 게임 이름(브랜드)을 한곳에 둔다. 화면에 보이는 이름은 모두 여기서 읽는다. 이름을 바꿀 때는 이 값과
 *          정적 파일(index.html·privacy.html·server/api/src/pages.js)을 함께 바꾼다(docs/MIGRATION.md 브랜드 절).
 *          three.js에 의존하지 않아 node에서도 불러올 수 있다.
 */
export const BRAND = Object.freeze({
  name: 'SKALA 작전',   // 한국어 화면 이름
  nameEn: 'SKALA OPS'   // 영어 화면 이름
});
