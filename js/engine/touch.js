/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 휴대폰용 터치 조작. 왼쪽 화면 조이스틱, 오른쪽 화면 시점, 발사·조준·점프·앉기·장전·이모트·점수판·일시정지 버튼을 만들어 input.touch로 넘긴다.
 *          키보드·마우스와 같은 입력 상태와 이벤트로 바꾸므로 게임 코드는 터치를 몰라도 된다. 화면 규칙은 css/touch.css에 있다.
 */
import { isStickSide, knobOffset, stickState } from './touch-logic.js';

/** 버튼 정의: [동작, 글자, 묶음]. act는 살아 있을 때만 보이는 전투 버튼이고 top은 언제나 보인다 */
const BUTTONS = [
  ['fire', '발사', 'act'],
  ['zoom', '조준', 'act'],
  ['jump', '점프', 'act'],
  ['reload', '장전', 'act'],
  ['crouch', '앉기', 'act'],
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

  /* ---------- 버튼 ---------- */
  const held = new Map();   // pointerId → { act, x, y }

  function press(act) {
    switch (act) {
      case 'fire': t.fire(true); break;
      case 'zoom': t.zoom(true); break;
      case 'jump': t.jump(true); break;
      case 'reload': t.reload(); break;
      case 'crouch': buttons.get('crouch').classList.toggle('is-on', t.crouchToggle()); break;
      case 'score': t.scoreboard(true); break;
      case 'emote': input.openEmoteWheel(); break;
      case 'pause': input.exitLock(); break;
      default: break;
    }
  }
  function release(act) {
    switch (act) {
      case 'fire': t.fire(false); break;
      case 'zoom': t.zoom(false); break;
      case 'jump': t.jump(false); break;
      case 'score': t.scoreboard(false); break;
      case 'emote': input.closeEmoteWheel(true); break;
      default: break;
    }
  }
  function onButtonDown(e) {
    const b = e.target.closest('.pc-tb');
    if (!b) return;
    if (e.cancelable) e.preventDefault();
    e.stopPropagation();
    if (held.has(e.pointerId)) return;
    held.set(e.pointerId, { act: b.dataset.act, x: e.clientX, y: e.clientY });
    b.classList.add('is-down');
    try { b.setPointerCapture(e.pointerId); } catch (err) { /* 이미 끝난 포인터 */ }
    press(b.dataset.act);
  }
  function onButtonMove(e) {
    const h = held.get(e.pointerId);
    if (!h) return;
    const dx = e.clientX - h.x, dy = e.clientY - h.y;
    h.x = e.clientX; h.y = e.clientY;
    if (h.act === 'fire') t.look(dx, dy);                       // 쏘면서 손가락을 끌어 조준한다
    else if (h.act === 'emote') input.moveEmoteWheel(dx, dy, false);
  }
  function onButtonUp(e) {
    const h = held.get(e.pointerId);
    if (!h) return;
    held.delete(e.pointerId);
    buttons.get(h.act).classList.remove('is-down');
    release(h.act);
  }
  layer.addEventListener('pointerdown', onButtonDown);
  layer.addEventListener('pointermove', onButtonMove);
  layer.addEventListener('pointerup', onButtonUp);
  layer.addEventListener('pointercancel', onButtonUp);

  /* ---------- HUD 위의 누를 수 있는 것: 무기 칸과 안내 줄 ---------- */
  function onHudDown(e) {
    const target = e.target && e.target.closest ? e.target : null;
    if (!target) return;
    const slot = target.closest('.sk-slot');
    if (slot && input.locked) {
      e.preventDefault();
      t.slot([...slot.parentElement.children].indexOf(slot) + 1);
      return;
    }
    if (target.closest('.sk-hint')) {
      e.preventDefault();
      if (input.locked) t.drop();
      else input.requestLock();
    }
  }
  document.addEventListener('pointerdown', onHudDown, true);

  /* ---------- 보이고 숨기기 ---------- */
  function clearPointers() {
    if (stick.id != null) endStick();
    look.id = null;
    for (const [id, h] of held) { held.delete(id); buttons.get(h.act).classList.remove('is-down'); release(h.act); }
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
    bus.on('screen:change', (e) => {
      document.documentElement.classList.toggle('pc-ingame', !!(e && gameScreens.has(e.to)));
    }),
    // 키보드가 붙은 기기: 앉기 상태가 바뀌면 버튼도 맞춘다(죽거나 스폰하면 입력이 풀린다)
    bus.on('input:crouch', (e) => { buttons.get('crouch').classList.toggle('is-on', !!(e && e.down)); }),
  ];

  return {
    layer,
    dispose() {
      for (const off of offs) if (typeof off === 'function') off();
      canvas.removeEventListener('pointerdown', onCanvasDown);
      canvas.removeEventListener('pointermove', onCanvasMove);
      canvas.removeEventListener('pointerup', onCanvasUp);
      canvas.removeEventListener('pointercancel', onCanvasUp);
      document.removeEventListener('pointerdown', onHudDown, true);
      document.removeEventListener('pointerup', onPointerUp, true);
      document.removeEventListener('gesturestart', onGesture);
      layer.remove();
      rotate.remove();
      document.documentElement.classList.remove('pc-touch', 'pc-ingame');
    }
  };
}
