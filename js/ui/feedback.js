/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 건의하기 시트. 종류(버그·제안·밸런스·기타)와 내용을 적어 운영자에게 바로 보내고, 내가 보낸 건의와 운영자의 답을 본다.
 *          메뉴와 일시정지가 같이 쓴다. 보내기는 ctx.account.sendFeedback, 목록은 ctx.account.myFeedback(js/account/index.js).
 *          새 답이 왔는지는 이 기기의 localStorage에 '마지막으로 본 답 시각'을 적어 비교한다. 설계와 이유는 docs/FEEDBACK.md.
 */
import { h, btn, setText } from './dom.js';
import { sheet } from './parts.js';
import { VERSION } from '../core/consts.js';
import {
  FEEDBACK_KINDS, FEEDBACK_KIND_NAMES, FEEDBACK_MAX, FEEDBACK_MESSAGES, FEEDBACK_MIN, FEEDBACK_STATUS_NAMES,
  feedbackLength, latestReplyAt, validateFeedback
} from '../account/feedback.js';

export const FEEDBACK_LOCAL_KEY = 'skalafps.feedback.v1';
const DEFAULT_KIND = 'idea';
const PLACEHOLDER = {
  bug: '어떤 맵·모드에서 무엇을 하다가 어떻게 됐는지 적어 주세요. 예) 중계 기지 폭파 미션에서 B 구역 계단을 오르면 벽에 끼어요',
  idea: '있으면 좋겠는 기능이나 바꾸고 싶은 점을 적어 주세요',
  balance: '어떤 무기·모드가 너무 세거나 약한지, 왜 그렇게 느꼈는지 적어 주세요',
  other: '운영자에게 하고 싶은 말을 적어 주세요'
};

/** 이 기기의 기록 { sent: 보낸 적 있음, seen: 마지막으로 본 답 시각(ms) }. 저장소가 막혀 있으면 빈 값 */
export function readFeedbackLocal() {
  try {
    const v = JSON.parse(localStorage.getItem(FEEDBACK_LOCAL_KEY) || 'null');
    return { sent: !!(v && v.sent), seen: Number(v && v.seen) || 0 };
  } catch { return { sent: false, seen: 0 }; }
}
export function writeFeedbackLocal(patch) {
  const next = { ...readFeedbackLocal(), ...patch };
  try { localStorage.setItem(FEEDBACK_LOCAL_KEY, JSON.stringify(next)); } catch { /* 저장 불가(사파리 개인 모드 등) */ }
  return next;
}

/** 사용자 에이전트 → 'Edge 157' 같은 짧은 이름. 버그 재현에만 쓴다 */
export function shortBrowser(ua) {
  const s = String(ua || '');
  const pick = [[/Edg\/(\d+)/, 'Edge'], [/SamsungBrowser\/(\d+)/, 'Samsung'], [/Whale\/(\d+)/, 'Whale'], [/Firefox\/(\d+)/, 'Firefox'],
    [/Chrome\/(\d+)/, 'Chrome'], [/Version\/(\d+)[\d.]* .*Safari/, 'Safari']];
  for (const [re, name] of pick) { const m = s.match(re); if (m) return `${name} ${m[1]}`; }
  return 'other';
}

const two = (n) => String(n).padStart(2, '0');
function fmtWhen(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return `${d.getMonth() + 1}월 ${d.getDate()}일 ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/**
 * @param {object} ctx  UI 컨텍스트(ctx.account가 있어야 보낼 수 있다)
 * @param {{ onClose: Function, where: 'menu'|'pause', onSeen?: Function }} opts
 *   onSeen: 목록을 그려 새 답을 본 것으로 적었을 때(메뉴가 새 답 표시를 끈다)
 * @returns {{ el, refresh(info?), get kind(), get text() }}  refresh(info): 열기 직전에 부른다. info는 { mode, map } 같은 진단 정보
 */
export function createFeedbackPanel(ctx, { onClose, where = 'menu', onSeen } = {}) {
  let kind = DEFAULT_KIND;
  let sending = false;
  let info = {};
  let loadSeq = 0;

  const kindBtns = FEEDBACK_KINDS.map((k) => {
    const b = btn(FEEDBACK_KIND_NAMES[k], () => pickKind(k), 'sk-seg-btn', { role: 'radio', 'data-kind': k });
    return b;
  });
  const kindRow = h('div', { class: 'sk-seg sk-fb-kinds', role: 'radiogroup', 'aria-label': '건의 종류' }, kindBtns);
  kindRow.addEventListener('keydown', (e) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    const i = FEEDBACK_KINDS.indexOf(kind);
    const next = FEEDBACK_KINDS[(i + step + FEEDBACK_KINDS.length) % FEEDBACK_KINDS.length];
    e.preventDefault(); e.stopPropagation();
    pickKind(next);
    kindBtns[FEEDBACK_KINDS.indexOf(next)].focus();
  });

  const area = h('textarea', {
    class: 'sk-input sk-fb-text', rows: '6', maxlength: String(FEEDBACK_MAX), 'aria-label': '건의 내용',
    'data-autofocus': '', spellcheck: 'false'
  });
  const count = h('span', { class: 'sk-fb-count', 'aria-live': 'off' });
  const gate = h('p', { class: 'sk-fb-gate', role: 'note', hidden: true });
  const status = h('p', { class: 'sk-fb-status', role: 'status' });
  const sendBtn = btn('보내기', () => send(), 'sk-btn--primary sk-fb-send');
  const list = h('ul', { class: 'sk-fb-list', 'aria-label': '내가 보낸 건의' });
  const listNote = h('p', { class: 'sk-fb-list-note' });
  const listBox = h('section', { class: 'sk-fb-mine', 'aria-label': '내가 보낸 건의' },
    h('h3', { class: 'sk-sub-title', text: '내가 보낸 건의와 답' }), listNote, list);

  area.addEventListener('input', () => { paintCount(); if (status.dataset.tone === 'bad') clearStatus(); });
  // Ctrl+Enter(맥은 Cmd+Enter)로 보낸다. 그냥 Enter는 줄바꿈
  area.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); }
  });

  const el = sheet({
    title: '건의하기',
    onClose: () => onClose && onClose(),
    cls: 'sk-feedback',
    body: [
      h('p', { class: 'sk-fb-intro', text: '버그, 아이디어, 밸런스 의견을 운영자에게 바로 보내요. 보낸 글은 운영자만 읽어요.' }),
      gate,
      h('div', { class: 'sk-field' }, h('span', { class: 'sk-field-label', text: '종류' }), kindRow),
      h('label', { class: 'sk-field' },
        h('span', { class: 'sk-field-label', text: '내용' }),
        area,
        h('span', { class: 'sk-fb-meta' },
          h('span', { class: 'sk-field-hint', text: '닉네임과 함께 전해져요. 이메일·전화번호 같은 개인정보는 적지 마세요.' +
            (document.documentElement.classList.contains('pc-touch') ? '' : ' Ctrl+Enter로 보내기') }),
          count)),
      status,
      listBox
    ],
    foot: [btn('닫기', () => onClose && onClose(), 'sk-btn--ghost'), sendBtn]
  });

  function pickKind(k) {
    if (!FEEDBACK_KINDS.includes(k)) return;
    kind = k;
    kindBtns.forEach((b, i) => {
      const on = FEEDBACK_KINDS[i] === k;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    });
    area.placeholder = PLACEHOLDER[k];
  }

  function paintCount() {
    const n = feedbackLength(area.value);
    setText(count, `${n} / ${FEEDBACK_MAX}`);
    count.classList.toggle('is-short', n > 0 && n < FEEDBACK_MIN);
    paintSend();
  }

  /** 지금 보낼 수 없는 이유(문구). 빈 문자열이면 보낼 수 있다 */
  function blockReason() {
    const a = ctx.account;
    if (!a || typeof a.sendFeedback !== 'function' || !a.remoteEnabled) return FEEDBACK_MESSAGES.offline;
    if (a.feedbackBox === 'closed') return FEEDBACK_MESSAGES.closed;
    return '';
  }

  function paintSend() {
    const blocked = !!blockReason();
    sendBtn.disabled = sending || blocked || feedbackLength(area.value.trim()) < FEEDBACK_MIN;
    setText(sendBtn, sending ? '보내는 중…' : '보내기');
  }

  function setStatus(text, tone) {
    setText(status, text || '');
    status.dataset.tone = tone || '';
  }
  const clearStatus = () => setStatus('', '');

  function paintGate() {
    const reason = blockReason();
    setText(gate, reason);
    gate.hidden = !reason;
    listBox.hidden = !!reason;
    paintSend();
  }

  async function send() {
    if (sending || blockReason()) return;
    const v = validateFeedback({ kind, body: area.value });
    if (!v.ok) { setStatus(v.message, 'bad'); area.focus(); return; }
    sending = true;
    // 누른 보내기 버튼이 꺼지면 포커스가 body로 빠져 Esc가 시트(모달)에 닿지 않는다. 시트에 포커스를 둔다
    // (글 칸에 두면 휴대폰 키보드가 다시 올라오므로, Ctrl+Enter로 보내 이미 글 칸에 있을 때만 그대로 둔다)
    if (document.activeElement !== area) el.focus({ preventScroll: true });
    paintSend();
    setStatus('보내는 중…', '');
    let r;
    try {
      r = await ctx.account.sendFeedback({ kind, body: v.body, info: diagInfo() });
    } catch (_) {
      r = { ok: false, reason: 'network', message: FEEDBACK_MESSAGES.network };
    }
    sending = false;
    if (r && r.ok) {
      area.value = '';
      writeFeedbackLocal({ sent: true });
      setStatus(r.message || FEEDBACK_MESSAGES.sent, 'good');
      ctx.emit('feedback:sent', { kind, where });
      loadList();
    } else {
      setStatus((r && r.message) || FEEDBACK_MESSAGES.network, 'bad');
    }
    paintCount();
    paintGate();
  }

  function diagInfo() {
    const touch = document.documentElement.classList.contains('pc-touch');
    const out = {
      where, ver: VERSION, touch,
      scr: `${Math.round(window.innerWidth || 0)}x${Math.round(window.innerHeight || 0)}`,
      br: shortBrowser(navigator.userAgent)
    };
    if (info && typeof info.mode === 'string') out.mode = info.mode;
    if (info && typeof info.map === 'string') out.map = info.map;
    return out;
  }

  /** seenBefore: 이 기기에서 마지막으로 본 답 시각. 그 뒤에 온 답은 강조한다 */
  function renderItems(items, seenBefore = Infinity) {
    list.replaceChildren(...items.map((it) => h('li', { class: 'sk-fb-item' + (it.reply ? ' has-reply' : '') + (it.reply && it.repliedAt > seenBefore ? ' is-new' : '') },
      h('div', { class: 'sk-fb-item-head' },
        h('span', { class: 'sk-chip', text: FEEDBACK_KIND_NAMES[it.kind] || '기타' }),
        h('span', { class: 'sk-badge sk-fb-st sk-fb-st--' + it.status, text: FEEDBACK_STATUS_NAMES[it.status] || '접수' }),
        h('time', { class: 'sk-fb-when', text: fmtWhen(it.at) })),
      h('p', { class: 'sk-fb-body', text: it.body }),
      it.reply ? h('div', { class: 'sk-fb-reply' },
        h('span', { class: 'sk-fb-reply-who', text: `운영자 답 · ${fmtWhen(it.repliedAt)}` }),
        h('p', { class: 'sk-fb-reply-text', text: it.reply })) : null)));
  }

  async function loadList() {
    const a = ctx.account;
    if (!a || typeof a.myFeedback !== 'function' || blockReason()) return;
    const seq = ++loadSeq;
    setText(listNote, '불러오는 중…');
    listNote.hidden = false;
    let r;
    try { r = await a.myFeedback(); } catch (_) { r = { ok: false, items: [] }; }
    if (seq !== loadSeq) return;
    const items = (r && Array.isArray(r.items)) ? r.items : [];
    const seenBefore = readFeedbackLocal().seen;
    renderItems(items, seenBefore);
    if (!r || !r.ok) setText(listNote, r && r.reason === 'closed' ? FEEDBACK_MESSAGES.closed : '목록을 불러오지 못했어요.');
    else setText(listNote, items.length ? '' : '아직 보낸 건의가 없어요.');
    listNote.hidden = !listNote.textContent;
    paintGate();
    const latest = latestReplyAt(items);
    if (r && r.ok && latest > seenBefore) {
      writeFeedbackLocal({ seen: latest });
      if (onSeen) onSeen(latest);
      // 새 답은 글 칸 아래에 있어 바로 안 보인다. 처음 새 답이 보이게 시트 안을 굴린다
      const fresh = list.querySelector('.sk-fb-item.is-new');
      if (fresh && el.isConnected && typeof fresh.scrollIntoView === 'function') fresh.scrollIntoView({ block: 'nearest' });
    }
  }

  /** 열기 직전에 부른다. 성공 문구는 지우고(쓰던 글과 실패 문구는 남긴다) 목록을 새로 읽는다 */
  function refresh(nextInfo) {
    info = nextInfo && typeof nextInfo === 'object' ? nextInfo : {};
    if (status.dataset.tone === 'good') clearStatus();
    paintCount();
    paintGate();
    loadList();
  }

  pickKind(DEFAULT_KIND);
  paintCount();
  return { el, refresh, get kind() { return kind; }, get text() { return area.value; } };
}
