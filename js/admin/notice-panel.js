/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 운영자 패널(dev/notice.html)의 동작. 운영자 열쇠를 확인해 이 브라우저에 보관하고, 쓴 공지를 서명해 중계 서버 로비 허브에 올린다.
 *          지금 접속한 사람 수, 떠 있는 공지와 남은 시간, 보낸 기록을 보여 준다. 공지 규약은 js/net/notice.js.
 */
/*
 * 열쇠 보관: 비밀 열쇠는 꺼낼 수 없는 CryptoKey로 바꿔 IndexedDB('skala-admin' / 'keys' / 'notice')에 둔다.
 *   글자 그대로 저장하지 않으므로 저장된 것을 읽어도 열쇠 글자를 되돌릴 수 없다. '기억하기'를 끄면 이 창을 닫을 때 사라진다.
 * 시험: tools/qa/scenarios/notice.mjs가 이 페이지를 헤드리스 브라우저로 열어 열쇠 넣기 → 보내기 → 내리기를 해 본다.
 *   window.__noticePanel = { state() }로 지금 상태를 읽는다(주소에 debug=1이 있을 때만).
 */
import {
  NOTICE, cleanNoticeText, createNoticeSender, findNoticePrivateKey, importNoticePrivateKey, importNoticePublicKey,
  noticeCryptoAvailable, noticeKeysMatch
} from '../net/notice.js';

const DB_NAME = 'skala-admin';
const STORE = 'keys';
const KEY_ID = 'notice';
const STATUS_TEXT = { error: '서버가 공지를 받지 않았어요', timeout: '서버 응답이 없어요', disconnected: '중계 서버와 연결이 끊겨 있어요', none: '내릴 공지가 없어요' };

const $ = (id) => document.getElementById(id);

/* ---------------- 열쇠 보관(IndexedDB) ---------------- */

function openDb() {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error('IndexedDB 없음')); return; }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB 열기 실패'));
  });
}

async function dbRun(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onerror = tx.onabort = () => reject(tx.error || new Error('IndexedDB 오류'));
    });
  } finally {
    db.close();
  }
}

const loadStoredKey = () => dbRun('readonly', (s) => s.get(KEY_ID)).catch(() => null);
const storeKey = (key) => dbRun('readwrite', (s) => s.put(key, KEY_ID));
/** 저장된 열쇠를 지운다. → 다 지워졌으면(트랜잭션이 끝났으면) true, 지우지 못했으면 false */
const forgetStoredKey = () => dbRun('readwrite', (s) => s.delete(KEY_ID)).then(() => true, () => false);

/* ---------------- 화면 ---------------- */

function setMsg(el, text, tone = '') {
  el.textContent = text || '';
  if (tone) el.dataset.tone = tone; else delete el.dataset.tone;
}

const clock = (ms) => new Date(ms).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

function leftText(ms) {
  const sec = Math.max(0, Math.ceil(ms / 1000));
  return sec >= 60 ? `${Math.floor(sec / 60)}분 ${String(sec % 60).padStart(2, '0')}초 남음` : `${sec}초 남음`;
}

async function boot() {
  const el = {
    conn: $('np-conn'), viewers: $('np-viewers'),
    keyNeed: $('np-key-need'), keyHave: $('np-key-have'), keyFile: $('np-key-file'), keyText: $('np-key-text'),
    keyRemember: $('np-key-remember'), keySave: $('np-key-save'), keyForget: $('np-key-forget'), keyMsg: $('np-key-msg'),
    form: $('np-form'), text: $('np-text'), count: $('np-count'), ttl: $('np-ttl'), send: $('np-send'), sendMsg: $('np-send-msg'),
    preview: $('np-preview'), previewText: $('np-preview-text'),
    liveCard: $('np-live-card'), liveText: $('np-live-text'), liveLeft: $('np-live-left'), retract: $('np-retract'),
    log: $('np-log'), logEmpty: $('np-log-empty')
  };
  const cfg = globalThis.SKALA_CONFIG || {};
  const relay = cfg.relay && typeof cfg.relay.url === 'string' ? cfg.relay.url.trim() : '';
  const publicText = cfg.notice && typeof cfg.notice.key === 'string' ? cfg.notice.key.trim() : '';
  const state = { connected: false, viewers: null, hasKey: false, sending: false, current: null, sent: 0, fatal: '' };
  let privateKey = null, publicKey = null, sender = null;

  function fatal(text) {
    state.fatal = text;
    el.conn.textContent = '공지를 보낼 수 없음';
    el.conn.dataset.tone = 'bad';
    setMsg(el.sendMsg, text, 'bad');
    refresh();
  }

  function refresh() {
    el.keyNeed.hidden = state.hasKey;
    el.keyHave.hidden = !state.hasKey;
    const body = cleanNoticeText(el.text.value);
    el.count.textContent = `${body.length} / ${NOTICE.MAX_TEXT}`;
    el.previewText.textContent = body || '게임 화면 맨 위에 이렇게 뜹니다';
    el.preview.classList.toggle('is-empty', !body);
    el.send.disabled = !!state.fatal || !state.hasKey || !state.connected || state.sending || !body;
    el.retract.disabled = state.sending || !state.connected;
    el.liveCard.hidden = !state.current;
    if (state.current) {
      el.liveText.textContent = state.current.text;
      el.liveLeft.textContent = leftText(state.current.until - Date.now());
    }
    el.viewers.textContent = state.viewers == null ? '접속 – 명' : `접속 ${state.viewers}명`;
  }

  function addLog(text, note) {
    const li = document.createElement('li');
    const time = document.createElement('time');
    time.textContent = clock(Date.now());
    const span = document.createElement('span');
    span.textContent = text;
    const em = document.createElement('em');
    em.textContent = note;
    li.append(time, span, em);
    el.log.prepend(li);
    el.logEmpty.hidden = true;
  }

  /* ----- 열쇠 ----- */

  async function useKeyText(raw) {
    const text = findNoticePrivateKey(raw);
    if (!text) { setMsg(el.keyMsg, '비밀 열쇠를 찾지 못했어요. 열쇠 파일을 고르거나 비밀 열쇠 한 줄을 붙여 넣으세요.', 'bad'); return false; }
    let key;
    try { key = await importNoticePrivateKey(text); } catch (err) { setMsg(el.keyMsg, `${err.message}.`, 'bad'); return false; }
    if (!(await noticeKeysMatch(key, publicKey))) {
      setMsg(el.keyMsg, '이 열쇠는 지금 게임에 등록된 공개 열쇠의 짝이 아니에요. 가장 최근에 만든 열쇠 파일인지 확인하세요.', 'bad');
      return false;
    }
    privateKey = key;
    el.keyText.value = '';
    el.keyFile.value = '';
    if (el.keyRemember.checked) {
      try { await storeKey(key); setMsg(el.keyMsg, '열쇠를 확인했고 이 브라우저에 기억해 두었어요.', 'ok'); }
      catch (_) { setMsg(el.keyMsg, '열쇠를 확인했어요. 이 브라우저에는 저장하지 못해 창을 닫으면 다시 넣어야 해요.', 'ok'); }
    } else {
      setMsg(el.keyMsg, '열쇠를 확인했어요. 창을 닫으면 다시 넣어야 해요.', 'ok');
    }
    state.hasKey = true;      // 저장까지 끝난 뒤에 켠다(화면의 안내와 상태가 같이 바뀐다)
    refresh();
    return true;
  }

  el.keySave.addEventListener('click', () => { useKeyText(el.keyText.value); });
  el.keyFile.addEventListener('change', async () => {
    const file = el.keyFile.files && el.keyFile.files[0];
    if (!file) return;
    if (file.size > 65536) { setMsg(el.keyMsg, '열쇠 파일이 아니에요(너무 큽니다).', 'bad'); return; }
    await useKeyText(await file.text());
  });
  el.keyForget.addEventListener('click', async () => {
    // 저장된 열쇠를 다 지운 뒤에 '지웠다'고 한다. 지우는 중에 창을 닫거나 새로 고치면 지우기가 취소돼 열쇠가 남기 때문이다
    el.keyForget.disabled = true;
    privateKey = null;
    const gone = await forgetStoredKey();
    el.keyForget.disabled = false;
    state.hasKey = false;
    if (gone) setMsg(el.keyMsg, '이 브라우저에서 열쇠를 지웠어요.', '');
    else setMsg(el.keyMsg, '이 창에서는 열쇠를 뺐지만 브라우저에 저장된 열쇠는 지우지 못했어요. 브라우저 설정에서 이 사이트의 데이터를 지워 주세요.', 'bad');
    refresh();
  });

  /* ----- 쓰기 · 보내기 · 내리기 ----- */

  el.text.addEventListener('input', refresh);
  el.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = cleanNoticeText(el.text.value);
    if (!body || !sender || el.send.disabled) return;
    state.sending = true;
    setMsg(el.sendMsg, '보내는 중…', 'wait');
    refresh();
    try {
      const res = await sender.send({ text: body, ttl: Number(el.ttl.value) || NOTICE.DEFAULT_TTL });
      if (res.ok) {
        state.sent++;
        const n = state.viewers == null ? '' : `접속 ${state.viewers}명에게 `;
        setMsg(el.sendMsg, `${n}보냈어요.`, 'ok');
        addLog(body, res.notice.ttl >= 60 && res.notice.ttl % 60 === 0 ? `${res.notice.ttl / 60}분` : `${res.notice.ttl}초`);
        el.text.value = '';
      } else {
        setMsg(el.sendMsg, `보내지 못했어요: ${STATUS_TEXT[res.status] || res.status}.`, 'bad');
      }
    } catch (err) {
      setMsg(el.sendMsg, `보내지 못했어요: ${(err && err.message) || err}.`, 'bad');
    }
    state.sending = false;
    refresh();
    el.text.focus();
  });
  el.retract.addEventListener('click', async () => {
    if (!sender || !state.current) return;
    const text = state.current.text;
    state.sending = true;
    refresh();
    try {
      const res = await sender.retract();
      if (res.ok) { setMsg(el.sendMsg, '공지를 내렸어요.', 'ok'); addLog(text, '내림'); }
      else setMsg(el.sendMsg, `내리지 못했어요: ${STATUS_TEXT[res.status] || res.status}.`, 'bad');
    } catch (err) {
      setMsg(el.sendMsg, `내리지 못했어요: ${(err && err.message) || err}.`, 'bad');
    }
    state.sending = false;
    refresh();
  });

  /* ----- 시작 ----- */

  refresh();
  if (new URLSearchParams(location.search).get('debug') === '1') {
    window.__noticePanel = { state: () => ({ ...state, current: state.current ? { ...state.current } : null }) };
  }
  if (!noticeCryptoAvailable()) { fatal('이 브라우저(또는 주소)에서는 서명을 쓸 수 없어요. https 주소로 열어 주세요.'); return; }
  if (cfg.transport !== 'relay' || !relay) { fatal('게임이 중계 서버를 쓰지 않도록 설정돼 있어요(js/config.js의 transport·relay.url). 공지는 중계 서버로만 보냅니다.'); return; }
  if (!publicText) { fatal('공지 공개 열쇠가 설정돼 있지 않아요(js/config.js의 notice.key).'); return; }
  try { publicKey = await importNoticePublicKey(publicText); } catch (err) { fatal(`${err.message}(js/config.js의 notice.key).`); return; }

  const stored = await loadStoredKey();
  if (stored) {
    if (await noticeKeysMatch(stored, publicKey)) {
      privateKey = stored;
      state.hasKey = true;
      setMsg(el.keyMsg, '이 브라우저에 기억해 둔 열쇠를 불러왔어요.', 'ok');
    } else {
      await forgetStoredKey();
      setMsg(el.keyMsg, '기억해 둔 열쇠가 지금 공개 열쇠와 맞지 않아 지웠어요. 새 열쇠 파일을 넣어 주세요.', 'bad');
    }
  }

  sender = createNoticeSender({ url: relay, privateKey: () => privateKey });
  sender.on('state', ({ connected }) => {
    state.connected = !!connected;
    el.conn.textContent = connected ? '중계 서버 연결됨' : '중계 서버에 다시 연결하는 중…';
    el.conn.dataset.tone = connected ? 'ok' : 'wait';
    if (!connected) state.viewers = null;
    refresh();
  });
  sender.on('viewers', (n) => { state.viewers = n; refresh(); });
  sender.on('notice', (n) => { state.current = n; refresh(); });
  setInterval(() => { if (state.current) refresh(); }, 500);
  window.addEventListener('pagehide', () => sender.close());
  // 뒤로 가기로 되살아난 창은 연결이 닫힌 채다. 새로 불러와 다시 붙는다
  window.addEventListener('pageshow', (e) => { if (e.persisted) location.reload(); });
  sender.open().catch(() => {
    if (!state.connected) { el.conn.textContent = '중계 서버에 연결하지 못함 · 다시 시도하는 중…'; el.conn.dataset.tone = 'bad'; }
  });
  refresh();
}

boot().catch((err) => {
  console.error('[notice-panel]', err);
  const msg = document.getElementById('np-send-msg');
  if (msg) { msg.textContent = `패널을 시작하지 못했어요: ${(err && err.message) || err}`; msg.dataset.tone = 'bad'; }
});
