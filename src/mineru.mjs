/**
 * MinerU 文档解析客户端
 * ------------------------------------------------------------------
 * 用途：把 PDF / 扫描件 / 作业图片解析成结构化 Markdown。
 *
 * 接口（v4 精准解析 API，需要 Token）：
 *   POST /api/v4/file-urls/batch          申请上传链接 → PUT 上传 → 自动解析
 *   POST /api/v4/file-urls/batch  (base64) 小文件直接内联，省一次 PUT
 *   GET  /api/v4/extract-results/batch/{batch_id}   轮询批量结果
 *   POST /api/v4/extract/task             按 URL 提交单任务
 *   GET  /api/v4/extract/task/{task_id}   轮询单任务
 * 错误码：A0202 Token 错误、A0211 Token 过期
 *
 * ⚠️ 实测认知（2026-09，手机翻拍课本/试卷上的印刷体题目）：
 *   MinerU 是文档解析器，但在**翻拍条件下**（阴影、反光、倾斜、纸张弯曲）
 *   公式识别同样会崩：
 *     ∂²E/∂t²  →  \frac{1\omega^2_2}{.7/2}
 *     electromagnetic → electonmignttic
 *   汉字通常还行，公式部分噪声极大。
 *   因此**绝不能**把它的输出当成书上/卷面上的原话来判断对错——
 *   这条链路必须由模型先做"可读性评估"，不可读的部分一律不许判错。
 *   见 src/homework.mjs 的 READABILITY 部分。
 */

import { requireEnv } from './env.mjs';

const BASE = () => process.env.MINERU_BASE_URL || 'https://mineru.net/api/v4';

function headers() {
  return {
    Authorization: `Bearer ${requireEnv('MINERU_API_KEY')}`,
    'Content-Type': 'application/json',
    Accept: '*/*',
  };
}

async function call(path, { method = 'GET', body, timeoutMs = 60000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE()}${path}`, {
      method,
      headers: headers(),
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    return { http: res.status, json, raw: text };
  } finally {
    clearTimeout(timer);
  }
}

/** 鉴权自检：申请一个上传链接（不会真的解析任何东西） */
export async function checkAuth() {
  const r = await call('/file-urls/batch', {
    method: 'POST',
    body: { files: [{ name: 'auth-check.pdf' }], model_version: 'pipeline' },
  });
  const code = r.json?.code;
  if (code === 0) return { ok: true, msg: 'Token 有效' };
  if (code === 'A0202') return { ok: false, msg: 'Token 错误（检查是否有 Bearer 前缀）' };
  if (code === 'A0211') return { ok: false, msg: 'Token 已过期，需要更换' };
  return { ok: false, msg: `返回 code=${code} msg=${r.json?.msg ?? r.raw.slice(0, 200)}` };
}

/** 本地文件：申请上传链接 → PUT 上传，返回 batch_id（上传完成后服务端自动开始解析） */
export async function uploadFiles(paths, { modelVersion = 'pipeline', onProgress } = {}) {
  const fs = await import('node:fs');
  const path = await import('node:path');

  const files = paths.map((p) => ({ name: path.basename(p) }));
  const r = await call('/file-urls/batch', {
    method: 'POST',
    body: { files, model_version: modelVersion },
  });
  if (r.json?.code !== 0) {
    throw new Error(`申请上传链接失败：${r.json?.msg ?? r.raw.slice(0, 200)}`);
  }

  const batchId = r.json.data.batch_id;
  const urls = r.json.data.file_urls;

  for (let i = 0; i < paths.length; i++) {
    const buf = fs.readFileSync(paths[i]);
    onProgress?.(i + 1, paths.length, path.basename(paths[i]));
    const put = await fetch(urls[i], { method: 'PUT', body: buf });
    if (!put.ok) throw new Error(`上传 ${path.basename(paths[i])} 失败：HTTP ${put.status}`);
  }
  return { batchId, count: paths.length };
}

/** 轮询批量结果 */
export async function batchResults(batchId) {
  const r = await call(`/extract-results/batch/${batchId}`);
  if (r.json?.code !== 0) throw new Error(`查询失败：${r.json?.msg ?? r.raw.slice(0, 200)}`);
  return r.json.data.extract_result ?? [];
}

/**
 * 小文件内联上传（base64）。
 *
 * ⚠️ 别用这个走主链路。实测 3 MB 的 PNG 直接被网关 413 拒掉，
 * 且官方文档里并不存在 "data" 内联上传这种用法——标准路径是
 * uploadFiles() 的「申请签名链接 → PUT 上传」。
 * 这里保留仅用于极小图片（几十 KB）的快速通路，失败就退回 uploadFiles。
 *
 * 单文件上限 10 MB 是轻量接口的口径，别按 200 MB 理解。
 */
export async function uploadBase64(items, { modelVersion = 'pipeline' } = {}) {
  const files = items.map((it) => ({
    name: it.name,
    data: String(it.data).replace(/^data:[^;]+;base64,/, ''),
  }));
  const r = await call('/file-urls/batch', {
    method: 'POST',
    body: { files, model_version: modelVersion },
  });
  if (r.json?.code !== 0) {
    const hint = r.http === 413 ? '（文件过大，base64 内联不被接受，请改用 uploadFiles）' : '';
    throw new Error(`提交失败${hint}：${r.json?.msg ?? `HTTP ${r.http}`}`);
  }
  return { batchId: r.json.data.batch_id, count: items.length };
}

/**
 * 下载解析结果压缩包（内含 full.md 与图片）。
 *
 * 两个必须处理的坑：
 *  1. CDN 会拒绝没有 UA 的请求，表现为直接 ECONNRESET（不是 403，很难猜）；
 *  2. 该 CDN 偶发中途断流，实测重试一两次就成功，因此这里带退避重试。
 */
export async function downloadZip(url, { timeoutMs = 120000, retries = 3 } = {}) {
  let lastErr;
  for (let i = 1; i <= retries; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: '*/*' },
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) throw new Error('下载到空内容');
      return buf;
    } catch (e) {
      lastErr = e;
      const msg = e?.name === 'AbortError' ? '超时' : (e?.cause?.code ?? e?.code ?? e?.message);
      if (i < retries) {
        const wait = i * 1200;
        console.warn(`[MinerU] 下载结果失败（${msg}），${wait}ms 后重试（${i}/${retries}）`);
        await new Promise((r) => setTimeout(r, wait));
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`下载解析结果失败：${lastErr?.cause?.code ?? lastErr?.message ?? '未知原因'}`);
}

/** 按 URL 提交单任务 */
export async function submitUrl(url, { modelVersion = 'pipeline' } = {}) {
  const r = await call('/extract/task', {
    method: 'POST',
    body: { url, model_version: modelVersion },
  });
  if (r.json?.code !== 0) throw new Error(`提交失败：${r.json?.msg ?? r.raw.slice(0, 200)}`);
  return r.json.data.task_id;
}

/** 轮询单任务 */
export async function taskResult(taskId) {
  const r = await call(`/extract/task/${taskId}`);
  if (r.json?.code !== 0) throw new Error(`查询失败：${r.json?.msg ?? r.raw.slice(0, 200)}`);
  return r.json.data;
}

/**
 * 轮询直到完成
 * @param {() => Promise<any>} poll 返回带 state 的对象
 */
export async function waitUntilDone(poll, { intervalMs = 5000, timeoutMs = 600000, onTick } = {}) {
  const t0 = Date.now();
  for (;;) {
    const r = await poll();
    const items = Array.isArray(r) ? r : [r];
    const states = items.map((x) => x.state);
    onTick?.(states);
    if (states.every((s) => s === 'done')) return r;
    if (states.some((s) => s === 'failed')) {
      const bad = items.find((x) => x.state === 'failed');
      throw new Error(`解析失败：${bad?.err_msg ?? '未知原因'}`);
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`解析超时（${timeoutMs / 1000}s）`);
    await new Promise((r2) => setTimeout(r2, intervalMs));
  }
}

/* ==================== 结果压缩包解包 ==================== */

/**
 * 从 zip 里取出 full.md。
 *
 * 为什么不落盘解压：包里除了 md 还有几十兆的切图，全解开纯属浪费；
 * 而且运行环境的删除接口被安全策略接管，产生的临时目录清理不干净。
 * 这里只需要内存中把中央目录扫一遍，定位那一个条目。
 *
 * 支持 stored（0）与 deflate（8）两种压缩方式——MinerU 用的是 deflate。
 */
export async function extractMarkdownFromZip(zipBuf) {
  const zlib = await import('node:zlib');

  // 1) 从尾部找 End of Central Directory（EOCD，签名 0x06054b50）
  let eocd = -1;
  for (let i = zipBuf.length - 22; i >= Math.max(0, zipBuf.length - 66000); i--) {
    if (zipBuf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('结果压缩包格式异常：找不到 EOCD');

  const entryCount = zipBuf.readUInt16LE(eocd + 10);
  let off = zipBuf.readUInt32LE(eocd + 16);

  // 2) 遍历中央目录，收集所有 .md 条目（图片略过）
  const hits = [];
  for (let i = 0; i < entryCount; i++) {
    if (zipBuf.readUInt32LE(off) !== 0x02014b50) break;
    const method = zipBuf.readUInt16LE(off + 10);
    const compSize = zipBuf.readUInt32LE(off + 20);
    const nameLen = zipBuf.readUInt16LE(off + 28);
    const extraLen = zipBuf.readUInt16LE(off + 30);
    const cmtLen = zipBuf.readUInt16LE(off + 32);
    const localOff = zipBuf.readUInt32LE(off + 42);
    const name = zipBuf.toString('utf8', off + 46, off + 46 + nameLen);

    if (/\.md$/i.test(name)) hits.push({ name, method, compSize, localOff });
    off += 46 + nameLen + extraLen + cmtLen;
  }

  if (!hits.length) throw new Error('结果压缩包里没有 Markdown 文件');

  // 3) 优先 full.md，否则取第一个
  const pick = hits.find((h) => /(^|\/)full\.md$/i.test(h.name)) ?? hits[0];

  // 4) 从本地文件头定位到实际数据（本地头的 name/extra 长度可能与中央目录不同，必须重读）
  const lo = pick.localOff;
  if (zipBuf.readUInt32LE(lo) !== 0x04034b50) throw new Error('结果压缩包格式异常：本地文件头签名不对');
  const lNameLen = zipBuf.readUInt16LE(lo + 26);
  const lExtraLen = zipBuf.readUInt16LE(lo + 28);
  const dataStart = lo + 30 + lNameLen + lExtraLen;
  const data = zipBuf.subarray(dataStart, dataStart + pick.compSize);

  const md = pick.method === 0
    ? data
    : zlib.inflateRawSync(data);

  return { name: pick.name, markdown: md.toString('utf8'), files: hits.map((h) => h.name) };
}

/**
 * 一步到位：图片/PDF 的 Buffer → Markdown。
 * 这是作业上传要用的主入口。
 *
 * 走官方标准路径（申请签名链接 → PUT），不落临时文件：
 * 用 Buffer 直接 PUT，省掉在含中文的项目目录里写临时文件的麻烦。
 */
export async function fileToMarkdown(buf, {
  filename = 'homework.png', onProgress, intervalMs = 4000, timeoutMs = 300000,
} = {}) {
  const r = await call('/file-urls/batch', {
    method: 'POST',
    body: { files: [{ name: filename }], model_version: 'pipeline' },
  });
  if (r.json?.code !== 0) {
    throw new Error(`申请上传链接失败：${r.json?.msg ?? `HTTP ${r.http}`}`);
  }

  const batchId = r.json.data.batch_id;
  const put = await fetch(r.json.data.file_urls[0], { method: 'PUT', body: buf });
  if (!put.ok) throw new Error(`上传失败：HTTP ${put.status}`);
  onProgress?.('已上传，排队解析…');

  const results = await waitUntilDone(() => batchResults(batchId), {
    intervalMs, timeoutMs,
    onTick: (states) => onProgress?.(`解析中（${states.join('、')}）`),
  });

  const first = results[0];
  if (!first?.full_zip_url) throw new Error('解析完成但没有返回结果地址');

  const zip = await downloadZip(first.full_zip_url);
  const { markdown, name } = await extractMarkdownFromZip(zip);
  return { markdown, mdName: name, batchId, zipBytes: zip.length };
}

