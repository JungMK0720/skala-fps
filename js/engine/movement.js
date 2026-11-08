/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 로컬 플레이어의 Quake 계열 이동 계산(지면 마찰·가속, 공중 스트레이프, 버니합, A/D 교체 보너스, 속도 상한).
 *          수평 속도만 정하고 충돌과 수직 이동은 physics.moveCharacter에 맡긴다. three.js·DOM 의존 없음.
 */
/**
 * SKALA 작전 — 플레이어 이동 (docs/DESIGN.md 4절). 봇은 이 파일을 쓰지 않는다.
 *
 *   const ev = moveQuake(world, body, wish, dt, opt);
 *   wish = { dirX, dirZ, speed, jump, strafeSign }
 *     dirX·dirZ   단위 방향(입력이 없으면 0)
 *     speed       목표 지면 속도(m/s). 앉기·천천히 걷기·speedScale이 이미 반영된 값
 *     jump        뛰고 싶다. 땅이면 이번 틱에 뛴다. 공중이면 "착지하면 바로 뛴다"는 예고라서 착지 틱의 ev.hopped를 켠다
 *     strafeSign  A = -1, D = +1, 둘 다이거나 없으면 0
 *   opt = moveCharacter의 opt(height 등) + { move }   move: MOVE 대신 쓸 값(튜닝·테스트용)
 *   ev  = moveCharacter의 ev + { hopped, swapBonus, speed }
 *     jumped     실제로 땅을 떠났을 때만 true(챌판 위로 올라섰거나 머리가 바로 막혀 땅에 남으면 false, 다음 틱에 다시 시도한다)
 *     hopped     버니합 사슬이다: 착지 직후(HOP_GRACE 안)의 점프이거나, 곧바로 다시 뛸 착지
 *     swapBonus  이번 틱에 A/D 교체로 더한 속도(m/s)
 *     speed      이동이 끝난 뒤의 수평 속력(m/s)
 *
 * 틱 사이의 기억(착지 후 경과 시간, 마지막 A/D 방향)은 body.moveMem에 둔다. 스폰·순간이동 때 resetMoveMemory(body)를 부른다.
 *
 * 튜닝 메모(값과 이유는 core/consts.js의 MOVE). 공중 가속은 "목표 방향 성분이 AIR_WISH_CAP(c)보다 작을 때만" 더하므로
 *   - 이동 방향과 c/v의 코사인을 이루는 각(v = 11 m/s, c = 1.5면 약 82°)보다 안쪽을 보면 가속이 0이다.
 *   - 마우스가 그 각을 유지하며 돌면 속도는 "c × 돌린 라디안"만큼 는다(AIR_ACCEL과 무관). 착지 때 방향을 바꾸는 손실까지 치면
 *     한 번 뛰는 동안 45° 돌릴 때 약 +1 m/s.
 *   - AIR_ACCEL은 따라갈 수 있는 마우스 속도의 한계를 정한다(틱당 AIR_ACCEL × c × dt / v 라디안). 낮추면 큰 스윙이 오히려 감속이 된다.
 */
import { MOVE, PLAYER } from '../core/consts.js';
import { moveCharacter, getGroundY } from './physics.js';

// 시간 비교 여유: 1/60을 15번 더하면 0.25보다 살짝 작아서, 틱에 딱 맞춘 간격이 한 틱 밀리지 않게 한다
const TIME_EPS = 1e-9;
// 발이 바닥에서 이만큼(m) 안이면 "거의 땅"으로 본다. 점프로 내려앉는 속도(6.3 m/s)의 한 틱 거리와 비슷하게 잡았다
const NEAR_FLOOR_GAP = 0.11;

function newMemory() {
  // sinceLand는 Infinity로 시작한다: 스폰 직후의 첫 점프는 버니합이 아니고, 첫 틱부터 마찰을 먹는다
  return { sinceLand: Infinity, sinceSwap: Infinity, lastSign: 0 };
}

/** 스폰·순간이동 때 부른다. 다음 점프가 버니합으로 잡히거나 묵은 A/D 방향으로 보너스가 붙지 않게 한다 */
export function resetMoveMemory(body) {
  body.moveMem = newMemory();
}

/** 수평 속력을 limit 이하로 줄인다(방향 유지) */
function limitSpeed(vel, limit) {
  const speed = Math.hypot(vel[0], vel[2]);
  if (speed > limit) {
    const k = limit / speed;
    vel[0] *= k; vel[2] *= k;
  }
}

/**
 * Quake PM_Friction. 단, STOP_SPEED 바닥값은 입력이 없을 때만 쓴다.
 * 입력이 있어도 쓰면 느린 목표 속도(앉기 + 저격 줌 등, 1~2 m/s)에서 틱당 마찰이 가속보다 커져 아예 움직이지 못한다.
 * 바닥값을 빼면 어떤 목표 속도든 GROUND_ACCEL > FRICTION 조건 하나로 같은 시간에 목표에 닿는다.
 */
function applyFriction(vel, friction, stopSpeed, hasInput, dt) {
  const speed = Math.hypot(vel[0], vel[2]);
  if (speed <= 0) return;
  const control = !hasInput && speed < stopSpeed ? stopSpeed : speed;
  const k = Math.max(0, speed - control * friction * dt) / speed;
  vel[0] *= k; vel[2] *= k;
}

/** Quake PM_Accelerate: wishdir 성분이 wishSpeed보다 작을 때만, 틱당 accel × wishSpeed × dt까지 더한다 */
function accelerate(vel, dirX, dirZ, wishSpeed, accel, dt) {
  const add = wishSpeed - (vel[0] * dirX + vel[2] * dirZ);
  if (add <= 0) return;
  const amount = Math.min(add, accel * wishSpeed * dt);
  vel[0] += amount * dirX;
  vel[2] += amount * dirZ;
}

/**
 * 지면 가속. Quake 원본은 비스듬히 누르면 목표 속도를 넘어(지면 스트레이프) 걷기가 빨라지므로,
 * 기존 조작감대로 "목표 속도 또는 지금 속도 중 큰 값"을 넘지 못하게 막는다. 방향은 그대로 틀 수 있다.
 */
function groundAccelerate(vel, dirX, dirZ, wishSpeed, accel, dt) {
  const before = Math.hypot(vel[0], vel[2]);
  accelerate(vel, dirX, dirZ, wishSpeed, accel, dt);
  limitSpeed(vel, Math.max(before, wishSpeed));
}

/** 현재 진행 방향으로 bonus를 더한다(max까지). 실제로 더한 양을 돌려준다 */
function addAlongTravel(vel, bonus, max) {
  const speed = Math.hypot(vel[0], vel[2]);
  if (speed < 0.01 || speed >= max) return 0; // 멈춰 있으면 "진행 방향"이 없다
  const amount = Math.min(bonus, max - speed);
  const k = (speed + amount) / speed;
  vel[0] *= k; vel[2] *= k;
  return amount;
}

/** 이번 틱의 수평 속도를 정한다. 더한 A/D 보너스(m/s)를 돌려준다 */
function steer(vel, wish, airborne, hopTick, mem, M, dt) {
  const dirX = wish.dirX || 0, dirZ = wish.dirZ || 0, wishSpeed = wish.speed || 0;
  const hasInput = dirX !== 0 || dirZ !== 0;
  const sign = Math.sign(wish.strafeSign || 0);
  const startSpeed = Math.hypot(vel[0], vel[2]);
  let bonus = 0;

  if (airborne) {
    if (hasInput) {
      // 뛰는 틱에 걷기 속도보다 느리면 지면 가속을 한 번 받는다.
      // 이게 없으면 제자리에서 Space를 누른 채 W를 눌렀을 때 AIR_WISH_CAP 속도로 영영 기어가게 된다.
      if (hopTick && startSpeed < wishSpeed) groundAccelerate(vel, dirX, dirZ, wishSpeed, M.GROUND_ACCEL, dt);
      else {
        // 거의 멈춘 채 뛰었을 때만 공중 조작을 넉넉히 준다. 제자리 점프로 상자에 올라타는 동작이 답답하지 않게 하되,
        // 이미 빠르게 움직이는 동안에는 AIR_WISH_CAP을 그대로 써서 공중 스트레이프 튜닝에 영향을 주지 않는다.
        const cap = startSpeed < M.AIR_LOW_SPEED ? Math.max(M.AIR_WISH_CAP, M.AIR_LOW_SPEED) : M.AIR_WISH_CAP;
        accelerate(vel, dirX, dirZ, Math.min(wishSpeed, cap), M.AIR_ACCEL, dt);
      }
    }
    // A→(없음)→D처럼 중간에 손을 떼도 한 번의 교체로 센다. SWAP_GAP은 연타로 보너스를 쓸어 담는 것을 막는다
    if (sign !== 0 && mem.lastSign !== 0 && sign !== mem.lastSign && mem.sinceSwap >= M.SWAP_GAP - TIME_EPS) {
      bonus = addAlongTravel(vel, M.SWAP_BONUS, M.SWAP_BONUS_MAX);
      if (bonus > 0) mem.sinceSwap = 0;
    }
  } else {
    if (mem.sinceLand >= M.HOP_GRACE - TIME_EPS) applyFriction(vel, M.FRICTION, M.STOP_SPEED, hasInput, dt);
    if (hasInput) groundAccelerate(vel, dirX, dirZ, wishSpeed, M.GROUND_ACCEL, dt);
  }

  // 상한은 입력으로 "더 빨라지는 것"만 막는다. 발판 등으로 이미 MAX_SPEED를 넘은 속도를 깎으면 착지 지점이 어긋난다
  limitSpeed(vel, Math.max(startSpeed, M.MAX_SPEED));

  mem.sinceSwap += dt;
  if (sign !== 0) mem.lastSign = sign;
  else if (!airborne) mem.lastSign = 0; // 땅에서 A/D를 놓으면 잊는다(묵은 방향으로 첫 점프에 보너스가 붙지 않게)
  return bonus;
}

/**
 * 뛰는 틱이거나, 공중인데 발이 바닥에 거의 닿았는가.
 * 공중의 턱 한도(STEP × 0.5 = 0.225 m)를 그대로 쓰면 0.3 m 계단에서 뛰는 틱·착지 틱마다 챌판을 벽으로 보고 수평 속도를 0으로 만든다.
 * 공중 가속으로는 속도를 되찾을 수 없어 Space를 누른 채 계단을 오르면 멈춰 버리므로, 이때만 걷기와 같은 한도로 올라서게 한다.
 * 걸어서 오를 수 있는 높이만 넘으므로 점프로 닿는 높이는 그대로다.
 */
function isNearFloor(world, body, hopTick, radius, dt) {
  if (hopTick) return true;
  if (body.onGround) return false;
  const feet = body.pos[1];
  const floor = getGroundY(world, body.pos[0], body.pos[2], feet + 1e-4, radius - 0.01);
  return feet - floor <= Math.max(NEAR_FLOOR_GAP, -body.vel[1] * dt); // 높은 곳에서 떨어지는 착지 틱도 포함
}

const NO_WISH = Object.freeze({ dirX: 0, dirZ: 0, speed: 0, jump: false, strafeSign: 0 });
const _charWish = { x: 0, z: 0, jump: false }; // rawVelocity라 x·z는 쓰이지 않는다

/**
 * 플레이어 1틱 이동 (body를 직접 수정).
 * @param world createWorld 결과
 * @param body { pos, vel, onGround } + moveMem(없으면 만든다)
 * @param wish 파일 머리 설명 참고
 * @param dt 초
 * @param [opt] moveCharacter opt + { move }
 * @returns moveCharacter ev + { hopped, swapBonus, speed }
 */
export function moveQuake(world, body, wish, dt, opt = {}) {
  const M = opt.move || MOVE;
  const w = wish || NO_WISH;
  const mem = body.moveMem || (body.moveMem = newMemory());
  const grounded = !!body.onGround;
  const jump = !!w.jump;
  // 뛰는 틱은 공중처럼 계산한다(Quake PM_CheckJump와 같은 순서). 그래서 착지와 점프 사이에 마찰이 한 번도 안 들어간다
  const hopTick = grounded && jump;
  const chained = hopTick && mem.sinceLand < M.HOP_GRACE - TIME_EPS;

  const swapBonus = dt > 0 ? steer(body.vel, w, !grounded || hopTick, hopTick, mem, M, dt) : 0;

  const y0 = body.pos[1];
  const nearFloor = isNearFloor(world, body, hopTick, opt.radius ?? PLAYER.RADIUS, dt);
  _charWish.jump = jump; // 공중의 jump는 moveCharacter가 무시한다
  const ev = moveCharacter(world, body, _charWish, dt, { ...opt, rawVelocity: true, nearFloor });

  // 뛰었는데 땅에 남았다: 챌판 위로 올라섰거나 머리가 바로 막혔다. 땅을 떠난 것이 아니므로 점프로 치지 않고,
  // 올라선 높이는 걸어서 오른 턱처럼 알려 카메라를 부드럽게 한다. 버니합 사슬은 끊지 않는다
  const stayed = hopTick && !!body.onGround;
  if (stayed) {
    ev.jumped = false;
    ev.stepUp = Math.max(ev.stepUp, body.pos[1] - y0);
  }

  // ev.landed는 올라가면서 턱에 걸터앉은 경우를 세지 않으므로 onGround 변화로 착지를 본다
  const landedNow = !grounded && !!body.onGround;
  if (dt > 0) mem.sinceLand = landedNow || stayed ? 0 : mem.sinceLand + dt;

  ev.hopped = (ev.jumped && chained) || (landedNow && jump);
  ev.swapBonus = swapBonus;
  ev.speed = Math.hypot(body.vel[0], body.vel[2]);
  return ev;
}
