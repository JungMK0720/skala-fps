/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 결과 = 작전 결과 보고서(AFTER ACTION REPORT). 맨 위에 내 처치·전사·K/D·헤드샷 비율 요약 줄을 두고, 팀전은 승리 팀·라운드 기록·MVP, 개인전은 시상대와 순위표, 배틀로얄은 내 순위(#n/총인원)·생존 시간과 탈락 순위표를 보여 주고, reward 값이 있으면 획득 포인트를 올라가는 숫자로 보여 준다.
 *          폭파 미션은 팀전 화면에 라운드마다 끝난 방식(폭파 · 해체 · 전멸 · 시간, 선 아이콘)과 이긴 진영(공격/수비)을 더한다.
 */
import { h, btn, setText, num, fmtPoints, fmtDelta, TEAMS, teamKey, modeKey, FFA_TARGET, SIDE_NAME, bombSide } from './dom.js';
import { makeScreen } from './parts.js';
import { mapInfo, uiIcon } from './icons.js';
import { normStatPlayers, byPerformance, rankPlayers } from './scoreboard.js';
import { t, fmtNum } from '../core/i18n.js';
import { platform } from '../platform/index.js';

/**
 * 결과 화면 단추 중 중간 광고를 붙이는 것: 'results:back'(다시 하기 · 방으로 돌아가기 = 계속 플레이)만.
 * 'results:lobby'(메뉴로 · 로비로)는 이동 단추라 광고를 붙이지 않는다(docs/PORTAL.md 2절)
 */
export const midgameOnLeave = (action) => action === 'results:back';

const COUNT_UP_MS = 900;
const COUNT_UP_STEP_MS = 30;
const FFA_REASON = {
  kills: (n) => t('results.ffaKills', { n }),
  time: () => t('results.ffaTime'),
  forfeit: () => t('results.ffaForfeit'),
  draw: () => t('results.ffaDraw'),
};

/** 폭파 미션 라운드가 끝난 방식(reasonCode) → 아이콘과 기본 문구 */
const BOMB_REASON = Object.freeze({
  bomb: Object.freeze({ icon: '💥', label: t('results.bombDetonated') }),
  defuse: Object.freeze({ icon: '✂️', label: t('results.bombDefused') }),
  elimination: Object.freeze({ icon: '☠️', label: t('results.eliminated') }),
  time: Object.freeze({ icon: '⏱', label: t('results.timeUp') }),
});
/** 끝난 방식 → 화면에 그리는 선 아이콘(BOMB_REASON의 icon 글자는 라운드 제목 문구에 쓴다) */
const BOMB_REASON_GLYPH = Object.freeze({ bomb: 'bomb', defuse: 'knife', elimination: 'skull', time: 'clock' });
const bombReason = (code) => (typeof code === 'string' && Object.prototype.hasOwnProperty.call(BOMB_REASON, code) ? BOMB_REASON[code] : null);

/** rounds 항목 → { n, winner, reason, reasonCode, attack }. reasonCode·attack은 폭파 미션만 쓴다 */
export function normRounds(list) {
  return (Array.isArray(list) ? list : []).map((r, i) => {
    const o = typeof r === 'string' ? { winner: r } : r || {};
    const w = o.winner === 'draw' ? 'draw' : teamKey(o.winner) || 'draw';
    return {
      n: o.n != null ? o.n : o.round != null ? o.round : i + 1, winner: w, reason: o.reason || '',
      reasonCode: typeof o.reasonCode === 'string' ? o.reasonCode : '', attack: teamKey(o.attack),
    };
  });
}

/**
 * 폭파 미션 라운드 칸에 쓸 글자 → { icon, reason, won, side, title }.
 * won: 이긴 진영('attack'|'defense', 무승부·공격 팀을 모르면 ''), side: '공격 승' 같은 줄, title: 칸 툴팁
 */
export function bombRoundInfo(r) {
  const why = bombReason(r.reasonCode);
  const reason = r.reason || (why ? why.label : '');
  const won = r.winner === 'draw' ? '' : bombSide(r.winner, r.attack);
  const side = won ? t('results.sideWin', { side: SIDE_NAME[won] }) : '';
  const title = [`R${r.n}`, reason && (why ? `${why.icon} ${reason}` : reason), side, r.attack ? t('results.teamAttack', { team: TEAMS[r.attack].name }) : ''].filter(Boolean).join(' · ');
  return { icon: why ? why.icon : '', reason, won, side, title };
}

/** 이름 칸: 봇이면 앞에 봇 선 아이콘(읽기 프로그램에는 '봇') */
function botName(x) {
  return h('span', {}, x.bot ? uiIcon('bot', 'sk-uico--inline sk-pl-bot') : null, x.bot ? h('span', { class: 'sk-vh', text: t('results.botPrefix') }) : null, x.name);
}

export function createResults(ctx) {
  const banner = h('div', { class: 'sk-res-banner' });
  const aar = h('p', { class: 'sk-kicker sk-res-aar', text: 'AFTER ACTION REPORT', 'aria-hidden': 'true' });
  const kicker = h('p', { class: 'sk-res-kicker sk-stencil', text: 'MATCH RESULT' });
  const titleEl = h('h1', { class: 'sk-res-title sk-stencil' });
  const scoreEl = h('p', { class: 'sk-res-score' });
  const verdict = h('p', { class: 'sk-res-verdict' });
  banner.append(aar, kicker, titleEl, scoreEl, verdict);

  // ---------- 내 작전 요약: 처치 · 전사 · K/D · 헤드샷 비율 ----------
  const summary = h('dl', { class: 'sk-res-summary', hidden: true, 'aria-label': t('results.summary') });
  function renderSummary(me) {
    summary.hidden = !me;
    if (!me) return;
    const rate = me.kills ? `${Math.round((me.head / me.kills) * 100)}%` : '—';
    summary.replaceChildren(...[[t('results.kills'), me.kills], [t('results.deaths'), me.deaths], ['K/D', (me.kills / Math.max(1, me.deaths)).toFixed(2)], [t('results.hsRate'), rate]]
      .map(([k, v]) => h('div', { class: 'sk-res-sum' }, h('dt', { text: k }), h('dd', { text: v }))));
  }

  // ---------- 획득 포인트 ----------
  const rewardNum = h('b', { class: 'sk-res-gain-num' });
  const rewardLines = h('ul', { class: 'sk-res-lines' });
  const rewardTotal = h('p', { class: 'sk-res-total' });
  // 포털 보상 광고: 이번 판 포인트를 한 번 더(판마다 한 번). 광고를 쓰는 제출본에서만 단추가 보인다(platform/index.js)
  const bonusBtn = btn('', () => claimBonus(), 'sk-btn--ghost sk-res-bonus-btn');
  bonusBtn.replaceChildren(h('span', { class: 'sk-res-bonus-ico', 'aria-hidden': 'true', text: '▶' }), h('span', { text: t('portal.rewardButton') }));
  const bonusNote = h('p', { class: 'sk-set-hint sk-res-bonus-note' });
  const bonusRow = h('div', { class: 'sk-res-bonus', hidden: true }, bonusBtn, bonusNote);
  const rewardBox = h('section', { class: 'sk-res-reward sk-steel', hidden: true, 'aria-label': t('results.pointsEarned') },
    h('p', { class: 'sk-res-gain' }, rewardNum, h('span', { class: 'sk-res-gain-unit', text: 'P' })),
    rewardLines,
    rewardTotal,
    bonusRow);
  let rewardSig = '';
  let countTimer = null;
  let bonusToken = null;   // 이번 결과 화면에서 받을 수 있는 보너스 표(account.grantAdBonus)
  let bonusBusy = false;

  /** 보상 광고 줄: 광고를 쓸 수 있고 이번 판 보상이 있으면 단추, 광고 차단기면 안내만(누를 수 없는 단추를 두지 않는다) */
  function renderBonus(reward) {
    const token = reward && reward.bonusToken != null && num(reward.gained, 0) > 0 ? reward.bonusToken : null;
    if (token !== bonusToken) bonusToken = token;
    const can = bonusToken != null && platform.rewardedAvailable;
    const blocked = bonusToken != null && platform.rewardedBlocked;
    bonusRow.hidden = !(can || blocked);
    bonusBtn.hidden = !can;
    bonusBtn.disabled = bonusBusy;
    setText(bonusNote, blocked ? t('portal.rewardAdblock') : t('portal.rewardHint'));
  }

  async function claimBonus() {
    if (bonusBusy || bonusToken == null) return;
    bonusBusy = true;
    bonusBtn.disabled = true;
    setText(bonusNote, t('portal.rewardWaiting'));
    const token = bonusToken;
    const watched = await platform.rewardedAd();
    bonusBusy = false;
    bonusBtn.disabled = false;
    if (!watched) {
      // 광고 오류에는 보상하지 않는다(문서). 차단기면 단추를 거두고, 그 밖에는 나중에 다시 해 보라고 한다
      setText(bonusNote, platform.lastAdError === 'adblock' ? t('portal.rewardAdblock') : t('portal.rewardFail'));
      if (platform.lastAdError === 'adblock') bonusBtn.hidden = true;
      return;
    }
    const res = ctx.account && typeof ctx.account.grantAdBonus === 'function' ? ctx.account.grantAdBonus(token) : null;
    bonusToken = null;
    bonusBtn.hidden = true;
    if (!res || !res.ok) { setText(bonusNote, t('portal.rewardRejected')); return; }
    setText(bonusNote, t('portal.rewardDone', { points: fmtNum(res.gained) }));
    setText(rewardTotal, t('results.balance', { points: fmtPoints(res.points) }));
    rewardTotal.hidden = false;
    ctx.emit('ui:sound', { name: 'purchase' });
  }

  let leaving = false;
  /**
   * 결과 화면을 떠난다. 포털이면 계속 플레이하는 단추(다시 하기 · 방으로 돌아가기)에서만 판 사이 중간 광고를 먼저 요청한다
   * (3분 간격, 게임 중에는 요청하지 않음). 메뉴·로비로 나가는 단추는 이동 단추라 광고를 붙이지 않는다(CrazyGames 광고 규칙)
   */
  async function leave(action) {
    if (!platform.isPortal || !midgameOnLeave(action)) { ctx.emit(action, {}); return; }
    if (leaving) return;
    leaving = true;
    backBtn.disabled = lobbyBtn.disabled = true;
    try { await platform.midgameAd(); } finally {
      leaving = false;
      backBtn.disabled = lobbyBtn.disabled = false;
    }
    ctx.emit(action, {});
  }

  function stopCount() {
    if (countTimer != null) { ctx.cancel(countTimer); countTimer = null; }
  }

  /** 0에서 gained까지 빠르게 올라간다. 움직임을 줄이는 설정이면 바로 최종값을 보여 준다. */
  function countUp(gained) {
    stopCount();
    const paint = (v) => setText(rewardNum, fmtDelta(v));
    const calm = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (calm || gained <= 0) { paint(gained); return; }
    const t0 = performance.now();
    paint(0);
    countTimer = ctx.every(() => {
      const t = Math.min(1, (performance.now() - t0) / COUNT_UP_MS);
      paint(gained * (1 - (1 - t) * (1 - t)));
      if (t >= 1) stopCount();
    }, COUNT_UP_STEP_MS);
  }

  /** reward: { gained, breakdown:[{ label, points }], points? } (account.recordMatch의 결과). 없으면 숨긴다. */
  function renderReward(reward) {
    rewardBox.hidden = !reward;
    if (!reward) { rewardSig = ''; stopCount(); return; }
    const sig = JSON.stringify(reward);
    if (sig === rewardSig) return;
    rewardSig = sig;
    const lines = Array.isArray(reward.breakdown) ? reward.breakdown : [];
    rewardLines.replaceChildren(...lines.map((x) => h('li', { class: 'sk-res-line' },
      h('span', { text: x.label }),
      h('b', { text: fmtDelta(x.points) }))));   // 쉬움 난이도 줄처럼 깎이는 값은 "-4"(앞에 +를 겹치지 않는다)
    setText(rewardTotal, reward.points != null ? t('results.balance', { points: fmtPoints(reward.points) }) : '');
    rewardTotal.hidden = reward.points == null;
    countUp(Math.round(num(reward.gained, 0)));   // 즉시 부활 값이 더 크면 이번 판은 음수(-15)다
    renderBonus(reward);
  }

  const rounds = h('ol', { class: 'sk-res-rounds', 'aria-label': t('results.rounds') });
  const mvpBox = h('div', { class: 'sk-res-mvp sk-steel' });
  const table = h('div', { class: 'sk-res-table' });
  const backBtn = btn(t('results.backToRoom'), () => leave('results:back'), 'sk-btn--primary sk-btn--big');
  const lobbyBtn = btn(t('results.toLobby'), () => leave('results:lobby'), 'sk-btn--ghost sk-btn--big');

  const teamGrid = h('div', { class: 'sk-res-grid' },
    h('section', { class: 'sk-panel sk-steel' }, h('h2', { class: 'sk-panel-title', text: t('results.rounds') }), rounds),
    mvpBox);
  const podium = h('section', { class: 'sk-res-podium', 'aria-label': t('results.podium'), hidden: true });
  const tableTitle = h('h2', { class: 'sk-panel-title', text: t('results.playerStats') });

  const el = h('section', { class: 'sk-screen sk-page sk-results', hidden: true, 'aria-label': t('results.report') },
    h('div', { class: 'sk-page-inner sk-res-inner' },
      banner,
      h('div', { class: 'sk-hazard', 'aria-hidden': 'true' }),
      summary,
      rewardBox,
      teamGrid,
      podium,
      h('section', { class: 'sk-panel sk-steel' }, tableTitle, table),
      h('div', { class: 'sk-res-actions' }, backBtn, lobbyBtn)));

  // ---------- 개인전 ----------
  function pod(x, place) {
    return h('div', { class: `sk-pod sk-pod--${place}` + (x.me ? ' is-me' : '') },
      h('span', { class: 'sk-pod-medal', 'aria-hidden': 'true' }, x.rank === 1 ? uiIcon('trophy') : h('b', { text: t('results.rank', { rank: x.rank }) })),
      h('b', { class: 'sk-pod-name' }, botName(x), x.me ? h('span', { class: 'sk-tag', text: t('results.me') }) : null),
      h('span', { class: 'sk-pod-kills', text: t('results.kd', { kills: x.kills, deaths: x.deaths }) }),
      h('div', { class: 'sk-pod-block', 'aria-label': t('results.rank', { rank: x.rank }) }, h('span', { text: x.rank })));
  }
  function renderFfa(p) {
    const rows = rankPlayers(normStatPlayers({ players: Array.isArray(p.ranking) && p.ranking.length ? p.ranking : p.players, meId: p.meId }));
    const target = Math.max(1, Math.floor(num(p.target != null ? p.target : p.killTarget, FFA_TARGET)));
    const me = rows.find((x) => x.me);
    let winner = null;
    if (p.reason !== 'draw') {
      if (p.winnerId != null) winner = rows.find((x) => x.id != null && String(x.id) === String(p.winnerId)) || null;
      const wName = p.winnerName || (winner && winner.name) || '';
      winner = wName ? { ...(winner || {}), name: wName } : null;
    }
    el.dataset.winner = winner ? 'ffa' : 'draw';
    setText(kicker, 'FREE FOR ALL');
    setText(titleEl, winner ? t('results.ffaWinner', { name: winner.name }) : t('results.draw'));
    const reasonFn = FFA_REASON[p.reason];
    setText(scoreEl, reasonFn ? reasonFn(target) : t('results.ffaTarget', { target }));
    let v = '';
    if (me) v = winner && (winner.me || (winner.id != null && winner.id === me.id)) ? t('results.youWon') : t('results.myRank', { rank: me.rank, total: rows.length });
    const m = p.mapName ? { name: p.mapName } : mapInfo(ctx.maps, p.maps, p.mapId);
    setText(verdict, [v, m && m.name].filter(Boolean).join(' · '));

    // 시상대: 2위 · 1위 · 3위 순서로 놓는다
    const top3 = rows.slice(0, 3);
    const order = [[top3[1], 2], [top3[0], 1], [top3[2], 3]].filter(([x]) => x);
    podium.replaceChildren(...(order.length ? order.map(([x, place]) => pod(x, place)) : [h('p', { class: 'sk-set-hint', text: t('results.noRecords') })]));

    setText(tableTitle, t('results.leaderboard'));
    table.replaceChildren(h('table', { class: 'sk-sb-table' },
      h('thead', {}, h('tr', {}, [t('results.colRank'), t('results.colName'), t('results.colKills'), t('results.colDeaths'), t('results.colHead')].map((c, i) => h('th', { scope: 'col', class: i === 1 ? '' : 'num', text: c })))),
      h('tbody', {}, rows.length ? rows.map((x) => h('tr', { class: x.me ? 'is-me' : '' },
        h('td', { class: 'num sk-sb-rank' + (x.rank <= 3 ? ' is-top' : ''), text: x.rank }),
        h('th', { scope: 'row', class: 'sk-sb-name' }, botName(x), x.me ? h('span', { class: 'sk-tag', text: t('results.me') }) : null),
        h('td', { class: 'num', text: x.kills }),
        h('td', { class: 'num', text: x.deaths }),
        h('td', { class: 'num', text: x.head })))
        : h('tr', {}, h('td', { colspan: 5, class: 'sk-sb-empty', text: t('results.noRecordsShort') })))));
  }

  // ---------- 좀비 물량 막기 ----------
  const fmtMs = (ms) => { const s = Math.max(0, Math.floor(num(ms, 0) / 1000)); return t('results.minSec', { m: Math.floor(s / 60), s: String(s % 60).padStart(2, '0') }); };
  function renderZombie(p) {
    const stage = Math.max(1, Math.floor(num(p.stage, 1)));
    const cleared = Math.max(0, Math.floor(num(p.cleared, stage - 1)));
    const best = Math.max(0, Math.floor(num(p.best, 0)));
    el.dataset.winner = 'zombie';
    setText(kicker, 'ZOMBIE HOLDOUT');
    setText(titleEl, t('results.zombieTitle', { stage }));
    setText(scoreEl, cleared ? t('results.zombieCleared', { cleared, time: fmtMs(p.ms) }) : t('results.zombieSurvived', { time: fmtMs(p.ms) }));
    const m = p.mapName ? { name: p.mapName } : mapInfo(ctx.maps, p.maps, p.mapId);
    setText(verdict, [p.newBest ? t('results.newBest') : best ? t('results.best', { best }) : '', m && m.name].filter(Boolean).join(' · '));
    // 고른 카드(내 것): 왼쪽 칸 · 기록 요약: 오른쪽 칸
    const cards = Array.isArray(p.cards) ? p.cards : [];
    rounds.replaceChildren(...(cards.length ? cards.map((c) => h('li', { class: 'sk-res-round sk-res-card', title: c.desc || null, style: { '--cd-color': c.color || '#c9d4e0' } },
      h('span', { class: 'sk-res-rn', text: c.icon || '🃏' }), h('span', { class: 'sk-res-rw', text: c.name }), c.n > 1 ? h('span', { class: 'sk-res-reason', text: `×${c.n}` }) : null))
      : [h('li', { class: 'sk-res-round', text: t('results.noCards') })]));
    const players = (Array.isArray(p.players) ? p.players : []).slice().sort((a, b) => num(b.kills) - num(a.kills));
    const me = players.find((x) => x.me) || players[0];
    mvpBox.replaceChildren(
      h('h2', { class: 'sk-panel-title', text: t('results.myStats') }),
      me ? h('dl', { class: 'sk-mvp-stats' },
        h('div', {}, h('dt', { text: t('results.kills') }), h('dd', { text: num(me.kills) | 0 })),
        h('div', {}, h('dt', { text: t('results.bosses') }), h('dd', { text: num(me.boss) | 0 })),
        h('div', {}, h('dt', { text: t('results.colHead') }), h('dd', { text: num(me.head) | 0 })),
        h('div', {}, h('dt', { text: t('results.damage') }), h('dd', { text: fmtNum(num(me.damage) | 0) })),
        h('div', {}, h('dt', { text: t('results.downs') }), h('dd', { text: num(me.downs) | 0 }))) : h('p', { class: 'sk-set-hint', text: t('results.noRecords') }));
    setText(tableTitle, t('results.squad'));
    table.replaceChildren(h('table', { class: 'sk-sb-table' },
      h('thead', {}, h('tr', {}, [t('results.colName'), t('results.kills'), t('results.colHead'), t('results.bosses'), t('results.damage'), t('results.downs'), t('results.cards')].map((c, i) => h('th', { scope: 'col', class: i ? 'num' : '', text: c })))),
      h('tbody', {}, players.length ? players.map((x) => h('tr', { class: x.me ? 'is-me' : '' },
        h('th', { scope: 'row', class: 'sk-sb-name' }, h('span', { text: x.name || t('common.playerPrefix') }), x.me ? h('span', { class: 'sk-tag', text: t('results.me') }) : null),
        h('td', { class: 'num', text: num(x.kills) | 0 }),
        h('td', { class: 'num', text: num(x.head) | 0 }),
        h('td', { class: 'num', text: num(x.boss) | 0 }),
        h('td', { class: 'num', text: fmtNum(num(x.damage) | 0) }),
        h('td', { class: 'num', text: num(x.downs) | 0 }),
        h('td', { class: 'num', text: num(x.cards) | 0 })))
        : h('tr', {}, h('td', { colspan: 7, class: 'sk-sb-empty', text: t('results.noRecordsShort') })))));
  }

  // ---------- 배틀로얄 (MODES.md 15절) ----------
  /**
   * p = { mode:'br', ranking:[{ id, name, bot, place, kills, head, survivedMs, alive }], total, winnerId, winnerName, meId, mapId, reward }
   * 순위(place)는 탈락 순서로 정한다: 마지막까지 남은 사람이 1위. 아직 살아 있는 사람(내가 먼저 결과를 본 경우)은 '생존 중'
   */
  function renderRoyale(p) {
    const total = Math.max(1, Math.floor(num(p.total, Array.isArray(p.ranking) ? p.ranking.length : 1)));
    const rows = (Array.isArray(p.ranking) ? p.ranking : []).map((x) => ({
      id: x.id, name: x.name || t('game.playerFallback'), bot: !!x.bot, me: x.id != null && x.id === p.meId,
      place: Math.max(1, Math.floor(num(x.place, total))), kills: Math.max(0, Math.floor(num(x.kills, 0))), head: Math.max(0, Math.floor(num(x.head, 0))),
      survivedMs: Math.max(0, num(x.survivedMs, 0)), alive: !!x.alive
    })).sort((a, b) => a.place - b.place || b.kills - a.kills);
    const me = rows.find((x) => x.me) || null;
    const won = !!me && p.winnerId != null && p.winnerId === me.id;
    el.dataset.winner = won ? 'ffa' : 'draw';
    setText(kicker, 'BATTLE ROYALE');
    setText(titleEl, won ? t('results.brWin') : me ? `#${me.place} / ${total}` : t('results.brOver'));
    setText(scoreEl, me ? t('results.brScore', { kills: me.kills, time: fmtMs(me.survivedMs) }) : '');
    const m = p.mapName ? { name: p.mapName } : mapInfo(ctx.maps, p.maps, p.mapId);
    const wn = p.winnerName || '';
    setText(verdict, [won ? t('results.brBeatAll') : wn ? t('results.brWinner', { name: wn }) : t('results.brUndecided'), m && m.name].filter(Boolean).join(' · '));
    summary.hidden = !me;
    if (me) {
      summary.replaceChildren(...[[t('results.colRank'), `#${me.place} / ${total}`], [t('results.kills'), me.kills], [t('results.brSurvived'), fmtMs(me.survivedMs)], [t('results.colHead'), me.head]]
        .map(([k, v]) => h('div', { class: 'sk-res-sum' }, h('dt', { text: k }), h('dd', { text: v }))));
    }
    const going = (x) => x.alive && !(p.winnerId != null && x.id === p.winnerId);   // 아직 싸우는 중(결과를 먼저 본 경우)
    // 시상대는 승부가 난 뒤에만(1~3위). 내가 먼저 결과를 보면 아직 싸우는 인원을 적는다
    const top3 = p.winnerId != null ? rows.filter((x) => x.place <= 3).slice(0, 3).map((x) => ({ ...x, rank: x.place, deaths: x.alive ? 0 : 1 })) : [];
    const order = [[top3[1], 2], [top3[0], 1], [top3[2], 3]].filter(([x]) => x);
    const left = rows.filter(going).length;
    podium.replaceChildren(...(order.length ? order.map(([x, place]) => pod(x, place)) : [h('p', { class: 'sk-set-hint', text: left ? t('results.brStillFighting', { n: left }) : t('results.noRecords') })]));
    setText(tableTitle, t('results.leaderboard'));
    table.replaceChildren(h('table', { class: 'sk-sb-table' },
      h('thead', {}, h('tr', {}, [t('results.colRank'), t('results.colName'), t('results.colKills'), t('results.colHead'), t('results.brSurvived')].map((c, i) => h('th', { scope: 'col', class: i === 1 ? '' : 'num', text: c })))),
      h('tbody', {}, rows.length ? rows.map((x) => h('tr', { class: x.me ? 'is-me' : '' },
        h('td', { class: 'num sk-sb-rank' + (x.place <= 3 && !going(x) ? ' is-top' : ''), text: going(x) ? t('results.brAlive') : `#${x.place}` }),
        h('th', { scope: 'row', class: 'sk-sb-name' }, botName(x), x.me ? h('span', { class: 'sk-tag', text: t('results.me') }) : null),
        h('td', { class: 'num', text: x.kills }),
        h('td', { class: 'num', text: x.head }),
        h('td', { class: 'num', text: going(x) ? '—' : fmtMs(x.survivedMs) })))
        : h('tr', {}, h('td', { colspan: 5, class: 'sk-sb-empty', text: t('results.noRecordsShort') })))));
  }

  function render(p) {
    renderReward(p.reward);
    const mode0 = modeKey(p.mode);
    renderSummary(mode0 === 'zombie' || mode0 === 'br' ? null : normStatPlayers({ players: Array.isArray(p.ranking) && p.ranking.length && mode0 === 'ffa' ? p.ranking : p.players, meId: p.meId }).find((x) => x.me) || null);
    const mode = modeKey(p.mode);
    const ffa = mode === 'ffa' || mode === 'br';
    el.dataset.mode = mode;
    teamGrid.hidden = ffa;
    podium.hidden = !ffa;
    setText(backBtn, p.backLabel || t('results.backToRoom'));
    setText(lobbyBtn, p.lobbyLabel || t('results.toLobby'));
    lobbyBtn.hidden = p.lobbyLabel === false;
    if (mode === 'br') { renderRoyale(p); return; }
    if (ffa) { renderFfa(p); return; }
    if (mode === 'zombie') {
      const head = teamGrid.querySelector('.sk-panel-title');
      if (head) setText(head, t('results.cardsPicked'));
      renderZombie(p);
      return;
    }
    { const head = teamGrid.querySelector('.sk-panel-title'); if (head) setText(head, t('results.rounds')); }
    setText(kicker, mode === 'bomb' ? 'BOMB MISSION' : 'MATCH RESULT');
    setText(tableTitle, t('results.playerStats'));
    renderTeam(p, mode === 'bomb');
  }

  /** 라운드 칸. 폭파 미션이면 끝난 방식 아이콘과 이긴 진영 줄을 더한다 */
  function roundItem(r, bomb) {
    const who = r.winner === 'draw' ? t('results.draw') : TEAMS[r.winner].name;
    if (!bomb) {
      return h('li', { class: `sk-res-round t-${r.winner}`, title: r.reason || null },
        h('span', { class: 'sk-res-rn', text: `R${r.n}` }),
        h('span', { class: 'sk-res-rw', text: who }),
        r.reason ? h('span', { class: 'sk-res-reason', text: r.reason }) : null);
    }
    const info = bombRoundInfo(r);
    return h('li', { class: `sk-res-round t-${r.winner}`, title: info.title, dataset: { reason: r.reasonCode } },
      h('span', { class: 'sk-res-rn', text: `R${r.n}` }),
      h('span', { class: 'sk-res-rw', text: who }),
      info.reason ? h('span', { class: 'sk-res-reason' }, BOMB_REASON_GLYPH[r.reasonCode] ? h('span', { class: 'sk-res-ico', 'aria-hidden': 'true' }, uiIcon(BOMB_REASON_GLYPH[r.reasonCode])) : null, info.reason) : null,
      info.side ? h('span', { class: 'sk-res-side', dataset: { side: info.won }, text: info.side }) : null);
  }

  function renderTeam(p, bomb = false) {
    const winner = p.winner === 'draw' ? 'draw' : teamKey(p.winner) || 'draw';
    const sc = p.score || {};
    const players = normStatPlayers(p).sort(byPerformance);
    const me = players.find((x) => x.me);
    const myTeam = teamKey(p.myTeam) || (me ? me.team : '');

    el.dataset.winner = winner;
    setText(titleEl, winner === 'draw' ? t('results.draw') : t('results.teamWins', { team: TEAMS[winner].name }));
    setText(scoreEl, (bomb ? t('results.bombPrefix') + ' · ' : '') + t('results.scoreLine', { blue: Math.floor(num(sc.owner, 0)), red: Math.floor(num(sc.charterer, 0)) }));
    let v = '';
    if (myTeam && winner !== 'draw') v = myTeam === winner ? t('results.teamWon') : t('results.teamLost');
    else if (winner === 'draw') v = t('results.noWinner');
    const m = p.mapName ? { name: p.mapName } : mapInfo(ctx.maps, p.maps, p.mapId);
    setText(verdict, [v, m && m.name].filter(Boolean).join(' · '));

    const rs = normRounds(p.rounds);
    rounds.replaceChildren(...(rs.length ? rs.map((r) => roundItem(r, bomb))
      : [h('li', { class: 'sk-res-round', text: t('results.noRounds') })]));

    // MVP: 지정값 → 최다 킬(동률이면 데스 적은 순 → 헤드샷 많은 순)
    let mvp = null;
    if (p.mvp) {
      const name = typeof p.mvp === 'string' ? p.mvp : p.mvp.name;
      // 같은 닉네임이 둘일 수 있다(같은 프로필의 두 탭 등). id가 있으면 id로 찾아야 다른 사람의 기록이 나오지 않는다
      const mvpId = typeof p.mvp === 'object' ? p.mvp.id : null;
      const same = (x) => (mvpId != null ? x.id === mvpId : x.name === name);
      mvp = players.find(same) || (typeof p.mvp === 'object' ? normStatPlayers({ players: [p.mvp] })[0] : { name, kills: 0, deaths: 0, head: 0, team: '' });
    } else if (players.length && players[0].kills > 0) mvp = players[0];
    mvpBox.replaceChildren(
      h('h2', { class: 'sk-panel-title', text: 'MVP' }),
      mvp ? h('div', { class: 'sk-mvp' },
        h('p', { class: `sk-mvp-name t-${mvp.team || 'none'}`, text: mvp.name }),
        mvp.team ? h('p', { class: `sk-mvp-team t-${mvp.team}`, text: t('results.teamName', { team: TEAMS[mvp.team].name }) }) : null,
        h('dl', { class: 'sk-mvp-stats' },
          h('div', {}, h('dt', { text: t('results.colKills') }), h('dd', { text: mvp.kills })),
          h('div', {}, h('dt', { text: t('results.colDeaths') }), h('dd', { text: mvp.deaths })),
          h('div', {}, h('dt', { text: t('results.colHead') }), h('dd', { text: mvp.head }))))
        : h('p', { class: 'sk-set-hint', text: t('results.noMvp') }));

    table.replaceChildren(h('table', { class: 'sk-sb-table' },
      h('thead', {}, h('tr', {}, [t('results.colName'), t('results.colTeam'), t('results.colKills'), t('results.colDeaths'), t('results.colHead')].map((c, i) => h('th', { scope: 'col', class: i > 1 ? 'num' : '', text: c })))),
      h('tbody', {}, players.length ? players.map((x) => h('tr', { class: x.me ? 'is-me' : '' },
        h('th', { scope: 'row', class: 'sk-sb-name' }, botName(x), x.me ? h('span', { class: 'sk-tag', text: t('results.me') }) : null),
        h('td', { class: `t-${x.team || 'none'}`, text: x.team ? TEAMS[x.team].name : '—' }),
        h('td', { class: 'num', text: x.kills }),
        h('td', { class: 'num', text: x.deaths }),
        h('td', { class: 'num', text: x.head })))
        : h('tr', {}, h('td', { colspan: 5, class: 'sk-sb-empty', text: t('results.noRecordsShort') })))));
  }

  return makeScreen(el, { render, onHide: () => { stopCount(); rewardSig = ''; }, onDispose: stopCount });
}
