/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 자동 플레이 테스트 도구의 브라우저 없는 부분을 시험한다. /skala-fps/ 서버, 설정 덮어쓰기, 키 표, 고정 플래그, 가짜 Supabase의 RPC와 Realtime.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_HEIGHT, MAX_WIDTH, SAFE_FLAGS, keyInfo, withTimeout } from '../tools/qa/browser.mjs';
import { startServer } from '../tools/qa/server.mjs';
import { startFakeSupabase } from '../tools/qa/fake-supabase.mjs';

describe('시험용 정적 서버', () => {
  let server;
  before(async () => { server = await startServer(); });
  after(() => server.close());

  test('/skala-fps/ 아래에서 저장소를 내려준다', async () => {
    const home = await fetch(server.base);
    assert.equal(home.status, 200);
    assert.match(await home.text(), /<title>SKALA FPS<\/title>/);
    const js = await fetch(`${server.base}js/main.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type'), /javascript/);
  });

  test('절대 경로는 404로 드러난다', async () => {
    for (const path of ['/', '/index.html', '/js/main.js', '/css/fps.css']) {
      assert.equal((await fetch(server.url + path)).status, 404, path);
    }
  });

  test('저장소 밖으로 나갈 수 없다', async () => {
    assert.equal((await fetch(`${server.base}..%2f..%2f..%2fpackage.json`)).status, 404);
    assert.equal((await fetch(`${server.base}js/없는파일.js`)).status, 404);
  });

  test('/skala-fps는 GitHub Pages처럼 끝에 /를 붙인다', async () => {
    const r = await fetch(`${server.url}/skala-fps`, { redirect: 'manual' });
    assert.equal(r.status, 301);
    assert.equal(r.headers.get('location'), '/skala-fps/');
  });

  test('js/config.js 내용을 바꿔 줄 수 있다', async () => {
    const plain = await (await fetch(`${server.base}js/config.js`)).text();
    assert.match(plain, /SKALA_CONFIG/);
    server.setConfig('window.SKALA_CONFIG = { qa: true };');
    assert.equal(await (await fetch(`${server.base}js/config.js`)).text(), 'window.SKALA_CONFIG = { qa: true };');
    server.setConfig(null);
    assert.equal(await (await fetch(`${server.base}js/config.js`)).text(), plain);
  });
});

describe('브라우저 도구', () => {
  test('GPU를 쓰지 않는 플래그가 고정돼 있다', () => {
    for (const flag of ['--headless=new', '--disable-gpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio']) {
      assert.ok(SAFE_FLAGS.includes(flag), flag);
    }
    assert.ok(MAX_WIDTH <= 960 && MAX_HEIGHT <= 540);
  });

  test('키 표: e.code → key, keyCode', () => {
    assert.deepEqual(keyInfo('KeyW'), { key: 'w', keyCode: 87 });
    assert.deepEqual(keyInfo('Digit3'), { key: '3', keyCode: 51 });
    assert.deepEqual(keyInfo('Space'), { key: ' ', keyCode: 32 });
    assert.deepEqual(keyInfo('F6'), { key: 'F6', keyCode: 117 });
    assert.deepEqual(keyInfo('Tab'), { key: 'Tab', keyCode: 9 });
    assert.throws(() => keyInfo('없는키'));
  });

  test('withTimeout은 시간이 지나면 이름을 적어 거절한다', async () => {
    await assert.rejects(withTimeout(new Promise(() => {}), 10, '기다리는 일'), /기다리는 일/);
    assert.equal(await withTimeout(Promise.resolve(7), 1000, '금방 끝나는 일'), 7);
  });
});

describe('가짜 Supabase', () => {
  let fake;
  const rpc = async (fn, body) => (await fetch(`${fake.url}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  before(async () => { fake = await startFakeSupabase({ takenNames: ['중복이름'] }); });
  after(() => fake.close());

  test('닉네임과 프로필 RPC', async () => {
    assert.deepEqual(await rpc('fps_check_nickname', { p_name: '중복이름' }), { ok: false, error: 'NAME_TAKEN' });
    assert.deepEqual(await rpc('fps_check_nickname', { p_name: '새이름' }), { ok: true });
    assert.deepEqual(await rpc('fps_get_profile', { p_token: 'a' }), { ok: false, error: 'NOT_FOUND' });
    assert.deepEqual(await rpc('fps_claim_nickname', { p_token: 'a', p_name: '새이름' }), { ok: true, name: '새이름' });
    assert.deepEqual(await rpc('fps_claim_nickname', { p_token: 'b', p_name: '새이름' }), { ok: false, error: 'NAME_TAKEN' });
    assert.deepEqual(await rpc('fps_save_profile', { p_token: 'a', p_points: 7, p_owned: [], p_loadout: {}, p_stats: {}, p_secrets: {} }), { ok: true });
    assert.equal((await rpc('fps_get_profile', { p_token: 'a' })).profile.points, 7);
  });

  test('Realtime: 참가, presence, broadcast', { skip: typeof WebSocket === 'undefined' ? 'Node에 WebSocket이 없다' : false }, async () => {
    const socketUrl = `${fake.url.replace(/^http/, 'ws')}/realtime/v1/websocket?apikey=k&vsn=1.0.0`;
    const open = () => new Promise((res, rej) => {
      const ws = new WebSocket(socketUrl);
      const inbox = [];
      const waiters = [];
      ws.addEventListener('message', (e) => {
        const msg = JSON.parse(e.data);
        const w = waiters.find((x) => x.test(msg));
        if (w) { waiters.splice(waiters.indexOf(w), 1); w.res(msg); } else inbox.push(msg);
      });
      ws.addEventListener('open', () => res({
        send: (m) => ws.send(JSON.stringify(m)),
        close: () => ws.close(),
        next(test) {
          const i = inbox.findIndex(test);
          if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
          return withTimeout(new Promise((r) => waiters.push({ test, res: r })), 3000, '서버 메시지');
        }
      }));
      ws.addEventListener('error', rej);
    });
    const topic = 'realtime:qa';
    const join = (key) => ({ topic, event: 'phx_join', ref: '1', join_ref: '1', payload: { config: { broadcast: { self: false }, presence: { key, enabled: true } } } });
    const a = await open();
    a.send(join('a'));
    const joined = await a.next((m) => m.event === 'phx_reply' && m.ref === '1');
    assert.equal(joined.payload.status, 'ok');
    assert.deepEqual((await a.next((m) => m.event === 'presence_state')).payload, {});

    a.send({ topic, event: 'presence', ref: '2', payload: { type: 'presence', event: 'track', payload: { name: '가' } } });
    assert.equal((await a.next((m) => m.event === 'phx_reply' && m.ref === '2')).payload.status, 'ok');
    const diff = await a.next((m) => m.event === 'presence_diff');
    assert.equal(diff.payload.joins.a.metas[0].name, '가');

    const b = await open();
    b.send(join('b'));
    const state = await b.next((m) => m.event === 'presence_state');
    assert.equal(state.payload.a.metas[0].name, '가');

    b.send({ topic, event: 'broadcast', ref: '3', payload: { type: 'broadcast', event: 'f', payload: { n: 1 } } });
    const got = await a.next((m) => m.event === 'broadcast');
    assert.deepEqual(got.payload, { type: 'broadcast', event: 'f', payload: { n: 1 } });

    a.send({ topic: 'phoenix', event: 'heartbeat', ref: '9', payload: {} });
    assert.equal((await a.next((m) => m.topic === 'phoenix' && m.ref === '9')).payload.status, 'ok');

    b.send({ topic, event: 'presence', ref: '4', payload: { type: 'presence', event: 'track', payload: { name: '나' } } });
    await a.next((m) => m.event === 'presence_diff' && m.payload.joins.b);
    fake.dropAll();
    a.close();
    b.close();
  });
});
