/**
 * 图谱查询层
 * ------------------------------------------------------------------
 * 所有对外能力都从这里出去。设计约束（沿用智卷的教训）：
 *   「学生哪里不行」必须是图运算算出来的，不是模型猜的。
 * 因此先修链、根因链、邻域全部在本层确定性求出，模型只负责组织语言。
 *
 * 先修方向约定：(a)-[:PREREQUISITE_OF]->(b) 表示 a 是 b 的先修。
 * 要查「b 的先修」用入边，要查「a 的后续」用出边。
 */

import { getConn, rows, row, scalar } from './kuzu.mjs';

const conn = () => getConn();

/* ============================ 章节树 ============================ */

export async function listChapters() {
  // 注意：Kuzu 里连续两个 OPTIONAL MATCH 时，第二个引用不到第一个引入的变量
  // （会报 "Binder exception: Variable s is not in scope"）。
  // 拆成独立查询再在 JS 里合并，比拼接 Cypher 更可靠。
  const chapters = await rows(
    conn(),
    `MATCH (c:Chapter)
     RETURN c.id AS id, c.no AS no, c.title AS title, c.summary AS summary
     ORDER BY c.no`
  );
  const secCounts = await rows(
    conn(),
    `MATCH (s:Section) RETURN s.chapterId AS cid, count(s) AS n`
  );
  const ptCounts = await rows(
    conn(),
    `MATCH (k:KnowledgePoint) RETURN k.chapterId AS cid, count(k) AS n`
  );
  const sm = new Map(secCounts.map((r) => [r.cid, r.n]));
  const pm = new Map(ptCounts.map((r) => [r.cid, r.n]));

  return chapters.map((c) => ({
    ...c,
    sectionCount: sm.get(c.id) ?? 0,
    pointCount: pm.get(c.id) ?? 0,
  }));
}

export async function chapterTree(chapterId) {
  const chapters = chapterId
    ? await rows(
        conn(),
        'MATCH (c:Chapter {id: $id}) RETURN c.id AS id, c.no AS no, c.title AS title, c.summary AS summary',
        { id: chapterId }
      )
    : await rows(
        conn(),
        'MATCH (c:Chapter) RETURN c.id AS id, c.no AS no, c.title AS title, c.summary AS summary ORDER BY c.no'
      );

  const out = [];
  for (const ch of chapters) {
    const sections = await rows(
      conn(),
      `MATCH (c:Chapter {id: $cid})-[:HAS_SECTION]->(s:Section)
       RETURN s.id AS id, s.no AS no, s.title AS title, s.summary AS summary
       ORDER BY s.no`,
      { cid: ch.id }
    );
    for (const s of sections) {
      s.points = await rows(
        conn(),
        `MATCH (s:Section {id: $sid})-[:HAS_POINT]->(k:KnowledgePoint)
         RETURN k.id AS id, k.name AS name, k.kind AS kind, k.difficulty AS difficulty
         ORDER BY k.name`,
        { sid: s.id }
      );
    }
    out.push({ ...ch, sections });
  }
  return out;
}

/* ============================ 节点详情 ============================ */

export async function getPoint(id) {
  const k = await row(
    conn(),
    `MATCH (k:KnowledgePoint {id: $id})
     RETURN k.id AS id, k.name AS name, k.sectionId AS sectionId, k.chapterId AS chapterId,
            k.kind AS kind, k.definition AS definition, k.keyPoints AS keyPoints,
            k.textbookRef AS textbookRef, k.difficulty AS difficulty`,
    { id }
  );
  if (!k) return null;

  const formulas = await rows(
    conn(),
    `MATCH (k:KnowledgePoint {id: $id})-[:HAS_FORMULA]->(f:Formula)
     RETURN f.id AS id, f.name AS name, f.latex AS latex, f.note AS note`,
    { id }
  );

  const place = await row(
    conn(),
    `MATCH (c:Chapter)-[:HAS_SECTION]->(s:Section {id: $sid})
     RETURN c.id AS chapterId, c.no AS chapterNo, c.title AS chapterTitle,
            s.no AS sectionNo, s.title AS sectionTitle`,
    { sid: k.sectionId }
  );

  return {
    ...k,
    keyPoints: safeParseArray(k.keyPoints),
    formulas,
    chapter: place ? { id: place.chapterId, no: place.chapterNo, title: place.chapterTitle } : null,
    section: place ? { no: place.sectionNo, title: place.sectionTitle } : null,
  };
}

export async function listPoints(chapterId) {
  const cy = chapterId
    ? `MATCH (k:KnowledgePoint {chapterId: $chapterId})
       RETURN k.id AS id, k.name AS name, k.chapterId AS chapterId, k.kind AS kind,
              k.difficulty AS difficulty, k.sectionId AS sectionId
       ORDER BY k.sectionId, k.name`
    : `MATCH (k:KnowledgePoint)
       RETURN k.id AS id, k.name AS name, k.chapterId AS chapterId, k.kind AS kind,
              k.difficulty AS difficulty, k.sectionId AS sectionId
       ORDER BY k.chapterId, k.sectionId, k.name`;
  return rows(conn(), cy, chapterId ? { chapterId } : undefined);
}

/* ============================ 先修 / 后续 ============================ */

/** 直接先修（入边） */
export async function directPrerequisites(id) {
  return rows(
    conn(),
    `MATCH (p:KnowledgePoint)-[r:PREREQUISITE_OF]->(k:KnowledgePoint {id: $id})
     RETURN p.id AS id, p.name AS name, p.chapterId AS chapterId,
            r.strength AS strength, r.reason AS reason
     ORDER BY p.chapterId`,
    { id }
  );
}

/** 直接后续（出边） */
export async function directDependents(id) {
  return rows(
    conn(),
    `MATCH (k:KnowledgePoint {id: $id})-[r:PREREQUISITE_OF]->(d:KnowledgePoint)
     RETURN d.id AS id, d.name AS name, d.chapterId AS chapterId,
            r.strength AS strength, r.reason AS reason
     ORDER BY d.chapterId`,
    { id }
  );
}

export async function related(id) {
  return rows(
    conn(),
    `MATCH (k:KnowledgePoint {id: $id})-[r:RELATES_TO]-(o:KnowledgePoint)
     RETURN o.id AS id, o.name AS name, o.chapterId AS chapterId,
            r.kind AS kind, r.note AS note`,
    { id }
  );
}

/**
 * 先修链回溯（BFS，带上每一跳的理由）
 * 这是本项目最有价值的查询：定位「到底哪一块基础断了」。
 * 第 1 层最靠近目标，层数越大越基础。
 *
 * 额外携带 weakest 字段：从目标到该节点这条链上**最弱的一环**。
 * 全是「强」边意味着这是硬前提；只要有一环是「弱」边，说明这条依赖可以绕开。
 * 诊断根因时这个区分很关键，否则弱关联会污染排序。
 */
export async function traceUpstream(id, maxDepth = 3) {
  const best = new Map(); // id -> { level, weakest }
  best.set(id, { level: 0, weakest: '强' });

  const levels = [];
  let frontier = [{ id, weakest: '强' }];

  for (let depth = 1; depth <= maxDepth && frontier.length; depth++) {
    const nextLevel = [];
    const nextFrontier = [];

    for (const cur of frontier) {
      const ups = await directPrerequisites(cur.id);
      for (const u of ups) {
        // 该路径上的最弱一环
        const weakest = cur.weakest === '弱' || u.strength === '弱' ? '弱' : '强';
        const prev = best.get(u.id);

        // 只保留「更近」或「同样近但链条更强」的记录
        const better =
          !prev ||
          depth < prev.level ||
          (depth === prev.level && weakest === '强' && prev.weakest === '弱');
        if (!better) continue;

        const isNew = !prev;
        best.set(u.id, { level: depth, weakest });

        if (isNew) {
          nextLevel.push({
            id: u.id,
            name: u.name,
            chapterId: u.chapterId,
            level: depth,
            strength: u.strength,
            weakest,
            reason: u.reason,
            via: cur.id,
            viaName: (await getPointName(cur.id)) ?? cur.id,
          });
          nextFrontier.push({ id: u.id, weakest });
        } else {
          // 已记录过但链条更强：更新该层的强度标记，必要时继续向下扩展
          const hit = nextLevel.find((n) => n.id === u.id);
          if (hit) hit.weakest = weakest;
          nextFrontier.push({ id: u.id, weakest });
        }
      }
    }

    if (nextLevel.length) levels.push(nextLevel);
    frontier = nextFrontier;
  }

  return levels;
}

export async function traceDownstream(id, maxDepth = 3) {
  const seen = new Set([id]);
  const out = [];
  let frontier = [id];
  for (let depth = 1; depth <= maxDepth && frontier.length; depth++) {
    const nextLevel = [];
    const nextFrontier = [];
    for (const cur of frontier) {
      const ds = await directDependents(cur);
      for (const d of ds) {
        if (seen.has(d.id)) continue;
        seen.add(d.id);
        nextLevel.push({ ...d, level: depth, viaName: (await getPointName(cur)) ?? cur });
        nextFrontier.push(d.id);
      }
    }
    if (nextLevel.length) out.push(nextLevel);
    frontier = nextFrontier;
  }
  return out;
}

/**
 * 根因诊断：给定若干「没学懂」的知识点，沿先修链向上找出同时支撑它们的薄弱基础。
 * 这是「先修诊断」能力的核心——多条链的交汇点往往就是真正的病根。
 */
export async function diagnoseRoots(strugglingIds, maxDepth = 3) {
  const support = new Map(); // id -> 累计信息

  for (const sid of strugglingIds) {
    const levels = await traceUpstream(sid, maxDepth);
    for (const level of levels) {
      for (const n of level) {
        if (!support.has(n.id)) {
          support.set(n.id, {
            id: n.id, name: n.name, chapterId: n.chapterId,
            level: n.level, supports: new Set(), reasons: [],
            strongPaths: 0, weakPaths: 0,
          });
        }
        const rec = support.get(n.id);
        rec.supports.add(sid);
        if (n.weakest === '强') rec.strongPaths++; else rec.weakPaths++;
        if (n.reason) rec.reasons.push(n.reason);
        // 层级取最深的一条，因为越基础越可能是真正的病根
        rec.level = Math.max(rec.level, n.level);
      }
    }
  }

  const symptoms = new Set(strugglingIds);

  const arr = [...support.values()].map((r) => {
    const supportedCount = r.supports.size;
    // 是否对每个症状都存在「全程强边」的依赖链
    const hard = r.strongPaths >= supportedCount;
    return {
      id: r.id,
      name: r.name,
      chapterId: r.chapterId,
      level: r.level,
      supportedCount,
      isHardPrerequisite: hard,
      isSymptomItself: symptoms.has(r.id),
      reasons: [...new Set(r.reasons)].slice(0, 3),
    };
  });

  // 决定性排序：支撑面越广越靠前 → 硬前提优先于弱关联 → 层级越基础越靠前
  arr.sort((a, b) =>
    b.supportedCount - a.supportedCount ||
    Number(b.isHardPrerequisite) - Number(a.isHardPrerequisite) ||
    b.level - a.level ||
    a.name.localeCompare(b.name, 'zh')
  );

  return arr;
}

/* ============================ 检索 ============================ */

export async function search(q, limit = 15) {
  const kw = String(q ?? '').trim();
  if (!kw) return [];
  return rows(
    conn(),
    `MATCH (k:KnowledgePoint)
     WHERE k.name CONTAINS $kw OR k.definition CONTAINS $kw
     RETURN k.id AS id, k.name AS name, k.chapterId AS chapterId,
            k.sectionId AS sectionId, k.kind AS kind, k.definition AS definition
     LIMIT ${Number(limit)}`,
    { kw }
  );
}

/**
 * 从一句自然语言提问里定位相关知识点。
 * 直接把整句丢给 CONTAINS 是匹配不到的（"为什么需要位移电流？" 不是任何节点名的子串），
 * 所以反过来做：遍历知识点，看哪个名字**出现在问题里**。
 * 只有 125 个节点，成本可以忽略，但命中率远高于关键词切分。
 */
export async function findFocusInQuestion(question, limit = 4) {
  const q = String(question ?? '');
  const all = await listPoints();
  const byId = new Map(all.map((p) => [p.id, p]));

  // 1) 节点名直接出现在提问里，名字越长越具体，优先
  const exact = all
    .filter((p) => p.name.length >= 2 && q.includes(p.name))
    .sort((a, b) => b.name.length - a.name.length);

  const picked = [];
  const seen = new Set();
  for (const p of exact) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    picked.push({ ...p, matchBy: 'name' });
  }

  // 2) 命中不够时，再用问题里的片段做模糊检索兜底
  if (picked.length < limit) {
    const tokens = q
      .split(/[，。、？！\s,.:;?!()（）【】"'"'']+/)
      .map((t) => t.trim())
      .filter((t) => t.length >= 2 && t.length <= 8);
    for (const t of tokens) {
      if (picked.length >= limit) break;
      const hits = await search(t, 3);
      for (const h of hits) {
        if (seen.has(h.id)) continue;
        seen.add(h.id);
        picked.push({ ...(byId.get(h.id) ?? h), matchBy: 'fuzzy' });
        if (picked.length >= limit) break;
      }
    }
  }

  return picked.slice(0, limit);
}

/* ============================ 提示词上下文 ============================ */

/**
 * 为一组知识点构造可注入提示词的子图描述。
 * 输出是紧凑的纯文本，模型可直接引用其中的节点 ID。
 */
export async function subgraphContext(kpIds) {
  const parts = [];
  const nodeIds = [];

  for (const id of kpIds) {
    const k = await getPoint(id);
    if (!k) continue;
    nodeIds.push(id);

    let block = `【知识点】${k.name}  [${id}]\n`;
    block += `  位置：${k.chapter?.no ?? ''}${k.chapter?.title ?? ''} · ${k.section?.no ?? ''}${k.section?.title ?? ''}\n`;
    block += `  教材出处：${k.textbookRef || '（未标注）'}\n`;
    if (k.definition) block += `  定义：${k.definition}\n`;
    if (k.keyPoints?.length) block += `  要点：\n${k.keyPoints.map((p) => `    - ${p}`).join('\n')}\n`;
    if (k.formulas?.length) {
      block += `  关键公式：\n${k.formulas.map((f) => `    - ${f.name}：${f.latex}${f.note ? `（${f.note}）` : ''}`).join('\n')}\n`;
    }

    const ups = await directPrerequisites(id);
    if (ups.length) {
      block += `  先修（学它之前必须先会）：\n${ups.map((u) => `    - ${u.name} [${u.id}]（${u.strength}）：${u.reason}`).join('\n')}\n`;
    }
    const downs = await directDependents(id);
    if (downs.length) {
      block += `  后续（学会它能支撑）：\n${downs.map((d) => `    - ${d.name} [${d.id}]`).join('、')}\n`;
    }
    const rels = await related(id);
    if (rels.length) {
      block += `  关联：${rels.map((r) => `${r.name} [${r.id}]（${r.kind}）`).join('、')}\n`;
    }

    parts.push(block);
  }

  return { text: parts.join('\n'), nodeIds };
}

/** 全书目录摘要，给模型全局感 */
export async function outlineContext() {
  const tree = await chapterTree();
  return tree
    .map((c) => {
      const secs = c.sections
        .map((s) => `  ${s.no} ${s.title}（${s.points.length} 个知识点）`)
        .join('\n');
      return `${c.no} ${c.title}\n${secs}`;
    })
    .join('\n\n');
}

/* ============================ 可视化取数 ============================ */

/**
 * 给前端可视化用的节点 + 边。
 * scope：
 *   'all'         全书（默认，节点较多，前端按章着色）
 *   'chapter:xx'  某一章
 *   'focus:ids'   某个知识点及其邻域（点开节点时用）
 */
export async function graphView({ scope = 'all', depth = 1 } = {}) {
  let nodes;
  let edgeFilter;

  if (scope.startsWith('chapter:')) {
    const chapterId = scope.slice('chapter:'.length);
    nodes = await rows(
      conn(),
      `MATCH (k:KnowledgePoint {chapterId: $cid})
       RETURN k.id AS id, k.name AS name, k.chapterId AS chapterId,
              k.sectionId AS sectionId, k.kind AS kind, k.difficulty AS difficulty`,
      { cid: chapterId }
    );
    edgeFilter = (a, b) => true;
  } else if (scope.startsWith('focus:')) {
    const seed = scope.slice('focus:'.length);
    const center = await getPoint(seed);
    if (!center) return { nodes: [], links: [], center: null };

    const neighborhood = new Map([[center.id, {
      id: center.id, name: center.name, chapterId: center.chapterId,
      sectionId: center.sectionId, kind: center.kind, difficulty: center.difficulty,
    }]]);
    const levels = await traceUpstream(seed, depth);
    for (const level of levels) {
      for (const n of level) {
        if (!neighborhood.has(n.id)) {
          neighborhood.set(n.id, {
            id: n.id, name: n.name, chapterId: n.chapterId, sectionId: '', kind: '', difficulty: '',
          });
        }
      }
    }
    const downs = await traceDownstream(seed, depth);
    for (const level of downs) {
      for (const n of level) {
        if (!neighborhood.has(n.id)) {
          neighborhood.set(n.id, {
            id: n.id, name: n.name, chapterId: n.chapterId, sectionId: '', kind: '', difficulty: '',
          });
        }
      }
    }
    nodes = [...neighborhood.values()];
    edgeFilter = (a, b) => neighborhood.has(a) && neighborhood.has(b);
  } else {
    nodes = await listPoints();
    edgeFilter = () => true;
  }

  const idSet = new Set(nodes.map((n) => n.id));
  const allEdges = await rows(
    conn(),
    `MATCH (a:KnowledgePoint)-[r:PREREQUISITE_OF]->(b:KnowledgePoint)
     RETURN a.id AS source, b.id AS target, r.strength AS strength, r.reason AS reason`
  );
  const allRelates = await rows(
    conn(),
    `MATCH (a:KnowledgePoint)-[r:RELATES_TO]->(b:KnowledgePoint)
     RETURN a.id AS source, b.id AS target, r.kind AS kind, r.note AS note`
  );

  const links = [
    ...allEdges
      .filter((e) => (scope === 'all' ? true : idSet.has(e.source) && idSet.has(e.target)))
      .map((e) => ({ ...e, type: 'prereq' })),
    ...allRelates
      .filter((e) => (scope === 'all' ? true : idSet.has(e.source) && idSet.has(e.target)))
      .map((e) => ({ ...e, type: 'relates' })),
  ];

  return {
    nodes,
    links,
    scope,
    center: scope.startsWith('focus:') ? scope.slice('focus:'.length) : null,
  };
}

/* ============================ 统计 ============================ */

export async function stats() {
  const s = await row(
    conn(),
    `MATCH (c:Chapter) WITH count(c) AS chapters
     MATCH (s:Section) WITH chapters, count(s) AS sections
     MATCH (k:KnowledgePoint) WITH chapters, sections, count(k) AS points
     MATCH (f:Formula) WITH chapters, sections, points, count(f) AS formulas
     MATCH ()-[p:PREREQUISITE_OF]->() WITH chapters, sections, points, formulas, count(p) AS prereq
     MATCH ()-[r:RELATES_TO]->()
     RETURN chapters, sections, points, formulas, prereq, count(r) AS relates`
  );
  return s;
}

/* ============================ 内部工具 ============================ */

async function getPointName(id) {
  const r = await row(conn(), 'MATCH (k:KnowledgePoint {id: $id}) RETURN k.name AS name', { id });
  return r?.name ?? null;
}

function safeParseArray(v) {
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string' || !v) return [];
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
