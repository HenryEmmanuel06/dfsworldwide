import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import paymentHandler from './api/payment.js';
import trackingHandler from './api/tracking.js';
import authHandler from './api/auth.js';
import adminMailHandler from './api/admin-mail.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, 'public');

function send(res, statusCode, headers, body) {
  res.statusCode = statusCode;
  if (headers) {
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  }
  res.end(body);
}

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.js') return 'application/javascript; charset=utf-8';
  if (ext === '.json') return 'application/json; charset=utf-8';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.svg') return 'image/svg+xml; charset=utf-8';
  if (ext === '.ico') return 'image/x-icon';
  if (ext === '.woff') return 'font/woff';
  if (ext === '.woff2') return 'font/woff2';
  if (ext === '.ttf') return 'font/ttf';
  return 'application/octet-stream';
}

function safeJoin(base, reqPath) {
  const decoded = decodeURIComponent(reqPath);
  const normalized = path.normalize(decoded).replace(/^([/\\])+/, '');
  const full = path.join(base, normalized);
  if (!full.startsWith(base)) return null;
  return full;
}

function enhanceRes(res) {
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (obj) => {
    const body = Buffer.from(JSON.stringify(obj));
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Length', String(body.length));
    res.end(body);
  };
  res.send = (body) => {
    if (typeof body === 'object' && body !== null && !Buffer.isBuffer(body)) {
      return res.json(body);
    }
    res.end(body);
  };
  return res;
}

function enhanceReq(req, urlObj, body) {
  req.query = Object.fromEntries(urlObj.searchParams.entries());
  req.body = body;
  return req;
}

async function readBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return null;

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return null;

  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  if (contentType.includes('application/json')) {
    try {
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }

  // best-effort form parsing
  if (contentType.includes('application/x-www-form-urlencoded')) {
    const params = new URLSearchParams(raw);
    return Object.fromEntries(params.entries());
  }

  return raw;
}

function routeApi(pathname) {
  if (pathname === '/api/payment' || pathname === '/api/payment/') return paymentHandler;
  if (pathname === '/api/tracking' || pathname === '/api/tracking/') return trackingHandler;
  if (pathname === '/api/auth' || pathname === '/api/auth/') return authHandler;
  if (pathname === '/api/admin-mail' || pathname === '/api/admin-mail/') return adminMailHandler;
  return null;
}

const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host}`);
  const pathname = urlObj.pathname;

  // API routes
  const apiHandler = routeApi(pathname);
  if (apiHandler) {
    const body = await readBody(req);
    enhanceReq(req, urlObj, body);
    enhanceRes(res);
    try {
      await apiHandler(req, res);
    } catch (e) {
      if (!res.headersSent) {
        res.status(500).json({ error: e?.message || 'Internal server error' });
      } else {
        res.end();
      }
    }
    return;
  }

  // Convenience redirects
  if (pathname === '/' || pathname === '') {
    const indexPath = path.join(publicDir, 'index.html');
    if (fs.existsSync(indexPath)) {
      const data = fs.readFileSync(indexPath);
      return send(res, 200, { 'Content-Type': 'text/html; charset=utf-8' }, data);
    }
    return send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Not found');
  }

  // Static files
  const filePath = safeJoin(publicDir, pathname);
  if (!filePath) return send(res, 400, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Bad request');

  let finalPath = filePath;
  try {
    const stat = fs.existsSync(finalPath) ? fs.statSync(finalPath) : null;
    if (stat && stat.isDirectory()) {
      finalPath = path.join(finalPath, 'index.html');
    }
    if (!fs.existsSync(finalPath) || !fs.statSync(finalPath).isFile()) {
      return send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Not found');
    }

    const data = fs.readFileSync(finalPath);
    return send(res, 200, { 'Content-Type': getContentType(finalPath) }, data);
  } catch (e) {
    return send(res, 500, { 'Content-Type': 'text/plain; charset=utf-8' }, e?.message || 'Internal server error');
  }
});

const port = Number(process.env.PORT || 30001);
server.listen(port, '0.0.0.0', () => {
  // Intentionally no console noise beyond what's needed
  console.log(`Dev server running on http://localhost:${port}`);
});
