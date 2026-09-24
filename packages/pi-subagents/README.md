# pi-subagents

一个同步的 `subagent` 工具：主 Agent 指定角色和完整任务，子 Agent 在独立会话中执行，只把最终回答返回给主 Agent。调用只有一个入口 `tasks`：单项是单任务委派，多项是最多 4 项互相独立的并行只读调查。

## 安装

本地开发时在仓库根目录执行 `pi install ./packages/pi-subagents`，完成后 `/reload` 生效。

<a id="github-monorepo"></a>

### 从 GitHub 单仓库安装 Exa / DeepWiki

代码推送到 GitHub 后执行 `pi install git:github.com/x1any/pi-extensions`。Pi 安装的是**整个仓库根包**，而非 `packages/pi-exa` 或 `packages/pi-deepwiki` 子目录；根包默认暴露仓库里的所有扩展。若 `pi-subagents` 已按上面的本地路径单独安装，可将用户级 `~/.pi/agent/settings.json` 中该 Git 来源的配置改为（保留其他已有包条目）：

```json
{
  "source": "git:github.com/x1any/pi-extensions",
  "extensions": [
    "packages/pi-exa/index.ts",
    "packages/pi-deepwiki/index.ts"
  ]
}
```

这是 `packages` 数组中的**一个条目**，只启用两个 Git 扩展；若 `pi-subagents` 也只从该 Git 仓库安装，则在此列表额外加入 `"packages/pi-subagents/index.ts"`，不要再安装一份本地副本。迁移到 Git 来源时请停用提供同名工具的旧来源（包括 pi-web-access 和本地 pi-deepwiki），避免父会话重复注册。修改后 `/reload`，可用 `pi list` 核对包来源。子 Agent 的 Git 来源必须已安装、已启用，委派时不会临时下载。

## Agent 配置

扩展不附带 Agent 定义，也不写入用户目录。请自行创建 Agent Markdown 文件，同名时项目级覆盖用户级：

- 用户级 `~/.pi/agent/agents/*.md`（根目录可用 `PI_CODING_AGENT_DIR` 改写）
- 项目级 `<cwd>/.pi/agents/*.md`（只在项目已受信任时读取，不向父目录搜索）

```markdown
---
name: scout
description: 查找相关代码并总结调用关系
tools: read, grep, find, ls
---

只调查代码，不修改文件。返回关键路径、调用关系、结论和不确定项。
```

| 字段 | 含义 |
| --- | --- |
| `name` | 必填，调用时使用准确名称 |
| `description` | 必填，列入工具描述 |
| `tools` | 工具白名单，支持逗号分隔字符串或 YAML 列表；省略时仅启用 `read, grep, find, ls`，`[]` 禁用全部。内置工具还包括 `edit`、`write`、`powershell`、`bash`；扩展工具须逐名列出，未注册的工具会阻止启动 |
| `extensions` | 可选，指定本地路径或已安装来源。省略时根据 `tools` 推导，`[]` 不加载任何来源，显式指定时不推导；不会自动安装或下载。包来源会加载其已启用的扩展和 skills，本地路径只加载入口；不可用来源会跳过并在结果中注明 |
| `model` | 可选，完整 `provider/model`，默认继承父会话当前模型 |
| `thinking` | 可选，`off/minimal/low/medium/high/xhigh/max`，默认继承父会话 |

子会话不会默认加载任何扩展来源：要使用扩展工具，需把工具名写进 `tools`（父会话已加载该扩展时可据此推导来源），否则在 `extensions` 显式声明来源。来源不可用时跳过，只有 `tools` 里显式写出的工具缺失才拒绝启动，并在提示里点名来源。

联网调查和 DeepWiki 示例见 [`examples/researcher.md`](examples/researcher.md) 与 [`examples/deepwiki.md`](examples/deepwiki.md)。示例省略 `extensions`，因为父会话已加载的扩展可根据工具入口推导；未加载的来源须显式指定。推导的包会加载全部已启用扩展，但可调用工具仍受 `tools` 限制。本地入口不附带整包 skills。子会话结束时清理 MCP 连接与临时文件；来源在会话启动和 `/reload` 时重新推导。

仅支持以上字段。Markdown 正文追加为系统提示，不替换原提示词；父会话的追加提示词和 `APPEND_SYSTEM.md` 不会继承。

配置错误、未知字段、重复条目或同目录重名会报告来源，并**禁用全部委派直至修正后 `/reload`**。没有 Agent 定义时工具会显示配置指引；配置在会话启动、切换和 `/reload` 时刷新。

## 调用

`tasks` 数组是唯一入口（1–4 项，按输入顺序返回逐项结果）。单项是单任务委派，多项是互相独立的调查，会并发执行：

```ts
subagent({ tasks: [{ agent: "scout", task: "调查 src/auth 的认证入口及主要调用链。只读、不运行命令。" }] })

subagent({
  tasks: [
    { agent: "scout", task: "定位认证入口与调用链，返回文件:行号。" },
    { agent: "reviewer", task: "只读审查 src/auth 的错误路径与输入校验。" }
  ]
})
```

任务必须自包含（背景、路径、限制、期望输出），子 Agent 不知道父会话历史；工作目录固定为父会话 `cwd`。

- `tasks: []`、逐项带 `cwd`/`model`/`thinking`、超过 4 项都直接报参数错误。同一个 Agent 可在一次调用里出现多次。
- 结果文本：`N/M 成功` 加逐项小节（`### [i/N] agent · 完成`，单项时不标序号），失败项在对应小节附诊断；全部失败才整次报错。

### 树形展示

交互式 TUI 把一次调用显示为树根、任务显示为一级节点。执行中只展开每个活动任务最近的工具调用；调用结束后，折叠态保持紧凑，展开态显示各任务的工具轨迹与完整 Markdown 回答。工具轨迹只记录名称、状态和耗时，不保存参数或结果；每项最多保留最近 20 个已结束工具，超出的数量会单独标注。RPC、JSON 与 print 模式仍使用原有纯文本结果。

### 调度与限制

- 并发：工具白名单全部落在只读清单 [`src/read-only-tools.ts`](src/read-only-tools.ts) 内的 Agent 共享并发槽，最多 3 个同时运行。清单含内置 `read`/`grep`/`find`/`ls`，以及已确认只读的扩展工具（`ffgrep`/`fffind`、`query-docs`、`deepwiki_*`、`web_search`/`web_fetch` 等）；判定只按工具名，不校验实际能力，同名工具被其他扩展注册时会一并放行。清单外的工具无法可靠判断是否写盘，会独占执行，期间不与其他子任务并行。父会话内所有 `subagent` 调用共用一个队列，超出的排队。
- 执行上限固定 10 分钟，等待与执行均可取消；单个任务失败不影响其他任务（失败原因写在对应小节）。
- 输出上限：单项结果与整次调用的报告各至多 50 KiB / 2000 行，超限时完整内容写入临时文件（单项 `result.md`，整次报告 `report.md`），保留到父会话关闭、切换或 `/reload`。
- 委派期间主 Agent 不要修改与子 Agent 相同的文件；子会话不是文件系统沙箱，写入与命令工具由 Agent 的 `tools` 授予，pi 不会在运行时弹权限确认。
- 子会话不继承父会话的扩展、自定义工具或只存在于父进程的 provider/认证状态：只加载 Agent 显式声明或由父会话已加载 `tools` 推导的来源，模型与 thinking 默认继承父会话，也可由 Agent 覆盖。
