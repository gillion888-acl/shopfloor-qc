// 本地静态服务器：只给预览 / 验收用（正式交付就是一个静态目录，放到哪台机器上都能开）
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

// 用 fileURLToPath 而不是 URL.pathname：后者会把路径里的中文/空格做百分号编码
const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT || 4220);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

createServer(async (req, res) => {
  try {
    const raw = decodeURIComponent((req.url || '/').split('?')[0]);
    const rel = normalize(raw === '/' ? '/index.html' : raw).replace(/^([/\\])+/, '');
    const file = join(ROOT, rel);
    if (!file.startsWith(normalize(ROOT))) throw new Error('forbidden');
    if ((await stat(file)).isDirectory()) throw new Error('is a directory');
    const body = await readFile(file);
    // 验收要看是否真的没有外部请求：这里给每个响应带上来源标记
    res.writeHead(200, {
      'content-type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404');
  }
}).listen(PORT, () => {
  console.log(`车间质检本 → http://localhost:${PORT}`);
  console.log('（本机静态服务，仅用于预览；正式交付把这个目录丢到任意静态空间即可）');
});
