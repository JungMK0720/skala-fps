/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 입력(Pointer Lock·키보드·마우스·휠·터치)을 폴링 상태와 bus 이벤트로 바꾼다. 이동·점프·앉기·무기 키와 이모트 휠을 다룬다.
 */
/**
 * SKALA 작전 — 입력 (Pointer Lock · 키보드 · 마우스 · 휠)
 *
 *   const input = createInput({ element: canvas, bus, settings, touch });   // touch = 휴대폰 조작(engine/touch.js가 input.touch로 넣는다)
 *   input.state.forward / back / left / right / jump / walk / crouch / fire / aim / scoreboard   (boolean, 폴링용)
 *   input.consumeLook() → { dx, dy }  // 라디안 (감도·lookScale 적용됨, invertY 반영). 프레임마다 1번 호출
 *   input.requestLock() / exitLock() / isLocked()
 *   input.setLookScale(s)  // 줌 중 감도 배율 (무기 모듈)
 *   input.resetAim()       // 토글 모드 줌을 강제로 해제 (예: 저격 후 자동 줌 해제)
 *   input.setEnabled(bool) // 메뉴 등에서 게임 입력 끄기
 *   input.setTouchZoomHold(b) // 터치 조준 버튼을 '누르는 동안 조준'으로 (라이플 조준 사격, world가 켜고 끔). 끄면 켜고 끄는 방식
 *   input.emoteWheel       // { open, cursor:{x,y}, selected, id, code } (이모트 휠 폴링용)
 *   input.setEmoteWheel(ids) // 휠 8칸의 이모트 id(12시부터 시계 방향, 계정 장비). 모르는 id는 빼고, 비면 기본 휠
 *   input.emoteWheelIds    // 지금 휠의 이모트 id 목록(복사본)
 *   input.setEmoteLock(b)  // 이모트 중: 좌·우클릭을 사격·줌 대신 input:emoteCancel로 (player가 켜고 끔)
 *
 * 키는 e.code 기준(한/영 상태와 무관): WASD(+화살표) · Space · Shift · Ctrl/C(앉기) · R · F(무기 살펴보기) · G(들고 있는 총 버리기) · 1~4 · Tab · Esc
 * Space: input.state.jump = 누르는 동안 true(player가 착지 즉시 다시 뛰는 데 쓴다), input:jump는 누른 순간 1번.
 *        잠금을 잃거나 창 포커스를 잃으면 풀리고, 키 반복으로는 다시 켜지지 않는다.
 * bus 이벤트: input:lock{locked} · input:fire{down} · input:aim{active,source} · input:zoom{down}(터치 조준 버튼) · input:reload · input:inspect · input:drop · input:slot{slot}
 *            input:cycle{dir} · input:jump · input:walk{down} · input:crouch{down} · input:scoreboard{open} · input:menu{reason}
 *            input:key{code,down} (모든 키, 반복 제외)
 *            input:emoteWheel{open,cursor,selected,id,code,cancelled?} · input:emotePick{id,code,selected} · input:emoteCancel{reason}
 *
 * 이모트 휠(MODES.md 4.2): B를 누르고 있는 동안 열림. 그동안 시점은 멈추고 마우스 이동은 가상 커서(px, 화면 중앙 기준,
 * y 아래로 +)로 간다(잠금이 없으면 실제 커서 위치). 커서는 EMOTE_WHEEL.RADIUS 테두리에서 멈추고, DEADZONE(40px)을
 * 벗어나면 12시부터 시계 방향 8칸 중 하나가 selected(0..7). B를 떼면 input:emotePick { id(없으면 null) }.
 * 휠이 열린 동안 좌클릭 = 강조된 칸 바로 고르기, 우클릭·Esc = 고르지 않고 닫기(cancelled:true). 사격·줌은 하지 않는다.
 *
 * 앉기: 왼·오른 Ctrl 또는 C를 누르고 있는 동안. Pointer Lock 중에는 Ctrl 조합 키의 브라우저 기본 동작
 * (Ctrl+S·D·R·A·Space·휠 확대 등)을 막는다. Ctrl+W·T·N·Tab은 브라우저가 먼저 가져가서 막을 수 없다
 * → C 키를 권장하고, main.js가 경기 중 beforeunload 확인을 건다. 전체 화면(Fullscreen API)에서는
 * navigator.keyboard.lock()으로 게임 키를 잠가 Ctrl 조합도 게임이 받는다(크로뮴 계열).
 *
 * 터치 모드: 휴대폰에는 Pointer Lock이 없으니 requestLock·exitLock이 잠금 상태만 바꾼다. input:lock·input:menu는 PC와 똑같이 나가서 게임 코드는 그대로다.
 * 탭 뒤에 브라우저가 흉내 내는 마우스 이벤트가 사격이 되지 않게 마우스 입력은 무시한다. 줌은 누를 때마다 켜고 끄는 방식으로 고정한다.
 */
import { MOUSE, DEFAULT_EMOTE_WHEEL, EMOTE_WHEEL, emoteById, emoteSlotAt } from '../core/consts.js';
import { TOUCH } from './touch-logic.js';

const MOVE_KEYS = {
  KeyW: 'forward', ArrowUp: 'forward',
  KeyS: 'back', ArrowDown: 'back',
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right'
};
const SLOT_KEYS = { Digit1: 1, Digit2: 2, Digit3: 3, Digit4: 4, Numpad1: 1, Numpad2: 2, Numpad3: 3, Numpad4: 4 };
const CROUCH_KEYS = new Set(['ControlLeft', 'ControlRight', 'KeyC']);
/** 전체 화면에서 Keyboard Lock으로 잡을 키(Esc는 빼서 전체 화면·잠금 해제가 그대로 되게) */
const LOCK_KEYS = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyC', 'KeyR', 'KeyF', 'KeyG', 'Space', 'Tab', 'Digit1', 'Digit2', 'Digit3', 'Digit4',
  'ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];

function isTyping(e) {
  const t = e.target;
  if (!t || t === document.body) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
}

export function createInput({ element, bus, settings, touch = false } = {}) {
  const el = element || document.body;
  const state = { forward: false, back: false, left: false, right: false, jump: false, walk: false, crouch: false, fire: false, aim: false, scoreboard: false, emoteWheel: false };
  const wheel = { open: false, x: 0, y: 0, selected: null };
  let wheelIds = DEFAULT_EMOTE_WHEEL.slice();   // 칸 → 이모트 id (world가 계정 장비로 맞춘다)
  let emoteLock = false;
  const crouchDown = new Set(); // 눌린 앉기 키(Ctrl·C 중 하나라도 눌려 있으면 앉음)
  let lookX = 0, lookY = 0;
  let locked = false;
  let enabled = true;
  let lookScale = 1;
  let lastWheel = 0;
  const emit = (evt, data) => { if (bus) bus.emit(evt, data); };
  let touchZoomHold = false;   // 터치 조준 버튼: false = 누를 때마다 켜고 끔, true = 누르는 동안(라이플 조준 사격)
  const zoomMode = () => (touch ? (touchZoomHold ? 'hold' : 'toggle') : (settings && settings.get('zoomMode')) || 'hold');

  function setAim(active, source = 'user') {
    if (state.aim === active) return;
    state.aim = active;
    emit('input:aim', { active, source });
  }

  function syncCrouch() {
    const v = crouchDown.size > 0;
    if (state.crouch === v) return;
    state.crouch = v;
    emit('input:crouch', { down: v });
  }

  /* ---------- 이모트 휠 ---------- */
  function wheelPayload(extra) {
    const sel = wheel.selected, e = sel == null ? null : emoteById(wheelIds[sel]) || null;
    return Object.assign({ open: wheel.open, cursor: { x: Math.round(wheel.x), y: Math.round(wheel.y) }, selected: sel, id: e ? e.id : null, code: e ? e.code : 0 }, extra || null);
  }
  let pendingWheel = null;
  function openWheel() {
    if (wheel.open) return;
    if (pendingWheel) { wheelIds = pendingWheel.length ? pendingWheel : DEFAULT_EMOTE_WHEEL.slice(); pendingWheel = null; }
    wheel.open = true; wheel.x = 0; wheel.y = 0; wheel.selected = null;
    state.emoteWheel = true;
    lookX = lookY = 0;
    emit('input:emoteWheel', wheelPayload());
  }
  function moveWheel(x, y, absolute) {
    if (absolute) { wheel.x = x; wheel.y = y; } else { wheel.x += x; wheel.y += y; }
    const R = EMOTE_WHEEL.RADIUS, d = Math.hypot(wheel.x, wheel.y);
    if (d > R) { wheel.x *= R / d; wheel.y *= R / d; }
    wheel.selected = emoteSlotAt(wheel.x, wheel.y, Math.min(EMOTE_WHEEL.SLOTS, wheelIds.length));
    emit('input:emoteWheel', wheelPayload());
  }
  /** 휠 닫기. pick = true면 input:emotePick(선택 없으면 id null)도 낸다 */
  function closeWheel(pick, extra) {
    if (!wheel.open) return;
    wheel.open = false;
    state.emoteWheel = false;
    const payload = wheelPayload(Object.assign({ open: false }, extra || null));
    emit('input:emoteWheel', payload);
    if (pick) emit('input:emotePick', { id: payload.id, code: payload.code, selected: payload.selected });
  }

  function releaseAll() {
    closeWheel(false, { cancelled: true });
    for (const k of ['forward', 'back', 'left', 'right', 'jump', 'walk']) state[k] = false;
    crouchDown.clear();
    syncCrouch();
    if (state.fire) { state.fire = false; emit('input:fire', { down: false }); }
    if (state.aim) setAim(false, 'release');
    if (state.scoreboard) { state.scoreboard = false; emit('input:scoreboard', { open: false }); }
    lookX = lookY = 0;
  }

  function onKeyDown(e) {
    if (isTyping(e)) return;
    const code = e.code;
    if (!e.repeat) emit('input:key', { code, down: true });
    if (code === 'Escape') {
      if (wheel.open) { closeWheel(false, { cancelled: true }); return; }
      // 터치 조작의 잠금은 가상이라 브라우저가 풀어 주지 않는다. 키보드를 붙인 태블릿은 Esc로 직접 푼다(→ 일시정지)
      if (locked && touch) { exitLock(); return; }
      if (!locked) emit('input:menu', { reason: 'esc' });
      return;
    }
    if (code === 'Tab') {
      e.preventDefault();
      if (enabled && !state.scoreboard) { state.scoreboard = true; emit('input:scoreboard', { open: true }); }
      return;
    }
    if (!enabled) return;
    // 게임 중 Ctrl 조합(앉아서 움직이기 등)은 브라우저 기본 동작을 막는다(막을 수 있는 것만: Ctrl+W·T·N·Tab은 불가)
    if (locked && e.ctrlKey) e.preventDefault();
    if (CROUCH_KEYS.has(code)) { crouchDown.add(code); syncCrouch(); return; }
    const mv = MOVE_KEYS[code];
    if (mv) { state[mv] = true; if (locked) e.preventDefault(); return; }
    if (e.repeat) { if (code === 'Space') e.preventDefault(); return; }
    if (code === 'Space') { e.preventDefault(); state.jump = true; emit('input:jump', {}); return; }
    if (code === 'ShiftLeft' || code === 'ShiftRight') { state.walk = true; emit('input:walk', { down: true }); return; }
    if (code === 'KeyR') { emit('input:reload', {}); return; }
    if (code === 'KeyF') { if (locked) e.preventDefault(); emit('input:inspect', {}); return; }
    if (code === 'KeyG') { if (locked) e.preventDefault(); emit('input:drop', {}); return; }
    if (code === 'KeyB') { openWheel(); return; }
    const slot = SLOT_KEYS[code];
    if (slot) { emit('input:slot', { slot }); return; }
  }

  function onKeyUp(e) {
    const code = e.code;
    emit('input:key', { code, down: false });
    if (code === 'Tab') {
      e.preventDefault();
      if (state.scoreboard) { state.scoreboard = false; emit('input:scoreboard', { open: false }); }
      return;
    }
    if (CROUCH_KEYS.has(code)) { crouchDown.delete(code); syncCrouch(); return; }
    if (code === 'KeyB') { closeWheel(true); return; }
    const mv = MOVE_KEYS[code];
    if (mv) { state[mv] = false; return; }
    if (code === 'Space') { state.jump = false; return; }
    if (code === 'ShiftLeft' || code === 'ShiftRight') {
      if (state.walk) { state.walk = false; emit('input:walk', { down: false }); }
    }
  }

  function onMouseMove(e) {
    if (touch || !enabled) return;
    if (wheel.open) {
      // 휠: 잠금 중이면 상대 이동을 가상 커서에, 아니면 화면 중앙 기준 실제 커서 위치
      if (locked) {
        const mx = e.movementX || 0, my = e.movementY || 0;
        if (Math.abs(mx) > 400 || Math.abs(my) > 400) return;
        if (mx || my) moveWheel(mx, my, false);
      } else {
        moveWheel(e.clientX - window.innerWidth / 2, e.clientY - window.innerHeight / 2, true);
      }
      return;
    }
    if (!locked) return;
    const mx = e.movementX || 0, my = e.movementY || 0;
    // 일부 브라우저의 Pointer Lock 튐 현상 무시
    if (Math.abs(mx) > 400 || Math.abs(my) > 400) return;
    lookX += mx; lookY += my;
  }

  /** 사격(0)·줌(2)을 누른다. 이모트 중이면 이모트를 취소하기만 한다 */
  function pressAction(button) {
    if (emoteLock) {
      emit('input:emoteCancel', { reason: button === 0 ? 'fire' : 'aim' });
      return;
    }
    if (button === 0) {
      if (!state.fire) { state.fire = true; emit('input:fire', { down: true }); }
    } else if (zoomMode() === 'toggle') setAim(!state.aim);
    else setAim(true);
  }
  function releaseAction(button) {
    if (button === 0) {
      if (state.fire) { state.fire = false; emit('input:fire', { down: false }); }
    } else if (zoomMode() !== 'toggle') setAim(false);
  }

  function onMouseDown(e) {
    if (touch || !locked || !enabled) return;
    if (wheel.open) {
      // 휠 열림: 좌클릭 = 강조된 칸 바로 고르기, 우클릭 = 닫기. 사격·줌은 하지 않는다
      if (e.button === 0 && wheel.selected != null) closeWheel(true);
      else if (e.button === 2) closeWheel(false, { cancelled: true });
      e.preventDefault();
      return;
    }
    if (e.button === 0 || e.button === 2) pressAction(e.button);
    e.preventDefault();
  }

  function onMouseUp(e) {
    if (touch) return;
    if (e.button === 0 || e.button === 2) releaseAction(e.button);
  }

  /** 터치 조작이 넣는 입력(engine/touch.js). 키보드·마우스와 같은 상태와 이벤트로 바꾼다 */
  const touchApi = {
    /** 조이스틱. stickState()의 결과를 그대로 받는다 */
    stick(s) {
      if (!enabled) return;
      state.forward = !!s.forward; state.back = !!s.back; state.left = !!s.left; state.right = !!s.right;
      const walk = !!s.walk;
      if (state.walk !== walk) { state.walk = walk; emit('input:walk', { down: walk }); }
    },
    /** 시점을 손가락 이동량(px)만큼 돌린다 */
    look(dx, dy) {
      if (locked && enabled && !wheel.open) { lookX += dx * TOUCH.LOOK_SCALE; lookY += dy * TOUCH.LOOK_SCALE; }
    },
    fire(down) {
      if (!down) { releaseAction(0); return; }
      if (locked && enabled && !wheel.open) pressAction(0);
    },
    /** 조준 버튼. 칼은 강타, 수류탄은 낮게 굴리기가 된다 */
    zoom(down) {
      if (!down) { releaseAction(2); emit('input:zoom', { down: false }); return; }
      if (!locked || !enabled || wheel.open) return;
      pressAction(2);
      if (!emoteLock) emit('input:zoom', { down: true });
    },
    jump(down) {
      if (!down) { state.jump = false; return; }
      if (enabled) { state.jump = true; emit('input:jump', {}); }
    },
    /** 앉기를 켜고 끈다 → 지금 앉아 있는가 */
    crouchToggle() {
      if (enabled) {
        if (crouchDown.has('touch')) crouchDown.delete('touch');
        else crouchDown.add('touch');
        syncCrouch();
      }
      return state.crouch;
    },
    reload() { if (enabled) emit('input:reload', {}); },
    slot(n) { if (enabled) emit('input:slot', { slot: n }); },
    drop() { if (enabled) emit('input:drop', {}); },
    scoreboard(open) {
      if (open && enabled && !state.scoreboard) { state.scoreboard = true; emit('input:scoreboard', { open: true }); }
      else if (!open && state.scoreboard) { state.scoreboard = false; emit('input:scoreboard', { open: false }); }
    },
  };

  function onWheel(e) {
    if (!locked || !enabled) return;
    e.preventDefault();
    if (wheel.open) return;
    const now = performance.now();
    if (now - lastWheel < 110 || Math.abs(e.deltaY) < 1) return;
    lastWheel = now;
    emit('input:cycle', { dir: e.deltaY > 0 ? 1 : -1 });
  }

  function onContextMenu(e) { e.preventDefault(); }

  function setLocked(now) {
    if (now === locked) return;
    locked = now;
    if (!locked) releaseAll();
    emit('input:lock', { locked });
    if (!locked) emit('input:menu', { reason: 'unlock' });
  }
  function onLockChange() {
    if (!touch) setLocked(document.pointerLockElement === el);
  }
  function onLockError() {
    emit('input:lock-error', {});
  }

  function onBlur() { releaseAll(); }

  // 전체 화면(Fullscreen API)일 때만 Keyboard Lock 사용 가능 → Ctrl+W 같은 조합도 게임이 받는다
  function onFullscreenChange() {
    const kb = navigator.keyboard;
    if (!kb || typeof kb.lock !== 'function') return;
    if (document.fullscreenElement) {
      try { const p = kb.lock(LOCK_KEYS); if (p && p.catch) p.catch(() => {}); } catch (err) { /* 미지원 */ }
    } else {
      try { kb.unlock(); } catch (err) { /* ignore */ }
    }
  }

  /** 사용자 제스처(클릭) 안에서 호출해야 한다. 결과는 pointerlockchange → input:lock 으로도 온다 */
  function requestLock() {
    if (locked) return Promise.resolve(true);
    if (touch) { setLocked(true); return Promise.resolve(true); }
    if (!el.requestPointerLock) return Promise.resolve(false);
    let p;
    try { p = el.requestPointerLock({ unadjustedMovement: true }); }
    catch (err) {
      try { p = el.requestPointerLock(); } catch (err2) { return Promise.resolve(false); }
    }
    if (p && typeof p.then === 'function') {
      return p.then(() => true, (err) => {
        // unadjustedMovement 미지원 → 일반 모드로 재시도
        if (err && err.name === 'NotSupportedError') {
          try {
            const p2 = el.requestPointerLock();
            if (p2 && typeof p2.then === 'function') return p2.then(() => true, () => false);
          } catch (e3) { /* ignore */ }
        }
        return false;
      });
    }
    return Promise.resolve(false);
  }

  function exitLock() {
    if (touch) { setLocked(false); return; }
    if (document.pointerLockElement === el && document.exitPointerLock) document.exitPointerLock();
  }

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mousedown', onMouseDown);
  document.addEventListener('mouseup', onMouseUp);
  document.addEventListener('wheel', onWheel, { passive: false });
  el.addEventListener('contextmenu', onContextMenu);
  document.addEventListener('contextmenu', onContextMenuIfLocked);
  document.addEventListener('pointerlockchange', onLockChange);
  document.addEventListener('pointerlockerror', onLockError);
  window.addEventListener('blur', onBlur);
  document.addEventListener('fullscreenchange', onFullscreenChange);

  function onContextMenuIfLocked(e) { if (locked) e.preventDefault(); }

  return {
    state,
    touchMode: !!touch,
    touch: touchApi,
    get locked() { return locked; },
    isLocked: () => locked,
    isDown: (name) => !!state[name],
    /** 누적된 마우스 이동(라디안)을 꺼내고 0으로 */
    consumeLook() {
      if (wheel.open) { lookX = lookY = 0; return { dx: 0, dy: 0 }; }
      const sens = MOUSE.BASE_SENS * ((settings && settings.get('sensitivity')) || 1) * lookScale;
      const inv = settings && settings.get('invertY') ? -1 : 1;
      const out = { dx: lookX * sens, dy: lookY * sens * inv };
      lookX = lookY = 0;
      return out;
    },
    /** 테스트·봇용: 인위적으로 시점 이동(픽셀 단위) */
    addLook(px, py) { lookX += px; lookY += py; },
    setLookScale(s) { lookScale = Number.isFinite(s) && s > 0 ? s : 1; },
    getLookScale: () => lookScale,
    resetAim() { setAim(false, 'reset'); },
    setAim,
    requestLock,
    exitLock,
    setEnabled(v) { enabled = !!v; if (!enabled) releaseAll(); },
    setTouchZoomHold(v) {
      v = !!v;
      if (!touch || v === touchZoomHold) return;
      touchZoomHold = v;
      if (state.aim) setAim(false, 'mode');   // 방식이 바뀌면 켜 둔 줌은 놓는다(무기가 바뀐 때다)
    },
    /** 이모트 휠 상태(폴링용) */
    get emoteWheel() { return wheelPayload(); },
    /** 휠 칸의 이모트(계정 장비). 휠이 열려 있는 동안 바뀌면 다음에 열 때부터 쓴다 */
    setEmoteWheel(ids) {
      const list = Array.isArray(ids) ? ids.filter((id, i) => typeof id === 'string' && emoteById(id) && ids.indexOf(id) === i).slice(0, EMOTE_WHEEL.SLOTS) : [];
      if (!wheel.open) wheelIds = list.length ? list : DEFAULT_EMOTE_WHEEL.slice();
      else pendingWheel = list;
    },
    get emoteWheelIds() { return wheelIds.slice(); },
    /** 이모트 중이면 true: 좌·우클릭이 사격·줌 대신 input:emoteCancel { reason:'fire'|'aim' } */
    setEmoteLock(v) { emoteLock = !!v; if (emoteLock) { if (state.fire) { state.fire = false; emit('input:fire', { down: false }); } if (state.aim) setAim(false, 'release'); } },
    get emoteLock() { return emoteLock; },
    /** 휠을 코드로 열고 닫기(테스트·봇·다른 입력 장치용) */
    openEmoteWheel: openWheel,
    moveEmoteWheel: (x, y, absolute = true) => { if (wheel.open) moveWheel(x, y, absolute); },
    closeEmoteWheel: (pick = true) => closeWheel(pick, pick ? null : { cancelled: true }),
    get enabled() { return enabled; },
    releaseAll,
    dispose() {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('wheel', onWheel);
      el.removeEventListener('contextmenu', onContextMenu);
      document.removeEventListener('contextmenu', onContextMenuIfLocked);
      document.removeEventListener('pointerlockchange', onLockChange);
      document.removeEventListener('pointerlockerror', onLockError);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      exitLock();
    }
  };
}
