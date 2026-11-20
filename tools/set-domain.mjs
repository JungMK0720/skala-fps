/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 도메인 이전의 정적 주소·접속 허용 목록을 함께 바꾸고 외부 콘솔 점검표를 출력한다.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FILES = ['index.html', 'js/config.js', 'server/relay/wrangler.toml', 'server/api/wrangler.toml', 'server/relay/src/rules.js', '_headers', 'privacy.html', 'README.md', 'dev/notice.html'];

function hostname(value) {
  if (typeof value !== 'string' || value.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(value)) throw new Error('경로·포트 없는 도메인을 넣으세요: ' + value);
  return value.toLowerCase();
}

export function parseArgs(args) {
  const options = {};
  const names = { '--domain': 'domain', '--game-host': 'gameHost', '--api-host': 'apiHost', '--relay-host': 'relayHost', '--game-server-host': 'gameServerHost' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--keep-old') options.keepOld = true;
    else if (args[i] === '--dry-run') options.dryRun = true;
    else if (names[args[i]]) options[names[args[i]]] = hostname(args[++i]);
    else throw new Error('모르는 옵션: ' + args[i]);
  }
  if (!options.domain) throw new Error('사용법: node tools/set-domain.mjs --domain example.io [--game-host example.io] [--api-host api.example.io] [--relay-host relay.example.io] [--game-server-host game.example.io] [--keep-old] [--dry-run]');
  return options;
}

/** 모든 파일을 먼저 읽고 변환한 뒤 기록한다. 잘못된 입력은 어느 파일도 바꾸지 않는다. */
export function setDomain(root, options, log = console.log) {
  const domain = hostname(options.domain);
  const hosts = [options.gameHost || domain, options.apiHost || `api.${domain}`, options.relayHost || `relay.${domain}`, options.gameServerHost || `game.${domain}`].map(hostname);
  const [game, api, relay, gameServer] = hosts;
  const sources = Object.fromEntries(FILES.map((file) => [file, readFileSync(resolve(root, file), 'utf8')]));
  const config = sources['js/config.js'];
  const oldHosts = ['relay', 'api'].map((key) => {
    const value = config.match(new RegExp(`\\b${key}:\\s*\\{\\s*url:\\s*'https://([^/']+)/?'`));
    if (!value) throw new Error(`js/config.js의 ${key}.url을 찾지 못했습니다`);
    return value[1];
  });
  const marker = /<!-- 배포 접속 호스트: ([a-z0-9.,-]+) -->/;
  oldHosts.push(...(sources['index.html'].match(marker)?.[1].split(',') || []));
  const updateCsp = (text, selectedHosts) => text.replace(/connect-src\s+([^;"\r\n]+)/g, (_, values) => {
    const old = values.trim().split(/\s+/).filter((token) => options.keepOld || !oldHosts.some((host) => token === `https://${host}` || token === `wss://${host}`));
    return 'connect-src ' + [...new Set([...old, ...selectedHosts.flatMap((host) => [`https://${host}`, `wss://${host}`])])].join(' ');
  });
  const origins = (list) => [...new Set([...list.split(',').map((value) => value.trim()).filter((value) => value && (options.keepOld || !/^https:\/\/[^/]+\.github\.io$/.test(value))), `https://${game}`])].join(',');
  const next = { ...sources };
  next['js/config.js'] = config.replace(/(\brelay:\s*\{\s*url:\s*)'[^']*'/, `$1'https://${relay}'`).replace(/(\bapi:\s*\{\s*url:\s*)'[^']*'/, `$1'https://${api}'`);
  next['index.html'] = updateCsp(sources['index.html'], hosts);
  const managed = `<!-- 배포 접속 호스트: ${[...new Set(options.keepOld ? [...oldHosts, ...hosts] : hosts)].sort().join(',')} -->`;
  next['index.html'] = marker.test(next['index.html']) ? next['index.html'].replace(marker, managed) : next['index.html'].replace(/(<meta http-equiv="Content-Security-Policy"[^>]+>)/, `$1\n  ${managed}`);
  next['_headers'] = updateCsp(sources['_headers'], hosts);
  next['dev/notice.html'] = sources['dev/notice.html'].replace(/connect-src\s+([^;"\r\n]+)/, `connect-src 'self' https://${relay} wss://${relay}`);
  for (const file of ['server/relay/wrangler.toml', 'server/api/wrangler.toml']) next[file] = sources[file].replace(/(ALLOWED_ORIGINS\s*=\s*")([^"]+)(")/, (_, start, list, end) => start + origins(list) + end);
  next['server/relay/src/rules.js'] = sources['server/relay/src/rules.js'].replace(/(export const DEFAULT_ORIGINS = ')([^']+)(';)/, (_, start, list, end) => start + origins(list) + end);
  next['privacy.html'] = sources['privacy.html'].replace(/<tr><td>(?:GitHub Pages|Cloudflare Pages)<\/td><td>게임 파일 제공[^<]*<\/td><\/tr>/, `<tr><td>Cloudflare Pages</td><td>게임 파일 제공 (https://${game})</td></tr>`);
  next['README.md'] = sources['README.md'].replace(/(\*\*플레이: <)https:\/\/[^>]+(>\*\*)/, `$1https://${game}/$2`);
  const changed = FILES.filter((file) => next[file] !== sources[file]);
  for (const file of changed) {
    log(`--- ${file}\n+++ ${file}`);
    const before = sources[file].split(/\r?\n/), after = next[file].split(/\r?\n/);
    for (const line of before) if (!after.includes(line)) log('-' + line);
    for (const line of after) if (!before.includes(line)) log('+' + line);
  }
  if (!options.dryRun) for (const file of changed) writeFileSync(resolve(root, file), next[file]);
  log(`${options.dryRun ? '미리보기' : '기록'}: ${changed.length}개 파일`);
  log(`수동 점검표:\n- DNS: ${game} → Pages, ${api}·${relay} → Workers 맞춤 도메인, ${gameServer} → EC2 고정 IP (DNS only)\n- Cloudflare: Pages 맞춤 도메인 ${game}, Worker skala-api → ${api}, Worker skala-relay → ${relay}, 각각 배포\n- Google: 승인된 JavaScript 원본 https://${game}, 리디렉션 URI https://${game}/\n- Kakao: 웹 사이트 도메인 https://${game}, Redirect URI https://${game}/\n- Toss: 웹훅 https://${api}/pay/webhook, 테스트 결제·환불 확인\n- GitHub Pages: 새 주소 안내 유지, 로그인은 새 주소에서 다시 연결 (브라우저 저장소는 자동 이전되지 않음)`);
  return { changed, hosts: { game, api, relay, gameServer } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { setDomain(ROOT, parseArgs(process.argv.slice(2))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
