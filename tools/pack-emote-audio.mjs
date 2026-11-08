#!/usr/bin/env node
/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 이모트 원본 음원(mp3 등)에서 한 소절을 잘라 WAV로 만들고 AES-GCM으로 묶어 audio/emotes/<id>.bin과 manifest.json을 쓴다.
 *          원본 음원은 저장소에 넣지 않는다(.gitignore). 묶음 형식과 키는 js/fx/emote-key.js.
 */
/**
 * 사용법
 *   node tools/pack-emote-audio.mjs <원본 폴더>              표의 파일을 모두 묶는다
 *   node tools/pack-emote-audio.mjs <원본 폴더> takeL veggie  고른 이모트만
 *   FFMPEG=<ffmpeg 경로> node tools/pack-emote-audio.mjs ...   ffmpeg가 PATH에 없을 때
 *
 * 원본은 같은 소절이 쉼과 함께 몇 번 반복된 파일이다. 맨 앞 한 소절(period 초, 끝의 쉼 포함)만 잘라 반복 재생 구간으로 쓴다.
 * 춤 박자(core/consts.js EMOTES[].bpm)는 이 소절 길이로 정해져 있어 소절이 바뀌면 bpm도 함께 고친다.
 */
import { spawnSync } from 'node:child_process';
import { createCipheriv, createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EMOTE_PACK, keyBytes } from '../js/fx/emote-key.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUT_DIR = join(ROOT, 'audio', 'emotes');
const MANIFEST = join(OUT_DIR, 'manifest.json');
export const PACK_RATE = 32000;    // 합성음과 같은 표본율(모노 16비트)

/** 이모트 id → 원본 파일 이름, 한 소절 길이(초). 소절 길이는 원본의 반복 주기를 잰 값이다 */
export const SOURCES = Object.freeze([
  { id: 'creamCheese', file: '01_크림치즈 허니.mp3', period: 1.8 },
  { id: 'veggie', file: '02_야채.mp3', period: 1.45 },
  { id: 'fromYou', file: '03_당신에게서.mp3', period: 1.65 },
  { id: 'takeL', file: '05_L을 가져가.mp3', period: 1.95 },
  { id: 'crissCross', file: '07_크리스 크로스.mp3', period: 1.65 },
  { id: 'selfie', file: '08_셀카.mp3', period: 1.3 }
]);

function decode(path, ffmpeg) {
  const r = spawnSync(ffmpeg, ['-v', 'error', '-i', path, '-ac', '1', '-ar', String(PACK_RATE), '-f', 'f32le', '-'], { maxBuffer: 256 << 20, windowsHide: true });
  if (r.error) throw new Error(`ffmpeg를 실행하지 못했어요(${r.error.code || r.error.message}). FFMPEG 환경 변수로 경로를 주세요.`);
  if (r.status !== 0) throw new Error(`ffmpeg 오류: ${String(r.stderr).trim()}`);
  const b = r.stdout;
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
}

/** 두 구간이 얼마나 같은가(정규화 상관). 원본이 정말 반복되는지 확인용 */
function similarity(x, a, b, n) {
  let s = 0, p = 0, q = 0;
  for (let i = 0; i < n; i++) { const u = x[a + i], v = x[b + i]; s += u * v; p += u * u; q += v * v; }
  return s / Math.sqrt(p * q + 1e-12);
}

export function wavBytes(samples, rate = PACK_RATE) {
  const data = samples.length * 2;
  const out = Buffer.alloc(44 + data);
  out.write('RIFF', 0, 'ascii'); out.writeUInt32LE(36 + data, 4); out.write('WAVE', 8, 'ascii');
  out.write('fmt ', 12, 'ascii'); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22);
  out.writeUInt32LE(rate, 24); out.writeUInt32LE(rate * 2, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34);
  out.write('data', 36, 'ascii'); out.writeUInt32LE(data, 40);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    out.writeInt16LE(Math.round(v < 0 ? v * 32768 : v * 32767), 44 + i * 2);
  }
  return out;
}

/** WAV → 묶음. IV는 내용 해시로 정한다(같은 입력 → 같은 파일) */
export function packBytes(id, plain) {
  const iv = createHash('sha256').update(`skala-emote:${id}:`).update(plain).digest().subarray(0, EMOTE_PACK.IV_BYTES);
  const c = createCipheriv('aes-256-gcm', keyBytes(), iv, { authTagLength: EMOTE_PACK.TAG_BYTES });
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([Buffer.from(EMOTE_PACK.MAGIC, 'ascii'), iv, body, c.getAuthTag()]);
}

function main(argv) {
  const [srcDir, ...only] = argv;
  if (!srcDir) {
    console.error('사용법: node tools/pack-emote-audio.mjs <원본 폴더> [이모트 id …]');
    return 2;
  }
  const ffmpeg = process.env.FFMPEG || 'ffmpeg';
  const manifest = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : {};
  let done = 0;
  for (const s of SOURCES) {
    if (only.length && !only.includes(s.id)) continue;
    const path = join(srcDir, s.file);
    if (!existsSync(path)) { console.warn(`건너뜀 ${s.id}: ${s.file} 없음`); continue; }
    const x = decode(path, ffmpeg);
    const n = Math.round(s.period * PACK_RATE);
    if (x.length < n) throw new Error(`${s.id}: 원본이 한 소절(${s.period}초)보다 짧아요`);
    const same = x.length >= n * 2 ? similarity(x, 0, n, n) : null;
    if (same !== null && same < 0.9) console.warn(`주의 ${s.id}: 두 번째 소절이 첫 소절과 다릅니다(상관 ${same.toFixed(3)}). period를 확인하세요.`);
    const plain = wavBytes(x.subarray(0, n));
    const packed = packBytes(s.id, plain);
    writeFileSync(join(OUT_DIR, `${s.id}.bin`), packed);
    manifest[s.id] = { file: `${s.id}.bin`, enc: true, loopStart: 0, loopEnd: s.period };
    console.log(`${s.id}: ${s.period}초, ${(packed.length / 1024).toFixed(0)} KB${same === null ? '' : `, 반복 상관 ${same.toFixed(3)}`}`);
    done++;
  }
  const sorted = Object.fromEntries(Object.keys(manifest).sort().map((k) => [k, manifest[k]]));
  writeFileSync(MANIFEST, JSON.stringify(sorted, null, 2) + '\n');
  console.log(`묶음 ${done}개, manifest.json 갱신`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
