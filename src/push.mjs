// 书签把解析结果推给服务端缓存，让 VRChat 的短链请求能直接命中。
// 纯函数部分（构造 payload / 拼请求）与网络部分分开，方便测试。

/** 把解析结果整理成 /push 需要的 payload */
export function pushPayload(d, t, page, qn) {
  return {
    bvid: d.bvid || t.bv || null,
    p: Number(d.p) || page || 1,
    qn: Number(d.quality) || qn,
    quality: Number(d.quality) || qn,
    cid: d.cid || null,
    title: d.title || '',
    acceptQuality: d.acceptQuality || [],
    url: d.url,
  };
}

/** POST 到 /push；返回 {ok, short, expiresInSeconds} 或抛错 */
export async function pushToServer(base, payload, opts) {
  const o = opts || {};
  const headers = { 'Content-Type': 'application/json' };
  if (o.token) headers.Authorization = 'Bearer ' + o.token;

  const res = await fetch(base + '/push', {
    method: 'POST',
    headers: headers,
    body: JSON.stringify(payload),
  });
  const txt = await res.text();
  if (!res.ok) {
    const err = new Error(txt.slice(0, 200).replace(/\s+/g, ' '));
    err.status = res.status;
    throw err;
  }
  try {
    return JSON.parse(txt);
  } catch {
    return { ok: true };
  }
}
