/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: dev/ui-demo.html에서 불러오는 QA 전용 UI 데모다. 목 데이터로 모든 화면을 띄우고 가짜 게임 루프로 HUD를 움직인다.
 */
// SKALA 작전 UI 데모(QA 전용) — dev/ui-demo.html 에서 로드
// 목 데이터로 모든 화면을 띄우고, HUD는 가짜 게임 루프로 움직인다.
// URL: ?screen=menu|menu-account|settings|controls|lobby|lobby-empty|lobby-loading|lobby-error|create|
//              room|room-guest|loadout|hud|hud-low|scope|scoreboard|results|pause
//              개인전: create-ffa|room-ffa|room-ffa-guest|loadout-ffa|hud-ffa|respawn|scoreboard-ffa|results-ffa
//              이모트: emotes-idle|emotes|emote-active
//              폭파 미션: create-bomb|room-bomb|hud-bomb|hud-bomb-plant|scoreboard-bomb|results-bomb
//      &bare=1(QA 패널 숨김) &mock=1(목 데이터만)
import { createUI, relativeAngle, emoteIndexAt } from './index.js';
import { h, MODE_NAME } from './dom.js';
import { multiKillTier } from '../game/multikill.js';

// ---------- 목 데이터 (실제 값은 maps/*, weapons/defs 담당이 제공) ----------
const MAPS = [
  { id: 'jetty', name: '원유 부두', nameEn: 'Crude Jetty', desc: '로딩암이 늘어선 잔교. 긴 부두는 저격, 펌프실은 근접전.' },
  { id: 'tankfarm', name: '탱크 팜', nameEn: 'Tank Farm', desc: '원통 저장탱크 사이 미로. 방유제 너머로 엄폐하라.', mission: true },
  { id: 'vlcc', name: 'VLCC 갑판', nameEn: 'VLCC Deck', desc: '초대형 유조선 갑판. 매니폴드 주변이 격전지.' },
];
const WEAPONS = [
  {
    id: 'sr_bolt', slot: 1, name: 'SK-7 저격소총', short: 'SK-7', icon: '🎯', tagline: '한 발로 끝내는 볼트 액션.',
    stats: [{ label: '피해', value: '어느 부위든 1발' }, { label: '탄약', value: '5 / 20' }, { label: '볼트', value: '1.2초' }, { label: '반샷', value: '줌 50% 이상' }],
    bars: { power: 100, rate: 12, accuracy: 95, mobility: 55 },
  },
  {
    id: 'ar_std', slot: 1, name: 'RX-4 돌격소총', short: 'RX-4', icon: '🔫', tagline: '묵직한 연사.',
    stats: [{ label: '연사', value: '600 rpm' }, { label: '피해', value: '머리 100 · 몸 30' }, { label: '탄약', value: '30 / 90' }, { label: '정조준', value: '2배 줌' }],
    bars: { power: 45, rate: 85, accuracy: 60, mobility: 75 },
  },
  { id: 'pt_std', slot: 2, name: 'P-9 권총', short: 'P-9', icon: '🔫' },
  { id: 'ml_knife', slot: 3, name: '호크빌 나이프', short: 'HAWKBILL', icon: '🔪' },
  { id: 'gr_frag', slot: 4, name: '수류탄', short: 'FRAG', icon: '💣' },
];
const MAG = { sr_bolt: [5, 20], ar_std: [30, 90], pt_std: [12, 36], ml_knife: [null, null], gr_frag: [1, 0] };
// 이모트 목록(MODES.md 4.1) — core/consts.js의 EMOTES가 있으면 그것을 쓴다
const EMOTES_MOCK = [
  { id: 'takeL', n: 1, name: 'L을 가져가', icon: '🫵' },
  { id: 'veggie', n: 2, name: '야채', icon: '🥬' },
  { id: 'sideToSide', n: 3, name: '사이드 스텝', icon: '↔️' },
  { id: 'crissCross', n: 4, name: '크리스 크로스', icon: '❌' },
  { id: 'tango', n: 5, name: '탱고', icon: '💃' },
  { id: 'salute', n: 6, name: '경례', icon: '🫡' },
  { id: 'wave', n: 7, name: '손 흔들기', icon: '👋' },
  { id: 'cheer', n: 8, name: '환호 박수', icon: '👏' },
];
let emoteItems = EMOTES_MOCK;
const OWNERS = ['번개J', '달빛', '새벽'];
const CHARTERERS = ['호랑이', '여우', '불꽃', '그림자'];
const ROOMS = [
  { roomId: 'k7q2', name: '야간 작전 3:3', mapId: 'jetty', hostName: '번개J', players: 3, max: 6, status: 'waiting' },
  { roomId: 'm3x9', name: '탱크 팜 3:3 고수만', mapId: 'tankfarm', hostName: '달빛', players: 6, max: 6, status: 'waiting', mode: 'team' },
  { roomId: 'p1z5', name: '점심 내기 개인전', mapId: 'vlcc', hostName: '불꽃', players: 5, max: 6, status: 'playing', mode: 'ffa' },
  { roomId: 'a8c4', name: '초보 환영 · 반샷 연습', mapId: 'jetty', hostName: '바람', players: 1, max: 4, status: 'waiting', mode: 'ffa', killTarget: 20 },
  { roomId: 'b2m7', name: '폭탄 해체반 모집', mapId: 'tankfarm', hostName: '새벽', players: 4, max: 6, status: 'playing', mode: 'bomb', ruleset: 'classic' },
];
const CHAT = [
  { system: true, text: '번개J님이 방을 만들었어요.' },
  { name: '번개J', team: 'owner', text: '끝쪽 저격 자리 조심하세요' },
  { name: '호랑이', team: 'charterer', text: '오른쪽으로 돌아서 들어갑시다' },
  { system: true, text: '여우님이 입장했어요.' },
];

// ---------- 가짜 게임 화면(캔버스) ----------
const canvas = document.getElementById('scene');
function drawScene() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = (canvas.width = Math.round(innerWidth * dpr));
  const hh = (canvas.height = Math.round(innerHeight * dpr));
  const g = canvas.getContext('2d');
  const hz = hh * 0.56;
  const sky = g.createLinearGradient(0, 0, 0, hz);
  sky.addColorStop(0, '#264653'); sky.addColorStop(0.62, '#f4a261'); sky.addColorStop(1, '#ffd6a5');
  g.fillStyle = sky; g.fillRect(0, 0, w, hz);
  g.fillStyle = 'rgba(255,214,165,.9)'; g.beginPath(); g.arc(w * 0.72, hz * 0.86, hh * 0.06, 0, Math.PI * 2); g.fill();
  const sea = g.createLinearGradient(0, hz, 0, hh);
  sea.addColorStop(0, '#2c4f6e'); sea.addColorStop(1, '#0f2238');
  g.fillStyle = sea; g.fillRect(0, hz, w, hh - hz);
  g.fillStyle = 'rgba(255,214,165,.18)';
  for (let i = 0; i < 26; i++) g.fillRect(w * 0.6 + Math.sin(i * 7) * w * 0.1, hz + i * 6 * dpr, w * 0.08 * (1 - i / 30), 2 * dpr);
  g.fillStyle = '#1b2a3a';
  [[0.05, 0.08, 0.1], [0.16, 0.06, 0.07], [0.82, 0.1, 0.12], [0.94, 0.07, 0.08]].forEach(([x, rw, rh]) => g.fillRect(w * x, hz - hh * rh, w * rw, hh * rh));
  g.fillRect(w * 0.3, hz - hh * 0.3, w * 0.008, hh * 0.3);
  g.fillStyle = '#f77f00'; g.beginPath(); g.ellipse(w * 0.304, hz - hh * 0.31, w * 0.006, hh * 0.02, 0, 0, Math.PI * 2); g.fill();
  // 바닥(원근)
  g.fillStyle = '#5b5f66';
  g.beginPath(); g.moveTo(w * 0.36, hz); g.lineTo(w * 0.64, hz); g.lineTo(w * 1.1, hh); g.lineTo(-w * 0.1, hh); g.closePath(); g.fill();
  g.strokeStyle = 'rgba(0,0,0,.25)'; g.lineWidth = 2 * dpr;
  for (let i = 1; i < 12; i++) { const t = i / 12; const y = hz + (hh - hz) * t * t; g.beginPath(); g.moveTo(w * (0.36 - 0.46 * t * t), y); g.lineTo(w * (0.64 + 0.46 * t * t), y); g.stroke(); }
  g.fillStyle = '#9b2226'; g.fillRect(w * 0.02, hh * 0.5, w * 0.2, hh * 0.32);
  g.fillStyle = 'rgba(0,0,0,.18)'; for (let i = 0; i < 9; i++) g.fillRect(w * (0.03 + i * 0.021), hh * 0.52, w * 0.006, hh * 0.28);
  g.strokeStyle = '#f2c14e'; g.lineWidth = 6 * dpr; g.beginPath(); g.moveTo(w * 0.78, hh * 0.62); g.lineTo(w * 0.98, hh * 0.6); g.stroke();
}
drawScene();
window.addEventListener('resize', drawScene);

// ---------- UI ----------
const ui = createUI(document.getElementById('stage'));

const qs = new URLSearchParams(location.search);
const bare = qs.get('bare') === '1';
const me = { id: 'me', name: '' };
let room = null; // 현재 방(목)
let mode = 'menu'; // 'menu' | 'game'
let sandbox = false;

// 이벤트 로그(QA)
const logList = h('ol', { class: 'qa-log', 'aria-label': '이벤트 로그' });
function log(action, payload) {
  let text = action;
  if (payload !== undefined) {
    try { text += ' ' + JSON.stringify(payload); } catch { /* 순환 참조 무시 */ }
  }
  logList.prepend(h('li', { text: text.length > 160 ? text.slice(0, 157) + '…' : text }));
  while (logList.children.length > 14) logList.lastElementChild.remove();
}
ui.on('*', (payload, action) => log(action, payload));

// ---------- 화면별 목 상태 ----------
function lobbyProps(extra = {}) { return { rooms: ROOMS, ...extra }; }

function makeRoom(asHost, roomMode = 'team') {
  const name = ui.getPlayerName() || '플레이어1234';
  me.name = name;
  const ffa = roomMode === 'ffa';
  const bomb = roomMode === 'bomb';
  const players = [
    { id: 'h', name: asHost ? name : '번개J', team: ffa ? null : 'owner', ready: true, ping: 24, host: true },
    { id: 'o2', name: '달빛', team: ffa ? null : 'owner', ready: true, ping: 61 },
    { id: 'c1', name: '호랑이', team: ffa ? null : 'charterer', ready: true, ping: 95 },
    { id: 'c2', name: '여우', team: ffa ? null : 'charterer', ready: true, ping: 172 },
  ];
  if (!asHost) players.push({ id: 'me', name, team: ffa ? null : 'charterer', ready: false, ping: 38 });
  room = {
    roomId: asHost ? 'n0w1' : 'k7q2', name: asHost ? `${name}의 방` : '야간 작전 3:3', mapId: bomb ? missionMapId() : 'jetty', max: 6,
    hostId: 'h', meId: asHost ? 'h' : 'me', players, chat: CHAT.slice(), mode: ffa ? 'ffa' : bomb ? 'bomb' : 'team', killTarget: ffa ? 20 : undefined,
    ruleset: bomb ? 'classic' : undefined,
  };
  return room;
}
function showRoom(asHost, roomMode) { ui.show('room', makeRoom(asHost, roomMode)); }
const myName = () => me.name || ui.getPlayerName() || '플레이어1234';

// 개인전 점수판·결과용 목 기록(여우·그림자은 동률 → 같은 순위)
function ffaPlayers() {
  return [
    { id: 'me', name: myName(), kills: game.ffa.kills, deaths: 4, head: 3, ping: 31, alive: !game.respawn, me: true, respawnIn: game.respawn ? game.respawn.seconds * 1000 : null, protect: game.protect },
    { id: 'b1', name: '하늘', kills: 12, deaths: 3, head: 6, ping: 45, alive: true },
    { id: 'b2', name: '호랑이', kills: 9, deaths: 6, head: 2, ping: 88, alive: false, respawnIn: 2100 },
    { id: 'b3', name: '여우', kills: 5, deaths: 8, head: 1, ping: 140, alive: true, bot: true },
    { id: 'b4', name: '그림자', kills: 5, deaths: 8, head: 1, ping: 20, alive: true, bot: true },
  ];
}

function statPlayers() {
  const mk = (name, team, i, alive) => ({ id: `${team}${i}`, name, team, kills: (7 - i * 2 + (team === 'owner' ? 1 : 0)) % 9, deaths: (i + 2) % 5, head: (i + 1) % 4, ping: 20 + i * 37, alive });
  return [
    { id: 'me', name: me.name || ui.getPlayerName() || '플레이어1234', team: 'owner', kills: 6, deaths: 2, head: 3, ping: 31, alive: true, me: true },
    ...OWNERS.map((n, i) => mk(n, 'owner', i, i !== 1)),
    ...CHARTERERS.map((n, i) => mk(n, 'charterer', i, i < 2)),
  ];
}

// 폭파 미션 점수판: 이번 라운드 공격 팀과 폭탄을 든 사람(번개J)
function bombBoard(mapId) {
  const attack = game.bomb ? game.bomb.attack : 'owner';
  const carrier = attack === 'owner' ? 'owner0' : 'charterer0';
  return { mode: 'bomb', attack, players: statPlayers().map((x) => (x.id === carrier ? { ...x, bomb: true } : x)), score: game.score, mapId };
}

// ---------- 가짜 게임 루프 ----------
const game = {
  hp: 100, slot: 1, primary: 'ar_std', ammo: { 1: 30, 2: 12, 3: null, 4: 1 }, reserve: { 1: 90, 2: 36, 3: null, 4: 0 },
  time: 120, spread: 0.012, zoom: 0, zoomTarget: 0, reload: null, score: { owner: 1, charterer: 1, target: 3, round: 3 },
  alive: { owner: 3, charterer: 2 }, teamSize: { owner: 4, charterer: 4 }, last: 0, tick: 0,
  // 개인전
  mode: 'team', ffa: { kills: 7, rank: 3, total: 5, leaderName: '하늘', leaderKills: 12, target: 20 },
  respawn: null, protect: false, protectT: 0, nextPrimary: null,
  // 폭파 미션(newBomb)
  bomb: null,
};

// ---------- 폭파 미션(목): 진영 패널 · 표식 · 설치/해체 막대 · 카운트다운 ----------
// 맵 목록(목 또는 maps/index.js) 중 폭파 미션 맵. 없으면 첫 맵
let mapData = MAPS;
const missionMapId = () => (mapData.find((m) => m && m.mission === true) || mapData[0] || { id: 'jetty' }).id;
/** view 'plant': 나(블루)는 공격, 폭탄을 들고 A 구역에서 설치 중. 'defuse': 나(블루)는 수비, A 구역에 설치된 폭탄을 해체 중 */
function newBomb(view = 'plant') {
  return view === 'defuse'
    ? { view, attack: 'charterer', planted: true, timer: 9.6, prog: 0.45 }
    : { view: 'plant', attack: 'owner', planted: false, timer: null, prog: 0.35 };
}
function bombHud() {
  const b = game.bomb;
  if (!b) return null;
  const W = innerWidth, H = innerHeight, bob = Math.sin(performance.now() / 650) * 6; // 시점이 흔들리는 것처럼 표식을 조금 움직인다
  const defuse = b.view === 'defuse';
  const markers = defuse
    ? [
      { id: 'A', label: 'A', kind: 'site', x: W * 0.36 + bob, y: H * 0.5, on: true, edge: false, planted: true, dist: 6 },
      { id: 'bomb', label: '💣', kind: 'bomb', x: W * 0.54 + bob, y: H * 0.62, on: true, edge: false, planted: true, dist: 1.2 },
      { id: 'B', label: 'B', kind: 'site', x: W - 30, y: H * 0.42, on: true, edge: true, planted: false, dist: 52 },
    ]
    : [
      { id: 'A', label: 'A', kind: 'site', x: W * 0.5 + bob, y: H * 0.58, on: true, edge: false, planted: false, dist: 2 },
      { id: 'B', label: 'B', kind: 'site', x: 30, y: H * 0.44, on: true, edge: true, planted: false, dist: 47 },
    ];
  const dur = defuse ? 5 : 3;
  return {
    side: defuse ? 'defense' : 'attack',
    goal: defuse ? '설치된 폭탄을 찾아 해체하세요' : 'A 또는 B 구역에 폭탄을 설치하세요',
    status: defuse ? '💣 A 구역에 폭탄이 설치됐어요' : '💣 내가 폭탄을 들고 있어요',
    tone: defuse ? 'warn' : 'attack',
    timer: b.planted ? b.timer : null,
    carrying: !defuse && !b.planted,
    progress: b.prog == null ? null : { kind: defuse ? 'defuse' : 'plant', ratio: b.prog, label: `${defuse ? '해체' : '설치'} 중… ${(dur * (1 - b.prog)).toFixed(1)}초` },
    prompt: defuse ? 'E를 누르고 있으면 해체' : 'E 길게 눌러 설치',
    markers,
  };
}
function slotsList() { return [game.primary, 'pt_std', 'ml_knife', game.ammo[4] > 0 ? 'gr_frag' : null]; }
function weaponIdForSlot(s) { return slotsList()[s - 1]; }
function setPrimary(id) {
  game.primary = id;
  const [mag, res] = MAG[id] || [30, 90];
  game.ammo[1] = mag; game.reserve[1] = res;
}
function hudState() {
  const wid = weaponIdForSlot(game.slot);
  const s = {
    hp: game.hp, ammo: game.ammo[game.slot], reserve: game.reserve[game.slot], mag: (MAG[wid] || [])[0],
    slot: game.slot, slots: slotsList(), spread: game.spread, roundTime: game.time, reload: game.reload,
    respawn: game.respawn, protect: game.protect, crosshair: !game.respawn,
    emote: emo.active, // 이모트 중이면 하단 안내 + 크로스헤어 자동 숨김
  };
  if (game.mode === 'ffa') {
    s.score = { mode: 'ffa', ...game.ffa };
    s.team = null;
  } else {
    const score = game.mode === 'bomb' ? { ...game.score, mode: 'bomb', attack: game.bomb ? game.bomb.attack : 'owner' } : game.score;
    Object.assign(s, { score, alive: game.alive, teamSize: game.teamSize, team: 'owner' });
  }
  s.bomb = game.mode === 'bomb' ? bombHud() : null;
  return s;
}
function loop(t) {
  const dt = Math.min(0.05, (t - (game.last || t)) / 1000);
  game.last = t;
  if (mode === 'game') {
    game.spread += (0.012 - game.spread) * Math.min(1, dt * 6);
    game.zoom += (game.zoomTarget - game.zoom) * Math.min(1, dt * 14);
    if (Math.abs(game.zoom - game.zoomTarget) < 0.002) game.zoom = game.zoomTarget;
    if (game.reload != null) {
      game.reload += dt / 1.6;
      if (game.reload >= 1) {
        const wid = weaponIdForSlot(game.slot);
        const need = (MAG[wid] || [0])[0] - game.ammo[game.slot];
        const take = Math.min(need, game.reserve[game.slot]);
        game.ammo[game.slot] += take; game.reserve[game.slot] -= take; game.reload = null;
      }
    }
    game.tick += dt;
    if (game.tick >= 1 && (game.mode === 'ffa' || !ui.isVisible('loadout'))) { game.tick = 0; game.time = Math.max(0, game.time - 1); }
    // 개인전 부활 → 보호
    if (game.respawn) {
      game.respawn.seconds -= dt;
      if (game.respawn.seconds <= 0) {
        game.respawn = null;
        game.hp = 100;
        if (game.nextPrimary) { setPrimary(game.nextPrimary); game.nextPrimary = null; }
        game.protect = true;
        game.protectT = 1.5;
      }
    }
    if (game.protectT > 0) { game.protectT -= dt; if (game.protectT <= 0) game.protect = false; }
    // 폭파 미션: 카운트다운이 0이 되면 35초로, 설치·해체 막대는 다 차면 처음부터(데모라 끝나지 않는다)
    const bomb = game.bomb;
    if (bomb && bomb.planted) { bomb.timer -= dt; if (bomb.timer <= 0) bomb.timer = 35; }
    if (bomb && bomb.prog != null) { bomb.prog += dt / (bomb.view === 'defuse' ? 5 : 3); if (bomb.prog >= 1) bomb.prog = 0; }
    ui.hud.set(hudState());
    ui.scope.set(game.slot === 1 && game.primary === 'sr_bolt' ? game.zoom : 0, 4);
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

function fire() {
  if (game.reload != null) return;
  const a = game.ammo[game.slot];
  if (a == null) { ui.hud.hitmarker(false); return; }
  if (a <= 0) { ui.hud.center('R 키로 재장전', 900); return; }
  game.ammo[game.slot] = a - 1;
  game.spread = Math.min(0.12, game.spread + (game.zoom > 0.5 ? 0.004 : 0.03));
  const r = Math.random();
  if (r < 0.15) {
    ui.hud.hitmarker(true, true);
    if (game.mode === 'ffa') {
      game.ffa.kills += 1;
      if (game.ffa.kills > game.ffa.leaderKills) Object.assign(game.ffa, { leaderName: myName(), leaderKills: game.ffa.kills, rank: 1 });
      ui.killfeed.push({ killer: myName(), victim: ['하늘', '호랑이', '여우', '그림자'][Math.floor(Math.random() * 4)], weaponId: weaponIdForSlot(game.slot), head: true, mode: 'ffa' });
    } else {
      ui.killfeed.push({ killer: myName(), victim: CHARTERERS[Math.floor(Math.random() * 4)], weaponId: weaponIdForSlot(game.slot), head: true, killerTeam: 'owner', victimTeam: 'charterer' });
    }
  } else if (r < 0.5) ui.hud.hitmarker(false);
  if (game.primary === 'sr_bolt' && game.slot === 1) game.zoomTarget = 0; // 볼트 후 자동 줌 해제
}
function ffaDie(killer = '호랑이', weaponName = 'RX-4 돌격소총', seconds = 3) {
  game.hp = 0;
  game.respawn = { seconds, killer, weaponName };
  game.ffa.rank = Math.min(game.ffa.total, game.ffa.rank + 1);
  ui.show('loadout', { compact: true, weapons: ['sr_bolt', 'ar_std'], selected: game.nextPrimary || game.primary });
}
function takeHit() {
  if (game.respawn || game.protect) return; // 부활 대기·보호 중에는 피해 없음
  if (emo.active) cancelEmote(); // 피해를 받으면 이모트 취소
  game.hp = Math.max(0, game.hp - 12);
  const self = { x: 0, z: 0 };
  const from = { x: Math.cos(Math.random() * 6.28) * 10, z: Math.sin(Math.random() * 6.28) * 10 };
  ui.hud.damageFrom(relativeAngle(self, 0, from));
  if (game.hp === 0 && game.mode === 'ffa') {
    ui.killfeed.push({ killer: '호랑이', victim: myName(), weaponId: 'ar_std', head: false, mode: 'ffa' });
    ffaDie();
    return;
  }
  if (game.hp === 0) {
    ui.killfeed.push({ killer: '불꽃', victim: me.name || ui.getPlayerName(), weaponId: 'ar_std', head: false, killerTeam: 'charterer', victimTeam: 'owner' });
    ui.hud.center('전사', 1800, { sub: '다음 라운드를 기다리세요' });
    ui.hud.set({ spectate: '번개J' });
  }
}
function demoKillfeed() {
  if (game.mode === 'ffa') {
    [
      { killer: '하늘', victim: '여우', weaponId: 'sr_bolt', head: true },
      { killer: '호랑이', victim: '그림자', weaponId: 'ar_std', head: false },
      { killer: myName(), victim: '하늘', weaponId: 'pt_std', head: true },
      { killer: '그림자', victim: '그림자', weaponId: 'gr_frag', head: false },
    ].forEach((x, i) => setTimeout(() => ui.killfeed.push({ ...x, mode: 'ffa' }), i * 120));
    return;
  }
  const k = [
    { killer: '번개J', victim: '여우', weaponId: 'sr_bolt', head: true, killerTeam: 'owner', victimTeam: 'charterer' },
    { killer: '호랑이', victim: '새벽', weaponId: 'ar_std', head: false, killerTeam: 'charterer', victimTeam: 'owner' },
    { killer: '달빛', victim: '그림자', weaponId: 'ml_knife', head: false, killerTeam: 'owner', victimTeam: 'charterer' },
    { killer: '불꽃', victim: '불꽃', weaponId: 'gr_frag', head: false, killerTeam: 'charterer', victimTeam: 'charterer' },
    { killer: me.name || ui.getPlayerName(), victim: '호랑이', weaponId: 'pt_std', head: true, killerTeam: 'owner', victimTeam: 'charterer' },
  ];
  k.forEach((x, i) => setTimeout(() => ui.killfeed.push(x), i * 120));
}
// 연속 킬: 누를 때마다 다음 단계(더블 킬 → … → 헥사 킬 → 당신은 전설입니다 → 처음부터)
let demoMulti = 1;
function demoMultiKill() {
  demoMulti = demoMulti >= 7 ? 2 : demoMulti + 1;
  const t = multiKillTier(demoMulti);
  ui.hud.multiKill({ id: t.id, title: t.title, sub: t.id === 'legend' ? `${demoMulti}연속 처치` : '' });
}

// ---------- 이모트 휠 흉내(엔진 역할): B 누르고 있기 → 마우스로 고르고 떼기, 안 움직이고 떼면 아무것도 안 함 ----------
const emo = { open: false, cursor: { x: 0, y: 0 }, active: null };
const moveKeys = new Set();
const WHEEL_R = 160; // 가상 커서는 이 반지름 테두리에 붙는다(core와 같은 값)
const emoteSel = () => emoteIndexAt(emo.cursor.x, emo.cursor.y, emoteItems.length);
function openWheel(cursor = { x: 0, y: 0 }) {
  emo.open = true;
  emo.cursor = cursor;
  ui.show('emotes', { items: emoteItems, cursor: emo.cursor, selected: emoteSel() });
}
function closeWheel(pick) {
  if (!emo.open) return;
  emo.open = false;
  const i = emoteSel();
  ui.hide('emotes');
  if (!pick || i == null) return; // 그냥 떼면 취소
  if (moveKeys.size) { ui.hud.center('멈춘 상태에서만 할 수 있어요', 1400, { tone: 'warn' }); return; }
  emo.active = { name: emoteItems[i].name, icon: emoteItems[i].icon };
}
function cancelEmote() { emo.active = null; }

function startGame(opts = {}) {
  mode = 'game';
  const ffa = opts.mode === 'ffa';
  const bomb = opts.mode === 'bomb';
  emo.open = false;
  emo.active = null;
  ui.hide('emotes');
  Object.assign(game, {
    mode: ffa ? 'ffa' : bomb ? 'bomb' : 'team', hp: opts.hp != null ? opts.hp : 100, time: ffa ? 300 : bomb ? 100 : 120, zoom: 0, zoomTarget: 0, reload: null, slot: 1,
    respawn: null, protect: false, protectT: 0, nextPrimary: null, bomb: bomb ? newBomb(opts.bombView) : null,
  });
  if (ffa) game.ffa = { kills: 7, rank: 3, total: 5, leaderName: '하늘', leaderKills: 12, target: 20 }; // ffaPlayers()와 같은 순위
  ui.hud.reset();
  ui.show('hud', hudState());
  if (opts.loadout !== false) {
    ui.show('loadout', ffa
      ? { weapons: ['sr_bolt', 'ar_std'], seconds: 5, title: '개인전 · 첫 출격 무기', selected: game.primary }
      : { weapons: ['sr_bolt', 'ar_std'], seconds: 5, round: game.score.round, selected: game.primary });
  }
}

// ---------- 액션 처리(엔진 흉내) ----------
ui.on('menu:sandbox', () => { sandbox = true; startGame(); });
ui.on('menu:multi', ({ name }) => {
  me.name = name;
  ui.show('lobby', lobbyProps({ loading: true, rooms: [] }));
  setTimeout(() => ui.isVisible('lobby') && ui.update('lobby', { loading: false, rooms: ROOMS }), 700);
});
ui.on('lobby:refresh', () => {
  ui.update('lobby', { loading: true, error: null });
  setTimeout(() => ui.isVisible('lobby') && ui.update('lobby', { loading: false, rooms: ROOMS }), 600);
});
ui.on('lobby:back', () => ui.show('menu'));
ui.on('lobby:create', ({ name, mapId, max, mode: roomMode, killTarget }) => { const r = makeRoom(true, roomMode); Object.assign(r, { name, mapId, max }, roomMode === 'ffa' ? { killTarget } : {}); ui.show('room', r); });
ui.on('lobby:join', ({ roomId }) => {
  ui.update('lobby', { joining: roomId });
  setTimeout(() => { if (ui.isVisible('lobby')) { ui.update('lobby', { joining: null }); showRoom(false); } }, 500);
});
ui.on('room:team', ({ team }) => {
  room.players = room.players.map((p) => (p.id === room.meId ? { ...p, team, ready: p.host } : p));
  room.chat = [...room.chat, { system: true, text: `${me.name}님이 ${team === 'owner' ? '블루' : '레드'} 팀으로 이동했어요.` }];
  ui.update('room', { players: room.players, chat: room.chat });
});
ui.on('room:ready', ({ ready }) => { room.players = room.players.map((p) => (p.id === room.meId ? { ...p, ready } : p)); });
ui.on('room:map', ({ mapId }) => {
  room.mapId = mapId;
  room.chat = [...room.chat, { system: true, text: `맵이 ${MAPS.find((m) => m.id === mapId).name}(으)로 바뀌었어요.` }];
  ui.update('room', { mapId, chat: room.chat });
});
ui.on('room:chat', ({ text }) => {
  const mine = room.players.find((p) => p.id === room.meId);
  room.chat = [...room.chat, { name: me.name, team: mine && mine.team, text }];
  ui.update('room', { chat: room.chat });
});
ui.on('room:mode', ({ mode: roomMode }) => {
  // 세션 흉내: 개인전이면 팀 배정을 지우고, 팀전·폭파 미션이면 번갈아 배정. 폭파 미션은 클래식 규칙과 미션 맵으로 맞춘다
  room.mode = roomMode;
  room.killTarget = roomMode === 'ffa' ? room.killTarget || 20 : room.killTarget;
  if (roomMode === 'bomb') {
    room.ruleset = 'classic';
    if (!mapData.some((m) => m.id === room.mapId && m.mission === true)) room.mapId = missionMapId();
  }
  room.players = room.players.map((p, i) => ({ ...p, team: roomMode === 'ffa' ? null : i % 2 ? 'charterer' : 'owner', ready: p.host }));
  room.chat = [...room.chat, { system: true, text: `방장이 ${MODE_NAME[roomMode] || '팀전'}으로 바꿨어요.` }];
  ui.update('room', { mode: room.mode, killTarget: room.killTarget, ruleset: room.ruleset, mapId: room.mapId, players: room.players, chat: room.chat });
});
ui.on('room:killTarget', ({ killTarget }) => {
  room.killTarget = killTarget;
  room.chat = [...room.chat, { system: true, text: `목표 킬이 ${killTarget}킬로 바뀌었어요 · 먼저 ${killTarget}킬을 채우면 우승` }];
  ui.update('room', { killTarget, chat: room.chat });
});
ui.on('room:leave', () => ui.show('lobby', lobbyProps()));
ui.on('room:start', ({ mode: roomMode }) => {
  sandbox = false;
  if (roomMode !== 'ffa') game.score = { owner: 0, charterer: 0, target: 3, round: 1 };
  startGame({ mode: roomMode });
});
ui.on('loadout:pick', ({ id }) => {
  if (game.mode === 'ffa') {
    if (game.respawn) { game.nextPrimary = id; return; } // 죽어 있는 동안: 다음 부활부터
    setPrimary(id);
    ui.hud.center('개인전 시작!', 1600, { sub: '모두가 적 · 먼저 20킬' });
    return;
  }
  setPrimary(id);
  const versus = game.mode === 'bomb' ? `폭파 미션 · ${game.bomb && game.bomb.attack === 'charterer' ? '레드' : '블루'} 공격` : '블루 vs 레드 · 팀 섬멸전';
  ui.hud.center(`라운드 ${game.score.round}`, 1600, { sub: game.score.owner === 2 || game.score.charterer === 2 ? '매치 포인트' : versus });
});
ui.on('pause:resume', () => {});
ui.on('pause:leave', () => { mode = 'menu'; if (sandbox || !room) ui.show('menu'); else ui.show('room', room); });
ui.on('results:back', () => { mode = 'menu'; if (room) ui.show('room', room); else ui.show('menu'); });
ui.on('results:lobby', () => { mode = 'menu'; ui.show('lobby', lobbyProps()); });

// 게임 입력 흉내(HUD가 보이고 커서 화면이 없을 때만)
const playing = () => mode === 'game' && ui.isVisible('hud') && !ui.needsCursor();
window.addEventListener('keydown', (e) => {
  if (ui.isTyping()) return;
  if (e.code === 'Tab' && mode === 'game' && ui.isVisible('hud') && !ui.isVisible('pause')) {
    e.preventDefault();
    if (game.mode === 'ffa') ui.show('scoreboard', { mode: 'ffa', target: game.ffa.target, players: ffaPlayers(), mapId: room ? room.mapId : 'jetty' });
    else if (game.mode === 'bomb') ui.show('scoreboard', bombBoard(room ? room.mapId : missionMapId()));
    else ui.show('scoreboard', { players: statPlayers(), score: game.score, mapId: room ? room.mapId : 'jetty' });
    return;
  }
  if (e.code === 'Escape' && emo.open) { closeWheel(false); return; } // Esc: 아무것도 안 하고 닫기
  if (e.code === 'Escape' && playing()) { ui.show('pause', { leaveLabel: sandbox ? '연습장 나가기' : '방 나가기' }); return; }
  if (/^Key[WASD]$/.test(e.code)) moveKeys.add(e.code);
  if (!playing() || e.repeat) return;
  if (e.code === 'KeyB') {
    if (emo.active) cancelEmote(); // B 다시 누름 = 취소
    else if (!emo.open && !game.respawn) openWheel();
    return;
  }
  if (emo.open) return; // 휠이 열린 동안 다른 입력은 막는다
  if (emo.active && /^(Key[WASDRC]|Space|Digit[1-4]|ControlLeft|ControlRight)$/.test(e.code)) cancelEmote();
  if (/^Digit[1-4]$/.test(e.code)) { game.slot = Number(e.code.slice(5)); game.zoomTarget = 0; game.reload = null; }
  if (e.code === 'KeyR' && game.ammo[game.slot] != null && game.reserve[game.slot] > 0) game.reload = 0;
  if (e.code === 'KeyH') takeHit();
  if (e.code === 'KeyK') demoKillfeed();
  if (e.code === 'KeyM') demoMultiKill();
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'Tab') ui.hide('scoreboard');
  if (/^Key[WASD]$/.test(e.code)) moveKeys.delete(e.code);
  if (e.code === 'KeyB') closeWheel(true); // 떼면 강조된 칸 시작(없으면 아무것도 안 함)
});
// 휠이 열린 동안 마우스 이동(상대값)은 가상 커서로 간다
window.addEventListener('mousemove', (e) => {
  if (!emo.open) return;
  let x = emo.cursor.x + (e.movementX || 0);
  let y = emo.cursor.y + (e.movementY || 0);
  const d = Math.hypot(x, y);
  if (d > WHEEL_R) { x = (x / d) * WHEEL_R; y = (y / d) * WHEEL_R; }
  emo.cursor = { x, y };
  ui.update('emotes', { cursor: emo.cursor, selected: emoteSel() });
});
const stage = document.getElementById('stage');
stage.addEventListener('contextmenu', (e) => { if (mode === 'game') e.preventDefault(); });
stage.addEventListener('mousedown', (e) => {
  if (!playing() || e.target.closest('.sk-page, .sk-overlay, .qa')) return;
  if (emo.open) { closeWheel(e.button === 0); return; } // 좌클릭 = 바로 시작, 우클릭 = 닫기
  if (emo.active) { cancelEmote(); return; } // 클릭하면 이모트 취소(사격 안 함)
  if (e.button === 0) fire();
  if (e.button === 2) game.zoomTarget = ui.getSettings().zoomMode === 'toggle' && game.zoomTarget > 0 ? 0 : 1;
});
stage.addEventListener('mouseup', (e) => { if (e.button === 2 && ui.getSettings().zoomMode === 'hold') game.zoomTarget = 0; });

// ---------- 시나리오 ----------
const clickIn = (sel) => setTimeout(() => { const b = document.querySelector(sel); if (b) b.click(); }, 30);
const SCENES = {
  menu: () => { mode = 'menu'; ui.show('menu'); },
  'menu-account': () => { mode = 'menu'; ui.show('menu', { name: '홍길동', account: true }); },
  settings: () => { SCENES.menu(); clickIn('.sk-menu .sk-menu-btn--sub'); },
  controls: () => { SCENES.menu(); clickIn('.sk-menu .sk-menu-btn--sub:nth-of-type(4)'); },
  lobby: () => { mode = 'menu'; ui.show('lobby', lobbyProps()); },
  'lobby-empty': () => { mode = 'menu'; ui.show('lobby', { rooms: [] }); },
  'lobby-loading': () => { mode = 'menu'; ui.show('lobby', { rooms: [], loading: true }); },
  'lobby-error': () => { mode = 'menu'; ui.show('lobby', { rooms: [], error: '로비 서버(Supabase)에 연결할 수 없어요.' }); },
  create: () => { SCENES.lobby(); clickIn('.sk-lobby .sk-bar-actions .sk-btn--primary'); },
  room: () => { mode = 'menu'; showRoom(true); },
  'room-guest': () => { mode = 'menu'; showRoom(false); },
  loadout: () => startGame(),
  hud: () => {
    startGame({ loadout: false });
    setPrimary('ar_std');
    game.ammo[1] = 7; game.time = 83;
    demoKillfeed();
    ui.hud.center('블루 팀 라운드 승리', 60000, { sub: '블루 2 : 1 레드 · 매치 포인트' });
    game.score = { owner: 2, charterer: 1, target: 3, round: 4 };
    setTimeout(() => ui.hud.hitmarker(true), 700);
  },
  'hud-low': () => { startGame({ loadout: false, hp: 18 }); setTimeout(() => ui.hud.damageFrom(-1.2), 400); },
  scope: () => { startGame({ loadout: false }); setPrimary('sr_bolt'); game.zoomTarget = 1; game.zoom = 1; },
  scoreboard: () => { startGame({ loadout: false }); ui.show('scoreboard', { players: statPlayers(), score: game.score, mapId: 'tankfarm' }); },
  results: () => {
    mode = 'menu';
    makeRoom(true);
    ui.show('results', {
      winner: 'owner', score: { owner: 3, charterer: 1 }, myTeam: 'owner', mapId: 'vlcc',
      rounds: [{ winner: 'owner', reason: '섬멸' }, { winner: 'charterer', reason: '시간 종료 · 생존자 수' }, { winner: 'owner', reason: '섬멸' }, { winner: 'owner', reason: '시간 종료 · 체력 합' }],
      players: statPlayers(),
    });
  },
  pause: () => { startGame({ loadout: false }); ui.show('pause'); },
  // ----- 개인전(FFA) -----
  'create-ffa': () => {
    SCENES.lobby();
    clickIn('.sk-lobby .sk-bar-actions .sk-btn--primary');
    setTimeout(() => { const b = document.querySelector('.sk-create .sk-mode-btn[data-mode="ffa"]'); if (b) b.click(); }, 80);
  },
  'room-ffa': () => { mode = 'menu'; showRoom(true, 'ffa'); },
  'room-ffa-guest': () => { mode = 'menu'; showRoom(false, 'ffa'); },
  'loadout-ffa': () => startGame({ mode: 'ffa' }),
  'hud-ffa': () => {
    startGame({ loadout: false, mode: 'ffa' });
    game.time = 247;
    game.protect = true;
    game.protectT = 600; // 스크린샷용으로 길게
    demoKillfeed();
  },
  respawn: () => {
    startGame({ loadout: false, mode: 'ffa' });
    ui.killfeed.push({ killer: '하늘', victim: myName(), weaponId: 'sr_bolt', head: true, mode: 'ffa' });
    ffaDie('하늘', 'SK-7 저격소총', 3.4);
  },
  'scoreboard-ffa': () => {
    startGame({ loadout: false, mode: 'ffa' });
    ui.show('scoreboard', { mode: 'ffa', target: 20, players: ffaPlayers(), mapId: 'vlcc' });
  },
  'results-ffa': () => {
    mode = 'menu';
    makeRoom(true, 'ffa');
    ui.show('results', {
      mode: 'ffa', winnerId: 'b1', reason: 'kills', target: 20, mapId: 'tankfarm',
      ranking: [
        { rank: 1, id: 'b1', name: '하늘', kills: 20, deaths: 5, head: 9 },
        { rank: 2, id: 'me', name: myName(), kills: 14, deaths: 6, head: 4, me: true },
        { rank: 3, id: 'b2', name: '호랑이', kills: 11, deaths: 9, head: 3 },
        { rank: 4, id: 'b3', name: '여우', kills: 6, deaths: 12, head: 1, bot: true },
        { rank: 5, id: 'b4', name: '그림자', kills: 4, deaths: 13, head: 0, bot: true },
      ],
    });
  },
};
// ----- 폭파 미션 -----
SCENES['create-bomb'] = () => {
  SCENES.lobby();
  clickIn('.sk-lobby .sk-bar-actions .sk-btn--primary');
  setTimeout(() => { const b = document.querySelector('.sk-create .sk-mode-btn[data-mode="bomb"]'); if (b) b.click(); }, 80);
};
SCENES['room-bomb'] = () => { mode = 'menu'; showRoom(true, 'bomb'); };
// 수비: 설치된 폭탄 해체 중(진영 패널 · 10초 밑 카운트다운 · 설치된 표식 · 가장자리 표식 · 해체 막대 · 안내)
SCENES['hud-bomb'] = () => {
  startGame({ loadout: false, mode: 'bomb', bombView: 'defuse' });
  game.score = { owner: 1, charterer: 1, target: 3, round: 3 };
  game.time = 41;
};
// 공격: 폭탄을 들고 A 구역에서 설치 중(폭탄 소지 · 설치 막대 · 안내 · 가장자리 B 표식)
SCENES['hud-bomb-plant'] = () => {
  startGame({ loadout: false, mode: 'bomb', bombView: 'plant' });
  game.score = { owner: 0, charterer: 1, target: 3, round: 2 };
  game.time = 64;
};
SCENES['scoreboard-bomb'] = () => {
  startGame({ loadout: false, mode: 'bomb', bombView: 'plant' });
  game.score = { owner: 1, charterer: 0, target: 3, round: 2 };
  ui.show('scoreboard', bombBoard(missionMapId()));
};
SCENES['results-bomb'] = () => {
  mode = 'menu';
  makeRoom(true, 'bomb');
  ui.show('results', {
    mode: 'bomb', winner: 'owner', score: { owner: 3, charterer: 2 }, myTeam: 'owner', mapId: missionMapId(),
    rounds: [
      { round: 1, winner: 'owner', reason: '폭탄 폭파', reasonCode: 'bomb', attack: 'owner' },
      { round: 2, winner: 'charterer', reason: '폭탄 해체', reasonCode: 'defuse', attack: 'owner' },
      { round: 3, winner: 'charterer', reason: '전멸', reasonCode: 'elimination', attack: 'charterer' },
      { round: 4, winner: 'owner', reason: '시간 종료', reasonCode: 'time', attack: 'charterer' },
      { round: 5, winner: 'owner', reason: '폭탄 해체', reasonCode: 'defuse', attack: 'charterer' },
    ],
    players: statPlayers(),
  });
};
// ----- 이모트 휠 -----
SCENES['emotes-idle'] = () => { startGame({ loadout: false }); openWheel({ x: 0, y: 0 }); }; // 안 움직임 → 안내 문구
SCENES.emotes = () => { startGame({ loadout: false }); openWheel({ x: 18, y: 118 }); }; // 6시 방향 → 탱고 강조
SCENES['emote-active'] = () => { startGame({ loadout: false }); emo.active = { name: emoteItems[4].name, icon: emoteItems[4].icon }; };

const TOUR = ['menu', 'settings', 'controls', 'lobby', 'lobby-empty', 'create', 'room', 'room-guest', 'loadout', 'hud', 'hud-low', 'scope', 'scoreboard', 'results', 'pause',
  'create-ffa', 'room-ffa', 'room-ffa-guest', 'loadout-ffa', 'hud-ffa', 'respawn', 'scoreboard-ffa', 'results-ffa',
  'create-bomb', 'room-bomb', 'hud-bomb', 'hud-bomb-plant', 'scoreboard-bomb', 'results-bomb',
  'emotes-idle', 'emotes', 'emote-active'];
let tourTimer = null;
function tour(i = 0) {
  clearTimeout(tourTimer);
  if (i >= TOUR.length) return;
  go(TOUR[i]);
  tourTimer = setTimeout(() => tour(i + 1), 2600);
}
function go(name) {
  for (const s of ['scoreboard', 'pause', 'loadout', 'emotes']) ui.hide(s);
  emo.open = false;
  emo.active = null;
  document.querySelectorAll('.sk-modal:not([hidden]) .sk-btn--icon').forEach((b) => b.click());
  (SCENES[name] || SCENES.menu)();
}

// ---------- QA 패널 ----------
if (!bare) {
  const b = (label, fn) => h('button', { type: 'button', onclick: fn }, label);
  const panel = h('aside', { class: 'qa', 'aria-label': 'QA 패널' },
    h('div', { class: 'qa-head' },
      h('strong', { text: 'QA · UI 데모' }),
      b('접기', () => panel.classList.toggle('is-min'))),
    h('div', { class: 'qa-body' },
      h('p', { class: 'qa-label', text: '화면' }),
      h('div', { class: 'qa-grid' }, Object.keys(SCENES).map((k) => b(k, () => go(k)))),
      h('p', { class: 'qa-label', text: 'HUD 동작' }),
      h('div', { class: 'qa-grid' },
        b('히트', () => ui.hud.hitmarker(false)),
        b('헤드샷', () => ui.hud.hitmarker(true)),
        b('피격(H)', () => (mode === 'game' ? takeHit() : null)),
        b('킬피드(K)', demoKillfeed),
        b('연속 킬(M)', demoMultiKill),
        b('매치 포인트', () => ui.hud.center('매치 포인트', 2000, { sub: '블루 2 : 2 레드' })),
        b('레드 승리', () => ui.hud.center('레드 팀 라운드 승리', 2000)),
        b('체력 회복', () => { game.hp = 100; ui.hud.set({ spectate: null }); }),
        b('전체 공지', () => (ui.notice.current() ? ui.notice.hide() : ui.notice.show({ id: 'demo', text: '오늘 밤 9시에 팀전 한 판 합니다! 로비에서 만나요.', ms: 8000 }))),
        b('힌트 토글', () => ui.hud.set({ hint: document.querySelector('.sk-hint[hidden]') ? '화면을 클릭하면 조작을 시작해요' : '' }))),
      h('p', { class: 'qa-label', text: '자동' }),
      h('div', { class: 'qa-grid' }, b('▶ 전체 투어', () => tour(0)), b('■ 정지', () => clearTimeout(tourTimer))),
      h('p', { class: 'qa-help', text: 'HUD에서: 좌클릭 사격 · 우클릭 줌(SK-7) · 1~4 슬롯 · R 재장전 · Tab 점수판 · Esc 일시정지 · B 누르고 있기 = 이모트 휠(마우스로 고르고 떼기, WASD로 취소)' }),
      h('p', { class: 'qa-label', text: '이벤트 로그' }),
      logList));
  if (innerWidth < 700) panel.classList.add('is-min');
  document.body.append(panel);
}

window.addEventListener('pagehide', (e) => { if (!e.persisted) ui.dispose(); });

// 실제 무기 정의·맵 목록이 있으면 그것을 쓰고(통합 확인), 없거나 실패하면 목 데이터. ?mock=1이면 항상 목 데이터.
async function boot() {
  let weapons = WEAPONS;
  let maps = MAPS;
  const src = [];
  if (qs.get('mock') !== '1') {
    try {
      const m = await import('../weapons/defs.js');
      if (m.WEAPONS && typeof m.WEAPONS === 'object') { weapons = m.WEAPONS; src.push('weapons/defs.js'); }
    } catch (e) { console.info('[demo] weapons/defs.js 대신 목 데이터 사용:', e.message); }
    try {
      const m = await import('../maps/index.js');
      if (Array.isArray(m.MAP_LIST) && m.MAP_LIST.length) { maps = m.MAP_LIST; src.push('maps/index.js'); }
    } catch (e) { console.info('[demo] maps/index.js 대신 목 데이터 사용:', e.message); }
    try {
      const m = await import('../core/consts.js');
      const E = m.EMOTES;
      const arr = Array.isArray(E) ? E : E && typeof E === 'object' ? Object.values(E) : [];
      if (arr.length) {
        emoteItems = arr.filter(Boolean).map((e, i) => ({ id: String(e.id), n: e.code != null ? e.code : e.n != null ? e.n : i + 1, name: e.name || e.id, icon: e.icon || '' }));
        src.push('core/consts.js EMOTES');
      }
    } catch (e) { console.info('[demo] core/consts.js 대신 목 이모트 사용:', e.message); }
  }
  mapData = maps;
  ui.setMaps(maps).setWeapons(weapons);
  log('demo:data', src.length ? src.join(', ') : '목 데이터');
  go(qs.get('screen') || 'menu');
}
boot();
