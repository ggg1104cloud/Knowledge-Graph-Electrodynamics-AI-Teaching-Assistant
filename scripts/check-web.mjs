/**
 * 前端接口契约校验
 * ------------------------------------------------------------------
 * 逐个检查 web/index.html 真正读取的字段是否存在、类型是否正确。
 * 这能抓住绝大多数前后端集成 bug（字段名拼错、结构层级不对、空数组当有数据处理）。
 */

const B = process.env.EM_BASE || 'http://localhost:3200';

let pass = 0, fail = 0;
const problems = [];

function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; problems.push(`${label}${detail ? ' — ' + detail : ''}`); console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
}

const get = async (p) => {
  const r = await fetch(`${B}${p}`);
  if (!r.ok) throw new Error(`${p} → HTTP ${r.status}`);
  return r.json();
};

console.log('\n═══ 前端接口契约校验 ═══');

/* ---- health ---- */
console.log('\n[health] 顶栏统计与模型名');
{
  const h = await get('/api/health');
  check('h.graph.points 是数字', typeof h.graph?.points === 'number');
  check('h.graph.prereq 是数字', typeof h.graph?.prereq === 'number');
  check('h.llm.model 存在', typeof h.llm?.model === 'string' && h.llm.model.length > 0, `得到 ${h.llm?.model}`);
  check('h.llm.configured 为真', h.llm?.configured === true);
}

/* ---- tree ---- */
console.log('\n[tree] 左侧章节树');
{
  const t = await get('/api/tree');
  const c = t.tree?.[0];
  check('tree 是数组且非空', Array.isArray(t.tree) && t.tree.length > 0);
  check('章有 id/no/title', !!(c?.id && c?.no && c?.title));
  check('章有 sections 数组', Array.isArray(c?.sections));
  const s = c?.sections?.[0];
  check('节有 id/no/title', !!(s?.id && s?.no && s?.title));
  check('节有 points 数组', Array.isArray(s?.points));
  check('知识点有 id/name', !!(s?.points?.[0]?.id && s?.points?.[0]?.name));
}

/* ---- graph-view ---- */
console.log('\n[graph-view] 中间画布');
{
  const g = await get('/api/graph-view?scope=all');
  check('nodes 非空', Array.isArray(g.nodes) && g.nodes.length > 0, `${g.nodes?.length} 个`);
  check('links 非空', Array.isArray(g.links) && g.links.length > 0, `${g.links?.length} 条`);
  const n = g.nodes[0];
  check('节点有 id/name/chapterId', !!(n?.id && n?.name && n?.chapterId));
  const l = g.links[0];
  check('边有 source/target/type', !!(l?.source && l?.target && l?.type));
  check('边 type 取值合法', ['prereq', 'relates'].includes(l?.type));
  // 边上端点必须都能在 nodes 里找到（否则前端画不出线）
  const ids = new Set(g.nodes.map((x) => x.id));
  const dangling = g.links.filter((x) => !ids.has(x.source) || !ids.has(x.target));
  check('所有边的端点都在节点集内', dangling.length === 0, `${dangling.length} 条悬空边`);
}

/* ---- focus 邻域 ---- */
console.log('\n[graph-view focus] 点击节点后的邻域');
{
  const g = await get('/api/graph-view?scope=focus:kp_image_method&depth=2');
  check('center 正确', g.center === 'kp_image_method');
  check('nodes 非空', Array.isArray(g.nodes) && g.nodes.length > 1, `${g.nodes?.length} 个`);
  check('中心节点在 nodes 内', g.nodes.some((n) => n.id === 'kp_image_method'));
  const ids = new Set(g.nodes.map((x) => x.id));
  const dangling = g.links.filter((x) => !ids.has(x.source) || !ids.has(x.target));
  check('邻域内所有边端点都在节点集内', dangling.length === 0, `${dangling.length} 条悬空边`);
}

/* ---- point ---- */
console.log('\n[point] 右侧知识点详情');
{
  const d = await get('/api/point/kp_image_method');
  const p = d.point;
  check('point.definition 存在', typeof p?.definition === 'string' && p.definition.length > 0);
  check('point.chapter{no,title}', !!(p?.chapter?.no && p?.chapter?.title));
  check('point.section{no,title}', !!(p?.section?.no && p?.section?.title));
  check('point.keyPoints 是数组', Array.isArray(p?.keyPoints), `得到 ${typeof p?.keyPoints}`);
  check('point.formulas 是数组', Array.isArray(p?.formulas));
  check('prerequisites 字段存在', Array.isArray(d.prerequisites));
  check('dependents 字段存在', Array.isArray(d.dependents));
  check('related 字段存在', Array.isArray(d.related));
  if (p.formulas?.length) {
    check('formula 有 name/latex', !!(p.formulas[0].name && p.formulas[0].latex));
    check('latex 未被转义破坏', !p.formulas[0].latex.includes('\\\\frac'), `得到 ${p.formulas[0].latex.slice(0, 60)}`);
  }
  if (d.prerequisites?.length) {
    const u = d.prerequisites[0];
    check('先修边有 id/name/strength/reason', !!(u.id && u.name && u.strength && u.reason));
  }
}

/* ---- trace ---- */
console.log('\n[trace] 先修链回溯');
{
  const d = await get('/api/trace?id=kp_plane_wave&depth=3');
  check('levels 是二维数组', Array.isArray(d.levels) && Array.isArray(d.levels[0]));
  check('levels 非空', d.levels.length > 0);
  const n = d.levels[0][0];
  check('节点有 id/name/weakest/reason', !!(n?.id && n?.name && n?.weakest && n?.reason));
  check('weakest 取值合法', ['强', '弱'].includes(n?.weakest), `得到 ${n?.weakest}`);
}

/* ---- roots ---- */
console.log('\n[roots] 根因诊断');
{
  const d = await get('/api/roots?ids=kp_electric_dipole_radiation,kp_magnetic_dipole_radiation&depth=3');
  check('symptoms 数组', Array.isArray(d.symptoms) && d.symptoms.length === 2);
  check('roots 非空', Array.isArray(d.roots) && d.roots.length > 0, `${d.roots?.length} 条`);
  const r = d.roots[0];
  check('root 有 id/name/chapterId/level', !!(r?.id && r?.name && r?.chapterId && typeof r.level === 'number'));
  check('root.supportedCount 是数字', typeof r?.supportedCount === 'number');
  check('root.isHardPrerequisite 是布尔', typeof r?.isHardPrerequisite === 'boolean');
  check('root.reasons 是数组', Array.isArray(r?.reasons));
}

/* ---- ask (SSE 事件契约) ---- */
console.log('\n[ask] 答疑 SSE 事件流');
{
  const seen = new Set();
  let raw = '', summary = null, segments = null, focus = null, err = null, model = null;
  const res = await fetch(`${B}/api/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: '什么是旋度？' }),
  });
  const rd = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await rd.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const part = buf.slice(0, i).trim(); buf = buf.slice(i + 2);
      if (!part.startsWith('data:')) continue;
      let ev; try { ev = JSON.parse(part.slice(5).trim()); } catch { continue; }
      seen.add(ev.type);
      if (ev.type === 'init') { focus = ev.focus; model = ev.model; }
      if (ev.type === 'text') raw += ev.content;
      if (ev.type === 'segments') { segments = ev.segments; summary = ev.summary; }
      if (ev.type === 'error') err = ev.message;
    }
  }

  check('收到 init 事件', seen.has('init'));
  check('init.focus 是数组', Array.isArray(focus), `得到 ${typeof focus}`);
  check('init.model 是 GLM', typeof model === 'string' && model.includes('glm'), `得到 ${model}`);
  check('收到 text 事件且正文非空', raw.length > 0, `${raw.length} 字`);
  check('无 error 事件', !err, err ?? '');
  check('收到 segments 事件', !!segments);
  check('summary 字段齐全', !!(summary && typeof summary.coverage === 'number' && typeof summary.total === 'number'));
  check('segments 每项有 text/source/citations',
    Array.isArray(segments) && segments.every((s) => typeof s.text === 'string' && s.source && Array.isArray(s.citations)));
  check('source 取值合法',
    segments?.every((s) => ['graph', 'textbook', 'web', 'inferred'].includes(s.source)));
  check('无无效引用（模型未编造节点 ID）', (summary?.invalid ?? 0) === 0, `无效 ${summary?.invalid} 个`);
  check('依据覆盖率 > 30%', (summary?.coverage ?? 0) > 30, `${summary?.coverage}%`);
  check('引用的节点 ID 均真实存在', (summary?.nodeIds ?? []).length > 0, `${summary?.nodeIds?.length} 个`);

  console.log(`\n  正文预览：${raw.slice(0, 120).replace(/\n/g, ' ')}…`);
  console.log(`  覆盖率 ${summary?.coverage}% · ${summary?.total} 句 · 引用 ${summary?.nodeIds?.length} 个节点`);
}

/* ---- 汇总 ---- */
console.log('\n═══════════════════════════════');
console.log(`通过 ${pass} ｜ 失败 ${fail}`);
if (problems.length) {
  console.log('\n失败项：');
  for (const p of problems) console.log('  · ' + p);
  console.log();
  process.exit(1);
}
console.log('前端接口契约全部匹配。\n');
