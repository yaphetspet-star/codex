/*
 * Serves `webview/dist` for the Playwright suite.
 *
 * The build emits absolute asset paths because the extension rewrites them through
 * `asWebviewUri`, so the bundle cannot be opened straight off the filesystem.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', 'webview', 'dist');
const PORT = Number(process.env.WEBVIEW_TEST_PORT) || 4573;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

http
  .createServer((req, res) => {
    const requested = decodeURIComponent((req.url ?? '/').split('?')[0]);
    const file = path.join(ROOT, requested === '/' ? 'index.html' : requested);
    if (!file.startsWith(ROOT) || !fs.existsSync(file)) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  })
  .listen(PORT, '127.0.0.1', () => console.log(`webview dist on http://127.0.0.1:${PORT}`));
