#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');

const rendererRoot = path.join(__dirname, '..', 'src', 'renderer');
const assetsRoot = path.join(__dirname, '..', 'src', 'assets');
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('Usage: npm run start:pwa -- [port]');
  process.exit(0);
}

const requestedPort = process.argv.slice(2).find((arg) => /^\d+$/.test(arg));
const port = Number(process.env.PORT || requestedPort || 4173);
const types = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
]);

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

const server = http.createServer((req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(requestUrl.pathname);
  const isAssetRequest = pathname.startsWith('/assets/');
  const root = isAssetRequest ? assetsRoot : rendererRoot;
  const relativePath = isAssetRequest
    ? pathname.replace(/^\/assets\//, '')
    : (pathname === '/' ? 'index.html' : pathname.replace(/^\//, ''));
  const filePath = path.resolve(root, relativePath);

  if (!filePath.startsWith(root)) {
    send(res, 403, 'Forbidden', { 'content-type': 'text/plain; charset=utf-8' });
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      send(res, 404, 'Not found', { 'content-type': 'text/plain; charset=utf-8' });
      return;
    }

    const ext = path.extname(filePath);
    send(res, 200, data, {
      'content-type': types.get(ext) || 'application/octet-stream',
      'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    });
  });
});

server.listen(port, () => {
  console.log(`pico PWA listening on http://localhost:${port}`);
});
