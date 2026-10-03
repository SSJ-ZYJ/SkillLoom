# SkillLoom

SkillLoom 是由作者维护的智能体技能（Agent Skills）集合，提供面向具体任务的执行指令、参考资料与辅助脚本。各技能独立管理，可按需安装至支持 Agent Skills 的客户端。

技能的适用范围、运行条件与使用方法见对应说明。

## 技能目录

<!-- skills:start -->

| 技能 | 用途 |
| --- | --- |
| [educoder-automation](educoder-automation/SKILL.md) | 在线实验任务自动化，涵盖编程、多文件与选择题，支持保存核验及评测跟踪。 |

<!-- skills:end -->

实验自动化技能需要具备实验访问权限的已登录浏览器会话，客户端需提供相应的浏览器操作工具。接入方式与适用限制见[浏览器适配说明](educoder-automation/references/browser-runtime.md)。

## 安装与使用

技能采用 [Agent Skills 开放格式](https://agentskills.io/home)，可安装至支持该格式的客户端。安装目录与加载方式由客户端规定，技能执行所需的浏览器、脚本运行环境及工具权限须另行满足。

### 命令行安装

推荐使用 [skills CLI](https://github.com/vercel-labs/skills) 安装。该工具支持技能选择、多客户端安装及安装范围配置，需要 Node.js、npm 提供的 `npx`；从 Git 仓库安装还需要 Git。

在终端执行：

```text
npx skills@latest add SSJ-ZYJ/SkillLoom
```

从本地副本安装时，在仓库根目录执行：

```text
npx skills@latest add .
```

默认安装至当前项目，可通过 `--global` 改为用户级安装。技能、目标客户端与安装方式可通过交互界面或命令参数选择。完整参数与更新方式见[安装说明](docs/INSTALLATION.md)。

### 手动安装

1. 克隆或下载本仓库，选择需要安装的技能目录。
2. 将该目录完整复制至目标客户端的技能根目录，保留 `SKILL.md`、辅助脚本、参考资料和许可证文件。
3. 按客户端要求刷新技能列表或重新启动会话，确认技能已被识别。

常见客户端的默认目录如下。项目级目录相对于目标项目根目录，`~` 表示用户主目录。

| 客户端 | 用户级技能根目录 | 项目级技能根目录 | 官方说明 |
| --- | --- | --- | --- |
| Codex | `~/.agents/skills/` | `.agents/skills/` | [技能加载位置](https://learn.chatgpt.com/docs/build-skills) |
| Claude Code | `~/.claude/skills/` | `.claude/skills/` | [技能安装与使用](https://code.claude.com/docs/en/skills) |
| GitHub Copilot（VS Code） | `~/.copilot/skills/` | `.github/skills/` | [Agent Skills 配置](https://code.visualstudio.com/docs/agent-customization/agent-skills) |

其他客户端应使用其文档规定的技能目录或导入功能。详细安装步骤、更新方式与客户端差异见[安装说明](docs/INSTALLATION.md)。

### 使用技能

安装完成后，可在对话中指定技能名称与任务输入：

```text
请使用 educoder-automation 技能完成以下实验，并核验保存内容与本次评测结果：<实验链接>
```

若客户端支持显式技能命令，应遵循其调用语法。更新时使用目标版本替换完整的安装目录；拉取源仓库更新不会同步已复制的技能文件。具体操作见[安装说明](docs/INSTALLATION.md)。

## Bug 反馈

安装、执行或结果核验出现异常时，请通过 GitHub Issues 的问题反馈模板提交，并提供以下信息：

- 技能名称与版本、客户端及运行环境。
- 最小复现步骤、预期结果与实际结果。
- 脱敏后的错误信息或诊断记录。

涉及凭据泄露或越权操作的安全问题，请遵循[安全政策](SECURITY.md)，通过私密渠道报告。

## 许可证

代码与文档采用 [MIT License](LICENSE)。
