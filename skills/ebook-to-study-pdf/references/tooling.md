# 工具与可重建命令

下例 `<skill>` 表示本技能安装目录，`<project>` 是目标项目；命令中的路径含空格时加引号。脚本可从任何工作目录调用，manifest 内路径相对于 manifest 所在目录。

## 依赖

- Python 3.10+，PyMuPDF 1.24.5+（低于 2）：`python -m pip install -r <skill>/scripts/requirements.txt`。`pymupdf` 模块名从 1.24.3 开始提供，但该版本在书签处理时仍产生异常诊断；本技能下限采用已通过回归和冒烟构建的 1.24.5，见[官方变更记录](https://pymupdf.readthedocs.io/en/latest/changes.html#changes-in-version-1-24-5)。
- Pandoc 3.11+（本机实测版本；使用 `--syntax-highlighting=none`）、完整 TeX Live 或等效工具，包含 LuaLaTeX、latexmk、ctex、fontspec、tcolorbox、fvextra、bookmark 等模板宏包。其他 Pandoc 版本先确认选项与输出格式兼容，未在本次验证中覆盖。
- Noto Serif、Noto Sans、Noto Sans Mono、Noto Serif SC、Noto Sans SC。本模板沿用 LuaLaTeX 可变字体的 Weight 设置。缺字体时安装/确认实际字体名称，不静默回退。
- OCRmyPDF/Tesseract 可选；视觉阅读不要求它们。工具未安装时不可报告 OCR 已执行。

本技能的代码、文档和自编样例采用随目录提供的 MIT 许可证。第三方依赖遵循各自许可证；PyMuPDF/MuPDF 提供 AGPL 开源许可和商业许可，MIT 声明不覆盖这些依赖。分发包含依赖的软件或将其用于服务时，应核对相应用途的许可条件；无法满足 AGPL 条件时，可向 Artifex 咨询商业许可。详见[PyMuPDF 官方许可说明](https://pymupdf.readthedocs.io/en/latest/about.html#license-and-copyright)。本技能不捆绑依赖、字体或教材。

## 诊断与渲染原书

```text
python <skill>/scripts/pdf_workflow.py inspect source.pdf --report tmp/pdfs/source-diagnostics.json
python <skill>/scripts/pdf_workflow.py render source.pdf --out tmp/pdfs/source-review --pages 1,10-12 --dpi 150 --report tmp/pdfs/source-render.json
```

`inspect` 遍历全部页面，报告图片面积并集比例、文字字符数、隐藏文字线索、预览文本、页标签与书签，不输出可靠性判决。扫描衍生但重排为矢量文字的 PDF 可能看不到结构线索，须查来源链。默认 `render` 为所有页；联系表每张最多 12 页。输出目录用于生成件，同名 `page-*.png` / `contact-*.png` 会更新，不要与私人图片混放。

所有命令的 `--report` 必须与源 PDF、输入 manifest 及本次切分 PDF 分开。执行前检查路径归一化、符号链接和已有文件的硬链接别名；冲突时非零退出，不开始切分或渲染。

## manifest、拆分与校验

从 [manifest 示例](../assets/manifest.example.json)复制，逐章改成核实后的区间。所有区间是 PDF 页码 1 起闭区间，按书中顺序、不重叠；允许排除前言、参考文献等形成间隙。`source` 可以相对或绝对指向原书；其他内容/输出路径限定项目内，使用相对路径。脚本不会把 source 当作 OCR 文本可信证明。

```text
python <skill>/scripts/pdf_workflow.py split <project>/manifest.json --out <project>/chapters --report <project>/tmp/pdfs/splits.json
python <skill>/scripts/pdf_workflow.py verify <project>/manifest.json --out <project>/chapters
```

切分文件按 ID 命名（`ch01.pdf` 等），标题写入元数据；保留章节内普通书签，归一化层级和页码。已有切分文件拒绝覆盖，重切分使用新目录。验证每一页的 RGB 渲染哈希和全部章内书签，不仅首末页；任何差异、缺文件或页数不符都非零退出。60 DPI 哈希适合复制一致性校验，不是高分辨率文字内容审核；切分保真不代表源书完整。

## 建立排版项目

1. 将 `assets/latex/` 完整复制到 `<project>/latex/`；不要覆盖已有自定义模板。可对照迁移同名语义框。
2. 在 `main.tex` 中设置 `\BookTitle`，如 `大学物理下册`。
3. `mode: markdown` 时，填入每章 `note` 和 `tex`，Markdown 首行一个一级章标题，其他标题按层级递进。公式用 `$...$` / `$$...$$` 和 raw TeX；图片放 `latex/figures/`，引用项目根相对路径。
4. 跨章节链接使用最终 fragment 如 `#ch02-基本机制`，本章 `#基本机制` 会自动加章节前缀。不要在导出 PDF 内链接不可交付的 Markdown 文件。
5. `mode: tex` 时，直接写 `latex/chapters/chNN.tex`（含 `\chapter`），无需 note；不会运行 Pandoc 或覆盖章节 TeX。语义环境采用花括号标题：`\begin{problembox}{题目} ... \end{problembox}`。

```text
python <skill>/scripts/build_study.py <project>/manifest.json --timeout 300
python <skill>/scripts/pdf_workflow.py render <project>/总结.pdf --out <project>/tmp/pdfs/final-review --dpi 150 --report <project>/tmp/pdfs/final-render.json
```

构建为 manifest 的章节顺序生成 `latex/chapters.tex`；非本脚本生成的同名索引拒绝覆盖。每次创建唯一编译目录，失败保留 Pandoc/latexmk 日志；最终 PDF 仅在新构建、A4、字体嵌入和关键告警检查通过后替换。输出同时报告页数、哈希和实际字体嵌入信息，**不报告内容或视觉已验收**。检查结果仍需执行者逐项处理。

构建工具每个命令有超时；超时可能需要检查 TeX 是否等待依赖/字体，不能无证据加大超时反复执行。日志保留在 `tmp/pdfs/build-*`；视觉及内容通过后，才清理本次可再生中间件。标准 PDF 被锁定会报错，旧文件不等于新成果。

## 本地回归

技能测试以标准库 unittest 提供；依赖 PyMuPDF 的集成用例在缺依赖时显式 skip，纯 Python 契约校验仍运行。要实际验证 PDF 路径，必须安装依赖，并确认集成用例未 skip。

```text
python -m unittest discover -s tests -v
```

在技能目录执行；Skills 仓库统一入口会自动发现这些测试。编译器和视觉能力不由单元测试代替，应按正文流程实际构建和看图。

构建回归通过受控工具输出验证旧 PDF 保留、诊断日志、质量告警、A4/字体门以及两种内容真源的交付行为；它们不需要安装 TeX，也不代表真实 Pandoc/LaTeX 编译已验证。

## 可复现冒烟样例

[样例 manifest](../assets/smoke/manifest.json)、[振动章节](../assets/smoke/notes/ch01.md)和[链路时延章节](../assets/smoke/notes/ch02.md)均为自编内容，包含中文、10 种语义框、完整题解、公式、表格、代码和跨章链接。

安装上述排版工具链后，从任意工作目录执行，`--out` 指向尚不存在的目录：

```text
python <skill>/scripts/smoke_study.py --out <project>/study-smoke --timeout 300
```

脚本复制公开样例与模板，生成两页合成来源 PDF，校验切分；再实际运行 Markdown/Pandoc 与直接 TeX 两种构建，检查章节源码不变、全部页面的 150 DPI 渲染一致、目录书签与内部链接有效。生成 `study-markdown.pdf`、`study-tex.pdf`、两个 manifest、完整 LaTeX、构建日志、`smoke-report.json` 和 `review/` 下的全页图及联系表。查看这些图片后再记录视觉结果；脚本仅报告结构检查通过，已有输出目录拒绝覆盖。页数随排版工具和字体版本可能变化，不设固定页数断言。

## 当前回归记录（2026-10-08）

- Windows，Python 3.14.8 / PyMuPDF 1.28.2，以及隔离环境中的 Python 3.12.14 / PyMuPDF 1.24.5，检查均通过；本技能合并报告路径夹具后为 19 个测试方法，原有场景保留，均实际运行，无 skip。
- 两种依赖版本均通过公开样例的真实 Markdown/TeX 构建：5 页 A4、字体嵌入、8 个有效内部链接、全部页面 150 DPI 渲染一致，TeX 模式保留章节源码。
- PyMuPDF 1.28.2 样例的全部 5 页已查看，中文、公式、语义框、表格、代码未见裁切、重叠或缺字。该结果仅适用于自编样例，不代表任意教材内容已验收。
- 官方 `skills-ref validate` 通过。内置 `quick_validate.py` 尚未接受标准 `compatibility` 字段，因此使用官方参考校验器与仓库校验结果。

## 初版实测记录

以下为初版记录，所用临时样例不再作为当前回归入口；可复现验证使用上面的公开冒烟样例。初版环境：Windows，Python 3.14.7、PyMuPDF 1.28.2、Pandoc 3.11，以及本机 LuaLaTeX/latexmk 与 Noto 字体。不代表其他客户端/工具版本自动兼容：

- Skills 仓库 `python scripts/check.py` 全部通过；本技能 8 个用例实际运行，未 skip。覆盖 OCR 隐藏文字风险、闭区间边界、章内书签、中间页损坏、拒绝覆盖和路径边界。
- `inspect` 实际处理原生矢量文字样本、482 页物理扫描教材及 505 页网络 OCR 教材；结果及来源判断见[经验记录](lessons.md)。
- `split` CLI 按 manifest 实际切分，自动全页渲染哈希与书签验证通过。
- Markdown/Pandoc 与直接 TeX 两种模式均实际生成 7 页 A4 PDF，所有字体嵌入；TeX 模式前后章节源码哈希不变，两份 PDF 的全部 7 页 150 DPI 渲染完全一致。
- 渲染并人工查看全部 7 页：封面、连续目录、10 种语义框、数学公式、完整题目/解析/答案、术语表、代码和跨页框均未见裁切、重叠或缺字；无独立分割横线。10 个目录/正文内部链接均解析到有效页面，跨章链接指向正确章节。
- 例题独立重算得到弹簧振子周期 0.314 秒、单链路总时延 5.12 毫秒，与最终 PDF 一致。

初版未覆盖：实际 OCR 引擎运行（本机未安装 OCRmyPDF/Tesseract）、两本教材的重新逐页内容审校、外部视觉模型、客户端全局安装、发布/推送。视觉验收由主代理直接查看图片完成。临时教材诊断和编译产物不随技能发布；公开自编冒烟样例位于 `assets/smoke/`。
