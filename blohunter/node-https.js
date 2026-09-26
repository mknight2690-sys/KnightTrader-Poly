const http = require('http');
const https = require('https');
const { URL } = require('url');

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

class SimpleHeaders {
  constructor(raw = {}) {
    this._map = new Map();
    for (const [key, value] of Object.entries(raw || {})) {
      if (value == null) continue;
      this._map.set(String(key).toLowerCase(), String(value));
    }
  }

  get(name) {
    return this._map.get(String(name || '').toLowerCase()) || null;
  }
}

function normalizeRequestHeaders(initHeaders) {
  const out = { 'User-Agent': CHROME_UA, Accept: 'application/json, text/event-stream, */*' };
  if (!initHeaders) return out;
  const entries = typeof initHeaders.entries === 'function'
    ? [...initHeaders.entries()]
    : Object.entries(initHeaders);
  for (const [key, value] of entries) {
    if (value == null) continue;
    out[key] = String(value);
  }
  return out;
}

function httpsFetch(url, init = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(String(url));
    } catch (err) {
      reject(err);
      return;
    }
    const lib = parsed.protocol === 'http:' ? http : https;
    const method = String(init.method || 'GET').toUpperCase();
    const headers = normalizeRequestHeaders(init.headers);
    const body = init.body == null ? null : Buffer.from(String(init.body));
    if (body && !headers['Content-Length'] && !headers['content-length']) {
      headers['Content-Length'] = String(body.length);
    }
    const req = lib.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'http:' ? 80 : 443),
        path: `${parsed.pathname}${parsed.search}`,
        method,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          const text = raw.toString('utf8');
          const headerMap = {};
          for (let i = 0; i < res.rawHeaders.length; i += 2) {
            headerMap[res.rawHeaders[i]] = res.rawHeaders[i + 1];
          }
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            headers: new SimpleHeaders(headerMap),
            url: parsed.href,
            redirected: false,
            async text() {
              return text;
            },
            async json() {
              return JSON.parse(text);
            },
          });
        });
      }
    );
    req.on('error', reject);
    const timeoutMs = Number(init.timeout || 0);
    if (timeoutMs > 0) req.setTimeout(timeoutMs, () => req.destroy(new Error('Request timed out')));
    if (init.signal) {
      if (init.signal.aborted) {
        req.destroy();
        reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
        return;
      }
      init.signal.addEventListener('abort', () => {
        req.destroy();
      });
    }
    if (body) req.write(body);
    req.end();
  });
}

function parseSseBlock(block) {
  let eventName = 'message';
  let id = '';
  const dataLines = [];
  for (const rawLine of String(block || '').split(/\r?\n/)) {
    const line = rawLine.replace(/\r$/, '');
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) eventName = line.slice(6).trim() || 'message';
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    else if (line.startsWith('id:')) id = line.slice(3).trim();
  }
  return { eventName, id, data: dataLines.join('\n') };
}

function openSse(url, { onOpen, onEvent, onError, headers = {} } = {}) {
  let req = null;
  let closed = false;
  let leftover = '';

  function close() {
    closed = true;
    if (req) {
      req.destroy();
      req = null;
    }
  }

  try {
    const parsed = new URL(String(url));
    const lib = parsed.protocol === 'http:' ? http : https;
    req = lib.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'http:' ? 80 : 443),
        path: `${parsed.pathname}${parsed.search}`,
        method: 'GET',
        headers: {
          Accept: 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'User-Agent': CHROME_UA,
          ...headers,
        },
      },
      (res) => {
        if (closed) return;
        if (res.statusCode !== 200) {
          onError?.(new Error(`SSE HTTP ${res.statusCode}`));
          close();
          return;
        }
        onOpen?.();
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          leftover += chunk;
          const parts = leftover.split(/\r?\n\r?\n/);
          leftover = parts.pop() || '';
          for (const block of parts) {
            const parsedEvent = parseSseBlock(block);
            if (!parsedEvent.data && parsedEvent.eventName === 'message') continue;
            onEvent?.(parsedEvent);
          }
        });
        res.on('end', () => {
          if (!closed) onError?.(new Error('SSE stream ended'));
        });
        res.on('error', (err) => {
          if (!closed) onError?.(err);
        });
      }
    );
    req.on('error', (err) => {
      if (!closed) onError?.(err);
    });
    req.end();
  } catch (err) {
    onError?.(err);
  }

  return { close };
}

function installNodeFetch() {
  globalThis.fetch = httpsFetch;
  return httpsFetch;
}

module.exports = { httpsFetch, openSse, installNodeFetch, SimpleHeaders };
