/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 시나리오. 건의 받은편지함(dev/inbox.html)을 실제 화면으로 검사한다. 가짜 Supabase(Auth + PostgREST, tools/qa/fake-inbox.mjs)를 띄우고
 *          로그인(틀린 비밀번호·소유자) → 목록(100건씩·더 보기·상태 칩·종류 거르기, 이름·본문의 태그가 글자로만 보이는지) → 내용·진단 정보 →
 *          답 저장(트리거로 확인함)·상태 단추·답 지우기·쓰던 답 보존 → 새로고침 → 토큰 만료·세션 되살리기·로그아웃 → 권한 없는 계정(다시 확인) →
 *          2단계 인증(코드 확인, 등록) → 서버에 새 SQL이 없을 때 → 좁은 화면(목록·내용 전환)을 본다.
 */
import { FAKE_TOTP_CODE, startFakeInbox } from '../fake-inbox.mjs';
import { sleep } from '../kit.mjs';

const KEY = 'sb_publishable_qa';
const OWNER = { email: 'owner@example.com', password: 'qa-owner-pass-1' };
const STRANGER = { email: 'stranger@example.com', password: 'qa-stranger-pass-1' };
const GUARDED = { email: 'mfa@example.com', password: 'qa-mfa-pass-1' };
const PATH = 'dev/inbox.html?debug=1';
const SIZE = { width: 960, height: 540 };
const ATTACK_NAME = '<b>해커</b>';
const ATTACK_BODY = '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>\n두 번째 줄입니다 &amp; "따옴표"';
/** 일부러 낸 서버 오류(틀린 비밀번호·틀린 코드·만료한 토큰·권한 없음)는 브라우저가 http 오류로 남기므로 이 주소만 넘긴다 */
const EXPECTED_HTTP = [/^(400|401|403) http:\/\/127\.0\.0\.1:\d+\/(auth|rest)\/v1\//];

/** 페이지에서: 목록 상태 */
function listState() {
  const rows = [...document.querySelectorAll('#ib-list .ib-row')];
  const more = document.querySelector('#ib-more');
  return {
    count: rows.length,
    ids: rows.map((r) => Number(r.dataset.id)),
    statuses: rows.map((r) => r.dataset.status),
    current: rows.filter((r) => r.getAttribute('aria-current') === 'true').map((r) => Number(r.dataset.id)),
    note: document.querySelector('#ib-list-note').textContent,
    more: more && !more.hidden ? more.textContent : null,
    chips: [...document.querySelectorAll('#ib-chips .ib-filter')].map((b) => ({ s: b.dataset.status, text: b.textContent, on: b.getAttribute('aria-pressed') === 'true' })),
    first: rows[0] ? { text: rows[0].textContent, name: rows[0].querySelector('.ib-row-name').textContent, snip: rows[0].querySelector('.ib-row-snip').textContent } : null,
    rowChips: Object.fromEntries(rows.slice(0, 200).map((r) => [r.dataset.id, [...r.querySelectorAll('.ib-chip')].map((c) => c.textContent)])),
    injected: document.querySelectorAll('#ib-list img, #ib-list script, #ib-list b, #ib-detail-body img, #ib-detail-body script, #ib-detail-body b').length,
    xss: window.__xss === undefined ? null : window.__xss
  };
}

/** 페이지에서: 내용 상태 */
function detailState() {
  const g = (id) => document.getElementById(id);
  return {
    shown: !g('ib-detail-body').hidden,
    id: g('ib-d-id').textContent,
    kind: g('ib-d-kind').textContent,
    status: g('ib-d-status').textContent,
    meta: g('ib-d-meta').textContent,
    text: g('ib-d-text').textContent,
    info: [...g('ib-d-info').children].map((c) => c.textContent),
    infoEmpty: !g('ib-d-info-empty').hidden,
    reply: g('ib-reply').value,
    count: g('ib-reply-count').textContent,
    over: g('ib-reply-count').classList.contains('is-over'),
    saveOff: g('ib-reply-save').disabled,
    saveLabel: g('ib-reply-save').textContent,
    pressed: [...g('ib-status-row').querySelectorAll('button')].filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.dataset.status),
    statusOff: [...g('ib-status-row').querySelectorAll('button')].every((b) => b.disabled),
    msg: g('ib-d-msg').textContent,
    tone: g('ib-d-msg').dataset.tone || ''
  };
}

/** 페이지에서: 어느 화면(로그인·권한 없음·받은편지함)이 보이는가 */
function views() {
  const vis = (id) => { const e = document.getElementById(id); return !!e && !e.hidden && e.getBoundingClientRect().height > 0; };
  return {
    login: vis('ib-login-card'), loginForm: vis('ib-login'), totpForm: vis('ib-totp'), denied: vis('ib-denied-card'), app: vis('ib-app'), who: vis('ib-who'),
    mfa: vis('ib-mfa-card'), aal: vis('ib-aal'), user: document.getElementById('ib-user').textContent,
    loginMsg: document.getElementById('ib-login-msg').textContent, deniedText: document.getElementById('ib-denied-text').textContent,
    dataView: document.getElementById('ib-root').dataset.view, pane: document.getElementById('ib-root').dataset.pane,
    noHScroll: document.documentElement.scrollWidth <= innerWidth + 1
  };
}

/** 페이지에서: 칸에 글을 넣고 input 이벤트를 낸다 */
function setValue({ sel, value }) {
  const e = document.querySelector(sel);
  e.focus();
  e.value = value;
  e.dispatchEvent(new Event('input', { bubbles: true }));
}

const waitView = (page, name, label) => page.waitFor(`window.__inbox && window.__inbox.state().view === ${JSON.stringify(name)}`, 15000, { label });

/** 로그인 칸에 진짜 입력(클릭 + 글자 넣기)으로 쓰고 로그인 단추를 누른다 */
async function typeLogin(page, { email, password }) {
  for (const [sel, value] of [['#ib-email', email], ['#ib-password', password]]) {
    await page.click(sel);
    await page.fn((s) => document.querySelector(s).select(), sel);
    await page.type(value);
  }
  await page.click('#ib-login-btn');
}

export default {
  name: 'inbox',
  title: '건의 받은편지함: 로그인 · 목록·거르기 · 답·상태 저장 · 만료·로그아웃 · 권한 없는 계정 · 2단계 인증 · 좁은 화면',
  timeoutMs: 5 * 60 * 1000,
  async run(t) {
    const srv = await startFakeInbox({ key: KEY });
    const fake = srv.fake;
    t.server.setConfig(srv.config);
    try {
      fake.addUser({ ...OWNER, admin: true });
      fake.addUser({ ...STRANGER, admin: false });
      fake.addUser({ ...GUARDED, admin: true, requireMfa: true, totp: true });
      const kinds = ['bug', 'idea', 'balance', 'other'];
      const base = Date.now() - 400 * 60_000;
      for (let i = 1; i <= 130; i++) {
        const status = i % 5 === 0 ? 'done' : i % 7 === 0 ? 'hold' : i % 3 === 0 ? 'read' : 'new';
        fake.addFeedback({
          name: `대원${i}`, kind: kinds[i % 4], status, createdAt: base + i * 60_000,
          body: `${i}번째 건의 글입니다. 목록에서는 한 줄로 잘려 보여야 하는 길고 긴 설명이 이어집니다. 끝까지 읽으려면 눌러서 내용을 봐야 합니다.`,
          info: { where: i % 2 ? 'menu' : 'pause', ver: '2.0.0', scr: '1920x1080', touch: false, br: 'Edge 157' },
          reply: status === 'read' ? '확인했어요' : null, repliedAt: status === 'read' ? base + i * 60_000 + 5000 : null
        });
      }
      const hostile = fake.feedback.at(-1);
      Object.assign(hostile, { name: ATTACK_NAME, body: ATTACK_BODY, kind: 'bug', status: 'new', reply: null, repliedAt: null, info: { where: 'pause', ver: '2.0.0', mode: 'bomb', map: 'railyard', extra: '모르는 칸', touch: true } });
      const counts = () => { const c = { new: 0, read: 0, done: 0, hold: 0 }; for (const f of fake.feedback) c[f.status]++; return c; };
      const row = (id) => fake.feedback.find((f) => f.id === id);
      const lastLogout = () => fake.log.filter((x) => x.path === '/auth/v1/logout').at(-1);

      /* ---------- 로그인 화면 ---------- */
      t.setSection('로그인 화면');
      const page = await t.newPage();
      await page.open(`${t.base}${PATH}`, { ...SIZE, clean: true });
      await page.waitFor('window.__inbox', 15000, { label: '패널 시작' });
      let v = await page.fn(views);
      t.check(v.login && v.loginForm && !v.totpForm && !v.denied && !v.app && !v.who && !v.mfa, '처음에는 로그인 칸만 보인다', v);
      t.check(await page.eval('document.activeElement && document.activeElement.id === "ib-email"'), '이메일 칸에 바로 쓸 수 있다(포커스)');
      t.check(await page.eval('document.title') === 'SKALA 작전 — 건의 받은편지함', '제목', await page.eval('document.title'));
      t.check(await page.eval('document.querySelector("meta[name=robots]").content') === 'noindex', '검색에 걸리지 않는다');
      t.check(!(await page.eval('/^Bearer/.test(String(sessionStorage.getItem("skala.inbox.session.v1")))')), '로그인 전에는 저장된 토큰이 없다');
      t.check(await page.eval('document.querySelectorAll("input[name]").length === 0'), '칸에 name이 없다(폼이 그대로 제출돼도 비밀번호가 주소에 실리지 않는다)');
      await t.shot('login');

      /* ---------- 다른 페이지 안(iframe)에서는 열리지 않는다 ---------- */
      t.setSection('iframe 안에서는 열리지 않는다');
      const framed = await page.eval(`new Promise((resolve) => {
        const f = document.createElement('iframe');
        f.src = location.href.replace('?debug=1', '?debug=1&framed=1');
        f.onload = () => setTimeout(() => {
          const d = f.contentDocument;
          resolve({ msg: d.getElementById('ib-login-msg').textContent, btn: d.getElementById('ib-login-btn').disabled, email: d.getElementById('ib-email').disabled, view: d.getElementById('ib-root').dataset.view });
          f.remove();
        }, 400);
        document.body.append(f);
      })`);
      t.check(/다른 페이지 안에서는 쓸 수 없어요/.test(framed.msg) && framed.btn && framed.email && framed.view === 'login', 'iframe 안의 화면은 로그인 칸이 막힌다(클릭재킹 방지)', framed);

      /* ---------- 틀린 비밀번호 ---------- */
      t.setSection('틀린 비밀번호');
      await typeLogin(page, { email: OWNER.email, password: 'wrong-password' });
      await page.waitFor('/맞지 않아요/.test(document.getElementById("ib-login-msg").textContent)', 8000, { label: '틀림 안내' });
      v = await page.fn(views);
      t.check(v.login && !v.app && v.dataView === 'login', '로그인 화면에 머문다', v);
      t.check((await page.eval('document.getElementById("ib-password").value')) === '', '틀려도 비밀번호 칸은 비운다');
      t.check((await page.eval('document.getElementById("ib-login-msg").dataset.tone')) === 'bad', '오류는 빨간 글');
      t.check(fake.sessions.size === 0, '서버에 세션이 생기지 않았다');
      page.clearErrors();   // 일부러 낸 400

      /* ---------- 소유자 로그인 → 목록 ---------- */
      t.setSection('소유자 로그인');
      await typeLogin(page, OWNER);
      await waitView(page, 'app', '받은편지함 열림');
      await page.waitFor('document.querySelectorAll("#ib-list .ib-row").length > 0', 15000, { label: '목록' });
      v = await page.fn(views);
      t.check(v.app && !v.login && v.who && v.mfa && v.user === OWNER.email && !v.aal, '받은편지함이 열리고 계정 이메일이 보인다(2단계 인증 표시는 없다)', v);
      t.check((await page.eval('document.getElementById("ib-password").value')) === '', '비밀번호 칸이 비어 있다');
      let l = await page.fn(listState);
      t.check(l.count === 100 && l.ids[0] === 130 && l.ids[99] === 31, '새 글이 위로 100건', { count: l.count, first: l.ids[0], last: l.ids.at(-1) });
      t.check(/130건 중 100건/.test(l.note), '전체 개수를 알려 준다', l.note);
      t.check(l.more === '더 보기 (100건씩)', '더 보기 단추(100건씩)', l.more);
      const c0 = counts();
      t.check(l.chips.map((c) => c.text).join('|') === `전체${130}|접수${c0.new}|확인함${c0.read}|반영${c0.done}|보류${c0.hold}`, '상태 칩에 개수가 있다', l.chips.map((c) => c.text));
      t.check(l.chips[0].on && l.chips.slice(1).every((c) => !c.on), '처음에는 전체가 눌려 있다');
      t.check(l.statuses[0] === 'new' && l.first.name === ATTACK_NAME && l.first.text.includes('#130') && l.first.text.includes('버그') && l.first.text.includes('접수'), '맨 위 줄: 번호·종류·상태·이름(태그 글자 그대로)', l.first);
      t.check(l.injected === 0 && l.xss === null, '이름·본문의 태그가 요소가 되지 않고 스크립트도 돌지 않는다', { injected: l.injected, xss: l.xss });
      t.check(!(await page.eval('JSON.stringify(Object.assign({}, localStorage))')).includes('eyJ') && (await page.eval('Object.keys(localStorage).length')) === 0, '토큰을 localStorage에 두지 않는다');
      t.check(await page.eval('/^eyJ/.test(JSON.parse(sessionStorage.getItem("skala.inbox.session.v1")).accessToken)'), '토큰은 sessionStorage에만 있다');
      t.check(!(await page.eval('location.href')).match(/token|eyJ/i), '주소에 토큰이 없다');
      await t.shot('list');

      /* ---------- 더 보기 ---------- */
      t.setSection('더 보기');
      await page.click('#ib-more');
      await page.waitFor('document.querySelectorAll("#ib-list .ib-row").length === 130', 10000, { label: '130건' });
      l = await page.fn(listState);
      t.check(new Set(l.ids).size === 130 && l.ids.at(-1) === 1, '겹침 없이 130건이 모두 보인다', l.count);
      t.check(l.more === null && /130건 중 130건/.test(l.note), '더 볼 것이 없으면 단추가 사라진다', { more: l.more, note: l.note });

      /* ---------- 거르기 ---------- */
      t.setSection('거르기');
      await page.clickText('#ib-chips .ib-filter', '접수');
      await page.waitFor('window.__inbox.state().status === "new" && document.querySelector("#ib-list-note").textContent !== "불러오는 중…"', 10000, { label: '접수만' });
      l = await page.fn(listState);
      t.check(l.statuses.every((s) => s === 'new') && l.count === Math.min(100, c0.new) && l.chips.find((c) => c.on).s === 'new', '접수 칩: 접수 글만', { count: l.count, want: c0.new });
      await page.fn(() => { const s = document.getElementById('ib-kind'); s.value = 'bug'; s.dispatchEvent(new Event('change', { bubbles: true })); });
      await page.waitFor('window.__inbox.state().kind === "bug" && document.querySelector("#ib-list-note").textContent !== "불러오는 중…"', 10000, { label: '버그만' });
      l = await page.fn(listState);
      const wantBug = fake.feedback.filter((f) => f.kind === 'bug' && f.status === 'new');
      t.check(l.count === wantBug.length && l.rowChips[l.ids[0]].includes('버그') && l.rowChips[l.ids[0]].includes('접수'), '종류를 버그로 바꾸면 접수 + 버그만', { count: l.count, want: wantBug.length });
      t.check(l.chips.map((c) => c.text).join('|').startsWith(`전체130|접수${c0.new}`), '칩의 개수는 종류 거르기와 상관없이 전체 기준', l.chips.map((c) => c.text));
      await page.clickText('#ib-chips .ib-filter', '전체');
      await page.fn(() => { const s = document.getElementById('ib-kind'); s.value = ''; s.dispatchEvent(new Event('change', { bubbles: true })); });
      await page.waitFor('window.__inbox.state().kind === "" && window.__inbox.state().status === "" && document.querySelectorAll("#ib-list .ib-row").length === 100', 10000, { label: '거르기 풀기' });
      t.check(true, '거르기를 풀면 다시 100건');

      /* ---------- 내용 ---------- */
      t.setSection('내용 보기');
      await page.click('#ib-list .ib-row[data-id="130"]');
      await page.waitFor('window.__inbox.state().currentId === 130', 5000, { label: '글 선택' });
      let d = await page.fn(detailState);
      t.check(d.shown && d.id === '#130' && d.kind === '버그' && d.status === '접수', '번호·종류·상태', d);
      t.check(d.text === ATTACK_BODY, '본문이 글자 그대로(태그·줄바꿈·따옴표)', d.text);
      t.check(d.meta.includes(ATTACK_NAME) && /플레이어 번호 7/.test(d.meta) && /받은 시각 \d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(d.meta) && !/답한 시각/.test(d.meta), '보낸 사람·플레이어 번호·받은 시각(한국 시간)', d.meta);
      t.check(d.info.join('|') === '연 곳|일시정지 메뉴|모드|bomb|맵|railyard|버전|2.0.0|터치 기기|예|extra|모르는 칸', '진단 정보를 한국어 이름으로, 모르는 칸은 키 그대로', d.info);
      t.check(d.reply === '' && d.count === '0 / 500' && d.saveOff && d.saveLabel === '답 저장', '답 칸은 비어 있고 저장은 꺼져 있다', d);
      l = await page.fn(listState);
      t.check(l.current.join() === '130' && l.injected === 0 && l.xss === null, '목록에서 선택이 표시되고 내용에도 태그 요소가 없다', { current: l.current, injected: l.injected });
      await t.shot('detail');

      /* ---------- 답 저장 ---------- */
      t.setSection('답 저장');
      await page.fn(setValue, { sel: '#ib-reply', value: '고쳤어요.  \r\n\r\n\r\n다음 배포에 들어가요   ' });
      d = await page.fn(detailState);
      t.check(!d.saveOff && d.count === `${Array.from('고쳤어요.\n\n다음 배포에 들어가요').length} / 500`, '쓰면 글자 수(서버가 세는 정리한 글자 수)가 보이고 저장이 켜진다', d);
      l = await page.fn(listState);
      t.check(l.rowChips[130].includes('쓰는 중'), '목록에 쓰는 중 표시', l.rowChips[130]);
      await page.fn(setValue, { sel: '#ib-reply', value: '가'.repeat(501) });
      d = await page.fn(detailState);
      t.check(d.over && d.saveOff && d.count === '501 / 500', '500자를 넘으면 빨갛게 되고 저장이 꺼진다', d);
      await page.fn(setValue, { sel: '#ib-reply', value: '고쳤어요.  \r\n\r\n\r\n다음 배포에 들어가요   ' });
      await page.click('#ib-reply-save');
      await page.waitFor('/답을 저장했어요/.test(document.getElementById("ib-d-msg").textContent)', 8000, { label: '저장' });
      d = await page.fn(detailState);
      t.check(d.tone === 'ok' && d.status === '확인함' && d.reply === '고쳤어요.\n\n다음 배포에 들어가요' && d.saveOff && /답한 시각/.test(d.meta), '저장했다: 상태가 확인함으로, 정리된 글이 답 칸에, 답한 시각', d);
      t.check(row(130).reply === '고쳤어요.\n\n다음 배포에 들어가요' && row(130).status === 'read' && row(130).replied_at > 0, '서버에 정리된 답과 트리거 결과(read·replied_at)가 들어갔다', { reply: row(130).reply, status: row(130).status });
      t.check(fake.log.filter((x) => x.method === 'PATCH').every((x) => x.bodyKeys.join() === 'reply'), '답을 저장할 때는 reply 한 칸만 보낸다');
      l = await page.fn(listState);
      t.check(l.rowChips[130].includes('확인함') && l.rowChips[130].includes('답함') && !l.rowChips[130].includes('쓰는 중') && l.statuses[0] === 'read', '목록 줄도 확인함·답함으로 바뀐다', l.rowChips[130]);
      await page.waitFor(`document.querySelector('#ib-chips .ib-filter[data-status="new"]').textContent === '접수${c0.new - 1}'`, 8000, { label: '칩 개수 갱신' });
      t.check(true, '상태 칩 개수도 새로 센다(접수 −1)');

      // 답이 그대로면 다시 보내지 않는다
      await page.fn(setValue, { sel: '#ib-reply', value: '고쳤어요.\n\n다음 배포에 들어가요  ' });
      d = await page.fn(detailState);
      t.check(!d.saveOff, '공백만 바꿨어도 저장 단추는 켜지지만');
      const patchesBefore = fake.log.filter((x) => x.method === 'PATCH').length;
      await page.click('#ib-reply-save');
      await page.waitFor('/바뀐 내용이 없어요/.test(document.getElementById("ib-d-msg").textContent)', 5000, { label: '변화 없음' });
      t.check(fake.log.filter((x) => x.method === 'PATCH').length === patchesBefore, '정리한 글이 같으면 서버에 보내지 않는다');

      /* ---------- 상태 단추 ---------- */
      t.setSection('상태 단추');
      await page.fn(setValue, { sel: '#ib-reply', value: '쓰던 답은 남아야 해요' });
      await page.clickText('#ib-status-row button', '반영');
      await page.waitFor('document.getElementById("ib-d-status").textContent === "반영"', 8000, { label: '반영' });
      d = await page.fn(detailState);
      t.check(d.pressed.join() === 'done' && /상태를 바꿨어요: 반영/.test(d.msg) && row(130).status === 'done', '반영으로 바뀌고 눌린 단추가 표시된다', d);
      t.check(d.reply === '쓰던 답은 남아야 해요', '상태만 바꿔도 쓰던 답은 그대로', d.reply);
      t.check(fake.log.filter((x) => x.method === 'PATCH').at(-1).bodyKeys.join() === 'status' && row(130).reply === '고쳤어요.\n\n다음 배포에 들어가요', '상태 단추는 status 한 칸만 보내고 저장된 답은 건드리지 않는다');
      await page.clickText('#ib-status-row button', '반영');
      await page.waitFor('/이미 .반영. 상태예요/.test(document.getElementById("ib-d-msg").textContent)', 5000, { label: '같은 상태' });
      await page.clickText('#ib-status-row button', '보류');
      await page.waitFor('document.getElementById("ib-d-status").textContent === "보류"', 8000, { label: '보류' });
      t.check(row(130).status === 'hold', '보류');
      await page.clickText('#ib-status-row button', '확인함');
      await page.waitFor('document.getElementById("ib-d-status").textContent === "확인함"', 8000, { label: '확인함' });
      t.check(row(130).status === 'read', '확인함으로 되돌릴 수 있다');
      t.check(!(await page.eval('[...document.querySelectorAll("#ib-status-row button")].some((b) => b.dataset.status === "new")')), '접수(new)로 되돌리는 단추는 없다');

      /* ---------- 쓰던 답 보존 ---------- */
      t.setSection('쓰던 답 보존');
      await page.click('#ib-list .ib-row[data-id="128"]');
      await page.waitFor('window.__inbox.state().currentId === 128', 5000, { label: '128번' });
      d = await page.fn(detailState);
      t.check(d.id === '#128' && d.reply === '' && d.saveOff, '다른 글로 옮기면 그 글의 답 칸이 보인다', d);
      l = await page.fn(listState);
      t.check(l.rowChips[130].includes('쓰는 중') && l.current.join() === '128', '쓰던 글 줄에 쓰는 중 표시', l.rowChips[130]);
      await page.click('#ib-list .ib-row[data-id="130"]');
      await page.waitFor('window.__inbox.state().currentId === 130', 5000, { label: '130번으로 돌아옴' });
      d = await page.fn(detailState);
      t.check(d.reply === '쓰던 답은 남아야 해요' && !d.saveOff, '돌아오면 쓰던 답이 그대로 있다', d.reply);
      await page.fn(setValue, { sel: '#ib-reply', value: '고쳤어요.\n\n다음 배포에 들어가요' });
      l = await page.fn(listState);
      t.check(!l.rowChips[130].includes('쓰는 중'), '저장된 답과 같아지면 쓰는 중 표시가 사라진다');

      /* ---------- 답 지우기 ---------- */
      t.setSection('답 지우기');
      await page.fn(setValue, { sel: '#ib-reply', value: '' });
      d = await page.fn(detailState);
      t.check(d.saveLabel === '답 지우기' && !d.saveOff, '비우면 단추가 답 지우기로 바뀐다', d);
      await page.click('#ib-reply-save');
      await page.waitFor('/답을 지웠어요/.test(document.getElementById("ib-d-msg").textContent)', 8000, { label: '지움' });
      t.check(row(130).reply === null && row(130).replied_at === null, '서버에서 답과 답한 시각이 지워졌다', row(130));
      d = await page.fn(detailState);
      t.check(d.reply === '' && !/답한 시각/.test(d.meta) && d.saveLabel === '답 저장', '화면에서도 지워진다', d);

      /* ---------- 새 글과 새로고침 ---------- */
      t.setSection('새로고침');
      fake.addFeedback({ name: '새대원', kind: 'idea', body: '새로고침하면 보이는 새 건의입니다', createdAt: Date.now(), info: {} });
      await page.click('#ib-refresh');
      await page.waitFor('document.querySelector("#ib-list .ib-row").dataset.id === "131"', 8000, { label: '새 글' });
      l = await page.fn(listState);
      t.check(/131건 중 100건/.test(l.note) && l.chips[0].text === '전체131', '새 건의가 맨 위에 보이고 전체가 131', { note: l.note, chip: l.chips[0].text });
      t.check(l.current.join() === '130', '보던 글 표시는 그대로', l.current);
      d = await page.fn(detailState);
      t.check(d.infoEmpty === false && d.id === '#130', '보던 내용도 그대로');
      await page.click('#ib-list .ib-row[data-id="131"]');
      await page.waitFor('window.__inbox.state().currentId === 131', 5000, { label: '131번' });
      d = await page.fn(detailState);
      t.check(d.infoEmpty && d.info.length === 0, '진단 정보가 없는 글은 없다고 알린다', d);
      t.errorsOk('로그인~새로고침', { allow: EXPECTED_HTTP });

      /* ---------- 토큰 만료 · 세션 되살리기 · 로그아웃 ---------- */
      t.setSection('토큰 만료');
      fake.expireAll();
      const refreshesBefore = fake.log.filter((x) => x.query === '?grant_type=refresh_token').length;
      await page.click('#ib-refresh');
      await page.waitFor('document.querySelector("#ib-list-note").textContent !== "불러오는 중…"', 8000, { label: '새로고침 끝' });
      v = await page.fn(views);
      t.check(v.app && fake.log.filter((x) => x.query === '?grant_type=refresh_token').length === refreshesBefore + 1, '만료돼도 로그인을 다시 묻지 않고 새 토큰으로 이어 간다', { app: v.app });
      page.clearErrors();   // 일부러 낸 401

      t.setSection('세션 되살리기');
      await page.reload();
      await page.waitFor('window.__inbox && window.__inbox.state().view === "app" && document.querySelectorAll("#ib-list .ib-row").length > 0', 15000, { label: '새로 고침 뒤에도 열림' });
      v = await page.fn(views);
      t.check(v.app && v.user === OWNER.email, '같은 탭에서 새로 고쳐도 로그인이 이어진다(sessionStorage)', v);

      t.setSection('로그아웃');
      await page.click('#ib-logout');
      await waitView(page, 'login', '로그아웃');
      v = await page.fn(views);
      l = await page.fn(listState);
      t.check(v.login && v.loginForm && !v.app && !v.who && !v.mfa && /로그아웃했어요/.test(v.loginMsg), '로그인 화면으로 돌아온다', v);
      t.check(l.count === 0 && !(await page.eval('document.getElementById("ib-detail-body").hidden === false')), '불러온 글이 화면에서 사라진다', l.count);
      t.check((await page.eval('sessionStorage.getItem("skala.inbox.session.v1")')) === null, '저장된 토큰을 지운다');
      const out = lastLogout();
      t.check(!!out && out.query === '?scope=local' && !fake.sessions.has(out.bearer), '서버 세션도 끝낸다(이 기기만, scope=local)', out);
      await page.reload();
      await page.waitFor('window.__inbox', 15000, { label: '다시 열림' });
      v = await page.fn(views);
      t.check(v.login && !v.app, '새로 고쳐도 로그인 화면이다(되살릴 세션이 없다)', v);

      /* ---------- 세션이 완전히 죽었을 때 ---------- */
      t.setSection('세션이 끝났을 때');
      await typeLogin(page, OWNER);
      await waitView(page, 'app', '다시 로그인');
      fake.expireAll();
      fake.revokeRefresh();
      await page.click('#ib-refresh');
      await waitView(page, 'login', '로그인 화면으로');
      v = await page.fn(views);
      t.check(v.login && /로그인이 풀렸어요/.test(v.loginMsg) && !v.app, '로그인이 풀리면 안내와 함께 로그인 화면으로 돌아간다', v.loginMsg);
      page.clearErrors();

      /* ---------- 권한 없는 계정 ---------- */
      t.setSection('권한 없는 계정');
      await typeLogin(page, STRANGER);
      await waitView(page, 'denied', '권한 없음 화면');
      v = await page.fn(views);
      t.check(v.denied && !v.app && v.who && v.mfa && /관리자 등록/.test(v.deniedText), '로그인은 되지만 목록 대신 안내가 나온다', v);
      t.check(!fake.log.some((x) => x.method === 'GET' && x.path === '/rest/v1/fps_feedback' && x.bearer && fake.sessions.has(x.bearer) && fake.sessions.get(x.bearer).userId === fake.users.get(STRANGER.email).id), '관리자가 아니면 목록을 아예 부르지 않는다');
      t.check(await page.eval('document.getElementById("ib-mfa-card").open === true'), '2단계 인증 칸이 열려 있다(필수로 켠 뒤 등록하지 않은 경우를 여기서 고친다)');
      await t.shot('denied');
      fake.users.get(STRANGER.email).admin = true;   // 소유자가 관리자 등록 SQL을 실행했다고 치고
      await page.click('#ib-denied-retry');
      await waitView(page, 'app', '다시 확인으로 열림');
      v = await page.fn(views);
      t.check(v.app && !v.denied, '관리자로 등록한 뒤 "다시 확인"을 누르면 로그아웃 없이 열린다', v);
      t.check(await page.eval('document.getElementById("ib-mfa-card").open === false'), '열린 뒤에는 2단계 인증 칸이 접힌다');
      await page.click('#ib-logout');
      await waitView(page, 'login', '로그아웃');
      fake.users.get(STRANGER.email).admin = false;

      /* ---------- 서버에 새 SQL이 없을 때 ---------- */
      t.setSection('schema.sql을 아직 실행하지 않은 서버');
      fake.flags.schema = false;
      await typeLogin(page, OWNER);
      await waitView(page, 'denied', '기능 없음 안내');
      v = await page.fn(views);
      t.check(/schema\.sql/.test(v.deniedText) && v.denied, '서버에 기능이 없으면 schema.sql을 실행하라고 알려 준다', v.deniedText);
      fake.flags.schema = true;
      await page.click('#ib-denied-retry');
      await waitView(page, 'app', 'SQL 실행 뒤 열림');
      t.check(true, '실행한 뒤 다시 확인하면 열린다');
      await page.click('#ib-logout');
      await waitView(page, 'login', '로그아웃');
      page.clearErrors();

      /* ---------- 2단계 인증: 로그인 ---------- */
      t.setSection('2단계 인증 로그인');
      await typeLogin(page, GUARDED);
      await page.waitFor('!document.getElementById("ib-totp").hidden', 8000, { label: '코드 칸' });
      v = await page.fn(views);
      t.check(v.login && !v.loginForm && v.totpForm && !v.app, '비밀번호 다음에 인증 앱 코드 칸이 나온다', v);
      t.check(!fake.log.some((x) => x.method === 'GET' && x.path === '/rest/v1/fps_feedback' && fake.sessions.get(x.bearer) && fake.sessions.get(x.bearer).userId === fake.users.get(GUARDED.email).id), '코드를 넣기 전에는 목록을 부르지 않는다');
      await page.click('#ib-totp-code');
      await page.type('000000');
      await page.click('#ib-totp-btn');
      await page.waitFor('/맞지 않거나/.test(document.getElementById("ib-login-msg").textContent)', 8000, { label: '틀린 코드' });
      v = await page.fn(views);
      t.check(v.totpForm && !v.app, '틀린 코드는 들어가지 못한다', v.loginMsg);
      await page.click('#ib-totp-code');
      await page.fn(() => document.getElementById('ib-totp-code').select());
      await page.type(` ${FAKE_TOTP_CODE.slice(0, 3)} ${FAKE_TOTP_CODE.slice(3)} `);
      await page.click('#ib-totp-btn');
      await waitView(page, 'app', '코드 확인 뒤 열림');
      await page.waitFor('document.querySelectorAll("#ib-list .ib-row").length > 0', 10000, { label: '목록' });
      v = await page.fn(views);
      t.check(v.app && v.aal && v.user === GUARDED.email, '맞는 코드를 넣으면 열리고 2단계 인증됨 표시가 켜진다', v);
      t.check(await page.eval('JSON.parse(sessionStorage.getItem("skala.inbox.session.v1")).aal === "aal2"'), '저장된 세션도 aal2');
      page.clearErrors();

      /* ---------- 2단계 인증: 등록 ---------- */
      t.setSection('2단계 인증 등록');
      await page.click('#ib-logout');
      await waitView(page, 'login', '로그아웃');
      await typeLogin(page, OWNER);
      await waitView(page, 'app', '소유자 로그인');
      await page.click('#ib-mfa-card summary');
      await page.waitFor('document.getElementById("ib-mfa-card").open', 3000, { label: '2단계 인증 칸 열기' });
      t.check(/아직 등록하지 않았어요/.test(await page.eval('document.getElementById("ib-mfa-state").textContent')), '등록 전 상태 안내');
      await page.click('#ib-mfa-start');
      await page.waitFor('!document.getElementById("ib-mfa-enroll").hidden', 8000, { label: '등록 칸' });
      const q = await page.eval(`(() => { const i = document.getElementById('ib-mfa-qr'); return { shown: !i.hidden && i.getBoundingClientRect().width > 100, src: i.src.slice(0, 40), loaded: i.complete && i.naturalWidth > 0, secret: document.getElementById('ib-mfa-secret').textContent }; })()`);
      t.check(q.shown && q.src.startsWith('data:image/svg+xml') && q.loaded && q.secret === 'JBSWY3DPEHPK3PXP', 'QR 그림과 직접 입력용 키가 보인다', q);
      await t.shot('mfa-enroll');
      await page.click('#ib-mfa-code');
      await page.type('111111');
      await page.fn(() => document.getElementById('ib-mfa-form').requestSubmit());
      await page.waitFor('/맞지 않거나/.test(document.getElementById("ib-mfa-msg").textContent)', 8000, { label: '틀린 등록 코드' });
      t.check(fake.users.get(OWNER.email).factors[0].status === 'unverified', '틀린 코드로는 등록되지 않는다');
      await page.fn(() => document.getElementById('ib-mfa-code').select());
      await page.type(FAKE_TOTP_CODE);
      await page.fn(() => document.getElementById('ib-mfa-form').requestSubmit());
      await page.waitFor('/등록했어요/.test(document.getElementById("ib-mfa-msg").textContent)', 8000, { label: '등록됨' });
      v = await page.fn(views);
      t.check(fake.users.get(OWNER.email).factors[0].status === 'verified' && v.aal && (await page.eval('document.getElementById("ib-mfa-enroll").hidden')), '등록되고 이 세션은 2단계 인증됨이 된다', v);
      t.check(/인증 앱이 등록돼 있어요/.test(await page.eval('document.getElementById("ib-mfa-state").textContent')) && (await page.eval('document.getElementById("ib-mfa-start").hidden')), '등록 뒤에는 시작 단추가 숨는다');
      await page.click('#ib-logout');
      await waitView(page, 'login', '로그아웃');
      await typeLogin(page, OWNER);
      await page.waitFor('!document.getElementById("ib-totp").hidden', 8000, { label: '다음 로그인은 코드' });
      t.check(true, '등록한 뒤 첫 로그인부터 코드를 묻는다');
      await page.click('#ib-totp-back');
      await page.waitFor('!document.getElementById("ib-login").hidden', 5000, { label: '처음으로' });
      v = await page.fn(views);
      t.check(v.loginForm && !v.totpForm && !v.app, '처음으로 돌아가면 세션을 버리고 로그인 칸이 다시 나온다', v);
      const out2 = lastLogout();
      t.check(!!out2 && out2.query === '?scope=local' && !fake.sessions.has(out2.bearer), '서버 세션도 끝난다', out2);
      t.errorsOk('로그인~2단계 인증', { allow: EXPECTED_HTTP });

      /* ---------- 좁은 화면 ---------- */
      t.setSection('좁은 화면');
      fake.users.get(OWNER.email).factors.length = 0;   // 코드 없이 들어가려고 등록을 지운다
      await page.open(`${t.base}${PATH}`, { width: 400, height: 540 });
      await page.waitFor('window.__inbox', 15000, { label: '좁은 화면 시작' });
      await typeLogin(page, OWNER);
      await waitView(page, 'app', '좁은 화면 로그인');
      await page.waitFor('document.querySelectorAll("#ib-list .ib-row").length > 0', 10000, { label: '목록' });
      let n = await page.eval(`(() => ({
        pane: document.getElementById('ib-root').dataset.pane,
        list: getComputedStyle(document.querySelector('.ib-list-pane')).display,
        detail: getComputedStyle(document.querySelector('.ib-detail-pane')).display,
        back: getComputedStyle(document.getElementById('ib-back')).display,
        noHScroll: document.documentElement.scrollWidth <= innerWidth + 1
      }))()`);
      t.check(n.pane === 'list' && n.list !== 'none' && n.detail === 'none' && n.noHScroll, '좁은 화면: 처음에는 목록만 보이고 가로로 넘치지 않는다', n);
      await t.shot('narrow-list');
      await page.click('#ib-list .ib-row[data-id="129"]');
      await page.waitFor('window.__inbox.state().currentId === 129', 5000, { label: '글 선택' });
      n = await page.eval(`(() => ({
        pane: document.getElementById('ib-root').dataset.pane,
        list: getComputedStyle(document.querySelector('.ib-list-pane')).display,
        detail: getComputedStyle(document.querySelector('.ib-detail-pane')).display,
        back: getComputedStyle(document.getElementById('ib-back')).display,
        noHScroll: document.documentElement.scrollWidth <= innerWidth + 1,
        saveVisible: document.getElementById('ib-reply-save').getBoundingClientRect().right <= innerWidth
      }))()`);
      t.check(n.pane === 'detail' && n.list === 'none' && n.detail !== 'none' && n.back !== 'none' && n.noHScroll && n.saveVisible, '글을 누르면 내용만 보이고 목록으로 돌아가는 단추가 있다', n);
      await t.shot('narrow-detail');
      await page.click('#ib-back');
      n = await page.eval(`document.getElementById('ib-root').dataset.pane`);
      t.check(n === 'list', '목록으로 돌아간다', n);
      t.errorsOk('좁은 화면', { allow: EXPECTED_HTTP });
      await sleep(50);
    } finally {
      t.server.setConfig(null);
      await srv.close();
    }
    t.note('가짜 Supabase(tools/qa/fake-inbox.mjs)로 확인했다. 진짜 Supabase Auth·PostgREST·RLS에서는 확인하지 못했다(처음 켠 뒤 SOP 6절의 첫 로그인 시험으로 확인한다)');
  }
};
