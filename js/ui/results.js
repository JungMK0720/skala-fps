/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 결과 화면. 팀전은 승리 팀·라운드 기록·MVP, 개인전은 시상대와 순위표를 보여 주고, reward 값이 있으면 획득 포인트를 올라가는 숫자로 보여 준다.
 *          폭파 미션은 팀전 화면에 라운드마다 끝난 방식(💥 폭파 · ✂️ 해체 · ☠️ 전멸 · ⏱ 시간)과 이긴 진영(공격/수비)을 더한다.
 */
import { h, btn, setText, num, fmtPoints, fmtDelta, TEAMS, teamKey, modeKey, FFA_TARGET, SIDE_NAME, bombSide } from './dom.js';
import { makeScreen } from './parts.js';
import { mapInfo } from './icons.js';
import { normStatPlayers, byPerformance, rankPlayers } from './scoreboard.js';

const MEDALS = { 1: '🥇', 2: '🥈', 3: '🥉' };
const COUNT_UP_MS = 900;
const COUNT_UP_STEP_MS = 30;
const FFA_REASON = {
  kills: (t) => `먼저 ${t}킬 달성`,
  time: () => '시간 종료 · 최다 킬 우승',
  forfeit: () => '다른 플레이어가 모두 나가 기권승',
  draw: () => '기록이 같아 승부를 가리지 못했어요',
};

/** 폭파 미션 라운드가 끝난 방식(reasonCode) → 아이콘과 기본 문구 */
const BOMB_REASON = Object.freeze({
  bomb: Object.freeze({ icon: '💥', label: '폭탄 폭파' }),
  defuse: Object.freeze({ icon: '✂️', label: '폭탄 해체' }),
  elimination: Object.freeze({ icon: '☠️', label: '전멸' }),
  time: Object.freeze({ icon: '⏱', label: '시간 종료' }),
});
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
  const side = won ? `${SIDE_NAME[won]} 승` : '';
  const title = [`R${r.n}`, reason && (why ? `${why.icon} ${reason}` : reason), side, r.attack ? `${TEAMS[r.attack].name} 공격` : ''].filter(Boolean).join(' · ');
  return { icon: why ? why.icon : '', reason, won, side, title };
}

export function createResults(ctx) {
  const banner = h('div', { class: 'sk-res-banner' });
  const kicker = h('p', { class: 'sk-res-kicker sk-stencil', text: 'MATCH RESULT' });
  const titleEl = h('h1', { class: 'sk-res-title sk-stencil' });
  const scoreEl = h('p', { class: 'sk-res-score' });
  const verdict = h('p', { class: 'sk-res-verdict' });
  banner.append(kicker, titleEl, scoreEl, verdict);

  // ---------- 획득 포인트 ----------
  const rewardNum = h('b', { class: 'sk-res-gain-num' });
  const rewardLines = h('ul', { class: 'sk-res-lines' });
  const rewardTotal = h('p', { class: 'sk-res-total' });
  const rewardBox = h('section', { class: 'sk-res-reward sk-steel', hidden: true, 'aria-label': '획득 포인트' },
    h('p', { class: 'sk-res-gain' }, rewardNum, h('span', { class: 'sk-res-gain-unit', text: 'P' })),
    rewardLines,
    rewardTotal);
  let rewardSig = '';
  let countTimer = null;

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
    setText(rewardTotal, reward.points != null ? `보유 ${fmtPoints(reward.points)}` : '');
    rewardTotal.hidden = reward.points == null;
    countUp(Math.max(0, Math.round(num(reward.gained, 0))));
  }

  const rounds = h('ol', { class: 'sk-res-rounds', 'aria-label': '라운드 기록' });
  const mvpBox = h('div', { class: 'sk-res-mvp sk-steel' });
  const table = h('div', { class: 'sk-res-table' });
  const backBtn = btn('방으로 돌아가기', () => ctx.emit('results:back', {}), 'sk-btn--primary sk-btn--big');
  const lobbyBtn = btn('로비로', () => ctx.emit('results:lobby', {}), 'sk-btn--ghost sk-btn--big');

  const teamGrid = h('div', { class: 'sk-res-grid' },
    h('section', { class: 'sk-panel sk-steel' }, h('h2', { class: 'sk-panel-title', text: '라운드 기록' }), rounds),
    mvpBox);
  const podium = h('section', { class: 'sk-res-podium', 'aria-label': '시상대', hidden: true });
  const tableTitle = h('h2', { class: 'sk-panel-title', text: '개인 기록' });

  const el = h('section', { class: 'sk-screen sk-page sk-results', hidden: true, 'aria-label': '매치 결과' },
    h('div', { class: 'sk-page-inner sk-res-inner' },
      banner,
      h('div', { class: 'sk-hazard', 'aria-hidden': 'true' }),
      rewardBox,
      teamGrid,
      podium,
      h('section', { class: 'sk-panel sk-steel' }, tableTitle, table),
      h('div', { class: 'sk-res-actions' }, backBtn, lobbyBtn)));

  // ---------- 개인전 ----------
  function pod(x, place) {
    return h('div', { class: `sk-pod sk-pod--${place}` + (x.me ? ' is-me' : '') },
      h('span', { class: 'sk-pod-medal', text: MEDALS[x.rank] || `${x.rank}위`, 'aria-hidden': 'true' }),
      h('b', { class: 'sk-pod-name' }, h('span', { text: (x.bot ? '🤖 ' : '') + x.name }), x.me ? h('span', { class: 'sk-tag', text: '나' }) : null),
      h('span', { class: 'sk-pod-kills', text: `${x.kills}킬 · ${x.deaths}데스` }),
      h('div', { class: 'sk-pod-block', 'aria-label': `${x.rank}위` }, h('span', { text: x.rank })));
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
    setText(titleEl, winner ? `🏆 ${winner.name} 우승!` : '무승부');
    const reasonFn = FFA_REASON[p.reason];
    setText(scoreEl, reasonFn ? reasonFn(target) : `개인전 · 목표 ${target}킬`);
    let v = '';
    if (me) v = winner && (winner.me || (winner.id != null && winner.id === me.id)) ? '🏆 내가 우승했어요!' : `내 순위 ${me.rank}위 / ${rows.length}명`;
    const m = p.mapName ? { name: p.mapName } : mapInfo(ctx.maps, p.maps, p.mapId);
    setText(verdict, [v, m && m.name].filter(Boolean).join(' · '));

    // 시상대: 2위 · 1위 · 3위 순서로 놓는다
    const top3 = rows.slice(0, 3);
    const order = [[top3[1], 2], [top3[0], 1], [top3[2], 3]].filter(([x]) => x);
    podium.replaceChildren(...(order.length ? order.map(([x, place]) => pod(x, place)) : [h('p', { class: 'sk-set-hint', text: '기록이 없어요.' })]));

    setText(tableTitle, '순위표');
    table.replaceChildren(h('table', { class: 'sk-sb-table' },
      h('thead', {}, h('tr', {}, ['순위', '이름', '킬', '데스', '헤드샷'].map((t, i) => h('th', { scope: 'col', class: i === 1 ? '' : 'num', text: t })))),
      h('tbody', {}, rows.length ? rows.map((x) => h('tr', { class: x.me ? 'is-me' : '' },
        h('td', { class: 'num sk-sb-rank', text: MEDALS[x.rank] ? `${MEDALS[x.rank]} ${x.rank}` : x.rank }),
        h('th', { scope: 'row', class: 'sk-sb-name' }, h('span', { text: (x.bot ? '🤖 ' : '') + x.name }), x.me ? h('span', { class: 'sk-tag', text: '나' }) : null),
        h('td', { class: 'num', text: x.kills }),
        h('td', { class: 'num', text: x.deaths }),
        h('td', { class: 'num', text: x.head })))
        : h('tr', {}, h('td', { colspan: 5, class: 'sk-sb-empty', text: '기록 없음' })))));
  }

  function render(p) {
    renderReward(p.reward);
    const mode = modeKey(p.mode);
    const ffa = mode === 'ffa';
    el.dataset.mode = mode;
    teamGrid.hidden = ffa;
    podium.hidden = !ffa;
    setText(backBtn, p.backLabel || '방으로 돌아가기');
    setText(lobbyBtn, p.lobbyLabel || '로비로');
    lobbyBtn.hidden = p.lobbyLabel === false;
    if (ffa) { renderFfa(p); return; }
    setText(kicker, mode === 'bomb' ? 'BOMB MISSION' : 'MATCH RESULT');
    setText(tableTitle, '개인 기록');
    renderTeam(p, mode === 'bomb');
  }

  /** 라운드 칸. 폭파 미션이면 끝난 방식 아이콘과 이긴 진영 줄을 더한다 */
  function roundItem(r, bomb) {
    const who = r.winner === 'draw' ? '무승부' : `${TEAMS[r.winner].emoji} ${TEAMS[r.winner].name}`;
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
      info.reason ? h('span', { class: 'sk-res-reason' }, info.icon ? h('span', { class: 'sk-res-ico', text: info.icon, 'aria-hidden': 'true' }) : null, info.reason) : null,
      info.side ? h('span', { class: 'sk-res-side', dataset: { side: info.won }, text: info.side }) : null);
  }

  function renderTeam(p, bomb = false) {
    const winner = p.winner === 'draw' ? 'draw' : teamKey(p.winner) || 'draw';
    const sc = p.score || {};
    const players = normStatPlayers(p).sort(byPerformance);
    const me = players.find((x) => x.me);
    const myTeam = teamKey(p.myTeam) || (me ? me.team : '');

    el.dataset.winner = winner;
    setText(titleEl, winner === 'draw' ? '무승부' : `${TEAMS[winner].name} 팀 승리`);
    setText(scoreEl, `${bomb ? '폭파 미션 · ' : ''}블루 ${Math.floor(num(sc.owner, 0))} : ${Math.floor(num(sc.charterer, 0))} 레드`);
    let v = '';
    if (myTeam && winner !== 'draw') v = myTeam === winner ? '🏆 우리 팀이 이겼어요!' : '패배 — 다음 매치를 노려 보세요.';
    else if (winner === 'draw') v = '승부를 가리지 못했어요.';
    const m = p.mapName ? { name: p.mapName } : mapInfo(ctx.maps, p.maps, p.mapId);
    setText(verdict, [v, m && m.name].filter(Boolean).join(' · '));

    const rs = normRounds(p.rounds);
    rounds.replaceChildren(...(rs.length ? rs.map((r) => roundItem(r, bomb))
      : [h('li', { class: 'sk-res-round', text: '라운드 기록이 없어요.' })]));

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
        mvp.team ? h('p', { class: 'sk-mvp-team', text: `${TEAMS[mvp.team].emoji} ${TEAMS[mvp.team].name}` }) : null,
        h('dl', { class: 'sk-mvp-stats' },
          h('div', {}, h('dt', { text: '킬' }), h('dd', { text: mvp.kills })),
          h('div', {}, h('dt', { text: '데스' }), h('dd', { text: mvp.deaths })),
          h('div', {}, h('dt', { text: '헤드샷' }), h('dd', { text: mvp.head }))))
        : h('p', { class: 'sk-set-hint', text: '이번 매치엔 MVP가 없어요.' }));

    table.replaceChildren(h('table', { class: 'sk-sb-table' },
      h('thead', {}, h('tr', {}, ['이름', '팀', '킬', '데스', '헤드샷'].map((t, i) => h('th', { scope: 'col', class: i > 1 ? 'num' : '', text: t })))),
      h('tbody', {}, players.length ? players.map((x) => h('tr', { class: x.me ? 'is-me' : '' },
        h('th', { scope: 'row', class: 'sk-sb-name' }, h('span', { text: (x.bot ? '🤖 ' : '') + x.name }), x.me ? h('span', { class: 'sk-tag', text: '나' }) : null),
        h('td', { class: `t-${x.team || 'none'}`, text: x.team ? TEAMS[x.team].name : '—' }),
        h('td', { class: 'num', text: x.kills }),
        h('td', { class: 'num', text: x.deaths }),
        h('td', { class: 'num', text: x.head })))
        : h('tr', {}, h('td', { colspan: 5, class: 'sk-sb-empty', text: '기록 없음' })))));
  }

  return makeScreen(el, { render, onHide: () => { stopCount(); rewardSig = ''; }, onDispose: stopCount });
}
