/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 좀비 물량 막기 HUD 띠. 화면 위 가운데에 스테이지·스테이지 남은 시간(40초)·남은 좀비, 그 아래 팀 레벨과 경험치 막대,
 *          보스 체력 막대(최대 3개), 왼쪽 위에 함께하는 사람들의 체력(증강을 고르는 사람은 표시)을 보여 준다. 입력은 받지 않는다.
 *          멀티에서 동료를 살리는 중이거나 동료가 나를 살리는 중이면 크로스헤어 아래에 살리기 막대를 띄운다.
 */
import { h, setText, num, clamp } from './dom.js';
import { makeScreen } from './parts.js';

const PHASE_TEXT = Object.freeze({
  prep: (p) => `작전 준비 · ${p.time}초 뒤 1스테이지 · 무기는 지금만 고를 수 있어요`,
  wave: (p) => `${p.bosses && p.bosses.length ? `보스 ${p.bosses.length}마리 · ` : ''}남은 좀비 ${p.left}${p.pickedText ? ` · 증강 고르는 중: ${p.pickedText}` : ''}`,
  cards: (p) => `${p.pickWhy === 'chest' ? '보물 상자!' : '레벨 업!'} · 증강 고르는 중(게임 멈춤)`,
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
  const field = h('div', { class: 'sk-hz-field', hidden: true, 'aria-hidden': 'true' });
  const fieldText = h('span', { class: 'sk-hz-field-text' });
  field.append(fieldText);
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
  // 살리기 막대(크로스헤어 아래): p.revive = { text, frac } | null
  const reviveText = h('span', { class: 'sk-hz-revive-t' });
  const reviveFill = h('i');
  const revive = h('div', { class: 'sk-hz-revive', hidden: true }, reviveText, h('span', { class: 'sk-hz-revive-bar' }, reviveFill));
  const el = h('section', { class: 'sk-screen sk-hz', hidden: true, 'aria-label': '좀비 물량 막기 상황', 'aria-live': 'off' },
    field, top, xpRow, bossBox, teamBox, warn, revive);

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

  /** 쓰러진 사람의 진행(0..1, 동료가 살리는 중일 때만) | null */
  const reviveOf = (x) => (!x.alive && x.down && typeof x.down === 'object' && x.down.by ? clamp(num(x.down.progress, 0), 0, 1) : null);
  /**
   * 쓰러진 사람 줄의 글자: 살리는 중이면 진행, 아니면 일어나는 길. 멀티에서 쓰러진 자리가 있는 몸(canRevive)은 동료가 곁에서 3초 눌러 살린다.
   * 휴대폰 동료 목록(150px)에서 한 줄에 들어가게 짧게 쓰고, 키 이름은 넣지 않는다(PC는 F, 휴대폰은 살리기 버튼). 내 줄은 내가 할 일이 아니라 기다리는 말
   */
  const downText = (x) => {
    const r = reviveOf(x);
    if (r != null) return `살리는 중 ${Math.round(r * 100)}%`;
    if (!x.canRevive) return x.noAutoRevive ? '동료가 살려야 부활' : '다음 스테이지에 부활';
    return x.me ? '동료가 살릴 수 있어요' : '곁에서 3초 눌러 살리기';
  };

  let teamSig = '';
  function renderTeam(list) {
    const rows = Array.isArray(list) ? list : [];
    const sig = JSON.stringify(rows.map((x) => [x.id, x.name, Math.round(num(x.hp, 0)), x.maxHp, x.alive, x.me, x.picking, x.invuln, x.shield, x.alive ? '' : downText(x)]));
    if (sig === teamSig) return;
    teamSig = sig;
    teamBox.hidden = rows.length <= 1;
    teamBox.replaceChildren(...rows.map((x) => {
      // 동료가 살리는 중이면 막대가 체력 대신 살리기 진행을 채운다
      const rev = reviveOf(x);
      const r = rev != null ? rev : clamp(num(x.hp, 0) / Math.max(1, num(x.maxHp, 100)), 0, 1);
      return h('li', { class: 'sk-hz-mate' + (x.me ? ' is-me' : '') + (x.alive ? '' : ' is-down') + (rev != null ? ' is-reviving' : '') },
        h('span', { class: 'sk-hz-mname', text: `${x.alive ? '' : '💀 '}${x.name}${x.me ? ' (나)' : ''}${x.picking ? ' · 증강 고르는 중 🛡' : x.invuln ? ' 🛡' : ''}` }),
        h('span', { class: 'sk-hz-mbar' }, h('i', { style: { transform: `scaleX(${r.toFixed(3)})` } }), x.shield > 0 ? h('b', { class: 'sk-hz-shield', style: { width: `${clamp(x.shield / Math.max(1, num(x.maxHp, 100)), 0, 1) * 100}%` } }) : null),
        h('span', { class: 'sk-hz-mhp', text: x.alive ? String(Math.max(0, Math.round(num(x.hp, 0)))) : downText(x) }));
    }));
  }

  /** 살리기 막대: 보이기 시작할 때는 빈 막대에서 채운다(지난번 끝 값에서 거꾸로 줄지 않게) */
  function renderRevive(rv) {
    const on = !!(rv && typeof rv === 'object');
    if (!on) {
      if (!revive.hidden) { revive.hidden = true; reviveFill.style.transform = 'scaleX(0)'; }
      return;
    }
    revive.hidden = false;
    // 쓰러진 내 화면: 아래의 관전 이름표와 겹치지 않게 그 위로 올린다(css .sk-hz-revive.is-down)
    revive.classList.toggle('is-down', !!rv.down);
    setText(reviveText, rv.text || '');
    reviveFill.style.transform = `scaleX(${clamp(num(rv.frac, 0), 0, 1).toFixed(3)})`;
  }
  const FIELD_TEXT = Object.freeze({ acid: '산성 장판', fire: '화염 장판', web: '거미줄 장판', frost: '빙결 장판', shock: '감전 장판' });
  let fieldKind = null;
  function renderField(kind) {
    const label = FIELD_TEXT[kind] || '';
    if ((label ? kind : null) === fieldKind) return;
    fieldKind = label ? kind : null;
    field.hidden = !label;
    field.className = `sk-hz-field${label ? ` is-${kind}` : ''}`;
    setText(fieldText, label ? `${label} 안에 있어요` : '');
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
    renderRevive(p.revive);
    renderField(p.field);
  }

  return makeScreen(el, { render, onHide: () => { teamSig = ''; renderRevive(null); renderField(null); } });
}
