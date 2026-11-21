/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 화면 글자 번역 누락을 찾는다. 표(js/core/lang)의 한국어·영어 짝, 코드의 t('키') 존재, 데이터의 짝 칸(name/nameEn),
 *          표 밖 코드에 남은 한글 문자열을 검사한다. tests/i18n.test.mjs가 부르고 단독으로도 돈다(node tools/check-i18n.mjs).
 */
/**
 * 규칙(docs/PORTAL.md 번역 절)
 *  - 화면에 보이는 글자는 t('영역.이름') 또는 데이터의 짝 칸(loc(obj, 'name') ↔ name/nameEn)으로 쓴다.
 *  - 코드에 한글 문자열을 남겨도 되는 곳:
 *      SKIP_DIRS / SKIP_FILES  표, 운영자 패널, 디버그 도구처럼 플레이어가 보지 않는 파일
 *      PAIRED_DATA            짝 칸을 가진 데이터 파일. 대신 내보낸 값을 훑어 한글 칸마다 '칸En'이 있는지 본다
 *      console.* 호출 줄        개발자용 기록
 *      줄 끝 주석 'i18n-ok'     이유를 함께 적는다. 예: if (/[가-힣]/.test(s)) … // i18n-ok: 한글 판별 정규식
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** 통째로 건너뛰는 폴더(저장소 기준, '/' 구분) */
export const SKIP_DIRS = Object.freeze([
  'js/core/lang',   // 번역 표 자체
  'js/admin'        // 운영자 공지 패널(dev/notice.html, 운영자 전용)
]);
/** 통째로 건너뛰는 파일과 이유 */
export const SKIP_FILES = Object.freeze({
  'js/engine/debug.js': '?debug=1 개발자 패널',
  'js/ui/demo.js': 'dev/ui-demo.html QA 전용 목 화면',
  'js/core/profanity.js': '채팅 욕설 목록(화면 글자가 아니다)'
});
/** 짝 칸 데이터 파일. 이 파일의 한글은 내보낸 값의 '칸En' 검사로 대신한다 */
export const PAIRED_DATA = Object.freeze([
  'js/core/brand.js',
  'js/core/consts.js',
  'js/core/avatar-defs.js',
  'js/weapons/defs.js',
  'js/game/modes.js',
  'js/maps/alley.js',
  'js/maps/cqb.js',
  'js/maps/dojo.js',
  'js/maps/glasshouse.js',
  'js/maps/hanok.js',
  'js/maps/harbortown.js',
  'js/maps/index.js',
  'js/maps/jetty.js',
  'js/maps/karaoke.js',
  'js/maps/longshot.js',
  'js/maps/lot.js',
  'js/maps/nexus.js',
  'js/maps/observatory.js',
  'js/maps/railyard.js',
  'js/maps/relay.js',
  'js/maps/restarea.js',
  'js/maps/rooftop.js',
  'js/maps/schoolyard.js',
  'js/maps/sorthub.js',
  'js/maps/subway.js',
  'js/maps/tankfarm.js',
  'js/maps/vlcc.js'
]);

const HANGUL = /[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7A3]/;
const rel = (p) => relative(ROOT, p).split(sep).join('/');

export function listJs(dir = join(ROOT, 'js')) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listJs(full));
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

/** 정규식 리터럴이 올 수 있는 자리인가(바로 앞의 의미 있는 글자로 판단) */
const REGEX_BEFORE = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);
const REGEX_AFTER_WORD = /(?:^|[^\w$])(?:return|typeof|case|in|of|new|delete|void|throw|else|do)$/;

/**
 * 주석을 지운 코드. 줄 수는 그대로 둔다(줄바꿈은 남긴다). 문자열·템플릿·정규식 리터럴은 그대로 옮긴다.
 * @param {string} src
 */
export function stripCommentsKeepLines(src) {
  let out = '';
  const lastSig = () => {
    let k = out.length - 1;
    while (k >= 0 && /\s/.test(out[k])) k--;
    return k >= 0 ? out[k] : '';
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') {
      const e = src.indexOf('*/', i + 2);
      const end = e < 0 ? src.length : e + 2;
      out += src.slice(i, end).replace(/[^\n]/g, ' ');
      i = end;
      continue;
    }
    if (c === '"' || c === "'") {
      out += src[i++];
      while (i < src.length && src[i] !== c && src[i] !== '\n') { if (src[i] === '\\') out += src[i++]; out += src[i++]; }
      out += src[i++] ?? '';
      continue;
    }
    if (c === '`') {
      // 템플릿: ${ … } 안은 코드라 주석이 있을 수 있지만 드물어 그대로 옮긴다
      out += src[i++];
      while (i < src.length && src[i] !== '`') { if (src[i] === '\\') out += src[i++]; out += src[i++]; }
      out += src[i++] ?? '';
      continue;
    }
    if (c === '/') {
      const sig = lastSig();
      const before = out.slice(-12);
      if (REGEX_BEFORE.has(sig) || REGEX_AFTER_WORD.test(before.trimEnd())) {
        let j = i + 1, cls = false;
        while (j < src.length && src[j] !== '\n') {
          if (src[j] === '\\') { j += 2; continue; }
          if (src[j] === '[') cls = true; else if (src[j] === ']') cls = false;
          else if (src[j] === '/' && !cls) break;
          j++;
        }
        if (src[j] === '/') { out += src.slice(i, j + 1); i = j + 1; continue; }
      }
    }
    out += src[i++];
  }
  return out;
}

/**
 * 표 밖 코드에 남은 한글 줄을 찾는다.
 * @param {string} src 파일 내용
 * @returns {{line:number, text:string}[]}
 */
export function findHangul(src) {
  const raw = src.split('\n');
  const code = stripCommentsKeepLines(src).split('\n');
  const out = [];
  code.forEach((line, i) => {
    if (!HANGUL.test(line)) return;
    const original = raw[i] || '';
    if (/\bi18n-ok\b/.test(original)) return;
    if (/\bconsole\.(log|warn|error|info|debug)\s*\(/.test(line)) return;
    out.push({ line: i + 1, text: original.trim().slice(0, 140) });
  });
  return out;
}

/** 표 밖 한글 검사 대상 파일 */
export function scanTargets(files = listJs()) {
  return files.filter((f) => {
    const r = rel(f);
    if (SKIP_DIRS.some((d) => r === d || r.startsWith(d + '/'))) return false;
    if (Object.prototype.hasOwnProperty.call(SKIP_FILES, r)) return false;
    return !PAIRED_DATA.includes(r);
  });
}

/** 저장소 전체의 표 밖 한글: { 'js/ui/x.js': [{line, text}] } */
export function scanHangul(files = scanTargets()) {
  const found = {};
  for (const f of files) {
    const hits = findHangul(readFileSync(f, 'utf8'));
    if (hits.length) found[rel(f)] = hits;
  }
  return found;
}

/**
 * 내보낸 데이터 값을 훑어 한글 칸마다 짝 칸('칸En')이 있는지 본다.
 * 글자 칸은 짝도 비어 있지 않은 글자, 글자 배열 칸은 길이가 같은 배열이어야 한다.
 * @param {*} value 모듈이 내보낸 값
 * @param {string} path 오류에 쓸 위치
 * @returns {string[]} 문제 목록
 */
export function checkPaired(value, path, seen = new Set()) {
  const problems = [];
  if (!value || typeof value !== 'object' || seen.has(value)) return problems;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((v, i) => problems.push(...checkPaired(v, `${path}[${i}]`, seen)));
    return problems;
  }
  for (const [k, v] of Object.entries(value)) {
    if (k.endsWith('En')) continue;
    const en = value[k + 'En'];
    if (typeof v === 'string' && HANGUL.test(v)) {
      if (typeof en !== 'string' || !en.trim()) problems.push(`${path}.${k}: '${v.slice(0, 30)}'에 ${k}En이 없다`);
      else if (HANGUL.test(en)) problems.push(`${path}.${k}En에 한글이 있다`);
    } else if (Array.isArray(v) && v.some((x) => typeof x === 'string' && HANGUL.test(x))) {
      if (!Array.isArray(en) || en.length !== v.length || en.some((x) => typeof x !== 'string' || !x.trim())) problems.push(`${path}.${k}: ${k}En 배열이 없거나 길이가 다르다`);
    } else {
      problems.push(...checkPaired(v, `${path}.${k}`, seen));
    }
  }
  return problems;
}

/** PAIRED_DATA 모듈을 불러와 짝 칸 문제를 모은다 */
export async function checkPairedData(list = PAIRED_DATA) {
  const problems = [];
  for (const file of list) {
    const mod = await import(pathToFileURL(join(ROOT, file)).href);
    for (const [name, value] of Object.entries(mod)) {
      if (typeof value === 'function') continue;
      problems.push(...checkPaired(value, `${file}:${name}`));
    }
  }
  return problems;
}

/** 표의 모양 검사: 키 모양, 짝, {자리} 이름, 영어에 한글 없음, 영역 사이 중복 키 */
export function checkTables(tables) {
  const problems = [];
  const owner = new Map();
  const holes = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
  for (const [area, table] of Object.entries(tables)) {
    for (const [key, pair] of Object.entries(table)) {
      if (owner.has(key)) problems.push(`${key}: ${owner.get(key)}와 ${area}에 모두 있다`);
      owner.set(key, area);
      if (!/^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9_-]+)+$/.test(key)) problems.push(`${area}/${key}: 키는 '영역.이름' 모양`);
      if (!Array.isArray(pair) || pair.length !== 2) { problems.push(`${area}/${key}: ['한국어', 'English'] 짝이 아니다`); continue; }
      const [ko, en] = pair;
      if (typeof ko !== 'string' || typeof en !== 'string') { problems.push(`${area}/${key}: 글자가 아니다`); continue; }
      if (!en.trim()) problems.push(`${area}/${key}: 영어가 비었다`);
      if (!ko.trim()) problems.push(`${area}/${key}: 한국어가 비었다`);
      if (HANGUL.test(en)) problems.push(`${area}/${key}: 영어 칸에 한글이 있다`);
      if (holes(ko) !== holes(en)) problems.push(`${area}/${key}: {자리}가 다르다 (${holes(ko)} / ${holes(en)})`);
    }
  }
  return problems;
}

/** 코드가 글자 그대로 부르는 t('키') 중 표에 없는 것 */
export function missingKeys(has, files = listJs()) {
  const missing = [];
  for (const f of files) {
    const code = stripCommentsKeepLines(readFileSync(f, 'utf8'));
    for (const m of code.matchAll(/(?:^|[^\w$.])t\(\s*'([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9_-]+)+)'/g)) {
      if (!has(m[1])) missing.push(`${rel(f)}: ${m[1]}`);
    }
  }
  return missing;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { TABLES, hasKey } = await import(pathToFileURL(join(ROOT, 'js/core/i18n.js')).href);
  const left = scanHangul();
  const problems = [...checkTables(TABLES), ...missingKeys(hasKey), ...(await checkPairedData())];
  for (const [file, hits] of Object.entries(left)) for (const h of hits) problems.push(`${file}:${h.line} ${h.text}`);
  for (const p of problems) console.log(p);
  console.log(problems.length ? `번역 문제 ${problems.length}개` : '번역 검사 통과');
  process.exitCode = problems.length ? 1 : 0;
}
