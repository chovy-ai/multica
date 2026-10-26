# Agent 工作台迁移

将 Tutti 的 Agent GUI 交互结构适配到 Multica：在同一个工作台管理 Agent、继续会话、查看业务任务与执行记录。执行、鉴权、任务调度和持久化继续由 Multica 拥有。

## 来源与边界

调研基线：Multica `dbdbb299164347586e2650bb67684a490726a798`；公开版 Tutti `207beeea554435618dffd3b579d0ffe112b065c4`。工作区已有的另一份 Tutti 使用不同架构，不作为迁移来源。

参考 Tutti 的 `packages/agent/gui/AgentGUI.tsx`、`agentActivityRuntime.tsx`、`types.ts`、`packages/agent/activity-core/src/engine/types.ts`、`docs/architecture/agent-gui-node.md` 和 `docs/architecture/agent-activity-packages.md`。参考的是 Agent/Session 导航、时间线、输入器、精确身份与能力门控，不复制原始组件和状态引擎。

目标代码依据：

| 证据 | 结论 | 实施路径 |
| --- | --- | --- |
| [Agent 列表](../../packages/views/agents/components/agents-page.tsx)及[详情](../../packages/views/agents/components/agent-detail-page.tsx) | 最新 Multica 已具备 Agent 管理 | 保留创建、配置、归档、权限及 Runtime 管理入口 |
| [会话控制器](../../packages/views/chat/components/use-chat-controller.ts) | 已有创建、发送、停止、排队、草稿恢复、权限处理 | 新布局使用同一个控制器 |
| [实时同步](../../packages/core/realtime/use-realtime-sync.ts) | Query cache 已有流式写入、终态校准、断线恢复 | 不再实例化 Tutti Engine 或第二条 WebSocket |
| [任务模型](../../packages/core/types/agent.ts) | AgentTask 是执行记录，Issue 才是业务任务 | 任务列表按精确 Agent assignee 查询，执行记录单独展示 |
| [消息模型](../../packages/core/types/events.ts) | 工具消息以 task_id、seq、call_id 关联 | 保留现有 transcript renderer，不从消息文案推断生命周期 |
| [Codex adapter](../../server/pkg/agent/codex.go) | 当前命令、文件审批由 daemon 自动答复 | 不把 GUI 审批按钮伪装成已支持的能力 |

用户选择完整接入 Agent 管理、会话交互与 Task 关联，并沿用 Multica 执行体系。这里的关联沿用现有关系：`Issue.assignee_type=agent + assignee_id`、`AgentTask.issue_id/chat_session_id`，以及持久化消息中的 `mention://issue/<id>`。不额外创造一个独立的任务系统，也不把 Task 误作 Project。

## 概念映射

| 来源概念 | 目标概念 | 约束 |
| --- | --- | --- |
| AgentGUI / AgentGuiNode | AgentWorkspace | 只负责布局与用户意图 |
| Agent Target | Multica Agent + 其 Runtime | 保留 Multica agent.id；Provider 名称不能充当实体 ID |
| Workspace | Multica Workspace | 以路由选中的 workspace 为作用域 |
| Session / Rail | ChatSession / 会话列表 | 保留会话与 Agent 的实际绑定 |
| Turn | AgentTask 执行记录 | 展示目标状态，不伪造 Tutti 的 waiting/settling 阶段 |
| Transcript | ChatMessage + TaskMessagePayload | 复用 Multica 的分页、工具输出、跟随与截断语义 |
| Composer | ChatInput | 保留附件协调、草稿、失败恢复及发送门禁 |
| 任务引用 | Issue mention | 精确 issue.id，插入草稿后由用户发送 |
| Host 管理能力 | 现有 Agent/Runtime 页面 | 通过 NavigationAdapter 跳转 |

## 不变的协议

所有已有 API 保持路径、请求/响应字段、状态枚举、错误码、鉴权方式与调用时序：

| 能力 | 原有协议 |
| --- | --- |
| Agent 管理 | `/api/agents` 及现有 Agent/Runtime API |
| 会话创建 | `POST /api/chat/sessions`：`agent_id`、`title`、`project_id` |
| 会话读取/更名/删除 | `GET/PATCH/DELETE /api/chat/sessions/{id}` |
| 固定/归档 | `PATCH /api/chat/sessions/{id}/pin`、`/archive` |
| 发送 | `POST /api/chat/sessions/{id}/messages`：`content`、`attachment_ids`；保留返回的 `message_id`、`task_id`、`created_at`、`supports_queue`、`queued` 与实际附件绑定 |
| 历史/执行输出 | `/api/chat/sessions/{id}/messages/page`、`/api/tasks/{taskId}/messages` |
| 停止/队列 | 现有 cancel、queued-tasks、draft-restores API，不把受理等同于 Provider 已停止 |
| 业务任务 | `GET /api/issues` 的服务端 assignee 过滤与原有创建、修改 API |
| 实时更新 | `task:message`、`chat:message`、`chat:done`、`task:completed`、`task:failed` 等既有事件 |

Web/Desktop 继续通过 ApiClient 的当前凭据与 `X-Workspace-Slug` 访问。不能在视图中手写另一套鉴权请求。服务端在发送前重新检查调用权限，继续原子持久化用户消息、任务与附件绑定。

业务任务查询放在 `packages/core`，使用既有 Issue flat cache 形状与键，才能参与现有任务更新/分配/删除的缓存协调。按页获取，避免只过滤已加载的全工作区任务而漏项。

## 数据与状态流

```text
路由 Workspace → AgentWorkspace
                    ├─ Agent 目录/会话列表 → 既有 Query
                    ├─ 用户操作 → useChatController → ApiClient
                    │                                  ↓
                    │                    Multica handler / TaskService
                    │                                  ↓
                    │                          原有 Agent Runtime
                    ├─ transcript ← Query cache ← 原有实时同步
                    └─ Issue / AgentTask 分页 → 精确 Agent 的任务与执行记录

点击任务引用 → 当前会话草稿 → 用户发送 → 持久化 ChatMessage 中的 Issue mention
```

React 不成为生命周期权威。切换会话不会重发任务；切换 Agent 创建新会话意图；历史会话的 Agent 不可被另一个列表选项悄悄替换。任务引用必须指向点击时的精确会话草稿，不覆盖已有文字或附件，不自动发送。

## 根本方案与兼容方案

采用根本方案：按照 Multica 的 core/views/platform 边界重新表达 Tutti 的产品交互。沿用 Multica 的状态权威，统一 Agent、会话与任务入口。Web 与 Desktop 使用同一实现。

兼容方案是让一个独立 AgentGUIRuntime adapter 消费 Multica，再嵌入原 Tutti GUI。它要求补全 Tutti Session/Turn/Interaction 契约，并引入其完整组件依赖及第二个前端状态引擎；还需要处理 UI System 替换。当前 Multica 没有同等的人工审批协议，无法用空实现获得真实兼容。用户已选择沿用 Multica 执行体系，因此本轮不采用该路线，也不迁入 tuttid、Electron host、Go Host 或 SQLite。

## UI 与实现组织

新增工作台使用 `@nextop-os/ui-system` 的公开入口。新增的 Agent/会话选择、搜索、按钮、状态标签、任务卡片、面板与图标使用其组件和语义 token；不复制 Tutti 的 CSS、SVG、palette 或产品文案。

| GUI 交互 | 目标实现 |
| --- | --- |
| Agent/Session rail 与操作 | UI System `Button`，精确 ID 选择与 Multica NavigationAdapter |
| 目录搜索 | UI System `Input` |
| 任务与执行记录 | UI System `Card` 组合轻量列表、`Spinner`；复用 Multica 的业务状态图标与本地化名称 |
| 入口与状态图标 | UI System 公开 `icons` 入口 |
| transcript、composer、queue | 保留 Multica 现有业务组件及其状态所有者 |

入口为 Agents 页和 Chat 页中的 **Agent workspace / 智能体工作台**，使用既有 Chat 路由的 `?view=workbench`。会话深链保留 `&session=<id>`，因此 Web/Desktop 共用页面、路由保护、权限与工作区切换逻辑，不新增顶层路由。

保留目标项目的 ChatInput、ChatMessageList、ChatQueue 和 Agent 管理页面。这些是已有业务组件，承载富文本、附件、输出与草稿恢复；UI System 没有等价的业务控件。本轮不为更换视觉而重写这些已验证的业务流程。新增样式负责工作台列宽、滚动和窄屏布局。

UI System 的扩展文字/交互 token 使用 `data-theme`，Multica 的主题使用 `.dark`；工作台内将这些 token 映射到目标项目的语义 token，保证深浅主题一致。选中项沿用 Multica 聊天列表的填色方式，悬停时保持选择状态。

### Multica 风格对齐

对照 `packages/views/layout/page-header.tsx`、`packages/views/layout/collection-page.tsx`、`packages/views/chat/components/chat-thread-list.tsx`、`packages/ui/components/ui/button.tsx`、`packages/ui/components/ui/input.tsx`、`packages/ui/styles/tokens.css` 与既有桌面截图完成调整：

| 视觉责任 | 对齐方式 |
| --- | --- |
| 页头 | 复用 `PageHeader`，与智能体管理页共用 48px 高度、页面 gutter、`text-body` 与中等字重 |
| 基础控件 | 继续使用 UI System 公开 Button/Input/Card；通过限定在工作台及其入口的样式映射使用 Multica 字号、圆角、输入边框、焦点环和中性选择态 |
| 智能体与会话 | 复用 `ActorAvatar` 的身份与在线状态；采用紧凑双行会话列表，保留固定、未读、归档和精确会话选择 |
| 任务 | 减少独立卡片边框，采用列表间距；复用 `StatusIcon` 和 `useStatusLabel`，内置状态使用 Multica 翻译，自定义状态保留目录中的名称、图标和颜色 |
| 执行历史 | 复用 `TaskStatusIcon`，保持原有精确任务/会话链接 |
| 窄窗口 | 根据工作台实际可用宽度切换双栏/单栏，不依赖整个窗口宽度猜测内容区大小 |
| 全局字体与画布 | UI System 公共 CSS 的 body 字体与渐变默认值会影响宿主；恢复 Multica 的字体继承与无渐变画布，不更改其主题 token |

这些有限的自定义样式用于弥合两套组件规范。UI System 的默认类名合并器不识别 Multica 的角色字号，直接追加 `text-body/text-label/text-caption` 会与颜色类产生冲突，因此在模块样式中按控件语义映射字号。保留公开 `styles.css` 导入，没有修改依赖源码或引入新的 UI 库。

本轮对齐仅调整渲染与中文文案，Agent 选择、权限、消息、附件、草稿、Issue/AgentTask 关联及 API/事件协议继续沿用前文的数据流。

风格对齐验证：

- Views 类型检查、Desktop main/preload/renderer 类型检查与改动范围 ESLint 通过。
- 原有 ChatPage、ChatInput、草稿隔离及翻译回归：4 个文件、103 项测试通过。
- 工作台端到端测试通过：新增与智能体管理页的真实页头高度/gutter/字体/字号/字重对比，保留深浅主题至少 4.5:1 的操作文字对比度检查；覆盖 1440px、900px 和 390px，及原有任务引用、发送、取消、恢复与执行记录导航。
- Electron main/preload/renderer 构建通过，保留既有 emoji-picker 导入警告。
- 用户解锁后，已完成重启后的 Electron 深浅主题人工复核：从原生智能体页进入工作台，检查页头、身份头像、会话选择、中文任务状态及持久化的 Codex 回复；执行记录可打开 DEV-1，详情保留 `MULTICA_TASK_CONNECTED` 评论、已完成状态和执行日志。验收后恢复原来的「跟随系统」主题，并停留在工作台的真实会话。
- 原生桌面截图保存在 `.tmp/agent-workspace-style-native-light.png` 和 `.tmp/agent-workspace-style-native-dark.png`；窄屏渲染截图已检查。

本轮未重新触发真实模型任务；使用上一轮已完成的 Codex 对话和 Task 验收记录核对外观。

后续从用户视角完成了交互一致性审查与三组并行优化，涵盖会话上下文保留、Agent 选择、搜索、会话摘要与操作菜单、运行来源与时间、错误恢复、自适应面板及键盘焦点。统一回归为 125 项组件测试和 1 项端到端测试通过，桌面类型检查、构建及深浅主题原生复核通过；详见[交互审查与验收](agent-workspace-interaction-audit.md)。

依赖通过目标仓库指定的 pnpm 安装并写入既有 pnpm lockfile，等价于要求的安装操作，不混入 npm lockfile。引入公开的 `styles.css`，并保持原有页面 token 的覆盖顺序，避免顺带重绘全部 Task 页面。

沿用来源的责任拆分与交互层级，重写组件名、内部方法、布局实现和 Multica 文案。Task/Agent/Workspace/Session 的精确 ID 不因展示而更换。

## 验收边界

验证 Agent 目录加载、失败重试、搜索、选择；会话选择、更名/固定/归档/删除；消息发送、分页、流式输出、停止、队列、附件与草稿恢复；业务任务的按 Agent 分页、创建、打开详情、引用；Web/Desktop 路由与窄屏访问。

人工审批、Plan 审核、Goal 自治、Session Fork、Tutti 的本机安装/登录/VM 管理不是单纯 GUI 能力。当前 Multica 未提供等价协议时，不展示虚假可用入口，也不改变现有自动审批策略。若需这些能力，下一步应先扩展 Runtime/service 的真实暂停、Interaction 持久化、响应与恢复协议，再接入界面。

以 Electron 桌面端作为交付与人工验收入口。迁移代码位于 Web/Desktop 共用渲染层和平台无关 Query/mention 数据层；桌面导航保留原有标签页、历史和工作区切换。桌面开发环境补全 `VITE_APP_URL` 为分配的 Web 地址，确保复制链接与登录跳转指向同一环境。Windows 原生执行保持原有 Multica adapter 的范围，本轮没有在 Windows 上实测。

本地开发版从仓库根目录运行 `make up C=api,daemon,desktop`，在桌面窗口进入「智能体 → 智能体工作台」。`make down` 停止服务并保留数据库。该交付未覆盖正式签名、安装包分发与其他操作系统验收。

验收时分别记录静态检查、组件/API 集成测试、应用构建与真实 Agent 执行结果。模拟服务或组件测试不能代表真实 Provider 已跑通。

## 本轮验证记录

已完成：

- `pnpm --filter @multica/core typecheck`、`pnpm --filter @multica/views typecheck`、`pnpm --filter @multica/web typecheck`、`pnpm --filter @multica/desktop typecheck`（main/preload 与 renderer）
- `pnpm --filter @multica/core exec vitest run agents/agent-workspace-queries.test.ts`：2 项通过；覆盖服务端 Agent 过滤、分页、跨 Workspace 缓存、重新分配后的事件校准
- `pnpm --filter @multica/views exec vitest run chat/chat-page.test.tsx chat/components/chat-input.test.tsx chat/components/chat-input-draft-isolation.test.tsx agents/agents-i18n-parity.test.ts`：103 项通过；包括新任务引用不覆盖、不重发、不跨 Workspace/草稿、不写入只读会话及取消未执行插入
- 改动范围的 Core/Views ESLint 与 `git diff --check`
- `pnpm --filter @multica/desktop exec electron-vite build`：通过，包括 main/preload/renderer 构建；现有 emoji-picker 静态/动态导入混用警告仍存在
- `make env-exec ARGS='-- pnpm exec playwright test e2e/agent-workspace.spec.ts'`：真实本地后端与数据库通过 1 项端到端测试；覆盖精确 Agent 任务筛选、任务引用、消息持久化、取消、刷新草稿恢复、执行历史导航、1440px/900px/390px 布局、与原生智能体页的页头样式对比，以及深浅主题操作文字至少 4.5:1 的对比度
- `make env-exec ARGS='-- pnpm exec playwright test e2e/agent-workspace-live.spec.ts'`：默认 2 项跳过，不接触真实模型账号
- 用户明确选择本机 Codex 后运行受门禁保护的真实验收：对话测试通过；分配给 Codex 的业务任务真实完成执行，输出通过原有 Agent 评论与 `source_task_id` 回写，工作台执行记录与详情导航测试通过
- `make up C=api,daemon,desktop`：Electron 实际启动并连接同一后端。人工在原生窗口发送消息，约 16 秒后收到 `MULTICA_DESKTOP_CONNECTED`；重启桌面客户端后会话与标签页恢复；工作台可打开 `DEV-1` 并显示 `MULTICA_TASK_CONNECTED`、执行日志与关联 Agent；新建任务表单预选当前 Agent
- 在桌面中验收结果后将 `DEV-1` 从待办改为已完成，返回工作台显示已完成。AgentTask 执行完成与 Issue 业务状态分开处理，验收没有改动这个协议
- `bash -n scripts/dev-env.sh` 与桌面环境地址身份检查通过。`bash scripts/dev-env.test.sh` 在已构建真实 CLI 的本机环境下因临时 profile 返回 `unknown_profile` 而失败；用原始 HEAD 脚本复跑得到相同失败，未扩大范围修改该既有测试问题

普通端到端测试使用 TestApiClient 创建的本地测试数据，测试后清理工作区，不启动真实 Agent CLI。真实验收文件先检查 `MULTICA_RUN_REAL_AGENT_SMOKE=1` 和 `MULTICA_SMOKE_AGENT_ID`，并限制本地后端，才登录和调用已授权的 Agent。运行方式：

```sh
MULTICA_RUN_REAL_AGENT_SMOKE=1 MULTICA_SMOKE_AGENT_ID=<本地AgentID> \
  make env-exec ARGS='-- pnpm exec playwright test e2e/agent-workspace-live.spec.ts'
```

该命令会真实消耗模型额度，只能在明确授权后运行。业务任务测试支持显式 `MULTICA_SMOKE_ISSUE_ID`，复查已经执行过的验收任务，避免重复模型调用。验收数据保留在本地开发工作区，便于在桌面端复核。

现场还观察到目标项目既有富文本外部内容同步路径的 React `flushSync` 开发态警告。新增任务引用已安排在可撤销的 microtask 中，避免从 React effect 内直接插入节点；没有扩大范围改写原有富文本同步流程。该警告不等于 Provider 执行失败，仍应作为后续编辑器专项检查项。

依赖检查保留了原 lockfile 中所有已存在 package/snapshot 的解析，仅增加 UI System 所需的依赖闭包。安装时曾出现 Core/Views 翻译库实例分裂，已通过恢复原有 peer 解析修正，并以相关回归测试与真实页面验证。
