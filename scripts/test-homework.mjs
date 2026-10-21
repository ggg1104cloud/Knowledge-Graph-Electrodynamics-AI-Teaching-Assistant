/**
 * 作业链路测试（单题模式：照片 → 视觉识别 → 图谱 → 诊断 → 引导）
 *   node scripts/test-homework.mjs [图片路径]
 *   默认用 samples/homework-multi.png（干净白底、三题印刷体，最能看出"只处理一道题"）
 *
 * 注意：这条链路不再使用 MinerU，识别改由 GLM 视觉模型直读（src/vision.mjs）。
 */
import fs from 'node:fs';
import * as V from '../src/vision.mjs';
import * as H from '../src/homework.mjs';
import { closeDb } from '../src/kuzu.mjs';

const img = process.argv[2] || 'samples/homework-multi.png';
const t0 = Date.now();
const lap = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

console.log(`\n图片：${img}\n`);

console.log('════════ 1. 视觉识别（' + V.visionInfo().model + '）════════');
const rec = await V.recognizeProblem(fs.readFileSync(img), {
  mime: 'image/png',
  onProgress: (m) => console.log('       ', m),
});
lap(`识别完成（${(rec.elapsedMs / 1000).toFixed(1)}s）`);

console.log(`\n  isProblem   : ${rec.isProblem}`);
console.log(`  题号        : ${rec.no || '（未标注）'}`);
console.log(`  题干        : ${rec.question}`);
console.log(`  解答        : ${rec.solution || '（无）'}`);
if (rec.uncertain?.length) {
  console.log('  不确定处    :');
  for (const u of rec.uncertain) console.log(`    · ${u}`);
}
if (rec.extraDetected?.length) {
  console.log(`  同时检测到  : ${rec.extraDetected.join('、')}`);
}

console.log('\n════════ 2. 单题约束检查 ════════');
const single = H.checkSingleProblem(rec);
console.log(`  通过：${single.ok}`);
for (const s of single.issues) console.log(`    ⚠ ${s}`);

const problem = H.toProblem(rec);
console.log(`\n  整理后：no=${problem.no} solutionKind=${problem.solutionKind} degraded=${problem.degraded}`);

if (!rec.isProblem && !problem.question) {
  console.log('\n没有识别到题目，链路到此结束。');
  closeDb();
  process.exit(0);
}

console.log('\n════════ 3. 图谱标记 ════════');
const nodes = await H.locateNodes(problem);
problem.nodes = nodes;
lap(`命中 ${nodes.length} 个知识点`);
for (const n of nodes) console.log(`    ${n.matchBy === 'semantic' ? '语义' : '字面'}  ${n.name}  [${n.id}]`);

console.log('\n════════ 4. 诊断 + 根因 ════════');
const diagnosis = await H.diagnoseProblem(problem, nodes);
problem.diagnosis = diagnosis;
lap(`判定：${diagnosis.verdict}`);
console.log(`    结论：${diagnosis.verdict}`);
if (diagnosis.reason) console.log(`    说明：${diagnosis.reason}`);
for (const m of diagnosis.mistakes) {
  console.log(`    疑点：${m.point}`);
  console.log(`          依据：${m.evidence}`);
  console.log(`          节点：${m.nodeId || '（无）'}${m.droppedNodeId ? `  [丢弃的假ID: ${m.droppedNodeId}]` : ''}`);
}
if (diagnosis.notCovered?.length) console.log(`    未覆盖：${diagnosis.notCovered.join('；')}`);
if (diagnosis.unreliable?.length) console.log(`    不确定处：${diagnosis.unreliable.length} 条（已排除出判定）`);
if (diagnosis.retakeHints?.length) {
  console.log('    重拍建议：');
  for (const h of diagnosis.retakeHints) console.log(`      · ${h}`);
}

const roots = await H.traceRoots(nodes, diagnosis.mistakes);
problem.roots = roots;
if (roots.roots.length) {
  console.log('    候选根因：');
  for (const r of roots.roots.slice(0, 4)) {
    console.log(`      · ${r.name} [${r.id}] ${r.isHardPrerequisite ? '硬前提' : '弱关联'} 支撑${r.supportedCount}个 第${r.level}层`);
  }
}

console.log('\n════════ 5. 开场引导 ════════');
const opening = await H.buildOpening({
  problem, diagnosis, nodes, extraDetected: problem.extraDetected,
});
lap('引导生成完成');
console.log(opening);
console.log('\n答案泄露检测：', H.detectAnswerLeak(opening).join('；') || '无信号');

closeDb();
