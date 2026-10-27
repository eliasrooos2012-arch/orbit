'use strict';

// The relay has no access to mouse/keyboard itself. A foreground host app
// must connect and opt in before any remote-control messages can work.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { WebSocket, WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 3000);
const VIEWER_PASSWORD = process.env.VIEWER_PASSWORD || '';
const HOST_TOKEN = process.env.HOST_TOKEN || '';
if (VIEWER_PASSWORD.length < 12 || HOST_TOKEN.length < 24) {
  console.error('Set VIEWER_PASSWORD (12+ chars) and HOST_TOKEN (24+ chars). See README.md.');
  process.exit(1);
}
const HTML_DIR = path.join(__dirname, 'public');
const SESSION_LIFETIME_MS = 8 * 60 * 60 * 1000;
const sessions = new Map();
const failedLogins = new Map();
const viewers = new Set();
let host = null;
let hostMeta = null;

function equalsSecret(input, expected) {
  if (typeof input !== 'string') return false;
  const a = crypto.createHash('sha256').update(input).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}
function sendJSON(ws, object) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(object));
}
function safeOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser agents do not set Origin
  try {
    return new URL(origin).host === req.headers.host;
  } catch { return false; }
}
function sessionToken(req) {
  const cookieHeader = req.headers.cookie || '';
  const match = /(?:^|;\s*)remote_session=([a-f0-9]{64})(?:;|$)/.exec(cookieHeader);
  if (!match) return null;
  const token = match[1];
  const expires = sessions.get(token);
  if (!expires) return null;
  if (expires < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return token;
}
function headers(res, code, contentType, extra = {}) {
  res.writeHead(code, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' blob:; style-src 'self'; script-src 'self'; object-src 'none'; frame-ancestors 'none'",
    ...extra,
  });
}
function json(res, code, data, extra = {}) {
  headers(res, code, 'application/json; charset=utf-8', extra);
  res.end(JSON.stringify(data));
}
function status() {
  return { type: 'status', hostOnline: !!(host && host.readyState === WebSocket.OPEN),
    width: hostMeta?.width || null, height: hostMeta?.height || null,
    viewers: viewers.size };
}
function announce() {
  const msg = JSON.stringify(status());
  for (const ws of viewers) if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  sendJSON(host, { type: 'watchers', count: viewers.size });
}
function failIp(req) {
  const id = req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  let item = failedLogins.get(id);
  if (!item || now - item.first > 15 * 60 * 1000) {
    item = { first: now, count: 0 };
    failedLogins.set(id, item);
  }
  return { id, item };
}
function readBody(req, maxBytes = 4096) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [];
    req.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        reject(new Error('Request too large'));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const STATIC = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'application/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
]);
const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://local').pathname;
  if (!safeOrigin(req)) return json(res, 403, { error: 'Origin denied' });

  if (req.method === 'POST' && pathname === '/api/login') {
    const { id, item } = failIp(req);
    if (item.count >= 12) return json(res, 429, { error: 'Too many attempts. Try again later.' });
    let request;
    try { request = JSON.parse(await readBody(req)); }
    catch { return json(res, 400, { error: 'Invalid request' }); }
    if (!request || typeof request !== 'object' || !equalsSecret(request.password, VIEWER_PASSWORD)) {
      item.count++;
      return json(res, 401, { error: 'Wrong password' });
    }
    failedLogins.delete(id);
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, Date.now() + SESSION_LIFETIME_MS);
    const secure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
    const cookie = `remote_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secure ? '; Secure' : ''}`;
    return json(res, 200, { ok: true }, { 'Set-Cookie': cookie });
  }
  if (req.method === 'POST' && pathname === '/api/logout') {
    const token = sessionToken(req);
    if (token) {
      sessions.delete(token);
      for (const ws of viewers) if (ws.sessionToken === token) ws.close(1000, 'Logged out');
    }
    return json(res, 200, { ok: true }, { 'Set-Cookie': 'remote_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
  }
  if (req.method === 'GET' && pathname === '/api/status') {
    if (!sessionToken(req)) return json(res, 401, { authenticated: false });
    return json(res, 200, { authenticated: true, ...status() });
  }
  if (req.method === 'GET' && STATIC.has(pathname)) {
    const [filename, type] = STATIC.get(pathname);
    fs.readFile(path.join(HTML_DIR, filename), (err, contents) => {
      if (err) return json(res, 500, { error: 'Missing UI file' });
      headers(res, 200, type);
      res.end(contents);
    });
    return;
  }
  return json(res, 404, { error: 'Not found' });
});

const viewerWss = new WebSocketServer({ noServer: true, maxPayload: 32768 });
const hostWss = new WebSocketServer({ noServer: true, maxPayload: 6 * 1024 * 1024 });
server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url, 'http://local').pathname;
  if (pathname === '/agent') {
    const match = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    if (!match || !equalsSecret(match[1], HOST_TOKEN)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    hostWss.handleUpgrade(req, socket, head, ws => hostWss.emit('connection', ws));
  } else if (pathname === '/viewer' && safeOrigin(req)) {
    const token = sessionToken(req);
    if (!token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    viewerWss.handleUpgrade(req, socket, head, ws => {
      ws.sessionToken = token;
      viewerWss.emit('connection', ws);
    });
  } else {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
  }
});

hostWss.on('connection', ws => {
  if (host) host.close(4000, 'New host connected');
  host = ws;
  hostMeta = null;
  announce();
  ws.on('message', (data, isBinary) => {
    if (ws !== host) return;
    if (isBinary) {
      // JPEG frames only; prevents the relay from broadcasting arbitrary bytes.
      if (data.length < 10 || data[0] !== 0xff || data[1] !== 0xd8) return;
      for (const viewer of viewers) {
        if (viewer.readyState === WebSocket.OPEN && viewer.bufferedAmount < 2_000_000) {
          viewer.send(data, { binary: true });
        }
      }
      return;
    }
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'meta' && Number.isInteger(msg.width) && Number.isInteger(msg.height)
          && msg.width > 0 && msg.width <= 16000 && msg.height > 0 && msg.height <= 16000) {
        hostMeta = { width: msg.width, height: msg.height };
        announce();
      }
    } catch {}
  });
  ws.on('close', () => { if (host === ws) { host = null; hostMeta = null; announce(); } });
  ws.on('error', () => {});
});

function validCommand(msg) {
  if (!msg || typeof msg !== 'object') return false;
  if (msg.type === 'releaseAll') return true;
  if (msg.type === 'mouse') {
    if (msg.action === 'move') return Number.isFinite(msg.x) && msg.x >= 0 && msg.x <= 1
      && Number.isFinite(msg.y) && msg.y >= 0 && msg.y <= 1;
    return ['down', 'up'].includes(msg.action) && ['left', 'right', 'middle'].includes(msg.button);
  }
  if (msg.type === 'scroll') return Number.isInteger(msg.steps) && Math.abs(msg.steps) <= 20;
  if (msg.type === 'key') return ['down', 'up'].includes(msg.action)
    && typeof msg.code === 'string' && /^[A-Za-z0-9]{1,24}$/.test(msg.code);
  return false;
}
viewerWss.on('connection', ws => {
  viewers.add(ws);
  sendJSON(ws, status());
  announce();
  ws.on('message', (data, isBinary) => {
    if (isBinary || !host || host.readyState !== WebSocket.OPEN ||
        !sessions.has(ws.sessionToken) || sessions.get(ws.sessionToken) < Date.now()) return;
    try {
      const msg = JSON.parse(data.toString());
      if (validCommand(msg)) sendJSON(host, msg);
    } catch {}
  });
  ws.on('close', () => {
    viewers.delete(ws);
    sendJSON(host, { type: 'releaseAll' });
    announce();
  });
  ws.on('error', () => {});
});

const cleanup = setInterval(() => {
  const now = Date.now();
  for (const [token, expiry] of sessions) if (expiry < now) sessions.delete(token);
  for (const [ip, item] of failedLogins) if (now - item.first > 15 * 60 * 1000) failedLogins.delete(ip);
  for (const ws of viewers) if (!sessions.has(ws.sessionToken)) ws.close(4001, 'Session expired');
}, 60_000);
cleanup.unref();
server.listen(PORT, '0.0.0.0', () => console.log(`Remote desktop website listening on port ${PORT}`));
