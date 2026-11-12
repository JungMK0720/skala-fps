/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 계정 진입점. localStorage 프로필을 정본으로 닉네임·포인트·장비·전적을 관리하고, Supabase가 설정돼 있으면 비동기로 동기화한다.
 *          네트워크가 실패해도 어떤 호출도 게임을 막거나 예외를 던지지 않는다. 계약은 docs/DESIGN.md 7절.
 *
 *   const account = createAccount({ bus });   // 만들면 곧바로 쓸 수 있다. 서버 동기화는 뒤에서 진행된다
 *
 * DESIGN 7절의 API에 더해:
 *   account.ready                 시작 동기화가 끝나면 풀리는 Promise. 게임을 막지 않도록 기다리지 않는다
 *   account.nicknamePending       서버에 아직 등록하지 못한 닉네임이 있으면 true
 *   account.nicknameConflict      등록을 거절당한 닉네임, 없으면 null. 이벤트를 놓친 화면은 이 값을 본다
 *   await account.retryNickname() 멀티 입장 때 부른다. setNickname과 같은 모양을 돌려준다
 *   await account.syncFromRemote(), await account.flush(), await account.topPlayers(limit), account.dispose()
 *   bus 'account:nickname-conflict' { name, reason, message }  새 닉네임을 물어볼 때
 *
 * 결과 모양:
 *   checkNickname, setNickname, retryNickname → { ok, name, reason?, offline, message }. message는 화면에 그대로 보여 줘도 된다.
 *   네트워크 실패는 { ok:true, offline:true, reason:'network', message }다. 게임을 막지 않으려고 ok가 true다.
 *   equip의 reason: 'slot'(칸이 없거나 맞지 않음) | 'unknown' | 'unowned'
 *   account.emoteWheel            휠 8칸의 이모트 id(12시부터 시계 방향). loadout.emotes와 같다
 *   account.equipEmote(slot, id)  휠 칸(0~7)에 가진 이모트를 넣는다. 다른 칸에 이미 있으면 두 칸을 맞바꾼다. reason은 equip과 같다
 *   account.avatar                장착한 캐릭터 id(core/avatar-defs.js). loadout.avatar와 같다
 *   account.equipAvatar(id)       가진 캐릭터를 장착한다. reason은 'unknown' | 'unowned'
 *   account.avatarShop            캐릭터 구매: 'open' | 'checking'(서버에 묻는 중) | 'closed'(서버가 아직 캐릭터를 모름)
 *                                 서버를 쓰면 시작할 때 fps_features를 한 번 묻고 avatars:true일 때만 연다. 오프라인·로컬은 늘 열려 있다.
 *                                 열리기 전 buy(캐릭터)는 { ok:false, reason:'closed' }다. 기본 캐릭터와 이미 가진 캐릭터 장착은 그대로 된다
 *   recordMatch의 summary에 knifeKills를 넣으면 전적에 쌓인다(선택).
 *   account.spendPoints(n)        물건이 아닌 곳에 n 포인트를 쓴다(개인전 즉시 부활). → { ok, spent, points, reason? }, 모자라면 reason 'points'
 *   account.feedbackBox           건의함: 'open' | 'checking'(묻는 중·네트워크 실패, 보내 보면 안다) | 'closed'(서버 없음·서버가 건의함을 모름)
 *                                 fps_features의 feedback:true로 연다. 규칙·문구는 ./feedback.js, 설계는 docs/FEEDBACK.md
 *   await account.sendFeedback({ kind, body, info? })  → { ok, id?, reason?, message }. reason: offline | kind | short | long | closed |
 *                                 nickname | duplicate | rate | blocked | invalid | network. message는 화면에 그대로 보여 줘도 된다
 *   await account.myFeedback()    → { ok, items, offline, reason? }  내가 보낸 건의와 운영자 답(최근 10개, feedback.js normalizeFeedbackItems 모양)
 *
 * 닉네임 게이트는 'account:change'도 들어야 한다. 프로필을 잃어도 토큰이 남아 있으면 동기화가 끝난 뒤 닉네임이 돌아온다.
 */
import { getDef } from '../weapons/defs.js';
import { EMOTE_WHEEL } from '../core/consts.js';
import { clampPoints, isAvatarId, isEmoteId, matchReward, priceOf, readSummary, secretReward, readZombieSummary, zombieReward } from './economy.js';
import { nicknameKey, validateNickname } from './nickname.js';
import { createRemote } from './remote.js';
import { FEEDBACK_MESSAGES, feedbackInfo, feedbackResult, normalizeFeedbackItems, validateFeedback } from './feedback.js';
import {
  LOADOUT_SLOTS, PROFILE_KEY, createStore, defaultProfile, isSecretId, mergeProfiles, normalizeOwned,
  normalizeProfile, normalizeStats, sameProfile, sameProgress, secretEntry
} from './store.js';

export { START_POINTS, isAvatarId, isEmoteId, matchReward, priceOf, quickRespawnCost } from './economy.js';
export { cleanNickname, nicknameKey, validateNickname } from './nickname.js';

export const SAVE_DEBOUNCE_MS = 2000;
export const RETRY_MIN_MS = 15000;
export const RETRY_MAX_MS = 300000;

const MESSAGE = Object.freeze({
  offline: '오프라인이라 중복 확인을 못 했어요.',
  available: '사용할 수 있는 닉네임이에요.',
  saved: '닉네임을 저장했어요.'
});

/**
 * 서버 오류 코드 → 화면에 알릴 이유. 여기 없는 코드(RATE_LIMITED: 같은 IP에서 등록이 너무 많음 등)는
 * 거절이 아니라 잠시 뒤 다시 시도할 실패로 다룬다(로컬에 두고 재시도).
 */
const REFUSALS = new Map([
  ['NAME_TAKEN', { reason: 'taken', message: '이미 사용 중인 닉네임이에요.' }],
  ['NAME_INVALID', { reason: 'format', message: '닉네임 형식이 맞지 않아요.' }],
  ['NAME_RESERVED', { reason: 'reserved', message: '이 닉네임은 쓸 수 없어요.' }]
]);

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const k of Object.keys(o)) deepFreeze(o[k]);
  }
  return o;
}

function offlineResult(name) {
  return { ok: true, name, reason: 'network', offline: true, message: MESSAGE.offline };
}

/**
 * opts: { bus, storage?, fetch?, config?: { url, anonKey }, target? }
 * config를 주지 않으면 globalThis.SKALA_CONFIG.supabase를 읽는다. target은 pagehide·online·storage를 받는 대상(기본 window).
 */
export function createAccount({ bus = null, storage, fetch: fetchImpl, config, target = globalThis.window } = {}) {
  const store = createStore({ storage });
  const remote = createRemote({ fetch: fetchImpl, config });
  const restored = store.load();

  let profile = restored ? restored.profile : defaultProfile();
  let dirty = restored ? restored.dirty : false;              // 서버가 아직 받았다고 확인하지 않은 변경이 있다
  let pendingClaim = restored ? restored.pendingClaim : null; // 서버에 등록하지 못한 닉네임
  let conflictName = null;                                    // 등록을 거절당한 닉네임
  let snapshot = null;
  let revision = 0;                                           // 저장 요청 중에 또 바뀌었는지 알아채는 번호
  let saveTimer = null;
  let retryTimer = null;
  let retryDelay = RETRY_MIN_MS;
  let synced = false;
  let syncing = null;
  let queue = Promise.resolve();
  let disposed = false;
  let avatarShop = remote.enabled ? 'checking' : 'open';      // 캐릭터 구매를 열었는가(서버 기능 확인)
  let feedbackBox = remote.enabled ? 'checking' : 'closed';   // 건의함을 쓸 수 있는가(서버 기능 확인)
  let featureCheck = null;

  // ───────────── 내부 상태 ─────────────
  function readProfile() {
    if (!snapshot) snapshot = deepFreeze(JSON.parse(JSON.stringify(profile)));
    return snapshot;
  }

  function emit(event, payload) {
    if (!bus) return;
    try {
      bus.emit(event, payload);
    } catch (err) {
      console.error('[account] 이벤트 처리 실패:', event, err);
    }
  }

  function persist() {
    store.save({ profile, dirty, pendingClaim });
  }

  function announce() {
    snapshot = null;
    emit('account:change', { profile: readProfile() });
  }

  /** 사용자의 변경을 확정한다: 로컬에 저장하고, 서버 저장을 예약하고, 화면에 알린다 */
  function commit() {
    dirty = true;
    revision += 1;
    persist();
    scheduleSave();
    announce();
  }

  /** 닉네임 등록·프로필 읽기·저장이 응답 순서로 뒤섞이지 않게 한 줄로 세운다 */
  function serial(task) {
    const run = queue.then(() => task());
    queue = run.catch(() => {});
    return run;
  }

  // ───────────── 서버 저장 ─────────────
  function canSave() {
    return remote.enabled && dirty && !!profile.nickname && !pendingClaim;
  }

  function scheduleSave() {
    if (!remote.enabled || disposed) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      serial(() => sendSave());
    }, SAVE_DEBOUNCE_MS);
  }

  async function sendSave(options) {
    if (!canSave()) return;
    const sent = revision;
    const r = await remote.saveProfile(store.token(), profile, options);
    if (r.ok) {
      retryDelay = RETRY_MIN_MS;
      if (sent === revision) {
        dirty = false;
        if (r.profile) adoptSaved(r.profile);
        persist();
      }
    } else if (r.reason === 'network') {
      armRetry();
    } else if (r.error === 'NOT_FOUND' && profile.nickname && !pendingClaim) {
      // 서버에 행이 없다(데이터베이스를 비운 경우 등): 닉네임부터 다시 등록하면 저장이 뒤따른다
      pendingClaim = profile.nickname;
      persist();
      retryNickname();
    }
  }

  /** 예약된 저장을 바로 보낸다. keepalive면 페이지가 닫혀도 요청이 끝까지 간다. */
  function flush({ keepalive = false } = {}) {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (!canSave()) return Promise.resolve();
    // 페이지가 닫히는 중에는 앞선 요청을 기다릴 시간이 없다
    return keepalive ? sendSave({ keepalive: true }) : serial(() => sendSave());
  }

  function armRetry() {
    if (retryTimer || disposed || !remote.enabled) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      resumeRemote();
    }, retryDelay);
    retryDelay = Math.min(RETRY_MAX_MS, retryDelay * 2);
  }

  /** 네트워크가 돌아왔을 수 있을 때 못 끝낸 일을 이어서 한다 */
  function resumeRemote() {
    if (avatarShop !== 'open' || feedbackBox !== 'open') checkFeatures();
    if (!synced) return syncFromRemote();
    if (pendingClaim && !conflictName) retryNickname();
    return flush();
  }

  // ───────────── 닉네임 ─────────────
  function acceptClaim(name) {
    profile.nickname = name;
    pendingClaim = null;
    conflictName = null;
    retryDelay = RETRY_MIN_MS;
    commit(); // 행이 방금 생겼을 수 있으니 진행 상황도 함께 올린다
    return { ok: true, name, offline: false, message: MESSAGE.saved };
  }

  function keepOffline(name) {
    profile.nickname = name;
    pendingClaim = name;
    conflictName = null;
    commit();
    armRetry();
    return offlineResult(name);
  }

  async function checkNickname(name) {
    const v = validateNickname(name);
    if (!v.ok) return { ok: false, name: v.name, reason: v.reason, offline: false, message: v.message };
    if (!remote.enabled) return offlineResult(v.name);
    if (profile.nickname && !pendingClaim && nicknameKey(v.name) === nicknameKey(profile.nickname)) {
      return { ok: true, name: v.name, offline: false, message: MESSAGE.available }; // 이미 내 이름이다
    }
    const r = await remote.checkNickname(v.name);
    if (r.ok) return { ok: true, name: v.name, offline: false, message: MESSAGE.available };
    const refusal = REFUSALS.get(r.error);
    return refusal ? { ok: false, name: v.name, offline: false, ...refusal } : offlineResult(v.name);
  }

  async function setNickname(name) {
    const v = validateNickname(name);
    if (!v.ok) return { ok: false, name: v.name, reason: v.reason, offline: false, message: v.message };
    return serial(async () => {
      if (v.name === profile.nickname && !pendingClaim) return { ok: true, name: v.name, offline: false, message: MESSAGE.saved };
      if (!remote.enabled) return keepOffline(v.name);
      const r = await remote.claimNickname(store.token(), v.name);
      if (r.ok) return acceptClaim(r.name || v.name);
      const refusal = REFUSALS.get(r.error);
      // 거절이면 이전 이름을 그대로 둔다. 그 밖의 실패는 게임을 막지 않도록 일단 로컬에 저장한다.
      return refusal ? { ok: false, name: v.name, offline: false, ...refusal } : keepOffline(v.name);
    });
  }

  /** 등록하지 못한 닉네임을 다시 등록한다. 거절되면 'account:nickname-conflict'를 알린다. */
  function retryNickname() {
    return serial(async () => {
      const name = pendingClaim;
      if (!name) return { ok: true, name: profile.nickname, offline: false, message: MESSAGE.saved };
      if (!remote.enabled) return offlineResult(name);
      const r = await remote.claimNickname(store.token(), name);
      if (pendingClaim !== name) return { ok: true, name: profile.nickname, offline: false, message: MESSAGE.saved };
      if (r.ok) return acceptClaim(r.name || name);
      const refusal = REFUSALS.get(r.error);
      if (!refusal) {
        armRetry();
        return offlineResult(name);
      }
      conflictName = name;
      emit('account:nickname-conflict', { name, reason: refusal.reason, message: `${refusal.message} 새 닉네임을 정해 주세요.` });
      return { ok: false, name, offline: false, ...refusal };
    });
  }

  // ───────────── 서버 동기화 ─────────────
  /**
   * 저장 응답의 서버 값(포인트·무기·전적)을 따른다. 서버는 늘어나는 속도와 무기 가격을 확인해 넘는 만큼을 버린다.
   * 정상 플레이에서는 보낸 값과 같아 아무것도 바뀌지 않는다.
   */
  function adoptSaved(raw) {
    const srv = raw && typeof raw === 'object' ? raw : {};
    const next = normalizeProfile({
      ...profile,
      points: srv.points ?? profile.points,
      owned: Array.isArray(srv.owned) ? srv.owned : profile.owned,
      stats: { ...profile.stats, ...(srv.stats && typeof srv.stats === 'object' ? srv.stats : null) }
    });
    if (sameProfile(next, profile)) return;
    profile = next;
    revision += 1;
    announce();
  }

  function adoptServerProfile(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const server = normalizeProfile({ ...src, nickname: src.name });
    const merged = mergeProfiles(profile, server, { dirty, keepNickname: !!pendingClaim });
    const changed = !sameProfile(merged, profile);
    const ahead = !sameProgress(merged, server);
    const wasDirty = dirty;
    profile = merged;
    dirty = ahead;
    if (changed) revision += 1;
    if (changed || dirty !== wasDirty) persist();
    if (changed) announce();
    if (dirty) scheduleSave();
  }

  /** 합치는 규칙은 store.js의 mergeProfiles. 시작할 때 한 번 저절로 불린다. */
  function syncFromRemote() {
    if (!remote.enabled || disposed) return Promise.resolve({ ok: false, offline: true });
    if (!syncing) syncing = runSync().finally(() => { syncing = null; });
    return syncing;
  }

  async function runSync() {
    if (pendingClaim) await retryNickname();
    const r = await serial(async () => {
      const res = await remote.getProfile(store.token());
      if (res.ok) adoptServerProfile(res.profile);
      return res;
    });
    if (r.ok) {
      synced = true;
      retryDelay = RETRY_MIN_MS;
      return { ok: true, offline: false };
    }
    if (r.error === 'NOT_FOUND') {
      synced = true;
      if (profile.nickname && !pendingClaim) {
        pendingClaim = profile.nickname; // 서버 설정 전에 정한 이름 등: 지금 등록한다
        persist();
        await retryNickname();
      }
      return { ok: true, offline: false };
    }
    armRetry();
    return { ok: false, offline: true };
  }

  // ───────────── 서버 기능 확인 ─────────────
  /**
   * 캐릭터는 서버 가격표가 캐릭터를 알 때만 판다. schema.sql을 다시 실행하기 전의 서버(fps_save_profile)는 모르는 물건을 버리지만
   * 줄어든 포인트는 받아들이므로, 그 사이에 사면 포인트만 잃는다. 그래서 fps_features가 avatars:true라고 답할 때까지 닫아 둔다.
   * 404(함수 없음), 어떤 오류, 값 없음은 모두 닫힘이다. 네트워크가 돌아오면(resumeRemote) 다시 묻는다.
   * 건의함(feedbackBox)은 답이 오면 feedback:true일 때만 열고, 404면 닫고, 네트워크 실패면 그대로 둔다(보내 보면 안다).
   */
  function checkFeatures() {
    if (!remote.enabled || disposed || (avatarShop === 'open' && feedbackBox === 'open')) return Promise.resolve(avatarShop === 'open');
    if (!featureCheck) {
      featureCheck = remote.features()
        .then((r) => {
          const shop = avatarShop === 'open' || (r && r.ok === true && r.avatars === true) ? 'open' : 'closed';
          const box = r && r.ok === true ? (r.feedback === true ? 'open' : 'closed') : (r && r.status === 404 ? 'closed' : feedbackBox);
          if (!disposed && (shop !== avatarShop || box !== feedbackBox)) {
            avatarShop = shop;
            feedbackBox = box;
            announce();
          }
          return shop === 'open';
        })
        .finally(() => { featureCheck = null; });
    }
    return featureCheck;
  }

  // ───────────── 건의함 (docs/FEEDBACK.md) ─────────────
  function setFeedbackBox(next) {
    if (disposed || next === feedbackBox) return;
    feedbackBox = next;
    announce();
  }

  async function sendFeedback(input = {}) {
    if (!remote.enabled) return { ok: false, reason: 'offline', message: FEEDBACK_MESSAGES.offline };
    const v = validateFeedback(input || {});
    if (!v.ok) return v;
    // 닫혀 있으면 소유자가 그 사이 schema.sql을 실행했을 수 있어 한 번 더 묻는다
    if (feedbackBox === 'closed') await checkFeatures();
    if (feedbackBox === 'closed') return { ok: false, reason: 'closed', message: FEEDBACK_MESSAGES.closed };
    const r = await remote.sendFeedback(store.token(), { kind: v.kind, body: v.body, info: feedbackInfo(input && input.info) });
    const out = feedbackResult(r);
    if (out.ok) setFeedbackBox('open');
    else if (out.reason === 'closed') setFeedbackBox('closed');
    return out;
  }

  async function myFeedback() {
    if (!remote.enabled) return { ok: false, items: [], offline: true, reason: 'offline' };
    if (feedbackBox === 'closed') return { ok: false, items: [], offline: false, reason: 'closed' };
    const r = await remote.myFeedback(store.token());
    if (r && r.ok === true) {
      setFeedbackBox('open');
      return { ok: true, items: normalizeFeedbackItems(r.items), offline: false };
    }
    if (r && r.status === 404) {
      setFeedbackBox('closed');
      return { ok: false, items: [], offline: false, reason: 'closed' };
    }
    // 닉네임을 아직 서버에 등록하지 않았으면 보낸 글도 없다
    if (r && (r.error === 'NOT_FOUND' || r.error === 'TOKEN_INVALID')) return { ok: true, items: [], offline: false };
    return { ok: false, items: [], offline: true, reason: 'network' };
  }

  // ───────────── 상점 · 장비 ─────────────
  function isOwned(id) {
    return profile.owned.includes(id);
  }

  function buy(id) {
    const price = priceOf(id);
    if (price === null) return { ok: false, reason: 'unknown', points: profile.points };
    if (isOwned(id)) return { ok: false, reason: 'owned', points: profile.points };
    if (isAvatarId(id) && avatarShop !== 'open') return { ok: false, reason: 'closed', points: profile.points };
    if (profile.points < price) return { ok: false, reason: 'points', points: profile.points };
    profile.points -= price;
    profile.owned = normalizeOwned([...profile.owned, id]);
    commit();
    return { ok: true, points: profile.points };
  }

  function equip(slotKey, id) {
    if (!hasOwn(LOADOUT_SLOTS, slotKey)) return { ok: false, reason: 'slot' };
    const def = getDef(id);
    if (!def) return { ok: false, reason: 'unknown' };
    if (def.slot !== LOADOUT_SLOTS[slotKey]) return { ok: false, reason: 'slot' };
    if (!isOwned(id)) return { ok: false, reason: 'unowned' };
    if (profile.loadout[slotKey] !== id) {
      profile.loadout[slotKey] = id;
      commit();
    }
    return { ok: true };
  }

  function equipEmote(slot, id) {
    const i = Number(slot);
    if (!Number.isInteger(i) || i < 0 || i >= EMOTE_WHEEL.SLOTS) return { ok: false, reason: 'slot' };
    if (!isEmoteId(id)) return { ok: false, reason: 'unknown' };
    if (!isOwned(id)) return { ok: false, reason: 'unowned' };
    const wheel = profile.loadout.emotes.slice();
    const at = wheel.indexOf(id);
    if (at === i) return { ok: true };
    if (at >= 0) wheel[at] = wheel[i];
    wheel[i] = id;
    profile.loadout.emotes = wheel;
    commit();
    return { ok: true };
  }

  function equipAvatar(id) {
    if (!isAvatarId(id)) return { ok: false, reason: 'unknown' };
    if (!isOwned(id)) return { ok: false, reason: 'unowned' };
    if (profile.loadout.avatar !== id) {
      profile.loadout.avatar = id;
      commit();
    }
    return { ok: true };
  }

  // ───────────── 전적 · 보상 ─────────────
  function recordMatch(summary) {
    const s = readSummary(summary);
    const { gained, breakdown } = matchReward(s);
    const t = profile.stats;
    profile.stats = normalizeStats({
      ...t,
      kills: t.kills + s.kills,
      deaths: t.deaths + s.deaths,
      headshots: t.headshots + s.headshots,
      halfShots: t.halfShots + s.halfShots,
      knifeKills: t.knifeKills + s.knifeKills,
      matches: t.matches + 1,
      wins: t.wins + (s.win ? 1 : 0),
      draws: t.draws + (s.draw ? 1 : 0),
      secondsPlayed: t.secondsPlayed + s.seconds
    });
    profile.points = clampPoints(profile.points + gained);
    commit();
    return { gained, breakdown, points: profile.points };
  }

  /**
   * 좀비 물량 막기 한 판을 기록한다(판마다 한 번). 좀비 처치는 사람 킬(kills)과 따로 zombieKills에 쌓고, 도달한 스테이지의 최고 기록을 남긴다.
   * summary = { online, stage, cleared, bossKills, kills, headshots, seconds } → { gained, breakdown, points, best, newBest }
   */
  function recordZombie(summary) {
    const s = readZombieSummary(summary);
    const { gained, breakdown } = zombieReward(s);
    const t = profile.stats;
    const before = t.zombieBest || 0;
    profile.stats = normalizeStats({
      ...t,
      zombieKills: (t.zombieKills || 0) + s.kills,
      zombieRuns: (t.zombieRuns || 0) + 1,
      zombieBest: Math.max(before, s.stage),
      headshots: t.headshots + s.headshots,
      secondsPlayed: t.secondsPlayed + s.seconds
    });
    profile.points = clampPoints(profile.points + gained);
    commit();
    return { gained, breakdown, points: profile.points, best: profile.stats.zombieBest, newBest: s.stage > before };
  }

  /**
   * 물건이 아닌 곳에 포인트를 쓴다(개인전 즉시 부활). 모자라면 쓰지 않는다. 서버(fps_save_profile)는 줄어든 포인트를 그대로 받는다.
   * → { ok, spent, points, reason? }  reason: 'amount'(양수 정수가 아님) | 'points'(모자람)
   */
  function spendPoints(amount) {
    const n = typeof amount === 'number' ? amount : NaN;   // 숫자만 받는다('10' 같은 글자는 거절)
    if (!Number.isInteger(n) || n <= 0) return { ok: false, spent: 0, reason: 'amount', points: profile.points };
    if (profile.points < n) return { ok: false, spent: 0, reason: 'points', points: profile.points };
    profile.points -= n;
    commit();
    return { ok: true, spent: n, points: profile.points };
  }

  /** secret: 맵 데이터의 { id, name, points? }. 같은 스팟은 한 번만 보상한다. */
  function findSecret(mapId, secret) {
    const id = secret && typeof secret === 'object' ? secret.id : secret;
    const none = { first: false, gained: 0, points: profile.points };
    if (!isSecretId(mapId) || !isSecretId(id)) return none;
    if (hasOwn(profile.secrets, mapId) && hasOwn(profile.secrets[mapId], id)) return none;
    const gained = secretReward(secret);
    if (!hasOwn(profile.secrets, mapId)) profile.secrets[mapId] = {};
    profile.secrets[mapId][id] = secretEntry(secret.name, Date.now());
    profile.points = clampPoints(profile.points + gained);
    commit();
    return { first: true, gained, points: profile.points };
  }

  /**
   * 이 기기의 프로필을 지운다. 토큰은 남긴다. 토큰까지 지우면 서버의 닉네임을 영영 되찾을 수 없기 때문이다.
   * 그래서 온라인이면 다음 시작 때 서버 프로필이 돌아오고, 그 전에 새 닉네임을 정하면 서버 행도 초기값으로 덮인다.
   */
  function resetLocal() {
    clearTimeout(saveTimer);
    clearTimeout(retryTimer);
    saveTimer = null;
    retryTimer = null;
    retryDelay = RETRY_MIN_MS;
    store.clear();
    profile = defaultProfile();
    dirty = false;
    pendingClaim = null;
    conflictName = null;
    revision += 1;
    announce();
  }

  async function topPlayers(limit = 20) {
    if (!remote.enabled) return { ok: false, players: [], offline: true };
    const r = await remote.topPlayers(limit);
    if (r.ok && Array.isArray(r.players)) return { ok: true, players: r.players, offline: false };
    return { ok: false, players: [], offline: r.reason === 'network' };
  }

  // ───────────── 브라우저 이벤트 ─────────────
  function onPageHide() {
    flush({ keepalive: true });
  }

  function onOnline() {
    retryDelay = RETRY_MIN_MS;
    resumeRemote();
  }

  /** 다른 탭이 프로필을 바꾸면 따라간다. 오래된 값으로 덮어써서 포인트를 잃지 않게 한다. */
  function onStorage(e) {
    if (e.key !== PROFILE_KEY && e.key !== null) return;
    const next = store.load();
    if (next) {
      ({ profile, dirty, pendingClaim } = next);
    } else if (e.newValue == null) {
      profile = defaultProfile();
      dirty = false;
      pendingClaim = null;
    } else {
      return;
    }
    if (pendingClaim !== conflictName) conflictName = null;
    revision += 1;
    announce();
  }

  const listeners = [['pagehide', onPageHide], ['online', onOnline], ['storage', onStorage]];
  const canListen = !!target && typeof target.addEventListener === 'function';
  if (canListen) for (const [name, fn] of listeners) target.addEventListener(name, fn);

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (canListen) for (const [name, fn] of listeners) target.removeEventListener(name, fn);
    clearTimeout(retryTimer);
    retryTimer = null;
    flush();
  }

  // 시작 동기화와 서버 기능 확인을 함께 기다린다. 값은 동기화 결과다
  const ready = Promise.all([syncFromRemote(), checkFeatures()]).then(([synced]) => synced);

  return Object.freeze({
    get profile() { return readProfile(); },
    get loadout() { return readProfile().loadout; },
    get emoteWheel() { return readProfile().loadout.emotes; },
    get avatar() { return readProfile().loadout.avatar; },
    get avatarShop() { return avatarShop; },
    get feedbackBox() { return feedbackBox; },
    get remoteEnabled() { return remote.enabled; },
    get nicknamePending() { return !!pendingClaim; },
    get nicknameConflict() { return conflictName; },
    ready,
    hasNickname: () => !!profile.nickname,
    checkNickname,
    setNickname,
    retryNickname,
    buy,
    equip,
    equipEmote,
    equipAvatar,
    isOwned,
    recordMatch,
    recordZombie,
    spendPoints,
    findSecret,
    resetLocal,
    syncFromRemote,
    flush: () => flush(),
    topPlayers,
    sendFeedback,
    myFeedback,
    dispose
  });
}
