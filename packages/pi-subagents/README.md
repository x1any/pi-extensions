# pi-subagents v0.1

一个同步、单任务的 `subagent` 工具：主 Agent 指定角色和完整任务，子 Agent 在独立会话中执行，只把最终回答返回给主 Agent。

基于 **Pi 0.85.1 SDK**，子会话在父进程内用 `createAgentSession` 创建，不启动 Pi CLI 子进程，不提供跨版本兼容层。目前仅完成静态核查，尚未运行验收。

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

```ts
subagent({
  agent: "scout",
  task: "调查 src/auth 的认证入口及主要调用链。只读、不运行命令。返回文件路径、关键行号、输入输出契约和待确认项。"
})
```

只接受 `agent` 和 `task`。任务必须自包含（背景、路径、限制、期望输出），子 Agent 不知道父会话历史；工作目录固定为父会话 `cwd`。

- 所有调用共用一个执行槽，多出的排队；排队和执行都可取消。
- 固定执行超时 **10 分钟**，从获得执行槽后计时，不含排队。
- 进度通过 `onUpdate` 报告状态和最近工具，没有自定义面板。
- 成功结果只包含最后一条 assistant 消息的文本块（不含 thinking、中间回答、工具日志）；模型错误、认证失败、输出长度耗尽或无有效回答均报错。

## 权限与隔离边界

- 默认只读。`edit`、`write`、`powershell`、`bash` 必须显式授予，且执行写入仍须用户对当前任务授权。
- 子会话**不是文件系统沙箱**：与父会话共享工作目录，读取工具也没有路径沙箱。主 Agent 不应与子 Agent 同时修改相同文件。
- 子会话使用内存会话（等价 `--no-session`），关闭扩展、skills、提示词模板和主题的**自动发现**；无持久会话、无递归委派。只有 Agent 显式声明且已安装的 `extensions` 会加载，父会话已加载但未声明的扩展不会继承。
- 模型和认证必须在子会话自己的运行时中可解析（内置 provider、环境变量、普通 `models.json`/认证）。父进程动态注册的 provider、临时 API key 和扩展工具不会被复制；子会话事件中的 provider/model 必须与要求完全一致，不接受静默回退。
- 取消、超时、会话关闭/切换和重载会 `abort()` 并等待会话结束，随后 `dispose()`；同一进程内没有需要终止的进程树。取消后未在宽限期内结束时放弃等待并释放会话，此时不再保证模型请求立即停止。

## 输出限制

模型可见成功输出至多 **50 KiB 或 2000 行**，含截断提示。超限时完整回答写入临时目录的 `result.md`，路径同时在返回内容和 `details.fullOutputPath` 中给出，可用父 Agent 的 `read` 分段读取；临时文件保留至父会话关闭、切换或 `/reload`，之后路径失效。未截断时不创建任何临时文件，错误诊断最多保留 **8 KiB / 80 行**。
