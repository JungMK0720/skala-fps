/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 조작법 시트. 키 배치, 이동 기술, 맵 요소, 규칙을 메뉴와 일시정지가 같이 보여 준다.
 */
import { h, btn } from './dom.js';
import { sheet, keycap } from './parts.js';
import { t } from '../core/i18n.js';

const OR = '|'; // 키 사이 "또는"
const KEYS = [
  [['W', 'A', 'S', 'D'], t('hud.controls.key.move')],
  [[t('hud.controls.cap.mouse')], t('hud.controls.key.look')],
  [[t('hud.controls.cap.lmb')], t('hud.controls.key.fire')],
  [[t('hud.controls.cap.rmb')], t('hud.controls.key.zoom')],
  [['Space'], t('hud.controls.key.jump')],
  [['Ctrl', OR, 'C'], t('hud.controls.key.crouch')],
  [['Shift'], t('hud.controls.key.walk')],
  [['R'], t('hud.controls.key.reload')],
  [['E'], t('hud.controls.key.use')],
  [['F'], t('hud.controls.key.inspect')],
  [[t('hud.controls.cap.fHold')], t('hud.controls.key.revive')],
  [['G'], t('hud.controls.key.drop')],
  [['1', '2', '3', '4'], t('hud.controls.key.slots')],
  [[t('hud.controls.cap.wheel')], t('hud.controls.key.wheel')],
  [['N'], t('hud.controls.key.swap')],
  [['Tab'], t('hud.controls.key.score')],
  [['B'], t('hud.controls.key.emote')],
  [['Enter'], t('hud.controls.key.chat')],
  [['F11'], t('hud.controls.key.fullscreen')],
  [['Esc'], t('hud.controls.key.pause')],
];

/** 휴대폰 조작(engine/touch.js). html.pc-touch가 켜져 있으면 키 표 대신 보여 준다 */
const TOUCH_KEYS = [
  [[t('hud.controls.tcap.left')], t('hud.controls.tkey.left')],
  [[t('hud.controls.tcap.right')], t('hud.controls.tkey.right')],
  [[t('hud.controls.tcap.fire')], t('hud.controls.tkey.fire')],
  [[t('hud.controls.tcap.zoom')], t('hud.controls.tkey.zoom')],
  [[t('hud.controls.tcap.aimFire')], t('hud.controls.tkey.aimFire')],
  [[t('hud.controls.tcap.jump')], t('hud.controls.key.jump')],
  [[t('hud.controls.tcap.crouch')], t('hud.controls.tkey.crouch')],
  [[t('hud.controls.tcap.reload')], t('hud.controls.key.reload')],
  [[t('hud.controls.tcap.use')], t('hud.controls.tkey.use')],
  [[t('hud.controls.tcap.revive')], t('hud.controls.tkey.revive')],
  [[t('hud.controls.tcap.slots')], t('hud.controls.tkey.slots')],
  [[t('hud.controls.tcap.slotsHold')], t('hud.controls.tkey.slotsHold')],
  [[t('hud.controls.tcap.hint')], t('hud.controls.tkey.hint')],
  [[t('hud.controls.tcap.score')], t('hud.controls.key.score')],
  [[t('hud.controls.tcap.emote')], t('hud.controls.tkey.emote')],
  [[t('hud.controls.tcap.chat')], t('hud.controls.tkey.chat')],
  [['Ⅱ'], t('hud.controls.tkey.pause')],
];

const TOUCH_MOVES = [
  t('hud.controls.tmove1'),
  t('hud.controls.tmove2'),
];

const MOVES = [
  t('hud.controls.move1'),
  t('hud.controls.move2'),
  t('hud.controls.move3'),
  t('hud.controls.move4'),
];

const SHOTS = [
  t('hud.controls.shot1'),
  t('hud.controls.shot2'),
  t('hud.controls.shot3'),
];

const RULES = [
  t('hud.controls.rule1'),
  t('hud.controls.rule2'),
  t('hud.controls.rule3'),
  t('hud.controls.rule4'),
  t('hud.controls.rule5'),
];

const bullets = (lines) => h('ul', { class: 'sk-rules' }, lines.map((t) => h('li', { text: t })));

export function createControlsPanel({ onClose }) {
  const isTouch = document.documentElement.classList.contains('pc-touch');
  const moves = isTouch ? [...TOUCH_MOVES, ...MOVES.slice(2)] : MOVES;
  const list = h('ul', { class: 'sk-keys' },
    (isTouch ? TOUCH_KEYS : KEYS).map(([keys, desc]) => h('li', { class: 'sk-keys-row' },
      h('span', { class: 'sk-keys-caps' }, keys.map((k) => (k === OR ? h('span', { class: 'sk-keys-or', text: t('hud.controls.or') }) : keycap(k)))),
      h('span', { class: 'sk-keys-desc', text: desc }))));
  // Ctrl+W는 브라우저가 가로채 탭을 닫는다(전체 화면 키 잠금이 아니면 페이지가 막을 수 없음)
  const warn = h('p', { class: 'sk-keys-warn', role: 'note' },
    h('b', { text: t('hud.controls.warnTitle') }),
    h('span', { text: t('hud.controls.warnBody') }));
  const el = sheet({
    title: t('hud.controls.title'),
    kicker: 'CONTROLS',
    onClose,
    cls: 'sk-controls',
    body: [
      list, warn,
      h('h3', { class: 'sk-sub-title', text: t('hud.controls.subMoves') }), bullets(moves),
      h('h3', { class: 'sk-sub-title', text: t('hud.controls.subShots') }), bullets(SHOTS),
      h('h3', { class: 'sk-sub-title', text: t('hud.controls.subRules') }), bullets(RULES),
    ],
    foot: [btn(t('hud.controls.ok'), onClose, 'sk-btn--primary', { 'data-autofocus': '' })],
  });
  return { el };
}
