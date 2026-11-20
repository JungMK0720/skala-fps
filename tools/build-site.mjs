/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 공개할 게임 파일만 골라 Cloudflare Pages 배포 폴더를 만든다.
 */
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const SHIPPED = Object.freeze(['index.html', 'privacy.html', '_headers', 'css', 'js', 'audio', 'assets', 'fonts', '.nojekyll']);

export function buildSite(root = ROOT) {
  const dist = resolve(root, 'dist');
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });
  const copied = [];
  for (const file of SHIPPED) {
    const source = resolve(root, file);
    if (!existsSync(source)) {
      if (['assets', 'fonts', '.nojekyll'].includes(file)) continue;
      throw new Error('필수 배포 파일이 없습니다: ' + file);
    }
    cpSync(source, resolve(dist, file), { recursive: true, dereference: true });
    copied.push(file);
  }
  return copied;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log('dist/ 배포 파일: ' + buildSite().join(', '));
