# 技能安装

SkillLoom 的技能源码统一存放在 `skills/<技能名>/`，每个技能以独立目录分发。目录内的 `SKILL.md` 提供技能元数据与执行指令，其他文件提供脚本、参考资料及资源。该结构遵循 [Agent Skills 开放格式](https://agentskills.io/home)，不依赖单一客户端的专用安装器。

## 使用命令行安装

推荐使用 [skills CLI](https://github.com/vercel-labs/skills)，可通过 `npx` 运行。使用前安装 Node.js 与 npm；远程 Git 仓库安装还需要 Git。

### 从 GitHub 安装

在目标项目的终端中执行：

```text
npx skills@latest add SSJ-ZYJ/SkillLoom
```

也可使用完整 GitHub 仓库地址作为 `add` 的参数。可先仅列出仓库技能，再选择需要安装的内容：

```text
npx skills@latest add SSJ-ZYJ/SkillLoom --list
npx skills@latest add SSJ-ZYJ/SkillLoom --skill educoder-automation
```

安装器依据 `skills/` 下各技能目录的 `SKILL.md` 发现可用技能；`--skill` 仍使用技能名称，不加 `skills/` 前缀。

### 从本地仓库安装

在本仓库根目录执行：

```text
npx skills@latest add . --list
npx skills@latest add .
```

默认采用项目级安装，目标项目为命令执行时的工作目录。需要安装至其他项目时，应在该项目目录中执行，并将 `.` 替换为本仓库的本地路径；包含空格的路径应加引号。

### 指定客户端与安装范围

以下示例将所选技能安装至 Codex 和 Claude Code 的用户级目录：

```text
npx skills@latest add SSJ-ZYJ/SkillLoom --skill educoder-automation --agent codex claude-code --global
```

| 参数                   | 用途                                                         |
| ---------------------- | ------------------------------------------------------------ |
| `--list`               | 列出可用技能，不进行安装                                     |
| `--skill <名称>`       | 指定技能；未指定时可选择可用技能                             |
| `--agent <客户端标识>` | 指定一个或多个目标客户端，标识列表见 CLI 文档                |
| `--global`             | 使用用户级安装；默认使用项目级安装                           |
| `--copy`               | 可选：为客户端安装独立文件副本，替代符号链接                 |
| `--yes`                | 跳过确认提示，适用于目标技能、客户端与范围已明确的自动化安装 |

安装器支持符号链接与文件复制两种方式。CLI 推荐符号链接，使多个客户端共享一份技能文件；需要独立副本或环境不支持符号链接时，可添加 `--copy`。该参数仅控制文件安装方式，与是否保留旧版本无关。实际目标路径以安装摘要为准。客户端未被自动识别时，可显式指定 `--agent`。

## 手动安装的目录选择

用户级安装用于当前用户的多个项目；项目级安装用于指定项目。客户端对加载范围、重复名称及组织策略的处理可能不同，应以目标客户端的文档为准。

| 客户端                    | 用户级目录           | 项目级目录                     | 官方文档                                                                                         |
| ------------------------- | -------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------ |
| Codex                     | `~/.agents/skills/`  | `<项目根目录>/.agents/skills/` | [Codex 技能文档](https://learn.chatgpt.com/docs/build-skills)                                    |
| Claude Code               | `~/.claude/skills/`  | `<项目根目录>/.claude/skills/` | [Claude Code 技能文档](https://code.claude.com/docs/en/skills)                                   |
| GitHub Copilot（VS Code） | `~/.copilot/skills/` | `<项目根目录>/.github/skills/` | [VS Code Agent Skills 文档](https://code.visualstudio.com/docs/agent-customization/agent-skills) |

表中列出各客户端的一组标准路径，未穷举其支持的全部位置。`~` 表示用户主目录；项目根目录指使用技能的目标项目，而非本仓库的下载位置。

其他支持 Agent Skills 的客户端，可使用其文档规定的技能根目录。仅支持文件上传或插件导入的客户端，应遵循其封装要求；本仓库的独立技能目录不等同于客户端专用插件包。

## 完整复制技能目录

1. 克隆或下载选定版本的仓库。
2. 从 [skills.json](../skills.json) 选择 `skills/<技能名>/` 下的技能目录。
3. 将整个技能目录复制至目标技能根目录，不仅复制 `SKILL.md`，也不要把仓库的 `skills/` 容器再套一层复制进去。
4. 按客户端要求重新加载技能，并核对实际识别的技能名称。

安装后的目录结构应为：

```text
<客户端技能根目录>/
└── <技能目录名>/
    ├── SKILL.md
    ├── LICENSE
    ├── scripts/       原技能包含时保留
    ├── references/    原技能包含时保留
    └── ...            保留原技能的其他配套文件
```

使用客户端安装器时，应明确提供仓库地址和所选技能目录，并确认安装器会保留完整内容。专用安装器属于客户端能力，不是使用本仓库的必要条件。

## 调用与运行条件

可在对话中使用“请使用 `<技能名称>` 技能……”指定任务。显式命令由客户端定义，例如 Claude Code 使用 `/技能名称`，Codex 使用 `$技能名称`；其他客户端按自身文档操作。

技能文件可被客户端识别，并不表示该客户端已具备执行任务的全部能力。运行前需核对技能说明中的浏览器访问、页面操作、脚本执行、外部服务与权限要求。当前实验技能的运行条件见[浏览器适配说明](../skills/educoder-automation/references/browser-runtime.md)。

脚本运行环境与依赖以所选技能的说明为准。

## 更新与移除

通过 skills CLI 安装时，重新执行相同来源、技能、客户端和安装范围的安装命令，并确认覆盖目标。本地来源的更新需先更新源仓库；GitHub 来源的更新会重新获取仓库内容。

更新时使用选定版本的完整技能目录替换原安装目录，并核对需要保留的本地定制内容。避免只覆盖部分文件而残留已删除的脚本或资料。默认仅保留当前安装版本。

源仓库中的 `git pull` 不会更新独立复制的安装目录。更新完成后，按客户端要求刷新或重新启动会话，确认其加载的是新版本。

手动安装的技能可通过删除对应安装目录移除；通过安装器安装的技能，应使用该安装器的卸载功能。skills CLI 可使用 `npx skills@latest remove educoder-automation`，并选择对应范围与客户端。
