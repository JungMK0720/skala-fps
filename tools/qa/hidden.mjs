#!/usr/bin/env node
/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: npm run qa를 화면을 건드리지 않게 돌린다. Windows에서는 보이지 않는 별도 데스크톱(tools/qa/run-hidden.ps1)에서 실행해
 *          브라우저를 닫을 때 잠깐 뜨는 콘솔 창 등이 작업 중인 창의 포커스·마우스를 가져가지 않는다. 다른 OS에서는 그냥 run.mjs를 돈다.
 *          사용: npm run qa:hidden -- --only damage   (인자는 npm run qa와 같다. 진행 기록은 그대로 이 창에 이어서 찍는다)
 */
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, openSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const RUN = join(ROOT, 'tools', 'qa', 'run.mjs');
const args = process.argv.slice(2);

/** cmd.exe 배치 파일에 넣을 인자. 따옴표·특수 문자는 큰따옴표로 감싸고 %는 두 번 적는다 */
const cmdArg = (a) => (/^[\w.,:/\\=+-]+$/.test(a) ? a : `"${a.replace(/"/g, '""').replace(/%/g, '%%')}"`);

function runPlain() {
  const child = spawn(process.execPath, [RUN, ...args], { cwd: ROOT, stdio: 'inherit' });
  child.on('exit', (code) => { process.exitCode = code ?? 1; });
}

function runHidden() {
  const dir = mkdtempSync(join(tmpdir(), 'skala-qa-hidden-'));
  const log = join(dir, 'qa.log');
  const bat = join(dir, 'qa.cmd');
  writeFileSync(log, '');
  writeFileSync(bat, `@echo off\r\n"${process.execPath}" "${RUN}" ${args.map(cmdArg).join(' ')}\r\n`);
  const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(ROOT, 'tools', 'qa', 'run-hidden.ps1'),
    '-Cwd', ROOT, '-Log', log, '-Script', bat], { stdio: ['ignore', 'ignore', 'inherit'], windowsHide: true });
  // 기록 파일을 따라 읽어 이 창에 찍는다
  let pos = 0;
  const buf = Buffer.alloc(64 * 1024);
  const pump = () => {
    if (!existsSync(log)) return;
    const size = statSync(log).size;
    if (size <= pos) return;
    const fd = openSync(log, 'r');
    try {
      while (pos < size) {
        const n = readSync(fd, buf, 0, Math.min(buf.length, size - pos), pos);
        if (n <= 0) break;
        process.stdout.write(buf.subarray(0, n));
        pos += n;
      }
    } finally { closeSync(fd); }
  };
  const timer = setInterval(pump, 500);
  ps.on('exit', (code) => {
    clearInterval(timer);
    pump();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 지워지지 않으면 임시 폴더에 남는다 */ }
    process.exitCode = code ?? 1;
  });
}

if (process.platform === 'win32') runHidden();
else runPlain();
