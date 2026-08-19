# dsh-smart-route 外部通道接入 — 实施计划（C 档）

> 关联设计文档：`docs/外部通道接入设计.md`（已定稿 2026-08-17）
> 状态：**计划定稿，待用户确认「开始」后执行**。未开始任何代码/配置改动。

---

## 1. 目标

让用户在 Harness 之外的目录（如 `~/.dsh/channels/`）放一个「本地 url + key + models」通道文件（`.jsonc`/`.json`），smart-route 自动扫描为**半注册渠道池**；用户按需在设置卡**手动新建链 / 填写渠道**（`provider` 填通道 id），url + key 由插件自动补全。全程不改 `settings.yaml`、`cordis.patch.yml`、`llm-pi-ai`。

一句话使用流程：**放文件 → 插件扫到（状态面板可见）→ 设置卡建链引用通道 id → 选这条链聊天**，报错自动冷却切下一家。

---

## 2. 已确认决策点（2026-08-17 用户确认）

| # | 决策 | 定案 |
|---|---|---|
| 1 | `channelDir` 默认值 | 默认 `''`（空 = 关闭），显式配置才启用，避免行为突变 |
| 2 | 建链方式 | **不自动生成外部链**；用户经设置卡手动新建链 / 编辑链，`provider` 填外部通道 id（如 `opencode-free`），url + key 由插件从文件自动补全；entry 显式填 baseUrl 可覆盖文件值 |
| 3 | key 方式 | **支持明文 `apiKey` 写入通道文件**（本地信任模型）；`apiKeyEnv` 优先于明文 |
| 4 | opencode 导出脚本 | **不做**（不解析 opencode.jsonc / auth.json） |

### 2.1 待实测点

1. 外部通道清单能否经 settings snapshot 透传给 client（`dsh-settings` `scope.get()` 是否剥离未知字段）：
   - 能 → 设置卡渠道编辑行加「外部通道 ▾」下拉，点选一键填充 provider + 默认 model（改动 G 完整版）；
   - 不能 → 用户手填通道 id，README 列出可用 id 清单（改动 G 降级为 hint 文案）。
2. `webServer.register` 挂载 `POST /api/dsh-smart-route/refresh` 的实际可用性（类型契约已确认，需沙盒实测挂载 + 请求返回）。

两者都不影响 host 端核心功能。

---

## 3. 质疑与回应（落盘）

| # | 质疑 / 隐患 | 回应与处理 | 状态 | 验收 |
|---|---|---|---|---|
| 1 | `fs.watch` 在 Windows/网络盘可能漏报文件变更 | `fs.watch` 为自动主机制（秒级）；**不引入常驻轮询**（通道变更低频，轮询是空转）。漏报时手动刷新：`POST /api/dsh-smart-route/refresh`（webServer 路由）+ `refresh-channels.cmd` 一键脚本 | 已定案，实施时落地 | 用例 #6：fs.watch 秒级生效；手动 POST refresh 亦立即生效 |
| 2 | 通道文件是 Harness 外信任源（url+key），被篡改即被冒用 | 只放本地用户目录；README 明确「勿提交 git」并给 .gitignore 建议；状态面板可审计每个通道的文件路径与加载状态 | 已定案，实施时落地 | 用例 #4/#5：坏文件/冲突被跳过 + warn，状态面板可见错误原因 |
| 3 | 当前 opencode 桥接不支持 tools，含外部通道的编码会话会失败 | 不是插件缺陷：请求在流式开始前失败 → 正确回退 + 冷却（`forwardedContent` 保护已有 L454-457）；桥接未来支持 tools 后自动受益 | 已定案（依赖现有机制） | 用例 #9：tools 请求在上游不支持时流式开始前失败并回退，不污染已输出内容 |
| 4 | 新增补全规则（entry 覆盖 baseUrl；model 不在通道 `models` 列表则跳过）未经真实上游验证，models 写不全可能误杀可用模型 | 沙箱用例 #11/#12 实测；**预案**：若实测发现误杀，把「跳过」降级为「照发 + 警告日志」——一处布尔开关（`strictModelCheck`，默认 true），实施时按实测结果二选一 | 待实施时实测后定案 | 用例 #11（补全/覆盖规则 + 日志证据）、#12（跳过规则） |

---

## 4. 实施步骤（C 档，约 1–1.5 小时）

1. **编码 host**（`lib/index.js`，改动 A–F，约 150–250 行）：
   - A. `Config` 加 `channelDir`（带 `.default('')`，无配置也能启动）；
   - B. 扫描器 `scanChannelDir` / `parseChannelFile`（容错：单文件错只记日志）；
   - C. `openAiCompatStream` 加 `apiKeyLiteral` 注入（明文 key 优先，其次 launchEnv 的 apiKeyEnv）；
   - D. entry 解析补全（provider 命中渠道池 → 补 baseUrl/key/contextWindow；model 不在通道内 → 按 §3-4 的开关处理）；
   - E. `apply()` 加 `fs.watch`（自动，秒级）+ 注册 `webServer` 路由 `POST /api/dsh-smart-route/refresh`（手动刷新，不回显 key），`ctx.effect`/`ctx.on` 注册 disposer；
   - F. RPC `status` 暴露 `externalChannels`。
2. **透传实测 + 端点实测**：沙盒验证 settings snapshot 能否携带 externalChannels（决定 G 形态）；验证 webServer 路由挂载后 curl 可触发刷新。
3. **编码 client**（`lib/client.js`，改动 G，可选增强）：
   - 透传可行 → provider 输入框旁「外部通道 ▾」下拉；
   - 不可行 → 渠道编辑 hint 文案列出可用 id。
4. **刷新脚本**：新增 `refresh-channels.ps1` / `.cmd`（`Invoke-RestMethod` / `curl -X POST http://127.0.0.1:3080/api/dsh-smart-route/refresh`，打印通道清单）。
5. **沙箱验收 12 项**（桩 `llm/settings/connection` + 临时 channelDir，每项日志证据落盘）：
   空配置 / 目录不存在 / 合法文件 / 非法文件 / id 冲突 / 热更新（fs.watch + 手动 POST 各一次）/ 删除下线 / 失败降级 / tools / 真实链路(4107 桥接) / entry 补全覆盖 / model 跳过。
6. **部署**：确认 profile 部署方式（junction）→ 重启 `dsh web`（**走重启红线，先向用户二次确认**）→ 页面渲染 + 设置卡建链 + 选链发消息真实返回 + `refresh-channels.cmd` 实测。
7. **文档**：README 更新（通道文件格式、可用 id 清单、刷新脚本、信任边界提示）；经验库沉淀。
8. **收尾复查**：对照 §3 四项验收全部通过后方可收工。

---

## 5. 验收标准（什么算修好）

- 沙箱 12 项用例全部通过，日志证据落盘；
- 不启用 `channelDir` 时行为与 v1.0.0 完全一致（零回归）；
- 真实链路：通道文件指向 `http://127.0.0.1:4107/v1` → 设置卡建链引用 → 链请求真实返回文本；
- 重启后页面正常，模型选择器仍只显示链名，无新增 provider 噪声；
- 回退验证：`git restore` 插件目录 + 重启 → 行为回到 v1.0.0，无配置残留。

---

## 6. 回退方案

- 插件源码 `git restore` → 重启 → 行为回到 v1.0.0（新字段全带 `.default()`，回退无残留状态）；
- 不改 `cordis.patch.yml`、不写 `settings.yaml`，回退零配置改动；
- 外部通道文件删除即下线，不产生任何 Harness 状态。

---

## 7. 那么，代价是什么？（摘要）

1. **信任面外移**：通道文件可被篡改（url+key 冒用）——只放本地目录 + README 防 git 提交 + 状态面板审计（§3-2）。
2. **热更新靠 fs.watch + 手动刷新**：漏报时跑一次 `refresh-channels.cmd` 即可，无常驻轮询（§3-1）。
3. **通道文件格式成为插件 API**：升级需向后兼容，`version`/`$schema` 留二期。
4. **不解决「免费编码」**：桥接不支持 tools 时，含外部通道的编码会话降级到下一家（§3-3）。
5. **重启要求**：插件代码改动必须重启 `dsh web` 生效，遵守重启红线二次确认。

---

## 8. 执行开关

- 用户说「开始」→ 按 §4 执行；
- 执行中若发现超出 C 档范围（如需要改 dsh-settings 本体、出现未预料的机制问题）→ 暂停并重新授权。
