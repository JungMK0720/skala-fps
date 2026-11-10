/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 연속 킬 규칙(5초 안에 이어지는 킬, 단계 이름, 7킬부터 전설)과, 단계표·안내 음성·그림의 id가 서로 맞는지,
 *          음성 파일(audio/voice/*.mp3)이 저장소에 있는지 확인한다.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MULTI_KILL_TIERS, MULTI_KILL_WINDOW_MS, createMultiKill, multiKillTier } from '../js/game/multikill.js';
import { VOICE_IDS, SOUND_NAMES } from '../js/fx/audio.js';
import { MULTI_KILL_ART, multiKillPalette } from '../js/ui/multikill.js';
import { multiKillSpec, MULTI_KILL_MS } from '../js/ui/hud.js';
import { VOICE_LINES, filterChain, ssmlOf } from '../tools/make-voice.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ids = MULTI_KILL_TIERS.map((t) => t.id);

describe('multiKillTier', () => {
  test('1킬 이하는 단계가 없다', () => {
    for (const n of [0, 1, -3, NaN, null, undefined, '1']) assert.equal(multiKillTier(n), null, String(n));
  });

  test('2~6킬은 더블 킬~헥사 킬', () => {
    assert.deepEqual([2, 3, 4, 5, 6].map((n) => multiKillTier(n).title), ['더블 킬!', '트리플 킬!', '쿼드라 킬!', '펜타 킬!', '헥사 킬!']);
    for (const n of [2, 3, 4, 5, 6]) assert.equal(multiKillTier(n).count, n);
  });

  test('7킬부터는 모두 당신은 전설입니다', () => {
    for (const n of [7, 8, 12, 99]) {
      const t = multiKillTier(n);
      assert.equal(t.id, 'legend');
      assert.equal(t.title, '당신은 전설입니다');
    }
  });
});

describe('createMultiKill', () => {
  test('앞 킬에서 5초 안이면 이어지고 딱 5초도 이어진다', () => {
    const m = createMultiKill();
    assert.equal(m.kill(1000), 1);
    assert.equal(m.kill(1000 + 4999), 2);
    assert.equal(m.kill(1000 + 4999 + MULTI_KILL_WINDOW_MS), 3);
    assert.equal(m.count, 3);
  });

  test('5초를 넘기면 1부터 다시 센다', () => {
    const m = createMultiKill();
    m.kill(0); m.kill(2000);
    assert.equal(m.kill(2000 + MULTI_KILL_WINDOW_MS + 1), 1);
    assert.equal(m.kill(2000 + MULTI_KILL_WINDOW_MS + 2), 2);
  });

  test('창은 첫 킬이 아니라 바로 앞 킬부터 잰다', () => {
    const m = createMultiKill();
    let t = 0, n = 0;
    for (let i = 0; i < 10; i++) { n = m.kill(t); t += 4500; }
    assert.equal(n, 10, '4.5초 간격으로 열 번이면 열 킬이 이어진다');
    assert.equal(multiKillTier(n).id, 'legend');
  });

  test('reset 뒤에는 처음부터, 시계가 거꾸로 가면 이어지지 않는다', () => {
    const m = createMultiKill();
    m.kill(0); m.kill(100);
    m.reset();
    assert.equal(m.count, 0);
    assert.equal(m.kill(200), 1);
    assert.equal(m.kill(50), 1, '앞 킬보다 이른 시각');
    assert.equal(m.kill(NaN), 1, '숫자가 아닌 시각은 무시');
  });

  test('창 길이를 바꿀 수 있다', () => {
    const m = createMultiKill({ windowMs: 1000 });
    m.kill(0);
    assert.equal(m.kill(1500), 1);
  });
});

describe('단계표 · 안내 음성 · 그림의 id', () => {
  test('단계 id = 안내 음성 id = 음성 문장표 id = 그림 id', () => {
    assert.deepEqual([...VOICE_IDS], ids);
    assert.deepEqual(VOICE_LINES.map((l) => l.id), ids);
    assert.deepEqual(Object.keys(MULTI_KILL_ART).sort(), [...ids].sort());
  });

  test('안내 음성은 화면 글자와 같은 말을 한다', () => {
    const bare = (s) => s.replace(/[!.\s]/g, '');
    for (const t of MULTI_KILL_TIERS) {
      const line = VOICE_LINES.find((l) => l.id === t.id);
      assert.equal(bare(line.text), bare(t.title), t.id);
    }
  });

  test('그림의 탄환 수는 킬 수와 같다(전설 제외)', () => {
    for (const t of MULTI_KILL_TIERS) if (t.id !== 'legend') assert.equal(MULTI_KILL_ART[t.id].n, t.count, t.id);
    assert.equal(multiKillPalette('없는 id'), MULTI_KILL_ART.double);
    assert.equal(multiKillPalette('__proto__'), MULTI_KILL_ART.double);
  });

  test('효과음 multi_kill · legend_kill이 있다', () => {
    assert.ok(SOUND_NAMES.includes('multi_kill'));
    assert.ok(SOUND_NAMES.includes('legend_kill'));
  });
});

describe('음성 파일(audio/voice)', () => {
  for (const id of VOICE_IDS) {
    test(`${id}.mp3가 있고 mp3 프레임으로 시작한다`, () => {
      const path = join(ROOT, 'audio', 'voice', `${id}.mp3`);
      const size = statSync(path).size;
      assert.ok(size > 2048 && size < 64 * 1024, `크기 ${size}`);
      const b = readFileSync(path);
      assert.ok(b[0] === 0xff && (b[1] & 0xe0) === 0xe0, '프레임 동기 바이트(태그 없이 바로 소리)');
    });
  }

  test('음성 만들기: SSML은 문장을 이스케이프하고 빠르기만 준다', () => {
    const s = ssmlOf({ text: '<A&B>', rate: 1.1 });
    assert.ok(s.includes('&lt;A&amp;B&gt;') && s.includes('rate="1.1"') && !s.includes('pitch'));
    assert.ok(filterChain({ semitones: 12 }).startsWith('rubberband=pitch=2.00000:formant=preserved'));
    assert.ok(filterChain({ semitones: 0 }).startsWith('rubberband=pitch=1.00000'));
  });
});

describe('hud multiKillSpec', () => {
  test('글자가 없으면 그리지 않는다', () => {
    for (const v of [null, undefined, 3, 'x', {}, { id: 'double' }, { title: '' }]) assert.equal(multiKillSpec(v), null);
  });

  test('모르는 그림 id는 더블 킬 그림, 전설은 더 오래 보인다', () => {
    assert.equal(multiKillSpec({ id: 'zzz', title: 'A' }).id, 'double');
    assert.equal(multiKillSpec({ id: 'constructor', title: 'A' }).id, 'double');
    assert.deepEqual(multiKillSpec({ id: 'triple', title: '트리플 킬!' }), { id: 'triple', title: '트리플 킬!', sub: '', ms: MULTI_KILL_MS.tier });
    assert.deepEqual(multiKillSpec({ id: 'legend', title: '당신은 전설입니다', sub: '7연속 처치' }), { id: 'legend', title: '당신은 전설입니다', sub: '7연속 처치', ms: MULTI_KILL_MS.legend });
    assert.ok(MULTI_KILL_MS.legend > MULTI_KILL_MS.tier);
  });
});
