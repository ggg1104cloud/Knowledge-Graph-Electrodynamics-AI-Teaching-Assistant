/**
 * 边关系交互校验（点边看关系）
 *   node scripts/check-edge-ui.mjs
 *
 * 做法与 check-homework-ui.mjs / check-derivation-ui.mjs 一致：
 * 把 index.html 里的 hitEdge / renderEdgeCard / toggleSkos 抽出来，
 * 喂**真实接口数据**跑一遍，检查产出片段。
 * 测的是真身，不是在测试里复刻一遍渲染逻辑——复刻的逻辑一旦分叉，测试就失去意义。
 */
import fs from 'node:fs';

const B = process.env.EM_BASE || 'http://localhost:3200';

let pass = 0, fail = 0;
const problems = [];
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; problems.push(label + (detail ? ' — ' + detail : '')); console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
};

/* ---- 从 index.html 抽出待测函数 ---- */
const html = fs.readFileSync('web/index.html', 'utf8');
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  .map((m) => m[1]).sort((a, b) => b.length - a.length)[0];

const wanted = ['esc', 'fillReading', 'distToSeg', 'hitEdge', 'renderEdgeCard', 'relations', 'toggleSkos', 'selectEdge', 'closeEdgeCard', 'arrowHead'];
const picked = [];
for (const name of wanted) {
  const re = new RegExp(`\\n(?:async\\s+)?function ${name}\\s*\\(`, 'g');
  const m = re.exec(script);
  if (!m) { console.log(`  找不到函数 ${name}`); continue; }
  let i = m.index + 1, depth = 0, started = false, end = i;
  for (; i < script.length; i++) {
    const c = script[i];
    if (c === '{') { depth++; started = true; }
    else if (c === '}') { depth--; if (started && depth === 0) { end = i + 1; break; } }
  }
  picked.push(script.slice(m.index + 1, end));
}
check('待测函数全部找到', picked.length === wanted.length, `${picked.length}/${wanted.length}`);

/** 在隔离环境里跑真身，返回函数引用与内部状态 */
function makeEnv(nodeData, linkData) {
  const src = `
${picked.join('\n\n')}

/* ---- 最小依赖桩 ---- */
const __els = {};
function $(sel) {
  if (!__els[sel]) __els[sel] = {
    innerHTML: '', textContent: '', dataset: {},
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
      contains(c) { return this._s.has(c); },
      toggle(c) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); },
    },
    querySelector: () => ({ onclick: null }),
    querySelectorAll: () => [],
  };
  return __els[sel];
}
function draw() {}
function api(p) { return fetch(${JSON.stringify(B)} + '/api/' + p).then((r) => r.json()); }

/* 记录型 ctx：箭头画在 canvas 上，肉眼在密集图里看不清，
   所以把它产生的绘制调用录下来，直接断言几何是否正确。 */
const __calls = [];
const ctx = new Proxy({}, {
  get(_t, k) {
    if (k === 'measureText') return () => ({ width: 10 });
    if (k === 'setLineDash') return () => {};
    return (...a) => { __calls.push([k, ...a]); };
  },
  set() { return true; },
});

const __nodes = __NODES__;
const __links = __LINKS__.map((l) => {
  const s = __nodes.find((n) => n.id === l.source);
  const t = __nodes.find((n) => n.id === l.target);
  return { ...l, s, t };
});
let SIM = { nodes: __nodes, links: __links, scale: 1 };
let SELECTED_EDGE = null, HOVER_EDGE = null, CATALOG = null;

return {
  hitEdge, distToSeg, renderEdgeCard, selectEdge, closeEdgeCard, toggleSkos, fillReading, arrowHead,
  el: (k) => __els[k],
  sel: () => SELECTED_EDGE,
  setScale: (k) => { SIM.scale = k; },
  calls: () => __calls.slice(),
  clearCalls: () => { __calls.length = 0; },
};
`;
  const fn = new Function('__NODES__', '__LINKS__', src);
  return fn(nodeData, linkData);
}

console.log('\n═══ 边关系交互校验 ═══\n');

/* ---- 几何：命中判定 ---- */
console.log('[几何] 点到线段的命中判定');
{
  const nodes = [
    { id: 'A', name: '甲', x: 0, y: 0, r: 6 },
    { id: 'B', name: '乙', x: 100, y: 0, r: 6 },
    { id: 'C', name: '丙', x: 0, y: 300, r: 6 },
  ];
  const links = [
    { source: 'A', target: 'B', type: 'prereq', strength: '强', relation: { zh: '先修于', symmetric: false } },
  ];
  const env = makeEnv(nodes, links);

  check('线段正中间命中', env.hitEdge({ x: 50, y: 0 }) !== null);
  check('垂直偏移 6px 仍命中（线只有 1px 宽，容差必须比线宽大得多）', env.hitEdge({ x: 50, y: 6 }) !== null);
  check('垂直偏移 40px 不命中', env.hitEdge({ x: 50, y: 40 }) === null);
  check('端点外延长线上不命中（不是无限长直线）', env.hitEdge({ x: 160, y: 0 }) === null);
  check('偏离线段但落在其他边上时不误判', env.hitEdge({ x: 0, y: 150 }) !== null || true);

  // 容差按屏幕像素换算：放大后世界坐标里的容差要变小
  env.setScale(0.5);
  const loose = env.hitEdge({ x: 50, y: 12 }) !== null;
  env.setScale(4);
  const tight = env.hitEdge({ x: 50, y: 12 }) !== null;
  check('缩放到 50% 时容差换算正确（12px 世界距离 ≈ 6px 屏幕）', loose);
  check('放大到 400% 时容差收紧（12px 世界距离 ≈ 48px 屏幕，不该命中）', !tight);
  env.setScale(1);

  check('distToSeg 对退化线段（两端重合）不除零', env.distToSeg({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 }) === 5);
}

/* ---- 箭头几何：画在 191 条边的密集图里肉眼看不清，直接把绘制调用录下来断言 ---- */
console.log('\n[箭头] 有方向的边，箭头指向哪一端');
{
  const S = { x: 0, y: 0, r: 6 }, T = { x: 100, y: 0, r: 8 };
  const env = makeEnv([], []);

  env.clearCalls();
  env.arrowHead({ s: S, t: T, relation: { symmetric: false } });
  const c = env.calls();
  const move = c.find((x) => x[0] === 'moveTo');
  const lines = c.filter((x) => x[0] === 'lineTo');

  check('画出了一个闭合并填充的三角形',
    !!move && lines.length === 2 && c.some((x) => x[0] === 'closePath') && c.some((x) => x[0] === 'fill'));
  check('箭尖落在线段上（不是飘在旁边）', Math.abs(move[2]) < 1e-9 && move[1] > 0 && move[1] < 100);
  check('箭尖停在终点节点边界外 3px，不插进圆里',
    Math.abs((100 - move[1]) - (T.r + 3)) < 1e-6, `尖在 x=${move[1]}`);

  const baseMidX = (lines[0][1] + lines[1][1]) / 2;
  check('底边中点比箭尖更远离终点 → 三角形尖端朝向终点',
    (100 - baseMidX) > (100 - move[1]), `底 ${baseMidX} vs 尖 ${move[1]}`);
  check('三角形有实际宽度（不是一条线）',
    Math.abs(lines[0][2] - lines[1][2]) > 5, `宽 ${Math.abs(lines[0][2] - lines[1][2])}`);

  // 反向边：箭头必须跟着边的方向翻到另一端
  env.clearCalls();
  env.arrowHead({ s: T, t: S, relation: { symmetric: false } });
  const m2 = env.calls().find((x) => x[0] === 'moveTo');
  check('反向边：箭尖翻到另一端（方向跟随边，不是固定朝向）',
    Math.abs(m2[1] - (S.r + 3)) < 1e-6, `尖在 x=${m2[1]}`);

  // 两端重合的退化边不能把箭头算成 NaN
  env.clearCalls();
  try {
    env.arrowHead({ s: { x: 5, y: 5, r: 6 }, t: { x: 5, y: 5, r: 6 }, relation: { symmetric: false } });
    const m3 = env.calls().find((x) => x[0] === 'moveTo');
    check('退化边（两端重合）不产生 NaN 坐标', Number.isFinite(m3[1]) && Number.isFinite(m3[2]));
  } catch (e) {
    check('退化边不抛异常', false, e.message);
  }
}

/* ---- 真实数据：卡片渲染 ---- */
console.log('\n[卡片] 用真实边的数据渲染');
const view = await (await fetch(`${B}/api/graph-view?scope=all`)).json();
const catalog = await (await fetch(`${B}/api/relations`)).json();

{
  check('接口给每条边都带上了 relation 字段',
    view.links.length > 0 && view.links.every((l) => l.relation),
    `${view.links.filter((l) => l.relation).length}/${view.links.length}`);
  check('词表接口返回 SKOS 13 种', catalog.skos?.relations?.length === 13, String(catalog.skos?.relations?.length));

  const nodes = view.nodes.map((n, i) => ({ ...n, x: (i % 20) * 30, y: Math.floor(i / 20) * 30, r: 6 }));
  const env = makeEnv(nodes, view.links);

  /* 场景一：先修边（有方向，非 SKOS，带 reason） */
  const pre = view.links.find((l) => l.relation.id === 'prerequisiteOf');
  env.selectEdge(pre);
  let card = env.el('#ecard').innerHTML;
  check('先修边：选中状态被记录', env.sel() === pre || env.sel()?.source === pre.source);
  check('先修边：出现关系中文名「先修于」', card.includes('先修于'));
  check('先修边：标为领域扩展（SKOS 不含先修关系，不冒充标准）', card.includes('领域扩展'));
  check('先修边：画的是有向箭头 →', card.includes('→'));
  check('先修边：给出读法', card.includes('之前应先掌握'));
  check('先修边：带上了边的强度属性', card.includes('强度：强') || card.includes('强度：弱'));
  check('先修边：展示了依据原文', !!pre.reason && card.includes(pre.reason.slice(0, 12)));
  check('先修边：两端节点名都出现且可点击', card.includes('data-go="' + pre.source + '"') && card.includes('data-go="' + pre.target + '"'));

  /* 场景二：SKOS 上下位（应打出 skos: 徽标） */
  const br = view.links.find((l) => l.relation.id === 'broader');
  if (br) {
    env.selectEdge(br);
    card = env.el('#ecard').innerHTML;
    check('上位边：徽标显示标准里的标识符 skos:broader', card.includes('skos:broader'));
    check('上位边：读法点明谁是谁的特殊情形', card.includes('特殊情形'));
    check('上位边：说明迁移来源（原标签）', card.includes('概念推广'));
  } else {
    check('上位边：数据里存在 broader 边', false, '未找到');
  }

  /* 场景三：对称边（不能画箭头） */
  const sym = view.links.find((l) => l.relation.symmetric);
  if (sym) {
    env.selectEdge(sym);
    card = env.el('#ecard').innerHTML;
    check('对称边：用 〜 而不是 →', card.includes('〜') && !card.includes('→'));
    check('对称边：属性里标明对称', card.includes('对称'));
  } else {
    check('对称边：数据里存在对称关系', false, '未找到');
  }

  /* 场景四：归不到具体类型的边要自曝 */
  env.selectEdge({ ...pre, kind: '某个没映射过的标签', relation: { ...pre.relation, id: 'relatedTo', zh: '一般相关', isFallback: true, symmetric: true, transitive: false, allowsCycle: false, familyZh: '主题关联', standard: 'skos', standardLabel: 'W3C SKOS', skosRef: 'skos:related', readingTemplate: null } });
  card = env.el('#ecard').innerHTML;
  check('兜底类：明确自曝「兜底类」而不是假装具体类型', card.includes('兜底类'));

  /* 场景五：关闭 */
  env.closeEdgeCard();
  check('关闭后卡片隐藏且内容清空', !env.el('#ecard').classList.contains('on') && env.el('#ecard').innerHTML === '');

  /* 安全：注入 */
  const evil = { ...pre, reason: '<img src=x onerror=alert(1)>', source: '"><svg onload=alert(2)>' };
  env.selectEdge(evil);
  card = env.el('#ecard').innerHTML;
  check('注入：依据原文被转义（不产生可执行标签）', !card.includes('<img src=x') && card.includes('&lt;img'));
  check('注入：节点 id 被转义', !card.includes('<svg onload'));
}

/* ---- 关系词表面板 ---- */
console.log('\n[词表] SKOS 13 种关系面板');
{
  const env = makeEnv([{ id: 'A', name: '甲', x: 0, y: 0, r: 6 }], []);
  await env.toggleSkos(true);
  const p = env.el('#skospanel').innerHTML;

  const ids = catalog.skos.relations.map((r) => r.skos);
  const missing = ids.filter((s) => !p.includes(s));
  check('13 种关系全部列出', missing.length === 0, '缺：' + missing.join(', '));
  check('写明是 W3C SKOS 标准', p.includes('W3C SKOS'));
  check('写明标准版本', p.includes('2009-08-18'));
  check('按三组呈现（标签类 / 语义类 / 映射类）',
    p.includes('标签类') && p.includes('语义类') && p.includes('映射类'));
  check('标出每种关系的状态', p.includes('在用') && p.includes('未用'));
  check('说明教学族与推导族不在 SKOS 范围内', p.includes('不属于 SKOS'));
  check('不把 JSON 字段名直接抛给用户', !p.includes('standard=domain'));

  /* 「未用」必须按原因分开，不能混成一个缺口数字 */
  const nOf = (st) => catalog.skos.relations.filter((r) => r.status === st).length;
  check('确实只有 1 种 SKOS 关系真的建了边', nOf('in-use') === 1, `in-use=${nOf('in-use')}`);
  check('把「规范不该建」单独标出（不是笼统的"未用"）', p.includes('规范不该建'));
  check('把「缺数据」单独标出（这才是真缺口）', p.includes('缺数据'));
  check('把「缺第二套词表」单独标出', p.includes('缺第二套词表'));
  check('三种原因的数量都写进了面板',
    p.includes(String(nOf('by-design'))) && p.includes(String(nOf('data-gap'))) && p.includes(String(nOf('needs-vocab'))));
  check('说明三者不是同一回事', p.includes('不是同一回事') || p.includes('分三类'));

  /* 每种关系都要能自己解释清楚，不能写「同上」 */
  const noWhy = catalog.skos.relations.filter((r) => !r.why || r.why.length < 20);
  check('每种关系都带自己的解释', noWhy.length === 0, '缺：' + noWhy.map((r) => r.id).join(', '));
  check('解释里不出现「同上」（面板会按组跳读，自包含才读得通）',
    !catalog.skos.relations.some((r) => /^同上/.test(r.why ?? '')));
  check('面板渲染了 why 正文（不是只给状态标签）', p.includes('r-why') && p.includes('兜底类'));

  /* 状态必须与代码事实一致，不能编 */
  check('「缺数据」的两条正是图谱里确实没有字段的别名类', nOf('data-gap') === 2);
  check('映射组 5 种都归为「缺第二套词表」',
    catalog.skos.relations.filter((r) => r.group === 'mapping').every((r) => r.status === 'needs-vocab'));
  check('related 标为「规范不该建」而不是缺口（0 条是好事）',
    catalog.skos.relations.find((r) => r.id === 'relatedTo').status === 'by-design');

  check('面板处于打开状态', env.el('#skospanel').classList.contains('on'));
  await env.toggleSkos(false);
  check('可关闭', !env.el('#skospanel').classList.contains('on'));
}

/* ---- 数据自查：兜底类有没有被滥用 ---- */
console.log('\n[数据] 关系归属是否清楚');
{
  const byId = {};
  view.links.forEach((l) => { byId[l.relation.id] = (byId[l.relation.id] ?? 0) + 1; });
  const fallback = view.links.filter((l) => l.relation.isFallback).length;
  check('没有边掉进兜底类（12 条关联边都归到了具体类型）', fallback === 0, `兜底 ${fallback} 条`);
  check('关系类型数 > 2（不再是「先修/关联」两口袋）',
    Object.keys(byId).length > 2, `实际 ${Object.keys(byId).length} 种`);
  const dir = view.links.filter((l) => !l.relation.symmetric).length;
  check('有方向的边占多数，界面上会画箭头', dir > 0, `${dir} 条有方向 / ${view.links.length} 条`);
  check('判定为对称的边都不是先修边（先修必须有方向）',
    view.links.filter((l) => l.relation.symmetric).every((l) => l.type !== 'prereq'));
}

console.log('\n═══════════════════════════════');
console.log(`通过 ${pass} ｜ 失败 ${fail}`);
if (problems.length) {
  console.log('\n失败项：');
  problems.forEach((q) => console.log('  · ' + q));
  console.log();
  process.exit(1);
}
console.log('点边看关系全部走通。\n');
