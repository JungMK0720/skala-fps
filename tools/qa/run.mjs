#!/usr/bin/env node
/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 자동 플레이 테스트 실행기(npm run qa). 시나리오를 차례로 돌려 통과·실패 표를 찍고, 스크린샷은 저장소 밖 임시 폴더에 둔다.
 *          사용법: npm run qa [-- --only 이름[,이름]] [-- --filter 글자] [-- --list]
 */
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SAFE_FLAGS, findBrowser, launchBrowser, withTimeout } from './browser.mjs';
import { startServer } from './server.mjs';
import { Tester } from './kit.mjs';
import { SCENARIOS } from './scenarios/index.mjs';

function parseArgs(argv) {
  const opts = { only: null, filter: null, list: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') opts.list = true;
    else if (a === '--only') opts.only = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--filter') opts.filter = String(argv[++i] || '');
    else throw new Error(`모르는 옵션이에요: ${a}`);
  }
  return opts;
}

const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - String(s).length));
const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;

async function runOne(scenario, { browser, server, outDir, filter }) {
  const started = Date.now();
  const t = new Tester({ name: scenario.name, browser, server, outDir, filter, logLine: (line) => console.log(`[${scenario.name}] ${line}`) });
  let thrown = null;
  try {
    await withTimeout(scenario.run(t), scenario.timeoutMs || 300000, `시나리오 ${scenario.name}`);
  } catch (err) {
    thrown = err;
    t.failures.push(`중단: ${err && err.message ? err.message : err}`);
    console.log(`[${scenario.name}] 중단: ${err && err.stack ? err.stack : err}`);
    await t.shot('중단');
    if (t.page) t.errorsOk('중단 시점');
  }
  await t.closePage().catch(() => {});
  return { name: scenario.name, title: scenario.title, ok: t.failures.length === 0 && !thrown, checks: t.checks, failures: t.failures, notes: t.notes, ms: Date.now() - started };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.list) {
    for (const s of SCENARIOS) console.log(`${pad(s.name, 12)} ${s.title}`);
    return 0;
  }
  const list = opts.only ? SCENARIOS.filter((s) => opts.only.includes(s.name)) : SCENARIOS;
  if (opts.only) for (const name of opts.only) if (!SCENARIOS.some((s) => s.name === name)) throw new Error(`없는 시나리오예요: ${name}`);
  if (!findBrowser()) throw new Error('Edge나 Chrome을 찾지 못했어요. QA_BROWSER 환경 변수로 실행 파일 경로를 알려 주세요.');

  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  const outDir = join(tmpdir(), `skala-qa-${stamp}`);
  mkdirSync(outDir, { recursive: true });

  const server = await startServer();
  let browser = null;
  // 강제 종료 신호에도 브라우저를 남기지 않는다. exit 처리기가 브라우저를 없앤다
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit(130));

  const results = [];
  try {
    browser = await launchBrowser();
    console.log(`브라우저: ${browser.version} (${browser.path})`);
    console.log(`플래그: ${SAFE_FLAGS.join(' ')}`);
    console.log(`게임 주소: ${server.base}`);
    for (const scenario of list) {
      console.log(`\n=== ${scenario.name}: ${scenario.title}`);
      if (!browser.alive) {   // 앞 시나리오에서 브라우저가 죽었으면 뒤 시나리오까지 잃지 않게 새로 띄운다
        console.log('브라우저가 죽어서 새로 띄웁니다');
        await browser.close();
        browser = await launchBrowser();
      }
      results.push(await runOne(scenario, { browser, server, outDir, filter: opts.filter }));
    }
  } finally {
    if (browser) await browser.close();
    await server.close();
  }

  console.log('\n결과');
  console.log(`${pad('시나리오', 14)}${pad('결과', 6)}${pad('검사', 7)}${pad('시간', 9)}내용`);
  for (const r of results) {
    console.log(`${pad(r.name, 14)}${pad(r.ok ? 'PASS' : 'FAIL', 6)}${pad(r.checks, 7)}${pad(seconds(r.ms), 9)}${r.title}`);
  }
  const failed = results.filter((r) => !r.ok);
  for (const r of failed) {
    console.log(`\n실패 ${r.name}:`);
    for (const f of r.failures) console.log(`  - ${f}`);
  }
  const notes = results.flatMap((r) => r.notes.map((n) => `[${r.name}] ${n}`));
  if (notes.length) {
    console.log('\n참고');
    for (const n of notes) console.log(`  - ${n}`);
  }
  console.log(`\n스크린샷: ${outDir}`);
  console.log(failed.length ? `실패: ${failed.length}/${results.length}` : `통과: ${results.length}/${results.length}`);
  return failed.length ? 1 : 0;
}

main().then((code) => process.exit(code), (err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
