/**
 * 答疑链路测试客户端
 *   node scripts/test-ask.mjs "为什么需要位移电流？" [焦点知识点ID]
 */
const B = process.env.EM_BASE || 'http://localhost:3200';
const question = process.argv[2] || '为什么需要位移电流？';
const focusIds = process.argv[3] ? [process.argv[3]] : [];

console.log(`\n提问：${question}`);
console.log(`焦点：${focusIds.join(',') || '（由服务端自动定位）'}\n`);

const t0 = Date.now();
const res = await fetch(`${B}/api/ask`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ question, focusIds }),
});
console.log(`HTTP ${res.status}  ${res.headers.get('content-type')}\n`);

const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = '';
let raw = '';
let segments = null;
let summary = null;
let focus = [];
let err = null;
let firstByteAt = null;

const handle = (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n\n')) >= 0) {
    const part = buf.slice(0, i).trim();
    buf = buf.slice(i + 2);
    if (!part.startsWith('data:')) continue;
    let ev;
    try { ev = JSON.parse(part.slice(5).trim()); } catch { continue; }
    if (ev.type === 'text') {
      if (!firstByteAt) firstByteAt = Date.now();
      raw += ev.content;
      process.stdout.write(ev.content);
    } else if (ev.type === 'init') {
      focus = ev.focus || [];
      console.log(`[init] 定位知识点：${focus.map((f) => `${f.name}(${f.id})`).join('、') || '（无）'}`);
      console.log(`[init] 注入图谱节点 ${ev.injectedNodes?.length ?? 0} 个\n`);
      console.log('────── 正文 ──────');
    } else if (ev.type === 'segments') {
      segments = ev.segments;
      summary = ev.summary;
    } else if (ev.type === 'error') {
      err = ev.message;
    }
  }
};

try {
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    handle(dec.decode(value, { stream: true }));
  }
  handle(dec.decode());
} catch (e) {
  console.log(`\n[流中断] ${e.message}`);
}

console.log('\n──────────────────\n');
if (err) {
  console.log(`✗ 错误：${err}`);
  process.exit(1);
}
if (!segments) {
  console.log('✗ 未收到 segments 事件');
  process.exit(1);
}

const s = summary;
console.log(`耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s ｜ 首字 ${firstByteAt ? ((firstByteAt - t0) / 1000).toFixed(1) + 's' : '—'}`);
console.log(`总句数 ${s.total} ｜ 图谱依据 ${s.grounded} ｜ 教材依据 ${s.textbook} ｜ 网络 ${s.web} ｜ AI 推断 ${s.inferred}`);
console.log(`依据覆盖率 ${s.coverage}% ｜ 无效引用 ${s.invalid}`);
console.log(`引用到的图谱节点：${s.nodeIds.join(', ') || '（无）'}`);

console.log('\n=== 逐句溯源 ===');
for (const seg of segments) {
  const tag = { graph: '图谱', textbook: '教材', web: '网络', inferred: '推断' }[seg.source];
  const cites = seg.citations.map((c) => `${c.kind}:${c.nodeId}${c.valid ? '' : '✗无效'}`).join(' ');
  console.log(`[${tag}] ${seg.text.slice(0, 70)}${seg.text.length > 70 ? '…' : ''}`);
  if (cites) console.log(`        ${cites}`);
}
console.log();
