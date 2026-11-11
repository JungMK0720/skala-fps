/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 전체 공지(js/net/notice.js)에 쓰는 운영자 열쇠 한 쌍을 만든다. 비밀 열쇠는 파일에만 쓰고 화면에는 찍지 않는다.
 *          공개 열쇠는 화면에 찍으니 js/config.js의 notice.key에 넣는다. 사용법: node tools/make-notice-key.mjs [--out 파일] [--force] [--public-of 파일]
 */
/**
 *   node tools/make-notice-key.mjs                       새 열쇠를 만들어 .secrets/notice-private-key.txt에 쓴다
 *   node tools/make-notice-key.mjs --out D:/keys/n.txt   비밀 열쇠 파일 자리를 바꾼다
 *   node tools/make-notice-key.mjs --force               이미 있는 파일을 덮어쓴다(전에 쓰던 열쇠로는 더 이상 공지를 보낼 수 없게 된다)
 *   node tools/make-notice-key.mjs --public-of 파일      그 비밀 열쇠 파일의 짝인 공개 열쇠만 다시 찍는다(파일은 건드리지 않는다)
 *
 * 비밀 열쇠 파일은 저장소에 올리지 않는다(.gitignore의 .secrets/). 잃어버리면 새로 만들고 js/config.js의 공개 열쇠를 바꿔 배포한다.
 * 남에게 새어 나갔을 때도 같다: 새 열쇠를 만들어 공개 열쇠를 바꾸면 옛 열쇠로 서명한 공지는 어느 화면에도 뜨지 않는다.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findNoticePrivateKey, generateNoticeKeys, importNoticePrivateKey, toBase64Url } from '../js/net/notice.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEFAULT_OUT = resolve(ROOT, '.secrets', 'notice-private-key.txt');

/** 비밀 열쇠 글자 → 짝이 되는 공개 열쇠 글자(raw 65바이트의 base64url) */
export async function publicKeyOf(privateKeyText) {
  const key = await importNoticePrivateKey(privateKeyText, { extractable: true });
  const jwk = await crypto.subtle.exportKey('jwk', key);
  const pub = await crypto.subtle.importKey('jwk', { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
  return toBase64Url(await crypto.subtle.exportKey('raw', pub));
}

/** 비밀 열쇠 파일에 쓸 글자. 열쇠는 마지막 줄 하나다 */
export function keyFileText({ publicKey, privateKey, date }) {
  return [
    'SKALA 작전 운영자 열쇠 (전체 공지 서명용)',
    '이 파일은 운영자만 가집니다. 남에게 보내거나 저장소에 올리지 마세요.',
    `만든 날: ${date}`,
    `공개 열쇠(js/config.js의 notice.key에 들어 있는 값): ${publicKey}`,
    '비밀 열쇠(아래 한 줄. 운영자 패널에서 이 파일을 고르거나 이 줄을 붙여 넣습니다):',
    privateKey,
    ''
  ].join('\n');
}

function parseArgs(argv) {
  const opts = { out: DEFAULT_OUT, force: false, publicOf: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--force') opts.force = true;
    else if (arg === '--out' || arg === '--public-of') {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} 뒤에 파일 경로가 필요합니다`);
      if (arg === '--out') opts.out = resolve(value); else opts.publicOf = resolve(value);
    } else throw new Error(`모르는 옵션입니다: ${arg}`);
  }
  return opts;
}

async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.publicOf) {
    const priv = findNoticePrivateKey(readFileSync(opts.publicOf, 'utf8'));
    if (!priv) throw new Error(`${opts.publicOf}에서 비밀 열쇠를 찾지 못했습니다`);
    console.log(`공개 열쇠: ${await publicKeyOf(priv)}`);
    return;
  }
  if (existsSync(opts.out) && !opts.force) {
    throw new Error(`${opts.out}이(가) 이미 있습니다. 그 열쇠를 계속 쓰려면 --public-of로 공개 열쇠를 확인하고, 새로 만들려면 --force를 붙이세요`);
  }
  const keys = await generateNoticeKeys();
  mkdirSync(dirname(opts.out), { recursive: true });
  writeFileSync(opts.out, keyFileText({ ...keys, date: new Date().toISOString().slice(0, 10) }), { encoding: 'utf8', mode: 0o600 });
  console.log(`비밀 열쇠 파일: ${opts.out}`);
  console.log('  (운영자만 보관합니다. 화면에는 찍지 않았습니다)');
  console.log(`공개 열쇠: ${keys.publicKey}`);
  console.log(`  js/config.js에 넣을 줄:  notice: { key: '${keys.publicKey}' }`);
}

const isMain = process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain) main().catch((err) => { console.error(`오류: ${err.message}`); process.exitCode = 1; });
