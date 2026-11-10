#!/usr/bin/env node
/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 연속 킬 안내 음성을 Windows 내장 한국어 음성(TTS)으로 합성하고 ffmpeg로 음 높이·음색·크기를 다듬어 audio/voice/<id>.mp3를 쓴다.
 *          녹음이나 다른 게임의 소리는 쓰지 않는다. 문장·빠르기·음 높이는 VOICE_LINES 표에 있고, 게임은 js/fx/audio.js가 이 파일을 불러 튼다.
 */
/**
 * 사용법 (Windows, ffmpeg 필요)
 *   node tools/make-voice.mjs                 표의 문장을 모두 만든다
 *   node tools/make-voice.mjs double legend   고른 문장만
 *   FFMPEG=<ffmpeg 경로> node tools/make-voice.mjs   ffmpeg가 PATH에 없을 때
 *   VOICE=<음성 이름> node tools/make-voice.mjs       기본(Microsoft Heami Desktop) 대신 다른 한국어 음성
 *
 * 순서: PowerShell(System.Speech)로 문장마다 44.1 kHz 모노 WAV를 만든다 → ffmpeg rubberband로 음 높이를 바꾸고(포먼트 유지)
 * 저역을 덜고 또렷한 대역을 올린 뒤 압축한다 → 앞뒤 무음을 자르고 짧게 페이드 → 체감 크기(LUFS)를 맞추고 넘치는 피크는
 * 리미터로 누른다 → 64 kbps 모노 mp3.
 * 이 음성은 SSML의 pitch를 무시하고 rate만 따른다. 그래서 음 높이는 ffmpeg에서 바꾼다.
 * 같은 음성과 같은 ffmpeg면 다시 만들어도 같은 파일이 나온다.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const OUT_DIR = join(ROOT, 'audio', 'voice');
export const VOICE_RATE = 44100;
const DEFAULT_VOICE = 'Microsoft Heami Desktop';
const MP3_KBPS = 64;
const PEAK = 0.89;                 // -1 dBFS. 리미터가 이 아래로 누른다
const TARGET_LUFS = -16;           // 문장마다 같은 체감 크기(+ boost)

/**
 * id(파일 이름) → 문장, 말 빠르기(1 = 보통), 음 높이(반음), 크기 덧셈(dB). 단계가 오를수록 조금 빠르고 높고 크게,
 * 전설은 느리고 낮게 말한다. id 목록은 js/fx/audio.js의 VOICE_IDS, js/game/multikill.js의 단계표와 같아야 한다(tests/multikill.test.mjs).
 */
export const VOICE_LINES = Object.freeze([
  { id: 'double', text: '더블 킬!', rate: 1.05, semitones: 0, boost: 0 },
  { id: 'triple', text: '트리플 킬!', rate: 1.08, semitones: 0.5, boost: 0.3 },
  { id: 'quadra', text: '쿼드라 킬!', rate: 1.1, semitones: 1, boost: 0.6 },
  { id: 'penta', text: '펜타 킬!', rate: 1.1, semitones: 1.5, boost: 0.9 },
  { id: 'hexa', text: '헥사 킬!', rate: 1.12, semitones: 2, boost: 1.2 },
  { id: 'legend', text: '당신은 전설입니다.', rate: 0.9, semitones: -2, boost: 1.2 }
]);

const xmlEscape = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);

/** 한 문장의 SSML. 빠르기만 prosody로 준다 */
export function ssmlOf(line) {
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="ko-KR"><prosody rate="${line.rate}">${xmlEscape(line.text)}</prosody></speak>`;
}

// 문장 목록(JSON 파일)을 받아 WAV를 쓰고, 고른 음성 이름을 한 줄 찍는다. 한글은 JSON 쪽에만 둔다(스크립트 파일 인코딩과 무관하게)
const TTS_PS1 = String.raw`param([string]$Json, [string]$Voice)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$items = Get-Content -Raw -Encoding UTF8 -LiteralPath $Json | ConvertFrom-Json
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$ko = @($s.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -eq 'ko-KR' })
if ($ko.Count -eq 0) { throw 'no ko-KR voice' }
$pick = $ko | Where-Object { $_.VoiceInfo.Name -eq $Voice } | Select-Object -First 1
if (-not $pick) { $pick = $ko[0] }
$s.SelectVoice($pick.VoiceInfo.Name)
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(44100, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
foreach ($it in $items) {
  $s.SetOutputToWaveFile($it.out, $fmt)
  $s.SpeakSsml($it.ssml)
  $s.SetOutputToNull()
}
$s.Dispose()
Write-Output $pick.VoiceInfo.Name
`;

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { maxBuffer: 256 << 20, windowsHide: true, ...opts });
  if (r.error) throw new Error(`${cmd}를 실행하지 못했어요(${r.error.code || r.error.message})`);
  if (r.status !== 0) throw new Error(`${cmd} 오류: ${String(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}

/** 문장마다 TTS WAV를 만든다. 반환: 쓴 음성 이름 */
function synthesize(lines, dir, voice) {
  const ps1 = join(dir, 'tts.ps1'), json = join(dir, 'lines.json');
  writeFileSync(ps1, TTS_PS1);
  writeFileSync(json, JSON.stringify(lines.map((l) => ({ out: join(dir, `${l.id}.tts.wav`), ssml: ssmlOf(l) }))), 'utf8');
  const out = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-Json', json, '-Voice', voice]);
  return String(out).trim().split(/\r?\n/).pop();
}

/** 음 높이(포먼트 유지) → 저역 정리 → 또렷한 대역 → 압축. 결과는 44.1 kHz 모노 float */
export function filterChain(line) {
  const pitch = Math.pow(2, line.semitones / 12).toFixed(5);
  return [
    `rubberband=pitch=${pitch}:formant=preserved:pitchq=quality`,
    'highpass=f=95',
    'equalizer=f=320:t=q:w=1.1:g=-2.5',
    'equalizer=f=2900:t=q:w=0.9:g=4',
    'equalizer=f=6800:t=q:w=1.3:g=2',
    'acompressor=threshold=0.08:ratio=3:attack=4:release=90:makeup=2'
  ].join(',');
}

function decodeFiltered(ffmpeg, wav, line) {
  const b = run(ffmpeg, ['-v', 'error', '-i', wav, '-af', filterChain(line), '-ac', '1', '-ar', String(VOICE_RATE), '-f', 'f32le', '-']);
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
}

/** 앞뒤 무음을 자르고(앞 15 ms, 뒤 80 ms 여유) 5 ms 페이드 인, 40 ms 페이드 아웃 */
export function trimAndFade(x, rate = VOICE_RATE) {
  const gate = 0.02 * peakOf(x);
  let first = -1, last = -1;
  for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > gate) { if (first < 0) first = i; last = i; }
  if (first < 0 || !(gate > 0)) throw new Error('소리가 없어요');
  const a = Math.max(0, first - Math.round(rate * 0.015)), b = Math.min(x.length, last + Math.round(rate * 0.08));
  const y = Float32Array.from(x.subarray(a, b));
  const fin = Math.round(rate * 0.005), fout = Math.round(rate * 0.04);
  for (let i = 0; i < fin && i < y.length; i++) y[i] *= i / fin;
  for (let i = 0; i < fout && i < y.length; i++) y[y.length - 1 - i] *= i / fout;
  return y;
}

export function peakOf(x) {
  let pk = 0;
  for (let i = 0; i < x.length; i++) { const a = x[i] < 0 ? -x[i] : x[i]; if (a > pk) pk = a; }
  return pk;
}

const rawOf = (y) => Buffer.from(y.buffer, y.byteOffset, y.byteLength);
const RAW_IN = ['-f', 'f32le', '-ar', String(VOICE_RATE), '-ac', '1', '-i', '-'];

/** 통합 음량(LUFS, EBU R128). ffmpeg ebur128 요약 줄에서 읽는다 */
function loudness(ffmpeg, y) {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-nostats', ...RAW_IN, '-af', 'ebur128', '-f', 'null', '-'], { input: rawOf(y), maxBuffer: 64 << 20, windowsHide: true });
  const m = /I:\s*(-?[\d.]+)\s*LUFS/.exec(String(r.stderr).split('Summary:').pop());
  if (r.status !== 0 || !m) throw new Error('음량을 재지 못했어요');
  return Number(m[1]);
}

/** 체감 크기를 목표 LUFS로 맞추고, 넘치는 피크는 리미터로 PEAK 아래에 두고 mp3로 쓴다 */
function encodeMp3(ffmpeg, y, out, lufs, target) {
  const g = Math.pow(10, (target - lufs) / 20);
  const z = Float32Array.from(y, (v) => v * g);
  run(ffmpeg, ['-v', 'error', '-y', ...RAW_IN, '-af', `alimiter=limit=${PEAK}:level=false:attack=2:release=40:latency=true`,
    '-c:a', 'libmp3lame', '-b:a', `${MP3_KBPS}k`, '-map_metadata', '-1', '-id3v2_version', '0', '-write_id3v1', '0',
    '-fflags', '+bitexact', '-flags:a', '+bitexact', out], { input: rawOf(z) });
}

function main(argv) {
  if (process.platform !== 'win32') {
    console.error('Windows의 System.Speech 음성으로 만듭니다. Windows에서 실행하세요.');
    return 2;
  }
  const only = argv.filter((a) => !a.startsWith('-'));
  for (const id of only) if (!VOICE_LINES.some((l) => l.id === id)) throw new Error(`표에 없는 id예요: ${id}`);
  const lines = VOICE_LINES.filter((l) => !only.length || only.includes(l.id));
  const ffmpeg = process.env.FFMPEG || 'ffmpeg';
  mkdirSync(OUT_DIR, { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), 'skala-voice-'));
  try {
    const voice = synthesize(lines, dir, process.env.VOICE || DEFAULT_VOICE);
    console.log(`음성: ${voice}`);
    for (const l of lines) {
      const y = trimAndFade(decodeFiltered(ffmpeg, join(dir, `${l.id}.tts.wav`), l));
      const out = join(OUT_DIR, `${l.id}.mp3`);
      const lufs = loudness(ffmpeg, y), target = TARGET_LUFS + l.boost;
      encodeMp3(ffmpeg, y, out, lufs, target);
      console.log(`${l.id}: "${l.text}" ${(y.length / VOICE_RATE).toFixed(2)}초, ${lufs.toFixed(1)} → ${target.toFixed(1)} LUFS, ${(statSync(out).size / 1024).toFixed(1)} KB`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
