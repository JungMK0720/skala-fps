/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 휴대폰용 터치 조작. 왼쪽 화면 조이스틱, 오른쪽 화면 시점, 발사·조준·점프·앉기·장전·이모트·채팅·점수판·일시정지 버튼을 만들어 input.touch로 넘긴다.
 *          키보드·마우스와 같은 입력 상태와 이벤트로 바꾸므로 게임 코드는 터치를 몰라도 된다. 화면 규칙은 css/touch.css에 있다.
 *          라이플을 들면 조준 버튼이 '조준 사격'이 된다(누르는 동안 조준하며 쏜다, 판단은 game/world.js의 touch:aimFire).
 *          이모트 버튼은 누른 채 끌어 고르거나, 짧게 눌러 휠을 열어 두고 칸을 눌러 고른다. 채팅 버튼은 멀티플레이 경기에서만 보인다(session의 chat:available).
 *          폭파 미션의 설치/해체 버튼(PC의 E)은 평소에 숨어 있다가 World가 touch:use { on, label }을 보낼 때만 보인다. 누르고 있는 동안 input.touch.use(true),
 *          떼면 use(false)이고, 누르는 중에 숨으면 그 자리에서 뗀다.
 */
import { EMOTE_WHEEL } from '../core/consts.js';
import { TOUCH, isStickSide, knobOffset, stickState, wheelTapAt } from './touch-logic.js';

/** 버튼 정의: [동작, 글자, 묶음]. act는 살아 있을 때만 보이는 전투 버튼이고 top은 언제나 보인다(채팅은 멀티플레이 경기에서만, 설치/해체는 touch:use가 켤 때만) */
const BUTTONS = [
  ['fire', '발사', 'act'],
  ['zoom', '조준', 'act'],
  ['jump', '점프', 'act'],
  ['reload', '장전', 'act'],
  ['crouch', '앉기', 'act'],
  ['use', '설치', 'act'],
  ['chat', '채팅', 'top'],
  ['emote', '이모트', 'top'],
  ['score', '점수', 'top'],
  ['pause', 'Ⅱ', 'top'],
];

function make(tag, cls, parent, text) {
  const el = document.createElement(tag);
  el.className = cls;
  if (text != null) el.textContent = text;
  if (parent) parent.append(el);
  return el;
}

/**
 * @param {{ input, bus, canvas: HTMLElement, root: HTMLElement, gameScreens: Set<string> }} o
 * @returns {{ layer: HTMLElement, dispose(): void }}
 */
export function createTouchControls({ input, bus, canvas, root, gameScreens }) {
  const t = input.touch;
  document.documentElement.classList.add('pc-touch');
  // 두 손가락 확대와 길게 누르기 메뉴가 게임을 끊지 않게 한다. iOS Safari는 viewport 설정을 무시해 gesture 이벤트로도 막는다
  const onGesture = (e) => e.preventDefault();
  document.addEventListener('gesturestart', onGesture);

  const layer = make('div', 'pc-touch-layer', root);
  layer.hidden = true;
  const stickBase = make('div', 'pc-stick', layer);
  const stickKnob = make('div', 'pc-stick-knob', stickBase);
  const rotate = make('div', 'pc-rotate', root);
  make('div', 'pc-rotate-ico', rotate, '📱');
  make('div', 'pc-rotate-txt', rotate, '휴대폰을 가로로 돌려 주세요');

  const buttons = new Map();
  for (const [act, label, group] of BUTTONS) {
    const b = make('button', `pc-tb pc-tb--${act} pc-tb-${group}`, layer, label);
    b.type = 'button';
    b.dataset.act = act;
    buttons.set(act, b);
  }
  buttons.get('chat').hidden = true;   // 멀티플레이 경기에서만 쓴다
  buttons.get('use').hidden = true;    // 폭파 미션에서 구역 안이나 폭탄 근처일 때만(touch:use)

  /* ---------- 왼쪽 조이스틱 · 오른쪽 시점 ---------- */
  const stick = { id: null, x: 0, y: 0 };
  const look = { id: null, x: 0, y: 0 };

  function moveStick(dx, dy) {
    t.stick(stickState(dx, dy));
    const k = knobOffset(dx, dy);
    stickKnob.style.transform = `translate(${k.x}px, ${k.y}px)`;
  }
  function endStick() {
    stick.id = null;
    t.stick(stickState(0, 0));
    stickKnob.style.transform = '';
    stickBase.classList.remove('is-held');
    stickBase.style.left = '';
    stickBase.style.top = '';
  }
  function onCanvasDown(e) {
    if (!input.locked) return;     // 잠기기 전의 터치는 click으로 조작을 시작한다
    if (e.cancelable) e.preventDefault();
    // 죽어 있으면 발사 버튼이 숨어 있다. 화면을 누르면 PC의 좌클릭처럼 관전 대상을 바꾼다
    if (layer.classList.contains('is-dead')) { t.fire(true); t.fire(false); return; }
    if (stick.id == null && isStickSide(e.clientX, window.innerWidth)) {
      stick.id = e.pointerId; stick.x = e.clientX; stick.y = e.clientY;
      stickBase.classList.add('is-held');
      stickBase.style.left = `${e.clientX}px`;
      stickBase.style.top = `${e.clientY}px`;
    } else if (look.id == null) {
      look.id = e.pointerId; look.x = e.clientX; look.y = e.clientY;
    } else return;
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* 이미 끝난 포인터 */ }
  }
  function onCanvasMove(e) {
    if (e.pointerId === stick.id) moveStick(e.clientX - stick.x, e.clientY - stick.y);
    else if (e.pointerId === look.id) {
      t.look(e.clientX - look.x, e.clientY - look.y);
      look.x = e.clientX; look.y = e.clientY;
    }
  }
  function onCanvasUp(e) {
    if (e.pointerId === stick.id) endStick();
    else if (e.pointerId === look.id) look.id = null;
  }
  canvas.addEventListener('pointerdown', onCanvasDown);
  canvas.addEventListener('pointermove', onCanvasMove);
  canvas.addEventListener('pointerup', onCanvasUp);
  canvas.addEventListener('pointercancel', onCanvasUp);

  /* ---------- 이모트 휠 ----------
   * 누른 채 끌어 칸을 고르고 떼면 시작한다(PC의 B와 같다). 짧게 눌렀다 떼면 휠이 열린 채로 남는다(탭 모드):
   * 칸을 누르면 그 이모트, 가운데를 누르거나 이모트 버튼을 다시 누르면 닫기. 휠 밖을 누르면 닫고 그 손가락은 원래 조작으로 간다. */
  let wheelTap = false;
  let wheelIdle = null;
  function endWheelTap() {
    wheelTap = false;
    if (wheelIdle) { clearTimeout(wheelIdle); wheelIdle = null; }
  }
  function closeWheel(pick) {
    endWheelTap();
    input.closeEmoteWheel(pick);
  }
  /** 이모트 버튼을 뗐다: 끌어서 칸을 골랐으면 시작, 그냥 눌렀다 뗐으면 휠을 열어 둔다 */
  function releaseEmote(h) {
    if (h.closer) return;                          // 열어 둔 휠을 닫은 누름이다
    const w = input.emoteWheel;
    if (!w.open) return;
    if (h.moved > TOUCH.EMOTE_TAP_SLOP || w.selected != null || layer.classList.contains('is-dead')) { closeWheel(true); return; }
    wheelTap = true;
    input.setEmoteWheelTap(true);
    wheelIdle = setTimeout(() => { wheelIdle = null; if (wheelTap) closeWheel(false); }, TOUCH.EMOTE_TAP_IDLE_MS);
  }
  /** 탭 모드 휠을 누른 손가락. 무기 칸(onHudDown)이나 버튼보다 먼저 받아, 휠 위를 누른 손가락은 다른 조작이 되지 않는다 */
  function onWheelTap(e) {
    if (!wheelTap) return;
    const target = e.target && e.target.closest ? e.target : null;
    if (target && target.closest('.pc-tb--emote')) return;   // 이모트 버튼은 onButtonDown이 닫는다
    const wheelEl = root.querySelector('.sk-emo-wheel');
    const hit = wheelTapAt(e.clientX, e.clientY, wheelEl ? wheelEl.getBoundingClientRect() : null);
    if (hit.kind === 'outside') { closeWheel(false); return; }
    if (e.cancelable) e.preventDefault();
    e.stopImmediatePropagation();
    if (hit.kind === 'hub') { closeWheel(false); return; }
    input.moveEmoteWheel(hit.ux * EMOTE_WHEEL.RADIUS, hit.uy * EMOTE_WHEEL.RADIUS, true);
    closeWheel(true);
  }
  document.addEventListener('pointerdown', onWheelTap, true);

  /* ---------- 버튼 ---------- */
  const held = new Map();   // pointerId → { act, x, y, moved, closer }

  function press(act) {
    switch (act) {
      case 'fire': t.fire(true); break;
      case 'zoom': t.zoom(true); break;
      case 'jump': t.jump(true); break;
      case 'reload': t.reload(); break;
      case 'crouch': buttons.get('crouch').classList.toggle('is-on', t.crouchToggle()); break;
      case 'use': t.use(true); break;
      case 'score': t.scoreboard(true); break;
      case 'emote': input.openEmoteWheel(); break;
      case 'chat': t.chat(); break;
      case 'pause': input.exitLock(); break;
      default: break;
    }
  }
  function release(act) {
    switch (act) {
      case 'fire': t.fire(false); break;
      case 'zoom': t.zoom(false); break;
      case 'jump': t.jump(false); break;
      case 'use': t.use(false); break;
      case 'score': t.scoreboard(false); break;
      default: break;
    }
  }
  /** 이 동작의 버튼을 누르고 있는 손가락을 모두 뗀 것으로 친다(버튼이 숨을 때) */
  function releaseHeld(act) {
    for (const [id, h] of held) {
      if (h.act !== act) continue;
      held.delete(id);
      buttons.get(act).classList.remove('is-down');
      release(act);
    }
  }
  function onButtonDown(e) {
    const b = e.target.closest('.pc-tb');
    if (!b) return;
    if (e.cancelable) e.preventDefault();
    e.stopPropagation();
    if (held.has(e.pointerId)) return;
    const h = { act: b.dataset.act, x: e.clientX, y: e.clientY, moved: 0, closer: false };
    held.set(e.pointerId, h);
    b.classList.add('is-down');
    try { b.setPointerCapture(e.pointerId); } catch (err) { /* 이미 끝난 포인터 */ }
    if (h.act === 'emote' && wheelTap) { h.closer = true; closeWheel(false); return; }
    press(h.act);
  }
  function onButtonMove(e) {
    const h = held.get(e.pointerId);
    if (!h) return;
    const dx = e.clientX - h.x, dy = e.clientY - h.y;
    h.x = e.clientX; h.y = e.clientY;
    h.moved += Math.hypot(dx, dy);
    if (h.act === 'fire' || h.act === 'zoom') t.look(dx, dy);  // 쏘거나 조준하면서 손가락을 끌어 겨눈다
    else if (h.act === 'emote' && !h.closer) input.moveEmoteWheel(dx, dy, false);
  }
  function onButtonUp(e) {
    const h = held.get(e.pointerId);
    if (!h) return;
    held.delete(e.pointerId);
    buttons.get(h.act).classList.remove('is-down');
    if (h.act === 'emote') releaseEmote(h);
    else release(h.act);
  }
  layer.addEventListener('pointerdown', onButtonDown);
  layer.addEventListener('pointermove', onButtonMove);
  layer.addEventListener('pointerup', onButtonUp);
  layer.addEventListener('pointercancel', onButtonUp);

  /* ---------- HUD 위의 누를 수 있는 것: 무기 칸과 안내 줄 ----------
   * 무기 칸을 누르면 그 무기를 꺼내고, 주무기·보조무기 칸을 0.45초 길게 누르면 꺼낸 총을 버린다(PC의 G). */
  const LONG_PRESS_MS = 450;
  let slotPress = null;   // { id, timer }
  function cancelSlotPress(e) {
    if (!slotPress || (e && e.pointerId !== slotPress.id)) return;
    clearTimeout(slotPress.timer);
    slotPress = null;
  }
  function onHudDown(e) {
    const target = e.target && e.target.closest ? e.target : null;
    if (!target) return;
    const slot = target.closest('.sk-slot');
    if (slot && input.locked) {
      e.preventDefault();
      const n = [...slot.parentElement.children].indexOf(slot) + 1;
      t.slot(n);
      cancelSlotPress();
      if (n === 1 || n === 2) {
        slotPress = { id: e.pointerId, timer: setTimeout(() => { slotPress = null; if (input.locked) t.drop(); }, LONG_PRESS_MS) };
      }
      return;
    }
    if (target.closest('.sk-hint')) {
      e.preventDefault();
      if (input.locked) t.drop();
      else input.requestLock();
    }
  }
  document.addEventListener('pointerdown', onHudDown, true);
  document.addEventListener('pointerup', cancelSlotPress, true);
  document.addEventListener('pointercancel', cancelSlotPress, true);

  /* ---------- 보이고 숨기기 ---------- */
  function clearPointers() {
    if (stick.id != null) endStick();
    look.id = null;
    for (const [id, h] of held) {
      held.delete(id);
      buttons.get(h.act).classList.remove('is-down');
      if (h.act !== 'emote') release(h.act);
    }
    if (input.emoteWheel.open) closeWheel(false);   // 끌던 휠도, 열어 둔 휠도 고르지 않고 닫는다
    endWheelTap();
    buttons.get('crouch').classList.remove('is-on');
  }
  /** 전체 화면과 가로 고정을 시도한다. 사용자 입력 안에서만 되고, iPhone Safari처럼 못 하는 기기는 그냥 넘어간다 */
  function goFullscreen() {
    const el = document.documentElement;
    if (document.fullscreenElement || !el.requestFullscreen || !document.fullscreenEnabled) return;
    let p;
    try { p = el.requestFullscreen({ navigationUI: 'hide' }); } catch (err) { return; }
    if (p && p.then) {
      p.then(() => {
        const o = window.screen && window.screen.orientation;
        if (o && o.lock) o.lock('landscape').catch(() => {});
      }, () => {});
    }
  }
  // 손을 뗄 때가 사용자 입력으로 인정된다
  const onPointerUp = () => { if (input.locked) goFullscreen(); };
  document.addEventListener('pointerup', onPointerUp, true);

  const offs = [
    bus.on('input:lock', (e) => {
      const on = !!(e && e.locked);
      layer.hidden = !on;
      if (!on) clearPointers();
    }),
    bus.on('player:death', () => { layer.classList.add('is-dead'); clearPointers(); }),
    bus.on('player:spawn', () => { layer.classList.remove('is-dead'); }),
    // 라이플: 조준 버튼을 누르는 동안 조준하며 자동으로 쏜다. 버튼 글자로 알린다
    bus.on('touch:aimFire', (e) => {
      const on = !!(e && e.on);
      const b = buttons.get('zoom');
      b.classList.toggle('is-aimfire', on);
      b.textContent = on ? '조준 사격' : '조준';
    }),
    bus.on('screen:change', (e) => {
      document.documentElement.classList.toggle('pc-ingame', !!(e && gameScreens.has(e.to)));
    }),
    // 키보드가 붙은 기기: 앉기 상태가 바뀌면 버튼도 맞춘다(죽거나 스폰하면 입력이 풀린다)
    bus.on('input:crouch', (e) => { buttons.get('crouch').classList.toggle('is-on', !!(e && e.down)); }),
    // 휠이 어떤 이유로든 닫히면(Esc·잠금 풀림·코드) 탭 모드도 끝난다
    bus.on('input:emoteWheel', (e) => { if (!(e && e.open)) endWheelTap(); }),
    // 채팅은 멀티플레이 경기에서만 있다(game/session.js가 경기에 들어가고 나올 때 알린다)
    bus.on('chat:available', (e) => { buttons.get('chat').hidden = !(e && e.on); }),
    // 폭파 미션: 설치·해체할 수 있을 때만 버튼을 보인다(World). 글자는 '설치'·'해체'처럼 World가 정하고, 누르는 중에 숨으면 뗀다
    bus.on('touch:use', (e) => {
      const b = buttons.get('use');
      const on = !!(e && e.on);
      const label = e && typeof e.label === 'string' && e.label ? e.label : '설치';
      if (b.textContent !== label) b.textContent = label;
      if (b.hidden !== on) return;
      b.hidden = !on;
      if (!on) releaseHeld('use');
    }),
  ];

  return {
    layer,
    dispose() {
      for (const off of offs) if (typeof off === 'function') off();
      canvas.removeEventListener('pointerdown', onCanvasDown);
      canvas.removeEventListener('pointermove', onCanvasMove);
      canvas.removeEventListener('pointerup', onCanvasUp);
      canvas.removeEventListener('pointercancel', onCanvasUp);
      document.removeEventListener('pointerdown', onWheelTap, true);
      endWheelTap();
      document.removeEventListener('pointerdown', onHudDown, true);
      document.removeEventListener('pointerup', cancelSlotPress, true);
      document.removeEventListener('pointercancel', cancelSlotPress, true);
      cancelSlotPress();
      document.removeEventListener('pointerup', onPointerUp, true);
      document.removeEventListener('gesturestart', onGesture);
      layer.remove();
      rotate.remove();
      document.documentElement.classList.remove('pc-touch', 'pc-ingame');
    }
  };
}
