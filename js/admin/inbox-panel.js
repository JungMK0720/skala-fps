/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 운영자 패널 dev/inbox.html의 동작. 로그인(이메일·비밀번호, 인증 앱 코드) → 관리자 확인 → 목록(상태 칩·종류 거르기·100건씩) →
 *          내용·답 저장·상태 단추 → 로그아웃. 서버 호출은 inbox.js, 그리기는 inbox-view.js. 토큰은 메모리와 sessionStorage에만 둔다.
 *          플레이어 글은 textContent로만 넣는다. 시험: tests/inbox.test.mjs(로직·그리기), tools/qa/scenarios/inbox.mjs(이 페이지를 헤드리스 브라우저로).
 *          window.__inbox = { state() }로 지금 상태를 읽는다(주소에 debug=1이 있을 때만).
 */
import {
  FEEDBACK_KINDS, FEEDBACK_KIND_NAMES, FEEDBACK_STATUS_NAMES, INBOX, INBOX_MESSAGES, createInboxClient, formatKst, validateReply
} from './inbox.js';
import { qrDataUrl, renderChips, renderInfo, renderList } from './inbox-view.js';

const IDS = [
  'root', 'who', 'user', 'aal', 'logout',
  'login-card', 'login', 'email', 'password', 'login-btn', 'totp', 'totp-code', 'totp-btn', 'totp-back', 'login-msg',
  'denied-card', 'denied-text', 'denied-retry',
  'app', 'chips', 'kind', 'refresh', 'list-note', 'list', 'more',
  'detail-empty', 'detail-body', 'back', 'd-id', 'd-kind', 'd-status', 'd-meta', 'd-text', 'd-info', 'd-info-empty',
  'reply-form', 'reply', 'reply-count', 'reply-save', 'status-row', 'd-msg',
  'mfa-card', 'mfa-state', 'mfa-start', 'mfa-enroll', 'mfa-qr', 'mfa-secret', 'mfa-form', 'mfa-code', 'mfa-cancel', 'mfa-msg'
];
const camel = (id) => id.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

function setMsg(node, text, tone = '') {
  node.textContent = text || '';
  if (tone) node.dataset.tone = tone; else delete node.dataset.tone;
}

/** 실패를 화면 글로. 모르는 오류·서버 오류에는 서버가 준 짧은 설명을 덧붙인다 */
const failText = (r) => `${r.message}${r.detail && ['unknown', 'server', 'invalid'].includes(r.reason) ? ` (${r.detail})` : ''}`;

async function boot() {
  const el = {};
  const missing = [];
  for (const id of IDS) {
    el[camel(id)] = document.getElementById(`ib-${id}`);
    if (!el[camel(id)]) missing.push(`ib-${id}`);
  }
  if (missing.length) throw new Error(`화면 요소가 없어요: ${missing.join(', ')}`);

  const client = createInboxClient();
  const state = {
    view: 'login', items: [], total: 0, hasMore: false, counts: null, kind: '', status: '',
    /** 지금 내용을 보고 있는 글(목록에서 걸러져도 남는다) */
    current: null,
    /** 저장하지 않은 답 글(글 번호 → 글). 다른 글로 옮겨도 잃지 않는다 */
    drafts: new Map(),
    loadSeq: 0, loading: false, busy: false, enrollFactor: ''
  };

  // 종류 거르기 칸과 상태 단추는 서버와 같은 목록에서 만든다(화면과 규칙이 어긋나지 않게)
  for (const k of FEEDBACK_KINDS) {
    const o = document.createElement('option');
    o.value = k;
    o.textContent = FEEDBACK_KIND_NAMES[k];
    el.kind.append(o);
  }
  for (const s of INBOX.STATUS_ACTIONS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.status = s;
    b.setAttribute('aria-pressed', 'false');
    b.textContent = FEEDBACK_STATUS_NAMES[s];
    el.statusRow.append(b);
  }
  const statusButtons = [...el.statusRow.querySelectorAll('button')];

  /* ---------------- 화면 상태 ---------------- */

  /** 위쪽 계정 칸과 2단계 인증 칸의 글을 지금 세션에 맞춘다 */
  function syncWho() {
    const s = client.state();
    el.user.textContent = s.email || '로그인함';
    el.aal.hidden = s.aal !== 'aal2';
    renderMfaState();
  }

  function setView(view) {
    state.view = view;
    el.root.dataset.view = view;
    el.loginCard.hidden = view !== 'login';
    el.deniedCard.hidden = view !== 'denied';
    el.app.hidden = view !== 'app';
    el.who.hidden = view === 'login';
    el.mfaCard.hidden = view === 'login';
    el.mfaCard.open = view === 'denied';   // 2단계 인증을 필수로 켠 뒤 등록하지 않은 경우를 권한 없음 화면에서 고친다. 다른 화면에서는 접어 둔다
    if (view !== 'login') syncWho();
    syncControls();
  }

  function setBusy(on) { state.busy = on; syncControls(); }

  function replyState() {
    const item = state.current;
    const v = validateReply(el.reply.value);
    const dirty = !!item && el.reply.value !== (item.reply || '');
    return { v, dirty, over: !v.ok };
  }

  function syncControls() {
    el.loginBtn.disabled = state.busy;
    el.totpBtn.disabled = state.busy;
    el.refresh.disabled = state.busy;
    el.more.disabled = state.busy;
    const { v, dirty, over } = replyState();
    el.replySave.disabled = state.busy || !state.current || !dirty || over;
    el.replySave.textContent = v.ok && v.reply === null && state.current && state.current.reply ? '답 지우기' : '답 저장';
    for (const b of statusButtons) b.disabled = state.busy || !state.current;
  }

  function updateCount() {
    const { v } = replyState();
    el.replyCount.textContent = `${v.length ?? 0} / ${INBOX.REPLY_MAX}`;
    el.replyCount.classList.toggle('is-over', !v.ok);
    syncControls();
  }

  /** 로그인 화면으로 돌아간다. 토큰과 불러온 글을 모두 버린다 */
  async function toLogin(message = '', tone = '') {
    await client.signOut();
    state.items = [];
    state.total = 0;
    state.hasMore = false;
    state.counts = null;
    state.current = null;
    state.drafts.clear();
    state.enrollFactor = '';
    state.loadSeq++;
    el.list.replaceChildren();
    el.chips.replaceChildren();
    el.detailBody.hidden = true;
    el.detailEmpty.hidden = false;
    el.password.value = '';
    el.totpCode.value = '';
    el.login.hidden = false;
    el.totp.hidden = true;
    resetEnrollUi();
    setMsg(el.dMsg, '');
    setMsg(el.mfaMsg, '');
    setMsg(el.loginMsg, message, tone);
    setView('login');
  }

  /** 실패 처리: 로그인이 풀렸으면 로그인 화면으로, 아니면 그 자리에 문구 */
  async function onFailure(r, node, tone = 'bad') {
    if (r.reason === 'expired') { await toLogin(INBOX_MESSAGES.expired, 'bad'); return; }
    setMsg(node, failText(r), tone);
  }

  /* ---------------- 목록 ---------------- */

  function drawChips() {
    renderChips(document, el.chips, state.counts || {}, {
      active: state.status,
      onPick: (status) => { state.status = status; reload(); }
    });
  }

  function drawList() {
    const top = el.list.scrollTop;   // 다시 그리면 스크롤이 맨 위로 가므로 되돌린다
    renderList(document, el.list, state.items, {
      selectedId: state.current ? state.current.id : null,
      drafts: state.drafts,
      onSelect: select
    });
    el.list.scrollTop = top;
    const filtered = !!(state.kind || state.status);
    setMsg(el.listNote, state.items.length
      ? `${state.total}건 중 ${state.items.length}건을 보고 있어요.`
      : state.loading ? '불러오는 중…' : filtered ? '조건에 맞는 건의가 없어요.' : '받은 건의가 아직 없어요.');
    el.more.hidden = !state.hasMore;
    el.more.textContent = `더 보기 (${INBOX.PAGE_SIZE}건씩)`;
  }

  function markSelected() {
    for (const b of el.list.querySelectorAll('.ib-row')) b.setAttribute('aria-current', state.current && Number(b.dataset.id) === state.current.id ? 'true' : 'false');
  }

  /** 첫 쪽을 새로 불러온다(거르기를 바꿨거나 새로고침) */
  async function reload() {
    const seq = ++state.loadSeq;
    state.loading = true;
    setMsg(el.listNote, '불러오는 중…', 'wait');
    el.refresh.disabled = true;
    const [list, counts] = await Promise.all([client.list({ kind: state.kind, status: state.status, offset: 0 }), client.counts()]);
    if (seq !== state.loadSeq) return;
    state.loading = false;
    syncControls();
    if (!list.ok) { await onFailure(list, el.listNote); return; }
    state.items = list.items;
    state.total = list.total;
    state.hasMore = list.hasMore;
    if (counts.ok) state.counts = counts.counts;
    // 보던 글이 새로 불러온 목록에 있으면 그 최신 모습으로 바꾼다(쓰던 답은 그대로 둔다)
    const fresh = state.current && state.items.find((x) => x.id === state.current.id);
    if (fresh) { stashDraft(); state.current = fresh; showDetail(fresh); }
    drawChips();
    drawList();
  }

  async function more() {
    if (state.busy || !state.hasMore) return;
    const seq = state.loadSeq;
    setBusy(true);
    const r = await client.list({ kind: state.kind, status: state.status, offset: state.items.length });
    setBusy(false);
    if (seq !== state.loadSeq) return;
    if (!r.ok) { await onFailure(r, el.listNote); return; }
    const seen = new Set(state.items.map((x) => x.id));
    state.items = [...state.items, ...r.items.filter((x) => !seen.has(x.id))];
    state.total = r.total;
    state.hasMore = r.hasMore;
    drawList();
  }

  async function refreshCounts() {
    const c = await client.counts();
    if (c.ok) { state.counts = c.counts; drawChips(); }
  }

  /* ---------------- 내용 · 답 · 상태 ---------------- */

  function metaText(item) {
    const who = `${item.name || '이름 없음'}${item.playerId != null ? ` (플레이어 번호 ${item.playerId})` : ' (지워진 플레이어)'}`;
    return `보낸 사람 ${who} · 받은 시각 ${formatKst(item.createdAt, { long: true })}${item.repliedAt ? ` · 답한 시각 ${formatKst(item.repliedAt, { long: true })}` : ''}`;
  }

  /** 저장하지 않은 답이 있으면 글 번호로 맡아 둔다(없으면 지운다). → 맡은 글이 생기거나 없어졌으면 true(목록의 '쓰는 중' 표시를 다시 그려야 한다) */
  function stashDraft() {
    const item = state.current;
    if (!item || el.detailBody.hidden) return false;
    const had = state.drafts.has(item.id);
    if (el.reply.value !== (item.reply || '')) state.drafts.set(item.id, el.reply.value);
    else state.drafts.delete(item.id);
    return had !== state.drafts.has(item.id);
  }

  function showDetail(item) {
    el.detailEmpty.hidden = true;
    el.detailBody.hidden = false;
    el.dId.textContent = `#${item.id}`;
    el.dKind.textContent = FEEDBACK_KIND_NAMES[item.kind] || item.kind;
    el.dKind.dataset.kind = item.kind;
    el.dStatus.textContent = FEEDBACK_STATUS_NAMES[item.status] || item.status;
    el.dStatus.dataset.status = item.status;
    el.dMeta.textContent = metaText(item);
    el.dText.textContent = item.body;
    el.dInfoEmpty.hidden = renderInfo(document, el.dInfo, item.info) > 0;
    el.reply.value = state.drafts.has(item.id) ? state.drafts.get(item.id) : item.reply || '';
    for (const b of statusButtons) b.setAttribute('aria-pressed', b.dataset.status === item.status ? 'true' : 'false');
    updateCount();
  }

  function select(id) {
    const item = state.items.find((x) => x.id === id);
    if (!item) return;
    const flipped = stashDraft();
    state.current = item;
    showDetail(item);
    setMsg(el.dMsg, '');
    if (flipped) drawList(); else markSelected();
    el.root.dataset.pane = 'detail';
    if (window.matchMedia('(max-width: 860px)').matches) window.scrollTo({ top: 0 });   // 좁은 화면은 목록 대신 내용만 보인다
  }

  /** 저장한 결과(서버가 돌려준 행)를 목록과 내용에 반영한다. clearDraft: 답을 저장했으니 맡아 둔 글을 버린다(상태만 바꿀 때는 쓰던 답을 둔다) */
  function applyItem(item, { clearDraft = false } = {}) {
    stashDraft();
    if (clearDraft) state.drafts.delete(item.id);
    state.items = state.items.map((x) => (x.id === item.id ? item : x));
    if (state.current && state.current.id === item.id) { state.current = item; showDetail(item); }
    drawList();
  }

  async function saveReply() {
    const item = state.current;
    if (!item || state.busy) return;
    const { v, dirty } = replyState();
    if (!v.ok) { setMsg(el.dMsg, v.message, 'bad'); return; }
    if (!dirty || (v.reply || '') === (item.reply || '')) { setMsg(el.dMsg, INBOX_MESSAGES.nochange, 'wait'); return; }
    setBusy(true);
    setMsg(el.dMsg, '저장하는 중…', 'wait');
    const r = await client.saveReply(item.id, el.reply.value);
    setBusy(false);
    if (!r.ok) { await onFailure(r, el.dMsg); return; }
    applyItem(r.item, { clearDraft: true });
    // 저장하는 동안 다른 글로 옮겼다면 그 글의 화면에 이 안내를 띄우지 않는다
    if (state.current && state.current.id === r.item.id) {
      setMsg(el.dMsg, r.item.reply ? '답을 저장했어요. 보낸 사람의 건의하기 시트에 바로 보여요.' : '답을 지웠어요. 보낸 사람에게는 더 이상 보이지 않아요.', 'ok');
    }
    refreshCounts();
  }

  async function saveStatus(status) {
    const item = state.current;
    if (!item || state.busy) return;
    if (item.status === status) { setMsg(el.dMsg, `이미 '${FEEDBACK_STATUS_NAMES[status]}' 상태예요.`, 'wait'); return; }
    setBusy(true);
    setMsg(el.dMsg, '저장하는 중…', 'wait');
    const r = await client.saveStatus(item.id, status);
    setBusy(false);
    if (!r.ok) { await onFailure(r, el.dMsg); return; }
    applyItem(r.item);
    if (state.current && state.current.id === r.item.id) setMsg(el.dMsg, `상태를 바꿨어요: ${FEEDBACK_STATUS_NAMES[r.item.status]}`, 'ok');
    refreshCounts();
  }

  /* ---------------- 로그인 · 권한 ---------------- */

  function showTotpStep() {
    el.login.hidden = true;
    el.totp.hidden = false;
    setMsg(el.loginMsg, '인증 앱에 보이는 6자리 코드를 넣어 주세요.', 'wait');
    el.totpCode.value = '';
    el.totpCode.focus();
  }

  function showDenied(text) {
    el.deniedText.textContent = text || '로그인은 됐지만 이 계정은 건의함 관리자로 인정되지 않았어요. ① 관리자 등록 SQL을 실행했는지 확인하세요(SOP 5절). ② 2단계 인증을 필수로 켜 두었다면 이 화면 아래에서 인증 앱을 등록한 뒤 "다시 확인"을 누르세요(SOP 7절). 고친 뒤에 "다시 확인"을 누르세요.';
    setView('denied');
  }

  /** 로그인을 마친 뒤: 관리자인지 확인하고 목록을 연다 */
  async function enter() {
    setMsg(el.loginMsg, '권한을 확인하는 중…', 'wait');
    setBusy(true);
    const a = await client.isAdmin();
    setBusy(false);
    if (!a.ok) {
      if (a.reason === 'expired') { await toLogin(INBOX_MESSAGES.expired, 'bad'); return; }
      showDenied(failText(a));
      return;
    }
    setMsg(el.loginMsg, '');
    if (!a.admin) { showDenied(''); return; }
    el.root.dataset.pane = 'list';
    setView('app');
    await reload();
  }

  el.login.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (state.busy) return;
    setBusy(true);
    setMsg(el.loginMsg, '로그인하는 중…', 'wait');
    const r = await client.signIn(el.email.value, el.password.value);
    setBusy(false);
    el.password.value = '';
    if (!r.ok) { setMsg(el.loginMsg, failText(r), 'bad'); return; }
    if (r.needsMfa) { showTotpStep(); return; }
    await enter();
  });

  el.totp.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (state.busy) return;
    setBusy(true);
    setMsg(el.loginMsg, '확인하는 중…', 'wait');
    const r = await client.verifyTotp(el.totpCode.value);
    setBusy(false);
    if (!r.ok) {
      if (r.reason === 'expired') { await toLogin(INBOX_MESSAGES.expired, 'bad'); return; }
      setMsg(el.loginMsg, failText(r), 'bad');
      el.totpCode.select();
      return;
    }
    el.totpCode.value = '';
    await enter();
  });
  el.totpBack.addEventListener('click', () => { toLogin(''); });
  el.logout.addEventListener('click', () => { toLogin('로그아웃했어요.', 'ok'); });
  el.deniedRetry.addEventListener('click', async () => {
    if (state.busy) return;
    const s = client.state();
    if (!s.signedIn) { await toLogin(INBOX_MESSAGES.expired, 'bad'); return; }
    await enter();
  });

  /* ---------------- 목록·내용 조작 ---------------- */

  el.kind.addEventListener('change', () => { state.kind = el.kind.value; reload(); });
  el.refresh.addEventListener('click', () => { reload(); });
  el.more.addEventListener('click', () => { more(); });
  el.back.addEventListener('click', () => { stashDraft(); drawList(); el.root.dataset.pane = 'list'; });
  el.reply.addEventListener('input', () => {
    if (stashDraft()) drawList();   // 목록의 '쓰는 중' 표시가 바뀔 때만 다시 그린다
    updateCount();
  });
  el.reply.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); el.replyForm.requestSubmit(); }
  });
  el.replyForm.addEventListener('submit', (e) => { e.preventDefault(); saveReply(); });
  for (const b of statusButtons) b.addEventListener('click', () => { saveStatus(b.dataset.status); });

  /* ---------------- 2단계 인증 등록(선택) ---------------- */

  function renderMfaState() {
    const s = client.state();
    const verified = s.factors.some((f) => f.status === 'verified');
    el.mfaState.textContent = verified
      ? `인증 앱이 등록돼 있어요. 로그인할 때마다 6자리 코드를 물어요.${s.aal === 'aal2' ? ' 이번 로그인도 코드까지 마쳤어요.' : ''} 서버에서도 코드 없이는 못 열게 하려면 SOP 7절의 SQL 한 줄(require_mfa)을 실행하세요.`
      : '아직 등록하지 않았어요. 등록하면 로그인할 때 인증 앱의 6자리 코드가 더 필요해요.';
    el.mfaStart.hidden = verified || !!state.enrollFactor;
  }

  function resetEnrollUi() {
    state.enrollFactor = '';
    el.mfaEnroll.hidden = true;
    el.mfaSecret.textContent = '';
    el.mfaQr.hidden = true;
    el.mfaQr.removeAttribute('src');
    el.mfaCode.value = '';
  }

  el.mfaStart.addEventListener('click', async () => {
    el.mfaStart.disabled = true;
    setMsg(el.mfaMsg, '준비하는 중…', 'wait');
    // 끝내지 않은 예전 등록이 쌓이지 않게 먼저 치운다
    for (const f of client.state().factors.filter((x) => x.status !== 'verified')) await client.mfaDiscard(f.id);
    const r = await client.mfaEnroll();
    el.mfaStart.disabled = false;
    if (!r.ok) { await onFailure(r, el.mfaMsg); return; }
    state.enrollFactor = r.factorId;
    el.mfaSecret.textContent = r.secret;
    if (r.qrSvg) { el.mfaQr.src = qrDataUrl(r.qrSvg); el.mfaQr.hidden = false; } else { el.mfaQr.hidden = true; }
    el.mfaEnroll.hidden = false;
    el.mfaStart.hidden = true;
    setMsg(el.mfaMsg, '');
    el.mfaCode.focus();
  });
  el.mfaForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!state.enrollFactor) return;
    setMsg(el.mfaMsg, '확인하는 중…', 'wait');
    const r = await client.mfaConfirm(state.enrollFactor, el.mfaCode.value);
    if (!r.ok) { await onFailure(r, el.mfaMsg); return; }
    resetEnrollUi();
    syncWho();   // 위쪽의 '2단계 인증됨' 표시를 켠다(칸을 접지 않는다: 아래 안내가 보여야 한다)
    setMsg(el.mfaMsg, '등록했어요. 다음 로그인부터 코드를 물어요.', 'ok');
  });
  el.mfaCancel.addEventListener('click', async () => {
    const id = state.enrollFactor;
    resetEnrollUi();
    setMsg(el.mfaMsg, '');
    renderMfaState();
    if (id) await client.mfaDiscard(id);
  });

  /* ---------------- 시작 ---------------- */

  window.addEventListener('beforeunload', (e) => {
    stashDraft();
    if (state.drafts.size) { e.preventDefault(); e.returnValue = ''; }
  });
  // 뒤로 가기로 되살아난 창은 상태가 낡았다. 새로 불러와 sessionStorage의 세션에서 다시 시작한다
  window.addEventListener('pageshow', (e) => { if (e.persisted) location.reload(); });
  if (new URLSearchParams(location.search).get('debug') === '1') {
    window.__inbox = {
      state: () => ({
        view: state.view, items: state.items.length, total: state.total, hasMore: state.hasMore, kind: state.kind, status: state.status,
        counts: state.counts ? { ...state.counts } : null, currentId: state.current ? state.current.id : null, drafts: [...state.drafts.keys()],
        busy: state.busy, client: client.state()
      })
    };
  }

  setView('login');
  // 다른 사이트가 이 화면을 iframe으로 덮어씌워 누르게 하는 것(클릭재킹)을 막는다. 정적 호스팅이라 응답 머리글을 못 정하므로 스크립트로 막는다
  if (window.top !== window.self) {
    setMsg(el.loginMsg, '이 화면은 다른 페이지 안에서는 쓸 수 없어요. 주소를 직접 열어 주세요.', 'bad');
    el.loginBtn.disabled = true;
    el.email.disabled = true;
    el.password.disabled = true;
    return;
  }
  if (!client.enabled) {
    setMsg(el.loginMsg, INBOX_MESSAGES.config, 'bad');
    el.loginBtn.disabled = true;
    el.email.disabled = true;
    el.password.disabled = true;
    return;
  }
  const back = await client.restore();
  if (!back.ok) { setMsg(el.loginMsg, failText(back), 'bad'); }
  else if (back.restored) {
    if (client.state().needsMfa) showTotpStep();
    else await enter();
  }
  if (state.view === 'login' && el.login.hidden === false) el.email.focus();
}

boot().catch((err) => {
  console.error('[inbox-panel]', err);
  const msg = document.getElementById('ib-login-msg');
  if (msg) { msg.textContent = `패널을 시작하지 못했어요: ${(err && err.message) || err}`; msg.dataset.tone = 'bad'; }
});
