// Cloudflare Worker 入口：wrangler deploy
// 和 Node 版共用同一个 handler，所以 /p、/json、/push、/bm、/bookmarklet.js 全都有。

import { handle } from './src/handler.mjs';

// 推送缓存的优先级：
//   1) KV（推荐，跨边缘节点一致；在 wrangler.toml 里绑 PUSH 命名空间）
//   2) Cache API（没有 KV 时的退化方案，只在本节点有效）
//   3) 都没有 -> 不缓存（/push 会返回 503）
const kvCache = (kv) => ({
  async get(key) {
    const raw = await kv.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  },
  async put(key, value, ttlSec) {
    await kv.put(key, JSON.stringify(value), {
      expirationTtl: Math.max(60, ttlSec), // KV 最小 60 秒
    });
  },
});

const cacheApiCache =
  typeof caches !== 'undefined' && caches.default
    ? {
        async get(key) {
          const hit = await caches.default.match(
            new Request('https://cache.local/' + encodeURIComponent(key))
          );
          if (!hit) return null;
          return await hit.json().catch(() => null);
        },
        async put(key, value, ttlSec) {
          await caches.default.put(
            new Request('https://cache.local/' + encodeURIComponent(key)),
            new Response(JSON.stringify(value), {
              headers: {
                'Content-Type': 'application/json',
                'Cache-Control': `max-age=${ttlSec}`,
              },
            })
          );
        },
      }
    : undefined;

export default {
  /**
   * @param {Request} request
   * @param {{BASE_PATH?: string, PUSH_TOKEN?: string, PUSH?: KVNamespace}} env
   */
  async fetch(request, env) {
    const cache = env && env.PUSH ? kvCache(env.PUSH) : cacheApiCache;
    return handle(request, {
      cache,
      basePath: (env && env.BASE_PATH) || '',
      pushToken: (env && env.PUSH_TOKEN) || '',
    });
  },
};
