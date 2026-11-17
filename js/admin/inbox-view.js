/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 받은편지함 화면의 목록·거르기 칩·진단 정보를 DOM 조각으로 만든다. 플레이어가 쓴 글(이름·본문·답)은 모두 textContent로만 넣고
 *          HTML로 해석하지 않는다. document를 인자로 받으므로 Node 시험이 가짜 DOM으로 같은 코드를 돌려 본다(tests/inbox.test.mjs).
 */
import { FEEDBACK_KIND_NAMES, FEEDBACK_STATUS_NAMES, formatKst, infoRows, snippet, statusChips } from './inbox.js';

/** 요소 하나를 만든다. text는 textContent로만 넣는다 */
function node(doc, tag, { cls = '', text = null, attrs = {}, data = {} } = {}, ...kids) {
  const e = doc.createElement(tag);
  if (cls) e.className = cls;
  if (text !== null) e.textContent = String(text);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  for (const [k, v] of Object.entries(data)) e.dataset[k] = String(v);
  if (kids.length) e.append(...kids);
  return e;
}

/**
 * 목록 한 줄. 누르면 onSelect(id)를 부른다.
 * @param {{ selected?: boolean, draft?: boolean, onSelect?: (id:number) => void }} [opts] draft: 저장하지 않은 답이 있다
 */
export function renderRow(doc, item, { selected = false, draft = false, onSelect = null } = {}) {
  const top = node(doc, 'span', { cls: 'ib-row-top' },
    node(doc, 'span', { cls: 'ib-row-id', text: `#${item.id}` }),
    node(doc, 'span', { cls: 'ib-chip', text: FEEDBACK_KIND_NAMES[item.kind] || item.kind, data: { kind: item.kind } }),
    node(doc, 'span', { cls: 'ib-chip', text: FEEDBACK_STATUS_NAMES[item.status] || item.status, data: { status: item.status } }),
    ...(item.reply ? [node(doc, 'span', { cls: 'ib-chip', text: '답함', data: { tone: 'ok' } })] : []),
    ...(draft ? [node(doc, 'span', { cls: 'ib-chip', text: '쓰는 중', data: { tone: 'wait' } })] : []),
    node(doc, 'span', { cls: 'ib-row-name', text: item.name || '이름 없음' }),
    node(doc, 'span', { cls: 'ib-row-time', text: formatKst(item.createdAt) })
  );
  const btn = node(doc, 'button', {
    cls: 'ib-row',
    attrs: { type: 'button', 'aria-current': selected ? 'true' : 'false' },
    data: { id: item.id, status: item.status }
  }, top, node(doc, 'span', { cls: 'ib-row-snip', text: snippet(item.body) }));
  if (onSelect) btn.addEventListener('click', () => onSelect(item.id));
  return node(doc, 'li', { cls: 'ib-item' }, btn);
}

/** 목록 전체를 다시 그린다. → 그린 줄 수 */
export function renderList(doc, listEl, items, { selectedId = null, drafts = null, onSelect = null } = {}) {
  const rows = items.map((it) => renderRow(doc, it, { selected: it.id === selectedId, draft: !!(drafts && drafts.has(it.id)), onSelect }));
  listEl.replaceChildren(...rows);
  return rows.length;
}

/** 상태 거르기 칩(전체·접수·확인함·반영·보류). 누르면 onPick(status)를 부른다('' = 전체) */
export function renderChips(doc, box, counts, { active = '', onPick = null } = {}) {
  const chips = statusChips(counts).map((c) => {
    const b = node(doc, 'button', {
      cls: 'ib-filter',
      attrs: { type: 'button', 'aria-pressed': c.status === active ? 'true' : 'false' },
      data: { status: c.status }
    }, node(doc, 'span', { text: c.label }), node(doc, 'b', { text: c.count }));
    if (onPick) b.addEventListener('click', () => onPick(c.status));
    return b;
  });
  box.replaceChildren(...chips);
  return chips.length;
}

/** 진단 정보 표(dt·dd). 비어 있으면 아무것도 넣지 않는다. → 줄 수 */
export function renderInfo(doc, dl, info) {
  const rows = infoRows(info);
  const parts = [];
  for (const [name, value] of rows) parts.push(node(doc, 'dt', { text: name }), node(doc, 'dd', { text: value }));
  dl.replaceChildren(...parts);
  return rows.length;
}

/** 인증 앱 등록의 QR(SVG 글자) → <img src>에 넣을 데이터 주소. 그림으로만 열리므로 안의 스크립트는 돌지 않는다 */
export const qrDataUrl = (svg) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(String(svg ?? ''))}`;
