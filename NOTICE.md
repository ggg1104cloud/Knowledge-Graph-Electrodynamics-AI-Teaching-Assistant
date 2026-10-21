# NOTICE —— 第三方数据与组件

本仓库包含以下第三方内容，均按其原始许可使用。本项目的原创代码与图谱数据以 **MIT License** 发布，全文见 `LICENSE`。

---

## 1. SPHERE —— 物理知识图谱调研素材

| 项 | 内容 |
|---|---|
| 文件 | `docs/research/kg-research/sphere_physics_kg.json`、`sphere_names.txt` |
| 原始文件 | `SPHERE/physics/final_physics_knowledge_graph.json` |
| 项目 | SPHERE: Scientific Multidomain Large Entity and Relation Extraction |
| 作者 | Devvrat Joshi, Islem Rekik（BASIRA Lab） |
| 仓库 | https://github.com/basiralab/SPHERE |
| 论文 | HGNet: Scalable Foundation Model for Automated Knowledge Graph Generation from Scientific Literature，ICLR 2026 |
| 许可 | **MIT License** |

`sphere_names.txt` 是本项目脚本 `analyze.mjs` 从上表 JSON 派生的名称清单（TSV），不是原始发布文件。

原始许可声明：

```
MIT License

Copyright (c) 2026 BASIRA LAB

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

建议引用：

```bibtex
@inproceedings{joshi2026hgnet,
  title={{HGN}et: Scalable Foundation Model for Automated Knowledge Graph Generation from Scientific Literature},
  author={Devvrat Joshi and Islem Rekik},
  booktitle={The Fourteenth International Conference on Learning Representations},
  year={2026},
  url={https://openreview.net/forum?id=NWd53rltx8}
}
```

---

## 2. graphysics —— 物理公式库调研素材

| 项 | 内容 |
|---|---|
| 文件 | `docs/research/kg-research/graphysics_equations.json` |
| 项目 | graphysics: A Graph-Based Framework for Exploring Mathematical Patterns in Physics |
| 作者 | Massimiliano Romiti |
| 仓库 | https://github.com/kingelanci/graphysics |
| 论文 | arXiv:2508.05724, 2025 |
| 许可 | **MIT License** |

原始许可声明：

```
MIT License

Copyright (c) 2025 Massimiliano Romiti

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 3. KaTeX

`web/vendor/katex/` 是 KaTeX 的本地副本（离线可用，不走 CDN），版本 0.18.7。

| 项 | 内容 |
|---|---|
| 项目 | KaTeX |
| 作者 | Khan Academy 及贡献者 |
| 仓库 | https://github.com/KaTeX/KaTeX |
| 许可 | **MIT License** |

---

## 4. 关于这些素材的用途

上述 SPHERE 与 graphysics 数据**仅作为调研阶段的历史参照**保留（见 `docs/research/kg-research/README.md`）：

- 未被本项目任何代码引用，不参与数据管线；
- 语言为英文、体系为通用物理分类（Sub-field → …），与本项目的中文课程图谱（章 → 节 → 知识点）体系不同；
- 不能直接并入 `data/`，如需复用只能作为对照表，且需要重新对齐。

---

## 5. 样例图片

`samples/` 下的题目照片与教材页截图，用于回归测试（`npm run hw` 等），不包含学生个人信息。

本项目图谱的**结构与内容**对齐下列公开来源，未复制其正文：

- 《电动力学》（郭硕鸿，高等教育出版社，第三版）—— 章节顺序与知识点划分
- 国家高等教育智慧教育平台《电动力学》（北京交通大学，王健）—— 课程骨架来源

## 6. 教材与课程骨架

本项目图谱的**结构与内容**对齐下列公开来源，未复制其正文：

- 《电动力学》（郭硕鸿，高等教育出版社，第三版）—— 章节顺序与知识点划分
- 国家高等教育智慧教育平台《电动力学》（北京交通大学，王健）—— 课程骨架来源

教材本身受著作权保护，本仓库只包含自行编写或从公开来源整理的结构化数据，不含教材原文。
