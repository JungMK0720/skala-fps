/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 일시정지 메뉴(Esc). 계속하기, 전체 화면(브라우저 단축키 잠금) 켜고 끄기, 설정, 조작법, 건의하기, 나가기를 보여 준다.
 *          건의하기는 메뉴와 같은 시트(ui/feedback.js)이고, 경기의 모드·맵(props.info)을 진단 정보로 함께 보낸다.
 */
import { h, btn, setText } from './dom.js';
import { createStatusRow } from './status.js';
import { makeScreen, createModal } from './parts.js';
import { createSettingsPanel, canLockKeys } from './settings.js';
import { createControlsPanel } from './controls.js';
import { createFeedbackPanel } from './feedback.js';

export function createPause(ctx) {
  const modal = createModal();
  const settingsPanel = createSettingsPanel(ctx, { onClose: () => modal.close() });
  const controlsPanel = createControlsPanel({ onClose: () => modal.close() });
  const feedbackPanel = createFeedbackPanel(ctx, { onClose: () => modal.close(), where: 'pause' });
  let info = null;
  const feedbackBtn = btn('건의하기', () => { feedbackPanel.refresh(info); modal.open(feedbackPanel.el); });

  const note = h('p', { class: 'sk-pause-note' });
  const details = h('div', { class: 'sk-pause-details', hidden: true });
  // 좀비 모드: 지금 걸린 버프·디버프(HUD 체력 칸 위 줄과 같은 칩). 마우스를 올리거나 Tab으로 초점을 주면 설명이 뜬다.
  // details를 다시 그려도 이 묶음은 그대로 쓰고, update('pause', { status })는 이 줄만 고친다(멀티는 게임이 멈추지 않는다)
  const statusRow = createStatusRow({ cls: 'sk-status sk-status--pause', tips: true });
  const statusEmpty = h('p', { class: 'sk-pause-empty', text: '지금 걸린 버프·디버프가 없어요.' });
  const statusGroup = h('section', { class: 'sk-pause-detail-group sk-pause-status-group', 'aria-label': '버프와 디버프' },
    h('h3', { text: '버프·디버프' }),
    h('p', { class: 'sk-pause-status-legend', text: '빨간 테두리 = 버프 · 초록 테두리 = 디버프 · 마우스를 올리면 설명' }),
    statusRow.el, statusEmpty);
  function applyStatus(list) {
    statusRow.apply(list);
    statusEmpty.hidden = !statusRow.el.hidden;
  }
  const resumeBtn = btn('계속하기', () => {
    ctx.emit('pause:resume', {}); // 이 핸들러 안에서 requestPointerLock()을 부르면 된다(사용자 클릭 중)
    ctx.hideSelf('pause');
  }, 'sk-btn--primary sk-btn--big', { 'data-autofocus': '' });
  // 전체 화면: 설정의 '전체 화면' 항목과 같은 값을 바꾼다(main.js가 실제 전체 화면을 켜고 끈다). 휴대폰에는 없다
  const isTouch = document.documentElement.classList.contains('pc-touch');
  const fullOn = () => ctx.setting('fullscreen') === 'on';
  // 브라우저가 전체 화면을 거절하면 main.js가 설정을 되돌린다 → 잠시 뒤에 한 번 더 그린다
  const fullBtn = btn('', () => { ctx.setSetting('fullscreen', fullOn() ? 'off' : 'on'); paintFull(); ctx.later(paintFull, 600); });
  fullBtn.hidden = isTouch;
  function paintFull() {
    const lock = canLockKeys() ? ' · Ctrl+W·Tab 잠금' : '';
    setText(fullBtn, fullOn() ? '전체 화면 끄기' : `전체 화면 켜기${lock}`);
    fullBtn.setAttribute('aria-pressed', fullOn() ? 'true' : 'false');
  }
  if (!isTouch) ctx.listen(document, 'fullscreenchange', () => ctx.later(paintFull, 0));
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
    details,
    h('div', { class: 'sk-pause-btns' },
      resumeBtn,
      fullBtn,
      btn('설정', () => { settingsPanel.refresh(); modal.open(settingsPanel.el); }),
      btn('조작법', () => modal.open(controlsPanel.el)),
      feedbackBtn,
      leaveBtn),
    confirmBox);

  const el = h('section', { class: 'sk-screen sk-overlay sk-pause', hidden: true, 'aria-label': '일시정지 메뉴' }, panel, modal.el);

  function render(p, { patch } = {}) {
    // 버프·디버프만 바뀐 갱신(매 프레임)은 그 줄만 고친다
    if (patch && 'status' in patch && Object.keys(patch).length === 1) { applyStatus(patch.status); return; }
    const leaveLabel = p.leaveLabel || '방 나가기';
    setText(leaveBtn, leaveLabel);
    setText(leaveYes, leaveLabel);
    setText(confirmText, p.leaveConfirm || '정말 나갈까요? 진행 중인 매치에서 빠지게 돼요.');
    setText(note, p.note != null ? p.note : '멀티플레이 중에는 게임이 멈추지 않아요.');
    note.hidden = !note.textContent;
    details.hidden = !p.details;
    panel.classList.toggle('sk-pause-panel--stats', !!p.details);
    if (p.details) {
      const cards = Array.isArray(p.details.cards) ? p.details.cards : [];
      const stats = Array.isArray(p.details.stats) ? p.details.stats : [];
      const status = 'status' in p ? p.status : p.details.status;
      if (Array.isArray(status)) applyStatus(status);
      details.replaceChildren(
        ...(Array.isArray(status) ? [statusGroup] : []),
        h('section', { class: 'sk-pause-detail-group', 'aria-label': '획득한 증강' },
          h('h3', { text: `획득한 증강 · ${cards.reduce((n, c) => n + (c.count || 1), 0)}장` }),
          cards.length ? h('div', { class: 'sk-pause-card-list' },
            ...cards.map((c) => h('div', { class: 'sk-pause-card' },
              h('strong', { text: `${c.icon || ''} ${c.name}${c.count > 1 ? ` ×${c.count}` : ''}` }),
              h('small', { text: c.desc || '' })))
          ) : h('p', { class: 'sk-pause-empty', text: '아직 획득한 증강이 없어요.' })),
        h('section', { class: 'sk-pause-detail-group', 'aria-label': '현재 능력치' },
          h('h3', { text: '현재 능력치' }),
          h('dl', { class: 'sk-pause-stats' },
            ...stats.flatMap((s) => [h('dt', { text: s.label }), h('dd', { text: s.value })])))
      );
    } else { details.replaceChildren(); applyStatus(null); }
    info = p.info && typeof p.info === 'object' ? p.info : null;
    feedbackBtn.hidden = !ctx.account || !ctx.account.remoteEnabled;
    paintFull();
  }

  return makeScreen(el, {
    render,
    onShow: () => resumeBtn.focus({ preventScroll: true }),
    onHide: () => { confirmBox.hidden = true; modal.close(); },
  });
}
