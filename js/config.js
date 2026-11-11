/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 배포 환경 설정. 새 Supabase 프로젝트의 URL과 Publishable key를 여기에 넣는다(docs/SUPABASE_SETUP.md).
 *          값이 비어 있으면 게임은 오프라인으로 동작한다: 연습장은 정상, 멀티플레이와 전역 닉네임 중복 검사만 꺼진다.
 *          Publishable(anon) key는 브라우저에 공개되는 키다. service_role key는 절대 넣지 않는다.
 *          transport는 멀티 메시지를 누가 중계하는지다: 'supabase'(Supabase Realtime) 또는 'relay'(server/relay의 Cloudflare 중계 서버).
 *          'relay'로 바꾸면 relay.url에 Worker 주소를 넣고 index.html CSP의 connect-src에 같은 주소(https·wss)를 더한다(server/relay/README.md).
 *          계정(닉네임·포인트)은 어느 쪽이든 Supabase를 쓴다.
 *          notice.key는 전체 공지(js/net/notice.js)의 서명을 확인하는 공개 열쇠다. 공개해도 되는 값이고, 짝이 되는 비밀 열쇠는 운영자만 가진다
 *          (tools/make-notice-key.mjs, docs/NOTICE.md). 비우면 공지 기능이 꺼진다. 공지는 transport가 'relay'일 때만 오간다.
 */
window.SKALA_CONFIG = {
  supabase: {
    url: 'https://tvsoacvbjvggqdgnzijc.supabase.co',
    anonKey: 'sb_publishable_rJg-uWBapq4V37XcAzLpZQ_Gp4p2Zb4'
  },
  transport: 'relay',
  relay: { url: 'https://skala-relay.skala-fps.workers.dev', hz: 20 },
  notice: { key: 'BNK5OrvWuP8gFyH0iyGnJUpzQceucA1qDLnpzzJMRoN1x4xwJyR2OSWMGiBZZ1yg4K12I9Pg6xeoQyAqvS1tsko' }
};
