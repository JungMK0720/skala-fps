/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 전체 공지(js/net/notice.js)를 시험한다. 본문 정리와 나누기, 서명과 검증(고친 줄·다른 열쇠·지난 줄 거절), 중계 서버 규칙과의 약속,
 *          Node 중계 서버에 실제 받는 쪽·보내는 쪽을 붙인 전체 흐름(보내기, 늦게 온 화면, 바꾸기, 내리기, 가짜 줄 무시), 열쇠 도구.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NET } from '../js/core/consts.js';
import { RealtimeSocket } from '../js/net/realtime.js';
import { HUB_HEARTBEAT_REF, HUB_PRESENCE_LIMIT, hubEndpoint } from '../js/net/hubsocket.js';
import { connect } from '../js/net/index.js';
import {
  NOTICE, NOTICE_VIEWER_FIELD, cleanNoticeText, splitNoticeText, toBase64Url, fromBase64Url,
  generateNoticeKeys, importNoticePublicKey, importNoticePrivateKey, noticeKeysMatch, findNoticePrivateKey,
  signNotice, readNoticeLine, verifyNotice, noticeShowMs, createNoticeFeed, createNoticeSender
} from '../js/net/notice.js';
import * as R from '../server/relay/src/rules.js';
import { startRelay } from '../server/relay/src/node.js';
import { keyFileText, publicKeyOf } from '../tools/make-notice-key.mjs';

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
async function until(fn, ms = 4000, label = '조건') {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`시간 안에 되지 않았다: ${label}`);
    await sleep(15);
  }
}
const LS = String.fromCharCode(0x2028);       // 줄 구분 문자(소스에 직접 적지 않는다)
const NUL = String.fromCharCode(0);
const GRIN = String.fromCodePoint(0x1f600);   // 두 단위짜리 글자

const keys = await generateNoticeKeys();
const other = await generateNoticeKeys();
const pub = await importNoticePublicKey(keys.publicKey);
const priv = await importNoticePrivateKey(keys.privateKey);
const otherPriv = await importNoticePrivateKey(other.privateKey);
const NOW = 1_800_000_000_000;

/* ---------------- 본문 ---------------- */

test('본문 정리: 한 줄로 만들고 제어 문자를 빼고 200자에서 자른다', () => {
  assert.equal(cleanNoticeText(`  오늘 밤 9시에\n\t팀전  합니다!${NUL}${LS} `), '오늘 밤 9시에 팀전 합니다!');
  assert.equal(cleanNoticeText(null), '');
  assert.equal(cleanNoticeText(undefined), '');
  assert.equal(cleanNoticeText(123), '123');
  assert.equal(cleanNoticeText('가'.repeat(300)).length, NOTICE.MAX_TEXT);
  // 두 단위짜리 글자의 가운데에서 자르지 않는다
  const cut = cleanNoticeText('가'.repeat(199) + GRIN);
  assert.equal(cut, '가'.repeat(199));
  // 조합형 한글은 완성형으로 맞춘다(서명 대상이 보내는 쪽과 받는 쪽에서 같아야 한다)
  assert.equal(cleanNoticeText('한'.normalize('NFD')), '한');
});

test('본문 나누기: 토막마다 100단위까지, 글자 가운데에서 자르지 않고, 이으면 원래 글자다', () => {
  assert.deepEqual(splitNoticeText(''), []);
  assert.deepEqual(splitNoticeText('짧은 공지'), ['짧은 공지']);
  const long = cleanNoticeText('가나다라마바사아자차'.repeat(20));
  const parts = splitNoticeText(long);
  assert.deepEqual(parts.map((p) => p.length), [100, 100]);
  assert.equal(parts.join(''), long);
  const emoji = cleanNoticeText(GRIN.repeat(100));            // 200단위, 토막 경계가 글자 사이에 온다
  const eparts = splitNoticeText(emoji);
  assert.equal(eparts.join(''), emoji);
  for (const p of eparts) assert.ok(p.length <= NOTICE.CHUNK && p.length % 2 === 0, `토막 ${p.length}`);
  const odd = cleanNoticeText('가' + GRIN.repeat(99) + '나');   // 경계에서 한 단위씩 밀린다 → 세 토막
  const oparts = splitNoticeText(odd);
  assert.equal(oparts.length, 3);
  assert.equal(oparts.join(''), odd);
  assert.equal(splitNoticeText('가'.repeat(301)), null, '세 토막에 안 들어가면 null');
});

test('base64url 왕복과 잘못된 글자', () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
  const text = toBase64Url(bytes);
  assert.match(text, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual([...fromBase64Url(text)], [...bytes]);
  assert.equal(fromBase64Url('한글'), null);
  assert.equal(fromBase64Url(''), null);
  assert.equal(fromBase64Url('a+b/c='), null);
});

/* ---------------- 열쇠 ---------------- */

test('열쇠: 공개 열쇠는 87자, 짝이 맞는지 확인하고, 틀린 글자는 거절한다', async () => {
  assert.equal(keys.publicKey.length, 87);
  assert.ok(keys.privateKey.length > 150);
  assert.equal(await noticeKeysMatch(priv, pub), true);
  assert.equal(await noticeKeysMatch(otherPriv, pub), false);
  assert.equal(await noticeKeysMatch(null, pub), false);
  await assert.rejects(importNoticePublicKey('AAAA'), /모양이 틀립니다/);
  await assert.rejects(importNoticePublicKey(keys.privateKey), /모양이 틀립니다/);
  await assert.rejects(importNoticePrivateKey('짧다'), /모양이 틀립니다/);
  await assert.rejects(importNoticePrivateKey('A'.repeat(200)), /읽을 수 없습니다/);
  assert.equal(priv.extractable, false, '기본은 꺼낼 수 없는 열쇠다');
});

test('열쇠 파일: 설명 줄이 섞여 있어도 비밀 열쇠를 찾고, 공개 열쇠를 다시 구한다', async () => {
  const file = keyFileText({ ...keys, date: '2026-11-11' });
  assert.ok(file.includes(keys.privateKey) && file.includes(keys.publicKey));
  assert.equal(findNoticePrivateKey(file), keys.privateKey);
  assert.equal(findNoticePrivateKey(`  ${keys.privateKey}\n`), keys.privateKey);
  assert.equal(findNoticePrivateKey('열쇠가 없는 글'), '');
  assert.equal(findNoticePrivateKey(keys.publicKey), '', '공개 열쇠는 비밀 열쇠로 치지 않는다');
  assert.equal(await publicKeyOf(keys.privateKey), keys.publicKey);
});

test('열쇠 도구: 비밀 열쇠는 파일에만 쓰고 화면에는 공개 열쇠만 찍는다. 있는 파일은 덮어쓰지 않는다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skala-notice-'));
  const out = join(dir, 'sub', 'key.txt');
  const tool = fileURLToPath(new URL('../tools/make-notice-key.mjs', import.meta.url));
  const run = (...args) => execFileSync(process.execPath, [tool, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const printed = run('--out', out);
    const priv2 = findNoticePrivateKey(readFileSync(out, 'utf8'));
    assert.ok(priv2.length > 150);
    assert.ok(!printed.includes(priv2), '비밀 열쇠를 화면에 찍지 않는다');
    const pub2 = (printed.match(/공개 열쇠: ([A-Za-z0-9_-]{87})/) || [])[1];
    assert.ok(pub2, printed);
    assert.ok(readFileSync(out, 'utf8').includes(pub2));
    assert.throws(() => run('--out', out), /이미 있습니다/);
    assert.equal(findNoticePrivateKey(readFileSync(out, 'utf8')), priv2, '거절했으면 파일은 그대로다');
    assert.ok(run('--public-of', out).includes(pub2));
    run('--out', out, '--force');
    assert.notEqual(findNoticePrivateKey(readFileSync(out, 'utf8')), priv2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------------- 서명과 검증 ---------------- */

test('서명한 줄은 그대로 확인되고, 한 글자라도 고치면 거절된다', async () => {
  const line = await signNotice(priv, { text: '  서버 점검: 10분 뒤 다시 시작합니다  ', ttl: 60, at: NOW });
  assert.deepEqual(Object.keys(line).sort(), ['at', 'id', 'k', 'nv', 'sig', 't0', 'ttl']);
  assert.equal(line.t0, '서버 점검: 10분 뒤 다시 시작합니다');
  assert.match(line.sig, /^[A-Za-z0-9_-]{86}$/);
  const ok = await verifyNotice(pub, line, NOW + 1000);
  assert.deepEqual(ok, { ok: true, notice: { id: line.id, at: NOW, ttl: 60, kind: 'n', text: '서버 점검: 10분 뒤 다시 시작합니다', until: NOW + 60000 } });
  const bad = async (patch) => (await verifyNotice(pub, { ...line, ...patch }, NOW + 1000)).reason;
  assert.equal(await bad({ t0: '서버 점검: 10분 뒤 다시 시작합니다!' }), 'signature');
  assert.equal(await bad({ ttl: 61 }), 'signature');
  assert.equal(await bad({ at: NOW + 1 }), 'signature');
  assert.equal(await bad({ id: 'aaaaaaaaaa' }), 'signature');
  assert.equal(await bad({ k: 'x' }), 'format', '내리기 줄에는 본문이 없어야 한다');
  assert.equal(await bad({ t1: '덧붙임' }), 'signature');
  // 서명 글자를 하나 바꾼다. 첫 글자는 서명의 첫 바이트를 바꾸므로 서명이 틀려진다
  assert.equal(await bad({ sig: (line.sig[0] === 'A' ? 'B' : 'A') + line.sig.slice(1) }), 'signature');
  // 마지막 글자는 2비트만 서명이고 4비트는 남는 자리다. 남는 자리만 바꾼 글자(같은 서명의 다른 표기)도 받지 않는다
  const twin = { A: 'B', Q: 'R', g: 'h', w: 'x' }[line.sig.slice(-1)];
  assert.ok(twin, `서명의 마지막 글자는 A·Q·g·w 가운데 하나다: ${line.sig.slice(-1)}`);
  assert.equal(await bad({ sig: line.sig.slice(0, -1) + twin }), 'format');
  // 마지막 글자의 서명 비트를 바꾸면 서명이 틀려진다
  assert.equal(await bad({ sig: line.sig.slice(0, -1) + (line.sig.endsWith('A') ? 'Q' : 'A') }), 'signature');
  // 다른 열쇠로 서명한 줄
  const forged = await signNotice(otherPriv, { text: '가짜 공지', ttl: 60, at: NOW });
  assert.deepEqual(await verifyNotice(pub, forged, NOW), { ok: false, reason: 'signature' });
});

test('긴 본문은 토막으로 나눠 싣고 다시 이어서 확인한다', async () => {
  const text = cleanNoticeText(('공지 ' + GRIN + ' "따옴표" \\ ').repeat(20));
  assert.equal(text.length <= NOTICE.MAX_TEXT, true);
  const line = await signNotice(priv, { text, ttl: 30, at: NOW });
  assert.ok(line.t1, '두 토막 이상');
  for (const k of ['t0', 't1', 't2']) if (line[k] !== undefined) assert.ok(line[k].length <= NOTICE.CHUNK);
  const r = await verifyNotice(pub, line, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.notice.text, text);
});

test('유효 시간: 지난 줄과 앞선 줄은 거절하고, 시계 차이 5분까지 봐준다', async () => {
  const line = await signNotice(priv, { text: '30초짜리', ttl: 30, at: NOW });
  const at = async (dt) => verifyNotice(pub, line, NOW + dt);
  assert.equal((await at(0)).ok, true);
  assert.equal((await at(29000)).ok, true);
  assert.equal(NOTICE.SKEW_MS, 5 * 60 * 1000);
  assert.equal((await at(30000 + NOTICE.SKEW_MS - 1)).ok, true, '받는 PC 시계가 5분 빠른 경우');
  assert.equal((await at(30000 + NOTICE.SKEW_MS)).reason, 'expired');
  assert.equal((await at(-NOTICE.SKEW_MS)).ok, true, '받는 PC 시계가 5분 느린 경우');
  assert.equal((await at(-NOTICE.SKEW_MS - 1)).reason, 'future');
  // 띄울 시간: 바로 받으면 전부, 늦게 받으면 남은 만큼, 그래도 4초는 띄운다
  const n = (await at(0)).notice;
  assert.equal(noticeShowMs(n, NOW), 30000);
  assert.equal(noticeShowMs(n, NOW + 12000), 18000);
  assert.equal(noticeShowMs(n, NOW + 29500), NOTICE.MIN_SHOW_MS);
  assert.equal(noticeShowMs(n, NOW - 60000), 30000, '받는 PC 시계가 느려도 정한 시간보다 길게 띄우지 않는다');
});

test('시간 범위와 내리기 줄', async () => {
  assert.equal((await signNotice(priv, { text: '가', ttl: 1, at: NOW })).ttl, NOTICE.MIN_TTL);
  assert.equal((await signNotice(priv, { text: '가', ttl: 99999, at: NOW })).ttl, NOTICE.MAX_TTL);
  assert.equal((await signNotice(priv, { text: '가', at: NOW })).ttl, NOTICE.DEFAULT_TTL);
  await assert.rejects(signNotice(priv, { text: '   ', at: NOW }), /비어 있습니다/);
  await assert.rejects(signNotice(priv, { text: '가', id: 'BAD ID', at: NOW }), /이름이 틀립니다/);
  const first = await signNotice(priv, { text: '내릴 공지', ttl: 600, at: NOW });
  const off = await signNotice(priv, { kind: 'x', id: first.id, ttl: NOTICE.RETRACT_TTL, at: NOW + 5000, text: '무시되는 본문' });
  assert.deepEqual([off.k, off.id, off.t0], ['x', first.id, undefined]);
  const r = await verifyNotice(pub, off, NOW + 6000);
  assert.equal(r.ok, true);
  assert.deepEqual([r.notice.kind, r.notice.id, r.notice.text], ['x', first.id, '']);
});

test('모양이 틀린 줄은 서명을 보기 전에 버린다', async () => {
  const line = await signNotice(priv, { text: '정상', ttl: 30, at: NOW });
  assert.ok(readNoticeLine(line));
  const no = (patch) => assert.equal(readNoticeLine({ ...line, ...patch }), null, JSON.stringify(patch));
  no({ nv: 2 }); no({ nv: '1' }); no({ id: 'Abc' }); no({ id: 'x' }); no({ at: '1' }); no({ at: 1.5 }); no({ at: -1 });
  no({ ttl: 4 }); no({ ttl: 3601 }); no({ ttl: 30.5 }); no({ k: 'z' }); no({ sig: 'short' }); no({ sig: 1 });
  no({ t0: 1 }); no({ t0: '가'.repeat(101) }); no({ t0: ' 앞에 공백' }); no({ t0: '줄\n바꿈' }); no({ t0: '' });
  assert.equal(readNoticeLine(null), null);
  assert.equal(readNoticeLine({ roomId: 'abc', name: '방' }), null, '방 목록 줄은 공지가 아니다');
});

/* ---------------- 중계 서버와의 약속 ---------------- */

test('공지 줄과 자리 표시는 중계 서버의 presence 규칙을 그대로 통과한다(잘리거나 빠지는 칸이 없다)', async () => {
  const worst = cleanNoticeText('"\\'.repeat(100));                       // JSON으로 쓰면 글자마다 두 배가 된다
  for (const text of ['짧은 공지', cleanNoticeText('가'.repeat(200)), cleanNoticeText(GRIN.repeat(100)), worst]) {
    const line = await signNotice(priv, { text, ttl: 30, at: NOW });
    const c = R.cleanMeta(line, { key: 'notice-abcdefghij', kind: 'lobby' });
    assert.equal(c.error, undefined);
    assert.deepEqual(c.meta, line);
    assert.ok(c.json.length <= R.LIMITS.maxMetaChars, `한 줄 ${c.json.length}자`);
    for (const v of Object.values(line)) if (typeof v === 'string') assert.ok(v.length <= R.LIMITS.maxFieldChars);
  }
  assert.deepEqual(R.cleanMeta({ [NOTICE_VIEWER_FIELD]: 1 }, { key: 'nfabc', kind: 'lobby' }).meta, { nf: 1 });
  assert.ok(R.isKey('notice-abcdefghij') && R.isKey('nfabcdefghijkl'));
});

/* ---------------- 전체 흐름(Node 중계 서버) ---------------- */

/** 아무 줄이나 로비 허브의 presence에 올리는 연결(남이 올리는 가짜·베낀 줄) */
async function rawTracker(url, key) {
  const sock = new RealtimeSocket({ endpoint: hubEndpoint(url, NET.LOBBY_CHANNEL), heartbeatRef: HUB_HEARTBEAT_REF, presenceLimit: { ...HUB_PRESENCE_LIMIT } });
  const ch = sock.channel(NET.LOBBY_CHANNEL, { presence: true, presenceKey: key });
  sock.start();
  await ch.join({ timeoutMs: 5000 });
  return { track: (line) => ch.track(line), untrack: () => ch.untrack(), close: () => sock.close() };
}

function feedOn(url, opts = {}) {
  const events = [];
  const feed = createNoticeFeed({ url, publicKey: keys.publicKey, onShow: (n) => events.push(['show', n]), onHide: (id) => events.push(['hide', id]), ...opts });
  feed.start();
  return { feed, events, shows: () => events.filter((e) => e[0] === 'show').map((e) => e[1]), hides: () => events.filter((e) => e[0] === 'hide').map((e) => e[1]) };
}

test('보낸 공지가 접속한 모든 화면에 뜨고, 늦게 온 화면은 남은 시간만큼 띄운다. 바꾸기와 내리기도 전달된다', async () => {
  const relay = await startRelay({ port: 0 });
  const open = [];
  try {
    // b는 시계가 90초 빠른 PC다
    const a = feedOn(relay.url), b = feedOn(relay.url, { now: () => Date.now() + 90000 });
    open.push(a.feed, b.feed);
    const sender = createNoticeSender({ url: relay.url, privateKey: priv });
    open.push({ dispose: () => sender.close() });
    const seen = [];
    sender.on('viewers', (n) => seen.push(n));
    await sender.open(5000);
    await until(() => sender.viewers === 2, 4000, '받는 화면 둘이 보인다');
    assert.equal(sender.connected, true);
    assert.ok(seen.includes(2));

    const t0 = Date.now();
    const sent = await sender.send({ text: '  오늘 밤 9시에\n팀전 한 판 합니다!  ', ttl: 30 });
    assert.equal(sent.ok, true);
    assert.equal(sent.notice.text, '오늘 밤 9시에 팀전 한 판 합니다!');
    await until(() => a.shows().length === 1 && b.shows().length === 1, 4000, '두 화면에 뜬다');
    for (const f of [a, b]) {
      const n = f.shows()[0];
      assert.equal(n.text, '오늘 밤 9시에 팀전 한 판 합니다!');
      assert.equal(n.id, sent.notice.id);
      assert.equal(n.ms, 30000, '방금 올라온 공지는 이 PC의 시계가 틀려도 정한 시간을 다 띄운다');
    }
    assert.deepEqual(sender.current.text, '오늘 밤 9시에 팀전 한 판 합니다!');

    // 늦게 접속한 화면: 올려 둔 줄을 받아 남은 시간만큼 띄운다
    await sleep(300);
    const late = feedOn(relay.url);
    open.push(late.feed);
    await until(() => late.shows().length === 1, 4000, '늦게 온 화면에도 뜬다');
    assert.ok(late.shows()[0].ms < 30000 - 250 && late.shows()[0].ms > 25000, `남은 시간 ${late.shows()[0].ms}`);
    assert.equal(late.feed.state().connected, true);

    // 다시 연결돼 같은 줄을 또 받아도 한 번만 띄운다
    relay.dropAll();
    await until(() => sender.connected && sender.viewers === 3, 8000, '다시 연결');
    await sleep(300);
    assert.equal(a.shows().length, 1);

    // 새 공지로 바꾼다
    const second = await sender.send({ text: '시간이 바뀌었어요: 10시', ttl: 20 });
    assert.equal(second.ok, true);
    assert.notEqual(second.notice.id, sent.notice.id);
    // 세 화면 모두 띄운 뒤에 내린다(아직 서명을 확인하는 중인 화면은 내리기 줄을 먼저 보면 그 공지를 아예 띄우지 않는다. 아래 시험)
    await until(() => a.shows().length === 2 && b.shows().length === 2 && late.shows().length === 2, 4000, '바뀐 공지가 뜬다');
    assert.equal(a.shows()[1].text, '시간이 바뀌었어요: 10시');

    // 내린다: 떠 있던 화면에서 사라지고, 그 뒤 접속한 화면에는 뜨지 않는다
    const off = await sender.retract();
    assert.deepEqual([off.ok, off.id], [true, second.notice.id]);
    await until(() => a.hides().length === 1 && b.hides().length === 1 && late.hides().length === 1, 4000, '모든 화면에서 내려간다');
    assert.deepEqual(a.hides(), [second.notice.id]);
    assert.equal(sender.current, null);
    assert.deepEqual((await sender.retract()).status, 'none');
    const after = feedOn(relay.url);
    open.push(after.feed);
    await sleep(500);
    assert.equal(after.shows().length, 0);
    assert.ok(Date.now() - t0 < 20000);
  } finally {
    for (const f of open) f.dispose();
    await relay.close();
  }
});

test('내리기 줄과 공지 줄을 같이 받으면 그 공지는 떠 있지 않는다', async () => {
  const relay = await startRelay({ port: 0 });
  const closers = [];
  try {
    // 1) 두 줄이 이미 올라와 있는 허브에 접속한 화면: 내리기 줄을 먼저 보고 공지는 아예 띄우지 않는다
    const one = await rawTracker(relay.url, 'copy0001'), two = await rawTracker(relay.url, 'copy0002');
    closers.push(() => one.close(), () => two.close());
    const real = await signNotice(priv, { text: '곧 내릴 공지', ttl: 60 });
    const off = await signNotice(priv, { kind: 'x', id: real.id, ttl: NOTICE.RETRACT_TTL });
    assert.equal(await one.track(real), 'ok');
    assert.equal(await two.track(off), 'ok');
    const late = feedOn(relay.url);
    closers.push(() => late.feed.dispose());
    await until(() => late.feed.state().connected, 4000, '받는 화면 연결');
    await sleep(500);
    assert.deepEqual([late.shows().length, late.hides().length], [0, 0]);
    assert.equal(late.feed.state().current, null);

    // 2) 서명을 확인하는 사이에 내리기 줄이 온 화면(열쇠를 늦게 받는다): 잠깐 떴다가 내려가거나 아예 뜨지 않는다. 끝나면 떠 있지 않다
    let giveKey = null;
    const slowKey = new Promise((resolve) => { giveKey = resolve; });
    const slow = feedOn(relay.url, { publicKey: slowKey });
    closers.push(() => slow.feed.dispose());
    await until(() => slow.feed.state().connected, 4000, '느린 화면 연결');
    const sender = createNoticeSender({ url: relay.url, privateKey: priv });
    closers.push(() => sender.close());
    await sender.open(5000);
    const sent = await sender.send({ text: '보내자마자 내리는 공지', ttl: 60 });
    assert.equal(sent.ok, true);
    await sleep(150);
    assert.equal((await sender.retract()).ok, true);
    await sleep(150);
    assert.equal(slow.shows().length, 0, '열쇠를 받기 전에는 아무것도 띄우지 않는다');
    giveKey(pub);
    await sleep(500);
    const mine = slow.shows().filter((n) => n.id === sent.notice.id).length;
    assert.ok(mine <= 1);
    assert.equal(slow.hides().filter((id) => id === sent.notice.id).length, mine, '떴다면 내려갔다');
    assert.equal(slow.feed.state().current, null, '끝나면 떠 있지 않다');
  } finally {
    for (const c of closers) c();
    await relay.close();
  }
});

test('남이 올린 줄은 뜨지 않는다: 다른 열쇠, 고친 줄, 지난 줄을 베낀 것, 내린 공지를 베낀 것', async () => {
  const relay = await startRelay({ port: 0 });
  const closers = [];
  try {
    const a = feedOn(relay.url);
    closers.push(() => a.feed.dispose());
    await until(() => a.feed.state().connected, 4000, '받는 화면 연결');
    const evil = await rawTracker(relay.url, 'evil0001');
    closers.push(() => evil.close());

    assert.equal(await evil.track(await signNotice(otherPriv, { text: '가짜 운영자 공지', ttl: 60 })), 'ok');   // 서버는 받아 준다
    await sleep(250);
    const real = await signNotice(priv, { text: '진짜 공지', ttl: 60 });
    assert.equal(await evil.track({ ...real, t0: '고친 공지' }), 'ok');
    await sleep(250);
    assert.equal(await evil.track(await signNotice(priv, { text: '한참 지난 공지', ttl: 30, at: Date.now() - 10 * 60 * 1000 })), 'ok');
    await sleep(250);
    assert.equal(await evil.track({ nv: 1, id: 'junkjunk01', at: Date.now(), ttl: 30, k: 'n', t0: '서명 없는 줄', sig: 'A'.repeat(86) }), 'ok');
    await sleep(250);
    assert.deepEqual(a.shows(), [], '어느 것도 뜨지 않는다');

    // 진짜 줄을 그대로 베껴 올리면 뜬다(내용도 시간도 운영자가 정한 그대로다). 그래도 한 번만 뜬다
    assert.equal(await evil.track(real), 'ok');
    await until(() => a.shows().length === 1, 4000, '베낀 진짜 줄');
    assert.equal(a.shows()[0].text, '진짜 공지');

    // 운영자가 내린 뒤에는 베낀 줄을 다시 올려도 이 화면에는 뜨지 않는다
    const off = await signNotice(priv, { kind: 'x', id: real.id, ttl: NOTICE.RETRACT_TTL });
    assert.equal(await evil.track(off), 'ok');
    await until(() => a.hides().length === 1, 4000, '내리기 줄');
    assert.equal(await evil.track(real), 'ok');
    await sleep(300);
    assert.equal(a.shows().length, 1);
  } finally {
    for (const c of closers) c();
    await relay.close();
  }
});

test('공지 줄과 자리 표시는 게임의 방 목록에 섞이지 않는다', async () => {
  const relay = await startRelay({ port: 0 });
  let net = null, sender = null, feed = null;
  try {
    net = await connect({ transport: 'relay', relayUrl: relay.url, playerId: 'p1', name: '하나' });
    const lists = [];
    net.lobby.subscribe((rooms, info) => lists.push({ rooms, synced: info.synced }));
    feed = feedOn(relay.url).feed;
    sender = createNoticeSender({ url: relay.url, privateKey: () => priv });
    await sender.open(5000);
    assert.equal((await sender.send({ text: '방 목록에는 안 보이는 줄', ttl: 30 })).ok, true);
    await until(() => net.lobby.synced, 4000, '로비 동기화');
    await sleep(300);
    assert.deepEqual(net.lobby.rooms(), []);
    assert.ok(lists.every((l) => l.rooms.length === 0));
    // 방을 만들면 그 방만 보인다
    const room = await net.createRoom({ name: '방 1', mapId: 'lot', max: 4, mode: 'ffa', ruleset: 'classic' });
    await until(() => net.lobby.rooms().length === 1, 4000, '방 목록에 방 하나');
    assert.equal(net.lobby.rooms()[0].roomId, room.id);
    await until(() => sender.viewers === 1, 4000, '게임 화면 하나가 보인다');
    await sleep(200);
    assert.equal(sender.viewers, 1, '방을 만든 연결은 접속자 수에 들어가지 않는다(게임 화면 하나)');
  } finally {
    if (sender) sender.close();
    if (feed) feed.dispose();
    if (net) await net.close();
    await relay.close();
  }
});

test('열쇠가 없으면 보내지 못하고, 서명을 쓸 수 없는 설정이면 받는 쪽이 조용히 꺼진다', async () => {
  const relay = await startRelay({ port: 0 });
  try {
    let key = null;
    const sender = createNoticeSender({ url: relay.url, privateKey: () => key });
    await sender.open(5000);
    await assert.rejects(sender.send({ text: '열쇠 없이', ttl: 30 }), /운영자 열쇠가 없습니다/);
    key = priv;
    assert.equal((await sender.send({ text: '열쇠를 넣은 뒤', ttl: 30 })).ok, true);
    sender.close();
    // 공개 열쇠 글자가 틀리면 아무것도 띄우지 않고 예외도 내지 않는다
    const shown = [];
    const feed = createNoticeFeed({ url: relay.url, publicKey: 'not-a-key', onShow: (n) => shown.push(n) });
    feed.start();
    const other2 = createNoticeSender({ url: relay.url, privateKey: priv });
    await other2.open(5000);
    await other2.send({ text: '보이지 않는 공지', ttl: 30 });
    await sleep(400);
    assert.deepEqual(shown, []);
    feed.dispose();
    other2.close();
  } finally {
    await relay.close();
  }
});
