/**
 * 句子级溯源解析
 * ------------------------------------------------------------------
 * 把模型输出切成句子，逐句判定依据来源，并**校验节点 ID 是否真实存在**。
 *
 * 这是全站可信度的关口：
 *   模型编造一个不存在的节点 ID → 该句降级为无效引用，绝不放行。
 */

const CITE_RE = /\[\[(KG|TXT|WEB):([^\]|]+)(?:\|([^\]]*))?\]\]/g;

/**
 * 切句：中英文标点都认，同时不破坏 LaTeX 公式内部。
 *
 * 三个必须处理的 Markdown 噪声，否则会严重拉低「依据覆盖率」这个指标：
 *   1. 标题行（# / ## / ###…）—— 是结构标签，不是论断，直接丢弃
 *   2. 列表序号（"1." / "-" / "•"）—— 与紧随其后的正文合并，不要单独成句
 *   3. 纯符号行 —— 丢弃
 */
export function splitSentences(text) {
  if (!text) return [];
  const out = [];
  let buf = '';
  let inMath = false;
  let mathDelim = null;

  const flush = (force = false) => {
    const raw = buf;
    buf = '';
    const t = raw.trim();
    if (!t) return;

    // 标题：丢弃
    if (/^#{1,6}\s/.test(t)) return;
    // 纯列表序号 / 纯符号：留着，与下一段正文合并
    if (/^(\d+[.、)）]|[-*•+]|>)$/.test(t) || !/[\u4e00-\u9fa5a-zA-Z0-9]/.test(t)) {
      if (!force) { buf = raw; return; }
      return;
    }
    out.push(t);
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    // 跟踪 LaTeX 数学环境，公式内的标点不切
    if (!inMath && ch === '$') {
      inMath = true;
      mathDelim = next === '$' ? '$$' : '$';
      buf += ch;
      continue;
    }
    if (inMath) {
      buf += ch;
      if (ch === '$' && (mathDelim === '$' || next === '$')) {
        if (mathDelim === '$$' && next === '$') { buf += next; i++; }
        inMath = false;
        mathDelim = null;
      }
      continue;
    }

    buf += ch;

    if (ch === '\n') {
      // 换行处：如果当前缓冲只是列表序号，先留着，等正文来了再合并
      const t = buf.trim();
      if (/^(\d+[.、)）]|[-*•+])$/.test(t)) continue;
      flush();
      continue;
    }

    if (ch === '。' || ch === '！' || ch === '？') {
      flush();
      continue;
    }

    // 英文句点：前面是纯数字的属于列表序号，不当作句末
    if (ch === '.' && next !== undefined && /[\s\n]/.test(next)) {
      const before = buf.slice(0, -1).trim();
      if (/^\d+$/.test(before)) continue;      // "1." 列表序号
      if (/^#{1,6}\s\S*$/.test(before)) continue; // 标题
      flush();
    }
  }
  const tail = buf.trim();
  buf = tail;
  flush(true);

  return out;
}

/**
 * 解析引用
 * @param {string} text 模型原始输出
 * @param {(id:string)=>boolean} hasNode 节点存在性校验函数
 */
export function parseCitations(text, hasNode = () => true) {
  const sentences = splitSentences(text);

  const segments = sentences.map((raw, idx) => {
    const citations = [];
    let cleaned = raw;

    // 先收集本句所有引用
    CITE_RE.lastIndex = 0;
    let m;
    while ((m = CITE_RE.exec(raw)) !== null) {
      const [, kind, id, label] = m;
      citations.push({
        kind,                        // KG | TXT | WEB
        nodeId: id.trim(),
        label: (label ?? '').trim(),
        valid: kind === 'WEB' ? true : hasNode(id.trim()),
      });
    }

    // 从展示文本中去掉标记
    cleaned = raw.replace(CITE_RE, '').replace(/\s{2,}/g, ' ').trim();

    const valid = citations.filter((c) => c.valid);
    const invalid = citations.filter((c) => !c.valid);

    const hasKg = valid.some((c) => c.kind === 'KG');
    const hasTxt = valid.some((c) => c.kind === 'TXT');
    const hasWeb = valid.some((c) => c.kind === 'WEB');

    let source;
    if (hasKg) source = 'graph';
    else if (hasTxt) source = 'textbook';
    else if (hasWeb) source = 'web';
    else source = 'inferred';

    return {
      index: idx,
      text: cleaned,
      raw,
      source,           // graph | textbook | web | inferred
      citations,
      invalidCitations: invalid,
      nodeIds: [...new Set(valid.map((c) => c.nodeId))],
    };
  }).filter((s) => s.text.length > 0);

  return segments;
}

/** 统计依据覆盖率 */
export function summarizeProvenance(segments) {
  const total = segments.length;
  const grounded = segments.filter((s) => s.source === 'graph').length;
  const textbook = segments.filter((s) => s.source === 'textbook').length;
  const web = segments.filter((s) => s.source === 'web').length;
  const inferred = segments.filter((s) => s.source === 'inferred').length;
  const invalid = segments.reduce((a, s) => a + s.invalidCitations.length, 0);
  const nodeIds = [...new Set(segments.flatMap((s) => s.nodeIds))];
  const coverage = total ? Math.round(((grounded + textbook + web) / total) * 1000) / 10 : 0;

  return {
    total, grounded, textbook, web, inferred, invalid, nodeIds, coverage,
  };
}
