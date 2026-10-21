/**
 * MinerU 鉴权自检
 *   node scripts/check-mineru.mjs
 */
import { checkAuth } from '../src/mineru.mjs';
import { maskKey, envInfo } from '../src/env.mjs';

const key = process.env.MINERU_API_KEY;
console.log('\n──── MinerU 配置 ────');
console.log(`配置文件   ${envInfo.envPath}`);
console.log(`接口地址   ${process.env.MINERU_BASE_URL || 'https://mineru.net/api/v4'}`);
console.log(`密钥       ${key ? maskKey(key) : '（未配置）'}`);

if (!key) { console.log('\n✗ 未配置密钥\n'); process.exit(1); }

console.log('\n──── 鉴权验证（申请上传链接）────');
try {
  const r = await checkAuth();
  console.log(`${r.ok ? '✓' : '✗'} ${r.msg}`);
  console.log(r.ok
    ? '\nMinerU 可用。后续可用于：教材 PDF → 结构化 Markdown 导入、试卷扫描件解析。\n'
    : '');
  process.exit(r.ok ? 0 : 1);
} catch (e) {
  console.log(`✗ 请求异常：${e.message}\n`);
  process.exit(1);
}
