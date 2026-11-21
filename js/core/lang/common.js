/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 여러 화면이 함께 쓰는 글자(확인·취소·닫기 등)와 부팅·game 플러그인 안내. 한 줄에 'key': ['한국어', 'English'] 하나(core/i18n.js).
 */
export default {
  'common.playerPrefix': ['플레이어', 'Player'],
  'common.fatalTitle': ['게임을 시작할 수 없어요', 'The game could not start'],
  'common.fatalWebgl': ['3D(WebGL)를 쓸 수 없어요. 브라우저의 하드웨어 가속을 켜거나 다른 브라우저로 열어 주세요.', 'WebGL is unavailable. Turn on hardware acceleration or try another browser.'],
  'common.fatalBoot': ['초기화 중 오류가 났어요.', 'Something went wrong while starting.'],
  'common.screenLobby': ['로비', 'Lobby'],
  'common.screenRoom': ['대기실', 'Room'],
  'common.screenMatch': ['멀티 경기', 'Online match'],
  'common.screenResults': ['결과', 'Results'],
  'common.screenNotReady': ['{screen} 화면은 아직 준비 중이에요.', '{screen} is not available yet.'],
  'common.multiUnavailable': ['멀티플레이를 열 수 없어요. 잠시 뒤 다시 시도해 주세요.', 'Multiplayer is unavailable. Please try again shortly.'],
  'common.error': ['오류가 났어요', 'Something went wrong'],
  'common.fullscreenDenied': ['이 브라우저 화면에서는 전체 화면을 켤 수 없어요. 앉은 채 앞으로 갈 때는 C 키를 쓰세요.', 'Fullscreen isn\'t available here. Use C to crouch-walk.'],
  'common.screenOpenFailed': ['{screen} 화면을 열지 못했어요: {detail}', 'Couldn\'t open {screen}: {detail}'],
  'common.mapLoadFailed': ['맵을 불러오지 못했어요: {detail}', 'Couldn\'t load the map: {detail}']
};
