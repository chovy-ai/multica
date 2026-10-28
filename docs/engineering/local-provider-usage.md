# 本机对话流用量

输入框的模型选择器左侧显示用量入口，展开后区分当前会话上下文与运行器账号的剩余额度。沿用宿主现有组件和 Multica 语义样式，不修改 vendored GUI、官方服务器或用户 CLI 配置。

浮层内的刷新操作保持打开；点击对话正文、应用侧栏、工具栏或搜索框时关闭。父文档通过现有私有端口发送 `dismissPopovers`，补齐 iframe 外点击无法冒泡的边界；子文档失去焦点、切换会话或隐藏时也关闭。来自宿主的关闭不恢复触发按钮焦点，避免抢走刚点击的宿主控件焦点。Escape 继续使用组件默认行为。

## 数据流与来源

```text
宿主用量入口 → usage.read → 桌面本机服务 → 作用域校验
  ├─ 当前会话的原生记录：最新主会话输入与上下文窗口
  └─ 本机 CLI 只读控制协议：账号额度与重置时间
```

- Claude Code：仅执行 `initialize`、`get_usage`，使用 `--no-session-persistence`；已有会话通过原生 ID 只读恢复，以取得对应模型的真实 `contextWindow`。上下文输入用量为最新主会话的 `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`，不累加历史轮次，不包含输出或子智能体用量。该计算与 [Claude Code 官方上下文说明](https://code.claude.com/docs/en/statusline#context-window-fields) 一致。
- Codex：使用本机 `app-server` 的 `account/rateLimits/read`；不创建线程或启动运行。上下文读取对应原生记录最新 `token_count` 的 `last_token_usage.total_tokens` 与 `model_context_window`，不再加一次缓存 token。
- 两者都使用当前桌面进程的 CLI 环境和本机账号。查询不发送模型提示词，不读取或向界面传递 Key、Token、账号邮箱和完整原生消息。

RPC 和 IPC 都新增内部 `usage` 读取能力，未改变官方服务 API。会话 ID 必须属于当前账号与工作区，且与指定运行器一致；切换账号时清理缓存、终止用量查询。

底部控件以当前会话的 `agent_id` 确定运行器，只有新会话才使用侧栏默认选择。原先直接使用 GUI 的侧栏选择，可能在切换已有会话后保留上一个运行器；现在模型和用量都跟随会话归属。端到端回归在修复前复现 Claude 会话仍显示 Codex，修复后覆盖 Codex → Claude → Codex 往返、草稿恢复和用量请求的运行器校验；实窗也完成相同往返复核。

## 显示与刷新

- 上下文显示当前上下文 token、窗口上限和已用比例；账号额度显示每个真实窗口的剩余比例和本地时区重置时间。两者分开，不能用上下文 token 估算订阅余量。
- 入口的账号摘要只取整体窗口，不把无关模型的单独限额当作整体额度。Codex 的 primary 窗口不假定为 5 小时，而是读取实际窗口长度。
- 当前可见、活动桌面每分钟更新；回复完成或重新聚焦时刷新，也可手动刷新。主进程复用一分钟缓存，合并并发查询，并对正常数据的手动刷新做短暂缓存；失败后的显式重试可立即重新查询。
- 缺失字段显示暂无数据或上限未提供。旧版本 CLI 不支持用量控制协议、网络失败时不会伪造 0% / 100%；保留的数据明确标为上次数据。到期窗口显示等待刷新。
- 用量数据只在主进程内存缓存，不写入用户对话，不修改原生执行历史。只扫描已关联的原生会话记录，单次最多读取末尾 2 MB；没有可读主会话用量时显示暂无数据。

## 验证

```sh
pnpm --filter @multica/desktop test src/local-host/local-provider-usage.test.ts src/local-host/local-conversation-service.test.ts src/renderer/src/platform/local-conversation-service.test.ts
pnpm --filter @multica/tutti-agent-gui-host test
pnpm --filter @multica/tutti-agent-gui-host typecheck
pnpm --filter @multica/desktop typecheck
pnpm exec eslint --config apps/desktop/eslint.config.mjs packages/tutti-agent-gui-host/src/usage-indicator.tsx e2e/local-provider-gui.spec.ts apps/desktop/src/local-host/local-provider-usage.ts apps/desktop/src/local-host/local-provider-usage.test.ts
pnpm --filter @multica/tutti-agent-gui-host build
make env-exec ARGS='-- pnpm exec playwright test e2e/local-provider-gui.spec.ts --trace retain-on-failure'
git diff --check
```

19 项桌面相关测试、34 项宿主测试通过；隔离浏览器端到端验证覆盖用量、上下文、额度窗口、刷新失败保留旧数据、运行器切换及草稿恢复，且不请求官方聊天 API。

桌面重启后实窗确认：Claude 当前会话显示 `26,222 / 1,000,000` tokens（2.6%），Max 账号整体窗口和 Fable 单独窗口分别显示；Codex 当前会话显示 `28,593 / 475,000` tokens（6.0%），Pro 账号按实际每周窗口显示。均通过只读查询取得数据，没有额外发送模型消息。浅色实窗与深色隔离界面均已检查。

实现边界：支持当前安装 CLI 的原生用量协议；未知未来协议或不提供账号限额的 API 模式显示不可用。Windows 的原生 CLI 进程启动尚未实机验收。
