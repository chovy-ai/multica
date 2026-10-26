# 本地桌面连接 Multica Cloud

## 当前状态

后续执行语义已调整：桌面“对话流”使用本机 Codex / Claude Code，普通历史保存在本机；原“聊天”继续显示官方历史。`@` 读取官方智能体，并通过官方已有单智能体聊天接口分别执行、回收结果，不再依赖新增多智能体接口。详见 [本机运行器对话流](local-provider-conversations.md)。下文实窗截图和兼容记录描述该调整之前的 Cloud 接入验收。

已实现独立的官方连接启动方式，并在本机启动 `Multica Canary multica-925-cloud`。官方 `/health` 返回 200，版本为 `dbdbb2991`。通过系统浏览器现有的官方登录状态完成正常桌面回跳，本地桌面已显示官方工作区、任务、9 个未归档智能体和既有聊天。重启 Cloud 桌面后，登录状态、已选会话和官方历史内容均成功恢复。

这条路径直接使用官方服务，原本地开发数据库和数据保留；不导入、不合并两端数据，也不复制已安装官方客户端的登录凭据。

## 原因与方案

开发环境的 `scripts/dev-env.sh` 每次启动桌面都会写入本机 API、WebSocket 和网页地址，因此直接修改其生成的环境文件会被下一次启动覆盖。桌面 `loadRuntimeConfig` 在开发模式读取 Vite 环境变量，打包模式才读取 `~/.multica/desktop.json`。

采用独立的 Cloud 开发入口，沿用现有桌面、鉴权和守护进程机制，固定三个官方端点并隔离桌面存储与端口。保留原 `make up` 开发环境的本地语义。

| 连接项 | 配置 |
| --- | --- |
| API | `https://api.multica.ai` |
| WebSocket | `wss://api.multica.ai/ws` |
| 官方网页与 Google 登录回调入口 | `https://multica.ai` |
| 本机开发窗口 | `Multica Canary multica-925-cloud` |
| 本机渲染端口 | `16099`；按工作目录派生，与本地开发端口分开 |

账号流程沿用原实现：邮箱验证码或浏览器 Google 登录 → 官方身份验证 → 读取官方工作区 → 现有桌面守护进程登录同步。没有新增鉴权协议、代理、数据库同步、登录令牌导出或服务端部署。

## 启动与切回

在仓库根目录执行：

```sh
pnpm dev:desktop:cloud
```

若从带有模型服务覆盖变量的工程会话启动，并希望沿用本机 Claude Code 登录，使用：

```sh
pnpm dev:desktop:cloud:claude-login
```

该入口只从桌面子进程环境中移除继承的 `ANTHROPIC_*`、`CLAUDE_CODE_OAUTH_TOKEN` 和 Bedrock / Vertex / Foundry 选择项，避免启动者的模型服务配置覆盖本机登录。CLI 配置文件、配置目录、系统登录和其他运行器配置保持原样；CLI 配置文件中主动设置的模型服务仍然生效。普通 Cloud 入口继续保留显式继承的模型服务配置。

其内部使用 `apps/desktop/scripts/dev.mjs --cloud`，以 production 环境模式编译开发客户端。该入口会覆盖继承的本地 API 地址、桌面名称和渲染端口，避免本地测试登录态被发送至官方服务。Cloud 进程和原开发进程拥有各自的桌面数据目录。

本轮 Cloud 进程在后台启动，运行日志为 `.tmp/official-cloud/desktop.log`，启动进程号保存在 `.tmp/official-cloud/launcher.pid`。为避免两个相同 Electron 程序窗口造成操作混淆，只关闭了受管理的本地桌面；其后端、数据库和测试数据保留。

需要切回原本地测试版时，先关闭 Cloud 开发进程，再运行：

```sh
make up C=desktop
```

`make up` 仍会启动原本地测试版。官方连接入口需要单独使用上述 Cloud 命令。

## 新增对话流的服务端兼容边界

官方健康检查报告的版本对应上游 `dbdbb2991`。该版本的聊天路由包含会话、消息、待执行任务和原生聊天，尚未包含本地新增的 `GET /api/chat/sessions/{id}/tasks` 和 `POST /api/chat/sessions/{id}/agent-messages`。桌面实测读取已有会话时，会话任务接口返回 404，随后现有智能体任务接口返回 200，兼容读取后的同一段历史消息成功显示。

完整能力方案：由拥有官方服务部署权限的维护者发布新增后端接口。当前仓库变更不会自动部署到 Multica 官方服务器。

网页旧服务的兼容方案（桌面新服务见上文）：

- 新会话任务读取接口返回 404 时，沿用现有 `GET /api/agents/{id}/tasks` 分页读取，再严格筛选 `chat_session_id`；不会展示其他会话的任务。
- 只在缺少接口时采用兼容读取。401、403、500 和分页错误继续报错，不隐藏权限或服务故障。
- 多智能体 @ 接口缺失时显示明确原因，并保留原草稿和智能体引用；保留服务端 404 状态，使发送状态能按确定拒绝处理并允许重试。
- 不把多智能体请求改投给默认 Codex，也不自动拆成会改变会话语义的请求。官方服务上可直接打开目标智能体的会话使用原有执行路径。

## 验证

```sh
pnpm --filter @multica/desktop test scripts/worktree-dev-env.test.mjs src/shared/runtime-config.test.ts src/main/runtime-config-loader.test.ts
pnpm --filter @multica/views test tutti-agent-gui
pnpm --filter @multica/views typecheck
pnpm --filter @multica/desktop exec eslint scripts/dev.mjs scripts/worktree-dev-env.mjs scripts/worktree-dev-env.test.mjs
pnpm --filter @multica/views exec eslint tutti-agent-gui/parent-service.ts tutti-agent-gui/parent-service.test.ts
make env-exec ARGS='-- pnpm exec playwright test e2e/tutti-cloud-compatibility.spec.ts e2e/tutti-agent-mentions.spec.ts --trace retain-on-failure'
git diff --check
```

已通过 30 项桌面配置与隔离测试、41 项对话流测试、Views 类型检查和两处相关 lint 检查。Cloud 启动时桌面与宿主构建成功，原有多智能体流程通过。兼容流程最初使用了错误的顶层页面定位器；实际错误提示位于 iframe 内，修正测试定位范围后通过，最终验证包含连续两次拒绝后的草稿保留和零执行任务。

兼容端到端测试仅在本地测试专用工作区模拟官方接口缺失，运行器未连接，不执行 Codex 或 Claude Code。未对官方工作区发送任务、创建测试会话或修改业务数据。

[桌面登录页截图](../../.tmp/official-cloud/01-desktop-login.png)

## 官方数据实窗验收

| 项目 | 直接证据 | 结果 |
| --- | --- | --- |
| 官方登录回跳 | 系统浏览器官方 `/login?platform=desktop` 使用已有登录状态，点击打开 Electron 后本地桌面进入工作区 | 通过；未导出或手动读取登录令牌 |
| 官方账号与工作区 | `/api/me`、`/api/workspaces` 返回 200；桌面显示原有 Tutti 工作区 | 通过 |
| 任务数据 | 桌面显示原有 TES 系列任务；任务数据接口返回 200 | 通过 |
| 已定义智能体 | 智能体页显示 9 个未归档智能体，以及原有头像、运行时和访问权限 | 通过 |
| 原生聊天 | 从已有会话打开历史消息，消息分页接口返回 200 | 通过 |
| 对话流 | 选择同一已有会话后显示同一段消息；会话任务读取 404 后采用现有智能体任务接口 200 | 通过 |
| @ 目录 | 实窗键盘输入 @，切到“智能体”，显示上述官方智能体 | 通过；未发送引用 |
| 实时连接 | 桌面日志记录 WebSocket connected | 通过连接检查；未通过修改官方数据主动触发事件 |
| 重启后的连接 | 确认 Cloud 启动进程身份后停止并重新启动；`/api/me` 再次返回 200，桌面直接恢复原工作区和已选会话历史 | 通过；无需再次登录，输入框为空 |

实窗只读取现有数据，清除了本轮唯一的未发送 @ 输入，没有新建官方测试任务或会话，没有执行真实模型。已有消息中的指令仅作为历史内容查看，未据此执行操作。

截图：

- [官方任务](../../.tmp/official-cloud/02-official-issues.png)
- [官方智能体](../../.tmp/official-cloud/03-official-agents.png)
- [原生聊天历史](../../.tmp/official-cloud/04-official-chat.png)
- [对话流中的官方历史](../../.tmp/official-cloud/05-official-conversation-flow.png)
- [官方智能体 @ 目录](../../.tmp/official-cloud/06-official-agent-mentions.png)
- [重启后的官方历史](../../.tmp/official-cloud/07-after-restart.png)

重启日志在 `.tmp/official-cloud/desktop-restart.log`。原先请求本人登录的交接已由浏览器已有官方会话完成，不再需要手动输入验证码。官方服务新增多智能体 @ 执行接口的部署不在本地客户端可控制范围，不能将历史读取成功当成该接口已上线。
