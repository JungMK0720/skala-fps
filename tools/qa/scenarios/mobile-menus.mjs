/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 휴대폰 크기(가로 844x390, 667x375, 세로 390x540)와 터치 에뮬레이션으로 경기 밖 화면을 차례로 띄워 스크린샷을 남기고, 잘린 버튼, 손이 닿지 않는 곳, 작은 누름 대상을 찾는다.
 *          사진을 눈으로 함께 본다. 시험 전용 값은 화면에 ui.show로 직접 넣어 렌더링 부담 없이 돌리고, 부활 패널만 실제 경기에서 한 번 더 본다.
 */
import { LOW_QUALITY, lockPointer, openGame, richProfile, sleep, waitLive, waitRun, waitTicks } from '../kit.mjs';

/** 기본으로 도는 크기. n844는 노치가 있는 아이폰의 가로 화면처럼 안전 영역을 준다 */
const PHONES = Object.freeze([
  Object.freeze({ id: 'l844', w: 844, h: 390, landscape: true, real: true }),
  Object.freeze({ id: 'l667', w: 667, h: 375, landscape: true, real: true }),
  Object.freeze({ id: 'p390', w: 390, h: 540, landscape: false }),
  Object.freeze({ id: 'n844', w: 844, h: 390, landscape: true, insets: Object.freeze({ top: 0, left: 47, right: 47, bottom: 21 }) }),
]);
/**
 * --filter로 이름을 줄 때만 도는 크기. 필터는 "크기[,크기][/사진 이름 일부[,…]]" 모양이다.
 * pc960은 터치 없는 작은 PC 창이다. 새 규칙이 하나도 걸리지 않아야 하므로, 이전 커밋과 사진을 맞대 볼 때 쓴다.
 */
const EXTRA_PHONES = Object.freeze([
  Object.freeze({ id: 'w932', w: 932, h: 430, landscape: true }),
  Object.freeze({ id: 'u844', w: 844, h: 320, landscape: true }),   // 주소창이 떠 있는 가로 화면
  Object.freeze({ id: 'u667', w: 667, h: 320, landscape: true }),
  Object.freeze({ id: 's640', w: 640, h: 360, landscape: true }),
  Object.freeze({ id: 's568', w: 568, h: 320, landscape: true }),
  Object.freeze({ id: 'pc960', w: 960, h: 540, landscape: true, touch: false }),
]);
const TAP_MIN = 40;
const TAP_MIN_WIDTH = 32;
const NICK_LONG = '가나다라마바사아자차카타';   // 닉네임 최대 길이(12자)
const ROOM_LONG = '오늘 밤 3대3 스나전 초보 환영 모여라 방';   // 방 이름 최대 길이에 가깝게

const ROOMS = Object.freeze([
  { roomId: 'r1', name: ROOM_LONG, mapId: 'alley', mode: 'team', ruleset: 'classic', players: 3, max: 6, hostName: NICK_LONG, status: 'waiting' },
  { roomId: 'r2', name: '스나전 모여라', mapId: 'nexus', mode: 'ffa', ruleset: 'sniper', killTarget: 20, players: 6, max: 6, hostName: '하늘', status: 'waiting' },
  { roomId: 'r3', name: '칼전 한 판', mapId: 'dojo', mode: 'team', ruleset: 'knife', players: 4, max: 6, hostName: '호랑이', status: 'playing' },
  { roomId: 'r4', name: '개인전 연습', mapId: 'jetty', mode: 'ffa', ruleset: 'classic', killTarget: 20, players: 2, max: 6, hostName: '여우', status: 'waiting' },
]);

const CHAT = Object.freeze([
  { system: true, text: '여우님이 입장했어요.' },
  { name: NICK_LONG, team: 'owner', text: '끝쪽 저격 자리 조심하세요. 오른쪽 컨테이너 뒤에 자주 숨어요.' },
  { name: '호랑이', team: 'charterer', text: '오른쪽으로 돌아서 들어갑시다' },
  { name: '달빛', team: 'owner', text: '준비 눌러 주세요' },
]);

function roomProps({ host = true, mode = 'team' } = {}) {
  const ffa = mode === 'ffa';
  const players = [
    { id: 'h', name: host ? NICK_LONG : '번개J', team: ffa ? null : 'owner', ready: true, ping: 24, host: true },
    { id: 'o2', name: '달빛', team: ffa ? null : 'owner', ready: true, ping: 61 },
    { id: 'o3', name: '그림자', team: ffa ? null : 'owner', ready: false, ping: 88 },
    { id: 'c1', name: '호랑이', team: ffa ? null : 'charterer', ready: true, ping: 95 },
    { id: 'c2', name: '여우', team: ffa ? null : 'charterer', ready: true, ping: 172 },
  ];
  if (!host) players.push({ id: 'me', name: NICK_LONG, team: ffa ? null : 'charterer', ready: false, ping: 38 });
  return {
    roomId: 'k7q2', name: ROOM_LONG, mapId: 'alley', mode, ruleset: 'classic', killTarget: ffa ? 20 : undefined, max: 6,
    hostId: 'h', meId: host ? 'h' : 'me', players, chat: CHAT.slice(),
  };
}

const TEAM_STATS = Object.freeze([
  { id: 'me', name: NICK_LONG, team: 'owner', kills: 12, deaths: 4, head: 6, ping: 31, alive: true, me: true },
  { id: 'o1', name: '달빛', team: 'owner', kills: 7, deaths: 6, head: 2, ping: 61, alive: false },
  { id: 'o2', name: '그림자', team: 'owner', kills: 5, deaths: 7, head: 1, ping: 88, alive: true, bot: true },
  { id: 'o3', name: '바람개비', team: 'owner', kills: 3, deaths: 8, head: 0, ping: 120, alive: true, bot: true },
  { id: 'c1', name: '호랑이', team: 'charterer', kills: 9, deaths: 5, head: 3, ping: 95, alive: true },
  { id: 'c2', name: '여우', team: 'charterer', kills: 8, deaths: 7, head: 4, ping: 172, alive: false },
  { id: 'c3', name: '늑대', team: 'charterer', kills: 4, deaths: 8, head: 1, ping: 45, alive: true, bot: true },
  { id: 'c4', name: '독수리', team: 'charterer', kills: 2, deaths: 9, head: 0, ping: 20, alive: true, bot: true },
]);

const FFA_STATS = Object.freeze(['하늘', NICK_LONG, '호랑이', '여우', '그림자', '달빛', '늑대', '독수리'].map((name, i) => ({
  id: `p${i}`, name, kills: 20 - i * 2, deaths: 3 + i, head: 8 - i, ping: 20 + i * 25, alive: i !== 3, respawnIn: i === 3 ? 2100 : null, me: i === 1, bot: i > 3, rank: i + 1,
})));

const REWARD = Object.freeze({
  gained: 180, points: 12525,
  breakdown: [{ label: '경기 참여', points: 50 }, { label: '승리', points: 80 }, { label: '킬 12', points: 36 }, { label: '헤드샷 6', points: 14 }],
});

const TEAM_RESULT = Object.freeze({
  ruleset: 'classic', winner: 'owner', score: { owner: 3, charterer: 2 }, myTeam: 'owner', mapId: 'alley', meId: 'me', reward: REWARD,
  rounds: [
    { winner: 'owner', reason: '섬멸' }, { winner: 'charterer', reason: '시간 종료 · 생존자 수' }, { winner: 'owner', reason: '섬멸' },
    { winner: 'charterer', reason: '섬멸' }, { winner: 'owner', reason: '시간 종료 · 체력 합' },
  ],
  players: TEAM_STATS, mvp: { id: 'me', name: NICK_LONG, team: 'owner', kills: 12, deaths: 4, head: 6 },
  backLabel: '다시 하기', lobbyLabel: '메뉴로',
});

const FFA_RESULT = Object.freeze({
  mode: 'ffa', ruleset: 'classic', ranking: FFA_STATS, winnerId: 'p0', winnerName: '하늘', reason: 'kills', target: 20, mapId: 'nexus', meId: 'p1', reward: REWARD,
  backLabel: '다시 하기', lobbyLabel: '메뉴로',
});

/** 페이지에서: 이 화면에서 잘리거나 손이 닿지 않는 곳을 찾는다. 스크롤 위치는 원래대로 돌려 둔다 */
function audit({ root, tapMin, tapMinWidth }) {
  const box = document.querySelector(root);
  if (!box) return { missing: true };
  const vw = innerWidth, vh = innerHeight;
  const out = { cut: [], wide: [], unreachable: [], small: [], truncated: [] };
  const shown = (n) => {
    if (n.closest('[hidden]')) return false;
    const r = n.getBoundingClientRect();
    const cs = getComputedStyle(n);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
  };
  const label = (n) => (n.textContent || n.getAttribute('aria-label') || n.title || n.className || n.tagName).trim().replace(/\s+/g, ' ').slice(0, 24);
  const scrollable = (o) => o === 'auto' || o === 'scroll';
  /** 가로로 스크롤되는 조상 안이면 화면 밖에 있어도 손으로 꺼낼 수 있다 */
  const scrollsX = (n) => {
    for (let p = n.parentElement; p && p !== document.documentElement; p = p.parentElement) {
      if (scrollable(getComputedStyle(p).overflowX) && p.scrollWidth > p.clientWidth) return true;
    }
    return false;
  };

  for (const n of box.querySelectorAll('*')) {
    if (n.closest('svg') || !shown(n)) continue;
    if (getComputedStyle(n).textOverflow === 'ellipsis' && n.scrollWidth > n.clientWidth) out.truncated.push(label(n));
    if (n.children.length && !n.matches('button, input')) continue;
    const r = n.getBoundingClientRect();
    if ((r.left < -1 || r.right > vw + 1) && !scrollsX(n)) out.wide.push(`${label(n)} x ${Math.round(r.left)}..${Math.round(r.right)}`);
  }

  const targets = [...box.querySelectorAll('button, input, a[href]')].filter(shown);
  for (const n of targets) {
    if (n.tagName === 'BUTTON' && n.scrollWidth > n.clientWidth + 1) out.cut.push(`${label(n)} ${n.clientWidth} < ${n.scrollWidth}`);
    const size = n.getBoundingClientRect();
    if (tapMin && (size.height < tapMin - 0.5 || size.width < tapMinWidth - 0.5)) out.small.push(`${label(n)} ${Math.round(size.width)}x${Math.round(size.height)}`);
  }

  const saved = new Map();
  for (const n of targets) for (let p = n.parentElement; p; p = p.parentElement) if (!saved.has(p)) saved.set(p, [p.scrollLeft, p.scrollTop]);
  const restore = () => { for (const [p, [x, y]] of saved) { if (p.scrollLeft !== x) p.scrollLeft = x; if (p.scrollTop !== y) p.scrollTop = y; } };
  for (const n of targets) {
    n.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    // overflow:hidden 조상이 코드로만 밀렸다면 사람 손으로는 닿지 못한다
    let stuck = false;
    for (let p = n.parentElement; p; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if ((p.scrollLeft && !scrollable(cs.overflowX)) || (p.scrollTop && !scrollable(cs.overflowY))) stuck = true;
    }
    const r = n.getBoundingClientRect();
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    const inView = r.left >= -1 && r.right <= vw + 1 && r.top >= -1 && r.bottom <= vh + 1;
    if (stuck || !inView || !at || !(at === n || n.contains(at))) {
      out.unreachable.push(`${label(n)} ${Math.round(r.left)},${Math.round(r.top)}${stuck ? ' 숨은 스크롤' : ''}${at && at !== n && !n.contains(at) ? ` 가림 ${at.className || at.tagName}` : ''}`);
    }
    restore();
  }
  return out;
}

/** 페이지에서: 이 화면 모든 요소의 자리와 주요 스타일을 한 값으로 줄인다. PC 크기의 결과를 이전 커밋과 맞대 본다 */
function layoutSig(root) {
  let hash = 0, count = 0;
  for (const n of document.querySelectorAll(`${root}, ${root} *`)) {
    if (n.closest('.sk-lo-bar')) continue;   // 남은 시간 막대는 시각에 따라 달라진다
    const r = n.getBoundingClientRect(), cs = getComputedStyle(n);
    const text = [n.tagName, n.className.baseVal ?? n.className, r.left, r.top, r.width, r.height, cs.display, cs.fontSize, cs.color, cs.backgroundColor, cs.padding, cs.margin].join('|');
    for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) | 0;
    count++;
  }
  return `${count}개 ${(hash >>> 0).toString(16)}`;
}

/** 페이지에서: 스크롤 없이 다 보이는가 */
function fitsAt(sel) {
  const el = document.querySelector(sel);
  return !!el && el.scrollHeight <= el.clientHeight + 1;
}

/** 페이지에서: 부활 화면 요소들의 자리 */
function deathLayout() {
  const rect = (s) => {
    const el = document.querySelector(s);
    if (!el || el.closest('[hidden]')) return null;
    const r = el.getBoundingClientRect();
    return r.width > 0 ? { l: r.left, t: r.top, r: r.right, b: r.bottom, h: r.height } : null;
  };
  const cards = document.querySelector('.sk-lc-cards');
  return {
    vw: innerWidth, vh: innerHeight, lc: rect('.sk-lc'), rsp: rect('.sk-rsp'), hint: rect('.sk-hint'),
    scrollable: !!cards && cards.scrollWidth > cards.clientWidth + 1,
    selVisible: (() => {
      const sel = document.querySelector('.sk-lc-card.is-sel');
      if (!sel || !cards) return false;
      const a = sel.getBoundingClientRect(), b = cards.getBoundingClientRect();
      return a.left >= b.left - 1 && a.right <= b.right + 1;
    })(),
  };
}

const overlaps = (a, b) => !!a && !!b && a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
const inside = (a, vw, vh) => !!a && a.l >= -1 && a.t >= -1 && a.r <= vw + 1 && a.b <= vh + 1;

/** 터치 에뮬레이션을 켠 탭에서 휴대폰 크기로 게임을 연다 */
async function openPhone(t, phone, { query = '', ...opts } = {}) {
  const page = await t.newPage();
  const touch = phone.touch !== false;
  page.usesMouse = !touch;
  if (touch) await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await openGame(t, query, { settings: LOW_QUALITY, ...opts, width: phone.w, height: phone.h, reusePage: true });
  if (touch) await page.send('Emulation.setDeviceMetricsOverride', { width: phone.w, height: phone.h, deviceScaleFactor: 1, mobile: true });
  if (phone.insets) await page.send('Emulation.setSafeAreaInsetsOverride', { insets: phone.insets }).catch(() => t.note(`${phone.id}: 이 브라우저는 안전 영역을 흉내 내지 못한다`));
  return page;
}

const uiShow = (page, name, props) => page.fn((a) => { window.__qa.ui.show(a.name, a.props); }, { name, props });

/** 이 글자가 들어 있는 보이는 요소의 가운데. 없으면 null */
function centerOf({ selector, text }) {
  for (const el of document.querySelectorAll(selector)) {
    if (text != null && !(el.textContent || '').includes(text)) continue;
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }
  return null;
}

/** 손가락으로 누른다(터치 → 클릭까지 브라우저가 만들어 낸다) */
async function tap(page, selector, text = null, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  let c = await page.fn(centerOf, { selector, text });
  while (!c) {
    if (Date.now() >= end) throw new Error(`누를 요소가 보이지 않아요: ${selector} ${text == null ? '' : text}`);
    await sleep(100);
    c = await page.fn(centerOf, { selector, text });
  }
  if (page.usesMouse) {
    await page.mouseClick(c.x, c.y);
    await sleep(120);
    return;
  }
  await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: c.x, y: c.y }] });
  await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(120);
}

/** 손가락으로 민다. dx, dy는 내용이 움직일 거리(양수면 오른쪽·아래 내용을 끌어온다). 한 번에 못 밀면 여러 번 민다 */
async function swipe(page, selector, dx, dy) {
  const box = await page.fn((sel) => {
    const r = document.querySelector(sel).getBoundingClientRect();
    return { l: Math.max(r.left, 0), t: Math.max(r.top, 0), r: Math.min(r.right, innerWidth), b: Math.min(r.bottom, innerHeight) };
  }, selector);
  const horizontal = dx !== 0;
  if (page.usesMouse) {
    await page.wheel(dy, (box.l + box.r) / 2, (box.t + box.b) / 2);
    await sleep(200);
    return;
  }
  const span = (horizontal ? box.r - box.l : box.b - box.t) - 20;
  const dir = Math.sign(horizontal ? dx : dy);
  const at = (d) => (horizontal
    ? { x: dir > 0 ? box.r - 10 - d : box.l + 10 + d, y: (box.t + box.b) / 2 }
    : { x: (box.l + box.r) / 2, y: dir > 0 ? box.b - 10 - d : box.t + 10 + d });
  for (let left = Math.abs(horizontal ? dx : dy); left > 0; left -= span) {
    const stroke = Math.min(left, span);
    await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [at(0)] });
    for (let i = 1; i <= 10; i++) {
      await page.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [at(stroke * i / 10)] });
      await sleep(16);
    }
    // 멈췄다가 뗀다. 관성 스크롤이 남으면 다음 터치가 클릭이 되지 않고 스크롤만 멈춘다
    await sleep(150);
    await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(120);
  }
}

const scrollOf = (page, sel) => page.fn((s) => { const el = document.querySelector(s); return el ? [el.scrollLeft, el.scrollTop] : [0, 0]; }, sel);
const rewind = (page, sel) => page.fn((s) => { const el = document.querySelector(s); if (el) { el.scrollLeft = 0; el.scrollTop = 0; } }, sel);

export default {
  name: 'mobile-menus',
  title: '휴대폰 크기의 경기 밖 화면: 잘림, 손이 닿는지, 누름 대상 크기',
  timeoutMs: 15 * 60 * 1000,
  async run(t) {
    const [phoneFilter, shotFilter] = (t.filter || '').split('/');
    const named = phoneFilter ? phoneFilter.split(',') : null;
    const phones = named ? [...PHONES, ...EXTRA_PHONES].filter((p) => named.includes(p.id)) : PHONES;
    const wantedShot = (name) => !shotFilter || shotFilter.split(',').some((w) => name.includes(w));
    for (const phone of phones) {
      const touch = phone.touch !== false;

      /** 사진을 남기고 이 화면을 검사한다 */
      const see = async (name, root, { fits = null } = {}) => {
        if (!wantedShot(name)) return;
        const pg = t.page;
        await sleep(280);
        await t.shot(`${phone.id}-${name}`);
        if (!root) return;
        const r = await pg.fn(audit, { root, tapMin: touch ? TAP_MIN : 0, tapMinWidth: TAP_MIN_WIDTH });
        const at = `${phone.id} ${name}`;
        if (!t.check(!r.missing, `${at}: 화면이 있다`, root)) return;
        t.check(r.cut.length === 0, `${at}: 글자가 버튼을 넘치지 않는다`, r.cut);
        t.check(r.wide.length === 0, `${at}: 가로로 나간 것이 없다`, r.wide);
        t.check(r.unreachable.length === 0, `${at}: 모든 컨트롤에 손이 닿는다`, r.unreachable);
        t.check(r.small.length === 0, `${at}: 누름 대상이 ${TAP_MIN}px 이상이다`, r.small);
        if (r.truncated.length) t.note(`${at}: 말줄임 ${r.truncated.join(', ')}`);
        if (fits && touch) t.check(await pg.fn(fitsAt, fits), `${at}: 스크롤 없이 다 보인다`, fits);
        if (!touch) t.note(`${at}: 배치 ${await pg.fn(layoutSig, root)}`);
      };

      t.setSection(`${phone.id}: 닉네임 게이트`);
      let page = await openPhone(t, phone, { profile: null, screen: 'menu' });
      await page.waitFor('__qa.ui.isVisible("nickname")', 10000, { label: '닉네임 게이트' });
      t.check(touch === await page.eval(`matchMedia('(pointer: coarse)').matches && matchMedia('(hover: none)').matches`), '터치 에뮬레이션이 켜져 있다(PC 크기는 꺼져 있다)');
      t.check((await page.eval('[innerWidth, innerHeight].join()')) === `${phone.w},${phone.h}`, '휴대폰 크기다', await page.eval('[innerWidth, innerHeight].join()'));
      await see('gate', '.sk-nick', { fits: '.sk-nick' });
      await page.fn(() => { const el = document.querySelector('#sk-gate-nick'); el.focus(); el.select(); });
      await page.type('a');
      await page.waitFor(`document.querySelector('#sk-gate-nick-status').classList.contains('is-bad')`, 3000, { label: '잘못된 이름' });
      await see('gate-bad', '.sk-nick', { fits: '.sk-nick' });
      await page.fn(() => { const el = document.querySelector('#sk-gate-nick'); el.focus(); el.select(); });
      await page.type('새손님');
      await page.waitFor(`!document.querySelector('.sk-nick-submit').disabled`, 3000, { label: '저장 켜짐' });
      await tap(page, '.sk-nick-submit');
      await page.waitFor('!__qa.ui.isVisible("nickname")', 3000, { label: '터치로 게이트 닫힘' });
      t.errorsOk(`${phone.id} 게이트`);

      t.setSection(`${phone.id}: 메뉴`);
      const stats = { kills: 57, deaths: 31, headshots: 12, halfShots: 3, knifeKills: 4, matches: 9, wins: 4, secondsPlayed: 3725 };
      const profile = richProfile({ nickname: NICK_LONG, points: 12345, stats, secrets: { alley: { alley_watertower: { name: '물탱크 옥상', at: 5 } } } });
      page = await openPhone(t, phone, { profile, screen: 'menu' });
      await page.waitFor('__qa.ui.isVisible("menu")', 5000, { label: '메뉴' });
      await see('menu', '.sk-menu', { fits: '.sk-menu' });

      await tap(page, '.sk-menu-btn--wide', '연습장');
      await page.waitFor('!!document.querySelector(".sk-sheet")', 3000, { label: '터치로 연습장 시트' });
      await see('practice-sheet', '.sk-sheet');
      await swipe(page, '.sk-sheet-body', 0, 600);
      t.check((await scrollOf(page, '.sk-sheet-body'))[1] > 0, `${phone.id}: 연습장 시트를 손으로 밀 수 있다`);
      await see('practice-sheet-end');
      await tap(page, '.sk-sheet-foot .sk-btn', '취소');
      await page.waitFor('!document.querySelector(".sk-sheet")', 3000, { label: '터치로 시트 닫힘' });

      await tap(page, '.sk-menu-btn--sub', '설정');
      await page.waitFor(`!document.querySelector('.sk-menu .sk-modal').hidden`, 3000, { label: '터치로 설정' });
      await see('settings', '.sk-settings');
      await tap(page, '.sk-settings .sk-sheet-foot .sk-btn--primary');
      await page.waitFor(`document.querySelector('.sk-menu .sk-modal').hidden`, 3000, { label: '터치로 설정 닫힘' });

      await tap(page, '.sk-menu-btn--sub', '조작법');
      await page.waitFor(`!document.querySelector('.sk-menu .sk-modal').hidden`, 3000, { label: '터치로 조작법' });
      await see('controls', '.sk-controls');
      await swipe(page, '.sk-controls .sk-sheet-body', 0, 700);
      t.check((await scrollOf(page, '.sk-controls .sk-sheet-body'))[1] > 0, `${phone.id}: 조작법을 손으로 밀 수 있다`);
      await see('controls-end');
      await tap(page, '.sk-controls .sk-sheet-foot .sk-btn--primary');
      await page.waitFor(`document.querySelector('.sk-menu .sk-modal').hidden`, 3000, { label: '터치로 조작법 닫힘' });

      t.setSection(`${phone.id}: 마이페이지`);
      await tap(page, '.sk-player-mypage');
      await page.waitFor('__qa.ui.isVisible("mypage")', 3000, { label: '터치로 마이페이지' });
      await see('mypage', '.sk-mypage');
      await swipe(page, '.sk-mypage', 0, 500);
      t.check((await scrollOf(page, '.sk-mypage'))[1] > 0, `${phone.id}: 마이페이지를 손으로 밀 수 있다`);
      await see('mypage-mid');
      await tap(page, '.sk-my-resetbtn');
      await page.waitFor(`!document.querySelector('.sk-mypage .sk-confirm').hidden`, 3000, { label: '확인 상자' });
      await see('mypage-reset', '.sk-mypage');
      await tap(page, '.sk-mypage .sk-confirm .sk-btn', '취소');

      t.setSection(`${phone.id}: 상점`);
      await tap(page, '.sk-mypage .sk-my-panelhead .sk-btn--sm');
      await page.waitFor('__qa.ui.isVisible("shop")', 3000, { label: '터치로 상점' });
      for (const [tab, id] of [['라이플', 'rifle'], ['저격', 'sniper'], ['SMG·샷건', 'smg'], ['권총', 'pistol'], ['근접', 'melee']]) {
        await tap(page, '.sk-shop .sk-tab', tab);
        await rewind(page, '.sk-shop');
        await see(`shop-${id}`, '.sk-shop');
      }
      await swipe(page, '.sk-shop', 0, 400);
      t.check((await scrollOf(page, '.sk-shop'))[1] > 0, `${phone.id}: 상점을 손으로 밀 수 있다`);
      if (touch) t.check(await page.eval(`document.querySelector('.sk-shop .sk-tabs').getBoundingClientRect().top >= 0`), `${phone.id}: 내려도 탭이 위에 남는다`);
      await see('shop-scrolled');
      await tap(page, '.sk-shop .sk-tab', '라이플');
      await rewind(page, '.sk-shop');
      t.errorsOk(`${phone.id} 메뉴·상점`);

      t.setSection(`${phone.id}: 로비`);
      await uiShow(page, 'lobby', { rooms: ROOMS, name: NICK_LONG });
      await see('lobby', '.sk-lobby');
      await uiShow(page, 'lobby', { rooms: [], error: '로비 서버에 연결할 수 없어요. 네트워크를 확인하고 다시 시도해 주세요.', name: NICK_LONG });
      await see('lobby-error', '.sk-lobby');
      await uiShow(page, 'lobby', { rooms: [], name: NICK_LONG });
      await see('lobby-empty', '.sk-lobby');
      await tap(page, '.sk-lobby .sk-bar-actions .sk-btn--primary');
      await page.waitFor('!!document.querySelector(".sk-create-sheet")', 3000, { label: '터치로 방 만들기' });
      const nameFocused = await page.eval(`document.activeElement === document.querySelector('.sk-create input')`);
      t.check(nameFocused === !touch, `${phone.id}: 터치 기기에서는 방 이름 칸에 바로 포커스를 주지 않는다(가상 키보드가 시트를 덮는다)`);
      await see('create-room', '.sk-create-sheet');
      await tap(page, '.sk-create .sk-mode-btn[data-mode="ffa"]');
      await swipe(page, '.sk-create-sheet .sk-sheet-body', 0, 900);
      t.check((await scrollOf(page, '.sk-create-sheet .sk-sheet-body'))[1] > 0, `${phone.id}: 방 만들기 시트를 손으로 밀 수 있다`);
      await see('create-room-end');
      await tap(page, '.sk-form-actions .sk-btn', '취소');

      t.setSection(`${phone.id}: 대기실`);
      await uiShow(page, 'room', roomProps({ host: true }));
      await see('room-host', '.sk-room');
      await swipe(page, '.sk-room', 0, 420);
      await see('room-host-mid');
      await uiShow(page, 'room', roomProps({ host: false }));
      await rewind(page, '.sk-room');
      await see('room-guest', '.sk-room');
      await uiShow(page, 'room', roomProps({ host: true, mode: 'ffa' }));
      await rewind(page, '.sk-room');
      await see('room-ffa', '.sk-room');
      t.errorsOk(`${phone.id} 로비·대기실`);

      t.setSection(`${phone.id}: 일시정지`);
      await uiShow(page, 'hud', {});
      await uiShow(page, 'pause', { leaveLabel: '연습장 나가기', note: '연습장은 일시정지하면 봇도 멈춰요.' });
      await see('pause', '.sk-pause', { fits: '.sk-pause' });
      await tap(page, '.sk-pause-btns .sk-btn--danger');
      await page.waitFor(`!document.querySelector('.sk-pause .sk-confirm').hidden`, 3000, { label: '나가기 확인' });
      await see('pause-confirm', '.sk-pause', { fits: '.sk-pause' });
      await tap(page, '.sk-pause .sk-confirm .sk-btn', '취소');
      await tap(page, '.sk-pause-btns .sk-btn', '설정');
      await page.waitFor(`!document.querySelector('.sk-pause .sk-modal').hidden`, 3000, { label: '일시정지 설정' });
      await see('pause-settings', '.sk-pause .sk-settings');
      await tap(page, '.sk-pause .sk-settings .sk-sheet-foot .sk-btn--primary');
      await page.fn(() => { window.__qa.ui.hide('pause'); });

      t.setSection(`${phone.id}: 무기 선택`);
      await uiShow(page, 'loadout', { ruleset: 'classic', seconds: 60, selected: 'ar_std', round: 3 });
      // 고르는 시간이 짧으니 기준 가로 화면에서는 무기 전부가 한 화면에 들어가야 한다
      await see('loadout-classic', '.sk-loadout', { fits: phone.landscape && phone.h >= 375 ? '.sk-loadout' : null });
      await swipe(page, '.sk-loadout', 0, 300);
      await see('loadout-classic-end');
      await page.fn(() => { window.__qa.ui.hide('loadout'); });
      await uiShow(page, 'loadout', { ruleset: 'sniper', seconds: 60, selected: 'sr_bolt', title: '개인전 · 무기 선택' });
      await see('loadout-sniper', '.sk-loadout');
      await page.fn(() => { window.__qa.ui.hide('loadout'); });
      await uiShow(page, 'loadout', { ruleset: 'knife', seconds: 0, selected: 'ml_knife', round: 1 });
      await see('loadout-knife', '.sk-loadout');
      await page.fn(() => { window.__qa.ui.hide('loadout'); });

      t.setSection(`${phone.id}: 부활 대기 패널`);
      await page.fn(() => {
        const ui = window.__qa.ui;
        ui.hud.set({ hp: 0, maxHp: 100, ammo: 22, mag: 30, reserve: 60, slot: 1, weaponName: 'RX-4 돌격소총', roundTime: 247, hint: 'G 키로 RX-4 버리기 · 4초', respawn: { seconds: 3, killer: '호랑이', weaponName: 'H-50 타이탄' } });
      });
      for (const [name, props] of [
        ['many', { ruleset: 'classic', selected: 'sr_heavy' }],
        ['few', { weapons: ['sr_bolt', 'ar_std'], selected: 'ar_std' }],
        ['knife', { ruleset: 'knife', selected: 'ml_knife' }],
      ]) {
        await uiShow(page, 'loadout', { compact: true, seconds: 0, title: '다음 부활 무기', ...props });
        await see(`compact-${name}`, '.sk-lc');
        if (touch) {
          const d = await page.fn(deathLayout);
          t.check(inside(d.lc, d.vw, d.vh), `${phone.id} compact ${name}: 패널이 화면 안에 있다`, d);
          t.check(inside(d.rsp, d.vw, d.vh), `${phone.id} compact ${name}: 부활 안내가 화면 안에 있다`, d);
          t.check(inside(d.hint, d.vw, d.vh), `${phone.id} compact ${name}: G 안내가 화면 안에 있다`, d);
          t.check(!overlaps(d.lc, d.rsp), `${phone.id} compact ${name}: 패널이 부활 안내를 가리지 않는다`, d);
          t.check(!overlaps(d.lc, d.hint), `${phone.id} compact ${name}: 패널이 G 안내를 가리지 않는다`, d);
          t.check(d.selVisible, `${phone.id} compact ${name}: 고른 무기가 보인다`, d);
          if (name === 'many') {
            t.check(d.lc.h <= d.vh * 0.45, `${phone.id} compact many: 패널이 화면을 덮지 않는다`, d);
            t.check(d.scrollable, `${phone.id} compact many: 무기가 많으면 줄이 옆으로 밀린다`, d);
            const stripX = () => page.fn(() => document.querySelector('.sk-lc-cards').scrollLeft);
            await page.fn(() => { document.querySelector('.sk-lc-cards').scrollLeft = 0; });
            await swipe(page, '.sk-lc-cards', 500, 0);
            t.check((await stripX()) > 0, `${phone.id} compact many: 무기 줄을 손으로 밀 수 있다`);
            await page.fn(centerOf, { selector: '.sk-lc-card', text: 'H-50' });
            const before = await stripX();
            await tap(page, '.sk-lc-card', 'H-50');
            t.check(await page.eval(`(document.querySelector('.sk-lc-card.is-sel') || {}).title === 'H-50 타이탄'`), `${phone.id} compact many: 터치로 무기를 고른다`);
            t.check(/H-50/.test(await page.eval(`__qa.text('.sk-lc-note')`)), `${phone.id} compact many: 고른 무기를 알려 준다`, await page.eval(`__qa.text('.sk-lc-note')`));
            const later = await stripX();
            t.check(Math.abs(later - before) < 2, `${phone.id} compact many: 고른 뒤에도 무기 줄 위치가 튀지 않는다`, { before, later });
            await see('compact-picked', '.sk-lc');
          }
        }
        await page.fn(() => { window.__qa.ui.hide('loadout'); });
      }
      await page.fn(() => { window.__qa.ui.hud.set({ respawn: null, hint: '' }); });

      t.setSection(`${phone.id}: 점수판`);
      // 점수판은 입력을 받지 않으므로 기본은 스크롤 없이 다 보여야 한다
      await uiShow(page, 'scoreboard', { players: TEAM_STATS, score: { owner: 1, charterer: 1, target: 3, round: 3 }, mapId: 'alley', meId: 'me' });
      await see('scoreboard-team', '.sk-scoreboard', { fits: '.sk-sb-panel' });
      await page.fn(() => { window.__qa.ui.hide('scoreboard'); });
      await uiShow(page, 'scoreboard', { mode: 'ffa', target: 20, players: FFA_STATS, mapId: 'nexus', meId: 'p1' });
      await see('scoreboard-ffa', '.sk-scoreboard', { fits: '.sk-sb-panel' });
      await page.fn(() => { window.__qa.ui.hide('scoreboard'); });

      t.setSection(`${phone.id}: 결과`);
      await uiShow(page, 'results', TEAM_RESULT);
      await sleep(1000);   // 포인트 숫자가 다 올라갈 때까지
      await see('results-team', '.sk-results');
      await swipe(page, '.sk-results', 0, 500);
      await see('results-team-mid');
      await uiShow(page, 'results', FFA_RESULT);
      await rewind(page, '.sk-results');
      await sleep(1000);
      await see('results-ffa', '.sk-results');
      await swipe(page, '.sk-results', 0, 500);
      await see('results-ffa-mid');
      t.errorsOk(`${phone.id} 경기 화면 레이어`);

      t.setSection(`${phone.id}: 새 손님의 상점과 마이페이지`);
      page = await openPhone(t, phone, { profile: { nickname: '새손님', points: 500, createdAt: 1 }, screen: 'menu' });
      await page.waitFor('__qa.ui.isVisible("menu")', 5000, { label: '메뉴' });
      await tap(page, '.sk-menu-btn--sub', '상점');
      await page.waitFor('__qa.ui.isVisible("shop")', 3000, { label: '터치로 상점' });
      await see('shop-new-rifle', '.sk-shop');
      await tap(page, '.sk-shop .sk-tab', '권총');
      await tap(page, '.sk-shop-card[aria-label="M-44 매그넘"] .sk-shop-action');
      await page.waitFor(`/샀어요/.test(document.querySelector('.sk-shop-note').textContent)`, 3000, { label: '터치로 구매' });
      await see('shop-new-bought', '.sk-shop');
      await tap(page, '.sk-shop .sk-btn--ghost');
      await page.waitFor('!__qa.ui.isVisible("shop")', 3000, { label: '상점 나가기' });
      await page.fn(() => { window.__qa.ui.show('mypage'); });
      await see('mypage-new', '.sk-mypage');
      t.errorsOk(`${phone.id} 새 손님`);

      if (!phone.real || !wantedShot('real')) continue;
      t.setSection(`${phone.id}: 실제 경기에서 부활 패널`);
      const armed = richProfile({ nickname: NICK_LONG, loadout: { primary: 'ar_std', secondary: 'pt_std', melee: 'ml_knife' } });
      page = await openPhone(t, phone, { query: 'sandbox=alley&ruleset=classic&mode=ffa&bots=1&botweapon=ar_std&killtarget=50', profile: armed, screen: 'sandbox' });
      await waitRun(page);
      await page.eval('__qa.freezeBots()');
      if (await page.eval('__qa.ui.isVisible("loadout")')) await see('real-loadout', '.sk-loadout');
      await waitLive(page);
      await page.waitFor('!__qa.ui.isVisible("loadout")', 8000, { label: '무기 선택 닫힘' });
      await lockPointer(page, 5000).catch(() => t.note(`${phone.id}: 포인터 잠금 없이 진행`));
      const spot = await page.fn(() => {
        const c = window.__qa.ctx, w = c.world, P = c.physics;
        for (let x = -30; x <= 30; x += 2) {
          for (let z = -18; z <= 18; z += 2) {
            const bx = x + 6;
            if (P.findFloor(w, x, z) !== 0 || P.findFloor(w, bx, z) !== 0) continue;
            if (!window.__qa.clearOfTriggers(x, z) || !window.__qa.clearOfTriggers(bx, z)) continue;
            if (P.overlapsCapsule(w, x, 0, z, 0.4, 1.9) || P.overlapsCapsule(w, bx, 0, z, 0.4, 1.9)) continue;
            if (P.lineOfSight(w, [x, 1.6, z], [bx, 1.6, z])) return { a: { x, z }, b: { x: bx, z } };
          }
        }
        return null;
      });
      if (!spot) throw new Error('평지를 찾지 못했어요');
      await page.fn((s) => {
        const qa = window.__qa;
        qa.teleport(s.a.x, 0, s.a.z);
        qa.ctx.player.state.onGround = true;
        qa.placeBot(0, s.b.x, 0, s.b.z);
        const p = qa.ctx.player.state, b = qa.run.bots[0];
        const dx = p.pos[0] - b.body.pos[0], dz = p.pos[2] - b.body.pos[2], dy = (p.pos[1] + 1.2) - (b.body.pos[1] + 1.6);
        b.yaw = Math.atan2(-dx, -dz);
        b.pitch = Math.atan2(dy, Math.hypot(dx, dz));
        b.brain.think = (dt, view) => ({ forward: 0, strafe: 0, jump: false, walk: false, yawDelta: 0, pitchDelta: 0, fire: true, zoom: false, reload: view.self.ammo.mag === 0, slot: null });
      }, spot);
      await page.waitFor('!__qa.world.localAlive', 20000, { intervalMs: 50, label: '봇에게 쓰러짐' });
      await page.eval('__qa.freezeBots()');
      await waitTicks(page, 2);
      await page.waitFor('__qa.ui.isVisible("loadout") && !document.querySelector(".sk-lc").hidden', 3000, { label: '부활 패널' });
      await see('real-compact', '.sk-lc');
      const d = await page.fn(deathLayout);
      t.check(inside(d.lc, d.vw, d.vh) && inside(d.rsp, d.vw, d.vh), `${phone.id} 실제 경기: 패널과 부활 안내가 화면 안에 있다`, d);
      t.check(!overlaps(d.lc, d.rsp), `${phone.id} 실제 경기: 패널이 부활 안내를 가리지 않는다`, d);
      t.check(!overlaps(d.lc, d.hint), `${phone.id} 실제 경기: 패널이 아래 안내를 가리지 않는다`, d);
      t.check(/버리기/.test(await page.eval(`__qa.text('.sk-hint') || ''`)), `${phone.id} 실제 경기: 총 버리기 안내가 떠 있다`, await page.eval(`__qa.text('.sk-hint')`));
      await page.waitFor('__qa.world.localAlive', 12000, { intervalMs: 50, label: '부활' });
      await page.waitFor('!__qa.ui.isVisible("loadout")', 3000, { label: '부활하면 패널이 닫힌다' });
      await page.press('Escape');
      await page.waitFor('__qa.ui.isVisible("pause")', 5000, { label: '일시정지 메뉴' }).catch(() => t.note(`${phone.id}: Esc로 일시정지가 뜨지 않았다`));
      if (await page.eval('__qa.ui.isVisible("pause")')) await see('real-pause', '.sk-pause', { fits: '.sk-pause' });
      t.errorsOk(`${phone.id} 실제 경기`);
    }
  },
};
