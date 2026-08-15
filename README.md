# dsh-smart-route（智能路由）

在 DeepSeek Harness Web 里做**供应商自动路由**，作为 polyglot 的替代。针对 polyglot 的四个痛点重新设计：

1. **全错误降级**：任何渠道报错（包括 4xx `INVALID_REQUEST`、`AUTH`、`HTTP_xxx`）都会自动尝试下一家，不再只看限流/5xx。
2. **一键停用开关**：对话栏按钮 + 设置卡都能一键启用/停用整个路由，停用后模型请求直连默认渠道。
3. **对话栏状态按钮**：composer 工具行（模型选择旁）常驻按钮，显示路由开关状态，点击弹出面板查看默认链、可用渠道、冷却中的渠道。
4. **模型列表干净**：只注册一个虚拟 provider `smart-route`，不注册一堆 configurable provider，模型选择器不会冒出一堆渠道模型。

## 功能

- **渠道链**：按顺序配置真实 provider（`deepseek-official`、`yunzhou`、`mze` 等，必须是 DSH 已注册的 provider），从上到下尝试。
- **自动回退**：某个渠道失败（错误、超时、限流、4xx、鉴权失败、传输错误）→ 冷却该渠道 → 自动切下一家；链上全部失败才返回最终错误。
- **冷却**：失败渠道进入冷却（指数退避 + 抖动），冷却期内跳过。
- **启用/停用**：停用后 `smart-route` 虚拟 provider 直接拒绝请求（错误码 `DISABLED`），提示用户在对话栏或设置中启用。
- **渠道级 URL**：每个渠道可声明 `baseUrl` / `apiKeyEnv`，声明了 `baseUrl` 的渠道走内置 OpenAI 兼容分派（fetch + SSE），未声明的复用 DSH 已注册 provider。
- **多链管理**：设置卡可新建 / 删除 / 切换默认链。

## 安装

```sh
dsh plugin --profile web add github:Semidia/dsh-smart-route
dsh web
```

重启 `dsh web` 后刷新页面。默认链为 `deepseek-official + deepseek-v4-flash`，可在设置卡或 `cordis.patch.yml` 里改。

## 使用

- **对话栏按钮**：模型选择旁出现"智能路由"胶囊按钮（绿点 = 启用）。点击弹出面板，切换启用/停用，查看冷却中的渠道。
- **设置卡**：设置 → 插件 → 智能路由，编辑默认链的渠道顺序，保存后下一个请求即生效。

## 原理

- Host 半区注册虚拟 provider `smart-route` 的 `LlmAdapter`，`stream()` 按链顺序调用 `ctx.llm.stream({...options, provider, model})` 分派到真实 provider；任何 `error` finish 都触发冷却并切下一家。
- 配置段存在 `smart-route` settings namespace（`~/.dsh/settings.yaml`），对话栏按钮和设置卡通过 settings 域读写。
- 依赖 `ctx.llm` / `ctx.settings` / `ctx.connection`，内置 OpenAI 兼容分派（渠道声明 `baseUrl` 时）。

## 已知问题（rc.6）

- **设置 UI 依赖上游白名单**：settings RPC 域只服务 `dsh-host-apiproxy` 白名单内的命名空间（`WEB_SETTINGS_NAMESPACES`）。上游合并「插件自行暴露命名空间」的改动前，设置卡会显示"命名空间未暴露"（本部署已通过本地补丁解决；核心路由功能不依赖设置 UI，无配置也能按默认链工作）。上游进展见 [deepseek-ai/deepseek-harness discussion #1877](https://github.com/deepseek-ai/deepseek-harness/discussions/1877)。

## 许可证

MIT
