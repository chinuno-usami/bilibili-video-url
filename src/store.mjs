// 「推送缓存」的校验与键规则。
//
// 思路：书签在浏览器里解析出直链后，把结果 POST 给服务存起来。
// VRChat 请求短链时先查这份缓存，命中就直接 302，服务端完全不碰 bilibili。
// 这样即使 Worker 出口 IP 被风控（-412），VRChat 仍然能播。

/** 只允许 bilibili 自家的 CDN 域名，防止把短链变成任意的开放跳转 */
const ALLOWED_HOSTS = [
  /(^|\.)bilivideo\.com$/i,
  /(^|\.)bilivideo\.cn$/i,
  /(^|\.)hdslb\.com$/i,
  /(^|\.)akamaized\.net$/i,
];

export class PushError extends Error {
  constructor(status, message, detail) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

export const MAX_URL_LEN = 2048;

/**
 * 校验客户端推上来的直链。
 * 不校验签名（没有密钥），但要求：https、CDN 白名单、upgcxcode 路径、
 * 带 upsig 与未来的 deadline。这样既挡住开放跳转，也挡住过期数据。
 *
 * @returns {{url:string, deadline:number}} deadline 是 unix 秒
 */
export function validateMediaUrl(raw, now = Date.now()) {
  const s = String(raw || '').trim();
  if (!s) throw new PushError(400, '缺少 url');
  if (s.length > MAX_URL_LEN) throw new PushError(400, 'url 太长');

  let u;
  try {
    u = new URL(s);
  } catch {
    throw new PushError(400, 'url 不是合法地址');
  }

  if (u.protocol !== 'https:') throw new PushError(400, '只接受 https 直链');
  if (!ALLOWED_HOSTS.some((re) => re.test(u.hostname))) {
    throw new PushError(400, `不接受该域名：${u.hostname}`);
  }
  if (!/\/upgcxcode\//.test(u.pathname)) {
    throw new PushError(400, '路径不像 bilibili 的媒体直链');
  }
  if (!u.searchParams.get('upsig')) throw new PushError(400, '直链缺少 upsig');

  const deadline = Number(u.searchParams.get('deadline')) || 0;
  const nowSec = Math.floor(now / 1000);
  if (!deadline) throw new PushError(400, '直链缺少 deadline');
  if (deadline <= nowSec + 30) {
    throw new PushError(400, `直链已过期（deadline 剩 ${deadline - nowSec}s）`);
  }

  return { url: u.toString(), deadline };
}

export const cacheKey = (bvid, p, qn) => `${bvid}:${Number(p) || 1}:${Number(qn) || 64}`;

/** 查缓存时依次尝试的 qn：先精确，再退到常见档位 */
export function qnCandidates(qn) {
  const first = Number(qn) || 64;
  return [...new Set([first, 64, 80, 16, 32, 112, 120])];
}

/** 条目是否还能用（留 30s 余量，避免刚好卡在过期边缘） */
export function isFresh(entry, now = Date.now()) {
  if (!entry || !entry.url) return false;
  if (!entry.deadline) return true; // 没记 deadline 就交给存储层 TTL
  return entry.deadline * 1000 > now + 30 * 1000;
}

/** 存储 TTL：直链剩余寿命和上限取小，再留 30s 安全边界 */
export function ttlOf(entry, now = Date.now(), maxTtl = 7200) {
  const nowSec = Math.floor(now / 1000);
  const left = entry.deadline ? entry.deadline - nowSec - 30 : maxTtl;
  return Math.max(60, Math.min(maxTtl, left));
}

/** 把推送进来的 payload 变成要存的条目 */
export function entryFromPush(payload, now = Date.now()) {
  const bvid = String(payload.bvid || '').trim();
  if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) {
    throw new PushError(400, 'bvid 不合法');
  }
  const p = Number(payload.p) || 1;
  const qn = Number(payload.qn) || 64;
  // 注意：0/负数会被 || 兜掉，所以这里要校验原始值
  if (payload.p !== undefined && (Number.isNaN(Number(payload.p)) || Number(payload.p) < 1 || Number(payload.p) > 9999)) {
    throw new PushError(400, 'p 不合法');
  }
  if (payload.qn !== undefined && (Number.isNaN(Number(payload.qn)) || Number(payload.qn) < 1 || Number(payload.qn) > 999)) {
    throw new PushError(400, 'qn 不合法');
  }

  const { url, deadline } = validateMediaUrl(payload.url, now);

  return {
    url,
    deadline,
    bvid,
    p,
    qn,
    quality: Number(payload.quality) || qn,
    cid: payload.cid ? Number(payload.cid) : null,
    title: payload.title ? String(payload.title).slice(0, 200) : '',
    acceptQuality: Array.isArray(payload.acceptQuality)
      ? payload.acceptQuality.map(Number).slice(0, 12)
      : [],
    pushedAt: Math.floor(now / 1000),
    source: 'push',
  };
}

export function shortPath(entry) {
  return `/p/${entry.bvid}?p=${entry.p}&qn=${entry.qn}`;
}
