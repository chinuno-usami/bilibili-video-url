#!/usr/bin/env node
// 生成书签小工具，并把静态资源打成 JS 模块（Node 和 Worker 都能直接 import，无需 fs）。
//
//   node bookmarklet/build.mjs                          # 默认 http://127.0.0.1:8787
//   node bookmarklet/build.mjs https://bili.example.com
//
// 产出：
//   src/assets.mjs        托管资源（bookmarklet.js + bm.html），被 handler 直接引用
//   public/bookmarklet.js 同样的内容落地一份，方便手动查看/调试
//   public/bm.html        书签安装页
//   browser-bm.txt        书签 URL（极短，指向上面的 loader）
//   browser-bm-inline.txt 书签 URL（内联全部代码，不依赖 loader）

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

/** bm-lib.mjs 是 ESM，塞进 classic script 前要去掉 export */
export function stripExports(src) {
  return src.replace(/^export\s+/gm, '').replace(/^import[^;]+;$/gm, '');
}

/** 精简版：书签只负责注入一个 <script src>，代码放服务器 */
export function buildLoader(base) {
  const b = base.replace(/\/+$/, '');
  const js =
    'javascript:(function(){' +
    'var s=document.createElement("script");' +
    's.src=' +
    JSON.stringify(b + '/bookmarklet.js') +
    ';s.onerror=function(){alert("加载书签脚本失败：' +
    b +
    '/bookmarklet.js\\n服务没起来，或 BASE 地址不对。")};' +
    '(document.body||document.documentElement).appendChild(s);' +
    '})()';
  return js;
}

/** 内联版：把全部代码塞进书签 URL，不依赖 loader */
export function buildInline(libSource, uiSource, base, pushSource, cdnSource) {
  const injected =
    'var BASE = ' + JSON.stringify(base.replace(/\/+$/, '')) + ';';
  const ui = uiSource.replace(/\/\/ >>>BASE[\s\S]*?\/\/ <<<BASE/, injected);
  const body =
    stripExports(cdnSource || '') + '\n' +
    stripExports(libSource) + '\n' + stripExports(pushSource || '') + '\n' + ui;
  return 'javascript:' + encodeURIComponent('(function(){' + body + '})()');
}

export async function buildAll(base) {
  const cdn = await readFile(join(root, 'src', 'cdn.mjs'), 'utf8');
  const lib = await readFile(join(root, 'src', 'bm-lib.mjs'), 'utf8');
  const push = await readFile(join(root, 'src', 'push.mjs'), 'utf8');
  const ui = await readFile(join(here, 'bm-ui.js'), 'utf8');
  const page = await readFile(join(here, 'bm.html'), 'utf8');

  const script =
    stripExports(cdn) + '\n' + stripExports(lib) + '\n' + stripExports(push) + '\n' + ui;

  await mkdir(join(root, 'public'), { recursive: true });
  await writeFile(join(root, 'public', 'bookmarklet.js'), script + '\n', 'utf8');
  await writeFile(join(root, 'public', 'bm.html'), page, 'utf8');

  // 打成模块，Node 与 Worker 都能 import（Worker 里没有 fs）
  const assetsModule =
    '// 由 bookmarklet/build.mjs 生成，请勿手改。\n' +
    '// 改动请编辑 src/bm-lib.mjs 与 bookmarklet/bm-ui.js 后重新生成。\n' +
    'export const BOOKMARKLET_JS = ' + JSON.stringify(script + '\n') + ';\n' +
    'export const BM_HTML = ' + JSON.stringify(page) + ';\n';
  await writeFile(join(root, 'src', 'assets.mjs'), assetsModule, 'utf8');

  await writeFile(join(root, 'browser-bm.txt'), buildLoader(base) + '\n', 'utf8');
  await writeFile(join(root, 'browser-bm-inline.txt'), buildInline(lib, ui, base, push) + '\n', 'utf8');

  return {
    loaderBytes: script.length,
    compactUrl: buildLoader(base).length,
    inlineUrl: buildInline(lib, ui, base, push, cdn).length,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const base = process.argv[2] || 'http://127.0.0.1:8787';
  const r = await buildAll(base);
  console.log(`base                  = ${base}`);
  console.log(`public/bookmarklet.js = ${r.loaderBytes} 字节（托管用）`);
  console.log(`src/assets.mjs        已生成（Node / Worker 共用）`);
  console.log(`browser-bm.txt        = ${r.compactUrl} 字符（推荐：注入 loader）`);
  console.log(`browser-bm-inline.txt = ${r.inlineUrl} 字符（内联，不依赖 loader）`);
  console.log('\n把 browser-bm.txt 的内容粘进新书签的 URL 即可。');
}
