// CDN 候选表 + 选择 / 探活。
//
// 这里的代码同时跑在三个地方，所以只用纯 JS，不碰任何运行时 API：
//   - Worker / Node（`src/bili.mjs` 引用）
//   - 书签脚本（`bookmarklet/build.mjs` 会把本文件去掉 export 后拼进去）
//
// 为什么需要它：playurl 返回的主机名是按「请求方 IP 的省份 + 运营商」挑的，
// 服务端在机房/海外时挑出来的节点，对联通/移动/外省/境外的访问者可能很慢甚至不通。
// 而 upsig 校验的是路径 + 签名参数，不锁主机名 —— 换到镜像主机照样能播。

export const CDN_MIRRORS = [
  { tag: 'ali', host: 'upos-sz-mirrorali.bilivideo.com' },
  { tag: 'cos', host: 'upos-sz-mirrorcos.bilivideo.com' },
  { tag: 'hw', host: 'upos-sz-mirrorhw.bilivideo.com' },
  { tag: '08c', host: 'upos-sz-mirror08c.bilivideo.com' },
  { tag: 'aliov', host: 'upos-sz-mirroraliov.bilivideo.com' }, // 海外（aliyun 国际）
  { tag: 'cosov', host: 'upos-sz-mirrorcosov.bilivideo.com' }, // 海外（腾讯云国际）
];

/** 主机名 -> 短标签，用于 ?h= 选择与响应头 */
export function cdnTagOf(host) {
  const h = String(host || '').toLowerCase();
  const m = CDN_MIRRORS.find((x) => x.host === h);
  if (m) return m.tag;
  const cn = h.match(/^cn-([a-z]+)-([a-z]{2})-/);
  if (cn) return `cn-${cn[2]}`; // cn-ct / cn-cu / cn-cm ...
  return 'auto';
}

/**
 * 一条签名直链 -> 多个等价候选（原节点在前，其余为镜像）。
 * 签名参数原样保留，只换 host，所以不需要再找 bilibili 签名。
 * akamai 系列（*.akamaized.net）的 os/og 家族对不上，会 403，故不列出。
 *
 * @returns {{tag:string, host:string, url:string, primary?:boolean}[]}
 */
export function cdnCandidates(direct) {
  let u;
  try {
    u = new URL(String(direct || ''));
  } catch {
    return [];
  }
  if (!/^https?:$/.test(u.protocol)) return [];

  const out = [{ tag: cdnTagOf(u.host), host: u.host, url: u.toString(), primary: true }];
  const seen = new Set([u.host.toLowerCase()]);
  for (const m of CDN_MIRRORS) {
    if (seen.has(m.host)) continue;
    const v = new URL(u);
    v.host = m.host;
    out.push({ tag: m.tag, host: m.host, url: v.toString() });
    seen.add(m.host);
  }
  return out;
}

/** ?h=ali / ?h=cosov / ?h=cn-ct / ?i=2 选候选；没指定或没匹配就用第一个 */
export function selectCandidate(urls, opts) {
  const o = opts || {};
  if (!Array.isArray(urls) || urls.length === 0) return null;
  // 注意 Number(null) === 0，所以 ?i 缺席时必须跳过，否则会默默选中第 0 个
  const hasIdx = o.i !== null && o.i !== undefined && String(o.i).trim() !== '';
  const idx = hasIdx ? Number(o.i) : NaN;
  if (Number.isInteger(idx) && idx >= 0 && idx < urls.length) return urls[idx];
  if (o.h) {
    const want = String(o.h).toLowerCase();
    const hit = urls.find((c) => c.tag === want) || urls.find((c) => c.host === want);
    if (hit) return hit;
  }
  return urls[0];
}

/**
 * 浏览器端探活：并发打所有候选，按「成功 + 往返快」排序。
 *
 * 用 `mode:'no-cors'`：CDN 不带 CORS 头也能发出去，代价是响应 opaque（读不到
 * 状态码），但「能不能在超时前拿到响应头」已经足够区分可达/不可达和快慢。
 * 拿到响应就 abort，不会真把视频拉下来。
 */
export async function probeInPage(urls, opts) {
  const o = opts || {};
  const list = Array.isArray(urls) ? urls : [];
  const timeoutMs = Number(o.timeoutMs) || 2000;
  const graceMs = Number(o.graceMs) || 0;
  const settle = String(o.settle || 'all').toLowerCase();
  const firstOkMode = settle === 'first-ok' || settle === 'firstok';
  const doFetch = o.fetchImpl || fetch;

  const results = new Array(list.length);
  const ctrls = new Array(list.length);
  const timers = new Array(list.length);
  let done = 0;
  let sawOk = false;
  let earlyTimer = null;
  let resolveEarly = null;
  const early = firstOkMode ? new Promise((r) => { resolveEarly = r; }) : null;

  const one = (c, i) => {
    const started = Date.now();
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    ctrls[i] = ctrl;
    if (ctrl) timers[i] = setTimeout(() => ctrl.abort(), timeoutMs);

    const finish = (ok, err) => {
      clearTimeout(timers[i]);
      results[i] = { tag: c.tag, host: c.host, url: c.url, ok, ms: Date.now() - started, error: err || '' };
      done++;
      if (ok && !sawOk) {
        sawOk = true;
        if (early) {
          if (graceMs > 0) earlyTimer = setTimeout(resolveEarly, graceMs);
          else resolveEarly();
        }
      }
    };

    try {
      return doFetch(c.url, {
        mode: 'no-cors',
        cache: 'no-store',
        signal: ctrl ? ctrl.signal : undefined,
      }).then(
        (res) => {
          // 拿到响应头就中断，别真把视频拉下来
          try {
            if (ctrl) ctrl.abort();
          } catch {}
          finish(true);
        },
        (e) => finish(false, String((e && e.message) || e))
      );
    } catch (e) {
      finish(false, String((e && e.message) || e));
      return Promise.resolve();
    }
  };

  const all = Promise.all(list.map(one));
  all.catch(() => {});

  if (early) {
    await Promise.race([all, early]);
    if (earlyTimer) {
      clearTimeout(earlyTimer);
      earlyTimer = null;
    }
    for (let i = 0; i < list.length; i++) {
      if (!results[i]) {
        clearTimeout(timers[i]);
        if (ctrls[i]) ctrls[i].abort();
      }
    }
  } else {
    await all;
  }

  return results
    .filter(Boolean)
    .sort((a, b) => Number(b.ok) - Number(a.ok) || a.ms - b.ms);
}
