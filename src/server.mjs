/**
 * 电动力学 AI 助教 —— 应用服务层
 * ------------------------------------------------------------------
 * 职责：
 *   1) 图谱查询 API（章节树、知识点、先修链、根因诊断、可视化取数）
 *   2) AI 答疑（SSE 流式 + 句子级溯源）
 *   3) 静态前端
 *
 * 设计原则：凡是可以由图运算确定的（先修链、根因、邻域），一律在服务端算好再交给模型；
 * 模型只负责把结论讲成人话，不允许它自己"判断"学生哪里不行。
 */

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as G from './graph.mjs';
import * as H from './homework.mjs';
import * as V from './vision.mjs';
import * as M from './mathgraph.mjs';
import * as R from './relations.mjs';
import { ROOT, SUBJECT, describeConfig } from './config.mjs';
import { getConn, getDb, rows, closeDb } from './kuzu.mjs';
import { buildSystemPrompt } from './prompts.mjs';
import { parseCitations, summarizeProvenance } from './citations.mjs';
import { streamChat, llmInfo } from './llm.mjs';
import { envInfo, maskKey } from './env.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3200);

const app = express();
app.use(express.json({ limit: '8mb' }));

/**
 * 全局兜底：单个请求出问题不该把整个服务带走。
 * 尤其是 Kuzu 的锁异常——被强杀的上一个进程可能留下短暂的锁残留，
 * 若不加兜底，服务会因为一个未处理的 rejection 直接退出。
 */
process.on('uncaughtException', (err) => {
  console.error('[Fatal] 未捕获异常，服务保持存活：', err?.message ?? err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[Fatal] 未处理的 Promise 拒绝：', reason?.message ?? reason);
});

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

/* ============ 节点存在性白名单（引用校验用，启动时载入） ============ */

let NODE_IDS = new Set();

async function refreshNodeIds() {
  const list = await G.listPoints();
  NODE_IDS = new Set(list.map((p) => p.id));
  return NODE_IDS.size;
}

const hasNode = (id) => NODE_IDS.has(id);

/* ============================ 图谱 API ============================ */

app.get('/api/health', async (_req, res) => {
  try {
    const s = await G.stats();
    const l = llmInfo();
    res.json({
      status: 'ok',
      // build 号：改前端/后端时手动递增。状态栏会显示它，用于确认浏览器跑的是新版页面
      build: '2026-09-22a',
      subject: SUBJECT.name,
      graph: s,
      /** Graph C 数学推导图（回答「这个概念是怎么来的」） */
      mathGraph: M.mathGraphStats(),
      storage: describeConfig(),
      llm: {
        provider: 'GLM（智谱）',
        model: l.model,
        base: l.base,
        configured: l.hasKey,
        keyMasked: l.hasKey ? maskKey(process.env.GLM_API_KEY) : null,
      },
      vision: {
        provider: V.visionInfo().provider,
        model: V.visionInfo().model,
        configured: V.visionInfo().hasKey,
        purpose: '题目照片识别（题干 + LaTeX 公式）',
        note: '作业辅导链路的第一步；与对话模型共用 GLM_API_KEY',
      },
      mineru: {
        configured: !!process.env.MINERU_API_KEY,
        purpose: '试卷 PDF / 教材解析（→ Markdown）',
        note: '仅用于批量文档导入，作业辅导链路已改用上面的视觉模型直读',
      },
      homework: {
        available: V.visionInfo().hasKey && l.hasKey,
        mode: '单题',
        boundary: '只给引导与提示，不输出完整解答',
      },
    });
  } catch (e) {
    res.status(500).json({ status: 'error', error: e.message });
  }
});

/**
 * 优雅停止（本地开发用）
 * ------------------------------------------------------------------
 * 直接 taskkill /F 强杀会跳过 closeDb()，Kuzu 的文件锁释放滞后，
 * 紧接着重启就会撞上 "Could not set lock on file"。
 * 走这个接口能先释放数据库句柄再退出。
 */
app.post('/api/shutdown', (_req, res) => {
  console.log('[Server] 收到停止请求，正在释放资源…');
  res.json({ success: true, message: '正在停止服务' });
  setTimeout(() => {
    try { closeDb(); } catch { /* ignore */ }
    process.exit(0);
  }, 150);
});

app.get('/api/stats', async (_req, res) => res.json(await G.stats()));

app.get('/api/chapters', async (_req, res) => res.json({ chapters: await G.listChapters() }));

app.get('/api/tree', async (req, res) => {
  res.json({ tree: await G.chapterTree(req.query.chapterId?.toString()) });
});

app.get('/api/points', async (req, res) => {
  res.json({ points: await G.listPoints(req.query.chapterId?.toString()) });
});

app.get('/api/point/:id', async (req, res) => {
  const k = await G.getPoint(req.params.id);
  if (!k) return res.status(404).json({ error: '知识点不存在' });
  res.json({
    point: k,
    prerequisites: await G.directPrerequisites(k.id),
    dependents: await G.directDependents(k.id),
    related: await G.related(k.id),
    /**
     * Graph C：这个知识点在数学上是怎么来的。
     * 注意与 prerequisites 的区别——那走的是「该先学谁」（教学顺序，无环），
     * 这里走的是「数学上怎么推出来」（推导关系，允许成环）。
     * 没有对应数学节点时为 null。
     */
    derivation: M.derivationChain(k.id),
  });
});

/** Graph C 单独取（测试与其他前端复用） */
app.get('/api/derivation/:kpId', (req, res) => {
  const r = M.derivationChain(req.params.kpId);
  if (!r) return res.status(404).json({ error: '该知识点在数学推导图中没有对应节点' });
  res.json(r);
});

/** 边类型词表：图例与边信息面板用 */
app.get('/api/edge-types', (_req, res) => {
  res.json({ types: M.edgeTypes() });
});

app.get('/api/trace', async (req, res) => {
  const id = req.query.id?.toString();
  const depth = Number(req.query.depth ?? 3);
  if (!id) return res.status(400).json({ error: '缺少 id' });
  const k = await G.getPoint(id);
  if (!k) return res.status(404).json({ error: '知识点不存在' });
  res.json({ point: { id: k.id, name: k.name }, levels: await G.traceUpstream(id, depth) });
});

app.get('/api/downstream', async (req, res) => {
  const id = req.query.id?.toString();
  const depth = Number(req.query.depth ?? 3);
  if (!id) return res.status(400).json({ error: '缺少 id' });
  const k = await G.getPoint(id);
  if (!k) return res.status(404).json({ error: '知识点不存在' });
  res.json({ point: { id: k.id, name: k.name }, levels: await G.traceDownstream(id, depth) });
});

/** 根因诊断：给定若干「学不懂」的知识点，返回候选根因 */
app.get('/api/roots', async (req, res) => {
  const ids = String(req.query.ids ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const depth = Number(req.query.depth ?? 3);
  if (!ids.length) return res.status(400).json({ error: '缺少 ids' });
  const points = [];
  for (const id of ids) {
    const k = await G.getPoint(id);
    if (k) points.push({ id: k.id, name: k.name });
  }
  res.json({ symptoms: points, roots: await G.diagnoseRoots(points.map((p) => p.id), depth) });
});

app.get('/api/search', async (req, res) => {
  const q = String(req.query.q ?? '');
  res.json({ hits: await G.search(q, Number(req.query.limit ?? 15)) });
});

app.get('/api/graph-view', async (req, res) => {
  const scope = String(req.query.scope ?? 'all');
  const depth = Number(req.query.depth ?? 1);
  const data = await G.graphView({ scope, depth });
  // 给每条边补上归一化后的关系（类型名 / 来源标准 / 数学性质），供点击边时展示。
  // 关系分类在读取时算，不写回数据文件——见 src/relations.mjs 的模块说明。
  data.links = data.links.map((l) => ({ ...l, relation: R.classify(l) }));
  res.json(data);
});

/** 关系词表：SKOS 13 种原生关系 + 本项目领域扩展，界面图例与关系卡片用 */
app.get('/api/relations', (_req, res) => res.json(R.catalog()));

app.get('/api/outline', async (_req, res) => res.json({ outline: await G.outlineContext() }));

/* ============================ AI 答疑 ============================ */

/**
 * 把图谱中与该问题相关的一切确定性信息组织成上下文。
 * 关键点：先修链是算出来的，不是让模型猜的。
 */
async function buildContext(question, focusIds, depth = 3) {
  let focus = [];

  if (focusIds?.length) {
    for (const id of focusIds) {
      const k = await G.getPoint(id);
      if (k) focus.push(k);
    }
  }

  // 没给焦点就从问题里找：按名称/定义命中
  if (!focus.length) {
    const hits = await G.findFocusInQuestion(question, 4);
    for (const h of hits) {
      const k = await G.getPoint(h.id);
      if (k) focus.push(k);
    }
  }

  const { text: graphText, nodeIds } = focus.length
    ? await G.subgraphContext(focus.map((k) => k.id))
    : { text: '', nodeIds: [] };

  // 焦点知识点的先修链（确定性算出，附理由）
  const chains = [];
  for (const k of focus) {
    const levels = await G.traceUpstream(k.id, depth);
    if (!levels.length) continue;
    chains.push({
      target: { id: k.id, name: k.name },
      levels: levels.map((level, i) => ({
        level: i + 1,
        nodes: level.map((n) => ({
          id: n.id, name: n.name, strength: n.strength,
          weakest: n.weakest, reason: n.reason, viaName: n.viaName,
        })),
      })),
    });
  }

  let chainText = '';
  if (chains.length) {
    chainText = chains.map((c) => {
      const lines = c.levels.map((lv) =>
        `  第${lv.level}层：` +
        lv.nodes.map((n) => `${n.name} [${n.id}]（${n.weakest === '强' ? '硬前提' : '弱关联'}）— ${n.reason}`).join('\n          ')
      ).join('\n');
      return `▸「${c.target.name}」[${c.target.id}] 的先修链：\n${lines}`;
    }).join('\n\n');
  }

  return {
    focus,
    nodeIds,
    graphText,
    chainText,
    outlineText: await G.outlineContext(),
  };
}

app.post('/api/ask', async (req, res) => {
  const { question, focusIds, depth = 3 } = req.body ?? {};
  if (!question || typeof question !== 'string') {
    return res.status(400).json({ error: 'question 不能为空' });
  }

  console.log(`\n[Ask] ${question.slice(0, 100)}`);
  const t0 = Date.now();

  // SSE
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  res.write(': connected\n\n');
  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* ignore */ }
  }, 15000);
  res.on('close', () => clearInterval(heartbeat));

  const send = (obj) => {
    try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* ignore */ }
  };

  try {
    const ctx = await buildContext(question, focusIds, depth);
    console.log(`[Ask] 焦点 ${ctx.focus.length} 个：${ctx.focus.map((f) => f.name).join('、') || '（无）'}`);

    const systemPrompt = buildSystemPrompt({
      graphText: ctx.graphText,
      outlineText: ctx.outlineText,
      focusPoints: ctx.focus.map((f) => ({ id: f.id, name: f.name })),
      toolMode: false,
    });

    // 先修链作为「已算好的事实」附在提问后面，模型只需转述
    const prompt = ctx.chainText
      ? `${question}\n\n---\n下面是系统已从知识图谱中算出的先修链，请直接依据它作答，不要自行推测：\n${ctx.chainText}`
      : question;

    send({
      type: 'init',
      focus: ctx.focus.map((f) => ({ id: f.id, name: f.name, chapter: f.chapter?.title ?? '' })),
      injectedNodes: ctx.nodeIds,
      model: llmInfo().model,
    });

    // 交给 GLM 流式生成（本项目只使用 GLM）
    const t1 = Date.now();
    let firstDeltaAt = null;
    const result = await streamChat({
      system: systemPrompt,
      messages: [{ role: 'user', content: prompt }],
      onContent: (t) => {
        if (!firstDeltaAt) firstDeltaAt = Date.now();
        send({ type: 'text', content: t });
      },
      // 思考过程单独走 reasoning 事件，前端可折叠展示，绝不混进正文
      onReasoning: (t) => send({ type: 'reasoning', content: t }),
    });
    const full = result.content;
    console.log(
      `[Ask] GLM 返回 ${full.length} 字正文 / ${result.reasoning.length} 字思考 ｜ ` +
      `首字 ${firstDeltaAt ? ((firstDeltaAt - t1) / 1000).toFixed(1) + 's' : '—'} ｜ ` +
      `tokens ${result.usage?.total_tokens ?? '?'}`
    );

    // ---- 先甄别「静默失败」 ----
    // 空正文是最难排查的故障形态，这里统一转成显式错误。
    if (!full.trim()) {
      send({ type: 'error', message: '模型没有返回任何内容，请重试。' });
      res.end();
      return;
    }

    // ---- 句子级溯源 ----
    const segments = parseCitations(full, hasNode);
    const summary = summarizeProvenance(segments);
    console.log(
      `[Ask] 完成 ${((Date.now() - t0) / 1000).toFixed(1)}s ｜ ` +
      `${summary.total} 句，覆盖率 ${summary.coverage}%，无效引用 ${summary.invalid}`
    );

    if (summary.invalid > 0) {
      const bad = [...new Set(segments.flatMap((s) => s.invalidCitations.map((c) => c.nodeId)))];
      console.log(`[Ask] 被拦下的编造节点 ID：${bad.join(', ')}`);
    }

    send({ type: 'segments', segments, summary, raw: full });
    send({ type: 'done' });
    res.end();
  } catch (e) {
    console.error('[Ask] 失败：', e?.message);
    send({ type: 'error', message: e?.message ?? '处理失败' });
    res.end();
  } finally {
    clearInterval(heartbeat);
  }
});

/* ======================= 作业辅导（图片 → 引导） ======================= */

/**
 * SSE 发送器：作业链路耗时较长（OCR 5~10s，逐题诊断 1~2min），
 * 中间必须让前端看见进度，否则用户会以为卡死了。
 */
function sseOpen(res) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  res.write(': connected\n\n');

  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* ignore */ }
  }, 15000);

  return {
    send(obj) {
      try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* ignore */ }
    },
    close() {
      clearInterval(heartbeat);
      try { res.end(); } catch { /* ignore */ }
    },
  };
}

/**
 * 上传题目照片 → 视觉识别 → 图谱标记 → 诊断 → 根因 → 开场引导
 * ------------------------------------------------------------------
 * **单题模式**：一次只处理一道题。识别阶段若发现图中有多道题，
 * 会通过 stage 事件给出提示，但仍继续处理——不硬拒绝，
 * 因为模型对"图里有几道题"的判断本身也可能出错。
 *
 * 识别用 GLM 视觉模型直读（不是 MinerU），一次请求就拿到题干 + LaTeX 公式。
 *
 * 请求体是 base64 图片（前端用 FileReader 读出来的 data URL）。
 * 走 base64 而不是 multipart：省掉一个 multer 依赖，
 * 且本链路的瓶颈在模型推理，不在那点传输开销。
 */
app.post('/api/homework/parse', async (req, res) => {
  const { image, filename = 'problem.png' } = req.body ?? {};
  if (!image || typeof image !== 'string') {
    return res.status(400).json({ error: '缺少 image 字段（base64 图片）' });
  }

  const t0 = Date.now();
  const S = sseOpen(res);
  let curStage = 'recognize';
  let curMsg = '';
  const stage = (name, msg, extra = {}) => {
    curStage = name;
    curMsg = msg ?? '';
    console.log(`[Homework] ${name}：${msg ?? ''}`);
    S.send({
      type: 'stage', stage: name, message: msg,
      elapsed: ((Date.now() - t0) / 1000).toFixed(1),
      ...extra,
    });
  };

  /**
   * 心跳：诊断与"生成反馈"两步要等模型 20~60 秒，期间一个事件都没有，
   * 前端进度条就干停在 72% / 96%——看起来和卡死一模一样。
   * 这里每 4 秒推一次"当前阶段 + 已耗时"，让长时间等待始终有可见的进展。
   */
  const ticker = setInterval(() => {
    S.send({
      type: 'tick',
      stage: curStage,
      message: curMsg,
      elapsedSec: Math.round((Date.now() - t0) / 1000),
    });
  }, 4000);

  try {
    const buf = Buffer.from(image.replace(/^data:[^;]+;base64,/, ''), 'base64');
    if (buf.length > 20 * 1024 * 1024) {
      S.send({ type: 'error', message: '图片超过 20 MB，请压缩后再传。' });
      return S.close();
    }
    const mime = (image.match(/^data:([^;]+);base64,/) ?? [])[1] || 'image/png';
    console.log(`\n[Homework] 收到图片 ${(buf.length / 1024).toFixed(0)} KB（${mime}）`);

    /* ---- 1. 视觉识别：照片 → 题干 + LaTeX ---- */
    stage('recognize', '识别中…');
    const rec = await V.recognizeProblem(buf, {
      mime,
      onProgress: (m) => stage('recognize', m),
    });

    // 单题约束检查：只提示，不拦
    const single = H.checkSingleProblem(rec);
    for (const issue of single.issues) stage('recognize', issue, { warn: 'single' });

    stage('recognize', `识别完成（${rec.model}，${(rec.elapsedMs / 1000).toFixed(1)}s）`);

    const problem = H.toProblem(rec);
    S.send({
      type: 'recognized',
      problem: { no: problem.no, question: problem.question, solution: problem.solution },
      uncertain: problem.uncertain,
      extraDetected: problem.extraDetected,
      warnings: single.issues,
      vision: { model: rec.model, elapsedMs: rec.elapsedMs },
    });

    if (!rec.isProblem && !problem.question) {
      S.send({ type: 'error', message: '这张照片里没有识别到题目，请对准题目重拍一张。' });
      return S.close();
    }

    /* ---- 2. 图谱标记 ---- */
    stage('locate', '定位中…');
    const roster = await G.listPoints();
    const nodes = await H.locateNodes(problem, { roster });
    stage('locate', nodes.length ? `命中 ${nodes.length} 个知识点` : '未命中知识点');

    /* ---- 3. 诊断 ---- */
    stage('diagnose', '核查中…');
    const diagnosis = await H.diagnoseProblem(problem, nodes);
    stage('diagnose', `判定：${diagnosis.verdict}`);

    /* ---- 4. 根因回溯 ---- */
    stage('roots', '回溯中…');
    const roots = await H.traceRoots(nodes, diagnosis.mistakes);
    stage('roots', roots.roots.length ? `找到 ${roots.roots.length} 个薄弱点` : '未找到共同先修');

    const record = {
      no: problem.no,
      question: problem.question,
      solution: problem.solution,
      uncertain: problem.uncertain,
      extraDetected: problem.extraDetected,
      nodes,
      diagnosis,
      roots,
    };

    /* ---- 5. 开场引导 ---- */
    stage('guide', '生成中…');
    const opening = await H.buildOpening({
      problem, diagnosis, nodes, extraDetected: problem.extraDetected,
    });
    const flags = H.detectAnswerLeak(opening);

    const result = {
      problem: record,
      opening,
      leakFlags: flags,
      warnings: single.issues,
      vision: { model: rec.model, elapsedMs: rec.elapsedMs, imageBytes: buf.length },
      elapsed: ((Date.now() - t0) / 1000).toFixed(1),
    };

    S.send({ type: 'done', ...result });
    console.log(`[Homework] 全流程完成 ${result.elapsed}s ｜ 泄露信号 ${flags.length} 个`);
  } catch (e) {
    console.error('[Homework] 失败：', e?.message);
    S.send({ type: 'error', message: e?.message ?? '处理失败' });
  } finally {
    clearInterval(ticker);
    S.close();
  }
});

/**
 * 引导式追问（SSE 流式）
 * 前端把这道题的上下文回传，不依赖服务端会话状态——刷新页面也不会丢。
 */
app.post('/api/homework/chat', async (req, res) => {
  const { question, problem, history } = req.body ?? {};
  if (!question || typeof question !== 'string') {
    return res.status(400).json({ error: 'question 不能为空' });
  }
  if (!problem || typeof problem !== 'object') {
    return res.status(400).json({ error: '缺少 problem 上下文，请先解析题目' });
  }

  console.log(`\n[Guide] 追问：${question.slice(0, 80)}`);
  const S = sseOpen(res);

  try {
    // 本次对话涉及的所有节点的图谱证据
    const graphText = problem.nodes?.length
      ? (await G.subgraphContext(problem.nodes.map((n) => n.id))).text
      : '';

    // 拼历史：前端传来的 + 本次提问
    const msgs = [
      ...(Array.isArray(history) ? history.slice(-8) : []).map((m) => ({
        role: m.role === 'ai' ? 'assistant' : 'user',
        content: String(m.content ?? ''),
      })),
      { role: 'user', content: question },
    ];

    const result = await H.streamGuide({
      history: msgs,
      problem,
      diagnosis: problem.diagnosis,
      roots: problem.roots,
      nodes: problem.nodes,
      graphText,
      onContent: (t) => S.send({ type: 'text', content: t }),
      onReasoning: (t) => S.send({ type: 'reasoning', content: t }),
    });

    if (!result.content.trim()) {
      S.send({ type: 'error', message: '模型没有返回内容，请重试。' });
      return S.close();
    }

    // 溯源：引导语同样按句子标注依据，学生能点开看对应知识点
    const segments = parseCitations(result.content, hasNode);
    const summary = summarizeProvenance(segments);

    S.send({ type: 'segments', segments, summary, leakFlags: result.flags ?? [] });
    S.send({ type: 'done' });
    console.log(`[Guide] 完成 ${result.content.length} 字 ｜ 覆盖率 ${summary.coverage}% ｜ 泄露信号 ${result.flags?.length ?? 0}`);
  } catch (e) {
    console.error('[Guide] 失败：', e?.message);
    S.send({ type: 'error', message: e?.message ?? '处理失败' });
  } finally {
    S.close();
  }
});

/* ============================ 静态前端 ============================ */
// HTML 不缓存：本项目是单用户本地应用，前端经常随代码一起改。
// 浏览器若缓存了旧页面，旧 JS 配新后端接口会对不上号（事件格式变了就"卡住无反应"），
// 这类问题极难排查。禁缓存后每次刷新都拿最新版，代价（几百 KB 传输）可以忽略。
// KaTeX 字体等大文件仍在 web/vendor/ 下，用 etag 协商缓存即可，不在此列。
app.use('/', express.static(path.join(ROOT, 'web'), {
  etag: true,
  lastModified: true,
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));

/* ============================ 启动 ============================ */

/**
 * 打开数据库并载入节点白名单，带退避重试。
 *
 * 为什么需要重试：Kuzu 是单写者，用文件锁独占数据库。如果上一个服务是被
 * `taskkill /F` 之类的强杀结束的（没走到 closeDb），锁的释放会滞后一点点。
 * 此时立刻重启就会撞上 "Could not set lock on file"。等几秒重试即可，不该直接崩。
 */
async function connectGraph(retries = 6) {
  for (let i = 1; i <= retries; i++) {
    try {
      const n = await refreshNodeIds();
      console.log(`[Graph] 载入 ${n} 个知识点用于引用校验`);
      return true;
    } catch (e) {
      const msg = String(e?.message ?? e).split('\n')[0];
      const isLock = /lock on file/i.test(msg);

      if (!isLock) {
        console.error(`[Graph] 载入失败：${msg}`);
        console.error('[Graph] 如尚未建库，请先执行：npm run ingest');
        return false;
      }
      if (i === retries) {
        console.error(`[Graph] 数据库一直被占用，重试 ${retries} 次后放弃：${msg}`);
        console.error('[Graph] 请确认没有其他进程占用该库文件（例如残留的服务进程），然后重试。');
        return false;
      }
      const wait = i * 1500;
      console.warn(`[Graph] 数据库暂被占用，${wait / 1000}s 后重试（${i}/${retries}）…`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  return false;
}

async function start() {
  const ok = await connectGraph();
  if (!ok) {
    console.error('\n[Server] 图谱不可用，服务未启动。\n');
    process.exit(1);
  }

  const server = app.listen(PORT);
  server.on('listening', async () => {
    let s = null;
    try { s = await G.stats(); } catch { /* 图谱统计失败不影响服务 */ }
    const l = llmInfo();
    console.log(`
╔══════════════════════════════════════════════════════╗
║   电动力学 AI 助教 — 服务已启动                       ║
║                                                      ║
║   地址   : http://localhost:${PORT}                     ║
║   图谱   : ${String(s?.points ?? '?').padEnd(4)} 知识点 / ${String(s?.prereq ?? '?').padEnd(4)} 先修边            ║
║   模型   : ${l.model.padEnd(24)} (GLM/智谱)   ║
║   图引擎 : Kuzu                                      ║
╚══════════════════════════════════════════════════════╝
    `);
    if (!l.hasKey) console.warn('[LLM] 未检测到 GLM_API_KEY，答疑功能不可用。请在 .env 中配置。');
    if (!envInfo.exists) console.warn(`[Env] 未找到 ${envInfo.envPath}`);
  });
  server.on('error', (err) => {
    if (err?.code === 'EADDRINUSE') {
      console.error(`[Server] 端口 ${PORT} 被占用，请先停止占用该端口的进程。`);
    } else {
      console.error('[Server] 启动失败：', err?.message ?? err);
    }
    process.exit(1);
  });
}

process.on('SIGINT', () => { closeDb(); process.exit(0); });
process.on('SIGTERM', () => { closeDb(); process.exit(0); });

start();
