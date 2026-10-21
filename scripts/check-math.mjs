/**
 * 公式渲染全量检查
 * ------------------------------------------------------------------
 * 把图谱里所有 LaTeX 公式过一遍 KaTeX，确认都能渲染成人类可读的公式。
 * 顺带验证前端 renderRich 的分段逻辑（抽出数学 → 转义其余 → 还原数学）。
 */

import fs from 'node:fs';
import katex from 'katex';
import { FILES } from '../src/config.mjs';

const points = JSON.parse(fs.readFileSync(FILES.points, 'utf8'));

console.log('\n═══ LaTeX 公式渲染检查 ═══\n');

let total = 0, ok = 0, bad = [];
const byKp = [];

for (const k of points) {
  for (const f of k.formulas ?? []) {
    total++;
    let html = '';
    let err = null;
    try {
      html = katex.renderToString(String(f.latex).trim(), {
        displayMode: true, throwOnError: false, strict: false,
      });
    } catch (e) { err = e.message; }

    const rendered = !err && html.includes('katex') && !html.includes('katex-error');
    if (rendered) ok++;
    else bad.push({ kp: k.name, name: f.name, latex: f.latex, err: err ?? '输出含 katex-error' });
    byKp.push({ kp: k.name, name: f.name, latex: f.latex, rendered, size: html.length });
  }
}

console.log(`公式总数 ${total} ｜ 渲染成功 ${ok} ｜ 失败 ${bad.length}`);

if (bad.length) {
  console.log('\n【渲染失败】');
  for (const b of bad) console.log(`  · ${b.kp} / ${b.name}\n    ${b.latex}\n    ${b.err}`);
} else {
  console.log('\n✓ 全部公式均可渲染为可视公式');
}

// 抽样展示（即用户截图里出问题的那几条所在的知识点）
console.log('\n【抽样：δ 与 ε 符号 / 二阶算符恒等式】');
const samples = [
  ['矢量加减与标积矢积', '标积'], ['矢量加减与标积矢积', '矢积'],
  ['二阶算符恒等式', '旋度无散'], ['二阶算符恒等式', '梯度无旋'], ['二阶算符恒等式', '旋度旋度'],
  ['麦克斯韦方程组', '高斯定理'], ['平面电磁波', '平面波解'],
  ['推迟势', '推迟势'], ['穿透深度', '穿透深度'], ['质能关系', '质能关系'],
];
for (const [kpName, fName] of samples) {
  const kp = points.find((p) => p.name === kpName);
  const f = kp?.formulas?.find((x) => x.name.includes(fName));
  if (!f) { console.log(`  ? ${kpName} / ${fName} —— 未找到`); continue; }
  const row = byKp.find((r) => r.latex === f.latex);
  console.log(`  ${row?.rendered ? '✓' : '✗'} ${fName.padEnd(10)} ${f.latex}`);
}

/* ---------- renderRich 分段逻辑验证 ---------- */
console.log('\n═══ renderRich 分段逻辑 ═══\n');

// 复刻前端 renderRich 的数学抽取部分（纯逻辑，不涉及 DOM）
function extractMath(rawText) {
  let s = String(rawText ?? '');
  const math = [];
  const stash = (tex, display) => {
    math.push({ tex, display });
    return `\u0000M${math.length - 1}\u0000`;
  };
  const blocks = [];
  s = s.replace(/```[\s\S]*?```|`[^`\n]+`/g, (m) => { blocks.push(m); return `\u0000C${blocks.length - 1}\u0000`; });
  s = s.replace(/\$\$([\s\S]+?)\$\$/g, (m, t) => stash(t, true));
  s = s.replace(/\\\[([\s\S]+?)\\\]/g, (m, t) => stash(t, true));
  s = s.replace(/\$([^$\n]+?)\$/g, (m, t) => stash(t, false));
  s = s.replace(/\\\(([\s\S]+?)\\\)/g, (m, t) => stash(t, false));
  return { s, math, blocks };
}

const cases = [
  ['行内公式', '安培环路定理写成 $\\nabla \\times \\vec{H} = \\vec{J}$ 的形式。'],
  ['显示公式', '于是\n$$\\nabla \\times \\vec{H} = \\vec{J} + \\frac{\\partial \\vec{D}}{\\partial t}$$\n成立。'],
  ['多个公式', '先有 $\\oint_L \\vec{A}\\cdot d\\vec{l}$，再有 $\\nabla\\cdot\\vec{B}=0$ 的结论。'],
  ['含对齐符的公式', '$$\\begin{vmatrix}A_x&A_y\\\\B_x&B_y\\end{vmatrix}$$'],
  ['代码块不渲染', '用 `$PATH` 这个变量，公式 $x^2$ 才渲染。'],
  ['无公式', '这是一段纯中文，不该出现公式。'],
];

let cOk = 0;
for (const [label, text] of cases) {
  const { s, math, blocks } = extractMath(text);
  const escaped = s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  // 还原后的 HTML 里不应残留占位符
  const restored = escaped
    .replace(/\u0000M(\d+)\u0000/g, (m, i) => katex.renderToString(math[i].tex, { displayMode: math[i].display, throwOnError: false }))
    .replace(/\u0000C(\d+)\u0000/g, () => '[code]');
  const leftover = /[\u0000]/.test(restored);
  const hasKatex = restored.includes('katex');
  const expectMath = label !== '无公式';
  const pass = !leftover && (hasKatex === expectMath);
  if (pass) cOk++;
  console.log(`  ${pass ? '✓' : '✗'} ${label}：抽出数学 ${math.length} 段，代码 ${blocks.length} 段，`
    + `渲染 ${hasKatex ? '有' : '无'}公式${leftover ? '，残留占位符！' : ''}`);
}

console.log(`\n分段逻辑 ${cOk}/${cases.length} 通过`);

/* ---------- Graph C：推导图里的公式同样要「人能看」 ---------- */
console.log('\n═══ Graph C 公式渲染检查 ═══\n');

const gc = JSON.parse(fs.readFileSync(FILES.graphC, 'utf8'));
const gErr = [];

/** 一段 LaTeX 能不能渲染成人类可读的公式（不抛异常、不出现 katex-error） */
function renders(tex, display) {
  try {
    const h = katex.renderToString(String(tex).trim(), {
      displayMode: display, throwOnError: false, strict: false,
    });
    return h.includes('katex') && !h.includes('katex-error');
  } catch { return false; }
}

// ① 节点 expr：整段就是数学，按行间公式渲染
const exprNodes = gc.nodes.filter((n) => n.expr);
let exprOk = 0;
for (const n of exprNodes) {
  if (renders(n.expr, true)) exprOk++;
  else gErr.push(`节点 ${n.id} 的 expr 渲染失败：${n.expr}`);
}
console.log(`节点 expr：${exprOk}/${exprNodes.length} 可渲染为可视公式`);

// ② 边 steps：正文是中文，数学必须包在 $...$ 里。
//    这是「人看不看得懂」的硬门槛——漏掉包裹，界面上剩下的就是一行反斜杠。
const INLINE = /\$([^$\n]+?)\$/g;
let segTotal = 0, segOk = 0, leak = 0;
for (const e of gc.edges) {
  const s = String(e.steps ?? '');
  const segs = [...s.matchAll(INLINE)];
  segTotal += segs.length;
  for (const m of segs) {
    if (renders(m[1], false)) segOk++;
    else gErr.push(`边 ${e.from}→${e.to} 的公式渲染失败：${m[1]}`);
  }
  if ((s.match(/\$/g) ?? []).length % 2 !== 0) {
    gErr.push(`边 ${e.from}→${e.to} 的 $ 未配对 —— 会有一段数学漏出源码`);
  }
  const hit = s.replace(INLINE, '［公式］').match(/\\[a-zA-Z]+/);
  if (hit) {
    leak++;
    gErr.push(`边 ${e.from}→${e.to} 有裸 LaTeX（未用 $ 包裹）：${hit[0]}`);
  }
}
console.log(`边 steps 行内公式：${segOk}/${segTotal} 可渲染`);
console.log(`裸 LaTeX 泄漏：${leak} 处`);

// ③ 反查伪公式。分两个范围看，混在一起会误报：
//    正文里（$...$ 之外）不该出现 ^{ 或 Unicode 上下标——那是源码漏出来了；
//    公式里也不该拿 Unicode 上下标凑数（KaTeX 认它当普通字符，排出来偏上偏下都不对）。
const fake = [];
const UNI = /[₀₁₂₃₄₅₆₇₈₉⁰¹²³⁴⁵⁶⁷⁸⁹\u00B2\u00B3\u00B9]/;
for (const e of gc.edges) {
  const s = String(e.steps ?? '');
  const prose = s.replace(INLINE, '［公式］');
  const hits = [];
  const m1 = prose.match(/\^\{|\^\(/);
  if (m1) hits.push(`${m1[0]}（出现在正文里，说明 $ 没包住）`);
  const m2 = prose.match(UNI);
  if (m2) hits.push(`${m2[0]}（出现在正文里）`);
  for (const m of s.matchAll(INLINE)) {
    const m3 = m[1].match(UNI);
    if (m3) hits.push(`${m3[0]}（在公式里，应写成 ^{2} / _{x}）`);
  }
  if (hits.length) fake.push(`边 ${e.from}→${e.to}：${hits.join('、')}`);
}
for (const n of exprNodes) {
  const m = String(n.expr).match(UNI);
  if (m) fake.push(`节点 ${n.id}：${m[0]}（在公式里，应写成 ^{2} / _{x}）`);
}
if (fake.length) { gErr.push(...fake.map((f) => `Unicode 伪公式残留 ${f}`)); }
console.log(`Unicode 伪公式残留：${fake.length} 处`);

if (gErr.length) {
  console.log('\n【Graph C 渲染问题】');
  gErr.forEach((x) => console.log('  · ' + x));
} else {
  console.log('\n✓ Graph C 的每个式子都能渲染成人可读的公式，且无源码泄漏');
}

const allOk = bad.length === 0 && cOk === cases.length && gErr.length === 0;
console.log(allOk ? '\n✓ 公式渲染检查全部通过\n' : '\n✗ 存在问题\n');
process.exit(allOk ? 0 : 1);
