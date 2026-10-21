/**
 * 连续多次答疑，摸清认证失败的规律
 *   node scripts/loop-ask.mjs [次数]
 */
const B = 'http://localhost:3200';
const qs = ['旋度是什么', '散度是什么', '梯度是什么', '镜像法怎么用', '位移电流的必要性', '推迟势的物理意义'];
const n = Number(process.argv[2] ?? 4);

let ok = 0, fail = 0;
for (let i = 0; i < Math.min(n, qs.length); i++) {
  const t0 = Date.now();
  const res = await fetch(`${B}/api/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: qs[i] }),
  });
  const rd = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', raw = '', err = null, sum = null;
  for (;;) {
    const { done, value } = await rd.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let k;
    while ((k = buf.indexOf('\n\n')) >= 0) {
      const p = buf.slice(0, k).trim();
      buf = buf.slice(k + 2);
      if (!p.startsWith('data:')) continue;
      let ev; try { ev = JSON.parse(p.slice(5).trim()); } catch { continue; }
      if (ev.type === 'text') raw += ev.content;
      if (ev.type === 'error') err = ev.message;
      if (ev.type === 'segments') sum = ev.summary;
    }
  }
  const dt = ((Date.now() - t0) / 1000).toFixed(0);
  if (err) { fail++; console.log(`#${i + 1} 「${qs[i]}」 ${dt}s  ✗ ${err.slice(0, 60)}`); }
  else { ok++; console.log(`#${i + 1} 「${qs[i]}」 ${dt}s  ✓ ${raw.length} 字 · 覆盖 ${sum?.coverage}% · ${sum?.total} 句`); }
}
console.log(`\n成功 ${ok} / 失败 ${fail}`);
