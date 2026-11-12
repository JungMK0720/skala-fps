/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 좀비 물량 막기 HUD 띠. 화면 위 가운데에 스테이지·남은 좀비·남은 시간, 그 아래 보스 체력 막대(최대 3개),
 *          왼쪽 위에 함께하는 사람들의 체력을 보여 준다. 입력은 받지 않는다(포인터 잠금 중에도 보인다).
 */
import { h, setText, num, clamp } from './dom.js';
import { makeScreen } from './parts.js';

const PHASE_TEXT = Object.freeze({
  prep: (p) => `작전 준비 · ${p.time}초 뒤 1스테이지`,
  wave: (p) => (p.bosses && p.bosses.length ? `보스 ${p.bosses.length}마리 · 남은 좀비 ${p.left}` : `남은 좀비 ${p.left}`),
  cards: (p) => `스테이지 클리어! · 카드 고르는 중${p.pickedText ? ` · ${p.pickedText}` : ''}`,
  break: (p) => `다음 스테이지까지 ${p.time}초`,
  over: () => '전멸 · 작전 종료'
});

export function createHordeHud(ctx) {
  void ctx;
  const stageNum = h('b', { class: 'sk-hz-stage-n', text: '1' });
  const stageLbl = h('span', { class: 'sk-hz-stage-l', text: '스테이지' });
  const line = h('span', { class: 'sk-hz-line' });
  const clock = h('span', { class: 'sk-hz-clock' });
  const bossBox = h('div', { class: 'sk-hz-bosses' });
  const teamBox = h('ul', { class: 'sk-hz-team', 'aria-label': '동료' });
  const warn = h('div', { class: 'sk-hz-warn', hidden: true });
  const top = h('div', { class: 'sk-hz-top sk-steel' },
    h('div', { class: 'sk-hz-stage' }, h('span', { class: 'sk-hz-ico', text: '🧟', 'aria-hidden': 'true' }), stageLbl, stageNum),
    h('div', { class: 'sk-hz-sub' }, line, clock));
  const el = h('section', { class: 'sk-screen sk-hz', hidden: true, 'aria-label': '좀비 물량 막기 상황', 'aria-live': 'off' },
    top, bossBox, teamBox, warn);

  const bossRows = [];
  function bossRow(i) {
    while (bossRows.length <= i) {
      const name = h('span', { class: 'sk-hz-bname' });
      const fill = h('i', { class: 'sk-hz-bfill' });
      const pct = h('span', { class: 'sk-hz-bpct' });
      const skill = h('span', { class: 'sk-hz-bskill' });
      const row = h('div', { class: 'sk-hz-boss' }, h('div', { class: 'sk-hz-bhead' }, name, skill, pct), h('div', { class: 'sk-hz-bbar' }, fill));
      bossBox.append(row);
      bossRows.push({ row, name, fill, pct, skill });
    }
    return bossRows[i];
  }

  let teamSig = '';
  function renderTeam(list) {
    const rows = Array.isArray(list) ? list : [];
    const sig = JSON.stringify(rows.map((x) => [x.id, x.name, Math.round(num(x.hp, 0)), x.maxHp, x.alive, x.me, x.picked, x.shield]));
    if (sig === teamSig) return;
    teamSig = sig;
    teamBox.hidden = rows.length <= 1;
    teamBox.replaceChildren(...rows.map((x) => {
      const r = clamp(num(x.hp, 0) / Math.max(1, num(x.maxHp, 100)), 0, 1);
      return h('li', { class: 'sk-hz-mate' + (x.me ? ' is-me' : '') + (x.alive ? '' : ' is-down') },
        h('span', { class: 'sk-hz-mname', text: `${x.alive ? '' : '💀 '}${x.name}${x.me ? ' (나)' : ''}${x.picked ? ' ✔' : ''}` }),
        h('span', { class: 'sk-hz-mbar' }, h('i', { style: { transform: `scaleX(${r.toFixed(3)})` } }), x.shield > 0 ? h('b', { class: 'sk-hz-shield', style: { width: `${clamp(x.shield / Math.max(1, num(x.maxHp, 100)), 0, 1) * 100}%` } }) : null),
        h('span', { class: 'sk-hz-mhp', text: x.alive ? String(Math.max(0, Math.round(num(x.hp, 0)))) : '다음 스테이지에 부활' }));
    }));
  }

  function render(p) {
    const phase = p.phase || 'prep';
    setText(stageNum, String(Math.max(phase === 'prep' ? 1 : 0, num(p.stage, 1) | 0) || 1));
    const time = Math.max(0, Math.ceil(num(p.timeLeft, 0)));
    const fmt = PHASE_TEXT[phase] || PHASE_TEXT.wave;
    setText(line, fmt({ ...p, time, left: Math.max(0, num(p.left, 0) | 0) }));
    setText(clock, p.elapsed ? `⏱ ${p.elapsed}` : '');
    top.classList.toggle('is-boss', !!(p.bosses && p.bosses.length));
    top.classList.toggle('is-clear', phase === 'cards' || phase === 'break');
    const bosses = Array.isArray(p.bosses) ? p.bosses : [];
    for (let i = 0; i < bossRows.length; i++) bossRows[i].row.hidden = i >= bosses.length;
    bosses.forEach((b, i) => {
      const r = bossRow(i);
      r.row.hidden = false;
      const frac = clamp(num(b.hpFrac, 0), 0, 1);
      setText(r.name, `${b.icon || '👑'} ${b.name || '보스'}${b.enraged ? ' · 분노' : ''}`);
      setText(r.pct, `${Math.ceil(frac * 100)}%`);
      setText(r.skill, b.skill ? `⚠ ${b.skill}` : '');
      r.fill.style.transform = `scaleX(${frac.toFixed(3)})`;
      r.row.classList.toggle('is-rage', !!b.enraged);
    });
    renderTeam(p.team);
    setText(warn, p.warn || '');
    warn.hidden = !p.warn;
  }

  return makeScreen(el, { render, onHide: () => { teamSig = ''; } });
}
