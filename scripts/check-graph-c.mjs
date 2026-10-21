/**
 * Graph C（数学推导图）校验
 *   node scripts/check-graph-c.mjs
 *
 * Graph C 与 Graph A/B 的校验目标不同：
 *   - Graph B 强制**无环**（Kahn 拓扑排序），因为教学先修不能循环；
 *   - Graph C **允许有环**，所以改为检查**可追溯性**——
 *     每条推导边都必须写清楚「怎么推出来的」（steps 或 reason）。
 *
 * 检查项：
 *   1. 边类型是否都在 data/edge-types.json 中登记
 *   2. 边类型所属族是否为 derivational（防止把教学/词汇关系混进推导图）
 *   3. 两端节点是否存在，且节点类型与词表声明的 endpoints 一致
 *   4. 每条边是否有可追溯的推导说明（steps / reason）
 *   5. 悬空引用：节点上的 kp 是否指向真实存在的知识点
 *   6. 节点 id 唯一性
 *   7. 统计：环的个数（预期 > 0，这正是 Graph C 存在的理由）
 */
import fs from 'node:fs';

const errors = [];
const warnings = [];
const check = (ok, msg) => { if (!ok) errors.push(msg); };
const warn = (msg) => warnings.push(msg);

const c = JSON.parse(fs.readFileSync('data/graph-c-derivation.json', 'utf8'));
const vocab = JSON.parse(fs.readFileSync('data/edge-types.json', 'utf8'));
const pts = JSON.parse(fs.readFileSync('data/knowledge-points.json', 'utf8'));

const typeById = new Map(vocab.types.map((t) => [t.id, t]));
const kpIds = new Set(pts.map((p) => p.id));
const nodeById = new Map(c.nodes.map((n) => [n.id, n]));

/* ---- 1 & 6. 节点 ---- */
const seen = new Set();
for (const n of c.nodes) {
  check(!seen.has(n.id), `节点 id 重复：${n.id}`);
  seen.add(n.id);
  check(!!n.type, `节点 ${n.id} 缺少 type`);
  if (n.kp !== null && n.kp !== undefined) {
    check(kpIds.has(n.kp), `节点 ${n.id} 的 kp 指向不存在的知识点：${n.kp}`);
  }
}

/* ---- 2~4. 边 ---- */
let cycles = 0;
const adj = new Map();
for (const e of c.edges) {
  const t = typeById.get(e.rel);
  check(!!t, `边 ${e.from}→${e.to} 的类型「${e.rel}」未在 edge-types.json 中登记`);
  if (!t) continue;

  check(t.family === 'derivational',
    `边 ${e.from}→${e.to} 用了非推导族类型「${e.rel}」（族=${t.family}）——推导图只应使用 derivational 族`);

  const a = nodeById.get(e.from);
  const b = nodeById.get(e.to);
  check(!!a, `边的起点节点不存在：${e.from}`);
  check(!!b, `边的终点节点不存在：${e.to}`);
  if (a && b && t.endpoints) {
    // endpoints 的每一项可以是字符串，或字符串数组（表示该端允许多种节点类型）
    const allows = (spec, actual) => (Array.isArray(spec) ? spec.includes(actual) : spec === actual);
    const [wantA, wantB] = t.endpoints;
    check(allows(wantA, a.type),
      `边 ${e.from}→${e.to}（${e.rel}）起点类型应为 ${[].concat(wantA).join('|')}，实为 ${a.type}`);
    check(allows(wantB, b.type),
      `边 ${e.from}→${e.to}（${e.rel}）终点类型应为 ${[].concat(wantB).join('|')}，实为 ${b.type}`);
  }

  const traceable = String(e.steps ?? e.reason ?? '').trim();
  check(traceable.length >= 8,
    `边 ${e.from}→${e.to}（${e.rel}）缺少可追溯的推导说明（steps / reason）`);

  if (!adj.has(e.from)) adj.set(e.from, []);
  adj.get(e.from).push(e.to);
}

/* ---- 7. 环检测：这里**期望**存在环 ---- */
function findCycles() {
  const color = new Map();   // 0 未访问 1 在栈上 2 已完成
  let n = 0;
  const dfs = (u) => {
    color.set(u, 1);
    for (const v of adj.get(u) ?? []) {
      const cv = color.get(v) ?? 0;
      if (cv === 1) n++;
      else if (cv === 0) dfs(v);
    }
    color.set(u, 2);
  };
  for (const u of nodeById.keys()) if ((color.get(u) ?? 0) === 0) dfs(u);
  return n;
}
cycles = findCycles();
if (cycles === 0) {
  warn('Graph C 中未检测到任何环——若确为设计如此可以忽略，但数学图中量互定义通常应成环');
}

/* ---- 交叉检查：声明的 knownCycles 与实际是否一致 ---- */
for (const kc of c.knownCycles ?? []) {
  const has = kc.nodes.every((id) => nodeById.has(id));
  check(has, `knownCycles 声明了不存在的节点：${kc.nodes.join(', ')}`);
}

/* ---- 汇总 ---- */
console.log('\n═══ Graph C（数学推导图）校验 ═══\n');
console.log(`  节点 ${c.nodes.length} 个 ｜ 边 ${c.edges.length} 条 ｜ 检测到环 ${cycles} 个`);
const byType = {};
c.nodes.forEach((n) => { byType[n.type] = (byType[n.type] ?? 0) + 1; });
console.log('  节点类型分布：' + Object.entries(byType).map(([k, v]) => `${k} ${v}`).join('　'));
const relUse = {};
c.edges.forEach((e) => { relUse[e.rel] = (relUse[e.rel] ?? 0) + 1; });
console.log('  用到的边类型：' + Object.entries(relUse).map(([k, v]) => `${k}×${v}`).join('　'));

const unlinked = c.nodes.filter((n) => !n.kp).length;
console.log(`  未挂到知识点上的节点：${unlinked} / ${c.nodes.length}（如物理量 B、k、ω —— 说明教学图谱只建了概念，没建量）`);

console.log();
if (warnings.length) { console.log('  ⚠ 提示：'); warnings.forEach((w) => console.log('    · ' + w)); console.log(); }
if (errors.length) {
  console.log('  ✗ 错误：');
  errors.forEach((e) => console.log('    · ' + e));
  console.log(`\n通过 0 ｜ 失败 ${errors.length}\n`);
  process.exit(1);
}
console.log('  校验通过。注意：物理内容正确性不由本脚本保证——\n' +
  '  它只检查格式与可追溯性，推导是否成立须由物理专业逐条复核。\n');
