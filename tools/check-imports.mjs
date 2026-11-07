/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 브라우저 없이 ES 모듈 연결을 검사한다. 상대 경로 import 대상 파일이 있는지, 가져오는 이름을 그 파일이 실제로 내보내는지 본다.
 *          이름이 어긋나면 브라우저는 페이지 전체가 뜨지 않으므로, 커밋 전에 이 검사로 잡는다. 사용법: npm run check:imports
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** 주석을 지운다. 문자열 안의 주석 표시를 건드리지 않도록 따옴표 구간은 그대로 옮긴다 */
export function stripComments(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; out += ' '; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      out += src[i++];
      while (i < src.length && src[i] !== q) {
        if (src[i] === '\\') out += src[i++];
        out += src[i++];
      }
      out += src[i++] ?? '';
      continue;
    }
    out += src[i++];
  }
  return out;
}

const splitNames = (body) => body.split(',').map((s) => s.trim()).filter(Boolean);

/** 파일이 내보내는 이름 목록과 전체 재내보내기(export * from) 대상을 찾는다 */
export function parseExports(code) {
  const names = new Set();
  const stars = [];
  for (const m of code.matchAll(/\bexport\s+(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  // export const a = 1, b = 2 처럼 한 줄에 여럿인 경우
  for (const m of code.matchAll(/\bexport\s+(?:const|let|var)\s+([^;\n]+)/g)) {
    for (const part of m[1].matchAll(/(?:^|,)\s*([A-Za-z_$][\w$]*)\s*=/g)) names.add(part[1]);
  }
  if (/\bexport\s+default\b/.test(code)) names.add('default');
  for (const m of code.matchAll(/\bexport\s*\{([^}]*)\}/g)) {
    for (const item of splitNames(m[1])) {
      const as = item.split(/\s+as\s+/);
      names.add((as[1] || as[0]).trim());
    }
  }
  for (const m of code.matchAll(/\bexport\s*\*\s+as\s+([A-Za-z_$][\w$]*)\s+from/g)) names.add(m[1]);
  for (const m of code.matchAll(/\bexport\s*\*\s+from\s+['"]([^'"]+)['"]/g)) stars.push(m[1]);
  return { names, stars };
}

/** 파일의 정적 import와 재내보내기를 찾는다: [{ spec, names:[{name}] }]. 동적 import는 경로만 본다 */
export function parseImports(code) {
  const out = [];
  for (const m of code.matchAll(/\bimport\s+([^'"();]+?)\s+from\s+['"]([^'"]+)['"]/g)) {
    const clause = m[1].trim();
    const names = [];
    const brace = clause.match(/\{([^}]*)\}/);
    if (brace) for (const item of splitNames(brace[1])) names.push(item.split(/\s+as\s+/)[0].trim());
    const head = clause.replace(/\{[^}]*\}/, '').replace(/,/g, ' ').trim();
    if (head && !head.startsWith('*')) names.push('default');
    out.push({ spec: m[2], names });
  }
  for (const m of code.matchAll(/\bimport\s+['"]([^'"]+)['"]/g)) out.push({ spec: m[1], names: [] });
  for (const m of code.matchAll(/\bexport\s*\{([^}]*)\}\s*from\s+['"]([^'"]+)['"]/g)) {
    out.push({ spec: m[2], names: splitNames(m[1]).map((s) => s.split(/\s+as\s+/)[0].trim()) });
  }
  for (const m of code.matchAll(/\bexport\s*\*(?:\s+as\s+[\w$]+)?\s+from\s+['"]([^'"]+)['"]/g)) out.push({ spec: m[1], names: [] });
  for (const m of code.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push({ spec: m[1], names: [] });
  return out;
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.js')) out.push(full);
  }
  return out;
}

const cache = new Map();
function loadExports(file) {
  if (cache.has(file)) return cache.get(file);
  const info = parseExports(stripComments(readFileSync(file, 'utf8')));
  cache.set(file, info);
  for (const star of info.stars) {
    const target = resolve(dirname(file), star);
    if (existsSync(target)) for (const n of loadExports(target).names) if (n !== 'default') info.names.add(n);
  }
  return info;
}

/** 경로의 글자가 실제 파일·폴더 이름과 대소문자까지 같은가. Windows의 existsSync는 대소문자를 가리지 않지만 GitHub Pages에서는 404다 */
function sameCase(fromDir, spec) {
  let cur = fromDir;
  for (const part of spec.split('/')) {
    if (part === '.' || part === '') continue;
    if (part === '..') { cur = dirname(cur); continue; }
    if (!readdirSync(cur).includes(part)) return false;
    cur = join(cur, part);
  }
  return true;
}

export function checkFile(file) {
  const problems = [];
  for (const { spec, names } of parseImports(stripComments(readFileSync(file, 'utf8')))) {
    if (!spec.startsWith('.')) continue; // three, cannon-es 같은 importmap 대상
    const target = resolve(dirname(file), spec);
    if (!existsSync(target)) { problems.push(`없는 파일: ${spec}`); continue; }
    if (!sameCase(dirname(file), spec)) { problems.push(`대소문자가 다른 경로: ${spec}`); continue; }
    const { names: exported } = loadExports(target);
    for (const n of names) if (!exported.has(n)) problems.push(`${spec}에 없는 이름: ${n}`);
  }
  return problems;
}

function main() {
  const files = walk(join(ROOT, 'js'));
  let bad = 0;
  for (const file of files) {
    const problems = checkFile(file);
    if (!problems.length) continue;
    bad++;
    console.log(`  FAIL  ${relative(ROOT, file).split(sep).join('/')}`);
    for (const p of problems) console.log(`        - ${p}`);
  }
  if (bad) { console.log(`실패: 파일 ${files.length}개 중 ${bad}개`); process.exit(1); }
  console.log(`통과: 파일 ${files.length}개`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
