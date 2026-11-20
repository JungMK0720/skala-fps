/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 임시 복사본으로 주소·브랜드 이전의 일관성·멱등성과 공개 배포 파일 및 응답 헤더를 시험한다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, setDomain } from '../tools/set-domain.mjs';
import { setBrand } from '../tools/set-brand.mjs';
import { buildSite, SHIPPED } from '../tools/build-site.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const files = ['index.html', 'privacy.html', '_headers', 'README.md', 'js/config.js', 'js/core/brand.js', 'server/relay/wrangler.toml', 'server/api/wrangler.toml', 'server/relay/src/rules.js', 'server/api/src/pages.js', 'dev/notice.html'];
const quiet = () => {};
const content = (dir, file) => readFileSync(join(dir, file), 'utf8');
const metaCsp = (html) => html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
const headerCsp = (headers) => headers.match(/Content-Security-Policy: ([^\r\n]+)/)[1];
const connect = (csp) => csp.split(';').map((part) => part.trim()).find((part) => part.startsWith('connect-src '));
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'fps-launch-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const file of files) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    cpSync(join(root, file), join(dir, file));
  }
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  // 실제 저장소가 이미 이전됐더라도 시험의 출발 주소는 일정하게 둔다.
  setDomain(dir, { domain: 'before.example' }, quiet);
  for (const file of ['server/relay/wrangler.toml', 'server/api/wrangler.toml', 'server/relay/src/rules.js']) {
    writeFileSync(join(dir, file), content(dir, file).replace('https://before.example', 'https://jungmk0720.github.io'));
  }
  return dir;
}

function assertHeaders(html, headers) {
  const header = headerCsp(headers);
  const frame = "frame-ancestors 'self' https://*.crazygames.com https://crazygames.com capacitor://app.crazygames.com";
  assert.equal(header.split(';').map((part) => part.trim()).filter((part) => !part.startsWith('frame-ancestors ')).join('; '), metaCsp(html), 'index.html CSP와 _headers CSP가 다릅니다. importmap을 바꿨다면 _headers의 script-src 해시도 함께 갱신하세요.');
  assert.ok(header.split(';').map((part) => part.trim()).includes(frame));
}

test('Pages 실제 CSP는 index.html과 같고 포털 프레임만 추가 허용한다', () => {
  assertHeaders(content(root, 'index.html'), content(root, '_headers'));
  const headers = content(root, '_headers');
  assert.match(headers, /X-Content-Type-Options: nosniff/);
  assert.match(headers, /Referrer-Policy: strict-origin-when-cross-origin/);
  assert.match(headers, /Permissions-Policy: camera=\(\), microphone=\(\), geolocation=\(\), payment=\(\)/);
  assert.match(headers, /\/\*\.html\r?\n  Cache-Control: no-cache/);
  for (const path of ['/fonts/*', '/assets/models/*', '/audio/*']) assert.ok(headers.includes(path + '\n  Cache-Control: public, max-age=31536000, immutable'));
  assert.ok(!headers.includes('X-Frame-Options'), '포털 iframe을 막지 않는다');
});

test('도메인 도구는 옵션을 검사하고 호스트 기본값을 만든다', (t) => {
  const dir = fixture(t);
  assert.throws(() => parseArgs([]), /사용법/);
  for (const domain of ['https://example.io', 'example.io/path', 'example.io:443', 'bad_.io', '-bad.io', 'example..io']) assert.throws(() => parseArgs(['--domain', domain]));
  assert.throws(() => parseArgs(['--domain', 'example.io', '--wat']));
  const options = parseArgs(['--domain', 'Example.IO']);
  assert.equal(options.domain, 'example.io');
  assert.deepEqual(setDomain(dir, options, quiet).hosts, { game: 'example.io', api: 'api.example.io', relay: 'relay.example.io', gameServer: 'game.example.io' });
});

test('dry-run은 파일을 보존하고 예상 변경과 외부 콘솔 점검표를 출력한다', (t) => {
  const dir = fixture(t), logs = [];
  const before = files.map((file) => content(dir, file));
  const result = setDomain(dir, parseArgs(['--domain', 'example.io', '--dry-run']), (line) => logs.push(line));
  assert.equal(result.changed.length, 9);
  assert.deepEqual(files.map((file) => content(dir, file)), before);
  const log = logs.join('\n');
  assert.match(log, /--- index.html\n\+\+\+ index.html/);
  assert.match(log, /\+.*https:\/\/api.example.io/);
  assert.match(log, /Google:.*https:\/\/example.io\//);
  assert.match(log, /Kakao:/);
  assert.match(log, /Toss: 웹훅 https:\/\/api.example.io\/pay\/webhook/);
  assert.match(log, /DNS:/);
});

test('주소·Origin·CSP·문서를 함께 바꾸며 반복 실행해도 차이가 없다', (t) => {
  const dir = fixture(t), options = parseArgs(['--domain', 'example.io']);
  setDomain(dir, options, quiet);
  const html = content(dir, 'index.html');
  assertHeaders(html, content(dir, '_headers'));
  for (const host of ['example.io', 'api.example.io', 'relay.example.io', 'game.example.io']) {
    assert.ok(connect(metaCsp(html)).includes(`https://${host}`));
    assert.ok(connect(metaCsp(html)).includes(`wss://${host}`));
  }
  assert.ok(!connect(metaCsp(html)).includes('workers.dev'));
  assert.match(content(dir, 'js/config.js'), /relay: \{ url: 'https:\/\/relay.example.io'/);
  for (const file of ['server/relay/wrangler.toml', 'server/api/wrangler.toml', 'server/relay/src/rules.js']) {
    assert.ok(content(dir, file).includes('https://example.io'));
    assert.ok(!content(dir, file).includes('https://jungmk0720.github.io'));
    assert.ok(content(dir, file).includes('http://localhost:*'));
  }
  assert.equal(connect(metaCsp(content(dir, 'dev/notice.html'))), "connect-src 'self' https://relay.example.io wss://relay.example.io");
  assert.match(content(dir, 'privacy.html'), /Cloudflare Pages<\/td><td>게임 파일 제공 \(https:\/\/example.io\)/);
  assert.match(content(dir, 'README.md'), /플레이: <https:\/\/example.io\/>/);
  assert.deepEqual(setDomain(dir, options, quiet).changed, []);
});

test('호스트 재정의·기존 주소 병행·다음 이전도 멱등이다', (t) => {
  const dir = fixture(t);
  const options = parseArgs(['--domain', 'example.io', '--game-host', 'play.example.io', '--api-host', 'accounts.example.io', '--relay-host', 'rooms.example.io', '--game-server-host', 'seoul.example.io', '--keep-old']);
  setDomain(dir, options, quiet);
  assert.ok(content(dir, 'server/api/wrangler.toml').includes('https://jungmk0720.github.io'));
  assert.ok(content(dir, 'server/api/wrangler.toml').includes('https://play.example.io'));
  assert.ok(connect(metaCsp(content(dir, 'index.html'))).includes('wss://seoul.example.io'));
  assert.deepEqual(setDomain(dir, options, quiet).changed, []);
  const newer = { domain: 'example.net' };
  setDomain(dir, newer, quiet);
  assert.ok(!connect(metaCsp(content(dir, 'index.html'))).includes('example.io'));
  assert.ok(!connect(metaCsp(content(dir, 'index.html'))).includes('workers.dev'));
  assert.deepEqual(setDomain(dir, newer, quiet).changed, []);
});

test('브랜드는 정의에서 읽고 정적 이름만 갱신하며 dry-run·반복 변경을 지원한다', async (t) => {
  const dir = fixture(t);
  const writeBrand = (name) => writeFileSync(join(dir, 'js/core/brand.js'), `export const BRAND = Object.freeze({ name: ${JSON.stringify(name)}, nameEn: 'TEST' });`);
  writeBrand('테스트 전선');
  const before = content(dir, 'index.html');
  await setBrand(dir, { dryRun: true }, quiet);
  assert.equal(content(dir, 'index.html'), before);
  assert.equal((await setBrand(dir, {}, quiet)).length, 4);
  assert.match(content(dir, 'index.html'), /<title>테스트 전선<\/title>/);
  assert.match(content(dir, 'index.html'), /apple-mobile-web-app-title" content="테스트 전선/);
  assert.match(content(dir, 'privacy.html'), /<h1>테스트 전선 개인정보처리방침<\/h1>/);
  assert.match(content(dir, 'server/api/src/pages.js'), /<h1>테스트 전선 코인 충전<\/h1>/);
  assert.match(content(dir, 'server/api/src/pages.js'), /return layout\("테스트 전선 테스트 결제", body/);
  assert.match(content(dir, 'README.md'), /^# 테스트 전선$/m);
  assert.deepEqual(await setBrand(dir, {}, quiet), []);
  writeBrand('새 전선 & 작전');
  await setBrand(dir, {}, quiet);
  assert.match(content(dir, 'index.html'), /새 전선 &amp; 작전/);
  assert.match(content(dir, 'server/api/src/pages.js'), /return layout\("새 전선 & 작전 테스트 결제", body/);
  assert.deepEqual(await setBrand(dir, {}, quiet), []);
});

test('공개 빌드는 허용 목록만 복사하고 이전 산출물을 지운다', (t) => {
  const dir = fixture(t);
  for (const path of ['css', 'audio', 'assets/models', 'fonts', 'tests', 'docs', 'supabase', 'tools', 'infra', 'dist/stale']) {
    mkdirSync(join(dir, path), { recursive: true });
    writeFileSync(join(dir, path, 'sample.txt'), path);
  }
  writeFileSync(join(dir, '.nojekyll'), '');
  const copied = buildSite(dir);
  assert.deepEqual(copied, [...SHIPPED]);
  assert.deepEqual(readdirSync(join(dir, 'dist')).sort(), [...SHIPPED].sort());
  for (const path of ['tests', 'docs', 'server', 'supabase', 'tools', 'dev', 'infra', 'stale', 'package.json']) assert.ok(!existsSync(join(dir, 'dist', path)), path);
  assert.ok(existsSync(join(dir, 'dist/assets/models/sample.txt')));
  assert.ok(existsSync(join(dir, 'dist/js/config.js')));
});
