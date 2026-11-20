/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 이모트 검증. 목록(번호·가격·기본 휠), 휠 정리 규칙, 춤 박자와 합성음 루프의 맞물림, 외부 음원이 없는지,
 *          새 동작의 길이와 포즈 값을 확인한다.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { DEFAULT_EMOTE_WHEEL, EMOTES, EMOTE_IDS, EMOTE_WHEEL, emoteByCode, normalizeEmoteWheel } from '../js/core/consts.js';
import { EMOTE_ANIM_IDS, TRACKS, emoteLength, fk, sampleEmote } from '../js/engine/emoteanim.js';
import { EMOTE_BPM, EMOTE_LOOP_BEATS, EMOTE_SOUNDS } from '../js/fx/audio.js';

const ROOT = new URL('../', import.meta.url);
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
/** 이름·동작을 새로 만든 이모트(id는 저장 데이터 때문에 그대로) */
const REDONE = ['takeL', 'veggie', 'sideToSide', 'crissCross', 'tango', 'creamCheese', 'fromYou', 'selfie'];

describe('이모트 목록', () => {
  test('번호는 1부터 빈틈없이, 전송 칸(4비트)에 들어간다', () => {
    assert.deepEqual(EMOTES.map((e) => e.code), EMOTES.map((_, i) => i + 1));
    assert.ok(EMOTES.length <= 15);
    assert.equal(new Set(EMOTE_IDS).size, EMOTES.length);
    for (const e of EMOTES) assert.equal(emoteByCode(e.code), e);
  });

  test('작전 성공·무전 확인·수신호는 기본 지급이고 처음 휠에 있다', () => {
    for (const id of ['takeL', 'veggie', 'creamCheese']) {
      const e = EMOTES.find((x) => x.id === id);
      assert.equal(e.price, 0, id);
      assert.ok(DEFAULT_EMOTE_WHEEL.includes(id), id);
    }
    assert.equal(EMOTES.find((x) => x.id === 'veggie').name, '무전 확인');
    assert.equal(EMOTES.find((x) => x.id === 'crissCross').name, '몸풀기');
  });

  test('다른 게임 이모트의 이름은 쓰지 않는다', () => {
    const old = ['L을 가져가', '야채', '사이드 스텝', '크리스 크로스', '탱고', '크림치즈 허니', '당신에게서', '셀카'];
    for (const e of EMOTES) {
      assert.ok(!old.includes(e.name), `${e.id}: ${e.name}`);
      assert.ok(!old.some((n) => e.desc.includes(n)), `${e.id} 설명`);
    }
    assert.equal(new Set(EMOTES.map((e) => e.name)).size, EMOTES.length, '이름이 겹치지 않는다');
  });

  test('상점 이모트는 값이 있고, 기본 휠은 기본 지급 이모트 8개다', () => {
    const paid = EMOTES.filter((e) => e.price > 0).map((e) => e.id).sort();
    assert.deepEqual(paid, ['fromYou', 'selfie']);
    assert.equal(EMOTES.find((e) => e.id === 'fromYou').price, 600, '서버 가격표와 같은 값');
    assert.equal(EMOTES.find((e) => e.id === 'selfie').price, 400, '서버 가격표와 같은 값');
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
    assert.ok(!got.includes('selfie'), '사지 않은 깃발 흔들기');
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

describe('춤과 합성음의 박자', () => {
  test('반복형 이모트의 합성음 루프는 춤 한 주기의 정수 배라서 돌 때마다 다시 맞는다', () => {
    for (const e of EMOTES) {
      const loop = EMOTE_LOOP_BEATS[e.id];
      if (!e.loop) { assert.equal(loop, 0, `${e.id} 한 번형`); continue; }
      const dance = TRACKS[e.id].beats;
      assert.ok(Number.isInteger(loop) && loop > 0, `${e.id}: 루프 ${loop}박`);
      assert.equal(loop % dance, 0, `${e.id}: 루프 ${loop}박 · 춤 ${dance}박`);
    }
  });

  test('외부 음원을 읽지 않는다(이모트 음악은 모두 합성음)', () => {
    const src = readFileSync(new URL('js/fx/audio.js', ROOT), 'utf8');
    assert.ok(!src.includes('audio/emotes'), 'audio.js가 이모트 음원 폴더를 보지 않는다');
    assert.ok(!existsSync(new URL('js/fx/emote-key.js', ROOT)), '음원 묶음 풀기 코드 없음');
    assert.ok(!existsSync(new URL('audio/emotes/manifest.json', ROOT)), '음원 목록 없음');
  });

  test('새 동작의 한 주기 길이', () => {
    const expect = { takeL: [4, 120], veggie: [4, 100], sideToSide: [4, 116], crissCross: [8, 96], tango: [4, 112], creamCheese: [8, 104], fromYou: [8, 84], selfie: [8, 92] };
    for (const [id, [beats, bpm]] of Object.entries(expect)) {
      assert.equal(EMOTES.find((e) => e.id === id).bpm, bpm, `${id} bpm`);
      assert.equal(TRACKS[id].beats, beats, `${id} 박 수`);
      assert.ok(near(emoteLength(id), (beats * 60) / bpm), `${id} 길이`);
    }
  });

  test('새 동작의 포즈는 어느 순간이든 유한한 값이고, 발은 바닥 근처에 있다', () => {
    for (const id of REDONE) {
      for (let t = 0; t < 12; t += 0.037) {
        const p = sampleEmote(id, t);
        assert.ok(p, `${id} ${t}`);
        for (const k of ['x', 'y', 'z', 'rx', 'ry', 'rz', 'air', 'foreR', 'foreL', 'kneeR', 'kneeL']) assert.ok(Number.isFinite(p[k]), `${id} ${k} @${t}`);
        for (const k of ['torso', 'head', 'armR', 'armL', 'legR', 'legL', 'handR', 'handL']) assert.ok(p[k].every(Number.isFinite), `${id} ${k} @${t}`);
        assert.ok(p.air >= 0 && p.air < 0.3, `${id} 공중 높이 @${t}`);
        const f = fk(p);
        assert.ok(Math.min(f.soleR[1], f.soleL[1]) > -0.03, `${id} 발이 바닥 아래로 꺼지지 않는다 @${t}`);
      }
    }
  });
});
