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

// ── CDN 候选（解决「别人连不上某个节点」）──────────────────

test('cdnCandidates: 保留原节点，并把签名参数原样带到镜像', async () => {
  const { cdnCandidates, selectCandidate, cdnTagOf } = await import('../src/bili.mjs');
  const src =
    'https://cn-jsnt-ct-01-02.bilivideo.com/upgcxcode/9/1/1-1-192.mp4?upsig=abc&deadline=9999999999&og=ali';
  const list = cdnCandidates(src);
  assert.ok(list.length > 1);
  assert.equal(list[0].host, 'cn-jsnt-ct-01-02.bilivideo.com');
  assert.equal(list[0].tag, 'cn-ct');
  assert.equal(cdnTagOf('upos-sz-mirrorcosov.bilivideo.com'), 'cosov');
  for (const c of list) {
    const u = new URL(c.url);
    assert.equal(u.searchParams.get('upsig'), 'abc');
    assert.equal(u.searchParams.get('deadline'), '9999999999');
    assert.match(u.pathname, /\/upgcxcode\//);
  }
  // akamai 会 403，不能进候选
  assert.ok(!list.some((c) => /akamaized\.net$/.test(c.host)));

  assert.equal(selectCandidate(list, { h: 'cosov' }).tag, 'cosov');
  assert.equal(selectCandidate(list, { i: 1 }).tag, list[1].tag);
  assert.equal(selectCandidate(list, {}).host, list[0].host);
  assert.equal(selectCandidate(list, { h: 'nope' }).host, list[0].host);
  assert.deepEqual(cdnCandidates('not a url'), []);
});

test('/p 支持 ?h= 换 CDN 节点，/json 列出全部候选', async () => {
  const res = await handle(req('/p/BV1GJ411x7h7?h=cosov'), { fetchImpl: fakeFetch() });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('x-bili-cdn'), 'cosov');
  assert.match(res.headers.get('location'), /upos-sz-mirrorcosov\.bilivideo\.com/);

  const j = await (await handle(req('/json/BV1GJ411x7h7'), { fetchImpl: fakeFetch() })).json();
  assert.ok(Array.isArray(j.urls) && j.urls.length > 1);
  assert.equal(j.url, j.urls[0].url);
  assert.equal(j.cdn, j.urls[0].tag);

  // 推送缓存里的短链同样能换节点
  const cache = memCache();
  await handle(pushReq({ bvid: 'BV1GJ411x7h7', p: 1, qn: 16, url: mediaUrl(16) }), { cache });
  const p = await handle(req('/p/BV1GJ411x7h7?qn=16&h=ali'), { cache });
  assert.equal(p.status, 302);
  assert.equal(p.headers.get('x-bili-cdn'), 'ali');
});

// ── 按访问者 ASN 记忆最佳节点 ─────────────────────────────

/** 在 fakeFetch 外面套一层：媒体请求按 host 返回 206/403，用来模拟探测 */
function cdnAwareFetch(okHosts) {
  const base = fakeFetch();
  const impl = async (url, init) => {
    const u = new URL(url);
    if (u.pathname.startsWith('/upgcxcode/')) {
      impl.probes.push(u.host);
      return new Response('x', { status: okHosts.includes(u.host) ? 206 : 403 });
    }
    return base(url, init);
  };
  impl.probes = [];
  impl.calls = base.calls;
  return impl;
}

test('首次访问探测并把可用节点记到该 ASN，之后不再探测', async () => {
  const cache = memCache();
  const ok = 'upos-sz-mirrorhw.bilivideo.com';
  const f = cdnAwareFetch([ok]);
  const opts = { cache, fetchImpl: f, client: { asn: 4837, country: 'CN', colo: 'HKG' } };

  const r1 = await handle(req('/p/BV1GJ411x7h7?qn=16'), opts);
  assert.equal(r1.status, 302);
  assert.equal(r1.headers.get('x-bili-cdn'), 'hw');
  assert.equal(r1.headers.get('x-bili-cdn-source'), 'probe');
  assert.ok(f.probes.length > 1, '应该逐个探过候选');

  const stored = cache.store.get('cdn:asn:4837');
  assert.equal(stored.tag, 'hw');
  assert.equal(stored.host, ok);
  assert.equal(stored.by, 'probe');

  // 第二次：命中记忆，不再发探测请求
  const before = f.probes.length;
  const r2 = await handle(req('/p/BV1GJ411x7h7?qn=16'), opts);
  assert.equal(r2.headers.get('x-bili-cdn'), 'hw');
  assert.equal(r2.headers.get('x-bili-cdn-source'), 'asn');
  assert.equal(f.probes.length, before);

  // 不同 ASN 各记各的
  const r3 = await handle(req('/p/BV1GJ411x7h7?qn=16'), {
    ...opts,
    client: { asn: 9929 },
  });
  assert.equal(r3.headers.get('x-bili-cdn'), 'hw');
  assert.equal(r3.headers.get('x-bili-cdn-source'), 'probe');
});

test('?h=&remember=1 手动教一次，该 ASN 后续都走这个节点', async () => {
  const cache = memCache();
  const opts = { cache, fetchImpl: fakeFetch(), client: { asn: 4847 } };

  const r1 = await handle(req('/p/BV1GJ411x7h7?h=cosov&remember=1'), opts);
  assert.equal(r1.headers.get('x-bili-cdn'), 'cosov');
  assert.equal(r1.headers.get('x-bili-cdn-source'), 'manual');
  assert.equal(cache.store.get('cdn:asn:4847').tag, 'cosov');
  assert.equal(cache.store.get('cdn:asn:4847').by, 'manual');

  const r2 = await handle(req('/p/BV1GJ411x7h7'), opts);
  assert.equal(r2.headers.get('x-bili-cdn'), 'cosov');
  assert.equal(r2.headers.get('x-bili-cdn-source'), 'asn');

  // 不带 remember 的显式选择不改记忆
  await handle(req('/p/BV1GJ411x7h7?h=ali'), opts);
  assert.equal(cache.store.get('cdn:asn:4847').tag, 'cosov');
});

test('污染保护：记住的 tag 在当前候选里不存在时退回默认', async () => {
  const cache = memCache();
  cache.store.set('cdn:asn:4808', { tag: 'gone', host: 'x', at: 1, by: 'manual' });
  const r = await handle(req('/p/BV1GJ411x7h7'), {
    cache,
    fetchImpl: fakeFetch(),
    client: { asn: 4808 },
    learn: false,
  });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('x-bili-cdn-source'), 'default');
});

test('GET /cdn/<asn> 能看到记忆；无 ASN 环境不崩', async () => {
  const cache = memCache();
  cache.store.set('cdn:asn:4837', { tag: 'aliov', host: 'upos-sz-mirroraliov.bilivideo.com', at: 1, by: 'manual' });
  const body = await (await handle(req('/cdn/4837'), { cache })).json();
  assert.equal(body.asn, '4837');
  assert.equal(body.entry.tag, 'aliov');

  const none = await (await handle(req('/cdn'), { cache })).json();
  assert.equal(none.asn, null);
  assert.match(none.note, /ASN/);

  // Node 环境（没有 client）下短链照常工作
  const r = await handle(req('/p/BV1GJ411x7h7'), { fetchImpl: fakeFetch() });
  assert.equal(r.headers.get('x-bili-cdn-source'), 'default');
});

test('全部候选都不可达：记 15 分钟负缓存，不反复探测', async () => {
  const cache = memCache();
  const f = cdnAwareFetch([]);
  const opts = { cache, fetchImpl: f, client: { asn: 4134 } };

  const r1 = await handle(req('/p/BV1GJ411x7h7?qn=16'), opts);
  assert.equal(r1.status, 302);
  assert.equal(r1.headers.get('x-bili-cdn-source'), 'default');
  assert.equal(cache.store.get('cdn:asn:4134').by, 'probe-empty');

  const before = f.probes.length;
  const r2 = await handle(req('/p/BV1GJ411x7h7?qn=16'), opts);
  assert.equal(r2.headers.get('x-bili-cdn-source'), 'default');
  assert.equal(f.probes.length, before);
});

// ── 客户端（浏览器）自报节点：不依赖服务端出口 IP ─────────

test('/push 带上 cdn 时，把它记到「推送者」的 ASN 上', async () => {
  const cache = memCache();
  const opts = { cache, client: { asn: 56040 } };

  // 合法 tag
  const r = await handle(
    pushReq({ bvid: 'BV1GJ411x7h7', p: 1, qn: 16, url: mediaUrl(16), cdn: 'hw' }),
    opts
  );
  assert.equal(r.status, 200);
  assert.equal((await r.json()).learnedCdn, 'hw');
  assert.equal(cache.store.get('cdn:asn:56040').tag, 'hw');
  assert.equal(cache.store.get('cdn:asn:56040').by, 'client');

  // 不在当前直链候选里的 tag 一律忽略
  const r2 = await handle(
    pushReq({ bvid: 'BV1GJ411x7h7', p: 1, qn: 16, url: mediaUrl(16), cdn: 'akamai' }),
    opts
  );
  assert.equal(r2.status, 200);
  assert.equal((await r2.json()).learnedCdn, undefined);
  assert.equal(cache.store.get('cdn:asn:56040').tag, 'hw');
});

test('probeInPage: 按可达 + 快慢排序（浏览器端探活）', async () => {
  const { probeInPage, cdnCandidates } = await import('../src/cdn.mjs');
  const urls = cdnCandidates(mediaUrl(16));
  const seen = [];
  const fake = async (url, init) => {
    seen.push({ host: new URL(url).host, mode: init.mode });
    if (new URL(url).host.includes('mirrorhw')) throw new Error('net::ERR_CONNECTION_RESET');
    // 浏览器里 no-cors 拿到的是 opaque response（status 0），这里造个等价的
    return new Response('');
  };
  const ranked = await probeInPage(urls, { timeoutMs: 500, fetchImpl: fake });
  assert.equal(ranked[0].ok, true);
  assert.equal(ranked[ranked.length - 1].host, 'upos-sz-mirrorhw.bilivideo.com');
  assert.equal(ranked[ranked.length - 1].ok, false);
  assert.equal(seen[0].mode, 'no-cors'); // CDN 没有 CORS 头也要能探
});

test('Worker 有 waitUntil 时：首次 302 不等待探测，学习在响应后后台完成', async () => {
  const cache = memCache();
  const base = fakeFetch();
  let probes = 0;
  const slow = async (url, init) => {
    const u = new URL(url);
    if (u.pathname.startsWith('/upgcxcode/')) {
      probes++;
      await new Promise((r) => setTimeout(r, 250)); // 模拟慢探测
      return new Response('x', { status: u.host.includes('mirrorcos.') ? 206 : 403 });
    }
    return base(url, init);
  };
  const background = [];
  const opts = {
    cache,
    fetchImpl: slow,
    client: { asn: 45090 },
    waitUntil: (p) => background.push(p),
  };

  const t0 = Date.now();
  const r1 = await handle(req('/p/BV1GJ411x7h7?qn=16'), opts);
  const elapsed = Date.now() - t0;

  assert.equal(r1.status, 302);
  assert.equal(r1.headers.get('x-bili-cdn-source'), 'default');
  assert.equal(r1.headers.get('x-bili-cdn-learning'), '1');
  assert.ok(elapsed < 150, `302 不该等探测，实际 ${elapsed}ms`);
  assert.equal(cache.store.get('cdn:asn:45090'), undefined, '响应时记忆还没写好');
  assert.equal(background.length, 1);

  await Promise.all(background);
  assert.equal(cache.store.get('cdn:asn:45090').tag, 'cos');

  const r2 = await handle(req('/p/BV1GJ411x7h7?qn=16'), opts);
  assert.equal(r2.headers.get('x-bili-cdn'), 'cos');
  assert.equal(r2.headers.get('x-bili-cdn-source'), 'asn');
  assert.equal(r2.headers.get('x-bili-cdn-learning'), null);
});

test('探测超时上限：卡死的节点不会把请求拖过 PROBE_TIMEOUT_MS', async () => {
  const { probeCandidates } = await import('../src/bili.mjs');
  const { cdnCandidates } = await import('../src/cdn.mjs');
  const { PROBE_TIMEOUT_MS } = await import('../src/handler.mjs');
  const urls = cdnCandidates(mediaUrl(16)).slice(0, 3);
  const hang = (url, init) =>
    new Promise((_, reject) => {
      // 永不回应，只等 AbortSignal 超时；模拟黑洞节点
      if (init && init.signal) init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
  const started = Date.now();
  const ranked = await probeCandidates(urls, hang, { timeoutMs: 200 });
  assert.ok(Date.now() - started < 1000);
  assert.ok(ranked.every((r) => !r.ok));
  assert.ok(PROBE_TIMEOUT_MS <= 2000);
});

// ── probe 的 first-ok 收尾策略（黑洞节点不再拖满超时）──────────

const { probeInPage } = await import('../src/cdn.mjs');

const okAfter = (ms, status = 206) => () =>
  new Promise((resolve) => setTimeout(() => resolve(new Response('', { status })), ms));
const hangUntilAbort = (url, init) =>
  new Promise((_, reject) => {
    if (init && init.signal) {
      if (init.signal.aborted) return reject(new Error('aborted'));
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }
  });

test('probeCandidates first-ok + grace：30ms 成功后 ~180ms 收工', async () => {
  const { probeCandidates } = await import('../src/bili.mjs');
  const { cdnCandidates } = await import('../src/cdn.mjs');
  const urls = cdnCandidates(mediaUrl(16));

  const fake = (url, init) => {
    const host = new URL(url).host;
    if (host === 'upos-sz-mirrorali.bilivideo.com') return okAfter(20)(); // 冠军
    if (host === 'upos-sz-mirrorcos.bilivideo.com') return okAfter(60)(); // 落在 grace 窗口内
    return hangUntilAbort(url, init); // 黑洞
  };

  const t0 = Date.now();
  const ranked = await probeCandidates(urls, fake, {
    timeoutMs: 1500,
    settle: 'first-ok',
    graceMs: 150,
  });
  const elapsed = Date.now() - t0;

  assert.ok(elapsed < 700, `不该等黑洞，实际 ${elapsed}ms`);
  assert.deepEqual(ranked.map((r) => r.tag).sort(), ['ali', 'cos']); // grace 窗口内的也在
  assert.ok(ranked.every((r) => r.ok));
  assert.equal(ranked[0].tag, 'ali'); // 快的在前
});

test('probeCandidates first-ok + grace=0：只拿冠军，立刻返回', async () => {
  const { probeCandidates } = await import('../src/bili.mjs');
  const { cdnCandidates } = await import('../src/cdn.mjs');
  const urls = cdnCandidates(mediaUrl(16));
  const fake = (url, init) => {
    const host = new URL(url).host;
    if (host === 'upos-sz-mirrorhw.bilivideo.com') return okAfter(10)();
    return hangUntilAbort(url, init);
  };
  const t0 = Date.now();
  const ranked = await probeCandidates(urls, fake, { timeoutMs: 1500, settle: 'first-ok' });
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].tag, 'hw');
  assert.ok(Date.now() - t0 < 400);
});

test('默认 settle=all 保持原样：完整排名，含失败的', async () => {
  const { probeCandidates } = await import('../src/bili.mjs');
  const { cdnCandidates } = await import('../src/cdn.mjs');
  const urls = cdnCandidates(mediaUrl(16));
  const fake = (url, init) =>
    new URL(url).host === 'upos-sz-mirrorcos.bilivideo.com'
      ? okAfter(10)()
      : Promise.resolve(new Response('', { status: 403 }));
  const ranked = await probeCandidates(urls, fake, { timeoutMs: 500 });
  assert.equal(ranked.length, urls.length);
  assert.equal(ranked[0].tag, 'cos');
  assert.ok(ranked.slice(1).every((r) => !r.ok));
});

test('learnAsn 用 first-ok：后台学习不被黑洞节点拖慢', async () => {
  const cache = memCache();
  const base = fakeFetch();
  const impl = (url, init) => {
    const u = new URL(url);
    if (u.pathname.startsWith('/upgcxcode/')) {
      if (u.host === 'upos-sz-mirrorcos.bilivideo.com') return okAfter(10)();
      return hangUntilAbort(url, init);
    }
    return base(url, init);
  };
  const background = [];
  const t0 = Date.now();
  const r1 = await handle(req('/p/BV1GJ411x7h7?qn=16'), {
    cache,
    fetchImpl: impl,
    client: { asn: 4808 },
    waitUntil: (p) => background.push(p),
  });
  assert.equal(r1.status, 302);

  await Promise.all(background);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 900, `后台学习被拖慢了：${elapsed}ms`);
  assert.equal(cache.store.get('cdn:asn:4808').tag, 'cos');
});

test('probeInPage first-ok：书签端也不等黑洞节点', async () => {
  const { probeInPage, cdnCandidates } = await import('../src/cdn.mjs');
  const urls = cdnCandidates(mediaUrl(16));
  const fake = (url, init) => {
    const host = new URL(url).host;
    if (host === 'upos-sz-mirrorhw.bilivideo.com') {
      return new Promise((r) => setTimeout(() => r(new Response('')), 10));
    }
    return new Promise((_, rej) => {
      if (init.signal) init.signal.addEventListener('abort', () => rej(new Error('aborted')));
    });
  };
  const t0 = Date.now();
  const ranked = await probeInPage(urls, {
    settle: 'first-ok',
    graceMs: 100,
    timeoutMs: 2000,
    fetchImpl: fake,
  });
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].tag, 'hw');
  assert.ok(Date.now() - t0 < 500, `实际 ${Date.now() - t0}ms`);
});

// ── 冷启动预算：首次请求不许把播放器拖到超时 ──────────────────

test('冷启动不等 session：指纹/WBI 慢也不影响首包', async () => {
  const calls = [];
  const slowSession = (url) => {
    const u = new URL(url);
    calls.push({ path: u.pathname, headers: {} });
    // spi / nav 慢 150ms
    if (u.pathname.includes('/finger/spi') || u.pathname.includes('/web-interface/nav')) {
      return new Promise((r) => setTimeout(() => r(new Response('{}')), 150));
    }
    return Promise.resolve(new Response(JSON.stringify(PLAY(137649199, 64))));
  };
  const view = async (url, init) => {
    const u = new URL(url);
    calls.push({ path: u.pathname, headers: (init && init.headers) || {} });
    if (u.pathname === '/x/web-interface/view') {
      return new Response(JSON.stringify(VIEW));
    }
    return new Response(JSON.stringify(PLAY(u.searchParams.get('qn') ? 64 : 64)));
  };

  const { resolveDirectUrl } = await import('../src/bili.mjs');
  const t0 = Date.now();
  const r = await resolveDirectUrl({ bvid: 'BV1GJ411x7h7', qn: 64 }, view);
  const elapsed = Date.now() - t0;

  assert.ok(elapsed < 120, `不该等 session，实际 ${elapsed}ms`);
  assert.match(r.url, /bilivideo\.com/);
  const first = calls.find((c) => c.path === '/x/web-interface/view');
  assert.equal(first.headers.Cookie, undefined, '第 0 次不带 Cookie，抢 RTT');
  assert.ok(r.timings && typeof r.timings.totalMs === 'number');
});

test('上游黑洞：预算内快速 504，不再重试到天荒地老', async () => {
  const { resolveDirectUrl } = await import('../src/bili.mjs');
  const hang = (url, init) =>
    new Promise((_, reject) => {
      if (init && init.signal) {
        if (init.signal.aborted) return reject(new Error('TimeoutError'));
        init.signal.addEventListener('abort', () => {
          const e = new Error('The operation was aborted due to timeout');
          e.name = 'TimeoutError';
          reject(e);
        });
      }
    });
  const t0 = Date.now();
  await assert.rejects(
    () => resolveDirectUrl({ bvid: 'BV1GJ411x7h7' }, hang, { budgetMs: 900 }),
    (e) => e.status === 504 && /超时/.test(e.message)
  );
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 1600, `应在预算附近失败，实际 ${elapsed}ms`);
});

test('上游慢但成功：耗时可观测，且不超预算', async () => {
  const { resolveDirectUrl } = await import('../src/bili.mjs');
  const slow = (url) => {
    const u = new URL(url);
    const delay = u.pathname === '/x/web-interface/view' ? 300 : 300;
    const body =
      u.pathname === '/x/web-interface/view'
        ? VIEW
        : PLAY(Number(u.searchParams.get('cid')), Number(u.searchParams.get('qn')));
    return new Promise((r) =>
      setTimeout(() => r(new Response(JSON.stringify(body))), delay)
    );
  };
  const r = await resolveDirectUrl({ bvid: 'BV1GJ411x7h7' }, slow, { budgetMs: 3000 });
  assert.ok(r.timings.totalMs >= 550, JSON.stringify(r.timings));
  assert.ok(r.timings.viewMs >= 280 && r.timings.playMs >= 280);
});

test('X-Bili-Upstream-Ms：现场解析有，缓存命中没有', async () => {
  const cache = memCache();
  const first = await handle(req('/p/BV1GJ411x7h7?qn=16'), { fetchImpl: fakeFetch(), cache });
  assert.equal(first.status, 302);
  assert.ok(Number(first.headers.get('x-bili-upstream-ms')) >= 0);

  const second = await handle(req('/p/BV1GJ411x7h7?qn=16'), { fetchImpl: fakeFetch(), cache });
  assert.equal(second.headers.get('x-bili-upstream-ms'), null);
});

test('冷启动超时：本次快速 504，后台补签写 KV，第二次直接命中', async () => {
  const cache = memCache();
  const slowUpstream = (url) => {
    const u = new URL(url);
    if (u.pathname.includes('/finger/spi') || u.pathname.includes('/web-interface/nav')) {
      return Promise.resolve(new Response('{}'));
    }
    const body =
      u.pathname === '/x/web-interface/view'
        ? VIEW
        : PLAY(Number(u.searchParams.get('cid')), Number(u.searchParams.get('qn')));
    return new Promise((r) => setTimeout(() => r(new Response(JSON.stringify(body))), 700));
  };
  const background = [];
  const opts = {
    cache,
    fetchImpl: slowUpstream,
    coldBudgetMs: 300,
    waitUntil: (p) => background.push(p),
  };

  const t0 = Date.now();
  const r1 = await handle(req('/p/BV1GJ411x7h7?qn=16'), opts);
  const elapsed = Date.now() - t0;
  assert.equal(r1.status, 504);
  assert.match(await r1.text(), /超时/);
  assert.ok(elapsed < 600, `应快速失败，实际 ${elapsed}ms`);
  assert.equal(background.length, 1);
  assert.ok(cache.store.get('warm:BV1GJ411x7h7:1:16'), '应加补签锁，避免并发风暴');

  await Promise.all(background);
  assert.ok(cache.store.get('u:BV1GJ411x7h7:1:16'), '后台应把结果写进缓存');

  const noUpstream = async () => {
    throw new Error('不该再打上游');
  };
  const r2 = await handle(req('/p/BV1GJ411x7h7?qn=16'), { cache, fetchImpl: noUpstream });
  assert.equal(r2.status, 302);
  assert.match(r2.headers.get('location'), /bilivideo\.com/);
});
