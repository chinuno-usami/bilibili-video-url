// 路由 + 响应。Web 标准 Request/Response，Worker 和 Node 都能跑。

import { HttpError, expandShortLink, parseTarget, resolveDirectUrl } from './bili.mjs';
import { BM_HTML, BOOKMARKLET_JS } from './assets.mjs';
import {
  PushError,
  cacheKey,
  entryFromPush,
  isFresh,
  qnCandidates,
  shortPath,
  ttlOf,
} from './store.mjs';

export const NAME = 'bili-302';

const HELP = `${NAME} — bilibili 视频直链短地址

用法（可直接贴进 VRChat / 任何播放器）：
  /p/BV1GJ411x7h7              -> 302 到 CDN 直链（720P）
  /p/BV1GJ411x7h7?p=2          -> 第 2 P
  /p/BV1GJ411x7h7?qn=16        -> 360P（文件小，加载快）
  /player/?url=BV1GJ411x7h7    -> 兼容 91vrchat 的写法
  /player/?url=https://www.bilibili.com/video/BV1GJ411x7h7
  /json/BV1GJ411x7h7           -> 返回调试 JSON（含 url / 标题 / 过期时间）
  /push                        -> POST，浏览器把解析结果推进缓存
  /cache/BV1GJ411x7h7          -> 查看某视频的推送缓存

说明：本服务只做「签名」，不中转视频流量，播放在你的播放器与 CDN 之间直连。
书签小工具：
  /bm                          -> 安装页（拖动按钮到书签栏）
  /bookmarklet.js              -> 书签实际加载的脚本
`;

/** 给了 basePath 时，帮助文案里的路径也补上前缀 */
function helpText(basePath) {
  const p = (basePath || '').replace(/\/+$/, '');
  if (!p) return HELP;
  return HELP.replace(/(^|\n)(\s*)\//g, `$1$2${p}/`);
}

function cors(extra) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Range, Content-Type, Authorization',
    ...extra,
  };
}

function text(body, status = 200) {
  return new Response(body, {
    status,
    headers: cors({ 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }),
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: cors({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }),
  });
}

function asset(body, type, cache = 'no-cache') {
  return new Response(body, {
    status: 200,
    headers: cors({ 'Content-Type': type, 'Cache-Control': cache }),
  });
}

/**
 * @param {Request} req
 * @param {{
 *   cache?: {get(k:string):Promise<any|null>, put(k:string,v:any,ttl:number):Promise<void>},
 *   fetchImpl?: typeof fetch,
 *   basePath?: string,
 *   pushToken?: string,
 * }} [opts] basePath 用于「path 前缀」部署；pushToken 有值时 /push 需要 Bearer
 */
export async function handle(req, opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const url = new URL(req.url);

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors() });
  }

  // 支持 example.com/bili/* 这种前缀部署
  const prefix = (opts.basePath || '').replace(/\/+$/, '');
  let path = url.pathname.replace(/\/+$/, '') || '/';
  if (prefix && (path === prefix || path.startsWith(prefix + '/'))) {
    path = path.slice(prefix.length) || '/';
  }
  const base = url.origin + prefix;

  // ── 静态资源（书签小工具）─────────────────────────────
  if (req.method === 'GET' || req.method === 'HEAD') {
    if (path === '/bookmarklet.js') {
      return asset(BOOKMARKLET_JS, 'application/javascript; charset=utf-8');
    }
    if (path === '/bm' || path === '/bm.html') {
      return asset(BM_HTML, 'text/html; charset=utf-8');
    }
  }

  // ── POST /push：浏览器把解析结果推进缓存 ───────────────
  if (path === '/push') {
    if (req.method !== 'POST') return text('请用 POST', 405);
    return handlePush(req, opts);
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return text('只支持 GET / HEAD / POST /push', 405);
  }

  // ── GET /cache/<bv>：查看推送缓存 ────────────────────
  const mc = path.match(/^\/cache\/(.+)$/);
  if (mc) return handleCacheView(decodeURIComponent(mc[1]), opts);

  // ── 路由 ───────────────────────────────────────────
  let mode = 'redirect';
  let raw = null;

  const m = path.match(/^\/(p|json|player)(?:\/(.*))?$/);
  if (path === '/' || path === '/index.html') return text(helpText(prefix));
  if (path === '/healthz') return text('ok');
  if (!m) return text(helpText(prefix), 404);

  if (m[1] === 'json') mode = 'json';
  if (m[2]) raw = decodeURIComponent(m[2]);
  if (!raw) raw = url.searchParams.get('url') || url.searchParams.get('bv');
  if (!raw) return text(helpText(prefix), 400);

  const pParam = Number(url.searchParams.get('p') || 0) || null;
  const qn = Number(url.searchParams.get('qn') || 0) || 64;

  try {
    const expanded = await expandShortLink(raw, fetchImpl);
    const t = parseTarget(expanded);
    const page = pParam || t.innerPage || 1;
    const bvid = t.bvid || (await aidToBvid(t.aid, fetchImpl));

    // 1) 精确匹配的推送缓存：命中就完全不用碰 bilibili
    const exact = await lookupPush({ cache: opts.cache, bvid, p: page, qn, exactOnly: true });
    if (exact) {
      return respond({ ...exact, fromPush: true }, { mode, base, bvid, page, qn });
    }

    // 2) 没有精确档位，服务端自己解析（可能被风控，看上游心情）
    try {
      const key = `u:${bvid}:${page}:${qn}`;
      let hit = opts.cache ? await opts.cache.get(key) : null;
      if (!hit || !isFresh(hit)) {
        hit = await resolveDirectUrl({ bvid, aid: null, p: page, qn }, fetchImpl);
        if (opts.cache) await opts.cache.put(key, hit, ttlOf(hit));
      }
      return respond(hit, { mode, base, bvid, page, qn });
    } catch (err) {
      // 3) 服务端被风控时，退而求其次：用任意档位的推送缓存。
      //    画质可能不是你要的，但至少能播（VRChat 尤其需要这个兜底）。
      const any = await lookupPush({ cache: opts.cache, bvid, p: page, qn });
      if (any) {
        return respond(
          { ...any, fromPush: true, degraded: any.qn !== qn },
          { mode, base, bvid, page, qn }
        );
      }
      throw err;
    }
  } catch (err) {
    if (err instanceof HttpError || err instanceof PushError) {
      return text(`${err.status} ${err.message}${err.detail ? '\n' + err.detail : ''}`, err.status);
    }
    return text(`500 ${err && err.message ? err.message : String(err)}`, 500);
  }
}

/** 统一的响应：302 或 JSON */
function respond(hit, { mode, base, bvid, page, qn }) {
  if (mode === 'json') {
    return json({
      ...hit,
      short: `${base}/p/${bvid}?p=${page}&qn=${qn}`,
      expiresInSeconds: hit.deadline ? hit.deadline - Math.floor(Date.now() / 1000) : null,
    });
  }
  return new Response(null, {
    status: 302,
    headers: cors({
      Location: hit.url,
      // 不让浏览器/播放器缓存这个 302，否则会拿到过期签名
      'Cache-Control': 'no-store, max-age=0',
      'X-Bili-Bvid': bvid,
      'X-Bili-Quality': String(hit.quality || qn),
      'X-Bili-Page': String(page),
      'X-Bili-Source': hit.fromPush ? 'push' : 'live',
      ...(hit.degraded ? { 'X-Bili-Degraded': '1' } : {}),
    }),
  });
}

/**
 * 在推送缓存里找一条还能用的。
 * exactOnly=true 时只认全部候选档位（不含降级），否则允许任意档位兜底。
 */
async function lookupPush({ cache, bvid, p, qn, exactOnly }) {
  if (!cache || !bvid) return null;
  const wanted = exactOnly ? [Number(qn) || 64] : qnCandidates(qn);
  for (const q of wanted) {
    const e = await cache.get(cacheKey(bvid, p, q));
    if (isFresh(e) && e.source === 'push') return e;
  }
  return null;
}

async function handlePush(req, opts) {
  // 设了 pushToken 就要求带 Bearer，否则谁都能往你缓存里塞东西
  if (opts.pushToken) {
    const auth = req.headers.get('authorization') || '';
    if (auth !== `Bearer ${opts.pushToken}`) {
      return text('401 推送需要 Authorization: Bearer <token>', 401);
    }
  }
  if (!opts.cache) return text('503 本部署没有配置缓存后端，/push 不可用', 503);

  let payload;
  try {
    payload = await req.json();
  } catch {
    return text('400 请求体不是合法 JSON', 400);
  }

  let entry;
  try {
    entry = entryFromPush(payload);
  } catch (err) {
    if (err instanceof PushError) return text(`${err.status} ${err.message}`, err.status);
    return text(`400 ${err.message || err}`, 400);
  }

  const key = cacheKey(entry.bvid, entry.p, entry.qn);
  await opts.cache.put(key, entry, ttlOf(entry));
  return json({
    ok: true,
    key,
    short: shortPath(entry),
    expiresInSeconds: entry.deadline - Math.floor(Date.now() / 1000),
  });
}

async function handleCacheView(raw, opts) {
  if (!opts.cache) return json({ bvid: raw, pushed: [], live: [], note: '本部署没有缓存后端' });
  const t = parseTarget(raw);
  const bvid = t.bvid || (await aidToBvid(t.aid, opts.fetchImpl || fetch));
  const page = t.innerPage || 1;
  const pushed = [];
  const live = [];
  for (const q of qnCandidates(64)) {
    const pe = await opts.cache.get(cacheKey(bvid, page, q));
    if (pe) pushed.push({ qn: q, fresh: isFresh(pe), ...pe });
    const le = await opts.cache.get(`u:${bvid}:${page}:${q}`);
    if (le) live.push({ qn: q, fresh: isFresh(le), ...le });
  }
  return json({
    bvid,
    page,
    // 短链请求会优先用 pushed（不需要访问 bilibili）
    pushed,
    live,
  });
}

/** av 号转 bvid（推送缓存的键统一用 bvid） */
async function aidToBvid(aid, fetchImpl) {
  const res = await fetchImpl(
    `https://api.bilibili.com/x/web-interface/view?aid=${Number(aid)}`,
    { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.bilibili.com/' } }
  );
  const body = await res.json().catch(() => null);
  if (!body || body.code !== 0 || !body.data) {
    throw new HttpError(404, `取视频信息失败 (code=${body && body.code})`, body && body.message);
  }
  return body.data.bvid;
}
