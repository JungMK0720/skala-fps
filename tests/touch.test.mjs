/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 터치 조작의 계산과 입력 연결을 시험한다. 기기 판별, 조이스틱 8방향과 걷기, 손잡이 범위, 열어 둔 이모트 휠 누르기, 터치 모드의 가상 잠금과 입력 이벤트, 채팅 키.
 */
import { before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { TOUCH, WHEEL_TAP, detectTouch, isStickSide, knobOffset, stickState, wheelTapAt } from '../js/engine/touch-logic.js';
import { DEFAULT_EMOTE_WHEEL, EMOTE_WHEEL, emoteSlotAt } from '../js/core/consts.js';

describe('터치 기기 판별', () => {
  test('주소의 touch 값이 먼저다', () => {
    assert.equal(detectTouch({ flag: '1' }), true);
    assert.equal(detectTouch({ flag: '0', coarse: true, maxTouchPoints: 5 }), false);
  });
  test('주 입력이 손가락이고 터치 지점이 있어야 켠다', () => {
    assert.equal(detectTouch({ coarse: true, maxTouchPoints: 5 }), true);
    assert.equal(detectTouch({ coarse: false, maxTouchPoints: 10 }), false, '터치스크린 노트북은 마우스로 친다');
    assert.equal(detectTouch({ coarse: true, maxTouchPoints: 0 }), false);
    assert.equal(detectTouch(), false);
  });
});

describe('조이스틱', () => {
  const R = TOUCH.STICK_RADIUS;
  test('데드존 안쪽은 멈춤이다', () => {
    for (const [dx, dy] of [[0, 0], [3, 3], [R * TOUCH.DEADZONE, 0], [Number.NaN, 1]]) {
      const s = stickState(dx, dy);
      assert.equal(s.mag, 0);
      assert.ok(!s.forward && !s.back && !s.left && !s.right && !s.walk, `${dx},${dy}`);
    }
  });
  test('위로 밀면 앞, 아래로 밀면 뒤, 양옆은 좌우다', () => {
    const cases = [
      [[0, -R], 'forward'], [[0, R], 'back'], [[-R, 0], 'left'], [[R, 0], 'right'],
    ];
    for (const [[dx, dy], want] of cases) {
      const s = stickState(dx, dy);
      for (const k of ['forward', 'back', 'left', 'right']) assert.equal(s[k], k === want, `${want}: ${k}`);
    }
  });
  test('대각선은 두 방향을 함께 누른다', () => {
    const s = stickState(R, -R);
    assert.ok(s.forward && s.right && !s.back && !s.left);
    const near = stickState(R * 0.1, -R);
    assert.ok(near.forward && !near.right, '축 가까이면 한 방향이다');
  });
  test('조금만 밀면 걷고 끝까지 밀면 달린다', () => {
    assert.equal(stickState(0, -R * 0.4).walk, true);
    assert.equal(stickState(0, -R).walk, false);
    assert.equal(stickState(0, -R * 3).mag, 1, '반지름을 넘어도 최대는 1이다');
  });
  test('손잡이는 반지름 밖으로 나가지 않는다', () => {
    assert.deepEqual(knobOffset(10, -5), { x: 10, y: -5 });
    const k = knobOffset(R * 3, 0);
    assert.ok(Math.abs(k.x - R) < 1e-9 && k.y === 0);
    assert.deepEqual(knobOffset(Number.NaN, 2), { x: 0, y: 2 });
  });
  test('화면 왼쪽을 누르면 조이스틱, 나머지는 시점이다', () => {
    assert.equal(isStickSide(100, 844), true);
    assert.equal(isStickSide(844 * TOUCH.STICK_SIDE, 844), false);
    assert.equal(isStickSide(700, 844), false);
  });
});

describe('열어 둔 이모트 휠 누르기', () => {
  const rect = { left: 100, top: 50, width: 400, height: 400 };   // 가운데 (300, 250), 그림 1단위 = 1px
  const slotOf = (hit) => emoteSlotAt(hit.ux * EMOTE_WHEEL.RADIUS, hit.uy * EMOTE_WHEEL.RADIUS);
  test('가운데 허브는 닫기, 칸 고리는 그 칸, 바깥은 휠 밖이다', () => {
    assert.equal(wheelTapAt(300, 250, rect).kind, 'hub');
    assert.equal(wheelTapAt(300 + WHEEL_TAP.HUB - 1, 250, rect).kind, 'hub');
    const up = wheelTapAt(300, 250 - 140, rect);
    assert.equal(up.kind, 'pick');
    assert.equal(slotOf(up), 0, '12시 칸(1번 이모트)');
    assert.equal(DEFAULT_EMOTE_WHEEL[slotOf(up)], 'takeL', '기본 휠의 12시는 L을 가져가다');
    assert.equal(slotOf(wheelTapAt(300 + 140, 250, rect)), 2, '3시 칸');
    assert.equal(slotOf(wheelTapAt(300, 250 + 140, rect)), 4, '6시 칸');
    assert.equal(slotOf(wheelTapAt(300 - 100, 250 - 100, rect)), 7, '10시 반 칸');
    assert.equal(wheelTapAt(300, 250 - (WHEEL_TAP.OUTER - 1), rect).kind, 'pick', '그림 테두리를 조금 넘어도 칸이다');
    assert.equal(wheelTapAt(300 + WHEEL_TAP.OUTER + 1, 250, rect).kind, 'outside');
  });
  test('작게 그려진 휠은 비율대로 보고, 휠이 없으면 밖이다', () => {
    const small = { left: 0, top: 0, width: 200, height: 200 };   // 그림 1단위 = 0.5px
    assert.equal(wheelTapAt(100 + 30, 100, small).kind, 'hub');
    assert.equal(wheelTapAt(100 + 40, 100, small).kind, 'pick');
    assert.equal(wheelTapAt(100 + 120, 100, small).kind, 'outside');
    assert.equal(wheelTapAt(10, 10, null).kind, 'outside');
    assert.equal(wheelTapAt(10, 10, { left: 0, top: 0, width: 0, height: 0 }).kind, 'outside', '숨은 휠');
    assert.equal(wheelTapAt(Number.NaN, 10, rect).kind, 'outside');
  });
});

describe('터치 모드 입력', () => {
  let createInput;
  const listeners = () => { const m = new Map(); return { addEventListener: (k, f) => m.set(k, f), removeEventListener: (k) => m.delete(k), fire: (k, e) => { const f = m.get(k); if (f) f(e); } }; };
  const stage = (touch = true) => {
    const events = [];
    const bus = { emit: (evt, data) => events.push([evt, data]) };
    const settings = { get: (k) => (k === 'sensitivity' ? 1 : k === 'zoomMode' ? 'hold' : null) };
    const input = createInput({ element: listeners(), bus, settings, touch });
    return { input, events, of: (evt) => events.filter((e) => e[0] === evt).map((e) => e[1]) };
  };

  before(async () => {
    // input.js는 window와 document에 리스너를 건다. 터치 입력은 DOM이 없어도 돌아간다
    globalThis.window = globalThis.window || listeners();
    globalThis.document = globalThis.document || Object.assign(listeners(), { pointerLockElement: null, body: {} });
    ({ createInput } = await import('../js/engine/input.js'));
  });

  test('잠금은 포인터 잠금 없이 상태만 바뀌고 PC와 같은 이벤트를 낸다', async () => {
    const { input, of } = stage();
    assert.equal(input.touchMode, true);
    assert.equal(input.locked, false);
    assert.equal(await input.requestLock(), true);
    assert.equal(input.locked, true);
    assert.deepEqual(of('input:lock').at(-1), { locked: true });
    input.exitLock();
    assert.equal(input.locked, false);
    assert.deepEqual(of('input:lock').at(-1), { locked: false });
    assert.deepEqual(of('input:menu').at(-1), { reason: 'unlock' }, '일시정지 메뉴가 열린다');
    input.dispose();
  });

  test('키보드를 붙인 태블릿은 Esc로 가상 잠금을 풀어 일시정지한다', async () => {
    const { input, of } = stage();
    const esc = () => globalThis.window.fire('keydown', { code: 'Escape', repeat: false, target: null, preventDefault() {} });
    await input.requestLock();
    esc();
    assert.equal(input.locked, false);
    assert.deepEqual(of('input:menu').at(-1), { reason: 'unlock' });
    esc();
    assert.deepEqual(of('input:menu').at(-1), { reason: 'esc' }, '풀린 뒤의 Esc는 PC와 같다');
    input.dispose();
  });

  test('조이스틱이 이동 키 상태가 된다', async () => {
    const { input } = stage();
    await input.requestLock();
    input.touch.stick(stickState(TOUCH.STICK_RADIUS, -TOUCH.STICK_RADIUS));
    assert.ok(input.state.forward && input.state.right && !input.state.walk);
    input.touch.stick(stickState(0, -TOUCH.STICK_RADIUS * 0.4));
    assert.ok(input.state.forward && !input.state.right && input.state.walk);
    input.touch.stick(stickState(0, 0));
    assert.ok(!input.state.forward && !input.state.walk);
    input.dispose();
  });

  test('시점은 마우스보다 크게 돌고 잠기기 전에는 듣지 않는다', async () => {
    const { input } = stage();
    input.touch.look(100, 0);
    assert.equal(input.consumeLook().dx, 0);
    await input.requestLock();
    input.touch.look(100, 0);
    const moved = input.consumeLook().dx;
    input.addLook(100, 0);
    const mouse = input.consumeLook().dx;
    assert.ok(Math.abs(moved / mouse - TOUCH.LOOK_SCALE) < 1e-9);
    input.dispose();
  });

  test('발사와 조준은 누르고 떼는 대로 이벤트를 낸다. 줌은 언제나 켜고 끄는 방식이다', async () => {
    const { input, of } = stage();
    input.touch.fire(true);
    assert.equal(input.state.fire, false, '잠기기 전에는 쏘지 않는다');
    await input.requestLock();
    input.touch.fire(true);
    assert.equal(input.state.fire, true);
    input.touch.fire(false);
    assert.equal(input.state.fire, false);
    assert.deepEqual(of('input:fire').map((e) => e.down), [true, false]);
    input.touch.zoom(true);
    input.touch.zoom(false);
    assert.equal(input.state.aim, true, '떼도 줌이 유지된다');
    assert.deepEqual(of('input:zoom').map((e) => e.down), [true, false]);
    input.touch.zoom(true);
    input.touch.zoom(false);
    assert.equal(input.state.aim, false, '다시 누르면 꺼진다');
    input.dispose();
  });

  test('라이플 조준 사격: 조준 버튼이 누르는 동안만 줌이 되고, 끄면 켜고 끄는 방식으로 돌아간다', async () => {
    const { input, of } = stage();
    await input.requestLock();
    input.setTouchZoomHold(true);
    input.touch.zoom(true);
    assert.equal(input.state.aim, true);
    input.touch.zoom(false);
    assert.equal(input.state.aim, false, '떼면 꺼진다');
    assert.deepEqual(of('input:zoom').map((e) => e.down), [true, false]);
    input.touch.zoom(true);
    input.setTouchZoomHold(false);
    assert.equal(input.state.aim, false, '방식이 바뀌면 켜 둔 줌을 놓는다');
    input.touch.zoom(false);
    input.touch.zoom(true);
    input.touch.zoom(false);
    assert.equal(input.state.aim, true, '다시 누를 때마다 켜고 끈다');
    input.dispose();
    const pc = stage(false);
    pc.input.setTouchZoomHold(true);
    assert.equal(pc.input.state.aim, false, 'PC에는 영향이 없다');
    pc.input.dispose();
  });

  test('이모트 중에는 사격과 조준이 이모트 취소만 한다', async () => {
    const { input, of } = stage();
    await input.requestLock();
    input.setEmoteLock(true);
    input.touch.fire(true);
    assert.equal(input.state.fire, false);
    assert.equal(of('input:emoteCancel').at(-1).reason, 'fire');
    input.touch.zoom(true);
    assert.equal(of('input:emoteCancel').at(-1).reason, 'aim');
    assert.equal(of('input:zoom').length, 0);
    input.dispose();
  });

  test('점프·앉기·장전·무기·점수판', async () => {
    const { input, of } = stage();
    await input.requestLock();
    input.setEnabled(true);
    input.touch.jump(true);
    assert.equal(input.state.jump, true);
    input.touch.jump(false);
    assert.equal(input.state.jump, false);
    assert.equal(input.touch.crouchToggle(), true);
    assert.equal(input.touch.crouchToggle(), false);
    input.touch.reload();
    input.touch.slot(3);
    input.touch.drop();
    assert.equal(of('input:reload').length, 1);
    assert.deepEqual(of('input:slot').at(-1), { slot: 3 });
    assert.equal(of('input:drop').length, 1);
    input.touch.scoreboard(true);
    assert.equal(input.state.scoreboard, true);
    input.touch.scoreboard(false);
    assert.deepEqual(of('input:scoreboard').map((e) => e.open), [true, false]);
    input.dispose();
  });

  test('탭 뒤에 브라우저가 흉내 내는 마우스 이벤트로는 쏘지 않는다', async () => {
    const { input } = stage();
    await input.requestLock();
    globalThis.document.fire('mousedown', { button: 0, preventDefault() {} });
    assert.equal(input.state.fire, false);
    input.dispose();
    const pc = stage(false);
    assert.equal(pc.input.touchMode, false);
    pc.input.dispose();
  });

  test('이모트 휠 탭 모드: 열린 휠만 켤 수 있고, 칸을 고르면 그 이모트를 내고, 닫히면 꺼진다', async () => {
    const { input, of } = stage();
    await input.requestLock();
    input.setEmoteWheelTap(true);
    assert.equal(of('input:emoteWheel').length, 0, '닫힌 휠은 켜지 않는다');
    input.openEmoteWheel();
    assert.equal(input.emoteWheel.tap, false, '열 때는 끌기 방식이다');
    input.setEmoteWheelTap(true);
    assert.equal(of('input:emoteWheel').at(-1).tap, true);
    assert.equal(of('input:emoteWheel').at(-1).open, true);
    input.touch.look(30, 0);
    assert.deepEqual(input.consumeLook(), { dx: 0, dy: 0 }, '휠이 열린 동안 시점은 멈춘다');
    input.moveEmoteWheel(0, -EMOTE_WHEEL.RADIUS, true);
    input.closeEmoteWheel(true);
    assert.deepEqual(of('input:emotePick').at(-1), { id: 'takeL', code: of('input:emotePick').at(-1).code, selected: 0 });
    assert.ok(of('input:emotePick').at(-1).code > 0);
    assert.equal(input.emoteWheel.open, false);
    assert.equal(input.emoteWheel.tap, false, '닫히면 탭 모드도 끝난다');
    input.openEmoteWheel();
    input.setEmoteWheelTap(true);
    input.exitLock();
    assert.equal(of('input:emoteWheel').at(-1).cancelled, true, '잠금이 풀리면 고르지 않고 닫는다');
    assert.equal(input.emoteWheel.tap, false);
    input.dispose();
  });

  test('채팅: 잠금 중 Enter와 채팅 버튼이 input:chat을 내고, 휠이 열렸거나 잠금 전이면 내지 않는다', async () => {
    const { input, of } = stage();
    const key = (code, repeat = false) => globalThis.window.fire('keydown', { code, repeat, target: null, preventDefault() {} });
    key('Enter');
    input.touch.chat();
    assert.equal(of('input:chat').length, 0, '잠금 전');
    await input.requestLock();
    key('Enter');
    key('NumpadEnter');
    key('Enter', true);
    input.touch.chat();
    assert.equal(of('input:chat').length, 3, 'Enter 두 개와 채팅 버튼, 키 반복은 뺀다');
    input.openEmoteWheel();
    key('Enter');
    input.touch.chat();
    assert.equal(of('input:chat').length, 3, '이모트 휠이 열려 있으면 열지 않는다');
    input.closeEmoteWheel(false);
    input.dispose();
  });

  test('잠금이 풀리면 눌려 있던 입력이 모두 풀린다', async () => {
    const { input } = stage();
    await input.requestLock();
    input.touch.stick(stickState(0, -TOUCH.STICK_RADIUS));
    input.touch.fire(true);
    input.touch.jump(true);
    input.touch.crouchToggle();
    input.exitLock();
    assert.ok(!input.state.forward && !input.state.fire && !input.state.jump && !input.state.crouch);
    input.dispose();
  });
});
