# 本地对话流迁入 daemon（Node sidecar）技术方案

状态：第二版草案。已合入逻辑评审和架构评审的结论。日期：2026-10-27。

## 1. 背景

本地对话流（直接调用本机 Codex / Claude Code 的对话）目前全部运行在 Electron main 进程里：

- `apps/desktop/src/main/local-conversation-service.ts` 持有会话、队列、运行状态。
- Codex 使用常驻 `app-server` 进程池：`local-codex-pool.ts`、`local-codex-worker.ts`、`local-codex-rpc.ts`、`local-codex-context-bridge.ts`。
- Claude 使用 `@anthropic-ai/claude-agent-sdk` 的常驻会话：`local-claude-conversation.ts`。
- 每轮启动内置 MCP `multica_desktop_context`：入口在 `local-context-mcp.ts`、`local-multica-context.ts`；工具在 `local-context-data.ts`、`local-workspace-tools.ts`、`local-settings-tools.ts`、`local-agent-avatar.ts`。
- 数据保存在 `userData/local-conversations/<scopeKey>/`，其中 `scopeKey = sha256([apiUrl, userId, workspaceId])`。

和 daemon 的关系仅限于借用：main 从 daemon profile 下的 `config.json` 读取 PAT，并通过 `execFile` 调用打包的 CLI，daemon 并不知道本地对话的存在。对话的生命周期绑定在 desktop 进程上，和 daemon 的生命周期、版本、凭据各管各的。

## 2. 目标、已定约束与非目标

目标：

1. 本地对话的运行和存储归 multica daemon 管理，由 daemon 拉起并监管一个 Node sidecar。desktop 只负责展示和需要人参与的交互。
2. 本地模型轮次从 desktop 直接到 daemon，再由 sidecar 拉起 provider CLI，不经过云端 server。
3. 关闭 desktop 窗口时，只要 daemon 和 sidecar 不重启，正在运行的轮次和排队项继续执行。

已定约束：

- 本地对话只面向 desktop 用户。
- Claude 继续使用官方 Agent SDK，通过 Node sidecar 运行。
- `@智能体` 轮次和 `invoke_agent` 一律走云端：创建 cloud chat session、发送消息、轮询结果，由云端把任务下发到智能体所在的 runtime。即使这个 runtime 就是本机 daemon，也不设本地快捷链路。server 不改动。
- 未登录或 daemon 未运行时，本地对话不可用，界面提示登录或启动 daemon。daemon 不增加"仅本地模式"。
- 多个 desktop（正式版、Canary、开发构建）连接同一 apiUrl 时，共用同一个 daemon profile 和同一个 sidecar。
- desktop 主动重启 daemon（切换用户、重新认证、登出、退出时 `autoStop`）会中断本地轮次，这是可以接受的。版本对齐重启要等本地轮次空闲后再执行（§10）。
- 重启之后（daemon、sidecar 或 desktop 中任一重启导致 sidecar 重建），非空队列暂停，需要用户手动继续；运行中的本地轮次标记为失败。这与现有行为一致（`local-conversation-service.ts:155,165`）。

非目标：

- 不改变已定义智能体的执行链路、权限模型和 server API。
- 第一期不改变本地对话 UI 的渲染模型，仍然是"收到 changed 后重新读取"。
- 不支持跨机器访问本地对话。

## 3. 总体架构

```text
Renderer ─IPC─> Desktop Main ─HTTP + WebSocket (loopback)─> daemon (Go) ─stdio JSON-RPC─> sidecar (Electron as Node)
                · 薄代理                               · Local API / 鉴权             · LocalConversationService
                · 需确认操作的执行方                    · sidecar 拉起/监管/drain       · Codex 进程池 / Claude SDK
                · 原生对话框、预览窗口、诊断日志         · 忙碌计数并入 /health          · multica_context MCP 与工具
                                                                                      · @智能体云端发送与轮询
```

整个现有 TS 对话服务原样迁入 sidecar，Go 侧不实现任何对话逻辑。被迁移的模块只依赖 node 内置模块、MCP SDK、Claude Agent SDK、zod 和 `@multica/core` 的类型；Electron 能力全部通过构造参数注入（§12）。

### 3.1 职责划分

| 组件 | 负责 | 不负责 |
| --- | --- | --- |
| Renderer | 对话 UI；显示 host_request 卡片 | 云端调用。现有直接 @智能体 的 `remoteBegin` / `remoteUpdate` 轮询路径删除 |
| Desktop Main | 转发 IPC 与 Local API；执行需要人确认的操作；原生对话框；预览窗口；诊断日志写入与导出 | 会话状态、provider 进程 |
| daemon | Local API 与鉴权；sidecar 的定位、拉起、退避重启、drain；把本地忙碌计数并入 `/health` 和重启屏障 | 对话逻辑、provider 协议 |
| sidecar | 现有 `LocalConversationService` 及其依赖；@智能体云端链路，包括重启后续接轮询 | 原生 UI、需确认操作的最终执行、诊断日志落盘 |

## 4. Sidecar 的定位、打包与运行

### 4.1 不提供注册接口，由 daemon 从自身位置推导

第一版方案设计了 `PUT /local/v1/host` 注册接口，让 desktop 告诉 daemon 去执行哪个程序。这等于把一个"任意执行"能力暴露给了 token 持有者；"同一应用包"校验也能被伪造的目录绕过。本版删除这个接口。

改为由 daemon 从自身可执行文件的位置推导 sidecar：

- desktop 打包时在 CLI 同级目录写入 `resources/local-conversation-host/manifest.json`，内容为 `{ "protocolVersion", "entry": "index.mjs", "electron": "<相对 CLI 的 Electron 可执行文件路径>" }`。
- daemon 启动时按 `os.Executable()` 定位 `../local-conversation-host/manifest.json`，校验文件存在、路径解析后仍位于同一安装目录。找到就启用本地对话能力，找不到就在 `/health` 中报告 `local_conversations: "unsupported"`。
- 因此本地对话要求 daemon 必须是 desktop 打包的 CLI。brew、PATH 或独立安装的 CLI 拉起的 daemon 不提供本地对话，desktop 会提示"本地对话需要使用 Multica 自带的 daemon"。
- 带来的好处：sidecar 的代码与 daemon 来自同一个安装包，版本天然一致。desktop 现有的版本对齐重启（`daemon-manager.ts:607`）会保证 daemon 与当前 desktop 一致，于是 desktop、daemon、sidecar 三方版本一致。

### 4.2 打包位置

- sidecar 代码作为 desktop 的一个独立构建入口，放在 `apps/desktop/src/local-host/`，由 electron-vite 输出到 `resources/local-conversation-host/index.mjs`，打包方式参照现有的 `developer-logs-mcp.ts`。它只有 desktop 一个使用方，本质是应用产物，所以不新建 `packages/*` 包，以免与"共享包导出源码 TS"的规则冲突。
- 协议类型从 `packages/tutti-agent-gui-host/src/local-protocol.ts`（这是一个 UI 包）移到无 UI 依赖的 `packages/core/local-conversation/`，由 GUI host 和 sidecar 共同引用。sidecar 不依赖任何 UI 包。

### 4.3 运行环境

- daemon 用 manifest 指定的 Electron 可执行文件，以 `ELECTRON_RUN_AS_NODE=1` 运行 `index.mjs`。不依赖系统 Node。
- sidecar 不使用独立进程组。stdin 遇到 EOF 时自行落盘并退出，所以 daemon 即使被 SIGKILL，sidecar 也会随之退出。sidecar 拉起的 Codex 进程仍按现有逻辑管理进程组。
- provider 的运行环境由 desktop 提供，不继承 daemon 的启动环境。具体做法：desktop 在 `session.set` 中携带 `PATH`、`HOME`、`CODEX_HOME`、`CLAUDE_CONFIG_DIR` 和代理变量，sidecar 用它们发现并启动 provider（替代 `local-provider-runner.ts:35` 对 `process.env.PATH` 的依赖）。这些变量通常与 desktop 拉起 daemon 时的 `desktopSpawnEnv()` 相同，显式传递是为了避免 daemon 由别的 desktop 拉起时环境不一致。
- sidecar 按需拉起：daemon 收到第一个 Local API 请求时才启动它，不在 daemon 启动时预先拉起。这是因为重启后队列总是暂停，提前拉起没有收益。

### 4.4 平台限制

| 场景 | 行为 |
| --- | --- |
| Windows desktop 配 WSL2 / 其他系统的 daemon（`daemon-os.ts:41`） | daemon 无法运行 Windows 的 Electron，`/health` 报告 `unsupported`，本地对话不可用。**这是相对现状的功能回退**，接受 daemon 拓扑即接受这一点 |
| Linux AppImage | Electron 运行在 `/tmp/.mount_*` 中，desktop 退出后这个挂载会被卸载。desktop 在退出时通过 drain 等待当前轮次结束，然后停止 sidecar，所以"关闭 desktop 后继续运行"在 AppImage 上不成立 |
| desktop 自动更新 | 安装更新前（`updater.ts` 的 `quitAndInstall` 之前），desktop 调用 `sidecar.drain`：有运行中的轮次时提示用户"等待完成或立即更新"，然后调用 `sidecar.stop`。这样可以避免 Windows 上正在运行的 `Multica.exe` 阻止替换，也可以避免 macOS 应用包在 sidecar 运行期间被换掉 |

### 4.5 daemon 与 sidecar 之间的协议

stdio 上使用换行分隔的 JSON-RPC 2.0。两端的消息格式由同一份 JSON 样例集校验：Go 测试和 vitest 读取同一批 fixture。

daemon → sidecar：

| 方法 | 说明 |
| --- | --- |
| `init` | 数据目录、profile 目录、CLI 路径 |
| `session.set` | `{userId, apiUrl, env, connectionId}`，对应现有 `setCurrentUser` |
| `request` | `{connectionId, scope, method, params}`，透传 `LOCAL_CONVERSATION_METHODS` |
| `hostReply` | host_request 的回复 |
| `drain` | 原子地拒绝新轮次、停止排空队列，返回当前忙碌项 |
| `undrain` | 取消 drain |
| `shutdown` | 落盘，中止运行中的轮次并标记失败，然后退出 |

sidecar → daemon（通知）：

| 通知 | 说明 |
| --- | --- |
| `event` | 会话事件，带 sidecar 实例 ID 和 seq（§5.4） |
| `hostRequest` | 需要 desktop 处理的请求（§6），带目标 `connectionId` |
| `busy` | 忙碌项计数，包括运行中轮次、Claude 后台任务、队列排空、导入 |
| `log` | 结构化日志，由 daemon 写入自身日志 |
| `timing` | 轮次计时数据，转发给 desktop 落盘（§9） |

sidecar 崩溃时，daemon 按指数退避重启它（1 秒起，上限 60 秒），并向所有连接推送 `resync`。

## 5. Local API

### 5.1 位置与鉴权

- 挂在 daemon 现有的 health HTTP server 上（`127.0.0.1:<healthPort>`，`server/internal/daemon/health.go`），前缀为 `/local/v1/`。
- daemon 每次启动生成 32 字节随机 token，写入 `<profileDir>/local-api.token`（权限 0600）。desktop main 读取这个文件；收到 401 时重新读取一次再重试。renderer 不接触 token。
- 每个请求必须同时满足三个条件：带 `Authorization: Bearer <token>`；`Host` 为 `127.0.0.1:<port>` 或 `localhost:<port>`；不带 `Origin` 头。任一条件不满足返回 403。这三条用于防御浏览器 DNS rebinding，做法与现有 `local-context-mcp.ts:96` 一致。
- **威胁模型**：这个 token 文件和 PAT 所在的 `config.json` 位于同一目录，权限相同。同一系统用户下的任何进程，包括 sidecar 拉起的 Codex/Claude，都能读到它们。因此 Local API token 的权限上限视同 PAT，**不能**用它证明"请求来自人"。需要人确认的操作按 §6 的方式处理。
- 顺带修复：`/shutdown` 目前没有鉴权，本地网页可以用 no-cors POST 触发它。由于 daemon 现在还承载本地对话，本次改为同样校验 token、Host 和 Origin。CLI 的 `daemon stop`（`cmd_daemon.go:1422`）改为读取 token 文件后再调用。

### 5.2 传输：HTTP + WebSocket

控制和事件走一条 WebSocket，大数据走 HTTP。两种传输共用 §5.1 的鉴权规则，WebSocket 在握手阶段校验。

库选型使用常见库：Go 侧用 `github.com/gorilla/websocket`（daemon 已依赖，见 `wakeup.go`）；desktop main 用 npm `ws`（握手时可设置 `Authorization` 头）。

HTTP 端点：

| 端点 | 说明 |
| --- | --- |
| `GET /local/v1/hello` | 协议版本、能力列表、daemon 实例 ID、sidecar 状态（`idle` / `starting` / `ready` / `crashed` / `unsupported` / `draining`）、sidecar 的 RSS 和崩溃次数。WebSocket 建立前用于版本门控 |
| `GET /local/v1/ws` | 升级为 WebSocket（见下） |
| `GET /local/v1/files/{scope}/{fileRef}` | 读取附件、输出图片、预览文件的原始字节，带 `Content-Type`，支持 `Range`。`fileRef` 是附件 id、输出图片 key 或预览授权 id，不接受任意路径 |
| `POST /local/v1/files/{scope}` | 上传附件，请求体是原始字节（`Content-Type` 为文件类型，文件名放在 `X-File-Name` 头，按 RFC 5987 编码），流式写入 sidecar 数据目录，返回 fileId。上限 25MB |
| `POST /shutdown` | 已有端点，加鉴权（§5.1） |

文件端点由 daemon 转给 sidecar 解析路径和权限（沿用 `local-resource-reader.ts` 的 cwd 与已批准根目录检查），然后由 daemon 直接流式读写文件，不经过 stdio。

WebSocket 连接：

- 一条连接代表一个 desktop 连接，连接本身就是 `connectionId`，不再需要单独的建连端点。
- 消息格式为 JSON-RPC 2.0，与 daemon↔sidecar 协议一致；daemon 只做鉴权、路由，并给请求打上 `connectionId`。
- 单条消息上限 1MB，超过返回错误，大数据改走文件端点。
- 每 15 秒一次 ping/pong，两次未回应即断开。

desktop → daemon（请求）：

| 方法 | 说明 |
| --- | --- |
| `session.set` | `{userId, apiUrl, env}`。用户与 profile 的 `.desktop-user-id` 不一致时返回错误 `account_mismatch`，desktop 显示"该 daemon 正被其他账号使用" |
| `subscribe` | `{since: "<instance>:<seq>"}`，开始接收事件（§5.4） |
| `request` | `{scope, method, params}`，透传 `LOCAL_CONVERSATION_METHODS` |
| `hostReply` | `{id, result}` 回复 host_request |
| `sidecar.drain` / `sidecar.undrain` / `sidecar.stop` | 更新和退出流程使用（§4.4） |

daemon → desktop（通知）：`event`、`hostRequest`、`hostRequestResolved`、`sidecarStatus`、`resync`。

`request` 采用单一透传方法，原因是方法集合已经由 `LOCAL_CONVERSATION_METHODS` 定义并做版本门控，daemon 不需要理解每个方法。desktop 侧的 `local-conversation-proxy.ts` 用 zod 解析 `hello`、所有通知和 host_request，未知的枚举值落入兜底分支。方法是否可用由 `hello` 返回的能力列表决定。

连接断开的含义：

- 发给这个连接的 pending host_request 立即失败（`settings_host_unavailable`），不等 90 秒超时。
- 连接断开不影响正在运行的轮次。
- desktop 断线后按指数退避重连（500ms 起，上限 10 秒），重连后重新 `session.set` 和 `subscribe`。

### 5.3 二进制数据：全程不转 base64

现状有五处把文件转成 base64 传递：`fileStore` 收 base64（`local-conversation-service.ts:348`）、`fileRead` 返回 base64（`:367`）、`imageRead` 和输出图片（`local-output-images.ts:45`）、预览（`local-resource-reader.ts:59`）、@智能体上传前从 base64 解码（`local-queued-cloud-run.ts:34`）。迁移后一律改为原始字节：

| 环节 | 做法 |
| --- | --- |
| WebSocket / stdio JSON-RPC | 只传元数据（fileRef、名称、类型、大小），不传文件内容。协议 zod schema 中删除 `data` 字段 |
| renderer 读文件（图片、附件、预览） | 一律 HTTP `GET`。renderer 请求 `multica-local-file://<scope>/<fileRef>`，main 的 `protocol.handle` 只负责补上 token，把请求原样转成 daemon 的 `GET /local/v1/files/...`，响应流原样返回（含 `Range`）。renderer 不接触 token |
| renderer 写文件（上传附件，包括选择、粘贴、拖入） | 一律 HTTP `POST`。renderer 对 `multica-local-file://<scope>/upload` 发 `fetch(..., {method: "POST", body: file})`，main 同样只补 token，把请求体流原样转给 daemon 的 `POST /local/v1/files/{scope}`。不走 IPC，不区分有无本地路径 |
| daemon ↔ 文件 | daemon 向 sidecar 发 `file.resolve {scope, fileRef}` 拿到已校验的绝对路径（沿用 `local-resource-reader.ts` 的 cwd 和已批准根目录检查），然后 daemon 自己用 `http.ServeContent` 读文件；上传时 daemon 写入临时文件，再调 sidecar `file.commit` 登记元数据。文件内容不经过 stdio |
| @智能体上传附件到云端 | sidecar 从磁盘读文件流，`multipart/form-data` 直接上传 `POST /api/upload-file`，不经过 base64 |
| Codex 输出图片 | provider 本身以 `data:` URL 返回图片，这是输入格式无法改变；sidecar 收到后只解码一次并落盘，此后按文件处理 |

例外：MCP 工具 `read_attachment` 目前对 4MB 以内的文件附带 base64 内容（`local-multica-context.ts:137`）。这是给模型的 MCP 返回值，与 desktop 传输无关；本次改为只返回本地路径，模型用自己的文件工具读取（工具说明已经要求这样做）。MCP 规范中的图片内容块本身是 base64，那部分不在本方案范围内。

`fileStore`、`fileRead`、`imageRead`、`preview*` 的返回值变化随 B-2 一起计入协议 v2。

### 5.4 事件流

- seq 由 sidecar 分配，带 sidecar 实例 ID；daemon 只负责转发，并保留最近 1024 条事件的环形缓冲。
- 第一期事件保持现有语义 `{type: "changed", scope, sessionId}`，通过 WebSocket 的 `event` 通知推送。
- `subscribe` 时带上 `since`。如果缓冲还覆盖这段事件，就补发；如果不覆盖，或者 sidecar 实例 ID 变了，先推送 `resync`。客户端收到后对当前打开的会话执行全量 `list` 加 `read`；pending 的 host_request 会随 `resync` 一起重发给对应连接。
- 事件中不出现任何密钥或令牌。

## 6. 需要人参与的操作

### 6.1 原则：需要确认的操作由 desktop 执行

由于 Local API token 无法区分人和 agent（§5.1），确认结果不能从 Local API "回复"给 sidecar 后由 sidecar 执行，否则 agent 可以伪造批准。本版改为：

- **需要确认的写操作由 desktop 执行。** sidecar 发出 `hostRequest{kind: "confirmed_operation", operation, input}`。desktop main 先弹出原生对话框；用户确认后，desktop 用自己的登录态执行该操作，再把结果回复给 sidecar。
- agent 伪造回复最多只能让工具调用方收到一个假的"已完成"，不会产生任何真实写入。在这个前提下，确认关卡仍然只由 desktop 的原生弹窗决定，与现状等价。
- `settings_create_token` 的密钥由 desktop 生成和展示，不经过 sidecar，不进入事件流，也不写入日志。

### 6.2 类型

| kind | 原实现 | 新实现 |
| --- | --- | --- |
| `ask_user` | `service.askUser`，问题保存在 turn 上，renderer 通过 `answerQuestion` 回答 | **保持不变**，不改成 host_request |
| `confirmed_operation` | `desktop-settings-host.ts:49` 的 `dialog.showMessageBox`，确认后由 main 执行 | desktop 弹窗并执行，执行结果回复给 sidecar |
| `settings_host` | `settings-host:request` 交给 renderer 处理（`settings_open`、设备操作） | 由 desktop 转给 renderer，行为不变 |
| `pick_directory` | `index.ts:695` 的 `dialog.showOpenDialog`（会话目录、`folderProjectAdd`、`previewChoose`） | 只发给发起请求的那个 `connectionId` |
| `developer_logs_export` | `index.ts:706` 的 `DeveloperLogExporter` | desktop 执行导出并返回文件路径（§9） |

### 6.3 语义（与现状对齐）

- **没有可用 desktop 时立即失败。** 目标连接不存在或已断开，或连接的用户与请求的 scope 不一致时，立即返回 `settings_host_unavailable`，与 `desktop-settings-host.ts:19-22` 一致，不挂起等待。
- **超时 90 秒**（与 `desktop-settings-host.ts:31` 一致）。超时后返回 `settings_host_timeout`，并告知调用方"没有确认成功的更改"。
- **回复绑定登录会话代数。** desktop 发起请求时记录 `authSessionGeneration`，账号切换后到达的回复一律作废（与 `:15,51` 一致）。
- **只有第一个有效回复生效**，后续回复返回 409。
- **sidecar 或 daemon 重启后，pending 的 host_request 全部作废**，对应的工具调用失败；轮次本身按 §2 标记为失败。

## 7. 身份、凭据与作用域

- daemon profile 与 apiUrl 一一对应：desktop 使用 `desktop-<host>`（`daemon-profile.ts:28`）。多个 desktop 共用同一个 profile，即共用同一个 sidecar 和同一份数据目录。
- **sidecar 只服务当前 profile 的用户**，即 `.desktop-user-id`。这个文件只由 desktop 的 `syncToken` 写入（`daemon-manager.ts:741-743`）。另一个 desktop 登录了不同账号时，`session.set` 返回 `account_mismatch`，本地对话显示不可用，不会互相中止对方的运行。`daemon-profile.ts:70` 中"Go 从不读取 `.desktop-user-id`"的说明需要相应更新：现在 sidecar 会读这个文件，Go 侧依旧不读。
- **scope key 使用 desktop 传入的 apiUrl 原文**（`runtimeConfig.apiUrl`），不使用 profile 里 CLI 规范化后的 `server_url`。否则 key 不一致，迁移过来的数据会全部"看不见"。
- **云端凭据**：沿用 `LocalMulticaContext.credentials` 的逻辑，读取 profile `config.json` 中的 PAT，并用 `GET /api/me` 校验用户是否匹配。PAT 由 desktop 写入，daemon 续期时只延长 `expires_at`，不写文件（`daemon.go:4051-4073`）。sidecar 每轮重新读取凭据。
- **未登录、PAT 缺失或用户不匹配时**，本地对话整体不可用，显示登录或重新认证的提示（已定约束）。

## 8. @智能体云端链路

- 现有两条实现，main 的 `local-queued-cloud-run.ts` 和 renderer 直接调用 core `api` 的那条，合并为 sidecar 里的一条，统一使用 PAT。链路不变：`POST /api/chat/sessions`，上传附件，发送消息，每 2 秒轮询 `/api/chat/sessions/{id}/messages`、`/api/tasks/{id}/messages`、`/api/agents/{id}/tasks`；取消时调用 `POST /api/tasks/{id}/cancel`。
- **重启后续接轮询。** 加载 scope 时（`local-conversation-service.ts:161`），`turn.remote` 已经存在且状态为 running 的轮次，由 sidecar 继续轮询。这接替了 renderer 中 `pollRemote` 现在承担的接管职责（`renderer/src/platform/local-conversation-service.ts:78-115`）。如果消息发送未确认就中断了，则标记为失败，与现有分支一致。
- **协议版本升到 2。** 从 `LOCAL_CONVERSATION_METHODS` 中删除 `remoteBegin`、`remoteUpdate`，renderer 删除对应代码；同时按 §5.3 去掉文件方法中的 base64 `data` 字段。

## 9. 诊断与开发日志

- `diagnostics/` 目录留在 desktop 的 `userData` 中，不迁移。`WebDiagnosticLog`、developer-logs stdio MCP（`index.ts:173,724-739`）、`DeveloperLogExporter` 的数据源都保持不变。
- sidecar 的 `LocalTimingLog` 改为发送 `timing` 通知，经 daemon 和事件流转给 desktop，由 desktop 写入原来的 `turn-timing.jsonl`。desktop 未连接期间的计时数据会丢失，这是已知限制。
- 导出工具 `export_developer_logs` 走 host_request `developer_logs_export`，由 desktop 执行导出。导出内容新增 sidecar 状态（来自 `hello`）。

## 10. daemon 改动

- **新包 `internal/daemon/localhost/`**：包含 manifest 定位、Local API handler、token 文件、连接表、事件环形缓冲、host_request 路由、sidecar 监管（按需拉起、退避重启、drain、stop）。
- **`health.go`**：在现有 mux 上挂载 `/local/v1/`；`/shutdown` 增加鉴权；`/health` 增加 `local_conversations`（`supported` / `unsupported`）和 `local_busy_count` 两个字段。
- **重启屏障**：凡是现在检查 `d.activeTasks` 的地方，都把 sidecar 的忙碌计数一并算入，包括 server 触发的升级 `tryBeginServerUpdate`（`daemon.go:5034,5047`）、`tryAutoUpdate`、`trySelfReload`。后两者对 desktop 拉起的 daemon 本来就跳过（`auto_update.go:117`），这里保持一致即可。屏障检查前先对 sidecar 执行 `drain`，消除"检查通过后又开始了新轮次"的竞态；如果最终不重启，就执行 `undrain`。
- **启动和认证逻辑不变。** `resolveAuth` 或 `preflightAuth` 失败时 daemon 照常退出，本地对话随之不可用。
- **daemon 停止时**，先向 sidecar 发 `shutdown`，超时 10 秒后关闭它的 stdin，再结束进程。

## 11. desktop 改动

- **新增 `local-conversation-proxy.ts`**：读取 port 和 token 文件，用 `ws` 建立 WebSocket 连接并订阅事件，转发 `local-conversation:request` IPC，处理 host_request，把 `timing` 写入日志。
- **`ensureRunningDaemonVersionMatches`**：`decideVersionAction` 把 `local_busy_count` 算作忙碌，有本地轮次在跑时推迟版本对齐重启。
- **其余主动重启或停止 daemon 的路径**（切换用户 `:748`、重新认证 `:840`、登出时的 `stopDaemon`、退出时的 `autoStop` `:1499`）会中断本地轮次，这是已定约束。其中 `autoStop` 打开时，"关闭 desktop 后继续运行"不成立；设置项旁边需要说明"退出时也会停止本地对话"。
- **退出流程**：未开启 `autoStop` 时，desktop 只断开连接，不停止 sidecar。AppImage 例外，按 §4.4 处理。
- **自动更新**：按 §4.4 先 drain 再 stop。
- **renderer**：删除 `remoteBegin` / `remoteUpdate` 路径；文件读写改用 `multica-local-file://`（§5.3）；根据 `hello` 和 `/health` 增加几种不可用状态的提示，分别是未登录、daemon 未运行、`unsupported`（WSL 或非自带 CLI）、账号不一致、sidecar 崩溃中。

## 12. 代码迁移清单

迁入 `apps/desktop/src/local-host/`，逻辑不改，只把 Electron 依赖改为注入：

- 会话服务：`local-conversation-service.ts`、`local-conversation-title*.ts`、`local-conversation-import.ts`
- Codex：`local-codex-pool.ts`、`local-codex-worker.ts`、`local-codex-rpc.ts`、`local-codex-stream.ts`、`local-codex-context-bridge.ts`、`local-codex-instructions.ts`
- Claude：`local-claude-conversation.ts`、`local-background-task-output.ts`
- provider 通用：`local-provider-runner.ts`、`local-provider-fork.ts`、`local-provider-models.ts`、`local-provider-usage.ts`、`local-provider-extensions.ts`、`local-native-history.ts`
- MCP 与工具：`local-context-mcp.ts`、`local-multica-context.ts`、`local-context-data.ts`、`local-workspace-tools.ts`、`local-settings-tools.ts`、`local-agent-avatar.ts`、`local-avatar-file.ts`、`local-user-question.ts`、`local-queued-cloud-run.ts`
- 文件与资源：`local-resource-reader.ts`、`local-output-images.ts`
- 共用的小模块：`daemon-profile.ts` 中的 profile 路径函数、`settings-operation-error.ts`，抽为 main 与 local-host 共用的模块
- 以上各文件对应的测试

留在 desktop：

- daemon 管理：`daemon-manager.ts`、`daemon-*.ts`
- 智能体资源目录选择器：`local-directory.ts`（`setupLocalDirectory`，`index.ts:985`），它不属于对话流
- 预览：`resource-web-preview.ts`、`html-preview-navigation.ts`。预览所需的文件通过 `multica-local-file://` 协议读取（§5.3）
- 日志与诊断：`developer-log-export.ts`、`developer-logs-mcp*.ts`、`local-timing-log.ts`（只负责写入）
- 设置确认：`desktop-settings-host.ts`，改为执行 `confirmed_operation`
- `findLocalProvider`（`index.ts:31,734`），供开发日志 MCP 注册使用

需要注入或替换的 Electron 依赖：

| 现有依赖 | 替换 |
| --- | --- |
| `app.getPath("userData")` | `init.dataDir`（`<profileDir>/local-conversations/`） |
| `dialog.showOpenDialog` | host_request `pick_directory` |
| `mainWindow.webContents.send` | `event` 通知 |
| `app.on("before-quit")` | sidecar `shutdown`；desktop 退出不再停止对话 |
| `bundledCliPath()` | `init.cliPath`（daemon 自身的路径） |
| `desktop-settings-host.ts` | host_request `confirmed_operation` / `settings_host` |
| `DeveloperLogExporter` | host_request `developer_logs_export` |
| `AUTH_SESSION_STATE_CHANNEL` 身份同步 | WebSocket `session.set` |
| `process.env.PATH` 等环境变量 | `session.set` 中的 `env` |

## 13. 数据迁移

迁移是一次性、单向的，没有回退开关。旧版本中的进程内实现会整体删除，不保留双路径。

- **目标目录**：`<profileDir>/local-conversations/`。
- **迁移内容**：`<scopeKey>/conversations.json`、`<scopeKey>/files/`、`<scopeKey>/preview-roots.json`、`settings-operation-receipts/`、`avatar-operation-receipts/`。
- **不迁移的内容**：
  - `<scopeKey>/workdirs/`：会话中保存的 `cwd` 是绝对路径，Claude（`~/.claude/projects/`）和 Codex 的会话记录也都按 cwd 归档，移动目录会导致 resume 失败。迁移后旧路径继续作为这些会话的 cwd；新建会话的默认工作目录放在新数据目录下。
  - `diagnostics/`：留在 desktop（§9）。
  - `cli-context/`：每次启动都会清空。
- **流程**：
  1. 新版 desktop 首次连接 sidecar 时，调用 `migrate {legacyDir}`。新版 desktop 中已不存在进程内服务，因此同一个 desktop 内不会出现并发写入。
  2. sidecar 读取 `<dataDir>/migrations.json`，按来源目录记录迁移状态。正式版、Canary、开发构建各自的 `userData` 分别迁移一次。
  3. 如果 scope 冲突（两个渠道都有同一用户、同一工作区的数据）：会话按 `id` 合并，id 相同的保留 `updatedAt` 较新的一份；文件按 uuid 合并；`folderProjects` 按 `id` 合并。
  4. 在来源目录写入 `MIGRATED_TO` 标记，原数据保留不删。
- **已知限制**：如果旧版 desktop（其他渠道或降级安装）仍在运行，它会继续写入自己的 `userData`，这些新增内容不会再次迁移。

## 14. 发布与验证

分期（不设运行时开关，开发分支完成后一次切换）：

1. **P0 拆分**：把对话服务移到 `apps/desktop/src/local-host/`，协议移到 `packages/core/local-conversation/`，Electron 依赖改为注入。此阶段 desktop 仍在进程内使用这部分代码，行为不变，现有测试迁移后全部通过。这只是开发中间状态，不单独发布。
2. **P1 接入 daemon**：manifest 定位、Local API、sidecar 监管与 drain、host_request（包括 `confirmed_operation`）、`/shutdown` 鉴权、desktop 代理、重启屏障、@智能体合并与续接、数据迁移、诊断转发，同时删除进程内路径。P1 作为一个整体发布。
3. **P2 体验**：增量事件，不再"收到 changed 后整段重读"；为长期常驻的 Codex 进程池和 Claude 会话加空闲回收和数量上限。

验证：

- **sidecar 单测**：迁移现有的 `local-*.test.ts`；新增重启后续接远程轮次、迁移合并、`session.set` 环境变量注入的测试。
- **Go 测试**（使用测试内的假 sidecar 脚本，不调用真实 provider）：
  - Local API 鉴权：缺 token、Host 错误、带 Origin 时均返回 403
  - `/shutdown` 鉴权
  - manifest 定位与 `unsupported` 状态
  - 事件补读与 resync
  - WebSocket 握手鉴权（缺 token、Host 错误、带 Origin 均拒绝）、消息大小上限、心跳超时断开
  - 连接断开时其 pending host_request 立即失败
  - 文件端点的路径检查、Range、25MB 上限；上传和下载都不经过 sidecar stdio
  - host_request 定向投递、首个回复生效、超时
  - 退避重启
  - drain 与重启屏障的竞态
  - stdin EOF 时 sidecar 退出
- **契约测试**：Go 与 vitest 共用 JSON fixture；`local-conversation-proxy.ts` 对畸形响应的处理。
- **desktop 测试**：`multica-local-file://` 的 GET/POST 流式透传与 Range、文件内容不经过 IPC 和 WebSocket、WebSocket 断线重连与重新订阅、token 轮换后重新读取、`daemon.port` 变化、版本对齐重启时延后、自动更新时 drain、两个 desktop 共用一个 profile。
- **E2E**：关闭 desktop 后运行中的轮次继续，重新打开后可以看到结果；daemon 重启后队列暂停，手动继续后可以正常执行。需要覆盖 Windows。

## 15. 风险与待决问题

1. **WSL2 场景功能回退**（§4.4）：现在可用的本地对话将不可用。需要产品确认，或者在界面中给出明确提示。
2. **离线不可用**：daemon 的 `preflightAuth` 在 server 不可达时也会让 daemon 退出，因此离线时本地对话不可用，而现在离线也能用。这是"未登录不可用、daemon 不加仅本地模式"这一决定带来的连带后果。
3. **macOS 权限归属**：daemon 由 launchd 或登录项拉起时，sidecar 访问"文稿"或"桌面"目录触发的权限弹窗，其归属进程可能不再是 `Multica.app`。需要实测。
4. **常驻资源占用**：Electron 以 Node 模式常驻约占 50–100MB；Codex 进程池和 Claude 会话在 desktop 关闭后仍会保留。P2 加入回收机制前，可以先通过 `hello` 观察。
5. **多个 desktop 共用一个 profile 时的版本对齐**：不同渠道打包的 CLI 版本不同，会互相触发版本对齐重启。这个问题现在已经存在，本方案只是让它每次额外中断一轮本地对话（只在空闲时发生）。
