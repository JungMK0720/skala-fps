/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 포털 플랫폼 창구(js/platform)를 시험한다. 포털 판별, 신호 중복 거르기, 판 사이 광고 간격과 게임 중 금지,
 *          보상 광고 직후 중간 광고를 잇지 않는 규칙, 기본 구현이 아무것도 하지 않는지, 채팅 욕설 거르기.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createPlatform, detectPortal, adsWanted, platform, MIDGAME_GAP_MS } from '../js/platform/index.js';
import { createWebPlatform } from '../js/platform/web.js';
import { maskProfanity, hasProfanity } from '../js/core/profanity.js';

/** 호출을 기록하는 가짜 SDK 구현 */
function fakeImpl(over = {}) {
  const calls = [];
  let settingsFn = null;
  const impl = {
    id: 'crazygames', isPortal: true, ready: true, chatAllowed: true, muted: false, adsEnabled: true, adblock: false,
    async init() { calls.push('init'); return true; },
    loadingStart: () => calls.push('loadingStart'), loadingStop: () => calls.push('loadingStop'),
    gameplayStart: () => calls.push('gameplayStart'), gameplayStop: () => calls.push('gameplayStop'),
    happytime: () => calls.push('happytime'),
    async requestAd(type, hooks) {
      calls.push('ad:' + type);
      hooks.start();
      hooks.end();
      return impl.adResult || { ok: true };
    },
    inviteLink: (p) => `https://www.crazygames.com/game/x?roomId=${p.roomId}`,
    inviteParam: () => null, updateRoom() {}, leftRoom() {},
    onSettings(fn) { settingsFn = fn; return () => {}; },
    onJoinRoom() { return () => {}; },
    fire: (s) => settingsFn && settingsFn(s),
    calls,
    ...over
  };
  return impl;
}
const noBlock = { show() {}, hide() {} };

describe('포털 판별', () => {
  test('쿼리·빌드 설정·crazygames.com 주소에서만 CrazyGames다', () => {
    assert.equal(detectPortal({ hostname: 'example.io', search: '?portal=crazygames' }), 'crazygames');
    assert.equal(detectPortal({ hostname: 'example.io', config: { portal: { id: 'crazygames' } } }), 'crazygames');
    assert.equal(detectPortal({ hostname: 'skala-fps-io.game-files.crazygames.com' }), 'crazygames');
    assert.equal(detectPortal({ hostname: 'crazygames.com' }), 'crazygames');
    assert.equal(detectPortal({ hostname: 'notcrazygames.com' }), '');
    assert.equal(detectPortal({ hostname: 'crazygames.com.evil.io' }), '');
    assert.equal(detectPortal({ hostname: 'jungmk0720.github.io', search: '?portal=poki' }), '');
  });

  test('광고는 정식 출시 제출본(ads=1 또는 빌드 설정)에서만 켠다', () => {
    assert.equal(adsWanted({ search: '?portal=crazygames' }), false);
    assert.equal(adsWanted({ search: '?portal=crazygames&ads=1' }), true);
    assert.equal(adsWanted({ config: { portal: { id: 'crazygames', ads: 'on' } } }), true);
  });

  test('node(브라우저 아님)에서는 기본 구현이고 모든 호출이 조용히 끝난다', async () => {
    assert.equal(platform.isPortal, false);
    assert.equal(platform.chatAllowed, true);
    assert.equal(platform.rewardedAvailable, false);
    assert.equal(await platform.init(), false);
    platform.loadingStart(); platform.loadingStop(); platform.gameplayStart(); platform.gameplayStop();
    assert.equal(await platform.midgameAd(), false);
    assert.equal(await platform.rewardedAd(), false);
    assert.equal(platform.inviteLink('abc'), null);
    const web = createWebPlatform();
    assert.deepEqual(await web.requestAd('midgame', {}), { ok: false, code: 'unavailable' });
  });
});

describe('공통 규칙', () => {
  test('로딩·게임플레이 신호는 상태가 바뀔 때만 보낸다', () => {
    const impl = fakeImpl();
    const p = createPlatform(impl, { blocker: noBlock });
    p.loadingStart(); p.loadingStart(); p.loadingStop(); p.loadingStop();
    p.gameplayStart(); p.gameplayStart(); p.gameplayStop(); p.gameplayStop(); p.gameplayStart();
    assert.deepEqual(impl.calls, ['loadingStart', 'loadingStop', 'gameplayStart', 'gameplayStop', 'gameplayStart']);
  });

  test('중간 광고는 게임 중에 요청하지 않고 3분에 한 번만, 광고가 실제로 시작될 때만 멈춤 훅을 부른다', async () => {
    let clock = 1000;
    const impl = fakeImpl();
    const p = createPlatform(impl, { now: () => clock, blocker: noBlock });
    const hooks = [];
    p.setAdHooks({ pause: (type) => hooks.push('pause:' + type), resume: (type) => hooks.push('resume:' + type) });
    p.gameplayStart();
    assert.equal(await p.midgameAd(), false, '게임 중');
    p.gameplayStop();
    assert.equal(await p.midgameAd(), true);
    clock += MIDGAME_GAP_MS - 1;
    assert.equal(await p.midgameAd(), false, '3분 안');
    clock += 1;
    assert.equal(await p.midgameAd(), true);
    assert.deepEqual(hooks, ['pause:midgame', 'resume:midgame', 'pause:midgame', 'resume:midgame']);
    assert.equal(impl.calls.filter((c) => c === 'ad:midgame').length, 2);
  });

  test('보상 광고를 본 직후에는 중간 광고를 잇지 않고, 오류면 보상하지 않는다', async () => {
    let clock = 0;
    const impl = fakeImpl();
    const p = createPlatform(impl, { now: () => clock, blocker: noBlock });
    assert.equal(await p.rewardedAd(), true);
    assert.equal(await p.midgameAd(), false, '광고 연달아 금지');
    impl.adResult = { ok: false, code: 'unfilled' };
    clock += MIDGAME_GAP_MS;
    assert.equal(await p.rewardedAd(), false);
    assert.equal(p.lastAdError, 'unfilled');
  });

  test('광고를 쓰지 않는 제출본(기본 출시)과 광고 차단기면 보상 단추를 보이지 않는다', async () => {
    const off = createPlatform(fakeImpl({ adsEnabled: false }), { blocker: noBlock });
    assert.equal(off.rewardedAvailable, false);
    assert.equal(off.rewardedBlocked, false);
    assert.equal(await off.midgameAd(), false);
    const blocked = createPlatform(fakeImpl({ adblock: true }), { blocker: noBlock });
    assert.equal(blocked.rewardedAvailable, false);
    assert.equal(blocked.rewardedBlocked, true);
    assert.equal(await blocked.rewardedAd(), false);
  });

  test('SDK 설정이 바뀌면 onChange로 알리고 초대 링크에 방 id를 넣는다', () => {
    const impl = fakeImpl();
    const p = createPlatform(impl, { blocker: noBlock });
    let seen = 0;
    p.onChange(() => seen++);
    impl.fire({ disableChat: true });
    assert.equal(seen, 1);
    assert.match(p.inviteLink('ab12cd34'), /roomId=ab12cd34$/);
    assert.equal(p.inviteLink(''), null);
  });
});

describe('채팅 욕설 거르기', () => {
  test('영어·한국어 욕설을 같은 길이로 가리고 평범한 낱말은 둔다', () => {
    assert.equal(maskProfanity('what the fuck'), 'what the ****');
    assert.equal(maskProfanity('sh1t happens'), '**** happens');
    assert.equal(maskProfanity('f u c k'), '* * * *');
    assert.equal(maskProfanity('이 병.신아'), '이 ***아');
    assert.equal(maskProfanity('ㅅㅂ 진짜'), '** 진짜');
    for (const ok of ['good game', 'class assignment', 'assassin', 'cocktail', 'Scunthorpe', '시발점에서 출발', 'grass']) assert.equal(maskProfanity(ok), ok, ok);
    assert.equal(hasProfanity('nice shot'), false);
    assert.equal(hasProfanity('you bitch'), true);
  });
});

describe('CrazyGames 제출본 만들기(tools/build-site.mjs --portal crazygames)', () => {
  test('SDK 태그는 게임 코드보다 앞에, 포털 설정은 config 끝에 한 번만 들어간다', async () => {
    const { addSdkTag, addPortalConfig, PORTAL_SDK_TAG, PORTAL_SHIPPED } = await import('../tools/build-site.mjs');
    const { readFileSync } = await import('node:fs');
    const html = addSdkTag(readFileSync(new URL('../index.html', import.meta.url), 'utf8'));
    assert.ok(html.indexOf(PORTAL_SDK_TAG) > 0 && html.indexOf(PORTAL_SDK_TAG) < html.indexOf('<script src="js/config.js"'));
    assert.equal(addSdkTag(html), html, '두 번 넣지 않는다');
    const cfg = addPortalConfig(readFileSync(new URL('../js/config.js', import.meta.url), 'utf8'), true);
    const win = {};
    new Function('window', cfg)(win);
    assert.deepEqual(win.SKALA_CONFIG.portal, { id: 'crazygames', ads: 'on' });
    assert.equal(detectPortal({ hostname: 'example.io', config: win.SKALA_CONFIG }), 'crazygames');
    assert.throws(() => addPortalConfig(cfg, false), /이미/);
    for (const banned of ['_headers', '.nojekyll', 'docs', 'tests', 'tools', 'server', 'dev']) assert.ok(!PORTAL_SHIPPED.includes(banned), banned);
  });

  test('zip은 표준 도구가 읽을 수 있는 모양이다(지역 머리·중앙 목록·끝 기록)', async () => {
    const { makeZip } = await import('../tools/build-site.mjs');
    const { inflateRawSync } = await import('node:zlib');
    const data = Buffer.from('hello hello hello hello'.repeat(10));
    const zip = makeZip([{ name: 'a/b.txt', data }, { name: 'c.txt', data: Buffer.from('x') }]);
    assert.equal(zip.readUInt32LE(0), 0x04034b50);
    const end = zip.length - 22;
    assert.equal(zip.readUInt32LE(end), 0x06054b50);
    assert.equal(zip.readUInt16LE(end + 10), 2);
    const nameLen = zip.readUInt16LE(26), size = zip.readUInt32LE(18);
    assert.equal(zip.toString('utf8', 30, 30 + nameLen), 'a/b.txt');
    assert.deepEqual(inflateRawSync(zip.subarray(30 + nameLen, 30 + nameLen + size)), data);
  });
});
