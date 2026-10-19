import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PushError,
  validateMediaUrl,
  entryFromPush,
  cacheKey,
  qnCandidates,
  isFresh,
  ttlOf,
  shortPath,
} from '../src/store.mjs';

const NOW = 1800000000000; // 固定时间，避免测试抖动
const dl = Math.floor(NOW / 1000) + 3600;

const goodUrl =
  `https://upos-sz-mirrorcos.bilivideo.com/upgcxcode/99/91/137649199/137649199_da2-1-192.mp4` +
  `?e=xx&upsig=abcdef&deadline=${dl}&platform=html5`;

test('validateMediaUrl: 接受合法直链', () => {
  const r = validateMediaUrl(goodUrl, NOW);
  assert.equal(r.deadline, dl);
  assert.match(r.url, /^https:\/\/upos-sz-mirrorcos\.bilivideo\.com\//);
});

test('validateMediaUrl: 拒绝非法输入', () => {
  const bad = [
    ['', /缺少 url/],
    ['not a url', /不是合法地址/],
    ['http://upos-sz.bilivideo.com/upgcxcode/1/2/3.mp4?upsig=a&deadline=' + dl, /只接受 https/],
    ['https://evil.com/upgcxcode/1/2/3.mp4?upsig=a&deadline=' + dl, /不接受该域名/],
    ['https://upos-sz.bilivideo.com/other/1.mp4?upsig=a&deadline=' + dl, /不像 bilibili/],
    ['https://upos-sz.bilivideo.com/upgcxcode/1/2/3.mp4?deadline=' + dl, /缺少 upsig/],
    ['https://upos-sz.bilivideo.com/upgcxcode/1/2/3.mp4?upsig=a', /缺少 deadline/],
    ['https://upos-sz.bilivideo.com/upgcxcode/1/2/3.mp4?upsig=a&deadline=1', /已过期/],
    ['x'.repeat(3000), /太长/],
  ];
  for (const [url, re] of bad) {
    assert.throws(() => validateMediaUrl(url, NOW), re, `应当拒绝: ${url.slice(0, 60)}`);
  }
});

test('validateMediaUrl: 防开放跳转（子域名伪装、协议绕过）', () => {
  for (const host of [
    'bilivideo.com.evil.dev',
    'evilbilivideo.com',
    'upos.bilivideo.com.evil.dev',
  ]) {
    assert.throws(
      () => validateMediaUrl(`https://${host}/upgcxcode/1.mp4?upsig=a&deadline=${dl}`, NOW),
      /不接受该域名/
    );
  }
  // 合法子域名应该通过
  for (const host of ['upos-sz.bilivideo.com', 'cn-hbyc-ct-01-02.bilivideo.com', 'b-baaa1gvj119u1.bilivideo.com']) {
    assert.doesNotThrow(() =>
      validateMediaUrl(`https://${host}/upgcxcode/1.mp4?upsig=a&deadline=${dl}`, NOW)
    );
  }
});

test('entryFromPush: 组装条目', () => {
  const e = entryFromPush(
    {
      bvid: 'BV1GJ411x7h7',
      p: '2',
      qn: '64',
      cid: '137649199',
      title: 'x'.repeat(300),
      acceptQuality: [64, 16],
      url: goodUrl,
    },
    NOW
  );
  assert.equal(e.bvid, 'BV1GJ411x7h7');
  assert.equal(e.p, 2);
  assert.equal(e.qn, 64);
  assert.equal(e.source, 'push');
  assert.equal(e.title.length, 200); // 标题截断
  assert.deepEqual(e.acceptQuality, [64, 16]);
});

test('entryFromPush: 参数校验', () => {
  const base = { bvid: 'BV1GJ411x7h7', p: 1, qn: 64, url: goodUrl };
  assert.throws(() => entryFromPush({ ...base, bvid: 'av123' }, NOW), /bvid 不合法/);
  assert.throws(() => entryFromPush({ ...base, p: 0 }, NOW), /p 不合法/);
  assert.throws(() => entryFromPush({ ...base, qn: 0 }, NOW), /qn 不合法/);
});

test('cacheKey / shortPath / qnCandidates', () => {
  assert.equal(cacheKey('BV1GJ411x7h7', 1, 64), 'BV1GJ411x7h7:1:64');
  assert.equal(shortPath({ bvid: 'BV1GJ411x7h7', p: 2, qn: 16 }), '/p/BV1GJ411x7h7?p=2&qn=16');
  assert.deepEqual(qnCandidates(16), [16, 64, 80, 32, 112, 120]);
  assert.deepEqual(qnCandidates(64), [64, 80, 16, 32, 112, 120]);
});

test('isFresh / ttlOf', () => {
  const fresh = { url: goodUrl, deadline: dl };
  const stale = { url: goodUrl, deadline: Math.floor(NOW / 1000) + 10 };
  assert.equal(isFresh(fresh, NOW), true);
  assert.equal(isFresh(stale, NOW), false);
  assert.equal(isFresh(null, NOW), false);
  assert.equal(isFresh({ url: goodUrl }, NOW), true); // 没 deadline 交给存储层

  assert.ok(ttlOf(fresh, NOW) <= 3600);
  assert.ok(ttlOf(fresh, NOW) >= 60);
  // 剩余寿命很短时给最小 60s，避免存了就过期
  assert.equal(ttlOf({ deadline: Math.floor(NOW / 1000) + 40 }, NOW), 60);
});
