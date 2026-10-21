/**
 * 优雅停止服务
 *   node scripts/stop.mjs
 *
 * 优先走 /api/shutdown（会先释放 Kuzu 句柄）。
 * 若接口不可达（例如服务已崩溃），退回到按端口结束进程。
 */

const PORT = Number(process.env.PORT || 3200);
const B = `http://localhost:${PORT}`;

async function viaApi() {
  try {
    const res = await fetch(`${B}/api/shutdown`, { method: 'POST' });
    if (!res.ok) return false;
    const j = await res.json();
    console.log(`[stop] ${j.message ?? '已请求停止'}`);
    return true;
  } catch {
    return false;
  }
}

async function waitGone(ms = 6000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      await fetch(`${B}/api/health`, { signal: AbortSignal.timeout(800) });
    } catch {
      return true; // 连不上了，说明已停
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

const ok = await viaApi();
if (ok) {
  const gone = await waitGone();
  console.log(gone ? `[stop] 服务已停止（端口 ${PORT} 已释放）` : '[stop] 停止请求已发出，但端口仍被占用');
  process.exit(gone ? 0 : 1);
}

console.log(`[stop] 无法通过接口停止（服务可能未运行或已崩溃）`);
console.log(`[stop] 如确认端口被残留进程占用，请手动结束该进程后再启动。`);
process.exit(1);
