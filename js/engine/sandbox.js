/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 코어 전용 연습장. 과녁 더미를 세워 사격 판정과 히트박스를 시연한다.
 */
/**
 * SKALA 작전 — 연습장(sandbox): 맵 위에 과녁 더미를 세우고 사격 판정을 시연한다.
 *
 * - 더미는 원격 아바타와 똑같이 avatars.push()로 10 Hz 스냅샷을 넣고 100 ms 지연 보간으로 그려진다
 *   → 히트박스도 화면에 보이는 위치 그대로(실제 멀티플레이와 같은 경로).
 * - 일부는 좌우로 움직이고(strafe), 일부는 제자리에서 앉았다 일어서고(bob: 앉은 자세·앉은 히트박스 시연),
 *   일부는 이모트 8종을 차례로 돌린다(emote: 원격 아바타 리그 재생 시연, 스냅샷 emote 번호).
 *   쓰러지면 2.5초 뒤 제자리에서 다시 선다.
 * - 피해는 'hit:player'(쏜 사람 = 로컬 플레이어)로 받는다 — 임시 총이든 무기 플러그인이든 같은 이벤트.
 *
 * bus 발행: sandbox:target-hit {id,name,part,damage,hp,dist,killed} · sandbox:target-down {id,name,part,dist}
 *           sandbox:stats {shots,hits,head,body,legs,kills,damage,accuracy,longest} · sandbox:targets {list}
 */
import { PLAYER, NET, EMOTES } from '../core/consts.js';
import { overlapsCapsule, lineOfSight, findFloor } from './physics.js';

const MAX_DUMMIES = 8;
const RESPAWN_MS = 2500;
const SEND_DT = 1 / NET.SEND_HZ;

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export function createSandbox(ctx) {
  const { bus, avatars, player } = ctx;
  const map = ctx.map;
  const world = map.world;
  const b = map.bounds;
  const offs = [];
  const dummies = [];
  const byId = new Map();
  const stats = { shots: 0, hits: 0, head: 0, body: 0, legs: 0, kills: 0, damage: 0, longest: 0 };
  const sp = player.spawnPoint;
  const eye = [sp.x, sp.y + PLAYER.EYE, sp.z];
  const fwdX = -Math.sin(sp.rotY), fwdZ = -Math.cos(sp.rotY);
  const rightX = Math.cos(sp.rotY), rightZ = -Math.sin(sp.rotY);
  const R = rng(1234 + Math.round(sp.x * 7 + sp.z * 13));

  const spots = [];
  function free(x, z, maxDy = 6) {
    if (x < b.minX + 1.2 || x > b.maxX - 1.2 || z < b.minZ + 1.2 || z > b.maxZ - 1.2) return null;
    if (Math.hypot(x - sp.x, z - sp.z) < 4) return null;
    const y = findFloor(world, x, z, { radius: 0.4 });
    if (!(y < 30) || Math.abs(y - sp.y) > maxDy) return null; // 탱크 지붕·상자 위 같은 곳은 제외
    if (overlapsCapsule(world, x, y, z, 0.42, PLAYER.HEIGHT)) return null;
    for (const s of spots) if (Math.hypot(s.x - x, s.z - z) < 2.6) return null;
    return y;
  }
  const visible = (x, y, z) => lineOfSight(world, eye, [x, y + 1.3, z]);

  // 1) 정면 사선: 7 · 12 · 18 · 26 · 40 m (보이는 곳만)
  for (const [d, lat] of [[7, 0], [12, -2.2], [18, 2.2], [26, -1], [40, 1.5]]) {
    const x = sp.x + fwdX * d + rightX * lat, z = sp.z + fwdZ * d + rightZ * lat;
    const y = free(x, z, 1.5);
    if (y == null || !visible(x, y, z)) continue;
    spots.push({ x, y, z });
  }
  // 2) 상대 팀 스폰 (먼 거리)
  for (const s of (map.spawns.charterer || [])) {
    if (spots.length >= MAX_DUMMIES - 1) break;
    const y = free(s.x, s.z);
    if (y != null) spots.push({ x: s.x, y, z: s.z });
  }
  // 3) 무작위로 보이는 곳
  for (let i = 0; i < 300 && spots.length < MAX_DUMMIES; i++) {
    const x = b.minX + 2 + R() * (b.maxX - b.minX - 4), z = b.minZ + 2 + R() * (b.maxZ - b.minZ - 4);
    const y = free(x, z);
    if (y != null && visible(x, y, z)) spots.push({ x, y, z });
  }

  // 더미 생성: 짝수 번째(가까운 곳)는 좌우 이동 시도
  spots.slice(0, MAX_DUMMIES).forEach((s, i) => {
    const dx = sp.x - s.x, dz = sp.z - s.z;
    const yaw = Math.atan2(-dx, -dz); // 플레이어를 바라봄
    const dist = Math.hypot(dx, dz);
    const d = {
      id: 'dummy-' + (i + 1),
      name: `더미 ${i + 1} · ${Math.round(dist)}m`,
      bx: s.x, by: s.y, bz: s.z, x: s.x, y: s.y, z: s.z, yaw,
      mode: 'stand', ax: 0, az: 0, range: 0, phase: R() * 6, speed: 0.9 + R() * 0.5,
      hp: PLAYER.HP, alive: true, moving: false, crouch: false, bobT: R() * 4, respawnAt: 0, sendT: R() * SEND_DT, dist
    };
    if (i % 4 === 2) d.mode = 'bob'; // 2.5초 서 있다가 2초 앉기를 반복
    if (i % 4 === 3) { d.mode = 'emote'; d.emoteIdx = i % EMOTES.length; d.emoteLeft = 0.5 + R(); } // 이모트 8종을 차례로
    if (i % 2 === 1) {
      // 시선에 수직인 축으로 ±2.4 m (양 끝이 비어 있고 같은 높이·사이에 벽 없음)
      const l = Math.hypot(dx, dz) || 1;
      const ax = -dz / l, az = dx / l, range = 2.4;
      const ends = [[s.x + ax * range, s.z + az * range], [s.x - ax * range, s.z - az * range]];
      const okEnds = ends.every(([x, z]) => {
        if (x < b.minX + 1 || x > b.maxX - 1 || z < b.minZ + 1 || z > b.maxZ - 1) return false;
        const y = findFloor(world, x, z, { radius: 0.4 });
        return Math.abs(y - s.y) < 0.05 && !overlapsCapsule(world, x, y, z, 0.42, PLAYER.HEIGHT);
      }) && lineOfSight(world, [ends[0][0], s.y + 0.5, ends[0][1]], [ends[1][0], s.y + 0.5, ends[1][1]]);
      if (okEnds) Object.assign(d, { mode: 'strafe', ax, az, range });
    }
    dummies.push(d);
    byId.set(d.id, d);
    avatars.add(d.id, { name: d.name, team: 'charterer' });
    avatars.teleport(d.id, snap(d));
  });

  function snap(d) {
    return { pos: [d.x, d.y, d.z], yaw: d.yaw, pitch: 0, alive: d.alive, moving: d.moving, crouch: d.crouch, emote: d.emote || 0, hp: d.hp, team: 'charterer', name: d.name };
  }

  function emitStats() {
    const accuracy = stats.shots ? Math.round((stats.hits / stats.shots) * 100) : 0;
    bus.emit('sandbox:stats', Object.assign({ accuracy }, stats));
  }
  function emitTargets() {
    bus.emit('sandbox:targets', { list: dummies.map((d) => ({ id: d.id, name: d.name, hp: d.hp, alive: d.alive, mode: d.mode, dist: Math.round(d.dist) })) });
  }

  offs.push(bus.on('weapon:fire', (e) => {
    if (e && e.shooterId === player.state.id) { stats.shots++; emitStats(); }
  }));
  offs.push(bus.on('hit:player', (e) => {
    if (!e || e.shooterId !== player.state.id) return;
    const d = byId.get(e.targetId);
    if (!d || !d.alive) return;
    const dmg = Math.max(0, Math.round(+e.damage || 0));
    d.hp = Math.max(0, d.hp - dmg);
    stats.hits++;
    if (stats[e.part] != null) stats[e.part]++;
    stats.damage += dmg;
    const dist = +e.dist || 0;
    const killed = d.hp <= 0;
    bus.emit('sandbox:target-hit', { id: d.id, name: d.name, part: e.part, damage: dmg, hp: d.hp, dist, killed, weapon: e.weapon });
    if (killed) {
      d.alive = false;
      d.moving = false;
      d.respawnAt = performance.now() + RESPAWN_MS;
      stats.kills++;
      stats.longest = Math.max(stats.longest, Math.round(dist));
      const av = avatars.get(d.id);
      if (av) av.kill({ dir: e.dir || null });
      avatars.push(d.id, performance.now(), snap(d));
      bus.emit('sandbox:target-down', { id: d.id, name: d.name, part: e.part, dist, weapon: e.weapon });
    }
    emitStats();
    emitTargets();
  }));

  function respawn(d) {
    d.hp = PLAYER.HP;
    d.alive = true;
    d.x = d.bx; d.y = d.by; d.z = d.bz;
    d.phase = 0;
    d.crouch = false;
    d.bobT = 0;
    d.emote = 0;
    avatars.teleport(d.id, Object.assign(snap(d), { respawned: true }));
    emitTargets();
  }

  function tick(dt) {
    const now = performance.now();
    for (const d of dummies) {
      if (!d.alive) {
        if (now >= d.respawnAt) respawn(d);
        continue;
      }
      if (d.mode === 'strafe') {
        d.phase += dt * d.speed * 1.6;
        const off = Math.sin(d.phase) * d.range;
        d.x = d.bx + d.ax * off;
        d.z = d.bz + d.az * off;
        d.moving = true;
      } else if (d.mode === 'emote') {
        // 이모트 하나를 4초(한 번형은 그 길이) 하고 1.5초 쉬기
        d.emoteLeft -= dt;
        if (d.emoteLeft <= 0) {
          if (d.emote) { d.emote = 0; d.emoteLeft = 1.5; }
          else {
            const e = EMOTES[d.emoteIdx % EMOTES.length];
            d.emoteIdx++;
            d.emote = e.code;
            d.emoteLeft = e.loop ? 4 : e.duration;
          }
          d.sendT = 0;
        }
      } else if (d.mode === 'bob') {
        d.bobT += dt;
        const c = d.bobT % 4.5 > 2.5;
        if (c !== d.crouch) { d.crouch = c; d.sendT = 0; } // 자세가 바뀌면 바로 전송
      }
      d.sendT -= dt;
      if (d.sendT <= 0) {
        d.sendT += SEND_DT;
        avatars.push(d.id, now, snap(d));
      }
    }
  }
  const offTick = ctx.loop.onTick(tick);

  emitStats();
  emitTargets();

  return {
    get dummies() { return dummies; },
    get stats() { return Object.assign({}, stats); },
    resetStats() { for (const k of Object.keys(stats)) stats[k] = 0; emitStats(); },
    respawnAll() { dummies.forEach(respawn); },
    dispose() {
      offTick();
      offs.forEach((o) => o()); offs.length = 0;
      for (const d of dummies) avatars.remove(d.id);
      dummies.length = 0;
      byId.clear();
    }
  };
}
