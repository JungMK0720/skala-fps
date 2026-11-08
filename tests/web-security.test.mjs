/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: index.html의 웹 보안 설정을 시험한다. CSP가 importmap 해시·Supabase 주소와 맞는지, CDN 모듈에 무결성 해시가 붙었는지,
 *          인라인 스크립트·이벤트 속성이 importmap 말고는 없는지, QA 서버가 로컬 주소만 더하는지.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { relaxCsp } from '../tools/qa/server.mjs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const config = readFileSync(new URL('../js/config.js', import.meta.url), 'utf8');
const csp = (html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/) || [])[1] || '';
const directive = (name) => (csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(name + ' ')) || '');

test('CSP가 있고 importmap을 해시로만 허용한다', () => {
  assert.ok(csp, 'CSP meta');
  const map = html.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1];
  assert.ok(!/[\r\n]/.test(map), 'importmap은 한 줄이다(줄바꿈 방식이 달라도 해시가 같게)');
  const hash = createHash('sha256').update(map, 'utf8').digest('base64');
  assert.ok(directive('script-src').includes(`'sha256-${hash}'`), 'script-src의 해시가 importmap과 같다');
  assert.ok(!directive('script-src').includes("'unsafe-inline'"), '인라인 스크립트를 통째로 열지 않는다');
  assert.ok(!/'unsafe-eval'/.test(csp));
  assert.equal(directive('object-src'), "object-src 'none'");
});

test('CDN 모듈은 무결성 해시가 붙고, 접속은 이 사이트와 설정의 Supabase만 허용한다', () => {
  const map = JSON.parse(html.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1]);
  for (const url of [map.imports.three, map.imports['cannon-es']]) assert.match(map.integrity[url] || '', /^sha384-[A-Za-z0-9+/]{64}$/, url);
  assert.match(html, /<link rel="modulepreload" href="[^"]+three\.module\.js" crossorigin integrity="sha384-/);
  const host = config.match(/https:\/\/([a-z0-9-]+\.supabase\.co)/)[1];
  assert.ok(directive('connect-src').includes(`https://${host}`) && directive('connect-src').includes(`wss://${host}`), 'Supabase 주소');
  assert.ok(!/\*\.supabase\.co|\shttps:\s|\shttps:$/.test(directive('connect-src')), '다른 곳으로는 보내지 않는다');
});

test('importmap 말고 인라인 스크립트와 인라인 이벤트 속성이 없다', () => {
  const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>/g)].map((m) => m[1]);
  assert.deepEqual(inline, [' type="importmap"']);
  assert.ok(!/\son[a-z]+="/i.test(html), '인라인 이벤트 속성');
});

test('QA 서버는 connect-src에 로컬 주소만 더한다', () => {
  const relaxed = relaxCsp(html);
  assert.ok(relaxed.includes('http://127.0.0.1:*') && relaxed.includes('ws://127.0.0.1:*'));
  assert.equal(relaxed.replace(/ http:\/\/127\.0\.0\.1:\* ws:\/\/127\.0\.0\.1:\* http:\/\/localhost:\* ws:\/\/localhost:\*/, ''), html);
});
