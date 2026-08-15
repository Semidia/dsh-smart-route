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

## 安装

1. 将本包放入工作区，例如 `插件开发/dsh-smart-route`。
2. 在 profile 的 node_modules 建 junction：

   ```powershell
   New-Item -ItemType Junction `
     -Path "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-smart-route" `
     -Target "D:\ds harness默认工作区\插件开发\dsh-smart-route"
   ```

   该 profile junction 会被 Node ESM 解析为真实工作区路径。还必须让本包能解析 DSH peer dependencies：

   ```powershell
   New-Item -ItemType Junction `
     -Path "D:\ds harness默认工作区\插件开发\dsh-smart-route\node_modules" `
     -Target "D:\DeepSeek Harness\node_modules"
   ```

   这会复用 Harness 当前安装的 `@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-settings`、`@deepseek-ai/cordis` 和 `@deepseek-ai/schemastery`，不会另行安装或复制依赖。

3. 在 `cordis.patch.yml` 末尾追加：

   ```yaml
   - insert:
       - id: dsh-smart-route
         name: 'dsh-smart-route'
         config:
           enabled: true
           defaultChain: default
           chains:
             default:
               - provider: deepseek-official
                 model: deepseek-v4-flash
               - provider: yunzhou
                 model: 'DeepSeek-V4-Flash[free]'
               - provider: mze
                 model: deepseek-v4-flash
   ```

4. 重启 `dsh web` 生效。

## 使用

- **对话栏按钮**：模型选择旁出现"智能路由"胶囊按钮（绿点 = 启用）。点击弹出面板，切换启用/停用，查看冷却中的渠道。
- **设置卡**：设置 → 插件 → 智能路由，编辑默认链的渠道顺序，保存后下一个请求即生效。

## 原理

- Host 半区注册虚拟 provider `smart-route` 的 `LlmAdapter`，`stream()` 按链顺序调用 `ctx.llm.stream({...options, provider, model})` 分派到真实 provider；任何 `error` finish 都触发冷却并切下一家。
- 配置段存在 `smart-route` settings namespace（`~/.dsh/settings.yaml`），对话栏按钮和设置卡通过 loopback RPC 读写。
- 只依赖 `ctx.llm` 与 `ctx.settings`，不自己实现 HTTP 传输（复用 DSH 已注册的 provider 适配器）。

## 许可证

MIT
