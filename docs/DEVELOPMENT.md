# 仓库维护与代码规范

本规范适用于仓库工具、技能脚本、测试和文档。运行技能只需安装对应技能的依赖；下述格式化工具用于维护源码。

## 环境与命令

维护环境使用 Python 3.10+、Node.js 22+ 和 Bun 1.4.2。Bun 负责依赖安装与命令入口，Node.js 用于现有脚本和运行兼容测试。在仓库根目录安装锁定版本的工具：

```text
python -m pip install -r requirements-dev.txt
bun install --frozen-lockfile
```

Python 可使用项目虚拟环境；以下命令中的 `python` 应指向同一环境。JS 工具从本仓库的 `node_modules` 加载，Python 工具从当前解释器加载，不依赖全局 Biome/Ruff。

```text
bun run format
bun run style:check
bun run check
```

`format` 执行格式化和安全的 lint 修复，之后需检查差异。`style:check` 只检查格式和静态规则；`check` 再执行元数据、链接、发布内容检查及全部离线测试。也可分别执行 `python scripts/style.py --write`、`python scripts/style.py` 和 `python scripts/check.py`。检查命令不会自动下载依赖。

CI 中的 Formatting and lint 作业执行相同规则，格式差异、静态错误与警告都会阻止检查通过。依赖由 `bun.lock` 锁定，CI 使用 `bun install --frozen-lockfile`。修改工具版本时同时更新配置中的 schema 和依赖版本，再运行 `bun install` 更新锁文件并执行完整检查。修改 Bun 版本时同时更新 `package.json` 的 `packageManager` 与 CI 的 `bun-version`。

## 格式与静态检查

| 文件           | 工具     | 规则                                                                                     |
| -------------- | -------- | ---------------------------------------------------------------------------------------- |
| JS、MJS、CJS   | Biome    | 2 空格、单引号、分号、100 列目标宽度；启用推荐规则和 import 整理                         |
| JSON           | Biome    | 2 空格；`bun.lock` 由 Bun 生成，不进行手工格式化                                         |
| Python         | Ruff     | 4 空格、双引号、100 列目标宽度、Python 3.10 语法基线；检查导入顺序、未使用名称及基础错误 |
| Markdown、YAML | Prettier | 2 空格、100 列目标宽度；保留正文换行，不重写代码围栏中的示例                             |
| Lua、LaTeX     | 人工维护 | 2 空格；复杂表、环境和配置分行，保留字符串及 TeX 空白语义                                |

所有文本使用 UTF-8、LF 和文件末尾换行。代码行宽为排版目标；不可拆分的路径、字符串、公式及正文可超出，不额外启用与格式化器冲突的硬性行宽检查。

同一种文件只由表中的一个工具格式化。Markdown 内的 JS/Python 示例保留其运行上下文，现有 EduCoder 测试仍检查示例语法。Pandoc 扩展语法和 LaTeX 改动需通过教材构建检查；涉及最终 PDF 排版时还需按技能说明进行视觉验收。

README 的技能目录由 `python scripts/update_catalog.py` 生成，表格前的 `prettier-ignore` 保持目录生成与全文格式化一致。新增技能后先运行生成器或刷新目录，再执行 `bun run format` 和 `bun run check`。

不得为了消除诊断而关闭整组检查。确有上下文限制时，使用范围最小的例外并写明原因。目前 Python 测试在导入技能脚本前需要设置 `sys.path`，因此仅对测试文件豁免 E402；其他 Python 规则仍生效。

## IDE 设置

仓库提供 [.vscode/settings.json](../.vscode/settings.json) 和 [扩展建议](../.vscode/extensions.json)。VS Code 及兼容 IDE 使用 Biome、Ruff、Prettier 和 EditorConfig 扩展；安装维护依赖后，按文件类型进行保存时格式化。Python 需选择已安装维护依赖的解释器；Biome 使用本仓库版本。

Lua 与 LaTeX 暂不启用保存时自动格式化，按上述规则维护，避免通用格式化器改动模板语义。其他 IDE 应读取根目录的 `.editorconfig`、`biome.json`、`pyproject.toml` 和 `.prettierrc.json`，采用相同工具版本；命令行和 CI 的检查结果作为仓库基准。

工具配置参考：[Biome](https://biomejs.dev/reference/configuration/)、[Ruff](https://docs.astral.sh/ruff/configuration/)、[Prettier](https://prettier.io/docs/options)。
