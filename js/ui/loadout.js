/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 로드아웃. 무기 고르기(작은 카드 격자, 숫자키 1~9, 카운트다운)와 부활 대기 중의 compact 패널, 보조·근접 빠른 교체 줄을 보여 준다.
 *          swap이면 라운드 시작 전 대기 시간에 N으로 여닫는 무기 교체 창이다: 무기를 누르면 바로 바뀌고 닫히며, 시간이 끝나면 고르지 않고 닫힌다.
 *          free면(좀비 물량 막기) 가진 것과 상관없이 모든 무기를 보여 주고, 보조·근접 줄은 지금 든 장비(props.current)를 고른 칸으로 그린다.
 *          그 줄에서 고르면 'loadout:equip'에 free: true를 붙인다(계정 장비는 바꾸지 않는다).
 *          무기 이름·수치는 무기 정의(defs)에서 읽고 여기서는 표시만 한다. 칼전이면 칼 목록이 그대로 들어온다.
 */
import { h, setText, isTextField } from './dom.js';
import { barMeters, createChoiceRow, makeScreen, normWeapon, summaryChips } from './parts.js';
import { pickableWeapons, rulesetOf } from '../game/modes.js';

const EXTRA_SLOTS = [['secondary', 2, '보조'], ['melee', 3, '근접']];
const NUMBER_KEYS = 9;
/** 무기가 이보다 많으면 compact 패널은 이름만 보여 준다 */
const COMPACT_DETAIL_MAX = 4;

const keyLabel = (i) => (i < NUMBER_KEYS ? String(i + 1) : '');
const numberKeyHint = (n) => (n > 1 ? `1~${Math.min(n, NUMBER_KEYS)} 키` : '1 키');

export function createLoadout(ctx) {
  let p = {};
  let weapons = [];
  let endAt = 0;
  let timer = null;

  const title = h('h2', { class: 'sk-lo-title sk-stencil' });
  const sub = h('p', { class: 'sk-lo-sub' });
  const count = h('div', { class: 'sk-lo-count', role: 'timer', 'aria-label': '남은 시간' });
  const barFill = h('i');
  const cards = h('div', { class: 'sk-lo-cards' });
  const extras = h('div', { class: 'sk-lo-extras', hidden: true });
  const foot = h('p', { class: 'sk-lo-foot' });

  const fullEl = h('div', { class: 'sk-lo-panel' },
    h('header', { class: 'sk-lo-header' }, h('div', { class: 'sk-lo-heading' }, title, sub), count),
    h('div', { class: 'sk-lo-bar', 'aria-hidden': 'true' }, barFill),
    cards,
    extras,
    foot);

  // compact: 화면을 덮지 않는 하단 작은 패널(개인전에서 죽어 있는 동안 다음 무기 고르기). 커서를 요구하지 않는다.
  const cTitle = h('b', { class: 'sk-lc-title', text: '다음 출격 무기' });
  const cHint = h('span', { class: 'sk-lc-hint' });
  const cCount = h('span', { class: 'sk-lc-count', hidden: true });
  const cCards = h('div', { class: 'sk-lc-cards', role: 'radiogroup', 'aria-label': '다음 무기' });
  const cNote = h('p', { class: 'sk-lc-note', role: 'status' });
  const compactEl = h('div', { class: 'sk-lc sk-steel', hidden: true },
    h('div', { class: 'sk-lc-head' }, cTitle, cHint, cCount),
    cCards,
    cNote);

  const el = h('section', { class: 'sk-screen sk-overlay sk-loadout', hidden: true, role: 'dialog', 'aria-label': '무기 선택' },
    fullEl, compactEl);

  let compact = false;
  let picked = null; // compact에서 지금 고른 무기
  let userPicked = false;

  /** 계정에 장착된 무기 중 이번 목록에 있는 것 */
  function equippedInList() {
    if (!ctx.account) return null;
    const { primary, secondary, melee } = ctx.account.loadout;
    return [primary, melee, secondary].find((id) => weapons.some((w) => w.id === id)) || null;
  }

  const defaultId = () => {
    if (p.selected != null && weapons.some((w) => w.id === String(p.selected))) return String(p.selected);
    return equippedInList() || (weapons[0] ? weapons[0].id : null);
  };

  function pick(id, auto) {
    if (id == null) return;
    if (compact && !auto) {
      // 고른 뒤에도 열어 둔다(부활 전까지 바꿀 수 있음). 엔진은 '다음 부활부터' 적용
      picked = id;
      userPicked = true;
      ctx.emit('loadout:pick', { id, auto: false });
      renderCompact();
      return;
    }
    stop();
    ctx.emit('loadout:pick', { id, auto: !!auto });
    ctx.hideSelf('loadout');
  }

  // ---------- compact 패널 ----------
  function compactCard(w, i, sel, detail) {
    return h('button', {
      type: 'button', class: 'sk-lc-card' + (sel ? ' is-sel' : ''), role: 'radio', 'aria-checked': sel ? 'true' : 'false',
      title: w.name, onclick: () => pick(w.id, false),
    },
      keyLabel(i) ? h('kbd', { class: 'sk-key', text: keyLabel(i) }) : null,
      h('span', { class: 'sk-lc-ico', text: w.icon, 'aria-hidden': 'true' }),
      h('span', { class: 'sk-lc-txt' },
        h('span', { class: 'sk-lc-name' },
          h('span', { class: 'sk-lc-full', text: detail ? w.name : w.short }),
          h('span', { class: 'sk-lc-short', text: w.short })),
        detail && w.tagline ? h('span', { class: 'sk-lc-term', text: w.tagline }) : null));
  }

  function renderCompact() {
    const cur = picked || defaultId();
    const detail = weapons.length <= COMPACT_DETAIL_MAX;
    compactEl.classList.toggle('is-many', !detail);
    setText(cHint, `${numberKeyHint(weapons.length)} 또는 클릭`);
    cCards.replaceChildren(...(weapons.length
      ? weapons.map((w, i) => compactCard(w, i, w.id === cur, detail))
      : [h('p', { class: 'sk-lo-empty', text: '무기 정보를 불러오지 못했어요.' })]));
    const cw = weapons.find((w) => w.id === cur);
    setText(cNote, userPicked && cw ? `다음 부활에 ${cw.name}(으)로 나가요.` : cw ? `지금 선택: ${cw.name}` : '');
    cNote.classList.toggle('is-picked', userPicked);
  }

  /** 휴대폰에서는 무기 줄이 옆으로 밀린다. 패널을 열 때 고른 무기가 보이게 옮겨 둔다 */
  function revealCompactPick() {
    const sel = cCards.querySelector('.is-sel');
    if (!sel || cCards.scrollWidth <= cCards.clientWidth) return;
    cCards.scrollLeft = sel.offsetLeft - cCards.offsetLeft - (cCards.clientWidth - sel.offsetWidth) / 2;
  }

  // ---------- 전체 화면 카드 ----------
  function card(w, i, sel) {
    return h('button', { type: 'button', class: 'sk-lo-card' + (sel ? ' is-sel' : ''), title: w.name, onclick: () => pick(w.id, false) },
      h('span', { class: 'sk-lo-head' },
        keyLabel(i) ? h('kbd', { class: 'sk-key', text: keyLabel(i), title: `${i + 1}번 키` }) : null,
        h('span', { class: 'sk-lo-ico', text: w.icon, 'aria-hidden': 'true' }),
        h('span', { class: 'sk-lo-names' },
          h('span', { class: 'sk-lo-name', text: w.name }),
          w.tagline ? h('span', { class: 'sk-lo-tagline', text: w.tagline }) : null)),
      w.summary.length ? summaryChips(w.summary) : null,
      w.bars.length ? barMeters(w.bars) : null);
  }

  // ---------- 보조·근접 빠른 교체 ----------
  const extraRows = EXTRA_SLOTS.map(([key, slot, label]) => {
    const row = createChoiceRow({
      label: `${label} 바꾸기`,
      onPick: (id) => {
        if (p.free) {
          p.current = { ...(p.current || {}), [key]: id };
          ctx.emit('loadout:equip', { slot: key, id, free: true });
          renderExtras();
          return;
        }
        ctx.emit('loadout:equip', { slot: key, id });
      }
    });
    return { key, slot, row, el: h('div', { class: 'sk-lo-extra' }, h('span', { class: 'sk-lo-extralabel', text: label }), row.el) };
  });
  extras.append(...extraRows.map((r) => r.el));

  /** 이 규칙에서 쓸 수 있고, 지금 고르는 칸이 아닌 칸만 보여 준다 */
  function extraSlotAllowed(slot) {
    if (weapons.some((w) => w.slot === slot)) return false;
    return !p.ruleset || rulesetOf(p.ruleset).slots.includes(slot);
  }

  function renderExtras() {
    const a = ctx.account;
    let shown = false;
    for (const r of extraRows) {
      const on = (!!a || !!p.free) && !compact && extraSlotAllowed(r.slot);
      r.el.hidden = !on;
      if (!on) continue;
      shown = true;
      const list = [...ctx.weapons.values()].filter((w) => w.slot === r.slot && (p.free || a.isOwned(w.id)));
      const sel = p.free ? (p.current && p.current[r.key]) || null : a.loadout[r.key];
      r.row.set(list.map((w) => ({ id: w.id, label: w.short || w.name, icon: w.icon, title: w.name })), sel);
    }
    extras.hidden = !shown;
  }

  // ---------- 카운트다운 ----------
  function stop() {
    if (timer != null) { ctx.cancel(timer); timer = null; }
  }
  function tick() {
    const left = endAt - performance.now();
    const n = Math.max(0, Math.ceil(left / 1000));
    setText(count, String(n));
    setText(cCount, `${n}초`);
    el.classList.toggle('is-urgent', left <= 2000);
    if (left > 0) return;
    if (p.swap) closeSwap('time', false);                           // 교체 창: 고르지 않았으면 들고 있던 무기 그대로
    else if (compact && userPicked) { stop(); ctx.hideSelf('loadout'); } // 이미 골랐으면 다시 보내지 않고 닫기만
    else pick(picked || defaultId(), true);
  }
  function startCountdown(sec) {
    stop();
    const s = Number(sec);
    const timed = Number.isFinite(s) && s > 0;
    count.hidden = !timed;
    cCount.hidden = !timed;
    barFill.parentElement.hidden = !timed;
    el.classList.remove('is-urgent');
    if (!timed) return;
    const ms = s * 1000;
    endAt = performance.now() + ms;
    barFill.style.transition = 'none';
    barFill.style.transform = 'scaleX(1)';
    void barFill.offsetWidth; // 트랜지션 재시작
    barFill.style.transition = `transform ${ms}ms linear`;
    barFill.style.transform = 'scaleX(0)';
    tick();
    timer = ctx.every(tick, 100);
  }

  // ---------- 그리기 ----------
  /** weapons를 주지 않으면 규칙과 보유 무기에서 만든다 */
  function weaponRefs() {
    if (Array.isArray(p.weapons)) return p.weapons;
    return ctx.account ? pickableWeapons(p.ruleset, ctx.account.profile.owned) : [];
  }

  function headline() {
    if (p.title) return p.title;
    const what = p.swap ? '무기 교체' : '무기 선택';
    return p.round ? `라운드 ${p.round} · ${what}` : what;
  }

  /** 교체 창을 고르지 않고 닫는다. relock = 키로 닫았다(그 키 입력으로 포인터를 다시 잠글 수 있다) */
  function closeSwap(reason, relock) {
    stop();
    ctx.hideSelf('loadout');
    ctx.emit('loadout:close', { reason, relock: !!relock });
  }

  function renderFull(secs) {
    const def = defaultId();
    setText(title, headline());
    setText(sub, p.swap
      ? `무기를 누르면 바로 바뀌어요 · ${numberKeyHint(weapons.length)}도 돼요 · N 또는 Esc로 닫기`
      : `카드를 누르거나 ${numberKeyHint(weapons.length)}로 고르세요`);
    cards.replaceChildren(...(weapons.length
      ? weapons.map((w, i) => card(w, i, w.id === def))
      : [h('p', { class: 'sk-lo-empty', text: '무기 정보를 불러오지 못했어요.' })]));
    const dw = weapons.find((w) => w.id === def);
    const timed = Number(secs) > 0 && Number.isFinite(Number(secs));
    const touch = document.documentElement.classList.contains('pc-touch');
    setText(foot, p.foot ? String(p.foot) : p.swap
      ? `라운드가 시작되기 전까지 ${touch ? '안내를 다시 눌러' : 'N으로 다시 열어'} 몇 번이든 바꿀 수 있어요.`
      : dw && timed ? `시간 안에 고르지 않으면 ${dw.name}(으)로 출격해요.` : '');
  }

  function render(props, { fresh, patch }) {
    p = props;
    if (fresh) { picked = null; userPicked = false; }
    compact = !!p.compact;
    el.classList.toggle('is-compact', compact);
    el.setAttribute('role', compact ? 'region' : 'dialog');
    el.setAttribute('aria-label', compact ? '다음 무기 선택' : '무기 선택');
    fullEl.hidden = compact;
    compactEl.hidden = !compact;
    // ammo: 무기 id → '탄' 칸에 대신 쓸 글자(좀비 물량 막기는 예비 3배·프리미엄도 유한이라 표의 값과 다르다)
    weapons = weaponRefs().map((w) => {
      const n = normWeapon(ctx.weapons, w);
      const text = p.ammo && typeof p.ammo === 'object' ? p.ammo[n.id] : null;
      if (text) n.summary = n.summary.map((r) => (r.label === '탄' ? { ...r, value: String(text) } : r));
      return n;
    });
    // 전체 화면은 seconds 생략 시 5초, compact는 생략 시 타이머 없음
    const secs = p.seconds === undefined ? (compact ? null : 5) : p.seconds;
    if (compact) {
      if (p.title) setText(cTitle, p.title);
      renderCompact();
      if (fresh) revealCompactPick();
    } else {
      renderFull(secs);
    }
    renderExtras();
    if (fresh || 'seconds' in patch || 'compact' in patch) startCountdown(secs);
  }

  // 숫자키는 캡처 단계에서 받아 여기서 소비한다. 그래야 엔진 입력(window 버블 리스너)이
  // 같은 키를 무기 슬롯 전환으로 한 번 더 처리하지 않는다. 예: 2로 RX-4를 골랐는데 P-9를 드는 문제.
  ctx.listen(window, 'keydown', (e) => {
    if (!screen.visible || isTextField(e.target)) return;
    // 교체 창: N이나 Esc로 고르지 않고 닫는다. 엔진까지 가면 N은 창을 다시 열고 Esc는 일시정지 메뉴를 연다
    if (p.swap && (e.code === 'KeyN' || e.code === 'Escape')) {
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) closeSwap('key', e.code === 'KeyN');
      return;
    }
    const m = /^(?:Digit|Numpad)([1-9])$/.exec(e.code || '');
    if (!m) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat) return;
    const w = weapons[Number(m[1]) - 1];
    if (w) pick(w.id, false);
  }, true);

  const screen = makeScreen(el, { render, onHide: stop, onDispose: stop });
  screen.wantsCursor = () => !compact; // compact는 포인터 잠금을 풀지 않는다(숫자키로 고름)
  screen.isCompact = () => compact;
  screen.onAccount = renderExtras;     // 카드는 그대로 두고 빠른 교체 줄만 고친다(카운트다운이 다시 시작되지 않게)
  return screen;
}
