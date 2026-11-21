/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 캐릭터(아바타) 목록. id·이름·가격·설명과 상점 순서를 정한다. 모양은 engine/avatars.js가 이 id로 그리고, three.js에 의존하지 않아 node에서도 불러올 수 있다.
 */
/**
 * 캐릭터는 모두 직접 설계한 역할형 대원이다(상용 게임 캐릭터의 이름·외형을 따르지 않는다. DESIGN.md 1절).
 * 몸 치수와 히트박스(consts HITBOX)는 모두 같고, 머리 장비·조끼·부착물만 다르다. 전투복은 팀 색이라 어느 캐릭터든 팀이 잘 보인다.
 *
 * price: 상점 가격(0 = 기본 지급). 정본은 이 표이고 서버 가격표(supabase/schema.sql fps_item_price)와 같아야 한다(tests/account.test.mjs가 대조한다).
 * id는 'av_'로 시작한다. 서버는 이 머리글자로 장비 칸(loadout.avatar)을 검사한다.
 * 계정 장비 loadout.avatar에 고른 id를 두고, 방 presence의 av 칸으로 다른 사람에게 알린다. 모르는 id는 늘 기본 캐릭터로 읽는다.
 */
export const AVATARS = Object.freeze([
  Object.freeze({ id: 'av_trooper', name: '보병', nameEn: 'Trooper', icon: '🪖', price: 0, desc: '전술 헬멧과 방탄 조끼. 처음부터 함께하는 기본 대원', descEn: 'Tactical helmet and body armor. Your default operator' }),
  Object.freeze({ id: 'av_scout', name: '정찰병', nameEn: 'Scout', icon: '🔭', price: 300, desc: '후드와 이마에 올린 고글, 가벼운 가슴 조끼와 쌍안경', descEn: 'Hood, goggles up, light chest rig and binoculars' }),
  Object.freeze({ id: 'av_sapper', name: '공병', nameEn: 'Sapper', icon: '🛠️', price: 600, desc: '흰 안전모와 귀마개·헤드램프, 공구 벨트와 무릎 보호대', descEn: 'White hard hat, ear muffs, headlamp, tool belt and knee pads' }),
  Object.freeze({ id: 'av_signal', name: '통신병', nameEn: 'Signalman', icon: '📻', price: 800, desc: '정찰모와 헤드셋, 등에 멘 무전기와 긴 안테나', descEn: 'Patrol cap, headset and a backpack radio with a long antenna' }),
  Object.freeze({ id: 'av_ranger', name: '사막 레인저', nameEn: 'Desert Ranger', icon: '🌵', price: 1000, desc: '챙 넓은 모자와 선글라스, 목에 두른 스카프와 수통', descEn: 'Wide-brim hat, sunglasses, neck scarf and canteen' }),
  Object.freeze({ id: 'av_night', name: '야간 작전병', nameEn: 'Night Ops', icon: '🌙', price: 1400, desc: '검은 복면과 이마에 올린 야간 투시경, 검은 판 조끼', descEn: 'Black balaclava, NVGs up, black plate carrier' }),
  Object.freeze({ id: 'av_heavy', name: '중장갑병', nameEn: 'Juggernaut', icon: '🛡️', price: 2000, desc: '얼굴 가리개 헬멧과 두꺼운 판 갑옷, 어깨·무릎 보호대', descEn: 'Visored helmet, heavy plate armor, shoulder and knee guards' })
]);
export const AVATAR_IDS = Object.freeze(AVATARS.map((a) => a.id));
/** 처음부터 장착한 캐릭터(price 0) */
export const DEFAULT_AVATAR = 'av_trooper';

/** id → 캐릭터(없으면 null) */
export function avatarById(id) {
  return typeof id === 'string' ? AVATARS.find((a) => a.id === id) || null : null;
}

/** 아는 캐릭터 id인가 */
export function isAvatarId(id) {
  return typeof id === 'string' && AVATAR_IDS.includes(id);
}

/** 받은 값(저장소·네트워크·봇 설정) → 그릴 캐릭터 id. 모르는 값은 기본 캐릭터 */
export function avatarIdOf(id) {
  return isAvatarId(id) ? id : DEFAULT_AVATAR;
}
