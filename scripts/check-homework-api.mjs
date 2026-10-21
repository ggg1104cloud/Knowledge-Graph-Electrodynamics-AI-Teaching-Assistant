/**
 * 作业辅导接口契约校验（单题模式）
 *   node scripts/check-homework-api.mjs [图片路径]
 *
 * 走真实 HTTP 接口（不是直接调模块），验证 SSE 事件序列与字段契约，
 * 并检查两条边界是否守得住：
 *   1. 识别不确定的地方不被当作错误依据
 *   2. 不给出完整解答
 */
import fs from 'node:fs';

const B = process.env.EM_BASE || 'http://localhost:3200';
const img = process.argv[2] || 'samples/homework-multi.png';

let pass = 0, fail = 0;
const problems = [];
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; problems.push(label + (detail ? ' — ' + detail : '')); console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
};

const b64 = fs.readFileSync(img).toString('base64');
const t0 = Date.now();

console.log('\n═══ 作业辅导接口契约校验（单题） ═══');
console.log(`图片 ${img}（${(b64.length / 1024 / 1024).toFixed(2)} MB base64）\n`);

console.log('[SSE] 解析事件流');
const res = await fetch(`${B}/api/homework/parse`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ image: b64, filename: img.split(/[\\/]/).pop() }),
});

check('HTTP 200', res.status === 200, `得到 ${res.status}`);
check('Content-Type 是 event-stream', (res.headers.get('content-type') ?? '').includes('text/event-stream'));

const rd = res.body.getReader();
const dec = new TextDecoder();
let buf = '';
const stages = [];
let recognizedEvent = null;
let doneEvent = null;
let errEvent = null;
let ticks = 0;
let maxGapMs = 0;      // 相邻事件之间的最大间隔——用来盯住"静默期"
let lastEvAt = Date.now();

for (;;) {
  const { done, value } = await rd.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  let i;
  while ((i = buf.indexOf('\n\n')) >= 0) {
    const part = buf.slice(0, i).trim(); buf = buf.slice(i + 2);
    if (!part.startsWith('data:')) continue;
    let ev; try { ev = JSON.parse(part.slice(5).trim()); } catch { continue; }
    const now = Date.now();
    maxGapMs = Math.max(maxGapMs, now - lastEvAt);
    lastEvAt = now;
    if (ev.type === 'stage') { stages.push(ev); console.log(`    [stage] ${ev.stage} · ${ev.message} (${ev.elapsed}s)`); }
    else if (ev.type === 'tick') ticks++;
    else if (ev.type === 'recognized') recognizedEvent = ev;
    else if (ev.type === 'done') doneEvent = ev;
    else if (ev.type === 'error') errEvent = ev.message;
  }
}

console.log();
const dt = ((Date.now() - t0) / 1000).toFixed(1);

check('无 error 事件', !errEvent, errEvent ?? '');
check('收到 stage 事件', stages.length > 0, `${stages.length} 个`);
check('stage 覆盖 recognize（视觉识别）', stages.some((s) => s.stage === 'recognize'));
check('stage 覆盖 guide', stages.some((s) => s.stage === 'guide'));
check('不再有 ocr / segment 阶段（已弃用 MinerU 链路）',
  !stages.some((s) => s.stage === 'ocr' || s.stage === 'segment'));
// 心跳：诊断与生成反馈各要等模型几十秒，没有 tick 前端进度条会一直不动，
// 看着和卡死一样。这条断言防止以后把心跳删了却没人发现。
check('全程有心跳事件（长耗时阶段不至于看似卡死）', ticks > 0, `${ticks} 次`);
check('相邻事件最大间隔 < 10 秒', maxGapMs < 10000, `实测 ${(maxGapMs / 1000).toFixed(1)}s`);
check('收到 recognized 事件（识别结果先给用户核对）', !!recognizedEvent);
check('收到 done 事件', !!doneEvent);

if (!doneEvent) {
  console.log(`\n通过 ${pass} ｜ 失败 ${fail}\n`);
  process.exit(1);
}

/* ---- recognized 事件结构 ---- */
console.log('\n[recognized] 识别阶段负载');
check('problem 对象存在', !!recognizedEvent?.problem);
check('question 是字符串', typeof recognizedEvent?.problem?.question === 'string');
check('uncertain 是数组', Array.isArray(recognizedEvent?.uncertain), `得到 ${typeof recognizedEvent?.uncertain}`);
check('extraDetected 是数组', Array.isArray(recognizedEvent?.extraDetected));
check('warnings 是数组', Array.isArray(recognizedEvent?.warnings));
check('vision 带模型名与耗时', !!(recognizedEvent?.vision?.model && typeof recognizedEvent?.vision?.elapsedMs === 'number'));

/* ---- done 负载结构 ---- */
console.log('\n[done] 负载结构');
check('problem 是对象（单题，不再是数组）',
  !!doneEvent.problem && !Array.isArray(doneEvent.problem), `得到 ${Array.isArray(doneEvent.problem) ? 'array' : typeof doneEvent.problem}`);
check('不再有 problems 数组字段', doneEvent.problems === undefined);
check('opening 非空', typeof doneEvent.opening === 'string' && doneEvent.opening.length > 0, `${doneEvent.opening?.length} 字`);
check('leakFlags 是数组', Array.isArray(doneEvent.leakFlags));
check('warnings 是数组', Array.isArray(doneEvent.warnings));
check('elapsed 是字符串', typeof doneEvent.elapsed === 'string');

const p = doneEvent.problem;
console.log('\n[problem] 单题结构');
check('有 no/question/solution', !!(p.no && typeof p.question === 'string' && typeof p.solution === 'string'));
check('question 非空（识别成功）', p.question.length > 0, `${p.question.length} 字`);
check('uncertain 是数组', Array.isArray(p.uncertain), `得到 ${typeof p.uncertain}`);
check('fragments 字段已移除（不再做逐句可读性评估）', p.fragments === undefined);
check('nodes 是数组', Array.isArray(p.nodes), `${p.nodes?.length} 个`);
check('node 有 id/name/matchBy',
  (p.nodes ?? []).every((n) => n.id && n.name && ['name', 'fuzzy', 'semantic'].includes(n.matchBy)));
check('diagnosis 存在且有 status/verdict', !!(p.diagnosis?.status && p.diagnosis?.verdict));
check('diagnosis.verdict 取值合法',
  ['正确', '部分正确', '有错误', '无法判定', '仅有题目'].includes(p.diagnosis?.verdict), `得到 ${p.diagnosis?.verdict}`);
check('diagnosis.mistakes 是数组', Array.isArray(p.diagnosis?.mistakes));
check('diagnosis.unreliable 是数组', Array.isArray(p.diagnosis?.unreliable));
check('roots 字段存在', !!p.roots && Array.isArray(p.roots.roots));

/* ---- 铁律一：识别不确定处不得进入 mistakes ---- */
console.log('\n[铁律] 只对确定的内容作判断');
const uncertainTexts = (p.diagnosis?.unreliable ?? []).map((u) => (u.text ?? '').trim()).filter(Boolean);
let leaked = 0;
for (const m of p.diagnosis?.mistakes ?? []) {
  const ev = (m.evidence ?? '').trim();
  if (!ev) continue;
  if (uncertainTexts.some((u) => u.includes(ev) || ev.includes(u))) leaked++;
}
check('没有把不确定片段当作错误依据', leaked === 0, `${leaked} 条误用`);

const noEvidence = (p.diagnosis?.mistakes ?? []).filter((m) => !m.evidence?.trim()).length;
check('每条 mistake 都带 evidence', noEvidence === 0, `${noEvidence} 条缺依据`);

const fakeNodes = (p.diagnosis?.mistakes ?? []).filter((m) => m.droppedNodeId).map((m) => m.droppedNodeId);
check('没有放行编造的节点 ID', fakeNodes.length === 0, `被丢弃：${fakeNodes.join(',')}`);

/* ---- 铁律二：不给出完整解答 ---- */
console.log('\n[铁律] 不给出完整解答');
const DISPLAY = (doneEvent.opening.match(/\$\$[\s\S]+?\$\$/g) ?? []).length;
check('开场反馈未出现多个独立公式（<3）', DISPLAY < 3, `${DISPLAY} 个`);
check('开场反馈未使用 \\boxed 给最终答案', !/\\boxed\{/.test(doneEvent.opening));
check('开场反馈不含"最终结果/答案："式表述', !/(最终|答案|结果为|解得)\s*[:：]?\s*\$/.test(doneEvent.opening));
check('开场反馈有反问（以问题引导）', /[？?]/.test(doneEvent.opening));
check('开场反馈篇幅克制（<600 字）', doneEvent.opening.length < 600, `${doneEvent.opening.length} 字`);

if (doneEvent.leakFlags?.length) {
  console.log(`\n  ⚠ 系统自报的泄露信号：${doneEvent.leakFlags.join('；')}`);
}

/* ---- 追问链路 ---- */
console.log('\n[追问] /api/homework/chat');
const hres = await fetch(`${B}/api/homework/chat`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    question: '我还是不懂，再提示一点',
    problem: doneEvent.problem,
    history: [],
  }),
});
check('HTTP 200', hres.status === 200, `得到 ${hres.status}`);

const rd2 = hres.body.getReader();
let buf2 = '', raw2 = '', seg2 = null, sum2 = null, flags2 = [], err2 = null;
const seen2 = new Set();
for (;;) {
  const { done, value } = await rd2.read();
  if (done) break;
  buf2 += dec.decode(value, { stream: true });
  let i;
  while ((i = buf2.indexOf('\n\n')) >= 0) {
    const part = buf2.slice(0, i).trim(); buf2 = buf2.slice(i + 2);
    if (!part.startsWith('data:')) continue;
    let ev; try { ev = JSON.parse(part.slice(5).trim()); } catch { continue; }
    seen2.add(ev.type);
    if (ev.type === 'text') raw2 += ev.content;
    if (ev.type === 'segments') { seg2 = ev.segments; sum2 = ev.summary; flags2 = ev.leakFlags ?? []; }
    if (ev.type === 'error') err2 = ev.message;
  }
}

check('无 error 事件', !err2, err2 ?? '');
check('收到 text 事件且非空', raw2.length > 0, `${raw2.length} 字`);
check('收到 segments 事件', !!seg2);
check('summary 字段齐全', !!(sum2 && typeof sum2.coverage === 'number'));
check('segments 结构正确',
  Array.isArray(seg2) && seg2.every((s) => typeof s.text === 'string' && s.source && Array.isArray(s.citations)));
check('追问回复也守边界（无 \\boxed、公式不连排）',
  !/\\boxed\{/.test(raw2) && (raw2.match(/\$\$[\s\S]+?\$\$/g) ?? []).length < 3);
check('leakFlags 是数组', Array.isArray(flags2));

console.log(`\n  追问正文（前 200 字）：${raw2.slice(0, 200).replace(/\n/g, ' ')}…`);
if (flags2.length) console.log(`  ⚠ 自报泄露信号：${flags2.join('；')}`);

console.log(`\n全场耗时 ${dt}s`);
console.log('\n═══════════════════════════════');
console.log(`通过 ${pass} ｜ 失败 ${fail}`);
if (problems.length) {
  console.log('\n失败项：');
  for (const x of problems) console.log('  · ' + x);
  console.log();
  process.exit(1);
}
console.log('作业辅导接口契约全部匹配。\n');
