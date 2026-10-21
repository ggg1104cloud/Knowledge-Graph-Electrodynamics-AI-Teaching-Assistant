/**
 * 链路计时
 *   node scripts/timing-homework.mjs [图片路径]      （或 npm run hw:timing）
 *
 * 打印每个 SSE 事件的到达时刻与相邻间隔。用途：
 *   1. 定位"哪一步最慢"——实测单次链路 60~90s，核查与生成反馈各占 20~48s；
 *   2. 验证心跳——长耗时阶段应当每 4 秒有一次 tick。
 *      若某阶段出现 >10s 的静默，说明心跳没生效，或链路真的断了。
 */
import fs from 'node:fs';

const B = process.env.EM_BASE || 'http://localhost:3200';
const img = process.argv[2] || 'samples/homework-typed.png';
const b64 = fs.readFileSync(img).toString('base64');
const mime = img.endsWith('.png') ? 'image/png' : 'image/jpeg';

console.log('图片:', img, (fs.statSync(img).size / 1024).toFixed(0) + ' KB\n');

const t0 = Date.now();
const el = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6) + 's';

const res = await fetch(B + '/api/homework/parse', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ image: `data:${mime};base64,${b64}`, filename: img }),
});
console.log('HTTP', res.status, res.headers.get('content-type'), '| body 请求体大小', (b64.length / 1024 / 1024).toFixed(1) + ' MB');
if (!/event-stream/.test(res.headers.get('content-type') ?? '')) {
  console.log('非 SSE 响应，正文：', (await res.text()).slice(0, 400));
  process.exit(1);
}
const rd = res.body.getReader();
const dec = new TextDecoder();
let buf = '', lastAt = Date.now();

for (;;) {
  const { done, value } = await rd.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  let i;
  while ((i = buf.indexOf('\n\n')) >= 0) {
    const part = buf.slice(0, i).trim();
    buf = buf.slice(i + 2);
    if (!part.startsWith('data:')) continue;
    let ev; try { ev = JSON.parse(part.slice(5).trim()); } catch { continue; }
    const gap = ((Date.now() - lastAt) / 1000).toFixed(1);
    lastAt = Date.now();
    const label = ev.type === 'stage' ? `${ev.stage} / ${ev.message}` : ev.type;
    console.log(`${el()}  (+${gap}s)  ${label}`);
    if (ev.type === 'error') console.log('   错误:', ev.message);
  }
}
console.log(`\n总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
