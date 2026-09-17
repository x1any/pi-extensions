# pi-deepwiki

把官方 [DeepWiki MCP](https://docs.devin.ai/work-with-devin/deepwiki-mcp) 包装成三个原生 Pi 工具，用于读取公共 GitHub 仓库的 AI 文档和进行代码库问答。不需要 API key，也不需要安装通用 MCP 适配器。

## 安装

在本仓库根目录执行：

```powershell
pi install ./packages/pi-deepwiki
```

安装后在已有会话中执行 `/reload`，或重新启动 Pi。

## 工具

| Pi 工具 | DeepWiki MCP 工具 | 用途 |
| --- | --- | --- |
| `deepwiki_read_wiki_structure` | `read_wiki_structure` | 列出仓库的文档主题与层级 |
| `deepwiki_read_wiki_contents` | `read_wiki_contents` | 读取仓库的完整生成文档 |
| `deepwiki_ask_question` | `ask_question` | 基于一个或多个仓库进行问答 |

调用示例：

```ts
deepwiki_read_wiki_structure({ repoName: "facebook/react" })

deepwiki_read_wiki_contents({ repoName: "earendil-works/pi" })

deepwiki_ask_question({
  repoName: "facebook/react",
  question: "Fiber 调度的主要入口和调用流程是什么？"
})

deepwiki_ask_question({
  repoNames: ["facebook/react", "preactjs/preact"],
  question: "两个仓库的协调算法有哪些主要差异？"
})
```

`repoName` 使用 `owner/repo` 格式。`deepwiki_ask_question` 的 `repoName` 与 `repoNames` 二选一；`repoNames` 最多 10 个。

## 实现与限制

- 固定连接官方 Streamable HTTP 端点 `https://mcp.deepwiki.com/mcp`。
- 首次调用时执行 MCP `initialize` 和 `notifications/initialized`，随后调用对应的 `tools/call`；兼容 JSON 与 SSE 响应。
- 每次网络请求最多等待 3 分钟，并响应 Pi 的取消信号。
- 工具结果最多返回 50 KiB 或 2000 行。超限时完整 Markdown 写到临时目录，路径会包含在结果中；临时目录在会话关闭、切换或 `/reload` 时删除。
- 免费 DeepWiki MCP 只支持公共 GitHub 仓库。私有仓库需要 Devin MCP、Devin 账号和 API key，不在这个扩展的范围内。
- 这是针对 DeepWiki 三个公开工具的专用客户端，不是通用 MCP 适配器。
