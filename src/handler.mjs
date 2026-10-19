// 路由 + 响应。Web 标准 Request/Response，Worker 和 Node 都能跑。

import {
  HttpError,
  cdnCandidates,
  expandShortLink,
  parseTarget,
  probeCandidates,
  resolveDirectUrl,
  selectCandidate,
} from './bili.mjs';
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

/** ASN 偏好记忆时长（秒） */
export const ASN_TTL = 6 * 3600;
/** 探测全失败时的负缓存时长（秒） */
export const ASN_NEG_TTL = 900;
/** 单个候选的探测预算上限（黑洞节点最坏拖到这个数） */
export const PROBE_TIMEOUT_MS = 1500;
/** 首选成功后多等一会，让同时到达的结果进排名；之后放弃慢节点 */
export const PROBE_GRACE_MS = 150;

const nowSec = () => Math.floor(Date.now() / 1000);

const asnKeyOf = (asn) => (asn ? `cdn:asn:${String(asn).trim()}` : null);

const HELP = `${NAME} — bilibili 视频直链短地址

用法（可直接贴进 VRChat / 任何播放器）：
  /p/BV1GJ411x7h7              -> 302 到 CDN 直链（720P）
  /p/BV1GJ411x7h7?p=2          -> 第 2 P
  /p/BV1GJ411x7h7?qn=16        -> 360P（文件小，加载快）
  /player/?url=BV1GJ411x7h7    -> 兼容 91vrchat 的写法
  /player/?url=https://www.bilibili.com/video/BV1GJ411x7h7
  /json/BV1GJ411x7h7           -> 返回调试 JSON（含 url / 标题 / 过期时间）
  /json/BV1GJ411x7h7?probe=1   -> 额外探测各 CDN 候选节点是否可达（排查「别人连不上」）
  /cdn/4837                    -> 查看某个 ASN 记住的 CDN 节点
  /push                        -> POST，浏览器把解析结果推进缓存
  /cache/BV1GJ411x7h7          -> 查看某视频的推送缓存

换 CDN 节点（同一份签名，只换主机名）：
  /p/BV1GJ411x7h7?h=ali        -> 阿里云；h=cos 腾讯云；h=hw 华为云
  /p/BV1GJ411x7h7?h=aliov      -> 海外阿里云；h=cosov 海外腾讯云（给境外/境外线路）
  /p/BV1GJ411x7h7?i=2          -> 按 /json 里 urls 的下标选
  /p/BV1GJ411x7h7?h=cosov&remember=1
                               -> 手动选定并记到该访问者的 ASN（/cdn/<asn> 可查）

不传 h/i 时，若部署端提供了访问者 ASN（Cloudflare Worker），会优先用
该 ASN 记住的节点；没记过就后台探一次（Worker 用 waitUntil，不阻塞本次 302），
把最快的那个记 6 小时。书签在浏览器里探活后会把最快的节点随 /push 上报
（by=client，最准）。

说明：本服务只做「签名」，不中转视频流量，播放在你的播放器与 CDN 之间直连。
链接有效期约 2 小时（bilibili 的 deadline）；过期请重新请求短链，不要转发 302 之后的直链。
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
 *   client?: {asn?: string|number, country?: string, colo?: string},
 *   learn?: boolean,
 *   waitUntil?: (p: Promise<any>) => void,
 * }} [opts] basePath 用于「path 前缀」部署；pushToken 有值时 /push 需要 Bearer
 *           client.asn 有值时启用「按 ASN 记忆最佳 CDN 节点」（learn 控制是否自动探测）
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

  // 访问者身份（Cloudflare 提供 ASN / 国家 / 边缘节点）；本地跑时为空
  const client = opts.client || null;
  const asnKey = asnKeyOf(client && client.asn);
  const learn = opts.learn !== false;

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

  // ── GET /cdn/<asn>：查看某个 ASN 记住的节点 ──────────
  const mn = path.match(/^\/cdn(?:\/(.+))?$/);
  if (mn) {
    const asn = mn[1] ? decodeURIComponent(mn[1]) : client && client.asn;
    const key = asnKeyOf(asn);
    const entry = key && opts.cache ? await safeGet(opts.cache, key) : null;
    return json({
      asn: asn || null,
      key,
      entry,
      note: key
        ? entry
          ? '短链不带 h/i 时会优先用这个节点'
          : '还没记住；首次访问会自动探测，或手动 ?h=xxx&remember=1'
        : '没拿到访问者 ASN（Cloudflare Worker 才会提供）',
    });
  }

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
  // ?h=ali|cos|hw|aliov|cosov|cn-ct ... 或 ?i=<下标> 换 CDN 节点
  const choice = { h: url.searchParams.get('h'), i: url.searchParams.get('i') };
  const explicit = Boolean(choice.h || (choice.i !== null && String(choice.i).trim() !== ''));
  const remember = /^(1|true|yes)$/i.test(url.searchParams.get('remember') || '');
  const wantProbe = /^(1|true|yes)$/i.test(url.searchParams.get('probe') || '');
  const ctx = {
    mode,
    base,
    bvid: null,
    page: 1,
    qn,
    choice,
    explicit,
    remember,
    wantProbe,
    fetchImpl,
    cache: opts.cache,
    asnKey,
    learn,
    client,
    waitUntil: opts.waitUntil || null,
  };

  try {
    const expanded = await expandShortLink(raw, fetchImpl);
    const t = parseTarget(expanded);
    const page = pParam || t.innerPage || 1;
    const bvid = t.bvid || (await aidToBvid(t.aid, fetchImpl));
    Object.assign(ctx, { bvid, page });

    // 1) 精确匹配的推送缓存：命中就完全不用碰 bilibili
    const exact = await lookupPush({ cache: opts.cache, bvid, p: page, qn, exactOnly: true });
    if (exact) {
      return await respond({ ...exact, fromPush: true }, ctx);
    }

    // 2) 没有精确档位，服务端自己解析（可能被风控，看上游心情）
    try {
      const key = `u:${bvid}:${page}:${qn}`;
      let hit = opts.cache ? await opts.cache.get(key) : null;
      if (!hit || !isFresh(hit)) {
        hit = await resolveDirectUrl({ bvid, aid: null, p: page, qn }, fetchImpl);
        if (opts.cache) await opts.cache.put(key, hit, ttlOf(hit));
      }
      return await respond(hit, ctx);
    } catch (err) {
      // 3) 服务端被风控时，退而求其次：用任意档位的推送缓存。
      //    画质可能不是你要的，但至少能播（VRChat 尤其需要这个兜底）。
      const any = await lookupPush({ cache: opts.cache, bvid, p: page, qn });
      if (any) {
        return await respond(
          { ...any, fromPush: true, degraded: any.qn !== qn },
          ctx
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

/** 缓存读写都不应该弄挂请求 */
async function safeGet(cache, key) {
  try {
    return await cache.get(key);
  } catch {
    return null;
  }
}

async function safePut(cache, key, value, ttl) {
  try {
    await cache.put(key, value, ttl);
  } catch {}
}

/**
 * 选节点，优先级：
 *   1) 显式 ?h= / ?i=          （带 remember=1 时顺手记到该 ASN）
 *   2) 该 ASN 记住的节点        （KV / Cache API，找不到就自动探测）
 *   3) 边缘探测最快的节点       （从离访问者较近的 colo 发 6 个 Range 请求，结果记 6 小时）
 *   4) 上游返回的原始节点
 *
 * Worker 默认开启 2/3；Node 本地跑时没有 ASN，直接走 4。
 */
async function pickCdn(urls, ctx) {
  const { explicit, choice, asnKey, cache, learn, remember } = ctx;

  if (explicit) {
    const picked = selectCandidate(urls, choice);
    if (picked && asnKey && cache && remember) {
      await safePut(
        cache,
        asnKey,
        { tag: picked.tag, host: picked.host, at: nowSec(), by: 'manual' },
        ASN_TTL
      );
    }
    return { picked: picked || urls[0], source: 'manual' };
  }

  if (asnKey && cache) {
    const known = await safeGet(cache, asnKey);
    const hit = known && known.tag ? urls.find((c) => c.tag === known.tag) : null;
    if (hit) return { picked: hit, source: 'asn' };
    // 刚探过但全不可达：别每次都再探一遍（负缓存）
    if (known && known.by === 'probe-empty') return { picked: urls[0], source: 'default' };

    if (learn) {
      // 关键：Worker 有 waitUntil 时，探测放到响应之后跑。
      // 这次请求立刻用默认节点 302，下次同 ASN 的请求就能命中记忆。
      if (typeof ctx.waitUntil === 'function') {
        ctx.waitUntil(learnAsn(urls, ctx));
        return { picked: urls[0], source: 'default', learning: true };
      }
      // 本地/自建服务器没有 waitUntil，只能同步探（最坏 PROBE_TIMEOUT_MS）
      const tag = await learnAsn(urls, ctx);
      const learned = tag ? urls.find((c) => c.tag === tag) : null;
      if (learned) return { picked: learned, source: 'probe' };
    }
  }

  return { picked: urls[0], source: 'default' };
}

/**
 * 探一轮并把结果写进 ASN 记忆。返回选中的 tag（全失败返回 null）。
 * 失败也不抛：调用方可能是 waitUntil 里的后台任务。
 */
async function learnAsn(urls, ctx) {
  const { asnKey, cache, fetchImpl } = ctx;
  if (!asnKey || !cache) return null;
  try {
    // 只要冠军：首个成功 + 150ms 收尾，黑洞节点不再拖满 1.5s
    const probe = await probeCandidates(urls, fetchImpl, {
      timeoutMs: PROBE_TIMEOUT_MS,
      settle: 'first-ok',
      graceMs: PROBE_GRACE_MS,
    });
    const best = probe.find((p) => p.ok);
    const hit = best ? urls.find((c) => c.tag === best.tag) : null;
    if (hit) {
      await safePut(
        cache,
        asnKey,
        { tag: hit.tag, host: hit.host, ms: best.ms, at: nowSec(), by: 'probe' },
        ASN_TTL
      );
      return hit.tag;
    }
    await safePut(cache, asnKey, { tag: null, at: nowSec(), by: 'probe-empty' }, ASN_NEG_TTL);
  } catch {}
  return null;
}

/** 统一的响应：302 或 JSON */
async function respond(hit, ctx) {
  const { mode, base, bvid, page, qn, wantProbe, fetchImpl } = ctx;
  // 直链签名是「路径 + 参数」绑定的，换主机名不需要重新签名
  const urls = Array.isArray(hit.urls) && hit.urls.length ? hit.urls : cdnCandidates(hit.url);
  const { picked, source, learning } = await pickCdn(urls, ctx);

  if (mode === 'json') {
    const body = {
      ...hit,
      url: picked.url,
      urls,
      cdn: picked.tag,
      cdnSource: source,
      ...(learning ? { cdnLearning: true } : {}),
      client: ctx.client || null,
      short: `${base}/p/${bvid}?p=${page}&qn=${qn}`,
      expiresInSeconds: hit.deadline ? hit.deadline - Math.floor(Date.now() / 1000) : null,
    };
    if (wantProbe) body.probe = await probeCandidates(urls, fetchImpl);
    return json(body);
  }

  return new Response(null, {
    status: 302,
    headers: cors({
      Location: picked.url,
      // 不让浏览器/播放器缓存这个 302，否则会拿到过期签名
      'Cache-Control': 'no-store, max-age=0',
      'X-Bili-Bvid': bvid,
      'X-Bili-Quality': String(hit.quality || qn),
      'X-Bili-Page': String(page),
      'X-Bili-Cdn': picked.tag,
      'X-Bili-Cdn-Source': source,
      ...(learning ? { 'X-Bili-Cdn-Learning': '1' } : {}),
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

  // 内网/浏览器端探活结果上报：让「这个 ASN 该走哪个 CDN」由访问者自己来教。
  // 只接受当前直链的合法候选 tag，别的一律忽略（不信任客户端给的任意主机）。
  const learned = await learnFromClient(entry.url, payload.cdn, opts);

  return json({
    ok: true,
    key,
    short: shortPath(entry),
    expiresInSeconds: entry.deadline - Math.floor(Date.now() / 1000),
    ...(learned ? { learnedCdn: learned.tag, learnedFor: opts.client && opts.client.asn ? String(opts.client.asn) : null } : {}),
  });
}

/** 客户端上报的最佳节点 -> 写进该访问者 ASN 的记忆（6 小时） */
async function learnFromClient(url, tag, opts) {
  const asnKey = asnKeyOf(opts.client && opts.client.asn);
  if (!asnKey || !opts.cache || !tag) return null;
  const hit = cdnCandidates(url).find((c) => c.tag === String(tag).toLowerCase());
  if (!hit) return null;
  await safePut(
    opts.cache,
    asnKey,
    { tag: hit.tag, host: hit.host, at: Math.floor(Date.now() / 1000), by: 'client' },
    ASN_TTL
  );
  return hit;
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
