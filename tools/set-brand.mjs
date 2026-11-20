/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 브랜드 정의를 읽어 정적 문서와 결제 페이지의 이름을 함께 맞춘다.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const escapeHtml = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export async function setBrand(root, { dryRun = false } = {}, log = console.log) {
  const url = pathToFileURL(resolve(root, 'js/core/brand.js'));
  url.searchParams.set('revision', createHash('sha256').update(readFileSync(url)).digest('hex'));
  const { BRAND } = await import(url.href);
  if (typeof BRAND?.name !== 'string' || !BRAND.name.trim() || /[\r\n]/.test(BRAND.name)) throw new Error('BRAND.name은 비어 있지 않은 한 줄 이름이어야 합니다');
  const name = BRAND.name, htmlName = escapeHtml(name);
  const files = ['index.html', 'privacy.html', 'server/api/src/pages.js', 'README.md'];
  const before = Object.fromEntries(files.map((file) => [file, readFileSync(resolve(root, file), 'utf8')]));
  const oldHtml = before['index.html'].match(/<title>([^<]+)<\/title>/)?.[1];
  if (!oldHtml) throw new Error('index.html의 정적 title을 찾지 못했습니다');
  const next = { ...before };
  next['index.html'] = before['index.html'].replace(/<title>[^<]*<\/title>/, `<title>${htmlName}</title>`)
    .replace(/(<meta name="apple-mobile-web-app-title" content=")[^"]*(")/, (_, start, end) => start + htmlName + end)
    .replace(/(<meta name="description" content=")([^"]*)(")/, (_, start, text, end) => start + text.replaceAll(oldHtml, htmlName) + end)
    .replace(/<noscript>[\s\S]*?<\/noscript>/g, (text) => text.replaceAll(oldHtml, htmlName));
  next['privacy.html'] = before['privacy.html'].replaceAll(oldHtml, htmlName);
  // 결제 본문은 템플릿 리터럴이며 제목은 안전한 문자열 리터럴로 기록한다.
  next['server/api/src/pages.js'] = before['server/api/src/pages.js']
    .replace(/<h1>([^<]*)<\/h1>/g, (text) => text.replaceAll(oldHtml.replace(/[`$\\]/g, '\\$&'), htmlName.replace(/[`$\\]/g, '\\$&')))
    .replace(/return layout\((?:'[^']*'|"(?:\\.|[^"\\])*"), body/g, () => `return layout(${JSON.stringify(name + ' 테스트 결제')}, body`);
  next['README.md'] = before['README.md'].replace(/^# .+$/m, '# ' + name);
  const changed = files.filter((file) => before[file] !== next[file]);
  for (const file of changed) {
    log(`${dryRun ? '미리보기' : '갱신'}: ${file}`);
    if (!dryRun) writeFileSync(resolve(root, file), next[file]);
  }
  return changed;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--dry-run')) { console.error('사용법: node tools/set-brand.mjs [--dry-run]'); process.exitCode = 1; }
  else await setBrand(ROOT, { dryRun: args.includes('--dry-run') });
}
