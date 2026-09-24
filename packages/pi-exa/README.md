# pi-exa

用 Exa 托管的 [MCP 服务](https://docs.exa.ai/reference/exa-mcp)提供两个原生 Pi 工具：`web_search` 和 `web_fetch`。直接使用 Node 的 `fetch` 实现所需的 Streamable HTTP 子集；无通用 MCP 桥接器或额外运行时依赖。

## 安装

代码推送到 GitHub 后，使用单仓库 Git 来源安装：

```powershell
pi install git:github.com/x1any/pi-extensions
```

这个来源安装的是**整个仓库**，不是单独的 `pi-exa`。请在 Pi 的 `packages` 资源过滤器中只启用所需扩展（至少 `packages/pi-exa/index.ts`）；同时使用 DeepWiki / 子 Agent 时参见 [pi-subagents 的 Git 安装说明](../pi-subagents/README.md#github-monorepo)。本地开发仍可在仓库根目录用 `pi install ./packages/pi-exa`，单次试用可用 `pi -e ./packages/pi-exa`。在已有会话中执行 `/reload` 或重新启动 Pi 后生效。

如果已经启用其他提供 `web_search` / `web_fetch` 的扩展（例如旧版 `./.pi/exa.ts` 或 pi-web-access），先停用旧扩展，避免同名工具冲突。本包**不会**修改 Pi 配置或卸载其他扩展；旧版 `./.pi/exa.ts` 不会被本包加载。

## 工具

| Pi 工具 | Exa MCP 工具 | 参数 |
| --- | --- | --- |
| `web_search` | `web_search_exa` | `query`，可选 `numResults`（1–100，Exa 默认 10） |
| `web_fetch` | `web_fetch_exa` | `urls`（1–10 个 HTTP(S) URL），可选 `maxCharacters`（每页字符数，Exa 默认 3000） |

```ts
web_search({ query: "Exa MCP server documentation", numResults: 5 })
web_fetch({ urls: ["https://docs.exa.ai/reference/exa-mcp"], maxCharacters: 5000 })
```

默认无需密钥，但 Exa 对匿名请求有限速。如有 API key，启动 Pi 前设置环境变量 `EXA_API_KEY`；扩展通过 `x-api-key` 请求头发送密钥，不写入 URL、日志或文件。这里只实现 API key 与匿名访问，不实现 OAuth 登录。

首次调用才与 `https://mcp.exa.ai/mcp` 建立 MCP 会话。网络请求超时 120 秒并支持取消；会话失效时对只读工具自动重新连接一次。结果最多返回约 50 KiB / 2000 行，超限时将完整文本写入临时 Markdown 文件并在结果中给出路径；临时文件在 Pi 会话关闭或 `/reload` 后删除。Exa 返回错误时工具会报错，不会把错误伪装成搜索结果。

这不是 pi-web-access 的完整替代品：只支持 Exa 的基础搜索和网页抓取，不提供多提供商检索、来源核验、网页缓存或视频/PDF 专用处理。
