# pi-handoff

把活动分支上下文（含 Pi 压缩摘要）整理成中文交接提示词，经用户审阅后交给独立 Pi。**交接正文只写编辑器草稿，绝不调用模型提交、`herdr agent prompt` 或模拟终端粘贴。**

## 使用

先按仓库的 Pi package 配置加载本扩展；开发时也可显式加载：

```powershell
pi --extension E:/pi-extensions/packages/pi-handoff/index.ts
```

```text
/handoff 接下来实现错误恢复             # 默认：当前 workspace 的新 tab
/handoff --tab 接下来实现错误恢复
/handoff --split right 接下来检查类型   # 当前 tab 右分屏
/handoff --split down 接下来整理文档    # 当前 tab 下分屏
/handoff --here 接下来继续工作          # 显式：当前 pane 内切换新会话
/handoff --here -- --tab 是目标正文的一部分
```

目的地参数只能出现在目标之前；`--split` 必须指定 `right` 或 `down`，不能同时选择多个目的地。

命令等待当前任务完成后才提取上下文，保留已有生成、审阅界面和外部编辑器保护。确认审阅后才创建交接包和布局；取消生成／审阅不会创建 tab、pane 或目标会话。确认不会发送提示词。

- 默认 tab／分屏必须从 herdr 管理的交互式 Pi 中调用。环境不足时明确报错，**不会自动降级到 `--here`**。
- herdr CLI 优先使用 `HERDR_BIN_PATH`，否则使用 `PATH` 中的 `herdr`。
- 新布局使用来源 Pi 的 `cwd`，不创建 workspace、worktree，也不复制整个旧对话。
- 来源 Pi 保持原会话和原 pane；目标成功初始化后才聚焦。
- 新会话复用目标名称、直接来源卡片、`parentSession` 和交接链。内存来源没有可链接的 session 文件，但仍记录 session ID。名称、卡片在首次用户消息前可能仅保存在 Pi 内存中，这是 Pi 的持久化语义。

## 配置继承

独立目标使用目标 shell 中 `pi` 命令启动。扩展显式通过绝对路径加载，交接包目录也显式传递，因此不依赖目标恰好安装了同一份 `pi-handoff`。

**模型、thinking、工具、系统提示词、临时 API-key override、CLI 启动参数不从来源复制**；目标按照自身的 Pi 配置和该 cwd 的正常资源发现／信任规则启动。交接包声明 `configuration: "target-defaults"`。herdr 自身设置的终端环境和 shell 正常继承的环境不由本扩展重写。不会自动信任项目、安装依赖、修改官方集成或绕过启动确认。若项目信任／认证／其他扩展阻塞启动，应手动查看目标，不自动回答对话框。

`--here` 保留 Pi 原地新建会话的既有配置语义，不启动另一个进程。

开发依赖基线已更新为 **Pi 1.3.0**；初始 herdr 适配依据 **Pi 1.2.0、herdr 0.9.5、官方 Pi integration v9** 的本地接口编写。目标 shell 的 `pi` 应支持这些 API；不会替换或升级 Pi/herdr。目标必须能访问同一台机器的交接目录与扩展路径；不支持跨机器／SSH 交接。

## 初始化协议与安全

```text
来源：生成 → 审阅 → 来源编辑器备份 → 私有交接包
herdr：tab create / pane split --no-focus → agent start --kind pi
目标：扩展完成 session_start → 调度内部命令 → 一次性领取
      → ctx.newSession({ parentSession, setup, withSession })
      → 名称／来源记录 → 新上下文 setEditorText → ready 回执
来源：校验回执 pane ID → 删除交接包 → 校验目标 agent／session 身份 → agent focus
```

- 不使用 CLI `initialMessage`。启动 argv 只有扩展路径、`--pi-handoff-init <随机 ID>`、`--pi-handoff-store <私有目录>`，没有提示词、目标正文、模型或凭据。
- 扩展只在首次 `session_start: startup` 后的资源发现阶段安排一次异步内部 slash 命令。命令调度明确启用 Pi 的扩展命令分派；正文从不走 `sendUserMessage`。生命周期处理器不调用 `ctx.newSession()`。新建／恢复／reload 不重新调度；shutdown 清除待调度任务。
- 这样即使目标扩展未能加载，也没有启动提示词可落入模型。命令仅在已注册时分派；错误不会退回正文提交。
- 包只含已审阅提示词、goal、来源及交接链、cwd、配置策略和版本／有效期，没有完整历史或凭据。包上限 4 MiB，ID 为 256 位随机数，限制为固定格式，拒绝路径穿越、符号链接目录、异常文件与错误版本。
- 目录位于 `<来源 getAgentDir()>/handoffs/<ID>/`，通常是 `~/.pi/agent/handoffs/`。POSIX 目录 `0700`、文件 `0600`；Windows 创建载荷前使用 PowerShell 设置并校验**仅当前用户**可访问、可继承的 DACL，不能用 `chmod` 假装保护 Windows 文件。权限设置失败即停止，不回退到公共临时目录。这不防同一用户的恶意进程或具有系统特权的管理员。
- 目标用独占 `claimed` 文件取得一次性消费权，核对绑定的 pane 和真实 cwd。失败也不会释放领取权重试；用户应重新执行一次审阅交接。来源只接受正确包／pane 的 `ready` 回执；回执在完整草稿写入并回读验证后原子发布。
- 官方 integration v9 继续负责 session 身份上报；聚焦前除 pane／terminal／agent 名称外，还核对它报告的 session ID 或路径与回执一致，避免目标已切换会话时错误聚焦。官方集成缺失或报告失败也会拒绝聚焦。本扩展不修改它、不重复上报 agent/session 状态，也不自行实现 herdr socket 控制。

## 超时、失败与清理

- 从包创建开始，初始化有效期 **120 秒**；herdr agent 就绪等待 **60 秒**，CLI 外层另留 10 秒退出余量。布局创建／聚焦等 CLI 调用也有独立超时。
- 不对布局创建、Pi 启动或聚焦做自动重试。超时不表示操作没有生效：布局或 Pi 可能已存在。
- 初始化失败、取消／超时、CLI 错误、目标身份改变均明确报错，不自动聚焦或切换交接方式。创建的 pane／Pi 不自动关闭，便于检查错误、避免杀掉已经启动的工作。
- 确认审阅后，来源编辑器先保留交接草稿，成功后仅在它未被用户修改时恢复原编辑器内容。失败时保留这份草稿；仍有编辑器备份时撤销并删除包。若来源关闭／切换会话，或用户已改动备份，则撤销包并保留私有载荷供手动恢复，错误信息包含目录位置；目标不会再凭此包重新初始化。
- 恢复时手动读取该目录的 `package.json` 中 `prompt` 字段并放入编辑器，不要把 JSON 或初始化命令当作 LLM 提示词。恢复后可删除该 ID 目录。
- 成功时删除整个包目录（载荷、领取标记、回执）。异常退出遗留包及保留的恢复包在 **24 小时后、下一次来源交接创建包时**清理，不运行后台清理服务；若不再使用交接，它们不会自行消失，可手动删除。
- 已领取的目标在切换和填草稿前复查撤销／有效期。临界超时可能发生在目标已经填好草稿、来源尚未看到回执之间：来源仍报失败、不聚焦并保留备份，不宣称目标未启动，更不会再次提交或重试。草稿不等于持久化会话，退出 Pi 前应自行保存需要的内容。

## 验证

在仓库根目录：

```powershell
pnpm tsc
pnpm test:handoff
```

测试使用 Node 内建 test runner 和 TypeScript strip-types，不引入依赖。覆盖参数、私有包往返／权限、一抢一领、撤销／过期、坏数据、回执、清理、CLI argv、分屏 ID、初始化顺序／草稿、取消、启动与聚焦错误、无回执超时和重复消费。Windows 测试会在独立临时目录中实际设置 DACL，测试结束后删除；herdr 控制和 Pi 上下文均用 mock，**不创建真实 tab／pane、不启动 Pi、不调用模型**。

这些测试与类型检查不是 herdr 端到端成功的证据。真实验收需要用户允许后在 herdr 中执行上述命令，分别检查新 tab／两种分屏、保持原 pane、来源卡片／会话名称、中文多行草稿、目标未发起模型请求、成功后聚焦，以及启动阻塞／失败的恢复。该验收会创建真实 pane／进程，本次实现未自动执行。

接口依据：本地 Pi 类型声明、`AgentSession.prompt/sendUserMessage` 与交互模式源码；herdr 0.9.5 的本地 CLI help，以及固定 tag 的 [agent CLI](https://github.com/herdrdev/herdr/blob/v0.9.5/src/cli/agent.rs)、[agent schema](https://github.com/herdrdev/herdr/blob/v0.9.5/src/api/schema/agents.rs) 和 [pane schema](https://github.com/herdrdev/herdr/blob/v0.9.5/src/api/schema/panes.rs)。
