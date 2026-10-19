import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/handler.mjs';
import { parseTarget, resolveDirectUrl } from '../src/bili.mjs';

// ---- 假 fetch：模拟 bilibili 的返回，不碰网络 ----
const VIEW = {
  code: 0,
  data: {
    bvid: 'BV1GJ411x7h7',
    aid: 80433022,
    cid: 137649199,
    title: 'test video',
    owner: { name: 'up' },
    pages: [
      { cid: 137649199, page: 1 },
      { cid: 222222222, page: 2 },
    ],
  },
};
const PLAY = (cid, qn) => ({
  code: 0,
  data: {
    quality: qn >= 64 ? 64 : 16,
    accept_quality: [64, 16],
    durl: [
      {
        url:
          `https://upos-sz-test.bilivideo.com/upgcxcode/${cid}/${cid}_da2-1-` +
          `${qn >= 64 ? 192 : 16}.mp4?e=xx&deadline=9999999999&upsig=abc&platform=html5`,
      },
    ],
  },
});

function fakeFetch({ dashOnly = false, view = VIEW } = {}) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    const u = new URL(url);
    if (u.pathname === '/x/web-interface/view') {
      return new Response(JSON.stringify(view), { headers: { 'Content-Type': 'application/json' } });
    }
    if (u.pathname === '/x/player/playurl') {
      const cid = Number(u.searchParams.get('cid'));
      const qn = Number(u.searchParams.get('qn'));
      const body = dashOnly
        ? { code: 0, data: { dash: { video: [] }, accept_quality: [80] } }
        : PLAY(cid, qn);
      return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('nope', { status: 404 });
  };
  impl.calls = calls;
  return impl;
}

const req = (path) => new Request('https://x.test' + path);

test('parseTarget 各种输入', () => {
  assert.deepEqual(parseTarget('BV1GJ411x7h7'), {
    bvid: 'BV1GJ411x7h7',
    aid: null,
    innerPage: null,
  });
  assert.equal(
    parseTarget('https://www.bilibili.com/video/BV1GJ411x7h7?p=3&spm=x').bvid,
    'BV1GJ411x7h7'
  );
  assert.equal(parseTarget('https://www.bilibili.com/video/BV1GJ411x7h7?p=3').innerPage, 3);
  assert.equal(parseTarget('av80433022').aid, 80433022);
  assert.equal(parseTarget('https://www.bilibili.com/video/av80433022/').aid, 80433022);
  assert.throws(() => parseTarget('hello'), /BV/);
  assert.throws(() => parseTarget(''), /缺少/);
});

test('resolveDirectUrl 用 pages[p-1].cid 取分P', async () => {
  const f = fakeFetch();
  const r1 = await resolveDirectUrl({ bvid: 'BV1GJ411x7h7', p: 1, qn: 64 }, f);
  const r2 = await resolveDirectUrl({ bvid: 'BV1GJ411x7h7', p: 2, qn: 64 }, f);
  assert.match(r1.url, /137649199_da2-1-192\.mp4/);
  assert.match(r2.url, /222222222_da2-1-192\.mp4/);
  assert.ok(f.calls.some((u) => u.includes('cid=222222222')));
});

test('qn<64 拿 360P 文件', async () => {
  const r = await resolveDirectUrl({ bvid: 'BV1GJ411x7h7', p: 1, qn: 16 }, fakeFetch());
  assert.match(r.url, /-1-16\.mp4/);
  assert.equal(r.quality, 16);
});

test('只有 DASH 时给出 403 而不是 500', async () => {
  await assert.rejects(
    () => resolveDirectUrl({ bvid: 'BV1GJ411x7h7', p: 1, qn: 80 }, fakeFetch({ dashOnly: true })),
    (e) => e.status === 403 && /DASH/.test(e.message)
  );
});

test('/p/ 返回 302 且 Location 指向 CDN', async () => {
  const res = await handle(req('/p/BV1GJ411x7h7?qn=16'), { fetchImpl: fakeFetch() });
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /bilivideo\.com/);
  assert.equal(res.headers.get('cache-control'), 'no-store, max-age=0');
  assert.equal(res.headers.get('x-bili-quality'), '16');
});

test('/player/?url= 兼容 91vrchat 写法', async () => {
  const res = await handle(
    req('/player/?url=' + encodeURIComponent('https://www.bilibili.com/video/BV1GJ411x7h7')),
    { fetchImpl: fakeFetch() }
  );
  assert.equal(res.status, 302);
});

test('/json/ 返回含 url 的 JSON', async () => {
  const res = await handle(req('/json/BV1GJ411x7h7'), { fetchImpl: fakeFetch() });
  const body = await res.json();
  assert.equal(body.bvid, 'BV1GJ411x7h7');
  assert.match(body.url, /^https:\/\//);
  assert.match(body.short, /\/p\/BV1GJ411x7h7\?p=1&qn=64/);
});

test('错误码：非法输入 400 / 无分P 404', async () => {
  assert.equal((await handle(req('/p/hello'), { fetchImpl: fakeFetch() })).status, 400);
  assert.equal((await handle(req('/p/BV1GJ411x7h7?p=9'), { fetchImpl: fakeFetch() })).status, 404);
});

test('缓存命中后不再请求上游', async () => {
  const f = fakeFetch();
  const store = new Map();
  const cache = {
    async get(k) {
      return store.get(k) || null;
    },
    async put(k, v) {
      store.set(k, v);
    },
  };
  await handle(req('/p/BV1GJ411x7h7'), { fetchImpl: f, cache });
  const before = f.calls.length;
  await handle(req('/p/BV1GJ411x7h7'), { fetchImpl: f, cache });
  assert.equal(f.calls.length, before);
});

test('/healthz 与帮助页', async () => {
  assert.equal(await (await handle(req('/healthz'))).text(), 'ok');
  assert.equal((await handle(req('/'))).status, 200);
});

test('书签静态资源由同一个 handler 提供', async () => {
  const js = await handle(req('/bookmarklet.js'));
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);
  assert.match(await js.text(), /boot\(\)/);

  const page = await handle(req('/bm'));
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(await page.text(), /bookmarklet\.js/);
});

// ── 推送缓存 ──────────────────────────────────────────────

function memCache() {
  const m = new Map();
  return {
    store: m,
    async get(k) {
      return m.get(k) ?? null;
    },
    async put(k, v) {
      m.set(k, v);
    },
  };
}

const futureDeadline = () => Math.floor(Date.now() / 1000) + 3600;
const mediaUrl = (qn = 16) =>
  `https://upos-sz-test.bilivideo.com/upgcxcode/99/91/137649199/137649199_da2-1-${qn}.mp4` +
  `?e=xx&upsig=sig${qn}&deadline=${futureDeadline()}&platform=html5`;

const pushReq = (body) =>
  new Request('https://x.test/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

test('POST /push 写入缓存，之后短链命中它（不再打上游）', async () => {
  const cache = memCache();
  // 上游一律 412 —— 如果代码去打了上游就会失败
  const banned = async () => new Response('{"code":-412}', { status: 412 });

  const res = await handle(
    pushReq({ bvid: 'BV1GJ411x7h7', p: 1, qn: 16, url: mediaUrl(16), title: 'hi' }),
    { cache, fetchImpl: banned }
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.short, '/p/BV1GJ411x7h7?p=1&qn=16');

  const r = await handle(req('/p/BV1GJ411x7h7?qn=16'), { cache, fetchImpl: banned });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('x-bili-source'), 'push');
  assert.equal(r.headers.get('x-bili-quality'), '16');
  assert.match(r.headers.get('location'), /upsig=sig16/);
});

test('服务端被风控时降级使用其它档位的推送缓存', async () => {
  const cache = memCache();
  const banned = async () => new Response('{"code":-412}', { status: 412 });
  await handle(pushReq({ bvid: 'BV1GJ411x7h7', p: 1, qn: 16, url: mediaUrl(16) }), { cache });

  // 请求 720P，但只 push 过 360P，上游又 412
  const r = await handle(req('/p/BV1GJ411x7h7?qn=64'), { cache, fetchImpl: banned });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('x-bili-source'), 'push');
  assert.equal(r.headers.get('x-bili-degraded'), '1');
});

test('/push 拒绝非法直链（防开放跳转）', async () => {
  const cache = memCache();
  for (const url of [
    'https://evil.com/upgcxcode/1.mp4?upsig=a&deadline=' + futureDeadline(),
    'http://upos.bilivideo.com/upgcxcode/1.mp4?upsig=a&deadline=' + futureDeadline(),
    'https://upos.bilivideo.com/other/1.mp4?upsig=a&deadline=' + futureDeadline(),
  ]) {
    const r = await handle(pushReq({ bvid: 'BV1GJ411x7h7', p: 1, qn: 16, url }), { cache });
    assert.equal(r.status, 400, url);
  }
});

test('/push 支持 token 保护', async () => {
  const cache = memCache();
  const noAuth = await handle(
    pushReq({ bvid: 'BV1GJ411x7h7', p: 1, qn: 16, url: mediaUrl() }),
    { cache, pushToken: 'secret' }
  );
  assert.equal(noAuth.status, 401);

  const withAuth = await handle(
    new Request('https://x.test/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret' },
      body: JSON.stringify({ bvid: 'BV1GJ411x7h7', p: 1, qn: 16, url: mediaUrl() }),
    }),
    { cache, pushToken: 'secret' }
  );
  assert.equal(withAuth.status, 200);
});

test('/push 没有缓存后端时返回 503', async () => {
  const r = await handle(pushReq({ bvid: 'BV1GJ411x7h7', p: 1, qn: 16, url: mediaUrl() }));
  assert.equal(r.status, 503);
});

test('GET /cache 能看到推送条目', async () => {
  const cache = memCache();
  await handle(pushReq({ bvid: 'BV1GJ411x7h7', p: 1, qn: 16, url: mediaUrl(16), title: 't' }), {
    cache,
  });
  const r = await handle(req('/cache/BV1GJ411x7h7'), { cache });
  const body = await r.json();
  assert.equal(body.pushed.length, 1);
  assert.equal(body.pushed[0].qn, 16);
  assert.equal(body.pushed[0].fresh, true);
});
