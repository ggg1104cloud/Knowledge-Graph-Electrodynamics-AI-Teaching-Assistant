/**
 * 图谱入库
 * ------------------------------------------------------------------
 * 把 data/*.json 的源数据导入 Kuzu。
 * 全程使用「参数化写入」——公式里的 LaTeX 含大量反斜杠，若拼字符串进 Cypher
 * 会被当作转义符而损坏，参数化可保证原样往返（已实测）。
 *
 * 库文件位置见 src/config.mjs：必须在纯 ASCII 路径下。
 */

import fs from 'node:fs';
import { FILES, DB_PATH, SUBJECT } from '../src/config.mjs';
import { getDb, resetSchema, rows, scalar, closeDb } from '../src/kuzu.mjs';

function say(msg = '') { console.log(msg); }

const t0 = Date.now();

/* ---------- 读取源数据 ---------- */
const chaptersDoc = JSON.parse(fs.readFileSync(FILES.chapters, 'utf8'));
const points = JSON.parse(fs.readFileSync(FILES.points, 'utf8'));
const prereqDoc = JSON.parse(fs.readFileSync(FILES.prereq, 'utf8'));

say(`\n源数据：${chaptersDoc.chapters.length} 章 ｜ ${points.length} 知识点 ｜ ` +
    `${prereqDoc.prerequisites.length} 先修边 ｜ ${prereqDoc.relates.length} 相关边`);

/* ---------- 重建 schema（先 DROP 再 CREATE，脚本可反复执行） ---------- */
say(`库文件：${DB_PATH}`);
const { conn } = getDb();
await resetSchema(conn);

/* ---------- 写入辅助 ---------- */
async function prep(cypher) { return conn.prepare(cypher); }
async function exec(stmt, params) { return conn.execute(stmt, params); }

/* ---------- 1. Chapter / Section ---------- */
const stmtChapter = await prep(
  'CREATE (:Chapter {id: $id, no: $no, title: $title, summary: $summary})'
);
const stmtSection = await prep(
  'CREATE (:Section {id: $id, chapterId: $chapterId, no: $no, title: $title, summary: $summary})'
);
const stmtHasSection = await prep(
  'MATCH (c:Chapter {id: $cid}), (s:Section {id: $sid}) CREATE (c)-[:HAS_SECTION]->(s)'
);

let nChapter = 0, nSection = 0;
for (const c of chaptersDoc.chapters) {
  await exec(stmtChapter, { id: c.id, no: c.no, title: c.title, summary: c.summary ?? '' });
  nChapter++;
  for (const s of c.sections) {
    await exec(stmtSection, {
      id: s.id, chapterId: c.id, no: s.no, title: s.title, summary: s.summary ?? '',
    });
    await exec(stmtHasSection, { cid: c.id, sid: s.id });
    nSection++;
  }
}
say(`✓ 章 ${nChapter} ｜ 节 ${nSection}`);

/* ---------- 2. KnowledgePoint ---------- */
const stmtKp = await prep(
  `CREATE (:KnowledgePoint {
     id: $id, name: $name, sectionId: $sectionId, chapterId: $chapterId,
     kind: $kind, definition: $definition, keyPoints: $keyPoints,
     textbookRef: $textbookRef, difficulty: $difficulty
   })`
);
const stmtHasPoint = await prep(
  'MATCH (s:Section {id: $sid}), (k:KnowledgePoint {id: $kid}) CREATE (s)-[:HAS_POINT]->(k)'
);

const sectionToChapter = new Map();
for (const c of chaptersDoc.chapters) for (const s of c.sections) sectionToChapter.set(s.id, c.id);

for (const k of points) {
  await exec(stmtKp, {
    id: k.id,
    name: k.name,
    sectionId: k.sectionId,
    chapterId: sectionToChapter.get(k.sectionId) ?? '',
    kind: k.kind ?? 'concept',
    definition: k.definition ?? '',
    keyPoints: JSON.stringify(k.keyPoints ?? []),
    textbookRef: k.textbookRef ?? '',
    difficulty: k.difficulty ?? '',
  });
  await exec(stmtHasPoint, { sid: k.sectionId, kid: k.id });
}
say(`✓ 知识点 ${points.length}`);

/* ---------- 3. Formula ---------- */
const stmtFormula = await prep(
  'CREATE (:Formula {id: $id, name: $name, latex: $latex, kpId: $kpId, note: $note})'
);
const stmtHasFormula = await prep(
  'MATCH (k:KnowledgePoint {id: $kid}), (f:Formula {id: $fid}) CREATE (k)-[:HAS_FORMULA]->(f)'
);

let nFormula = 0;
for (const k of points) {
  const list = k.formulas ?? [];
  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    const fid = `f_${k.id}_${i}`;
    await exec(stmtFormula, {
      id: fid, name: f.name ?? '', latex: f.latex ?? '', kpId: k.id, note: f.note ?? '',
    });
    await exec(stmtHasFormula, { kid: k.id, fid });
    nFormula++;
  }
}
say(`✓ 公式 ${nFormula}`);

/* ---------- 4. PREREQUISITE_OF ---------- */
const stmtPre = await prep(
  `MATCH (a:KnowledgePoint {id: $from}), (b:KnowledgePoint {id: $to})
   CREATE (a)-[:PREREQUISITE_OF {strength: $strength, reason: $reason}]->(b)`
);
let nPre = 0;
for (const e of prereqDoc.prerequisites) {
  await exec(stmtPre, { from: e.from, to: e.to, strength: e.strength ?? '强', reason: e.reason ?? '' });
  nPre++;
}
say(`✓ 先修边 ${nPre}`);

/* ---------- 5. RELATES_TO ---------- */
const stmtRel = await prep(
  `MATCH (a:KnowledgePoint {id: $from}), (b:KnowledgePoint {id: $to})
   CREATE (a)-[:RELATES_TO {kind: $kind, note: $note}]->(b)`
);
let nRel = 0;
for (const e of prereqDoc.relates) {
  await exec(stmtRel, { from: e.from, to: e.to, kind: e.kind ?? '', note: e.note ?? '' });
  nRel++;
}
say(`✓ 相关边 ${nRel}`);

/* ---------- 校验 ---------- */
say('\n────────── 入库结果 ──────────');
const counts = await rows(conn, `
  MATCH (c:Chapter) WITH count(c) AS chapters
  MATCH (s:Section) WITH chapters, count(s) AS sections
  MATCH (k:KnowledgePoint) WITH chapters, sections, count(k) AS points
  MATCH (f:Formula) WITH chapters, sections, points, count(f) AS formulas
  MATCH ()-[p:PREREQUISITE_OF]->() WITH chapters, sections, points, formulas, count(p) AS prereq
  MATCH ()-[r:RELATES_TO]->() WITH chapters, sections, points, formulas, prereq, count(r) AS relates
  MATCH ()-[hs:HAS_SECTION]->() WITH chapters, sections, points, formulas, prereq, relates, count(hs) AS hasSection
  MATCH ()-[hp:HAS_POINT]->() WITH chapters, sections, points, formulas, prereq, relates, hasSection, count(hp) AS hasPoint
  MATCH ()-[hf:HAS_FORMULA]->()
  RETURN chapters, sections, points, formulas, prereq, relates, hasSection, hasPoint, count(hf) AS hasFormula
`);
say(JSON.stringify(counts[0], null, 1));

/* ---------- DAG 无环验证（在数据库里复核一遍） ---------- */
const cycles = await scalar(
  conn,
  'MATCH (k:KnowledgePoint)-[:PREREQUISITE_OF*1..20]->(k) RETURN count(k) AS n'
);
say(`\n环路数（应为 0）：${cycles}`);

/* ---------- 先修链冒烟查询 ---------- */
const demo = await rows(conn, `
  MATCH (target:KnowledgePoint {name: '平面电磁波'})<-[:PREREQUISITE_OF*1..2]-(up:KnowledgePoint)
  RETURN DISTINCT up.name AS 上游, up.chapterId AS 章
  ORDER BY 章
`);
say(`\n「平面电磁波」两层先修共 ${demo.length} 个：`);
for (const d of demo) say(`  · ${d.上游}`);

say(`\n✓ 入库完成，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
say(`  学科：${SUBJECT.name}（${SUBJECT.textbook}）\n`);

/* ---------- 退出 ----------
 * 不用 closeDb()：在本机 Windows 上，写完数据后关闭连接会让 Kuzu 原生层
 * 在本进程退出时触发段错误（退出码 3221225477 / 139），
 * 而 start.mjs 是看退出码判断成败的，于是「入库其实成功了，启动却报错」。
 * 此时数据已全部提交，直接丢弃句柄由进程退出时回收即可。
 * 停止常驻服务仍走 /api/shutdown → closeDb()，那条路径是正常的。 */
process.exit(0);
