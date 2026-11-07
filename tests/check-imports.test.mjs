/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 모듈 연결 검사 도구의 구문 해석을 검증하고, 저장소 전체 모듈의 import가 맞는지 확인한다.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkFile, parseExports, parseImports, stripComments } from '../tools/check-imports.mjs';

describe('구문 해석', () => {
  test('내보내기 형태를 모두 찾는다', () => {
    const { names, stars } = parseExports(stripComments(`
      export const a = 1, b = 2;
      export function c() {}
      export async function d() {}
      export class E {}
      const f = 1; export { f, f as g };
      export * as ns from './x.js';
      export * from './y.js';
      export default 1;
    `));
    for (const n of ['a', 'b', 'c', 'd', 'E', 'f', 'g', 'ns', 'default']) assert.ok(names.has(n), n);
    assert.deepEqual(stars, ['./y.js']);
  });

  test('가져오기 형태를 모두 찾는다', () => {
    const list = parseImports(`
      import def, { a, b as c } from './one.js';
      import * as all from './two.js';
      export { x as y } from './three.js';
      const p = import('./four.js');
    `);
    assert.deepEqual(list.find((i) => i.spec === './one.js').names, ['a', 'b', 'default']);
    assert.deepEqual(list.find((i) => i.spec === './two.js').names, []);
    assert.deepEqual(list.find((i) => i.spec === './three.js').names, ['x']);
    assert.ok(list.some((i) => i.spec === './four.js'));
  });

  test('주석 안의 import는 무시하고 문자열은 건드리지 않는다', () => {
    const code = stripComments(`// import { x } from './gone.js';\n/* import './gone2.js'; */\nconst s = 'a // b';`);
    assert.equal(parseImports(code).length, 0);
    assert.ok(code.includes("'a // b'"));
  });
});

describe('저장소 전체', () => {
  test('모든 상대 경로 import가 실제 파일과 이름을 가리킨다', () => {
    const root = fileURLToPath(new URL('../js', import.meta.url));
    const walk = (dir) => readdirSync(dir).flatMap((n) => {
      const f = join(dir, n);
      return statSync(f).isDirectory() ? walk(f) : f.endsWith('.js') ? [f] : [];
    });
    const bad = walk(root).flatMap((f) => checkFile(f).map((p) => `${f}: ${p}`));
    assert.deepEqual(bad, []);
  });
});
