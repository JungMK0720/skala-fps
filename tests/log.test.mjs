/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 개발 도구 테스트. 로거의 레벨·이름표 필터·링 버퍼, 머리말 검사기의 해석·삽입,
 *          디버그 도구의 판정 부위 선(물리 판정과 일치), 충돌체 선, 키 처리와 정리를 확인한다.
 */
import test, { describe, afterEach, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { clearLogs, configureLog, createLogger, getLogs, LOG_CAPACITY } from '../js/core/log.js';
import {
  applyHeader, BANNED_WORDS, findBannedWords, HEADER_AUTHOR, HEADER_DATE, parseHeader, renderHeader, runCheck, runFix, stampFile
} from '../tools/check-headers.mjs';
import { buildWireLines, createDebug, hitVolumes, isTextEntry, volumeVertexCount, writeTargetLines } from '../js/engine/debug.js';
import { raycastPlayers, rampHeight } from '../js/engine/physics.js';

const TOOL = fileURLToPath(new URL('../tools/check-headers.mjs', import.meta.url));

/* ============================================================ 로거 */

describe('로거', () => {
  /** 콘솔 호출을 가로채 [메서드, ...인자] 목록으로 모은다 */
  function captureConsole(t) {
    const calls = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
      t.mock.method(console, method, (...args) => { calls.push([method, ...args]); });
    }
    return calls;
  }

  afterEach(() => {
    clearLogs();
    configureLog('');
  });

  test('기본 레벨은 info다: debug는 콘솔에도 버퍼에도 남지 않는다', (t) => {
    const calls = captureConsole(t);
    configureLog('');
    const log = createLogger('physics');
    log.debug('안 보임');
    log.info('보임');
    assert.deepEqual(calls, [['info', '[physics]', '보임']]);
    assert.deepEqual(getLogs().map((l) => l.text), ['보임']);
  });

  test('?log로 레벨을 정하고 그 아래는 조용하다', (t) => {
    const calls = captureConsole(t);
    configureLog('?log=warn');
    const log = createLogger('net');
    log.debug('a'); log.info('b'); log.warn('c'); log.error('d');
    assert.deepEqual(calls.map((c) => c[0]), ['warn', 'error']);
    assert.deepEqual(getLogs().map((l) => [l.level, l.ns, l.text]), [['warn', 'net', 'c'], ['error', 'net', 'd']]);
  });

  test('?log=debug는 항상 보이는 console.log로 낸다', (t) => {
    const calls = captureConsole(t);
    configureLog('?log=debug');
    createLogger('net').debug('x', 1);
    assert.deepEqual(calls, [['log', '[net]', 'x', 1]]);
  });

  test('모르는 레벨은 기본값(info)이다', (t) => {
    captureConsole(t);
    for (const search of ['?log=loud', '?log=constructor', '?log=']) {
      configureLog(search);
      clearLogs();
      const log = createLogger('a');
      log.debug('아래');
      log.info('위');
      assert.deepEqual(getLogs().map((l) => l.text), ['위'], search);
    }
  });

  test('?logns는 목록의 이름표만 남기고 하위 이름표도 포함한다', (t) => {
    captureConsole(t);
    configureLog('?logns=physics, net');
    createLogger('physics').info('1');
    createLogger('net').warn('2');
    createLogger('net:room').info('3');
    createLogger('network').info('이름이 net으로 시작할 뿐');
    createLogger('ui').warn('다른 모듈');
    assert.deepEqual(getLogs().map((l) => l.text), ['1', '2', '3']);
  });

  test('error는 이름표 필터를 무시한다', (t) => {
    const calls = captureConsole(t);
    configureLog('?logns=physics');
    createLogger('net').error('꼭 봐야 함');
    assert.equal(calls.length, 1);
    assert.equal(getLogs()[0].ns, 'net');
  });

  test('링 버퍼는 500줄까지만 갖고 오래된 줄부터 밀어낸다', (t) => {
    captureConsole(t);
    const log = createLogger('a');
    assert.equal(LOG_CAPACITY, 500);
    for (let i = 0; i < 620; i++) log.info(`줄 ${i}`);
    const lines = getLogs();
    assert.equal(lines.length, 500);
    assert.equal(lines[0].text, '줄 120');
    assert.equal(lines[499].text, '줄 619');
    for (let i = 1; i < lines.length; i++) assert.ok(lines[i].t >= lines[i - 1].t);
  });

  test('getLogs는 새 배열이고 clearLogs는 비운다', (t) => {
    captureConsole(t);
    createLogger('a').info('x');
    const first = getLogs();
    first.length = 0;
    assert.equal(getLogs().length, 1);
    clearLogs();
    assert.equal(getLogs().length, 0);
  });

  test('어떤 인자가 와도 예외를 던지지 않고 값은 기록 시점의 글자로 남는다', (t) => {
    const calls = captureConsole(t);
    const log = createLogger('a');
    const cycle = { name: 'c' };
    cycle.self = cycle;
    const hostile = { get boom() { throw new Error('getter'); } };
    log.info(cycle, hostile, null, undefined, 10n, Symbol('s'), () => {}, new Map([[1, 2]]), Object.create(null), new Float32Array([1.5, 2]));
    const text = getLogs()[0].text;
    assert.match(text, /\[순환\]/);
    assert.match(text, /\[출력 불가\]/);
    assert.match(text, /Map\(1\)/);
    assert.match(text, /\[1\.5, 2\]/);
    assert.equal(calls.length, 1);

    const live = { hp: 100 };
    log.info(live);
    live.hp = 0;
    assert.match(getLogs()[1].text, /hp: 100/);

    log.error(new Error('터짐'));
    assert.match(getLogs()[2].text, /터짐/);
  });

  test('한 줄이 아주 길어도 잘려서 메모리가 묶인다', (t) => {
    captureConsole(t);
    createLogger('a').info('x'.repeat(50000));
    assert.ok(getLogs()[0].text.length <= 1001);
  });
});

/* ============================================================ 머리말 검사기 */

describe('머리말 검사기', () => {
  const BLOCK = `/*\n * Date: ${HEADER_DATE}\n * Author: ${HEADER_AUTHOR}\n * Purpose: 설명\n */\nconst a = 1;\n`;

  test('형식별 올바른 머리말을 통과시킨다', () => {
    const lines = (prefix) => `${prefix} Date: ${HEADER_DATE}\n${prefix} Author: ${HEADER_AUTHOR}\n${prefix} Purpose: 설명\n`;
    const html = `<!--\n  Date: ${HEADER_DATE}\n  Author: ${HEADER_AUTHOR}\n  Purpose: 설명\n-->\n<html></html>\n`;
    const cases = [
      ['.js', BLOCK],
      ['.mjs', BLOCK],
      ['.mjs', `#!/usr/bin/env node\n${BLOCK}`],
      ['.css', `/*\n * Date: ${HEADER_DATE}\n * Author: ${HEADER_AUTHOR}\n * Purpose: 스타일\n */\nbody {}\n`],
      ['.js', BLOCK.replace('/*', '/**')],
      ['.html', html],
      ['.html', `<!DOCTYPE html>\n${html}`],
      ['.html', `<!doctype html>\r\n\r\n${html.replace(/\n/g, '\r\n')}`],
      ['.sql', `${lines('--')}create table t ();\n`],
      ['.yml', `${lines('#')}name: x\n`],
      ['.yaml', `${lines('#')}name: x\n`]
    ];
    for (const [ext, text] of cases) {
      const info = parseHeader(text, ext);
      assert.deepEqual(info.errors, [], `${ext}: ${text.slice(0, 30)}`);
      assert.equal(info.fields.purpose, info.fields.purpose.trim());
    }
  });

  test('틀린 머리말은 이유를 알려 준다', () => {
    const errorsOf = (text, ext = '.js') => parseHeader(text, ext).errors.join('|');
    assert.match(errorsOf('const a = 1;\n'), /머리말이 없습니다/);
    assert.match(errorsOf('/**\n * SKALA FPS — 설명 문서\n */\nconst a = 1;\n'), /머리말이 없습니다/);
    assert.match(errorsOf(''), /머리말이 없습니다/);
    assert.match(errorsOf('/* Date: 안 닫힘'), /머리말이 없습니다/);
    assert.match(errorsOf(BLOCK.replace(HEADER_DATE, '01JAN2020')), /Date/);
    assert.match(errorsOf(BLOCK.replace(HEADER_AUTHOR, '다른 사람')), /Author/);
    assert.match(errorsOf(BLOCK.replace('Purpose: 설명', 'Purpose:   ')), /Purpose/);
    assert.match(errorsOf(BLOCK.replace(' * Purpose: 설명\n', '')), /Purpose/);
    assert.match(errorsOf(`﻿${BLOCK}`), /BOM/);
    assert.match(errorsOf(`/*\n * Author: ${HEADER_AUTHOR}\n * Date: ${HEADER_DATE}\n * Purpose: x\n */\n`), /순서/);
    // 형식에 맞는 주석이어야 한다
    assert.match(errorsOf(BLOCK, '.sql'), /머리말이 없습니다/);
    assert.match(errorsOf(BLOCK, '.yml'), /머리말이 없습니다/);
    assert.match(errorsOf(BLOCK, '.html'), /머리말이 없습니다/);
    assert.match(errorsOf(`const a = 1;\n${BLOCK}`), /머리말이 없습니다/);
    assert.throws(() => parseHeader('{}', '.json'));
  });

  test('머리말이 없으면 맨 위에 넣고 나머지는 한 글자도 바꾸지 않는다', () => {
    const body = '/**\n * SKALA FPS — 기존 설명\n */\nimport x from "y";\n';
    const out = applyHeader(body, '새 설명', '.js');
    assert.equal(out, renderHeader('새 설명', '.js') + body);
    assert.deepEqual(parseHeader(out, '.js').errors, []);
    assert.equal(parseHeader(out, '.js').fields.purpose, '새 설명');
  });

  test('이미 있는 머리말은 바꾸고 뒤따르는 내용은 그대로 둔다', () => {
    const out = applyHeader(BLOCK, '바뀐 설명', '.js');
    assert.equal(out, renderHeader('바뀐 설명', '.js') + 'const a = 1;\n');
  });

  test('잘못된 머리말도 올바른 것으로 바꾼다', () => {
    const out = applyHeader(BLOCK.replace(HEADER_DATE, '01JAN2020'), '설명', '.js');
    assert.deepEqual(parseHeader(out, '.js').errors, []);
    assert.ok(out.endsWith('const a = 1;\n'));
  });

  test('두 번 적용해도 결과가 같다', () => {
    for (const [ext, text] of [['.js', 'const a = 1;\n'], ['.html', '<!DOCTYPE html>\n<html></html>\n'], ['.sql', '-- 설명\nselect 1;\n'], ['.yml', 'name: x\n'], ['.css', 'body {}\n']]) {
      const once = applyHeader(text, '줄 하나\n줄 둘', ext);
      assert.equal(applyHeader(once, '줄 하나\n줄 둘', ext), once, ext);
      assert.deepEqual(parseHeader(once, ext).errors, [], ext);
    }
  });

  test('줄바꿈을 유지한다: CRLF 파일은 CRLF 머리말, LF 파일은 LF 머리말', () => {
    const crlf = applyHeader('const a = 1;\r\nconst b = 2;\r\n', '설명', '.js');
    assert.ok(crlf.startsWith('/*\r\n * Date:'));
    assert.ok(crlf.endsWith(' */\r\nconst a = 1;\r\nconst b = 2;\r\n'));
    assert.equal(crlf.replace(/\r\n/g, '').includes('\n'), false);

    const lf = applyHeader('const a = 1;\n', '설명', '.js');
    assert.equal(lf.includes('\r'), false);
  });

  test('줄바꿈이 섞인 파일은 본문을 그대로 둔다', () => {
    const body = 'a\r\nb\nc\r\nd\r\n';
    assert.ok(applyHeader(body, '설명', '.js').endsWith(body));
  });

  test('BOM을 지운다', () => {
    const out = applyHeader('﻿const a = 1;\n', '설명', '.js');
    assert.notEqual(out.charCodeAt(0), 0xfeff);
    assert.ok(out.startsWith('/*\n'));
    assert.ok(out.endsWith('const a = 1;\n'));
  });

  test('HTML은 DOCTYPE 다음, 스크립트는 #! 다음에 넣는다', () => {
    const html = applyHeader('<!DOCTYPE html>\n<html lang="ko"></html>\n', '페이지', '.html');
    assert.ok(html.startsWith('<!DOCTYPE html>\n<!--\n  Date:'));
    assert.ok(html.endsWith('-->\n<html lang="ko"></html>\n'));

    const oneLine = applyHeader('<!DOCTYPE html><html></html>', '페이지', '.html');
    assert.ok(oneLine.startsWith('<!DOCTYPE html>\n<!--\n'));
    assert.ok(oneLine.endsWith('-->\n<html></html>'));
    assert.deepEqual(parseHeader(oneLine, '.html').errors, []);

    const script = applyHeader('#!/usr/bin/env node\nconsole.log(1);\n', '도구', '.mjs');
    assert.ok(script.startsWith('#!/usr/bin/env node\n/*\n'));
    assert.ok(script.endsWith(' */\nconsole.log(1);\n'));
  });

  test('SQL·YAML은 한 줄 주석을 쓰고 뒤따르는 다른 주석은 머리말로 보지 않는다', () => {
    const sql = applyHeader('-- 테이블 설명\ncreate table t ();\n', 'DB', '.sql');
    assert.equal(sql, `-- Date: ${HEADER_DATE}\n-- Author: ${HEADER_AUTHOR}\n-- Purpose: DB\n-- 테이블 설명\ncreate table t ();\n`);
    assert.equal(applyHeader(sql, '바뀜', '.sql'), `-- Date: ${HEADER_DATE}\n-- Author: ${HEADER_AUTHOR}\n-- Purpose: 바뀜\n-- 테이블 설명\ncreate table t ();\n`);

    const yml = applyHeader('# 배포\nname: x\n', 'CI', '.yml');
    assert.ok(yml.startsWith(`# Date: ${HEADER_DATE}\n# Author: ${HEADER_AUTHOR}\n# Purpose: CI\n# 배포\n`));
  });

  test('여러 줄 설명은 Purpose 다음 줄에 맞춰 이어 쓰고, 바꿀 때 함께 사라진다', () => {
    const header = renderHeader('첫 줄\n  둘째 줄  \n\n셋째 줄', '.js');
    assert.ok(header.includes(' * Purpose: 첫 줄\n *          둘째 줄\n *          셋째 줄\n */\n'));
    const out = applyHeader(`${header}code();\n`, '하나', '.js');
    assert.equal(out, renderHeader('하나', '.js') + 'code();\n');

    const sqlHeader = renderHeader('첫 줄\n둘째 줄', '.sql');
    assert.equal(applyHeader(`${sqlHeader}-- 다른 주석\n`, '하나', '.sql'), `${renderHeader('하나', '.sql')}-- 다른 주석\n`);
  });

  test('설명이 비었거나 주석을 일찍 닫으면 거절한다', () => {
    assert.throws(() => renderHeader('', '.js'), /비어/);
    assert.throws(() => renderHeader('  \n ', '.js'), /비어/);
    assert.throws(() => renderHeader(null, '.js'), /문자열/);
    assert.throws(() => renderHeader('js/*/README.md 참고', '.js'), /주석을 닫는/);
    assert.throws(() => renderHeader('a --> b', '.html'), /주석을 닫는/);
    assert.equal(renderHeader('a --> b', '.js').includes('a --> b'), true);
    assert.throws(() => renderHeader('x', '.json'), /형식/);
    assert.throws(() => renderHeader('x', '.md'), /형식/);
  });

  test('머리말 주석에 다른 내용이 섞여 있으면 덮어쓰지 않는다', () => {
    const mixed = `/*\n * Date: ${HEADER_DATE}\n * Author: ${HEADER_AUTHOR}\n * Purpose: 설명\n *\n * 사용법을 적은 문단\n */\n`;
    assert.deepEqual(parseHeader(mixed, '.js').errors, []);   // 검사는 통과한다
    assert.throws(() => applyHeader(mixed, '새 설명', '.js'), /다른 내용/);
  });

  test('금지 단어를 대소문자 없이 찾고 줄 번호를 알려 준다', () => {
    assert.equal(BANNED_WORDS.length, 7);
    for (const word of BANNED_WORDS) {
      assert.deepEqual(findBannedWords(`앞줄\n둘째 줄\n셋째 ${word.toUpperCase()} 끝`), [{ word, line: 3 }], word);
      assert.equal(findBannedWords(`x${word}y`).length, 1, word);
    }
    assert.deepEqual(findBannedWords('평범한 글자 gpt 와 pilot, open ai'), []);
  });

  describe('파일에 적용', () => {
    let dir;
    const write = (rel, content) => {
      const full = join(dir, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
      return full;
    };

    before(() => { dir = mkdtempSync(join(tmpdir(), 'skala-headers-')); });
    after(() => { rmSync(dir, { recursive: true, force: true }); });

    test('stampFile은 BOM 없는 UTF-8로 쓰고 바뀐 게 없으면 파일을 건드리지 않는다', () => {
      const file = write('stamp/a.js', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('const 이름 = 1;\r\n')]));
      assert.equal(stampFile(file, '설명'), 'changed');
      const bytes = readFileSync(file);
      assert.notEqual(bytes[0], 0xef);
      assert.ok(bytes.toString('utf8').startsWith('/*\r\n * Date:'));
      assert.ok(bytes.toString('utf8').endsWith('const 이름 = 1;\r\n'));
      assert.equal(stampFile(file, '설명'), 'unchanged');
    });

    test('dryRun은 쓰지 않고, 깨진 UTF-8은 건드리지 않는다', () => {
      const file = write('stamp/b.js', 'const a = 1;\n');
      assert.equal(stampFile(file, '설명', { dryRun: true }), 'changed');
      assert.equal(readFileSync(file, 'utf8'), 'const a = 1;\n');

      const broken = Buffer.from([0x2f, 0x2f, 0x20, 0xc3, 0x28, 0x0a]);
      const bad = write('stamp/c.js', broken);
      assert.throws(() => stampFile(bad, '설명'));
      assert.ok(readFileSync(bad).equals(broken));
    });

    test('runFix는 파일별 결과를 돌려주고 실패해도 나머지를 처리한다', () => {
      const root = join(dir, 'fix');
      mkdirSync(root);
      const good = 'js/ok.js', json = 'data.json';
      writeFileSync(join(root, json), '{}');
      mkdirSync(join(root, 'js'));
      writeFileSync(join(root, good), 'const a = 1;\n');
      const { ok, results } = runFix({
        root,
        purposes: { 'js\\ok.js': '좋음', 'data.json': '형식 오류', 'js/없는파일.js': '없음', '../바깥.js': '밖', 'js/ok2.js': 5 }
      });
      assert.equal(ok, false);
      const statusOf = (path) => results.find((r) => r.path === path).status;
      assert.equal(statusOf('js/ok.js'), 'changed');
      assert.equal(statusOf('data.json'), 'failed');
      assert.equal(statusOf('js/없는파일.js'), 'failed');
      assert.equal(statusOf('../바깥.js'), 'failed');
      assert.equal(statusOf('js/ok2.js'), 'failed');
      assert.equal(readFileSync(join(root, json), 'utf8'), '{}');
      assert.ok(readFileSync(join(root, good), 'utf8').includes('Purpose: 좋음'));
    });

    test('runCheck는 폴더를 걸어 머리말과 금지 단어를 파일별로 보고한다', () => {
      const root = join(dir, 'check');
      const add = (rel, content) => {
        const full = join(root, rel);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, content);
      };
      add('js/good.js', BLOCK);
      add('js/bad.js', 'const a = 1;\n');
      add('docs/guide.md', `# 안내\n${BANNED_WORDS[1]}\n`);
      add('docs/clean.md', '# 안내\n');
      add('package.json', '{}\n');
      add('audio/song.js', 'skip();\n');
      add('node_modules/dep/index.js', 'skip();\n');
      add(`data/${BANNED_WORDS[5]}.txt`, '내용은 멀쩡함\n');
      const { ok, files } = runCheck({ root });
      assert.equal(ok, false);
      const problemsOf = (path) => files.find((f) => f.path === path).problems;
      assert.deepEqual(problemsOf('js/good.js'), []);
      assert.match(problemsOf('js/bad.js').join(), /머리말이 없습니다/);
      assert.match(problemsOf('docs/guide.md').join(), /2번째 줄/);
      assert.deepEqual(problemsOf('docs/clean.md'), []);
      assert.deepEqual(problemsOf('package.json'), []);
      assert.match(problemsOf(`data/${BANNED_WORDS[5]}.txt`).join(), /경로/);
      assert.equal(files.some((f) => f.path.startsWith('node_modules/')), false);
      // audio 안의 코드는 머리말을 보지 않지만 금지 단어는 본다
      assert.deepEqual(problemsOf('audio/song.js'), []);
    });

    test('명령줄: 실패하면 종료 코드 1, 고치면 0', () => {
      const root = join(dir, 'cli');
      mkdirSync(root);
      writeFileSync(join(root, 'a.js'), 'const a = 1;\n');
      writeFileSync(join(root, 'b.html'), '<!DOCTYPE html>\n<html></html>\n');
      const run = (...args) => spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8' });

      const failed = run('--root', root);
      assert.equal(failed.status, 1, failed.stderr);
      assert.match(failed.stdout, /FAIL {2}a\.js/);
      assert.match(failed.stdout, /FAIL {2}b\.html/);

      const stamp = join(dir, 'stamp.json');
      writeFileSync(stamp, JSON.stringify({ 'a.js': '스크립트', 'b.html': '페이지' }));
      const dry = run('--root', root, '--fix-from', stamp, '--dry-run');
      assert.equal(dry.status, 0, dry.stderr);
      assert.equal(readFileSync(join(root, 'a.js'), 'utf8'), 'const a = 1;\n');

      const fixed = run('--root', root, '--fix-from', stamp);
      assert.equal(fixed.status, 0, fixed.stderr);
      const passed = run('--root', root);
      assert.equal(passed.status, 0, passed.stdout);
      assert.match(passed.stdout, /OK {4}a\.js/);

      assert.equal(run('--모르는옵션').status, 1);
      assert.equal(run('--fix-from').status, 1);
      assert.equal(run('--root', root, '--fix-from', join(dir, '없음.json')).status, 1);
    });
  });
});

/* ============================================================ 디버그 도구 */

describe('디버그 도구: F4 판정 부위 선', () => {
  /** writeTargetLines가 쓴 선에서 부위별 중심을 구한다. 박스 모서리와 구의 원 꼭짓점은 평균이 곧 중심이다 */
  function drawnCenters(target) {
    const volumes = hitVolumes(target.crouch);
    const total = volumes.reduce((sum, v) => sum + volumeVertexCount(v), 0);
    const buf = new Float32Array(total * 3);
    assert.equal(writeTargetLines(buf, 0, target), total * 3);
    let o = 0;
    return volumes.map((v) => {
      const count = volumeVertexCount(v);
      let x = 0, y = 0, z = 0;
      for (let i = 0; i < count; i++, o += 3) { x += buf[o]; y += buf[o + 1]; z += buf[o + 2]; }
      return { part: v.part, center: [x / count, y / count, z / count] };
    });
  }

  /** 대상의 앞(-Z) 또는 뒤에서 point를 지나 수평으로 쏜다. 다른 부위에 먼저 맞지 않는 쪽을 고른다 */
  function shoot(target, point, from) {
    const sign = from === 'front' ? -1 : 1;
    const yaw = target.yaw || 0;
    // 로컬 z축의 월드 방향 = (sin yaw, 0, cos yaw)
    const axis = [Math.sin(yaw) * sign, 0, Math.cos(yaw) * sign];
    const origin = [point[0] + axis[0] * 10, point[1], point[2] + axis[2] * 10];
    return raycastPlayers(origin, [-axis[0], 0, -axis[2]], 100, [target]);
  }

  const FROM = { head: 'front', body: 'back', legs: 'back', foot: 'back', hand: 'front' };
  const POSES = [
    { name: '서 있음, yaw 0', target: { id: 'a', pos: [0, 0, 0], yaw: 0, crouch: 0 } },
    { name: '돌아섬', target: { id: 'a', pos: [12, 3, -7], yaw: 1.1, crouch: 0 } },
    { name: '뒤로 돎', target: { id: 'a', pos: [-4, 0.5, 9], yaw: -2.6, crouch: 0 } },
    { name: '앉음(true)', target: { id: 'a', pos: [2, 0, 2], yaw: 0.7, crouch: true } },
    { name: '앉는 중', target: { id: 'a', pos: [2, 0, 2], yaw: -0.4, crouch: 0.5 } }
  ];

  // 손과 발은 physics.raycastPlayers가 부위를 돌려주기 시작해야 일치한다(DESIGN 2절)
  const physicsHasAllParts = (() => {
    const target = { id: 'a', pos: [0, 0, 0], yaw: 0 };
    const foot = hitVolumes(0).find((v) => v.part === 'foot');
    const hitsFoot = raycastPlayers([0, (foot.minY + foot.maxY) / 2, 10], [0, 0, -1], 100, [target]);
    return !!hitsFoot && hitsFoot.part === 'foot';
  })();

  for (const { name, target } of POSES) {
    test(`그린 선의 부위 중심을 쏘면 물리 판정도 같은 부위다: ${name}`, () => {
      for (const { part, center } of drawnCenters(target)) {
        if (!physicsHasAllParts && (part === 'hand' || part === 'foot')) continue;
        const res = shoot(target, center, FROM[part]);
        assert.ok(res, `${part}: 맞지 않음`);
        assert.equal(res.part, part);
      }
    });
  }

  test('yaw에 따라 손이 몸 앞쪽으로 돈다', () => {
    const handOf = (yaw) => drawnCenters({ pos: [0, 0, 0], yaw }).find((c) => c.part === 'hand').center;
    assert.ok(handOf(0)[2] < 0, '정면(-Z) 쪽');
    assert.ok(handOf(Math.PI)[2] > 0, '뒤돌면 +Z 쪽');
    assert.ok(handOf(Math.PI / 2)[0] < 0, 'yaw 90도면 -X 쪽');
  });

  test('앉으면 머리와 몸이 내려가고 발은 그대로다', () => {
    const at = (crouch) => Object.fromEntries(hitVolumes(crouch).map((v) => [v.part, v]));
    const stand = at(0), crouch = at(true), half = at(0.5);
    assert.ok(crouch.head.y < stand.head.y);
    assert.ok(Math.abs(half.head.y - (stand.head.y + crouch.head.y) / 2) < 1e-9);
    assert.ok(crouch.body.maxY < stand.body.maxY);
    assert.equal(crouch.foot.maxY, stand.foot.maxY);
    assert.deepEqual(hitVolumes(5), hitVolumes(1));
    assert.deepEqual(hitVolumes(-1), hitVolumes(0));
  });

  test('부위는 다섯 종류이고 손은 구 2개다', () => {
    const parts = hitVolumes(0).map((v) => v.part);
    assert.deepEqual(parts, ['head', 'body', 'legs', 'foot', 'hand', 'hand']);
  });
});

describe('디버그 도구: F6 충돌체 선', () => {
  const close = (a, b) => Math.abs(a - b) < 0.05;

  test('종류별 선 수와 색 이름별 개수', () => {
    const lines = buildWireLines([
      { kind: 'box', minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 },
      { kind: 'box', minX: 0, minY: -1, minZ: 0, maxX: 1, maxY: 0, maxZ: 1, tag: 'ground' },
      { kind: 'box', minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1, tag: 'clip' },
      { kind: 'box', minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1, tag: 'bounds' },
      { kind: 'cyl', x: 0, z: 0, r: 1, minX: -1, maxX: 1, minY: 0, maxY: 2, minZ: -1, maxZ: 1 },
      { kind: 'ramp', dir: '+x', minX: 0, minY: 0, minZ: 0, maxX: 2, maxY: 1, maxZ: 2 },
      null
    ], null);
    assert.deepEqual(
      { box: lines.counts.box, ground: lines.counts.ground, clip: lines.counts.clip, bounds: lines.counts.bounds, cyl: lines.counts.cyl, ramp: lines.counts.ramp, pad: lines.counts.pad },
      { box: 1, ground: 1, clip: 1, bounds: 1, cyl: 1, ramp: 1, pad: 0 }
    );
    assert.equal(lines.positions.length % 6, 0);
    assert.equal(lines.colors.length, lines.positions.length);
    assert.ok(lines.positions.every(Number.isFinite));
  });

  for (const dir of ['+x', '-x', '+z', '-z']) {
    test(`경사로 선의 높은 쪽이 physics.rampHeight와 같다: ${dir}`, () => {
      const ramp = { kind: 'ramp', dir, minX: 2, minY: 1, minZ: -3, maxX: 6, maxY: 4, maxZ: 1 };
      const { positions } = buildWireLines([ramp], null);
      let top = 0;
      for (let i = 0; i < positions.length; i += 3) {
        const x = positions[i], y = positions[i + 1], z = positions[i + 2];
        const expected = rampHeight(ramp, x, z);
        // 윗꼭짓점은 그 자리의 경사면 높이와 같고, 나머지는 바닥이다
        if (close(y, ramp.maxY)) { top++; assert.ok(close(expected, ramp.maxY), `${x},${z}`); }
        else assert.ok(close(y, ramp.minY));
      }
      assert.ok(top >= 2);
    });
  }

  test('발판·포털·비밀 스팟을 각자의 색으로 넣고 발판 궤적이 목표에 닿는다', () => {
    const triggers = {
      pads: [
        { index: 0, x: 0, y: 0, z: 0, minX: -1, maxX: 1, minZ: -1, maxZ: 1, target: [10, 2, 0], apex: 3, vel: null },
        { index: 1, x: 5, y: 1, z: 5, minX: 4, maxX: 6, minZ: 4, maxZ: 6, target: null, vel: [2, 8, 0] }
      ],
      portals: [{ index: 0, x: 0, y: 0, z: 0, minX: -1, maxX: 1, minY: 0, maxY: 2, minZ: -1, maxZ: 1, to: { x: 20, y: 5, z: -3 } }],
      secrets: [{ id: 's', minX: 0, maxX: 1, minY: 0, maxY: 1, minZ: 0, maxZ: 1 }]
    };
    const { positions, colors, counts } = buildWireLines([], triggers);
    assert.deepEqual([counts.pad, counts.portal, counts.secret], [2, 1, 1]);
    assert.ok(positions.every(Number.isFinite));
    let reachesTarget = false;
    for (let i = 0; i < positions.length; i += 3) {
      if (close(positions[i], 10) && close(positions[i + 1], 2) && close(positions[i + 2], 0)) reachesTarget = true;
    }
    assert.ok(reachesTarget, '궤적 끝이 target');
    const distinct = new Set();
    for (let i = 0; i < colors.length; i += 3) distinct.add(colors.slice(i, i + 3).join());
    assert.equal(distinct.size, 3);
  });
});

describe('디버그 도구: 키와 정리', () => {
  /** 최소한의 가짜 three.js. 만든 지오메트리·재질의 dispose를 센다 */
  function fakeThree() {
    const stats = { geometries: 0, geometriesDisposed: 0, materials: 0, materialsDisposed: 0 };
    class BufferGeometry {
      constructor() { stats.geometries++; this.attributes = {}; this.drawRange = null; }
      setAttribute(name, attr) { this.attributes[name] = attr; }
      setDrawRange(start, count) { this.drawRange = { start, count }; }
      dispose() { stats.geometriesDisposed++; }
    }
    class BufferAttribute {
      constructor(array, size) { this.array = array; this.count = array.length / size; }
      setUsage() { return this; }
    }
    class LineBasicMaterial {
      constructor() { stats.materials++; }
      dispose() { stats.materialsDisposed++; }
    }
    class LineSegments {
      constructor(geometry, material) { this.geometry = geometry; this.material = material; }
      removeFromParent() { if (this.parent) this.parent.remove(this); }
    }
    return { THREE: { BufferGeometry, BufferAttribute, LineBasicMaterial, LineSegments, DynamicDrawUsage: 35048 }, stats };
  }

  function fakeScene() {
    return {
      children: [],
      add(o) { this.children.push(o); o.parent = this; },
      remove(o) { this.children = this.children.filter((c) => c !== o); o.parent = null; }
    };
  }

  function fakeElement(tagName) {
    return {
      tagName, style: {}, children: [], textContent: '', parent: null,
      append(...nodes) { for (const n of nodes) { n.parent = this; this.children.push(n); } },
      remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; }
    };
  }

  const DOM_GLOBALS = ['window', 'document', 'requestAnimationFrame', 'cancelAnimationFrame'];
  const realGlobals = {};
  let body;

  before(() => {
    for (const name of DOM_GLOBALS) realGlobals[name] = globalThis[name];
    globalThis.window = new EventTarget();
    globalThis.requestAnimationFrame = () => 1;
    globalThis.cancelAnimationFrame = () => {};
  });
  beforeEach(() => {
    body = fakeElement('BODY');
    globalThis.document = { createElement: (tag) => fakeElement(tag.toUpperCase()), body };
  });
  after(() => {
    for (const name of DOM_GLOBALS) globalThis[name] = realGlobals[name];
  });

  /** 도구를 만들고 테스트가 실패해도 정리되게 한다 */
  function openDebug(t, ctx) {
    const debug = createDebug(ctx);
    t.after(() => debug.dispose());
    return debug;
  }

  /** F키를 누른다. target을 주면 그 요소에 포커스가 있는 것으로 친다 */
  function press(code, opts = {}) {
    const event = new Event('keydown', { cancelable: true });
    event.code = code;
    event.repeat = !!opts.repeat;
    event.ctrlKey = !!opts.ctrlKey; event.altKey = !!opts.altKey; event.metaKey = false; event.shiftKey = !!opts.shiftKey;
    if (opts.target) Object.defineProperty(event, 'target', { value: opts.target });
    window.dispatchEvent(event);
    return event;
  }

  /** 프레임 구독 수를 세는 가짜 ctx */
  function fakeCtx(extra = {}) {
    const frames = new Set();
    const scene = fakeScene();
    const { THREE, stats } = fakeThree();
    const ctx = {
      flags: { debug: true }, THREE, renderer: { scene },
      onFrame(fn) { frames.add(fn); return () => frames.delete(fn); },
      ...extra
    };
    return { ctx, frames, scene, stats, tick: (dt = 0.25) => { for (const fn of frames) fn(dt); } };
  }

  test('?debug가 꺼져 있으면 아무것도 하지 않는다', (t) => {
    openDebug(t, { flags: { debug: false } });
    assert.equal(press('F3').defaultPrevented, false);
  });

  test('ctx가 거의 비어 있어도 세 키 모두 죽지 않는다', (t) => {
    t.mock.method(console, 'warn', () => {});
    const debug = openDebug(t, { flags: { debug: true } });
    for (const code of ['F3', 'F4', 'F6']) assert.equal(press(code).defaultPrevented, true, code);
    assert.equal(body.children.length, 1, '패널은 열린다');
    assert.match(body.children[0].children[0].textContent, /디버그/);
    debug.dispose();
    assert.equal(body.children.length, 0);
    assert.equal(press('F3').defaultPrevented, false, 'dispose 뒤에는 키를 잡지 않는다');
  });

  test('ctx의 값이 이상해도 패널이 줄 단위로 버틴다', (t) => {
    const { ctx, tick } = fakeCtx({
      player: { state: { pos: null, vel: null }, getEye() { throw new Error('눈 없음'); }, getAimDir: () => [0, 0, -1] },
      map: { id: 'm', colliders: [] },
      traceShot: () => null,
      plugins: [{ name: 'game', api: { world: { get internals() { throw new Error('내부 오류'); } } } }],
      renderer: { scene: fakeScene(), info: () => ({}) }
    });
    openDebug(t, ctx);
    press('F3');
    tick();
    const text = body.children[0].children[0].textContent;
    assert.match(text, /읽기 실패: 눈 없음/);
    assert.match(text, /읽기 실패: 내부 오류/);
    assert.match(text, /map {5}m/);
  });

  test('닫혀 있으면 프레임 구독도 DOM도 장면 물체도 없다', (t) => {
    const { ctx, frames, scene, stats } = fakeCtx();
    openDebug(t, ctx);
    assert.equal(frames.size, 0);
    press('F3');
    assert.equal(frames.size, 1);
    assert.equal(body.children.length, 1);
    press('F4');
    press('F6');
    assert.equal(frames.size, 1, '여럿 열어도 구독은 하나');
    assert.equal(scene.children.length, 1, 'F6은 맵이 없으면 선을 만들지 않는다');
    press('F3'); press('F4');
    assert.equal(frames.size, 1, 'F6이 아직 켜져 있다');
    press('F6');
    assert.equal(frames.size, 0);
    assert.equal(body.children.length, 0);
    assert.equal(scene.children.length, 0);
    assert.equal(stats.geometries, stats.geometriesDisposed);
    assert.equal(stats.materials, stats.materialsDisposed);
  });

  test('dispose는 켜져 있는 것을 모두 정리하고 두 번 불러도 된다', (t) => {
    const offs = [];
    const bus = { on: (evt) => { offs.push(evt); return () => { offs.splice(offs.indexOf(evt), 1); }; } };
    const { ctx, frames, scene, stats } = fakeCtx({ bus, map: { id: 'm', colliders: [{ kind: 'box', minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 }] } });
    const debug = openDebug(t, ctx);
    assert.equal(offs.length, 3, '트리거 이벤트 구독');
    assert.deepEqual(ctx.logs, getLogs(), '__skalafps.logs로 로그 버퍼를 읽는다');
    press('F3'); press('F4'); press('F6');
    assert.equal(scene.children.length, 2);
    debug.dispose();
    debug.dispose();
    assert.equal(frames.size, 0);
    assert.equal(scene.children.length, 0);
    assert.equal(body.children.length, 0);
    assert.equal(offs.length, 0);
    assert.equal(stats.geometries, stats.geometriesDisposed);
    assert.equal(stats.materials, stats.materialsDisposed);
    assert.equal('logs' in ctx, false);
  });

  test('글자 입력 중에는 키를 가져가지 않고 조합키·반복도 토글하지 않는다', (t) => {
    const { ctx, frames } = fakeCtx();
    openDebug(t, ctx);
    for (const target of [{ tagName: 'INPUT', type: 'text' }, { tagName: 'TEXTAREA' }, { tagName: 'DIV', isContentEditable: true }, { tagName: 'SELECT' }]) {
      assert.equal(press('F3', { target }).defaultPrevented, false, target.tagName);
    }
    assert.equal(press('F4', { altKey: true }).defaultPrevented, false, 'Alt+F4');
    assert.equal(press('F3', { shiftKey: true }).defaultPrevented, false, 'Shift+F3');
    assert.equal(frames.size, 0);

    assert.equal(press('F3', { repeat: true }).defaultPrevented, true, '누르고 있어도 브라우저 찾기를 막는다');
    assert.equal(frames.size, 0, '반복은 토글하지 않는다');
    // 슬라이더·체크박스는 글자 입력이 아니다
    assert.equal(press('F3', { target: { tagName: 'INPUT', type: 'range' } }).defaultPrevented, true);
    assert.equal(frames.size, 1);
    press('F3');
    assert.equal(press('KeyW').defaultPrevented, false, '다른 키는 건드리지 않는다');
  });

  test('isTextEntry 판별', () => {
    assert.equal(isTextEntry(null), false);
    assert.equal(isTextEntry({ tagName: 'CANVAS' }), false);
    assert.equal(isTextEntry({ tagName: 'INPUT' }), true);
    assert.equal(isTextEntry({ tagName: 'INPUT', type: 'search' }), true);
    assert.equal(isTextEntry({ tagName: 'INPUT', type: 'checkbox' }), false);
  });

  test('F4 버퍼는 재사용하고 대상이 용량을 넘을 때만 늘린다', (t) => {
    const many = (n) => Array.from({ length: n }, (_, i) => ({ id: i, pos: [i, 0, 0], yaw: 0 }));
    let targets = many(2);
    const { ctx, scene, tick, stats } = fakeCtx({ getTargets: () => targets });
    openDebug(t, ctx);
    press('F4');
    const lines = scene.children[0];
    const firstBuffer = lines.geometry.attributes.position.array;
    const vertsPerTarget = hitVolumes(0).reduce((sum, v) => sum + volumeVertexCount(v), 0);
    assert.equal(lines.geometry.drawRange.count, 2 * vertsPerTarget);

    targets = many(10).concat({ id: 'dead', pos: [0, 0, 0], alive: false }, { id: 'broken' }, null);
    tick();
    assert.equal(lines.geometry.attributes.position.array, firstBuffer, '용량 안이면 같은 버퍼');
    assert.equal(lines.geometry.drawRange.count, 10 * vertsPerTarget, '죽었거나 위치가 없는 대상은 그리지 않는다');
    assert.equal(lines.geometry.attributes.position.needsUpdate, true);

    const before = stats.geometries;
    targets = many(40);
    tick();
    assert.notEqual(lines.geometry.attributes.position.array, firstBuffer);
    assert.equal(lines.geometry.drawRange.count, 40 * vertsPerTarget);
    assert.equal(stats.geometries, before + 1);
    assert.equal(stats.geometriesDisposed, before, '이전 지오메트리를 버렸다');
  });

  test('F6은 맵이 바뀌면 선을 다시 만들고 맵이 없으면 치운다', (t) => {
    const mapA = { id: 'a', colliders: [{ kind: 'box', minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 }], data: { pads: [{ x: 0, z: 0, target: [5, 0, 0] }] } };
    const mapB = { id: 'b', colliders: [], world: { triggers: { pads: [], portals: [], secrets: [] } } };
    let current = mapA;
    const { ctx, scene, tick } = fakeCtx();
    Object.defineProperty(ctx, 'map', { get: () => current });
    openDebug(t, ctx);
    press('F6');
    const first = scene.children[0];
    const firstCount = first.geometry.attributes.position.count;
    assert.ok(firstCount > 24, '충돌체 + 발판(world.triggers가 없으면 data로 만든다)');
    tick();
    assert.equal(scene.children[0], first, '같은 맵이면 그대로');
    current = mapB;
    tick();
    assert.notEqual(scene.children[0], first);
    assert.equal(scene.children[0].geometry.attributes.position.count, 0);
    current = null;
    tick();
    assert.equal(scene.children.length, 0);
    current = mapA;
    tick();
    assert.equal(scene.children[0].geometry.attributes.position.count, firstCount);
  });

  test('패널은 프레임을 세어 약 0.2초마다 갱신하고 트리거 이벤트를 보여 준다', (t) => {
    const listeners = {};
    const bus = { on: (evt, fn) => { listeners[evt] = fn; return () => {}; } };
    const pos = [1, 2, 3];
    const { ctx, tick } = fakeCtx({ bus });
    openDebug(t, ctx);
    listeners['player:pad']({ pad: { index: 2 }, pos });   // 닫혀 있는 동안의 발동도 기억한다
    pos[0] = 99;
    press('F3');
    const textOf = () => body.children[0].children[0].textContent;
    assert.match(textOf(), /trigger pad#2/);
    assert.match(textOf(), /1\.00/, '발동 순간의 위치를 복사해 둔다');
    tick(0.05);
    assert.doesNotMatch(textOf(), /fps {5}\d/);
    for (let i = 0; i < 4; i++) tick(0.05);
    assert.match(textOf(), /fps {5}20\.0 {2}frame 50\.0ms {2}max 50\.0ms/);
    listeners['player:secret']({ secret: { id: 'roof' } });
    for (let i = 0; i < 5; i++) tick(0.05);
    assert.match(textOf(), /trigger secret roof/);
  });
});
