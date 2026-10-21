# kg-research —— 物理知识图谱调研素材

本项目在做课程图谱之前，调研过「能不能直接拿现成的物理知识图谱用」。
这里的文件是那次调研的留档，**全部是第三方数据，两者均为 MIT 许可**（见仓库根目录 `NOTICE.md`）。

## 文件

| 文件 | 大小 | 内容 | 来源 |
|---|---|---|---|
| `sphere_physics_kg.json` | 2.4 MB | 8245 条英文物理知识图谱（Sub-field：Classical Mechanics / QFT / General Relativity …） | [basiralab/SPHERE](https://github.com/basiralab/SPHERE) 的 `physics/final_physics_knowledge_graph.json` |
| `sphere_names.txt` | 324 KB | 上面所有节点的「类型 + 名称」清单（TSV） | 由 `analyze.mjs` 从上一行派生，非原始发布文件 |
| `graphysics_equations.json` | 269 KB | 400 条物理公式 + 25 个常数 | [kingelanci/graphysics](https://github.com/kingelanci/graphysics) |
| `analyze.mjs` | 3 KB | 分析脚本：统计规模、层级、是否覆盖电动力学 | 本项目自写 |

SPHERE 对应 ICLR 2026 论文 HGNet（Joshi & Rekik，BASIRA Lab）；
graphysics 对应 arXiv:2508.05724（Romiti, 2025）。引用格式见 `NOTICE.md`。

## 结论：为什么最后没有直接用

**未被本项目任何代码引用**，也不在数据管线里。留档是为了说明「调研过、评估过、没采用」，
而不是留着一份可以直接并入的数据。

三点原因：

1. **体系不同**。它们是英文的通用物理分类（Sub-field → …），本项目是中文课程图谱（章 → 节 → 知识点）。
   两套层级的切分逻辑不一样，不能直接映射，真要复用只能当"对照表"，且需要逐条重新对齐。
2. **粒度不对**。大学物理的顶层分类会把「电动力学」整体当成一个 Sub-field，而本项目需要的是
   「球坐标系下的分离变数」这一级别的知识点，以及它们之间的**教学先修**关系。
3. **没有先修关系**。这两个数据集提供的是分类层级与公式清单，**不含教学意义上的「学 A 之前必须会 B」**。
   而先修 DAG 恰恰是本项目最核心、也最没法现成拿到的资产。

## 另外

- 文件名里的 `pyhsics` / `graphysics` 是原始来源的拼写，未做修正，以免与出处对不上。
- 这两个数据集不是同源的，放在同一目录只是因为同属那次调研。
