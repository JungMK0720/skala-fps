/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 전체 공지 띠. 운영자가 보낸 공지를 화면 맨 위 가운데에 띄우고 정해진 시간이 지나면 내린다.
 *          메뉴·로비·경기 어느 화면 위에나 뜨고, 클릭을 가로채지 않는다. 떠 있는 동안 경기 HUD의 윗줄을 그 높이만큼 내린다.
 */
import { h } from './dom.js';

/** 띠가 떠 있는 시간의 범위(ms). 공지를 보내는 쪽이 정한 시간을 이 안으로 자른다 */
export const NOTICE_SHOW = Object.freeze({ min: 3000, max: 3600000, def: 30000 });
/** 본문 글자 수 상한. 보내는 쪽(net/notice.js)의 상한과 같다 */
const MAX_CHARS = 200;
const HIDE_ANIM_MS = 220;

const cleanText = (v) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS);

/**
 * @param {{ root:HTMLElement, later(fn, ms):any, cancel(id):void }} ctx UI 루트와 타이머(js/ui/index.js의 ctx)
 * @returns {{ el:HTMLElement, show(o:{id?, text, ms?}):boolean, hide(id?):boolean, current():object|null, dispose():void }}
 */
export function createNoticeBanner(ctx) {
  const text = h('span', { class: 'sk-notice-text' });
  const el = h('div', { class: 'sk-notice', role: 'status', 'aria-live': 'polite', hidden: true },
    h('span', { class: 'sk-notice-tag', text: '공지' }), text);
  let current = null;      // { id, text, until }
  let hideTimer = null, animTimer = null;

  function clearTimers() {
    if (hideTimer != null) { ctx.cancel(hideTimer); hideTimer = null; }
    if (animTimer != null) { ctx.cancel(animTimer); animTimer = null; }
  }

  /** 떠 있는 동안 경기 HUD의 윗줄(점수·타이머, 킬 피드)을 띠 높이만큼 내린다 */
  function reserve(on) {
    ctx.root.classList.toggle('sk-has-notice', on);
    if (on) ctx.root.style.setProperty('--sk-notice-h', `${Math.ceil(el.getBoundingClientRect().height) + 6}px`);
    else ctx.root.style.removeProperty('--sk-notice-h');
  }

  /** 띠를 내린다. id를 주면 그 공지가 떠 있을 때만 내린다 */
  function hide(id) {
    if (!current || (id != null && String(id) !== current.id)) return false;
    current = null;
    clearTimers();
    el.classList.remove('is-in');
    animTimer = ctx.later(() => { animTimer = null; el.hidden = true; reserve(false); }, HIDE_ANIM_MS);
    return true;
  }

  /** 띠를 띄운다. 이미 떠 있으면 내용과 시간을 바꾼다. 내용이 비면 띄우지 않는다 */
  function show(o = {}) {
    const body = cleanText(o.text);
    if (!body) return false;
    const ms = Math.min(NOTICE_SHOW.max, Math.max(NOTICE_SHOW.min, Number.isFinite(+o.ms) && +o.ms > 0 ? +o.ms : NOTICE_SHOW.def));
    clearTimers();
    current = { id: o.id != null ? String(o.id) : '', text: body, until: Date.now() + ms };
    text.textContent = body;
    el.hidden = false;
    reserve(true);
    // 숨김을 푼 다음 프레임에 클래스를 붙여야 내려오는 전환이 보인다
    el.classList.remove('is-in');
    void el.offsetWidth;
    el.classList.add('is-in');
    hideTimer = ctx.later(() => { hideTimer = null; hide(); }, ms);
    return true;
  }

  return {
    el,
    show,
    hide,
    current: () => (current ? { ...current } : null),
    dispose() {
      clearTimers();
      current = null;
      reserve(false);
      el.remove();
    }
  };
}
