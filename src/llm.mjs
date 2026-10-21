/**
 * GLM（智谱）流式对话客户端
 * ------------------------------------------------------------------
 * 本项目只使用 GLM 作为对话模型（不使用其他模型）。
 *
 * GLM-5.3 是推理模型，返回里有两个字段，务必分清：
 *   delta.reasoning_content  思考过程——不是答案，不要当正文
 *   delta.content            正式回答
 * 实测中推理内容可能很长，若混进正文会严重污染输出。
 */

import { requireEnv } from './env.mjs';

const BASE = () => process.env.GLM_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4';
const MODEL = () => process.env.GLM_MODEL || 'glm-5.3-flash';

export function llmInfo() {
  return { base: BASE(), model: MODEL(), hasKey: !!process.env.GLM_API_KEY };
}

/**
 * 流式对话
 * @param {object} o
 * @param {string} o.system 系统提示词
 * @param {Array<{role:string,content:string}>} o.messages 对话历史（不含 system）
 * @param {(t:string)=>void} o.onContent 正文增量
 * @param {(t:string)=>void} [o.onReasoning] 思考增量
 * @param {number} [o.timeoutMs]
 * @returns {Promise<{content:string, reasoning:string, usage:any, finishReason:string}>}
 */
export async function streamChat({
  system, messages, onContent, onReasoning, timeoutMs = 180000, temperature = 0.6,
}) {
  const key = requireEnv('GLM_API_KEY');
  const url = `${BASE()}/chat/completions`;

  const body = {
    model: MODEL(),
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      ...messages,
    ],
    stream: true,
    temperature,
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw new Error(`GLM 请求超时（${timeoutMs / 1000}s）`);
    throw new Error(`GLM 连接失败：${e.message}`);
  }

  if (!res.ok) {
    clearTimeout(timer);
    const txt = await res.text().catch(() => '');
    throw new Error(`GLM 返回 ${res.status}：${txt.slice(0, 300)}`);
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let content = '';
  let reasoning = '';
  let usage = null;
  let finishReason = '';

  function handleChunk(chunk) {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;

      let ev;
      try { ev = JSON.parse(payload); } catch { continue; }

      if (ev.usage) usage = ev.usage;
      const choice = ev.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;

      const d = choice.delta ?? {};
      if (d.reasoning_content) {
        reasoning += d.reasoning_content;
        onReasoning?.(d.reasoning_content);
      }
      if (d.content) {
        content += d.content;
        onContent?.(d.content);
      }
    }
  }

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      handleChunk(dec.decode(value, { stream: true }));
    }
    handleChunk(dec.decode());
  } finally {
    clearTimeout(timer);
  }

  if (!content.trim()) {
    throw new Error(
      reasoning.trim()
        ? 'GLM 只返回了思考内容、没有正式回答。请重试，或调低 temperature。'
        : 'GLM 返回了空内容。'
    );
  }

  return { content, reasoning, usage, finishReason };
}

/** 非流式调用，供简单场景（连通性自检等）使用 */
export async function chat({ system, messages, timeoutMs = 60000, temperature = 0.6 }) {
  const key = requireEnv('GLM_API_KEY');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE()}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL(),
        messages: [...(system ? [{ role: 'system', content: system }] : []), ...messages],
        stream: false,
        temperature,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`GLM 返回 ${res.status}：${t.slice(0, 300)}`);
    }
    const json = await res.json();
    const m = json.choices?.[0]?.message ?? {};
    return {
      content: m.content ?? '',
      reasoning: m.reasoning_content ?? '',
      usage: json.usage ?? null,
    };
  } finally {
    clearTimeout(timer);
  }
}
