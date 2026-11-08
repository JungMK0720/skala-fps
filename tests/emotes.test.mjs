/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 이모트 검증. 목록(번호·가격·기본 휠), 휠 정리 규칙, 춤 박자와 음원 소절의 맞물림, 합성음 박자, 음원 묶음(.bin) 형식과
 *          풀기·변조 감지, manifest가 가리키는 파일, 새 동작의 포즈 값을 확인한다.
 */
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { describe, test } from 'node:test';

import { DEFAULT_EMOTE_WHEEL, EMOTES, EMOTE_IDS, EMOTE_WHEEL, emoteByCode, normalizeEmoteWheel } from '../js/core/consts.js';
import { EMOTE_ANIM_IDS, TRACKS, emoteLength, sampleEmote } from '../js/engine/emoteanim.js';
import { EMOTE_BPM, EMOTE_SOUNDS } from '../js/fx/audio.js';
import { EMOTE_PACK, decryptEmote, isEmotePack } from '../js/fx/emote-key.js';
import { PACK_RATE, SOURCES, packBytes, wavBytes } from '../tools/pack-emote-audio.mjs';

const ROOT = new URL('../', import.meta.url);
const MANIFEST = JSON.parse(readFileSync(new URL('audio/emotes/manifest.json', ROOT), 'utf8'));
const toAB = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

describe('이모트 목록', () => {
  test('번호는 1부터 빈틈없이, 전송 칸(4비트)에 들어간다', () => {
    assert.deepEqual(EMOTES.map((e) => e.code), EMOTES.map((_, i) => i + 1));
    assert.ok(EMOTES.length <= 15);
    assert.equal(new Set(EMOTE_IDS).size, EMOTES.length);
    for (const e of EMOTES) assert.equal(emoteByCode(e.code), e);
  });

  test('L을 가져가·야채·크림치즈 허니는 기본 지급이고 처음 휠에 있다', () => {
    for (const id of ['takeL', 'veggie', 'creamCheese']) {
      const e = EMOTES.find((x) => x.id === id);
      assert.equal(e.price, 0, id);
      assert.ok(DEFAULT_EMOTE_WHEEL.includes(id), id);
    }
    assert.equal(EMOTES.find((x) => x.id === 'veggie').name, '야채');
    assert.equal(EMOTES.find((x) => x.id === 'crissCross').name, '크리스 크로스');
  });

  test('상점 이모트는 값이 있고, 기본 휠은 기본 지급 이모트 8개다', () => {
    const paid = EMOTES.filter((e) => e.price > 0).map((e) => e.id).sort();
    assert.deepEqual(paid, ['fromYou', 'selfie']);
    assert.equal(DEFAULT_EMOTE_WHEEL.length, EMOTE_WHEEL.SLOTS);
    assert.equal(new Set(DEFAULT_EMOTE_WHEEL).size, EMOTE_WHEEL.SLOTS);
    for (const id of DEFAULT_EMOTE_WHEEL) assert.equal(EMOTES.find((e) => e.id === id).price, 0, id);
    for (const e of EMOTES) assert.ok(typeof e.desc === 'string' && e.desc.length > 4, `${e.id} 설명`);
  });

  test('모든 이모트에 동작과 합성음이 있다', () => {
    assert.deepEqual([...EMOTE_ANIM_IDS], [...EMOTE_IDS]);
    assert.deepEqual([...EMOTE_SOUNDS], [...EMOTE_IDS], '합성음 순서 = 번호 순서(인덱스 + 1 = 번호)');
    for (const e of EMOTES) assert.equal(EMOTE_BPM[e.id], e.bpm, `${e.id} 합성음 박자 = 춤 박자`);
  });
});

describe('휠 정리 (normalizeEmoteWheel)', () => {
  test('기본값', () => {
    assert.deepEqual(normalizeEmoteWheel(), [...DEFAULT_EMOTE_WHEEL]);
    assert.deepEqual(normalizeEmoteWheel('broken'), [...DEFAULT_EMOTE_WHEEL]);
  });

  test('모르는 것·가지지 않은 것·겹친 것은 기본 휠로 채운다', () => {
    const got = normalizeEmoteWheel(['selfie', 'takeL', 'takeL', 7, '__proto__', 'cheer']);
    assert.equal(got.length, 8);
    assert.equal(new Set(got).size, 8);
    assert.ok(!got.includes('selfie'), '사지 않은 셀카');
    assert.equal(got[1], 'takeL');
    assert.equal(got[5], 'cheer');
  });

  test('가진 이모트는 원하는 칸에 그대로 둔다', () => {
    const owns = () => true;
    const got = normalizeEmoteWheel(['selfie', 'fromYou', 'sideToSide'], owns);
    assert.deepEqual(got.slice(0, 3), ['selfie', 'fromYou', 'sideToSide']);
    assert.equal(got.length, 8);
    assert.deepEqual(normalizeEmoteWheel([...EMOTE_IDS].reverse(), owns), [...EMOTE_IDS].reverse().slice(0, 8), '9칸째부터는 버린다');
  });
});

describe('춤과 음원의 박자', () => {
  test('음원이 있는 이모트는 한 소절에 정수 박이 들어가고, 두 소절 안에 춤 주기와 다시 맞는다', () => {
    const files = Object.keys(MANIFEST);
    assert.deepEqual(files.sort(), ['creamCheese', 'crissCross', 'fromYou', 'selfie', 'takeL', 'veggie']);
    for (const id of files) {
      const e = EMOTES.find((x) => x.id === id);
      const bar = MANIFEST[id].loopEnd - (MANIFEST[id].loopStart || 0);
      const beats = (bar * e.bpm) / 60;
      assert.ok(near(beats, Math.round(beats)), `${id}: 소절 ${bar}초 = ${beats}박`);
      const loop = TRACKS[id].beats;
      const n = Math.round(beats);
      assert.ok(n % loop === 0 || (2 * n) % loop === 0 || loop % n === 0, `${id}: 춤 ${loop}박 · 소절 ${n}박`);
    }
  });

  test('새 동작의 한 주기 길이', () => {
    assert.ok(near(emoteLength('creamCheese'), 1.8), '크림치즈 허니 = 한 소절');
    assert.ok(near(emoteLength('fromYou'), 1.65), '당신에게서 = 한 소절');
    assert.ok(near(emoteLength('selfie'), 2.6), '셀카 = 두 소절');
    assert.ok(near(emoteLength('takeL') * 2, 1.95), 'L을 가져가 = 소절의 절반');
  });

  test('새 동작의 포즈는 어느 순간이든 유한한 값이다', () => {
    for (const id of ['creamCheese', 'fromYou', 'selfie', 'takeL', 'veggie', 'crissCross']) {
      for (let t = 0; t < 6; t += 0.037) {
        const p = sampleEmote(id, t);
        assert.ok(p, `${id} ${t}`);
        for (const k of ['x', 'y', 'z', 'rx', 'ry', 'rz', 'air', 'foreR', 'foreL', 'kneeR', 'kneeL']) assert.ok(Number.isFinite(p[k]), `${id} ${k} @${t}`);
        for (const k of ['torso', 'head', 'armR', 'armL', 'legR', 'legL', 'handR', 'handL']) assert.ok(p[k].every(Number.isFinite), `${id} ${k} @${t}`);
        assert.ok(p.air >= 0 && p.air < 0.3, `${id} 공중 높이 @${t}`);
      }
    }
  });
});

describe('음원 묶음(.bin)', () => {
  const tone = (sec) => Float32Array.from({ length: Math.round(sec * PACK_RATE) }, (_, i) => 0.5 * Math.sin((i / PACK_RATE) * 2 * Math.PI * 440));

  test('묶고 풀면 같은 WAV가 나오고, 같은 입력은 같은 파일이 된다', async () => {
    const wav = wavBytes(tone(0.25));
    const a = packBytes('takeL', wav), b = packBytes('takeL', wav);
    assert.ok(a.equals(b), '결정적');
    assert.ok(!packBytes('veggie', wav).equals(a), 'id가 다르면 IV도 다르다');
    assert.equal(a.subarray(0, 4).toString('ascii'), EMOTE_PACK.MAGIC);
    assert.ok(isEmotePack(toAB(a)));
    const plain = Buffer.from(await decryptEmote(toAB(a)));
    assert.ok(plain.equals(wav));
  });

  test('바뀐 파일·형식이 다른 파일·WebCrypto가 없으면 거절한다', async () => {
    const a = packBytes('selfie', wavBytes(tone(0.1)));
    const bad = Buffer.from(a);
    bad[bad.length - 40] ^= 1;
    await assert.rejects(decryptEmote(toAB(bad)), /풀기 실패/);
    await assert.rejects(decryptEmote(toAB(Buffer.from('ID3 not a pack at all, just bytes'))), /형식/);
    await assert.rejects(decryptEmote(toAB(a), null), /WebCrypto/);
  });

  test('manifest의 파일은 모두 있고, 풀면 한 소절 길이의 WAV다', async () => {
    for (const [id, ent] of Object.entries(MANIFEST)) {
      assert.equal(ent.enc, true, `${id}는 묶음`);
      assert.match(ent.file, /^[A-Za-z0-9_]+\.bin$/);
      const url = new URL(`audio/emotes/${ent.file}`, ROOT);
      assert.ok(existsSync(url), ent.file);
      const raw = readFileSync(url);
      assert.ok(raw.length < 1024 * 1024, `${id} 1 MB 미만`);
      const wav = Buffer.from(await decryptEmote(toAB(raw)));
      assert.equal(wav.subarray(0, 4).toString('ascii'), 'RIFF');
      assert.equal(wav.subarray(8, 12).toString('ascii'), 'WAVE');
      assert.equal(wav.readUInt16LE(22), 1, '모노');
      assert.equal(wav.readUInt32LE(24), PACK_RATE);
      const sec = wav.readUInt32LE(40) / 2 / PACK_RATE;
      assert.ok(near(sec, ent.loopEnd, 1 / PACK_RATE), `${id}: ${sec}초 = loopEnd ${ent.loopEnd}`);
    }
  });

  test('묶는 도구의 표와 manifest가 같다', () => {
    for (const s of SOURCES) assert.equal(MANIFEST[s.id].loopEnd, s.period, s.id);
    assert.equal(SOURCES.length, Object.keys(MANIFEST).length);
  });
});
