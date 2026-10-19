# bili-302

把 B 站视频变成**可直接贴进播放器**的短地址。只签名，不中转流量。

```
https://your.host/p/BV1GJ411x7h7?p=1&qn=64      ← 42 字符，可直接贴进 VRChat
        │
        └─ 302 → https://upos-sz-....bilivideo.com/upgcxcode/...mp4?upsig=...   ← 516 字符
```

## 原理

服务端做两次匿名 API 调用，然后把签名直链以 `302` 交出去：

1. `GET api.bilibili.com/x/web-interface/view?bvid=BV...` → 拿 `pages[p-1].cid`
2. `GET api.bilibili.com/x/player/playurl?bvid=...&cid=...&qn=64&platform=html5&high_quality=1`
   → 拿 `data.durl[0].url`（**`platform=html5` 是单文件 mp4 的关键**，否则是 DASH 音视频分离）

服务端请求天然不带 `Origin`，所以不会被 B 站的反盗链 403 拦（`Origin: <第三方>` → 403/412）。

**流量**：一次请求约 600 B JSON，视频 0 B。播放发生在播放器与 CDN 之间。

## 路由

| 路由 | 说明 |
|---|---|
| `/p/BV1GJ411x7h7` | 302 到直链，默认 `qn=64`（720P） |
| `/p/BV1GJ411x7h7?p=2&qn=16` | 第 2P，360P（文件小 5 倍，加载快） |
| `/p/av80433022` | av 号 |
| `/p/<urlencoded bilibili/b23.tv 链接>` | 自动展开短链 |
| `/player/?url=BV1GJ411x7h7` | 兼容 91vrchat 的写法 |
| `/json/BV1GJ411x7h7` | 调试用，返回 url / 标题 / 剩余有效期 |
| `/healthz` | 健康检查 |

响应头会带上 `X-Bili-Bvid` / `X-Bili-Page` / `X-Bili-Quality`，方便排查。

## 清晰度

匿名接口只有 720P 上限：`accept_quality = [64, 16]`。

| qn | 文件 | 大小（示例） | 分辨率 |
|---|---|---|---|
| 6 / 16 / 32 | `...-1-16.mp4` | 10.5 MB | 640×360 |
| 64 / 80 / 112 / 120 | `...-1-192.mp4` | 52.0 MB | 1280×720 |

请求 1080P 会被自动降到 720P。要更高需要账号 cookie 且只能走 DASH（本服务不做）。

## 运行

### 本地

```bash
node server.mjs 8787
```

- 书签安装页：<http://127.0.0.1:8787/bm>（拖动按钮即可）
- 健康检查：`curl -s http://127.0.0.1:8787/healthz`

绑定 `0.0.0.0`，同一局域网内的头显可以直接访问 `http://<你的内网IP>:8787/p/BV...`。

### Cloudflare Worker（推荐，免费额度足够）

先建配置文件（`wrangler.toml` 被 gitignore，仓库里只有 example）：

```bash
cp wrangler.toml.example wrangler.toml
# 编辑 wrangler.toml：填自己的域名、KV namespace id 等
```

然后：

```bash
npx wrangler login
npx wrangler dev          # 本地预览
npx wrangler deploy
```

部署后得到 `https://bili-302.<你的子域>.workers.dev`。要更好的域名，在 `wrangler.toml` 里放开 `routes` 配置自定义域名。

Worker 和 Node **共用同一个 `handle()`**，所以 `/p`、`/json`、`/bm`、`/bookmarklet.js` 在两边行为完全一致。

### 绑定自己的域名（wrangler）

前提：域名已接入 Cloudflare（NS 指向 Cloudflare，账号里能看到这个 zone）。

#### 方案 A：整个子域名（推荐）

改 `wrangler.toml`：

```toml
[[routes]]
pattern = "bili.example.com"
custom_domain = true
```

然后：

```bash
npx wrangler deploy
```

`custom_domain = true` 会自动建 CNAME、申请证书，**不用**去控制台手动加记录。

打开 `https://bili.example.com/bm` 拖书签，短地址就是：

```
https://bili.example.com/p/BV1GJ411x7h7?p=1&qn=64
```

#### 方案 B：挂在一个子路径下

```toml
[[routes]]
pattern = "example.com/bili/*"
zone_name = "example.com"

[vars]
BASE_PATH = "/bili"
```

`BASE_PATH` 让 handler 认识这个前缀，否则 `/json` 返回的 `short` 字段和帮助文案会少一段。

```
https://example.com/bili/p/BV1GJ411x7h7?p=1&qn=64
```

#### 两种写法不能同时开

`custom_domain` 会独占整个域名，和 `routes` 的 path 匹配会冲突。选一个，注释掉另一个。

#### 换域名后必须重新拖书签

书签里烧录了 base 地址（网页版靠 `document.currentScript.src` 反推，但 family 版是写死的）。所以：

```bash
node bookmarklet/build.mjs https://bili.example.com
```

然后打开 `https://bili.example.com/bm`，删掉旧书签、重新拖一次。

### 书签小工具

```bash
node bookmarklet/build.mjs https://your.host     # 生成书签代码
```

产出：

| 文件 | 用途 |
|---|---|
| `browser-bm.txt` | **推荐**。265 字符，只注入 `<script src="<base>/bookmarklet.js">` |
| `browser-bm-inline.txt` | 内联全部代码（约 16KB），不依赖 loader，适合离线/本地 |
| `public/bookmarklet.js` | 托管用的实际逻辑（`/bookmarklet.js` 直接返回它） |
| `public/bm.html` | 安装页（`/bm` 直接返回它） |
| `src/assets.mjs` | 上两份资源打成的 JS 模块，被 `handler.mjs` import |

> `public/` 和 `src/assets.mjs` 都是从 `src/bm-lib.mjs` + `bookmarklet/bm-ui.js` + `bookmarklet/bm.html` 生成的，**不要手改**。改完源文件重跑一次 `build.mjs`。

更省事的做法：直接打开 `http://127.0.0.1:8787/bm`，把页面上的按钮拖到书签栏。

在 B 站视频页点书签 → 弹窗显示标题/清晰度/短链/直链，可一键复制或切 720P/360P。分 P 自动从当前 URL 的 `?p=` 读取。

### 测试

```bash
npm test     # 35 个用例，全部用假 fetch，不联网
```

## 注意

- **直链 2 小时过期**（`deadline = now + 7200`）。本服务每次被请求时现场重新签名，所以短地址长期有效，但**不要把 `/json/` 返回的 `url` 存起来复用**。缓存 TTL 设成 10 分钟正是为此。
- CDN 只校验 UA：`libcurl`、`curl`、`python-requests` → 403；`AVProVRC`、`VRChat/*`、`ExoPlayerLib/*`、`UnityPlayer/*` → 206。正常播放器都没问题，用 `curl` 直接测视频会看到 403，那不是服务的问题。
- 单文件 mp4 是 h264+aac，`moov` 在文件头（faststart），支持边下边播和 seek：中段 `Range: bytes=20000000-` → 206。
- 不支持：番剧（`ep`）、付费课程、需要登录/大会员的视频、`bangumi` 类型。这些会返回 403 并说明原因。
- 请只用于个人观看，不要公开部署成面向大量用户的服务——那会把你的服务器暴露在别人的滥用之下。

## 遇到 412 / 风控怎么办

bilibili 对匿名请求的风控会随时间收紧。本服务做了三层防护：

1. **请求头凑成浏览器**：默认 UA + `Referer: https://www.bilibili.com/` + `Accept-Language`。不要设 `Origin`（带 Origin 必 403/412）。
2. **带设备指纹**：启动时调 `x/frontend/finger/spi` 拿 `buvid3/buvid4`，之后每次请求作为 Cookie 带上（缓存 30 分钟）。
3. **WBI 签名**：先 `/x/web-interface/nav` 取 `wbi_img` 的两个 key，按官方混淆表算 `mixinKey`，再给 playurl 加 `wts` + `w_rid`。第 3 次重试会退回不带签名的老端点（签名本身有时反而触发校验）。

三种情况仍然会失败，以及对应解法：

| 现象 | 原因 | 解法 |
|---|---|---|
| `502 ... code -412 request was banned` | 机房 IP 被风控（Cloudflare Worker 出口 IP 尤其常见） | 书签会**自动回退到页面内解析**（见下），或把服务跑在家宽上 |
| `502 ... HTTP 412` + HTML | UA / 请求头被判爬虫 | 已自动换指纹重试；持续失败就升级 UA 字符串 |
| `400/403` + 具体说明 | 视频本身不可匿名播放 | 番剧 / 大会员 / 仅 DASH 的视频不支持 |

### 推送缓存（让 VRChat 绕开服务端风控）

这是解决「服务端 IP 被封但 VRChat 还要用短链」的关键机制：

```
书签在浏览器里解析出直链
        │  POST /push  { bvid, p, qn, url, ... }
        ▼
服务端缓存（KV / 内存）   key = "BV1x:1:64"
        ▲
        │  GET /p/BV1x?qn=64
VRChat ─┘  命中 → 直接 302，完全不碰 bilibili
            未命中 → 服务端现场解析（可能 412）
            解析也失败 → 降级用任意档位的推送缓存
```

书签拿到直链后会自动 `POST /push`（无论走服务端还是页面内解析），所以流程是：

1. 你在桌面浏览器点书签 → 直链到手，同时推进服务端
2. 你把短链贴进 VRChat → 服务端从缓存直接 302，不打 bilibili
3. 2 小时后直链过期 → 再点一次书签

相关接口：

| 接口 | 说明 |
|---|---|
| `POST /push` | 写入一条缓存。会校验：https、CDN 域名白名单、`/upgcxode/` 路径、`upsig`、未来 `deadline` |
| `GET /cache/BV1x` | 查看某视频的推送缓存与实时缓存 |

响应头 `X-Bili-Source` 会告诉你这次走的哪条路：

- `push` —— 命中推送缓存，没碰 bilibili
- `live` —— 服务端现场解析

如果 `X-Bili-Source: push` 且带 `X-Bili-Degraded: 1`，说明是服务端解析失败后降级用了别的清晰度（能播但可能不是你要的档位）。

**安全**：`/push` 只接受 bilibili 自家 CDN 的地址，避免短链变成任意开放跳转。建议再配 `PUSH_TOKEN` 防止别人投毒。

**KV（Worker 部署时强烈建议配）**：不配会退化成 Cloudflare Cache API，只在本边缘节点生效，命中率低。

```bash
npx wrangler kv namespace create PUSH
# 把输出的 id 填进 wrangler.toml 的 [[kv_namespaces]]
```

### 页面内解析（书签的回退模式）

服务端返回任何错误时，书签不会直接失败，而是改在**当前 B 站页面**里用 JSONP 直接请求 API：

```
1. view  ->  https://api.bilibili.com/x/web-interface/view?bvid=...&jsonp=jsonp&callback=...
2. playurl -> /x/player/playurl?cid=...&qn=64&platform=html5&high_quality=1&jsonp=jsonp&callback=...
```

为什么这个路子能过：

- **Referer 天然正确**——页面就在 `www.bilibili.com` 下，满足 playurl 的防盗链检查（第三方 referer → 403）。
- **JSONP 绕过 CORS**——`<script>` 不受同源策略约束，而 `fetch` 会因为缺 `Access-Control-Allow-Origin` 被拦。
- **用的是你自己的 IP 和登录 cookie**——不是服务器出口 IP，所以不受机房 IP 风控影响；登录态还能顺带解锁更高清晰度。

代价：`/json` 返回的 `short` 短链仍然指向服务端（那一步被风控就真没辙），但直链是真实可用的。界面会标注「页面内解析」。
