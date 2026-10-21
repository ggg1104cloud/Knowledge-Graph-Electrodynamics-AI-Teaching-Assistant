/**
 * 页面空白诊断
 *   node scripts/debug-blank-hw.mjs      （或 npm run debug:ui）
 *
 * 用途：用户报告"切到某个 tab 什么都不显示"时，先跑这个，区分是
 *   (a) 页面代码有 bug —— 脚本会报出具体错误行
 *   (b) 浏览器缓存了旧页面 —— 脚本一切正常，说明服务端没问题
 *
 * 做法：连真实服务器拿首页 HTML，在 jsdom 里执行全部 <script>，
 * 然后逐个点击 tab，检查 pane 的 class/display 与内容长度。
 *
 * 依赖 jsdom（仅诊断用，不在 package.json 里，避免拖累正常安装）：
 *   npm i --no-save jsdom
 */
let JSDOM, VirtualConsole;
try {
  ({ JSDOM, VirtualConsole } = await import('jsdom'));
} catch {
  console.error('缺少 jsdom。请先执行：  npm i --no-save jsdom');
  process.exit(2);
}

const BASE = process.env.BASE || 'http://localhost:3200';
let html;
try {
  const res = await fetch(BASE + '/', { signal: AbortSignal.timeout(5000) });
  html = await res.text();
} catch (e) {
  console.error(`连不上 ${BASE}（${e.cause?.code || e.name}）。先启动服务：npm start`);
  process.exit(2);
}
console.log('[1] 首页 HTML 长度:', html.length);

const errors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (e) => errors.push('jsdomError: ' + e.message));
virtualConsole.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));

const dom = new JSDOM(html, {
  url: BASE + '/',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
});
const { window } = dom;

window.onerror = (msg, src, line, col) => {
  errors.push(`onerror: ${msg} @${line}:${col}`);
  return false;
};
window.addEventListener('unhandledrejection', (e) => errors.push('unhandledrejection: ' + e.reason));

// ---- 最小浏览器桩 ----
// canvas 2d 桩（checkImageQuality 用，但初始化也可能碰）
const ctxStub = new Proxy({}, {
  get: (t, k) => {
    if (k === 'getImageData') return (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4).fill(128), width: w, height: h });
    if (k === 'measureText') return () => ({ width: 10 });
    return () => undefined;
  },
  set: () => true,
});
window.HTMLCanvasElement.prototype.getContext = () => ctxStub;
window.scrollTo = () => {};
if (!window.fetch) window.fetch = (u, o) => fetch(new URL(u, BASE), o);

// 把页面所有 <script> 块拿出来在 jsdom 里按序执行
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
if (!scripts.length) { console.log('!! 没找到 <script> 块'); process.exit(1); }
console.log('[2] script 块数:', scripts.length, '总长度:', scripts.reduce((a, s) => a + s.length, 0));

scripts.forEach((code, i) => {
  try {
    window.eval(code);
    console.log(`[3.${i}] script #${i} 执行: OK`);
  } catch (e) {
    console.log(`[3.${i}] script #${i} 执行抛错:`, e.message);
  }
});

// 等微任务（health fetch 等异步）
await new Promise((r) => setTimeout(r, 1500));
console.log('[4] 初始化阶段错误:', errors.length ? errors : '无');
let bootErrors = errors.length;
errors.length = 0;

// 逐个 tab 点击，检查 pane 是否真的显示、内容是否为空
const doc = window.document;
const names = [...doc.querySelectorAll('.tab')].map((t) => t.dataset.pane);
console.log('[5] 页面 tab 列表:', names.join(', '));

let blank = [];
for (const name of names) {
  const tab = doc.querySelector(`.tab[data-pane="${name}"]`);
  if (!tab) { console.log(`    tab ${name}: !! 不存在`); continue; }
  tab.click();
  await new Promise((r) => setTimeout(r, 200));
  const p = doc.getElementById('pane-' + name);
  const display = p ? window.getComputedStyle(p).display : '-';
  const len = p ? p.innerHTML.length : 0;
  const bad = !p || display === 'none' || len < 50;
  if (bad) blank.push(name);
  console.log(`    tab ${name}: display=${display} 内容=${len} 字符 ${bad ? '  <-- 空白!' : ''}`);
}

console.log('[6] 切换过程错误:', errors.length ? errors : '无');
console.log('[7]', blank.length ? `空白 tab: ${blank.join(', ')}` : '全部 tab 正常');

// 结论
const ok = bootErrors === 0 && errors.length === 0 && blank.length === 0;
console.log('\n========== 结论 ==========');
if (ok) {
  console.log('服务端页面代码正常。若浏览器里仍空白，按顺序排查：');
  console.log('  1. 看状态栏末尾的 build 号。没有 build 号 = 浏览器跑的是旧缓存页面，Ctrl+F5。');
  console.log('  2. 看浏览器窗口宽度。窄窗口曾导致三栏 grid 横向溢出、右侧面板被推出可视区而"一片空白"');
  console.log('     （已在 CSS 里加 @media 逐级退让修正）。用截图脚本按目标宽度复现最快。');
  console.log('  3. 页面顶部的红色错误条会直接显示 JS 崩溃原因 —— 有红条就以它为准。');
} else {
  console.log('页面代码存在问题，看上方的错误与空白 tab 明细。');
}
process.exit(ok ? 0 : 1);
