/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 시나리오 13. 무작위 입력을 실제 경기에 쏟아붓는다(이동, 점프, 앉기, 사격, 줌, 재장전, 교체, 이모트, 점수판, 일시정지, 무기 선택). 어떤 조합에서도 예외가 없고 게임이 계속 도는지 본다.
 *          난수는 시드로 고정해 실패를 다시 만들 수 있게 한다.
 */
import { LOW_QUALITY, openGame, richProfile, sleep, waitRun } from '../kit.mjs';

const RUN_MS = 45000;
const MOVE_KEYS = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft', 'KeyC', 'ControlLeft'];

function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 화면 상태에 맞춰 사람이 할 법한 조작으로 게임 화면으로 돌아온다 */
async function recover(page, w, h) {
  const s = await page.eval(`({ pause: __qa.ui.isVisible('pause'), results: __qa.ui.isVisible('results'), loadout: __qa.ui.isVisible('loadout'), compact: !!document.querySelector('.sk-loadout.is-compact'), locked: __qa.ctx.input.locked, cursor: __qa.ui.needsCursor(), screen: __qa.ctx.screen })`);
  if (s.results) { await page.click('.sk-res-actions .sk-btn--primary'); return 'restart'; }
  if (s.pause) { await page.click('.sk-pause-btns .sk-btn--primary'); return 'resume'; }
  if (s.loadout && !s.compact) { await page.press('Digit1'); return 'pick'; }
  if (!s.locked && !s.cursor) { await page.mouseClick(w / 2, h / 2); return 'lock'; }
  return null;
}

async function monkey(t, page, rng, { width, height }) {
  const held = new Set();
  const counts = {};
  let x = width / 2, y = height / 2;
  const end = Date.now() + RUN_MS;
  const pick = (list) => list[Math.floor(rng() * list.length)];
  while (Date.now() < end) {
    const fixed = await recover(page, width, height);
    if (fixed) counts[fixed] = (counts[fixed] || 0) + 1;
    const r = rng();
    if (r < 0.28) {
      const code = pick(MOVE_KEYS);
      if (held.has(code)) { held.delete(code); await page.key(code, 'up'); } else { held.add(code); await page.key(code, 'down'); }
    } else if (r < 0.5) {
      x = Math.max(40, Math.min(width - 40, x + (rng() - 0.5) * 200));
      y = Math.max(40, Math.min(height - 40, y + (rng() - 0.5) * 80));
      await page.mouseMove(x, y);
    } else if (r < 0.65) {
      await page.mouseDown(0, x, y);
      await sleep(30 + rng() * 300);
      await page.mouseUp(0, x, y);
    } else if (r < 0.75) {
      await page.mouseDown(2, x, y);
      await sleep(30 + rng() * 400);
      await page.mouseUp(2, x, y);
    } else if (r < 0.85) {
      await page.press(pick(['Digit1', 'Digit2', 'Digit3', 'Digit4', 'KeyR', 'KeyF']));
    } else if (r < 0.89) {
      await page.wheel(rng() < 0.5 ? 120 : -120, x, y);
    } else if (r < 0.92) {
      await page.key('Tab', 'down');
      await sleep(100);
      await page.key('Tab', 'up');
    } else if (r < 0.96) {
      await page.key('KeyB', 'down');
      x = Math.max(40, Math.min(width - 40, x + (rng() - 0.5) * 300));
      await page.mouseMove(x, y);
      await sleep(80);
      await page.key('KeyB', 'up');
    } else if (r < 0.98) {
      await page.eval('document.exitPointerLock()');
      counts.unlock = (counts.unlock || 0) + 1;
    } else {
      await page.press('Escape');
    }
    await sleep(15 + rng() * 80);
  }
  for (const code of held) await page.key(code, 'up');
  return counts;
}

/** 무작위 입력이 끝난 뒤 사람이 이어서 할 조작이 그대로 먹는지 본다. 키가 눌린 채 남거나 입력이 막혔으면 여기서 드러난다 */
async function stillPlayable(page, w, h) {
  const out = { jumped: false, moved: false };
  const end = Date.now() + 60000;
  const pos = () => page.eval('__qa.ctx.player.state.pos.slice()');
  while (Date.now() < end && !(out.jumped && out.moved)) {
    await recover(page, w, h);
    await sleep(150);
    const ready = await page.eval(`!!(__qa.run && __qa.run.phase === 'live' && __qa.world.localAlive && __qa.ctx.input.locked && __qa.ctx.input.enabled && !__qa.ui.needsCursor() && __qa.ctx.player.state.onGround && !__qa.ctx.player.state.frozen)`);
    if (!ready) continue;   // 쓰러졌거나 라운드 사이면 다음 기회를 기다린다
    if (!out.jumped) {
      const before = await page.eval(`__qa.busCount('player:jump')`);
      await page.press('Space');
      await sleep(250);
      out.jumped = (await page.eval(`__qa.busCount('player:jump')`)) > before;
    }
    if (!out.moved) {
      // 벽을 보고 있을 수 있으니 앞뒤로 다 해 본다
      for (const code of ['KeyW', 'KeyS']) {
        const p0 = await pos();
        await page.key(code, 'down');
        await sleep(350);
        await page.key(code, 'up');
        const p1 = await pos();
        if (Math.hypot(p1[0] - p0[0], p1[2] - p0[2]) > 0.1) out.moved = true;
      }
    }
  }
  return out;
}

export default {
  name: 'monkey',
  title: '무작위 입력을 쏟아부어도 예외 없이 도는가',
  timeoutMs: 6 * 60 * 1000,
  async run(t) {
    const size = { width: 640, height: 360 };
    const cases = [
      ['nexus', 'classic', 'ffa', 3, 11],
      ['dojo', 'knife', 'team', 2, 22],
      ['longshot', 'sniper', 'ffa', 2, 33],
      ['alley', 'classic', 'team', 2, 44]
    ].filter((c) => !t.filter || c.join(' ').includes(t.filter));
    for (const [mapId, ruleset, mode, bots, seed] of cases) {
      t.setSection(`${mapId} ${ruleset} ${mode}`);
      const page = await openGame(t, `sandbox=${mapId}&ruleset=${ruleset}&mode=${mode}&bots=${bots}&killtarget=8`, { profile: richProfile(), settings: LOW_QUALITY, ...size, screen: 'sandbox' });
      await waitRun(page);
      await page.mouseMove(size.width / 2, size.height / 2);
      const counts = await monkey(t, page, mulberry32(seed), size);
      const tick0 = await page.eval('__qa.ctx.loop.tick');
      await sleep(600);
      const state = await page.eval(`({ tick: __qa.ctx.loop.tick, screen: __qa.ctx.screen, run: !!__qa.run, phase: __qa.run && __qa.run.phase, hp: __qa.ctx.player.state.hp, weapon: __qa.arsenal.getWeapon().id, shots: __qa.worldCount('fire'), pads: __qa.busCount('player:pad'), jumps: __qa.busCount('player:jump'), kills: __qa.match.filter((e) => e.type === 'kill').length, emote: __qa.ctx.player.state.emote })`);
      t.log(`   ${JSON.stringify(state)} 복구 ${JSON.stringify(counts)}`);
      t.check(state.tick > tick0, '게임 루프가 계속 돈다', state);
      t.check(state.screen === 'sandbox' || state.screen === 'menu', '화면 상태가 정상이다', state);
      t.check(state.shots > 0, '입력이 실제로 게임에 들어갔다', state);
      const after = await stillPlayable(page, size.width, size.height);
      t.check(after.jumped, '무작위 입력 뒤에도 점프가 먹는다', after);
      t.check(after.moved, '무작위 입력 뒤에도 움직인다', after);
      await t.shot(`${mapId}-after`);
      t.errorsOk(`${mapId} 무작위 입력`);
    }
  }
};
