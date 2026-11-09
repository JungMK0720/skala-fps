/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 폭파 미션 화면 연출. 설치·떨어진 폭탄 모형과 깜박이는 불, 빨라지는 삐 소리와 폭발, A·B 구역 표시(3D 위치를 화면에 투영),
 *          E 키·휴대폰 설치/해체 버튼으로 설치·해체 의도를 만들고 HUD 폭탄 칸을 채운다. 판정은 방장의 match.js가 한다(World가 쓴다).
 */
/**
 * World 안에서만 쓴다(WORLD_API.md 8절).
 *
 *   const bv = createBombView({ THREE, scene, camera, bus, play, fx, hud, emit, local, posOf, floorAt });
 *   bv.load(mapData)    맵의 미션 칸(구역) 읽기          bv.unload()  모두 지우기
 *   bv.set(info|null)   방장 상태(세션·연습장이 매 스냅샷)  bv.event(ev) 폭탄 이벤트 하나(소리·안내·폭발)
 *   bv.tick(dt)         E 키 → 'bombAction' 의도           bv.frame(dt) 모형·삐 소리·구역 표시
 *   bv.hud()            → hud.set({ bomb })에 넣을 값       bv.reset()  라운드 전환
 *
 * info = { attack, state, carrier, carrierName?, actorName?, pos:[x,y,z]|null, site, explodeInMs, action:{kind,id,leftMs,totalMs}|null,
 *          phase, plantMs?, defuseMs? } — match.applySnapshot(...).bomb에 attack·phase를 더한 모양
 */
import { BOMB, BOMB_CANCEL_LABELS, normalizeMission, siteAt, within, beepInterval, bombTexts, sideOfTeam } from './mission.js';

const STILL_SPEED = 0.5;       // 이보다 느려야 설치·해체를 시작한다(m/s)
const MOVE_CANCEL_SPEED = 1.2; // 진행 중 이보다 빠르면 취소
const PENDING_MS = 1500;       // 시작을 보냈는데 방장 확인이 이만큼 없으면 접는다
const MARKER_Y = 2.4;          // 구역 표시를 띄우는 높이(바닥 위 m)
const EDGE_PAD = 48;           // 화면 가장자리에 붙일 때 여백(px)

const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export function createBombView(o) {
  const { THREE, scene, camera, bus } = o;
  const play = typeof o.play === 'function' ? o.play : () => null;
  const emit = typeof o.emit === 'function' ? o.emit : () => {};
  const local = typeof o.local === 'function' ? o.local : () => null;
  const posOf = typeof o.posOf === 'function' ? o.posOf : () => null;
  const floorAt = typeof o.floorAt === 'function' ? o.floorAt : (x, y) => y;
  const hudApi = () => (typeof o.hud === 'function' ? o.hud() : null);
  const fx = o.fx || null;
  const now = () => performance.now();

  let sites = [];
  let info = null;             // 마지막 방장 상태
  let infoAt = 0;
  let pending = null;          // { kind, at, from:[x,y,z] } 내가 시작을 보냈다
  let useDown = false, armed = false;
  let touchSig = '';
  let nextBeep = 0, ledUntil = 0, keyAt = 0;
  let carrierCb = typeof o.onCarrier === 'function' ? o.onCarrier : null;
  let lastCarrier = null;
  let blockedUntil = 0;        // 거절·취소 뒤 잠깐 다시 시작하지 않는다

  /* ---------- 폭탄 모형 ---------- */
  const group = new THREE.Group();
  group.name = 'bomb';
  group.visible = false;
  const bodyMat = new THREE.MeshLambertMaterial({ color: 0x2b3038 });
  const trimMat = new THREE.MeshLambertMaterial({ color: 0xb08a2e });
  const screenMat = new THREE.MeshBasicMaterial({ color: 0x1f8f4c });
  const ledMat = new THREE.MeshBasicMaterial({ color: 0x4a0f12 });
  const glowMat = new THREE.MeshBasicMaterial({ color: 0xff3040, transparent: true, opacity: 0, depthWrite: false });
  const geos = [];
  const mesh = (geo, mat, x, y, z) => { geos.push(geo); const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); group.add(m); return m; };
  mesh(new THREE.BoxGeometry(0.46, 0.16, 0.3), bodyMat, 0, 0.08, 0);
  mesh(new THREE.BoxGeometry(0.48, 0.03, 0.06), trimMat, 0, 0.12, -0.08);
  mesh(new THREE.BoxGeometry(0.48, 0.03, 0.06), trimMat, 0, 0.12, 0.08);
  mesh(new THREE.BoxGeometry(0.18, 0.012, 0.1), screenMat, -0.08, 0.166, 0);
  for (let i = 0; i < 3; i++) mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.2, 8), trimMat, 0.1 + i * 0.012, 0.18, -0.1 + i * 0.1).rotation.z = Math.PI / 2;
  const led = mesh(new THREE.SphereGeometry(0.028, 10, 8), ledMat, 0.16, 0.18, 0);
  const glow = mesh(new THREE.SphereGeometry(0.22, 12, 10), glowMat, 0.16, 0.2, 0);
  glow.renderOrder = 2;
  // 떨어진 폭탄 둘레의 고리(공격 팀에게 위치를 알려 준다)
  const ringGeo = new THREE.RingGeometry(0.42, 0.52, 28);
  ringGeo.rotateX(-Math.PI / 2);
  geos.push(ringGeo);
  const ringMat = new THREE.MeshBasicMaterial({ color: 0xffb340, transparent: true, opacity: 0.8, depthWrite: false });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.position.y = 0.02;
  ring.visible = false;
  group.add(ring);
  if (scene) scene.add(group);

  function placeModel(p) {
    const y = p[1] == null ? floorAt(p[0], 1e3, p[2]) : floorAt(p[0], p[1] + 0.4, p[2]);
    group.position.set(p[0], Number.isFinite(y) ? y : num(p[1], 0), p[2]);
  }

  /* ---------- 입력 ---------- */
  const offs = [];
  if (bus && typeof bus.on === 'function') {
    offs.push(bus.on('input:use', (e) => {
      const down = !!(e && e.down);
      if (down && !useDown) armed = true;
      useDown = down;
    }));
  }

  /* ---------- 조회 ---------- */
  function me() { const L = local(); return L && L.id != null ? L : null; }
  function mySide(L) { return info ? sideOfTeam(L && L.team, info.attack) : null; }
  const hspeed = (v) => (v ? Math.hypot(num(v[0]), num(v[2])) : 0);
  const msFor = (kind) => (kind === 'defuse' ? num(info && info.defuseMs, BOMB.defuseMs) : num(info && info.plantMs, BOMB.plantMs));

  /** 지금 할 수 있는 일: 'plant' | 'defuse' | null (멈춤 여부는 따로 본다) */
  function ability(L) {
    if (!info || info.phase !== 'live' || !L || !L.alive || !L.canAct) return null;
    const side = mySide(L);
    if (side === 'attack' && info.state === 'carried' && info.carrier === L.id && siteAt(sites, L.pos)) return 'plant';
    if (side === 'defense' && info.state === 'planted' && info.pos && within(L.pos, info.pos, BOMB.defuseRange)) return 'defuse';
    return null;
  }

  function send(act, reason) { emit('bombAction', reason ? { act, reason } : { act }); }
  function cancel(reason, say) {
    if (!pending) return;
    pending = null;
    send('cancel', reason);
    armed = false;
    blockedUntil = now() + 250;
    const h = hudApi();
    const text = BOMB_CANCEL_LABELS[reason];
    if (say && text && h) h.callout(text, 'info');
  }

  /* ---------- 공개 ---------- */
  function load(data) {
    const m = normalizeMission(data);
    sites = m ? m.sites.slice() : [];
    reset();
  }

  function reset() {
    pending = null; armed = false; useDown = false;
    nextBeep = 0; ledUntil = 0; keyAt = 0;
    group.visible = false;
    ring.visible = false;
    glowMat.opacity = 0;
    info = info ? { ...info, state: 'none', carrier: null, pos: null, action: null } : null;
    syncTouch(null);
  }

  function unload() {
    sites = [];
    info = null;
    reset();
    setCarrier(null);
  }

  function setCarrier(id) {
    if (id === lastCarrier) return;
    const prev = lastCarrier;
    lastCarrier = id;
    if (carrierCb) { try { carrierCb(prev, id); } catch (e) { /* 이름표만 늦게 바뀐다 */ } }
  }

  function set(next) {
    if (!next) { info = null; group.visible = false; syncTouch(null); setCarrier(null); return; }
    info = { ...next };
    infoAt = now();
    if (pending) {
      const a = info.action;
      if (a && a.id === (me() || {}).id && a.kind === pending.kind) pending.confirmed = true;
      else if (info.state === 'planted' && pending.kind === 'plant') pending = null;
      else if ((info.state === 'defused' || info.state === 'exploded') && pending.kind === 'defuse') pending = null;
      else if (pending.confirmed && !a) pending = null;   // 방장이 끝냈거나 취소했다
    }
    const L = me();
    // 폭탄을 든 사람은 아군에게만 보인다(이름표 💣)
    setCarrier(info.state === 'carried' && L && mySide(L) === 'attack' ? info.carrier : null);
    if (info.state === 'planted' || info.state === 'dropped') {
      if (info.pos) placeModel(info.pos);
      group.visible = !!info.pos;
      ring.visible = info.state === 'dropped' && !!L && mySide(L) === 'attack';
      if (info.state === 'planted' && !nextBeep) nextBeep = now() + 200;
    } else {
      group.visible = false;
      ring.visible = false;
      nextBeep = 0;
    }
  }

  /** 남은 시간(ms): 받은 시각부터 로컬로 줄인다 */
  function explodeLeft() {
    if (!info || info.state !== 'planted' || info.explodeInMs == null) return null;
    return Math.max(0, info.explodeInMs - (now() - infoAt));
  }
  function actionLeft() {
    const a = info && info.action;
    return a ? Math.max(0, a.leftMs - (now() - infoAt)) : 0;
  }

  function event(ev) {
    if (!ev || typeof ev !== 'object') return;
    const L = me();
    const side = mySide(L);
    const mine = !!L && ev.id != null && String(ev.id) === L.id;
    const h = hudApi();
    const site = ev.site ? `${ev.site} 구역` : '';
    switch (ev.act) {
      case 'give':
        if (mine && h) h.banner({ icon: '💣', title: '폭탄을 받았어요', sub: 'A 또는 B 구역에서 E를 길게 눌러 설치하세요' });
        break;
      case 'pick':
        if (mine) { play('bomb_pickup'); if (h) h.callout('💣 폭탄을 주웠어요', 'info'); }
        else if (side === 'attack' && h) h.callout(`💣 ${ev.name || '아군'}이(가) 폭탄을 주웠어요`, 'info');
        break;
      case 'drop':
        if (side === 'attack' && h) h.callout('💣 폭탄이 떨어졌어요', 'info');
        break;
      case 'plantStart':
      case 'defuseStart':
        keyAt = 0;
        break;
      case 'plantCancel':
      case 'defuseCancel':
        if (mine) { pending = null; if (h && BOMB_CANCEL_LABELS[ev.reason]) h.callout(BOMB_CANCEL_LABELS[ev.reason], 'info'); }
        break;
      case 'plant': {
        const p = Array.isArray(ev.pos) ? ev.pos : info && info.pos;
        if (p) play('bomb_armed', { pos: [p[0], num(p[1], 0) + 0.3, p[2]] });
        if (h) {
          h.center(`💣 폭탄 설치 · ${site || '구역'}`, 2600, {
            sub: side === 'attack' ? `${Math.round(num(ev.ms, BOMB.fuseMs) / 1000)}초 동안 폭탄을 지키세요` : side === 'defense' ? '폭탄을 찾아 해체하세요 · E 5초' : '',
            tone: 'warn'
          });
        }
        if (mine) pending = null;
        nextBeep = now() + 400;
        break;
      }
      case 'defuse':
        play('bomb_defused');
        if (mine) pending = null;
        group.visible = false;
        nextBeep = 0;
        break;
      case 'explode': {
        const p = Array.isArray(ev.pos) ? ev.pos : info && info.pos;
        group.visible = false;
        nextBeep = 0;
        pending = null;
        if (p) {
          const c = [p[0], num(p[1], 0) + 0.4, p[2]];
          play('bomb_explode', { pos: c });
          if (fx && typeof fx.explosion === 'function') {
            fx.explosion(c, { radius: 13 });
            setTimeout(() => { try { fx.explosion([c[0], c[1] + 1.6, c[2]], { radius: 9 }); } catch (e) { /* 맵이 이미 닫혔다 */ } }, 160);
          }
        }
        break;
      }
      default: break;
    }
  }

  /** 시뮬레이션 틱: E 키·버튼 → 설치·해체 시작/취소 의도 */
  function tick() {
    const L = me();
    const can = ability(L);
    const t = now();
    if (pending) {
      const moved = L && pending.from && L.pos ? Math.hypot(L.pos[0] - pending.from[0], L.pos[2] - pending.from[2]) : 0;
      if (!L || !L.alive) { pending = null; armed = false; }
      else if (!useDown) cancel('released', false);
      else if (hspeed(L.vel) > MOVE_CANCEL_SPEED || moved > BOMB.moveCancel || (can !== pending.kind && !pending.confirmed)) cancel('moved', true);
      else if (!pending.confirmed && t - pending.at > PENDING_MS) { pending = null; armed = false; blockedUntil = t + 400; }
    } else if (useDown && armed && can && t >= blockedUntil && L.onGround && hspeed(L.vel) < STILL_SPEED) {
      pending = { kind: can, at: t, from: [L.pos[0], L.pos[1], L.pos[2]], confirmed: false };
      armed = false;
      send(can);
    }
    syncTouch(pending ? pending.kind : can);
  }

  /** 내가 쐈다(칼·수류탄 포함) → 진행 중이면 취소 */
  function onLocalFire() { if (pending) cancel('fired', true); }
  function onLocalDeath() { pending = null; armed = false; syncTouch(null); }

  function syncTouch(kind) {
    const sig = kind || '';
    if (sig === touchSig || !bus || typeof bus.emit !== 'function') return;
    touchSig = sig;
    bus.emit('touch:use', { on: !!kind, label: kind === 'defuse' ? '해체' : '설치' });
  }

  /* ---------- 프레임: 모형 · 삐 · 단말기 소리 ---------- */
  function frame(dt) {
    const t = now();
    if (info && info.state === 'planted' && group.visible) {
      const left = explodeLeft();
      if (left != null && left > 0 && nextBeep && t >= nextBeep) {
        const p = group.position;
        play('bomb_beep', { pos: [p.x, p.y + 0.2, p.z] });
        ledUntil = t + Math.min(140, beepInterval(left) * 0.5);
        nextBeep = t + beepInterval(left);
      }
      const on = t < ledUntil;
      ledMat.color.setHex(on ? 0xff3344 : 0x4a0f12);
      glowMat.opacity = on ? 0.55 : 0;
      group.rotation.y = 0.3;
    } else {
      ledMat.color.setHex(0x4a0f12);
      glowMat.opacity = 0;
    }
    if (ring.visible) ringMat.opacity = 0.55 + 0.3 * Math.sin(t / 180);
    // 설치·해체 중이면 그 사람 자리에서 작업 소리를 낸다(모두에게 들린다)
    const a = info && info.action;
    if (a && info.phase === 'live' && actionLeft() > 0) {
      const gap = a.kind === 'plant' ? 450 : 600;
      if (!keyAt || t >= keyAt) {
        keyAt = t + gap;
        const L = me();
        const p = L && a.id === L.id ? L.pos : posOf(a.id) || (a.kind === 'defuse' && info.pos);
        if (p) play(a.kind === 'plant' ? 'bomb_key' : 'bomb_defuse', { pos: [p[0], num(p[1], 0) + 0.6, p[2]] });
      }
    } else keyAt = 0;
    void dt;
  }

  /* ---------- HUD ---------- */
  const _v = THREE ? new THREE.Vector3() : null;
  const _f = THREE ? new THREE.Vector3() : null;
  function project(x, y, z, L) {
    const w = (typeof window !== 'undefined' && window.innerWidth) || 1280;
    const h = (typeof window !== 'undefined' && window.innerHeight) || 720;
    _v.set(x, y, z);
    camera.getWorldDirection(_f);
    const cam = camera.position;
    const behind = (x - cam.x) * _f.x + (y - cam.y) * _f.y + (z - cam.z) * _f.z < 0;
    _v.project(camera);
    let sx = (_v.x + 1) / 2 * w, sy = (1 - _v.y) / 2 * h;
    if (behind) { sx = w - sx; sy = h - EDGE_PAD; }
    let edge = behind;
    if (sx < EDGE_PAD || sx > w - EDGE_PAD || sy < EDGE_PAD || sy > h - EDGE_PAD) edge = true;
    sx = Math.min(w - EDGE_PAD, Math.max(EDGE_PAD, sx));
    sy = Math.min(h - EDGE_PAD, Math.max(EDGE_PAD, sy));
    const from = L && L.pos ? L.pos : [cam.x, cam.y, cam.z];
    const dist = Math.round(Math.hypot(x - from[0], z - from[2]));
    return { x: Math.round(sx), y: Math.round(sy), edge, dist };
  }

  function markers(L, side) {
    const out = [];
    if (!camera || !_v) return out;
    const planted = info && info.state === 'planted';
    for (const s of sites) {
      const isBombSite = planted && info.site === s.id;
      if (planted && !isBombSite) {
        out.push({ id: s.id, label: s.id, kind: 'site', x: 0, y: 0, on: false, edge: false, planted: false, dist: null });
        continue;
      }
      const p = project(s.x, s.y + MARKER_Y, s.z, L);
      out.push({ id: s.id, label: s.id, kind: 'site', x: p.x, y: p.y, on: true, edge: p.edge, planted: isBombSite, dist: p.dist });
    }
    const showBomb = info && info.pos && (info.state === 'planted' || (info.state === 'dropped' && side === 'attack'));
    if (showBomb) {
      const p = project(info.pos[0], num(info.pos[1], group.position.y) + 0.6, info.pos[2], L);
      out.push({ id: 'bomb', label: '💣', kind: 'bomb', x: p.x, y: p.y, on: true, edge: p.edge, planted: info.state === 'planted', dist: p.dist });
    } else out.push({ id: 'bomb', label: '💣', kind: 'bomb', x: 0, y: 0, on: false, edge: false, planted: false, dist: null });
    return out;
  }

  function hud() {
    if (!info) return null;
    const L = me();
    const side = mySide(L);
    const nameOf = (id) => (info.carrier === id && info.carrierName ? info.carrierName : info.actorName && info.action && info.action.id === id ? info.actorName : '아군');
    const tx = bombTexts(side, info, { me: L && L.id, nameOf });
    let status = tx.status, tone = tx.tone;
    const a = info.action;
    const mineAct = !!(a && L && a.id === L.id);
    if (a && !mineAct && side && ((a.kind === 'plant' && side === 'attack') || (a.kind === 'defuse' && side === 'defense'))) {
      status = `${info.actorName || '아군'} ${a.kind === 'plant' ? '설치' : '해체'} 중…`;
    }
    let progress = null;
    const t = now();
    if (mineAct && info.phase === 'live') {
      const total = Math.max(1, a.totalMs || msFor(a.kind));
      const left = actionLeft();
      progress = { kind: a.kind, ratio: Math.min(1, Math.max(0, 1 - left / total)), label: `${a.kind === 'plant' ? '설치' : '해체'} 중… ${(left / 1000).toFixed(1)}초` };
    } else if (pending) {
      const total = msFor(pending.kind);
      const el = t - pending.at;
      progress = { kind: pending.kind, ratio: Math.min(0.98, el / total), label: `${pending.kind === 'plant' ? '설치' : '해체'} 중… ${(Math.max(0, total - el) / 1000).toFixed(1)}초` };
    }
    let prompt = '';
    const can = ability(L);
    if (can && !pending && !mineAct) {
      const verb = can === 'plant' ? '설치' : '해체';
      const secs = Math.round(msFor(can) / 1000);
      if (L && hspeed(L.vel) >= STILL_SPEED) prompt = `멈춘 채 ${L.touch ? `${verb} 버튼` : 'E'}을 누르고 있으면 ${verb}`;
      else prompt = L && L.touch ? `${verb} 버튼을 ${secs}초 누르고 있으세요` : `E 길게 눌러 ${verb} (${secs}초)`;
    }
    const left = explodeLeft();
    return {
      side, goal: tx.goal, status, tone,
      timer: left == null ? null : Math.max(0, left / 1000),
      carrying: !!(L && info.state === 'carried' && info.carrier === L.id),
      progress, prompt,
      markers: markers(L, side)
    };
  }

  function dispose() {
    for (const f of offs.splice(0)) { try { f(); } catch (e) { /* noop */ } }
    if (scene) scene.remove(group);
    for (const g of geos) g.dispose();
    for (const m of [bodyMat, trimMat, screenMat, ledMat, glowMat, ringMat]) m.dispose();
    syncTouch(null);
  }

  return {
    load, unload, reset, set, event, tick, frame, hud, onLocalFire, onLocalDeath, dispose,
    setCarrierListener(fn) { carrierCb = typeof fn === 'function' ? fn : null; },
    get carrier() { return lastCarrier; },
    get sites() { return sites.slice(); },
    get pending() { return pending ? { ...pending } : null; },
    get info() { return info ? { ...info } : null; }
  };
}

export default createBombView;
