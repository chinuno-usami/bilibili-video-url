// bilibili WBI 签名。签名后的 playurl 走的是官方 web 端同一条路，
// 比裸调 playurl 更不容易被风控判成爬虫。

import { md5 } from './md5.mjs';

// 官方 JS 里写死的混淆表
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28,
  14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54,
  21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

const keyFromUrl = (u) => String(u || '').split('/').pop().split('.')[0];

/** img_url + sub_url 的 key 部分 -> 32 位 mixin key */
export function mixinKey(imgUrl, subUrl) {
  const raw = keyFromUrl(imgUrl) + keyFromUrl(subUrl);
  if (raw.length < 64) return null;
  return MIXIN_KEY_ENC_TAB.map((i) => raw[i]).join('').slice(0, 32);
}

/** 按 WBI 规则把 params 排序、过滤特殊字符、加 wts 与 w_rid，返回 query string */
export function signQuery(params, mixin, now = Date.now()) {
  const p = { ...params, wts: Math.round(now / 1000) };
  const q = Object.keys(p)
    .sort()
    .map((k) => {
      const v = String(p[k]).replace(/[!'()*]/g, '');
      return encodeURIComponent(k) + '=' + encodeURIComponent(v);
    })
    .join('&');
  return q + '&w_rid=' + md5(q + mixin);
}
