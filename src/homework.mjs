/**
 * 作业解析与引导式批改（单题模式）
 * ==================================================================
 * 流程：题目照片 → GLM 视觉识别（题干 + LaTeX）→ 图谱标记 → 诊断 → 根因 → 引导
 *
 * ── 这个文件里最重要的东西是「不做什么」 ──
 *
 * 1. **一次只处理一道题**。学生必须每次只上传一道题的照片。
 *    识别阶段会检查图中是否只有一道题，多了就提示重拍——不做自动切分。
 *    理由：多题照片一旦识别错位，后面所有判断都会连锁污染，且无法让用户感知。
 *
 * 2. **模型不做题面检验**。识别只负责"看"，不负责"judge"：
 *    不判断题目本身是否合理、不修正明显的错别字、不替学生补全残缺的公式。
 *    看到什么就转写什么——识别环节一旦开始"自作聪明"，下游的诊断就失去基准。
 *    （注意：这与"诊断"环节并不矛盾——诊断是明确标注的另一件事，
 *      且只对可靠的片段做，见 diagnoseProblem。）
 *
 * 3. **不给完整解答**（硬边界）。
 *    引导、追问、指方向、给一个小问题 → 可以。
 *    把答案写完、把关键公式直接给出来 → 不行。
 *
 * 4. **识别不可靠的地方不硬评**。
 *    视觉模型比 MinerU 稳得多（实测 electromagnetic / \omega / \nabla\times E 都能对），
 *    但仍会看错下标、漏字。所以保留 uncertain 传递与"无法判定"出口——
 *    宁可说"这里没认出来，请重拍"，也不猜着批改。
 */

import * as G from './graph.mjs';
import { chat, streamChat } from './llm.mjs';

/* ==================== 第 1 步：题目照片 → 结构化题目 ==================== */

/**
 * 把视觉识别的原始结果整理成后续环节能用的题目对象。
 *
 * 这里**不做任何修正**：识别到什么就是什么。
 * 唯一的加工是把 uncertain（模型自己标记的不确定处）转成后续要用的形态。
 *
 * @param {object} rec recognizeProblem() 的返回值
 * @returns {{no:string, question:string, solution:string, solutionKind:string,
 *            uncertain:string[], extraDetected:string[], degraded:boolean, vision:object}}
 */
export function toProblem(rec) {
  const question = String(rec.question ?? '').trim();
  const solution = String(rec.solution ?? '').trim();

  return {
    no: rec.no || '本题',
    question,
    solution,
    // solutionKind 决定诊断口径：书上的解答 vs 学生的作答，判定标准不同
    solutionKind: solution ? 'answer' : 'none',
    uncertain: rec.uncertain ?? [],
    extraDetected: rec.extraDetected ?? [],
    degraded: !!rec.degraded,
    vision: {
      model: rec.model,
      elapsedMs: rec.elapsedMs,
      imageBytes: rec.imageBytes,
    },
  };
}

/**
 * 单题约束检查。
 *
 * 不做硬拦截（不抛错、不拒绝请求），只产出给前端看的提示。
 * 理由：模型对"图里有几道题"的判断本身也可能错，
 * 拿它当拒绝理由会让用户陷入"我怎么都传不上去"的死局。
 * 提示 + 让用户自己决定，比强行阻拦更可靠。
 *
 * @returns {{ok:boolean, issues:string[]}}
 */
export function checkSingleProblem(rec) {
  const issues = [];

  if (rec?.isProblem === false) {
    issues.push('这张照片里似乎没有题目。请对准题目本身重新拍一张。');
  }
  if (rec?.extraDetected?.length) {
    issues.push(
      `照片里还检测到其他题目：${rec.extraDetected.join('、')}。`
      + '本次只处理了其中一道——请一题一图，把要问的那道单独拍下来。'
    );
  }
  if (!String(rec?.question ?? '').trim()) {
    issues.push('没有识别到题干内容，请重拍。');
  }

  return { ok: issues.length === 0, issues };
}

/**
 * 宽松 JSON 解析：模型偶尔会裹一层 ```json 围栏，或者前后带一句话。
 * 这里不追求严格，只求把能用的对象捞出来。
 */
export function parseJsonLoose(text) {
  let s = String(text ?? '').trim();

  // 去掉代码围栏
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();

  // 先直接试
  try { return JSON.parse(s); } catch { /* 继续 */ }

  // 退而求其次：截取第一个 { 到最后一个 }
  const i = s.indexOf('{');
  const j = s.lastIndexOf('}');
  if (i >= 0 && j > i) {
    try { return JSON.parse(s.slice(i, j + 1)); } catch { /* 放弃 */ }
  }
  return null;
}

/* ==================== 第 2 步：图谱标记 ==================== */

/**
 * 找出这道题涉及哪些图谱知识点。
 *
 * 分两路：
 *   A. 确定性匹配——把 125 个知识点名逐个去题干里找（复用 graph.findFocusInQuestion）
 *   B. 语义匹配——题干用了别的说法时，由模型在候选名单里挑
 *
 * 为什么要叠加 B：学生和题目不会总用教材原词（"推迟势" vs "时谐场的滞后解"），
 * 只靠字符串匹配会大面积漏。但 B 的结果必须回到图谱校验，模型报的 ID 不存在就丢弃。
 *
 * 性能说明：A 是纯本地计算（微秒级），B 要调模型（30~60s）。
 * 所以把 A 放在最前面先拿到结果，B 失败或超时都不影响主流程。
 */
export async function locateNodes(problem, { limit = 6, roster } = {}) {
  const text = `${problem.question ?? ''}\n${problem.solution ?? ''}`;
  // A. 字符串命中（快，先做）
  const deterministic = await G.findFocusInQuestion(text, limit);

  // 已经命中足够多就不必再问模型——省一次 30s+ 的调用
  if (deterministic.length >= limit) {
    return deterministic.slice(0, limit).map((p) => ({
      id: p.id, name: p.name, chapterId: p.chapterId, matchBy: p.matchBy ?? 'name',
    }));
  }

  // B. 语义补充
  const all = roster ?? await G.listPoints();
  const rosterText = all.map((p) => `${p.id}\t${p.name}`).join('\n');

  let semantic = [];
  try {
    const r = await chat({
      system: `你是电动力学课程的助教。下面给你一份知识图谱的完整名录（ID 与名称）。
请从名录中挑出与这道作业题**最相关**的知识点，最多 ${limit} 个。
只输出 JSON 数组，元素是名录里真实存在的 ID 字符串，例如 ["kp_plane_wave","kp_poynting_vector"]。
宁可少挑，也不要挑牵强的。若不相关就输出 []。不要输出任何其他文字。`,
      messages: [{ role: 'user', content: `题目：\n${text.slice(0, 2000)}\n\n--- 名录 ---\n${rosterText}` }],
      temperature: 0.1,
      timeoutMs: 60000,
    });
    const arr = parseJsonLoose(r.content);
    if (Array.isArray(arr)) semantic = arr.map((x) => String(x).trim());
  } catch {
    // 语义匹配失败不致命，退化为只用字符串命中
  }

  // 合并 + 校验存在性（编造的 ID 一律丢弃，和答疑链路一个标准）
  const byId = new Map(all.map((p) => [p.id, p]));
  const picked = [];
  const seen = new Set();

  for (const p of deterministic) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    picked.push({ id: p.id, name: p.name, chapterId: p.chapterId, matchBy: p.matchBy ?? 'name' });
  }
  for (const id of semantic) {
    if (seen.has(id) || !byId.has(id)) continue;
    seen.add(id);
    const p = byId.get(id);
    picked.push({ id: p.id, name: p.name, chapterId: p.chapterId, matchBy: 'semantic' });
  }

  return picked.slice(0, limit);
}

/* ==================== 第 3 步：判定与根因 ==================== */

/**
 * 对一道题做诊断。
 *
 * 两种情形要分开处理：
 *   A. 题目自带解答（课本例题）—— 判定"这个解答讲得对不对/完不完整"
 *   B. 只有题干 —— 引导学生自己推
 * 两者口径不同，由 solutionKind 区分。
 *
 * 识别带来的不确定性来自两处：
 *   1. 视觉模型自己标记的 uncertain（它明确说"这里我不确定"）
 *   2. 题干或解答为空（等于没识别出来）
 * 这两种情况下都不做对错判定，转而请学生核对/重拍。
 *
 * 铁律：**识别不确定的地方，宁可不说，也不猜着批改。**
 * 把识别误差当成学生的错误去批评，伤害比漏判大得多。
 */
export async function diagnoseProblem(problem, nodes) {
  const uncertain = problem.uncertain ?? [];
  const hasQuestion = !!String(problem.question ?? '').trim();
  const hasSolution = !!String(problem.solution ?? '').trim();

  // 题干都没识别出来 → 直接进入"请重拍"模式
  if (!hasQuestion) {
    return {
      status: 'unreadable',
      verdict: '无法判定',
      reason: '没有识别到题干内容，无法判断这道题在问什么。请重拍。',
      unreliable: uncertain.map((t) => ({ text: t, readability: 'unclear', note: '模型标记为不确定' })),
      mistakes: [],
      notCovered: [],
      retakeHints: buildRetakeHints(uncertain, { noQuestion: true }),
    };
  }

  const graphCtx = await buildGraphEvidence(nodes);

  const system = `你是电动力学课程的助教，正在审阅一道题目。

【最先要理解的事】
题干与解答来自对照片的**视觉识别**（不是学生手写，是拍下来的印刷体题目）。
识别结果中，下面这些地方模型明确表示**不确定**，可能是看错了：
${uncertain.length ? uncertain.map((t) => `  · ${t}`).join('\n') : '  （无）'}

【你的判定要以这些为前提】
- 上面列出的不确定处，**不要**据此指出错误，改写进 notCovered；
- 若不确定处恰好位于解题的关键步骤上，宁可整体判 unreadable 并说明原因，
  也不要基于一个可能看错的公式去批评解答。

【任务】给出诊断，输出 JSON（不要解释文字、不要代码围栏）：
{
  "verdict": "correct" | "partial" | "incorrect" | "unreadable" | "no_answer",
  "summary": "一句话说明这道题的状况（不超过 60 字）",
  "mistakes": [
    {
      "point": "出问题的物理环节，一句话",
      "evidence": "题目/解答原文里的依据（必须能原文中找到）",
      "nodeId": "对应的图谱知识点 ID，没有就写空字符串",
      "severity": "concept" | "method" | "calculation"
    }
  ],
  "notCovered": ["题干要求但解答里看不出来的环节"]
}

verdict 取值口径：
- "correct"  —— 解答正确且完整
- "partial"  —— 思路对但有缺漏，或结论对但论证不足
- "incorrect"—— 有明确的物理或数学错误
- "no_answer"—— 只有题目没有解答（常见于课本例题的题干部分）
- "unreadable"—— 识别不确定处太多，无法判定

【判定的边界｜极重要】
- verdict 为 incorrect 或 partial 时，mistakes 里每一条都必须有 evidence，
  且 evidence 必须能在题干或解答原文中找到。**找不到证据就不要写这条错误。**
- 表述不同不算错。公式的等价变形不算错。
- 你不确定的地方，写进 notCovered，不要写成 mistakes。
- 如果题目本身是课本上的标准例题、书上给的解答是规范答案，就如实判 correct，
  不要为了"显得有用"而硬找问题。
- 如果没有解答（只有题干），判 no_answer，不要凭空替他解答。`;

  const r = await chat({
    system,
    messages: [{
      role: 'user',
      content: `题目：${problem.question}\n\n`
        + `解答：\n${hasSolution ? problem.solution : '（照片上没有解答，属于只有题目的情况）'}\n\n`
        + `图谱依据：\n${graphCtx.text || '（未匹配到相关知识点）'}\n\n`
        + `请给出诊断 JSON。`,
    }],
    temperature: 0.2,
    timeoutMs: 90000,
  });

  const d = parseJsonLoose(r.content) ?? {};

  // 校验：模型报的 nodeId 必须真实存在，否则清空（宁可没有引用，也不能有假引用）
  const validIds = new Set(nodes.map((n) => n.id));
  const mistakes = (d.mistakes ?? []).map((m) => ({
    point: m.point ?? '',
    evidence: m.evidence ?? '',
    nodeId: validIds.has(m.nodeId) ? m.nodeId : '',
    severity: ['concept', 'method', 'calculation'].includes(m.severity) ? m.severity : 'method',
    droppedNodeId: validIds.has(m.nodeId) ? null : (m.nodeId || null),
  }));

  const status = d.verdict ?? (hasSolution ? 'unreadable' : 'no_answer');

  return {
    status,
    verdict: {
      correct: '正确', partial: '部分正确', incorrect: '有错误',
      unreadable: '无法判定', no_answer: '仅有题目',
    }[status] ?? '无法判定',
    reason: d.summary ?? '',
    mistakes,
    notCovered: d.notCovered ?? [],
    unreliable: uncertain.map((t) => ({ text: t, readability: 'unclear', note: '模型标记为不确定' })),
    retakeHints: status === 'unreadable' ? buildRetakeHints(uncertain, { noSolution: hasQuestion && !hasSolution }) : [],
  };
}

/**
 * 从识别的不确定处反推"该怎么重拍"。
 *
 * 这一步的价值在于：学生看到"识别失败"通常不知道该怎么办，
 * 只能反复重传同一张烂图。给出具体动作（"公式那一行单独拍""避开反光"）才解决问题。
 * 这里只做粗分类，具体措辞交给模型在反馈里组织。
 *
 * @param {string[]} uncertain 模型自报的不确定处
 * @param {{noQuestion?:boolean, noSolution?:boolean}} [ctx]
 */
export function buildRetakeHints(uncertain = [], ctx = {}) {
  const hints = new Set();
  const list = Array.isArray(uncertain) ? uncertain : [];

  if (ctx.noQuestion) hints.add('题干整段没认出来——把题目完整框进画面，别只拍一半');
  if (ctx.noSolution) hints.add('只拍到了题干——若书上这道题带解答，把解答部分也一起拍进来');

  for (const u of list) {
    const t = String(u ?? '');
    // 含 LaTeX 控制符或反斜杠：多半是公式没看准
    if (/\\[a-zA-Z]+|[{}$^_]/.test(t)) hints.add('公式里有看不清的地方——把公式那几行单独拍一张，让它占满画面');
    // 提到下标/上标/符号
    if (/下标|上标|指数|符号|字母/.test(t)) hints.add('字母或上下标看不准——靠近一点拍，保证字迹边缘清晰');
    // 提到模糊/遮挡/反光
    if (/模糊|不清|遮挡|反光|阴影|重影/.test(t)) hints.add('画面有模糊、遮挡或反光——换个角度、避开光源直射再拍');
  }

  if (list.length >= 3) hints.add('不确定的地方较多——建议在光线均匀的地方重拍一张');
  return [...hints];
}

/**
 * 根因追溯：把出错的节点丢给图谱，沿先修链往上找真正断掉的基础。
 * 这是纯粹图运算，模型不参与——和答疑链路保持同一个可信度标准。
 */
export async function traceRoots(nodes, mistakes) {
  const ids = [...new Set([
    ...mistakes.map((m) => m.nodeId).filter(Boolean),
    ...nodes.map((n) => n.id),
  ])];

  if (!ids.length) return { symptoms: [], roots: [] };

  const symptoms = [];
  for (const id of ids) {
    const k = await G.getPoint(id);
    if (k) symptoms.push({ id: k.id, name: k.name });
  }

  const roots = await G.diagnoseRoots(symptoms.map((s) => s.id), 3);
  return { symptoms, roots };
}

/** 为若干节点拼出可注入提示词的图谱证据（紧凑版） */
async function buildGraphEvidence(nodes) {
  if (!nodes.length) return { text: '', nodeIds: [] };
  return G.subgraphContext(nodes.map((n) => n.id));
}

/* ==================== 第 4 步：引导式对话 ==================== */

export const GUIDE_RULES = `
【绝不给出完整解答｜这是最硬的一条规则】

学生的用法是**拍下课本/试卷上的题目**来求助。
他要的是"这题该怎么想"，不是"这题的答案"——答案就在他手里的书上。

你的任务是**引导学生自己想出来**，不是把答案交给他。

【一次只推进一步】
每一步只搭一个台阶：指出一个可疑点、或反问一个更基础的问题，然后**停下来等他回应**。
不要一口气把他后面三步该怎么想都讲出来——那样他读到的是一份思路提纲，
不是一个可以自己走的过程。他答完这一步，你再给下一步。

允许你做：
- 指出他思路里第一个值得怀疑的地方，问他为什么这么想
- 反问一个更基础的问题，把他拉回物理图像
- 说出该用哪个方程/哪个概念**的名字**，但不写出它的内容
- 让他自己核验一个量纲、一个极限情形、一个特例
- 指出这道题在教材的哪一节，让他自己翻过去对照
- 如果他确实卡死，可以再退一步给更基础的提示，但仍不写出最终结果

禁止你做：
- 写出这道题的完整推导步骤
- 直接给出最终结果或关键中间结果的表达式
- 写出一整段可以直接抄进作业的解答
- 在学生还没尝试之前就把方法讲完
- **在提示里泄露结论性的物理关系**。例如"E×B 指向传播方向""B 的振幅比 E 小一个 c""平均值要带 1/2 因子"
  这类话虽然看起来只是一个"线索"，但它把学生本该自己推出来的关键结论直接说了出来，等同于给答案。
  允许的说法是把它变成问题："传播方向该怎么判断？你想用哪个矢量的方向来定？"
  即：**提示只能指向思路的入口，不能指向结论。**
- **替学生把式子写出来**。即使是题干里已经给出的量，也不要由你重写一遍——
  学生需要自己盯着书上那行公式想，你写一遍反而让他分不清该看哪个。
  要指代某个量，用文字（"题里那个振幅""你要求的那个量"），不要用公式。

【识别失败时的正确做法】
如果题目或解答里有片段识别失败，**不要猜着往下讲**，也不要假装看懂了。
明确告诉学生"这一处没认出来"，并请他重拍那个位置——这是唯一负责任的做法。

【自检】写完回复后回头看一眼：如果学生照着你这段话就能把答案拼出来，那这段话就写多了，删到只剩问题。
再检查一遍：回复里的公式是不是都在描述**问题**（比如你要他算的东西），而不是在**给出内容**？

【语气】
像个坐在旁边的助教，不是考官。指出问题时对事不对人，不评判。
如果识别有疑问，先请学生核对原书，而不是断言他看错了。
如果他直接要答案，温和地拒绝并给一个更小的台阶，例如把问题拆小一半再问回去。
`;

/** 开场引导的额外约束：第一印象最容易讲多，所以单独再压一次篇幅 */
export const OPENING_EXTRA = `
【这段是开场，格外注意】
- 300 字以内。先一句整体印象，然后**只聚焦一个**最值得他想清楚的点，不要把所有问题都倒出来。
- 结尾抛一个具体的小问题，让他能自己往下走。
- 涉及识别失败时，说清楚是哪一处、该怎么重拍（拍公式那几行、避开反光、让整题入镜）。
- **不要复述题目内容**——题目就在他手上，复述只会占篇幅。
- 情绪上要稳：既不夸"很棒"，也不批评。就事论事。
`;

export function buildGuidePrompt({ problem, diagnosis, roots, nodes, graphText }) {
  const mistakeLines = (diagnosis?.mistakes ?? []).length
    ? diagnosis.mistakes.map((m, i) =>
        `  ${i + 1}. ${m.point}${m.nodeId ? `（关联知识点：${m.nodeId}）` : ''}`
        + `\n     依据：${m.evidence}`).join('\n')
    : '  （未发现明确错误）';

  const unreliableLines = (diagnosis?.unreliable ?? []).length
    ? diagnosis.unreliable.map((u) => `  · [${u.readability}] ${u.text}${u.note ? ` —— ${u.note}` : ''}`).join('\n')
    : '  （无）';

  const rootLines = (roots?.roots ?? []).length
    ? roots.roots.slice(0, 5).map((r, i) =>
        `  ${i + 1}. ${r.name} [${r.id}]（${r.isHardPrerequisite ? '硬前提' : '弱关联'}，`
        + `支撑 ${r.supportedCount} 个症状，第 ${r.level} 层）`).join('\n')
    : '  （未找到共同先修）';

  const retakeLines = (diagnosis?.retakeHints ?? []).length
    ? diagnosis.retakeHints.map((h) => `  · ${h}`).join('\n')
    : '  （无需重拍）';

  return `
你是电动力学课程的 AI 助教。学生拍了一张题目照片来求助，下面是从照片里识别出的内容。

【题目】
${problem?.question ?? '（题干缺失）'}

【题目自带的解答（课本例题常有；没有就是空的）】
${problem?.solution || '（照片上没有解答）'}

【识别中不确定的地方——严禁据此推断学生的理解状况】
${unreliableLines}

【若需重拍，建议这样拍】
${retakeLines}

【系统对这道题的诊断】
结论：${diagnosis?.verdict ?? '未判定'}
${diagnosis?.reason ? `说明：${diagnosis.reason}` : ''}
疑点：
${mistakeLines}
${(diagnosis?.notCovered ?? []).length ? `题目要求但解答里看不到的环节：\n${diagnosis.notCovered.map((x) => `  · ${x}`).join('\n')}` : ''}

【系统沿先修链回溯出的基础薄弱点（这是图运算结果，不是猜的）】
${rootLines}

【涉及的知识点】
${(nodes ?? []).map((n) => `  · ${n.name} [${n.id}]`).join('\n') || '  （未匹配到）'}

${graphText ? `【图谱依据（可引用其中的节点 ID）】\n${graphText}\n` : ''}

${GUIDE_RULES}
`.trim();
}

/**
 * 生成开场引导（学生上传题目照片后看到的第一段反馈）。
 *
 * 单题模式：一次只针对这一道题给反馈。
 * 若识别有不确定处，第一件事是说清楚"哪里没认准、该怎么重拍"。
 */
export async function buildOpening(analysis) {
  const { problem, diagnosis, nodes, extraDetected = [] } = analysis;
  const system = `你是电动力学课程的 AI 助教。学生刚发来一张题目照片，你要给他第一段反馈。

${GUIDE_RULES}

${OPENING_EXTRA}

【格式】用 LaTeX 写公式时用 $...$。`;

  const user = `
题干：${problem.question}
解答（若照片上有）：${problem.solution || '（无）'}
诊断：${diagnosis.verdict}${diagnosis.reason ? ` —— ${diagnosis.reason}` : ''}
疑点：${diagnosis.mistakes.length ? diagnosis.mistakes.map((m) => m.point).join('；') : '无'}
识别不确定处：${diagnosis.unreliable?.length ? diagnosis.unreliable.map((u) => u.text.slice(0, 40)).join('；') : '无'}
${diagnosis.retakeHints?.length ? `重拍建议：${diagnosis.retakeHints.join('；')}` : ''}
可溯源节点：${nodes.map((n) => `${n.name}[[KG:${n.id}|${n.name}]]`).join('、') || '无'}
${extraDetected.length ? `照片里还存在其他题目（本次已忽略，需提醒他一题一图）：${extraDetected.join('、')}` : ''}
`;

  const r = await chat({
    system,
    messages: [{ role: 'user', content: `这是我发来的题目情况：\n${user}\n\n请给我反馈。` }],
    temperature: 0.6,
    timeoutMs: 90000,
  });

  return r.content;
}

/**
 * 引导式追问（流式）。学生接着说"我还是不懂"时走这里。
 *
 * 兜底检查：生成完扫一遍，若出现"完整解答式"的危险信号（把最终结果直接写出来），
 * 不静默放行——记日志并把告警回传给前端，让边界可见。
 */
export async function streamGuide({
  history, problem, diagnosis, roots, nodes, graphText, onContent, onReasoning,
}) {
  const system = buildGuidePrompt({ problem, diagnosis, roots, nodes, graphText });

  const result = await streamChat({
    system,
    messages: history,
    onContent,
    onReasoning,
    temperature: 0.6,
  });

  const flags = detectAnswerLeak(result.content);
  return { ...result, flags };
}

/**
 * 答案泄露检测。
 *
 * 这里刻意不做"关键词黑名单"式的粗暴拦截——物理表述太灵活，误杀率会很高，
 * 而且一旦拦错，学生会收到一段面目全非的回复。
 * 因此只做**信号提示**：把可疑之处报给前端标出来，由人（学生/老师）判断，
 * 同时在后端日志里留痕，方便观察这个边界是否真的守住了。
 */
export function detectAnswerLeak(text) {
  const s = String(text ?? '');
  const flags = [];

  // 多个 display 公式连排，通常是"把推导写完了"
  const displayCount = (s.match(/\$\$[\s\S]+?\$\$/g) ?? []).length;
  if (displayCount >= 3) flags.push(`连续 ${displayCount} 个独立公式，可能有完整推导`);

  // 出现了"最终/答案/所以结果"且紧跟等式
  if (/(最终|最后|答案|结果为|解得)\s*[:：]?\s*\$/i.test(s)) flags.push('出现"最终结果"式表述');

  // 明确写出某量等于某式的收尾
  if (/\\boxed\{/.test(s)) flags.push('使用了 \\boxed 表示的最终答案');

  if (flags.length) {
    console.warn('[Guide] 可能的解答泄露信号：' + flags.join('；'));
  }
  return flags;
}
