/**
 * Kuzu 访问层
 * ------------------------------------------------------------------
 * 踩坑记录（都验证过，别凭直觉改）：
 *  1. API 是「全异步」的：`conn.query()` 返回 QueryResult，但 `getNext()` /
 *     `getColumnNames()` 返回的都是 Promise，必须 await。直接
 *     JSON.stringify(result.getAll()) 会得到 "{}"，因为那是个未 await 的 Promise。
 *  2. `await result.getAll()` 是取数最省事的方式，返回普通对象数组。
 *  3. 库文件路径必须纯 ASCII（见 config.mjs），且**父目录必须已存在**。
 *  4. 只有「路径」受窄字符限制，节点属性里的中文没问题。
 *  5. **同一个库文件只能打开一个 `Database` 实例**（单写者，违反会报
 *     `Could not set lock on file`）。所以统一走下面的 `getDb()` 单例；
 *     需要并发就在同一个 Database 上多开 `Connection`，不要再 openDb 一次。
 */

import kuzu from 'kuzu';
import fs from 'node:fs';
import { DB_PATH, DB_ROOT } from './config.mjs';

/** Cypher DDL —— 建库脚本与校验脚本共用，保持单一事实来源 */
export const SCHEMA = {
  nodeTables: [
    `CREATE NODE TABLE IF NOT EXISTS Chapter(
       id STRING, no STRING, title STRING, summary STRING,
       PRIMARY KEY(id))`,

    `CREATE NODE TABLE IF NOT EXISTS Section(
       id STRING, chapterId STRING, no STRING, title STRING, summary STRING,
       PRIMARY KEY(id))`,

    `CREATE NODE TABLE IF NOT EXISTS KnowledgePoint(
       id STRING, name STRING, sectionId STRING, chapterId STRING,
       kind STRING, definition STRING, keyPoints STRING,
       textbookRef STRING, difficulty STRING,
       PRIMARY KEY(id))`,

    `CREATE NODE TABLE IF NOT EXISTS Formula(
       id STRING, name STRING, latex STRING, kpId STRING, note STRING,
       PRIMARY KEY(id))`,
  ],

  relTables: [
    `CREATE REL TABLE IF NOT EXISTS HAS_SECTION(FROM Chapter TO Section)`,
    `CREATE REL TABLE IF NOT EXISTS HAS_POINT(FROM Section TO KnowledgePoint)`,
    /** a 是先修，b 是后继： (a)-[:PREREQUISITE_OF]->(b) */
    `CREATE REL TABLE IF NOT EXISTS PREREQUISITE_OF(
       FROM KnowledgePoint TO KnowledgePoint, strength STRING, reason STRING)`,
    /** 相关但非先修：互为参照、易混淆、同一物理图像的不同表述 */
    `CREATE REL TABLE IF NOT EXISTS RELATES_TO(
       FROM KnowledgePoint TO KnowledgePoint, kind STRING, note STRING)`,
    `CREATE REL TABLE IF NOT EXISTS HAS_FORMULA(FROM KnowledgePoint TO Formula)`,
  ],
};

/** 打开数据库（父目录不存在则先建好——Kuzu 不会自建） */
export function openDb(dbPath = DB_PATH) {
  if (!/^[\x00-\x7F]+$/.test(dbPath)) {
    throw new Error(
      `Kuzu 库路径含非 ASCII 字符，原生层打不开：${dbPath}\n` +
      `请把库文件放到纯 ASCII 目录（默认 ${DB_ROOT}），或设置环境变量 EM_KUZU_DIR。`
    );
  }
  fs.mkdirSync(require_dirname(dbPath), { recursive: true });
  const db = new kuzu.Database(dbPath);
  const conn = new kuzu.Connection(db);
  return { db, conn };
}

function require_dirname(p) {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i > 0 ? p.slice(0, i) : '.';
}

/* ------------------------- 单例访问 ------------------------- */

let _db = null;
let _conn = null;
let _dbPath = null;

/**
 * 取全局唯一的 Database / Connection。
 * 整个进程只能有一条 Database 句柄，重复 open 同一个文件会被锁拒绝。
 */
export function getDb(dbPath = DB_PATH) {
  if (_db && _dbPath === dbPath) {
    return { db: _db, conn: _conn, fresh: false };
  }
  if (_db) closeDb();
  const opened = openDb(dbPath);
  _db = opened.db;
  _conn = opened.conn;
  _dbPath = dbPath;
  return { db: _db, conn: _conn, fresh: true };
}

export function getConn(dbPath = DB_PATH) {
  return getDb(dbPath).conn;
}

export function closeDb() {
  try { _conn?.close?.(); } catch { /* ignore */ }
  try { _db?.close?.(); } catch { /* ignore */ }
  _db = null; _conn = null; _dbPath = null;
}

/**
 * 取多行：唯一推荐的取数入口。
 *
 * 注意 `conn.query()` 的第二个位置参数是 progressCallback 而**不是**查询参数，
 * 传对象进去会报 "progressCallback must be a function"。
 * 要带参数必须走 prepare + execute（顺带也解决了 LaTeX 反斜杠的转义问题）。
 */
export async function rows(conn, cypher, params) {
  if (params === undefined) {
    const res = await conn.query(cypher);
    return (await res.getAll()) ?? [];
  }
  const stmt = await conn.prepare(cypher);
  const res = await conn.execute(stmt, params);
  if (!res || typeof res.getAll !== 'function') return [];
  return (await res.getAll()) ?? [];
}

/** 取单行（无结果返回 null） */
export async function row(conn, cypher, params) {
  const r = await rows(conn, cypher, params);
  return r.length ? r[0] : null;
}

/** 取标量（第一行第一列） */
export async function scalar(conn, cypher, params) {
  const r = await rows(conn, cypher, params);
  if (!r.length) return null;
  return r[0][Object.keys(r[0])[0]];
}

/** 建表（幂等） */
export async function initSchema(conn) {
  for (const ddl of SCHEMA.nodeTables) await conn.query(ddl);
  for (const ddl of SCHEMA.relTables) await conn.query(ddl);
}

/** 全部表名（删除时须先关系后节点，顺序不能反） */
export const TABLE_NAMES = {
  rel: SCHEMA.relTables.map((d) => d.match(/TABLE IF NOT EXISTS\s+(\w+)/)[1]),
  node: SCHEMA.nodeTables.map((d) => d.match(/TABLE IF NOT EXISTS\s+(\w+)/)[1]),
};

/**
 * 重建 schema：先删关系表再删节点表，然后重新建表。
 *
 * 为什么不直接删库文件？运行环境的 fs 删除接口被安全策略接管为"移入回收站"，
 * 在数据目录上会失败。走 DROP TABLE 既避免了这个坑，又保证脚本可重复执行。
 */
export async function resetSchema(conn) {
  for (const t of TABLE_NAMES.rel) {
    try { await conn.query(`DROP TABLE IF EXISTS ${t}`); } catch { /* 表不存在 */ }
  }
  for (const t of TABLE_NAMES.node) {
    try { await conn.query(`DROP TABLE IF EXISTS ${t}`); } catch { /* 表不存在 */ }
  }
  await initSchema(conn);
}

/** 尝试删除库文件（失败不报错——环境可能拦截删除，改用 resetSchema 即可） */
export function resetDbFiles(dbPath = DB_PATH) {
  const removed = [];
  for (const f of [dbPath, `${dbPath}.wal`, `${dbPath}.lock`, `${dbPath}.tmp`]) {
    if (!fs.existsSync(f)) continue;
    try { fs.rmSync(f, { force: true }); removed.push(f); } catch { /* 被拦截，忽略 */ }
  }
  return removed;
}

export { kuzu };
