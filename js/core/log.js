/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 공용 로거. 이름표(ns)를 붙여 콘솔에 남기고 최근 500줄을 링 버퍼에 보관한다.
 *          ?log=debug|info|warn|error 로 레벨을, ?logns=physics,net 으로 이름표를 거른다. three.js·DOM 의존 없음(node에서도 동작).
 */
/**
 *   import { createLogger, getLogs } from './core/log.js';
 *   const log = createLogger('physics');
 *   log.debug('벽 밀어내기', { pos, vel });   // ?log=debug 일 때만 나온다
 *   log.warn('스폰이 벽에 박힘', spawn);
 *   getLogs();                                // [{ t(ms), level, ns, text }] 오래된 순, 최대 500줄
 *
 * 규칙
 * - 레벨 순서는 debug < info < warn < error. 기본은 info이고 모르는 값도 info로 본다.
 * - ?logns는 쉼표로 구분한 이름표 목록이다. 'net'은 'net:room'까지 포함한다.
 *   error는 이 필터를 무시한다. 다른 모듈의 오류를 필터 때문에 놓치면 안 되기 때문이다.
 * - 걸러진 줄은 콘솔에도 버퍼에도 남지 않고 인자를 문자열로 바꾸는 비용도 들지 않는다.
 * - 버퍼에는 그 순간의 값을 문자열로 남긴다. 객체 참조를 붙잡지 않고, 나중에 값이 바뀌어도 기록은 그대로다.
 * - 로깅 때문에 게임이 멈추면 안 되므로 어떤 인자가 와도 예외를 던지지 않는다.
 */

export const LOG_LEVELS = Object.freeze(['debug', 'info', 'warn', 'error']);
export const LOG_CAPACITY = 500;

const DEFAULT_LEVEL = 'info';
const ERROR_RANK = LOG_LEVELS.indexOf('error');
const MAX_DEPTH = 3;      // 객체를 글자로 풀 때 들어가는 깊이
const MAX_ITEMS = 20;     // 객체·배열 하나에서 보여 주는 항목 수
const MAX_TEXT = 1000;    // 버퍼 한 줄의 최대 글자 수. 500줄이어도 메모리가 1MB 안팎으로 묶인다

// 크롬은 console.debug를 기본으로 숨긴다(Verbose). ?log=debug로 직접 켠 줄이 안 보이면 안 되므로 console.log로 낸다
const CONSOLE_METHOD = Object.freeze({ debug: 'log', info: 'info', warn: 'warn', error: 'error' });

let minRank = LOG_LEVELS.indexOf(DEFAULT_LEVEL);
let nsFilter = null;      // null이면 모든 이름표

const ring = new Array(LOG_CAPACITY);
let written = 0;          // 지금까지 쓴 줄 수. 다음 칸 = written % LOG_CAPACITY

/**
 * URL 쿼리 문자열로 레벨과 이름표 필터를 정한다. 페이지가 열릴 때 location.search로 한 번 부른다.
 * 테스트나 콘솔에서 다시 불러도 된다. 예: configureLog('?log=debug&logns=net')
 */
export function configureLog(search = '') {
  const query = new URLSearchParams(search);
  const rank = LOG_LEVELS.indexOf(String(query.get('log') || '').trim().toLowerCase());
  minRank = rank >= 0 ? rank : LOG_LEVELS.indexOf(DEFAULT_LEVEL);
  const names = String(query.get('logns') || '').split(',').map((s) => s.trim()).filter(Boolean);
  nsFilter = names.length ? names : null;
}

function passes(rank, ns) {
  if (rank < minRank) return false;
  if (rank === ERROR_RANK || !nsFilter) return true;
  return nsFilter.some((name) => ns === name || ns.startsWith(name + ':'));
}

function describeObject(value, depth, path) {
  if (typeof value.message === 'string' && typeof value.stack === 'string') return value.stack || `${value.name}: ${value.message}`;
  if (value instanceof Map || value instanceof Set) return `${value.constructor.name}(${value.size})`;
  if (path.includes(value)) return '[순환]';
  const isList = Array.isArray(value) || ArrayBuffer.isView(value);
  if (depth >= MAX_DEPTH) return isList ? `[${value.length}개]` : '{…}';
  const nextPath = [...path, value];
  const keys = Object.keys(value);
  const items = keys.slice(0, MAX_ITEMS).map((k) => (isList ? '' : `${k}: `) + describe(value[k], depth + 1, nextPath));
  if (keys.length > MAX_ITEMS) items.push(`… +${keys.length - MAX_ITEMS}`);
  return isList ? `[${items.join(', ')}]` : `{${items.join(', ')}}`;
}

/** 값 하나를 버퍼에 넣을 글자로 바꾼다. JSON.stringify는 쓰지 않는다: three.js 객체의 toJSON이 장면 전체를 직렬화한다 */
function describe(value, depth = 0, path = []) {
  if (typeof value === 'string') return depth ? JSON.stringify(value) : value;
  if (typeof value === 'function') return `[함수 ${value.name || '이름 없음'}]`;
  if (value === null || typeof value !== 'object') return String(value);
  return describeObject(value, depth, path);
}

function toText(args) {
  const parts = [];
  for (const arg of args) {
    try { parts.push(describe(arg)); } catch { parts.push('[출력 불가]'); }
  }
  const text = parts.join(' ');
  return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + '…' : text;
}

function nowMs() {
  const perf = globalThis.performance;
  return Math.round(perf && perf.now ? perf.now() : Date.now());
}

function write(rank, ns, args) {
  if (!passes(rank, ns)) return;
  const level = LOG_LEVELS[rank];
  ring[written % LOG_CAPACITY] = { t: nowMs(), level, ns, text: toText(args) };
  written++;
  try { console[CONSOLE_METHOD[level]](`[${ns}]`, ...args); } catch { /* 콘솔이 없어도 게임은 계속한다 */ }
}

/** 이름표 하나의 로거를 만든다 */
export function createLogger(ns = 'app') {
  const name = String(ns);
  return {
    debug: (...args) => write(0, name, args),
    info: (...args) => write(1, name, args),
    warn: (...args) => write(2, name, args),
    error: (...args) => write(ERROR_RANK, name, args)
  };
}

/** 최근 줄들을 오래된 순서로 돌려준다(새 배열). 최대 LOG_CAPACITY줄 */
export function getLogs() {
  const count = Math.min(written, LOG_CAPACITY);
  const first = written - count;
  const out = new Array(count);
  for (let i = 0; i < count; i++) out[i] = ring[(first + i) % LOG_CAPACITY];
  return out;
}

/** 버퍼를 비운다 */
export function clearLogs() {
  written = 0;
  ring.fill(undefined);
}

configureLog((globalThis.location && globalThis.location.search) || '');
