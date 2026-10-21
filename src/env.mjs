/**
 * .env 加载器
 * ------------------------------------------------------------------
 * 不引入 dotenv 依赖，自己解析即可。
 * 规则：已存在的环境变量优先（方便临时覆盖，如 GLM_MODEL=xxx npm start）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const envPath = path.join(ROOT, '.env');
let loaded = 0;

if (fs.existsSync(envPath)) {
  const text = fs.readFileSync(envPath, 'utf8');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key && process.env[key] === undefined) {
      process.env[key] = val;
      loaded++;
    }
  }
}

export const envInfo = { envPath, exists: fs.existsSync(envPath), loaded };

/** 取必填环境变量，缺失时抛出可读的错误（而不是让 undefined 静默传下去） */
export function requireEnv(key) {
  const v = process.env[key];
  if (!v) {
    throw new Error(
      `缺少环境变量 ${key}。请在 ${envPath} 中配置，或通过环境变量传入。`
    );
  }
  return v;
}

/** 打码显示，避免密钥进日志 */
export function maskKey(v) {
  const s = String(v ?? '');
  if (s.length <= 10) return '***';
  return s.slice(0, 6) + '****' + s.slice(-4);
}
