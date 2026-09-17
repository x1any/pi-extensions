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
| `extensions` | 可选，只在本子会话加载的扩展来源（本地路径或已安装来源，如 `npm:pi-web-access`）；省略或 `[]` 为不加载，来源未安装或不可用时拒绝启动。不会安装或下载任何东西；来源随包提供的 skills 会一并加载 |
| `model` | 可选，完整 `provider/model`，默认继承父会话当前模型 |
| `thinking` | 可选，`off/minimal/low/medium/high/xhigh/max`，默认继承父会话 |

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

并发与取消：

- 工具白名单全部命中只读集合的 Agent 最多同时运行 **3 个**，多出的按 FIFO 排队，上限作用于父会话内**全部** subagent 调用。只读集合为内置 `read`/`grep`/`find`/`ls`，加上 [pi-fff](https://github.com/dmtrKovalenko/fff/tree/main/packages/pi-fff) 的 `ffgrep`/`fffind`/`fff-multi-grep`（`override` 模式下为 `multi_grep`）、[pi-web-access](https://github.com/nicobailon/pi-web-access) 的 `web_search`/`source_check`/`fetch_content`/`get_search_content`、context7 的 `resolve-library-id`/`query-docs`。
- 含 `edit`、`write`、`powershell`、`bash` 或名单外扩展工具的 Agent 无法静态判断是否写盘，**独占整个池**，放进 `tasks` 数组也串行执行。
- 排队和执行都可取消：已结束的任务保留结果，运行中的被中止，尚未开始的标记为已取消。固定执行超时 **10 分钟**，从获得执行槽后计时，不含排队。
- 单个任务失败不影响其他任务，**部分失败不抛错**（失败项在文本里标明原因）；全部失败才抛错。
- 工具行显示 task 摘要；结果行逐任务显示状态（失败/超时/取消时写明原因）、最近工具、耗时与答案预览，`ctrl+o` 展开明细与完整回答；进行中的任务在 footer 汇总（`subagents ◐2 ✓1 · scout-fff 使用工具（ffgrep）`），结束后清空。
- 成功结果只含最后一条 assistant 消息的文本（不含 thinking 与工具日志）；模型错误、认证失败、输出耗尽或无有效回答均报错。

## 权限与隔离边界

- 默认只读，`edit`、`write`、`powershell`、`bash` 必须在 Agent 定义里显式授予——**授权只发生在这一步**：pi 没有权限弹窗，也没有沙箱。子会话与父会话共享工作目录，拿到写工具后即以相同用户权限直接执行，主 Agent 不应与子 Agent 同时修改相同文件。
- 只读判定只看工具名：名单内的工具不改动工作目录，改过名的（pi-fff 与 pi-web-access 都允许 `toolNames` / `mode` 改名）按未验证独占；网络类工具并行会同时占用 provider 配额与速率限制。
- 子会话是独立运行时：内存会话，关闭扩展、skills、提示词模板和主题的**自动发现**，无持久会话、无递归委派；只加载 Agent 显式声明且已安装的 `extensions` 及随包 skills，父会话的扩展与 skills 都不继承。模型和认证必须在子会话自己的运行时中可解析（内置 provider、环境变量、`models.json`/认证），父进程动态注册的 provider、临时 API key 与扩展工具不会被复制，provider/model 不接受静默回退。
- 取消、超时、会话关闭/切换和重载会中止子会话并释放资源；未能在宽限期内结束时会放弃等待，此时不再保证模型请求立即停止。

## 输出限制

模型可见的成功输出有**两层**上限，都是 **50 KiB 或 2000 行**，含截断提示：单个任务超限时完整回答写入临时目录的 `result.md`，路径出现在返回文本中，可用父 Agent 的 `read` 分段读取；整次调用在逐项拼接后再受一次同样上限，被截断时完整拼接文本写入 `parallel.md`。未截断时不创建任何临时文件，错误诊断最多保留 **8 KiB / 80 行**；临时文件保留至父会话关闭、切换或 `/reload`。
