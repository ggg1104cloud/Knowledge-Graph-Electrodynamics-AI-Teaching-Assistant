/**
 * 全局配置与路径解析
 * ------------------------------------------------------------------
 * 路径策略（重要，别改）：
 * Kuzu 的原生层用「窄字符」API 处理文件路径（Windows 上等同 ANSI 代码页），
 * 而本项目所在的目录名含中文（桌面 / AI错题智能体）。实测直接报：
 *   No mapping for the Unicode character exists in the target multi-byte code page.
 * 所以 **Kuzu 库文件必须放在纯 ASCII 路径下**。
 *
 * 职责划分：
 *   - 图谱「源数据」(data/*.json) 属于可版本管理的资产，放在项目内；
 *   - Kuzu 库文件是从源数据派生出来的「编译产物」，放 %LOCALAPPDATA%\em-tutor\，
 *     随时可用 `npm run ingest` 重建。
 *
 * 注意：只有「文件路径」受限，节点/关系里的中文「内容」完全正常。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
// 先加载 .env，后面读 process.env 才拿得到值
import './env.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 图谱源数据目录（允许含中文路径，仅由 Node 的 UTF-8 fs 读取） */
export const DATA_DIR = path.join(ROOT, 'data');

/** Kuzu 库文件的递归父目录：优先 ASCII 的 LOCALAPPDATA，退回 TEMP */
function resolveDbRoot() {
  const candidates = [
    process.env.EM_KUZU_DIR,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'em-tutor') : null,
    path.join(os.tmpdir(), 'em-tutor'),
  ].filter(Boolean);

  for (const c of candidates) {
    // 硬约束：路径必须是纯 ASCII，否则 Kuzu 打不开文件
    if (!/^[\x00-\x7F]+$/.test(c)) continue;
    try {
      fs.mkdirSync(c, { recursive: true }); // Kuzu 不会自建父目录，必须提前建好
      return c;
    } catch {
      /* 试下一个候选 */
    }
  }
  throw new Error('找不到可写的纯 ASCII 数据目录，请设置环境变量 EM_KUZU_DIR');
}

export const DB_ROOT = resolveDbRoot();
export const DB_PATH = path.join(DB_ROOT, 'em.db').replace(/\\/g, '/');

/** 源数据文件 */
export const FILES = {
  chapters: path.join(DATA_DIR, 'graph-a-chapters.json'),
  prereq: path.join(DATA_DIR, 'graph-b-prerequisites.json'),
  points: path.join(DATA_DIR, 'knowledge-points.json'),
  /** 边类型词表（SKOS 对齐）：把关系类型从代码里解放出来 */
  edgeTypes: path.join(DATA_DIR, 'edge-types.json'),
  /** Graph C 数学推导图：回答「这个概念是怎么来的」，允许成环 */
  graphC: path.join(DATA_DIR, 'graph-c-derivation.json'),
};

/** 学科元信息 */
export const SUBJECT = {
  name: '电动力学',
  course: 'Electrodynamics',
  /** 权威骨架来源 */
  syllabusSource: '国家高等教育智慧教育平台《电动力学》（北京交通大学 王健，中国大学MOOC）',
  /** 教材对齐 */
  textbook: '郭硕鸿《电动力学》（高等教育出版社，第三版）',
};

/** 掌握度三色阈值，与智卷保持一致 */
export const MASTERY_THRESHOLD = { mastered: 85, consolidating: 60 };

export function describeConfig() {
  return {
    root: ROOT,
    dataDir: DATA_DIR,
    dbRoot: DB_ROOT,
    dbPath: DB_PATH,
    asciiSafe: /^[\x00-\x7F]+$/.test(DB_PATH),
  };
}
