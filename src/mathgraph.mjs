/**
 * Graph C —— 数学推导图的读取与回溯
 * ------------------------------------------------------------------
 * 职责：回答「这个概念/这个式子是**怎么来的**」。
 *
 * 与 Graph B（教学先修）的分工：
 *   - Graph B 说「该先学谁」，由 Kuzu 做图运算，必须无环；
 *   - Graph C 说「数学上怎么推出来」，**允许成环**（量互相定义）。
 *
 * 为什么暂时直接读 JSON 而不入库：
 *   Graph C 目前是 10 节点的样板。入库需要改 Kuzu schema 并重新 ingest，
 *   而现有 462 条边的库有停机成本。反向回溯在内存里做只有微秒级开销。
 *   等 Graph C 扩到整门课（预期上百节点）再按 Graph A/B 的同样方式入库。
 *   —— 这是有意的取舍，不是遗漏。
 */
import fs from 'node:fs';
import { FILES } from './config.mjs';

let cache = null;

/** 按 mtime 缓存：改完 JSON 不必重启服务就能看到效果 */
function load() {
  const mtC = fs.statSync(FILES.graphC).mtimeMs;
  const mtV = fs.statSync(FILES.edgeTypes).mtimeMs;
  if (cache && cache.mtC === mtC && cache.mtV === mtV) return cache;

  const c = JSON.parse(fs.readFileSync(FILES.graphC, 'utf8'));
  const vocab = JSON.parse(fs.readFileSync(FILES.edgeTypes, 'utf8'));

  const nodeById = new Map(c.nodes.map((n) => [n.id, n]));
  const typeById = new Map(vocab.types.map((t) => [t.id, t]));

  // 反向邻接：to → [{ edge, from }]，用于「从结果往成因回溯」
  const incoming = new Map();
  for (const e of c.edges) {
    if (!incoming.has(e.to)) incoming.set(e.to, []);
    incoming.get(e.to).push(e);
  }

  // kp → 数学节点（一一对应；若多个节点挂同一 kp 取第一个）
  const byKp = new Map();
  for (const n of c.nodes) if (n.kp) byKp.set(n.kp, n);

  cache = { c, vocab, nodeById, typeById, incoming, byKp, mtC, mtV };
  return cache;
}

/**
 * 节点摘要（用于前端渲染与跳转）
 *
 * 带上 note：它是**纯中文散文**，适合直接塞进 title 浮层。
 * 不能拿 steps 当浮层文案——steps 里现在是 LaTeX（$...$），
 * 原生 title 不支持渲染，会把源码原样显示出来。
 */
function briefOf(L, id) {
  const n = L.nodeById.get(id);
  return n
    ? {
        id: n.id, name: n.name, type: n.type,
        expr: n.expr ?? null, note: n.note ?? null, kp: n.kp ?? null,
      }
    : { id, name: id, type: null, expr: null, note: null, kp: null };
}

/** 把一条边补上可展示信息（关系中文名、两端节点摘要） */
function decorate(edge, L) {
  const t = L.typeById.get(edge.rel);
  return {
    from: briefOf(L, edge.from),
    to: briefOf(L, edge.to),
    rel: edge.rel,
    relZh: t?.zh ?? edge.rel,
    relFamily: t?.family ?? null,
    steps: edge.steps ?? edge.reason ?? '',
    review: edge.review ?? 'unknown',
    cycleWith: edge.cycleWith ?? null,
  };
}

/** 某知识点在数学推导图中对应的节点（没有则 null） */
export function mathNodeByKp(kpId) {
  const L = load();
  const n = L.byKp.get(kpId);
  return n ? { ...n } : null;
}

/**
 * 从某个知识点出发，反向回溯它的推导链。
 *
 * @param {string} kpId   知识点 id
 * @param {number} maxDepth 最多回溯几层（防止样板之外意外展开过大）
 * @returns {null | object} null 表示该知识点在数学图中没有节点
 */
export function derivationChain(kpId, maxDepth = 5) {
  const L = load();
  const start = L.byKp.get(kpId);
  if (!start) return null;

  const levels = [];
  const visited = new Set([start.id]);
  const usedEdges = [];
  let frontier = [start.id];

  for (let depth = 1; depth <= maxDepth; depth++) {
    const edges = [];
    const next = [];
    for (const id of frontier) {
      for (const e of L.incoming.get(id) ?? []) {
        if (visited.has(e.from)) continue;   // 已访问（含成环情形）不再展开
        visited.add(e.from);
        next.push(e.from);
        edges.push(decorate(e, L));
        usedEdges.push(e);
      }
    }
    if (!edges.length) break;
    levels.push({ depth, edges });
    frontier = next;
  }

  // 图里声明的环中，只要有一个节点出现在本次链路上就提示出来。
  // 顺带把 id 翻成人看的名字：knownCycles 里存的是 cq_E / cq_B，
  // 这两个标识符摆给学生看没有意义，界面上要显示「电场强度 E ⇄ 磁感应强度 B」。
  const cycles = (L.c.knownCycles ?? [])
    .filter((kc) => kc.nodes.some((id) => visited.has(id)))
    .map((kc) => ({
      ...kc,
      names: kc.nodes.map((id) => L.nodeById.get(id)?.name ?? id),
    }));

  /**
   * 前提假设。
   *
   * `assumes` 的方向是「方程 → 前提」，属**正向边**，所以上面的反向回溯走不到它。
   * 但前提恰恰是「怎么来的」的一部分（没有无源假设就没有波动方程），
   * 所以这里单独把它收集出来，而不是混进层级链里。
   */
  const preconditions = [];
  const seenPre = new Set();
  for (const id of visited) {
    for (const e of L.c.edges) {
      if (e.from !== id || e.rel !== 'assumes') continue;
      if (seenPre.has(e.to)) continue;
      seenPre.add(e.to);
      const pre = decorate(e, L);
      pre.assumedBy = briefOf(L, id);
      preconditions.push(pre);
    }
  }

  const pending = [...usedEdges, ...(L.incoming.get(start.id) ?? [])]
    .filter((e, i, a) => a.indexOf(e) === i)
    .filter((e) => (e.review ?? 'unknown') !== 'approved').length;

  return {
    kp: kpId,
    node: {
      id: start.id, type: start.type, name: start.name,
      expr: start.expr ?? null, note: start.note ?? null,
    },
    levels,
    preconditions,
    cycles,
    pending: pending + preconditions.filter((p) => p.review !== 'approved').length,
    truncated: levels.length === maxDepth && (L.incoming.get(frontier[0]) ?? []).length > 0,
    meta: {
      graph: L.c._meta.name,
      status: L.c._meta.status,
      reviewWarning: L.c._meta['⚠️_review'] ?? null,
    },
  };
}

/** 供状态栏显示 */
export function mathGraphStats() {
  const L = load();
  let cycles = 0;
  {
    // 简单环计数：有向边里 to→from 也存在的成对关系算一个环
    const set = new Set(L.c.edges.map((e) => `${e.from}→${e.to}`));
    for (const e of L.c.edges) if (set.has(`${e.to}→${e.from}`)) cycles++;
    cycles = cycles / 2;
  }
  return {
    nodes: L.c.nodes.length,
    edges: L.c.edges.length,
    cycles,
    types: new Set(L.c.edges.map((e) => e.rel)).size,
    unmapped: L.c.nodes.filter((n) => !n.kp).length,
  };
}

/** 供前端一次性拿到边类型词表（图例与边详情面板用） */
export function edgeTypes() {
  const L = load();
  return L.vocab.types;
}
