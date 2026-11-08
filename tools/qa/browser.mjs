/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 자동 플레이 테스트용 헤드리스 브라우저 제어(의존성 없음). Edge나 Chrome을 소프트웨어 렌더링으로 띄우고
 *          Node의 전역 WebSocket으로 CDP에 붙어 페이지 열기, 평가, 입력, 스크린샷, 오류 수집을 한다. 모든 대기에는 시간 제한이 있다.
 */
/*
 * 사용법
 *   const browser = await launchBrowser();
 *   const page = await browser.newPage();
 *   await page.open('http://127.0.0.1:1234/skala-fps/', { width: 960, height: 540, clean: true, initScript: '...' });
 *   await page.eval('document.title');
 *   await page.waitFor('window.__skalafps && __skalafps.screen === "menu"', 20000);
 *   await page.click('.sk-menu-btn--main');  await page.type('닉네임');
 *   await page.key('KeyW', 'down');  await page.key('KeyW', 'up');  await page.press('KeyR');
 *   await page.mouseMove(100, 100);  await page.mouseDown(0);  await page.mouseUp(0);  await page.mouseClick(100, 100);
 *   await page.screenshot('out.png');
 *   page.console  page.errors   // errors = { type:'exception'|'console.error'|'log.error'|'http'|'net'|'dialog', text, ... }
 *   await page.close();  await browser.close();
 *
 * 안전 규칙: 이 PC는 GPU 부하에서 멈춘 적이 있다. 그래서 GPU를 쓰지 않는 플래그를 고정하고, 화면 크기를 960x540으로 자르고,
 * 브라우저는 한 번에 하나만 띄운다. 브라우저는 이 프로세스가 어떻게 끝나든(시간 초과, 강제 종료 포함) 감시 프로세스가 함께 없앤다.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** 고정 플래그. 소프트웨어 렌더링 외의 경로로 빠지지 않게 호출하는 쪽에서 바꿀 수 없다 */
export const SAFE_FLAGS = Object.freeze([
  '--headless=new', '--disable-gpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'
]);
const QUIET_FLAGS = Object.freeze([
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync', '--disable-background-networking',
  '--disable-component-update', '--disable-default-apps', '--disable-breakpad', '--disable-crash-reporter', '--no-pings',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
  '--disable-features=Translate,msEdgeSidebarV2,msEdgeShopping,msEdgeCollections,msImplicitSignin',
  '--hide-scrollbars', '--force-color-profile=srgb',
  // 소리는 --mute-audio로 꺼져 있다. 사용자 입력 없이 도는 dev/fx-demo.html?smoke=1이 AudioContext를 기다리다 멈추지 않게 한다
  '--autoplay-policy=no-user-gesture-required'
]);
export const MAX_WIDTH = 960, MAX_HEIGHT = 540;
const COMMAND_TIMEOUT_MS = 30000;
const LAUNCH_TIMEOUT_MS = 30000;
const WATCHDOG_MAX_MS = 90 * 60 * 1000;   // 어떤 경우에도 90분이 넘으면 브라우저를 없앤다

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/** 이 시간 안에 끝나지 않으면 label을 적은 오류로 거절한다 */
export function withTimeout(promise, ms, label) {
  let timer;
  const guard = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`시간 초과(${ms} ms): ${label}`)), ms); });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

/** QA_BROWSER → Windows → macOS → Linux 순서로 찾는다. 없으면 null */
export function findBrowser(env = process.env) {
  if (env.QA_BROWSER) return existsSync(env.QA_BROWSER) ? env.QA_BROWSER : null;
  const list = [];
  if (process.platform === 'win32') {
    const roots = [env['ProgramFiles(x86)'], env.ProgramFiles, env.LOCALAPPDATA, 'C:\\Program Files (x86)', 'C:\\Program Files'].filter(Boolean);
    for (const r of roots) list.push(join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    for (const r of roots) list.push(join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  } else if (process.platform === 'darwin') {
    list.push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium');
  } else {
    list.push('/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium');
  }
  return list.find((p) => existsSync(p)) || null;
}

function killTreeSync(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', timeout: 10000, windowsHide: true });
    else { try { process.kill(-pid, 'SIGKILL'); } catch (err) { process.kill(pid, 'SIGKILL'); } }
  } catch (err) { /* 이미 끝났다 */ }
}

/** 이 Node 프로세스가 사라지면 브라우저를 없애고 임시 폴더를 지우는 감시 프로세스. 브라우저가 끝나면 함께 끝난다 */
function startWatchdog(browserPid, dataDir) {
  const code = `
    const { spawnSync } = require('node:child_process');
    const { rmSync } = require('node:fs');
    const parent = ${process.pid}, browser = ${browserPid}, dir = ${JSON.stringify(dataDir)}, limit = Date.now() + ${WATCHDOG_MAX_MS};
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return false; } };
    setInterval(() => {
      if (!alive(browser)) { try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch (e) {} process.exit(0); }
      if (!alive(parent) || Date.now() > limit) {
        if (process.platform === 'win32') spawnSync('taskkill', ['/T', '/F', '/PID', String(browser)], { stdio: 'ignore', windowsHide: true });
        else { try { process.kill(-browser, 'SIGKILL'); } catch (e) { try { process.kill(browser, 'SIGKILL'); } catch (e2) {} } }
      }
    }, 1000);
  `;
  const child = spawn(process.execPath, ['-e', code], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  return child;
}

/* ───────────────────────────── CDP 연결 ───────────────────────────── */

class CdpConnection {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();   // sessionId → (method, params) => void
    this.closed = false;
    ws.addEventListener('message', (e) => this.onMessage(e));
    ws.addEventListener('close', () => this.onClose());
    ws.addEventListener('error', () => {});
  }

  onMessage(e) {
    const msg = JSON.parse(typeof e.data === 'string' ? e.data : Buffer.from(e.data).toString('utf8'));
    if (msg.id) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}${msg.error.data ? ' ' + msg.error.data : ''}`));
      else p.resolve(msg.result);
      return;
    }
    const fn = this.handlers.get(msg.sessionId || '');
    if (fn) { try { fn(msg.method, msg.params || {}); } catch (err) { console.error('[qa] CDP 이벤트 처리 오류', err); } }
  }

  onClose() {
    this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(`${p.method}: 브라우저 연결이 끊겼어요`)); }
    this.pending.clear();
  }

  send(method, params = {}, sessionId = undefined, timeoutMs = COMMAND_TIMEOUT_MS) {
    if (this.closed) return Promise.reject(new Error(`${method}: 브라우저 연결이 끊겼어요`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: 응답 시간 초과(${timeoutMs} ms)`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      const msg = { id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      this.ws.send(JSON.stringify(msg));
    });
  }
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const fail = () => reject(new Error(`CDP에 연결하지 못했어요: ${url}`));
    ws.addEventListener('open', () => { ws.removeEventListener('error', fail); resolve(new CdpConnection(ws)); }, { once: true });
    ws.addEventListener('error', fail, { once: true });
  });
}

/* ───────────────────────────── 키 표 ───────────────────────────── */

const SPECIAL_KEYS = {
  Space: [' ', 32], Enter: ['Enter', 13], Escape: ['Escape', 27], Tab: ['Tab', 9], Backspace: ['Backspace', 8],
  ShiftLeft: ['Shift', 16], ShiftRight: ['Shift', 16], ControlLeft: ['Control', 17], ControlRight: ['Control', 17], AltLeft: ['Alt', 18],
  ArrowUp: ['ArrowUp', 38], ArrowDown: ['ArrowDown', 40], ArrowLeft: ['ArrowLeft', 37], ArrowRight: ['ArrowRight', 39]
};
for (let i = 1; i <= 12; i++) SPECIAL_KEYS[`F${i}`] = [`F${i}`, 111 + i];

/** e.code → { key, keyCode } */
export function keyInfo(code) {
  if (SPECIAL_KEYS[code]) return { key: SPECIAL_KEYS[code][0], keyCode: SPECIAL_KEYS[code][1] };
  let m = /^Key([A-Z])$/.exec(code);
  if (m) return { key: m[1].toLowerCase(), keyCode: m[1].charCodeAt(0) };
  m = /^Digit([0-9])$/.exec(code);
  if (m) return { key: m[1], keyCode: 48 + +m[1] };
  throw new Error(`키 표에 없는 코드예요: ${code}`);
}

const BUTTONS = ['left', 'middle', 'right'];
const BUTTON_MASK = [1, 4, 2];

/* ───────────────────────────── 페이지 ───────────────────────────── */

export class Page {
  constructor(cdp, targetId, sessionId) {
    this.cdp = cdp;
    this.targetId = targetId;
    this.sessionId = sessionId;
    /** { type, text, url?, line?, at } 모든 콘솔 출력 */
    this.console = [];
    /** { type:'exception'|'console.error'|'log.error'|'http'|'net'|'dialog', text, url?, status?, at } */
    this.errors = [];
    /** 끝까지 받은 요청 { url, status } */
    this.requests = [];
    this.width = MAX_WIDTH;
    this.height = MAX_HEIGHT;
    this.mouse = { x: 0, y: 0, buttons: 0 };
    this.loadWaiters = [];
    this.requestUrls = new Map();
    this.initScriptIds = [];
    this.closed = false;
    this.crashed = false;
    cdp.handlers.set(sessionId, (method, params) => this.onEvent(method, params));
  }

  send(method, params = {}, timeoutMs = COMMAND_TIMEOUT_MS) {
    return this.cdp.send(method, params, this.sessionId, timeoutMs);
  }

  async setup() {
    await Promise.all([
      this.send('Page.enable'), this.send('Runtime.enable'), this.send('Log.enable'), this.send('Network.enable'), this.send('Inspector.enable')
    ]);
    await this.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  }

  onEvent(method, p) {
    const at = Date.now();
    switch (method) {
      case 'Runtime.consoleAPICalled': {
        const text = (p.args || []).map(remoteValueText).join(' ');
        const frame = p.stackTrace && p.stackTrace.callFrames && p.stackTrace.callFrames[0];
        const entry = { type: p.type, text, url: frame && frame.url, line: frame && frame.lineNumber + 1, at };
        this.console.push(entry);
        if (p.type === 'error' || p.type === 'assert') this.errors.push({ ...entry, type: 'console.error' });
        break;
      }
      case 'Runtime.exceptionThrown': {
        const d = p.exceptionDetails || {};
        const text = d.exception ? (d.exception.description || remoteValueText(d.exception)) : d.text;
        this.errors.push({ type: 'exception', text: String(text), url: d.url, line: d.lineNumber + 1, at });
        break;
      }
      case 'Log.entryAdded': {
        const e = p.entry || {};
        this.console.push({ type: `log.${e.level}`, text: e.text, url: e.url, at });
        // 네트워크 실패는 http·net 항목이 더 자세하다.
        // 입력 없이 게임 화면을 떠날 때 브라우저가 나가기 확인을 막았다고 남기는 줄은 시험 환경에서만 나고 해롭지 않다
        if (e.level === 'error' && e.source !== 'network' && !/confirmation panel for a frame that never had a user gesture/.test(e.text)) {
          this.errors.push({ type: 'log.error', text: e.text, url: e.url, at });
        }
        break;
      }
      case 'Network.requestWillBeSent':
        this.requestUrls.set(p.requestId, p.request.url);
        break;
      case 'Network.responseReceived': {
        const { url, status } = p.response;
        if (url.startsWith('data:')) break;
        this.requests.push({ url, status });
        if (status >= 400) this.errors.push({ type: 'http', status, text: `${status} ${url}`, url, at });
        break;
      }
      case 'Network.loadingFailed': {
        if (p.canceled) break;
        const url = this.requestUrls.get(p.requestId) || '';
        this.errors.push({ type: 'net', text: `${p.errorText} ${url}`, url, at });
        break;
      }
      case 'Inspector.targetCrashed':
        this.crashed = true;
        this.errors.push({ type: 'exception', text: '페이지 프로세스가 죽었어요(targetCrashed)', at });
        break;
      case 'Page.loadEventFired': {
        const w = this.loadWaiters;
        this.loadWaiters = [];
        for (const res of w) res();
        break;
      }
      case 'Page.javascriptDialogOpening': {
        // 나가기 확인(beforeunload)은 게임 화면의 정상 동작이다. alert·confirm·prompt는 DESIGN 1절이 금지한다
        if (p.type !== 'beforeunload') this.errors.push({ type: 'dialog', text: `${p.type}: ${p.message}`, at });
        this.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
        break;
      }
      default:
        break;
    }
  }

  /** 지금까지 모은 오류를 비운다(시나리오 중간에 일부러 낸 오류를 걸러 낼 때) */
  clearErrors() { this.errors.length = 0; }

  /** initScript를 등록하고 url을 연다. clean이면 그 출처의 저장소를 먼저 지운다 */
  async open(url, { width = MAX_WIDTH, height = MAX_HEIGHT, initScript = null, clean = false, timeoutMs = 60000, mobile = false } = {}) {
    this.width = Math.min(width, MAX_WIDTH);
    this.height = Math.min(height, MAX_HEIGHT);
    await this.send('Emulation.setDeviceMetricsOverride', { width: this.width, height: this.height, deviceScaleFactor: 1, mobile });
    if (mobile) await this.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    for (const id of this.initScriptIds) await this.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: id });
    this.initScriptIds = [];
    if (initScript) {
      const r = await this.send('Page.addScriptToEvaluateOnNewDocument', { source: initScript });
      this.initScriptIds.push(r.identifier);
    }
    if (clean) await this.clearStorage(new URL(url).origin);
    await this.navigate(url, timeoutMs);
  }

  async clearStorage(origin) {
    await this.send('Storage.clearDataForOrigin', { origin, storageTypes: 'local_storage,indexeddb,websql,service_workers,cache_storage' });
  }

  /** 이 패턴(별표 가능)의 요청을 막는다. 빈 배열이면 푼다. 다음 navigate부터 적용하려면 open 전에 부른다 */
  async blockUrls(patterns) {
    await this.send('Network.setBlockedURLs', { urls: patterns });
  }

  async navigate(url, timeoutMs = 60000) {
    const loaded = new Promise((res) => this.loadWaiters.push(res));
    const r = await this.send('Page.navigate', { url });
    if (r.errorText) throw new Error(`열지 못했어요: ${url}: ${r.errorText}`);
    await withTimeout(loaded, timeoutMs, `페이지 불러오기 ${url}`);
  }

  async reload(timeoutMs = 60000) {
    const loaded = new Promise((res) => this.loadWaiters.push(res));
    await this.send('Page.reload', { ignoreCache: false });
    await withTimeout(loaded, timeoutMs, '페이지 다시 불러오기');
  }

  /** 식을 페이지에서 평가한다. Promise면 기다린다. 값은 JSON으로 돌아온다 */
  async eval(expr, { timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, timeoutMs);
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(`eval 실패: ${d.exception ? d.exception.description || remoteValueText(d.exception) : d.text}\n  식: ${String(expr).slice(0, 400)}`);
    }
    return r.result.value;
  }

  /** 지금 페이지 메인 스레드의 자바스크립트 호출 스택(글자). 멈춘 페이지를 진단할 때 쓴다 */
  async stack(timeoutMs = 8000) {
    const prev = this.cdp.handlers.get(this.sessionId);
    let onPaused = null;
    const paused = new Promise((res) => { onPaused = res; });
    this.cdp.handlers.set(this.sessionId, (m, p) => { if (prev) prev(m, p); if (m === 'Debugger.paused') onPaused(p); });
    try {
      await this.send('Debugger.enable', {}, timeoutMs);
      await this.send('Debugger.pause', {}, timeoutMs);
      const p = await withTimeout(paused, timeoutMs, 'Debugger.paused');
      return p.callFrames.slice(0, 16).map((f) => `    ${f.functionName || '(익명)'} ${f.url.split('/').slice(-2).join('/')}:${f.location.lineNumber + 1}`).join('\n');
    } catch (err) {
      return `    스택을 읽지 못했어요: ${err.message}`;
    } finally {
      if (prev) this.cdp.handlers.set(this.sessionId, prev);
      await this.send('Debugger.resume', {}, 2000).catch(() => {});
      await this.send('Debugger.disable', {}, 2000).catch(() => {});
    }
  }

  /** 함수를 페이지에서 부른다. 함수는 글자로 옮겨지므로 바깥 변수를 쓸 수 없고, 값은 arg(JSON)로 넘긴다 */
  fn(fn, arg, options) {
    return this.eval(`(${fn.toString()})(${JSON.stringify(arg === undefined ? null : arg)})`, options);
  }

  /** 식이 참이 될 때까지 기다린다. 그 값을 돌려준다. 시간이 지나면 오류 */
  async waitFor(expr, timeoutMs = 15000, { intervalMs = 100, label = null } = {}) {
    const end = Date.now() + timeoutMs;
    let lastErr = null;
    // 객체는 JSON으로 옮기지 않고 참으로 친다. 맵이나 ctx를 그대로 옮기면 페이지가 멈춘다
    const safe = `(async () => { const v = await (${expr}); return v && typeof v === 'object' ? true : v; })()`;
    for (;;) {
      if (this.crashed) throw new Error(`페이지가 죽었어요: ${label || expr}`);
      try {
        const v = await this.eval(safe, { timeoutMs: Math.max(1000, Math.min(COMMAND_TIMEOUT_MS, end - Date.now() + 1000)) });
        if (v) return v;
        lastErr = null;
      } catch (err) { lastErr = err; }   // 페이지가 바뀌는 중이면 다시 시도한다
      if (Date.now() >= end) {
        // 페이지가 응답하지 않아 시간이 다 됐다면 무엇을 하다 멈췄는지 적어 준다
        const stuck = lastErr && lastErr.message.includes('응답 시간 초과') ? `\n  멈춘 곳:\n${await this.stack()}` : '';
        throw new Error(`시간 초과(${timeoutMs} ms): ${label || expr}${lastErr ? `\n  마지막 오류: ${lastErr.message}` : ''}${stuck}`);
      }
      await sleep(intervalMs);
    }
  }

  async screenshot(path) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' }, 60000);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from(r.data, 'base64'));
    return path;
  }

  /** 요소의 가운데 좌표(뷰포트 기준). 보이지 않으면 null */
  async elementCenter(selector) {
    return this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return null;
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
  }

  /** 선택자의 요소를 진짜 마우스 입력으로 누른다. 없거나 보이지 않으면 시간 제한 안에서 기다린 뒤 오류 */
  async click(selector, { timeoutMs = 10000, button = 0 } = {}) {
    const end = Date.now() + timeoutMs;
    let c = await this.elementCenter(selector);
    while (!c) {
      if (Date.now() >= end) throw new Error(`누를 요소가 보이지 않아요: ${selector}`);
      await sleep(100);
      c = await this.elementCenter(selector);
    }
    await this.mouseClick(c.x, c.y, button);
    return c;
  }

  /** 선택자에 맞는 요소 중 글자가 들어 있는(정규식 또는 포함) 보이는 요소를 진짜 마우스 입력으로 누른다 */
  async clickText(selector, text, { timeoutMs = 10000, button = 0 } = {}) {
    const pattern = text instanceof RegExp ? { source: text.source, flags: text.flags } : null;
    const find = () => this.fn(({ selector: sel, text: plainText, pattern: re }) => {
      const test = re ? ((s) => new RegExp(re.source, re.flags).test(s)) : ((s) => s.includes(plainText));
      for (const el of document.querySelectorAll(sel)) {
        if (!test(el.textContent || '')) continue;
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
      return null;
    }, { selector, text: pattern ? null : String(text), pattern });
    const end = Date.now() + timeoutMs;
    let c = await find();
    while (!c) {
      if (Date.now() >= end) throw new Error(`누를 요소가 보이지 않아요: ${selector} "${text}"`);
      await sleep(100);
      c = await find();
    }
    await this.mouseClick(c.x, c.y, button);
    return c;
  }

  /** 글자를 지금 포커스된 칸에 넣는다(한글 포함). input 이벤트가 난다 */
  async type(text) {
    await this.send('Input.insertText', { text });
  }

  /** code = KeyboardEvent.code. direction = 'down' | 'up' */
  async key(code, direction = 'down', { text } = {}) {
    const { key, keyCode } = keyInfo(code);
    const down = direction !== 'up';
    const p = {
      type: down ? (text ? 'keyDown' : 'rawKeyDown') : 'keyUp',
      code, key, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, autoRepeat: false, isKeypad: false
    };
    if (text && down) { p.text = text; p.unmodifiedText = text; }
    await this.send('Input.dispatchKeyEvent', p);
  }

  /** 눌렀다 뗀다. holdMs 동안 누르고 있는다 */
  /**
   * 터치 이벤트. type = 'touchStart' | 'touchMove' | 'touchEnd'. points = 지금 닿아 있는 손가락 전부 [{ id, x, y }]. touchEnd는 모두 뗀다.
   * open(url, { mobile: true })로 연 페이지에서 쓴다.
   */
  async touch(type, points = []) {
    await this.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((p) => ({ id: p.id || 0, x: p.x, y: p.y })) });
  }

  async press(code, { holdMs = 0, text } = {}) {
    await this.key(code, 'down', { text });
    if (holdMs > 0) await sleep(holdMs);
    await this.key(code, 'up');
  }

  async mouseMove(x, y) {
    this.mouse.x = x; this.mouse.y = y;
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: this.mouse.buttons, button: 'none' });
  }

  async mouseDown(button = 0, x = this.mouse.x, y = this.mouse.y) {
    this.mouse.x = x; this.mouse.y = y;
    this.mouse.buttons |= BUTTON_MASK[button];
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: BUTTONS[button], buttons: this.mouse.buttons, clickCount: 1 });
  }

  async mouseUp(button = 0, x = this.mouse.x, y = this.mouse.y) {
    this.mouse.x = x; this.mouse.y = y;
    this.mouse.buttons &= ~BUTTON_MASK[button];
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: BUTTONS[button], buttons: this.mouse.buttons, clickCount: 1 });
  }

  async mouseClick(x, y, button = 0) {
    await this.mouseMove(x, y);
    await this.mouseDown(button, x, y);
    await this.mouseUp(button, x, y);
  }

  async wheel(deltaY, x = this.mouse.x, y = this.mouse.y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY });
  }

  /** 이 페이지를 앞으로 가져온다. 포인터 잠금과 키 입력은 앞에 있는 페이지가 받는다 */
  async bringToFront() {
    await this.send('Page.bringToFront');
  }

  /** 탭을 닫는다. 나가기 확인 대화상자가 떠도 기다리지 않는다 */
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.cdp.handlers.delete(this.sessionId);
    await this.cdp.send('Target.closeTarget', { targetId: this.targetId }, undefined, 5000).catch(() => {});
    if (this.browserContextId) await this.cdp.send('Target.disposeBrowserContext', { browserContextId: this.browserContextId }, undefined, 5000).catch(() => {});
  }
}

function remoteValueText(v) {
  if (!v) return '';
  if (v.type === 'string') return v.value;
  if (v.value !== undefined) return String(v.value);
  if (v.description) return v.description;
  if (v.unserializableValue) return v.unserializableValue;
  return v.type || '';
}

/* ───────────────────────────── 브라우저 ───────────────────────────── */

let liveBrowser = null;

/**
 * 헤드리스 브라우저를 띄운다. 이미 하나 떠 있으면 거절한다(한 번에 하나).
 * @returns {Promise<{newPage:()=>Promise<Page>, close:()=>Promise<void>, pid:number, path:string, version:string}>}
 */
export async function launchBrowser({ extraFlags = [] } = {}) {
  if (liveBrowser) throw new Error('브라우저는 한 번에 하나만 띄웁니다');
  if (typeof WebSocket === 'undefined') throw new Error('Node에 전역 WebSocket이 없어요. Node 22 이상에서 돌려 주세요.');
  const path = findBrowser();
  if (!path) throw new Error('Edge나 Chrome을 찾지 못했어요. QA_BROWSER 환경 변수로 실행 파일 경로를 알려 주세요.');
  const dataDir = mkdtempSync(join(tmpdir(), 'skala-qa-profile-'));
  const args = [...SAFE_FLAGS, ...QUIET_FLAGS, '--remote-debugging-port=0', `--user-data-dir=${dataDir}`, `--window-size=${MAX_WIDTH},${MAX_HEIGHT}`, ...extraFlags, 'about:blank'];
  // 부모가 Windows 호환성 계층(__COMPAT_LAYER)을 물려주면 Edge는 그 계층을 떼려고 자기를 다시 띄우고 처음 프로세스는 바로 끝난다.
  // 그러면 시작하자마자 끝난 것으로 보이고 진짜 브라우저는 고아로 남는다. 환경에서 빼고 띄운다
  const env = { ...process.env };
  delete env.__COMPAT_LAYER;
  const child = spawn(path, args, { stdio: 'ignore', detached: process.platform !== 'win32', windowsHide: true, env });
  let exited = false;
  child.on('exit', () => { exited = true; });
  child.on('error', () => { exited = true; });
  startWatchdog(child.pid, dataDir);

  let closing = null;
  const killNow = () => { killTreeSync(child.pid); };
  const onExit = () => killNow();
  process.on('exit', onExit);

  async function close() {
    if (closing) return closing;
    closing = (async () => {
      process.removeListener('exit', onExit);
      liveBrowser = null;
      if (cdp && !cdp.closed) await cdp.send('Browser.close', {}, undefined, 4000).catch(() => {});
      for (let i = 0; i < 20 && !exited; i++) await sleep(100);
      // 헤드리스 Edge는 끝날 때 비정상 종료 코드를 남기기도 한다. 해롭지 않으니 코드는 보지 않는다
      killNow();
      for (let i = 0; i < 10; i++) {
        try { rmSync(dataDir, { recursive: true, force: true }); break; } catch (err) { await sleep(300); }
      }
    })();
    return closing;
  }

  let cdp = null;
  try {
    const activePort = join(dataDir, 'DevToolsActivePort');
    const end = Date.now() + LAUNCH_TIMEOUT_MS;
    let wsUrl = null;
    while (!wsUrl) {
      if (exited) throw new Error('브라우저가 시작하자마자 끝났어요');
      if (Date.now() > end) throw new Error('브라우저 시작 시간 초과');
      if (existsSync(activePort)) {
        let lines = [];
        try { lines = readFileSync(activePort, 'utf8').split(/\r?\n/); } catch (err) { /* 윈도우에서 브라우저가 쓰는 중이면 EBUSY다. 다음 차례에 다시 읽는다 */ }
        if (lines[0] && lines[1]) wsUrl = `ws://127.0.0.1:${lines[0]}${lines[1]}`;
      }
      if (!wsUrl) await sleep(100);
    }
    cdp = await connect(wsUrl);
    const version = await cdp.send('Browser.getVersion');
    const api = {
      path,
      pid: child.pid,
      version: version.product,
      /** 브라우저가 아직 살아 있는가. 죽었으면 close() 뒤 새로 띄운다 */
      get alive() { return !exited && !cdp.closed; },
      /** isolated면 저장소와 캐시가 따로인 새 컨텍스트에 연다. 두 사람을 흉내 낼 때 쓴다 */
      async newPage({ isolated = false } = {}) {
        const params = { url: 'about:blank', newWindow: isolated };
        if (isolated) params.browserContextId = (await cdp.send('Target.createBrowserContext', { disposeOnDetach: true })).browserContextId;
        const { targetId } = await cdp.send('Target.createTarget', params);
        const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
        const page = new Page(cdp, targetId, sessionId);
        page.browserContextId = params.browserContextId || null;
        await page.setup();
        return page;
      },
      close
    };
    liveBrowser = api;
    return api;
  } catch (err) {
    await close();
    throw err;
  }
}
