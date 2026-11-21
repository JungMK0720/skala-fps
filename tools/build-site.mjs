/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 공개할 게임 파일만 골라 Cloudflare Pages 배포 폴더(dist/)를 만든다. --portal crazygames면 CrazyGames에 올릴 폴더와 zip을 만든다.
 */
/**
 * 사용법
 *   node tools/build-site.mjs                              dist/ (Cloudflare Pages)
 *   node tools/build-site.mjs --portal crazygames          dist-crazygames/ + dist-crazygames.zip (기본 출시: 광고 꺼짐)
 *   node tools/build-site.mjs --portal crazygames --ads    정식 출시(Full Launch) 제출본: 광고(중간·보상) 켬
 *
 * CrazyGames 제출본(docs/PORTAL.md):
 *   - 파일은 CrazyGames CDN(https://<게임>.game-files.crazygames.com/<게임>/<버전>/index.html)에서 열린다. 모든 경로는 상대 경로다.
 *   - index.html <head>에 SDK 스크립트 태그를 넣고, js/config.js에 portal: { id: 'crazygames', ads } 를 더한다(js/platform이 읽는다).
 *   - _headers(Pages 전용)·.nojekyll은 넣지 않는다. 문서·시험·도구·서버·dev도 넣지 않는다.
 *   - 문서 한도: 파일 1500개, 전체 250MB, 처음 받는 크기 50MB(모바일 홈 20MB). 넘으면 실패한다.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const SHIPPED = Object.freeze(['index.html', 'privacy.html', '_headers', 'css', 'js', 'audio', 'assets', 'fonts', '.nojekyll']);
/** CrazyGames 제출본에 넣는 것. 개인정보 처리방침은 계정·건의를 저장하므로 함께 둔다(문서: User Consent) */
export const PORTAL_SHIPPED = Object.freeze(['index.html', 'privacy.html', 'css', 'js', 'audio', 'assets', 'fonts']);
export const PORTAL_SDK_TAG = '<script src="https://sdk.crazygames.com/crazygames-sdk-v3.js"></script>';
/** CrazyGames 기술 요건(docs.crazygames.com/requirements/technical) */
export const PORTAL_LIMITS = Object.freeze({ files: 1500, totalBytes: 250 * 1024 * 1024, initialBytes: 50 * 1024 * 1024, mobileBytes: 20 * 1024 * 1024 });
const OPTIONAL = new Set(['assets', 'fonts', '.nojekyll']);

function copyList(root, dist, list) {
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });
  const copied = [];
  for (const file of list) {
    const source = resolve(root, file);
    if (!existsSync(source)) {
      if (OPTIONAL.has(file)) continue;
      throw new Error('필수 배포 파일이 없습니다: ' + file);
    }
    cpSync(source, resolve(dist, file), { recursive: true, dereference: true });
    copied.push(file);
  }
  return copied;
}

export function buildSite(root = ROOT) {
  return copyList(root, resolve(root, 'dist'), SHIPPED);
}

/** 폴더 안 파일 목록(상대 경로 '/' 구분, 정렬) */
export function listFiles(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listFiles(full, base));
    else out.push(relative(base, full).split(sep).join('/'));
  }
  return out;
}

/** index.html에 SDK 태그를 넣는다. 게임 코드(config.js, main.js)보다 앞, CSP meta 뒤 */
export function addSdkTag(html) {
  if (html.includes(PORTAL_SDK_TAG)) return html;
  const at = html.indexOf('<meta name="referrer"');
  if (at < 0) throw new Error('index.html에서 SDK 태그를 넣을 자리를 찾지 못했습니다');
  return html.slice(0, at) + '<!-- CrazyGames SDK v3 (tools/build-site.mjs --portal crazygames) -->\n  ' + PORTAL_SDK_TAG + '\n  ' + html.slice(at);
}

/** js/config.js에 포털 설정을 더한다 */
export function addPortalConfig(src, ads) {
  const value = `portal: { id: 'crazygames', ads: '${ads ? 'on' : 'off'}' }`;
  if (/\bportal\s*:/.test(src)) throw new Error('js/config.js에 이미 portal 설정이 있습니다');
  const next = src.replace(/\r?\n\};\s*$/, `,\n  ${value}\n};\n`);
  if (next === src) throw new Error('js/config.js의 끝(};)을 찾지 못했습니다');
  return next;
}

/**
 * CrazyGames 제출 폴더와 zip을 만든다.
 * @param {string} [root]
 * @param {{ ads?: boolean, zip?: boolean }} [opt]
 * @returns {{ dir:string, zip:string|null, files:number, bytes:number, copied:string[] }}
 */
export function buildPortal(root = ROOT, { ads = false, zip = true } = {}) {
  const dir = resolve(root, 'dist-crazygames');
  const copied = copyList(root, dir, PORTAL_SHIPPED);
  const indexPath = join(dir, 'index.html');
  writeFileSync(indexPath, addSdkTag(readFileSync(indexPath, 'utf8')));
  const configPath = join(dir, 'js', 'config.js');
  writeFileSync(configPath, addPortalConfig(readFileSync(configPath, 'utf8'), ads));
  const files = listFiles(dir);
  const bytes = files.reduce((n, f) => n + statSync(join(dir, f)).size, 0);
  if (files.length > PORTAL_LIMITS.files) throw new Error(`파일이 너무 많습니다: ${files.length} > ${PORTAL_LIMITS.files}`);
  if (bytes > PORTAL_LIMITS.totalBytes) throw new Error(`전체 크기가 한도를 넘습니다: ${bytes}`);
  let zipPath = null;
  if (zip) {
    zipPath = resolve(root, 'dist-crazygames.zip');
    writeFileSync(zipPath, makeZip(files.map((f) => ({ name: f, data: readFileSync(join(dir, f)) }))));
  }
  return { dir, zip: zipPath, files: files.length, bytes, copied };
}

/* ---------------- zip(작은 구현: deflate, zip64 없음. 4GB보다 훨씬 작은 제출본용) ---------------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * @param {{name:string, data:Buffer}[]} entries 폴더 기준 경로('/' 구분)
 * @returns {Buffer}
 */
export function makeZip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  const DOS_TIME = 0, DOS_DATE = (2026 - 1980) << 9 | 11 << 5 | 6;   // 2026-11-06: 같은 입력이면 같은 zip
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const packed = deflateRawSync(data, { level: 9 });
    const useDeflate = packed.length < data.length;
    const body = useDeflate ? packed : data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(useDeflate ? 8 : 0, 8); local.writeUInt16LE(DOS_TIME, 10); local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(useDeflate ? 8 : 0, 10); central.writeUInt16LE(DOS_TIME, 12); central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const portal = args.includes('--portal') ? args[args.indexOf('--portal') + 1] : '';
  if (!portal) console.log('dist/ 배포 파일: ' + buildSite().join(', '));
  else if (portal === 'crazygames') {
    const r = buildPortal(ROOT, { ads: args.includes('--ads') });
    const mb = (r.bytes / 1024 / 1024).toFixed(2);
    console.log(`dist-crazygames/: 파일 ${r.files}개, ${mb} MB (한도 ${PORTAL_LIMITS.files}개 · 250 MB, 처음 받는 크기 50 MB · 모바일 홈 20 MB)`);
    console.log(`광고: ${args.includes('--ads') ? '켬(정식 출시 제출본)' : '끔(기본 출시 제출본)'} · zip: ${r.zip}`);
  } else {
    console.error('알 수 없는 포털: ' + portal);
    process.exitCode = 1;
  }
}
