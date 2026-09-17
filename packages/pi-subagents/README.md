# pi-subagents

一个同步的 `subagent` 工具：主 Agent 指定角色和完整任务，子 Agent 在独立会话中执行，只把最终回答返回给主 Agent。支持单任务与最多 4 项互相独立的并行只读调查。

## 安装

在仓库根目录执行 `pi install ./packages/pi-subagents`，完成后 `/reload` 生效。

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
| `tools` | 工具白名单，逗号分隔字符串或 YAML 列表；省略为 `read, grep, find, ls` 加已声明可信只读来源的只读工具，`[]` 禁用全部。内置为 `read`/`grep`/`find`/`ls`/`edit`/`write`/`powershell`/`bash`，其余视为扩展工具；显式写出的名字必须真实注册，缺一个就拒绝启动，自动启用的名字缺失时忽略 |
| `extensions` | 可选，在默认来源之外额外加载的扩展来源（本地路径或已安装来源，如 `npm:pi-web-access`）；省略或 `[]` 表示只加载默认来源。不会安装或下载任何东西；来源随包提供的 skills 会一并加载。来源不可用（未安装、未启用或路径不存在）时跳过该来源，子会话用已注册的工具继续；声明的来源被跳过时会在结果文本里注明 |
| `model` | 可选，完整 `provider/model`，默认继承父会话当前模型 |
| `thinking` | 可选，`off/minimal/low/medium/high/xhigh/max`，默认继承父会话 |

子会话默认加载 `npm:@ff-labs/pi-fff`，不需要在 Agent 里声明：装了就由 FFF 提供 `grep`/`find`（pi-fff 处于 `override` 模式时同名覆盖内置实现，模式来自全局 `pi-fff.json`），没装或未启用就静默跳过、回退 Pi 内置 `grep`/`find`；默认来源缺失不写进结果文本，声明的来源缺失才提示。默认来源只放检索/只读能力，加载失败（来源存在但自身报错）仍然报错。

仅支持以上字段。Markdown 正文以追加系统提示注入，不替换系统提示词，也不读取父会话的追加提示词或 `APPEND_SYSTEM.md`。

配置解析错误、未知字段、重复条目或同目录重名会报告来源路径，并**禁用全部委派直至修正后 `/reload`**。没有定义时工具返回配置指引；定义在会话启动、切换和 `/reload` 时刷新。

## 调用

单任务用 `agent` + `task`；并行用 `tasks`（1–4 项，按输入顺序返回逐项结果）：

```ts
subagent({ agent: "scout", task: "调查 src/auth 的认证入口及主要调用链。只读、不运行命令。" })

subagent({
  tasks: [
    { agent: "scout", task: "定位认证入口与调用链，返回文件:行号。" },
    { agent: "reviewer", task: "只读审查 src/auth 的错误路径与输入校验。" }
  ]
})
```

任务必须自包含（背景、路径、限制、期望输出），子 Agent 不知道父会话历史；工作目录固定为父会话 `cwd`。

- `agent`/`task` 与 `tasks` 互斥，两种模式并用、`tasks: []`、逐项带 `cwd`/`model`/`thinking`、超过 4 项都直接报参数错误。同一个 Agent 可在并行调用里出现多次。
- 结果文本：单任务就是最终回答本身；并行是 `N/M 成功` 加逐项小节。

### 调度与限制

- 并发：只读 Agent 共享并发槽，最多 3 个同时运行，父会话内所有 `subagent` 调用共用一个队列，超出的排队；含写入或名单外扩展工具的任务无法静态判断是否写盘，会独占执行，期间不与其他子任务并行。
- 执行上限固定 10 分钟，等待与执行均可取消；单个任务失败不影响其他任务（并行时逐项标注失败原因，全部失败才报错）。
- 输出上限：单任务与整次调用的返回文本各至多 50 KiB / 2000 行，超限时完整内容写入临时文件（单任务 `result.md`，整次调用 `parallel.md`），保留到父会话关闭、切换或 `/reload`。
- 委派期间主 Agent 不要修改与子 Agent 相同的文件；子会话不是文件系统沙箱，写入与命令工具由 Agent 的 `tools` 授予，pi 不会在运行时弹权限确认。
- 子会话不继承父会话的扩展、自定义工具或只存在于父进程的 provider/认证状态：除默认来源外只加载 Agent 声明的 `extensions`，模型与 thinking 默认继承父会话，也可由 Agent 覆盖。
