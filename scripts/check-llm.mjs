/**
 * GLM 连通性自检
 *   node scripts/check-llm.mjs
 */
import { llmInfo, chat, streamChat } from '../src/llm.mjs';
import { envInfo, maskKey } from '../src/env.mjs';

const info = llmInfo();
console.log('\n──── GLM 配置 ────');
console.log(`配置文件   ${envInfo.path ?? envInfo.envPath}  ${envInfo.exists ? '（已加载 ' + envInfo.loaded + ' 项）' : '（不存在）'}`);
console.log(`接口地址   ${info.base}`);
console.log(`模型       ${info.model}`);
console.log(`密钥       ${info.hasKey ? maskKey(process.env.GLM_API_KEY) : '（未配置）'}`);

if (!info.hasKey) { console.log('\n✗ 未配置密钥\n'); process.exit(1); }

console.log('\n──── 非流式调用 ────');
const t0 = Date.now();
try {
  const r = await chat({
    system: '你是电动力学助教，回答简洁。',
    messages: [{ role: 'user', content: '用一句话说明什么是位移电流。' }],
  });
  console.log(`✓ ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`  正文：${r.content.slice(0, 150)}`);
  console.log(`  思考：${r.reasoning.length} 字（推理模型，已与正文分离）`);
} catch (e) {
  console.log(`✗ ${e.message}`);
}

console.log('\n──── 流式调用 ────');
const t1 = Date.now();
let first = null, n = 0, reasoningN = 0;
try {
  const r = await streamChat({
    system: '你是电动力学助教，回答简洁。',
    messages: [{ role: 'user', content: '麦克斯韦方程组有哪几个方程？只列名称。' }],
    onContent: (t) => { if (!first) first = Date.now(); n++; },
    onReasoning: (t) => { reasoningN += t.length; },
  });
  console.log(`✓ 总耗时 ${((Date.now() - t1) / 1000).toFixed(1)}s ｜ 首字 ${first ? ((first - t1) / 1000).toFixed(1) + 's' : '—'}`);
  console.log(`  分片 ${n} 个 ｜ 正文 ${r.content.length} 字 ｜ 思考 ${reasoningN} 字`);
  console.log(`  tokens：${JSON.stringify(r.usage)}`);
  console.log(`  正文：${r.content.slice(0, 200)}`);
} catch (e) {
  console.log(`✗ ${e.message}`);
  process.exit(1);
}
console.log();
