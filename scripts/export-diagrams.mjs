/**
 * 把 docs/diagrams/*.svg 导出成 2 倍分辨率的 PNG（2560×1440），供 PPT / 文档使用。
 *
 * 做法：为每张 SVG 生成一个临时 HTML（把 SVG 铺满 2560×1440），
 * 再用本机已装的 Edge 无头模式截图 —— 这样不需要装任何图像库。
 *
 * 用法：
 *   node scripts/export-diagrams.mjs                # 导出全部
 *   node scripts/export-diagrams.mjs 07 08          # 只导出文件名含 07 / 08 的
 *
 * 注意：
 *   - 只能导出 docs/diagrams/ 下的 SVG（PNG 落在 docs/diagrams/png/）。
 *   - 若 Edge 正在运行也没关系：用独立的 user-data-dir，不打扰用户会话。
 *   - 出现在 SVG 里的中文字体由系统提供，Windows 上 Microsoft YaHei 一定在。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DIAGRAM_DIR = path.join(ROOT, 'docs', 'diagrams');
const PNG_DIR = path.join(DIAGRAM_DIR, 'png');

const SCALE = 2;                 // 2 倍图
const BASE_W = 1280;
const BASE_H = 720;

const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/microsoft-edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

function findBrowser() {
  for (const p of EDGE_CANDIDATES) if (fs.existsSync(p)) return p;
  throw new Error('找不到可用的浏览器（Edge / Chrome / Chromium），无法导出 PNG');
}

/**
 * SVG 是 XML：正文里出现**未转义的 &** 会让整个文件解析失败。
 * 失败时浏览器只给一张空白图，PNG 体积会小得离谱（十几 KB），不报任何错。
 * 所以导出前先自查一遍，比事后看空白图省事得多。
 */
function checkXmlEntities(svgPath, svgName) {
  const src = fs.readFileSync(svgPath, 'utf8');
  const bad = [];
  const re = /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g;
  let m;
  while ((m = re.exec(src))) {
    const line = src.slice(0, m.index).split('\n').length;
    bad.push(`第 ${line} 行：${src.slice(m.index, m.index + 24).split('\n')[0]}`);
  }
  if (bad.length) {
    throw new Error(`${svgName} 有未转义的 & （XML 会解析失败，导出必为空白图）：\n     ` + bad.join('\n     '));
  }
}

function exportOne(browser, svgName, tmpDir) {
  const svgPath = path.join(DIAGRAM_DIR, svgName);
  checkXmlEntities(svgPath, svgName);
  const base = svgName.replace(/\.svg$/, '');
  const pngPath = path.join(PNG_DIR, `${base}.png`);

  const wrapper = path.join(DIAGRAM_DIR, `_export-${base}.html`);
  fs.writeFileSync(
    wrapper,
    `<!DOCTYPE html><html><head><meta charset="utf-8">`
      + `<style>html,body{margin:0;padding:0;background:#fff}img{display:block;width:${BASE_W * SCALE}px;height:${BASE_H * SCALE}px}</style>`
      + `</head><body><img src="${encodeURI(svgName)}"></body></html>`,
    'utf8',
  );

  try {
    execFileSync(
      browser,
      [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--no-first-run',
        '--no-default-browser-check',
        `--user-data-dir=${path.join(tmpDir, 'edge-profile')}`,
        `--screenshot=${pngPath}`,
        `--window-size=${BASE_W * SCALE},${BASE_H * SCALE}`,
        `file:///${wrapper.replace(/\\/g, '/')}`,
      ],
      { stdio: 'ignore', timeout: 90000 },
    );
  } finally {
    fs.rmSync(wrapper, { force: true });
  }

  const size = fs.statSync(pngPath).size;
  return { base, pngPath, size };
}

function main() {
  const filters = process.argv.slice(2);
  const all = fs.readdirSync(DIAGRAM_DIR).filter((f) => f.endsWith('.svg')).sort();
  const targets = filters.length
    ? all.filter((f) => filters.some((k) => f.includes(k)))
    : all;

  if (!targets.length) {
    console.log('没有匹配到任何 SVG。可选：\n  ' + all.join('\n  '));
    process.exit(1);
  }

  fs.mkdirSync(PNG_DIR, { recursive: true });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-diagrams-'));
  const browser = findBrowser();
  console.log(`浏览器：${browser}`);
  console.log(`导出 ${targets.length} 张（${BASE_W * SCALE}×${BASE_H * SCALE}）\n`);

  let ok = 0;
  const suspect = [];
  for (const svg of targets) {
    try {
      const r = exportOne(browser, svg, tmpDir);
      // 一张 2560×1440 的图只有几十 KB 时，多半是渲染失败后的空白图
      const blank = r.size < 30 * 1024;
      console.log(`  ${blank ? '?' : '✓'} ${r.base}.png  ${(r.size / 1024).toFixed(0)} KB`
        + (blank ? '   ← 体积异常小，可能导出了空白图，请打开确认' : ''));
      if (blank) suspect.push(r.base);
      ok += 1;
    } catch (e) {
      console.log(`  ✗ ${svg}\n     ${e.message.slice(0, 300)}`);
    }
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log(`\n完成 ${ok}/${targets.length}，输出目录：docs/diagrams/png/`);
  if (suspect.length) console.log(`⚠ 需人工确认：${suspect.join('、')}`);
  if (ok !== targets.length) process.exit(1);
}

main();
