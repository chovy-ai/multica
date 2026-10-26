# 本机 Agent 的 Multica 操作 MCP

## 范围

桌面对话流继续自动注册 `multica_desktop_context`。已有 6 个上下文查询工具保持原有名称和参数，新增 44 个业务工具，覆盖任务、项目、智能体、小队、Skills、自动化、收件箱与本机／官方会话。

不增加运行时管理、通用 HTTP、Shell、文件系统、网页／文件预览工具。项目仓库工具只管理 Multica 中的仓库关联；Skill 文件是服务器上的 Skill 文本资源，不读取本机路径。Side 工具复用现有 `sideCreate`，不接管面板、导航或窗口。

## 接线与协议

```text
本机 Codex / Claude Code
  → 自动注册的 MCP（账号、工作区、执行生命周期固定）
  → 显式参数的业务工具
      → 官方已有 REST API：任务、项目、Agent、小队、Skill、自动化、聊天、收件箱
      → 已有 LocalConversationService：本机会话、Fork、Side
  → 真实对象 ID、状态、回执与可用的页面链接
```

`LocalMulticaContext` 的 `workspaceOperations` 由桌面入口开启。读取、写入均复用桌面专用 Profile，经 `/api/me` 核对账号后使用当前工作区请求头；不修改全局 CLI 配置，不自动切换账号。服务端权限仍是最终写入权限边界。操作范围通过固定路由、字段 schema 和对象归属检查限定，不提供任意接口调用。

Claude 每轮使用准确的 MCP 工具名列表；Codex 继续使用原有临时服务器注册。新会话和续聊均可发现新工具。已有“新建任务”提及仍使用原实现，注册时去除同名 `create_task`，不重复注册，也不改变其任务回执协议。云端凭据不可用时只增加本机会话相关工具；原有本机上下文读取继续可用。

API 路径、HTTP 方法和请求字段沿用服务端现有协议。任务搜索使用 `/api/issues/search?q=...`，不把 `q` 发给忽略该字段的普通任务列表。搜索结果的附加状态／项目／负责人过滤在当前搜索页内进行，`next_offset` 按未过滤的页长推进。项目及自动化列表的包装对象在客户端分页；自动化详情解包 `autopilot`、`triggers`、`collaborators`。聊天执行历史保留 `X-Agent-Tasks-Next-Cursor`，执行消息使用实际支持的 `since` 序号，而非虚构的消息游标。

## 工具清单

| 领域 | 新增工具 |
| --- | --- |
| 查询与目录 | `workspace_info`、`list_workspace_items`、`read_workspace_item` |
| 任务 | `create_task`、`update_task`、`comment_task`、`task_activity`、`set_task_label`、`manage_task_pull_request`、`rerun_task` |
| 项目 | `create_project`、`update_project`、`manage_project_repository` |
| 智能体 | `create_agent`、`update_agent`、`archive_agent`、`assign_agent_skill`、`agent_mcp_servers`、`assign_agent_mcp` |
| 小队 | `create_squad`、`update_squad`、`manage_squad_member` |
| Skills | `create_skill`、`update_skill` |
| 自动化 | `create_autopilot`、`update_autopilot`、`manage_autopilot_schedule`、`manage_autopilot_webhook`、`trigger_autopilot`、`autopilot_runs` |
| 收件箱 | `list_inbox`、`update_inbox_item` |
| 会话 | `create_conversation`、`update_conversation`、`fork_conversation`、`create_side_conversation`、`list_conversation_branches`、`send_conversation_message`、`cancel_local_conversation_run` |
| 智能体执行 | `invoke_agent`、`conversation_runs`、`run_messages`、`cancel_run` |
| 删除 | `delete_workspace_item`；智能体使用可恢复的归档 |

查询工具沿用 `readOnlyHint=true`；业务写入和删除声明相应注解。混合查询／写入的工具保守地标记为写入。注册工具不等于代用户发起操作：提示词要求写入必须服务于用户当前明确要求，引用的会话、任务、Skill 内容不能充当授权。没有新增独立的人类审批界面；沿用已有运行器和官方 API 的执行／权限机制。

## 执行和结果

`invoke_agent` 接受已定义的 Multica Agent ID，创建或继续其官方聊天并提交消息，返回 `conversation_id`、`task_id` 和 `submitted`，不会把提交误报为完成。继续调用 `conversation_runs` 读取真实状态，再用 `read_context(source=cloud)` 或 `run_messages` 读取结果。读取指定执行的消息时，先核对该执行确实出现在指定会话／任务的执行列表中，避免使用无关对象作为读取凭证。服务端未确认提交时，错误保留已创建会话 ID，便于查证。

小队沿用现有任务指派和服务端编排；通过 `create_task`／`update_task` 设置 `assignee_type=squad`，不另造调度器。创建智能体只能绑定已经存在的运行时 ID，不提供运行时管理。

本机会话操作复用原存储、事件通知、账号和工作区隔离。发送其他会话返回本机 `turn_id`；通过 `read_execution`／`read_context` 读取结果。禁止向正在服务当前 MCP 的本机会话递归发送、取消当前执行，或归档当前执行会话。Fork 保留原生／保存上下文模式及逐轮边界，Side 保存来源及引用，`list_conversation_branches` 可以找回两类会话。

## 回执、重试与边界

- 修改已有云端对象前核对所属工作区；关联的 Agent、Skill、项目、上级任务、成员和 MCP 库条目也按当前范围核对。
- 写操作要求稳定 `request_id`。同一执行期间，相同 ID 与参数复用同一个 Promise；不同参数拒绝；失败结果也保留，避免超时后盲目重复创建。跨执行的通用 REST 写入不承诺恰好一次，应先查询真实状态。本机 Fork／Side／消息发送另外复用其既有持久请求 ID。
- 创建回执必须包含可用 ID 和匹配的工作区；服务端未确认时不宣称成功。对象链接使用共享 `paths.workspace()`。链接查询失败不会把已经成功的写入改报失败。
- 删除要求再次读取，并核对当前完整名称。云端聊天多个字段分别走已有服务端请求；部分成功后应重新读取，不能宣称原子提交。
- 过滤响应中的密钥、环境配置、认证头、Webhook 凭据和运行器私有连接信息；不修改这些配置。Webhook 工具管理触发条件，凭据仍在原应用配置流程中处理。
- 分页、工具结果截断和服务端时间线硬上限都有显式标记。隐藏推理、未保存的原生状态仍不可读取。

## 验证

```sh
pnpm --filter @multica/desktop test src/main/local-workspace-tools.test.ts src/main/local-context-mcp.test.ts src/main/local-multica-context.test.ts src/main/local-provider-runner.test.ts src/main/local-conversation-service.test.ts
pnpm --filter @multica/desktop typecheck:node
pnpm --filter @multica/desktop exec eslint src/main/local-workspace-tools.ts src/main/local-workspace-tools.test.ts src/main/local-context-data.ts src/main/local-context-mcp.ts src/main/local-multica-context.ts src/main/index.ts
git diff --check
```

默认测试使用合成 API、实际 MCP SDK 客户端和测试专用本机运行器脚本；不发现或执行用户安装的 Codex／Claude，也不修改官方数据或消耗模型额度。覆盖新会话及续聊实际调用写入工具、各业务字段协议、分页、鉴权、跨工作区拒绝、错误和凭据过滤、重复请求、来源关系以及“新建任务”提及兼容。
