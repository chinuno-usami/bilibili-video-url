// 书签脚本的 UI 部分（classic script，和 bm-lib 拼在一起跑）。
// base 从自身 src 推断，所以同一个文件可以被任意域名部署。

// >>>BASE  （buildInline 会把这一整块换成一个常量字符串）
var BASE = (function () {
  if (typeof window !== 'undefined' && window.__BILI302_BASE__) return window.__BILI302_BASE__;
  var s = document.currentScript && document.currentScript.src;
  if (!s) return '';
  return s.replace(/\/bookmarklet\.js(?:[?#].*)?$/, '');
})();
// <<<BASE

// 可选：服务端设了 PUSH_TOKEN 时，在书签里把它填上（可通过 localStorage 预置）
var TOKEN =
  (typeof window !== 'undefined' && window.__BILI302_TOKEN__) ||
  (function () {
    try {
      return localStorage.getItem('bili302_push_token') || '';
    } catch (e) {
      return '';
    }
  })();

var CSS =
  '.m{position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:flex-start;justify-content:center;padding-top:12vh;font:14px/1.6 -apple-system,"PingFang SC",system-ui,sans-serif}' +
  '.c{width:min(560px,92vw);background:#16181d;color:#e8eaed;border:1px solid #2b2f38;border-radius:12px;box-shadow:0 18px 60px rgba(0,0,0,.6);padding:16px 18px 14px}' +
  '.h{display:flex;gap:10px;align-items:flex-start}' +
  '.t{flex:1;font-weight:600;font-size:15px;line-height:1.45;max-height:2.9em;overflow:hidden}' +
  '.x{cursor:pointer;color:#8b93a1;font-size:20px;line-height:1;padding:0 4px;background:none;border:0}' +
  '.x:hover{color:#fff}' +
  '.meta{margin:8px 0 6px;color:#8b93a1;font-size:12px}' +
  '.r{display:flex;gap:8px;margin-top:10px;align-items:center}' +
  '.i{flex:1;min-width:0;background:#0d0f13;color:#7ee787;border:1px solid #2b2f38;border-radius:7px;padding:8px 10px;font:12px/1.4 ui-monospace,Menlo,monospace}' +
  '.b{cursor:pointer;border:1px solid #2b2f38;background:#1f232b;color:#e8eaed;border-radius:7px;padding:7px 11px;font-size:12px;white-space:nowrap}' +
  '.b:hover{background:#282d36}' +
  '.b:disabled{opacity:.45;cursor:default}' +
  '.b.on{background:#1d3a5c;border-color:#2c5c92}' +
  '.s{margin-top:9px;font-size:12px;color:#8b93a1;min-height:1.5em;word-break:break-all}' +
  '.s.e{color:#ff8f8f}.s.k{color:#7ee787}' +
  '.tip{margin-top:8px;font-size:11px;color:#5f6673}';

var HTML =
  '<div class="m"><div class="c">' +
  '<div class="h"><div class="t" id="t">解析中…</div><button class="x" id="x" title="关闭 (Esc)">×</button></div>' +
  '<div class="meta" id="meta"></div>' +
  '<div class="r"><input class="i" id="short" readonly spellcheck="false" placeholder="短地址"><button class="b on" id="cs">复制短链</button></div>' +
  '<div class="r"><input class="i" id="direct" readonly spellcheck="false" placeholder="CDN 直链"><button class="b" id="cd">复制直链</button></div>' +
  '<div class="r"><button class="b" id="q64">720P</button><button class="b" id="q16">360P</button><button class="b" id="op">打开直链</button><button class="b" id="js">原始 JSON</button></div>' +
  '<div class="s" id="s"></div>' +
  '<div class="tip">短链长期有效（每次实时签名）；直链 2 小时过期。VRChat 里贴短链。</div>' +
  '</div></div>';

function copy(text) {
  return navigator.clipboard.writeText(text).then(
    function () {
      return true;
    },
    function () {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;top:-9999px;opacity:0';
      document.documentElement.appendChild(ta);
      ta.select();
      var ok = false;
      try {
        ok = document.execCommand('copy');
      } catch (e) {}
      ta.remove();
      return ok;
    }
  );
}

function boot() {
  var t = extract(location.href);
  if (!t) {
    var v = prompt('没识别到 BV 号。粘贴 B 站链接或 BV / av 号：', '');
    t = extract(v);
  }
  if (!t) return alert('没识别到 BV 号');

  var warn = mixedContentWarning(BASE);
  if (warn && !confirm(warn + '\n\n仍然尝试？')) return;

  var old = document.getElementById('__bili302');
  if (old) old.remove();

  var host = document.createElement('div');
  host.id = '__bili302';
  host.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647';
  var sh = host.attachShadow({ mode: 'open' });
  sh.innerHTML = '<style>' + CSS + '</style>' + HTML;
  (document.body || document.documentElement).appendChild(host);

  var $ = function (s) {
    return sh.querySelector(s);
  };
  var st = { page: t.page || 1, qn: 64, data: null };

  function onKey(e) {
    if (e.key === 'Escape') close();
  }
  function close() {
    host.remove();
    document.removeEventListener('keydown', onKey);
  }
  document.addEventListener('keydown', onKey);
  $('#x').onclick = close;
  sh.querySelector('.m').onclick = function (e) {
    if (e.target.className === 'm') close();
  };

  function say(msg, cls) {
    var el = $('#s');
    el.textContent = msg || '';
    el.className = 's' + (cls ? ' ' + cls : '');
  }

  function paint() {
    $('#short').value = shortUrl(BASE, t, st.page, st.qn);
    $('#direct').value = (st.data && st.data.url) || '';
    $('#q64').className = 'b' + (st.qn >= 64 ? ' on' : '');
    $('#q16').className = 'b' + (st.qn < 64 ? ' on' : '');
  }

  // 无论走服务端还是页面内解析，都把结果推一份到服务端缓存。
  // 这样下次 VRChat 请求短链时，服务端可以直接 302，不用再打 bilibili。
  function cacheToServer(d) {
    return pushToServer(BASE, pushPayload(d, t, st.page, st.qn), { token: TOKEN }).then(
      function (r) {
        return r;
      },
      function (e) {
        // 推送失败不影响用户拿直链，只是短链仍然依赖服务端实时解析
        return { ok: false, error: e && e.message ? e.message : String(e) };
      }
    );
  }

  function render(d) {
    st.data = d;
    $('#t').textContent = d.title || '(无标题)';
    var expires =
      d.expiresInSeconds != null
        ? d.expiresInSeconds
        : d.deadline
          ? d.deadline - Math.floor(Date.now() / 1000)
          : null;
    $('#meta').textContent =
      (d.bvid || t.bv || 'av' + t.av) +
      ' · 第 ' + d.p + ' P · ' + qnLabel(d.quality) + ' (qn=' + d.quality + ')' +
      (d.acceptQuality && d.acceptQuality.length ? ' · 可选 ' + d.acceptQuality.join('/') : '') +
      (d.cdn ? ' · CDN ' + d.cdn + (d.cdnMs != null ? '(' + d.cdnMs + 'ms)' : '') : '') +
      (expires != null ? ' · 直链剩 ' + humanExpire(expires) : '') +
      (d.inPage ? ' · 页面内解析' : '');
    paint();
    return d;
  }

  function cdnNote(d) {
    if (!d.cdn) return '';
    return '节点 ' + d.cdn + (d.cdnMs != null ? ' (' + d.cdnMs + 'ms)' : '');
  }

  function readyText(d, extra) {
    return ['就绪', cdnNote(d), extra].filter(Boolean).join(' · ');
  }

  // 用访问者自己的网络挑 CDN 节点：服务端出口可能是机房/海外，它挑的节点
  // 对联通/移动/境外不一定通。探活结果会随 /push 上报，服务端按 ASN 记住。
  function chooseBest(d) {
    var urls = d.urls && d.urls.length ? d.urls : cdnCandidates(d.url);
    if (!urls || urls.length < 2) return Promise.resolve(d);
    say('按你的网络挑最快的 CDN 节点…');
    return probeInPage(urls, { settle: 'first-ok', graceMs: 150 })
      .then(function (ranked) {
        var best = (ranked || []).filter(function (r) {
          return r.ok;
        })[0];
        if (best) {
          d.cdn = best.tag;
          d.cdnMs = best.ms;
          d.url = best.url;
          render(d);
        } else {
          say('所有节点都没探通，先按默认节点走');
        }
        return d;
      })
      .catch(function () {
        return d;
      });
  }

  function serverless() {
    return resolveInPage(t, st.page, st.qn).then(function (d) {
      render(d);
      return chooseBest(d)
        .then(function () {
          return cacheToServer(d);
        })
        .then(function (r) {
          say(
            readyText(
              d,
              r.ok ? '已缓存到服务端，VRChat 可直接用短链' : '缓存到服务端失败：' + r.error
            ),
            r.ok ? 'k' : 'e'
          );
        });
    });
  }

  function load() {
    $('#q64').disabled = $('#q16').disabled = true;
    say('解析中…');
    fetch(apiUrl(BASE, t, st.page, st.qn), { cache: 'no-store' })
      .then(function (r) {
        return r.text().then(function (txt) {
          if (!r.ok) {
            var err = new Error(txt.slice(0, 300));
            err.upstream = true;
            throw err;
          }
          return JSON.parse(txt);
        });
      })
      .then(function (d) {
        render(d);
        // 先用访问者自己的网络挑节点，再把它连同直链一起 push 给服务端
        return chooseBest(d).then(function () {
          return cacheToServer(d).then(function (r) {
            say(readyText(d, r.ok ? '已缓存' : ''), 'k');
          });
        });
      })
      .catch(function (e) {
        // 服务端不可用（502 风控 / 服务没起来 / 混合内容 / 404）时，一律改由页面自己解析：
        // 书签跑在 bilibili 域下，playurl 需要的 Referer 天然满足，
        // JSONP 绕过 CORS，还能蹭到用户自己的登录 cookie。
        say('服务端不可用，改由本页直接解析…');
        return serverless().catch(function (e2) {
          $('#t').textContent = '解析失败';
          say(
            '失败：' + (e2 && e2.message ? e2.message : String(e2)) +
              '\n服务端原因：' + (e && e.message ? e.message.split('\n')[0] : String(e)),
            'e'
          );
        });
      })
      .then(function () {
        $('#q64').disabled = $('#q16').disabled = false;
      });
  }

  $('#q64').onclick = function () {
    if (st.qn !== 64) {
      st.qn = 64;
      load();
    }
  };
  $('#q16').onclick = function () {
    if (st.qn !== 16) {
      st.qn = 16;
      load();
    }
  };
  $('#cs').onclick = function () {
    copy($('#short').value).then(function (ok) {
      say(ok ? '短链已复制：' + $('#short').value : '复制失败，请手动选中', ok ? 'k' : 'e');
    });
  };
  $('#cd').onclick = function () {
    if (!st.data) return say('还没解析出直链', 'e');
    copy(st.data.url).then(function (ok) {
      say(ok ? '直链已复制（2 小时内有效）' : '复制失败，请手动选中', ok ? 'k' : 'e');
    });
  };
  $('#op').onclick = function () {
    if (st.data) window.open(st.data.url, '_blank', 'noopener');
  };
  $('#js').onclick = function () {
    window.open(apiUrl(BASE, t, st.page, st.qn), '_blank', 'noopener');
  };
  $('#short').onclick = function (e) {
    e.target.select();
  };

  paint();
  load();
}

boot();
