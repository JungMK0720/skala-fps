/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 점수판(Tab 누르는 동안). 포인터 잠금 중에도 보이도록 입력은 받지 않는다. 팀전은 팀별 두 표, 개인전은 순위 번호가 붙은 한 목록이다.
 *          폭파 미션은 팀전 표에 공격/수비 꼬리표와 폭탄 소지(💣) 표시를 더한다.
 */
import { h, setText, num, TEAMS, TEAM_KEYS, teamKey, pingText, pingClass, modeKey, modeLabel, FFA_TARGET, SIDE_NAME, bombSide } from './dom.js';
import { makeScreen } from './parts.js';
import { mapInfo } from './icons.js';

export function normStatPlayers(p) {
  let list = Array.isArray(p.players) ? p.players : [];
  if (!list.length && p.teams && typeof p.teams === 'object') {
    list = TEAM_KEYS.flatMap((t) => (Array.isArray(p.teams[t]) ? p.teams[t].map((x) => ({ ...x, team: x.team || t })) : []));
  }
  return list.map((x) => ({
    id: x.id,
    name: x.name || '플레이어',
    team: teamKey(x.team),
    kills: Math.max(0, Math.floor(num(x.kills, 0))),
    deaths: Math.max(0, Math.floor(num(x.deaths, 0))),
    head: Math.max(0, Math.floor(num(x.head != null ? x.head : x.headshots, 0))),
    ping: x.ping,
    alive: x.alive !== false,
    bot: !!x.bot,
    me: !!x.me || (p.meId != null && x.id === p.meId),
    rank: x.rank != null && Number.isFinite(Number(x.rank)) ? Math.max(1, Math.floor(Number(x.rank))) : null,
    respawnIn: x.respawnIn != null && Number.isFinite(Number(x.respawnIn)) ? Math.max(0, Number(x.respawnIn)) : null,
    protect: !!x.protect,
    bomb: !!x.bomb, // 폭파 미션: 폭탄을 든 사람
  }));
}

export const byPerformance = (a, b) => b.kills - a.kills || a.deaths - b.deaths || b.head - a.head || String(a.name).localeCompare(String(b.name), 'ko');

/**
 * 개인전 순위: 킬↓ → 데스↑ → 헤드샷↓. 모두 rank를 주면 그대로 쓰고,
 * 아니면 같은 기록끼리 같은 순위(1, 2, 2, 4 …)를 매긴다.
 */
export function rankPlayers(list) {
  if (list.length && list.every((x) => x.rank != null)) return list.slice().sort((a, b) => a.rank - b.rank || byPerformance(a, b));
  const sorted = list.slice().sort(byPerformance);
  sorted.forEach((x, i) => {
    const prev = sorted[i - 1];
    x.rank = prev && prev.kills === x.kills && prev.deaths === x.deaths && prev.head === x.head ? prev.rank : i + 1;
  });
  return sorted;
}

export function createScoreboard(ctx) {
  let sig = '';
  const title = h('h2', { class: 'sk-sb-title sk-stencil', text: '점수판' });
  const meta = h('p', { class: 'sk-sb-meta' });
  const ownerScore = h('b');
  const chScore = h('b');
  const scoreLine = h('div', { class: 'sk-sb-score' },
    h('span', { class: 't-owner', text: `${TEAMS.owner.emoji} ${TEAMS.owner.name} ` }), ownerScore, h('span', { class: 'sk-sb-colon', text: ' : ' }), chScore,
    h('span', { class: 't-charterer', text: ` ${TEAMS.charterer.name} ${TEAMS.charterer.emoji}` }));
  const cols = h('div', { class: 'sk-sb-cols' });

  const el = h('section', { class: 'sk-screen sk-overlay sk-scoreboard', hidden: true, 'aria-label': '점수판' },
    h('div', { class: 'sk-sb-panel sk-steel' },
      h('div', { class: 'sk-hazard sk-hazard--thin', 'aria-hidden': 'true' }),
      h('header', { class: 'sk-sb-head' }, h('div', {}, title, meta), scoreLine),
      cols,
      h('p', { class: 'sk-sb-foot', text: 'Tab에서 손을 떼면 닫혀요' })));

  /** role: 폭파 미션의 이번 라운드 진영('attack'|'defense'), 팀전이면 '' */
  function teamTable(team, rows, role = '') {
    const T = TEAMS[team];
    const alive = rows.filter((x) => x.alive).length;
    const row = (x) => h('tr', { class: (x.me ? 'is-me ' : '') + (x.alive ? '' : 'is-dead') },
      h('th', { scope: 'row', class: 'sk-sb-name' }, h('span', { text: (x.bot ? '🤖 ' : '') + x.name }),
        x.bomb ? h('span', { class: 'sk-sb-bomb', text: '💣', title: '폭탄 소지', 'aria-label': '폭탄 소지' }) : null,
        x.me ? h('span', { class: 'sk-tag', text: '나' }) : null),
      h('td', { class: 'num', text: x.kills }),
      h('td', { class: 'num', text: x.deaths }),
      h('td', { class: 'num', text: x.head }),
      h('td', { class: 'num' }, h('span', { class: 'sk-ping ' + pingClass(x.ping), text: pingText(x.ping) })),
      h('td', { class: 'num sk-sb-state', text: x.alive ? '생존' : '☠ 전사' }));
    return h('section', { class: `sk-sb-team sk-sb-team--${team}` },
      h('h3', { class: 'sk-sb-team-name' },
        h('span', { text: `${T.emoji} ${T.name}` }), h('small', { text: T.en }),
        role ? h('span', { class: 'sk-sb-side', dataset: { side: role }, text: SIDE_NAME[role] }) : null,
        h('span', { class: 'sk-sb-team-alive', text: `생존 ${alive}/${rows.length}` })),
      h('table', { class: 'sk-sb-table' },
        h('thead', {}, h('tr', {}, ['이름', '킬', '데스', '헤드샷', '핑', '상태'].map((t, i) => h('th', { scope: 'col', class: i ? 'num' : '', text: t })))),
        h('tbody', {}, rows.length ? rows.map(row) : h('tr', {}, h('td', { colspan: 6, class: 'sk-sb-empty', text: '플레이어 없음' })))));
  }

  function ffaState(x) {
    if (x.alive) return x.protect ? '🛡 보호' : '생존';
    return x.respawnIn != null ? `☠ ${Math.ceil(x.respawnIn / 1000)}초` : '☠ 부활 대기';
  }
  function ffaTable(rows) {
    const row = (x) => h('tr', { class: (x.me ? 'is-me ' : '') + (x.alive ? '' : 'is-dead') },
      h('td', { class: 'num sk-sb-rank', text: x.rank }),
      h('th', { scope: 'row', class: 'sk-sb-name' }, h('span', { text: (x.bot ? '🤖 ' : '') + x.name }), x.me ? h('span', { class: 'sk-tag', text: '나' }) : null),
      h('td', { class: 'num', text: x.kills }),
      h('td', { class: 'num', text: x.deaths }),
      h('td', { class: 'num', text: x.head }),
      h('td', { class: 'num' }, h('span', { class: 'sk-ping ' + pingClass(x.ping), text: pingText(x.ping) })),
      h('td', { class: 'num sk-sb-state', text: ffaState(x) }));
    return h('section', { class: 'sk-sb-team sk-sb-team--ffa' },
      h('table', { class: 'sk-sb-table' },
        h('thead', {}, h('tr', {}, ['순위', '이름', '킬', '데스', '헤드샷', '핑', '상태'].map((t, i) => h('th', { scope: 'col', class: i === 1 ? '' : 'num', text: t })))),
        h('tbody', {}, rows.length ? rows.map(row) : h('tr', {}, h('td', { colspan: 7, class: 'sk-sb-empty', text: '플레이어 없음' })))));
  }

  function render(p) {
    const s = JSON.stringify(p);
    if (s === sig) return;
    sig = s;
    const mode = modeKey(p.mode);
    const ffa = mode === 'ffa';
    el.classList.toggle('is-ffa', ffa);
    scoreLine.hidden = ffa;
    if (ffa) {
      const rows = rankPlayers(normStatPlayers(p));
      const target = Math.max(1, Math.floor(num(p.target != null ? p.target : p.killTarget != null ? p.killTarget : p.score && p.score.target, FFA_TARGET)));
      const me = rows.find((x) => x.me);
      const m = p.mapName ? { name: p.mapName } : mapInfo(ctx.maps, p.maps, p.mapId);
      setText(title, `개인전 · 목표 ${target}킬`);
      setText(meta, [m && m.name, me ? `내 순위 ${me.rank}위 / ${rows.length}명` : `${rows.length}명`].filter(Boolean).join(' · '));
      cols.replaceChildren(ffaTable(rows));
      return;
    }
    // 팀전과 폭파 미션: 팀별 두 표. 폭파 미션은 제목에 모드, 팀 머리에 공격/수비(attack = 이번 라운드 공격 팀)
    const bomb = mode === 'bomb';
    const players = normStatPlayers(p);
    const sc = p.score || {};
    const target = Math.max(1, Math.floor(num(sc.target, 3)));
    const bestOf = Math.max(1, Math.floor(num(sc.bestOf, target * 2 - 1)));
    const round = p.round != null ? p.round : sc.round;
    const attack = bomb ? teamKey(p.attack != null ? p.attack : sc.attack) : '';
    const m = p.mapName ? { name: p.mapName } : mapInfo(ctx.maps, p.maps, p.mapId);
    setText(title, bomb ? modeLabel('bomb', { target, bestOf }) : '점수판');
    setText(meta, [m && m.name, round ? `라운드 ${round}` : '', bomb ? '' : `${bestOf}판 ${target}선승`].filter(Boolean).join(' · '));
    setText(ownerScore, Math.floor(num(sc.owner, 0)));
    setText(chScore, Math.floor(num(sc.charterer, 0)));
    cols.replaceChildren(...TEAM_KEYS.map((t) => teamTable(t, players.filter((x) => x.team === t).sort(byPerformance), bombSide(t, attack))));
  }

  return makeScreen(el, { render, onHide: () => { sig = ''; } });
}
