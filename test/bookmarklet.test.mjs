import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extract,
  pathOf,
  apiUrl,
  shortUrl,
  qnLabel,
  humanExpire,
  mixedContentWarning,
  biliApiPath,
  jsonpUrl,
} from '../src/bm-lib.mjs';
import { buildInline, buildLoader } from '../bookmarklet/build.mjs';

test('extract: 各种 bilibili 链接', () => {
  assert.deepEqual(extract('https://www.bilibili.com/video/BV1GJ411x7h7'), {
    bv: 'BV1GJ411x7h7',
    av: null,
    page: 1,
  });
  assert.deepEqual(extract('https://www.bilibili.com/video/BV1GJ411x7h7?p=3&spm_id_from=x'), {
    bv: 'BV1GJ411x7h7',
    av: null,
    page: 3,
  });
  assert.deepEqual(extract('https://www.bilibili.com/video/av80433022/?p=2'), {
    bv: null,
    av: 80433022,
    page: 2,
  });
  assert.equal(extract('https://www.bilibili.com/list/watchlater?bvid=BV1GJ411x7h7').bv, 'BV1GJ411x7h7');
  assert.equal(extract('https://www.bilibili.com/video/AV80433022').av, 80433022);
});

test('extract: 识别不了就返回 null', () => {
  assert.equal(extract('https://example.com/'), null);
  assert.equal(extract('https://www.bilibili.com/'), null);
  assert.equal(extract(''), null);
  assert.equal(extract(null), null);
  // 不能把 "avatar" 里的 av 当成 av 号
  assert.equal(extract('https://example.com/avatar/123'), null);
});

test('pathOf / apiUrl / shortUrl', () => {
  assert.equal(pathOf({ bv: 'BV1GJ411x7h7', av: null }), 'BV1GJ411x7h7');
  assert.equal(pathOf({ bv: null, av: 80433022 }), 'av80433022');
  assert.equal(
    apiUrl('https://h', { bv: 'BV1GJ411x7h7', av: null }, 2, 16),
    'https://h/json/BV1GJ411x7h7?p=2&qn=16'
  );
  assert.equal(
    shortUrl('https://h', { bv: 'BV1GJ411x7h7', av: null }, 1, 64),
    'https://h/p/BV1GJ411x7h7?p=1&qn=64'
  );
});

test('qnLabel / humanExpire', () => {
  assert.equal(qnLabel(64), '720P');
  assert.equal(qnLabel(80), '720P');
  assert.equal(qnLabel(32), '360P');
  assert.equal(humanExpire(7200), '2时00分');
  assert.equal(humanExpire(59), '0分59秒');
  assert.equal(humanExpire(0), '已过期');
  assert.equal(humanExpire(null), '');
});

test('mixedContentWarning: 只在 https 页面 + http 远端时告警', () => {
  assert.match(mixedContentWarning('http://192.168.1.9:8787', 'https:'), /混合内容/);
  assert.equal(mixedContentWarning('http://192.168.1.9:8787', 'http:'), null);
  assert.equal(mixedContentWarning('https://bili.example.com', 'https:'), null);
  assert.equal(mixedContentWarning('http://127.0.0.1:8787', 'https:'), null);
  assert.equal(mixedContentWarning('http://localhost:8787', 'https:'), null);
});

test('buildLoader: 产出可执行的 javascript: URL', () => {
  const bm = buildLoader('https://h/');
  assert.ok(bm.startsWith('javascript:'));
  assert.ok(bm.length < 400);
  const code = bm.slice('javascript:'.length);
  assert.doesNotThrow(() => new Function(code));
  assert.ok(code.includes('https://h/bookmarklet.js'));
});

test('buildInline: 展开后语法有效且带上 base', async () => {
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const here = dirname(fileURLToPath(import.meta.url));
  const lib = await readFile(join(here, '..', 'src', 'bm-lib.mjs'), 'utf8');
  const ui = await readFile(join(here, '..', 'bookmarklet', 'bm-ui.js'), 'utf8');
  const cdn = await readFile(join(here, '..', 'src', 'cdn.mjs'), 'utf8');
  const bm = buildInline(lib, ui, 'https://bili.example.com', '', cdn);
  const code = decodeURIComponent(bm.slice('javascript:'.length));
  assert.doesNotThrow(() => new Function(code));
  assert.ok(!code.includes('__BASE__'));
  assert.ok(code.includes('https://bili.example.com'));
  assert.ok(!/^export /m.test(code));
  // 书签要自己探活，CDN 候选表必须被一起打包进来
  assert.ok(code.includes('function probeInPage'));
  assert.ok(code.includes('function cdnCandidates'));
});

test('jsonpUrl / biliApiPath', () => {
  assert.equal(biliApiPath({ bv: 'BV1GJ411x7h7', av: null }), 'bvid=BV1GJ411x7h7');
  assert.equal(biliApiPath({ bv: null, av: 80433022 }), 'aid=80433022');
  assert.equal(
    jsonpUrl('/x/web-interface/view', 'bvid=BV1GJ411x7h7'),
    'https://api.bilibili.com/x/web-interface/view?bvid=BV1GJ411x7h7&jsonp=jsonp'
  );
});

test('md5 与 node:crypto 一致（WBI 签名依赖它）', async () => {
  const { createHash } = await import('node:crypto');
  const { md5 } = await import('../src/md5.mjs');
  for (const s of ['', 'abc', 'a'.repeat(100), 'x'.repeat(1000), '中文测试']) {
    assert.equal(md5(s), createHash('md5').update(s).digest('hex'));
  }
});

test('WBI mixinKey 与 signQuery 符合官方算法', async () => {
  const { mixinKey, signQuery } = await import('../src/wbi.mjs');
  const img = 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png';
  const sub = 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png';
  const mk = mixinKey(img, sub);
  assert.equal(mk, 'ea1db124af3c7062474693fa704f4ff8');

  // 固定 wts，结果可复现
  const q = signQuery(
    { bvid: 'BV1GJ411x7h7', cid: '137649199', qn: '64', platform: 'html5', high_quality: '1' },
    mk,
    1700000000000
  );
  assert.equal(
    q,
    'bvid=BV1GJ411x7h7&cid=137649199&high_quality=1&platform=html5&qn=64&wts=1700000000' +
      '&w_rid=eae477ed56dda528b11ab4ece1556e67'
  );
});

test('mixinKey: key 太短时返回 null', async () => {
  const { mixinKey } = await import('../src/wbi.mjs');
  assert.equal(mixinKey('https://x/a.png', 'https://x/b.png'), null);
});
