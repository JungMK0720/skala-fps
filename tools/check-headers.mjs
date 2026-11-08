/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 코드 파일 맨 위의 머리말(Date·Author·Purpose)과 금지 단어를 검사한다. 실패하면 종료 코드 1(npm run check:headers).
 *          --fix-from <json>은 {경로: 설명} 목록의 파일에 머리말을 넣거나 바꾸고 나머지 내용은 건드리지 않는다.
 */
/**
 * 사용법
 *   node tools/check-headers.mjs                              저장소 전체 검사
 *   node tools/check-headers.mjs --fix-from stamp.json        목록의 파일에 머리말 넣기
 *   node tools/check-headers.mjs --fix-from stamp.json --dry-run   쓰지 않고 결과만 출력
 *   --root <폴더>                                             저장소 대신 검사할 폴더(테스트용)
 *
 * stamp.json 형식: { "js/main.js": "부트스트랩과 화면 상태 머신", "index.html": "게임 진입 페이지" }
 * 경로는 저장소 루트 기준이고, 설명에 줄바꿈이 있으면 Purpose 다음 줄에 맞춰 이어 쓴다.
 *
 * 머리말 형식은 docs/DESIGN.md 1절. HTML은 <!DOCTYPE html> 다음에 와도 되고, js·mjs는 #! 다음에 와도 된다.
 * 금지 단어 검사는 Markdown·JSON까지 모든 텍스트 파일과 파일 경로를 본다. 대상은 git이 추적하는 파일과,
 * 아직 추가하지 않았지만 무시 규칙에 걸리지 않아 git add에 딸려 갈 파일이다.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HEADER_DATE = '06NOV2026';
export const HEADER_AUTHOR = 'Minkyu Jung';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** 확장자 → 주석 형식. 여기 없는 확장자(JSON·Markdown 포함)는 머리말 검사 대상이 아니다 */
const STYLE_BY_EXT = Object.freeze({
  '.js': 'block', '.mjs': 'block', '.css': 'block', '.html': 'html', '.sql': 'sql', '.yml': 'yaml', '.yaml': 'yaml'
});
/** 설명 문자열에 들어가면 주석이 일찍 닫히는 글자 */
const UNSAFE_IN_COMMENT = Object.freeze({ block: ['*/'], html: ['-->', '--!>', '<!--'], sql: [], yaml: [] });

const rot13 = (s) => s.replace(/[a-z]/g, (c) => String.fromCharCode(((c.charCodeAt(0) - 97 + 13) % 26) + 97));
/** 저장소에 남으면 안 되는 단어(대소문자 무시). 이 파일이 자기 검사에 걸리지 않게 ROT13으로 적었다 */
export const BANNED_WORDS = Object.freeze(['pynhqr', 'naguebcvp', 'pungtcg', 'bcranv', 'tcg-', 'pbcvybg', 'pb-nhguberq-ol'].map(rot13));
const BANNED_RE = new RegExp(BANNED_WORDS.join('|'), 'gi');

const LOCAL_TOOL_DIR = `.${BANNED_WORDS[0]}`;   // git에서 제외된 개발 도구 설정 폴더
const HEADER_SKIP_DIRS = new Set(['.git', LOCAL_TOOL_DIR, 'node_modules', 'audio']);
const SCAN_SKIP_DIRS = new Set(['.git', LOCAL_TOOL_DIR, 'node_modules']);   // git을 못 쓸 때의 금지 단어 검사용
const BINARY_EXT = new Set(['.bin', '.mp3', '.wav', '.ogg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.woff', '.woff2', '.ttf', '.zip', '.pdf']);

const KEY_RE = /^(Date|Author|Purpose)\s*:\s*(.*)$/;
const indentOf = (line) => line.length - line.trimStart().length;

function styleOf(ext) {
  const style = STYLE_BY_EXT[String(ext).toLowerCase()];
  if (!style) throw new Error(`머리말을 넣지 않는 형식입니다: ${ext}`);
  return style;
}

/** 머리말보다 앞에 와도 되는 줄(<!DOCTYPE html>, #!)의 길이 */
function preludeLength(src, style) {
  const re = style === 'html' ? /^<!doctype\s+html\b[^>]*>[ \t]*(\r?\n)?/i : style === 'block' ? /^#![^\r\n]*(\r?\n)?/ : null;
  const match = re && re.exec(src);
  return match ? match[0].length : 0;
}

/** start 위치의 블록 주석을 읽는다. 없거나 닫히지 않았으면 null */
function readBlockComment(src, start, open, close, stripLine) {
  if (!src.startsWith(open, start)) return null;
  const closeAt = src.indexOf(close, start + open.length);
  if (closeAt < 0) return null;
  const tail = /[ \t]*\r?\n/y;
  tail.lastIndex = closeAt + close.length;
  const end = tail.test(src) ? tail.lastIndex : closeAt + close.length;
  return { lines: src.slice(start + open.length, closeAt).split(/\r?\n/).map(stripLine), end };
}

/** start 위치부터 이어지는 한 줄 주석 중 머리말에 해당하는 줄을 읽는다. 뒤따르는 다른 주석은 머리말이 아니다 */
function readLineComments(src, start, prefix) {
  const lines = [];
  let pos = start;
  let purposeIndent = -1;
  while (pos < src.length) {
    const newline = src.indexOf('\n', pos);
    const next = newline < 0 ? src.length : newline + 1;
    const raw = src.slice(pos, next).replace(/\r?\n$/, '');
    if (!raw.startsWith(prefix)) break;
    const content = raw.slice(prefix.length);
    const isKey = KEY_RE.test(content.trim());
    const isContinuation = !isKey && purposeIndent >= 0 && content.trim() !== '' && indentOf(content) >= purposeIndent + 2;
    if (!isKey && !isContinuation) break;
    if (content.trim().startsWith('Purpose')) purposeIndent = indentOf(content);
    lines.push(content);
    pos = next;
  }
  return lines.length ? { lines, end: pos } : null;
}

/** 주석 줄들에서 Date·Author·Purpose를 뽑는다. extra = 머리말이 아닌 내용이 섞여 있음(덮어쓰면 내용이 사라진다) */
function readFields(lines) {
  const fields = { date: null, author: null, purpose: null };
  const order = [];
  let extra = false;
  let purposeIndent = -1;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = KEY_RE.exec(trimmed);
    if (match && !order.includes(match[1].toLowerCase())) {
      const key = match[1].toLowerCase();
      fields[key] = match[2].trim();
      order.push(key);
      purposeIndent = key === 'purpose' ? indentOf(line) : -1;
    } else if (purposeIndent < 0 || indentOf(line) < purposeIndent + 2) {
      extra = true;
    }
  }
  return { fields, order, extra };
}

/**
 * 파일 내용에서 머리말을 찾아 검사한다.
 * @param {string} text 파일 내용
 * @param {string} ext 확장자('.js' 등)
 * @returns {{found:boolean, bom:boolean, start:number, end:number, preludeEnd:number, extra:boolean,
 *            fields:{date,author,purpose}, errors:string[]}} start·end·preludeEnd는 BOM을 뺀 글자 기준이다
 */
export function parseHeader(text, ext) {
  const style = styleOf(ext);
  const bom = text.charCodeAt(0) === 0xfeff;
  const src = bom ? text.slice(1) : text;
  const preludeEnd = preludeLength(src, style);
  const blank = /\s*/y;
  blank.lastIndex = preludeEnd;
  blank.test(src);
  const start = blank.lastIndex;
  let comment = null;
  if (style === 'block') comment = readBlockComment(src, start, '/*', '*/', (l) => l.replace(/^\s*\* ?/, ''));
  else if (style === 'html') comment = readBlockComment(src, start, '<!--', '-->', (l) => l);
  else comment = readLineComments(src, start, style === 'sql' ? '--' : '#');

  const firstLine = comment ? comment.lines.map((l) => l.trim()).find(Boolean) : null;
  const errors = bom ? ['파일이 BOM으로 시작합니다'] : [];
  if (!firstLine || !KEY_RE.test(firstLine)) {
    errors.push('머리말이 없습니다');
    return { found: false, bom, start, end: start, preludeEnd, extra: false, fields: { date: null, author: null, purpose: null }, errors };
  }
  const { fields, order, extra } = readFields(comment.lines);
  if (fields.date !== HEADER_DATE) errors.push(`Date가 ${HEADER_DATE}가 아닙니다`);
  if (fields.author !== HEADER_AUTHOR) errors.push(`Author가 ${HEADER_AUTHOR}가 아닙니다`);
  if (!fields.purpose) errors.push('Purpose가 비어 있습니다');
  if (order.length === 3 && order.join() !== 'date,author,purpose') errors.push('순서가 Date, Author, Purpose가 아닙니다');
  return { found: true, bom, start, end: comment.end, preludeEnd, extra, fields, errors };
}

/** 이 형식의 머리말 글자를 만든다(끝 줄바꿈 포함). 설명이 비었거나 주석을 일찍 닫으면 예외 */
export function renderHeader(purpose, ext, eol = '\n') {
  const style = styleOf(ext);
  if (typeof purpose !== 'string') throw new Error('설명은 문자열이어야 합니다');
  const purposeLines = purpose.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!purposeLines.length) throw new Error('설명이 비어 있습니다');
  for (const bad of UNSAFE_IN_COMMENT[style]) {
    if (purpose.includes(bad)) throw new Error(`설명에 주석을 닫는 글자 "${bad}"가 있습니다`);
  }
  const pad = ' '.repeat('Purpose: '.length);
  const body = [`Date: ${HEADER_DATE}`, `Author: ${HEADER_AUTHOR}`, `Purpose: ${purposeLines[0]}`, ...purposeLines.slice(1).map((l) => pad + l)];
  let out;
  if (style === 'block') out = ['/*', ...body.map((l) => ` * ${l}`), ' */'];
  else if (style === 'html') out = ['<!--', ...body.map((l) => `  ${l}`), '-->'];
  else out = body.map((l) => `${style === 'sql' ? '--' : '#'} ${l}`);
  return out.join(eol) + eol;
}

/** 파일에서 더 많이 쓰인 줄바꿈 */
function dominantEol(src) {
  const all = (src.match(/\n/g) || []).length;
  const crlf = (src.match(/\r\n/g) || []).length;
  return crlf * 2 > all ? '\r\n' : '\n';
}

/**
 * 머리말을 넣거나 바꾼 내용을 돌려준다. BOM은 지우고 나머지 글자와 줄바꿈은 그대로 둔다.
 * 머리말 주석 안에 다른 내용이 섞여 있으면 덮어쓰지 않고 예외를 던진다.
 */
export function applyHeader(text, purpose, ext) {
  const info = parseHeader(text, ext);
  const src = info.bom ? text.slice(1) : text;
  const eol = dominantEol(src);
  const header = renderHeader(purpose, ext, eol);
  if (info.found) {
    if (info.extra) throw new Error('머리말 주석에 다른 내용이 섞여 있어 직접 고쳐야 합니다');
    return src.slice(0, info.start) + header + src.slice(info.end);
  }
  const before = src.slice(0, info.preludeEnd);
  const glue = before && !before.endsWith('\n') ? eol : '';
  return before + glue + header + src.slice(info.preludeEnd);
}

/** 금지 단어를 찾는다. @returns {{word:string, line:number}[]} 줄 번호는 1부터 */
export function findBannedWords(text) {
  const src = String(text);
  const hits = [];
  for (const match of src.matchAll(BANNED_RE)) {
    let line = 1;
    for (let i = src.indexOf('\n'); i >= 0 && i < match.index; i = src.indexOf('\n', i + 1)) line++;
    hits.push({ word: match[0].toLowerCase(), line });
  }
  return hits;
}

/** 깨진 UTF-8이면 예외. 그대로 다시 쓰면 내용이 망가지기 때문이다 */
function decodeUtf8(buffer) {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer);
}

/** 파일 하나에 머리말을 넣거나 바꾼다. @returns {'changed'|'unchanged'} */
export function stampFile(path, purpose, { dryRun = false } = {}) {
  const before = readFileSync(path);
  const after = Buffer.from(applyHeader(decodeUtf8(before), purpose, extname(path)), 'utf8');
  if (before.equals(after)) return 'unchanged';
  if (!dryRun) writeFileSync(path, after);
  return 'changed';
}

/** root 아래 파일을 정렬된 상대 경로('/' 구분)로 돌려준다. skipDirs 이름의 폴더는 들어가지 않는다 */
function walkFiles(root, skipDirs) {
  const out = [];
  const visit = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) visit(join(dir, entry.name), `${prefix}${entry.name}/`);
      } else if (entry.isFile()) {
        out.push(prefix + entry.name);
      }
    }
  };
  visit(root, '');
  return out.sort();
}

/** 금지 단어 검사 대상: git이 추적하거나 git add에 딸려 갈 파일. git을 못 쓰면 폴더를 직접 걷는다 */
function listRepoFiles(root) {
  try {
    const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024
    });
    return [...new Set(out.split('\0').filter(Boolean))].sort();
  } catch {
    return walkFiles(root, SCAN_SKIP_DIRS);
  }
}

function checkHeaderOf(path, ext) {
  try {
    return parseHeader(decodeUtf8(readFileSync(path)), ext).errors;
  } catch (err) {
    return [`읽을 수 없습니다: ${err.message}`];
  }
}

/** 금지 단어를 본문과 경로에서 찾아 문제 목록으로 돌려준다. 바이너리·사라진 파일은 건너뛴다 */
function checkWordsOf(path, relPath) {
  const problems = findBannedWords(relPath).map((h) => `금지 단어 "${h.word}"가 파일 경로에 있습니다`);
  if (BINARY_EXT.has(extname(path).toLowerCase())) return problems;
  let buffer;
  try { buffer = readFileSync(path); } catch { return problems; }
  if (buffer.includes(0)) return problems;
  for (const hit of findBannedWords(buffer.toString('utf8'))) problems.push(`금지 단어 "${hit.word}" (${hit.line}번째 줄)`);
  return problems;
}

/**
 * 저장소 전체를 검사한다.
 * @returns {{ok:boolean, files:{path:string, problems:string[]}[]}} files는 경로 순서이고 파일마다 한 번 나온다
 */
export function runCheck({ root = REPO_ROOT } = {}) {
  const problems = new Map();
  const note = (path, list) => problems.set(path, [...(problems.get(path) || []), ...list]);
  for (const rel of walkFiles(root, HEADER_SKIP_DIRS)) {
    const ext = extname(rel).toLowerCase();
    if (STYLE_BY_EXT[ext]) note(rel, checkHeaderOf(join(root, rel), ext));
  }
  for (const rel of listRepoFiles(root)) note(rel, checkWordsOf(join(root, rel), rel));
  const files = [...problems.entries()].map(([path, list]) => ({ path, problems: list })).sort((a, b) => (a.path < b.path ? -1 : 1));
  return { ok: files.every((f) => !f.problems.length), files };
}

/**
 * {경로: 설명} 목록의 파일에 머리말을 넣거나 바꾼다. 저장소 밖 경로는 거절한다.
 * @returns {{ok:boolean, results:{path:string, status:'changed'|'unchanged'|'failed', message?:string}[]}}
 */
export function runFix({ root = REPO_ROOT, purposes, dryRun = false }) {
  const results = [];
  for (const [key, purpose] of Object.entries(purposes)) {
    const path = key.replace(/\\/g, '/');
    try {
      const full = resolve(root, path);
      const rel = relative(root, full);
      if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('저장소 밖 경로입니다');
      results.push({ path, status: stampFile(full, purpose, { dryRun }) });
    } catch (err) {
      results.push({ path, status: 'failed', message: err.message });
    }
  }
  return { ok: results.every((r) => r.status !== 'failed'), results };
}

function printCheck({ ok, files }) {
  const failed = files.filter((f) => f.problems.length);
  // 실패가 요약 바로 위에 오도록 통과한 파일을 먼저 적는다
  for (const file of files) if (!file.problems.length) console.log(`  OK    ${file.path}`);
  for (const file of failed) {
    console.log(`  FAIL  ${file.path}`);
    for (const problem of file.problems) console.log(`        - ${problem}`);
  }
  console.log(ok ? `통과: 파일 ${files.length}개` : `실패: 파일 ${files.length}개 중 ${failed.length}개`);
}

function printFix({ ok, results }, dryRun) {
  const label = { changed: dryRun ? '바꿀 예정' : '바꿈', unchanged: '그대로', failed: '실패' };
  for (const r of results) console.log(`  ${label[r.status]}  ${r.path}${r.message ? `: ${r.message}` : ''}`);
  const count = (status) => results.filter((r) => r.status === status).length;
  console.log(`${ok ? '완료' : '실패 있음'}: ${label.changed} ${count('changed')}개, 그대로 ${count('unchanged')}개, 실패 ${count('failed')}개`);
}

function parseArgs(argv) {
  const opts = { root: REPO_ROOT, fixFrom: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--fix-from' || arg === '--root') {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} 뒤에 경로가 필요합니다`);
      if (arg === '--root') opts.root = resolve(value);
      else opts.fixFrom = value;
    } else throw new Error(`모르는 옵션입니다: ${arg}`);
  }
  return opts;
}

function readPurposes(jsonPath) {
  const data = JSON.parse(readFileSync(jsonPath, 'utf8').replace(/^﻿/, ''));
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`${jsonPath}: {경로: 설명} 형태의 JSON이어야 합니다`);
  return data;
}

/** @returns {number} 종료 코드 */
export function main(argv = process.argv.slice(2)) {
  try {
    const opts = parseArgs(argv);
    if (opts.fixFrom) {
      const result = runFix({ root: opts.root, purposes: readPurposes(opts.fixFrom), dryRun: opts.dryRun });
      printFix(result, opts.dryRun);
      return result.ok ? 0 : 1;
    }
    const result = runCheck({ root: opts.root });
    printCheck(result);
    return result.ok ? 0 : 1;
  } catch (err) {
    console.error(`오류: ${err.message}`);
    return 1;
  }
}

function isRunDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
  } catch {
    return false;
  }
}

if (isRunDirectly()) process.exitCode = main();
