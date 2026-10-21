/**
 * 分析 SPHERE 物理知识图谱：规模、层级、是否覆盖电动力学
 */
import fs from 'node:fs';

const raw = JSON.parse(fs.readFileSync(new URL('./sphere_physics_kg.json', import.meta.url), 'utf8'));

// 递归统计
let total = 0;
const types = new Map();
const byDepth = new Map();
const allNames = [];
const relTypes = new Map();
let withRelations = 0;
let relCount = 0;

function walk(nodes, depth, path) {
  for (const n of nodes) {
    total++;
    types.set(n.type, (types.get(n.type) || 0) + 1);
    byDepth.set(depth, (byDepth.get(depth) || 0) + 1);
    if (depth <= 1 && path.length <= 1) allNames.push(n.name);
    const rels = n.relations || [];
    if (rels.length) withRelations++;
    relCount += rels.length;
    for (const r of rels) relTypes.set(r.type, (relTypes.get(r.type) || 0) + 1);
    if (n.children) walk(n.children, depth + 1, [...path, n.name]);
  }
}

console.log('顶层键:', Object.keys(raw[0]).join(', '));
walk(raw, 0, []);

console.log('\n=== 规模 ===');
console.log('概念总数:', total);
console.log('关系总数:', relCount, '| 含关系的节点:', withRelations);
console.log('\n层级分布:', [...byDepth.entries()].map(([d, c]) => `L${d}:${c}`).join('  '));
console.log('\n类型分布:', [...types.entries()].sort((a, b) => b[1] - a[1]).map(([t, c]) => `${t}=${c}`).join(', '));
console.log('关系类型:', [...relTypes.entries()].map(([t, c]) => `${t}=${c}`).join(', '));

// 写全部名称出来供检索
const names = [];
function collect(nodes) {
  for (const n of nodes) {
    names.push(`${n.type}\t${n.name}`);
    if (n.children) collect(n.children);
  }
}
collect(raw);
fs.writeFileSync(new URL('./sphere_names.txt', import.meta.url), names.join('\n'), 'utf8');
console.log('\n已导出全部节点名 → sphere_names.txt');

// 电动力学相关检索
const KEY = [
  'Maxwell', 'Electrodynamic', 'Electromagnetic Wave', 'Wave Equation', 'Helmholtz',
  'Poynting', 'Retarded Potential', 'Dipole Radiation', 'Boundary Value', 'Dielectric',
  'Magnetostatic', 'Electrostatic', 'Laplace', 'Green', 'Multipole', 'Lorentz',
  'Covarian', 'Four-vector', 'Gauge', 'Waveguide', 'Cavity', 'Fresnel', 'Skin Depth',
  'Liénard', 'Gauge Transformation', 'Vector Potential', 'Scalar Potential',
];
console.log('\n=== 电动力学关键词命中 ===');
const lower = names.map((s) => s.toLowerCase());
for (const k of KEY) {
  const hit = names.filter((s) => s.toLowerCase().includes(k.toLowerCase()));
  console.log(`${hit.length ? '✓' : '✗'} ${k.padEnd(22)} ${hit.length ? hit.slice(0, 3).map((h) => h.split('\t')[1]).join(' / ') + (hit.length > 3 ? ` …(+${hit.length - 3})` : '') : ''}`);
}
