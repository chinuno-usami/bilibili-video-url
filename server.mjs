#!/usr/bin/env node
// 本地/自建服务器跑法：node server.mjs  [PORT]
import { createServer } from 'node:http';
import { handle } from './src/handler.mjs';

const PORT = Number(process.argv[2] || process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const PUSH_TOKEN = process.env.PUSH_TOKEN || '';

// 极简内存缓存（key -> {v, at}）。
// 注意：进程重启就清空。书签每次解析都会重新 push，所以影响不大；
// 想跨重启保留可以换成写文件或 SQLite。
const store = new Map();
const cache = {
  async get(k) {
    const e = store.get(k);
    if (!e) return null;
    if (Date.now() > e.at) {
      store.delete(k);
      return null;
    }
    return e.v;
  },
  async put(k, v, ttlSec) {
    store.set(k, { v, at: Date.now() + ttlSec * 1000 });
    if (store.size > 1000) {
      const now = Date.now();
      for (const [kk, ev] of store) if (now > ev.at) store.delete(kk);
    }
  },
};

const server = createServer(async (req, res) => {
  const host = req.headers.host || `127.0.0.1:${PORT}`;
  try {
    // POST 必须把 body 一起交给 Request，否则 handler 读不到 JSON
    const hasBody = req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH';
    const body = hasBody ? await new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    }) : undefined;

    const request = new Request(`http://${host}${req.url}`, {
      method: req.method,
      headers: req.headers,
      body,
    });
    const response = await handle(request, { cache, pushToken: PUSH_TOKEN });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (req.method === 'HEAD' || !response.body) {
      res.end();
      return;
    }
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('500 ' + (err && err.message ? err.message : String(err)));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`bili-302 listening on http://${HOST}:${PORT}`);
  console.log(`书签安装页: http://127.0.0.1:${PORT}/bm`);
  console.log(`推送缓存  : POST http://127.0.0.1:${PORT}/push${PUSH_TOKEN ? ' (需要 Bearer token)' : ''}`);
  console.log(`试一下    : curl -sI "http://127.0.0.1:${PORT}/p/BV1GJ411x7h7?qn=16" | grep -i location`);
});
