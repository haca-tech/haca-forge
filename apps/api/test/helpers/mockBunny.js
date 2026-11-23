// A local stand-in for Bunny (no real Bunny calls in tests or the browser check). One HTTP server:
//   Storage API   PUT / DELETE / GET-listing  /<zone>/<path>   (AccessKey header required)
//   Pull Zone     GET /<path>?token=&expires=                 (token checked like Bunny, Range supported)
// Files are kept in memory. `log` records every storage call, for assertions.
import http from 'http';
import path from 'path';
import { verifyBunnyToken } from '../../src/lib/storage/bunnyToken.js';

const TYPES = { '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.pdf': 'application/pdf', '.txt': 'text/plain', '.csv': 'text/csv', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
const MEDIA = new Set(['.mp4', '.mov', '.webm', '.png', '.jpg', '.jpeg', '.webp']);

export async function startMockBunny({ zone = 'test-zone', accessKey = 'test-storage-key', tokenKey = 'test-token-key', port = 0, failNext = null } = {}) {
  const files = new Map(); // key -> { body: Buffer, contentType }
  const log = [];
  const state = { failNext };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://mock');
    const parts = decodeURIComponent(url.pathname).split('/').filter(Boolean);
    const isStorage = parts[0] === zone && req.headers.accesskey !== undefined;

    if (isStorage) {
      const key = parts.slice(1).join('/');
      log.push({ method: req.method, key, contentType: req.headers['content-type'], contentLength: req.headers['content-length'] });
      if (req.headers.accesskey !== accessKey) {
        res.writeHead(401).end('{"HttpCode":401,"Message":"Unauthorized"}');
        return;
      }
      if (state.failNext && state.failNext.method === req.method) {
        const status = state.failNext.status;
        state.failNext = null;
        req.resume();
        res.writeHead(status).end('{"HttpCode":' + status + '}');
        return;
      }
      if (req.method === 'PUT') {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          files.set(key, { body: Buffer.concat(chunks), contentType: req.headers['content-type'] || 'application/octet-stream', chunks: chunks.length });
          res.writeHead(201, { 'Content-Type': 'application/json' }).end('{"HttpCode":201,"Message":"File uploaded."}');
        });
        return;
      }
      if (req.method === 'DELETE') {
        if (!files.delete(key)) {
          res.writeHead(404).end('{"HttpCode":404,"Message":"Object Not Found"}');
          return;
        }
        res.writeHead(200).end('{"HttpCode":200,"Message":"File deleted successfuly."}');
        return;
      }
      if (req.method === 'GET' && url.pathname.endsWith('/')) {
        const dir = key ? `${key}/` : '';
        const list = [...files.entries()]
          .filter(([k]) => k.startsWith(dir) && !k.slice(dir.length).includes('/'))
          .map(([k, f]) => ({ ObjectName: k.slice(dir.length), Length: f.body.length, IsDirectory: false }));
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(list));
        return;
      }
      res.writeHead(400).end();
      return;
    }

    // Pull Zone
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    const key = parts.join('/');
    const ok = verifyBunnyToken({ tokenKey, path: url.pathname, token: url.searchParams.get('token'), expires: url.searchParams.get('expires') });
    if (!ok) {
      res.writeHead(403, { 'Content-Type': 'text/plain' }).end('403 Forbidden');
      return;
    }
    const file = files.get(key);
    if (!file) {
      res.writeHead(404).end();
      return;
    }
    const ext = path.extname(key).toLowerCase();
    const headers = {
      'Content-Type': TYPES[ext] || file.contentType,
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
      'X-Content-Type-Options': 'nosniff',
    };
    // Like the Edge Rule docs/STORAGE.md sets up: anything that is not an image or video downloads.
    if (!MEDIA.has(ext)) headers['Content-Disposition'] = `attachment; filename="${path.basename(key)}"`;
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range) {
      const size = file.body.length;
      const start = range[1] === '' ? size - Number(range[2]) : Number(range[1]);
      const end = range[1] !== '' && range[2] !== '' ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start > end || start >= size) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
        return;
      }
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
      res.end(req.method === 'HEAD' ? undefined : file.body.subarray(start, end + 1));
      return;
    }
    res.writeHead(200, { ...headers, 'Content-Length': file.body.length });
    res.end(req.method === 'HEAD' ? undefined : file.body);
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    files,
    log,
    zone,
    accessKey,
    tokenKey,
    storageHost: base,
    cdnUrl: base,
    failNext: (method, status) => {
      state.failNext = { method, status };
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
