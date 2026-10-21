/**
 * 一键启动
 * ------------------------------------------------------------------
 *   1. 检查 Kuzu 库是否可用、是否已有数据
 *   2. 若为空则自动执行入库（幂等，可反复跑）
 *   3. 载入服务
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DB_PATH, ROOT } from '../src/config.mjs';
import { getDb, rows, closeDb } from '../src/kuzu.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function needsIngest() {
  try {
    const { conn } = getDb();
    const r = await rows(conn, 'MATCH (k:KnowledgePoint) RETURN count(k) AS n');
    const n = r[0]?.n ?? 0;
    return n === 0;
  } catch (e) {
    console.log(`[start] 库暂不可用（${e.message.split('\n')[0]}），将执行入库`);
    return true;
  }
}

function runNode(script) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(__dirname, script)], {
      cwd: ROOT, stdio: 'inherit',
    });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${script} 退出码 ${code}`))));
  });
}

const empty = await needsIngest();

// ⚠️ 关键：无论是否要建库，都必须先释放本进程的数据库句柄。
// needsIngest() 会打开库做一次计数查询，而 Kuzu 是单写者——
// 若这里不 closeDb()，紧接着 spawn 出去的服务子进程就会撞上
// "Could not set lock on file"，表现为「服务起不来」。
closeDb();

if (empty) {
  console.log('[start] 图谱为空，先执行入库…\n');
  await runNode('ingest.mjs');
  console.log('');
}

console.log(`[start] 库文件：${DB_PATH}`);
console.log('[start] 启动服务…\n');
await runNode('../src/server.mjs');
