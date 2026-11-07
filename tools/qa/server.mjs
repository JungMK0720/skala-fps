/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 자동 플레이 테스트용 정적 서버(의존성 없음). 저장소를 GitHub Pages와 같은 /skala-fps/ 아래에서만 내려주므로 절대 경로는 404로 드러난다.
 *          시험이 운영 Supabase를 건드리지 않도록 js/config.js는 기본으로 빈 설정을 내려주고, 시험용 값으로 바꿀 수 있다. 포트는 운영체제가 고른다.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const PREFIX = '/skala-fps/';
const CONFIG_PATH = 'js/config.js';
/** 저장소의 js/config.js는 운영 프로젝트를 가리킨다. 시험은 이 빈 설정으로 시작해 닉네임이나 프로필이 운영 DB에 들어가지 않게 한다. */
export const OFFLINE_CONFIG = "window.SKALA_CONFIG = { supabase: { url: '', anonKey: '' } };\n";
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.mp3': 'audio/mpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end('Not found');
}

/**
 * @param {{ root?:string, config?:string|null }} [options]
 *   config: js/config.js 대신 내려줄 글자. 기본은 OFFLINE_CONFIG이고, null이면 저장소의 파일을 그대로 내려준다.
 *   server.setConfig로 나중에 바꿀 수 있고, setConfig(null)은 서버를 시작할 때의 설정으로 돌아간다.
 * @returns {Promise<{ url:string, base:string, port:number, requests:{url:string,status:number}[], setConfig(text):void, close():Promise<void> }>}
 *   base는 끝에 /가 붙은 게임 주소, requests는 지금까지 받은 요청이다.
 */
export async function startServer({ root = ROOT, config = OFFLINE_CONFIG } = {}) {
  let configText = config;
  const requests = [];

  async function handle(req, res) {
    const path = decodeURIComponent((req.url || '/').split('?')[0]);
    if (path === PREFIX.slice(0, -1)) {   // GitHub Pages처럼 /skala-fps → /skala-fps/
      res.writeHead(301, { Location: PREFIX });
      res.end();
      return 301;
    }
    if (!path.startsWith(PREFIX)) { notFound(res); return 404; }
    const rel = normalize(path.slice(PREFIX.length)).replace(/^([/\\])+/, '');
    let full = join(root, rel);
    if (full !== root && !full.startsWith(root + sep)) { notFound(res); return 404; }
    if (configText != null && rel.replace(/\\/g, '/') === CONFIG_PATH) {
      res.writeHead(200, { 'Content-Type': TYPES['.js'], 'Cache-Control': 'no-store' });
      res.end(configText);
      return 200;
    }
    try {
      if ((await stat(full)).isDirectory()) full = join(full, 'index.html');
      const body = await readFile(full);
      res.writeHead(200, { 'Content-Type': TYPES[extname(full).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(body);
      return 200;
    } catch (err) {
      notFound(res);
      return 404;
    }
  }

  const server = createServer((req, res) => {
    handle(req, res).then((status) => requests.push({ url: req.url, status }), () => { notFound(res); requests.push({ url: req.url, status: 500 }); });
  });
  const sockets = new Set();
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((res, rej) => { server.once('error', rej); server.listen(0, '127.0.0.1', res); });
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    port,
    base: url + PREFIX,
    requests,
    setConfig(text) { configText = text == null ? config : text; },
    close() {
      return new Promise((res) => {
        for (const s of sockets) s.destroy();
        server.close(() => res());
      });
    }
  };
}
