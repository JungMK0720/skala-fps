/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 일시정지 메뉴(Esc). 계속하기, 설정, 조작법, 나가기를 보여 준다.
 */
import { h, btn, setText } from './dom.js';
import { makeScreen, createModal } from './parts.js';
import { createSettingsPanel } from './settings.js';
import { createControlsPanel } from './controls.js';

export function createPause(ctx) {
  const modal = createModal();
  const settingsPanel = createSettingsPanel(ctx, { onClose: () => modal.close() });
  const controlsPanel = createControlsPanel({ onClose: () => modal.close() });

  const note = h('p', { class: 'sk-pause-note' });
  const resumeBtn = btn('계속하기', () => {
    ctx.emit('pause:resume', {}); // 이 핸들러 안에서 requestPointerLock()을 부르면 된다(사용자 클릭 중)
    ctx.hideSelf('pause');
  }, 'sk-btn--primary sk-btn--big', { 'data-autofocus': '' });
  const leaveBtn = btn('방 나가기', () => { confirmBox.hidden = false; leaveYes.focus(); }, 'sk-btn--danger');
  const confirmText = h('p', { class: 'sk-confirm-text' });
  const leaveYes = btn('나가기', () => {
    confirmBox.hidden = true;
    ctx.emit('pause:leave', {});
    ctx.hideSelf('pause');
  }, 'sk-btn--danger');
  const confirmBox = h('div', { class: 'sk-confirm', hidden: true, role: 'alertdialog', 'aria-label': '나가기 확인' },
    confirmText,
    h('div', { class: 'sk-row' }, leaveYes, btn('취소', () => { confirmBox.hidden = true; leaveBtn.focus(); }, 'sk-btn--ghost')));

  const panel = h('div', { class: 'sk-pause-panel sk-steel', role: 'dialog', 'aria-label': '일시정지', tabindex: '-1' },
    h('div', { class: 'sk-hazard', 'aria-hidden': 'true' }),
    h('h2', { class: 'sk-pause-title sk-stencil', text: '일시정지' }),
    note,
    h('div', { class: 'sk-pause-btns' },
      resumeBtn,
      btn('설정', () => { settingsPanel.refresh(); modal.open(settingsPanel.el); }),
      btn('조작법', () => modal.open(controlsPanel.el)),
      leaveBtn),
    confirmBox);

  const el = h('section', { class: 'sk-screen sk-overlay sk-pause', hidden: true, 'aria-label': '일시정지 메뉴' }, panel, modal.el);

  function render(p) {
    const leaveLabel = p.leaveLabel || '방 나가기';
    setText(leaveBtn, leaveLabel);
    setText(leaveYes, leaveLabel);
    setText(confirmText, p.leaveConfirm || '정말 나갈까요? 진행 중인 매치에서 빠지게 돼요.');
    setText(note, p.note != null ? p.note : '멀티플레이 중에는 게임이 멈추지 않아요.');
    note.hidden = !note.textContent;
  }

  return makeScreen(el, {
    render,
    onShow: () => resumeBtn.focus({ preventScroll: true }),
    onHide: () => { confirmBox.hidden = true; modal.close(); },
  });
}
