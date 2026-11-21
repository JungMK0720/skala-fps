/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 접속·방 연결·공지 오류와 안내 글자. 한 줄에 'key': ['한국어', 'English'] 하나(core/i18n.js).
 */
export default {
  'net.relayUrlNeeded': ['중계 서버 주소(http(s)://…)가 필요합니다', 'A relay server URL (http(s)://…) is required'],
  'net.noWebSocket': ['이 환경에는 WebSocket이 없습니다', 'WebSocket is not available in this environment'],
  'net.alreadyClosed': ['이미 닫힌 연결입니다', 'The connection is already closed'],
  'net.closed': ['연결이 닫혔습니다', 'The connection was closed'],
  'net.relayConnectFail': ['중계 서버에 연결하지 못했습니다', 'Couldn\'t connect to the relay server'],
  'net.unknownTransport': ['모르는 전송 방식입니다: {transport}', 'Unknown transport: {transport}'],
  'net.relayUrlMissing': ['중계 서버 주소(relay.url)가 없습니다', 'Relay server URL (relay.url) is missing'],
  'net.supabaseMissing': ['Supabase 접속 정보(url, key)가 없습니다', 'Supabase connection info (url, key) is missing'],
  'net.badPlayerId': ['playerId는 영문·숫자·_- 1~40자', 'playerId must be 1-40 chars of letters, digits, _ or -'],
  'net.defaultPlayer': ['플레이어-{id}', 'Player-{id}'],
  'net.supabaseNeeded': ['Supabase url/key가 필요합니다', 'Supabase url/key is required'],
  'net.realtimeConnectFail': ['Realtime 서버에 연결하지 못했습니다', 'Couldn\'t connect to the Realtime server'],
  'net.joinTimeout': ['채널 참가 시간 초과: {topic}', 'Channel join timed out: {topic}'],
  'net.joinError': ['채널 참가 실패: {reason}', 'Channel join failed: {reason}'],
  'net.leftChannel': ['채널에서 나갔습니다', 'Left the channel'],
  'net.defaultRoom': ['{name}의 방', '{name}\'s Room'],
  'net.badRoomId': ['잘못된 방 ID입니다', 'Invalid room ID'],
  'net.badPassword': ['비밀번호가 맞지 않습니다', 'Wrong password'],
  'net.needPassword': ['비밀번호가 필요한 방입니다', 'This room requires a password'],
  'net.roomNotFound': ['방을 찾을 수 없습니다', 'Room not found'],
  'net.roomFull': ['방이 가득 찼습니다', 'Room is full'],
  'net.trackFailed': ['presence 등록 실패: {status}', 'Presence registration failed: {status}'],
  'net.noCrypto': ['이 브라우저는 비밀번호 방을 지원하지 않아요', 'This browser doesn\'t support password rooms'],
};
