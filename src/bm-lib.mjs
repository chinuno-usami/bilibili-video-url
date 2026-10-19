// 纯函数，无 DOM 依赖：既能被测试直接 import，也会被拼进书签脚本里。

export const BV_RE = /(BV[0-9A-Za-z]{10})/;
export const AV_RE = /(?:^|[^\w])av(\d{1,12})(?![\w])/i;

/** 从任意 href 里抠出 BV/av 和分P */
export function extract(href) {
  const s = String(href || '');
  const m = s.match(/[?&]p=(\d{1,4})/);
  const page = m ? Number(m[1]) : 1;
  const bv = s.match(BV_RE);
  if (bv) return { bv: bv[1], av: null, page };
  const av = s.match(AV_RE);
  if (av) return { bv: null, av: Number(av[1]), page };
  return null;
}

export function pathOf(t) {
  return t.bv ? t.bv : 'av' + t.av;
}

/** 调试接口：返回 JSON（含直链、标题、剩余寿命） */
export function apiUrl(base, t, page, qn) {
  return base + '/json/' + encodeURIComponent(pathOf(t)) + '?p=' + page + '&qn=' + qn;
}

/** 短地址：贴进播放器用的那种，302 到直链 */
export function shortUrl(base, t, page, qn) {
  return base + '/p/' + pathOf(t) + '?p=' + page + '&qn=' + qn;
}

export function qnLabel(qn) {
  return Number(qn) >= 64 ? '720P' : '360P';
}

// ── 页面内回退解析 ────────────────────────────────────────────
// 服务端被封（Cloudflare Worker 出口 IP 常见）时，改由浏览器直接请求。
// playurl 只认 Referer 是不是 bilibili，而书签正好跑在 bilibili 页面里；
// 用 JSONP 可以绕过 CORS，且蹭到用户自己的登录 cookie。

export function biliApiPath(t) {
  return t.bv ? 'bvid=' + encodeURIComponent(t.bv) : 'aid=' + Number(t.av);
}

/** 拼一个 JSONP URL */
export function jsonpUrl(path, params) {
  return 'https://api.bilibili.com' + path + '?' + params + '&jsonp=jsonp';
}

/** 在页面里加载 JSONP，超时/报错都 reject */
export function jsonp(url, timeout) {
  return new Promise(function (resolve, reject) {
    var cb = '__bili302_cb_' + Math.random().toString(36).slice(2);
    var s = document.createElement('script');
    var done = false;
    var timer = setTimeout(function () {
      finish(new Error('请求超时（可能被广告拦截器或网络阻断）'));
    }, timeout || 12000);

    function finish(err, data) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        delete window[cb];
      } catch (e) {
        window[cb] = undefined;
      }
      s.remove();
      err ? reject(err) : resolve(data);
    }

    window[cb] = function (d) {
      finish(null, d);
    };
    s.onerror = function () {
      finish(new Error('JSONP 加载失败'));
    };
    s.src = url + '&callback=' + cb;
    (document.head || document.documentElement).appendChild(s);
  });
}

/** 页面内解析：view -> cid -> playurl(platform=html5) -> durl[0].url */
export async function resolveInPage(t, page, qn) {
  var who = biliApiPath(t);
  var view = await jsonp(jsonpUrl('/x/web-interface/view', who));
  if (!view || view.code !== 0 || !view.data) {
    throw new Error('取视频信息失败 (code=' + (view && view.code) + ')');
  }
  var d = view.data;
  var pages = d.pages || [];
  var one = pages[page - 1] || (page === 1 ? { cid: d.cid } : null);
  if (!one || !one.cid) throw new Error('没有第 ' + page + ' P');

  var q =
    'cid=' + one.cid + '&qn=' + qn + '&platform=html5&high_quality=1&' + biliApiPath({ bv: d.bvid, av: null });
  var play = await jsonp(jsonpUrl('/x/player/playurl', q));
  if (!play || play.code !== 0 || !play.data) {
    throw new Error('取播放地址失败 (code=' + (play && play.code) + ')');
  }
  var url = play.data.durl && play.data.durl[0] && play.data.durl[0].url;
  if (!url) throw new Error(play.data.dash ? '该视频只给 DASH，需要登录' : '没有直链');

  var deadline = null;
  try {
    deadline = Number(new URL(url).searchParams.get('deadline')) || null;
  } catch (e) {}

  return {
    url: url,
    quality: play.data.quality,
    acceptQuality: play.data.accept_quality || [],
    title: d.title,
    owner: d.owner && d.owner.name,
    bvid: d.bvid,
    cid: one.cid,
    p: page,
    deadline: deadline,
    inPage: true,
  };
}

export function humanExpire(sec) {
  if (sec === null || sec === undefined) return '';
  if (sec <= 0) return '已过期';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h
    ? h + '时' + String(m).padStart(2, '0') + '分'
    : m + '分' + String(s).padStart(2, '0') + '秒';
}

/** https 页面不能请求 http 服务（localhost 例外），提前给出人话提示 */
export function mixedContentWarning(base, proto) {
  const p = proto || (typeof location !== 'undefined' ? location.protocol : 'https:');
  if (p !== 'https:') return null;
  if (!/^http:\/\//i.test(base)) return null;
  if (/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(base)) return null;
  return (
    '当前页面是 https，浏览器会拦掉对 ' +
    base.replace(/^https?:\/\//, '') +
    ' 的请求（混合内容）。\n\n改用 https 地址（如 Cloudflare Worker），或 http://127.0.0.1:8787。'
  );
}
