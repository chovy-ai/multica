# CHOV-28 Side 工作区实施记录

本分支实现已确认方案的必做能力：当前会话的 Side 标签、文件读取、旁支发送与等待，以及直接操作右侧网页。Claude 运行中发送采用方案允许的持久队列分支；没有运行真实模型 smoke。iframe 跨进程路由和助手光标属于可选项，本次未实现。

基准为重新抓取的 `personal/main`（`chovy-ai/multica`，`5e0f56243`），实施分支为 `codex/CHOV-28-side-workspace`。提交 PR 前同步过 `25721ebd3`（#42），合入前再次同步至 `personal/main` 的 `322aa09ab`（#44），保留 CHOV-21 的后台结果投递、定时器清理及上游更新。保留其轮次完成与后台清理分离的行为，Side release 同样作为受跟踪的后台清理，不等待 renderer 应答后才落盘轮次完成。原工作目录和设计 worktree 保留原状。详细规格见 [定稿方案](CHOV-28-side-workspace-access-plan.md)。

## 能力与入口

| 用户操作 | MCP 入口 | 执行位置与边界 |
| --- | --- | --- |
| 识别“这里 / 右侧那个” | `side_tabs`、`side_focused_tab` | sidecar 最新快照，保留聚焦标签和实际可见性 |
| 打开或选择内容 | `side_open_tab`、`side_select_tab` | main 校验用户、会话、活动轮次，renderer 应答后返回 |
| 读取文件或目录 | `side_read_file` | sidecar 复用 `LocalResourceReader`，只允许标签本身或目录后代，realpath 校验 |
| 查看旁支 | `side_conversation_read` | 只允许当前 Side 打开的会话，复用原分页读取 |
| 向旁支发送并获取结果 | `side_conversation_send`、`side_conversation_wait` | 空闲新执行；Codex 有确认的原生 steer；不支持时持久排队 |
| 读取和操作网页 | `side_browser_snapshot/screenshot/click/type/press/scroll/select/navigate/wait/open` | 当前页面的 `WebContentsView`，不开放调试端口 |

`create_side_conversation` 仍只创建会话，新增创建后在当前 Side 打开标签；不会因此启动模型。已有 `send_conversation_message` 的权限和发送语义未改变。

## 状态流与实施选择

renderer 的 Layout 仍是唯一布局数据源。150 ms 防抖通过现有 conversation request 通道推送 `sideWorkspaceSync`；关闭标签立即发起同步。sidecar 的 `SideWorkspaceRegistry` 只保存内存镜像。每轮执行从镜像构造 `<side-context>`，仅进入 provider 输入，不保存到展示消息。

应用根层负责从非聊天页面启动、sidecar 重新可用时的快照恢复；会话面板挂载后由它推送正在显示的实时布局。没有新建另一份持久布局。界面命令在面板未挂载时更新同一个保存布局；需要显示时通过已有 tab store 打开当前工作区的会话。

main 只处理界面变更、CDP 和资源释放。`sideWorkspaceState` 从 sidecar 返回严格的原始快照，使 main 在控制实际页面前再次校验标签存在，不向 renderer 拉取清单。新增 `previewLocate` 复用既有文件授权根，支持助手打开目录。

浏览器锁绑定会话和轮次。导航或新 snapshot 后旧 ref 失效；关闭标签、账号切换、取消或执行结束会释放控制。`finally` 使用独立的清理信号，关闭本轮助手打开且没有 `keep` 的临时网页，用户标签保持所有权。标签栏显示操作状态和停止按钮。

### 旁支执行回执

- `new_run`：包含真实 `turn_id`；发送结果表示提交，完成情况由 wait/read 查询。
- `steer`：Codex 使用原生 `threadId` 和 `expectedTurnId`。原生 turn 已结束或不匹配时转入新执行或队列。
- `queued`：`turn_id: null`，返回持久的 `request_id`；wait 可以用此 ID 等待实际轮次创建。
- 运输或确认结果不明：保留未知状态，不自动重提。原生 steer 之前写入本地回执，使重启后也不会重复发送。

运行中的 Claude 与 CLI 回退路径使用现有队列，消息显示来源。当前 SDK 的流式消息接口不能单凭入队动作证明已经并入当前轮，所以没有将入队报告成成功 steer。未进行会消耗真实模型配额的 SDK 插入验证。

### 消息大小与浏览器策略

Go daemon 的 `maxMessageBytes` 是 **1 MiB**，并非无限制。截图先限制长边 1600，再压缩到不超过 650 KiB，给 base64 和 JSON 留空间；AX 节点数据预算 500 KiB。图片最终作为 MCP image content 返回，不把 base64 塞进文本。

四档确认按定稿写入系统提示、MCP 指令和工具描述：验证码、2FA、密码修改最后一步及证书警告交给用户；删除、发送、提交、支付、权限修改和敏感输入每次询问用户；登录与上传要求事先授权，上传仍维持不可用；普通浏览和 cookie 同意无需询问。页面数据不构成授权。此处与方案一致，由助手遵循语义策略，没有实现网页意图的自动分类拦截器。

## 验证与证据

所有命令从本 worktree 执行。单元测试使用 fake provider，不调用已安装模型 CLI。Electron 脚本启动独立测试 profile 和本地 HTTP 页面，不启动 Multica 应用或接管当前运行时。

```sh
pnpm --filter @multica/desktop typecheck
pnpm --dir apps/desktop exec vitest run --maxWorkers=2
pnpm --dir packages/core exec vitest run local-conversation
node apps/desktop/scripts/test-side-browser.mjs
pnpm --dir apps/desktop exec electron-vite build
```

Go 通道验证从 `server/` 执行：

```sh
go test ./internal/daemon/localhost -run 'TestSideWorkspaceHostRequestPreservesPayloadAndImageReply|TestHostRequestGoesOnlyToOriginAndFirstReplyWins' -count=1
```

| 证据 | 结论 | 对应实现 |
| --- | --- | --- |
| 注册表与 schema 回归测试 | 拒绝旧 revision、重复标签、跨会话访问和无效选择 | `local-side-workspace.ts`、core `protocol.ts` |
| 文件测试 | 文件分页可用，目录后代可读，兄弟路径及 symlink 逃逸被拒绝 | `readSideFile`、`LocalResourceReader` |
| provider pool、旁支与回执测试 | 原生 turn ID 用于 steer，队列会自动执行，未知提交重启后不重放 | `local-codex-pool.ts`、`steerSide` |
| 根层与面板测试 | 不进入聊天页也能恢复快照，面板卸载后仍能清理临时标签 | `side-workspace-bridge.tsx` |
| 真实 Electron 测试页 | AX、输入、点击、选择、等待、导航、旧 ref 拒绝、截图和 detach 可用 | `scripts/test-side-browser.mjs` |

Electron 脚本在 `apps/desktop/.tmp/side-browser/` 写入 `result.json` 和 `page.jpg`。该目录被忽略，不提交。最新运行截图已检查：输入值与结果均为 `side test`，下拉选项为 B，截图非空。

### 本次检查结果

| 检查 | 结果 |
| --- | --- |
| Desktop node/web 类型检查 | 通过（同步 main #42 后再次验证） |
| 同步 main #42 后的轮次、引导和 Side 回归 | 12 个文件、149 项通过；包含 renderer release 阻塞时仍及时完成轮次的回归 |
| 改动文件 ESLint（Desktop 与 core） | 通过，无新增警告 |
| core local-conversation 测试 | 2 个文件、8 项通过 |
| 最近一次桌面全量执行（2 workers） | 135 个文件通过；3 个原有假 CLI 文件的 4 项超过默认 5 秒，另有 1 项原有跳过 |
| 上述 3 个文件单独重跑（20 秒限时） | 43 项全部通过 |
| 新能力最终定向测试 | 6 个文件、25 项通过 |
| 后续取消与界面导航边界回归 | 3 个文件、11 项通过 |
| Go localhost 定向集成 | 2 项通过，包括新增 kind 及大图片回执 |
| 真实 Electron 页面脚本 | 通过；全页截图 9333 字节，隐藏页面截图 17255 字节 |
| electron-vite main/preload/renderer 构建 | 通过；仅剩原有 emoji-picker 静态/动态导入警告 |
| `git diff --check` | 通过 |

全量测试中的假 CLI 文件按以下原命令重跑，未修改测试实现或项目默认超时：

```sh
pnpm --dir apps/desktop exec vitest run src/local-host/local-codex-instructions.test.ts src/local-host/local-provider-runner.test.ts src/main/terminal-cli.test.ts --maxWorkers=2 --testTimeout=20000
```

临时运行日志保存在本 worktree 的 `.tmp/side-workspace-verification/`。

## 验证边界

- 没有运行真实 Codex/Claude 模型到完整 Desktop 的端到端验收，尤其没有验证真实模型逐次触发敏感操作询问。
- iframe session 路由和隔离世界中的助手光标没有实现；主页面已有 select/scroll 操作。
- 文本文件上限 10 MB；MCP 栅格图片上限 4 MiB。PDF 返回授权路径和元数据，正文仍需原生 PDF 工具。
- 快照有防抖窗口；控制网页前 main 会再次检查标签，文件/旁支访问依赖最新已收到快照。
- 实现与验证没有替换正在运行的 Desktop；提交与合入状态以 GitHub PR 和 Git 历史为准。
