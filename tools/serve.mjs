/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 로컬 개발용 정적 파일 서버(의존성 없음). GitHub Pages와 같이 저장소 루트를 그대로 내려준다.
 *          사용법: node tools/serve.mjs [포트=8080]
 */
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.argv[2]) || Number(process.env.PORT) || 8080;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.mp3': 'audio/mpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};

function fileFor(urlPath) {
  const rel = normalize(decodeURIComponent(urlPath.split('?')[0])).replace(/^([/\\])+/, '');
  const full = join(ROOT, rel);
  if (full !== ROOT && !full.startsWith(ROOT + sep)) return null; // 저장소 밖 경로 차단
  try {
    const st = statSync(full);
    if (st.isDirectory()) {
      const index = join(full, 'index.html');
      return statSync(index).isFile() ? index : null;
    }
    return st.isFile() ? full : null;
  } catch { return null; }
}

createServer((req, res) => {
  const file = fileFor(req.url || '/');
  if (!file) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not found'); return; }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  createReadStream(file).pipe(res);
}).listen(PORT, () => console.log(`SKALA 작전 dev server: http://localhost:${PORT}/`));
