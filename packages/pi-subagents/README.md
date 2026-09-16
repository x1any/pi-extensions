# pi-subagents v0.2

一个同步的 `subagent` 工具：主 Agent 指定角色和完整任务，子 Agent 在独立会话中执行，只把最终回答返回给主 Agent。一次调用可以委派一个任务，也可以提交最多 4 个互相独立的只读调查并行执行。

基于 **Pi 0.85.1 SDK**，子会话在父进程内用 `createAgentSession` 创建，不启动 Pi CLI 子进程，不提供跨版本兼容层。2026-09-17 在 Pi 0.85.1 + `deepseek/deepseek-flash` 上完成运行验证（并行任务顺序、部分失败、并发上限、写 Agent 独占、取消、截断与清理），清单与证据见 [subagents-v0.2-parallel-plan.md](../../subagents-v0.2-parallel-plan.md) 的「运行验证结果」；动画圈与 `ctrl+o` 展开等 TUI 观感仍需人眼确认。

## 安装

在本仓库根目录：

```powershell
pi install ./pi-subagents      # 写入用户配置，之后 /reload
pi -e ./pi-subagents/index.ts  # 或仅临时加载
```

不要只复制 `index.ts`，它依赖同包的 `src/agents.ts`、`src/runner.ts`。扩展自身不修改任何用户配置。

## Agent 配置

扩展不附带 Agent 定义，也不写入用户目录。请自行创建 Agent Markdown 文件，同名时项目级覆盖用户级：

- 用户级 `getAgentDir()/agents/*.md`（默认 `~/.pi/agent/agents/`，遵循 `PI_CODING_AGENT_DIR`）
- 项目级 `<cwd>/.pi/agents/*.md`（目录名取自 `CONFIG_DIR_NAME`，只在项目已受信任时读取，不向父目录搜索）

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
| `tools` | 工具白名单，逗号分隔字符串或 YAML 列表；省略为 `read, grep, find, ls`；`[]` 为完全禁用。内置工具为 `read, grep, find, ls, edit, write, powershell, bash`，其余名称视为扩展工具 |
| `extensions` | 可选，只在本子会话加载的扩展来源（本地路径或已安装来源，如 `npm:pi-web-access`）；省略或 `[]` 为不加载 |
| `model` | 可选，完整 `provider/model`，默认继承父会话当前模型 |
| `thinking` | 可选，`off/minimal/low/medium/high/xhigh/max`，默认继承父会话 |

仅支持以上字段。Markdown 正文以追加系统提示注入，不替换系统提示词，也不读取父会话的追加提示词或 `APPEND_SYSTEM.md`。

两个易错点：

- 显式空值（`tools:`、`tools: ""`）无效，禁用全部工具必须写 `tools: []`。
- 扩展工具要同时配置两处：名字写进 `tools`，提供它的扩展写进 `extensions`。`extensions` 不会安装或下载任何东西；来源未安装、被禁用或路径不存在时拒绝启动。

配置解析错误、未知字段、重复条目或同目录重名会报告来源路径，并**禁用全部委派直至修正后 `/reload`**。没有任何定义时工具返回配置指引。定义在会话启动、切换和 `/reload` 时刷新，没有文件监听器。

## 调用

单任务模式：

```ts
subagent({
  agent: "scout",
  task: "调查 src/auth 的认证入口及主要调用链。只读、不运行命令。返回文件路径、关键行号、输入输出契约和待确认项。"
})
```

并行模式（1–4 项，按输入顺序返回逐项结果）：

```ts
subagent({
  tasks: [
    { agent: "scout", task: "定位认证入口与调用链，返回文件:行号。" },
    { agent: "reviewer", task: "只读审查 src/auth 的错误路径与输入校验。" }
  ]
})
```

任务必须自包含（背景、路径、限制、期望输出），子 Agent 不知道父会话历史；工作目录固定为父会话 `cwd`。

- `agent`/`task` 与 `tasks` 互斥，只能出现其一。`tasks: []`、两种模式同时出现、逐项带 `cwd`/`model`/`thinking`、或超过 4 项都直接报参数错误，不静默截断也不补默认值。
- 同一个 Agent 可以在并行调用里出现多次，每次都创建独立子会话；逐项不提供 `cwd`、`model`、`thinking`，这些只来自 Agent 定义和父会话。
- 结果文本：单任务就是最终回答本身；并行是 `N/M 成功` 加逐项小节（`### [i/M] agent · 完成|失败（kind）|已取消`）。

并发与取消：

- 只读 Agent 最多同时运行 **3 个**，多出的按 FIFO 排队。上限作用于父会话内**全部** subagent 调用，不只是同一个 `tasks` 数组。
- 含 `edit`、`write`、`powershell`、`bash` 或已知只读集合之外的扩展工具名的 Agent 无法静态判断是否写盘，按保守处理**独占整个池**：既不与只读任务并行，也不与其他写任务并行。这类 Agent 即使放进 tasks 数组也会串行执行。
- 排队和执行都可取消。取消后已结束的任务保留结果，运行中的任务被 `abort()`，尚未开始的任务不再启动并标记为已取消。
- 固定执行超时 **10 分钟**，从获得执行槽后计时，不含排队。
- 单个任务失败不影响其他任务；**部分失败不抛错**，失败项在文本里标明原因，成功项正常返回。全部任务失败才抛错，诊断按任务聚合、各自独立截断。
- 工具行显示 task 摘要；结果行每个任务一行：进行中统一用一个动画圈（`⠋⠙⠹…`，每 120ms 走一帧），不写状态词，只在失败/超时/取消时写明原因；另有最近工具、耗时与用量，单任务另附答案预览，`ctrl+o` 展开逐任务明细与完整回答。
- 还在推进的任务会在 footer 汇总成一行（`subagents ◐2 ✓1 · scout-fff 使用工具（ffgrep）`），全部结束后自动清空；没有其余界面元素。
- `details` 是多任务结构：`{ mode, tasks[], concurrency? }`，单任务即 `tasks.length === 1`；`concurrency` 给出全局的 `{ limit, active, queued }`，`tasks[].usage` 为预留的用量字段，暂未采集。
- 成功结果只包含最后一条 assistant 消息的文本块（不含 thinking、中间回答、工具日志）；模型错误、认证失败、输出长度耗尽或无有效回答均报错。

## 权限与隔离边界

- 默认只读。`edit`、`write`、`powershell`、`bash` 必须在 Agent 定义里显式授予；**授权只发生在这一步**：pi 没有内置权限弹窗，也没有沙箱（官方 README：“No permission popups.”，`docs/security.md`：“Pi does not include a built-in sandbox.”）。子会话一旦拿到写工具，就会以与父进程相同的用户权限直接执行，不会再请求确认。
- **并行只对只读 Agent 生效**：工具白名单全部命中只读集合时共享并发槽——内置 `read`/`grep`/`find`/`ls`，以及已知只读的扩展工具：[pi-fff](https://github.com/dmtrKovalenko/fff/tree/main/packages/pi-fff) 的 `ffgrep`/`fffind`/`fff-multi-grep`（`override` 模式下另有 `multi_grep`）和 [pi-web-access](https://github.com/nicobailon/pi-web-access) 的 `web_search`/`source_check`/`fetch_content`/`get_search_content`。其他扩展工具和写入工具一律按未验证处理，独占执行。判定只影响调度，不拒绝调用，现有 Agent 定义无需修改。
- 已知只读名单只看工具名，不检查扩展实现：这几个工具不改动工作目录，写入都在扩展自己的状态目录与临时目录（pi-fff 的索引与 frecency/history 库，pi-web-access 的 `web-search-cache`、`chrome-cookies` 临时副本、GitHub 克隆目录、PDF 产物）。两个扩展都允许在配置里改工具名（`toolNames` / `mode`），改过名的工具不在名单里，会按未验证独占。网络类工具并行会同时占用 provider 配额与速率限制。
- 子会话**不是文件系统沙箱**：与父会话共享工作目录，读取工具也没有路径沙箱；写工具一旦在定义里授予就没有额外拦截。主 Agent 不应与子 Agent 同时修改相同文件；写入型 Agent 也不会与其他子任务重叠。
- 子会话使用内存会话（等价 `--no-session`），关闭扩展、skills、提示词模板和主题的**自动发现**；无持久会话、无递归委派。只有 Agent 显式声明且已安装的 `extensions` 会加载，父会话已加载但未声明的扩展不会继承。
- 模型和认证必须在子会话自己的运行时中可解析（内置 provider、环境变量、普通 `models.json`/认证）。父进程动态注册的 provider、临时 API key 和扩展工具不会被复制；子会话事件中的 provider/model 必须与要求完全一致，不接受静默回退。
- 取消、超时、会话关闭/切换和重载会 `abort()` 并等待会话结束，随后 `dispose()`；同一进程内没有需要终止的进程树。取消后未在宽限期内结束时放弃等待并释放会话，此时不再保证模型请求立即停止。

## 输出限制

模型可见的成功输出有**两层**上限，都是 **50 KiB 或 2000 行**，含截断提示：

- 单个任务：超限时完整回答写入临时目录的 `result.md`，路径同时出现在返回文本和 `details.tasks[].fullOutputPath` 中，可用父 Agent 的 `read` 分段读取。
- 整次调用：逐项结果拼接后再受一次同样的上限；被截断时完整拼接文本写入 `parallel.md`，返回文本的「并行输出已被截断」段给出该路径与各任务自己的截断文件路径。单任务占满配额导致其余任务被整次调用截断时，完整内容仍可从 `parallel.md` 取回。

未截断时不创建任何临时文件，错误诊断最多保留 **8 KiB / 80 行**。临时文件保留至父会话关闭、切换或 `/reload`，之后路径失效。
