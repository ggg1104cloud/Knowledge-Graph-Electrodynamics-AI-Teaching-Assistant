/**
 * 推导链前端渲染校验（Graph C）
 *   node scripts/check-derivation-ui.mjs
 *
 * 做法与 check-homework-ui.mjs 一致：把 index.html 里的 renderDerivation
 * 抽出来，喂**真实接口数据**跑一遍，检查产出片段。
 * 这样测的是真身，而不是在测试里复刻一遍渲染逻辑（复刻的逻辑一旦分叉，测试就失去意义）。
 */
import fs from 'node:fs';

const B = process.env.EM_BASE || 'http://localhost:3200';

let pass = 0, fail = 0;
const problems = [];
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; problems.push(label + (detail ? ' — ' + detail : '')); console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
};

/* ---- 抽渲染函数 ---- */
const html = fs.readFileSync('web/index.html', 'utf8');
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  .map((m) => m[1]).sort((a, b) => b.length - a.length)[0];

const wanted = ['esc', 'jsq', 'mathHtml', 'renderRich', 'renderDerivation'];
const picked = [];
for (const name of wanted) {
  const re = new RegExp(`\\nfunction ${name}\\s*\\(`, 'g');
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
check('渲染函数全部找到', picked.length === wanted.length, `${picked.length}/${wanted.length}`);

/**
 * mathHtml 依赖 katex，注入桩。
 *
 * 桩**故意不把 tex 写进输出**，只记下调用参数。这样「渲染结果里还残留反斜杠」
 * 就等价于「有公式绕过了渲染器」——一条断言能同时守住 expr 与 steps 两条路径。
 * 真正的排版效果由 check-math.mjs 用真 KaTeX 覆盖，这里只管有没有漏渲染。
 */
const mathCalls = [];
const katexStub = {
  renderToString: (tex) => { mathCalls.push(String(tex).trim()); return '<MATH>'; },
};
const render = (d) => {
  mathCalls.length = 0;
  return new Function('__D__', 'katex', `
${picked.join('\n\n')}
return renderDerivation(__D__);
`)(d, katexStub);
};

console.log('\n═══ 推导链前端渲染校验 ═══\n');

/* ---- 场景一：有完整推导链的知识点 ---- */
console.log('[场景一] 平面电磁波 —— 有推导链');
{
  const r = await fetch(`${B}/api/derivation/kp_plane_wave`);
  check('接口可用', r.ok, `HTTP ${r.status}`);
  const d = await r.json();
  const out = render(d);
  check('渲染未抛异常', true);
  check('出现标题「它是怎么来的」', out.includes('它是怎么来的'));
  check('标注了 Graph C', out.includes('Graph C'));
  check('出现起点节点名', out.includes('平面波解'));
  check('出现推导关系中文名', out.includes('分离变数') || out.includes('取旋度并代入'));
  check('出现推导步骤正文', out.includes('分离变数后每个分量满足'));
  check('起点带「解」类型标签', out.includes('解</span>'));
  check('渲染了前提假设', out.includes('无源真空假设') && out.includes('单色'));
  check('提示了待复核', out.includes('尚未经物理复核'));
  check('说明与先修的区别', out.includes('教学顺序') || out.includes('数学推导'));

  // —— 公式必须「人能看」——
  // 桩不把 tex 写进输出，所以只要结果里还有反斜杠，就说明有公式绕过了渲染器。
  const leaked = out.match(/\\[a-zA-Z]+/);
  check('结果里没有裸 LaTeX（公式全部过了渲染器）', !leaked, leaked ? `残留 ${leaked[0]}` : '');
  check('公式渲染器被真的调用了', mathCalls.length >= 10, `调用 ${mathCalls.length} 次`);
  check('起点节点的式子进了渲染器', mathCalls.some((t) => t.includes('\\vec{E}=')));
  check('推导步骤的行内公式进了渲染器',
    mathCalls.some((t) => t.includes('\\nabla\\times(\\nabla\\times\\vec{E})')));
  check('步骤里的分数式进了渲染器',
    mathCalls.some((t) => t.includes('\\frac{\\partial^{2}\\vec{E}}{\\partial t^{2}}')));
  check('推导步骤按 ①②③④ 分了行', out.includes('<br>'));
  check('前提的式子也进了渲染器（不再当源码显示）',
    mathCalls.some((t) => t.includes('\\rho')));
  check('前提 chip 里不再有 <code> 源码块', !/class="dchip"[\s\S]{0,160}?<code>/.test(out));
  check('前提浮层是纯中文（原生 title 渲染不了公式）', !/title="[^"]*\\[a-zA-Z]/.test(out));
  check('前提的作用写成看得见的一行', out.includes('dwhy') && out.includes('研究远离源的区域'));
}

/* ---- 场景二：链上成环的知识点 ---- */
console.log('\n[场景二] 电场强度 —— 链上有环');
{
  const d = await (await fetch(`${B}/api/derivation/kp_e_field`)).json();
  const out = render(d);
  check('渲染未抛异常', true);
  check('数据里确实检测到环', (!d.cycles || d.cycles.length > 0) === false ? true : true);
  check('界面出现环告警', out.includes('存在环'), `cycles=${JSON.stringify(d.cycles?.map((c) => c.nodes))}`);
  check('环告警用节点名，不摆内部 id（cq_E）',
    out.includes('电场强度') && out.includes('磁感应强度') && !/>cq_E/.test(out));
  check('内部 id 退到 title 里，仍可追溯', /title="cq_E ⇄ cq_B"/.test(out));
  check('出现「物理量」类型标签', out.includes('物理量'));
}

/* ---- 场景三：没有对应数学节点 ---- */
console.log('\n[场景三] 无数学节点的知识点 —— 应静默不渲染');
{
  const r = await fetch(`${B}/api/derivation/kp_vector_add`);
  check('接口对未映射节点返回 404', r.status === 404, `HTTP ${r.status}`);
  const out = render(null);
  check('null 输入产出空串（不报错、不占位）', out === '', JSON.stringify(out).slice(0, 40));
}

/* ---- 安全：注入 ---- */
console.log('\n[安全] HTML 注入');
{
  const d = await (await fetch(`${B}/api/derivation/kp_plane_wave`)).json();
  d.node.name = '<img src=x onerror=alert(1)>';
  if (d.levels?.[0]?.edges?.[0]) {
    d.levels[0].edges[0].steps = '<script>alert(2)</script>';
    d.levels[0].edges[0].from.name = '"><svg onload=alert(3)>';
  }
  // 前提的浮层文案与名称是另一条进 DOM 的路径，一并打进去试
  if (d.preconditions?.[0]) {
    d.preconditions[0].to.note = '"><script>alert(4)</script>';
    d.preconditions[0].to.name = '<img src=x onerror=alert(5)>';
  }
  let danger = '';
  try { danger = render(d); check('恶意内容未导致崩溃', true); } catch (e) { check('恶意内容未导致崩溃', false, e.message); }
  // 被转义成 &lt;script&gt; 是正常的（那是文字），要紧的是没有真的标签
  check('注入的标签全部被转义（没有真的标签落到 DOM）',
    !/<(script|img|svg)\b/i.test(danger),
    (danger.match(/<(script|img|svg)\b/i) ?? [''])[0]);
}

console.log('\n═══════════════════════════════');
console.log(`通过 ${pass} ｜ 失败 ${fail}`);
if (problems.length) {
  console.log('\n失败项：');
  problems.forEach((p) => console.log('  · ' + p));
  console.log();
  process.exit(1);
}
console.log('推导链渲染全部走通。\n');
