/**
 * 题目识别的视觉通道（GLM 视觉模型直读）
 * ==================================================================
 * 为什么不用 MinerU：
 *   MinerU 是**文档版面解析器**，它的目标是还原整页文档的结构，
 *   对单张题目照片属于用大炮打蚊子——而且实测在翻拍条件下公式会崩：
 *     ∂²E/∂t²  →  \frac{1\omega^2_2}{.7/2}
 *     electromagnetic → electonmignttic
 *   更麻烦的是它输出的是"版面 Markdown"，还要再跑一次模型去切题、判可读性。
 *
 * 视觉模型直读的好处（同一张翻拍图实测对比）：
 *   · glm-4v-plus  5.4s，electromagnetic / \omega / \nabla\times E 全部正确
 *   · MinerU      13.4s，连 electromagnetic 都认错
 *   一次请求就拿到"题干 + LaTeX 公式"的结构化结果，链路短、失败面小。
 *
 * ⚠️ 但这不意味着识别一定可靠：
 *   模型仍可能看错字母、漏掉下标，甚至"顺手"把明显的错字改对。
 *   所以下游依然要保留"识别失败时不硬评"的边界，见 homework.mjs 的 READABILITY 部分。
 *
 * 配置：GLM_VISION_MODEL（默认 glm-4v-plus）。与对话模型共用 GLM_API_KEY。
 */

import { requireEnv } from './env.mjs';

const BASE = () => process.env.GLM_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4';
const MODEL = () => process.env.GLM_VISION_MODEL || 'glm-4v-plus';

export function visionInfo() {
  return {
    provider: 'GLM 视觉（智谱）',
    model: MODEL(),
    base: BASE(),
    hasKey: !!process.env.GLM_API_KEY,
  };
}

/**
 * 识别意图标记：模型在识别时可能发现"这不像一道题"或"图里有好几道题"。
 * 我们不做硬拦截，只把信号回传，让前端提示用户按单题重新拍。
 */
export const SINGLE_PROBLEM_RULE = `
【重要：一次只处理一道题】
这张照片里**应当只有一道题**。
- 如果图中有多道题，只在 "extraDetected" 里列出你看到的其他题号，不要把它们的内容写进 question。
- 如果图中根本没有题目（比如拍的是封面、目录、空白页），把 "isProblem" 设为 false。
`;

const RECOGNIZE_SYSTEM = `你是电动力学课程的助教，任务是**把学生拍来的题目照片转写成结构化文本**。

【你的唯一职责是"看"】
把照片上的内容如实转写出来。你不是在批改，也不是在解题。

【转写要求】
1. 题干（question）：原样转写。
2. 解答（solution）：如果照片上有解答（课本例题常自带），一并转写；没有就留空字符串。
3. 所有公式用 LaTeX：
   - 行内用 $...$，独立成行的用 $$...$$
   - 矢量用 \\mathbf{E}、\\mathbf{B}；偏导用 \\partial；求导用 \\frac{d}{dt}
   - 希腊字母、上下标、分式、根号、积分、矢量算符一律用标准 LaTeX
4. 一道题内部的段落、编号公式（如"式 (4.2-1)"）保留下来。
5. 图中若有明显的错别字或识别不清的地方，**照原样转写**，不要自行猜测修正，
   并在 uncertain 里列出你不确定的片段。

${SINGLE_PROBLEM_RULE}

【输出格式】
只输出一个 JSON 对象，不要任何解释、不要 Markdown 代码围栏：
{
  "isProblem": true,
  "no": "题号（如 4.3 / 例 4.2 / 第三题；找不到就留空字符串）",
  "question": "题干（LaTeX 公式用 $...$ 包起来）",
  "solution": "解答；没有就留空字符串",
  "uncertain": ["你不确定的地方，逐条说明；没有就空数组"],
  "extraDetected": ["图中还看到但本次忽略的其他题号；没有就空数组"]
}`;

/**
 * 把一张题目照片交给视觉模型，拿到结构化题目。
 *
 * @param {Buffer} buf 图片二进制
 * @param {object} [o]
 * @param {string} [o.mime] 图片 MIME，默认按 PNG 处理
 * @param {(m:string)=>void} [o.onProgress]
 * @param {number} [o.timeoutMs]
 * @returns {Promise<{isProblem:boolean, no:string, question:string, solution:string,
 *                    uncertain:string[], extraDetected:string[], model:string, imageBytes:number, elapsedMs:number}>}
 */
export async function recognizeProblem(buf, { mime = 'image/png', onProgress, timeoutMs = 90000 } = {}) {
  if (!buf?.length) throw new Error('图片内容为空');
  onProgress?.(`正在识别题目（${MODEL()}）…`);

  const key = requireEnv('GLM_API_KEY');
  const b64 = buf.toString('base64');
  const t0 = Date.now();

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(`${BASE()}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL(),
        stream: false,
        temperature: 0.1,      // 识别任务要的是稳定复现，不是创造性
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
            { type: 'text', text: RECOGNIZE_SYSTEM },
          ],
        }],
      }),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw new Error(`视觉模型请求超时（${timeoutMs / 1000}s）`);
    throw new Error(`视觉模型连接失败：${e.message}`);
  }

  if (!res.ok) {
    clearTimeout(timer);
    const txt = await res.text().catch(() => '');
    throw new Error(`视觉模型返回 ${res.status}：${txt.slice(0, 300)}`);
  }

  const json = await res.json();
  clearTimeout(timer);
  const raw = json.choices?.[0]?.message?.content ?? '';
  if (!raw.trim()) throw new Error('视觉模型返回了空内容，请重试。');

  const parsed = parseJsonLoose(raw);
  if (!parsed) {
    // 解析不出来时不要丢掉识别结果——把原文当成题干，标为不确定
    return {
      isProblem: true,
      no: '',
      question: raw.trim(),
      solution: '',
      uncertain: ['模型未按 JSON 格式返回，以下为原始输出，请人工核对'],
      extraDetected: [],
      model: MODEL(),
      imageBytes: buf.length,
      elapsedMs: Date.now() - t0,
      degraded: true,
    };
  }

  return {
    isProblem: parsed.isProblem !== false,
    no: String(parsed.no ?? '').trim(),
    question: String(parsed.question ?? '').trim(),
    solution: String(parsed.solution ?? '').trim(),
    uncertain: Array.isArray(parsed.uncertain) ? parsed.uncertain.filter(Boolean).map(String) : [],
    extraDetected: Array.isArray(parsed.extraDetected) ? parsed.extraDetected.filter(Boolean).map(String) : [],
    model: MODEL(),
    imageBytes: buf.length,
    elapsedMs: Date.now() - t0,
  };
}

/** 宽松 JSON 解析：模型偶尔裹一层 ```json 围栏或前后带话 */
export function parseJsonLoose(text) {
  let s = String(text ?? '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  try { return JSON.parse(s); } catch { /* 继续 */ }
  const i = s.indexOf('{');
  const j = s.lastIndexOf('}');
  if (i >= 0 && j > i) {
    try { return JSON.parse(s.slice(i, j + 1)); } catch { /* 放弃 */ }
  }
  return null;
}
