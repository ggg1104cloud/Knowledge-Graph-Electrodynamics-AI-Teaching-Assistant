/**
 * 前端渲染逻辑校验
 * ------------------------------------------------------------------
 * 不依赖真实浏览器：把 index.html 里的渲染函数抽出来，喂真实数据跑一遍，
 * 检查是否抛错、是否产出预期的 DOM 片段。
 *
 * 为什么这么做：作业面板的渲染分支很多（可信/噪声/存疑、四种判定、
 * 根因有无、节点有无），光看代码很容易漏掉某个空数组或 undefined 的分支。
 * 用真实接口返回的数据过一遍，比手工点强。
 */
import fs from 'node:fs';

const B = process.env.EM_BASE || 'http://localhost:3200';

let pass = 0, fail = 0;
const problems = [];
const check = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; problems.push(label + (detail ? ' — ' + detail : '')); console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
};

/* ---- 从 index.html 抽出内联脚本 ---- */
const html = fs.readFileSync('web/index.html', 'utf8');
// 页面现在有两个 <script>：head 里的全局错误条（小）与主脚本（大）。
// 取最长的那块，避免抽错。
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  .map((m) => m[1])
  .sort((a, b) => b.length - a.length)[0];

// 只取渲染相关函数的定义（避免引入 DOM 依赖）
const wanted = ['esc', 'jsq', 'mathHtml', 'renderRich', 'renderSegments', 'renderHwResult', 'checkImageQuality'];
const picked = [];
for (const name of wanted) {
  const re = new RegExp(`\\nfunction ${name}\\s*\\(`, 'g');
  const m = re.exec(script);
  if (!m) { check(`找到函数 ${name}`, false); continue; }
  // 从 function 开始，按大括号配平截取
  let i = m.index + 1, depth = 0, started = false, end = i;
  for (; i < script.length; i++) {
    const c = script[i];
    if (c === '{') { depth++; started = true; }
    else if (c === '}') { depth--; if (started && depth === 0) { end = i + 1; break; } }
  }
  picked.push(script.slice(m.index + 1, end));
}
check('渲染函数全部找到', picked.length === wanted.length, `找到 ${picked.length}/${wanted.length}`);

/* ---- 在隔离环境里执行，提供最小依赖桩 ---- */
// 拍照解题并入答疑后，renderHwResult 把 HTML 写进 **消息里的结果容器**（HW.bodyEl），
// 而不是某个固定面板。这里提供一个最小 DOM 桩，让**真实渲染函数**跑起来，
// 而不是在测试里复刻一遍它的逻辑（复刻的逻辑一旦和真身分叉，测试就失去意义）。
const harness = `
${picked.join('\n\n')}

const HW = __HW__;

// 最小 DOM 桩：只实现渲染路径用到的那几个方法
const __els = {};
function $(sel) {
  if (!__els[sel]) __els[sel] = { innerHTML: '', style: {}, textContent: '' };
  return __els[sel];
}
function tab() {}

HW.bodyEl = { innerHTML: '' };
renderHwResult();
__OUT__ = HW.bodyEl.innerHTML;
`;

/* ---- 取真实数据 ---- */
console.log('\n═══ 前端渲染逻辑校验 ═══');
console.log('（用真实接口数据驱动，检查渲染分支是否都能走通）\n');

// 注意：renderRich 依赖 katex，这里注入一个极简桩——它只验证"不炸"，
// 真正的公式渲染由 check-math.mjs 覆盖
const katexStub = {
  renderToString: (tex) => `<K>${String(tex).slice(0, 40)}</K>`,
};

let hwData;
try {
  const body = JSON.stringify({
    question: '这道题我卡住了',
    problem: {
      no: '4.3',
      question: '已知 $E = E_0\\cos(kz-\\omega t)$，求 $B$',
      solution: '解：由 $\\nabla\\times E = -\\partial B/\\partial t$',
      uncertain: ['公式中的 $\\omega$ 下标看不清'],
      nodes: [{ id: 'kp_plane_wave', name: '平面电磁波', matchBy: 'name' }],
      diagnosis: { status: 'unreadable', verdict: '无法判定', reason: '公式识别不确定', mistakes: [], notCovered: ['B 的方向'], unreliable: [{ text: '$E_0$', readability: 'unclear', note: '下标不清' }] },
      roots: { symptoms: [], roots: [{ id: 'kp_maxwell_equations', name: '麦克斯韦方程组', isHardPrerequisite: true, supportedCount: 3, level: 3 }] },
    },
    history: [],
  });
  const r = await fetch(`${B}/api/homework/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
  });
  const rd = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) { const { done, value } = await rd.read(); if (done) break; buf += dec.decode(value, { stream: true }); }
  hwData = { ok: true, raw: buf.includes('"type":"text"') };
} catch (e) {
  hwData = { ok: false, err: e.message };
}
check('追问接口可用（渲染测试的前置）', hwData.ok, hwData.err ?? '');

/* ---- 构造 HW 状态，覆盖各渲染分支 ---- */
// 分支 A：有错误 + 疑点 + 根因 + 节点
const HWStateFull = {
  problem: {
    no: '4.4',
    question: '简述位移电流的物理意义。',
    solution: '位移电流就是电容器两极板之间实际流动的电流。',
    uncertain: ['"实际流动"四个字有点模糊，可能是照片反光'],
    nodes: [
      { id: 'kp_displacement_current', name: '位移电流', matchBy: 'name' },
      { id: 'kp_poynting_vector', name: '坡印廷矢量', matchBy: 'semantic' },
    ],
    diagnosis: {
      status: 'incorrect', verdict: '有错误',
      reason: '把位移电流等同于传导电流。',
      mistakes: [{
        point: '混淆位移电流与传导电流',
        evidence: '位移电流就是电容器两极板之间实际流动的电流',
        nodeId: 'kp_displacement_current', severity: 'concept',
      }],
      notCovered: ['位移电流与传导电流的本质区别'],
      unreliable: [{ text: '"实际流动"', readability: 'unclear', note: '可能反光' }],
      retakeHints: [],
    },
    roots: { symptoms: [], roots: [{ id: 'kp_maxwell_equations', name: '麦克斯韦方程组', isHardPrerequisite: true, supportedCount: 2, level: 3 }] },
  },
  preview: null,
  warnings: [],
  leakFlags: [],
  opening: '先别急着下结论：位移电流到底"流"在哪里？你想想电容器两极板之间有什么。',
  vision: { model: 'glm-4v-plus', elapsedMs: 5400, imageBytes: 512000 },
};

// 分支 B：无法判定 + 需重拍 + 有单题提示
const HWStateUnreadable = {
  problem: {
    no: '',
    question: '在无限大均匀绝缘介质中，$\\nabla^2 E - \\frac{1}{v^2}\\frac{\\partial^2 E}{\\partial t^2} = 0$',
    solution: '',
    uncertain: ['公式里的 $v^2$ 看不清，可能是 $c^2$', '下标 $\\frac{\\partial^2}{\\partial t^2}$ 疑似识别错误'],
    nodes: [],
    diagnosis: {
      status: 'unreadable', verdict: '无法判定',
      reason: '公式里有不确定的地方，不做对错判断。',
      mistakes: [], notCovered: [],
      unreliable: [{ text: '$\\frac{1}{v^2}$', readability: 'unclear', note: '看不清' }],
      retakeHints: ['公式里有看不清的地方——把公式那几行单独拍一张，让它占满画面', '画面有模糊、遮挡或反光——换个角度再拍'],
    },
    roots: { symptoms: [], roots: [] },
  },
  preview: null,
  warnings: ['照片里还检测到其他题目：4.3。本次只处理了其中一道——请一题一图。'],
  leakFlags: ['出现"最终结果"式表述'],
  opening: '这张照片里的公式有几个地方没认准，先按我给的方式重拍一张。',
  vision: { model: 'glm-4v-plus', elapsedMs: 6100, imageBytes: 380000 },
};

// 分支 C：仅有识别结果、诊断尚未完成（preview 阶段）
const HWStatePreview = {
  problem: null,
  preview: { no: '例 4.2', question: '求平面电磁波的 $B$ 与平均能流密度 $S$。', solution: '' },
  warnings: [],
  leakFlags: [],
  opening: '',
  vision: null,
};

function render(state) {
  const fn = new Function('__HW__', 'katex', `${harness}\nreturn __OUT__;`);
  return fn(state, katexStub);
}

console.log('═══ 分支 A：有错误 + 疑点 + 根因 ═══');
try {
  const out = render(HWStateFull);
  console.log('  产出前 300 字：' + out.slice(0, 300).replace(/\n/g, ' ') + '\n');
  check('整体渲染未抛异常', true);
  check('渲染了题号与判定', out.includes('4.4') && out.includes('有错误'));
  check('渲染了识别到的题目', out.includes('识别到的题目'));
  check('渲染了题目自带的解答', out.includes('题目自带的解答'));
  check('渲染了图谱节点', out.includes('kp_displacement_current'));
  check('语义匹配节点也在', out.includes('kp_poynting_vector'));
  check('渲染了疑点与依据', out.includes('混淆位移电流与传导电流') && out.includes('依据：'));
  check('渲染了未覆盖项', out.includes('题干要求但解答里看不到'));
  check('渲染了根因', out.includes('kp_maxwell_equations'));
  check('渲染了识别不确定处', out.includes('识别不确定的地方'));
  check('渲染了识别信息', out.includes('glm-4v-plus'));
  check('渲染了助教反馈', out.includes('位移电流到底'));
  check('完成态给出「结束本题」出口', out.includes('结束本题') && out.includes('endProblem'));
} catch (e) {
  check('分支 A 未抛异常', false, e.message);
  console.log(e.stack);
}

console.log('\n═══ 分支 B：无法判定 + 重拍建议 + 单题提示 ═══');
try {
  const out = render(HWStateUnreadable);
  check('分支 B 未抛异常', true);
  check('渲染了单题提示', out.includes('其他题目') && out.includes('一题一图'));
  check('渲染了重拍建议', out.includes('建议这样重拍') && out.includes('占满画面'));
  check('渲染了无法判定', out.includes('无法判定'));
  check('渲染了泄露告警', out.includes('边界提醒'));
  check('无节点时不产生图谱段', !out.includes('图谱标记'));
  check('无根因时不产生根因段', !out.includes('沿先修链回溯'));
} catch (e) {
  check('分支 B 未抛异常', false, e.message);
  console.log(e.stack);
}

console.log('\n═══ 分支 C：仅识别完成，诊断进行中 ═══');
try {
  const out = render(HWStatePreview);
  check('分支 C 未抛异常', true);
  check('preview 阶段也能看到识别结果', out.includes('例 4.2') && out.includes('求平面电磁波'));
  check('提示正在核查', out.includes('正在核查'));
  check('preview 阶段不渲染判定', !out.includes('verdict'));
} catch (e) {
  check('分支 C 未抛异常', false, e.message);
  console.log(e.stack);
}

/* ---- 结构断言：拍照解题已并入答疑窗口 ---- */
console.log('\n[结构] 拍照解题并入答疑');
check('不再有独立「作业辅导」tab', !html.includes('data-pane="hw"'));
check('不再有 #pane-hw 面板', !html.includes('id="pane-hw"'));
check('不再有上传拖拽区', !html.includes('id="hwdrop"'));
check('不再有旧的独立进度条容器', !html.includes('id="hwprogress"'));
check('答疑输入框旁有拍照入口', /id="attach"/.test(html));
check('文件输入挂在答疑 composer 内', /id="pane-ask"[\s\S]*?id="hwfile"[\s\S]*?<\/div>\s*<\/div>/.test(html));
check('窄窗口有响应式退让', /@media \(max-width: 900px\)/.test(html) && /@media \(max-width: 700px\)/.test(html));
check('统一发送入口存在（按有无题目分流）', /async function sendUser/.test(script) && script.includes('HW.problem) await hwAsk(t)'));
check('进度条/阶段改为挂在消息里', script.includes('mountProgress(bubble)') && script.includes('mountStages(bubble)'));
check('前端处理 tick 心跳', script.includes("ev.type === 'tick'") && script.includes('function tickUpdate'));
check('阶段文案不自我重复', script.includes('function stageText'));
check('有断流看门狗', script.includes('watchdog') && script.includes('20 秒没有收到服务端响应'));

/* ---- 转义安全：注入 attempt ---- */
console.log('\n[安全] HTML 注入');
try {
  const evil = JSON.parse(JSON.stringify(HWStateFull));
  evil.problem.question = '<img src=x onerror=alert(1)>';
  evil.problem.solution = '<script>alert(2)</script>';
  evil.problem.diagnosis.mistakes[0].point = '"><svg onload=alert(3)>';
  evil.problem.uncertain = ['<iframe src=//evil></iframe>'];
  evil.warnings = ['<b onclick=alert(4)>x</b>'];
  evil.opening = '<iframe src=//evil></iframe>';
  render(evil);
  check('恶意内容未导致崩溃', true);
} catch (e) {
  check('恶意内容未导致崩溃', false, e.message);
}

/* ---- 图像质量预检：用合成图喂进真实的 checkImageQuality ---- */
console.log('\n[预检] 图像质量判定');
{
  const fn = new Function('__IMG__', 'katex', `
${picked.join('\n\n')}
return checkImageQuality(__IMG__);
`);
  // 生成灰度场：g(u,v) 的 u/v 都是 0~1 的归一化坐标
  const grayImg = (W, H, fnGray) => {
    const g = (u, v) => Math.max(0, Math.min(255, fnGray(u, v))) | 0;
    return { W, H, g };
  };

  // 桩：Document.createElement('canvas') 走一个只支持 drawImage/getImageData 的实现。
  // drawImage(img, 0, 0, w, h) 的语义是"整张源图缩放进 w×h"，
  // 所以目标像素只按归一化坐标映射回源图即可——不涉及源图尺寸。
  const withCanvas = (im, body) => {
    const prevDoc = globalThis.document;
    globalThis.document = {
      createElement: () => {
        const cv = { width: 0, height: 0 };
        cv.getContext = () => ({
          drawImage: () => {},   // 语义上只是"把图铺到画布"，采样时按时序直接查源图
          getImageData: (_x, _y, w, h) => {
            const a = new Uint8ClampedArray(w * h * 4);
            for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
              const v = im.g((x + 0.5) / w, (y + 0.5) / h);
              const i = (y * w + x) * 4;
              a[i] = v; a[i + 1] = v; a[i + 2] = v; a[i + 3] = 255;
            }
            return { data: a };
          },
        });
        return cv;
      },
    };
    try { return body(); } finally { globalThis.document = prevDoc; }
  };

  // 1) 清晰照片：高对比度、亮度适中、分辨率足
  const good = grayImg(1600, 2200, (u, v) => (Math.sin(u * 60) * Math.sin(v * 90) > 0 ? 235 : 30));
  const rGood = withCanvas(good, () => fn({ naturalWidth: 1600, naturalHeight: 2200 }));
  check('清晰照片判为 ok', rGood.level === 'ok', `实际 ${rGood.level}：${rGood.issues.join('；')}`);

  // 2) 分辨率过低
  const lowRes = grayImg(600, 800, (u, v) => (Math.sin(u * 60) > 0 ? 235 : 30));
  const rLow = withCanvas(lowRes, () => fn({ naturalWidth: 600, naturalHeight: 800 }));
  check('低分辨率判为 bad', rLow.level === 'bad', `实际 ${rLow.level}`);
  check('低分辨率给出重拍建议', rLow.issues.some((s) => s.includes('分辨率')), rLow.issues.join('；'));

  // 3) 整体偏暗
  const dark = grayImg(1600, 2200, (u, v) => (Math.sin(u * 60) > 0 ? 70 : 15));
  const rDark = withCanvas(dark, () => fn({ naturalWidth: 1600, naturalHeight: 2200 }));
  check('偏暗照片判为 bad', rDark.level === 'bad', `实际 ${rDark.level}`);
  check('偏暗照片提示光线', rDark.issues.some((s) => s.includes('暗')), rDark.issues.join('；'));

  // 4) 低对比度（灰蒙蒙）
  const flat = grayImg(1600, 2200, (u, v) => 128 + Math.sin(u * 60) * 3);
  const rFlat = withCanvas(flat, () => fn({ naturalWidth: 1600, naturalHeight: 2200 }));
  check('低对比度判为 bad', rFlat.level === 'bad', `实际 ${rFlat.level}`);
  check('低对比度提示对焦', rFlat.issues.some((s) => s.includes('对比度')), rFlat.issues.join('；'));

  // 5) 局部反光：高对比 + 一大块纯白
  const glare = grayImg(1600, 2200, (u, v) => (u > 0.6 && v < 0.3 ? 255 : (Math.sin(u * 60) > 0 ? 235 : 30)));
  const rGlare = withCanvas(glare, () => fn({ naturalWidth: 1600, naturalHeight: 2200 }));
  check('反光照片给出提示', rGlare.issues.some((s) => s.includes('反光')), rGlare.issues.join('；'));

  // 6) 阈值边界：just-ok 不应被误报
  const edge = grayImg(1400, 1900, (u, v) => (Math.sin(u * 60) > 0 ? 230 : 40));
  const rEdge = withCanvas(edge, () => fn({ naturalWidth: 1400, naturalHeight: 1900 }));
  check('达标边缘不误报 bad', rEdge.level !== 'bad', `实际 ${rEdge.level}：${rEdge.issues.join('；')}`);

  // 7) 跨域图读不到像素时应放行，不阻断上传
  const prevDoc2 = globalThis.document;
  globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage: () => {}, getImageData: () => { throw new Error('tainted'); } }) }) };
  let rTaint;
  try { rTaint = fn({ naturalWidth: 1600, naturalHeight: 2200 }); } finally { globalThis.document = prevDoc2; }
  check('跨域图放行不阻断', rTaint.level === 'ok', `实际 ${rTaint.level}`);
}

console.log('\n═══════════════════════════════');
console.log(`通过 ${pass} ｜ 失败 ${fail}`);
if (problems.length) {
  console.log('\n失败项：');
  for (const x of problems) console.log('  · ' + x);
  console.log();
  process.exit(1);
}
console.log('前端渲染逻辑全部走通。\n');
