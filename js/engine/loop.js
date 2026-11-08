/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 게임 루프. 60 Hz 고정 틱 물리와 가변 프레임 렌더를 순서대로 돌린다.
 */
/**
 * SKALA 작전 — 게임 루프: 고정 틱(기본 60 Hz) 물리 + 가변 렌더(rAF)
 *
 *   const loop = createLoop({ tickRate: 60 });
 *   const off1 = loop.onTick((dt, tick, time) => { ... }, order?);    // dt = 1/60 고정
 *   const off2 = loop.onFrame((dt, alpha, now) => { ... }, order?);   // dt = 실제 경과(초, ≤0.25), alpha = 틱 사이 보간 비율 0..1
 *   order(기본 0)가 작을수록 먼저. core: 플레이어 시점 -100 · 아바타/맵 -50 · 렌더 1000(항상 마지막)
 *   loop.start(); loop.stop();
 *
 * - 콜백은 order 순(같으면 등록 순)으로 호출. 예외는 잡아서 같은 오류는 한 번만 출력한다(루프는 계속).
 * - 탭이 숨겨졌다 돌아와도 한 프레임에 최대 maxTicksPerFrame 틱만 돌린다(따라잡기 폭주 방지).
 */

export function createLoop({ tickRate = 60, maxFrameDt = 0.25, maxTicksPerFrame = 6, bus = null } = {}) {
  const step = 1 / tickRate;
  const ticks = [];
  const frames = [];
  let acc = 0, last = 0, raf = 0, running = false;
  let tickCount = 0, simTime = 0;
  const reported = new WeakSet();
  let fps = 60, fpsAcc = 0, fpsFrames = 0;

  function safe(fn, a, b, c) {
    try { fn(a, b, c); }
    catch (err) {
      if (!reported.has(fn)) { reported.add(fn); console.error('[loop] callback error (이후 같은 오류는 생략):', err); }
    }
  }

  function frame(now) {
    if (!running) return;
    raf = requestAnimationFrame(frame);
    let dt = last ? (now - last) / 1000 : step;
    last = now;
    if (!(dt >= 0)) dt = 0;
    if (dt > maxFrameDt) dt = maxFrameDt;
    acc += dt;
    let n = 0;
    while (acc >= step && n < maxTicksPerFrame) {
      for (let i = 0; i < ticks.length; i++) safe(ticks[i].fn, step, tickCount, simTime);
      if (bus && bus.has('loop:tick')) bus.emit('loop:tick', { dt: step, tick: tickCount, t: simTime });
      tickCount++;
      simTime += step;
      acc -= step;
      n++;
    }
    if (n >= maxTicksPerFrame && acc > step) acc = 0;
    const alpha = acc / step;
    for (let i = 0; i < frames.length; i++) safe(frames[i].fn, dt, alpha, now);
    if (bus && bus.has('loop:frame')) bus.emit('loop:frame', { dt, alpha, now });
    fpsAcc += dt; fpsFrames++;
    if (fpsAcc >= 0.5) { fps = fpsFrames / fpsAcc; fpsAcc = 0; fpsFrames = 0; }
  }

  function add(list, fn, order = 0) {
    const item = { fn, order: +order || 0 };
    let i = list.length;
    while (i > 0 && list[i - 1].order > item.order) i--;
    list.splice(i, 0, item);
    return () => { const k = list.indexOf(item); if (k >= 0) list.splice(k, 1); };
  }

  return {
    step,
    onTick: (fn, order) => add(ticks, fn, order),
    onFrame: (fn, order) => add(frames, fn, order),
    start() {
      if (running) return;
      running = true;
      last = 0;
      acc = 0;
      raf = requestAnimationFrame(frame);
    },
    stop() {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    },
    get running() { return running; },
    get tick() { return tickCount; },
    get time() { return simTime; },
    get fps() { return fps; },
    dispose() {
      this.stop();
      ticks.length = 0;
      frames.length = 0;
    }
  };
}
