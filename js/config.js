/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 배포 환경 설정. 새 Supabase 프로젝트의 URL과 Publishable key를 여기에 넣는다(docs/SUPABASE_SETUP.md).
 *          값이 비어 있으면 게임은 오프라인으로 동작한다: 연습장은 정상, 멀티플레이와 전역 닉네임 중복 검사만 꺼진다.
 *          Publishable(anon) key는 브라우저에 공개되는 키다. service_role key는 절대 넣지 않는다.
 */
window.SKALA_CONFIG = {
  supabase: {
    url: 'https://tvsoacvbjvggqdgnzijc.supabase.co',
    anonKey: 'sb_publishable_rJg-uWBapq4V37XcAzLpZQ_Gp4p2Zb4'
  }
};
