/**
 * 图谱数据校验
 * ------------------------------------------------------------------
 * 在导入 Kuzu 之前把数据错误拦下来，比入库后再排查便宜得多。
 * 检查项：
 *   1. JSON 可解析
 *   2. 引用完整性：每个 sectionId / from / to 都指向真实存在的节点
 *   3. ID 唯一性
 *   4. **无环**：先修关系必须是 DAG。用 Kahn 拓扑排序检测。
 *   5. 自环、重复边
 *   6. 覆盖率统计
 */

import fs from 'node:fs';
import { FILES } from '../src/config.mjs';

const errors = [];
const warnings = [];

function load(p, label) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    errors.push(`${label} 无法解析：${e.message}`);
    return null;
  }
}

const chaptersDoc = load(FILES.chapters, 'graph-a-chapters.json');
const points = load(FILES.points, 'knowledge-points.json');
const prereqDoc = load(FILES.prereq, 'graph-b-prerequisites.json');

if (errors.length) { report(); process.exit(1); }

/* ---------- 1. 收集节点 ---------- */
const chapterById = new Map();
const sectionById = new Map();
const sectionToChapter = new Map();

for (const c of chaptersDoc.chapters) {
  if (chapterById.has(c.id)) errors.push(`章 ID 重复：${c.id}`);
  chapterById.set(c.id, c);
  for (const s of c.sections) {
    if (sectionById.has(s.id)) errors.push(`节 ID 重复：${s.id}`);
    sectionById.set(s.id, s);
    sectionToChapter.set(s.id, c.id);
  }
}

const pointById = new Map();
for (const k of points) {
  if (pointById.has(k.id)) errors.push(`知识点 ID 重复：${k.id}`);
  pointById.set(k.id, k);
}
const pointIds = new Set(pointById.keys());

/* ---------- 2. 引用完整性 ---------- */
for (const k of points) {
  if (!sectionById.has(k.sectionId)) errors.push(`知识点 ${k.id} 的 sectionId 不存在：${k.sectionId}`);
  if (!k.name) errors.push(`知识点 ${k.id} 缺少名称`);
  if (!k.definition) warnings.push(`知识点 ${k.id}（${k.name}）缺少定义`);
}

const edges = [];
const seenEdge = new Set();
for (const e of prereqDoc.prerequisites) {
  if (!pointIds.has(e.from)) errors.push(`先修边 from 不存在：${e.from}`);
  if (!pointIds.has(e.to)) errors.push(`先修边 to 不存在：${e.to}`);
  if (e.from === e.to) errors.push(`自环：${e.from}`);
  const key = `${e.from}->${e.to}`;
  if (seenEdge.has(key)) warnings.push(`重复先修边：${key}`);
  seenEdge.add(key);
  edges.push(e);
}

const relates = [];
for (const e of prereqDoc.relates) {
  if (!pointIds.has(e.from)) errors.push(`相关边 from 不存在：${e.from}`);
  if (!pointIds.has(e.to)) errors.push(`相关边 to 不存在：${e.to}`);
  if (e.from === e.to) errors.push(`相关边自环：${e.from}`);
  relates.push(e);
}

/* ---------- 3. 无环检测（Kahn 拓扑排序） ---------- */
const adj = new Map();
const indeg = new Map();
for (const id of pointIds) { adj.set(id, []); indeg.set(id, 0); }
for (const e of edges) {
  adj.get(e.from).push(e.to);
  indeg.set(e.to, indeg.get(e.to) + 1);
}

const queue = [...pointIds].filter((id) => indeg.get(id) === 0);
const order = [];
const indegWork = new Map(indeg);
while (queue.length) {
  const n = queue.shift();
  order.push(n);
  for (const m of adj.get(n)) {
    indegWork.set(m, indegWork.get(m) - 1);
    if (indegWork.get(m) === 0) queue.push(m);
  }
}

const isDag = order.length === pointIds.size;

if (!isDag) {
  // 定位环：剩下入度 > 0 的节点就在环上或环的下游
  const stuck = [...pointIds].filter((id) => indegWork.get(id) > 0);
  errors.push(`先修图存在环！涉及 ${stuck.length} 个节点：${stuck.map((id) => pointById.get(id)?.name ?? id).join('、')}`);

  // 深度优先找出一个具体的环，便于修复
  const cycle = findCycle(adj, stuck);
  if (cycle) {
    errors.push(`具体环路：${cycle.map((id) => pointById.get(id)?.name ?? id).join(' → ')}`);
  }
}

function findCycle(adjacency, candidates) {
  const color = new Map(); // 0 未访问 1 在栈上 2 已完成
  const stack = [];
  let found = null;

  function dfs(n) {
    if (found) return;
    color.set(n, 1);
    stack.push(n);
    for (const m of adjacency.get(n) ?? []) {
      if (found) return;
      if (color.get(m) === 1) {
        found = stack.slice(stack.indexOf(m)).concat(m);
        return;
      }
      if (!color.get(m)) dfs(m);
    }
    stack.pop();
    color.set(n, 2);
  }

  for (const c of candidates) if (!color.get(c)) dfs(c);
  return found;
}

/* ---------- 4. 冗余边检测（可由传递闭包推出） ---------- */
const reach = new Map();
function reachableFrom(start) {
  if (reach.has(start)) return reach.get(start);
  const out = new Set();
  const st = [...(adj.get(start) ?? [])];
  while (st.length) {
    const n = st.pop();
    if (out.has(n)) continue;
    out.add(n);
    for (const m of adj.get(n) ?? []) st.push(m);
  }
  reach.set(start, out);
  return out;
}

for (const e of edges) {
  const direct = adj.get(e.from) ?? [];
  const indirect = [];
  for (const mid of direct) {
    if (mid === e.to) continue;
    if (reachableFrom(mid).has(e.to)) indirect.push(mid);
  }
  if (indirect.length) {
    warnings.push(
      `冗余先修边 ${pointById.get(e.from)?.name} → ${pointById.get(e.to)?.name}` +
      `（可经 ${indirect.map((m) => pointById.get(m)?.name).join('、')} 传递推出）`
    );
  }
}

/* ---------- 5. 统计 ---------- */
const secToCh = sectionToChapter;
const byChapter = new Map();
for (const k of points) {
  const ch = secToCh.get(k.sectionId);
  byChapter.set(ch, (byChapter.get(ch) ?? 0) + 1);
}

const noIn = [...pointIds].filter((id) => !edges.some((e) => e.to === id));
const noOut = [...pointIds].filter((id) => !edges.some((e) => e.from === id));

function report() {
  console.log('\n══════════ 图谱数据校验 ══════════\n');
  console.log(`章 ${chapterById.size} 个 ｜ 节 ${sectionById.size} 个 ｜ 知识点 ${pointById.size} 个`);
  console.log(`先修边 ${edges.length} 条 ｜ 相关边 ${relates.length} 条`);
  console.log(`公式 ${points.reduce((a, k) => a + ((k.formulas?.length) ?? 0), 0)} 条`);
  console.log(`\nDAG 无环：${isDag ? '✓ 通过' : '✗ 失败'}`);
  console.log(`拓扑序长度 ${order.length} / ${pointIds.size}`);
  console.log(`\n入度为零（基础节点）${noIn.length} 个：${noIn.map((id) => pointById.get(id).name).join('、')}`);
  console.log(`出度为零（终点节点）${noOut.length} 个`);

  console.log('\n各章知识点分布：');
  for (const c of chaptersDoc.chapters) {
    console.log(`  ${c.no} ${c.title.padEnd(20, '　')} ${String(byChapter.get(c.id) ?? 0).padStart(3)} 个`);
  }

  if (warnings.length) {
    console.log(`\n⚠ 警告 ${warnings.length} 条：`);
    for (const w of warnings.slice(0, 15)) console.log('  · ' + w);
    if (warnings.length > 15) console.log(`  …（还有 ${warnings.length - 15} 条）`);
  }

  if (errors.length) {
    console.log(`\n✗ 错误 ${errors.length} 条：`);
    for (const e of errors) console.log('  · ' + e);
    console.log('\n校验未通过。\n');
  } else {
    console.log('\n✓ 校验全部通过。\n');
  }
}

report();
process.exit(errors.length ? 1 : 0);
