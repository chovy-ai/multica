# 设备互联对话流

在本机 Desktop 中，通过已有的 p2p 设备链路使用同账号另一台设备上的本地对话流。功能名为**设备互联**（英文 **Device link**）。「Relay」只保留传输层含义：两台设备无法直连时，由 libp2p circuit relay 转发连接。

## 范围

第一版包含：

- 被访问端的开关：允许同账号的其他设备使用本机对话流，默认关闭。
- 每台可用设备对应一个对话流侧边栏入口和 tab。没有可用设备时，侧边栏保持不变。
- 远端 tab 复用对话流界面，目录、Session、消息、运行、模型和文件都读取远端设备，执行也在远端设备上。
- 通过现有的事件游标和重新同步机制实现实时更新和重连。
- 优先直连，尽量不经中继。

暂不包含：

- 两台设备同时操作同一个 Session 时的协调。不做限制，也不额外提示。
- 设置中的设备列表和逐台管理。侧边栏入口是临时方案。
- Session 跨设备迁移，以及离线设备的展示。

## 交互

### 设置 → 本设备 → 设备互联

仅 Desktop 提供，通过 `extraDeviceTabs` 加在实验室和守护进程旁边。p2p 未启用时不显示。页面只有一个 `Switch`：

| 元素 | zh-Hans | en |
| --- | --- | --- |
| Tab | 设备互联 | Device link |
| 开关标签 | 允许其他设备访问本机对话流 | Allow other devices to use conversations on this device |
| 开关说明 | 同一账号的其他设备可以查看本机对话、读取对话中的文件，并在本机运行智能体。 | Other devices signed in to this account can view conversations on this device, read their files and run agents here. |

保留这句说明，是因为它说明的是权限后果（见开发规范「UI 描述性文案」）。页头等其他位置不再重复。

打开开关时弹出 `AlertDialog`（重要操作确认，见 `packages/ui/docs/dialog.zh.md`）：

- 标题：允许其他设备访问本机？ / Allow other devices to use this device?
- 说明：它们可以在本机运行智能体并读写本机文件。 / They can run agents and read and write files on this device.
- 操作：取消 / Cancel，允许 / Allow。守护进程确认成功后再关闭弹窗；失败时保留弹窗并显示错误，开关保持关闭。

关闭开关不需要确认。其他设备上已打开的远端 tab 会显示「已关闭」状态。

### 侧边栏

- 没有可用设备：只有一个 **对话流 / Conversations** 入口，保持不变。
- 有一台或多台可用设备：先显示 **对话流（本地）**，再为每台设备显示 **对话流（{设备名}）**。「可用」指登录同一账号、当前已连通，并且开启了设备互联。同一台机器上的其他 profile（例如 Canary）是独立设备，也会出现。
- 入口复用 `NAV_ITEM_CLASS_NAME` 和对话流的路由图标，不新增徽标、颜色或说明。设备名过长时截断；悬停时仍能认出选中项。
- 选中状态：现有 `isNavActive` 按前缀匹配，会让「对话流（本地）」在 `/conversations/devices/…` 下同时高亮。本地入口改为排除 `/conversations/devices/` 前缀，设备入口精确匹配自己的路径。
- 设备变为不可用时，入口从侧边栏消失。已打开的 tab 保留，并显示断线状态。

### 远端 tab

- 标题为 **对话流（{设备名}）**；图标与其他 tab 一样，由路由推导。
- 路由：`/{slug}/conversations/devices/{peerId}`。设备必须放在 pathname 中：tab 去重只看 pathname（`tab-store.ts`），`?session=` 等查询参数属于 tab 内的视图状态。
- tab 内容与现有对话流完全一致，不做任何改变。区别只在数据来源和执行位置：都换成远端设备。
- 远端操作归属：

| 操作 | 行为 |
| --- | --- |
| 添加目录、选择预览文件（`folderProjectAdd`、`previewChoose`） | 入口不变，点击后用 Dialog 列出远端设备上的目录或文件：「选择 {设备名} 上的文件夹」/ Choose a folder on {device}。不使用原生选择器。 |
| 点击文件路径、文件树、图片和文档预览 | 从远端设备读取。 |
| 消息中的附件 | 通过文件协议从远端读取，不使用 `fileInfo` 返回的 `file://` 地址。 |
| 在输入框添加附件 | 发送前先上传到远端设备。 |
| 文件右键菜单 | 隐藏「在 Finder 中显示」和「打开」，提供「保存到本机」。 |
| 网页预览、Side 浏览器 | 公网地址照常打开，预览实例按设备隔离。回环地址（`localhost`、`127.0.0.1`、`[::1]`）不打开，提示「这是 {设备名} 上的本地地址」。 |
| 智能体打开 Side 会话、文件 tab | 照常在远端 tab 的右侧工作区打开。 |
| 账号或工作区设置确认 | 在发起这轮运行的设备上确认，弹窗标明来自哪台设备，用这台设备的登录凭据应用到云端。 |
| 设备设置（读写偏好、快捷键、守护进程和更新操作） | 拒绝：「这项设置只能在 {设备名} 上修改」。 |
| 导出开发者日志 | 第一版不支持。 |

- 异常提示复用现有的 `LocalRuntimeNotice`，位置和样式不变，只补充远端设备的文案。连接正常时不显示。

| 状态 | 错误码 | zh-Hans | en |
| --- | --- | --- | --- |
| 正在重连 | `device_unreachable` | 与 {设备名} 的连接已断开，正在重连 | Lost connection to {device}. Reconnecting… |
| 被访问端准备中 | `host_not_ready` | {设备名} 正在准备，稍后自动重试 | {device} is getting ready. Retrying shortly… |
| 被访问端已关闭 | `device_link_off` | {设备名} 已关闭设备互联 | {device} turned off Device link |
| 版本不一致 | `incompatible` | 两台设备的 Multica 版本不一致，更新后再试 | Update Multica on both devices to the same version |
| 服务端不一致 | `api_url_mismatch` | {设备名} 连接的是另一个 Multica 服务端 | {device} is connected to a different Multica server |
| 中继下的大文件 | `relay_transfer_limited` | 当前经中继连接，暂不能传输大于 5 MB 的文件 | Files over 5 MB are unavailable while connected through the relay |

断线期间保留已加载内容和草稿，不把正在运行的任务标记为失败。连接恢复前禁用发送。重连后从游标续传，或重新同步；待处理的目录选择和设置确认在宽限期内保持有效。被访问端更新时进入 drain，期间发起执行返回 `host_draining`，复用现有文案。

## 能力归属原则

每项能力按它作用于哪台机器划分：

- **机器**：数据、执行、文件、目录、执行环境、端口。实现放在守护进程或 sidecar。本地 tab 经回环访问，远端 tab 经 p2p 访问，只有一份实现。
- **查看端**：窗口、弹窗、确认、网页渲染、保存到本机。实现留在 Electron，由发起请求的那台查看端处理。

host request 只保留需要人操作的请求。今后新增涉及机器数据的能力，写在 sidecar 或守护进程中，不写进 Electron 主进程，否则每项能力都要为远端 tab 单独补一次。

## 数据链路

```text
MacBook（查看端）                                         Mac Studio（被访问端）
渲染进程  设备专属 client（context 注入）
  → IPC local-conversation:request(deviceId, scope, method, params)
Electron 主进程  按 deviceId 选择 LocalHostProxy
  → 回环 HTTP/WS /local/v1/devices/{peerId}/...（校验本机 token）
本机守护进程  ReverseProxy，删除 Authorization
  → p2p.Dial(peerId, /multica/local-api/1)  ══优先直连══▶  p2p.Listen
                                                          localhost.Server.ServeRemote
                                                            → sidecar（数据、执行、文件）
```

Desktop 与守护进程之间的 Local API（`/hello`、`/ws`、`/files`）原样承载在 p2p 流上的 HTTP 中。版本检查、断线重连与游标续传、WebSocket ping/pong、文件 Range 读取和上传都直接复用。

### 0. 设备发现

1. 守护进程向 p2p-server 登记公钥和地址（含中继地址），并拉取同账号设备生成 allowlist。
2. 连接顺序：局域网 mDNS 或直连，失败时经中继，之后尝试 DCUtR 打洞升级为直连。
3. 被访问端打开开关后注册 `/multica/local-api/1`，通过 identify 推送给其他设备。
4. 查看端 `GET /local/v1/devices` 返回 allowlist 中已连接且支持该协议的设备：`{ peerId, deviceName, connection: direct | relayed }`。Electron 在窗口聚焦时每 5 秒轮询一次，更新侧边栏。

### 1. 握手

```text
打开远端 tab → 主进程为该设备获取 LocalHostProxy(basePath=/local/v1/devices/{peerId})，引用计数 +1
 → GET  …/hello        版本不一致 → incompatible
 → WS   …/ws           WebSocket upgrade 透传，长期占用一条 p2p 流
 → session.set {userId, clientKey}
       被访问端丢弃 env 和 legacyDataDir，标记 remote，按 clientKey 绑定连接
       sidecar 已被本机锁定或本机 env 未就绪 → host_not_ready
       apiUrl 不同 → api_url_mismatch
 → subscribe {since: cursor}
```

### 2. 读取和执行

```text
渲染进程 useQuery(key 带 deviceId) → deviceClient.request(scope, method)
 → IPC(deviceId) → proxy(deviceId) → JSON-RPC "request"
 → 隧道 → ServeRemote → handleClient（远端客户端）→ sidecar → 原路返回
```

### 3. 实时更新

```text
sidecar notify event {changed, scope, sessionId}
 → 被访问端守护进程写入事件 ring（1024 条），分配 seq
 → 放入每个客户端各自的发送队列（不再同步串行写）
     本机客户端：逐条发送
     远端客户端：同一 (scope, sessionId) 的 changed 在 250ms 窗口内合并为一条；不发送 timing
     队列满：清空并发送 resync
 → 查看端 proxy 记录 cursor → IPC changed(deviceId)
 → 渲染进程使对应 query 失效 → 重新 read
```

### 4. 文件

```text
读取：multica-local-file://local/files/{ref}?deviceId=… → protocol.handle 选择 proxy
 → GET …/devices/{peerId}/files/{ref}（Range 透传）→ sidecar file.resolve → ServeContent
上传：POST …/devices/{peerId}/files → 被访问端临时文件 → sidecar file.commit → 文件 id
保存到本机：previewRead/previewLocate 拿到 fileRef → IPC local-conversation:save-file(deviceId, scope, fileRef)
 → 主进程 showSaveDialog → proxy.file 流式写入本机文件
仅经中继时：读取超过 5 MB（按 Content-Length）或上传超过 5 MB → relay_transfer_limited
```

### 5. 反向请求（以选择目录为例）

```text
查看端「添加目录」→ request folderProjectAdd → 被访问端 sidecar 需要选择目录
 → bridge.hostRequest("pick_directory")，origin = 查看端的 clientKey
 → 被访问端守护进程 Notify hostRequest → 隧道 → 查看端 proxy(deviceId)
 → 远端 proxy 的处理函数 → IPC 让渲染进程弹出远端目录选择 Dialog
     每层目录：request directoryList {path} → 走第 2 节的链路
 → hostReply {path} → 隧道 → sidecar 继续
```

### 6. 断线、迁移到直连和恢复

```text
p2p 断开 → WS 关闭 → proxy 状态 unavailable → 「正在重连」
 → 待处理的 hostRequest 按 clientKey 保留 60 秒宽限期
 → libp2p 重新连接 → proxy 退避重试 hello → ws → session.set{clientKey} → subscribe {since}
     宽限期内的 hostRequest 重新下发给新连接
     ring 仍覆盖 → 补发漏掉的事件
     超出 ring 或 sidecar 重启 → resync → 打开的视图整体重新读取
中继升级为直连 → 查看端守护进程关闭走中继的隧道流 → proxy 立即重连（不显示断线提示），新流走直连
被访问端关闭开关 → 移除协议并断开远端客户端 → device_link_off → 下次轮询时侧边栏入口消失
关闭最后一个该设备的 tab → 引用计数归零，60 秒后关闭 proxy
```

## 优先直连

- 直连顺序：局域网 mDNS → 登记的直连地址（含 NAT 端口映射和观察到的公网地址）→ 中继，随后 DCUtR 打洞。
- 建立隧道前：如果到该设备只有中继连接，`p2p.Dial` 最多等待 5 秒，等打洞得到直连后再开流；超时才使用中继。
- 打洞成功后：守护进程订阅连接事件，出现非 circuit 连接时，关闭这台设备上所有走中继的隧道流（包括 HTTP 连接池里的空闲连接），proxy 立即在直连上重建 WebSocket。libp2p 新开流时优先选择直连。
- 仍然只有中继时：会话读写照常；单个文件读取或上传超过 5 MB 时返回 `relay_transfer_limited`。
- `/local/v1/devices` 返回 `connection`，并写入诊断日志，便于统计中继占比。侧边栏不显示连接类型。

## 能力清单

远端 tab 涉及的全部读写，按链路分为六类。

### ① sidecar 请求：自动经隧道

| 类别 | 方法 |
| --- | --- |
| 配置和环境 | `providers`（安装和登录状态）、`models`、`usage`、`capabilities`、`runtimeState` |
| 目录 | `folderProjects`、`folderProjectAdd`、`directory`、`directorySource`，新增 `directoryList` |
| 会话 | `list`、`listPage`、`read`、`create`、`update`、`fork` |
| 执行 | `send`、`cancel`、`answerQuestion`、`stopBackgroundTasks`、`remoteSend`（会话中调用云端智能体） |
| 队列 | `queueEnqueue`、`queueUpdate`、`queueSide` |
| Side | `sideCreate`、`sideAccepted`、`sideWorkspaceSync`、`sideWorkspaceState` |
| 相关文件 | `previewList`、`previewRead`、`previewLocate`、`previewChoose`、`imageRead`、`fileInfo` |
| 导入 | `importScan`、`importSessions`、`importCancel` |

`remoteBegin`、`remoteUpdate`、`fileStore`、`fileRead` 是 sidecar 内部方法，客户端不能调用。

### ② 文件 HTTP：自动经隧道

`multica-local-file://local/files/{ref}` 和 `multica-local-file://local/upload` 的 URL 带上 `deviceId`，主进程据此选择 proxy。附件的展示和下载地址由渲染进程按设备生成为这个协议的 URL，不使用 `fileInfo.url`（被访问端的 `file://` 路径）。

### ③ 反向请求：由查看端的 proxy 按设备处理

| kind | 本地 proxy | 远端 proxy |
| --- | --- | --- |
| `pick_directory`、`pick_preview` | 原生选择器 | 远端目录或文件选择 Dialog |
| `side_workspace` | 现有处理 | 照常处理，owner 带 deviceId，`sideWorkspaceSync` 的 reconcile 按设备进行；回环地址拦截 |
| `settings_host`、`confirmed_operation` | 现有处理 | 按 operation 名分流，见下表 |
| `developer_logs_export` | 现有处理 | 拒绝 `unsupported_host_request` |

settings 分流（`apps/desktop/src/local-host/local-settings-tools.ts`、`packages/core/settings/operations.ts`）。没有 `request` 的操作走 `settings_host`，需要确认的写操作走 `confirmed_operation`，其余写操作由被访问端 sidecar 直接调用云端：

| operation | 通道 | 远端 proxy |
| --- | --- | --- |
| `settings_refresh`、`settings_assert_scope`、`settings_cancel`、`settings_capabilities`、`settings_open` | `settings_host`，查看端界面 | 照常处理 |
| 需要确认的账号和工作区写操作（members、workflows、mcp、tokens 等） | `confirmed_operation` | 照常确认，弹窗标明来源设备；查看端根据 operation 和 input 重新生成请求，不直接执行被访问端给出的 `apply` |
| `settings_read_device`、`settings_update_device`、`settings_set_shortcut`、`settings_device_action` | `settings_host`，设备 | 拒绝，提示只能在该设备上修改 |
| 不需要确认的写操作、读取 | 被访问端 sidecar 直接调用云端 | 不经过查看端，同账号，结果一致 |

### ④ Electron 主进程直接操作本机的能力

| 能力 | 归属 | 远端 tab |
| --- | --- | --- |
| provider 执行环境（`localProviderEnv`） | 机器 | 下沉：被访问端持久化，sidecar 自行读取 |
| 文件右键菜单（`localFileContextMenu`） | 机器和界面，无法跨机 | 改为「保存到本机」（新增 `local-conversation:save-file`，`file:download-url` 只放行 http(s)，不复用） |
| 网页预览（`resource-preview`）、Side 浏览器 | 渲染在查看端 | owner 带 deviceId；回环地址拦截 |
| 开发者日志导出 | 守护进程日志属于机器，Web 日志属于查看端 | 第一版不提供 |
| 计时诊断（`timing` 事件） | 机器 | 被访问端不向远端广播 |

### ⑤ 查看端本地状态：key 加 deviceId

| 状态 | 位置 |
| --- | --- |
| 输入框草稿 | `composerDraftScope` |
| GUI 偏好（模型、权限模式、推理强度等） | `storage.read/write` 的 `local-provider:` 前缀 |
| 待发送队列 | `desktop-pending-store` |
| 右侧工作区布局 | `local-side-workspace` 的 localStorage |
| 列表布局、项目可见性 | `useConversationLayoutStore`、`useProjectVisibilityStore` |
| Query 缓存 | `localConversationKey`，以及 `resource-folder`、`resource-file` 等单独拼接的 key |
| 能力和版本检查缓存 | `local-conversation-client.ts` 的 capability key |
| 网页预览实例 | `resource-preview` 的 owner |

### ⑥ 云端数据：直连

工作区、智能体、任务引用、云端聊天等，两台设备同一账号，查看端直接请求云端。例外：云端任务的 `chat_session_id` 可能指向其他设备上的会话（`agent-task-panel.tsx`）。打开链接时先在本地查找；找不到时依次在可用设备上 `read`，找到则打开对应设备的 tab；都找不到时提示「这个会话在其他设备上」。

## 实现

### 守护进程（Go）

- `p2p` 包：
  - 新增 `Service.Listen(proto) net.Listener` 和 `Service.Dial(ctx, peer, proto) net.Conn`，基于 `Service.Handle` 和 `Service.Open`，保留 allowlist 检查。不使用 `gostream`：它的 `Listen` 直接调用 `SetStreamHandler`，绕过 allowlist。适配器需要处理半关闭（参考 gostream 的 `IgnoreEOF`）。
  - `RemoteAddr()` 返回 peer ID。
  - 新增 `RemoveHandler(proto)`。
  - `Dial` 在只有中继连接时最多等待 5 秒直连；新增连接变化订阅，供隧道在出现直连后迁移。
- 开关：
  - 保存在 profile 目录的 `device-link.json`。
  - 回环接口 `GET`/`PUT /local/v1/device-link`。p2p 未启用时返回 `unavailable`。
  - 打开时 `Listen` 并用 `http.Server{Handler: ServeRemote, ReadHeaderTimeout, IdleTimeout}` 服务；关闭时 `RemoveHandler`、关闭 listener、断开远端客户端。
- `localhost.Server.ServeRemote`：
  - 不做 loopback 和 token 校验，访问控制由 gater、allowlist 和开关负责。
  - 路径白名单：`GET /hello`、`GET /ws`、`GET /files/*`、`POST /files`。
  - `client` 增加 `remote`、`peer`、`clientKey`。远端客户端：
    - 拒绝 `sidecar.drain`、`sidecar.undrain`、`sidecar.stop`。
    - `session.set` 清空 `Env`、`LegacyDataDir`，带 `Remote: true` 转给 sidecar。
    - 每次 `request` 和文件请求都重新执行 `checkProfileUser`，被访问端切换账号后立即拒绝。
  - 仅经中继时，文件读取和上传超过 5 MB 返回 `relay_transfer_limited`。
- sidecar 锁定：本机 Desktop 调用 `sidecar.stop`（退出更新、AppImage）后进入锁定状态。锁定期间远端请求不触发 `Ensure`，返回 `host_not_ready`，并断开远端客户端；本机 Desktop 再次 `session.set` 或守护进程重启后解锁。`wantRestart` 只统计本机客户端。
- 事件发送：
  - 每个客户端一个有界发送队列（256 条）和独立写协程，`broadcast` 只入队，不阻塞。队列满时清空并发送 `resync`。
  - 远端客户端合并 250ms 窗口内同一 `(scope, sessionId)` 的 `changed`，不发送 `timing`。
- 反向请求按 `clientKey` 绑定：
  - `session.set` 带 `clientKey`（proxy 实例生命周期内不变）。守护进程把 `clientKey` 作为 `ConnectionID` 传给 sidecar，所以 sidecar 的 origin 在重连后仍然有效。
  - 连接断开时，该 `clientKey` 的待处理 hostRequest 保留 60 秒；同一 `clientKey` 重连并 `subscribe` 后重新下发。宽限期结束才返回失败。
  - 交互类请求（`pick_directory`、`pick_preview`、`confirmed_operation`）的 TTL 改为 5 分钟。
- 回环接口：
  - 在 health mux 上显式注册 `/local/v1/devices` 和 `/local/v1/devices/`（`/local/v1/` 前缀整体交给了 `localhost.Server`），并调用 `Authorize`。
  - `GET /local/v1/devices` 返回可用设备。
  - `/local/v1/devices/{peerId}/...`：`httputil.ReverseProxy`，Transport 的 `DialContext` 使用 `p2p.Dial`，设置 `IdleConnTimeout`；删除 `Authorization`；`FlushInterval: -1`。
  - `ErrorHandler` 返回 JSON `{ error: { code } }`：拨号失败为 502 `device_unreachable`；对端不支持协议为 503 `device_link_off`；不在 allowlist 为 404 `device_unknown`。
- `hello` 的 `capabilities` 增加 `device-link`。

### Sidecar 和 core 协议

- `session.set` 增加 `remote`。远端 connection：
  - 不执行 `Object.assign(process.env, …)`，不迁移 legacy 数据。
  - 在 `session.set` 和 `request` 中都不写入 `lastConnection`。
  - 被访问端本机 env 未就绪时返回 `host_not_ready`。
- provider env 下沉：本机 `session.set` 收到的 env 持久化到 profile（文件权限 0600，`*_PROXY` 可能含凭据）；sidecar 启动时读取，本机 Desktop 连上后覆盖为最新值。
- 新增 `directoryList { path } → { path, parent, entries: [{ name, path, kind }] }`，供远端目录和文件选择使用。

### Desktop 主进程和 preload

- `LocalHostProxy`：
  - 增加 `basePath`，默认 `/local/v1`。
  - 增加 `clientKey`。
  - 错误映射：解析 `{ error: { code } }`，按错误码更新状态；只有本机回环接口返回 403 时才重读 token。
- `DeviceProxies`：`peerId → LocalHostProxy`，生命周期跟随远端 tab（引用计数），不跟随设备列表；计数归零 60 秒后关闭。远端 proxy：`providerEnv: () => ({})`、`legacyDataDir: ""`、远端 host request 处理函数。
- IPC 显式带 deviceId 参数（本机为 `"local"`），不从 scope 推断，缺失时报错。涉及 `request`、`changed`、`availability`、文件 key、`localFileContextMenu`、`sideWorkspace`、`resourcePreview`。
- 文件协议 URL 带 deviceId；新增 `local-conversation:save-file`。
- 设备列表轮询、开关读写的 IPC；`tab:attach`/`tab:detach` 维护引用计数。

### 渲染进程和 views

- 设备专属 client：`window.desktopAPI.localConversations.forDevice(deviceId)` 返回包含 `request`、`subscribe`、`availability`、`fileUrl` 的 client。`LocalConversationFlowPage` 从路由读取 deviceId，通过 context 提供；子组件通过 hook 获取，拿不到时抛错，不回落到本机。替换现有直接引用 `window.desktopAPI.localConversations` 和重建 scope 的位置，包括 `local-runtime-notice.tsx`、`side-workspace-bridge.tsx`、`local-side-workspace.tsx`、`local-resource-preview.tsx`、`local-side-feedback.tsx`。
- `LocalConversationScope` 不增加字段。第 ⑤ 类的 key 改为显式带 deviceId。
- 路由 `/{slug}/conversations/devices/{peerId}`；`paths.ts` 增加对应路径函数。
- `app-sidebar` 增加平台插槽，由 Desktop 注入「对话流（本地）」和「对话流（{设备名}）」，并按上文规则判断选中状态。
- 远端目录和文件选择 Dialog；设置「设备互联」tab 和 AlertDialog；`LocalRuntimeNotice` 按设备订阅并补充远端文案；翻译（en、zh-Hans、ja、ko）。
- 云端任务会话链接的跨设备查找。

## 安全边界

| 层级 | 检查 |
| --- | --- |
| 查看端回环接口 | 现有 token、只允许 loopback Host、不能带 Origin |
| 转发前 | 删除本机 token |
| p2p 连接 | gater 只放行同账号设备，基于握手时证明的公钥身份 |
| 被访问端入口 | 开关打开才注册协议；路径白名单；禁止 sidecar 运维方法；每次请求校验 userId |
| 被访问端执行环境 | 不接受远端 env，使用被访问端自己持久化的 env |

已知风险（第一版接受）：信任范围是「同一账号」。p2p-server 接受任何能通过 `/api/me` 的 token（包括 `mat_` 智能体任务 token 和 PAT），开关也只受本机 loopback token 保护。某台机器上被注入的智能体可以注册伪设备并打开开关，从而在该账号的其他已开启设备上执行任务和读取文件。第二期收紧。

## 实施顺序

1. 守护进程：p2p 适配器和直连优先、开关、`ServeRemote`、sidecar 锁定、发送队列和合并、`clientKey` 绑定、`/devices` 和反向代理、错误码。用同一台机器的两个 profile，以 curl 验证 hello、ws、files。
2. Sidecar 和 core 协议：`remote` 标记、`lastConnection` 修正、env 持久化和 `host_not_ready`、`directoryList`。
3. Desktop 主进程和 preload：`basePath`、`clientKey`、错误映射、`DeviceProxies` 和引用计数、显式 deviceId 的 IPC、文件协议、保存到本机、反向请求和 settings 分流、设备轮询、开关 IPC。
4. 渲染进程和 views：设备专属 client 和 context、路由、侧边栏插槽和选中规则、第 ⑤ 类 key、远端选择 Dialog、附件 URL、右键菜单和网页预览的远端行为、设置 tab、提示文案、翻译、云端任务会话链接。
5. 验证：
   - Go：适配器（含半关闭）、`ServeRemote` 白名单、反向代理和错误码、sidecar 锁定、发送队列满时 resync、`clientKey` 宽限期、直连迁移。
   - sidecar：远端连接不进入 `lastConnection`、不改 env、`host_not_ready`。
   - 渲染进程：侧边栏两种状态和选中规则、远端 tab、key 隔离、缺少设备 client 时报错。
   - 手动：先用同一台机器的两个 profile，再用两台不同网络的机器验证打洞和中继回退。浅色和深色主题截图保存在 `.tmp/device-link/`。

## 第二期

- 收紧信任：p2p-server 只接受 Desktop 和守护进程的登录 token；被访问端按设备逐台批准；开关只能从 Desktop 界面修改。
- 增量读取（`read {id, sinceSeq}`），减少流式输出时的整份重读。
- 端口转发（`/multica/port-forward/1`，只转发被访问端的回环端口），支持预览被访问端的 dev server。
- 从被访问端获取守护进程日志和计时日志。
- 设备列表改为推送。

## 待定问题

- 被访问端是否需要提示「正在被其他设备使用」？
