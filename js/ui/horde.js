/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 좀비 물량 막기 HUD 띠. 화면 위 가운데에 스테이지·스테이지 남은 시간(40초)·남은 좀비, 그 아래 팀 레벨과 경험치 막대,
 *          보스 체력 막대(최대 3개), 왼쪽 위에 함께하는 사람들의 체력(증강을 고르는 사람은 표시)을 보여 준다. 입력은 받지 않는다.
 */
import { h, setText, num, clamp } from './dom.js';
import { makeScreen } from './parts.js';

const PHASE_TEXT = Object.freeze({
  prep: (p) => `작전 준비 · ${p.time}초 뒤 1스테이지 · 무기는 지금만 고를 수 있어요`,
  wave: (p) => `${p.bosses && p.bosses.length ? `보스 ${p.bosses.length}마리 · ` : ''}남은 좀비 ${p.left}${p.pickedText ? ` · 증강 고르는 중: ${p.pickedText}` : ''}`,
  cards: () => '레벨 업! · 증강 고르는 중(게임 멈춤)',
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
  // 스테이지 남은 시간(40초가 줄어든다)과 팀 레벨·경험치 막대
  const stageTime = h('b', { class: 'sk-hz-time' });
  const lvText = h('b', { class: 'sk-hz-lv', text: 'Lv 1' });
  const xpFill = h('i', { class: 'sk-hz-xpfill' });
  const xpText = h('span', { class: 'sk-hz-xpnum' });
  const xpRow = h('div', { class: 'sk-hz-xp', 'aria-label': '팀 레벨과 경험치' }, lvText, h('span', { class: 'sk-hz-xpbar' }, xpFill), xpText);
  const top = h('div', { class: 'sk-hz-top sk-steel' },
    h('div', { class: 'sk-hz-stage' }, h('span', { class: 'sk-hz-ico', text: '🧟', 'aria-hidden': 'true' }), stageLbl, stageNum),
    stageTime,
    h('div', { class: 'sk-hz-sub' }, line, clock));
  const el = h('section', { class: 'sk-screen sk-hz', hidden: true, 'aria-label': '좀비 물량 막기 상황', 'aria-live': 'off' },
    top, xpRow, bossBox, teamBox, warn);

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
    const sig = JSON.stringify(rows.map((x) => [x.id, x.name, Math.round(num(x.hp, 0)), x.maxHp, x.alive, x.me, x.picking, x.invuln, x.shield]));
    if (sig === teamSig) return;
    teamSig = sig;
    teamBox.hidden = rows.length <= 1;
    teamBox.replaceChildren(...rows.map((x) => {
      const r = clamp(num(x.hp, 0) / Math.max(1, num(x.maxHp, 100)), 0, 1);
      return h('li', { class: 'sk-hz-mate' + (x.me ? ' is-me' : '') + (x.alive ? '' : ' is-down') },
        h('span', { class: 'sk-hz-mname', text: `${x.alive ? '' : '💀 '}${x.name}${x.me ? ' (나)' : ''}${x.picking ? ' · 증강 고르는 중 🛡' : x.invuln ? ' 🛡' : ''}` }),
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
    setText(clock, p.elapsed ? `생존 ${p.elapsed}` : '');
    // 스테이지 남은 시간: 웨이브·증강 고르기 중에만, 10초 아래면 빨갛게
    const st = p.stageLeft == null ? null : Math.max(0, Math.ceil(num(p.stageLeft, 0)));
    stageTime.hidden = st == null || (phase !== 'wave' && phase !== 'cards');
    setText(stageTime, st == null ? '' : `⏱ ${st}초`);
    stageTime.classList.toggle('is-urgent', st != null && st <= 10 && phase === 'wave');
    const xp = p.xp && typeof p.xp === 'object' ? p.xp : null;
    xpRow.hidden = !xp || phase === 'over';
    if (xp) {
      setText(lvText, `Lv ${Math.max(1, num(xp.level, 1) | 0)}`);
      setText(xpText, `${Math.max(0, num(xp.xp, 0) | 0)} / ${Math.max(1, num(xp.need, 10) | 0)}`);
      xpFill.style.transform = `scaleX(${clamp(num(xp.xp, 0) / Math.max(1, num(xp.need, 10)), 0, 1).toFixed(3)})`;
    }
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
