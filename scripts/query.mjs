/**
 * 图谱查询 CLI
 * ------------------------------------------------------------------
 *   node scripts/query.mjs stats
 *   node scripts/query.mjs tree [章号如 4]
 *   node scripts/query.mjs kp <名称或ID>
 *   node scripts/query.mjs trace <名称> [深度]
 *   node scripts/query.mjs down <名称> [深度]
 *   node scripts/query.mjs roots <名称1,名称2,...> [深度]
 *   node scripts/query.mjs search <关键词>
 */

import * as G from '../src/graph.mjs';
import { closeDb } from '../src/kuzu.mjs';

const [, , cmd, ...args] = process.argv;

/** 允许用名称或 ID 指定知识点 */
async function resolve(ref) {
  if (!ref) return null;
  const byId = await G.getPoint(ref);
  if (byId) return byId;
  const hits = await G.search(ref, 8);
  if (!hits.length) return null;
  const exact = hits.find((h) => h.name === ref);
  return G.getPoint((exact ?? hits[0]).id);
}

const line = (c = '─', n = 64) => console.log(c.repeat(n));

switch (cmd) {
  case 'stats': {
    const s = await G.stats();
    line('═');
    console.log('电动力学知识图谱');
    line('═');
    console.log(`章        ${s.chapters}`);
    console.log(`节        ${s.sections}`);
    console.log(`知识点    ${s.points}`);
    console.log(`公式      ${s.formulas}`);
    console.log(`先修边    ${s.prereq}`);
    console.log(`相关边    ${s.relates}`);
    line();
    break;
  }

  case 'tree': {
    const tree = await G.chapterTree(args[0]);
    for (const c of tree) {
      console.log(`\n${c.no}  ${c.title}`);
      console.log(`    ${c.summary}`);
      for (const s of c.sections) {
        console.log(`  ${s.no} ${s.title}  (${s.points.length})`);
        for (const p of s.points) console.log(`      · ${p.name}  [${p.kind}/${p.difficulty}]`);
      }
    }
    console.log();
    break;
  }

  case 'kp': {
    const k = await resolve(args[0]);
    if (!k) { console.log('未找到该知识点'); break; }
    line('═');
    console.log(`${k.name}   [${k.id}]`);
    line('═');
    console.log(`位置    ${k.chapter?.no ?? ''} ${k.chapter?.title ?? ''} · ${k.section?.no ?? ''} ${k.section?.title ?? ''}`);
    console.log(`类型    ${k.kind} / ${k.difficulty}`);
    console.log(`教材    ${k.textbookRef}`);
    console.log(`\n定义\n  ${k.definition}`);
    if (k.keyPoints?.length) {
      console.log('\n要点');
      for (const p of k.keyPoints) console.log(`  · ${p}`);
    }
    if (k.formulas?.length) {
      console.log('\n公式');
      for (const f of k.formulas) console.log(`  ${f.name}：${f.latex}${f.note ? `  （${f.note}）` : ''}`);
    }
    const ups = await G.directPrerequisites(k.id);
    if (ups.length) {
      console.log('\n先修');
      for (const u of ups) console.log(`  ← ${u.name} [${u.strength}]  ${u.reason}`);
    }
    const downs = await G.directDependents(k.id);
    if (downs.length) {
      console.log('\n后续');
      for (const d of downs) console.log(`  → ${d.name}`);
    }
    const rels = await G.related(k.id);
    if (rels.length) {
      console.log('\n关联');
      for (const r of rels) console.log(`  ~ ${r.name}（${r.kind}）：${r.note}`);
    }
    console.log();
    break;
  }

  case 'trace': {
    const k = await resolve(args[0]);
    if (!k) { console.log('未找到该知识点'); break; }
    const depth = Number(args[1] ?? 3);
    const levels = await G.traceUpstream(k.id, depth);
    line('═');
    console.log(`「${k.name}」的先修链（向上 ${depth} 层）`);
    line('═');
    if (!levels.length) console.log('（无先修——这是基础节点）');
    for (let i = 0; i < levels.length; i++) {
      console.log(`\n第 ${i + 1} 层：`);
      for (const n of levels[i]) {
        console.log(`  ${n.name}  [${n.chapterId}]  ${n.strength === '强' ? '必会' : '有帮助'}`);
        console.log(`      因为：${n.reason}`);
      }
    }
    console.log();
    break;
  }

  case 'down': {
    const k = await resolve(args[0]);
    if (!k) { console.log('未找到该知识点'); break; }
    const depth = Number(args[1] ?? 3);
    const levels = await G.traceDownstream(k.id, depth);
    line('═');
    console.log(`「${k.name}」的后续（向下 ${depth} 层）`);
    line('═');
    for (let i = 0; i < levels.length; i++) {
      console.log(`\n第 ${i + 1} 层：`);
      for (const n of levels[i]) console.log(`  ${n.name}  （经 ${n.viaName}）`);
    }
    console.log();
    break;
  }

  case 'roots': {
    const refs = String(args[0] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!refs.length) { console.log('请给出若干个「没学懂」的知识点名称，逗号分隔'); break; }
    const depth = Number(args[1] ?? 3);
    const resolved = [];
    for (const r of refs) {
      const k = await resolve(r);
      if (k) resolved.push(k);
      else console.log(`（跳过，未找到：${r}）`);
    }
    if (!resolved.length) break;

    line('═');
    console.log('根因诊断');
    line('═');
    console.log(`症状（学生反映学不懂的）：${resolved.map((k) => k.name).join('、')}`);
    console.log(`回溯深度：${depth} 层\n`);

    const roots = await G.diagnoseRoots(resolved.map((k) => k.id), depth);
    if (!roots.length) { console.log('未找到共同先修——这些症状可能是彼此独立的。'); break; }

    console.log('按「支撑面」排序的候选根因：');
    console.log('（同时支撑越多症状越可能是病根；「硬前提」表示存在全程强依赖链，绕不开）\n');
    for (const r of roots.slice(0, 10)) {
      const tags = [];
      if (r.supportedCount > 1) tags.push('★ 共同根因');
      tags.push(r.isHardPrerequisite ? '硬前提' : '弱关联');
      if (r.isSymptomItself) tags.push('本身也是症状');
      console.log(`\n[${tags.join(' · ')}]  ${r.name}  [${r.chapterId}]  第 ${r.level} 层`);
      console.log(`         支撑了 ${r.supportedCount} / ${resolved.length} 个症状`);
      for (const reason of r.reasons) console.log(`         · ${reason}`);
    }
    console.log();
    break;
  }

  case 'search': {
    const hits = await G.search(args[0], 20);
    console.log(`命中 ${hits.length} 条：\n`);
    for (const h of hits) console.log(`  ${h.name}  [${h.id}]  ${h.chapterId}`);
    console.log();
    break;
  }

  default:
    console.log(`
电动力学图谱查询

  node scripts/query.mjs stats                    图谱统计
  node scripts/query.mjs tree [章号]               章节树 / 某章展开
  node scripts/query.mjs kp <名称>                 知识点详情
  node scripts/query.mjs trace <名称> [深度]       先修链回溯
  node scripts/query.mjs down <名称> [深度]        后续链
  node scripts/query.mjs roots <名称1,名称2> [深度] 根因诊断
  node scripts/query.mjs search <关键词>           搜索
`);
}

closeDb();
