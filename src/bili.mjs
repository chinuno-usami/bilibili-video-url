// Bilibili 直链解析：view -> cid -> playurl(platform=html5) -> durl[0].url
// 只用匿名接口，不涉及任何账号 cookie；单文件 mp4（h264+aac），可直接喂给播放器。

import { mixinKey, signQuery } from './wbi.mjs';

export const BILI = 'https://api.bilibili.com';

// bilibili 对「空 UA」「带 Origin」「爬虫类 UA（python-requests / okhttp / libcurl）」
// 会直接 403 或 412。服务端请求天然没有 Origin，这里把头凑齐成普通浏览器。
export const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
export const REFERER = 'https://www.bilibili.com/';

const BROWSER_HEADERS = {
  'User-Agent': UA,
  Referer: REFERER,
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

const BV_RE = /(BV[0-9A-Za-z]{10})/;
const AV_RE = /(?:^|[^\w])av(\d{1,12})(?![\w])/i;
const QN_RE = /^\d{1,3}$/;

export class HttpError extends Error {
  constructor(status, message, detail) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

// ── 会话信息：buvid3/4 + WBI 密钥 ──────────────────────────────
// buvid 是 bilibili 的设备指纹 cookie，不带它匿名请求更容易被判爬虫。
// WBI 密钥每天轮换，所以带 TTL 缓存。

let session = null; // { buvid3, buvid4, mixin, fetchedAt }
const SESSION_TTL = 30 * 60 * 1000;

async function rawJson(url, fetchImpl, extraHeaders) {
  const res = await fetchImpl(url, {
    headers: { ...BROWSER_HEADERS, ...extraHeaders },
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {}
  return { res, text, body };
}

async function getSession(fetchImpl) {
  if (session && Date.now() - session.fetchedAt < SESSION_TTL) return session;

  const next = { buvid3: null, buvid4: null, mixin: null, fetchedAt: Date.now() };

  // 设备指纹（不需要登录）
  try {
    const { body } = await rawJson(`${BILI}/x/frontend/finger/spi`, fetchImpl);
    if (body && body.code === 0 && body.data) {
      next.buvid3 = body.data.b_3 || null;
      next.buvid4 = body.data.b_4 || null;
    }
  } catch {}

  // WBI 密钥（nav 未登录返回 code -101，但 wbi_img 照样有）
  try {
    const { body } = await rawJson(`${BILI}/x/web-interface/nav`, fetchImpl);
    const w = body && body.data && body.data.wbi_img;
    if (w) next.mixin = mixinKey(w.img_url, w.sub_url);
  } catch {}

  session = next;
  return session;
}

/** 让缓存立刻失效，下次重取 buvid 与 WBI 密钥 */
export function resetSession() {
  session = null;
}

function cookieOf(s) {
  const parts = [];
  if (s && s.buvid3) parts.push(`buvid3=${s.buvid3}`);
  if (s && s.buvid4) parts.push(`buvid4=${s.buvid4}`);
  return parts.length ? parts.join('; ') : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 带重试与多端点回退的 GET。
 * bilibili 的 412 有两种：UA 黑名单（HTML）与风控 ban（JSON code -412）。
 * 两者的共同解法是「换一套指纹 + 换一条路径」再试。
 */
async function apiGet(pathBase, params, fetchImpl, { attempts = 3 } = {}) {
  let last = null;

  for (let i = 0; i < attempts; i++) {
    const s = await getSession(fetchImpl);
    const cookie = cookieOf(s);

    // 第 3 次起换回不带 WBI 的端点（签名反而可能因 wts 触发校验）
    const useWbi = i < 2 && s.mixin;
    const url = useWbi
      ? `${BILI}${pathBase.replace('/x/player/playurl', '/x/player/wbi/playurl')}?${signQuery(params, s.mixin)}`
      : `${BILI}${pathBase}?${new URLSearchParams(params).toString()}`;

    const { res, text, body } = await rawJson(
      url,
      fetchImpl,
      cookie ? { Cookie: cookie } : undefined
    );
    last = { status: res.status, text, body };

    if (res.ok && body && body.code === 0) return body;

    // 视频本身的问题（不存在 / 无权限）不必重试
    if (body && body.code !== 0 && body.code !== -412 && body.code !== -352) {
      return body;
    }

    // 指纹或密钥可能过期，下一次循环重取
    resetSession();
    if (i < attempts - 1) await sleep(300 * (i + 1));
  }

  const body = last && last.body;
  if (last && last.status === 412) {
    const banned = body && body.code === -412;
    throw new HttpError(
      502,
      banned
        ? 'bilibili 风控拦截了本服务的出口 IP（code -412）'
        : 'bilibili 拒绝了本服务的请求（HTTP 412）',
      [
        banned
          ? '这通常发生在机房 IP（如 Cloudflare Worker）或短时间请求过多时。'
          : '通常是 UA/请求头被判定为爬虫。',
        '可以稍后重试；或在浏览器打开本页用「页面内解析」模式（书签会自动回退）。',
        `上游原文：${(last.text || '').replace(/\s+/g, ' ').slice(0, 160)}`,
      ].join('\n')
    );
  }
  throw new HttpError(502, `上游返回异常（HTTP ${last ? last.status : '?'}）`, (last && last.text || '').slice(0, 200));
}

/** 从各种输入里抠出 bvid / aid 和分P */
export function parseTarget(raw) {
  const input = String(raw || '').trim();
  if (!input) throw new HttpError(400, '缺少 url 参数');

  const bv = input.match(BV_RE);
  if (bv) {
    const innerPage = input.match(/[?&]p=(\d{1,4})/);
    return { bvid: bv[1], aid: null, innerPage: innerPage ? Number(innerPage[1]) : null };
  }

  const av = input.match(AV_RE);
  if (av) return { bvid: null, aid: Number(av[1]), innerPage: null };

  throw new HttpError(400, '只认 BV 号 / av 号 / 含 BV 号的 bilibili 链接');
}

/** b23.tv 短链 -> 真实链接（跟随跳转，只在服务端做） */
export async function expandShortLink(input, fetchImpl) {
  const s = String(input || '');
  if (!/^https?:\/\/b23\.tv\//i.test(s.trim())) return s;
  try {
    const r = await fetchImpl(s.trim(), {
      method: 'GET',
      redirect: 'follow',
      headers: BROWSER_HEADERS,
    });
    return r.url || s;
  } catch {
    return s;
  }
}

/**
 * 核心：BV/av + 分P + 清晰度 -> 签名直链
 * @returns {{url:string, quality:number, acceptQuality:number[], title:string, bvid:string, cid:number, p:number, deadline:number|null}}
 */
export async function resolveDirectUrl({ bvid, aid, p = 1, qn = 64 }, fetchImpl = fetch) {
  const q = QN_RE.test(String(qn)) ? Number(qn) : 64;

  // 1) 取 cid（分P 必须靠 pages[p-1].cid，playurl 不认 p 参数）
  const view = await apiGet(
    '/x/web-interface/view',
    bvid ? { bvid } : { aid: String(aid) },
    fetchImpl
  );
  if (!view.data) {
    throw new HttpError(404, `取视频信息失败 (code=${view.code})`, view.message);
  }

  const data = view.data;
  const pages = Array.isArray(data.pages) ? data.pages : [];
  const page = pages[p - 1] || (p === 1 ? { cid: data.cid } : null);
  if (!page || !page.cid) {
    throw new HttpError(404, `没有第 ${p} P（共 ${pages.length || 1} P）`);
  }

  // 2) 取播放地址：platform=html5 才会返回单文件 mp4 的 durl
  const play = await apiGet(
    '/x/player/playurl',
    {
      bvid: data.bvid,
      cid: String(page.cid),
      qn: String(q),
      platform: 'html5',
      high_quality: '1',
    },
    fetchImpl
  );

  if (!play.data) {
    throw new HttpError(404, `取播放地址失败 (code=${play.code})`, play.message);
  }

  const d = play.data;
  const direct = d.durl && d.durl[0] && d.durl[0].url;
  if (!direct) {
    // 有 dash 没 durl：通常是需要登录/大会员，或投稿被限制
    throw new HttpError(
      403,
      d.dash ? '该视频只给 DASH（音视频分离），需要登录态' : '没有可用的直链',
      `accept_quality=${JSON.stringify(d.accept_quality || [])}`
    );
  }

  let deadline = null;
  try {
    deadline = Number(new URL(direct).searchParams.get('deadline')) || null;
  } catch {}

  return {
    url: direct,
    quality: d.quality,
    acceptQuality: d.accept_quality || [],
    title: data.title,
    owner: data.owner && data.owner.name,
    bvid: data.bvid,
    cid: page.cid,
    p: Number(p),
    deadline,
  };
}
