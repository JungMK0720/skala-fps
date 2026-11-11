/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 시나리오 24. 전체 공지를 실제 화면으로 검사한다. Node 중계 서버를 띄우고 게임 화면과 운영자 패널(dev/notice.html)을 같이 열어,
 *          열쇠 확인(틀린 열쇠 거절·기억하기) → 보내기 → 게임 화면 맨 위에 뜸(메뉴·경기 HUD) → 바꾸기 → 내리기 → 시간이 지나면 스스로 내려감을 본다.
 */
import { join } from 'node:path';
import { startRelay } from '../../../server/relay/src/node.js';
import { generateNoticeKeys } from '../../../js/net/notice.js';
import { LOW_QUALITY, openGame, richProfile, sleep, waitLive, waitRun } from '../kit.mjs';

const PANEL_SIZE = { width: 900, height: 760 };

/** 페이지(운영자 패널)에서: 열쇠 칸에 글자를 넣고 확인을 누른다 */
function enterKey(text) {
  const box = document.querySelector('#np-key-text');
  box.value = text;
  box.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('#np-key-save').click();
}

/** 페이지(운영자 패널)에서: 공지 내용과 시간을 넣고 보낸다 */
function sendNotice({ text, ttl }) {
  const input = document.querySelector('#np-text');
  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  const sel = document.querySelector('#np-ttl');
  sel.value = String(ttl);
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  const btn = document.querySelector('#np-send');
  if (btn.disabled) return false;
  document.querySelector('#np-form').requestSubmit(btn);
  return true;
}

/** 페이지(게임)에서: 공지 띠의 상태 */
function banner() {
  const el = document.querySelector('.sk-notice');
  const root = document.querySelector('.sk-ui');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const top = document.querySelector('.sk-top');
  return {
    shown: !el.hidden && el.classList.contains('is-in'),
    hidden: el.hidden,
    text: el.querySelector('.sk-notice-text').textContent,
    tag: el.querySelector('.sk-notice-tag').textContent,
    rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
    centered: Math.abs(r.left + r.width / 2 - innerWidth / 2) < 2,
    reserve: root.classList.contains('sk-has-notice'),
    hudTopMargin: top ? parseFloat(getComputedStyle(top).marginTop) || 0 : null,
    hudTop: top ? Math.round(top.getBoundingClientRect().top) : null,
    pointer: getComputedStyle(el).pointerEvents
  };
}

const panelState = (page) => page.eval('window.__noticePanel ? window.__noticePanel.state() : null');
const panelText = (page, id) => page.eval(`document.querySelector(${JSON.stringify('#' + id)}).textContent`);

export default {
  name: 'notice',
  title: '전체 공지: 운영자 패널에서 보내면 게임 화면 맨 위에 뜬다',
  timeoutMs: 6 * 60 * 1000,
  async run(t) {
    const relay = await startRelay({ port: 0 });
    const keys = await generateNoticeKeys();
    const wrong = await generateNoticeKeys();
    t.server.setConfig(`window.SKALA_CONFIG = { supabase: { url: '', anonKey: '' }, transport: 'relay', relay: { url: ${JSON.stringify(relay.url)} }, notice: { key: ${JSON.stringify(keys.publicKey)} } };`);
    let panel = null;
    try {
      /* ---------- 게임 화면: 메뉴에서 공지를 받을 준비 ---------- */
      t.setSection('게임 화면이 공지 연결을 연다');
      const game = await openGame(t, '', { profile: richProfile(), settings: LOW_QUALITY, screen: 'menu' });
      await game.waitFor('__qa.game.notices.state().connected', 20000, { label: '공지 연결' });
      let b = await game.fn(banner);
      t.check(b && b.hidden && !b.reserve, '처음에는 띠가 없다', b);
      t.check(relay.hubs.has('skalafps:lobby'), '로비 허브에 붙는다', [...relay.hubs.keys()]);

      /* ---------- 운영자 패널: 연결 · 접속자 수 · 열쇠 ---------- */
      t.setSection('운영자 패널: 열쇠');
      panel = await t.browser.newPage({ isolated: true });
      await panel.open(`${t.base}dev/notice.html?debug=1`, { ...PANEL_SIZE, clean: true });
      await panel.waitFor('window.__noticePanel && window.__noticePanel.state().connected', 20000, { label: '패널 연결' });
      await panel.waitFor('window.__noticePanel.state().viewers === 1', 8000, { label: '접속자 수' });
      t.check(/접속 1명/.test(await panelText(panel, 'np-viewers')), '게임 화면을 연 사람 수를 보여 준다', await panelText(panel, 'np-viewers'));
      t.check(/연결됨/.test(await panelText(panel, 'np-conn')), '중계 서버 연결 상태를 보여 준다');
      let st = await panelState(panel);
      t.check(st.hasKey === false && (await panel.eval(`document.querySelector('#np-send').disabled`)), '열쇠가 없으면 보내기 버튼이 꺼져 있다', st);
      t.check((await panel.fn(sendNotice, { text: '열쇠 없이 보낸 공지', ttl: 10 })) === false, '열쇠 없이는 보낼 수 없다');

      await panel.fn(enterKey, '열쇠가 아닌 글자');
      await panel.waitFor(`/찾지 못했어요/.test(document.querySelector('#np-key-msg').textContent)`, 5000, { label: '열쇠 아님' });
      await panel.fn(enterKey, wrong.privateKey);
      await panel.waitFor(`/짝이 아니에요/.test(document.querySelector('#np-key-msg').textContent)`, 5000, { label: '다른 열쇠 거절' });
      t.check((await panelState(panel)).hasKey === false, '다른 열쇠는 받지 않는다');
      await panel.fn(enterKey, `운영자 열쇠 파일 내용\n비밀 열쇠:\n${keys.privateKey}\n`);
      await panel.waitFor('window.__noticePanel.state().hasKey', 5000, { label: '열쇠 확인' });
      t.check(/기억해 두었어요/.test(await panelText(panel, 'np-key-msg')), '열쇠를 확인하고 기억한다', await panelText(panel, 'np-key-msg'));
      t.check((await panel.eval(`document.querySelector('#np-key-text').value`)) === '', '확인한 뒤 붙여 넣은 글자를 지운다');
      t.check(!(await panel.eval(`JSON.stringify(Object.assign({}, localStorage, sessionStorage))`)).includes(keys.privateKey.slice(0, 40)), '열쇠 글자를 저장소에 그대로 두지 않는다');

      /* ---------- 보내기 → 메뉴 화면에 뜬다 ---------- */
      t.setSection('보내기: 메뉴 화면');
      // 3분짜리: 아래에서 게임 화면을 새로 열 때까지(느린 헤드리스 브라우저) 떠 있어야 한다
      t.check(await panel.fn(sendNotice, { text: '  오늘 밤 9시에   팀전 한 판 합니다!  ', ttl: 180 }), '보내기 버튼을 누른다');
      await panel.waitFor(`/보냈어요/.test(document.querySelector('#np-send-msg').textContent)`, 8000, { label: '보냄' });
      t.check(/접속 1명에게/.test(await panelText(panel, 'np-send-msg')), '몇 명에게 보냈는지 알려 준다', await panelText(panel, 'np-send-msg'));
      await game.waitFor(`(() => { const el = document.querySelector('.sk-notice'); return el && !el.hidden && el.classList.contains('is-in'); })()`, 8000, { label: '띠가 뜸' });
      await sleep(400);
      b = await game.fn(banner);
      t.check(b.text === '오늘 밤 9시에 팀전 한 판 합니다!' && b.tag === '공지', '보낸 글자가 그대로 뜬다(앞뒤·중복 공백은 정리)', b);
      t.check(b.centered && b.rect.y <= 12 && b.rect.y >= 0, '화면 맨 위 가운데에 뜬다', b.rect);
      t.check(b.pointer === 'none', '클릭을 가로채지 않는다', b.pointer);
      t.check(await game.eval('__qa.ui.isVisible("menu")'), '메뉴는 그대로 쓸 수 있다');
      await t.shot('menu');
      st = await panelState(panel);
      t.check(st.current && st.current.text === '오늘 밤 9시에 팀전 한 판 합니다!' && st.sent === 1, '패널에 떠 있는 공지와 남은 시간이 보인다', st);
      t.check(/남음/.test(await panelText(panel, 'np-live-left')) && (await panel.eval(`document.querySelectorAll('#np-log li').length`)) === 1, '보낸 기록에 한 줄이 남는다');
      await panel.screenshot(join(t.outDir, 'notice-panel.png'));

      /* ---------- 경기 중에도 뜬다: HUD 윗줄이 띠만큼 내려간다 ---------- */
      t.setSection('경기 화면');
      await openGame(t, 'sandbox=lot&ruleset=classic&mode=ffa&bots=1&killtarget=50', { profile: richProfile(), settings: LOW_QUALITY, screen: 'sandbox', reusePage: true, clean: false });
      await waitRun(game);
      await game.eval('__qa.freezeBots()');
      await waitLive(game);
      await game.waitFor('__qa.game.notices.state().connected', 20000, { label: '경기 화면의 공지 연결' });
      // 새로 연 화면은 올려 둔 공지를 받아 남은 시간만큼 띄운다
      await game.waitFor(`(() => { const el = document.querySelector('.sk-notice'); return el && !el.hidden && el.classList.contains('is-in'); })()`, 8000, { label: '늦게 연 화면에도 뜸' });
      await sleep(400);
      b = await game.fn(banner);
      t.check(b.text === '오늘 밤 9시에 팀전 한 판 합니다!', '새로 연 화면에도 떠 있는 공지가 온다', b);
      t.check(b.reserve && b.hudTopMargin >= b.rect.h, '경기 HUD의 윗줄이 띠 높이만큼 내려간다', b);
      t.check(b.hudTop >= b.rect.y + b.rect.h, '점수·타이머가 띠에 가려지지 않는다', { hudTop: b.hudTop, banner: b.rect });
      await t.shot('match');

      /* ---------- 바꾸기 ---------- */
      t.setSection('바꾸기');
      t.check(await panel.fn(sendNotice, { text: '시간이 바뀌었어요: 밤 10시', ttl: 10 }), '새 공지를 보낸다');
      await game.waitFor(`document.querySelector('.sk-notice-text').textContent === '시간이 바뀌었어요: 밤 10시'`, 8000, { label: '바뀐 공지' });
      t.check((await game.fn(banner)).shown, '새 공지가 앞의 공지를 바꾼다');

      /* ---------- 내리기 ---------- */
      t.setSection('내리기');
      await panel.click('#np-retract');
      await panel.waitFor(`/내렸어요/.test(document.querySelector('#np-send-msg').textContent)`, 8000, { label: '내림' });
      await game.waitFor(`document.querySelector('.sk-notice').hidden`, 8000, { label: '띠가 내려감' });
      b = await game.fn(banner);
      t.check(b.hidden && !b.reserve && b.hudTopMargin === 0, '띠가 사라지고 HUD가 제자리로 돌아온다', b);
      t.check((await panelState(panel)).current === null && (await panel.eval(`document.querySelector('#np-live-card').hidden`)), '패널에서도 떠 있는 공지가 없어진다');

      /* ---------- 시간이 지나면 스스로 내려간다 ---------- */
      t.setSection('시간이 지나면 내려간다');
      t.check(await panel.fn(sendNotice, { text: '10초 뒤에 사라지는 공지', ttl: 10 }), '10초짜리 공지를 보낸다');
      await game.waitFor(`(() => { const el = document.querySelector('.sk-notice'); return el && !el.hidden && el.classList.contains('is-in'); })()`, 8000, { label: '띠가 뜸' });
      const shownAt = Date.now();
      await game.waitFor(`document.querySelector('.sk-notice').hidden`, 20000, { label: '스스로 내려감' });
      const lasted = Date.now() - shownAt;
      t.check(lasted > 6000 && lasted < 15000, '정한 시간만큼 떠 있다가 내려간다', lasted);
      await panel.waitFor('window.__noticePanel.state().current === null', 8000, { label: '패널도 끝남' });
      t.errorsOk('게임 화면');

      /* ---------- 열쇠 기억하기 · 지우기 ---------- */
      t.setSection('열쇠 기억하기');
      await panel.open(`${t.base}dev/notice.html?debug=1`, { ...PANEL_SIZE });
      await panel.waitFor('window.__noticePanel && window.__noticePanel.state().connected', 20000, { label: '패널 다시 연결' });
      t.check((await panelState(panel)).hasKey === true, '다시 열어도 열쇠가 남아 있다');
      await panel.click('#np-key-forget');
      await panel.waitFor('window.__noticePanel.state().hasKey === false', 5000, { label: '열쇠 지움' });
      t.check(/열쇠를 지웠어요/.test(await panelText(panel, 'np-key-msg')), '저장된 열쇠를 다 지운 뒤에 지웠다고 알린다', await panelText(panel, 'np-key-msg'));
      // 지웠다고 한 바로 다음에 창을 새로 열어도 열쇠가 남아 있지 않아야 한다(지우기가 끝나기 전에 알리면 새로 고침이 지우기를 취소한다)
      await panel.open(`${t.base}dev/notice.html?debug=1`, { ...PANEL_SIZE });
      await panel.waitFor('window.__noticePanel && window.__noticePanel.state().connected', 20000, { label: '패널 또 다시 연결' });
      t.check((await panelState(panel)).hasKey === false, '지운 뒤에는 열쇠를 다시 넣어야 한다');
      t.check(panel.errors.length === 0, '운영자 패널: 오류가 없어야 한다', panel.errors.slice(0, 5).map((e) => `${e.type}: ${String(e.text).slice(0, 200)}`).join(' | '));
    } finally {
      t.server.setConfig(null);
      if (panel) await panel.close();
      await relay.close();
    }
    t.note('Node 중계 서버로 확인했다. 배포된 Cloudflare 중계 서버와 실제 여러 사람의 화면에서는 확인하지 못했다');
  }
};
