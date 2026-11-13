/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: WebAudio 합성 효과음·이모트 비트 엔진. 효과음은 코드로 합성해 캐시하고 보이스 풀로 재생한다.
 *          이모트는 audio/emotes의 음원 묶음(manifest)이 있으면 풀어서 쓰고, 없거나 못 읽으면 합성음으로 돌아간다.
 *          연속 킬 안내 음성(audio/voice, TTS로 합성한 mp3)은 받아서 디코드해 두었다가 전용 보이스 하나로 낸다.
 */
import { EMOTES } from '../core/consts.js';
import { decryptEmote } from './emote-key.js';

// createAudio() → { unlock, setVolume, setListener, play, stopAll, setQuality, getStats, dispose }
// 그래프: [보이스 풀: Gain → LowPass → Panner(HRTF)] → mix → Compressor → makeup → Limiter → SoftClip → Volume → out
//                                          └→ reverb send → Convolver(합성 IR) → mix

/* ───────────── 작은 DSP 도구 (Float32Array 위에서 동작, 동기 렌더) ───────────── */

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

// TPT 상태변수 필터(무조건 안정). fc: Hz 또는 (u∈[0,1]) => Hz. band 출력은 피크 이득 1로 정규화.
function svf(buf, sr, mode, fc, q = 0.707) {
  const k = 1 / q, n = buf.length, dyn = typeof fc === 'function';
  const m = mode === 'low' ? 0 : mode === 'band' ? 1 : 2;
  let ic1 = 0, ic2 = 0, a1 = 0, a2 = 0, a3 = 0;
  const coef = (f) => {
    const g = Math.tan(Math.PI * Math.min(Math.max(f, 20), sr * 0.45) / sr);
    a1 = 1 / (1 + g * (g + k)); a2 = g * a1; a3 = g * a2;
  };
  if (!dyn) coef(fc);
  for (let i = 0; i < n; i++) {
    if (dyn && (i & 15) === 0) coef(fc(i / n));
    const v0 = buf[i], v3 = v0 - ic2;
    const v1 = a1 * ic1 + a2 * v3;
    const v2 = ic2 + a2 * ic1 + a3 * v3;
    ic1 = 2 * v1 - ic1; ic2 = 2 * v2 - ic2;
    buf[i] = m === 0 ? v2 : m === 1 ? k * v1 : v0 - k * v1 - v2;
  }
  return buf;
}

// 엔벌로프: exp(기본) | bell(sin²) | hold(어택→유지→지수 릴리스)
function envAt(x, o) {
  if (o.env === 'bell') return Math.sin(Math.PI * Math.min(1, x / o.dur)) ** 2;
  const a = o.a ?? 0.001;
  if (x < a) return x / a;
  const y = x - a;
  if (o.env === 'hold') { const h = o.h ?? 0; return y < h ? 1 : Math.exp(-(y - h) / o.d); }
  return Math.exp(-y / o.d);
}

// 대역 제한 배음 웨이브테이블(가산 합성보다 훨씬 빠름). 배음 수·기울기·홀수 여부가 같으면 캐시 재사용.
const WAVE_TABLES = new Map();
function waveTable(harm, tilt, odd, fmax, sr) {
  let nh = 0;
  for (let h = 1; h <= harm && fmax * h < sr * 0.45; h++) nh = h;
  const key = nh + '|' + tilt + '|' + (odd ? 1 : 0);
  let t = WAVE_TABLES.get(key);
  if (!t) {
    const N = 2048;
    t = new Float32Array(N + 1);
    for (let h = 1; h <= nh; h++) {
      if (odd && h % 2 === 0) continue;
      const amp = 1 / h ** tilt;
      for (let j = 0; j <= N; j++) t[j] += Math.sin((2 * Math.PI * h * j) / N) * amp;
    }
    WAVE_TABLES.set(key, t);
  }
  return t;
}

// 한 소리를 레이어 단위로 쌓는 합성기. 메서드는 체이닝 가능.
function synth(sr, dur, seed) {
  const n = Math.max(1, Math.ceil(sr * dur));
  const out = new Float32Array(n);
  const rnd = mulberry32(seed);
  const fadeN = Math.floor(sr * 0.005);
  const span = (t, d) => {
    const i0 = Math.max(0, Math.floor(t * sr));
    return [i0, Math.max(0, Math.min(n - i0, Math.ceil(d * sr)))];
  };
  const tailFade = (i, len) => (i > len - fadeN ? (len - i) / fadeN : 1);
  const S = {
    sr, out, rnd,
    r: (a, b) => a + (b - a) * rnd(),
    // 노이즈 레이어: { t, dur, g, a, d, env, h, lp, hp, bp, q, brown }
    noise(o) {
      const d = o.dur ?? 0.1, [i0, len] = span(o.t ?? 0, d);
      if (!len) return S;
      const e = { env: o.env, a: o.a, h: o.h, d: o.d ?? d / 4, dur: d };
      const tmp = new Float32Array(len);
      let b = 0;
      for (let i = 0; i < len; i++) {
        let w = rnd() * 2 - 1;
        if (o.brown) { b = (b + 0.04 * w) / 1.04; w = b * 4; }
        tmp[i] = w * envAt(i / sr, e) * tailFade(i, len);
      }
      if (o.bp) svf(tmp, sr, 'band', o.bp, o.q ?? 1);
      if (o.lp) svf(tmp, sr, 'low', o.lp, 0.707);
      if (o.hp) svf(tmp, sr, 'high', o.hp, 0.707);
      const g = o.g ?? 1;
      for (let i = 0; i < len; i++) out[i0 + i] += tmp[i] * g;
      return S;
    },
    // 음정 레이어: { t, dur, f, f1, glide, g, a, d, env, h, tri, harm, tilt, vib, vibF }
    tone(o) {
      const d = o.dur ?? 0.3, [i0, len] = span(o.t ?? 0, d);
      if (!len) return S;
      const f0 = o.f, f1 = o.f1 ?? o.f, g = o.g ?? 1;
      const vib = o.vib ?? 0, vf = o.vibF ?? 5;
      const table = (o.harm ?? 1) > 1 ? waveTable(o.harm, o.tilt ?? 1, !!o.odd, Math.max(f0, f1), sr) : null;
      // 글라이드 f = f1 + (f0-f1)·e^(-x/glide) 와 엔벌로프(어택 선형 → 유지 → 지수 감쇠)를 곱셈 누적으로 계산.
      // 감쇠가 들리지 않을 만큼 작아지면 중단한다(루프 음악처럼 음표가 많을 때 빠름).
      const gk = Math.exp(-1 / ((o.glide ?? 0.05) * sr));
      // bell = sin²(πu) = (1 − cos 2πu)/2, 비브라토 sin 도 재귀 발진기로(샘플당 Math.sin 없음)
      const bell = o.env === 'bell', bellN = d * sr, bc = 2 * Math.cos((2 * Math.PI) / bellN);
      let bk1 = 1, bk0 = Math.cos((2 * Math.PI) / bellN);
      const vw = (2 * Math.PI * vf) / sr, vc = 2 * Math.cos(vw);
      let vs1 = 0, vs0 = -Math.sin(vw);
      const aN = Math.max(1, Math.round((o.a ?? 0.001) * sr));
      const hN = o.env === 'hold' ? Math.round((o.h ?? 0) * sr) : 0;
      const dk = Math.exp(-1 / ((o.d ?? d / 3) * sr));
      let gd = f0 - f1, ev = 1;
      let ph = rnd();                       // 위상(0..1 사이클)
      for (let i = 0; i < len; i++) {
        let env;
        if (bell) {
          if (i >= bellN) break;
          env = (1 - bk1) * 0.5;
          const nk = bc * bk1 - bk0; bk0 = bk1; bk1 = nk;
        } else if (i < aN) env = i / aN;
        else if (i < aN + hN) env = 1;
        else { env = ev; ev *= dk; if (ev < 1e-5) break; }
        let f = f1 + gd; gd *= gk;
        if (vib) { f *= 1 + vib * vs1; const nv = vc * vs1 - vs0; vs0 = vs1; vs1 = nv; }
        ph += f / sr; ph -= Math.floor(ph);
        let s;
        if (table) { const p = ph * 2048, j = p | 0; s = table[j] + (table[j + 1] - table[j]) * (p - j); }
        else if (o.tri) s = 1 - 4 * Math.abs(ph - 0.5);
        else s = Math.sin(2 * Math.PI * ph);
        out[i0 + i] += s * g * env * tailFade(i, len);
      }
      return S;
    },
    // 비조화 금속 울림: { t, f:[Hz], amp:[], dec:[s], g }
    ring(o) {
      const g = o.g ?? 1, fs = o.f, am = o.amp || [], dc = o.dec;
      const [i0, len] = span(o.t ?? 0, Math.max(...dc) * 6);
      if (!len) return S;
      for (let p = 0; p < fs.length; p++) {
        if (fs[p] >= sr * 0.45) continue;                  // 나이퀴스트 근처 부분음은 생략(에일리어싱 방지)
        const w = (2 * Math.PI * fs[p]) / sr, ph = rnd() * 6.283, c = 2 * Math.cos(w);
        let s1 = Math.sin(ph), s0 = Math.sin(ph - w);      // 2차 재귀 사인 발진기: 샘플당 곱셈 1번
        const kk = Math.exp(-1 / ((dc[p] ?? dc[0]) * sr));
        let env = (am[p] ?? 1) * g;
        for (let i = 0; i < len && env > 1e-5; i++) {
          out[i0 + i] += s1 * env * (i < 24 ? i / 24 : 1) * tailFade(i, len);
          const s = c * s1 - s0; s0 = s1; s1 = s;
          env *= kk;
        }
      }
      return S;
    },
    click(t, g = 0.5, hp = 2500) { return S.noise({ t, dur: 0.006, a: 0.0002, d: 0.0008, g, hp }); },
    // 지연 탭 메아리(굽기): [{ t, g, lp }]
    echo(taps) {
      const dry = out.slice();
      for (const tp of taps) {
        const off = Math.floor(tp.t * sr);
        if (off >= n) continue;
        const w = svf(dry.slice(0, n - off), sr, 'low', tp.lp ?? 2000);
        for (let i = 0; i < w.length; i++) out[off + i] += w[i] * tp.g;
      }
      return S;
    },
    sat(drive = 1.5) {                      // 정규화 후 tanh 포화(펀치감)
      let pk = 1e-9;
      for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(out[i]));
      const k = Math.tanh(drive);
      for (let i = 0; i < n; i++) out[i] = Math.tanh((out[i] / pk) * drive) / k;
      return S;
    },
    filter(mode, fc, q) { svf(out, sr, mode, fc, q); return S; },
    // 루프 마감: 루프 길이를 넘친 꼬리를 앞쪽으로 접어 이음매 없이 반복되게 한다(끝 페이드 없음).
    loopDone(loopSec, peak = 0.9) {
      const L = Math.min(n, Math.round(loopSec * sr));
      for (let i = L; i < n; i++) out[i % L] += out[i];
      const res = out.subarray(0, L);
      let pk = 1e-9;
      for (let i = 0; i < L; i++) pk = Math.max(pk, Math.abs(res[i]));
      const s = peak / pk;
      for (let i = 0; i < L; i++) res[i] *= s;
      return res;
    },
    done(peak = 0.9) {
      svf(out, sr, 'high', 25);             // DC 제거
      const fo = Math.min(n, Math.floor(sr * 0.012));
      for (let i = 0; i < fo; i++) out[n - 1 - i] *= i / fo;
      let pk = 1e-9;
      for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(out[i]));
      const s = peak / pk;
      for (let i = 0; i < n; i++) out[i] *= s;
      return out;
    }
  };
  return S;
}

/* ───────────── 소리 정의 ─────────────
   prio: 우선순위(높을수록 중요) · level: 기본 이득 · ref/roll/maxDist: 거리 감쇠(m)
   muffle: 멀수록 강한 저역 통과 · send: 잔향 양 · max: 같은 소리 동시 상한 · vars: 변형 수
   jit: 재생 속도 랜덤 폭 · ui: 항상 2D(비위치) */
const DEFS = {
  rifle: { dur: 0.6, prio: 6, level: 0.8, ref: 8, maxDist: 260, muffle: 1, send: 0.2, max: 6, vars: 3, jit: 0.035,
    r: (S) => S.noise({ dur: 0.03, a: 0.0003, d: 0.005, hp: 1800, g: 1 })
      .noise({ dur: 0.25, d: S.r(0.035, 0.05), lp: 3800, g: 0.9 })
      .tone({ f: S.r(150, 175), f1: 48, glide: 0.03, d: 0.06, dur: 0.3, g: 0.9 })
      .noise({ t: 0.015, dur: 0.55, a: 0.01, d: 0.13, lp: 900, brown: 1, g: 0.6 })
      .click(0.045, 0.12).sat(1.6) },
  sniper: { dur: 2.8, prio: 7, level: 0.95, ref: 10, maxDist: 420, muffle: 1, send: 0.32, max: 3, vars: 2, jit: 0.02,
    r: (S) => S.noise({ dur: 0.02, a: 0.0002, d: 0.004, hp: 2600, g: 1.3 })
      .noise({ dur: 0.06, d: 0.012, bp: 4200, q: 1.2, g: 0.7 })
      .tone({ f: 125, f1: 34, glide: 0.06, d: 0.22, dur: 0.9, g: 1.1 })
      .noise({ dur: 0.5, d: 0.08, lp: 2400, g: 0.8 })
      .noise({ t: 0.01, dur: 1.4, a: 0.02, d: 0.35, lp: 420, brown: 1, g: 0.7 })
      .sat(1.8)
      .echo([{ t: 0.21, g: 0.34, lp: 2600 }, { t: 0.47, g: 0.24, lp: 1600 }, { t: 0.83, g: 0.16, lp: 1100 },
        { t: 1.28, g: 0.1, lp: 800 }, { t: 1.82, g: 0.06, lp: 600 }]) },
  pistol: { dur: 0.45, prio: 6, level: 0.7, ref: 6, maxDist: 190, muffle: 1, send: 0.16, max: 4, vars: 3, jit: 0.03,
    r: (S) => S.noise({ dur: 0.02, a: 0.0003, d: 0.004, hp: 2200, g: 0.9 })
      .noise({ dur: 0.12, d: 0.024, bp: S.r(1500, 1900), q: 1, g: 0.85 })
      .tone({ f: 215, f1: 72, glide: 0.02, d: 0.035, dur: 0.2, g: 0.7 })
      .noise({ t: 0.01, dur: 0.42, a: 0.006, d: 0.085, lp: 1100, brown: 1, g: 0.4 }).sat(1.4) },
  // 가벼운 연사음: 높고 짧은 크랙 + 얇은 몸통 + 노리쇠 달각. 950 rpm(63 ms 간격)에서 뭉개지지 않게 꼬리를 짧게 둔다.
  smg: { dur: 0.26, prio: 6, level: 0.7, ref: 6, maxDist: 180, muffle: 1, send: 0.1, max: 5, vars: 3, jit: 0.045,
    r: (S) => S.noise({ dur: 0.014, a: 0.0002, d: 0.0028, hp: 3200, g: 0.8 })
      .noise({ dur: 0.09, d: 0.016, bp: S.r(2300, 2900), q: 0.9, g: 1.1 })
      .tone({ f: S.r(300, 340), f1: 125, glide: 0.012, d: 0.024, dur: 0.12, g: 0.8 })
      .noise({ t: 0.004, dur: 0.24, a: 0.003, d: 0.05, lp: 1700, brown: 1, g: 0.5 })
      .ring({ t: 0.024, f: [3400, 5100], amp: [1, 0.5], dec: [0.008, 0.005], g: 0.12 })
      .click(0.026, 0.12, 3500).sat(2.2) },
  // 깊고 넓은 붐 뒤에 펌프 소리(뒤로 0.56초, 앞으로 0.70초). 펌프는 sat 뒤에 얹어 붐에 눌리지 않게 한다.
  shotgun: { dur: 1, prio: 7, level: 0.95, ref: 9, maxDist: 300, muffle: 1, send: 0.3, max: 3, vars: 2, jit: 0.02,
    r: (S) => {
      S.noise({ dur: 0.016, a: 0.0002, d: 0.0035, hp: 1500, g: 1.1 })
        .noise({ dur: 0.3, a: 0.0005, d: 0.055, lp: (u) => 700 + 4200 * (1 - u) ** 3, g: 1.25 })
        .tone({ f: S.r(118, 130), f1: 36, glide: 0.045, a: 0.0012, d: 0.14, dur: 0.62, g: 1.5 })
        .tone({ f: 72, f1: 42, glide: 0.08, a: 0.002, d: 0.2, dur: 0.7, g: 0.7 })
        .noise({ t: 0.008, dur: 0.72, a: 0.012, d: 0.17, lp: 520, brown: 1, g: 0.95 })
        .sat(2.2);
      S.noise({ t: 0.46, dur: 0.1, env: 'bell', bp: (u) => 1500 + 1100 * u, q: 1.3, g: 0.2 })
        .click(0.555, 0.34, 2200)
        .ring({ t: 0.556, f: [1480, 2360, 3540], amp: [1, 0.6, 0.35], dec: [0.035, 0.025, 0.015], g: 0.16 })
        .noise({ t: 0.6, dur: 0.1, env: 'bell', bp: (u) => 2600 - 1000 * u, q: 1.3, g: 0.18 })
        .click(0.695, 0.42, 2000)
        .ring({ t: 0.696, f: [1240, 2050, 3120], amp: [1, 0.65, 0.35], dec: [0.05, 0.03, 0.018], g: 0.2 })
        .tone({ t: 0.696, f: 210, f1: 140, glide: 0.015, d: 0.02, dur: 0.1, g: 0.16 });
    } },
  // 묵직한 크랙 + 낮은 쿵 + 짧은 되울림
  magnum: { dur: 0.9, prio: 7, level: 0.9, ref: 8, maxDist: 300, muffle: 1, send: 0.24, max: 3, vars: 2, jit: 0.02,
    r: (S) => S.noise({ dur: 0.012, a: 0.0002, d: 0.0025, hp: 2800, g: 1.4 })
      .noise({ dur: 0.12, a: 0.0003, d: 0.02, bp: S.r(820, 980), q: 1.5, g: 2.6 })
      .tone({ f: S.r(150, 165), f1: 40, glide: 0.03, a: 0.0008, d: 0.1, dur: 0.5, g: 1.5 })
      .noise({ t: 0.004, dur: 0.6, a: 0.006, d: 0.11, lp: 460, brown: 1, g: 0.6 })
      .sat(2)
      .echo([{ t: 0.12, g: 0.2, lp: 2200 }, { t: 0.29, g: 0.11, lp: 1300 }]) },
  // 날카로운 중역 크랙. 저격보다 짧고 소총보다 또렷한 꼬리
  dmr: { dur: 1, prio: 6, level: 0.9, ref: 9, maxDist: 320, muffle: 1, send: 0.24, max: 4, vars: 3, jit: 0.025,
    r: (S) => S.noise({ dur: 0.012, a: 0.0002, d: 0.0024, hp: 2400, g: 1.2 })
      .noise({ dur: 0.09, a: 0.0002, d: 0.016, bp: S.r(2900, 3400), q: 1.1, g: 1.2 })
      .noise({ dur: 0.24, d: 0.046, bp: S.r(1250, 1500), q: 0.7, g: 1.3 })
      .tone({ f: 240, f1: 84, glide: 0.014, a: 0.0006, d: 0.026, dur: 0.16, g: 0.45 })
      .noise({ t: 0.008, dur: 0.6, a: 0.008, d: 0.09, lp: 1800, brown: 1, g: 0.3 })
      .sat(2.4)
      .echo([{ t: 0.15, g: 0.2, lp: 2800 }, { t: 0.34, g: 0.12, lp: 1700 }, { t: 0.58, g: 0.06, lp: 1100 }]) },
  knife_slash: { dur: 0.32, prio: 5, level: 0.55, ref: 2.5, maxDist: 30, send: 0.04, max: 3, vars: 2, jit: 0.06,
    r: (S) => {
      const top = S.r(2300, 2900);
      S.noise({ dur: 0.26, env: 'bell', bp: (u) => 600 + top * Math.sin(Math.PI * Math.min(1, u * 1.1)), q: 1.6, g: 1 })
        .noise({ t: 0.05, dur: 0.16, env: 'bell', hp: 3200, g: 0.18 });
    } },
  knife_hit: { dur: 0.3, prio: 5, level: 0.6, ref: 3, maxDist: 40, send: 0.05, max: 3, vars: 2, jit: 0.05,
    r: (S) => S.noise({ dur: 0.09, d: 0.02, lp: 650, g: 1 })
      .tone({ f: 195, f1: 118, glide: 0.03, d: 0.05, dur: 0.25, g: 0.6 })
      .click(0.001, 0.3).ring({ f: [1250, 1870], amp: [1, 0.6], dec: [0.03, 0.02], g: 0.12 }) },
  // 공기를 가르는 휙 + 위로 미끄러지는 약한 금속 울림
  katana_swing: { dur: 0.46, prio: 5, level: 0.62, ref: 2.5, maxDist: 34, send: 0.05, max: 3, vars: 3, jit: 0.07,
    r: (S) => {
      const top = S.r(2600, 3300);
      S.noise({ dur: 0.36, env: 'bell', bp: (u) => 450 + top * Math.sin(Math.PI * Math.min(1, u * 1.05)), q: 1.7, g: 1 })
        .noise({ t: 0.06, dur: 0.24, env: 'bell', hp: 4200, g: 0.22 })
        .tone({ t: 0.05, f: S.r(3000, 3300), f1: S.r(3900, 4300), glide: 0.12, env: 'bell', dur: 0.28, g: 0.09 })
        .tone({ t: 0.05, f: S.r(4700, 5000), f1: S.r(5900, 6300), glide: 0.12, env: 'bell', dur: 0.24, g: 0.05 });
    } },
  // 더 길고 무거운 휙 + 낮은 몸통(강타)
  katana_heavy: { dur: 0.86, prio: 5, level: 0.74, ref: 3, maxDist: 42, send: 0.08, max: 2, vars: 2, jit: 0.04,
    r: (S) => {
      const top = S.r(1500, 1900);
      S.noise({ dur: 0.72, env: 'bell', bp: (u) => 260 + top * Math.sin(Math.PI * u), q: 1.25, g: 1 })
        .noise({ t: 0.16, dur: 0.42, env: 'bell', hp: 3400, g: 0.16 })
        .tone({ t: 0.05, f: 120, f1: 58, glide: 0.24, env: 'bell', dur: 0.62, g: 0.55 })
        .noise({ t: 0.06, dur: 0.6, env: 'bell', lp: 360, brown: 1, g: 0.6 })
        .tone({ t: 0.18, f: S.r(2300, 2500), f1: S.r(3000, 3300), glide: 0.2, env: 'bell', dur: 0.42, g: 0.07 });
    } },
  // 밝은 강철 울림 + 짧은 타격
  katana_hit: { dur: 0.62, prio: 6, level: 0.72, ref: 3.5, maxDist: 60, send: 0.12, max: 3, vars: 3, jit: 0.05,
    r: (S) => {
      const k = S.r(0.95, 1.06);
      S.click(0, 0.7, 3000)
        .noise({ dur: 0.05, a: 0.0002, d: 0.01, bp: 3600, q: 0.8, g: 0.9 })
        .tone({ f: 250, f1: 125, glide: 0.018, d: 0.03, dur: 0.14, g: 0.6 })
        .ring({ t: 0.001, f: [2290, 3390, 5120, 6930, 8740].map((x) => x * k), amp: [1, 0.85, 0.55, 0.35, 0.18],
          dec: [0.2, 0.15, 0.1, 0.07, 0.04], g: 0.5 });
    } },
  grenade_pin: { dur: 0.6, prio: 5, level: 0.5, ref: 2, maxDist: 25, send: 0.05, max: 2,
    r: (S) => S.click(0, 0.5)
      .ring({ t: 0.004, f: [2960, 4310, 5620, 7150], amp: [1, 0.6, 0.4, 0.2], dec: [0.2, 0.14, 0.09, 0.05], g: 0.5 })
      .noise({ t: 0.18, dur: 0.05, d: 0.01, bp: 3000, q: 2, g: 0.35 })
      .ring({ t: 0.19, f: [1800, 2650], amp: [1, 0.6], dec: [0.06, 0.04], g: 0.2 }) },
  grenade_bounce: { dur: 0.45, prio: 5, level: 0.6, ref: 3, maxDist: 55, send: 0.08, max: 3, vars: 3, jit: 0.08,
    r: (S) => S.noise({ dur: 0.06, d: 0.012, lp: 900, g: 0.9 })
      .tone({ f: 160, f1: 110, glide: 0.02, d: 0.03, dur: 0.15, g: 0.4 })
      .ring({ f: [820, 1370, 2240, 3310].map((x) => x * S.r(0.93, 1.07)), amp: [1, 0.7, 0.45, 0.25],
        dec: [0.09, 0.07, 0.05, 0.035], g: 0.6 }) },
  explosion: { dur: 3.6, prio: 8, level: 1, ref: 12, maxDist: 420, muffle: 1, send: 0.5, max: 3, vars: 2, jit: 0.04,
    r: (S) => {
      S.noise({ dur: 0.06, a: 0.0003, d: 0.012, hp: 1200, g: 1 })
        .tone({ f: 95, f1: 26, glide: 0.18, a: 0.004, d: 0.6, dur: 2.4, g: 1.3 })
        .tone({ f: 55, f1: 30, glide: 0.3, a: 0.01, d: 0.9, dur: 3, g: 0.6 })
        .noise({ dur: 1.4, a: 0.003, d: 0.25, lp: (u) => 150 + 3200 * (1 - u) ** 2, g: 1 })
        .noise({ t: 0.02, dur: 3.5, a: 0.05, d: 0.9, lp: 300, brown: 1, g: 0.9 });
      for (let i = 0; i < 26; i++) S.click(0.12 + S.rnd() ** 1.6 * 1.4, S.r(0.02, 0.12), 2500); // 파편 후드득
      S.sat(2).echo([{ t: 0.35, g: 0.25, lp: 700 }, { t: 0.8, g: 0.15, lp: 500 }, { t: 1.4, g: 0.08, lp: 400 }]);
    } },
  reload_mag_out: { dur: 0.35, prio: 4, level: 0.5, ref: 2, maxDist: 20, send: 0.03, max: 2,
    r: (S) => S.click(0, 0.6).noise({ t: 0.02, dur: 0.09, env: 'bell', bp: 2400, q: 1.4, g: 0.35 })
      .ring({ t: 0.09, f: [1650, 2480], amp: [1, 0.6], dec: [0.03, 0.02], g: 0.25 })
      .tone({ t: 0.1, f: 300, f1: 180, glide: 0.02, d: 0.02, dur: 0.12, g: 0.25 }) },
  reload_mag_in: { dur: 0.4, prio: 4, level: 0.55, ref: 2, maxDist: 20, send: 0.03, max: 2,
    r: (S) => S.noise({ dur: 0.1, env: 'bell', bp: 2000, q: 1.3, g: 0.3 }).click(0.11, 0.8)
      .ring({ t: 0.11, f: [1450, 2300, 3700], amp: [1, 0.6, 0.3], dec: [0.04, 0.03, 0.02], g: 0.35 })
      .tone({ t: 0.11, f: 240, f1: 140, glide: 0.02, d: 0.03, dur: 0.15, g: 0.45 }).click(0.16, 0.35) },
  bolt: { dur: 0.7, prio: 4, level: 0.6, ref: 2, maxDist: 25, send: 0.03, max: 2,
    r: (S) => S.click(0, 0.5).ring({ f: [2100, 3300], amp: [1, 0.5], dec: [0.03, 0.02], g: 0.2 })
      .noise({ t: 0.04, dur: 0.12, env: 'bell', bp: (u) => 1600 + 1200 * u, q: 1.2, g: 0.4 }).click(0.16, 0.6)
      .noise({ t: 0.3, dur: 0.1, env: 'bell', bp: (u) => 2600 - 1000 * u, q: 1.2, g: 0.4 })
      .click(0.41, 0.9).ring({ t: 0.41, f: [1300, 2050, 3150], amp: [1, 0.6, 0.3], dec: [0.05, 0.035, 0.02], g: 0.4 })
      .tone({ t: 0.41, f: 220, f1: 150, glide: 0.02, d: 0.025, dur: 0.12, g: 0.35 }).click(0.5, 0.5) },
  dry_fire: { dur: 0.12, prio: 4, level: 0.45, ref: 1.5, maxDist: 15, max: 2,
    r: (S) => S.click(0, 0.8).ring({ f: [3200, 4700], amp: [1, 0.5], dec: [0.015, 0.01], g: 0.3 })
      .tone({ f: 900, f1: 700, glide: 0.01, d: 0.01, dur: 0.05, g: 0.1 }) },
  switch: { dur: 0.3, prio: 4, level: 0.45, ref: 1.5, maxDist: 15, max: 2,
    r: (S) => S.noise({ dur: 0.14, env: 'bell', lp: 1800, g: 0.35 }).click(0.12, 0.5)
      .ring({ t: 0.12, f: [1900, 2900], amp: [1, 0.5], dec: [0.025, 0.015], g: 0.2 }) },
  footstep_concrete: { dur: 0.2, prio: 3, level: 0.45, ref: 2, roll: 1.4, maxDist: 32, send: 0.04, max: 6, vars: 4, jit: 0.06,
    r: (S) => S.noise({ dur: 0.07, a: 0.0008, d: 0.011, lp: S.r(1100, 1600), hp: 120, g: 1 })
      .noise({ t: 0.006, dur: 0.05, d: 0.009, bp: S.r(2200, 3200), q: 0.8, g: 0.3 })
      .tone({ f: 105, f1: 70, glide: 0.02, d: 0.018, dur: 0.1, g: 0.45 })
      .noise({ t: S.r(0.038, 0.055), dur: 0.05, d: 0.008, lp: 1000, g: 0.4 }) },
  footstep_steel: { dur: 0.8, prio: 3, level: 0.5, ref: 2.5, roll: 1.3, maxDist: 45, send: 0.08, max: 6, vars: 4, jit: 0.05,
    r: (S) => S.tone({ f: S.r(80, 90), f1: 60, glide: 0.05, d: 0.11, dur: 0.6, g: 1 })
      .tone({ f: 128, d: 0.06, dur: 0.3, g: 0.35 })
      .ring({ f: [287, 461, 733, 1109, 1620].map((x) => x * S.r(0.95, 1.05)), amp: [1, 0.8, 0.55, 0.35, 0.2],
        dec: [0.22, 0.16, 0.12, 0.08, 0.05], g: 0.28 })
      .noise({ dur: 0.05, d: 0.008, lp: 1700, g: 0.65 }) },
  // 버니합 착지: 아주 작고 낮은 쿵. 연속으로 뛰어도 거슬리지 않게 작게 둔다.
  bhop_land: { dur: 0.16, prio: 3, level: 0.2, ref: 1.5, roll: 1.4, maxDist: 14, max: 2, vars: 2, jit: 0.07,
    r: (S) => S.tone({ f: S.r(84, 96), f1: 50, glide: 0.018, a: 0.0025, d: 0.03, dur: 0.14, g: 1 })
      .noise({ dur: 0.04, a: 0.001, d: 0.007, lp: 420, g: 0.25 }) },
  // 점프 발판: 튕기는 쿵 + 위로 올라가는 휙
  pad_boost: { dur: 0.72, prio: 5, level: 0.62, ref: 4, maxDist: 60, send: 0.14, max: 3, vars: 2, jit: 0.03,
    r: (S) => S.tone({ f: 130, f1: 70, glide: 0.03, a: 0.002, d: 0.04, dur: 0.16, g: 0.5 })
      .noise({ dur: 0.62, env: 'bell', bp: (u) => 320 + 3600 * u * u, q: 1.5, g: 1 })
      .tone({ t: 0.02, f: 190, f1: 1250, glide: 0.2, env: 'bell', dur: 0.56, g: 0.32 })
      .tone({ t: 0.04, f: 380, f1: 2500, glide: 0.2, env: 'bell', dur: 0.5, g: 0.1 }) },
  // 포털: 떨리며 올라가는 음 4겹 + 대역 스윕 + 흩어지는 반짝임
  portal: { dur: 1.25, prio: 5, level: 0.58, ref: 5, maxDist: 70, send: 0.32, max: 2, jit: 0.02,
    r: (S) => {
      for (const [f0, f1, vf, g] of [[260, 1040, 6.3, 0.3], [392, 1560, 7.7, 0.22], [587, 2350, 9.1, 0.15], [880, 3520, 10.7, 0.09]]) {
        S.tone({ f: f0, f1, glide: 0.38, env: 'bell', dur: 1.15, vib: 0.018, vibF: vf, g });
      }
      S.noise({ dur: 1.1, env: 'bell', bp: (u) => 700 + 5600 * u, q: 3, g: 0.4 });
      for (let i = 0; i < 12; i++) {
        S.ring({ t: S.r(0.12, 0.92), f: [S.r(2600, 6400)], amp: [1], dec: [S.r(0.03, 0.08)], g: S.r(0.04, 0.09) });
      }
    } },
  hit_marker: { ui: 1, dur: 0.1, prio: 8, level: 0.5, max: 3, jit: 0.015,
    r: (S) => S.tone({ f: 2350, a: 0.0004, d: 0.016, dur: 0.08, tri: 1, g: 0.8 })
      .tone({ f: 1650, d: 0.01, dur: 0.05, g: 0.3 }).click(0, 0.35, 4000) },
  headshot: { ui: 1, dur: 0.5, prio: 9, level: 0.6, max: 2,
    r: (S) => S.click(0, 0.4, 4000).tone({ f: 2350, a: 0.0004, d: 0.016, dur: 0.08, tri: 1, g: 0.6 })
      .ring({ t: 0.004, f: [1760, 2640, 3553], amp: [1, 0.7, 0.3], dec: [0.16, 0.12, 0.06], g: 0.6 })
      .tone({ t: 0.05, f: 3150, d: 0.08, dur: 0.3, g: 0.22 }) },
  kill: { ui: 1, dur: 0.7, prio: 9, level: 0.55, max: 2,
    r: (S) => S.tone({ f: 987.8, d: 0.11, dur: 0.3, tri: 1, g: 0.5 }).tone({ f: 1975.5, d: 0.08, dur: 0.25, g: 0.12 })
      .tone({ t: 0.085, f: 1318.5, d: 0.2, dur: 0.55, tri: 1, g: 0.55 }).tone({ t: 0.085, f: 2637, d: 0.12, dur: 0.4, g: 0.1 }) },
  // 반샷: 짧게 두 번 내려가는 음. 올라가는 kill과 반대 방향이라 킬이 아니라는 것을 바로 알 수 있다.
  half_shot: { ui: 1, dur: 0.34, prio: 9, level: 0.6, max: 2,
    r: (S) => S.click(0, 0.25, 3500)
      .tone({ f: 1320, f1: 990, glide: 0.018, a: 0.0006, d: 0.035, dur: 0.1, tri: 1, g: 0.75 })
      .tone({ t: 0.075, f: 990, f1: 620, glide: 0.035, a: 0.001, d: 0.07, dur: 0.24, tri: 1, g: 0.85 })
      .tone({ t: 0.075, f: 1490, f1: 930, glide: 0.035, d: 0.045, dur: 0.16, g: 0.14 }) },
  // 비밀 스팟: 완전5도로 쌓아 올리는 오리지널 아르페지오(G5 D6 A6 E7) 뒤에 열린 화음 울림
  secret_found: { ui: 1, dur: 1.15, prio: 9, level: 0.6, max: 1, send: 0.3,
    r: (S) => {
      [783.99, 1174.66, 1760, 2637.02].forEach((f, i) => {
        const t = i * 0.072;
        S.tone({ t, f, a: 0.0015, d: 0.1, dur: 0.4, tri: 1, g: 0.5 }).tone({ t, f: f * 2, d: 0.05, dur: 0.2, g: 0.1 });
      });
      S.ring({ t: 0.29, f: [1975.53, 2637.02, 3951.07, 5274.04], amp: [0.8, 1, 0.5, 0.25], dec: [0.24, 0.2, 0.14, 0.09], g: 0.42 });
    } },
  // 구매: 금속 조각이 두 번 부딪히는 소리(비조화 배음) + 짧은 확인음
  purchase: { ui: 1, dur: 0.46, prio: 8, level: 0.56, max: 2, jit: 0.01,
    r: (S) => S.click(0, 0.3, 3500)
      .ring({ f: [2217, 3322, 4987], amp: [1, 0.6, 0.3], dec: [0.035, 0.03, 0.02], g: 0.6 })
      .ring({ t: 0.068, f: [2793, 4186, 6272, 8372], amp: [1, 0.65, 0.35, 0.18], dec: [0.13, 0.1, 0.06, 0.035], g: 0.6 })
      .tone({ t: 0.068, f: 1396.9, a: 0.001, d: 0.07, dur: 0.24, tri: 1, g: 0.22 }) },
  // 메뉴 클릭: 작고 부드러운 틱
  ui_click: { ui: 1, dur: 0.045, prio: 4, level: 0.28, max: 3, jit: 0.02,
    r: (S) => S.noise({ dur: 0.01, a: 0.0003, d: 0.0018, hp: 1400, lp: 6000, g: 0.7 })
      .tone({ f: 1250, f1: 980, glide: 0.004, a: 0.0003, d: 0.005, dur: 0.024, g: 0.45 }) },
  round_start: { ui: 1, dur: 3.2, prio: 10, level: 0.75, max: 1, send: 0.45,   // 낮은 혼(맥놀이)
    r: (S) => S.tone({ f: 89, f1: 92, glide: 0.1, harm: 16, tilt: 0.8, env: 'hold', a: 0.16, h: 1.75, d: 0.28, dur: 3.1,
      vib: 0.002, vibF: 4.3, g: 0.8 })
      .tone({ f: 89.6, f1: 92.7, glide: 0.1, harm: 12, tilt: 0.9, env: 'hold', a: 0.2, h: 1.7, d: 0.3, dur: 3.1, g: 0.55 })
      .noise({ dur: 2.4, env: 'hold', a: 0.2, h: 1.6, d: 0.25, bp: 520, q: 0.6, g: 0.05 })
      .filter('low', 1500, 0.7) },
  round_win: { ui: 1, dur: 1.8, prio: 10, level: 0.6, max: 1, send: 0.25,
    r: (S) => {
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
        const t = [0, 0.11, 0.22, 0.36][i], d = i === 3 ? 0.55 : 0.22;
        S.tone({ t, f, d, dur: d * 5, tri: 1, g: 0.5 }).tone({ t, f: f * 2, d: d * 0.6, dur: d * 3, g: 0.12 });
      });
      S.ring({ t: 0.36, f: [2093, 3136], amp: [1, 0.6], dec: [0.4, 0.3], g: 0.08 });
    } },
  round_lose: { ui: 1, dur: 1.9, prio: 10, level: 0.6, max: 1, send: 0.25,
    r: (S) => {
      [[0, 440], [0.2, 349.23], [0.42, 293.66]].forEach(([t, f], i) => {
        const d = i === 2 ? 0.6 : 0.26;
        S.tone({ t, f, f1: i === 2 ? 277.2 : f, glide: 0.5, harm: 4, tilt: 1.6, a: 0.01, d, dur: d * 4.5, g: 0.6 });
      });
      S.filter('low', 1800);
    } },
  low_hp_heartbeat: { ui: 1, dur: 0.75, prio: 7, level: 0.7, max: 1,
    r: (S) => S.tone({ f: 64, f1: 42, glide: 0.05, a: 0.006, d: 0.07, dur: 0.35, g: 1 })
      .noise({ dur: 0.12, d: 0.035, lp: 160, g: 0.35 })
      .tone({ t: 0.24, f: 56, f1: 38, glide: 0.05, a: 0.006, d: 0.06, dur: 0.35, g: 0.7 })
      .noise({ t: 0.24, dur: 0.1, d: 0.03, lp: 140, g: 0.25 }) },
  // 폭파 미션(MODES.md 5절). 설치된 폭탄의 삐: 짧고 높은 삼각파 한 번. 남은 시간이 줄수록 World가 자주 부른다
  bomb_beep: { dur: 0.16, prio: 7, level: 0.5, ref: 4, maxDist: 80, send: 0.06, max: 3,
    r: (S) => S.tone({ f: 2217, a: 0.001, d: 0.045, dur: 0.12, tri: 1, g: 0.85 }).tone({ f: 4434, d: 0.025, dur: 0.07, g: 0.12 }) },
  // 설치 중 단말기 버튼: 짧은 딸깍 + 낮은 확인음(0.45초마다)
  bomb_key: { dur: 0.14, prio: 5, level: 0.42, ref: 2.5, maxDist: 30, send: 0.03, max: 3, vars: 3, jit: 0.04,
    r: (S) => S.click(0, 0.6, 3200).tone({ f: S.r(1180, 1420), a: 0.0008, d: 0.03, dur: 0.09, tri: 1, g: 0.5 }) },
  // 설치 완료: 올라가는 두 음 + 금속 잠금 소리
  bomb_armed: { dur: 0.9, prio: 8, level: 0.6, ref: 6, maxDist: 120, send: 0.12, max: 1,
    r: (S) => S.click(0, 0.8, 2600)
      .ring({ t: 0.01, f: [980, 1630, 2420], amp: [1, 0.6, 0.3], dec: [0.08, 0.06, 0.04], g: 0.45 })
      .tone({ t: 0.12, f: 1568, d: 0.08, dur: 0.22, tri: 1, g: 0.55 })
      .tone({ t: 0.3, f: 2093, d: 0.16, dur: 0.5, tri: 1, g: 0.6 }) },
  // 해체 중: 금속 긁는 소리 + 작은 딸깍(0.6초마다)
  bomb_defuse: { dur: 0.32, prio: 5, level: 0.42, ref: 2.5, maxDist: 28, send: 0.03, max: 2, vars: 2, jit: 0.05,
    r: (S) => S.noise({ dur: 0.2, env: 'bell', bp: (u) => 2400 + 1600 * u, q: 2.2, g: 0.45 }).click(0.2, 0.5, 2800)
      .ring({ t: 0.2, f: [2650, 3900], amp: [1, 0.5], dec: [0.03, 0.02], g: 0.2 }) },
  // 해체 완료: 내려가는 두 음과 전원이 꺼지는 소리
  bomb_defused: { ui: 1, dur: 1.2, prio: 10, level: 0.6, max: 1, send: 0.2,
    r: (S) => S.tone({ f: 1760, d: 0.09, dur: 0.26, tri: 1, g: 0.55 })
      .tone({ t: 0.16, f: 1318.5, d: 0.12, dur: 0.36, tri: 1, g: 0.55 })
      .tone({ t: 0.34, f: 420, f1: 60, glide: 0.5, a: 0.004, d: 0.3, dur: 0.8, g: 0.45 }) },
  // 폭탄 줍기: 가방 끈 소리 + 작은 금속음
  bomb_pickup: { ui: 1, dur: 0.4, prio: 7, level: 0.5, max: 1,
    r: (S) => S.noise({ dur: 0.16, env: 'bell', lp: 1400, g: 0.5 }).click(0.14, 0.6, 2400)
      .ring({ t: 0.14, f: [1720, 2580], amp: [1, 0.5], dec: [0.05, 0.03], g: 0.3 }) },
  // 폭탄 폭발: 수류탄 폭발을 더 크고 길게(낮은 울림 + 긴 잔향)
  bomb_explode: { dur: 5.4, prio: 10, level: 1, ref: 24, maxDist: 700, muffle: 1, send: 0.6, max: 1,
    r: (S) => {
      S.noise({ dur: 0.08, a: 0.0003, d: 0.02, hp: 900, g: 1 })
        .tone({ f: 72, f1: 18, glide: 0.3, a: 0.006, d: 1.1, dur: 3.6, g: 1.5 })
        .tone({ f: 44, f1: 22, glide: 0.5, a: 0.02, d: 1.6, dur: 4.6, g: 0.8 })
        .noise({ dur: 2.2, a: 0.004, d: 0.45, lp: (u) => 120 + 2600 * (1 - u) ** 2, g: 1.1 })
        .noise({ t: 0.03, dur: 5.2, a: 0.08, d: 1.6, lp: 240, brown: 1, g: 1 });
      for (let i = 0; i < 40; i++) S.click(0.15 + S.rnd() ** 1.5 * 2.2, S.r(0.02, 0.14), 2200); // 파편이 길게 떨어진다
      S.sat(2.4).echo([{ t: 0.45, g: 0.3, lp: 600 }, { t: 1.1, g: 0.2, lp: 450 }, { t: 1.9, g: 0.12, lp: 350 }]);
    } },
  // 연속 킬: 낮은 쿵, 쓸리는 바람, 한 옥타브 위로 쓸어 올리는 음, 반짝임. 단계가 오를수록 world가 rate를 올려 높고 짧게 낸다
  multi_kill: { ui: 1, dur: 0.9, prio: 10, level: 0.5, max: 2, send: 0.2,
    r: (S) => S.tone({ f: 150, f1: 48, glide: 0.06, a: 0.002, d: 0.14, dur: 0.5, g: 0.9 })
      .noise({ dur: 0.35, a: 0.004, d: 0.08, bp: 1800, q: 0.7, g: 0.25 })
      .tone({ t: 0.02, f: 659.25, f1: 1318.5, glide: 0.08, harm: 6, tilt: 1.3, a: 0.004, d: 0.12, dur: 0.45, g: 0.32 })
      .ring({ t: 0.09, f: [2637.02, 3951.07, 5274.04], amp: [1, 0.6, 0.3], dec: [0.22, 0.16, 0.1], g: 0.22 }) },
  // 전설(7킬부터): 깊은 쿵과 낮은 울림 위에 C장조 화음을 차례로 쌓고 긴 반짝임
  legend_kill: { ui: 1, dur: 2.2, prio: 10, level: 0.55, max: 1, send: 0.4,
    r: (S) => {
      S.tone({ f: 110, f1: 41, glide: 0.09, a: 0.002, d: 0.3, dur: 1, g: 1 })
        .noise({ dur: 0.6, a: 0.004, d: 0.18, lp: 900, g: 0.35, brown: 1 });
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
        S.tone({ t: 0.05 + i * 0.06, f, harm: 8, tilt: 1.2, env: 'hold', a: 0.01, h: 0.5, d: 0.45, dur: 1.9, g: 0.22 });
      });
      S.ring({ t: 0.3, f: [2093, 3136, 4186.01, 5274.04], amp: [1, 0.7, 0.45, 0.25], dec: [0.6, 0.45, 0.3, 0.2], g: 0.2 });
    } },
  // ───────── 좀비 물량 막기(game/horde) ─────────
  // 좀비 신음: 떨리는 낮은 목소리 + 숨소리. 변형마다 높이가 다르다
  zombie_groan: { dur: 1.3, prio: 3, level: 0.5, ref: 3, maxDist: 45, muffle: 1, send: 0.12, max: 5, vars: 4, jit: 0.08,
    r: (S) => S.tone({ f: S.r(95, 135), f1: S.r(70, 90), glide: 0.5, harm: 7, tilt: 1.1, vib: 0.06, vibF: S.r(5, 9), a: 0.12, d: 0.45, dur: 1.2, g: 0.8 })
      .noise({ dur: 1.1, a: 0.15, d: 0.4, bp: S.r(500, 800), q: 1.5, g: 0.35 }).filter('low', 1600) },
  // 좀비 할퀴기: 쉭 하는 바람 + 짧은 끙
  zombie_attack: { dur: 0.45, prio: 5, level: 0.55, ref: 2.5, maxDist: 30, send: 0.05, max: 4, vars: 3, jit: 0.07,
    r: (S) => S.noise({ dur: 0.22, env: 'bell', bp: (u) => 900 + 1800 * u, q: 1.4, g: 0.6 })
      .tone({ f: S.r(150, 190), f1: 90, glide: 0.08, harm: 5, a: 0.01, d: 0.1, dur: 0.3, g: 0.5 }) },
  // 좀비 쓰러짐: 내려가는 신음 + 털썩
  zombie_die: { dur: 1, prio: 4, level: 0.55, ref: 3, maxDist: 50, muffle: 1, send: 0.1, max: 5, vars: 3, jit: 0.06,
    r: (S) => S.tone({ f: S.r(140, 170), f1: 55, glide: 0.35, harm: 6, vib: 0.05, a: 0.02, d: 0.3, dur: 0.8, g: 0.7 })
      .noise({ t: 0.45, dur: 0.3, d: 0.06, lp: 380, brown: 1, g: 0.7 }) },
  // 땅에서 기어 나옴: 흙이 부서지는 낮은 소리
  zombie_rise: { dur: 0.9, prio: 3, level: 0.45, ref: 3, maxDist: 40, muffle: 1, send: 0.08, max: 4, vars: 2, jit: 0.06,
    r: (S) => S.noise({ dur: 0.8, a: 0.05, d: 0.25, lp: 520, brown: 1, g: 0.9 }).click(0.1, 0.3, 1200).click(0.3, 0.25, 1000) },
  // 침·산 뱉기: 젖은 소리
  zombie_spit: { dur: 0.5, prio: 4, level: 0.5, ref: 3, maxDist: 45, send: 0.06, max: 3, vars: 2, jit: 0.06,
    r: (S) => S.noise({ dur: 0.3, env: 'bell', bp: 1400, q: 2.5, g: 0.6 }).tone({ f: 320, f1: 140, glide: 0.06, d: 0.08, dur: 0.25, g: 0.35 }) },
  // 산이 떨어짐: 치익
  acid_splash: { dur: 0.7, prio: 4, level: 0.45, ref: 3, maxDist: 45, send: 0.08, max: 3, vars: 2, jit: 0.05,
    r: (S) => S.noise({ dur: 0.6, a: 0.005, d: 0.2, hp: 1800, g: 0.6 }).noise({ dur: 0.2, d: 0.05, lp: 700, g: 0.4 }) },
  // 보스 등장·분노: 깊은 포효(맥놀이) + 거친 숨
  boss_roar: { dur: 2.6, prio: 9, level: 0.9, ref: 14, maxDist: 260, muffle: 1, send: 0.45, max: 2,
    r: (S) => S.tone({ f: 82, f1: 58, glide: 0.8, harm: 9, tilt: 1, vib: 0.07, vibF: 7, a: 0.15, d: 0.9, dur: 2.4, g: 1 })
      .tone({ f: 84, f1: 59, glide: 0.8, harm: 7, vib: 0.07, vibF: 6, a: 0.15, d: 0.9, dur: 2.4, g: 0.6 })
      .noise({ dur: 2.2, a: 0.2, d: 0.7, bp: 650, q: 0.8, g: 0.5 }).sat(1.8) },
  // 보스 스킬 예고: 부풀어 오르는 바람 소리
  boss_skill: { dur: 1.2, prio: 8, level: 0.7, ref: 8, maxDist: 160, send: 0.25, max: 3,
    r: (S) => S.noise({ dur: 1.1, a: 0.6, d: 0.2, bp: (u) => 300 + 2200 * u, q: 1.2, g: 0.8 }).tone({ f: 70, f1: 140, glide: 0.4, a: 0.5, d: 0.3, dur: 1.1, g: 0.4 }) },
  // 보스 쓰러짐: 큰 쿵 + 내려가는 포효
  boss_down: { dur: 2.4, prio: 10, level: 0.9, ref: 14, maxDist: 300, muffle: 1, send: 0.5, max: 1,
    r: (S) => S.tone({ f: 120, f1: 30, glide: 0.6, harm: 8, vib: 0.05, a: 0.02, d: 0.8, dur: 2, g: 1 })
      .noise({ t: 0.5, dur: 1.2, a: 0.004, d: 0.4, lp: 260, brown: 1, g: 1 }).sat(1.6) },
  // 충격파·내려찍기: 땅이 울리는 쿵
  ground_slam: { dur: 1.6, prio: 8, level: 0.9, ref: 10, maxDist: 200, muffle: 1, send: 0.35, max: 2,
    r: (S) => S.noise({ dur: 0.05, a: 0.0005, d: 0.015, lp: 1800, g: 1 })
      .tone({ f: 60, f1: 24, glide: 0.25, a: 0.004, d: 0.5, dur: 1.4, g: 1.3 })
      .noise({ dur: 1.2, a: 0.01, d: 0.35, lp: 300, brown: 1, g: 0.8 }).sat(2) },
  // 연쇄 번개: 지직
  zap: { dur: 0.6, prio: 7, level: 0.6, ref: 6, maxDist: 120, send: 0.15, max: 3, vars: 2, jit: 0.05,
    r: (S) => { S.noise({ dur: 0.5, a: 0.001, d: 0.15, hp: 2200, g: 0.7 }); for (let i = 0; i < 12; i++) S.click(S.rnd() * 0.45, S.r(0.2, 0.6), 3000); } },
  // 얼음 가시: 쨍
  ice_crack: { dur: 0.8, prio: 5, level: 0.5, ref: 4, maxDist: 70, send: 0.2, max: 3, vars: 2, jit: 0.05,
    r: (S) => S.ring({ f: [2400, 3510, 5150], amp: [1, 0.6, 0.35], dec: [0.18, 0.12, 0.08], g: 0.5 }).noise({ dur: 0.1, d: 0.03, hp: 3500, g: 0.4 }) },
  // 스테이지 시작: 낮은 경보 두 번
  horde_wave: { ui: 1, dur: 2.2, prio: 10, level: 0.6, max: 1, send: 0.3,
    r: (S) => S.tone({ f: 233, f1: 311, glide: 0.25, harm: 6, tilt: 1.2, a: 0.04, env: 'hold', h: 0.45, d: 0.15, dur: 0.8, g: 0.6 })
      .tone({ t: 0.9, f: 233, f1: 311, glide: 0.25, harm: 6, tilt: 1.2, a: 0.04, env: 'hold', h: 0.45, d: 0.2, dur: 1.1, g: 0.6 }) },
  // 스테이지 깸: 올라가는 세 음
  horde_clear: { ui: 1, dur: 1.4, prio: 10, level: 0.55, max: 1, send: 0.25,
    r: (S) => [659.25, 830.61, 987.77].reduce((s, f, i) => s.tone({ t: i * 0.11, f, harm: 5, tilt: 1.3, a: 0.005, d: 0.25, dur: 0.9, g: 0.4 }), S) },
  // 카드 고름: 반짝
  card_pick: { ui: 1, dur: 0.6, prio: 8, level: 0.5, max: 2,
    r: (S) => S.tone({ f: 1046.5, f1: 1568, glide: 0.04, harm: 4, a: 0.003, d: 0.12, dur: 0.4, g: 0.4 })
      .ring({ t: 0.05, f: [3136, 4186], amp: [1, 0.5], dec: [0.15, 0.1], g: 0.2 }) },
  // 좀비 보급품 줍기: 탄창 끼우는 딸깍 + 짧은 금속음
  loot_pick: { ui: 1, dur: 0.35, prio: 7, level: 0.5, max: 2,
    r: (S) => S.click(0, 0.7, 1800).noise({ t: 0.03, dur: 0.07, d: 0.02, bp: 3200, q: 2, g: 0.35 })
      .ring({ t: 0.06, f: [2093, 3136], amp: [1, 0.45], dec: [0.08, 0.05], g: 0.28 }) },
  // 카드 다시 뽑기: 카드 섞는 소리
  card_shuffle: { ui: 1, dur: 0.5, prio: 7, level: 0.45, max: 2,
    r: (S) => { for (let i = 0; i < 7; i++) S.noise({ t: i * 0.05, dur: 0.05, d: 0.012, bp: S.r(2500, 4000), q: 2, g: 0.5 }); } }
};

export const SOUND_NAMES = Object.freeze(Object.keys(DEFS));

const VARIANTS_TOTAL = SOUND_NAMES.reduce((n, name) => n + (DEFS[name].vars || 1), 0);   // 미리 합성할 변형 수

// 표에 직접 적은 이름만 찾는다('constructor'·'__proto__' 같은 이름이 Object.prototype으로 새지 않게)
function ownDef(table, name) {
  return typeof name === 'string' && Object.prototype.hasOwnProperty.call(table, name) ? table[name] : null;
}

/* ───────────── 이모트 음악(대체 합성음): 직접 쓴 음표 표로 합성하는 오리지널 루프. 음원 묶음이 없거나 못 읽을 때 쓴다 ───────────── */

const mtof = (m) => 440 * 2 ** ((m - 69) / 12);

// 16칸 패턴('x' 강, 'o' 약, '.' 쉼). 길이 16이면 매 마디 반복, 64면 4마디 전체 → cb(t, g)
function hits(str, bars, st, cb) {
  for (let b = 0; b < bars; b++) {
    for (let i = 0; i < 16; i++) {
      const c = str[(b * 16 + i) % str.length];
      if (c === 'x' || c === 'o') cb((b * 16 + i) * st, c === 'x' ? 1 : 0.55);
    }
  }
}
// 마디별 음표 [[칸, midi, 길이(칸)], ...] → cb(t, midi, 길이(초))
function notes(bars, st, cb) {
  bars.forEach((bar, b) => { for (const [s, m, len = 1] of bar) cb((b * 16 + s) * st, m, len * st); });
}

const kit = {
  kick: (S, t, g) => S.tone({ t, f: 140, f1: 46, glide: 0.035, a: 0.002, d: 0.11, dur: 0.4, g }).click(t, 0.25 * g, 1500),
  snare: (S, t, g) => S.noise({ t, dur: 0.2, a: 0.001, d: 0.06, bp: 1900, q: 0.6, g: 0.9 * g })
    .tone({ t, f: 210, f1: 170, glide: 0.02, d: 0.04, dur: 0.15, g: 0.4 * g }),
  clap: (S, t, g) => {
    for (let k = 0; k < 3; k++) S.noise({ t: t + k * 0.011, dur: 0.02, d: 0.004, bp: 1300, q: 1.1, g: 0.8 * g });
    return S.noise({ t: t + 0.03, dur: 0.25, d: 0.06, bp: 1250, q: 0.9, g: 0.7 * g });
  },
  hat: (S, t, g) => S.noise({ t, dur: 0.06, a: 0.0005, d: 0.014, hp: 7500, g: 0.5 * g }),
  shaker: (S, t, g) => S.noise({ t, dur: 0.07, env: 'bell', hp: 5000, g: 0.35 * g }),
  rim: (S, t, g) => S.ring({ t, f: [1750, 2650], amp: [1, 0.5], dec: [0.022, 0.012], g: 0.5 * g }).click(t, 0.2 * g, 2500),
  pluck: (S, t, m, d, g, o = {}) => S.tone({ t, f: mtof(m) * 1.015, f1: mtof(m), glide: 0.006, harm: o.harm ?? 8,
    odd: o.odd, tilt: o.tilt ?? 1.1, a: 0.002, d, dur: d * 5, g }),
  marimba: (S, t, m, g) => {
    const f = mtof(m);
    return S.ring({ t, f: [f, f * 3.93, f * 9.2], amp: [1, 0.28, 0.06], dec: [0.38, 0.07, 0.018], g })
      .noise({ t, dur: 0.012, d: 0.003, lp: 2500, g: 0.12 * g });
  },
  // len 동안 유지(gate 비율) 후 빠르게 끊는 음: 베이스·리드·리드오르간·칩튠
  held: (S, t, m, len, g, o = {}) => S.tone({ t, f: mtof(m) * (o.bend ?? 1), f1: mtof(m), glide: 0.012, harm: o.harm ?? 6,
    odd: o.odd, tilt: o.tilt ?? 1.2, tri: o.tri, env: 'hold', a: o.a ?? 0.004, h: Math.max(0.01, len * (o.gate ?? 0.6)),
    d: o.rel ?? 0.035, dur: len + 0.25, vib: o.vib, vibF: o.vibF, g })
};

// code = 전송 번호(MODES.md 4.1). bpm은 core/consts.js EMOTES[].bpm을 그대로 쓴다(emoteanim 춤 박자와 같아야 박자가 맞는다).
// loop형은 bpm·bars(4박 마디 수. 1.25면 5박), 한 번형은 dur. level은 효과음보다 작게.
const BPM = Object.freeze(Object.fromEntries(EMOTES.map((e) => [e.id, e.bpm])));
const EMOTE_DEFS = {
  // 1 L을 가져가 — 통통 튀는 신스 비트 (C장조)
  takeL: { code: 1, bpm: BPM.takeL, bars: 4, level: 0.32, r(S, st) {
    hits('x...x...x...x...', 4, st, (t, g) => kit.kick(S, t, 0.9 * g));
    hits('....x.......x...', 4, st, (t, g) => kit.clap(S, t, 0.5 * g));
    hits('..x...x...x...x.', 4, st, (t, g) => kit.hat(S, t, 0.55 * g));
    const roots = [36, 33, 29, 31];                                  // C A F G
    for (let b = 0; b < 4; b++) {
      for (const [s, iv] of [[0, 0], [3, 12], [6, 0], [8, 12], [11, 7], [14, 12]]) {
        kit.pluck(S, (b * 16 + s) * st, roots[b] + iv, 0.09, 0.6, { harm: 6, tilt: 1.3 });
      }
    }
    notes([
      [[0, 76, 2], [3, 79, 2], [6, 81, 2], [8, 79, 2], [11, 76, 2], [14, 74, 2]],
      [[0, 72, 2], [3, 76, 2], [6, 79, 3], [10, 81, 2], [12, 79, 3]],
      [[0, 81, 2], [3, 79, 2], [6, 76, 2], [8, 79, 2], [11, 81, 2], [14, 84, 2]],
      [[0, 86, 2], [2, 84, 2], [4, 81, 2], [6, 79, 2], [8, 76, 3], [12, 74, 4]]
    ], st, (t, m, len) => kit.pluck(S, t, m, Math.min(0.16, len * 0.6), 0.38, { harm: 8, tilt: 1 }));
    for (const b of [1, 3]) S.tone({ t: (b * 16 + 15) * st, f: 300, f1: 900, glide: 0.05, a: 0.003, d: 0.06, dur: 0.2, g: 0.25 });
  } },
  // 2 야채 — 가벼운 마림바 비트 (F장조)
  veggie: { code: 2, bpm: BPM.veggie, bars: 4, level: 0.29, r(S, st) {
    hits('x.......x.......', 4, st, (t, g) => kit.kick(S, t, 0.5 * g));
    hits('....x.......x...', 4, st, (t, g) => kit.rim(S, t, 0.7 * g));
    hits('xoxoxoxoxoxoxoxo', 4, st, (t, g) => kit.shaker(S, t, 0.7 * g));
    const bass = [41, 38, 34, 36];                                   // F Dm B♭ C
    for (let b = 0; b < 4; b++) {
      kit.marimba(S, b * 16 * st, bass[b], 0.75);
      kit.marimba(S, (b * 16 + 6) * st, bass[b] + 7, 0.4);
      kit.marimba(S, (b * 16 + 8) * st, bass[b], 0.6);
      kit.marimba(S, (b * 16 + 11) * st, bass[b] + 12, 0.35);
    }
    notes([
      [[0, 65], [2, 69], [4, 72], [7, 69], [8, 74], [10, 72], [12, 69], [14, 67]],
      [[0, 65], [2, 69], [4, 72], [6, 74], [8, 77], [11, 74], [12, 72]],
      [[0, 67], [2, 70], [4, 74], [7, 70], [8, 72], [10, 74], [12, 77], [14, 74]],
      [[0, 72], [2, 69], [4, 67], [6, 65], [8, 69], [10, 72], [12, 77]]
    ], st, (t, m) => kit.marimba(S, t, m, 0.55));
  } },
  // 3 사이드 스텝 — 펑키 베이스 비트 (E 도리안)
  sideToSide: { code: 3, bpm: BPM.sideToSide, bars: 4, level: 0.27, r(S, st) {
    hits('x.....x...x.....x.....x...x.....x.....x...x.....x.....x...x..x..', 4, st, (t, g) => kit.kick(S, t, 0.85 * g));
    hits('....x..o....x..o', 4, st, (t, g) => kit.snare(S, t, 0.6 * g));
    hits('xoxoxoxoxoxoxoxo', 4, st, (t, g) => kit.hat(S, t, 0.5 * g));
    notes([
      [[0, 40, 2], [3, 40, 1], [6, 43, 1], [7, 45, 2], [10, 52, 1], [12, 50, 1], [14, 47, 2]],
      [[0, 40, 2], [3, 40, 1], [6, 43, 1], [8, 45, 2], [11, 47, 1], [12, 50, 1], [14, 52, 1]],
      [[0, 45, 2], [3, 45, 1], [6, 48, 1], [7, 50, 2], [10, 57, 1], [12, 43, 1], [14, 40, 2]],
      [[0, 47, 2], [3, 47, 1], [6, 50, 1], [8, 47, 1], [10, 45, 1], [12, 43, 1], [13, 42, 1], [14, 40, 2]]
    ], st, (t, m, len) => kit.held(S, t, m, len, 0.75, { harm: 7, tilt: 1.25, bend: 0.96, gate: 0.55 }));
    const chords = [[64, 67, 71, 74], [64, 67, 71, 74], [57, 60, 64, 67], [59, 62, 66, 69]];  // Em7 Em7 Am7 Bm7
    for (let b = 0; b < 4; b++) {
      for (const s of [2, 10]) for (const m of chords[b]) kit.held(S, (b * 16 + s) * st, m, st, 0.12, { harm: 5, tilt: 1.6, gate: 0.4, rel: 0.02 });
    }
  } },
  // 4 크리스 크로스 — 8비트 비트 (A단조, 사각파·삼각파·노이즈)
  crissCross: { code: 4, bpm: BPM.crissCross, bars: 4, level: 0.26, r(S, st) {
    hits('x.......x.x.....', 4, st, (t, g) => S.tone({ t, f: 220, f1: 48, glide: 0.018, tri: 1, d: 0.07, dur: 0.25, g: 0.9 * g }));
    hits('....x.......x...', 4, st, (t, g) => S.noise({ t, dur: 0.14, d: 0.045, hp: 1400, g: 0.5 * g }));
    hits('x.x.x.x.x.x.x.x.', 4, st, (t, g) => S.noise({ t, dur: 0.03, d: 0.008, hp: 6000, g: 0.25 * g }));
    const roots = [45, 41, 48, 43];                                  // Am F C G
    const arps = [[69, 72, 76, 81], [65, 69, 72, 77], [72, 76, 79, 84], [67, 71, 74, 79]];
    for (let b = 0; b < 4; b++) {
      for (let s = 0; s < 16; s += 2) {
        kit.held(S, (b * 16 + s) * st, roots[b] - 12 + (s % 4 ? 12 : 0), st * 2, 0.5, { tri: 1, harm: 1, gate: 0.8, rel: 0.02 });
      }
      for (let s = 0; s < 16; s++) {
        const i = s % 8;
        kit.held(S, (b * 16 + s) * st, arps[b][i < 4 ? i : 7 - i], st, 0.13, { harm: 11, odd: 1, tilt: 1, gate: 0.5, rel: 0.012 });
      }
    }
    notes([
      [[0, 81, 4], [4, 79, 2], [6, 76, 2], [8, 72, 4], [12, 74, 4]],
      [],
      [[0, 76, 4], [4, 79, 2], [6, 81, 2], [8, 84, 6], [14, 83, 2]],
      [[0, 79, 3], [3, 76, 3], [6, 74, 2], [8, 71, 4], [12, 74, 2], [14, 76, 2]]
    ], st, (t, m, len) => kit.held(S, t, m, len, 0.3, { harm: 9, odd: 1, tilt: 1, gate: 0.85, rel: 0.03, vib: 0.006, vibF: 6 }));
  } },
  // 5 탱고 — 반도네온풍 리드 스타카토 (96 BPM, D단조, 매 박 마르카토)
  tango: { code: 5, bpm: BPM.tango, bars: 4, level: 0.3, r(S, st) {
    const reed = (t, m, len, g) => {                                  // 리드 2겹(기음 + 옥타브)
      kit.held(S, t, m, len, g, { harm: 10, tilt: 0.85, a: 0.012, gate: 0.55, rel: 0.035 });
      kit.held(S, t, m + 12, len, g * 0.25, { harm: 5, tilt: 1.2, a: 0.015, gate: 0.5, rel: 0.03 });
    };
    const chords = [[62, 65, 69], [61, 64, 67, 69], [62, 65, 69], [61, 64, 67, 69]];  // Dm A7 Dm A7
    for (let b = 0; b < 4; b++) {
      for (const s of [0, 4, 8, 12]) {
        const acc = s === 0 || s === 8 ? 1 : 0.6;
        for (const m of chords[b]) reed((b * 16 + s) * st, m - 12, st * 1.6, 0.11 * acc);
      }
    }
    for (const m of chords[3]) S.tone({ t: 60 * st, f: mtof(m - 12), harm: 10, tilt: 0.85, env: 'bell', dur: st * 4, g: 0.1 }); // 끌어당기듯 부풂
    notes([[[0, 38, 2], [8, 33, 2], [14, 37, 1]], [[0, 33, 2], [8, 40, 2], [12, 33, 2]],
      [[0, 38, 2], [8, 41, 2], [12, 45, 2]], [[0, 33, 2], [8, 37, 2], [12, 40, 1], [15, 37, 1]]], st,
    (t, m) => S.tone({ t, f: mtof(m), harm: 3, tilt: 1.5, a: 0.004, d: 0.16, dur: 0.6, g: 0.6 }));
    notes([
      [[0, 69, 2], [3, 69, 1], [4, 74, 2], [7, 76, 1], [8, 77, 3], [12, 76, 2], [14, 74, 2]],
      [[0, 73, 3], [4, 76, 2], [6, 79, 2], [8, 81, 4], [12, 79, 1], [13, 77, 1], [14, 76, 2]],
      [[0, 77, 2], [3, 77, 1], [4, 74, 2], [6, 77, 2], [8, 81, 3], [11, 82, 1], [12, 81, 2], [14, 77, 2]],
      [[0, 76, 2], [2, 77, 1], [3, 76, 1], [4, 74, 2], [6, 73, 2], [8, 69, 6]]
    ], st, (t, m, len) => reed(t, m, len, 0.32));
    hits('x.......x.......', 4, st, (t, g) => S.noise({ t, dur: 0.05, d: 0.012, lp: 900, g: 0.35 * g }));  // 몸통 두드림
  } },
  // 6 경례 — 짧은 혼
  salute: { code: 6, oneShot: true, dur: 1.6, level: 0.4,
    r: (S) => S.tone({ f: 104, f1: 108, glide: 0.08, harm: 14, tilt: 0.85, env: 'hold', a: 0.07, h: 0.75, d: 0.18, dur: 1.5,
      vib: 0.002, vibF: 5, g: 0.8 })
      .tone({ f: 104.6, f1: 108.7, glide: 0.08, harm: 10, tilt: 0.9, env: 'hold', a: 0.09, h: 0.7, d: 0.2, dur: 1.5, g: 0.5 })
      .filter('low', 1600, 0.7) },
  // 7 손 흔들기 — 작은 '뿅'
  wave: { code: 7, oneShot: true, dur: 0.3, level: 0.35,
    r: (S) => S.tone({ f: 380, f1: 1250, glide: 0.035, a: 0.002, d: 0.05, dur: 0.2, g: 1 })
      .tone({ t: 0.07, f: 900, f1: 1700, glide: 0.03, a: 0.002, d: 0.04, dur: 0.15, g: 0.45 }) },
  // 8 환호 박수 — 여럿이 치는 박수 + "와아" 함성 + 휘파람 (128 BPM)
  cheer: { code: 8, bpm: BPM.cheer, bars: 4, level: 0.4, r(S, st) {
    hits('x...x...x...x...', 4, st, (t, g) => {
      for (let k = 0; k < 6; k++) {
        const tt = t + S.r(-0.012, 0.018), f = S.r(900, 2400);
        for (let j = 0; j < 2; j++) S.noise({ t: tt + j * 0.009, dur: 0.02, d: 0.004, bp: f, q: 1.2, g: S.r(0.35, 0.7) * g });
        S.noise({ t: tt + 0.02, dur: 0.12, d: 0.035, bp: f * 0.9, q: 0.9, g: 0.3 * g });
      }
    });
    hits('x.......x.......', 4, st, (t, g) => kit.kick(S, t, 0.45 * g));
    for (const b of [0, 2]) {
      const t = b * 16 * st;
      for (let k = 0; k < 7; k++) {
        const f = S.r(190, 420);
        S.tone({ t: t + S.r(0, 0.15), f: f * 0.92, f1: f * S.r(1.04, 1.12), glide: 0.5, harm: 7, tilt: 1.6, env: 'bell',
          dur: S.r(1.4, 2.0), vib: 0.015, vibF: S.r(4, 7), g: 0.07 });
      }
      S.noise({ t, dur: 1.9, env: 'bell', bp: (u) => 700 + 500 * u, q: 0.8, g: 0.18 });
    }
    S.tone({ t: 24 * st, f: 1700, f1: 2500, glide: 0.12, env: 'bell', dur: 0.5, vib: 0.01, vibF: 9, g: 0.12 });
  } },
  // 9 크림치즈 허니 — 5박 한 마디(춤 한 주기). 통통 튀는 마림바, 3.8박에 두 팔 번쩍과 함께 '짠', 마지막 박은 쉼 (F장조)
  creamCheese: { code: 9, bpm: BPM.creamCheese, bars: 1.25, level: 0.3, r(S, st) {
    const step = (str, cb) => { for (let i = 0; i < str.length; i++) if (str[i] === 'x' || str[i] === 'o') cb(i * st, str[i] === 'x' ? 1 : 0.55); };
    step('x...x...x...x.......', (t, g) => kit.kick(S, t, 0.7 * g));
    step('....x.......x.......', (t, g) => kit.clap(S, t, 0.45 * g));
    step('..o...o...o...o.....', (t, g) => kit.hat(S, t, 0.5 * g));
    for (const [s, m] of [[0, 72], [2, 76], [4, 79], [6, 77], [8, 76], [10, 72], [12, 74], [13, 76]]) kit.marimba(S, s * st, m, 0.55);
    for (const [s, m] of [[0, 41], [4, 45], [8, 46], [12, 48]]) kit.pluck(S, s * st, m, 0.12, 0.55, { harm: 5, tilt: 1.4 });   // F A B♭ C
    const ta = 15.2 * st;
    for (const m of [65, 69, 72, 77]) S.tone({ t: ta, f: mtof(m), harm: 6, tilt: 1.2, env: 'bell', dur: 0.45, g: 0.12 });
    S.tone({ t: ta, f: 1800, f1: 2600, glide: 0.08, env: 'bell', dur: 0.3, g: 0.08 });
  } },
  // 10 당신에게서 — 잔잔한 발라드(4박 = 춤 두 주기). 부드러운 패드 위 종소리 멜로디, 2박마다 숨 쉬듯 쉼 (D장조)
  fromYou: { code: 10, bpm: BPM.fromYou, bars: 1, level: 0.3, r(S, st) {
    const pad = (t, ms, len) => { for (const m of ms) S.tone({ t, f: mtof(m), harm: 5, tilt: 1.7, env: 'bell', dur: len, vib: 0.004, vibF: 4.5, g: 0.07 }); };
    pad(0, [62, 66, 69, 73], 1.5);                                   // Dmaj7
    pad(8 * st, [59, 62, 66, 69], 1.5);                              // Bm7
    for (const [s, m] of [[0, 78], [2, 76], [3, 74], [5, 76], [8, 74], [10, 73], [11, 71], [13, 73]]) {
      const f = mtof(m);
      S.ring({ t: s * st, f: [f, f * 2.76, f * 5.4], amp: [1, 0.22, 0.05], dec: [0.9, 0.25, 0.08], g: 0.32 });
    }
    hits('x.......x.......', 1, st, (t, g) => kit.kick(S, t, 0.35 * g));
    hits('....o.......o...', 1, st, (t, g) => kit.rim(S, t, 0.5 * g));
  } },
  // 11 셀카 — 가벼운 힙합 비트(4박 = 춤 한 주기). 0.86박·2.86박에 셔터 '찰칵' (A단조)
  selfie: { code: 11, bpm: BPM.selfie, bars: 1, level: 0.3, r(S, st) {
    hits('x.....x...x.....', 1, st, (t, g) => kit.kick(S, t, 0.8 * g));
    hits('....x.......x...', 1, st, (t, g) => kit.snare(S, t, 0.45 * g));
    hits('x.x.x.x.x.x.x.x.', 1, st, (t, g) => kit.hat(S, t, 0.4 * g));
    for (const [s, m, len] of [[0, 45, 2], [3, 45, 1], [8, 48, 2], [11, 43, 1]]) kit.held(S, s * st, m, len * st, 0.6, { harm: 4, tilt: 1.5, gate: 0.7 });
    for (const [s, m] of [[1, 76], [2, 79], [9, 72], [10, 76]]) kit.pluck(S, s * st, m, 0.1, 0.3, { harm: 7 });
    for (const beat of [0.86, 2.86]) {
      const t = beat * 4 * st;
      S.click(t, 0.9, 3000)
        .noise({ t: t + 0.004, dur: 0.05, d: 0.012, bp: 3800, q: 1.4, g: 0.5 })
        .noise({ t: t + 0.06, dur: 0.04, d: 0.01, bp: 2600, q: 1.2, g: 0.35 });
    }
  } }
};

/** 이모트 id 목록. 인덱스 + 1 = 전송 번호(1~11) */
export const EMOTE_SOUNDS = Object.freeze(Object.keys(EMOTE_DEFS).sort((a, b) => EMOTE_DEFS[a].code - EMOTE_DEFS[b].code));
/** 이모트 루프 템포(id → BPM, 한 번형은 0). 춤 동작(core EMOTES[].bpm)과 같아야 박자가 맞는다 */
export const EMOTE_BPM = Object.freeze(Object.fromEntries(EMOTE_SOUNDS.map((id) => [id, EMOTE_DEFS[id].bpm || 0])));

/* ───────────── 엔진 ───────────── */

function softClipCurve() {                 // |x|≤0.75 선형, 그 위는 tanh로 0.99 미만에 수렴 → 하드 클리핑 없음
  const n = 2048, c = new Float32Array(n), T = 0.75, R = 0.24;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1, a = Math.abs(x);
    c[i] = Math.sign(x) * (a <= T ? a : T + R * Math.tanh((a - T) / R));
  }
  return c;
}

function setComp(c, th, knee, ratio, atk, rel) {
  c.threshold.value = th; c.knee.value = knee; c.ratio.value = ratio; c.attack.value = atk; c.release.value = rel;
}

function setAt(param, value, now, at) {     // 지난 이벤트를 비워 타임라인이 쌓이지 않게
  param.cancelScheduledValues(now);
  param.setValueAtTime(value, at);
}

const NO_OPTS = Object.freeze({});
const tmpPos = { x: 0, y: 0, z: 0 };
function readPos(p) {                      // {x,y,z} | THREE.Vector3 | [x,y,z]
  if (!p) return null;
  if (Array.isArray(p)) { tmpPos.x = +p[0] || 0; tmpPos.y = +p[1] || 0; tmpPos.z = +p[2] || 0; }
  else { tmpPos.x = +p.x || 0; tmpPos.y = +p.y || 0; tmpPos.z = +p.z || 0; }
  return tmpPos;
}

// 이모트 음원 교체(선택): audio/emotes/manifest.json. 이 모듈 기준 상대 경로라 어느 페이지에서 불러도 같은 곳을 본다.
const DEFAULT_EMOTE_MANIFEST = (() => {
  try { return new URL('../../audio/emotes/manifest.json', import.meta.url).href; } catch { return null; }
})();
const SAFE_FILE = /^[A-Za-z0-9_][A-Za-z0-9_.\-/]*$/;       // manifest 기준 상대 파일 이름만(절대 URL·'..' 금지)
const EMOTE_FILE_MAX_BYTES = 8 * 1024 * 1024, EMOTE_FILE_MAX_SEC = 60;

/**
 * 안내 음성(연속 킬) id 목록 = audio/voice/<id>.mp3. tools/make-voice.mjs가 Windows 한국어 음성(TTS)으로 합성해 다듬은
 * 짧은 문장이다. id는 js/game/multikill.js의 단계표와 같다(tests/multikill.test.mjs).
 */
export const VOICE_IDS = Object.freeze(['double', 'triple', 'quadra', 'penta', 'hexa', 'legend']);
const DEFAULT_VOICE_DIR = (() => {
  try { return new URL('../../audio/voice/', import.meta.url).href; } catch { return null; }
})();
const VOICE_FILE_MAX_BYTES = 512 * 1024, VOICE_LEVEL = 0.95;

export function createAudio(opts = {}) {
  const MAX3 = opts.maxVoices3d ?? 20;     // 3D 보이스(HRTF) 상한
  const MAX2 = opts.maxVoices2d ?? 8;      // 2D 보이스(UI·자기 무기) 상한
  let ctx = null, mix = null, outVol = null, verb = null, chainNodes = [];
  let volume = Math.min(1, Math.max(0, opts.volume ?? 0.8));
  let quality = opts.quality === 'low' ? 'low' : 'high';
  let disposed = false, prewarmTimer = 0, seq = 0;
  const L = { x: 0, y: 1.6, z: 0, yaw: 0, pitch: 0 };
  const cache = new Map();                 // name → AudioBuffer[] (합성 결과 재사용)
  const lastVar = new Map();
  const pool3 = [], pool2 = [];
  // 이모트 음악: 효과음 풀과 분리한 작은 보이스 풀(3D는 가벼운 equalpower). 핸들은 가상 재생 시각(t0)을 가져서
  // 보이스를 잃었다 다시 받아도 박자가 이어진다.
  const EMO_MAX3 = 6, EMO_MAX2 = 2, EMO_MAX_DIST = 45;
  const emo3 = [], emo2 = [];
  const emoCache = new Map();              // id → AudioBuffer (32 kHz 모노, 루프는 이음매 없음)
  const emoSynth = new Map();              // id → 합성음 묘사자
  const emoFiles = new Map();              // id → 파일 묘사자(manifest로 교체된 이모트만)
  const manifestUrl = opts.emoteManifest === false ? null : (opts.emoteManifest || DEFAULT_EMOTE_MANIFEST);
  const emoRaw = new Map();                // id → { ent, data } 받아서 푼 음원 바이트(언락 전에도 채운다)
  const emoBuilding = new Map();           // id → 버퍼 만들기 Promise(한 번만)
  const emoBad = [];                       // 합성음으로 대체한 이유
  let emoFetch = null, emoReady = null, emoAbort = null, emoPrefetchTimer = 0;
  const emoHandles = new Set();
  const emoCand = [], emoLocal = [];
  let emoSeq = 0, emoLast = -1e9;
  // 안내 음성: 받은 바이트 → 디코드한 버퍼. 전용 2D 보이스 하나로 한 번에 한 문장만 낸다
  const voiceDir = opts.voiceDir === false ? null : (opts.voiceDir || DEFAULT_VOICE_DIR);
  const voiceRaw = new Map();              // id → ArrayBuffer(언락 전에도 받아 둔다)
  const voiceBuf = new Map();              // id → AudioBuffer
  const voiceDecoding = new Map();         // id → 디코드 Promise(한 번만)
  const voiceBad = [];
  let voiceFetch = null, voiceAbort = null, voiceV = null, voiceLast = '', voicePlays = 0;

  function build() {
    const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
    if (!AC) return false;
    ctx = new AC({ latencyHint: 'interactive' });
    mix = ctx.createGain();
    const comp = ctx.createDynamicsCompressor(); setComp(comp, -20, 10, 3.5, 0.004, 0.2);
    const makeup = ctx.createGain(); makeup.gain.value = 1.25;
    const limiter = ctx.createDynamicsCompressor(); setComp(limiter, -3, 0, 20, 0.001, 0.08);
    const clip = ctx.createWaveShaper(); clip.curve = softClipCurve(); clip.oversample = 'none';
    outVol = ctx.createGain(); outVol.gain.value = volume;
    mix.connect(comp); comp.connect(makeup); makeup.connect(limiter); limiter.connect(clip);
    clip.connect(outVol); outVol.connect(ctx.destination);
    verb = ctx.createConvolver(); verb.buffer = makeIR();
    const verbRet = ctx.createGain(); verbRet.gain.value = 0.55;
    verb.connect(verbRet); verbRet.connect(mix);
    chainNodes = [mix, comp, makeup, limiter, clip, outVol, verb, verbRet];
    for (let i = 0; i < MAX3; i++) pool3.push(makeVoice(true));
    for (let i = 0; i < MAX2; i++) pool2.push(makeVoice(false));
    for (let i = 0; i < EMO_MAX3; i++) emo3.push(makeEmoteVoice(true));
    for (let i = 0; i < EMO_MAX2; i++) emo2.push(makeEmoteVoice(false));
    voiceV = makeVoice(false);
    applyListener();
    return true;
  }

  function makeEmoteVoice(is3d) {
    const v = makeVoice(is3d);
    if (v.p) { v.p.panningModel = 'equalpower'; v.p.refDistance = 3; v.p.rolloffFactor = 1.2; v.p.maxDistance = EMO_MAX_DIST; }
    v.h = null;
    return v;
  }

  // 잔향: 프리딜레이 + 벽 초기 반사 + 점점 어두워지는 꼬리 (합성 IR)
  function makeIR() {
    const sr = ctx.sampleRate, len = Math.floor(sr * 1.8), b = ctx.createBuffer(2, len, sr);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c), rnd = mulberry32(99 + c * 31);
      let lp = 0;
      for (let i = Math.floor(sr * 0.012); i < len; i++) {
        const t = i / sr, fc = 400 + 7000 * Math.exp(-t / 0.35);
        lp += (1 - Math.exp((-2 * Math.PI * fc) / sr)) * (rnd() * 2 - 1 - lp);
        d[i] = lp * Math.exp(-t / 0.42);
      }
      for (const [t, g] of [[0.023, 0.5], [0.041, -0.35], [0.067, 0.28], [0.103, -0.2]]) {
        d[Math.floor((t + c * 0.003) * sr)] += g;
      }
    }
    return b;
  }

  function makeVoice(is3d) {
    const g = ctx.createGain(); g.gain.value = 0;
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 20000; f.Q.value = 0.5;
    const send = ctx.createGain(); send.gain.value = 0;
    let out = f, p = null;
    g.connect(f);
    if (is3d) {
      p = ctx.createPanner();
      p.panningModel = quality === 'low' ? 'equalpower' : 'HRTF';
      p.distanceModel = 'inverse'; p.refDistance = 4; p.maxDistance = 420; p.rolloffFactor = 1;
      f.connect(p); out = p;
    }
    out.connect(mix); out.connect(send); send.connect(verb);
    return { is3d, g, f, p, send, src: null, name: '', score: 0, t0: 0, t1: 0, id: 0 };
  }

  // 변형 하나를 합성해 캐시에 추가 (캐시 배열은 변형 수만큼 점진적으로 채워진다)
  function renderVariant(name) {
    const def = DEFS[name], sr = ctx.sampleRate;
    let arr = cache.get(name);
    if (!arr) { arr = []; cache.set(name, arr); }
    if (arr.length >= (def.vars || 1)) return arr;
    const S = synth(sr, def.dur, hashStr(name) + arr.length * 7919);
    def.r(S, arr.length);
    const data = S.done();
    const b = ctx.createBuffer(1, data.length, sr);
    b.copyToChannel(data, 0);
    arr.push(b);
    return arr;
  }

  function getBuffer(name) {
    let arr = cache.get(name);
    if (!arr || !arr.length) arr = renderVariant(name);
    if (arr.length === 1) return arr[0];
    const last = lastVar.get(name) ?? -1;   // 같은 변형 연속 재생 방지
    let i = (Math.random() * arr.length) | 0;
    if (i === last) i = (i + 1) % arr.length;
    lastVar.set(name, i);
    return arr[i];
  }

  function schedulePrewarm() {             // 첫 재생 지연을 없애려고 유휴 시간에 변형 하나씩 미리 합성
    if (prewarmTimer || !ctx) return;
    const todo = [];
    for (const n of SOUND_NAMES) for (let v = 0; v < (DEFS[n].vars || 1); v++) todo.push(n);
    for (const id of EMOTE_SOUNDS) todo.push('@' + id);    // 이모트 음악은 효과음 다음(루프 하나 ≈ 30~50 ms)
    const step = () => {
      prewarmTimer = 0;
      if (disposed || !ctx) return;
      const n = todo.shift();
      if (!n) return;
      if (n[0] === '@') emoteBuffer(n.slice(1)); else renderVariant(n);
      prewarmTimer = setTimeout(step, 16);
    };
    prewarmTimer = setTimeout(step, 30);
  }

  function isLive(v, now) {
    if (v.src && now > v.t1 + 0.1) release(v);   // ended 이벤트 누락 대비
    return !!v.src;
  }

  function release(v) {
    const s = v.src;
    v.src = null; v.name = '';
    if (s) { s.onended = null; try { s.disconnect(); } catch { /* 이미 해제 */ } }
  }

  // 빈 보이스 → 없으면 같은 소리 상한 초과분/가장 덜 중요한 보이스를 훔친다. 새 소리가 더 약하면 null.
  function acquire(pool, lim, name, def, score, now) {
    let free = null, same = 0, oldestSame = null, worst = null;
    for (let i = 0; i < lim; i++) {
      const v = pool[i];
      if (!isLive(v, now)) { if (!free) free = v; continue; }
      if (v.name === name) { same++; if (!oldestSame || v.t0 < oldestSame.t0) oldestSame = v; }
      if (!worst || v.score < worst.score || (v.score === worst.score && v.t0 < worst.t0)) worst = v;
    }
    if (same >= (def.max ?? 4)) return oldestSame;
    if (free) return free;
    if (worst && worst.score <= score) return worst;
    return null;
  }

  function fadeOutVoice(v, now, sec = 0.01) {
    const gp = v.g.gain;
    gp.cancelScheduledValues(now);
    gp.setValueAtTime(gp.value, now);
    gp.linearRampToValueAtTime(0, now + sec);
    const s = v.src;
    if (s) { try { s.stop(now + sec + 0.002); } catch { /* 이미 정지 */ } }
  }

  function play(name, opt) {
    if (!ctx || disposed || ctx.state === 'closed') return null;
    const def = ownDef(DEFS, name);
    if (!def) return null;                               // 모르는 이름은 오류 없이 무시한다
    const o = opt || NO_OPTS;
    const now = ctx.currentTime;
    const p = def.ui ? null : readPos(o.pos);
    const is3d = !!p;
    let dist = 0;
    if (is3d) {
      dist = Math.hypot(p.x - L.x, p.y - L.y, p.z - L.z);
      if (dist > def.maxDist) return null;               // 들리지 않을 거리면 보이스를 쓰지 않는다
    }
    const score = def.prio - (is3d ? Math.min(3, dist / 40) : 0);
    const pool = is3d ? pool3 : pool2;
    const lim = is3d && quality === 'low' ? Math.min(12, pool.length) : pool.length;
    const v = acquire(pool, lim, name, def, score, now);
    if (!v) return null;

    const stolen = !!v.src;
    if (stolen) {                                        // 이전 음원은 10ms 페이드 후 스스로 정지·해제 (클릭 방지)
      const old = v.src;
      fadeOutVoice(v, now);
      old.onended = () => { try { old.disconnect(); } catch { /* 이미 해제 */ } };
      v.src = null; v.name = '';
    }
    const at = stolen ? now + 0.012 : now;
    const buf = getBuffer(name);
    const src = ctx.createBufferSource();                // BufferSource는 스펙상 일회용(가벼움). 나머지 체인은 재사용.
    src.buffer = buf;
    const rate = Math.max(0.25, Math.min(4, (o.rate ?? 1) * (1 + (Math.random() * 2 - 1) * (def.jit ?? 0.02))));
    src.playbackRate.value = rate;

    const gain = def.level * Math.max(0, o.gain ?? 1);
    const gp = v.g.gain;
    if (!stolen) gp.cancelScheduledValues(now);
    gp.setValueAtTime(gain, at);

    if (is3d) {
      const pn = v.p;
      pn.refDistance = def.ref ?? 4; pn.rolloffFactor = def.roll ?? 1; pn.maxDistance = def.maxDist;
      if (pn.positionX) { pn.positionX.value = p.x; pn.positionY.value = p.y; pn.positionZ.value = p.z; }
      else pn.setPosition(p.x, p.y, p.z);
      const half = def.muffle ? 24 : 50;                  // 멀수록 먹먹하게(저역 통과)
      const fc = Math.max(def.muffle ? 500 : 1400, 18000 * Math.pow(0.5, dist / half));
      setAt(v.f.frequency, fc, now, at);
    } else {
      setAt(v.f.frequency, 20000, now, at);
    }
    const sendAmt = (def.send ?? 0) * (is3d ? 0.6 + Math.min(0.8, dist / 60) : 0.5);
    setAt(v.send.gain, quality === 'low' ? sendAmt * 0.5 : sendAmt, now, at);

    src.connect(v.g);
    src.start(at);
    v.src = src; v.name = name; v.score = score; v.t0 = at; v.t1 = at + buf.duration / rate; v.id = ++seq;
    src.onended = () => { if (v.src === src) release(v); };
    const id = v.id;
    return {
      id,
      stop(fade = 0.05) { if (ctx && v.id === id && v.src) { fadeOutVoice(v, ctx.currentTime, fade); } }
    };
  }

  /* ── 이모트 ── */

  function emoteBuffer(id) {
    let b = emoCache.get(id);
    if (b) return b;
    const def = EMOTE_DEFS[id], sr = Math.min(ctx.sampleRate, 32000);
    let data;
    if (def.oneShot) {
      const S = synth(sr, def.dur, hashStr('emote:' + id));
      def.r(S);
      data = S.done();
    } else {
      const st = 60 / def.bpm / 4, loopSec = def.bars * 16 * st;   // st = 16분음표 길이
      const S = synth(sr, loopSec + 1.2, hashStr('emote:' + id));
      def.r(S, st);
      data = S.loopDone(loopSec);
    }
    b = ctx.createBuffer(1, data.length, sr);
    b.copyToChannel(data, 0);
    emoCache.set(id, b);
    return b;
  }

  /* ── 이모트 음원 파일(manifest). 목록에 있는 파일만 요청, 실패는 console.info 한 줄 + 합성음 ──
   * 1) 받기·풀기(fetchEmoteFiles)는 오디오를 켜기 전에도 한다: 페이지를 열고 잠시 뒤, 또는 언락 때 중 먼저.
   *    번호 순서(L을 가져가가 먼저)로 요청한다.
   * 2) 버퍼 만들기(buildEmoteFile)는 오디오 컨텍스트가 생긴 뒤. 묶음의 WAV는 직접 읽어 곧바로 버퍼로 만든다.
   * 3) 파일이 늦게 준비돼 합성음으로 시작한 이모트(상점 미리 듣기 포함)는 준비되는 즉시 같은 박자 위치에서 파일로 바꿔 튼다. */
  function fetchEmoteFiles() {
    if (emoFetch) return emoFetch;
    clearTimeout(emoPrefetchTimer); emoPrefetchTimer = 0;
    if (!manifestUrl || typeof fetch !== 'function' || disposed) { emoFetch = Promise.resolve(); return emoFetch; }
    emoAbort = typeof AbortController === 'function' ? new AbortController() : null;
    const signal = emoAbort ? emoAbort.signal : undefined;
    emoFetch = (async () => {
      let list;
      try {
        const res = await fetch(manifestUrl, { cache: 'no-cache', signal });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        list = await res.json();
      } catch (e) {
        if (!disposed && e?.name !== 'AbortError') console.info('[fx] 이모트 음원 manifest를 읽지 못해 합성음을 씁니다 —', e?.message || String(e));
        return;
      }
      if (!list || typeof list !== 'object' || Array.isArray(list)) {
        console.info('[fx] 이모트 음원 manifest가 객체가 아니라서 합성음을 씁니다.');
        return;
      }
      const rank = (id) => { const i = EMOTE_SOUNDS.indexOf(id); return i < 0 ? 99 : i; };
      const ids = Object.keys(list).sort((a, b) => rank(a) - rank(b));
      await Promise.all(ids.map(async (id) => {
        const ent = list[id];
        const file = ent && typeof ent.file === 'string' ? ent.file.trim() : '';
        if (!ownDef(EMOTE_DEFS, id)) { emoBad.push(`${id}: 모르는 이모트`); return; }
        if (!SAFE_FILE.test(file) || file.split('/').includes('..')) { emoBad.push(`${id}: 파일 이름`); return; }
        try {
          const res = await fetch(new URL(file, manifestUrl).href, { signal });
          if (!res.ok) throw new Error('HTTP ' + res.status);
          let ab = await res.arrayBuffer();
          if (ab.byteLength > EMOTE_FILE_MAX_BYTES) throw new Error('파일이 너무 큼');
          if (ent.enc === true) ab = await decryptEmote(ab);    // 음원 묶음(.bin, js/fx/emote-key.js)은 여기서 풀어 둔다
          if (disposed) return;
          emoRaw.set(id, { ent, data: ab });
          if (ctx) await buildEmoteFile(id);                   // 이미 언락했으면 바로 버퍼로
        } catch (e) {
          if (e?.name !== 'AbortError') emoBad.push(`${id}: ${e?.message || e}`);
        }
      }));
    })();
    return emoFetch;
  }

  /** 언락 때 한 번: 받기를 시작(또는 이어서)하고, 받은 것을 모두 버퍼로 만든다. 끝나면 파일로 바뀐 id 목록 */
  function loadEmoteFiles() {
    if (emoReady) return emoReady;
    if (!ctx) return Promise.resolve([]);
    emoReady = fetchEmoteFiles()
      .then(() => Promise.all([...emoRaw.keys()].map((id) => buildEmoteFile(id))))
      .then(() => {
        if (disposed) return [];
        const ok = [...emoFiles.keys()];
        if (ok.length || emoBad.length) {
          console.info(`[fx] 이모트 음원 — 파일: ${ok.length ? ok.join(', ') : '없음'}${emoBad.length ? ` · 합성음 대체: ${emoBad.join(' / ')}` : ''}`);
        }
        return ok;
      });
    return emoReady;
  }

  /** 16비트 PCM WAV(묶는 도구가 만드는 형식)를 곧바로 AudioBuffer로. 다른 형식이면 null(→ decodeAudioData) */
  function wavBuffer(ab) {
    try {
      const dv = new DataView(ab);
      const tag = (o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
      if (ab.byteLength < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
      let o = 12, fmt = null, data = null;
      while (o + 8 <= ab.byteLength) {
        const id = tag(o), size = dv.getUint32(o + 4, true);
        if (id === 'fmt ') fmt = { format: dv.getUint16(o + 8, true), ch: dv.getUint16(o + 10, true), rate: dv.getUint32(o + 12, true), bits: dv.getUint16(o + 22, true) };
        else if (id === 'data') { data = { at: o + 8, size: Math.min(size, ab.byteLength - o - 8) }; break; }
        o += 8 + size + (size & 1);
      }
      if (!fmt || !data || fmt.format !== 1 || fmt.bits !== 16 || fmt.ch < 1 || fmt.ch > 2 || fmt.rate < 8000 || fmt.rate > 96000) return null;
      const frames = Math.floor(data.size / (2 * fmt.ch));
      if (!frames) return null;
      const buf = ctx.createBuffer(fmt.ch, frames, fmt.rate);
      for (let c = 0; c < fmt.ch; c++) {
        const out = buf.getChannelData(c);
        for (let i = 0; i < frames; i++) out[i] = dv.getInt16(data.at + (i * fmt.ch + c) * 2, true) / 32768;
      }
      return buf;
    } catch {
      return null;
    }
  }

  /** 받아 둔 음원 하나를 버퍼로(한 번만). 합성음으로 돌던 같은 이모트는 파일로 바꾼다 */
  function buildEmoteFile(id) {
    if (!ctx || disposed) return Promise.resolve();
    if (emoBuilding.has(id)) return emoBuilding.get(id);
    const raw = emoRaw.get(id);
    if (!raw) return Promise.resolve();
    const job = makeEmoteFile(id, raw.ent, raw.data)
      .catch((e) => { emoBad.push(`${id}: ${e?.message || e}`); });
    emoBuilding.set(id, job);
    return job;
  }

  async function makeEmoteFile(id, ent, ab) {
    let buf = wavBuffer(ab);
    if (!buf) {
      try { buf = await ctx.decodeAudioData(ab.slice(0)); } catch { throw new Error('디코드 실패'); }
    }
    if (!ctx || disposed || !buf) return;
    if (buf.duration > EMOTE_FILE_MAX_SEC) throw new Error(`${EMOTE_FILE_MAX_SEC}초 초과`);
    let pk = 0;                                            // 피크를 합성음과 같은 0.9로 맞춘다 → gain 1 ≈ 합성음 크기
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < d.length; i++) { const a = d[i] < 0 ? -d[i] : d[i]; if (a > pk) pk = a; }
    }
    const norm = pk > 1e-4 ? Math.min(4, 0.9 / pk) : 1;
    const g = Number(ent.gain);
    const gain = ent.gain == null || !Number.isFinite(g) || g < 0 ? 1 : Math.min(4, g);
    let ls = Number(ent.loopStart);
    ls = Number.isFinite(ls) && ls > 0 ? ls : 0;
    let le = ent.loopEnd == null ? buf.duration : Number(ent.loopEnd);
    le = Number.isFinite(le) ? Math.min(buf.duration, le) : buf.duration;
    if (le - ls < 0.05) { ls = 0; le = buf.duration; }     // 구간이 잘못되면 파일 전체를 반복
    const f = { buf, ls, le, level: EMOTE_DEFS[id].level * gain * norm, source: 'file' };
    emoFiles.set(id, f);
    // 파일보다 먼저 시작해 합성음으로 돌던 같은 이모트: 보이스를 짧게 줄이고 같은 박자 위치(t0 기준)에서 파일로 다시 받는다
    let swapped = false;
    for (const h of emoHandles) {
      if (h.name !== id || h.dead || h.snd.source !== 'synth') continue;
      h.snd = f;
      dropEmote(h, 0.06);
      swapped = true;
    }
    if (swapped) refreshEmotes(true);
  }

  // 이모트 소리 묘사자 { buf, ls, le(루프 구간 초), level, source: 'file'|'synth' }.
  // 파일(manifest)이 디코드돼 있으면 그것, 아니면 합성음. 핸들은 시작할 때 하나를 잡아 끝까지 쓴다.
  function emoteSound(id) {
    const f = emoFiles.get(id);
    if (f) return f;
    let s = emoSynth.get(id);
    if (!s) {
      const buf = emoteBuffer(id);
      s = { buf, ls: 0, le: buf.duration, level: EMOTE_DEFS[id].level, source: 'synth' };
      emoSynth.set(id, s);
    }
    return s;
  }

  // 가상 재생 위치(초): 반복형은 처음엔 0→loopEnd, 그 뒤 loopStart~loopEnd 를 돈다
  function emotePos(h, el) {
    const s = h.snd;
    if (el <= 0) return 0;
    if (!h.loop) return Math.min(el, s.buf.duration);
    if (el < s.le) return el;
    return s.ls + ((el - s.ls) % (s.le - s.ls));
  }

  const NO_EMOTE = Object.freeze({ id: 0, name: '', source: '', playing: false, stop() {}, setPos() {} });

  function emote(which, o = {}) {
    const name = typeof which === 'number' ? EMOTE_SOUNDS[which - 1] : which;
    const def = ownDef(EMOTE_DEFS, name);
    if (!def || !ctx || disposed || ctx.state === 'closed') return NO_EMOTE;
    const p = readPos(o.pos);
    const h = {
      name, def, snd: emoteSound(name), loop: !def.oneShot && o.loop !== false,
      pos: p ? { x: p.x, y: p.y, z: p.z } : null, gain: Math.max(0, o.gain ?? 1),
      t0: ctx.currentTime, dist: 0, voice: null, dead: false, api: null
    };
    h.api = {
      id: ++emoSeq, name,
      /** 'file'(manifest 음원) | 'synth'(합성음) */
      get source() { return h.snd.source; },
      get playing() { return !h.dead; },
      stop(fadeMs = 150) { endEmote(h, Math.max(5, +fadeMs || 0) / 1000); },
      setPos(np) {                                          // 2D(내 이모트) 핸들에서는 무시
        if (h.dead || !h.pos) return;
        const q = readPos(np);
        if (!q) return;
        h.pos.x = q.x; h.pos.y = q.y; h.pos.z = q.z;
        if (h.voice) placeEmote(h, false);
      }
    };
    emoHandles.add(h);
    refreshEmotes(true);
    return h.api;
  }

  // 0.2초마다(setListener에서) 또는 즉시: 끝난 한 번형 정리, 가까운 3D 이모트 상위 N개에만 보이스 배정
  function refreshEmotes(force) {
    if (!ctx || !emoHandles.size) return;
    const wall = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (!force && wall - emoLast < 200) return;          // 주기는 벽시계 기준(오디오 스레드가 밀려도 일정)
    emoLast = wall;
    const now = ctx.currentTime;                         // 재생 위치(박자)는 오디오 시계 기준
    emoCand.length = 0; emoLocal.length = 0;
    for (const h of emoHandles) {
      if (!h.loop && now >= h.t0 + h.snd.buf.duration) { endEmote(h, 0.02); continue; }
      if (!h.pos) { emoLocal.push(h); continue; }
      h.dist = Math.hypot(h.pos.x - L.x, h.pos.y - L.y, h.pos.z - L.z);
      if (h.dist <= EMO_MAX_DIST) emoCand.push(h); else dropEmote(h, 0.3);
    }
    emoCand.sort((a, b) => a.dist - b.dist);
    const lim = Math.min(emo3.length, quality === 'low' ? 3 : EMO_MAX3);
    for (let i = lim; i < emoCand.length; i++) dropEmote(emoCand[i], 0.3);
    for (let i = 0; i < emoCand.length && i < lim; i++) {
      const h = emoCand[i];
      if (h.voice) placeEmote(h, true); else giveEmote(h, emo3, now);
    }
    const first = Math.max(0, emoLocal.length - emo2.length);   // 2D(내 이모트)는 최신 것 우선
    for (let i = 0; i < first; i++) dropEmote(emoLocal[i], 0.15);
    for (let i = first; i < emoLocal.length; i++) if (!emoLocal[i].voice) giveEmote(emoLocal[i], emo2, now);
  }

  function giveEmote(h, pool, now) {
    const s = h.snd, dur = s.buf.duration, el = now - h.t0;
    if (!h.loop && el > 0.05 && dur - el < 1) return;            // 거의 끝난 한 번형은 늦게 시작하지 않는다
    let v = null;
    for (const x of pool) if (!x.h && (!v || (v.src && !x.src))) v = x;   // 조용한 보이스 우선
    if (!v) return;
    const at = now + 0.015, gp = v.g.gain;
    if (v.src) {                                                  // 페이드 중인 이전 음원은 12ms 안에 정리
      const old = v.src;
      fadeOutVoice(v, now, 0.012);
      old.onended = () => { try { old.disconnect(); } catch { /* 이미 해제 */ } };
      v.src = null;
    } else gp.cancelScheduledValues(now);
    const src = ctx.createBufferSource();
    src.buffer = s.buf; src.loop = h.loop;
    if (h.loop) { src.loopStart = s.ls; src.loopEnd = s.le; }    // 합성 루프는 0~끝, 파일은 manifest 구간
    const off = emotePos(h, el + 0.015);
    gp.setValueAtTime(0, at);                                     // 중간부터 이어 받으면 부드럽게 페이드 인
    gp.linearRampToValueAtTime(s.level * h.gain * (h.pos ? 0.75 : 1), at + (el > 0.05 ? 0.12 : 0.008));
    v.h = h; h.voice = v; v.src = src;
    placeEmote(h, true);
    setAt(v.send.gain, h.pos ? 0.12 : 0.05, now, at);
    src.connect(v.g);
    src.start(at, off);
    src.onended = () => {
      if (v.src === src) v.src = null;
      try { src.disconnect(); } catch { /* 이미 해제 */ }
      if (h.voice === v && !h.loop) { v.h = null; h.voice = null; endEmote(h, 0); }
    };
  }

  function placeEmote(h, full) {
    const v = h.voice;
    if (!v) return;
    const now = ctx.currentTime;
    if (h.pos && v.p) {
      const pn = v.p;
      if (pn.positionX) { pn.positionX.value = h.pos.x; pn.positionY.value = h.pos.y; pn.positionZ.value = h.pos.z; }
      else pn.setPosition(h.pos.x, h.pos.y, h.pos.z);
      if (full) setAt(v.f.frequency, Math.max(1200, 16000 * Math.pow(0.5, h.dist / 30)), now, now);
    } else if (full) setAt(v.f.frequency, 20000, now, now);
  }

  function dropEmote(h, fade) {                                   // 핸들은 살려 두고 보이스만 돌려준다
    const v = h.voice;
    if (!v) return;
    h.voice = null; v.h = null;
    if (v.src && ctx) fadeOutVoice(v, ctx.currentTime, fade);
  }

  function endEmote(h, fade) {
    if (h.dead) return;
    h.dead = true;
    emoHandles.delete(h);
    if (ctx) dropEmote(h, Math.max(0.005, fade));
  }

  function stopAll(fade = 0.05) {
    if (!ctx) return;
    const now = ctx.currentTime;
    for (const h of emoHandles) endEmote(h, fade);
    for (const v of pool3.concat(pool2)) if (v.src) fadeOutVoice(v, now, fade);
    if (voiceV && voiceV.src) fadeOutVoice(voiceV, now, fade);
  }

  /* ── 안내 음성(연속 킬) ──
   * 받기는 페이지를 연 뒤 잠시 뒤나 언락 때 중 먼저(6개 합계 약 45 KB), 디코드는 오디오 컨텍스트가 생긴 뒤.
   * 아직 준비되지 않았거나 못 읽은 문장은 소리 없이 건너뛴다(같이 내는 효과음은 그대로 난다). */
  function fetchVoices() {
    if (voiceFetch) return voiceFetch;
    if (!voiceDir || typeof fetch !== 'function' || disposed) { voiceFetch = Promise.resolve(); return voiceFetch; }
    voiceAbort = typeof AbortController === 'function' ? new AbortController() : null;
    const signal = voiceAbort ? voiceAbort.signal : undefined;
    voiceFetch = Promise.all(VOICE_IDS.map(async (id) => {
      try {
        const res = await fetch(new URL(`${id}.mp3`, voiceDir).href, { signal });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const ab = await res.arrayBuffer();
        if (ab.byteLength > VOICE_FILE_MAX_BYTES) throw new Error('파일이 너무 큼');
        if (disposed) return;
        voiceRaw.set(id, ab);
        if (ctx) await decodeVoice(id);
      } catch (e) {
        if (e?.name !== 'AbortError') voiceBad.push(`${id}: ${e?.message || e}`);
      }
    })).then(() => {
      if (voiceBad.length && !disposed) console.info(`[fx] 안내 음성 일부를 읽지 못해 효과음만 냅니다 — ${voiceBad.join(' / ')}`);
    });
    return voiceFetch;
  }

  function decodeVoice(id) {
    if (!ctx || disposed || voiceBuf.has(id)) return Promise.resolve();
    if (voiceDecoding.has(id)) return voiceDecoding.get(id);
    const raw = voiceRaw.get(id);
    if (!raw) return Promise.resolve();
    const job = ctx.decodeAudioData(raw.slice(0))
      .then((b) => { if (!disposed && ctx && b) voiceBuf.set(id, b); })
      .catch(() => { voiceBad.push(`${id}: 디코드 실패`); });
    voiceDecoding.set(id, job);
    return job;
  }

  /** 언락 때: 받기를 시작(또는 이어서)하고 받은 것을 모두 디코드한다. 끝나면 쓸 수 있는 id 목록 */
  function loadVoices() {
    if (!ctx) return Promise.resolve([]);
    return fetchVoices()
      .then(() => Promise.all([...voiceRaw.keys()].map(decodeVoice)))
      .then(() => [...voiceBuf.keys()]);
  }

  /** 안내 음성 한 문장(2D). 앞 문장이 아직 나오면 40 ms 페이드로 끊고 바로 잇는다. 냈으면 true */
  function voice(id, o) {
    if (!ctx || disposed || ctx.state === 'closed' || !voiceV) return false;
    if (typeof id !== 'string' || !VOICE_IDS.includes(id)) return false;
    const buf = voiceBuf.get(id);
    if (!buf) { loadVoices(); return false; }
    const opt = o || NO_OPTS, v = voiceV, now = ctx.currentTime;
    let at = now + Math.min(2, Math.max(0, Number(opt.delay) || 0));
    if (v.src) {
      const old = v.src;
      fadeOutVoice(v, now, 0.04);
      old.onended = () => { try { old.disconnect(); } catch { /* 이미 해제 */ } };
      v.src = null;
      at = Math.max(at, now + 0.045);
    } else v.g.gain.cancelScheduledValues(now);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    v.g.gain.setValueAtTime(VOICE_LEVEL * Math.max(0, opt.gain ?? 1), at);
    setAt(v.f.frequency, 20000, now, now);
    setAt(v.send.gain, quality === 'low' ? 0.06 : 0.12, now, now);   // 공용 잔향을 조금 섞어 방 안에서 울리게
    src.connect(v.g);
    src.start(at);
    v.src = src; v.name = 'voice:' + id; v.t0 = at; v.t1 = at + buf.duration;
    src.onended = () => {
      if (v.src === src) { v.src = null; v.name = ''; }
      try { src.disconnect(); } catch { /* 이미 해제 */ }
    };
    voiceLast = id; voicePlays++;
    return true;
  }

  function applyListener() {
    if (!ctx) return;
    const l = ctx.listener;
    const cp = Math.cos(L.pitch), sp = Math.sin(L.pitch), cy = Math.cos(L.yaw), sy = Math.sin(L.yaw);
    // three.js 카메라 관례(Euler 'YXZ', -Z가 정면): forward/up 벡터
    const fx = -sy * cp, fy = sp, fz = -cy * cp, ux = sy * sp, uy = cp, uz = cy * sp;
    if (l.positionX) {
      l.positionX.value = L.x; l.positionY.value = L.y; l.positionZ.value = L.z;
      l.forwardX.value = fx; l.forwardY.value = fy; l.forwardZ.value = fz;
      l.upX.value = ux; l.upY.value = uy; l.upZ.value = uz;
    } else {
      l.setPosition(L.x, L.y, L.z);
      l.setOrientation(fx, fy, fz, ux, uy, uz);
    }
  }

  // 음원 묶음과 안내 음성은 페이지를 연 뒤 잠시(게임 로딩과 겹치지 않게) 기다렸다가 미리 받아 둔다. 언락이 먼저면 그때 바로 받는다.
  // 그래서 상점 미리 듣기나 첫 이모트도 대개 처음부터 파일로 나온다. createAudio({ emotePrefetch: false })로 끌 수 있다
  const prefetchMs = opts.emotePrefetch === false ? -1 : Math.max(0, Number(opts.emotePrefetchDelayMs ?? 1500) || 0);
  if (prefetchMs >= 0 && (manifestUrl || voiceDir) && typeof setTimeout === 'function') {
    emoPrefetchTimer = setTimeout(() => { emoPrefetchTimer = 0; if (!disposed) { fetchEmoteFiles(); fetchVoices(); } }, prefetchMs);
  }

  return {
    names: SOUND_NAMES,
    /** 첫 사용자 입력(click/keydown/pointerdown) 핸들러 안에서 호출. 여러 번 불러도 안전. */
    unlock() {
      if (disposed) return Promise.resolve(false);
      if (!ctx && !build()) return Promise.resolve(false);
      try {                                              // iOS Safari 언락용 무음 1샘플
        const s = ctx.createBufferSource(); s.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
        s.connect(ctx.destination); s.start(); s.onended = () => s.disconnect();
      } catch { /* 무시 */ }
      schedulePrewarm();
      loadEmoteFiles();                                  // manifest 음원(있으면) — 한 번만, 비동기
      loadVoices();                                      // 안내 음성 — 받은 것을 디코드(비동기)
      if (ctx.state === 'suspended') return ctx.resume().then(() => ctx?.state === 'running', () => false);
      return Promise.resolve(ctx.state === 'running');
    },
    /** 0..1 마스터 볼륨(리미터 뒤 → 볼륨을 올려도 클리핑 없음) */
    setVolume(v) {
      volume = Math.min(1, Math.max(0, +v || 0));
      if (ctx) outVol.gain.setTargetAtTime(volume, ctx.currentTime, 0.02);
    },
    /** pos: {x,y,z}|Vector3|[x,y,z] (눈 위치), yaw/pitch: 라디안 (camera.rotation.y / .x, order 'YXZ') */
    setListener(pos, yaw = 0, pitch = 0) {
      const p = readPos(pos);
      if (p) { L.x = p.x; L.y = p.y; L.z = p.z; }
      L.yaw = +yaw || 0; L.pitch = +pitch || 0;
      applyListener();
      refreshEmotes(false);                              // 매 프레임 호출돼도 0.2초에 한 번만 재배정
    },
    /** name: SOUND_NAMES 중 하나. pos가 있으면 3D, 없으면 2D. 반환: { id, stop(fade) } | null(생략됨) */
    play,
    /**
     * 이모트 소리. which: id('takeL'…) 또는 전송 번호(1~11). pos가 있으면 3D(원격, 작게), 없으면 2D(나).
     * loop: 반복형 기본 true(false면 4마디 한 번). 한 번형(salute·wave)은 끝나면 저절로 정리된다.
     * 반환 { id, name, playing, stop(fadeMs = 150), setPos(pos) } — 언락 전·모르는 id·0이면 아무것도 안 하는 핸들.
     */
    emote,
    /** 이모트 id 목록(인덱스 + 1 = 전송 번호) */
    emotes: EMOTE_SOUNDS,
    /** 언락 뒤 manifest 음원을 모두 버퍼로 만들면 파일로 바뀐 이모트 id 목록으로 resolve(언락 전이거나 파일이 없으면 []) */
    emoteFilesReady() { return emoReady || Promise.resolve([]); },
    /** 음원 받기·풀기를 지금 시작한다(언락 전에도 됨, 한 번만). 끝나면 resolve */
    prefetchEmoteFiles: () => fetchEmoteFiles(),
    /**
     * 안내 음성 한 문장(2D, VOICE_IDS 중 하나). { delay: 초, gain }. 앞 문장은 끊고 바로 잇는다.
     * 냈으면 true, 언락 전·모르는 id·아직 못 받은 파일이면 false(그때는 받기·디코드를 시작해 둔다)
     */
    voice,
    /** 안내 음성 id 목록 */
    voices: VOICE_IDS,
    /** 언락 뒤 안내 음성을 모두 디코드하면 쓸 수 있는 id 목록으로 resolve(언락 전이면 []) */
    voicesReady: () => loadVoices(),
    stopAll,
    /** 'low': HRTF→equalpower, 3D 보이스 12개, 잔향 절반, 동시 3D 이모트 3개 */
    setQuality(q) {
      quality = q === 'low' ? 'low' : 'high';
      for (const v of pool3) v.p.panningModel = quality === 'low' ? 'equalpower' : 'HRTF';
      refreshEmotes(true);
    },
    getStats() {
      const now = ctx ? ctx.currentTime : 0;
      const count = (pool) => pool.reduce((n, v) => n + (isLive(v, now) ? 1 : 0), 0);
      const held = (pool) => pool.reduce((n, v) => n + (v.h ? 1 : 0), 0);
      return {
        state: ctx ? ctx.state : 'locked', sampleRate: ctx ? ctx.sampleRate : 0, quality,
        voices3d: count(pool3), voices2d: count(pool2), pool3d: pool3.length, pool2d: pool2.length, cached: cache.size,
        variants: [...cache.values()].reduce((n, arr) => n + arr.length, 0), variantsTotal: VARIANTS_TOTAL,
        emotes: emoHandles.size, emoteVoices3d: held(emo3), emoteVoices2d: held(emo2),
        emotePool3d: emo3.length, emotePool2d: emo2.length, emoteCached: emoCache.size,
        emoteSources: emo3.concat(emo2).reduce((n, v) => n + (v.src ? 1 : 0), 0),
        emoteFiles: [...emoFiles.keys()],
        emoteFetched: [...emoRaw.keys()],
        /** 재생 중인 이모트 핸들: 'id:file' 또는 'id:synth' */
        emotePlaying: [...emoHandles].map((h) => `${h.name}:${h.snd.source}`),
        /** 안내 음성: 디코드해 쓸 수 있는 것, 받은 것, 마지막으로 낸 것, 낸 횟수, 지금 나오는 중인가 */
        voiceFiles: [...voiceBuf.keys()],
        voiceFetched: [...voiceRaw.keys()],
        voiceLast, voicePlays,
        voicePlaying: !!(voiceV && voiceV.src && isLive(voiceV, now))
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(prewarmTimer); prewarmTimer = 0;
      for (const h of emoHandles) h.dead = true;
      emoHandles.clear();
      for (const v of emo3.concat(emo2)) {
        if (v.src) { const s = v.src; v.src = null; s.onended = null; try { s.stop(); } catch { /* 무시 */ } try { s.disconnect(); } catch { /* 무시 */ } }
        v.h = null;
        for (const n of [v.g, v.f, v.p, v.send]) if (n) { try { n.disconnect(); } catch { /* 무시 */ } }
      }
      emo3.length = 0; emo2.length = 0; emoCache.clear(); emoSynth.clear(); emoFiles.clear();
      clearTimeout(emoPrefetchTimer); emoPrefetchTimer = 0;
      if (emoAbort) { try { emoAbort.abort(); } catch { /* 무시 */ } emoAbort = null; }
      emoRaw.clear(); emoBuilding.clear();
      if (voiceAbort) { try { voiceAbort.abort(); } catch { /* 무시 */ } voiceAbort = null; }
      if (voiceV) {
        if (voiceV.src) { const s = voiceV.src; voiceV.src = null; s.onended = null; try { s.stop(); } catch { /* 무시 */ } try { s.disconnect(); } catch { /* 무시 */ } }
        for (const n of [voiceV.g, voiceV.f, voiceV.send]) { try { n.disconnect(); } catch { /* 무시 */ } }
        voiceV = null;
      }
      voiceRaw.clear(); voiceBuf.clear(); voiceDecoding.clear();
      for (const v of pool3.concat(pool2)) {
        if (v.src) { try { v.src.stop(); } catch { /* 무시 */ } release(v); }
        for (const n of [v.g, v.f, v.p, v.send]) if (n) { try { n.disconnect(); } catch { /* 무시 */ } }
      }
      for (const n of chainNodes) { try { n.disconnect(); } catch { /* 무시 */ } }
      pool3.length = 0; pool2.length = 0; chainNodes = [];
      cache.clear(); lastVar.clear();
      if (ctx) { const c = ctx; ctx = null; c.close().catch(() => {}); }
    }
  };
}
