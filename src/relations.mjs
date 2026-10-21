/**
 * 关系层：把图谱里的每条边解析成「显式的关系类型」。
 *
 * 背景：数据里边的关系原先只靠**放在哪个数组里**区分（prerequisites[] / relates[]），
 * 以及关联边的一个自由文本 kind。词表 data/edge-types.json 把这些关系显式化，
 * 并对齐 W3C 的 SKOS 标准（13 种原生关系，分标签类 / 语义类 / 映射类三组）。
 *
 * 本模块做三件事，都**不改动源数据**：
 *   1. catalog()  —— 输出完整词表 + SKOS 13 种关系，供界面展示
 *   2. classify() —— 把一条边归一化成关系描述符（关系名 / 来源标准 / 数学性质）
 *   3. 关系种类统计 —— 用于自检与图例
 *
 * 为什么分类放在读取时算，而不是写回数据文件：
 *   现有 191 条边里，12 条关联边的 kind 迁移属于内容决策（见 docs/图谱扩展设计.md 的 P3），
 *   需要教研确认。在读取时映射可以先把界面做出来，等迁移审批通过再把 rel 落进数据文件，
 *   届时只需删掉这里的映射兜底，接口与界面完全不用动。
 */
import fs from 'node:fs';
import { FILES } from './config.mjs';

let cache = null;

/** 按 mtime 缓存：改完词表 JSON 不必重启服务 */
function load() {
  const { mtimeMs } = fs.statSync(FILES.edgeTypes);
  if (cache && cache.mtimeMs === mtimeMs) return cache;
  const raw = JSON.parse(fs.readFileSync(FILES.edgeTypes, 'utf8'));
  const byId = new Map(raw.types.map((t) => [t.id, t]));
  cache = { mtimeMs, raw, byId };
  return cache;
}

/** 标准标识 → 展示用名称 */
const STANDARD_LABEL = { skos: 'W3C SKOS', domain: '领域扩展' };

/**
 * 读法模板：把「A 关系 B」写成一句人话，界面填上两端节点名。
 * 「A」= from 端，「B」= to 端。只给能确定方向的类型写，其余留空——
 * 与其编一句读起来像那么回事的话，不如不写。
 */
const READING = {
  prerequisiteOf: '学「B」之前应先掌握「A」——箭头由前置知识指向依赖它的知识。',
  broader: '「A」是「B」的一种特殊情形（「B」更一般）。',
  narrower: '「A」比「B」更具体，「B」是「A」的一种。',
  seriesOrder: '「A」是「B」的低阶或弱化情形，按阶次递进。',
  theoreticalBasis: '「A」是「B」的理论依据。',
  related: '「A」与「B」是同一层级的并列定理，处理同类问题。',
};
const DERIV_READING = '「B」由「A」经这一步推出——箭头从已知的式子指向推出的结果。';

/** 取某关系类型的读法模板（含占位符），或 null */
export function readingTemplate(type) {
  if (!type) return null;
  if (READING[type.id]) return READING[type.id];
  return type.family === 'derivational' ? DERIV_READING : null;
}

/**
 * 归一化一条边的关系。
 * @param {{rel?:string, type?:string, kind?:string}} edge
 * @returns {object|null} 关系描述符
 */
export function classify(edge) {
  if (!edge) return null;
  const { raw, byId } = load();

  let id = null;
  let via = null;          // 这条边的类型是怎么判出来的，用于透明展示

  if (edge.rel && byId.has(edge.rel)) {
    // 已经显式声明了关系类型（Graph C 的推导边走这条）
    id = edge.rel;
    via = 'explicit';
  } else if (edge.type === 'prereq') {
    id = 'prerequisiteOf';
    via = 'origin';
  } else if (edge.type === 'relates') {
    const mapped = raw.migrationMap?.[edge.kind];
    // 迁移映射里的值可能带 ★ 注释，取前面的标识
    const clean = mapped ? mapped.split(/[\s★（]/)[0] : null;
    if (clean && byId.has(clean)) {
      id = clean;
      via = 'migration';
    } else {
      // 映射不到就落到 SKOS 的兜底类——但明确标出来，不假装它是具体类型
      id = 'relatedTo';
      via = 'fallback';
    }
  } else {
    return null;
  }

  const t = byId.get(id);
  if (!t) return null;

  // 该关系是不是 SKOS 的原生关系，若是则给出标准里的标识符
  const skosRef = t.standard === 'skos' ? `skos:${t.id}` : null;

  return {
    id: t.id,
    zh: t.zh,
    en: t.en,
    family: t.family,
    familyZh: raw._meta.families[t.family]?.split(' —— ')[0] ?? t.family,
    standard: t.standard,
    standardLabel: STANDARD_LABEL[t.standard] ?? t.standard,
    skosRef,
    symmetric: !!t.symmetric,
    transitive: !!t.transitive,
    allowsCycle: !!t.allowsCycle,
    note: t.note ?? null,
    readingTemplate: readingTemplate(t),
    via,
    isFallback: via === 'fallback',
  };
}

/** 完整词表：族 + SKOS 13 种 + 全部类型。界面图例与关系卡片用 */
export function catalog() {
  const { raw, byId } = load();
  const meta = raw._meta;

  const skos = meta.skos
    ? {
        ...meta.skos,
        relations: meta.skos.relations.map((r) => {
          const t = r.typeId ? byId.get(r.typeId) : null;
          return { ...r, zhFull: t?.zh ?? r.zh, note: t?.note ?? null };
        }),
      }
    : null;

  return {
    families: meta.families,
    skos,
    types: raw.types.map((t) => ({
      id: t.id, zh: t.zh, en: t.en, family: t.family, familyZh: meta.families[t.family]?.split(' —— ')[0] ?? t.family,
      standard: t.standard, standardLabel: STANDARD_LABEL[t.standard] ?? t.standard,
      symmetric: !!t.symmetric, transitive: !!t.transitive, allowsCycle: !!t.allowsCycle,
      inUse: !!t.inUse, note: t.note ?? null,
      readingTemplate: readingTemplate(t),
    })),
  };
}

/** 现有 191 条边按关系类型统计——用于自检和确认「兜底类没有被滥用」 */
export function statistics(edges) {
  const byId = new Map();
  let fallback = 0;
  for (const e of edges) {
    const r = classify(e);
    if (!r) continue;
    const cur = byId.get(r.id) ?? { id: r.id, zh: r.zh, family: r.family, standard: r.standard, count: 0 };
    cur.count += 1;
    byId.set(r.id, cur);
    if (r.isFallback) fallback += 1;
  }
  return {
    total: edges.length,
    kinds: [...byId.values()].sort((a, b) => b.count - a.count),
    fallback,
  };
}
