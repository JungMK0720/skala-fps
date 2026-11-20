/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 원본 CC0 GLB(Quaternius Ultimate Modular Men: SWAT·Business Man·Worker·Farmer)에서 대원 모델 하나를 만든다.
 *          SWAT 몸·머리·뼈·동작에 다른 인물의 맨머리·안전모·챙 넓은 모자를 같은 뼈대로 옮겨 붙이고, 안 쓰는 동작·UV를 빼고 줄인다.
 *          사용법: cd tools/models && npm install && node build-operators.mjs <원본 GLB 폴더>
 */
/*
 * 원본(assets/models/operators/LICENSE.md에 주소·받은 날짜·해시가 있다):
 *   SWAT.glb, Suit.glb(Business Man), Worker.glb, Farmer.glb — 모두 같은 62관절 뼈대(이름·순서·바인드 행렬이 같다).
 * 결과: assets/models/operators/operators.glb
 *   - 메시: Swat_Legs·Swat_Feet·Swat_Body·Swat_Head(그대로), Bare_Head(맨머리·눈·눈썹), Hardhat(안전모), Brim_Hat(챙 모자·띠)
 *   - 동작: Idle, Walk, Run, Run_Back, Run_Left, Run_Right, Death (이름 앞의 'CharacterArmature|'는 뗀다)
 *   - 위치는 float 그대로 둔다(뼈대 하나·바인드 행렬 하나를 모든 메시가 함께 쓰게). 법선·가중치만 KHR_mesh_quantization으로 줄인다
 *     → three.js GLTFLoader가 따로 디코더 없이 읽는다.
 */
import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const OUT = join(ROOT, 'assets/models/operators/operators.glb');

/** 받은 원본의 sha256(LICENSE.md와 같다). 다르면 원본이 바뀐 것이니 멈춘다 */
export const SOURCES = Object.freeze({
  'SWAT.glb': 'a835107bac833eb916c494e10997ae1709e85957ea6f6c59ace3c9a66f6d1fec',
  'Suit.glb': '82b81257c1e94cd9ee48cb1dcbe5ff506e81c9ce67cd0c5af542d8712dca546e',
  'Worker.glb': '9c28614f465b7dc105f908c20c22fc045f4b07caf8c5ef0e9f8049eceb6dd38d',
  'Farmer.glb': 'f7ae6e2596c6521d296fa5948783f1dac717807456ce5355e48719e81d15e9a6'
});
export const KEEP_CLIPS = Object.freeze(['Idle', 'Walk', 'Run', 'Run_Back', 'Run_Left', 'Run_Right', 'Death']);
/** 다른 인물에서 가져올 머리 부품: 원본 노드 → 새 메시 이름, 가져올 재질 이름 */
export const DONORS = Object.freeze([
  { file: 'Suit.glb', node: 'Suit_Head', name: 'Bare_Head', prims: ['Skin', 'Eyebrows', 'Eye'] },
  { file: 'Worker.glb', node: 'Worker_Head', name: 'Hardhat', prims: ['Worker_Yellow'] },
  { file: 'Farmer.glb', node: 'Farmer_Head', name: 'Brim_Hat', prims: ['Beige', 'Red'] }
]);

async function libs() {
  try {
    const core = await import('@gltf-transform/core');
    const { ALL_EXTENSIONS } = await import('@gltf-transform/extensions');
    const fn = await import('@gltf-transform/functions');
    return { ...core, ALL_EXTENSIONS, ...fn };
  } catch (err) {
    throw new Error('glTF-Transform가 없어요. tools/models에서 npm install을 먼저 하세요. (' + err.message + ')');
  }
}

function checkSource(dir, file) {
  const path = join(dir, file);
  const sum = createHash('sha256').update(readFileSync(path)).digest('hex');
  if (sum !== SOURCES[file]) throw new Error(`${file}의 해시가 기록과 달라요: ${sum}`);
  return path;
}

async function main(srcDir) {
  if (!srcDir) throw new Error('원본 GLB 폴더를 주세요: node build-operators.mjs <폴더>');
  const L = await libs();
  const io = new L.NodeIO().registerExtensions(L.ALL_EXTENSIONS);
  const doc = await io.read(checkSource(srcDir, 'SWAT.glb'));
  const root = doc.getRoot();
  const skin = root.listSkins()[0];
  const joints = skin.listJoints().map((j) => j.getName());
  const ibm = skin.getInverseBindMatrices().getArray();
  const parent = root.listNodes().find((n) => n.getName() === 'Swat_Head').getParentNode();

  for (const d of DONORS) {
    const src = await io.read(checkSource(srcDir, d.file));
    const sskin = src.getRoot().listSkins()[0];
    if (sskin.listJoints().map((j) => j.getName()).join() !== joints.join()) throw new Error(`${d.file}: 관절 순서가 SWAT과 달라요`);
    const sibm = sskin.getInverseBindMatrices().getArray();
    for (let i = 0; i < ibm.length; i++) if (Math.abs(ibm[i] - sibm[i]) > 1e-4) throw new Error(`${d.file}: 바인드 행렬이 SWAT과 달라요`);
    const snode = src.getRoot().listNodes().find((n) => n.getName() === d.node);
    const mesh = doc.createMesh(d.name);
    for (const p of snode.getMesh().listPrimitives()) {
      const sm = p.getMaterial();
      if (!d.prims.includes(sm.getName())) continue;
      const np = doc.createPrimitive();
      for (const sem of ['POSITION', 'NORMAL', 'JOINTS_0', 'WEIGHTS_0']) {
        const a = p.getAttribute(sem);
        np.setAttribute(sem, doc.createAccessor().setType(a.getType()).setArray(a.getArray().slice()).setNormalized(a.getNormalized()));
      }
      np.setIndices(doc.createAccessor().setType('SCALAR').setArray(p.getIndices().getArray().slice()));
      np.setMaterial(doc.createMaterial(`${d.name}_${sm.getName()}`).setBaseColorFactor(sm.getBaseColorFactor()).setRoughnessFactor(1).setMetallicFactor(0));
      mesh.addPrimitive(np);
    }
    if (mesh.listPrimitives().length !== d.prims.length) throw new Error(`${d.file}: 필요한 재질(${d.prims.join(',')})을 다 찾지 못했어요`);
    parent.addChild(doc.createNode(d.name).setMesh(mesh).setSkin(skin)
      .setTranslation(snode.getTranslation()).setRotation(snode.getRotation()).setScale(snode.getScale()));
  }

  // 안 쓰는 동작은 채널·샘플러까지 지운다(애니메이션만 지우면 그 데이터가 파일에 남는다)
  for (const a of root.listAnimations()) {
    const name = a.getName().split('|').pop();
    if (KEEP_CLIPS.includes(name)) { a.setName(name); continue; }
    for (const c of a.listChannels()) c.dispose();
    for (const s of a.listSamplers()) s.dispose();
    a.dispose();
  }
  // 무늬(텍스처)가 없는 단색 모델이라 UV는 쓰지 않는다
  for (const m of root.listMeshes()) for (const p of m.listPrimitives()) p.setAttribute('TEXCOORD_0', null);

  await doc.transform(
    L.weld(),
    L.resample({ tolerance: 1e-4 }),
    L.dedup(),
    L.prune({ keepLeaves: false }),
    L.quantize({ pattern: /^(NORMAL|WEIGHTS_0)$/, quantizeNormal: 8, quantizeWeight: 8, cleanup: true }),
    L.prune({ keepLeaves: false })
  );
  const got = root.listAnimations().map((a) => a.getName()).sort();
  if (got.join() !== [...KEEP_CLIPS].sort().join()) throw new Error('동작 목록이 달라요: ' + got.join());
  writeFileSync(OUT, await io.writeBinary(doc));
  console.log(`${OUT}: ${statSync(OUT).size} bytes, clips ${got.join(', ')}`);
}

main(process.argv[2]).catch((err) => { console.error(err.message || err); process.exitCode = 1; });
