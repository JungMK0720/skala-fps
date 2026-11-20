/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 대원 모델을 시험한다. 아트 바이블의 팀 색·장비 색, 모든 캐릭터의 모양 표, GLB 파일(크기·부품·동작·디코더 없는 압축·삼각형 수),
 *          출처 기록, 두 마디 IK가 목표에 닿는지 본다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { AVATAR_IDS } from '../js/core/avatar-defs.js';
import { OPERATOR_IDS, OPERATOR_LOOK, TEAM_LOOK, GEAR_COLORS, partsOf, colorOf } from '../js/engine/operator-look.js';
import { solveTwoBone } from '../js/engine/limb-ik.js';

const GLB = new URL('../assets/models/operators/operators.glb', import.meta.url);

/** GLB의 JSON 덩어리와 바이너리 덩어리 */
function readGlb() {
  const buf = readFileSync(GLB);
  assert.equal(buf.readUInt32LE(0), 0x46546c67, 'glTF 매직');
  assert.equal(buf.readUInt32LE(4), 2, 'glTF 2.0');
  const jsonLen = buf.readUInt32LE(12);
  assert.equal(buf.readUInt32LE(16), 0x4e4f534a, 'JSON 덩어리');
  return JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
}

test('아트 바이블 색: 팀 전투복·강조색과 대원 장비 색', () => {
  assert.deepEqual(TEAM_LOOK.owner, { uniform: '#2B3A55', accent: '#3F8CFF' });
  assert.deepEqual(TEAM_LOOK.charterer, { uniform: '#5A2A2E', accent: '#FF4F5E' });
  const gear = { av_trooper: 'black', av_scout: 'olive', av_sapper: 'coyote', av_signal: 'olive', av_ranger: 'sand', av_night: 'black', av_heavy: 'darkGray' };
  for (const [id, g] of Object.entries(gear)) assert.equal(OPERATOR_LOOK[id].gear, g, id);
  for (const id of OPERATOR_IDS) {
    assert.match(colorOf(OPERATOR_LOOK[id], 'owner', 'gear'), /^#[0-9A-F]{6}$/i, id);
    assert.ok(GEAR_COLORS[OPERATOR_LOOK[id].gear], id);
  }
});

test('모든 캐릭터(core/avatar-defs.js)에 대원 모양이 있고 순서도 같다', () => {
  assert.deepEqual([...OPERATOR_IDS], [...AVATAR_IDS]);
});

test('대원 GLB: 1 MB 이하, 디코더가 필요 없는 압축, 단색, 뼈대 하나, 필요한 동작과 부품', () => {
  assert.ok(statSync(GLB).size <= 1024 * 1024, `${statSync(GLB).size} bytes`);
  const j = readGlb();
  assert.deepEqual(j.extensionsRequired || [], ['KHR_mesh_quantization'].filter((e) => (j.extensionsRequired || []).includes(e)));
  for (const e of j.extensionsUsed || []) assert.ok(['KHR_mesh_quantization'].includes(e), `디코더가 필요한 확장 ${e}`);
  assert.equal((j.images || []).length, 0, '무늬 없음');
  assert.equal(j.skins.length, 1, '뼈대 하나를 모든 메시가 함께 쓴다');
  assert.equal(j.skins[0].joints.length, 62);
  assert.deepEqual(j.animations.map((a) => a.name).sort(), ['Death', 'Idle', 'Run', 'Run_Back', 'Run_Left', 'Run_Right', 'Walk']);
  // 대원마다 쓰는 [메시, 재질] 부품이 모두 있고, 몸 삼각형이 장비를 붙일 여유를 남긴다(장비 포함 1만 개 이하)
  const prims = new Map();
  for (const m of j.meshes) for (const p of m.primitives) prims.set(`${m.name}/${j.materials[p.material].name}`, j.accessors[p.indices].count / 3);
  for (const id of OPERATOR_IDS) {
    let tris = 0;
    for (const [base, mat] of partsOf(OPERATOR_LOOK[id])) {
      assert.ok(prims.has(`${base}/${mat}`), `${id}: ${base}/${mat}`);
      tris += prims.get(`${base}/${mat}`);
    }
    assert.ok(tris <= 8000, `${id}: GLB 부품 ${tris} 삼각형`);
  }
});

test('출처 기록: 원본 해시가 빌드 도구와 같고 CC0 문구가 함께 있다', () => {
  const notes = readFileSync(new URL('../assets/models/operators/LICENSE.md', import.meta.url), 'utf8');
  const tool = readFileSync(new URL('../tools/models/build-operators.mjs', import.meta.url), 'utf8');
  const hashes = [...tool.matchAll(/'([0-9a-f]{64})'/g)].map((m) => m[1]);
  assert.equal(hashes.length, 4);
  for (const h of hashes) assert.ok(notes.includes(h), h);
  assert.match(notes, /CC0/);
  assert.match(readFileSync(new URL('../assets/models/operators/CC0-1.0.txt', import.meta.url), 'utf8'), /CC0 1\.0 Universal/);
});

test('두 마디 IK: 닿는 목표에는 정확히 닿고 마디 길이를 지키며 팔꿈치는 pole 쪽이다', () => {
  const root = [0.15, 1.38, -0.06], target = [0.13, 1.25, -0.33];
  const { mid, end, reach } = solveTwoBone(root, target, 0.174, 0.225, [0.4, -0.9, 0.15]);
  const d = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
  assert.ok(reach);
  assert.ok(d(end, target) < 1e-6);
  assert.ok(Math.abs(d(root, mid) - 0.174) < 1e-6);
  assert.ok(Math.abs(d(mid, end) - 0.225) < 1e-6);
  assert.ok(mid[1] < (root[1] + target[1]) / 2, '팔꿈치가 아래쪽');
  const far = solveTwoBone([0, 0, 0], [0, 0, -2], 0.3, 0.3, [0, -1, 0]);
  assert.equal(far.reach, false);
  assert.ok(Math.abs(d([0, 0, 0], far.end) - 0.6) < 1e-3, '닿지 않으면 곧게 편 만큼만');
});
