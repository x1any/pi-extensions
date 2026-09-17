# pi-btw

提供一个 `/btw` 斜杠命令：把「顺便问一句」的临时问题交给当前模型回答，答案显示在临时 overlay 中。提问与回答都不会写入会话历史。

## 安装

在本仓库根目录执行：

```powershell
pi install ./packages/pi-btw
```

安装后在已有会话中执行 `/reload`，或重新启动 Pi。

## 使用

```
/btw 刚才读的那个文件里，为什么用 queueMicrotask 而不是 Promise.resolve？
```

- 命令会把当前会话分支的消息序列化成上下文，连同问题一起发给当前模型；
- 答案显示在居中的 overlay 中，整页一起滚动：

| 按键 | 作用 |
| --- | --- |
| `Esc` / `Ctrl+C` / `Space` / `q` | 关闭 overlay |
| `↑` `↓` / `k` `j` | 逐行滚动 |
| `PgUp` / `PgDn` | 翻页 |

overlay 顶部第三行显示本次调用的模型，以及 provider 上报时的 token 数与费用。

## 行为与限制

- **只读上下文**：用 `buildSessionContext` 读取当前分支，不调用 `appendEntry` 或任何写入 API；主会话历史与上下文统计都不受影响。
- **无工具**：`/btw` 的请求不带工具，模型只能依据上下文中已有的信息回答；上下文不足时系统提示要求它直接说明。
- **上下文序列化**：工具结果每条最多保留 20000 字符（远高于压缩摘要的 2000 字符上限），被截断的部分以 `[... N more characters truncated]` 标记；图片以 `[image: <mime type>]` 占位，不静默丢弃。
- **请求组装**：通过 `ctx.modelRegistry.complete` 发起调用，鉴权（apiKey / headers / baseUrl / env）与请求头转换和普通会话一致；鉴权失败会直接报错，不会退回环境变量密钥。
- **取消与超时**：`Esc` 可随时取消；单次请求 5 分钟超时（provider 支持时生效）。
- **非 TUI 模式**：`print` 模式把答案打印到 stdout，`json` / 其他模式通过通知返回，不显示 overlay。

## 开发

纯逻辑都放在 `btw.ts`，不依赖 pi 运行时，可直接用 Node 内置测试运行器验证：

```powershell
npm test -w pi-btw
```

覆盖范围：参数校验、上下文序列化（截断 / 图片占位 / 工具错误标注）、usage 格式化、overlay 滚动计算。
